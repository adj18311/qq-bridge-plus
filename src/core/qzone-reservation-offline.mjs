import { authorizeTool, beijingDay, checkInterval, checkWriteGate, reserveWrite, wasLiked } from './qzone-policy-offline.mjs';
import { formatAuditRecord, isSafeQzoneAuditId } from './qzone-audit-offline.mjs';
// ONE copy of the reply-evidence predicate, shared with `qzone-bound-write-simulation-offline.mjs`.
// Two copies of "does this evidence describe this reply?" would drift silently, and the drift would
// authorise a reply to the wrong person under a matching parent comment.
import { matchesReplyEvidence, trustedQQ } from './qzone-reply-evidence-offline.mjs';

// ══════════════════════════════════════════════════════════════════════════════════════════════
// REPLY-EVIDENCE AGE — judged INSIDE the reservation transaction
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// WHY IT LIVES HERE (the whole reason this block exists)
// -----------------------------------------------------
// `state.commentEvidence` rows carry `at`. Until this change NOTHING on the reserve path read it:
// the gate below matched the identity triple and `matchesReplyEvidence`, and a row stamped a year
// ago authorised a reply exactly like one stamped a minute ago. The module that DID judge `at`,
// `qzone-reply-evidence-consumer-offline.mjs#check`, ran in a SEPARATE `store.read()` transaction
// BEFORE the reservation — so between "fresh" and "spent" the row could be replaced, and no
// separate pre-flight can make "this evidence is still fresh" true OF THIS LAYER.
//
// The check therefore happens in the SAME `store.update` as the quota spend, on the SAME candidate
// row the identity check just accepted, BEFORE `reserveOfflineInteraction` runs. That is the only
// placement where "expired" can prevent the charge rather than merely predict it.
//
// WHY `at` IS NOT "JUST METADATA FOR prune" ANY MORE
// --------------------------------------------------
// `qzone-reply-evidence-store-offline.mjs` still prunes by `at`, but the field now has a second,
// binding meaning: it is the age basis this gate enforces. Anything that writes a row (the producer
// `record()`, or a foreign writer) is writing the number this gate refuses on.
//
// BOUND, AND WHY THERE IS NO DEFAULT-OFF
// --------------------------------------
// An optional expiry is an expiry nobody chose. `DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS` is therefore ON
// for every reply that reaches this function, and `MAX_REPLY_EVIDENCE_MAX_AGE_MS` is a hard ceiling:
// a caller can NARROW the window, never widen it past an hour, and can never spell "no limit" as a
// big integer.
//
// ⚠️ `DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS` / `MAX_REPLY_EVIDENCE_MAX_AGE_MS` have the same names and
// the same values as the constants exported by `qzone-reply-evidence-composition-offline.mjs`
// (`:118`, `:124`). They are duplicated HERE because this module must not import the composition
// (the composition imports THIS module), and they must not drift: one policy, one pair of numbers.
// If either is changed, the other must change with it — and see the CONSISTENCY note below.
//
// CONSISTENCY WITH THE CONSUMER GATE (`qzone-reply-evidence-consumer-offline.mjs#check`, `:94-102`)
// -------------------------------------------------------------------------------------------------
// Same judgement, same reason strings, same closed interval `[0, maxAgeMs]`:
//
//   row state                          this gate / the consumer
//   ----------------------------------  ------------------------
//   `now` not a safe integer >= 0       REFUSE `clock-invalid`
//   `at` absent                         REFUSE `evidence-undated`
//   `at` not a safe integer >= 0        REFUSE `evidence-invalid-at`
//   `at > now`                          REFUSE `evidence-future-dated`
//   `now - at > maxAgeMs`               REFUSE `evidence-expired`
//   `now - at <= maxAgeMs`              continue (identity already checked)
//
// The ACCEPT boundary is identical, and that is the part that must not drift: anything the consumer
// accepts has (a) a usable clock, (b) exactly one matching row, and (c) `at` inside the window, and
// this gate accepts those same inputs. Where the two differ is only WHICH refusal a doubly-broken
// request gets: the consumer reads its clock FIRST (`:302`) and this gate judges the clock where it
// judges age (after the row is located), so "no usable clock AND no matching row" is `clock-invalid`
// there and `missing_comment_evidence` here. Both refuse; neither spends anything. The consumer is
// otherwise the STRICTER one (it also refuses a missing `replyParams`, an unreadable collection and
// non-plain rows), and after this change it is no longer the only place `at` is enforced.
//
// LEGACY ISOLATION (explicit, and NOT part of the B3 chain)
// -------------------------------------------------------
// Callers written before this gate exist pass no age policy at all; they get the enforced default,
// which is the safe direction (a refusal spends nothing). A caller that genuinely cannot supply a
// dated row — an old fixture, a simulation harness — must say so EXPLICITLY with
// `request.enforceEvidenceAge === false`. That opt-out:
//   · only accepts the strict boolean `false` (a truthy string is not a bypass);
//   · is a CONTRACT ERROR (TypeError, nothing reserved) if combined with `request.maxAgeMs`, because
//     "don't check the age" and "check the age with this bound" are contradictory instructions;
//   · is NOT available on the B3 reply chain: `qzone-write-path-offline.mjs` always builds the
//     request from a frozen dispatch and never sets it, so every real reply is age-checked.

