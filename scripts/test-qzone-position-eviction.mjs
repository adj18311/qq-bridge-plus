import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzonePluginHandle, MAX_POSITIONS } from '../plugins/qzone-safe/index.mjs';

// Offline only: fake Cordis ctx, fake tool registry, fake dispatcher.
//
// Pins the positions-eviction behaviour in plugins/qzone-safe/index.mjs:117-119.
// At MAX_POSITIONS only the OLDEST pending callId loses its position; every other
// in-flight call keeps working. The evicted call must fail closed with
// 'origin-unbound' — not silently succeed, and not throw.
// Filled from the plugin's own MAX_POSITIONS so this file cannot drift from
// plugins/qzone-safe/index.mjs:22 (independent review R5). Two callIds are emitted
// before the fill loop, so the loop only needs MAX_POSITIONS - 1 slots.
//
// Round-2 review N3: importing the constant means a mutated constant silently
// moves the test with it, so the value itself is pinned here as well. Changing the
// capacity is a deliberate product decision and has to be made in BOTH places.
//
// Round-3 review N3-followup: the pin lives inside a `test()` on purpose. A
// module-scope assert aborts the whole file when the constant changes, so the two
// real behaviour cases below would never execute and the total would silently drop
// from 602 to 601. Keeping it here pins the value AND still runs the behaviour.
const EXPECTED_MAX_POSITIONS = 4096;
const evictions = MAX_POSITIONS - 1;

test('MAX_POSITIONS 的数值本身被钉住：改容量必须同时改这里和 plugins/qzone-safe/index.mjs', () => {
  assert.equal(MAX_POSITIONS, EXPECTED_MAX_POSITIONS,
    'MAX_POSITIONS 数值本身必须被钉住，否则变异常量测试会跟着漂移');
});

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

test('位置表容量满时只淘汰最早的 callId：被淘汰的调用返回 origin-unbound，不静默成功也不抛异常', async () => {
  const host = fakeHost();
  const agentCallbacks = new Map();
  const dispatched = [];
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: 'e1', defineTool: (tool) => tool,
    dispatch: async (...args) => { dispatched.push(args); return { ok: true }; },
  });
  host.emit('agent/created', { agent: { id: 'agent-1', session: { id: 's1' },
    ctx: { on: (name, fn) => { const list = agentCallbacks.get(name) ?? []; list.push(fn);
      agentCallbacks.set(name, list); return () => {}; } } } });
  handle.registerBridgeRequest('s1', { requestId: 'r1', origin: 'qq-inbound' });
  for (const cb of agentCallbacks.get('agent/pre-step') ?? []) {
    cb({ turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'r1' } }] }, () => {});
  }
  const sendCall = (sessionId, callId) => host.emit('session/event', { id: sessionId },
    { type: 'tool/call', data: { turn: 1, step: 1, callId, name: 'qzone_read_posts' } });

  sendCall('s1', 'oldest');
  sendCall('s1', 'still-in-flight');
  // Fillers must be LIVE for this case: the eviction preference below drops dead
  // positions first, so only an all-live map reaches the FIFO fallback this test
  // is about. Every filler is a real callId in the same observed step, which the
  // ledger binds (one step may issue many calls), so `peekCall` resolves for all.
  for (let index = 0; index < evictions; index++) sendCall('s1', `filler-${index}`);

  const tool = host.registered.get('qzone_read_posts');
  const exec = (callId) => ({ agent: { session: { id: 's1' } }, callId });

  let evicted;
  await assert.doesNotReject(async () => { evicted = await tool.execute({ target_uin: 456 }, exec('oldest')); },
    '驱逐必须走返回值，不能抛异常');
  assert.deepEqual(evicted, { ok: false, error: 'origin-unbound' }, '被驱逐的调用必须失败关闭');
  assert.deepEqual(dispatched, [], '被驱逐的调用绝不能触达 dispatcher（不得静默成功）');
  assert.equal(handle.status().positionsEvictedLive, 1,
    '全部位置都还活着时只能牺牲最旧的一个，并且这次牺牲必须可观测');

  assert.deepEqual(await tool.execute({ target_uin: 456 }, exec('still-in-flight')), { ok: true });
  assert.equal(dispatched.length, 1, '只有仍在飞的那一次进入了 dispatcher');
  await handle.dispose();
});

