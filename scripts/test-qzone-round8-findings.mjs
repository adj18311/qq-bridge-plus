// Round-8 findings F1 / F2 / F4 (independent review 5e2996ff) + the coverage gaps
// it exposed (F3). Each case names the defect it pins so a future regression cannot
// silently restore it.
//
// F1  a turn may cite more than one requestId. `endTurn` and the capacity reap both
//     went through `turnRequests`, which used to remember only the FIRST id per
//     turn — so the extra ids were unfreeable by either path and `requests` filled
//     up permanently. The visible symptom was not a throw but silently lost work:
//     every later turn's first step was refused (its id had just been reaped).
// F2  a pre-step for a turn at or below `maxTurn` used to set `continuityLost` —
//     permanently, since `reconnect()` sets it too. Once `ended` aged past its
//     64-turn window, one late duplicate pre-step killed the ledger for good.
// F4  a callId refused because `calls` was full was not added to `spentCalls`, so
//     the refusal was advisory: a later turn re-reported the same id and it bound.
// F3  coverage: the previous suite had no case at all for the reap's poisoning, for
//     the `ended` aging logic, or for "a capacity-refused callId stays refused".

import assert from 'node:assert/strict';
import test from 'node:test';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

const sessionId = 'round8-session';
const epoch = 'round8-epoch';
const message = (rpcId) => ({ role: 'user', source: { rpcId } });
const stepOf = (turn, step, rpcId) => ({ sessionId, turn, step, messages: [message(rpcId)] });
const callOf = (turn, step, callId) => ({ sessionId, event: { type: 'tool/call', data: { turn, step, callId } } });

function ledgerOf(trackingLimit) {
  return createQzoneOriginLedger({ sessionId, epoch, trackingLimit });
}

// ---------------------------------------------------------------------------
// F1 — every requestId a turn cites must be reapable with that turn
// ---------------------------------------------------------------------------
test('F1 一回合引用两个 requestId 时两个都必须随回合回收，不得永久占满 requests', () => {
  const ledger = ledgerOf(4);
  for (let turn = 1; turn <= 8; turn += 1) {
    const first = `r${turn}a`;
    const second = `r${turn}b`;
    assert.doesNotThrow(() => ledger.registerBridgeRequest({ requestId: first, origin: 'qq-inbound' }),
      `turn ${turn} 的第一个 requestId 必须能登记`);
    assert.doesNotThrow(() => ledger.registerBridgeRequest({ requestId: second, origin: 'qq-inbound' }),
      `turn ${turn} 的第二个 requestId 必须能登记`);
    // The first step of the turn is the one that used to be sacrificed once
    // `requests` filled with the leaked second ids of earlier turns.
    assert.equal(ledger.observeStep(stepOf(turn, 1, first)), true,
      `turn ${turn} 的第一个 step 必须被观测到（泄漏时它在第 4 回合起失效）`);
    assert.equal(ledger.observeStep(stepOf(turn, 2, second)), true,
      `turn ${turn} 的第二个 step 必须被观测到`);
    assert.equal(ledger.endTurn({ sessionId, turn }), true, `turn ${turn} 必须能结束`);
  }
});

test('F1 引用两个 requestId 的回合仍必须被投毒：不得因此产出绑定', () => {
  // Recording the extra id must not weaken the rule that a turn citing two
  // different requestIds has ambiguous provenance. It is tainted either way.
  const ledger = ledgerOf(8);
  ledger.registerBridgeRequest({ requestId: 'a1', origin: 'qq-inbound' });
  ledger.registerBridgeRequest({ requestId: 'a2', origin: 'qq-inbound' });
  assert.equal(ledger.observeStep(stepOf(1, 1, 'a1')), true);
  assert.equal(ledger.observeStep(stepOf(1, 2, 'a2')), true);
  assert.equal(ledger.observeToolCall(callOf(1, 1, 'k1')), true);
  assert.equal(ledger.consume({ sessionId, turn: 1, step: 1, callId: 'k1' }), null,
    '同一回合引用两个 requestId 必须被投毒，绑定不可用');
});

