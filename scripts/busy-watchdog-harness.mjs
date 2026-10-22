// 卡忙自愈看门狗测试的**共用 harness**（t59 拆分出来的公共模块）。
//
// 为什么需要它：C-reconnect 家族约 19.6s、占 test-busy-watchdog.mjs 的 39%，两个文件合跑会
// 逼近 test-audit 的每脚本 60s 硬上限（并发落地窗口里实测过 63.5s）。把 harness 抽到这里之后，
// `scripts/test-busy-watchdog.mjs` 与 `scripts/test-c-reconnect.mjs` **共用同一份实现**，
// 各自吃 60s 预算、各自独立跑；任何一条断言语义都没有改动（只搬位置）。
//
// 本模块不做断言，只提供：
//   · `busyHarness()`：在临时目录 + 假 DSH/QQ 上跑真实 src/bridge.js（VM 注入真函数 + 假 peer），
//     并把看门狗内部结构暴露给断言；不读线上 config.json、不写真实 state/、不连 QQ/DSH。
//   · `test()/finish()`：用例登记、✅/❌ 打印与显式退出码（两个脚本各自的标题）。
//   · 夹具构造器与等待工具（帧构造、断流 mux、探活失败桩、waitFor 等）。
//
// 命名注意：本文件**故意不叫 test-*.mjs**（它不是用例脚本，不进 test-audit 的清单）。
// 也**故意不 import assert**：本模块只提供夹具/助手，任何断言都写在两个用例文件里
// （t59 验收：共用 harness 不得含断言语义）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import * as coreBindings from './bridge-core-bindings.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as forward from '../src/forward.js';
import * as slang from '../src/slang-learner.js';
import * as sticker from '../src/sticker-lib.js';
import * as modelPrices from '../src/model-prices.js';
import * as tokenLedger from '../src/token-ledger.js';
import * as voiceLib from '../src/send-voice-lib.js';
import * as stateAcl from '../src/state-acl.mjs';
import * as retryObserver from '../src/retry-observer.js';
import * as retryDiagnostic from '../src/retry-diagnostic.js';
import * as errorNotice from '../src/error-notice.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const CONSOLE_TOKEN = 'fixture-console-token';

/** 在临时目录里跑真实桥接（假 api / 假 bot），并暴露看门狗内部结构供断言。
 * `transformSource`：载荷性反证用（在**内存副本**里把源码改回旧写法，仓库文件一个字节都不动）。 */