// `ledger.reservations` GROWTH — BOUNDED BY NOTHING
// -------------------------------------------------
// `ledger.reservations` keeps ONE entry per reserved id (`reservations[id] = kind`, written by
// `reserveWrite` in `qzone-policy-offline.mjs`) and has NO TTL, NO prune, NO eviction. It is not
// cleared by the daily rollover either: `reserveWrite` resets `used` when the day changes but
// carries `reservations` forward verbatim, so the map only ever grows.
// Measured: 200 distinct reservations -> 200 keys, ~17 B each as JSON.
//
// Its growth is the SAME ORDER as `settled` in `qzone-write-observability-offline.mjs` (also one
// entry per operation, also unbounded) and the same order as `state.audit` (also one row per
// operation). This is not a new class of growth — but it was previously undeclared.
//
// Do NOT add a TTL / prune / eviction as a quick fix. Deleting a reservation entry is not
// housekeeping: `reservations[id]` is the ONLY thing that makes a repeat of the same id return
// `duplicate` instead of writing again. An expired entry therefore means "the same id may be
// replayed once more", i.e. it reopens exactly the replay window this map exists to close — the
// same failure mode as an expired `settled` key reopening G1. Any compaction must first answer
// "what happens when a repeat arrives after the entry is gone", and that answer is a product
// decision (accept one extra send per evicted id, or persist a trusted-install fact to bound it),
// not a cleanup detail. Until that is decided, unbounded is the SAFE direction.
//
// Related: `reservations[id] === kind` is also the bucket-ownership check the release path relies
// on (`qzone-paused-release-offline.mjs`), so the record must survive at least as long as any
// release of that id.

class Denied extends Error {}
const AUDIT_INPUT_FIELDS = ['time', 'source', 'action', 'target', 'postId', 'commentId', 'content', 'result', 'reason', 'quota', 'operator', 'pauseScope'];
// The three fields that make a `state.commentEvidence` row describe the reply's ADDRESSED-TO identity
// (as opposed to the identity triple, which only says WHICH comment). Used to decide whether a caller
// that supplied no identity at all can be corroborated by that row — see the refusal note in
// `reserveAuditedOfflineInteraction`.
const REPLY_IDENTITY_FIELDS = Object.freeze(['commentUin', 'replyUin', 'replyName']);

