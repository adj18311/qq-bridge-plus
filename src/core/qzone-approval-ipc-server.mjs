// Loopback HTTP listener for the cross-process approval channel — bridge-process side.
//
// WHAT THIS IS
// ------------
// The bridge process owns the approval broker ('qzone-operation-approval-console.mjs:16'), whose
// 'approveOperation' resolves a Promise with strict true/false once an operator decides
// (or the ticket expires). The plugin process cannot call it directly, so this listener carries
// the question over 127.0.0.1 and carries only the ANSWER back:
//
//     POST /approve   Authorization: Bearer <token>
//     { authorizationId, inputDigest, operation }   ->   { ok: true, approved: <boolean> }
//
// WHAT THIS LAYER DOES **NOT** PROVIDE
// ------------------------------------
//   · It is NOT "exactly once send". Duplicate refusal here is a QUEUE property: while one
//     authorizationId is in flight, a second ask is answered 'approved:false' and never reaches
//     the broker, so one authorizationId cannot occupy two broker slots. Whether a platform write
//     happens twice is decided by the durable B2 claim ('authorizer.claim'), not here.
//   · It is NOT authentication of a human. The bearer token authenticates the CHANNEL to a process
//     that was already trusted with the token; whoever holds it can ask. The decision itself is
//     made by the console operator through the broker, and the audit row is written by the
//     broker's 'recordDecision' — not by this listener.
//   · It WITHDRAWS the broker ticket on timeout and on client disconnect
//     ('broker.withdraw(authorizationId)', '...approval-console.mjs'): the ask is abandoned, so the
//     ticket is closed silently — the waiter gets 'false', NO decision is recorded, and the
//     operator's console stops offering a button for a request nobody is waiting on any more.
//
// WHEN A TICKET IS WITHDRAWN, AND WHEN IT MUST NOT BE
// ---------------------------------------------------
// 'askBroker' races exactly three things and then asks WHICH ONE WON:
//   'waiting'  the broker settled — a decision was made. Withdraw is NEVER called on this path,
//              because the decision (and its audit row) is already durable and a real approval must
//              stay a real approval.
//   'expired'  this listener ran out of budget. The caller will be told 'approved:false', so the
//              ticket is withdrawn immediately instead of staying clickable for its remaining life.
//   'stopped'  the caller vanished (request aborted / socket closed / server closing). Same thing.
// A duplicate ask that is refused by the in-flight guard never reaches 'askBroker', so it cannot
// withdraw the OTHER ask's ticket. And withdraw itself is the last line of defence: it answers
// 'false' when nothing is pending, so a race that resolved in the meantime cannot destroy anything.
// A failed withdraw never changes the 'approved:false' already owed to the client.
//
// A TICKET THAT WAS WITHDRAWN LEAVES NO AUDIT ROW — deliberately. "No decision" is the truthful
// state of an abandoned request; writing a fake 'rejected' would put a human's name on a decision
// nobody made. An 'approval/approved' row is still written when an operator really approves, and
// that row is TRUE — it records the decision, not the dispatch: 'intent'/'result' rows answer
// "was it sent / what came back". Those two questions stay separate on purpose.
//
// The stale window is bounded anyway: a ticket cannot be enqueued more than MAX_WAIT_MS (30s)
// ahead ('...approval-console.mjs:6,47'), and with matched budgets the ticket's own timer fires
// first because it starts when the broker enqueues, before this listener's timer starts.
//
// FAIL-CLOSED POSTURE
// -------------------
//   · Listen address is restricted to a loopback literal; the port is ephemeral by default.
//   · The token is REQUIRED and supplied by the caller (never generated or read here), must be
//     16–512 printable ASCII characters, and is compared in constant time.
//   · Auth is checked BEFORE the path, so an unauthenticated peer cannot enumerate routes.
//   · Only 'POST /approve' exists: other paths 404, other methods 405.
//   · A body over the frame cap is refused (413) before it is parsed.
//   · Duplicate in-flight authorizationId -> approved:false without a second broker call.
//   · Broker wait exceeding 'timeoutMs' -> approved:false (the ticket stays with the broker).
//   · Any thrown error, invalid frame, broken clock or exhausted in-flight budget -> no approval.
//   · NOTHING about the request — body, token or ids — is written to any log. This module never
//     touches console.* and keeps no request history after the response is sent.

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import {
  QZONE_APPROVAL_IPC_MAX_FRAME_BYTES,
  QZONE_APPROVAL_IPC_PATH,
  parseQzoneApprovalRequestFrame,
  serializeQzoneApprovalRefusalFrame,
  serializeQzoneApprovalResponseFrame,
} from './qzone-approval-ipc-protocol.mjs';

