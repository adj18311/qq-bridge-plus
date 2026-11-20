// Offline formatter only. Detection is defense in depth, not proof that an
// arbitrary body contains no secrets; no raw requests or responses are accepted.
//
// `state.audit` GROWTH — BOUNDED ONLY BY WHOEVER CALLS `pruneOfflineAudit`
// ----------------------------------------------------------------------
// `state.audit` is a flat array that grows ONE entry per appended operation
// (`appendOfflineAudit`). Nothing in THIS module trims it: there is no timer, no size cap, and
// no implicit cleanup on write. The only reduction path is `pruneOfflineAudit(store, now)`, which
// is a SEPARATE, caller-invoked function — so **pruning is the caller's responsibility**. If the
// caller never invokes it, the array grows without bound: measured 200 appends -> 200 entries,
// 400 appends -> 400 entries (~207 B per entry as JSON).
//
// Do NOT bolt an automatic prune onto `appendOfflineAudit` as a quick fix. Three reasons, all
// structural rather than stylistic:
//   1. `appendOfflineAudit` takes no clock. It cannot decide what "7 days" means without being
//      handed a trusted `now`, and inventing one here (`Date.now()`) would let a wrong host clock
//      silently delete the audit evidence it is supposed to preserve.
//   2. The retention rule lives in `auditRetentionDecision` / `beijingDay` in
//      `qzone-policy-offline.mjs` on purpose: one place decides retention for BOTH the store
//      array and the jsonl file names. Calling it from the append path would create a second
//      decision point that can drift.
//   3. Pruning is a WRITE to state that the caller may not expect from an "append". Deleting
//      audit rows as a side effect of recording one makes an audit write non-additive: a caller
//      that lost rows cannot tell whether the loss was its own prune or somebody else's append.
//
// TWO SINKS COEXIST — neither one cleans the other:
//   · `state.audit` (this module): in-store array, trimmed only by an explicit
//     `pruneOfflineAudit(store, now)` call.
//   · `state/qzone-audit/YYYY-MM-DD.jsonl` (`qzone-audit-jsonl-offline.mjs`): file-per-day sink
//     with its own FILE-LEVEL 7-day cleanup, and it does NOT touch `state.audit`.
// So having the jsonl sink wired does NOT bound this array, and pruning this array does NOT
// delete any jsonl file. Both obligations have to be discharged separately.
import { beijingDay, auditRetentionDecision, isResolvedBy } from './qzone-policy-offline.mjs';
const SOURCES = new Set(['qq', 'patrol', 'admin_console', 'admin_script', 'health_probe']);
const ACTIONS = new Set(['read_posts', 'read_comments', 'publish', 'comment', 'reply', 'like', 'restore', 'reset_quota', 'authenticate', 'configure']);
const RESULTS = new Set(['success', 'failure', 'unknown', 'denied']);
const REASONS = new Set(['', 'network', 'not_accessible', 'login_expired', 'captcha', 'rate_limit', 'quota', 'timeout', 'platform_error', 'policy', 'other']);
const SENSITIVE = /(?:\b(?:cookie|set-cookie|authorization|bearer|p_skey|skey|qzonetoken|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|token)\b["']?\s*(?:[:=]|\s)|\bBearer\s+|[?&](?:token|qzonetoken|key|secret)=|\bsk-[A-Za-z0-9_-]{12,})/i;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
export const isSafeQzoneAuditId = (value) => typeof value === 'string' && ID.test(value) &&
  !SENSITIVE.test(value) && !/sk-[A-Za-z0-9_-]{12,}/i.test(value);

export function formatAuditRecord(input) {
  if (!input || !Number.isFinite(input.time) || !SOURCES.has(input.source) || !ACTIONS.has(input.action) ||
      !RESULTS.has(input.result) || !REASONS.has(input.reason ?? '') ||
      typeof input.target !== 'string' || !/^\d{1,20}$/.test(input.target) ||
      typeof input.content !== 'string' || input.content.length > 100000 ||
      [input.postId, input.commentId].some((id) => id != null && !isSafeQzoneAuditId(id)) ||
      (input.quota != null && (!Number.isSafeInteger(input.quota) || input.quota < 0))) throw new TypeError('invalid audit record');
  const management = ['restore', 'reset_quota', 'configure'].includes(input.action);
  if (management && (!['admin_console', 'admin_script'].includes(input.source) ||
      !isSafeQzoneAuditId(input.operator) ||
      !['none', 'access', 'write', 'both'].includes(input.pauseScope))) throw new TypeError('invalid management audit');
  const redacted = SENSITIVE.test(input.content);
  const record = { time: input.time, source: input.source, action: input.action, target: input.target,
    postId: input.postId ?? null, commentId: input.commentId ?? null,
    content: redacted ? '[REDACTED]' : input.content, redacted,
    result: input.result, reason: input.reason ?? '', quota: input.quota ?? null };
  if (management) { record.operator = input.operator; record.pauseScope = input.pauseScope; }
  return record;
}

// Offline-only experiment. Persistence here is separate from the operation
// transaction and cannot yet guarantee audit/operation atomicity.
export function appendOfflineAudit(store, id, input) {
  if (!store || typeof store.update !== 'function' || !isSafeQzoneAuditId(id)) throw new TypeError('invalid audit id');
  const record = formatAuditRecord(input);
  let appended = false;
  store.update((state) => {
    if (!Array.isArray(state.audit)) throw new TypeError('invalid audit state');
    const previous = state.audit.find((entry) => entry.id === id);
    if (previous) {
      // TYPED, not message-matched (verifier t26 low-1). Callers must distinguish "the caller reused an
      // id with different content" (a bug in THEIR code) from "the store is broken" (infrastructure).
      // Matching on the message text made that distinction fragile: rewording the message in this file
      // would silently reclassify a caller bug as a storage fault — and the write-observability path
      // LATCHES the authority on a storage fault, i.e. it would lock a healthy process out.
      // `code` is the contract; the message is for humans and may change freely.
      if (JSON.stringify(previous.record) !== JSON.stringify(record)) {
        const conflict = new Error('conflicting audit id');
        conflict.code = 'AUDIT_ID_CONFLICT';
        throw conflict;
      }
      return state;
    }
    appended = true;
    return { ...state, audit: [...state.audit, { id, record }] };
  });
  return { appended };
}

// Only removes entries from the isolated store. Unknown/corrupt entries are
// retained, not guessed to be expired. No files are deleted.
export function pruneOfflineAudit(store, now) {
  if (!store || typeof store.update !== 'function' || !Number.isFinite(now)) throw new TypeError('invalid prune');
  let removed = 0;
  store.update((state) => {
    if (!Array.isArray(state.audit)) throw new TypeError('invalid audit state');
    const audit = state.audit.filter((item) => {
      if (!Number.isFinite(item?.record?.time)) return true;
      let name;
      try { name = `${beijingDay(item.record.time)}.jsonl`; } catch { return true; }
      if (auditRetentionDecision(name, now) !== 'expired') return true;
      removed++; return false;
    });
    return { ...state, audit };
  });
  return { removed };
}

// ════════════════════════════════════════════════════════════════════════════════════════
// `auditGaps` — the record of an audit that FAILED to be written (M8)
// ════════════════════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS
// ---------------
// `appendOfflineAudit` can fail: the store write can throw, or `state.audit` can be corrupt.
// When that happens the operation itself may still have reached the platform, so the evidence
// is gone but the action is not. A gap entry is the honest, minimal record of that loss: it
// says "an audit row SHOULD exist for identity X and does not exist because of reason Y",
// which is what a recovery pass needs in order to either re-derive the row or flag it.
//
// WHAT A GAP ENTRY IS **NOT**
// ---------------------------
//   · NOT an audit record. It never enters `state.audit`, and `formatAuditRecord` is not
//     involved at all. In particular it has NO `result` field: an audit gap is a statement
//     about a MISSING row, and stamping `result:'success'` on it would fabricate the very
//     evidence that was lost (design rule G-2). Any `result:'success'` input is rejected.
//   · NOT a place to park the operation's content. There is no `content`, no `body`, no
//     `target`, no `postId`. Only the identity, the reason and the generation. Rule G-5.
//   · NOT keyed by the clock. See below.
//
// STABLE KEY, NOT A CLOCK (G-1)
// -----------------------------
// The key MUST be the stable identity of the settlement/execution whose audit was lost — the
// same identity the caller already uses for idempotency (for the write path that is
// `settleKeyFor()`'s `<id>#<digest>`). This function NEVER derives it, hashes it with a
// timestamp, or fills it in from `Date.now()`. Rationale, and it is not academic: a
// clock-derived key mints a NEW entry on every retry of the same failure, so one broken audit
// write becomes an unbounded stream of gap rows — and none of them can be matched back to the
// operation they describe. The `time` field exists for operators to order events; it is
// metadata and is deliberately NOT part of the key.
//
// TWO REASON CODES, DELIBERATELY NOT ONE
// --------------------------------------
//   `audit-write-failed`  the append was attempted and the store rejected/threw. The audit
//                         LOGIC is intact; re-trying the same append may succeed.
//   `audit-state-invalid` `state.audit` itself is not an array (or the shape is unusable).
//                         Nothing can be appended until the state is repaired; re-trying is
//                         pointless and would only add noise.
// Collapsing them into one code would tell a recovery pass "try again" for the second case,
// which can never work. The distinction is the whole point of keeping two.
//
// G-4 (do not overwrite/clear a corrupt `audit`) is a CALLER obligation, and this module
// deliberately adds no writer that could violate it: there is no `appendAuditGap` here. A
// caller that records a gap must leave `state.audit` exactly as it found it — including when
// it is corrupt — because the corrupt array IS the evidence of what went wrong.

// ── `resolvedBy` — how a gap stops blocking WITHOUT being deleted (M8b) ─────────────────────
//
// THE CONFLICT THIS FIELD RESOLVES
// --------------------------------
// The write gate refuses while any gap is present, and G-4 forbids deleting a gap (the gap is the
// evidence that an audit row went missing). A rule of "non-empty ⇒ refuse" plus "never delete"
// means recovery is impossible: the operator fixes the store, and the gate still refuses forever.
//
// So a gap becomes `{ key, reason, generation, time, resolvedBy }`, where `resolvedBy` is either
// `null` (still open) or `{ generation, at, operator }`. The entry STAYS in `auditGaps` — nothing
// in this module deletes it — and the gate simply stops counting it as a blocker.
//
// WHY THE MARKER MUST MATCH THE GENERATION
// ---------------------------------------
// `generation` identifies WHICH failure episode produced the gap. A marker that does not name the
// same generation cannot have been produced by resolving THIS episode; accepting it would let a
// stale marker (or one copied from another incident) unblock writes. So the match is exact.
//
// The marker shape is validated by `isResolvedBy` in `qzone-policy-offline.mjs`, and the gate uses
// THAT SAME FUNCTION. The rule is deliberately not re-implemented here: two implementations would
// drift, and a drift means either a gap that can never be cleared or a cleared gap that still
// blocks. This module imports the validator; it does not define a second one. (The import
// direction is forced: this module already depends on `policy`, so the shared rule lives there.)
//
// ⚠️ SHAPE IS NOT AUTHORISATION. `formatAuditGap` only proves an input LOOKS like a resolution
// marker. It does not, and cannot, prove the caller was entitled to clear the gap — that is the
// job of M9's controlled recovery transaction, which is the only code allowed to write the marker
// together with its management audit. A model-supplied "I resolved this" must never obtain
// recovery merely by satisfying a shape check.

/** Fixed reason codes. Kept small and closed; see "TWO REASON CODES" above. */
export const AUDIT_GAP_REASONS = Object.freeze(['audit-write-failed', 'audit-state-invalid']);

// A gap key is either a bare safe id, or `<safe-id>#<32 hex digest>` (the settled-key shape).
// Deliberately NOT a hash of anything: the caller must hand over the identity it already has,
// so that two reports about the same lost audit produce the SAME key.
const GAP_KEY = /^[A-Za-z0-9_-]{1,128}(?:#[0-9a-f]{32})?$/;
// Field names that must never reach a gap entry. Listed explicitly (rather than relying only on
// the output allowlist) so the thrown error can NAME the offending field — a caller that passes
// `content` has a bug worth seeing, and silently dropping it would hide that bug.
const AUDIT_GAP_FORBIDDEN = Object.freeze([
  'content', 'body', 'text', 'message', 'target', 'targetQQ', 'targetUin', 'postId', 'commentId',
  'rawResponse', 'response', 'request', 'payload', 'arguments', 'args',
  'cookie', 'cookies', 'setCookie', 'authorization', 'bearer', 'pskey', 'skey', 'qzonetoken',
  'accessToken', 'refreshToken', 'apiKey', 'clientSecret', 'password', 'passwd', 'token',
]);

const isPlainRecord = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/**
 * Validate one audit-gap input and return the frozen gap entry.
 *
 * @param input - `{ key, reason, generation, time }`. See the module section above for why each
 *   field is where it is. Unknown NON-sensitive keys are ignored (the result is built from a
 *   closed allowlist, so nothing can leak); sensitive keys are REJECTED, not stripped.
 * @returns `Object.freeze({ key, reason, generation, time })`.
 * @throws {TypeError} for a missing/malformed stable key, an unknown reason code, a
 *   `result:'success'` (G-2), a sensitive field (G-5), or a non-finite/negative `time`.
 */
export function formatAuditGap(input) {
  if (!isPlainRecord(input)) throw new TypeError('invalid audit gap: input must be a plain object');

  // G-5 first: name the offending field rather than silently dropping it.
  for (const field of AUDIT_GAP_FORBIDDEN) {
    if (Object.hasOwn(input, field) && input[field] !== undefined) {
      throw new TypeError(`invalid audit gap: field "${field}" must not be recorded `
        + '(an audit gap carries identity and reason only, never operation content or credentials)');
    }
  }

  // G-2: a gap describes a MISSING audit row. Claiming success here would fabricate the
  // evidence that was lost, so it is refused loudly rather than ignored.
  if (Object.hasOwn(input, 'result')) {
    if (input.result === 'success') {
      throw new TypeError('invalid audit gap: result:"success" is forbidden (G-2) — '
        + 'an audit gap records a FAILED audit write, never a successful operation');
    }
    throw new TypeError('invalid audit gap: a gap entry has no "result" field at all — '
      + `received ${JSON.stringify(input.result)}`);
  }

  // G-1: the key is the caller's stable identity. Never derived, never clock-stamped.
  const { key } = input;
  if (typeof key !== 'string' || !GAP_KEY.test(key)
      || SENSITIVE.test(key) || /sk-[A-Za-z0-9_-]{12,}/i.test(key)) {
    throw new TypeError('invalid audit gap: "key" must be the stable settlement/execution identity '
      + '(a safe id, optionally followed by "#" and a 32-hex digest). It must NOT be derived from '
      + 'the current clock — a clock-derived key creates a new entry on every retry, so one broken '
      + 'audit write becomes unbounded gap rows that can never be matched back to the operation');
  }

  if (typeof input.reason !== 'string' || !AUDIT_GAP_REASONS.includes(input.reason)) {
    throw new TypeError(`invalid audit gap: "reason" must be one of ${AUDIT_GAP_REASONS.join(' | ')} `
      + '(audit-write-failed = retryable; audit-state-invalid = state must be repaired first)');
  }

  const { generation } = input;
  if (typeof generation !== 'string' || !ID.test(generation)
      || SENSITIVE.test(generation) || /sk-[A-Za-z0-9_-]{12,}/i.test(generation)) {
    throw new TypeError('invalid audit gap: "generation" must be a non-empty safe id identifying '
      + 'the fault generation (so a recovery pass can tell which failure episode it belongs to)');
  }

  if (!Number.isSafeInteger(input.time) || input.time < 0) {
    throw new TypeError('invalid audit gap: "time" must be a non-negative safe integer '
      + '(it is metadata for operators; it is NOT part of the key)');
  }

  // ── resolvedBy (M8b): null, or a marker that passes the SAME validator the write gate uses ──
  // Absent and `null` both mean "still open" — a gap written before this field existed is therefore
  // unresolved, which is the safe reading. Anything else must be an exact `{ generation, at,
  // operator }` marker whose generation equals THIS entry's generation; a marker for another
  // generation, a missing `at`/`operator`, a wrong type, or an unrecognised shape is refused here
  // rather than being stored and silently ignored by the gate later.
  const resolvedBy = Object.hasOwn(input, 'resolvedBy') ? input.resolvedBy : null;
  if (resolvedBy !== null && !isResolvedBy(resolvedBy, generation)) {
    throw new TypeError('invalid audit gap: "resolvedBy" must be null or exactly '
      + '{ generation, at, operator } — with generation equal to this entry\'s generation, '
      + 'at a non-negative safe integer, and operator a safe id. A marker carrying only '
      + '"generation" is NOT sufficient: shape alone must never be able to clear a gap, and only '
      + 'a marker naming THIS failure episode may stop it blocking');
  }

  // Built from a closed allowlist, so no caller-supplied extra can ride along.
  return Object.freeze({
    key,
    reason: input.reason,
    generation,
    time: input.time,
    resolvedBy: resolvedBy === null ? null : Object.freeze({
      generation: resolvedBy.generation,
      at: resolvedBy.at,
      operator: resolvedBy.operator,
    }),
  });
}

/**
 * Shape check for a stored gap entry. Deliberately strict and independent of the writer.
 *
 * @returns true only for an entry built from the five allowed fields (`key`, `reason`,
 *   `generation`, `time`, `resolvedBy`) whose values would also pass `formatAuditGap`. In
 *   particular an entry carrying `result` (of any value) is rejected: a gap record must never look
 *   like it settled an operation. `resolvedBy` may be `null` (open) or a valid marker.
 */
export function isAuditGap(value) {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value).sort();
  // Exactly five fields: key, reason, generation, time, resolvedBy.
  if (keys.length !== 5 || keys[0] !== 'generation' || keys[1] !== 'key' || keys[2] !== 'reason'
      || keys[3] !== 'resolvedBy' || keys[4] !== 'time') return false;
  try {
    const rewritten = formatAuditGap(value);
    // Round-trip equality: catches an entry whose stored values were mutated after writing.
    // `resolvedBy` is compared by value, since the rewrite re-freezes it.
    return rewritten.key === value.key && rewritten.reason === value.reason
      && rewritten.generation === value.generation && rewritten.time === value.time
      && JSON.stringify(rewritten.resolvedBy) === JSON.stringify(value.resolvedBy);
  } catch {
    return false;
  }
}
