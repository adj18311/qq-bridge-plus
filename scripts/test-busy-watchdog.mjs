// 卡忙自愈看门狗（busy watchdog）聚焦测试 —— t2 实现自证。
//
// 背景：会话被判忙（isConversationBusyV2 的四条判据：pendingWakeTimer / pendingWakeKeys /
// promptQueues.running / v2TurnStartAt+collectors）后可以**无限期**卡住，其间的唤醒全部在
// sendWakePromptV2 / scheduleWakeV2 的忙分支被静默暂存 —— 参见 2026-10-05 08:45:41→09:11:07
// 那次「私聊 25 分钟不回复、只能人工重启」。设计冻结见 docs/guides/NEXT-TASKS-ROUND2.md §15。
//
// 本测试在**临时目录 + 假 DSH/QQ** 上跑真实的 src/bridge.js（与 audit-bridge-harness.mjs
// 同一手法：注入真函数 + 假 peer），覆盖 §15 的 A1–A6 与反例 C1–C6 关键行为：
//   · ①②④ 能释放、③ 只读；释放必须成对 disarm 30 分钟租约（C5）
//   · 持续有帧的长回合不被误杀（A4/C1）、paused/非 reserved2 完全静默（C2）
//   · 墓碑 + 迟到的 turn/end 静默排空（A3）、backlog 去重与 re-arm 走正常投递路径（A6/C4）
//   · 禁用语义（A5）、定时器 unref（A6）、释放路径异常不带走进程（A6）
// 不读线上 config.json、不写真实 state/、不连 QQ/DSH、不启动第二个守护进程。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
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
import { unwrap, createTurnCollector } from '../src/dsh-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const CONSOLE_TOKEN = 'fixture-console-token';

/** 在临时目录里跑真实桥接（假 api / 假 bot），并暴露看门狗内部结构供断言。 */
async function busyHarness({ config = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-busy-watchdog-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: CONSOLE_TOKEN, slang: { enabled: false }, ...config,
  }));
  const calls = { created: [], prompts: [], sent: [], follows: [], http: [] };
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
  const intervals = [];   // 捕获 setInterval 注册（看门狗定时器）
  const timeouts = new Set();
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
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
    promptQueues, pendingWakeKeys, pendingWakeLeaseTimers, collectors, v2TurnStartAt,
    wakeConfigUpdatedKeys, markReadCalledKeys,
    busyWatchdog, busyWatchdogConfig, runBusyWatchdogScanV2, startBusyWatchdogV2,
    markBusyRearmedWakeV2, clearBusyRearmedWakeV2,
    queued, enqueueForRetry, flushQueue,
    noteFrameActivityV2, noteActionActivityV2, clearBusyWatchdogRuntimeV2,
    createTurnCollector, pumpMux,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
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
    ...modelPrices, ...tokenLedger, ...voiceLib, ...stateAcl,
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    processAudioVolume: async (file) => ({ path: String(file), converted: false, applied: false, mode: 'original', volume: 1, loudness: null }),
    cleanupTemp: () => {},
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
    async close() {
      for (const t of timeouts) clearTimeout(t);
      fs.rmSync(temp, { recursive: true, force: true });
    },
  };
}

// 缩放的默认配置（**100 倍缩放**：warnMs 3000ms ↔ 300000ms）：让 5min/15min/30min 三档在
// 秒级跑完，且日志里的 `busy=Ns/idle=Ns` 仍是整数秒。绝不能靠真等 15 分钟，也不把默认值写进代码。
const SCALED = { warnMs: 3000, releaseMs: 9000, hardCapMs: 18000, checkIntervalMs: 1000, rearmCooldownMs: 60000, maxRearmPerHour: 3 };
const withWatchdog = (wd) => ({ socialV2: { enabled: true, busyWatchdog: { ...wd } } });

/** 造一个「② pendingWakeKeys 卡住」的会话（DSH 接受过 prompt，但永远没有 turn/end）。 */
function stuckByPendingWake(h, key = 'private:123') {
  h.setMode('reserved2');
  const st = h.getSocialV2State(key);
  h.pendingWakeKeys.add(key);
  return { key, st };
}

