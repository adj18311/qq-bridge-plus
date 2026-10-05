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
  const calls = { created: [], prompts: [], sent: [], follows: [] };
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
    promptQueues, pendingWakeKeys, pendingWakeLeaseTimers, collectors, v2TurnStartAt,
    armPendingWakeLease, disarmPendingWakeLease, reverse, wakeConfigUpdatedKeys, markReadCalledKeys,
    clearBusyRearmedWakeV2, busyWakeIdV2,
    busyWatchdog, busyWatchdogConfig, runBusyWatchdogScanV2, startBusyWatchdogV2,
    noteFrameActivityV2, noteActionActivityV2, clearBusyWatchdogRuntimeV2,
    createTurnCollector, pumpMux, startConsoleServer, handleIncoming, queued,
    clearSocialV2Timers, cancelPendingWakeTimerV2, clearRearmMarkForDroppedWakeV2,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
  };
  bot.onPrivateMessage(async (event) => {`);
  const timeouts = new Set();
  const intervals = [];
  const context = vm.createContext({
    fs, os: { ...os, homedir: () => temp }, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal,
    console: { log() {}, error() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) }),
    execFileSync: () => '',
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, exit: (code) => { throw new Error(`unexpected exit ${code}`); } },
    // 真定时器（行为与生产一致），只记录句柄用于收尾清理 / 断言 unref。
    setTimeout: (fn, ms) => { const handle = setTimeout(fn, ms); timeouts.add(handle); return handle; },
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
    ...modelPrices, ...tokenLedger, ...voiceLib, ...stateAcl,
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
    bridge.temp = temp;
    bridge.intervals = intervals;
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
await test('T13 租约本体未被改动（仍 30 分钟）且 7 个默认阈值等于冻结值', {}, async (h) => {
  assert.deepEqual({ ...h.busyWatchdogConfig() }, {
    enabled: true, warnMs: 300000, releaseMs: 900000, hardCapMs: 1800000,
    checkIntervalMs: 10000, rearmCooldownMs: 60000, maxRearmPerHour: 3,
  }, '默认阈值必须逐条等于 t1 §15.6 冻结值');
  const source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  const armStart = source.indexOf('function armPendingWakeLease');
  const armBody = source.slice(armStart, source.indexOf('function disarmPendingWakeLease'));
  assert.ok(armStart > 0 && armBody.includes('30 * 60 * 1000'), 'armPendingWakeLease 本体必须仍是 30 分钟（R2：本轮不得改动租约）');
  assert.match(source, /hardCapMs: 1800000/, '代码内默认 hardCapMs 必须与 30 分钟租约对齐');
  // 租约本体：与 HEAD 的 arm/disarm 函数体逐字比对（只看本文件，避免 diff 行噪声）
  const { execFileSync } = await import('node:child_process');
  const head = execFileSync('git', ['show', 'HEAD:src/bridge.js'], { cwd: root, encoding: 'utf8' });
  // 工作区是 CRLF、git show 是 LF：比对前必须归一化行尾（否则会把纯行尾差异当改动）。
  const norm = (text) => String(text).replace(/\r\n/g, '\n');
  const sourceN = norm(source);
  const headN = norm(head);
  // 取「函数体」= 从声明行到下一个同级 function 声明前（避免把相邻无关代码算进来）。
  const fnBody = (text, name) => {
    const start = text.indexOf(`function ${name}(`);
    if (start < 0) return '';
    const rest = text.slice(start);
    const next = rest.slice(1).search(/\n {2}function /);
    return (next < 0 ? rest : rest.slice(0, next + 1)).trim();
  };
  const armOld = fnBody(headN, 'armPendingWakeLease');
  const disarmOld = fnBody(headN, 'disarmPendingWakeLease');
  assert.ok(armOld.length > 100 && disarmOld.length > 50, '夹具必须能在 HEAD 里定位到租约函数体');
  assert.ok(sourceN.includes(armOld), 'armPendingWakeLease 函数体必须与 HEAD 逐字一致（R2：本轮不得改动租约）');
  assert.ok(sourceN.includes(disarmOld), 'disarmPendingWakeLease 函数体必须与 HEAD 逐字一致（R2：本轮不得改动租约）');
  const diff = execFileSync('git', ['diff', '-U0', '--', 'src/bridge.js'], { cwd: root, encoding: 'utf8' });
  const touched = diff.split(/\r?\n/).filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  // F1 修复引入的运行时去重表必须有生命周期清理：pause/切模式（clearBusyWatchdogRuntimeV2）、
  // retireSession、两处会话重置 —— 否则标记会跨模式/跨会话残留并把合法补发吞掉。
  const markClearSites = (sourceN.match(/rearmedWakeV2\.(delete|clear)\(/g) ?? []).length;
  const runtimeBody = sourceN.slice(sourceN.indexOf('function clearBusyWatchdogRuntimeV2'), sourceN.indexOf('function startBusyWatchdogV2'));
  assert.ok(runtimeBody.includes('rearmedWakeV2.clear()'), 'pause/切模式清运行时必须一并清去重标记');
  assert.ok(markClearSites >= 4, `去重标记必须 ≥4 处清理（运行时 clear + retire + 两处 reset），实测 ${markClearSites} 处`);
  console.log(`   [证据] 去重标记清理点 ${markClearSites} 处（含 clearBusyWatchdogRuntimeV2 内 rearmedWakeV2.clear()）`);
  console.log(`   [证据] git diff src/bridge.js 变更行 ${touched.length} 行；arm/disarm 函数体与 HEAD 逐字一致；`
    + `arm 仍含 30 分钟常量=${armOld.includes('30 * 60 * 1000')}`);
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
     每次 release 都是一次新的看门狗干预，属于冻结设计（§15.8 防释放风暴靠 cooldown+额度）。`);
if (failures.length || (STRICT && probeFailures.length)) process.exitCode = 1;
