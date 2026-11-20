import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { loadHostToolRuntime } from './host-tool-runtime-fixture.mjs';
import { createQzonePluginHandle as apply, MAX_POSITIONS, STATES } from '../plugins/qzone-safe/index.mjs';
import { QZONE_MCP_TOOLS } from '../src/core/qzone-mcp-contract.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';
import { createQzoneSourceLifetime } from '../src/core/qzone-source-lifetime-offline.mjs';

const ASAR = process.env.DSH_ASAR || 'D:/DSH Desktop/resources/app.asar';
const TOOL_NAMES = Object.keys(QZONE_MCP_TOOLS).map((action) => `qzone_${action}`);

// Real DSH Cordis Context + real ToolRuntime from app.asar. Subscriptions are
// counted by wrapping only `on`; the ctx itself and ToolRuntime are the real ones.
async function realHost(t) {
  if (!fs.existsSync(ASAR)) {
    t.skip(`no DSH asar at ${ASAR}`);
    return null;
  }
  const host = await loadHostToolRuntime({ asarPath: ASAR });
  const { Context, Service, ToolRuntime } = host;
  class FakePrompt extends Service {
    constructor(ctx) { super(ctx, 'systemPrompt', true); }
    tools() { return { dispose() {} }; }
    section() { return { dispose() {} }; }
    getSectionOrder() { return 0; }
  }
  const root = new Context();
  root.plugin(FakePrompt);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const runtime = new ToolRuntime(root, { mode: 'native' });
  const counter = { subscriptions: 0 };
  const localListeners = new Map();
  const spyCtx = {
    tools: runtime,
    on(event, listener, options) {
      counter.subscriptions += 1;
      const list = localListeners.get(event) ?? [];
      list.push(listener);
      localListeners.set(event, list);
      return root.on(event, listener, options);
    },
  };
  // `agent/created` is what installs the pre-step adapter; dispatch cannot bind a
  // single `tool/call` without it, so tests that assert a truly ready handle must
  // simulate one agent the way the host does.
  const emitAgent = (sessionId = 'session-entry-1', agentId = 'agent-entry-1') => {
    for (const listener of localListeners.get('agent/created') ?? []) {
      listener({ agent: { id: agentId, session: { id: sessionId }, ctx: { on: () => () => {} } } });
    }
  };
  return { host, root, runtime, spyCtx, counter, emitAgent, defineTool: host.defineContentToolFixture };
}

const exec = { agent: { session: { id: 'session-entry-1' } }, callId: 'call-entry-1' };

test('插件来源账本达到会话上限时拒绝新增，不清空旧账本', async () => {
  const ctx = { on() { return () => {}; }, tools: { register() { return () => {}; } } };
  const handle = await apply(ctx, { enabled: true }, { epoch: 'fixture', defineTool: (x) => x,
    dispatch: async () => ({ ok: true }) });
  // 4096 here is the *session-ledger* cap (`MAX_SESSIONS` in
  // plugins/qzone-safe/index.mjs), a different constant from `MAX_POSITIONS`.
  // Round-3 review N2 flagged this as a look-alike magic number; it is not a copy
  // of MAX_POSITIONS and must not be "deduplicated" into one.
  for (let i = 0; i < 4096; i++) handle.registerBridgeRequest(`s${i}`, { requestId: `r${i}`, origin: 'qq-inbound' });
  assert.throws(() => handle.registerBridgeRequest('overflow', { requestId: 'r', origin: 'qq-inbound' }));
  assert.throws(() => handle.registerBridgeRequest('s0', { requestId: 'r0', origin: 'qq-inbound' }), /重复/);
  await handle.dispose();
});

