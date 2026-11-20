// Bounded-capacity recovery for the origin ledger.
//
// Defect under repair (found by independent review, reproduced by the captain):
// every `calls` / `steps` / `requests` map shared one `trackingLimit`, entries
// were never reaped, and hitting the limit set `continuityLost`, which poisons
// the WHOLE ledger forever (`validSession` false, `reconnect()` cannot revive).
// A model that retries a known-but-unwired tool therefore locked every later
// legitimate read out of the session until the connection rotated.
//
// The fix keeps replay protection intact and makes capacity a LOCAL refusal:
//  - `canAdd` no longer sets `continuityLost`; a full map refuses that one entry.
//  - `endTurn` deletes the ended turn's `calls` / `steps` entries. This is
//    ABA-safe: `observeStep` returns false for an ended turn before touching
//    `steps`, and `consume` returns null for an ended turn before reading
//    `calls`, so neither map is consulted for a turn that already ended.
//    `requests` / `usedRequests` / `poisonedRequests` are NOT reaped, so
//    requestId replay remains permanently poisoned.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

const sessionId = 'capacity-session';
const epoch = 'capacity-epoch';
const message = (rpcId) => ({ role: 'user', source: { rpcId } });

function openTurn(ledger, { turn, step = 1, requestId, callIds }) {
  ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  const observed = ledger.observeStep({ sessionId, turn, step, messages: [message(requestId)] });
  const calls = callIds.map((callId) => ledger.observeToolCall({
    sessionId, event: { type: 'tool/call', data: { turn, step, callId } },
  }));
  return { observed, calls };
}

test('容量耗尽只拒绝该次登记，不得毒化整个账本', () => {
  const ledger = createQzoneOriginLedger({ sessionId, epoch, trackingLimit: 1 });
  openTurn(ledger, { turn: 1, requestId: 'r1', callIds: ['c1'] });

  // requests is now full (limit 1). A second registration must be refused...
  assert.throws(
    () => ledger.registerBridgeRequest({ requestId: 'r2', origin: 'qq-inbound' }),
    /来源账本/,
  );

  // ...but the ledger must still be usable for what it already authorized. If
  // capacity had poisoned `continuityLost`, this consume would return null.
  const consumed = ledger.consume({ sessionId, turn: 1, step: 1, callId: 'c1' });
  assert.ok(consumed, '容量耗尽后已有的合法绑定必须仍然可消费');
  assert.equal(consumed.requestId, 'r1');
});

test('登记后从未被步骤引用的请求不得永久占满 requests：小额度账本仍能接新回合', () => {
  // Defect found while checking Codex round-8 Q3c: `registerBridgeRequest` filled
  // `requests` and `endTurn` only reaps the request of the turn it closes, so a
  // bridge request whose turn never arrived (model error, aborted turn) kept its
  // slot for the life of the ledger. Enough of those reached `trackingLimit` and
  // every later registration threw — a session lockout with no attacker involved.
  //
  // Reaping the OLDEST never-observed request is safe: a bare registration
  // authenticates nothing and no step cited the id, so no binding can depend on
  // it. The evicted id is poisoned, so a late turn citing it is still refused.
  const ledger = createQzoneOriginLedger({ sessionId, epoch, trackingLimit: 2 });
  for (let index = 0; index < 4; index += 1) {
    ledger.registerBridgeRequest({ requestId: `abandoned-${index}`, origin: 'qq-inbound' });
  }
  // A real turn must still register, observe and dispatch.
  const { observed, calls } = openTurn(ledger, { turn: 1, requestId: 'r1', callIds: ['c1'] });
  assert.equal(observed, true, '遗弃请求不得阻止真实回合被观测');
  assert.deepEqual(calls, [true]);
  assert.ok(ledger.consume({ sessionId, turn: 1, step: 1, callId: 'c1' }));

  // A late turn citing an evicted request must stay refused, not become valid.
  // The bare `observeStep(...) === false` above cannot tell "poisoned" apart from
  // "never registered", so re-register the id first: if the eviction had dropped
  // the poison as well, this re-registration would make the id usable again.
  ledger.endTurn({ sessionId, turn: 1 });
  assert.equal(ledger.observeStep({ sessionId, turn: 2, step: 1, messages: [message('abandoned-0')] }), false,
    '被回收的遗弃 requestId 迟到也不得被接受');
  ledger.registerBridgeRequest({ requestId: 'abandoned-0', origin: 'qq-inbound' });
  assert.equal(ledger.observeStep({ sessionId, turn: 2, step: 1, messages: [message('abandoned-0')] }), false,
    '被回收的 requestId 即使重新登记也必须仍是毒化的');
  ledger.observeToolCall({ sessionId, event: { type: 'tool/call', data: { turn: 2, step: 1, callId: 'poisoned-call' } } });
  assert.equal(ledger.consume({ sessionId, turn: 2, step: 1, callId: 'poisoned-call' }), null,
    '被回收的 requestId 不得产出绑定');
});

