// Frozen pre-stage reference for scripts/test-watchdog-support.mjs. Test-only; not production code.
//
// Provenance: hand-transcribed MINIMAL expressions from the pre-stage bridge snapshot
//   .agent-teams/watchdog-support-20261018/bridge.start.js (captured 2026-10-18, before the
//   busy-watchdog support extraction):
//   - busyWatchdogConfig, snapshot lines 2623-2644: the local `num()` coercion helper
//     (null/undefined/'' -> fallback, else finite Number or fallback), hardCap read before release,
//     enabled === false as the only disable, warn/rearm zero clamps, release/hardCap <= 0 fallback
//     and checkInterval floor 1000;
//   - busyRearmAllowedV2, snapshot lines 2777-2783: cooldown on the LAST entry (no sorting) plus
//     the strict one-hour window (< 3600000) hourly cap.
// Historical defaults (snapshot lines 2052-2059) are used by tests as explicit INPUT DATA, never
// as implicit defaults here.
// Independent of src/core/watchdog-policy.mjs and of .agent-teams at runtime: expected output is
// never taken from the current production implementation. Keep expressions aligned with the
// snapshot; do not "improve" the policy while transcribing.

export const LEGACY_PROVENANCE = Object.freeze({
  kind: 'test-only frozen historical reference',
  snapshot: '.agent-teams/watchdog-support-20261018/bridge.start.js',
  captured: '2026-10-18',
  configLines: '2623-2644',
  rearmLines: '2777-2783',
  defaultsLines: '2052-2059',
  note: 'Independent hand transcription; not imported from the current implementation.',
});

export const legacyNormalizeBusyWatchdogConfig = Object.freeze(function legacyNormalizeBusyWatchdogConfig(raw, defaults) {
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
});

export const legacyCanRearmBusyWatchdog = Object.freeze(function legacyCanRearmBusyWatchdog(times, wd, at) {
  if (wd.rearmCooldownMs > 0 && times.length > 0 && at - times[times.length - 1] < wd.rearmCooldownMs) return false;
  if (wd.maxRearmPerHour > 0 && times.filter((t) => at - t < 3600000).length >= wd.maxRearmPerHour) return false;
  return true;
});
