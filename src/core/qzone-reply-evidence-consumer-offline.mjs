// A CONSUMER-SIDE gate for `state.commentEvidence`: "may this reply be attempted AT ALL?"
//
// ⚠️⚠️ THIS MODULE IS PREPARATORY WORK. IT IS **NOT** "item 2 complete". ⚠️⚠️
// See the "TRUSTED SOURCE" section below before reading a single line of the code. A green
// `check()` here means "the store holds one matching, not-too-old row" — NOT "the platform said so".
//
// WHY THIS FILE EXISTS
// --------------------
// Two facts, both verified by reading the code, not inferred:
//
//  1. `record()` in `qzone-reply-evidence-store-offline.mjs` writes an `at` on every row
//     (line 283: `{ ...fields, at: now }`), documented there as "metadata for `prune`". The ONLY
//     consumer of that collection — `reserveAuditedOfflineInteraction`
//     (`qzone-reservation-offline.mjs:216-246`) — filters by the identity triple and calls
//     `matchesReplyEvidence`. It NEVER reads `at`. So an age limit written on the producer side is
//     enforced by nobody: a row stamped a year ago authorises a reply exactly like one stamped a
//     minute ago. Writing `expiresAt` (or `at`) and not checking it downstream is a decoration, and
//     this project has already been told so.
//
//  2. `qzone-reservation-offline.mjs:11` and `:20-27` state, in capitals, that
//     `ledger.reservations` must NOT gain a TTL / prune / eviction, and that the same reasoning
//     applies to reopening a replay window. Whatever the general merits, that file is explicitly
//     out of bounds for an age limit. So the age limit CANNOT live in the reservation layer even if
//     we wanted it there.
//
// Therefore the age limit lives HERE, as a gate that runs BEFORE
// `reserveAuditedOfflineInteraction` is called, and refuses to let an expired (or undated) row reach
// it. That placement is also the cheapest one: the reservation spends nothing on a refusal, but a
// caller that does not ask first still has to burn a call to find out.
//
// ── WHAT `check()` ANSWERS ────────────────────────────────────────────────────────────────────
//   "Does `state.commentEvidence` hold EXACTLY ONE row for this (target, postId, commentId) whose
//    `at` is a readable, non-future, no-older-than-`maxAgeMs` timestamp, AND whose identity fields
//    agree with the reply this request is about to send?"
//
// ── WHAT IT DOES NOT ANSWER ───────────────────────────────────────────────────────────────────
//   · It does not prove the row came from a platform read. See "TRUSTED SOURCE".
//   · It does not reserve anything, spend quota, write audit, or advance `lastCommentAt`. It only
//     reads (`store.read()`), and it holds no lock: between `check()` and the reservation the row
//     could be pruned. The reservation re-checks the row's PRESENCE and IDENTITY itself, so that
//     race can only ever DOWNGRADE to `missing_comment_evidence` (refuse for free) — never authorise.
//   · It does not replace the reservation. Both must be kept: the reservation is where the reply
//     gate is atomic with the quota spend; this gate is where `at` is looked at.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// TRUSTED SOURCE — the question this module CANNOT answer, stated plainly
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// `state.commentEvidence` rows are just frozen plain objects in the store. The write path
// (`qzone-reply-evidence-store-offline.mjs#record`) accepts any `Object.freeze`d object with the
// right field set — its own header says so at lines 20-29 — so ANY code able to execute JavaScript
// in this process can write a row claiming whatever `at` it likes. A forger who writes
// `at: Date.now()` passes this gate. That is not a flaw in the expiry rule; it is the floor of what
// a shape check can do, and it must not be described as "verified".
//
// A row only becomes TRUSTWORTHY when it is derived from a trusted projection:
//
//     qzone-comment-binding-offline.mjs
//       :198  bindAuthorizedQzoneReply        -> reply-shaped projection (frozen)
//       :211  bindAuthorizedOwnNewQzoneComment -> comment-shaped projection (frozen)
//       :240  bindAuthorizedOwnNewQzoneReply   -> reply-shaped projection (frozen)
//
// fed into `qzone-reply-evidence-store-offline.mjs#record(projection, { now })`.
//
// ⚠️ NO SUCH CALL EXISTS IN THIS REPOSITORY. Concretely:
//   · Nothing under `src/` imports `qzone-reply-evidence-store-offline.mjs` (grep: its only
//     importer is `scripts/test-qzone-reply-evidence-store.mjs`). There is no producer bound to
//     `record()`, so in the current composition this gate can only ever answer "no row" and every
//     reply is refused for free. FAIL CLOSED BY ABSENCE — the honest state, not "verified".
//   · The three `bindAuthorized*` functions have no non-test caller either: grep for them finds
//     only `scripts/test-qzone-comment-binding-offline.mjs`,
//     `scripts/test-qzone-comment-binding-write-chain-offline.mjs` and
//     `scripts/test-qzone-reply-evidence-store.mjs`.
//   · The CLOSEST thing that looks like an authorised read chain is
//     `qzone-live-friend-read.mjs`'s `read_comments` branch (lines 296, 340-344): it is gated by
//     `exceptionReads.fetchCommentPage`/`semanticFetch`, projects the platform detail envelope with
//     `projectQzoneOnebotMsgDetail`, then narrows it with `filterOfflineOwnNewComment`. Its return
//     value is `{ allowed, outcome, parent, comments: [oneComment] }` — a OWN-NEW-COMMENT read. It
//     never calls a `bindAuthorized*` function and never writes `commentEvidence`, and it returns no
//     reply identity at all (no `parentQq`, no `replyQq`, no `replyName`). The wiring that enables it
//     lives in `qzone-runtime-wiring.mjs:329-331` and `:658`.
//
// So: the authorised read/event chain that WOULD supply data is
// `qzone-live-friend-read.mjs` (read_comments / own-new-comment scope) -> `bindAuthorized*`
// -> `record()` -> this gate -> `reserveAuditedOfflineInteraction`. Only the first arrow exists in
// code today, and even that one stops short (it filters down to one own comment and calls no binding).
// Building the remaining arrows is what would turn this module from "preparation" into "protection".
// Nothing in THIS file may be cited as "item 2 done".
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// EXPIRY SEMANTICS (the whole point of the file)
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// Judged on the ONE candidate row, in this order (the order is observable through `reason`):
//
//   | row state                                     | result                     |
//   |-----------------------------------------------|----------------------------|
//   | `at` absent (or `undefined`)                  | REFUSE `evidence-undated`  |
//   | `at` present but not a safe integer >= 0      | REFUSE `evidence-invalid-at` |
//   | `at > now` (dated in the future)              | REFUSE `evidence-future-dated` |
//   | `now - at > maxAgeMs`                         | REFUSE `evidence-expired`  |
//   | `now - at <= maxAgeMs`                        | continue to identity check |
//
// THREE rules that are easy to get wrong, and are therefore pinned by tests:
//
//   1. **A row without `at` is NOT "never expires".** It cannot be dated, so its age is unknown, and
//      unknown age is refused. Treating "no timestamp" as "fresh" would hand any legacy/foreign
//      writer a permanent bypass — precisely the hole this module exists to close.
//      (Note the deliberate asymmetry with `prune()` in the store, which RETAINS undated rows:
//      "do not delete what you cannot interpret" and "do not authorise what you cannot date" are
//      different obligations, and both are correct.)
//   2. **`maxAgeMs` is a bound, not a suggestion.** `now - at > maxAgeMs` refuses; equality is
//      allowed, so the accepted range is the CLOSED interval `age in [0, maxAgeMs]`.
//   3. **A future `at` is refused, not clamped.** `ageMs` would be negative, and a negative age
//      means the two clocks disagree (or the row was written to outlive its age limit). Either way
//      the age is not measurable, so it is refused. The reservation does not check this — a refusal
//      here is STRICTER than the layer below, which is the only direction this gate may differ in
//      (see "CONSISTENCY").
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// CONSISTENCY WITH `reserveAuditedOfflineInteraction`
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// The contract, in the order a host should use it:
//
//   const decision = consumer.check({ target, postId, commentId, replyParams });
//   if (!decision.ok) return refused(decision.reason);        // reservation NOT called: zero cost
//   const reserved = reserveAuditedOfflineInteraction(store, request, intent);
//
//   1. `check().ok === true`  =>  the reservation's EVIDENCE branch MUST also pass. This gate never
//      adds an evidence refusal the reservation would have allowed: the row it demanded is exactly
//      the row the reservation demands (same triple, same `matchesReplyEvidence` predicate, same
//      "exactly one" rule), and it normalises `replyParams` the same way the reservation does. The
//      reservation can still refuse for reasons that are NOT about evidence (the 3-minute interval,
//      the daily quota, a paused write gate, an unreadable state). Those are legitimate independent
//      refusals, and this gate does not predict them — claiming otherwise would be a second copy of
//      the whole policy, which is exactly what this module refuses to become. REC-1 proves the
//      evidence-consistency direction in a state where the other rules are satisfied.
//   2. `check().ok === false` => the reservation MUST NOT be called. Half of its refusals
//      (`evidence-expired`, `evidence-undated`, `evidence-invalid-at`, `evidence-future-dated`,
//      `reply-identity-*`, `clock-invalid`) are conditions the reservation does NOT look at, so
//      calling it anyway would spend a `comment` unit on a reply that this gate already refused.
//   3. Where this gate and the reservation disagree, THIS GATE IS THE STRICTER ONE, and only in the
//      refuse direction. Concretely it is stricter in: expiry (`at`), future dating, missing
//      `replyParams` (see below), an unreadable `commentEvidence` collection, and non-plain rows.
//
// `replyParams` IS REQUIRED HERE, on purpose. The reservation accepts `null` and then falls back to
// a pre-identity shape ("a row carrying NONE of the identity fields"), documented at its lines
// 229-238 as the lenient backward-compatibility path. A PRE-gate has no reason to reproduce that
// leniency — a caller that cannot name the reply's identity is exactly what the full-identity path
// exists to reject — so omission is refused as `reply-identity-required`. `qzone-write-path-offline.mjs:848-866`
// ALWAYS supplies the identity on the reply branch, so the facade can never hit this refusal while
// doing what it does today.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE DOES NOT TOUCH
// ══════════════════════════════════════════════════════════════════════════════════════════════
//   · No `settled` key, no audit row, no audit format change (`qzone-write-audit-offline.mjs` and
//     `qzone-audit-offline.mjs` are untouched).
//   · No reservation change, no TTL/prune/eviction anywhere. This module reads; it never writes.
//   · No producer-side `expiresAt`: the age is COMPUTED here from `at` and a caller-supplied clock,
//     because a stored expiry is another caller-controlled number nothing checks.

