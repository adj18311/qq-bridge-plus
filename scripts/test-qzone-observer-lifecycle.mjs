// Pins the `session/event` observer LIFECYCLE, which R12b broke by moving observation
// from agent granularity (owned by the adapter, so `teardown()`'s adapter loop reached
// it) to session granularity (a separate `observers` Map that nothing on the teardown
// path cleaned).
//
// Measured before the fix, on one shared host ctx:
//
//   reload 5 rounds, agent created, no `agent/disposed`  → session/event listeners [1,2,3,4,5]
//   reload 3 rounds, faulted session                     → [1,2,3]
//   S1 zero agents + handle.dispose()                    → 0   (ok)
//   S2 one agent + handle.dispose()                      → 1   (leak)
//   S3 one agent + clean `agent/disposed`                → 0   (ok, the only path that cleaned)
//   S4 adapter construction failure                      → 1–2 (leak)
//
// The leaked observer keeps `active === true`, a host listener, and the closure over the
// already-disconnected ledger. It does NOT resurrect a false promise (`state` stays
// `disposed`, `dispatchAvailable` stays false), so the cost is a resource leak that grows
// without bound across reloads — not a safety regression. These cases pin the cleanup,
// not a security property.
//
// Counting method: this host ctx increments on `on('session/event', fn)` and decrements
// when that exact disposer runs, so the number is the host's own view — the same thing an
// operator would see on `listenerCount`.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createQzonePluginHandle } from '../plugins/qzone-safe/index.mjs';
import { createQzoneSourceLifetime } from '../src/core/qzone-source-lifetime-offline.mjs';

const TOOL = 'qzone_read_posts';
const defineTool = (tool) => tool;
const userMessage = (requestId) => ({ role: 'user', source: { rpcId: requestId } });

// A host ctx that reports its own listener population. `count(name)` is what a real host
// would answer for `ctx.listenerCount(name)`, computed the only way this harness can.
function countingHost() {
  const listeners = new Map();
  const counts = new Map();
  const registered = new Map();
  const ctx = {
    on(name, fn) {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
      counts.set(name, (counts.get(name) ?? 0) + 1);
      return () => {
        const current = listeners.get(name) ?? [];
        const index = current.indexOf(fn);
        if (index < 0) return; // already disposed: do not double-decrement
        current.splice(index, 1);
        counts.set(name, (counts.get(name) ?? 0) - 1);
      };
    },
    tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); } },
  };
  return {
    ctx,
    registered,
    count: (name) => counts.get(name) ?? 0,
    emit(name, ...args) {
      for (const fn of [...(listeners.get(name) ?? [])]) fn(...args);
    },
  };
}

function agentCtx({ broken = false } = {}) {
  const callbacks = new Map();
  return {
    // `broken` reproduces the adapter construction failure: a ctx that refuses to hand
    // back a disposer, so `createQzonePrestepAdapter` throws after subscribing.
    on: broken
      ? () => undefined
      : (name, fn) => {
        const list = callbacks.get(name) ?? [];
        list.push(fn);
        callbacks.set(name, list);
        return () => {};
      },
    fire(name, payload) {
      for (const fn of callbacks.get(name) ?? []) fn(payload, () => {});
    },
  };
}

async function newHandle(host, extra = {}) {
  return createQzonePluginHandle(host.ctx, { enabled: true }, {
    dispatch: async () => ({ ok: true }),
    epoch: 'e1',
    defineTool,
    ...extra,
  });
}

function addAgent(host, agentId, sessionId, ctxOf) {
  host.emit('agent/created', { agent: { id: agentId, session: { id: sessionId }, ctx: ctxOf } });
}

// The plugin subscribes `session/event` once for `positions` and each session observer
// adds one more. Both are counted; the assertions below are about the TOTAL, because the
// leak is about the host listener population, not about attributing listeners.
const COUNTED = 'session/event';

test('S1 零 agent：dispose 后 host 的 session/event 监听器回到基线', async () => {
  const host = countingHost();
  const before = host.count(COUNTED);
  const handle = await newHandle(host);
  assert.ok(host.count(COUNTED) > before, '前提：插件确实订阅了 session/event');
  await handle.dispose();
  assert.equal(host.count(COUNTED), before, '把宿主当作用完即还的对象：dispose 必须解开自己所有订阅');
});

test('S2 有 agent 但没走 agent/disposed：dispose 也必须把 observer 一起收掉', async () => {
  const host = countingHost();
  const before = host.count(COUNTED);
  const handle = await newHandle(host);
  addAgent(host, 'agent-1', 'sess-s2', agentCtx());
  // The observer is the extra listener on top of the plugin's own `positions` one.
  assert.equal(host.count(COUNTED), before + 2, '前提：插件订阅 + 每 session 一个 observer');
  assert.equal(handle.status('sess-s2').dispatchAvailable, true);

  // NO `agent/disposed`: this is the ordinary "plugin reloaded / host shut down" path.
  await handle.dispose();
  assert.equal(host.count(COUNTED), before,
    '没有 agent/disposed 也不能泄漏：observer 归插件所有，teardown 必须清理它');
  assert.equal(handle.status('sess-s2').dispatchAvailable, false);
});

