import { consumeQzoneWriteBinding } from './qzone-write-binding-offline.mjs';
import { formatAuditRecord } from './qzone-audit-offline.mjs';
import { reserveOfflinePost, reserveOfflineInteraction } from './qzone-reservation-offline.mjs';
import { claimQzoneWriteDispatch } from './qzone-dispatch-claim-offline.mjs';
import { settleOfflineWrite } from './qzone-settlement-offline.mjs';
import { openOfflineStore } from './qzone-store-offline.mjs';
// The reply-evidence predicate has ONE home (see that file's header): the audited reservation path
// and this one must not be able to disagree about what "the evidence describes this reply" means.
import { matchesReplyEvidence } from './qzone-reply-evidence-offline.mjs';
import { lstatSync } from 'node:fs';

const privateRuns = new WeakMap();
const RESERVED = Object.freeze({ publish: 'post', comment: 'comment', reply: 'comment', like: 'like' });
const ALLOWED_OUTCOMES = new Set(['success', 'failure', 'unknown', 'not_accessible', 'login_expired', 'captcha', 'network_unavailable']);

function safeEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function appendAudit(state, id, record) {
  if (!Array.isArray(state.audit)) throw new TypeError('invalid audit state');
  const previous = state.audit.find((entry) => entry?.id === id);
  if (previous) {
    if (!safeEqual(previous.record, record)) throw new TypeError('conflicting audit intent');
    return state;
  }
  return { ...state, audit: [...state.audit, { id, record }] };
}

function transactionFacade(initial) {
  let current = initial;
  return {
    get state() { return current; },
    update(fn) {
      if (typeof fn !== 'function') throw new TypeError('transaction callback required');
      const next = fn(current);
      if (next && typeof next.then === 'function') throw new TypeError('synchronous transaction required');
      current = next;
      return current;
    },
  };
}

function reserveAndAudit(store, run) {
  const { id, kind, auditInput, audit } = run;
  let reservationResult;
  store.update((state) => {
    if (!Array.isArray(state.audit)) throw new TypeError('invalid audit state');
    if (audit.reason !== '') {
      reservationResult = { allowed: false, reason: 'invalid_intent_reason' };
      return state;
    }
    if (!['qq', 'patrol'].includes(audit.source)) {
      reservationResult = { allowed: false, reason: 'invalid_source' };
      return state;
    }
    const intentId = `intent_${id}`;
    const matches = state.audit.filter((entry) => entry?.id === intentId);
    const reservationKind = state.ledger?.reservations?.[id];
    if (matches.length || reservationKind) {
      reservationResult = { allowed: false, reason: 'pending' };
      return state;
    }
    if (kind === 'publish' && (typeof state.selfId !== 'string' || state.selfId !== audit.target)) {
      reservationResult = { allowed: false, reason: 'identity_mismatch' };
      return state;
    }
    if (kind === 'reply') {
      const matches = Array.isArray(state.commentEvidence)
        ? state.commentEvidence.filter((item) => item && item.target === audit.target &&
          item.postId === audit.postId && item.commentId === audit.commentId)
        : [];
      if (!matches.length) {
        reservationResult = { allowed: false, reason: 'missing_comment_evidence' };
        return state;
      }
      if (matches.length !== 1 || !matchesReplyEvidence(matches[0], run.request)) {
        reservationResult = { allowed: false, reason: 'comment_evidence_mismatch' };
        return state;
      }
    }

    const tx = transactionFacade(state);
    if (kind === 'publish') {
      reservationResult = reserveOfflinePost(tx, { id, now: auditInput.time });
    } else {
      reservationResult = reserveOfflineInteraction(tx, {
        id, now: auditInput.time, tool: kind, target: auditInput.target,
        postId: auditInput.postId, source: auditInput.source,
        commentId: kind === 'reply' ? auditInput.commentId : null,
      });
    }
    if (!reservationResult.allowed) return state;
    const updated = appendAudit(tx.state, intentId, audit);
    return updated;
  });
  return reservationResult;
}

function outcomeReason(outcome) {
  if (outcome === 'network_unavailable') return 'network';
  if (['not_accessible', 'login_expired', 'captcha'].includes(outcome)) return outcome;
  if (outcome === 'success' || outcome === 'failure' || outcome === 'unknown') return outcome === 'failure' ? 'other' : '';
  throw new TypeError('invalid fake outcome');
}