/** Only a literal loopback address: 'localhost' would re-resolve through the hosts file. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1']);

/** A bearer token must be printable ASCII without whitespace, and long enough to matter. */
const TOKEN = /^[\x21-\x7E]{16,512}$/;

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_INFLIGHT = 32;
/** Hard cap on 'maxInflight' so a misconfiguration cannot turn the queue into an unbounded map. */
const MAX_INFLIGHT_CAP = 256;
/**
 * How much of an over-size body is read-and-discarded before the socket is dropped. Once the cap
 * has been exceeded the body is never buffered again; this only bounds total wall-clock work for a
 * peer that keeps streaming, since 'requestTimeout' alone would let it stream for that long.
 */
const OVERFLOW_DRAIN_BYTES = QZONE_APPROVAL_IPC_MAX_FRAME_BYTES * 4;

const JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

/**
 * Start the loopback listener.
 *
 * @param {object} options
 * @param {{ approveOperation: (operation: object) => unknown }} options.broker
 *   The host's approval broker. Only 'approveOperation' is used; its verdict is trusted to be the
 *   operator's, and only a strict 'true' is forwarded.
 * @param {string} options.token   Bearer token minted by the caller (never by this module).
 * @param {() => number} [options.clock]  Trusted clock, integer ms. Used for the staleness pre-check.
 * @param {string} [options.host]  '127.0.0.1' (default) or '::1'.
 * @param {number} [options.port]  0 (default) picks an ephemeral port; the chosen one is returned.
 * @param {number} [options.maxInflight]  Concurrent distinct authorizationIds (default 32).
 * @param {number} [options.timeoutMs]    How long one ask may wait for the broker (default 30000).
 * @returns {Promise<{ close: () => Promise<void>, port: number, address: string }>}
 */
