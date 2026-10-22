// DSH 连接恢复（NodeApiClient.refreshDesktopEndpoint）与新连接监视器
// （src/core/dsh-connection-watch.mjs）的测试。
// 全部用例只使用 fake 计时器、临时 DSH_HOME 和本地 fake fetch，不接触真实 DSH/QQ。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeApiClient } from '../src/dsh-client.js';

const WATCH_MODULE_URL = new URL('../src/core/dsh-connection-watch.mjs', import.meta.url);

async function loadCreateDshConnectionWatch() {
  let mod;
  try {
    mod = await import(WATCH_MODULE_URL);
  } catch (error) {
    assert.fail(`src/core/dsh-connection-watch.mjs must exist and be importable: ${error?.message ?? error}`);
  }
  assert.equal(typeof mod.createDshConnectionWatch, 'function', 'createDshConnectionWatch must be exported');
  return mod.createDshConnectionWatch;
}

// 冲干净所有微任务/宏任务链，避免测试依赖真实时间。
async function flushTasks(turns = 10) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// 手动计时器：监视器只能通过注入的 setTimeoutFn/clearTimeoutFn 安排重试，
// 测试用 advance() 精确推进时间，用 pendingDelays() 断言待执行计时器数量。
function createFakeClock() {
  let current = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    get now() {
      return current;
    },
    setTimeoutFn(fn, delay = 0) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { id, fn, at: current + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
    pendingDelays() {
      return [...timers.values()]
        .map((timer) => timer.at - current)
        .sort((left, right) => left - right);
    },
    async advance(ms) {
      const target = current + ms;
      for (let guard = 0; guard < 1000; guard += 1) {
        let due = null;
        for (const timer of timers.values()) {
          if (timer.at > target) continue;
          if (!due || timer.at < due.at || (timer.at === due.at && timer.id < due.id)) due = timer;
        }
        if (!due) break;
        timers.delete(due.id);
        current = due.at;
        due.fn();
        await flushTasks();
      }
      current = target;
      await flushTasks();
    },
  };
}

function createWatcherHarness(createDshConnectionWatch, options = {}) {
  const clock = createFakeClock();
  const calls = [];
  const resolvers = [];
  const errors = [];
  const watch = createDshConnectionWatch({
    check: () => {
      calls.push(clock.now);
      if (options.check) return options.check();
      return new Promise((resolve) => resolvers.push(resolve));
    },
    readyDelayMs: options.readyDelayMs ?? 5000,
    retryDelayMs: options.retryDelayMs ?? 2000,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onError: options.onError ?? ((error) => errors.push(error)),
  });
  return { clock, watch, calls, resolvers, errors };
}

test('watch: start checks immediately and success waits readyDelayMs before the next check', async () => {
  const createDshConnectionWatch = await loadCreateDshConnectionWatch();
  const harness = createWatcherHarness(createDshConnectionWatch, { check: async () => true });
  harness.watch.start();
  await flushTasks();
  assert.deepEqual(harness.calls, [0], 'start must run the first check immediately');
  assert.deepEqual(harness.clock.pendingDelays(), [5000], 'a healthy connection must wait readyDelayMs before the next check');
  await harness.clock.advance(4999);
  assert.equal(harness.calls.length, 1, 'must not check before readyDelayMs elapses');
  await harness.clock.advance(1);
  assert.deepEqual(harness.calls, [0, 5000]);
  harness.watch.stop();
});

test('watch: failure retries after retryDelayMs instead of an overlapping interval', async () => {
  const createDshConnectionWatch = await loadCreateDshConnectionWatch();
  let healthy = false;
  const harness = createWatcherHarness(createDshConnectionWatch, { check: async () => healthy });
  harness.watch.start();
  await flushTasks();
  assert.deepEqual(harness.calls, [0]);
  assert.deepEqual(harness.clock.pendingDelays(), [2000], 'a failed check must schedule a retry after retryDelayMs');
  await harness.clock.advance(1999);
  assert.equal(harness.calls.length, 1);
  await harness.clock.advance(1);
  assert.deepEqual(harness.calls, [0, 2000]);
  await harness.clock.advance(2000);
  assert.deepEqual(harness.calls, [0, 2000, 4000], 'failures keep retrying at retryDelayMs');
  healthy = true;
  await harness.clock.advance(2000);
  assert.deepEqual(harness.calls, [0, 2000, 4000, 6000]);
  assert.deepEqual(harness.clock.pendingDelays(), [5000], 'a recovered connection goes back to readyDelayMs');
  harness.watch.stop();
});