/**
 * Default maximum accepted age of one `state.commentEvidence` row, ENFORCED by
 * `reserveAuditedOfflineInteraction` for every reply. Ten minutes: long enough for
 * read-comments → bind → record → approve → send (the approval's own TTL is 30 s,
 * `qzone-operation-authorization-offline.mjs:59`) and for the 3-minute comment interval here
 * (`:141`, 180_000 ms) to elapse once, short enough that "this comment exists and its author is X"
 * is still a claim about the current content.
 *
 * SAME NAME AND SAME VALUE as the composition's constant
 * (`qzone-reply-evidence-composition-offline.mjs:118`). Kept in step by hand because this module
 * cannot import the composition (that would be a cycle). See the header block above.
 */
export const DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Hard ceiling for a caller-supplied `request.maxAgeMs`. Above this, the request is a CONTRACT
 * ERROR (`TypeError`, nothing reserved), so "effectively unbounded" cannot be spelled as a large
 * integer. SAME NAME AND SAME VALUE as `qzone-reply-evidence-composition-offline.mjs:124`.
 */
export const MAX_REPLY_EVIDENCE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Resolve the age policy for ONE audited reply, OUTSIDE the transaction (the values compared
 * inside must be the values validated here — never a caller-owned property re-read mid-update).
 *
 * Accepts:
 *   · `request.maxAgeMs` absent  → `DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS`;
 *   · `request.maxAgeMs` present → a non-negative safe integer `<= MAX_REPLY_EVIDENCE_MAX_AGE_MS`;
 *   · `request.enforceEvidenceAge === false` → `{ enforce:false }`. LEGACY ISOLATION ONLY: this is
 *     the explicit, whitelisted path for callers (old fixtures, simulations) that cannot supply a
 *     dated row. It is NOT reachable from the B3 reply chain, which never sets the field.
 *
 * @throws {TypeError} for a value outside the domain, and for the contradictory combination
 *   "don't enforce" + "enforce with this bound". Both are caller bugs caught BEFORE the store is
 *   touched, so neither can reserve anything.
 */
function snapshotEvidenceAgePolicy(request) {
  const rawEnforce = request?.enforceEvidenceAge;
  if (rawEnforce !== undefined && rawEnforce !== false) {
    // Only the strict literal `false` is an opt-out. `0`, `''`, `'false'` and `null` are NOT.
    throw new TypeError('invalid evidence age policy');
  }
  const enforce = rawEnforce !== false;
  const rawMaxAge = request?.maxAgeMs;
  if (rawMaxAge !== undefined) {
    // `null` is NOT "absent": it is a value outside the domain, and silently treating it as the
    // default would let a caller who meant "no bound" get the default while believing otherwise.
    if (!Number.isSafeInteger(rawMaxAge) || rawMaxAge < 0 || rawMaxAge > MAX_REPLY_EVIDENCE_MAX_AGE_MS) {
      throw new TypeError('invalid evidence maxAgeMs');
    }
    if (!enforce) throw new TypeError('invalid evidence age policy');
    return Object.freeze({ enforce: true, maxAgeMs: rawMaxAge });
  }
  return Object.freeze({ enforce, maxAgeMs: DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS });
}

function snapshotAuditInput(input) {
  if (!input || typeof input !== 'object') return input;
  const snapshot = {};
  for (const field of AUDIT_INPUT_FIELDS) snapshot[field] = input[field];
  return snapshot;
}

function snapshotRequest(request, fields) {
  if (!request || (typeof request !== 'object' && typeof request !== 'function')) return request;
  const snapshot = {};
  for (const field of fields) snapshot[field] = request[field];
  return snapshot;
}

