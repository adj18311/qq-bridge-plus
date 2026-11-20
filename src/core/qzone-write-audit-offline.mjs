// Write-audit sink: what `formatAuditRecord` structurally CANNOT carry.
//
// WHY THIS MODULE EXISTS
// ----------------------
// `qzone-audit-offline.mjs:43-61` validates and formats every audit row, and its product is a FIXED
// CLOSED KEY SET:
//
//   time, source, action, target, postId, commentId, content, redacted, result, reason, quota
//   (+ operator, pauseScope for management actions)
//
// Six facts this project needs are simply NOT in that set — `ugc_right`, `target_uins`,
// `comment_uin`, `reply_uin`, `reply_name`, and the approval digest. Passing them in is not an
// error; `formatAuditRecord` silently drops them (measured). So the existing audit cannot answer
// "what visibility did this publish use?", "who were the recipients?", or "which comment and author
// did this reply address?".
//
// `formatAuditRecord` and the `settled` idempotency key are DELIBERATELY UNTOUCHED. Its key ORDER
// participates in `settleKeyFor` (`qzone-write-observability-offline.mjs:199-206`), so widening or
// reordering it would invalidate every historical settled key. This module is a SECOND sink beside
// the first, not a widening of it: nothing here reads or writes `state.audit`, and nothing here
// calls `settleKeyFor`.
//
// ⚠️ WHAT THIS MODULE CANNOT DO — READ THIS BEFORE TRUSTING A ROW
// --------------------------------------------------------------
// `recordWrite()` accepts a plain object. THAT MEANS ANY CALLER CAN WRITE ANY VALUE INTO THIS
// SINK. It is an append-only, validated, prunable LOG — it is NOT a trusted audit root, and it does
// not prove that what was recorded actually happened. Specifically it cannot prove:
//
//   · that the caller was authorised to perform the write it is describing;
//   · that the described write was the one the host approved (the digest binds to a snapshot only
//     if the CALLER passed the real snapshot's digest);
//   · that a platform request was ever issued.
//
// What it DOES give you: shape validation (a malformed or over-long row is refused rather than
// stored), no body retention (content is never stored, only an optional digest), bounded growth,
// append-only idempotency by `authorizationId`, and a durable record that survives the process.
// Binding a row to a real approval needs a caller that is itself trusted — that caller does not
// exist in this repository yet.
//
// ⚠️ THE DIGEST IS NOT ANONYMITY. `inputDigest` is `sha256` of the canonical input, and a publish
// body is often low-entropy (a short greeting, a fixed template, a single emoji). Anyone holding a
// candidate plaintext can hash it and match the digest, so a digest of a guessable body is a
// verifier, not a redaction. It is stored because it binds the row to the approved snapshot — not
// because it hides the body. Do not describe this sink as storing "anonymised" content.
//
// ⚠️ FOUR DIFFERENT FACTS, FOUR DIFFERENT FIELDS — DO NOT COLLAPSE THEM
// -------------------------------------------------------------------
// The audit trail must let a reader tell these apart, because they license different conclusions:
//
//   1. INTENT      — a reservation/audit intent exists. Says "this was going to be attempted".
//   2. APPROVAL    — the operator decided. Says "a human allowed it". Carried by `decision`.
//   3. DISPATCH    — the platform call was handed to `send`. Says "we tried to send it".
//   4. OUTCOME     — what the platform answered, or `unknown`. Says "we know how it ended".
//
// ⚠️ `send()` BEING CALLED IS **NOT** PLATFORM SUCCESS. In every composition in this repository
// `send` is an injected function; its return value is classified by the write path's own
// `classify()` (`qzone-write-settlement-offline.mjs:105-...`), which reads an unparseable or
// self-contradictory answer as `unknown`. `outcome:'success'` therefore means "the injected
// transport claimed success", not "the platform confirmed the post". A row must never be written
// with `decision:'approved'` as if that were the outcome — the decision field answers WHO and
// WHAT, the outcome field separate from it answers HOW IT ENDED.
//
// REDACTION POLICY
// ----------------
// · `content` is NOT a field of this sink at all (a caller that wants a body fingerprint passes
//   `inputDigest`, already a sha256 hex string).
// · `replyName` is a DISPLAY NAME, i.e. text another account chose. It is stored only if it passes
//   `isSafeQzoneAuditId`-style screening; otherwise it is replaced by the fixed marker
//   `[REDACTED-NAME]`. The row still says "a name existed", it just does not keep the text.
// · every id-shaped field is validated with the SAME `isSafeQzoneAuditId` predicate the audit
//   module already uses, so a credential-looking string cannot be parked here.
//
// OPERATOR IDENTITY — WHY IT IS A SEPARATE ARGUMENT, AND WHAT IT STILL CANNOT PROVE
// --------------------------------------------------------------------------------
// `recordWrite(input, approval)` takes the operator decision as a SECOND argument, never as part
// of `input`. That split is the whole design:
//
//   · `input` describes THE OPERATION (what was approved). It is exactly the frame a model or a
//     caller can produce, so nothing in it may be trusted as "who approved this".
//   · `approval` describes THE DECISION (who approved it, and when). A caller that wants a real
//     operator here must take the value from a server-side authenticated route — `authorizeConsole`
//     (`qzone-console-gateway.mjs:85`) plus `verifySession` (`console-column-auth.mjs:359`), whose
//     `sessionId` comes from a server-minted session in a process-local Map, not from a request
//     body.
//
// ⚠️ THIS MODULE VALIDATES THE SHAPE OF `approval`, NOT ITS TRUTH. Any caller can call
// `recordWrite(input, { operatorSessionId: '<any uuid>' })` and the row will claim that operator
// decided. Shape validation stops a malformed or credential-shaped value; it cannot stop a caller
// that invents a well-formed one. A reader must therefore treat `operator` as "what the writer
// asserted", not "what the server proved".
//
// ⚠️ AND TODAY NO CALLER CAN SUPPLY A TRUE ONE: `qzone-console-gateway.mjs` does not pass the
// session to the broker's `decide()` (`qzone-operation-approval-console.mjs:64`), so the approval
// path currently has no way to carry the authenticated sessionId into a write. Operator fields are
// therefore OPTIONAL and are `null` when omitted — that null means "not recorded", never
// "no operator existed". Do not read a null operator as an anonymous approval.

