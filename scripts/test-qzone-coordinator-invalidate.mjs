// Pins the ONE shape that is actually injected in production-like wiring: the facade
// returned by `createQzoneConnectionSourceCoordinator`.
//
// Background (R12-1, reviewer finding): `plugins/qzone-safe/index.mjs`'s `releaseLedger()`
// calls `runtime?.sourceLifetime?.invalidate?.(sessionId)` on a clean `agent/disposed` so
// a later resume of the same session can mint a fresh ledger. The optional chaining made
// a facade WITHOUT `invalidate` look wired while the whole recovery path was a no-op:
//
//   typeof coordinator.invalidate === undefined
//   clean dispose  -> getLedger returned the SAME (disconnected) ledger
//   after resume   -> adaptersBlocked=1, agentAdapters=0, dispatchAvailable=false
//   resume dispatch -> threw "来源账本不可用或已满"
//
// i.e. the session was permanently undispatchable until the connection turned over,
// behind a status that honestly said false. The suite stayed green because the only
// resume test injected a BARE `createQzoneSourceLifetime` (which does have
// `invalidate`) while the only coordinator test never disposed an agent — the gap sat
// exactly between the two files.
//
// These cases therefore inject the coordinator, not a bare lifetime.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createQzonePluginHandle } from '../plugins/qzone-safe/index.mjs';
import { createQzoneConnectionSourceCoordinator } from '../src/core/qzone-connection-source-coordinator-offline.mjs';

const TOOL = 'qzone_read_posts';
const BOT = 123;
const FRIEND = 456;
const defineTool = (tool) => tool;
const execFor = (sessionId, callId) => ({ agent: { session: { id: sessionId } }, callId });
const userMessage = (requestId) => ({ role: 'user', source: { rpcId: requestId } });

function fakeClient() {
  const listeners = new Map();
  return {
    middlewares: [],
    on(name, fn) {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
      return () => {};
    },
    off(name, fn) {
      const list = listeners.get(name) ?? [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    use() { return () => {}; },
    // The identity guard reads `result.user_id` OFF THE RESULT (not `result.data.user_id`),
    // so wrapping it OneBot-style (`{status, retcode, data:{user_id}}`) makes `verify()`
    // return false forever and every assertion downstream fails on the premise instead of
    // on the thing under test.
    async getLoginInfo() { return { user_id: BOT }; },
    // `bindQzoneConnectionEpoch` only reports a usable epoch after an `open` event; a
    // client that never emits one leaves `current()` at -1 and `verify()` returns false.
    emit(name, ...args) {
      for (const fn of listeners.get(name) ?? []) fn(...args);
    },
  };
}

function fakeHost() {
  const listeners = new Map();
  const registered = new Map();
  return {
    registered,
    ctx: {
      on(name, fn) {
        const list = listeners.get(name) ?? [];
        list.push(fn);
        listeners.set(name, list);
        return () => {
          const index = list.indexOf(fn);
          if (index >= 0) list.splice(index, 1);
        };
      },
      tools: { register: (tool) => { registered.set(tool.name, tool); return () => registered.delete(tool.name); } },
    },
    emit(name, ...args) {
      for (const fn of listeners.get(name) ?? []) fn(...args);
    },
  };
}

function agentCtx() {
  const callbacks = new Map();
  return {
    on(name, fn) {
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

async function wiredCoordinator() {
  const host = fakeHost();
  const client = fakeClient();
  const coordinator = createQzoneConnectionSourceCoordinator({ client, expectedUserId: BOT });
  // The epoch tracker only counts a live connection after `open`; without this emit the
  // facade reports `connectionEpoch: -1` and refuses to verify.
  client.emit('open');
  assert.equal(await coordinator.verify(), true, '前提：coordinator 必须 verified，否则 getLedger 抛 source unavailable');
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    dispatch: async () => ({ ok: true }),
    epoch: coordinator.sourceEpoch(),
    sourceLifetime: coordinator,
    defineTool,
  });
  return { coordinator, host, handle, client };
}

let turnCounter = 0;
async function armAndRun(host, handle, coordinator, sessionId, { agentKey, ctxOf, requestId, callId }) {
  turnCounter += 1;
  const turn = turnCounter;
  // The plugin registers the bridge request on itself; the ledger must be the live one.
  void coordinator;
  handle.registerBridgeRequest(sessionId, { requestId, origin: 'qq-inbound' });
  ctxOf.fire('agent/pre-step', { turn, step: 1, messages: [userMessage(requestId)] });
  host.emit('session/event', { id: sessionId }, { type: 'tool/call', data: { turn, step: 1, callId, name: TOOL } });
  const result = await host.registered.get(TOOL).execute({ target_uin: FRIEND }, execFor(sessionId, callId));
  host.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn } });
  return result;
}

