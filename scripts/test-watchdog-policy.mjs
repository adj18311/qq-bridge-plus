#!/usr/bin/env node
/**
 * RED-first contract tests for the pure watchdog policy seam.
 * Run in-process: node scripts/test-watchdog-policy.mjs
 *
 * Expected values come ONLY from scripts/fixtures/legacy-watchdog-policy.mjs, a frozen
 * hand-transcription of the pre-stage bridge snapshot. This file never derives expectations from
 * src/core/watchdog-policy.mjs, never spawns children and does not use node --test.
 */
import * as legacy from './fixtures/legacy-watchdog-policy.mjs';

const TARGET_LABEL = '../src/core/watchdog-policy.mjs';
const TARGET_URL = new URL(TARGET_LABEL, import.meta.url);

const WARN = 300_000;
const RELEASE = 900_000;
const HARD_CAP = 1_800_000;

const results = { total: 0, passed: 0, failed: 0, suppressed: 0 };
const failureMessages = [];
const reasonCounts = new Map();
const PRINT_LIMIT = 10;

function check(name, body) {
  results.total += 1;
  try {
    body();
    results.passed += 1;
  } catch (error) {
    results.failed += 1;
    const message = String(error?.message ?? error);
    const match = /^(MISSING_FEATURE|MODULE_LOAD_ERROR|CONTRACT)/.exec(message);
    const reason = match ? match[1] : 'ASSERTION';
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    if (failureMessages.length < PRINT_LIMIT) failureMessages.push(`${name}: ${message}`);
    else results.suppressed += 1;
  }
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function format(value) {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (Object.is(value, -0)) return '-0';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function assertSame(actual, expected, label) {
  if (!Object.is(actual, expected)) fail(`${label}: expected ${format(expected)}, got ${format(actual)}`);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function thresholds(overrides = {}) {
  return deepFreeze({ warnMs: WARN, releaseMs: RELEASE, hardCapMs: HARD_CAP, ...overrides });
}

const GLOBAL_BASELINE = new Set(Object.getOwnPropertyNames(globalThis));
const PROCESS_EVENTS = ['beforeExit', 'exit', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection', 'warning'];
const listenerBaseline = new Map(PROCESS_EVENTS.map((event) => [event, process.listenerCount(event)]));

let target = null;
let loadFailure = null;
try {
  target = await import(TARGET_URL.href);
} catch (error) {
  loadFailure = error;
}

function requireExport(name) {
  if (loadFailure) {
    const code = String(loadFailure?.code ?? '');
    const message = String(loadFailure?.message ?? loadFailure);
    const missing = code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module|does not provide an export/.test(message);
    const reason = missing ? 'MISSING_FEATURE' : 'MODULE_LOAD_ERROR';
    fail(`${reason}: ${TARGET_LABEL} not importable (${code || message}); expected before implementation`);
  }
  const candidate = target?.[name];
  if (typeof candidate !== 'function') fail(`CONTRACT: export ${name} must be a function`);
  return candidate;
}

function timingOf(input) {
  return requireExport('watchdogTiming')(input);
}

function classifyOf(input) {
  return requireExport('classifyWatchdog')(input);
}

function assertTimingEqual(actual, expected, label) {
  assert(actual && typeof actual === 'object', `${label}: result must be an object`);
  assertSame(Object.keys(actual).sort().join(','), 'busyMs,idleMs', `${label} result keys`);
  assertSame(actual.busyMs, expected.busyMs, `${label} busyMs`);
  assertSame(actual.idleMs, expected.idleMs, `${label} idleMs`);
}

function assertPolicyEqual(actual, expected, label) {
  assert(actual && typeof actual === 'object', `${label}: result must be an object`);
  assertSame(Object.keys(actual).sort().join(','), 'hardCapSilenceMs,releaseByBudget,releaseByHardCap,tier,warnTier', `${label} result keys`);
  for (const key of ['tier', 'warnTier', 'releaseByBudget', 'releaseByHardCap', 'hardCapSilenceMs']) {
    assertSame(actual[key], expected[key], `${label} ${key}`);
  }
}

function expectTiming(label, at, busySince, lastFrameAt) {
  check(label, () => {
    const input = deepFreeze({ at, busySince, lastFrameAt });
    assertTimingEqual(timingOf(input), legacy.legacyWatchdogTiming(input), label);
  });
}

function expectClassify(label, busyMs, idleMs, wd, expectedTier) {
  check(label, () => {
    const input = deepFreeze({ busyMs, idleMs, thresholds: wd });
    const actual = classifyOf(input);
    assertPolicyEqual(actual, legacy.legacyClassifyWatchdog(input), label);
    if (expectedTier !== undefined) assertSame(actual.tier, expectedTier, `${label} tier`);
  });
}

// ── Reference self-checks: fixture vs literal snapshot expressions (run even during RED) ──────────
check('[ref] legacy timing basic + future clamp', () => {
  const out = legacy.legacyWatchdogTiming(deepFreeze({ at: 1_000_000, busySince: 400_000, lastFrameAt: 250_000 }));
  assertSame(out.busyMs, 600_000, 'busyMs');
  assertSame(out.idleMs, 750_000, 'idleMs');
  const future = legacy.legacyWatchdogTiming(deepFreeze({ at: 1_000, busySince: 1_500, lastFrameAt: 250 }));
  assertSame(future.busyMs, 0, 'future busyMs clamps to 0');
  assertSame(future.idleMs, 750, 'future idleMs');
});

check('[ref] legacy timing negative timestamps', () => {
  const out = legacy.legacyWatchdogTiming(deepFreeze({ at: 0, busySince: -250, lastFrameAt: -1_000 }));
  assertSame(out.busyMs, 250, 'negative busySince');
  assertSame(out.idleMs, 1_000, 'negative lastFrameAt');
});

check('[ref] legacy timing NaN/Infinity arithmetic', () => {
  const nanAt = legacy.legacyWatchdogTiming(deepFreeze({ at: NaN, busySince: 0, lastFrameAt: 0 }));
  assertSame(nanAt.busyMs, NaN, 'NaN busyMs');
  assertSame(nanAt.idleMs, NaN, 'NaN idleMs');
  const inf = legacy.legacyWatchdogTiming(deepFreeze({ at: 1_000, busySince: 1_000, lastFrameAt: Infinity }));
  assertSame(inf.busyMs, 0, 'busyMs');
  assertSame(inf.idleMs, 0, '-Infinity clamps to 0');
  const negInfAt = legacy.legacyWatchdogTiming(deepFreeze({ at: -Infinity, busySince: 0, lastFrameAt: 0 }));
  assertSame(negInfAt.busyMs, 0, '-Infinity at busyMs');
  assertSame(negInfAt.idleMs, 0, '-Infinity at idleMs');
});

check('[ref] legacy warn boundary', () => {
  const below = legacy.legacyClassifyWatchdog(deepFreeze({ busyMs: WARN - 1, idleMs: WARN - 1, thresholds: thresholds() }));
  assertSame(below.tier, null, 'below warn tier');
  assertSame(below.warnTier, false, 'below warnTier');
  const at = legacy.legacyClassifyWatchdog(deepFreeze({ busyMs: WARN, idleMs: WARN, thresholds: thresholds() }));
  assertSame(at.tier, 'warn', 'exact warn tier');
  assertSame(at.warnTier, true, 'exact warnTier');
  const idleBelow = legacy.legacyClassifyWatchdog(deepFreeze({ busyMs: WARN, idleMs: WARN - 1, thresholds: thresholds() }));
  assertSame(idleBelow.tier, null, 'idle below warn tier');
});

check('[ref] legacy release boundary', () => {
  const at = legacy.legacyClassifyWatchdog(deepFreeze({ busyMs: RELEASE, idleMs: RELEASE, thresholds: thresholds() }));
  assertSame(at.tier, 'release', 'exact release tier');
  assertSame(at.releaseByBudget, true, 'releaseByBudget');
  const idleBelow = legacy.legacyClassifyWatchdog(deepFreeze({ busyMs: RELEASE, idleMs: RELEASE - 1, thresholds: thresholds() }));
  assertSame(idleBelow.tier, 'warn', 'release idle edge falls back to warn');
});

check('[ref] legacy hardcap boundary and silence', () => {
  const at = legacy.legacyClassifyWatchdog(deepFreeze({ busyMs: HARD_CAP, idleMs: WARN, thresholds: thresholds() }));
  assertSame(at.tier, 'hardcap', 'exact hardcap tier');
  assertSame(at.hardCapSilenceMs, WARN, 'hardcap silence = min(warn, release)');
  assertSame(at.releaseByBudget, false, 'hardcap is not budget release');
  const below = legacy.legacyClassifyWatchdog(deepFreeze({ busyMs: HARD_CAP, idleMs: WARN - 1, thresholds: thresholds() }));
  assertSame(below.tier, null, 'hardcap silence edge');
});

check('[ref] legacy release-over-hardcap priority with both flags', () => {
  const out = legacy.legacyClassifyWatchdog(deepFreeze({ busyMs: HARD_CAP, idleMs: RELEASE, thresholds: thresholds() }));
  assertSame(out.releaseByBudget, true, 'releaseByBudget');
  assertSame(out.releaseByHardCap, true, 'releaseByHardCap');
  assertSame(out.tier, 'release', 'priority release over hardcap');
});

check('[ref] legacy warnMs=0 silence and warnTier', () => {
  const wd = thresholds({ warnMs: 0 });
  const out = legacy.legacyClassifyWatchdog(deepFreeze({ busyMs: HARD_CAP, idleMs: RELEASE - 1, thresholds: wd }));
  assertSame(out.hardCapSilenceMs, RELEASE, 'warnMs=0 silence is releaseMs');
  assertSame(out.warnTier, false, 'warnMs=0 never warns');
  assertSame(out.tier, null, 'warnMs=0 under both release and hardcap silence');
});

check('[ref] legacy frequent-frame counterexample', () => {
  const out = legacy.legacyClassifyWatchdog(deepFreeze({ busyMs: HARD_CAP * 2, idleMs: 60_000, thresholds: thresholds() }));
  assertSame(out.tier, null, 'frequent frames suppress hardcap');
  const justBelowWarn = legacy.legacyClassifyWatchdog(deepFreeze({ busyMs: HARD_CAP * 2, idleMs: WARN - 1, thresholds: thresholds() }));
  assertSame(justBelowWarn.tier, null, 'frames below warn window suppress all tiers');
});

check('[ref] legacy NaN/Infinity classification arithmetic', () => {
  const nan = legacy.legacyClassifyWatchdog(deepFreeze({ busyMs: NaN, idleMs: HARD_CAP, thresholds: thresholds() }));
  assertSame(nan.tier, null, 'NaN busyMs never releases');
  assertSame(nan.warnTier, false, 'NaN warnTier');
  const inf = legacy.legacyClassifyWatchdog(deepFreeze({ busyMs: Infinity, idleMs: Infinity, thresholds: thresholds() }));
  assertSame(inf.tier, 'release', 'Infinity both releases');
});

check('[ref] fixture is frozen test-only provenance reference', () => {
  assert(Object.isFrozen(legacy.LEGACY_PROVENANCE), 'provenance frozen');
  assert(Object.isFrozen(legacy.legacyWatchdogTiming), 'timing reference frozen');
  assert(Object.isFrozen(legacy.legacyClassifyWatchdog), 'classify reference frozen');
  assertSame(legacy.LEGACY_PROVENANCE.snapshot, '.agent-teams/watchdog-policy-20261018/bridge.start.js', 'snapshot provenance');
  assertSame(legacy.LEGACY_PROVENANCE.timingLines, '2819-2821', 'timing provenance lines');
  assertSame(legacy.LEGACY_PROVENANCE.classificationLines, '2835-2846', 'classification provenance lines');
});

// ── Explicit production contract edges ──────────────────────────────────────────────────────────
check('[contract] exact exports, no default/factory', () => {
  requireExport('watchdogTiming');
  requireExport('classifyWatchdog');
  // 2026-10-18 support extraction: the approved contract adds two pure exports; the exact-set pin
  // remains strict (no default/factory, no accidental extra export).
  assertSame(Object.keys(target).sort().join(','), 'canRearmBusyWatchdog,classifyWatchdog,normalizeBusyWatchdogConfig,watchdogTiming', 'module export keys');
  assertSame('default' in target, false, 'no default export');
});

check('[contract] import has no global/listener/factory side effects', () => {
  requireExport('watchdogTiming');
  requireExport('classifyWatchdog');
  const added = Object.getOwnPropertyNames(globalThis).filter((name) => !GLOBAL_BASELINE.has(name));
  assertSame(added.join(','), '', 'new globals');
  for (const [event, count] of listenerBaseline) {
    assertSame(process.listenerCount(event), count, `process listener count for ${event}`);
  }
});

expectTiming('[contract] timing baseline', 1_000_000, 400_000, 250_000);
expectTiming('[contract] timing future busySince clamps', 1_000, 1_500, 250);
expectTiming('[contract] timing negative timestamps', 0, -250, -1_000);
expectTiming('[contract] timing NaN at', NaN, 0, 0);
expectTiming('[contract] timing Infinity lastFrameAt clamps', 1_000, 1_000, Infinity);
expectTiming('[contract] timing -Infinity at clamps', -Infinity, 0, 0);
expectTiming('[contract] timing Infinity at', Infinity, 0, 0);
expectTiming('[contract] timing NaN lastFrameAt', 1_000, 1_000, NaN);

expectClassify('[contract] warn below both edges', WARN - 1, WARN - 1, thresholds(), null);
expectClassify('[contract] warn exact both edges', WARN, WARN, thresholds(), 'warn');
expectClassify('[contract] warn idle below edge', WARN, WARN - 1, thresholds(), null);
expectClassify('[contract] warn busy below edge', WARN - 1, HARD_CAP, thresholds(), null);
expectClassify('[contract] release exact both edges', RELEASE, RELEASE, thresholds(), 'release');
expectClassify('[contract] release idle edge falls back to warn', RELEASE, RELEASE - 1, thresholds(), 'warn');
expectClassify('[contract] release busy edge falls back to warn', RELEASE - 1, HARD_CAP, thresholds(), 'warn');
expectClassify('[contract] hardcap exact silence edge', HARD_CAP, WARN, thresholds(), 'hardcap');
expectClassify('[contract] hardcap silence below edge', HARD_CAP, WARN - 1, thresholds(), null);
// idleMs=WARN (below releaseMs) isolates the hardcap predicate from release-by-budget.
expectClassify('[contract] hardcap busy below edge', HARD_CAP - 1, WARN, thresholds(), 'warn');

check('[contract] simultaneous release+hardcap resolves to release', () => {
  const actual = classifyOf(deepFreeze({ busyMs: HARD_CAP, idleMs: RELEASE, thresholds: thresholds() }));
  assertSame(actual.releaseByBudget, true, 'releaseByBudget');
  assertSame(actual.releaseByHardCap, true, 'releaseByHardCap');
  assertSame(actual.hardCapSilenceMs, WARN, 'hardcap silence floor');
  assertSame(actual.tier, 'release', 'tier');
});

check('[contract] frequent frames suppress hardcap', () => {
  const actual = classifyOf(deepFreeze({ busyMs: HARD_CAP * 2, idleMs: 60_000, thresholds: thresholds() }));
  assertSame(actual.tier, null, '60s-frame busy session never released');
  assertSame(actual.releaseByHardCap, false, 'releaseByHardCap');
});

expectClassify('[contract] warnMs=0 silence is releaseMs', HARD_CAP, RELEASE - 1, thresholds({ warnMs: 0 }), null);
expectClassify('[contract] warnMs=0 release edge', HARD_CAP, RELEASE, thresholds({ warnMs: 0 }), 'release');
expectClassify('[contract] warnMs<0 silence is releaseMs', HARD_CAP, RELEASE - 1, thresholds({ warnMs: -1 }), null);
expectClassify('[contract] warn>release uses min for silence', HARD_CAP, RELEASE - 1, thresholds({ warnMs: 2_000_000 }), null);
expectClassify('[contract] warn>release silence boundary', HARD_CAP, RELEASE, thresholds({ warnMs: 2_000_000 }), 'release');
expectClassify('[contract] NaN busyMs never releases', NaN, Infinity, thresholds(), null);
expectClassify('[contract] NaN idleMs never releases', HARD_CAP, NaN, thresholds(), null);
expectClassify('[contract] NaN releaseMs never releases', HARD_CAP * 2, HARD_CAP * 2, thresholds({ releaseMs: NaN }), 'warn');
// idleMs=WARN (below releaseMs) isolates hardcap reachability from release-by-budget.
expectClassify('[contract] Infinity hardCapMs never hardcaps', HARD_CAP, WARN, thresholds({ hardCapMs: Infinity }), 'warn');
expectClassify('[contract] direct negative busyMs is not clamped', -1, -1, thresholds(), null);
expectClassify('[contract] direct negative idleMs is not clamped', 1_000_000, -1, thresholds(), null);

check('[contract] extra threshold fields are ignored', () => {
  const wd = thresholds({ checkIntervalMs: 10_000, enabled: true, warnTier: 'ignored' });
  const input = deepFreeze({ busyMs: WARN, idleMs: WARN, thresholds: wd });
  assertPolicyEqual(classifyOf(input), legacy.legacyClassifyWatchdog(input), 'extra fields');
});

check('[contract] inputs frozen and unmutated', () => {
  const timeInput = deepFreeze({ at: 1_000_500, busySince: 900_000, lastFrameAt: 1_000_000, extra: 'keep' });
  const timeBefore = JSON.stringify(timeInput);
  const timeOut = timingOf(timeInput);
  assertSame(JSON.stringify(timeInput), timeBefore, 'timing input mutated');
  assert(!Object.is(timeOut, timeInput), 'timing result must be a new object');

  const classInput = deepFreeze({ busyMs: WARN, idleMs: WARN, thresholds: thresholds({ note: 'keep' }) });
  const classBefore = JSON.stringify(classInput);
  const classOut = classifyOf(classInput);
  assertSame(JSON.stringify(classInput), classBefore, 'classify input mutated');
  assert(!Object.is(classOut, classInput), 'classify result must be a new object');
});

// ── Deterministic differential grids: production vs frozen pre-stage reference ──────────────────
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function pick(rng, pool) {
  return pool[Math.floor(rng() * pool.length)];
}

const TIMING_POOL = [
  -Infinity, -1_800_000, -1, 0, 1, 59_999, 60_000, 250_000, 299_999, 300_000, 300_001,
  899_999, 900_000, 1_000_000, 1_799_999, 1_800_000, 1_800_001, 12_345.5, 1e9, Infinity, NaN,
];

const BUSY_IDLE_POOL = [
  -Infinity, -1, 0, 1, 60_000, 299_999, 300_000, 300_001, 899_999, 900_000, 1_799_999,
  1_800_000, 1_800_001, 1e12, Infinity, NaN,
];

const WARN_POOL = [0, 1, -5, 300_000, 600_000, NaN, Infinity];
const RELEASE_POOL = [0, -1, 300_000, 900_000, 1_800_000, NaN, Infinity];
const HARD_CAP_POOL = [0, -1, 900_000, 1_800_000, NaN, Infinity];

const timingRng = lcg(0x5eed0001);
for (let index = 0; index < 256; index += 1) {
  check(`[diff] timing grid #${index}`, () => {
    const at = pick(timingRng, TIMING_POOL);
    const busySince = pick(timingRng, TIMING_POOL);
    const lastFrameAt = pick(timingRng, TIMING_POOL);
    const input = deepFreeze({ at, busySince, lastFrameAt });
    const actual = timingOf(input);
    assertTimingEqual(actual, legacy.legacyWatchdogTiming(input), 'reference');
    assertSame(actual.busyMs, Math.max(0, at - busySince), 'inline busyMs');
    assertSame(actual.idleMs, Math.max(0, at - lastFrameAt), 'inline idleMs');
  });
}

const classifyRng = lcg(0x5eed0002);
for (let index = 0; index < 512; index += 1) {
  check(`[diff] classify grid #${index}`, () => {
    const busyMs = pick(classifyRng, BUSY_IDLE_POOL);
    const idleMs = pick(classifyRng, BUSY_IDLE_POOL);
    const wd = deepFreeze({
      warnMs: pick(classifyRng, WARN_POOL),
      releaseMs: pick(classifyRng, RELEASE_POOL),
      hardCapMs: pick(classifyRng, HARD_CAP_POOL),
    });
    const input = deepFreeze({ busyMs, idleMs, thresholds: wd });
    assertPolicyEqual(classifyOf(input), legacy.legacyClassifyWatchdog(input), 'reference');
  });
}

// ── Summary ────────────────────────────────────────────────────────────────────────────────────
const reasonSummary = [...reasonCounts.entries()].map(([reason, count]) => `${reason}=${count}`).join(' ');
console.log(`watchdog-policy contract tests (target: ${TARGET_LABEL})`);
console.log(`${results.passed} passed, ${results.failed} failed, ${results.total} total`);
if (results.failed > 0) {
  console.log(`failure reasons: ${reasonSummary}`);
  for (const message of failureMessages) console.log(`  - ${message}`);
  if (results.suppressed > 0) console.log(`  ... ${results.suppressed} more failures suppressed`);
  console.log('RED: verdict requires the pure policy module; see docs/superpowers/plans/2026-10-18-watchdog-policy.md');
  process.exitCode = 1;
} else {
  console.log('GREEN: pure watchdog policy contract satisfied');
}
