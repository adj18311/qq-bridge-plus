// 只读探针：agent 被 dispose 之后，同一个 session 重新 created 还能不能派发？
//
// 这条路径在日常里很常见：DSH 在会话恢复 / 重新进入会话时会重建 agent。
// 如果 `agent/disposed` → `adapter.dispose()` → `ledger.disconnect()` 把账本打成
// `continuityLost`，而 `ledgers` 里缓存的那本仍然是同一个对象，那么新 agent 拿到的
// 就是一本永久失效的账本 —— 用户看到的是「恢复会话后空间工具全废」，且没有任何
// 计数器或错误码能说明原因。
//
// 主树零字节改动：假 ctx / 假 store / 假 transport。
import { createQzonePluginHandle } from '../plugins/qzone-safe/index.mjs';
import { createQzoneSourceLifetime } from '../src/core/qzone-source-lifetime-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

const SESSION = 'sess-resume';
const DAY = Date.parse('2026-11-11T04:00:00Z');
const BOT = 111;
const FRIEND = 456;
const um = (rpcId) => ({ role: 'user', source: { rpcId } });
const execFor = (sid, cid) => ({ agent: { session: { id: sid } }, callId: cid });

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
  return { read: () => structuredClone(state), update(fn) { state = fn(structuredClone(state)); return state; } };
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
    tools: { register(tool) { if (tool?.name) tools[tool.name] = tool; return () => { delete tools[tool.name]; }; } },
  };
  return { ctx, tools, emit(name, ...a) { for (const fn of listeners.get(name) ?? []) fn(...a); } };
}

// agent 自己的 ctx：pre-step 由 adapter 挂在它上面
function agentCtx() {
  const map = new Map();
  return {
    on(name, fn) {
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(fn);
      return () => {};
    },
    fire(name, payload) { for (const fn of map.get(name) ?? []) fn(payload, () => {}); },
  };
}

let turn = 0;

async function world() {
  const lifetime = createQzoneSourceLifetime({ sessionLimit: 4, trackingLimit: 64 });
  const store = fakeStore();
  const host = makeHost();
  const connectionEpoch = { value: 1 };
  const call = async (action) => {
    if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: BOT } };
    if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: FRIEND }] };
    if (action === 'get_qzone_msg_list') return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
    throw new Error(`unexpected ${action}`);
  };
  const runtime = createQzoneRuntime({
    store, botQq: BOT, sourceEpoch: lifetime.sourceEpoch(),
    authorizeSource: (c) => lifetime.ownsConsumption(c),
    getConnectionEpoch: () => connectionEpoch.value,
    getBridgeSessions: () => lifetime.getLedger(SESSION),
    clock: () => DAY, mode: 'read-only', trackingLimit: 64, call,
  });
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    dispatch: runtime.dispatch, epoch: lifetime.sourceEpoch(),
    sourceLifetime: lifetime, defineTool: (tool) => tool,
  });
  return { lifetime, host, handle, store };
}

async function oneRead(w, agent, { callId, requestId }) {
  turn += 1;
  const t = turn;
  try {
    w.handle.registerBridgeRequest(SESSION, { requestId, origin: 'qq-inbound' });
  } catch (error) {
    return { turn: t, registrationThrew: error.message, result: null, status: w.handle.status(SESSION) };
  }
  agent.ctx.fire('agent/pre-step', { turn: t, step: 1, messages: [um(requestId)] });
  agent.ctx.fire('session/event', { id: SESSION }, { type: 'tool/call', data: { turn: t, step: 1, callId, name: 'qzone_read_posts' } });
  w.host.emit('session/event', { id: SESSION }, { type: 'tool/call', data: { turn: t, step: 1, callId, name: 'qzone_read_posts' } });
  const result = await w.host.tools.qzone_read_posts.execute({ target_uin: FRIEND }, execFor(SESSION, callId));
  return { turn: t, result, status: w.handle.status(SESSION) };
}

const out = {};
const w = await world();

// agent A：正常建、正常读一次
const agentA = { id: 'agent-A', ctx: agentCtx() };
w.host.emit('agent/created', { agent: { id: agentA.id, session: { id: SESSION }, ctx: agentA.ctx } });
out.beforeDispose = await oneRead(w, agentA, { callId: 'call-1', requestId: 'rid-1' });

// 模拟 DSH 的会话恢复：agent 被 dispose，随后同 session 重新 created
w.host.emit('agent/disposed', { agent: { id: agentA.id, session: { id: SESSION } } });
const statusAfterDispose = w.handle.status(SESSION);

const agentB = { id: 'agent-B', ctx: agentCtx() };
w.host.emit('agent/created', { agent: { id: agentB.id, session: { id: SESSION }, ctx: agentB.ctx } });
const statusAfterResume = w.handle.status(SESSION);
out.afterResume = await oneRead(w, agentB, { callId: 'call-2', requestId: 'rid-2' });

// 账本本身的状态（直接问 lifetime，不看插件）
const ledger = w.lifetime.getLedger(SESSION);
out.ledgerDirect = {
  registrationAccepted: (() => {
    try { ledger.registerBridgeRequest({ requestId: 'rid-probe', origin: 'qq-inbound' }); return true; }
    catch (error) { return `threw: ${error.message}`; }
  })(),
  peekExistingCall: ledger.peekCall('call-2'),
};

out.statusAfterDispose = statusAfterDispose;
out.statusAfterResume = statusAfterResume;
out.verdict = {
  readBeforeDisposeSucceeded: out.beforeDispose.result?.ok === true,
  readAfterResumeSucceeded: out.afterResume.result?.ok === true,
  // 关键判据：恢复后是否还能派发
  resumeHeals: out.afterResume.result?.ok === true,
  adaptersDisconnected: statusAfterResume.adaptersDisconnected,
  dispatchAvailableAfterResume: statusAfterResume.dispatchAvailable,
  dispatchableSessionsAfterResume: statusAfterResume.dispatchableSessions,
};

console.log(JSON.stringify(out, null, 2));
