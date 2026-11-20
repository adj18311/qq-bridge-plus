import { beijingDay, claimRecoveryProbe, finishRecoveryProbe } from './qzone-policy-offline.mjs';
import { appendOfflineAudit, isSafeQzoneAuditId } from './qzone-audit-offline.mjs';

const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
function validAuditTime(value) {
  if (!Number.isFinite(value) || value < 0) return false;
  try { return /^\d{4}-\d{2}-\d{2}$/.test(beijingDay(value)); } catch { return false; }
}

// Trusted runtime supplies the administrator's own QQ identity and a current
// patrol window. These functions only persist state: they do not perform a
// probe, verify the gateway identity, or schedule an autonomous model call.
export function claimAuditedOfflineProbe(store, id, adminQq, options) {
  if (!store || typeof store.update !== 'function' || !isSafeQzoneAuditId(`probe_result_${id}`) ||
      !validId(id) || typeof adminQq !== 'string' || !/^[1-9]\d{0,19}$/.test(adminQq) ||
      !options || !validAuditTime(options.now)) throw new TypeError('invalid audited probe');
  const selected = { now: options.now, enabled: options.enabled, serviceReady: options.serviceReady, activeTime: options.activeTime };
  let result = { claimed: false };
  store.update((state) => {
    let next = state;
    const transaction = { update(fn) { next = fn(next); } };
    result = claimOfflineProbe(transaction, id, selected);
    if (!result.claimed) return state;
    const record = { time: selected.now, source: 'health_probe', action: 'read_posts', target: adminQq,
      content: '', result: 'unknown' };
    if (!appendOfflineAudit(transaction, `probe_intent_${id}`, record).appended) throw new Error('duplicate probe intent');
    return next;
  });
  return result;
}

export function finishAuditedOfflineProbe(store, id, outcome, now, reason = 'other') {
  if (!store || typeof store.update !== 'function' || !validId(id) || !isSafeQzoneAuditId(`probe_result_${id}`) ||
      !validAuditTime(now) || !['success', 'failure', 'unknown'].includes(outcome)) throw new TypeError('invalid audited probe');
  store.update((state) => {
    if (!Array.isArray(state.audit)) throw new TypeError('invalid audit state');
    const matches = state.audit.filter(entry => entry?.id === `probe_intent_${id}`);
    const intent = matches[0]?.record;
    if (matches.length !== 1 || !intent || intent.source !== 'health_probe' || intent.action !== 'read_posts' ||
        intent.result !== 'unknown' || !Number.isFinite(intent.time) || now < intent.time ||
        typeof intent.target !== 'string' || !/^[1-9]\d{0,19}$/.test(intent.target)) throw new TypeError('invalid probe intent');
    let next = state;
    const transaction = { update(fn) { next = fn(next); } };
    finishOfflineProbe(transaction, id, outcome, reason);
    const record = { time: now, source: 'health_probe', action: 'read_posts', target: intent.target,
      content: '', result: outcome, reason: outcome === 'success' ? '' : reason };
    if (!appendOfflineAudit(transaction, `probe_result_${id}`, record).appended) throw new Error('duplicate probe result');
    return next;
  });
}

// Release a persisted claim only when the runtime can prove its adapter was
// never invoked. This keeps the 24h opportunity available without recording a
// failed probe or changing either pause layer.
export function releaseAuditedUnsentOfflineProbe(store, id, now, networkNotCalled) {
  if (!store || typeof store.update !== 'function' || !validId(id) ||
      !isSafeQzoneAuditId(`probe_result_${id}`) || !validAuditTime(now) || networkNotCalled !== true) {
    throw new TypeError('unsent probe and valid clock required');
  }
  store.update((state) => {
    if (state.probe !== 'claimed' || state.probeId !== id || !state.accessPaused ||
        !Array.isArray(state.audit) || !Array.isArray(state.notices)) throw new TypeError('invalid claimed probe');
    const matches = state.audit.filter(entry => entry?.id === `probe_intent_${id}`);
    const intent = matches[0]?.record;
    if (matches.length !== 1 || !intent || intent.source !== 'health_probe' || intent.action !== 'read_posts' ||
        intent.result !== 'unknown' || !validAuditTime(intent.time) || now < intent.time ||
        typeof intent.target !== 'string' || !/^[1-9]\d{0,19}$/.test(intent.target)) {
      throw new TypeError('invalid probe intent');
    }
    let next = { ...state, probe: 'waiting' };
    const record = { time: now, source: 'health_probe', action: 'read_posts', target: intent.target,
      content: 'not_dispatched', result: 'denied', reason: 'policy' };
    const transaction = { update(fn) { next = fn(next); } };
    if (!appendOfflineAudit(transaction, `probe_result_${id}`, record).appended) throw new Error('duplicate probe result');
    return next;
  });
  return { released: true };
}

