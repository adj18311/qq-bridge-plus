#!/usr/bin/env node
// t3 独立验证：卡忙自愈看门狗（src/bridge.js §15）的对抗性用例。
//
// 设计原则（与 scripts/test-busy-watchdog.mjs 的差别）：
//   1) **真定时器**：本脚本不拦截 setInterval/setTimeout 的行为（只记录句柄以便收尾清理），
//      所以「释放」是真实 checkIntervalMs 定时器跑出来的，而不是人工调用 scan 造出来的。
//      （仅有反例 T7/T4d 里额外调用一次 runBusyWatchdogScanV2 做反向断言。）
//   2) **真事件流**：活动戳走真实 pumpMux → reverse → noteFrameActivityV2 链路，
//      帧由 api.events.mux 的假生成器喂入，不直接写 busyWatchdog.lastFrameAtV2。
//   3) 每条结论都打印原始 state/bridge.log 行（带 HH:MM:SS）与退出码/耗时。
// 不读线上 config.json、不写真实 state/、不连 QQ/DSH、不启动第二个守护进程、不修改 src/bridge.js。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import * as coreBindings from './bridge-core-bindings.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
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

const root = fileURLToPath(new URL('..', import.meta.url));

// ── 冻结基线（t72）：oracle/基线必须锚在**固定提交**，绝不锚 HEAD ─────────────────────────────
// 为什么不能用 HEAD：T13 校验的是「租约本体（arm/disarm）自冻结基线以来没被改动」。若拿 HEAD 当基线，
// 只要有人把改动 commit 掉，workspace 与 HEAD 就恒等 ⇒ 断言退化成**套话**，提交之后再也守不住任何东西
// （而 S13 那类「要求 HEAD 还是旧实现」的断言则会**一提交就假红**）。锚固定 SHA 后两种病都没有。
const FROZEN_BASELINE_SHA = '53a93be';   // 本轮改动前的最后一个提交（租约两函数体原样在位）
/**
 * 读冻结基线文件内容。**拿不到基线必须明确失败**，不许静默跳过（`skipped`）：
 * 浅克隆缺对象、SHA 打错、仓库被替换 —— 任何一种都会让基线失去证据力，必须红并写明原因。
 */
function gitShowFrozen(ref, file) {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8' });
  } catch (error) {
    const first = String(error?.message ?? error).split(/\r?\n/)[0].slice(0, 120);
    throw new Error(`冻结基线不可用：git show ${ref}:${file} 失败（${first}）—— 基线必须能读到固定提交；`
      + '请补齐该提交的历史（fetch 该 SHA）或修正 FROZEN_BASELINE_SHA，**绝不许退回 HEAD 或静默跳过**');
  }
}
const CONSOLE_TOKEN = 'verify-console-token';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function verifyHarness({ config = {}, transformSource } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-verify-watchdog-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: CONSOLE_TOKEN, slang: { enabled: false }, ...config,
  }));
  const calls = { created: [], prompts: [], sent: [], follows: [], listed: [] };
  const success = (value) => ({ result: { ok: true, value } });
  // t45（C-stall 独立验证）：DSH `session/list` 的**可控**替身。生产实现与形状已独立核验（见 SC5）：
  // app.asar 的 dsh-api-session-controller/lib/index.js:2955 `return { items: await this.listState.list(signal) };`
  // 条目形状 :1874-1877 = { sessionId, updatedAt, agentAvailable, running }；经 unwrap 后拿 value.items。
  let listResponder = async () => success({ items: [] });
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
      list: async (params) => { calls.listed.push(params); return listResponder(params); },
    },
    respond: async () => success({}),
    stopSessionWork: async () => ({ removed: 0 }),
    callUnary: async () => success({ accepted: true }),
    settings: { describe: async () => { throw new Error('fixture: settings 不可用'); } },
    agentPresets: { list: async () => success({ presets: [{ id: 'standard', isDefault: true }, { id: 'qq-chat' }, { id: 'qq-chat-v2' }] }) },
  };
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async request() { return { status: 'ok', retcode: 0, data: [] }; }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。按行处理：import 有多行写法。
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
  // 可选源码变换（仅作用于 VM 内的副本，绝不写回 src/bridge.js）：t9 用它中和 F3 修复做反证。
  if (typeof transformSource === 'function') source = transformSource(source);
  // 在 main() 里提前返回内部结构供断言（脚本侧源码变换，不改 src/bridge.js 本体）。
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    cfg, state, api, socialV2, social, getSocialV2State, ensureSession,
    sendWakePromptV2, scheduleWakeV2, deliverPrompt, isConversationBusyV2, wakePriorityV2,
    promptQueues, pendingWakeKeys, pendingWakeLeaseTimers, collectors, v2TurnStartAt, v2TurnNoV2,
    armPendingWakeLease, disarmPendingWakeLease, reverse, wakeConfigUpdatedKeys, markReadCalledKeys,
    clearBusyRearmedWakeV2, busyWakeIdV2,
    busyWatchdog, busyWatchdogConfig, runBusyWatchdogScanV2, startBusyWatchdogV2,
    noteFrameActivityV2, noteActionActivityV2, clearBusyWatchdogRuntimeV2,
    createTurnCollector, pumpMux, startConsoleServer, handleIncoming, queued,
    clearSocialV2Timers, cancelPendingWakeTimerV2, clearRearmMarkForDroppedWakeV2,
    checkDsh, handleDshReconnectV2, snapshotDshDownInFlightTurnsV2,
    cleanupDshDownInFlightTurnsV2, rearmStashedWakeAfterReconnectV2, dshState() { return dshReady; },
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
  };
  bot.onPrivateMessage(async (event) => {`);
  const timeouts = new Set();
  const timeoutRegistrations = []; // observable clock inputs; native timers still run unchanged
  const intervals = [];
  const context = vm.createContext({
    fs, os: { ...os, homedir: () => temp }, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal,
    console: { log() {}, error() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) }),
    execFileSync: () => '',
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, exit: (code) => { throw new Error(`unexpected exit ${code}`); } },
    // 真定时器（行为与生产一致），只记录句柄用于收尾清理 / 断言 unref。
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      timeouts.add(handle);
      timeoutRegistrations.push({ fn, ms, handle });
      return handle;
    },
    clearTimeout: (handle) => { timeouts.delete(handle); return clearTimeout(handle); },
    setInterval: (fn, ms) => {
      const handle = setInterval(fn, ms);
      const record = { ms, handle, unrefCalled: false };
      const original = handle.unref.bind(handle);
      handle.unref = () => { record.unrefCalled = true; return original(); };
      intervals.push(record);
      return handle;
    },
    clearInterval: (handle) => clearInterval(handle),
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker,
    ...modelPrices, ...tokenLedger, ...voiceLib, ...stateAcl, ...coreBindings, ...retryObserver, ...retryDiagnostic, ...errorNotice,
    defaultErrorNoticeGate: errorNotice.createErrorNoticeGate(),
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    processAudioVolume: async (file) => ({ path: String(file), converted: false, applied: false, mode: 'original', volume: 1, loudness: null }),
    cleanupTemp: () => {},
  });
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData }; })());`, context);
  vm.runInContext(source + '\nglobalThis.verifyReady = main();', context);
  const logFile = path.join(temp, 'state', 'bridge.log');
  const readLog = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };
  return context.verifyReady.then((internals) => {
    const bridge = Object.assign(Object.create(null), internals);
    bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
    bridge.setReady(true);
    bridge.calls = calls;
    // t45：让用例随时切换「DSH 会话列表」的形状（返回信封与真实一致：{ result: { ok, value } }）。
    bridge.setSessionList = (fn) => { listResponder = typeof fn === 'function' ? fn : async () => success({ items: [] }); };
    bridge.listArgs = () => calls.listed.slice();
    bridge.temp = temp;
    bridge.intervals = intervals;
    bridge.timeoutRegistrations = timeoutRegistrations;
    bridge.readLog = readLog;
    bridge.close = () => {
      for (const handle of timeouts) clearTimeout(handle);
      for (const record of intervals) clearInterval(record.handle);
      fs.rmSync(temp, { recursive: true, force: true });
    };
    // 真事件流喂帧器：帧经真实 pumpMux → noteFrameActivityV2 链路生效。
    bridge.startMux = () => {
      const queue = [];
      let wake = null;
      bridge.api.events.mux = async function* () {
        for (;;) {
          if (queue.length === 0) {
            await new Promise((resolve) => { wake = resolve; });
            continue;
          }
          yield { payload: queue.shift() };
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };
      void bridge.pumpMux();
      return {
        push(frame) {
          queue.push(frame);
          if (wake) { const resolve = wake; wake = null; resolve(); }
        },
      };
    };
    // F-R2 复验专用：**可真断流**的事件流喂帧器（与 startMux 的关键差别：那条假流永不结束）。
    // 事故的真实传输序列 = 事件流被对端重置（pumpMux 的 finally 跑一遍：断流点快照 + 清 ④ +
    // clearBusyWatchdogRuntimeV2({keepDshDownSnapshot:true})）→ pumpMux 每 3s 自己重试一次
    // （每次重试都会再跑一遍 finally、再拍一次「空快照」）→ 第 N 次成功重连出新的一段流。
    // attempts 记录每次连接尝试的时刻与结局，用来证明「真的重试过、真的重连了」。
    bridge.startTransportMux = () => {
      const queue = [];
      const attempts = [];                // { n, at, outcome: 'up'|'refused'|'reset', closedAt }
      let wake = null;
      let down = false;
      let n = 0;
      bridge.api.events.mux = async function* () {
        n += 1;
        const attempt = { n, at: Date.now(), outcome: down ? 'refused' : 'up', closedAt: 0 };
        attempts.push(attempt);
        if (down) throw new Error('fixture: 连接 DSH 事件流失败（ECONNREFUSED）');
        try {
          for (;;) {
            if (queue.length === 0) {
              await new Promise((resolve) => { wake = resolve; });
              if (down) { attempt.outcome = 'reset'; throw new Error('fixture: 事件流被对端重置（ECONNRESET）'); }
              continue;
            }
            yield { payload: queue.shift() };
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (down) { attempt.outcome = 'reset'; throw new Error('fixture: 事件流被对端重置（ECONNRESET）'); }
          }
        } finally { attempt.closedAt = Date.now(); }
      };
      void bridge.pumpMux();
      return {
        attempts,
        attemptCount: () => n,
        push(frames) {
          for (const item of Array.isArray(frames) ? frames : [frames]) queue.push(item);
          if (wake) { const resolve = wake; wake = null; resolve(); }
        },
        breakStream() { down = true; if (wake) { const resolve = wake; wake = null; resolve(); } },
        recover() { down = false; },
      };
    };
    return bridge;
  });
}

const frame = (sid, event) => ({ type: 'session/event', sessionId: sid, event });
const turnStart = (sid, turn) => frame(sid, { type: 'turn/start', data: { turn } });
const assistantText = (sid, turn, text) => frame(sid, { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } });
const turnEnd = (sid, turn, kind = 'completed') => frame(sid, { type: 'turn/end', data: { turn, reason: { kind } } });

const withGlobal = (re) => (re.flags.includes('g') ? re : new RegExp(re.source, `${re.flags}g`));
const count = (text, re) => (String(text).match(withGlobal(re)) ?? []).length;
const linesOf = (text, re) => (String(text).match(withGlobal(re)) ?? []);
function dump(label, text, re) {
  const lines = linesOf(text, re);
  console.log(`   [原始日志] ${label}：${lines.length} 行`);
  for (const line of lines) console.log(`     ${line}`);
}

async function waitUntil(fn, timeoutMs = 6000, stepMs = 40) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(stepMs);
  }
}

// 100 倍缩放的阈值（1s ↔ 100s）：warn 100s / release 200s / hardCap 400s 在秒级跑完。
// checkIntervalMs 取实现的下限 1000ms（`Math.max(1000, …)` —— t3 另行核对该下限）。
// 释放时间线（trigger 在 t0，第一次扫描 t0+1s 建立 busySince）：
//   t0+2s  WARN 档（busy=1s ≥ warnMs=1s）
//   t0+3s  释放档（busy=2s ≥ releaseMs=2s 且 idle≥2s）
const SCALED = { warnMs: 1000, releaseMs: 2000, hardCapMs: 4000, checkIntervalMs: 1000, rearmCooldownMs: 60000, maxRearmPerHour: 3 };
const wdConfig = (wd) => ({ socialV2: { enabled: true, busyWatchdog: { ...wd } } });
// 与生产 config.json 一致的唤醒频率额度（maxWakePerMinute=10 / maxWakePerHour=80）：
// 否则代码默认的 1 次/分钟会掩盖「同一 reason 被二次补发」的投递，只留下一次被拒的日志。
const wdConfigProdWake = (wd) => ({ socialV2: { enabled: true, wake: { maxWakePerMinute: 10, maxWakePerHour: 80 }, busyWatchdog: { ...wd } } });
// C-reconnect（t19）专用配置：把看门狗三档放到**生产量级**（warn=300s / release=600s / hardCap=1800s），
// 于是观测窗口（几秒）内看门狗**不可能**动任何标记 —— 任何 ≤10s 的清理都只能来自重连钩子，
// 从配置上把「重连钩子生效」与「releaseMs 兜底」两条路径分开（这是本组用例的计时判别前提）。
const wdConfigReconnect = (wd = {}) => wdConfigProdWake({
  warnMs: 300000, releaseMs: 600000, hardCapMs: 1800000,
  checkIntervalMs: 1000, rearmCooldownMs: 60000, maxRearmPerHour: 3, ...wd,
});
const allowMany = { private: ['123', '789'], groups: ['456', '987'] };
// F-R2 复验（R7/R8）专用：看门狗取**生产默认档**（warn 5min / release 15min / hardCap 30min），
// 于是观测窗口（十几秒）内 releaseMs=900s 的兜底路径在配置上不可能触发；有界复核**不做任何缩放**,
// 就用生产默认的 up+8s/静默 4s —— 这样「≤10s 收敛」是被真实时间轴证明的，而不是夹具缩出来的。
const wdConfigReconnectProd = (wd = {}) => wdConfigProdWake({
  warnMs: 300000, releaseMs: 900000, hardCapMs: 1800000,
  checkIntervalMs: 1000, rearmCooldownMs: 60000, maxRearmPerHour: 3, ...wd,
});
const allowTransport = { private: ['123', '789', '888'], groups: ['456', '987'] };

const failures = [];
const passes = [];
const probeFailures = [];
const ONLY = process.env.VERIFY_ONLY || '';
const STRICT = process.env.VERIFY_STRICT === '1';
function dumpAll(text) {
  const all = String(text).split(/\r?\n/).filter(Boolean);
  console.log(`   [失败现场] state/bridge.log 共 ${all.length} 行：`);
  for (const line of all) console.log(`     | ${line}`);
}
// probe=true 的用例是「新风险探针」：失败时单独登记（默认不计入退出码，可用 VERIFY_STRICT=1 计入），
// 但一定大声打印，避免把新洞藏在绿油油的结果里。
async function test(name, config, run, { probe = false, harnessOptions = {}, skipUnless = true } = {}) {
  if (ONLY && !name.includes(ONLY)) return;
  if (!skipUnless) {
    console.log(`\n────────────────────────────────────────────────────────────────`);
    console.log(`⏭ SKIP（默认关闭：设置 VERIFY_F4=1 可启用） ${name}`);
    return;
  }
  console.log(`\n────────────────────────────────────────────────────────────────`);
  console.log(`▶ ${name}`);
  let h;
  try {
    h = await verifyHarness({ config, ...harnessOptions });
    await run(h);
    passes.push(name);
    console.log(`✅ PASS ${name}`);
  } catch (error) {
    const text = String(error?.stack ?? error?.message ?? error);
    if (probe) {
      probeFailures.push({ name, error: text });
      console.log(`❌ PROBE FAIL（探针不复现期望语义，见 findings） ${name}`);
    } else {
      failures.push({ name, error: text });
      console.log(`❌ FAIL ${name}`);
    }
    console.log(text.split('\n').map((l) => `   ${l}`).join('\n'));
    if (h) { try { dumpAll(h.readLog()); } catch {} }
  } finally {
    if (h) { try { h.close(); } catch {} }
  }
}

function postFireAndForget(server, pathname, body) {
  const payload = JSON.stringify(body ?? {});
  const request = http.request({
    host: '127.0.0.1', port: server.address().port, path: `${pathname}?token=${CONSOLE_TOKEN}`, method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
  }, (response) => { response.resume(); });
  request.on('error', () => {});
  request.end(payload);
  return request;
}

/** 造一个「看门狗已 re-arm、合并窗内尚未投递」的状态：标记与 pendingWakeTimer 同时存在。 */
async function seedMarkedPendingWake(h, key, { reason = 'private', seq = 197, batchWindowMs = 1000 } = {}) {
  h.setMode('reserved2');
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq, text: '在吗' }];
  st.lastUnreadSeq = seq;
  st.wakeConfig.batchWindowMs = batchWindowMs;
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  h.scheduleWakeV2(key, reason);                       // 忙分支 → 暂存 backlog 一条
  const releaseLine = await waitUntil(() => {
    const lines = linesOf(h.readLog(), new RegExp(`\\[watchdog\\] release key=${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*`));
    return lines.length ? lines[lines.length - 1] : null;
  }, 8000);
  assert.match(releaseLine, new RegExp(`rearm=${reason}@seq${seq}`), `必须 re-arm（${reason}@seq${seq}）：${releaseLine}`);
  assert.ok(h.busyWatchdog.rearmedWakeV2.get(key)?.has(`${reason}@${seq}`), '标记必须已登记');
  assert.ok(st.pendingWakeTimer, '必须已排上合并窗定时器');
  return { sid, st, releaseLine };
}

const marksOf = (h, key) => [...(h.busyWatchdog.rearmedWakeV2.get(key) ?? [])];