export async function createQzoneApprovalIpcServer({
  broker, token, clock = Date.now, host = '127.0.0.1', port = 0,
  maxInflight = DEFAULT_MAX_INFLIGHT, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (broker === null || typeof broker !== 'object' || typeof broker.approveOperation !== 'function') {
    throw new TypeError('approval ipc server needs a broker with approveOperation');
  }
  if (typeof token !== 'string' || TOKEN.test(token) === false) {
    throw new TypeError('approval ipc server needs a 16-512 character printable bearer token supplied by the caller');
  }
  if (typeof clock !== 'function') throw new TypeError('approval ipc server needs a clock function');
  if (typeof host !== 'string' || LOOPBACK_ADDRESSES.has(host) === false) {
    throw new TypeError('approval ipc server only listens on a loopback address (127.0.0.1 or ::1)');
  }
  if (Number.isSafeInteger(port) === false || port < 0 || port > 65535) {
    throw new TypeError('approval ipc server needs a valid port');
  }
  if (Number.isSafeInteger(maxInflight) === false || maxInflight < 1 || maxInflight > MAX_INFLIGHT_CAP) {
    throw new TypeError('approval ipc server needs a maxInflight between 1 and ' + MAX_INFLIGHT_CAP);
  }
  if (Number.isSafeInteger(timeoutMs) === false || timeoutMs < 1 || timeoutMs > 120000) {
    throw new TypeError('approval ipc server needs a timeoutMs between 1 and 120000');
  }

  const expected = Buffer.from(token, 'utf8');
  /** authorizationId -> true. Presence alone means "a broker call for this id is still running". */
  const inFlight = new Map();
  /**
   * Resolvers that end an in-flight ask early. close() runs them all, so a shutting-down listener
   * does not keep its own per-ask timers (and the event loop) alive for up to 'timeoutMs' after the
   * sockets are gone.
   */
  const cancels = new Set();
  let closed = false;

  const server = http.createServer((request, response) => {
    // 'handle' is written to be total, but an unexpected throw must not become an unhandled
    // rejection that leaves the socket hanging: answer the closed refusal instead.
    handle(request, response).catch(() => {
      respond(response, 500, serializeQzoneApprovalRefusalFrame());
      discard(request);
    });
  });
  // Slow-loris bound: one ask must arrive and be answered within its own budget.
  server.headersTimeout = Math.min(timeoutMs + 5000, 30000);
  server.requestTimeout = timeoutMs + 5000;
  server.keepAliveTimeout = 5000;

  server.on('clientError', (_error, socket) => {
    try { socket.destroy(); } catch {}
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen({ host, port, exclusive: true });
    } catch (error) {
      // A synchronous listen failure (bad options) must reject, never escape as a throw: the
      // caller handles both the same way.
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
      reject(error);
    }
  });

  const bound = server.address();
  if (bound === null || typeof bound !== 'object' || LOOPBACK_ADDRESSES.has(bound.address) === false) {
    await new Promise((resolve) => server.close(() => resolve()));
    throw new Error('approval ipc server refused to start: the bound address is not loopback');
  }

  // A post-listen 'error' would otherwise be an unhandled event that kills the host process. It
  // does not approve anything; it turns the listener into a closed one, so every later ask is
  // answered with the refusal frame instead of a hang.
  server.on('error', () => { closed = true; });

  function respond(response, status, body, extraHeaders) {
    try {
      if (response.writableEnded === true || response.destroyed === true) return;
      response.writeHead(status, extraHeaders === undefined ? JSON_HEADERS : { ...JSON_HEADERS, ...extraHeaders });
      response.end(body);
    } catch {
      try { response.destroy(); } catch {}
    }
  }

  /** Discard whatever is left of a body we are not going to read, without buffering it. */
  function discard(request) {
    try { request.resume(); } catch {}
  }

  /**
   * Constant-time bearer check.
   *
   * A length mismatch is reported before the comparison (timingSafeEqual throws on differing
   * lengths); the length of a bearer token is not the secret, its value is.
   */
  function isAuthorized(request) {
    const header = request.headers.authorization;
    if (typeof header !== 'string') return false;
    if (header.startsWith('Bearer ') === false) return false;
    const supplied = Buffer.from(header.slice(7), 'utf8');
    if (supplied.length !== expected.length) return false;
    try { return timingSafeEqual(supplied, expected); } catch { return false; }
  }

  /** The request target's path, with the query string dropped. Never decoded: '/approve' is exact. */
  function pathOf(url) {
    if (typeof url !== 'string') return null;
    const mark = url.indexOf('?');
    return mark === -1 ? url : url.slice(0, mark);
  }

  /**
   * Read one request body up to the frame cap.
   *
   * Resolves to { ok: true, buffer } or { ok: false, status }. The cap is enforced WHILE reading,
   * so an oversized body is never accumulated; the rest of it is discarded only up to
   * OVERFLOW_DRAIN_BYTES and the socket is then dropped.
   */
  function readBody(request) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      let drained = 0;
      let overflow = false;
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        request.removeListener('data', onData);
        request.removeListener('end', onEnd);
        request.removeListener('error', onError);
        request.removeListener('aborted', onAbort);
        resolve(result);
      };

      const deadline = setTimeout(() => {
        finish({ ok: false, status: 408 });
        try { request.destroy(); } catch {}
      }, timeoutMs);

      function onData(chunk) {
        if (overflow) {
          drained += chunk.length;
          if (drained > OVERFLOW_DRAIN_BYTES) {
            finish({ ok: false, status: 413 });
            try { request.destroy(); } catch {}
          }
          return;
        }
        size += chunk.length;
        if (size > QZONE_APPROVAL_IPC_MAX_FRAME_BYTES) {
          overflow = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      }

      function onEnd() {
        if (overflow) finish({ ok: false, status: 413 });
        else if (size === 0) finish({ ok: false, status: 400 });
        else finish({ ok: true, buffer: Buffer.concat(chunks, size) });
      }

      function onError() { finish({ ok: false, status: 400 }); }
      function onAbort() { finish({ ok: false, status: 400 }); }

      request.on('data', onData);
      request.on('end', onEnd);
      request.on('error', onError);
      request.on('aborted', onAbort);
    });
  }

  /**
   * Withdraw the broker ticket for an ask nobody is waiting for any more.
   *
   * Silent by design: no decision is recorded, so no audit row appears and no human is credited
   * with a rejection they never made. A broker without 'withdraw' is tolerated (the channel still
   * answers 'approved:false'; the ticket then lives out its own 'expiresAt') — this listener must
   * not crash over an optional capability, and it must never fake one.
   *
   * Failures are swallowed on purpose: the client is already owed an 'approved:false', and a
   * withdraw that came too late (a decision landed first) is a normal outcome, not an error.
   */
  function withdrawQuietly(authorizationId) {
    try {
      if (typeof broker.withdraw !== 'function') return false;
      return broker.withdraw(authorizationId) === true;
    } catch {
      return false;
    }
  }

  /**
   * Ask the broker and answer within 'timeoutMs'.
   *
   * Three racers, and the winner decides what happens to the ticket:
   *   'waiting' -> the broker settled: a decision was made. NOTHING is withdrawn.
   *   'expired' -> this listener's budget ran out: the ask is abandoned, so withdraw it.
   *   'stopped' -> the caller vanished (abort / socket close / shutdown): withdraw it too.
   * The in-flight entry is dropped either way, and a later ask for the same id is refused by the
   * broker itself ('...approval-console.mjs:48' answers false for an already-pending id), so the
   * queue still cannot hold two tickets for one authorizationId.
   */
  async function askBroker(authorizationId, operation, onAbandon) {
    inFlight.set(authorizationId, true);
    let timer = null;
    let cancel = null;
    const stopped = new Promise((resolve) => { cancel = () => resolve({ settledBy: 'stopped' }); });
    cancels.add(cancel);
    // The caller can also abandon the ask WITHOUT the request stream noticing (a keep-alive socket
    // that never carries the close event through the parser). Handing the canceller out lets the
    // handler below end the wait the moment the socket is gone, which is what makes the ticket get
    // withdrawn on disconnect instead of lingering.
    if (typeof onAbandon === 'function') {
      try { onAbandon(cancel); } catch { /* a broken hook must not break the ask */ }
    }
    try {
      let waiting;
      try {
        waiting = Promise.resolve(broker.approveOperation(operation))
          .then((value) => ({ settledBy: 'waiting', approved: value === true }),
            () => ({ settledBy: 'waiting', approved: false }));
      } catch {
        // The broker threw synchronously: it never took the ticket, so there is nothing to withdraw.
        return false;
      }
      const expired = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ settledBy: 'expired' }), timeoutMs);
      });
      const winner = await Promise.race([waiting, expired, stopped]);
      // ONLY the two abandon paths withdraw. If the broker won, the decision is already durable and
      // withdrawing would try to erase a real approval — 'withdraw' would refuse anyway because the
      // entry is gone, but the intent matters: this branch must never even ask.
      if (winner.settledBy !== 'waiting') withdrawQuietly(authorizationId);
      return winner.approved === true;
    } catch {
      return false;
    } finally {
      if (timer !== null) clearTimeout(timer);
      cancels.delete(cancel);
      inFlight.delete(authorizationId);
    }
  }

  async function handle(request, response) {
    if (closed) { respond(response, 503, serializeQzoneApprovalRefusalFrame()); discard(request); return; }
    if (isAuthorized(request) === false) {
      respond(response, 401, serializeQzoneApprovalRefusalFrame(), { 'WWW-Authenticate': 'Bearer' });
      discard(request);
      return;
    }
    if (pathOf(request.url) !== QZONE_APPROVAL_IPC_PATH) {
      respond(response, 404, serializeQzoneApprovalRefusalFrame());
      discard(request);
      return;
    }
    if (request.method !== 'POST') {
      respond(response, 405, serializeQzoneApprovalRefusalFrame(), { Allow: 'POST' });
      discard(request);
      return;
    }

    const body = await readBody(request);
    if (body.ok !== true) {
      respond(response, body.status, serializeQzoneApprovalRefusalFrame());
      return;
    }

    const frame = parseQzoneApprovalRequestFrame(body.buffer);
    if (frame === null) { respond(response, 400, serializeQzoneApprovalRefusalFrame()); return; }

    // A hopeless ask is answered without touching the broker, so a stale frame cannot occupy a
    // queue slot. The broker applies the same rule ('...approval-console.mjs:47'); this is only
    // the cheap version of it.
    let now;
    try { now = clock(); } catch { now = NaN; }
    if (Number.isSafeInteger(now) === false) { respond(response, 500, serializeQzoneApprovalRefusalFrame()); return; }
    if (frame.operation.expiresAt <= now) {
      respond(response, 200, serializeQzoneApprovalResponseFrame(false));
      return;
    }

    if (inFlight.has(frame.authorizationId)) {
      respond(response, 200, serializeQzoneApprovalResponseFrame(false));
      return;
    }
    if (inFlight.size >= maxInflight) {
      respond(response, 503, serializeQzoneApprovalRefusalFrame());
      return;
    }

    // A client that disappears mid-ask is an ABANDONED ask: 'response.close' fires both on a normal
    // finish and on a premature connection loss, so the "not ended yet" test is what tells them
    // apart. Aborting ends the wait, which lands in askBroker's 'stopped' branch and withdraws the
    // ticket. 'request.aborted' covers the same event from the request side.
    let abandoned = null;
    const onGone = () => {
      try { if (abandoned !== null) abandoned(); } catch {}
    };
    const onResponseClose = () => {
      if (response.writableEnded === false) onGone();
    };
    response.on('close', onResponseClose);
    request.on('aborted', onGone);
    try {
      const approved = await askBroker(frame.authorizationId, frame.operation, (cancel) => {
        abandoned = cancel;
        // The socket may already be gone by the time the hook is installed. Check the SOCKET, not
        // 'request.destroyed': an IncomingMessage is auto-destroyed once its body ends, so that flag
        // is already true for every healthy ask that got this far.
        if (response.destroyed === true || request.socket?.destroyed === true) cancel();
      });
      respond(response, 200, serializeQzoneApprovalResponseFrame(approved === true));
    } finally {
      response.removeListener('close', onResponseClose);
      request.removeListener('aborted', onGone);
    }
  }

  async function close() {
    if (closed === true) return;
    closed = true;
    // End every in-flight ask first: it resolves false, the per-ask timer is cleared in its
    // 'finally', and the guarantee "a timeout never approves" is preserved on shutdown too.
    for (const cancel of [...cancels]) {
      try { cancel(); } catch {}
    }
    cancels.clear();
    inFlight.clear();
    // Same-host clients hold keep-alive connections; without this the close callback waits on
    // them and the port is not actually released when close() resolves.
    try { server.closeAllConnections(); } catch {}
    await new Promise((resolve) => {
      try { server.close(() => resolve()); } catch { resolve(); }
    });
  }

  return Object.freeze({ close, port: bound.port, address: bound.address });
}
