import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

// Offline only: every QQ/OneBot effect is a local fake. No network, no real QQ.
//
// Pins the invariant that keeps `requestTurns` (the `const requestTurns = new Map()`
// declaration in qzone-runtime-wiring.mjs)
// bounded without its own limit: every dispatch must first take a `seenCalls`
// slot and is denied at `trackingLimit`, and one requestId is written at most
// once, so distinct requestIds <= seenCalls.size <= trackingLimit. These tests
// also pin the failure mode: exhaustion keeps denying forever, it never clears
// the tracking state (clearing would re-admit a replayed callId = ABA replay).
//
// The two halves of that invariant are pinned separately:
//  - "every dispatch first takes a seenCalls slot" -> the capacity tests below.
//  - "one requestId is written at most once"      -> the cross-generation test
//    at the bottom, which is the only assertion here that actually depends on
//    `requestTurns` being keyed by requestId rather than by callId.
const now = Date.parse('2026-11-10T04:00:00Z');
const SESSION = 's1';

function makeStore() {
  let state = {
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true, publish: true, comment: true }, reads: 0, writes: 0, readAttempts: {}, readOutcomes: {},
    notices: [], browseDay: '2026-11-10', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
    activeStart: 0, activeEnd: 1439, audit: [],
  };
  return {
    read: () => structuredClone(state),
    update(fn) { state = fn(structuredClone(state)); return structuredClone(state); },
  };
}

function makeRuntime({ trackingLimit, store, clock } = {}) {
  const calls = [];
  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1' });
  const runtime = createQzoneRuntime({
    store: store ?? makeStore(), botQq: 123, sourceEpoch: 'e1',
    authorizeSource: (consumption) => ledger.ownsConsumption(consumption),
    getConnectionEpoch: () => 8,
    getBridgeSessions: (sessionId) => (sessionId === SESSION ? ledger : null),
    clock: clock ?? (() => now), mode: 'read-only',
    ...(trackingLimit === undefined ? {} : { trackingLimit }),
    call: async (action) => {
      calls.push(action);
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
      if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
      if (action === 'get_qzone_msg_list') return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
      throw new Error(`unexpected action ${action}`);
    },
  });
  return { runtime, ledger, calls };
}

// One bridge request per turn: the ledger allows a single rpcId per turn, and a
// turn must be closed with endTurn before the next turn can be observed.
function turn(ledger, index, callIds) {
  ledger.registerBridgeRequest({ requestId: `rpc-${index}`, origin: 'qq-inbound' });
  ledger.observeStep({ sessionId: SESSION, turn: index, step: 1,
    messages: [{ role: 'user', source: { rpcId: `rpc-${index}` } }] });
  for (const callId of callIds) {
    ledger.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn: index, step: 1, callId } } });
  }
}

const ctx = (callId) => ({ sessionId: SESSION, callId });
const input = { target_uin: 456 };

test('seenCalls 容量耗尽后每个新 requestId 都被 tracking-capacity 拒绝，不清空后重新放行', async () => {
  const { runtime, ledger, calls } = makeRuntime({ trackingLimit: 2 });
  for (const index of [1, 2]) {
    turn(ledger, index, [`c${index}`]);
    assert.equal((await runtime.dispatch('read_posts', input, ctx(`c${index}`))).outcome, 'success', `turn ${index}`);
    ledger.endTurn({ sessionId: SESSION, turn: index });
  }
  const callsBefore = calls.length;
  // A clear-on-overflow implementation would accept the next turn and reset the
  // tracking state; every subsequent turn must instead stay denied.
  for (const index of [3, 4]) {
    turn(ledger, index, [`c${index}`]);
    assert.deepEqual(await runtime.dispatch('read_posts', input, ctx(`c${index}`)),
      { ok: false, error: 'tracking-capacity' }, `turn ${index} 必须失败关闭`);
  }
  assert.equal(calls.length, callsBefore, '容量拒绝必须发生在任何 QQ 调用之前');
});

