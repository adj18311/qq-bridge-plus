import { appendOfflineAudit } from './qzone-audit-offline.mjs';
import { types as utilTypes } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ACTIONS = new Set(['setup', 'verify', 'forgot-reset', 'logout']);
const RESULTS = new Set(['success', 'failure', 'unknown']);
const KEYS = new Set(['operationId', 'action', 'time', 'source', 'phase', 'result']);

/** Read-only password check for the local recovery path: no counters or sessions are changed. */
export function verifyOfflineColumnPassword({ stateDir, password, namespace, now = Date.now() } = {}) {
  if (namespace !== 'qqspace' || typeof stateDir !== 'string' || !stateDir ||
      typeof password !== 'string' || !Number.isFinite(now)) return false;
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(path.join(stateDir, 'qqspace-console-column-auth.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch { return false; }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored) || stored.schemaVersion !== 1 ||
      stored.algorithm !== 'scrypt' || !stored.params || typeof stored.params !== 'object' ||
      Array.isArray(stored.params) || stored.params.N !== 16384 || stored.params.r !== 8 ||
      stored.params.p !== 1 || stored.params.keylen !== 32 || !Number.isFinite(stored.passwordUpdatedAt) ||
      !Number.isInteger(stored.failedAttempts) || stored.failedAttempts < 0 ||
      (stored.lockedUntil !== null && !Number.isFinite(stored.lockedUntil)) ||
      (stored.lastFailedAt !== null && !Number.isFinite(stored.lastFailedAt)) ||
      (typeof stored.lockedUntil === 'number' && stored.lockedUntil > now)) return false;
  const decodeExact = (value, length) => {
    if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
    const bytes = Buffer.from(value, 'base64');
    return bytes.length === length && bytes.toString('base64') === value ? bytes : null;
  };
  const salt = decodeExact(stored.salt, 16);
  const expected = decodeExact(stored.hash, 32);
  if (!salt || !expected) return false;
  try {
    const actual = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

// Offline adapter: store.update must be a trusted synchronous transaction.
// No passwords, sessions or raw request/response objects are accepted.
export function createOfflineColumnAuthAudit(store, { selfId } = {}) {
  if (!store || typeof store.update !== 'function' || typeof selfId !== 'string' || !/^\d{1,20}$/.test(selfId)) throw new TypeError('invalid audit dependencies');
  return (event) => {
    try {
      if (!event || Object.getPrototypeOf(event) !== Object.prototype || Reflect.ownKeys(event).some((key) => typeof key !== 'string' || !KEYS.has(key))) return false;
      const copy = {};
      for (const key of KEYS) {
        const item = Object.getOwnPropertyDescriptor(event, key);
        if (!item?.enumerable || !Object.hasOwn(item, 'value')) return false;
        copy[key] = item.value;
      }
      const { operationId, action, time, source, phase, result } = copy;
      if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{1,110}$/.test(operationId) ||
          !ACTIONS.has(action) || !Number.isFinite(time) || source !== 'admin_console' ||
          !['intent', 'outcome'].includes(phase) || !RESULTS.has(result) || (phase === 'intent' && result !== 'unknown')) return false;
      let written = false;
      let active = true;
      let resultOfUpdate;
      try { resultOfUpdate = store.update((state) => {
        if (!active) return state;
        if (!Array.isArray(state.audit)) throw new TypeError('invalid audit state');
        const intentId = `auth_${operationId}_intent`;
        const id = `auth_${operationId}_${phase}`;
        if (state.audit.some((item) => item.id === id)) return state;
        if (phase === 'outcome') {
          const intent = state.audit.find((item) => item.id === intentId);
          if (!intent || intent.record?.action !== 'authenticate' || intent.record?.target !== selfId ||
              intent.record?.source !== source || intent.record?.time !== time ||
              intent.record?.content !== JSON.stringify({ action, phase: 'intent' })) return state;
        }
        let next = state;
        const transaction = { update(fn) { next = fn(next); } };
        const input = { time, source, action: 'authenticate', target: selfId,
          content: JSON.stringify({ action, phase }), result, reason: '' };
        written = appendOfflineAudit(transaction, id, input).appended;
        return next;
      }); } finally { active = false; }
      if (utilTypes.isPromise(resultOfUpdate)) {
        Promise.prototype.then.call(resultOfUpdate, undefined, () => {});
        return false;
      }
      return written;
    } catch {
      return false;
    }
  };
}