// Store the already validated immutable projection; never revisit caller-owned
// properties inside the reservation transaction.
function appendFormattedIntent(store, id, record) {
  if (!store || typeof store.update !== 'function' || !isSafeQzoneAuditId(id)) throw new TypeError('invalid audit id');
  let appended = false;
  store.update((state) => {
    if (!Array.isArray(state.audit)) throw new TypeError('invalid audit state');
    const previous = state.audit.find((entry) => entry.id === id);
    if (previous) {
      if (JSON.stringify(previous.record) !== JSON.stringify(record)) throw new Error('conflicting audit id');
      return state;
    }
    appended = true;
    return { ...state, audit: [...state.audit, { id, record }] };
  });
  return { appended };
}

// Offline experiment: this only reserves a post; it never calls a platform.
// The clock and stored configuration must originate from trusted runtime code.
export function reserveOfflinePost(store, request) {
  if (!store || typeof store.update !== 'function' || !request || !Number.isFinite(request.now)) throw new TypeError('invalid request');
  try {
    store.update((state) => {
      // H3 write gate FIRST. This is the deeper of the two gate points (the write path has its own,
      // so that an entry which never reaches `reserveOffline*` still refuses for free): here it is the
      // floor, and it also covers direct callers of this function that bypass the facade entirely.
      // A refusal throws `Denied`, which the `catch` below turns into `{allowed:false, reason}` — the
      // same shape every other refusal uses, so no caller needs a new branch.
      const health = checkWriteGate(state, { action: 'publish', now: request.now });
      if (health?.allowed !== true) throw new Denied(health?.reason ?? 'write-gate-refused');
      const gate = authorizeTool(state, 'publish');
      if (!gate.allowed) throw new Denied(gate.reason);
      if (!checkInterval(state.lastPostAt, request.now, 7200000)) throw new Denied('interval');
      const reservation = reserveWrite(state.ledger, { day: beijingDay(request.now), kind: 'post', limit: state.limits?.post, id: request.id });
      if (!reservation.allowed) throw new Denied(reservation.reason);
      return { ...state, ledger: reservation.state, lastPostAt: request.now };
    });
    return { allowed: true };
  } catch (error) {
    if (error instanceof Denied) return { allowed: false, reason: error.message };
    throw error;
  }
}

// Offline-only: persist a conservative unknown intent atomically with the
// reservation. No platform request is sent by this function.
export function reserveAuditedOfflinePost(store, request, input) {
  const boundRequest = snapshotRequest(request, ['id', 'now']);
  const record = formatAuditRecord(snapshotAuditInput(input));
  // Masked bodies cannot yet be safely bound to the same trusted request used for dispatch.
  // Keep sensitive writes fail-closed until that binding exists.
  if (!boundRequest || record.time !== boundRequest.now || record.action !== 'publish' || record.result !== 'unknown' || record.reason !== '' || record.redacted) throw new TypeError('invalid intent');
  let result;
  store.update((state) => {
    if (typeof state.selfId !== 'string' || !/^\d{1,20}$/.test(state.selfId) || record.target !== state.selfId) throw new TypeError('invalid account identity');
    let next = state;
    const transaction = { update(fn) { next = fn(next); } };
    result = reserveOfflinePost(transaction, boundRequest);
    if (!result.allowed) return state;
    if (!appendFormattedIntent(transaction, `intent_${boundRequest.id}`, record).appended) throw new Error('duplicate intent');
    return next;
  });
  return result;
}

