import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import {
  bindAuthorizedOwnNewQzoneComment,
  bindAuthorizedOwnNewQzoneReply,
} from '../src/core/qzone-comment-binding-offline.mjs';
import { createQzoneWriteBinding } from '../src/core/qzone-write-binding-offline.mjs';
import { simulateQzoneBoundWriteOffline } from '../src/core/qzone-bound-write-simulation-offline.mjs';

const now = Date.parse('2026-11-08T02:00:00Z');
const postId = 'old_post_1';
let operationSequence = 0;

function detail() {
  return {
    status: 'ok', retcode: 0,
    data: {
      tid: postId, content: 'synthetic post', comment_num: 2,
      comments: [
        { comment_id: 'parent_1', uin: 456, name: 'Parent', time: now / 1000 - 10,
          content: 'synthetic parent', replies: [
            { comment_id: 'reply_1', uin: 789, name: 'Reply Nick', time: now / 1000 - 5,
              content: 'synthetic reply', parent_comment_id: 'parent_1', parent_comment_uin: 456 },
          ] },
      ],
    },
  };
}

function testCommentEvidence(identity, { patch = {}, child = false } = {}) {
  // TEST FIXTURE ONLY: this object simulates state that a trusted production
  // event/read handler would have to establish. The test does not verify that
  // production authorization source or persistence pipeline.
  return {
    target: identity.targetQq,
    postId: identity.postId,
    commentId: child ? identity.parentCommentId : identity.commentId,
    commentUin: child ? identity.parentQq : identity.commentQq,
    replyUin: child ? identity.replyQq : null,
    replyName: child ? identity.replyName : null,
    ...patch,
  };
}

function initialState(commentEvidence) {
  return {
    offlineTestFixture: true,
    reads: 0, writes: 0,
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    selfId: '123', tools: { publish: true, comment: true, reply: true, like: true },
    limits: { post: 5, comment: 5, like: 5 }, lastPostAt: null, lastCommentAt: null,
    commentTargets: [], likes: [], commentEvidence,
    ledger: { day: '2026-11-08', used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    outcomes: {}, dispatchClaims: {}, notices: [], audit: [],
  };
}

async function runReplyChain(t, identity, { child = false, evidencePatch = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-comment-write-chain-'));
  const file = join(dir, 'state.db');
  const fixture = testCommentEvidence(identity, { child, patch: evidencePatch });
  const store = openOfflineStore(file, initialState([fixture]));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  const id = `comment_chain_${++operationSequence}`;
  const input = {
    tid: identity.postId, target_uin: identity.targetQq, content: 'synthetic write body',
    comment_id: child ? identity.parentCommentId : identity.commentId,
    comment_uin: child ? identity.parentQq : identity.commentQq,
    ...(child ? { reply_uin: identity.replyQq, reply_name: identity.replyName } : {}),
  };
  const binding = createQzoneWriteBinding(id, 'reply', input, {
    time: now, source: 'qq', target: identity.targetQq, result: 'unknown', reason: '',
  });
  const requests = [];
  const result = await simulateQzoneBoundWriteOffline(file, binding, async (request) => {
    requests.push(request);
    return { outcome: 'success', now };
  });
  return { result, requests, state: store.read(), input };
}

function firstLevelIdentity() {
  const target = { author: '123', id: postId };
  const event = { isNew: true, selfId: '123', author: '123', postId, commentId: 'parent_1' };
  return bindAuthorizedOwnNewQzoneComment(target, event, detail(), 'parent_1');
}

function secondLevelIdentity() {
  const target = { author: '123', id: postId };
  const event = { isNew: true, selfId: '123', author: '123', postId, commentId: 'reply_1' };
  return bindAuthorizedOwnNewQzoneReply(target, event, detail(), 'parent_1', 'reply_1');
}

test('一级评论身份绑定转成测试夹具后，写链参数指向正确父评论', async (t) => {
  const identity = firstLevelIdentity();
  const { result, requests, state, input } = await runReplyChain(t, identity);

  assert.deepEqual(result, { allowed: true, outcome: 'success', successEvidence: 'fake_simulation_only', replayed: false });
  assert.deepEqual(requests, [{ action: 'comment_qzone', params: {
    tid: postId, target_uin: 123, content: 'synthetic write body', comment_id: 'parent_1', comment_uin: 456,
  } }]);
  assert.equal(state.ledger.reservations.comment_chain_1, 'comment');
  assert.equal(input.comment_id, 'parent_1');
  assert.equal(input.comment_uin, '456');
});

test('二级回复身份绑定转成测试夹具后，写链参数包含准确回复 QQ 和昵称', async (t) => {
  const identity = secondLevelIdentity();
  const { result, requests, state } = await runReplyChain(t, identity, { child: true });

  assert.deepEqual(result, { allowed: true, outcome: 'success', successEvidence: 'fake_simulation_only', replayed: false });
  assert.deepEqual(requests, [{ action: 'comment_qzone', params: {
    tid: postId, target_uin: 123, content: 'synthetic write body', comment_id: 'parent_1', comment_uin: 456,
    reply_uin: 789, reply_name: 'Reply Nick',
  } }]);
  assert.equal(state.ledger.reservations.comment_chain_2, 'comment');
});

test('写链拒绝错误父 QQ、二级回复 QQ、昵称和帖子测试证据，且不调用 fake', async (t) => {
  const identity = secondLevelIdentity();
  const cases = [
    { name: 'wrong-parent-qq', patch: { commentUin: '999' } },
    { name: 'wrong-reply-qq', patch: { replyUin: '999' } },
    { name: 'wrong-reply-name', patch: { replyName: 'Forged Nick' } },
    { name: 'wrong-post', patch: { postId: 'another_post' } },
  ];
  for (const item of cases) {
    const dir = await mkdtemp(join(tmpdir(), 'qzone-comment-write-chain-deny-'));
    const file = join(dir, 'state.db');
    const fixture = testCommentEvidence(identity, { child: true, patch: item.patch });
    const store = openOfflineStore(file, initialState([fixture]));
    t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
    const id = `comment_chain_deny_${++operationSequence}`;
    const binding = createQzoneWriteBinding(id, 'reply', {
      tid: identity.postId, target_uin: identity.targetQq, content: 'synthetic write body',
      comment_id: identity.parentCommentId, comment_uin: identity.parentQq,
      reply_uin: identity.replyQq, reply_name: identity.replyName,
    }, { time: now, source: 'qq', target: identity.targetQq, result: 'unknown', reason: '' });
    let calls = 0;
    const result = await simulateQzoneBoundWriteOffline(file, binding, async () => {
      calls++;
      return { outcome: 'success', now };
    });
    assert.equal(result.allowed, false, item.name);
    assert.equal(result.reason, item.name === 'wrong-post' ? 'missing_comment_evidence' : 'comment_evidence_mismatch', item.name);
    assert.equal(calls, 0, item.name);
    assert.deepEqual(store.read().ledger.reservations, {}, item.name);
    assert.deepEqual(store.read().audit, [], item.name);
  }
});
