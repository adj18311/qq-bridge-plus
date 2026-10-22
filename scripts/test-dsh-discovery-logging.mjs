// DSH 连接发现诊断链路的测试：NodeApiClient 的真实恢复流程（真实 emit）
// → 诊断事件 → bridge 实际复用的同一份日志器（src/core/dsh-connection-watch.mjs）。
// 覆盖：发现阶段/原因/耗时/code 保留、预算耗尽/外部取消/候选超时/新 base 取代分类、
// 多阶段交替不绕过 30s 去重、恢复后清理，以及健康检查 result.ok 反例。
// 全部使用临时 DSH_HOME 与本地 fake fetch，不接触真实 DSH/QQ。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { NodeApiClient } from '../src/dsh-client.js';
import { createDshConnectionWatch } from '../src/core/dsh-connection-watch.mjs';

const WATCH_MODULE_URL = new URL('../src/core/dsh-connection-watch.mjs', import.meta.url);
const BRIDGE_URL = new URL('../src/bridge.js', import.meta.url);

async function loadWatchModule() {
  const mod = await import(WATCH_MODULE_URL);
  assert.equal(typeof mod.createDshConnectionWatch, 'function');
  assert.equal(typeof mod.createDshDiscoveryDiagnosticLog, 'function');
  assert.equal(
    mod.createDshConnectionWatch.createDiscoveryDiagnosticLog,
    undefined,
    '日志器必须走显式 named export，不再挂在 createDshConnectionWatch 函数属性上'
  );
  return mod;
}

async function isolateDshHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-discovery-logging-'));
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

test('discovery stage/status/elapsedMs/code survive the client emit and bridge logging', async (t) => {
  await isolateDshHome(t);
  const watch = await loadWatchModule();
  const raw = [];
  const lines = [];
  const dshDiscoveryLog = watch.createDshDiscoveryDiagnosticLog({
    log: (line) => lines.push(line),
    now: () => 0,
  });
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(new URL(input).port, '41002');
    return namespacesResponse(readEnvelope(init), [{ ns: 'qq-mode' }]);
  };
  const api = new NodeApiClient('http://127.0.0.1:19387', 1000, {
    desktopRecoveryTimeoutMs: 3000,
    discoverDesktopOrigins: async ({ onDiagnostic }) => {
      onDiagnostic({ stage: 'tasklist', status: 'success', elapsedMs: 5, candidateCount: 1 });
      onDiagnostic({ stage: 'netstat', status: 'timeout', reason: 'timeout', elapsedMs: 4000, code: 'ETIMEDOUT' });
      onDiagnostic({ stage: 'process', status: 'empty', reason: 'no-process', elapsedMs: 300, candidateCount: 0 });
      onDiagnostic({ stage: 'listener', status: 'success', elapsedMs: 80, candidateCount: 1 });
      return ['http://127.0.0.1:41002'];
    },
    onDesktopDiagnostic: (event) => raw.push(event),
  });
  assert.equal(await api.refreshDesktopEndpoint(), true);
  for (const event of raw) dshDiscoveryLog(event);

  assert.ok(raw.length >= 5, 'discovery events and the recovered event must be emitted');
  for (const event of raw) {
    assert.equal(typeof event.phase, 'string');
    assert.equal(typeof event.reason, 'string');
    assert.equal(event.stage, undefined, 'stage must be normalized to phase');
    assert.equal(event.status, undefined, 'status must be normalized to reason');
    assert.equal(event.elapsedMs, undefined, 'elapsedMs must be normalized to ms');
  }
  const tasklist = raw.find((event) => event.phase === 'tasklist');
  assert.deepEqual({ reason: tasklist?.reason, ms: tasklist?.ms, candidates: tasklist?.candidateCount }, { reason: 'success', ms: 5, candidates: 1 });
  const netstat = raw.find((event) => event.phase === 'netstat');
  assert.deepEqual({ reason: netstat?.reason, ms: netstat?.ms, code: netstat?.code }, { reason: 'timeout', ms: 4000, code: 'ETIMEDOUT' });
  const process = raw.find((event) => event.phase === 'process');
  assert.deepEqual({ reason: process?.reason, ms: process?.ms, candidates: process?.candidateCount }, { reason: 'no-process', ms: 300, candidates: 0 });
  const listener = raw.find((event) => event.phase === 'listener');
  assert.deepEqual({ reason: listener?.reason, ms: listener?.ms, candidates: listener?.candidateCount }, { reason: 'success', ms: 80, candidates: 1 });
  const recovered = raw.find((event) => event.recovered === true);
  assert.equal(recovered?.phase, 'probe');
  assert.equal(recovered?.reason, 'recovered');

  assert.ok(lines.some((line) => line.includes('[dsh-discovery] netstat/timeout 4000ms code=ETIMEDOUT')), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('listener/success 80ms candidates=1')), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('process/no-process 300ms candidates=0')), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('probe/recovered') && line.includes('(recovered)')), lines.join('\n'));
  assert.doesNotMatch(JSON.stringify({ raw, lines }), /super-secret|access_token|cookie|authorization/i);
});