export function reserveOfflineInteraction(store, request) {
  if (!store || typeof store.update !== 'function' || !request || !Number.isFinite(request.now) ||
      !['comment', 'reply', 'like'].includes(request.tool) || typeof request.target !== 'string' || !/^\d{1,20}$/.test(request.target) ||
      typeof request.postId !== 'string' || !request.postId) throw new TypeError('invalid request');
  try {
    store.update((state) => {
      // H3 write gate FIRST — see the note in `reserveOfflinePost`. `request.tool` is the action so a
      // future per-action gate can scope this without touching the call sites.
      const health = checkWriteGate(state, { action: request.tool, now: request.now });
      if (health?.allowed !== true) throw new Denied(health?.reason ?? 'write-gate-refused');
      const gate = authorizeTool(state, request.tool);
      if (!gate.allowed) throw new Denied(gate.reason);
      const kind = request.tool === 'like' ? 'like' : 'comment';
      if (!Array.isArray(state.commentTargets) || state.commentTargets.some((x) => !x || typeof x.target !== 'string' || !Number.isFinite(x.time))) throw new TypeError('invalid comment state');
      if (kind === 'like' && wasLiked(state.likes, request.target, request.postId)) throw new Denied('duplicate_like');
      if (state.lastCommentAt != null && !Number.isFinite(state.lastCommentAt)) throw new TypeError('invalid comment state');
      // Legacy state stored per-target times. Retain the latest of those and
      // the global timestamp, so migrating or resetting quota cannot bypass it.
      let previous = state.lastCommentAt ?? null;
      for (const item of state.commentTargets) previous = previous === null ? item.time : Math.max(previous, item.time);
      if (kind === 'comment' && !checkInterval(previous, request.now, 180000)) throw new Denied('interval');
      const reservation = reserveWrite(state.ledger, { day: beijingDay(request.now), kind, limit: state.limits?.[kind], id: request.id });
      if (!reservation.allowed) throw new Denied(reservation.reason);
      const next = { ...state, ledger: reservation.state };
      if (kind === 'like') next.likes = [...state.likes, { author: request.target, id: request.postId }];
      else {
        next.lastCommentAt = request.now;
        next.commentTargets = [...state.commentTargets.filter((x) => x.target !== request.target), { target: request.target, time: request.now }];
      }
      return next;
    });
    return { allowed: true };
  } catch (error) {
    if (error instanceof Denied) return { allowed: false, reason: error.message };
    throw error;
  }
}

// ── replyParams: the FULL reply identity, in `buildQzoneOnebotWriteRequest`'s param shape ──────
//
// WHY A SECOND OBJECT AND NOT MORE FIELDS ON `request`: `request` is already snapshotted field by
// field above, and adding `commentUin`/`replyUin`/`replyName` to it would widen the shape every
// existing caller (and the bound-write simulation) has to satisfy. `replyParams` is OPTIONAL, so
// callers written before the identity existed keep working — but omission is NOT full verification
// (see the refusal note in `reserveAuditedOfflineInteraction`: a row that carries any identity field
// is refused against a caller that named none, and the facade ALWAYS supplies the identity).
//
// The result is a FROZEN object of primitives built from a closed field list, so the values compared
// inside the transaction are the values validated here. Invalid shapes throw `invalid intent` BEFORE
// the store is touched: a half-validated reply identity is not something to reserve against.
function snapshotReplyParams(boundRequest, input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid intent');
  const commentId = input.comment_id;
  const commentUin = trustedQQ(input.comment_uin);
  const hasReplyUin = Object.hasOwn(input, 'reply_uin') && input.reply_uin !== undefined && input.reply_uin !== null;
  const hasReplyName = Object.hasOwn(input, 'reply_name') && input.reply_name !== undefined && input.reply_name !== null;
  // The builder's own pair rule (`qzone-onebot-write-contract.mjs:107`): a half target is refused,
  // never defaulted, because a default would name a recipient the caller never approved.
  if (hasReplyUin !== hasReplyName) throw new TypeError('invalid intent');
  if (commentId !== boundRequest.commentId) throw new TypeError('invalid intent');
  if (commentUin === null) throw new TypeError('invalid intent');
  if (!hasReplyUin) {
    return Object.freeze({ comment_id: commentId, comment_uin: commentUin });
  }
  const replyUin = trustedQQ(input.reply_uin);
  if (replyUin === null || typeof input.reply_name !== 'string' || !input.reply_name) {
    throw new TypeError('invalid intent');
  }
  return Object.freeze({
    comment_id: commentId, comment_uin: commentUin, reply_uin: replyUin, reply_name: input.reply_name,
  });
}

