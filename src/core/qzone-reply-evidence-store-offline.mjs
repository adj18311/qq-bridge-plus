// A TRUSTED PRODUCER for `state.commentEvidence` — the collection the reply gate consumes.
//
// WHY THIS FILE EXISTS
// --------------------
// `qzone-reservation-offline.mjs` refuses every reply unless `state.commentEvidence` holds exactly
// one row for the request's (target, postId, commentId) whose `commentUin` and `replyUin`/`replyName`
// agree with the approved reply identity (`matchesReplyEvidence`) AND whose `at` is a readable,
// non-future timestamp no older than the request's bounded `maxAgeMs`. Its own header used to say, in
// capitals, that no producer of that collection was found within the checked scope; THAT IS NO LONGER
// TRUE and this module is the reason. It is the single producer (`qzone-live-friend-read.mjs` is its
// only `src/` importer — pinned by `scripts/test-qzone-live-friend-read-evidence.mjs` LFR-EV-10), and
// its rows carry the `at` the reserve-side age gate enforces. Two consequences worth stating plainly:
//   · a row is now BOTH "which comment/author" and "how fresh": `at` is no longer metadata for `prune`
//     alone, so a caller that writes this collection by hand is writing the number replies are judged
//     on;
//   · the producer still has no production caller and only covers `own-new-comment`, so in the current
//     composition the collection is empty and every reply is refused `missing_comment_evidence`.
//
// The gate was complete; the WRITER was missing. This module is that writer — nothing more, and
// nothing less.
//
// WHAT IT IS NOT (read this before trusting a row)
// ------------------------------------------------
//   · **NOT proof of provenance.** `record()` demands the caller hand over the output of a trusted
//     projection (`bindAuthorizedQzoneReply`, `bindAuthorizedOwnNewQzoneComment`,
//     `bindAuthorizedOwnNewQzoneReply`) rather than a bare `{target, postId, commentId, ...}`. But
//     those functions return a plain `Object.freeze`d object, so anyone able to write JavaScript in
//     this process can build an object of the same shape and freeze it. The freeze check and the
//     exact-field-set check therefore reject **shape errors** — a hand-assembled evidence row, a
//     half-validated copy, an unfrozen spread, a class instance — they do NOT reject a determined
//     forger. A module-private mint (WeakSet, as `qzone-trusted-binding.mjs` does) is impossible
//     here WITHOUT changing `qzone-comment-binding-offline.mjs`, which this change deliberately does
//     not touch. That limitation is stated, not papered over.
//   · **NOT a bypass.** Nothing in this module can authorise a reply on its own: it only writes rows
//     that the EXISTING gate then re-checks in full. A row whose identity does not match still
//     produces `missing_comment_evidence` / `comment_evidence_mismatch` and costs nothing.
//   · **NOT audit.** No `state.audit` row is written, no quota unit is reserved, no clock is read.
//
// WHO CALLS IT (exactly one caller under `src/`, and why that placement matters)
// -----------------------------------------------------------------------------
// `qzone-live-friend-read.mjs` is the ONLY importer in `src/` (pinned by
// `scripts/test-qzone-live-friend-read-evidence.mjs` LFR-EV-10). It records ONE row on the
// `read_comments` success path, from `bindAuthorizedOwnNewQzoneComment`, and only after the read,
// the post-I/O proof/epoch recheck, the synchronous `current()` recheck, the projection filter, the
// `finishScope` lease close AND the post-lease policy/audit recheck have ALL succeeded. Therefore:
//
//   · **Only `scope.kind === 'own-new-comment'` produces evidence.** It is the one branch carrying a
//     host-verified `event` (isNew / selfId === botQq / author / postId / commentId agreement) PLUS
//     an authorization limited to a single comment. `read_posts` (friend / admin / shared /
//     own-history) has no comment identity at all, and every other `read_comments` scope kind is
//     refused before dispatch, so neither can reach this module. If a plain comment-page read is
//     ever added it must NOT be allowed to call `record()`: without a trusted event and one named
//     comment there is no honest projection to write.
//   · A row is written only for a SUCCESSFUL read; a failed read writes nothing. Absence of a row can
//     only make a reply be REFUSED — never authorised.
//   · It writes through the handle it was constructed with, NOT a store of its own. A producer built
//     over a different handle than the reservation layer uses would write rows the gate never sees;
//     `qzone-live-friend-read.mjs` passes its own `store` for exactly that reason.
//
// ── MAPPING: trusted projection -> `state.commentEvidence` row ──────────────────────────────
// Verified by reading `qzone-comment-binding-offline.mjs:115-123` (the `bind()` return) and the
// consumer at `qzone-reservation-offline.mjs:217-242`:
//
//   row.target     <= targetQq        the post OWNER the reply is sent as (the gate's `request.target`)
//   row.postId     <= postId          `data.tid`, already proven === `target.id` by the binding
//   row.commentId  <= parentCommentId the PARENT comment id — the gate filters on this
//   row.commentUin <= parentQq        the parent comment's AUTHOR (the identity the gate re-checks)
//   row.replyUin   <= replyQq         who the reply is addressed to, or null for "the thread"
//   row.replyName  <= replyName       display name of that person, or null (pair rule: both null)
//   row.at         <= the caller's trusted `now` (metadata for `prune`; not part of any key)
//
// `replyCommentId` (the bot's OWN reply id) is deliberately NOT stored: the gate never reads it, and
// a stored field nobody checks is a field that invites a false impression of verification.
//
// SECOND ACCEPTED VARIANT — the first-level projection
// ---------------------------------------------------
// `bindAuthorizedOwnNewQzoneComment` returns `{targetQq, postId, commentId, commentQq, commentName}`
// (`:224-230`), i.e. a comment rather than a reply. It maps to the SAME row with the reply pair
// forced to `null` (a first-level comment addresses the thread, not a person), and `commentName` is
// not stored for the same "nobody reads it" reason. Both variants are closed field sets; a projection
// that is neither is refused rather than partially mapped.