test('bridge discovery log dedupes per stage+reason, survives alternation, resets after recovery', async () => {
  const watch = await loadWatchModule();
  const lines = [];
  let nowMs = 1_000_000;
  const dshDiscoveryLog = watch.createDshDiscoveryDiagnosticLog({
    log: (line) => lines.push(line),
    now: () => nowMs,
  });
  dshDiscoveryLog({ phase: 'health', reason: 'unhealthy', ms: 4 });
  dshDiscoveryLog({ phase: 'process', reason: 'success', ms: 3, candidateCount: 1 });
  dshDiscoveryLog({ phase: 'listener', reason: 'success', ms: 2, candidateCount: 1 });
  dshDiscoveryLog({ phase: 'scan', reason: 'no-endpoint', ms: 7 });
  assert.equal(lines.length, 4);
  // 多阶段交替 + 同键重复：30s 内不得再记录（旧的单 lastKey 会被绕过）。
  dshDiscoveryLog({ phase: 'health', reason: 'unhealthy', ms: 4 });
  dshDiscoveryLog({ phase: 'process', reason: 'success', ms: 3, candidateCount: 1 });
  dshDiscoveryLog({ phase: 'listener', reason: 'success', ms: 2, candidateCount: 1 });
  dshDiscoveryLog({ phase: 'scan', reason: 'no-endpoint', ms: 7 });
  assert.equal(lines.length, 4, 'alternating stages must not bypass the cooldown');
  // 新的根因首次可见。
  dshDiscoveryLog({ phase: 'netstat', reason: 'timeout', ms: 4000, code: 'ETIMEDOUT' });
  assert.equal(lines.length, 5);
  assert.match(lines[4], /netstat\/timeout 4000ms code=ETIMEDOUT/);
  // 冷却结束后同键可再次出现。
  nowMs += 30_001;
  dshDiscoveryLog({ phase: 'health', reason: 'unhealthy', ms: 5 });
  assert.equal(lines.length, 6);
  // 恢复成功：记一条并清空冷却，随后同键立即可见。
  dshDiscoveryLog({ phase: 'probe', reason: 'recovered', ms: 9, recovered: true });
  dshDiscoveryLog({ phase: 'health', reason: 'unhealthy', ms: 6 });
  assert.equal(lines.length, 8);
  assert.match(lines[6], /probe\/recovered 9ms \(recovered\)/);
  assert.match(lines[7], /health\/unhealthy/);

  // 有界：maxKeys 之外淘汰最老键，不会无限增长。
  const boundedLines = [];
  let boundedNow = 0;
  const bounded = watch.createDshDiscoveryDiagnosticLog({
    log: (line) => boundedLines.push(line),
    now: () => boundedNow,
    maxKeys: 2,
  });
  bounded({ phase: 'p1', reason: 'r' });
  boundedNow += 1;
  bounded({ phase: 'p2', reason: 'r' });
  boundedNow += 1;
  bounded({ phase: 'p3', reason: 'r' });
  boundedNow += 1;
  bounded({ phase: 'p1', reason: 'r' }); // p1 已被淘汰 → 记录
  assert.equal(boundedLines.length, 4);
  boundedNow += 1;
  bounded({ phase: 'p3', reason: 'r' }); // p3 仍在 Map 中 → 冷却
  assert.equal(boundedLines.length, 4);

  // bridge 必须显式 named import 该共享实现，而不是旧的 lastKey 单键去重。
  const bridgeSource = fs.readFileSync(BRIDGE_URL, 'utf8');
  assert.ok(
    bridgeSource.includes("import { createDshConnectionWatch, createDshDiscoveryDiagnosticLog } from './core/dsh-connection-watch.mjs';"),
    'bridge 必须显式 named import 发现日志器'
  );
  assert.ok(
    bridgeSource.includes('const dshDiscoveryLog = createDshDiscoveryDiagnosticLog({ log });'),
    'bridge 必须直接调用 named export，而不是函数属性'
  );
  assert.equal(
    bridgeSource.includes('createDshConnectionWatch.createDiscoveryDiagnosticLog'),
    false,
    '函数属性挂载必须移除'
  );
  assert.doesNotMatch(bridgeSource, /let lastKey = ''/);
});

