import { buildQzoneOnebotReadRequest } from './qzone-onebot-contract-offline.mjs';

const UNKNOWN = Object.freeze({ status: 'unknown' });
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const HARD_MAX_RESPONSE_BYTES = 1_048_576;
const AUTH_HEADER_NAMES = new Set(['authorization']);

function requireOrigin(value) {
  if (typeof value !== 'string') throw new TypeError('invalid OneBot origin');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('invalid OneBot origin');
  }

  const authority = /^http:\/\/(\[[^\]]+\]|[^/:?#]+)(?::\d+)?\/?$/i.exec(value);
  const rawHost = authority?.[1];
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== '/' || !['127.0.0.1', '[::1]'].includes(rawHost) ||
      !['127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new TypeError('invalid OneBot origin');
  }
  return parsed.origin;
}

function requirePath(value) {
  if (value === undefined) return '/';
  if (typeof value !== 'string') throw new TypeError('invalid OneBot path');
  const path = value.trim() || '/';
  const normalized = path === '/' ? '/' : path.endsWith('/') ? path.slice(0, -1) : path;
  const safePath = /^\/(?!\/)(?:(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+)*)?$/;
  if (!safePath.test(normalized)) throw new TypeError('invalid OneBot path');
  return normalized;
}

function requireAuthHeaders(value) {
  try {
    if (value === undefined) return new Headers();
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('invalid authentication headers');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('invalid authentication headers');

    const headers = new Headers();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !AUTH_HEADER_NAMES.has(key.toLowerCase())) {
        throw new TypeError('invalid authentication headers');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') {
        throw new TypeError('invalid authentication headers');
      }
      headers.set(key, descriptor.value);
    }
    return headers;
  } catch {
    throw new TypeError('invalid authentication headers');
  }
}

function boundedInteger(value, fallback, hardLimit) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('invalid transport limit');
  return Math.min(value, hardLimit);
}

function attemptWithoutWaiting(operation) {
  try {
    const result = operation();
    if (result !== undefined) Promise.resolve(result).catch(() => {});
  } catch {}
}

function cancelResponseBody(response) {
  try {
    const body = response?.body;
    if (typeof body?.cancel === 'function') attemptWithoutWaiting(() => body.cancel());
  } catch {}
}

async function readBoundedJson(response, maxBytes, onReaderCancel) {
  if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
    cancelResponseBody(response);
    return null;
  }
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|\s*$)/i.test(contentType)) {
    cancelResponseBody(response);
    return null;
  }

  const lengthValue = response.headers?.get?.('content-length');
  if (lengthValue !== null && lengthValue !== undefined && /^\d+$/.test(lengthValue) && Number(lengthValue) > maxBytes) {
    cancelResponseBody(response);
    return null;
  }
  const reader = response.body?.getReader?.();
  if (!reader) return null;
  onReaderCancel(() => reader.cancel());

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        attemptWithoutWaiting(() => reader.cancel());
        return null;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    onReaderCancel(null);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

async function requestEnvelope({ fetchImpl, origin, pathPrefix, headers, timeoutMs, maxResponseBytes }, action, input) {
  let controller;
  let timer;
  let cancelReader;
  let timedOut = false;
  let waitingForResponse = false;
  try {
    const request = buildQzoneOnebotReadRequest(action, input);
    controller = new AbortController();
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        if (cancelReader) attemptWithoutWaiting(cancelReader);
        resolve(UNKNOWN);
      }, timeoutMs);
    });
    const operation = (async () => {
      const requestHeaders = new Headers(headers);
      requestHeaders.set('content-type', 'application/json');
      const actionPath = pathPrefix === '/' ? '' : pathPrefix;
      waitingForResponse = true;
      const response = await fetchImpl(`${origin}${actionPath}/${action}`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(request.params),
        redirect: 'error',
        signal: controller.signal
      });
      waitingForResponse = false;
      if (timedOut) {
        cancelResponseBody(response);
        return UNKNOWN;
      }
      const envelope = await readBoundedJson(response, maxResponseBytes, (cancel) => {
        cancelReader = cancel;
      });
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
          envelope.status !== 'ok' || envelope.retcode !== 0) return UNKNOWN;
      return { kind: 'trusted-envelope', envelope };
    })();
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (waitingForResponse && !timedOut) {
      try {
        const cause = Object.getOwnPropertyDescriptor(error, 'cause');
        const code = cause && Object.hasOwn(cause, 'value') && cause.value &&
          Object.getOwnPropertyDescriptor(cause.value, 'code');
        if (code && Object.hasOwn(code, 'value') && ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code.value)) {
          return { status: 'gateway_unavailable' };
        }
      } catch {}
    }
    return UNKNOWN;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller?.abort();
  }
}

/**
 * Create a deliberately narrow HTTP transport. Successful envelopes are returned
 * only to the trusted caller; model-facing projection and policy belong elsewhere.
 */
export function createQzoneOnebotReadTransport(options) {
  let values;
  try {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('invalid transport options');
    }
    values = {
      origin: options.origin,
      path: options.path,
      fetch: options.fetch,
      authHeaders: options.authHeaders,
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes
    };
  } catch {
    throw new TypeError('invalid transport options');
  }
  const origin = requireOrigin(values.origin);
  const pathPrefix = requirePath(values.path);
  if (typeof values.fetch !== 'function') throw new TypeError('fetch function is required');
  const headers = requireAuthHeaders(values.authHeaders);
  const timeoutMs = boundedInteger(values.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxResponseBytes = boundedInteger(values.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, HARD_MAX_RESPONSE_BYTES);
  const transportOptions = { fetchImpl: values.fetch, origin, pathPrefix, headers, timeoutMs, maxResponseBytes };

  return Object.freeze({
    get_qzone_msg_list(input) {
      return requestEnvelope(transportOptions, 'get_qzone_msg_list', input);
    },
    get_qzone_msg_detail(input) {
      return requestEnvelope(transportOptions, 'get_qzone_msg_detail', input);
    }
  });
}