test('同一 callId 重复上报会投毒该调用：不占额外位置，但调用必须失败关闭', async () => {
  const host = fakeHost();
  const agentCallbacks = new Map();
  const dispatched = [];
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: 'e1', defineTool: (tool) => tool,
    dispatch: async (...args) => { dispatched.push(args); return { ok: true }; },
  });
  host.emit('agent/created', { agent: { id: 'agent-1', session: { id: 's1' },
    ctx: { on: (name, fn) => { const list = agentCallbacks.get(name) ?? []; list.push(fn);
      agentCallbacks.set(name, list); return () => {}; } } } });
  handle.registerBridgeRequest('s1', { requestId: 'r1', origin: 'qq-inbound' });
  for (const cb of agentCallbacks.get('agent/pre-step') ?? []) {
    cb({ turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'r1' } }] }, () => {});
  }
  const emitCall = (sessionId, callId) => host.emit('session/event', { id: sessionId },
    { type: 'tool/call', data: { turn: 1, step: 1, callId } });
  const tool = host.registered.get('qzone_read_posts');
  const exec = (callId) => ({ agent: { session: { id: 's1' } }, callId });

  // Layer 1 — positions map: announcing an already-tracked callId must neither take
  // a new slot nor evict anyone. The map is filled to exactly MAX_POSITIONS and
  // 'keep' is the oldest key, so without the `!positions.has(callId)` guard the
  // first repeat would delete 'keep' and the second would delete 'bystander'.
  emitCall('s1', 'keep');
  emitCall('s1', 'bystander');
  for (let index = 0; index < MAX_POSITIONS - 2; index++) emitCall('unrelated-session', `filler-${index}`);
  for (let index = 0; index < 3; index++) emitCall('s1', 'keep');
  assert.deepEqual(await tool.execute({ target_uin: 456 }, exec('bystander')), { ok: true },
    '重复上报不得挤出其他在飞调用');
  assert.equal(dispatched.length, 1);

  // Layer 2 — origin ledger: the duplicate tool/call poisons the callId
  // (origin-ledger-offline.mjs observeToolCall => poisonedCalls), so this exact
  // call must stay fail-closed rather than silently succeed.
  assert.deepEqual(await tool.execute({ target_uin: 456 }, exec('keep')), { ok: false, error: 'origin-unbound' },
    '重复上报等于自毁：被投毒的调用必须失败关闭');
  assert.equal(dispatched.length, 1, '被投毒的调用绝不能触达 dispatcher');
  await handle.dispose();
});

// Independent review (round 6) P_positions_singleKeyCrossSession: the position map
// used to be keyed by the BARE callId while the value already carried sessionId, and
// `dispatchBound` deleted the entry before validating the session. So one session
// announcing a callId that another session had already announced destroyed the first
// session's pending entry, and the first session's own legitimate dispatch then failed
// closed with origin-unbound. T2 had reported this as `sessionALostItsOwnCall: true`.
//
// This pins the composite key: two sessions may announce the SAME callId, each keeps
// its own position, and each dispatch consumes only its own entry.
test('两个会话复用同一 callId 时各自保留位置：互不覆盖，也互不删除对方的在飞调用', async () => {
  const host = fakeHost();
  const agentCallbacks = new Map();
  const dispatched = [];
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: 'e1', defineTool: (tool) => tool,
    dispatch: async (...args) => { dispatched.push(args); return { ok: true }; },
  });
  const addAgent = (agentId, sessionId) => host.emit('agent/created', { agent: { id: agentId, session: { id: sessionId },
    ctx: { on: (name, fn) => { const list = agentCallbacks.get(`${sessionId}/${name}`) ?? []; list.push(fn);
      agentCallbacks.set(`${sessionId}/${name}`, list); return () => {}; } } } });
  const step = (sessionId) => {
    for (const cb of agentCallbacks.get(`${sessionId}/agent/pre-step`) ?? []) {
      cb({ turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'r1' } }] }, () => {});
    }
  };
  addAgent('agent-a', 'session-a');
  addAgent('agent-b', 'session-b');
  handle.registerBridgeRequest('session-a', { requestId: 'r1', origin: 'qq-inbound' });
  handle.registerBridgeRequest('session-b', { requestId: 'r1', origin: 'qq-inbound' });
  step('session-a');
  step('session-b');

  const shared = 'same-call-id';
  const sendCall = (sessionId) => host.emit('session/event', { id: sessionId },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: shared } });
  const tool = host.registered.get('qzone_read_posts');
  const exec = (sessionId) => ({ agent: { session: { id: sessionId } }, callId: shared });

  // Both sessions announce the same callId. With a bare key the second overwrites
  // the first, and the first session's own dispatch below would be origin-unbound.
  sendCall('session-a');
  sendCall('session-b');

  assert.deepEqual(await tool.execute({ target_uin: 456 }, exec('session-a')), { ok: true },
    'A 自己的调用不得被 B 的同名 callId 顶掉');
  assert.equal(dispatched.length, 1);
  assert.deepEqual(await tool.execute({ target_uin: 456 }, exec('session-b')), { ok: true },
    'B 的调用也必须能用自己的位置完成');
  assert.equal(dispatched.length, 2);

  // Each position is single-use: replaying either session's dispatch must fail closed.
  assert.deepEqual(await tool.execute({ target_uin: 456 }, exec('session-a')), { ok: false, error: 'origin-unbound' },
    '同一位置只能用一次');
  assert.equal(dispatched.length, 2, '被拒的调用绝不能触达 dispatcher');
  await handle.dispose();
});

