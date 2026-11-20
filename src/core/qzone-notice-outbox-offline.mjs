// Offline state transitions only. No QQ sender is invoked here. While claims
// are outstanding the notices array must be append-only: indices are identities.
const validToken = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(x);
// reserveWrite/settleOfflineWrite accept opaque operation IDs beyond the
// claim-token alphabet. Keep event identity separate from claim credentials.
const validOperationId = (x) => typeof x === 'string' && x.length > 0 && x.length <= 128 &&
  !['__proto__', 'constructor', 'prototype'].includes(x);

function entry(state, index) {
  if (!state || !Array.isArray(state.notices) || !Number.isSafeInteger(index) || index < 0 || !state.notices[index] ||
      !['access', 'write'].includes(state.notices[index].layer) || !validOperationId(state.notices[index].operationId)) throw new TypeError('invalid notice');
  return state.notices[index];
}

export function claimOfflineNotice(store, index, token) {
  if (!store || typeof store.update !== 'function' || !validToken(token)) throw new TypeError('invalid claim');
  let claimed = false;
  store.update((state) => {
    const current = entry(state, index);
    if (current.delivery != null && current.delivery !== 'pending') return state;
    if (current.usedClaimTokens != null && (!Array.isArray(current.usedClaimTokens) || current.usedClaimTokens.some((x) => !validToken(x)))) throw new TypeError('invalid claim history');
    const used = current.usedClaimTokens ?? [];
    if (current.claimToken === token || used.includes(token)) throw new Error('claim token reused');
    const notices = [...state.notices];
    notices[index] = { ...current, delivery: 'claimed', claimToken: token, usedClaimTokens: [...used, token] };
    claimed = true;
    return { ...state, notices };
  });
  return { claimed };
}

export function finishOfflineNotice(store, index, token, result) {
  if (!store || typeof store.update !== 'function' || !validToken(token) || !['success', 'failure', 'unknown'].includes(result)) throw new TypeError('invalid outcome');
  store.update((state) => {
    const current = entry(state, index);
    if (current.delivery !== 'claimed' || current.claimToken !== token) throw new Error('stale claim');
    const notices = [...state.notices];
    notices[index] = { ...current, delivery: result === 'success' ? 'sent' : result === 'failure' ? 'pending' : 'unknown' };
    return { ...state, notices };
  });
}

// Only call after the runtime has established exclusive ownership and the
// old sender is no longer running; a boolean cannot itself establish that.
export function recoverOfflineNotice(store, index, exclusiveOwnershipConfirmed) {
  if (!store || typeof store.update !== 'function' || exclusiveOwnershipConfirmed !== true) throw new TypeError('exclusive ownership required');
  let recovered = false;
  store.update((state) => {
    const current = entry(state, index);
    if (current.delivery !== 'claimed') return state;
    const notices = [...state.notices];
    notices[index] = { ...current, delivery: 'unknown' };
    recovered = true;
    return { ...state, notices };
  });
  return { recovered };
}
