import assert from 'node:assert/strict';
import test from 'node:test';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

const sessionId = 'offline-session';
const epoch = 'offline-epoch';
const requestId = 'bridge-request-1';
const message = (rpcId = requestId) => ({ role: 'user', source: { rpcId } });
const ledger = () => createQzoneOriginLedger({ sessionId, epoch });
const step = (target, messages = [message()], turn = 1, number = 1) =>
  target.observeStep({ sessionId, turn, step: number, messages });
const call = (target, callId = 'tool-call-1', turn = 1, number = 1) =>
  target.observeToolCall({ sessionId, event: { type: 'tool/call', data: { turn, step: number, callId } } });

test('来源账本达到容量时只拒绝新增条目，不清空旧条目也不毒化已有绑定', () => {
  const target = createQzoneOriginLedger({ sessionId, epoch, trackingLimit: 1 });
  target.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  assert.equal(step(target), true);
  assert.equal(call(target), true);
  // Capacity refuses the extra tool/call...
  assert.equal(call(target, 'overflow'), false);
  // ...but the binding admitted before the refusal must still work. Setting the
  // global `continuityLost` flag here used to make this return null, which meant
  // an exhausted collection locked the whole session out of every later read.
  assert.deepEqual(target.consume({ sessionId, turn: 1, step: 1, callId: 'tool-call-1' }), {
    requestId, origin: 'qq-inbound', sessionId, epoch, turn: 1, step: 1, callId: 'tool-call-1',
  });
  // The refusal is a refusal, not an eviction: the map is still full.
  assert.throws(() => target.registerBridgeRequest({ requestId: 'another', origin: 'qq-inbound' }));
});

test('bridge 注册的单一 request 经 DSH step 与 tool/call 精确配对后每个 callId 只可消费一次', () => {
  const target = ledger();
  target.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  step(target);
  call(target);
  assert.deepEqual(target.consume({ sessionId, turn: 1, step: 1, callId: 'tool-call-1' }), {
    requestId, origin: 'qq-inbound', sessionId, epoch, turn: 1, step: 1, callId: 'tool-call-1',
  });
  assert.equal(target.consume({ sessionId, turn: 1, step: 1, callId: 'tool-call-1' }), null);
});

// ── t25：真实 DSH 回合里，user 消息旁边永远有宿主注入的上下文 ────────────────────────────
//
// 这条钉住实测暴露的缺陷：`observeStep` 曾要求 `messages.length === 1`，而真实回合里
// runtime-context / time-context / skill-catalog 与 user 消息同处一个数组，长度从不为 1，
// 于是来源永远拿不到、consume 恒失败、工具恒 `origin-unbound`。
//
// 修法的语义边界（三条都要钉住）：
//   · 带 rpcId 的消息恰好一条  ⇒ 拿到来源（上下文消息不计）；
//   · 携带 TWO 个不同 rpcId     ⇒ 仍是混合来源，拒绝并污染该 turn；
//   · 只有上下文、没有任何 rpcId ⇒ 没有来源，与改动前一致。
test('t25 宿主上下文与 user 消息同居时，唯一带 rpcId 的那条仍提供来源（多 rpcId 仍拒）', () => {
  const contextMessage = (kind) => ({ role: 'user', source: { kind }, content: [] });
  const userMessage = { role: 'user', source: { kind: 'user', rpcId: requestId }, content: [] };

  // (a) 上下文 + 一条带 rpcId 的 user 消息 ⇒ 正常绑定。真实回合的形状。
  const mixed = ledger();
  mixed.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  assert.equal(step(mixed, [contextMessage('runtime-context'), userMessage, contextMessage('skill-catalog')]), true,
    '上下文消息与 user 消息共存时，唯一带 rpcId 的那条必须提供来源');
  assert.equal(call(mixed), true);
  assert.deepEqual(mixed.consume({ sessionId, turn: 1, step: 1, callId: 'tool-call-1' }), {
    requestId, origin: 'qq-inbound', sessionId, epoch, turn: 1, step: 1, callId: 'tool-call-1',
  });

  // (b) 两个不同的 rpcId ⇒ 混合来源，拒绝（不是"取第一条"）。
  const ambiguous = ledger();
  ambiguous.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  ambiguous.registerBridgeRequest({ requestId: 'second-request', origin: 'qq-inbound' });
  assert.equal(step(ambiguous, [
    { role: 'user', source: { kind: 'user', rpcId: requestId } },
    { role: 'user', source: { kind: 'user', rpcId: 'second-request' } },
  ]), false, '一个 step 携带两个不同 rpcId 时不得凭空选一个');

  // (c) 只有上下文、没有 rpcId ⇒ 没有来源（与改动前一致）。
  const noSource = ledger();
  noSource.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  assert.equal(step(noSource, [contextMessage('runtime-context'), contextMessage('time-context')]), false,
    '每一步都有输入但没有 rpcId 时，不得凭空产生来源');
});

