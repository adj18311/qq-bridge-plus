// Pins R11 reviewer F1: a CLEAN close + resume of the same session used to leave the
// whole space-tool surface permanently dead behind a `dispatchAvailable: true`.
//
// The chain was three existing pieces that only became visible once `status()` started
// promising real dispatchability:
//   1. `agent/disposed` → `entry.adapter.dispose()` → `ledger.disconnect()` latches
//      `continuityLost` forever (`qzone-origin-ledger-offline.mjs`, `reconnect()` is
//      deliberately non-reviving).
//   2. the plugin kept the disconnected ledger cached by sessionId
//      (`ledgerFor`), and `sourceLifetime.getLedger()` handed the same frozen object
//      back, so the resume built a FRESH adapter on a DEAD ledger.
//   3. nothing could ask a ledger whether it was alive: `stats()` exposed only
//      `callsRefusedCapacity` / `spentCalls` / `usedRequests`.
//
// Consequence: `registerBridgeRequest` threw "来源账本不可用或已满", every dispatch
// returned `origin-unbound`, and it survived a full plugin reload because the poisoned
// ledger lived in the source lifetime. No malformed input was needed.
//
// These cases use a REAL `createQzoneSourceLifetime` on purpose: the fake lifetimes in
// the other tests cannot express the `getLedger`-returns-the-same-object behaviour that
// caused the bug, so a fake here would pass before the fix and prove nothing.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createQzonePluginHandle, STATES } from '../plugins/qzone-safe/index.mjs';
import { createQzoneSourceLifetime } from '../src/core/qzone-source-lifetime-offline.mjs';

const TOOL = 'qzone_read_posts';
const defineTool = (tool) => tool;
const userMessage = (requestId) => ({ role: 'user', source: { rpcId: requestId } });
const execFor = (sessionId, callId) => ({ agent: { session: { id: sessionId } }, callId });

function fakeHost() {
  const callbacks = new Map();
  const registered = new Map();
  const ctx = {
    on: (name, fn) => {
      const list = callbacks.get(name) ?? [];
      list.push(fn);
      callbacks.set(name, list);
      return () => {
        const current = callbacks.get(name) ?? [];
        const index = current.indexOf(fn);
        if (index >= 0) current.splice(index, 1);
      };
    },
    tools: { register: (tool) => { registered.set(tool.name, tool); return () => registered.delete(tool.name); } },
  };
  const emit = (name, ...args) => { for (const fn of callbacks.get(name) ?? []) fn(...args); };
  return { ctx, emit, registered };
}

function agentCtx() {
  const callbacks = new Map();
  return {
    on: (name, fn) => { const list = callbacks.get(name) ?? []; list.push(fn); callbacks.set(name, list); return () => {}; },
    fire: (name, payload) => { for (const fn of callbacks.get(name) ?? []) fn(payload, () => {}); },
  };
}

// Build a handle wired to a REAL source lifetime, dispatching into a stub runtime.
async function wiredHost({ sessionLimit = 8, trackingLimit = 64 } = {}) {
  const host = fakeHost();
  const lifetime = createQzoneSourceLifetime({ sessionLimit, trackingLimit });
  const dispatches = [];
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: lifetime.sourceEpoch(),
    defineTool,
    dispatch: async (action, input, context) => { dispatches.push({ action, context }); return { ok: true }; },
    sourceLifetime: lifetime,
  });
  return { host, lifetime, handle, dispatches };
}

// One complete dispatchable turn: register the bridge request, claim it in a pre-step,
// announce the host's tool/call, then run the tool. `turn` must advance monotonically.
async function armAndRun(host, handle, sessionId, { turn, requestId, callId, agentKey }) {
  const ctxOf = agentContexts.get(agentKey);
  handle.registerBridgeRequest(sessionId, { requestId, origin: 'qq-inbound' });
  ctxOf.fire('agent/pre-step', { turn, step: 1, messages: [userMessage(requestId)] });
  host.emit('session/event', { id: sessionId }, { type: 'tool/call', data: { turn, step: 1, callId, name: TOOL } });
  // execute() runs INSIDE the turn, like real DSH: `turn/end` reaps this turn's
  // `calls` in the origin ledger, so emitting it first makes every dispatch fail
  // `origin-unbound` — a fixture artefact, not a plugin fault.
  const result = await host.registered.get(TOOL).execute({ target_uin: 456 }, execFor(sessionId, callId));
  host.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn } });
  return result;
}

