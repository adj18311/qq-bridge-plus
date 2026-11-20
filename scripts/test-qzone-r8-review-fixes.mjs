import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzonePluginHandle, STATES } from '../plugins/qzone-safe/index.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneSourceLifetime } from '../src/core/qzone-source-lifetime-offline.mjs';

// Pins the three fixable findings of the round-8 independent review (R8 verdict,
// F1/F2/F3). Each case below failed against the frozen 653-revision bytes:
//
//   F1 (high) `ledgerFor` compared `sourceEpoch()` only while filling its cache, so
//      after ANY reconnect (`qzone-connection-source-coordinator-offline.mjs` calls
//      `sources.rotate()` on every open/close/error) every cached ledger stayed bound
//      to the retired generation: register threw `来源账本不可用或已满`, dispatch
//      returned `origin-unbound`, nothing was audited, and `status()` still reported
//      dispatch-ready.
//   F2 (high) one late/out-of-order pre-step latched `continuityLost` (or walked
//      `maxTurn` past the genuine turn) and permanently disabled the subsystem, with
//      no audit row and a `status()` that still said ready.
//   F3 (medium) capacity eviction dropped the oldest position blindly, so a still
//      consumable pending call was sacrificed with zero audit and zero notice.

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

function agentCtx() {
  const callbacks = new Map();
  return {
    callbacks,
    ctx: { on: (name, fn) => {
      const list = callbacks.get(name) ?? [];
      list.push(fn);
      callbacks.set(name, list);
      return () => {};
    } },
    preStep(payload) {
      for (const cb of callbacks.get('agent/pre-step') ?? []) cb(payload, () => {});
    },
  };
}

const defineTool = (tool) => tool;

test('F1 换代后插件必须报告未就绪并拒绝一切登记，不得继续用已退役代的账本', async () => {
  // A real lifetime: `rotate()` retires every cached ledger and mints a new epoch.
  const lifetime = createQzoneSourceLifetime();
  const host = fakeHost();
  const dispatched = [];
  // `sourceLifetime` is the hook the plugin uses to obtain (and validate) ledgers.
  const runtime = {
    epoch: lifetime.sourceEpoch(),
    sourceLifetime: lifetime,
    defineTool,
    dispatch: async (...args) => { dispatched.push(args); return { ok: true }; },
  };
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, runtime);
  assert.equal(handle.status().state, STATES.DISPATCH_READY);
  // A ready handle still needs one pre-step adapter (`agent/created`) before any
  // `tool/call` can be observed; without it dispatch is impossible and the status
  // must say so instead of promising a dispatch that can never bind.
  assert.equal(handle.status().dispatchAvailable, false, '没有 agent 时不得报 dispatch-ready');
  assert.equal(handle.status().agentAdapters, 0);
  host.emit('agent/created', { agent: { id: 'agent-1', session: { id: 's1' }, ctx: { on: () => () => {} } } });
  assert.equal(handle.status().agentAdapters, 1);
  assert.equal(handle.status().dispatchAvailable, true);
  assert.equal(handle.status().generationBound, true);

  // Warm the cache: this is the step that used to strand the plugin.
  handle.registerBridgeRequest('s1', { requestId: 'r1', origin: 'qq-inbound' });

  // Real reconnect: the old generation is retired on the spot.
  lifetime.rotate();

  // The cached ledger is now bound to a retired epoch. Reporting must not lie…
  const afterRotate = handle.status();
  assert.equal(afterRotate.generationBound, false, '换代后 generationBound 必须为 false');
  assert.equal(afterRotate.dispatchAvailable, false, '换代后绝不能继续报 dispatch-ready');
  assert.equal(afterRotate.state, STATES.DISPATCH_READY, 'state 是构造期快照，不改它');

  // …and every use must fail closed instead of surfacing a confusing error from
  // inside a runtime that still holds the retired epoch.
  assert.throws(() => handle.registerBridgeRequest('s1', { requestId: 'r2', origin: 'qq-inbound' }),
    /来源代际不匹配/, '换代后登记必须明确失败，不得沿用旧账本');
  host.emit('session/event', { id: 's1' }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'qzone_read_posts' } });
  const tool = host.registered.get('qzone_read_posts');
  assert.deepEqual(await tool.execute({ target_uin: 456 }, { agent: { session: { id: 's1' } }, callId: 'c1' }),
    { ok: false, error: 'origin-unbound' }, '换代后派发必须失败关闭');
  assert.deepEqual(dispatched, [], '退役代的调用绝不能触达 dispatcher');

  // Recovery is a NEW runtime + handle for the new generation; the old handle must
  // never re-home itself onto it.
  const freshHost = fakeHost();
  const freshRuntime = {
    epoch: lifetime.sourceEpoch(), sourceLifetime: lifetime, defineTool,
    dispatch: async (...args) => { dispatched.push(args); return { ok: true }; },
  };
  const fresh = await createQzonePluginHandle(freshHost.ctx, { enabled: true }, freshRuntime);
  assert.equal(fresh.status().dispatchAvailable, false, '新一代也必须先有 agent 才算就绪');
  freshHost.emit('agent/created', { agent: { id: 'agent-2', session: { id: 's1' }, ctx: { on: () => () => {} } } });
  assert.equal(fresh.status().agentAdapters, 1);
  assert.equal(fresh.status().dispatchAvailable, true, '新一代必须重新就绪');
  await fresh.dispose();
  await handle.dispose();
});