import { isSafeQzoneAuditId } from './qzone-audit-offline.mjs';

/** Where the rows live. A dedicated top-level field, never inside `state.audit`. */
const SINK_FIELD = 'writeAudit';

/** Upper bound on stored rows. Oldest are dropped first (see `pruneWriteAudit`). */
const MAX_ROWS = 2000;

/** Per-field cap for the free-text display name. */
const MAX_NAME_LENGTH = 64;

/** A name this module refuses to store verbatim. The marker is a fixed token, not caller text. */
const REDACTED_NAME = '[REDACTED-NAME]';

const ACTIONS = new Set(['publish', 'comment', 'reply', 'like']);
const UGC_RIGHTS = new Set([1, 4, 16, 64, 128]);
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The lifecycle stage of one authorisation.
 *
 * WHY A STAGE IS NEEDED AT ALL: one approval produces at least three distinct facts — it was
 * decided, a send was attempted, and the attempt ended somehow. Recording them as three mutations
 * of ONE row would destroy the earlier facts (a later `unknown` would overwrite the approval that
 * licensed it), and recording them under one `authorizationId` with a single-row idempotency key
 * makes the second write look like a conflicting duplicate. So each fact is its own ROW and the
 * idempotency key is `(authorizationId, stage)`.
 */
const STAGES = new Set(['approval', 'intent', 'result']);

/** Which outcome values are legal for which stage. A stage may not carry another's outcome. */
const STAGE_OUTCOMES = Object.freeze({
  approval: new Set([null]),
  intent: new Set([null]),
  result: new Set(['success', 'failed', 'unknown', 'not-sent']),
});

