import { randomUUID } from 'node:crypto';
import { claimAuditedOfflineProbe, finishAuditedOfflineProbe, releaseAuditedUnsentOfflineProbe } from './qzone-recovery-offline.mjs';

const inFlight = new WeakMap();
const SAFE_QQ = /^[1-9]\d{0,19}$/;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const TIMEOUT = Symbol('health_probe_timeout');
const NOT_DISPATCHED = Symbol('health_probe_not_dispatched');

function evaluateBoolean(source) {
  try { return typeof source === 'function' ? source() === true : source === true; }
  catch { return false; }
}

// This binds persisted state only. Production must additionally attest the
// live connection and its generation; comparing account strings cannot detect ABA.
function matchesBot(state, botQq) {
  return !!state && state.botQq === botQq && state.selfId === botQq;
}

function classify(result, adminQq, botQq) {
  if (!result || typeof result !== 'object') return { outcome: 'unknown', reason: 'other' };
  if (result.status === 'ok') {
    if (typeof result.targetQq !== 'string' || typeof result.selfQq !== 'string') {
      return { outcome: 'unknown', reason: 'other' };
    }
    if (result.targetQq !== adminQq || result.selfQq !== botQq) {
      return { outcome: 'failure', reason: 'other' };
    }
    return { outcome: 'success', reason: 'other' };
  }
  const reasons = {
    gateway_unavailable: 'network', timeout: 'timeout', login_expired: 'login_expired',
    captcha: 'captcha', not_accessible: 'not_accessible', platform_error: 'platform_error'
  };
  if (Object.hasOwn(reasons, result.status)) return { outcome: 'failure', reason: reasons[result.status] };
  return { outcome: 'unknown', reason: 'other' };
}

/**
 * Run the one persisted recovery probe. The adapter must perform a read-only
 * request for targetQq and independently attest the authenticated selfQq.
 * Timeout abort is advisory: a non-cooperative adapter remains single-flight
 * until its promise settles, and its late value is never used for recovery.
 */
export async function runQzoneHealthProbe(options = {}) {
  const { store, readOwnSpace, adminQq, botQq, now: readClock } = options;
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function' || typeof readOwnSpace !== 'function' ||
      typeof readClock !== 'function' || typeof adminQq !== 'string' || !SAFE_QQ.test(adminQq) ||
      typeof botQq !== 'string' || !SAFE_QQ.test(botQq) ||
      (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1))) {
    return { status: 'invalid_runtime' };
  }

  const active = inFlight.get(store);
  if (active) return { status: 'in_flight' };

  try { if (!matchesBot(store.read(), botQq)) return { status: 'identity_mismatch' }; }
  catch { return { status: 'identity_mismatch' }; }

  let now;
  try { now = readClock(); } catch { return { status: 'not_eligible' }; }
  if (!Number.isFinite(now) || !evaluateBoolean(options.serviceReady) || !evaluateBoolean(options.activeTime)) {
    return { status: 'not_eligible' };
  }

  const id = `health-${randomUUID()}`;
  let claim;
  try {
    const guardedStore = { update(fn) { return store.update(state => {
      if (!matchesBot(state, botQq)) throw new Error('identity mismatch');
      return fn(state);
    }); } };
    claim = claimAuditedOfflineProbe(guardedStore, id, adminQq, {
      now, enabled: true, serviceReady: true, activeTime: true
    });
  } catch {
    return { status: 'claim_failed' };
  }
  if (!claim.claimed) return { status: 'not_eligible' };

  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const flight = { task: null, adapterSettled: false, timedOut: false };
  inFlight.set(store, flight);
  const task = (async () => {
    const controller = new AbortController();
    let timer;
    const adapterResult = Promise.resolve().then(() => {
      let currentState;
      try { currentState = store.read(); } catch { return NOT_DISPATCHED; }
      if (!matchesBot(currentState, botQq)) return null;
      if (currentState.enabled !== true ||
          !evaluateBoolean(options.serviceReady) || !evaluateBoolean(options.activeTime)) {
        return NOT_DISPATCHED;
      }
      // This persisted/config recheck and the outbound network send cannot be
      // atomic across processes. A disable racing after this check may still
      // overlap a send; production must not treat this module as proving that race solved.
      return readOwnSpace(Object.freeze({ targetQq: adminQq, readOnly: true, signal: controller.signal }));
    }).then(
      value => ({ kind: 'value', value }),
      () => ({ kind: 'error' })
    ).then(value => {
      flight.adapterSettled = true;
      if (flight.timedOut && inFlight.get(store) === flight) inFlight.delete(store);
      return value;
    });
    const timeoutResult = new Promise(resolve => {
      timer = setTimeout(() => {
        flight.timedOut = true;
        controller.abort();
        resolve({ kind: TIMEOUT });
      }, timeoutMs);
    });
    const raced = await Promise.race([adapterResult, timeoutResult]);
    clearTimeout(timer);
    if (raced.kind === 'value' && raced.value === NOT_DISPATCHED) {
      let canceledAt;
      try { canceledAt = readClock(); } catch { canceledAt = now; }
      try {
        releaseAuditedUnsentOfflineProbe(store, id,
          Number.isFinite(canceledAt) && canceledAt >= now ? canceledAt : now, true);
        return { status: 'unknown' };
      } catch { return { status: 'finish_failed' }; }
    }
    let outcome = 'unknown';
    let reason = 'other';
    if (raced.kind === 'value') {
      try { ({ outcome, reason } = classify(raced.value, adminQq, botQq)); }
      catch { outcome = 'unknown'; reason = 'other'; }
    }
    else if (raced.kind === 'error' || raced.kind === TIMEOUT) reason = raced.kind === TIMEOUT ? 'timeout' : 'other';

    let completedAt;
    try { completedAt = readClock(); } catch { completedAt = Number.NaN; }
    if (!Number.isFinite(completedAt) || completedAt < now) {
      // Persist an unknown terminal outcome when the completion clock cannot
      // be trusted; the recovery state then becomes manual-only.
      outcome = 'unknown';
      reason = 'other';
    }
    try {
      const settlementTime = Number.isFinite(completedAt) && completedAt >= now ? completedAt : now;
      const guardedStore = { update(fn) { return store.update(state => {
        if (outcome === 'success' && !matchesBot(state, botQq)) {
          outcome = 'unknown'; reason = 'other';
          let next = state;
          finishAuditedOfflineProbe({ update(transform) { next = transform(next); } }, id, outcome, settlementTime, reason);
          return next;
        }
        return fn(state);
      }); } };
      finishAuditedOfflineProbe(guardedStore, id, outcome, settlementTime, reason);
    } catch {
      // Claim remains persisted as claimed and is therefore never auto-reissued.
      return { status: 'finish_failed' };
    }

    if (raced.kind === TIMEOUT) reason = 'timeout';
    return { status: outcome === 'success' ? 'recovered' : outcome === 'failure' ? 'failed' : 'unknown',
      reason: outcome === 'success' ? undefined : reason,
      ...(raced.kind === TIMEOUT ? { adapterMayStillBeRunning: true } : {}) };
  })();
  flight.task = task;
  try { return await task; }
  finally {
    if (inFlight.get(store) === flight && (!flight.timedOut || flight.adapterSettled)) inFlight.delete(store);
  }
}
