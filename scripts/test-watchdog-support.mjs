#!/usr/bin/env node
/**
 * RED-first contract tests for the pure busy-watchdog support helpers
 * (normalizeBusyWatchdogConfig, canRearmBusyWatchdog).
 *
 * Run in-process: node scripts/test-watchdog-support.mjs
 *
 * Expected values come ONLY from the task contract literals plus
 * scripts/fixtures/legacy-watchdog-support.mjs, a frozen hand-transcription of the pre-stage bridge
 * snapshot. This file never derives expectations from src/core/watchdog-policy.mjs, never spawns
 * children and does not use node --test.
 */
import assert from 'node:assert/strict';
import * as legacy from './fixtures/legacy-watchdog-support.mjs';

const TARGET_LABEL = '../src/core/watchdog-policy.mjs';
const TARGET_URL = new URL(TARGET_LABEL, import.meta.url);

const KEY_ORDER = 'enabled,warnMs,releaseMs,hardCapMs,checkIntervalMs,rearmCooldownMs,maxRearmPerHour';

const DEFAULT_CONFIG = deepFreeze({
  enabled: true,
  warnMs: 300_000,
  releaseMs: 900_000,
  hardCapMs: 1_800_000,
  checkIntervalMs: 10_000,
  rearmCooldownMs: 60_000,
  maxRearmPerHour: 3,
});

const ALTERNATE_CONFIG = deepFreeze({
  enabled: true,
  warnMs: 250_000.5,
  releaseMs: 750_000,
  hardCapMs: 1_500_000,
  checkIntervalMs: 2_500,
  rearmCooldownMs: 30_000,
  maxRearmPerHour: 1.5,
});

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
    const match = /^(MISSING_FEATURE|MODULE_LOAD_ERROR|CONTRACT|ASSERTION)/.exec(message);
    const reason = match ? match[1] : 'ASSERTION';
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    if (failureMessages.length < PRINT_LIMIT) failureMessages.push(`${name}: ${bounded(message)}`);
    else results.suppressed += 1;
  }
}

function fail(message) {
  throw new Error(message);
}

function bounded(text) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > 240 ? `${oneLine.slice(0, 240)}…` : oneLine;
}

function same(actual, expected, label) {
  try {
    assert.strictEqual(actual, expected);
  } catch (error) {
    fail(`CONTRACT: ${label}: expected ${format(expected)}, got ${format(actual)} (${bounded(error?.message ?? error)})`);
  }
}

function deepSame(actual, expected, label) {
  try {
    assert.deepEqual(actual, expected);
  } catch (error) {
    fail(`CONTRACT: ${label}: ${bounded(error?.message ?? error)}`);
  }
}

function different(actual, other, label) {
  if (Object.is(actual, other)) fail(`CONTRACT: ${label}: result must be a fresh object`);
}

function format(value) {
  if (typeof value === 'undefined') return 'undefined';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (Object.is(value, -0)) return '-0';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function expectedConfig(overrides = {}) {
  return {
    enabled: true,
    warnMs: 300_000,
    releaseMs: 900_000,
    hardCapMs: 1_800_000,
    checkIntervalMs: 10_000,
    rearmCooldownMs: 60_000,
    maxRearmPerHour: 3,
    ...overrides,
  };
}

// ── Import side-effect baselines (captured before the target module loads) ─────────────────────
const GLOBAL_BASELINE = new Set(Object.getOwnPropertyNames(globalThis));
const PROCESS_EVENTS = [
  'beforeExit', 'exit', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection', 'warning',
];
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
  if (candidate === undefined) {
    fail(`MISSING_FEATURE: ${TARGET_LABEL} does not export ${name} (expected RED before implementation)`);
  }
  if (typeof candidate !== 'function') fail(`CONTRACT: export ${name} must be a function`);
  return candidate;
}

function normalizeOf(raw, defaults = DEFAULT_CONFIG) {
  return requireExport('normalizeBusyWatchdogConfig')(raw, defaults);
}

function rearmOf(times, wd, at) {
  return requireExport('canRearmBusyWatchdog')(times, wd, at);
}

function expectNormalize(label, raw, overrides = {}) {
  check(label, () => {
    const actual = normalizeOf(raw);
    deepSame(actual, legacy.legacyNormalizeBusyWatchdogConfig(raw, DEFAULT_CONFIG), `${label} legacy reference`);
    deepSame(actual, expectedConfig(overrides), `${label} contract literal`);
    same(Object.keys(actual).join(','), KEY_ORDER, `${label} key order`);
  });
}

