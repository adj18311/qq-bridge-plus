// Loopback HTTP client for the cross-process approval channel — plugin-process side.
//
// WHAT THIS IS
// ------------
// 'createQzoneApprovalIpcClient' returns an 'approveOperation' whose signature and verdict match
// the in-process broker's ('qzone-operation-approval-console.mjs:40'), so it can be dropped
// straight into 'createQzoneOperationAuthorizer({ approveOperation })'. The authorizer accepts a
// promise and requires a STRICT true ('qzone-operation-authorization-offline.mjs:304-329'); every
// other outcome is "not approved".
//
// THE FAILURE MATRIX, IN ONE SENTENCE
// -----------------------------------
// Timeout, connection refused, socket reset mid-flight, non-2xx, unreadable or oversized body,
// invalid JSON, a frame with any other shape, and "the operation itself is not carryable" ALL
// resolve to 'false'. Nothing here throws, nothing retries, and a name/body is never logged.
//
// WHY THERE IS NO RETRY (and why a disconnect is final)
// -----------------------------------------------------
// A retry would ask a SECOND time — after a timeout, the first ask may still be pending in the
// broker, and the host would then show the operator two tickets for one operation. An unknown
// outcome must stay unknown: 'false' means "not approved", and the authorizer refuses. There is
// no reconnect buffer, no queue and no replay: once the request has failed, this client forgets it.
//
// DUPLICATE SUPPRESSION IS ABOUT THE WIRE, NOT ABOUT WRITES
// --------------------------------------------------------
// Concurrent calls carrying the SAME authorizationId AND THE SAME FRAME share one in-flight request
// and therefore one answer: the second caller awaits the first promise instead of opening a second
// connection. Same id with a DIFFERENT frame is answered 'false' outright — handing it the first
// ask's verdict would let an unreviewed body inherit an approval. Either way this only stops the
// PLUGIN from asking twice over one channel. It does NOT make a platform write happen once — the
// durable B2 claim ('authorizer.claim') is what does that. And once a call has SETTLED the entry is
// dropped, so an id that is asked about again really is sent again, and the broker answers 'false'
// for an id it already has pending.
//
// WHAT THE TOKEN MEANS
// --------------------
// The bearer token authenticates the CHANNEL to a listener that was already trusted with it. It
// does not authenticate a human, and it does not decide anything: the operator does, through the
// console. This client never reads a credential from disk or the environment — the caller injects
// it.

import {
  QZONE_APPROVAL_IPC_MAX_RESPONSE_BYTES,
  QZONE_APPROVAL_IPC_PATH,
  readQzoneApprovalResponseFrame,
  serializeQzoneApprovalRequestFrame,
} from './qzone-approval-ipc-protocol.mjs';

const TOKEN = /^[\x21-\x7E]{16,512}$/;
const DEFAULT_TIMEOUT_MS = 30000;

/** A loopback http(s) origin, with no path: the path is fixed by the protocol. */
function readOrigin(origin) {
  if (typeof origin !== 'string') return null;
  let parsed;
  try { parsed = new URL(origin); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]' && parsed.hostname !== '::1') return null;
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  return parsed.origin;
}

/**
 * Read at most 'maxBytes' of a response body.
 *
 * Returns null when the body is longer than the cap. Reading through a reader instead of
 * 'await response.text()' is what makes the cap real: the answer is two fields, so a larger body is
 * by definition not this protocol's answer.
 */
async function readCappedText(response, maxBytes) {
  const stream = response.body;
  if (stream === null || typeof stream !== 'object' || typeof stream.getReader !== 'function') {
    // No stream (e.g. a synthetic Response): fall back to text() but enforce the cap afterwards.
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > maxBytes ? null : text;
  }
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) break;
      const chunk = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
      size += chunk.length;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch {}
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/**
 * Build the client.
 *
 * @param {object} options
 * @param {string} options.origin    e.g. 'http://127.0.0.1:41234' (loopback only).
 * @param {string} options.token      Bearer token, 16–512 printable ASCII characters.
 * @param {number} [options.timeoutMs] Per-ask budget (default 30000, capped at 120000).
 * @param {() => number} [options.clock]  Trusted clock; used only to skip an operation that has
 *   already expired, so a hopeless ask never opens a socket.
 * @returns {{ approveOperation: (operation: object) => Promise<boolean>, close: () => Promise<void> }}
 */
