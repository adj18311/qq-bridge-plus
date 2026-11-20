// B3 correlation -> B2 persistent claim -> injected transport, as ONE importable offline
// entry point.
//
// WHY THIS MODULE EXISTS
// ----------------------
// `scripts/test-qzone-b3-chain.mjs` already proved the three pieces compose correctly, but it
// built the chain INSIDE the test file: `buildChain()`/`run()` exist nowhere else. That makes
// the ordering a property of a test fixture, not of a module anything can import. It also had
// two options left UNINJECTED by default — the contract validator and the ownership map — so
// the composed behaviour that the tests described was weaker than the composed behaviour
// anyone would get.
//
// This module closes exactly that gap and nothing else:
//
//   · one exported factory, no other named exports;
//   · `contractValidator` and `ownership` are REQUIRED injections, checked at construction
//     (missing/non-functional ⇒ TypeError, never a silent skip);
//   · the order correlate -> claim -> dispatch is in the code, not in prose.
//
// The pieces themselves are NOT re-implemented. This file imports the reviewed B3 table, the
// reviewed B2 claimer and the reviewed claim->transport wrapper and composes them.
//
// THE ORDER IS NOT COMMUTABLE — each swap is a concrete defect
// -----------------------------------------------------------
//   claim BEFORE correlate  =>  a call that was never authorised still occupies a replay key.
//       Anyone able to reach this entry point with a guessed (requestId, callId) pair could
//       burn that key in advance and make the legitimate call permanently undispatchable.
//       Pre-correlation rejection must therefore write NOTHING: a refusal must not be able to
//       poison the replay set, and `claimSize()` must stay a truthful audit signal of calls
//       that were actually authorised and CLAIMED.
//
//       NOTE (corrected): a claim is NOT proof of dispatch. The process can die after the claim
//       commits and before the transport runs, and an `unknown` outcome does not mean the
//       platform received anything. So `claimSize()` counts authorised-and-claimed calls, never
//       "已派发" / "delivered". Read it as a replay-set occupancy gauge, not a delivery ledger.
//
//   dispatch BEFORE claim  =>  the same (account, session, request, call) can reach the
//       platform twice. The claim is the only thing that makes "at most once" true; if the
//       transport runs first, two duplicates both pass before either key exists.
//
//   correlate AFTER claim (i.e. claim-first, correlate-later) is the same defect as the first
//       row with an extra step: the key is already written when the refusal is discovered, and
//       nothing in B2 can un-write it without reopening the replay window.
//
// So the three stages are ordered by what each one needs to be TRUE before the next runs:
// correlate decides whether this call may happen at all; claim decides whether it has already
// happened; the transport is the only irreversible step and therefore runs last, exactly once.
//
// WHAT THIS IS NOT
// ----------------
//   · NOT a production entry point. Nothing in `src/bridge.js` imports it; the production
//     assembly point stays at zero. This is an OFFLINE SAMPLE that can be imported and tested
//     on its own.
//   · NOT authentication of the caller. `requestId` is a lookup key, not a per-call proof
//     (see the header of `qzone-b3-correlation-offline.mjs`): a process that can observe a
//     requestId can reuse it with a NEW callId, and only B2's key limits how many times.
//   · NOT a retry engine and NOT a not-sent classifier. An `unknown` transport outcome keeps
//     the claim and is never retried here.
//   · NOT a durability proof beyond "the claim was committed before the transport ran"
//     (asserted by the tests with a second SQLite connection).

import { createCorrelationTable } from './qzone-b3-correlation-offline.mjs';
import { createReplayClaimer, initializeReplayState } from './qzone-replay-claim-offline.mjs';
import { createReplayGuardedDispatcher } from './qzone-replay-dispatch-offline.mjs';

/**
 * Build the guarded dispatcher.
 *
 * Every dependency is required. In particular `contractValidator` and `ownership` are NOT
 * optional: the correlation table treats them as optional hooks (that is right for a low-level
 * table), but a composed entry point that skips them would accept call shapes the business
 * contract rejects and would never check who owns the post being touched. A composed guarantee
 * must not be weaker than the pieces it claims to compose, so the absence of either is a
 * construction error here.
 *
 * @param store - offline state store (`read`/`update`), already backed by SQLite in tests.
 * @param accountId - the bot account this claimer is bound to (part of the B2 key).
 * @param selfUin - the bot's own uin, used by the sample target-scope rules.
 * @param clock - () => trusted millisecond timestamp.
 * @param ownership - ownership evidence map (`has`, `ownerOf`, ...); REQUIRED.
 * @param contractValidator - (action, input) => boolean; REQUIRED.
 * @param transport - async (action, input) => result; the fake/real platform call.
 */
