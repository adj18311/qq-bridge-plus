import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

// Round-9 review, medium-1. Capacity overflow costs TWO pending calls, not one:
//   1. the plugin position table evicts the oldest live position (counted as
//      `positionsEvictedLive`), and
//   2. `observeToolCall` refuses the NEWEST callId because `calls` is full — and that
//      half used to move no counter at all, so status showed one loss where two
//      happened.
// The refusal must stay terminal and fail-closed; only the tally is new.

function ledger(trackingLimit = 2) {
  return createQzoneOriginLedger({ sessionId: 's1', epoch: 'e1', trackingLimit });
}

// `observeToolCall` only binds inside a step that cited a registered request, so every
// turn has to be opened the way the bridge does it.
function openTurn(l, turn, requestId) {
  l.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  assert.equal(l.observeStep({ sessionId: 's1', turn, step: 1,
    messages: [{ role: 'user', source: { rpcId: requestId } }] }), true, `turn ${turn} 必须能绑定`);
}

function event(callId, turn = 1, step = 1) {
  return { type: 'tool/call', data: { turn, step, callId, name: 'qzone_read_posts' } };
}

test('容量拒绝必须在账本侧被计数：一次溢出牺牲两个待派发调用不得只留一个痕', () => {
  const l = ledger(2);
  assert.equal(l.stats().callsRefusedCapacity, 0);
  openTurn(l, 1, 'r1');

  assert.equal(l.observeToolCall({ sessionId: 's1', event: event('c1') }), true);
  assert.equal(l.observeToolCall({ sessionId: 's1', event: event('c2') }), true);
  assert.equal(l.stats().callsRefusedCapacity, 0, '容量内不得误计');

  assert.equal(l.observeToolCall({ sessionId: 's1', event: event('c3') }), false, '超出容量必须拒绝');
  assert.equal(l.stats().callsRefusedCapacity, 1, '被容量拒绝的那个 callId 必须留痕');

  assert.equal(l.observeToolCall({ sessionId: 's1', event: event('c4') }), false);
  assert.equal(l.stats().callsRefusedCapacity, 2, '每一次容量拒绝都要计数');
});

test('容量拒绝被计数后仍然是终局：同一 callId 不得在下个回合复活', () => {
  const l = ledger(1);
  openTurn(l, 1, 'r1');
  assert.equal(l.observeToolCall({ sessionId: 's1', event: event('c1') }), true);
  assert.equal(l.observeToolCall({ sessionId: 's1', event: event('c2') }), false);
  assert.equal(l.stats().callsRefusedCapacity, 1);

  // 下一回合：`calls` 被 endTurn 回收，但 `spentCalls` 记得 c2。
  l.endTurn({ sessionId: 's1', turn: 1 });
  openTurn(l, 2, 'r2');
  assert.equal(l.observeToolCall({ sessionId: 's1', event: event('c2', 2, 1) }), false,
    '因容量被拒的 callId 必须在 spentCalls 里，重报仍然拒绝');
  assert.equal(l.stats().callsRefusedCapacity, 1, '重复上报走投毒分支，不得再计一次容量');
  assert.equal(l.peekCall('c2'), null);
  // 对照：全新的 id 在同一位置仍可绑定，证明拒绝来自 spentCalls 而不是回合坏了。
  assert.equal(l.observeToolCall({ sessionId: 's1', event: event('c3', 2, 1) }), true);
});

test('stats 是只读遥测：调用方拿不到可变内部状态，也不影响账本判定', () => {
  const l = ledger(4);
  openTurn(l, 1, 'r1');
  const first = l.stats();
  assert.equal(Object.isFrozen(first), true);
  l.observeToolCall({ sessionId: 's1', event: event('c1') });
  assert.equal(first.spentCalls, 0, '快照不得随后续写入而改变');
  assert.equal(l.stats().spentCalls, 1);
  // 篡改快照不改变账本本身
  assert.throws(() => { first.callsRefusedCapacity = 99; }, TypeError);
  assert.equal(l.stats().callsRefusedCapacity, 0);
});
