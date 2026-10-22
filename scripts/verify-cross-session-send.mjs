#!/usr/bin/env node
// t30 独立验证：owner 跨会话发送（t29「放开 owner 会话的跨会话发送」）的权限放宽**没有溢出**。
//
// 立场（与实现者的 scripts/test-cross-session-send.mjs 独立）：
//   这次改动是**权限边界的放宽**，所以本脚本重点不是「新能力能用」，而是「放宽没有溢出」：
//     1) 只有**管理员来信触发的那一轮**放行 —— 非管理员触发的主动唤醒（proactiveCheck/replyCheck/
//        概率/关键词/桥接提醒）之后，同一会话做同样的发送调用必须仍被拒；
//     2) 只有**发送路径**放行 —— 8 个其它会话级工具在 owner 授权轮内操作别的会话仍必须 403；
//     3) 只有**白名单目标**放行 —— allow.private / allow.groups 之外一律拒；
//     4) 令牌语义不变 —— 逐会话绑定，别的会话拿不到、也用不了 owner 的能力。
//   所有判定都走**真实 src/bridge.js 的 HTTP 路由**（真鉴权、真 403、真 OneBot 发送），
//   不采信实现者自报，也不把提示词当作任何一道闸门（拒绝发生在桥接代码里）。
//
// 手法（与聚焦测试的两点差别，避免「照抄夹具」）：
//   · 时间轴自己控制：VM 里替换 Date.now 为「真实时间 + 可调偏移」，用它把 30 分钟墙钟窗口
//     真的推过期（含边界：正好 CROSS_SESSION_GRANT_MS 放行、超 1ms 拒绝），不靠改内部字段。
//   · 每个用例都带**对照组**：跨会话请求必须 403「agent token 无效」，同一请求换本会话令牌必须
//     不再是这个错误 —— 否则用例可能只是被更早的参数校验挡住（空断言）。
// 不读线上 config.json、不写真实 state/、不连 QQ/DSH、不启动第二个守护进程、不改 src/。
import assert from 'node:assert/strict';
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

const root = fileURLToPath(new URL('..', import.meta.url));
const CONSOLE_TOKEN = 'verify-cross-session-token';
const OWNER_QQ = 123;                 // 只来自 config.ownerQQ；T8 会改配置证明不写死
const OWNER_KEY = `private:${OWNER_QQ}`;
const OTHER_PRIVATE = 'private:999';  // 白名单内私聊
const OTHER_GROUP = 'group:456';      // 白名单内群
const OUT_PRIVATE = 'private:888';    // 白名单外私聊
const OUT_GROUP = 'group:777';        // 白名单外群
const OWNER_PRIVATE_ALT = 'private:999'; // T8 换 owner 时用的「新管理员」私聊（白名单内）
const ALLOW = { private: ['123', '999'], groups: ['456', '987'] };
const TOKEN_ERR = 'agent token 无效';
const WHITELIST_ERR = '目标不在当前模式允许范围内';
/**
 * 令牌闸门拒绝的**统一**断言（t38：修 t30 的空转断言；t47：加「是哪道闸门」）。
 * 只断言 403 是不够的：更早的闸门（例如 /api/send/* 的 body.token 缺失、空令牌、x-agent-call 校验）
 * 会先返回 403，让「必须 403」在**没打到目标闸门**时也通过。所以每个「应拒」用例都必须同时钉住拒因文案。
 *
 * t47：拒因文案「agent token 无效」同时出现在**两条路径**上 ——
 *   ① `isolation`：端点级会话绑定拒绝（令牌不属于目标会话；跨会话豁免路径根本没走到，不打任何 [cross-session] 留痕）；
 *   ② 跨会话豁免路径里的具体理由：`not-owner-token` / `no-grant` / `grant-expired` / `session-changed`
 *      （t61 之前还有一个 `turn-ended` 时序判据，已**有意移除**：驻留轮可能没有桥接可见的 turn/start/④，
 *       硬卡它会把刚兑现的授权立刻作废；生命周期改由「投递绑定 + 任意 turn/end 关闭 + 30 分钟墙钟」界定）
 *      （这些一定会打一行 `[cross-session] 拒绝代发（<理由>）`）。
 * 光看 response 分不清是哪条，所以给可选参数 `gate` + 本次请求**新增**的拒绝代发行，失败信息能直接指名闸门。
 * 传 gate 时必须配 `probeTokenDenied`（它会采集新增行），否则断言会以「没给证据」失败。
 *
 * @param res           HTTP 响应
 * @param label         用例标签
 * @param gate          可选：期望闸门（'isolation' 或上面列出的豁免路径理由）
 * @param newDenyLines  可选：本次请求新增的 `[cross-session] 拒绝代发` 行（由 probeTokenDenied 采集）
 */
function assertTokenDenied(res, label, gate = null, newDenyLines = null) {
  assert.equal(res.status, 403, `${label}：必须 403，实测 ${res.status} ${res.raw}`);
  assert.equal(String(res?.data?.error ?? ''), TOKEN_ERR,
    `${label}：拒因必须恰是「${TOKEN_ERR}」，实测 ${res.raw}（拒因不对＝被更早的闸门挡成空断言）`);
  if (!gate) return;
  assert.ok(Array.isArray(newDenyLines),
    `${label}：要核对期望闸门（${gate}）就必须用 probeTokenDenied 传入本次请求新增的拒绝代发行`);
  if (gate === 'isolation') {
    assert.deepEqual(newDenyLines, [],
      `${label}：期望闸门=isolation（端点级会话绑定拒绝，不该有跨会话留痕），但本次请求新增了：${JSON.stringify(newDenyLines)}`);
  } else {
    assert.ok(newDenyLines.some((line) => line.includes(`拒绝代发（${gate}）`)),
      `${label}：期望闸门=${gate}，但本次请求新增的拒绝代发行里没有它：${JSON.stringify(newDenyLines)}`);
  }
}
/**
 * 发一个「应当被令牌闸门拒绝」的请求，并采集**本次请求新增的** `[cross-session] 拒绝代发` 行，
 * 交给 assertTokenDenied 判定「是哪道闸门在拒」（t47）。
 */
async function probeTokenDenied(h, label, gate, request) {
  const before = count(h.readLog(), /\[cross-session\] 拒绝代发/g);
  const res = await request();
  const added = linesOf(h.readLog(), /\[cross-session\] 拒绝代发[^\n]*/g).slice(before);
  assertTokenDenied(res, label, gate, added);
  return res;
}
/** 白名单闸门拒绝的统一断言（/api/send/* 与 /api/socialV2/send-* 的文案一致）。 */
function assertWhitelistDenied(res, label) {
  assert.equal(res.status, 403, `${label}：必须 403，实测 ${res.status} ${res.raw}`);
  assert.equal(String(res?.data?.error ?? ''), WHITELIST_ERR,
    `${label}：拒因必须恰是「${WHITELIST_ERR}」，实测 ${res.raw}（拒因不对＝被更早的闸门挡成空断言）`);
}
/** 放行断言：200 之外还要 ok:true（只看状态码的放行断言同样可能假绿）。 */
function assertAllowed(res, label) {
  assert.equal(res.status, 200, `${label}：必须 200，实测 ${res.status} ${res.raw}`);
  assert.equal(res.data?.ok, true, `${label}：响应体必须 ok:true，实测 ${res.raw}`);
}

