// Verifies Codex ruling 3: with TWO agents sharing one session, a pre-step fault from
// ONE agent disconnects the SHARED ledger. The other agent's entry is untouched, so does
// `status()` still promise dispatchability for that session?
//
// `prestep-adapter.mjs`'s `disconnect()` calls `ledger.disconnect()`, which latches
// `continuityLost` on the ONE frozen ledger both agents share. The plugin's
// `onDisconnected` handler for that adapter only marks ITS OWN entry dead:
//
//     onDisconnected: () => { if (!installed || entry.dead) return; entry.dead = true; ... }
//
// Since `liveAdapterSessions()` asks only about adapter liveness, the survivor's entry
// keeps the session in `dispatchableSessions` while `ledger.consume`/`registerBridgeRequest`
// refuse everything. That is the same false promise R12-4 removed for duplicate events,
// still reachable through a single agent's fault.
//
// Read-only: fake ctx / fake store / fake transport.
import { createQzonePluginHandle } from '../plugins/qzone-safe/index.mjs';
import { createQzoneSourceLifetime } from '../src/core/qzone-source-lifetime-offline.mjs';

const SESSION = 'sess-shared';
const TOOL = 'qzone_read_posts';
const userMessage = (rpcId) => ({ role: 'user', source: { rpcId } });
const execFor = (sessionId, callId) => ({ agent: { session: { id: sessionId } }, callId });

function fakeHost() {
  const listeners = new Map();
  const registered = new Map();
  const ctx = {
    on(name, fn) {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
      return () => {};
    },
    tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); } },
  };
  return { ctx, registered, emit(name, ...args) { for (const fn of listeners.get(name) ?? []) fn(...args); } };
}

function agentCtx() {
  const callbacks = new Map();
  return {
    on(name, fn) { const list = callbacks.get(name) ?? []; list.push(fn); callbacks.set(name, list); return () => {}; },
    fire(name, payload) { for (const fn of callbacks.get(name) ?? []) fn(payload, () => {}); },
  };
}

const lifetime = createQzoneSourceLifetime({ sessionLimit: 8, trackingLimit: 64 });
const host = fakeHost();
const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
  dispatch: async () => ({ ok: true }),
  epoch: lifetime.sourceEpoch(),
  sourceLifetime: lifetime,
  defineTool: (tool) => tool,
});

const ctxA = agentCtx();
const ctxB = agentCtx();
host.emit('agent/created', { agent: { id: 'agent-A', session: { id: SESSION }, ctx: ctxA } });
host.emit('agent/created', { agent: { id: 'agent-B', session: { id: SESSION }, ctx: ctxB } });

const out = {};
out.beforeFault = handle.status(SESSION);

// ONE agent's pre-step stream faults (malformed payload). This is agent-scoped input,
// but `disconnect()` hits the SHARED ledger.
ctxA.fire('agent/pre-step', { turn: 0, step: 1, messages: [] });

out.afterFault = handle.status(SESSION);
out.ledgerAlive = lifetime.getLedger(SESSION).alive();

// Can the OTHER agent still dispatch? Its entry was never marked dead.
let regThrew = null;
try { handle.registerBridgeRequest(SESSION, { requestId: 'r-1', origin: 'qq-inbound' }); }
catch (error) { regThrew = error.message; }
out.survivorRegisterThrew = regThrew;

try {
  ctxB.fire('agent/pre-step', { turn: 1, step: 1, messages: [userMessage('r-1')] });
  host.emit('session/event', { id: SESSION }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c-1', name: TOOL } });
  out.survivorDispatch = await host.registered.get(TOOL).execute({ target_uin: 456 }, execFor(SESSION, 'c-1'));
} catch (error) {
  out.survivorDispatch = { threw: error.message };
}

out.finalStatus = handle.status(SESSION);
out.verdict = {
  oneAgentFaultKilledSharedLedger: out.ledgerAlive === false,
  statusStillPromisesAfterSharedLedgerDeath: out.finalStatus.dispatchAvailable === true,
  statusStillListsSession: out.finalStatus.dispatchableSessions.includes(SESSION),
  survivorCanActuallyDispatch: out.survivorDispatch?.ok === true,
  falsePromiseReproduced:
    out.finalStatus.dispatchAvailable === true && out.survivorDispatch?.ok !== true,
  adaptersDisconnected: out.finalStatus.adaptersDisconnected,
  adaptersBlocked: out.finalStatus.adaptersBlocked,
  agentAdapters: out.finalStatus.agentAdapters,
};

console.log(JSON.stringify(out, null, 2));
await handle.dispose();