/** 造一个「④ 陈旧 collector（重连重建的在途回合）」的会话。 */
function seedStaleCollector(h, sid, turn = 10, text = '卡死前的回复') {
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
function ensureFrameFeed(h) {
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

async function feedFrames(h, frames, waitMs = 120) {
  const queue = ensureFrameFeed(h);
  for (const frame of frames) queue.push(frame);
  for (const wake of h.__frameWaiters.splice(0)) wake();
  await new Promise((r) => setTimeout(r, waitMs));
}

function postJson(server, pathname, body) {
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

const count = (text, re) => (String(text).match(re) ?? []).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 轮询等待某个条件成立（日志行 / 投递计数），比死等固定时长稳。 */
const waitFor = async (fn, timeoutMs = 5000, stepMs = 50) => {
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
const frameOf = (sid, event) => ({ type: 'session/event', sessionId: sid, event });
/** 一个正常收尾的回合：turn/start → assistant/message → turn/end。 */
const completedTurn = (sid, turn, text) => [
  frameOf(sid, { type: 'turn/start', data: { turn } }),
  frameOf(sid, { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } }),
  frameOf(sid, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }),
];

let failures = 0;
let caseMsTotal = 0;
let closeMsTotal = 0;
async function test(name, config, run) {
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

// ── §15.6 配置键/默认值/禁用语义 ─────────────────────────────────────────────
await test('默认阈值严格等于 t1 冻结值；未配置 config.json 也生效；非法值回落默认', {}, async (h) => {
  assert.deepEqual({ ...h.busyWatchdogConfig() }, {
    enabled: true, warnMs: 300000, releaseMs: 900000, hardCapMs: 1800000,
    checkIntervalMs: 10000, rearmCooldownMs: 60000, maxRearmPerHour: 3,
  }, '§15.6 的 7 个键与默认值必须逐条一致');
  // 秒级覆盖（验证方要用它跑 C1 的 300 秒场景，不得依赖真等 15 分钟）
  h.cfg.socialV2 = h.cfg.socialV2 ?? {};
  h.cfg.socialV2.busyWatchdog = { ...SCALED };
  const over = h.busyWatchdogConfig();
  assert.equal(over.warnMs, 3000);
  assert.equal(over.releaseMs, 9000);
  assert.equal(over.hardCapMs, 18000);
  assert.equal(over.checkIntervalMs, 1000);
  // 非法/边界值：非法回落默认；hardCapMs 0 不允许「无上限」；checkIntervalMs 下限 1000
  h.cfg.socialV2.busyWatchdog = { warnMs: 'x', releaseMs: -5, hardCapMs: 0, checkIntervalMs: 1, rearmCooldownMs: -1 };
  const bad = h.busyWatchdogConfig();
  assert.equal(bad.warnMs, 300000);
  assert.equal(bad.releaseMs, 900000);
  assert.equal(bad.hardCapMs, 1800000, 'hardCapMs=0 必须回落到 1800000（不允许无上限）');
  assert.equal(bad.checkIntervalMs, 1000, 'checkIntervalMs 下限 1000');
  assert.equal(bad.rearmCooldownMs, 0);
});

// ── A2/C5：② 释放 + 租约成对 disarm + 单行 WARN/释放日志 ──────────────────────
await test('② pendingWakeKeys 卡死：超过 releaseMs 零帧 → 释放 + disarm 租约 + 单行 WARN', withWatchdog(SCALED), async (h) => {
  const { key } = await stuckByPendingWake(h);
  const t0 = Date.now();
  h.busyWatchdog.lastFrameAtV2.set(key, t0);
  h.runBusyWatchdogScanV2(t0);                     // 建立 busySince
  assert.equal(h.pendingWakeKeys.has(key), true);
  h.runBusyWatchdogScanV2(t0 + 3000);              // WARN 档：只记录
  let log = h.readLog();
  assert.match(log, /⚠️ \[watchdog\] warn key=private:123 busy=3s idle=3s flags=pendingWakeKeys queue=running:0,tail:0 backlog=0 staleTurn=false/);
  assert.doesNotMatch(log, /\[watchdog\] release/, 'WARN 档绝不能掉进释放路径');
  assert.equal(h.pendingWakeKeys.has(key), true, 'WARN 档不得释放任何标记');
  h.runBusyWatchdogScanV2(t0 + 9000);              // 释放档
  log = h.readLog();
  assert.match(log, /⚠️ \[watchdog\] release key=private:123 busy=9s idle=9s tier=release released=pendingWakeKeys staleTurn=false backlog=0 rearm=none/);
  assert.equal(h.pendingWakeKeys.has(key), false, '② 必须被释放');
  assert.equal(h.pendingWakeLeaseTimers.has(key), false, '释放 ② 必须成对 disarm 30 分钟租约（C5）');
});

// ── A1：① 释放（clearTimeout + 置 null）────────────────────────────────────
await test('① pendingWakeTimer 卡死：clearTimeout 置 null；无 backlog 时 rearm=none', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const st = h.getSocialV2State(key);
  const origTimer = setTimeout(() => { throw new Error('看门狗没有清掉这个定时器'); }, 60000);
  st.pendingWakeTimer = origTimer;
  const t0 = Date.now();
  h.busyWatchdog.lastFrameAtV2.set(key, t0);
  assert.equal(h.isConversationBusyV2(key, st), true, '① 为真即为忙');
  h.runBusyWatchdogScanV2(t0);
  h.runBusyWatchdogScanV2(t0 + 10000);
  const log = h.readLog();
  assert.match(log, /\[watchdog\] release key=private:123 busy=10s idle=10s tier=release released=pendingWakeTimer staleTurn=false backlog=0 rearm=none/);
  assert.equal(st.pendingWakeTimer, null, '① 必须 clearTimeout 并置 null（无 backlog 时没有 re-arm 覆盖它）');
  assert.equal(origTimer._destroyed, true, '原定时器必须被 clearTimeout 销毁');
  assert.equal(h.pendingWakeKeys.has(key), false);
});

// ── A6/C4：backlog 合并：优先级降序、(reason,seq) 去重、只重排不投递 ─────────
await test('A6/C4：释放时 backlog 按优先级降序去重合并，写入 pendingWakeReasons', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const st = h.getSocialV2State(key);
  st.pendingWakeReasons = [
    { reason: 'anyMessage', seq: 197 },
    { reason: 'private', seq: 197 },
    { reason: 'private', seq: 197 }, // 重复项：必须去重
  ];
  st.pendingWakeReason = 'atMention';
  st.unread = [{ seq: 197, text: 'x' }];
  st.lastUnreadSeq = 197;
  h.pendingWakeKeys.add(key); // ② 忙
  const t0 = Date.now();
  h.busyWatchdog.lastFrameAtV2.set(key, t0);
  h.runBusyWatchdogScanV2(t0);
  h.runBusyWatchdogScanV2(t0 + 10000);
  const log = h.readLog();
  assert.match(log, /\[watchdog\] release key=private:123 .* backlog=3 rearm=private@seq197/);
  // private(100) > atMention(90) > anyMessage(50)；位置 2 的重复 private@197 被去重
  assert.deepEqual([...st.pendingWakeReasons].map((r) => `${r.reason}@${r.seq}`), ['private@197', 'atMention@197', 'anyMessage@197']);
  assert.equal(st.pendingWakeReason, 'private', '被释放①的 pendingWakeReason 必须先合并进 backlog，再由 re-arm 重新武装');
  assert.match(log, /\[reserved2\] 计划唤醒 private:123（private）/, '补发只能通过 scheduleWakeV2');
  assert.equal(h.calls.prompts.length, 0, '释放当拍不得同步直投');
  assert.equal(h.calls.sent.length, 0, '释放路径不得直接发 QQ 消息');
});

// ── A3/C4：④ 释放 + 墓碑 + 迟到 turn/end 静默排空 ───────────────────────────
await test('④ 陈旧 collector/v2TurnStartAt：释放 + 墓碑；迟到 turn/end 不发 QQ、不记 noActionCount、不补发', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.unread = [{ seq: 197, text: 'x' }];
  st.lastUnreadSeq = 197;
  st.pendingWakeReasons = [{ reason: 'private', seq: 197 }];
  seedStaleCollector(h, sid);
  const t0 = Date.now();
  h.busyWatchdog.lastFrameAtV2.set(key, t0);
  h.runBusyWatchdogScanV2(t0);
  h.runBusyWatchdogScanV2(t0 + 10000);
  const log = h.readLog();
  assert.match(log, /\[watchdog\] release key=private:123 busy=10s idle=10s tier=release released=v2TurnStartAt,collectors staleTurn=true backlog=1 rearm=private@seq197/);
  assert.equal(h.collectors.has(sid), false, '④ 的 collectors 必须释放');
  assert.equal(h.v2TurnStartAt.has(sid), false, '④ 的 v2TurnStartAt 必须释放');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sid), true, '必须留墓碑');
  assert.equal(h.busyWatchdog.busyStallsV2.get(key), 1);
  // 释放**只清标记 + re-arm**，不得旁路直发消息
  assert.equal(h.calls.sent.length, 0, '释放路径不得直接发 QQ 消息');
  assert.equal(h.calls.prompts.length, 0, '投递只能通过 scheduleWakeV2 的合并窗，不能同步直投');
  // 释放后 DSH 侧又送达一份重建快照（rebuildInFlightCollector 同款）：collector 重新出现，
  // 随后迟到的 turn/end 必须被墓碑静默排空。
  const noActionBefore = st.wakeConfig.noActionCount || 0;
  seedStaleCollector(h, sid);
  await feedFrames(h, [{ type: 'session/event', sessionId: sid, event: { type: 'turn/end', data: { turn: 10, reason: { kind: 'completed' } } } }]);
  assert.match(h.readLog(), /\[watchdog\] 静默排空被释放回合的 turn\/end key=private:123 session=/);
  assert.equal(h.calls.sent.length, 0, '墓碑后的 turn/end 不得发出任何 QQ 消息');
  assert.equal(st.wakeConfig.noActionCount || 0, noActionBefore, '墓碑后的 turn/end 不得改 noActionCount');
  assert.doesNotMatch(h.readLog(), /补发繁忙期间积压的唤醒/, '墓碑后的 turn/end 不得做 backlog 补发');
  assert.doesNotMatch(h.readLog(), /AI 内部输出（不自动转发）/, '墓碑后的 turn/end 不得走 reserved2 的收尾/输出路径');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sid), false, '墓碑必须在排空时消费掉（不引入新泄漏）');
  assert.equal(h.collectors.has(sid), false);
});

await test('对照组：没有墓碑时同一 turn/end 会正常走收尾路径（证明上一条是被墓碑挡住的）', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  seedStaleCollector(h, sid, 10, '正常回合的回复');
  h.runBusyWatchdogScanV2(Date.now()); // idle=0：不是卡死，不释放
  await feedFrames(h, [{ type: 'session/event', sessionId: sid, event: { type: 'turn/end', data: { turn: 10, reason: { kind: 'completed' } } } }]);
  const log = h.readLog();
  assert.match(log, /\[reserved2\] AI 内部输出（不自动转发）\(private:123\): 正常回合的回复/, `无墓碑时必须走正常收尾路径；log=\n${log}`);
  assert.equal(st.wakeConfig.noActionCount || 0, 1, '无墓碑时该回合照常记 noActionCount');
  assert.equal(log.includes('静默排空'), false);
});

// ── A4/C1/C6：有帧＝没卡死；300s/600s 只 WARN ───────────────────────────────
await test('持续有帧的长忙会话不被误杀（忙满 hardCapMs 也不释放、不 WARN）', withWatchdog(SCALED), async (h) => {
  const { key } = await stuckByPendingWake(h);
  const sid = await h.ensureSession(key);
  const t0 = Date.now();
  h.busyWatchdog.lastFrameAtV2.set(key, t0);
  h.runBusyWatchdogScanV2(t0);
  // 正常长回合：每一步 tool/call+tool/result 都是帧（这里 3000ms 当作 30s）
  for (let i = 1; i <= 4; i += 1) h.noteFrameActivityV2(sid, t0 + i * 3000);
  h.runBusyWatchdogScanV2(t0 + 13000);
  h.noteFrameActivityV2(sid, t0 + 50000);
  h.runBusyWatchdogScanV2(t0 + 51000); // busy=51s >= hardCapMs=18s，但 idle 只有 1s
  const log = h.readLog();
  assert.doesNotMatch(log, /\[watchdog\] release/, '有帧的忙会话绝不能被释放（A4，§15.4 与 A4 冲突时以 A4 为准）');
  assert.doesNotMatch(log, /\[watchdog\] warn/, 'idle 始终 < warnMs，不该有 WARN');
  assert.equal(h.pendingWakeKeys.has(key), true);
});