export async function busyHarness({ config = {}, transformSource = null, globals = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-busy-watchdog-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: CONSOLE_TOKEN, slang: { enabled: false }, ...config,
  }));
  const calls = { created: [], prompts: [], sent: [], follows: [], http: [], sessionList: 0 };
  // C-stall（t44）：`api.sessions.list({})` 的夹具。默认**故意不提供**（等于 DSH 没有这个 API），
  // 由 D 系列用例用 setSessionsList 显式注入；计数器用来断言「窗口未到 ⇒ 一次都不探测」。
  let sessionsListImpl = null;
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async () => success({}),
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
      // C-stall 探测唯一用到的 API（与 /api/workspace/reset 同一个）。未注入 impl 时按「DSH 无此 API」处理。
      list: async (params) => {
        calls.sessionList += 1;
        if (typeof sessionsListImpl !== 'function') throw new Error('fixture: sessions.list 未注入');
        return sessionsListImpl(params);
      },
    },
    respond: async () => success({}),
    stopSessionWork: async () => ({ removed: 0 }),
    callUnary: async () => success({ accepted: true }),
    // 与生产 NodeApiClient 的 API 面对齐：checkHealth(signal) 只是 settings.describe 探测结果的代理。
    // 恢复用例仍通过控制 settings.describe 来切换成功/失败，这里绝不能写死 true。
    settings: { describe: async () => { throw new Error('fixture: settings 不可用'); } },
    checkHealth: async (signal) => {
      const result = await api.settings.describe({}, signal);
      return result?.result?.ok === true;
    },
    agentPresets: { list: async () => success({ presets: [{ id: 'standard', isDefault: true }, { id: 'qq-chat' }, { id: 'qq-chat-v2' }] }) },
  };
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async request() { return { status: 'ok', retcode: 0, data: [] }; }
  }
  const intervals = [];   // 捕获 setInterval 注册（看门狗定时器）
  const timeouts = new Set();
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  // 载荷性反证入口：只在内存里改（不改仓库文件）。
  if (typeof transformSource === 'function') source = transformSource(source);
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。必须按行处理：这些 import
  // 有多行写法，单行正则会在第一个分号处停下并吞掉紧随其后的正常代码。
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  // 在 main() 里提前返回：把看门狗内部结构暴露给断言（不改变 bridge.js 自身）。
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    cfg, state, api, socialV2, getSocialV2State, ensureSession, sendToQQ,
    startConsoleServer, retireSession, drainPromptQueue,
    sendWakePromptV2, scheduleWakeV2, deliverPrompt, isConversationBusyV2, wakePriorityV2,
    promptQueues, pendingWakeKeys, pendingWakeLeaseTimers, collectors, v2TurnStartAt, v2TurnNoV2,
    wakeConfigUpdatedKeys, markReadCalledKeys,
    busyWatchdog, busyWatchdogConfig, runBusyWatchdogScanV2, startBusyWatchdogV2,
    markBusyRearmedWakeV2, clearBusyRearmedWakeV2,
    queued, enqueueForRetry, flushQueue,
    noteFrameActivityV2, noteActionActivityV2, clearBusyWatchdogRuntimeV2,
    busyFlagsV2,
    checkDsh, handleDshReconnectV2, snapshotDshDownInFlightTurnsV2, cleanupDshDownInFlightTurnsV2,
    recheckDshReconnectV2,
    // F-R2：有界复核的时间轴缩放（与 SCALED 同一手法；生产默认值 8s/30s 由静态断言守住）
    setReconnectRecheckPlanV2(plan) { reconnectRecheckPlanV2 = plan; },
    createTurnCollector, pumpMux,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
    stallProbeConfigV2, maybeStartStallProbeV2, scanBusyWatchdogKeyV2,
  };
  bot.onPrivateMessage(async (event) => {`);
  const context = vm.createContext({
    fs, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal,
    console: { log() {}, error() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) }),
    execFileSync: () => '',
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, exit: (code) => { throw new Error(`unexpected exit ${code}`); } },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timeouts.add(t); return t; },
    clearTimeout: (t) => { timeouts.delete(t); clearTimeout(t); },
    // 看门狗定时器**不真的跑**：记下注册参数，测试按需手动触发，保证断言确定。
    setInterval: (fn, ms) => { const handle = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; } }; intervals.push(handle); return handle; },
    clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker,
    ...modelPrices, ...tokenLedger, ...voiceLib, ...stateAcl, ...coreBindings, ...retryObserver, ...retryDiagnostic, ...errorNotice,
    defaultErrorNoticeGate: errorNotice.createErrorNoticeGate(),
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    processAudioVolume: async (file) => ({ path: String(file), converted: false, applied: false, mode: 'original', volume: 1, loudness: null }),
    cleanupTemp: () => {},
    ...globals,
  });
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData }; })());`, context);
  vm.runInContext(source + '\nglobalThis.busyHarnessReady = main();', context);
  const bridge = await context.busyHarnessReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  const logFile = path.join(temp, 'state', 'bridge.log');
  return {
    ...bridge,
    calls,
    intervals,
    temp,
    readLog: () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } },
    // C-stall（t44）：注入 api.sessions.list({}) 的返回（探测唯一的 DSH 输入）+ 调用计数。
    // 必须放在 harness 作用域里（`calls`/`sessionsListImpl` 只在这里可见 —— 桥接源码里没有它们）。
    setSessionsList(impl) { sessionsListImpl = impl; },
    sessionsListCalls() { return calls.sessionList; },
    async close() {
      for (const t of timeouts) clearTimeout(t);
      fs.rmSync(temp, { recursive: true, force: true });
    },
  };
}