import { isSafeQzoneAuditId } from './qzone-audit-offline.mjs';
import { trustedQQ } from './qzone-reply-evidence-offline.mjs';

/**
 * Default hard cap on the number of stored rows. See the `SIZE` section of `record`'s note below:
 * eviction is by INSERTION ORDER and can only ever REFUSE a reply, never authorise one.
 */
export const MAX_REPLY_EVIDENCE_ENTRIES = 1000;

/** Reply-shaped projection: `bindAuthorizedQzoneReply` / `bindAuthorizedOwnNewQzoneReply`. */
const REPLY_PROJECTION_FIELDS = Object.freeze([
  'parentCommentId', 'parentQq', 'postId', 'replyCommentId', 'replyName', 'replyQq', 'targetQq',
]);
/** Comment-shaped projection: `bindAuthorizedOwnNewQzoneComment`. */
const COMMENT_PROJECTION_FIELDS = Object.freeze([
  'commentId', 'commentName', 'commentQq', 'postId', 'targetQq',
]);

// The largest reply display name this module will store. The consumer compares `replyName` for EXACT
// equality against `params.reply_name` (which the write contract caps at 100000 chars), so any cap
// here is stricter than the consumer's: a longer name is refused, which makes that reply always
// refused with `missing_comment_evidence` — FAIL CLOSED, never a wrong-name match.
const MAX_REPLY_NAME_LENGTH = 256;
// `state.audit`'s `target` rule (`qzone-audit-offline.mjs:46`); QQ ids are ~10 digits, so 20 is a
// generous ceiling that still refuses a pasted blob. `trustedQQ` already refuses anything above
// Number.MAX_SAFE_INTEGER, so this is defence in depth rather than the only bound.
const MAX_QQ_DIGITS = 20;

