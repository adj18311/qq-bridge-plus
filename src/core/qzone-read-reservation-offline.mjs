import { authorizeTool, beijingDay, checkBrowseBudget, isActiveTime } from './qzone-policy-offline.mjs';
import { appendOfflineAudit, formatAuditRecord } from './qzone-audit-offline.mjs';
class Denied extends Error {}
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);

// Offline only. Caller must establish trusted source/opportunity and content
// scope separately; this function never performs or authorizes a platform fetch.
export function reserveOfflineRead(store, request) {
  if (!store || typeof store.update !== 'function' || !request || !validId(request.id) ||
      !['read_posts', 'read_comments'].includes(request.tool) || !['proactive', 'requested'].includes(request.source) ||
      !Number.isFinite(request.now) || typeof request.activeTime !== 'boolean' ||
      (request.source === 'proactive' && !validId(request.opportunity))) throw new TypeError('invalid read reservation');
  try {
    store.update((state) => {
      if (!state.readAttempts || typeof state.readAttempts !== 'object' || Array.isArray(state.readAttempts) ||
          !state.usedOpportunities || typeof state.usedOpportunities !== 'object' || Array.isArray(state.usedOpportunities) ||
          typeof state.browseDay !== 'string' || !Number.isSafeInteger(state.todayBrowses) || state.todayBrowses < 0) throw new TypeError('invalid read state');
      const gate = authorizeTool(state, request.tool);
      if (!gate.allowed) throw new Denied(gate.reason);
      if (Object.hasOwn(state.readAttempts, request.id)) throw new Denied('duplicate');
      const day = beijingDay(request.now);
      if (day < state.browseDay) throw new Denied('clock');
      const count = day === state.browseDay ? state.todayBrowses : 0;
      if (request.source === 'proactive' && Object.hasOwn(state.usedOpportunities, request.opportunity)) throw new Denied('opportunity_used');
      const activeTime = request.source === 'proactive' ? isActiveTime(request.now, state.activeStart, state.activeEnd) : false;
      const decision = checkBrowseBudget({ ...state, now: request.now, todayBrowses: count, activeTime }, request.source);
      if (!decision.allowed) throw new Denied(decision.reason);
      const next = { ...state, readAttempts: { ...state.readAttempts, [request.id]: true }, browseDay: day, todayBrowses: count };
      if (request.source === 'proactive') {
        next.todayBrowses++; next.lastBrowseAt = request.now;
        next.usedOpportunities = { ...state.usedOpportunities, [request.opportunity]: true };
      }
      return next;
    });
    return { allowed: true };
  } catch (error) {
    if (error instanceof Denied) return { allowed: false, reason: error.message };
    throw error;
  }
}

// This binds an offline intent to its target; it does not establish content
// authorization, platform identity, or the trustworthiness of the request.
export function reserveAuditedOfflineRead(store, request, input) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('invalid read intent');
  request = { ...request };
  const record = formatAuditRecord(input);
  if (!request || record.time !== request.now || record.action !== request.tool || record.target !== request.target ||
      record.source !== (request.source === 'proactive' ? 'patrol' : 'qq') || record.result !== 'unknown' ||
      record.reason !== '' || record.content !== '' || record.postId !== (request.postId ?? null) ||
      record.commentId !== (request.commentId ?? null)) throw new TypeError('invalid read intent');
  let result;
  store.update((state) => {
    let next = state;
    const transaction = { update(fn) { next = fn(next); } };
    result = reserveOfflineRead(transaction, request);
    if (!result.allowed) return state;
    if (!appendOfflineAudit(transaction, `read_intent_${request.id}`, record).appended) throw new Error('duplicate intent');
    return next;
  });
  return result;
}