test('容量耗尽后旧 callId 仍是 origin-unverified：tracking 记录没有被清空', async () => {
  const { runtime, ledger } = makeRuntime({ trackingLimit: 1 });
  turn(ledger, 1, ['c1']);
  assert.equal((await runtime.dispatch('read_posts', input, ctx('c1'))).outcome, 'success');
  ledger.endTurn({ sessionId: SESSION, turn: 1 });
  turn(ledger, 2, ['c2']);
  assert.equal((await runtime.dispatch('read_posts', input, ctx('c2'))).error, 'tracking-capacity');
  // If the exhausted path had cleared the single-use set, this replay would be
  // re-admitted; it must stay rejected.
  assert.equal((await runtime.dispatch('read_posts', input, ctx('c1'))).error, 'origin-unverified');
  assert.equal((await runtime.dispatch('read_posts', input, ctx('c2'))).error, 'tracking-capacity');
});

test('容量按 callId 计：同一回合两个调用已占满 seenCalls 时，下一个 requestId 仍被 tracking-capacity 拒绝', async () => {
  // Two calls, one requestId: requestTurns records one entry, seenCalls two.
  // This pins the seenCalls half of the bound only. It deliberately does NOT
  // prove requestTurns is keyed by requestId — that half is pinned by the
  // cross-generation test below.
  const { runtime, ledger } = makeRuntime({ trackingLimit: 2 });
  turn(ledger, 1, ['f1', 'f2']);
  assert.equal((await runtime.dispatch('read_posts', input, ctx('f1'))).outcome, 'success');
  assert.equal((await runtime.dispatch('read_posts', input, ctx('f2'))).outcome, 'success');
  ledger.endTurn({ sessionId: SESSION, turn: 1 });
  // seenCalls is full at this point, so the next turn is denied even though only
  // one requestId has ever been recorded.
  turn(ledger, 2, ['f3']);
  assert.equal((await runtime.dispatch('read_posts', input, ctx('f3'))).error, 'tracking-capacity');
});

test('同一 requestId 跨代际复用到不同 turn 时必须被 origin-unverified 拒绝（requestTurns 以 requestId 为键）', async () => {
  // The other half of the bound: requestTurns holds at most one turn per
  // requestId, so replaying a requestId in a later turn is refused by the
  // `priorTurn !== undefined && priorTurn !== consumption.turn` guard in
  // qzone-runtime-wiring.mjs dispatch step 3 (look for `const priorTurn`). Each
  // generation gets a brand-new ledger so the ledger itself would happily accept
  // the requestId (fresh `requests` and `usedRequests`), which makes that guard
  // the only possible rejection point. If requestTurns were keyed by callId
  // instead, the replay would be accepted.
  const calls = [];
  const generations = [];
  const freshLedger = () => {
    const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1' });
    generations.push(ledger);
    return ledger;
  };
  let active = freshLedger();
  const runtime = createQzoneRuntime({
    store: makeStore(), botQq: 123, sourceEpoch: 'e1',
    authorizeSource: (consumption) => generations.some((ledger) => ledger.ownsConsumption(consumption)),
    getConnectionEpoch: () => 8,
    getBridgeSessions: (sessionId) => (sessionId === SESSION ? active : null),
    clock: () => now, mode: 'read-only',
    call: async (action) => {
      calls.push(action);
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
      if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
      if (action === 'get_qzone_msg_list') return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
      throw new Error(`unexpected action ${action}`);
    },
  });

  // gen1 turn 1 with requestId rpc-1 and two calls in the same turn/step. The
  // first dispatch writes requestTurns[rpc-1] = 1; the second sees the same turn
  // and stays allowed. This is the "same requestId, same turn" control.
  turn(active, 1, ['g1a', 'g1b']);
  assert.equal((await runtime.dispatch('read_posts', input, ctx('g1a'))).outcome, 'success', 'gen1 first call');
  assert.equal((await runtime.dispatch('read_posts', input, ctx('g1b'))).outcome, 'success',
    '同一 requestId 在同一 turn 内必须仍被放行');
  active.endTurn({ sessionId: SESSION, turn: 1 });

  // gen2 turn 2 replays rpc-1 on a fresh ledger. Everything before the
  // requestTurns check succeeds, so origin-unverified can only come from that
  // guard (the `const priorTurn` comparison in dispatch step 3).
  active = freshLedger();
  active.registerBridgeRequest({ requestId: 'rpc-1', origin: 'qq-inbound' });
  active.observeStep({ sessionId: SESSION, turn: 2, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'rpc-1' } }] });
  active.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn: 2, step: 1, callId: 'g2a' } } });
  assert.deepEqual(await runtime.dispatch('read_posts', input, ctx('g2a')),
    { ok: false, error: 'origin-unverified' }, '同一 requestId 换 turn 复用必须被 priorTurn 守卫拒绝');
  active.endTurn({ sessionId: SESSION, turn: 2 });

  // gen3 turn 3 uses a fresh requestId and must be accepted, proving the
  // rejection above is specific to the reused requestId rather than a blanket
  // deny.
  active = freshLedger();
  active.registerBridgeRequest({ requestId: 'rpc-3', origin: 'qq-inbound' });
  active.observeStep({ sessionId: SESSION, turn: 3, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'rpc-3' } }] });
  active.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn: 3, step: 1, callId: 'g3a' } } });
  assert.equal((await runtime.dispatch('read_posts', input, ctx('g3a'))).outcome, 'success',
    '换新 requestId 必须放行，证明上一步的拒绝来自 requestTurns 而非通用拒绝');

  // gen1 two successes + gen3 one success reach the fake transport; the rejected
  // replay must not.
  assert.equal(calls.filter((action) => action === 'get_qzone_msg_list').length, 3,
    'gen1 两次 + gen3 一次成功读取，replay 必须不产生 QQ 调用');
});

