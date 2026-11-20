// Codex m05450：「先就全局有界+拒绝新增、分层软配额与**实际错误可观察性**离线比较」。
//
// 策略对比在 `scripts/qzone-positions-options-probe.mjs` 已经做了（A/B/C 三选）。
// 这一支只回答后半句：**今天到底能观察到什么**。
//
// 做法：对「一次空间调用被拒」的五种成因，各跑一遍真实插件路径，然后把
// `status()` 的全部对外字段与派发返回值逐个对比。凡是五种成因读数相同的字段，
// 就是「观察不到」的证据 —— 这比任何设计意见都硬。
//
// 关键装置约束（踩过两次，都会得到「五条成因完全一致」的假结论）：
//   1. 注入契约是 `{ dispatch, epoch, sourceLifetime, defineTool }`，不是 `{ runtime }`；
//      传错键会被静默忽略，handle 停在 `enabled-awaiting-runtime`，全部 `dispatch-unavailable`。
//   2. `agent/created` 载荷是 `{ agent: { id, session: { id }, ctx } }`；扁平形状静默忽略，
//      adapter 不装 ⇒ `agentAdapters: 0` ⇒ 全部 `origin-unbound`。
//   3. **不要手动调 `ledger.observeToolCall`**：pre-step adapter 在 `session/event` 上
//      已经替我们调了。再调一次，同一个 callId 第二次会被 `spentCalls` 判为重复并投毒，
//      于是健康的调用也返回 `origin-unbound`。
//
// 只读：假 ctx / 假 store / 假 transport，主树零字节改动。
import { createQzonePluginHandle, MAX_POSITIONS } from '../plugins/qzone-safe/index.mjs';
import { createQzoneSourceLifetime } from '../src/core/qzone-source-lifetime-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

const SESSION = 'sess-obs';
const OTHER = 'sess-other';
const DAY = Date.parse('2026-11-11T04:00:00Z');
const FRIEND = 456;
const BOT = 111;

const userMessage = (rpcId) => ({ role: 'user', source: { rpcId } });

function fakeStore() {
  let state = {
    enabled: true, readAllowed: true, writeAllowed: false,
    accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: false },
    reads: 0, writes: 0,
    readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-11', todayBrowses: 0, lastBrowseAt: null,
    usedOpportunities: {}, activeStart: 0, activeEnd: 1439, audit: [],
  };
  return { read: () => structuredClone(state), update(fn) { state = fn(structuredClone(state)); return state; }, dump: () => structuredClone(state) };
}

function makeHost() {
  const listeners = new Map();
  const tools = {};
  const ctx = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => { const arr = listeners.get(name) ?? []; const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };
    },
    tools: {
      register(tool) {
        if (tool && typeof tool.name === 'string') tools[tool.name] = tool;
        return () => { if (tool?.name) delete tools[tool.name]; };
      },
    },
  };
  return {
    ctx,
    tools,
    emit(name, ...args) { for (const fn of listeners.get(name) ?? []) fn(...args); },
  };
}

let turnCounter = 0;

async function makeWorld({ trackingLimit = 64 } = {}) {
  const lifetime = createQzoneSourceLifetime({ sessionLimit: 4, trackingLimit });
  const store = fakeStore();
  const host = makeHost();
  let connectionEpoch = 1;
  const call = async (action) => {
    if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: BOT } };
    if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: FRIEND }] };
    if (action === 'get_qzone_msg_list') return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
    throw new Error(`unexpected ${action}`);
  };
  const runtime = createQzoneRuntime({
    store, botQq: BOT,
    sourceEpoch: lifetime.sourceEpoch(),
    authorizeSource: (c) => lifetime.ownsConsumption(c),
    getConnectionEpoch: () => connectionEpoch,
    getBridgeSessions: () => lifetime.getLedger(SESSION),
    clock: () => DAY, mode: 'read-only', trackingLimit, call,
  });
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    dispatch: runtime.dispatch,
    epoch: lifetime.sourceEpoch(),
    sourceLifetime: lifetime,
    defineTool: (tool) => tool,
  });
  host.emit('agent/created', { agent: { id: 'agent-1', session: { id: SESSION }, ctx: host.ctx } });
  return { lifetime, store, host, handle };
}