test('F1 单 requestId 回合的回收行为不得改变（对照）', () => {
  const ledger = ledgerOf(2);
  for (let turn = 1; turn <= 10; turn += 1) {
    ledger.registerBridgeRequest({ requestId: `only-${turn}`, origin: 'qq-inbound' });
    assert.equal(ledger.observeStep(stepOf(turn, 1, `only-${turn}`)), true);
    assert.equal(ledger.observeToolCall(callOf(turn, 1, `c-${turn}`)), true);
    assert.ok(ledger.consume({ sessionId, turn, step: 1, callId: `c-${turn}` }));
    assert.equal(ledger.endTurn({ sessionId, turn }), true);
  }
});

// ---------------------------------------------------------------------------
// F2 — a stale pre-step must be refused, not turned into a permanent poison
// ---------------------------------------------------------------------------
test('F2 超出 ended 窗口的迟到 pre-step 只拒绝，不得永久毒化账本', () => {
  const ledger = ledgerOf(4096);
  const window = 64;
  for (let turn = 1; turn <= window + 3; turn += 1) {
    ledger.registerBridgeRequest({ requestId: `w${turn}`, origin: 'qq-inbound' });
    ledger.observeStep(stepOf(turn, 1, `w${turn}`));
    ledger.endTurn({ sessionId, turn });
  }
  // Turn 2 has aged out of `ended` by now; a duplicate pre-step arrives late.
  assert.equal(ledger.observeStep(stepOf(2, 1, 'w2')), false, '迟到 pre-step 必须被拒');
  // ...and the next legitimate turn must still work.
  assert.doesNotThrow(() => ledger.registerBridgeRequest({ requestId: 'w-next', origin: 'qq-inbound' }),
    '迟到 pre-step 之后账本必须仍可登记');
  assert.equal(ledger.observeStep(stepOf(window + 4, 1, 'w-next')), true,
    '迟到 pre-step 之后下一回合必须仍能被观测');
});

test('F2 窗口内的迟到 pre-step 行为不变（对照）', () => {
  const ledger = ledgerOf(4096);
  for (let turn = 1; turn <= 5; turn += 1) {
    ledger.registerBridgeRequest({ requestId: `x${turn}`, origin: 'qq-inbound' });
    ledger.observeStep(stepOf(turn, 1, `x${turn}`));
    ledger.endTurn({ sessionId, turn });
  }
  assert.equal(ledger.observeStep(stepOf(3, 1, 'x3')), false);
  ledger.registerBridgeRequest({ requestId: 'x6', origin: 'qq-inbound' });
  assert.equal(ledger.observeStep(stepOf(6, 1, 'x6')), true);
});

test('F2 真正的前向跳跃仍必须判定证据丢失（不得放宽）', () => {
  // The relaxation above only covers turn <= maxTurn. A forward gap skips a turn
  // whose events were never seen at all, which is still lost ordering evidence.
  const ledger = ledgerOf(4096);
  ledger.registerBridgeRequest({ requestId: 'g1', origin: 'qq-inbound' });
  ledger.observeStep(stepOf(1, 1, 'g1'));
  ledger.endTurn({ sessionId, turn: 1 });
  assert.equal(ledger.observeStep(stepOf(3, 1, 'g3')), false, '跳过 turn 2 必须被拒');
  assert.throws(() => ledger.registerBridgeRequest({ requestId: 'g4', origin: 'qq-inbound' }),
    /来源账本/, '前向跳跃之后账本必须失败关闭');
});