test('total budget expiry during discovery is diagnosed instead of a silent false', async (t) => {
  await isolateDshHome(t);
  const diagnostics = [];
  globalThis.fetch = async () => {
    throw new Error('no candidate probe is expected after discovery overruns the budget');
  };
  const api = new NodeApiClient('http://127.0.0.1:19387', 1000, {
    desktopRecoveryTimeoutMs: 80,
    discoverDesktopOrigins: ({ signal }) => new Promise((resolve) => {
      const timer = setTimeout(() => resolve(['http://127.0.0.1:41002']), 500);
      if (typeof timer?.unref === 'function') timer.unref();
      signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve(['http://127.0.0.1:41002']); }, { once: true });
    }),
    onDesktopDiagnostic: (event) => diagnostics.push(event),
  });
  assert.equal(await api.refreshDesktopEndpoint(), false);
  assert.equal(api.resolveBase(), 'http://127.0.0.1:19387');
  assert.ok(
    diagnostics.some((event) => event.phase === 'discovery' && event.reason === 'budget-exhausted'),
    JSON.stringify(diagnostics)
  );
});

test('a fetch that ignores abort cannot make recovery adopt a candidate after caller cancellation', async (t) => {
  await isolateDshHome(t);
  const diagnostics = [];
  const controller = new AbortController();
  globalThis.fetch = (input, init = {}) => new Promise((resolve) => {
    const envelope = readEnvelope(init);
    const respond = () => resolve(namespacesResponse(envelope, [{ ns: 'qq-mode' }]));
    const signal = init.signal;
    if (signal?.aborted) respond();
    else signal?.addEventListener?.('abort', respond, { once: true });
  });
  const api = new NodeApiClient('http://127.0.0.1:19387', 1000, {
    desktopRecoveryTimeoutMs: 8000,
    discoverDesktopOrigins: async () => ['http://127.0.0.1:41002'],
    onDesktopDiagnostic: (event) => diagnostics.push(event),
  });
  setTimeout(() => controller.abort(), 30);
  assert.equal(await api.refreshDesktopEndpoint(controller.signal), false);
  assert.equal(api.resolveBase(), 'http://127.0.0.1:19387', 'a cancelled probe must never be adopted');
  assert.ok(diagnostics.some((event) => event.reason === 'cancelled'), JSON.stringify(diagnostics));
});

test('a candidate timeout is reported as timeout even when the fetch later resolves successfully', async (t) => {
  await isolateDshHome(t);
  const diagnostics = [];
  globalThis.fetch = (input, init = {}) => new Promise((resolve) => {
    const envelope = readEnvelope(init);
    const respond = () => resolve(namespacesResponse(envelope, [{ ns: 'qq-mode' }]));
    const signal = init.signal;
    if (signal?.aborted) respond();
    else signal?.addEventListener?.('abort', respond, { once: true });
  });
  const api = new NodeApiClient('http://127.0.0.1:19387', 1000, {
    desktopRecoveryTimeoutMs: 8000,
    discoverDesktopOrigins: async () => ['http://127.0.0.1:41002'],
    onDesktopDiagnostic: (event) => diagnostics.push(event),
  });
  assert.equal(await api.refreshDesktopEndpoint(), false);
  assert.equal(api.resolveBase(), 'http://127.0.0.1:19387', 'a timed-out candidate must never be adopted');
  assert.ok(
    diagnostics.some((event) => event.phase === 'candidate' && event.reason === 'timeout' && event.code === 'ETIMEDOUT'),
    JSON.stringify(diagnostics)
  );
});

