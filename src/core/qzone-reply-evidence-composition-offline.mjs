// ONE CALL that turns "may this reply be attempted?" into "this reply has been reserved" —
// with the evidence-age gate ACTUALLY ON THE PATH.
//
// WHY THIS FILE EXISTS
// --------------------
// Two facts, both verified by reading the code in this repository:
//
//  1. `state.commentEvidence` rows carry `at`, but nothing on the RESERVE path ever looks at it. The
//     store documents `at` as "metadata for `prune`" (`qzone-reply-evidence-store-offline.mjs:63`,
//     `:271`), and `prune()` is only ever called explicitly by a caller. So a row stamped a year ago
//     authorises a reply exactly like one stamped a minute ago. "The evidence expires" is FALSE as a
//     description of the reservation layer.
//  2. The module that DOES judge `at` — `createQzoneReplyEvidenceConsumer`
//     (`qzone-reply-evidence-consumer-offline.mjs`) — had ZERO callers under `src/` before this file;
//     its only non-test importer is now this composition (verified with `Select-String`). An un-called
//     gate protects nothing, which is the whole reason the composition exists.
//
// The reservation layer cannot enforce the age itself: `qzone-reservation-offline.mjs:11` and
// `:20-27` state that `ledger.reservations` must not gain a TTL/prune/eviction, and the reservation's
// evidence branch (`:216-246`) filters by the identity triple and `matchesReplyEvidence` only — it
// never reads `at` (and, in the checked scope, is not to be changed to). So the age limit has to be
// enforced BEFORE the reservation, by refusing to call it. That is exactly what this module composes:
//
//     check()  ── refuse ──▶  return the refusal, reservation NOT called (zero quota, zero cooldown)
//        │
//        └─ pass ──▶ reserveAuditedOfflineInteraction(store, {…, now}, {…, time: now})
//
// ⚠️ WHAT THIS FILE DOES **NOT** CLAIM
// -----------------------------------
//   · It does not claim evidence in a production deployment is protected. Within the checked scope
//     (this repository's `src/`) nothing imports this module either, so it is PREPARATORY: the gate is
//     now wired to the reservation, but the composition itself has no production caller yet. Wiring it
//     is a separate change with its own review.
//   · It does not make `state.commentEvidence` provenance-true. Rows are still caller-written plain
//     objects (see the store's own header, `:17-26`); anyone who can execute JavaScript in the process
//     can write a row with any `at`. This module checks SHAPE AND AGE, not provenance.
//   · It does not make the reply atomic with the platform send. It is synchronous from the gate to the
//     reservation (no `await`, no I/O between them), which is as small as the window can be made in one
//     process; it does not eliminate cross-process writers (see LIMITS at the bottom).
//
// ── ONE CLOCK READ, AND WHY
// ---------------------------------------------------------------------------------------------
// `clock()` is read EXACTLY ONCE per `reserveReply()`: inside the consumer's `check()`
// (`:302-303`). The reservation needs a `now` for the quota day, the 3-minute interval and the audit
// `time`, and it must be the SAME instant the age was measured against — otherwise a clock that moved
// (or a caller that supplied its own) would let the two halves of one decision disagree.
//
// `check()` returns `{ok:true, at, ageMs, maxAgeMs}` and NOT the instant, so this module recovers it
// as `at + ageMs` — exact, because `check()` computes `ageMs = now - at` (`:338`). That arithmetic is
// NOT a second implementation of the age rule: the rule itself is only ever `check()`.
//
// The caller therefore does NOT supply the timestamp for a reply: any `request.now` and any
// `intent.time` are OVERWRITTEN with the recovered instant and are not trusted. On a refusal no
// instant is needed at all (the reservation is not reached), so there is still exactly one read.
//
// ── DEFAULT MAXIMUM EVIDENCE AGE: 10 MINUTES (`DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS`)
// ---------------------------------------------------------------------------------------------
// The number is a POLICY, so here is the reasoning rather than a bare constant:
//
//   · LONG ENOUGH for the normal approve→send flow. `OPERATION_TTL_MS = 30_000`
//     (`qzone-operation-authorization-offline.mjs:59`) bounds how long an APPROVAL stays usable, and
//     the evidence is read BEFORE the approval exists (read comments → bind → record → approve →
//     send). A human approving, plus the approval's own 30 s life, plus retries, must fit inside the
//     bound or every normal reply would be refused for staleness. 10 minutes is 20× that TTL.
//   · LONG ENOUGH relative to the send cadence. The audited path enforces a 3-minute minimum between
//     comments (`qzone-reservation-offline.mjs:141`, 180_000 ms). A reply prepared just after the
//     previous send is at most a couple of those cycles old; 10 minutes covers it with room to spare.
//   · SHORT ENOUGH that the fact being asserted still means something. A row says "this comment
//     exists, and its author is X". Over ten minutes the realistic change is deletion or moderation —
//     not a rewrite of authorship — so ten minutes keeps the claim close to the read while still
//     absorbing a queueing delay. It is deliberately NOT tied to `OPERATION_TTL_MS`: approval validity
//     and evidence freshness are different facts and can change independently (the approval is about
//     "the operator said yes recently"; the evidence is about "the platform content was like this
//     recently").
//
//   · BOUNDED, and it cannot be made unbounded by a caller. `MAX_REPLY_EVIDENCE_MAX_AGE_MS` is one
//     hour, and a larger `maxAgeMs` is refused at construction with `TypeError`. `Infinity`,
//     `Number.MAX_SAFE_INTEGER`, `NaN` and floats are already refused by the consumer
//     (`Number.isSafeInteger`, `:267`). So "no age limit" cannot be expressed as a big number here.
//     One hour is the ceiling because beyond it the row is not evidence about the current content any
//     more, and a caller that genuinely wants longer is asking for a different product decision — one
//     that should not be smuggled in as a configuration value.
//
// ── LEGACY / UNDATED EVIDENCE: FAIL CLOSED, NO SWITCH, ON PURPOSE
// ---------------------------------------------------------------
// `check()` already refuses `at`-absent rows (`evidence-undated`) and unreadable `at`
// (`evidence-invalid-at`) — see its table at `:96-102` and rule 1 at `:106-111`. This composition
// KEEPS that default: an old row never authorises a reply.
//
// There is deliberately NO `allowUndated`-style option in this module:
//   · an "undated counts as fresh" switch would require re-spelling the age decision HERE, i.e. a
//     second copy of the rule the task forbids duplicating — and a second copy is exactly how the two
//     gates would drift into disagreeing about the same row;
//   · the honest compatibility path is to RE-RECORD the row through the producer with a trustworthy
//     `now` (`qzone-reply-evidence-store-offline.mjs#record`), which stores a dateable `at`. That is a
//     write, visible in the store, not a flag that silently reinterprets history.
// Note the asymmetry with `prune()` (store `:332-366`), which RETAINS undated rows: "do not delete
// what you cannot interpret" and "do not authorise what you cannot date" are different obligations.
// Undated rows therefore survive in the store and never authorise — they must be re-recorded to work.
//
// ── WHAT THIS FILE DOES NOT TOUCH
// ------------------------------
//   · No change to the consumer, the store, the reservation, the write path, the audit layer, the
//     runtime wiring, the approved-dispatch modules, or any configuration/ACL/credential file. It
//     imports the reviewed gate and the reviewed reservation and adds ONE composition entry point.
//   · No producer-side `expiresAt`: the age is computed at consume time from `at` and the single
//     clock read. A stored expiry would be a caller-controlled number nothing checks — the exact
//     decoration this work exists to remove.

