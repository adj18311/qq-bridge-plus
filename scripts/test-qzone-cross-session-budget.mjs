import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

// Offline only: every QQ/OneBot effect is a local fake. No network, no real QQ.
//
// Two defects found by independent review are pinned here:
//
//  1. The tracking budget was counted over the whole `seenCalls` set while the set
//     itself is keyed by sessionId + callId. One runtime serves several sessions,
//     so the first session to reach `trackingLimit` refused every other session's
//     tools with `tracking-capacity` even though their own ledgers were healthy.
//     The budget must be counted per session.
//
//  2. `registerBridgeRequest` and `observeToolCall` accepted ids of any length,
//     and both `usedRequests` and `spentCalls` retain those strings for the life of
//     the ledger with no delete path. Every other id in the subsystem is capped at
//     128, so a 1 MiB requestId could be pinned in memory forever.

const now = Date.parse('2026-11-10T04:00:00Z');
const SESSION_A = 'sess-a';
const SESSION_B = 'sess-b';
const FRIEND = 456;

function makeStore() {
  let state = {
    enabled: true, readAllowed: true, writeAllowed: false, accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: false }, reads: 0, writes: 0, readAttempts: {}, readOutcomes: {},
    notices: [], browseDay: '2026-11-10', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
    activeStart: 0, activeEnd: 1439, audit: [],
  };
  return {
    read: () => structuredClone(state),
    update(fn) { state = fn(structuredClone(state)); return structuredClone(state); },
  };
}

// One runtime, one ledger per session: exactly the shape the reviewer used to
// starve a second session.
function makeMultiSessionRuntime({ trackingLimit = 2 } = {}) {
  const ledgers = new Map();
  const sessionIds = [SESSION_A, SESSION_B];
  for (const sessionId of sessionIds) {
    ledgers.set(sessionId, createQzoneOriginLedger({ sessionId, epoch: 'e1' }));
  }
  const calls = [];
  const runtime = createQzoneRuntime({
    store: makeStore(), botQq: 123, sourceEpoch: 'e1',
    authorizeSource: (consumption) => ledgers.get(consumption.sessionId)?.ownsConsumption(consumption) === true,
    getConnectionEpoch: () => 8,
    getBridgeSessions: (sessionId) => ledgers.get(sessionId) ?? null,
    clock: () => now, mode: 'read-only', trackingLimit,
    call: async (action) => {
      calls.push(action);
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
      if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: FRIEND }] };
      if (action === 'get_qzone_msg_list') return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
      throw new Error(`unexpected action ${action}`);
    },
  });
  return { runtime, ledgers, calls };
}

// Each session keeps its own turn counter, and every turn is closed: an open turn
// makes the next observeStep set continuityLost permanently.
let turnNo = 0;
function turn(ledger, sessionId, callId) {
  turnNo += 1;
  const requestId = `rpc-${sessionId}-${turnNo}`;
  ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  ledger.observeStep({ sessionId, turn: turnNo, step: 1, messages: [{ role: 'user', source: { rpcId: requestId } }] });
  ledger.observeToolCall({ sessionId, event: { type: 'tool/call', data: { turn: turnNo, step: 1, callId } } });
  return turnNo;
}

test('一个会话花光 tracking 额度不得饿死同一 runtime 上的另一个会话', async () => {
  const { runtime, ledgers, calls } = makeMultiSessionRuntime({ trackingLimit: 2 });
  const ctx = (sessionId, callId) => ({ sessionId, callId });
  const input = { target_uin: FRIEND };

  // Session A spends the entire budget with two genuine reads.
  for (const callId of ['a1', 'a2']) {
    const turnIndex = turn(ledgers.get(SESSION_A), SESSION_A, callId);
    const result = await runtime.dispatch('read_posts', input, ctx(SESSION_A, callId));
    assert.equal(result.outcome, 'success', `${callId} 必须是成功读`);
    ledgers.get(SESSION_A).endTurn({ sessionId: SESSION_A, turn: turnIndex });
  }

  // A is now exhausted.
  const aThird = turn(ledgers.get(SESSION_A), SESSION_A, 'a3');
  assert.equal((await runtime.dispatch('read_posts', input, ctx(SESSION_A, 'a3'))).error, 'tracking-capacity',
    'A 自己花光后必须被 tracking-capacity 拒绝');
  ledgers.get(SESSION_A).endTurn({ sessionId: SESSION_A, turn: aThird });

  // B must be unaffected: its own ledger is healthy and it has spent nothing.
  const callsBeforeB = calls.length;
  const bTurn = turn(ledgers.get(SESSION_B), SESSION_B, 'b1');
  const bResult = await runtime.dispatch('read_posts', input, ctx(SESSION_B, 'b1'));
  ledgers.get(SESSION_B).endTurn({ sessionId: SESSION_B, turn: bTurn });
  assert.equal(bResult.outcome, 'success',
    'B 的额度必须独立：A 花光不得让 B 收到 tracking-capacity');
  assert.ok(calls.length > callsBeforeB, 'B 的读必须真的走到 transport');
});