// Codex round-7 point 1: the composite key used to be the string
// `${sessionId}:${callId}`, but BOTH halves may contain `:`. The session id charset
// is `[A-Za-z0-9_.:-]` (src/core/qzone-runtime-wiring.mjs:33, qzone-session-mapper.mjs:1)
// and the call id comes from the host, so `("a:b", "c")` and `("a", "b:c")` both
// render as `a:b:c`. The second announcement then overwrote the first session's
// pending position and that session's own dispatch failed closed with origin-unbound
// even though nobody replayed anything.
//
// The key is now JSON.stringify([sessionId, callId]), which is injective over string
// pairs, so no two different pairs can alias. This test pins that specific pair.
test('会话 ID 与 callId 都含冒号时位置不得混叠：a:b/c 与 a/b:c 是两个不同位置', async () => {
  const host = fakeHost();
  const agentCallbacks = new Map();
  const dispatched = [];
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: 'e1', defineTool: (tool) => tool,
    dispatch: async (...args) => { dispatched.push(args); return { ok: true }; },
  });
  const addAgent = (agentId, sessionId) => host.emit('agent/created', { agent: { id: agentId, session: { id: sessionId },
    ctx: { on: (name, fn) => { const list = agentCallbacks.get(`${sessionId}/${name}`) ?? []; list.push(fn);
      agentCallbacks.set(`${sessionId}/${name}`, list); return () => {}; } } } });
  const step = (sessionId, turn) => {
    for (const cb of agentCallbacks.get(`${sessionId}/agent/pre-step`) ?? []) {
      cb({ turn, step: 1, messages: [{ role: 'user', source: { rpcId: 'r1' } }] }, () => {});
    }
  };
  addAgent('agent-colon', 'a:b');
  addAgent('agent-plain', 'a');
  handle.registerBridgeRequest('a:b', { requestId: 'r1', origin: 'qq-inbound' });
  handle.registerBridgeRequest('a', { requestId: 'r1', origin: 'qq-inbound' });
  step('a:b', 1);
  step('a', 1);

  // Deliberately the pair that aliases under naive joining: "a:b" + "c" and "a" + "b:c".
  host.emit('session/event', { id: 'a:b' }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c' } });
  host.emit('session/event', { id: 'a' }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'b:c' } });

  const tool = host.registered.get('qzone_read_posts');
  const run = (sessionId, callId) => tool.execute({ target_uin: 456 }, { agent: { session: { id: sessionId } }, callId });

  assert.deepEqual(await run('a:b', 'c'), { ok: true },
    'a:b / c 的位置不得被 a / b:c 覆盖（旧 `${sessionId}:${callId}` 键会混叠成 a:b:c）');
  assert.equal(dispatched.length, 1);
  assert.deepEqual(await run('a', 'b:c'), { ok: true }, 'a / b:c 也必须是自己的位置');
  assert.equal(dispatched.length, 2);

  // Both are single-use, so no aliasing was introduced in the other direction.
  assert.deepEqual(await run('a:b', 'c'), { ok: false, error: 'origin-unbound' });
  assert.deepEqual(await run('a', 'b:c'), { ok: false, error: 'origin-unbound' });
  assert.equal(dispatched.length, 2);
  await handle.dispose();
});

