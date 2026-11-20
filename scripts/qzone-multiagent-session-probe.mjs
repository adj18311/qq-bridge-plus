// Evidence probe (R12-4): TWO agents on ONE session make the whole session permanently
// dead behind `dispatchAvailable: true`.
//
// Why this shape is reachable without any malformed input:
//   `plugins/qzone-safe/index.mjs` builds ONE pre-step adapter PER AGENT
//   (`agent/created`), but `session/event` is HOST-scoped and filtered only by
//   `hostSession?.id !== sessionId`. So when a second agent exists on the same session,
//   BOTH adapters observe the SAME `tool/call` and the SAME `turn/end`. The plugin's own
//   `agent/disposed` handler has a `stillUsed` guard for exactly this case (it refuses to
//   release the ledger while another agent shares the session), and
//   `test-qzone-agent-resume.mjs` even asserts that guard — so the shape is modelled,
//   not hypothetical.
//
// What it costs, measured below:
//   1. duplicate `observeToolCall` for one callId → the second adapter hits
//      `spentCalls.has(callId)` and POISONS that callId → its dispatch is `origin-unbound`
//      (this happens on the FIRST turn after a second agent exists);
//   2. duplicate `endTurn` for one turn → the second adapter's `endTurn` returns false
//      (`activeTurn` is already null) → the adapter calls `disconnect()` → the shared
//      ledger latches `continuityLost`;
//   3. from then on every `registerBridgeRequest` throws and every dispatch fails, while
//      `status()` still reports `dispatchAvailable: true` for that session, because the
//      OTHER adapter entry is still alive and `liveAdapterSessions()` only asks about
//      adapter liveness — the ledger's death is invisible to it.
//
// Step 3 is the same "status promises, dispatch refuses" shape R11 §0 / R12 set out to
// remove, reached through a second agent instead of a malformed pre-step.
//
// Read-only: fake ctx / fake store / fake transport. No real QQ access, no writes to
// src/ or plugins/.

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
    tools: {
      register(tool) {
        registered.set(tool.name, tool);
        return () => registered.delete(tool.name);
      },
    },
  };
  return {
    ctx,
    registered,
    emit(name, ...args) { for (const fn of listeners.get(name) ?? []) fn(...args); },
  };
}

// Per-agent ctx: the pre-step middleware lives here, not on the host ctx.
function agentCtx() {
  const callbacks = new Map();
  return {
    on(name, fn) {
      const list = callbacks.get(name) ?? [];
      list.push(fn);
      callbacks.set(name, list);
      return () => {};
    },
    fire(name, payload) { for (const fn of callbacks.get(name) ?? []) fn(payload, () => {}); },
  };
}

let turn = 0;

async function world() {
  const lifetime = createQzoneSourceLifetime({ sessionLimit: 8, trackingLimit: 64 });
  const host = fakeHost();
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    dispatch: async () => ({ ok: true }),
    epoch: lifetime.sourceEpoch(),
    sourceLifetime: lifetime,
    defineTool: (tool) => tool,
  });
  return { lifetime, host, handle };
}

async function oneRead(w, agentCtxOf, { callId, requestId }) {
  turn += 1;
  const t = turn;
  try { w.handle.registerBridgeRequest(SESSION, { requestId, origin: 'qq-inbound' }); }
  catch (error) { return { turn: t, stage: 'register', threw: error.message }; }
  agentCtxOf.fire('agent/pre-step', { turn: t, step: 1, messages: [userMessage(requestId)] });
  w.host.emit('session/event', { id: SESSION }, { type: 'tool/call', data: { turn: t, step: 1, callId, name: TOOL } });
  // `execute` is async: awaiting it is what keeps `execute` inside the turn (before
  // `turn/end`) AND makes `result.ok` a boolean rather than a pending Promise.
  const result = await w.host.registered.get(TOOL).execute({ target_uin: 456 }, execFor(SESSION, callId));
  w.host.emit('session/event', { id: SESSION }, { type: 'turn/end', data: { turn: t } });
  return { turn: t, result };
}