test('null discovery and a base replaced mid-flight are diagnosed', async (t) => {
  await isolateDshHome(t);
  const emptyDiagnostics = [];
  const emptyApi = new NodeApiClient('http://127.0.0.1:19387', 1000, {
    desktopRecoveryTimeoutMs: 1000,
    discoverDesktopOrigins: async () => null,
    onDesktopDiagnostic: (event) => emptyDiagnostics.push(event),
  });
  assert.equal(await emptyApi.refreshDesktopEndpoint(), false);
  assert.ok(
    emptyDiagnostics.some((event) => event.phase === 'discovery' && event.reason === 'empty'),
    JSON.stringify(emptyDiagnostics)
  );

  const supersededDiagnostics = [];
  let supersededApi = null;
  supersededApi = new NodeApiClient('http://127.0.0.1:19387', 1000, {
    desktopRecoveryTimeoutMs: 1000,
    discoverDesktopOrigins: async () => {
      supersededApi.baseUrl = 'http://127.0.0.1:42000';
      return ['http://127.0.0.1:41002'];
    },
    onDesktopDiagnostic: (event) => supersededDiagnostics.push(event),
  });
  assert.equal(await supersededApi.refreshDesktopEndpoint(), false);
  assert.equal(supersededApi.resolveBase(), 'http://127.0.0.1:42000');
  assert.ok(
    supersededDiagnostics.some((event) => event.reason === 'superseded'),
    JSON.stringify(supersededDiagnostics)
  );
});