await test('C1：300s/600s 零帧只 WARN（合法长等），900s 才释放', withWatchdog(SCALED), async (h) => {
  const { key } = await stuckByPendingWake(h);
  const t0 = Date.now();
  h.busyWatchdog.lastFrameAtV2.set(key, t0);
  h.runBusyWatchdogScanV2(t0);
  h.runBusyWatchdogScanV2(t0 + 3000);
  h.runBusyWatchdogScanV2(t0 + 6000);   // 两次满等 ≈ 10 分钟零帧
  let log = h.readLog();
  assert.equal(count(log, /\[watchdog\] warn/g), 2, `两次满等各记一条 WARN；log=\n${log}`);
  assert.match(log, /idle=3s/);
  assert.match(log, /idle=6s/);
  assert.doesNotMatch(log, /\[watchdog\] release/, '900s 之前绝不释放');
  assert.equal(h.pendingWakeKeys.has(key), true);
  h.runBusyWatchdogScanV2(t0 + 9000);
  log = h.readLog();
  assert.match(log, /\[watchdog\] release key=private:123 busy=9s idle=9s tier=release/);
  // 反证：把 releaseMs 配成 300s = 5 分钟就会误杀一次合法长等 —— 所以默认必须是 15 分钟
  h.pendingWakeKeys.add(key);
  h.cfg.socialV2.busyWatchdog.releaseMs = 3000;
  h.busyWatchdog.busySinceV2.set(key, t0 + 20000);
  h.busyWatchdog.lastFrameAtV2.set(key, t0 + 20000);
  h.runBusyWatchdogScanV2(t0 + 23000); // busy=3s、idle=3s：5 分钟档会在这里误杀
  assert.match(h.readLog(), /\[watchdog\] release key=private:123 busy=3s idle=3s tier=release/, 'releaseMs=300s（5 分钟）时会在合法长等的点上误杀（C1 的量化说明）');
});

// ── §15.7：硬上限档（busy 满 hardCapMs、零帧只到 WARN 档）用 ❗ + tier=hardcap ──
await test('硬上限档：busy 满 hardCapMs 且零帧只到 WARN 档 → ❗ tier=hardcap 释放', withWatchdog(SCALED), async (h) => {
  const { key } = await stuckByPendingWake(h);
  const t0 = Date.now();
  h.busyWatchdog.busySinceV2.set(key, t0);
  h.busyWatchdog.lastFrameAtV2.set(key, t0 + 25000); // 零帧 5s：够 WARN(3s)、不够 release(9s)
  h.runBusyWatchdogScanV2(t0 + 30000);                // busy=30s >= hardCapMs=18s
  const log = h.readLog();
  assert.match(log, /❗ \[watchdog\] release key=private:123 busy=30s idle=5s tier=hardcap released=pendingWakeKeys/, `硬上限档格式必须用 ❗ + tier=hardcap；log=\n${log}`);
  assert.equal(h.pendingWakeKeys.has(key), false);
  // 释放后计时重置：同一卡死状态不会被每个扫描周期反复释放
  assert.equal(h.busyWatchdog.busySinceV2.get(key), t0 + 30000);
  assert.equal(count(h.readLog(), /\[watchdog\] release key=private:123/g), 1);
});

// ── ③ promptQueues：只读，绝不写队列（§15.2 表最后一行 / §15.5 第 6 步）───────
await test('③ promptQueues 卡住：只读不改队列，无可释放标记时只按 WARN 记录', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const st = h.getSocialV2State(key);
  // 造一个「队列头永不返回」的队列：running=true 且队尾还有一项（其 Promise 由调用方 await）
  const entry = { queue: [], running: true };
  let settled = 0;
  entry.queue.push({ promptText: 'x', opts: {}, resolve: () => { settled += 1; }, reject: () => { settled += 1; } });
  h.promptQueues.set(key, entry);
  assert.equal(h.isConversationBusyV2(key, st), true, '③ 为真即为忙');
  const t0 = Date.now();
  h.busyWatchdog.lastFrameAtV2.set(key, t0);
  h.runBusyWatchdogScanV2(t0);
  h.runBusyWatchdogScanV2(t0 + 30000); // busy=30s >= hardCapMs=18s
  const log = h.readLog();
  assert.match(log, /⚠️ \[watchdog\] warn key=private:123 busy=30s idle=30s flags=promptQueues queue=running:1,tail:1 backlog=0 staleTurn=false/, `③ 只读场景必须按 WARN 记录；log=\n${log}`);
  assert.doesNotMatch(log, /\[watchdog\] release/, '③ 没有可释放的标记：不得打 release 行');
  assert.equal(h.promptQueues.get(key), entry, '队列本体绝不能被替换/删除');
  assert.equal(entry.running, true, 'promptQueues.running 绝不能被写');
  assert.equal(entry.queue.length, 1, '队列项（有人 await 的 Promise）绝不能被清');
  assert.equal(settled, 0, '不得伪造 success/error 去 resolve/reject 队列项');
  assert.equal(h.busyWatchdog.busyStallsV2.size, 0, '未发生任何释放');
  // 队列正常排空后忙态自然消散，忙→闲边沿清除计时
  h.promptQueues.delete(key);
  h.runBusyWatchdogScanV2(t0 + 31000);
  assert.equal(h.busyWatchdog.busySinceV2.has(key), false, '忙→闲边沿必须清除 busySince');
});

// ── C2：paused / 非 reserved2 / 未授权 → 完全静默 ───────────────────────────
await test('C2：paused（控制台写入）与非 reserved2 完全静默、不释放、计时被重置', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  h.getSocialV2State(key);
  seedStaleCollector(h, sid); // ④ 忙；暂停不应释放它
  const t0 = Date.now();
  h.busyWatchdog.lastFrameAtV2.set(key, t0);
  h.runBusyWatchdogScanV2(t0);
  assert.equal(h.busyWatchdog.busySinceV2.has(key), true);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await postJson(server, '/api/socialV2/activity', { paused: true });
    assert.equal(res.status, 200, res.body);
    assert.equal(h.socialV2.paused, true);
    assert.equal(h.busyWatchdog.busySinceV2.size, 0, 'paused 写入必须重置看门狗计时（否则恢复后会立刻释放）');
    h.runBusyWatchdogScanV2(t0 + 50000);
    assert.equal(h.collectors.has(sid), true, 'paused 时不得释放 ④');
    assert.equal(h.busyWatchdog.staleBusyTurns.size, 0, 'paused 时不得留墓碑');
    assert.equal(h.busyWatchdog.busyStallsV2.size, 0, 'paused 时不得发生任何释放');
    assert.equal(count(h.readLog(), /\[watchdog\] (warn|release)/g), 0, 'paused 时连 WARN 都不打');
    // 切模式（控制台端点）同样必须清运行时计时
    h.socialV2.paused = false;
    h.runBusyWatchdogScanV2(t0 + 51000);
    assert.equal(h.busyWatchdog.busySinceV2.has(key), true, '恢复后重新计一次');
    const modeRes = await postJson(server, '/api/mode', { mode: 'chat' });
    assert.equal(modeRes.status, 200, modeRes.body);
    assert.equal(h.busyWatchdog.busySinceV2.size, 0, '模式切换必须重置看门狗计时（反例 C2/C3）');
  } finally {
    server.closeAllConnections?.();   // 收掉可能挂着的 keep-alive 连接，别让空闲 socket 吊住事件循环
    await new Promise((resolve) => server.close(resolve));
  }
  h.setMode('chat'); // 已通过 /api/mode 切到 chat：看门狗必须完全静默
  h.pendingWakeKeys.add(key);
  const silentBefore = count(h.readLog(), /\[watchdog\] (warn|release)/g);
  h.runBusyWatchdogScanV2(t0 + 90000);
  assert.equal(h.pendingWakeKeys.has(key), true, '非 reserved2 时不得释放 ②');
  assert.equal(count(h.readLog(), /\[watchdog\] (warn|release)/g), silentBefore, '非 reserved2 时完全静默');
});

// ── A5：禁用语义 ────────────────────────────────────────────────────────────
await test('A5：enabled:false → 不注册定时器、无任何 [watchdog] 日志、不释放', withWatchdog({ ...SCALED, enabled: false }), async (h) => {
  assert.equal(h.busyWatchdog.timer, null, '禁用时不得注册扫描定时器');
  assert.equal(h.busyWatchdog.started, false);
  assert.equal(h.intervals.filter((it) => it === h.busyWatchdog.timer).length, 0);
  assert.equal(h.intervals.filter((it) => it.ms === SCALED.checkIntervalMs).length, 0, '禁用时不得按 checkIntervalMs 注册定时器');
  const { key } = await stuckByPendingWake(h);
  const t0 = Date.now();
  h.busyWatchdog.lastFrameAtV2.set(key, t0);
  h.runBusyWatchdogScanV2(t0);
  h.runBusyWatchdogScanV2(t0 + 100000);
  assert.equal(h.pendingWakeKeys.has(key), true, '禁用后不得释放任何标记');
  assert.equal(h.readLog().includes('[watchdog]'), false, '禁用后不得有任何看门狗日志');
  h.startBusyWatchdogV2();
  assert.equal(h.busyWatchdog.timer, null, '显式启动也要尊重 enabled:false');
});