function expectRearm(label, times, wd, at, expected) {
  check(label, () => {
    const frozenTimes = deepFreeze(times);
    const frozenWd = deepFreeze(wd);
    const actual = rearmOf(frozenTimes, frozenWd, at);
    same(actual, expected, `${label} contract literal`);
    same(actual, legacy.legacyCanRearmBusyWatchdog(frozenTimes, frozenWd, at), `${label} legacy reference`);
  });
}

// ── Reference self-checks: frozen fixture vs literal snapshot expressions (run even during RED) ──
check('[ref] legacy normalize empty raw uses defaults', () => {
  const actual = legacy.legacyNormalizeBusyWatchdogConfig(deepFreeze({}), DEFAULT_CONFIG);
  assert.deepEqual(actual, expectedConfig());
});

check('[ref] legacy normalize coercion and clamps', () => {
  const actual = legacy.legacyNormalizeBusyWatchdogConfig(deepFreeze({
    enabled: 0,
    warnMs: -5,
    releaseMs: '1500',
    hardCapMs: -0,
    checkIntervalMs: 500,
    rearmCooldownMs: '',
    maxRearmPerHour: [2.5],
  }), DEFAULT_CONFIG);
  assert.deepEqual(actual, expectedConfig({
    enabled: true,
    warnMs: 0,
    releaseMs: 1_500,
    hardCapMs: 1_800_000,
    checkIntervalMs: 1_000,
    rearmCooldownMs: 60_000,
    maxRearmPerHour: 2.5,
  }));
});

check('[ref] legacy rearm cooldown uses last unsorted entry', () => {
  const wd = deepFreeze({ rearmCooldownMs: 2_000, maxRearmPerHour: 0 });
  assert.equal(legacy.legacyCanRearmBusyWatchdog(deepFreeze([1_000, 5_000, 3_000]), wd, 6_000), true);
  assert.equal(legacy.legacyCanRearmBusyWatchdog(deepFreeze([10_000]), wd, 12_000), true);
  assert.equal(legacy.legacyCanRearmBusyWatchdog(deepFreeze([10_000]), wd, 11_999), false);
});

check('[ref] legacy rearm hourly strict boundary', () => {
  const wd = deepFreeze({ rearmCooldownMs: 0, maxRearmPerHour: 1 });
  const at = 10_000_000;
  assert.equal(legacy.legacyCanRearmBusyWatchdog(deepFreeze([at - 3_600_000]), wd, at), true);
  assert.equal(legacy.legacyCanRearmBusyWatchdog(deepFreeze([at - 3_599_999]), wd, at), false);
  const fractional = deepFreeze({ rearmCooldownMs: 0, maxRearmPerHour: 1.5 });
  assert.equal(legacy.legacyCanRearmBusyWatchdog(deepFreeze([at - 1]), fractional, at), true);
});

check('[ref] provenance frozen and pinned', () => {
  assert(Object.isFrozen(legacy.LEGACY_PROVENANCE), 'provenance frozen');
  assert(Object.isFrozen(legacy.legacyNormalizeBusyWatchdogConfig), 'normalize reference frozen');
  assert(Object.isFrozen(legacy.legacyCanRearmBusyWatchdog), 'rearm reference frozen');
  assert.equal(legacy.LEGACY_PROVENANCE.snapshot, '.agent-teams/watchdog-support-20261018/bridge.start.js', 'snapshot provenance');
  assert.equal(legacy.LEGACY_PROVENANCE.configLines, '2623-2644', 'config provenance lines');
  assert.equal(legacy.LEGACY_PROVENANCE.rearmLines, '2777-2783', 'rearm provenance lines');
});

// ── Production contract edges ──────────────────────────────────────────────────────────────────
check('[contract] both support helpers are exported functions', () => {
  same(typeof requireExport('normalizeBusyWatchdogConfig'), 'function', 'normalizeBusyWatchdogConfig type');
  same(typeof requireExport('canRearmBusyWatchdog'), 'function', 'canRearmBusyWatchdog type');
});

check('[contract] import has no global/listener/factory side effects', () => {
  const added = Object.getOwnPropertyNames(globalThis).filter((name) => !GLOBAL_BASELINE.has(name));
  same(added.join(','), '', 'new globals');
  for (const [event, count] of listenerBaseline) {
    same(process.listenerCount(event), count, `process listener count for ${event}`);
  }
  requireExport('normalizeBusyWatchdogConfig');
  requireExport('canRearmBusyWatchdog');
});