test('health check requires result.ok === true; HTTP 200 with result.ok=false is unhealthy', async (t) => {
  await isolateDshHome(t);
  const payloads = [
    { result: { ok: false, error: { code: 'not-ready' } } },
    { result: { ok: true, value: { namespaces: [{ ns: 'qq-mode' }] } } },
  ];
  globalThis.fetch = async (input, init = {}) => {
    const envelope = readEnvelope(init);
    const payload = payloads.shift();
    assert.ok(payload, 'unexpected extra health request');
    return Response.json({ type: 'server-response', rpcId: envelope.rpcId, ...payload });
  };
  const api = new NodeApiClient('http://127.0.0.1:19387', 1000, {});
  assert.equal(await api.checkHealth(), false, 'HTTP 200 with result.ok=false must not be healthy');
  assert.equal(await api.checkHealth(), true);
  const bridgeSource = fs.readFileSync(BRIDGE_URL, 'utf8');
  assert.match(bridgeSource, /api\.checkHealth\(/);
});

// ── 真实 bridge checkDsh 的薄缝测试 ─────────────────────────────────────────
// createDshConnectionWatch 自身的单测只能证明监视器调度正确，证明不了 checkDsh 的消费边界：
// 「补投会不会卡住健康检查」「短超时何时才算断线」「何时拍快照」都在 bridge 闭包里。
// 这里从 bridge.js 切出真实的 checkDsh + startDshWatch 源码，在 vm 里注入最小桩，
// 用真实 createDshConnectionWatch 与假计时器驱动 —— 测的就是生产代码本身。

const CHECK_SLICE_START = '  const checkDsh = async () => {';
const CHECK_SLICE_END = '  // ── SnowLuma 上游健康';
const MODE_SLICE_START = '  async function refreshMode(signal) {';
const MODE_SLICE_END = '  /** 拉取 DSH 当前可用的 agent preset 清单';
const PRESET_SLICE_START = '  async function refreshPresetList(signal) {';
const PRESET_SLICE_END = '  /** 当前模式是否允许该会话进入 */';

function sliceBridgeSource(startMarker, endMarker) {
  const source = fs.readFileSync(BRIDGE_URL, 'utf8');
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `bridge.js 缺少切片起点: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `bridge.js 缺少切片终点: ${endMarker}`);
  return source.slice(start, end);
}

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay = 0) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fn, at: now + Math.max(0, Number(delay) || 0) });
      return { __id: id, unref() {} };
    },
    clearTimeout(handle) {
      if (handle && typeof handle.__id === 'number') timers.delete(handle.__id);
    },
    nextDueBefore(target) {
      let due = null;
      for (const [id, entry] of timers) {
        if (entry.at > target) continue;
        if (!due || entry.at < due.at) due = { id, at: entry.at };
      }
      return due;
    },
    fire(id) {
      const entry = timers.get(id);
      if (!entry) return;
      timers.delete(id);
      now = entry.at;
      entry.fn();
    },
    setNow(value) { now = value; },
  };
}

async function flushBridgeMicrotasks() {
  await new Promise((resolve) => { setImmediate(resolve); });
}

async function advanceBridgeClock(clock, ms) {
  const target = clock.now() + ms;
  for (let guard = 0; guard < 64; guard += 1) {
    const due = clock.nextDueBefore(target);
    if (!due) break;
    clock.fire(due.id);
    await flushBridgeMicrotasks();
  }
  clock.setNow(target);
  await flushBridgeMicrotasks();
}

function createCheckDshSandbox(options = {}) {
  const clock = createFakeClock();
  const logs = [];
  const diagnostics = [];
  const calls = { check: 0, flush: 0, snapshots: 0, reconnect: 0 };
  const script = Array.isArray(options.sequence) ? [...options.sequence] : ['ok'];
  let lastProbe = null;
  const sandbox = {
    __expose(value) { sandbox.bridge = value; },
    bridge: null,
    setTimeout: (fn, delay) => clock.setTimeout(fn, delay),
    clearTimeout: (handle) => clock.clearTimeout(handle),
    api: {
      async checkHealth() {
        calls.check += 1;
        const step = script.length > 0 ? script.shift() : 'ok';
        if (step === 'timeout') {
          assert.ok(lastProbe, 'timeout 必须发生在探测预算创建之后');
          lastProbe.abort();
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          throw error;
        }
        if (step === 'refused') {
          const error = new Error('connect ECONNREFUSED 127.0.0.1:1');
          error.code = 'ECONNREFUSED';
          throw error;
        }
        assert.equal(step, 'ok');
        return true;
      },
      async refreshDesktopEndpoint() { return false; },
      resolveBase() { return 'http://127.0.0.1:1'; },
    },
    cfg: { dsh: { autoDiscoverDesktop: false, baseUrl: 'http://127.0.0.1:1' } },
    log: (line) => { logs.push(String(line)); },
    dshDiscoveryLog: (event) => { diagnostics.push(event); },
    createDshHealthProbeTimeout() {
      const controller = new AbortController();
      const signal = controller.signal;
      lastProbe = { signal, abort: () => { controller.abort(); } };
      return { signal, cancel: () => {} };
    },
    createDshConnectionWatch,
    dshReady: options.dshReady === true,
    lastMode: 'chat',
    currentMode: 'chat',
    dshPresetIds: [],
    dshDefaultPreset: 'default',
    dshHealthSoftTimeoutStreak: 0,
    dshCheckStarted: false,
    socialV2: { conversations: new Map() },
    slangWindows: new Map(),
    refreshMode: async () => {},
    refreshPresetList: async () => {},
    reconcileSessionPolicies: () => {},
    handleDshReconnectV2: () => { calls.reconnect += 1; },
    snapshotDshDownInFlightTurnsV2: () => { calls.snapshots += 1; },
    flushQueue: () => { calls.flush += 1; return new Promise(() => {}); },
    maybeQueueSlangExtraction: () => {},
    setupSleepTimerV2: () => {},
    scheduleProactiveCheckV2: () => {},
    clearAllSocialV2Timers: () => {},
    drainAllPromptQueues: () => {},
    cleanupSocialForModeChange: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${sliceBridgeSource(CHECK_SLICE_START, CHECK_SLICE_END)}\n__expose({ checkDsh, startDshWatch });\n`,
    sandbox,
    { filename: 'bridge-checkDsh-slice.js' }
  );
  assert.equal(typeof sandbox.bridge?.checkDsh, 'function');
  assert.equal(typeof sandbox.bridge?.startDshWatch, 'function');
  return { sandbox, clock, logs, diagnostics, calls };
}