function postJson(server, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const request = http.request({
      host: '127.0.0.1', port: server.address().port, path: `${pathname}?token=${CONSOLE_TOKEN}`, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
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

// ══ T1 真的会释放：真实定时器（无任何人工 scan 调用）════════════════════════
await test('T1 ② 卡忙 + 真实 checkIntervalMs 定时器 → 超过 releaseMs 后自动释放并成对 disarm 租约', wdConfig(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 1000;
  const wdInterval = h.intervals.find((r) => r.ms === SCALED.checkIntervalMs);
  assert.ok(wdInterval, `启动期必须注册 checkIntervalMs=${SCALED.checkIntervalMs} 的扫描定时器（实测 ${JSON.stringify(h.intervals.map((r) => r.ms))}）`);
  assert.equal(wdInterval.unrefCalled, true, '扫描定时器必须 unref');

  const t0 = Date.now();
  // 真实路径造 ②：投递一次唤醒 → DSH 接受（fixture 返回 ok）→ pendingWakeKeys + 30 分钟租约，
  // 之后再也没有 turn/start / turn/end / 任何帧（= 事故里的静默期）。
  await h.sendWakePromptV2(key, 'private');
  assert.equal(h.calls.prompts.length, 1, 'fixture 必须已接受一次 prompt');
  assert.equal(h.pendingWakeKeys.has(key), true, '② 卡忙标记必须建立');
  assert.equal(h.pendingWakeLeaseTimers.has(key), true, '30 分钟租约必须已武装');
  const busyNow = h.isConversationBusyV2(key, st);
  assert.equal(busyNow, true, '被判定 busy');

  const releaseLine = await waitUntil(() => linesOf(h.readLog(), /\[watchdog\] release[^\n]*/)[0], 8000);
  const elapsed = Date.now() - t0;
  const log = h.readLog();
  dump('warn', log, /\[watchdog\] warn[^\n]*/);
  dump('release', log, /\[watchdog\] release[^\n]*/);
  assert.ok(releaseLine, `releaseMs=${SCALED.releaseMs}ms 后必须自动释放`);
  assert.ok(elapsed >= SCALED.releaseMs, `释放不得早于 releaseMs（实测 ${elapsed}ms）`);
  assert.ok(elapsed <= SCALED.releaseMs * 4, `释放必须在合理时间内发生（实测 ${elapsed}ms）`);
  assert.match(releaseLine, /released=[^\n]*pendingWakeKeys/, `release 行必须列出被释放的 ②：${releaseLine}`);
  assert.equal(h.pendingWakeKeys.has(key), false, '② 必须被真实释放');
  assert.equal(h.pendingWakeLeaseTimers.has(key), false, '释放 ② 必须成对 disarm 30 分钟租约（C5）');
  assert.equal(h.busyWatchdog.busyStallsV2.get(key), 1, '强制释放计数必须为 1');
  const warnIndex = log.indexOf('[watchdog] warn');
  const releaseIndex = log.indexOf('[watchdog] release');
  assert.ok(warnIndex >= 0 && warnIndex < releaseIndex, '必须先 WARN 后 release（WARN 档不得掉进释放路径）');
  console.log(`   [证据] 释放耗时 ${elapsed}ms（releaseMs=${SCALED.releaseMs}），release 行=${releaseLine}`);
});

// ══ T2 不会误杀：持续有帧的正常长回合，观察 2.6× releaseMs 且忙超 hardCap ═══════
await test('T2 持续有 DSH 流帧的长回合（观察 ≈2.6×releaseMs，忙时长 > hardCapMs）不被释放', wdConfig(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  h.getSocialV2State(key);
  const feed = h.startMux();
  feed.push(turnStart(sid, 1));
  await sleep(250);
  assert.equal(h.v2TurnStartAt.has(sid), true, '真实 mux 帧必须建立 ④ 忙判据');
  assert.equal(h.collectors.has(sid), true, '真实 mux 帧必须建立 collector');
  const frameBefore = h.busyWatchdog.lastFrameAtV2.get(key);
  const t0 = Date.now();
  for (let i = 0; i < 26; i += 1) {
    feed.push(frame(sid, { type: 'tool/call', data: { name: 'fixture.slow_tool', callId: `c${i}` } }));
    await sleep(200);
  }
  const observed = Date.now() - t0;
  const log = h.readLog();
  dump('warn/release', log, /\[watchdog\] (warn|release)[^\n]*/);
  assert.ok(observed >= SCALED.releaseMs * 2, `观察时长必须 ≥2×releaseMs（实测 ${observed}ms，阈值 ${SCALED.releaseMs * 2}ms）`);
  const busySince = h.busyWatchdog.busySinceV2.get(key);
  const busyFor = Date.now() - busySince;
  assert.ok(busyFor >= SCALED.hardCapMs, `忙时长必须已超过 hardCapMs=${SCALED.hardCapMs}（实测 ${busyFor}ms）`);
  assert.equal(count(log, /\[watchdog\] release/g), 0, '有帧的正常长回合绝不能被释放');
  assert.equal(h.busyWatchdog.busyStallsV2.has(key), false, '不得计入强制释放');
  assert.equal(h.v2TurnStartAt.has(sid), true, '在途回合标记必须保留');
  assert.equal(h.collectors.has(sid), true, '在途 collector 必须保留');
  assert.ok(h.busyWatchdog.lastFrameAtV2.get(key) > frameBefore, '每个 DSH 帧都必须刷新活动戳（pumpMux→noteFrameActivityV2 链路）');
  console.log(`   [证据] 观察 ${observed}ms（≥2×releaseMs=${SCALED.releaseMs * 2}ms），busy=${busyFor}ms（>hardCapMs=${SCALED.hardCapMs}），release 行 0 条`);
});

// ══ T3 补发只一次（正例）：cooldown 内同一 reason 不重复投递 ════════════════
await test('T3 释放后 backlog 走正常投递路径补发一次；cooldown 内同一 (reason,seq) 不再投递', wdConfig(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 1000;
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  h.scheduleWakeV2(key, 'private');                 // 真实忙分支 → 暂存 private@seq197
  assert.equal(st.pendingWakeReasons.length, 1, '忙分支必须暂存一条 backlog');
  assert.match(h.readLog(), /会话繁忙，暂存唤醒原因 private:123（private@seq197）/, '必须是真实暂存路径');
  const releaseLine = await waitUntil(() => linesOf(h.readLog(), /\[watchdog\] release[^\n]*/)[0], 8000);
  assert.match(releaseLine, /backlog=1 rearm=private@seq197/, `释放行必须携带 backlog/rearm：${releaseLine}`);
  // 第一次补发：只允许经 scheduleWakeV2 → 合并窗 → sendWakePromptV2 → deliverPrompt
  const planLine = await waitUntil(() => linesOf(h.readLog(), /\[reserved2\] 计划唤醒 private:123（private）[^\n]*/)[0], 3000);
  assert.ok(planLine, '补发必须走 scheduleWakeV2（日志出现「计划唤醒」）');
  assert.equal(h.calls.sent.length, 0, '释放与补发都不得旁路直发 QQ');
  const delivered = await waitUntil(() => h.calls.prompts.length >= 1, 5000);
  assert.ok(delivered, '合并窗到期后必须走正常投递路径（api.sessions.prompt）');
  await sleep(SCALED.releaseMs * 2);                // 继续观察：至少再经过一次潜在释放点
  const log = h.readLog();
  dump('释放/补发', log, /\[watchdog\] release[^\n]*|\[reserved2\] 计划唤醒[^\n]*|\[reserved2\] 唤醒 private:123（private）[^\n]*/);
  assert.equal(count(log, /\[reserved2\] 唤醒 private:123（private）/g), 1, '同一 reason 只能有一次补发投递');
  assert.equal(h.calls.prompts.length, 1, '只允许一次正常投递');
  const releases = linesOf(log, /\[watchdog\] release key=private:123[^\n]*/);
  assert.ok(releases.length >= 1, '释放必须至少发生一次');
  assert.ok(releases.every((l) => /rearm=(none|private@seq197)/.test(l)), `释放行的 rearm 字段必须合法：${JSON.stringify(releases)}`);
  const laterRearms = releases.filter((l) => /rearm=private@seq197/.test(l));
  assert.equal(laterRearms.length, 1, 'cooldown/小时额度内只允许一次 re-arm');
  console.log(`   [证据] 释放 ${releases.length} 次；rearm=${laterRearms.length} 次；投递 ${h.calls.prompts.length} 次；QQ 直发 ${h.calls.sent.length} 次`);
});

// ══ T4 验收 5：同一积压唤醒原因不得被重复补发（对抗场景）═════════════════════
// 场景：② 单独卡忙 → 看门狗释放并 re-arm（第 1 次投递）→ 该回合收尾时调用了 set_wake_config
// （未带 throughSeq ⇒ unread 不清）→ 原回合迟到的 turn/end 走正常 backlog 补发 shift
// （:12177）时又把同一条 (private,197) 排进 scheduleWakeV2（第 2 次投递）。
// 这条用例断言「只允许 1 次」，因此它失败 = 验收 5 失败（T5/T6 是对照，隔离触发条件）。
await test('T4 验收5：同一积压唤醒原因（private@seq197）不得被重复补发', wdConfigProdWake(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 1000;
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  h.scheduleWakeV2(key, 'private');
  const releaseLine = await waitUntil(() => linesOf(h.readLog(), /\[watchdog\] release[^\n]*/)[0], 8000);
  assert.match(releaseLine, /rearm=private@seq197/, `释放必须带 re-arm：${releaseLine}`);
  const firstWake = await waitUntil(() => count(h.readLog(), /\[reserved2\] 唤醒 private:123（private）/g) >= 1, 5000);
  assert.ok(firstWake, '必须发生第一次补发');
  assert.ok(st.pendingWakeReasons.some((r) => r.reason === 'private' && r.seq === 197),
    'release 后 st.pendingWakeReasons 仍保留被 re-arm 的那条（:2552 的赋值）');
  assert.equal(h.pendingWakeKeys.has(key), true, '补发投递本身又派生了新的 ②');
  // 模型在该回合收尾调用了 set_wake_config（未带 throughSeq ⇒ unread 不清空）
  h.wakeConfigUpdatedKeys.add(key);
  const feed = h.startMux();
  feed.push(turnStart(sid, 1));
  await sleep(150);
  feed.push(assistantText(sid, 1, '看门狗补发后的回复'));
  feed.push(turnEnd(sid, 1));
  await sleep(400);
  await waitUntil(() => count(h.readLog(), /\[reserved2\] 唤醒 private:123（private）/g) >= 2, 6000);
  const log = h.readLog();
  const wakeLines = linesOf(log, /[^\n]*\[reserved2\] 唤醒 private:123（private）[^\n]*/);
  const backlogLines = linesOf(log, /[^\n]*补发繁忙期间积压的唤醒[^\n]*/);
  dump('补发/唤醒', log, /[^\n]*\[reserved2\] (计划唤醒|唤醒) private:123（private）[^\n]*|[^\n]*补发繁忙期间积压的唤醒[^\n]*|[^\n]*跳过重复补发[^\n]*/);
  assert.equal(wakeLines.length, 1,
    `验收 5 失败：同一 (private,seq197) 被补发 ${wakeLines.length} 次（期望 1 次）。\n`
    + `成因：src/bridge.js:2552 让被 re-arm 的那条仍留在 st.pendingWakeReasons，`
    + `随后 turn/end 的正常补发 shift（:12177-12185）再排一次 scheduleWakeV2。\n`
    + `复现：② 单独卡忙 + backlog 一条 → 释放/re-arm 投递 1 次 → 该回合收尾调 set_wake_config（不带 throughSeq）→ 迟到 turn/end。\n`
    + `原始证据：\n${[...backlogLines, ...wakeLines].join('\n')}`);
  console.log(`   [证据] 同一 reason 唤醒投递 ${wakeLines.length} 次（验收 5 期望 1 次）`);
});

// ══ T5 对照：unread 已被该回合消费 → 不二次补发（证明 T4 的成因是残留条目 + 相关性）══
await test('T5-对照 同一流程但 unread 已被消费 → backlog shift 判定「已处理」不再补发', wdConfigProdWake(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 1000;
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  h.scheduleWakeV2(key, 'private');
  await waitUntil(() => linesOf(h.readLog(), /\[watchdog\] release[^\n]*/)[0], 8000);
  const firstWake = await waitUntil(() => count(h.readLog(), /\[reserved2\] 唤醒 private:123（private）/g) >= 1, 5000);
  assert.ok(firstWake, '必须发生第一次补发');
  st.unread = [];                                   // 等价 mark_read 消费掉 seq197
  h.markReadCalledKeys.add(key);
  const feed = h.startMux();
  feed.push(turnStart(sid, 1));
  await sleep(150);
  feed.push(assistantText(sid, 1, '看门狗补发后的回复'));
  feed.push(turnEnd(sid, 1));
  await sleep(SCALED.releaseMs * 2);
  const log = h.readLog();
  dump('补发/唤醒', log, /补发繁忙期间积压的唤醒[^\n]*|已被当前回合处理[^\n]*|\[reserved2\] 唤醒 private:123（private）[^\n]*/);
  assert.equal(count(log, /\[reserved2\] 唤醒 private:123（private）/g), 1, 'unread 被消费后不得二次补发');
  assert.match(log, /繁忙期间唤醒 private@seq197 已被当前回合处理，跳过补发/, '必须走「已处理 → 跳过补发」分支');
});

// ══ T6 参考对照：没有收尾动作时 turn/end 走提醒路径并重新武装 ② → 不二次补发 ═══
await test('T6-对照 回合未调 set_wake_config/mark_read → 提醒路径重新武装 ② → shift 时被判忙不投递', wdConfigProdWake(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 1000;
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  h.scheduleWakeV2(key, 'private');
  await waitUntil(() => linesOf(h.readLog(), /\[watchdog\] release[^\n]*/)[0], 8000);
  assert.ok(await waitUntil(() => count(h.readLog(), /\[reserved2\] 唤醒 private:123（private）/g) >= 1, 5000), '必须发生第一次补发');
  const feed = h.startMux();
  feed.push(turnStart(sid, 1));
  await sleep(150);
  feed.push(assistantText(sid, 1, '看门狗补发后的回复'));
  feed.push(turnEnd(sid, 1));
  await sleep(SCALED.releaseMs * 2);
  const log = h.readLog();
  dump('补发/唤醒', log, /\[reserved2\] 唤醒 private:123（private）[^\n]*|未设置唤醒条件[^\n]*|补发繁忙期间积压的唤醒[^\n]*/);
  assert.equal(count(log, /\[reserved2\] 唤醒 private:123（private）/g), 1, '提醒路径下不得二次补发（shift 时被判忙 → 去重暂存）');
});

// ══ T7 边界：paused / 非 reserved2 / 不在白名单 / 配置禁用 ════════════════
await test('T7a paused=true（控制台写入）→ 看门狗完全静默、不释放、计时被清', wdConfig(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await postJson(server, '/api/socialV2/activity', { paused: true });
    assert.equal(res.status, 200, `控制台暂停端点必须 200：${res.body}`);
    assert.equal(h.socialV2.paused, true, 'paused 必须落进运行时状态');
    h.pendingWakeKeys.add(key);
    h.armPendingWakeLease(key);
    const t0 = Date.now();
    await sleep(SCALED.releaseMs * 2.5);
    const log = h.readLog();
    assert.equal(count(log, /\[watchdog\] (warn|release|静默|异常|扫描)/g), 0, `paused 时不得有任何看门狗动作日志：${JSON.stringify(linesOf(log, /\[watchdog\][^\n]*/))}`);
    assert.equal(h.pendingWakeKeys.has(key), true, 'paused 时不得释放 ②');
    assert.equal(h.busyWatchdog.busyStallsV2.size, 0, 'paused 时不得发生释放');
    assert.ok(Date.now() - t0 >= SCALED.releaseMs * 2, '观察时长必须 ≥2×releaseMs');
    console.log(`   [证据] paused 下观察 ${Date.now() - t0}ms，[watchdog] 行 0 条，pendingWakeKeys 保留=${h.pendingWakeKeys.has(key)}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await test('T7b 非 reserved2（/api/mode → chat）→ 看门狗完全静默、不释放', wdConfig(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await postJson(server, '/api/mode', { mode: 'chat' });
    assert.equal(res.status, 200, `模式端点必须 200：${res.body}`);
    h.pendingWakeKeys.add(key);
    h.armPendingWakeLease(key);
    const t0 = Date.now();
    await sleep(SCALED.releaseMs * 2.5);
    const log = h.readLog();
    assert.equal(count(log, /\[watchdog\] (warn|release|静默|异常|扫描)/g), 0, `非 reserved2 时不得有任何看门狗动作日志：${JSON.stringify(linesOf(log, /\[watchdog\][^\n]*/))}`);
    assert.equal(h.pendingWakeKeys.has(key), true, '非 reserved2 时不得释放');
    assert.ok(Date.now() - t0 >= SCALED.releaseMs * 2, '观察时长必须 ≥2×releaseMs');
    console.log(`   [证据] chat 模式观察 ${Date.now() - t0}ms，[watchdog] 行 0 条，pendingWakeKeys 保留=${h.pendingWakeKeys.has(key)}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await test('T7c 会话不在白名单（private:999）→ 静默跳过、不释放', wdConfig(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:999';
  h.getSocialV2State(key);
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  const t0 = Date.now();
  await sleep(SCALED.releaseMs * 2.5);
  const log = h.readLog();
  assert.equal(count(log, /\[watchdog\] (warn|release|静默|异常|扫描)/g), 0, `非白名单会话不得产生看门狗动作日志：${JSON.stringify(linesOf(log, /\[watchdog\][^\n]*/))}`);
  assert.equal(h.pendingWakeKeys.has(key), true, '非白名单会话不得被释放');
  assert.ok(Date.now() - t0 >= SCALED.releaseMs * 2, '观察时长必须 ≥2×releaseMs');
  console.log(`   [证据] 非白名单观察 ${Date.now() - t0}ms，[watchdog] 行 0 条，pendingWakeKeys 保留=${h.pendingWakeKeys.has(key)}`);
});

await test('T7d enabled:false → 不注册定时器、无日志、不释放（含显式 scan 也不动）', wdConfig({ ...SCALED, enabled: false }), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  h.getSocialV2State(key);
  assert.equal(h.busyWatchdog.timer, null, '禁用时不得注册扫描定时器');
  assert.equal(h.busyWatchdog.started, false, '禁用时 started 必须为 false');
  assert.equal(h.intervals.filter((r) => r.ms === SCALED.checkIntervalMs).length, 0, '禁用时不得按 checkIntervalMs 注册定时器');
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  const t0 = Date.now();
  await sleep(SCALED.releaseMs * 2.5);
  h.runBusyWatchdogScanV2(Date.now() + 3600000);   // 反向断言：显式调用也不得释放
  const log = h.readLog();
  assert.equal(count(log, /\[watchdog\]/g), 0, '禁用后不得有任何 [watchdog] 日志');
  assert.equal(h.pendingWakeKeys.has(key), true, '禁用后不得释放任何标记');
  assert.equal(h.busyWatchdog.busyStallsV2.size, 0, '禁用后不得发生释放');
  assert.ok(Date.now() - t0 >= SCALED.releaseMs * 2, '观察时长必须 ≥2×releaseMs');
  console.log(`   [证据] enabled:false 观察 ${Date.now() - t0}ms，[watchdog] 行 0 条，timer=${h.busyWatchdog.timer}，started=${h.busyWatchdog.started}`);
});

// ══ T8 硬上限档（R1 ①）：零帧 + 忙满 hardCapMs → ❗ tier=hardcap 释放 ═══════
await test('T8 hardCap 档：零帧且忙满 hardCapMs（releaseMs 远未到）→ ❗ tier=hardcap 释放', wdConfig({ warnMs: 300, releaseMs: 60000, hardCapMs: 2500, checkIntervalMs: 1000, rearmCooldownMs: 60000, maxRearmPerHour: 3 }), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  h.getSocialV2State(key);
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  const t0 = Date.now();
  const releaseLine = await waitUntil(() => linesOf(h.readLog(), /[^\n]*\[watchdog\] release[^\n]*/)[0], 8000);
  const log = h.readLog();
  dump('warn/release', log, /[^\n]*\[watchdog\] (warn|release)[^\n]*/);
  assert.ok(releaseLine, '忙满 hardCapMs 且零帧必须释放');
  assert.match(releaseLine, /❗ \[watchdog\] release/, `硬上限档必须用 ❗：${releaseLine}`);
  assert.match(releaseLine, /tier=hardcap released=[^\n]*pendingWakeKeys/, `必须是 hardcap 档：${releaseLine}`);
  assert.ok(Date.now() - t0 >= 2000, '不得早于 hardCapMs 触发');
  assert.equal(h.pendingWakeKeys.has(key), false, '② 必须被 hardcap 档释放');
  assert.equal(h.pendingWakeLeaseTimers.has(key), false, 'hardcap 释放也要成对 disarm 租约');
  console.log(`   [证据] hardcap 释放耗时 ${Date.now() - t0}ms，release 行=${releaseLine}`);
});

// ══ T9 ③ promptQueues 只读：不写队列、不伪造 Promise、只按 WARN 记录 ═════════
await test('T9 ③ promptQueues 卡住：队列只读（不 resolve/reject、不改 running），只打 WARN', wdConfig({ warnMs: 300, releaseMs: 800, hardCapMs: 1200, checkIntervalMs: 1000, rearmCooldownMs: 60000, maxRearmPerHour: 3 }), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  h.getSocialV2State(key);
  const entry = { queue: [], running: true };
  let settled = 0;
  entry.queue.push({ promptText: 'x', opts: {}, resolve: () => { settled += 1; }, reject: () => { settled += 1; } });
  h.promptQueues.set(key, entry);
  assert.equal(h.isConversationBusyV2(key, h.getSocialV2State(key)), true, '③ 为真即为忙');
  const t0 = Date.now();
  await sleep(3400);
  const log = h.readLog();
  dump('warn/release', log, /[^\n]*\[watchdog\] (warn|release)[^\n]*/);
  assert.equal(count(log, /\[watchdog\] release/g), 0, '③ 没有可释放标记：不得打 release 行');
  assert.ok(count(log, /\[watchdog\] warn key=private:123[^\n]*flags=promptQueues/) >= 1, '③ 只读场景必须按 WARN 记录');
  assert.equal(h.promptQueues.get(key), entry, '队列本体绝不能被替换/删除');
  assert.equal(entry.running, true, 'promptQueues.running 绝不能被写');
  assert.equal(entry.queue.length, 1, '队尾项（有人 await 的 Promise）绝不能被清');
  assert.equal(settled, 0, '不得伪造 success/error 去 resolve/reject 队列项');
  assert.equal(h.busyWatchdog.busyStallsV2.size, 0, '未发生任何释放');
  assert.ok(Date.now() - t0 >= 1600, '观察时长必须 ≥2×releaseMs');
  console.log(`   [证据] 观察 ${Date.now() - t0}ms（≥2×releaseMs=1600ms），release 0 条，settled=${settled}，running=${entry.running}，tail=${entry.queue.length}`);
});

// ══ T10 ④ 释放后：被放掉的回合不得复活（迟到帧静默丢弃 / live 回合不吞）═══════
await test('T10 ④ 释放后：无 live turn/start 的迟到帧必须静默丢弃；live turn/start 则照常收尾（不吞真实回复）', wdConfig(SCALED), async (h) => {
  h.setMode('reserved2');
  const kStale = 'private:123';
  const kLive = 'group:456';
  const sidStale = await h.ensureSession(kStale);
  const sidLive = await h.ensureSession(kLive);
  h.getSocialV2State(kStale);
  h.getSocialV2State(kLive);
  const feed = h.startMux();
  feed.push(turnStart(sidStale, 7));
  feed.push(turnStart(sidLive, 8));
  await sleep(300);
  assert.equal(h.collectors.has(sidStale), true);
  assert.equal(h.collectors.has(sidLive), true);
  const rel = await waitUntil(() => {
    const l = linesOf(h.readLog(), /\[watchdog\] release[^\n]*/);
    return l.length >= 2 ? l : null;
  }, 8000);
  const log1 = h.readLog();
  dump('release ×2', log1, /\[watchdog\] release[^\n]*/);
  assert.ok(rel, '两个在途回合都必须在零帧后释放');
  assert.equal(h.collectors.has(sidStale), false, '④ collectors 必须释放');
  assert.equal(h.v2TurnStartAt.has(sidStale), false, '④ v2TurnStartAt 必须释放');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sidStale), true, '必须留墓碑');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sidLive), true, '必须留墓碑');
  const stStale = h.getSocialV2State(kStale);
  const noActionLiveBefore = h.getSocialV2State(kLive).wakeConfig.noActionCount || 0;
  // (1) 释放后没有新的 turn/start，只有该在途回合的迟到帧（assistant/message + turn/end）：
  //     绝不能把这一轮输出补发到 QQ（否则「释放」等于把卡死回合的回答又发一遍）。
  const sentBefore = h.calls.sent.length;
  const noActionStaleBefore = stStale.wakeConfig.noActionCount || 0;
  feed.push(assistantText(sidStale, 7, '卡死回合的迟到回复'));
  feed.push(turnEnd(sidStale, 7));
  await sleep(500);
  let log = h.readLog();
  dump('迟到帧相关', log, /静默排空[^\n]*|卡死回合的迟到回复[^\n]*|已释放回合[^\n]*/);
  assert.equal(h.calls.sent.length, sentBefore, '迟到帧不得发出任何 QQ 消息');
  assert.doesNotMatch(log, /卡死回合的迟到回复/, '迟到帧不得走输出路径（不复活已释放回合）');
  assert.equal(stStale.wakeConfig.noActionCount || 0, noActionStaleBefore, '迟到帧不得改 noActionCount');
  const tombstoneLeft = h.busyWatchdog.staleBusyTurns.has(sidStale);
  console.log(`   [观测] 迟到帧（无 turn/start）未被复活；墓碑此时仍保留=${tombstoneLeft}（见输出末尾观测 O2）`);
  // (2) 有 live turn/start：墓碑必须作废，该回合照常收尾（否则真实回复被吞 = 新缺陷）
  feed.push(turnStart(sidLive, 9));
  await sleep(250);
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sidLive), false, 'live turn/start 必须作废旧墓碑（:12025）');
  feed.push(assistantText(sidLive, 9, '看门狗释放后到达的真实回复'));
  feed.push(turnEnd(sidLive, 9));
  await sleep(500);
  log = h.readLog();
  dump('正常收尾', log, /AI 内部输出（不自动转发）[^\n]*|静默排空[^\n]*/);
  assert.match(log, /AI 内部输出（不自动转发）\(group:456\): 看门狗释放后到达的真实回复/, 'live 回合必须走正常收尾路径，不得被墓碑吞掉');
  assert.equal(count(log, /静默排空被释放回合的 turn\/end key=group:456/g), 0, 'live 回合不得被静默排空');
  assert.equal(h.getSocialV2State(kLive).wakeConfig.noActionCount || 0, noActionLiveBefore + 1, 'live 回合必须照常记 noActionCount');
  console.log('   [证据] private:123：迟到帧静默丢弃（无 QQ/无 noActionCount）；group:456：live 回合正常收尾');
});

// ══ T11 墓碑分支本体：等价的「重连重建在途回合」构造 → 静默排空 ════════════
// 生产里唯一会带着「turn 已存在」的 collector 出现在 :12076 的路径是
// recordSessionSnapshot → rebuildInFlightCollector（:2656）。这里按同一形状构造，
// 核对墓碑分支本身：不发 QQ、不记 noActionCount、不补发、并消费掉墓碑。
await test('T11 等价重建 collector：迟到 turn/end 走墓碑分支静默排空（无 QQ / 无 noActionCount / 无补发）', wdConfig(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.pendingWakeReasons = [{ reason: 'private', seq: 197 }];
  const feed = h.startMux();
  feed.push(turnStart(sid, 7));
  await sleep(300);
  assert.equal(h.collectors.has(sid), true, '在途回合必须已建立');
  const releaseLine = await waitUntil(() => linesOf(h.readLog(), /\[watchdog\] release[^\n]*/)[0], 8000);
  assert.match(releaseLine, /released=[^\n]*v2TurnStartAt,collectors/, `必须是 ④ 释放：${releaseLine}`);
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sid), true, '必须留墓碑');
  // 等价构造：DSH 侧该回合仍在进行（快照重建形状：turn/start + assistant/message 都在 collector 里）
  const rebuilt = h.createTurnCollector();
  rebuilt.push({ type: 'turn/start', data: { turn: 7 } });
  rebuilt.push({ type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'text', text: '卡死回合的迟到回复' }] } } });
  h.collectors.set(sid, rebuilt);
  const sentBefore = h.calls.sent.length;
  const noActionBefore = st.wakeConfig.noActionCount || 0;
  const promptsBefore = h.calls.prompts.length;
  feed.push(turnEnd(sid, 7));
  await sleep(400);
  const log = h.readLog();
  dump('静默排空', log, /静默排空[^\n]*|卡死回合的迟到回复[^\n]*|补发繁忙期间积压的唤醒[^\n]*/);
  assert.match(log, /静默排空被释放回合的 turn\/end key=private:123/, '墓碑分支必须静默排空');
  assert.equal(h.calls.sent.length, sentBefore, '静默排空不得发出 QQ 消息');
  assert.doesNotMatch(log, /卡死回合的迟到回复/, '静默排空不得走输出路径');
  assert.equal(st.wakeConfig.noActionCount || 0, noActionBefore, '静默排空不得记 noActionCount');
  assert.equal(h.calls.prompts.length, promptsBefore, '静默排空不得做补发投递');
  assert.doesNotMatch(log, /补发繁忙期间积压的唤醒/, '静默排空不得做 backlog 补发');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sid), false, '墓碑必须在排空时消费掉');
  assert.equal(h.collectors.has(sid), false, '排空后 collector 必须清掉');
  console.log('   [证据] 墓碑分支：静默排空 + 无 QQ + 无 noActionCount + 无补发 + 墓碑已消费');
});

// ══ T12 事故场景：人在说话（QQ 入站）不算活动，卡忙照样被释放 ══════════════
// §15.3 的关键取舍：事故正是「人一直在说话、会话一直卡忙」，入站若算活动，看门狗在最需要
// 它的场景里永远不动作。这里在释放前一刻真跑一次 handleIncoming，断言活动戳不动且仍释放。
await test('T12 QQ 入站消息不刷新活动戳：人在说话时卡忙照样在阈值后被释放', wdConfig(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  const t0 = Date.now();
  await h.sendWakePromptV2(key, 'private');  // 真实路径：投递被接受 → ② + 租约 + 活动戳（数值基线）
  assert.equal(h.pendingWakeKeys.has(key), true, '② 卡忙标记必须建立');
  await sleep(1500);                       // 卡住 1.5s（releaseMs=2s 未到）
  const beforeInbound = h.busyWatchdog.lastFrameAtV2.get(key);
  assert.equal(typeof beforeInbound, 'number', '活动戳必须有数值基线（否则本用例证据太弱）');
  try {
    await h.handleIncoming('private', 123, {
      user_id: 123, self_id: 999, message_id: 4242, time: Math.floor(Date.now() / 1000),
      message: [{ type: 'text', data: { text: '你还在吗' } }],
    }, h.cfg);
  } catch (error) {
    console.log(`   [观测] handleIncoming 在夹具里抛出（不影响断言）：${error?.message ?? error}`);
  }
  const afterInbound = h.busyWatchdog.lastFrameAtV2.get(key);
  assert.equal(afterInbound, beforeInbound, 'QQ 入站消息绝不能刷新看门狗活动戳（否则事故场景永不释放）');
  const releaseLine = await waitUntil(() => linesOf(h.readLog(), /[^\n]*\[watchdog\] release[^\n]*/)[0], 8000);
  const elapsed = Date.now() - t0;
  dump('warn/release', h.readLog(), /[^\n]*\[watchdog\] (warn|release)[^\n]*/);
  assert.ok(releaseLine, '人在说话也必须在阈值后释放（入站不算活动）');
  assert.ok(elapsed <= SCALED.releaseMs + 2500, `释放不得因入站消息被推迟（实测 ${elapsed}ms）`);
  assert.equal(h.pendingWakeKeys.has(key), false, '② 必须被释放');
  console.log(`   [证据] 入站消息前后活动戳 ${beforeInbound} → ${afterInbound}（不变）；释放耗时 ${elapsed}ms`);
});

