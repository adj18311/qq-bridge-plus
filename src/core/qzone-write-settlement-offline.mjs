// Write-quota SETTLEMENT: reserve -> persist -> transport -> classify the result.
//
// WHY THIS MODULE EXISTS (gap G-1)
// --------------------------------
// `qzone-policy-offline.mjs:93` states the contract for `reserveWrite`:
//
//     // Pure state transition only: caller must serialize, persist atomically before
//     // dispatch, and fail closed on persistence errors. Unknown outcomes never refund.
//
// Nothing implemented that contract. `qzone-reservation-offline.mjs` composes the policy into
// reservation operations but is not wired anywhere, and the runtime refuses writes with
// `write-not-wired` BEFORE any reservation is considered (see the note at the bottom of this
// header). This module is that missing caller: it takes the pure transition, persists it
// atomically, and only then lets one platform call happen.
//
// THE ORDER, AND WHY IT IS NOT NEGOTIABLE
// --------------------------------------
//   1. read the ledger from the store
//   2. `reserveWrite(...)`            (pure; decides duplicate / limit / take)
//   3. persist the next state ATTESTED  (one `store.update` transaction: BEGIN IMMEDIATE ...
//      COMMIT; any throw rolls back, so a failed persist leaves the quota untouched)
//   4. call the injected transport    (exactly once)
//   5. classify, never retry, never refund
//
// Persist-before-dispatch is the entire point. If the reservation were written after the
// platform call, a crash between the two would leave a WRITE THAT HAPPENED with no record of
// it, and the same id would be accepted again — a duplicate publish, which is the one outcome
// this whole subsystem exists to prevent. Persisting first can only ever produce the opposite,
// safe error: a reserved call that never ran, i.e. a quota unit spent on nothing. Prefer
// wasting quota over publishing twice.
//
// NO REFUND. AT ALL. (the judgement call the task asked for)
// --------------------------------------------------------
// The task distinguishes two failures and asks whether quota should be given back:
//
//   (a) "genuinely never left" — persistence failed, or the transport itself reports it never
//       sent anything (argument validation, connection never established);
//   (b) "unknown" — transport threw, timed out, or returned an unparseable/unknown verdict.
//
// This module keeps quota consumed in BOTH cases, with one precise exception: when
// PERSISTENCE fails, the transaction rolled back and the quota was never consumed in the first
// place, so there is nothing to give back.
//
// Why not refund on (a)-via-transport? Three reasons, in increasing order of severity:
//
//   1. **A refund has to delete `reservations[id]` to free the id, or the id stays blocked and
//      the refund is purely cosmetic.** The user's replay guarantee is "the same id executes at
//      most once"; a deleted reservation makes the id reusable, so a transport that reports
//      "not sent" and is WRONG converts a double-publish from impossible to trivially
//      reachable. The transport's self-report is exactly the claim we cannot audit.
//
//   2. **Refunding without deleting the reservation silently breaks the limit.** `used` would
//      drop while `reservations` keeps the key, so `used[kind] < limit` stops bounding how many
//      reservations exist. An attacker (or a buggy caller) repeating "not sent" failures with
//      fresh ids could then grow `reservations` without bound while `used` stays at zero.
//
//   3. **The conservative error is recoverable; the optimistic one is not.** Spending one quota
//      unit on a call that never went out costs a user some reach today, and the operator can
//      see it in the returned `outcome`/`reason`. Publishing the same post twice cannot be
//      undone.
//
// So the two failures are DISTINGUISHED in the RESULT (different `outcome`/`reason`, and
// `transportCalled` / `quotaConsumed` tell the caller exactly what happened) but they are NOT
// distinguished in the ACCOUNTING. That asymmetry is deliberate and is what the tests pin.
//
// WHAT THIS MODULE IS NOT
// -----------------------
//   · NOT wired into production. `src/bridge.js` does not reference it; the assembly point
//     stays at 0.
//   · NOT a replacement for `write-not-wired`. `qzone-runtime-wiring.mjs` refuses write tools
//     BEFORE any reservation, on purpose: B3 origin binding is not closed, so no write may be
//     composed yet. Inserting a reservation ahead of that refusal would burn quota on calls
//     that are rejected for safety reasons. This module is an INDEPENDENT offline chain and
//     must not be spliced in front of that gate.
//   · NOT an authorisation layer. It answers "may this id spend one unit of write quota, and
//     what happened when the platform was called". Whether the write is ALLOWED at all is a
//     separate decision made by the caller's gates.

import { beijingDay, reserveWrite } from './qzone-policy-offline.mjs';

/** Write kinds the quota ledger tracks. Mirrors the policy's own list. */
export const WRITE_KINDS = Object.freeze(['post', 'comment', 'like']);