test('容量只被已观测请求占满时仍拒绝新登记，不得挤掉自己的活回合', () => {
  // The reap must NOT be a general "clear when full": a request that a step already
  // cited carries a live binding, so evicting it would reopen a replay window.
  const ledger = createQzoneOriginLedger({ sessionId, epoch, trackingLimit: 1 });
  openTurn(ledger, { turn: 1, requestId: 'r1', callIds: ['c1'] });
  assert.throws(
    () => ledger.registerBridgeRequest({ requestId: 'r2', origin: 'qq-inbound' }),
    /来源账本/,
  );
  assert.ok(ledger.consume({ sessionId, turn: 1, step: 1, callId: 'c1' }),
    '被拒的新登记不得影响已观测回合的绑定');
});

test('endTurn 回收该回合的 calls 与 steps，小额度账本可长期使用', () => {
  const ledger = createQzoneOriginLedger({ sessionId, epoch, trackingLimit: 2 });

  for (let turn = 1; turn <= 6; turn += 1) {
    const { observed, calls } = openTurn(ledger, {
      turn, requestId: `r${turn}`, callIds: [`c${turn}`],
    });
    assert.equal(observed, true, `turn ${turn} 的 step 必须能被观测`);
    assert.deepEqual(calls, [true], `turn ${turn} 的 tool/call 必须能被观测`);
    const consumed = ledger.consume({ sessionId, turn, step: 1, callId: `c${turn}` });
    assert.ok(consumed, `turn ${turn} 必须能消费到绑定`);
    assert.equal(consumed.turn, turn);
    assert.equal(ledger.endTurn({ sessionId, turn }), true, `turn ${turn} 必须能正常结束`);
  }

  // Six turns on a limit-2 ledger. Before the fix turn 3 already threw
  // 「来源账本不可用或已满」 and every later turn stayed dead.
  assert.ok(true, '六个回合在 trackingLimit=2 下全部完成');
});