expectNormalize('[contract] normalize empty raw -> defaults', deepFreeze({}));
expectNormalize('[contract] normalize null values -> defaults', deepFreeze({
  disabled: undefined, warnMs: null, releaseMs: null, hardCapMs: null,
  checkIntervalMs: null, rearmCooldownMs: null, maxRearmPerHour: null,
}));
expectNormalize('[contract] normalize undefined values -> defaults', deepFreeze({
  warnMs: undefined, releaseMs: undefined, hardCapMs: undefined,
  checkIntervalMs: undefined, rearmCooldownMs: undefined, maxRearmPerHour: undefined,
}));
expectNormalize('[contract] normalize empty-string values -> defaults', deepFreeze({
  warnMs: '', releaseMs: '', hardCapMs: '', checkIntervalMs: '', rearmCooldownMs: '', maxRearmPerHour: '',
}));

expectNormalize('[contract] normalize numeric strings coerce', deepFreeze({
  warnMs: '1234', releaseMs: '1500', hardCapMs: '2400',
  checkIntervalMs: '5000', rearmCooldownMs: '1500.5', maxRearmPerHour: '2.5',
}), {
  warnMs: 1_234, releaseMs: 1_500, hardCapMs: 2_400,
  checkIntervalMs: 5_000, rearmCooldownMs: 1_500.5, maxRearmPerHour: 2.5,
});

expectNormalize('[contract] normalize booleans coerce', deepFreeze({
  warnMs: true, releaseMs: true, hardCapMs: false,
  checkIntervalMs: true, rearmCooldownMs: false, maxRearmPerHour: true,
}), {
  warnMs: 1, releaseMs: 1, hardCapMs: 1_800_000,
  checkIntervalMs: 1_000, rearmCooldownMs: 0, maxRearmPerHour: 1,
});

expectNormalize('[contract] normalize arrays coerce', deepFreeze({
  warnMs: [5], releaseMs: [2_000], hardCapMs: [],
  checkIntervalMs: [5_000], rearmCooldownMs: [1_500], maxRearmPerHour: [2.5],
}), {
  warnMs: 5, releaseMs: 2_000, hardCapMs: 1_800_000,
  checkIntervalMs: 5_000, rearmCooldownMs: 1_500, maxRearmPerHour: 2.5,
});

expectNormalize('[contract] normalize plain objects fall back', deepFreeze({
  warnMs: {}, releaseMs: { value: 900 }, hardCapMs: {},
  checkIntervalMs: {}, rearmCooldownMs: {}, maxRearmPerHour: {},
}));

expectNormalize('[contract] normalize non-finite values fall back', deepFreeze({
  warnMs: 'abc', releaseMs: NaN, hardCapMs: Infinity,
  checkIntervalMs: -Infinity, rearmCooldownMs: 'Infinity', maxRearmPerHour: 'NaN',
}));

check('[contract] only enabled === false disables', () => {
  const enabledCases = [
    {}, { enabled: undefined }, { enabled: null }, { enabled: true }, { enabled: 0 },
    { enabled: 1 }, { enabled: '' }, { enabled: 'false' }, { enabled: NaN },
    { enabled: {} }, { enabled: [] }, { enabled: -1 },
  ];
  for (const rawCase of enabledCases) {
    const raw = deepFreeze(rawCase);
    const actual = normalizeOf(raw);
    same(actual.enabled, true, `enabled for ${format(rawCase.enabled)}`);
    deepSame(actual, legacy.legacyNormalizeBusyWatchdogConfig(raw, DEFAULT_CONFIG), 'legacy reference');
  }
  for (const rawCase of [{ enabled: false }, { enabled: false, warnMs: 1_234 }]) {
    const raw = deepFreeze(rawCase);
    const actual = normalizeOf(raw);
    same(actual.enabled, false, 'explicit enabled false');
    deepSame(actual, legacy.legacyNormalizeBusyWatchdogConfig(raw, DEFAULT_CONFIG), 'legacy reference enabled false');
  }
});

expectNormalize('[contract] warn/rearm negative values clamp to zero', deepFreeze({
  warnMs: -5, rearmCooldownMs: -100, maxRearmPerHour: -3,
}), { warnMs: 0, rearmCooldownMs: 0, maxRearmPerHour: 0 });