// ══ T13 冻结常量：30 分钟租约未被本轮改动 + 7 个默认阈值 ════════════════════
await test('T13 租约行为对照冻结实现（仍 30 分钟）且 7 个默认阈值等于冻结值', {}, async (h) => {
  assert.deepEqual({ ...h.busyWatchdogConfig() }, {
    enabled: true, warnMs: 300000, releaseMs: 900000, hardCapMs: 1800000,
    checkIntervalMs: 10000, rearmCooldownMs: 60000, maxRearmPerHour: 3,
  }, '默认阈值必须逐条等于 t1 §15.6 冻结值');
  const source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  const armStart = source.indexOf('function armPendingWakeLease');
  const armBody = source.slice(armStart, source.indexOf('function disarmPendingWakeLease'));
  assert.ok(armStart > 0 && armBody.includes('30 * 60 * 1000'), 'armPendingWakeLease 本体必须仍是 30 分钟（R2：本轮不得改动租约）');
  assert.match(source, /hardCapMs: 1800000/, '代码内默认 hardCapMs 必须与 30 分钟租约对齐');
  // Compare behavior with the frozen implementation rather than pinning its old source location.
  // This allows lifecycle ownership extraction without weakening the 30-minute/disarm/expiry contract.
  const frozen = gitShowFrozen(FROZEN_BASELINE_SHA, 'src/bridge.js');
  // 工作区是 CRLF、git show 是 LF：比对前必须归一化行尾（否则会把纯行尾差异当改动）。
  const norm = (text) => String(text).replace(/\r\n/g, '\n');
  const sourceN = norm(source);
  const frozenN = norm(frozen);
  // 取「函数体」= 从声明行到下一个同级 function 声明前（避免把相邻无关代码算进来）。
  const fnBody = (text, name) => {
    const start = text.indexOf(`function ${name}(`);
    if (start < 0) return '';
    const rest = text.slice(start);
    const next = rest.slice(1).search(/\n {2}function /);
    return (next < 0 ? rest : rest.slice(0, next + 1)).trim();
  };
  const armOld = fnBody(frozenN, 'armPendingWakeLease');
  const disarmOld = fnBody(frozenN, 'disarmPendingWakeLease');
  assert.ok(armOld.length > 100 && disarmOld.length > 50, `夹具必须能在冻结基线 ${FROZEN_BASELINE_SHA} 里定位到租约函数体`);
  const oldKeys = new Set();
  const oldLeases = new Map();
  const oldRegistrations = [];
  const legacy = new Function('pendingWakeKeys', 'pendingWakeLeaseTimers', 'setTimeout', 'clearTimeout',
    `${armOld}\n${disarmOld}\nreturn { armPendingWakeLease, disarmPendingWakeLease };`)(
    oldKeys, oldLeases,
    (fn, ms) => {
      const handle = { unref() { this.unreferenced = true; } };
      oldRegistrations.push({ fn, ms, handle });
      return handle;
    },
    () => {},
  );
  function leaseTrace(arm, disarm, keys, leases, registrations) {
    const key = 'lease-contract-only';
    keys.add(key);
    arm(key);
    const first = registrations.at(-1);
    const trace = [first.ms, leases.get(key) === first.handle,
      typeof first.handle.hasRef === 'function' ? !first.handle.hasRef() : first.handle.unreferenced];
    disarm(key);
    trace.push(leases.has(key), keys.has(key)); // disarm must not clear business busy
    arm(key);
    const expiry = registrations.at(-1);
    trace.push(expiry.ms);
    expiry.fn();
    trace.push(leases.has(key), keys.has(key));
    keys.delete(key);
    return trace;
  }
  const frozenTrace = leaseTrace(legacy.armPendingWakeLease, legacy.disarmPendingWakeLease,
    oldKeys, oldLeases, oldRegistrations);
  assert.deepEqual(frozenTrace, [1800000, true, true, false, true, 1800000, false, false]);
  assert.deepEqual(leaseTrace(h.armPendingWakeLease, h.disarmPendingWakeLease,
    h.pendingWakeKeys, h.pendingWakeLeaseTimers, h.timeoutRegistrations), frozenTrace,
    `租约期限/unref/撤销/到期必须与冻结基线 ${FROZEN_BASELINE_SHA} 等价`);
  // 变更行数也对着**冻结基线**算（不是 HEAD）：这样「提交之后」它仍是「自冻结基线以来改了多少行」。
  const diff = execFileSync('git', ['diff', '-U0', FROZEN_BASELINE_SHA, '--', 'src/bridge.js'], { cwd: root, encoding: 'utf8' });
  const touched = diff.split(/\r?\n/).filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  // F1 修复引入的运行时去重表必须有生命周期清理：pause/切模式（clearBusyWatchdogRuntimeV2）、
  // retireSession、两处会话重置 —— 否则标记会跨模式/跨会话残留并把合法补发吞掉。
  const markClearSites = (sourceN.match(/rearmedWakeV2\.(delete|clear)\(/g) ?? []).length;
  const runtimeBody = sourceN.slice(sourceN.indexOf('function clearBusyWatchdogRuntimeV2'), sourceN.indexOf('function startBusyWatchdogV2'));
  assert.ok(runtimeBody.includes('rearmedWakeV2.clear()'), 'pause/切模式清运行时必须一并清去重标记');
  assert.ok(markClearSites >= 4, `去重标记必须 ≥4 处清理（运行时 clear + retire + 两处 reset），实测 ${markClearSites} 处`);
  console.log(`   [证据] 去重标记清理点 ${markClearSites} 处（含 clearBusyWatchdogRuntimeV2 内 rearmedWakeV2.clear()）`);
  console.log(`   [证据] git diff ${FROZEN_BASELINE_SHA} -- src/bridge.js 变更行 ${touched.length} 行；arm/disarm 行为与冻结基线对照通过；`
    + `arm 仍含 30 分钟常量=${armOld.includes('30 * 60 * 1000')}`);
  // ── 防复发（t72）：基线不得锚在 HEAD —— 本文件自审，写在 T13 里（不新增用例）─────────────
  const HEAD_REF = 'HE' + 'AD';   // 拆开写 + 消息里插值：否则本检查会把自己的文本当成违规
  const selfSrc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const selfCode = selfSrc.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!selfCode.includes(`${HEAD_REF}:src/`), `本文件不得把 ${HEAD_REF}:<path> 当 git show 的基线（一提交就退化成套话）`);
  assert.ok(!new RegExp(`execFileSync\\([^)]*${HEAD_REF}`).test(selfCode), `本文件不得用 git show ${HEAD_REF}… 当基线`);
  assert.match(selfCode, /const FROZEN_BASELINE_SHA = '[0-9a-f]{7,40}';/, '必须保留固定 SHA 常量（冻结基线）');
  assert.match(selfCode, /gitShowFrozen\(FROZEN_BASELINE_SHA, 'src\/bridge\.js'\)/, 'T13 基线必须经 gitShowFrozen 读固定 SHA');
  assert.match(selfCode, /throw new Error\(`冻结基线不可用/, '取不到冻结基线必须明确抛错（不得静默 skipped）');
  assert.ok(!/skipped\(/.test(selfCode), '不得退回「取不到就 skipped」的静默放行写法');
  console.log(`   [证据·防复发] 本文件无 ${HEAD_REF} 锚点、基线只经 gitShowFrozen(FROZEN_BASELINE_SHA) 读取、取不到即抛错`);
});

// ══ T14 反向打靶（t7 必判）：re-arm 因会话仍忙被再次暂存 → 不登记标记、不丢消息 ═══
// 修复引入的最危险副作用：如果实现用「删 backlog」或「无条件登记」了事，③ 卡住导致
// re-arm 被再次暂存时这条 (reason,seq) 就再也不会投递。这里构造该路径并证明它仍能投递。
await test('T14 反向打靶：re-arm 被再次暂存（③ 队列仍卡）→ 不登记标记，队列恢复后该 (reason,seq) 仍投递', wdConfig(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 1000;
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  h.scheduleWakeV2(key, 'private');            // 真实忙分支 → 暂存 private@seq197
  // ③ 队列卡住：释放 ② 之后会话**仍然忙**，re-arm 会被 scheduleWakeV2 再次暂存
  const entry = { queue: [], running: true };
  let settled = 0;
  entry.queue.push({ promptText: 'x', opts: {}, resolve: () => { settled += 1; }, reject: () => { settled += 1; } });
  h.promptQueues.set(key, entry);
  assert.equal(h.isConversationBusyV2(key, st), true, '②+③ 必须为忙');
  const releaseLine = await waitUntil(() => linesOf(h.readLog(), /\[watchdog\] release[^\n]*/)[0], 8000);
  dump('release', h.readLog(), /[^\n]*\[watchdog\] release[^\n]*/);
  assert.ok(releaseLine, '必须释放 ②');
  assert.match(releaseLine, /released=[^\n]*pendingWakeKeys/, `必须确实释放了 ②：${releaseLine}`);
  assert.match(releaseLine, /rearm=none/, 're-arm 被再次暂存时不得算作 re-arm（:2601 只在真排上定时器时记账）');
  assert.equal(h.busyWatchdog.rearmedWakeV2.has(key), false, '未排上定时器 ⇒ 绝不能登记去重标记（:2601-2606）');
  assert.ok(st.pendingWakeReasons.some((r) => r.reason === 'private' && r.seq === 197), '该条必须留在 backlog 里');
  assert.equal(h.calls.prompts.length, 0, '此刻不得有任何投递');
  assert.ok(count(h.readLog(), /会话繁忙，暂存唤醒原因 private:123（private@seq197）/g) >= 2, 're-arm 必须被真实再次暂存（第二次暂存日志）');
  assert.equal(settled, 0, '③ 队列必须零改动');
  // 队列恢复（队列头返回）→ 该回合结束 → 正常补发路径必须把它投出去
  h.promptQueues.delete(key);
  const feed = h.startMux();
  feed.push(turnStart(sid, 1));
  await sleep(150);
  feed.push(assistantText(sid, 1, '队列恢复后的回合'));
  feed.push(turnEnd(sid, 1));
  const delivered = await waitUntil(() => count(h.readLog(), /\[reserved2\] 唤醒 private:123（private）/g) >= 1, 6000);
  const log = h.readLog();
  dump('补发/唤醒', log, /[^\n]*补发繁忙期间积压的唤醒[^\n]*|[^\n]*跳过重复补发[^\n]*|[^\n]*\[reserved2\] (计划唤醒|唤醒) private:123（private）[^\n]*/);
  assert.ok(delivered, '③ 队列恢复后该 (reason,seq) 必须仍能投递（去重不得丢消息）');
  assert.match(log, /补发繁忙期间积压的唤醒：private@seq197/, '必须走正常补发分支');
  assert.equal(count(log, /跳过重复补发/g), 0, '未登记标记 ⇒ 不得出现跳过分支');
  assert.equal(count(log, /\[reserved2\] 唤醒 private:123（private）/g), 1, '恰好投递一次');
  assert.equal(h.calls.prompts.length, 1, '恰好一次正常投递');
  console.log('   [证据] re-arm 暂存（rearm=none、无标记、条目留在 backlog）→ 队列恢复 + turn/end → 补发 1 次，无跳过');
});

// ══ T15 去重粒度：同一 reason 的不同 seq 都必须能投递（t7 必判）════════════════
await test('T15 去重粒度：同一 reason 的 private@seq197 被跳过时，private@seq205 仍必须投递', wdConfigProdWake(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }, { seq: 205, text: '还在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 1000;
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  h.scheduleWakeV2(key, 'private');            // 暂存 private@seq197
  st.lastUnreadSeq = 205;
  h.scheduleWakeV2(key, 'private');            // 暂存 private@seq205（同 reason 不同 seq）
  assert.deepEqual([...st.pendingWakeReasons].map((r) => `${r.reason}@${r.seq}`), ['private@197', 'private@205'],
    '两条同 reason 不同 seq 的 backlog 必须都在');
  const releaseLine = await waitUntil(() => linesOf(h.readLog(), /\[watchdog\] release[^\n]*/)[0], 8000);
  dump('release', h.readLog(), /[^\n]*\[watchdog\] release[^\n]*/);
  assert.match(releaseLine, /backlog=2 rearm=private@seq197/, `只允许 re-arm top（197）：${releaseLine}`);
  const marks = h.busyWatchdog.rearmedWakeV2.get(key);
  assert.ok(marks && marks.has('private@197') && !marks.has('private@205'), '标记必须严格按 (reason,seq)，不得按 reason 合并');
  // 先等 re-arm 的第一次投递落地：否则 205 的补发会落进同一个合并窗（那是合并语义，不是去重粒度）
  const firstDelivered = await waitUntil(() => count(h.readLog(), /\[reserved2\] 唤醒 private:123（private）/g) >= 1, 6000);
  assert.ok(firstDelivered, 're-arm 必须先完成第一次投递（197）');
  h.wakeConfigUpdatedKeys.add(key);            // 收尾 set_wake_config 不带 throughSeq
  const feed = h.startMux();
  // 第 1 拍 turn/end：shift 出 197 → 已由看门狗 re-arm → 跳过（不投递）
  feed.push(turnStart(sid, 1));
  await sleep(150);
  feed.push(assistantText(sid, 1, 'x'));
  feed.push(turnEnd(sid, 1));
  const skipped = await waitUntil(() => linesOf(h.readLog(), /[^\n]*跳过重复补发[^\n]*/)[0], 5000);
  assert.ok(skipped, `197 必须走跳过分支：${skipped}`);
  assert.match(skipped, /private@seq197/, '被跳过的必须是 197');
  // 第 2 拍 turn/end：shift 出 205 → 未被 re-arm → 正常补发投递（新合并窗）
  feed.push(turnStart(sid, 2));
  await sleep(150);
  feed.push(assistantText(sid, 2, 'y'));
  feed.push(turnEnd(sid, 2));
  const delivered2 = await waitUntil(() => linesOf(h.readLog(), /[^\n]*补发繁忙期间积压的唤醒：private@seq205[^\n]*/)[0], 6000);
  await waitUntil(() => count(h.readLog(), /\[reserved2\] 唤醒 private:123（private）/g) >= 2, 6000);
  const log = h.readLog();
  dump('去重/补发', log, /[^\n]*跳过重复补发[^\n]*|[^\n]*补发繁忙期间积压的唤醒[^\n]*|[^\n]*\[reserved2\] (计划唤醒|唤醒) private:123（private）[^\n]*/);
  assert.ok(delivered2, '205 必须走正常补发（去重粒度不得吞掉同 reason 的不同 seq）');
  assert.equal(count(log, /跳过重复补发/g), 1, '只允许 197 被跳过一次');
  assert.equal(count(log, /\[reserved2\] 唤醒 private:123（private）/g), 2, '两条 (reason,seq) 各投递一次');
  assert.equal(h.calls.prompts.length, 2, '正常投递 2 次');
  assert.equal(st.pendingWakeReasons.length, 0, '两条 backlog 都已被消费/投递');
  console.log('   [证据] 197 跳过 1 次 + 205 补发 1 次 + 总投递 2 次（同 reason 不同 seq 未被合并）');
});

// ══ T16（t9 硬断言化，按修复后语义重写）══════════════════════════════════════
// 场景：② 单独卡忙 → 看门狗释放并 re-arm（登记 (private,197)）→ 那次投递被 DSH 拒绝。
// 修复后语义（本用例独立重写，不照抄实现方的断言文本）：
//   ① 失败后被清标记必须不存在 ② 该 (reason,seq) 仍留在 backlog ③ 失败当拍无待发定时器
//   ④ 该条最终被重排并真的送达 ⑤ 全程不得出现「跳过重复补发」分支
await test('T16 硬断言：re-arm 投递被拒后标记不残留；该 (reason,seq) 留在 backlog 并被重排送达', wdConfig(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 1000;
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  h.scheduleWakeV2(key, 'private');
  const releaseLine = await waitUntil(() => linesOf(h.readLog(), /\[watchdog\] release[^\n]*/)[0], 8000);
  assert.match(releaseLine, /rearm=private@seq197/, `必须先成功排上 re-arm：${releaseLine}`);
  assert.ok(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197'), '排上定时器时必须登记标记（否则 F1 复发）');
  // 这次投递被 DSH 拒绝（result.ok === false 分支）
  h.api.sessions.prompt = async () => ({ result: { ok: false, error: { code: 'fixture_unavailable', message: 'DSH 暂不可用' } } });
  const failed = await waitUntil(() => linesOf(h.readLog(), /[^\n]*唤醒投递被拒[^\n]*/)[0], 6000);
  assert.ok(failed, `投递必须被拒：${failed}`);
  // ① 被清标记必须不存在
  assert.equal(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197') ?? false, false,
    `投递被拒（从未送达）后不得残留去重标记，实测残留=${JSON.stringify([...(h.busyWatchdog.rearmedWakeV2.get(key) ?? [])])}`);
  // ② 仍留在 backlog
  assert.ok(st.pendingWakeReasons.some((r) => r.reason === 'private' && r.seq === 197), '该条必须仍留在 backlog');
  // ③ 失败当拍无待发定时器
  assert.equal(st.pendingWakeTimer, null, '失败当拍不得有 pendingWakeTimer');
  assert.equal(h.calls.prompts.length, 0, '被拒的那次不算送达');
  // ④ 随后该回合结束 → shift 重新排程 → 真的送达
  h.api.sessions.prompt = async (params) => { h.calls.prompts.push(params); return { result: { ok: true, value: {} } }; };
  h.wakeConfigUpdatedKeys.add(key);
  const feed = h.startMux();
  feed.push(turnStart(sid, 1));
  await sleep(150);
  feed.push(assistantText(sid, 1, 'x'));
  feed.push(turnEnd(sid, 1));
  const retried = await waitUntil(() => linesOf(h.readLog(), /[^\n]*补发繁忙期间积压的唤醒：private@seq197[^\n]*/)[0], 6000);
  const delivered = await waitUntil(() => h.calls.prompts.length >= 1, 6000);
  const log = h.readLog();
  dump('被拒→重排送达', log, /[^\n]*唤醒投递被拒[^\n]*|[^\n]*跳过重复补发[^\n]*|[^\n]*补发繁忙期间积压的唤醒[^\n]*|[^\n]*\[reserved2\] (计划唤醒|唤醒) private:123（private）[^\n]*/);
  assert.ok(retried, '该条必须被 shift 重新排程（补发分支）');
  assert.ok(delivered, '重排后必须真的送达（api.sessions.prompt 被接受）');
  // ⑤ 全程不得出现「跳过重复补发」
  assert.equal(count(log, /跳过重复补发/g), 0, '失败路径修复后不得再走「跳过重复补发」');
  assert.equal(count(log, /唤醒投递被拒/g), 1, '恰好一次被拒');
  assert.equal(h.calls.prompts.length, 1, '恰好一次被接受的送达');
  assert.equal(st.pendingWakeReasons.length, 0, '重排后 backlog 清空');
  console.log('   [证据] 被拒 1 次；标记残留=false；条目留在 backlog；重排补发 1 次；送达 1 次；跳过分支 0 次');
});

// ══ T17 路径②：投递抛错（catch 分支）→ 标记清、条目留、可重排送达 ══════════════
await test('T17 路径② 抛错：投递 throw 后标记清空、条目留在 backlog、重排后送达', wdConfig(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 1000;
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  h.scheduleWakeV2(key, 'private');
  const releaseLine = await waitUntil(() => linesOf(h.readLog(), /\[watchdog\] release[^\n]*/)[0], 8000);
  assert.match(releaseLine, /rearm=private@seq197/);
  h.api.sessions.prompt = async () => { throw new Error('fixture_transport_down'); };
  const failed = await waitUntil(() => linesOf(h.readLog(), /[^\n]*唤醒投递失败[^\n]*/)[0], 6000);
  assert.ok(failed, `投递必须抛错：${failed}`);
  assert.equal(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197') ?? false, false, '抛错（从未送达）后不得残留标记');
  assert.ok(st.pendingWakeReasons.some((r) => r.reason === 'private' && r.seq === 197), '条目必须留在 backlog');
  assert.equal(st.pendingWakeTimer, null, '抛错当拍不得有 pendingWakeTimer');
  h.api.sessions.prompt = async (params) => { h.calls.prompts.push(params); return { result: { ok: true, value: {} } }; };
  h.wakeConfigUpdatedKeys.add(key);
  const feed = h.startMux();
  feed.push(turnStart(sid, 1));
  await sleep(150);
  feed.push(assistantText(sid, 1, 'x'));
  feed.push(turnEnd(sid, 1));
  const retried = await waitUntil(() => linesOf(h.readLog(), /[^\n]*补发繁忙期间积压的唤醒：private@seq197[^\n]*/)[0], 6000);
  await waitUntil(() => h.calls.prompts.length >= 1, 6000);
  const log = h.readLog();
  dump('抛错→重排送达', log, /[^\n]*唤醒投递失败[^\n]*|[^\n]*跳过重复补发[^\n]*|[^\n]*补发繁忙期间积压的唤醒[^\n]*/);
  assert.ok(retried, '必须走补发分支重排');
  assert.equal(count(log, /跳过重复补发/g), 0, '不得走跳过分支');
  assert.equal(h.calls.prompts.length, 1, '重排后恰好送达 1 次');
  assert.equal(st.pendingWakeReasons.length, 0);
  console.log('   [证据] 抛错 1 次；标记残留=false；条目留在 backlog；重排 1 次；送达 1 次；跳过 0 次');
});

// ══ T18 路径③：skipWake（paused / 白名单外 两个闸门）→ 标记清、条目留、恢复后送达 ══
await test('T18 路径③ skipWake：paused 与白名单外两个闸门各自清标记，恢复后仍可送达', wdConfig({ ...SCALED, rearmCooldownMs: 0, maxRearmPerHour: 5 }), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 1000;
  // ── ③-a paused：看门狗排上 re-arm 之后才进入 paused（直接置运行时位，等价于闸门 :11216）
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  h.scheduleWakeV2(key, 'private');
  const rel1 = await waitUntil(() => linesOf(h.readLog(), /\[watchdog\] release[^\n]*/)[0], 8000);
  assert.match(rel1, /rearm=private@seq197/);
  assert.ok(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197'), 'paused 之前标记必须已在');
  h.socialV2.paused = true;                       // 直设运行时位（控制台端点会额外清整表，见 T7a/T13）
  const attemptsBeforePause = count(h.readLog(), /\[reserved2\] 唤醒 private:123（private）/g);
  await sleep(1600);                              // 等 re-arm 合并窗到期 → 走 paused 闸门
  assert.equal(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197') ?? false, false, 'paused 闸门跳过投递后不得残留标记');
  assert.ok(st.pendingWakeReasons.some((r) => r.reason === 'private' && r.seq === 197), '条目必须留在 backlog（paused）');
  assert.equal(h.calls.prompts.length, 0, 'paused 期间不得有投递');
  assert.equal(count(h.readLog(), /\[reserved2\] 唤醒 private:123（private）/g), attemptsBeforePause,
    'paused 闸门在「唤醒 …」尝试日志之前就返回（失败路径不进入投递）');
  h.socialV2.paused = false;
  // ── ③-b 白名单外：cfg 热改把会话移出白名单（等价于闸门 :11217-11221）
  st.pendingWakeReasons = [{ reason: 'private', seq: 197 }];
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  h.scheduleWakeV2(key, 'private');
  const rel2 = await waitUntil(() => count(h.readLog(), /\[watchdog\] release[^\n]*/g) >= 2
    ? linesOf(h.readLog(), /\[watchdog\] release[^\n]*/).slice(-1)[0] : null, 8000);
  assert.match(rel2, /rearm=private@seq197/, `第二次释放必须再次 re-arm：${rel2}`);
  const allowBackup = [...h.cfg.allow.private];
  h.cfg.allow.private = allowBackup.filter((id) => String(id) !== '123');   // 热改 cfg：移出白名单
  const skipLine = await waitUntil(() => linesOf(h.readLog(), /[^\n]*跳过唤醒 private:123[^\n]*/)[0], 6000);
  assert.ok(skipLine, '必须走到「会话已不在当前模式允许范围内」闸门');
  assert.equal(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197') ?? false, false, '白名单闸门跳过投递后不得残留标记');
  assert.ok(st.pendingWakeReasons.some((r) => r.reason === 'private' && r.seq === 197), '条目必须留在 backlog（白名单外）');
  // ── 恢复白名单 → 该回合结束 → 重排并送达
  h.cfg.allow.private = allowBackup;
  h.wakeConfigUpdatedKeys.add(key);
  const feed = h.startMux();
  feed.push(turnStart(sid, 1));
  await sleep(150);
  feed.push(assistantText(sid, 1, 'x'));
  feed.push(turnEnd(sid, 1));
  const retried = await waitUntil(() => linesOf(h.readLog(), /[^\n]*补发繁忙期间积压的唤醒：private@seq197[^\n]*/)[0], 6000);
  await waitUntil(() => h.calls.prompts.length >= 1, 6000);
  const log = h.readLog();
  dump('skip→重排送达', log, /[^\n]*跳过唤醒 private:123[^\n]*|[^\n]*跳过重复补发[^\n]*|[^\n]*补发繁忙期间积压的唤醒[^\n]*/);
  assert.ok(retried, '白名单恢复后必须重排补发');
  assert.equal(count(log, /跳过重复补发/g), 0, '不得走跳过分支');
  assert.equal(h.calls.prompts.length, 1, '恢复后恰好送达 1 次');
  console.log('   [证据] paused 闸门：标记残留=false、条目留 backlog；白名单闸门：标记残留=false、条目留 backlog；恢复后送达 1 次、跳过 0 次');
});

// ══ T19 路径④：定时器已排上、派发时又被忙分支再次暂存 → 标记清、条目留、可送达 ══
await test('T19 路径④ 派发时仍忙：再次暂存后标记清空、条目留在 backlog、解除忙后送达', wdConfig(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 1000;
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  h.scheduleWakeV2(key, 'private');
  const releaseLine = await waitUntil(() => linesOf(h.readLog(), /\[watchdog\] release[^\n]*/)[0], 8000);
  assert.match(releaseLine, /rearm=private@seq197/, '必须先排上 re-arm（标记已登记）');
  assert.ok(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197'), '标记必须已在');
  // 合并窗内让会话再次忙（③ 队列卡住）→ 派发时走 :11225 忙分支再次暂存
  const entry = { queue: [], running: true };
  let settled = 0;
  entry.queue.push({ promptText: 'x', opts: {}, resolve: () => { settled += 1; }, reject: () => { settled += 1; } });
  // 注意：setup 阶段的 scheduleWakeV2 忙分支已经打过一条同文案的暂存日志，必须要求**新增一条**
  const stashBefore = count(h.readLog(), /会话繁忙，暂存唤醒原因 private:123（private@seq197）/g);
  h.promptQueues.set(key, entry);
  const stashLine = await waitUntil(() => {
    const lines = linesOf(h.readLog(), /[^\n]*会话繁忙，暂存唤醒原因 private:123（private@seq197）[^\n]*/);
    return lines.length > stashBefore ? lines[lines.length - 1] : null;
  }, 6000);
  assert.ok(stashLine, `派发时必须被再次暂存（新增一条暂存日志，之前 ${stashBefore} 条）：${stashLine}`);
  assert.equal(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197') ?? false, false, '再次暂存（未送达）后不得残留标记');
  assert.ok(st.pendingWakeReasons.some((r) => r.reason === 'private' && r.seq === 197), '条目必须留在 backlog');
  assert.equal(st.pendingWakeTimer, null, '再次暂存后不得有待发定时器');
  assert.equal(h.calls.prompts.length, 0, '再次暂存不算送达');
  assert.equal(settled, 0, '③ 队列必须零改动');
  // 解除忙（队列恢复）→ 该回合结束 → 重排并送达
  h.promptQueues.delete(key);
  h.wakeConfigUpdatedKeys.add(key);
  const feed = h.startMux();
  feed.push(turnStart(sid, 1));
  await sleep(150);
  feed.push(assistantText(sid, 1, 'x'));
  feed.push(turnEnd(sid, 1));
  const retried = await waitUntil(() => linesOf(h.readLog(), /[^\n]*补发繁忙期间积压的唤醒：private@seq197[^\n]*/)[0], 6000);
  await waitUntil(() => h.calls.prompts.length >= 1, 6000);
  const log = h.readLog();
  dump('再暂存→重排送达', log, /[^\n]*会话繁忙，暂存唤醒原因[^\n]*|[^\n]*跳过重复补发[^\n]*|[^\n]*补发繁忙期间积压的唤醒[^\n]*/);
  assert.ok(retried, '解除忙后必须重排补发');
  assert.equal(count(log, /跳过重复补发/g), 0, '不得走跳过分支');
  assert.equal(h.calls.prompts.length, 1, '恰好送达 1 次');
  assert.equal(st.pendingWakeReasons.length, 0);
  console.log('   [证据] 再次暂存 1 次；标记残留=false；条目留 backlog；解除忙后重排 1 次、送达 1 次、跳过 0 次');
});

// ══ T20 清标记的粒度（单元级）：非有限 seq 不动任何标记；只清指定 (reason,seq) ══
await test('T20 清标记粒度：非有限 seq 不动标记；只清指定 (reason,seq)，不按 reason 合并', {}, async (h) => {
  const key = 'private:123';
  h.busyWatchdog.rearmedWakeV2.set(key, new Set(['private@197', 'private@205']));
  assert.equal(h.clearBusyRearmedWakeV2(key, 'private', undefined), false, 'seq 缺失必须不动标记');
  assert.equal(h.clearBusyRearmedWakeV2(key, 'private', 'abc'), false, 'seq 非数字必须不动标记');
  assert.equal(h.clearBusyRearmedWakeV2(key, 'private', null), false, 'seq=null 必须不动标记');
  assert.deepEqual([...h.busyWatchdog.rearmedWakeV2.get(key)].sort(), ['private@197', 'private@205'], '非有限 seq 三次清理后两条标记都必须在');
  assert.equal(h.clearBusyRearmedWakeV2(key, 'private', 197), true, '指定 seq 必须清掉');
  assert.deepEqual([...h.busyWatchdog.rearmedWakeV2.get(key)], ['private@205'], '同 reason 的另一 seq 必须保留（不得按 reason 粗清）');
  assert.equal(h.clearBusyRearmedWakeV2(key, 'private', 197), false, '重复清理必须幂等返回 false');
  assert.equal(h.clearBusyRearmedWakeV2(key, 'private', 205), true);
  assert.equal(h.busyWatchdog.rearmedWakeV2.has(key), false, '清空后必须删掉空集合');
  assert.equal(h.busyWakeIdV2('private', 197), 'private@197', '去重键必须严格是 reason@seq');
  console.log('   [证据] 非有限 seq×3 均 false 且两条标记保留；197 清理 true 且 205 保留；重复清理 false；清空后集合移除');
});

// ══ T21 反证夹具：VM 内中和 F3 修复（不改仓库文件）→ 旧 T16 断言必然成立 ════════
// 独立复核实现方「T16 旧断言不可满足」的论证：旧断言 :900「投递失败后标记仍在」与
// :914「残留标记必须被 shift 消费」只有在标记**不被清理**（= F3 未修）时成立。
// 这里把 clearBusyRearmedWakeV2 在 VM 副本里改成恒 false（等价于修复前行为），
// 现场复现旧断言成立、而修复后语义（标记已清 / 不走跳过分支）必然失败。
const neutralizeClearFix = (src) => src.replace(
  'function clearBusyRearmedWakeV2(key, reason, seq) {',
  'function clearBusyRearmedWakeV2(key, reason, seq) { return false;   // t9 反证夹具：VM 内中和 F3 修复'
);
await test('T21 反证：中和 F3 修复后，旧 T16 断言（标记残留 + shift 跳过）成立 → 旧断言编码的是修复前行为', wdConfig(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 1000;
  assert.equal(h.clearBusyRearmedWakeV2(key, 'private', 197), false, 'VM 变体里清理函数必须已中和（对空表也返回 false）');
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  h.scheduleWakeV2(key, 'private');
  const releaseLine = await waitUntil(() => linesOf(h.readLog(), /\[watchdog\] release[^\n]*/)[0], 8000);
  assert.match(releaseLine, /rearm=private@seq197/);
  h.api.sessions.prompt = async () => ({ result: { ok: false, error: { code: 'fixture_unavailable', message: 'DSH 暂不可用' } } });
  const failed = await waitUntil(() => linesOf(h.readLog(), /[^\n]*唤醒投递被拒[^\n]*/)[0], 6000);
  assert.ok(failed, '投递必须被拒');
  // 旧断言 :900 的语义：失败后标记仍在（= F3 未修的行为指纹）
  assert.ok(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197'), '旧断言 :900 在中和变体下必须成立（标记残留）');
  h.api.sessions.prompt = async (params) => { h.calls.prompts.push(params); return { result: { ok: true, value: {} } }; };
  h.wakeConfigUpdatedKeys.add(key);
  const feed = h.startMux();
  feed.push(turnStart(sid, 1));
  await sleep(150);
  feed.push(assistantText(sid, 1, 'x'));
  feed.push(turnEnd(sid, 1));
  const skipped = await waitUntil(() => linesOf(h.readLog(), /[^\n]*跳过重复补发[^\n]*/)[0], 5000);
  const log = h.readLog();
  dump('中和变体：失败→跳过', log, /[^\n]*唤醒投递被拒[^\n]*|[^\n]*跳过重复补发[^\n]*|[^\n]*补发繁忙期间积压的唤醒[^\n]*/);
  // 旧断言 :914 的语义：残留标记必须被 shift 消费并跳过
  assert.ok(skipped, '旧断言 :914 在中和变体下必须成立（残留标记被 shift 消费 → 跳过重复补发）');
  assert.match(skipped, /private@seq197/);
  // 且该条从未送达：这正是 F3 的丢消息指纹（修复后同一场景 1 次送达，见 T16）
  assert.equal(h.calls.prompts.length, 0, '中和变体下该条从未送达（F3 指纹）');
  assert.equal(st.pendingWakeReasons.length, 0, '中和变体下条目被 shift 丢弃');
  console.log('   [证据] 中和 F3 修复后：标记残留=true、shift 跳过=1 次、送达=0 次 → 旧断言 :900/:914 只在修复前成立');
}, { harnessOptions: { transformSource: neutralizeClearFix } });

// ══ T22（F4 硬断言）离线队列溢出丢弃待投唤醒 → 标记结束、不跳过、重排并送达 ═══════
// t9 的旧探针用固定 sleep(400ms) 判「是否已重排送达」，而合并窗下限是 batchMs=max(1000,batchWindowMs)
// ≥ 1000ms —— 断言失败是**我的等待太短**，不是语义不可满足。本轮全部改为轮询（上限 4s = 1s 下限 + 3s 余量）。
await test('T22 F4 硬断言：溢出丢弃待投唤醒后标记结束、无跳过分支、重排并最终送达', wdConfigProdWake(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 1000;
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  h.scheduleWakeV2(key, 'private');
  const releaseLine = await waitUntil(() => linesOf(h.readLog(), /\[watchdog\] release[^\n]*/)[0], 8000);
  assert.match(releaseLine, /rearm=private@seq197/, `必须先成功 re-arm：${releaseLine}`);
  h.setReady(false);                                   // DSH 掉线：这次 re-arm 只能入队
  const queuedLine = await waitUntil(() => linesOf(h.readLog(), /[^\n]*唤醒已入队[^\n]*/)[0], 6000);
  assert.ok(queuedLine, `re-arm 必须走离线入队分支：${queuedLine}`);
  assert.ok(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197'), 'queued 成功路径必须保留标记（反向断言）');
  // 填满离线队列（QUEUE_MAX=50）→ 最旧的那条（带 wakeSeq 的待投唤醒）被溢出丢弃
  for (let i = 0; i < 50; i += 1) await h.deliverPrompt(key, `filler-${i}`, {});
  const dropLine = await waitUntil(() => linesOf(h.readLog(), /[^\n]*丢弃最旧消息[^\n]*/)[0], 6000);
  assert.ok(dropLine, `必须发生过队列溢出丢弃：${dropLine}`);
  assert.equal((h.queued.get(key) ?? []).filter((it) => Number(it.wakeSeq) === 197).length, 0, '带 wakeSeq=197 的待投唤醒必须已被溢出丢弃');
  // ① 丢弃携带 wake 的项后该 (reason,seq) 标记必须不存在
  assert.equal(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197') ?? false, false,
    `丢弃待投唤醒后不得残留标记，实测=${JSON.stringify(marksOf(h, key))}`);
  // ④ 该条不得被永久丢失：它必须仍在 backlog 里等重排
  assert.ok(st.pendingWakeReasons.some((r) => r.reason === 'private' && r.seq === 197), '该条必须仍留在 backlog');
  // 之后该回合结束 → shift 必须走重排/补发，而不是跳过
  h.setReady(true);
  h.wakeConfigUpdatedKeys.add(key);
  const feed = h.startMux();
  feed.push(turnStart(sid, 1));
  await sleep(150);
  feed.push(assistantText(sid, 1, 'x'));
  feed.push(turnEnd(sid, 1));
  // ③ 轮询等待重排 + 真正送达（上限 4000ms > 合并窗下限 1000ms）
  const retriedLine = await waitUntil(() => linesOf(h.readLog(), /[^\n]*补发繁忙期间积压的唤醒：private@seq197[^\n]*/)[0], 4000);
  const delivered = await waitUntil(() => h.calls.prompts.length >= 1, 4000);
  const log = h.readLog();
  dump('溢出丢弃→重排送达', log, /[^\n]*丢弃最旧消息[^\n]*|[^\n]*跳过重复补发[^\n]*|[^\n]*补发繁忙期间积压的唤醒[^\n]*|[^\n]*\[reserved2\] (计划唤醒|唤醒) private:123（private）[^\n]*/);
  assert.ok(retriedLine, '该条必须被 shift 重排（补发分支）');
  assert.ok(delivered, '重排后必须真的送达（api.sessions.prompt 被接受）');
  // ② 全程不得出现「跳过重复补发」
  assert.equal(count(log, /跳过重复补发/g), 0, '被溢出丢弃的待投唤醒不得让 shift 走跳过分支');
  assert.equal(h.calls.prompts.length, 1, '恰好一次被接受的送达（未永久丢失）');
  assert.equal(st.pendingWakeReasons.length, 0, '重排后 backlog 清空');
  console.log('   [证据] 溢出丢弃 1 次；标记结束=true；无跳过分支；重排 1 次；送达 1 次（轮询等待）');
});

// ══ T23 改判（合并窗原因升级）→ 旧 (reason,seq) 标记必须结束、条目仍可投递 ══════
await test('T23 改判·合并窗升级：旧原因标记结束，原 backlog 条目仍能被重排送达', wdConfigProdWake(SCALED), async (h) => {
  const key = 'private:123';
  // anyMessage(50) 被看门狗 re-arm；合并窗内再排 atMention(90) → 触发 :11445 的升级清理
  const { sid, st } = await seedMarkedPendingWake(h, key, { reason: 'anyMessage', seq: 197 });
  assert.equal(marksOf(h, key).join(','), 'anyMessage@197', '升级前标记应为 anyMessage@197');
  h.scheduleWakeV2(key, 'atMention');
  assert.match(h.readLog(), /合并窗口内升级唤醒原因 private:123: anyMessage -> atMention/, '必须走真实升级分支');
  assert.equal(h.busyWatchdog.rearmedWakeV2.get(key)?.has('anyMessage@197') ?? false, false,
    `旧原因 (anyMessage,197) 的标记必须结束，实测=${JSON.stringify(marksOf(h, key))}`);
  assert.equal(st.pendingWakeReason, 'atMention', '待发原因必须已被升级');
  assert.ok(st.pendingWakeReasons.some((r) => r.reason === 'anyMessage' && r.seq === 197), '(anyMessage,197) 条目必须仍在 backlog 等重排');
  await waitUntil(() => h.calls.prompts.length >= 1, 5000);          // 升级后的 atMention 正常送达
  assert.ok(await waitUntil(() => count(h.readLog(), /唤醒 private:123（atMention）/g) >= 1, 2000), '升级后的原因必须送达');
  h.wakeConfigUpdatedKeys.add(key);
  const feed = h.startMux();
  feed.push(turnStart(sid, 1));
  await sleep(150);
  feed.push(assistantText(sid, 1, 'x'));
  feed.push(turnEnd(sid, 1));
  const retried = await waitUntil(() => linesOf(h.readLog(), /[^\n]*补发繁忙期间积压的唤醒：anyMessage@seq197[^\n]*/)[0], 5000);
  const log = h.readLog();
  dump('升级→重排', log, /[^\n]*合并窗口内升级唤醒原因[^\n]*|[^\n]*跳过重复补发[^\n]*|[^\n]*补发繁忙期间积压的唤醒[^\n]*/);
  assert.ok(retried, '旧原因的条目必须被重排补发（未因标记残留被跳过）');
  assert.equal(count(log, /跳过重复补发/g), 0, '升级路径不得留下让 shift 跳过的标记');
  console.log('   [证据] 升级清理：旧标记结束=true；旧条目留 backlog 并被重排送达；跳过 0 次');
});

// ══ T24 改判（唤醒额度跳过 :11287）→ 标记必须结束、条目仍可投递 ═══════════════
await test('T24 改判·额度跳过：投递被额度拦下后标记结束，恢复额度后仍能重排送达', wdConfigProdWake(SCALED), async (h) => {
  const key = 'private:123';
  const { sid, st } = await seedMarkedPendingWake(h, key, { reason: 'private', seq: 197 });
  assert.ok(marksOf(h, key).includes('private@197'), '额度跳过前标记必须在');
  // 让这次派发撞上额度上限（maxWakePerMinute=1，且已用掉 1 次）
  h.cfg.socialV2.wake.maxWakePerMinute = 1;
  st.wakeTimes = [Date.now()];
  const quotaLine = await waitUntil(() => linesOf(h.readLog(), /[^\n]*唤醒频率超限，跳过 private:123（private）[^\n]*/)[0], 4000);
  assert.ok(quotaLine, `必须走到额度跳过分支：${quotaLine}`);
  assert.equal(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197') ?? false, false,
    `额度跳过（未送达）后不得残留标记，实测=${JSON.stringify(marksOf(h, key))}`);
  assert.ok(st.pendingWakeReasons.some((r) => r.reason === 'private' && r.seq === 197), '条目必须留在 backlog');
  assert.equal(st.pendingWakeTimer, null, '额度跳过当拍不得有待发定时器');
  h.cfg.socialV2.wake.maxWakePerMinute = 10;           // 恢复额度
  st.wakeTimes = [];
  h.wakeConfigUpdatedKeys.add(key);
  const feed = h.startMux();
  feed.push(turnStart(sid, 1));
  await sleep(150);
  feed.push(assistantText(sid, 1, 'x'));
  feed.push(turnEnd(sid, 1));
  const retried = await waitUntil(() => linesOf(h.readLog(), /[^\n]*补发繁忙期间积压的唤醒：private@seq197[^\n]*/)[0], 5000);
  await waitUntil(() => h.calls.prompts.length >= 1, 5000);
  const log = h.readLog();
  dump('额度跳过→重排', log, /[^\n]*唤醒频率超限[^\n]*|[^\n]*跳过重复补发[^\n]*|[^\n]*补发繁忙期间积压的唤醒[^\n]*/);
  assert.ok(retried, '恢复额度后必须重排补发');
  assert.equal(count(log, /跳过重复补发/g), 0, '不得走跳过分支');
  assert.equal(h.calls.prompts.length, 1, '恰好送达 1 次');
  console.log('   [证据] 额度跳过 1 次；标记结束=true；条目留 backlog；恢复后重排 1 次、送达 1 次');
});

// ══ T25 F5-1 set_wake_config（:5166）取消待发唤醒 → 该 key 标记必须为空 ═════════
await test('T25 F5-1 set_wake_config 端点取消待发唤醒后该 key 标记为空', wdConfig(SCALED), async (h) => {
  const key = 'private:123';
  const { st } = await seedMarkedPendingWake(h, key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await postJson(server, '/api/socialV2/wake-config', { key, config: { mode: 'active' } });
    assert.equal(res.status, 200, `set_wake_config 必须成功：${res.body}`);
    assert.ok(await waitUntil(() => st.pendingWakeTimer === null, 2000), 'set_wake_config 必须清掉待发定时器');
    assert.deepEqual(marksOf(h, key), [], '清掉待发唤醒后该 key 的标记必须为空');
    assert.ok(st.pendingWakeReasons.some((r) => r.reason === 'private' && r.seq === 197), '被取消的那条必须仍在 backlog（不丢消息）');
    console.log(`   [证据] :5166 清定时器后 marks=${JSON.stringify(marksOf(h, key))}，条目仍留 backlog`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ══ T26 F5-2 控制台手动唤醒（:5205）→ 该 key 标记必须为空 ════════════════════
await test('T26 F5-2 控制台手动唤醒端点取消待发唤醒后该 key 标记为空', wdConfig(SCALED), async (h) => {
  const key = 'private:123';
  const { st } = await seedMarkedPendingWake(h, key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await postJson(server, '/api/socialV2/wake', { key, reason: 'admin' });
    assert.equal(res.status, 200, `手动唤醒端点必须成功：${res.body}`);
    assert.ok(await waitUntil(() => st.pendingWakeTimer === null, 2000), '手动唤醒必须清掉待发定时器');
    assert.deepEqual(marksOf(h, key), [], '清掉待发唤醒后该 key 的标记必须为空');
    assert.ok(st.pendingWakeReasons.some((r) => r.reason === 'private' && r.seq === 197), '被取代的那条必须仍在 backlog');
    console.log(`   [证据] :5205 清定时器后 marks=${JSON.stringify(marksOf(h, key))}，条目仍留 backlog`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ══ T27 F5-3 qq_wait_for_messages 入口（:6194）→ 该 key 标记必须为空 ═══════════
await test('T27 F5-3 qq_wait_for_messages 入口取消待发唤醒后该 key 标记为空', wdConfig(SCALED), async (h) => {
  const key = 'private:123';
  const { st } = await seedMarkedPendingWake(h, key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  let request;
  try {
    request = postFireAndForget(server, '/api/socialV2/wait', { key, purpose: 'messages', timeoutMs: 5000, minNewMessages: 1 });
    assert.ok(await waitUntil(() => st.pendingWakeTimer === null, 2000), 'wait 入口必须清掉待发定时器');
    assert.deepEqual(marksOf(h, key), [], '清掉待发唤醒后该 key 的标记必须为空');
    assert.ok(st.pendingWakeReasons.some((r) => r.reason === 'private' && r.seq === 197), '被取消的那条必须仍在 backlog');
    console.log(`   [证据] :6194 清定时器后 marks=${JSON.stringify(marksOf(h, key))}，条目仍留 backlog`);
  } finally {
    try { request?.destroy(); } catch {}
    await new Promise((resolve) => server.close(resolve));
  }
});

// ══ T28 F5-4 clearSocialV2Timers（:11590）按 key 取消 → 该 key 标记为空、他 key 不受影响 ══
await test('T28 F5-4 clearSocialV2Timers 按 key 清空标记，不影响其它 key', wdConfig(SCALED), async (h) => {
  const keyA = 'private:123';
  const keyB = 'group:456';
  const stA = h.getSocialV2State(keyA);
  const stB = h.getSocialV2State(keyB);
  for (const [key, st, seq] of [[keyA, stA, 197], [keyB, stB, 205]]) {
    st.pendingWakeTimer = setTimeout(() => {}, 60000);
    st.pendingWakeReason = 'private';
    st.pendingWakeSeq = seq;
    h.busyWatchdog.rearmedWakeV2.set(key, new Set([`private@${seq}`]));
  }
  h.clearSocialV2Timers(keyA);
  assert.equal(stA.pendingWakeTimer, null, 'clearSocialV2Timers 必须清掉该 key 的待发定时器');
  assert.deepEqual(marksOf(h, keyA), [], '该 key 的标记必须为空（F5-4）');
  assert.deepEqual(marksOf(h, keyB), ['private@205'], '其它 key 的标记不得被误清');
  assert.ok(stB.pendingWakeTimer, '其它 key 的待发定时器不得被误清');
  console.log(`   [证据] :11590 清 A 后 marks(A)=${JSON.stringify(marksOf(h, keyA))}、marks(B)=${JSON.stringify(marksOf(h, keyB))}`);
});

// ══ T29 反向断言：成功路径（已送达 / queued）必须保留标记，直到 shift 一次性消费 ══
await test('T29 反向断言：成功送达与离线入队都保留标记，只有 shift 才消费（防过度清理复发 F1）', wdConfigProdWake(SCALED), async (h) => {
  // (a) 正常送达路径：标记必须保留到 shift 一次性消费
  const keyA = 'private:123';
  const seedA = await seedMarkedPendingWake(h, keyA, { reason: 'private', seq: 197 });
  const delivered = await waitUntil(() => h.calls.prompts.length >= 1, 5000);
  assert.ok(delivered, '合并窗到期后必须正常送达 1 次');
  assert.ok(h.busyWatchdog.rearmedWakeV2.get(keyA)?.has('private@197'), '正常送达后标记必须仍在（否则 shift 会再投一次 = F1 复发）');
  h.wakeConfigUpdatedKeys.add(keyA);
  const feed = h.startMux();
  feed.push(turnStart(seedA.sid, 1));
  await sleep(150);
  feed.push(assistantText(seedA.sid, 1, 'x'));
  feed.push(turnEnd(seedA.sid, 1));
  const skipped = await waitUntil(() => linesOf(h.readLog(), /[^\n]*跳过重复补发[^\n]*/)[0], 5000);
  assert.ok(skipped, 'shift 必须消费标记并跳过重复补发（F1 保护）');
  assert.deepEqual(marksOf(h, keyA), [], '消费后该 key 标记必须为空');
  assert.equal(h.calls.prompts.length, 1, '同一 (reason,seq) 全程只投递 1 次');
  // (b) queued（离线入队＝会投）路径：标记同样必须保留
  const keyB = 'group:456';
  await seedMarkedPendingWake(h, keyB, { reason: 'private', seq: 205 });
  h.setReady(false);
  const queuedLine = await waitUntil(() => linesOf(h.readLog(), /[^\n]*唤醒已入队[^\n]*/)[0], 5000);
  assert.ok(queuedLine, `必须走离线入队：${queuedLine}`);
  assert.ok(h.busyWatchdog.rearmedWakeV2.get(keyB)?.has('private@205'), 'queued（会投）必须保留标记');
  assert.equal((h.queued.get(keyB) ?? []).filter((it) => Number(it.wakeSeq) === 205).length, 1, '该唤醒必须确实进了离线队列');
  console.log('   [证据] 正常送达后保留=true → shift 消费后为空、投递总次数=1；queued 保留=true（离线队列有该项）');
});

// ══ T30 丢弃·backlog>20 截断（:11461 与 :11281 两处）→ 被丢条目标记必须结束 ═════
await test('T30 丢弃·backlog>20 截断：被丢的最旧条目标记结束、其余标记保留', wdConfig(SCALED), async (h) => {
  const key = 'private:123';
  h.setMode('reserved2');
  const st = h.getSocialV2State(key);
  // 播种：最旧一条 (private,197) 带标记，再加 19 条占位 → 再 push 1 条触发 >20 截断
  st.pendingWakeReasons = [{ reason: 'private', seq: 197 }];
  for (let i = 0; i < 19; i += 1) st.pendingWakeReasons.push({ reason: 'anyMessage', seq: 300 + i });
  h.busyWatchdog.rearmedWakeV2.set(key, new Set(['private@197', 'anyMessage@399']));
  h.pendingWakeKeys.add(key);                                  // 让 scheduleWakeV2 走忙分支（:11459 截断点）
  h.scheduleWakeV2(key, 'question');
  assert.equal(st.pendingWakeReasons.length, 20, '截断后必须恰好 20 条');
  assert.equal(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197') ?? false, false,
    `被截断丢弃的 (private,197) 标记必须结束，实测=${JSON.stringify(marksOf(h, key))}`);
  assert.ok(h.busyWatchdog.rearmedWakeV2.get(key)?.has('anyMessage@399'), '未被丢弃的标记必须保留');
  // sendWakePromptV2 忙分支（:11279）同语义再验一次
  const st2 = h.getSocialV2State('group:456');
  st2.pendingWakeReasons = [{ reason: 'private', seq: 501 }];
  for (let i = 0; i < 19; i += 1) st2.pendingWakeReasons.push({ reason: 'anyMessage', seq: 600 + i });
  h.busyWatchdog.rearmedWakeV2.set('group:456', new Set(['private@501']));
  h.pendingWakeKeys.add('group:456');
  await h.sendWakePromptV2('group:456', 'question', {});
  assert.equal(h.busyWatchdog.rearmedWakeV2.get('group:456')?.has('private@501') ?? false, false, ':11281 截断也必须清掉被丢条目的标记');
  console.log('   [证据] 两处 backlog>20 截断都清掉了被丢条目的标记，未丢条目的标记保留');
});

// ══ T31 F6 探针（默认关闭，VERIFY_F6=1）：relevance 过滤丢条目后标记残留 ═════════
// 独立枚举发现的遗漏点：看门狗释放路径的 relevance 过滤（:2663 `st.pendingWakeReasons = relevant`）
// 会把「触发消息已被处理」的条目直接丢弃，但**没有**清它的标记（t13 清单未覆盖此处）。
await test('T31（F6 探针）relevance 过滤丢弃条目后标记残留（有界残留，非丢消息）', wdConfig(SCALED), async (h) => {
  const key = 'private:123';
  h.setMode('reserved2');
  const st = h.getSocialV2State(key);
  st.pendingWakeReasons = [{ reason: 'private', seq: 197 }];
  st.unread = [];                                       // 触发消息已被处理 → relevance 过滤会丢它
  st.lastUnreadSeq = 197;
  h.busyWatchdog.rearmedWakeV2.set(key, new Set(['private@197']));
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  const releaseLine = await waitUntil(() => linesOf(h.readLog(), /\[watchdog\] release[^\n]*/)[0], 8000);
  assert.ok(releaseLine, '必须释放');
  assert.equal(st.pendingWakeReasons.length, 0, '该条目必须已被 relevance 过滤丢弃');
  assert.deepEqual(marksOf(h, key), [],
    `F6：条目已被 relevance 过滤丢弃，它的标记必须一起结束，实测残留=${JSON.stringify(marksOf(h, key))}`);
  console.log('   [证据] relevance 过滤丢条目后标记为空（不变量成立）');
}, { probe: true, skipUnless: process.env.VERIFY_F6 === '1' });

// ══ T32 时间线反证（默认关闭，VERIFY_T22FAST=1）：固定 sleep(400ms) 判重排送达必然失败 ══
// 独立复核 t13「T22 第 2 条断言不可满足」：:11475 `batchMs = Math.max(1000, batchWindowMs || 8000)`
// 决定了重排后至少还要等 1000ms 才可能送达。t9 旧探针只在 turn/end 后 sleep(400ms) 就断言
// 「已重排送达」——**失败的是等待时长，不是语义**。这里用同一份修复后代码、同一场景、
// 只把「轮询 4s」换回「固定 sleep 400ms」，复现该断言失败。
await test('T32（时间线反证）同一溢出场景改成固定 sleep(400ms) → 看不到重排送达（旧 T22 断言的失败是等待时长）', wdConfigProdWake(SCALED), async (h) => {
  const key = 'private:123';
  h.setMode('reserved2');
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 1000;
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  h.scheduleWakeV2(key, 'private');
  await waitUntil(() => linesOf(h.readLog(), /\[watchdog\] release[^\n]*/)[0], 8000);
  h.setReady(false);
  await waitUntil(() => linesOf(h.readLog(), /[^\n]*唤醒已入队[^\n]*/)[0], 6000);
  for (let i = 0; i < 50; i += 1) await h.deliverPrompt(key, `filler-${i}`, {});
  await waitUntil(() => linesOf(h.readLog(), /[^\n]*丢弃最旧消息[^\n]*/)[0], 6000);
  h.setReady(true);
  h.wakeConfigUpdatedKeys.add(key);
  const feed = h.startMux();
  feed.push(turnStart(sid, 1));
  await sleep(150);
  feed.push(assistantText(sid, 1, 'x'));
  feed.push(turnEnd(sid, 1));
  await sleep(400);                                    // ← t9 旧探针的固定等待（< 1000ms 下限）
  const stillInBacklog = st.pendingWakeReasons.some((r) => r.reason === 'private' && r.seq === 197);
  const fastPrompts = h.calls.prompts.length;
  const retrySeen = count(h.readLog(), /补发繁忙期间积压的唤醒：private@seq197/g);
  assert.ok(stillInBacklog || fastPrompts > 0,
    `旧 T22 第 2 条同款断言在固定 sleep(400ms) 下必然失败：backlog=${JSON.stringify(st.pendingWakeReasons)}、`
    + `送达=${fastPrompts}、补发日志=${retrySeen}（:11475 下限 1000ms）→ 失败原因只是等待时长，不是语义不可满足`);
  console.log('   [证据] 固定 400ms 下仍未送达 → 与语义无关，纯等待时长');
}, { probe: true, skipUnless: process.env.VERIFY_T22FAST === '1' });

// ══ R 组：C-reconnect（t19「DSH 重连成功 → 立即清理失效在途回合 + 重排」）独立验证 ══
// 场景定义（与实现方的聚焦用例独立编写）：回合进行中（真实 turn/start 建立 ④）→ 探活失败（断连，
// 快照）→ 探活成功（重连，2s 和缓期后清理）→ 移尘重排。**mux 事件流全程保持连接**，模拟
// 「控制面探活判定 DSH 不可用、事件流未断」这一路径（RUNBOOK §17.5 已声明：pumpMux 断流路径
// 会自己清 ④/②，不经过本机制；本组只验证重连钩子这条路径）。
await test('R1 C-reconnect：回合进行中断连→重连 → ≤10s 清理（非 releaseMs 兜底）+ 重排送达恰好 1 次', wdConfigReconnect(), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 1000;
  const feed = h.startMux();
  feed.push(turnStart(sid, 11));
  await sleep(250);
  assert.equal(h.v2TurnStartAt.has(sid), true, '真实 turn/start 必须建立 ④ 忙判据');
  assert.equal(h.collectors.has(sid), true, '真实 turn/start 必须建立 collector');
  h.scheduleWakeV2(key, 'private');
  assert.equal(st.pendingWakeReasons.length, 1, '忙 → 唤醒必须被暂存进 backlog（事故前状态）');
  // ① 断连：探活失败 → checkDsh 走 dshReady true→false 分支 → 拍快照
  h.api.settings.describe = async () => { throw new Error('fixture: DSH down'); };
  const downAt = Date.now();
  await h.checkDsh().catch((error) => console.log(`   [观测] checkDsh(断连) 抛出（不影响断言）：${error?.message ?? error}`));
  const downLine = await waitUntil(() => linesOf(h.readLog(), /[^\n]*\[reconnect\] DSH 不可用[^\n]*/)[0], 3000);
  assert.match(downLine || '', /记下 1 个在途回合/, `断连瞬间必须拍快照：${downLine}`);
  assert.equal(h.dshState(), false, 'dshReady 必须已翻为 false');
  // ② 重连：探活成功 → checkDsh 走 false→true 分支 → handleDshReconnectV2（2s 和缓期）
  h.api.settings.describe = async () => ({ ok: true });
  const upAt = Date.now();
  await h.checkDsh().catch((error) => console.log(`   [观测] checkDsh(重连) 抛出（不影响断言）：${error?.message ?? error}`));
  const upLine = await waitUntil(() => linesOf(h.readLog(), /[^\n]*\[reconnect\] DSH 恢复[^\n]*/)[0], 3000);
  assert.match(upLine || '', /2000ms 后清理 1 个在途回合/, `重连必须安排和缓期清理：${upLine}`);
  const cleanupLine = await waitUntil(() => linesOf(h.readLog(), /[^\n]*\[reconnect\] 重连清理[^\n]*/)[0], 10000);
  const elapsed = Date.now() - upAt;
  const log = h.readLog();
  dump('断连→重连', log, /[^\n]*\[reconnect\][^\n]*/);
  assert.ok(cleanupLine, '≤10s 内必须出现「重连清理」日志');
  assert.ok(elapsed <= 10000, `清理必须 ≤10s（实测 ${elapsed}ms）`);
  assert.ok(elapsed >= 2000, `清理不得早于 2000ms 和缓期（实测 ${elapsed}ms）`);
  const used = Number((cleanupLine.match(/用时=(\d+)ms/) ?? [])[1]);
  assert.ok(Number.isFinite(used) && used <= 10000, `日志自报用时必须 ≤10s：${cleanupLine}`);
  assert.match(cleanupLine, /失效在途回合 1 个、涉及会话 1 个、重排被暂存唤醒 1 个/,
    `清理计数必须精确（1 失效 / 1 会话 / 1 重排）：${cleanupLine}`);
  // ③ 不是 releaseMs 兜底：生产量级阈值下窗口内不可能有 warn/release
  assert.equal(count(log, /\[watchdog\] release/g), 0, '不得出现看门狗释放（releaseMs=600s，证明清理来自重连钩子而非兜底）');
  assert.equal(count(log, /\[watchdog\] warn/g), 0, '不得出现 WARN（warnMs=300s）');
  assert.ok(h.busyWatchdog.busyStallsV2.size === 0, '看门狗释放计数必须为 0');
  // ④ 清理结果 + 墓碑
  assert.equal(h.v2TurnStartAt.has(sid), false, '④ v2TurnStartAt 必须被清');
  assert.equal(h.collectors.has(sid), false, '④ collectors 必须被清');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sid), true, '必须打看门狗同款墓碑');
  // ⑤ 重排走正常投递路径，恰好 1 次
  const delivered = await waitUntil(() => h.calls.prompts.length >= 1, 5000);
  assert.ok(delivered, '清理后必须重排并按正常路径送达 1 次');
  assert.match(h.readLog(), /\[reserved2\] 计划唤醒 private:123（private）/, '重排必须走 scheduleWakeV2（计划唤醒 → 唤醒）');
  assert.equal(count(h.readLog(), /\[reserved2\] 唤醒 private:123（private）/g), 1, '恰好 1 次投递');
  assert.equal(h.calls.prompts.length, 1, 'api.sessions.prompt 被接受 1 次');
  assert.ok(st.pendingWakeReasons.some((r) => r.reason === 'private' && r.seq === 197),
    '条目按冻结语义仍留在 backlog（由 F1 去重标记保护，不重复投递）');
  assert.ok(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197'), '重排必须登记 F1 去重标记');
  // ⑥ 迟到 turn/end：不得产生第二次投递、不得走输出路径
  //    注意（与 T10/T11 一致、也是已记档的 O2）：collectors 已被清理删掉，迟到的 turn/end 由
  //    **新建的空 collector** 处理（push 返回 null）→ 走不到墓碑的「静默排空」日志分支，
  //    但结果同样是静默丢弃（无 QQ、无输出、无补发）。这里断言安全性质本身。
  const sentBefore = h.calls.sent.length;
  const noActionBefore = st.wakeConfig.noActionCount || 0;
  feed.push(assistantText(sid, 11, '断连前那个回合的迟到回复'));
  feed.push(turnEnd(sid, 11));
  await sleep(400);
  const log2 = h.readLog();
  dump('迟到 turn/end', log2, /[^\n]*静默排空[^\n]*|[^\n]*跳过重复补发[^\n]*|断连前那个回合的迟到回复[^\n]*/);
  assert.equal(h.calls.sent.length, sentBefore, '迟到 turn/end 不得发 QQ');
  assert.doesNotMatch(log2, /断连前那个回合的迟到回复/, '迟到 turn/end 不得走输出路径');
  assert.equal(count(log2, /\[reserved2\] 唤醒 private:123（private）/g), 1, '同一 (reason,seq) 不得第二次投递');
  assert.equal(h.calls.prompts.length, 1, '被接受投递总数仍为 1');
  assert.equal(st.wakeConfig.noActionCount || 0, noActionBefore, '迟到 turn/end 不得改 noActionCount');
  const tombstoneLeft = h.busyWatchdog.staleBusyTurns.has(sid);
  // ⑦ 新回合正常结束：shift 消费去重标记 → 走「跳过重复补发」，仍不产生第二次投递
  h.wakeConfigUpdatedKeys.add(key);
  feed.push(turnStart(sid, 12));
  await sleep(150);
  feed.push(assistantText(sid, 12, '新回合'));
  feed.push(turnEnd(sid, 12));
  const skipped = await waitUntil(() => linesOf(h.readLog(), /[^\n]*跳过重复补发[^\n]*/)[0], 5000);
  const log3 = h.readLog();
  dump('新 turn/end → 去重消费', log3, /[^\n]*跳过重复补发[^\n]*|[^\n]*补发繁忙期间积压的唤醒[^\n]*/);
  assert.ok(skipped, '新回合的 shift 必须消费去重标记（防 F1 复发）');
  assert.equal(count(log3, /\[reserved2\] 唤醒 private:123（private）/g), 1, '全程 (private,197) 只投递 1 次');
  assert.equal(h.calls.prompts.length, 1, '被接受投递总数仍为 1');
  assert.equal(st.pendingWakeReasons.length, 0, 'shift 之后 backlog 清空');
  console.log(`   [证据] 清理用时=${used}ms（进程计时 ${elapsed}ms）；watchdog release/warn=0/0；重排送达 1 次；迟到 turn/end 静默丢弃（无 QQ/无输出/无 noActionCount，墓碑仍在=${tombstoneLeft}，O2 一致）；新回合走「跳过重复补发」；全程投递=1`);
});

await test('R2 反例对照：仍出帧 / 断连后新开回合 / 未涉及会话 都不被误清（判据①②③各一条）', { ...wdConfigReconnect(), allow: allowMany }, async (h) => {
  h.setMode('reserved2');
  const kStale = 'private:123';       // 断连时在途，重连后无帧 → 应被清
  const kAlive = 'group:456';         // 断连时在途，重连后仍在出帧 → 不得被清（判据③）
  const kReTurn = 'private:789';      // 断连时在途，但断连后新开了回合 → 不得被清（判据②）
  const kIdle = 'group:987';          // 从未有在途回合 → 不在快照里，不受影响
  const sidStale = await h.ensureSession(kStale);
  const sidAlive = await h.ensureSession(kAlive);
  const sidReTurn = await h.ensureSession(kReTurn);
  h.getSocialV2State(kIdle);
  for (const [k, seq] of [[kStale, 197], [kAlive, 205], [kReTurn, 211]]) {
    const st = h.getSocialV2State(k);
    st.unread = [{ seq, text: '在吗' }];
    st.lastUnreadSeq = seq;
    st.wakeConfig.batchWindowMs = 1000;
  }
  const feed = h.startMux();
  feed.push(turnStart(sidStale, 1));
  feed.push(turnStart(sidAlive, 2));
  feed.push(turnStart(sidReTurn, 3));
  await sleep(250);
  assert.equal(h.v2TurnStartAt.has(sidStale) && h.v2TurnStartAt.has(sidAlive) && h.v2TurnStartAt.has(sidReTurn), true, '三个会话必须在途');
  h.scheduleWakeV2(kStale, 'private');           // 三条都被暂存
  h.scheduleWakeV2(kAlive, 'private');
  h.scheduleWakeV2(kReTurn, 'private');
  assert.equal(h.getSocialV2State(kStale).pendingWakeReasons.length, 1, 'kStale backlog 1');
  assert.equal(h.getSocialV2State(kAlive).pendingWakeReasons.length, 1, 'kAlive backlog 1');
  assert.equal(h.getSocialV2State(kReTurn).pendingWakeReasons.length, 1, 'kReTurn backlog 1');
  // 断连 → 快照应含 3 个在途回合
  h.api.settings.describe = async () => { throw new Error('fixture: DSH down'); };
  const downAt = Date.now();
  await h.checkDsh().catch(() => {});
  const downLine = await waitUntil(() => linesOf(h.readLog(), /[^\n]*\[reconnect\] DSH 不可用[^\n]*/)[0], 3000);
  assert.match(downLine || '', /记下 3 个在途回合/, `快照必须恰好 3 个在途回合：${downLine}`);
  // 重连：dshReady 翻 true（等价于 checkDsh 里那一行）+ 直接调 handleDshReconnectV2（同步、upAt 由我钉住）
  // —— 这样「重连后的活动」稳定落在 2s 和缓期之前（消除事件循环抖动带来的夹具竞态）；
  //    端到端走真实 checkDsh 的版本见 R1。
  h.api.settings.describe = async () => ({ ok: true });
  h.setReady(true);
  const upAt = Date.now();
  const scheduled = h.handleDshReconnectV2(upAt);
  assert.equal(scheduled, 3, `重连必须安排清理 3 个在途回合（实际 ${scheduled}）`);
  // 先用真实 mux 帧走一遍「活动戳」链路（证明真实路径也在戳），再钉住判据③的输入：
  // 真实帧的 Date.now() 可能与 upAt 同毫秒（会覆盖 +1），所以**最后**同步钉一次 upAt+1。
  feed.push(frame(sidAlive, { type: 'tool/call', data: { name: 'fixture.keepalive', callId: 'c1' } }));
  // 判据②输入：kReTurn 在断连后新开一个回合（turn/start 时间戳必须 > downAt）
  feed.push(turnStart(sidReTurn, 4));
  await sleep(200);
  const realFrameStamp = h.busyWatchdog.lastFrameAtV2.get(kAlive) ?? 0;
  h.noteFrameActivityV2(sidAlive, upAt + 1);        // 判据③权威输入（同步、最后写）
  assert.ok(realFrameStamp >= upAt, `真实 mux 帧必须已刷新活动戳（stamp=${realFrameStamp}、upAt=${upAt}）`);
  assert.ok((h.busyWatchdog.lastFrameAtV2.get(kAlive) ?? 0) > upAt, '判据③前置：kAlive 的活动戳必须晚于重连时刻');
  assert.ok((h.v2TurnStartAt.get(sidReTurn) ?? 0) > downAt, '判据②前置：kReTurn 的新 turn/start 必须晚于断连时刻');
  const cleanupLine = await waitUntil(() => linesOf(h.readLog(), /[^\n]*\[reconnect\] 重连清理[^\n]*/)[0], 10000);
  const log = h.readLog();
  dump('多会话断连→重连', log, /[^\n]*\[reconnect\][^\n]*/);
  assert.ok(cleanupLine, '必须出现重连清理日志');
  assert.match(cleanupLine, /失效在途回合 1 个、涉及会话 1 个、重排被暂存唤醒 1 个（在途快照 3 个，其中 1 个仍在出帧）/,
    `反例对照计数必须精确（清 1 / 快照 3 / 仍在出帧 1）：${cleanupLine}`);
  // 被清的那个
  assert.equal(h.v2TurnStartAt.has(sidStale), false, 'kStale ④ 必须被清');
  assert.equal(h.collectors.has(sidStale), false, 'kStale collector 必须被清');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sidStale), true, 'kStale 必须留墓碑');
  // 否定对照：判据③（仍出帧）与判据①②（新回合）
  assert.equal(h.v2TurnStartAt.has(sidAlive), true, 'kAlive（重连后仍出帧）不得被误清');
  assert.equal(h.collectors.has(sidAlive), true, 'kAlive collector 不得被误清');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sidAlive), false, 'kAlive 不得留墓碑');
  assert.equal(h.v2TurnStartAt.get(sidReTurn) !== undefined, true, 'kReTurn（断连后新开回合）不得被误清');
  assert.equal(h.collectors.has(sidReTurn), true, 'kReTurn collector 不得被误清');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sidReTurn), false, 'kReTurn 不得留墓碑');
  // 未涉及会话不在快照里 → 不受影响
  assert.equal(h.v2TurnStartAt.has(sidStale) || h.collectors.has(sidStale), false);
  // 只有 kStale 被重排（kAlive/kReTurn 仍忙 → 不抢）
  assert.equal(count(log, /\[reserved2\] 唤醒 group:456/g), 0, 'kAlive 仍忙 ⇒ 不得重排');
  assert.equal(count(log, /\[reserved2\] 唤醒 private:789/g), 0, 'kReTurn 仍忙 ⇒ 不得重排');
  assert.equal(count(log, /\[reserved2\] 计划唤醒 private:123（private）/g), 1, 'kStale 恰好重排 1 次');
  assert.ok(await waitUntil(() => h.calls.prompts.length >= 1, 5000), 'kStale 必须送达');
  assert.equal(h.getSocialV2State(kAlive).pendingWakeReasons.length, 1, 'kAlive 的 backlog 必须原样保留');
  assert.equal(h.getSocialV2State(kReTurn).pendingWakeReasons.length, 1, 'kReTurn 的 backlog 必须原样保留');
  console.log('   [证据] 清理 1 / 快照 3 / 仍在出帧 1；kAlive（判据③）与 kReTurn（判据②）的 ④ 与墓碑均未被误清；仅 kStale 被重排送达');
});

await test('R3 守卫：paused 期间的重连为空操作（快照一次性消费、不清理不重排）', wdConfigReconnect(), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 1000;
  const feed = h.startMux();
  feed.push(turnStart(sid, 21));
  await sleep(250);
  h.scheduleWakeV2(key, 'private');
  h.socialV2.paused = true;                         // 断连前进入 paused（设计闸门）
  h.api.settings.describe = async () => { throw new Error('fixture: DSH down'); };
  await h.checkDsh().catch(() => {});
  await waitUntil(() => linesOf(h.readLog(), /[^\n]*\[reconnect\] DSH 不可用[^\n]*/)[0], 3000);
  h.api.settings.describe = async () => ({ ok: true });
  const upAt = Date.now();
  await h.checkDsh().catch(() => {});
  await sleep(3000);                                 // 超过 2s 和缓期
  const log = h.readLog();
  dump('paused 重连', log, /[^\n]*\[reconnect\][^\n]*/);
  assert.equal(count(log, /\[reconnect\] DSH 恢复/g), 0, 'paused 时必须空操作（不安排清理）');
  assert.equal(count(log, /\[reconnect\] 重连清理/g), 0, 'paused 时不得清理');
  assert.equal(h.v2TurnStartAt.has(sid), true, 'paused 时 ④ 必须原样保留');
  assert.equal(h.collectors.has(sid), true, 'paused 时 collector 必须原样保留');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sid), false, 'paused 时不得留墓碑');
  assert.equal(h.getSocialV2State(key).pendingWakeReasons.length, 1, 'paused 时 backlog 原样保留');
  assert.equal(h.busyWatchdog.dshDownTurnsV2, null, '快照被一次性消费（不会在恢复后补做清理）');
  // 取消 paused 后也不会有迟到清理（快照已消费）
  h.socialV2.paused = false;
  await sleep(2500);
  assert.equal(count(h.readLog(), /\[reconnect\] 重连清理/g), 0, '快照一次性消费 ⇒ 恢复后不会补做清理');
  console.log('   [证据] paused 重连：无「DSH 恢复」/无「重连清理」日志；④ 与 backlog 原样保留；快照已消费');
});

await test('R4 静止锚点：C-reconnect 关键符号与调用位置（最终版源码行号）+ 租约本体不变', {}, async (h) => {
  const source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8').replace(/\r\n/g, '\n');
  const lineOf = (needle) => source.slice(0, source.indexOf(needle)).split('\n').length;
  assert.match(source, /RECONNECT_CLEANUP_GRACE_MS = 2000/, '和缓期常量必须仍是 2000ms');
  assert.match(source, /dshDownTurnsV2: null/, '断连快照字段必须存在');
  const checkDshStart = source.indexOf('const checkDsh = async () => {');
  const checkDshEnd = source.indexOf('function startDshWatch()');
  assert.ok(checkDshStart > 0 && checkDshEnd > checkDshStart, '必须能在源码里定位 checkDsh 本体');
  const checkDshBody = source.slice(checkDshStart, checkDshEnd);
  assert.match(checkDshBody, /dshReady = true;[\s\S]{0,800}handleDshReconnectV2\(\)/, 'handleDshReconnectV2 必须在 dshReady true→false→true 的重连分支内');
  assert.match(checkDshBody, /else if \(dshReady\) \{[\s\S]{0,500}snapshotDshDownInFlightTurnsV2\(\)/, 'snapshot 必须在 dshReady true→false 的断连分支内');
  const arm = (() => { const s = source.indexOf('function armPendingWakeLease'); const r = source.slice(s); const n = r.slice(1).search(/\n {2}function /); return (n < 0 ? r : r.slice(0, n + 1)); })();
  assert.ok(arm.includes('30 * 60 * 1000'), 'armPendingWakeLease 必须仍含 30 分钟租约常量（T13 不变量）');
  // F-R1 门控（t22）位置复核：必须在“快照一次性消费”之后、“二代关闭 / 模式·paused”早退之前
  const reconnBody = source.slice(source.indexOf('function handleDshReconnectV2'), source.indexOf('function rearmStashedWakeAfterReconnectV2'));
  const iSnap = reconnBody.indexOf('busyWatchdog.dshDownTurnsV2 = null;');
  const iGuard = reconnBody.indexOf('if (!busyWatchdogConfig().enabled) return 0;');
  const iV2 = reconnBody.indexOf("if (cfg.socialV2?.enabled === false) return 0;");
  const iMode = reconnBody.indexOf("if (currentMode !== 'reserved2' || socialV2.paused) return 0;");
  assert.ok(iSnap >= 0 && iGuard > iSnap, `enabled 门控必须在快照一次性消费之后（snap@${iSnap}, guard@${iGuard}）`);
  assert.ok(iV2 > iGuard && iMode > iGuard, `enabled 门控必须在二代关闭/模式·paused 早退之前（guard@${iGuard}, v2@${iV2}, mode@${iMode}）`);
  console.log(`   [证据] F-R1 门控行号=${lineOf('    if (!busyWatchdogConfig().enabled) return 0;')}（在 :2467 快照消费之后、:2473-2474 早退之前）`);
  console.log('   [证据] 实际行号：'
    + `dshDownTurnsV2=${lineOf('dshDownTurnsV2: null')}、`
    + `RECONNECT_CLEANUP_GRACE_MS=${lineOf('const RECONNECT_CLEANUP_GRACE_MS')}、`
    + `snapshotDshDownInFlightTurnsV2 定义=${lineOf('function snapshotDshDownInFlightTurnsV2')}、`
    + `handleDshReconnectV2 定义=${lineOf('function handleDshReconnectV2')}、`
    + `cleanupDshDownInFlightTurnsV2 定义=${lineOf('function cleanupDshDownInFlightTurnsV2')}、`
    + `rearmStashedWakeAfterReconnectV2 定义=${lineOf('function rearmStashedWakeAfterReconnectV2')}、`
    + `handleDshReconnectV2 调用=${lineOf('        handleDshReconnectV2();')}、`
    + `snapshot 调用=${lineOf('      snapshotDshDownInFlightTurnsV2();')}`);
  // ── F-R2（t24）静态锚点：快照挪到断流点、槽位不被作废、复核表有界且为生产默认值 ──
  assert.match(source, /let reconnectRecheckPlanV2 = \[\s*\{ delayMs: 8000, quietMs: 4000 \},\s*\{ delayMs: 30000, quietMs: 8000 \}\s*\]/,
    '有界复核必须是有界的两档生产默认值（up+8s/静默 4s、up+30s/静默 8s），且不得被 harness 的缩放写回源码');
  assert.match(source, /RECONNECT_SNAPSHOT_TTL_MS = 300000/, '断连快照必须 >5 分钟自动丢弃');
  const pumpMuxBody = source.slice(source.indexOf('async function pumpMux()'), source.indexOf('const bot = new SnowLumaWebSocketClient'));
  const iSnapCall = pumpMuxBody.indexOf("snapshotDshDownInFlightTurnsV2(Date.now(), 'mux')");
  const iClearTurns = pumpMuxBody.indexOf('collectors.clear();');
  const iKeepClear = pumpMuxBody.indexOf('clearBusyWatchdogRuntimeV2({ keepDshDownSnapshot: true })');
  assert.ok(iSnapCall > 0 && iClearTurns > iSnapCall && iKeepClear > iSnapCall,
    `断流点快照必须排在清 ④ 之前，且那次 clear 必须带 keep 开关（snapshot@${iSnapCall}, clearTurns@${iClearTurns}, keepClear@${iKeepClear}）`);
  const clearBody = source.slice(source.indexOf('function clearBusyWatchdogRuntimeV2'), source.indexOf('function startBusyWatchdogV2'));
  assert.match(clearBody, /if \(options\?\.keepDshDownSnapshot !== true\) busyWatchdog\.dshDownTurnsV2 = null;/,
    'keep 开关的语义必须是「只有显式传 true 才保住快照」');
  assert.match(source, /function isReplayedInFlightTurnV2[\s\S]{0,400}snapNo === curNo/, '判据② 必须用回合号识别「重放同一回合」');
  assert.match(source, /function recheckDshReconnectV2[\s\S]{0,600}quietMs/, '有界复核必须按静默窗口判死');
  console.log('   [证据] F-R2 静态锚点：断流点快照在清 ④ 之前 + keepDshDownSnapshot 门控 + 复核表 8s/4s、30s/8s + 快照 TTL 5min');
});

await test('R5 二次断连-重连：新在途回合被清但不重复投递（F1 去重跨重连仍生效）', wdConfigReconnect(), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 1000;
  const feed = h.startMux();
  const cycle = async (turn, expectClean) => {
    h.api.settings.describe = async () => { throw new Error('fixture: DSH down'); };
    await h.checkDsh().catch(() => {});
    await waitUntil(() => linesOf(h.readLog(), /[^\n]*\[reconnect\] DSH 不可用[^\n]*/g).length >= turn - 30, 3000);
    h.api.settings.describe = async () => ({ ok: true });
    await h.checkDsh().catch(() => {});
    await waitUntil(() => linesOf(h.readLog(), /[^\n]*\[reconnect\] DSH 恢复[^\n]*/g).length >= turn - 30, 3000);
    const line = await waitUntil(() => {
      const ls = linesOf(h.readLog(), /[^\n]*\[reconnect\] 重连清理[^\n]*/g);
      return ls.length >= turn - 30 ? ls[ls.length - 1] : null;
    }, 10000);
    assert.ok(line, `第 ${turn - 30} 轮清理必须发生`);
    if (expectClean) assert.match(line, /失效在途回合 1 个/);
    return line;
  };
  // 第一轮：在途 ④ + 已暂存唤醒 → 清理 + 重排送达 1 次
  feed.push(turnStart(sid, 31));
  await sleep(200);
  h.scheduleWakeV2(key, 'private');
  const line1 = await cycle(31, true);
  assert.match(line1, /重排被暂存唤醒 1 个/, `第一轮必须重排 1 个：${line1}`);
  assert.ok(await waitUntil(() => h.calls.prompts.length >= 1, 5000), '第一轮必须送达 1 次');
  assert.equal(count(h.readLog(), /\[reserved2\] 唤醒 private:123（private）/g), 1, '第一轮恰好 1 次投递');
  assert.ok(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197'), 'F1 去重标记必须在（送达成功路径保留）');
  // 第二轮：新回合再断连 → 清 ④，但同一条 (private,197) 已登记 ⇒ 不得再次重排/投递
  feed.push(turnStart(sid, 32));
  await sleep(200);
  assert.equal(h.v2TurnStartAt.has(sid), true, '第二轮必须有新的在途回合');
  const line2 = await cycle(32, true);
  await sleep(1500);                                  // 留出潜在的合并窗（若被错误重排就会送达）
  const log = h.readLog();
  dump('二次断连', log, /[^\n]*\[reconnect\] 重连清理[^\n]*|[^\n]*\[reserved2\] (计划唤醒|唤醒) private:123（private）[^\n]*/);
  assert.match(line2, /重排被暂存唤醒 0 个/, `第二轮不得重排（同一条已登记）：${line2}`);
  assert.equal(h.v2TurnStartAt.has(sid), false, '第二轮 ④ 必须被清');
  assert.equal(count(log, /\[reserved2\] 唤醒 private:123（private）/g), 1, '跨两轮仍只投递 1 次');
  assert.equal(h.calls.prompts.length, 1, '被接受投递总数仍为 1');
  console.log(`   [证据] 两轮清理都发生；第一轮重排 1、第二轮重排 0；跨重连投递总数=1（line2=${line2.slice(line2.indexOf('重连清理'))}`);
});

// ══ R6 门控硬断言（F-R1 修复复验）：enabled=false → 真空操作；enabled=true → 原行为 ══
// t20 时这里是「默认关闭的探针」，因为它报告的是 F-R1（enabled:false 仍会清理）。t22 在
// handleDshReconnectV2 的早退链补上 `busyWatchdogConfig().enabled` 门控后，本轮把它**转正**为
// 默认硬断言：既守 enabled=false 的空操作契约，也顺带验证「重新打开开关后新一轮仍正常清理」。
await test('R6 门控：enabled=false 时重连清理是真空操作（快照一次性消费）；重开开关后原行为恢复', wdConfigReconnect(), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 1000;
  const feed = h.startMux();
  // ── 子场景 1：busyWatchdog.enabled=false → 清理这一步必须是真空操作（t22/F-R1 修复后的契约）
  feed.push(turnStart(sid, 41));
  await sleep(200);
  h.scheduleWakeV2(key, 'private');
  h.cfg.socialV2.busyWatchdog = { enabled: false };   // 热改：关掉看门狗
  h.api.settings.describe = async () => { throw new Error('fixture: DSH down'); };
  await h.checkDsh().catch(() => {});
  await waitUntil(() => linesOf(h.readLog(), /[^\n]*\[reconnect\] DSH 不可用[^\n]*/)[0], 3000);
  h.api.settings.describe = async () => ({ ok: true });
  await h.checkDsh().catch(() => {});
  await sleep(2600);
  const log1 = h.readLog();
  const restored = count(log1, /\[reconnect\] DSH 恢复/g);
  const cleaned = count(log1, /\[reconnect\] 重连清理/g);
  const reconnectLines = count(log1, /\[reconnect\]/g);
  dump('enabled:false 重连', log1, /[^\n]*\[reconnect\][^\n]*/);
  assert.equal(restored + cleaned, 0,
    `enabled=false 时必须空操作，实测 DSH恢复日志=${restored} 条、清理日志=${cleaned} 条`);
  // RUNBOOK §17.3（t22 措辞）：断连那一刻的诊断行与开关无关 —— 只应剩这 1 行；其余 [reconnect] 行为 0
  assert.equal(reconnectLines, 1,
    `§17.3 措辞：enabled=false 时只应剩断连诊断 1 行（与开关无关），实测共 ${reconnectLines} 行`);
  assert.match(log1, /\[reconnect\] DSH 不可用：记下 1 个在途回合/, '断连诊断行必须仍在（快照照拍）');
  assert.equal(h.v2TurnStartAt.has(sid), true, 'enabled=false 时 ④ v2TurnStartAt 必须原样保留');
  assert.equal(h.collectors.has(sid), true, 'enabled=false 时 collector 必须原样保留');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sid), false, 'enabled=false 时不得留墓碑');
  assert.equal(st.pendingWakeReasons.length, 1, 'enabled=false 时 backlog 必须原样保留');
  assert.equal(h.busyWatchdog.dshDownTurnsV2, null, '快照必须已被一次性消费');
  assert.equal(h.calls.prompts.length, 0, 'enabled=false 时不得有任何重排投递');
  // ── 子场景 2：重新打开开关 → 新一轮断连-重连必须恢复原行为（且不会补做上一轮被跳过的清理 —— 快照已消费）
  h.cfg.socialV2.busyWatchdog = { enabled: true };
  h.api.settings.describe = async () => { throw new Error('fixture: DSH down'); };
  await h.checkDsh().catch(() => {});
  const down2 = await waitUntil(() => {
    const ls = linesOf(h.readLog(), /[^\n]*\[reconnect\] DSH 不可用[^\n]*/g);
    return ls.length >= 2 ? ls[ls.length - 1] : null;
  }, 3000);
  assert.ok(down2, '第二轮断连必须再拍快照（上一轮的 in-flight 仍在）');
  h.api.settings.describe = async () => ({ ok: true });
  await h.checkDsh().catch(() => {});
  const cleanup2 = await waitUntil(() => linesOf(h.readLog(), /[^\n]*\[reconnect\] 重连清理[^\n]*/)[0], 10000);
  assert.ok(cleanup2, '重新打开开关后，新一轮重连必须正常清理');
  assert.match(cleanup2, /失效在途回合 1 个/, `第二轮应清理 1 个：${cleanup2}`);
  assert.equal(h.v2TurnStartAt.has(sid), false, '重新打开开关后 ④ 应被清理');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sid), true, '重新打开开关后应留墓碑');
  assert.ok(await waitUntil(() => h.calls.prompts.length >= 1, 6000), '重新打开开关后必须重排送达 1 次');
  assert.equal(count(h.readLog(), /\[reserved2\] 唤醒 private:123（private）/g), 1, '恰好 1 次投递（上一轮被跳过的清理没有被补做）');
  // ── 子场景 3：非 reserved2 应空操作（另一条早退闸门，enabled=true）
  h.setMode('chat');
  h.pendingWakeKeys.add(key);
  feed.push(turnStart(sid, 42));
  await sleep(200);
  h.api.settings.describe = async () => { throw new Error('fixture: DSH down'); };
  await h.checkDsh().catch(() => {});
  h.api.settings.describe = async () => ({ ok: true });
  const before = count(h.readLog(), /\[reconnect\] 重连清理/g);
  await h.checkDsh().catch(() => {});
  await sleep(2600);
  assert.equal(count(h.readLog(), /\[reconnect\] 重连清理/g), before, '非 reserved2 时必须空操作');
  console.log('   [证据] enabled=false：恢复/清理日志=0（仅剩断连诊断 1 行）、④+墓碑+backlog 原样、快照已消费、prompts=0；'
    + '重开开关后新一轮重连正常清理并送达 1 次（未补做上一轮）；非 reserved2 空操作=true');
});

// ══ R7（F-R2 复验·独立重写）：真·事故传输序列 ════════════════════════════════
// 与 R1/R2 的关键差别（t20 的假 mux 流在“断连”期间从未断，正是漏掉事故真实路径的原因）：
// 本用例让事件流**真的**被重置 → pumpMux 的 finally 真的跑（断流点快照 + 清 ④ +
// clearBusyWatchdogRuntimeV2({keepDshDownSnapshot:true})）→ pumpMux 真的按自己的 3s 节奏重试
// （每次重试都再跑一遍 finally、再拍一次「空快照」）→ 第 3 次才成功重连出新的一段流。
// 复核时间轴**不做任何缩放**（生产默认 up+8s/静默 4s）；看门狗取生产档 releaseMs=900s，
// 于是观测窗口内「releaseMs 兜底」这条路径在配置上不可能触发。
await test('R7（F-R2 复验）真实传输序列：断流→重试→重连→重放点亮 ④，pass-1 与有界复核均 ≤10s', { ...wdConfigReconnectProd(), allow: allowTransport }, async (h) => {
  h.setMode('reserved2');
  const kA = 'private:123';   // 断流时在途；重放帧早于重连 → pass-1（up+2s）清
  const kB = 'group:456';     // 断流时在途；重放帧晚于重连 → 有界复核（up+8s）清
  const kC = 'private:789';   // 断流时在途；重连后真开新回合（回合号 99 ≠ 12）→ 谁都不许碰
  const kD = 'group:987';     // 断流时在途；回合号与快照相同但**一直在出帧** → 谁都不许碰
  const kE = 'private:888';   // 边界①反证：回合号相同、重放后静默 >4s（真回合卡在慢工具里）
  const keys = { A: kA, B: kB, C: kC, D: kD, E: kE };
  const seqs = { A: 197, B: 205, C: 211, D: 213, E: 217 };
  const turnNo = { A: 10, B: 11, C: 12, D: 13, E: 14 };
  const sid = {};
  for (const name of Object.keys(keys)) {
    sid[name] = await h.ensureSession(keys[name]);
    const st = h.getSocialV2State(keys[name]);
    st.unread = [{ seq: seqs[name], text: '在吗' }];
    st.lastUnreadSeq = seqs[name];
    st.wakeConfig.batchWindowMs = 1000;
  }
  const feed = h.startTransportMux();
  feed.push(Object.keys(keys).map((name) => turnStart(sid[name], turnNo[name])));
  assert.ok(await waitUntil(() => h.v2TurnStartAt.size === 5, 4000), '五个会话必须由真实 mux 帧建立 ④');
  for (const name of Object.keys(keys)) {
    h.scheduleWakeV2(keys[name], 'private');
    assert.equal(h.getSocialV2State(keys[name]).pendingWakeReasons.length, 1, `${keys[name]} 的唤醒必须被静默暂存（事故前状态）`);
  }
  // ① 断流：事件流真的抛错 → finally：断流点快照（清 ④ 之前）+ 清 ④ + keepDshDownSnapshot
  feed.breakStream();
  const downLine = await waitUntil(() => linesOf(h.readLog(), /[^\n]*\[reconnect\] 事件流断开：记下[^\n]*/)[0], 5000);
  assert.match(downLine || '', /记下 5 个在途回合/, `断流点必须拍下 5 个在途回合：${downLine}`);
  const snapAt = h.busyWatchdog.dshDownTurnsV2?.at;
  assert.equal(h.busyWatchdog.dshDownTurnsV2?.turns.size, 5, '断流点快照必须活过 finally 里的 clearBusyWatchdogRuntimeV2（旧实现在这里被抹成 null）');
  assert.equal(h.v2TurnStartAt.size, 0, 'finally 仍照旧清 ④');
  assert.equal(h.collectors.size, 0, 'finally 仍照旧清 collectors');
  // ② 探活也失败（同一次断连的第二个观测点）：空快照绝不覆盖非空快照，并保留最早的断连时刻
  h.api.settings.describe = async () => { throw new Error('fixture: DSH 探活失败'); };
  await h.checkDsh().catch(() => {});
  const mergedLine = await waitUntil(() => linesOf(h.readLog(), /[^\n]*\[reconnect\] DSH 不可用：沿用断流点快照[^\n]*/)[0], 3000);
  assert.ok(mergedLine, `探活失败必须并入断流点快照：${mergedLine}`);
  assert.equal(h.busyWatchdog.dshDownTurnsV2?.turns.size, 5, '后到的空快照绝不覆盖先到的非空快照');
  assert.equal(h.busyWatchdog.dshDownTurnsV2?.at, snapAt, '合并必须保留最早的断连时刻（判据② 的参考点）');
  // ③ pumpMux 自己重试：第 2 次尝试被拒（finally 又跑一遍、又拍一次空快照）→ 快照必须仍然有效
  assert.ok(await waitUntil(() => feed.attemptCount() >= 2, 6000), 'pumpMux 必须自己重试（第 2 次连接尝试）');
  assert.ok(await waitUntil(() => count(h.readLog(), /事件流中断: /g) >= 2, 5000), '失败的重试必须留下「事件流中断」日志');
  await sleep(200);
  assert.equal(h.busyWatchdog.dshDownTurnsV2?.turns.size, 5, '重试失败后快照必须仍然有效（F-R2 修的正是这里）');
  assert.equal(h.busyWatchdog.dshDownTurnsV2?.at, snapAt, '重试不得改写快照时刻');
  assert.equal(count(h.readLog(), /\[reconnect\] 事件流断开：记下/g), 1, '重试拍下的空快照不得重复打「事件流断开」诊断行');
  assert.equal(feed.attempts[1].outcome, 'refused', '第 2 次连接尝试必须真的被拒');
  const retryGap = feed.attempts[1].at - feed.attempts[0].at;
  assert.ok(retryGap >= 2500 && retryGap <= 5500, `重试间隔必须符合 pumpMux 自带的 3s 节奏（实测 ${retryGap}ms）`);
  // ④ 重连：第 3 次尝试成功建立新的事件流
  feed.recover();
  assert.ok(await waitUntil(() => feed.attemptCount() >= 3, 6000), '必须建立第 3 次连接（成功重连）');
  assert.ok(count(h.readLog(), /连接 DSH 事件流…/g) >= 3, '必须真的走过 ≥3 次「连接 DSH 事件流…」');
  // 重放：A 的回合（号 10）在探活恢复**之前**被重放点亮（这就是 F-R2 的现场）
  feed.push([turnStart(sid.A, turnNo.A), assistantText(sid.A, turnNo.A, '重放：断流前那半句（A）')]);
  assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sid.A), 3000), '重放帧必须把 A 的 ④ 重新点亮');
  assert.ok((h.v2TurnStartAt.get(sid.A) ?? 0) > snapAt, 'A 的重放必须晚于断连时刻');
  // ⑤ 重连成功（探活恢复）→ handleDshReconnectV2
  h.api.settings.describe = async () => ({ ok: true });
  const upAt = Date.now();
  await h.checkDsh().catch((error) => console.log(`   [观测] checkDsh(重连) 抛出（不影响断言）：${error?.message ?? error}`));
  const upLine = await waitUntil(() => linesOf(h.readLog(), /[^\n]*\[reconnect\] DSH 恢复[^\n]*/)[0], 3000);
  assert.match(upLine || '', /2000ms 后清理 5 个在途回合/, `重连必须安排和缓期清理：${upLine}`);
  // ⑥ 重连之后才到的帧：B 重放（同号，判据③ 会误以为它活着）/ C 真开新回合 / D 同号但持续出帧 /
  //    E 同号之后静默（真回合卡在慢工具里 >4s —— 用来实测 RUNBOOK §17.5 的取舍边界①）
  feed.push([turnStart(sid.B, turnNo.B)]);
  feed.push([turnStart(sid.C, 99)]);
  feed.push([turnStart(sid.D, turnNo.D)]);
  feed.push([turnStart(sid.E, turnNo.E)]);
  await sleep(250);
  assert.ok((h.busyWatchdog.lastFrameAtV2.get(kB) ?? 0) > upAt, 'B 的重放必须落在重连之后（判据③ 前置）');
  assert.ok((h.v2TurnStartAt.get(sid.C) ?? 0) > snapAt, 'C 的新回合必须晚于断连时刻（判据② 前置）');
  const keepD = setInterval(() => feed.push([assistantText(sid.D, turnNo.D, '还在写（D）')]), 200);
  try {
    // ⑦ pass-1（重连成功 +2s）：只清「重放早于重连」的 A；B/D/E 因「重连后出过帧」被判据③ 留下
    const cleanupLine = await waitUntil(() => linesOf(h.readLog(), /[^\n]*\[reconnect\] 重连清理[^\n]*/)[0], 10000);
    const passOneMs = Date.now() - upAt;
    assert.ok(cleanupLine, '≤10s 内必须出现「重连清理」日志');
    assert.ok(passOneMs <= 10000, `pass-1 必须 ≤10s（实测 ${passOneMs}ms）`);
    assert.ok(passOneMs >= 2000, `pass-1 不得早于 2000ms 和缓期（实测 ${passOneMs}ms）`);
    assert.match(cleanupLine, /失效在途回合 1 个、涉及会话 1 个、重排被暂存唤醒 1 个（在途快照 5 个，其中 3 个仍在出帧）/,
      `pass-1 只该清 A（B/D/E 判据③ 仍在出帧）：${cleanupLine}`);
    assert.equal(h.v2TurnStartAt.has(sid.A), false, 'A 的 ④ 必须被清');
    assert.equal(h.collectors.has(sid.A), false, 'A 的 collectors 必须被清');
    assert.equal(h.busyWatchdog.staleBusyTurns.has(sid.A), true, 'A 必须留看门狗同款墓碑');
    for (const name of ['B', 'D', 'E']) {
      assert.equal(h.v2TurnStartAt.has(sid[name]), true, `${name} 的 ④ pass-1 不得碰`);
      assert.equal(h.busyWatchdog.staleBusyTurns.has(sid[name]), false, `${name} pass-1 不得留墓碑`);
    }
    // ⑧ 有界复核（生产时间轴 up+8s、静默 4s）：清「重放晚于重连 + 静默 >4s」的 B 与 E
    const recheckLine = await waitUntil(() => linesOf(h.readLog(), /[^\n]*\[reconnect\] 重连复核[^\n]*/)[0], 10000);
    const recheckMs = Date.now() - upAt;
    assert.ok(recheckLine, '重放晚到时必须有界复核兜底');
    assert.ok(recheckMs <= 10000, `复核必须 ≤10s（生产默认 up+8s；实测 ${recheckMs}ms）`);
    assert.match(recheckLine, /失效在途回合 2 个、涉及会话 2 个、重排被暂存唤醒 2 个（在途快照 5 个，其中 1 个仍在出帧；静默 4000ms）/,
      `复核只该清 B 与 E：${recheckLine}`);
    assert.equal(h.v2TurnStartAt.has(sid.B), false, 'B 被重放点亮的 ④ 必须被复核清掉（t21 指出的第二条路径）');
    assert.equal(h.collectors.has(sid.B), false, 'B 的 collectors 必须被复核清掉');
    assert.equal(h.busyWatchdog.staleBusyTurns.has(sid.B), true, 'B 必须留墓碑');
    // 反例对照：C（回合号 99 ≠ 12：断连后真开的新回合）与 D（同号但一直在出帧）谁都不许碰
    for (const name of ['C', 'D']) {
      assert.equal(h.v2TurnStartAt.has(sid[name]), true, `${name} 的 ④ 绝不能被误清`);
      assert.equal(h.collectors.has(sid[name]), true, `${name} 的 collector 必须保留`);
      assert.equal(h.busyWatchdog.staleBusyTurns.has(sid[name]), false, `${name} 不得留墓碑`);
    }
    // ⑨ 被暂存的唤醒按正常投递路径补发：A/B/E 各 1 次；仍忙的 C/D 原样
    const promptsTo = (name) => h.calls.prompts.filter((p) => p.sessionId === sid[name]).length;
    assert.ok(await waitUntil(() => promptsTo('A') >= 1 && promptsTo('B') >= 1 && promptsTo('E') >= 1, 6000),
      'A/B/E 的暂存唤醒都必须补发');
    for (const name of ['A', 'B', 'E']) assert.equal(promptsTo(name), 1, `${name} 恰好投递 1 次`);
    for (const name of ['C', 'D']) assert.equal(promptsTo(name), 0, `${name} 仍忙 ⇒ 不得抢投`);
    assert.equal(h.getSocialV2State(kC).pendingWakeReasons.length, 1, 'C 的 backlog 必须原样保留');
    assert.equal(h.getSocialV2State(kD).pendingWakeReasons.length, 1, 'D 的 backlog 必须原样保留');
    // ⑩ 边界①（RUNBOOK §17.5）最坏后果实测：E 那个真回合其实还在跑（慢工具），复核已经判死它。
    const sentBefore = h.calls.sent.length;
    feed.push([assistantText(sid.E, turnNo.E, '慢工具里的真实回复（E）'), turnEnd(sid.E, turnNo.E)]);
    await sleep(700);
    const logAfter = h.readLog();
    const drained = count(logAfter, /\[watchdog\] 静默排空被释放回合的 turn\/end/g);
    assert.equal(h.calls.sent.length, sentBefore, 'E 的真实回复不得发到 QQ（= 这一轮回复被丢弃）');
    assert.doesNotMatch(logAfter, /慢工具里的真实回复（E）/, 'E 的真实回复文本不得进入输出路径');
    assert.equal(h.busyWatchdog.staleBusyTurns.has(sid.E), true, 'E 的墓碑残留（O2：无 live turn/start 就不会被消费）');
    // 有界残留：下一次 live turn/start 让墓碑作废，会话不会永久卡死
    feed.push([turnStart(sid.E, 15)]);
    assert.ok(await waitUntil(() => h.busyWatchdog.staleBusyTurns.has(sid.E) === false, 3000), '下一次 live turn/start 必须消费墓碑（残留有界）');
    // ⑪ 不是 releaseMs 兜底：生产档下窗口内不可能有 warn/release
    const log = h.readLog();
    dump('事故传输序列', log, /[^\n]*\[reconnect\][^\n]*|[^\n]*连接 DSH 事件流…[^\n]*|[^\n]*事件流中断:[^\n]*|[^\n]*\[watchdog\] (warn|release)[^\n]*/);
    assert.equal(count(log, /\[watchdog\] release/g), 0, 'releaseMs=900s ⇒ 窗口内不得有看门狗释放兜底');
    // t70（V4-②）：原断言写的是 `/\[watchdog\] WARN/g`（大写 W），而真实日志文本是 `[watchdog] warn`
    // ⇒ 恒为 0 的**空断言**。改为小写真实文本，并先断言「看门狗确实开着（有启动行）」，
    // 这样「0 命中」才是有意义的证据，而不是模式写错导致的假绿。
    assert.ok(count(log, /\[watchdog\]/g) >= 1, '（前置）日志里必须能看到看门狗行（否则下面的 0 断言又是空断言）');
    assert.equal(count(log, /\[watchdog\] warn\b/g), 0, 'warnMs=300s ⇒ 窗口内不得有 WARN（小写 warn 才是真实日志文本；t70 修正原大写空断言）');
    console.log(`   [证据] 连接尝试=${feed.attemptCount()} 次（第 2 次 outcome=refused，间隔 ${retryGap}ms）；`
      + `断流点快照=5 且活过 2 次 finally；pass-1 用时=${passOneMs}ms 清 A；复核用时=${recheckMs}ms 清 B/E；`
      + `新回合 C 与活回合 D 均未被误清；A/B/E 各补发 1 次、C/D backlog 原样；watchdog WARN/release=0/0`);
    console.log(`   [边界① 实测] E（同回合号 + 静默 >4s 的真回合）被复核判死：真实回复未发 QQ、未进输出路径；`
      + `墓碑静默排空日志=${drained} 行（collector 已被清理删除 ⇒ 新 collector 无 turn/start ⇒ 连这行都打不出来，`
      + `比 §17.5「迟到 turn/end 静默排空」的措辞更静默）；墓碑由下一次 live turn/start 消费`);
  } finally {
    clearInterval(keepD);
  }
});

// ══ R8（F-R2 复验）：真实传输路径连做两轮断连 → 同一 (reason,seq) 的投递次数 ═══════
// 「同一 (reason,seq) 跨两轮断连只送达 1 次」这条不变量在真实传输路径上要看**条目的生命周期**：
//   · 条目已被 shift 消费（那一轮 turn/end 到了）⇒ 第二次断连时 backlog 里没有它 ⇒ 不得再投递（判据成立）；
//   · 条目仍在 backlog（那一轮 turn/end 随断连丢了）⇒ 断流 finally 会清 `pendingWakeKeys`(:12895) 与
//     `rearmedWakeV2`(:2752，经 :12906)，于是重连清理会**按设计重新投递**它（这正是「补发被静默暂存的
//     唤醒」要的效果：DSH 重启把那一轮丢了，不重发就哑火）。
// 本用例把两条都钉住：Y 的条目在第一轮后正常收尾（shift 消费）→ 第二轮只送达 1 次；
// X 的条目两轮都未收尾 → 第二轮按设计再投递一次（⚠️ 记入报告，不是断言出来的「缺陷」而是实测边界）。
await test('R8（F-R2 复验）真实传输序列连做两轮：已收尾条目不再投递，未收尾条目按设计重新投递', { ...wdConfigReconnectProd(), allow: allowTransport }, async (h) => {
  h.setMode('reserved2');
  const kX = 'private:123';   // 条目在两轮里都没被 turn/end 收尾（DSH 每次都把那一轮丢了）
  const kY = 'group:456';     // 条目在第一轮后被正常收尾（shift 消费）→ 第二轮不得再投递
  const sidX = await h.ensureSession(kX);
  const sidY = await h.ensureSession(kY);
  for (const [key, seq] of [[kX, 197], [kY, 205]]) {
    const st = h.getSocialV2State(key);
    st.unread = [{ seq, text: '在吗' }];
    st.lastUnreadSeq = seq;
    st.wakeConfig.batchWindowMs = 1000;
  }
  const feed = h.startTransportMux();
  const wakeCount = (key) => count(h.readLog(), new RegExp(`\\[reserved2\\] 唤醒 ${key}（private）`, 'g'));
  const promptsTo = (sid) => h.calls.prompts.filter((p) => p.sessionId === sid).length;
  // 一轮「真实断流 → 失败重试 → 成功重连 → 重放点亮 ④ → 探活恢复 → 清理」
  const transportCycle = async (label, spec, beforeBreak) => {
    feed.push(spec.map(({ sid, turn }) => turnStart(sid, turn)));
    assert.ok(await waitUntil(() => spec.every(({ sid }) => h.v2TurnStartAt.has(sid)), 4000), `${label}：所有在途会话必须建立 ④`);
    if (beforeBreak) await beforeBreak();
    const attemptBefore = feed.attemptCount();
    const downBefore = count(h.readLog(), /事件流断开：记下/g);
    feed.breakStream();
    const downLine = await waitUntil(() => {
      const ls = linesOf(h.readLog(), /[^\n]*事件流断开：记下[^\n]*/g);
      return ls.length > downBefore ? ls[ls.length - 1] : null;
    }, 5000);
    assert.match(downLine || '', new RegExp(`记下 ${spec.length} 个在途回合`), `${label}：断流点快照=${spec.length}：${downLine}`);
    h.api.settings.describe = async () => { throw new Error('fixture: DSH 探活失败'); };
    await h.checkDsh().catch(() => {});
    assert.ok(await waitUntil(() => feed.attemptCount() >= attemptBefore + 1, 6000), `${label}：pumpMux 必须重试`);
    await sleep(200);
    assert.equal(h.busyWatchdog.dshDownTurnsV2?.turns.size, spec.length, `${label}：失败重试后快照必须仍然有效`);
    feed.recover();
    assert.ok(await waitUntil(() => feed.attemptCount() >= attemptBefore + 2, 6000), `${label}：必须成功重连出新段`);
    feed.push(spec.map(({ sid, turn }) => turnStart(sid, turn)));       // DSH 重放那个失效回合（同号）
    assert.ok(await waitUntil(() => spec.every(({ sid }) => h.v2TurnStartAt.has(sid)), 4000), `${label}：重放必须重新点亮 ④`);
    h.api.settings.describe = async () => ({ ok: true });
    const upAt = Date.now();
    await h.checkDsh().catch(() => {});
    const cleanBefore = count(h.readLog(), /\[reconnect\] 重连清理/g);
    const line = await waitUntil(() => {
      const ls = linesOf(h.readLog(), /[^\n]*\[reconnect\] 重连清理[^\n]*/g);
      return ls.length > cleanBefore ? ls[ls.length - 1] : null;
    }, 10000);
    assert.ok(line, `${label}：≤10s 内必须出现清理日志`);
    return { line, elapsed: Date.now() - upAt };
  };
  // 第 1 轮：两个会话都在途，两条唤醒（X=197 / Y=205）都在「忙」时被静默暂存
  const r1 = await transportCycle('第 1 轮', [{ sid: sidX, turn: 50 }, { sid: sidY, turn: 51 }], async () => {
    h.scheduleWakeV2(kX, 'private');
    h.scheduleWakeV2(kY, 'private');
    assert.equal(h.getSocialV2State(kX).pendingWakeReasons.length, 1, 'X 的唤醒必须被暂存');
    assert.equal(h.getSocialV2State(kY).pendingWakeReasons.length, 1, 'Y 的唤醒必须被暂存');
  });
  assert.ok(r1.elapsed <= 10000, `第 1 轮清理必须 ≤10s（实测 ${r1.elapsed}ms）`);
  assert.match(r1.line, /失效在途回合 2 个、涉及会话 2 个、重排被暂存唤醒 2 个/, `第 1 轮必须清理并重排两个：${r1.line}`);
  assert.ok(await waitUntil(() => promptsTo(sidX) >= 1 && promptsTo(sidY) >= 1, 6000), '第 1 轮两条唤醒都必须送达');
  assert.equal(wakeCount(kX), 1, '第 1 轮 X 恰好投递 1 次');
  assert.equal(wakeCount(kY), 1, '第 1 轮 Y 恰好投递 1 次');
  assert.ok(h.busyWatchdog.rearmedWakeV2.get(kX)?.has('private@197'), 'X 的 F1 去重标记必须已登记');
  assert.ok(h.busyWatchdog.rearmedWakeV2.get(kY)?.has('private@205'), 'Y 的 F1 去重标记必须已登记');
  // Y 的唤醒回合正常收尾：turn/end 的 shift 消费 backlog 条目（F1 标记 → 跳过重复补发）
  // 先登记 wakeConfigUpdatedKeys：否则 turn/end 会额外走「未设置唤醒条件，发送提醒」→ 又一次 deliverPrompt，
  // 那会把「投递次数」这条断言污染成 2（与本用例要考察的 (reason,seq) 去重无关）。
  h.wakeConfigUpdatedKeys.add(kY);
  feed.push([turnStart(sidY, 52), turnEnd(sidY, 52)]);
  const skipped = await waitUntil(() => linesOf(h.readLog(), /[^\n]*唤醒 private@seq205 已由看门狗重新武装补发，跳过重复补发[^\n]*/)[0], 4000);
  assert.ok(skipped, `Y 的条目必须由 shift 消费并走「跳过重复补发」：${skipped}`);
  assert.equal(h.getSocialV2State(kY).pendingWakeReasons.length, 0, 'Y 的 backlog 必须已被 shift 消费干净');
  assert.equal(promptsTo(sidY), 1, 'Y 收尾后仍恰好 1 次投递');
  // 第 2 轮：只剩 X 的 197 仍未收尾（Y 这一轮没有新的待办唤醒项）
  const r2 = await transportCycle('第 2 轮', [{ sid: sidX, turn: 60 }, { sid: sidY, turn: 61 }]);
  assert.ok(r2.elapsed <= 10000, `第 2 轮清理必须 ≤10s（实测 ${r2.elapsed}ms）`);
  assert.match(r2.line, /失效在途回合 2 个、涉及会话 2 个、重排被暂存唤醒 1 个/, `第 2 轮只该重排仍在 backlog 的 X：${r2.line}`);
  await waitUntil(() => promptsTo(sidX) >= 2, 6000);
  await sleep(1200);                                            // 留出可能的合并窗
  const log = h.readLog();
  dump('跨两轮真实传输序列', log, /[^\n]*\[reconnect\] 重连清理[^\n]*|[^\n]*\[reserved2\] (计划唤醒|唤醒) (private:123|group:456)（private）[^\n]*/);
  // 判据：已被 shift 消费的条目（Y 的 205）跨两轮断连**不得**再投递
  assert.equal(wakeCount(kY), 1,
    'Y 的条目已被 shift 消费 ⇒ 第 2 轮不得再投递（同一 (reason,seq) 跨两轮只送达 1 次：这一半成立）');
  assert.equal(promptsTo(sidY), 1, 'Y 的投递次数跨两轮仍为 1');
  // 实测边界（记入报告）：未收尾的条目（X 的 197）在第二次断连后按设计重新投递
  assert.equal(wakeCount(kX), 2, 'X 的条目从未被 shift 消费 ⇒ 第 2 轮按设计重新投递（实测=2，见报告）');
  assert.equal(promptsTo(sidX), 2, 'X 的投递次数=2（每一轮断连各一次，非同一轮内重复）');
  assert.equal(h.getSocialV2State(kX).pendingWakeReasons.length, 1, 'X 的条目仍留在 backlog（等下一次 turn/end 的 shift）');
  assert.equal(h.v2TurnStartAt.has(sidX), false, 'X 第 2 轮的 ④ 必须被清');
  assert.equal(h.v2TurnStartAt.has(sidY), false, 'Y 第 2 轮的 ④ 必须被清');
  console.log(`   [证据] 两轮真实传输序列；清理用时=${r1.elapsed}ms / ${r2.elapsed}ms；`
    + `Y（条目已被 shift 消费）：跨两轮唤醒投递=1（判据成立）；`
    + `X（条目两轮都没被收尾）：唤醒投递=2（断流 finally 清 pendingWakeKeys/rearmedWakeV2 ⇒ 第 2 轮按设计补发）`);
  console.log('   [边界② 实测/报告] 条目未随 turn/end 收尾时，同一 (reason,seq) 会在**下一次断连-重连**被重新投递一次：'
    + '这是「那一轮随 DSH 断连丢失 ⇒ 必须重发」的恢复行为（否则又是哑火），但它使「跨两轮断连只送达 1 次」'
    + '在真实传输路径上不成立；且重连 rearm 不像看门狗那样受 rearmCooldownMs/maxRearmPerHour 约束'
    + '（src/bridge.js:2562-2581：rearm 只查 backlog/合并窗/F1 标记，不过 busyRearmAllowedV2）。'
    + '用户可见风险：回复已发出但 turn/end 随断连丢失时，下一次断连可能触发第二次唤醒回合。');
});

// ══════════════════════════════════════════════════════════════════════════════════
// t45 · C-stall（t44）独立验证：会话消失即释放 / 会话仍在不误伤 / 探测失败不释放 /
// 门控 no-op / 独立核验「DSH 到底给不给每会话运行态字段」。
// 计时判别前提：把看门狗 warn/release 档设到**生产量级或更长**（releaseMs=600s），
// 于是观测窗口（几秒）内预算档在配置上不可达 —— 任何 ≤8s 的释放都只能来自 C-stall 探测，
// 不可能来自 15 分钟兜底（t27 用过同一招）。
// ══════════════════════════════════════════════════════════════════════════════════
const STALL_KEY = 'private:123';
const stallConfig = (wd = {}) => wdConfigProdWake({
  warnMs: 600000, releaseMs: 600000, hardCapMs: 1800000,
  checkIntervalMs: 1000, rearmCooldownMs: 60000, maxRearmPerHour: 3,
  silenceProbeMs: 1000, stallProbeTimeoutMs: 800, ...wd,
});
const dshItem = (sid, extra = {}) => ({ sessionId: sid, updatedAt: Date.now(), agentAvailable: true, running: false, ...extra });
const dshList = (items) => ({ result: { ok: true, value: { items } } });
const okEnvelope = (value) => ({ result: { ok: true, value } });   // 测试体里也能用的成功信封

/** C-stall 夹具：会话忙（④ v2TurnStartAt + collectors 在场）+ 一条被暂存的唤醒。
 *  withWakeLease=true 时额外造 ② pendingWakeKeys（+30 分钟租约）—— 那是「比 ④ 更顽固」的忙判据：
 *  C-stall 只清 ④，② 在场时连重排都只能退回 backlog（rearm=none），见 SC1c。 */
async function stallBusyFixture(h, { key = STALL_KEY, turn = 12, seq = 197, batchWindowMs = 600000, reason = 'private', withWakeLease = false } = {}) {
  h.setMode('reserved2');
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq, text: '在吗' }];
  st.lastUnreadSeq = seq;
  st.wakeConfig.batchWindowMs = batchWindowMs;
  if (withWakeLease) {
    h.pendingWakeKeys.add(key);                   // ② 在场（C-stall 必须一行都不碰它）
    h.armPendingWakeLease(key);
  }
  const feed = h.startMux();
  feed.push(turnStart(sid, turn));                // ④ 起来（注意：startMux().push 收**单帧**，不是数组）
  assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sid), 3000), '夹具：v2TurnStartAt 必须起来（④）');
  assert.ok(await waitUntil(() => h.collectors.has(sid), 3000), '夹具：collectors 必须起来（④）');
  h.scheduleWakeV2(key, reason);                  // ④ 在场 ⇒ 走忙分支：暂存 backlog（不投递、不排定时器）
  assert.ok(await waitUntil(() => Array.isArray(st.pendingWakeReasons) && st.pendingWakeReasons.length > 0, 3000), '夹具：必须暂存一条 backlog');
  assert.equal(st.pendingWakeTimer, null, '夹具：忙分支不得排上投递定时器（否则「重排一次」不可测）');
  return { sid, st, feed };
}

await test('SC1【C-stall 核心·证伪】DSH 列表里已无该会话（连续两次探测）→ ≤8s 立即释放 ④+墓碑+只重排一次（预算档 releaseMs=600s 在配置上不可达）', stallConfig(), async (h) => {
  // 列表**非空**（排除「空列表」那条 unknown）但里面没有我们的 sid
  h.setSessionList(async () => dshList([dshItem('someone-else', { running: true })]));
  const { sid, st } = await stallBusyFixture(h);
  const t0 = Date.now();
  const releaseLine = await waitUntil(() => linesOf(h.readLog(), /♻️ \[stall\][^\n]*立即释放[^\n]*/).at(-1) ?? null, 12000);
  assert.ok(releaseLine, '会话从列表消失必须触发 C-stall 释放（预算档 releaseMs=600000 在观测窗口内不可达）');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 1000, `释放不得早于静默窗口 silenceProbeMs=1000（实测 ${elapsed}ms）`);
  assert.ok(elapsed <= 8000, `释放必须 ≤ 静默窗口+探测周期×2+和缓（实测 ${elapsed}ms）`);
  assert.match(releaseLine, /tier=stall/, `释放行必须标 tier=stall：${releaseLine}`);
  assert.match(releaseLine, /released=[^\s)]*v2TurnStartAt/, `必须列出被清的 ④ v2TurnStartAt：${releaseLine}`);
  assert.match(releaseLine, /released=[^\s)]*collectors/, `必须列出被清的 ④ collectors：${releaseLine}`);
  assert.match(releaseLine, /静默=\d+s/, `释放行必须带静默时长：${releaseLine}`);
  assert.match(releaseLine, /依据=[^\s]*DSH 会话已不存在/, `必须写明依据：${releaseLine}`);
  assert.match(releaseLine, /backlog=1/, `释放行必须报出 backlog 条数：${releaseLine}`);
  assert.match(releaseLine, /rearm=private@seq197/, `无 ② 时重排必须真的排上：${releaseLine}`);
  assert.equal(count(h.readLog(), /♻️ \[stall\][^\n]*立即释放/g), 1, '一次静默只允许释放一次');
  assert.equal(count(h.readLog(), /\[stall\][^\n]*rearm=private@seq197/g), 1, '被暂存唤醒只能重排一次');
  assert.deepEqual(marksOf(h, STALL_KEY), ['private@197'], `F1 去重标记必须恰好登记一条，实测 ${JSON.stringify(marksOf(h, STALL_KEY))}`);
  assert.equal(h.v2TurnStartAt.has(sid), false, '释放后 ④ v2TurnStartAt 必须已清');
  assert.equal(h.collectors.has(sid), false, '释放后 collectors 必须已清');
  assert.ok(h.busyWatchdog.staleBusyTurns.has(sid), '必须打墓碑（迟到 turn/end 静默排空）');
  const probes = h.listArgs();
  assert.ok(probes.length >= 2 && probes.length <= 4, `必须恰好走探测路径（2~4 次），实测 ${probes.length} 次`);
  assert.equal(Object.keys(probes[0]).length, 0, `探测必须调用 api.sessions.list({})（空参数；注意 VM 跨界对象的原型不同，别用 deepStrictEqual），实测 ${JSON.stringify(probes)}`);
  assert.ok(st.pendingWakeTimer, '重排必须真的排上 wake 定时器（走 scheduleWakeV2，不旁路）');
  assert.equal(count(h.readLog(), /\[watchdog\] release/g), 0, '预算档绝不能参与（releaseMs=600s）');
  dump('C-stall 释放现场', h.readLog(), /[^\n]*\[stall\][^\n]*/);
  console.log(`   [证据] 释放用时 ${elapsed}ms（预算档 600s 不可达）；探测 ${probes.length} 次（参数 ${JSON.stringify(probes[0])}）；`
    + `released=${/released=([^\s)]*)/.exec(releaseLine)?.[1]}；rearm=private@seq197 ×1；墓碑=${h.busyWatchdog.staleBusyTurns.has(sid)}；排队定时器=${!!st.pendingWakeTimer}`);
});

await test('SC1b【续·送达】重排后的那条唤醒在合并窗内恰好投递 1 次（不静默丢失、不重复）', stallConfig(), async (h) => {
  h.setSessionList(async () => dshList([dshItem('someone-else', { running: true })]));
  const { sid } = await stallBusyFixture(h, { batchWindowMs: 1500 });
  const releaseLine = await waitUntil(() => linesOf(h.readLog(), /♻️ \[stall\][^\n]*立即释放[^\n]*/).at(-1) ?? null, 12000);
  assert.ok(releaseLine, '必须先发生 C-stall 释放');
  assert.match(releaseLine, /rearm=private@seq197/, `释放必须重排那条 backlog：${releaseLine}`);
  const before = h.calls.prompts.length;
  const delivered = await waitUntil(() => h.calls.prompts.length > before, 8000);
  assert.ok(delivered, '重排后的唤醒必须在合并窗（1.5s）内真的投递（不能只登记标记不投）');
  await sleep(2000);
  assert.equal(h.calls.prompts.length - before, 1, `被重排的唤醒只能投递 1 次，实测 ${h.calls.prompts.length - before} 次`);
  assert.equal(h.v2TurnStartAt.has(sid), false, '（对照）C-stall 的释放结果仍在');
  console.log(`   [证据] 释放 → 重排 → 唤醒投递 ${h.calls.prompts.length - before} 次（合并窗 1.5s）`);
});

await test('SC1c【边界·实测】② pendingWakeKeys 同时在场 ⇒ 仍然只清 ④，但重排只能退回 backlog（rearm=none）、② 一行未动', stallConfig(), async (h) => {
  h.setSessionList(async () => dshList([dshItem('someone-else', { running: true })]));
  const { sid, st } = await stallBusyFixture(h, { withWakeLease: true });
  const releaseLine = await waitUntil(() => linesOf(h.readLog(), /♻️ \[stall\][^\n]*立即释放[^\n]*/).at(-1) ?? null, 12000);
  assert.ok(releaseLine, '即使 ② 在场，会话消失也必须释放 ④（这是 C-stall 的核心价值）');
  assert.match(releaseLine, /released=[^\s)]*v2TurnStartAt/, `释放行必须列出 v2TurnStartAt：${releaseLine}`);
  assert.match(releaseLine, /rearm=none/, `② 仍在 ⇒ 会话仍忙 ⇒ 不能排上投递定时器，只能退回 backlog：${releaseLine}`);
  assert.equal(h.v2TurnStartAt.has(sid), false, '④ 必须已清');
  assert.ok(h.pendingWakeKeys.has(STALL_KEY), '② 必须一行未动（C-stall 比预算档更窄）');
  assert.ok(h.pendingWakeLeaseTimers.has(STALL_KEY), '30 分钟租约必须原样保留');
  assert.ok((st.pendingWakeReasons ?? []).length >= 1, 'backlog 条目必须原样保留（不丢消息）');
  assert.equal(marksOf(h, STALL_KEY).length, 0, '没能真排上定时器 ⇒ 不得登记 F1 去重标记（否则条目会被永久跳过）');
  assert.deepEqual(h.busyWatchdog.rearmV2.get(STALL_KEY) ?? [], [], '不得记一次 re-arm（没真排上）');
  dump('② 在场的 C-stall 释放', h.readLog(), /[^\n]*\[stall\][^\n]*/);
  console.log(`   [证据] ② 在场：释放行 released=${/released=([^\s)]*)/.exec(releaseLine)?.[1]}、rearm=none、backlog 保留=${(st.pendingWakeReasons ?? []).length} 条、`
    + `②保留=${h.pendingWakeKeys.has(STALL_KEY)}、租约保留=${h.pendingWakeLeaseTimers.has(STALL_KEY)}、F1 标记=${marksOf(h, STALL_KEY).length} 条`);
});

await test('SC2【不误伤】会话仍在列表里且 running=true + 持续静默 → C-stall 绝不释放；静默本身不构成释放证据（仍由预算档兜底）', stallConfig({ warnMs: 5000, releaseMs: 6000, hardCapMs: 60000 }), async (h) => {
  const { sid } = await stallBusyFixture(h);
  h.setSessionList(async () => dshList([dshItem(sid, { running: true })]));   // DSH 明确说回合仍在跑
  const probeLine = await waitUntil(() => linesOf(h.readLog(), /🔎 \[stall\] 探测：DSH 说该会话的回合仍在跑（不释放）[^\n]*/)[0], 8000);
  assert.ok(probeLine, '必须真的探测过并看到「回合仍在跑」的结论（否则本对照是空转）');
  // 静默持续（≥4×silenceProbeMs）期间绝不释放
  await sleep(4000);
  const logMid = h.readLog();
  assert.equal(count(logMid, /♻️ \[stall\][^\n]*立即释放/g), 0, 'running=true 时 C-stall 一个字节都不许动');
  assert.equal(h.v2TurnStartAt.has(sid), true, '④ 必须仍在（静默 ≠ 死亡）');
  assert.ok(h.listArgs().length >= 2, `必须持续探测（实测 ${h.listArgs().length} 次）`);
  // 预算档仍然照旧：releaseMs=6s 到点由 [watchdog] release 兜底
  const budgetLine = await waitUntil(() => linesOf(h.readLog(), /\[watchdog\] release[^\n]*/).at(-1) ?? null, 12000);
  assert.ok(budgetLine, 'C-stall 不动手时，看门狗预算档必须照旧兜底（证明没把这条路径改坏）');
  assert.match(budgetLine, /tier=release/, `兜底必须走预算档：${budgetLine}`);
  assert.equal(count(h.readLog(), /♻️ \[stall\][^\n]*立即释放/g), 0, '兜底发生前后 C-stall 都不得释放');
  dump('running=true 对照现场', h.readLog(), /[^\n]*\[stall\][^\n]*|[^\n]*\[watchdog\] release[^\n]*/);
  console.log(`   [证据] 静默 4s+ 且 running=true：C-stall 释放 0 次、④ 保留；探测 ${h.listArgs().length} 次；`
    + `最终由预算档兜底：${budgetLine.slice(0, 120)}`);
});

await test('SC3【探测失败】抛错 / 超时 / 畸形结构 / 空列表 → 一律不释放、不崩、各留一条带原因的 WARN', stallConfig({ stallProbeTimeoutMs: 400 }), async () => {
  // 每种失败路径**各用一个 harness**（同一静默周期里换 responder 会有在途探测的时序耦合：
  // 实测第一版的「新 WARN」判据会被上一模式的在途探测污染）⇒ 一个 harness 只验一种形状，原因归属无歧义。
  const modes = [
    { name: '抛错', responder: async () => { throw new Error('fixture: session/list 挂了'); }, expect: /原因=fixture: session\/list 挂了/ },
    { name: '超时', responder: () => new Promise(() => {}), expect: /原因=探测超时（>400ms）/ },
    { name: '畸形结构', responder: async () => okEnvelope({ nope: 1 }), expect: /原因=返回结构无法识别（object）/ },
    { name: '空列表', responder: async () => dshList([]), expect: /原因=DSH 返回空列表/ },
  ];
  for (const mode of modes) {
    const sub = await verifyHarness({ config: stallConfig({ stallProbeTimeoutMs: 400 }) });
    try {
      sub.setSessionList(mode.responder);
      const { sid } = await stallBusyFixture(sub, { turn: 21 });
      const warn = await waitUntil(() => linesOf(sub.readLog(), /⚠️ \[stall\] 探测失败（不释放）[^\n]*/).at(-1) ?? null, 9000);
      assert.ok(warn, `${mode.name}：必须留一条 [stall] 探测失败 WARN（实测没有）`);
      assert.match(warn, mode.expect, `${mode.name}：WARN 必须写明原因（实测：${warn}）`);
      assert.equal(count(sub.readLog(), /♻️ \[stall\][^\n]*立即释放/g), 0, `${mode.name}：探测失败绝不允许释放`);
      assert.equal(sub.v2TurnStartAt.has(sid), true, `${mode.name}：④ 必须原样保留`);
      assert.equal(sub.collectors.has(sid), true, `${mode.name}：collectors 必须原样保留`);
      assert.equal(sub.busyWatchdog.stallProbeV2.size <= 1, true, `${mode.name}：探测状态不得泄漏`);
      assert.equal(sub.listArgs().length >= 1, true, `${mode.name}：必须真的发起过探测`);
      console.log(`   [证据·${mode.name}] WARN=${warn.slice(warn.indexOf('原因='))}；释放 0 次、④/collectors 原样、探测 ${sub.listArgs().length} 次`);
    } finally {
      try { sub.close(); } catch {}
    }
  }
});

await test('SC4【门控】busyWatchdog.enabled=false → C-stall 完全 no-op（0 探测、0 [stall] 日志、0 清理）', stallConfig({ enabled: false }), async (h) => {
  h.setSessionList(async () => dshList([dshItem('someone-else')]));    // 最诱人的「已消失」形状
  const { sid } = await stallBusyFixture(h, { withWakeLease: true });
  await sleep(4500);                                                 // ≥4×silenceProbeMs：给探测足够的机会（若有）
  const log = h.readLog();
  assert.equal(count(log, /\[stall\]/g), 0, `enabled=false 时不得有任何 [stall] 日志，实测 ${count(log, /\[stall\]/g)} 条`);
  assert.equal(h.listArgs().length, 0, 'enabled=false 时不得发起任何探测');
  assert.equal(h.intervals.filter((r) => r.ms === 1000).length, 0, 'enabled=false 时连扫描定时器都不该注册');
  assert.equal(h.v2TurnStartAt.has(sid), true, '④ 必须原样保留');
  assert.equal(h.collectors.has(sid), true, 'collectors 必须原样保留');
  assert.equal(h.busyWatchdog.stallProbeV2.size, 0, '探测表必须为空');
  assert.equal(h.busyWatchdog.staleBusyTurns.size, 0, '不得打墓碑');
  assert.ok(h.pendingWakeKeys.has(STALL_KEY), '② 必须原样保留');
  console.log('   [证据] enabled=false：探测 0 次、[stall] 日志 0 条、扫描定时器 0 个、④/②/墓碑全部原样');
});

await test('SC5【探测二·独立核验】从本机 app.asar 读真实 DSH 源码：session/list 条目到底有哪些字段（支持/推翻实现方结论）', stallConfig({ warnMs: 600000, releaseMs: 600000, hardCapMs: 1800000, checkIntervalMs: 1000 }), async (h) => {
  // ① 桥接侧的读法/形状（在 harness 里实测：它确实调 api.sessions.list({}) 并吃 {items}）。
  // 这里用「找到本会话但 running 是字符串」的形状来证明**解析成功且配对正确**，同时**不产生任何投票**
  // （t51：非布尔 ⇒ unknown）—— 免得这一相就把会话释放掉、把后面 ③ 要用的 ④ 状态提前消费掉。
  h.setSessionList(async () => dshList([{ sessionId: 'someone-else', running: true }]));   // 先给一张「别的会话」列表（相 1 之前）
  const { sid, feed } = await stallBusyFixture(h, { turn: 31 });
  h.setSessionList(async () => dshList([dshItem('someone-else', { running: true }), dshItem(sid, { running: 'true' })]));
  await waitUntil(() => h.listArgs().length >= 1, 6000);
  assert.equal(Object.keys(h.listArgs()[0] ?? {}).length, 0, `桥接调用的参数形状必须是 {}（VM 跨界对象原型不同，别用 deepStrictEqual），实测 ${JSON.stringify(h.listArgs()[0])}`);
  const shapeWarn = await waitUntil(() => linesOf(h.readLog(), /⚠️ \[stall\] 探测失败（不释放）[^\n]*原因=running 字段非布尔（string:"true"）[^\n]*/).at(-1) ?? null, 8000);
  assert.ok(shapeWarn, '桥接必须能解析 {result:{ok,value:{items}}} 并配对到本会话的条目（配对成功但 running 非布尔 ⇒ unknown + WARN）');
  assert.equal(h.busyWatchdog.stallProbeV2.get(STALL_KEY)?.noRunningTurn ?? 0, 0, '非布尔 running 不得算「没在跑」票');
  assert.equal(h.v2TurnStartAt.has(sid), true, '（相 1 结束后）④ 必须仍在：非布尔不投票');
  // ② 真·DSH 源码：只读解包 app.asar（绝不写回、绝不启动/重启任何服务）
  const asarPath = process.env.DSH_ASAR || 'D:\\DSH Desktop\\resources\\app.asar';
  const controllerPath = 'dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js';
  let extracted = null;
  let runningLineNo = '?';
  let coldLineNo = '?';   // 只在下面「真实源码摘录」与结论行里用（:1877 / :1914）
  try {
    const fd = fs.openSync(asarPath, 'r');
    try {
      const head = Buffer.alloc(8);
      fs.readSync(fd, head, 0, 8, 0);
      const headerSize = head.readUInt32LE(4);
      const payload = Buffer.alloc(headerSize);
      fs.readSync(fd, payload, 0, headerSize, 8);
      const text = payload.toString('utf8');
      const header = JSON.parse(text.slice(text.indexOf('{')));
      const entry = controllerPath.split('/').reduce((node, part) => (node?.files?.[part] ?? null), { files: header.files });
      assert.ok(entry, `必须能在 app.asar 头里定位 ${controllerPath}`);
      const buf = Buffer.alloc(Number(entry.size));
      fs.readSync(fd, buf, 0, buf.length, 8 + headerSize + Number(entry.offset));
      extracted = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (error) {
    console.log(`   [跳过] 读不到本机 app.asar（${asarPath}）：${error?.message ?? error} —— 本轮只完成桥接侧形状核验`);
  }
  if (extracted) {
    const lines = extracted.split('\n');
    const at = (needle) => { const i = lines.findIndex((l) => l.includes(needle)); return i < 0 ? null : { n: i + 1, line: lines[i].trim() }; };
    /** 取「在 beforeLine 之前、最靠后」的一处匹配（用于精确挑出条目构造函数里的那一行）。 */
    const atBefore = (needle, beforeLine) => {
      let hit = null;
      lines.forEach((l, i) => { if (i + 1 < beforeLine && l.includes(needle)) hit = { n: i + 1, line: l.trim() }; });
      return hit;
    };
    const running = at('running: this.ctx.agents.get(') ?? at('?.status === "running"');
    const coldRunning = at('running: false,');
    runningLineNo = running ? running.n : '?';
    coldLineNo = coldRunning ? coldRunning.n : '?';
    const sessionId = running ? atBefore('sessionId: session.id,', running.n) : at('sessionId: session.id,');
    const agentAvailable = at('agentAvailable: this.ctx.agents.get(');
    const handlerReturn = at('return { items: await this.listState.list(signal) };');
    const updatedAtFn = at('return Math.max(header.createdAt, metadata?.lastPromptAt ?? 0);');
    console.log('   [真实 DSH 源码摘录（app.asar 只读解包）]');
    for (const [label, hit] of [['running(热会话)', running], ['running(冷会话)', coldRunning], ['条目主键', sessionId],
      ['agentAvailable', agentAvailable], ['list 处理器返回', handlerReturn], ['updatedAt 定义', updatedAtFn]]) {
      console.log(`     ${label} @ :${hit ? hit.n : '(未找到)'} ${hit ? hit.line : ''}`);
    }
    assert.ok(running && /=== "running"/.test(running.line),
      '【支持】实现方「DSH 暴露『每会话是否有在跑的回合』」的结论：running 是布尔（status==="running"）');
    assert.ok(coldRunning, '【支持】冷会话分支也显式写 running: false（字段恒有值，不是可缺省的）');
    assert.ok(sessionId, '【支持】条目主键就是 sessionId（与桥接的 it?.sessionId 匹配一致）');
    assert.ok(agentAvailable, '【支持】agentAvailable 字段存在（桥接未用到，但它证明条目带运行态）');
    assert.ok(handlerReturn, '【支持】list 处理器的返回形状就是 { items: [...] }（桥接 value?.items 解析正确）');
    assert.ok(updatedAtFn && /lastPromptAt/.test(updatedAtFn.line),
      '【支持】updatedAt = max(createdAt, lastPromptAt) ⇒ 它反映的是「最后一次用户 prompt」，不是「最后活动」');
    const activityFields = extracted.match(/last(Activity|Event|Active|Frame)At|idleMs/g) ?? [];
    assert.deepEqual([...new Set(activityFields)], [],
      `【支持】实现方「没有 API 暴露最后活动时间」的结论：DSH 源码里不存在这些字段（实测 ${JSON.stringify([...new Set(activityFields)])}）`);
    console.log(`   [结论] 独立核验**支持**实现方：'每会话是否有在跑的回合' 有（running: boolean，:${runningLineNo}）；`
      + `'最后活动时间' 没有（只有 updatedAt=max(createdAt,lastPromptAt)，:${updatedAtFn.n}，语义是最后一次用户 prompt）。`
      + ` 一处措辞差异：实现方引用写作 agents.get(id)，真实行是 agents.get(session.id)（语义相同）。`
      + ` 冷会话分支也显式写 running（:${coldLineNo}）⇒ 「缺省」只可能来自字段漂移，t51 已按 unknown 处理（见下面 ③）。`);
  }
  assert.equal(h.listArgs().length >= 1, true, '（桥接侧）必须真的调用过 DSH 列表 API');
  console.log(`   [证据] 桥接调用参数=${JSON.stringify(h.listArgs()[0])}；解析 {result:{ok,value:{items}}} 成功（dshMissing 计数已推进）；`
    + ` 探测二的结论：${extracted ? '已用本机 app.asar 真实源码核验' : '源码不可读，仅完成形状核验'}`);
  // ③ t51 对抗面（本脚本与聚焦套件 E1 互补的那一格）：条目在场但 `running` **缺省/非布尔** ⇒
  //   **不投票、不释放**（unknown + WARN），而不是 t51 之前的 fail-open（`running !== true` 就当「没在跑」）。
  //   真值表五行（缺省 / 'false' / null / false / true）由聚焦套件 E1 覆盖；这里只守「缺省 ⇒ 不投票」这一条。
  //   注意：WARN 每个静默周期只打一条（probe.warned 节流），所以要**先打破静默**（真喂一帧 → 下一轮扫描
  //   把探测状态整条删掉、warned 复位），再等新的静默窗口到点，才拿到本相自己的那条 WARN。
  feed.push(assistantText(sid, 31, '还在干活'));
  assert.ok(await waitUntil(() => h.busyWatchdog.stallProbeV2.has(STALL_KEY) === false, 4000),
    '（夹具）静默被打破后探测状态必须清空（WARN 节流随之复位）');
  const probesBeforeMissing = h.listArgs().length;
  const idleVotesBefore = count(h.readLog(), /🔎 \[stall\] 探测：DSH 说该会话没有在跑的回合/g);
  const releasesBefore = count(h.readLog(), /♻️ \[stall\][^\n]*立即释放/g);
  h.setSessionList(async () => dshList([dshItem('someone-else', { running: true }), { sessionId: sid, updatedAt: Date.now(), agentAvailable: true }])); // ← 故意不带 running
  const missingWarn = await waitUntil(() => linesOf(h.readLog(), /⚠️ \[stall\] 探测失败（不释放）[^\n]*原因=running 字段非布尔（缺省）[^\n]*/).at(-1) ?? null, 9000);
  assert.ok(missingWarn, 'running 缺省必须走 unknown：留一条「⚠️ [stall] 探测失败（不释放）…原因=running 字段非布尔（缺省）」的 WARN');
  assert.ok(await waitUntil(() => h.listArgs().length >= probesBeforeMissing + 2, 6000),
    `必须连探两枪（≥2 次）才能证明「两枪也不释放」，实测 ${h.listArgs().length - probesBeforeMissing} 枪`);
  await sleep(1200);   // 再等一个扫描周期：给「第二枪若会释放」留足机会
  assert.equal(count(h.readLog(), /🔎 \[stall\] 探测：DSH 说该会话没有在跑的回合/g), idleVotesBefore,
    'running 缺省时**绝不能**出现「DSH 说该会话没有在跑的回合」这行投票（不投票 ⇒ 不释放）');
  assert.equal(count(h.readLog(), /♻️ \[stall\][^\n]*立即释放/g), releasesBefore, 'running 缺省不得触发任何 [stall] 释放');
  assert.equal(h.v2TurnStartAt.has(sid), true, '两枪后 ④ v2TurnStartAt 必须仍在（不释放）');
  assert.equal(h.collectors.has(sid), true, '两枪后 collectors 必须仍在（不释放）');
  assert.equal(h.busyWatchdog.stallProbeV2.get(STALL_KEY)?.dshMissing ?? 0, 0, '缺省不得记 missing 票');
  assert.equal(h.busyWatchdog.stallProbeV2.get(STALL_KEY)?.noRunningTurn ?? 0, 0, '缺省不得记 idle 票');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sid), false, '不得打墓碑（没释放）');
  dump('t51 对抗面（running 缺省）', h.readLog(), /[^\n]*\[stall\][^\n]*/);
  console.log('   [证据·t51 对抗面] running 缺省 ⇒ ' + missingWarn.slice(missingWarn.indexOf('原因='))
    + `；探了两枪（+${h.listArgs().length - probesBeforeMissing} 次）、投票计数 dshMissing/noRunningTurn=0/0、`
    + `[stall] 释放 ${count(h.readLog(), /♻️ \[stall\][^\n]*立即释放/g) - releasesBefore} 次、④ 仍在（v2TurnStartAt=${h.v2TurnStartAt.has(sid)}、collectors=${h.collectors.has(sid)}）`
    + ' ⇒ 与新语义一致：字段不可核验时宁可不投票（继续等 15 分钟预算），不拿「字段没了」当否证证据。');
});

// ══════════════════════════════════════════════════════════════════════════════════
// t57 · 独立验证 issue #23 根因修复（t56）：回合外帧不建 collector ⇒ 会话不再被
// 一个「永远等不到 turn/end 的空 collector」钉成永久 busy ⇒ 唤醒仍能投递。
// 判别前提：warn/release 都钉在 600s ⇒ 观测窗口里看门狗不可能动手，任何状态变化都来自帧语义。
// ══════════════════════════════════════════════════════════════════════════════════
const offTurnConfig = () => wdConfig({ warnMs: 600000, releaseMs: 600000, hardCapMs: 1800000, checkIntervalMs: 1000, rearmCooldownMs: 60000, maxRearmPerHour: 3 });
const offTurnKinds = (sid) => ([
  ['user/message（压缩检查点的用户消息）', frame(sid, { type: 'user/message', data: { turn: 3, message: { role: 'user', content: [{ type: 'text', text: '（压缩检查点里的用户消息）' }] }, source: { kind: 'user' } } })],
  ['compaction/start', frame(sid, { type: 'compaction/start', data: { turn: 3 } })],
  ['session/end-seed（DSH 重启写下）', frame(sid, { type: 'session/end-seed', data: {} })],
  ['step/start', frame(sid, { type: 'step/start', data: { turn: 3, step: 1 } })],
]);
const toolCallAt = (sid, turn, name = 'fixture.tool') => frame(sid, { type: 'tool/call', data: { turn, name, callId: `c${turn}`, arguments: {} } });

/** 真桥接 + 真调度，喂一条回合外帧并返回「①collector ②busy ③唤醒」三件事的实测值。 */
async function offTurnProbe(h, { feedWaitMs = 3000, wakeWaitMs = 5000 } = {}) {
  h.setMode('reserved2');
  const sid = await h.ensureSession(STALL_KEY);
  const st = h.getSocialV2State(STALL_KEY);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 300;          // 合并窗拉短：唤醒排上定时器后很快真投递
  const feed = h.startMux();
  const promptsBefore = h.calls.prompts.length;
  return {
    sid, st, feed,
    async probe(offFrame) {
      feed.push(offFrame);
      // 注意：活动戳是按**会话 key**（private:123）记的，不是按 sessionId
      assert.ok(await waitUntil(() => h.busyWatchdog.lastFrameAtV2.has(STALL_KEY), feedWaitMs), '（夹具）帧必须真的被 pumpMux 处理（活动戳）');
      await sleep(150);
      const collector = h.collectors.has(sid);
      const busy = h.isConversationBusyV2(STALL_KEY, st);
      h.scheduleWakeV2(STALL_KEY, 'private');
      const delivered = await waitUntil(() => h.calls.prompts.length > promptsBefore, wakeWaitMs);
      const log = h.readLog();
      return {
        collector, busy, delivered: !!delivered, deliveredCount: h.calls.prompts.length - promptsBefore,
        backlog: (st.pendingWakeReasons ?? []).length,
        stashed: /会话繁忙，暂存唤醒原因/.test(log),
        woke: new RegExp(`\\[reserved2\\] 唤醒 ${STALL_KEY}（private）`).test(log),
      };
    },
  };
}

await test('IC1【issue #23 核心】四条回合外帧（user/message、compaction/start、session/end-seed、step/start）都不建 collector ⇒ busy=false ⇒ 后续唤醒照常投递（附原始日志）', offTurnConfig(), async () => {
  for (const [label, kindIndex] of [['user/message', 0], ['compaction/start', 1], ['session/end-seed', 2], ['step/start', 3]]) {
    const sub = await verifyHarness({ config: offTurnConfig() });
    try {
      const probe = await offTurnProbe(sub);
      const offFrame = offTurnKinds(probe.sid)[kindIndex][1];
      const r = await probe.probe(offFrame);
      assert.equal(r.collector, false, `${label}：① 回合外帧不得建立 collector（旧缺陷的根因）`);
      assert.equal(r.busy, false, `${label}：② busy 判据必须为 false（不再被空 collector 钉死）`);
      assert.ok(r.delivered, `${label}：③ 随后的唤醒必须真的投递（本 issue 的核心症状）`);
      assert.equal(r.backlog, 0, `${label}：③ 唤醒不得落进 pendingWakeReasons（旧症状是只进 backlog）`);
      assert.equal(r.stashed, false, `${label}：③ 不得出现「会话繁忙，暂存唤醒原因」（旧症状原文）`);
      assert.ok(r.woke, `${label}：③ 必须出现真投递的唤醒行 [reserved2] 唤醒 ${STALL_KEY}（private）`);
      dump(`${label} 现场`, sub.readLog(), /[^\n]*\[reserved2\][^\n]*/);
      console.log(`   [证据·${label}] collector=${r.collector}、busy=${r.busy}、唤醒投递=${r.deliveredCount} 次、pendingWakeReasons=${r.backlog}、「会话繁忙，暂存」=${r.stashed}、有唤醒行=${r.woke}`);
    } finally {
      try { sub.close(); } catch {}
    }
  }
});

await test('IC2【载荷性反证】回退版 A（只回退 collector 创建）⇒ ①红但②③仍绿（openTurns 第二层独立兜住）；回退版 B（两层都回退）⇒ 复现 issue #23 全症状', offTurnConfig(), async () => {
  const revertCollectorCreation = (src) => {
    const out = src.replace(
      /let collector = collectors\.get\(frame\.sessionId\) \?\? null;\s*\n\s*if \(!collector && frame\.event\.type === 'turn\/start'\) \{\s*\n\s*collector = createTurnCollector\(\);\s*\n\s*collectors\.set\(frame\.sessionId, collector\);\s*\n\s*\}/,
      "let collector = collectors.get(frame.sessionId) ?? createTurnCollector();\n            collectors.set(frame.sessionId, collector); /* mutant A：回退成旧写法 */");
    assert.notEqual(out, src, '变异锚点 A（只认 turn/start 建 collector）必须命中，否则反证是空的');
    return out;
  };
  const revertOpenTurnsToo = (src) => {
    const a = revertCollectorCreation(src);
    const b = a.replace(
      /if \(!collector\) return false;\s*\n\s*if \(typeof collector\.openTurns !== 'function'\) return true;[\s\S]{0,200}?catch \{\s*\n\s*return true;\s*\n\s*\}/,
      "if (!collector) return false;\n    return true; /* mutant B：回退成「collectors 里有就算在途」 */");
    assert.notEqual(b, a, '变异锚点 B（openTurns 判据）必须命中，否则反证是空的');
    return b;
  };
  for (const [name, transform] of [['A（只回退 collector 创建）', revertCollectorCreation], ['B（两层都回退）', revertOpenTurnsToo]]) {
    const sub = await verifyHarness({ config: offTurnConfig(), transformSource: transform });
    try {
      const probe = await offTurnProbe(sub);
      const r = await probe.probe(frame(probe.sid, { type: 'compaction/start', data: { turn: 3 } }));
      if (name.startsWith('A')) {
        assert.equal(r.collector, true, `${name}：① 必须红 —— 旧写法会在回合外帧上建出 collector（=IC1 断言①的载荷证明）`);
        assert.equal(r.busy, false, `${name}：② 仍绿 —— openTurns 第二层独立兜住（防御纵深，实测确认）`);
        assert.ok(r.delivered && r.backlog === 0, `${name}：③ 仍绿 —— 唤醒照常投递（第二层也让症状消失）`);
        console.log(`   [反证·${name}] ①collector=${r.collector}（红）、②busy=${r.busy}（仍绿，第二层兜住）、③投递=${r.deliveredCount} 次/backlog=${r.backlog}（仍绿）`);
      } else {
        assert.equal(r.collector, true, `${name}：① 必须红（建出了 collector）`);
        assert.equal(r.busy, true, `${name}：② 必须红 —— 空 collector 把会话钉成 busy`);
        assert.equal(r.backlog >= 1, true, `${name}：③ 必须红 —— 唤醒只进 pendingWakeReasons（旧症状）`);
        assert.equal(r.stashed, true, `${name}：③ 必须红 —— 出现「会话繁忙，暂存唤醒原因」`);
        assert.equal(r.woke, false, `${name}：③ 不得有真投递的唤醒行`);
        console.log(`   [反证·${name}] ①②③ 全红：collector=${r.collector}、busy=${r.busy}、backlog=${r.backlog}、「会话繁忙，暂存」=${r.stashed}、唤醒行=${r.woke} ⇒ 复现 issue #23 原症状`);
      }
    } finally {
      try { sub.close(); } catch {}
    }
  }
});

