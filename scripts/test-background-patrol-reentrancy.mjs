import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundPatrolScheduler } from '../src/core/background-patrol-scheduler.mjs';

const ACTIVE_AT = Date.UTC(2026, 0, 5, 2, 0, 0); // 北京时间 10:00

function createFakeClock(startAt) {
  let current = startAt;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.set(id, { fn, due: current + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    runNext() {
      let pickedId = null;
      let picked = null;
      for (const [id, timer] of timers) {
        if (picked === null || timer.due < picked.due) {
          pickedId = id;
          picked = timer;
        }
      }
      if (picked === null) throw new Error('no pending timer');
      timers.delete(pickedId);
      current = Math.max(current, picked.due);
      picked.fn();
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const seq = (values) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
};

function harness(overrides = {}) {
  const clock = createFakeClock(ACTIVE_AT);
  const scheduler = createBackgroundPatrolScheduler({
    clock,
    random: seq([0, 0.999]),
    getAvailability: () => ({ dshAvailable: true, modeAllowed: true }),
    run: () => Promise.resolve(),
    onEvent: () => {},
    ...overrides,
  });
  return { clock, scheduler };
}

test('background patrol reentrancy: getAvailability stop voids the pending run', () => {
  const events = [];
  let runs = 0;
  let scheduler = null;
  const h = harness({
    getAvailability: () => {
      scheduler.stop();
      return { dshAvailable: true, modeAllowed: true };
    },
    run: () => {
      runs += 1;
      return Promise.resolve();
    },
    onEvent: (event) => events.push(event),
  });
  scheduler = h.scheduler;
  scheduler.start();
  h.clock.runNext();
  assert.equal(runs, 0);
  assert.deepEqual(events.filter((event) => event.type === 'started'), []);
  assert.equal(scheduler.snapshot().started, false);
  assert.equal(h.clock.pending(), 0);
});

test('background patrol reentrancy: timer reentry from getAvailability cannot start a second run', async () => {
  const events = [];
  const runCalls = [];
  let availabilityCalls = 0;
  let release = null;
  const h = harness({
    getAvailability: () => {
      availabilityCalls += 1;
      if (availabilityCalls === 1) h.clock.runNext();
      return { dshAvailable: true, modeAllowed: true };
    },
    run: ({ platform }) => {
      runCalls.push(platform);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    onEvent: (event) => events.push(event),
  });
  h.scheduler.start();
  h.clock.runNext();
  assert.deepEqual(runCalls, ['xiaoheihe']);
  assert.equal(h.scheduler.snapshot().runningPlatform, 'xiaoheihe');
  assert.deepEqual(events.filter((event) => event.type === 'skipped').map((event) => event.reason), ['background-busy']);
  release();
  await tick();
  assert.equal(h.scheduler.snapshot().runningPlatform, null);
});

test('background patrol reentrancy: observer stop/start from started keeps the lease', async () => {
  const events = [];
  const runCalls = [];
  let stopSeenByRun = null;
  let restarting = false;
  let release = null;
  const h = harness({
    run: ({ platform }) => {
      stopSeenByRun = restarting;
      runCalls.push(platform);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'started' && !restarting) {
        restarting = true;
        h.scheduler.stop();
        h.scheduler.start();
      }
    },
  });
  h.scheduler.start();
  h.clock.runNext();
  assert.deepEqual(runCalls, ['tieba']);
  assert.equal(stopSeenByRun, false);
  assert.equal(h.scheduler.snapshot().started, true);
  h.clock.runNext();
  assert.deepEqual(runCalls, ['tieba']);
  assert.equal(events.filter((event) => event.type === 'started').length, 1);
  assert.ok(events.some((event) => event.type === 'skipped' && event.reason === 'background-busy'));
  release();
  await tick();
  assert.equal(h.scheduler.snapshot().runningPlatform, null);
  assert.equal(h.scheduler.snapshot().started, true);
});

test('background patrol reentrancy: synchronous run reentry stays blocked and a throwing run frees its lease', async () => {
  const events = [];
  const runCalls = [];
  const h = harness({
    run: ({ platform }) => {
      runCalls.push(platform);
      if (platform === 'tieba') {
        h.clock.runNext();
        throw new Error('sync boom');
      }
      return Promise.resolve();
    },
    onEvent: (event) => events.push(event),
  });
  h.scheduler.start();
  h.clock.runNext();
  assert.deepEqual(runCalls, ['tieba']);
  assert.ok(events.some((event) => event.type === 'skipped' && event.reason === 'background-busy'));
  assert.equal(h.scheduler.snapshot().runningPlatform, null);
  h.clock.runNext();
  assert.deepEqual(runCalls, ['tieba', 'xiaoheihe']);
  await tick();
});

test('background patrol factory rejects missing dependencies', () => {
  assert.throws(() => createBackgroundPatrolScheduler(), TypeError);
  assert.throws(() => createBackgroundPatrolScheduler({ run: () => {} }), TypeError);
  assert.throws(() => createBackgroundPatrolScheduler({ getAvailability: () => ({}) }), TypeError);
});