// 缩放的默认配置（**100 倍缩放**：warnMs 3000ms ↔ 300000ms）：让 5min/15min/30min 三档在
// 秒级跑完，且日志里的 `busy=Ns/idle=Ns` 仍是整数秒。绝不能靠真等 15 分钟，也不把默认值写进代码。
export const SCALED = { warnMs: 3000, releaseMs: 9000, hardCapMs: 18000, checkIntervalMs: 1000, rearmCooldownMs: 60000, maxRearmPerHour: 3 };
export const withWatchdog = (wd) => ({ socialV2: { enabled: true, busyWatchdog: { ...wd } } });

/** 造一个「② pendingWakeKeys 卡住」的会话（DSH 接受过 prompt，但永远没有 turn/end）。 */
export function stuckByPendingWake(h, key = 'private:123') {
  h.setMode('reserved2');
  const st = h.getSocialV2State(key);
  h.pendingWakeKeys.add(key);
  return { key, st };
}

/** 造一个「④ 陈旧 collector（重连重建的在途回合）」的会话。 */
export function seedStaleCollector(h, sid, turn = 10, text = '卡死前的回复') {
  const collector = h.createTurnCollector();
  collector.push({ type: 'turn/start', data: { turn } });
  collector.push({ type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } });
  h.collectors.set(sid, collector);
  h.v2TurnStartAt.set(sid, Date.now());
}

/**
 * 让 pumpMux 消费一批帧。首次调用时装一条**持久**的假事件流：pumpMux 的 `for await` 一旦
 * 建立就不会重建，所以多次 feedFrames 必须喂同一条流（否则第二批帧会被静默丢弃）。
 */
export function ensureFrameFeed(h) {
  if (!h.__frameQueue) {
    h.__frameQueue = [];
    h.__frameWaiters = [];
    h.api.events.mux = async function* () {
      for (;;) {
        while (h.__frameQueue.length === 0) {
          await new Promise((resolve) => h.__frameWaiters.push(resolve));
        }
        yield { payload: h.__frameQueue.shift() };
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    void h.pumpMux();
  }
  return h.__frameQueue;
}

export async function feedFrames(h, frames, waitMs = 120) {
  const queue = ensureFrameFeed(h);
  for (const frame of frames) queue.push(frame);
  for (const wake of h.__frameWaiters.splice(0)) wake();
  await new Promise((r) => setTimeout(r, waitMs));
}

/**
 * F-R2 用的**可断**假事件流：`breakStream()` 让当前这一段真的抛错（＝DSH 重启时事件流断开），
 * pumpMux 的 catch/finally 随即执行；3 秒后 pumpMux 自己重连出**新的一段**（segments 递增），
 * 重放帧只能从这一段喂进去 —— 这正是 t20 漏掉的那条路径（断连期间事件流真的断过）。
 */
export function startBreakableMux(h) {
  const state = { queue: [], waiters: [], breakNow: false, segments: 0 };
  h.api.events.mux = async function* () {
    state.segments += 1;
    for (;;) {
      if (state.breakNow) { state.breakNow = false; throw new Error('fixture: DSH 事件流断开（重启中）'); }
      if (state.queue.length === 0) {
        await new Promise((resolve) => state.waiters.push(resolve));
        continue;   // 回到循环顶部重新判 breakNow：断流请求不能卡在等待里
      }
      yield { payload: state.queue.shift() };
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  void h.pumpMux();
  return {
    push(frames) {
      for (const frame of frames) state.queue.push(frame);
      for (const wake of state.waiters.splice(0)) wake();
    },
    breakStream() {
      state.breakNow = true;
      for (const wake of state.waiters.splice(0)) wake();
    },
    segments: () => state.segments,
  };
}

export function postJson(server, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const request = http.request({
      host: '127.0.0.1', port: server.address().port, path: `${pathname}?token=${CONSOLE_TOKEN}`, method: 'POST',
      // agent:false + Connection: close：不要留下 keep-alive 空闲 socket。否则测试跑完后
      // Node 的全局 agent 会抱着它的 socket 直到超时，进程迟迟不退出（实测会把 29s 的用例
      // 拖成 88s 的墙钟时间，撞上 test-audit 的每脚本超时）。
      agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), connection: 'close' },
    }, (response) => {
      let data = '';
      response.on('data', (c) => { data += c; });
      response.on('end', () => resolve({ status: response.statusCode, body: data }));
    });
    request.on('error', reject);
    request.setTimeout(4000, () => request.destroy(new Error('request hung')));
    request.end(payload);
  });
}