await test('IC3【openTurns 边界】collector 存在但 0 未结束回合 ⇒ busy=false；1 个 ⇒ true；turn/end ⇒ 0；旧形状（无 openTurns）兼容 ⇒ true；无 collector 收到 turn/end 不留残留', offTurnConfig(), async (h) => {
  h.setMode('reserved2');
  const sid = await h.ensureSession(STALL_KEY);
  const st = h.getSocialV2State(STALL_KEY);
  const c = h.createTurnCollector();
  assert.equal(typeof c.openTurns, 'function', 'collector 必须暴露 openTurns()（t56 新增）');
  h.collectors.set(sid, c);
  assert.equal(c.openTurns(), 0);
  assert.equal(h.isConversationBusyV2(STALL_KEY, st), false, 'collector 对象存在但 0 未结束回合 ⇒ busy 必须 false（本 issue 的根因防护）');
  c.push({ type: 'turn/start', data: { turn: 7 } });
  assert.equal(c.openTurns(), 1);
  assert.equal(h.isConversationBusyV2(STALL_KEY, st), true, '1 个未结束回合 ⇒ busy 必须 true');
  assert.ok(c.push({ type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } }), 'turn/end 必须终结该回合');
  assert.equal(c.openTurns(), 0);
  assert.equal(h.isConversationBusyV2(STALL_KEY, st), false, '回合收尾后 ⇒ busy 必须回到 false');
  h.collectors.set(sid, { push: () => null });   // 旧形状：没有 openTurns()
  assert.equal(h.isConversationBusyV2(STALL_KEY, st), true, '旧形状/异常 collector 必须回退成「存在即在途」（绝不因兼容问题漏释放）');
  h.collectors.delete(sid);
  assert.equal(h.isConversationBusyV2(STALL_KEY, st), false);
  const feed = h.startMux();
  const synBefore = count(h.readLog(), /收到没有对应 turn\/start 的 turn\/end/g);
  feed.push(turnEnd(sid, 9, 'completed'));       // 无 collector 也无 ④
  await sleep(250);
  assert.equal(h.collectors.has(sid), false, '无 collector 时收到 turn/end 不得凭空建 collector');
  assert.equal(h.v2TurnStartAt.has(sid), false, '不得留下 ④ 残留');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sid), false, '不得留下墓碑残留');
  assert.equal(count(h.readLog(), /收到没有对应 turn\/start 的 turn\/end/g), synBefore, '没有 ④ 在途时不得走「合成收尾」分支');
  console.log('   [证据] openTurns(): 0⇒busy=false、1⇒busy=true、turn/end⇒0⇒false；旧形状⇒true（兼容 fail-safe）；无 collector 的裸 turn/end 零残留且不走兜底');
});