test('连续 reload 5 轮（每轮都有 agent、都不发 agent/disposed）：监听器不得单调增长', async () => {
  const host = countingHost();
  const before = host.count(COUNTED);
  const perRoundAfterDispose = [];
  const perRoundPeak = [];
  for (let round = 1; round <= 5; round += 1) {
    const handle = await newHandle(host);
    addAgent(host, `agent-r${round}`, `sess-r${round}`, agentCtx());
    perRoundPeak.push(host.count(COUNTED));
    await handle.dispose();
    perRoundAfterDispose.push(host.count(COUNTED));
  }
  // The pre-fix reading was afterDispose = [1,2,3,4,5] and peak growing the same way.
  assert.deepEqual(perRoundAfterDispose, [before, before, before, before, before],
    `每轮 dispose 之后必须回到基线；实测 ${JSON.stringify(perRoundAfterDispose)}（修复前是 1,2,3,4,5）`);
  assert.equal(new Set(perRoundPeak).size, 1,
    `每轮峰值必须恒定；实测 ${JSON.stringify(perRoundPeak)}（修复前每轮 +1）`);
  assert.equal(host.count(COUNTED), before, '五轮之后整体必须归零');
});

test('故障会话的最后一个 agent 退出：observer 被清掉，但账本必须保留原对象且仍是死的', async () => {
  const lifetime = createQzoneSourceLifetime({ sessionLimit: 8, trackingLimit: 64 });
  const host = countingHost();
  // The handle must be bound to the CURRENT epoch of that lifetime, otherwise
  // generationIsCurrent() fails on the first ledgerFor() call and no adapter is ever
  // installed (the precondition assertions below would then fail for the wrong reason).
  const handle = await newHandle(host, { sourceLifetime: lifetime, epoch: lifetime.sourceEpoch() });
  const ctxOf = agentCtx();
  addAgent(host, 'agent-dead', 'sess-dead', ctxOf);
  const listenerAfterAgent = host.count(COUNTED);
  const dead = lifetime.getLedger('sess-dead');

  // A malformed pre-step latches `continuityLost` on the SHARED ledger and faults every
  // agent entry on the session (`faultSession`).
  ctxOf.fire('agent/pre-step', { turn: 0, step: 1, messages: [] });
  assert.equal(dead.alive(), false, '前提：账本确实被打成 continuityLost');
  assert.equal(handle.status('sess-dead').dispatchAvailable, false, '前提：状态已如实转假');

  host.emit('agent/disposed', { agent: { id: 'agent-dead', session: { id: 'sess-dead' } } });

  // Observer cleaned: the extra listener is gone (only the plugin's own remains).
  assert.equal(host.count(COUNTED), listenerAfterAgent - 1,
    '故障会话出口不得再跳过 observer 清理：最后一个 agent 走了就没人需要它');
  // Ledger must NOT be replaced: `spentCalls` / `usedRequests` are the only replay
  // protection that survives the fault, and a fresh ledger would reopen that window.
  assert.equal(lifetime.getLedger('sess-dead'), dead, '故障账本必须留在缓存里，不得换新');
  assert.equal(lifetime.getLedger('sess-dead').alive(), false, '而且必须仍然是死的');

  // Control: the same session now looks blocked, not dispatchable, and the counter says
  // the fault was counted exactly once.
  assert.deepEqual(handle.status('sess-dead').dispatchableSessions, []);
  assert.equal(handle.status('sess-dead').adaptersDisconnected, 1);

  await handle.dispose();
  assert.equal(host.count(COUNTED), 0, 'dispose 之后整体归零');
});

test('故障会话仍有两个 agent 时：先退出一个不得清掉共用 observer，最后一个走了才清', async () => {
  const lifetime = createQzoneSourceLifetime({ sessionLimit: 8, trackingLimit: 64 });
  const host = countingHost();
  // The handle must be bound to the CURRENT epoch of that lifetime, otherwise
  // generationIsCurrent() fails on the first ledgerFor() call and no adapter is ever
  // installed (the precondition assertions below would then fail for the wrong reason).
  const handle = await newHandle(host, { sourceLifetime: lifetime, epoch: lifetime.sourceEpoch() });
  const ctxA = agentCtx();
  const ctxB = agentCtx();
  addAgent(host, 'agent-A', 'sess-shared', ctxA);
  addAgent(host, 'agent-B', 'sess-shared', ctxB);
  const withObserver = host.count(COUNTED);
  assert.equal(handle.status('sess-shared').agentAdapters, 2);

  ctxA.fire('agent/pre-step', { turn: 0, step: 1, messages: [] });
  assert.equal(lifetime.getLedger('sess-shared').alive(), false);

  host.emit('agent/disposed', { agent: { id: 'agent-A', session: { id: 'sess-shared' } } });
  assert.equal(host.count(COUNTED), withObserver,
    '还有 agent 在该会话上时不得提前 dispose 共用的 observer');

  host.emit('agent/disposed', { agent: { id: 'agent-B', session: { id: 'sess-shared' } } });
  assert.equal(host.count(COUNTED), withObserver - 1, '最后一个 agent 退出后才清');
  assert.equal(lifetime.getLedger('sess-shared').alive(), false, '全程不得换账本');
  await handle.dispose();
});