// ---------------------------------------------------------------------------
// F4 — a capacity refusal must be terminal for that callId
// ---------------------------------------------------------------------------
test('F4 因容量被拒的 callId 必须立即失效，不得在下个回合复活并绑定', () => {
  const ledger = ledgerOf(3);
  ledger.registerBridgeRequest({ requestId: 'r1', origin: 'qq-inbound' });
  ledger.observeStep(stepOf(1, 1, 'r1'));
  assert.deepEqual(['a', 'b', 'c'].map((id) => ledger.observeToolCall(callOf(1, 1, id))), [true, true, true]);
  assert.equal(ledger.observeToolCall(callOf(1, 1, 'late')), false, '满容量时必须拒绝');

  ledger.endTurn({ sessionId, turn: 1 });
  ledger.registerBridgeRequest({ requestId: 'r2', origin: 'qq-inbound' });
  assert.equal(ledger.observeStep(stepOf(2, 1, 'r2')), true);
  assert.equal(ledger.observeToolCall(callOf(2, 1, 'late')), false,
    '被容量拒过的 callId 下个回合必须仍被拒（不得复活）');
  assert.equal(ledger.consume({ sessionId, turn: 2, step: 1, callId: 'late' }), null,
    '被容量拒过的 callId 不得产出绑定');
});

// ---------------------------------------------------------------------------
// F3 — coverage the review found missing
// ---------------------------------------------------------------------------
test('F3 被容量回收的 requestId 必须被投毒：迟到回合引用它不得被接受', () => {
  const ledger = ledgerOf(2);
  // Fill with abandoned registrations so the next one has to reap.
  for (let index = 0; index < 4; index += 1) {
    ledger.registerBridgeRequest({ requestId: `ab-${index}`, origin: 'qq-inbound' });
  }
  // `ab-0` / `ab-1` were reaped; a turn citing one must be refused AND must not
  // become usable later by re-registering it.
  assert.equal(ledger.observeStep(stepOf(1, 1, 'ab-0')), false, '被回收的 requestId 迟到引用必须被拒');
  assert.doesNotThrow(() => ledger.registerBridgeRequest({ requestId: 'ab-0', origin: 'qq-inbound' }),
    '被回收的 id 重新登记本身允许，但必须立刻投毒');
  assert.equal(ledger.observeStep(stepOf(2, 1, 'ab-0')), false,
    '被回收后又重新登记的 requestId 必须仍被拒（毒化不得丢失）');
});

test('F3 已消费的 callId 在 calls 被回收后重放仍必须被拒', () => {
  const ledger = ledgerOf(4);
  ledger.registerBridgeRequest({ requestId: 'r1', origin: 'qq-inbound' });
  ledger.observeStep(stepOf(1, 1, 'r1'));
  ledger.observeToolCall(callOf(1, 1, 'spent'));
  assert.ok(ledger.consume({ sessionId, turn: 1, step: 1, callId: 'spent' }));
  ledger.endTurn({ sessionId, turn: 1 });

  ledger.registerBridgeRequest({ requestId: 'r2', origin: 'qq-inbound' });
  ledger.observeStep(stepOf(2, 1, 'r2'));
  assert.equal(ledger.observeToolCall(callOf(2, 1, 'spent')), false,
    '回收后重放已消费的 callId 必须被拒');
  assert.equal(ledger.consume({ sessionId, turn: 2, step: 1, callId: 'spent' }), null);
});

test('F3 ended 老化窗口不得让已结束的回合重新可用', () => {
  const ledger = ledgerOf(4096);
  const window = 64;
  for (let turn = 1; turn <= window + 2; turn += 1) {
    ledger.registerBridgeRequest({ requestId: `o${turn}`, origin: 'qq-inbound' });
    ledger.observeStep(stepOf(turn, 1, `o${turn}`));
    ledger.endTurn({ sessionId, turn });
  }
  // Turn 1 is out of `ended` now. Replaying it must still be refused, just by the
  // `turn <= maxTurn` path rather than the `ended` set.
  assert.equal(ledger.observeStep(stepOf(1, 1, 'o1')), false, '老化后的已结束回合重放必须被拒');
  assert.equal(ledger.observeToolCall(callOf(1, 1, 'o-call')), false, '老化回合的 tool/call 必须被拒');
});