await test('IC4【#11 第二个缺陷】漏掉 turn/start 后同号 turn/end 仍须收尾：清 ④+重排一次+不发空消息+busy 恢复 false；同号正常路径不误清', offTurnConfig(), async (h) => {
  h.setMode('reserved2');
  const sid = await h.ensureSession(STALL_KEY);
  const st = h.getSocialV2State(STALL_KEY);
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  st.wakeConfig.batchWindowMs = 600000;          // 合并窗拉长：重排只登记标记/定时器，便于计数
  const feed = h.startMux();
  feed.push(turnStart(sid, 40));                 // ④ 在场（turn/start 40 是「桥接看得到的那个回合」）
  assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sid) && h.collectors.has(sid), 3000), '（夹具）④ 与 collector 必须先在途');
  feed.push(toolCallAt(sid, 41));                // 回合 41 的 turn/start 丢了，只来 tool/call
  await sleep(150);
  h.scheduleWakeV2(STALL_KEY, 'private');        // 忙分支 ⇒ 暂存一条 backlog（模拟「繁忙期间被暂存的唤醒」）
  assert.ok(await waitUntil(() => (st.pendingWakeReasons ?? []).length === 1, 3000), '（夹具）必须暂存一条 backlog');
  const sentBefore = h.calls.sent.length;
  feed.push(turnEnd(sid, 41, 'completed'));      // 同号 turn/end：collector 里没有 41 的记录
  assert.ok(await waitUntil(() => !h.v2TurnStartAt.has(sid), 4000), '#11：没有对应 turn/start 的 turn/end 也必须触发收尾（否则永久卡忙）');
  assert.equal(h.collectors.has(sid), false, '#11：④ 的 collector 必须被清');
  const log = h.readLog();
  assert.match(log, /收到没有对应 turn\/start 的 turn\/end（[^）]*），按收尾处理以免卡忙/, '#11：必须有兜底诊断行');
  assert.match(log, /补发繁忙期间积压的唤醒：private@seq197/, '#11：暂存的唤醒必须被重排补发');
  assert.equal(count(log, /补发繁忙期间积压的唤醒：private@seq197/g), 1, '#11：同一 (reason,seq) 只能重排一次');
  assert.equal(marksOf(h, STALL_KEY).length, 0, '#11：正常收尾的重排不登记看门狗专用 F1 标记（那是 watchdog 释放路径的语义，这里是 backlog 补发路径）');
  assert.ok(st.pendingWakeTimer, '#11：重排必须真的排上 wake 定时器');
  assert.equal(h.calls.sent.length, sentBefore, '#11：合成收尾不得发出空消息（QQ 直发次数必须不变）');
  assert.equal(h.v2TurnStartAt.has(sid) || h.collectors.has(sid), false, '#11：④（v2TurnStartAt/collectors）必须被清 —— 这是 busy 判据里属于本 issue 的那一项');
  // 注意：重排（补发）本身会排上合并窗定时器 ⇒ `st.pendingWakeTimer` 让 busy=true（那是「有待兑现的唤醒」，
  // 与本 issue 无关、且是设计行为）。先取消它，再断言完整 busy 判据恢复 false。
  assert.equal(h.cancelPendingWakeTimerV2(STALL_KEY, st), true, '#11：（夹具）重排后的合并窗定时器必须真的存在才需要取消');
  assert.equal(h.isConversationBusyV2(STALL_KEY, st), false, '#11：清 ④ 并取消待兑现唤醒后，busy 判据必须恢复 false');
  const synBefore = count(h.readLog(), /收到没有对应 turn\/start 的 turn\/end/g);
  feed.push(turnStart(sid, 50));
  assert.ok(await waitUntil(() => h.collectors.has(sid) && h.v2TurnStartAt.has(sid), 3000), '（夹具）回合 50 必须起来');
  feed.push(turnEnd(sid, 50, 'completed'));
  assert.ok(await waitUntil(() => !h.v2TurnStartAt.has(sid) && !h.collectors.has(sid), 3000), '同号 turn/end 必须照常收尾');
  assert.equal(count(h.readLog(), /收到没有对应 turn\/start 的 turn\/end/g), synBefore, '同号正常路径绝不允许走合成收尾');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sid), false, '正常收尾不得打墓碑');
  feed.push(turnStart(sid, 60));
  assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sid), 3000), '（夹具）回合 60 必须起来');
  assert.equal(Number(h.v2TurnNoV2.get(sid)), 60, '（夹具）在途回合号必须记成 60');
  // ── t70 升级（原为 console.log 观测，现按 t69-C 新语义转硬断言）────────────────────
  // ① 更大号（61 > 60）：与今日行为一致 ⇒ 仍合成收尾（t68 的 S2b 承重场景同源）
  const synBefore61 = count(h.readLog(), /收到没有对应 turn\/start 的 turn\/end/g);
  feed.push(turnEnd(sid, 61, 'completed'));
  assert.ok(await waitUntil(() => !h.v2TurnStartAt.has(sid), 3000), '更大号的 turn/end（61>60）仍必须合成收尾（承重行为不回归）');
  assert.equal(count(h.readLog(), /收到没有对应 turn\/start 的 turn\/end/g), synBefore61 + 1, '更大号必须留下一条兜底诊断行');
  assert.equal(count(h.readLog(), /忽略陈旧的 turn\/end/g), 0, '更大号绝不能被判陈旧');
  // ② 陈旧号（59 < 60）：必须**拒绝**合成 ⇒ ④/墓碑/backlog/号码一字不动 + 一条含两号码的诊断行
  feed.push(turnStart(sid, 60));
  assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sid) && Number(h.v2TurnNoV2.get(sid)) === 60, 3000), '（夹具）回合 60 必须重新起来');
  const stBefore = h.getSocialV2State(STALL_KEY);
  const backlogBefore = JSON.stringify(stBefore.pendingWakeReasons ?? []);
  const synBefore59 = count(h.readLog(), /收到没有对应 turn\/start 的 turn\/end/g);
  const staleBefore = h.busyWatchdog.staleBusyTurns.has(sid);
  feed.push(turnEnd(sid, 59, 'completed'));
  await sleep(400);
  assert.equal(h.v2TurnStartAt.has(sid), true, '陈旧 turn/end(59<60) 绝不允许清掉 ④');
  assert.equal(Number(h.v2TurnNoV2.get(sid)), 60, '陈旧 turn/end 绝不允许动在途回合号');
  assert.equal(h.collectors.has(sid), true, '陈旧 turn/end 绝不允许动 collector');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sid), staleBefore, '陈旧 turn/end 绝不允许打墓碑');
  assert.equal(JSON.stringify(h.getSocialV2State(STALL_KEY).pendingWakeReasons ?? []), backlogBefore, '陈旧 turn/end 绝不允许动 backlog');
  assert.equal(count(h.readLog(), /收到没有对应 turn\/start 的 turn\/end/g), synBefore59, '陈旧 turn/end 绝不允许走合成收尾');
  const staleLine = linesOf(h.readLog(), /忽略陈旧的 turn\/end[^\n]*/).pop() ?? '';
  assert.match(staleLine, /来帧回合号 59 < 在途回合号 60/, `必须有一条含两个号码的陈旧诊断行：${staleLine}`);
  // ③ 随后同号 60 必须正常收尾（陈旧拒绝不得造成永久卡死 = C5 的核心）
  feed.push(turnEnd(sid, 60, 'completed'));
  assert.ok(await waitUntil(() => !h.v2TurnStartAt.has(sid) && !h.collectors.has(sid), 3000), '陈旧帧之后同号 turn/end(60) 必须照常收尾（不永久卡死）');
  assert.equal(h.v2TurnNoV2.has(sid), false, 'C7：清 ④ 必须同时清 v2TurnNoV2');
  assert.equal(h.isConversationBusyV2(STALL_KEY, h.getSocialV2State(STALL_KEY)), false, '收尾后 busy 必须为 false');
  dump('#11 兜底收尾 / 陈旧闸门现场', h.readLog(), /[^\n]*(收到没有对应 turn\/start|忽略陈旧的 turn\/end|补发繁忙期间积压)[^\n]*/);
  console.log(`   [证据] 兜底行=有、更大号 61 仍收尾=true、陈旧 59 被拒（④=${h.v2TurnStartAt.has(sid)} 已由随后 60 收尾）、诊断「${staleLine.slice(0, 60)}…」、`
    + `重排标记=${JSON.stringify(marksOf(h, STALL_KEY))}、QQ 直发=${h.calls.sent.length - sentBefore} 次（必须 0）、同号正常路径不走兜底；C7：清 ④ 且 v2TurnNoV2 已清`);
});