test('watch: defaults to a 5s ready delay and a 2s retry delay', async () => {
  const createDshConnectionWatch = await loadCreateDshConnectionWatch();
  const clock = createFakeClock();
  let healthy = false;
  const watch = createDshConnectionWatch({
    check: async () => healthy,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  watch.start();
  await flushTasks();
  assert.deepEqual(clock.pendingDelays(), [2000], 'default retryDelayMs must be 2000');
  healthy = true;
  await clock.advance(2000);
  assert.deepEqual(clock.pendingDelays(), [5000], 'default readyDelayMs must be 5000');
  watch.stop();
});

test('watch: advancing timers while a check is in flight never overlaps checks', async () => {
  const createDshConnectionWatch = await loadCreateDshConnectionWatch();
  const harness = createWatcherHarness(createDshConnectionWatch);
  harness.watch.start();
  await flushTasks();
  assert.equal(harness.calls.length, 1);
  await harness.clock.advance(60000);
  assert.equal(harness.calls.length, 1, 'an in-flight check must never be restarted by time passing');
  assert.deepEqual(harness.clock.pendingDelays(), [], 'no timer is scheduled while a check is pending');
  harness.resolvers[0](true);
  await flushTasks();
  assert.deepEqual(harness.clock.pendingDelays(), [5000]);
  await harness.clock.advance(5000);
  assert.equal(harness.calls.length, 2);
  assert.deepEqual(harness.clock.pendingDelays(), [], 'the second check is still in flight');
  harness.watch.stop();
  harness.resolvers[1](false);
  await flushTasks();
  assert.equal(harness.calls.length, 2, 'a stopped watch never reacts to a late result');
});

test('watch: start is idempotent and does not stack timers', async () => {
  const createDshConnectionWatch = await loadCreateDshConnectionWatch();
  const harness = createWatcherHarness(createDshConnectionWatch);
  harness.watch.start();
  harness.watch.start();
  harness.watch.start();
  await flushTasks();
  assert.equal(harness.calls.length, 1, 'repeated start calls must not duplicate the in-flight check');
  assert.deepEqual(harness.clock.pendingDelays(), []);
  harness.resolvers[0](true);
  await flushTasks();
  assert.deepEqual(harness.clock.pendingDelays(), [5000]);
  harness.watch.start();
  harness.watch.start();
  assert.deepEqual(harness.clock.pendingDelays(), [5000], 'further start calls must not add timers');
  await harness.clock.advance(5000);
  assert.equal(harness.calls.length, 2);
  harness.watch.stop();
  harness.resolvers[1](true);
  await flushTasks();
});

test('watch: stop cancels the next scheduled check', async () => {
  const createDshConnectionWatch = await loadCreateDshConnectionWatch();
  const harness = createWatcherHarness(createDshConnectionWatch, { check: async () => true });
  harness.watch.start();
  await flushTasks();
  assert.deepEqual(harness.calls, [0]);
  assert.deepEqual(harness.clock.pendingDelays(), [5000]);
  harness.watch.stop();
  assert.deepEqual(harness.clock.pendingDelays(), [], 'stop must clear the pending timer');
  await harness.clock.advance(60000);
  assert.deepEqual(harness.calls, [0], 'a stopped watch must never schedule another check');
});

test('watch: stop leaves an in-flight check alone but prevents its rescheduling', async () => {
  const createDshConnectionWatch = await loadCreateDshConnectionWatch();
  const harness = createWatcherHarness(createDshConnectionWatch);
  harness.watch.start();
  await flushTasks();
  assert.equal(harness.calls.length, 1);
  harness.watch.stop();
  await harness.clock.advance(60000);
  assert.equal(harness.calls.length, 1);
  harness.resolvers[0](false);
  await flushTasks();
  assert.deepEqual(harness.clock.pendingDelays(), [], 'a late result must not schedule a retry after stop');
  await harness.clock.advance(60000);
  assert.equal(harness.calls.length, 1);
});

test('watch: stop/start generation prevents a stale result from scheduling work', async () => {
  const createDshConnectionWatch = await loadCreateDshConnectionWatch();
  const harness = createWatcherHarness(createDshConnectionWatch);
  harness.watch.start();
  await flushTasks();
  assert.equal(harness.calls.length, 1);
  harness.watch.stop();
  harness.watch.start();
  await flushTasks();
  assert.equal(harness.calls.length, 1, 'restart must not overlap the check still in flight');
  assert.deepEqual(harness.clock.pendingDelays(), [], 'nothing is scheduled while the old check is in flight');
  harness.resolvers[0](true);
  await flushTasks();
  assert.equal(harness.calls.length, 2, 'the new generation must start immediately once the stale check settles');
  assert.deepEqual(harness.clock.pendingDelays(), [], 'a result from the previous generation must not schedule');
  await harness.clock.advance(60000);
  assert.equal(harness.calls.length, 2, 'a stale result must never trigger extra checks');
  harness.resolvers[1](false);
  await flushTasks();
  assert.deepEqual(harness.clock.pendingDelays(), [2000], 'the current generation still schedules its retry');
  await harness.clock.advance(2000);
  assert.equal(harness.calls.length, 3);
  harness.watch.stop();
  harness.resolvers[2](true);
  await flushTasks();
  assert.deepEqual(harness.clock.pendingDelays(), [], 'a stopped watch must not schedule from a late result');
});

test('watch: a throwing check and a throwing onError do not stop the retry loop', async () => {
  const createDshConnectionWatch = await loadCreateDshConnectionWatch();
  const errors = [];
  const harness = createWatcherHarness(createDshConnectionWatch, {
    check: async () => {
      throw new Error('probe exploded');
    },
    onError: (error) => {
      errors.push(error);
      throw new Error('observer exploded');
    },
  });
  harness.watch.start();
  await flushTasks();
  assert.equal(harness.calls.length, 1);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]?.message ?? errors[0]), /probe exploded/);
  assert.deepEqual(harness.clock.pendingDelays(), [2000], 'a rejected check must still schedule a retry');
  await harness.clock.advance(2000);
  assert.equal(harness.calls.length, 2);
  assert.equal(errors.length, 2, 'a throwing onError must not break later checks');
  harness.watch.stop();
});

