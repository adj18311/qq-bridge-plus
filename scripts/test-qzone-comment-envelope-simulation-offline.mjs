import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { simulateOfflineOnebotComments } from '../src/core/qzone-comment-envelope-simulation-offline.mjs';

const now = Date.parse('2026-11-07T02:00:00Z');
const target = { author: '123', id: 'post-1' };
const metadata = { ...target, time: now - 1000 };
const scope = { author: '123', friend: true, now };
const request = { id: 'r1', now, tool: 'read_comments', source: 'requested', target: '123', postId: 'post-1', activeTime: false };
const envelope = { status: 'ok', retcode: 0, data: { tid: 'post-1', content: 'private post', comment_num: 1,
  comments: [{ comment_id: 'c1', uin: 456, name: 'name', time: now / 1000 - 1, content: 'allowed', replies: [] }] } };

async function fixture(t, marker = true) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-envelope-'));
  const db = openOfflineStore(join(dir, 'state.db'), { offlineTestFixture: marker, enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, reads: 0, writes: 0, tools: { read_comments: true }, readAttempts: {},
    readOutcomes: {}, notices: [], browseDay: '2026-11-07', todayBrowses: 0, lastBrowseAt: null,
    usedOpportunities: {}, activeStart: 420, activeEnd: 1380, audit: [] });
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  return db;
}

test('隔离假数据从 OneBot envelope 经授权和审计到评论投影', async (t) => {
  const db = await fixture(t);
  const result = await simulateOfflineOnebotComments(db, request, target, metadata, scope, envelope);
  assert.deepEqual(result.comments, [{ id: 'c1', author: '456', time: now - 1000, content: 'allowed' }]);
  assert.equal(result.outcome, 'success');
  assert.equal(db.read().readOutcomes.r1, 'success');
  assert.equal(JSON.stringify(db.read().audit).includes('private post'), false);
});

test('非测试状态与无权访问在投影和假派发前拒绝', async (t) => {
  const db = await fixture(t, false); let calls = 0;
  const fake = () => { calls++; return envelope; };
  await assert.rejects(simulateOfflineOnebotComments(db, request, target, metadata, scope, fake));
  assert.equal((await simulateOfflineOnebotComments(db, request, target, metadata, scope, envelope)).allowed, false);
  db.update((s) => ({ ...s, offlineTestFixture: true }));
  assert.equal((await simulateOfflineOnebotComments(db, request, target, { ...metadata, time: now - 8 * 86400000 }, scope, envelope)).allowed, false);
  assert.equal(calls, 0);
  assert.deepEqual(db.read().readAttempts, {});
});

test('本人旧说说新评论事件只输出目标评论，不输出同页其他内容', async (t) => {
  const db = await fixture(t);
  const event = { isNew: true, selfId: '123', author: '123', postId: 'post-1', commentId: 'c1' };
  const other = { comment_id: 'c2', uin: 789, name: 'other', time: now / 1000 - 1, content: 'unrelated', replies: [] };
  const page = { ...envelope, data: { ...envelope.data, comment_num: 2, comments: [...envelope.data.comments, other] } };
  const result = await simulateOfflineOnebotComments(db, { ...request, commentId: 'c1' }, target,
    { ...metadata, time: now - 8 * 86400000 }, { ...scope, selfId: '123', event }, page);
  assert.deepEqual(result.comments, [{ id: 'c1', author: '456', time: now - 1000, content: 'allowed' }]);
  assert.equal(JSON.stringify(db.read().audit).includes('unrelated'), false);
});

test('错误帖子与损坏的 envelope 均只返回 unknown，不能泄露原始响应', async (t) => {
  const db = await fixture(t);
  const wrong = { ...envelope, data: { ...envelope.data, tid: 'other', token: 'private-canary' } };
  const result = await simulateOfflineOnebotComments(db, request, target, metadata, scope, wrong);
  assert.equal(result.outcome, 'unknown');
  assert.deepEqual(result.comments, []);
  assert.equal(JSON.stringify(result).includes('private-canary'), false);
  assert.equal(JSON.stringify(db.read().audit).includes('private-canary'), false);
});
