import {
  forgotResetPassword,
  getAuthStatus,
  revokeSession,
  setPassword,
  verifyPassword,
  verifySession,
} from './console-column-auth.mjs';
import { randomUUID } from 'node:crypto';

const ROUTE_PREFIX = '/api/console/qqspace-column/auth';
const COOKIE_NAME = 'qqspace_column_session';
const COOKIE_PATH = '/api/console/qqspace-column';
const NAMESPACE = 'qqspace';

// Copy only ordinary data properties before any guard observes the request.
// This is an offline handler, not a substitute for HTTP body size limits.
function snapshotRequest(value, depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (!value || typeof value !== 'object' || depth > 6 || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('invalid request');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64 || keys.some((key) => typeof key !== 'string')) throw new TypeError('invalid request');
  const copy = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('invalid request');
    Object.defineProperty(copy, key, { value: snapshotRequest(descriptor.value, depth + 1), enumerable: true });
  }
  return Object.freeze(copy);
}

function syncTrue(result) {
  if (result === true) return true;
  // Guards are synchronous by contract. Consume accidental rejected promises
  // without awaiting or treating them as successful authorization.
  if (result && (typeof result === 'object' || typeof result === 'function')) {
    Promise.resolve(result).catch(() => {});
  }
  return false;
}

function response(status, body, headers = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body,
  };
}

function readCookie(request) {
  const raw = typeof request?.headers?.cookie === 'string' ? request.headers.cookie : '';
  let found = null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    if (found !== null) return '';
    const value = part.slice(eq + 1).trim();
    try {
      found = decodeURIComponent(value);
    } catch {
      return '';
    }
  }
  return found ?? '';
}

