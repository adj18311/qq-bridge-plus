import { consumeHistoryGrant } from './qzone-policy-offline.mjs';
import { appendOfflineAudit, formatAuditRecord } from './qzone-audit-offline.mjs';

// The calling runtime must derive and verify the grant and question identity
// from the original QQ event. This never performs a platform request.
export function consumeStoredHistoryGrant(store, id, request, input) {
  if (!store || typeof store.update !== 'function' || typeof id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,96}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new TypeError('invalid grant');
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('invalid audit intent');
  request = { ...request };
  const record = formatAuditRecord(input);
  if (!request || record.source !== 'qq' || record.action !== 'read_posts' || record.target !== request.requester ||
      record.postId !== request.postId || record.content !== '' || record.result !== 'unknown' || record.reason !== '') throw new TypeError('invalid audit intent');
  let result = { allowed: false };
  store.update((state) => {
    if (!state.grants || typeof state.grants !== 'object' || Array.isArray(state.grants)) throw new TypeError('invalid grants');
    if (!Object.hasOwn(state.grants, id)) return state;
    result = consumeHistoryGrant(state.grants[id], request);
    if (!result.allowed) return state;
    let next = { ...state, grants: { ...state.grants, [id]: result.grant } };
    const transaction = { update(fn) { next = fn(next); } };
    if (!appendOfflineAudit(transaction, `grant_${id}`, record).appended) throw new Error('duplicate intent');
    return next;
  });
  return { allowed: result.allowed };
}
