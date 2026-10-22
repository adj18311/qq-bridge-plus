#!/usr/bin/env node
// Real-bridge integration tests for the wake-policy adapters.
// Run in-process: node scripts/test-wake-policy-integration.mjs
//
// Reuses scripts/audit-bridge-harness.mjs (the vm bridge harness) only: temporary files, fake
// peers, fake clock via the globals seam, no QQ/DSH/network side effects. The bridge object must
// expose the real adapters; missing exports are the expected RED state before implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const BASE = Date.UTC(2026, 9, 18, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const FUTURE = new Date(BASE + 60_000).toISOString();
const EXPOSED = [
  'normalizeSpeakerIdsV2', 'defaultWakeConfigV2', 'hasExplicitEndV2', 'isSleepingConfigV2',
  'preSleepWaitBlockedV2', 'computeWakeSafetyV2', 'wakePriorityV2',
  'refreshDefaultWakeConfigV2', 'refreshAllDefaultWakeConfigsV2', 'ensureWakeableV2',
];

function fakeClock(start = BASE) {
  let at = start;
  const calls = [];
  return {
    calls,
    now() { calls.push(at); return at; },
    set(value) { at = value; },
    get at() { return at; },
  };
}

async function withBridge(run, { wake = {} } = {}) {
  const clock = fakeClock();
  const random = { count: 0 };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now()])); }
    static now() { return clock.now(); }
  }
  const fakeMath = Object.create(Math);
  fakeMath.random = () => { random.count += 1; return 0.5; };
  const h = await bridgeHarness({
    config: { socialV2: { enabled: true, wake } },
    globals: { Date: ClockDate, Math: fakeMath },
  });
  h.setMode('reserved2');
  h.socialV2.paused = false;
  clock.calls.length = 0;
  random.count = 0;
  const reset = () => { clock.calls.length = 0; random.count = 0; };
  try {
    await run(h, clock, random, reset);
  } finally {
    await h.close();
  }
}

function api(h, name) {
  const fn = h[name];
  assert.equal(typeof fn, 'function', `bridge must expose ${name}`);
  return fn;
}

test('bridge exposes every wake-policy adapter', () => withBridge((h) => {
  for (const name of EXPOSED) api(h, name);
}));

test('normalizeSpeakerIdsV2 / hasExplicitEndV2 / isSleepingConfigV2 are thin real adapters', () => withBridge((h) => {
  const normalize = api(h, 'normalizeSpeakerIdsV2');
  const hasExplicitEnd = api(h, 'hasExplicitEndV2');
  const isSleeping = api(h, 'isSleepingConfigV2');

  assert.deepEqual(normalize('1，2,3 4'), ['1', '2', '3', '4'], 'speaker list parsing');
  assert.deepEqual(normalize(undefined), [], 'undefined speaker ids');
  assert.deepEqual(normalize(['001', null, '123']), ['123'], 'dirty speaker ids');
  assert.equal(normalize(Array.from({ length: 25 }, (_, index) => String(index + 1))).length, 20, 'speaker cap');

  assert.equal(hasExplicitEnd({ recentMessages: [{ isSelf: false, tail: '晚安' }] }), true, 'explicit end match');
  assert.equal(hasExplicitEnd({ recentMessages: [{ tail: 'hello' }] }), false, 'explicit end miss');
  assert.equal(hasExplicitEnd(null), false, 'explicit end null state');

  assert.equal(isSleeping({}), true, 'empty config sleeps');
  assert.equal(isSleeping({ mode: 'active' }), false, 'active mode does not sleep');
  assert.equal(isSleeping({ triggers: { anyMessage: 1 } }), false, 'anyMessage does not sleep');
}));