test('缺失、未登记或并发多来源的 step 不产生绑定', () => {
  const target = ledger();
  target.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  step(target, []);
  call(target, 'missing');
  assert.equal(target.consume({ sessionId, turn: 1, step: 1, callId: 'missing' }), null);

  step(target, [message(), message('unregistered')], 2);
  call(target, 'mixed', 2);
  assert.equal(target.consume({ sessionId, turn: 2, step: 1, callId: 'mixed' }), null);
});

test('同一回合出现混合或未登记来源后，后续 step 不能重新获得可信来源', () => {
  const target = ledger();
  target.registerBridgeRequest({ requestId, origin: 'schedule' });
  target.registerBridgeRequest({ requestId: 'later-request', origin: 'qq-inbound' });
  step(target);
  call(target, 'not-yet-consumed');
  step(target, [message('unknown'), message('another-unknown')], 1, 2);
  step(target, [message('later-request')], 1, 3);
  call(target, 'after-mixed', 1, 3);
  assert.equal(target.consume({ sessionId, turn: 1, step: 1, callId: 'not-yet-consumed' }), null);
  assert.equal(target.consume({ sessionId, turn: 1, step: 3, callId: 'after-mixed' }), null);
});

test('同一回合分步进入不同的已登记请求时也不得当成单一来源', () => {
  const target = ledger();
  target.registerBridgeRequest({ requestId, origin: 'schedule' });
  target.registerBridgeRequest({ requestId: 'later-request', origin: 'qq-inbound' });
  step(target);
  call(target, 'earlier');
  step(target, [message('later-request')], 1, 2);
  call(target, 'later', 1, 2);
  assert.equal(target.consume({ sessionId, turn: 1, step: 1, callId: 'earlier' }), null);
  assert.equal(target.consume({ sessionId, turn: 1, step: 2, callId: 'later' }), null);
});

test('requestId、step 或 callId 冲突会永久污染相关关联', () => {
  const target = ledger();
  target.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  assert.throws(() => target.registerBridgeRequest({ requestId, origin: 'schedule' }));
  step(target);
  call(target);
  assert.equal(target.consume({ sessionId, turn: 1, step: 1, callId: 'tool-call-1' }), null);

  const duplicateStep = ledger();
  duplicateStep.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  step(duplicateStep);
  call(duplicateStep, 'duplicate-step-call');
  step(duplicateStep);
  assert.equal(duplicateStep.consume({ sessionId, turn: 1, step: 1, callId: 'duplicate-step-call' }), null);

  const lateRequestCollision = ledger();
  lateRequestCollision.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  step(lateRequestCollision);
  call(lateRequestCollision, 'late-collision-call');
  assert.throws(() => lateRequestCollision.registerBridgeRequest({ requestId, origin: 'schedule' }));
  assert.equal(lateRequestCollision.consume({ sessionId, turn: 1, step: 1, callId: 'late-collision-call' }), null);

  const collision = ledger();
  collision.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  step(collision);
  call(collision, 'same');
  call(collision, 'same', 2, 1);
  assert.equal(collision.consume({ sessionId, turn: 1, step: 1, callId: 'same' }), null);
});

