// End-to-end proof that the round-7 "three refusals lock the session" defect is gone.
//
// The transport guards its own call with `isStillAuthorized` — the wiring passes
// `sourceStillAuthorized`, which re-reads `authorizeSource` on the consumption. A
// source that is revoked between authentication and the transport therefore refuses
// AFTER the reader already claimed the dispatch (`dispatched = true`).
//
// Before the fix that refusal was reported as `unknown` (post-dispatch) and the
// tracking charge was kept forever: three of them exhausted `trackingLimit` while
// issuing zero `get_qzone_msg_list` calls. With the not-sent marker the reader
// answers `unverified` + `dispatched: false` and the wiring refunds.
//
// The judge is capacity, not `unverified`: a refusal that still burned the charge
// shows up as `tracking-capacity` on the third and later attempts.
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

const now = Date.parse('2026-11-10T04:00:00Z');
const SESSION = 'sess-r7-e2e';
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

const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1', trackingLimit: 4096 });
const platformCalls = [];
// Per dispatch the wiring asks twice: once at the authentication gate and once more
// inside the transport (`sourceStillAuthorized` → `authorizeSource`). Answering true
// then false puts the refusal squarely inside the transport, i.e. after the reader
// already claimed the dispatch — the window that used to burn the charge.
let allowNextLookup = true;
let authorizeLookups = 0;
const runtime = createQzoneRuntime({
  store: makeStore(), botQq: 123, sourceEpoch: 'e1', trackingLimit: 2,
  authorizeSource: (consumption) => {
    if (!consumption) return false;
    authorizeLookups += 1;
    const answer = allowNextLookup;
    allowNextLookup = false;
    return answer;
  },
  getConnectionEpoch: () => 8,
  getBridgeSessions: () => ledger,
  clock: () => now, mode: 'read-only',
  call: async (action, params) => {
    if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
    if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: FRIEND }] };
    if (action === 'get_qzone_msg_list') {
      platformCalls.push(params);
      return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
    }
    throw new Error(`unexpected action ${action}`);
  },
});

const results = [];
for (let turnNo = 1; turnNo <= 4; turnNo++) {
  const requestId = `rpc-${turnNo}`;
  const callId = `c-${turnNo}`;
  ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  ledger.observeStep({ sessionId: SESSION, turn: turnNo, step: 1,
    messages: [{ role: 'user', source: { rpcId: requestId } }] });
  ledger.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn: turnNo, step: 1, callId } } });
  const result = await runtime.dispatch('read_posts', { target_uin: FRIEND }, { sessionId: SESSION, callId });
  results.push(result.ok === true ? (result.outcome ?? 'ok') : (result.error ?? 'error'));
  ledger.endTurn({ sessionId: SESSION, turn: turnNo });
  // Re-arm for the next dispatch: each dispatch gets one true then one false.
  allowNextLookup = true;
}

process.stdout.write(`${JSON.stringify({
  results,
  platformCalls: platformCalls.length,
  authorizeLookups,
  trackingLimit: 2,
  // The defect would show up as `tracking-capacity` here: four refusals against a
  // budget of TWO slots. Every one of them was a refusal raised before anything was
  // sent, so none of them may spend a slot.
  lockoutGone: results.filter((code) => code === 'tracking-capacity').length === 0,
  allRefusedAsPreDispatch: results.every((code) => code === 'read-denied'),
})}\n`);