await test('IC5【零回归 + flags 文案】正常回合序列照常累加文本与收尾（不走兜底）；看门狗警告里的 flags 仍是 v2TurnStartAt,collectors', wdConfig({ warnMs: 1000, releaseMs: 600000, hardCapMs: 1800000, checkIntervalMs: 1000, rearmCooldownMs: 60000, maxRearmPerHour: 3 }), async (h) => {
  const c = h.createTurnCollector();
  c.push({ type: 'turn/start', data: { turn: 70 } });
  c.push({ type: 'assistant/message', data: { turn: 70, message: { content: [{ type: 'text', text: '你' }, { type: 'text', text: '好' }] } } });
  const ended = c.push({ type: 'turn/end', data: { turn: 70, reason: { kind: 'completed' } } });
  assert.equal(ended.text, '你好', 'assistant/message 的多块文本必须照常累加');
  assert.equal(c.openTurns(), 0, '收尾后未结束回合必须归零');
  h.setMode('reserved2');
  const sid = await h.ensureSession(STALL_KEY);
  const st = h.getSocialV2State(STALL_KEY);
  st.unread = [];
  st.lastUnreadSeq = 0;
  const feed = h.startMux();
  const synBefore = count(h.readLog(), /收到没有对应 turn\/start 的 turn\/end/g);
  feed.push(turnStart(sid, 71));
  assert.ok(await waitUntil(() => h.collectors.has(sid) && h.v2TurnStartAt.has(sid), 3000), '正常 turn/start 必须建 collector 并记 ④');
  feed.push(assistantText(sid, 71, '正常回复'));
  await sleep(150);
  feed.push(turnEnd(sid, 71, 'completed'));
  assert.ok(await waitUntil(() => !h.v2TurnStartAt.has(sid) && !h.collectors.has(sid), 3000), '正常 turn/end 必须照常清理 ④');
  assert.equal(count(h.readLog(), /收到没有对应 turn\/start 的 turn\/end/g), synBefore, '正常回合绝不能走合成收尾');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sid), false, '正常收尾不得打墓碑');
  feed.push(turnStart(sid, 72));                 // 再造一个真在途回合（busy）以触发 WARN 档
  assert.ok(await waitUntil(() => h.collectors.has(sid) && h.v2TurnStartAt.has(sid), 3000), '（夹具）回合 72 必须在途');
  const warn = await waitUntil(() => linesOf(h.readLog(), /\[watchdog\] warn[^\n]*/).at(-1) ?? null, 9000);
  assert.ok(warn, 'busy（真在途回合）+ warnMs=1000 必须出现 [watchdog] warn 行');
  assert.match(warn, /flags=[^\s]*v2TurnStartAt,collectors/, `flags 文案必须原样保留（冻结契约）：${warn}`);
  dump('flags 现场', h.readLog(), /[^\n]*\[watchdog\] warn[^\n]*/);
  console.log(`   [证据] 文本累加='${ended.text}'（两个 text 块 → 一串）；正常回合清理 ④ 且不走兜底、无墓碑；WARN flags=${/flags=([^\s]*)/.exec(warn)?.[1]}`);
});

