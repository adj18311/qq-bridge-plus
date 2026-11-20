import { nextFailureState } from './qzone-policy-offline.mjs';
import { formatAuditRecord } from './qzone-audit-offline.mjs';
import { randomUUID } from 'node:crypto';

// Offline state transition only: queue entries are not delivered notifications.
// Transport outcomes must be classified by trusted code, never the model.
const OUTCOMES = new Set(['success', 'failure', 'unknown', 'not_accessible', 'login_expired', 'captcha', 'network_unavailable']);

function markPauseCycle(next, previous, layer, operationId, cause) {
  const existing = previous.pauseCycles;
  if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing))) throw new TypeError('invalid pause cycles');
  next.pauseCycles = { access: null, write: null, ...existing, [layer]: { id: randomUUID(), operationId, cause } };
}

function validateAuditOutcome(record, outcome, now) {
  const expectedResult = outcome === 'success' ? 'success' : outcome === 'unknown' ? 'unknown' : 'failure';
  const fixedReasons = { success: '', unknown: '', not_accessible: 'not_accessible', login_expired: 'login_expired', captcha: 'captcha', network_unavailable: 'network' };
  if (record.result !== expectedResult || record.time !== now ||
      (Object.hasOwn(fixedReasons, outcome) && record.reason !== fixedReasons[outcome]) ||
      (outcome === 'failure' && ['captcha', 'login_expired', 'not_accessible'].includes(record.reason))) throw new TypeError('audit outcome, time or reason mismatch');
}

function validateExistingIntent(state, key, record) {
  const intent = state.audit.find((entry) => entry.id === key);
  if (!intent) throw new TypeError('missing audit intent');
  const existing = intent.record;
  // Different original bodies collapse to the same marker. Fail closed until a
  // single trusted request binding covers the body reserved and the body dispatched.
  if (!existing || existing.redacted || record.redacted || existing.redacted !== record.redacted ||
      ['source', 'action', 'target', 'postId', 'commentId'].some((field) => existing[field] !== record[field]) ||
      existing.content !== record.content) {
    throw new TypeError('audit intent mismatch');
  }
}

export function settleOfflineWrite(store, id, outcome, now = Date.now()) {
  if (!store || typeof store.update !== 'function' || typeof id !== 'string' || !id ||
      ['__proto__', 'constructor', 'prototype'].includes(id) || !OUTCOMES.has(outcome) || !Number.isFinite(now)) throw new TypeError('invalid settlement');
  let applied = false;
  store.update((state) => {
    if (!state.ledger?.reservations || !Object.hasOwn(state.ledger.reservations, id) ||
        !state.outcomes || typeof state.outcomes !== 'object' || Array.isArray(state.outcomes) || !Array.isArray(state.notices)) {
      throw new TypeError('missing reservation or invalid settlement state');
    }
    if (Object.hasOwn(state.outcomes, id)) {
      if (state.outcomes[id] !== outcome) throw new Error('conflicting outcome');
      return state;
    }
    const next = outcome === 'unknown' ? { ...state } : nextFailureState(state, 'write', outcome);
    const notices = [...state.notices];
    if (!state.accessPaused && next.accessPaused) {
      next.pausedAt = now; next.probe = 'waiting';
      markPauseCycle(next, state, 'access', id, outcome);
      notices.push({ layer: 'access', cause: outcome, operationId: id });
    }
    if (!state.writePaused && next.writePaused) {
      markPauseCycle(next, state, 'write', id, outcome);
      notices.push({ layer: 'write', cause: outcome, operationId: id });
    }
    applied = true;
    return { ...next, outcomes: { ...state.outcomes, [id]: outcome }, notices };
  });
  return { applied };
}

export function settleOfflineRead(store, id, outcome, now = Date.now()) {
  if (!store || typeof store.update !== 'function' || typeof id !== 'string' || !id ||
      ['__proto__', 'constructor', 'prototype'].includes(id) || !OUTCOMES.has(outcome) || !Number.isFinite(now)) throw new TypeError('invalid settlement');
  let applied = false;
  store.update((state) => {
    if (!state.readAttempts || !Object.hasOwn(state.readAttempts, id) || state.readAttempts[id] !== true ||
        !state.readOutcomes || typeof state.readOutcomes !== 'object' || Array.isArray(state.readOutcomes) || !Array.isArray(state.notices)) {
      throw new TypeError('missing attempt or invalid settlement state');
    }
    if (Object.hasOwn(state.readOutcomes, id)) {
      if (state.readOutcomes[id] !== outcome) throw new Error('conflicting outcome');
      return state;
    }
    const next = outcome === 'unknown' ? { ...state } : nextFailureState(state, 'read', outcome);
    const notices = [...state.notices];
    if (!state.accessPaused && next.accessPaused) {
      next.pausedAt = now; next.probe = 'waiting';
      markPauseCycle(next, state, 'access', id, outcome);
      notices.push({ layer: 'access', cause: outcome, operationId: id });
    }
    applied = true;
    return { ...next, readOutcomes: { ...state.readOutcomes, [id]: outcome }, notices };
  });
  return { applied };
}

// Offline experiment: audit and final state changes commit together. This
// does not remove the separate risk of crashing after platform dispatch but
// before recording the outcome, nor does it guarantee secret detection.
export function settleAuditedOfflineWrite(store, id, outcome, input, now = Date.now()) {
  if (!store || typeof store.update !== 'function') throw new TypeError('invalid store');
  const record = formatAuditRecord(input);
  validateAuditOutcome(record, outcome, now);
  let applied = false;
  store.update((state) => {
    if (!Array.isArray(state.audit)) throw new TypeError('invalid audit state');
    validateExistingIntent(state, `intent_${id}`, record);
    const kind = state.ledger?.reservations?.[id];
    const actions = { post: ['publish'], comment: ['comment', 'reply'], like: ['like'] };
    if (!Object.hasOwn(actions, kind) || !actions[kind].includes(record.action)) throw new TypeError('audit action mismatch');
    let next = state;
    const result = settleOfflineWrite({ update(fn) { next = fn(next); } }, id, outcome, now);
    const auditId = `write:${id}`;
    const previous = next.audit.find((entry) => entry.id === auditId);
    if (previous && JSON.stringify(previous.record) !== JSON.stringify(record)) throw new Error('conflicting audit id');
    if (!previous) next = { ...next, audit: [...next.audit, { id: auditId, record }] };
    applied = result.applied;
    return next;
  });
  return { applied };
}

export function settleAuditedOfflineRead(store, id, outcome, input, now = Date.now()) {
  if (!store || typeof store.update !== 'function') throw new TypeError('invalid store');
  const record = formatAuditRecord(input);
  validateAuditOutcome(record, outcome, now);
  if (!['read_posts', 'read_comments'].includes(record.action)) throw new TypeError('audit action mismatch');
  let applied = false;
  store.update((state) => {
    if (!Array.isArray(state.audit)) throw new TypeError('invalid audit state');
    validateExistingIntent(state, `read_intent_${id}`, record);
    let next = state;
    const result = settleOfflineRead({ update(fn) { next = fn(next); } }, id, outcome, now);
    const auditId = `read:${id}`;
    const previous = next.audit.find((entry) => entry.id === auditId);
    if (previous && JSON.stringify(previous.record) !== JSON.stringify(record)) throw new Error('conflicting audit id');
    if (!previous) next = { ...next, audit: [...next.audit, { id: auditId, record }] };
    applied = result.applied;
    return next;
  });
  return { applied };
}
