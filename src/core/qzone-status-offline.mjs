import { beijingDay, validatePatrolInterval } from './qzone-policy-offline.mjs';

const TOOLS = ['read_posts', 'read_comments', 'publish', 'comment', 'reply', 'like'];
const KINDS = ['post', 'comment', 'like'];

// Pure offline projection only. Authentication and real-time dispatch gates
// belong to the future console/runtime; never expose the original state.
export function qzoneOfflineStatus(state, now) {
  const day = beijingDay(now);
  const storedDay = state?.ledger?.day;
  if (!state || ['enabled', 'readAllowed', 'writeAllowed', 'accessPaused', 'writePaused'].some((k) => typeof state[k] !== 'boolean') ||
      !state.tools || TOOLS.some((k) => !Object.hasOwn(state.tools, k) || typeof state.tools[k] !== 'boolean') ||
      !state.limits || !state.ledger?.used || KINDS.some((k) => !Number.isSafeInteger(state.limits[k]) || state.limits[k] < 0 || state.limits[k] > 99 ||
        !Number.isSafeInteger(state.ledger.used[k]) || state.ledger.used[k] < 0) ||
      typeof storedDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(storedDay) ||
      !Number.isFinite(Date.parse(`${storedDay}T00:00:00Z`)) || new Date(`${storedDay}T00:00:00Z`).toISOString().slice(0, 10) !== storedDay || storedDay > day ||
      !validatePatrolInterval(state.intervalMinutes) || ![state.activeStart, state.activeEnd].every((x) => Number.isInteger(x) && x >= 0 && x < 1440) || state.activeStart === state.activeEnd) {
    throw new TypeError('invalid qzone status state');
  }
  const quota = Object.fromEntries(KINDS.map((kind) => {
    const used = storedDay === day ? state.ledger.used[kind] : 0;
    const limit = state.limits[kind];
    return [kind, { used, limit, remaining: Math.max(0, limit - used) }];
  }));
  return { day, enabled: state.enabled, readAllowed: state.readAllowed, writeAllowed: state.writeAllowed,
    accessPaused: state.accessPaused, writePaused: state.writePaused,
    tools: Object.fromEntries(TOOLS.map((tool) => [tool, state.tools[tool]])), quota,
    intervalMinutes: state.intervalMinutes, activeStart: state.activeStart, activeEnd: state.activeEnd };
}