function settleFromPrivateSnapshot(store, run, outcome, now) {
  const record = formatAuditRecord({ ...run.auditInput, time: now, result: outcome === 'success' ? 'success' : outcome === 'unknown' ? 'unknown' : 'failure', reason: outcomeReason(outcome) });
  const original = run.audit;
  if (['source', 'action', 'target', 'postId', 'commentId', 'content', 'redacted'].some((key) => record[key] !== original[key])) {
    throw new TypeError('settlement audit binding mismatch');
  }
  let applied = false;
  store.update((state) => {
    const intent = state.audit?.filter((entry) => entry?.id === `intent_${run.id}`) ?? [];
    if (intent.length !== 1 || !safeEqual(intent[0].record, original)) throw new TypeError('missing or conflicting audit intent');
    let next;
    const tx = { update(fn) { next = fn(next); } };
    next = state;
    const result = settleOfflineWrite(tx, run.id, outcome, now);
    const settled = appendAudit(next, `write:${run.id}`, record);
    applied = result.applied;
    return settled;
  });
  return { applied };
}

function readFakeResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('invalid fake result');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !['outcome', 'now'].includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('invalid fake result');
    }
  }
  const { outcome, now } = value;
  if (!ALLOWED_OUTCOMES.has(outcome) || !Number.isFinite(now)) throw new TypeError('invalid fake result');
  return { outcome, now };
}

/**
 * Process-local, offline-only vertical experiment. `fake` is an injected
 * deterministic test double; this module contains no transport or network code.
 * An `outcome: 'success'` result means only that the fake reported success; it
 * is not evidence of platform execution or delivery.
 */
async function simulateWithStore(store, binding, fake) {
  if (!binding || typeof binding !== 'object' || typeof fake !== 'function') {
    return { allowed: false, reason: 'invalid_capability', replayed: false };
  }
  let run;
  try {
    const consumed = consumeQzoneWriteBinding(binding.id, binding.capability);
    run = { ...consumed, kind: consumed.audit.action };
    if (!Object.hasOwn(RESERVED, run.kind) || !Object.isFrozen(run.request) || !Object.isFrozen(run.request.params)) {
      return { allowed: false, reason: 'invalid_capability', replayed: false };
    }
    if (!safeEqual(formatAuditRecord(run.auditInput), run.audit)) return { allowed: false, reason: 'invalid_capability', replayed: false };
  } catch {
    return { allowed: false, reason: 'invalid_capability', replayed: false };
  }

  const state = store.read();
  if (Object.hasOwn(state.dispatchClaims ?? {}, run.id)) {
    return { allowed: false, reason: Object.hasOwn(state.outcomes ?? {}, run.id) ? 'already_settled' : 'pending', replayed: false };
  }
  if (Object.hasOwn(state.outcomes ?? {}, run.id)) {
    return { allowed: false, reason: 'already_settled', replayed: false };
  }
  const reserved = reserveAndAudit(store, run);
  if (!reserved?.allowed) return { allowed: false, reason: reserved?.reason ?? 'reservation_failed', replayed: false };

  const claim = claimQzoneWriteDispatch(store, { id: run.id, kind: run.kind });
  if (!claim.allowed) return { allowed: false, reason: claim.reason, replayed: false };
  privateRuns.set(run, { request: run.request, auditInput: run.auditInput });

  let outcome = 'unknown';
  let settledAt = run.auditInput.time;
  try {
    const fakeResult = readFakeResult(await fake(privateRuns.get(run).request));
    if (fakeResult.now >= run.auditInput.time) {
      outcome = fakeResult.outcome;
      settledAt = fakeResult.now;
    }
  } catch {
    // Once a claim is durable, any ambiguous fake failure is terminal unknown.
  }
  settleFromPrivateSnapshot(store, run, outcome, settledAt);
  privateRuns.delete(run);
  return {
    allowed: true, outcome,
    ...(outcome === 'success' ? { successEvidence: 'fake_simulation_only' } : {}),
    replayed: false,
  };
}

// Accept a path and open the trusted SQLite implementation internally. An
// arbitrary caller supplied update() object cannot claim transactional safety.
export async function simulateQzoneBoundWriteOffline(storePath, binding, fake) {
  if (typeof storePath !== 'string' || !storePath) {
    return { allowed: false, reason: 'invalid_store', replayed: false };
  }
  // This avoids accidental creation and rejects links/non-files. It is only a
  // preflight check: a hostile local process could still swap the path before
  // openOfflineStore opens it (TOCTOU is not solved here).
  try {
    if (!lstatSync(storePath).isFile()) return { allowed: false, reason: 'invalid_store', replayed: false };
  } catch {
    return { allowed: false, reason: 'invalid_store', replayed: false };
  }
  let store;
  try { store = openOfflineStore(storePath, {}); }
  catch { return { allowed: false, reason: 'store_unavailable', replayed: false }; }
  try {
    // Test marker prevents accidental use with the normal console state. It is
    // not an authentication boundary against a local process modifying state.
    if (store.read().offlineTestFixture !== true) return { allowed: false, reason: 'not_test_fixture', replayed: false };
    return await simulateWithStore(store, binding, fake);
  }
  finally { store.close(); }
}