/**
 * Result classification. Every one of these is a DISTINCT outcome; none may be collapsed into
 * another, because they lead to different operator actions.
 */
export const SETTLEMENT_OUTCOME = Object.freeze({
  SUCCESS: 'success',       // transport reported a definite success
  FAILED: 'failed',         // transport reported a definite failure (the call DID go out)
  UNKNOWN: 'unknown',       // may or may not have reached the platform; never retried here
  NOT_SENT: 'not-sent',     // provably never left this process (see `reason`)
  REFUSED: 'refused',       // no reservation was taken at all (duplicate / limit / invalid)
});

/**
 * Classify a raw transport answer.
 *
 * Deliberately strict and non-short-circuiting: an unrecognised or self-contradictory answer is
 * `unknown`, never `success`. "The transport was called" is not evidence that anything reached
 * the platform, and treating it as such is how a not-sent failure gets mislabelled as sent.
 *
 * @returns {'success'|'failed'|'unknown'|'not-sent'}
 */
function classify(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return 'unknown';

  const hasOk = Object.hasOwn(result, 'ok');
  const hasOutcome = Object.hasOwn(result, 'outcome');
  const hasNotSent = Object.hasOwn(result, 'notSent');
  const hasUnknown = Object.hasOwn(result, 'unknown');

  // ── 1. reject illegal field values outright ─────────────────────────────────────────
  if (hasOk && typeof result.ok !== 'boolean') return 'unknown';
  if (hasNotSent && typeof result.notSent !== 'boolean') return 'unknown';
  if (hasUnknown && typeof result.unknown !== 'boolean') return 'unknown';
  if (hasOutcome && !['success', 'failed', 'unknown', 'not-sent'].includes(result.outcome)) return 'unknown';

  // ── 2. collect EVERY claim the answer makes, before deciding anything ───────────────
  //
  // This used to short-circuit: the "not sent" branch ran BEFORE the unknown claim was
  // collected, so `{notSent:true, unknown:true}` came back as `not-sent`. Measured. That is the
  // most dangerous direction of misreading in this whole file — it downgrades "I cannot tell"
  // into "definitely never left", and the user's rule is that a possibly-sent call must be
  // accounted for. Collecting first makes the precedence explicit instead of accidental.
  const claims = new Set();
  if (hasOk) claims.add(result.ok ? 'success' : 'failed');
  if (hasOutcome && result.outcome !== 'not-sent') claims.add(result.outcome);
  if (hasNotSent && result.notSent === true) claims.add('not-sent');
  if (hasOutcome && result.outcome === 'not-sent') claims.add('not-sent');
  if (hasUnknown && result.unknown === true) claims.add('unknown');

  // ── 3. precedence, most pessimistic first ───────────────────────────────────────────
  // `unknown` is CONTAGIOUS: an answer that admits it cannot tell is never upgraded, no matter
  // what friendlier field sits next to it. This is what keeps `{notSent:true, unknown:true}` at
  // `unknown` instead of `not-sent`.
  if (claims.has('unknown')) return 'unknown';

  // A definite success and a definite failure in one answer is not interpretable.
  if (claims.has('success') && claims.has('failed')) return 'unknown';

  // `not-sent` is a claim like any other: it conflicts with either definite verdict, and a
  // contradiction means we cannot interpret the answer — not that we believe the nicer half.
  if (claims.has('not-sent')) {
    if (claims.has('success') || claims.has('failed')) return 'unknown';
    return 'not-sent';
  }

  if (claims.size === 1) return [...claims][0];
  return 'unknown';                    // no claim at all
}

const validLimit = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 99;

/**
 * @param store - offline state store (`read`/`update`); tests use a real temp SQLite file.
 *   The quota ledger lives at `state.ledger`, matching `qzone-reservation-offline.mjs`.
 * @param limits - `{ post?, comment?, like? }` daily caps. A missing kind means "no write of
 *   this kind is configured", which is a construction-time error only when that kind is used.
 * @param clock - `() => trusted millisecond timestamp`. Must NOT be model-supplied.
 * @param transport - `async ({ id, kind, target, postId, source }) => result`.
 * @param now  - optional per-call override hook is deliberately NOT provided: the day must come
 *   from the same trusted clock the reservation uses.
 */