import { isSafeQzoneAuditId } from './qzone-audit-offline.mjs';
// ONE copy of "does this evidence describe this reply?" — the SAME predicate the reservation uses.
// Re-spelling it here would let the two drift, and drift in that predicate means a reply to the
// wrong person under a matching parent comment.
import { matchesReplyEvidence, trustedQQ } from './qzone-reply-evidence-offline.mjs';

// Every refusal reason this module can produce. Frozen and exported so a caller (and a test) can
// enumerate them instead of matching magic strings, and so a renamed reason is a compile-time-ish
// break rather than a silent behaviour change.
export const REPLY_EVIDENCE_CONSUMER_REASONS = Object.freeze({
  INVALID_REQUEST: 'invalid-request',
  CLOCK_INVALID: 'clock-invalid',
  REPLY_IDENTITY_REQUIRED: 'reply-identity-required',
  REPLY_IDENTITY_INVALID: 'reply-identity-invalid',
  REPLY_IDENTITY_MISMATCH: 'reply-identity-mismatch',
  EVIDENCE_STORE_UNREADABLE: 'evidence-store-unreadable',
  MISSING_EVIDENCE: 'missing_comment_evidence',   // same string the reservation returns
  EVIDENCE_MISMATCH: 'comment_evidence_mismatch', // same string the reservation returns
  EVIDENCE_UNDATED: 'evidence-undated',
  EVIDENCE_INVALID_AT: 'evidence-invalid-at',
  EVIDENCE_FUTURE_DATED: 'evidence-future-dated',
  EVIDENCE_EXPIRED: 'evidence-expired',
});