test('未认证的尝试不得消耗 tracking 预算：伪造 callId 不能把后续合法读锁死', async () => {
  // Regression for round-2 finding N1. The budget used to be charged at
  // qzone-runtime-wiring.mjs step 2, i.e. BEFORE the origin check at step 3, and
  // entries are never evicted — so any unauthenticated caller could burn every
  // slot with callIds that were never observed, after which all legitimate reads
  // were permanently refused with tracking-capacity. The charge now happens only
  // after authentication succeeds.
  const { runtime, ledger, calls } = makeRuntime({ trackingLimit: 2 });
  // Two fabricated callIds: valid shape, never observed in the ledger.
  for (const bogus of ['forged-1', 'forged-2']) {
    assert.equal((await runtime.dispatch('read_posts', input, ctx(bogus))).error, 'origin-unverified',
      `${bogus} 必须被认证拒绝`);
  }
  assert.equal(calls.length, 0, '被认证拒绝的尝试不得发出任何 QQ 调用');
  // Budget must still be fully available: a real turn with two observed calls fits
  // exactly in trackingLimit = 2.
  turn(ledger, 1, ['c1', 'c2']);
  assert.equal((await runtime.dispatch('read_posts', input, ctx('c1'))).outcome, 'success',
    '伪造尝试之后，合法读必须仍能通过而非 tracking-capacity');
  assert.equal((await runtime.dispatch('read_posts', input, ctx('c2'))).outcome, 'success',
    '第二格预算同样不得被伪造尝试占用');
  ledger.endTurn({ sessionId: SESSION, turn: 1 });
  // And the budget is genuinely spent now: a third authenticated call is refused.
  turn(ledger, 2, ['c3']);
  assert.equal((await runtime.dispatch('read_posts', input, ctx('c3'))).error, 'tracking-capacity',
    '预算必须仍然被已认证的调用正常耗尽');
});

test('默认容量下多回合连续读取不被误拒', async () => {
  const { runtime, ledger } = makeRuntime();
  for (const index of [1, 2, 3, 4]) {
    turn(ledger, index, [`c${index}`]);
    assert.equal((await runtime.dispatch('read_posts', input, ctx(`c${index}`))).outcome, 'success', `turn ${index}`);
    ledger.endTurn({ sessionId: SESSION, turn: index });
  }
});