expectNormalize('[contract] explicit zero warn/rearm preserved', deepFreeze({
  warnMs: 0, rearmCooldownMs: 0, maxRearmPerHour: 0,
}), { warnMs: 0, rearmCooldownMs: 0, maxRearmPerHour: 0 });

expectNormalize('[contract] release/hardCap zero fall back', deepFreeze({ releaseMs: 0, hardCapMs: 0 }));
expectNormalize('[contract] release/hardCap -0 fall back', deepFreeze({ releaseMs: -0, hardCapMs: -0 }));
expectNormalize('[contract] release/hardCap negative fall back', deepFreeze({ releaseMs: -1, hardCapMs: -1 }));
expectNormalize('[contract] release/hardCap positive fractions preserved', deepFreeze({
  releaseMs: 0.5, hardCapMs: 0.25,
}), { releaseMs: 0.5, hardCapMs: 0.25 });

check('[contract] checkInterval floor is 1000', () => {
  const cases = [
    [0, 1_000], [999.9, 1_000], [1_000, 1_000], [1_000.5, 1_000.5],
    [-500, 1_000], [5_000, 5_000], ['5000', 5_000],
  ];
  for (const [value, expected] of cases) {
    const raw = deepFreeze({ checkIntervalMs: value });
    same(normalizeOf(raw).checkIntervalMs, expected, `checkIntervalMs ${format(value)}`);
    same(normalizeOf(raw).checkIntervalMs, legacy.legacyNormalizeBusyWatchdogConfig(raw, DEFAULT_CONFIG).checkIntervalMs,
      `checkIntervalMs reference ${format(value)}`);
  }
});

expectNormalize('[contract] fractional maxRearmPerHour not rounded', deepFreeze({
  maxRearmPerHour: 2.5, rearmCooldownMs: 1_500.75,
}), { maxRearmPerHour: 2.5, rearmCooldownMs: 1_500.75 });

expectNormalize('[contract] small fractional maxRearmPerHour kept', deepFreeze({ maxRearmPerHour: 0.25 }), {
  maxRearmPerHour: 0.25,
});

check('[contract] normalize result key order is exact', () => {
  const actual = normalizeOf(deepFreeze({ warnMs: 1_234 }));
  same(Object.keys(actual).join(','), KEY_ORDER, 'key order');
  same(Object.keys(actual).length, 7, 'key count');
});

check('[contract] extra raw/defaults fields are ignored', () => {
  const defaults = deepFreeze({ ...DEFAULT_CONFIG, extra: 'defaults-extra' });
  const raw = deepFreeze({ enabled: true, warnMs: 1_234, extra: 'raw-extra' });
  const actual = normalizeOf(raw, defaults);
  same(Object.keys(actual).join(','), KEY_ORDER, 'key order');
  deepSame(actual, expectedConfig({ warnMs: 1_234 }), 'contract literal');
  deepSame(actual, legacy.legacyNormalizeBusyWatchdogConfig(raw, defaults), 'legacy reference');
});

check('[contract] normalize frozen inputs unmutated and result is fresh', () => {
  const raw = deepFreeze({
    enabled: false, warnMs: '1234', releaseMs: 0, hardCapMs: -0,
    checkIntervalMs: 500, rearmCooldownMs: -5, maxRearmPerHour: 2.5, extra: 'keep',
  });
  const defaults = DEFAULT_CONFIG;
  const rawBefore = JSON.stringify(raw);
  const defaultsBefore = JSON.stringify(defaults);
  const first = normalizeOf(raw, defaults);
  const second = normalizeOf(raw, defaults);
  same(JSON.stringify(raw), rawBefore, 'raw input mutated');
  same(JSON.stringify(defaults), defaultsBefore, 'defaults input mutated');
  different(first, defaults, 'result aliases defaults');
  different(first, raw, 'result aliases raw');
  different(first, second, 'two calls return distinct objects');
  same(first.enabled, false, 'enabled false survives');
  same(first.releaseMs, 900_000, 'release fallback survives');
  same(first.hardCapMs, 1_800_000, 'hardCap fallback survives');
});

// ── canRearmBusyWatchdog: cooldown uses only the LAST entry, never sorts ───────────────────────
const COOLDOWN = (rearmCooldownMs, maxRearmPerHour = 0) => ({ rearmCooldownMs, maxRearmPerHour });

