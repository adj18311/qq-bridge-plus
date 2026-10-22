// 跨会话发送（t29）聚焦测试 —— owner 会话在「管理员来信触发的那一轮」里可代发到白名单目标。
//
// 用户诉求（2026-10-06）：管理员在私聊里让机器人「主动去给别人发消息」，机器人回
// 「我手上只有你这一个窗口的钥匙 / 别人的会话我照样发不出去」。取证发现那 3 次失败是**桥接自己拒的**
// （发送端点用 `agentTokenOk(目标key, token)` 把每个会话的令牌钉死在自己的会话上 → 403「agent token 无效」），
// 不是 QQ 挡住（args.key=private:1000000021，调用方会话是 owner 的 private:1000000001）。
//
// 本测试跑**真实的 src/bridge.js**（VM + 假 DSH/假 QQ + 真 HTTP 路由），用与 MCP 工具一致的
// 请求头（x-console-token + x-agent-token + x-agent-call）逐条钉住放行与拒绝两侧：
//   · 放行：只有 owner 会话 + 只有「管理员来信触发的那一轮」+ 只有白名单目标 + 只有发送路径；
//   · 拒绝：非 owner 会话 / 非管理员触发的回合 / 回合结束后 / 超 30 分钟墙钟上限 / 白名单外 /
//     其它会话级工具 / 群会话冒用 owner 令牌；
//   · 每笔跨会话代发都留 `[cross-session]` 审计行（授权人 ownerQQ、来源、目标、条数、结果）；
//   · 第三方（别的群/私聊）的消息与回合不影响 owner 的授权，也不会获得任何跨会话能力。
// 不读线上 config.json、不写真实 state/、不连 QQ/DSH、不启动第二个守护进程。
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
const CONSOLE_TOKEN = 'fixture-console-token';
const OWNER_QQ = 123;                       // 只来自 config.ownerQQ；测试里也换一个值验证不写死
const OWNER_KEY = `private:${OWNER_QQ}`;
const OTHER_PRIVATE = 'private:999';        // 白名单内（allow.private）
const OTHER_GROUP = 'group:456';            // 白名单内（allow.groups）
const OUT_PRIVATE = 'private:888';          // 白名单外
const OUT_GROUP = 'group:777';              // 白名单外

/** 在临时目录里跑真实桥接（假 api / 假 bot），并暴露本任务需要断言的内部结构。
 *  `transformSource`：载荷性反证（t61 变异体）用 —— 只改**内存副本**，仓库文件一个字节都不动。 */