// Exclusive ownership and termination of the old sender must be established
// by the runtime; the boolean is an assertion, not a process lock.
export function recoverAuditedAbandonedOfflineProbe(store, exclusiveOwnershipConfirmed, now) {
  if (!store || typeof store.update !== 'function' || exclusiveOwnershipConfirmed !== true || !validAuditTime(now)) {
    throw new TypeError('exclusive ownership and valid clock required');
  }
  let result = { recovered: false };
  store.update((state) => {
    if (state.probe !== 'claimed') return state;
    const id = state.probeId;
    if (!validId(id) || !isSafeQzoneAuditId(`probe_result_${id}`) || !Array.isArray(state.audit)) throw new TypeError('invalid probe');
    const matches = state.audit.filter(entry => entry?.id === `probe_intent_${id}`);
    const intent = matches[0]?.record;
    if (matches.length !== 1 || !intent || intent.source !== 'health_probe' || intent.action !== 'read_posts' ||
        intent.result !== 'unknown' || !validAuditTime(intent.time) || now < intent.time ||
        typeof intent.target !== 'string' || !/^[1-9]\d{0,19}$/.test(intent.target)) throw new TypeError('invalid probe intent');
    let next = state;
    const transaction = { update(fn) { next = fn(next); } };
    result = recoverAbandonedOfflineProbe(transaction, true);
    const record = { time: now, source: 'health_probe', action: 'read_posts', target: intent.target,
      content: 'probe_interrupted', result: 'unknown', reason: 'other' };
    if (!appendOfflineAudit(transaction, `probe_result_${id}`, record).appended) throw new Error('duplicate probe result');
    return next;
  });
  return result;
}

// This experiment never invokes a gateway. The caller supplies a unique ID
// for each attempt and must check the global enable flag at dispatch time too.
export function claimOfflineProbe(store, id, options) {
  if (!store || typeof store.update !== 'function' || !validId(id)) throw new TypeError('invalid probe');
  let claimed = false;
  store.update((state) => {
    // Never trust a stale caller snapshot over the persisted module switch.
    if (state.enabled !== true) return state;
    const result = claimRecoveryProbe(state, options);
    if (!result.claimed) return state;
    if (state.probeId === id) throw new Error('probe id reused');
    claimed = true;
    return { ...result.state, probeId: id, probeWriteSnapshot: {
      paused: state.writePaused, cycleId: state.pauseCycles?.write?.id ?? null,
    } };
  });
  return { claimed };
}

export function finishOfflineProbe(store, id, outcome, reason = 'other') {
  const reasons = ['other', 'network', 'not_accessible', 'login_expired', 'captcha', 'timeout', 'platform_error', 'unknown'];
  if (!store || typeof store.update !== 'function' || !validId(id) || !reasons.includes(reason)) throw new TypeError('invalid probe');
  store.update((state) => {
    if (state.probeId !== id || !Array.isArray(state.notices)) throw new Error('stale probe or invalid notices');
    const snapshot = state.probeWriteSnapshot;
    const sameWritePause = snapshot && snapshot.paused === true &&
      (typeof snapshot.cycleId === 'string' || snapshot.cycleId === null) &&
      snapshot.cycleId === (state.pauseCycles?.write?.id ?? null);
    // A delayed probe must not erase a write pause that appeared after its
    // claim. Legacy in-flight probes have no snapshot and fail closed.
    const next = finishRecoveryProbe(state, outcome, { preserveWrite: state.writePaused && !sameWritePause });
    if (outcome !== 'success') {
      next.probeFailureReason = reason;
      next.notices = [...state.notices, { layer: 'access', cause: 'probe_failed', reason, operationId: id }];
    }
    return next;
  });
}

// Call only after the runtime has independently established exclusive
// ownership and that the previous probe is no longer in flight. This helper
// cannot prove process death or acquire that lock by itself.
export function recoverAbandonedOfflineProbe(store, exclusiveOwnershipConfirmed) {
  if (!store || typeof store.update !== 'function' || exclusiveOwnershipConfirmed !== true) throw new TypeError('exclusive ownership required');
  let recovered = false;
  store.update((state) => {
    if (state.probe !== 'claimed') return state;
    if (!state.accessPaused || !validId(state.probeId) || !Array.isArray(state.notices)) throw new TypeError('invalid abandoned probe');
    recovered = true;
    return { ...state, probe: 'manual_only', notices: [...state.notices,
      { layer: 'access', cause: 'probe_interrupted', operationId: state.probeId }] };
  });
  return { recovered };
}
