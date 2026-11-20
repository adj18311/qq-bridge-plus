// The PLUGIN-PROCESS side of the local OneBot forward endpoint \
// (`POST /api/qzone/onebot`, implemented in `src/bridge.js` by task C1).
//
// WHAT THIS MODULE IS
// -------------------
// A transport, and nothing else. It turns `call(action, params)` into ONE HTTP request to the
// bridge's loopback forward endpoint and hands back the parsed OneBot envelope. It holds no
// policy, no quota, no approval and no ledger: every one of those lives further down the chain
// (`qzone-plugin-host-runtime.mjs` -> `qzone-runtime-wiring.mjs` -> the approved-write
// compositions -> `qzone-write-path-offline.mjs`).
//
// IT FAILS BY THROWING, NEVER BY INVENTING A SUCCESS
// -------------------------------------------------
// Timeout, refused connection, socket reset, a non-2xx answer, an oversized body and a body that
// is not JSON ALL throw a `QzoneOnebotBridgeError` carrying a machine-readable `code`. That is
// deliberate and load-bearing: `qzone-write-path-offline.mjs:938-947` classifies a THROW as
// `unknown` ("it may have gone out"), which is the conservative reading of a lost answer, and it
// classifies a RETURNED value as `success`/`failed`/`not-sent`/`unknown` depending on what the
// object claims. Swallowing a transport failure into a return value here would let this layer
// choose the write path's classification, which is exactly the authority it must not have.
//
// CODE VERSUS BUSINESS FAILURE (measured against the C1 endpoint, 2026-11-16)
// --------------------------------------------------------------------------
//   · A CHANNEL failure is non-2xx with `{ ok:false, error, code }`: 401 unauthorized,
//     403 write-channel-not-wired / action-not-allowed / agent-call-forbidden, 400 invalid-body,
//     503 onebot-unavailable, 502 onebot-request-failed, ... This module throws, `code` is copied
//     from that body when it is well formed (and left as `'http-status'` otherwise).
//   · A PLATFORM failure is 200 plus the ordinary OneBot envelope with `retcode !== 0`. That is
//     NOT a transport failure: the request was forwarded and answered, and the caller decides what
//     the envelope means. This module therefore RETURNS it unchanged.
//
// WHAT IS NEVER LOGGED
// --------------------
// Nothing. This module never writes to `console` and never puts the request body, the token or
// the response body into an error message; a `send_qzone_msg` body is a user's post.
//
// THE TOKEN IS A CHANNEL CREDENTIAL, NOT AN IDENTITY
// -------------------------------------------------
// The bearer token authenticates this process to the bridge endpoint. It says nothing about which
// human or which QQ account is behind the request, and nothing about whether the host really
// issued the tool call — that is the origin ledger's question, not this transport's.

/** Default per-request budget. The endpoint only answers after the OneBot round trip. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** Hard cap for the same reason `qzone-onebot-read-transport.mjs:5` caps at 30 s. */
const MAX_TIMEOUT_MS = 60_000;
/** 1 MiB, matching the read transport's hard cap: a list page is the largest legal answer. */
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
/** How much of a REFUSAL body is read for its `code`. The refusal is two short fields. */
const MAX_ERROR_BODY_BYTES = 4_096;
/** The bridge's own action vocabulary shape; anything else cannot be a route. */
const ACTION = /^[a-z][a-z0-9_]{0,63}$/;
/**
 * A bearer token. The C1 endpoint requires 32..256 `[A-Za-z0-9_-]` characters in
 * `config.json.qzone.onebotForwardToken`; this client is deliberately no stricter than printable
 * ASCII so it can be pointed at a test double without re-implementing the server's rule, and no
 * looser than the approval client's 16..512 (`qzone-approval-ipc-client.mjs:49`).
 */
const TOKEN = /^[\x21-\x7E]{16,512}$/;
/** A machine-readable code, as the endpoint emits it. */
const CODE = /^[a-z0-9-]{1,64}$/;

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A loopback http(s) origin with no path. The bridge console binds 127.0.0.1 / ::1 only, so a
 * non-loopback origin cannot be the endpoint this module claims to talk to; refusing it here
 * fails closed instead of shipping a channel credential to an arbitrary host.
 */
