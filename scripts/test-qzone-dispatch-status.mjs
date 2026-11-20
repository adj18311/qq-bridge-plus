import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzonePluginHandle, STATES } from '../plugins/qzone-safe/index.mjs';
import { QZONE_MCP_TOOLS } from '../src/core/qzone-mcp-contract.mjs';

// Offline only: fake Cordis ctx, fake tool registry, fake dispatcher.
//
// Pins status().dispatchAvailable to the real same-process binding state:
// it must be true only when the entry both has an injected dispatch+epoch
// (ready) and actually reached DISPATCH_READY, false in every other state.
// It never means production cross-process authentication.
const TOOL_NAMES = Object.keys(QZONE_MCP_TOOLS).map((action) => `qzone_${action}`);

function fakeHost() {
  const listeners = new Map();
  const registered = new Map();
  const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args); };
  return {
    registered, emit,
    // A handle with no `agent/created` has zero pre-step adapters, so no `tool/call`
    // is ever observed and every dispatch fails `origin-unbound`. Reporting
    // `dispatchAvailable: true` in that state is the worst shape (all green, nothing
    // works), so the real sequence has to include an agent before the assertion.
    createAgent(sessionId = 's1', agentId = 'agent-1') {
      emit('agent/created', { agent: { id: agentId, session: { id: sessionId },
        ctx: { on: () => () => {} } } });
    },
    ctx: {
      on(name, listener) {
        const list = listeners.get(name) ?? [];
        list.push(listener);
        listeners.set(name, list);
        return () => {
          const index = list.indexOf(listener);
          if (index >= 0) list.splice(index, 1);
        };
      },
      tools: {
        register(tool) {
          registered.set(tool.name, tool);
          return () => registered.delete(tool.name);
        },
      },
    },
  };
}

const defineTool = (tool) => tool;

test('disabled：未启用时 dispatchAvailable 为 false，且零注册零订阅', async () => {
  for (const config of [undefined, {}, { enabled: false }, { enabled: 'true' }]) {
    const host = fakeHost();
    const handle = await createQzonePluginHandle(host.ctx, config, {
      dispatch: async () => ({ ok: true }), epoch: 'e1', defineTool,
    });
    assert.deepEqual(handle.status(), {
      enabled: false, state: STATES.DISABLED, tools: 0, subscriptions: 0, dispatchAvailable: false,
      dispatchableSessions: [], adaptersDisconnected: 0,
      generationBound: true, staleGenerationObserved: false,
      positionsEvictedLive: 0, stepsRefused: 0, adaptersFailed: 0, adaptersBlocked: 0, agentAdapters: 0,
      lastDispatchRefusal: { reason: null, counters: { 'invalid-context': 0, epoch: 0, position: 0, ledger: 0, consume: 0 } },
      positionStream: { toolCallEventsSeen: 0, positionsStored: 0, positionsSkippedForeignTool: 0, positionsSkippedInvalidId: 0, positionsEvictedLive: 0, positionsLive: 0 },
    });
    assert.equal(host.registered.size, 0);
    await handle.dispose();
  }
});

test('awaiting-runtime：启用但未注入 dispatch/epoch 时 dispatchAvailable 为 false', async () => {
  for (const [label, runtime] of [
    ['只有 defineTool', { defineTool }],
    ['有 dispatch 无 epoch', { dispatch: async () => ({ ok: true }), defineTool }],
    ['epoch 为空串', { dispatch: async () => ({ ok: true }), epoch: '', defineTool }],
    ['dispatch 不是函数', { dispatch: 'not-a-function', epoch: 'e1', defineTool }],
  ]) {
    const host = fakeHost();
    const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, runtime);
    const status = handle.status();
    assert.equal(status.state, STATES.AWAITING_RUNTIME, label);
    assert.equal(status.dispatchAvailable, false, `没有同进程 dispatch 绑定就不能报 true（${label}）`);
    assert.equal(status.tools, TOOL_NAMES.length, '仍应注册工具，只是调用会返回 dispatch-unavailable');
    // dispatch-unavailable is the observable consequence of not being ready.
    const result = await host.registered.get('qzone_read_posts').execute({ target_uin: 456 },
      { agent: { session: { id: 's1' } }, callId: 'c1' });
    assert.deepEqual(result, { ok: false, error: 'dispatch-unavailable' }, label);
    await handle.dispose();
  }
});

