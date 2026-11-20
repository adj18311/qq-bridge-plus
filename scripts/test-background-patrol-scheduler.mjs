import test from 'node:test';
import assert from 'node:assert/strict';

const PRODUCTION_MODULE_URL = new URL('../src/core/background-patrol-scheduler.mjs', import.meta.url);
const BEIJING_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const MICROTASK_SETTLE_ROUNDS = 40;

let productionModule = null;
let productionImportError = null;

try {
  productionModule = await import(PRODUCTION_MODULE_URL.href);
} catch (error) {
  productionImportError = error;
}

function missingSchedulerFeature(detail) {
  assert.fail('missing scheduler feature: src/core/background-patrol-scheduler.mjs must export PATROL_INTERVALS, isPatrolActiveTime and createBackgroundPatrolScheduler; ' + detail);
}

function loadSchedulerApi() {
  if (productionModule === null) {
    let detail = 'the module import failed without an error object';
    if (productionImportError) {
      detail = productionImportError.code
        ? productionImportError.code + ': ' + productionImportError.message
        : String(productionImportError.message || productionImportError);
    }
    missingSchedulerFeature(detail);
  }
  const api = productionModule;
  if (typeof api.createBackgroundPatrolScheduler !== 'function') {
    missingSchedulerFeature('createBackgroundPatrolScheduler is not an exported function');
  }
  if (typeof api.isPatrolActiveTime !== 'function') {
    missingSchedulerFeature('isPatrolActiveTime is not an exported function');
  }
  if (!api.PATROL_INTERVALS || typeof api.PATROL_INTERVALS !== 'object') {
    missingSchedulerFeature('PATROL_INTERVALS is not an exported object');
  }
  return api;
}

function beijing(year, month, day, hour, minute = 0, second = 0, millisecond = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - BEIJING_UTC_OFFSET_MS;
}

function toMs(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'object' && typeof value.getTime === 'function') {
    return value.getTime();
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : NaN;
}

