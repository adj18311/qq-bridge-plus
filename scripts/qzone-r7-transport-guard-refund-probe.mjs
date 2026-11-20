// Proves the three-refusal lockout (round-7 review, high) is gone.
//
// Before the fix: `qzone-live-friend-read.mjs` sets `dispatched = true` immediately
// before calling the transport, and the transport's OWN guards (derived connection
// epoch, revoked source, malformed snapshot) run inside that call. Their throws were
// indistinguishable from a lost platform response, so the reader reported `unknown`
// and the wiring kept the tracking charge. Three refusals with zero
// `get_qzone_msg_list` calls then exhausted `trackingLimit` — a permanent lockout
// caused by a guard that never sent anything.
//
// The judge is the SAME one used everywhere else in this project: the second and
// third dispatch must NOT come back `tracking-capacity`. `unverified` is not evidence
// of a refund (a turn can also taint), so capacity is what we look at.
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';
import { createQzoneBoundReadTransport } from '../src/core/qzone-bound-read-transport.mjs';

const now = Date.parse('2026-11-10T04:00:00Z');
const SESSION = 'sess-r7';
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

async function scenario({ revokeAfterAuthentication, trackingLimit }) {
  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1', trackingLimit: 4096 });
  const calls = [];
  // The transport guard that used to be fatal: `isStillAuthorized` is consulted inside
  // the transport, i.e. after the reader already claimed the dispatch.
  const transport = createQzoneBoundReadTransport({
    botQq: 123,
    getConnectionEpoch: () => 8,
    transport: {
      async get_qzone_msg_list(params) {
        calls.push(params);
        return { kind: 'trusted-envelope', envelope: { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } } };
      },
    },
  });
  const runtime = createQzoneRuntime({
    store: makeStore(), botQq: 123, sourceEpoch: 'e1', trackingLimit,
    authorizeSource: (consumption) => ledger.ownsConsumption(consumption) === true,
    getConnectionEpoch: () => 8,
    getBridgeSessions: () => ledger,
    clock: () => now, mode: 'read-only',
    call: async (action) => {
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
      if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: FRIEND }] };
      if (action === 'get_qzone_msg_list') return transport;
      throw new Error(`unexpected action ${action}`);
    },
  });

  const results = [];
  for (let turnNo = 1; turnNo <= 3; turnNo++) {
    const requestId = `rpc-${turnNo}`;
    const callId = `c-${turnNo}`;
    ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
    ledger.observeStep({ sessionId: SESSION, turn: turnNo, step: 1, messages: [{ role: 'user', source: { rpcId: requestId } }] });
    ledger.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn: turnNo, step: 1, callId } } });
    const result = await runtime.dispatch('read_posts', { target_uin: FRIEND }, { sessionId: SESSION, callId });
    const code = result.ok === true ? (result.outcome ?? 'ok') : (result.error ?? 'error');
    results.push(code);
    ledger.endTurn({ sessionId: SESSION, turn: turnNo });
    void revokeAfterAuthentication;
  }
  return { results, platformCalls: calls.length };
}

// Turn 1..3 are all refused by the transport's `isStillAuthorized` guard: it is
// supplied by the reader from `isStillAuthorized(modelRequest)`, which this runtime
// never provides — so the guard refuses every time, exactly as in the reported case.
const refused = await scenario({ revokeAfterAuthentication: true, trackingLimit: 2 });
process.stdout.write(`${JSON.stringify({
  scenario: 'transport-guard-refuses-every-call',
  results: refused.results,
  platformCalls: refused.platformCalls,
  lockoutGone: !refused.results.includes('tracking-capacity'),
  nothingEverSent: refused.platformCalls === 0,
})}\n`);
