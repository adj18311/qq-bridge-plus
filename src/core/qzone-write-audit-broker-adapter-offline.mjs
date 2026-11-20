// Approval-decisions and per-attempt lifecycle -> the write-audit sink (offline composition only).
//
// WHY THIS MODULE EXISTS
// ----------------------
// `qzone-write-audit-offline.mjs` can store three facts per authorisation — the DECISION, the
// pre-send INTENT, and the OUTCOME — but it has no producer. `qzone-operation-approval-console.mjs`
// has a decision and no sink: `decide()` (:71-83) calls an injected `recordDecision` with a FROZEN
// `{ operation, operator, approved }` and only proceeds when the call returns strict `true`. This
// module is the shape that connects the two, plus the one frame builder both sides use so the
// approval row and the dispatch rows cannot drift apart.
//
// ⚠️ THE OPERATOR IS A SERVER-SIDE SESSION ID, NOT A NATURAL PERSON
// -----------------------------------------------------------------
// `operator` is `session.sessionId` from `verifySession` (`console-column-auth.mjs:359`), forwarded
// by the console gateway (`qzone-console-gateway.mjs:110`) — the id of a server-minted, process-local
// session record (`crypto.randomUUID()` at `console-column-auth.mjs:204`). It answers "which console
// session pressed approve". It does NOT identify a human being, a QQ account, or a principal that a
// third party could verify: one person can hold several sessions, and a session says nothing about
// who was at the keyboard. A row must never be described as "approved by <person>".
//
// ⚠️ AND THE PARAMETER SPLIT IS SHAPE SEPARATION, NOT A SECURITY BOUNDARY
// ---------------------------------------------------------------------
// `{ operation, operator, approved }` keeps "what was approved" apart from "who decided it", and the
// sink keeps the decision, the intent and the outcome in three separate arguments/rows. That layout
// stops ACCIDENTAL conflation (a caller cannot fold a decision into the operation frame, and a
// `success` outcome cannot be read as an approval). It does NOT stop a caller that invents well-formed
// values: `recordDecision` is an ordinary in-process function, and anything that can call it can pass
// an operator string it made up. Marking two parameters as separate does not authenticate either of
// them. What the split buys is that an honest caller has nowhere to hide a mistake, and that a
// malformed value is refused instead of stored.
//
// WHAT THIS MODULE CAN AND CANNOT PROVE
// -------------------------------------
//   · CAN: the decision was written to the sink before the broker released the approval, and the
//     broker refuses the approval when that write fails (see "STORE FAILURE" below).
//   · CANNOT: that the operator was a human, that the operation was really the one a model proposed,
//     that a platform request was ever issued, or that a recorded outcome came from the platform. The
//     sink validates shape, never truth — its own header says so.
//
// STORE FAILURE — RETURN `false`, DELIBERATELY, AND WHY THAT IS THE VISIBLE CHOICE
// ------------------------------------------------------------------------------
// `decide()` accepts only a strict `true` from `recordDecision`, and both a `false` return and a
// thrown error are caught into the same outcome (`qzone-operation-approval-console.mjs:76-82`):
// `finish(authorizationId, false)` closes the ticket and `decide()` returns `false`, i.e. the console
// is told "approval-unavailable" and the operation is NOT approved. So the two are equivalent there.
//
// This module returns `false` rather than throwing, for two reasons:
//   1. The broker's question is "answerable?" — a `false` answers it directly, and no exception has to
//      cross a boundary that swallows every detail anyway.
//   2. `recordDecision` must refuse for MANY non-exceptional reasons (a malformed operation, a digest
//      that does not agree with the snapshot, an operator charset the sink refuses). Wrapping those
//      into thrown errors would make an ordinary refusal look like a crash.
// The failure stays VISIBLE through its consequence: the approval does not happen, the ticket is
// closed, and the console receives a refusal instead of an approval. This module does not add a
// second notification channel; it does not swallow the failure into an approval.
//
// ⚠️ WHY THE AUDIT ID IS THE QUADRUPLE DIGEST AND NOT THE TICKET UUID
// -------------------------------------------------------------------
// `prepare()` mints `authorizationId` with `randomUUID()` (`qzone-operation-authorization-offline.mjs:382`)
// INSIDE the composition. The runtime never sees the ticket, so if the approval row were keyed by that
// UUID, the runtime's intent/result rows could only be associated with it by heuristics. Both sides
// DO share the durable identity the B2 claim already uses — (accountId, sessionId, requestId, callId)
// — so the audit id is a digest of exactly that, computed by ONE exported function
// (`qzoneWriteAuditAuthorizationId`) on both sides. Consequence, stated rather than hidden: two
// dispatches of the same quadruple share one audit id. That is also what makes the "one send per
// quadruple" rule visible in the sink: the second attempt's intent write hits the existing
// `(authorizationId, 'intent')` row with different content and the sink throws
// `WRITE_AUDIT_ID_CONFLICT` — the write is refused, never sent twice.
//
// ⚠️ THE DIGEST IS RE-DERIVED AND CROSS-CHECKED, ON PURPOSE
// -------------------------------------------------------
// The approval row must carry the SAME `inputDigest` the dispatch rows carry, or the three rows
// describe three different operations. The authorizer's digest is authoritative for the approval
// (`operation.inputDigest`), while the runtime must compute its own (it has no operation). Their
// canonicalisations are independently written, so this module treats the authorizer's value as the
// reference: after re-deriving a digest it requires strict equality with `operation.inputDigest` and
// REFUSES the decision otherwise. A disagreement is therefore a loud, fail-closed refusal — never a
// silent pair of rows that look correlated and are not. The equality itself is verified end-to-end
// against the real authorizer in `scripts/test-qzone-write-audit-runtime-wiring.mjs`.
//
// ⚠️ THE BODY IS HASHED, NEVER STORED
// -----------------------------------
// `inputDigest` is `sha256` of a canonical rendering of the business input. The body itself is not a
// field of any row, not returned by the frame builder, and not written anywhere here. As the sink's
// header warns, a digest of a low-entropy body is a verifier, not a redaction.
//
// WHAT THIS IS NOT
// ----------------
//   · NOT an authentication of the console, the operator, the host or the transport.
//   · NOT a claim that a decision implies a successful write, or that an outcome implies platform
//     confirmation (`send` is injected everywhere in this repository).
//   · NOT a second audit trail: it writes only through the injected sink, and it never touches
//     `state.audit`, `settled`, `settleKeyFor` or `formatAuditRecord`.

