// Wire format for the cross-process approval channel (offline composition only).
//
// WHY THIS MODULE EXISTS
// ----------------------
// The approval broker ('qzone-operation-approval-console.mjs:16') lives in the bridge process; the
// authorizer that needs its verdict ('qzone-operation-authorization-offline.mjs:304-329') lives in
// the plugin process. This module is the only thing the two sides share: a frame reader/serializer,
// a response reader and the size caps. It performs no I/O, holds no state and never touches the
// network — the server and the client do that.
//
// WHAT A FRAME IS
// ---------------
//   { "authorizationId": "<id>", "inputDigest": "<64 hex>", "operation": { ...12 keys... } }
//
// Both key sets are CLOSED. One extra key, one missing key, an accessor property or a non-plain
// prototype is refused. Key-set closedness is also how the "no ledger consumption crosses the
// channel" rule is enforced: a consumption is a module-level WeakMap entry
// ('qzone-origin-ledger-offline.mjs:20-26') that means nothing in another process, and it cannot
// be spelled with any accepted key, so a frame carrying one is refused by construction. The check
// is on the KEY SET ONLY. String content is never screened: a comment whose text happens to
// contain the word "consumption" is ordinary business text and is accepted.
//
// SIZE LIMIT — WHY 2 MiB AND NOT 64 KiB
// -------------------------------------
// 'content' and 'reply_name' are 'text' in the tool contract: up to 100000 characters each
// ('qzone-mcp-contract.mjs:9'). JSON escaping costs up to 6 bytes per character (control chars),
// so one maximum-length field is <= 600000 bytes on the wire and a 'reply' can carry TWO of them
// (content + reply_name) => ~1200000 bytes, plus up to 1000 recipients in 'target_uins'
// (~20000 bytes) and the fixed fields. A 64 KiB cap — or even 512 KiB — would therefore refuse
// input the business contract explicitly allows: an availability regression, not hardening.
// 2 MiB covers the computed worst case with margin and still bounds the exposure, because the body
// is buffered in memory before it is parsed and this cap is what stops a hostile local peer from
// making the host allocate without limit.
//
// WHERE THE DIGEST IS CHECKED, AND WHAT IT CANNOT PROVE
// -----------------------------------------------------
// Two checks happen here: (a) the frame's authorizationId/inputDigest must equal the operation's,
// and (b) sha256(canonical(operation.input)) must equal inputDigest, so the digest always
// describes the body carried in the same frame. Both use the SAME canonicalisation the approval
// recorder uses ('_writeAuditInputDigest'), so the two ends cannot drift apart.
// This layer still CANNOT see the authorizer's in-process frozen snapshot or its branded
// consumption (different process, WeakMap identity). The authoritative correlation is completed by
// 'recordDecision' inside the broker ('createQzoneApprovalAuditRecorder',
// 'qzone-write-audit-broker-adapter-offline.mjs:357-403'): it re-derives the digest from the
// operation and refuses the decision when it disagrees with operation.inputDigest. What this
// module adds is narrower and still worth having: a frame cannot even ASK the question with a
// digest that contradicts the body it carries.
//
// FAILURE STYLE
// -------------
// Every export is TOTAL: invalid input becomes null / false, never an exception, because both
// callers (an HTTP handler and a plugin callback) have to answer in one closed value anyway.

import { validateQzoneMcpInput } from './qzone-mcp-contract.mjs';
import { _writeAuditInputDigest } from './qzone-write-audit-broker-adapter-offline.mjs';

/** The only path the server answers; every other path is a 404. */
export const QZONE_APPROVAL_IPC_PATH = '/approve';

/** Hard cap on one request frame. Derivation in the header — do not shrink it to 64 KiB. */
export const QZONE_APPROVAL_IPC_MAX_FRAME_BYTES = 2 * 1024 * 1024;

/** Cap on the response the client reads: the answer is two fields, so 8 KiB is generous. */
export const QZONE_APPROVAL_IPC_MAX_RESPONSE_BYTES = 8 * 1024;

/** Closed key set of the request frame. */
export const QZONE_APPROVAL_FRAME_KEYS = Object.freeze(['authorizationId', 'inputDigest', 'operation']);