test('defaultWakeConfigV2 reads cfg.socialV2.wake live on every call', () => withBridge((h) => {
  const fn = api(h, 'defaultWakeConfigV2');
  h.cfg.socialV2.wake = { batchWindowMs: 5000 };
  assert.equal(fn().batchWindowMs, 5000, 'initial live config');

  h.cfg.socialV2.wake.batchWindowMs = 1234;
  assert.equal(fn().batchWindowMs, 1234, 'mutated live config');

  h.cfg.socialV2.wake = { batchWindowMs: 4321, defaultMode: 'active' };
  const replaced = fn();
  assert.equal(replaced.batchWindowMs, 4321, 'replaced live config');
  assert.equal(replaced.mode, 'active', 'replaced mode');
}));

test('defaultWakeConfigV2 maps mode, infinite, triggers and batch window', () => withBridge((h) => {
  h.cfg.socialV2.wake = {
    defaultMode: 'active',
    recommendedAtMention: false,
    recommendedKeywords: ['kw', 7],
    recommendedProbability: '0.25',
    recommendedQuestion: false,
    batchWindowMs: 10,
  };
  const fn = api(h, 'defaultWakeConfigV2');
  const out = fn();
  assert.equal(out.mode, 'active', 'mode');
  assert.equal(out.infinite, true, 'infinite default');
  assert.equal(out.triggers.anyMessage, true, 'active implies anyMessage');
  assert.equal(out.triggers.atMention, false, 'atMention switch');
  assert.deepEqual(out.triggers.keywords, ['kw', '7'], 'keywords stringified');
  assert.equal(out.triggers.probability, 0.25, 'probability coercion');
  assert.equal(out.batchWindowMs, 1000, 'batch window floor');

  h.cfg.socialV2.wake = {
    recommendedDefaultInfinite: false,
    recommendedSleepMinMs: 1000000,
    recommendedSleepMaxMs: 1000000,
  };
  const finite = fn();
  assert.equal(finite.infinite, false, 'finite config');
  assert.equal(finite.sleepUntil, new Date(BASE + 1000000).toISOString(), 'finite sleepUntil');
}));

test('defaultWakeConfigV2 consumes random once even when infinite, clock only when finite', () => withBridge((h, clock, random, reset) => {
  const fn = api(h, 'defaultWakeConfigV2');

  reset();
  const infinite = fn();
  assert.equal(infinite.infinite, true, 'infinite config');
  assert.equal(random.count, 1, 'random consumed exactly once for infinite');
  assert.equal(clock.calls.length, 0, 'infinite consumes no clock');

  h.cfg.socialV2.wake = {
    recommendedDefaultInfinite: false,
    recommendedSleepMinMs: 1000000,
    recommendedSleepMaxMs: 1000000,
  };
  clock.set(BASE + 123);
  reset();
  const finite = fn();
  assert.equal(random.count, 1, 'random consumed exactly once for finite');
  assert.equal(clock.calls.length, 1, 'finite consumes clock exactly once');
  assert.equal(finite.sleepUntil, new Date(BASE + 123 + 1000000).toISOString(), 'clock value feeds sleepUntil');
}));

test('preSleepWaitBlockedV2(null) returns false without reading cfg.socialV2.wake', () => withBridge((h) => {
  const fn = api(h, 'preSleepWaitBlockedV2');
  const st = h.getSocialV2State('private:123');
  const original = h.cfg.socialV2;
  let reads = 0;
  h.cfg.socialV2 = { enabled: true, get wake() { reads += 1; throw new Error('config read'); } };
  try {
    assert.equal(fn(null), false, 'null state short-circuits before config');
    assert.equal(reads, 0, 'cfg.socialV2.wake must not be read for null state');
    assert.throws(() => fn(st), /config read/, 'non-null state still resolves live wake config');
  } finally {
    h.cfg.socialV2 = original;
  }
}));