// ==== NodeApiClient.refreshDesktopEndpoint ====

async function isolateDshHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-connection-watch-'));
  const previousHome = process.env.DSH_HOME;
  const previousFetch = globalThis.fetch;
  process.env.DSH_HOME = dir;
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function readEnvelope(init) {
  return JSON.parse(init.body);
}

function namespacesResponse(envelope, namespaces) {
  return Response.json({
    type: 'server-response',
    rpcId: envelope.rpcId,
    result: { ok: true, value: { namespaces } },
  });
}

test('desktop recovery probes candidates with qq-mode and keeps desired follows', async (t) => {
  await isolateDshHome(t);
  const checked = [];
  const diagnostics = [];
  const discoveries = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    checked.push(url.origin);
    if (url.port === '41001') throw new Error('probe exploded token=super-secret');
    const envelope = readEnvelope(init);
    const namespaces = url.port === '41002' ? [{ ns: 'qq-mode' }] : [{ ns: 'unrelated' }];
    return namespacesResponse(envelope, namespaces);
  };
  const api = new NodeApiClient('http://127.0.0.1:19387', 1000, {
    desktopRecoveryTimeoutMs: 1000,
    discoverDesktopOrigins: async (options) => {
      discoveries.push(options);
      return ['https://remote.invalid', 'http://127.0.0.1:41001', 'http://127.0.0.1:41003', 'http://127.0.0.1:41002'];
    },
    onDesktopDiagnostic: (event) => diagnostics.push(event),
  });
  api.events.follow('existing-session');
  assert.equal(typeof api.refreshDesktopEndpoint, 'function', 'client must expose refreshDesktopEndpoint');
  const recovered = await api.refreshDesktopEndpoint();
  assert.equal(typeof recovered, 'boolean');
  assert.equal(recovered, true);
  assert.equal(api.resolveBase(), 'http://127.0.0.1:41002');
  assert.deepEqual(checked, ['http://127.0.0.1:41001', 'http://127.0.0.1:41003', 'http://127.0.0.1:41002']);
  assert.ok(api._desiredFollows.has('existing-session'), 'recovery must preserve desired follows');
  assert.equal(discoveries.length, 1);
  assert.equal(typeof discoveries[0]?.onDiagnostic, 'function', 'discoverDesktopOrigins must receive onDiagnostic');
  assert.equal(typeof discoveries[0]?.signal?.addEventListener, 'function', 'discoverDesktopOrigins must receive an abort signal');
  assert.ok(diagnostics.length >= 1, 'a failed candidate must emit a diagnostic event');
  for (const diagnostic of diagnostics) {
    assert.equal(typeof diagnostic, 'object');
    assert.ok(diagnostic !== null && !Array.isArray(diagnostic));
  }
  const serialized = JSON.stringify(diagnostics);
  assert.doesNotMatch(serialized, /super-secret/);
  assert.doesNotMatch(serialized, /token=/);
  assert.doesNotMatch(serialized, /probe exploded/);
});