/** Which decisions are legal for which stage. Only `approval` carries one. */
function stageDecisionAllowed(stage, decision) {
  if (stage === 'approval') return DECISIONS.has(decision);
  return decision === null;
}

/**
 * The operator decision, validated as a closed shape.
 *
 * A `null`/absent approval is legal and means "the operator was not recorded" — the honest state
 * while the console gateway does not carry a session into the approval. A PRESENT approval must be
 * complete: a decision with an outcome but no identity, or an identity but no outcome, is refused
 * rather than stored half-populated (a half row would read like a fully attributed decision).
 */
const DECISIONS = new Set(['approved', 'rejected']);

/**
 * What the platform actually answered — a SEPARATE axis from the decision.
 *
 * `intent`   : an intent was recorded, nothing was dispatched. The row says "planned, not tried".
 * `dispatched`: `send()` was handed the payload. Says "we tried", NOT "it worked".
 * `success`  : the injected transport claimed success. `send` is always injected in this codebase,
 *              so this is the TRANSPORT's claim, classified by the write path's own `classify()`.
 * `failed`   : the transport claimed a definite failure.
 * `unknown`  : the answer was contradictory or unparseable, or an exception escaped mid-flight.
 *              Never collapsed into `success`, and never retried on the strength of it.
 * `not-sent` : provably nothing left this process.
 *
 * `null` means "no outcome was recorded", which is different from every value above.
 */
const OUTCOMES = new Set(['intent', 'dispatched', 'success', 'failed', 'unknown', 'not-sent']);

function buildOperator(approval) {
  if (approval === undefined || approval === null) {
    return Object.freeze({ operator: null, operatorSessionId: null, decidedAt: null, decision: null });
  }
  if (!isPlainObject(approval)) throw new TypeError('invalid write audit approval');
  const { operator, operatorSessionId, decidedAt, decision } = approval;

  // `operator` is the display label an administrator chose; `operatorSessionId` is the server-minted
  // session that made the decision. Both are optional individually, but at least one identity must
  // be present — a decision with no attributable actor is exactly the row this sink must not invent.
  const hasLabel = operator !== undefined && operator !== null;
  const hasSession = operatorSessionId !== undefined && operatorSessionId !== null;

  if (!hasLabel && !hasSession) throw new TypeError('invalid write audit operator');
  if (hasLabel && !isSafeQzoneAuditId(operator)) throw new TypeError('invalid write audit operator');
  if (hasSession && !isSafeQzoneAuditId(operatorSessionId)) {
    throw new TypeError('invalid write audit operator session');
  }
  if (typeof decision !== 'string' || !DECISIONS.has(decision)) {
    throw new TypeError('invalid write audit decision');
  }
  if (!Number.isFinite(decidedAt)) throw new TypeError('invalid write audit decided time');

  return Object.freeze({
    operator: hasLabel ? operator : null,
    operatorSessionId: hasSession ? operatorSessionId : null,
    decidedAt,
    decision,
  });
}

/**
 * Validate the reported outcome. Kept OUT of `input` and OUT of `approval` for the same reason the
 * operator block is: "who allowed it" and "how it ended" are different facts with different
 * evidentiary weight, and a single object invites collapsing them.
 */
function buildOutcome(reported) {
  if (reported === undefined || reported === null) return Object.freeze({ outcome: null });
  if (typeof reported !== 'string' || !OUTCOMES.has(reported)) {
    throw new TypeError('invalid write audit outcome');
  }
  return Object.freeze({ outcome: reported });
}

const isPlainObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/**
 * Screen a display name, returning either the name or the fixed redaction marker.
 *
 * `''` and `null` both mean "there is no name", and are stored as `null` — they are not the same
 * thing as a name that failed screening, which is the marker.
 */
function screenName(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError('invalid reply name');
  if (value.length > MAX_NAME_LENGTH) throw new TypeError('invalid reply name');
  // `isSafeQzoneAuditId` is the existing credential-screening predicate: it rejects the SENSITIVE
  // pattern and sk-/token-looking strings. Reusing it here means a name cannot smuggle a secret
  // into a field a human will read.
  if (!isSafeQzoneAuditId(value)) return REDACTED_NAME;
  return value;
}