/** 在临时目录里跑真实桥接（假 api / 假 bot / 假 OneBot HTTP），并暴露本任务要断言的内部结构。 */
async function verifyHarness({ config = {}, transformSource, sourcePath } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-verify-cross-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  const socialV2 = {
    enabled: true,
    proactive: { enabled: false },        // 主动机会定时器：本脚本自己驱动回合，不要它插话
    sticker: { enabled: true },           // 收藏表情/表情备注用例要走到令牌关卡
    // 唤醒频率额度放宽：V2 要连做 5 个「非管理员唤醒回合」，不能让额度把唤醒本身拦掉。
    wake: { maxWakePerMinute: 120, maxWakePerHour: 600 },
    ...(config.socialV2 ?? {}),
  };
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: OWNER_QQ,
    allow: ALLOW, consolePort: 0, consoleToken: CONSOLE_TOKEN, slang: { enabled: false },
    ...config, socialV2,
  }));
  const calls = { prompts: [], sent: [], follows: [], http: [] };
  // 发送最终走 OneBot HTTP（onebotSend → POST {httpUrl}/send_private_msg|send_group_msg|send_poke），
  // 这里既拦下真网络，又把「到底发给了谁、发了什么」原样记下来作为最强证据。
  const fakeFetch = async (url, init = {}) => {
    let body = null;
    try { body = JSON.parse(init?.body ?? 'null'); } catch { body = init?.body ?? null; }
    calls.http.push({ url: String(url), body });
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async () => success({}),
    },
    sessions: {
      create: async (params) => { calls.prompts.push(params); return success({ sessionId: `fixture-session-${calls.prompts.length}` }); },
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
  const timeouts = new Set();
  let source = fs.readFileSync(sourcePath ?? path.join(root, 'src/bridge.js'), 'utf8');
  // 顶层 import 在 VM 里靠 context 注入提供；按行处理（import 有多行写法）。
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
  // 变异体（载荷性反证）用：只作用于 VM 内的源码副本，绝不写回 src/bridge.js。
  if (typeof transformSource === 'function') source = transformSource(source);
  // 观测点：把授权状态机与日志需要的内部结构暴露给断言（只改 VM 内副本，绝不写回 src/bridge.js）。
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    cfg, state, api, socialV2, getSocialV2State, ensureSession, handleIncoming, pumpMux,
    startConsoleServer, v2TurnStartAt, v2TurnNoV2, collectors, pendingWakeKeys, promptQueues,
    ownerCrossSendV2, CROSS_SESSION_GRANT_MS,
    armOwnerCrossSendV2, onV2TurnStartCrossSendV2, onV2TurnEndCrossSendV2,
    clearOwnerCrossSendV2, ownerSessionKeyV2, markReadCalledKeys,
    scheduleWakeV2, sendWakePromptV2,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
  };
  bot.onPrivateMessage(async (event) => {`);
  const context = vm.createContext({
    fs, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal,
    console: { log() {}, error() {} },
    fetch: fakeFetch,
    execFileSync: () => '',
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, exit: (code) => { throw new Error(`unexpected exit ${code}`); } },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timeouts.add(t); return t; },
    clearTimeout: (t) => { timeouts.delete(t); clearTimeout(t); },
    setInterval: () => ({ unref() {} }),        // 定时守护（看门狗/DSH 探活）在 VM 里不真跑
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
  });
  // 可调时钟：把 Date.now 改成「真实时间 + 偏移」，用来真的把 30 分钟授权窗口推过期（不改内部字段）。
  vm.runInContext(`
    globalThis.__clockOffsetMs = 0;
    const __realDateNow = Date.now.bind(Date);
    Date.now = () => __realDateNow() + globalThis.__clockOffsetMs;
  `, context);
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData }; })());`, context);
  vm.runInContext(source + '\nglobalThis.verifyCrossReady = main();', context);
  const bridge = await context.verifyCrossReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setMode('reserved2');
  bridge.setReady(true);
  const logFile = path.join(temp, 'state', 'bridge.log');
  return {
    ...bridge,
    calls,
    temp,
    readLog: () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } },
    setClockOffset: (ms) => { vm.runInContext(`globalThis.__clockOffsetMs = ${Number(ms) || 0}`, context); },
    close() {
      for (const t of timeouts) clearTimeout(t);
      fs.rmSync(temp, { recursive: true, force: true });
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const count = (text, re) => (String(text).match(re) ?? []).length;
const linesOf = (text, re) => (String(text).match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []);
function dump(label, text, re) {
  const lines = linesOf(text, re);
  console.log(`   [原始日志] ${label}：${lines.length} 行`);
  for (const line of lines) console.log(`     ${line}`);
}
async function waitUntil(fn, timeoutMs = 6000, stepMs = 40) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(stepMs);
  }
}
/** 真事件流喂帧器：帧经真实 pumpMux → turn/start / turn/end 链路生效。 */
function startMux(h) {
  const queue = [];
  let wake = null;
  h.api.events.mux = async function* () {
    for (;;) {
      if (queue.length === 0) { await new Promise((resolve) => { wake = resolve; }); continue; }
      yield { payload: queue.shift() };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  void h.pumpMux();
  return {
    push(frames) {
      for (const frame of Array.isArray(frames) ? frames : [frames]) queue.push(frame);
      if (wake) { const resolve = wake; wake = null; resolve(); }
    },
  };
}
const frameOf = (sid, event) => ({ type: 'session/event', sessionId: sid, event });
const turnStart = (sid, turn) => frameOf(sid, { type: 'turn/start', data: { turn } });
const turnEnd = (sid, turn) => frameOf(sid, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
let msgSeq = 5000;
const ownerPrivateMessage = (text, userId = OWNER_QQ) => ({
  user_id: userId, self_id: 999, message_id: (msgSeq += 1), message_seq: msgSeq,
  sender: { user_id: userId, nickname: '管理员' }, time: Math.floor(Date.now() / 1000),
  message: [{ type: 'text', data: { text } }],
});
const groupMessage = (text, userId = 555) => ({
  user_id: userId, self_id: 999, group_id: 456, message_id: (msgSeq += 1), message_seq: msgSeq,
  sender: { user_id: userId, nickname: '路人' }, time: Math.floor(Date.now() / 1000),
  message: [{ type: 'text', data: { text } }],
});

/** 与 MCP 工具一致：query token + x-console-token + x-agent-token + x-agent-call。 */
function agentRequest(server, { method = 'POST', pathname, query = null, body, agentToken, agentCall = true }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const search = query ? new URLSearchParams(query).toString() : '';
    const headers = {
      'x-console-token': CONSOLE_TOKEN,
      connection: 'close',
    };
    if (agentToken !== undefined) {
      headers['x-agent-token'] = agentToken;
      if (agentCall) headers['x-agent-call'] = '1';
    }
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({
      host: '127.0.0.1', port: server.address().port,
      path: `${pathname}?token=${encodeURIComponent(CONSOLE_TOKEN)}${search ? `&${search}` : ''}`,
      method, headers, agent: false,
    }, (response) => {
      let raw = '';
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        resolve({ status: response.statusCode, data, raw });
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('request hung')));
    req.end(payload ?? undefined);
  });
}
async function listen(server) {
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  return server;
}
async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
/** 拦下来的 OneBot 发送请求 —— 「真的发出去了」的最强证据。 */
const onebot = (h, action) => h.calls.http.filter((c) => c.url.includes(`/${action}`));

let failures = 0;
let passes = 0;
const ONLY = process.env.VERIFY_ONLY || '';           // 只跑名字里含该串的用例（调试/定点复跑用）
async function test(name, run) {
  if (ONLY && !name.includes(ONLY)) return;
  console.log(`\n────────────────────────────────────────────────────────────────`);
  console.log(`▶ ${name}`);
  const t0 = Date.now();
  try {
    await run();
    passes += 1;
    console.log(`✅ PASS ${name}（${Date.now() - t0}ms）`);
  } catch (error) {
    failures += 1;
    console.log(`❌ FAIL ${name}（${Date.now() - t0}ms）`);
    console.log(String(error?.stack ?? error?.message ?? error).split('\n').map((l) => `   ${l}`).join('\n'));
  }
}
async function withBridge(run, config) {
  const h = await verifyHarness({ config });
  const server = await listen(h.startConsoleServer());
  try { await run(h, server); }
  finally { await closeServer(server); h.close(); }
}
/** 变异体专用：同一套 harness，但加载的是「被中和掉某一处放宽点」的源码副本（只在 VM 内）。 */
async function withMutant(transformSource, run) {
  const h = await verifyHarness({ transformSource });
  const server = await listen(h.startConsoleServer());
  try { await run(h, server); }
  finally { await closeServer(server); h.close(); }
}
/** M3 变异专用：从磁盘上的 %TEMP% 副本加载桥接（t38 要求「在 %TEMP% 副本上做变异」）。 */
async function withSource(sourcePath, run) {
  const h = await verifyHarness({ sourcePath });
  const server = await listen(h.startConsoleServer());
  try { await run(h, server); }
  finally { await closeServer(server); h.close(); }
}

/** owner 会话 + 它的会话令牌（真实 getSocialV2State 生成，和 MCP 拿到的是同一个）。 */
async function ownerSession(h) {
  const sid = await h.ensureSession(OWNER_KEY);
  return { sid, token: h.getSocialV2State(OWNER_KEY).agentToken };
}
/** 管理员来信 → **承载来信的那次唤醒被真正投递** → 就地兑现（t61 新口径；不再等 turn/start）。 */
async function openOwnerGrant(h, feed, { turn = 1, text = '去给 999 发条消息', userId = OWNER_QQ, key = OWNER_KEY, startTurn = true } = {}) {
  await h.handleIncoming('private', Number(String(key).split(':')[1]), ownerPrivateMessage(text, userId), h.cfg);
  const sid = h.state.sessions[key];
  const seq = h.getSocialV2State(key).lastUnreadSeq;   // 来信的 unread 序号：授权按它严格绑定
  // 清掉「残留唤醒中间态」（含 ensureSession 自动排的 bootstrap 合并窗定时器、在途唤醒 key、排队投递）：
  // 否则这次投递会被判「忙」而暂存 —— 那正是 t61 要消除的生产形态，本 helper 要测的是「投递即成」这条正路。
  // 注意：quiesce 不碰 ownerCrossSendV2.pending（名额必须活到承载它的那次投递）。
  await quiesce(h, key);
  await h.sendWakePromptV2(key, 'private', { seq });   // 真投递（sendWakePromptV2 → deliverPrompt → redeemOwnerCrossSendOnDeliveryV2）
  const active = await waitUntil(() => h.ownerCrossSendV2.active, 4000);
  if (!active) {
    const st = h.getSocialV2State(key);
    const lines = String(h.readLog()).split(/\r?\n/).filter((l) => /唤醒|暂存|授权|busy/.test(l)).slice(-6);
    console.log(`   [诊断] 未兑现：pending=${JSON.stringify(h.ownerCrossSendV2.pending)} active=${JSON.stringify(h.ownerCrossSendV2.active)}`
      + ` seq=${seq} lastUnreadSeq=${st.lastUnreadSeq}`
      + ` pendingWakeKeys=${h.pendingWakeKeys.has(key)} pendingWakeTimer=${!!st.pendingWakeTimer}`
      + ` queue=${JSON.stringify(h.promptQueues.get(key) ?? null)} turnMark=${h.v2TurnStartAt.has(h.state.sessions[key])} collectors=${h.collectors.has(h.state.sessions[key])}`);
    for (const line of lines) console.log(`     | ${line}`);
  }
  // 需要「桥接可见的回合」时再开一轮：投递时会话空闲 ⇒ adoptNextTurnStart ⇒ 这一轮被接管（授权不清）。
  // 必须**等到帧真的被 pumpMux 消费**（④ 置位）再返回，否则调用方随后清 ④ 会被迟到帧重新点亮。
  if (startTurn && active && active.adoptNextTurnStart !== false) {
    feed.push([turnStart(sid, turn)]);
    await waitUntil(() => h.v2TurnStartAt.has(sid), 2000);
  }
  return { sid, active, seq };
}
const sendMessage = (server, { key, messages, agentToken, agentCall }) =>
  agentRequest(server, { pathname: '/api/socialV2/send-message', body: { key, messages }, agentToken, agentCall });
/**
 * 把某个会话的「唤醒中间态」清干净（待发合并窗 / 在途唤醒 key / 排队投递 / 唤醒时间账），
 * 这样测试自己驱动的每一次桥接唤醒都能**真的投递**（而不是被上一轮的残留判成「忙」而暂存）。
 * 只用公开内部结构，不改 src/。
 */
async function quiesce(h, key) {
  const st = h.getSocialV2State(key);
  // 合并窗收到 1s（默认 8s；turn/end 的「连续未设置唤醒条件」重置会把配置打回默认值，所以每次都要重设）
  if (st.wakeConfig) st.wakeConfig.batchWindowMs = 1000;
  if (st.pendingWakeTimer) { clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null; }
  st.pendingWakeReason = null;
  st.pendingWakeSeq = null;
  st.wakeTimes = [];
  h.pendingWakeKeys.clear();
  h.promptQueues.clear();
  await sleep(30);
}

// ══ T1 正例（独立复现）：owner 会话经管理员来信触发 → 白名单内其它会话：成功 + [cross-session] 留痕 ══
await test('V1 正例：管理员来信触发的那一轮里代发到白名单内私聊 → 200 + 真发 OneBot + [cross-session] 审计行', async () => {
  await withBridge(async (h, server) => {
    const { sid, token } = await ownerSession(h);
    await h.ensureSession(OTHER_PRIVATE);
    const feed = startMux(h);
    // ── 隔离基线：没有管理员来信（也就没有授权）时，跨会话发送必须仍是原样拒绝 ──
    const before = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['替管理员传个话（越权尝试）'], agentToken: token });
    assert.equal(before.status, 403, `无授权时跨会话发送必须 403，实测 ${before.status} ${before.raw}`);
    assert.equal(before.data?.error, TOKEN_ERR, '拒绝文案必须原样「agent token 无效」');
    assert.equal(onebot(h, 'send_private_msg').length, 0, '被拒的请求不得产生任何 OneBot 请求');
    // ── 管理员来信 → **承载来信的那次唤醒被真正投递**时就地兑现（t61：不再等 turn/start）──
    const { active } = await openOwnerGrant(h, feed, { text: '帮我给 999 私聊传个话：晚上开会' });
    assert.ok(active, '管理员来信的唤醒被真正投递时必须兑现授权');
    assert.equal(active.key, OWNER_KEY);
    assert.equal(active.sessionId, sid);
    assert.equal(active.source, 'owner-message');
    assert.equal(String(active.seq), String(h.getSocialV2State(OWNER_KEY).lastUnreadSeq), '授权必须绑定来信的 unread seq');
    const after = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['替管理员传个话：晚上开会'], agentToken: token });
    assertAllowed(after, '授权轮内跨会话发送');
    const sends = onebot(h, 'send_private_msg');
    assert.equal(sends.length, 1, `必须真的发出 1 条 OneBot 私聊，实测 ${sends.length}`);
    assert.equal(String(sends[0].body?.user_id), '999', `OneBot 目标必须是 999：${JSON.stringify(sends[0].body)}`);
    assert.match(JSON.stringify(sends[0].body?.message ?? ''), /晚上开会/, `OneBot 内容必须带原文：${JSON.stringify(sends[0].body)}`);
    const log = h.readLog();
    dump('授权轮代发', log, /[^\n]*\[cross-session\][^\n]*/);
    assert.match(log, /\[cross-session\] 授权窗口开启：管理员 123 来信的唤醒(已交给当前回合的待办队列|已投递)（来源=owner-message@seq\d+/, '必须有授权窗口开启留痕（含授权人与来信 seq）');
    // 按**字段**断言而不是整句：审计行的说明性措辞会被别的任务改写（t3x 就给 /api/socialV2/* 的
    // 「来源=」补过一句解释），绑整句会让断言因为无关改动转红。字段才是这条留痕的契约。
    const successLine = linesOf(log, /\[cross-session\] 代发成功[^\n]*/).pop() ?? '';
    assert.ok(successLine, '必须有代发成功留痕');
    for (const [field, re] of [
      ['授权人', /授权人=123/], ['来源', /来源=owner-message/], ['目标', /目标=private:999/],
      ['条数', /条数=1\/1/], ['端点', /端点=\/api\/socialV2\/send-message/],
    ]) {
      assert.match(successLine, re, `代发成功留痕必须带${field}：${successLine}`);
    }
    console.log(`   [证据] 无授权 403「${before.data?.error}」→ 管理员来信触发回合 → 200 ok:true；OneBot 实收 send_private_msg(user_id=999, ${JSON.stringify(sends[0].body?.message)})；审计行见上`);
  });
});

// ══ T2 核心：只有管理员能指派 —— 非管理员触发的回合一律被拒，管理员回合放行（两半都要原始日志）══
await test('V2 核心：主动唤醒（proactiveCheck/replyCheck/probability/keyword/提醒）触发的回合 → 403；管理员来信回合 → 200', async () => {
  await withBridge(async (h, server) => {
    const { sid, token } = await ownerSession(h);
    await h.ensureSession(OTHER_PRIVATE);
    const feed = startMux(h);
    h.getSocialV2State(OWNER_KEY).wakeConfig.batchWindowMs = 1000;
    // ── A 半：桥接自己发起的唤醒回合（没有任何管理员来信）──
    const reasons = ['proactiveCheck', 'replyCheck', 'probability:0.5', 'keyword:开会', 'atMention'];
    let turn = 10;
    for (const reason of reasons) {
      await quiesce(h, OWNER_KEY);                      // 清掉上一轮残留，保证这次唤醒真的投递（而不是被当成「忙」暂存）
      h.scheduleWakeV2(OWNER_KEY, reason);
      const woke = await waitUntil(() => linesOf(h.readLog(), new RegExp(`\\[reserved2\\] 唤醒 ${OWNER_KEY}（${reason.split(':')[0]}`)).length > 0, 5000);
      if (!woke) {
        const st = h.getSocialV2State(OWNER_KEY);
        console.log(`   [诊断] ${reason} 唤醒未投递：busy 输入 pendingWakeTimer=${!!st.pendingWakeTimer} pendingWakeKeys=${h.pendingWakeKeys.has(OWNER_KEY)}`
          + ` queue=${JSON.stringify(h.promptQueues.get(OWNER_KEY) ?? null)} turnMark=${h.v2TurnStartAt.has(sid)} collectors=${h.collectors.has(sid)}`
          + ` wakeTimes=${(st.wakeTimes ?? []).length}`);
        for (const line of String(h.readLog()).split(/\r?\n/).filter((l) => l.includes('唤醒') || l.includes('[cross-session]'))) console.log(`     | ${line}`);
      }
      assert.ok(woke, `桥接唤醒 ${reason} 必须真的投递（否则这不是一次「非管理员回合」）`);
      const before = count(h.readLog(), /\[cross-session\] 授权窗口开启/g);
      feed.push([turnStart(sid, turn)]);
      assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sid), 3000), `${reason} 的回合必须真的起来`);
      await sleep(120);
      assert.equal(h.ownerCrossSendV2.active, null, `${reason} 触发的回合绝不能被授权`);
      assert.equal(count(h.readLog(), /\[cross-session\] 授权窗口开启/g), before, `${reason} 回合不得打授权开启日志`);
      const denied = await probeTokenDenied(h, `${reason} 触发的回合`, 'no-grant',
        () => sendMessage(server, { key: OTHER_PRIVATE, messages: [`${reason} 回合越权尝试`], agentToken: token }));
      assert.equal(onebot(h, 'send_private_msg').length, 0, `${reason} 被拒后不得有任何 OneBot 请求`);
      feed.push([turnEnd(sid, turn)]);
      await waitUntil(() => !h.v2TurnStartAt.has(sid), 3000);
      turn += 1;
    }
    dump('非管理员回合（A 半）', h.readLog(), /[^\n]*\[cross-session\][^\n]*/);
    // ── B 半：同一会话，管理员来信触发 → 放行 ──
    const { active } = await openOwnerGrant(h, feed, { turn: 50, text: '现在去给 999 说一声' });
    assert.ok(active, '管理员来信触发的那一轮必须兑现授权（B 半）');
    const allowed = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['管理员指派的代发'], agentToken: token });
    assertAllowed(allowed, '管理员回合内的同样调用（V2 B 半）');
    assert.equal(onebot(h, 'send_private_msg').length, 1, 'A 半 0 条 + B 半 1 条 ⇒ 放行只发生在管理员回合');
    const log = h.readLog();
    dump('管理员回合（B 半）', log, /[^\n]*\[cross-session\][^\n]*/);
    assert.equal(count(log, /\[cross-session\] 授权窗口开启/g), 1, '全程只应有一次授权开启（B 半）');
    assert.equal(count(log, /\[cross-session\] 拒绝代发（no-grant）/g), reasons.length, `${reasons.length} 个非管理员回合各留 1 条拒绝留痕`);
    console.log(`   [证据] A 半 ${reasons.length} 个非管理员回合全部 403「${TOKEN_ERR}」+ no-grant 留痕、OneBot=0；B 半管理员回合 200、OneBot=1`);
  });
});