// ── A6：定时器 unref / checkIntervalMs / 启动去重 ───────────────────────────
await test('A6：定时器按 checkIntervalMs 注册且 unref；重复启动不产生第二个定时器', withWatchdog({ ...SCALED, checkIntervalMs: 7000 }), async (h) => {
  const mine = h.intervals.find((it) => it === h.busyWatchdog.timer);
  assert.ok(mine, `启动期应注册看门狗定时器（intervals=${h.intervals.map((i) => i.ms).join(',')}）`);
  assert.equal(h.intervals.filter((it) => it === h.busyWatchdog.timer).length, 1, '看门狗只应有一个定时器');
  assert.equal(mine.ms, 7000, '周期必须取自 cfg.socialV2.busyWatchdog.checkIntervalMs');
  assert.equal(mine.unrefCalled, true, '定时器必须 unref，不得把进程钉住');
  assert.equal(h.busyWatchdog.started, true);
  const { key } = await stuckByPendingWake(h);
  h.intervals[0].fn(); // 手动触发一次定时器回调
  assert.equal(h.busyWatchdog.busySinceV2.has(key), true, '定时器回调必须真的扫描');
  h.startBusyWatchdogV2();
  assert.equal(h.intervals.filter((it) => it.ms === 7000).length, 1, '重复启动必须去重');
});

// ── A6/C4：re-arm 走正常投递路径、不重复投递 ────────────────────────────────
await test('A6/C4：释放后 re-arm 走 scheduleWakeV2→正常投递路径补发；cooldown 内不重复补发', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const st = h.getSocialV2State(key);
  st.wakeConfig.batchWindowMs = 1000;          // 把合并窗缩到 1s
  st.unread = [{ seq: 197, text: 'x' }];
  st.lastUnreadSeq = 197;
  st.pendingWakeReasons = [{ reason: 'anyMessage', seq: 197 }, { reason: 'private', seq: 197 }, { reason: 'private', seq: 197 }];
  h.pendingWakeKeys.add(key);
  const t0 = Date.now();
  h.busyWatchdog.lastFrameAtV2.set(key, t0);
  h.runBusyWatchdogScanV2(t0);
  h.runBusyWatchdogScanV2(t0 + 10000);
  let log = h.readLog();
  assert.match(log, /\[watchdog\] release key=private:123 busy=10s idle=10s tier=release .* backlog=2 rearm=private@seq197/);
  assert.ok(st.pendingWakeTimer, 're-arm 必须排上 scheduleWakeV2 的合并窗定时器');
  assert.match(log, /\[reserved2\] 计划唤醒 private:123（private）/, 're-arm 必须走既有的 scheduleWakeV2 路径');
  assert.equal(h.calls.prompts.length, 0);
  assert.equal(h.calls.sent.length, 0);
  // 合并窗到期 → sendWakePromptV2 → deliverPrompt → api.sessions.prompt（正常投递路径）
  await new Promise((r) => setTimeout(r, 1400));
  assert.equal(h.calls.prompts.length, 1, '补发必须走正常投递路径（api.sessions.prompt）');
  assert.equal(count(h.readLog(), /\[reserved2\] 唤醒 private:123（private）/g), 1);
  assert.equal(h.calls.sent.length, 0, '补发不得旁路直发 QQ');
  // cooldown 内再释放一次：不得产生第二次补发
  h.runBusyWatchdogScanV2(t0 + 40000); // 距上次 re-arm 30s < rearmCooldownMs 60s
  log = h.readLog();
  const releases = log.match(/\[watchdog\] release key=private:123[^\n]*/g) ?? [];
  assert.equal(releases.length, 2, `应恰好两次释放：${JSON.stringify(releases)}`);
  assert.match(releases[1], /rearm=none/, 'cooldown 内第二次释放不得再 re-arm');
  assert.equal(h.calls.prompts.length, 1, '同一 reason 不得重复投递');
  assert.equal(count(log, /\[reserved2\] 唤醒 private:123（private）/g), 1);
  assert.equal((h.busyWatchdog.rearmV2.get(key) ?? []).length, 1);
});

// ══ F1 回归（t6）：同一 (reason,seq) 不得被二次补发 ═══════════════════════════
// 复现 t3 判定的 F1 触发路径：判据② 单独卡忙 → 看门狗释放并 re-arm（第 1 次投递）→
// 该回合收尾调 qq_set_wake_config 且**未带 throughSeq**（unread 不清）→ 交接点不是提醒路径，
// 原回合迟到的 turn/end 走到「繁忙期间积压的唤醒」补发 shift 时，同一条 (private,197)
// 会被再排一次 scheduleWakeV2（第 2 次投递）。
await test('F1 回归：② 单独卡忙 + re-arm 后迟到 turn/end（收尾 set_wake_config 不带 throughSeq）不得二次补发', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.wakeConfig.batchWindowMs = 1000;                                  // 合并窗缩到 1s
  // 关掉与 F1 无关的「唤醒频率硬限制」（桥接默认 maxWakePerMinute=1 会在同一分钟里
  // 顺手挡掉第 2 次投递，让本用例失去区分力）：这里要测的是 (reason,seq) 去重本身。
  h.cfg.socialV2.wake = { ...(h.cfg.socialV2.wake ?? {}), maxWakePerMinute: 0, maxWakePerHour: 0 };
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  h.pendingWakeKeys.add(key);                                          // ② 单独卡忙
  h.scheduleWakeV2(key, 'private');                                    // 真实忙分支 → 暂存 private@seq197
  assert.match(h.readLog(), /会话繁忙，暂存唤醒原因 private:123（private@seq197）/, '必须是真实暂存路径');
  const t0 = Date.now();
  h.busyWatchdog.lastFrameAtV2.set(key, t0);
  h.runBusyWatchdogScanV2(t0);
  h.runBusyWatchdogScanV2(t0 + 10000);                                 // 释放 + re-arm
  let log = h.readLog();
  const releases = log.match(/\[watchdog\] release key=private:123[^\n]*/g) ?? [];
  assert.equal(releases.length, 1, `恰好一次释放：${JSON.stringify(releases)}`);
  assert.match(releases[0], /rearm=private@seq197/);
  assert.ok([...st.pendingWakeReasons].some((r) => r.reason === 'private' && r.seq === 197),
    '被 re-arm 的那条仍留在 backlog（t3 T4 的前置断言，不得改成“从 backlog 删掉”）');
  // 第 1 次（也是唯一一次）投递：合并窗 → sendWakePromptV2 → deliverPrompt → api.sessions.prompt
  await sleep(1200);
  log = h.readLog();
  assert.equal(count(log, /\[reserved2\] 唤醒 private:123（private）/g), 1);
  assert.equal(h.calls.prompts.length, 1);
  assert.equal(h.pendingWakeKeys.has(key), true, '补发投递本身又派生了新的 ②');
  // 模型在该回合收尾调 set_wake_config（未带 throughSeq ⇒ unread 不清）
  h.wakeConfigUpdatedKeys.add(key);
  await feedFrames(h, completedTurn(sid, 1, '看门狗补发后的回复'), 400);
  // 等满一个合并窗（1000ms）再看：若该条被 turn/end 再排一次，第 2 次投递也会落进这段窗口，
  // 于是「计数=1」断言同时覆盖“重复排程”和“重复投递”两件事。
  await sleep(1300);
  log = h.readLog();
  assert.equal(count(log, /\[reserved2\] 唤醒 private:123（private）/g), 1,
    `F1：同一 (private,seq197) 只能投递一次（计数=1）；log=\n${log}`);
  assert.equal(h.calls.prompts.length, 1, '只允许一次正常投递（计数=1）');
  assert.match(log, /繁忙期间唤醒 private@seq197 已由看门狗重新武装补发，跳过重复补发/);
  assert.doesNotMatch(log, /补发繁忙期间积压的唤醒：private@seq197/, '不得再排一次 scheduleWakeV2');
  assert.equal(count(log, /\[reserved2\] 计划唤醒 private:123（private）/g), 1,
    '幂等证据：同一 (reason,seq) 在「释放 → re-arm → 迟到 turn/end」全生命周期内只被 scheduleWakeV2 排一次');
  assert.equal([...st.pendingWakeReasons].filter((r) => r.reason === 'private' && r.seq === 197).length, 0,
    '该条已在 turn/end 时被消费，不在 backlog 残留');
  assert.equal(h.busyWatchdog.rearmedWakeV2.has(key), false, '一次性标记必须被消费（不残留）');
  console.log(`   [证据] 全生命周期 计划唤醒 private=${count(log, /\[reserved2\] 计划唤醒 private:123（private）/g)} 次；`
    + `唤醒投递=${count(log, /\[reserved2\] 唤醒 private:123（private）/g)} 次；api.sessions.prompt=${h.calls.prompts.length} 次；`
    + `watchdog release=${releases.length} 次（rearm=private@seq197）`);
});