const R = REPLY_EVIDENCE_CONSUMER_REASONS;

function refusal(reason, extra) {
  return Object.freeze({ ok: false, reason, ...(extra === undefined ? {} : extra) });
}

function invalid(message) {
  return new TypeError(message);
}

/**
 * The reply identity, snapshotted into `buildQzoneOnebotWriteRequest`'s param shape.
 *
 * ⚠️ This is NOT the match predicate (that is `matchesReplyEvidence`, imported). It is the INPUT
 * NORMALISATION, and it mirrors `snapshotReplyParams` in `qzone-reservation-offline.mjs:171-193`
 * field for field, because two different normalisations of the same `replyParams` would be two
 * different gates:
 *   · `comment_id` must equal the request's `commentId` (the reservation throws for a mismatch);
 *   · `comment_uin` must canonicalise to a QQ identity;
 *   · `reply_uin`/`reply_name` are present TOGETHER or absent TOGETHER — a half pair never means
 *     "reply to the thread", it means the caller could not name the recipient;
 *   · a `null`/`undefined` pair is DROPPED (the reservation strips it too), so "reply to the thread"
 *     is spelled by omission, not by a null pair. Without this the same request would be judged
 *     "has a reply target" here and "has no reply target" downstream.
 *
 * @returns `{ok:true, params}` or `{ok:false, reason}` — never throws for caller data.
 */