const execFor = (sessionId, callId) => ({ agent: { session: { id: sessionId } }, callId });

// 唯一真实路径：SSE announce（适配器据此 observeToolCall，插件据此写 positions）
const announce = (world, sessionId, callId, { turn = 1, step = 1, name = 'qzone_read_posts' } = {}) =>
  world.host.emit('session/event', { id: sessionId }, { type: 'tool/call', data: { turn, step, callId, name } });

async function dispatchRead(world, sessionId, callId) {
  const tool = world.host.tools.qzone_read_posts;
  if (!tool) return { ok: false, error: 'tool-not-registered(probe)' };
  return tool.execute({ target_uin: FRIEND }, execFor(sessionId, callId));
}

const out = {};

// ---- 成因 0（正向对照）：位置已 announce、账本已绑定、回合干净 —— 必须 success ----
// 没有这一条，后面五条全是 `origin-unbound` 也可能只是装置没接对。
{
  const world = await makeWorld();
  const ledger = world.lifetime.getLedger(SESSION);
  turnCounter += 1;
  const turn = turnCounter;
  const callId = 'call-healthy';
  ledger.registerBridgeRequest({ requestId: `rid-0-${turn}`, origin: 'qq-inbound' });
  ledger.observeStep({ sessionId: SESSION, turn, step: 1, messages: [userMessage(`rid-0-${turn}`)] });
  announce(world, SESSION, callId, { turn });
  const result = await dispatchRead(world, SESSION, callId);
  out.cause0_healthyControl = { result, status: world.handle.status(SESSION) };
}

// ---- 成因 1：位置从未 announce ----
{
  const world = await makeWorld();
  const ledger = world.lifetime.getLedger(SESSION);
  turnCounter += 1;
  const turn = turnCounter;
  const callId = 'call-never-announced';
  ledger.registerBridgeRequest({ requestId: `rid-1-${turn}`, origin: 'qq-inbound' });
  ledger.observeStep({ sessionId: SESSION, turn, step: 1, messages: [userMessage(`rid-1-${turn}`)] });
  const result = await dispatchRead(world, SESSION, callId);
  out.cause1_neverAnnounced = { result, status: world.handle.status(SESSION) };
}

// ---- 成因 2：位置属于别的会话 ----
{
  const world = await makeWorld();
  turnCounter += 1;
  const turn = turnCounter;
  const callId = 'call-other-session';
  announce(world, OTHER, callId, { turn });            // 位置落在 OTHER 名下
  const ledger = world.lifetime.getLedger(SESSION);
  ledger.registerBridgeRequest({ requestId: `rid-2-${turn}`, origin: 'qq-inbound' });
  ledger.observeStep({ sessionId: SESSION, turn, step: 1, messages: [userMessage(`rid-2-${turn}`)] });
  const result = await dispatchRead(world, SESSION, callId);   // 从 SESSION 派发
  out.cause2_otherSession = { result, status: world.handle.status(SESSION) };
}

// ---- 成因 3：位置被容量淘汰（4096 个**活**位置之后，最老的那个被挤掉）----
// 注意必须让 filler 也是活的：`evictOnePosition` 优先淘汰死位置，如果 filler 是死的，
// 被淘汰的永远是 filler，待派发的那个反而安然无恙（这就是我第一版的错误结论来源）。
// 活 filler 需要：同一回合同一 step 内多个 callId，且账本为它们各绑一次 —— 由
// pre-step adapter 在 `session/event` 上自动完成，所以只要 announce 就会绑。
{
  const world = await makeWorld({ trackingLimit: MAX_POSITIONS });
  const ledger = world.lifetime.getLedger(SESSION);
  turnCounter += 1;
  const turn = turnCounter;
  const pendingCallId = 'call-pending-live';
  ledger.registerBridgeRequest({ requestId: `rid-3-${turn}`, origin: 'qq-inbound' });
  ledger.observeStep({ sessionId: SESSION, turn, step: 1, messages: [userMessage(`rid-3-${turn}`)] });
  announce(world, SESSION, pendingCallId, { turn });          // 1 条：最早入表、活的
  for (let i = 0; i < MAX_POSITIONS - 1; i += 1) {            // 4095 条：同样是活位置
    announce(world, SESSION, `filler-${i}`, { turn });        //（同一步内各绑一次，共 4096）
  }
  const statusFull = world.handle.status(SESSION);            // 表恰好满 4096，尚无淘汰
  announce(world, SESSION, 'filler-overflow', { turn });       // 第 4097 条触发淘汰
  const statusBefore = world.handle.status(SESSION);
  const result = await dispatchRead(world, SESSION, pendingCallId);
  out.cause3_evicted = {
    result,
    status: world.handle.status(SESSION),
    evictionCounterBeforeDispatch: statusBefore.positionsEvictedLive,
    fullAt: statusFull.positionsEvictedLive,
    fillerAllLive: true,
  };
}

