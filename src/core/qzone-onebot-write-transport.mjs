import { buildQzoneOnebotWriteRequest } from './qzone-onebot-write-contract.mjs';
import { projectQzoneWriteResult } from './qzone-onebot-write-result.mjs';

const UNKNOWN = Object.freeze({ outcome: 'unknown' });
const NETWORK_UNAVAILABLE = Object.freeze({ outcome: 'network_unavailable' });
const MAX_BYTES = 1024 * 1024;

function baseOrigin(value) {
  if (typeof value !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(value)) throw new TypeError('invalid local origin');
  const url = new URL(value);
  if (url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new TypeError('invalid local origin');
  return url.origin;
}

async function readBody(response, setReader) {
  if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300 ||
      !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|\s*$)/i.test(response.headers?.get?.('content-type') ?? '')) {
    cancelBody(response);
    return null;
  }
  const length = response.headers?.get?.('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BYTES) { cancelBody(response); return null; }
  const reader = response.body?.getReader?.();
  if (!reader) return null;
  setReader(reader);
  let size = 0;
  const parts = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || (size += value.byteLength) > MAX_BYTES) { Promise.resolve(reader.cancel()).catch(() => {}); return null; }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let position = 0;
    for (const part of parts) { bytes.set(part, position); position += part.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { setReader(null); reader.releaseLock(); }
}

function cancelBody(response) {
  try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch { /* best effort */ }
}

/** Narrow internal transport only: caller MUST already authorize, persist an
 * audit intent and atomically reserve quota. Never expose directly to a model. */
export function createQzoneOnebotWriteTransport({ origin, fetch: sendFetch, authorization, timeoutMs = 5000 } = {}) {
  const base = baseOrigin(origin);
  if (typeof sendFetch !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 ||
      (authorization !== undefined && typeof authorization !== 'string')) throw new TypeError('invalid transport configuration');
  // Headers rejects control characters and prevents credentials in URLs.
  const headers = new Headers({ 'content-type': 'application/json' });
  if (authorization !== undefined) headers.set('authorization', authorization);
  return Object.freeze({ async send(kind, input) {
    let timer;
    let activeReader = null;
    let responseReceived = false;
    const controller = new AbortController();
    try {
      const request = buildQzoneOnebotWriteRequest(kind, input);
      let expired = false;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => {
        expired = true;
        controller.abort();
        try { if (activeReader) Promise.resolve(activeReader.cancel()).catch(() => {}); } catch {}
        resolve(UNKNOWN);
      }, timeoutMs); });
      const work = (async () => {
        const response = await sendFetch(`${base}/${request.action}`, { method: 'POST', headers: new Headers(headers),
          body: JSON.stringify(request.params), signal: controller.signal, redirect: 'error' });
        responseReceived = true;
        if (expired) { cancelBody(response); return UNKNOWN; }
        const data = await readBody(response, (reader) => { activeReader = reader; });
        return expired || !data ? UNKNOWN : projectQzoneWriteResult(kind, data);
      })();
      return await Promise.race([work, timeout]);
    } catch (error) {
      try {
        const cause = Object.getOwnPropertyDescriptor(error, 'cause');
        const code = cause && Object.hasOwn(cause, 'value') && cause.value &&
          Object.getOwnPropertyDescriptor(cause.value, 'code');
        if (!responseReceived && code && Object.hasOwn(code, 'value') && ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code.value)) return NETWORK_UNAVAILABLE;
      } catch {}
      return UNKNOWN;
    }
    finally { clearTimeout(timer); controller.abort(); }
  } });
}