function createRefreshModeSandbox(options = {}) {
  const logs = [];
  const diagnostics = [];
  const clears = { watchdog: 0 };
  const sandbox = {
    __expose(value) { Object.assign(sandbox, value); },
    api: { settings: { describe: options.describe ?? (async () => ({ namespaces: [] })) } },
    unwrap: (result) => result.value,
    cfg: { ownerQQ: '10001' },
    log: (line) => { logs.push(String(line)); },
    dshDiscoveryLog: (event) => { diagnostics.push(event); },
    readJsonSafe: () => options.localMode ?? null,
    path: { join: (...parts) => parts.join('/') },
    STATE_DIR: '/tmp/dsh-state',
    normalizeModeInput: (value) => (value === 'chat' || value === 'reserved' || value === 'reserved2' ? value : null),
    normalizeOwnerQQ: (value) => value,
    clearBusyWatchdogRuntimeV2: () => { clears.watchdog += 1; },
    closedAgentPreset: '',
    dshDefaultPreset: '',
    currentMode: options.currentMode ?? 'reserved2',
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${sliceBridgeSource(MODE_SLICE_START, MODE_SLICE_END)}\n__expose({ refreshMode });\n`,
    sandbox,
    { filename: 'bridge-refreshMode-slice.js' }
  );
  assert.equal(typeof sandbox.refreshMode, 'function');
  return { sandbox, logs, diagnostics, clears };
}

function createRefreshPresetSandbox(options = {}) {
  const logs = [];
  const diagnostics = [];
  const sandbox = {
    __expose(value) { Object.assign(sandbox, value); },
    api: { agentPresets: { list: options.list ?? (async () => ({ presets: [] })) } },
    unwrap: (result) => result.value,
    log: (line) => { logs.push(String(line)); },
    dshDiscoveryLog: (event) => { diagnostics.push(event); },
    dshPresetIds: [],
    dshDefaultPreset: '',
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${sliceBridgeSource(PRESET_SLICE_START, PRESET_SLICE_END)}\n__expose({ refreshPresetList });\n`,
    sandbox,
    { filename: 'bridge-refreshPresetList-slice.js' }
  );
  assert.equal(typeof sandbox.refreshPresetList, 'function');
  return { sandbox, logs, diagnostics };
}

test('real bridge checkDsh: a stuck offline flushQueue must not block the single-flight health cycle', async () => {
  const env = createCheckDshSandbox({ dshReady: false, sequence: ['ok', 'ok'] });
  env.sandbox.bridge.startDshWatch();
  await flushBridgeMicrotasks();
  await flushBridgeMicrotasks();
  assert.equal(env.calls.check, 1, '首次健康检查必须完成');
  assert.equal(env.calls.flush, 1, '进入 ready 后应启动离线补投');
  assert.equal(env.sandbox.dshReady, true);
  assert.ok(env.clock.nextDueBefore(10_000), 'checkDsh 返回后监视器必须安排下一次检查');

  await advanceBridgeClock(env.clock, 5000);
  assert.equal(env.calls.check, 2, 'flushQueue 永不 resolve 也不能卡住下一轮健康检查');
});

test('real bridge checkDsh: two local probe timeouts keep ready, the third flips it once', async () => {
  const env = createCheckDshSandbox({ dshReady: true, sequence: ['timeout', 'timeout', 'timeout', 'timeout'] });
  env.sandbox.bridge.startDshWatch();
  await flushBridgeMicrotasks();

  assert.equal(env.calls.check, 1);
  assert.equal(env.sandbox.dshReady, true, '第一次本机短超时不得翻转 ready');
  assert.equal(env.calls.snapshots, 0);
  assert.ok(env.diagnostics.some((event) => event.phase === 'health' && event.reason === 'local-timeout'));

  await advanceBridgeClock(env.clock, 2000);
  assert.equal(env.calls.check, 2);
  assert.equal(env.sandbox.dshReady, true, '第二次本机短超时不得翻转 ready');
  assert.equal(env.calls.snapshots, 0);
  assert.ok(env.diagnostics.some((event) => event.reason === 'soft-timeout-1of3'));
  assert.ok(env.diagnostics.some((event) => event.reason === 'soft-timeout-2of3'));

  await advanceBridgeClock(env.clock, 2000);
  assert.equal(env.calls.check, 3);
  assert.equal(env.sandbox.dshReady, false, '连续第三次本机短超时才翻转 ready');
  assert.equal(env.calls.snapshots, 1, '翻转时只拍一次快照');
  assert.ok(env.diagnostics.some((event) => event.reason === 'soft-timeout-confirmed'));

  await advanceBridgeClock(env.clock, 2000);
  assert.equal(env.calls.check, 4);
  assert.equal(env.calls.snapshots, 1, '已判定 down 后重复超时不再拍快照');
});