async function crossHarness({ config = {}, transformSource = null } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-cross-send-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  const socialV2 = {
    enabled: true,
    proactive: { enabled: false },          // 主动机会定时器：本测试自己驱动回合，不要它插话
    sticker: { enabled: true },             // 收藏表情用例要走到 token 关卡（关掉会在更早的闸门被拒）
    ...(config.socialV2 ?? {}),
  };
  const cfgFile = {
    dsh: { authToken: 'fixture-only' }, ownerQQ: OWNER_QQ,
    allow: { private: ['123', '999'], groups: ['456', '987'] },
    consolePort: 0, consoleToken: CONSOLE_TOKEN, slang: { enabled: false },
    ...config, socialV2,
  };
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify(cfgFile));
  const calls = { created: [], prompts: [], sent: [], follows: [], http: [] };
  // 发送最终走 OneBot HTTP（`onebotSend` → POST {httpUrl}/send_private_msg|send_group_msg），
  // 所以这里既拦下真网络，又把「到底发给了谁、发了什么」原样记下来作为最强证据。
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
  const timeouts = new Set();
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  // 变异体入口（只作用于 VM 内的源码副本；绝不写回 src/bridge.js）
  if (typeof transformSource === 'function') source = transformSource(source);
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
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    cfg, state, api, socialV2, getSocialV2State, ensureSession, sendToQQ, deliverPrompt,
    startConsoleServer, handleIncoming, pumpMux, scheduleWakeV2, sendWakePromptV2,
    v2TurnStartAt, v2TurnNoV2, ownerCrossSendV2, CROSS_SESSION_GRANT_MS,
    armOwnerCrossSendV2, clearOwnerCrossSendV2, ownerSessionKeyV2,
    buildWakePromptV2,
    collectors, promptQueues, pendingWakeKeys,
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
    setInterval: () => ({ unref() {} }),
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
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData }; })());`, context);
  vm.runInContext(source + '\nglobalThis.crossHarnessReady = main();', context);
  const bridge = await context.crossHarnessReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  const logFile = path.join(temp, 'state', 'bridge.log');
  return {
    ...bridge,
    calls,
    temp,
    readLog: () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } },
    async close() {
      for (const t of timeouts) clearTimeout(t);
      fs.rmSync(temp, { recursive: true, force: true });
    },
  };
}

/** 真事件流喂帧器：帧经真实 pumpMux → turn/start / turn/end 链路生效。 */
function startMux(h) {
  const queue = [];
  let wake = null;
  h.api.events.mux = async function* () {
    for (;;) {
      if (queue.length === 0) { await new Promise((resolve) => { wake = resolve; }); continue; }
      yield { payload: queue.shift() };
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  void h.pumpMux();
  return {
    push(frames) {
      for (const frame of frames) queue.push(frame);
      if (wake) { const resolve = wake; wake = null; resolve(); }
    },
  };
}

const frameOf = (sid, event) => ({ type: 'session/event', sessionId: sid, event });
const turnStart = (sid, turn) => frameOf(sid, { type: 'turn/start', data: { turn } });
const turnEnd = (sid, turn) => frameOf(sid, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let msgSeq = 1000;
/** 管理员在 owner 私聊里发来的消息（真实 handleIncoming 入参形状）。 */
const ownerMessage = (text) => ({
  user_id: OWNER_QQ, self_id: 999, message_id: (msgSeq += 1), message_seq: msgSeq,
  sender: { user_id: OWNER_QQ, nickname: '管理员' }, time: Math.floor(Date.now() / 1000),
  message: [{ type: 'text', data: { text } }],
});
/** 群里的消息（第三方）。 */
const groupMessage = (text) => ({
  user_id: 555, self_id: 999, message_id: (msgSeq += 1), message_seq: msgSeq,
  sender: { user_id: 555, nickname: '路人' }, time: Math.floor(Date.now() / 1000),
  message: [{ type: 'text', data: { text } }],
});

/**
 * 与 MCP 工具完全一致的调用方式（src/mcp-snowluma-safe.js agentApi）：
 * x-console-token + x-agent-token + x-agent-call: 1。
 */
function agentRequest(server, { method = 'POST', pathname, query = '', body, agentToken }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const search = new URLSearchParams(query || {}).toString();
    const req = http.request({
      host: '127.0.0.1', port: server.address().port,
      path: `${pathname}?token=${encodeURIComponent(CONSOLE_TOKEN)}${search ? `&${search}` : ''}`,
      method,
      headers: {
        'content-type': 'application/json',
        'x-console-token': CONSOLE_TOKEN,
        ...(agentToken ? { 'x-agent-token': agentToken, 'x-agent-call': '1' } : {}),
        ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        connection: 'close',
      },
      agent: false,
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
    // 15s：分条发送的响应要等完整条链（含间隔），auto 模式的间隔上限可到 10s；
    // 用例自己会用 gapMode:'fixed' 把间隔压到 300ms，这里的预算只是兜底。
    req.setTimeout(15000, () => req.destroy(new Error('request hung')));
    req.end(payload ?? undefined);
  });
}

const sendMessage = (server, { key, messages, agentToken }) =>
  agentRequest(server, { pathname: '/api/socialV2/send-message', body: { key, messages }, agentToken });

async function listen(server) {
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  return server;
}
async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

const count = (text, re) => (String(text).match(re) ?? []).length;
/** 拦下来的 OneBot 发送请求 —— 「真的发出去了」的最强证据（谁、什么内容）。 */
const onebotSends = (h, action) => h.calls.http.filter((c) => c.url.includes(`/${action}`));
const sentText = (h, action) => onebotSends(h, action).map((c) => JSON.stringify(c.body?.message ?? '')).join(' | ');
/** 等 mux 帧被真实 pumpMux 处理完（固定 sleep 在繁忙机器上会偶发假红）。 */
const waitTurnActive = (h, timeoutMs = 4000) => waitFor(() => h.ownerCrossSendV2.active !== null, timeoutMs);
const waitTurnClosed = (h, timeoutMs = 4000) => waitFor(() => h.ownerCrossSendV2.active === null, timeoutMs);
const waitFor = async (fn, timeoutMs = 3000, stepMs = 40) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(stepMs);
  }
};

let failures = 0;
async function test(name, run) {
  const t0 = Date.now();
  try {
    await run();
    console.log(`✅ ${name}（${Date.now() - t0}ms）`);
  } catch (error) {
    failures += 1;
    console.error(`❌ ${name}（${Date.now() - t0}ms）\n   ${error?.stack ?? error?.message ?? error}`);
  }
}

/** 起一个 harness + console server，跑完自动收尾。 */
async function withBridge(run, config) {
  const h = await crossHarness({ config });
  const server = await listen(h.startConsoleServer());
  try { await run(h, server); }
  finally { await closeServer(server); await h.close(); }
}

/** 造一个「管理员来信 → 该轮到回合中」的授权现场。
 *  t61：兑现已从 turn/start 提前到「承载这封来信的那次唤醒真的被投递进 DSH」⇒ 这里先走真实投递，
 *  再 push turn/start（它只负责接管这一轮，不再消费名额）。 */
async function openOwnerTurn(h, feed, { turn = 1, text = '去给 999 发条消息' } = {}) {
  const sidOwner = await h.ensureSession(OWNER_KEY);
  const ownerToken = h.getSocialV2State(OWNER_KEY).agentToken;
  await h.handleIncoming('private', OWNER_QQ, ownerMessage(text), h.cfg);
  assert.ok(h.ownerCrossSendV2.pending, '管理员来信必须登记「待兑现」名额');
  assert.ok(Number.isFinite(Number(h.ownerCrossSendV2.pending.seq)) && Number(h.ownerCrossSendV2.pending.seq) > 0,
    `来信的待兑现名额必须带 unread 序号（不截胡的绑定依据）：${JSON.stringify(h.ownerCrossSendV2.pending)}`);
  await redeemByDelivery(h);
  feed.push([turnStart(sidOwner, turn)]);
  assert.ok(await waitFor(() => h.v2TurnStartAt.has(sidOwner), 4000), 'turn/start 必须真的开起来（接管那一轮）');
  return { sidOwner, ownerToken };
}

/**
 * t61 兑现点：调**真实的** sendWakePromptV2 把「承载管理员来信的那次唤醒」交给 DSH ⇒ 就地兑现授权。
 * 无 seq / seq 不等于来信序号 的唤醒不会兑现（回复检查、主动检查、看门狗重排别的条目…）。
 */
async function redeemByDelivery(h, { reason = 'private', expectSeq } = {}) {
  const st = h.getSocialV2State(OWNER_KEY);
  const seq = expectSeq ?? st.lastUnreadSeq;
  assert.ok(Number.isFinite(Number(seq)) && Number(seq) > 0, `来信必须有 unread 序号（实测 ${seq}）`);
  // handleIncoming 已经排了一个合并窗定时器（pendingWakeTimer 本身就是 ① 忙判据），这里把它撤掉再
  // 直接投递 —— 本函数是**注入式**夹具，只用来给"非定时器路径"的用例省时间。
  // ⚠️ 订正（t65-F2，原文案写错了）：生产里合并窗到点时是由 `scheduleWakeV2` 的定时器回调投递的，
  // 它传的是 **`st.pendingWakeSeq`**（:12325→:12328），不是"同一个 seq"：来信路径只有在
  // `scheduleWakeV2(key, reason, { seq })` 显式带 seq 时它才非空（t65 起来信分支就是这么排的）。
  // 所以"注入 seq"与"真实定时器"**不是**同一条路径 —— 真实定时器路径由 `跨会话-15`（空闲来信，等
  // `st.pendingWakeTimer` 自然触发）与 `跨会话-16`（忙时暂存 → 真实重排）两条用例覆盖。
  if (st.pendingWakeTimer) { clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null; }
  st.pendingWakeReason = null;
  st.pendingWakeSeq = null;
  await h.sendWakePromptV2(OWNER_KEY, reason, { seq });
  assert.ok(await waitTurnActive(h), '承载管理员来信的那次投递必须就地兑现授权');
  const log = h.readLog();
  assert.match(log, /\[cross-session\] 授权窗口开启：管理员 123 来信的唤醒(已交给当前回合的待办队列|已投递)/,
    '授权窗口开启必须留痕（「暂存即兑现」t66/A′ 或「投递时兑现」t61）');
  assert.match(log, new RegExp(`来源=owner-message@seq${seq}`), `授权行必须写明承载它的 seq=${seq}：${log.split('\n').filter((l) => l.includes('授权窗口开启')).pop() ?? ''}`);
  return seq;
}

// ══ 1. 正例：owner 会话在「管理员来信触发的那一轮」里代发到白名单内目标 ══════════════
await test('跨会话-1：owner 会话代发到白名单内私聊 → 成功 + [cross-session] 审计行（含授权人/来源/目标/条数）', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    h.getSocialV2State(OTHER_PRIVATE);
    const feed = startMux(h);
    // ① 管理员来信之前：同样的调用必须被拒（原有隔离语义没松，错误文案也不变）
    const sidOwner = await h.ensureSession(OWNER_KEY);
    const ownerToken = h.getSocialV2State(OWNER_KEY).agentToken;
    let res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['你好'], agentToken: ownerToken });
    assert.equal(res.status, 403, `未授权时必须 403：${res.raw}`);
    assert.equal(res.data.error, 'agent token 无效', '错误文案必须保持原样');
    assert.equal(h.calls.http.length, 0, '被拒时绝不能发出任何 QQ 消息');
    // ② 管理员来信 → 它触发的那一轮
    await h.handleIncoming('private', OWNER_QQ, ownerMessage('去给 999 发条消息'), h.cfg);
    await redeemByDelivery(h);                 // t61：兑现点在「承载来信的那次投递」，不再等 turn/start
    feed.push([turnStart(sidOwner, 1)]);        // 这一轮只负责接管刚兑现的授权
    assert.ok(await waitFor(() => h.v2TurnStartAt.has(sidOwner), 4000), 'owner 回合必须真的开起来');
    assert.match(h.readLog(), /\[cross-session\] 授权窗口开启：管理员 123/, '授权窗口开启必须留痕（含授权人）');
    // ③ 代发：走真实发送链路
    res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['替管理员传个话'], agentToken: ownerToken });
    assert.equal(res.status, 200, `授权轮内必须放行：${res.raw}`);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.sent, 1);
    // 真发送链路证据：OneBot HTTP 收到 send_private_msg(user_id=999, 文本=管理员那句话)
    const sends = onebotSends(h, 'send_private_msg');
    assert.equal(sends.length, 1, '必须真的走 OneBot 发送链路');
    assert.equal(Number(sends[0].body.user_id), 999, '必须发给被指定的那个会话');
    assert.ok(sentText(h, 'send_private_msg').includes('替管理员传个话'), `发送内容必须原样：${sentText(h, 'send_private_msg')}`);
    // ④ 审计行：授权人 ownerQQ、来源、目标、条数、结果
    const log = h.readLog();
    const audit = (log.match(/\[cross-session\] 代发成功[^\n]*/g) ?? []).pop() ?? '';
    assert.match(audit, /授权人=123/, `审计行必须含授权人：${audit}`);
    assert.match(audit, /来源=owner-message/, `审计行必须含触发来源：${audit}`);
    assert.match(audit, /目标=private:999/, `审计行必须含目标：${audit}`);
    assert.match(audit, /条数=1\/1/, `审计行必须含条数：${audit}`);
    console.log(`   [证据] 未授权 403「agent token 无效」→ 管理员来信触发回合 → 200 sent=1；审计行=${audit}`);
  });
});

// ══ 2. 核心：只有管理员能指派 —— 非管理员触发的回合一律被拒 ═════════════════════════
await test('跨会话-2（核心）：同一 owner 会话里，proactiveCheck/replyCheck/probability/自动检查 等回合一律被拒', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    h.getSocialV2State(OTHER_PRIVATE);
    const feed = startMux(h);
    const sidOwner = await h.ensureSession(OWNER_KEY);
    const ownerToken = h.getSocialV2State(OWNER_KEY).agentToken;
    let turn = 10;
    for (const reason of ['proactive', 'replyCheck', 'probability', 'keyword:在吗', 'atMention']) {
      await h.scheduleWakeV2(OWNER_KEY, reason);      // 这些正是非管理员触发的唤醒路径
      feed.push([turnStart(sidOwner, (turn += 1))]);
      assert.ok(await waitFor(() => h.v2TurnStartAt.has(sidOwner), 4000),
        `${reason} 回合必须真的开始（否则本用例没验到东西）`);
      assert.equal(h.ownerCrossSendV2.active, null, `${reason} 回合不得拿到授权`);
      const res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['越权试试'], agentToken: ownerToken });
      assert.equal(res.status, 403, `${reason} 回合必须被拒：${res.raw}`);
      assert.equal(res.data.error, 'agent token 无效');
      assert.equal(h.calls.http.length, 0, `${reason} 回合不得发出任何消息`);
      assert.match(h.readLog(), /\[cross-session\] 拒绝代发（no-grant）/,
        `${reason} 回合的拒绝必须可追溯到「没有管理员授权」`);
      feed.push([turnEnd(sidOwner, turn)]);
      await waitFor(() => !h.v2TurnStartAt.has(sidOwner), 3000);
    }
    // 桥接自己发起的投递（例如「请设置唤醒条件」提醒、主动机会）同样不是管理员触发
    await h.deliverPrompt(OWNER_KEY, '【系统】请设置你下一次的唤醒条件', {}).catch(() => null);
    feed.push([turnStart(sidOwner, (turn += 1))]);
    assert.ok(await waitFor(() => h.v2TurnStartAt.has(sidOwner), 4000), '桥接自动提醒的回合必须真的开始');
    assert.equal(h.ownerCrossSendV2.active, null, '桥接自动提醒的回合不得拿到授权');
    let bridgeRes = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['自动提醒轮'], agentToken: ownerToken });
    assert.equal(bridgeRes.status, 403, `桥接自动提醒的回合必须被拒：${bridgeRes.raw}`);
    assert.equal(h.calls.http.length, 0);
    feed.push([turnEnd(sidOwner, turn)]);
    await waitFor(() => !h.v2TurnStartAt.has(sidOwner), 3000);
    // 对照组：同一会话、管理员来信触发 → 放行
    await h.handleIncoming('private', OWNER_QQ, ownerMessage('这回你去发'), h.cfg);
    await redeemByDelivery(h);                  // t61：投递时兑现
    feed.push([turnStart(sidOwner, (turn += 1))]);
    assert.ok(await waitTurnActive(h), '管理员来信触发的那一轮必须拿到授权');
    const ok = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['管理员让我发的'], agentToken: ownerToken });
    assert.equal(ok.status, 200, `管理员触发的回合必须放行：${ok.raw}`);
    assert.equal(h.calls.http.length, 1);
    console.log('   [证据] proactive/replyCheck/probability/keyword/atMention 五个非管理员回合 + 桥接自动提醒轮全部 403（no-grant）；管理员来信触发的那一轮 200');
  });
});

// ══ 3. 授权窗口四条 + 上限不变量 ═══════════════════════════════════════════════════
await test('跨会话-3：授权窗口 = 管理员来信触发的那一轮（轮内放行 / 超 30 分钟拒 / 回合结束即失效 / 非管理员轮拒）', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    h.getSocialV2State(OTHER_PRIVATE);
    const feed = startMux(h);
    const { sidOwner, ownerToken } = await openOwnerTurn(h, feed, { turn: 30 });
    // ① 同一轮内、未超上限 → 放行
    let res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['一'], agentToken: ownerToken });
    assert.equal(res.status, 200, res.raw);
    // ② 超过墙钟硬上限（把授权起点回拨到上限之外）→ 拒
    const startedAt = h.ownerCrossSendV2.active.startedAt;
    h.ownerCrossSendV2.active.startedAt = Date.now() - (h.CROSS_SESSION_GRANT_MS + 1000);
    res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['二'], agentToken: ownerToken });
    assert.equal(res.status, 403, `超 30 分钟必须被拒：${res.raw}`);
    assert.match(h.readLog(), /\[cross-session\] 拒绝代发（grant-expired）/, '超上限的拒绝必须留痕');
    // 回拨回来 → 仍可放行（证明上面拒的是窗口而不是别的）
    h.ownerCrossSendV2.active.startedAt = startedAt;
    res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['三'], agentToken: ownerToken });
    assert.equal(res.status, 200, res.raw);
    // ③ 回合结束后再调用 → 拒
    feed.push([turnEnd(sidOwner, 30)]);
    assert.ok(await waitTurnClosed(h), 'turn/end 必须关闭授权窗口');
    assert.match(h.readLog(), /\[cross-session\] 授权窗口关闭：private:123 的授权回合已结束/);
    res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['四'], agentToken: ownerToken });
    assert.equal(res.status, 403, `回合结束后必须被拒：${res.raw}`);
    assert.match(h.readLog(), /\[cross-session\] 拒绝代发（no-grant）/);
    // ④ 非管理员触发的回合 → 拒（详见跨会话-2）
    // 上限不变量：与看门狗 hardCapMs 同值且不得更长
    assert.equal(h.CROSS_SESSION_GRANT_MS, 1800000, '墙钟上限必须恰好 30 分钟（用户指定）');
    const source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
    assert.match(source, /const CROSS_SESSION_GRANT_MS = 1800000;/, '常量必须显式写死 1800000');
    assert.match(source, /hardCapMs: 1800000/, '必须与看门狗 hardCapMs 同值');
    assert.ok(h.CROSS_SESSION_GRANT_MS <= 1800000, '窗口上限不变量：≤ 1800000ms');
    console.log(`   [证据] 轮内 200 → 回拨 ${Math.round(h.CROSS_SESSION_GRANT_MS / 1000)}s+ 后 403（grant-expired）→ 回拨回来 200 → turn/end 后 403（no-grant）；常量=${h.CROSS_SESSION_GRANT_MS}ms`);
  });
});

// ══ 4. 非 owner 会话完全不受影响 ═══════════════════════════════════════════════════
await test('跨会话-4：非 owner 会话（群 / 其它私聊）代发仍被拒；它们自己发自己照旧成功', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    const feed = startMux(h);
    const sidGroup = await h.ensureSession(OTHER_GROUP);
    const sidOther = await h.ensureSession(OTHER_PRIVATE);
    const groupToken = h.getSocialV2State(OTHER_GROUP).agentToken;
    const otherToken = h.getSocialV2State(OTHER_PRIVATE).agentToken;
    // 群会话的回合也是真实的（证明「有回合」不等于「有授权」）
    feed.push([turnStart(sidGroup, 1), turnStart(sidOther, 1)]);
    assert.ok(await waitFor(() => h.v2TurnStartAt.has(sidGroup) && h.v2TurnStartAt.has(sidOther), 4000),
      '两个非 owner 会话的回合必须真的开始');
    // 群 → 别的私聊：拒
    let res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['跨会话'], agentToken: groupToken });
    assert.equal(res.status, 403, `群会话代发必须被拒：${res.raw}`);
    assert.equal(res.data.error, 'agent token 无效');
    // 其它私聊 → 群：拒
    res = await sendMessage(server, { key: OTHER_GROUP, messages: ['跨会话'], agentToken: otherToken });
    assert.equal(res.status, 403, `其它私聊代发必须被拒：${res.raw}`);
    assert.equal(res.data.error, 'agent token 无效');
    // 对照：各自发自己的会话照旧成功（隔离语义未变，原有能力没被误伤）
    res = await sendMessage(server, { key: OTHER_GROUP, messages: ['我自己的群'], agentToken: groupToken });
    assert.equal(res.status, 200, `群会话发自己的群必须照旧成功：${res.raw}`);
    res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['我自己的私聊'], agentToken: otherToken });
    assert.equal(res.status, 200, `私聊发自己必须照旧成功：${res.raw}`);
    assert.equal(h.calls.http.length, 2);
    assert.equal(count(h.readLog(), /\[cross-session\] 代发成功/g), 0, '非 owner 会话不得产生任何跨会话成功审计');
    console.log('   [证据] 群/其它私聊的代发均 403「agent token 无效」；各自发自己 200×2；跨会话成功审计=0');
  });
});

// ══ 5. 白名单外目标：即使来自 owner 会话也一律被拒 ══════════════════════════════════
await test('跨会话-5：白名单外目标（allow.private / allow.groups 两类）一律被拒', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    h.getSocialV2State(OTHER_PRIVATE);
    const feed = startMux(h);
    const { ownerToken } = await openOwnerTurn(h, feed, { turn: 40 });
    for (const key of [OUT_PRIVATE, OUT_GROUP]) {
      const res = await sendMessage(server, { key, messages: ['白名单外'], agentToken: ownerToken });
      assert.equal(res.status, 403, `${key} 必须被拒：${res.raw}`);
      assert.match(String(res.data.error), /目标不在当前模式允许范围内|agent token 无效/, `拒绝文案应说明目标不允许：${res.raw}`);
    }
    assert.equal(h.calls.http.length, 0, '白名单外目标绝不能发出消息');
    // 对照：白名单内的两个目标都能发（证明上面的拒是白名单、不是授权）
    for (const key of [OTHER_PRIVATE, OTHER_GROUP]) {
      await h.ensureSession(key);
      const res = await sendMessage(server, { key, messages: ['白名单内'], agentToken: ownerToken });
      assert.equal(res.status, 200, `${key} 必须放行：${res.raw}`);
    }
    assert.equal(h.calls.http.length, 2);
    console.log('   [证据] private:888 / group:777 → 403；private:999 / group:456 → 200×2');
  });
});

// ══ 6. 豁免只作用于发送路径：其它会话级工具一项都不放 ═══════════════════════════════
await test('跨会话-6：owner 授权轮内，unread/recent/images/mark-read/send-poke/collect-sticker 操作其它会话仍全部被拒', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    const feed = startMux(h);
    const { ownerToken } = await openOwnerTurn(h, feed, { turn: 50 });
    h.getSocialV2State(OTHER_PRIVATE);
    const cases = [
      ['GET', '/api/socialV2/unread', { key: OTHER_PRIVATE }],
      ['GET', '/api/socialV2/recent', { key: OTHER_PRIVATE }],
      ['GET', '/api/images/message', { key: OTHER_PRIVATE, messageId: '1' }],
      ['POST', '/api/socialV2/mark-read', undefined, { key: OTHER_PRIVATE, throughSeq: 1 }],
      ['POST', '/api/socialV2/send-poke', undefined, { key: OTHER_PRIVATE }],
      ['POST', '/api/socialV2/collect-sticker', undefined, { key: OTHER_PRIVATE, messageId: '1' }],
    ];
    for (const [method, pathname, query, body] of cases) {
      const res = await agentRequest(server, { method, pathname, query, body, agentToken: ownerToken });
      assert.equal(res.status, 403, `${pathname} 操作别的会话必须被拒：${res.raw}`);
      assert.equal(res.data?.error, 'agent token 无效', `${pathname} 必须走原隔离语义：${res.raw}`);
    }
    // 对照：同一批端点操作 owner 自己的会话时令牌这一关是过的（不是这些端点整体坏了）
    const ownUnread = await agentRequest(server, { method: 'GET', pathname: '/api/socialV2/unread', query: { key: OWNER_KEY }, agentToken: ownerToken });
    assert.equal(ownUnread.status, 200, `owner 自己的 unread 必须照常可用：${ownUnread.raw}`);
    const ownMarkRead = await agentRequest(server, { method: 'POST', pathname: '/api/socialV2/mark-read', body: { key: OWNER_KEY, throughSeq: 0 }, agentToken: ownerToken });
    assert.notEqual(ownMarkRead.status, 403, `owner 自己的 mark-read 不得因令牌被拒：${ownMarkRead.raw}`);
    console.log('   [证据] 6 个非发送端点在授权轮内操作别的会话全部 403「agent token 无效」；owner 自己 unread=200 / mark-read≠403');
  });
});

// ══ 7. 反向：别的会话拿不到、也用不了 owner 的能力 ═════════════════════════════════
await test('跨会话-7：群会话冒用 owner 令牌 / 拿 owner 授权轮当挡箭牌 —— 都不成立', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    h.getSocialV2State(OTHER_PRIVATE);
    const feed = startMux(h);
    const sidGroup = await h.ensureSession(OTHER_GROUP);
    await h.ensureSession(OWNER_KEY);
    const { ownerToken } = await openOwnerTurn(h, feed, { turn: 60 });
    // 群会话自己的令牌 + 目标其它会话：拒（拿不到 owner 能力）
    const groupToken = h.getSocialV2State(OTHER_GROUP).agentToken;
    let res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['群想代发'], agentToken: groupToken });
    assert.equal(res.status, 403, res.raw);
    // 群会话的回合正在进行：owner 的授权轮不会因此被「借」给它
    feed.push([turnStart(sidGroup, 2)]);
    assert.ok(await waitFor(() => h.v2TurnStartAt.has(sidGroup), 4000), '群会话回合必须真的开始');
    res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['群又试一次'], agentToken: groupToken });
    assert.equal(res.status, 403, res.raw);
    // owner 令牌仍然只对 owner 会话有效：拿它去冒充「调用方是群会话」也无法绕过（令牌即身份）
    res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['owner 令牌'], agentToken: ownerToken });
    assert.equal(res.status, 200, `owner 令牌在其授权轮内正常放行：${res.raw}`);
    // 不存在的令牌：拒
    res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['假令牌'], agentToken: 'not-a-real-token' });
    assert.equal(res.status, 403, res.raw);
    console.log('   [证据] 群令牌 → 403×2（含群自己回合进行时）；owner 令牌 200；伪造令牌 403');
  });
});

// ══ 8. 第三方隔离：别的会话的消息与回合不影响 owner 的授权 ══════════════════════════
await test('跨会话-8：授权窗口内，别的会话来消息 / 起回合，不影响 owner 授权，也不给它们任何能力', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    h.getSocialV2State(OTHER_PRIVATE);
    const feed = startMux(h);
    const sidGroup = await h.ensureSession(OTHER_GROUP);
    const groupToken = h.getSocialV2State(OTHER_GROUP).agentToken;
    const { ownerToken } = await openOwnerTurn(h, feed, { turn: 70 });
    const before = h.ownerCrossSendV2.active;
    // 第三方动作：群里来消息（真实 handleIncoming）+ 群会话自己起一个回合并收尾
    await h.handleIncoming('group', 456, groupMessage('群里聊点别的'), h.cfg);
    feed.push([turnStart(sidGroup, 9)]);
    assert.ok(await waitFor(() => h.v2TurnStartAt.has(sidGroup), 4000), '群会话回合必须真的开始');
    feed.push([turnEnd(sidGroup, 9)]);
    assert.ok(await waitFor(() => !h.v2TurnStartAt.has(sidGroup), 4000), '群会话回合必须真的结束');
    assert.equal(h.ownerCrossSendV2.active, before, '第三方回合不得改动 owner 的授权状态');
    assert.equal(h.ownerCrossSendV2.active?.key, OWNER_KEY);
    // owner 的授权依然有效
    let res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['第三方插曲之后仍可发'], agentToken: ownerToken });
    assert.equal(res.status, 200, `第三方动作不得影响 owner 授权：${res.raw}`);
    // 第三方依旧没有任何跨会话能力
    res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['群照样不行'], agentToken: groupToken });
    assert.equal(res.status, 403, res.raw);
    // owner 自己的回合收尾后，窗口才关闭
    const sidOwner = h.state.sessions[OWNER_KEY];
    feed.push([turnEnd(sidOwner, 70)]);
    assert.ok(await waitTurnClosed(h), 'owner 回合结束后窗口才关闭');
    console.log('   [证据] 第三方消息+回合前后 owner 授权对象不变；owner 仍 200；群仍 403；owner 回合结束后窗口关闭');
  });
});

// ══ 9. 判定来源：管理员身份只来自 config.ownerQQ；强制逻辑在桥接层（静态锚点）═════════
await test('跨会话-9：管理员身份只来自 config.ownerQQ；豁免只挂在发送路径（3 个端点）；无硬编码 QQ', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    h.getSocialV2State(OTHER_PRIVATE);
    const feed = startMux(h);
    const { ownerToken } = await openOwnerTurn(h, feed, { turn: 80 });
    // 换一个 ownerQQ：能力跟着配置走（同一套代码、同一个会话结构，判定不写死数字）
    assert.equal(h.ownerSessionKeyV2(), 'private:123', 'owner 会话 key 必须由 cfg.ownerQQ 推导');
    h.cfg.ownerQQ = 456789;
    assert.equal(h.ownerSessionKeyV2(), 'private:456789', '改 ownerQQ 后能力应当跟着走');
    const res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['换 owner 后'], agentToken: ownerToken });
    assert.equal(res.status, 403, 'ownerQQ 一变，旧令牌就不再是 owner 会话的令牌 ⇒ 必须被拒');
    h.cfg.ownerQQ = OWNER_QQ;
    const back = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['换回来'], agentToken: ownerToken });
    assert.equal(back.status, 200, `ownerQQ 复原后授权恢复：${back.raw}`);
    // 静态锚点
    const source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
    assert.ok(!/1587\d{6}|1000000001|1000000021/.test(source), '代码里不得硬编码任何具体 QQ 号（含本次取证的号码）');
    assert.equal(count(source, /crossSessionSendCheckV2\(/g), 3,
      'crossSessionSendCheckV2 只能出现在 3 个发送端点里（/api/send/* + send-message + send-burst）');
    assert.equal(count(source, /logCrossSendDeniedV2\(/g), 3, '拒绝审计同样只挂在这 3 个发送端点');
    assert.match(source, /function ownerSessionKeyV2\(\)[\s\S]{0,200}cfg\.ownerQQ/, 'owner 身份只来自 cfg.ownerQQ');
    // 只读提示词/前端不构成强制：判定必须发生在桥接的 HTTP 层（本测试正是直接打端点，没有模型参与）
    console.log('   [证据] ownerQQ 123→456789 后同一令牌 403、复原后 200；硬编码号码=0；豁免调用点=3（仅发送端点）');
  });
});

// ══ 9b. 敏感内容只能私下告诉主人（t81）：唤醒提示里必须能看到 owner 的私聊 key ═════════════
// 用户诉求（2026-10-08）：敏感/不适内容不往群里带，但可以私下告诉主人 —— 前提是模型**知道**
// 主人的私聊 key。旧状态：唤醒提示里只有本会话的 key（`【唤醒】${key}`），message 上的
// ownerLabel 只在「主人自己在这个会话发言」时才带 ownerQQ；主人没开口的群会话里推不出来 ⇒
// 模型只能猜。这里钉住「提示里给出 private:<ownerQQ>」并且它跟着 config.ownerQQ 走（不写死号码）。
await test('跨会话-9b：唤醒提示里给出【主人私聊】private:<ownerQQ>，且随 config.ownerQQ 变化', async () => {
  await withBridge(async (h) => {
    h.setMode('reserved2');
    // 用一个「主人压根没说过话」的群会话：ownerLabel 帮不上忙，只有唤醒提示能给到 key。
    const prompt = h.buildWakePromptV2(OTHER_GROUP, 'private');
    assert.match(prompt, /【主人私聊】/, `唤醒提示必须有【主人私聊】一行，实测：${prompt.slice(0, 300)}`);
    assert.ok(prompt.includes(`private:${OWNER_QQ}`), `唤醒提示必须带 owner 私聊 key（private:${OWNER_QQ}）`);
    // 换一个 ownerQQ：提示里的 key 跟着配置走（同一套代码，同一个会话结构，判定不写死数字）
    h.cfg.ownerQQ = 456789;
    const moved = h.buildWakePromptV2(OTHER_GROUP, 'private');
    assert.ok(moved.includes('private:456789'), '改 ownerQQ 后提示里的 owner 私聊 key 应跟着走');
    assert.ok(!moved.includes(`private:${OWNER_QQ}`), '旧 owner 私聊 key 不应残留在提示里');
    h.cfg.ownerQQ = OWNER_QQ;
    console.log(`   [证据] 群会话唤醒提示含【主人私聊】private:${OWNER_QQ}；ownerQQ→456789 后同步为 private:456789`);
  });
});

// ══ 10. 另外两个发送端点同规则（豁免挂在「发送路径」这一类上，不是一个端点）═════════
await test('跨会话-10：/api/send/private 与 /api/socialV2/send-burst 同规则（无授权拒 / 授权轮内放行）', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    h.getSocialV2State(OTHER_PRIVATE);
    const feed = startMux(h);
    const sidOwner = await h.ensureSession(OWNER_KEY);
    const ownerToken = h.getSocialV2State(OWNER_KEY).agentToken;
    // 无授权：两个端点都必须拒
    let legacy = await agentRequest(server, {
      pathname: '/api/send/private', body: { token: ownerToken, userId: '999', message: '偷偷发' },
    });
    assert.equal(legacy.status, 403, `无授权时 /api/send/private 必须拒：${legacy.raw}`);
    assert.equal(legacy.data.error, 'agent token 无效');
    let burst = await agentRequest(server, {
      pathname: '/api/socialV2/send-burst', body: { key: OTHER_PRIVATE, messages: ['一', '二'] }, agentToken: ownerToken,
    });
    assert.equal(burst.status, 403, `无授权时 send-burst 必须拒：${burst.raw}`);
    assert.equal(burst.data.error, 'agent token 无效');
    assert.equal(h.calls.http.length, 0);
    // 管理员来信触发的那一轮：两个端点都放行
    await h.handleIncoming('private', OWNER_QQ, ownerMessage('去把这两条也发了'), h.cfg);
    await redeemByDelivery(h);                  // t61：投递时兑现
    feed.push([turnStart(sidOwner, 90)]);
    assert.ok(await waitTurnActive(h), 'owner 回合必须拿到授权');
    legacy = await agentRequest(server, {
      pathname: '/api/send/private', body: { token: ownerToken, userId: '999', message: '走老端点' },
    });
    assert.equal(legacy.status, 200, `授权轮内 /api/send/private 必须放行：${legacy.raw}`);
    burst = await agentRequest(server, {
      pathname: '/api/socialV2/send-burst',
      // gapMode:'fixed' + gapMs：把分条间隔钉成确定值（auto 模式的下限是 300ms、上限 10s，
      // 会让响应时长随机，审计环境下曾把 5s 客户端预算吃满成 flake）
      body: { key: OTHER_PRIVATE, messages: ['第一条', '第二条'], gapMode: 'fixed', gapMs: 120 },
      agentToken: ownerToken,
    });
    assert.equal(burst.status, 200, `授权轮内 send-burst 必须放行：${burst.raw}`);
    assert.equal(burst.data.sent, 2);
    assert.equal(onebotSends(h, 'send_private_msg').length, 3, '三条消息都必须真的发出');
    const log = h.readLog();
    assert.match(log, /\[cross-session\] 代发成功：[^\n]*端点=\/api\/send\/private/,
      '老发送端点的审计行必须带端点名');
    assert.equal(count(log, /\[cross-session\] 代发成功/g), 2, '两个端点各留 1 行审计');
    console.log('   [证据] 无授权 403×2 → 授权轮内 200×2（send-burst sent=2）；OneBot 实际发出 3 条；审计行=2');
  });
});

// ══ 11. t61 生产复现：owner 私聊**长期驻留同一轮**时也必须能授权（不再等新的 turn/start）═══════
/**
 * 2026-10-06 17:2x–17:3x 真实事故：owner 私聊里机器人两次代发都被 `拒绝代发（no-grant）`，
 * 日志里零「授权窗口开启」—— 因为名额当时只在 turn/start 兑现，而那一段对话**一直驻留在同一轮**里。
 * 本用例把这个场景钉死：轮内有旧回合 → 来信在忙时被暂存 → 补发（投递）时就地兑现 → 同一轮里代发成功。
 */
async function residentTurnScenario(h, server, feed) {
  h.setMode('reserved2');
  h.getSocialV2State(OTHER_PRIVATE);
  const sidOwner = await h.ensureSession(OWNER_KEY);
  const ownerToken = h.getSocialV2State(OWNER_KEY).agentToken;
  const st = h.getSocialV2State(OWNER_KEY);
  // ① 已经在某一轮里（T1）：真实 mux 帧点亮 ④ + collector —— 期间**不会有新的 turn/start**
  feed.push([turnStart(sidOwner, 1)]);
  assert.ok(await waitFor(() => h.v2TurnStartAt.has(sidOwner), 4000), 'T1 必须真的在跑');
  const turnMarksBefore = count(h.readLog(), /\[reserved2\] 唤醒 private:123（private）/g);
  // ② 管理员来信到达时会话忙 ⇒ 被静默暂存（事故现场），名额登记为「待兑现」并带上来信序号
  await h.handleIncoming('private', OWNER_QQ, ownerMessage('去给 999 发条消息'), h.cfg);
  // t66（A′）：来信自己的唤醒被「繁忙暂存」的那一刻就兑现名额 —— 生产里用户正是在这个空窗期内
  // 发起代发而连吃 no-grant（暂存 14 秒后就试，重排投递还没发生）。
  const arr = h.ownerCrossSendV2;
  assert.ok(arr.pending || arr.active, '来信必须登记待兑现名额，或已因「繁忙暂存」就地兑现（t66/A′）');
  const letterSeq = Number((arr.pending ?? arr.active).seq);
  assert.ok(Number.isFinite(letterSeq) && letterSeq > 0, `来信必须有 unread 序号：${JSON.stringify(arr.pending ?? arr.active)}`);
  assert.match(h.readLog(), /会话繁忙，暂存唤醒原因 private:123/, '忙时来信的唤醒必须被暂存（事故现场）');
  assert.ok(arr.active !== null, 't66（A′）：暂存那一刻就该就地兑现、把窗口开起来，否则这个空窗期里代发必吃 no-grant');
  assert.match(h.readLog(), /\[cross-session\] 授权窗口开启：管理员 123 来信的唤醒已交给当前回合的待办队列/,
    '暂存即兑现必须留痕，且与「投递时兑现」的文案区分开');
  const early = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['暂存空窗期里的代发'], agentToken: ownerToken });
  assert.equal(early.status, 200, `t66（A′）：暂存即兑现后同轮代发必须放行：${early.raw}`);
  assert.equal(early.data.sent, 1);
  // ③ 自愈补发：④ 被清（看门狗/C-stall 释放）后，**承载这封来信的那次唤醒**被真正投递给 DSH
  h.v2TurnStartAt.delete(sidOwner);
  h.collectors.delete(sidOwner);
  if (st.pendingWakeTimer) { clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null; }
  st.pendingWakeReason = null;
  st.pendingWakeSeq = null;
  await h.sendWakePromptV2(OWNER_KEY, 'private', { seq: letterSeq, ownerLetter: true });
  assert.ok(await waitTurnActive(h), '授权必须在（暂存或投递任一路径）就地兑现，不需要任何新 turn/start');
  // 注：留痕在①处（暂存即兑现）就已经打过；日志缓冲区会滚动，这里改校验状态与绑定字段，不追文案。
  assert.ok(h.ownerCrossSendV2.active, '承载来信的那条路径（暂存或投递）必须已就地兑现授权');
  assert.equal(Number(h.ownerCrossSendV2.active.seq), letterSeq, `授权必须绑这封信的 seq=${letterSeq}`);
  // ④ 同一轮里代发：必须 200，且审计行字段齐全（授权人/来源/目标/条数/端点）
  const res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['驻留轮里的代发'], agentToken: ownerToken });
  assert.equal(res.status, 200, `驻留轮内必须放行：${res.raw}`);
  assert.equal(res.data.sent, 1);
  const audit = (h.readLog().match(/\[cross-session\] 代发成功[^\n]*/g) ?? []).pop() ?? '';
  assert.match(audit, /授权人=123/, `审计行缺授权人：${audit}`);
  assert.match(audit, /来源=owner-message/, `审计行缺来源：${audit}`);
  assert.match(audit, /目标=private:999/, `审计行缺目标：${audit}`);
  assert.match(audit, /条数=1\/1/, `审计行缺条数：${audit}`);
  assert.match(audit, /端点=\/api\/socialV2\/send-message|端点=\/api\/send\/private/, `审计行缺端点：${audit}`);
  assert.equal(onebotSends(h, 'send_private_msg').length, 2, '两次代发都必须真的走 OneBot 发送链路（暂存空窗期 1 次 + 投递后 1 次）');
  // ⑤ 该授权属于 T1：T1 结束时关闭
  feed.push([turnEnd(sidOwner, 1)]);
  assert.ok(await waitTurnClosed(h), '授权回合结束必须关闭窗口');
  assert.match(h.readLog(), /\[cross-session\] 授权窗口关闭：private:123/);
  const after = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['轮后不该放行'], agentToken: ownerToken });
  assert.equal(after.status, 403, `授权回合结束后必须回到 no-grant：${after.raw}`);
  console.log(`   [证据] 驻留轮 T1 内：来信被暂存 → 投递（seq=${letterSeq}）即兑现（无需新 turn/start）→ 代发 200 sent=1；`
    + `T1 turn/end 即关闭 → 再发 403；期间新唤醒投递数=${count(h.readLog(), /\[reserved2\] 唤醒 private:123（private）/g) - turnMarksBefore}`);
  return { sidOwner, ownerToken };
}

await test('跨会话-11（t61 生产复现）：owner 长期驻留同一轮 ⇒ 来信唤醒被补发投递时即兑现，同轮内代发成功', async () => {
  await withBridge(async (h, server) => {
    const feed = startMux(h);
    await residentTurnScenario(h, server, feed);
  });
});

// ══ 12. t61 不截胡：名额只绑「承载来信的那次投递」，无关唤醒投递一律不兑现（消掉 t30 的 O1）═══
await test('跨会话-12（t61 不截胡）：回复检查/主动检查/其它 seq 的唤醒投递都不得兑现名额', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    h.getSocialV2State(OTHER_PRIVATE);
    const feed = startMux(h);
    const sidOwner = await h.ensureSession(OWNER_KEY);
    const ownerToken = h.getSocialV2State(OWNER_KEY).agentToken;
    const st = h.getSocialV2State(OWNER_KEY);
    await h.handleIncoming('private', OWNER_QQ, ownerMessage('去给 999 发条消息'), h.cfg);
    const letterSeq = Number(h.ownerCrossSendV2.pending.seq);
    // 本用例要连做 4 次投递：把唤醒频率硬限制关掉，否则第 2 次起会被额度挡掉（那样测的就不是「不截胡」了）
    h.cfg.socialV2.wake = { ...(h.cfg.socialV2.wake ?? {}), maxWakePerMinute: 0, maxWakePerHour: 0 };
    const openedBefore = count(h.readLog(), /\[cross-session\] 授权窗口开启/g);
    const deliver = async (reason, seq) => {
      if (st.pendingWakeTimer) { clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null; }
      st.pendingWakeReason = null;
      st.pendingWakeSeq = null;
      // 上一次投递成功会派生 ② pendingWakeKeys（等那一轮收尾才清）；本用例要连做多次投递，
      // 所以每次都把它当作「上一轮已收尾」清掉，否则后续投递会被 busy 分支暂存而不是真的投递。
      h.pendingWakeKeys.clear();
      h.promptQueues.delete(OWNER_KEY);
      await h.sendWakePromptV2(OWNER_KEY, reason, seq === undefined ? {} : { seq });
      await sleep(60);
    };
    // ① 回复检查 / 主动检查：无 seq ⇒ 不兑现
    await deliver('replyCheck');
    assert.equal(h.ownerCrossSendV2.active, null, 'replyCheck 投递不得兑现名额（t30 的 O1）');
    await deliver('proactiveCheck');
    assert.equal(h.ownerCrossSendV2.active, null, 'proactiveCheck 投递不得兑现名额');
    // ② 带 seq 但不是这封来信：同样不兑现
    await deliver('private', letterSeq + 1);
    assert.equal(h.ownerCrossSendV2.active, null, '别的 seq 的唤醒不得兑现名额');
    // ③ 全程不得出现「授权窗口开启」，且此时仍必须 no-grant
    assert.equal(count(h.readLog(), /\[cross-session\] 授权窗口开启/g), openedBefore, '无关唤醒绝不该打授权开启日志');
    assert.ok(h.ownerCrossSendV2.pending, '名额必须仍在等着它自己的那次投递');
    const denied = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['截胡试试'], agentToken: ownerToken });
    assert.equal(denied.status, 403, `被截胡前必须仍是 no-grant：${denied.raw}`);
    // ④ 对照：承载来信的那次投递一到位就兑现
    await deliver('private', letterSeq);
    assert.ok(await waitTurnActive(h), '承载来信的投递必须兑现');
    const ok = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['该放行时放行'], agentToken: ownerToken });
    assert.equal(ok.status, 200, `承载来信的投递到位后必须放行：${ok.raw}`);
    console.log(`   [证据] replyCheck / proactiveCheck / 别的 seq（${letterSeq + 1}）三次投递：active 恒 null、授权开启日志 +0、代发 403；`
      + `换成承载来信的 seq=${letterSeq} 后：兑现 + 200`);
  });
});

// ══ 13. t61 上限不变：来信太旧（>30 分钟）⇒ 投递也不兑现，同一轮里仍是 no-grant ═════════════
await test('跨会话-13（t61）：墙钟上限仍是 30 分钟 —— 超龄来信即使被投递也不兑现', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    h.getSocialV2State(OTHER_PRIVATE);
    const feed = startMux(h);
    const sidOwner = await h.ensureSession(OWNER_KEY);
    const ownerToken = h.getSocialV2State(OWNER_KEY).agentToken;
    const st = h.getSocialV2State(OWNER_KEY);
    await h.handleIncoming('private', OWNER_QQ, ownerMessage('这条太旧了'), h.cfg);
    const letterSeq = Number(h.ownerCrossSendV2.pending.seq);
    h.ownerCrossSendV2.pending.at = Date.now() - h.CROSS_SESSION_GRANT_MS - 1000;   // 人为超龄（墙钟上限不变）
    if (st.pendingWakeTimer) { clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null; }
    st.pendingWakeReason = null;
    st.pendingWakeSeq = null;
    await h.sendWakePromptV2(OWNER_KEY, 'private', { seq: letterSeq });
    await sleep(80);
    assert.equal(h.ownerCrossSendV2.active, null, '超过 30 分钟的来信不得兑现');
    assert.equal(h.ownerCrossSendV2.pending, null, '超龄名额必须被消费掉（不能留着等下一封）');
    feed.push([turnStart(sidOwner, 5)]);
    await waitFor(() => h.v2TurnStartAt.has(sidOwner), 3000);
    const res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['超龄还想发'], agentToken: ownerToken });
    assert.equal(res.status, 403, `超龄授权必须回到 no-grant：${res.raw}`);
    assert.equal(h.calls.http.length, 0);
    assert.equal(h.CROSS_SESSION_GRANT_MS, 1800000, '墙钟上限必须仍是 30 分钟');
    console.log('   [证据] 人为把来信时间推早 30 分钟+1s ⇒ 投递不兑现（active=null）、名额被消费、随后同一轮代发 403；CROSS_SESSION_GRANT_MS=1800000');
  });
});

// ══ 14. t61 载荷性反证（变异体）：中和「投递时兑现」⇒ 驻留轮用例必须转红 ═══════════════════
/**
 * 与 t56 的 F4 同款：在**内存副本**里把「投递时兑现」那一行中和掉（仓库文件一字不动），
 * 再用**同一套断言**重跑驻留轮场景 —— 必须抛错，否则那组断言不是载荷的。
 * 说明：验收原文希望这条变异体加进 `scripts/verify-cross-session-send.mjs`（验证方文件），但该文件在
 * t61 的 outOfScope 里且被明令「不得改」，所以这里做等效反证（同一处变异点 + 同一套断言），并在报告里说明。
 */
function neutralizeDeliveryRedeem(source) {
  const needle = 'redeemOwnerCrossSendOnDeliveryV2(key, wakeSeq);';
  assert.ok(source.includes(needle), '（变异体）必须能在源码里定位「投递时兑现」那一行');
  // t66（A′）：兑现现在有两条路 —— 投递时、以及「来信自己的唤醒被繁忙暂存」时。要证明驻留轮场景的
  // 断言是载荷的，必须**两条一起中和**；只中和一条，另一条会把它救活。
  const stagedNeedle = 'if (ownerLetter) redeemOwnerCrossSendOnStagedWakeV2(key, wakeSeq);';
  assert.ok(source.includes(stagedNeedle), '（变异体）必须能定位「暂存即兑现」那一行（t66/A′）');
  return source
    .replace(needle, 'void 0; /* mutated: 投递时兑现被中和 */')
    .replaceAll(stagedNeedle, 'void 0; /* mutated: 暂存即兑现被中和 */');
}

await test('跨会话-14（t61 变异体反证）：中和「投递时兑现」⇒ 驻留轮场景必红', async () => {
  const h = await crossHarness({ transformSource: neutralizeDeliveryRedeem });
  const server = await listen(h.startConsoleServer());
  let error = null;
  try {
    const feed = startMux(h);
    await residentTurnScenario(h, server, feed);
  } catch (e) {
    error = e;
  } finally {
    await closeServer(server);
    await h.close();
  }
  assert.ok(error, '把「投递时兑现」中和掉之后，驻留轮场景必须转红（否则那些断言不是载荷的）');
  assert.match(String(error?.message ?? ''), /就地兑现|就该开窗/, `红的原因必须是「没有兑现」：${error?.message ?? error}`);
  console.log(`   [反证] 中和「投递时兑现」⇒ 驻留轮场景红：${String(error?.message ?? '').split('\n')[0].slice(0, 110)}`);
});

// ══ 15/16. t65（F2）：**真实定时器路径** —— 不手动调 sendWakePromptV2，让合并窗定时器自己投递 ════════
// 这两条用例存在的唯一理由：修复前「来信触发的排程没把 seq 传下去」⇒ pendingWakeSeq=null ⇒ 定时器回调
// 交出去的是 {seq:null} ⇒ 严格匹配失败 ⇒ 空闲路径**永远兑不了现**（t63-F1 的高危回归）。
// 之前的用例全是"手动注入 seq"，照不到这条 ⇒ 这里必须让 scheduleWakeV2 的定时器真的跑。
await test('跨会话-15（t65-F2①）：空闲来信 ⇒ 等合并窗定时器自然投递即兑现 → 同轮代发 200 + 审计行', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    h.getSocialV2State(OTHER_PRIVATE);
    const feed = startMux(h);
    const sidOwner = await h.ensureSession(OWNER_KEY);
    const ownerToken = h.getSocialV2State(OWNER_KEY).agentToken;
    const st = h.getSocialV2State(OWNER_KEY);
    st.wakeConfig.batchWindowMs = 1000;                       // 桥接把合并窗下限钳在 1000ms
    await h.handleIncoming('private', OWNER_QQ, ownerMessage('空闲路径：等定时器自然投递'), h.cfg);
    const letterSeq = Number(h.ownerCrossSendV2.pending.seq);
    assert.ok(Number.isFinite(letterSeq) && letterSeq > 0, `名额必须带来信 seq：${JSON.stringify(h.ownerCrossSendV2.pending)}`);
    assert.ok(st.pendingWakeTimer, '来信必须真的排上合并窗定时器');
    assert.equal(st.pendingWakeSeq, letterSeq, `定时器必须携带来信 seq（t65-F1 修复点）：实际 ${st.pendingWakeSeq}`);
    // 关键：**不手动调 sendWakePromptV2**，等定时器自己到点（合并窗 1s）
    assert.ok(await waitTurnActive(h, 5000), '合并窗定时器自然投递后必须立即兑现授权');
    const log = h.readLog();
    assert.match(log, new RegExp(`来源=owner-message@seq${letterSeq}`), `授权行必须写明承载它的 seq：${log}`);
    assert.match(log, /\[reserved2\] 唤醒 private:123（[a-zA-Z]+）/, '必须是真实唤醒投递路径（不是被忙暂存）');
    feed.push([turnStart(sidOwner, 1)]);                      // 投递时会话空闲 ⇒ turn/start 只接管这一轮
    assert.ok(await waitFor(() => h.v2TurnStartAt.has(sidOwner), 3000), 'owner 回合必须真的开起来');
    const res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['空闲路径的代发'], agentToken: ownerToken });
    assert.equal(res.status, 200, `空闲来信路径必须放行：${res.raw}`);
    assert.equal(res.data.sent, 1);
    const audit = (h.readLog().match(/\[cross-session\] 代发成功[^\n]*/g) ?? []).pop() ?? '';
    for (const re of [/授权人=123/, /来源=owner-message/, /目标=private:999/, /条数=1\/1/, /端点=/]) {
      assert.match(audit, re, `审计行缺字段 ${re}：${audit}`);
    }
    console.log(`   [证据] 空闲来信（seq=${letterSeq}）→ 合并窗定时器自然投递（pendingWakeSeq=${letterSeq}）→ active 兑现 → 同轮代发 200；审计行=${audit.slice(0, 110)}…`);
  });
});

await test('跨会话-16（t65-F2②）：忙时来信 ⇒ 暂存 → 真实重排（看门狗 re-arm 同路径）投递 ⇒ 兑现', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    h.getSocialV2State(OTHER_PRIVATE);
    const feed = startMux(h);
    const sidOwner = await h.ensureSession(OWNER_KEY);
    const ownerToken = h.getSocialV2State(OWNER_KEY).agentToken;
    const st = h.getSocialV2State(OWNER_KEY);
    st.wakeConfig.batchWindowMs = 1000;
    feed.push([turnStart(sidOwner, 1)]);
    assert.ok(await waitFor(() => h.v2TurnStartAt.has(sidOwner), 3000), 'T1 必须真的在跑');
    await h.handleIncoming('private', OWNER_QQ, ownerMessage('忙时来信'), h.cfg);
    // t66（A′）：忙时来信在「暂存那一刻」就兑现了名额 ⇒ 序号可能已在 active 上，不再留在 pending。
    const letterSeq = Number((h.ownerCrossSendV2.pending ?? h.ownerCrossSendV2.active).seq);
    assert.match(h.readLog(), /会话繁忙，暂存唤醒原因 private:123/, '忙时来信的唤醒必须被暂存');
    const backlog = (st.pendingWakeReasons ?? []).find((r) => r && r.seq === letterSeq);
    assert.ok(backlog, `backlog 里必须有带来信 seq 的那条：${JSON.stringify(st.pendingWakeReasons)}`);
    // 看门狗 re-arm 的同款路径：释放 ④（C-stall/看门狗 release 会清）→ 用 backlog 的 seq 真实重排
    h.v2TurnStartAt.delete(sidOwner);
    h.collectors.delete(sidOwner);
    st.pendingWakeReasons = [];
    await h.scheduleWakeV2(OWNER_KEY, 'private', { seq: backlog.seq });
    assert.equal(st.pendingWakeSeq, backlog.seq, '真实重排必须把 backlog 的 seq 带进定时器');
    assert.ok(await waitTurnActive(h, 5000), '真实重排投递后必须兑现（不需要新的 turn/start）');
    const res = await sendMessage(server, { key: OTHER_PRIVATE, messages: ['重排后的代发'], agentToken: ownerToken });
    assert.equal(res.status, 200, `重排投递后必须放行：${res.raw}`);
    console.log(`   [证据] 忙时来信（seq=${letterSeq}）→ 暂存 backlog → 真实重排（seq=${backlog.seq}）→ 定时器投递 → 兑现 → 代发 200 sent=${res.data.sent}`);
  });
});

// ══ 17. t82 窄豁免：任何会话的合法令牌 → 主人私聊；其它跨会话目标照旧 403 ═══════════════
// 用户诉求（2026-10-08）：预设要求「敏感/不适内容不往群里带、但可以私下告诉主人」，唤醒提示也已经把
// 主人私聊 key（private:<ownerQQ>）交给模型；但发送层的跨会话授权只认「owner 令牌 + 管理员来信那轮」
// ⇒ 群会话回合里想私聊主人会吃 403「agent token 无效」。这里加一条**更窄**的豁免：令牌仍必须是
// 该会话的真实令牌，目标必须**逐字等于**主人私聊 key，别的跨会话目标一行都不放宽。
await test('跨会话-17（t82）：群会话令牌 → 主人私聊 ⇒ 200 + 真发 + [cross-send→owner]；私聊/别的群/无令牌/假令牌照旧 403', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    await h.ensureSession(OWNER_KEY);
    const sidGroup = await h.ensureSession(OTHER_GROUP);
    await h.ensureSession(OTHER_PRIVATE);
    const groupToken = h.getSocialV2State(OTHER_GROUP).agentToken;
    const otherToken = h.getSocialV2State(OTHER_PRIVATE).agentToken;
    const ownerToken = h.getSocialV2State(OWNER_KEY).agentToken;
    const feed = startMux(h);
    feed.push([turnStart(sidGroup, 1)]);
    assert.ok(await waitFor(() => h.v2TurnStartAt.has(sidGroup), 4000), '群会话回合必须真的开始');
    // 前提：本用例**刻意不制造任何 A′ 授权**（没有管理员来信、没有 owner 回合）—— 窄豁免独立于 A′
    assert.equal(h.ownerCrossSendV2.pending, null, '本用例刻意不登记 A′ 名额');
    assert.equal(h.ownerCrossSendV2.active, null, '本用例刻意不开启 A′ 窗口');
    const groupSt = h.getSocialV2State(OTHER_GROUP);
    const ownerSt = h.getSocialV2State(OWNER_KEY);
    const groupBudgetBefore = groupSt.sendTimes.length;
    const ownerBudgetBefore = ownerSt.sendTimes.length;
    // ① 正例：群会话令牌 → 主人私聊 key ⇒ 放行，而且真的走 OneBot 发出
    let res = await sendMessage(server, { key: OWNER_KEY, messages: ['【豁免自检】群会话 → 私聊主人'], agentToken: groupToken });
    assert.equal(res.status, 200, `群会话私聊主人必须放行：${res.raw}`);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.sent, 1);
    const sends = onebotSends(h, 'send_private_msg');
    assert.equal(sends.length, 1, '必须真的走 OneBot 发送链路');
    assert.equal(Number(sends[0].body.user_id), OWNER_QQ, `目标必须恰是主人的私聊：${JSON.stringify(sends[0].body)}`);
    assert.ok(sentText(h, 'send_private_msg').includes('豁免自检'), `发送内容必须原样：${sentText(h, 'send_private_msg')}`);
    // ② 审计：bridge.log 与活动日志都要带可辨识标记（来源会话 = 谁私聊了主人）
    const audit = (h.readLog().match(/\[cross-session\] \[cross-send→owner\][^\n]*/g) ?? []).pop() ?? '';
    assert.match(audit, /豁免代发成功/, `豁免发送必须留痕：${audit}`);
    assert.match(audit, /来源=group:456/, `留痕必须写明来源会话：${audit}`);
    assert.match(audit, new RegExp(`目标=${OWNER_KEY}`), `留痕必须写明目标：${audit}`);
    assert.match(audit, /端点=\/api\/socialV2\/send-message/, `留痕必须写明端点：${audit}`);
    const activity = fs.readFileSync(path.join(h.temp, 'state', 'qq-activity.log'), 'utf8');
    assert.match(activity, /\[cross-send→owner\]/, `活动日志必须带同一标记：${activity.slice(-300)}`);
    assert.ok(activity.includes('来源=group:456'), `活动日志必须写明来源会话：${activity.slice(-300)}`);
    // ③ 限频账记在**来源会话**上（群里的频率上限照样管得住它），不记到目标（主人）头上
    assert.equal(groupSt.sendTimes.length, groupBudgetBefore + 1, '豁免发送必须计入来源会话的发送预算');
    assert.equal(ownerSt.sendTimes.length, ownerBudgetBefore, '不得把豁免发送记到目标会话的账上');
    // ④ 负例：其它跨会话目标一律照旧 403「agent token 无效」，且一条都不许发出
    const httpBefore = h.calls.http.length;
    for (const [key, label] of [[OTHER_PRIVATE, '别的私聊'], ['group:987', '别的群'], [OUT_PRIVATE, '不存在的私聊']]) {
      const denied = await sendMessage(server, { key, messages: ['别的目标'], agentToken: groupToken });
      assert.equal(denied.status, 403, `${label}（${key}）必须照旧 403：${denied.raw}`);
      assert.match(String(denied.data.error), /agent token 无效|目标不在当前模式允许范围内/, `${label} 的拒因：${denied.raw}`);
    }
    assert.equal(h.calls.http.length, httpBefore, '负例绝不能发出任何 QQ 消息');
    // ⑤ 无令牌 / 伪造令牌：窄豁免不是「无令牌也能发」的口子
    const noToken = await agentRequest(server, { pathname: '/api/socialV2/send-message', body: { key: OWNER_KEY, messages: ['无令牌'] } });
    assert.equal(noToken.status, 403, `无令牌必须 403：${noToken.raw}`);
    assert.match(String(noToken.data?.error), /必须携带 agent token/, `无令牌的拒因：${noToken.raw}`);
    const forged = await sendMessage(server, { key: OWNER_KEY, messages: ['假令牌'], agentToken: 'not-a-real-token' });
    assert.equal(forged.status, 403, `伪造令牌必须 403：${forged.raw}`);
    // ⑥ 「任何会话」都行：别的私聊令牌同样可以私聊主人；主人自己发自己走原同会话路径（不算豁免）
    res = await sendMessage(server, { key: OWNER_KEY, messages: ['私聊会话令牌 → 主人'], agentToken: otherToken });
    assert.equal(res.status, 200, `别的私聊令牌也要能私聊主人：${res.raw}`);
    const ownerSelf = await sendMessage(server, { key: OWNER_KEY, messages: ['主人给自己'], agentToken: ownerToken });
    assert.equal(ownerSelf.status, 200, `owner 发自己走原同会话路径：${ownerSelf.raw}`);
    assert.equal(count(h.readLog(), /\[cross-send→owner\]/g), 2, '只有两次真的走了窄豁免（owner 自己发自己不算跨会话）');
    assert.equal(onebotSends(h, 'send_private_msg').length, 3, '正例 + 别的私聊 + owner 自己 = 3 条');
    console.log(`   [证据] 群令牌 → ${OWNER_KEY} = 200（OneBot user_id=${sends[0].body.user_id}）；别的私聊/别的群/白名单外/无令牌/假令牌 = 403；`
      + `预算：来源 ${OTHER_GROUP} +1、目标（主人）+0；审计=${audit.slice(0, 90)}…；活动日志含同一标记`);
  });
});

// ══ 18. t82：豁免发送吃**来源会话**的频率上限（超限 429），失败要回滚预占 ═══════════════
await test('跨会话-18（t82）：频率上限对豁免发送生效（超限 429 且不发出）+ 400 路径回滚来源会话的预占额度', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    await h.ensureSession(OWNER_KEY);
    await h.ensureSession(OTHER_GROUP);
    const groupToken = h.getSocialV2State(OTHER_GROUP).agentToken;
    const groupSt = h.getSocialV2State(OTHER_GROUP);
    const ownerSt = h.getSocialV2State(OWNER_KEY);
    const maxPerMinute = Number(h.cfg.socialV2?.send?.maxSendPerMinute) || 0;
    assert.equal(maxPerMinute, 3, `（前置）本用例把来源会话上限配成 3，实测 ${maxPerMinute}`);
    // ① 来源会话额度用满 ⇒ 豁免发送必须 429（群里的频率上限管得住它），且一条都不发
    groupSt.sendTimes = Array.from({ length: maxPerMinute }, () => Date.now());
    let res = await sendMessage(server, { key: OWNER_KEY, messages: ['超限还想私聊主人'], agentToken: groupToken });
    assert.equal(res.status, 429, `超限必须 429：${res.raw}`);
    assert.match(String(res.data.error), /发送频率超限/, `429 的拒因：${res.raw}`);
    assert.equal(onebotSends(h, 'send_private_msg').length, 0, '超限时绝不能发出消息');
    assert.equal(groupSt.sendTimes.length, maxPerMinute, '被拒时不得改动额度账本');
    // ② 让出一格 ⇒ 放行，且预占记在来源会话（主人账本原封不动）
    groupSt.sendTimes = groupSt.sendTimes.slice(0, maxPerMinute - 1);
    res = await sendMessage(server, { key: OWNER_KEY, messages: ['让出一格后私聊主人'], agentToken: groupToken });
    assert.equal(res.status, 200, `让出一格后必须放行：${res.raw}`);
    assert.equal(groupSt.sendTimes.length, maxPerMinute, '放行的预占必须 +1 记在来源会话');
    assert.equal(ownerSt.sendTimes.length, 0, '目标（主人）的额度账本必须原封不动');
    // ③ 失败回滚：引用一条解析不出来的消息 ⇒ 400，预占的**来源会话**额度必须回滚（不留假 429）
    groupSt.sendTimes = groupSt.sendTimes.slice(0, maxPerMinute - 1);   // 先让出一格，免得 400 之前先吃 429
    const before = groupSt.sendTimes.length;
    res = await agentRequest(server, {
      pathname: '/api/socialV2/send-message',
      body: { key: OWNER_KEY, messages: ['引用不存在的消息'], replyToMessageId: '987654321' },
      agentToken: groupToken,
    });
    assert.equal(res.status, 400, `无法解析的引用必须 400：${res.raw}`);
    assert.equal(groupSt.sendTimes.length, before, '400 路径必须回滚预占的来源会话额度');
    assert.equal(onebotSends(h, 'send_private_msg').length, 1, '整条用例只允许真的发出 1 条（就是那条让出一格后的自检）');
    console.log('   [证据] 来源额度=3/3 ⇒ 429（OneBot=0、账本不变）→ 让出 1 格 ⇒ 200（来源 +1、主人 0）→ 引用解析失败 400 ⇒ 回滚（来源账本回到预占前）');
  }, { socialV2: { send: { maxSendPerMinute: 3 } } });
});

// ══ 19. t82：窄豁免挂在**发送路径这一类**上 —— 另外两个发送端点同规则 ══════════════════
await test('跨会话-19（t82）：/api/send/private 与 /api/socialV2/send-burst 同样支持「→ 主人私聊」窄豁免', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    await h.ensureSession(OWNER_KEY);
    await h.ensureSession(OTHER_GROUP);
    const groupToken = h.getSocialV2State(OTHER_GROUP).agentToken;
    // 旧发送端点（body.token + x-agent-token 头）：群令牌 → 主人私聊 ⇒ 200
    let res = await agentRequest(server, {
      pathname: '/api/send/private', body: { token: groupToken, userId: String(OWNER_QQ), message: '走老端点私聊主人' }, agentToken: groupToken,
    });
    assert.equal(res.status, 200, `老端点的窄豁免必须放行：${res.raw}`);
    assert.equal(res.data.ok, true);
    // 分条端点：群令牌 → 主人私聊 ⇒ 200 sent=2
    res = await agentRequest(server, {
      pathname: '/api/socialV2/send-burst',
      body: { key: OWNER_KEY, messages: ['第一条', '第二条'], gapMode: 'fixed', gapMs: 100 },
      agentToken: groupToken,
    });
    assert.equal(res.status, 200, `send-burst 的窄豁免必须放行：${res.raw}`);
    assert.equal(res.data.sent, 2);
    assert.equal(count(h.readLog(), /\[cross-session\] \[cross-send→owner\] 豁免代发成功/g), 2, '两个端点各留 1 行豁免审计');
    // 老端点上的**别的目标**照旧不放宽：群令牌 + 白名单内他人私聊 ⇒ 403「agent token 无效」
    // （白名单闸门本身由跨会话-5 与老端点既有用例覆盖；这里证明窄豁免只认主人私聊这一个 key）
    res = await agentRequest(server, {
      pathname: '/api/send/private', body: { token: groupToken, userId: '999', message: '老端点打别人' }, agentToken: groupToken,
    });
    assert.equal(res.status, 403, `别的目标必须照旧 403：${res.raw}`);
    assert.match(String(res.data.error), /agent token 无效|目标不在当前模式允许范围内/, `拒因：${res.raw}`);
    assert.equal(onebotSends(h, 'send_private_msg').length, 3, '只有两条豁免 + 一条老端点正例真的发出');
    console.log('   [证据] /api/send/private=200、send-burst=200(sent=2)、两个端点各 1 行 [cross-send→owner]；老端点打别人仍 403');
  });
});

if (failures) {
  console.error(`\n❌ 跨会话发送测试失败 ${failures} 项`);  process.exit(1);
}
console.log('\n🎉 跨会话发送（t29）聚焦测试全部通过');