test('默认关闭：未显式 enabled 时真实 ToolRuntime 零注册、事件订阅为零', async (t) => {
  const h = await realHost(t);
  if (!h) return;
  try {
    for (const config of [undefined, {}, { enabled: false }, { enabled: 'true' }]) {
      const handle = await apply(h.spyCtx, config, { dispatch: async () => ({ ok: true }), epoch: 'e1', defineTool: h.defineTool });
      assert.equal(handle.status().state, STATES.DISABLED);
      assert.equal(handle.status().enabled, false);
      assert.equal(handle.status().dispatchAvailable, false);
      for (const name of TOOL_NAMES) assert.equal(h.runtime.get(name), undefined, `${name} must not be registered`);
      assert.equal(h.counter.subscriptions, 0, 'default-closed must subscribe to zero events');
      await handle.dispose();
    }
  } finally {
    await h.root.dispose?.();
  }
});

test('启用但未注入 runtime：工具注册，调用返回 dispatch-unavailable，且不订阅事件', async (t) => {
  const h = await realHost(t);
  if (!h) return;
  try {
    const handle = await apply(h.spyCtx, { enabled: true }, { defineTool: h.defineTool });
    const status = handle.status();
    assert.equal(status.state, STATES.AWAITING_RUNTIME);
    assert.equal(status.dispatchAvailable, false);
    assert.equal(h.counter.subscriptions, 0);
    for (const name of TOOL_NAMES) assert.ok(h.runtime.get(name), `${name} should be registered`);
    const result = await h.runtime.get('qzone_like').execute({ tid: 'tid-1', target_uin: '12345' }, exec);
    assert.deepEqual(result, { ok: false, error: 'dispatch-unavailable' });
    await handle.dispose();
    for (const name of TOOL_NAMES) assert.equal(h.runtime.get(name), undefined, `${name} must be removed on dispose`);
  } finally {
    await h.root.dispose?.();
  }
});

test('注入 runtime 不代表真实派发已接线，且 dispatch 必须经 origin ledger 绑定', async (t) => {
  const h = await realHost(t);
  if (!h) return;
  try {
    const calls = [];
    const handle = await apply(h.spyCtx, { enabled: true }, {
      epoch: 'epoch-1',
      defineTool: h.defineTool,
      dispatch: async (...args) => { calls.push(args); return { ok: true }; },
    });
    assert.equal(handle.status().state, STATES.DISPATCH_READY);
    // In-process binding only: dispatchAvailable reports the real same-process
    // composition state. It is NOT production cross-process authentication.
    //
    // It also requires at least one pre-step adapter: dispatch needs a position,
    // positions come from observed `tool/call` events, and only the adapter created
    // in `agent/created` observes them. Without an agent this handle is registered
    // but every call fails `origin-unbound`, so the honest answer is false.
    assert.equal(handle.status().dispatchAvailable, false);
    assert.equal(handle.status().agentAdapters, 0);
    h.emitAgent();
    assert.equal(handle.status().agentAdapters, 1);
    assert.equal(handle.status().dispatchAvailable, true);
    assert.ok(h.counter.subscriptions >= 3);
    // No bridge request registered and no tool/call observed: must fail closed.
    const result = await h.runtime.get('qzone_like').execute({ tid: 'tid-1', target_uin: '12345' }, exec);
    assert.deepEqual(result, { ok: false, error: 'origin-unbound' });
    assert.deepEqual(calls, []);
    await handle.dispose();
  } finally {
    await h.root.dispose?.();
  }
});

