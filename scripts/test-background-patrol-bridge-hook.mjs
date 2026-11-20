// scripts/test-background-patrol-bridge-hook.mjs
// task-53：bridge 接线 hook 测试（TDD 先红后绿）。
// 覆盖：默认关闭零副作用 / 缺独立 authorizeToken / 坏 controller store fail-closed /
// 启用后真实 loopback allow+deny+401 / 审计适配器 / stop/close 幂等 / 端口释放 / 状态。
// plus bridge.js 静态接线断言 + 用 audit-bridge-harness 验证禁用路径不构造 hook。
// 全部离线：临时 store 路径 + 127.0.0.1 临时端口；不启动桥接、不读正式 config。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import * as patrolHookModule from '../src/core/background-patrol-bridge-hook.mjs';
const { createBackgroundPatrolBridgeHook } = patrolHookModule;
import { createXhhOperationStore } from '../src/core/xiaoheihe-operation-store.mjs';
import { createBackgroundPatrolAudit } from '../src/core/background-patrol-audit.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { httpRequest, postJson } from './test-port-safe.mjs';

const TOKEN = 'hook-authorize-token-0123456789abcdef';
const BG = 'patrol:background';
const tempDirs = [];

test('未确认写状态缺失或格式损坏时不能视作空账本', () => {
  assert.equal(typeof patrolHookModule.classifyUnconfirmedWrites, 'function');
  const classify = patrolHookModule.classifyUnconfirmedWrites;
  for (const input of [null, {}, { pending: [], unknown: null }, { pending: [{}], unknown: [] }, { pending: [{ kind: 'other' }], unknown: [] }]) {
    assert.equal(classify(input).known, false);
  }
  assert.deepEqual(classify({ pending: [], unknown: [] }), { known: true, pendingWrites: 0, unknownWrites: 0, reason: null });
  assert.equal(classify({ pending: [{ kind: 'post' }], unknown: [] }).pendingWrites, 1);
});

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhh-bridge-hook-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * 巡逻时钟接缝：`beginTiebaPatrol` 的时段判定与贴吧账本共用 `backgroundPatrolNow`，
 * 固定成北京时间正午，避免测试在 23:00–07:00 跑时被静默门禁误伤。
 */
function fixedPatrolNow(iso) {
  const fixed = Date.parse(iso);
  return () => fixed;
}

function makeFakeE1(overrides = {}) {
  const ensureCalls = [];
  const schedulerStarted = [];
  const schedulerOptions = [];
  const storeOptions = [];
  const marks = [];
  const plans = [];
  const recordedPlans = [];
  const closes = { lifecycle: 0, store: 0 };
  const schedulerStops = [];
  const state = overrides.storeState ?? {
    generation: 0,
    platforms: { tieba: { nextAt: null, lastRunAt: null, lastRunGeneration: null }, xiaoheihe: { nextAt: null, lastRunAt: null, lastRunGeneration: null } },
  };
  const globals = {
    createBackgroundPatrolSessionLifecycle: (options) => {
      ensureCalls.push(options);
      return {
        async ensureSession() {
          if (typeof overrides.ensure === 'function') return overrides.ensure(options);
          return overrides.ensureResult ?? { ok: true, sessionId: 'sid-patrol' };
        },
        async close() {
          closes.lifecycle += 1;
          if (typeof overrides.lifecycleClose === 'function') overrides.lifecycleClose();
          return { ok: true, archived: true, sessionId: 'sid-patrol' };
        },
        async status() { return { phase: 'ready' }; },
      };
    },
    createBackgroundPatrolScheduleStore: (options) => {
      storeOptions.push(options);
      return {
        async load() {
          if (overrides.loadError) throw overrides.loadError;
        },
        async advanceGeneration(request) {
          if (overrides.advanceError) throw overrides.advanceError;
          if (overrides.advanceResult !== undefined) return overrides.advanceResult;
          state.generation += 1;
          if (request && typeof request.at === 'number') state.lastSeenAt = request.at;
          return { ok: true, generation: state.generation };
        },
        async snapshot() {
          const cloned = JSON.parse(JSON.stringify(state));
          return cloned;
        },
        async planNext(request) { plans.push(request); return { ok: true, at: request.now + 1000 }; },
        async recordPlan(request) {
          recordedPlans.push(request);
          if (overrides.recordPlanError) throw overrides.recordPlanError;
          if (overrides.recordPlanResult !== undefined) return overrides.recordPlanResult;
          // 模拟真实 store 语义：lastSeenAt=实际记录时间、nextAt=已算好的机会时间、planCount+1。
          state.lastSeenAt = request.at;
          state.platforms[request.platform].nextAt = request.nextAt;
          state.platforms[request.platform].planCount = (state.platforms[request.platform].planCount ?? 0) + 1;
          return { ok: true, platform: request.platform, at: request.at, nextAt: request.nextAt };
        },
        async markOpportunity(request) { marks.push(request); return { ok: true }; },
        async close() { closes.store += 1; },
      };
    },
    createBackgroundPatrolScheduler: (options) => {
      schedulerOptions.push(options);
      return {
        start() { schedulerStarted.push(true); },
        stop() { schedulerStops.push(true); },
        snapshot() { return { started: schedulerStarted.length > 0, runningPlatform: null, nextAt: { tieba: null, xiaoheihe: null } }; },
      };
    },
  };
  return { globals, ensureCalls, schedulerStarted, schedulerOptions, storeOptions, marks, plans, recordedPlans, closes, schedulerStops, state };
}

function enabledConfig(extra = {}) {
  return { backgroundPatrol: { enabled: true, ...extra } };
}

function makeHook(overrides = {}) {
  return createBackgroundPatrolBridgeHook({
    config: enabledConfig(),
    consoleToken: TOKEN,
    controllerStorePath: overrides.storePath,
    ownerQQ: 123456789,
    sessions: ['patrol:background'],
    ...overrides,
  });
}

test('未暂停时恢复写入不产生控制器状态文件写入', async () => {
  const dir = await makeDir();
  const storePath = path.join(dir, 'controller.json');
  const hook = makeHook({ storePath });
  try {
    assert.equal((await hook.start()).ok, true);
    const before = await fs.stat(storePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    const result = await hook.recoverColumnScope('write');
    assert.equal(result.ok, true);
    assert.equal(result.wasPaused, false);
    const after = await fs.stat(storePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    assert.equal(after?.mtimeMs ?? null, before?.mtimeMs ?? null, '无暂停时不应持久化');
  } finally { await hook.close(); }
});

test('恢复落盘失败时显示 store 错误码及底层原因', async () => {
  const dir = await makeDir();
  const storePath = path.join(dir, 'controller.json');
  const seed = createXhhOperationStore({ filePath: storePath });
  await seed.load();
  await seed.controller.reportAccessUnavailable({ reason: 'captcha', now: Date.now() });
  assert.equal((await seed.save()).ok, true);
  await seed.close();
  const hook = makeHook({ storePath, fsOps: {
    rename: async () => { throw Object.assign(new Error('simulated denial'), { code: 'EACCES' }); },
  } });
  try {
    assert.equal((await hook.start()).ok, true);
    await assert.rejects(() => hook.recoverColumnScope('access'), /WRITE_FAILED.*EACCES/);
    const diagnostics = (await hook.statusAsync()).controllerStore;
    assert.equal(diagnostics.degraded, true);
    assert.equal(diagnostics.lastError.code, 'XHH_OPERATION_STORE_WRITE_FAILED');
    assert.equal(diagnostics.lastError.causeCode, 'EACCES');
    assert.equal('filePath' in diagnostics, false);
  } finally { await hook.close(); }
});

// 端口安全：hook 的 listen 端口由 OS 分配（makeHook 未指定 port），可能落进 undici fetch 的
// blocked-port 列表，让 `fetch()` 抛 `TypeError: fetch failed (bad port)` —— 这是环境假红，
// 不是被测逻辑失败。本文件的请求全部由测试自己发出，因此用原生 http（无 bad-port 限制），
// 端口是什么都能连。见 scripts/test-port-safe.mjs。
function post(url, body, headers = {}) {
  return postJson(url, body, headers);
}

async function authorize(url, body) {
  const response = await post(`${url}/api/xiaoheihe/authorize`, body, { 'x-console-token': TOKEN });
  return { status: response.status, body: await response.json() };
}

async function commit(url, ticket, agentKey = BG) {
  const response = await post(`${url}/api/xiaoheihe/commit`, { ticket, agentKey }, { 'x-console-token': TOKEN });
  return { status: response.status, body: await response.json() };
}

async function abort(url, ticket, agentKey = BG) {
  const response = await post(`${url}/api/xiaoheihe/abort`, { ticket, agentKey }, { 'x-console-token': TOKEN });
  return { status: response.status, body: await response.json() };
}

test('默认关闭：undefined/{}/enabled:false/"true"/1 → enabled:false，零副作用（不建 store/不校验 token）', async () => {
  const configs = [undefined, null, {}, { backgroundPatrol: {} }, { backgroundPatrol: { enabled: false } }, {
    backgroundPatrol: { enabled: 'true' },
  }, { backgroundPatrol: { enabled: 1 } }, 'true', 1];
  for (const config of configs) {
    const hook = makeHook({ config, consoleToken: undefined, controllerStorePath: '/definitely/not/a/dir/x.json' });
    assert.deepEqual(await hook.start(), { ok: true, enabled: false }, JSON.stringify(config));
    assert.deepEqual(await hook.stop(), { stopped: false });
    const status = hook.status();
    assert.equal(status.enabled, false);
    assert.equal(status.started, false);
    assert.equal(status.url, null);
    assert.equal(status.port, null);
  }
});

test('启用但缺独立 authorizeToken（空/非字符串/缺失）→ missing-authorize-token，不启动', async () => {
  const dir = await makeDir();
  for (const consoleToken of [undefined, '', 42, null]) {
    const hook = makeHook({ consoleToken, storePath: path.join(dir, 'controller.json') });
    assert.deepEqual(await hook.start(), { ok: false, error: 'missing-authorize-token' }, String(consoleToken));
    assert.deepEqual(await hook.stop(), { stopped: false });
  }
});

test('启用但 controller store 路径非法/不可写 → invalid-controller-store，不启动', async () => {
  const dir = await makeDir();
  const fileAsDir = path.join(dir, 'not-a-dir');
  await fs.writeFile(fileAsDir, 'x', 'utf8');
  const cases = ['', undefined, path.join(dir, 'no-such-dir', 'controller.json'), path.join(fileAsDir, 'controller.json')];
  for (const storePath of cases) {
    const hook = makeHook({ storePath });
    const result = await hook.start();
    assert.equal(result.ok, false, String(storePath));
    assert.equal(result.error, 'invalid-controller-store', String(storePath));
    assert.deepEqual(await hook.stop(), { stopped: false });
  }
});

test('启用：真实 loopback allow / deny / 401；stop 幂等；端口释放', async () => {
  const dir = await makeDir();
  const storePath = path.join(dir, 'controller.json');
  const hook = makeHook({ storePath });
  const started = await hook.start();
  assert.equal(started.ok, true);
  assert.equal(started.enabled, true);
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(started.port > 0);

  const allow = await post(`${started.url}/api/xiaoheihe/authorize`, {
    agentKey: BG,
    tool: 'mcp__xiaoheihe__get_home_content',
    args: { id: 'p1' },
  }, { 'x-console-token': TOKEN });
  assert.equal(allow.status, 200);
  assert.equal((await allow.json()).decision, 'allow');

  const stranger = await post(`${started.url}/api/xiaoheihe/authorize`, {
    agentKey: 'unknown-agent',
    tool: 'mcp__xiaoheihe__get_home_content',
    args: {},
  }, { 'x-console-token': TOKEN });
  assert.equal(stranger.status, 200);
  assert.equal((await stranger.json()).decision, 'deny');

  const unauthorized = await post(`${started.url}/api/xiaoheihe/authorize`, {
    agentKey: BG,
    tool: 'mcp__xiaoheihe__get_home_content',
    args: {},
  });
  assert.equal(unauthorized.status, 401);

  assert.equal(hook.status().started, true);
  assert.equal(hook.status().port, started.port);
  assert.deepEqual(await hook.stop(), { stopped: true });
  assert.deepEqual(await hook.stop(), { stopped: false }, 'stop 幂等');
  await assert.rejects(() => httpRequest(`${started.url}/api/xiaoheihe/authorize`), 'stop 后端口关闭');

  // 端口释放 + 同 store 重启仍可工作。
  const again = makeHook({ storePath, port: started.port });
  const restarted = await again.start();
  assert.equal(restarted.port, started.port, '端口已释放，可复用');
  await again.stop();
  await hook.close();
  await again.close();
});

test('P2-1 首次对账完成前：写授权 fail-closed（reconcile-pending），对账成功后放行', async () => {
  const dir = await makeDir();
  const hook = makeHook({ storePath: path.join(dir, 'controller.json') });
  const started = await hook.start();
  assert.equal(started.ok, true, JSON.stringify(started));
  try {
    assert.equal(hook.status().lastReconcile ?? null, null, '启动时尚未对账');
    const pending = await post(`${started.url}/api/xiaoheihe/authorize`, {
      agentKey: BG,
      tool: 'mcp__xiaoheihe__post_comment',
      args: { operationId: 'p21-write' },
    }, { 'x-console-token': TOKEN });
    assert.equal(pending.status, 200);
    const pendingBody = await pending.json();
    assert.equal(pendingBody.decision, 'deny', JSON.stringify(pendingBody));
    assert.equal(pendingBody.reason, 'reconcile-pending');
    const reconciled = await hook.reconcile({ enqueue: async () => ({ ok: true, id: 'x' }), isDelivered: async () => ({ ok: true, delivered: false }) });
    assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
    const allowed = await post(`${started.url}/api/xiaoheihe/authorize`, {
      agentKey: BG,
      tool: 'mcp__xiaoheihe__post_comment',
      args: { operationId: 'p21-write-2' },
    }, { 'x-console-token': TOKEN });
    const allowedBody = await allowed.json();
    assert.equal(allowedBody.decision, 'allow', JSON.stringify(allowedBody));
  } finally { await hook.stop(); await hook.close(); }
});
test('controller 状态持久化：reserve+commit 后读额度跨 hook 重启保留（同 store 文件）', async () => {
  const dir = await makeDir();
  const storePath = path.join(dir, 'controller.json');
  const first = makeHook({ storePath });
  const { url } = await first.start();
  const reserved = await authorize(url, {
    agentKey: BG,
    tool: 'mcp__xiaoheihe__get_home_content',
    args: { id: 'read-1' },
  });
  assert.equal(reserved.body.decision, 'allow');
  const started = await commit(url, reserved.body.ticket);
  assert.equal(started.body.ok, true);
  assert.equal(started.body.started, true);
  await first.close();

  const second = makeHook({ storePath });
  const restarted = await second.start();
  assert.equal(restarted.ok, true);
  assert.equal((await second.statusAsync()).readUsed, 1, 'commit 后 readCount=1 必须落盘');
  const after = await authorize(restarted.url, {
    agentKey: BG,
    tool: 'mcp__xiaoheihe__get_post_detail',
    args: { id: 'read-2' },
  });
  assert.equal(after.body.decision, 'allow', '持久化读额度后仍允许第 2 次');
  await second.close();
});

test('审计适配器：注入 {record} 时 allow 事件映射为后台审计固定字段（无 token/args）', async () => {
  const dir = await makeDir();
  const records = [];
  const audit = { record: async (payload) => { records.push(payload); return { ok: true }; } };
  const hook = makeHook({ storePath: path.join(dir, 'controller.json'), audit });
  const { url } = await hook.start();
  try {
    const response = await post(`${url}/api/xiaoheihe/authorize`, {
      agentKey: BG,
      tool: 'mcp__xiaoheihe__get_home_content',
      args: { id: 'p1', text: 'SENSITIVE_TEXT' },
    }, { 'x-console-token': TOKEN });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(records.length >= 1);
    const record = records[0];
    assert.equal(record.platform, 'xiaoheihe');
    assert.equal(record.action, 'read');
    assert.equal(record.result, 'allowed');
    const serialized = JSON.stringify(records);
    assert.ok(!serialized.includes(TOKEN), '审计不得含 token');
    assert.ok(!serialized.includes('SENSITIVE_TEXT'), '审计不得含 args 原文');
  } finally {
    await hook.close();
  }
});

test('start 幂等 / close 幂等 / status 只读；缺失 background session 时 authorize fail-closed deny', async () => {
  const dir = await makeDir();
  const hook = makeHook({ storePath: path.join(dir, 'controller.json'), sessions: null });
  const first = await hook.start();
  assert.equal(first.ok, true);
  const again = await hook.start();
  assert.equal(again.port, first.port, '重复 start 幂等');
  const response = await post(`${again.url}/api/xiaoheihe/authorize`, {
    agentKey: BG,
    tool: 'mcp__xiaoheihe__get_home_content',
    args: {},
  }, { 'x-console-token': TOKEN });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).decision, 'deny', '未注入 session identity → fail-closed deny');
  const status = hook.status();
  status.started = 'tampered';
  assert.equal(hook.status().started, true, 'status 必须返回副本');
  assert.deepEqual(await hook.close(), { ok: true });
  assert.deepEqual(await hook.close(), { ok: true }, 'close 幂等');
  assert.deepEqual(await hook.start(), { ok: false, error: 'closed' });
});

