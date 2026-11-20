// §3.5 of the freeze, part 2: delayed and concurrent deliveries.
//
// The remaining question after the stale-generation probe: when events arrive out of
// order or at the same time, does the wiring still issue at most one binding, and does
// a delayed delivery corrupt a turn that is already in flight?
//
// Everything here is offline: fake store, fake transport, no network, no credentials.
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

const SESSION = 'sess-delay';
const FRIEND = 456;
const now = Date.parse('2026-11-10T04:00:00Z');

function makeStore() {
  const state = {
    enabled: true, readAllowed: true, writeAllowed: false, accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: false }, reads: 0, writes: 0, readAttempts: {}, readOutcomes: {},
    notices: [], browseDay: '2026-11-10', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
    activeStart: 0, activeEnd: 1439, audit: [],
  };
  let current = structuredClone(state);
  return {
    read: () => structuredClone(current),
    update(fn) { current = fn(structuredClone(current)); return structuredClone(current); },
  };
}

function makeRuntime({ trackingLimit = 8, transport } = {}) {
  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1', trackingLimit });
  const actions = [];
  const runtime = createQzoneRuntime({
    store: makeStore(), botQq: 123, sourceEpoch: 'e1', trackingLimit,
    authorizeSource: () => true,
    getConnectionEpoch: () => 8,
    getBridgeSessions: () => ledger,
    clock: () => now,
    mode: 'read-only',
    call: async (action, params) => {
      actions.push(action);
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
      if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: FRIEND }] };
      if (action === 'get_qzone_msg_list') {
        if (transport) return transport(params);
        return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
      }
      throw new Error(`unexpected action ${action}`);
    },
  });
  return { runtime, ledger, actions };
}

function openTurn(ledger, turn, requestId, callIds) {
  ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  const bound = ledger.observeStep({ sessionId: SESSION, turn, step: 1,
    messages: [{ role: 'user', source: { rpcId: requestId } }] });
  const calls = callIds.map((callId) => ledger.observeToolCall({ sessionId: SESSION,
    event: { type: 'tool/call', data: { turn, step: 1, callId, name: 'qzone_read_posts' } } }));
  return { bound, calls };
}

function code(result) {
  if (!result) return 'null';
  if (result.ok === true) return `ok:${result.outcome ?? 'ok'}`;
  return `err:${result.error}`;
}

const out = {};

// ---------------------------------------------------------------------------
// A. Two dispatches of the SAME callId fired concurrently must reach the
//    transport at most once. `seenCalls.has` runs before any await, so the
//    second one must be refused synchronously.
// ---------------------------------------------------------------------------
{
  const { runtime, ledger, actions } = makeRuntime();
  openTurn(ledger, 1, 'rpc-a', ['same-call']);
  const both = await Promise.all([
    runtime.dispatch('read_posts', { target_uin: FRIEND }, { sessionId: SESSION, callId: 'same-call' }),
    runtime.dispatch('read_posts', { target_uin: FRIEND }, { sessionId: SESSION, callId: 'same-call' }),
  ]);
  const codes = both.map(code).sort();
  out.A_concurrent_same_call = {
    codes,
    platformReads: actions.filter((a) => a === 'get_qzone_msg_list').length,
    exactlyOneAccepted: codes.filter((c) => c.startsWith('ok:')).length === 1,
  };
}

// ---------------------------------------------------------------------------
// B. Two dispatches of DIFFERENT callIds in the same step, concurrently: both are
//    legitimate and both must succeed. This is the control for A.
// ---------------------------------------------------------------------------
{
  const { runtime, ledger, actions } = makeRuntime();
  openTurn(ledger, 1, 'rpc-b', ['call-b1', 'call-b2']);
  const both = await Promise.all([
    runtime.dispatch('read_posts', { target_uin: FRIEND }, { sessionId: SESSION, callId: 'call-b1' }),
    runtime.dispatch('read_posts', { target_uin: FRIEND }, { sessionId: SESSION, callId: 'call-b2' }),
  ]);
  out.B_concurrent_distinct_calls = {
    codes: both.map(code).sort(),
    platformReads: actions.filter((a) => a === 'get_qzone_msg_list').length,
  };
}

// ---------------------------------------------------------------------------
// C. A DELAYED tool/call: announced after its own turn has already been closed.
//    It must not bind, and it must not reopen the closed turn.
// ---------------------------------------------------------------------------
{
  const { runtime, ledger, actions } = makeRuntime();
  openTurn(ledger, 1, 'rpc-c', []);
  ledger.endTurn({ sessionId: SESSION, turn: 1 });
  const lateBind = ledger.observeToolCall({ sessionId: SESSION,
    event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'late-call', name: 'qzone_read_posts' } } });
  const consume = ledger.consume({ sessionId: SESSION, callId: 'late-call', turn: 1, step: 1 });
  out.C_tool_call_after_endTurn = {
    lateBind, consumeIsNull: consume === null,
    dispatchAfterward: code(await runtime.dispatch('read_posts', { target_uin: FRIEND }, { sessionId: SESSION, callId: 'late-call' })),
    platformReads: actions.filter((a) => a === 'get_qzone_msg_list').length,
  };
}