// Independent review (round 9) 建议②: `positionIsDead` / `evictOnePosition` 的
// 「优先淘汰已失效位置」这一支在本文件里原本是零覆盖 —— 把 `positionIsDead` 改成恒
// false 之后本文件仍 5/5 全绿（防线只被 scripts/test-qzone-r8-review-fixes.mjs 的 F3
// 兜住）。这条用例把「失效位置优先被丢弃、且不算牺牲活调用」钉在这里。
test('位置表满时优先丢弃已失效的位置：活位置全部保留，计数不得增长', async () => {
  const host = fakeHost();
  const agentCallbacks = new Map();
  const dispatched = [];
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: 'e1', defineTool: (tool) => tool,
    dispatch: async (...args) => { dispatched.push(args); return { ok: true }; },
  });
  host.emit('agent/created', { agent: { id: 'agent-1', session: { id: 's1' },
    ctx: { on: (name, fn) => { const list = agentCallbacks.get(name) ?? []; list.push(fn);
      agentCallbacks.set(name, list); return () => {}; } } } });
  handle.registerBridgeRequest('s1', { requestId: 'r1', origin: 'qq-inbound' });
  for (const cb of agentCallbacks.get('agent/pre-step') ?? []) {
    cb({ turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'r1' } }] }, () => {});
  }
  const sendCall = (sessionId, callId) => host.emit('session/event', { id: sessionId },
    { type: 'tool/call', data: { turn: 1, step: 1, callId, name: 'qzone_read_posts' } });

  // 最旧的一条来自一个从未建立账本的会话：`positionIsDead` 对它返回 true
  // （`ledgers.get` 为 undefined），它永远不可能被 consume。
  sendCall('ghost-session', 'dead-oldest');
  // 其余全部是同一会话同一 step 的活位置（一个 step 可以发出多个调用），
  // `peekCall` 对它们都能解析出 turn/step。
  for (let index = 0; index < MAX_POSITIONS - 1; index++) sendCall('s1', `live-${index}`);

  // 第 MAX_POSITIONS + 1 条登记才触发淘汰。
  sendCall('s1', 'newcomer');

  assert.equal(handle.status().positionsEvictedLive, 0,
    '丢弃已失效的位置不算牺牲活调用：计数必须保持 0');

  const tool = host.registered.get('qzone_read_posts');
  const exec = (callId) => ({ agent: { session: { id: 's1' } }, callId });
  // 活位置全部保留：最旧的那个活 filler 与最新登记的都还能派发。
  assert.deepEqual(await tool.execute({ target_uin: 456 }, exec('live-0')), { ok: true },
    '淘汰必须落在失效位置上，最旧的活位置不得被牺牲');
  assert.deepEqual(await tool.execute({ target_uin: 456 }, exec('newcomer')), { ok: true },
    '触发淘汰的那次登记本身必须能派发');
  assert.equal(dispatched.length, 2);
  await handle.dispose();
});
// 上一条只挡住「失效位置不是最旧」的情况：那时 FIFO 恰好也选它，所以
// `positionIsDead` 被改成「恒为 true」也能通过 —— 因为恒 true 时淘汰仍会挑到
// 第一个条目（正是那个失效的）。真正能区分「按失效筛选」与「一律挑最旧」的，
// 是失效位置排在**活的**位置之后：正确实现跳过最旧（活）去丢后面的失效项，
// 恒 true 的实现则直接丢掉最旧那个活调用，用户的合法派发就没了。
test('失效位置排在最旧活位置之后时仍必须先丢失效项：不得牺牲更旧的活调用', async () => {
  const host = fakeHost();
  const agentCallbacks = new Map();
  const dispatched = [];
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: 'e1', defineTool: (tool) => tool,
    dispatch: async (...args) => { dispatched.push(args); return { ok: true }; },
  });
  host.emit('agent/created', { agent: { id: 'agent-1', session: { id: 's1' },
    ctx: { on: (name, fn) => { const list = agentCallbacks.get(name) ?? []; list.push(fn);
      agentCallbacks.set(name, list); return () => {}; } } } });
  handle.registerBridgeRequest('s1', { requestId: 'r1', origin: 'qq-inbound' });
  for (const cb of agentCallbacks.get('agent/pre-step') ?? []) {
    cb({ turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'r1' } }] }, () => {});
  }
  const sendCall = (sessionId, callId) => host.emit('session/event', { id: sessionId },
    { type: 'tool/call', data: { turn: 1, step: 1, callId, name: 'qzone_read_posts' } });

  // 顺序很关键：活的最旧项在前，失效项在后。
  sendCall('s1', 'live-oldest');
  for (let index = 0; index < MAX_POSITIONS - 2; index++) sendCall('s1', `live-${index}`);
  sendCall('ghost-session', 'dead-late');
  sendCall('s1', 'newcomer');

  assert.equal(handle.status().positionsEvictedLive, 0,
    '丢掉失效项不算牺牲活调用，计数必须保持 0');

  const tool = host.registered.get('qzone_read_posts');
  const exec = (callId) => ({ agent: { session: { id: 's1' } }, callId });
  assert.deepEqual(await tool.execute({ target_uin: 456 }, exec('live-oldest')), { ok: true },
    '最旧的活调用不是淘汰对象：失效项在它后面，必须跳过它去丢失效项');
  assert.equal(dispatched.length, 1);
  await handle.dispose();
});