test('real bridge checkDsh: a healthy probe resets the soft-timeout streak', async () => {
  const env = createCheckDshSandbox({ dshReady: true, sequence: ['timeout', 'timeout', 'ok', 'timeout', 'timeout'] });
  env.sandbox.bridge.startDshWatch();
  await flushBridgeMicrotasks();
  await advanceBridgeClock(env.clock, 2000);
  await advanceBridgeClock(env.clock, 2000);
  assert.equal(env.calls.check, 3);
  assert.equal(env.sandbox.dshReady, true);
  assert.equal(env.sandbox.dshHealthSoftTimeoutStreak, 0, '健康探测成功必须清零软失败计数');

  await advanceBridgeClock(env.clock, 5000);
  await advanceBridgeClock(env.clock, 2000);
  assert.equal(env.calls.check, 5);
  assert.equal(env.sandbox.dshReady, true, '清零后的两次短超时不能累计成第三次');
  assert.equal(env.calls.snapshots, 0);
});

test('real bridge checkDsh: ECONNREFUSED still flips ready immediately (old behaviour)', async () => {
  const env = createCheckDshSandbox({ dshReady: true, sequence: ['refused'] });
  env.sandbox.bridge.startDshWatch();
  await flushBridgeMicrotasks();
  assert.equal(env.calls.check, 1);
  assert.equal(env.sandbox.dshReady, false, '连接拒绝属于确定性失败，必须立即 down');
  assert.equal(env.calls.snapshots, 1);
  assert.equal(env.sandbox.dshHealthSoftTimeoutStreak, 0);
});

test('real bridge refreshMode: a short probe abort keeps the current DSH mode', async () => {
  const controller = new AbortController();
  const env = createRefreshModeSandbox({
    currentMode: 'reserved2',
    localMode: { mode: 'chat' },
    describe: async () => {
      controller.abort();
      const error = new Error('This operation was aborted');
      error.name = 'AbortError';
      throw error;
    },
  });
  await env.sandbox.refreshMode(controller.signal);
  assert.equal(env.sandbox.currentMode, 'reserved2', '短超时不得用本地 mode.json 覆盖 DSH 有效模式');
  assert.equal(env.clears.watchdog, 0);
  assert.ok(
    env.diagnostics.some((event) => event.phase === 'mode' && event.reason === 'timeout-reserved2'),
    JSON.stringify(env.diagnostics)
  );
});

test('real bridge refreshMode: a non-timeout failure still uses the local fallback', async () => {
  const env = createRefreshModeSandbox({
    currentMode: 'reserved2',
    localMode: { mode: 'chat' },
    describe: async () => { throw new Error('settings describe failed'); },
  });
  await env.sandbox.refreshMode(undefined);
  assert.equal(env.sandbox.currentMode, 'chat');
  assert.equal(env.clears.watchdog, 1);
});

test('real bridge refreshPresetList: a short probe timeout is diagnosed without error text', async () => {
  const controller = new AbortController();
  const env = createRefreshPresetSandbox({
    list: async () => {
      controller.abort();
      const error = new Error('This operation was aborted');
      error.name = 'AbortError';
      throw error;
    },
  });
  await env.sandbox.refreshPresetList(controller.signal);
  assert.ok(env.diagnostics.some((event) => event.phase === 'preset' && event.reason === 'timeout'));
  assert.deepEqual(env.logs, [], '短超时的诊断不能写出可能含端点/错误文本的日志');
});