function snapshotReplyParams(commentId, input) {
  if (input === undefined || input === null) return { ok: false, reason: R.REPLY_IDENTITY_REQUIRED };
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: R.REPLY_IDENTITY_INVALID };
  if (input.comment_id !== commentId) return { ok: false, reason: R.REPLY_IDENTITY_MISMATCH };
  const commentUin = trustedQQ(input.comment_uin);
  if (commentUin === null) return { ok: false, reason: R.REPLY_IDENTITY_INVALID };
  const hasReplyUin = Object.hasOwn(input, 'reply_uin') && input.reply_uin !== undefined && input.reply_uin !== null;
  const hasReplyName = Object.hasOwn(input, 'reply_name') && input.reply_name !== undefined && input.reply_name !== null;
  if (hasReplyUin !== hasReplyName) return { ok: false, reason: R.REPLY_IDENTITY_INVALID };
  if (!hasReplyUin) {
    return { ok: true, params: Object.freeze({ comment_id: commentId, comment_uin: commentUin }) };
  }
  const replyUin = trustedQQ(input.reply_uin);
  if (replyUin === null || typeof input.reply_name !== 'string' || !input.reply_name) {
    return { ok: false, reason: R.REPLY_IDENTITY_INVALID };
  }
  return {
    ok: true,
    params: Object.freeze({
      comment_id: commentId, comment_uin: commentUin, reply_uin: replyUin, reply_name: input.reply_name,
    }),
  };
}

function isPlainRow(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Build the consumer gate over one store.
 *
 * @param store - the SAME handle the reservation will be called with (any object with synchronous
 *   `read()`/`update()`). It must be the same handle: a gate reading a different database than the
 *   one that reserves is a gate over somebody else's evidence. Requiring `update()` (which this
 *   module never calls) is what makes "same handle" checkable — the read-only export handle from
 *   `qzone-store-offline.mjs#openOfflineStoreReadOnly` cannot be the reservation store, so it is
 *   refused here rather than silently gating a database nothing writes to.
 * @param clock - `() => trusted millisecond timestamp`. There is NO `Date.now()` fallback: the age
 *   limit is only as trustworthy as the clock, so the caller must state which clock it means.
 *   A clock that throws or returns a non-integer/non-negative value refuses every `check()`
 *   (`clock-invalid`) instead of crashing the host.
 * @param maxAgeMs - the maximum accepted age of an evidence row, as a non-negative safe integer.
 *   REQUIRED, with no default constant: a default here would be an age limit nobody chose.
 *
 * @throws {TypeError} only for construction errors (missing/!sane dependencies). Data problems
 *   inside `check()` are refusals, never throws — a gate that throws is a gate somebody bypasses.
 */