async function settle() {
  for (let round = 0; round < MICROTASK_SETTLE_ROUNDS; round += 1) {
    await Promise.resolve();
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createRunController() {
  const pendingTasks = [];
  let active = 0;
  let maxActive = 0;
  function run() {
    const deferred = createDeferred();
    pendingTasks.push(deferred);
    active += 1;
    if (active > maxActive) {
      maxActive = active;
    }
    const release = () => {
      active -= 1;
    };
    deferred.promise.then(release, release);
    return deferred.promise;
  }
  return {
    run,
    get active() {
      return active;
    },
    get maxActive() {
      return maxActive;
    },
    get pendingCount() {
      return pendingTasks.length;
    },
    resolveOne(value) {
      const deferred = pendingTasks.shift();
      if (!deferred) {
        return false;
      }
      deferred.resolve(value);
      return true;
    },
    rejectOne(error) {
      const deferred = pendingTasks.shift();
      if (!deferred) {
        return false;
      }
      deferred.reject(error);
      return true;
    },
  };
}

function createFakeClock(startMs) {
  assert.equal(typeof startMs, 'number', 'the fake clock requires a numeric start time');
  let now = startMs;
  let sequence = 0;
  const timers = new Map();

  function normalizeTimerId(handle) {
    if (typeof handle === 'number') {
      return handle;
    }
    if (handle && typeof handle === 'object' && typeof handle.__fakeTimerId === 'number') {
      return handle.__fakeTimerId;
    }
    return null;
  }

  function setTimeoutFake(callback, delay) {
    assert.equal(typeof callback, 'function', 'clock.setTimeout() must receive a callback function');
    const parsedDelay = Number(delay);
    assert.ok(Number.isFinite(parsedDelay) && parsedDelay >= 0, 'clock.setTimeout() delay must be finite and non-negative, received ' + String(delay));
    sequence += 1;
    const id = sequence;
    const timer = { id, at: now + parsedDelay, fn: callback, cleared: false };
    const handle = {
      __fakeTimerId: id,
      unref() {
        return handle;
      },
      ref() {
        return handle;
      },
      hasRef() {
        return true;
      },
      valueOf() {
        return id;
      },
      [Symbol.toPrimitive]() {
        return id;
      },
    };
    timer.handle = handle;
    timers.set(id, timer);
    return handle;
  }

  function clearTimeoutFake(handle) {
    const id = normalizeTimerId(handle);
    if (id === null) {
      return;
    }
    const timer = timers.get(id);
    if (!timer) {
      return;
    }
    timer.cleared = true;
    timers.delete(id);
  }

  async function advance(deltaMs) {
    const delta = Number(deltaMs);
    assert.ok(Number.isFinite(delta) && delta >= 0, 'cannot advance the fake clock by ' + String(deltaMs));
    const target = now + delta;
    let guard = 0;
    for (;;) {
      guard += 1;
      assert.ok(guard <= 5000, 'the fake clock detected a runaway timer rescheduling loop');
      let nextTimer = null;
      for (const timer of timers.values()) {
        if (timer.at > target) {
          continue;
        }
        if (nextTimer === null || timer.at < nextTimer.at || (timer.at === nextTimer.at && timer.id < nextTimer.id)) {
          nextTimer = timer;
        }
      }
      if (nextTimer === null) {
        break;
      }
      timers.delete(nextTimer.id);
      now = nextTimer.at;
      const result = nextTimer.fn();
      if (result && typeof result.then === 'function') {
        result.catch(() => {});
      }
      await settle();
    }
    now = target;
    await settle();
  }

  function pending() {
    return [...timers.values()]
      .sort((left, right) => left.at - right.at || left.id - right.id)
      .map((timer) => ({ id: timer.id, at: timer.at, fn: timer.fn }));
  }

  return {
    now() {
      return now;
    },
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    advance,
    pending,
    pendingCount() {
      return timers.size;
    },
  };
}

function readIntervals(api) {
  const intervals = api.PATROL_INTERVALS;
  const result = {};
  for (const platform of ['tieba', 'xiaoheihe']) {
    const entry = intervals ? intervals[platform] : null;
    assert.ok(entry && Number.isFinite(entry.minMs) && Number.isFinite(entry.maxMs), 'missing scheduler feature: PATROL_INTERVALS.' + platform + ' must expose finite minMs and maxMs');
    assert.ok(entry.maxMs > entry.minMs, 'PATROL_INTERVALS.' + platform + '.maxMs must be greater than minMs');
    result[platform] = { min: entry.minMs, max: entry.maxMs };
  }
  return result;
}

function createHarness(options = {}) {
  const api = loadSchedulerApi();
  const start = typeof options.start === 'number' ? options.start : beijing(2026, 10, 24, 10, 0);
  const clock = createFakeClock(start);
  const runs = [];
  const events = [];
  const availabilityCalls = [];
  const availability = options.availability || (() => ({ qqBusy: false, dshAvailable: true, paused: false, modeAllowed: true }));
  const runImplementation = options.run || null;
  const onEvent = options.onEvent || null;
  const random = options.random || (() => 0);
  const scheduler = api.createBackgroundPatrolScheduler({
    clock,
    random,
    getAvailability() {
      availabilityCalls.push(clock.now());
      return availability();
    },
    run(task) {
      runs.push(task);
      const result = runImplementation ? runImplementation(task) : Promise.resolve();
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
      return result;
    },
    onEvent(event) {
      events.push(event);
      if (onEvent) {
        onEvent(event);
      }
    },
    ...(options.initialNextAt === undefined ? {} : { initialNextAt: options.initialNextAt }),
    ...(options.onPlan === undefined ? {} : { onPlan: options.onPlan }),
  });
  return { api, clock, scheduler, runs, events, availabilityCalls };
}

function readNextAt(snapshot) {
  const nextAt = snapshot.nextAt || {};
  return { tieba: toMs(nextAt.tieba), xiaoheihe: toMs(nextAt.xiaoheihe) };
}

function earliestPlanned(snapshot) {
  const planned = readNextAt(snapshot);
  const candidates = [];
  if (Number.isFinite(planned.tieba)) {
    candidates.push({ platform: 'tieba', at: planned.tieba });
  }
  if (Number.isFinite(planned.xiaoheihe)) {
    candidates.push({ platform: 'xiaoheihe', at: planned.xiaoheihe });
  }
  assert.ok(candidates.length > 0, 'expected the started scheduler to plan at least one upcoming opportunity');
  candidates.sort((left, right) => left.at - right.at);
  return candidates[0];
}

async function advanceToNextOpportunity(harness) {
  const target = earliestPlanned(harness.scheduler.snapshot());
  const delay = target.at - harness.clock.now();
  assert.ok(delay >= 0, 'the next planned opportunity must not be in the fake clock past');
  await harness.clock.advance(delay);
  return target;
}

function mutateSnapshot(snapshot, values) {
  try {
    snapshot.started = values.started;
    snapshot.runningPlatform = values.runningPlatform;
    snapshot.nextAt.tieba = values.tieba;
    snapshot.nextAt.xiaoheihe = values.xiaoheihe;
  } catch (error) {
    // A frozen snapshot cannot leak mutable internals either; isolation is verified by re-reading state.
  }
}

test('the scheduler module exposes the documented public API', () => {
  const api = loadSchedulerApi();
  assert.equal(typeof api.createBackgroundPatrolScheduler, 'function');
  assert.equal(typeof api.isPatrolActiveTime, 'function');
  assert.deepEqual(api.PATROL_INTERVALS, {
    tieba: { minMs: 3600000, maxMs: 7200000 },
    xiaoheihe: { minMs: 2700000, maxMs: 5400000 },
  });
});

test('creating a scheduler arms nothing and keeps the factory I/O free', () => {
  const harness = createHarness();
  assert.equal(harness.clock.pendingCount(), 0, 'the factory must not arm timers');
  assert.deepEqual(harness.availabilityCalls, [], 'the factory must not probe availability');
  assert.equal(harness.runs.length, 0);
  assert.deepEqual(harness.events, []);
  const snapshot = harness.scheduler.snapshot();
  assert.equal(snapshot.started, false);
  assert.equal(snapshot.runningPlatform, null);
  assert.equal(snapshot.nextAt.tieba, null);
  assert.equal(snapshot.nextAt.xiaoheihe, null);
});

test('isPatrolActiveTime implements the Beijing 07:00 inclusive to 23:00 exclusive window', () => {
  const api = loadSchedulerApi();
  const activeAt = api.isPatrolActiveTime;
  const cases = [
    ['06:59:59.999', beijing(2026, 10, 24, 6, 59, 59, 999), false],
    ['07:00:00.000', beijing(2026, 10, 24, 7, 0, 0, 0), true],
    ['07:00:00.001', beijing(2026, 10, 24, 7, 0, 0, 1), true],
    ['12:00:00.000', beijing(2026, 10, 24, 12, 0, 0, 0), true],
    ['22:59:59.999', beijing(2026, 10, 24, 22, 59, 59, 999), true],
    ['23:00:00.000', beijing(2026, 10, 24, 23, 0, 0, 0), false],
    ['23:00:00.001', beijing(2026, 10, 24, 23, 0, 0, 1), false],
    ['03:00:00.000', beijing(2026, 10, 24, 3, 0, 0, 0), false],
  ];
  for (const [label, timestamp, expected] of cases) {
    assert.equal(activeAt(new Date(timestamp)), expected, 'Date input at Beijing ' + label);
    assert.equal(activeAt(timestamp), expected, 'millisecond input at Beijing ' + label);
  }
});

test('isPatrolActiveTime depends on the absolute instant, not the host timezone', () => {
  const api = loadSchedulerApi();
  const activeAt = api.isPatrolActiveTime;
  const utcDayStart = Date.UTC(2026, 9, 23, 0, 0, 0, 0);
  for (let halfHours = 0; halfHours < 48; halfHours += 1) {
    const instant = utcDayStart + halfHours * 30 * 60 * 1000;
    const beijingHour = (new Date(instant).getUTCHours() + 8) % 24;
    const expected = beijingHour >= 7 && beijingHour < 23;
    assert.equal(activeAt(instant), expected, 'instant ' + new Date(instant).toISOString() + ' must be ' + (expected ? 'active' : 'inactive') + ' in Beijing time');
  }
});

test('an opportunity landing exactly on Beijing 07:00 starts the task', async () => {
  const harness = createHarness({ start: beijing(2026, 10, 24, 6, 15), random: () => 0 });
  harness.scheduler.start();
  const fired = await advanceToNextOpportunity(harness);
  assert.equal(fired.at, beijing(2026, 10, 24, 7, 0));
  assert.equal(fired.platform, 'xiaoheihe');
  assert.equal(harness.runs.length, 1, 'Beijing 07:00 must be inside the active window');
  assert.equal(harness.runs[0].platform, 'xiaoheihe');
  assert.equal(toMs(harness.runs[0].startedAt), fired.at);
  assert.equal(harness.events.filter((event) => event.type === 'started').length, 1);
  assert.equal(harness.events.filter((event) => event.type === 'skipped').length, 0);
});

test('an opportunity landing exactly on Beijing 23:00 is skipped as outside-hours without queueing', async () => {
  const harness = createHarness({ start: beijing(2026, 10, 24, 22, 15), random: () => 0 });
  const bounds = readIntervals(harness.api);
  harness.scheduler.start();
  const fired = await advanceToNextOpportunity(harness);
  assert.equal(fired.at, beijing(2026, 10, 24, 23, 0));
  assert.equal(fired.platform, 'xiaoheihe');
  assert.equal(harness.runs.length, 0, 'Beijing 23:00 is outside the active window');
  const skip = harness.events.find((event) => event.type === 'skipped');
  assert.ok(skip, 'expected a skipped event at the inactive boundary');
  assert.equal(skip.platform, 'xiaoheihe');
  assert.equal(skip.reason, 'outside-hours');
  assert.equal(toMs(skip.at), fired.at);
  const nextAt = toMs(harness.scheduler.snapshot().nextAt.xiaoheihe);
  assert.ok(Number.isFinite(nextAt), 'the skipped platform must plan its next opportunity');
  const gap = nextAt - fired.at;
  assert.ok(gap >= bounds.xiaoheihe.min && gap <= bounds.xiaoheihe.max, 'a skipped opportunity must schedule one fresh random interval, not an immediate retry');
});

test('start plans the documented minimum interval for both platforms when random returns 0', () => {
  const harness = createHarness({ random: () => 0 });
  const bounds = readIntervals(harness.api);
  harness.scheduler.start();
  const started = harness.scheduler.snapshot();
  assert.equal(started.started, true);
  assert.equal(started.runningPlatform, null);
  const planned = readNextAt(started);
  const now = harness.clock.now();
  assert.equal(planned.tieba - now, bounds.tieba.min, 'tieba opportunity must use minMs when random is 0');
  assert.equal(planned.xiaoheihe - now, bounds.xiaoheihe.min, 'xiaoheihe opportunity must use minMs when random is 0');
});

test('start plans near the documented maximum interval for both platforms when random returns 0.9999999', () => {
  const harness = createHarness({ random: () => 0.9999999 });
  const bounds = readIntervals(harness.api);
  harness.scheduler.start();
  const planned = readNextAt(harness.scheduler.snapshot());
  const now = harness.clock.now();
  for (const platform of ['tieba', 'xiaoheihe']) {
    const delay = planned[platform] - now;
    assert.ok(Number.isFinite(delay), platform + ' must have a finite planned delay');
    assert.ok(delay > bounds[platform].min, platform + ' delay must exceed minMs when random is 0.9999999');
    assert.ok(delay <= bounds[platform].max, platform + ' delay must not exceed maxMs');
    assert.ok(bounds[platform].max - delay < 2, platform + ' delay must use almost the whole documented range when random is 0.9999999');
  }
});

test('start is idempotent and a single opportunity dispatches a single task', async () => {
  const harness = createHarness();
  harness.scheduler.start();
  const firstPlan = readNextAt(harness.scheduler.snapshot());
  const plannedTimers = harness.clock.pendingCount();
  assert.ok(plannedTimers >= 1, 'start must plan at least one platform timer');
  assert.equal(harness.scheduler.snapshot().started, true);
  harness.scheduler.start();
  const secondPlan = readNextAt(harness.scheduler.snapshot());
  assert.equal(harness.clock.pendingCount(), plannedTimers, 'a repeated start must not add timers');
  assert.equal(secondPlan.tieba, firstPlan.tieba);
  assert.equal(secondPlan.xiaoheihe, firstPlan.xiaoheihe);
  await advanceToNextOpportunity(harness);
  assert.equal(harness.runs.length, 1, 'one opportunity must dispatch exactly one task');
  assert.equal(harness.events.filter((event) => event.type === 'started').length, 1);
});

test('each readiness skip cause is reported without running or queueing', async () => {
  const scenarios = [
    ['paused', 'paused', { qqBusy: false, dshAvailable: true, paused: true, modeAllowed: true }],
    ['qq busy', 'qq-busy', { qqBusy: true, dshAvailable: true, paused: false, modeAllowed: true }],
    ['dsh unavailable boolean false', 'dsh-unavailable', { qqBusy: false, dshAvailable: false, paused: false, modeAllowed: true }],
    ['dsh available missing', 'dsh-unavailable', { qqBusy: false, paused: false, modeAllowed: true }],
    ['dsh available numeric one', 'dsh-unavailable', { qqBusy: false, dshAvailable: 1, paused: false, modeAllowed: true }],
    ['dsh available string true', 'dsh-unavailable', { qqBusy: false, dshAvailable: 'true', paused: false, modeAllowed: true }],
    ['mode disabled boolean false', 'mode-disabled', { qqBusy: false, dshAvailable: true, paused: false, modeAllowed: false }],
    ['mode allowed missing', 'mode-disabled', { qqBusy: false, dshAvailable: true, paused: false }],
    ['mode allowed numeric one', 'mode-disabled', { qqBusy: false, dshAvailable: true, paused: false, modeAllowed: 1 }],
  ];
  for (const [label, expectedReason, availability] of scenarios) {
    const harness = createHarness({ availability: () => ({ ...availability }) });
    const bounds = readIntervals(harness.api);
    harness.scheduler.start();
    const fired = await advanceToNextOpportunity(harness);
    assert.equal(harness.runs.length, 0, label + ': a skipped opportunity must not run');
    const skip = harness.events.find((event) => event.type === 'skipped');
    assert.ok(skip, label + ': expected a skipped event');
    assert.equal(skip.reason, expectedReason, label + ': unexpected skip reason');
    assert.equal(skip.platform, fired.platform, label + ': the skip must report the firing platform');
    assert.equal(toMs(skip.at), fired.at, label + ': the skip must report the firing time');
    const nextAt = toMs(harness.scheduler.snapshot().nextAt[fired.platform]);
    assert.ok(Number.isFinite(nextAt), label + ': the skipped platform must keep scheduling');
    const gap = nextAt - fired.at;
    assert.ok(gap >= bounds[fired.platform].min && gap <= bounds[fired.platform].max, label + ': a skip must schedule one fresh interval, not an immediate retry');
    harness.scheduler.stop();
  }
});

test('availability errors are reported as skips and do not stop later opportunities', async () => {
  let availabilityBroken = true;
  const harness = createHarness({
    availability: () => {
      if (availabilityBroken) {
        throw new Error('availability-probe-exploded');
      }
      return { qqBusy: false, dshAvailable: true, paused: false, modeAllowed: true };
    },
  });
  harness.scheduler.start();
  await advanceToNextOpportunity(harness);
  assert.equal(harness.runs.length, 0);
  const skip = harness.events.find((event) => event.type === 'skipped');
  assert.ok(skip, 'expected an availability-error skip');
  assert.equal(skip.reason, 'availability-error');
  assert.ok(!JSON.stringify(harness.events).includes('availability-probe-exploded'), 'events must not expose raw availability errors');
  availabilityBroken = false;
  const second = await advanceToNextOpportunity(harness);
  assert.equal(harness.runs.length, 1, 'scheduling must continue after an availability error');
  assert.equal(harness.runs[0].platform, second.platform);
});

test('a pending run holds a global single-flight lease across both platforms', async () => {
  const controller = createRunController();
  const leasesSeenByRun = [];
  let harness = null;
  harness = createHarness({
    run: (task) => {
      leasesSeenByRun.push(harness.scheduler.snapshot().runningPlatform);
      return controller.run(task);
    },
  });
  const bounds = readIntervals(harness.api);
  harness.scheduler.start();
  const plannedAtStart = readNextAt(harness.scheduler.snapshot());
  const first = await advanceToNextOpportunity(harness);
  assert.equal(first.platform, 'xiaoheihe');
  assert.equal(harness.runs.length, 1);
  assert.deepEqual(leasesSeenByRun, ['xiaoheihe'], 'the global running lease must be set before run executes');
  assert.equal(harness.scheduler.snapshot().runningPlatform, 'xiaoheihe');
  assert.equal(toMs(harness.runs[0].startedAt), first.at);
  const startedEvent = harness.events.find((event) => event.type === 'started');
  assert.ok(startedEvent, 'expected a started event');
  assert.equal(startedEvent.platform, 'xiaoheihe');
  assert.equal(toMs(startedEvent.at), first.at);
  assert.equal(controller.active, 1);
  const secondAt = plannedAtStart.tieba;
  await harness.clock.advance(secondAt - harness.clock.now());
  assert.equal(harness.runs.length, 1, 'no overlapping task may start while the lease is held');
  const busySkip = harness.events.find((event) => event.type === 'skipped' && event.platform === 'tieba');
  assert.ok(busySkip, 'the other platform must be skipped while the task runs');
  assert.equal(busySkip.reason, 'background-busy');
  assert.equal(harness.scheduler.snapshot().runningPlatform, 'xiaoheihe');
  assert.equal(harness.events.filter((event) => event.type === 'completed').length, 0, 'a task that is still running must not be reported as completed');
  const tiebaNext = toMs(harness.scheduler.snapshot().nextAt.tieba);
  assert.ok(Number.isFinite(tiebaNext), 'the busy-skipped platform must plan its next opportunity');
  const busyGap = tiebaNext - secondAt;
  assert.ok(busyGap >= bounds.tieba.min && busyGap <= bounds.tieba.max, 'a busy skip must schedule one fresh interval, not an immediate retry');
  controller.resolveOne('finished');
  await settle();
  assert.equal(harness.scheduler.snapshot().runningPlatform, null, 'settling the whole task must release the lease');
  assert.equal(controller.active, 0);
  assert.equal(harness.events.filter((event) => event.type === 'completed' && event.platform === 'xiaoheihe').length, 1);
  assert.equal(controller.maxActive, 1, 'tasks must never overlap');
  await advanceToNextOpportunity(harness);
  assert.equal(harness.runs.length, 2, 'the scheduler must keep planning after a completed task');
});

test('a synchronously throwing run is reported as failed, leaks no raw error and releases the lease', async () => {
  const runs = [];
  let callCount = 0;
  const harness = createHarness({
    run(task) {
      runs.push(task);
      callCount += 1;
      if (callCount === 1) {
        throw new Error('sync-run-secret');
      }
      return Promise.resolve();
    },
  });
  harness.scheduler.start();
  const first = await advanceToNextOpportunity(harness);
  assert.equal(runs.length, 1);
  assert.equal(harness.scheduler.snapshot().runningPlatform, null, 'a synchronous throw must release its own lease');
  const failed = harness.events.find((event) => event.type === 'failed');
  assert.ok(failed, 'a synchronous throw must be reported as a failed event');
  assert.equal(failed.platform, first.platform);
  assert.ok(!JSON.stringify(harness.events).includes('sync-run-secret'), 'failed events must not include raw callback errors');
  for (const event of harness.events) {
    assert.ok(!Object.prototype.hasOwnProperty.call(event, 'error'), 'events must not carry raw error objects');
  }
  await advanceToNextOpportunity(harness);
  assert.equal(runs.length, 2, 'the released lease must allow the next planned opportunity');
});

test('an asynchronous run rejection is reported as failed, leaks no raw error and releases the lease', async () => {
  const runs = [];
  let callCount = 0;
  const harness = createHarness({
    run(task) {
      runs.push(task);
      callCount += 1;
      if (callCount === 1) {
        return Promise.reject(new Error('async-run-secret'));
      }
      return Promise.resolve();
    },
  });
  harness.scheduler.start();
  const first = await advanceToNextOpportunity(harness);
  assert.equal(runs.length, 1);
  assert.equal(harness.scheduler.snapshot().runningPlatform, null, 'an asynchronous rejection must release its own lease');
  const failed = harness.events.find((event) => event.type === 'failed');
  assert.ok(failed, 'an asynchronous rejection must be reported as a failed event');
  assert.equal(failed.platform, first.platform);
  assert.ok(!JSON.stringify(harness.events).includes('async-run-secret'), 'failed events must not include raw callback errors');
  await advanceToNextOpportunity(harness);
  assert.equal(runs.length, 2, 'the released lease must allow the next planned opportunity');
});

test('stop clears planned timers and stale callbacks cannot dispatch or rearm', async () => {
  const harness = createHarness();
  harness.scheduler.start();
  const plannedTimers = harness.clock.pendingCount();
  assert.ok(plannedTimers >= 1, 'start must plan at least one platform timer');
  const stale = harness.clock.pending();
  assert.equal(stale.length, plannedTimers);
  harness.scheduler.stop();
  assert.equal(harness.clock.pendingCount(), 0, 'stop must clear every planned timer');
  for (const timer of stale) {
    timer.fn();
  }
  assert.equal(harness.runs.length, 0, 'cancelled callbacks must not dispatch a task');
  assert.equal(harness.clock.pendingCount(), 0, 'cancelled callbacks must not rearm timers');
  harness.scheduler.start();
  const freshTimers = harness.clock.pendingCount();
  assert.ok(freshTimers >= 1, 'restart must plan platform timers again');
  for (const timer of stale) {
    timer.fn();
  }
  assert.equal(harness.runs.length, 0, 'stale callbacks from before stop must not dispatch after a restart');
  assert.equal(harness.clock.pendingCount(), freshTimers, 'stale callbacks must not rearm timers next to the fresh plan');
  await advanceToNextOpportunity(harness);
  assert.equal(harness.runs.length, 1, 'the fresh plan must still work after stale callbacks were invoked');
});

test('stop then start while a task runs blocks overlap until its promise settles', async () => {
  const controller = createRunController();
  const harness = createHarness({ run: (task) => controller.run(task) });
  harness.scheduler.start();
  const timersBeforeStop = harness.clock.pendingCount();
  assert.ok(timersBeforeStop >= 1, 'start must plan at least one platform timer');
  const first = await advanceToNextOpportunity(harness);
  assert.equal(first.platform, 'xiaoheihe');
  assert.equal(harness.scheduler.snapshot().runningPlatform, 'xiaoheihe');
  harness.scheduler.stop();
  const stoppedSnapshot = harness.scheduler.snapshot();
  assert.equal(stoppedSnapshot.started, false);
  assert.equal(stoppedSnapshot.nextAt.tieba, null);
  assert.equal(stoppedSnapshot.nextAt.xiaoheihe, null);
  assert.equal(stoppedSnapshot.runningPlatform, 'xiaoheihe', 'stop must not cancel an in-flight task');
  assert.equal(harness.clock.pendingCount(), 0, 'stop must clear every planned timer');
  harness.scheduler.start();
  assert.equal(harness.scheduler.snapshot().started, true);
  assert.equal(harness.clock.pendingCount(), timersBeforeStop, 'restart must plan the same number of platform timers');
  const busyOpportunity = await advanceToNextOpportunity(harness);
  assert.equal(harness.runs.length, 1, 'restart must not overlap the still-running task');
  const busySkip = harness.events.find((event) => event.type === 'skipped' && event.platform === busyOpportunity.platform);
  assert.ok(busySkip);
  assert.equal(busySkip.reason, 'background-busy');
  assert.equal(controller.maxActive, 1);
  controller.resolveOne('finished');
  await settle();
  assert.equal(harness.scheduler.snapshot().runningPlatform, null);
  await advanceToNextOpportunity(harness);
  assert.equal(harness.runs.length, 2, 'the released lease must allow the next planned opportunity');
  assert.equal(controller.maxActive, 1, 'tasks must never overlap');
});

test('an observer that throws does not interrupt scheduling or lease release', async () => {
  const controller = createRunController();
  const harness = createHarness({
    run: (task) => controller.run(task),
    onEvent: () => {
      throw new Error('observer-exploded');
    },
  });
  harness.scheduler.start();
  const first = await advanceToNextOpportunity(harness);
  assert.equal(harness.runs.length, 1, 'the task must start even though the observer throws');
  assert.equal(harness.scheduler.snapshot().runningPlatform, first.platform);
  controller.resolveOne('ok');
  await settle();
  assert.equal(harness.scheduler.snapshot().runningPlatform, null, 'a throwing observer must not strand the lease');
  assert.ok(Number.isFinite(toMs(harness.scheduler.snapshot().nextAt[first.platform])), 'planning must continue with a throwing observer');
  await advanceToNextOpportunity(harness);
  assert.equal(harness.runs.length, 2, 'later opportunities must still be dispatched');
});

test('snapshot is detached from scheduler internals and stopped state is empty', () => {
  const harness = createHarness();
  const idle = harness.scheduler.snapshot();
  mutateSnapshot(idle, { started: true, runningPlatform: 'tampered', tieba: 1, xiaoheihe: 2 });
  const idleAgain = harness.scheduler.snapshot();
  assert.equal(idleAgain.started, false);
  assert.equal(idleAgain.runningPlatform, null);
  assert.equal(idleAgain.nextAt.tieba, null);
  assert.equal(idleAgain.nextAt.xiaoheihe, null);
  harness.scheduler.start();
  const live = harness.scheduler.snapshot();
  const expected = readNextAt(live);
  assert.ok(Number.isFinite(expected.tieba));
  assert.ok(Number.isFinite(expected.xiaoheihe));
  mutateSnapshot(live, { started: false, runningPlatform: 'tampered', tieba: -1, xiaoheihe: -2 });
  const liveAgain = harness.scheduler.snapshot();
  assert.equal(liveAgain.started, true);
  assert.equal(liveAgain.runningPlatform, null);
  assert.equal(toMs(liveAgain.nextAt.tieba), expected.tieba);
  assert.equal(toMs(liveAgain.nextAt.xiaoheihe), expected.xiaoheihe);
  harness.scheduler.stop();
  const stopped = harness.scheduler.snapshot();
  assert.equal(stopped.started, false);
  assert.equal(stopped.runningPlatform, null);
  assert.equal(stopped.nextAt.tieba, null);
  assert.equal(stopped.nextAt.xiaoheihe, null);
});

test('task-86 E1：initialNextAt 只接受未来时间（恢复 nextAt）；过期不补；onPlan 汇报排期', async () => {
  const start = beijing(2026, 10, 24, 10, 0);
  const future = start + 10 * 60 * 1000;
  const plans = [];
  const harness = createHarness({
    start,
    initialNextAt: { tieba: future, xiaoheihe: null },
    onPlan(plan) { plans.push(plan); },
  });
  harness.scheduler.start();
  const snapshot = harness.scheduler.snapshot();
  assert.equal(snapshot.nextAt.tieba, future, '未来持久 nextAt 必须恢复（精确）');
  assert.equal(snapshot.nextAt.xiaoheihe, start + 45 * 60 * 1000, '无 seed 的平台按随机区间规划');
  assert.deepEqual(plans.map((plan) => plan.platform).sort(), ['tieba', 'xiaoheihe']);
  const tiebaPlan = plans.find((plan) => plan.platform === 'tieba');
  assert.equal(tiebaPlan.at, future);
  assert.equal(tiebaPlan.delayMs, 10 * 60 * 1000);

  const expiredPlans = [];
  const expired = createHarness({
    start,
    initialNextAt: { tieba: start - 1000, xiaoheihe: start - 1 },
    onPlan(plan) { expiredPlans.push(plan); },
  });
  expired.scheduler.start();
  const expiredSnapshot = expired.scheduler.snapshot();
  assert.equal(expiredSnapshot.nextAt.tieba, start + 60 * 60 * 1000, '过期 nextAt 不得补执行');
  assert.equal(expiredSnapshot.nextAt.xiaoheihe, start + 45 * 60 * 1000, '过期 nextAt 不得补执行');
  assert.ok(expiredPlans.every((plan) => plan.at > start));
});

test('task-86 E1：onPlan 抛错不影响调度（异常吞掉，timer 照常）', async () => {
  const start = beijing(2026, 10, 24, 10, 0);
  const harness = createHarness({
    start,
    onPlan() { throw new Error('persist failed'); },
  });
  harness.scheduler.start();
  const snapshot = harness.scheduler.snapshot();
  assert.equal(snapshot.nextAt.tieba, start + 60 * 60 * 1000);
  assert.equal(snapshot.started, true);
});

test('E1-fix2 F3：isPlatformEnabled 过滤 disabled 平台机会；全 disabled 不 run', async () => {
  const api = loadSchedulerApi();
  const startedAt = beijing(2026, 10, 26, 10, 0, 0);
  const clock = createFakeClock(startedAt);
  const runs = [];
  const skipped = [];
  const scheduler = api.createBackgroundPatrolScheduler({
    clock,
    random: () => 0,
    isPlatformEnabled: (platform) => platform === 'xiaoheihe',
    getAvailability: () => ({ qqBusy: false, dshAvailable: true, paused: false, modeAllowed: true }),
    run: ({ platform }) => { runs.push(platform); },
    onEvent: (event) => { if (event.type === 'skipped') skipped.push(event.reason); },
  });
  scheduler.start();
  await clock.advance(45 * 60 * 1000);
  await settle();
  assert.deepEqual(runs, ['xiaoheihe'], '只允许 xiaoheihe 产生机会');
  assert.ok(!skipped.includes('platform-disabled'), 'disabled 平台不应重复产生机会');
  scheduler.stop();

  const allDisabled = api.createBackgroundPatrolScheduler({
    clock: createFakeClock(startedAt),
    random: () => 0,
    isPlatformEnabled: () => false,
    getAvailability: () => ({ qqBusy: false, dshAvailable: true, paused: false, modeAllowed: true }),
    run: () => { runs.push('unexpected'); },
  });
  allDisabled.start();
  await settle();
  assert.deepEqual(runs, ['xiaoheihe'], '全 disabled 不得 run');
  allDisabled.stop();
  assert.deepEqual(allDisabled.snapshot().nextAt, { tieba: null, xiaoheihe: null });
});