export function createB3GuardedDispatch({
  store, accountId, selfUin, clock, ownership, contractValidator, transport,
} = {}) {
  // ── dependency validation: every one of these is mandatory ────────────────────────────
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('b3 guarded dispatch needs a store with read/update');
  }
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new TypeError('b3 guarded dispatch needs a positive accountId (botQq)');
  }
  if (!Number.isSafeInteger(selfUin) || selfUin <= 0) {
    throw new TypeError('b3 guarded dispatch needs a positive selfUin');
  }
  if (typeof clock !== 'function') throw new TypeError('b3 guarded dispatch needs a clock()');
  // Ownership: absence is an ERROR, not a mode. Without it `authorize` cannot tell "this post
  // is not yours" from "nobody said anything about this post".
  if (ownership === null || typeof ownership !== 'object'
    || typeof ownership.has !== 'function' || typeof ownership.ownerOf !== 'function') {
    throw new TypeError('b3 guarded dispatch requires an ownership map (not optional)');
  }
  // Contract validator: absence means "any shape is accepted", which is precisely the weaker
  // behaviour this composed entry point exists to stop.
  if (typeof contractValidator !== 'function') {
    throw new TypeError('b3 guarded dispatch requires a contractValidator (not optional)');
  }
  if (typeof transport !== 'function') {
    throw new TypeError('b3 guarded dispatch needs a transport function');
  }

  // The table gets BOTH required hooks. They are not re-validated here because the factory
  // above already refused to build without them.
  const table = createCorrelationTable({ selfUin, clock, ownership, contractValidator });
  const claimer = createReplayClaimer({ store, accountId });
  const dispatcher = createReplayGuardedDispatcher({ claimer, transport, clock });

  return Object.freeze({
    /**
     * Explicit first-install step. Deliberately NOT automatic: `initializeReplayState` is
     * idempotent for a healthy install and REFUSES to rebuild a lost collection (that refusal
     * is the whole point of the B2 marker). Calling it here keeps the decision visible instead
     * of hiding it inside the first dispatch.
     */
    initialize({ now } = {}) { return initializeReplayState(store, { now }); },

    /**
     * Diagnostic: how many distinct (account, session, request, call) keys are recorded.
     *
     * This counts CLAIMED calls, not dispatched ones. A claim that commits and is then followed by
     * a crash, or by an `unknown` transport outcome, still counts here — because the whole point
     * of the replay set is that such a call must NOT be retried. Do not read this as "how many
     * reached the platform".
     */
    claimSize() { return claimer.size(); },

    /** Diagnostic: how many requestIds the correlation table knows. */
    tableSize() { return table.size(); },

    /** Diagnostic: record one real inbound event (trusted side only). */
    record(event) { return table.record(event); },

    /**
     * Run exactly one call through the fixed order.
     *
     * @returns
     *   { ok:true,  stage:'transport', outcome:'success'|'failed'|'unknown', result, ... }
     *   { ok:false, stage:'correlate', reason, detail, ... }   claim NOT taken, transport NOT called
     *   { ok:false, stage:'claim',     reason, ... }           transport NOT called
     *   { ok:false, stage:'transport', reason:'transport-threw', error }  transport called, threw
     *
     * A THROW from the claimer propagates out of this method on purpose. A storage failure is
     * not a "not sent" answer: the caller must be able to tell "nothing happened" from "I
     * could not record whether it happened". Swallowing it into `ok:false` would invite a
     * retry of a call that may already be durable.
     */
    async dispatch({ requestId, accountId: callerAccountId = accountId, action, input, sessionId, callId, generation } = {}) {
      // ── stage 1: correlate (B3) ────────────────────────────────────────────────────────
      // Runs FIRST so that a refused call writes no replay key. Read-only: `authorize` never
      // mutates the table.
      const correlation = table.authorize({ requestId, accountId: callerAccountId, action, input });
      if (!correlation || correlation.ok !== true) {
        return Object.freeze({
          ok: false,
          stage: 'correlate',
          reason: correlation?.reason ?? 'correlation-refused',
          // The refusal record carries audit-relevant detail (owner, field, candidates, ...);
          // exposing it under one key keeps the outer shape stable.
          detail: correlation,
          requestId, action, callId, sessionId,
        });
      }

      // ── stage 2 + 3: claim (B2), then transport ───────────────────────────────────────
      // Delegated to the reviewed wrapper so the claim->transport ordering and the outcome
      // normalisation (`success`/`failed`/`unknown`, no short-circuiting) are NOT re-implemented
      // here. The identity is exactly (account fixed in the claimer, sessionId, requestId,
      // callId): the caller's chosen reply candidate is NOT part of it, and must never become
      // part of it — see the reporting note in the accompanying doc. Folding it in would mint a
      // fresh key whenever only the chosen reply target changes, letting the same call run a
      // second time and reopening the exact replay window B2 exists to close.
      const out = await dispatcher.dispatch({
        identity: { sessionId, requestId, callId, generation },
        action,
        input,
      });

      if (out.ok === true) {
        return Object.freeze({
          ok: true,
          stage: 'transport',
          outcome: out.outcome,
          result: out.result,
          correlation,
          requestId, action, callId, sessionId,
        });
      }

      // `claim` refusals and transport throws keep their own stage. `unknown`/throw outcomes
      // leave the claim consumed: the wrapper never retries, and neither do we.
      return Object.freeze({
        ok: false,
        stage: out.stage === 'claim' ? 'claim' : 'transport',
        reason: out.reason ?? 'dispatch-refused',
        ...(out.error === undefined ? {} : { error: out.error }),
        correlation,
        requestId, action, callId, sessionId,
      });
    },
  });
}