/**
 * Validate + freeze one row. Throws on anything malformed; never normalises silently.
 *
 * `stage` is a separate argument (not an `input` field) for the same reason the operator block is:
 * the operation frame describes WHAT was approved and must stay identical across all three stages of
 * one authorisation. Putting the stage inside it would let a caller that only changed the stage look
 * like a different operation.
 */
function buildRow(input, stage, approval, reportedOutcome) {
  if (!isPlainObject(input)) throw new TypeError('invalid write audit input');
  const {
    authorizationId, accountId, sessionId, requestId, callId, connectionEpoch,
    action, inputDigest, ugcRight, targetUins, commentId, commentUin, replyUin, replyName, time,
  } = input;

  // `input` must not try to smuggle the operator fields: keeping them out of the operation frame is
  // what makes "the operation described" and "who approved it" impossible to conflate by accident.
  for (const field of ['operator', 'operatorSessionId', 'decision', 'decidedAt']) {
    if (Object.hasOwn(input, field)) throw new TypeError('invalid write audit input');
  }
  // Nor may it smuggle the stage/outcome axes.
  if (Object.hasOwn(input, 'stage') || Object.hasOwn(input, 'outcome')) {
    throw new TypeError('invalid write audit input');
  }

  if (typeof stage !== 'string' || !STAGES.has(stage)) throw new TypeError('invalid write audit stage');

  if (!isSafeQzoneAuditId(authorizationId)) throw new TypeError('invalid write audit authorization id');
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new TypeError('invalid write audit account');
  if (!isSafeQzoneAuditId(sessionId)) throw new TypeError('invalid write audit session id');
  if (!isSafeQzoneAuditId(requestId)) throw new TypeError('invalid write audit request id');
  if (!isSafeQzoneAuditId(callId)) throw new TypeError('invalid write audit call id');
  if (!Number.isSafeInteger(connectionEpoch) || connectionEpoch < 0) {
    throw new TypeError('invalid write audit connection epoch');
  }
  if (!Number.isFinite(time)) throw new TypeError('invalid write audit time');
  if (typeof action !== 'string' || !ACTIONS.has(action)) throw new TypeError('invalid write audit action');
  if (typeof inputDigest !== 'string' || !HEX64.test(inputDigest)) {
    throw new TypeError('invalid write audit input digest');
  }

  // Visibility and recipients are a PAIR, mirroring the builder's own rule
  // (`qzone-onebot-write-contract.mjs:84-92`): 16/128 require 1..1000 recipients, anything else
  // must carry none. A row that recorded `ugc_right:16` with no recipients would be a lie about who
  // could see it, so it is refused rather than stored half-populated.
  let right = null;
  let recipients = null;
  if (ugcRight !== undefined && ugcRight !== null) {
    if (!UGC_RIGHTS.has(ugcRight)) throw new TypeError('invalid write audit visibility');
    right = ugcRight;
    const needsRecipients = ugcRight === 16 || ugcRight === 128;
    const hasRecipients = targetUins !== undefined && targetUins !== null;
    if (needsRecipients !== hasRecipients) throw new TypeError('invalid write audit recipients');
    if (hasRecipients) {
      if (!Array.isArray(targetUins) || targetUins.length < 1 || targetUins.length > 1000) {
        throw new TypeError('invalid write audit recipients');
      }
      recipients = [];
      for (let i = 0; i < targetUins.length; i += 1) {
        const desc = Object.getOwnPropertyDescriptor(targetUins, String(i));
        if (!desc || !Object.hasOwn(desc, 'value')) throw new TypeError('invalid write audit recipients');
        const value = desc.value;
        if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('invalid write audit recipients');
        recipients.push(value);
      }
      Object.freeze(recipients);
    }
  } else if (targetUins !== undefined && targetUins !== null) {
    throw new TypeError('invalid write audit recipients');
  }

  // Reply identity. `replyUin`/`replyName` are a pair in the platform contract; `commentUin` is
  // required for a reply. A non-reply carrying any of them is refused rather than silently dropped
  // — the row would otherwise look like it described a reply it did not describe.
  const replyFields = { commentId, commentUin, replyUin, replyName };
  const anyReplyField = Object.values(replyFields).some((value) => value !== undefined && value !== null);
  if (anyReplyField && action !== 'reply') throw new TypeError('invalid write audit reply fields');

  let comment = null;
  let parentUin = null;
  let replyToUin = null;
  let name = null;
  if (action === 'reply') {
    if (!isSafeQzoneAuditId(commentId)) throw new TypeError('invalid write audit comment id');
    if (!Number.isSafeInteger(commentUin) || commentUin <= 0) throw new TypeError('invalid write audit comment uin');
    comment = commentId;
    parentUin = commentUin;
    const hasReplyUin = replyUin !== undefined && replyUin !== null;
    const hasReplyName = replyName !== undefined && replyName !== null;
    if (hasReplyUin !== hasReplyName) throw new TypeError('invalid write audit reply target');
    if (hasReplyUin) {
      if (!Number.isSafeInteger(replyUin) || replyUin <= 0) throw new TypeError('invalid write audit reply target');
      replyToUin = replyUin;
      name = screenName(replyName);
    }
  }

  const operatorRecord = buildOperator(approval);
  const outcomeRecord = buildOutcome(reportedOutcome);

  // The stage constrains the other two axes, so a row can never say "approved AND not-sent" or
  // "an intent with a success outcome" — those are contradictions a reader would otherwise have to
  // detect. Each is refused here instead.
  if (!STAGE_OUTCOMES[stage].has(outcomeRecord.outcome)) {
    throw new TypeError('invalid write audit outcome');
  }
  if (!stageDecisionAllowed(stage, operatorRecord.decision)) {
    // `approval` requires a decision; every later stage must NOT carry one, because the decision
    // belongs to the moment it was made, not to the attempt that followed.
    throw new TypeError('invalid write audit decision');
  }

  const row = {
    // The stage is the FIRST field so a human scanning the sink sees the lifecycle order directly,
    // and so `(authorizationId, stage)` reads as the natural key.
    stage,
    time,
    authorizationId,
    accountId,
    sessionId,
    requestId,
    callId,
    connectionEpoch,
    action,
    inputDigest,
    ugcRight: right,
    targetUins: recipients,
    commentId: comment,
    commentUin: parentUin,
    replyUin: replyToUin,
    replyName: name,
    // The operator block is present on EVERY row so a reader never has to distinguish "field
    // missing because nobody wrote it" from "field missing because the schema grew later". `null`
    // inside it means "not recorded", which is a different statement from "no operator acted".
    operator: operatorRecord.operator,
    operatorSessionId: operatorRecord.operatorSessionId,
    decidedAt: operatorRecord.decidedAt,
    decision: operatorRecord.decision,
    // The OUTCOME axis, separate from the decision axis on purpose: "a human approved this" and
    // "the transport claimed success" are different facts. `null` = no outcome recorded.
    outcome: outcomeRecord.outcome,
  };
  return Object.freeze(row);
}