test('F2 迟到或乱序的 pre-step 不得永久毒化账本：真正的下一个回合仍必须能绑定', async () => {
  // Branch A — a turn that has already closed, delivered again while nothing is in
  // flight. `ended` only remembers the last 64 turns, so an older number reaches the
  // `activeTurn === null` path instead of the `ended` check.
  const closed = createQzoneOriginLedger({ sessionId: 's1', epoch: 'e1', trackingLimit: 8 });
  closed.registerBridgeRequest({ requestId: 'r1', origin: 'qq-inbound' });
  assert.equal(closed.observeStep({ sessionId: 's1', turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'r1' } }] }), true);
  assert.equal(closed.endTurn({ sessionId: 's1', turn: 1 }), true);
  assert.equal(closed.observeStep({ sessionId: 's1', turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'r1' } }] }), false, '迟到的重复回合必须被拒');
  closed.registerBridgeRequest({ requestId: 'r2', origin: 'qq-inbound' });
  assert.equal(closed.observeStep({ sessionId: 's1', turn: 2, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'r2' } }] }), true, '真正的下一回合必须仍可绑定');

  // Branch B — a turn OLDER than the one currently in flight. This is the branch that
  // used to latch `continuityLost`: reaching it needs a first turn that is not 1,
  // which the ledger allows on purpose (a rotation resumes a session mid-numbering),
  // so a stale low turn is not in `ended` and lands here instead of the check above.
  const inflight = createQzoneOriginLedger({ sessionId: 's2', epoch: 'e1', trackingLimit: 8 });
  inflight.registerBridgeRequest({ requestId: 'q1', origin: 'qq-inbound' });
  assert.equal(inflight.observeStep({ sessionId: 's2', turn: 10, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'q1' } }] }), true, '首回合可以是任意编号');
  assert.equal(inflight.observeStep({ sessionId: 's2', turn: 3, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'q1' } }] }), false, '比在飞回合更旧的 pre-step 必须被拒');
  assert.equal(inflight.endTurn({ sessionId: 's2', turn: 10 }), true);
  inflight.registerBridgeRequest({ requestId: 'q2', origin: 'qq-inbound' });
  assert.equal(inflight.observeStep({ sessionId: 's2', turn: 11, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'q2' } }] }), true,
    '乱序的旧回合之后，真正的下一回合仍必须能绑定（不得 latch continuityLost）');
  assert.equal(inflight.observeToolCall({ sessionId: 's2',
    event: { type: 'tool/call', data: { turn: 11, step: 1, callId: 'c11', name: 'qzone_read_posts' } } }), true);
  assert.equal(inflight.consume({ sessionId: 's2', turn: 11, step: 1, callId: 'c11' })?.requestId, 'q2',
    '乱序事件之后仍必须能铸出绑定');
});