test('bridge.js 接线（静态）：import + 启用门禁 + start + stop 均在位，且不启调度器/不建巡逻会话', async () => {
  const source = await fs.readFile(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ createBackgroundPatrolBridgeHook, describeIdentityMode \} from '\.\/core\/background-patrol-bridge-hook\.mjs';/);
  assert.match(source, /if \(cfg\.backgroundPatrol\?\.enabled === true\) \{/);
  assert.match(source, /createBackgroundPatrolBridgeHook\(\{/);
  assert.match(source, /await backgroundPatrolHook\.start\(\)/);
  // task-58：启动日志必须记录身份模式；legacy 时明确标注「后台写门禁已降级」，
  // 让运维在日志里就能看到 task-49 门禁是否因身份降级而失效。
  // task-62（P3-4）：文案改由 describeIdentityMode() 纯函数产出（单测在 test-session-identity-mode.mjs），
  // bridge 只保留接线断言；legacy 文案不再要求出现在 bridge.js 里。
  assert.match(source, /const identityMode = backgroundPatrolHook\.status\(\)\?\.identityMode/);
  assert.match(source, /describeIdentityMode\(identityMode\)/);
  // task-62（P2-1）：session-store 的键名剔除诊断与身份模式都必须有桥接侧出口。
  assert.match(source, /const diagnostics = sessionStore\.diagnostics;/);
  assert.match(source, /removedCount > 0/);
  assert.match(source, /__backgroundPatrolStatus/);
  assert.match(source, /await backgroundPatrolHook\.stop\(\)/);
  // task-78：真实审计 + 真实 sessions + backgroundSessionId(null，不伪造) 接线。
  assert.match(source, /import \{ createBackgroundPatrolAudit \} from '\.\/core\/background-patrol-audit\.mjs';/);
  assert.match(source, /createBackgroundPatrolAudit\(\{ filePath: auditDir \}\)/);
  assert.match(source, /sessions: \{ \.\.\.\(state\.sessions \?\? \{\}\) \}/);
  assert.match(source, /backgroundSessionId/);
  assert.match(source, /auditDir/);
  // task-86（E1）：生命周期 + 机会调度也在同一 enabled 门禁后接线；默认关闭路径不触碰。
  assert.match(source, /import \{ createBackgroundPatrolSessionLifecycle, BACKGROUND_SESSION_KEY \} from '\.\/core\/background-patrol-session-lifecycle\.mjs';/);
  assert.match(source, /import \{ createBackgroundPatrolScheduler, PATROL_INTERVALS, isPatrolActiveTime \} from '\.\/core\/background-patrol-scheduler\.mjs';/);
  assert.match(source, /import \{ createBackgroundPatrolScheduleStore \} from '\.\/core\/background-patrol-schedule-store\.mjs';/);
  assert.match(source, /createBackgroundPatrolSessionLifecycle\(\{/);
  assert.match(source, /createBackgroundPatrolScheduler\(\{/);
  assert.match(source, /createBackgroundPatrolScheduleStore\(\{/);
  // task-53：onPlan 必须登记 scheduler 已算好的 nextAt（recordPlan），不得再 planNext 二次抽样。
  assert.match(source, /scheduleStore\.recordPlan\(\{ platform, at: Date\.now\(\), nextAt: at \}\)/);
  assert.doesNotMatch(source, /scheduleStore\.planNext\(\{ platform, now: at/);
  assert.match(source, /backgroundPatrolDispatchOpportunity\(platform, opportunity\)/);
  assert.match(source, /await stopBackgroundPatrolRuntime\(\)/);
  assert.equal((source.match(/createBackgroundPatrolBridgeHook\(/g) ?? []).length, 1, 'hook 只在启用分支创建一次');
  assert.equal((source.match(/createBackgroundPatrolSessionLifecycle\(/g) ?? []).length, 1, 'lifecycle 只在运行时创建一次');
});

test('bridge harness（禁用路径）：普通 config 不构造 hook、QQ/DSH 链路照常初始化', async () => {
  const harness = await bridgeHarness({ config: { slang: { enabled: false } } });
  try {
    assert.ok(harness.temp, 'harness 正常初始化');
    assert.equal(typeof harness.close, 'function');
  } finally {
    await harness.close();
  }
});

test('bridge harness（启用路径）：注入 fake hook 时以独立 token 构造并 start，不改 QQ/DSH 链路', async () => {
  const captured = [];
  const fakeFactory = (options) => {
    captured.push(options);
    return {
      async start() { return { ok: true, enabled: true, url: 'http://127.0.0.1:1', port: 1 }; },
      async stop() { return { stopped: true }; },
      status() { return { started: true, identityMode: 'mapper' }; },
    };
  };
  const auditCaptured = [];
  const fakeAuditFactory = (options) => {
    auditCaptured.push(options);
    return { filePath: options.filePath, async load() {}, async record() { return { ok: true }; } };
  };
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({
    config: {
      slang: { enabled: false },
      backgroundPatrol: { enabled: true, authorizeToken: 'independent-token-0123456789abcdef' },
    },
    globals: {
      createBackgroundPatrolBridgeHook: fakeFactory,
      createBackgroundPatrolAudit: fakeAuditFactory,
      ...e1.globals,
    },
  });
  try {
    assert.equal(captured.length, 1, '启用时只构造一次 hook');
    assert.equal(captured[0].consoleToken, 'independent-token-0123456789abcdef', '必须使用独立 authorizeToken');
    assert.equal(captured[0].config.backgroundPatrol.enabled, true);
    assert.equal(typeof captured[0].controllerStorePath, 'string');
    assert.ok(captured[0].controllerStorePath.includes('xiaoheihe-operation-controller.json'));
    assert.ok(harness.temp);
    // task-78：真实 sessions 映射 + backgroundSessionId(null，不伪造) + audit 实例必须传入 hook。
    assert.equal(typeof captured[0].sessions, 'object');
    assert.equal(captured[0].sessions === null, false, '不得再传 sessions:null');
    // E2/E1-fix：先 ensure lifecycle，再把真实 sessionId 交给 hook（不再伪造 null）。
    assert.equal(captured[0].backgroundSessionId, 'sid-patrol', 'hook 必须收到 lifecycle ensure 出的 sessionId');
    assert.equal(typeof captured[0].audit, 'object');
    assert.ok(auditCaptured.length >= 1);
    assert.ok(auditCaptured[0].filePath.includes('xiaoheihe-audit'), '默认真实审计目录 state/xiaoheihe-audit');
    // task-86（E1）：启用时生命周期 ensure 一次、调度器 start 一次。
    assert.equal(e1.ensureCalls.length, 1, 'lifecycle ensure 必须调用一次');
    assert.equal(e1.schedulerStarted.length, 1, 'scheduler 必须 start 一次');
    assert.equal(harness.getBackgroundPatrolSessionId(), 'sid-patrol', '全局身份必须回填 lifecycle sessionId');
    const runtime = harness.getBackgroundPatrolRuntime();
    assert.ok(runtime !== null, '运行时必须存在');
    await harness.stopBackgroundPatrolRuntime();
    assert.equal(harness.getBackgroundPatrolRuntime(), null);
  } finally {
    await harness.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// task-56 F1/F2/F3/F4/F5/F7 补齐。
// ─────────────────────────────────────────────────────────────────────────────

test('F1 落盘：12 次 reserve+commit 后 store readCount=12；第 13 次 reserve deny；重启仍 deny', async () => {
  const dir = await makeDir();
  const storePath = path.join(dir, 'controller.json');
  const hook = makeHook({ storePath });
  const { url } = await hook.start();
  try {
    for (let index = 0; index < 14; index += 1) {
      const reserved = await authorize(url, {
        agentKey: BG,
        tool: index % 2 === 0 ? 'mcp__xiaoheihe__get_home_content' : 'mcp__xiaoheihe__get_post_detail',
        args: { id: `read-${index}` },
      });
      assert.equal(reserved.status, 200);
      assert.equal(reserved.body.decision, 'allow', `第 ${index + 1} 次 reserve 应 allow`);
      const committed = await commit(url, reserved.body.ticket);
      assert.equal(committed.status, 200);
      assert.equal(committed.body.ok, true, `第 ${index + 1} 次 commit 应成功`);
      assert.equal(committed.body.started, true);
    }
    const status = await hook.statusAsync();
    assert.equal(status.readUsed, 14, 'commit 后 readUsed=14');
    assert.equal(status.reservedRead, 0, 'commit 后 reservedRead=0');
    assert.equal(hook.status().readUsed, 14, '同步 status 也应暴露 commit 后的 used');

    const over = await authorize(url, {
      agentKey: BG,
      tool: 'mcp__xiaoheihe__get_home_content',
      args: { id: 'read-over' },
    });
    assert.equal(over.body.decision, 'deny', '第 13 次 reserve 必须 deny');
    assert.equal(over.body.reason, 'read-daily-cap');
  } finally {
    await hook.close();
  }

  const raw = await fs.readFile(storePath, 'utf8');
  assert.match(raw, /"readCount":14/, '14 次 commit 必须落盘 readCount=14');
  assert.match(raw, /"day":/, '落盘内容应为 controller 状态');

  const restarted = makeHook({ storePath });
  const again = await restarted.start();
  try {
    const response = await authorize(again.url, {
      agentKey: BG,
      tool: 'mcp__xiaoheihe__get_home_content',
      args: { id: 'read-after-restart' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.decision, 'deny', '重启后第 13 次仍必须 deny');
    assert.equal(response.body.reason, 'read-daily-cap');
  } finally {
    await restarted.close();
  }
});

test('B3 reserve 不落盘；abort 释放预占；commit 后 abort 回滚且 store 恢复', async () => {
  const dir = await makeDir();
  const storePath = path.join(dir, 'controller.json');
  const hook = makeHook({ storePath });
  const { url } = await hook.start();
  try {
    const reserved = await authorize(url, {
      agentKey: BG,
      tool: 'mcp__xiaoheihe__get_home_content',
      args: { id: 'read-reserve' },
    });
    assert.equal(reserved.body.decision, 'allow');
    await assert.rejects(() => fs.access(storePath), 'reserve 不得落盘');
    const statusAfterReserve = await hook.statusAsync();
    assert.equal(statusAfterReserve.reservedRead, 1, 'status 暴露 reservedRead=1');
    assert.equal(statusAfterReserve.readUsed, 0, 'reserve 不计 used');
    const aborted = await abort(url, reserved.body.ticket);
    assert.equal(aborted.status, 200);
    assert.equal(aborted.body.ok, true);
    const statusAfterAbort = await hook.statusAsync();
    assert.equal(statusAfterAbort.reservedRead, 0);
    assert.equal(statusAfterAbort.readUsed, 0);
    await assert.rejects(() => fs.access(storePath), '未 commit 的 abort 不需落盘');

    const reserved2 = await authorize(url, {
      agentKey: BG,
      tool: 'mcp__xiaoheihe__get_home_content',
      args: { id: 'read-commit-abort' },
    });
    const committed = await commit(url, reserved2.body.ticket);
    assert.equal(committed.body.ok, true);
    assert.match(await fs.readFile(storePath, 'utf8'), /"readCount":1/, 'commit 后 readCount=1');
    const rolled = await abort(url, reserved2.body.ticket);
    assert.equal(rolled.status, 200);
    assert.equal(rolled.body.ok, true);
    assert.equal(rolled.body.rolledBack, true);
    assert.match(await fs.readFile(storePath, 'utf8'), /"readCount":0/, 'abort 后 store 回滚 readCount=0');
    const finalStatus = await hook.statusAsync();
    assert.equal(finalStatus.readUsed, 0);
    assert.equal(finalStatus.reservedRead, 0);
    assert.equal(hook.status().readUsed, 0, '同步 status 应反映 abort 回滚后的 used');
  } finally {
    await hook.close();
  }
});

test('F1 暂停落盘：另一个 store 写入 accessPaused 后，hook 重启仍拒绝读写', async () => {
  const dir = await makeDir();
  const storePath = path.join(dir, 'controller.json');
  const store = createXhhOperationStore({ filePath: storePath });
  await store.load();
  const paused = await store.controller.reportAccessUnavailable({ reason: 'captcha', now: Date.now() });
  assert.equal(paused.ok, true);
  const saved = await store.save();
  assert.notEqual(saved?.ok, false, '暂停状态必须能保存');
  await store.close();

  const hook = makeHook({ storePath });
  const { url } = await hook.start();
  try {
    for (const tool of ['mcp__xiaoheihe__get_home_content', 'mcp__xiaoheihe__publish_content']) {
      const args = tool.endsWith('publish_content') ? { operationId: 'op-paused' } : {};
      const response = await post(`${url}/api/xiaoheihe/authorize`, { agentKey: BG, tool, args }, { 'x-console-token': TOKEN });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.decision, 'deny');
      assert.equal(body.reason, 'access-paused');
    }
  } finally {
    await hook.close();
  }
});

test('F1 persist 失败（B3）：reserve allow 但不落盘；commit 返回 persist-failed，store 不生成且不放行', async () => {
  const dir = await makeDir();
  const storePath = path.join(dir, 'controller.json');
  const hook = makeHook({
    storePath,
    fsOps: {
      rename: async () => { throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' }); },
    },
  });
  const { url } = await hook.start();
  try {
    const reserved = await authorize(url, {
      agentKey: BG,
      tool: 'mcp__xiaoheihe__get_home_content',
      args: { id: 'p1' },
    });
    assert.equal(reserved.status, 200);
    assert.equal(reserved.body.decision, 'allow', 'reserve 阶段不应因 persist 失败而拒绝');
    await assert.rejects(() => fs.access(storePath), 'reserve 不得落盘');
    const committed = await commit(url, reserved.body.ticket);
    assert.equal(committed.status, 200);
    assert.equal(committed.body.ok, false);
    assert.equal(committed.body.reason, 'persist-failed', 'commit 落盘失败必须拒绝执行');
    await assert.rejects(() => fs.access(storePath), '落盘失败不得出现 store 文件');
    // 回滚已消费 controller 票据；重试不得 started（具体拒绝码由 API 决定，不作为保证）。
    const retry = await commit(url, reserved.body.ticket);
    assert.equal(retry.body.ok, false);
  } finally {
    await hook.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// task-134b / reload 分叉部署阻断回归（真实 hook+API，离线）：
// store.reload 会替换 controller 实例。若 hook 的 controllerForApi 捕获旧实例，API 写路径会
// 落在孤儿 controller 上（额度不落盘）；若 ticketId 序列在新实例上从 0 重来，旧票据还可能
// 静默命中新 controller 的同号预占。以下用「旧版暂停状态」触发迁移落盘，并用 fsOps.rename
// 首次失败制造一次真实的保存失败 → reload，然后验证旧票据被拒、新额度按新实例落盘。
// ─────────────────────────────────────────────────────────────────────────────

async function writeLegacyPausedState(storePath) {
  // 造出「尚无转换事件 id」的暂停状态：ensureTransitionIds 会迁移它，从而触发迁移落盘。
  const store = createXhhOperationStore({ filePath: storePath });
  await store.load();
  const state = JSON.parse(store.controller.serialize());
  await store.close();
  state.writePaused = true;
  state.writeReason = 'consecutive-failures';
  state.consecutiveWriteFailures = 3; // parse 要求与 writePaused 强一致
  delete state.writePauseEventId;
  delete state.writePauseAt;
  delete state.accessPauseEventId;
  delete state.accessPauseAt;
  delete state.lastRecoverEventId;
  delete state.transitionEvents;
  delete state.transitionSeq;
  await fs.writeFile(storePath, JSON.stringify(state), 'utf8');
}

function failFirstRename() {
  const stats = { renames: 0 };
  return {
    stats,
    fsOps: {
      rename: async (...args) => {
        stats.renames += 1;
        if (stats.renames === 1) throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
        return fs.rename(...args);
      },
    },
  };
}

async function reconcileOnce(hook) {
  return hook.reconcile({
    enqueue: async () => ({ ok: true, id: 'reconcile-event' }),
    isDelivered: async () => ({ ok: true, delivered: false }),
  });
}

test('reload 分叉阻断 T1：保存失败→reload 后旧票据必须被拒绝，不得静默提交新预占', async () => {
  const dir = await makeDir();
  const storePath = path.join(dir, 'controller.json');
  await writeLegacyPausedState(storePath);
  const { stats, fsOps } = failFirstRename();
  const hook = makeHook({ storePath, fsOps });
  const { url } = await hook.start();
  try {
    // reload 前：writePaused 只挡写，读仍可预占；票据只存在于旧 controller 内存。
    const old = await authorize(url, {
      agentKey: BG,
      tool: 'mcp__xiaoheihe__get_home_content',
      args: { id: 'p1' },
    });
    assert.equal(old.status, 200);
    assert.equal(old.body.decision, 'allow', JSON.stringify(old.body));
    const oldTicket = old.body.ticket;

    const reconciled = await reconcileOnce(hook);
    assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
    assert.equal(reconciled.persisted, true, 'reload 后重做的迁移落盘必须成功');
    assert.ok(stats.renames >= 2, `必须发生「保存失败→reload→重试保存」，实际 rename=${stats.renames}`);
    assert.equal(hook.status().lastReconcile.controllerReloads, 1, '对账结果必须暴露 reload 次数，便于运行期观察');

    // reload 后：新 controller 上再预占；两张票据 id 不得重号。
    const fresh = await authorize(url, {
      agentKey: BG,
      tool: 'mcp__xiaoheihe__get_home_content',
      args: { id: 'p2' },
    });
    assert.equal(fresh.body.decision, 'allow', JSON.stringify(fresh.body));
    assert.notEqual(fresh.body.ticket.ticketId, oldTicket.ticketId, 'reload 后新 controller 不得沿用旧票据 id');

    // 旧票据必须被新 controller 拒绝（插件据此 deny，不得派发）。
    const oldCommit = await commit(url, oldTicket);
    assert.equal(oldCommit.body.ok, false, `旧票据不得提交成功：${JSON.stringify(oldCommit.body)}`);
    assert.equal(oldCommit.body.reason, 'invalid-ticket');

    // 新票据正常计数，且只按新 controller 的事实落盘一次。
    const freshCommit = await commit(url, fresh.body.ticket);
    assert.equal(freshCommit.body.ok, true, JSON.stringify(freshCommit.body));
    const disk = JSON.parse(await fs.readFile(storePath, 'utf8'));
    assert.equal(disk.readCount, 1, 'reload 后的读取额度必须落盘到新 controller 状态');
  } finally {
    await hook.close();
  }
});

test('reload 分叉阻断 T2：reload 后的额度必须按新 controller 持久化，重启后仍可读', async () => {
  const dir = await makeDir();
  const storePath = path.join(dir, 'controller.json');
  await writeLegacyPausedState(storePath);
  const { fsOps } = failFirstRename();
  const hook = makeHook({ storePath, fsOps });
  const { url } = await hook.start();
  try {
    const reconciled = await reconcileOnce(hook);
    assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
    assert.equal(reconciled.persisted, true);

    const read = await authorize(url, {
      agentKey: BG,
      tool: 'mcp__xiaoheihe__get_home_content',
      args: { id: 'p1' },
    });
    assert.equal(read.body.decision, 'allow', JSON.stringify(read.body));
    const committed = await commit(url, read.body.ticket);
    assert.equal(committed.body.ok, true, JSON.stringify(committed.body));

    const disk = JSON.parse(await fs.readFile(storePath, 'utf8'));
    assert.equal(disk.readCount, 1, 'reload 后授权并提交的读取必须落盘（旧 controller 上计数=丢失）');
    assert.equal(disk.writePaused, true, 'legacy 暂停事实不得被 reload 覆盖');
    await hook.close();

    const restarted = createXhhOperationStore({ filePath: storePath });
    await restarted.load();
    try {
      const status = await restarted.controller.status();
      assert.equal(status.read.used, 1, '重启后必须读到正确的读取额度');
      assert.equal(status.writePaused, true);
    } finally {
      await restarted.close();
    }
  } finally {
    await hook.close();
  }
});

test('F4 start 失败统一 close 并置 null：非法 host 返回 invalid-options，status.closed=true，再次 start 为 closed', async () => {
  const dir = await makeDir();
  const hook = makeHook({ storePath: path.join(dir, 'controller.json'), host: '0.0.0.0' });
  const result = await hook.start();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid-options');
  const status = hook.status();
  assert.equal(status.closed, true);
  assert.equal(status.started, false);
  assert.deepEqual(await hook.start(), { ok: false, error: 'closed' });
});

test('F5 启动成功后 warn：sessions 为空（所有 agentKey 会 deny）且 audit 未注入（审计不落盘）', async () => {
  const dir = await makeDir();
  const warnings = [];
  const hook = makeHook({
    storePath: path.join(dir, 'controller.json'),
    sessions: null,
    logger: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
  });
  const started = await hook.start();
  assert.equal(started.ok, true);
  await hook.close();
  const serialized = JSON.stringify(warnings);
  assert.ok(serialized.includes('no-session-identity'), `缺少 sessions 告警：${serialized}`);
  assert.ok(serialized.includes('audit-disabled'), `缺少 audit 告警：${serialized}`);
});

test('F7 token 最小长度：31 字符 → weak-authorize-token；32 字符可启动', async () => {
  const dir = await makeDir();
  const weak = makeHook({ storePath: path.join(dir, 'weak.json'), consoleToken: 'a'.repeat(31) });
  assert.deepEqual(await weak.start(), { ok: false, error: 'weak-authorize-token' });
  const strong = makeHook({ storePath: path.join(dir, 'strong.json'), consoleToken: 'a'.repeat(32) });
  const started = await strong.start();
  assert.equal(started.ok, true);
  await strong.close();
});

test('F2/F3/F7 bridge 接线静态：shutdown 重入保护 + async 异常仍 exit(0) + token 最小长度校验', async () => {
  const source = await fs.readFile(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(source, /let shuttingDown = false;/);
  assert.match(source, /if \(shuttingDown\) return;/);
  assert.match(source, /weak-authorize-token/);
  const shutdownIndex = source.indexOf('async function shutdownBridge');
  assert.ok(shutdownIndex > 0);
  // 按**函数边界**切片，而不是固定字符窗口。
  // 这里原本是 `source.slice(shutdownIndex, shutdownIndex + 1600)`，而 shutdownBridge
  // 每加一段关停逻辑就会变长 —— 断言于是退化成「函数变长就红」，与它想钉的东西
  // （异步回调里的 process.exit(0)）毫无关系。逐版本实测的偏移：
  //   1ba98df=685、9c422c1/d17d287=861、e9f2ab2=1234、39093ee=1656、HEAD=1643。
  // 39093ee（qzone C5：关停时先关写入许可 IPC listener）把它顶出 1600 窗口，此后
  // 两个门禁套件（full + quick）一起红。固定窗口只会把问题往后推一次，所以改成
  // 切到**本函数自己的收尾大括号**为止：顶格的 `\n}\n`。函数体缩进两格，内部块的
  // 收尾都是 `\n  }`，所以顶格 `}}` 只可能是这个函数的结尾。
  // 找不到边界（例如函数被挪到文件末尾且没有尾随换行）就退化为切到文件末 —— 宁可
  // 让下面的断言去判断内容，也不要静默截出一个空片段。
  const shutdownBoundary = /\r?\n\}\r?\n/.exec(source.slice(shutdownIndex));
  const shutdownBlock = shutdownBoundary === null
    ? source.slice(shutdownIndex)
    : source.slice(shutdownIndex, shutdownIndex + shutdownBoundary.index + shutdownBoundary[0].length);
  assert.ok(shutdownBlock.length > 0, 'shutdownBridge 片段不能为空（切片边界失效）');
  assert.match(shutdownBlock, /try \{/);
  assert.match(shutdownBlock, /catch \(error\)/);
  // 单独一条断言、自带说明：这一句缺失时，最可能的原因是**切片边界失效**，而不是
  // 产品代码丢了退出语句 —— 两者的排查方向完全不同，报错必须能区分。
  assert.ok(
    shutdownBlock.includes('process.exit(0);'),
    `shutdownBridge 片段（${shutdownBlock.length} 字符）里找不到 process.exit(0);：`
    + '先查切片边界是否失效，再查 src/bridge.js 的关停路径',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// task-78：身份映射（sessions/backgroundSessionId/ownerQQ/groupExempt）+ 真实审计接线。
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_QQ = 1234567890;

function mapperSessions() {
  return {
    [`private:${OWNER_QQ}`]: 'sid-owner',
    'group:123456': 'sid-group',
    'private:999000111': 'sid-guest',
  };
}

function makeMapperHook(dir, overrides = {}) {
  return createBackgroundPatrolBridgeHook({
    config: enabledConfig(),
    consoleToken: TOKEN,
    controllerStorePath: path.join(dir, 'controller.json'),
    ownerQQ: OWNER_QQ,
    sessions: mapperSessions(),
    backgroundSessionId: 'sid-bg',
    ...overrides,
  });
}

test('来源不明：owner 与群会话无可信指令证明时按自主读取预留额度', async () => {
  const dir = await makeDir();
  const hook = makeMapperHook(dir);
  const { url } = await hook.start();
  try {
    for (const agentKey of ['sid-owner', 'sid-group']) {
      const response = await authorize(url, { agentKey, tool: 'mcp__xiaoheihe__get_home_content', args: {} });
      assert.equal(response.body.decision, 'allow');
      assert.equal(response.body.exemption, 'quota');
      assert.equal(response.body.ticket.state, 'reserved');
    }
    const unknown = await authorize(url, { agentKey: 'sid-not-in-map', tool: 'mcp__xiaoheihe__get_home_content', args: {} });
    assert.equal(unknown.body.decision, 'deny');
    assert.equal(unknown.body.reason, 'unknown-agent');
  } finally { await hook.close(); }
});

test('身份映射实时更新：会话新建后可计额，撤销或歧义后拒绝', async () => {
  const dir = await makeDir();
  const sessions = {};
  const hook = makeMapperHook(dir, { sessions });
  const { url } = await hook.start();
  const read = (agentKey) => authorize(url, { agentKey, tool: 'mcp__xiaoheihe__get_home_content', args: {} });
  try {
    assert.equal((await read('sid-new')).body.reason, 'unknown-agent');
    sessions[`private:${OWNER_QQ}`] = 'sid-new';
    const known = await read('sid-new');
    assert.equal(known.body.decision, 'allow');
    assert.equal(known.body.exemption, 'quota');
    sessions['group:123456'] = 'sid-new';
    assert.equal((await read('sid-new')).body.reason, 'unknown-agent');
    delete sessions['group:123456'];
    delete sessions[`private:${OWNER_QQ}`];
    assert.equal((await read('sid-new')).body.reason, 'unknown-agent');
  } finally { await hook.close(); }
});

test('后台会话轮换：只信当前映射，旧会话、冲突和清空后必须拒绝', async () => {
  const dir = await makeDir();
  let sessions = { 'patrol:background': 'sid-bg' };
  const hook = makeMapperHook(dir, { sessions, sessionsProvider: () => sessions });
  const { url } = await hook.start();
  const read = (agentKey) => authorize(url, { agentKey, tool: 'mcp__xiaoheihe__get_home_content', args: {} });
  try {
    assert.equal((await read('sid-bg')).body.decision, 'allow');
    sessions = { 'patrol:background': 'sid-new-bg' };
    assert.equal((await read('sid-bg')).body.reason, 'unknown-agent');
    assert.equal((await read('sid-new-bg')).body.exemption, 'quota');
    sessions['group:123456'] = 'sid-new-bg';
    assert.equal((await read('sid-new-bg')).body.reason, 'unknown-agent');
    sessions = {};
    assert.equal((await read('sid-new-bg')).body.reason, 'unknown-agent');
    assert.equal((await read('sid-bg')).body.reason, 'unknown-agent');
  } finally { await hook.close(); }
});

test('身份映射 provider 替换或异常：新映射生效，旧映射与异常状态拒绝', async () => {
  const dir = await makeDir();
  let sessions = { [`private:${OWNER_QQ}`]: 'sid-old' };
  let broken = false;
  const hook = makeMapperHook(dir, { sessions, sessionsProvider: () => { if (broken) throw new Error('fixture'); return sessions; } });
  const { url } = await hook.start();
  const read = (agentKey) => authorize(url, { agentKey, tool: 'mcp__xiaoheihe__get_home_content', args: {} });
  try {
    assert.equal((await read('sid-old')).body.decision, 'allow');
    sessions = { [`private:${OWNER_QQ}`]: 'sid-new' };
    assert.equal((await read('sid-old')).body.reason, 'unknown-agent');
    assert.equal((await read('sid-new')).body.exemption, 'quota');
    broken = true;
    assert.equal((await read('sid-new')).body.reason, 'unknown-agent');
  } finally { await hook.close(); }
});

test('task-78 身份矩阵：patrol、owner、允许的 group 计入 / 其它 unknown deny', async () => {
  const dir = await makeDir();
  const hook = makeMapperHook(dir);
  const { url } = await hook.start();
  try {
    const patrol = await authorize(url, { agentKey: 'sid-bg', tool: 'mcp__xiaoheihe__get_home_content', args: { id: 'r1' } });
    assert.equal(patrol.body.decision, 'allow');
    assert.equal(patrol.body.exemption, 'quota');
    assert.equal(patrol.body.counted, false);
    assert.equal(patrol.body.ticket.state, 'reserved');

    const owner = await authorize(url, { agentKey: 'sid-owner', tool: 'mcp__xiaoheihe__get_home_content', args: {} });
    assert.equal(owner.body.decision, 'allow');
    assert.equal(owner.body.exemption, 'quota');
    assert.equal(owner.body.ticket.state, 'reserved');

    const group = await authorize(url, { agentKey: 'sid-group', tool: 'mcp__xiaoheihe__get_home_content', args: {} });
    assert.equal(group.body.decision, 'allow', '已知群会话可以申请额度');
    assert.equal(group.body.exemption, 'quota');

    const guest = await authorize(url, { agentKey: 'sid-guest', tool: 'mcp__xiaoheihe__get_home_content', args: {} });
    assert.equal(guest.body.decision, 'deny');
    assert.equal(guest.body.reason, 'unknown-agent');

    const unknown = await authorize(url, { agentKey: 'sid-not-in-map', tool: 'mcp__xiaoheihe__get_home_content', args: {} });
    assert.equal(unknown.body.decision, 'deny');
    assert.equal(unknown.body.reason, 'unknown-agent');

    const status = hook.status();
    assert.equal(status.identityMode, 'mapper');
    assert.equal(status.hasBackgroundSessionId, true);
  } finally {
    await hook.close();
  }
});

test('task-78 groupExempt=false：群会话 deny（owner 计额）；backgroundSessionId=null 时 patrol deny 且 warn', async () => {
  const dir = await makeDir();
  const strict = makeMapperHook(dir, { groupExempt: false, controllerStorePath: path.join(dir, 'strict.json') });
  const strictStarted = await strict.start();
  try {
    const group = await authorize(strictStarted.url, { agentKey: 'sid-group', tool: 'mcp__xiaoheihe__get_home_content', args: {} });
    assert.equal(group.body.decision, 'deny');
    assert.equal(group.body.reason, 'unknown-agent');
    const owner = await authorize(strictStarted.url, { agentKey: 'sid-owner', tool: 'mcp__xiaoheihe__get_home_content', args: {} });
    assert.equal(owner.body.decision, 'allow');
    assert.equal(owner.body.exemption, 'quota');
  } finally {
    await strict.close();
  }

  const warnings = [];
  const noBg = makeMapperHook(dir, {
    controllerStorePath: path.join(dir, 'no-bg.json'),
    backgroundSessionId: null,
    logger: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
  });
  const started = await noBg.start();
  try {
    const patrol = await authorize(started.url, { agentKey: 'sid-bg', tool: 'mcp__xiaoheihe__get_home_content', args: {} });
    assert.equal(patrol.body.decision, 'deny', 'backgroundSessionId=null 时不得把任意会话当后台会话');
    assert.equal(patrol.body.reason, 'unknown-agent');
    assert.equal(noBg.status().hasBackgroundSessionId, false);
    assert.ok(JSON.stringify(warnings).includes('no-session-identity'), '不得伪造 backgroundSessionId，必须 warn');
  } finally {
    await noBg.close();
  }
});

test('task-78 审计落盘：authorize/commit/complete/abort 固定字段、无 token/args/QQ 原文', async () => {
  const dir = await makeDir();
  const auditDir = path.join(dir, 'audit');
  const audit = createBackgroundPatrolAudit({ filePath: auditDir });
  const hook = makeMapperHook(dir, { audit });
  const { url } = await hook.start();
  try {
    // P2-1：首次对账完成前写被 fail-closed 拒绝；本用例先完成一次对账（读不受影响，但保持契约一致）。
    const reconciled = await hook.reconcile({ enqueue: async () => ({ ok: true, id: 'audit' }), isDelivered: async () => ({ ok: true, delivered: false }) });
    assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
    const allowed = await authorize(url, {
      agentKey: 'sid-bg',
      tool: 'mcp__xiaoheihe__get_home_content',
      args: { id: 'audit-read', text: 'SENSITIVE_ARGS' },
    });
    assert.equal(allowed.body.decision, 'allow');
    const committed = await commit(url, allowed.body.ticket, 'sid-bg');
    assert.equal(committed.body.started, true);
    const completed = await post(`${url}/api/xiaoheihe/complete`, { ticket: allowed.body.ticket, outcome: 'success' }, { 'x-console-token': TOKEN });
    assert.equal(completed.status, 200);

    const writeAllowed = await authorize(url, {
      agentKey: 'sid-owner',
      tool: 'mcp__xiaoheihe__publish_content',
      args: { operationId: 'audit-op', content: 'SENSITIVE_ARGS' },
    });
    const aborted = await abort(url, writeAllowed.body.ticket, 'sid-owner');
    assert.equal(aborted.body.ok, true);

    const denied = await authorize(url, { agentKey: 'sid-guest', tool: 'mcp__xiaoheihe__get_home_content', args: { text: 'SENSITIVE_ARGS' } });
    assert.equal(denied.body.decision, 'deny');

    // 审计写入是异步的（adapter fire-and-forget），稍等后读盘。
    await new Promise((resolve) => setTimeout(resolve, 100));
    const read = await audit.readDay();
    assert.equal(read.ok, true);
    assert.ok(read.records.length >= 4, `审计记录应覆盖 authorize/commit/complete/abort，实际 ${read.records.length}`);
    const keys = ['action', 'at', 'day', 'opId', 'platform', 'quota', 'reason', 'result', 'v'];
    const actions = new Set();
    for (const record of read.records) {
      assert.deepEqual(Object.keys(record).sort(), keys);
      assert.equal(record.platform, 'xiaoheihe');
      assert.ok(['read', 'write', 'skip', 'pause', 'resume', 'report', 'unknown'].includes(record.action));
      assert.ok(['allowed', 'denied', 'success', 'failure', 'unknown'].includes(record.result));
      actions.add(record.action);
    }
    assert.ok(actions.has('read'), '必须记录读');
    assert.ok(actions.has('write'), '必须记录写');
    assert.ok(actions.has('skip'), '必须记录 deny/skip');
    const files = (await fs.readdir(auditDir)).filter((name) => name.startsWith('background-patrol-audit-') && name.endsWith('.jsonl'));
    assert.equal(files.length, 1, '审计固定文件命名');
    const raw = await fs.readFile(path.join(auditDir, files[0]), 'utf8');
    assert.ok(!raw.includes(TOKEN), '审计不得含 token');
    assert.ok(!raw.includes('SENSITIVE_ARGS'), '审计不得含 args 原文');
    assert.ok(!raw.includes(String(OWNER_QQ)), '审计不得含 QQ 号原文');
  } finally {
    await hook.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// task-86（E1）：lifecycle + schedule-store + scheduler 接线（harness fake）。
// ─────────────────────────────────────────────────────────────────────────────

function e1Config(extra = {}) {
  return {
    slang: { enabled: false },
    backgroundPatrol: { enabled: true, authorizeToken: 'independent-token-0123456789abcdef', ...extra },
  };
}

function fakeHookFactory() {
  return {
    async start() { return { ok: true, enabled: true, url: 'http://127.0.0.1:1', port: 1 }; },
    async stop() { return { stopped: true }; },
    status() { return { started: true, identityMode: 'mapper' }; },
    async reconcile() { return { ok: true, blocked: false }; },
  };
}

test('后台会话轮换后忙碌判定使用当前 id，不当成 QQ 回合', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({
    config: e1Config(),
    globals: { createBackgroundPatrolBridgeHook: fakeHookFactory, createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }), ...e1.globals },
  });
  try {
    const runtime = harness.getBackgroundPatrolRuntime();
    harness.state.sessions['patrol:background'] = 'sid-rotated';
    runtime.turns.set('sid-rotated', Date.now());
    assert.equal(runtime.isBackgroundTurnInFlight(), true);
    assert.equal(runtime.isQqBusy(), false);
    harness.setMode('reserved2');
    harness.setReady(true);
    const result = await harness.deliverPrompt('patrol:background', 'fixture', { backgroundPatrol: true });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'background-busy', '投递边界也必须采用轮换后的实时 id');
    assert.equal(harness.calls.prompts.length, 0);
  } finally { await harness.close(); }
});

test('后台机会投递时已有 QQ 请求排队则跳过，不能在后台等待补发', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({
    config: e1Config(),
    globals: { createBackgroundPatrolBridgeHook: fakeHookFactory, createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }), ...e1.globals },
  });
  try {
    harness.setMode('reserved2');
    harness.setReady(true);
    harness.promptQueues.set('group:123', { queue: [], running: true });
    const result = await harness.deliverPrompt('patrol:background', 'fixture', { backgroundPatrol: true });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'qq-busy');
    assert.equal(harness.promptQueues.has('patrol:background'), false);
  } finally {
    harness.promptQueues.delete('group:123');
    await harness.close();
  }
});

test('后台机会投递时 QQ 回合已在途则跳过', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({
    config: e1Config(),
    globals: { createBackgroundPatrolBridgeHook: fakeHookFactory, createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }), ...e1.globals },
  });
  try {
    harness.setMode('reserved2');
    harness.setReady(true);
    harness.getBackgroundPatrolRuntime().turns.set('fixture-qq-session', Date.now());
    const result = await harness.deliverPrompt('patrol:background', 'fixture', { backgroundPatrol: true });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'qq-busy');
    assert.equal(harness.promptQueues.has('patrol:background'), false);
  } finally {
    await harness.close();
  }
});

test('后台机会投递前 DSH 断线时跳过，不进入离线队列', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({
    config: e1Config(),
    globals: { createBackgroundPatrolBridgeHook: fakeHookFactory, createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }), ...e1.globals },
  });
  try {
    harness.setMode('reserved2');
    harness.setReady(false);
    const result = await harness.deliverPrompt('patrol:background', 'fixture', { backgroundPatrol: true });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'dsh-unavailable');
    assert.equal(harness.queued.has('patrol:background'), false);
  } finally {
    await harness.close();
  }
});

test('E1 启用：lifecycle ensure→scheduler start；恢复未来 nextAt、过期机会不补；stop 幂等释放', async () => {
  const now = Date.now();
  const future = now + 3600000;
  const expired = now - 60000;
  const e1 = makeFakeE1({
    storeState: {
      generation: 3,
      platforms: {
        tieba: { nextAt: future, lastRunAt: null, lastRunGeneration: null },
        xiaoheihe: { nextAt: expired, lastRunAt: null, lastRunGeneration: null },
      },
    },
  });
  const harness = await bridgeHarness({
    config: e1Config(),
    globals: { createBackgroundPatrolBridgeHook: fakeHookFactory, createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }), ...e1.globals },
  });
  try {
    assert.equal(e1.ensureCalls.length, 1);
    assert.equal(e1.schedulerStarted.length, 1);
    assert.equal(e1.schedulerOptions.length, 1);
    assert.equal(e1.schedulerOptions[0].initialNextAt.tieba, future, '未来 nextAt 必须恢复');
    assert.equal(e1.schedulerOptions[0].initialNextAt.xiaoheihe, null, '过期机会不得补执行');
    assert.equal(e1.schedulerOptions[0].initialNextAt.tieba > now, true);
    const runtime = harness.getBackgroundPatrolRuntime();
    assert.ok(runtime !== null);
    const first = await harness.stopBackgroundPatrolRuntime();
    assert.equal(first.stopped, true);
    assert.equal(first.schedulerStopped, true);
    assert.equal(first.lifecycleClosed, true);
    assert.equal(first.storeClosed, true);
    assert.equal(harness.getBackgroundPatrolRuntime(), null);
    const second = await harness.stopBackgroundPatrolRuntime();
    assert.equal(second.stopped, false);
    assert.equal(e1.schedulerStops.length, 1, 'stop 幂等：scheduler.stop 只调一次');
    assert.equal(e1.closes.lifecycle, 1, 'lifecycle.close 只调一次');
    assert.equal(e1.closes.store, 1, 'store.close 只调一次');
  } finally {
    await harness.close();
  }
});

test('E1 机会：ready → dispatch 一次；busy/暂停 skip 零 dispatch、零扣额（只落 skip 原因）', async () => {
  const dispatched = [];
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({
    config: e1Config(),
    globals: {
      createBackgroundPatrolBridgeHook: fakeHookFactory,
      createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
      ...e1.globals,
      backgroundPatrolDispatchOpportunity: async (platform, opportunity) => {
        dispatched.push({ platform, opportunity });
        return { ok: true };
      },
    },
  });
  try {
    const options = e1.schedulerOptions[0];
    const now = Date.now();
    await options.run({ platform: 'tieba', startedAt: now });
    assert.equal(dispatched.length, 1, '一次机会只 dispatch 一次');
    assert.equal(dispatched[0].platform, 'tieba');
    assert.equal(dispatched[0].opportunity.platform, 'tieba');
    assert.equal(e1.marks.filter((mark) => mark.kind === 'run').length, 1);
    assert.equal(e1.marks[0].generation, 1, '机会使用当前持久代次');

    // scheduler 判定 skip（QQ 忙/暂停/DSH 不可用）→ 不 dispatch、只记 skip 原因。
    options.onEvent({ type: 'skipped', platform: 'xiaoheihe', at: now + 1, reason: 'qq-busy' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(dispatched.length, 1, 'skip 不得触发 dispatch/扣额');
    const skip = e1.marks.find((mark) => mark.kind === 'skip');
    assert.equal(skip.platform, 'xiaoheihe');
    assert.equal(skip.reason, 'qq-busy');
    assert.equal(skip.generation, 1);

    // 未注入 dispatch（默认）→ E2 真实后台会话投递路径（不再 dispatch-not-wired）。
    const e1b = makeFakeE1();
    const harness2 = await bridgeHarness({
      config: e1Config(),
      globals: { createBackgroundPatrolBridgeHook: fakeHookFactory, createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }), ...e1b.globals },
    });
    try {
      const result = await e1b.schedulerOptions[0].run({ platform: 'xiaoheihe', startedAt: Date.now() });
      assert.notEqual(result.reason, 'dispatch-not-wired', 'E2 必须走真实后台会话投递路径');
      assert.ok(typeof result.ok === 'boolean');
      assert.equal(e1b.marks.filter((mark) => mark.kind === 'run').length, 1);
    } finally {
      await harness2.stopBackgroundPatrolRuntime();
      await harness2.close();
    }
  } finally {
    await harness.stopBackgroundPatrolRuntime();
    await harness.close();
  }
});

test('后台映射清空后不沿用启动 id，也不重建或投递', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({
    config: e1Config({ platforms: { xiaoheihe: true } }),
    globals: { createBackgroundPatrolBridgeHook: fakeHookFactory, createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }), ...e1.globals },
  });
  try {
    delete harness.state.sessions['patrol:background'];
    const result = await e1.schedulerOptions[0].run({ platform: 'xiaoheihe', startedAt: Date.now() });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'background-session-missing');
    assert.equal(harness.calls.prompts.length, 0);
    assert.equal(harness.state.sessions['patrol:background'], undefined);
  } finally { await harness.close(); }
});

test('终审 blocking⑥：hook 无 reconcile 时调度 fail-closed skip，零投递', async () => {
  const e1 = makeFakeE1();
  const hookFactoryWithoutReconcile = () => ({
    async start() { return { ok: true, enabled: true, url: 'http://127.0.0.1:1', port: 1 }; },
    async stop() { return { stopped: true }; },
    status() { return { started: true, identityMode: 'mapper' }; },
  });
  const harness = await bridgeHarness({
    config: e1Config({ platforms: { xiaoheihe: true } }),
    globals: { createBackgroundPatrolBridgeHook: hookFactoryWithoutReconcile, createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }), ...e1.globals },
  });
  try {
    await harness.ensureSession('patrol:background');
    const result = await e1.schedulerOptions[0].run({ platform: 'xiaoheihe', startedAt: Date.now() });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'reconcile-not-run', JSON.stringify(result));
    assert.equal(harness.calls.prompts.length, 0, '无 reconcile 时不得投递');
  } finally { await harness.close(); }
});
test('E2 真实巡逻投递：复用管理员私聊会话，不走固定汇报块', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({
    config: e1Config({ platforms: { tieba: true, xiaoheihe: true } }),
    globals: { createBackgroundPatrolBridgeHook: fakeHookFactory, createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }), ...e1.globals },
  });
  try {
    assert.equal(harness.getBackgroundPatrolSessionId(), 'sid-patrol');
    // 假 lifecycle 不会调用真实 sessionsAdapter，显式建立和生产相同的可信映射。
    await harness.ensureSession('patrol:background');
    const ownerSession = await harness.ensureSession('private:123');
    const result = await e1.schedulerOptions[0].run({ platform: 'xiaoheihe', startedAt: Date.now() });
    assert.equal(result.ok, true, JSON.stringify(result));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(harness.calls.prompts.length, 1, '后台回合必须投递一次到 DSH');
    const promptCall = harness.calls.prompts[0];
    assert.equal(promptCall.sessionId, ownerSession, '机会必须投递到管理员现有会话');
    assert.equal(result.sessionId, promptCall.sessionId, '投递回执必须使用实际 DSH 会话，不能沿用启动时旧 id');
    assert.equal('requestId' in result, false, '机会代次不是 DSH 请求 id，不能伪装成 requestId');
    const text = promptCall.content?.[0]?.text ?? '';
    assert.match(text, /是否分享，由你自行决定/);
    assert.match(text, /现有权限、暂停和额度规则/);
    assert.doesNotMatch(text, /不要向 QQ 发送任何消息|<patrol-report|禁止发帖/);
    // 输出隔离：后台 key 直接调用 sendToQQ 也不得发 QQ。
    await harness.sendToQQ('patrol:background', '后台输出不应外发');
    assert.equal(harness.calls.sent.length, 0, '后台输出不得自动转发 QQ');
  } finally {
    await harness.stopBackgroundPatrolRuntime();
    await harness.close();
  }
});