// ══ T3 授权窗口失效：过期 / 回合结束 / 标记被清 / 窗口内再来非管理员回合 ══
await test('V3 授权窗口失效：超 30 分钟(含边界) / turn/end / 回合标记被清 / 窗口内再来非管理员回合 → 全部 403', async () => {
  await withBridge(async (h, server) => {
    const { sid, token } = await ownerSession(h);
    await h.ensureSession(OTHER_PRIVATE);
    const feed = startMux(h);
    assert.equal(h.CROSS_SESSION_GRANT_MS, 1800000, '墙钟上限必须是 30 分钟（1800000ms）');
    const { active } = await openOwnerGrant(h, feed, { turn: 1 });
    assert.ok(active);
    // ① 边界之内（距上限约 -200ms）→ 放行（代码判据是 ageMs > GRANT 才拒）
    const ageNow = Date.now() - active.startedAt;
    h.setClockOffset(h.CROSS_SESSION_GRANT_MS - ageNow - 200);
    const inside = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['上限内仍应放行'], agentToken: token });
    assertAllowed(inside, '距上限 200ms 仍应放行（V3 ①）');
    // ② 超上限（距上限约 +200ms）→ 拒（grant-expired）
    h.setClockOffset(h.CROSS_SESSION_GRANT_MS - ageNow + 200);
    const expired = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['过期后越权尝试'], agentToken: token });
    assert.equal(expired.status, 403, `超上限必须 403，实测 ${expired.status} ${expired.raw}`);
    assert.equal(expired.data?.error, TOKEN_ERR);
    assert.match(h.readLog(), /\[cross-session\] 拒绝代发（grant-expired）[^\n]*目标=private:999/, '必须有 grant-expired 留痕');
    // ③ 时钟回拨回来 → 授权仍然有效（证明 ② 拒的是过期而非别的状态）
    h.setClockOffset(0);
    const backInTime = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['回拨回来'], agentToken: token });
    assertAllowed(backInTime, '时钟回到窗口内应恢复放行（V3 ③）');
    // ④ turn/end 正常收尾 → 窗口关闭
    feed.push([turnEnd(sid, 1)]);
    assert.ok(await waitUntil(() => linesOf(h.readLog(), /\[cross-session\] 授权窗口关闭/).length > 0, 3000), 'turn/end 必须打窗口关闭留痕');
    const closed = await probeTokenDenied(h, '回合结束后（V3 ④）', 'no-grant',
      () => sendMessage(server, { key: OTHER_PRIVATE, messages: ['回合结束后的越权尝试'], agentToken: token }));
    // ⑤ 重新授权后，把「在途回合标记」清掉（真实断流 finally 会这么做）→ 授权不得继续生效
    const re = await openOwnerGrant(h, feed, { turn: 2, text: '再发一次' });
    assert.ok(re.active);
    // ⑤【t61 有意变更】桥接可见的 ④ 被清（真实断流 finally / 自愈释放都会这么做）**不再**让授权失效：
    //   旧断言期望 `turn-ended` 403；t61 删掉了这条时序判据 —— 原因正是这次生产复现：驻留轮很可能
    //   压根没有桥接可见的 turn/start/④，硬卡它会把刚兑现的授权立刻作废。⇒ 现在必须**仍然 200**。
    h.v2TurnStartAt.delete(sid);
    const stillAllowed = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['④ 被清后仍然有效'], agentToken: token });
    assertAllowed(stillAllowed, '桥接可见的 ④ 被清后授权必须仍然有效（t61 有意移除 turn-ended）');
    assert.equal(h.v2TurnStartAt.has(sid), false, '（前置）此刻 ④ 确实不在');
    h.v2TurnStartAt.set(sid, Date.now());
    assertAllowed(await sendMessage(server, { key: OTHER_PRIVATE, messages: ['标记补回来'], agentToken: token }), '标记补回来同样放行（V3 ⑤ 对照）');
    // ⑥ 窗口内又来一个非管理员触发的回合 → 名额被吃掉且不重新授权
    feed.push([turnEnd(sid, 2)]);                            // 先让授权回合正常结束（给 ⑥ 一个干净起点）
    assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sid) === false, 3000), '授权回合必须能正常结束');
    await quiesce(h, OWNER_KEY);
    h.getSocialV2State(OWNER_KEY).wakeConfig.batchWindowMs = 1000;
    h.scheduleWakeV2(OWNER_KEY, 'proactiveCheck');
    assert.ok(await waitUntil(() => linesOf(h.readLog(), /\[reserved2\] 唤醒 private:123（proactiveCheck）/).length > 0, 5000), '非管理员唤醒必须真的投递');
    feed.push([turnStart(sid, 20)]);
    assert.ok(await waitUntil(() => h.ownerCrossSendV2.active === null, 3000), '非管理员回合必须把 active 归零');
    const afterHijack = await probeTokenDenied(h, '窗口被非管理员回合接管后（V3 ⑥）', 'no-grant',
      () => sendMessage(server, { key: OTHER_PRIVATE, messages: ['非管理员回合后的越权尝试'], agentToken: token }));
    const log = h.readLog();
    dump('窗口失效', log, /[^\n]*\[cross-session\][^\n]*/);
    console.log(`   [证据] 上限内(-200ms)=${inside.status} → 超上限(+200ms)=${expired.status}(grant-expired) → 回拨=${backInTime.status} → turn/end 后=${closed.status}(窗口关闭留痕) → ④ 被清后=${stillAllowed.status}(仍然 200：turn-ended 已按 t61 有意移除) → 非管理员回合接管=${afterHijack.status}(no-grant)且 active=${h.ownerCrossSendV2.active}`);
  });
});

// ══ T4 豁免只作用于发送路径：8 个其它会话级工具在 owner 授权轮内操作别的会话仍 403 ══
await test('V4 八个其它工具（unread/recent/images/mark-read/send-poke/collect-sticker/sticker-note/sticker-list）跨会话仍 403，本会话对照不再报令牌错', async () => {
  // 语音默认关闭（socialV2.voice.enabled=false）：这里显式打开，好让「跨会话发语音」走到令牌关卡而不是被总闸挡掉
  await withBridge(async (h, server) => {
    const { token } = await ownerSession(h);
    await h.ensureSession(OTHER_PRIVATE);
    const otherToken = h.getSocialV2State(OTHER_PRIVATE).agentToken;
    const feed = startMux(h);
    const { active } = await openOwnerGrant(h, feed, { turn: 1 });
    assert.ok(active, 'owner 授权轮必须生效（这些工具要在这个窗口内被验证）');
    const stOther = h.getSocialV2State(OTHER_PRIVATE);
    stOther.unread = [{ seq: 77, text: '别的会话的未读' }];
    stOther.lastUnreadSeq = 77;
    const unreadBefore = stOther.unread.length;
    const cases = [
      ['qq_get_unread_messages', () => agentRequest(server, { method: 'GET', pathname: '/api/socialV2/unread', query: { key: OTHER_PRIVATE, limit: 30 }, agentToken: token }),
        () => agentRequest(server, { method: 'GET', pathname: '/api/socialV2/unread', query: { key: OTHER_PRIVATE, limit: 30 }, agentToken: otherToken })],
      ['qq_get_recent_messages', () => agentRequest(server, { method: 'GET', pathname: '/api/socialV2/recent', query: { key: OTHER_PRIVATE, limit: 20 }, agentToken: token }),
        () => agentRequest(server, { method: 'GET', pathname: '/api/socialV2/recent', query: { key: OTHER_PRIVATE, limit: 20 }, agentToken: otherToken })],
      ['qq_get_message_images', () => agentRequest(server, { method: 'GET', pathname: '/api/images/message', query: { key: OTHER_PRIVATE, messageId: '1' }, agentToken: token }),
        () => agentRequest(server, { method: 'GET', pathname: '/api/images/message', query: { key: OTHER_PRIVATE, messageId: '1' }, agentToken: otherToken })],
      ['qq_mark_read', () => agentRequest(server, { pathname: '/api/socialV2/mark-read', body: { key: OTHER_PRIVATE, throughSeq: 77 }, agentToken: token }),
        () => agentRequest(server, { pathname: '/api/socialV2/mark-read', body: { key: OTHER_PRIVATE, throughSeq: 77 }, agentToken: otherToken })],
      ['qq_send_poke', () => agentRequest(server, { pathname: '/api/socialV2/send-poke', body: { key: OTHER_PRIVATE }, agentToken: token }),
        () => agentRequest(server, { pathname: '/api/socialV2/send-poke', body: { key: OTHER_PRIVATE }, agentToken: otherToken })],
      ['qq_collect_sticker', () => agentRequest(server, { pathname: '/api/socialV2/collect-sticker', body: { key: OTHER_PRIVATE, messageId: '77' }, agentToken: token }),
        () => agentRequest(server, { pathname: '/api/socialV2/collect-sticker', body: { key: OTHER_PRIVATE, messageId: '77' }, agentToken: otherToken })],
      ['qq_sticker_note', () => agentRequest(server, { pathname: '/api/socialV2/sticker-note', body: { key: OTHER_PRIVATE, stickerId: 'md5-fixture', note: '越权改备注' }, agentToken: token }),
        () => agentRequest(server, { pathname: '/api/socialV2/sticker-note', body: { key: OTHER_PRIVATE, stickerId: 'md5-fixture', note: '本会话正常调用' }, agentToken: otherToken })],
      ['qq_list_stickers', () => agentRequest(server, { method: 'GET', pathname: '/api/socialV2/sticker-list', query: { key: OTHER_PRIVATE }, agentToken: token }),
        () => agentRequest(server, { method: 'GET', pathname: '/api/socialV2/sticker-list', query: { key: OTHER_PRIVATE }, agentToken: otherToken })],
    ];
    const summary = [];
    for (const [tool, crossCall, ownCall] of cases) {
      const cross = await crossCall();
      assert.equal(cross.status, 403, `${tool}：owner 授权轮内跨会话调用必须 403，实测 ${cross.status} ${cross.raw}`);
      assert.equal(cross.data?.error, TOKEN_ERR, `${tool}：拒绝文案必须原样「${TOKEN_ERR}」，实测 ${cross.raw}`);
      const own = await ownCall();
      assert.notEqual(own.data?.error, TOKEN_ERR,
        `${tool}：同一请求换本会话令牌必须不再是令牌错（否则用例只是被更早的参数校验挡住）实测 ${own.status} ${own.raw}`);
      summary.push(`${tool}:cross=${cross.status},own=${own.status}`);
    }
    // 副作用：被拒的 mark-read 不得改动目标会话的已读水位/标记
    assert.equal(stOther.unread.length, unreadBefore, '被拒的跨会话调用不得改动目标会话未读');
    assert.equal(h.markReadCalledKeys.has(OTHER_PRIVATE), false, '被拒的跨会话 mark_read 不得登记已读');
    // 放宽只覆盖 3 个**文本发送**端点：表情/语音这两个同样带 agent token 的发送端点不在豁免内
    const stickerSend = await agentRequest(server, { pathname: '/api/socialV2/send-sticker', body: { key: OTHER_PRIVATE, stickerId: 'md5-fixture' }, agentToken: token });
    assert.equal(stickerSend.status, 403, `跨会话发表情未列入豁免 ⇒ 必须 403，实测 ${stickerSend.status} ${stickerSend.raw}`);
    assert.equal(stickerSend.data?.error, TOKEN_ERR, '发表情的拒绝文案必须原样');
    const voiceSend = await agentRequest(server, { pathname: '/api/socialV2/send-voice', body: { key: OTHER_PRIVATE, text: '跨会话语音' }, agentToken: token });
    assert.equal(voiceSend.status, 403, `跨会话发语音未列入豁免 ⇒ 必须 403，实测 ${voiceSend.status} ${voiceSend.raw}`);
    assert.equal(voiceSend.data?.error, TOKEN_ERR, '发语音的拒绝文案必须原样');
    // 发送路径仍然可用（授权轮内），证明「只有发送路径放宽」而不是整块 v2 面被拒
    const send = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['授权轮内正常代发'], agentToken: token });
    assertAllowed(send, '授权轮内发送路径对照（V4）');
    console.log(`   [证据] ${summary.join(' | ')}；表情/语音两个未豁免的发送端点=${stickerSend.status}/${voiceSend.status}；目标会话 unread=${stOther.unread.length}(未变)、markReadCalledKeys=false；发送路径对照=${send.status}`);
  }, { socialV2: { voice: { enabled: true } } });
});

// ══ T5 白名单边界：白名单外私聊/群一律拒；owner 自己与白名单内目标符合设计 ══
await test('V5 白名单边界：allow 外私聊/群即使来自 owner 授权轮也拒；owner 自己=原同会话路径；白名单内群放行', async () => {
  await withBridge(async (h, server) => {
    const { token } = await ownerSession(h);
    await h.ensureSession(OTHER_GROUP);
    const feed = startMux(h);
    const { active } = await openOwnerGrant(h, feed, { turn: 1 });
    assert.ok(active);
    const outPrivate = await sendMessage(server, { key: OUT_PRIVATE, messages: ['给白名单外的私聊'], agentToken: token });
    assertWhitelistDenied(outPrivate, '白名单外私聊（/api/socialV2/send-message）');
    const outGroup = await sendMessage(server, { key: OUT_GROUP, messages: ['给白名单外的群'], agentToken: token });
    assertWhitelistDenied(outGroup, '白名单外群（/api/socialV2/send-message）');
    // t38 修复：/api/send/* 读的是 **body.token**（src/bridge.js:7605），只发 x-agent-token 头会被
    // src/bridge.js:7632 先以「reserved2 模式发送必须携带 agent token」403 —— 那样「必须 403」会通过，
    // 但根本没打到白名单闸门。这里必须带 body.token，并断言拒因是白名单文案。
    const outViaSendPrivate = await agentRequest(server, {
      pathname: '/api/send/private',
      body: { token, userId: '888', message: '走另一个发送端点也不行' },
      agentToken: token,
    });
    assertWhitelistDenied(outViaSendPrivate, '白名单外私聊（/api/send/private，带 body.token）');
    // owner 自己的会话：这是「同会话」原路径（令牌本来就对），t29 不改它
    const self = await sendMessage(server, { key: OWNER_KEY, messages: ['给我自己（管理员）说一句'], agentToken: token });
    assertAllowed(self, 'owner 给自己发走原同会话路径');
    // 白名单内的群：授权轮内跨会话放行
    const group = await sendMessage(server, { key: OTHER_GROUP, messages: ['替管理员在群里说一句'], agentToken: token });
    assertAllowed(group, '白名单内群目标（V5）');
    const groupSends = onebot(h, 'send_group_msg');
    assert.equal(groupSends.length, 1, `必须真的发出 1 条群消息，实测 ${groupSends.length}`);
    assert.equal(String(groupSends[0].body?.group_id), '456', `OneBot 群目标必须是 456：${JSON.stringify(groupSends[0].body)}`);
    const log = h.readLog();
    assert.equal(count(log, /\[cross-session\] 代发成功/g), 1, '只有那一条跨会话代发留成功留痕');
    assert.ok(!/代发成功[^\n]*目标=private:123/.test(log), 'owner 给自己发走的是原同会话路径，不得被记成跨会话代发');
    dump('白名单边界', log, /[^\n]*\[cross-session\][^\n]*/);
    console.log(`   [证据] 白名单外 private=${outPrivate.status}/group=${outGroup.status}/send-private=${outViaSendPrivate.status}；owner 自己=${self.status}(原同会话路径，无代发留痕)；白名单内群=${group.status}(OneBot group_id=456)`);
  });
});