// ---- 成因 4：账本从未绑定（位置在，但 observeStep 没跑到 ⇒ 没有 requestId 归属）----
{
  const world = await makeWorld();
  turnCounter += 1;
  const turn = turnCounter;
  const callId = 'call-position-only';
  announce(world, SESSION, callId, { turn });          // 只有位置，账本完全没记账
  const result = await dispatchRead(world, SESSION, callId);
  out.cause4_ledgerNeverBound = { result, status: world.handle.status(SESSION) };
}

// ---- 成因 5：回合被投毒（同回合两个 requestId）----
{
  const world = await makeWorld();
  const ledger = world.lifetime.getLedger(SESSION);
  turnCounter += 1;
  const turn = turnCounter;
  const callId = 'call-tainted';
  ledger.registerBridgeRequest({ requestId: `rid-5a-${turn}`, origin: 'qq-inbound' });
  ledger.registerBridgeRequest({ requestId: `rid-5b-${turn}`, origin: 'qq-inbound' });
  ledger.observeStep({ sessionId: SESSION, turn, step: 1, messages: [userMessage(`rid-5a-${turn}`)] });
  ledger.observeStep({ sessionId: SESSION, turn, step: 2, messages: [userMessage(`rid-5b-${turn}`)] });
  announce(world, SESSION, callId, { turn });
  const result = await dispatchRead(world, SESSION, callId);
  out.cause5_taintedTurn = { result, status: world.handle.status(SESSION) };
}

// ---- 汇总：五种成因的可观测面差异 ----
{
  const causes = ['cause1_neverAnnounced', 'cause2_otherSession', 'cause3_evicted', 'cause4_ledgerNeverBound', 'cause5_taintedTurn'];
  const rows = causes.map((k) => ({
    cause: k,
    error: out[k]?.result?.error ?? null,
    reason: out[k]?.result?.reason ?? null,
  }));
  const errorCodes = new Set(rows.map((r) => r.error));
  const counters = ['positionsEvictedLive', 'stepsRefused', 'adaptersDisconnected', 'adaptersFailed', 'agentAdapters', 'dispatchAvailable', 'staleGenerationObserved'];
  const counterTable = {};
  for (const field of counters) {
    const values = causes.map((k) => out[k]?.status?.[field] ?? null);
    counterTable[field] = { values, distinguishes: new Set(values.map(String)).size > 1 };
  }
  const distinguishingCounters = Object.entries(counterTable).filter(([, v]) => v.distinguishes).map(([k]) => k);
  out.observability_matrix = {
    healthyControlWorks: out.cause0_healthyControl.result?.ok === true,
    rows,
    distinctErrorCodes: [...errorCodes],
    sameErrorCodeForEveryCause: errorCodes.size === 1,
    counterTable,
    distinguishingCounters,
    anyCounterDistinguishes: distinguishingCounters.length > 0,
    verdict: errorCodes.size !== 1
      ? 'CODES_DIFFER'
      : distinguishingCounters.length === 0
        ? 'ONE_CODE_AND_NO_COUNTER'
        : 'ONE_CODE_ONE_AGGREGATE_COUNTER',
    note: '五条成因共用 `origin-unbound` 一个码。唯一能区分的是 positionsEvictedLive，且它只在「淘汰活位置」时 +1：'
      + '它是聚合量、不带 callId、不带代际、也不告诉 owner 死的是哪一次调用。'
      + '所以「位置被淘汰」可以事后从计数上看出「发生过 N 次」，但无法与任何一次具体的失败对应起来 —— '
      + '对 owner 来说，用户看到的那条 `origin-unbound` 仍然与另外四种成因不可区分。',
  };
}

console.log(JSON.stringify(out, null, 2));