export function createWriteSettlement({ store, limits, clock, transport } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('write settlement needs a store with read/update');
  }
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new TypeError('write settlement needs a limits object');
  }
  for (const [kind, value] of Object.entries(limits)) {
    if (!WRITE_KINDS.includes(kind)) throw new TypeError(`unknown write kind in limits: ${kind}`);
    if (!validLimit(value)) throw new TypeError(`invalid daily limit for ${kind}`);
  }
  if (typeof clock !== 'function') throw new TypeError('write settlement needs a clock()');
  if (typeof transport !== 'function') throw new TypeError('write settlement needs a transport function');

  const limitFor = (kind) => {
    if (!WRITE_KINDS.includes(kind)) throw new TypeError(`invalid write kind: ${String(kind)}`);
    if (!Object.hasOwn(limits, kind)) throw new TypeError(`no daily limit configured for ${kind}`);
    return limits[kind];
  };

  return Object.freeze({
    /**
     * Diagnostic only: read the current ledger without touching it. Returns null when the store
     * has no ledger yet (a fresh store has to start with one; see the note in `settle`).
     */
    ledger() {
      const state = store.read();
      return state && typeof state === 'object' && state.ledger ? state.ledger : null;
    },

    /**
     * Settle exactly one write.
     *
     * @returns
     *   { ok:true,  outcome:'success'|'failed'|'unknown'|'not-sent', transportCalled, quotaConsumed,
     *     reservation:{ id, kind, day, used, limit }, result?, error? }
     *   { ok:false, outcome:'refused'|'not-sent', reason, transportCalled:false, quotaConsumed:false,
     *     reservation:null, error? }
     *
     * `ok` means "a reservation was taken and persisted" — i.e. this call got past the quota gate.
     * It does NOT mean the platform accepted anything; read `outcome` for that.
     */
    async settle({ id, kind, target, postId, source } = {}) {
      const limit = limitFor(kind);
      if (typeof id !== 'string' || !id || id.length > 128) {
        return Object.freeze({
          ok: false, outcome: SETTLEMENT_OUTCOME.REFUSED, reason: 'invalid-id',
          transportCalled: false, quotaConsumed: false, reservation: null,
        });
      }

      // ── 1 + 2 + 3. reserve AND persist in ONE transaction ───────────────────────────────
      // `reserveWrite` is pure, so the whole decision + write happens inside a single
      // `store.update` (BEGIN IMMEDIATE .. COMMIT). Two racing settles therefore serialize, and a
      // throw anywhere inside rolls the reservation back.
      let refused = null;
      let persisted = null;
      try {
        const now = clock();
        const day = beijingDay(now);
        store.update((state) => {
          if (!state || typeof state !== 'object' || !state.ledger) {
            throw new TypeError('store state has no quota ledger');
          }
          const reservation = reserveWrite(state.ledger, { day, kind, limit, id });
          if (!reservation.allowed) {
            // Nothing is written: returning the state unchanged keeps the committed JSON
            // identical, and the caller learns the refusal reason below.
            refused = reservation.reason;
            return state;
          }
          persisted = reservation.state;
          return { ...state, ledger: reservation.state };
        });
      } catch (error) {
        // FAIL CLOSED. `store.update` rolled back, so the quota was never consumed and the
        // transport must not run: we cannot prove a reservation for this id exists, and calling
        // the platform without one is exactly the duplicate this design forbids.
        return Object.freeze({
          ok: false, outcome: SETTLEMENT_OUTCOME.NOT_SENT, reason: 'persist-failed',
          transportCalled: false, quotaConsumed: false, reservation: null, error,
        });
      }

      if (refused !== null) {
        return Object.freeze({
          ok: false, outcome: SETTLEMENT_OUTCOME.REFUSED, reason: refused,
          transportCalled: false, quotaConsumed: false, reservation: null,
        });
      }

      const reservation = Object.freeze({
        id, kind, day: persisted.day, used: persisted.used[kind], limit,
        // Echo the reservation map size so a caller can see occupancy without re-reading.
        reservedCount: Object.keys(persisted.reservations).length,
      });

      // ── 4. the only irreversible step, exactly once ─────────────────────────────────────
      let outcome;
      let result;
      let error;
      try {
        result = await transport(Object.freeze({ id, kind, target, postId, source }));
        outcome = classify(result);
      } catch (thrown) {
        // A throw is NOT "it did not happen". The request may have reached the platform before
        // the failure surfaced. Treated as unknown, the claim/quota is kept, and nothing retries.
        outcome = SETTLEMENT_OUTCOME.UNKNOWN;
        error = thrown;
      }

      // ── 5. classify; quota stays consumed in every branch (see the header) ─────────────
      return Object.freeze({
        ok: true,
        outcome,
        transportCalled: true,
        quotaConsumed: true,
        reservation,
        ...(result === undefined ? {} : { result }),
        ...(error === undefined ? {} : { error }),
      });
    },
  });
}

export { classify as _classifyWriteTransportResult };