import { createQzoneReplyEvidenceConsumer } from './qzone-reply-evidence-consumer-offline.mjs';
import { reserveAuditedOfflineInteraction } from './qzone-reservation-offline.mjs';

/**
 * Default maximum accepted age of one `state.commentEvidence` row. See the module header for why it
 * is ten minutes. Chosen HERE (not in the consumer, which deliberately has no default) so that a
 * caller of this composition gets a bounded policy without choosing one per call site.
 */
export const DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Hard ceiling for a caller-supplied `maxAgeMs`. A value above this is refused at construction, so
 * "effectively unbounded" cannot be spelled as a large integer. See the header.
 */
export const MAX_REPLY_EVIDENCE_MAX_AGE_MS = 60 * 60 * 1000;

function invalid(message) {
  return new TypeError(message);
}

/**
 * Build the composition over ONE store handle.
 *
 * The SAME handle is used for the gate and for the reservation, by construction: a gate reading a
 * different database than the one that reserves would be a gate over somebody else's evidence.
 *
 * @param store - a synchronous handle with `read()`/`update()` (the reservation handle). The consumer
 *   refuses anything else, so the read-only export handle cannot be passed here.
 * @param clock - `() => trusted millisecond timestamp`. Read ONCE per `reserveReply()` (inside
 *   `check()`). There is no `Date.now()` fallback in either layer.
 * @param maxAgeMs - optional; defaults to `DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS`. Must be a non-negative
 *   safe integer and at most `MAX_REPLY_EVIDENCE_MAX_AGE_MS`.
 * @throws {TypeError} for construction errors only.
 */
