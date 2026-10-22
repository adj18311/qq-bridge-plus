/**
 * Pure watchdog policy seam for the busy watchdog.
 *
 * Extracted verbatim from the pre-stage bridge:
 * - watchdogTiming / classifyWatchdog: scanBusyWatchdogKeyV2 (snapshot lines 2819-2821 and
 *   2835-2846), duration arithmetic and warn/release/hardcap classification only;
 * - normalizeBusyWatchdogConfig: busyWatchdogConfig (snapshot lines 2623-2644), numeric/default
 *   normalization of exactly the seven public busy-watchdog config fields;
 * - canRearmBusyWatchdog: busyRearmAllowedV2 (snapshot lines 2777-2783), the pure cooldown plus
 *   hourly-cap rearm gate.
 *
 * All state, configuration reading, mode/allow gates, stall probing, warn deduplication,
 * release/rearm actions, logging and timers stay in the bridge caller.
 *
 * No implicit defaults, global config, validation, I/O, Date, logging or mutable state here:
 * inputs are used exactly as supplied, so NaN/Infinity/zero/negative/future timestamps keep
 * ordinary JS behavior.
 */

/**
 * @param {{ at: number, busySince: number, lastFrameAt: number }} input
 * @returns {{ busyMs: number, idleMs: number }}
 */
export function watchdogTiming({ at, busySince, lastFrameAt }) {
  return {
    busyMs: Math.max(0, at - busySince),
    idleMs: Math.max(0, at - lastFrameAt),
  };
}

/**
 * @param {{ busyMs: number, idleMs: number, thresholds: { warnMs: number, releaseMs: number, hardCapMs: number } }} input
 * @returns {{ tier: 'release' | 'hardcap' | 'warn' | null, warnTier: boolean, releaseByBudget: boolean, releaseByHardCap: boolean, hardCapSilenceMs: number }}
 */
export function classifyWatchdog({ busyMs, idleMs, thresholds: wd }) {
  const warnTier = wd.warnMs > 0 && busyMs >= wd.warnMs && idleMs >= wd.warnMs;
  const releaseByBudget = busyMs >= wd.releaseMs && idleMs >= wd.releaseMs;
  const hardCapSilenceMs = wd.warnMs > 0 ? Math.min(wd.warnMs, wd.releaseMs) : wd.releaseMs;
  const releaseByHardCap = busyMs >= wd.hardCapMs && idleMs >= hardCapSilenceMs;
  const tier = releaseByBudget ? 'release' : (releaseByHardCap ? 'hardcap' : (warnTier ? 'warn' : null));
  return { tier, warnTier, releaseByBudget, releaseByHardCap, hardCapSilenceMs };
}

/**
 * Normalize the busy-watchdog config fields exactly as busyWatchdogConfig did.
 *
 * `defaults` is explicit input data (the bridge's BUSY_WATCHDOG_DEFAULTS); it is never copied into
 * the result. Null/undefined/'' fall back, any other value is Number-coerced and falls back when
 * non-finite. Only `enabled === false` disables the watchdog; warn/rearm clamps stop at zero,
 * release/hardCap fall back unless strictly positive, checkInterval floors at 1000.
 *
 * @param {Record<string, unknown>} raw
 * @param {{ warnMs: number, releaseMs: number, hardCapMs: number, checkIntervalMs: number, rearmCooldownMs: number, maxRearmPerHour: number }} defaults
 * @returns {{ enabled: boolean, warnMs: number, releaseMs: number, hardCapMs: number, checkIntervalMs: number, rearmCooldownMs: number, maxRearmPerHour: number }}
 */
export function normalizeBusyWatchdogConfig(raw, defaults) {
  const d = defaults;
  const num = (value, fallback) => {
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const hardCap = num(raw.hardCapMs, d.hardCapMs);
  const release = num(raw.releaseMs, d.releaseMs);
  return {
    enabled: raw.enabled !== false,
    warnMs: Math.max(0, num(raw.warnMs, d.warnMs)),
    releaseMs: release > 0 ? release : d.releaseMs,
    hardCapMs: hardCap > 0 ? hardCap : d.hardCapMs,
    checkIntervalMs: Math.max(1000, num(raw.checkIntervalMs, d.checkIntervalMs)),
    rearmCooldownMs: Math.max(0, num(raw.rearmCooldownMs, d.rearmCooldownMs)),
    maxRearmPerHour: Math.max(0, num(raw.maxRearmPerHour, d.maxRearmPerHour)),
  };
}

/**
 * Pure re-arm gate from busyRearmAllowedV2: the cooldown looks only at the last recorded time
 * (the array is never sorted), and the hourly cap counts entries strictly inside the trailing hour.
 *
 * @param {number[]} times recorded re-arm timestamps, oldest-first by convention but not reordered
 * @param {{ rearmCooldownMs?: number, maxRearmPerHour?: number }} wd
 * @param {number} at
 * @returns {boolean}
 */
export function canRearmBusyWatchdog(times, wd, at) {
  if (wd.rearmCooldownMs > 0 && times.length > 0 && at - times[times.length - 1] < wd.rearmCooldownMs) return false;
  if (wd.maxRearmPerHour > 0 && times.filter((t) => at - t < 3600000).length >= wd.maxRearmPerHour) return false;
  return true;
}