// ══ T6 非 owner 会话：跨会话仍拒（**唯一例外**＝t82 窄豁免指向主人私聊），各自发自己照旧 ══
await test('V6 非 owner 会话（群 / 其它私聊）跨会话仍 403；→ 主人私聊走 t82 窄豁免 200；各自发自己照旧 200；非 owner 来信不登记名额', async () => {
  await withBridge(async (h, server) => {
    await ownerSession(h);
    await h.ensureSession(OTHER_PRIVATE);
    await h.ensureSession(OTHER_GROUP);
    const tokenGroup = h.getSocialV2State(OTHER_GROUP).agentToken;
    const tokenOther = h.getSocialV2State(OTHER_PRIVATE).agentToken;
    const feed = startMux(h);
    const g2p = await probeTokenDenied(h, '群会话 → 私聊（V6）', 'isolation',
      () => sendMessage(server, { key: OTHER_PRIVATE, messages: ['群会话想给私聊发'], agentToken: tokenGroup }));
    const p2g = await probeTokenDenied(h, '其它私聊 → 群（V6）', 'isolation',
      () => sendMessage(server, { key: OTHER_GROUP, messages: ['其它私聊想给群发'], agentToken: tokenOther }));
    assert.equal(onebot(h, 'send_private_msg').length + onebot(h, 'send_group_msg').length, 0, '以上被拒请求不得产生 OneBot 请求');
    // t82（窄豁免，2026-10-08）：非 owner 会话的**真实令牌**只能发给「主人私聊」这**一个**目标 ——
    // 用户在预设里要求「敏感内容不往群里带、但可以私下告诉主人」，所以这一条是**唯一**被允许的跨会话目标。
    const otherSt = h.getSocialV2State(OTHER_PRIVATE);
    const ownerSt = h.getSocialV2State(OWNER_KEY);
    const otherBudget = otherSt.sendTimes.length;
    const ownerBudget = ownerSt.sendTimes.length;
    const p2owner = await sendMessage(server, { key: OWNER_KEY, messages: ['其它私聊想给管理员发'], agentToken: tokenOther });
    assertAllowed(p2owner, '其它私聊 → 主人私聊（t82 窄豁免）');
    const ownerSends = onebot(h, 'send_private_msg');
    assert.equal(ownerSends.length, 1, `窄豁免必须真的发出 1 条，实测 ${ownerSends.length}`);
    assert.equal(String(ownerSends[0].body?.user_id), String(OWNER_QQ), `窄豁免必须发给主人私聊：${JSON.stringify(ownerSends[0].body)}`);
    const exemptLog = h.readLog();
    const exemptAudit = (exemptLog.match(/\[cross-session\] \[cross-send→owner\][^\n]*/g) ?? []).pop() ?? '';
    assert.match(exemptAudit, /豁免代发成功/, `窄豁免必须留痕：${exemptAudit}`);
    assert.match(exemptAudit, new RegExp(`来源=${OTHER_PRIVATE}`), `留痕必须写明来源会话：${exemptAudit}`);
    assert.match(exemptAudit, new RegExp(`目标=${OWNER_KEY}`), `留痕必须写明目标（主人私聊）：${exemptAudit}`);
    assert.equal(count(exemptLog, /\[cross-session\] 代发成功/g), 0, '窄豁免不得被记成 A′ 代发成功（两条路径的审计行必须可区分）');
    assert.equal(otherSt.sendTimes.length, otherBudget + 1, '窄豁免的限频必须记在**来源会话**的账上');
    assert.equal(ownerSt.sendTimes.length, ownerBudget, '窄豁免不得记到目标（主人）的账上');
    // 各自发自己（原能力）不得被这次放宽改坏
    const selfGroup = await sendMessage(server, { key: OTHER_GROUP, messages: ['我自己在群里说话'], agentToken: tokenGroup });
    assertAllowed(selfGroup, '群会话发自己（V6）');
    const selfOther = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['我自己私聊说话'], agentToken: tokenOther });
    assertAllowed(selfOther, '其它私聊发自己（V6）');
    // 非 owner 来信不得登记名额：999 来信 + 999 的回合 → 无授权
    const sidOther = h.state.sessions[OTHER_PRIVATE];
    await h.handleIncoming('private', 999, ownerPrivateMessage('我（999）也想指派', 999), h.cfg);
    assert.equal(h.ownerCrossSendV2.pending, null, '非 owner 私聊来信绝不能被登记为待兑现名额');
    feed.push([turnStart(sidOther, 7)]);
    assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sidOther), 3000), '999 的回合必须真的起来');
    await sleep(120);
    assert.equal(h.ownerCrossSendV2.active, null, '非 owner 会话的回合不得获得任何跨会话授权');
    const denied = await sendMessage(server, { key: OTHER_GROUP, messages: ['999 回合越权'], agentToken: tokenOther });
    assertTokenDenied(denied, '非 owner 回合内的跨会话发送（V6）');
    dump('非 owner', h.readLog(), /[^\n]*\[cross-session\][^\n]*/);
    console.log(`   [证据] 群→私聊=${g2p.status}、私聊→群=${p2g.status}（其余目标仍全拒）；私聊→owner=${p2owner.status}（t82 窄豁免，OneBot user_id=${ownerSends[0].body?.user_id}，审计带 [cross-send→owner]）；各自发自己=${selfGroup.status}/${selfOther.status}；非 owner 来信 pending=null、回合 active=null、越权=${denied.status}`);
  });
});

// ══ T7 令牌语义：空/伪造令牌/会话重置后一律 403；别的会话令牌只许打「主人私聊」这一格 ══
await test('V7 令牌语义：空/伪造令牌/重置后一律 403；别的会话令牌→主人私聊走 t82 窄豁免；会话映射漂移=session-changed', async () => {
  await withBridge(async (h, server) => {
    const { sid, token } = await ownerSession(h);
    await h.ensureSession(OTHER_PRIVATE);
    const otherToken = h.getSocialV2State(OTHER_PRIVATE).agentToken;
    const feed = startMux(h);
    const { active } = await openOwnerGrant(h, feed, { turn: 1 });
    assert.ok(active);
    const empty = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['空令牌'], agentToken: '' });
    assert.equal(empty.status, 403, `空令牌必须 403，实测 ${empty.status} ${empty.raw}`);
    // 带 x-agent-call 时空令牌先被**集中关卡**（isLiveAgentToken）拒绝，这是实测到的那道闸门
    assert.match(String(empty.data?.error ?? ''), /必须携带有效的会话令牌/, `空令牌 + x-agent-call 应由集中关卡拒绝，实测 ${empty.raw}`);
    // 不带 x-agent-call 时才会走到端点自己的空令牌闸门 —— 两个拒因都钉住，免得以后搞混是哪一道在挡
    const emptyNoCall = await agentRequest(server, { pathname: '/api/socialV2/send-message', body: { key: OTHER_PRIVATE, messages: ['空令牌（无 x-agent-call）'] }, agentToken: '', agentCall: false });
    assert.equal(emptyNoCall.status, 403, `空令牌（无 x-agent-call）必须 403，实测 ${emptyNoCall.status} ${emptyNoCall.raw}`);
    assert.equal(String(emptyNoCall.data?.error ?? ''), 'agent token 不能为空', `拒因必须是「agent token 不能为空」，实测 ${emptyNoCall.raw}`);
    const forged = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['伪造令牌'], agentToken: 'not-a-real-session-token' });
    assert.equal(forged.status, 403, `伪造令牌必须 403，实测 ${forged.status} ${forged.raw}`);
    assert.match(String(forged.data?.error ?? ''), /必须携带有效的会话令牌/, `伪造令牌应由 x-agent-call 集中关卡拒绝，实测 ${forged.raw}`);
    // t82：别的会话的令牌 → **主人私聊**这一目标是被允许的唯一跨会话例外（令牌仍必须是它自己的真实令牌）。
    // 注意：这条豁免与 A′ 无关，靠的是「目标恰等于 ownerSessionKeyV2()」，所以这里同时钉住审计标记与来源。
    const otherSession = await sendMessage(server, { key: OWNER_KEY, messages: ['用别的会话令牌以 owner 为目标'], agentToken: otherToken });
    assertAllowed(otherSession, '别的会话令牌 → 主人私聊（t82 窄豁免：目标是主人私聊这一个 key）');
    const narrowAudit = (h.readLog().match(/\[cross-session\] \[cross-send→owner\][^\n]*/g) ?? []).pop() ?? '';
    assert.match(narrowAudit, /豁免代发成功/, `窄豁免必须留痕：${narrowAudit}`);
    assert.match(narrowAudit, new RegExp(`来源=${OTHER_PRIVATE}`), `留痕必须写明来源会话：${narrowAudit}`);
    assert.match(narrowAudit, new RegExp(`目标=${OWNER_KEY}`), `留痕必须写明目标：${narrowAudit}`);
    // owner 令牌 + 别的会话为目标，但会话映射被换掉（重置/重建竞态）→ session-changed
    const realSessionId = h.ownerCrossSendV2.active.sessionId;
    h.ownerCrossSendV2.active.sessionId = 'stale-session-id';
    const stale = await probeTokenDenied(h, '会话映射漂移（V7）', 'session-changed',
      () => sendMessage(server, { key: OTHER_PRIVATE, messages: ['会话已经换了'], agentToken: token }));
    h.ownerCrossSendV2.active.sessionId = realSessionId;
    assertAllowed(await sendMessage(server, { key: OTHER_PRIVATE, messages: ['映射补回来'], agentToken: token }), '会话映射补回应恢复放行（V7 对照）');
    // 不带令牌（连头都不带）：reserved2 发送必须要求令牌 —— 豁免不得变成"无令牌也能发"
    const noToken = await agentRequest(server, { pathname: '/api/socialV2/send-message', body: { key: OTHER_PRIVATE, messages: ['不带令牌'] } });
    assert.equal(noToken.status, 403, `不带 agent token 必须 403，实测 ${noToken.status} ${noToken.raw}`);
    assert.match(noToken.data?.error ?? '', /必须携带 agent token/, `应当是「必须携带令牌」而不是别的：${noToken.raw}`);
    // 暂停闸门没有被这次放宽绕过
    h.socialV2.paused = true;
    const paused = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['暂停期间越权'], agentToken: token });
    assert.equal(paused.status, 403, `暂停期间必须 403，实测 ${paused.status} ${paused.raw}`);
    assert.match(paused.data?.error ?? '', /已暂停/, `应当是暂停闸门：${paused.raw}`);
    h.socialV2.paused = false;
    assertAllowed(await sendMessage(server, { key: OTHER_PRIVATE, messages: ['解除暂停后再发'], agentToken: token }), '解除暂停后恢复放行（V7 对照）');
    // key 的规范形：'private:0123' 与 owner 自己等价 ⇒ 对 owner 令牌是「同会话」，对**别的**令牌则是
    // t82 窄豁免那一格（规范形 == 主人私聊 key）；owner 令牌 + 规范形走原同会话路径、不得多一条跨会话留痕。
    const canonCross = await sendMessage(server, { key: 'private:0123', messages: ['别的令牌打 owner 规范形 key'], agentToken: otherToken });
    assertAllowed(canonCross, '别的会话令牌 → 主人私聊规范形 private:0123（t82 窄豁免，规范化后就是那一个 key）');
    assert.match((h.readLog().match(/\[cross-session\] \[cross-send→owner\][^\n]*/g) ?? []).pop() ?? '',
      new RegExp(`目标=${OWNER_KEY}`), '窄豁免的审计行必须写出规范化后的主人私聊 key');
    const successBefore = count(h.readLog(), /\[cross-session\] 代发成功/g);
    const canonSelf = await sendMessage(server, { key: 'private:0123', messages: ['规范形=自己'], agentToken: token });
    assertAllowed(canonSelf, 'owner 令牌 + 规范形=自己 走原同会话路径');
    assert.equal(count(h.readLog(), /\[cross-session\] 代发成功/g), successBefore, '规范形=自己 不得被记成跨会话代发');
    // 真实会话重置端点（控制台路径）→ 授权必须作废，旧令牌不能再代发
    const reset = await agentRequest(server, { pathname: '/api/session/reset', body: { key: OWNER_KEY }, agentToken: undefined });
    assertAllowed(reset, '会话重置端点（V7 控制台路径）');
    assert.equal(h.ownerCrossSendV2.active, null, '会话重置必须把被授权回合作废');
    assert.equal(h.ownerCrossSendV2.pending, null, '会话重置必须把待兑现名额作废');
    const afterReset = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['重置之后还想发'], agentToken: token });
    assert.equal(afterReset.status, 403, `会话重置后旧令牌不得再代发，实测 ${afterReset.status} ${afterReset.raw}`);
    assert.match(String(afterReset.data?.error ?? ''), /必须携带有效的会话令牌/,
      `重置后旧令牌应由集中关卡拒绝（forgetAgentToken 之后令牌不再 live），实测 ${afterReset.raw}`);
    // 说明：重置端点会 forgetAgentToken（src/bridge.js:7806）⇒ 旧令牌连「活跃会话」都不算，
    // 先被集中关卡（x-agent-call → isLiveAgentToken）拒掉 —— 比端点级令牌校验更强。
    assert.match(h.readLog(), /\[cross-session\] 授权窗口作废（会话已重置）/, '必须有作废留痕');
    assert.equal(h.v2TurnStartAt.has(sid), false, '重置后旧在途回合标记必须已清（对照）');
    console.log(`   [证据] 空令牌=${empty.status}(集中关卡)、空令牌无 x-agent-call=${emptyNoCall.status}(agent token 不能为空)、伪造=${forged.status}、别的会话令牌→主人私聊=${otherSession.status}(t82 窄豁免，审计带 [cross-send→owner])、`
      + `映射漂移=${stale.status}(session-changed)、恢复后=200、不带令牌=${noToken.status}(必须携带 agent token)、暂停中=${paused.status}(暂停闸门)、解除暂停=200、`
      + `规范形 key(private:0123)+别的令牌=${canonCross.status}(窄豁免)、+owner 令牌=${canonSelf.status}、重置后=${afterReset.status}（作废留痕见日志）`);
  });
});