// `armAndRun` needs the live agent ctx per agentId; kept here so each case can create
// its own and the helper stays a pure function of its arguments otherwise.
const agentContexts = new Map();

function createAgent(host, agentId, sessionId) {
  const ctxOf = agentCtx();
  agentContexts.set(agentId, ctxOf);
  host.emit('agent/created', { agent: { id: agentId, session: { id: sessionId }, ctx: ctxOf } });
  return ctxOf;
}

test('干净关闭后 resume 同一会话必须仍然能派发，且 status 不得在期间报 ready', async () => {
  const { host, handle } = await wiredHost();
  createAgent(host, 'agent-1', 'sess-resume');

  const before = await armAndRun(host, handle, 'sess-resume', { turn: 1, requestId: 'rpc-1', callId: 'call-1', agentKey: 'agent-1' });
  assert.deepEqual(before, { ok: true }, '前提：resume 之前这条会话必须真的能派发');

  // Clean shutdown of the agent (host `resume` path), no malformed input at all.
  host.emit('agent/disposed', { agent: { id: 'agent-1', session: { id: 'sess-resume' } } });
  assert.equal(handle.status('sess-resume').dispatchAvailable, false, '没有 adapter 时不得报可派发');
  assert.deepEqual(handle.status('sess-resume').dispatchableSessions, []);

  // Resume: same agent id, same session id.
  createAgent(host, 'agent-1b', 'sess-resume');
  const resumed = handle.status('sess-resume');
  assert.deepEqual(resumed.dispatchableSessions, ['sess-resume'], 'resume 之后必须重新有线可派');
  assert.equal(resumed.dispatchAvailable, true);
  assert.equal(resumed.adaptersBlocked, 0, '账本已被干净释放，不应算作被阻断');
  assert.equal(resumed.adaptersDisconnected, 0, '干净关闭不是运行期断流');

  const after = await armAndRun(host, handle, 'sess-resume', { turn: 2, requestId: 'rpc-2', callId: 'call-2', agentKey: 'agent-1b' });
  assert.deepEqual(after, { ok: true }, 'resume 之后必须真的能派发；否则 status 又在承诺做不到的事');
  await handle.dispose();
});

test('同一会话可以在多次关闭与恢复之间反复使用', async () => {
  const { host, handle } = await wiredHost();
  for (let round = 1; round <= 3; round += 1) {
    const agentKey = `agent-${round}`;
    createAgent(host, agentKey, 'sess-loop');
    const result = await armAndRun(host, handle, 'sess-loop', {
      turn: round, requestId: `rpc-${round}`, callId: `call-${round}`, agentKey,
    });
    assert.deepEqual(result, { ok: true }, `第 ${round} 轮必须能派发`);
    host.emit('agent/disposed', { agent: { id: agentKey, session: { id: 'sess-loop' } } });
  }
  await handle.dispose();
});