test('desktop discovery never scans an explicitly remote base', async (t) => {
  await isolateDshHome(t);
  let fetchCalls = 0;
  let discoverCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('remote base must not be probed');
  };
  const api = new NodeApiClient('https://remote.invalid', 1000, {
    desktopRecoveryTimeoutMs: 1000,
    discoverDesktopOrigins: async () => {
      discoverCalls += 1;
      return ['http://127.0.0.1:41002'];
    },
  });
  assert.equal(await api.refreshDesktopEndpoint(), false);
  assert.equal(discoverCalls, 0, 'discovery must not run for an explicit remote base');
  assert.equal(fetchCalls, 0);
  assert.equal(api.resolveBase(), 'https://remote.invalid');
});

test('desktop recovery applies the total budget to candidate probes', async (t) => {
  await isolateDshHome(t);
  const attempts = [];
  globalThis.fetch = (input, init = {}) => {
    const url = new URL(input);
    attempts.push({ origin: url.origin, signal: init.signal });
    return new Promise((resolve, reject) => {
      const signal = init.signal;
      const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal?.aborted) {
        fail();
        return;
      }
      signal?.addEventListener?.('abort', fail, { once: true });
    });
  };
  const api = new NodeApiClient('http://127.0.0.1:19387', 1000, {
    desktopRecoveryTimeoutMs: 150,
    discoverDesktopOrigins: async () => ['http://127.0.0.1:41001', 'http://127.0.0.1:41002'],
  });
  api.events.follow('keep-me');
  const started = Date.now();
  let recovered;
  try {
    recovered = await Promise.race([
      api.refreshDesktopEndpoint(),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 4000)),
    ]);
  } catch (error) {
    assert.fail(`recovery must resolve false when the total budget expires, but rejected: ${error?.message ?? error}`);
  }
  const elapsed = Date.now() - started;
  assert.notEqual(recovered, 'timeout', 'recovery must not keep probing past the configured budget window');
  assert.equal(recovered, false);
  assert.ok(elapsed < 3000, `recovery must respect the configured budget, took ${elapsed}ms`);
  assert.ok(attempts.length >= 1, 'at least one candidate must be probed');
  assert.ok(attempts.some((attempt) => attempt.signal?.aborted === true), 'candidate fetch must receive the recovery budget signal');
  assert.equal(api.resolveBase(), 'http://127.0.0.1:19387');
  assert.ok(api._desiredFollows.has('keep-me'));
});