import { createHash } from 'node:crypto';

import { isSafeQzoneAuditId } from './qzone-audit-offline.mjs';
import { _MAX_NAME_LENGTH, _REDACTED_NAME } from './qzone-write-audit-offline.mjs';

/** The write actions the sink knows. Anything else is refused rather than stamped. */
const ACTIONS = new Set(['publish', 'comment', 'reply', 'like']);

/** The visibilities the platform contract accepts (`qzone-onebot-write-contract.mjs`). */
const UGC_RIGHTS = new Set([1, 4, 16, 64, 128]);

/** Visibilities that MUST name their recipients, mirroring the builder's own rule. */
const NEEDS_RECIPIENTS = new Set([16, 128]);

/** The MCP contract's recipient cap. */
const MAX_RECIPIENTS = 1000;

/**
 * The charset an operator session id must satisfy on the way IN (`qzone-operation-approval-console.mjs:4`,
 * the same regex the console gateway's `verifySession` result is validated against).
 */
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** A QQ identity written as a decimal string, as the MCP contract allows. */
const QQ_TEXT = /^[1-9][0-9]*$/;

/** Recursion cap for the canonical rendering. The MCP contract's inputs are two levels deep. */
const MAX_DEPTH = 8;

/**
 * The audit id of one authorisation: a digest of the B2 quadruple.
 *
 * WHY THIS AND NOT THE TICKET UUID — see the module header ("WHY THE AUDIT ID IS THE QUADRUPLE
 * DIGEST"). It is a pure function of the four durable identities, so the approval side (which has the
 * operation) and the dispatch side (which has the consumption) compute the same value without
 * exchanging anything.
 *
 * @returns 32 lowercase hex characters, which `isSafeQzoneAuditId` accepts.
 */