export function createQzoneApprovalIpcClient({ origin, token, timeoutMs = DEFAULT_TIMEOUT_MS, clock = Date.now } = {}) {
  const base = readOrigin(origin);
  if (base === null) throw new TypeError('approval ipc client needs a loopback http origin such as http://127.0.0.1:1234');
  if (typeof token !== 'string' || TOKEN.test(token) === false) {
    throw new TypeError('approval ipc client needs a 16-512 character printable bearer token supplied by the caller');
  }
  if (typeof clock !== 'function') throw new TypeError('approval ipc client needs a clock function');
  if (Number.isSafeInteger(timeoutMs) === false || timeoutMs < 1 || timeoutMs > 120000) {
    throw new TypeError('approval ipc client needs a timeoutMs between 1 and 120000');
  }

  const endpoint = base + QZONE_APPROVAL_IPC_PATH;
  /** authorizationId -> { promise, body } for asks that have not settled yet. */
  const inFlight = new Map();
  /** Aborts every ask still on the wire when close() is called. */
  const pending = new Set();
  let closed = false;

  /**
   * One real request. Never throws; every failure resolves 'false'.
   *
   * 'signal' is the caller's per-ask controller so close() can abort it. The connect/read budget is
   * enforced by the SAME signal, so there is exactly one deadline per ask.
   */
  async function send(body, signal) {
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json',
        },
        body,
        signal,
        // A redirect would silently re-POST somewhere else; refusing it keeps the endpoint fixed.
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch {
      return false;
    }
    try {
      if (response.status < 200 || response.status > 299) {
        try { await response.body?.cancel?.(); } catch {}
        return false;
      }
      const text = await readCappedText(response, QZONE_APPROVAL_IPC_MAX_RESPONSE_BYTES);
      if (text === null) return false;
      let parsed;
      try { parsed = JSON.parse(text); } catch { return false; }
      // The ONLY approval is the closed { ok: true, approved: true } frame; everything else is a
      // refusal, including a well-formed 'approved: "true"' or an extra key.
      return readQzoneApprovalResponseFrame(parsed) === true;
    } catch {
      return false;
    }
  }

  /** Ask once, honouring the deadline, and resolve a boolean no matter what happens. */
  async function ask(body, controller) {
    let timer = null;
    try {
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => {
          try { controller.abort(); } catch {}
          resolve(false);
        }, timeoutMs);
      });
      const answer = await Promise.race([send(body, controller.signal), deadline]);
      return answer === true;
    } catch {
      return false;
    } finally {
      if (timer !== null) clearTimeout(timer);
      pending.delete(controller);
    }
  }

  /**
   * Signature-compatible with 'broker.approveOperation'.
   *
   * Always resolves a boolean; never rejects. A closed client, an operation that has already
   * expired, and an operation this protocol cannot carry all answer 'false' without a request.
   */
  async function approveOperation(operation) {
    if (closed) return false;
    let authorizationId;
    try {
      authorizationId = operation !== null && typeof operation === 'object' ? operation.authorizationId : undefined;
    } catch {
      return false;
    }
    const key = typeof authorizationId === 'string' ? authorizationId : null;

    const body = serializeQzoneApprovalRequestFrame(operation);
    if (body === null) return false;

    let now;
    try { now = clock(); } catch { return false; }
    if (Number.isSafeInteger(now) === false) return false;
    // Read the expiry through a guard: the caller's object may be a Proxy or carry a getter, and a
    // throw here would turn a refusal into a rejection the authorizer would have to swallow.
    let expiresAt;
    try { expiresAt = operation.expiresAt; } catch { return false; }
    if (Number.isSafeInteger(expiresAt) === false || expiresAt <= now) return false;

    // A concurrent ask for the SAME ID AND THE SAME FRAME shares the first answer instead of
    // opening a second socket. Same id with a DIFFERENT frame is refused outright: handing it the
    // first ask's verdict would let an unreviewed body inherit an approval.
    if (key !== null) {
      const existing = inFlight.get(key);
      if (existing !== undefined) {
        return existing.body === body ? existing.promise : false;
      }
    }

    const controller = new AbortController();
    pending.add(controller);
    const promise = ask(body, controller);
    if (key !== null) {
      const entry = { promise, body };
      inFlight.set(key, entry);
      try {
        return await promise;
      } finally {
        if (inFlight.get(key) === entry) inFlight.delete(key);
      }
    }
    return await promise;
  }

  /** Abort everything on the wire; pending asks resolve 'false'. Idempotent. */
  async function close() {
    closed = true;
    for (const controller of pending) {
      try { controller.abort(); } catch {}
    }
    pending.clear();
    inFlight.clear();
  }

  return Object.freeze({ approveOperation, close });
}