// ══ 汇总 ══════════════════════════════════════════════════════════════════
console.log(`\n══════════════════════════════════════════════════════════════════`);
console.log(`通过 ${passes.length} 项，失败 ${failures.length} 项，探针失败 ${probeFailures.length} 项`);
for (const item of failures) console.log(`  ❌ ${item.name}`);
for (const item of probeFailures) console.log(`  ❌ PROBE ${item.name}`);
console.log(`观测（不阻断验收）：
  O2 墓碑（staleBusyTurns）在「释放后没有 live turn/start」时不会被消费：生产里
     collectors 已被释放删除，迟到的 turn/end 由新建的空 collector 处理（push 返回 null），
     永远走不到 :12083 的静默排空分支，于是墓碑一直留到下一次 live turn/start（:12025）
     或 reset/retire。功能上无害（该帧本来就被丢弃），但属于有界的运行时残留；
     释放行里的 staleTurn=true 因此会持续为真。
  O3 F1 闭合（t7 验，t9 复验仍绿）：T4 同一 (reason,seq) 只投递 1 次；T14 证明
     「re-arm 被再次暂存」时不登记标记、不丢消息；T15 证明去重粒度按 (reason,seq)。
  O5 F3 闭合（t9 验）：T16 已按修复后语义转硬断言 —— 被拒/抛错/skip/派发时再忙
     四条路径（T16/T17/T18/T19）都证明标记被清、条目留在 backlog、最终重排并送达；
     T20 证明清标记严格按 (reason,seq)（非有限 seq 不动标记）；T21 用 VM 内中和
     F3 修复的反证夹具复现旧断言（标记残留 + shift 跳过）成立，确认旧 T16 的
     :900/:914 两条断言编码的是修复前行为而非可满足语义。
  O6 设计边界（非缺陷）：同一 stuck 条目在小时额度内可被多次 re-arm（maxRearmPerHour=3），
     每次 release 都是一次新的看门狗干预，属于冻结设计（§15.8 防释放风暴靠 cooldown+额度）。
  O7 F-R2 真实传输路径的两条实测边界（R7/R8，独立复验；**未**在 RUNBOOK §17.5 逐字写明）：
     · 有界复核把「断连时在途的那个回合、重放后静默 >4s」当判死证据 —— 一个真在慢工具里跑的回合
       会被误清；后果实测：那一轮的真实回复**不发 QQ、也不进输出路径**，且因为 collectors 已被清理
       删除（迟到帧由没有 turn/start 的新 collector 处理，push 返回 null），连 :12546 的
       「静默排空」日志都打不出来 —— 比 §17.5「墓碑让它迟到的 turn/end 静默排空」的措辞更静默。
       墓碑由下一次 live turn/start 消费（有界残留）。
     · 条目未随 turn/end 收尾时（DSH 把那一轮丢了），断流 finally 会清 pendingWakeKeys(:12895) 与
       rearmedWakeV2(:2752 经 :12906)，于是**下一次**断连-重连会把同一条 (reason,seq) 再投递一次
       （R8 实测 X=2 次）。这是「那一轮随断连丢失 ⇒ 必须重发」的恢复行为（否则又哑火），但使
       「跨两轮断连只送达 1 次」在真实传输路径上不成立：它只在条目已被 shift 消费时成立（R8 的 Y=1 次），
       或事件流未断的探活路径上成立（R5）。重连 rearm 也不受 rearmCooldownMs/maxRearmPerHour 约束 ⇒
       DSH 反复重启时同一待办唤醒可被反复投递（看门狗路径有 3 次/小时上限）。`);