/**
 * Closed key set of the operation — exactly what the authorizer mints
 * ('qzone-operation-authorization-offline.mjs:371-384') and what the broker snapshots for the
 * console. 'sourceEpoch' and 'origin' are part of it: the console must show the same semantic
 * operation the plugin asked about, and dropping them would make the frame a different object than
 * the one the authorizer froze.
 */
export const QZONE_APPROVAL_OPERATION_KEYS = Object.freeze([
  'accountId', 'sessionId', 'requestId', 'callId', 'sourceEpoch', 'connectionEpoch', 'origin',
  'action', 'input', 'inputDigest', 'authorizationId', 'expiresAt',
]);

/** Closed key set of the response frame. */
export const QZONE_APPROVAL_RESPONSE_KEYS = Object.freeze(['ok', 'approved']);

/** The actions the tool contract knows; anything else is refused before the broker sees it. */
const ACTIONS = new Set(['read_posts', 'read_comments', 'publish', 'comment', 'reply', 'like']);

const AUTHORIZATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const EPOCH = /^[A-Za-z0-9_.:-]{1,128}$/;
const ORIGIN = /^[A-Za-z0-9_.:-]{1,64}$/;
/**
 * session/request/call ids are only bounded (non-empty, <= 128, no control characters) because
 * that is the whole rule the authorizer applies to them
 * ('qzone-operation-authorization-offline.mjs:356-358'), and the origin ledger's
 * registerBridgeRequest only checks non-empty and <= 128 as well. A tighter charset here would
 * refuse identifiers the rest of the tree already accepts.
 */
const ID_TEXT = /^[^\u0000-\u001F\u007F]{1,128}$/;

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Read a record of exactly the given own DATA properties, or null.
 *
 * Accessors, extra keys, missing keys and exotic prototypes all return null: this data arrives
 * from another process, and a value that needs a getter to be read is not data this module will
 * bind. A hostile Proxy makes ownKeys/getPrototypeOf throw, which the callers turn into a refusal.
 */