expectRearm('[contract] rearm empty history allowed', [], COOLDOWN(2_000), 10_000, true);
expectRearm('[contract] rearm within cooldown blocked', [10_000], COOLDOWN(2_000), 11_000, false);
expectRearm('[contract] rearm exact cooldown boundary allowed', [10_000], COOLDOWN(2_000), 12_000, true);
expectRearm('[contract] rearm just below cooldown boundary blocked', [10_000], COOLDOWN(2_000), 11_999, false);
expectRearm('[contract] rearm beyond cooldown boundary allowed', [10_000], COOLDOWN(2_000), 12_001, true);
expectRearm('[contract] rearm uses last entry even when unsorted newest is earlier', [9_000, 1_000], COOLDOWN(2_000), 10_000, true);
expectRearm('[contract] rearm uses last entry not the maximum', [1_000, 5_000, 3_000], COOLDOWN(2_000), 6_000, true);
expectRearm('[contract] rearm future entry blocks via cooldown', [10_001], COOLDOWN(1_000), 10_000, false);
expectRearm('[contract] rearm zero cooldown disables the gate', [10_000, 10_000], COOLDOWN(0), 10_000, true);
expectRearm('[contract] rearm negative cooldown disables the gate', [10_000, 10_000], COOLDOWN(-5), 10_000, true);
expectRearm('[contract] rearm fractional cooldown exact boundary allowed', [10_000], COOLDOWN(1_000.5), 11_000.5, true);
expectRearm('[contract] rearm fractional cooldown just below blocked', [10_000], COOLDOWN(1_000.5), 11_000.4, false);

// ── canRearmBusyWatchdog: hourly cap uses strict (< 3600000) window ───────────────────────────
expectRearm('[contract] hourly cap blocks at the limit', [990_000, 999_000, 999_900], COOLDOWN(0, 3), 1_000_000, false);
expectRearm('[contract] hourly cap allows below the limit', [990_000, 999_000], COOLDOWN(0, 3), 1_000_000, true);
expectRearm('[contract] hourly cap zero disables the gate', [999_999, 999_998], COOLDOWN(0, 0), 1_000_000, true);
expectRearm('[contract] hourly cap negative disables the gate', [999_999, 999_998], COOLDOWN(0, -2), 1_000_000, true);
expectRearm('[contract] hourly exact 3600000 boundary excluded', [1_000_000 - 3_600_000], COOLDOWN(0, 1), 1_000_000, true);
expectRearm('[contract] hourly just inside 3600000 counted', [1_000_000 - 3_599_999], COOLDOWN(0, 1), 1_000_000, false);
expectRearm('[contract] hourly future timestamp counted', [1_000_001], COOLDOWN(0, 1), 1_000_000, false);
expectRearm('[contract] hourly fractional cap not rounded (2 allowed at 2.5)', [999_000, 999_100], COOLDOWN(0, 2.5), 1_000_000, true);
expectRearm('[contract] hourly fractional cap not rounded (3 blocked at 2.5)', [998_000, 999_000, 999_100], COOLDOWN(0, 2.5), 1_000_000, false);
expectRearm('[contract] hourly cap 1.5 allows one', [999_000], COOLDOWN(0, 1.5), 1_000_000, true);
expectRearm('[contract] hourly duplicate timestamps each count', [999_000, 999_000], COOLDOWN(0, 2), 1_000_000, false);
expectRearm('[contract] NaN at never counts toward the hourly cap', [0], COOLDOWN(0, 1), NaN, true);
expectRearm('[contract] missing wd fields allow rearm', [0, 1, 2], {}, 10_000, true);
expectRearm('[contract] cooldown passes while hourly cap blocks', [996_000, 1_000_000 - 3_600_000], COOLDOWN(4_000, 1), 1_000_000, false);
expectRearm('[contract] cooldown blocks while hourly cap has room', [999_900], COOLDOWN(5_000, 10), 1_000_000, false);
expectRearm('[contract] both gates pass', [0, 100], COOLDOWN(1_000, 10), 500_000, true);

check('[contract] rearm does not mutate or sort the times array', () => {
  const times = deepFreeze([5_000, 1_000, 9_000]);
  const wd = deepFreeze({ rearmCooldownMs: 0, maxRearmPerHour: 0 });
  const before = JSON.stringify(times);
  const wdBefore = JSON.stringify(wd);
  same(rearmOf(times, wd, 10_000), true, 'result');
  same(JSON.stringify(times), before, 'times mutated');
  same(times.join(','), '5000,1000,9000', 'order preserved');
  same(JSON.stringify(wd), wdBefore, 'wd mutated');
});

