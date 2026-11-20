import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createQzoneWriteBinding } from '../src/core/qzone-write-binding-offline.mjs';
import { simulateQzoneBoundWriteOffline } from '../src/core/qzone-bound-write-simulation-offline.mjs';
import { createQzoneOnebotWriteTransport } from '../src/core/qzone-onebot-write-transport.mjs';
import { createQzoneToolGate } from '../src/core/qzone-tool-gate.mjs';

const now = Date.parse('2026-11-08T02:00:00Z');

async function harness(t, patch = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-bound-transport-'));
  const file = join(dir, 'state.sqlite');
  const store = openOfflineStore(file, { offlineTestFixture: true, enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, reads: 0, writes: 0, selfId: '123',
    tools: { publish: true, comment: true, reply: true, like: true }, limits: { post: 3, comment: 25, like: 30 },
    lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [],
    ledger: { day: '2026-11-08', used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    outcomes: {}, dispatchClaims: {}, notices: [], audit: [], ...patch });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { file, store };
}

function binding(id) {
  return createQzoneWriteBinding(id, 'like', { tid: 'post_1', target_uin: 456 },
    { time: now, source: 'qq', target: '456', result: 'unknown', reason: '' });
}

function fakeTransport(calls, response) {
  return createQzoneOnebotWriteTransport({ origin: 'http://127.0.0.1:3210', fetch: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
}

test('离线预留→模拟 OneBot→结算链保持目标一致且不泄露原始响应', async (t) => {
  const { file, store } = await harness(t); const calls = [];
  const transport = fakeTransport(calls, { status: 'ok', retcode: 0, data: null, token: 'synthetic-secret' });
  const result = await simulateQzoneBoundWriteOffline(file, binding('transport_chain_1'), async (request) => {
    assert.equal(request.action, 'like_qzone');
    assert.equal(store.read().audit[0].record.result, 'unknown');
    const projected = await transport.send('like', request.params);
    return { outcome: projected.outcome, now };
  });
  assert.equal(result.allowed, true);
  assert.equal(result.outcome, 'success');
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:3210/like_qzone', body: { tid: 'post_1', target_uin: 456 } }]);
  assert.equal(store.read().ledger.used.like, 1);
  assert.equal(store.read().audit.at(-1).record.result, 'success');
  assert.equal(JSON.stringify(store.read()).includes('synthetic-secret'), false);
});

test('关闭写权限时不调用模拟 OneBot，额度和审计不变化', async (t) => {
  const { file, store } = await harness(t, { writeAllowed: false }); const calls = [];
  const transport = fakeTransport(calls, { status: 'ok', retcode: 0, data: {} });
  const result = await simulateQzoneBoundWriteOffline(file, binding('transport_chain_denied'), async (request) => {
    const projected = await transport.send('like', request.params);
    return { outcome: projected.outcome, now };
  });
  assert.equal(result.allowed, false);
  assert.equal(calls.length, 0);
  assert.equal(store.read().ledger.used.like, 0);
  assert.deepEqual(store.read().audit, []);
});

test('旧工具引用在关闭后被拦，重新启用后才可进入完整模拟写入链', async (t) => {
  const { file, store } = await harness(t); const calls = [];
  const transport = fakeTransport(calls, { status: 'ok', retcode: 0, data: null });
  const gate = createQzoneToolGate({ readState: () => store.read() });
  const handler = gate.wrap('like', bound => simulateQzoneBoundWriteOffline(file, bound, async (request) => {
    const projected = await transport.send('like', request.params);
    return { outcome: projected.outcome, now };
  }));
  store.update(s => ({ ...s, enabled: false }));
  await assert.rejects(handler(binding('gate_closed')), /qzone tool denied/);
  assert.equal(calls.length, 0);
  assert.equal(store.read().ledger.used.like, 0);
  assert.deepEqual(store.read().audit, []);
  store.update(s => ({ ...s, enabled: true }));
  assert.equal((await handler(binding('gate_reopened'))).outcome, 'success');
  assert.equal(calls.length, 1);
  assert.equal(store.read().ledger.used.like, 1);
});

test('无法确认的模拟网关响应只结算 unknown，不退款、不自动重试', async (t) => {
  const { file, store } = await harness(t); const calls = [];
  const transport = fakeTransport(calls, { status: 'failed', retcode: 1, data: { token: 'synthetic-secret' } });
  const bound = binding('transport_chain_unknown');
  const simulate = () => simulateQzoneBoundWriteOffline(file, bound, async (request) => {
    const projected = await transport.send('like', request.params);
    return { outcome: projected.outcome, now };
  });
  assert.equal((await simulate()).outcome, 'unknown');
  assert.equal((await simulate()).allowed, false);
  assert.equal(calls.length, 1);
  assert.equal(store.read().ledger.used.like, 1);
  assert.equal(store.read().audit.at(-1).record.result, 'unknown');
  assert.equal(JSON.stringify(store.read()).includes('synthetic-secret'), false);
});

test('发说说、评论和回复各自经同一预留→传输→结算路径', async (t) => {
  const cases = [
    { kind: 'publish', target: '123', input: { content: 'fixture post', ugc_right: 4 },
      action: 'send_qzone_msg', data: { tid: 'new_post', time: 100 }, quota: 'post' },
    { kind: 'comment', target: '456', input: { tid: 'post_1', target_uin: 456, content: 'fixture comment' },
      action: 'comment_qzone', data: { comment_id: 'new_comment' }, quota: 'comment' },
    { kind: 'reply', target: '456', input: { tid: 'post_1', target_uin: 456, content: 'fixture reply',
      comment_id: 'parent_1', comment_uin: 789, reply_uin: 987, reply_name: 'fixture name' },
      action: 'comment_qzone', data: { comment_id: 'new_reply' }, quota: 'comment',
      evidence: [{ target: '456', postId: 'post_1', commentId: 'parent_1', commentUin: 789, replyUin: 987, replyName: 'fixture name' }] },
  ];
  for (const item of cases) {
    const { file, store } = await harness(t, item.evidence ? { commentEvidence: item.evidence } : {});
    const bound = createQzoneWriteBinding(`transport_${item.kind}`, item.kind, item.input,
      { time: now, source: 'qq', target: item.target, result: 'unknown', reason: '' });
    const calls = [];
    const transport = fakeTransport(calls, { status: 'ok', retcode: 0, data: item.data });
    const result = await simulateQzoneBoundWriteOffline(file, bound, async (request) => {
      assert.equal(request.action, item.action);
      const projected = await transport.send(item.kind, request.params);
      return { outcome: projected.outcome, now };
    });
    assert.equal(result.outcome, 'success', item.kind);
    assert.equal(calls.length, 1, item.kind);
    assert.equal(calls[0].url, `http://127.0.0.1:3210/${item.action}`, item.kind);
    assert.deepEqual(calls[0].body, item.input, item.kind);
    assert.equal(store.read().ledger.used[item.quota], 1, item.kind);
    assert.equal(store.read().audit.at(-1).record.result, 'success', item.kind);
  }
});