function readClosedRecord(value, keys) {
  try {
    if (!isPlainObject(value)) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length) return null;
    for (const key of own) {
      if (typeof key !== 'string' || keys.includes(key) === false) return null;
    }
    const out = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || Object.hasOwn(descriptor, 'value') === false) return null;
      out[key] = descriptor.value;
    }
    return out;
  } catch {
    return null;
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * Validate one operation and return a frozen plain copy, or null.
 *
 * This is the same shape the broker accepts, checked strictly enough that nothing but a
 * well-formed operation reaches the broker. It is NOT a policy decision: whether this action may
 * be approved, and whether the body is the one a human should see, is the broker's and the
 * recorder's question.
 */
export function readQzoneApprovalOperation(operation) {
  try {
    const op = readClosedRecord(operation, QZONE_APPROVAL_OPERATION_KEYS);
    if (op === null) return null;
    if (typeof op.authorizationId !== 'string' || AUTHORIZATION_ID.test(op.authorizationId) === false) return null;
    if (typeof op.inputDigest !== 'string' || DIGEST.test(op.inputDigest) === false) return null;
    if (Number.isSafeInteger(op.accountId) === false || op.accountId <= 0) return null;
    if (typeof op.sessionId !== 'string' || ID_TEXT.test(op.sessionId) === false) return null;
    if (typeof op.requestId !== 'string' || ID_TEXT.test(op.requestId) === false) return null;
    if (typeof op.callId !== 'string' || ID_TEXT.test(op.callId) === false) return null;
    if (typeof op.sourceEpoch !== 'string' || EPOCH.test(op.sourceEpoch) === false) return null;
    if (Number.isSafeInteger(op.connectionEpoch) === false || op.connectionEpoch < 0) return null;
    if (typeof op.origin !== 'string' || ORIGIN.test(op.origin) === false) return null;
    if (typeof op.action !== 'string' || ACTIONS.has(op.action) === false) return null;
    if (Number.isSafeInteger(op.expiresAt) === false || op.expiresAt <= 0) return null;
    if (isPlainObject(op.input) === false) return null;
    // The tool contract is the authority on what a business input may look like. Using the real
    // validator means this channel cannot invent a looser input language than the tool itself.
    if (validateQzoneMcpInput(op.action, op.input) === false) return null;
    // Correlation (b): the digest must describe the body carried in the same frame.
    let digest;
    try { digest = _writeAuditInputDigest(op.input); } catch { return null; }
    if (digest !== op.inputDigest) return null;
    return deepFreeze(Object.assign(Object.create(null), op));
  } catch {
    return null;
  }
}

/**
 * Validate one request frame given as a PARSED value. Returns a frozen
 * { authorizationId, inputDigest, operation } or null.
 *
 * Correlation (a) lives here: the envelope ids must be the operation's own ids. A frame whose
 * envelope disagrees with the operation inside it is refused rather than resolved in favour of
 * either one.
 */
export function readQzoneApprovalRequestFrame(value) {
  try {
    const frame = readClosedRecord(value, QZONE_APPROVAL_FRAME_KEYS);
    if (frame === null) return null;
    if (typeof frame.authorizationId !== 'string' || AUTHORIZATION_ID.test(frame.authorizationId) === false) return null;
    if (typeof frame.inputDigest !== 'string' || DIGEST.test(frame.inputDigest) === false) return null;
    const operation = readQzoneApprovalOperation(frame.operation);
    if (operation === null) return null;
    if (operation.authorizationId !== frame.authorizationId) return null;
    if (operation.inputDigest !== frame.inputDigest) return null;
    return deepFreeze({
      authorizationId: frame.authorizationId,
      inputDigest: frame.inputDigest,
      operation,
    });
  } catch {
    return null;
  }
}

/**
 * Parse and validate one request frame from its wire text (a UTF-8 string or a Buffer).
 *
 * The byte cap is applied BEFORE JSON.parse, so an oversized body is refused without ever being
 * materialised as a JS value. Returns the same shape as readQzoneApprovalRequestFrame, or null.
 */
export function parseQzoneApprovalRequestFrame(text) {
  try {
    let source;
    if (typeof text === 'string') source = text;
    else if (Buffer.isBuffer(text)) source = text;
    else return null;
    const bytes = typeof source === 'string' ? Buffer.byteLength(source, 'utf8') : source.length;
    if (bytes > QZONE_APPROVAL_IPC_MAX_FRAME_BYTES) return null;
    if (bytes === 0) return null;
    const parsed = JSON.parse(typeof source === 'string' ? source : source.toString('utf8'));
    return readQzoneApprovalRequestFrame(parsed);
  } catch {
    return null;
  }
}

/**
 * Serialize one operation into request-frame text, or null when the operation is not a shape this
 * channel may carry (or would exceed the frame cap).
 */
export function serializeQzoneApprovalRequestFrame(operation) {
  try {
    const op = readQzoneApprovalOperation(operation);
    if (op === null) return null;
    const text = JSON.stringify({
      authorizationId: op.authorizationId,
      inputDigest: op.inputDigest,
      operation: op,
    });
    if (Buffer.byteLength(text, 'utf8') > QZONE_APPROVAL_IPC_MAX_FRAME_BYTES) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Read one response frame. Returns strict true ONLY for exactly
 * { ok: true, approved: true }; everything else — ok:false, approved:false, approved:"true", a
 * missing key, an extra key, a non-object — is false. The client's whole verdict rides on this.
 */
export function readQzoneApprovalResponseFrame(value) {
  try {
    const frame = readClosedRecord(value, QZONE_APPROVAL_RESPONSE_KEYS);
    if (frame === null) return false;
    if (frame.ok !== true) return false;
    return frame.approved === true;
  } catch {
    return false;
  }
}

/** The one response shape this channel emits. 'approved' is coerced to a real boolean. */
export function serializeQzoneApprovalResponseFrame(approved) {
  return JSON.stringify({ ok: true, approved: approved === true });
}

/** The refusal shape: an explicit ok:false, so a reader can never mistake it for an approval. */
export function serializeQzoneApprovalRefusalFrame() {
  return JSON.stringify({ ok: false, approved: false });
}
