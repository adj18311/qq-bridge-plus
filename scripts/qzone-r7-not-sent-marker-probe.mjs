// Proves the reader reports "not sent" when the transport refuses BEFORE dispatching.
//
// Round-7 review (high): `qzone-live-friend-read.mjs` sets `dispatched = true` right
// before calling the transport, and the transport's own guards (connection epoch,
// source authorization, snapshot shape) run inside that call. Their throws used to be
// indistinguishable from a lost platform response, so the reader answered `unknown`
// and the wiring kept the tracking charge — three such refusals exhausted
// `trackingLimit` while issuing zero `get_qzone_msg_list` calls.
//
// The fix is a marker (`QZONE_READ_NOT_SENT`) on the error the transport raises
// asks isQzoneReadNotSent(error). This probe sweeps the call on which the epoch changes, which
// is how the guard is reached without any fabricated refusal.
import { createQzoneLiveFriendRead } from '../src/core/qzone-live-friend-read.mjs';
import { createQzoneBoundReadTransport, isQzoneReadNotSent } from '../src/core/qzone-bound-read-transport.mjs';

const now = Date.parse('2026-11-10T04:00:00Z');
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

async function attempt(flipAt) {
  let epochCalls = 0;
  const getConnectionEpoch = () => {
    epochCalls += 1;
    return epochCalls >= flipAt ? 9 : 8;
  };
  const sent = [];
  const transport = createQzoneBoundReadTransport({
    botQq: 123,
    getConnectionEpoch,
    transport: { async get_qzone_msg_list(params) { sent.push(params); return { kind: 'trusted-envelope', envelope: { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } } }; } },
  });
  let proofNo = 0;
  const proof = {
    // Exactly the seven documented proof fields — `trustedProof` rejects any extra key.
    id: `pf-${flipAt}`, sourceProofId: `sp-${flipAt}`, source: 'requested',
    targetQq: FRIEND, botQq: 123, connectionEpoch: 8,
  };
  const reader = createQzoneLiveFriendRead({
    store: makeStore(),
    clock: () => now,
    offlineTestFixture: true,
    authorizeTool: () => ({ allowed: true }),
    // The SAME proof on every call: the reader re-verifies before the transport and
    // `sameProof` compares field by field, so a fresh id per call would be refused at
    // the pre-dispatch recheck and the transport would never be reached.
    verifyRequestProof: async () => proof,
    verifyFriendship: async (binding) => ({
      // `boundFriendReceipt` requires exactly these five keys and these values; any
      // other shape makes the friendship gate refuse before the transport runs.
      status: 'friend', sourceProofId: binding.sourceProofId, botQq: binding.botQq,
      targetQq: binding.targetQq, connectionEpoch: binding.connectionEpoch,
    }),
    transport,
  });
  const result = await reader.read(proofNo === 0 ? {} : {});
  return { flipAt, outcome: result.outcome ?? result.reason, dispatched: result.dispatched, allowed: result.allowed, sent: sent.length, epochCalls };
}

const rows = [];
for (let flipAt = 1; flipAt <= 12; flipAt++) rows.push(await attempt(flipAt));
const preSend = rows.find((row) => row.sent === 0 && row.dispatched === false);
process.stdout.write(`${JSON.stringify({
  rows,
  notSentReported: preSend !== undefined,
  example: preSend ?? null,
  forgedMarkerIgnored: isQzoneReadNotSent(Object.assign(new Error('forged'), { [Symbol.for('qzone.read.not-sent')]: true })) === false,
})}\n`);
