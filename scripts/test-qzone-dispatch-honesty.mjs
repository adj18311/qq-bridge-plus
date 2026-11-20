// Pins `status().dispatchAvailable` to something it can actually promise.
//
// R10 reviewer H2 found two reachable shapes where the field said `true` and every
// dispatch then failed `origin-unbound`:
//   B) an adapter exists for session s2 while the call comes from s1
//   C) the adapter exists for s1 but its ledger was disconnected at runtime
//      (one malformed pre-step does it), so `ledger.consume` refuses forever
//
// Both are silent failures: no audit row, no counter, and the error text blames the
// origin rather than the missing/dead binding. The fix is that `status()` answers
// PER SESSION and folds in adapter liveness; these cases pin that answer to the
// observable dispatch outcome, so "status true but dispatch fails" cannot come back
// unnoticed.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createQzonePluginHandle, STATES } from '../plugins/qzone-safe/index.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

const TOOL = 'qzone_read_posts';
const defineTool = (tool) => tool;

// `getQzoneDshSessionContext` (`plugins/qzone-safe/session-context.mjs:5-14`) reads the
// session from `exec.agent.session.id` and the call from `exec.callId`. The flat
// `{sessionId, callId}` shape returns `missing-native-context` before dispatch, which
// would make every case look like a plugin failure instead of the case under test.
const execFor = (sessionId, callId) => ({ agent: { session: { id: sessionId } }, callId });

const userMessage = (requestId) => ({ role: 'user', source: { rpcId: requestId } });

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
  const ledgers = new Map();
  const lifetime = {
    sourceEpoch: () => 'e1',
    getLedger: (sessionId) => {
      let ledger = ledgers.get(sessionId);
      if (!ledger) {
        ledger = createQzoneOriginLedger({ sessionId, epoch: 'e1', trackingLimit: 4096 });
        ledgers.set(sessionId, ledger);
      }
      return ledger;
    },
    rotate() {},
    ownsConsumption: () => false,
  };
  const dispatches = [];
  const handle = createQzonePluginHandle(ctx, { enabled: true }, {
    epoch: 'e1',
    defineTool,
    dispatch: async (action, input, context) => { dispatches.push({ action, context }); return { ok: true }; },
    sourceLifetime: lifetime,
  });
  const emit = (name, ...args) => { for (const fn of callbacks.get(name) ?? []) fn(...args); };
  return { handle, emit, registered, dispatches };
}

// A stand-in for the live agent ctx: the plugin needs `on` to exist and the adapter
// registers its pre-step listener on it.
function agentCtx() {
  const callbacks = new Map();
  return {
    on: (name, fn) => { const list = callbacks.get(name) ?? []; list.push(fn); callbacks.set(name, list); return () => {}; },
    fire: (name, payload) => { for (const fn of callbacks.get(name) ?? []) fn(payload, () => {}); },
  };
}

// Drive one session into the exact shape that makes a dispatch possible:
// a registered bridge request, a pre-step step that claims it, and the host's
// `tool/call` announcement that creates the position.
function armSession(handle, host, ctxOf, sessionId, { requestId = 'rpc-1', callId = 'call-1' } = {}) {
  handle.registerBridgeRequest(sessionId, { requestId, origin: 'qq-inbound' });
  ctxOf.fire('agent/pre-step', { turn: 1, step: 1, messages: [userMessage(requestId)] });
  host.emit('session/event', { id: sessionId }, { type: 'tool/call', data: { turn: 1, step: 1, callId, name: TOOL } });
  return { requestId, callId };
}

test('status 必须按会话回答：只有别的会话有 adapter 时，本会话不得报 dispatchAvailable', async () => {
  const host = fakeHost();
  const handle = await host.handle;
  const other = agentCtx();
  host.emit('agent/created', { agent: { id: 'agent-s2', session: { id: 's2' }, ctx: other } });
  // s1 gets a pending position but no adapter, so nothing ever observes a step for it.
  host.emit('session/event', { id: 's1' }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: TOOL } });

  const forS1 = handle.status('s1');
  assert.equal(forS1.dispatchAvailable, false, 's1 没有活 adapter，报 true 就是在承诺做不到的事');
  assert.deepEqual(forS1.dispatchableSessions, ['s2'], '必须如实列出真正有线可派的会话');
  assert.equal(handle.status('s2').dispatchAvailable, true, 's2 真的接线了，必须报 true');

  const result = await host.registered.get(TOOL).execute({ target_uin: 456 }, execFor('s1', 'c1'));
  assert.deepEqual(result, { ok: false, error: 'origin-unbound' }, '这条派发本来就必失败');
  assert.equal(host.dispatches.length, 0);
  assert.equal(handle.status('s1').dispatchAvailable, false, '承诺与结果必须一致');
  await handle.dispose();
});

