import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzonePluginHandle, STATES } from '../plugins/qzone-safe/index.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

// Round-9 review (77d82a66, suggestion 3) narrowed `generationBound` to
// `generationIsCurrent() && !staleGenerationObserved`. The point was that the two
// fields must share ONE source: `dispatchAvailable` folds in the stale latch, so a
// bare `generationIsCurrent()` could report `generationBound: true` while
// `staleGenerationObserved: true` and `dispatchAvailable: false` — a trio that can
// never be acted on, because the latch is permanent while the injected epoch can be
// observed as "current" again.
//
// This case pins that: an injected lifetime that reports a newer epoch once (latching
// the stale flag) and then the original epoch again must NOT produce
// `generationBound: true`. Real lifetimes only move forward, so the shape is only
// reachable through injection — which is exactly why the field has to defend itself.

function fakeHost() {
  const callbacks = new Map();
  const registered = new Map();
  const on = (map) => (name, fn) => {
    const list = map.get(name) ?? [];
    list.push(fn);
    map.set(name, list);
    return () => { const index = list.indexOf(fn); if (index >= 0) list.splice(index, 1); };
  };
  return {
    callbacks, registered,
    ctx: { on: on(callbacks), tools: { register(tool) {
      registered.set(tool.name, tool);
      return () => registered.delete(tool.name);
    } } },
    emit(name, ...args) { for (const cb of callbacks.get(name) ?? []) cb(...args); },
  };
}

const defineTool = (tool) => tool;

function handleWithEpochs(epochs) {
  const host = fakeHost();
  const state = { index: 0 };
  // `getLedger` must return a REAL ledger: the pre-step adapter is built with
  // `ledgerFor(sessionId)`, so a throwing stub makes adapter construction fail and
  // the handle reports `agentAdapters: 0` forever — which would make the "healthy"
  // case fail for the wrong reason.
  const ledgers = new Map();
  const sourceLifetime = {
    sourceEpoch: () => epochs[Math.min(state.index, epochs.length - 1)],
    getLedger: (sessionId) => {
      let ledger = ledgers.get(sessionId);
      if (!ledger) {
        ledger = createQzoneOriginLedger({ sessionId, epoch: epochs[0], trackingLimit: 8 });
        ledgers.set(sessionId, ledger);
      }
      return ledger;
    },
    rotate() { throw new Error('not used by this case'); },
    ownsConsumption: () => false,
  };
  return { host, state,
    build: () => createQzonePluginHandle(host.ctx, { enabled: true }, {
      epoch: 'e1', defineTool, dispatch: async () => ({ ok: true }), sourceLifetime,
    }) };
}

test('staleGenerationObserved 一旦 latch，即使 epoch 又看起来是当前值，generationBound 也必须为 false', async () => {
  // 1. 建 handle 时 epoch 一致（'e1'）。
  const { host, state, build } = handleWithEpochs(['e1', 'e2', 'e1']);
  const handle = await build();
  assert.equal(handle.status().state, STATES.DISPATCH_READY);
  assert.equal(handle.status().generationBound, true, '起初代际一致');
  assert.equal(handle.status().staleGenerationObserved, false);

  // 2. 让 epoch 前进到 'e2'，再走一次需要账本的路径：失配 → purge → latch。
  state.index = 1;
  assert.throws(() => handle.registerBridgeRequest('s1', { requestId: 'r1', origin: 'qq-inbound' }),
    /来源代际不匹配/);
  assert.equal(handle.status().staleGenerationObserved, true, '失配必须被 latch 住');

  // 3. 让注入的 lifetime 又报回 'e1'（真实 lifetime 不会这样，但这正是该字段要防的形状）。
  state.index = 2;
  const status = handle.status();
  assert.equal(status.staleGenerationObserved, true, 'latch 是永久的，不随 epoch 回头而清除');
  assert.equal(status.generationBound, false,
    'epoch 看起来又是当前值时也不得报 generationBound:true —— 否则三个字段互相矛盾');
  assert.equal(status.dispatchAvailable, false);

  // 4. 必须建新 handle 才能恢复：这条路径不可自愈。
  const rebuilt = await build();
  assert.equal(rebuilt.status().generationBound, true);
  assert.equal(rebuilt.status().staleGenerationObserved, false, '新实例不带旧 latch');
  await rebuilt.dispose();
  await handle.dispose();
});

test('正常生命周期下 generationBound 与 dispatchAvailable 不得互相矛盾', async () => {
  const { host, build } = handleWithEpochs(['e1']);
  const handle = await build();
  host.emit('agent/created', { agent: { id: 'agent-1', session: { id: 's1' }, ctx: { on: () => () => {} } } });
  const status = handle.status();
  assert.equal(status.generationBound, true);
  assert.equal(status.staleGenerationObserved, false);
  assert.equal(status.dispatchAvailable, true);
  await handle.dispose();
});
