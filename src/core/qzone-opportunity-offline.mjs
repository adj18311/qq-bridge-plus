import { authorizeTool, beijingDay, checkBrowseBudget, isActiveTime, validatePatrolInterval } from './qzone-policy-offline.mjs';

export const QZONE_OPPORTUNITY_OFFLINE_BOUNDARY = Object.freeze({
  timers: false,
  modelCalls: false,
  networkCalls: false,
  crossProcessDispatchLock: false,
});

const DANGEROUS_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function validOpportunityId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) && !DANGEROUS_IDS.has(id);
}

function validRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

// Offline adapter only. The caller supplies a trusted existing patrol opportunity
// and timestamp. This persists an offer marker, while actual read quota is reserved
// later by reserveOfflineRead when a real read is chosen and dispatched.
export function adaptQzoneOfflineOpportunity(store, opportunity) {
  if (!store || typeof store.update !== 'function' || !opportunity ||
      !validOpportunityId(opportunity.id) || !Number.isFinite(opportunity.now) ||
      !Number.isFinite(new Date(opportunity.now).getTime())) {
    throw new TypeError('invalid patrol opportunity');
  }

  let decision;
  store.update((state) => {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('invalid qzone state');
    const offers = state.offlineOpportunityOffers ?? {};
    if (!validRecord(offers)) throw new TypeError('invalid opportunity offers');
    const usedOpportunities = state.usedOpportunities ?? {};
    if (!validRecord(usedOpportunities)) throw new TypeError('invalid used opportunities');

    if (Object.hasOwn(offers, opportunity.id) || Object.hasOwn(usedOpportunities, opportunity.id)) {
      decision = { allowed: false, reason: 'duplicate' };
      return state;
    }

    if (!validatePatrolInterval(state.intervalMinutes)) {
      decision = { allowed: false, reason: 'invalid' };
      return state;
    }
    let lastOffer = null;
    for (const timestamp of Object.values(offers)) {
      if (!Number.isFinite(timestamp)) {
        decision = { allowed: false, reason: 'invalid' };
        return state;
      }
      if (lastOffer === null || timestamp > lastOffer) lastOffer = timestamp;
    }
    if (lastOffer !== null && opportunity.now < lastOffer) {
      decision = { allowed: false, reason: 'clock' };
      return state;
    }
    if (lastOffer !== null && (opportunity.now - lastOffer) / 60000 < state.intervalMinutes) {
      decision = { allowed: false, reason: 'interval' };
      return state;
    }

    const gate = authorizeTool(state, 'read_posts');
    if (!gate.allowed) {
      decision = { allowed: false, reason: gate.reason };
      return state;
    }

    const activeStart = state.activeStart;
    const activeEnd = state.activeEnd;
    if (!Number.isInteger(activeStart) || activeStart < 0 || activeStart >= 1440 ||
        !Number.isInteger(activeEnd) || activeEnd < 0 || activeEnd >= 1440 || activeStart === activeEnd) {
      decision = { allowed: false, reason: 'invalid' };
      return state;
    }
    const activeTime = isActiveTime(opportunity.now, activeStart, activeEnd);
    if (!validDay(state.browseDay) ||
        !Number.isSafeInteger(state.todayBrowses) || state.todayBrowses < 0) {
      decision = { allowed: false, reason: 'invalid' };
      return state;
    }

    const day = beijingDay(opportunity.now);
    if (day < state.browseDay) {
      decision = { allowed: false, reason: 'clock' };
      return state;
    }
    const budget = checkBrowseBudget({
      ...state,
      now: opportunity.now,
      todayBrowses: day === state.browseDay ? state.todayBrowses : 0,
      activeTime,
    }, 'proactive');
    if (!budget.allowed) {
      decision = budget;
      return state;
    }

    decision = {
      allowed: true,
      opportunity: { id: opportunity.id, tool: 'read_posts', now: opportunity.now },
    };
    return { ...state, offlineOpportunityOffers: { ...offers, [opportunity.id]: opportunity.now } };
  });

  return decision;
}