// ══ T8 判定来源：管理员身份只来自 config.ownerQQ（运行时改 + 配置文件改都跟随），且无硬编码 QQ ══
await test('V8 判定来源：改 cfg.ownerQQ 即跟随（旧管理员立刻失去能力），配置文件换 owner 同样成立，代码无硬编码 QQ', async () => {
  // ① 运行时改 ownerQQ
  await withBridge(async (h, server) => {
    // ① 运行时改 ownerQQ —— 先把探活回合收尾，再让新管理员的来信唤醒被真正投递
    const { token } = await ownerSession(h);
    await h.ensureSession(OWNER_PRIVATE_ALT);
    const feed = startMux(h);
    h.cfg.ownerQQ = 999;                                  // 管理员换成白名单内的 999
    assert.equal(h.ownerSessionKeyV2(), 'private:999', 'owner 会话 key 必须跟随配置热读');
    await h.handleIncoming('private', OWNER_QQ, ownerPrivateMessage('旧管理员还想指派'), h.cfg);
    assert.equal(h.ownerCrossSendV2.pending, null, '换 owner 后，旧管理员的来信不得再登记名额');
    const sidNew = h.state.sessions[OWNER_PRIVATE_ALT];
    feed.push([turnStart(sidNew, 3)]);
    assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sidNew), 3000));
    await sleep(120);
    assert.equal(h.ownerCrossSendV2.active, null, '没有新管理员的来信 ⇒ 不得授权');
    feed.push([turnEnd(sidNew, 3)]);                      // 收尾这一轮（否则后续投递会被判忙暂存）
    assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sidNew) === false, 3000), '探活回合必须能正常收尾');
    const oldTokenDenied = await probeTokenDenied(h, '配置换 owner 后旧会话令牌（V8①）', 'isolation',
      () => sendMessage(server, { key: OTHER_GROUP, messages: ['旧 owner 令牌'], agentToken: token }));
    // 新管理员的来信 → 承载来信的唤醒被真正投递 → 就地兑现 → 新 manager 的令牌放行
    const newToken = h.getSocialV2State(OWNER_PRIVATE_ALT).agentToken;
    await h.handleIncoming('private', 999, ownerPrivateMessage('我是新管理员，去群里说一句', 999), h.cfg);
    assert.ok(h.ownerCrossSendV2.pending, '新管理员的来信必须登记名额');
    const seqNew = h.getSocialV2State(OWNER_PRIVATE_ALT).lastUnreadSeq;
    await quiesce(h, OWNER_PRIVATE_ALT);
    await h.sendWakePromptV2(OWNER_PRIVATE_ALT, 'private', { seq: seqNew });
    assert.ok(await waitUntil(() => h.ownerCrossSendV2.active, 3000), '新管理员的来信唤醒被投递时必须兑现授权');
    feed.push([turnStart(sidNew, 4)]);                   // 投递时空闲 ⇒ adoptNextTurnStart ⇒ 这一轮被接管（授权不清）
    assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sidNew), 3000), '（夹具）授权轮必须起来');
    const newAllowed = await sendMessage(server, { key: OTHER_GROUP, messages: ['新管理员指派的群消息'], agentToken: newToken });
    assertAllowed(newAllowed, '新管理员授权轮内（V8①）');
    assert.match(h.readLog(), /\[cross-session\] 授权窗口开启：管理员 999/, '审计行里的授权人必须是新配置值');
    dump('换 owner（运行时）', h.readLog(), /[^\n]*\[cross-session\][^\n]*/);
    console.log(`   [证据] cfg.ownerQQ 123→999：旧令牌=${oldTokenDenied.status}、新管理员回合=${newAllowed.status}、审计行授权人=999`);
  });
  // ② 配置文件里换 owner（证明来自 config，不来自代码）
  await withBridge(async (h, server) => {
    const { token } = await ownerSession(h);            // private:123 在这个 harness 里不是 owner
    await h.ensureSession(OTHER_PRIVATE);
    const sidNewOwner = h.state.sessions[OTHER_PRIVATE];
    const feed = startMux(h);
    assert.equal(h.ownerSessionKeyV2(), 'private:999', 'owner 会话 key 必须等于 config.ownerQQ');
    await h.handleIncoming('private', OWNER_QQ, ownerPrivateMessage('123 还想指派'), h.cfg);
    assert.equal(h.ownerCrossSendV2.pending, null, 'config 里 123 不是 owner ⇒ 123 的来信不得登记');
    await h.handleIncoming('private', 999, ownerPrivateMessage('999 是 owner', 999), h.cfg);
    assert.ok(h.ownerCrossSendV2.pending, 'config 里的 owner（999）来信必须登记');
    const seq999 = h.getSocialV2State(OTHER_PRIVATE).lastUnreadSeq;
    await quiesce(h, OTHER_PRIVATE);
    await h.sendWakePromptV2(OTHER_PRIVATE, 'private', { seq: seq999 });
    assert.ok(await waitUntil(() => h.ownerCrossSendV2.active, 3000), 'config 里的 owner 来信唤醒被投递时必须兑现');
    feed.push([turnStart(sidNewOwner, 5)]);
    const denied = await probeTokenDenied(h, 'config 里的非 owner 令牌（V8②）', 'isolation',
      () => sendMessage(server, { key: OTHER_GROUP, messages: ['123 的令牌'], agentToken: token }));
    const allowed = await sendMessage(server, { key: OTHER_GROUP, messages: ['999 的令牌'], agentToken: h.getSocialV2State(OTHER_PRIVATE).agentToken });
    assertAllowed(allowed, 'config 里的 owner 令牌（V8②）');
    console.log('   [证据] config.ownerQQ=999 的新 harness：123 来信 pending=null、令牌 403；999 来信→唤醒投递兑现→回合被接管→200');
  }, { ownerQQ: 999, allow: { private: ['123', '999'], groups: ['456', '987'] } });
  // ③ 静态：判定在桥接层（HTTP 403 已实证）+ 无硬编码 QQ
  const source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const stateMachine = source.slice(source.indexOf('── 跨会话发送（t29）'), source.indexOf('function busyWatchdogConfig'));
  const checkBody = source.slice(source.indexOf('const crossSessionSendCheckV2'), source.indexOf('const logCrossSendDeniedV2'));
  assert.ok(stateMachine.length > 500 && checkBody.length > 500, '必须能定位授权状态机与判定函数');
  assert.match(stateMachine, /const id = String\(cfg\.ownerQQ \?\? ''\)\.trim\(\)/, 'owner 身份必须只从 cfg.ownerQQ 读取');
  assert.match(stateMachine, /if \(\(canonicalV2Key\(key\) \?\? String\(key \?\? ''\)\) !== own\) return false;/, '名额登记必须比对「配置里的 owner 会话」，不是写死的会话');
  assert.match(checkBody, /if \(!agentTokenOk\(own, token\)\) return \{ ok: false, reason: 'not-owner-token' \};/, '必须要求令牌属于 owner 会话本身');
  const numerics = [...new Set((stripComments(stateMachine + checkBody).match(/\b\d{5,}\b/g) ?? []))];
  assert.deepEqual(numerics.sort(), ['1800000', '60000'], `跨会话实现里不得出现硬编码 QQ 号（去掉注释后只允许时限常量），实测 ${JSON.stringify(numerics)}`);
  console.log(`   [证据] 去掉注释后，跨会话实现里的 5 位以上数字字面量=${JSON.stringify(numerics)}（只有时限常量，无 QQ 号）；身份判定=cfg.ownerQQ；拒绝发生在 HTTP 层（上面全是真 403）`);
});

// ══ T9 第三方隔离与时序：别的会话的来信/回合不影响 owner 名额；多条管理员来信仍只兑现一次 ══
await test('V9 第三方隔离：别的会话起回合/回合结束不影响 owner 名额；owner 群里发言不登记；两条管理员来信只兑现一次', async () => {
  await withBridge(async (h, server) => {
    const { sid, token } = await ownerSession(h);
    await h.ensureSession(OTHER_PRIVATE);
    await h.ensureSession(OTHER_GROUP);
    const sidOther = h.state.sessions[OTHER_PRIVATE];
    const feed = startMux(h);
    // owner 在**群里**发言：isOwner 为真但 kind=group ⇒ 不得登记名额
    await h.handleIncoming('group', 456, groupMessage('我是管理员，但我在群里说', OWNER_QQ), h.cfg);
    assert.equal(h.ownerCrossSendV2.pending, null, '管理员在群里的发言不得登记跨会话名额（授权来源必须是私聊来信）');
    // 管理员私聊来信 → 名额；期间别的会话起回合、结束回合
    await h.handleIncoming('private', OWNER_QQ, ownerPrivateMessage('去给 999 说一声'), h.cfg);
    assert.ok(h.ownerCrossSendV2.pending, '私聊来信必须登记名额');
    feed.push([turnStart(sidOther, 31), turnEnd(sidOther, 31)]);
    assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sidOther) === false, 3000), '第三方回合必须能跑完');
    assert.ok(h.ownerCrossSendV2.pending, '第三方回合不得吃掉/清掉 owner 的名额');
    assert.equal(h.ownerCrossSendV2.active, null, '第三方回合不得获得授权');
    // 第二条管理员来信：覆盖式登记（仍只兑现一次）
    await h.handleIncoming('private', OWNER_QQ, ownerPrivateMessage('再补一句，还是给 999'), h.cfg);
    const seqLatest = h.getSocialV2State(OWNER_KEY).lastUnreadSeq;   // 覆盖后 pending.seq = 最新来信的 seq
    await quiesce(h, OWNER_KEY);
    await h.sendWakePromptV2(OWNER_KEY, 'private', { seq: seqLatest });
    assert.ok(await waitUntil(() => h.ownerCrossSendV2.active, 3000), '承载管理员来信的唤醒被投递时必须兑现名额');
    assert.equal(h.ownerCrossSendV2.pending, null, '名额是一次性的：兑现后必须清空');
    feed.push([turnStart(sid, 41)]);                                 // 投递时空闲 ⇒ adoptNextTurnStart ⇒ 接管这一轮
    assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sid), 3000), '（夹具）授权轮必须起来');
    assertAllowed(await sendMessage(server, { key: OTHER_PRIVATE, messages: ['第一次替管理员'], agentToken: token }), '授权轮内第一次代发（V9）');
    feed.push([turnEnd(sid, 41)]);
    assert.ok(await waitUntil(() => h.ownerCrossSendV2.active === null, 3000), '授权回合结束必须关窗');
    // 同名额不得被「补发/重放」重新激活：再来一个 owner 回合（无新来信）→ 仍被拒
    feed.push([turnStart(sid, 42)]);
    assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sid), 3000));
    await sleep(120);
    assert.equal(h.ownerCrossSendV2.active, null, '没有新的管理员来信时，后续 owner 回合不得自动获得授权');
    const after = await probeTokenDenied(h, '缺少新来信的后续 owner 回合（V9）', 'no-grant',
      () => sendMessage(server, { key: OTHER_PRIVATE, messages: ['第二个 owner 回合越权'], agentToken: token }));
    const log = h.readLog();
    dump('第三方隔离', log, /[^\n]*\[cross-session\][^\n]*/);
    assert.equal(count(log, /\[cross-session\] 授权窗口开启/g), 1, '两条管理员来信只兑现一次窗口');
    console.log(`   [证据] 群里发言 pending=null；第三方回合不影响名额；兑现后 pending=null、关窗后无新来信的回合=${after.status}；窗口开启仅 1 次`);
  });
});

// ══ T13 新不变量（t61）：授权**严格绑定来信 seq** —— 无关唤醒一律不截胡 ══
// 旧口径（「管理员来信后第一个 owner 回合兑现」）已被 t61 有意废除：那正是生产里「名额登记了却等不到
// 兑现」的一半原因（reserved2 的 owner 私聊长期驻留在同一轮里，不会再有新 turn/start）。
// 新口径 = 「承载这封来信的那次唤醒被**真正投递**」才兑现，且投递必须携带**同一 seq**。
await test('V13 新不变量·严格 seq 绑定：无关唤醒（无 seq）与别的 seq 都不得截胡；带来信 seq 的那次投递才兑现', async () => {
  await withBridge(async (h, server) => {
    const { sid, token } = await ownerSession(h);
    await h.ensureSession(OTHER_PRIVATE);
    const feed = startMux(h);
    await h.handleIncoming('private', OWNER_QQ, ownerPrivateMessage('帮我给 999 说一声'), h.cfg);
    assert.ok(h.ownerCrossSendV2.pending, '管理员来信必须登记名额');
    const letterSeq = h.getSocialV2State(OWNER_KEY).lastUnreadSeq;
    // ① 无关唤醒（无 seq，如 proactiveCheck）被真正投递 ⇒ 绝不兑现
    await quiesce(h, OWNER_KEY);
    h.scheduleWakeV2(OWNER_KEY, 'proactiveCheck');
    assert.ok(await waitUntil(() => linesOf(h.readLog(), /\[reserved2\] 唤醒 private:123（proactiveCheck）/).length > 0, 5000), '无关唤醒必须真的投递');
    assert.equal(h.ownerCrossSendV2.active, null, '无 seq 的唤醒不得兑现名额（不截胡）');
    assert.equal(count(h.readLog(), /\[cross-session\] 授权窗口开启/g), 0, '不得打授权开启日志');
    await probeTokenDenied(h, '无关唤醒之后（V13 ①）', 'no-grant',
      () => sendMessage(server, { key: OTHER_PRIVATE, messages: ['无关唤醒回合越权'], agentToken: token }));
    // ② 带**别的 seq**的唤醒被真正投递 ⇒ 同样不兑现（严格相等），且不得消费掉名额
    await quiesce(h, OWNER_KEY);
    await h.sendWakePromptV2(OWNER_KEY, 'private', { seq: letterSeq + 1 });
    await sleep(200);
    assert.equal(h.ownerCrossSendV2.active, null, 'seq 不等于来信 seq 的唤醒不得兑现');
    assert.ok(h.ownerCrossSendV2.pending, 'seq 不匹配的投递不得消费掉名额');
    // ③ 带来信 seq 的那次投递 ⇒ 兑现 ⇒ 同轮可代发（一次性）
    await quiesce(h, OWNER_KEY);
    await h.sendWakePromptV2(OWNER_KEY, 'private', { seq: letterSeq });
    assert.ok(await waitUntil(() => h.ownerCrossSendV2.active, 3000), '带来信 seq 的投递必须兑现');
    assert.equal(h.ownerCrossSendV2.pending, null, '兑现后名额必须清空（一次性）');
    feed.push([turnStart(sid, 70)]);
    assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sid), 3000), '（夹具）授权轮必须起来');
    assertAllowed(await sendMessage(server, { key: OTHER_PRIVATE, messages: ['带来信 seq 的投递所兑现的这一轮里代发'], agentToken: token }), '兑现轮内代发（V13 ③）');
    // ④ 该轮 turn/end 关闭 ⇒ 下一轮仍拒（一次性）
    feed.push([turnEnd(sid, 70)]);
    assert.ok(await waitUntil(() => h.ownerCrossSendV2.active === null, 3000), 'turn/end 必须关窗');
    feed.push([turnStart(sid, 71)]);
    assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sid), 3000));
    await sleep(150);
    await probeTokenDenied(h, '名额一次性：下一轮（V13 ④）', 'no-grant',
      () => sendMessage(server, { key: OTHER_PRIVATE, messages: ['下一轮越权'], agentToken: token }));
    dump('严格 seq 绑定', h.readLog(), /[^\n]*\[cross-session\][^\n]*/);
    console.log(`   [证据] 来信 seq=${letterSeq}：无 seq 的唤醒投递 ⇒ active=null；seq=${letterSeq + 1} 投递 ⇒ 不兑现且 pending 保留；`
      + `seq=${letterSeq} 投递 ⇒ 兑现 + 200；该轮 turn/end 后下一轮 403(no-grant)`);
  });
});

// ══ T11 过期名额：管理员来信后很久才起回合（>30 分钟）→ 不得兑现 ══
await test('V11 过期名额：管理员来信 >30 分钟后才起回合 → 名额作废（不得兑现），发送仍 403', async () => {
  await withBridge(async (h, server) => {
    const { sid, token } = await ownerSession(h);
    await h.ensureSession(OTHER_PRIVATE);
    const feed = startMux(h);
    await h.handleIncoming('private', OWNER_QQ, ownerPrivateMessage('（很久以前）去给 999 说一声'), h.cfg);
    // t66（A′）：忙时来信在「暂存那一刻」就兑现了名额 ⇒ 断言要容得下 pending 已被消费。
    assert.ok(h.ownerCrossSendV2.pending || h.ownerCrossSendV2.active, '来信必须登记名额，或已因繁忙暂存就地兑现（t66/A′）');
    h.setClockOffset(h.CROSS_SESSION_GRANT_MS + 1000);       // 名额老化到超过墙钟上限
    const seqOld = h.getSocialV2State(OWNER_KEY).lastUnreadSeq;
    await quiesce(h, OWNER_KEY);
    await h.sendWakePromptV2(OWNER_KEY, 'private', { seq: seqOld });   // 承载旧来信的唤醒（真实投递）
    await sleep(200);
    assert.equal(h.ownerCrossSendV2.active, null, '超过上限的旧名额不得被兑现');
    assert.equal(h.ownerCrossSendV2.pending, null, '超上限的名额必须被消费掉（不得留成永久待兑现）');
    assert.equal(count(h.readLog(), /\[cross-session\] 授权窗口开启/g), 0, '不得打授权开启日志');
    const denied = await probeTokenDenied(h, '过期名额（V11）', 'no-grant',
      () => sendMessage(server, { key: OTHER_PRIVATE, messages: ['旧名额越权'], agentToken: token }));
    h.setClockOffset(0);
    console.log(`   [证据] pending 老化到 GRANT+1000ms 后起回合：active=${h.ownerCrossSendV2.active}、授权开启日志=0、发送=${denied.status}`);
  });
});