test('preSleepWaitBlockedV2 uses no clock on disabled/explicit end, one read otherwise', () => withBridge((h, clock, random, reset) => {
  const fn = api(h, 'preSleepWaitBlockedV2');
  const st = h.getSocialV2State('private:123');
  h.cfg.socialV2.wake = { preSleepWaitEnabled: false, preSleepWaitMs: 600000 };

  reset();
  assert.equal(fn(st), false, 'disabled rule');
  assert.equal(clock.calls.length, 0, 'disabled rule consumes no clock');

  h.cfg.socialV2.wake = { preSleepWaitEnabled: true, preSleepWaitMs: 600000 };
  st.recentMessages = [{ isSelf: false, tail: '晚安' }];
  reset();
  assert.equal(fn(st), false, 'explicit end');
  assert.equal(clock.calls.length, 0, 'explicit end consumes no clock');

  st.recentMessages = [];
  reset();
  assert.equal(fn(st), true, 'idle state is blocked');
  assert.equal(clock.calls.length, 1, 'blocked path reads clock once');

  st.lastIncomingAt = clock.at - 600000;
  reset();
  assert.equal(fn(st), false, 'quiet-window boundary releases');
  assert.equal(clock.calls.length, 1, 'boundary reads clock once');

  st.lastIncomingAt = clock.at - 599999;
  reset();
  assert.equal(fn(st), true, 'one ms under boundary blocks');
  assert.equal(clock.calls.length, 1, 'one ms under reads clock once');
}));

test('preSleepWaitBlockedV2 observed/satisfied release after the quiet gate fails', () => withBridge((h, clock, random, reset) => {
  const fn = api(h, 'preSleepWaitBlockedV2');
  const st = h.getSocialV2State('private:123');
  h.cfg.socialV2.wake = { preSleepWaitEnabled: true, preSleepWaitMs: 600000 };
  st.recentMessages = [];

  const check = (label, fields, expected) => {
    Object.assign(st, {
      lastIncomingAt: 0,
      preSleepWaitSatisfiedAt: 0,
      preSleepWaitObservedAt: 0,
      ...fields,
    });
    reset();
    assert.equal(fn(st), expected, label);
    assert.equal(clock.calls.length, 1, `${label}: exactly one clock read`);
    assert.ok(!st.lastIncomingAt || clock.at - st.lastIncomingAt < 600000, `${label}: quiet gate stays false`);
  };

  check('observed newer than incoming releases', { lastIncomingAt: clock.at - 1, preSleepWaitObservedAt: clock.at }, false);
  check('observed equal to incoming releases', { lastIncomingAt: clock.at, preSleepWaitObservedAt: clock.at }, false);
  check('observed older than incoming blocks', { lastIncomingAt: clock.at, preSleepWaitObservedAt: clock.at - 1 }, true);
  check('zero incoming with observed marker releases', { lastIncomingAt: 0, preSleepWaitObservedAt: clock.at }, false);

  check('satisfied newer than incoming releases', { lastIncomingAt: clock.at - 1, preSleepWaitSatisfiedAt: clock.at }, false);
  check('satisfied equal to incoming releases', { lastIncomingAt: clock.at, preSleepWaitSatisfiedAt: clock.at }, false);
  check('satisfied older than incoming blocks', { lastIncomingAt: clock.at, preSleepWaitSatisfiedAt: clock.at - 1 }, true);
  check('zero incoming with satisfied marker releases', { lastIncomingAt: 0, preSleepWaitSatisfiedAt: clock.at }, false);

  check('observed releases after satisfied misses', { lastIncomingAt: clock.at, preSleepWaitSatisfiedAt: clock.at - 1, preSleepWaitObservedAt: clock.at }, false);
}));

test('preSleepWaitBlockedV2 reads preSleepWaitMs live', () => withBridge((h, clock, random, reset) => {
  const fn = api(h, 'preSleepWaitBlockedV2');
  const st = h.getSocialV2State('private:123');
  h.cfg.socialV2.wake = { preSleepWaitEnabled: true, preSleepWaitMs: 600000 };
  st.lastIncomingAt = clock.at - 600000;
  reset();
  assert.equal(fn(st), false, '600000 ms window boundary');

  h.cfg.socialV2.wake.preSleepWaitMs = 1000;
  st.lastIncomingAt = clock.at - 1000;
  reset();
  assert.equal(fn(st), false, 'hot 1000 ms window boundary');
  st.lastIncomingAt = clock.at - 999;
  reset();
  assert.equal(fn(st), true, 'hot 1000 ms window one ms under');
}));

