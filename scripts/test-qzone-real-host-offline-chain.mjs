import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOfflineHostFixture } from './qzone-host-prestep-fixture.mjs';
import { createQzonePluginHandle } from '../plugins/qzone-safe/index.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createQzoneConnectionSourceCoordinator } from '../src/core/qzone-connection-source-coordinator-offline.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

// t48: the count fields were REMOVED (R12b-24 counting side channel). The success shape is now just
// `{ok, outcome:'success', posts}` — no `page`, no counts of any kind. This constant is what the
// reader/wiring pair returns for the fake platform `{ total: 0, msglist: [] }` in this file.
const SUCCESS_WITH_EMPTY_PAGE = Object.freeze({
  ok: true, outcome: 'success', posts: [],
});
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';

test('真实 DSH 离线宿主：用户来源经工具流水线进入只读空间，写入关闭', async (t) => {
  let h;
  try { h = await loadOfflineHostFixture(); }
  catch (error) { if (/本机找不到 DSH app\.asar/u.test(error.message)) { t.skip(error.message); return; } throw error; }
  const { cordis, session, projection, agent, agentLoop, llm, tools, systemPrompt, nativeExecutor } = h;
  const root = new cordis.Context();
  let handle, agentHandle, disposeAdapter;
  let fakeBridge;
  const calls = [], outputs = [];
  const now = Date.parse('2026-11-10T04:00:00Z');
  const initialState = { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true, like: true }, reads: 0, writes: 0, readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-10', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {}, activeStart: 0, activeEnd: 1439, audit: [] };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-real-host-offline-'));
  const dbPath = path.join(temp, 'state.db');
  let store = openOfflineStore(dbPath, initialState);
  class NeverConnect {}
  const fakeClient = new SnowLumaWebSocketClient({ webSocket: NeverConnect, reconnect: false });
  fakeClient.getLoginInfo = async () => ({ user_id: 123 });
  fakeClient.request = async (action) => {
    calls.push(action);
    if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
    if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
    if (action === 'get_qzone_msg_list') return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
    throw new Error('unexpected fake action');
  };
  const sourceLifetime = createQzoneConnectionSourceCoordinator({ client: fakeClient, expectedUserId: 123 });
  try {
    fakeClient.emitter.emit('open');
    assert.equal(await sourceLifetime.verify(), true);
    for (const plugin of [projection.SessionProjectionRegistry, session.SessionStore, agent.AgentRegistry,
      systemPrompt.SystemPrompt, llm.LlmRuntime, tools.ToolRuntime, nativeExecutor, agentLoop.AgentLoop]) root.plugin(plugin);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const runtime = createQzoneRuntime({ store, botQq: 123, sourceEpoch: sourceLifetime.sourceEpoch(),
      authorizeSource: (c) => sourceLifetime.ownsConsumption(c), getConnectionEpoch: sourceLifetime.connectionEpoch,
      getBridgeSessions: () => null, clock: () => now, mode: 'read-only',
      call: (action, params) => fakeClient.request(action, params) });
    handle = await createQzonePluginHandle(root, { enabled: true }, { epoch: sourceLifetime.sourceEpoch(), sourceLifetime, defineTool: tools.defineTool,
      dispatch: async (...args) => { const out = await runtime.dispatch(...args); outputs.push(out); return out; } });
    assert.equal(handle.status().state, 'enabled-dispatch-ready');
    let modelRequests = 0;
    class FakeAdapter extends llm.LlmAdapter {
      providerInfo(provider) { return { id: provider, name: provider }; }
      resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }); }
      async *stream() {
        const step = modelRequests++;
        if (step === 0) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'offline-call', name: 'qzone_read_posts', arguments: '{"target_uin":456}' } };
          yield { type: 'block-start', index: 1, blockType: 'tool-call' };
          yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'offline-write', name: 'qzone_like', arguments: '{"tid":"fixture","target_uin":456}' } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else if (step === 2) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'unregistered-call', name: 'qzone_read_posts', arguments: '{"target_uin":456}' } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: 'done' };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
    }
    disposeAdapter = root.get('llm').registerAdapter(['offline'], new FakeAdapter());
    agentHandle = await root.get('agents').create({ sessionId: 'offline-qzone-session', agentOptions: { provider: 'offline', model: 'fixture' } });
    // The actual bridge delivery path runs inside a temporary VM. This adapter
    // stands in for an authenticated cross-process registration channel; it
    // is NOT evidence that such a channel exists in production.
    fakeBridge = await bridgeHarness();
    fakeBridge.api.sessions.create = async () => ({ result: { ok: true, value: { sessionId: 'offline-qzone-session' } } });
    const requestId = '123e4567-e89b-42d3-a456-426614174000';
    fakeBridge.api.sessions.prompt = async (params) => {
      assert.equal(params.requestId, requestId);
      handle.registerBridgeRequest(params.sessionId, { requestId: params.requestId, origin: 'qq-inbound' });
      agentHandle.agent.followup(llm.createUserMessage({ content: params.content,
        source: { kind: 'user', rpcId: params.requestId } }));
      return { result: { ok: true, value: {} } };
    };
    assert.equal((await fakeBridge.deliverPrompt('group:456', 'offline', { requestId })).ok, true);
    await agentHandle.agent.whenIdle();
    assert.equal(outputs.length, 2);
    assert.ok(outputs.some((output) => output.outcome === 'success'));
    assert.ok(outputs.some((output) => output.error === 'write-not-wired'));
    assert.equal(calls.filter((action) => action === 'get_qzone_msg_list').length, 1);
    const audit = store.read().audit;
    assert.deepEqual(Object.values(store.read().readOutcomes), ['success']);
    assert.equal(store.read().writes, 0, 'rejected write must not consume a write allowance');
    assert.ok(audit.some((item) => item.id.startsWith('read_intent_')), 'read intent must be persisted');
    assert.ok(audit.some((item) => item.id.startsWith('read:') && item.record.result === 'success'), 'read outcome must be persisted');
    assert.ok(audit.some((item) => item.record.action === 'like' && item.record.result === 'denied'), 'disabled write must be audited');
    const callsBeforeUnknown = calls.length;
    agentHandle.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'unregistered input' }],
      source: { kind: 'user', rpcId: 'unknown-rpc' } }));
    await agentHandle.agent.whenIdle();
    assert.equal(modelRequests, 4, 'unregistered turn must exercise the host tool pipeline');
    assert.equal(calls.length, callsBeforeUnknown, 'unregistered input must not reach fake QQ transport');
    store.close();
    store = openOfflineStore(dbPath, initialState);
    assert.ok(store.read().audit.length > 0, 'audit must survive store reopening');
    assert.equal(handle.status().dispatchAvailable, true, 'in-process dispatch binding only; not production cross-process authentication');
  } finally {
    await handle?.dispose();
    sourceLifetime.dispose();
    await fakeBridge?.close();
    try { agentHandle?.dispose?.(); } catch {}
    try { disposeAdapter?.(); } catch {}
    await root.dispose?.();
    await h.close?.();
    store.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// ── R12-4 E (Codex finding 5): the OFFLINE HOST CHAIN must cover the multi-agent
// lifecycle, not just the single-agent happy path.
//
// Codex: "real-host-offline-chain 至少补双 agent 派发、一个退出后继续、最后退出后 resume、
// 故障状态和重放，以及观察器创建后 adapter 失败的清理。"
//
// What is REAL here (same fixture as the test above): Cordis root, SessionStore,
// AgentRegistry, LlmRuntime + the real agent loop, SystemPrompt, ToolRuntime, the native
// tool executor, the real qzone plugin handle, the real origin ledger, and the real
// read-only runtime wiring with a fake OneBot client. Agent A runs genuine turns through
// the real tool pipeline.
//
// What is SYNTHETIC, and why (stated plainly rather than dressed up):
//   - The SECOND agent on the same session. The real registry rejects it —
//     `agents.create({sessionId: <live id>})` throws `session "<id>" already exists`
//     (measured). One session cannot host two real agents, but the plugin's contract is
//     defined for exactly that case, so agent B is announced with a `ctx` that records its
//     `agent/pre-step` listener. That is the same shape the host delivers; the plugin
//     cannot tell it apart, and the test only claims what it can see.
//   - `session/event` delivery for B's turn. The projection registry (`drive()`) requires a
//     real committed event with a sequence number, so a synthesized event cannot be pushed
//     through `root.emit`. Instead the plugin's OWN captured listeners are invoked directly
//     — the host's delivery shape `(session, event)` — which is what the observer consumes.
//     This does NOT exercise the host's commit path; the test above does, for one agent.
//   - `resume()`. It is unavailable in this fixture: with no session-persistence backend
//     loaded it throws `cannot resume: session persistence is not configured` (measured).
//     The state a resume lands in — clean last-agent boundary, fresh ledger for the same
//     session id — is produced by re-creating the agent on that session instead. The
//     resume SHAPE itself (agent id, ledger replacement, `adaptersBlocked`) is pinned by
//     `scripts/test-qzone-agent-resume.mjs` against a fake host.
//
// Evidence scope: this is an OFFLINE host with a fake OneBot transport and a fake LLM
// adapter. It is NOT evidence that the chain works against a real QQ account, a real DSH
// release, or a cross-process bridge — see the declaration at the end of the test.
test('真实 DSH 离线宿主：多 agent 生命周期链（双 agent/继续/重建/故障/重放/孤儿观察器）', async (t) => {
  let h;
  try { h = await loadOfflineHostFixture(); }
  catch (error) { if (/本机找不到 DSH app\.asar/u.test(error.message)) { t.skip(error.message); return; } throw error; }
  const { cordis, session, projection, agent, agentLoop, llm, tools, systemPrompt, nativeExecutor } = h;
  const root = new cordis.Context();
  let handle, disposeAdapter, agentA, agentA2, agentC, agentD;
  let fakeBridge;
  const platformCalls = [];
  const outputs = [];
  const now = Date.parse('2026-11-10T04:00:00Z');
  const initialState = { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true, like: true }, reads: 0, writes: 0, readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-10', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {}, activeStart: 0, activeEnd: 1439, audit: [] };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-real-host-chain-'));
  const dbPath = path.join(temp, 'state.db');
  const store = openOfflineStore(dbPath, initialState);
  class NeverConnect {}
  const fakeClient = new SnowLumaWebSocketClient({ webSocket: NeverConnect, reconnect: false });
  fakeClient.getLoginInfo = async () => ({ user_id: 123 });
  fakeClient.request = async (action) => {
    platformCalls.push(action);
    if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
    if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
    if (action === 'get_qzone_msg_list') return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
    throw new Error('unexpected fake action');
  };
  const coordinator = createQzoneConnectionSourceCoordinator({ client: fakeClient, expectedUserId: 123 });

  // Ledger seam: a plain delegating wrapper (a Proxy is rejected — the ledger object is
  // frozen, so `get` would have to return the identical property descriptor). It records
  // what the OBSERVER forwards to `observeToolCall`, which is how "the replay reached the
  // ledger and the ledger refused it" is told apart from "the observer swallowed it".
  // Deliberately NOT cached: a clean release calls `invalidate()` and the next lookup must
  // mint a fresh ledger, exactly like the real coordinator does.
  const forwardedToolCalls = [];
  const wrapLedger = (sessionId) => {
    const real = coordinator.getLedger(sessionId);
    const wrapper = {
      observeStep: (input) => real.observeStep(input),
      observeToolCall: (input) => {
        const result = real.observeToolCall(input);
        forwardedToolCalls.push({ sessionId, callId: input?.event?.data?.callId ?? null, result });
        return result;
      },
      peekCall: (callId) => real.peekCall(callId),
      consume: (input) => real.consume(input),
      endTurn: (input) => real.endTurn(input),
      disconnect: () => real.disconnect(),
      reconnect: () => real.reconnect(),
      alive: () => real.alive(),
      stats: () => real.stats(),
      registerBridgeRequest: (input) => real.registerBridgeRequest(input),
      ownsConsumption: (value) => real.ownsConsumption(value),
    };
    return wrapper;
  };
  const sourceFacade = {
    sourceEpoch: () => coordinator.sourceEpoch(),
    ownsConsumption: (value) => coordinator.ownsConsumption(value),
    invalidate: (sessionId) => coordinator.invalidate(sessionId),
    getLedger: (sessionId) => wrapLedger(sessionId),
  };

  // The host context the plugin is attached to. `on` records the subscriptions so the test
  // can (a) count them — a leaked observer is a permanent host listener — and (b) deliver
  // `session/event` without dragging the projection registry through a synthetic commit.
  const hostListeners = new Map();
  const capturedTools = new Map();
  // WHICH channel delivered a listener callback: the real host (root.on) or the fixture's own
  // hand-written `deliver` call. Without this, a growing `forwardedToolCalls` cannot tell us
  // whether A's turn reached the observer through real host events or through a manual delivery.
  const deliveryOrigins = [];
  // Every REAL tool execution performed by the real AgentLoop, with the callId the host handed to
  // the tool. Used to check that the id the model asked for is the id the tool actually receives.
  const realToolExecCallIds = [];
  const pluginCtx = {
    on(name, fn) {
      const list = hostListeners.get(name) ?? [];
      // Two SEPARATE wrappers so the origin of each delivery is observable. The original `fn` still
      // runs unchanged in both cases — this only labels the path, it does not alter delivery.
      const viaDeliver = (...args) => { deliveryOrigins.push({ name, via: 'deliver' }); return fn(...args); };
      const viaRoot = (...args) => { deliveryOrigins.push({ name, via: 'root' }); return fn(...args); };
      list.push(viaDeliver);
      hostListeners.set(name, list);
      const offRoot = root.on(name, viaRoot);
      return () => {
        const index = list.indexOf(viaDeliver);
        if (index >= 0) list.splice(index, 1);
        offRoot();
      };
    },
    tools: { register: (definition) => { capturedTools.set(definition.name, definition); return root.get('tools').register(definition); } },
  };
  const deliver = (name, ...args) => { for (const fn of [...(hostListeners.get(name) ?? [])]) fn(...args); };
  const listenerCount = (name) => (hostListeners.get(name) ?? []).length;
  const sameSessionListenerBaseline = () => listenerCount('session/event');

  const modelQueue = [];
  class ScriptedAdapter extends llm.LlmAdapter {
    providerInfo(provider) { return { id: provider, name: provider }; }
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }); }
    async *stream() {
      const step = modelQueue.shift() ?? { kind: 'text' };
      if (step.kind === 'tool') {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: step.callId, name: 'qzone_read_posts', arguments: '{"target_uin":456}' } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'done' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }

  // A synthetic agent ctx: only the pre-step listener matters, and it must be fireable.
  const syntheticAgentCtx = () => {
    const callbacks = new Map();
    return {
      on(name, fn) { const list = callbacks.get(name) ?? []; list.push(fn); callbacks.set(name, list); return () => {}; },
      fire(name, payload) { for (const fn of callbacks.get(name) ?? []) fn(payload, () => {}); },
      listenerNames() { return [...callbacks.keys()]; },
    };
  };

  const platformReads = () => platformCalls.filter((action) => action === 'get_qzone_msg_list').length;

  try {
    fakeClient.emitter.emit('open');
    assert.equal(await coordinator.verify(), true, '前提：离线来源通过校验');
    for (const plugin of [projection.SessionProjectionRegistry, session.SessionStore, agent.AgentRegistry,
      systemPrompt.SystemPrompt, llm.LlmRuntime, tools.ToolRuntime, nativeExecutor, agentLoop.AgentLoop]) root.plugin(plugin);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const runtime = createQzoneRuntime({ store, botQq: 123, sourceEpoch: coordinator.sourceEpoch(),
      authorizeSource: (c) => coordinator.ownsConsumption(c), getConnectionEpoch: coordinator.connectionEpoch,
      getBridgeSessions: () => null, clock: () => now, mode: 'read-only',
      call: (action, params) => fakeClient.request(action, params) });
    handle = await createQzonePluginHandle(pluginCtx, { enabled: true },
      { epoch: coordinator.sourceEpoch(), sourceLifetime: sourceFacade, defineTool: tools.defineTool,
        dispatch: async (...args) => { const out = await runtime.dispatch(...args); outputs.push(out); return out; } });
    assert.equal(handle.status().state, 'enabled-dispatch-ready', '前提：插件在真实宿主上完成装配');
    const readTool = capturedTools.get('qzone_read_posts');
    assert.equal(typeof readTool?.execute, 'function', '前提：原生读工具已注册到宿主工具面');
    disposeAdapter = root.get('llm').registerAdapter(['offline'], new ScriptedAdapter());
    // The authenticated cross-process delivery channel is a temporary VM fixture; it is NOT
    // evidence that such a channel exists in production (same caveat as the test above).
    fakeBridge = await bridgeHarness();

    const S1 = 'chain-session-1';
    const baselineListeners = sameSessionListenerBaseline();
    assert.equal(baselineListeners, 1, '前提：没有 agent 时只有插件自己的 session/event 订阅');

    // ── 1. two agents on ONE session, each dispatches successfully ────────────────
    agentA = await root.get('agents').create({ sessionId: S1, agentOptions: { provider: 'offline', model: 'fixture' } });
    const readsBeforeA = platformReads();
    // RUNTIME observation (not a source search): `forwardedToolCalls` is appended ONLY by the
    // plugin's session/event observer. If A's real AgentLoop turn leaves it untouched, then A
    // reached the tool through the native executor and NOT through event delivery.
    const forwardedBeforeA = forwardedToolCalls.length;
    const originsBeforeA = deliveryOrigins.length;
    handle.registerBridgeRequest(S1, { requestId: 'rpc-a1', origin: 'qq-inbound' });
    // Wrap the captured tool ONCE so every real execution records the host-supplied callId.
    // This is observation only: the original execute still runs and its result is returned untouched.
    const realReadTool = capturedTools.get('qzone_read_posts');
    const originalExecute = realReadTool.execute;
    let wrapped = false;
    if (!wrapped) {
      wrapped = true;
      realReadTool.execute = async function wrappedExecute(args, exec) {
        realToolExecCallIds.push({ callId: exec?.callId ?? null, toolName: realReadTool.name });
        return originalExecute.call(this, args, exec);
      };
    }

    modelQueue.push({ kind: 'tool', callId: 'a-call-1' }, { kind: 'text' });
    agentA.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user', rpcId: 'rpc-a1' } }));
    await agentA.agent.whenIdle();
    assert.equal(platformReads(), readsBeforeA + 1, 'A 的真实回合必须走到平台读（假客户端）');
    assert.deepEqual(outputs.at(-1), SUCCESS_WITH_EMPTY_PAGE, 'A 的派发必须成功');
    assert.equal(sameSessionListenerBaseline(), 2, 'A 建了本 session 的 observer');
    // ── RUNTIME observation that corrected a source-reading mistake ─────────────────────
    //
    // A previous version of this probe grepped for `deliver('session/event'` inside the A
    // section, found none, and concluded "A bypasses event delivery". THAT WAS WRONG: the real
    // AgentLoop emits session/event internally, so the A section never needs to call `deliver`.
    // Measured here instead of inferred:
    //
    //   forwardedBeforeA = 0  ->  after A = 1   with { callId: 'a-call-1', result: true }
    //
    // So channel A in this fixture IS real host-style event delivery, and the observer saw the
    // SAME callId the model asked for. That makes the two ENDS of one hop observable together:
    // `exec.callId` (what the tool received) and `session/event.data.callId` (what the observer
    // saw) are the same string here.
    assert.equal(forwardedToolCalls.length, forwardedBeforeA + 1,
      'A 的真实回合必须产生恰好一条 session/event tool/call');
    // THE DISAMBIGUATION the user asked for: was it the real host event path, or our own
    // hand-written `deliver`? This distinguishes "the fixture did not deliver it" from
    // "the host did not deliver it" — a grep for `deliver(` cannot tell these apart.
    const aOrigins = deliveryOrigins.slice(originsBeforeA);
    assert.ok(aOrigins.length >= 1, 'A 回合必须至少有一次投递');
    assert.ok(aOrigins.every((entry) => entry.via === 'root'),
      'A 的投递必须全部来自真实宿主 root 事件路径，不得是手工 deliver；实际: '
      + JSON.stringify(aOrigins));
    const aDelivery = forwardedToolCalls[forwardedBeforeA];
    assert.equal(aDelivery.sessionId, S1, '投递的 sessionId 必须一致');
    assert.equal(aDelivery.result, true, '这条投递被账本接受（result:true 来自账本）');
    // THE HOP, both ends measured on the same real execution:
    assert.equal(aDelivery.callId, realToolExecCallIds[0].callId,
      'exec.callId 与 session/event.data.callId 必须相同 —— 这是同一跳的两端，'
      + '两端都由运行时观察得到，不是源码推断');
    // ── 1b. the real AgentLoop must hand the model's callId to the tool unchanged ──────────
    //
    // WHAT THIS PROVES: inside this process, the real AgentLoop does not rewrite, prefix or
    // regenerate the tool-call id — 'exec.callId' is exactly the id the model emitted.
    // WHAT IT DOES NOT PROVE: that a real host delivers the same id on 'session/event' (channel B
    // here is synthesised), that another process cannot forge one, or that ids are unique across
    // sessions. This is ONE hop of the chain, measured; the rest stays inference.
    assert.deepEqual(
      realToolExecCallIds.map((entry) => entry.callId),
      ['a-call-1'],
      '真实 AgentLoop 传给工具的 exec.callId 必须就是模型请求的那个 id（不改写、不重生成）',
    );
    assert.equal(realToolExecCallIds[0].toolName, 'qzone_read_posts', '被执行的是同一个工具');

    const ctxB = syntheticAgentCtx();
    deliver('agent/created', { agent: { id: 'chain-agent-b', session: { id: S1 }, ctx: ctxB } });
    assert.equal(handle.status(S1).agentAdapters, 2, '前提：B 也装上了 adapter');
    assert.equal(sameSessionListenerBaseline(), 2, 'B 必须复用同一个 observer，不是再建一个');
    assert.deepEqual(ctxB.listenerNames(), ['agent/pre-step'], 'B 拿到的是 pre-step adapter');

    handle.registerBridgeRequest(S1, { requestId: 'rpc-b1', origin: 'qq-inbound' });
    ctxB.fire('agent/pre-step', { turn: 2, step: 1, messages: [{ role: 'user', source: { rpcId: 'rpc-b1' } }] });
    deliver('session/event', { id: S1 }, { type: 'tool/call', data: { turn: 2, step: 1, callId: 'b-call-1', name: 'qzone_read_posts' } });
    assert.deepEqual(coordinator.getLedger(S1).peekCall('b-call-1'), { turn: 2, step: 1 },
      'B 的 tool/call 必须被唯一的那一个 observer 记成一次');
    const readsBeforeB = platformReads();
    assert.deepEqual(await readTool.execute({ target_uin: 456 }, { agent: { session: { id: S1 } }, callId: 'b-call-1' }),
      SUCCESS_WITH_EMPTY_PAGE, 'B 必须能派发');
    assert.equal(platformReads(), readsBeforeB + 1, 'B 的派发必须真的走到平台读');
    deliver('session/event', { id: S1 }, { type: 'turn/end', data: { turn: 2 } });
    assert.equal(coordinator.getLedger(S1).alive(), true, '双 agent 记账不得打断共享账本');
    assert.equal(handle.status(S1).dispatchAvailable, true);

    // ── 2. dispose one; the other keeps dispatching ───────────────────────────────
    const shared = coordinator.getLedger(S1);
    await agentA.dispose();
    agentA = null;
    assert.equal(handle.status(S1).agentAdapters, 1, 'A 退出后只剩 B 的 entry');
    assert.equal(handle.status(S1).dispatchAvailable, true, 'A 退出不得让 session 失去可派发');
    assert.equal(coordinator.getLedger(S1).alive(), true, 'A 退出不得断开共享账本');
    assert.equal(sameSessionListenerBaseline(), 2, 'A 退出不得销毁还在服务 B 的 observer');
    handle.registerBridgeRequest(S1, { requestId: 'rpc-b2', origin: 'qq-inbound' });
    ctxB.fire('agent/pre-step', { turn: 3, step: 1, messages: [{ role: 'user', source: { rpcId: 'rpc-b2' } }] });
    deliver('session/event', { id: S1 }, { type: 'tool/call', data: { turn: 3, step: 1, callId: 'b-call-2', name: 'qzone_read_posts' } });
    assert.deepEqual(await readTool.execute({ target_uin: 456 }, { agent: { session: { id: S1 } }, callId: 'b-call-2' }),
      SUCCESS_WITH_EMPTY_PAGE, 'A 退出后 B 必须仍然能派发');
    deliver('session/event', { id: S1 }, { type: 'turn/end', data: { turn: 3 } });

    // ── 3. last agent leaves; same session re-created; dispatch again ─────────────
    // This is the state a `resume` lands in (see the header note: resume() itself needs a
    // persistence backend this fixture does not load).
    deliver('agent/disposed', { agent: { id: 'chain-agent-b', session: { id: S1 } } });
    assert.equal(handle.status(S1).agentAdapters, 0);
    assert.equal(handle.status(S1).dispatchAvailable, false, '没有 agent 不得报可派发');
    assert.ok(!handle.status(S1).dispatchableSessions.includes(S1));
    assert.equal(sameSessionListenerBaseline(), 1, '最后一个 agent 退出后 observer 必须销毁');
    assert.notEqual(coordinator.getLedger(S1), shared, '干净边界必须换一本新账本');
    assert.equal(coordinator.getLedger(S1).alive(), true, '新账本必须是活的');

    agentA2 = await root.get('agents').create({ sessionId: S1, agentOptions: { provider: 'offline', model: 'fixture' } });
    assert.equal(handle.status(S1).adaptersBlocked, 0, '干净释放不得算作被阻断');
    assert.equal(handle.status(S1).dispatchAvailable, true, '同一 session 重建 agent 后必须恢复可派发');
    const readsBeforeA2 = platformReads();
    handle.registerBridgeRequest(S1, { requestId: 'rpc-a2', origin: 'qq-inbound' });
    modelQueue.push({ kind: 'tool', callId: 'a2-call-1' }, { kind: 'text' });
    agentA2.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user', rpcId: 'rpc-a2' } }));
    await agentA2.agent.whenIdle();
    assert.equal(platformReads(), readsBeforeA2 + 1, '重建之后必须真的走到平台读');
    assert.deepEqual(outputs.at(-1), SUCCESS_WITH_EMPTY_PAGE, '重建之后必须真的能派发');

    // ── 4. replay: the SAME callId must be refused by the LEDGER ──────────────────
    // The observer must FORWARD the duplicate (dropping it there would be deduplication at
    // the wrong layer, hiding a conflict) and the ledger's `spentCalls` must refuse it.
    forwardedToolCalls.length = 0;
    deliver('session/event', { id: S1 }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'a2-call-1', name: 'qzone_read_posts' } });
    assert.deepEqual(forwardedToolCalls.filter((entry) => entry.callId === 'a2-call-1'),
      [{ sessionId: S1, callId: 'a2-call-1', result: false }],
      '重放必须先被 observer 转发，再由账本自己拒绝（result:false 来自账本；被观察层吞掉就看不到这条记录）');
    assert.equal(coordinator.getLedger(S1).peekCall('a2-call-1'), null, '重放不得留下可消费的绑定');
    const readsBeforeReplay = platformReads();
    assert.deepEqual(await readTool.execute({ target_uin: 456 }, { agent: { session: { id: S1 } }, callId: 'a2-call-1' }),
      { ok: false, error: 'origin-unbound' }, '重放不得拿到第二次绑定');
    assert.equal(platformReads(), readsBeforeReplay, '重放不得触碰平台');
    assert.equal(handle.status(S1).dispatchAvailable, true, '重放被拒不是运行期故障，session 仍可派发');

    // ── 5. fault state: malformed pre-step must fail CLOSED ──────────────────────
    await agentA2.dispose();
    agentA2 = null;
    const S2 = 'chain-session-2';
    agentC = await root.get('agents').create({ sessionId: S2, agentOptions: { provider: 'offline', model: 'fixture' } });
    assert.equal(handle.status(S2).dispatchAvailable, true, '前提：新 session 可派发');
    agentC.agent.ctx.emit('agent/pre-step', { turn: 0, step: 1, messages: [] }, () => {});
    assert.equal(coordinator.getLedger(S2).alive(), false, '前提：畸形 pre-step 真的打死账本');
    assert.equal(handle.status(S2).dispatchAvailable, false, '故障之后不得再报可派发');
    assert.deepEqual(handle.status(S2).dispatchableSessions, [], '故障 session 不得出现在可派发集合里');
    assert.equal(handle.status().adaptersDisconnected, 1, '故障必须计数');

    // ── 6. observer created, then adapter FAILS → no orphan observer ─────────────
    const beforeFailure = { listeners: sameSessionListenerBaseline(), failed: handle.status().adaptersFailed, adapters: handle.status().agentAdapters };
    deliver('agent/created', { agent: { id: 'chain-bad', session: { id: 'chain-session-3' }, ctx: { on: () => undefined } } });
    assert.equal(handle.status().adaptersFailed, beforeFailure.failed + 1, '构造失败必须在真实宿主上被计数');
    assert.equal(sameSessionListenerBaseline(), beforeFailure.listeners,
      '为失败 agent 新建的 observer 必须回滚：不得留孤儿 host 监听');
    assert.equal(handle.status('chain-session-3').dispatchAvailable, false);
    assert.equal(handle.status().agentAdapters, beforeFailure.adapters, '失败的 agent 不得进入 adapters 表');

    // Behavioural proof that no orphan is left: a normal agent on ANOTHER session still
    // gets its own observer and still dispatches through the real pipeline.
    const S4 = 'chain-session-4';
    agentD = await root.get('agents').create({ sessionId: S4, agentOptions: { provider: 'offline', model: 'fixture' } });
    assert.equal(sameSessionListenerBaseline(), beforeFailure.listeners + 1, '正常 agent 必须能建自己的 observer');
    const readsBeforeD = platformReads();
    handle.registerBridgeRequest(S4, { requestId: 'rpc-d1', origin: 'qq-inbound' });
    modelQueue.push({ kind: 'tool', callId: 'd-call-1' }, { kind: 'text' });
    agentD.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user', rpcId: 'rpc-d1' } }));
    await agentD.agent.whenIdle();
    assert.equal(platformReads(), readsBeforeD + 1, '坏 adapter 之后正常 agent 仍必须能观察并派发');
    assert.deepEqual(outputs.at(-1), SUCCESS_WITH_EMPTY_PAGE);

    // ── E1 (Codex ruling §3): the real `agents.create` refuses a LIVE session id ──
    //
    // This is a FACT about THIS entry point, measured against the real AgentRegistry
    // exported from app.asar — not a claim that no resume path could ever overlap two
    // agents. It exists so the "two agents on one session is synthetic only" caveat is
    // backed by an executable assertion instead of a comment, and so a future host that
    // changes this behaviour turns the suite red instead of silently invalidating the
    // cover story.
    let duplicateCreateError = null;
    try {
      // S4 is the session whose agent (`agentD) is still LIVE at this point in the chain.
      const duplicate = await root.get('agents').create({ sessionId: S4, agentOptions: { provider: 'offline', model: 'fixture' } });
      try { await duplicate?.dispose?.(); } catch {}
    } catch (error) {
      duplicateCreateError = error;
    }
    assert.ok(duplicateCreateError, '对已存在的 live session 再次 agents.create 必须抛错（本入口实测行为）');
    assert.match(String(duplicateCreateError.message ?? duplicateCreateError),
      /already exists|already been created|duplicate/i,
      '抛错消息应能识别为「session 已存在」；若宿主换了措辞，这里要跟着更新而不是放宽断言');

    // The failed create must not have damaged the live agent: `agentD` (S4) still works.
    const readsBeforeE1 = platformReads();
    handle.registerBridgeRequest(S4, { requestId: 'rpc-e1', origin: 'qq-inbound' });
    modelQueue.push({ kind: 'tool', callId: 'e1-call-1' }, { kind: 'text' });
    agentD.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user', rpcId: 'rpc-e1' } }));
    await agentD.agent.whenIdle();
    assert.equal(platformReads(), readsBeforeE1 + 1,
      'duplicate-create 失败后，原有 agent 仍必须能真实派发（状态未被破坏）');
    assert.deepEqual(outputs.at(-1), SUCCESS_WITH_EMPTY_PAGE);
    assert.equal(store.read().writes, 0, '写路径保持 write-not-wired：全程没有任何写成功');
    t.diagnostic(JSON.stringify({
      archive: h.archive,
      evidence: '本机 app.asar 导出的 Cordis/AgentRegistry/AgentLoop/ToolRuntime；假 OneBot 客户端与假 LLM 适配器',
      caveat: '离线宿主证据 ≠ 线上通过；双 agent 的第二只是合成的 agent/created，session/event 由捕获的监听器投递，resume 由同 session 重建等价代替',
      platformReads: platformReads(),
      outputs: outputs.length,
      forwardedToolCalls: forwardedToolCalls.length,
    }));
  } finally {
    await handle?.dispose();
    coordinator.dispose();
    await fakeBridge?.close();
    try { await agentD?.dispose?.(); } catch {}
    try { await agentC?.dispose?.(); } catch {}
    try { await agentA2?.dispose?.(); } catch {}
    try { await agentA?.dispose?.(); } catch {}
    try { disposeAdapter?.(); } catch {}
    await root.dispose?.();
    await h.close?.();
    store.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// t48 — INVARIANCE through the WIRED path: hidden rows and upstream total must not move the output
// ══════════════════════════════════════════════════════════════════════════════════════
//
// The reader-side invariance test proves the reader leaks nothing. This proves the WIRING does not
// reintroduce a count while forwarding — the exact place R12b-24's `page` lived.

const INV_SESSION = 's1';
const INV_NOW = Date.parse('2026-11-10T04:00:00Z');

function invStore() {
  let state = { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true }, reads: 0, writes: 0, readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-10', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
    activeStart: 0, activeEnd: 1439, audit: [] };
  return { read: () => structuredClone(state), update(fn) { state = fn(structuredClone(state)); return structuredClone(state); } };
}