test('已认证但被工具闸拒绝的调用必须退回 tracking 额度，不得锁死后续合法读', async () => {
  // Regression for the round-4 extra review's F1. `seenCalls` is charged after
  // authentication but the charge used to survive the tool gates at dispatch
  // steps 5 (`write-not-wired` / `tool-not-wired`), and entries are never
  // evicted. A model retrying such a tool would burn every slot and then be
  // refused tracking-capacity on a genuine read_posts.
  //
  // WHAT THIS USED TO PIN: the refusal was triggered with `read_comments`, which
  // returned `tool-not-wired` because no host injected `exceptionReads`. That
  // tool is now deliberately wired (plain-comments scope), so using it here would
  // measure a SUCCESSFUL read instead of the release path.
  //
  // WHAT IT PINS NOW: `comment` — still refused with `write-not-wired` (it mints
  // an origin consumption because it carries `target_uin`, then hits the write
  // gate) — so the assertion still covers "authenticated, then refused before
  // dispatch". The protected property is unchanged: a refused dispatch must not
  // consume a `seenCalls` slot. `publish` is deliberately NOT used: it has no
  // `target_uin`, so it fails earlier with `origin-unverified` BEFORE minting and
  // would not exercise the leak this test exists for.
  const { runtime, ledger, calls } = makeRuntime({ trackingLimit: 2 });
  const commentInput = { tid: 'abc123', target_uin: 456, content: 'x' };
  // This input passes schema validation and the origin ledger, so it reaches the
  // write gate and is refused there — the exact path that used to leak budget.
  turn(ledger, 1, ['w1', 'w2']);
  assert.deepEqual(await runtime.dispatch('comment', commentInput, ctx('w1')),
    { ok: false, error: 'write-not-wired' }, 'comment 必须仍为 write-not-wired');
  assert.deepEqual(await runtime.dispatch('comment', commentInput, ctx('w2')),
    { ok: false, error: 'write-not-wired' }, 'comment 必须仍为 write-not-wired');
  ledger.endTurn({ sessionId: SESSION, turn: 1 });
  assert.equal(calls.length, 0, '未接线的工具不得发出任何 QQ 调用');
  // Both slots must still be free: a real read fits in trackingLimit = 2.
  turn(ledger, 2, ['r1', 'r2']);
  assert.equal((await runtime.dispatch('read_posts', input, ctx('r1'))).outcome, 'success',
    '被工具闸拒绝的调用不得占用 tracking 额度');
  assert.equal((await runtime.dispatch('read_posts', input, ctx('r2'))).outcome, 'success',
    '第二格额度同样不得被工具闸拒绝的调用占用');
  ledger.endTurn({ sessionId: SESSION, turn: 2 });
  // And the budget is still genuinely spendable-then-exhausted, so the release
  // path did not disable the capacity check itself.
  turn(ledger, 3, ['r3']);
  assert.equal((await runtime.dispatch('read_posts', input, ctx('r3'))).error, 'tracking-capacity',
    '真实读取必须照旧正常耗尽额度');
});

test('被工具闸拒绝后释放额度不得破坏 requestTurns 的有界性', async () => {
  // The release path also has to undo the `requestTurns` write, otherwise a
  // released dispatch would leave a requestId recorded while its callId slot was
  // freed — distinct requestIds could then exceed seenCalls.size and the bound
  // documented next to `const requestTurns` would no longer hold.
  //
  // This must run inside ONE runtime instance: `requestTurns` lives in the
  // closure created by createQzoneRuntime, so a second runtime would have an
  // empty map and prove nothing. The ledger is swapped instead, which is what a
  // reconnect does.
  //
  // WHAT THIS USED TO PIN: the refused dispatch was `read_comments` returning
  // `tool-not-wired`. That tool is now deliberately wired, so it would succeed
  // and never touch the release path. `comment` is used instead: it is still
  // refused with `write-not-wired` (mints an origin consumption via
  // `target_uin`, then hits the write gate). The protected property is
  // unchanged — the release path must also undo the `requestTurns` write, or a
  // released dispatch would leave a requestId recorded while its callId slot was
  // freed, letting distinct requestIds exceed `seenCalls.size`.
  const store = makeStore();
  const commentInput = { tid: 'abc123', target_uin: 456, content: 'x' };
  const generations = [];
  const freshLedger = () => {
    const created = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1' });
    generations.push(created);
    return created;
  };
  let active = freshLedger();
  const runtime = createQzoneRuntime({
    store, botQq: 123, sourceEpoch: 'e1',
    authorizeSource: (consumption) => generations.some((ledger) => ledger.ownsConsumption(consumption)),
    getConnectionEpoch: () => 8,
    getBridgeSessions: (sessionId) => (sessionId === SESSION ? active : null),
    clock: () => now, mode: 'read-only', trackingLimit: 2,
    call: async (action) => {
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
      if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
      if (action === 'get_qzone_msg_list') return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
      throw new Error(`unexpected action ${action}`);
    },
  });
  // Both dispatches share rpc-1 and are refused by the tool gate, so both release
  // (if the release left requestTurns[rpc-1] = 1 behind, the next step fails).
  turn(active, 1, ['w1', 'w2']);
  assert.equal((await runtime.dispatch('comment', commentInput, ctx('w1'))).error, 'write-not-wired');
  assert.equal((await runtime.dispatch('comment', commentInput, ctx('w2'))).error, 'write-not-wired');
  active.endTurn({ sessionId: SESSION, turn: 1 });
  // A brand-new ledger replays rpc-1 on a different turn. The ledger itself would
  // accept it (fresh requests/usedRequests), so the priorTurn guard is the only
  // thing that could reject it. It must pass, because the released dispatches
  // restored requestTurns to its pre-write absence.
  active = freshLedger();
  active.registerBridgeRequest({ requestId: 'rpc-1', origin: 'qq-inbound' });
  active.observeStep({ sessionId: SESSION, turn: 9, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'rpc-1' } }] });
  active.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn: 9, step: 1, callId: 'n1' } } });
  assert.equal((await runtime.dispatch('read_posts', input, ctx('n1'))).outcome, 'success',
    '被工具闸拒绝的调用必须把 requestTurns 恢复到写入前的状态');
});