test('computeWakeSafetyV2 clock budget and non-boolean fields', () => withBridge((h, clock, random, reset) => {
  const fn = api(h, 'computeWakeSafetyV2');

  reset();
  const empty = fn({});
  assert.equal(empty.hard, false, 'empty hard');
  assert.equal(empty.timed, undefined, 'empty timed stays undefined');
  assert.equal(empty.stale, true, 'empty stale');
  assert.equal(clock.calls.length, 0, 'empty config consumes no clock');

  reset();
  const idle = fn({ mode: 'diving', infinite: true, triggers: {}, confirmedAt: 0 });
  assert.deepEqual(idle, { hard: false, timed: false, soft: false, guaranteed: false, stale: true }, 'idle safety');
  assert.equal(clock.calls.length, 0, 'idle config consumes no clock');

  reset();
  const timed = fn({ infinite: false, sleepUntil: FUTURE, triggers: {}, confirmedAt: BASE - 1 });
  assert.equal(timed.timed, true, 'timed future');
  assert.equal(timed.stale, false, 'fresh confirmation');
  assert.equal(clock.calls.length, 2, 'timed and stale each read clock');

  reset();
  const invalid = fn({ infinite: false, sleepUntil: 'bogus', triggers: {}, confirmedAt: 0 });
  assert.equal(invalid.timed, false, 'invalid sleepUntil');
  assert.equal(clock.calls.length, 1, 'invalid timed comparison still reads clock');

  const ref = { tag: 'ref' };
  const nonBoolean = fn({ triggers: { anyMessage: ref } });
  assert.equal(nonBoolean.hard, ref, 'hard keeps object reference');
  assert.equal(nonBoolean.guaranteed, ref, 'guaranteed keeps object reference');
  assert.equal(fn({ triggers: { question: 7 } }).hard, 7, 'hard keeps number');
}));

test('refreshDefaultWakeConfigV2 refreshes only default-confirmed configs', () => withBridge((h, clock, random, reset) => {
  h.cfg.socialV2.wake = { defaultMode: 'active', batchWindowMs: 4500 };
  const refresh = api(h, 'refreshDefaultWakeConfigV2');
  const st = h.getSocialV2State('private:123');
  st.wakeConfig = {
    mode: 'diving',
    infinite: false,
    sleepUntil: '2020-01-01T00:00:00.000Z',
    triggers: { anyMessage: true },
    batchWindowMs: 1000,
    lastWakeAt: 111,
    wakeCount: 2,
    noActionCount: 3,
    confirmedAt: 444,
    confirmedBy: 'default',
  };
  reset();
  assert.equal(refresh(st), true, 'default config refreshed');
  assert.equal(st.wakeConfig.mode, 'active', 'refreshed mode');
  assert.equal(st.wakeConfig.infinite, true, 'refreshed infinite');
  assert.equal(st.wakeConfig.batchWindowMs, 4500, 'refreshed batch window');
  assert.equal(st.wakeConfig.confirmedBy, 'default', 'confirmedBy preserved as default');
  assert.equal(st.wakeConfig.lastWakeAt, 111, 'lastWakeAt preserved');
  assert.equal(st.wakeConfig.wakeCount, 2, 'wakeCount preserved');
  assert.equal(st.wakeConfig.noActionCount, 3, 'noActionCount preserved');
  assert.equal(st.wakeConfig.confirmedAt, 444, 'confirmedAt preserved');
  assert.equal(st.wakeConfig.triggers.atMention, true, 'default triggers applied');
  assert.equal(clock.calls.length, 0, 'infinite default refresh consumes no clock');

  const explicit = { confirmedBy: 'ai', batchWindowMs: 999, lastWakeAt: 5 };
  st.wakeConfig = explicit;
  assert.equal(refresh(st), false, 'explicit config not refreshed');
  assert.equal(st.wakeConfig, explicit, 'explicit config identity preserved');
}));

