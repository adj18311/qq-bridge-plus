import test from 'node:test';
import assert from 'node:assert/strict';
import { createExternalEventExperiment } from './owner-patrol-external-events-prototype.mjs';
import { NodeApiClient } from '../src/dsh-client.js';

test('真实桥接 DSH 客户端保留显式 requestId，无需连接真实 DSH', async () => {
  const api = new NodeApiClient('http://127.0.0.1:1', 1000, { tokenExplicit: false });
  let captured;
  api.postJson = async (_path, body) => { captured = body; return { json: async () => ({ type: 'server-response', rpcId: body.rpcId, result: { ok: true } }) }; };
  await api.callUnary('session/prompt', { sessionId: 's', requestId: 'fixture-unique-request', content: [] });
  assert.equal(captured.payload.args.request.requestId, 'fixture-unique-request');
});

const start = (seq, turn = 2) => ({ seq, type: 'turn/start', data: { turn } });
const message = (seq, rpcId = 'req-1') => ({ seq, type: 'user/message', data: { source: { kind: 'user', rpcId }, id: 'm' } });
const end = (seq, turn = 2) => ({ seq, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
function f() { const a = createExternalEventExperiment(); a.begin({ sessionId: 's', requestId: 'req-1' }); return a; }

test('完整 live 帧由请求 id 与当前回合关联，结束只决定一次', () => {
  const a = f();
  for (const event of [start(10), message(11), end(12), end(12)]) a.accept({ sessionId: 's', event });
  assert.equal(a.results.length, 1); assert.equal(a.results[0].turn, 2);
});
test('缺 start、错请求 id 或错会话时不能完成关联', () => {
  const a = f(); a.accept({ sessionId: 's', event: message(10) }); a.accept({ sessionId: 's', event: end(11) });
  assert.equal(a.results.length, 0);
});
test('丢帧造成序号不连续时不输出分享决定', () => {
  const a = f(); a.accept({ sessionId: 's', event: start(10) }); a.accept({ sessionId: 's', event: message(12) }); a.accept({ sessionId: 's', event: end(13) });
  assert.equal(a.results.length, 0);
});
test('中途出现其他消息时完成回合但不产生主动分享许可', () => {
  const a = f(); for (const event of [start(10), message(11), message(12, 'owner-message'), end(13)]) a.accept({ sessionId: 's', event });
  assert.equal(a.results.length, 1); assert.equal(a.results[0].share, false);
});
test('管理员来信已到桥接但尚未被宿主消费，仍须抑制分享', () => {
  const a = f(); a.accept({ sessionId: 's', event: start(10) });
  a.accept({ sessionId: 's', event: message(11) });
  a.ownerReceived({ sessionId: 's' });
  a.accept({ sessionId: 's', event: end(12) });
  assert.equal(a.results[0].share, false);
});
test('匹配请求尚未出现的旧回合结束，不应抹去新机会', () => {
  const a = f();
  for (const event of [start(10, 1), end(11, 1), start(12, 2), message(13), end(14, 2)]) a.accept({ sessionId: 's', event });
  assert.deepEqual(a.results, [{ turn: 2, share: true }]);
});
test('事件流断开后迟到帧不触发决定，且允许后续新任务', () => {
  const a = f(); a.accept({ sessionId: 's', event: start(10) });
  a.accept({ sessionId: 's', event: message(11) }); a.disconnect();
  a.accept({ sessionId: 's', event: end(12) });
  assert.equal(a.results.length, 0);
  assert.equal(a.begin({ sessionId: 's', requestId: 'new' }), true);
});
test('仅关联会话的订阅中断才使当前机会失效', () => {
  const a = f(); a.accept({ sessionId: 's', event: start(10) }); a.accept({ sessionId: 's', event: message(11) });
  a.followEnded({ sessionId: 'other' });
  a.accept({ sessionId: 's', event: end(12) });
  assert.equal(a.results.length, 1);
  assert.equal(a.begin({ sessionId: 's', requestId: 'next' }), true);
  a.accept({ sessionId: 's', event: start(20) });
  a.accept({ sessionId: 's', event: message(21, 'next') });
  a.followEnded({ sessionId: 's' });
  a.accept({ sessionId: 's', event: end(22) });
  assert.equal(a.results.length, 1);
});
test('来源缺失、失败回合和其他会话不得作为匹配完成', () => {
  const a = f();
  a.accept({ sessionId: 's', event: start(10) });
  a.accept({ sessionId: 'wrong', event: message(11) });
  a.accept({ sessionId: 's', event: { ...message(11), data: { id: 'm' } } });
  a.accept({ sessionId: 's', event: end(12) });
  assert.equal(a.results.length, 0);
});