// ══ T10 静态锚点：豁免只挂 3 个发送端点；8 个其它端点不调用；常量与门控语义 ══
await test('V10 静态锚点：crossSessionSendCheckV2 只被 3 个发送端点调用，8 个其它端点零调用；30 分钟常量在代码里', async () => {
  const source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  assert.match(source, /const CROSS_SESSION_GRANT_MS = 1800000;/, '墙钟上限常量必须是 30 分钟');
  assert.match(source, /const crossSessionSendCheckV2 = \(key, token\) => \{/, '必须有唯一的跨会话判定函数定义');
  assert.equal(count(source, /crossSessionSendCheckV2\(/g), 3, '跨会话判定必须只被 3 个发送端点调用（别的端点一行都不许调）');
  assert.equal(count(source, /armOwnerCrossSendV2\(/g), 2, '名额登记必须只有 1 处定义 + 1 处调用（管理员私聊来信那条路径）');
  // t61：登记点必须**带来信 seq**（授权按 seq 严格绑定）；兑现点必须是「投递时」（唯一调用在 sendWakePromptV2 的投递路径里）
  assert.match(source, /if \(isOwner && kind === 'private'\) armOwnerCrossSendV2\(key, 'owner-message', \{ seq: st\.lastUnreadSeq \}\);/, '登记点必须是「管理员私聊来信」这一条路径，且带来信 seq');
  assert.match(source, /function redeemOwnerCrossSendOnDeliveryV2\(key, wakeSeq(?:, via = 'wake')?\)/, '必须有兑现点（t66/A′ 起带 via 形参，区分「投递时」与「暂存时」）');
  assert.equal(count(source, /redeemOwnerCrossSendOnDeliveryV2\(/g), 3, '兑现点必须只有 1 处定义 + 2 处调用：投递成功分支 + t66/A′ 的繁忙暂存分支，别处一行都不许调');
  assert.match(source, /redeemOwnerCrossSendOnDeliveryV2\(key, wakeSeq\);\s*\n\s*\}\s*\n\s*\} catch \(error\) \{/, '兑现调用必须紧跟在「投递真的成功（else 分支）」里，不允许在 busy/queued/被拒分支兑现');
  // t61 有意移除的判据：`turn-ended` 不得复活（驻留轮可能没有桥接可见的 turn/start/④）
  assert.ok(!source.includes("reason: 'turn-ended'"), "t61 有意移除了 `turn-ended` 时序判据（若它复活，请先复核驻留轮用例 V17 与 V3 ⑤）");
  assert.ok(!/授权窗口开启：管理员 \$\{cfg\.ownerQQ\} 来信触发的那一轮/.test(source), '旧的「来信触发的那一轮」审计文案不得复活');
  const sendEndpoints = [
    ['/api/socialV2/send-burst', "url.pathname === '/api/socialV2/send-burst'"],
    ['/api/socialV2/send-message', "url.pathname === '/api/socialV2/send-message'"],
    ['/api/send/private|group|reply', "url.pathname === '/api/send/group'"],
  ];
  for (const [name, needle] of sendEndpoints) {
    const at = source.indexOf(needle);
    assert.ok(at > 0, `必须能定位发送端点 ${name}`);
    const body = source.slice(at, at + 9000);
    assert.match(body, /crossSessionSendCheckV2\(/, `${name} 必须调用跨会话判定`);
  }
  const otherEndpoints = [
    ['/api/socialV2/unread', "url.pathname === '/api/socialV2/unread'"],
    ['/api/socialV2/recent', "url.pathname === '/api/socialV2/recent'"],
    ['/api/images/message', "url.pathname === '/api/images/message'"],
    ['/api/socialV2/mark-read', "url.pathname === '/api/socialV2/mark-read'"],
    ['/api/socialV2/send-poke', "url.pathname === '/api/socialV2/send-poke'"],
    ['/api/socialV2/collect-sticker', "url.pathname === '/api/socialV2/collect-sticker'"],
    ['/api/socialV2/sticker-note', "url.pathname === '/api/socialV2/sticker-note'"],
    ['/api/socialV2/sticker-list', "url.pathname === '/api/socialV2/sticker-list'"],
  ];
  for (const [name, needle] of otherEndpoints) {
    const at = source.indexOf(needle);
    assert.ok(at > 0, `必须能定位非发送端点 ${name}`);
    const body = source.slice(at, at + 3000);
    assert.ok(!body.includes('crossSessionSendCheckV2('), `${name} 不得调用跨会话判定（豁免只能挂在发送路径）`);
  }
  console.log('   [证据] crossSessionSendCheckV2：1 定义 + 恰好 3 个发送端点调用；8 个其它端点零调用；CROSS_SESSION_GRANT_MS=1800000；'
    + '登记点带来信 seq；兑现点唯一且只在投递成功分支；turn-ended 已确认不存在');
});

// ══ T14 载荷性反证：本脚本的断言真的能被打红（变异体只在 VM 内，绝不写回 src/）══
await test('V14 载荷性反证：中和「投递必须携带同一 seq」/「必须是 owner 令牌」后，V13/V6 的对应断言必然转红', async () => {
  // 反证 A（t61 重定点）：把「投递必须携带**同一 seq**」这处判据中和 → 任何唤醒的投递都会兑现授权。
  // 这正是 V13 ①（无 seq 唤醒不得截胡）与 ②（不同 seq 不得兑现）要抓的行为。
  await withMutant((source) => {
    const out = source.replace(
      'if (pendingSeq === null || deliveredSeq === null || pendingSeq !== deliveredSeq) return false;   // 不截胡',
      '/* mutant A：seq 绑定被中和（任何投递都兑现） */');
    assert.notEqual(out, source, '变异锚点 A（seq 严格绑定）必须存在（否则本反证是空的）');
    return out;
  }, async (h, server) => {
    const { token } = await ownerSession(h);
    await h.ensureSession(OTHER_PRIVATE);
    const feed = startMux(h);
    await h.handleIncoming('private', OWNER_QQ, ownerPrivateMessage('帮我给 999 说一声'), h.cfg);
    assert.ok(h.ownerCrossSendV2.pending, '（前置）管理员来信必须已登记名额');
    const letterSeq = h.getSocialV2State(OWNER_KEY).lastUnreadSeq;
    await quiesce(h, OWNER_KEY);
    await h.sendWakePromptV2(OWNER_KEY, 'private', { seq: letterSeq + 1 });   // 带「别的 seq」的唤醒：正常情况下不得兑现
    assert.ok(await waitUntil(() => h.ownerCrossSendV2.active, 3000),
      '变异体上必须出现「seq 不匹配也兑现」—— 这正是 V13 ② 的 active===null 断言要抓的');
    const send = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['变异体：seq 不匹配也代发'], agentToken: token });
    assertAllowed(send, '变异体上跨会话发送（V13 的 403 断言会因此转红）');
    console.log(`   [反证 A] 中和「seq 严格绑定」→ 带 seq=${letterSeq + 1}（≠来信 seq=${letterSeq}）的投递也授权、发送=200 ⇒ V13 ①② 的断言不是空断言`);
  });
  // 反证 B：把「令牌必须属于 owner 会话」这处判据中和 → 别的会话的令牌也能过
  await withMutant((source) => {
    const out = source.replace("if (!agentTokenOk(own, token)) return { ok: false, reason: 'not-owner-token' };",
      '/* mutant B：owner 令牌校验被中和 */');
    assert.notEqual(out, source, '变异锚点 B 必须存在（否则本反证是空的）');
    return out;
  }, async (h, server) => {
    await ownerSession(h);
    await h.ensureSession(OTHER_PRIVATE);
    await h.ensureSession(OTHER_GROUP);
    const feed = startMux(h);
    const grant = await openOwnerGrant(h, feed, { turn: 1 });
    assert.ok(grant.active, '（前置）owner 授权轮必须生效');
    const groupToken = h.getSocialV2State(OTHER_GROUP).agentToken;
    const send = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['群令牌越权'], agentToken: groupToken });
    assertAllowed(send, '变异体上「别的会话令牌」也能过 owner 令牌关卡（V6 的「群→私聊必须 403」会因此转红）');
    console.log('   [反证 B] 中和「令牌必须属于 owner 会话」→ 群会话令牌也能发到**非主人**目标=200 ⇒ V6 的令牌绑定断言（群→私聊 403）不是空断言');
  });
  // 反证 C（t47·放行侧）：让发送端点在 HTTP 200 的同时回 ok:false ⇒ 放行侧断言（200 + ok:true）必须转红。
  // 变异：把三个发送端点的成功体 `ok: true, key, sent:` 全换成 `ok: false, …`（只改 VM 内副本）。
  await withMutant((source) => {
    const out = source.replaceAll('ok: true, key, sent:', 'ok: false, key, sent: /* mutant C：200 但 ok:false */');
    assert.notEqual(out, source, '变异锚点 C（发送端点成功体）必须命中');
    return out;
  }, async (h, server) => {
    const { token } = await ownerSession(h);
    await h.ensureSession(OTHER_PRIVATE);
    const feed = startMux(h);
    const grant = await openOwnerGrant(h, feed, { turn: 1 });
    assert.ok(grant.active, '（前置）owner 授权轮必须生效');
    const send = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['变异体：HTTP 200 但 ok:false'], agentToken: token });
    assert.equal(send.status, 200, `（前置）变异体仍回 HTTP 200，实测 ${send.status} ${send.raw}`);
    assert.equal(send.data?.ok, false, '（前置）变异体的响应体必须是 ok:false');
    let allowError = null;
    try { assertAllowed(send, '变异体 C（200 但 ok:false）'); } catch (error) { allowError = error; }
    assert.ok(allowError, '放行侧断言必须在「200 但 ok:false」的变异体上抛错（否则 ok:true 检查不是载荷的）');
    console.log(`   [反证 C·放行侧] HTTP 200 但 ok=false ⇒ assertAllowed 抛出：${String(allowError.message).split('\n')[0].slice(0, 140)} ✔`);
  });
});

