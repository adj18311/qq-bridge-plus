// Is the `sent !== true` ordering in the transport's catch actually reachable?
//
// The round-9 reviewer ran a full-suite mutation that deletes `sent !== true` from
// `src/core/qzone-bound-read-transport.mjs:77` and got 664/664 green — so no test pins
// the ordering. This probe answers the prior question: is the ordering LOAD-BEARING, or
// is it dead defensive code? If a marker-bearing error can reach the catch AFTER the
// send, then without the guard the transport would report a real read as "not sent",
// which unlocks a quota refund for a read that really happened.
//
// The marker cannot be forged (module-private symbol + WeakSet), so the only way to get
// a marked error object is to make the transport raise one: a malformed snapshot does
// that. This probe captures that object and then re-injects it through
// `getConnectionEpoch`, which the transport calls a second time AFTER `sent = true`.
//
// Read-only: fake transport, no network, no credentials, no real QQ.
import { createQzoneBoundReadTransport, isQzoneReadNotSent } from '../src/core/qzone-bound-read-transport.mjs';

const out = {};

const GOOD = Object.freeze({ target_uin: 456, pos: 0, num: 20, botQq: 123,
  connectionEpoch: 8, sourceProofId: 'sp-1' });
const BAD = Object.freeze({ target_uin: 456, pos: 0, num: 20, botQq: 123, connectionEpoch: 8 });

// Step 1: capture a genuine marker-bearing error from a pre-send refusal.
let captured = null;
{
  const transport = createQzoneBoundReadTransport({
    botQq: 123, getConnectionEpoch: () => 8,
    transport: { async get_qzone_msg_list() { throw new Error('must not be called'); } },
  });
  try { await transport(BAD, () => true); } catch (error) { captured = error; }
  out.capturedMarker = {
    isMarked: isQzoneReadNotSent(captured),
    message: captured?.message ?? null,
  };
}

// Step 2: the send happens, then `getConnectionEpoch` (called after `sent = true`)
// throws the captured marker object. With the `sent !== true` guard the refusal must
// be reported as an ordinary unreadable failure; without it, it would be reported as
// "nothing was sent" and the wiring would refund a read that really went out.
{
  let epochCalls = 0;
  const sentCalls = [];
  const transport = createQzoneBoundReadTransport({
    botQq: 123,
    getConnectionEpoch: () => {
      epochCalls += 1;
      // 1st call: pre-send check. 2nd call: post-send revalidation.
      if (epochCalls === 2) throw captured;
      return 8;
    },
    transport: {
      async get_qzone_msg_list(params) {
        sentCalls.push(params);
        return { kind: 'trusted-envelope', envelope: { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } } };
      },
    },
  });
  let thrown = null;
  try { await transport(GOOD, () => true); } catch (error) { thrown = error; }
  out.afterSendReinjectedMarker = {
    epochCalls,
    sentCalls: sentCalls.length,
    thrownMessage: thrown?.message ?? null,
    reportedAsNotSent: isQzoneReadNotSent(thrown),
    sameObjectAsCaptured: thrown === captured,
  };
}

// Step 3: control — the same re-injection BEFORE the send (1st epoch call) must still
// be credited as not-sent, otherwise the guard would be over-broad and pre-dispatch
// refusals would stop refunding.
{
  let epochCalls = 0;
  const transport = createQzoneBoundReadTransport({
    botQq: 123,
    getConnectionEpoch: () => {
      epochCalls += 1;
      if (epochCalls === 1) throw captured;
      return 8;
    },
    transport: { async get_qzone_msg_list() { throw new Error('must not be called'); } },
  });
  let thrown = null;
  try { await transport(GOOD, () => true); } catch (error) { thrown = error; }
  out.beforeSendReinjectedMarker = {
    epochCalls,
    reportedAsNotSent: isQzoneReadNotSent(thrown),
    sameObjectAsCaptured: thrown === captured,
  };
}

out.verdict = {
  markerIsObtainableWithoutForging: out.capturedMarker.isMarked,
  sendReallyHappenedInStep2: out.afterSendReinjectedMarker.sentCalls === 1,
  postSendMarkerIsSuppressed: out.afterSendReinjectedMarker.reportedAsNotSent === false,
  preSendMarkerIsCredited: out.beforeSendReinjectedMarker.reportedAsNotSent === true,
  orderingIsLoadBearing: out.afterSendReinjectedMarker.sentCalls === 1
    && out.afterSendReinjectedMarker.reportedAsNotSent === false
    && out.beforeSendReinjectedMarker.reportedAsNotSent === true,
};

console.log(JSON.stringify(out, null, 2));