test('F2 向前跳跃仍必须判定证据丢失：真跳跃不得被放宽成正常续接', async () => {
  const ledger = createQzoneOriginLedger({ sessionId: 's1', epoch: 'e1', trackingLimit: 8 });
  ledger.registerBridgeRequest({ requestId: 'r1', origin: 'qq-inbound' });
  assert.equal(ledger.observeStep({ sessionId: 's1', turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'r1' } }] }), true);
  assert.equal(ledger.endTurn({ sessionId: 's1', turn: 1 }), true);
  // Skipping turn 2 is lost evidence, not a late delivery: it must still fail closed.
  assert.equal(ledger.observeStep({ sessionId: 's1', turn: 3, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'r9' } }] }), false, '向前跳跃必须拒绝');
  assert.throws(() => ledger.registerBridgeRequest({ requestId: 'r2', origin: 'qq-inbound' }),
    /来源账本/, '跳跃之后账本必须继续拒绝（丢失证据不得自愈）');
});

test('F3 容量驱逐必须先淘汰已失效的位置：仍在飞的可消费位置不得被牺牲', async () => {
  const host = fakeHost();
  const agent = agentCtx();
  const dispatched = [];
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: 'e1', defineTool, dispatch: async (...args) => { dispatched.push(args); return { ok: true }; },
  });
  host.emit('agent/created', { agent: { id: 'agent-1', session: { id: 's1' }, ctx: agent.ctx } });
  handle.registerBridgeRequest('s1', { requestId: 'r1', origin: 'qq-inbound' });
  agent.preStep({ turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'r1' } }] });

  const emitCall = (sessionId, callId) => host.emit('session/event', { id: sessionId },
    { type: 'tool/call', data: { turn: 1, step: 1, callId, name: 'qzone_read_posts' } });

  // One genuine pending call whose ledger binding really exists.
  emitCall('s1', 'live');

  // Fill the map with positions that can NEVER be consumed: their session has no
  // ledger at all, so `peekCall` cannot resolve. These are the honest eviction
  // candidates, and there are more of them than slots.
  const { MAX_POSITIONS } = await import('../plugins/qzone-safe/index.mjs');
  for (let index = 0; index < MAX_POSITIONS + 16; index++) emitCall('ghost-session', `ghost-${index}`);

  // The live call must survive: capacity was exhausted by dead entries.
  const tool = host.registered.get('qzone_read_posts');
  assert.deepEqual(await tool.execute({ target_uin: 456 }, { agent: { session: { id: 's1' } }, callId: 'live' }),
    { ok: true }, '仍在飞的可消费位置绝不能因挤占而被牺牲');
  assert.equal(dispatched.length, 1);
  assert.equal(handle.status().positionsEvictedLive, 0,
    '只要存在失效位置就不得牺牲活位置');
  await handle.dispose();
});

test('F2 适配器必须把被拒的 pre-step 记录下来，而不是静默吞掉返回值', async () => {
  const host = fakeHost();
  const agent = agentCtx();
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: 'e1', defineTool, dispatch: async () => ({ ok: true }),
  });
  host.emit('agent/created', { agent: { id: 'agent-1', session: { id: 's1' }, ctx: agent.ctx } });
  // No bridge request registered: this step cannot bind, so the ledger refuses it.
  agent.preStep({ turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'unknown' } }] });
  assert.equal(handle.status().stepsRefused, 1, '被拒的 pre-step 必须可观测');
  // A refusal is not a fault: the adapter stays subscribed so later turns still work.
  // The refused turn is closed first — replaying the SAME (turn, step) is a duplicate
  // and is refused on purpose, so the positive control has to be a real next turn.
  host.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { turn: 1 } });
  handle.registerBridgeRequest('s1', { requestId: 'r1', origin: 'qq-inbound' });
  agent.preStep({ turn: 2, step: 1, messages: [{ role: 'user', source: { rpcId: 'r1' } }] });
  assert.equal(handle.status().stepsRefused, 1, '成功绑定的 pre-step 不得计入拒绝');
  await handle.dispose();
});