export function createQzoneReplyEvidenceConsumer({ store, clock, maxAgeMs } = {}) {
  if (!store || typeof store !== 'object' || typeof store.read !== 'function' || typeof store.update !== 'function') {
    throw invalid('a synchronous store with read() and update() is required (the handle that will reserve)');
  }
  if (typeof clock !== 'function') throw invalid('a trusted clock() is required (there is no Date.now fallback)');
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) {
    throw invalid('maxAgeMs must be a non-negative safe integer');
  }

  /** ONE clock read per check, or `null` when the clock cannot be used. */
  function readClock() {
    let value;
    try { value = clock(); } catch { return null; }
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  /**
   * Pre-flight decision for one reply. Pure apart from `store.read()`: no write, no quota, no audit.
   *
   * @param query - `{ target, postId, commentId, replyParams }`, i.e. the request the host is about
   *   to hand to `reserveAuditedOfflineInteraction` (target/postId/commentId are the same three
   *   values; `replyParams` is the object the write path puts on the request).
   * @returns frozen `{ok:true, at, ageMs, maxAgeMs}` or frozen `{ok:false, reason, ...}`.
   * @throws only when `store.read()` throws — a store that cannot be read must not be reported as
   *   "no evidence": a broken store and an empty collection are different facts, and flattening
   *   them would hide corruption behind an ordinary refusal.
   */
  function check(query) {
    if (!query || typeof query !== 'object' || Array.isArray(query)) return refusal(R.INVALID_REQUEST);
    const { target, postId, commentId, replyParams } = query;
    // The same domains the audited path enforces before it reserves: a `target` is a QQ number
    // string (`reserveOfflineInteraction`'s own check), and post/comment ids must be ids the AUDIT
    // formatter accepts, because the reservation requires `record.postId`/`record.commentId` to
    // equal them. A request that cannot become a valid intent is a caller bug, refused for free.
    if (typeof target !== 'string' || !/^\d{1,20}$/.test(target)) return refusal(R.INVALID_REQUEST);
    if (typeof postId !== 'string' || !isSafeQzoneAuditId(postId)) return refusal(R.INVALID_REQUEST);
    if (typeof commentId !== 'string' || !isSafeQzoneAuditId(commentId)) return refusal(R.INVALID_REQUEST);
    const identity = snapshotReplyParams(commentId, replyParams);
    if (identity.ok !== true) return refusal(identity.reason);

    const now = readClock();
    if (now === null) return refusal(R.CLOCK_INVALID);

    const state = store.read();
    const rows = state && typeof state === 'object' ? state.commentEvidence : undefined;
    // Absent is normal (state written before the collection existed) and means EMPTY, exactly like
    // the store's own `readCollection`. Present-but-not-an-array is unreadable state: REFUSED rather
    // than silently treated as empty, because "the collection is corrupt" must not look like
    // "nobody recorded anything" — and because guessing would require a write, which this gate
    // never performs.
    if (rows !== undefined && !Array.isArray(rows)) return refusal(R.EVIDENCE_STORE_UNREADABLE);

    // The identity triple, filtered exactly as the reservation filters it
    // (`qzone-reservation-offline.mjs:217-219`). Non-plain rows are skipped, not matched.
    const candidates = [];
    for (const row of rows ?? []) {
      if (!isPlainRow(row)) continue;
      if (row.target !== target || row.postId !== postId || row.commentId !== commentId) continue;
      candidates.push(row);
    }
    if (candidates.length === 0) return refusal(R.MISSING_EVIDENCE);
    // Two rows for one comment mean the evidence is ambiguous, and picking one would be a guess
    // about WHICH row (and therefore which age) applies. Same rule, same reason string as the
    // reservation.
    if (candidates.length > 1) return refusal(R.EVIDENCE_MISMATCH, { candidates: candidates.length });

    const row = candidates[0];
    const at = row.at;
    // ── AGE, judged before identity ──────────────────────────────────────────────────────────
    // Ordering is deliberate and observable: an EXPIRED row is refused as expired even if its
    // identity also mismatches, because "this evidence is too old to count" is the fact the operator
    // needs, and because the identity check must never be reached by a row whose age is unusable.
    if (at === undefined) return refusal(R.EVIDENCE_UNDATED);
    if (!Number.isSafeInteger(at) || at < 0) {
      return refusal(R.EVIDENCE_INVALID_AT, typeof at === 'number' && Number.isFinite(at) ? { at } : {});
    }
    const ageMs = now - at;
    if (ageMs < 0) return refusal(R.EVIDENCE_FUTURE_DATED, { ageMs });
    // `>` not `>=`: an age of exactly `maxAgeMs` is still inside the window, so the accept range is
    // the closed interval [0, maxAgeMs]. Pinned by a boundary test.
    if (ageMs > maxAgeMs) return refusal(R.EVIDENCE_EXPIRED, { ageMs, maxAgeMs });

    // ── IDENTITY, with the SHARED predicate ──────────────────────────────────────────────────
    // `matchesReplyEvidence` also refuses a row that does not carry `commentUin`/`replyUin`/
    // `replyName` at all (`Object.hasOwn`), so a pre-identity row is a mismatch here rather than
    // "absent means don't care". The reservation applies the same predicate (with the same
    // normalisation) when `replyParams` is supplied, so a pass here reaches the reservation's
    // evidence branch with the same verdict — its OTHER rules (interval/quota/gate) are its own.
    if (!matchesReplyEvidence(row, { params: identity.params })) return refusal(R.EVIDENCE_MISMATCH);

    return Object.freeze({ ok: true, at, ageMs, maxAgeMs });
  }

  return Object.freeze({ check, maxAgeMs });
}