// F1 不得“整批跳过补发”：其它不同 (reason,seq) 的合法补发必须照旧，且仍按 wakePriorityV2 降序。
await test('F1 反面：只跳过被 re-arm 的那条，其它不同 (reason,seq) 的合法补发不受影响', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.wakeConfig.batchWindowMs = 1000;
  // 关掉与 F1 无关的唤醒频率硬限制：本用例要证明「两条不同 (reason,seq) 各自只排一次」。
  h.cfg.socialV2.wake = { ...(h.cfg.socialV2.wake ?? {}), maxWakePerMinute: 0, maxWakePerHour: 0 };
  st.unread = [{ seq: 197, text: '在吗' }, { seq: 198, text: '还在吗' }];  // 两条不同 seq 都还“相关”
  st.lastUnreadSeq = 198;
  st.pendingWakeReasons = [{ reason: 'anyMessage', seq: 198 }, { reason: 'private', seq: 197 }];
  h.pendingWakeKeys.add(key);
  const t0 = Date.now();
  h.busyWatchdog.lastFrameAtV2.set(key, t0);
  h.runBusyWatchdogScanV2(t0);
  h.runBusyWatchdogScanV2(t0 + 10000);
  const release = (h.readLog().match(/\[watchdog\] release key=private:123[^\n]*/g) ?? [])[0];
  // 降序：private(100) 先于 anyMessage(50) 被 re-arm
  assert.match(release, /backlog=2 rearm=private@seq197/, `必须按 wakePriorityV2 降序取 top：${release}`);
  await sleep(1200);
  assert.equal(count(h.readLog(), /\[reserved2\] 唤醒 private:123（private）/g), 1);
  // turn/end #1：shift 到的正是被 re-arm 的 private@197 → 跳过（不投递第 2 次）
  h.wakeConfigUpdatedKeys.add(key);
  await feedFrames(h, completedTurn(sid, 1, '第一个回合'), 350);
  await sleep(300);
  assert.equal(count(h.readLog(), /\[reserved2\] 唤醒 private:123（private）/g), 1, 'private@197 不得二次投递');
  // turn/end #2：shift 到 anyMessage@198（没有任何标记）→ 照旧补发
  await feedFrames(h, completedTurn(sid, 2, '第二个回合'), 350);
  await sleep(1300);
  const log = h.readLog();
  assert.match(log, /补发繁忙期间积压的唤醒：anyMessage@seq198/, '不同 (reason,seq) 的合法补发不得被削弱');
  assert.equal(count(log, /\[reserved2\] 唤醒 private:123（anyMessage）/g), 1, `anyMessage@198 必须真的投递；log=\n${log}`);
  assert.equal(count(log, /\[reserved2\] 唤醒 private:123（private）/g), 1, 'private@197 仍然只有一次');
  assert.equal(count(log, /\[reserved2\] 计划唤醒 private:123（private）/g), 1, 'private@197 只被 scheduleWakeV2 排一次');
  assert.equal(count(log, /\[reserved2\] 计划唤醒 private:123（anyMessage）/g), 1, 'anyMessage@198 只被 scheduleWakeV2 排一次');
  assert.equal(h.calls.prompts.length, 2, '两条不同唤醒各自投递一次');
});

// F1 不得丢消息：若 re-arm 时会话仍忙（③ 队列卡住）而被再次暂存，该 (reason,seq) 必须仍可投递。
await test('F1 不丢消息：re-arm 被再次暂存（③ 仍卡住）→ 不登记标记、留在 backlog 并仍能补发', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.wakeConfig.batchWindowMs = 1000;
  h.cfg.socialV2.wake = { ...(h.cfg.socialV2.wake ?? {}), maxWakePerMinute: 0, maxWakePerHour: 0 };
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  h.pendingWakeKeys.add(key);
  h.scheduleWakeV2(key, 'private');                       // 暂存 private@197
  const queueEntry = { queue: [], running: true };        // ③ 队列卡住：释放 ①②④ 后仍判忙
  h.promptQueues.set(key, queueEntry);
  const t0 = Date.now();
  h.busyWatchdog.lastFrameAtV2.set(key, t0);
  h.runBusyWatchdogScanV2(t0);
  h.runBusyWatchdogScanV2(t0 + 10000);
  const release = (h.readLog().match(/\[watchdog\] release key=private:123[^\n]*/g) ?? [])[0];
  assert.match(release, /rearm=none/, '排不上合并窗定时器就不算 re-arm');
  assert.equal(st.pendingWakeTimer, null);
  assert.equal(h.busyWatchdog.rearmedWakeV2.has(key), false, '未真正排上的条目绝不能登记（否则就是丢消息）');
  assert.ok([...st.pendingWakeReasons].some((r) => r.reason === 'private' && r.seq === 197),
    '被再次暂存的 (reason,seq) 必须仍在 backlog 等待投递');
  h.promptQueues.delete(key);                             // 队列恢复
  await feedFrames(h, completedTurn(sid, 1, '队列恢复后的回合'), 350);
  await sleep(1300);
  const log = h.readLog();
  assert.match(log, /补发繁忙期间积压的唤醒：private@seq197/, '未被 re-arm 的条目必须走正常补发（未丢消息）');
  assert.equal(count(log, /\[reserved2\] 唤醒 private:123（private）/g), 1, '该唤醒最终必须投递出去');
  assert.equal(h.calls.prompts.length, 1);
});

// ══ F3 回归（t8）：投递未真正生效时防重复登记必须被清除 ══════════════════════
// 四类「投递未真正生效」：① 被 DSH 拒绝 ② 投递抛错 ③ skipWake（paused/非 reserved2/二代关闭）
// ④ 定时器已排上后又被「会话仍繁忙」分支再次暂存；另有 ⑤ 唤醒频率额度跳过。
// 共同断言：标记被清 → 条目仍在 backlog → 下一次 turn/end 的 shift 仍能补发并真的送达。
// 反向断言（防过度清理）：queued/retried（= 已交给正常路径、稍后会送达）**必须保留**标记，否则 F1 复发。
const stuckBacklogFor = (h, key, seq = 197) => {
  const st = h.getSocialV2State(key);
  st.unread = [{ seq, text: '在吗' }];
  st.lastUnreadSeq = seq;
  st.pendingWakeReasons = [{ reason: 'private', seq }];
  st.wakeConfig.batchWindowMs = 1000;
  h.cfg.socialV2.wake = { ...(h.cfg.socialV2.wake ?? {}), maxWakePerMinute: 0, maxWakePerHour: 0 };
  return st;
};
const releaseAndRearm = (h, key) => {
  const t0 = Date.now();
  h.busyWatchdog.lastFrameAtV2.set(key, t0);
  h.runBusyWatchdogScanV2(t0);
  h.runBusyWatchdogScanV2(t0 + 10000);
  return (h.readLog().match(/\[watchdog\] release key=private:123[^\n]*/g) ?? [])[0] ?? '';
};

await test('F3-a 投递被 DSH 拒绝 → 标记被清除、条目留在 backlog 并被重排后送达', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = stuckBacklogFor(h, key);
  h.pendingWakeKeys.add(key);                                    // ② 单独卡忙
  const release = releaseAndRearm(h, key);
  assert.match(release, /rearm=private@seq197/, `必须真的排上 re-arm：${release}`);
  assert.equal(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197'), true, '排上定时器时必须登记（F1 保护）');
  h.api.sessions.prompt = async () => ({ result: { ok: false, error: { code: 'fixture_unavailable', message: 'DSH 暂不可用' } } });
  await waitFor(() => /唤醒投递被拒 private:123/.test(h.readLog()));
  let log = h.readLog();
  assert.match(log, /唤醒投递被拒 private:123/, `必须走「被拒」分支；log=\n${log}`);
  assert.equal(h.busyWatchdog.rearmedWakeV2.has(key), false, 'F3：被拒后标记必须被清除（否则该条既不再投递也不再重排）');
  assert.ok([...st.pendingWakeReasons].some((r) => r.reason === 'private' && r.seq === 197), '被拒的条目必须仍在 backlog');
  assert.equal([...st.pendingWakeReasons].length, 1, '不得复制出第二条（仍按 (reason,seq) 去重）');
  h.api.sessions.prompt = async (params) => { h.calls.prompts.push(params); return { result: { ok: true, value: {} } }; };
  h.wakeConfigUpdatedKeys.add(key);
  await feedFrames(h, completedTurn(sid, 1, '恢复后的回合'), 400);
  await waitFor(() => /补发繁忙期间积压的唤醒：private@seq197/.test(h.readLog()));
  await waitFor(() => h.calls.prompts.length >= 1);
  await sleep(150);
  log = h.readLog();
  assert.match(log, /补发繁忙期间积压的唤醒：private@seq197/, 'F3：必须被重排（不得静默丢弃）');
  assert.equal(count(log, /\[reserved2\] 唤醒 private:123（private）/g), 2, '尝试 2 次（被拒 1 + 重试 1）');
  assert.equal(h.calls.prompts.length, 1, '重试那一次必须真的送达');
  assert.equal([...st.pendingWakeReasons].length, 0, '重排后 backlog 被消费');
  console.log(`   [证据] 被拒 ${count(log, /唤醒投递被拒/g)} 次；重排补发 ${count(log, /补发繁忙期间积压的唤醒：private@seq197/g)} 次；`
    + `成功送达 ${h.calls.prompts.length} 次；残留登记=${h.busyWatchdog.rearmedWakeV2.has(key)}`);
});