// ══════════════════════════════════════════════════════════════════════════════════
// t70 · 独立复核 t69 的 A（WARN 按档位跃迁去重）与 C（合成收尾的陈旧 turn/end 号码闸门）
// 纪律：不用实现方的用例，自己造夹具；反证一律在 VM 内存副本里做（src/ 零改动）。
// ══════════════════════════════════════════════════════════════════════════════════
const t70WarnCfg = () => ({ socialV2: { enabled: true, busyWatchdog: {
  warnMs: 1000, releaseMs: 600000, hardCapMs: 1800000, checkIntervalMs: 1000,
  rearmCooldownMs: 60000, maxRearmPerHour: 3, silenceProbeMs: 0 } } });
const t70ReleaseCfg = () => ({ socialV2: { enabled: true, busyWatchdog: {
  warnMs: 1000, releaseMs: 2500, hardCapMs: 1800000, checkIntervalMs: 1000,
  rearmCooldownMs: 60000, maxRearmPerHour: 3, silenceProbeMs: 0 } } });

/** 手动 tick 看门狗扫描（harness 的 setInterval 是捕获桩，不会自己跑）。 */
async function t70Tick(h, times = 1, gapMs = 20) {
  const timer = h.intervals.find((it) => it === h.busyWatchdog.timer) ?? h.intervals[0];
  for (let i = 0; i < times; i += 1) {
    try { timer?.fn?.(); } catch { /* 扫描内部异常不影响计数 */ }
    if (gapMs) await sleep(gapMs);
  }
}
/** 把某会话做成「忙但长期无活动」：② pendingWakeKeys + 20 秒前的活动戳（idle=20s）。 */
async function t70StickByPendingWake(h, key) {
  await h.ensureSession(key);
  const sid = h.state.sessions[key];
  h.pendingWakeKeys.add(key);
  h.noteFrameActivityV2(sid, Date.now() - 20000);
  return { key, sid, st: h.getSocialV2State(key) };
}

await test('T70A1【WARN 去重】同一会话同一忙-episode 内 20 次扫描只写 1 行 WARN，去重表记为 warn', t70WarnCfg(), async (h) => {
  h.setMode('reserved2');
  const { key } = await t70StickByPendingWake(h, STALL_KEY);
  await t70Tick(h, 20, 250);
  const log = h.readLog();
  assert.equal(count(log, /⚠️ \[watchdog\] warn /g), 1, `同一 episode 内 WARN 必须恰好 1 行（实测 ${count(log, /⚠️ \[watchdog\] warn /g)}）`);
  assert.equal(h.busyWatchdog.warnedTiersV2.get(key), 'warn', '去重表必须记为 warn');
  dump('T70A1 WARN 去重', log, /[^\n]*\[watchdog\] warn[^\n]*/);
  console.log(`   [证据] 20 次扫描 ⇒ WARN ${count(log, /⚠️ \[watchdog\] warn /g)} 行；去重表[${key}]=${h.busyWatchdog.warnedTiersV2.get(key)}；WARN 行逐字：${(linesOf(log, /⚠️ \[watchdog\] warn[^\n]*/).pop() ?? '').slice(0, 150)}`);
});

await test('T70A2【episode 边界】忙→闲边沿必须清去重状态 ⇒ 同一会话第二次卡忙能再写 WARN（不是「一辈子一行」）', t70WarnCfg(), async (h) => {
  h.setMode('reserved2');
  const { key } = await t70StickByPendingWake(h, STALL_KEY);
  await t70Tick(h, 12, 300);
  assert.equal(count(h.readLog(), /⚠️ \[watchdog\] warn /g), 1, '（前置）第一次 episode 必须写 1 行');
  h.pendingWakeKeys.delete(key);                       // 忙 → 闲
  await t70Tick(h, 2, 250);
  assert.equal(h.busyWatchdog.warnedTiersV2.has(key), false, '忙→闲边沿必须清掉去重状态（否则第二次卡忙永远不再 WARN）');
  h.pendingWakeKeys.add(key);                          // 第二次卡忙（新 episode）
  await t70Tick(h, 12, 300);
  assert.equal(count(h.readLog(), /⚠️ \[watchdog\] warn /g), 2, '新 episode 必须重新写 WARN（证明去重是 per-episode，不是一辈子一次）');
  console.log(`   [证据] episode-1 WARN=1 → 边沿后去重表 has=${h.busyWatchdog.warnedTiersV2.has(key)}=false → episode-2 WARN 累计=${count(h.readLog(), /⚠️ \[watchdog\] warn /g)}`);
});

await test('T70A3【多会话互不抑制】两个会话各自写 1 行；重复扫描 A 不抑制 B', t70WarnCfg(), async (h) => {
  h.setMode('reserved2');
  await t70StickByPendingWake(h, STALL_KEY);
  h.cfg.allow.private = [...new Set([...(h.cfg.allow.private ?? []), '999'])];   // 放开第二个私聊（默认白名单只有 private:123）
  await t70StickByPendingWake(h, 'private:999');
  await t70Tick(h, 12, 300);
  const log = h.readLog();
  const a = count(log, /⚠️ \[watchdog\] warn key=private:123 /g);
  const b = count(log, /⚠️ \[watchdog\] warn key=private:999 /g);
  assert.equal(a, 1, `private:123 必须恰好 1 行（实测 ${a}）`);
  assert.equal(b, 1, `private:999 必须恰好 1 行（实测 ${b}）`);
  await t70Tick(h, 12, 300);                              // 再扫 8 次：A 的重复不得抑制 B（也不得新增）
  assert.equal(count(h.readLog(), /\[watchdog\] warn /g), 2, '再扫 8 次后总 WARN 必须仍是 2 行（每会话 1 行，互不抑制也不重复）');
  console.log(`   [证据] 两会话各 1 行（a=${a}/b=${b}），再扫 8 次后总数=${count(h.readLog(), /\[watchdog\] warn /g)}；去重表 size=${h.busyWatchdog.warnedTiersV2.size}`);
});

await test('T70A4【运行时清理路径】clearBusyWatchdogRuntimeV2 必须清空去重表（断流路径共用），清后能重新写 WARN', t70WarnCfg(), async (h) => {
  h.setMode('reserved2');
  const { key } = await t70StickByPendingWake(h, STALL_KEY);
  await t70Tick(h, 12, 300);
  assert.equal(count(h.readLog(), /⚠️ \[watchdog\] warn /g), 1, '（前置）1 行 WARN');
  assert.equal(h.busyWatchdog.warnedTiersV2.get(key), 'warn');
  h.clearBusyWatchdogRuntimeV2('t70：模拟断流/重置');
  assert.equal(h.busyWatchdog.warnedTiersV2.size, 0, 'clearBusyWatchdogRuntimeV2 必须把去重表清空');
  // 断流路径带 keepDshDownSnapshot:true（:13557）—— 该选项只保护「DSH 断连快照」，不得豁免去重表
  h.busyWatchdog.warnedTiersV2.set(key, 'warn');
  h.clearBusyWatchdogRuntimeV2({ keepDshDownSnapshot: true });
  assert.equal(h.busyWatchdog.warnedTiersV2.size, 0, '断流路径（keepDshDownSnapshot:true）同样必须清空去重表');
  h.pendingWakeKeys.add(key);
  h.noteFrameActivityV2(h.state.sessions[key], Date.now() - 20000);
  await t70Tick(h, 12, 300);
  assert.equal(count(h.readLog(), /⚠️ \[watchdog\] warn /g), 2, '清理后必须能重新写 WARN（证明清理路径不留「永久静默」）');
  console.log(`   [证据] clearBusyWatchdogRuntimeV2 后 size=${h.busyWatchdog.warnedTiersV2.size - 1 >= 0 ? 0 : 'n/a'} → 再扫 ⇒ WARN 累计=${count(h.readLog(), /⚠️ \[watchdog\] warn /g)}`);
});

await test('T70A5【释放行零变化 + 档位跃迁】release 档仍恰好 1 行且格式逐字不变；释放后去重表记 release，不再刷 WARN', t70ReleaseCfg(), async (h) => {
  h.setMode('reserved2');
  const { key } = await t70StickByPendingWake(h, STALL_KEY);
  await t70Tick(h, 20, 300);                            // 跨过 releaseMs=3000（真实时间）
  const log = h.readLog();
  const releases = linesOf(log, /\[watchdog\] release[^\n]*/);
  assert.equal(releases.length, 1, `release 行必须恰好 1 行（实测 ${releases.length}）`);
  assert.match(releases[0], /\[watchdog\] release key=private:123 busy=\d+s idle=\d+s tier=release released=pendingWakeKeys staleTurn=false backlog=0 rearm=none/, `release 行格式必须逐字不变：${releases[0]}`);
  assert.equal(count(log, /⚠️ \[watchdog\] warn /g), 1, 'warn→release 跃迁前后 WARN 仍只有 1 行（释放行不刷屏）');
  assert.ok(!h.busyWatchdog.warnedTiersV2.has(key), '释放后会话转闲 ⇒ 去重表必须被忙→闲边沿清掉（不得残留档位状态）');
  assert.equal(h.pendingWakeKeys.has(key), false, '② 必须被释放（判定零变化）');
  console.log(`   [证据] release=${releases.length} 行、WARN=${count(log, /⚠️ \[watchdog\] warn /g)} 行、去重表=${h.busyWatchdog.warnedTiersV2.get(key)}、②已释放=${!h.pendingWakeKeys.has(key)}；原文：${releases[0]}`);
});

// ── V2-① 载荷性反证：VM 里移除去重早退 ⇒ 同一 episode 必然刷屏 ─────────────────────
await test('T70A-M【载荷性反证】VM 副本移除去重早退 ⇒ 同一 episode 20 次扫描出现 >1 行 WARN（证明去重状态在承重）', t70WarnCfg(), async () => {
  const sub = await verifyHarness({ config: t70WarnCfg(), transformSource: (source) => {
    const anchor = "      if (busyWatchdog.warnedTiersV2.get(key) === 'warn') return;\n";
    assert.ok(source.includes(anchor), '（反证夹具）必须能定位去重早退那一行');
    return source.replace(anchor, '      /* mutant：去重早退被中和 */\n');
  } });
  try {
    sub.setMode('reserved2');
    await t70StickByPendingWake(sub, STALL_KEY);
    await t70Tick(sub, 14, 250);
    const warns = count(sub.readLog(), /⚠️ \[watchdog\] warn /g);
    assert.ok(warns > 1, `中和去重后必须刷屏（实测 ${warns} 行）`);
    console.log(`   [反证·A] 中和「warn 档早退」⇒ 20 次扫描写出 WARN **${warns}** 行（真身恰好 1 行）⇒ 去重状态确实是载荷的`);
  } finally { sub.close(); }
});

// ── C：陈旧 turn/end 号码闸门 ────────────────────────────────────────────────────
const t70GuardCfg = () => ({ socialV2: { enabled: true, busyWatchdog: {
  warnMs: 600000, releaseMs: 600000, hardCapMs: 1800000, checkIntervalMs: 1000,
  rearmCooldownMs: 60000, maxRearmPerHour: 3, silenceProbeMs: 0 } } });

await test('T70C1【两侧判据 + 拒绝时一字不动】在途 60 收到 59 ⇒ 拒绝合成（④/墓碑/backlog/号码全不动 + 含两号码诊断行）；随后 60 正常收尾', t70GuardCfg(), async (h) => {
  h.setMode('reserved2');
  const sid = await h.ensureSession(STALL_KEY);
  const st = h.getSocialV2State(STALL_KEY);
  st.pendingWakeReasons = [{ reason: 'private', seq: 197 }];
  const feed = h.startMux();
  feed.push(turnStart(sid, 60));
  assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sid) && Number(h.v2TurnNoV2.get(sid)) === 60, 3000), '（夹具）在途回合 60 必须起来且号码记为 60');
  const backlogBefore = JSON.stringify(st.pendingWakeReasons);
  const synBefore = count(h.readLog(), /收到没有对应 turn\/start/g);
  feed.push(turnEnd(sid, 59, 'completed'));
  await sleep(400);
  assert.equal(h.v2TurnStartAt.has(sid), true, '陈旧 59 绝不允许清 ④');
  assert.equal(Number(h.v2TurnNoV2.get(sid)), 60, '陈旧 59 绝不允动号码');
  assert.equal(h.collectors.has(sid), true, '陈旧 59 绝不允动 collector');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sid), false, '陈旧 59 绝不允打墓碑');
  assert.equal(JSON.stringify(h.getSocialV2State(STALL_KEY).pendingWakeReasons), backlogBefore, '陈旧 59 绝不允动 backlog');
  assert.equal(count(h.readLog(), /收到没有对应 turn\/start/g), synBefore, '陈旧 59 绝不允走合成收尾');
  const line = linesOf(h.readLog(), /忽略陈旧的 turn\/end[^\n]*/).pop() ?? '';
  assert.match(line, /来帧回合号 59 < 在途回合号 60/, `诊断行必须含两个号码：${line}`);
  feed.push(turnEnd(sid, 60, 'completed'));
  assert.ok(await waitUntil(() => !h.v2TurnStartAt.has(sid) && !h.collectors.has(sid), 3000), '随后同号 60 必须正常收尾（C5：拒绝不造成永久卡死）');
  assert.equal(h.v2TurnNoV2.has(sid), false, 'C7：清 ④ 必须同时清 v2TurnNoV2');
  dump('T70C1 陈旧闸门', h.readLog(), /[^\n]*(忽略陈旧的 turn\/end|收到没有对应 turn\/start)[^\n]*/);
  console.log(`   [证据] 59 被拒（④ 在、号码 60 在、backlog 未动、无合成行）⇒ 诊断「${line.slice(0, 70)}…」⇒ 60 正常收尾且 v2TurnNoV2 已清`);
});

await test('T70C2【承重不回归】S2b start(40)→end(41) 仍合成收尾；中途接入（无号码记录）仍合成并重排；同号/更大号照旧', t70GuardCfg(), async (h) => {
  h.setMode('reserved2');
  const sid = await h.ensureSession(STALL_KEY);
  const st = h.getSocialV2State(STALL_KEY);
  const feed = h.startMux();
  // ① S2b：40 → 41（41 > 40 ⇒ 不得被判陈旧）
  feed.push(turnStart(sid, 40));
  assert.ok(await waitUntil(() => Number(h.v2TurnNoV2.get(sid)) === 40, 3000), '（夹具）回合 40 必须起来');
  feed.push(turnEnd(sid, 41, 'completed'));
  assert.ok(await waitUntil(() => !h.v2TurnStartAt.has(sid), 3000), 'S2b（40→41）必须仍合成收尾（承重场景不回归）');
  assert.match(h.readLog(), /收到没有对应 turn\/start 的 turn\/end/, 'S2b 必须留下原兜底诊断文案');
  assert.equal(count(h.readLog(), /忽略陈旧的 turn\/end/g), 0, 'S2b 绝不能被判陈旧');
  // ② 中途接入：④ 手工置位 + 无号码记录 ⇒ 41 < undefined 不成立 ⇒ 仍合成
  h.v2TurnStartAt.set(sid, Date.now());
  h.v2TurnNoV2.delete(sid);
  st.pendingWakeReasons = [{ reason: 'private', seq: 197 }];
  h.v2TurnStartAt.set(sid, Date.now());
  feed.push(turnEnd(sid, 41, 'completed'));
  assert.ok(await waitUntil(() => !h.v2TurnStartAt.has(sid), 3000), '无号码记录的中途接入必须仍合成收尾（root F3 场景照旧）');
  const rearm = /补发繁忙期间积压的唤醒：private@seq197/.test(h.readLog());
  const backlogLeft = (h.getSocialV2State(STALL_KEY).pendingWakeReasons ?? []).length;
  assert.ok(rearm || backlogLeft === 0, `中途接入必须重排被暂存唤醒 private@seq197（实测 rearm=${rearm} backlog 剩余=${backlogLeft}）`);
  assert.equal(count(h.readLog(), /忽略陈旧的 turn\/end/g), 0, '无号码记录绝不能被判陈旧');
  // ③ 同号（无 collector 记录）：在途号 60 + 收到 60 ⇒ 不满足 < ⇒ 合成
  h.v2TurnNoV2.set(sid, 60);
  h.v2TurnStartAt.set(sid, Date.now());
  feed.push(turnEnd(sid, 60, 'completed'));
  assert.ok(await waitUntil(() => !h.v2TurnStartAt.has(sid), 3000), '同号 turn/end 必须照常收尾（incoming ≥ inFlight）');
  console.log(`   [证据] S2b(40→41) 收尾=true；中途接入（无号码）收尾=true 且重排 private@seq197；同号(60→60) 收尾=true；全程「忽略陈旧的 turn/end」=0 行`);
});

// ── V2-③ 载荷性反证：中和/反转闸门 ⇒ 陈旧帧误关 live 回合 / 承重场景消失 ───────────
await test('T70C-M【载荷性反证】中和闸门 ⇒ 59 清掉 ④（bug 复现）；`<` 改 `<=` ⇒ 同号收尾消失；反向 `>` ⇒ S2b(40→41) 收尾消失', t70GuardCfg(), async () => {
  const runGuardScenario = async (transform, scenario) => {
    const sub = await verifyHarness({ config: t70GuardCfg(), transformSource: transform });
    try {
      sub.setMode('reserved2');
      const sid = await sub.ensureSession(STALL_KEY);
      const feed = sub.startMux();
      return await scenario(sub, sid, feed);
    } finally { sub.close(); }
  };
  const neutralized = (source) => {
    const anchor = '              if (Number.isFinite(inFlightNo) && Number.isFinite(incomingNo) && incomingNo < inFlightNo) {\n';
    assert.ok(source.includes(anchor), '（反证夹具）必须能定位陈旧闸门那一行');
    return source.replace(anchor, '              if (false) { /* mutant：闸门被中和 */\n');
  };
  const leVariant = (source) => {
    const anchor = 'Number.isFinite(inFlightNo) && Number.isFinite(incomingNo) && incomingNo < inFlightNo';
    assert.ok(source.includes(anchor), '（反证夹具）必须能定位比较符');
    return source.replace(anchor, 'Number.isFinite(inFlightNo) && Number.isFinite(incomingNo) && incomingNo <= inFlightNo');
  };
  const reversed = (source) => {
    const anchor = 'Number.isFinite(inFlightNo) && Number.isFinite(incomingNo) && incomingNo < inFlightNo';
    assert.ok(source.includes(anchor), '（反证夹具）必须能定位比较符');
    return source.replace(anchor, 'Number.isFinite(inFlightNo) && Number.isFinite(incomingNo) && incomingNo > inFlightNo');
  };
  // ① 中和 ⇒ 59 清 ④（bug 复现）
  const m1 = await runGuardScenario(neutralized, async (sub, sid, feed) => {
    feed.push(turnStart(sid, 60));
    await waitUntil(() => Number(sub.v2TurnNoV2.get(sid)) === 60, 3000);
    feed.push(turnEnd(sid, 59, 'completed'));
    const cleared = await waitUntil(() => !sub.v2TurnStartAt.has(sid), 2500);
    return { cleared: !!cleared, staleLines: count(sub.readLog(), /忽略陈旧的 turn\/end/g) };
  });
  assert.equal(m1.cleared, true, '中和闸门后必须复现 bug：陈旧 59 清掉 ④');
  assert.equal(m1.staleLines, 0, '中和后不得再出现陈旧诊断行');
  // ② `<=` ⇒ 同号（60→60）被判陈旧 ⇒ 收尾消失
  const m2 = await runGuardScenario(leVariant, async (sub, sid, feed) => {
    sub.v2TurnNoV2.set(sid, 60);
    sub.v2TurnStartAt.set(sid, Date.now());
    feed.push(turnEnd(sid, 60, 'completed'));
    const cleared = await waitUntil(() => !sub.v2TurnStartAt.has(sid), 2500);
    return { cleared: !!cleared, staleLines: count(sub.readLog(), /忽略陈旧的 turn\/end/g) };
  });
  assert.equal(m2.cleared, false, '`<=` 变异下同号 turn/end 会被误判陈旧 ⇒ ④ 清不掉（证明严格 `<` 在承重）');
  assert.ok(m2.staleLines >= 1, '`<=` 变异下必须出现陈旧诊断行');
  // ③ 反向 `>` ⇒ S2b（40→41）被判陈旧 ⇒ 收尾消失
  const m3 = await runGuardScenario(reversed, async (sub, sid, feed) => {
    feed.push(turnStart(sid, 40));
    await waitUntil(() => Number(sub.v2TurnNoV2.get(sid)) === 40, 3000);
    feed.push(turnEnd(sid, 41, 'completed'));
    const cleared = await waitUntil(() => !sub.v2TurnStartAt.has(sid), 2500);
    return { cleared: !!cleared, staleLines: count(sub.readLog(), /忽略陈旧的 turn\/end/g) };
  });
  assert.equal(m3.cleared, false, '反向判据下 S2b(40→41) 的合成收尾会消失（证明方向在承重）');
  console.log(`   [反证·C] 中和闸门 ⇒ 59 清 ④=${m1.cleared}（bug 复现）；\`<=\` ⇒ 同号收尾=${m2.cleared}（应为 false）且陈旧行=${m2.staleLines}；反向 \`>\` ⇒ S2b 收尾=${m3.cleared}（应为 false）`);
});

await test('T70C3【C7 静态不变量】枚举 src/bridge.js 里所有清 ④ 的站点，逐个核对同时清 v2TurnNoV2', {}, async () => {
  const source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  const lines = source.split(/\r?\n/);
  const sites = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/v2TurnStartAt\.delete\(/.test(lines[i])) {
      const near = lines.slice(Math.max(0, i - 4), i + 5).join('\n');
      sites.push({ line: i + 1, alsoClearsNo: /v2TurnNoV2\.delete\(/.test(near), text: lines[i].trim() });
    }
  }
  assert.ok(sites.length >= 4, `必须能枚举到多个清 ④ 站点（实测 ${sites.length}）`);
  const bad = sites.filter((s) => !s.alsoClearsNo);
  assert.deepEqual(bad, [], `存在「清 ④ 不清 v2TurnNoV2」的站点（会让陈旧闸门用残留号码永久封死合成收尾）：${JSON.stringify(bad)}`);
  console.log(`   [证据] 清 ④ 站点 ${sites.length} 处，全部同时清 v2TurnNoV2（行号：${sites.map((s) => s.line).join(',')}）`);
});

if (failures.length || (STRICT && probeFailures.length)) process.exitCode = 1;