/** 3 visible rows, identical across every combination. */
const INV_VISIBLE = [
  { tid: 'v0', time: INV_NOW / 1000 - 5, content: 'visible-0' },
  { tid: 'v1', time: INV_NOW / 1000 - 6, content: 'visible-1' },
  { tid: 'v2', time: INV_NOW / 1000 - 7, content: 'visible-2' },
];

/** Rows outside the 7-day window: returned by the platform, not returned by the reader. */
function invHidden(count) {
  return Array.from({ length: count }, (_, i) => ({
    tid: `h${i}`, time: INV_NOW / 1000 - 8 * 86400, content: `hidden-${i}`,
  }));
}

/** Drive the real runtime end-to-end against a fake platform answering `{total, msglist}`. */
async function invDispatch(hiddenCount, total) {
  const store = invStore();
  const ledger = createQzoneOriginLedger({ sessionId: INV_SESSION, epoch: 'e1' });
  ledger.registerBridgeRequest({ requestId: 'rpc-1', origin: 'qq-inbound' });
  const msglist = [...INV_VISIBLE, ...invHidden(hiddenCount)];
  let dispatches = 0;
  const runtime = createQzoneRuntime({
    store, botQq: 123, sourceEpoch: 'e1', getConnectionEpoch: () => 8,
    authorizeSource: (c) => ledger.ownsConsumption(c),
    getBridgeSessions: (sid) => (sid === INV_SESSION ? ledger : null),
    clock: () => INV_NOW, mode: 'read-only',
    call: async (action) => {
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
      if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
      if (action === 'get_qzone_msg_list') { dispatches += 1; return { status: 'ok', retcode: 0, data: { total, msglist } }; }
      throw new Error(`unexpected action ${action}`);
    },
  });
  ledger.observeStep({ sessionId: INV_SESSION, turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'rpc-1' } }] });
  ledger.observeToolCall({ sessionId: INV_SESSION, event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1' } } });
  const result = await runtime.dispatch('read_posts', { target_uin: 456 }, { sessionId: INV_SESSION, callId: 'c1' });
  assert.equal(dispatches, 1, '每次恰好一次平台读（不翻页）');
  return result;
}

test('INV-W1 wiring：隐藏行数 0/1/5/17 × total 3/20/137/999 共 16 种组合，wiring 输出全等', async () => {
  const outputs = [];
  for (const hidden of [0, 1, 5, 17]) {
    for (const total of [3, 20, 137, 999]) {
      outputs.push({ hidden, total, result: await invDispatch(hidden, total) });
    }
  }
  const baseline = outputs[0].result;
  // Non-vacuity: the baseline really does carry the three visible posts.
  assert.equal(baseline.ok, true);
  assert.equal(baseline.outcome, 'success');
  assert.deepEqual(baseline.posts.map((p) => p.id), ['v0', 'v1', 'v2'], '前提：三条可见行确实返回了');

  for (const { hidden, total, result } of outputs) {
    assert.deepEqual(result, baseline,
      `hidden=${hidden}, total=${total} 时 wiring 输出必须与基准相同 —— 差异即侧信道`);
  }
});

test('INV-W2 wiring：success 返回体只有 ok/outcome/posts 三个键，没有任何计数', async () => {
  const result = await invDispatch(17, 999);
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'outcome', 'posts'],
    'success 只允许 ok/outcome/posts');
  for (const forbidden of ['page', 'received', 'upstreamTotal', 'requested', 'truncated', 'incomplete']) {
    assert.equal(Object.hasOwn(result, forbidden), false, `不得含 ${forbidden}`);
  }
});

test('INV-W3 wiring：隐藏 0 行与隐藏 17 行必须不可区分（最直接的侧信道对比）', async () => {
  assert.deepEqual(await invDispatch(0, 3), await invDispatch(17, 999),
    '隐藏 0 与隐藏 17 的返回体必须完全相同');
});