test('回合结束后仍不得重放该回合的调用或步骤', () => {
  const ledger = createQzoneOriginLedger({ sessionId, epoch, trackingLimit: 4 });
  openTurn(ledger, { turn: 1, requestId: 'r1', callIds: ['c1'] });
  ledger.consume({ sessionId, turn: 1, step: 1, callId: 'c1' });
  assert.equal(ledger.endTurn({ sessionId, turn: 1 }), true);

  // The ended turn must stay closed even though its keys were reaped.
  assert.equal(ledger.observeStep({ sessionId, turn: 1, step: 1, messages: [message('r1')] }), false);
  assert.equal(ledger.observeToolCall({ sessionId, event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1' } } }), false);
  assert.equal(ledger.consume({ sessionId, turn: 1, step: 1, callId: 'c1' }), null);
});

test('回收 calls 不得打开 requestId 重放窗口', () => {
  const ledger = createQzoneOriginLedger({ sessionId, epoch, trackingLimit: 8 });
  openTurn(ledger, { turn: 1, requestId: 'r1', callIds: ['c1'] });
  ledger.consume({ sessionId, turn: 1, step: 1, callId: 'c1' });
  ledger.endTurn({ sessionId, turn: 1 });

  // A fresh turn re-using r1 must still be poisoned: usedRequests is not reaped.
  const replay = ledger.observeStep({ sessionId, turn: 2, step: 1, messages: [message('r1')] });
  assert.equal(replay, false, '跨回合复用 requestId 必须被拒绝');
  ledger.observeToolCall({ sessionId, event: { type: 'tool/call', data: { turn: 2, step: 1, callId: 'c2' } } });
  assert.equal(ledger.consume({ sessionId, turn: 2, step: 1, callId: 'c2' }), null);
});

test('容量回收会牺牲仍在等待的最老请求：该取舍必须有文档，不得当成无副作用', () => {
  // Documented trade-off, not a defect: the reap at `registerBridgeRequest` takes
  // the OLDEST registration that no step has cited yet. A request that is
  // registered but whose turn has not arrived yet is therefore reapable. Before
  // the reap existed this could not happen, but the alternative was worse: one
  // overflow refused every later registration forever (see the first case above).
  // Both directions refuse rather than admit; this one needs `trackingLimit`
  // newer registrations to trigger, which at the default 4096 means 4096
  // registrations whose turn never arrived.
  const ledger = createQzoneOriginLedger({ sessionId, epoch, trackingLimit: 3 });
  ledger.registerBridgeRequest({ requestId: 'pending-real', origin: 'qq-inbound' });
  for (const id of ['junk-1', 'junk-2', 'junk-3']) {
    ledger.registerBridgeRequest({ requestId: id, origin: 'qq-inbound' });
  }
  // The pending request was the oldest unreferenced registration, so it is gone.
  assert.equal(ledger.observeStep({ sessionId, turn: 1, step: 1, messages: [message('pending-real')] }), false,
    '被回收的待处理请求，其回合必须被拒（fail closed，不是放行）');

  // A registration that arrives AFTER the pressure survives, which is the reason
  // the reap is oldest-first instead of a wholesale clear.
  const fresh = createQzoneOriginLedger({ sessionId, epoch, trackingLimit: 3 });
  for (const id of ['junk-1', 'junk-2', 'junk-3']) {
    fresh.registerBridgeRequest({ requestId: id, origin: 'qq-inbound' });
  }
  fresh.registerBridgeRequest({ requestId: 'pending-real', origin: 'qq-inbound' });
  assert.equal(fresh.observeStep({ sessionId, turn: 1, step: 1, messages: [message('pending-real')] }), true,
    '在容量压力之后才到达的请求必须存活');
});

test('同回合内超额的 tool/call 只被拒，不影响该回合已建立的绑定', () => {
  const ledger = createQzoneOriginLedger({ sessionId, epoch, trackingLimit: 3 });
  const { observed } = openTurn(ledger, { turn: 1, requestId: 'r1', callIds: [] });
  assert.equal(observed, true);

  const verdicts = ['a', 'b', 'c', 'd'].map((callId) => ledger.observeToolCall({
    sessionId, event: { type: 'tool/call', data: { turn: 1, step: 1, callId } },
  }));
  // `requests` already holds r1 and shares the same trackingLimit, so `calls`
  // has room for two more entries: three admitted, the rest refused.
  assert.equal(verdicts[0], true);
  assert.equal(verdicts[1], true);
  assert.equal(verdicts[2], true);
  assert.equal(verdicts[3], false, '超过 trackingLimit 的 tool/call 必须被拒');

  // The three that were admitted must still be consumable: a refusal must not
  // poison the ledger.
  assert.ok(ledger.consume({ sessionId, turn: 1, step: 1, callId: 'a' }));
  assert.ok(ledger.consume({ sessionId, turn: 1, step: 1, callId: 'b' }));
  assert.ok(ledger.consume({ sessionId, turn: 1, step: 1, callId: 'c' }));
});

test('位置非法的 tool/call 不占 calls 容量，后续合法回合仍可用（历史缺陷）', () => {
  // Defect under repair: an out-of-position tool/call (a turn that was never
  // observed) was recorded in `calls` with turn 0. `endTurn` only reaps entries
  // whose turn matches the ending turn, so those entries were permanent: enough
  // stray events filled `calls` and refused every later legitimate call for the
  // rest of the session. They can never produce a binding anyway, so they must
  // not occupy a slot at all.
  const ledger = createQzoneOriginLedger({ sessionId, epoch, trackingLimit: 2 });

  // Six stray events on an unobserved turn, i.e. three times the limit.
  for (let index = 0; index < 6; index += 1) {
    assert.equal(ledger.observeToolCall({
      sessionId, event: { type: 'tool/call', data: { turn: 99, step: 1, callId: `stray${index}` } },
    }), false, '位置非法的 tool/call 必须被拒');
  }

  // The legitimate turn must still work end to end.
  const { observed, calls } = openTurn(ledger, { turn: 1, requestId: 'r1', callIds: ['good'] });
  assert.equal(observed, true);
  assert.deepEqual(calls, [true], '脏事件不得挤占合法 tool/call 的容量');
  const consumed = ledger.consume({ sessionId, turn: 1, step: 1, callId: 'good' });
  assert.ok(consumed, '合法调用必须仍可消费');

  // And the stray ids stay spent forever, so re-reporting one is still refused.
  assert.equal(ledger.observeToolCall({
    sessionId, event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'stray0' } },
  }), false, '被拒过的 callId 必须永久失效，不能借后续回合复活');
  assert.equal(ledger.peekCall('stray0'), null);
});