function readLoopbackOrigin(value) {
  if (typeof value !== 'string') return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!['127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) return null;
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  return parsed.origin;
}

/**
 * Read at most `maxBytes` of a response body as UTF-8 text.
 *
 * Returns `null` when the body is longer than the cap, and the cap is enforced WHILE reading, so
 * an oversized answer is never materialised. `null` is a refusal, never an empty answer.
 */
async function readCappedText(response, maxBytes) {
  const stream = response?.body;
  if (stream === null || stream === undefined || typeof stream.getReader !== 'function') {
    try {
      const text = await response.text();
      return Buffer.byteLength(text, 'utf8') > maxBytes ? null : text;
    } catch {
      return null;
    }
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
        try { await reader.cancel(); } catch { /* the cap already decided */ }
        return null;
      }
      chunks.push(chunk);
    }
  } catch {
    return null;
  } finally {
    try { reader.releaseLock(); } catch { /* nothing to release */ }
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/**
 * The transport's own error type.
 *
 * `code` is the only field a caller should branch on. `detail` is the endpoint's own `error`
 * text, truncated: it is a fixed server-side sentence (`unauthorized`, `onebot-unavailable`, ...),
 * never a copy of the request or the response body.
 */
export class QzoneOnebotBridgeError extends Error {
  constructor(message, { code, status = null, detail = null, cause } = {}) {
    super(message);
    this.name = 'QzoneOnebotBridgeError';
    this.code = typeof code === 'string' ? code : 'transport';
    this.status = Number.isInteger(status) ? status : null;
    this.detail = typeof detail === 'string' ? detail : null;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Build the transport.
 *
 * @param {object} options
 * @param {string} options.origin   loopback origin of the bridge console, e.g. `http://127.0.0.1:3100`.
 * @param {string} options.token    the forward-endpoint bearer token (injected; never read from disk).
 * @param {number} [options.timeoutMs]  per-request budget, 1..60000 (default 10000).
 * @param {number} [options.maxResponseBytes]  hard cap on one answer (default 1 MiB, cap 1 MiB).
 * @param {typeof fetch} [options.fetch]  injected fetch; defaults to the platform's.
 * @returns {(action: string, params?: object) => Promise<unknown>} the parsed envelope.
 * @throws {TypeError} on any missing or mistyped dependency. No default is invented for the
 *   origin or the token — unlike `fetch`, those two are the whole point of the injection.
 */
export function createOnebotViaBridge({ origin, token, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES, fetch: fetchOption } = {}) {
  const base = readLoopbackOrigin(origin);
  if (base === null) {
    throw new TypeError('onebot bridge transport needs a loopback http origin such as http://127.0.0.1:3100');
  }
  if (typeof token !== 'string' || TOKEN.test(token) === false) {
    throw new TypeError('onebot bridge transport needs a 16-512 character printable bearer token supplied by the caller');
  }
  if (Number.isSafeInteger(timeoutMs) === false || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError('onebot bridge transport needs a timeoutMs between 1 and ' + MAX_TIMEOUT_MS);
  }
  if (Number.isSafeInteger(maxResponseBytes) === false || maxResponseBytes < 1 || maxResponseBytes > DEFAULT_MAX_RESPONSE_BYTES) {
    throw new TypeError('onebot bridge transport needs a maxResponseBytes between 1 and ' + DEFAULT_MAX_RESPONSE_BYTES);
  }
  const fetchImpl = fetchOption === undefined ? globalThis.fetch : fetchOption;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('onebot bridge transport needs an injected fetch function');
  }

  const endpoint = base + '/api/qzone/onebot';
  const authorization = 'Bearer ' + token;

  /**
   * Forward ONE action. Resolves with the parsed envelope; throws on every channel failure.
   *
   * @param {string} action  the OneBot action the bridge route accepts (`get_qzone_msg_list`,
   *   `get_qzone_msg_detail`, `get_login_info`, and — once the bridge opens the write channel —
   *   `send_qzone_msg` / `comment_qzone` / `like_qzone`).
   * @param {object} [params]  the action's parameters; must be a plain record.
   */
  async function call(action, params) {
    if (typeof action !== 'string' || ACTION.test(action) === false) {
      throw new QzoneOnebotBridgeError('invalid qzone bridge action', { code: 'invalid-action' });
    }
    const args = params === undefined ? {} : params;
    if (isPlainRecord(args) === false) {
      throw new QzoneOnebotBridgeError('invalid qzone bridge params', { code: 'invalid-params' });
    }
    const body = JSON.stringify({ action, params: args });

    const controller = new AbortController();
    let timer;
    let timedOut = false;

    // The timeout rejects with the SAME error type the callers already branch on, and it aborts
    // the socket so a hung endpoint cannot pin this process.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        try { controller.abort(); } catch { /* already aborted */ }
        reject(new QzoneOnebotBridgeError('qzone bridge request timed out', { code: 'timeout' }));
      }, timeoutMs);
    });

    const work = (async () => {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json; charset=utf-8',
            accept: 'application/json',
          },
          body,
          signal: controller.signal,
          // A redirect would silently re-POST the write somewhere else; refusing keeps the
          // endpoint fixed, exactly as the approval client does (`qzone-approval-ipc-client.mjs:147`).
          redirect: 'error',
          cache: 'no-store',
          credentials: 'omit',
        });
      } catch (error) {
        if (timedOut) throw new QzoneOnebotBridgeError('qzone bridge request timed out', { code: 'timeout', cause: error });
        throw new QzoneOnebotBridgeError('qzone bridge request failed', { code: 'network', cause: error });
      }

      const status = Number.isInteger(response?.status) ? response.status : null;
      if (status === null || status < 200 || status > 299) {
        // The refusal body carries the machine-readable reason; read a bounded slice of it and
        // keep ONLY the fixed `code`/`error` fields. Nothing else from a server response is copied
        // into an error, and no response content is ever logged.
        const text = await readCappedText(response, MAX_ERROR_BODY_BYTES);
        let code = 'http-status';
        let detail = null;
        if (typeof text === 'string' && text.length > 0) {
          try {
            const parsed = JSON.parse(text);
            if (isPlainRecord(parsed)) {
              if (typeof parsed.code === 'string' && CODE.test(parsed.code)) code = parsed.code;
              if (typeof parsed.error === 'string') detail = parsed.error.slice(0, 200);
            }
          } catch { /* an unparseable refusal is still a refusal */ }
        }
        throw new QzoneOnebotBridgeError('qzone bridge refused the request', { code, status, detail });
      }

      const text = await readCappedText(response, maxResponseBytes);
      if (text === null) {
        throw new QzoneOnebotBridgeError('qzone bridge response exceeded the size cap', { code: 'response-too-large', status });
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        // The endpoint answers JSON on every path it owns, so a non-JSON 2xx is not this protocol's
        // answer. Returning `undefined` here would look like "the platform sent nothing".
        throw new QzoneOnebotBridgeError('qzone bridge response is not JSON', { code: 'invalid-json', status, cause: error });
      }
      return parsed;
    })();

    // Observe a late rejection so an aborted request cannot surface as an unhandled rejection
    // after the race has already settled on the deadline.
    work.catch(() => {});

    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      try { controller.abort(); } catch { /* already aborted */ }
    }
  }

  return call;
}