test('乱序、断连重连和 turn 结束均 fail closed', () => {
  const target = ledger();
  target.registerBridgeRequest({ requestId, origin: 'schedule' });
  call(target, 'early');
  step(target);
  assert.equal(target.consume({ sessionId, turn: 1, step: 1, callId: 'early' }), null);

  call(target, 'after-step');
  target.endTurn({ sessionId, turn: 1 });
  assert.equal(target.consume({ sessionId, turn: 1, step: 1, callId: 'after-step' }), null);

  const disconnected = ledger();
  disconnected.registerBridgeRequest({ requestId, origin: 'schedule' });
  step(disconnected);
  disconnected.disconnect();
  disconnected.reconnect({ sessionId, epoch: 'new-epoch' });
  call(disconnected);
  assert.equal(disconnected.consume({ sessionId, turn: 1, step: 1, callId: 'tool-call-1' }), null);
});

test('模型字段、管理员标签和历史授权不能注册来源', () => {
  const target = ledger();
  for (const origin of ['owner', 'admin', 'history', 'model']) {
    assert.throws(() => target.registerBridgeRequest({ requestId: origin, origin }));
  }
  step(target, [message('model-claimed-request')]);
  call(target);
  assert.equal(target.consume({ sessionId, turn: 1, step: 1, callId: 'tool-call-1' }), null);
});

test('requestId 在另一个 step 或 turn 重现会废弃此前及后续的全部绑定', () => {
  const sameTurn = ledger();
  sameTurn.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  step(sameTurn);
  call(sameTurn, 'first-call');
  step(sameTurn, [message()], 1, 2);
  call(sameTurn, 'replayed-call', 1, 2);
  assert.equal(sameTurn.consume({ sessionId, turn: 1, step: 1, callId: 'first-call' }), null);
  assert.equal(sameTurn.consume({ sessionId, turn: 1, step: 2, callId: 'replayed-call' }), null);

  const nextTurn = ledger();
  nextTurn.registerBridgeRequest({ requestId, origin: 'schedule' });
  step(nextTurn);
  call(nextTurn, 'turn-one-call');
  nextTurn.endTurn({ sessionId, turn: 1 });
  step(nextTurn, [message()], 2, 1);
  call(nextTurn, 'turn-two-replay', 2, 1);
  assert.equal(nextTurn.consume({ sessionId, turn: 1, step: 1, callId: 'turn-one-call' }), null);
  assert.equal(nextTurn.consume({ sessionId, turn: 2, step: 1, callId: 'turn-two-replay' }), null);
});

test('重复 step 与乱序 turn 回放均不能创建新的调用关联', () => {
  const duplicateStep = ledger();
  duplicateStep.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  step(duplicateStep);
  call(duplicateStep, 'initial-call');
  step(duplicateStep);
  call(duplicateStep, 'step-replay-call');
  assert.equal(duplicateStep.consume({ sessionId, turn: 1, step: 1, callId: 'step-replay-call' }), null);

  const replayedTurn = ledger();
  replayedTurn.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  step(replayedTurn);
  call(replayedTurn, 'turn-one-call');
  replayedTurn.endTurn({ sessionId, turn: 1 });
  step(replayedTurn, [message()], 2);
  replayedTurn.endTurn({ sessionId, turn: 2 });
  assert.equal(step(replayedTurn, [message()], 1), false);
  call(replayedTurn, 'replayed-turn-call', 1);
  assert.equal(replayedTurn.consume({ sessionId, turn: 1, step: 1, callId: 'replayed-turn-call' }), null);
});