test('coordinator facade 必须转发 invalidate：否则 resume 之后会话永久不可派发', async () => {
  const { coordinator, host, handle } = await wiredCoordinator();
  assert.equal(typeof coordinator.invalidate, 'function',
    'coordinator 必须暴露 invalidate —— 插件侧的 releaseLedger 靠它才能换掉已断流的账本');

  const SESSION = 'sess-coord';
  const ctxA = agentCtx();
  host.emit('agent/created', { agent: { id: 'agent-A', session: { id: SESSION }, ctx: ctxA } });

  const before = await armAndRun(host, handle, coordinator, SESSION, { agentKey: 'agent-A', ctxOf: ctxA, requestId: 'r-1', callId: 'c-1' });
  assert.deepEqual(before, { ok: true }, '前提：干净关闭之前这条会话必须真的能派发');

  const liveLedger = coordinator.getLedger(SESSION);

  // Clean shutdown of the agent — this is what DSH does on session re-entry.
  host.emit('agent/disposed', { agent: { id: 'agent-A', session: { id: SESSION } } });

  // The whole point of the forwarding: the session's ledger must be dropped so the next
  // lookup mints a fresh one. Without the forward this object is handed back forever and
  // `alive()` stays false.
  assert.notEqual(coordinator.getLedger(SESSION), liveLedger,
    'clean dispose 之后 coordinator 必须换一本新账本；拿回同一本说明 invalidate 被静默跳过');

  const ctxB = agentCtx();
  host.emit('agent/created', { agent: { id: 'agent-B', session: { id: SESSION }, ctx: ctxB } });
  const status = handle.status(SESSION);
  assert.equal(status.dispatchAvailable, true, 'resume 之后必须重新可派发');
  assert.equal(status.adaptersBlocked, 0, '不应当因为「账本已死」被拒绝装 adapter');

  const after = await armAndRun(host, handle, coordinator, SESSION, { agentKey: 'agent-B', ctxOf: ctxB, requestId: 'r-2', callId: 'c-2' });
  assert.deepEqual(after, { ok: true }, 'resume 之后必须真的能派发，而不只是 status 说能');
  await handle.dispose();
  coordinator.dispose();
});

test('coordinator 未就绪时不假装能失效：invalidate 返回 false 且不抛', async () => {
  const client = fakeClient();
  const coordinator = createQzoneConnectionSourceCoordinator({ client, expectedUserId: BOT });
  // Not verified yet: `getLedger` throws `source unavailable`, so there is no trustworthy
  // ledger to revoke. Returning false (not throwing) keeps `releaseLedger`'s optional call
  // total while still refusing to pretend the revocation happened.
  assert.equal(coordinator.isReady(), false);
  assert.equal(coordinator.invalidate('sess-any'), false, '未就绪时必须明确返回 false');
  client.emit('open');
  await coordinator.verify();
  assert.equal(coordinator.isReady(), true, '前提：verify 之后必须就绪');
  assert.equal(coordinator.invalidate('sess-never-seen'), false, '从未登记的会话没有账本可撤，返回 false');
  coordinator.dispose();
});

test('invalidate 只影响目标会话，不波及其他会话的代际', async () => {
  const { coordinator, host, handle } = await wiredCoordinator();
  const epochBefore = coordinator.sourceEpoch();
  host.emit('agent/created', { agent: { id: 'agent-1', session: { id: 'sess-1' }, ctx: agentCtx() } });
  host.emit('agent/created', { agent: { id: 'agent-2', session: { id: 'sess-2' }, ctx: agentCtx() } });

  const ledger1 = coordinator.getLedger('sess-1');
  const ledger2 = coordinator.getLedger('sess-2');

  assert.equal(coordinator.invalidate('sess-1'), true);
  assert.notEqual(coordinator.getLedger('sess-1'), ledger1, '目标会话必须换账本');
  assert.equal(coordinator.getLedger('sess-2'), ledger2, '别的会话的账本不得被动过');
  assert.equal(coordinator.sourceEpoch(), epochBefore, 'invalidate 不改代际（这是它比 rotate 弱的地方）');
  assert.equal(handle.status('sess-2').dispatchAvailable, true, '别的会话必须仍然可派发');
  await handle.dispose();
  coordinator.dispose();
});