export function reserveAuditedOfflineInteraction(store, request, input) {
  const boundRequest = snapshotRequest(request, ['id', 'now', 'tool', 'target', 'postId', 'source', 'commentId', 'maxAgeMs', 'enforceEvidenceAge']);
  const record = formatAuditRecord(snapshotAuditInput(input));
  if (!boundRequest || record.time !== boundRequest.now || record.action !== boundRequest.tool || record.target !== boundRequest.target ||
      !['qq', 'patrol'].includes(boundRequest.source) || record.source !== boundRequest.source ||
      record.postId !== boundRequest.postId || record.result !== 'unknown' || record.reason !== '' || record.redacted ||
      (boundRequest.tool === 'reply' ? (typeof boundRequest.commentId !== 'string' || !boundRequest.commentId || record.commentId !== boundRequest.commentId)
        : (boundRequest.commentId != null || record.commentId != null))) throw new TypeError('invalid intent');
  // The optional FULL reply identity, snapshotted OUTSIDE the transaction (like every other field
  // here) so a caller cannot swap it between the check and the reserve.
  const boundReplyParams = snapshotReplyParams(boundRequest, request?.replyParams);
  // The evidence-age policy, also snapshotted OUTSIDE the transaction. A `maxAgeMs` (or an opt-out
  // flag) read inside the update would be a caller-owned number consulted at commit time.
  const agePolicy = boundRequest.tool === 'reply'
    ? snapshotEvidenceAgePolicy(boundRequest)
    : Object.freeze({ enforce: false, maxAgeMs: DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS });
  let result;
  store.update((state) => {
    // Evidence must have been inserted by a trusted, authorized read/event
    // handler; a model-supplied evidence list would defeat this check.
    //
    // ⚠️ PRODUCER STATUS (updated — the older text here said "no producer was found", which is now
    // OUT OF DATE, not merely cautious). Within the checked scope (this repository's `src/`) there
    // IS exactly one producer: `qzone-live-friend-read.mjs`'s own-new-comment success path calls
    // `qzone-reply-evidence-store-offline.mjs#record` after the read, the post-I/O proof/epoch
    // recheck, the synchronous `current()` recheck, the projection filter, the lease close and the
    // post-lease policy recheck (`scripts/test-qzone-live-friend-read-evidence.mjs` LFR-EV-1..11,
    // and LFR-EV-10 pins it as the ONLY importer). What that producer covers is NARROW:
    //   · only `scope.kind === 'own-new-comment'` (one host-verified comment, one authorization);
    //   · `read_posts` (friend / admin / shared / own-history) has no comment identity at all, and
    //     every other `read_comments` scope kind is refused before dispatch;
    //   · the producer itself has NO production caller yet (nothing in `src/` constructs the reader
    //     in a non-test composition), so in the current wiring no row is written at runtime.
    // Consequence, stated without absolutes: a row CAN now come from a trusted path, but it need not,
    // and in the present composition it does not. When no corroborating row exists this gate refuses
    // the reply — FAIL CLOSED by absence. A PRESENT row is "shape and age agree", not "the platform
    // was consulted and proven": rows are still frozen plain objects any in-process writer can mint
    // (see the evidence store's own header), and every test that seeds one says so.
    if (boundRequest.tool === 'reply') {
      const candidates = (Array.isArray(state.commentEvidence) ? state.commentEvidence : [])
        .filter((item) => item && item.target === boundRequest.target &&
          item.postId === boundRequest.postId && item.commentId === boundRequest.commentId);
      if (!candidates.length) {
        result = { allowed: false, reason: 'missing_comment_evidence' };   // no reserve, no cooldown
        return state;
      }
      // FULL match, not just the identity triple: the parent comment's author, and — when the reply
      // targets a person — that person's id and display name. Exactly one candidate is required:
      // two rows for one comment mean the evidence is ambiguous, and picking one would be a guess
      // about WHO the reply is addressed to.
      //
      // BACKWARD COMPATIBILITY, TIGHTENED: without `replyParams` this module cannot compare the
      // addressed-to identity at all. It therefore accepts a candidate ONLY when that row carries
      // NONE of the identity fields — the pre-identity `{target, postId, commentId}` shape that
      // already existed when this collection was introduced. A row that DOES carry identity fields
      // (say `replyUin`/`replyName` but no `commentUin`, or a `commentUin` naming a different author)
      // is REFUSED against a caller that supplied no identity: the caller is asking for a reply whose
      // addressed-to identity it never stated, which is exactly the degradation this gate exists to
      // prevent. Callers that omit `replyParams` must not be described as "fully verified";
      // `qzone-write-path-offline.mjs` ALWAYS passes it (its reply branch supplies the identity it
      // froze on the dispatch), so the facade can never take this lenient path.
      if (candidates.length !== 1 ||
          (boundReplyParams !== null
            ? !matchesReplyEvidence(candidates[0], { params: boundReplyParams })
            : REPLY_IDENTITY_FIELDS.some((field) => Object.hasOwn(candidates[0], field)))) {
        result = { allowed: false, reason: 'comment_evidence_mismatch' };  // no reserve, no cooldown
        return state;
      }
      // ── AGE: same transaction, same row, BEFORE any quota is spent ─────────────────────────
      // The candidate the identity check just accepted is the row judged here. `boundRequest.now`
      // is the trusted caller clock (the SAME instant the audit `time`, the quota day and the
      // 3-minute interval use), never `Date.now()`. The order and the reason strings match
      // `qzone-reply-evidence-consumer-offline.mjs#check` (`:94-102`) exactly, so the two can never
      // disagree about the same row. See the header block for why nothing may re-enter another
      // transaction for this.
      if (agePolicy.enforce) {
        const row = candidates[0];
        const now = boundRequest.now;
        // `request.now` is validated as finite by `reserveOfflineInteraction`, but the age rule
        // needs a safe non-negative integer: a float/negative clock would make `now - at` a
        // measurement of nothing. Refused before the row is even dated.
        if (!Number.isSafeInteger(now) || now < 0) {
          result = { allowed: false, reason: 'clock-invalid' };            // no reserve, no cooldown
          return state;
        }
        // `=== undefined`, exactly like the consumer (`:334`), not `Object.hasOwn`: a row whose `at`
        // is explicitly `undefined` is undatable, and the two reasons must agree. (A JSON round-trip
        // drops the property anyway, so `absent` and `undefined` are the same fact in the store.)
        if (row.at === undefined) {
          result = { allowed: false, reason: 'evidence-undated' };         // no reserve, no cooldown
          return state;
        }
        if (!Number.isSafeInteger(row.at) || row.at < 0) {
          result = { allowed: false, reason: 'evidence-invalid-at' };      // no reserve, no cooldown
          return state;
        }
        // Future-dated is REFUSED, not clamped: a negative age means the clocks disagree (or the
        // row was stamped to outlive its window), so the age is not measurable.
        if (row.at > now) {
          result = { allowed: false, reason: 'evidence-future-dated' };    // no reserve, no cooldown
          return state;
        }
        // `>` not `>=`: an age of exactly `maxAgeMs` is still inside the window (closed [0, max]).
        if (now - row.at > agePolicy.maxAgeMs) {
          result = { allowed: false, reason: 'evidence-expired' };         // no reserve, no cooldown
          return state;
        }
      }
    }
    let next = state;
    const transaction = { update(fn) { next = fn(next); } };
    result = reserveOfflineInteraction(transaction, boundRequest);
    if (!result.allowed) return state;
    if (!appendFormattedIntent(transaction, `intent_${boundRequest.id}`, record).appended) throw new Error('duplicate intent');
    return next;
  });
  return result;
}