test('每个会话的额度独立计数：B 花光后 A 的既有拒绝状态不受影响，新会话仍可用', async () => {
  const { runtime, ledgers } = makeMultiSessionRuntime({ trackingLimit: 1 });
  const ctx = (sessionId, callId) => ({ sessionId, callId });
  const input = { target_uin: FRIEND };

  const aTurn = turn(ledgers.get(SESSION_A), SESSION_A, 'a1');
  assert.equal((await runtime.dispatch('read_posts', input, ctx(SESSION_A, 'a1'))).outcome, 'success');
  ledgers.get(SESSION_A).endTurn({ sessionId: SESSION_A, turn: aTurn });

  const bTurn = turn(ledgers.get(SESSION_B), SESSION_B, 'b1');
  assert.equal((await runtime.dispatch('read_posts', input, ctx(SESSION_B, 'b1'))).outcome, 'success',
    'trackingLimit 1 时 B 的第一读仍必须成功');
  ledgers.get(SESSION_B).endTurn({ sessionId: SESSION_B, turn: bTurn });

  const aTurn2 = turn(ledgers.get(SESSION_A), SESSION_A, 'a2');
  assert.equal((await runtime.dispatch('read_posts', input, ctx(SESSION_A, 'a2'))).error, 'tracking-capacity',
    'A 的额度用完后仍必须失败关闭');
  ledgers.get(SESSION_A).endTurn({ sessionId: SESSION_A, turn: aTurn2 });
});

test('超过 128 字符的 requestId 必须在账本边界被拒，不得进入 requests/usedRequests', () => {
  const ledger = createQzoneOriginLedger({ sessionId: SESSION_A, epoch: 'e1' });
  const huge = 'r'.repeat(1024 * 1024);
  assert.throws(() => ledger.registerBridgeRequest({ requestId: huge, origin: 'qq-inbound' }),
    /桥接 request 登记非法/, '1 MiB requestId 必须被拒');
  assert.throws(() => ledger.registerBridgeRequest({ requestId: 'x'.repeat(129), origin: 'qq-inbound' }),
    /桥接 request 登记非法/, '129 字符已超上限');
  // 128 is the documented cap and must still work.
  assert.doesNotThrow(() => ledger.registerBridgeRequest({ requestId: 'y'.repeat(128), origin: 'qq-inbound' }),
    '128 字符是上限本身，必须被接受');
  assert.doesNotThrow(() => ledger.registerBridgeRequest({ requestId: 'rpc-ok', origin: 'qq-inbound' }),
    '普通长度不受影响');
});

test('超过 128 字符的 callId 不得进入 spentCalls / calls', () => {
  const ledger = createQzoneOriginLedger({ sessionId: SESSION_A, epoch: 'e1' });
  ledger.registerBridgeRequest({ requestId: 'rpc-1', origin: 'qq-inbound' });
  ledger.observeStep({ sessionId: SESSION_A, turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'rpc-1' } }] });
  const huge = 'c'.repeat(1024 * 1024);
  assert.equal(ledger.observeToolCall({ sessionId: SESSION_A,
    event: { type: 'tool/call', data: { turn: 1, step: 1, callId: huge } } }), false,
  '超长 callId 必须被拒');
  // The same id must be refused on a second report too: it was never spent, but it
  // is over the length gate, which is checked before every other branch.
  assert.equal(ledger.observeToolCall({ sessionId: SESSION_A,
    event: { type: 'tool/call', data: { turn: 1, step: 1, callId: huge } } }), false,
  '超长 callId 的重复上报同样必须被拒');
  // A normal-length callId at the same position still binds: the gate rejects the
  // id, not the position.
  assert.equal(ledger.observeToolCall({ sessionId: SESSION_A,
    event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c-ok' } } }), true,
  '同一位置的正常 callId 必须仍能绑定');
  assert.notEqual(ledger.consume({ sessionId: SESSION_A, turn: 1, step: 1, callId: 'c-ok' }), null);
  assert.equal(ledger.consume({ sessionId: SESSION_A, turn: 1, step: 1, callId: huge }), null,
    '超长 callId 永远不得铸出 binding');
});

test('长度闸必须在 spentCalls.add 之前：超长 callId 不得被账本留住', () => {
  // The gate and the spend are adjacent lines, and BOTH orderings refuse the call, so
  // no assertion on return values can tell them apart — which is why moving the spend
  // above the gate survived the whole suite. `spentCalls` has no delete path, so the
  // only observable difference is retained memory: 32 × 1 MiB ids cost ~32 MB when
  // they are recorded first, and ~0 when the gate rejects them before the add.
  const ledger = createQzoneOriginLedger({ sessionId: SESSION_A, epoch: 'e1' });
  ledger.registerBridgeRequest({ requestId: 'rpc-1', origin: 'qq-inbound' });
  ledger.observeStep({ sessionId: SESSION_A, turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'rpc-1' } }] });

  const settle = () => {
    if (typeof global.gc === 'function') { global.gc(); global.gc(); }
    return process.memoryUsage().heapUsed;
  };
  const before = settle();
  for (let index = 0; index < 32; index++) {
    assert.equal(ledger.observeToolCall({ sessionId: SESSION_A, event: { type: 'tool/call',
      data: { turn: 1, step: 1, callId: `${String(index).padStart(4, '0')}${'x'.repeat(1024 * 1024)}` } } }), false,
    '超长 callId 必须被拒');
  }
  const retainedMB = (settle() - before) / (1024 * 1024);
  // The threshold sits an order of magnitude away from BOTH outcomes: ~0 when the gate
  // runs first, ~32 MB when the spend does. Measurement noise without `global.gc` was
  // measured at 0.06 MB for this loop.
  assert.ok(retainedMB < 8,
    `超长 callId 不得被 spentCalls 留住：实测 ${retainedMB.toFixed(2)} MB，说明长度闸跑在 spentCalls.add 之后`);
});