test('构造失败只计 adaptersFailed，不得同时冒充一次运行期断流', async () => {
  const { host, handle } = await wiredHost();
  const ctxOf = agentCtx();
  // A ctx whose `on` refuses to hand back a disposer makes the adapter constructor
  // throw after it already subscribed — the construction-failure path.
  const brokenCtx = { on: () => undefined };
  host.emit('agent/created', { agent: { id: 'bad', session: { id: 'sess-bad' }, ctx: brokenCtx } });
  const status = handle.status('sess-bad');
  assert.equal(status.adaptersFailed, 1, '构造失败必须留痕');
  assert.equal(status.adaptersDisconnected, 0, '从未进表的 adapter 不是运行期断流，否则计数指向一个不存在的死对象');
  assert.equal(status.agentAdapters, 0);
  assert.equal(status.dispatchAvailable, false);
  assert.deepEqual(status.dispatchableSessions, []);

  // A healthy agent on another session must still work — one broken construction is
  // not a plugin-wide failure.
  agentContexts.set('ok', ctxOf);
  host.emit('agent/created', { agent: { id: 'ok', session: { id: 'sess-ok' }, ctx: ctxOf } });
  assert.equal(handle.status('sess-ok').dispatchAvailable, true);
  await handle.dispose();
});

test('运行的会话在会话表里没有剩余 agent 时才释放账本，仍有别的 agent 共用时不释放', async () => {
  const { host, handle, lifetime } = await wiredHost();
  createAgent(host, 'a1', 'sess-share');
  createAgent(host, 'a2', 'sess-share');
  const shared = lifetime.getLedger('sess-share');

  host.emit('agent/disposed', { agent: { id: 'a1', session: { id: 'sess-share' } } });
  assert.equal(lifetime.getLedger('sess-share'), shared, '还有 agent 用着这本账本时不得释放，否则会打断在用会话');

  host.emit('agent/disposed', { agent: { id: 'a2', session: { id: 'sess-share' } } });
  assert.notEqual(lifetime.getLedger('sess-share'), shared, '最后一根线断掉后必须换一本新账本');
  await handle.dispose();
});

test('运行期断流的账本不得被释放：那会清掉跨故障唯一剩下的防重放记录', async () => {
  const { host, handle, lifetime } = await wiredHost();
  const ctxOf = createAgent(host, 'agent-dead', 'sess-dead');
  // A malformed pre-step latches `continuityLost` — a runtime fault, not a clean close.
  ctxOf.fire('agent/pre-step', { turn: 0, step: 1, messages: [] });
  const dead = lifetime.getLedger('sess-dead');
  assert.equal(dead.alive(), false, '前提：账本确实已被断流');

  host.emit('agent/disposed', { agent: { id: 'agent-dead', session: { id: 'sess-dead' } } });
  assert.equal(lifetime.getLedger('sess-dead'), dead, '故障账本必须留在缓存里，换新的会重开重放窗口');

  // And the plugin must refuse to pretend a new adapter on it would work.
  createAgent(host, 'agent-after', 'sess-dead');
  const status = handle.status('sess-dead');
  assert.equal(status.dispatchAvailable, false, '建在死账本上的 adapter 派发必然失败，不得报可派发');
  assert.deepEqual(status.dispatchableSessions, []);
  assert.equal(status.adaptersBlocked, 1, '被阻断必须可观测，且与构造失败分开计');
  assert.equal(status.adaptersFailed, 0);
  await handle.dispose();
});

test('status 里 session 参数只认实参个数：显式传值（含 undefined）不得替别人回答', async () => {
  const { host, handle } = await wiredHost();
  createAgent(host, 'only', 'sess-only');
  // `null` / `''` / explicit `undefined` all mean "a session was named, but not one I can
  // identify" — none of them may be answered with "some other session is wired". The
  // distinction from "no argument" is `arguments.length`, which is why `status()` (the
  // compatibility form, asserted on the next line) still reports the global answer.
  for (const bogus of [null, '', undefined]) {
    const label = bogus === '' ? "status('')" : `status(${String(bogus)})`;
    assert.equal(handle.status(bogus).dispatchAvailable, false, `${label} 表示「我说不出我是哪个会话」，不能报别人的会话可派发`);
  }
  assert.equal(handle.status().dispatchAvailable, true, '省略参数的含义仍是「至少有一个会话可派」');
  // An explicitly named, live session is still answered exactly.
  assert.equal(handle.status('sess-only').dispatchAvailable, true, '显式传入有效会话时必须报该会话可派发');
  await handle.dispose();
});
