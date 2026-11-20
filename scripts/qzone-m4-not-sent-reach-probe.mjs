// Adjudication of the R9 reviewer's M4 finding: does
// `scripts/test-qzone-read-refusal-refund.mjs` actually exercise the not-sent
// marker branch, or does its `true -> false` authorize toggle fall over earlier?
//
// The reviewer claims the toggle flips on the SECOND `authorizeSource` call, which
// lands in `authorizeBinding` (reader:141) while `dispatched` is still false — so the
// test's `read-denied` comes from `!platformAttempted`, never from the marker. If that
// is right, deleting the marker branch would leave the test green, i.e. the case is
// not pinned.
//
// This probe counts the authorize calls per dispatch and then drives a TTTF sequence
// (three accepted lookups, the fourth refused) so the refusal lands INSIDE the
// transport, after the reader has already set `dispatched = true`.
//
// Read-only: fake store, fake transport, no network, no credentials, no real QQ.
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

const SESSION = 'sess-m4';
const FRIEND = 456;
const now = Date.parse('2026-11-10T04:00:00Z');

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

// `answers` is the authorizeSource sequence consumed one per call; once exhausted the
// last value repeats. Returns the full call log so the sequence is observable.
function makeRuntime({ trackingLimit = 2, answers }) {
  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1', trackingLimit });
  const log = { authorizeCalls: [], platformCalls: [] };
  // Externally rearmable so a scenario can restart the sequence per dispatch.
  const plan = { answers: [...answers], index: 0 };
  const runtime = createQzoneRuntime({
    store: makeStore(), botQq: 123, sourceEpoch: 'e1', trackingLimit,
    authorizeSource: () => {
      const list = plan.answers;
      const answer = plan.index < list.length ? list[plan.index] : list[list.length - 1];
      plan.index += 1;
      log.authorizeCalls.push(answer);
      return answer;
    },
    getConnectionEpoch: () => 8,
    getBridgeSessions: () => ledger,
    clock: () => now,
    mode: 'read-only',
    call: async (action, params) => {
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
      if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: FRIEND }] };
      if (action === 'get_qzone_msg_list') {
        log.platformCalls.push(params);
        return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
      }
      throw new Error(`unexpected action ${action}`);
    },
  });
  return { runtime, ledger, log, plan };
}

function code(result) {
  if (!result) return 'null';
  if (result.ok === true) return `ok:${result.outcome ?? 'ok'}`;
  return `err:${result.error}`;
}

async function oneDispatch(runtime, ledger, turnNo) {
  const requestId = `rpc-${turnNo}`;
  const callId = `c-${turnNo}`;
  ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  ledger.observeStep({ sessionId: SESSION, turn: turnNo, step: 1,
    messages: [{ role: 'user', source: { rpcId: requestId } }] });
  ledger.observeToolCall({ sessionId: SESSION,
    event: { type: 'tool/call', data: { turn: turnNo, step: 1, callId, name: 'qzone_read_posts' } } });
  const result = await runtime.dispatch('read_posts', { target_uin: FRIEND }, { sessionId: SESSION, callId });
  ledger.endTurn({ sessionId: SESSION, turn: turnNo });
  return code(result);
}

const out = {};

// ---------------------------------------------------------------------------
// A. Reproduce the shipped test's `true -> false` toggle and count the authorize
//    calls. If the flip lands on call #2, the refusal is a pre-dispatch denial.
// ---------------------------------------------------------------------------
{
  const { runtime, ledger, log } = makeRuntime({ trackingLimit: 2, answers: [true, false] });
  const results = [];
  for (let turnNo = 1; turnNo <= 4; turnNo++) results.push(await oneDispatch(runtime, ledger, turnNo));
  out.A_shipped_toggle = {
    results,
    authorizeCallCount: log.authorizeCalls.length,
    authorizeSequence: log.authorizeCalls,
    platformReads: log.platformCalls.length,
    reachedTransport: log.platformCalls.length > 0,
  };
}

// ---------------------------------------------------------------------------
// B. TTTF: three accepted lookups, the fourth refused. With four lookups per
//    dispatch the refusal then lands inside the transport's own guard, i.e. AFTER
//    `dispatched = true`. That throw carries the marker, so the wiring must refund
//    and the next dispatch must still succeed.
// ---------------------------------------------------------------------------
{
  const { runtime, ledger, log } = makeRuntime({ trackingLimit: 2, answers: [true, true, true, false] });
  const results = [];
  for (let turnNo = 1; turnNo <= 4; turnNo++) results.push(await oneDispatch(runtime, ledger, turnNo));
  out.B_TTTF = {
    results,
    authorizeCallCount: log.authorizeCalls.length,
    platformReads: log.platformCalls.length,
    allRefunded: results.every((r) => r === 'err:read-denied'),
  };
}