await test('F3-b 投递抛错 → 标记被清除、条目留在 backlog 并被重排后送达', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = stuckBacklogFor(h, key);
  h.pendingWakeKeys.add(key);
  const release = releaseAndRearm(h, key);
  assert.match(release, /rearm=private@seq197/);
  h.api.sessions.prompt = async () => { throw new Error('fixture dsh timeout'); };
  await waitFor(() => /唤醒投递失败 private:123: fixture dsh timeout/.test(h.readLog()));
  let log = h.readLog();
  assert.match(log, /唤醒投递失败 private:123: fixture dsh timeout/, '必须走「投递失败」分支');
  assert.equal(h.busyWatchdog.rearmedWakeV2.has(key), false, 'F3：抛错后标记必须被清除');
  assert.ok([...st.pendingWakeReasons].some((r) => r.reason === 'private' && r.seq === 197), '抛错的条目必须仍在 backlog');
  h.api.sessions.prompt = async (params) => { h.calls.prompts.push(params); return { result: { ok: true, value: {} } }; };
  h.wakeConfigUpdatedKeys.add(key);
  await feedFrames(h, completedTurn(sid, 1, '恢复后的回合'), 400);
  await waitFor(() => /补发繁忙期间积压的唤醒：private@seq197/.test(h.readLog()));
  await waitFor(() => h.calls.prompts.length >= 1);
  await sleep(150);
  log = h.readLog();
  assert.match(log, /补发繁忙期间积压的唤醒：private@seq197/, 'F3：必须被重排（不得静默丢弃）');
  assert.equal(h.calls.prompts.length, 1, '重试那一次必须真的送达');
  console.log(`   [证据] 投递失败 ${count(log, /唤醒投递失败 private:123/g)} 次；重排补发 ${count(log, /补发繁忙期间积压的唤醒：private@seq197/g)} 次；`
    + `成功送达 ${h.calls.prompts.length} 次；残留登记=${h.busyWatchdog.rearmedWakeV2.has(key)}`);
});

await test('F3-c 派发时被跳过（skipWake：paused）→ 标记被清除、条目留在 backlog 并可补发', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = stuckBacklogFor(h, key);
  h.busyWatchdog.rearmedWakeV2.set(key, new Set(['private@197'])); // 等价于「看门狗刚登记完、还没派发」
  h.socialV2.paused = true;
  const queued = await h.deliverPrompt(key, 'x', { wakeReason: 'private', wakeSeq: 197 });
  assert.deepEqual({ ...queued }, { ok: true, skipped: true }, '必须走 skipWake 分支');
  assert.equal(h.busyWatchdog.rearmedWakeV2.has(key), false, 'F3：被跳过必须清标记');
  assert.ok([...st.pendingWakeReasons].some((r) => r.reason === 'private' && r.seq === 197), '被跳过的条目必须仍在 backlog');
  assert.equal(h.calls.prompts.length, 0, '跳过 = 没有调用 DSH');
  h.socialV2.paused = false;
  h.wakeConfigUpdatedKeys.add(key);
  await feedFrames(h, completedTurn(sid, 1, '恢复后的回合'), 400);
  await waitFor(() => /补发繁忙期间积压的唤醒：private@seq197/.test(h.readLog()));
  await waitFor(() => h.calls.prompts.length >= 1);
  await sleep(150);
  const log = h.readLog();
  assert.match(log, /补发繁忙期间积压的唤醒：private@seq197/, '恢复后必须补发');
  assert.equal(count(log, /\[reserved2\] 唤醒 private:123（private）/g), 1, '必须真的送达一次');
  assert.equal(h.calls.prompts.length, 1);
});

await test('F3-d 定时器已排上后又被「会话仍忙」再次暂存 → 标记被清除、条目仍在 backlog', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = stuckBacklogFor(h, key);
  h.pendingWakeKeys.add(key);
  const release = releaseAndRearm(h, key);
  assert.match(release, /rearm=private@seq197/);
  assert.equal(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197'), true);
  // 合并窗到期时该会话又「忙」了（④：一个 live turn 正在进行）→ sendWakePromptV2 走忙分支再次暂存
  st.unread = [{ seq: 197, text: '在吗' }];
  h.v2TurnStartAt.set(sid, Date.now());
  await waitFor(() => /会话繁忙，暂存唤醒原因 private:123（private@seq197）/.test(h.readLog()));
  let log = h.readLog();
  assert.match(log, /会话繁忙，暂存唤醒原因 private:123（private@seq197）/, '必须走派发时的忙分支');
  assert.equal(h.busyWatchdog.rearmedWakeV2.has(key), false, 'F3-d：被再次暂存必须清标记（否则 shift 会跳过它）');
  assert.ok([...st.pendingWakeReasons].some((r) => r.reason === 'private' && r.seq === 197), '条目仍在 backlog（等待下一次窗口）');
  assert.equal(h.calls.prompts.length, 0, '这次唤醒没有送出去');
  // ④ 消失后，下一次 turn/end 的 shift 必须照常补发并送达
  h.v2TurnStartAt.delete(sid);
  h.wakeConfigUpdatedKeys.add(key);
  await feedFrames(h, completedTurn(sid, 1, '窗口恢复后的回合'), 400);
  await waitFor(() => /补发繁忙期间积压的唤醒：private@seq197/.test(h.readLog()));
  await waitFor(() => h.calls.prompts.length >= 1);
  await sleep(150);
  log = h.readLog();
  assert.match(log, /补发繁忙期间积压的唤醒：private@seq197/, '窗口恢复后必须补发');
  assert.equal(count(log, /\[reserved2\] 唤醒 private:123（private）/g), 1, '最终必须送达一次');
  assert.equal(h.calls.prompts.length, 1);
});

await test('F3-e 投递被唤醒频率额度跳过 → 标记被清除、条目留在 backlog', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  await h.ensureSession(key);
  const st = stuckBacklogFor(h, key);
  h.cfg.socialV2.wake = { ...(h.cfg.socialV2.wake ?? {}), maxWakePerMinute: 1, maxWakePerHour: 0 };
  st.wakeTimes = [Date.now()];                                   // 本分钟额度已用掉
  h.busyWatchdog.rearmedWakeV2.set(key, new Set(['private@197']));
  await h.sendWakePromptV2(key, 'private', { seq: 197 });
  assert.match(h.readLog(), /唤醒频率超限，跳过 private:123（private）/, '必须走额度跳过分支');
  assert.equal(h.busyWatchdog.rearmedWakeV2.has(key), false, 'F3：被额度跳过也必须清标记');
  assert.ok([...st.pendingWakeReasons].some((r) => r.reason === 'private' && r.seq === 197), '条目必须仍在 backlog（等下一次机会）');
});

await test('F3 反向：queued/retried（已交给正常路径）必须保留标记，不得过度清理（否则 F1 复发）', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  await h.ensureSession(key);
  const st = stuckBacklogFor(h, key);
  // queued === true：DSH 未就绪 → 只入队，晚些会真正投递 → 标记必须保留
  h.busyWatchdog.rearmedWakeV2.set(key, new Set(['private@197']));
  h.setReady(false);
  const queuedResult = await h.deliverPrompt(key, 'x', { wakeReason: 'private', wakeSeq: 197 });
  assert.equal(queuedResult.queued, true, 'DSH 未就绪时必须走入队分支');
  assert.equal(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197'), true, 'queued 必须保留标记（F1 保护不能被过度清理掉）');
  // retried === true：会话创建期被 reset 抢先 → 入队重试，晚些会真正投递 → 标记必须保留
  h.setReady(true);
  const key2 = 'group:456';                                   // 还没有会话：让 ensureSession 真的去创建
  h.getSocialV2State(key2);
  h.busyWatchdog.rearmedWakeV2.set(key2, new Set(['private@197']));
  h.api.sessions.create = async (params) => {
    h.calls.created.push(params);
    h.resetEpoch();                                           // 创建期间发生 reset → 走「丢弃新会话」分支
    return { result: { ok: true, value: { sessionId: 'fixture-race' } } };
  };
  const retriedResult = await h.deliverPrompt(key2, 'y', { wakeReason: 'private', wakeSeq: 197 });
  assert.equal(retriedResult.retried, true, '会话创建期重置时必须走重试入队分支');
  assert.equal(h.busyWatchdog.rearmedWakeV2.get(key2)?.has('private@197'), true, 'retried 必须保留标记（否则 F1 复发）');
  assert.equal(h.promptQueues.has(key), false);
});