test('完全没有注入 runtime：工具工厂缺失导致注册失败，dispatchAvailable 仍为 false', async () => {
  const host = fakeHost();
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, undefined);
  assert.equal(handle.status().state, STATES.TOOLS_FAILED);
  assert.equal(handle.status().dispatchAvailable, false);
  assert.equal(host.registered.size, 0, '注册失败必须回滚已注册的工具');
  await handle.dispose();
});

test('dispatch-ready：注入 dispatch+epoch 并完成注册后 dispatchAvailable 为 true', async () => {
  const host = fakeHost();
  const calls = [];
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: 'e1', defineTool, dispatch: async (...args) => { calls.push(args); return { ok: true }; },
  });
  // `ready` alone is not a promise that a call issued now would dispatch: dispatch
  // needs a position, positions come from observed `tool/call` events, and only the
  // pre-step adapter created in `agent/created` observes them. Without an agent the
  // handle is registered but every call fails `origin-unbound`, so the honest status
  // is `dispatchAvailable: false` with `agentAdapters: 0`.
  assert.deepEqual(handle.status(), {
    enabled: true, state: STATES.DISPATCH_READY, tools: TOOL_NAMES.length,
    subscriptions: 3, dispatchAvailable: false,
    dispatchableSessions: [], adaptersDisconnected: 0,
    generationBound: true, staleGenerationObserved: false,
    positionsEvictedLive: 0, stepsRefused: 0, adaptersFailed: 0, adaptersBlocked: 0, agentAdapters: 0,
    lastDispatchRefusal: { reason: null, counters: { 'invalid-context': 0, epoch: 0, position: 0, ledger: 0, consume: 0 } },
    positionStream: { toolCallEventsSeen: 0, positionsStored: 0, positionsSkippedForeignTool: 0, positionsSkippedInvalidId: 0, positionsEvictedLive: 0, positionsLive: 0 },
  });
  host.createAgent();
  assert.deepEqual(handle.status(), {
    enabled: true, state: STATES.DISPATCH_READY, tools: TOOL_NAMES.length,
    subscriptions: 3, dispatchAvailable: true,
    dispatchableSessions: ['s1'], adaptersDisconnected: 0,
    generationBound: true, staleGenerationObserved: false,
    positionsEvictedLive: 0, stepsRefused: 0, adaptersFailed: 0, adaptersBlocked: 0, agentAdapters: 1,
    lastDispatchRefusal: { reason: null, counters: { 'invalid-context': 0, epoch: 0, position: 0, ledger: 0, consume: 0 } },
    positionStream: { toolCallEventsSeen: 0, positionsStored: 0, positionsSkippedForeignTool: 0, positionsSkippedInvalidId: 0, positionsEvictedLive: 0, positionsLive: 0 },
  });
  // dispatchAvailable is a报告字段 only; a tool call without ledger binding still fails closed.
  const result = await host.registered.get('qzone_read_posts').execute({ target_uin: 456 },
    { agent: { session: { id: 's1' } }, callId: 'c1' });
  assert.deepEqual(result, { ok: false, error: 'origin-unbound' });
  assert.deepEqual(calls, []);
  await handle.dispose();
});

test('工具注册失败或已释放时 dispatchAvailable 回到 false，不残留 ready', async () => {
  const broken = fakeHost();
  broken.ctx.tools.register = () => undefined;
  const failed = await createQzonePluginHandle(broken.ctx, { enabled: true }, {
    epoch: 'e1', defineTool, dispatch: async () => ({ ok: true }),
  });
  assert.equal(failed.status().state, STATES.TOOLS_FAILED);
  assert.equal(failed.status().dispatchAvailable, false);

  const host = fakeHost();
  const ready = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: 'e1', defineTool, dispatch: async () => ({ ok: true }),
  });
  host.createAgent();
  assert.equal(ready.status().dispatchAvailable, true);
  await ready.dispose();
  assert.deepEqual(ready.status(), {
    enabled: true, state: STATES.DISPOSED, tools: 0, subscriptions: 0, dispatchAvailable: false,
    dispatchableSessions: [], adaptersDisconnected: 0,
    generationBound: true, staleGenerationObserved: false,
    positionsEvictedLive: 0, stepsRefused: 0, adaptersFailed: 0, adaptersBlocked: 0, agentAdapters: 0,
    lastDispatchRefusal: { reason: null, counters: { 'invalid-context': 0, epoch: 0, position: 0, ledger: 0, consume: 0 } },
    positionStream: { toolCallEventsSeen: 0, positionsStored: 0, positionsSkippedForeignTool: 0, positionsSkippedInvalidId: 0, positionsEvictedLive: 0, positionsLive: 0 },
  });
});