// ══ T15（t38 修复自证）：/api/send/private 跨会话用例真的打到白名单闸门 + M3 变异证明载荷性 ══
// t30 的这条断言是**空转**的：调用只发了 x-agent-token 头，而 /api/send/* 读的是 body.token
// （src/bridge.js:7605）⇒ src/bridge.js:7632 先以「reserved2 模式发送必须携带 agent token」403，
// 「必须 403」照样通过，但根本没碰到白名单闸门。修复＝带 body.token + 断言白名单文案。
// 这里把「修复后的断言在 M3（跳过白名单）变异体上必然失败」钉成永久自证：变异只写在 %TEMP% 副本上。
await test('V15 修复自证：/api/send/private 用例 → 基准 403「目标不在当前模式允许范围内」；M3 变异（跳过白名单）后该断言必然失败', async () => {
  /** 与 V5 完全同构的一条用例：owner 授权轮内，用 /api/send/private 打白名单外目标。 */
  const sendPrivateToOutsider = async (h, server) => {
    const { token } = await ownerSession(h);
    const feed = startMux(h);
    const grant = await openOwnerGrant(h, feed, { turn: 1 });
    assert.ok(grant.active, '前置：owner 授权轮必须生效');
    return agentRequest(server, {
      pathname: '/api/send/private',
      body: { token, userId: '888', message: '走 /api/send/private 打白名单外目标' },
      agentToken: token,
    });
  };
  // ── ① 基准（未变异 src/bridge.js）：必须 403 且拒因是白名单 ──
  let baseline;
  await withBridge(async (h, server) => { baseline = await sendPrivateToOutsider(h, server); });
  assertWhitelistDenied(baseline, '基准·/api/send/private 打白名单外目标');
  console.log(`   [基准·未变异] status=${baseline.status} error=${JSON.stringify(baseline.data?.error)}`);
  // ── ② M3 变异（%TEMP% 副本：/api/send* 跳过白名单）：同一用例必须失败 ──
  const originalSource = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  const anchor = originalSource.indexOf("url.pathname === '/api/send/group'");
  assert.ok(anchor > 0, '必须能定位 /api/send* 处理器（M3 变异锚点）');
  const mutatedTail = originalSource.slice(anchor)
    .replace('!modeAllowed(key, kind, id, cfg, currentMode)', 'false /* M3：跳过白名单 */');
  assert.notEqual(mutatedTail, originalSource.slice(anchor), 'M3 变异锚点必须命中（否则本自证是空的）');
  const mutantPath = path.join(os.tmpdir(), `qq-m3-skip-whitelist-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(mutantPath, originalSource.slice(0, anchor) + mutatedTail);
  let mutant;
  try {
    await withSource(mutantPath, async (h, server) => { mutant = await sendPrivateToOutsider(h, server); });
  } finally {
    fs.rmSync(mutantPath, { force: true });
  }
  console.log(`   [M3 变异·跳过白名单 %TEMP% 副本] status=${mutant.status} error=${JSON.stringify(mutant.data?.error)}`);
  assert.equal(mutant.status, 500, `M3 变异后该用例必须失败（实测应为 500），实测 ${mutant.status} ${mutant.raw}`);
  assert.notEqual(String(mutant.data?.error ?? ''), WHITELIST_ERR, 'M3 变异后不得再出现白名单拒因（否则变异没生效、自证不成立）');
  let assertionError = null;
  try { assertWhitelistDenied(mutant, 'M3 变异体（跳过白名单）'); } catch (error) { assertionError = error; }
  assert.ok(assertionError, 'M3 变异体上「修复后的断言」必须抛错（否则这条断言不是载荷的）');
  console.log(`   [M3 变异·断言结果] ${String(assertionError.message).split('\n')[0]}`);
  console.log('   [证据] 同一段断言：基准=403+「目标不在当前模式允许范围内」→ 通过；M3（跳过白名单）=500 → 断言必然转红 ⇒ 这条用例真的落在白名单闸门上');
});

// ══ T16 自审（防复发）：本文件里不允许再出现「只看 403 不看拒因」或「/api/send/* 不带 body.token」══
// t38 的根因是断言只钉了状态码：更早的闸门（缺 body.token、空令牌、x-agent-call 校验）会先回 403，
// 「必须 403」照样通过。这个自审把这条纪律变成可执行断言，后续新增用例不会再悄悄退化成空断言。
await test('V16 自审（防复发）：每个 403 断言都紧跟拒因；每个 /api/send/* 调用都带 body.token', async () => {
  const selfSource = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const selfLines = selfSource.split(/\r?\n/);
  const noReason = [];
  for (let i = 0; i < selfLines.length; i += 1) {
    const line = selfLines[i];
    // 只看「裸的 .status, 403」；统一断言（assertTokenDenied/assertWhitelistDenied）内部自己会看文案
    if (!/assert\.(equal|strictEqual)\([A-Za-z0-9_$.]+\.status, 403/.test(line)) continue;
    if (/res\.status, 403/.test(line)) continue;                 // 统一断言自身
    const around = selfLines.slice(i, i + 3).join('\n');
    // 拒因可以是 response.error，也可以是同一步的 [cross-session] 审计行（源码里写成 \[cross-session\]）
    if (/data\?\.error/.test(around) || /cross-session/.test(around) || /拒绝代发/.test(around)) continue;
    noReason.push(`:${i + 1} ${line.trim()}`);
  }
  assert.deepEqual(noReason, [], `存在「只看 403 不看拒因」的断言（会再被更早的闸门挡成空断言）：\n${noReason.join('\n')}`);
  // t47：自审扩展到**放行侧** —— 所有 `.status, 200` 断言必须同时校验成功字段（`ok:true` 或等价），
  // 否则「HTTP 200」可能只是响应壳（t39 提醒：套件里曾有 10 处只钉状态码的放行断言）。
  const allowGaps = [];
  let allowChecked = 0;
  for (let i = 0; i < selfLines.length; i += 1) {
    const line = selfLines[i];
    if (!/assert\.(equal|strictEqual)\([A-Za-z0-9_$.]+\.status, 200/.test(line)) continue;
    allowChecked += 1;
    if (/res\.status, 200/.test(line)) continue;                  // assertAllowed 自身（下一行就是 ok:true 校验）
    const around = selfLines.slice(i, i + 3).join('\n');
    if (/data\?\.ok/.test(around) || /assertAllowed/.test(around)) continue;
    allowGaps.push(`:${i + 1} ${line.trim()}`);
  }
  assert.deepEqual(allowGaps, [], `存在「只看 200 不校验 ok:true」的放行断言：\n${allowGaps.join('\n')}`);
  // /api/send/* 读 body.token（src/bridge.js:7605）：这些调用必须显式带上，否则先撞「必须携带 agent token」
  const sendCalls = [...selfSource.matchAll(/pathname: '\/api\/send\/[^']*',[\s\S]{0,240}?\}/g)].map((m) => m[0]);
  assert.ok(sendCalls.length >= 1, `必须能定位到 /api/send/* 调用（实测 ${sendCalls.length} 处）`);
  for (const call of sendCalls) {
    assert.match(call, /body: \{[^}]*token/, `/api/send/* 调用必须带 body.token（否则会被更早的闸门挡成空断言）：${call.slice(0, 200)}`);
  }
  // t47：能区分闸门的拒绝断言必须显式传 gate（否则断言失败时分不清是隔离拒绝还是豁免路径的哪个理由）
  // t67（F2 盲区纪律，防复发）：必须保留**真实定时器路径**的正例，且它们的用例体不得手动调
  // `sendWakePromptV2(...)` 注入 seq —— 手动注入会绕开 `scheduleWakeV2` 的合并窗定时器，
  // 正好掩盖 t63-F1（来信排程漏带 seq ⇒ 空闲路径永远兑不了现）这类回归。
  const ownCaseBodies = selfSource.split(/^await test\(/m).slice(1);
  const timerCases = ownCaseBodies.filter((body) => /^'V(19|20)/.test(body.trim()));
  assert.equal(timerCases.length, 2, `必须保留两条真实定时器正例（V19 空闲 / V20 忙时暂存），实测 ${timerCases.length}`);
  for (const body of timerCases) {
    const name = (/^(?:'|")(.*?)(?:'|"),/s.exec(body) ?? [])[1] ?? '?';
    assert.ok(/scheduleWakeV2\(|定时器/.test(body), `${name} 必须走真实定时器路径（来信自排 / scheduleWakeV2 重排）`);
    assert.ok(!/sendWakePromptV2\(/.test(body), `${name} 不得手动调 sendWakePromptV2 注入 seq（那会掩盖 F1 这类回归）`);
  }
  const gatedCalls = count(selfSource, /probeTokenDenied\(/g);
  assert.ok(gatedCalls >= 8, `至少 8 处拒绝断言必须用 probeTokenDenied 指名闸门（实测 ${gatedCalls} 处）`);
  console.log(`   [证据] 自审：裸 403 断言 ${count(selfSource, /\.status, 403/g)} 处全部带拒因（覆盖断言内 2 处也已收紧）；`
    + `放行侧 200 断言 ${allowChecked} 处全部校验 ok:true（覆盖断言内 1 处）；`
    + `/api/send/* 调用 ${sendCalls.length} 处全部带 body.token；指名闸门的拒绝断言 ${gatedCalls} 处`);
});

// ══ T17 驻留回合面（t61 生产复现，独立夹具）：先开一轮、此后**不再喂任何 turn/start** ══
// 生产复现路径：reserved2 的 owner 私聊会长期驻留在同一轮里 ⇒ 管理员来信时会话忙 ⇒ 那次唤醒只能被暂存
// ⇒ 「承载来信的那次唤醒」后来被真正投递时，必须就地把名额兑现给**当前这一轮**（旧口径等新 turn/start ⇒ 永远等不到）。
await test('V17 驻留回合（t61 生产复现）：先开一轮且此后不再喂 turn/start ⇒ 来信忙时暂存 ⇒ 投递即成 ⇒ 同轮代发 200 + 审计齐全；turn/end 关窗、30 分钟超限', async () => {
  await withBridge(async (h, server) => {
    const { sid, token } = await ownerSession(h);
    await h.ensureSession(OTHER_PRIVATE);
    const feed = startMux(h);
    let turnStartsAfterLetter = 0;                      // 来信之后**喂过的 turn/start 计数**（必须保持 0）
    // ① 先开一轮；此后不再喂任何 turn/start（模拟 reserved2 长期驻留的那一轮）
    feed.push([turnStart(sid, 7)]);
    assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sid), 3000), '（夹具）驻留轮必须起来');
    // ② 管理员来信：此刻会话忙 ⇒ 承载它的唤醒只能被暂存（生产形态）
    await h.handleIncoming('private', OWNER_QQ, ownerPrivateMessage('帮我给 999 说一声（驻留轮）'), h.cfg);
    // t66（A′）：忙时来信在「暂存那一刻」就兑现了名额 ⇒ 断言要容得下 pending 已被消费。
    assert.ok(h.ownerCrossSendV2.pending || h.ownerCrossSendV2.active, '来信必须登记名额，或已因繁忙暂存就地兑现（t66/A′）');
    const letterSeq = h.getSocialV2State(OWNER_KEY).lastUnreadSeq;
    await h.sendWakePromptV2(OWNER_KEY, 'private', { seq: letterSeq });
    await sleep(150);
    // t66（A′）：来信自己的唤醒被暂存的那一刻就兑现 —— 生产里用户正是在这个空窗期发起代发而吃 no-grant。
    assert.ok(h.ownerCrossSendV2.active, 't66（A′）：来信自己的唤醒被暂存时必须就地兑现');
    assert.match(h.readLog(), /\[cross-session\] 授权窗口开启：管理员 123 来信的唤醒已交给当前回合的待办队列/, '暂存即兑现必须留痕（且与「投递时兑现」的文案区分）');
    assert.match(h.readLog(), /会话繁忙，暂存唤醒原因 private:123（private@seq\d+）/, '必须留下「忙 ⇒ 暂存」的原始日志');
    assert.ok((h.getSocialV2State(OWNER_KEY).pendingWakeReasons ?? []).some((r) => Number(r.seq) === Number(letterSeq)),
      '承载来信的那条唤醒必须留在 backlog（等真正投递）');
    // ③ 忙标记被释放（= 看门狗/C-stall 自愈释放 ④，或租约到点；**不经任何新 turn/start**）⇒ 那条唤醒被真正投递
    h.v2TurnStartAt.delete(sid);
    h.collectors.delete(sid);
    await sleep(30);
    await h.sendWakePromptV2(OWNER_KEY, 'private', { seq: letterSeq });
    assert.ok(await waitUntil(() => h.ownerCrossSendV2.active, 3000), '承载来信的唤醒被真正投递时必须就地兑现（驻留轮没有新 turn/start 也要兑现）');
    assert.equal(turnStartsAfterLetter, 0, '本次兑现必须发生在「来信之后零个 turn/start」的前提下（t61 新不变量①）');
    assert.equal(h.ownerCrossSendV2.pending, null, '兑现后名额必须清空（一次性）');
    // ④ 同一轮内代发 200 + 审计四字段齐全
    const allowed = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['驻留轮里替管理员传话'], agentToken: token });
    assertAllowed(allowed, '驻留轮内跨会话代发');
    const sendOk = onebot(h, 'send_private_msg');
    assert.equal(sendOk.length, 1, `必须真的发出 1 条 OneBot 私聊，实测 ${sendOk.length}`);
    assert.equal(String(sendOk[0].body?.user_id), '999');
    const log = h.readLog();
    assert.match(log, /\[cross-session\] 授权窗口开启：管理员 123 来信的唤醒(已交给当前回合的待办队列|已投递)（来源=owner-message@seq\d+/, '必须有开窗审计行（t66/A′ 暂存即兑现 或 t61 投递时兑现）');
    const successLine = linesOf(log, /\[cross-session\] 代发成功[^\n]*/).pop() ?? '';
    assert.ok(successLine, '必须有代发成功留痕');
    for (const [field, re] of [['授权人', /授权人=123/], ['来源', /来源=owner-message/], ['目标', /目标=private:999/], ['条数', /条数=1\/1/], ['端点', /端点=\/api\/socialV2\/send-message/]]) {
      assert.match(successLine, re, `代发成功留痕必须带${field}：${successLine}`);
    }
    dump('驻留轮代发（原始日志）', log, /[^\n]*(\[cross-session\]|暂存唤醒原因)[^\n]*/);
    // ⑤ 该轮 turn/end ⇒ 关窗 ⇒ 回到 no-grant
    feed.push([turnEnd(sid, 7)]);
    assert.ok(await waitUntil(() => h.ownerCrossSendV2.active === null, 3000), '驻留轮 turn/end 必须关窗');
    await probeTokenDenied(h, '驻留轮 turn/end 之后（V17 ⑤）', 'no-grant',
      () => sendMessage(server, { key: OTHER_PRIVATE, messages: ['关窗后再发'], agentToken: token }));
    // ⑥ 30 分钟墙钟上限（注入时钟：Date.now 整体前移，手法同 V3）：重新兑现一次后超限 ⇒ grant-expired
    await h.handleIncoming('private', OWNER_QQ, ownerPrivateMessage('再给 999 说一声'), h.cfg);
    const seq2 = h.getSocialV2State(OWNER_KEY).lastUnreadSeq;
    await quiesce(h, OWNER_KEY);
    await h.sendWakePromptV2(OWNER_KEY, 'private', { seq: seq2 });
    assert.ok(await waitUntil(() => h.ownerCrossSendV2.active, 3000), '第二次兑现必须成功（用于测上限）');
    h.setClockOffset(h.CROSS_SESSION_GRANT_MS + 1000);        // 让「已授权时长」超过 30 分钟
    await probeTokenDenied(h, '超过 30 分钟墙钟（V17 ⑥）', 'grant-expired',
      () => sendMessage(server, { key: OTHER_PRIVATE, messages: ['超限后越权'], agentToken: token }));
    h.setClockOffset(0);
    console.log(`   [证据] 驻留轮 sid=${sid}：来信 seq=${letterSeq} 时忙 ⇒ 暂存；释放忙标记后**零个新 turn/start**下投递即成 ⇒ 同轮 200 + 审计四字段；`
      + `turn/end 关窗 ⇒ no-grant；>30 分钟 ⇒ grant-expired（注入时钟 +${h.CROSS_SESSION_GRANT_MS + 1000}ms）`);
  });
  // ⑦ 保真补充：投递**期间**回合已经在轮内（真实生产形态：DSH 接单后立刻起回合）⇒ 兑现给当前这一轮（adopt=false）
  await withBridge(async (h, server) => {
    const { sid, token } = await ownerSession(h);
    await h.ensureSession(OTHER_PRIVATE);
    startMux(h);
    await h.handleIncoming('private', OWNER_QQ, ownerPrivateMessage('帮我给 999 传个话（投递瞬间已在轮内）'), h.cfg);
    const seq = h.getSocialV2State(OWNER_KEY).lastUnreadSeq;
    await quiesce(h, OWNER_KEY);
    const originalPrompt = h.api.sessions.prompt;
    h.api.sessions.prompt = async (params) => {          // 投递 await 期间：DSH 起了回合（④ 置位）
      const result = await originalPrompt(params);
      h.v2TurnStartAt.set(sid, Date.now());
      return result;
    };
    await h.sendWakePromptV2(OWNER_KEY, 'private', { seq });
    assert.ok(await waitUntil(() => h.ownerCrossSendV2.active, 3000), '投递瞬间已在轮内时同样必须兑现');
    assert.equal(h.ownerCrossSendV2.active.adoptNextTurnStart, false, '投递时已在轮内 ⇒ adoptNextTurnStart=false（绑定当前轮）');
    assert.match(h.readLog(), /\[cross-session\] 授权窗口开启：管理员 123 来信的唤醒(已交给当前回合的待办队列|已投递)（来源=owner-message@seq\d+，会话当时已在轮内）/, '审计行必须标明「投递时已在轮内」');
    assertAllowed(await sendMessage(server, { key: OTHER_PRIVATE, messages: ['已在轮内这一轮里代发'], agentToken: token }), '已在轮内时兑现的同一轮内代发');
    console.log('   [证据·保真补充] 投递 await 期间 ④ 置位 ⇒ 兑现给当前这一轮（adopt=false），审计行含「会话当时已在轮内」，同轮代发 200');
  });
});

// ══ T18 我自己的变异体（必须落在本 verify 文件里）：中和「投递时兑现」⇒ V17 的驻留轮用例必红 ══
await test('V18 载荷性反证（本文件自己的变异体）：中和「投递时兑现」⇒ 驻留轮永远等不到授权、代发 403（V17 的 200 断言必红）', async () => {
  await withMutant((source) => {
    const out = source.replace('function redeemOwnerCrossSendOnDeliveryV2(key, wakeSeq, via = \'wake\') {',
      'function redeemOwnerCrossSendOnDeliveryV2(key, wakeSeq) { return false; /* mutant：中和「投递时兑现」 */');
    assert.notEqual(out, source, '变异锚点（投递时兑现函数）必须存在，否则本反证是空的');
    return out;
  }, async (h, server) => {
    const { sid, token } = await ownerSession(h);
    await h.ensureSession(OTHER_PRIVATE);
    const feed = startMux(h);
    feed.push([turnStart(sid, 7)]);                     // 驻留轮：此后不再喂 turn/start
    assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sid), 3000), '（夹具）驻留轮必须起来');
    await h.handleIncoming('private', OWNER_QQ, ownerPrivateMessage('驻留轮里的来信'), h.cfg);
    assert.ok(h.ownerCrossSendV2.pending, '（前置）来信必须登记名额');
    const seq = h.getSocialV2State(OWNER_KEY).lastUnreadSeq;
    await quiesce(h, OWNER_KEY);
    h.v2TurnStartAt.set(sid, Date.now());
    await h.sendWakePromptV2(OWNER_KEY, 'private', { seq });   // 真投递，但变异体不兑现
    await sleep(300);
    assert.equal(h.ownerCrossSendV2.active, null, '变异体上：投递不再兑现 ⇒ 驻留轮永远拿不到授权（这正是 V17 会转红的机制）');
    const denied = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['变异体：驻留轮代发'], agentToken: token });
    assert.equal(denied.status, 403, `变异体上代发必须 403，实测 ${denied.status} ${denied.raw}`);
    assert.equal(String(denied.data?.error ?? ''), TOKEN_ERR, '拒绝文案必须原样');
    console.log('   [反证·我自己的变异体] 中和「投递时兑现」⇒ 驻留轮 active=null、代发 403(no-grant) ⇒ V17 的「投递即成 ⇒ 同轮 200」断言是载荷的');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// T19–T21（t67）· 真实定时器路径正例（F1 盲区）