test('超过位置容量只淘汰最早记录，不整批丢弃其他在途调用', async () => {
  const callbacks = new Map();
  const agentCallbacks = new Map();
  const registered = new Map();
  const on = (map) => (name, fn) => {
    const list = map.get(name) ?? [];
    list.push(fn); map.set(name, list);
    return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
  };
  const ctx = { on: on(callbacks), tools: { register(tool) {
    registered.set(tool.name, tool);
    return () => registered.delete(tool.name);
  } } };
  const handle = await apply(ctx, { enabled: true }, { epoch: 'e1', defineTool: (tool) => tool,
    dispatch: async () => ({ ok: true }) });
  const emit = (name, ...args) => { for (const cb of callbacks.get(name) ?? []) cb(...args); };
  emit('agent/created', { agent: { id: 'agent-1', session: { id: 's1' }, ctx: { on: on(agentCallbacks) } } });
  handle.registerBridgeRequest('s1', { requestId: 'r1', origin: 'qq-inbound' });
  for (const cb of agentCallbacks.get('agent/pre-step') ?? []) {
    cb({ turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'r1' } }] }, () => {});
  }
  const sendCall = (id) => emit('session/event', { id: 's1' }, {
    type: 'tool/call', data: { turn: 1, step: 1, callId: id, name: 'qzone_read_posts' },
  });
  sendCall('oldest');
  sendCall('still-in-flight');
  // One more filler than there are slots: the map is full and EVERY entry is still
  // live (the ledger's own `calls` capacity is just as large), so this is the one
  // case that reaches the FIFO fallback. With a smaller filler count no eviction
  // happens at all, and the case would pass without exercising anything.
  for (let i = 0; i < MAX_POSITIONS - 1; i++) sendCall(`filler-${i}`);
  const tool = registered.get('qzone_read_posts');
  assert.deepEqual(await tool.execute({ target_uin: 456 }, { agent: { session: { id: 's1' } }, callId: 'oldest' }),
    { ok: false, error: 'origin-unbound' });
  assert.deepEqual(await tool.execute({ target_uin: 456 }, { agent: { session: { id: 's1' } }, callId: 'still-in-flight' }),
    { ok: true });
  await handle.dispose();
});

test('插件消费的来源凭证与真实 runtime 可在同进程离线组合', async () => {
  const callbacks = new Map(), agentCallbacks = new Map(), registered = new Map();
  const on = (map) => (name, fn) => { const list = map.get(name) ?? []; list.push(fn); map.set(name, list);
    return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }; };
  const host = { on: on(callbacks), tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); } } };
  const now = Date.parse('2026-11-10T04:00:00Z');
  let state = { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true }, reads: 0, writes: 0, readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-10', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {}, activeStart: 0, activeEnd: 1439, audit: [] };
  const store = { read: () => structuredClone(state), update(fn) { state = fn(structuredClone(state)); return state; } };
  let spaceCalls = 0;
  const sourceLifetime = createQzoneSourceLifetime();
  const runtime = createQzoneRuntime({ store, botQq: 123, sourceEpoch: sourceLifetime.sourceEpoch(),
    authorizeSource: (c) => sourceLifetime.ownsConsumption(c), getConnectionEpoch: () => 1, getBridgeSessions: () => null,
    clock: () => now, mode: 'read-only', call: async (action) => {
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
      if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
      if (action === 'get_qzone_msg_list') { spaceCalls++; return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } }; }
      throw new Error('unexpected fake action');
    } });
  const handle = await apply(host, { enabled: true }, { dispatch: runtime.dispatch,
    epoch: sourceLifetime.sourceEpoch(), sourceLifetime, defineTool: (tool) => tool });
  const emit = (name, ...args) => { for (const cb of callbacks.get(name) ?? []) cb(...args); };
  emit('agent/created', { agent: { id: 'a', session: { id: 's1' }, ctx: { on: on(agentCallbacks) } } });
  handle.registerBridgeRequest('s1', { requestId: 'r1', origin: 'qq-inbound' });
  for (const cb of agentCallbacks.get('agent/pre-step') ?? []) cb({ turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'r1' } }] }, () => {});
  emit('session/event', { id: 's1' }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1' } });
  const result = await registered.get('qzone_read_posts').execute({ target_uin: 456 }, { agent: { session: { id: 's1' } }, callId: 'c1' });
  assert.equal(result.outcome, 'success');
  assert.equal(spaceCalls, 1);
  await handle.dispose();
  sourceLifetime.close();
});