await test('F3 粒度：clearBusyRearmedWakeV2 对非有限 seq 直接 return；只清指定 (reason,seq)', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  h.getSocialV2State(key);
  h.markBusyRearmedWakeV2(key, 'private', 197);
  h.markBusyRearmedWakeV2(key, 'private', 205);
  assert.equal(h.clearBusyRearmedWakeV2(key, 'private', undefined), false, '非有限 seq 必须直接 return（不得退化为按 reason 粗清）');
  assert.equal(h.clearBusyRearmedWakeV2(key, 'private', 'abc'), false);
  assert.equal(h.clearBusyRearmedWakeV2(key, 'private', null), false);
  assert.deepEqual([...h.busyWatchdog.rearmedWakeV2.get(key)].sort(), ['private@197', 'private@205'],
    '三次无效调用后两条标记都必须还在（粗清会在这里丢掉 205）');
  assert.equal(h.clearBusyRearmedWakeV2(key, 'private', 197), true);
  assert.deepEqual([...h.busyWatchdog.rearmedWakeV2.get(key)], ['private@205'], '只清指定 (reason,seq)，同 reason 不同 seq 不受影响');
  assert.equal(h.clearBusyRearmedWakeV2(key, 'private', 197), false, '已清过的再清返回 false（幂等，不误删别的）');
  assert.deepEqual([...h.busyWatchdog.rearmedWakeV2.get(key)], ['private@205']);
});

await test('F3 对照：过度清理（把已成功送达的标记也清掉）会复发 F1 —— 故 queued/retried 必须保留', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = stuckBacklogFor(h, key);
  h.pendingWakeKeys.add(key);
  const release = releaseAndRearm(h, key);
  assert.match(release, /rearm=private@seq197/);
  await waitFor(() => count(h.readLog(), /\[reserved2\] 唤醒 private:123（private）/g) >= 1);
  assert.equal(h.calls.prompts.length, 1, 're-arm 已成功送达一次');
  assert.equal(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197'), true, '成功送达必须保留标记（F1 保护）');
  // 对照：模拟「过度清理」——把这条已成功送达的标记也清掉
  h.busyWatchdog.rearmedWakeV2.delete(key);
  h.wakeConfigUpdatedKeys.add(key);
  await feedFrames(h, completedTurn(sid, 1, '收尾回合'), 400);
  await waitFor(() => count(h.readLog(), /\[reserved2\] 唤醒 private:123（private）/g) >= 2);
  await sleep(150);
  const log = h.readLog();
  assert.match(log, /补发繁忙期间积压的唤醒：private@seq197/, '对照：清掉标记后 shift 会走「正常补发」分支');
  assert.equal(count(log, /\[reserved2\] 唤醒 private:123（private）/g), 2, '对照：同一 (private,197) 被投递 2 次 = F1 复发');
  assert.equal(h.calls.prompts.length, 2);
  console.log(`   [证据] 对照（过度清理）：同一 (private,197) 投递 ${count(log, /\[reserved2\] 唤醒 private:123（private）/g)} 次、`
    + `计划唤醒 ${count(log, /\[reserved2\] 计划唤醒 private:123（private）/g)} 次 → 正是 F1 的重复补发机制`);
});

// ══ F4 回归（t13）：待投唤醒项被丢弃/改判时标记必须结束 ══════════════════════
// 不变量：标记生命周期 ⟺ 唤醒项生命周期。项被丢弃/改判/未真正送达 → 清标记；
// 仅当已交给正常投递路径（正常送达 / queued / retried）才保留标记。
await test('F4-a 离线队列溢出（QUEUE_MAX）丢弃带 wake 的待投项 → 标记被清除、不再跳过、仍被重排并送达', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = stuckBacklogFor(h, key);              // unread=[197]、backlog=[private@197]、合并窗 1s、关频率限制
  h.pendingWakeKeys.add(key);
  const release = releaseAndRearm(h, key);
  assert.match(release, /rearm=private@seq197/);
  h.setReady(false);                               // DSH 掉线：这次 re-arm 只能入队
  await waitFor(() => /唤醒已入队/.test(h.readLog()));
  assert.equal(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197'), true, 'queued 分支按设计保留标记（不得过度清理）');
  // 填满离线队列（QUEUE_MAX=50）→ 最旧的（带 wakeSeq=197 的待投唤醒）被丢弃
  for (let i = 0; i < 50; i += 1) await h.deliverPrompt(key, `filler-${i}`, {});
  await waitFor(() => /丢弃最旧消息/.test(h.readLog()));
  assert.equal((h.queued.get(key) ?? []).filter((it) => Number(it.wakeSeq) === 197).length, 0, '带 wakeSeq=197 的项必须已被溢出丢弃');
  assert.equal(h.busyWatchdog.rearmedWakeV2.has(key), false, 'F4：被溢出丢弃的待投唤醒必须同步清标记');
  // 终局：随后有回合结束 → 不得走「跳过重复补发」，且该条必须重排后真的送达
  h.setReady(true);
  h.wakeConfigUpdatedKeys.add(key);
  await feedFrames(h, completedTurn(sid, 1, '溢出之后的回合'), 400);
  await waitFor(() => /补发繁忙期间积压的唤醒：private@seq197/.test(h.readLog()));
  await waitFor(() => h.calls.prompts.length >= 1);
  await sleep(150);
  const log = h.readLog();
  assert.equal(count(log, /跳过重复补发/g), 0, 'F4：被溢出丢弃的待投唤醒不得让 shift 走跳过分支');
  assert.match(log, /补发繁忙期间积压的唤醒：private@seq197/, '该条必须重新排入正常投递路径');
  assert.equal(h.calls.prompts.length, 1, '最终必须真的送达（计数=1）');
  console.log(`   [证据] 溢出丢弃后 残留登记=${h.busyWatchdog.rearmedWakeV2.has(key)}；跳过重复补发=${count(log, /跳过重复补发/g)} 次；`
    + `重排补发=${count(log, /补发繁忙期间积压的唤醒：private@seq197/g)} 次；送达=${h.calls.prompts.length} 次`);
});

await test('F4-b enqueueForRetry 溢出丢最旧（同族点 :2830）→ 带 wake 的项被丢时清标记', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  h.getSocialV2State(key);
  h.markBusyRearmedWakeV2(key, 'private', 197);
  h.enqueueForRetry(key, 'wake-text', { wakeReason: 'private', wakeSeq: 197 });   // 最旧的一条带 wake
  assert.equal(h.busyWatchdog.rearmedWakeV2.get(key)?.has('private@197'), true);
  for (let i = 0; i < 50; i += 1) h.enqueueForRetry(key, `filler-${i}`, {});
  assert.match(h.readLog(), /丢弃最旧消息 \(private:123\)/, '必须发生溢出丢弃');
  assert.equal((h.queued.get(key) ?? []).filter((it) => Number(it.wakeSeq) === 197).length, 0, '带 wake 的项已被丢弃');
  assert.equal(h.busyWatchdog.rearmedWakeV2.has(key), false, 'F4-b：同族溢出丢弃点必须成对清标记');
});

await test('F4-c flushQueue 补投时未授权会话被改判丢弃（:3083）→ 清标记', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const blockedKey = 'group:789';                 // 不在 allow.groups 里 → 补投时被 modeAllowed 改判丢弃
  h.getSocialV2State(blockedKey);
  h.markBusyRearmedWakeV2(blockedKey, 'private', 197);
  h.queued.set(blockedKey, [{ promptText: 'x', farewell: false, silent: false, media: [], wakeReason: 'private', wakeSeq: 197 }]);
  await h.flushQueue();
  assert.match(h.readLog(), /补投跳过未授权会话 group:789/, '必须走改判丢齐分支');
  assert.equal(h.busyWatchdog.rearmedWakeV2.has(blockedKey), false, 'F4-c：改判丢弃必须清标记');
  assert.equal(h.promptQueues.has(blockedKey), false, '未授权项不得进入投递队列');
});

await test('F4-d 看门狗合并 backlog 截断到 20（:2527）丢掉尾部条目 → 清标记', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  await h.ensureSession(key);
  const st = stuckBacklogFor(h, key);
  // 21 条高优先级（private）+ 1 条低优先级（proactiveCheck，排在尾部 → 会被截断丢掉）
  st.pendingWakeReasons = [{ reason: 'proactiveCheck', seq: 999 }];
  for (let i = 0; i < 21; i += 1) st.pendingWakeReasons.push({ reason: 'private', seq: 1000 + i });
  st.lastUnreadSeq = 197;
  h.markBusyRearmedWakeV2(key, 'proactiveCheck', 999);
  h.pendingWakeKeys.add(key);
  releaseAndRearm(h, key);
  assert.ok(!(h.busyWatchdog.rearmedWakeV2.get(key)?.has('proactiveCheck@999')),
    'F4-d：被合并截断丢掉的条目必须清标记（否则以后重新暂存同一条时会被 shift 静默跳过）');
});