test('adapter 构造失败（坏 ctx）不留孤儿 observer', async () => {
  const host = countingHost();
  const handle = await newHandle(host);
  const before = host.count(COUNTED);

  // This agent's ctx cannot hand back a disposer, so the adapter constructor throws AFTER
  // the session observer was already created for its session.
  addAgent(host, 'agent-bad', 'sess-bad', agentCtx({ broken: true }));

  assert.equal(handle.status('sess-bad').adaptersFailed, 1, '前提：构造失败确实发生了');
  assert.equal(handle.status('sess-bad').agentAdapters, 0, '前提：这个 agent 没有拿到 adapter');
  assert.equal(handle.status('sess-bad').dispatchAvailable, false);
  assert.equal(host.count(COUNTED), before,
    '本次新建的 observer 必须随之回滚：失败的 agent 不该留下一个孤儿订阅');

  await handle.dispose();
  assert.equal(host.count(COUNTED), 0);
});

test('构造失败不得误伤别的 agent 正在用的 observer', async () => {
  const host = countingHost();
  const handle = await newHandle(host);
  // A healthy agent establishes the session observer…
  addAgent(host, 'agent-ok', 'sess-mixed', agentCtx());
  const withObserver = host.count(COUNTED);
  assert.equal(handle.status('sess-mixed').dispatchAvailable, true);

  // …then a second agent on the SAME session fails to construct. Its rollback must be
  // scoped to observers IT created; disposing the shared one would silently stop
  // recording `session/event` for `agent-ok`.
  //
  // Note on what is NOT asserted here: the adapter's own construction-failure path calls
  // `ledger.disconnect()` (pre-existing, pinned by
  // `test-qzone-agent-resume.mjs` "构造失败只计 adaptersFailed"), so this session's ledger
  // is already dead afterwards. That is a separate, known behaviour — this case is only
  // about the OBSERVER's ownership.
  addAgent(host, 'agent-bad', 'sess-mixed', agentCtx({ broken: true }));
  assert.equal(handle.status('sess-mixed').adaptersFailed, 1);
  assert.equal(host.count(COUNTED), withObserver,
    '共用 observer 不得被失败方 dispose：它还有别的 agent 在用');

  // A THIRD agent on the same session must still reuse that same observer rather than
  // build a second one — the count is the proof that it survived the failure.
  addAgent(host, 'agent-ok-2', 'sess-mixed', agentCtx());
  assert.equal(host.count(COUNTED), withObserver, '后续 agent 复用同一个 observer，不得新建第二个');

  await handle.dispose();
  assert.equal(host.count(COUNTED), 0, 'dispose 之后整体归零');
});

test('干净 agent/disposed 之后 dispose：监听器不重复计数也不残留', async () => {
  const host = countingHost();
  const before = host.count(COUNTED);
  const handle = await newHandle(host);
  const ctxOf = agentCtx();
  addAgent(host, 'agent-1', 'sess-clean', ctxOf);
  host.emit('agent/disposed', { agent: { id: 'agent-1', session: { id: 'sess-clean' } } });
  // Only the plugin's own subscription is left.
  assert.equal(host.count(COUNTED), before + 1, '干净退出后 observer 已解开，只剩插件自己那条');
  await handle.dispose();
  assert.equal(host.count(COUNTED), before, 'dispose 收尾必须归零（不能因为 observer 已走而少减或多减）');
});

test('observer 泄漏修好之后，dispose 的语义没有变：状态 disposed、不再派发、不复活', async () => {
  const host = countingHost();
  const handle = await newHandle(host);
  addAgent(host, 'agent-1', 'sess-after', agentCtx());
  await handle.dispose();

  const status = handle.status('sess-after');
  assert.equal(status.state, 'disposed');
  assert.equal(status.dispatchAvailable, false);
  assert.deepEqual(status.dispatchableSessions, []);

  // A late event on the same host must not resurrect anything or throw.
  host.emit('session/event', { id: 'sess-after' }, { type: 'turn/end', data: { turn: 1 } });
  host.emit('agent/created', { agent: { id: 'agent-2', session: { id: 'sess-after' }, ctx: agentCtx() } });
  assert.equal(handle.status('sess-after').dispatchAvailable, false);
  assert.equal(host.count(COUNTED), 0, 'disposed 之后的迟到事件不得重新订阅');
});