test('refreshAllDefaultWakeConfigsV2 refreshes each default state only', () => withBridge((h) => {
  h.cfg.socialV2.wake = { batchWindowMs: 3333 };
  const refreshAll = api(h, 'refreshAllDefaultWakeConfigsV2');
  const a = h.getSocialV2State('private:123');
  const b = h.getSocialV2State('group:456');
  a.wakeConfig = { ...a.wakeConfig, batchWindowMs: 1, confirmedBy: 'default' };
  b.wakeConfig = { ...b.wakeConfig, batchWindowMs: 1, confirmedBy: 'admin' };
  const explicit = b.wakeConfig;
  assert.equal(refreshAll(), true, 'changed when a default state exists');
  assert.equal(a.wakeConfig.batchWindowMs, 3333, 'default state refreshed');
  assert.equal(b.wakeConfig, explicit, 'admin state identity preserved');
  assert.equal(b.wakeConfig.batchWindowMs, 1, 'admin state untouched');
}));

test('ensureWakeableV2 resets no-trigger configs, honors skipSave, saves otherwise', () => withBridge((h) => {
  h.cfg.socialV2.wake = { defaultMode: 'active', batchWindowMs: 4500 };
  const ensure = api(h, 'ensureWakeableV2');
  const st = h.getSocialV2State('private:123');
  const stateFile = path.join(h.temp, 'state', 'social-v2.json');
  const readState = () => { try { return fs.readFileSync(stateFile, 'utf8'); } catch { return null; } };
  const noTriggers = () => ({
    mode: 'diving',
    infinite: true,
    sleepUntil: null,
    triggers: { atMention: false, nameMention: false, question: false, poke: false, anyMessage: false, keywords: [], speakerIds: ['001', 'null'], probability: 0 },
    batchWindowMs: 1000,
    confirmedBy: 'ai',
  });

  st.wakeConfig = noTriggers();
  const beforeSkip = readState();
  ensure(st, { skipSave: true });
  assert.equal(st.wakeConfig.confirmedBy, 'default', 'no-trigger config reset');
  assert.equal(st.wakeConfig.mode, 'active', 'reset uses live default mode');
  assert.equal(st.wakeConfig.batchWindowMs, 4500, 'reset uses live default batch window');
  assert.deepEqual(st.wakeConfig.triggers.speakerIds, [], 'dirty speaker ids dropped');
  assert.equal(readState(), beforeSkip, 'skipSave leaves state file unchanged');

  st.wakeConfig = noTriggers();
  const beforeSave = readState();
  ensure(st);
  const afterSave = readState();
  assert.notEqual(afterSave, beforeSave, 'non-skipped reset persists state');
  assert.equal(JSON.parse(afterSave).conversations['private:123'].wakeConfig.confirmedBy, 'default', 'persisted reset config');
}));

test('ensureWakeableV2 does not reset wakeable configs and normalizes speaker ids in place', () => withBridge((h) => {
  h.cfg.socialV2.wake = { batchWindowMs: 4500 };
  const ensure = api(h, 'ensureWakeableV2');
  const st = h.getSocialV2State('group:456');
  const wakeable = {
    mode: 'diving',
    infinite: true,
    sleepUntil: null,
    triggers: { atMention: true, speakerIds: ['001', '123', 'x'] },
    batchWindowMs: 1000,
    confirmedBy: 'ai',
  };
  st.wakeConfig = wakeable;
  ensure(st, { skipSave: true });
  assert.equal(st.wakeConfig, wakeable, 'wakeable config identity preserved');
  assert.deepEqual(st.wakeConfig.triggers.speakerIds, ['123'], 'speaker ids normalized in place');
}));

