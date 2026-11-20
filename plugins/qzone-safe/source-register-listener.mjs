// C13 — the PLUGIN-SIDE listener for the bridge's source-registration call.
//
// THE CHAIN THIS COMPLETES
// -----------------------
// bridge receives a QQ message
//   -> mints a requestId
//   -> POST /source/register to THIS listener            <- the piece added here
//   -> passes requestId to api.sessions.prompt({requestId})
//   -> DSH stores it as message.source.rpcId
//   -> the plugin's `observeStep` looks that rpcId up in the ledger's `requests`
//   -> `observeToolCall` binds calls[callId] = { turn, step, requestId }
//   -> dispatchBound -> ledger.consume() hits -> dispatch succeeds.
//
// Measured production failure, before this existed: `lastDispatchRefusal.reason === 'consume'`
// because the ledger's `requests` was EMPTY — nothing ever called `registerBridgeRequest`.
//
// THIS FILE FORWARDS; IT NEVER INVENTS
// ------------------------------------
// It accepts `(sessionId, requestId, origin)` from the bridge and hands the frame to an injected
// `register` callback (the handle's own `registerBridgeRequest`). It does NOT mint a requestId, does
// NOT invent an origin, and does NOT call the ledger itself — so "was this registered" stays a fact
// about a call that really happened, not something this module can manufacture.
//
// WHY A SECOND IMPLEMENTATION OF THE SAME CONTRACT
// -----------------------------------------------
// `src/qzone-source-register-ipc.mjs` already contains a server with this exact contract. That file
// belongs to the bridge-side task and was declared off-limits for this one, so its service shape is
// reproduced here instead of imported or edited. Only the PROTOCOL CONSTANTS and the configuration
// reader are imported from it, so path/limits/origin-vocabulary cannot drift between the two ends;
// the request handling is this file's own. Consolidating the two into one shared implementation is a
// follow-up for whoever owns that module.
//
// SECURITY SHAPE (copied deliberately from the approval IPC, not invented here)
// ---------------------------------------------------------------------------
//   · binds a LOOPBACK literal only ('127.0.0.1' / '::1'); 'localhost' would re-resolve through the
//     hosts file, i.e. a second trust path;
//   · a per-channel Bearer token, compared in constant time, checked BEFORE routing so an
//     unauthenticated peer cannot enumerate paths;
//   · the request body is capped WHILE reading (16 KiB), never accumulated past the cap;
//   · the origin is a closed set, and a well-formed frame with an origin outside it is 403 (not
//     400): the request is not malformed, it is not allowed;
//   · NO LOGGING AT ALL, and the requestId is never stored. It is the identifier that links a
//     delivery to one QQ message: writing it anywhere durable would put the delivery graph on disk.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import {
  QZONE_SOURCE_ORIGINS,
  QZONE_SOURCE_REGISTER_MAX_FRAME_BYTES,
  QZONE_SOURCE_REGISTER_PATH,
  readQzoneSourceRegisterConfig,
} from '../../src/qzone-source-register-ipc.mjs';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1']);
const TOKEN = /^[\x21-\x7E]{16,512}$/;
/** Overflow drain bound, same value the bridge-side server uses. */
const OVERFLOW_DRAIN_BYTES = QZONE_SOURCE_REGISTER_MAX_FRAME_BYTES * 2;
const BODY_TIMEOUT_MS = 10_000;

const ID_TEXT = /^[^\u0000-\u001F\u007F]{1,128}$/;
const REGISTER_KEYS = Object.freeze(['sessionId', 'requestId', 'origin']);

const JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Read one own DATA property; a getter, a symbol key or a throw all yield `undefined`. */
function ownData(target, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** A non-empty, control-character-free id of at most 128 characters. */
function isValidText(value) {
  return typeof value === 'string' && ID_TEXT.test(value) && value.trim() !== '';
}

/** Read the register frame as a closed key set, or `null`. Origin is validated separately. */
function readRegisterFrame(value) {
  try {
    if (!isPlainRecord(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== REGISTER_KEYS.length) return null;
    for (const key of keys) {
      if (typeof key !== 'string' || REGISTER_KEYS.includes(key) === false) return null;
    }
    const sessionId = ownData(value, 'sessionId');
    const requestId = ownData(value, 'requestId');
    const origin = ownData(value, 'origin');
    if (isValidText(sessionId) === false || isValidText(requestId) === false) return null;
    if (typeof origin !== 'string') return null;
    return Object.freeze({ sessionId, requestId, origin });
  } catch {
    return null;
  }
}

/**
 * Interpret the plugin-side configuration for this listener.
 *
 * Reuses the bridge module's READER so the two ends agree on what a valid section looks like, then
 * adds the one rule only the listener can state: the port must be FIXED. A bridge deployment has to
 * be configured with the same number, so an ephemeral port (0) would produce a listener nobody can
 * reach — worse than no listener, because it would look healthy.
 *
 * @returns {{enabled:false, reason:string} | {enabled:true, token:string, port:number}}
 *   `enabled:false` is never an error: the caller records the reason and loads normally.
 */
export function readSourceRegisterListenerConfig(section) {
  if (section === undefined || section === null) return { enabled: false, reason: 'not-configured' };
  const parsed = readQzoneSourceRegisterConfig({ sourceRegister: section });
  if (parsed.enabled !== true) return parsed;
  if (parsed.port === 0) {
    // Deliberately NOT 'port-invalid': the shape is fine and the intent is understandable, it is the
    // VALUE that cannot work here.
    return { enabled: false, reason: 'port-must-be-fixed' };
  }
  return parsed;
}

/**
 * Adapt a plugin handle to the listener's `register` contract.
 *
 * WHY THIS EXISTS: `handle.registerBridgeRequest` returns `undefined` on success (the ledger's own
 * method is void) and THROWS on refusal. The wire contract needs an explicit `{ok:true}`, and the
 * normalisation must live in ONE place — a listener that accepted `undefined` as success could not
 * tell "registered" from "the handler returned nothing", which would let a silent no-op be
 * reported to the bridge as a successful registration.
 *
 * @param {{registerBridgeRequest: (sessionId: string, input: object) => unknown}} handle
 * @returns {(sessionId: string, input: object) => {ok: true}}
 * @throws {TypeError} when the handle cannot register, and rethrows the handle's own refusal so the
 *   listener can answer 500 without inventing a reason.
 */
export function createHandleRegisterAdapter(handle) {
  if (handle === null || typeof handle !== 'object' || typeof handle.registerBridgeRequest !== 'function') {
    throw new TypeError('source register adapter needs a handle with registerBridgeRequest');
  }
  return (sessionId, input) => {
    handle.registerBridgeRequest(sessionId, input);
    // Reached only when the handle did NOT throw. Anything it returned is irrelevant: the contract
    // here is "the call completed", and an exception is the only way the handle refuses.
    return { ok: true };
  };
}

export { TOKEN as _SOURCE_REGISTER_TOKEN_PATTERN };

/**
 * Start the loopback listener.
 *
 * @param {object} options
 * @param {(sessionId: string, input: {requestId: string, origin: string}) => unknown} options.register
 *   the plugin-side registration (the handle's `registerBridgeRequest`). `{ok:true}` (or any
 *   non-`undefined`/non-`null` answer without `ok:false`) means registered.
 * @param {string} options.token   Bearer token, 16..512 printable ASCII, supplied by the caller.
 * @param {number} options.port    1..65535. Fixed by contract — see `readSourceRegisterListenerConfig`.
 * @param {string} [options.host]  '127.0.0.1' (default) or '::1'.
 * @returns {Promise<{close: () => Promise<void>, port: number, address: string}>}
 * @throws {TypeError|Error} on a bad dependency or a failed bind. The CALLER decides whether that
 *   is fatal; this module never swallows a failure into a half-open listener.
 */
export async function createQzoneSourceRegisterListener({ register, token, port, host = '127.0.0.1' } = {}) {
  if (typeof register !== 'function') throw new TypeError('source register listener needs a register function');
  if (typeof token !== 'string' || TOKEN.test(token) === false) {
    throw new TypeError('source register listener needs a 16-512 character printable bearer token');
  }
  if (Number.isSafeInteger(port) === false || port < 1 || port > 65535) {
    throw new TypeError('source register listener needs a fixed port between 1 and 65535');
  }
  if (typeof host !== 'string' || LOOPBACK_ADDRESSES.has(host) === false) {
    throw new TypeError("source register listener only listens on a loopback address ('127.0.0.1' or '::1')");
  }

  const expected = Buffer.from(token, 'utf8');
  let closed = false;

  function respond(response, status, body, extra) {
    try {
      if (response.writableEnded === true || response.destroyed === true) return;
      response.writeHead(status, extra === undefined ? JSON_HEADERS : { ...JSON_HEADERS, ...extra });
      response.end(JSON.stringify(body));
    } catch {
      try { response.destroy(); } catch { /* the socket is already gone */ }
    }
  }

  function discard(request) {
    try { request.resume(); } catch { /* nothing to drain */ }
  }

  function isAuthorized(request) {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || header.startsWith('Bearer ') === false) return false;
    const supplied = Buffer.from(header.slice(7), 'utf8');
    // Length is not the secret; comparing requires equal lengths (timingSafeEqual throws otherwise).
    if (supplied.length !== expected.length) return false;
    try { return timingSafeEqual(supplied, expected); } catch { return false; }
  }

  function pathOf(url) {
    if (typeof url !== 'string') return null;
    const mark = url.indexOf('?');
    return mark === -1 ? url : url.slice(0, mark);
  }

  /** Read the body up to the frame cap. Never buffers past the cap; never logs. */
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
        try { request.destroy(); } catch { /* already destroyed */ }
      }, BODY_TIMEOUT_MS);

      function onData(chunk) {
        if (overflow) {
          drained += chunk.length;
          if (drained > OVERFLOW_DRAIN_BYTES) {
            finish({ ok: false, status: 413 });
            try { request.destroy(); } catch { /* already destroyed */ }
          }
          return;
        }
        size += chunk.length;
        if (size > QZONE_SOURCE_REGISTER_MAX_FRAME_BYTES) {
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

  function parseJson(buffer) {
    try {
      const text = buffer.toString('utf8');
      if (Buffer.byteLength(text, 'utf8') > QZONE_SOURCE_REGISTER_MAX_FRAME_BYTES) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function handle(request, response) {
    if (closed === true) { respond(response, 503, { ok: false, error: 'closed' }); discard(request); return; }
    // Authentication BEFORE routing: an unauthenticated peer must not even learn which path exists.
    if (isAuthorized(request) === false) {
      respond(response, 401, { ok: false, error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      discard(request);
      return;
    }
    if (pathOf(request.url) !== QZONE_SOURCE_REGISTER_PATH) {
      respond(response, 404, { ok: false, error: 'not-found' });
      discard(request);
      return;
    }
    if (request.method !== 'POST') {
      respond(response, 405, { ok: false, error: 'method-not-allowed' }, { Allow: 'POST' });
      discard(request);
      return;
    }
    const body = await readBody(request);
    if (body.ok !== true) { respond(response, body.status, { ok: false, error: 'invalid-frame' }); return; }
    const frame = readRegisterFrame(parseJson(body.buffer));
    if (frame === null) { respond(response, 400, { ok: false, error: 'invalid-frame' }); return; }
    // Well-formed but not an allowed origin: 403, not 400. The two lead an operator to different
    // fixes, and collapsing them would blame the bridge's request shape for a policy refusal.
    if (QZONE_SOURCE_ORIGINS.includes(frame.origin) === false) {
      respond(response, 403, { ok: false, error: 'invalid-origin' });
      return;
    }
    let answer;
    try {
      answer = await register(frame.sessionId, Object.freeze({ requestId: frame.requestId, origin: frame.origin }));
    } catch {
      // The message is NOT echoed: it can carry a session id or ledger internals.
      respond(response, 500, { ok: false, error: 'register-failed' });
      return;
    }
    if (answer === undefined || answer === null || (isPlainRecord(answer) && answer.ok === false)) {
      // WHY 500 AND NOT 403: 403 in this protocol means "the origin you named is not allowed".
      // This is the plugin REFUSING FOR A STATE REASON (no ledger, generation superseded, handle not
      // dispatch-ready) — a transient condition the bridge should surface as a failed registration,
      // never as a policy violation. The bridge's own server uses the same 500 for the same case.
      respond(response, 500, { ok: false, error: 'register-refused' });
      return;
    }
    respond(response, 200, { ok: true });
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch(() => {
      respond(response, 500, { ok: false, error: 'internal' });
      discard(request);
    });
  });
  server.headersTimeout = Math.min(BODY_TIMEOUT_MS + 5000, 30000);
  server.requestTimeout = BODY_TIMEOUT_MS + 5000;
  server.keepAliveTimeout = 5000;
  server.on('clientError', (_error, socket) => { try { socket.destroy(); } catch { /* already gone */ } });

  await new Promise((resolve, reject) => {
    const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen({ host, port, exclusive: true });
    } catch (error) {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
      reject(error);
    }
  });

  const bound = server.address();
  if (bound === null || typeof bound !== 'object' || LOOPBACK_ADDRESSES.has(bound.address) === false) {
    await new Promise((resolve) => server.close(() => resolve()));
    throw new Error('source register listener refused to start: the bound address is not loopback');
  }
  // A post-listen 'error' with no listener would kill the host process. Turn it into a closed one.
  server.on('error', () => { closed = true; });

  async function close() {
    if (closed === true) return;
    closed = true;
    try { server.closeAllConnections(); } catch { /* nothing open */ }
    await new Promise((resolve) => {
      try { server.close(() => resolve()); } catch { resolve(); }
    });
  }

  return Object.freeze({ close, port: bound.port, address: bound.address });
}