test('E1 lifecycle 失败 → 不启动调度器（fail-closed）；store 加载失败同样不启调度', async () => {
  const failed = makeFakeE1({ ensureResult: { ok: false, reason: 'create-failed' } });
  const capturedFailure = [];
  const captureHook = (options) => { capturedFailure.push(options); return fakeHookFactory(); };
  const harness = await bridgeHarness({
    config: e1Config(),
    globals: { createBackgroundPatrolBridgeHook: captureHook, createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }), ...failed.globals },
  });
  try {
    assert.equal(failed.ensureCalls.length, 1);
    assert.equal(failed.schedulerOptions.length, 0, 'lifecycle 失败不得创建调度器');
    assert.equal(failed.schedulerStarted.length, 0, 'lifecycle 失败不得启动调度');
    assert.equal(harness.getBackgroundPatrolRuntime(), null);
    assert.equal(harness.getBackgroundPatrolSessionId(), null, 'ensure 失败必须保持 null');
    assert.equal(capturedFailure[0].backgroundSessionId, null, 'ensure 失败 hook 收到 null（fail-closed deny）');
    const failureQueue = await harness.getBackgroundPatrolNotifyQueue().snapshot();
    const lifecycleNotice = [...failureQueue.items, ...failureQueue.recent]
      .some((item) => item.event === 'access-paused');
    assert.equal(lifecycleNotice, true, 'lifecycle 失败必须进入通知队列');
  } finally {
    await harness.close();
  }

  const badStore = makeFakeE1();
  const loadError = new Error('bad schedule state');
  loadError.code = 'BACKGROUND_PATROL_SCHEDULE_LOAD_FAILED';
  const failed2 = makeFakeE1({ loadError });
  const harness2 = await bridgeHarness({
    config: e1Config(),
    globals: { createBackgroundPatrolBridgeHook: fakeHookFactory, createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }), ...failed2.globals },
  });
  try {
    assert.equal(failed2.schedulerStarted.length, 0, 'store 加载失败不得启动调度');
    assert.equal(harness2.getBackgroundPatrolRuntime(), null);
  } finally {
    await harness2.close();
  }
});

