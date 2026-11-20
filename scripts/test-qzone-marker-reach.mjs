import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

// Pins the reader-level `isQzoneReadNotSent` branch, which the transport-level cases in
// `test-qzone-read-refusal-refund.mjs` cannot reach. Found by the round-9 reviewer as
// "§4-M4 does not hold": deleting that branch left the refund file 4/4 green.
//
// The shipped toggle there answers `true` then `false` from `authorizeSource`. That flip
// lands on the SECOND authorize lookup of the dispatch, which is `authorizeBinding`
// inside `qzone-live-friend-read.mjs` — while `dispatched` and `reserved` are both still
// false. The wiring refunds there via `platformAttempted === false`, never via the
// marker, so that file pins the transport's marker and nothing about the reader's use
// of it. Measured: reader marker branch disabled -> refund file still 4/4.
//
// To land a refusal INSIDE the transport's own guard the sequence has to be TTTF:
// lookups 1-3 belong to the wiring and the reader's pre-dispatch recheck, lookup 4 is
// `isStillAuthorized` inside `createQzoneBoundReadTransport`, which runs after
// `dispatched = true`. Re-arming TTTF at every turn keeps all four refusals in that
// window, so with `trackingLimit: 2` a kept charge surfaces as `tracking-capacity` on
// the third dispatch. Measured: this file red with the branch deleted, green shipped.
const now = Date.parse('2026-11-10T04:00:00Z');
const SESSION = 'sess-marker-reach';
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

test('读取器收到的未发出标记必须真的被用来退款：拒绝发生在传输层守卫内部也不得扣额度', async () => {
  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1', trackingLimit: 2 });
  const platformCalls = [];
  const answers = [true, true, true, false];
  let index = 0;
  const runtime = createQzoneRuntime({
    store: makeStore(), botQq: 123, sourceEpoch: 'e1', trackingLimit: 2,
    authorizeSource: () => {
      const answer = index < answers.length ? answers[index] : answers[answers.length - 1];
      index += 1;
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
    index = 0;
    const requestId = `rpc-m${turnNo}`;
    const callId = `c-m${turnNo}`;
    ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
    ledger.observeStep({ sessionId: SESSION, turn: turnNo, step: 1,
      messages: [{ role: 'user', source: { rpcId: requestId } }] });
    ledger.observeToolCall({ sessionId: SESSION,
      event: { type: 'tool/call', data: { turn: turnNo, step: 1, callId, name: 'qzone_read_posts' } } });
    const result = await runtime.dispatch('read_posts', { target_uin: FRIEND }, { sessionId: SESSION, callId });
    results.push(result.ok === true ? (result.outcome ?? 'ok') : (result.error ?? 'error'));
    ledger.endTurn({ sessionId: SESSION, turn: turnNo });
  }

  assert.deepEqual(results, ['read-denied', 'read-denied', 'read-denied', 'read-denied'],
    '每一次都必须在传输层守卫内部被拒并退款，不得降级成 tracking-capacity');
  assert.equal(platformCalls.length, 0, '守卫在发出之前拒绝，因此一次平台读都不该出现');
});