//
// 【盲区本身（t63-F1 / t65 修复）】"投递时兑现"要求那次投递**携带来信的 seq**；而生产里那次投递是
// `scheduleWakeV2` 的**合并窗定时器**发起的 —— 定时器回调只认 `st.pendingWakeSeq`（src/bridge.js:12320
// →:12325→:12328）。t65 之前，来信分支排程时没带 `opts.seq` ⇒ `pendingWakeSeq=null` ⇒ 定时器把
// `{seq:null}` 交给 `sendWakePromptV2` ⇒ 严格 seq 匹配失败 ⇒ **会话空闲时那条最普通的路径永远兑不了现**。
//
// 【本组用例的纪律】V19/V20 **绝不调用 `sendWakePromptV2`**（那会把 seq 手动注入、绕开定时器，正好掩盖 F1）；
// 它们只让桥接自己排的合并窗定时器自然到点投递（用 `calls.prompts` 增量 + 投递日志证明"真的经由定时器"）。
// ⇒ **正例必须至少一条走真实定时器投递；手动注入 seq 的写法会掩盖 F1 这类回归。**
//    （V16 的自审里有一条静态检查把这条纪律钉住：V19/V20 的用例体不得出现 `sendWakePromptV2(`。）
// ══════════════════════════════════════════════════════════════════════════════════

/** 空闲路径的公共流程：来信 → 等桥接自己的合并窗定时器投递（不手动注入 seq）→ 返回实测值。 */
async function idleTimerDelivery(h, { text = '帮我给 999 传个话（空闲路径）', timeoutMs = 12000 } = {}) {
  await quiesce(h, OWNER_KEY);                    // 清残留（含 ensureSession 自动排的 bootstrap 定时器）
  const promptsBefore = h.calls.prompts.length;
  const wakesBefore = count(h.readLog(), /\[reserved2\] 唤醒 private:123（/g);
  await h.handleIncoming('private', OWNER_QQ, ownerPrivateMessage(text), h.cfg);
  const st = h.getSocialV2State(OWNER_KEY);
  const letterSeq = st.lastUnreadSeq;
  const pendingSeqAtSchedule = st.pendingWakeSeq === null || st.pendingWakeSeq === undefined ? null : Number(st.pendingWakeSeq);
  const armed = !!st.pendingWakeTimer;
  const delivered = await waitUntil(() => h.calls.prompts.length > promptsBefore, timeoutMs);
  const log = h.readLog();
  const active = await waitUntil(() => h.ownerCrossSendV2.active, 3000);
  const wakeLine = linesOf(log, /\[reserved2\] 唤醒 private:123（[^\n]*/).pop() ?? '';
  return {
    letterSeq, pendingSeqAtSchedule, armed, delivered: !!delivered,
    wakeLogs: count(log, /\[reserved2\] 唤醒 private:123（/g) - wakesBefore,
    wakeLine,
    deliveredLog: /\[reserved2\] 唤醒 private:123（private）/.test(log),
    active,
  };
}

await test('V19 真实定时器正例（空闲路径，F1 盲区）：来信后只等合并窗定时器自然投递（零手动注入）⇒ 严格 seq 兑现 ⇒ 同轮代发 200 + 审计四字段', async () => {
  await withBridge(async (h, server) => {
    const { sid, token } = await ownerSession(h);
    await h.ensureSession(OTHER_PRIVATE);
    const feed = startMux(h);
    const r = await idleTimerDelivery(h);
    // ① 来信路径必须把来信 seq 交给排程（t65-F1 的不变量）——这是 F1 的靶心
    assert.ok(r.armed, '来信必须真的排上合并窗定时器（而不是被暂存/被别的分支吃掉）');
    assert.equal(r.pendingSeqAtSchedule, Number(r.letterSeq),
      `来信路径排的唤醒必须把 pendingWakeSeq 设成来信 seq（t65-F1）：实测 ${r.pendingSeqAtSchedule} vs 来信 ${r.letterSeq}`);
    // ② 定时器自然到点并真的投递（用调用计数 + 投递日志证明，而非手动注入）
    assert.ok(r.delivered, '合并窗定时器必须自然到期并真正投递（calls.prompts 必须增长）');
    assert.ok(r.wakeLogs >= 1 && /\[reserved2\] 唤醒 private:123（/.test(r.wakeLine), `必须有真实投递日志（实测 wakeLine=${JSON.stringify(r.wakeLine)}）`);
    // ③ 严格 seq 兑现
    assert.ok(r.active, '定时器投递必须立即兑现（空闲路径 —— F1 之前这里必然 active=null）');
    assert.equal(Number(r.active.seq), Number(r.letterSeq), 'active.seq 必须等于来信 seq（严格绑定）');
    assert.equal(h.ownerCrossSendV2.pending, null, '兑现后名额必须清空（一次性）');
    // ④ 同轮代发 200 + 审计四字段
    feed.push([turnStart(sid, 7)]);
    assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sid), 3000), '（夹具）授权轮必须起来');
    assertAllowed(await sendMessage(server, { key: OTHER_PRIVATE, messages: ['空闲路径里替管理员传话'], agentToken: token }), '空闲路径兑现后的同轮代发');
    const sends = onebot(h, 'send_private_msg');
    assert.equal(sends.length, 1, `必须真的发出 1 条 OneBot 私聊，实测 ${sends.length}`);
    const successLine = linesOf(h.readLog(), /\[cross-session\] 代发成功[^\n]*/).pop() ?? '';
    for (const [field, re] of [['授权人', /授权人=123/], ['来源', /来源=owner-message/], ['目标', /目标=private:999/], ['条数', /条数=1\/1/], ['端点', /端点=\/api\/socialV2\/send-message/]]) {
      assert.match(successLine, re, `代发成功留痕必须带${field}：${successLine}`);
    }
    dump('空闲路径·真实定时器（原始日志）', h.readLog(), /[^\n]*(\[cross-session\]|\[reserved2\] 唤醒 private:123)[^\n]*/);
    console.log(`   [证据] 空闲来信 seq=${r.letterSeq} → 排程时 pendingWakeSeq=${r.pendingSeqAtSchedule}（必须等于来信 seq）→ `
      + `合并窗定时器自然投递（calls.prompts +1、投递日志 ${r.wakeLogs} 条）→ active.seq=${r.active.seq} 兑现 → 同轮代发 200 sent=${sends.length}；零手动 sendWakePromptV2`);
  });
});

await test('V20 真实定时器正例（忙时暂存 → 自愈重排，F1 盲区）：来信忙时暂存（backlog 带 seq）⇒ 释放忙标记后真实重排 ⇒ 定时器投递 ⇒ 兑现 ⇒ 同轮代发 200', async () => {
  await withBridge(async (h, server) => {
    const { sid, token } = await ownerSession(h);
    await h.ensureSession(OTHER_PRIVATE);
    const feed = startMux(h);
    // ① 先开一轮使会话忙
    feed.push([turnStart(sid, 7)]);
    assert.ok(await waitUntil(() => h.v2TurnStartAt.has(sid), 3000), '（夹具）驻留轮必须起来');
    const promptsBefore = h.calls.prompts.length;
    // ② 来信：忙 ⇒ 暂存进 backlog（带着这封来信的 seq）
    await h.handleIncoming('private', OWNER_QQ, ownerPrivateMessage('帮我给 999 说一声（忙时）'), h.cfg);
    const st = h.getSocialV2State(OWNER_KEY);
    const letterSeq = st.lastUnreadSeq;
    assert.match(h.readLog(), /会话繁忙，暂存唤醒原因 private:123（[^）]*）/, '忙时必须留下「暂存」原始日志');
    const backlog = (st.pendingWakeReasons ?? []).find((item) => Number(item.seq) === Number(letterSeq));
    assert.ok(backlog, `backlog 里必须有带来信 seq=${letterSeq} 的那条，实测 ${JSON.stringify(st.pendingWakeReasons)}`);
    assert.equal(h.calls.prompts.length, promptsBefore, '暂存阶段绝不允许发生投递');
  assert.ok(h.ownerCrossSendV2.active, 't66（A′）：来信自己的唤醒被暂存的那一刻就必须已兑现（生产里这个空窗期代发不再吃 no-grant）');
    // ③ 自愈释放忙标记（= 看门狗/C-stall 释放 ④），然后**真实重排**（桥接 flush 用的同一次调用形态）
    h.v2TurnStartAt.delete(sid);
    h.collectors.delete(sid);
    await sleep(30);
    h.scheduleWakeV2(OWNER_KEY, backlog.reason, { seq: backlog.seq });
    assert.equal(Number(h.getSocialV2State(OWNER_KEY).pendingWakeSeq), Number(letterSeq), '重排必须把来信 seq 带进 pendingWakeSeq');
    const delivered = await waitUntil(() => h.calls.prompts.length > promptsBefore, 12000);
    assert.ok(delivered, '重排后的合并窗定时器必须自然到期并真正投递');
    assert.match(h.readLog(), /\[reserved2\] 唤醒 private:123（/, '必须有真实投递日志');
    const active = await waitUntil(() => h.ownerCrossSendV2.active, 3000);
    assert.ok(active, '忙时暂存 → 重排投递 必须兑现（这一条 t61 已覆盖，本用例把「真实定时器」这一半补齐）');
    assert.equal(Number(active.seq), Number(letterSeq), 'active.seq 必须等于来信 seq');
    // ④ 同轮代发 200
    assertAllowed(await sendMessage(server, { key: OTHER_PRIVATE, messages: ['忙时路径里替管理员传话'], agentToken: token }), '忙时路径兑现后的同轮代发');
    assert.equal(onebot(h, 'send_private_msg').length, 1, '必须真的发出 1 条 OneBot 私聊');
    dump('忙时暂存·真实重排（原始日志）', h.readLog(), /[^\n]*(\[cross-session\]|暂存唤醒原因|\[reserved2\] 唤醒 private:123)[^\n]*/);
    console.log(`   [证据] 忙时来信 seq=${letterSeq} → 暂存 backlog（含该 seq，暂存期零投递/零兑现）→ 释放 ④ → 真实重排 `
      + `(reason=${backlog.reason},seq=${backlog.seq}) → 定时器投递（calls.prompts +1）→ active.seq=${active.seq} → 同轮代发 200 sent=1`);
  });
});

// ══ T21 独立确认 t65 的修复：在「等价于 t65 之前」的 VM 副本上复现 F1（同样的空闲用例必须红）══
await test('V21 独立确认 F1 已被 t65 修好：VM 回退「来信排程带 seq」⇒ 空闲路径 pendingWakeSeq=null、投递后不兑现、代发 403（同一用例两次输出对比）', async () => {
  // ── 基准（当前树）：同一段流程必须 200 ──
  let baseline = null;
  await withBridge(async (h, server) => {
    const { sid, token } = await ownerSession(h);
    await h.ensureSession(OTHER_PRIVATE);
    const feed = startMux(h);
    const r = await idleTimerDelivery(h);
    feed.push([turnStart(sid, 7)]);
    await waitUntil(() => h.v2TurnStartAt.has(sid), 3000);
    const send = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['基准：空闲路径代发'], agentToken: token });
    assertAllowed(send, '基准（当前树）：空闲路径兑现后的同轮代发');   // 200 + ok:true（V16 自审要求）
    baseline = { pendingSeq: r.pendingSeqAtSchedule, active: !!r.active, status: send.status, ok: send.data?.ok === true };
  });
  assert.equal(baseline.pendingSeq, 1, `基准：排程时 pendingWakeSeq 必须等于来信 seq（实测 ${baseline.pendingSeq}）`);
  assert.ok(baseline.active, '基准：定时器投递必须兑现');
  assert.equal(baseline.ok, true, `基准：代发必须 200 且 ok:true（实测 status=${baseline.status}）`);
  // ── VM 回退副本（等价于 t65 之前的树）：来信分支的两处排程不带 seq ──
  let mutant = null;
  await withMutant((source) => {
    let out = source.replace(
      "scheduleWakeV2(key, 'bootstrap', ownerMsgSeq === undefined ? {} : { seq: ownerMsgSeq, ownerLetter: true });",
      "scheduleWakeV2(key, 'bootstrap');   /* mutant（t65 回退）：不带 seq */");
    assert.notEqual(out, source, '回退锚点 ①（bootstrap 排程带 seq）必须命中，否则本反证是空的');
    const before = out;
    out = out.replace(
      'scheduleWakeV2(key, reason, ownerMsgSeq === undefined ? {} : { seq: ownerMsgSeq, ownerLetter: true });',
      'scheduleWakeV2(key, reason);   /* mutant（t65 回退）：不带 seq */');
    assert.notEqual(out, before, '回退锚点 ②（来信排程带 seq）必须命中，否则本反证是空的');
    return out;
  }, async (h, server) => {
    const { sid, token } = await ownerSession(h);
    await h.ensureSession(OTHER_PRIVATE);
    const feed = startMux(h);
    const r = await idleTimerDelivery(h);
    feed.push([turnStart(sid, 7)]);
    await waitUntil(() => h.v2TurnStartAt.has(sid), 3000);
    const send = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['回退副本：空闲路径代发'], agentToken: token });
    mutant = { pendingSeq: r.pendingSeqAtSchedule, delivered: r.delivered, active: !!r.active, status: send.status, error: send.data?.error,
      wakeLogs: r.wakeLogs, noGrant: /拒绝代发（no-grant）/.test(h.readLog()) };
  });
  // ── 两次输出对比：回退副本上必须复现 F1 的每一个特征 ──
  assert.equal(mutant.pendingSeq, null, `回退副本：排程时 pendingWakeSeq 必须为 null（这正是 F1 的根因），实测 ${mutant.pendingSeq}`);
  assert.ok(mutant.delivered && mutant.wakeLogs >= 1, '回退副本：定时器**照样投递**（所以问题不在「没投递」，而在投递时不带 seq）');
  assert.equal(mutant.active, false, '回退副本：投递后**不得**兑现（F1 症状）');
  assert.equal(mutant.status, 403, `回退副本：代发必须 403（实测 ${mutant.status}）`);
  assert.equal(String(mutant.error ?? ''), TOKEN_ERR, '回退副本：拒绝文案必须原样');
  assert.ok(mutant.noGrant, '回退副本：必须有 `拒绝代发（no-grant）` 留痕');
  console.log('   [对比·基准（当前树）] pendingWakeSeq=' + baseline.pendingSeq + ' → 定时器投递 → active=true → 代发 ' + baseline.status);
  console.log('   [对比·回退副本（等价 t65 之前）] pendingWakeSeq=' + mutant.pendingSeq + ' → 定时器**照样**投递（日志 ' + mutant.wakeLogs
    + ' 条）→ active=false → 代发 ' + mutant.status + '（' + mutant.error + '，no-grant 留痕=' + mutant.noGrant + '）');
});

console.log(`\n══════════════════════════════════════════════════════════════════`);
console.log(`通过 ${passes} 项，失败 ${failures} 项`);
if (failures) process.exitCode = 1;