const snapshot = (handle) => ({
  dispatchAvailable: handle.status(SESSION).dispatchAvailable,
  dispatchableSessions: handle.status(SESSION).dispatchableSessions,
  agentAdapters: handle.status(SESSION).agentAdapters,
  adaptersDisconnected: handle.status(SESSION).adaptersDisconnected,
  adaptersBlocked: handle.status(SESSION).adaptersBlocked,
  generationBound: handle.status(SESSION).generationBound,
  state: handle.status(SESSION).state,
});

const out = {};

// ── Control: one agent, two turns ────────────────────────────────────────────
{
  const w = await world();
  const ctxA = agentCtx();
  w.host.emit('agent/created', { agent: { id: 'agent-A', session: { id: SESSION }, ctx: ctxA } });
  out.oneAgent = {
    turn1: await oneRead(w, ctxA, { callId: 'c-1', requestId: 'r-1' }),
    turn2: await oneRead(w, ctxA, { callId: 'c-2', requestId: 'r-2' }),
    status: snapshot(w.handle),
  };
  await w.handle.dispose();
}

// ── Two agents on the SAME session (the shape `stillUsed` guards) ────────────
{
  const w = await world();
  const ctxA = agentCtx();
  w.host.emit('agent/created', { agent: { id: 'agent-A', session: { id: SESSION }, ctx: ctxA } });
  out.twoAgentsBefore = {
    turn1: await oneRead(w, ctxA, { callId: 'c-1', requestId: 'r-1' }),
    status: snapshot(w.handle),
    ledgerAlive: w.lifetime.getLedger(SESSION).alive(),
  };

  const ctxB = agentCtx();
  w.host.emit('agent/created', { agent: { id: 'agent-B', session: { id: SESSION }, ctx: ctxB } });

  out.twoAgentsAfter = {
    agentAdapters: w.handle.status(SESSION).agentAdapters,
    // FIRST turn after the second agent exists: duplicate observeToolCall poisons the
    // callId, then duplicate endTurn disconnects the shared ledger.
    duplicateTurn: await oneRead(w, ctxA, { callId: 'c-2', requestId: 'r-2' }),
    ledgerAlive: w.lifetime.getLedger(SESSION).alive(),
    statusAfterDuplicate: snapshot(w.handle),
    // SECOND turn: the ledger is dead, so registration throws outright.
    nextTurn: await oneRead(w, ctxA, { callId: 'c-3', requestId: 'r-3' }),
    finalStatus: snapshot(w.handle),
  };
  await w.handle.dispose();
}

// ── Verdict ─────────────────────────────────────────────────────────────────
const control = out.oneAgent.status;
const broken = out.twoAgentsAfter;

out.verdict = {
  controlHealthy: out.oneAgent.turn1.result?.ok === true && out.oneAgent.turn2.result?.ok === true,
  secondAgentCreatesTwoAdapters: broken.agentAdapters === 2,
  firstTurnAfterSecondAgentDispatches: broken.duplicateTurn.result?.ok === true,
  ledgerKilledByDuplicateEndTurn: broken.ledgerAlive === false,
  // The honest-failure question: after the ledger dies, does status still promise?
  statusStillPromisesAfterLedgerDeath: broken.finalStatus.dispatchAvailable === true,
  dispatchStillWorksAfterLedgerDeath: broken.nextTurn.result?.ok === true,
  // The shape R11 §0 exists to remove:
  falsePromiseReproduced:
    broken.finalStatus.dispatchAvailable === true
    && broken.nextTurn.result?.ok !== true
    && typeof broken.nextTurn.threw === 'string',
  adaptersDisconnected: broken.finalStatus.adaptersDisconnected,
  adaptersBlocked: broken.finalStatus.adaptersBlocked,
};

console.log(JSON.stringify(out, null, 2));