test('E1 默认关闭：普通 config 不创建 lifecycle/store/scheduler（零副作用）', async () => {
  let lifecycleCalls = 0;
  const harness = await bridgeHarness({
    config: { slang: { enabled: false } },
    globals: {
      createBackgroundPatrolSessionLifecycle: () => { lifecycleCalls += 1; throw new Error('must not be called'); },
      createBackgroundPatrolScheduler: () => { lifecycleCalls += 1; throw new Error('must not be called'); },
      createBackgroundPatrolScheduleStore: () => { lifecycleCalls += 1; throw new Error('must not be called'); },
    },
  });
  try {
    assert.equal(lifecycleCalls, 0, '禁用路径不得创建 lifecycle/store/scheduler');
    assert.equal(harness.getBackgroundPatrolRuntime(), null);
  } finally {
    await harness.close();
  }
});

test('E2b 概率汇报：第 1 次读取 60% 抽中→owner 私聊一次；同 readIndex 不重复；边界相等不中', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({
    config: e1Config({ platforms: { tieba: true, xiaoheihe: true } }),
    globals: {
      createBackgroundPatrolBridgeHook: fakeHookFactory,
      createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
      ...e1.globals,
      backgroundPatrolReportRandom: () => 0.1,
    },
  });
  try {
    await fs.writeFile(path.join(harness.temp, 'state', 'xiaoheihe-operation-controller.json'), JSON.stringify({ schemaVersion: 1, day: '2026-10-26', readCount: 1 }));
    const first = await harness.maybeSendTiebaPatrolReport(1);
    assert.equal(first.deferred, true, JSON.stringify(first));
    await flushWithModel(harness);
    assert.equal(harness.calls.sent.length, 1, '抽中必须只发一次');
    assert.equal(harness.calls.sent[0].kind, 'private');
    assert.equal(harness.calls.sent[0].id, 123, '目的地必须是 owner');
    assert.match(harness.calls.sent[0].text, /第 1 次自主逛贴吧/);
    const repeat = await harness.maybeSendTiebaPatrolReport(1);
    assert.equal(repeat.sent, false, '同一 tieba used 不得重复发送');
    assert.equal(harness.calls.sent.length, 1);
  } finally {
    await harness.stopBackgroundPatrolRuntime();
    await harness.close();
  }

  // 边界：random === probability（0.6）不命中，不发。
  const e1b = makeFakeE1();
  const harness2 = await bridgeHarness({
    config: e1Config({ platforms: { xiaoheihe: true } }),
    globals: {
      createBackgroundPatrolBridgeHook: fakeHookFactory,
      createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
      ...e1b.globals,
      backgroundPatrolReportRandom: () => 0.6,
    },
  });
  try {
    await fs.writeFile(path.join(harness2.temp, 'state', 'xiaoheihe-operation-controller.json'), JSON.stringify({ schemaVersion: 1, day: '2026-10-26', readCount: 1 }));
    const boundary = await harness2.maybeSendTiebaPatrolReport(1);
    assert.equal(boundary.sent, false, 'random===probability 不得命中');
    assert.equal(harness2.calls.sent.length, 0);
  } finally {
    await harness2.stopBackgroundPatrolRuntime();
    await harness2.close();
  }
});

test('写入第三次失败事件立即通知，之后读取成功不能误报恢复', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({
    config: e1Config(),
    globals: { createBackgroundPatrolBridgeHook: fakeHookFactory, createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }), ...e1.globals },
  });
  try {
    await harness.onBackgroundPatrolAudit({ platform: 'xiaoheihe', action: 'write', result: 'failure', reason: 'write-paused' });
    assert.equal(harness.calls.sent.length, 1);
    assert.match(harness.calls.sent[0].text, /写操作已暂停/);
    await harness.onBackgroundPatrolAudit({ platform: 'xiaoheihe', action: 'read', result: 'allowed', reason: null });
    assert.equal(harness.calls.sent.length, 1, '读取成功不证明写暂停已恢复');
  } finally { await harness.close(); }
});

test('E2b 通知队列：写暂停→owner 私聊+去重；pending 可重发；后台输出仍不外发', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({
    config: e1Config(),
    globals: {
      createBackgroundPatrolBridgeHook: fakeHookFactory,
      createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
      ...e1.globals,
    },
  });
  try {
    const first = await harness.enqueueBackgroundPatrolNotification('write-paused', 'write-paused', { platform: 'xiaoheihe' });
    assert.equal(first.ok, true, JSON.stringify(first));
    await harness.flushBackgroundPatrolNotifications();
    assert.equal(harness.calls.sent.length, 1);
    assert.match(harness.calls.sent[0].text, /写操作已暂停/);
    const duplicate = await harness.enqueueBackgroundPatrolNotification('write-paused', 'write-paused', { platform: 'xiaoheihe' });
    assert.equal(duplicate.duplicate, true, '去重窗口内不得重复入队');
    await harness.flushBackgroundPatrolNotifications();
    assert.equal(harness.calls.sent.length, 1);
    const snapshot = await harness.getBackgroundPatrolNotifyQueue().snapshot();
    assert.equal(snapshot.recent.length, 1, 'delivered 后进入 recent');
    assert.equal(snapshot.items.length, 0, 'pending 已清');
    // 后台输出仍不得自动外发。
    await harness.sendToQQ('patrol:background', '后台输出');
    assert.equal(harness.calls.sent.length, 1);
  } finally {
    await harness.stopBackgroundPatrolRuntime();
    await harness.close();
  }
});

test('E2b 贴吧账本迁移：唯一 6 次/日；第 7 次 deny；无可信来源时 user 不能绕过', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({
    config: e1Config(),
    globals: {
      createBackgroundPatrolBridgeHook: fakeHookFactory,
      createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
      ...e1.globals,
      backgroundPatrolNow: fixedPatrolNow('2026-10-08T12:00:00+08:00'),
    },
  });
  try {
    harness.cfg.socialV2 = { ...(harness.cfg.socialV2 ?? {}), patrol: { enabled: true, quietHours: [0, 0] } };
    for (let i = 0; i < 6; i += 1) {
      const result = await harness.beginTiebaPatrol({ reason: 'patrol', key: 'private:123', action: 'bar', bar: 'test', page: '1' });
      assert.equal(result.ok, true, `第 ${i + 1} 次应 allow：${JSON.stringify(result)}`);
      assert.equal(result.cap, 6);
    }
    const denied = await harness.beginTiebaPatrol({ reason: 'patrol', key: 'private:123', action: 'bar', bar: 'test', page: '1' });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'PATROL_DAILY_CAP');
    assert.equal(denied.status, 429);
    for (let i = 0; i < 3; i += 1) {
      const user = await harness.beginTiebaPatrol({ reason: 'user', key: 'private:123', action: 'bar', bar: 'test', page: '1' });
      assert.equal(user.ok, false, '自报 user 不构成可信的用户指令证明');
    }
    const raw = JSON.parse(await fs.readFile(path.join(harness.temp, 'state', 'xiaoheihe-tieba-patrol.json'), 'utf8'));
    assert.equal(raw.used, 6, '账本唯一计数=6，拒绝后不再增加');
  } finally {
    await harness.stopBackgroundPatrolRuntime();
    await harness.close();
  }
});

test('E1-fix2 F2：advanceGeneration 抛错 → warn + fail-closed，不启动 scheduler', async () => {
  const failed = makeFakeE1({ advanceError: Object.assign(new Error('advance failed'), { code: 'WRITE_FAILED' }) });
  const harness = await bridgeHarness({
    config: e1Config(),
    globals: { createBackgroundPatrolBridgeHook: fakeHookFactory, createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }), ...failed.globals },
  });
  try {
    assert.equal(failed.ensureCalls.length, 1);
    assert.equal(failed.schedulerOptions.length, 0, 'advance 失败不得创建/启动 scheduler');
    assert.equal(failed.schedulerStarted.length, 0);
    assert.equal(harness.getBackgroundPatrolRuntime(), null);
    assert.ok(failed.closes.store >= 1, 'store 必须关闭');
    assert.ok(failed.closes.lifecycle >= 1, 'lifecycle 必须关闭');
  } finally {
    await harness.close();
  }
});

test('E1-fix2 F3：platforms 过滤与 modeAllowed 由当前模式决定', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({
    config: e1Config({ platforms: { tieba: false, xiaoheihe: true } }),
    globals: { createBackgroundPatrolBridgeHook: fakeHookFactory, createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }), ...e1.globals },
  });
  try {
    assert.equal(e1.schedulerOptions.length, 1);
    const options = e1.schedulerOptions[0];
    assert.equal(options.isPlatformEnabled('tieba'), false, '显式 false 平台不排期');
    assert.equal(options.isPlatformEnabled('xiaoheihe'), true);
    harness.setMode('chat');
    assert.equal(options.getAvailability().modeAllowed, false, 'chat 模式不允许后台巡逻');
    harness.setMode('closed-agent');
    assert.equal(options.getAvailability().modeAllowed, true);
    harness.setMode('reserved2');
    assert.equal(options.getAvailability().modeAllowed, true);
  } finally {
    await harness.stopBackgroundPatrolRuntime();
    await harness.close();
  }
});

test('E1-fix2 F1：stop 等待在途 dispatch settle，之后才 close lifecycle/store；超时 warn 继续', async () => {
  const order = [];
  const pending = [];
  const e1 = makeFakeE1({ lifecycleClose: () => order.push('lifecycle-close') });
  const harness = await bridgeHarness({
    config: e1Config({ platforms: { tieba: true } }),
    globals: {
      createBackgroundPatrolBridgeHook: fakeHookFactory,
      createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
      ...e1.globals,
      backgroundPatrolDispatchOpportunity: () => {
        order.push('dispatch-start');
        return new Promise((resolve) => pending.push(() => { order.push('dispatch-settled'); resolve({ ok: true }); }));
      },
    },
  });
  try {
    const runPromise = e1.schedulerOptions[0].run({ platform: 'tieba', startedAt: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(order, ['dispatch-start']);
    const stopPromise = harness.stopBackgroundPatrolRuntime();
    assert.equal(harness.getBackgroundPatrolRuntime(), null, 'stop 开始即拒绝新机会');
    assert.equal(e1.closes.lifecycle, 0, '在途 dispatch settle 前不得 close lifecycle');
    for (const settle of pending) settle();
    const stopped = await stopPromise;
    await runPromise;
    assert.deepEqual(order, ['dispatch-start', 'dispatch-settled', 'lifecycle-close']);
    assert.equal(stopped.waitedInFlight, true);
    assert.equal(stopped.inFlightTimedOut, false);
    assert.ok(e1.closes.lifecycle >= 1);
    assert.ok(e1.closes.store >= 1);
  } finally {
    await harness.close();
  }

  // 超时：dispatch 永不 settle，stop 在注入短超时后 warn 并继续关闭，且无未处理 rejection。
  const e1b = makeFakeE1();
  const harness2 = await bridgeHarness({
    config: e1Config({ platforms: { tieba: true } }),
    globals: {
      createBackgroundPatrolBridgeHook: fakeHookFactory,
      createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
      ...e1b.globals,
      backgroundPatrolStopWaitMs: 30,
      backgroundPatrolDispatchOpportunity: () => new Promise(() => {}),
    },
  });
  try {
    const runPromise = e1b.schedulerOptions[0].run({ platform: 'tieba', startedAt: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stopped = await harness2.stopBackgroundPatrolRuntime();
    assert.equal(stopped.waitedInFlight, true);
    assert.equal(stopped.inFlightTimedOut, true, '超时必须如实标记');
    assert.ok(e1b.closes.lifecycle >= 1);
    void runPromise;
  } finally {
    await harness2.close();
  }
});

test('E2b-fix F1：report restore 失败 → degraded 禁用汇报；prepare persist 失败 → 不发送', async () => {
  // restore 失败：报告初始化即 degraded，无发送。
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({
    config: e1Config({ platforms: { xiaoheihe: true } }),
    globals: {
      createBackgroundPatrolBridgeHook: fakeHookFactory,
      createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
      ...e1.globals,
      backgroundPatrolForceReportRestoreFail: true,
      backgroundPatrolReportRandom: () => 0.1,
    },
  });
  try {
    await fs.writeFile(path.join(harness.temp, 'state', 'xiaoheihe-operation-controller.json'), JSON.stringify({ schemaVersion: 1, day: '2026-10-26', readCount: 1 }));
    const result = await harness.maybeSendTiebaPatrolReport(1);
    assert.equal(result.sent, false);
    assert.equal(harness.calls.sent.length, 0, 'restore 失败后不得发送');
  } finally {
    await harness.stopBackgroundPatrolRuntime();
    await harness.close();
  }

  // prepare 持久化失败：命中概率但状态未落盘 → 不发送。
  const e1b = makeFakeE1();
  const harness2 = await bridgeHarness({
    config: e1Config({ platforms: { xiaoheihe: true } }),
    globals: {
      createBackgroundPatrolBridgeHook: fakeHookFactory,
      createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
      ...e1b.globals,
      backgroundPatrolForceReportPersistFail: true,
      backgroundPatrolReportRandom: () => 0.1,
    },
  });
  try {
    await fs.writeFile(path.join(harness2.temp, 'state', 'xiaoheihe-operation-controller.json'), JSON.stringify({ schemaVersion: 1, day: '2026-10-26', readCount: 1 }));
    const result = await harness2.maybeSendTiebaPatrolReport(1);
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'persist-failed');
    assert.equal(harness2.calls.sent.length, 0, 'persist 失败不得发送');
  } finally {
    await harness2.stopBackgroundPatrolRuntime();
    await harness2.close();
  }
});

test('E2b-fix F2：audit 初始化失败时内存 tap 仍驱动通知与汇报（degraded + warn）', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({
    config: e1Config({ platforms: { xiaoheihe: true } }),
    globals: {
      createBackgroundPatrolBridgeHook: fakeHookFactory,
      createBackgroundPatrolAudit: () => { throw new Error('audit-dir-failed'); },
      ...e1.globals,
      backgroundPatrolReportRandom: () => 0.1,
    },
  });
  try {
    const tap = harness.getBackgroundPatrolAuditTap();
    assert.ok(tap && typeof tap.record === 'function', '审计失败仍必须保留内存 tap');
    // 启动阶段可能已有 audit-degraded 等 owner 通知入队/发送；以 baseline 计增量。
    const sentBaseline = harness.calls.sent.length;
    // F-E：汇报改由贴吧 used 触发，小黑盒 read 事件不再触发汇报（即使审计 tap 正常）。
    await tap.record({ at: Date.now(), platform: 'xiaoheihe', action: 'read', result: 'success', reason: null });
    assert.equal(harness.calls.sent.length, sentBaseline, '小黑盒 read 不得触发贴吧汇报');
    // 暂停通知仍可用；普通 allow 不得冒充恢复。
    await tap.record({ at: Date.now(), platform: 'xiaoheihe', action: 'skip', result: 'denied', reason: 'write-paused' });
    await tap.record({ at: Date.now(), platform: 'xiaoheihe', action: 'skip', result: 'allowed', reason: 'recovered' });
    assert.ok(harness.calls.sent.some((item) => /写操作已暂停/.test(item.text)));
    assert.equal(harness.calls.sent.some((item) => /后台巡逻已恢复/.test(item.text)), false);
  } finally {
    await harness.stopBackgroundPatrolRuntime();
    await harness.close();
  }
});

test('E2b-fix F3：暂停通知与普通 allow 不冒充恢复', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({
    config: e1Config({ platforms: { xiaoheihe: true } }),
    globals: {
      createBackgroundPatrolBridgeHook: fakeHookFactory,
      createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
      ...e1.globals,
    },
  });
  try {
    const tap = harness.getBackgroundPatrolAuditTap();
    await tap.record({ at: Date.now(), platform: 'xiaoheihe', action: 'skip', result: 'denied', reason: 'access-paused' });
    await tap.record({ at: Date.now(), platform: 'xiaoheihe', action: 'skip', result: 'allowed', reason: 'recovered' });
    assert.equal(harness.calls.sent.length, 1, '普通 allow 不能作为恢复证据');
    assert.match(harness.calls.sent[0].text, /平台访问已暂停/);
  } finally {
    await harness.stopBackgroundPatrolRuntime();
    await harness.close();
  }
});

test('F-D 忙判据：覆盖真实在途 turn（QQ turn → qq-busy skip；后台 turn → background-busy skip；turn/end 恢复）', async () => {
  const dispatched = [];
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({
    config: e1Config(),
    globals: {
      createBackgroundPatrolBridgeHook: fakeHookFactory,
      createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
      ...e1.globals,
      backgroundPatrolDispatchOpportunity: async (platform) => { dispatched.push(platform); return { ok: true }; },
    },
  });
  try {
    const runtime = harness.getBackgroundPatrolRuntime();
    const options = e1.schedulerOptions[0];
    harness.state.sessions['patrol:background'] = 'sid-patrol';
    assert.equal(runtime.isQqBusy(), false, '无队列/无回合时不忙');
    assert.equal(options.getAvailability().qqBusy, false);

    // QQ 在途 turn：即使 promptQueues 为空也必须算忙。
    runtime.turns.set('private:qq-sid', Date.now());
    assert.equal(runtime.isQqBusy(), true, '在途 QQ turn 必须算忙');
    assert.equal(options.getAvailability().qqBusy, true);

    // 后台 session 的 turn：不算 QQ 忙，但机会执行时应 skip background-busy。
    runtime.turns.delete('private:qq-sid');
    runtime.turns.set('sid-patrol', Date.now());
    assert.equal(runtime.isQqBusy(), false, '后台 turn 不应伪装成 QQ 忙');
    assert.equal(runtime.isBackgroundTurnInFlight(), true);
    const skipped = await options.run({ platform: 'tieba', startedAt: Date.now() });
    assert.equal(skipped.ok, false);
    assert.equal(skipped.reason, 'background-busy');
    assert.equal(dispatched.length, 0, '后台忙不得 dispatch');
    const skipMark = e1.marks.find((mark) => mark.kind === 'skip');
    assert.equal(skipMark.reason, 'background-busy');

    // turn/end 后恢复可用。
    runtime.turns.delete('sid-patrol');
    assert.equal(runtime.isBackgroundTurnInFlight(), false);
    await options.run({ platform: 'tieba', startedAt: Date.now() });
    assert.equal(dispatched.length, 1, 'turn/end 后机会应恢复 dispatch');
  } finally {
    await harness.stopBackgroundPatrolRuntime();
    await harness.close();
  }
});

test('F-E 贴吧汇报：used 抽签/dedupe/第 7 次 0；xiaoheihe readCount 不再触发', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({
    config: e1Config(),
    globals: {
      createBackgroundPatrolBridgeHook: fakeHookFactory,
      createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
      ...e1.globals,
      backgroundPatrolReportRandom: () => 0.1,
    },
  });
  try {
    // 第 1 次 used=1：概率 60%，random 0.1 → 发送一次。
    const first = await harness.maybeSendTiebaPatrolReport(1);
    assert.equal(first.deferred, true, JSON.stringify(first));
    await flushWithModel(harness);
    assert.equal(harness.calls.sent.length, 1);
    assert.match(harness.calls.sent[0].text, /第 1 次自主逛贴吧/);
    // 同 used 去重（dedupe tieba:<day>:1）。
    assert.equal((await harness.maybeSendTiebaPatrolReport(1)).sent, false);
    assert.equal(harness.calls.sent.length, 1);
    // 第 2 次 random 0.1 < 50% → 发送（不同 dedupe key；readIndex 需单调递增）。
    assert.equal((await harness.maybeSendTiebaPatrolReport(2)).deferred, true);
    await flushWithModel(harness);
    assert.equal(harness.calls.sent.length, 2);
    // 第 7 次概率 0 → 不发送。
    assert.equal((await harness.maybeSendTiebaPatrolReport(7)).sent, false);
    // 小黑盒 readCount 不再触发：写入 readCount=1 但不传 used → no-tieba-used，不发送。
    await fs.writeFile(path.join(harness.temp, 'state', 'xiaoheihe-operation-controller.json'), JSON.stringify({ schemaVersion: 1, day: '2026-10-26', readCount: 1 }));
    const legacyCall = await harness.maybeSendTiebaPatrolReport(undefined);
    assert.equal(legacyCall.sent, false);
    assert.equal(legacyCall.reason, 'no-tieba-used');
    assert.equal(harness.calls.sent.length, 2);
  } finally {
    await harness.stopBackgroundPatrolRuntime();
    await harness.close();
  }
});

