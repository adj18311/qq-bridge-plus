// E3 probe (v2): can a qzone `tool/call` reach dispatch through the HOST's own commit path?
//
// The question the tin the previous report answered "no" to was really: can a SYNTHESIZED
// event get a LEGITIMATE seq? This probe checks the host's own append (`session.append`),
// which assigns `seq = log.length` itself and publishes through `commit()` ->
// `session/event` observers -> projection `drive()` -> plugin observer.
//
// Refusal to forge: `root.emit('session/event', session, {seq: 9999, ...})` is recorded as a
// NEGATIVE control at the end. A hand-written seq is not evidence and this probe never uses
// one as a pass condition.
//
// Usage: node scripts/qzone-e3-commit-probe.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOfflineHostFixture } from './qzone-host-prestep-fixture.mjs';
import { createQzonePluginHandle } from '../plugins/qzone-safe/index.mjs';
import { createQzoneConnectionSourceCoordinator } from '../src/core/qzone-connection-source-coordinator-offline.mjs';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';

const h = await loadOfflineHostFixture();
const { cordis, session, projection, agent, agentLoop, llm, tools, systemPrompt, nativeExecutor } = h;
const root = new cordis.Context();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-e3-commit-'));
const out = [];
const log = (step, value) => { out.push({ step, value }); console.log(`[${step}]`, typeof value === 'string' ? value : JSON.stringify(value)); };

class NeverConnect {}
const fakeClient = new SnowLumaWebSocketClient({ webSocket: NeverConnect, reconnect: false });
fakeClient.getLoginInfo = async () => ({ user_id: 123 });
const platformReads = [];
fakeClient.request = async (action) => {
  platformReads.push(action);
  if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
  if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
  if (action === 'get_qzone_msg_list') return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
  throw new Error(`unexpected fake action ${action}`);
};
const coordinator = createQzoneConnectionSourceCoordinator({ client: fakeClient, expectedUserId: 123 });

let handle;
try {
  fakeClient.emitter.emit('open');
  assert.equal(await coordinator.verify(), true);
  for (const plugin of [projection.SessionProjectionRegistry, session.SessionStore, agent.AgentRegistry,
    systemPrompt.SystemPrompt, llm.LlmRuntime, tools.ToolRuntime, nativeExecutor, agentLoop.AgentLoop]) root.plugin(plugin);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const delivered = [];
  root.on('session/event', (hostSession, event) => delivered.push({ id: hostSession?.id, type: event?.type, seq: event?.seq, callId: event?.data?.callId }));
  const capturedTools = new Map();
  const pluginCtx = {
    on: (name, fn) => root.on(name, fn),
    tools: { register: (definition) => { capturedTools.set(definition.name, definition); return root.get('tools').register(definition); } },
  };
  const runtime = {
    dispatch: async (action, input, context) => ({ ok: true, outcome: 'success', callId: context?.callId, action }),
  };
  handle = await createQzonePluginHandle(pluginCtx, { enabled: true },
    { epoch: coordinator.sourceEpoch(), sourceLifetime: coordinator, defineTool: tools.defineTool, dispatch: runtime.dispatch });
  log('plugin.state', handle.status().state);

  class Quiet extends llm.LlmAdapter {
    providerInfo(p) { return { id: p, name: p }; }
    resolveModel(p, m) { return Promise.resolve({ provider: p, id: m, name: m }); }
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'x' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'x' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const off = root.get('llm').registerAdapter(['offline'], new Quiet());
  const S = 'e3-session';
  const agentHandle = await root.get('agents').create({ sessionId: S, agentOptions: { provider: 'offline', model: 'fixture' } });
  const hostSession = agentHandle.agent.session;
  const ledger = coordinator.getLedger(S);
  log('ledger alive at start', ledger.alive());

  // 1) The bridge request is what makes a step bind at all (real plugin API).
  handle.registerBridgeRequest(S, { requestId: 'e3-rpc-1', origin: 'qq-inbound' });

  // 2) The step must be OBSERVED by a pre-step adapter. Agent A is a real agent but its
  //    own pre-step only fires on a real turn; to keep this probe focused on the
  //    session/event path, the step is delivered to a synthetic agent ctx — the same
  //    documented substitution the multi-agent case makes for agent B. (The alternative,
  //    a real turn, is the existing single-agent case; not duplicated here.)
  const callbacks = new Map();
  const syntheticCtx = {
    on(name, fn) { const list = callbacks.get(name) ?? []; list.push(fn); callbacks.set(name, list); return () => {}; },
    fire(name, payload) { for (const fn of callbacks.get(name) ?? []) fn(payload, () => {}); },
  };
  root.emit('agent/created', { agent: { id: 'e3-synthetic-b', session: { id: S }, ctx: syntheticCtx } });
  log('agentAdapters after synthetic agent', handle.status(S).agentAdapters);
  syntheticCtx.fire('agent/pre-step', { turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'e3-rpc-1' } }] });
  log('ledger.peekCall before tool/call', ledger.peekCall('e3-call-1'));

  // 3) THE POINT: append through the host session — the host assigns seq (log.length),
  //    commits, drives projections, and invokes every session/event listener.
  let appended = null;
  try {
    appended = hostSession.append('tool/call', { turn: 1, step: 1, callId: 'e3-call-1', name: 'qzone_read_posts', arguments: '{"target_uin":456}' });
    log('hostSession.append("tool/call")', { ok: true, seq: appended.seq, type: appended.type });
  } catch (error) {
    log('hostSession.append("tool/call")', { ok: false, error: error.message });
  }
  log('delivered session/event', delivered.filter((entry) => entry.type === 'tool/call'));
  log('ledger.peekCall after host commit', ledger.peekCall('e3-call-1'));

  // 4) Dispatch through the real native tool entry point.
  const tool = capturedTools.get('qzone_read_posts');
  let dispatched;
  try {
    dispatched = await tool.execute({ target_uin: 456 }, { agent: { session: { id: S } }, callId: 'e3-call-1' });
  } catch (error) { dispatched = { threw: error.message }; }
  log('dispatch result', dispatched);
  const readsBefore = platformReads.length;

  // 5) turn/end through the same path.
  try {
    hostSession.append('turn/end', { turn: 1 });
    log('hostSession.append("turn/end")', { ok: true });
  } catch (error) { log('hostSession.append("turn/end")', { ok: false, error: error.message }); }
  log('ledger.alive after turn/end', ledger.alive());
  log('platform calls during probe', platformReads.slice(readsBefore));
  log('dispatchableSessions', handle.status().dispatchableSessions);

  // 6) NEGATIVE CONTROL: a hand-written seq must not be accepted as a delivery mechanism.
  let forged;
  try {
    root.emit('session/event', hostSession, { type: 'tool/call', seq: 9999, data: { turn: 2, step: 1, callId: 'e3-forged', name: 'qzone_read_posts' } });
    forged = { ok: true };
  } catch (error) { forged = { ok: false, error: error.message }; }
  log('NEGATIVE CONTROL root.emit with hand-written seq', forged);
  log('ledger.peekCall("e3-forged")', ledger.peekCall('e3-forged'));

  off();
  await agentHandle.dispose();
} finally {
  await handle?.dispose?.();
  coordinator.dispose();
  await root.dispose?.();
  h.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