test('读取器在派出任何 QQ 请求前就拒绝时不得扣额度：非好友目标反复重试不能锁死实例', async () => {
  // Regression for the round-6 review's M-1. `keptCharge = true` is set before
  // `await reader.read(binding)`, and the `read-denied` branch used to keep the
  // charge unconditionally. But `src/core/qzone-live-friend-read.mjs` returns
  // `{ allowed: false, reason: 'unverified' }` WITHOUT `reserved: true` when the
  // friendship proof fails (non-friend target, stale proof) — and in that case no
  // `get_qzone_msg_list` is ever issued. Charging for it let a repeatedly
  // unverifiable target burn `trackingLimit` slots and lock out every later read.
  //
  // The marker is `reserved`: only a denial that comes back with `reserved: true`
  // (the reader really entered the audited read path) keeps the charge.
  const { runtime, ledger, calls } = makeRuntime({ trackingLimit: 2 });
  const stranger = { target_uin: 789 };  // not in the fake friend list
  turn(ledger, 1, ['p1', 'p2']);
  assert.equal((await runtime.dispatch('read_posts', stranger, ctx('p1'))).error, 'read-denied');
  ledger.endTurn({ sessionId: SESSION, turn: 1 });
  turn(ledger, 2, ['p3']);
  assert.equal((await runtime.dispatch('read_posts', stranger, ctx('p3'))).error, 'read-denied',
    '第二次预派发拒绝仍是 read-denied，不是 tracking-capacity');
  ledger.endTurn({ sessionId: SESSION, turn: 2 });
  assert.equal(calls.filter((action) => action === 'get_qzone_msg_list').length, 0,
    '预派发拒绝不得发出取说说请求');
  // Budget must be intact: two genuine reads still fit in trackingLimit = 2.
  turn(ledger, 3, ['ok1', 'ok2']);
  assert.equal((await runtime.dispatch('read_posts', input, ctx('ok1'))).outcome, 'success',
    '预派发拒绝之后合法读必须仍能通过而非 tracking-capacity');
  assert.equal((await runtime.dispatch('read_posts', input, ctx('ok2'))).outcome, 'success');
  ledger.endTurn({ sessionId: SESSION, turn: 3 });
  // And a genuine read still keeps its charge, so capacity is not disabled.
  turn(ledger, 4, ['ok3']);
  assert.equal((await runtime.dispatch('read_posts', input, ctx('ok3'))).error, 'tracking-capacity',
    '真实读取必须照旧正常耗尽额度');
});