await test('F4-e 忙分支 backlog 溢出丢最旧（:11270/:11450）→ 清标记', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  await h.ensureSession(key);
  const st = stuckBacklogFor(h, key);
  st.pendingWakeReasons = [{ reason: 'proactiveCheck', seq: 999 }];
  for (let i = 0; i < 20; i += 1) st.pendingWakeReasons.push({ reason: 'private', seq: 1000 + i });
  st.lastUnreadSeq = 197;
  h.markBusyRearmedWakeV2(key, 'proactiveCheck', 999);
  h.pendingWakeKeys.add(key);                     // 会仍忙 → scheduleWakeV2 走暂存分支并溢出去掉最旧那条
  h.scheduleWakeV2(key, 'keyword');
  assert.ok(![...st.pendingWakeReasons].some((r) => r && r.reason === 'proactiveCheck' && r.seq === 999),
    '最旧的 proactiveCheck@999 必须已被溢出丢弃');
  assert.equal(h.busyWatchdog.rearmedWakeV2.get(key)?.has('proactiveCheck@999') ?? false, false,
    'F4-e：同族溢出丢弃点必须成对清标记');
});

// ══ F5 回归（t13）：取消待发唤醒（清 pendingWakeTimer）时必须同步结束标记 ══════
// 三处取消点：set_wake_config / 控制台手动唤醒 / qq_wait_for_messages 入口。
// 统一断言：pendingWakeTimer 被清 → 该 (reason,seq) 标记同步消失（不变量：标记生命周期 ⟺ 唤醒项生命周期）。
const armPendingWakeWithMark = (h, key, reason = 'private', seq = 197) => {
  const st = h.getSocialV2State(key);
  st.pendingWakeTimer = setTimeout(() => {}, 60000);   // 模拟看门狗 re-arm 已排上的合并窗定时器
  st.pendingWakeReason = reason;
  st.pendingWakeSeq = seq;
  h.markBusyRearmedWakeV2(key, reason, seq);
  assert.equal(h.busyWatchdog.rearmedWakeV2.get(key)?.has(`${reason}@${seq}`), true, '前置：标记已登记');
  return st;
};

await test('F5-1 set_wake_config 取消待发唤醒（:5166）→ 标记同步清除', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  h.getSocialV2State(key);
  const st = armPendingWakeWithMark(h, key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    // 用 non-sleeping（active）配置：避免命中「沉睡前观察」闸门（那是另一条独立规则，
    // 与本用例要验证的 F5-1「取消待发唤醒 → 清标记」无关；该闸门会提前 return，压根走不到取消点）
    const res = await postJson(server, '/api/socialV2/wake-config', { key, config: { mode: 'active' } });
    assert.equal(res.status, 200, res.body);
    assert.equal(st.pendingWakeTimer, null, 'F5-1：set_wake_config 必须取消待发唤醒定时器');
    assert.equal(h.busyWatchdog.rearmedWakeV2.has(key), false, 'F5-1：取消待发唤醒后标记必须同步清除');
  } finally {
    server.closeAllConnections?.();   // 收掉可能挂着的 keep-alive 连接，别让空闲 socket 吊住事件循环
    await new Promise((resolve) => server.close(resolve));
  }
});

await test('F5-2 控制台手动唤醒取消旧的待发唤醒（:5205）→ 标记同步清除', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  await h.ensureSession(key);
  const st = armPendingWakeWithMark(h, key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await postJson(server, '/api/socialV2/wake', { key, reason: 'admin' });
    assert.equal(res.status, 200, res.body);
    assert.equal(st.pendingWakeTimer, null, 'F5-2：手动唤醒必须取消旧的待发唤醒定时器');
    assert.equal(h.busyWatchdog.rearmedWakeV2.has(key), false, 'F5-2：旧待发唤醒取消后标记必须同步清除');
  } finally {
    server.closeAllConnections?.();   // 收掉可能挂着的 keep-alive 连接，别让空闲 socket 吊住事件循环
    await new Promise((resolve) => server.close(resolve));
  }
});

await test('F5-3 qq_wait_for_messages 入口取消待发唤醒（:6194）→ 标记同步清除', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  h.getSocialV2State(key);
  const st = armPendingWakeWithMark(h, key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  // 该端点会挂住等待消息；这里只 fire-and-forget，等它把待发唤醒取消即可
  const pending = postJson(server, '/api/socialV2/wait', { key, timeoutMs: 2000 }).catch(() => null);
  const cleared = await waitFor(() => !h.busyWatchdog.rearmedWakeV2.has(key), 3000);
  try {
    assert.ok(cleared, 'F5-3：wait 入口必须清掉待发唤醒的标记');
    assert.equal(st.pendingWakeTimer, null, 'F5-3：wait 入口必须取消待发唤醒定时器');
    assert.match(h.readLog(), /\[reserved2\]/, 'wait 入口仍然进入等待路径');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pending;
  }
});

// ── A6：释放路径异常被捕获，不带走进程 ─────────────────────────────────────
await test('A6：释放路径内部异常只记一行 ❌ [watchdog]，其它会话照常释放、进程存活', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const bad = 'private:123';
  const good = 'group:456';
  const st = h.getSocialV2State(bad);
  // 注入异常：unread 是数组（Array.isArray 通过）但 .some 抛错 —— 模拟释放路径内部异常
  const brokenUnread = [];
  brokenUnread.some = () => { throw new Error('injected-boom'); };
  st.unread = brokenUnread;
  st.pendingWakeReasons = [{ reason: 'private', seq: 197 }];
  h.pendingWakeKeys.add(bad);
  h.getSocialV2State(good);
  h.pendingWakeKeys.add(good);
  const t0 = Date.now();
  h.busyWatchdog.lastFrameAtV2.set(bad, t0);
  h.busyWatchdog.lastFrameAtV2.set(good, t0);
  h.runBusyWatchdogScanV2(t0);
  h.runBusyWatchdogScanV2(t0 + 10000);
  const log = h.readLog();
  assert.match(log, /❌ \[watchdog\] 释放异常 key=private:123: injected-boom/);
  assert.match(log, /\[watchdog\] release key=group:456 .*released=pendingWakeKeys/, '单会话异常不得影响其它会话');
  assert.equal(h.pendingWakeKeys.has(good), false);
  // 进程存活：后续扫描仍然工作
  h.pendingWakeKeys.add(good);
  h.busyWatchdog.lastFrameAtV2.set(good, t0 + 20000);
  h.runBusyWatchdogScanV2(t0 + 30000);
  assert.equal(count(h.readLog(), /\[watchdog\] release key=group:456/g), 2);
});

// ── C5：30 分钟租约未被改动、边重复出现 ────────────────────────────────────
await test('C5：30 分钟租约语义未被改动，释放后租约计时器为空', withWatchdog(SCALED), async (h) => {
  const source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  const arm = source.slice(source.indexOf('function armPendingWakeLease'), source.indexOf('function disarmPendingWakeLease'));
  assert.match(arm, /30 \* 60 \* 1000/, 'armPendingWakeLease 必须仍是 30 分钟（本轮不得改动）');
  assert.match(source, /hardCapMs: 1800000/, '代码内默认 hardCapMs 必须与租约的 30 分钟对齐');
  const { key } = await stuckByPendingWake(h);
  const t0 = Date.now();
  h.busyWatchdog.lastFrameAtV2.set(key, t0);
  h.runBusyWatchdogScanV2(t0);
  h.runBusyWatchdogScanV2(t0 + 10000);
  assert.equal(h.pendingWakeLeaseTimers.has(key), false);
  // 释放只发生一次：租约不会在之后冒出第二次「释放」
  assert.equal(count(h.readLog(), /\[watchdog\] release key=private:123/g), 1);
  // 释放路径成对出现：没有残留的墓碑/collector（无新泄漏）
  assert.equal(h.busyWatchdog.staleBusyTurns.size, 0);
  assert.equal(h.collectors.size, 0);
  assert.equal(h.v2TurnStartAt.size, 0);
});

if (failures) {
  console.error(`\n❌ 卡忙看门狗测试失败 ${failures} 项`);
  process.exit(1);
}
console.log(`\n🎉 卡忙自愈看门狗聚焦测试通过（用例 ${(caseMsTotal / 1000).toFixed(1)}s + close ${(closeMsTotal / 1000).toFixed(1)}s，`
  + `进程 uptime ${process.uptime().toFixed(1)}s）`);
// 显式退出（与 scripts/test-agent-preset-patches.mjs 同风格）：本文件会起若干临时 HTTP 服务，
// 测试侧偶发残留一个空闲 socket 句柄会把事件循环多吊住 ~60s（实测 29s → 88s），
// 撞上 test-audit 的每脚本超时。断言已全部跑完，这里直接给出退出码。
process.exit(failures === 0 ? 0 : 1);