function invalid(message = 'invalid reply evidence projection') {
  return new TypeError(message);
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

// Reads an own DATA property. A getter is refused rather than invoked: the values written here must
// be the values that were frozen on the projection, not whatever an accessor decides at write time.
function ownValue(value, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid(`${label}: "${key}" must be a data property`);
  return descriptor.value;
}

function qqField(value, label, { optional = false } = {}) {
  if (optional && value === null) return null;
  const canonical = trustedQQ(value);
  if (canonical === null || canonical.length > MAX_QQ_DIGITS) throw invalid(`${label}: not a QQ identity`);
  return canonical;
}

function idField(value, label) {
  // Reused from the AUDIT rule on purpose: the same postId/commentId travels into the intent audit
  // row, and one id rule for both means a row cannot be recorded for a comment the audit layer
  // would refuse.
  if (!isSafeQzoneAuditId(value)) throw invalid(`${label}: not a safe id`);
  return value;
}

function replyNameField(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${label}: must be a non-empty string`);
  if (value.length > MAX_REPLY_NAME_LENGTH) throw invalid(`${label}: longer than ${MAX_REPLY_NAME_LENGTH} characters`);
  // Control characters cannot be compared for equality meaningfully and would corrupt an operator's
  // view of the row; the binding's own `text()` already refuses an empty/whitespace string.
  if (/[\u0000-\u001f\u007f]/.test(value)) throw invalid(`${label}: contains control characters`);
  return value;
}

/**
 * Validate one trusted projection and return the six evidence fields (target, postId, commentId,
 * commentUin, replyUin, replyName) — nothing else, from a closed allowlist.
 *
 * Enforced (and this is the WHOLE guarantee): object, plain prototype, FROZEN, exactly one of the two
 * closed field sets, no accessors, every field in its documented domain, and the reply pair present
 * or absent TOGETHER. NOT enforced (impossible here): that the caller really obtained the object from
 * a binding — see the module header.
 *
 * @throws {TypeError} for any shape/domain violation. Nothing is written when it throws.
 */
function snapshotProjection(input, now) {
  if (!Number.isSafeInteger(now) || now < 0) throw invalid('a trusted non-negative integer `now` is required');
  if (!isPlainRecord(input)) throw invalid();
  // A frozen projection is the strongest provenance signal available in this process: a binding's
  // output is frozen, and an unfrozen copy/spread is exactly the "hand-assembled row" shape this
  // module must not accept.
  if (!Object.isFrozen(input)) throw invalid('projection must be frozen (pass the binding\'s return value, not a copy)');

  const keys = Object.keys(input).sort();
  const isReply = keys.length === REPLY_PROJECTION_FIELDS.length
    && keys.every((key, index) => key === REPLY_PROJECTION_FIELDS[index]);
  const isComment = keys.length === COMMENT_PROJECTION_FIELDS.length
    && keys.every((key, index) => key === COMMENT_PROJECTION_FIELDS[index]);
  if (!isReply && !isComment) {
    throw invalid('expected the exact field set of bindAuthorizedQzoneReply / '
      + 'bindAuthorizedOwnNewQzoneComment (a bare evidence row or an extended copy is refused)');
  }

  const target = qqField(ownValue(input, 'targetQq', 'projection'), 'targetQq');
  const postId = idField(ownValue(input, 'postId', 'projection'), 'postId');

  if (isComment) {
    return Object.freeze({
      target,
      postId,
      commentId: idField(ownValue(input, 'commentId', 'projection'), 'commentId'),
      commentUin: qqField(ownValue(input, 'commentQq', 'projection'), 'commentQq'),
      // A first-level comment addresses the thread, never a person: the pair is null/null.
      replyUin: null,
      replyName: null,
    });
  }

  const commentId = idField(ownValue(input, 'parentCommentId', 'projection'), 'parentCommentId');
  const commentUin = qqField(ownValue(input, 'parentQq', 'projection'), 'parentQq');
  const replyCommentId = idField(ownValue(input, 'replyCommentId', 'projection'), 'replyCommentId');
  if (replyCommentId === commentId) throw invalid('replyCommentId must differ from parentCommentId');
  const rawReplyQq = ownValue(input, 'replyQq', 'projection');
  const rawReplyName = ownValue(input, 'replyName', 'projection');
  // THE PAIR RULE. `bind()` always returns both; a half pair can only come from a hand-built object,
  // and defaulting either half would name a recipient the caller never proved. Same rule the write
  // contract applies (`qzone-onebot-write-contract.mjs:107`).
  if ((rawReplyQq === null) !== (rawReplyName === null)) {
    throw invalid('replyQq and replyName must be null together or non-null together');
  }
  if (rawReplyQq === null) {
    return Object.freeze({ target, postId, commentId, commentUin, replyUin: null, replyName: null });
  }
  return Object.freeze({
    target,
    postId,
    commentId,
    commentUin,
    replyUin: qqField(rawReplyQq, 'replyQq'),
    replyName: replyNameField(rawReplyName, 'replyName'),
  });
}

const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function keyOf(row) {
  return `${row.target}\u0000${row.postId}\u0000${row.commentId}`;
}

function assertStore(store) {
  if (!store || typeof store !== 'object' || typeof store.update !== 'function' || typeof store.read !== 'function') {
    throw invalid('a synchronous store with update() and read() is required');
  }
}

function readCollection(state) {
  const rows = state.commentEvidence;
  // Absent is normal (every state written before the collection existed lacks it) and means EMPTY.
  // Present-but-not-an-array is unreadable state, and an unreadable collection must not be silently
  // replaced by a fresh one: that would delete whatever was there.
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) throw invalid('state.commentEvidence is not an array');
  return rows;
}

/**
 * Build the producer over one store.
 *
 * @param store - the SAME store handle the reservation layer uses (any object with synchronous
 *   `read()`/`update()`, i.e. `openOfflineStore`). Writing anywhere else would produce rows the gate
 *   never sees.
 * @param maxEntries - optional cap on stored rows (`MAX_REPLY_EVIDENCE_ENTRIES` by default).
 */
export function createQzoneReplyEvidenceStore({ store, maxEntries = MAX_REPLY_EVIDENCE_ENTRIES } = {}) {
  assertStore(store);
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100000) {
    throw invalid('maxEntries must be a safe integer between 1 and 100000');
  }

  /**
   * Write ONE evidence row derived from a trusted projection.
   *
   * Everything — "does a row for this comment already exist?" AND the append AND the cap eviction —
   * happens inside ONE `store.update`, so two writers cannot both observe "absent" and then both
   * append. (In-process that is also serialised by the store's `BEGIN IMMEDIATE`; the single
   * `update` is what makes the check-then-write atomic for every caller of this handle.)
   *
   * Idempotent on (target, postId, commentId): an identical row is reported as
   * `{written:false, duplicate:true}`; the SAME key with DIFFERENT identity fields is a CONFLICT and
   * throws (`EVIDENCE_KEY_CONFLICT`) instead of overwriting. Overwriting would let a later caller
   * silently re-address an approved reply; refusing keeps the first row, which is the one an approval
   * was based on.
   *
   * A DUPLICATE IS NOT ALWAYS A NO-OP — `at` MAY MOVE FORWARD. The row's identity is immutable, but
   * `at` is a DERIVED age basis, and a genuine re-read of the same comment is exactly what should
   * renew it; otherwise the row ages past the enforcement window and the reply gate refuses that
   * comment forever even though it is being read again. So a duplicate with a STRICTLY LATER trusted
   * `now` rewrites `at` and reports `{duplicate:true, refreshed:true}`. An equal or earlier `now`
   * leaves the row untouched (`refreshed:false`): a backwards clock must never extend a row's life.
   *
   * SIZE: over `maxEntries` the OLDEST INSERTED row is dropped (front of the array). Eviction is by
   * INSERTION ORDER, not by the stored `at`: `at` comes from the caller, and letting a caller-chosen
   * value decide what survives would let one caller evict another's rows. Dropping a row can only
   * ever REFUSE a later reply (fail closed, zero cost) — it can never authorise one, because the gate
   * requires a matching row to be PRESENT.
   *
   * @param projection - the return value of a `bindAuthorized*` function (see the header).
   * @param options.now - trusted clock; it stamps a NEW row's `at` and is the ONLY value that may move
   *   an existing row's `at` forward. Required (`prune` uses it too): a row written without a
   *   trustworthy clock could not be dated, and the reserve-side age gate refuses an undated row.
   * @returns `Object.freeze({ written, duplicate, refreshed, evicted })`.
   * @throws {TypeError} for a shape/domain violation OR a key conflict — in both cases nothing is written.
   */
  function record(projection, options) {
    const now = options && typeof options === 'object' ? options.now : undefined;
    // Validate BEFORE the store is touched: a half-validated projection must not hold a transaction.
    // (`snapshotProjection` also refuses a missing/unusable `now`, which matters more now than it did:
    // the row's `at` comes from it, and the reserve-side age gate refuses an UNDATED row outright.)
    const fields = snapshotProjection(projection, now);
    const key = keyOf(fields);
    let written = false;
    let duplicate = false;
    let refreshed = false;
    let evicted = 0;

    store.update((state) => {
      const current = readCollection(state);
      // Check + write in ONE transaction (see the note above).
      for (const row of current) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;   // unreadable: not a match
        if (keyOf(row) !== key) continue;
        const { at: present, ...existing } = row;
        if (!sameValue(existing, fields)) {
          const conflict = new TypeError('conflicting reply evidence for the same comment '
            + '(target/postId/commentId already recorded with a different identity)');
          conflict.code = 'EVIDENCE_KEY_CONFLICT';
          throw conflict;
        }
        duplicate = true;
        // ── A REAL re-read REFRESHES THE AGE BASIS (never the identity) ─────────────────────
        // Without this, a row whose `at` has aged past the enforcement window stays expired
        // FOREVER: every later genuine read of the SAME comment returns "duplicate" and leaves the
        // stale stamp in place, so the reply gate keeps refusing until somebody calls `prune`
        // explicitly. Refreshing the derived `at` is what makes a re-read mean something.
        //
        // CLOCK DIRECTION IS ONE-WAY, and this is the part that must not be "helpful": only a
        // STRICTLY LATER trusted `now` may move `at` forward. An equal stamp changes nothing, and an
        // EARLIER one is refused rather than applied — a backwards clock (or a caller replaying an
        // old `now`) must never extend a row's life, because that would be a way to keep evidence
        // alive without a fresh read. `refreshed` is reported separately from `duplicate` so a caller
        // can tell "already present, nothing changed" from "already present, age extended".
        //
        // Only `at` is written. Every identity field stays byte-identical to the row an approval was
        // based on; the conflict branch above has already refused any disagreement.
        if (Number.isSafeInteger(present) && now > present) {
          refreshed = true;
          const index = current.indexOf(row);
          const next = current.slice();
          next[index] = { ...row, at: now };
          return { ...state, commentEvidence: next };
        }
        return state;
      }

      let next = [...current, { ...fields, at: now }];
      if (next.length > maxEntries) {
        evicted = next.length - maxEntries;
        next = next.slice(evicted);
      }
      written = true;
      return { ...state, commentEvidence: next };
    });

    return Object.freeze({ written, duplicate, refreshed, evicted });
  }

  /**
   * Read-only view of the stored rows (deep copies, frozen). Deliberately a THIN filter over the
   * committed collection: no ordering guarantees, no synthesised rows.
   */
  function list(filter) {
    const rows = readCollection(store.read());
    const query = filter && typeof filter === 'object' ? filter : {};
    const result = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      if (query.target !== undefined && row.target !== query.target) continue;
      if (query.postId !== undefined && row.postId !== query.postId) continue;
      if (query.commentId !== undefined && row.commentId !== query.commentId) continue;
      result.push(Object.freeze(JSON.parse(JSON.stringify(row))));
    }
    return Object.freeze(result);
  }

  /**
   * Lifecycle: remove rows older than `maxAgeMs` relative to a CALLER-SUPPLIED `now`.
   *
   * WHY THERE IS NO IMPLICIT TTL (and no `Date.now()` in this module): `record` takes no clock of its
   * own, exactly like `appendOfflineAudit`. An implicit expiry would delete corroboration on the
   * strength of an unverified host clock, and deleting it can only make replies FAIL. So expiry is an
   * explicit, caller-driven decision — the caller knows whether its clock is trustworthy.
   *
   * RETENTION RULE: a row whose `at` is not a non-negative safe integer is RETAINED. It cannot be
   * dated, and guessing that an unreadable row is expired would delete evidence this module did not
   * write (a foreign writer's row). Same direction as `pruneOfflineAudit`, which keeps entries it
   * cannot parse.
   *
   * @returns `Object.freeze({ removed })`.
   */
  function prune(options) {
    const now = options && typeof options === 'object' ? options.now : undefined;
    const maxAgeMs = options && typeof options === 'object' ? options.maxAgeMs : undefined;
    if (!Number.isSafeInteger(now) || now < 0) throw invalid('prune requires a trusted non-negative integer `now`');
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) throw invalid('prune requires a non-negative integer `maxAgeMs`');
    const cutoff = now - maxAgeMs;
    let removed = 0;
    store.update((state) => {
      const current = readCollection(state);
      const kept = current.filter((row) => {
        // Unreadable row or unreadable age: keep it. Never delete what we cannot interpret.
        if (!row || typeof row !== 'object' || Array.isArray(row)) return true;
        if (!Number.isSafeInteger(row.at) || row.at < 0) return true;
        if (row.at >= cutoff) return true;
        removed += 1;
        return false;
      });
      if (!removed) return state;
      return { ...state, commentEvidence: kept };
    });
    return Object.freeze({ removed });
  }

  return Object.freeze({ record, list, prune });
}