// ---------------------------------------------------------------------------
// D. A tool/call delivered BEFORE its pre-step (out of order). There is no
//    binding for that position yet, so it must not bind; and once the pre-step
//    does arrive, a re-report of the same callId must still be refused because
//    the id is spent forever.
// ---------------------------------------------------------------------------
{
  const { ledger } = makeRuntime();
  ledger.registerBridgeRequest({ requestId: 'rpc-d', origin: 'qq-inbound' });
  const early = ledger.observeToolCall({ sessionId: SESSION,
    event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'early-call', name: 'qzone_read_posts' } } });
  const bound = ledger.observeStep({ sessionId: SESSION, turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'rpc-d' } }] });
  const retry = ledger.observeToolCall({ sessionId: SESSION,
    event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'early-call', name: 'qzone_read_posts' } } });
  out.D_tool_call_before_prestep = {
    earlyBind: early,
    preStepBound: bound,
    reReportAccepted: retry,
    consumeIsNull: ledger.consume({ sessionId: SESSION, callId: 'early-call', turn: 1, step: 1 }) === null,
  };
}

// ---------------------------------------------------------------------------
// E. A DELAYED pre-step for an older turn, arriving while a NEWER turn is in
//    flight. It must be refused without latching `continuityLost`, so the
//    in-flight turn keeps working.
// ---------------------------------------------------------------------------
{
  const { runtime, ledger, actions } = makeRuntime();
  openTurn(ledger, 1, 'rpc-e1', []);
  ledger.endTurn({ sessionId: SESSION, turn: 1 });
  const inFlight = openTurn(ledger, 2, 'rpc-e2', ['call-e2']);
  const delayed = ledger.observeStep({ sessionId: SESSION, turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'rpc-e1' } }] });
  out.E_delayed_older_prestep = {
    inFlightBound: inFlight.bound, inFlightCallBound: inFlight.calls,
    delayedAccepted: delayed,
    inFlightStillDispatches: code(await runtime.dispatch('read_posts', { target_uin: FRIEND }, { sessionId: SESSION, callId: 'call-e2' })),
    platformReads: actions.filter((a) => a === 'get_qzone_msg_list').length,
  };
}

// ---------------------------------------------------------------------------
// F. An UNKNOWN result after the platform call really went out: the charge must
//    be kept (fail-closed), so the same session cannot retry for free.
// ---------------------------------------------------------------------------
{
  const { runtime, ledger, actions } = makeRuntime({
    trackingLimit: 1,
    transport: () => { throw new Error('socket closed mid-flight'); },
  });
  openTurn(ledger, 1, 'rpc-f1', ['call-f1']);
  const first = await runtime.dispatch('read_posts', { target_uin: FRIEND }, { sessionId: SESSION, callId: 'call-f1' });
  ledger.endTurn({ sessionId: SESSION, turn: 1 });
  openTurn(ledger, 2, 'rpc-f2', ['call-f2']);
  const second = await runtime.dispatch('read_posts', { target_uin: FRIEND }, { sessionId: SESSION, callId: 'call-f2' });
  out.F_unknown_result_keeps_charge = {
    first: code(first),
    second: code(second),
    platformReads: actions.filter((a) => a === 'get_qzone_msg_list').length,
    chargeKept: code(second) === 'err:tracking-capacity',
  };
}

// ---------------------------------------------------------------------------
// G. A pre-step that is genuinely FORWARD-JUMPED (turn 3 right after turn 1) is
//    the one case that must still latch: the ledger cannot tell what it missed.
// ---------------------------------------------------------------------------
{
  const { ledger } = makeRuntime();
  openTurn(ledger, 1, 'rpc-g1', []);
  ledger.endTurn({ sessionId: SESSION, turn: 1 });
  const jump = ledger.observeStep({ sessionId: SESSION, turn: 3, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'rpc-g3' } }] });
  let afterJump = 'ok';
  try { ledger.registerBridgeRequest({ requestId: 'rpc-g4', origin: 'qq-inbound' }); }
  catch (error) { afterJump = String(error.message); }
  out.G_forward_jump_still_latches = { jumpAccepted: jump, registrationAfterJump: afterJump };
}

out.verdict = {
  concurrentSameCallReachesTransportOnce: out.A_concurrent_same_call.platformReads === 1
    && out.A_concurrent_same_call.exactlyOneAccepted,
  concurrentDistinctCallsBothWork: out.B_concurrent_distinct_calls.platformReads === 2,
  lateToolCallCannotBind: out.C_tool_call_after_endTurn.lateBind === false
    && out.C_tool_call_after_endTurn.consumeIsNull,
  earlyToolCallCannotBind: out.D_tool_call_before_prestep.earlyBind === false
    && out.D_tool_call_before_prestep.reReportAccepted === false,
  delayedOlderPreStepIsHarmless: out.E_delayed_older_prestep.delayedAccepted === false
    && out.E_delayed_older_prestep.inFlightStillDispatches === 'ok:success',
  unknownResultKeepsCharge: out.F_unknown_result_keeps_charge.chargeKept,
  forwardJumpStillRefused: out.G_forward_jump_still_latches.jumpAccepted === false,
};

console.log(JSON.stringify(out, null, 2));