check('[contract] rearm returns primitive booleans', () => {
  const wd = deepFreeze({ rearmCooldownMs: 1_000, maxRearmPerHour: 1 });
  same(rearmOf(deepFreeze([]), wd, 10_000), true, 'allowed value');
  same(rearmOf(deepFreeze([10_000]), wd, 10_001), false, 'blocked value');
});

// ── Deterministic differential matrix: production vs frozen pre-stage reference ────────────────
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

const CONFIG_VALUE_POOL = [
  null, undefined, '', 0, -0, -1, 1, 999.5, 1_000, 1_000.5, 10_000, 60_000, 300_000, 900_000,
  1_800_000, 3_600_000, -3_600_000, '0', '900', ' 1200 ', '5000', 'abc', 'Infinity', 'NaN',
  NaN, Infinity, -Infinity, true, false, [], [7], [2.5], {}, { value: 1 },
];
const ENABLED_POOL = [false, true, 0, 1, null, '', 'false', undefined, -1];
const TIME_POOL = [
  -Infinity, -3_600_000, -1, -0, 0, 1, 1_000, 59_999, 60_000, 899_999, 900_000,
  3_599_999, 3_600_000, 3_600_001, 7_200_000, 12_345.5, 1e9, NaN, Infinity,
];
const CD_POOL = [0, -1, -60_000, 1, 1_000, 1_500.5, 60_000, 3_600_000, NaN, Infinity];
const MAX_POOL = [0, -1, 0.5, 1, 1.5, 2.5, 3, NaN, Infinity];

const configRng = lcg(0x5eed0003);
for (let index = 0; index < 128; index += 1) {
  check(`[diff] normalize grid #${index}`, () => {
    const raw = {};
    for (const key of ['warnMs', 'releaseMs', 'hardCapMs', 'checkIntervalMs', 'rearmCooldownMs', 'maxRearmPerHour']) {
      if (configRng() < 0.85) raw[key] = pick(configRng, CONFIG_VALUE_POOL);
    }
    if (configRng() < 0.2) raw.enabled = pick(configRng, ENABLED_POOL);
    const defaults = pick(configRng, [DEFAULT_CONFIG, ALTERNATE_CONFIG]);
    const frozenRaw = deepFreeze(raw);
    const actual = normalizeOf(frozenRaw, defaults);
    deepSame(actual, legacy.legacyNormalizeBusyWatchdogConfig(frozenRaw, defaults), 'normalize legacy reference');
    same(Object.keys(actual).join(','), KEY_ORDER, 'key order');
  });
}

const rearmRng = lcg(0x5eed0004);
for (let index = 0; index < 192; index += 1) {
  check(`[diff] rearm grid #${index}`, () => {
    const at = pick(rearmRng, TIME_POOL);
    const length = Math.floor(rearmRng() * 8);
    const times = [];
    for (let entry = 0; entry < length; entry += 1) times.push(pick(rearmRng, TIME_POOL));
    const wd = {
      rearmCooldownMs: pick(rearmRng, CD_POOL),
      maxRearmPerHour: pick(rearmRng, MAX_POOL),
    };
    const pristineTimes = times.slice();
    const pristineWd = { ...wd };
    const frozenTimes = deepFreeze(times);
    const frozenWd = deepFreeze(wd);
    const before = JSON.stringify(frozenTimes);
    const actual = rearmOf(frozenTimes, frozenWd, at);
    same(actual, legacy.legacyCanRearmBusyWatchdog(pristineTimes, pristineWd, at), 'rearm legacy reference');
    same(JSON.stringify(frozenTimes), before, 'times mutated');
  });
}

// ── Summary ────────────────────────────────────────────────────────────────────────────────────
const reasonSummary = [...reasonCounts.entries()].map(([reason, count]) => `${reason}=${count}`).join(' ');
console.log(`busy-watchdog support contract tests (target: ${TARGET_LABEL})`);
console.log(`${results.passed} passed, ${results.failed} failed, ${results.total} total`);
if (results.failed > 0) {
  console.log(`failure reasons: ${reasonSummary}`);
  for (const message of failureMessages) console.log(`  - ${message}`);
  if (results.suppressed > 0) console.log(`  ... ${results.suppressed} more failures suppressed`);
  console.log('RED: verdict requires the pure busy-watchdog support helpers; expected before implementation.');
  process.exitCode = 1;
} else {
  console.log('GREEN: busy-watchdog support contract satisfied');
}
