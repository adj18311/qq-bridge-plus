#!/usr/bin/env node
// RED-first differential tests for the pure wake-policy seam.
// Run in-process: node scripts/test-wake-policy.mjs
//
// Expected values come ONLY from scripts/fixtures/legacy-wake-policy.mjs, a frozen hand
// transcription of HEAD ca43576 src/bridge.js. This file never derives expectations from
// src/core/wake-policy.mjs and never reads .agent-teams state.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as legacy from './fixtures/legacy-wake-policy.mjs';

const TARGET_LABEL = '../src/core/wake-policy.mjs';
const BASE = Date.UTC(2026, 9, 18, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const FUTURE = new Date(BASE + 60_000).toISOString();
const PRIORITY_TABLE = legacy.LEGACY_WAKE_PRIORITY;

let target = null;
let loadFailure = null;
try {
  target = await import(new URL(TARGET_LABEL, import.meta.url).href);
} catch (error) {
  loadFailure = error;
}

function requireExport(name) {
  if (loadFailure) {
    const code = String(loadFailure?.code ?? '');
    const message = String(loadFailure?.message ?? loadFailure);
    throw new Error(`MISSING_FEATURE: ${TARGET_LABEL} not importable (${code || message})`);
  }
  const candidate = target?.[name];
  assert.equal(typeof candidate, 'function', `CONTRACT: export ${name} must be a function`);
  return candidate;
}

function describeError(error) {
  return { name: String(error?.name ?? 'Error'), message: String(error?.message ?? error) };
}

function captureThrow(body) {
  try {
    return { value: body(), error: null };
  } catch (error) {
    return { value: undefined, error: describeError(error) };
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// Fresh, independent plain-object input for each side of a differential assertion. Getters are
// preserved by descriptor, but stateful reproductions must pass an explicit factory instead so the
// oracle and production never share one stateful input.
function freshInput(value) {
  if (Array.isArray(value)) return value.map(freshInput);
  if (!value || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const copy = Object.create(proto);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) descriptor.value = freshInput(descriptor.value);
    Object.defineProperty(copy, key, descriptor);
  }
  return copy;
}

function inputFactory(input) {
  return typeof input === 'function' ? input : () => freshInput(input);
}

function makeCaps(spec = {}, log = []) {
  const trace = { now: [], random: [], order: [] };
  let nowIndex = 0;
  let randomIndex = 0;
  const now = () => {
    if (spec.nowThrows) throw new Error(spec.nowThrows);
    const value = (spec.nowValues ?? [])[nowIndex++];
    trace.now.push(value);
    trace.order.push('now');
    log.push('now()');
    return value;
  };
  const random = () => {
    if (spec.randomThrows) throw new Error(spec.randomThrows);
    const value = (spec.randomValues ?? [])[randomIndex++];
    trace.random.push(value);
    trace.order.push('random');
    log.push('random()');
    return value;
  };
  return { now, random, trace };
}

function traced(value, log) {
  if (!value || typeof value !== 'object') return value;
  return new Proxy(value, {
    get(obj, key) {
      if (typeof key === 'string') log.push(key);
      return obj[key];
    },
  });
}

function runDefault(fn, w, spec, log) {
  const caps = makeCaps(spec, log);
  const outcome = captureThrow(() => fn(traced(w, log), caps));
  return { ...outcome, trace: caps.trace };
}

function compareDefault(label, input, spec = {}) {
  const fn = requireExport('defaultWakeConfig');
  const make = inputFactory(input);
  const expectedLog = [];
  const actualLog = [];
  const expected = runDefault(legacy.legacyDefaultWakeConfig, make(), spec, expectedLog);
  const actual = runDefault(fn, make(), spec, actualLog);
  assert.deepEqual(actual.trace, expected.trace, `${label}: capability trace`);
  assert.deepEqual(actual.error, expected.error, `${label}: thrown error`);
  assert.deepEqual(actual.value, expected.value, `${label}: result`);
  assert.deepEqual(actualLog, expectedLog, `${label}: complete ordered property/capability log`);
}

function runCompute(fn, wc, spec, log) {
  const caps = makeCaps(spec, log);
  const outcome = captureThrow(() => fn(traceCompute(wc, log), caps));
  return { ...outcome, trace: caps.trace };
}

function compareCompute(label, input, spec = {}) {
  const fn = requireExport('computeWakeSafety');
  const make = inputFactory(input);
  const expectedLog = [];
  const actualLog = [];
  const expected = runCompute(legacy.legacyComputeWakeSafety, make(), spec, expectedLog);
  const actual = runCompute(fn, make(), spec, actualLog);
  assert.deepEqual(actual.trace, expected.trace, `${label}: clock trace`);
  assert.deepEqual(actual.error, expected.error, `${label}: thrown error`);
  assert.deepEqual(actual.value, expected.value, `${label}: result`);
  assert.deepEqual(actualLog, expectedLog, `${label}: complete ordered property/capability log`);
}

function runPreSleep(fn, st, w, spec, log) {
  const caps = makeCaps(spec, log);
  const outcome = captureThrow(() => fn(tracePreSleepState(st, log), traced(w, log), caps));
  return { ...outcome, trace: caps.trace };
}

function comparePreSleep(label, st, w, spec = {}) {
  const fn = requireExport('preSleepWaitBlocked');
  const stMake = inputFactory(st);
  const wMake = inputFactory(w);
  const expectedLog = [];
  const actualLog = [];
  const expected = runPreSleep(legacy.legacyPreSleepWaitBlocked, stMake(), wMake(), spec, expectedLog);
  const actual = runPreSleep(fn, stMake(), wMake(), spec, actualLog);
  assert.deepEqual(actual.trace, expected.trace, `${label}: clock trace`);
  assert.deepEqual(actual.error, expected.error, `${label}: thrown error`);
  assert.deepEqual(actual.value, expected.value, `${label}: result`);
  assert.deepEqual(actualLog, expectedLog, `${label}: complete ordered property/capability log`);
}

// Focused nested tracers: only the reads the legacy bodies actually perform. Log entries include
// the field path (and duplicates) so single-read caching mutations are observable.
function traceCompute(wc, log) {
  if (!wc || typeof wc !== 'object') return wc;
  return new Proxy(wc, {
    get(obj, key) {
      if (typeof key !== 'string') return obj[key];
      log.push(`wc.${key}`);
      const value = obj[key];
      if (key === 'triggers' && value && typeof value === 'object') {
        return new Proxy(value, {
          get(triggers, triggerKey) {
            if (typeof triggerKey === 'string') log.push(`triggers.${triggerKey}`);
            return triggers[triggerKey];
          },
        });
      }
      return value;
    },
  });
}

function tracePreSleepState(st, log) {
  if (!st || typeof st !== 'object') return st;
  return new Proxy(st, {
    get(obj, key) {
      if (typeof key !== 'string') return obj[key];
      log.push(`st.${key}`);
      const value = obj[key];
      if (key === 'recentMessages' && Array.isArray(value)) {
        return value.map((message, index) => {
          if (!message || typeof message !== 'object') return message;
          return new Proxy(message, {
            get(entry, entryKey) {
              if (typeof entryKey === 'string') log.push(`recentMessages[${index}].${entryKey}`);
              return entry[entryKey];
            },
          });
        });
      }
      return value;
    },
  });
}

function normalizeOf(value) {
  return requireExport('normalizeSpeakerIds')(value);
}

// ── Frozen oracle self-checks (must already pass while the module is missing) ────────────────────
test('[ref] frozen fixture provenance and literal behaviors', () => {
  assert(Object.isFrozen(legacy.LEGACY_PROVENANCE), 'provenance is frozen');
  assert.equal(legacy.LEGACY_PROVENANCE.commit, 'ca43576', 'provenance commit');
  assert.equal(legacy.LEGACY_PROVENANCE.file, 'src/bridge.js', 'provenance file');
  assert.equal(legacy.LEGACY_PROVENANCE.defaultWakeConfigLines, '9665-9697', 'default config lines');
  assert.equal(legacy.LEGACY_PROVENANCE.preSleepLines, '9747-9761', 'pre-sleep lines');
  assert.equal(legacy.LEGACY_PROVENANCE.priorityLines, '12694-12711', 'priority lines');
  assert.match(legacy.LEGACY_EXPLICIT_END_RE.source, /晚安/, 'explicit-end regex is legacy');
  assert.deepEqual(Object.keys(PRIORITY_TABLE), [
    'private', 'atMention', 'question', 'speaker', 'nameMention',
    'keyword', 'anyMessage', 'replyCheck', 'timeout', 'proactiveCheck',
  ], 'priority table shape');
  assert(Object.isFrozen(PRIORITY_TABLE), 'priority table is frozen');

  const infinite = legacy.legacyDefaultWakeConfig({}, { now: () => BASE, random: () => 0.5 });
  assert.equal(infinite.mode, 'diving', 'empty mode');
  assert.equal(infinite.infinite, true, 'empty infinite');
  assert.equal(infinite.sleepUntil, null, 'infinite sleepUntil');
  assert.equal(infinite.batchWindowMs, 8000, 'default batch window');
  assert.equal(infinite.triggers.probability, 0, 'default probability');

  const finite = legacy.legacyDefaultWakeConfig(
    { recommendedDefaultInfinite: false, recommendedSleepMinMs: 1000, recommendedSleepMaxMs: 1000 },
    { now: () => BASE, random: () => 0.5 },
  );
  assert.equal(finite.sleepUntil, new Date(BASE + 1000).toISOString(), 'finite sleepUntil');

  assert.deepEqual(legacy.legacyNormalizeSpeakerIds('1,2，3 4'), ['1', '2', '3', '4'], 'speaker ids');
  assert.equal(legacy.legacyHasExplicitEnd({ recentMessages: [{ tail: '晚安' }] }), true, 'explicit end');
  assert.equal(legacy.legacyIsSleepingConfig({ mode: 'active' }), false, 'sleeping active');
  assert.equal(legacy.legacyWakePriority('keyword:小鲸鱼', PRIORITY_TABLE), 60, 'priority colon base');
  assert.equal(legacy.legacyWakePriority('unknown', PRIORITY_TABLE), 0, 'priority unknown');
});

// ── Contract surface ────────────────────────────────────────────────────────────────────────────
test('[contract] module exports exactly the frozen interface', () => {
  requireExport('normalizeSpeakerIds');
  assert.deepEqual(Object.keys(target).sort(), [
    'computeWakeSafety', 'defaultWakeConfig', 'evaluateWakeTrigger', 'hasExplicitEnd', 'isDirectedAtAi', 'isSleepingConfig',
    'normalizeSpeakerIds', 'preSleepWaitBlocked', 'wakePriority',
  ], 'module export keys');
  assert.equal('default' in target, false, 'no default export');
});

// ── normalizeSpeakerIds ─────────────────────────────────────────────────────────────────────────
const SPEAKER_CASES = [
  ['undefined', undefined],
  ['null', null],
  ['empty array', []],
  ['number scalar', 12345],
  ['zero scalar', 0],
  ['numeric string', '12345'],
  ['leading zero', '012345'],
  ['negative', '-123'],
  ['decimal', '1.5'],
  ['whitespace padded', '  123  '],
  ['mixed separators', '1，2,3 4\t5\n6'],
  ['duplicates', ['1', '1', 2, '2']],
  ['mixed junk array', [null, undefined, {}, 'abc', '123']],
  ['array with zero', [0, '0', '123']],
  ['object scalar', {}],
  ['true scalar', true],
  ['false scalar', false],
  ['bigint scalar', 123n],
  ['symbol scalar', Symbol('x')],
  ['array object coercion', [{ toString: () => ' 999 ' }]],
  ['twenty five items', Array.from({ length: 25 }, (_, index) => String(index + 1))],
  ['duplicate order preserved', ['456', '123', '456', '123']],
];

test('[contract] normalizeSpeakerIds differential table', () => {
  const fn = requireExport('normalizeSpeakerIds');
  for (const [label, input] of SPEAKER_CASES) {
    assert.deepEqual(fn(input), legacy.legacyNormalizeSpeakerIds(input), label);
  }
});

test('[contract] normalizeSpeakerIds caps at 20 before later coercions', () => {
  const fn = requireExport('normalizeSpeakerIds');
  const input = [
    ...Array.from({ length: 20 }, (_, index) => String(index + 1)),
    { toString() { throw new Error('coerced past the cap'); } },
  ];
  const expected = legacy.legacyNormalizeSpeakerIds(input);
  assert.equal(expected.length, 20, 'fixture cap');
  assert.deepEqual(fn(input), expected, 'cap before coercion');
  assert.equal(fn(Array.from({ length: 25 }, (_, index) => String(index + 1))).length, 20, 'cap length');

  const throwing = { toString() { throw new Error('bad scalar'); } };
  assert.deepEqual(captureThrow(() => fn(throwing)).error, captureThrow(() => legacy.legacyNormalizeSpeakerIds(throwing)).error, 'coercion error parity');
});

// ── defaultWakeConfig differential ─────────────────────────────────────────────────────────────
const DEFAULT_BOUND_CASES = [
  { label: 'empty object stays infinite', w: {}, spec: { randomValues: [0.5] } },
  { label: 'finite defaults', w: { recommendedDefaultInfinite: false }, spec: { randomValues: [0], nowValues: [BASE] } },
  { label: 'active mode', w: { defaultMode: 'active' }, spec: { randomValues: [0.25] } },
  { label: 'uppercase mode is not active', w: { defaultMode: 'ACTIVE' }, spec: { randomValues: [0.25] } },
  { label: 'numeric mode is not active', w: { defaultMode: 1 }, spec: { randomValues: [0.25] } },
  { label: 'numeric string bounds', w: { recommendedDefaultInfinite: false, recommendedSleepMinMs: '10000', recommendedSleepMaxMs: '20000' }, spec: { randomValues: [0.25], nowValues: [BASE] } },
  { label: 'recMin only', w: { recommendedDefaultInfinite: false, recommendedSleepMinMs: 400000 }, spec: { randomValues: [0.5], nowValues: [BASE] } },
  { label: 'recMax only', w: { recommendedDefaultInfinite: false, recommendedSleepMaxMs: 900000 }, spec: { randomValues: [0.5], nowValues: [BASE] } },
  { label: 'zero recMin falls back to 300000', w: { recommendedDefaultInfinite: false, recommendedSleepMinMs: 0 }, spec: { randomValues: [0.5], nowValues: [BASE] } },
  { label: 'zero recMax falls back to 7200000', w: { recommendedDefaultInfinite: false, recommendedSleepMaxMs: 0 }, spec: { randomValues: [0.5], nowValues: [BASE] } },
  { label: 'recMin greater than recMax flattens', w: { recommendedDefaultInfinite: false, recommendedSleepMinMs: 7200000, recommendedSleepMaxMs: 300000 }, spec: { randomValues: [0.5], nowValues: [BASE] } },
];

test('[contract] defaultWakeConfig differential: bounds, mode, infinite', () => {
  for (const { label, w, spec } of DEFAULT_BOUND_CASES) compareDefault(label, w, spec);
});

const DEFAULT_COERCION_CASES = [
  { label: 'hard min clamp', w: { recommendedDefaultInfinite: false, recommendedSleepMinMs: 100, recommendedSleepMaxMs: 100, sleepMinMs: 2000 }, spec: { randomValues: [0.5], nowValues: [BASE] } },
  { label: 'hard max clamp', w: { recommendedDefaultInfinite: false, recommendedSleepMinMs: 5000000, recommendedSleepMaxMs: 5000000, sleepMaxMs: 1000 }, spec: { randomValues: [0.5], nowValues: [BASE] } },
  { label: 'hard min then hard max order', w: { recommendedDefaultInfinite: false, recommendedSleepMinMs: 100, recommendedSleepMaxMs: 100, sleepMinMs: 2000, sleepMaxMs: 1000 }, spec: { randomValues: [0.5], nowValues: [BASE] } },
  { label: 'numeric string hard bounds', w: { recommendedDefaultInfinite: false, recommendedSleepMinMs: 100, recommendedSleepMaxMs: 100, sleepMinMs: '2000', sleepMaxMs: '1000' }, spec: { randomValues: [0.5], nowValues: [BASE] } },
  { label: 'negative hard bounds ignored', w: { recommendedDefaultInfinite: false, sleepMinMs: -5, sleepMaxMs: -1 }, spec: { randomValues: [0.5], nowValues: [BASE] } },
  { label: 'zero hard min ignored', w: { recommendedDefaultInfinite: false, recommendedSleepMinMs: 1000, recommendedSleepMaxMs: 1000, sleepMinMs: 0 }, spec: { randomValues: [0.5], nowValues: [BASE] } },
  { label: 'probability over one clamps', w: { recommendedProbability: 2 }, spec: { randomValues: [0.5] } },
  { label: 'probability below zero clamps', w: { recommendedProbability: -1 }, spec: { randomValues: [0.5] } },
  { label: 'probability NaN becomes zero', w: { recommendedProbability: NaN }, spec: { randomValues: [0.5] } },
  { label: 'probability numeric string', w: { recommendedProbability: '0.5' }, spec: { randomValues: [0.5] } },
  { label: 'probability boolean', w: { recommendedProbability: true }, spec: { randomValues: [0.5] } },
  { label: 'batch window zero falls back', w: { batchWindowMs: 0 }, spec: { randomValues: [0.5] } },
  { label: 'batch window floor', w: { batchWindowMs: 10 }, spec: { randomValues: [0.5] } },
  { label: 'batch window negative floors', w: { batchWindowMs: -5 }, spec: { randomValues: [0.5] } },
  { label: 'batch window numeric string', w: { batchWindowMs: '2500' }, spec: { randomValues: [0.5] } },
  { label: 'batch window NaN falls back', w: { batchWindowMs: NaN }, spec: { randomValues: [0.5] } },
];

test('[contract] defaultWakeConfig differential: numeric coercion and clamps', () => {
  for (const { label, w, spec } of DEFAULT_COERCION_CASES) compareDefault(label, w, spec);
});

const DEFAULT_SWITCH_CASES = [
  { label: 'atMention strict false', w: { recommendedAtMention: false }, spec: { randomValues: [0.5] } },
  { label: 'atMention zero stays enabled', w: { recommendedAtMention: 0 }, spec: { randomValues: [0.5] } },
  { label: 'atMention empty string stays enabled', w: { recommendedAtMention: '' }, spec: { randomValues: [0.5] } },
  { label: 'atMention null stays enabled', w: { recommendedAtMention: null }, spec: { randomValues: [0.5] } },
  { label: 'atMention string false stays enabled', w: { recommendedAtMention: 'false' }, spec: { randomValues: [0.5] } },
  { label: 'nameMention strict false', w: { recommendedNameMention: false }, spec: { randomValues: [0.5] } },
  { label: 'question NaN stays enabled', w: { recommendedQuestion: NaN }, spec: { randomValues: [0.5] } },
  { label: 'poke zero stays enabled', w: { recommendedPoke: 0 }, spec: { randomValues: [0.5] } },
  { label: 'infinite zero stays enabled', w: { recommendedDefaultInfinite: 0 }, spec: { randomValues: [0.5] } },
  { label: 'infinite empty string stays enabled', w: { recommendedDefaultInfinite: '' }, spec: { randomValues: [0.5] } },
  { label: 'infinite string false stays enabled', w: { recommendedDefaultInfinite: 'false' }, spec: { randomValues: [0.5] } },
  { label: 'keywords array of mixed values', w: { recommendedKeywords: [1, 'two', null] }, spec: { randomValues: [0.5] } },
  { label: 'keywords string is not an array', w: { recommendedKeywords: 'kw' }, spec: { randomValues: [0.5] } },
  { label: 'keywords null', w: { recommendedKeywords: null }, spec: { randomValues: [0.5] } },
  { label: 'keywords object', w: { recommendedKeywords: { 0: 'kw' } }, spec: { randomValues: [0.5] } },
  { label: 'active mode enables anyMessage', w: { defaultMode: 'active', recommendedAtMention: false }, spec: { randomValues: [0.5] } },
];

test('[contract] defaultWakeConfig differential: switches, triggers, batch', () => {
  for (const { label, w, spec } of DEFAULT_SWITCH_CASES) compareDefault(label, w, spec);
});

test('[contract] defaultWakeConfig capability traces and counts', () => {
  const fn = requireExport('defaultWakeConfig');

  const infiniteLog = [];
  const infiniteCaps = makeCaps({ randomValues: [0.5] }, infiniteLog);
  const infinite = fn?.({}, { now: infiniteCaps.now, random: infiniteCaps.random });
  assert.deepEqual(infiniteCaps.trace.random, [0.5], 'infinite consumes random once');
  assert.deepEqual(infiniteCaps.trace.now, [], 'infinite consumes no clock');
  assert.deepEqual(infiniteCaps.trace.order, ['random'], 'infinite capability order');

  const finiteCaps = makeCaps({ randomValues: [0.5], nowValues: [BASE] }, []);
  const finite = fn({ recommendedDefaultInfinite: false, recommendedSleepMinMs: 1000, recommendedSleepMaxMs: 1000 }, { now: finiteCaps.now, random: finiteCaps.random });
  assert.deepEqual(finiteCaps.trace.random, [0.5], 'finite consumes random once');
  assert.deepEqual(finiteCaps.trace.now, [BASE], 'finite consumes clock once');
  assert.deepEqual(finiteCaps.trace.order, ['random', 'now'], 'random before clock');

  const laterCaps = makeCaps({ randomValues: [0.5], nowValues: [BASE + 5000] }, []);
  const later = fn({ recommendedDefaultInfinite: false, recommendedSleepMinMs: 1000, recommendedSleepMaxMs: 1000 }, { now: laterCaps.now, random: laterCaps.random });
  assert.notEqual(later.sleepUntil, finite.sleepUntil, 'clock value changes sleepUntil');

  const clampCaps = makeCaps({ randomValues: [0.5], nowValues: [BASE] }, []);
  fn({ recommendedDefaultInfinite: false, recommendedSleepMinMs: 7200000, recommendedSleepMaxMs: 100, sleepMinMs: 1000, sleepMaxMs: 2000 }, { now: clampCaps.now, random: clampCaps.random });
  assert.deepEqual(clampCaps.trace.random, [0.5], 'random once before clamps');
  assert.deepEqual(clampCaps.trace.now, [BASE], 'clock once after clamps');
});

test('[contract] defaultWakeConfig key order, types, fresh identity, no mutation', () => {
  const fn = requireExport('defaultWakeConfig');
  const keywords = Object.freeze(['a', 2]);
  const source = deepFreeze({ recommendedDefaultInfinite: false, recommendedSleepMinMs: 1500, recommendedSleepMaxMs: 1500, recommendedKeywords: keywords });
  const out = fn(source, { now: () => BASE, random: () => 0.5 });

  assert.deepEqual(Object.keys(out), ['mode', 'infinite', 'sleepUntil', 'triggers', 'batchWindowMs', 'lastWakeAt', 'wakeCount', 'noActionCount', 'confirmedAt', 'confirmedBy'], 'result key order');
  assert.deepEqual(Object.keys(out.triggers), ['atMention', 'nameMention', 'speakerIds', 'keywords', 'question', 'poke', 'anyMessage', 'probability'], 'trigger key order');
  assert.equal(typeof out.mode, 'string', 'mode type');
  assert.equal(typeof out.infinite, 'boolean', 'infinite type');
  assert.equal(out.sleepUntil, new Date(BASE + 1500).toISOString(), 'rounded finite sleepUntil');
  assert.equal(typeof out.sleepUntil, 'string', 'sleepUntil type');
  assert.deepEqual(out.triggers.speakerIds, [], 'speakerIds empty array');
  assert(Array.isArray(out.triggers.speakerIds), 'speakerIds array');
  assert(Array.isArray(out.triggers.keywords), 'keywords array');
  assert.deepEqual(out.triggers.keywords, ['a', '2'], 'keywords stringified');
  assert.equal(typeof out.triggers.atMention, 'boolean', 'atMention type');
  assert.equal(typeof out.triggers.probability, 'number', 'probability type');
  assert.equal(out.batchWindowMs, 8000, 'batch window type/value');
  assert.deepEqual([out.lastWakeAt, out.wakeCount, out.noActionCount, out.confirmedAt], [0, 0, 0, 0], 'zeroed counters');
  assert.equal(out.confirmedBy, 'default', 'confirmedBy');

  assert.notEqual(out.triggers.keywords, keywords, 'keywords are a fresh array');
  assert.notEqual(out.triggers.speakerIds, out.triggers.keywords, 'fresh arrays per field');
  const second = fn(source, { now: () => BASE, random: () => 0.5 });
  assert.notEqual(second, out, 'fresh result object');
  assert.notEqual(second.triggers, out.triggers, 'fresh triggers object');
  assert.notEqual(second.triggers.speakerIds, out.triggers.speakerIds, 'fresh speakerIds array');

  assert.equal(JSON.stringify(source), JSON.stringify({ recommendedDefaultInfinite: false, recommendedSleepMinMs: 1500, recommendedSleepMaxMs: 1500, recommendedKeywords: ['a', 2] }), 'input not mutated');
  const infiniteOut = fn(deepFreeze({}), { now: () => { throw new Error('clock should not run'); }, random: () => 0.5 });
  assert.equal(infiniteOut.sleepUntil, null, 'infinite has null sleepUntil');
  assert.equal(Object.isFrozen(source), true, 'frozen input still frozen');
});

test('[contract] defaultWakeConfig exception parity', () => {
  compareDefault('throwing random', {}, { randomThrows: 'random boom' });
  compareDefault('throwing clock on finite', { recommendedDefaultInfinite: false }, { randomValues: [0.5], nowThrows: 'clock boom' });
  compareDefault('clock NaN invalid date', { recommendedDefaultInfinite: false }, { randomValues: [0.5], nowValues: [NaN] });
  compareDefault('clock Infinity invalid date', { recommendedDefaultInfinite: false }, { randomValues: [0.5], nowValues: [Infinity] });
  compareDefault('clock beyond Date range', { recommendedDefaultInfinite: false }, { randomValues: [0.5], nowValues: [8.64e15] });

  const throwingMin = {};
  Object.defineProperty(throwingMin, 'recommendedSleepMinMs', { get() { throw new Error('getter boom'); }, enumerable: true });
  compareDefault('throwing getter', throwingMin, { randomValues: [0.5] });

  const throwingMode = {};
  Object.defineProperty(throwingMode, 'defaultMode', { get() { throw new Error('mode getter boom'); }, enumerable: true });
  compareDefault('throwing mode getter', throwingMode, { randomValues: [0.5] });
});

test('[contract] defaultWakeConfig repeated keyword reads and second-read exception', () => {
  const fn = requireExport('defaultWakeConfig');
  const makeKeywordSource = (firstValue) => {
    let reads = 0;
    const w = {};
    Object.defineProperty(w, 'recommendedKeywords', {
      enumerable: true,
      get() {
        reads += 1;
        if (reads === 1) return firstValue;
        throw new Error('second read');
      },
    });
    return { w, reads: () => reads };
  };
  const compareKeywordPath = (firstValue, label) => {
    const expectedInput = makeKeywordSource(firstValue);
    const actualInput = makeKeywordSource(firstValue);
    const expectedLog = [];
    const actualLog = [];
    const spec = { randomValues: [0.5] };
    const expected = runDefault(legacy.legacyDefaultWakeConfig, expectedInput.w, spec, expectedLog);
    const actual = runDefault(fn, actualInput.w, spec, actualLog);
    return { expectedInput, actualInput, expectedLog, actualLog, expected, actual, label };
  };

  const arrayPath = compareKeywordPath(['kw'], 'array path');
  assert.deepEqual(arrayPath.actual.error, { name: 'Error', message: 'second read' }, 'production throws on second read');
  assert.deepEqual(arrayPath.expected.error, { name: 'Error', message: 'second read' }, 'oracle throws on second read');
  assert.deepEqual(arrayPath.actual.error, arrayPath.expected.error, 'second-read exception parity');
  assert.equal(arrayPath.actualInput.reads(), 2, 'production reads the array keyword twice');
  assert.equal(arrayPath.expectedInput.reads(), 2, 'oracle reads the array keyword twice');
  assert.equal(arrayPath.actualLog.filter((entry) => entry === 'recommendedKeywords').length, 2, 'production log shows two reads');
  assert.equal(arrayPath.expectedLog.filter((entry) => entry === 'recommendedKeywords').length, 2, 'oracle log shows two reads');
  assert.deepEqual(arrayPath.actualLog, arrayPath.expectedLog, 'complete ordered log parity on array path');

  const scalarPath = compareKeywordPath('kw', 'non-array path');
  assert.equal(scalarPath.actual.error, null, 'production non-array branch does not read twice');
  assert.equal(scalarPath.expected.error, null, 'oracle non-array branch does not read twice');
  assert.deepEqual(scalarPath.actual.value.triggers.keywords, [], 'non-array keywords are empty');
  assert.equal(scalarPath.actualInput.reads(), 1, 'production reads the non-array keyword once');
  assert.equal(scalarPath.expectedInput.reads(), 1, 'oracle reads the non-array keyword once');
  assert.equal(scalarPath.actualLog.filter((entry) => entry === 'recommendedKeywords').length, 1, 'one read in production log');
  assert.deepEqual(scalarPath.actualLog, scalarPath.expectedLog, 'complete ordered log parity on non-array path');
});

// ── computeWakeSafety differential ─────────────────────────────────────────────────────────────
const SAFETY_CASES = [
  { label: 'empty object', wc: {} },
  { label: 'active mode', wc: { mode: 'active' } },
  { label: 'anyMessage string', wc: { triggers: { anyMessage: 'yes' } } },
  { label: 'atMention zero question one', wc: { triggers: { atMention: 0, question: 1 } } },
  { label: 'poke object reference', wc: { triggers: { poke: { tag: 'p' } } } },
  { label: 'empty keywords', wc: { triggers: { keywords: [] } } },
  { label: 'string keywords not array', wc: { triggers: { keywords: 'kw' } } },
  { label: 'keyword list', wc: { triggers: { keywords: ['kw'] } } },
  { label: 'speaker ids junk only', wc: { triggers: { speakerIds: ['001', 'null', null] } } },
  { label: 'speaker ids valid', wc: { triggers: { speakerIds: ['001', '123'] } } },
  { label: 'speaker ids scalar', wc: { triggers: { speakerIds: '123' } } },
  { label: 'probability numeric string', wc: { triggers: { probability: '0.5' } } },
  { label: 'probability zero', wc: { triggers: { probability: 0 } } },
  { label: 'infinite ignores sleepUntil', wc: { infinite: true, sleepUntil: FUTURE } },
  { label: 'finite future sleepUntil', wc: { infinite: false, sleepUntil: FUTURE }, spec: { nowValues: [BASE] } },
  { label: 'finite invalid sleepUntil', wc: { infinite: false, sleepUntil: 'bogus' }, spec: { nowValues: [BASE] } },
  { label: 'finite zero sleepUntil', wc: { infinite: false, sleepUntil: 0 } },
  { label: 'finite empty sleepUntil', wc: { infinite: false, sleepUntil: '' } },
  { label: 'finite null sleepUntil', wc: { infinite: false, sleepUntil: null } },
  { label: 'stale exact day boundary', wc: { infinite: true, confirmedAt: BASE - DAY }, spec: { nowValues: [BASE] } },
  { label: 'stale one ms over boundary', wc: { infinite: true, confirmedAt: BASE - DAY - 1 }, spec: { nowValues: [BASE] } },
  { label: 'confirmedAt invalid string', wc: { infinite: true, confirmedAt: 'abc' } },
  { label: 'confirmedAt string zero', wc: { infinite: true, confirmedAt: '0' }, spec: { nowValues: [BASE] } },
  { label: 'confirmedAt zero', wc: { infinite: true, confirmedAt: 0 } },
  { label: 'timed and stale both read clock', wc: { infinite: false, sleepUntil: FUTURE, confirmedAt: BASE - 1000 }, spec: { nowValues: [BASE, BASE] } },
  { label: 'null config', wc: null },
  { label: 'undefined config', wc: undefined },
];

test('[contract] computeWakeSafety differential table', () => {
  for (const { label, wc, spec = {} } of SAFETY_CASES) compareCompute(label, wc, spec);
});

test('[contract] computeWakeSafety non-boolean fields and clock budget', () => {
  const fn = requireExport('computeWakeSafety');

  const emptyCaps = makeCaps({}, []);
  const empty = fn({}, { now: emptyCaps.now });
  assert.deepEqual(emptyCaps.trace.now, [], 'empty config uses no clock');
  assert.equal(empty.hard, false, 'empty hard');
  assert.equal(empty.timed, undefined, 'empty timed keeps undefined');
  assert.equal(empty.soft, false, 'empty soft');
  assert.equal(empty.guaranteed, false, 'empty guaranteed');
  assert.equal(empty.stale, true, 'empty stale');
  assert.deepEqual(Object.keys(empty), ['hard', 'timed', 'soft', 'guaranteed', 'stale'], 'safety key order');

  const pokeRef = { tag: 'ref' };
  const refOut = fn({ triggers: { poke: pokeRef } }, { now: () => BASE });
  assert.equal(refOut.hard, pokeRef, 'hard keeps object reference');
  assert.equal(refOut.guaranteed, pokeRef, 'guaranteed keeps object reference');
  const numeric = fn({ triggers: { question: 7 } }, { now: () => BASE });
  assert.equal(numeric.hard, 7, 'hard keeps number');
  assert.equal(numeric.guaranteed, 7, 'guaranteed keeps number');
  const stringy = fn({ triggers: { anyMessage: 'yes' } }, { now: () => BASE });
  assert.equal(stringy.hard, 'yes', 'hard keeps string');

  const timedCaps = makeCaps({ nowValues: [BASE, BASE] }, []);
  fn({ infinite: false, sleepUntil: FUTURE, confirmedAt: BASE - 1 }, { now: timedCaps.now });
  assert.equal(timedCaps.trace.now.length, 2, 'timed and stale each read clock');

  const staleCaps = makeCaps({ nowValues: [BASE] }, []);
  fn({ infinite: true, confirmedAt: BASE - 1 }, { now: staleCaps.now });
  assert.equal(staleCaps.trace.now.length, 1, 'only stale reads clock');

  const exact = fn({ infinite: true, confirmedAt: BASE - DAY }, { now: () => BASE });
  assert.equal(exact.stale, false, 'exact 24h is not stale');
  const over = fn({ infinite: true, confirmedAt: BASE - DAY - 1 }, { now: () => BASE });
  assert.equal(over.stale, true, 'one ms over 24h is stale');

  const frozen = deepFreeze({ triggers: { probability: 0.5 }, confirmedAt: BASE });
  const before = JSON.stringify(frozen);
  fn(frozen, { now: () => BASE });
  assert.equal(JSON.stringify(frozen), before, 'config not mutated');
});

// ── preSleepWaitBlocked differential ─────────────────────────────────────────────────────────
const PRE_SLEEP_CASES = [
  { label: 'null state', st: null, w: { preSleepWaitEnabled: true } },
  { label: 'undefined state', st: undefined, w: { preSleepWaitEnabled: true } },
  { label: 'zero state', st: 0, w: { preSleepWaitEnabled: true } },
  { label: 'empty state and config', st: {}, w: {}, spec: { nowValues: [BASE] } },
  { label: 'disabled strict false', st: {}, w: { preSleepWaitEnabled: false } },
  { label: 'disabled zero is enabled', st: {}, w: { preSleepWaitEnabled: 0 }, spec: { nowValues: [BASE] } },
  { label: 'disabled empty string is enabled', st: {}, w: { preSleepWaitEnabled: '' }, spec: { nowValues: [BASE] } },
  { label: 'disabled null is enabled', st: {}, w: { preSleepWaitEnabled: null }, spec: { nowValues: [BASE] } },
  { label: 'disabled string false is enabled', st: {}, w: { preSleepWaitEnabled: 'false' }, spec: { nowValues: [BASE] } },
  { label: 'explicit end short-circuits', st: { recentMessages: [{ isSelf: false, tail: '晚安' }] }, w: {} },
  { label: 'explicit end uses plain fallback', st: { recentMessages: [{ tail: '', plain: '再见' }] }, w: {} },
  { label: 'explicit end ignores non-last non-self', st: { recentMessages: [{ tail: '晚安' }, { isSelf: true, tail: 'x' }] }, w: {} },
  { label: 'last non-self no match', st: { recentMessages: [{ tail: 'hello' }, { isSelf: true, tail: '晚安' }] }, w: {}, spec: { nowValues: [BASE] } },
  { label: 'default wait boundary', st: { lastIncomingAt: BASE - 300000 }, w: {}, spec: { nowValues: [BASE] } },
  { label: 'default wait one ms under', st: { lastIncomingAt: BASE - 299999 }, w: {}, spec: { nowValues: [BASE] } },
  { label: 'zero lastIncomingAt blocks', st: { lastIncomingAt: 0 }, w: {}, spec: { nowValues: [BASE] } },
  { label: 'custom wait boundary', st: { lastIncomingAt: BASE - 600000 }, w: { preSleepWaitMs: '600000' }, spec: { nowValues: [BASE] } },
  { label: 'custom wait one ms under', st: { lastIncomingAt: BASE - 599999 }, w: { preSleepWaitMs: '600000' }, spec: { nowValues: [BASE] } },
  { label: 'zero wait falls back to default', st: { lastIncomingAt: BASE - 299999 }, w: { preSleepWaitMs: 0 }, spec: { nowValues: [BASE] } },
  { label: 'negative wait clamps to zero', st: { lastIncomingAt: BASE - 1 }, w: { preSleepWaitMs: -5 }, spec: { nowValues: [BASE] } },
  // Quiet gate is definitively false here (now=1000, waitMs=300000): these rows reach the
  // satisfied/observed release branch instead of returning at the quiet-window check.
  { label: 'satisfied newer than incoming after quiet gate', st: { lastIncomingAt: 999, preSleepWaitSatisfiedAt: 1000 }, w: {}, spec: { nowValues: [1000] }, expected: false },
  { label: 'satisfied equal incoming after quiet gate', st: { lastIncomingAt: 1000, preSleepWaitSatisfiedAt: 1000 }, w: {}, spec: { nowValues: [1000] }, expected: false },
  { label: 'satisfied older than incoming after quiet gate', st: { lastIncomingAt: 1001, preSleepWaitSatisfiedAt: 1000 }, w: {}, spec: { nowValues: [1000] }, expected: true },
  { label: 'satisfied with zero incoming after quiet gate', st: { lastIncomingAt: 0, preSleepWaitSatisfiedAt: 5 }, w: {}, spec: { nowValues: [1000] }, expected: false },
  { label: 'observed newer than incoming after quiet gate', st: { lastIncomingAt: 999, preSleepWaitObservedAt: 1000 }, w: {}, spec: { nowValues: [1000] }, expected: false },
  { label: 'observed equal incoming after quiet gate', st: { lastIncomingAt: 1000, preSleepWaitObservedAt: 1000 }, w: {}, spec: { nowValues: [1000] }, expected: false },
  { label: 'observed older than incoming after quiet gate', st: { lastIncomingAt: 1001, preSleepWaitObservedAt: 1000 }, w: {}, spec: { nowValues: [1000] }, expected: true },
  { label: 'observed with zero incoming after quiet gate', st: { lastIncomingAt: 0, preSleepWaitObservedAt: 5 }, w: {}, spec: { nowValues: [1000] }, expected: false },
  { label: 'observed wins after satisfied misses', st: { lastIncomingAt: 1001, preSleepWaitSatisfiedAt: 1000, preSleepWaitObservedAt: 1001 }, w: {}, spec: { nowValues: [1000] }, expected: false },
  { label: 'satisfied wins before observed', st: { lastIncomingAt: 1001, preSleepWaitSatisfiedAt: 1001, preSleepWaitObservedAt: 1000 }, w: {}, spec: { nowValues: [1000] }, expected: false },
];

test('[contract] preSleepWaitBlocked differential table', () => {
  const fn = requireExport('preSleepWaitBlocked');
  for (const { label, st, w, spec = {}, expected } of PRE_SLEEP_CASES) {
    comparePreSleep(label, st, w, spec);
    if (expected === undefined) continue;
    const actual = runPreSleep(fn, inputFactory(st)(), inputFactory(w)(), spec, []);
    const oracle = runPreSleep(legacy.legacyPreSleepWaitBlocked, inputFactory(st)(), inputFactory(w)(), spec, []);
    assert.equal(actual.error, null, `${label}: production must not throw`);
    assert.equal(oracle.error, null, `${label}: oracle must not throw`);
    assert.equal(actual.value, expected, `${label}: production expected ${expected}`);
    assert.equal(oracle.value, expected, `${label}: oracle expected ${expected}`);
  }
});

test('[contract] preSleepWaitBlocked clock budget and read order', () => {
  const fn = requireExport('preSleepWaitBlocked');

  const nullCaps = makeCaps({}, []);
  const nullLog = [];
  fn(null, traced({ preSleepWaitEnabled: true }, nullLog), nullCaps);
  assert.equal(nullCaps.trace.now.length, 0, 'null state uses no clock');
  assert.deepEqual(nullLog, [], 'null state reads no config');

  const disabledCaps = makeCaps({}, []);
  const disabledLog = [];
  fn({}, traced({ preSleepWaitEnabled: false, preSleepWaitMs: 999 }, disabledLog), disabledCaps);
  assert.equal(disabledCaps.trace.now.length, 0, 'disabled rule uses no clock');
  assert.deepEqual(disabledLog, ['preSleepWaitEnabled'], 'disabled reads only the switch');

  const endCaps = makeCaps({}, []);
  fn({ recentMessages: [{ tail: '886' }] }, {}, endCaps);
  assert.equal(endCaps.trace.now.length, 0, 'explicit end uses no clock');

  const blockedCaps = makeCaps({ nowValues: [BASE] }, []);
  assert.equal(fn({}, {}, blockedCaps), true, 'fresh state is blocked');
  assert.equal(blockedCaps.trace.now.length, 1, 'blocked path reads clock once');

  const equalCaps = makeCaps({ nowValues: [BASE] }, []);
  assert.equal(fn({ lastIncomingAt: BASE - 300000 }, {}, equalCaps), false, 'boundary equality releases');
  assert.equal(equalCaps.trace.now.length, 1, 'boundary reads clock once');

  const underCaps = makeCaps({ nowValues: [BASE] }, []);
  assert.equal(fn({ lastIncomingAt: BASE - 299999 }, {}, underCaps), true, 'one ms under blocks');
  assert.equal(underCaps.trace.now.length, 1, 'one ms under reads clock once');

  const throwingConfig = traced({}, []);
  assert.throws(() => fn({}, throwingConfig, { now: () => { throw new Error('clock should not run'); } }), /clock should not run/, 'clock not touched before config');

  const throwingState = new Proxy({}, { get() { throw new Error('state getter boom'); } });
  assert.deepEqual(captureThrow(() => fn(throwingState, {}, { now: () => BASE })).error, captureThrow(() => legacy.legacyPreSleepWaitBlocked(throwingState, {}, { now: () => BASE })).error, 'state getter error parity');

  const throwingWait = {};
  Object.defineProperty(throwingWait, 'preSleepWaitMs', { get() { throw new Error('wait getter boom'); }, enumerable: true });
  comparePreSleep('throwing wait getter', {}, throwingWait, { nowValues: [BASE] });
});

// ── hasExplicitEnd / isSleepingConfig differential ─────────────────────────────────────────────
const EXPLICIT_END_CASES = [
  ['undefined state', undefined],
  ['null state', null],
  ['empty state', {}],
  ['non-array recentMessages', { recentMessages: 'x' }],
  ['empty recentMessages', { recentMessages: [] }],
  ['tail match', { recentMessages: [{ isSelf: false, tail: '晚安' }] }],
  ['plain fallback', { recentMessages: [{ tail: '', plain: '再见' }] }],
  ['plain ignored when tail truthy', { recentMessages: [{ tail: 'hi', plain: '再见' }] }],
  ['text ignored when tail truthy', { recentMessages: [{ tail: 'hi', text: '886' }] }],
  ['text fallback', { recentMessages: [{ plain: '', text: '886' }] }],
  ['null message entries', { recentMessages: [null, { tail: '晚安' }] }],
  ['only last non-self', { recentMessages: [{ tail: '晚安' }, { isSelf: true, tail: 'x' }] }],
  ['last self ignored', { recentMessages: [{ tail: 'hello' }, { isSelf: true, tail: '晚安' }] }],
  ['regex bye', { recentMessages: [{ tail: '拜拜！' }] }],
  ['regex digits', { recentMessages: [{ tail: '88' }] }],
  ['regex long', { recentMessages: [{ tail: '886' }] }],
  ['regex errand', { recentMessages: [{ tail: '去吃饭了' }] }],
  ['no match', { recentMessages: [{ tail: 'hello there' }] }],
];

test('[contract] hasExplicitEnd differential table', () => {
  const fn = requireExport('hasExplicitEnd');
  for (const [label, st] of EXPLICIT_END_CASES) {
    assert.equal(fn(st), legacy.legacyHasExplicitEnd(st), label);
  }
});

const SLEEPING_CASES = [
  ['null config', null],
  ['undefined config', undefined],
  ['empty config', {}],
  ['active mode', { mode: 'active' }],
  ['anyMessage true', { triggers: { anyMessage: true } }],
  ['anyMessage one', { triggers: { anyMessage: 1 } }],
  ['anyMessage string', { triggers: { anyMessage: 'yes' } }],
  ['diving no triggers', { mode: 'diving' }],
  ['diving anyMessage zero', { mode: 'diving', triggers: { anyMessage: 0 } }],
  ['null triggers', { triggers: null }],
  ['uppercase active is sleeping', { mode: 'ACTIVE' }],
];

test('[contract] isSleepingConfig differential table', () => {
  const fn = requireExport('isSleepingConfig');
  for (const [label, wc] of SLEEPING_CASES) {
    assert.equal(fn(wc), legacy.legacyIsSleepingConfig(wc), label);
  }
});

// ── wakePriority differential (table passed by the caller) ─────────────────────────────────────
const PRIORITY_CASES = [
  ['private', 'private'],
  ['atMention base', 'atMention'],
  ['atMention subtype', 'atMention:group'],
  ['question subtype', 'question:direct'],
  ['speaker subtype', 'speaker:昵称'],
  ['nameMention', 'nameMention'],
  ['keyword subtype', 'keyword:小鲸鱼'],
  ['anyMessage', 'anyMessage'],
  ['replyCheck', 'replyCheck'],
  ['timeout', 'timeout'],
  ['proactiveCheck', 'proactiveCheck'],
  ['unknown', 'unknown'],
  ['empty string', ''],
  ['null reason', null],
  ['undefined reason', undefined],
  ['no trim', '  private  '],
  ['uppercase is unknown', 'PRIVATE'],
  ['inherited constructor', 'constructor'],
  ['inherited toString', 'toString'],
  ['inherited __proto__', '__proto__'],
  ['inherited hasOwnProperty', 'hasOwnProperty'],
  ['numeric reason', 88],
  ['object reason', { toString: () => 'keyword:x' }],
];

test('[contract] wakePriority differential and inherited lookup', () => {
  const fn = requireExport('wakePriority');
  for (const [label, reason] of PRIORITY_CASES) {
    assert.equal(fn(reason, PRIORITY_TABLE), legacy.legacyWakePriority(reason, PRIORITY_TABLE), label);
  }
  assert.equal(fn('keyword:小鲸鱼', PRIORITY_TABLE), 60, 'colon base priority');
  assert.equal(fn('unknown', PRIORITY_TABLE), 0, 'unknown priority');
  assert.equal(typeof fn('constructor', PRIORITY_TABLE), 'function', 'constructor stays inherited');
  assert.equal(typeof fn('toString', PRIORITY_TABLE), 'function', 'toString stays inherited');
  assert.equal(typeof fn('__proto__', PRIORITY_TABLE), 'object', '__proto__ stays inherited');
  assert.notEqual(fn('constructor', PRIORITY_TABLE), 0, 'constructor is not defaulted');

  const throwing = { toString() { throw new Error('reason boom'); } };
  assert.deepEqual(captureThrow(() => fn(throwing, PRIORITY_TABLE)).error, captureThrow(() => legacy.legacyWakePriority(throwing, PRIORITY_TABLE)).error, 'reason coercion error parity');
  assert.deepEqual(captureThrow(() => fn('private', null)).error, captureThrow(() => legacy.legacyWakePriority('private', null)).error, 'null table error parity');
});