test('scheduleWakeV2 stashes a bounded backlog while the conversation is busy', () => withBridge((h) => {
  const schedule = api(h, 'scheduleWakeV2');
  const st = h.getSocialV2State('private:123');
  st.lastUnreadSeq = 7;
  h.pendingWakeKeys.add('private:123');

  schedule('private:123', 'keyword:a', { seq: 1 });
  assert.equal(st.pendingWakeReasons.length, 1, 'busy wake stashed');
  assert.equal(st.pendingWakeReasons[0].reason, 'keyword:a', 'stashed reason');
  assert.equal(st.pendingWakeReasons[0].seq, 7, 'stashed seq follows lastUnreadSeq');
  schedule('private:123', 'keyword:a', { seq: 1 });
  assert.equal(st.pendingWakeReasons.length, 1, 'duplicate stash deduplicated');
  schedule('private:123', 'question', { seq: 2 });
  assert.equal(st.pendingWakeReasons.length, 2, 'distinct reason appended');
  assert.equal(st.pendingWakeTimer ?? null, null, 'no batch timer while busy');
  assert.equal(h.calls.prompts.length, 0, 'no prompt while busy');
  assert.equal(h.calls.sent.length, 0, 'no send while busy');

  for (let index = 0; index < 25; index += 1) schedule('private:123', `keyword:bulk-${index}`, { seq: 3 });
  assert.equal(st.pendingWakeReasons.length, 20, 'backlog capped at 20');
  assert.equal(st.pendingWakeReasons.at(-1).reason, 'keyword:bulk-24', 'newest backlog entry retained');
  assert.equal(st.pendingWakeReasons.some((item) => item.reason === 'keyword:a'), false, 'oldest entries dropped');
}));

test('scheduleWakeV2 upgrades by priority without downgrading or sending early', () => withBridge((h, clock) => {
  const priority = api(h, 'wakePriorityV2');
  api(h, 'scheduleWakeV2');
  const st = h.getSocialV2State('private:123');
  st.wakeConfig.batchWindowMs = 60000;

  h.scheduleWakeV2('private:123', 'keyword:kw', { seq: 1 });
  assert.equal(st.pendingWakeReason, 'keyword:kw', 'initial pending reason');
  assert.equal(st.pendingWakeSeq, 1, 'initial pending seq');

  h.scheduleWakeV2('private:123', 'atMention', { seq: 2 });
  assert.equal(st.pendingWakeReason, 'atMention', 'higher priority upgrades');
  assert.equal(st.pendingWakeSeq, 2, 'upgrade adopts new seq');

  h.scheduleWakeV2('private:123', 'question', { seq: 3 });
  assert.equal(st.pendingWakeReason, 'atMention', 'lower priority does not downgrade');
  assert.equal(st.pendingWakeSeq, 2, 'downgrade keeps seq');

  h.scheduleWakeV2('private:123', 'atMention', { seq: 4 });
  assert.equal(st.pendingWakeReason, 'atMention', 'equal priority does not re-upgrade');
  assert.equal(st.pendingWakeSeq, 2, 'equal priority keeps seq');

  assert.equal(st.pendingWakeTimer != null, true, 'one batch timer still pending');
  assert.equal(h.calls.prompts.length, 0, 'no prompt before batch window');
  assert.equal(h.calls.sent.length, 0, 'no QQ send before batch window');

  assert.equal(priority('keyword:kw'), 60, 'keyword priority');
  assert.equal(priority('atMention'), 90, 'atMention priority');
  assert.equal(priority('question'), 80, 'question priority');
  assert.equal(priority('unknown'), 0, 'unknown priority');
  assert.notEqual(typeof priority('constructor'), 'number', 'inherited constructor is not a priority');
  assert.notEqual(typeof priority('__proto__'), 'number', 'inherited __proto__ is not a priority');
}));
