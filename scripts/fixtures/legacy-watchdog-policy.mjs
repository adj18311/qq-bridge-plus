// Frozen pre-stage reference for scripts/test-watchdog-policy.mjs. Test-only; not production code.
//
// Provenance: hand-transcribed MINIMAL expressions from the pre-stage bridge snapshot
//   .agent-teams/watchdog-policy-20261018/bridge.start.js (captured 2026-10-18, before the
//   watchdog-policy extraction):
//   - scanBusyWatchdogKeyV2, snapshot lines 2819-2821: busyMs/idleMs Math.max(0, at - x) clamping;
//   - snapshot lines 2835-2846: warnTier, releaseByBudget, hardCapSilenceMs, releaseByHardCap and
//     the release > hardcap > warn priority.
// Historical defaults warnMs=300000 / releaseMs=900000 / hardCapMs=1800000 (snapshot lines
// 2053-2055) are used by tests as explicit INPUT DATA, never as implicit defaults here.
// Independent of src/core/watchdog-policy.mjs and of .agent-teams at runtime: expected output is
// never taken from the current production implementation. Keep expressions aligned with the
// snapshot; do not "improve" policy while transcribing.

export const LEGACY_PROVENANCE = Object.freeze({
  kind: 'test-only frozen historical reference',
  snapshot: '.agent-teams/watchdog-policy-20261018/bridge.start.js',
  captured: '2026-10-18',
  timingLines: '2819-2821',
  classificationLines: '2835-2846',
  note: 'Independent hand transcription; not imported from the current implementation.',
});

export const legacyWatchdogTiming = Object.freeze(function legacyWatchdogTiming({ at, busySince, lastFrameAt }) {
  return {
    busyMs: Math.max(0, at - busySince),
    idleMs: Math.max(0, at - lastFrameAt),
  };
});

export const legacyClassifyWatchdog = Object.freeze(function legacyClassifyWatchdog({ busyMs, idleMs, thresholds }) {
  const wd = thresholds;
  const warnTier = wd.warnMs > 0 && busyMs >= wd.warnMs && idleMs >= wd.warnMs;
  const releaseByBudget = busyMs >= wd.releaseMs && idleMs >= wd.releaseMs;
  const hardCapSilenceMs = wd.warnMs > 0 ? Math.min(wd.warnMs, wd.releaseMs) : wd.releaseMs;
  const releaseByHardCap = busyMs >= wd.hardCapMs && idleMs >= hardCapSilenceMs;
  const tier = releaseByBudget ? 'release' : (releaseByHardCap ? 'hardcap' : (warnTier ? 'warn' : null));
  return { tier, warnTier, releaseByBudget, releaseByHardCap, hardCapSilenceMs };
});