/**
 * Read the raw sink out of a state object, tolerating its absence.
 *
 * An absent field means "nothing was ever recorded", which is the same answer as an empty list, so
 * it is NOT an error. A field that exists but is not an array IS an error: that state is corrupt
 * and guessing what it meant is how audit trails quietly become fiction.
 */
function readSink(state) {
  const value = state?.[SINK_FIELD];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('invalid write audit state');
  return value;
}

/**
 * Build the write-audit sink.
 *
 * @param store - the offline SQLite store (`read`/`update`), the same one the rest of the offline
 *   pipeline uses. Rows live in a dedicated `state.writeAudit` array, never in `state.audit`.
 * @returns `Object.freeze({ recordWrite, read })`.
 */
export function createQzoneWriteAudit({ store } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('write audit needs a store with read/update');
  }

  /**
   * Append one row, idempotently keyed by `(authorizationId, stage)`.
   *
   * WHY THE KEY IS THE PAIR, NOT JUST THE ID: one authorisation legitimately produces THREE rows —
   * the decision, the pre-send intent, and the result. Keying on `authorizationId` alone would make
   * the intent look like a duplicate of the approval and throw `WRITE_AUDIT_ID_CONFLICT` on the
   * second write, i.e. the lifecycle could never be recorded at all. Keying on the pair keeps
   * "retry of the same fact" idempotent while letting the next fact through.
   *
   * A second write of the SAME `(id, stage)` with byte-identical content is a retry and is a no-op;
   * with DIFFERENT content it throws, exactly like `appendOfflineAudit`'s `AUDIT_ID_CONFLICT`
   * contract — matching on message text instead of a typed code would let a reworded message
   * reclassify a caller bug as a storage fault.
   *
   * The check and the append happen inside ONE `store.update`, so two racing writers cannot both
   * pass the check. A store failure PROPAGATES: the caller must never believe a decision was
   * durably recorded when the transaction failed.
   *
   * @param input - the OPERATION frame (what was approved). Validated as a closed shape, and it must
   *   be IDENTICAL across the three stages of one authorisation — the stage says which fact this row
   *   is, not what the operation was.
   * @param stage - `approval` | `intent` | `result`.
   * @param approval - the OPERATOR DECISION (`{operator?, operatorSessionId?, decidedAt, decision}`),
   *   or `null`/absent when the operator was not recorded. Kept out of `input` on purpose: a caller
   *   that could fold "who approved" into "what was approved" could invent both with one object.
   *   See the header for what this can and cannot prove.
   * @param outcome - what the platform answered (`success`/`failed`/`unknown`/`not-sent`), or
   *   `null`/absent. Legal only on the `result` stage; a THIRD/fourth argument rather than a field,
   *   so "a human approved this" can never be misread as "it worked".
   */
  function recordWrite(input, stage, approval, outcome) {
    const row = buildRow(input, stage, approval, outcome);
    let appended = false;
    store.update((state) => {
      const rows = readSink(state);
      const existing = rows.find((entry) => entry
        && entry.authorizationId === row.authorizationId && entry.stage === row.stage);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(row)) {
          const conflict = new Error('conflicting write audit authorization id');
          conflict.code = 'WRITE_AUDIT_ID_CONFLICT';
          throw conflict;
        }
        return state;
      }
      appended = true;
      const next = [...rows, row];
      // Pruning is part of the SAME transaction: a row that would exceed the cap evicts the oldest
      // in the commit that adds it, so a reader never observes an over-cap array.
      const bounded = next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
      return { ...state, [SINK_FIELD]: bounded };
    });
    return Object.freeze({ appended });
  }

  /** All rows for one authorisation, in the order they were written. A copy. */
  function stagesFor(authorizationId) {
    if (!isSafeQzoneAuditId(authorizationId)) throw new TypeError('invalid write audit authorization id');
    return Object.freeze(readSink(store.read())
      .filter((row) => row && row.authorizationId === authorizationId)
      .map((row) => (isPlainObject(row) ? Object.freeze({ ...row }) : row)));
  }

  /** All recorded rows, oldest first. A copy: a caller cannot mutate the stored array. */
  function read() {
    return Object.freeze(readSink(store.read()).map((row) => (isPlainObject(row) ? Object.freeze({ ...row }) : row)));
  }

  return Object.freeze({ recordWrite, read, stagesFor });
}

export {
  MAX_ROWS as _MAX_ROWS,
  MAX_NAME_LENGTH as _MAX_NAME_LENGTH,
  REDACTED_NAME as _REDACTED_NAME,
  buildRow as _buildRow,
  buildOperator as _buildOperator,
  DECISIONS as _DECISIONS,
  STAGES as _STAGES,
};