export const count = (text, re) => (String(text).match(re) ?? []).length;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 轮询等待某个条件成立（日志行 / 投递计数），比死等固定时长稳。 */
export const waitFor = async (fn, timeoutMs = 5000, stepMs = 50) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(stepMs);
  }
};
/** DSH 帧构造器（与 createTurnCollector 认的形状一致）。 */
export const frameOf = (sid, event) => ({ type: 'session/event', sessionId: sid, event });
/** 一个正常收尾的回合：turn/start → assistant/message → turn/end。 */
export const completedTurn = (sid, turn, text) => [
  frameOf(sid, { type: 'turn/start', data: { turn } }),
  frameOf(sid, { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } }),
  frameOf(sid, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }),
];

let failures = 0;
let caseMsTotal = 0;
let closeMsTotal = 0;
export async function test(name, config, run) {
  let h;
  const t0 = Date.now();
  try {
    h = await busyHarness({ config });
    await run(h);
    caseMsTotal += Date.now() - t0;
    console.log(`✅ ${name}（${Date.now() - t0}ms）`);
  } catch (error) {
    failures += 1;
    caseMsTotal += Date.now() - t0;
    console.error(`❌ ${name}（${Date.now() - t0}ms）\n   ${error?.stack ?? error?.message ?? error}`);
  } finally {
    if (h) {
      const tc = Date.now();
      await h.close();
      closeMsTotal += Date.now() - tc;
    }
  }
}

/**
 * 统一收尾（两个脚本共用）：打印各自的汇总行并显式退出。
 * 显式退出的原因（原注保留）：本套 harness 会起若干临时 HTTP 服务，测试侧偶发残留一个空闲
 * socket 句柄会把事件循环多吊住 ~60s（实测 29s → 88s），撞上 test-audit 的每脚本超时。
 * 断言已全部跑完，这里直接给出退出码。
 */
export function finish({ title = '卡忙自愈看门狗聚焦测试', failTitle = '卡忙看门狗测试' } = {}) {
  if (failures) {
    console.error(`\n❌ ${failTitle}失败 ${failures} 项`);
    process.exit(1);
  }
  console.log(`\n🎉 ${title}通过（用例 ${(caseMsTotal / 1000).toFixed(1)}s + close ${(closeMsTotal / 1000).toFixed(1)}s，`
    + `进程 uptime ${process.uptime().toFixed(1)}s）`);
  process.exit(failures === 0 ? 0 : 1);
}

/** 本文件导出的全部共享件（两个用例文件按需 import；见 scripts/test-busy-watchdog.mjs 头部说明）。 */
export const SHARED = {
  busyHarness, test, finish, SCALED, withWatchdog, root, CONSOLE_TOKEN,
  stuckByPendingWake, seedStaleCollector, ensureFrameFeed, feedFrames, startBreakableMux,
  postJson, count, sleep, waitFor, frameOf, completedTurn,
};