export function createQzoneReplyEvidenceComposition({
  store,
  clock,
  maxAgeMs = DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS,
} = {}) {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) {
    throw invalid('maxAgeMs must be a non-negative safe integer');
  }
  if (maxAgeMs > MAX_REPLY_EVIDENCE_MAX_AGE_MS) {
    throw invalid(`maxAgeMs must be at most ${MAX_REPLY_EVIDENCE_MAX_AGE_MS} ms (an unbounded evidence age cannot be expressed here)`);
  }
  // Construction of the consumer validates `store` (read+update) and `clock`. Keeping that check in
  // ONE place means this module cannot accidentally accept a handle the gate would not.
  const gate = createQzoneReplyEvidenceConsumer({ store, clock, maxAgeMs });

  /**
   * Check the evidence, then reserve the reply — in that order, synchronously.
   *
   * Contract:
   *   · Evidence refused  ⇒ the gate's refusal is returned VERBATIM and the reservation is NOT
   *     called, so `used`, `lastCommentAt`, `commentTargets`, the reservation map (the B2 key) and
   *     `audit` are untouched. `ok:false` plus a `reason` from `REPLY_EVIDENCE_CONSUMER_REASONS`.
   *   · Evidence accepted ⇒ `reserveAuditedOfflineInteraction` is called with `now` recovered from
   *     the SAME clock read, and its result is returned unmodified: `{allowed:true}` or
   *     `{allowed:false, reason}` for the reservation's OWN reasons (interval, daily quota, write
   *     gate, duplicate id, …). Those are legitimate independent refusals; this module does not
   *     predict them. `ok` is absent in that result because it is the reservation's shape, not a
   *     second verdict shape.
   *
   * `request.now` and `intent.time` are IGNORED/overwritten (see the header). `request.tool` MUST be
   * `'reply'`: the audited reservation only consults evidence on the reply branch, so composing this
   * gate with another tool would produce a check whose verdict the reservation never uses.
   *
   * @param query - `{request, intent, replyParams?}`:
   *   `request` - the audited reservation request (`id`, `tool:'reply'`, `target`, `postId`,
   *     `source`, `commentId`); `now` is supplied by this module.
   *   `intent`  - the audit intent for that request; `time` is supplied by this module.
   *   `replyParams` - the full reply identity (`{comment_id, comment_uin, reply_uin?, reply_name?}`),
   *     the same object the write path puts on the request. Optional argument: when omitted,
   *     `request.replyParams` is used. Required in effect — the gate refuses to guess an identity.
   * @returns the gate's frozen refusal, or the reservation's result.
   * @throws {TypeError} for a caller CONTRACT violation only (no `request`/`intent` object, or a
   *   `tool` other than `'reply'`), BEFORE the clock is read or the store is touched. Data problems
   *   (bad ids, missing identity, undated/expired evidence) are refusals, never throws.
   */
  function reserveReply(query) {
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      throw invalid('reserveReply requires {request, intent, replyParams?}');
    }
    const request = query.request;
    const intent = query.intent;
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw invalid('reserveReply requires a request object');
    }
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
      throw invalid('reserveReply requires an intent object');
    }
    if (request.tool !== 'reply') {
      throw invalid("reserveReply only composes the 'reply' tool (evidence is consulted on that branch only)");
    }
    // Explicit argument wins; the request's own field is a convenience fallback so a caller that
    // already built the audited request does not have to carry the identity twice.
    const replyParams = query.replyParams === undefined ? request.replyParams : query.replyParams;

    // ── stage 1: the evidence gate. ONE clock read lives here. ─────────────────────────────────
    const decision = gate.check({
      target: request.target,
      postId: request.postId,
      commentId: request.commentId,
      replyParams,
    });
    // Any refusal — expired, undated, future-dated, invalid `at`, missing/mismatched identity, bad
    // clock, unreadable collection — stops HERE. Returning the frozen decision verbatim keeps one
    // vocabulary (`REPLY_EVIDENCE_CONSUMER_REASONS`) and one shape for every evidence refusal.
    if (decision.ok !== true) return decision;

    // The instant the age was measured against, recovered exactly (see the header). `check()` has
    // already proved both fields are non-negative safe integers and that `at <= now`.
    const now = decision.at + decision.ageMs;

    // ── stage 2: the audited reservation, at the SAME instant. No I/O and no `await` between
    // stage 1 and here, so the window in which the row could change is as small as one process can
    // make it. The reservation re-reads the row itself and re-checks presence + identity; a row that
    // disappeared in between can only DOWNGRADE to `missing_comment_evidence` (refuse for free).
    return reserveAuditedOfflineInteraction(
      store,
      {
        id: request.id,
        now,
        tool: 'reply',
        target: request.target,
        postId: request.postId,
        source: request.source,
        commentId: request.commentId,
        replyParams,
      },
      { ...intent, time: now },
    );
  }

  return Object.freeze({ reserveReply, maxAgeMs });
}

// LIMITS (stated, not papered over)
// ---------------------------------
//   · NO PRODUCTION CALLER: within the checked scope (`src/` of this repository) nothing imports this
//     module, so a reply in the current composition is still refused earlier for lack of evidence (or
//     never reaches here at all). This module makes the wired path AVAILABLE, not ACTIVE.
//   · The gate reads `commentEvidence`; the reservation re-reads it inside its own transaction. In one
//     process the two reads are sequential and synchronous, but a DIFFERENT process writing the store
//     between them is not excluded by the checked code: it could, in principle, replace the
//     identity-matching row with another identity-matching row carrying a fresher `at`. The identity
//     comparison still has to pass (so "reply to the wrong person" is not opened), and the row must
//     still be reassembled by a writer able to reach the store. Bounding that requires the store-level
//     trust model, which is out of this file's scope.
//   · Age is only as good as the clock. The clock is supplied by the caller, read once, and there is
//     no `Date.now()` fallback; a clock that lies makes every row look as fresh or as old as it says.
//     The consumer refuses a throwing/non-integer/negative clock (`clock-invalid`).