test('task46 贴吧汇报命中后等待回合结束，不立即发送', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    const result = await harness.maybeSendTiebaPatrolReport(1);
    assert.equal(result.deferred, true);
    assert.equal(result.sent, false);
    assert.equal(harness.calls.sent.length, 0);
    await harness.handleBackgroundPatrolFrame('sid', { type: 'turn/start', data: { turn: 1 } });
    await harness.handleBackgroundPatrolFrame('sid', { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '<patrol-report sensitive="false" destination="admin">看到新的讨论</patrol-report>' }] } } });
    await harness.handleBackgroundPatrolFrame('sid', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    assert.equal(harness.calls.sent.length, 1);
    assert.match(harness.calls.sent[0].text, /看到新的讨论/);
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('贴吧汇报跨北京零点后重新从 60% 开始且当天不重复', async () => {
  const e1 = makeFakeE1();
  let now = Date.parse('2026-10-27T15:59:59Z');
  class FakeDate extends Date { static now() { return now; } }
  const harness = await bridgeHarness({
    config: e1Config(),
    globals: {
      Date: FakeDate,
      createBackgroundPatrolBridgeHook: fakeHookFactory,
      createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
      ...e1.globals,
      backgroundPatrolReportRandom: () => 0.1,
    },
  });
  try {
    assert.equal((await harness.maybeSendTiebaPatrolReport(2)).deferred, true);
    await flushWithModel(harness);
    now += 2000;
    const next = await harness.maybeSendTiebaPatrolReport(1);
    assert.equal(next.deferred, true, JSON.stringify(next));
    await flushWithModel(harness);
    assert.equal(next.probability, 1, '抽签取消后恒为 1');
    assert.equal((await harness.maybeSendTiebaPatrolReport(1)).sent, false);
    assert.equal(harness.calls.sent.length, 2);
  } finally {
    await harness.stopBackgroundPatrolRuntime();
    await harness.close();
  }
});

test('贴吧汇报发送失败时审计不得记录成功', async () => {
  const e1 = makeFakeE1();
  const audit = [];
  class FailedBot {
    on() {} off() {}
    async sendPrivateMessage() { throw new Error('fixture send failure'); }
  }
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    SnowLumaWebSocketClient: FailedBot,
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record(entry) { audit.push(entry); return { ok: true }; } }),
    ...e1.globals,
    backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    const result = await harness.maybeSendTiebaPatrolReport(1);
    assert.equal(result.sent, false);
    assert.equal(result.deferred, true);
    await flushWithModel(harness);
    assert.equal(harness.getBackgroundPatrolReportOnce().snapshot().state, 'failed', '发送抛错=失败终态，不重试');
    assert.equal(audit.find((entry) => entry.reason === 'report-failed')?.result, 'failure', '发送抛错=confirmed 失败，不得记 unknown/成功');
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('贴吧汇报发送成功时审计记录成功', async () => {
  const e1 = makeFakeE1();
  const audit = [];
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record(entry) { audit.push(entry); return { ok: true }; } }),
    ...e1.globals,
    backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    assert.equal((await harness.maybeSendTiebaPatrolReport(1)).deferred, true);
    await flushWithModel(harness);
    assert.equal(audit.find((entry) => entry.reason === 'report-sent')?.result, 'success');
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('管理员会话已存在时小黑盒读取不再触发旧后台代发候选', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    ...e1.globals,
  } });
  try {
    await harness.ensureSession('private:123');
    const machine = harness.getXhhPatrolReportOnce();
    const before = machine.snapshot();
    await harness.getBackgroundPatrolAuditTap().record(
      { at: Date.now(), platform: 'xiaoheihe', action: 'read', result: 'success', reason: null },
      { agentClass: 'background', tool: 'get_home_content', readIndex: 1, readStartedAt: Date.now() });
    assert.deepEqual(machine.snapshot(), before, '同会话自然分享不得创建旧代发候选');
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('小黑盒自主成功读取触发独立概率汇报，搜索和用户读取不触发', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    const tap = harness.getBackgroundPatrolAuditTap();
    const read = { at: Date.now(), platform: 'xiaoheihe', action: 'read', result: 'success', reason: null, opId: null };
    await tap.record(read, { agentClass: 'background', tool: 'search_content' });
    await tap.record(read, { agentClass: 'user', tool: 'get_home_content', readIndex: 1 });
    await tap.record({ ...read, action: 'write' }, { agentClass: 'background', tool: 'post_comment', readIndex: 1, readStartedAt: read.at });
    await tap.record({ ...read, result: 'failure' }, { agentClass: 'background', tool: 'get_home_content', readIndex: 1, readStartedAt: read.at });
    assert.equal(harness.calls.sent.length, 0);
    await tap.record(read, { agentClass: 'background', tool: 'get_home_content', readIndex: 1, readStartedAt: read.at });
    await flushWithModel(harness);
    assert.equal(harness.calls.sent.length, 1);
    assert.match(harness.calls.sent[0].text, /小黑盒/);
    await tap.record(read, { agentClass: 'background', tool: 'get_home_content', readIndex: 1, readStartedAt: read.at });
    assert.equal(harness.calls.sent.length, 1);
    assert.equal((await harness.maybeSendTiebaPatrolReport(1)).probability, 1);
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('小黑盒按派发日归属，跨日旧回执不发且新日首读恢复 60%', async () => {
  const e1 = makeFakeE1();
  let now = Date.parse('2026-10-27T15:59:59Z');
  class FakeDate extends Date { static now() { return now; } }
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    Date: FakeDate, createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    ...e1.globals, backgroundPatrolReportRandom: () => 0.55,
  } });
  try {
    const tap = harness.getBackgroundPatrolAuditTap();
    const event = { platform: 'xiaoheihe', action: 'read', result: 'success', reason: null };
    const meta = { agentClass: 'background', tool: 'get_home_content', readIndex: 1, readStartedAt: now };
    await tap.record(event, meta);
    await flushWithModel(harness);
    assert.equal(harness.calls.sent.length, 1);
    now += 2000;
    await tap.record(event, meta);
    assert.equal(harness.calls.sent.length, 1);
    await tap.record(event, { ...meta, readStartedAt: now });
    await flushWithModel(harness);
    assert.equal(harness.calls.sent.length, 2);
    assert.match(harness.calls.sent[1].text, /60%/);
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('小黑盒发送失败审计为 unknown 且不重发', async () => {
  const e1 = makeFakeE1();
  const audit = [];
  let attempts = 0;
  class FailedBot { on() {} off() {} async sendPrivateMessage() { attempts += 1; throw new Error('fixture'); } }
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    SnowLumaWebSocketClient: FailedBot, createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record(entry) { audit.push(entry); return { ok: true }; } }),
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    const event = { platform: 'xiaoheihe', action: 'read', result: 'success', reason: null };
    const meta = { agentClass: 'background', tool: 'get_post_detail', readIndex: 1, readStartedAt: Date.now() };
    await harness.getBackgroundPatrolAuditTap().record(event, meta);
    await flushWithModel(harness);
    await harness.getBackgroundPatrolAuditTap().record(event, meta);
    assert.equal(attempts, 1);
    assert.equal(audit.find((entry) => entry.reason === 'report-failed')?.result, 'failure', '发送抛错=confirmed 失败，不得记 unknown/成功');
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('小黑盒旧日 dispatched 快照不重发，新日首读仍可汇报', async () => {
  const e1 = makeFakeE1();
  let now = Date.parse('2026-10-27T15:59:59Z');
  class FakeDate extends Date { static now() { return now; } }
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    Date: FakeDate, createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    const report = vm.runInContext('xhhPatrolReportOnce', harness.context);
    report.prepare({ readIndex: 1, dedupeKey: 'xiaoheihe:2026-10-27:1', random: 0.1, at: now });
    report.dispatch({ at: now });
    report.restore(report.snapshot());
    now += 2000;
    await harness.getBackgroundPatrolAuditTap().record(
      { platform: 'xiaoheihe', action: 'read', result: 'success', reason: null },
      { agentClass: 'background', tool: 'get_home_content', readIndex: 1, readStartedAt: now },
    );
    await flushWithModel(harness);
    assert.equal(harness.calls.sent.length, 1);
    assert.match(harness.calls.sent[0].text, /60%/);
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('恢复旧日 prepared 快照后新日首读重新抽签', async () => {
  const e1 = makeFakeE1();
  let now = Date.parse('2026-10-27T15:59:59Z');
  class FakeDate extends Date { static now() { return now; } }
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    Date: FakeDate,
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    ...e1.globals,
    backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    const state = harness.getBackgroundPatrolReportOnce();
    state.prepare({ readIndex: 2, dedupeKey: 'tieba:2026-10-27:2', random: 0.1, at: now });
    const snapshot = state.snapshot();
    state.restore(snapshot);
    now += 2000;
    const result = await harness.maybeSendTiebaPatrolReport(1);
    assert.equal(result.deferred, true, JSON.stringify(result));
    await flushWithModel(harness);
    assert.equal(result.probability, 1);
    assert.equal(harness.calls.sent.length, 1);
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('重启恢复：持久化汇报状态在下次 start 必须真正 restore，不得误判 degraded/禁用', async () => {
  const e1 = makeFakeE1();
  let now = Date.parse('2026-10-27T15:59:00Z');
  class FakeDate extends Date { static now() { return now; } }
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    Date: FakeDate, createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    const event = { platform: 'xiaoheihe', action: 'read', result: 'success', reason: null };
    await harness.getBackgroundPatrolAuditTap().record(event, { agentClass: 'background', tool: 'get_home_content', readIndex: 1, readStartedAt: now });
    assert.equal((await harness.maybeSendTiebaPatrolReport(1)).deferred, true);
    await flushWithModel(harness);
    assert.equal(harness.calls.sent.length, 2);

    await harness.stopBackgroundPatrolRuntime();
    now = Date.parse('2026-10-27T16:00:30Z'); // 次日 00:00:30 +08
    await vm.runInContext('__startBackgroundPatrolWiring()', harness.context);

    assert.equal(vm.runInContext('backgroundPatrolReportDegraded', harness.context), false);
    assert.notEqual(vm.runInContext('backgroundPatrolReportOnce', harness.context), null);
    assert.notEqual(vm.runInContext('xhhPatrolReportOnce', harness.context), null);

    await harness.getBackgroundPatrolAuditTap().record(event, { agentClass: 'background', tool: 'get_home_content', readIndex: 1, readStartedAt: now });
    await flushWithModel(harness);
    assert.equal(harness.calls.sent.length, 3);
    assert.match(harness.calls.sent[2].text, /60%/);
    const tieba = await harness.maybeSendTiebaPatrolReport(1);
    assert.equal(tieba.deferred, true);
    await flushWithModel(harness);
    assert.match(harness.calls.sent[3].text, /60%/);
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

test('汇报状态文件损坏：重启时贴吧 degraded、小黑盒 fail-closed 禁用并留下日志', async () => {
  const e1 = makeFakeE1();
  let now = Date.parse('2026-10-27T15:59:00Z');
  class FakeDate extends Date { static now() { return now; } }
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    Date: FakeDate, createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    const event = { platform: 'xiaoheihe', action: 'read', result: 'success', reason: null };
    await harness.getBackgroundPatrolAuditTap().record(event, { agentClass: 'background', tool: 'get_home_content', readIndex: 1, readStartedAt: now });
    assert.equal((await harness.maybeSendTiebaPatrolReport(1)).deferred, true);
    await flushWithModel(harness);
    assert.equal(harness.calls.sent.length, 2);

    await harness.stopBackgroundPatrolRuntime();
    await fs.writeFile(path.join(harness.temp, 'state/xiaoheihe-read-report.json'), '{not-json', 'utf8');
    await fs.writeFile(path.join(harness.temp, 'state/xiaoheihe-patrol-report.json'), '{not-json', 'utf8');
    now = Date.parse('2026-10-28T04:00:00Z');
    await vm.runInContext('__startBackgroundPatrolWiring()', harness.context);

    assert.equal(vm.runInContext('backgroundPatrolReportDegraded', harness.context), true);
    assert.equal(vm.runInContext('backgroundPatrolReportOnce', harness.context), null);
    assert.equal(vm.runInContext('xhhPatrolReportOnce', harness.context), null);
    const logText = await fs.readFile(path.join(harness.temp, 'state/bridge.log'), 'utf8');
    assert.match(logText, /小黑盒汇报状态恢复失败/);
    const sentBefore = harness.calls.sent.length;
    await harness.getBackgroundPatrolAuditTap().record(event, { agentClass: 'background', tool: 'get_home_content', readIndex: 1, readStartedAt: now });
    assert.equal(harness.calls.sent.length, sentBefore);
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

test('跨日时真实发送仍在途不得重置或重发', async () => {
  const e1 = makeFakeE1();
  let now = Date.parse('2026-10-27T15:59:59Z');
  class FakeDate extends Date { static now() { return now; } }
  let release;
  let started;
  let sendCount = 0;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  class SlowBot {
    on() {} off() {}
    async sendPrivateMessage() {
      sendCount += 1;
      if (sendCount > 1) return;
      started();
      return new Promise((resolve) => { release = resolve; });
    }
  }
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    Date: FakeDate, SnowLumaWebSocketClient: SlowBot,
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    ...e1.globals,
    backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    assert.equal((await harness.maybeSendTiebaPatrolReport(2)).deferred, true);
    const old = flushWithModel(harness);
    await startedPromise;
    now += 2000;
    assert.equal((await harness.maybeSendTiebaPatrolReport(1)).reason, 'report-in-flight');
    release();
    await old;
    assert.equal((await harness.maybeSendTiebaPatrolReport(1)).deferred, true);
    await flushWithModel(harness);
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('恢复旧日 dispatched 快照后不重发旧汇报，新日仍可抽签', async () => {
  const e1 = makeFakeE1();
  let now = Date.parse('2026-10-27T15:59:59Z');
  class FakeDate extends Date { static now() { return now; } }
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    Date: FakeDate,
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    const state = harness.getBackgroundPatrolReportOnce();
    state.prepare({ readIndex: 2, dedupeKey: 'tieba:2026-10-27:2', random: 0.1, at: now });
    state.dispatch({ at: now });
    state.restore(state.snapshot());
    now += 2000;
    const result = await harness.maybeSendTiebaPatrolReport(1);
    assert.equal(result.deferred, true);
    await flushWithModel(harness);
    assert.equal(result.probability, 1);
    assert.equal(harness.calls.sent.length, 1, '只发送新日汇报，不重发旧日尝试');
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('贴吧汇报恢复快照后跨日重置，时钟回拨不再抽签', async () => {
  const e1 = makeFakeE1();
  let now = Date.parse('2026-10-27T15:59:59Z');
  class FakeDate extends Date { static now() { return now; } }
  const create = () => bridgeHarness({ config: e1Config(), globals: {
    Date: FakeDate,
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    ...e1.globals,
    backgroundPatrolReportRandom: () => 0.1,
  } });
  const first = await create();
  let saved;
  try {
    assert.equal((await first.maybeSendTiebaPatrolReport(2)).deferred, true);
    await flushWithModel(first);
    saved = first.getBackgroundPatrolReportOnce().snapshot();
  } finally { await first.stopBackgroundPatrolRuntime(); await first.close(); }
  now += 2000;
  const restarted = await create();
  try {
    restarted.getBackgroundPatrolReportOnce().restore(saved);
    assert.equal((await restarted.maybeSendTiebaPatrolReport(1)).deferred, true);
    await flushWithModel(restarted);
    now -= 2000;
    const rollback = await restarted.maybeSendTiebaPatrolReport(3);
    assert.equal(rollback.reason, 'report-clock-rollback');
    assert.equal(restarted.calls.sent.length, 1);
  } finally { await restarted.stopBackgroundPatrolRuntime(); await restarted.close(); }
});

test('P2-3 每次调度前强制现跑 reconcile（不复用 60s 快照）', async () => {
  const e1 = makeFakeE1();
  let reconcileCalls = 0;
  const hookFactory = () => ({
    async start() { return { ok: true, enabled: true, url: 'http://127.0.0.1:1', port: 1 }; },
    async stop() { return { stopped: true }; },
    status() { return { started: true, identityMode: 'mapper' }; },
    async reconcile() { reconcileCalls += 1; return { ok: true, blocked: false, at: Date.now() }; },
  });
  const harness = await bridgeHarness({
    config: e1Config({ platforms: { xiaoheihe: true } }),
    globals: { createBackgroundPatrolBridgeHook: hookFactory, createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }), ...e1.globals },
  });
  try {
    await harness.ensureSession('patrol:background');
    const base = reconcileCalls;
    await e1.schedulerOptions[0].run({ platform: 'xiaoheihe', startedAt: Date.now() });
    await e1.schedulerOptions[0].run({ platform: 'xiaoheihe', startedAt: Date.now() + 1000 });
    assert.equal(reconcileCalls, base + 2, 'dispatch 门禁必须每次现跑对账');
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

// ── task-190：真审计落盘夹具 ───────────────────────────────────────────────
// 背景：旧用例用 makeAuditTap()（直接 records.push）绕过了审计模块的 validateRecordRequest，
// 因此「result/action 用了枚举外的值」这类缺陷在测试里永远看不见 —— 生产里整条记录被静默拒绝。
// 本夹具不再注入假 factory，而是通过配置项 backgroundPatrol.auditDir 把**真实审计模块**
// 指向临时目录，断言直接落在磁盘 JSONL 上：没落盘 = 被拒 = 测试红。
async function makeRealAuditDir() {
  const dir = await makeDir();
  return dir;
}

// 审计写入是异步 append（record() 内部起火即忘，失败也不抛），所以断言前必须轮询等待，
// 否则「文件还没落盘」会被误判成「记录被拒绝」。
async function readAuditLines(dir, predicate = () => true) {
  const deadline = Date.now() + 3000;
  let rows = [];
  while (Date.now() < deadline) {
    const names = (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith('.jsonl'));
    rows = [];
    for (const name of names) {
      const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '');
      for (const line of text.split('\n')) if (line.trim() !== '') rows.push(JSON.parse(line));
    }
    if (predicate(rows)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`审计目录里没有出现期望的记录：${JSON.stringify(rows)}`);
}

// ── task-46 集成（Lead 补齐）：真实回合流下的群路由/分级回退/跨日/绑定/并发/迟到回执/过期会话 ──
function makeAuditTap() {
  const records = [];
  return {
    records,
    factory: () => ({
      async load() {},
      async record(payload) { records.push(payload); return { ok: true }; },
    }),
  };
}

async function runTurn(harness, sessionId, turn, text) {
  await harness.handleBackgroundPatrolFrame(sessionId, { type: 'turn/start', data: { turn } });
  await harness.handleBackgroundPatrolFrame(sessionId, {
    type: 'assistant/message',
    data: { turn, message: { content: [{ type: 'text', text }] } },
  });
  await harness.handleBackgroundPatrolFrame(sessionId, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
}

// 测试旧的抽签、跨日和持久化行为时提供真实模型回合，而不是依赖生产模板。
async function flushWithModel(harness) {
  return runTurn(harness, 'sid', 1, '<patrol-report sensitive="false" destination="admin">第 1 次自主逛贴吧和小黑盒，60%</patrol-report>');
}

test('巡逻群汇报直接使用会话群白名单，不依赖独立报告名单', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: makeAuditTap().factory,
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    await harness.maybeSendTiebaPatrolReport(1);
    await runTurn(harness, 'sid', 1, '<patrol-report sensitive="false" destination="group">今天看到有趣的话题。</patrol-report>');
    assert.equal(harness.calls.sent.length, 1);
    assert.equal(harness.calls.sent[0].kind, 'group');
    assert.equal(String(harness.calls.sent[0].id), '456');
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('task46 集成：群白名单命中 → 发群 + 审计固定 report 字段', async () => {
  const e1 = makeFakeE1();
  const tap = makeAuditTap();
  const harness = await bridgeHarness({ config: e1Config({ report: { groups: ['456'] } }), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: tap.factory,
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    await harness.maybeSendTiebaPatrolReport(1);
    await runTurn(harness, 'sid', 1, '<patrol-report sensitive="false" destination="group">今天看到不少好帖，氛围不错。</patrol-report>');
    assert.equal(harness.calls.sent.length, 1);
    assert.equal(harness.calls.sent[0].kind, 'group');
    assert.equal(String(harness.calls.sent[0].id), '456');
    assert.match(harness.calls.sent[0].text, /氛围不错/);
    const reportAudits = tap.records.filter((record) => record.action === 'report');
    assert.equal(reportAudits.length, 1, JSON.stringify(tap.records));
    // 审计对象来自 VM 上下文，跨 realm 原型不同，用 JSON 归一后比较。
    assert.deepEqual(JSON.parse(JSON.stringify(reportAudits[0].report)), {
      contentSource: 'model', classification: 'non-sensitive', destination: 'group', reportBlockPresent: true,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(reportAudits[0].quota)), { readIndex: 1 });
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('task46 集成：敏感内容即使模型指定 group 也只发管理员', async () => {
  const e1 = makeFakeE1();
  const tap = makeAuditTap();
  const harness = await bridgeHarness({ config: e1Config({ report: { groups: ['456'] } }), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: tap.factory,
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    await harness.maybeSendTiebaPatrolReport(1);
    await runTurn(harness, 'sid', 1, '<patrol-report sensitive="false" destination="group">群里发了张二维码图片。</patrol-report>');
    assert.equal(harness.calls.sent.length, 1);
    assert.equal(harness.calls.sent[0].kind, 'private');
    assert.equal(String(harness.calls.sent[0].id), '123');
    const report = tap.records.find((record) => record.action === 'report');
    assert.equal(report.report.classification, 'sensitive');
    assert.equal(report.report.destination, 'owner');
    assert.equal(report.report.contentSource, 'model');
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('task46 集成：Blocked 内容不发送并记录原因', async () => {
  const e1 = makeFakeE1();
  const tap = makeAuditTap();
  const harness = await bridgeHarness({ config: e1Config({ report: { groups: ['456'] } }), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: tap.factory,
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    await harness.maybeSendTiebaPatrolReport(1);
    await runTurn(harness, 'sid', 1, '<patrol-report sensitive="false" destination="group">见 bit.ly/x 这个链接</patrol-report>');
    assert.equal(harness.calls.sent.length, 0);
    const report = tap.records.find((record) => record.action === 'report');
    assert.equal(report.reason, 'report-blocked', '安全拦截必须与「模型主动不发」区分');
    assert.equal(report.result, 'skipped');
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('小黑盒无模型汇报块：不发送、审计未发送且不重试', async () => {
  const e1 = makeFakeE1();
  const tap = makeAuditTap();
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: tap.factory,
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    const at = Date.now();
    const event = { at, platform: 'xiaoheihe', action: 'read', result: 'success', reason: null };
    const meta = { agentClass: 'background', tool: 'get_home_content', readIndex: 1, readStartedAt: at };
    await harness.getBackgroundPatrolAuditTap().record(event, meta);
    await runTurn(harness, 'sid', 1, '本回合没有汇报块');
    assert.equal(harness.calls.sent.length, 0);
    const report = tap.records.find((record) => record.reason === 'report-declined' || record.reason === 'report-invalid-block');
    assert.equal(report?.result, 'skipped');
    assert.equal(report?.platform, 'xiaoheihe');
    await harness.getBackgroundPatrolAuditTap().record(event, meta);
    await harness.flushPendingPatrolReports('');
    assert.equal(harness.calls.sent.length, 0);
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('task46 集成：跨日 pending 丢弃且审计 report-stale-day，不发送', async () => {
  const e1 = makeFakeE1();
  const tap = makeAuditTap();
  let now = Date.parse('2026-10-27T04:00:00Z');
  class FakeDate extends Date { static now() { return now; } }
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    Date: FakeDate,
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: tap.factory,
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    await harness.maybeSendTiebaPatrolReport(1);
    now += 24 * 60 * 60 * 1000;
    await harness.flushPendingPatrolReports('');
    assert.equal(harness.calls.sent.length, 0, '跨日 pending 不得发送');
    const report = tap.records.find((record) => record.action === 'report');
    assert.equal(report.reason, 'report-stale-day');
    assert.equal(report.result, 'unknown');
    assert.equal(report.report, null);
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('task46 集成：pending 与回合绑定，回合文本不会串到别的回合', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({ config: e1Config({ report: { groups: ['456'] } }), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    await harness.handleBackgroundPatrolFrame('sid', { type: 'turn/start', data: { turn: 1 } });
    await harness.maybeSendTiebaPatrolReport(1);
    await runTurn(harness, 'sid', 2, '<patrol-report sensitive="false" destination="admin">第二回合正文不该被使用</patrol-report>');
    assert.equal(harness.calls.sent.length, 0, '不得借用第二回合文本或发送模板');
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('task46 集成：迟到回执无对应模型文本时不发送', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    await runTurn(harness, 'sid', 1, '第一回合结束');
    await harness.maybeSendTiebaPatrolReport(1);
    assert.equal(harness.calls.sent.length, 0);
    await harness.flushPendingPatrolReports('');
    assert.equal(harness.calls.sent.length, 0);
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('task46 集成：并发 flush 串行化，pending 不丢也不重复发送', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    await harness.maybeSendTiebaPatrolReport(1);
    await Promise.all([
      harness.flushPendingPatrolReports(''),
      harness.flushPendingPatrolReports(''),
      harness.flushPendingPatrolReports(''),
    ]);
    assert.equal(harness.calls.sent.length, 0, '没有模型内容时不能并发发送模板');
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('task46 集成：过期会话事件不污染当前回合文本', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    await harness.maybeSendTiebaPatrolReport(1);
    await harness.handleBackgroundPatrolFrame('sid-a', { type: 'turn/start', data: { turn: 1 } });
    await harness.handleBackgroundPatrolFrame('sid-b', {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: '<patrol-report sensitive="false" destination="admin">过期会话不该出现的正文</patrol-report>' }] } },
    });
    await harness.handleBackgroundPatrolFrame('sid-a', {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: '<patrol-report sensitive="false" destination="admin">当前会话正文</patrol-report>' }] } },
    });
    await harness.handleBackgroundPatrolFrame('sid-a', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    assert.equal(harness.calls.sent.length, 1);
    assert.match(harness.calls.sent[0].text, /当前会话正文/);
    assert.doesNotMatch(harness.calls.sent[0].text, /过期会话/);
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

// ── task-52：P3 清理（审计 platform / 帧 sessionId 纵深防御 / stale-day 可观测） ──────

test('task52-1 审计 platform：贴吧汇报=tieba、小黑盒汇报=xiaoheihe，且既有字段顺序不变', async () => {
  const e1 = makeFakeE1();
  const tap = makeAuditTap();
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: tap.factory,
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  // 既有审计行字段顺序（bridge 侧 payload 的键序；下行落盘适配器只按固定 schema 重排，不改变调用方语义）。
  const EXPECTED_KEYS = ['at', 'platform', 'action', 'result', 'reason', 'quota', 'report'];
  try {
    // 贴吧汇报路径：maybeSendTiebaPatrolReport → flush → recordBackgroundPatrolAudit(..., platform='tieba')
    await harness.maybeSendTiebaPatrolReport(1);
    await harness.flushPendingPatrolReports('');
    const tiebaReport = tap.records.filter((record) => record.action === 'report').at(-1);
    assert.ok(tiebaReport, `贴吧汇报必须有审计行：${JSON.stringify(tap.records)}`);
    assert.equal(tiebaReport.platform, 'tieba', '贴吧汇报审计必须标注 platform=tieba');
    assert.deepEqual(JSON.parse(JSON.stringify(Object.keys(tiebaReport))), EXPECTED_KEYS, '审计字段顺序是固定契约');
    // 小黑盒汇报路径：审计 tap 读事件 → flush → recordBackgroundPatrolAudit 缺省 platform='xiaoheihe'
    const read = { at: Date.now(), platform: 'xiaoheihe', action: 'read', result: 'success', reason: null, opId: null };
    await harness.getBackgroundPatrolAuditTap().record(read, {
      agentClass: 'background', tool: 'get_home_content', readIndex: 1, readStartedAt: read.at,
    });
    await harness.flushPendingPatrolReports('');
    const xhhReport = tap.records.filter((record) => record.action === 'report').at(-1);
    assert.ok(xhhReport, `小黑盒汇报必须有审计行：${JSON.stringify(tap.records)}`);
    assert.equal(xhhReport.platform, 'xiaoheihe', '既有小黑盒审计行 platform 必须逐字节保持 xiaoheihe');
    assert.deepEqual(JSON.parse(JSON.stringify(Object.keys(xhhReport))), EXPECTED_KEYS, '小黑盒审计字段顺序不得变化');
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('task52-2 帧 sessionId 与当前后台会话映射不符 → 拒绝且不建 collector、不发送', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    // 当前后台会话身份（生产由 ensureSession 写入 state.sessions[BACKGROUND_SESSION_KEY]）。
    harness.state.sessions['patrol:background'] = 'sid-expected';
    // 正向：身份一致的帧正常建立 collector 并结算汇报。
    await harness.maybeSendTiebaPatrolReport(1);
    await runTurn(harness, 'sid-expected', 1, '<patrol-report sensitive="false" destination="admin">期望会话正文</patrol-report>');
    assert.equal(harness.calls.sent.length, 1, '身份一致的帧必须保持既有行为');
    // 负向：身份不符的帧一律拒绝（纵深防御；生产入口已被 key 过滤，这里防将来新增入口绕过）。
    await harness.maybeSendTiebaPatrolReport(2);
    await runTurn(harness, 'sid-intruder', 2, '<patrol-report sensitive="false" destination="admin">越权会话正文</patrol-report>');
    assert.equal(harness.calls.sent.length, 1, '身份不符的帧不得触发汇报发送');
    const bridgeLog = await readBridgeLog(harness);
    assert.match(bridgeLog, /后台汇报帧被拒绝：会话身份不匹配/, `拒绝路径必须留日志：${bridgeLog.slice(-2000)}`);
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('task52-4 report-stale-day：跨日丢弃无条件 log + 控制台 patrol 视图可见', async () => {
  const e1 = makeFakeE1();
  let now = Date.parse('2026-10-27T04:00:00Z');
  class FakeDate extends Date { static now() { return now; } }
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    Date: FakeDate,
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    await harness.maybeSendTiebaPatrolReport(1);
    now += 24 * 60 * 60 * 1000;
    await harness.flushPendingPatrolReports('');
    assert.equal(harness.calls.sent.length, 0, '跨日 pending 不得发送');
    const bridgeLog = await readBridgeLog(harness);
    assert.match(bridgeLog, /后台巡逻汇报跨日丢弃/, `stale-day 丢弃必须无条件留日志：${bridgeLog.slice(-2000)}`);
    assert.match(bridgeLog, /report-stale-day/);
    const status = JSON.parse(JSON.stringify(vm.runInContext('__backgroundPatrolStatus()', harness.context)));
    // task-52：patrol 顶层字段集合是 task-65 冻结契约（observability 精确断言 STATUS_KEYS），
    // 因此汇报可观测字段挂在 runtime 视图下，而不是顶层再长出新键。
    assert.equal(status?.report, undefined, `patrol 顶层不得新增字段（冻结契约）：${JSON.stringify(status)}`);
    assert.ok(status?.runtime?.report, `patrol 的 runtime 视图必须暴露 report 字段：${JSON.stringify(status)}`);
    assert.equal(status.runtime.report.staleDayDrops, 1, '控制台视图必须能查到跨日丢弃次数');
    assert.equal(status.runtime.report.lastStaleDay?.readIndex, 1, '控制台视图必须能查到最近一次跨日丢弃的 readIndex');
    assert.equal(status.runtime.report.lastStaleDay?.day, '2026-10-27', '控制台视图必须能查到被丢弃 pending 的归属日');
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

// ── task-53：后台巡逻调度漂移（onPlan 登记 / 启动 fail-closed / 跨日重启） ──────────

async function readBridgeLog(harness) {
  try {
    return await fs.readFile(path.join(harness.temp, 'state', 'bridge.log'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

test('task-53 onPlan：登记 scheduler 已算好的 nextAt，lastSeenAt=真实 now，不二次抽样', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({
    config: e1Config(),
    globals: { createBackgroundPatrolBridgeHook: fakeHookFactory, createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }), ...e1.globals },
  });
  try {
    const options = e1.schedulerOptions[0];
    assert.ok(options, 'scheduler 必须已创建');
    const future = Date.now() + 6 * 3600_000;
    const delayMs = 6 * 3600_000;
    options.onPlan({ platform: 'tieba', at: future, delayMs });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(e1.recordedPlans.length, 1, 'onPlan 必须登记一次计划（recordPlan）');
    const recorded = e1.recordedPlans[0];
    assert.equal(recorded.platform, 'tieba');
    assert.equal(recorded.nextAt, future, '落盘 nextAt 必须等于 scheduler 已算好的机会时间（不得二次抽样）');
    assert.equal(recorded.at < future, true, '记录时间必须是真实 now，不能是未来 nextAt');
    assert.equal(Math.abs(recorded.at - Date.now()) < 5000, true, 'lastSeenAt 必须是真实当前时间');
    assert.equal(e1.plans.length, 0, 'onPlan 不得再调用 planNext 二次排期');
    assert.equal(e1.state.platforms.tieba.nextAt, future);
    assert.equal(e1.state.lastSeenAt, recorded.at);
    // 两平台交错：各记各的，互不覆盖。
    const futureX = Date.now() + 3 * 3600_000;
    options.onPlan({ platform: 'xiaoheihe', at: futureX, delayMs: 3 * 3600_000 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(e1.recordedPlans.length, 2);
    assert.equal(e1.state.platforms.xiaoheihe.nextAt, futureX);
    assert.equal(e1.state.platforms.tieba.nextAt, future, '另一平台的 nextAt 不得被覆盖');
    // 跨日 nextAt 允许登记（窗口只在开火时判定，不在计划登记时裁剪）。
    const crossDay = Date.now() + 24 * 3600_000;
    options.onPlan({ platform: 'tieba', at: crossDay, delayMs: 24 * 3600_000 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(e1.state.platforms.tieba.nextAt, crossDay);
    assert.equal(e1.state.platforms.xiaoheihe.nextAt, futureX);
    // 登记成功不得触发任何后台回合投递。
    assert.equal(harness.calls.prompts.length, 0);
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('task-53 onPlan 登记失败：fail-closed 停止调度且日志可观察（不静默/不分叉）', async () => {
  const e1 = makeFakeE1({ recordPlanResult: { ok: false, reason: 'persist-failed', causeCode: 'EACCES' } });
  const harness = await bridgeHarness({
    config: e1Config(),
    globals: { createBackgroundPatrolBridgeHook: fakeHookFactory, createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }), ...e1.globals },
  });
  try {
    const options = e1.schedulerOptions[0];
    options.onPlan({ platform: 'tieba', at: Date.now() + 3600_000, delayMs: 3600_000 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(e1.recordedPlans.length, 1);
    assert.equal(e1.plans.length, 0, '登记失败不得回退成 planNext 掩盖');
    assert.equal(e1.schedulerStops.length, 1, '登记失败必须停止调度（fail-closed），避免内存/落盘 nextAt 分叉');
    assert.equal(harness.getBackgroundPatrolRuntime()?.stopping, true, '运行时必须标记 stopping');
    assert.equal(e1.state.platforms.tieba.nextAt, null, '落盘不得留下半写计划');
    const logText = await readBridgeLog(harness);
    assert.match(logText, /计划登记失败/);
    assert.match(logText, /persist-failed/);
    assert.match(logText, /EACCES/);
    assert.match(logText, /fail-closed/);
  } finally { await harness.close(); }
});

test('task-53 启动：advanceGeneration 返回 ok:false(clock-rollback) → fail-closed 不启动调度 + 可恢复日志', async () => {
  const futureLastSeen = Date.now() + 6 * 3600_000;
  const e1 = makeFakeE1({
    advanceResult: { ok: false, reason: 'clock-rollback' },
    storeState: {
      generation: 13,
      lastSeenAt: futureLastSeen,
      platforms: {
        tieba: { nextAt: null, lastRunAt: null, lastRunGeneration: null },
        xiaoheihe: { nextAt: null, lastRunAt: null, lastRunGeneration: null },
      },
    },
  });
  const harness = await bridgeHarness({
    config: e1Config(),
    globals: { createBackgroundPatrolBridgeHook: fakeHookFactory, createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }), ...e1.globals },
  });
  try {
    assert.equal(e1.schedulerOptions.length, 0, 'advance 返回 ok:false 不得创建调度器');
    assert.equal(e1.schedulerStarted.length, 0, 'advance 返回 ok:false 不得启动调度');
    assert.equal(harness.getBackgroundPatrolRuntime(), null);
    assert.ok(e1.closes.store >= 1, 'store 必须关闭');
    assert.ok(e1.closes.lifecycle >= 1, 'lifecycle 必须关闭');
    const logText = await readBridgeLog(harness);
    assert.match(logText, /generation-advance-failed/);
    assert.match(logText, /clock-rollback/);
    assert.match(logText, /lastSeenAt/);
    assert.match(logText, /需人工受控归一/);
    assert.match(logText, /不会自动改写正式 state/);
  } finally { await harness.close(); }
});

test('task-53 重启恢复：跨日 nextAt 原样恢复、不重发、启动不写计划', async () => {
  const future = Date.now() + 20 * 3600_000; // 跨日机会
  const e1 = makeFakeE1({
    storeState: {
      generation: 5,
      lastSeenAt: Date.now(),
      platforms: {
        tieba: { nextAt: future, lastRunAt: null, lastRunGeneration: null, planCount: 2 },
        xiaoheihe: { nextAt: null, lastRunAt: null, lastRunGeneration: null, planCount: 0 },
      },
    },
  });
  const harness = await bridgeHarness({
    config: e1Config(),
    globals: { createBackgroundPatrolBridgeHook: fakeHookFactory, createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }), ...e1.globals },
  });
  try {
    assert.equal(e1.schedulerOptions.length, 1);
    assert.equal(e1.schedulerOptions[0].initialNextAt.tieba, future, '持久 nextAt 必须原样恢复');
    assert.equal(e1.schedulerOptions[0].initialNextAt.xiaoheihe, null);
    assert.equal(e1.recordedPlans.length, 0, '启动恢复本身不得写计划（只有 onPlan 才登记）');
    assert.equal(harness.calls.prompts.length, 0, '重启不得自动重发后台回合');
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('巡逻汇报：超长(>800码点)不截断不发送、审计 report-too-long 且带真实码点数', async () => {
  const e1 = makeFakeE1();
  const auditDir = await makeRealAuditDir();
  const harness = await bridgeHarness({ config: e1Config({ auditDir }), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    await harness.maybeSendTiebaPatrolReport(1);
    const body = '很长'.repeat(500); // 1000 码点
    // 注意：原用例的 sensitive 属性曾被一个误入的 0x0C 控制字符吃掉引号（sensitive=^Lalse），
    // 属性解析因此退化成「保守视为敏感」，测试虽然仍绿但没测到它声称的东西。
    await runTurn(harness, 'sid', 1, `<patrol-report sensitive="false" destination="admin">${body}</patrol-report>`);
    assert.equal(harness.calls.sent.length, 0, '超长不得发送');
    // 真审计：'skipped' 与顶层 tooLongChars 曾被枚举/字段白名单整条拒绝,
    // 所以这里必须在 JSONL 上真的看到这行，而且数字要能对上（不是 unknown）。
    const lines = await readAuditLines(auditDir, (rows) => rows.some((entry) => entry.reason === 'report-too-long'));
    const row = lines.find((entry) => entry.reason === 'report-too-long');
    assert.ok(row, `必须如实落盘 report-too-long：${JSON.stringify(lines)}`);
    assert.equal(row.result, 'skipped');
    assert.equal(row.tooLongChars, 1000, '审计必须带出真实码点数（bridge 曾恒为 unknown）');
    assert.ok(!JSON.stringify(row).includes('很长很长'), '审计不得记正文');
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('巡逻汇报：回执 messageId 非法（零/对象/空白）一律不得判 delivered', async () => {
  // 注意：**负数不是非法值**。真实 QQ 私聊会返回负 message_id（本机实测），
  // 把它当非法会让真实送达记成 report-unknown 并跳过分享记忆。
  // 这里改用真正非法的形状：字符串 '0' / '-0' 与 0 都证明不了「这条消息有 id」。
  const e1 = makeFakeE1();
  const audit = [];
  class BadIdBot { on() {} off() {} async sendPrivateMessage() { return { message_id: 0 }; } }
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    SnowLumaWebSocketClient: BadIdBot,
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record(entry) { audit.push(entry); return { ok: true }; } }),
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    await harness.maybeSendTiebaPatrolReport(1);
    await flushWithModel(harness);
    assert.equal(audit.find((entry) => entry.reason === 'report-sent'), undefined, '不得记 report-sent');
    const unknown = audit.find((entry) => entry.reason === 'report-unknown');
    assert.ok(unknown, '非法回执必须记 report-unknown');
    assert.equal(unknown.result, 'unknown');
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

test('记忆落盘失败：审计可见、不降级投递、不重发、不记正文', async () => {
  const e1 = makeFakeE1();
  const audit = [];
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({ async load() {}, async record(entry) { audit.push(entry); return { ok: true }; } }),
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
    // 只让 social-v2.json 的写盘失败，验证「投递成功但记忆没落盘」的可观察性。
    atomicWriteJson: (file, obj) => {
      if (String(file).endsWith('social-v2.json')) { const err = new Error('EIO fixture'); err.code = 'EIO'; throw err; }
      return atomicWriteJson(file, obj);
    },
  } });
  try {
    await harness.maybeSendTiebaPatrolReport(1);
    await flushWithModel(harness);
    assert.equal(harness.calls.sent.length, 1, '投递本身不得因记忆失败而取消');
    const sent = audit.find((entry) => entry.reason === 'report-sent');
    assert.ok(sent, '投递成功仍要记 report-sent');
    const memory = audit.find((entry) => entry.reason === 'report-memory-unpersisted');
    assert.ok(memory, '记忆未落盘必须有审计');
    // 枚举规范化（task-190）：生产原先写 'failed'（不在 AUDIT_RESULTS）会被整条静默拒绝，
    // 现统一为 'failure'；这里改钉子，避免又把缺陷钉成契约。
    assert.equal(memory.result, 'failure');
    assert.ok(!JSON.stringify(memory).includes('第 1 次'), '审计不得记录正文');
    assert.equal(audit.filter((entry) => entry.reason === 'report-sent').length, 1, '不得重发');
  } finally { await harness.stopBackgroundPatrolRuntime(); await harness.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Codex m45752 #1/#2：可观察性（in-flight / persist-failed）与 M5/M6/M8 仓库回归。
// 只加测试，不改生产语义；全部离线、临时目录。
// ─────────────────────────────────────────────────────────────────────────────

test('M5 回归：同日内重启残留 dispatched 按 unknown 收尾、不重发，后续新读取仍可处理', async () => {
  const e1 = makeFakeE1();
  const tap = makeAuditTap();
  let now = Date.parse('2026-10-27T04:00:00Z'); // 北京 12:00
  class FakeDate extends Date { static now() { return now; } }
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    Date: FakeDate, createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: tap.factory, ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    const snapshot = {
      schemaVersion: 1, state: 'dispatched', readIndex: 1, dedupeKey: 'tieba:2026-10-27:1',
      probability: 1, shouldReport: true, random: null,
      preparedAt: now - 5000, dispatchedAt: now - 4000, settledAt: null, outcome: null,
      lastReadIndex: 1, seenKeys: ['tieba:2026-10-27:1'], stats: { draws: 1, attempts: 1 },
    };
    await harness.stopBackgroundPatrolRuntime();
    await fs.writeFile(path.join(harness.temp, 'state/xiaoheihe-patrol-report.json'), JSON.stringify(snapshot), 'utf8');
    await vm.runInContext('__startBackgroundPatrolWiring()', harness.context);

    const state = harness.getBackgroundPatrolReportOnce();
    assert.equal(state.snapshot().state, 'unknown', '重启残留 dispatched 必须按 unknown 收尾');
    assert.equal(harness.calls.sent.length, 0, '不得重发旧尝试');

    now += 2000;
    const result = await harness.maybeSendTiebaPatrolReport(2);
    assert.equal(result.deferred, true, '收尾后新读取仍必须能进入候选');
    await runTurn(harness, 'sid', 1, '<patrol-report sensitive="false" destination="admin">第 2 次自主逛贴吧</patrol-report>');
    assert.equal(harness.calls.sent.length, 1, '新事件必须照常发送');
    assert.equal(tap.records.filter((row) => row.reason === 'report-sent').length, 1);
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

test('M6 回归：drain 时去重键不符必须审计 report-skipped，不得静默丢弃也不得发送', async () => {
  const e1 = makeFakeE1();
  const auditDir = await makeRealAuditDir();
  class FakeDate extends Date { static now() { return Date.parse('2026-10-27T04:00:00Z'); } }
  const harness = await bridgeHarness({ config: e1Config({ auditDir }), globals: {
    Date: FakeDate, createBackgroundPatrolBridgeHook: fakeHookFactory,
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    assert.equal((await harness.maybeSendTiebaPatrolReport(1)).deferred, true);
    // 模拟状态机已换到别的读取：pending 的 dedupeKey 与快照不再一致。
    const state = harness.getBackgroundPatrolReportOnce();
    state.reset();
    state.prepare({ readIndex: 7, dedupeKey: 'tieba:2026-10-27:7', at: Date.now() });

    await runTurn(harness, 'sid', 1, '<patrol-report sensitive="false" destination="admin">第 1 次自主逛贴吧</patrol-report>');
    assert.equal(harness.calls.sent.length, 0, '去重键不符不得发送');
    // 真审计：'skipped' 曾是枚举外值 → 整条被静默拒绝，所以这里必须真的在 JSONL 上看到它。
    const lines = await readAuditLines(auditDir, (rows) => rows.some((row) => row.reason === 'report-skipped'));
    const skipped = lines.find((row) => row.reason === 'report-skipped');
    assert.ok(skipped, `去重键不符必须真的落盘 report-skipped：${JSON.stringify(lines)}`);
    assert.equal(skipped.result, 'skipped');
    assert.equal(skipped.platform, 'tieba');
    assert.equal(skipped.quota?.readIndex, 1, '留痕要能定位到被丢弃的那次读取');
    assert.equal(lines.some((row) => row.reason === 'report-sent'), false);
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

test('可观察性（真审计落盘）：in-flight 必须真的写进 JSONL，且不得记成已分享', async () => {
  const e1 = makeFakeE1();
  const auditDir = await makeRealAuditDir();
  class FakeDate extends Date { static now() { return Date.parse('2026-10-27T04:00:00Z'); } }
  // 不注入 createBackgroundPatrolAudit：让 bridge 用真实审计模块写临时目录。
  const harness = await bridgeHarness({ config: e1Config({ auditDir }), globals: {
    Date: FakeDate, createBackgroundPatrolBridgeHook: fakeHookFactory,
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    assert.equal((await harness.maybeSendTiebaPatrolReport(1)).deferred, true);
    const inflight = await harness.maybeSendTiebaPatrolReport(2);
    // 返回体沿用状态机 reason（'in-flight'）；审计里用可区分前缀 'report-in-flight'。
    assert.equal(inflight.reason, 'in-flight', JSON.stringify(inflight));
    // 决定性断言：真实模块校验通过并落盘（旧实现 result='skipped' 会被整条拒绝）。
    const lines = await readAuditLines(auditDir, (rows) => rows.some((entry) => entry.reason === 'report-in-flight'));
    const row = lines.find((entry) => entry.reason === 'report-in-flight');
    assert.ok(row, `in-flight 必须真的落盘：${JSON.stringify(lines)}`);
    assert.equal(row.result, 'skipped');
    assert.equal(row.platform, 'tieba');
    assert.equal(row.quota?.readIndex, 2);
    assert.ok(!JSON.stringify(row).includes('第 1 次'), '审计不得记正文');
    assert.equal(lines.some((entry) => entry.reason === 'report-sent'), false);
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

test('可观察性（真审计落盘）：persist-failed 必须审计为 failure，且不得发送', async () => {
  const e1 = makeFakeE1();
  const auditDir = await makeRealAuditDir();
  class FakeDate extends Date { static now() { return Date.parse('2026-10-27T04:00:00Z'); } }
  const harness = await bridgeHarness({ config: e1Config({ auditDir }), globals: {
    Date: FakeDate, createBackgroundPatrolBridgeHook: fakeHookFactory,
    ...e1.globals,
    backgroundPatrolReportRandom: () => 0.1, backgroundPatrolForceReportPersistFail: true,
  } });
  try {
    const failed = await harness.maybeSendTiebaPatrolReport(1);
    assert.equal(failed.reason, 'persist-failed', JSON.stringify(failed));
    assert.equal(harness.calls.sent.length, 0, '未落盘不得发送');
    const lines = await readAuditLines(auditDir, (rows) => rows.some((entry) => entry.reason === 'report-persist-failed'));
    const row = lines.find((entry) => entry.reason === 'report-persist-failed');
    assert.ok(row, `persist-failed 必须真的落盘：${JSON.stringify(lines)}`);
    assert.equal(row.result, 'failure');
    assert.equal(row.platform, 'tieba');
    assert.ok(!JSON.stringify(row).includes('第 1 次'), '审计不得记正文');
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

test('可观察性（真审计落盘）：小黑盒 in-flight 也必须审计（不得静默放弃机会）', async () => {
  const e1 = makeFakeE1();
  const auditDir = await makeRealAuditDir();
  const now = Date.parse('2026-10-27T04:00:00Z');
  class FakeDate extends Date { static now() { return now; } }
  const harness = await bridgeHarness({ config: e1Config({ platforms: { xiaoheihe: true }, auditDir }), globals: {
    Date: FakeDate, createBackgroundPatrolBridgeHook: fakeHookFactory,
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    const tapFn = harness.getBackgroundPatrolAuditTap();
    const readEvent = { platform: 'xiaoheihe', action: 'read', result: 'success', reason: null };
    await tapFn.record(readEvent, { agentClass: 'background', tool: 'get_home_content', readIndex: 1, readStartedAt: now });
    await tapFn.record(readEvent, { agentClass: 'background', tool: 'get_home_content', readIndex: 2, readStartedAt: now });
    const lines = await readAuditLines(auditDir, (rows) => rows.some((entry) => entry.reason === 'report-in-flight' && entry.platform === 'xiaoheihe'));
    const row = lines.find((entry) => entry.reason === 'report-in-flight' && entry.platform === 'xiaoheihe');
    assert.ok(row, `小黑盒 in-flight 必须真的落盘：${JSON.stringify(lines)}`);
    assert.equal(row.result, 'skipped');
    assert.equal(row.quota?.readIndex, 2);
    assert.equal(lines.some((entry) => entry.reason === 'report-sent' && entry.platform === 'xiaoheihe'), false);
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

test('可观察性（真审计落盘）：小黑盒 persist-failed 必须审计为 failure，且不得发送', async () => {
  const e1 = makeFakeE1();
  const auditDir = await makeRealAuditDir();
  const now = Date.parse('2026-10-27T04:00:00Z');
  class FakeDate extends Date { static now() { return now; } }
  const harness = await bridgeHarness({ config: e1Config({ platforms: { xiaoheihe: true }, auditDir }), globals: {
    Date: FakeDate, createBackgroundPatrolBridgeHook: fakeHookFactory,
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    // 让 persistXhhPatrolReportOnce 的 rename 必然失败：把目标路径变成目录。
    const reportFile = path.join(harness.temp, 'state/xiaoheihe-read-report.json');
    await fs.rm(reportFile, { force: true, recursive: true });
    await fs.mkdir(reportFile, { recursive: true });

    await harness.getBackgroundPatrolAuditTap().record(
      { platform: 'xiaoheihe', action: 'read', result: 'success', reason: null },
      { agentClass: 'background', tool: 'get_home_content', readIndex: 1, readStartedAt: now },
    );
    const lines = await readAuditLines(auditDir, (rows) => rows.some((entry) => entry.reason === 'report-persist-failed' && entry.platform === 'xiaoheihe'));
    const row = lines.find((entry) => entry.reason === 'report-persist-failed' && entry.platform === 'xiaoheihe');
    assert.ok(row, `小黑盒 persist-failed 必须真的落盘：${JSON.stringify(lines)}`);
    assert.equal(row.result, 'failure');
    assert.equal(row.quota?.readIndex, 1);
    assert.equal(harness.calls.sent.length, 0, '未落盘不得发送');
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

test('可观察性：贴吧跨日且发送在途时，机会被放弃必须留痕 report-in-flight', async () => {
  const e1 = makeFakeE1();
  const auditDir = await makeRealAuditDir();
  let now = Date.parse('2026-10-26T04:00:00Z'); // 北京 10-26 12:00
  class FakeDate extends Date { static now() { return now; } }
  const harness = await bridgeHarness({ config: e1Config({ auditDir }), globals: {
    Date: FakeDate, createBackgroundPatrolBridgeHook: fakeHookFactory,
    ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  let release = null;
  try {
    // 第一次：正常发一条，让状态机记下 10-26 的去重键。
    assert.equal((await harness.maybeSendTiebaPatrolReport(1)).deferred, true);
    await runTurn(harness, 'sid', 1, '<patrol-report sensitive="false" destination="admin">10-26 第一次逛贴吧</patrol-report>');
    assert.equal(harness.calls.sent.length, 1);

    // 第二次：把发送挂起，制造「发送在途」。
    const gate = new Promise((resolve) => { release = resolve; });
    const original = harness.bot.sendPrivateMessage.bind(harness.bot);
    harness.bot.sendPrivateMessage = async (id, body) => { await gate; return original(id, body); };
    assert.equal((await harness.maybeSendTiebaPatrolReport(2)).deferred, true);
    const pending = runTurn(harness, 'sid', 2, '<patrol-report sensitive="false" destination="admin">10-26 第二次逛贴吧</patrol-report>');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 跨日后再来一次读取：此时发送仍在途 ⇒ 机会被放弃，必须留痕。
    now = Date.parse('2026-10-27T04:00:00Z');
    const crossed = await harness.maybeSendTiebaPatrolReport(1);
    assert.equal(crossed.reason, 'report-in-flight', JSON.stringify(crossed));
    const lines = await readAuditLines(auditDir, (rows) => rows.some((entry) => entry.reason === 'report-in-flight' && entry.platform === 'tieba'));
    const row = lines.find((entry) => entry.reason === 'report-in-flight' && entry.platform === 'tieba');
    assert.ok(row, `跨日在途必须真的落盘 report-in-flight：${JSON.stringify(lines)}`);
    assert.equal(row.result, 'skipped');
    assert.ok(!JSON.stringify(row).includes('逛贴吧'), '审计不得记正文');

    release();
    await pending;
  } finally {
    if (release) release();
    harness.bot.sendPrivateMessage = harness.bot.sendPrivateMessage;
    await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close();
  }
});

test('可观察性：小黑盒跨日且发送在途时，机会被放弃必须留痕 report-in-flight', async () => {
  const e1 = makeFakeE1();
  const tap = makeAuditTap();
  let now = Date.parse('2026-10-26T04:00:00Z');
  class FakeDate extends Date { static now() { return now; } }
  const harness = await bridgeHarness({ config: e1Config({ platforms: { xiaoheihe: true } }), globals: {
    Date: FakeDate, createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: tap.factory, ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  let release = null;
  try {
    const readEvent = { platform: 'xiaoheihe', action: 'read', result: 'success', reason: null };
    await harness.getBackgroundPatrolAuditTap().record(readEvent,
      { agentClass: 'background', tool: 'get_home_content', readIndex: 1, readStartedAt: now });
    await runTurn(harness, 'sid', 1, '<patrol-report sensitive="false" destination="admin">10-26 第一次逛小黑盒</patrol-report>');
    assert.equal(harness.calls.sent.length, 1, '第一次应真的发送');

    const gate = new Promise((resolve) => { release = resolve; });
    const original = harness.bot.sendPrivateMessage.bind(harness.bot);
    harness.bot.sendPrivateMessage = async (id, body) => { await gate; return original(id, body); };
    await harness.getBackgroundPatrolAuditTap().record(readEvent,
      { agentClass: 'background', tool: 'get_home_content', readIndex: 2, readStartedAt: now });
    const pending = runTurn(harness, 'sid', 2, '<patrol-report sensitive="false" destination="admin">10-26 第二次逛小黑盒</patrol-report>');
    await new Promise((resolve) => setTimeout(resolve, 20));

    now = Date.parse('2026-10-27T04:00:00Z');
    await harness.getBackgroundPatrolAuditTap().record(readEvent,
      { agentClass: 'background', tool: 'get_home_content', readIndex: 3, readStartedAt: now });
    const row = tap.records.find((entry) => entry.reason === 'report-in-flight' && entry.platform === 'xiaoheihe' && entry.quota?.readIndex === 3);
    assert.ok(row, '小黑盒跨日在途必须留痕 report-in-flight（且能定位到被放弃的读取）');
    assert.equal(row.result, 'skipped');
    assert.ok(!JSON.stringify(row).includes('逛小黑盒'), '审计不得记正文');

    release();
    await pending;
  } finally {
    if (release) release();
    await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close();
  }
});

test('M5 回归（小黑盒）：重启残留 dispatched 按 unknown 收尾、不重发，当天后续读取仍能处理', async () => {
  const e1 = makeFakeE1();
  const tap = makeAuditTap();
  let now = Date.parse('2026-10-27T04:00:00Z'); // 北京 12:00
  class FakeDate extends Date { static now() { return now; } }
  const harness = await bridgeHarness({ config: e1Config({ platforms: { xiaoheihe: true } }), globals: {
    Date: FakeDate, createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: tap.factory, ...e1.globals, backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    const snapshot = {
      schemaVersion: 1, state: 'dispatched', readIndex: 1, dedupeKey: 'xiaoheihe:2026-10-27:1',
      probability: 1, shouldReport: true, random: null,
      preparedAt: now - 5000, dispatchedAt: now - 4000, settledAt: null, outcome: null,
      lastReadIndex: 1, seenKeys: ['xiaoheihe:2026-10-27:1'], stats: { draws: 1, attempts: 1 },
    };
    await harness.stopBackgroundPatrolRuntime();
    await fs.writeFile(path.join(harness.temp, 'state/xiaoheihe-read-report.json'), JSON.stringify(snapshot), 'utf8');
    await vm.runInContext('__startBackgroundPatrolWiring()', harness.context);

    // 决定性断言：重启残留的 dispatched 必须被收尾成 unknown（而不是留在 dispatched 卡住后续读取）。
    // 只断言「后续能发」是不够的——那条路径在残留 dispatched 时也会因 TTL 过期而偶然通过。
    assert.equal(harness.getXhhPatrolReportOnce().snapshot().state, 'unknown', '重启残留 dispatched 必须收尾为 unknown');
    const readEvent = { platform: 'xiaoheihe', action: 'read', result: 'success', reason: null };
    // 收尾后同一 dedupeKey 的重放必须被去重（不重发）。
    await harness.getBackgroundPatrolAuditTap().record(readEvent,
      { agentClass: 'background', tool: 'get_home_content', readIndex: 1, readStartedAt: now });
    assert.equal(harness.calls.sent.length, 0, '收尾后同 readIndex 重放不得再发');
    assert.equal(tap.records.some((row) => row.reason === 'report-in-flight'), false, '收尾后不得被当成 in-flight 卡住');

    // 新的一次读取必须仍能进入候选并发送（说明 dispatched 没有永久阻塞）。
    now += 60000;
    await harness.getBackgroundPatrolAuditTap().record(readEvent,
      { agentClass: 'background', tool: 'get_home_content', readIndex: 2, readStartedAt: now });
    await runTurn(harness, 'sid', 1, '<patrol-report sensitive="false" destination="admin">第 2 次自主逛小黑盒</patrol-report>');
    assert.equal(harness.calls.sent.length, 1, '收尾后新读取必须照常分享');
    assert.equal(tap.records.filter((row) => row.reason === 'report-sent').length, 1);
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

// ─── m46812（Codex 复核）：审计失败不得静默 ────────────────────────────────
// 背景：审计模块的 record() 失败时**不抛异常**，而是返回 {ok:false,error}；写盘失败同样返回
// AUDIT_WRITE_FAILED。原实现只挂 .catch 且丢弃返回值 ⇒ 校验拒绝与磁盘失败在生产里都不可见。
// 这几条用**真审计模块**制造两种真实失败，断言 counts 与 lastFailure 都被记下。

test('m46812：审计校验被拒绝时必须计数（不得静默吞掉返回值）', async () => {
  const e1 = makeFakeE1();
  const auditDir = await makeRealAuditDir();
  const harness = await bridgeHarness({ config: e1Config({ auditDir }), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory, ...e1.globals,
  } });
  try {
    vm.runInContext('__resetBackgroundPatrolAuditFailures()', harness.context);
    // 直接打一条**必然被审计模块拒绝**的载荷：result 不在白名单。
    harness.recordBackgroundPatrolAudit('probe-rejected', 'report', 'definitely-not-a-result');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const counts = harness.getAuditFailures();
    assert.equal(counts.rejected, 1, '校验拒绝必须计入 rejected');
    assert.equal(counts.writeFailed, 0, '校验拒绝不是写盘失败');
    assert.equal(counts.last?.code, 'AUDIT_INVALID_ENUM', '必须记下真实错误码');
    assert.equal(counts.last?.reason, 'probe-rejected', '必须记下原因名');
    // 磁盘上不能出现这条被拒绝的记录。
    const rows = await readAuditLines(auditDir, () => true).catch(() => []);
    assert.equal(rows.some((r) => r.reason === 'probe-rejected'), false, '被拒绝的记录不得落盘');
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

test('m46812：审计写盘失败时必须计数（目录不可写，不是抛异常）', async () => {
  const e1 = makeFakeE1();
  const auditDir = await makeRealAuditDir();
  const harness = await bridgeHarness({ config: e1Config({ auditDir }), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory, ...e1.globals,
  } });
  try {
    vm.runInContext('__resetBackgroundPatrolAuditFailures()', harness.context);
    // 让当日审计文件**无法追加**：把目录删掉换成同名普通文件。
    const day = vm.runInContext(
      "new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })",
      harness.context,
    );
    await fs.rm(auditDir, { recursive: true, force: true });
    await fs.writeFile(auditDir, 'blocked', 'utf8');

    harness.recordBackgroundPatrolAudit('probe-write-failed', 'read', 'success');
    await new Promise((resolve) => setTimeout(resolve, 150)); // 等异步 append settle

    const counts = harness.getAuditFailures();
    assert.equal(counts.writeFailed, 1, `写盘失败必须计入 writeFailed（day=${day}）`);
    assert.equal(counts.last?.code, 'AUDIT_WRITE_FAILED', '必须记下 AUDIT_WRITE_FAILED');
  } finally {
    await fs.rm(auditDir, { force: true }).catch(() => {});
    await fs.mkdir(auditDir, { recursive: true }).catch(() => {});
    await harness.stopBackgroundPatrolRuntime().catch(() => {});
    await harness.close();
  }
});

test('m46812：审计健康时不得产生假失败（防止计数变成噪声）', async () => {
  const e1 = makeFakeE1();
  const auditDir = await makeRealAuditDir();
  const harness = await bridgeHarness({ config: e1Config({ auditDir }), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory, ...e1.globals,
  } });
  try {
    vm.runInContext('__resetBackgroundPatrolAuditFailures()', harness.context);
    harness.recordBackgroundPatrolAudit('probe-healthy', 'read', 'success');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const counts = harness.getAuditFailures();
    assert.equal(counts.rejected, 0, '健康写入不得计入 rejected');
    assert.equal(counts.writeFailed, 0, '健康写入不得计入 writeFailed');
    assert.equal(counts.last, null, '健康写入不得留下 lastFailure');
    // 并且这条确实落盘了（证明上面不是「根本没写」）。
    const rows = await readAuditLines(auditDir, (list) => list.some((r) => r.reason === 'probe-healthy'));
    assert.equal(rows.some((r) => r.reason === 'probe-healthy'), true, '健康记录必须真的落盘');
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

test('m46812：状态视图必须暴露审计失败计数（运维可见面）', async () => {
  const e1 = makeFakeE1();
  const auditDir = await makeRealAuditDir();
  const harness = await bridgeHarness({ config: e1Config({ auditDir }), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory, ...e1.globals,
  } });
  try {
    vm.runInContext('__resetBackgroundPatrolAuditFailures()', harness.context);
    harness.recordBackgroundPatrolAudit('probe-visible', 'report', 'nope');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const view = vm.runInContext('__backgroundPatrolStatus()', harness.context);
    assert.equal(typeof view.audit, 'object', '状态视图必须有 audit 段');
    assert.equal(view.audit.instanceReady, true, '真审计实例应就绪');
    assert.equal(view.audit.failures.rejected, 1, '状态视图必须能看到这次拒绝');
    assert.equal(view.audit.lastFailure?.reason, 'probe-visible', '状态视图必须带上原因名');
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

// ─── m47919（Codex m47874 裁决）：审计可观察面口径收紧 ─────────────────────────
// 六条验收口径对应的断言都在下面：
//  ① 本进程内存计数、重启归零、不是磁盘侧计数 → "口径" 用例 + 每条用的 scope 断言；
//  ② instanceReady 只代表实例已创建，不代表目录可写 → "load 失败" 用例；
//  ③ 失败摘要只含安全码/原因名/动作/时间/形态 → "零敏感信息" 用例（键集合精确断言）；
//  ④ 五种失败形态各自可辨识 → 三条按真模块/假实例分别打 ① ② 与 ③ ④ ⑤；
//  ⑤ 诊断不改变业务结果、不递归审计 → 两条；
//  ⑥ 内存计数与落盘计数覆盖范围不同 → "两套账" 用例。

function auditShapeTotal(byShape) {
  return Object.values(byShape).reduce((sum, value) => sum + value, 0);
}

function auditViewOf(harness) {
  return vm.runInContext('__backgroundPatrolStatus()', harness.context).audit;
}

test('m47919①②⑥：状态视图必须显式声明「本进程内存计数」，不得冒充落盘/跨进程口径', async () => {
  const e1 = makeFakeE1();
  const auditDir = await makeRealAuditDir();
  const harness = await bridgeHarness({ config: e1Config({ auditDir }), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory, ...e1.globals,
  } });
  try {
    const view = auditViewOf(harness);
    // ① 作用域必须机器可读，且四条都指向「内存、重启即归零、不落盘、不代表别的进程」。
    // 注意：view 是 vm realm 里的对象，跨 realm 原型不同，deepStrictEqual 前先摊平成宿主对象。
    assert.deepEqual({ ...view.scope }, {
      kind: 'process-memory',
      resetsOnRestart: true,
      persistedToDisk: false,
      authoritativeForOtherProcesses: false,
      diskCountersAvailableFrom: '__backgroundPatrolAuditDiskStatus',
    }, 'scope 必须把内存计数口径写死（不得让人外推成磁盘侧/跨进程计数）');
    // ⑥ 落盘计数不在同步视图里缓存，并明确指向审计模块自己的 status()。
    assert.equal(view.diskCounters, null, '同步视图不得夹带落盘计数（status() 是异步的，读它会改变时序）');
    // m47919-F1（t4 复审）：这个值必须**可解析**——指向真实存在的入口，否则等于没说。
    // 真实入口是测试接缝，不是 HTTP 路由；用它取一次落盘计数来证明指得到东西。
    assert.equal(typeof vm.runInContext('__backgroundPatrolAuditDiskStatus', harness.context), 'function',
      'diskCountersAvailableFrom 指向的入口必须真实存在');
    assert.equal(view.scope.diskCountersAvailableFrom, '__backgroundPatrolAuditDiskStatus');
    // 测试接缝同样带口径声明（防止有人用接缝绕过）。
    const seam = vm.runInContext('__backgroundPatrolAuditFailures()', harness.context);
    assert.equal(seam.scope, 'process-memory');
    assert.equal(seam.resetsOnRestart, true);
    // 重置只清本进程内存计数：清完必须真的回到全零（而不是只清两个总数）。
    vm.runInContext('__resetBackgroundPatrolAuditFailures()', harness.context);
    const after = vm.runInContext('__backgroundPatrolAuditFailures()', harness.context);
    assert.equal(after.rejected, 0);
    assert.equal(after.writeFailed, 0);
    assert.equal(after.last, null);
    assert.deepEqual({ ...after.byShape }, { invalid: 0, writeFailed: 0, okFalse: 0, promiseRejected: 0, threw: 0 }, '重置必须连形态一起清零');
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

test('m47919④：真审计模块的校验拒绝 → 形态 invalid（不混进写盘失败）', async () => {
  const e1 = makeFakeE1();
  const auditDir = await makeRealAuditDir();
  const harness = await bridgeHarness({ config: e1Config({ auditDir }), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory, ...e1.globals,
  } });
  try {
    vm.runInContext('__resetBackgroundPatrolAuditFailures()', harness.context);
    harness.recordBackgroundPatrolAudit('probe-shape-invalid', 'report', 'definitely-not-a-result');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const counts = harness.getAuditFailures();
    assert.equal(counts.byShape.invalid, 1, '校验拒绝必须记成 invalid');
    assert.equal(counts.byShape.writeFailed, 0, '校验拒绝不得被算成写盘失败');
    assert.equal(counts.byShape.okFalse, 0, '校验拒绝有明确 AUDIT_INVALID_* 码，不得退化成 okFalse');
    assert.equal(counts.rejected, 1);
    assert.equal(counts.last?.shape, 'invalid');
    assert.equal(counts.last?.code, 'AUDIT_INVALID_ENUM');
    const view = auditViewOf(harness);
    assert.equal(view.failures.byShape.invalid, 1);
    assert.equal(view.failures.total, 1, 'total 必须等于 rejected + writeFailed');
    assert.equal(auditShapeTotal(view.failures.byShape), view.failures.total, '五形态计数之和必须等于 total');
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

test('m47919④：真审计模块的写盘失败 → 形态 writeFailed（不是校验拒绝）', async () => {
  const e1 = makeFakeE1();
  const auditDir = await makeRealAuditDir();
  const harness = await bridgeHarness({ config: e1Config({ auditDir }), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory, ...e1.globals,
  } });
  try {
    vm.runInContext('__resetBackgroundPatrolAuditFailures()', harness.context);
    await fs.rm(auditDir, { recursive: true, force: true });
    await fs.writeFile(auditDir, 'blocked', 'utf8');
    harness.recordBackgroundPatrolAudit('probe-shape-write-failed', 'read', 'success');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const counts = harness.getAuditFailures();
    assert.equal(counts.byShape.writeFailed, 1, '写盘失败必须记成 writeFailed');
    assert.equal(counts.byShape.invalid, 0, '写盘失败不是校验拒绝');
    assert.equal(counts.writeFailed, 1);
    assert.equal(counts.last?.shape, 'writeFailed');
    assert.equal(counts.last?.code, 'AUDIT_WRITE_FAILED');
    const view = auditViewOf(harness);
    assert.equal(auditShapeTotal(view.failures.byShape), view.failures.total);
  } finally {
    await fs.rm(auditDir, { force: true }).catch(() => {});
    await fs.mkdir(auditDir, { recursive: true }).catch(() => {});
    await harness.stopBackgroundPatrolRuntime().catch(() => {});
    await harness.close();
  }
});

test('m47919④：{ok:false} / Promise 拒绝 / 同步抛异常三种形态必须彼此可辨', async () => {
  const e1 = makeFakeE1();
  // 一个受控假实例：按 reason 决定用哪种失败形态回应（真模块只会走 ①②，④⑤ 只能这样造）。
  const factory = () => ({
    async load() {},
    record(payload) {
      const reason = payload?.reason;
      if (reason === 'probe-shape-ok-false') return { ok: false }; // 无错误码
      if (reason === 'probe-shape-promise-rejected') return Promise.reject(new Error('boom /tmp/secret'));
      if (reason === 'probe-shape-threw') throw new Error('sync boom /tmp/secret');
      return { ok: true };
    },
  });
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: factory,
    ...e1.globals,
  } });
  try {
    vm.runInContext('__resetBackgroundPatrolAuditFailures()', harness.context);
    harness.recordBackgroundPatrolAudit('probe-shape-ok-false', 'read', 'success');
    harness.recordBackgroundPatrolAudit('probe-shape-promise-rejected', 'read', 'success');
    // Promise 拒绝在 microtask 里结算，必须等它落地再打第三种形态，否则「最近一次」会被抢。
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(harness.getAuditFailures().last?.shape, 'promiseRejected', 'Promise 拒绝必须先落地');
    harness.recordBackgroundPatrolAudit('probe-shape-threw', 'read', 'success');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const counts = harness.getAuditFailures();
    assert.equal(counts.byShape.okFalse, 1, '{ok:false} 必须记成 okFalse');
    assert.equal(counts.byShape.promiseRejected, 1, 'Promise 拒绝必须单独可辨');
    assert.equal(counts.byShape.threw, 1, '同步抛异常必须单独可辨');
    assert.equal(counts.byShape.invalid, 0);
    assert.equal(counts.byShape.writeFailed, 0);
    assert.equal(counts.rejected, 3, '这三种都不是写盘失败，只计 rejected');
    assert.equal(counts.writeFailed, 0);
    // last 是「最近一次」，上面最后一条是同步抛异常。
    assert.equal(counts.last?.shape, 'threw');
    assert.equal(counts.last?.code, 'AUDIT_THROWN');
    const view = auditViewOf(harness);
    assert.equal(auditShapeTotal(view.failures.byShape), view.failures.total);
    assert.equal(view.failures.total, 3);
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

test('m47919②：instanceReady 只代表实例已创建，load 失败必须显式暴露（不得当成目录可写）', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    // load 抛错，且错误正文带路径/令牌：这些绝不能进状态视图。
    createBackgroundPatrolAudit: () => ({
      async load() { const error = new Error('EACCES: open /tmp/secret/audit-dir token=abcdef'); error.code = 'EACCES'; throw error; },
      async record() { return { ok: true }; },
    }),
    ...e1.globals,
  } });
  try {
    const view = auditViewOf(harness);
    assert.equal(view.instanceReady, true, '实例对象确实被创建了（instanceReady 只表达这件事）');
    assert.equal(view.loadAttempted, true, '必须能看出「试过 load」');
    assert.equal(view.instanceLoaded, false, 'load 失败时 instanceLoaded 必须为 false');
    assert.equal(view.loadFailure, 'EACCES', 'load 失败原因只留安全错误码');
    assert.equal(JSON.stringify(view).includes('/tmp'), false, 'load 失败原因不得带文件路径');
    assert.equal(JSON.stringify(view).includes('token=abcdef'), false, 'load 失败原因不得带令牌');
    assert.equal(JSON.stringify(view).includes('EACCES: open'), false, 'load 失败原因不得带错误正文');
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

test('m47919②：load 成功时 instanceLoaded=true 且 loadFailure 为 null', async () => {
  const e1 = makeFakeE1();
  const auditDir = await makeRealAuditDir();
  const harness = await bridgeHarness({ config: e1Config({ auditDir }), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory, ...e1.globals,
  } });
  try {
    const view = auditViewOf(harness);
    assert.equal(view.instanceReady, true);
    assert.equal(view.loadAttempted, true);
    assert.equal(view.instanceLoaded, true, '真模块 load 成功后必须为 true');
    assert.equal(view.loadFailure, null);
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

test('m47919③：失败摘要零敏感信息（键集合固定，路径/正文/令牌/堆栈一律不进）', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({
      async load() {},
      // 故意把路径/正文塞进 code，把自由文本塞进 message；错误对象里还塞 token。
      record() {
        return { ok: false, error: { code: '/tmp/secret/audit.jsonl', message: 'token=abcdef cookie=xyz at Object.<anonymous> (D:\\qq-bridge\\src\\bridge.js:1:1)' } };
      },
    }),
    ...e1.globals,
  } });
  try {
    vm.runInContext('__resetBackgroundPatrolAuditFailures()', harness.context);
    // reason / action 也故意传非机器码（含路径与令牌）。
    harness.recordBackgroundPatrolAudit('/tmp/secret token', { evil: 'D:\\qq-bridge' }, 'success');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const view = auditViewOf(harness);
    assert.ok(view.lastFailure, '必须留下失败摘要');
    assert.deepEqual(
      Object.keys(view.lastFailure).sort(),
      ['action', 'at', 'code', 'reason', 'shape'],
      '失败摘要的键集合必须固定这五个（多一个键就可能是泄露通道）',
    );
    assert.equal(typeof view.lastFailure.at, 'number', 'at 必须是毫秒时间戳');
    assert.equal(view.lastFailure.code, 'AUDIT_UNKNOWN_FAILURE', '非法错误码必须降级成安全码');
    assert.equal(view.lastFailure.reason, 'unknown', '非法原因名必须降级成 unknown');
    assert.equal(view.lastFailure.action, 'unknown', '非法动作名必须降级成 unknown');
    assert.equal(view.lastFailure.shape, 'okFalse');
    const serialized = JSON.stringify(view);
    for (const marker of ['/tmp', 'secret', 'token', 'cookie', 'Object.<anonymous>', 'qq-bridge', 'bridge.js', 'stack']) {
      assert.equal(serialized.includes(marker), false, `状态视图不得包含敏感标记：${marker}`);
    }
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

test('m47919⑤：审计抛异常时不得改变业务结果（汇报照常发出，且诊断自身不抛）', async () => {
  const e1 = makeFakeE1();
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({
      async load() {},
      record() { throw new Error('audit exploded /tmp/secret'); },
    }),
    ...e1.globals,
    // 汇报是否发出必须由业务自己决定；这里固定抽签，避免测试被随机数否决。
    backgroundPatrolReportRandom: () => 0.1,
  } });
  try {
    vm.runInContext('__resetBackgroundPatrolAuditFailures()', harness.context);
    // 直接调用接线：审计抛异常不得冒泡回调用方。
    assert.doesNotThrow(
      () => harness.recordBackgroundPatrolAudit('probe-nonintrusive', 'read', 'success'),
      '审计诊断失败不得抛回业务路径',
    );
    // 走真实汇报链路：先挂起一次汇报，再由模型回合落地——审计全程抛异常也得照常发。
    assert.equal((await harness.maybeSendTiebaPatrolReport(1)).deferred, true);
    await runTurn(harness, 'sid', 1, '<patrol-report sensitive="false" destination="admin">审计炸了也要照常汇报</patrol-report>');
    assert.equal(harness.calls.sent.length, 1, '审计失败不得让汇报发不出去');
    assert.equal(harness.calls.sent[0].text.includes('审计炸了也要照常汇报'), true, '汇报正文必须照常');
    assert.ok(harness.getAuditFailures().byShape.threw >= 1, '吞掉异常不等于不计数：必须记成 threw');
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

test('m47919⑤：诊断不递归审计（一次失败只对应一次 record 调用）', async () => {
  const e1 = makeFakeE1();
  const calls = [];
  const harness = await bridgeHarness({ config: e1Config(), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    createBackgroundPatrolAudit: () => ({
      async load() {},
      record(payload) { calls.push(payload); return { ok: false, error: { code: 'AUDIT_WRITE_FAILED' } }; },
    }),
    ...e1.globals,
  } });
  try {
    vm.runInContext('__resetBackgroundPatrolAuditFailures()', harness.context);
    const before = calls.length;
    harness.recordBackgroundPatrolAudit('probe-recursion', 'read', 'success');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(calls.length - before, 1, '记一次失败不得引发额外的审计写入（否则就是递归审计）');
    const counts = harness.getAuditFailures();
    assert.equal(counts.byShape.writeFailed, 1);
    assert.equal(counts.writeFailed, 1);
    assert.equal(counts.rejected, 0);
    const reasonOfNested = calls.slice(before).map((payload) => payload?.reason);
    assert.deepEqual(reasonOfNested, ['probe-recursion'], '诊断自身不得伪造审计记录');
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

test('m47919⑥：内存计数与落盘计数是两套账（覆盖范围不同，不可互换）', async () => {
  const e1 = makeFakeE1();
  const auditDir = await makeRealAuditDir();
  const harness = await bridgeHarness({ config: e1Config({ auditDir }), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory, ...e1.globals,
  } });
  try {
    vm.runInContext('__resetBackgroundPatrolAuditFailures()', harness.context);
    harness.recordBackgroundPatrolAudit('probe-two-ledgers', 'read', 'success');
    await new Promise((resolve) => setTimeout(resolve, 150));
    // 落盘侧：审计模块自己的 status()，只有 load 过才有意义。
    const disk = await vm.runInContext('__backgroundPatrolAuditDiskStatus()', harness.context);
    assert.equal(disk.ok, true, '落盘侧计数必须可读');
    assert.equal(typeof disk.written, 'number');
    assert.ok(disk.written >= 1, '健康写入必须在落盘侧可见');
    // 内存侧：这条既没被拒绝也没写盘失败，所以仍是 0（两套账不会互相冒充）。
    const view = auditViewOf(harness);
    assert.equal(view.failures.total, 0, '健康写入不得计入内存失败计数');
    assert.equal(view.diskCounters, null, '同步视图不得把落盘计数混进来');
    assert.equal(view.scope.diskCountersAvailableFrom, '__backgroundPatrolAuditDiskStatus');
  } finally { await harness.stopBackgroundPatrolRuntime().catch(() => {}); await harness.close(); }
});

test('m47919⑥：审计未接线时落盘侧计数明确报 absent，不得伪造成 0', async () => {
  const eager = await bridgeHarness({ config: e1Config({ enabled: false }), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
  } });
  try {
    const view = auditViewOf(eager);
    assert.equal(view.instanceReady, false, '未启用时不得谎报实例就绪');
    assert.equal(view.loadAttempted, false);
    const disk = await vm.runInContext('__backgroundPatrolAuditDiskStatus()', eager.context);
    assert.deepEqual({ ...disk }, { ok: false, reason: 'audit-instance-absent' }, '没有实例必须如实报 absent');
  } finally { await eager.close(); }

  const e1 = makeFakeE1();
  const noStatus = await bridgeHarness({ config: e1Config(), globals: {
    createBackgroundPatrolBridgeHook: fakeHookFactory,
    // 有 record 但没有 status：必须与「没有实例」区分开。
    createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    ...e1.globals,
  } });
  try {
    const disk = await vm.runInContext('__backgroundPatrolAuditDiskStatus()', noStatus.context);
    assert.deepEqual({ ...disk }, { ok: false, reason: 'audit-status-unsupported' }, '实例在但不支持 status() 必须单独报');
  } finally { await noStatus.stopBackgroundPatrolRuntime().catch(() => {}); await noStatus.close(); }
});