// ---------------------------------------------------------------------------
// C. Control: TTTT never refuses, so the read must reach the platform. This tells
//    us the TTTF refusal really is the fourth lookup and not something earlier.
// ---------------------------------------------------------------------------
{
  const { runtime, ledger, log } = makeRuntime({ trackingLimit: 2, answers: [true] });
  const results = [];
  for (let turnNo = 1; turnNo <= 2; turnNo++) results.push(await oneDispatch(runtime, ledger, turnNo));
  out.C_TTTT_control = {
    results,
    authorizeCallCount: log.authorizeCalls.length,
    platformReads: log.platformCalls.length,
  };
}

// ---------------------------------------------------------------------------
// D. TTTTF: five accepted-then-refused. If the sequence needs exactly four lookups
//    to reach the transport, an extra true should make the refusal fall even later
//    (into the after-I/O revalidation) and therefore KEEP the charge.
// ---------------------------------------------------------------------------
{
  const { runtime, ledger, log } = makeRuntime({ trackingLimit: 2, answers: [true, true, true, true, false] });
  const results = [];
  for (let turnNo = 1; turnNo <= 3; turnNo++) results.push(await oneDispatch(runtime, ledger, turnNo));
  out.D_TTTTF = {
    results,
    authorizeCallCount: log.authorizeCalls.length,
    platformReads: log.platformCalls.length,
  };
}

out.conclusion = {
  shippedToggleReachesTransport: out.A_shipped_toggle.reachedTransport === false,
  toggleFlipsOnSecondCall: out.A_shipped_toggle.authorizeSequence.slice(0, 2).join(',') === 'true,false',
  authorizedLookupsPerDispatch: out.C_TTTT_control.authorizeCallCount / 2,
  tttfHitsTransportGuard: out.B_TTTF.platformReads === 0 && out.B_TTTF.allRefunded,
};
// ---------------------------------------------------------------------------
// E. The shape a FIXED test needs: reset the authorize sequence at the start of
//    every turn to TTTF, so each dispatch refuses INSIDE the transport guard (the
//    4th lookup) rather than in `authorizeBinding` (the 2nd). With trackingLimit 2,
//    four such refusals must all stay `read-denied`; keeping the charge would turn
//    the third into `tracking-capacity`.
// ---------------------------------------------------------------------------
{
  const { runtime, ledger, log, plan } = makeRuntime({ trackingLimit: 2, answers: [true, true, true, false] });
  const results = [];
  for (let turnNo = 1; turnNo <= 4; turnNo++) {
    // Re-arm the sequence per dispatch: this is the whole difference from probe B.
    const before = log.authorizeCalls.length;
    const requestId = `rpc-e-${turnNo}`;
    const callId = `ce-${turnNo}`;
    ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
    ledger.observeStep({ sessionId: SESSION, turn: turnNo, step: 1,
      messages: [{ role: 'user', source: { rpcId: requestId } }] });
    ledger.observeToolCall({ sessionId: SESSION,
      event: { type: 'tool/call', data: { turn: turnNo, step: 1, callId, name: 'qzone_read_posts' } } });
    const result = await runtime.dispatch('read_posts', { target_uin: FRIEND }, { sessionId: SESSION, callId });
    results.push(code(result));
    out[`E_turn${turnNo}_lookups`] = log.authorizeCalls.length - before;
    ledger.endTurn({ sessionId: SESSION, turn: turnNo });
    // Re-arm: truncate the log so the next dispatch starts a fresh TTTF.
    log.authorizeCalls.length = 0;
    plan.index = 0;
  }
  out.E_fixed_shape_TTTF_per_turn = {
    results,
    platformReads: log.platformCalls.length,
    allRefunded: results.every((r) => r === 'err:read-denied'),
    noCapacityLockout: results.every((r) => r !== 'err:tracking-capacity'),
  };
}

out.conclusion.fixedShapePinsMarker = out.E_fixed_shape_TTTF_per_turn.noCapacityLockout
  && out.E_fixed_shape_TTTF_per_turn.allRefunded;

console.log(JSON.stringify(out, null, 2));