function cookieFor(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=${COOKIE_PATH}`;
}

function clearedCookie() {
  return `${COOKIE_NAME}=; Max-Age=0; HttpOnly; SameSite=Strict; Path=${COOKIE_PATH}`;
}

function safeReason(reason, fallback) {
  const allowed = new Set([
    'agent-not-paused',
    'already-set',
    'invalid-password',
    'password-equals-console-token',
    'password-too-short',
    'persist-failed',
    'state-untrusted',
    'untrusted',
    'unset',
    'locked',
    'wrong-password',
  ]);
  return allowed.has(reason) ? reason : fallback;
}

/**
 * Create an offline QQ Space password-route handler. The returned function only
 * accepts request-shaped objects and returns response-shaped objects; it does
 * not register routes, listen on a socket, or access bridge globals.
 *
 * Trust decisions and location/secrets are constructor dependencies. No such
 * values are read from request parameters or bodies.
 */
export function createQzoneColumnAuthRouteOffline({
  stateDir,
  consoleToken,
  authorizeConsole,
  verifyCsrf,
  isAgentPaused,
  audit,
  now = () => Date.now(),
} = {}) {
  const configured = typeof stateDir === 'string' && stateDir.length > 0
    && (typeof consoleToken === 'string' || typeof consoleToken === 'function')
    && typeof authorizeConsole === 'function'
    && typeof verifyCsrf === 'function'
    && typeof isAgentPaused === 'function';

  return function handleQzoneColumnAuth(request = {}) {
    if (!configured) return response(403, { ok: false, error: 'console-auth-required' });
    try { request = snapshotRequest(request); }
    catch { return response(400, { ok: false, error: 'invalid-request' }); }

    try {
      if (!syncTrue(authorizeConsole(request))) {
        return response(403, { ok: false, error: 'console-auth-required' });
      }
    } catch {
      return response(403, { ok: false, error: 'console-auth-required' });
    }
    try {
      if (!syncTrue(verifyCsrf(request))) {
        return response(403, { ok: false, error: 'csrf-required' });
      }
    } catch {
      return response(403, { ok: false, error: 'csrf-required' });
    }

    const method = typeof request.method === 'string' ? request.method.toUpperCase() : '';
    const pathname = typeof request.pathname === 'string' ? request.pathname : '';
    if (!pathname.startsWith(`${ROUTE_PREFIX}/`)) {
      return response(404, { ok: false, error: 'not-found' });
    }
    const subPath = pathname.slice(ROUTE_PREFIX.length);
    let current;
    try {
      current = now();
      if (!Number.isFinite(current)) {
        if (current && (typeof current === 'object' || typeof current === 'function')) Promise.resolve(current).catch(() => {});
        return response(500, { ok: false, error: 'internal-error' });
      }
    } catch {
      return response(500, { ok: false, error: 'internal-error' });
    }

    const readPaused = () => {
      try {
        return syncTrue(isAgentPaused());
      } catch {
        return false;
      }
    };
    const bodyPassword = () => {
      const body = request.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, error: 'invalid-body' };
      }
      if (typeof body.password !== 'string') return { ok: false, error: 'password-required' };
      return { ok: true, password: body.password };
    };

    const action = method === 'POST' && ['/setup', '/verify', '/forgot-reset', '/logout'].includes(subPath)
      ? subPath.slice(1) : null;
    const operationId = action ? randomUUID() : null;
    const record = (phase, result) => {
      try { return typeof audit === 'function' && syncTrue(audit(Object.freeze({ phase, action, result, time: current, source: 'admin_console', operationId }))); }
      catch { return false; }
    };
    if (action && !record('intent', 'unknown')) return response(503, { ok: false, error: 'audit-unavailable' });
    const execute = () => { try {
      if (method === 'GET' && subPath === '/status') {
        const auth = getAuthStatus({ stateDir, now: current, namespace: NAMESPACE });
        const token = readCookie(request);
        const session = token === ''
          ? { ok: false }
          : verifySession({ sessionToken: token, now: current, namespace: NAMESPACE });
        return response(200, {
          ok: true,
          state: auth.state,
          lockedSeconds: auth.lockedSeconds,
          failedAttempts: auth.failedAttempts,
          agentPaused: readPaused(),
          session: {
            valid: session.ok === true,
            expiresAt: session.ok === true && Number.isFinite(session.expiresAt) ? session.expiresAt : null,
          },
        });
      }

      if (method === 'POST' && (subPath === '/setup' || subPath === '/verify' || subPath === '/forgot-reset')) {
        const input = bodyPassword();
        if (!input.ok) return response(400, { ok: false, error: input.error });

        const activeConsoleToken = typeof consoleToken === 'function' ? consoleToken() : consoleToken;
        if (typeof activeConsoleToken !== 'string' || !activeConsoleToken) return response(500, { ok: false, error: 'internal-error' });

        if (subPath === '/setup') {
          const result = setPassword({
            stateDir,
            password: input.password,
            consoleToken: activeConsoleToken,
            agentPaused: readPaused(),
            now: current,
            namespace: NAMESPACE,
          });
          if (result.ok !== true) return mappedFailure(result, 'setup-failed');
          const issued = verifyPassword({ stateDir, password: input.password, now: current, namespace: NAMESPACE });
          return issued.ok === true
            ? response(200, { ok: true }, { 'set-cookie': cookieFor(issued.sessionToken) })
            : response(200, { ok: true });
        }

        if (subPath === '/verify') {
          const result = verifyPassword({
            stateDir,
            password: input.password,
            now: current,
            namespace: NAMESPACE,
          });
          if (result.ok !== true) return mappedFailure(result, 'verify-failed');
          return response(200, { ok: true, expiresAt: result.expiresAt ?? null }, {
            'set-cookie': cookieFor(result.sessionToken),
          });
        }

        const result = forgotResetPassword({
          stateDir,
          password: input.password,
          consoleToken: activeConsoleToken,
          agentPaused: readPaused(),
          now: current,
          namespace: NAMESPACE,
        });
        if (result.ok !== true) return mappedFailure(result, 'forgot-reset-failed');
        return response(200, { ok: true }, { 'set-cookie': clearedCookie() });
      }

      if (method === 'POST' && subPath === '/logout') {
        const token = readCookie(request);
        if (token !== '') revokeSession(token, { namespace: NAMESPACE });
        return response(200, { ok: true }, { 'set-cookie': clearedCookie() });
      }

      return response(404, { ok: false, error: 'not-found' });
    } catch {
      return response(500, { ok: false, error: 'internal-error' });
    } };
    const result = execute();
    if (action && !record('outcome', result.status >= 500 ? 'unknown' : result.status >= 400 ? 'failure' : 'success')) {
      return response(500, { ok: false, error: 'audit-outcome-unknown' });
    }
    return result;
  };
}

function mappedFailure(result, fallback) {
  const reason = safeReason(result?.reason, fallback);
  if (reason === 'agent-not-paused') {
    return response(409, { ok: false, reason, agentPaused: false });
  }
  if (reason === 'persist-failed') return response(500, { ok: false, reason });
  if (reason === 'already-set' || reason === 'state-untrusted' || reason === 'unset' || reason === 'untrusted') {
    return response(409, { ok: false, reason });
  }
  if (reason === 'locked') {
    return response(423, {
      ok: false,
      reason,
      lockedSeconds: Number.isFinite(result?.lockedSeconds) ? result.lockedSeconds : 0,
      failedAttempts: Number.isInteger(result?.failedAttempts) ? result.failedAttempts : 0,
    });
  }
  if (reason === 'wrong-password') {
    return response(400, {
      ok: false,
      reason,
      failedAttempts: Number.isInteger(result?.failedAttempts) ? result.failedAttempts : 0,
      lockedSeconds: Number.isFinite(result?.lockedSeconds) ? result.lockedSeconds : 0,
    });
  }
  return response(400, { ok: false, reason });
}