test('desktop recovery never adopts an endpoint after caller cancellation', async (t) => {
  await isolateDshHome(t);
  let releaseFetch = null;
  globalThis.fetch = (input, init = {}) => {
    const envelope = readEnvelope(init);
    return new Promise((resolve) => {
      releaseFetch = () => resolve(namespacesResponse(envelope, [{ ns: 'qq-mode' }]));
    });
  };
  const api = new NodeApiClient('http://127.0.0.1:19387', 1000, {
    desktopRecoveryTimeoutMs: 1000,
    discoverDesktopOrigins: async () => ['http://127.0.0.1:41001'],
  });
  const controller = new AbortController();
  const pending = api.refreshDesktopEndpoint(controller.signal);
  for (let index = 0; index < 50 && !releaseFetch; index += 1) await flushTasks(1);
  assert.equal(typeof releaseFetch, 'function', 'candidate probe must have started');
  controller.abort();
  releaseFetch();
  await pending.catch(() => {});
  assert.equal(api.resolveBase(), 'http://127.0.0.1:19387', 'cancelled recovery must not adopt a discovered endpoint');
});

test('desktop recovery does not let a late result overwrite a newer base configuration', async (t) => {
  await isolateDshHome(t);
  let releaseFetch = null;
  globalThis.fetch = (input, init = {}) => {
    const envelope = readEnvelope(init);
    return new Promise((resolve) => {
      releaseFetch = () => resolve(namespacesResponse(envelope, [{ ns: 'qq-mode' }]));
    });
  };
  const api = new NodeApiClient('http://127.0.0.1:19387', 1000, {
    desktopRecoveryTimeoutMs: 1000,
    discoverDesktopOrigins: async () => ['http://127.0.0.1:41001'],
  });
  const pending = api.refreshDesktopEndpoint();
  for (let index = 0; index < 50 && !releaseFetch; index += 1) await flushTasks(1);
  assert.equal(typeof releaseFetch, 'function', 'candidate probe must have started');
  api.baseUrl = 'http://127.0.0.1:42000';
  api.invalidateAuth();
  releaseFetch();
  await pending.catch(() => {});
  assert.equal(api.resolveBase(), 'http://127.0.0.1:42000', 'a probe started before the config change must not win');
});

test('concurrent recovery calls share one in-flight probe', async (t) => {
  await isolateDshHome(t);
  let discoveries = 0;
  const checked = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    checked.push(url.origin);
    return namespacesResponse(readEnvelope(init), [{ ns: 'qq-mode' }]);
  };
  const api = new NodeApiClient('http://127.0.0.1:19387', 1000, {
    desktopRecoveryTimeoutMs: 1000,
    discoverDesktopOrigins: async () => {
      discoveries += 1;
      return ['http://127.0.0.1:41001'];
    },
  });
  const [first, second] = await Promise.all([api.refreshDesktopEndpoint(), api.refreshDesktopEndpoint()]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(discoveries, 1, 'the in-flight recovery promise must be reused');
  assert.deepEqual(checked, ['http://127.0.0.1:41001']);
  assert.equal(api.resolveBase(), 'http://127.0.0.1:41001');
});

test('candidate probe failures stay visible, safe, and do not stop later candidates', async (t) => {
  await isolateDshHome(t);
  const checked = [];
  const diagnostics = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    checked.push(url.origin);
    if (url.port === '41001') throw new Error('ECONNREFUSED Authorization: Bearer super-secret-token');
    return namespacesResponse(readEnvelope(init), [{ ns: 'qq-mode' }]);
  };
  const api = new NodeApiClient('http://127.0.0.1:19387', 1000, {
    desktopRecoveryTimeoutMs: 1000,
    discoverDesktopOrigins: async () => ['http://127.0.0.1:41001', 'http://127.0.0.1:41002'],
    onDesktopDiagnostic: (event) => {
      diagnostics.push(event);
      throw new Error('observer exploded');
    },
  });
  assert.equal(await api.refreshDesktopEndpoint(), true);
  assert.equal(api.resolveBase(), 'http://127.0.0.1:41002');
  assert.deepEqual(checked, ['http://127.0.0.1:41001', 'http://127.0.0.1:41002']);
  assert.ok(diagnostics.length >= 1, 'candidate failures must be visible to the diagnostic observer');
  const serialized = JSON.stringify(diagnostics);
  assert.doesNotMatch(serialized, /ECONNREFUSED/);
  assert.doesNotMatch(serialized, /Authorization/);
  assert.doesNotMatch(serialized, /super-secret-token/);
});