test('adapter 的账本在运行期断流后不得继续报 dispatchAvailable，且断流必须可计数', async () => {
  const host = fakeHost();
  const handle = await host.handle;
  const ctxOf = agentCtx();
  host.emit('agent/created', { agent: { id: 'agent-1', session: { id: 's1' }, ctx: ctxOf } });
  const { callId } = armSession(handle, host, ctxOf, 's1', { requestId: 'rpc-c', callId: 'c9' });

  const before = handle.status('s1');
  assert.equal(before.dispatchAvailable, true, '断流之前必须确实是可派发的形状');
  assert.deepEqual(before.dispatchableSessions, ['s1']);
  assert.equal(before.adaptersDisconnected, 0);

  // A malformed pre-step payload fails `positive(turn)` and makes the adapter call
  // `disconnect()`, which latches `continuityLost` on the ledger permanently.
  ctxOf.fire('agent/pre-step', { turn: 0, step: 1, messages: [] });

  const after = handle.status('s1');
  assert.equal(after.dispatchAvailable, false, '账本已断流，唯一的诚实答案是否');
  assert.deepEqual(after.dispatchableSessions, [], '死 adapter 不得出现在可派发会话里');
  assert.equal(after.adaptersDisconnected, 1, '运行期断流必须有计数，否则这个状态不可观测');
  assert.equal(after.agentAdapters, 1, '对象仍在表里，总数不改（它只是不能用了）');
  assert.equal(after.state, STATES.DISPATCH_READY, 'state 是构造期快照，不因运行期故障改变');

  const result = await host.registered.get(TOOL).execute({ target_uin: 456 }, execFor('s1', callId));
  assert.deepEqual(result, { ok: false, error: 'origin-unbound' }, '这就是 status 必须提前否掉的失败');
  assert.equal(host.dispatches.length, 0);
  await handle.dispose();
});

test('健康形状必须同时满足 status 为真与实际派发成功', async () => {
  const host = fakeHost();
  const handle = await host.handle;
  const ctxOf = agentCtx();
  host.emit('agent/created', { agent: { id: 'agent-1', session: { id: 's1' }, ctx: ctxOf } });
  const { callId } = armSession(handle, host, ctxOf, 's1', { callId: 'ok-1' });

  const status = handle.status('s1');
  assert.equal(status.dispatchAvailable, true);
  assert.deepEqual(status.dispatchableSessions, ['s1']);
  const result = await host.registered.get(TOOL).execute({ target_uin: 456 }, execFor('s1', callId));
  assert.deepEqual(result, { ok: true }, 'status 为真时派发必须真的成功，否则这个字段没有意义');
  assert.equal(host.dispatches.length, 1);
  await handle.dispose();
});

test('正常 dispose 不是运行期断流：不得把它算进 adaptersDisconnected', async () => {
  const host = fakeHost();
  const handle = await host.handle;
  const ctxOf = agentCtx();
  host.emit('agent/created', { agent: { id: 'agent-1', session: { id: 's1' }, ctx: ctxOf } });
  armSession(handle, host, ctxOf, 's1', { callId: 'd-1' });
  assert.equal(handle.status('s1').dispatchAvailable, true);

  await handle.dispose();
  const status = handle.status('s1');
  assert.equal(status.state, STATES.DISPOSED);
  assert.equal(status.dispatchAvailable, false);
  assert.equal(status.adaptersDisconnected, 0, '拆掉插件不等于运行期故障，否则计数器会失去含义');
  assert.equal(status.agentAdapters, 0);
});

test('不传会话时只能代表「至少有一个会话可派发」，全死必须为假', async () => {
  const host = fakeHost();
  const handle = await host.handle;
  const ctxOf = agentCtx();
  host.emit('agent/created', { agent: { id: 'agent-1', session: { id: 's1' }, ctx: ctxOf } });
  host.emit('session/event', { id: 's1' }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'n-1', name: TOOL } });
  assert.equal(handle.status().dispatchAvailable, true, '没有任何会话可派发之前，无参形式仍要能反映“有线”');

  ctxOf.fire('agent/pre-step', { turn: 0, step: 1, messages: [] });
  assert.equal(handle.status().dispatchAvailable, false, '唯一会话死了，无参形式也必须为假');
  assert.deepEqual(handle.status().dispatchableSessions, []);
  await handle.dispose();
});