test('读取器在预约之后、派发之前抛异常时也必须退款：已提交的一次性意图不得连带烧掉 tracking 额度', async () => {
  // Codex round-7 point 2. `reserved: true` only means a one-shot audited read
  // intent is committed in the store; it says nothing about the platform request.
  // `qzone-live-friend-read.mjs` reaches that state and THEN runs safeClock /
  // verifyRequestProof / authorizeTool before touching the transport, so a throw in
  // that gap leaves "intent consumed, zero platform requests". Charging tracking
  // budget for it is the same lockout class as M-1: a pre-dispatch recheck that
  // keeps failing would burn capacity. The reader therefore reports
  // `{ reserved: true, dispatched: false }` and the wiring refunds.
  //
  // The throw is injected through the clock: the reader's first `safeClock` is the
  // dispatch's first `clock()` call, the pre-dispatch recheck is the second, and
  // that is exactly the gap under test.
  let clockCalls = 0;
  const throwingClock = () => {
    clockCalls += 1;
    if (clockCalls === 2) throw new TypeError('clock failed in the pre-dispatch gap');
    return now;
  };
  const { runtime, ledger, calls } = makeRuntime({ trackingLimit: 1, clock: throwingClock });
  turn(ledger, 1, ['g1']);
  const first = await runtime.dispatch('read_posts', input, ctx('g1'));
  assert.equal(first.error, 'read-denied', '派发前的抛异常必须走 read-denied，而不是 dispatch-failed');
  ledger.endTurn({ sessionId: SESSION, turn: 1 });
  assert.equal(calls.filter((action) => action === 'get_qzone_msg_list').length, 0,
    '这一路径不得发出取说说请求');

  // trackingLimit = 1: if the burned reservation had kept the charge, this genuine
  // read would be refused with tracking-capacity instead of succeeding.
  turn(ledger, 2, ['g2']);
  assert.equal((await runtime.dispatch('read_posts', input, ctx('g2'))).outcome, 'success',
    '预约后未派发的失败不得占用 tracking 额度（否则会像 M-1 一样把实例锁死）');
});

test('同一 runtime 服务两个会话时，同名字符串的 callId / requestId 必须各自独立记账', async () => {
  // Regression for the round-6 review's M-2. `seenCalls` and `requestTurns` live in
  // the runtime closure while the ledger is per-session, and
  // `getBridgeSessions(ctx.sessionId)` lets one runtime serve several sessions.
  // DSH tool callIds are deterministic (`pi_tool_load_<hash>`), so two sessions can
  // legitimately present the same callId string. With bare keys the second
  // session's call was refused as a replay of the first session's call.
  const sessionA = 'session-aaa';
  const sessionB = 'session-bbb';
  const ledgers = new Map();
  const runtime = createQzoneRuntime({
    store: makeStore(), botQq: 123, sourceEpoch: 'e1',
    authorizeSource: (consumption) => ledgers.get(consumption.sessionId)?.ownsConsumption(consumption) === true,
    getConnectionEpoch: () => 8,
    getBridgeSessions: (sessionId) => ledgers.get(sessionId) ?? null,
    clock: () => now, mode: 'read-only', trackingLimit: 8,
    call: async (action) => {
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
      if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
      if (action === 'get_qzone_msg_list') return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
      throw new Error(`unexpected action ${action}`);
    },
  });
  const sharedCall = 'same-call-id';
  const sharedRequest = 'same-request-id';
  const seed = (sessionId, turnIndex) => {
    const ledger = createQzoneOriginLedger({ sessionId, epoch: 'e1' });
    ledgers.set(sessionId, ledger);
    ledger.registerBridgeRequest({ requestId: sharedRequest, origin: 'qq-inbound' });
    ledger.observeStep({ sessionId, turn: turnIndex, step: 1,
      messages: [{ role: 'user', source: { rpcId: sharedRequest } }] });
    ledger.observeToolCall({ sessionId, event: { type: 'tool/call', data: { turn: turnIndex, step: 1, callId: sharedCall } } });
    return ledger;
  };
  const ledgerA = seed(sessionA, 1);
  const ctxA = { sessionId: sessionA, callId: sharedCall };
  assert.equal((await runtime.dispatch('read_posts', input, ctxA)).outcome, 'success', '会话 A 的首次读取');
  ledgerA.endTurn({ sessionId: sessionA, turn: 1 });

  // Session B is a different session with its OWN ledger, its own fresh request and
  // its own fresh call — but the identical strings. It must not be treated as a
  // replay of A's call or as a second turn for A's requestId.
  const ledgerB = seed(sessionB, 1);
  const ctxB = { sessionId: sessionB, callId: sharedCall };
  assert.equal((await runtime.dispatch('read_posts', input, ctxB)).outcome, 'success',
    '会话 B 用同名 callId / requestId 必须被独立放行，而非 origin-unverified');
  ledgerB.endTurn({ sessionId: sessionB, turn: 1 });

  // Isolation must not weaken replay protection inside one session: A may not
  // reuse its own already-spent callId.
  assert.deepEqual(await runtime.dispatch('read_posts', input, ctxA),
    { ok: false, error: 'origin-unverified' }, '同一会话内重放自己的 callId 必须仍被拒');
});
