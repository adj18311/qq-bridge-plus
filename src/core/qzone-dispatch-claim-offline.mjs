// Offline-only dispatch claim. The committed claim is the authorization
// linearization point; a later permission change can still race with the
// caller's actual packet send. This module is not a transport integration.
const OPERATION = Object.freeze({
  publish: { reservation: 'post', action: 'publish' },
  comment: { reservation: 'comment', action: 'comment' },
  reply: { reservation: 'comment', action: 'reply' },
  like: { reservation: 'like', action: 'like' },
});
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function validMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function deny(reason) { return { allowed: false, reason }; }

/** Atomically claim one previously reserved and audited write for dispatch.
 * Requires a trusted synchronous transactional store; callback checks cannot
 * prove an arbitrary store actually committed synchronously. The caller must
 * still treat post-claim crashes/outcomes conservatively. */
export function claimQzoneWriteDispatch(store, { id, kind } = {}) {
  if (!store || typeof store.update !== 'function' || typeof id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(id) || RESERVED_IDS.has(id) ||
      typeof kind !== 'string' || !Object.hasOwn(OPERATION, kind)) return deny('invalid_operation');

  let result;
  let active = true;
  let calls = 0;
  let updateResult;
  try { updateResult = store.update((state) => {
    if (!active) return state;
    if (++calls !== 1) throw new TypeError('single synchronous transaction required');
    if (!state || typeof state !== 'object' ||
        ['enabled', 'writeAllowed', 'accessPaused', 'writePaused'].some(key => typeof state[key] !== 'boolean') ||
        !validMap(state.tools) || !validMap(state.ledger?.reservations) ||
        !validMap(state.outcomes) || !validMap(state.dispatchClaims) || !Array.isArray(state.audit)) {
      result = deny('invalid_state');
      return state;
    }
    if (!state.enabled) { result = deny('disabled'); return state; }
    if (!state.writeAllowed) { result = deny('permission'); return state; }
    if (state.accessPaused) { result = deny('access_paused'); return state; }
    if (state.writePaused) { result = deny('write_paused'); return state; }
    if (state.tools[kind] !== true) { result = deny('tool_permission'); return state; }

    const operation = OPERATION[kind];
    if (state.ledger.reservations[id] !== operation.reservation) {
      result = deny('missing_reservation'); return state;
    }
    if (Object.hasOwn(state.dispatchClaims, id)) { result = deny('duplicate'); return state; }
    if (Object.hasOwn(state.outcomes, id)) { result = deny('already_settled'); return state; }

    const intents = state.audit.filter(entry => entry?.id === `intent_${id}`);
    if (intents.length !== 1) { result = deny(intents.length ? 'intent_mismatch' : 'missing_intent'); return state; }
    const record = intents[0].record;
    if (!record || record.action !== operation.action || record.result !== 'unknown' || record.reason !== '' ||
        !((record.redacted === true && record.content === '[REDACTED]') ||
          (record.redacted === false && typeof record.content === 'string' && record.content !== '[REDACTED]')) ||
        !['qq', 'patrol'].includes(record.source) ||
        typeof record.target !== 'string' || !/^\d{1,20}$/.test(record.target) ||
        (kind === 'publish' && (typeof state.selfId !== 'string' || record.target !== state.selfId))) {
      result = deny('intent_mismatch'); return state;
    }

    result = { allowed: true, claim: { id, kind } };
    return { ...state, dispatchClaims: { ...state.dispatchClaims, [id]: kind } };
  }); } finally { active = false; }
  if (updateResult && typeof updateResult.then === 'function') {
    Promise.resolve(updateResult).catch(() => {});
    throw new TypeError('synchronous transaction required');
  }
  if (calls !== 1) throw new TypeError('synchronous transaction required');
  return result;
}