export function qzoneWriteAuditAuthorizationId({ accountId, sessionId, requestId, callId } = {}) {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new TypeError('invalid write audit account id');
  if (!isSafeQzoneAuditId(sessionId)) throw new TypeError('invalid write audit session id');
  if (!isSafeQzoneAuditId(requestId)) throw new TypeError('invalid write audit request id');
  if (!isSafeQzoneAuditId(callId)) throw new TypeError('invalid write audit call id');
  return createHash('sha256')
    .update(`qzone-write-audit\n${accountId}\n${sessionId}\n${requestId}\n${callId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/**
 * One canonical rendering of a business input, for the digest.
 *
 * The shape rules mirror the authorizer's `serialize()`
 * (`qzone-operation-authorization-offline.mjs:142-198`) because the two values must be EQUAL for the
 * same input — object keys sorted, arrays in order, scalars as JSON literals — but this copy is
 * deliberately narrower: it accepts only what the MCP contract can produce and refuses everything
 * else (no `undefined`, no non-finite numbers, no accessors, no exotic prototypes, no sparse arrays).
 * A narrower accept-set can only turn an unexpected input into a refusal, never into a different
 * digest that silently matches.
 */
function canonicalInput(value, depth = 0) {
  if (depth > MAX_DEPTH) throw new TypeError('write audit input is too deep');
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('write audit input has a non-finite number');
    return JSON.stringify(value);
  }
  if (type !== 'object') throw new TypeError('write audit input has an unsupported value');
  if (Array.isArray(value)) {
    // `length` is the one non-enumerable own property of every array; anything else is refused
    // (including an own index property that is not enumerable, and any extra named property).
    if (Reflect.ownKeys(value).length !== value.length + 1) {
      throw new TypeError('write audit input has an unsupported array');
    }
    const parts = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('write audit input has an unsupported array entry');
      }
      parts.push(canonicalInput(descriptor.value, depth + 1));
    }
    return `[${parts.join(',')}]`;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new TypeError('write audit input is not a plain object');
  const names = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError('write audit input has a symbol key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new TypeError('write audit input has an unsupported property');
    }
    names.push(key);
  }
  // Default sort is UTF-16 code unit order: deterministic and locale-independent.
  names.sort();
  const parts = names.map((name) => `${JSON.stringify(name)}:${canonicalInput(value[name], depth + 1)}`);
  return `{${parts.join(',')}}`;
}

/** `sha256` of the canonical rendering — the value both sides put in `inputDigest`. */
function inputDigestOf(input) {
  return createHash('sha256').update(canonicalInput(input), 'utf8').digest('hex');
}

/**
 * A QQ identity as a positive safe integer, or `null`.
 *
 * The MCP contract accepts an integer or its canonical decimal string, and the sink stores integers
 * only, so a string must be converted here rather than reformatted later.
 */
function qqInt(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value === 'string' && QQ_TEXT.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/** Read a recipient list as integers. Throws (fail closed) on anything the sink would refuse. */
function recipientsOf(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RECIPIENTS) {
    throw new TypeError('invalid write audit recipients');
  }
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('invalid write audit recipients');
    const uin = qqInt(descriptor.value);
    if (uin === null) throw new TypeError('invalid write audit recipients');
    out.push(uin);
  }
  return out;
}

/**
 * Screen a reply's display name DOWN TO WHAT THE SINK CAN STORE.
 *
 * `reply_name` is `text` in the MCP contract (up to 100000 characters) while the sink caps the name
 * at `_MAX_NAME_LENGTH` and REDRACTS an unsafe one with the fixed marker `_REDACTED_NAME`. Without
 * this step a long-but-legal name would make the whole frame unbuildable and, with the runtime's
 * opt-in wiring, turn an otherwise-sendable reply into a refusal — an availability regression caused
 * by the audit, which is not acceptable. So an over-long name is replaced by the sink's OWN marker
 * (imported, not re-spelled) and everything else is handed over for the sink to screen.
 */
function screenReplyName(value) {
  if (typeof value !== 'string') throw new TypeError('invalid write audit reply name');
  return value.length > _MAX_NAME_LENGTH ? _REDACTED_NAME : value;
}

/**
 * The action-specific business fields of the frame.
 *
 * Visibility and recipients are a PAIR in both the sink and the platform builder; a caller that must
 * produce one and not the other is refused rather than recorded half-populated.
 */
function businessFields(action, input) {
  if (action === 'publish') {
    const ugcRight = input.ugc_right;
    if (!UGC_RIGHTS.has(ugcRight)) throw new TypeError('invalid write audit visibility');
    const hasRecipients = input.target_uins !== undefined && input.target_uins !== null;
    if (NEEDS_RECIPIENTS.has(ugcRight) !== hasRecipients) throw new TypeError('invalid write audit recipients');
    return {
      ugcRight,
      targetUins: hasRecipients ? recipientsOf(input.target_uins) : null,
      commentId: null,
      commentUin: null,
      replyUin: null,
      replyName: null,
    };
  }
  if (action === 'reply') {
    const commentId = input.comment_id;
    if (!isSafeQzoneAuditId(commentId)) throw new TypeError('invalid write audit comment id');
    const commentUin = qqInt(input.comment_uin);
    if (commentUin === null) throw new TypeError('invalid write audit comment uin');
    const hasReplyUin = input.reply_uin !== undefined && input.reply_uin !== null;
    const hasReplyName = input.reply_name !== undefined && input.reply_name !== null;
    // The platform contract treats the pair as all-or-nothing; a half pair is refused here instead of
    // being stored as "answered whoever".
    if (hasReplyUin !== hasReplyName) throw new TypeError('invalid write audit reply target');
    let replyUin = null;
    let replyName = null;
    if (hasReplyUin) {
      replyUin = qqInt(input.reply_uin);
      if (replyUin === null) throw new TypeError('invalid write audit reply target');
      replyName = screenReplyName(input.reply_name);
    }
    return { ugcRight: null, targetUins: null, commentId, commentUin, replyUin, replyName };
  }
  // `comment` and `like` carry none of these. A stray one is refused by the MCP contract before it can
  // reach here; the frame simply records that this operation names no parent comment and no receipt.
  return { ugcRight: null, targetUins: null, commentId: null, commentUin: null, replyUin: null, replyName: null };
}

/**
 * Build the OPERATION FRAME one row is written with.
 *
 * The frame is the same on every stage of one authorisation (approval / intent / result); `time` is
 * the only field that differs, because it is the moment THAT fact was recorded. The idempotency key is
 * `(authorizationId, stage)`, so a re-write of the same stage with a different `time` conflicts and is
 * refused by the sink — which is the intended reading of "the same fact cannot be recorded twice with
 * two different timestamps".
 *
 * @returns a frozen object with exactly the sink's accepted field names.
 * @throws {TypeError} on any malformed or unrepresentable input. Callers turn that into a refusal
 *   (the broker adapter returns `false`; the runtime refuses to send).
 */
export function buildQzoneWriteAuditFrame({
  accountId, sessionId, requestId, callId, connectionEpoch, action, input, time,
} = {}) {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new TypeError('invalid write audit account id');
  if (!isSafeQzoneAuditId(sessionId)) throw new TypeError('invalid write audit session id');
  if (!isSafeQzoneAuditId(requestId)) throw new TypeError('invalid write audit request id');
  if (!isSafeQzoneAuditId(callId)) throw new TypeError('invalid write audit call id');
  if (!Number.isSafeInteger(connectionEpoch) || connectionEpoch < 0) {
    throw new TypeError('invalid write audit connection epoch');
  }
  if (typeof action !== 'string' || !ACTIONS.has(action)) throw new TypeError('invalid write audit action');
  if (!Number.isFinite(time)) throw new TypeError('invalid write audit time');
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('invalid write audit input');
  }
  const fields = businessFields(action, input);
  return Object.freeze({
    authorizationId: qzoneWriteAuditAuthorizationId({ accountId, sessionId, requestId, callId }),
    time,
    accountId,
    sessionId,
    requestId,
    callId,
    connectionEpoch,
    action,
    inputDigest: inputDigestOf(input),
    ugcRight: fields.ugcRight,
    targetUins: fields.targetUins === null ? null : Object.freeze(fields.targetUins),
    commentId: fields.commentId,
    commentUin: fields.commentUin,
    replyUin: fields.replyUin,
    replyName: fields.replyName,
  });
}

/**
 * Build the `recordDecision` callback the approval broker accepts.
 *
 * @param audit - the write-audit sink (`createQzoneWriteAudit`): an object with `recordWrite`. Only
 *   that method is used, so the sink's own shape is not re-checked here.
 * @param clock - trusted clock, integer milliseconds.
 * @returns `(decision) => boolean` — strict `true` only when the approval row is durably stored.
 *
 * It NEVER throws: a malformed operation, an unrepresentable business input, a digest disagreement, a
 * refused operator charset and a failing store all become `false`, which the broker turns into a
 * closed ticket (`qzone-operation-approval-console.mjs:76-82`). An approval that cannot be recorded
 * therefore cannot happen.
 */
export function createQzoneApprovalAuditRecorder({ audit, clock } = {}) {
  if (!audit || typeof audit.recordWrite !== 'function') {
    throw new TypeError('approval audit recorder needs a write audit sink with recordWrite');
  }
  if (typeof clock !== 'function') throw new TypeError('approval audit recorder needs a clock function');

  return function recordDecision(decision) {
    try {
      if (decision === null || typeof decision !== 'object') return false;
      const { operation, operator, approved } = decision;
      if (typeof approved !== 'boolean') return false;
      // The broker already validates this (it only calls a recorder when the operator is a safe id);
      // re-checking is cheap and keeps the recorder honest when called directly.
      if (typeof operator !== 'string' || !SESSION_ID.test(operator)) return false;
      if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) return false;
      const time = clock();
      const frame = buildQzoneWriteAuditFrame({
        accountId: operation.accountId,
        sessionId: operation.sessionId,
        requestId: operation.requestId,
        callId: operation.callId,
        connectionEpoch: operation.connectionEpoch,
        action: operation.action,
        input: operation.input,
        time,
      });
      // The authorizer's digest is the reference (see "THE DIGEST IS RE-DERIVED AND CROSS-CHECKED").
      // A disagreement means the two canonicalisations drifted; refuse the decision rather than write
      // a row that claims to describe the approved snapshot and does not.
      if (typeof operation.inputDigest !== 'string' || frame.inputDigest !== operation.inputDigest) {
        return false;
      }
      // The three axes are passed as three separate arguments on purpose: the decision says WHO and
      // WHAT, the stage says WHICH FACT, and the outcome is `null` here because a decision is not a
      // result. The sink refuses any other combination.
      audit.recordWrite(frame, 'approval', Object.freeze({
        operatorSessionId: operator,
        decidedAt: time,
        decision: approved ? 'approved' : 'rejected',
      }), null);
      return true;
    } catch {
      // Deliberately `false`, not a rethrow — see "STORE FAILURE" in the module header.
      return false;
    }
  };
}

export {
  ACTIONS as _ACTIONS,
  NEEDS_RECIPIENTS as _NEEDS_RECIPIENTS,
  canonicalInput as _canonicalWriteAuditInput,
  inputDigestOf as _writeAuditInputDigest,
};
