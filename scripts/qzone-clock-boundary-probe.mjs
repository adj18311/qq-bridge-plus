// Codex round-7: the exception / unknown-result billing boundary, measured positionally.
//
// Design: `trackingLimit: 1` makes the capacity signal unambiguous. A single read
// either refunds its slot (next legitimate read succeeds) or keeps it (next
// legitimate read is refused with `tracking-capacity`). An `origin-unverified`
// refusal is never accepted as evidence — it can come from turn tainting instead
// of capacity.
//
// A throwing `clock` is used as the fault injector because the reader calls it at
// fixed stages: once before the reservation (via the friend proof) and twice
// around the transport. Throw on the N-th call and the failure lands at a
// different stage for each N.
//
// Run: cmd /c "D:\Node\node.exe scripts\qzone-clock-boundary-probe.mjs"
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

const sessionId = 'sess-clock';
const botQq = 111;
const friendUin = 456;
const DAY = Date.parse('2026-11-12T04:00:00Z');
const POST_TIME_S = Math.floor(DAY / 1000) - 3600;
const POST = { tid: 'p1', content: 'hello', time: POST_TIME_S };

const userMessage = (rpcId) => ({ role: 'user', source: { rpcId } });
const code = (r) => (r.ok ? r.outcome : `${r.error}${r.reason ? `/${r.reason}` : ''}`);

function makeStore() {
  let state = {
    enabled: true, readAllowed: true, writeAllowed: false,
    accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: false },
    reads: 0, writes: 0, readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-12', todayBrowses: 0, lastBrowseAt: null,
    usedOpportunities: {}, activeStart: 0, activeEnd: 1439, audit: [],
  };
  return {
    read: () => structuredClone(state),
    update(fn) { state = fn(structuredClone(state)); return state; },
    dump: () => structuredClone(state),
  };
}

function makeTransport() {
  const actions = [];
  const call = async (action) => {
    actions.push(action);
    if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: botQq } };
    if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: friendUin }] };
    if (action === 'get_qzone_msg_list') return { status: 'ok', retcode: 0, data: { total: 1, msglist: [POST] } };
    throw new Error(`unexpected ${action}`);
  };
  return {
    call, actions,
    count: (a) => actions.filter((x) => x === a).length,
    snapshot: () => ({
      total: actions.length,
      msgList: actions.filter((a) => a === 'get_qzone_msg_list').length,
      loginInfo: actions.filter((a) => a === 'get_login_info').length,
      friendList: actions.filter((a) => a === 'get_friend_list').length,
    }),
  };
}

let turnCounter = 0;
function prepare(ledger, tag) {
  turnCounter += 1;
  const turn = turnCounter;
  const requestId = `req-${tag}`;
  const callId = `call-${tag}`;
  ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  const stepOk = ledger.observeStep({ sessionId, turn, step: 1, messages: [userMessage(requestId)] });
  const callOk = ledger.observeToolCall({ sessionId, event: { type: 'tool/call', data: { turn, step: 1, callId } } });
  return { turn, callId, requestId, stepOk, callOk };
}

// Returns DAY normally; throws exactly on the N-th invocation.
function makeClock(throwOnNthCall) {
  let n = 0;
  return () => {
    n += 1;
    if (n === throwOnNthCall) throw new Error(`clock exploded on call ${n}`);
    return DAY;
  };
}

function build(store, transport, ledger, clock) {
  return createQzoneRuntime({
    store, botQq, sourceEpoch: 'epoch-1',
    authorizeSource: (c) => ledger.ownsConsumption(c),
    getConnectionEpoch: () => 1,
    getBridgeSessions: () => ledger,
    clock,
    mode: 'read-only',
    trackingLimit: 1,
    call: transport.call,
  });
}

const out = { note: 'trackingLimit is 1, so a follow-up refused with tracking-capacity is the only accepted proof the slot was kept', scenarios: [] };

// Baseline: a healthy read at limit 1.
{
  const transport = makeTransport();
  const store = makeStore();
  const ledger = createQzoneOriginLedger({ sessionId, epoch: 'epoch-1', trackingLimit: 64 });
  let n = 0;
  const runtime = build(store, transport, ledger, () => { n += 1; return DAY; });
  const p = prepare(ledger, 'baseline');
  const r = await runtime.dispatch('read_posts', { target_uin: friendUin }, { sessionId, callId: p.callId });
  ledger.endTurn({ sessionId, turn: p.turn });
  out.baseline = { code: code(r), posts: r.ok ? r.posts.length : null, clockCalls: n, qqCalls: transport.snapshot() };
}

for (let n = 1; n <= 6; n += 1) {
  const transport = makeTransport();
  const store = makeStore();
  const ledger = createQzoneOriginLedger({ sessionId, epoch: 'epoch-1', trackingLimit: 64 });
  const runtime = build(store, transport, ledger, makeClock(n));

  const first = prepare(ledger, `n${n}-a`);
  const r1 = await runtime.dispatch('read_posts', { target_uin: friendUin }, { sessionId, callId: first.callId });
  const afterFirst = transport.snapshot();
  ledger.endTurn({ sessionId, turn: first.turn });

  // Follow-up with the same (now non-throwing) clock and a fresh turn/callId.
  const follow = prepare(ledger, `n${n}-b`);
  const r2 = await runtime.dispatch('read_posts', { target_uin: friendUin }, { sessionId, callId: follow.callId });
  ledger.endTurn({ sessionId, turn: follow.turn });

  out.scenarios.push({
    throwOnClockCall: n,
    firstCode: code(r1),
    firstPosts: r1.ok ? r1.posts.length : null,
    platformCallsAfterFirstRead: afterFirst,
    followUp: code(r2),
    // For N >= 5 the FIRST read succeeds outright (a healthy read only makes 4
    // clock calls), so it legitimately consumed the limit-1 slot and the
    // follow-up refusal is the normal wall, not a leak. Only N = 1..4 answer the
    // boundary question.
    firstReadSucceeded: code(r1) === 'success',
    slotKept: code(r2) === 'tracking-capacity',
    refunded: code(r2) === 'success',
    interpretation: code(r1) === 'success'
      ? 'first read succeeded, so the limit-1 slot was spent by a real read (not a boundary sample)'
      : afterFirst.msgList === 0
        ? 'pre-dispatch failure: zero get_qzone_msg_list, refund expected'
        : 'post-dispatch failure: get_qzone_msg_list already left, charge expected',
  });
}

console.log(JSON.stringify(out, null, 2));
