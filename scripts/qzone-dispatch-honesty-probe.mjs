// Reproduces the two paths the R10 reviewer H2 claims against `status().dispatchAvailable`:
//   B) an adapter exists for session s2 only; a space call is issued from s1
//      => status says dispatchAvailable true, the call fails `origin-unbound`
//   C) an adapter exists for s1, its ledger then gets disconnected
//      => the adapter entry stays in the map, status still says true, consume returns null
//
// Both contradict the comment at `plugins/qzone-safe/index.mjs:333-342`
// ("`ready` alone is not enough ... reporting false here is the only honest answer").
// A positive control (D) runs the exact same path with nothing broken, so a green
// failing case cannot be blamed on the fixture.
//
// Reproduce first, fix later: this probe must not be run against modified source until
// the failure is recorded.

import { createQzonePluginHandle } from '../plugins/qzone-safe/index.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

const out = (label, payload) => console.log(JSON.stringify({ exp: label, ...payload }));

const TOOL = 'qzone_read_posts';

// `getQzoneDshSessionContext` (plugins/qzone-safe/session-context.mjs:5-14) reads the
// session from `exec.agent.session.id` and the call from `exec.callId` — NOT a flat
// `{sessionId, callId}`. The flat shape returns `missing-native-context` before dispatch
// is ever reached, which would make every case look like a plugin failure.
const execFor = (sessionId, callId) => ({ agent: { session: { id: sessionId } }, callId });

const userMessage = (requestId) => ({ role: 'user', source: { rpcId: requestId } });

function fakeHost() {
  const callbacks = new Map();
  const registered = new Map();
  const ctx = {
    on: (name, fn) => {
      const list = callbacks.get(name) ?? [];
      list.push(fn);
      callbacks.set(name, list);
      return () => {
        const cur = callbacks.get(name) ?? [];
        const index = cur.indexOf(fn);
        if (index >= 0) cur.splice(index, 1);
      };
    },
    tools: { register: (tool) => { registered.set(tool.name, tool); return () => registered.delete(tool.name); } },
  };
  const ledgers = new Map();
  const lifetime = {
    sourceEpoch: () => 'e1',
    getLedger: (sessionId) => {
      let ledger = ledgers.get(sessionId);
      if (!ledger) {
        ledger = createQzoneOriginLedger({ sessionId, epoch: 'e1', trackingLimit: 4096 });
        ledgers.set(sessionId, ledger);
      }
      return ledger;
    },
    rotate() {},
    ownsConsumption: () => false,
  };
  const dispatches = [];
  const handle = createQzonePluginHandle(ctx, { enabled: true }, {
    epoch: 'e1',
    defineTool: (tool) => tool,
    dispatch: async (action, input, context) => { dispatches.push({ action, context }); return { ok: true }; },
    sourceLifetime: lifetime,
  });
  const emit = (name, ...args) => { for (const fn of callbacks.get(name) ?? []) fn(...args); };
  return { handle, emit, registered, ledgers, dispatches };
}

// A stand-in for the live agent ctx: the plugin only needs `on` to exist, and the
// adapter needs it to be able to register both of its listeners.
function agentCtx() {
  const cbs = new Map();
  return {
    on: (name, fn) => { const list = cbs.get(name) ?? []; list.push(fn); cbs.set(name, list); return () => {}; },
    _fire: (name, payload, next) => { for (const fn of cbs.get(name) ?? []) fn(payload, next); },
  };
}

// Bring one session to the healthy, dispatchable shape:
//   bridge request registered -> pre-step claiming it -> tool/call announced.
// Every case that is supposed to fail must fail AFTER this, never because of it.
function armSession(handle, host, ctxOf, sessionId, { requestId = 'rpc-1', callId = 'call-1' } = {}) {
  handle.registerBridgeRequest(sessionId, { requestId, origin: 'qq-inbound' });
  ctxOf._fire('agent/pre-step', { turn: 1, step: 1, messages: [userMessage(requestId)] }, () => {});
  host.emit('session/event', { id: sessionId }, { type: 'tool/call', data: { turn: 1, step: 1, callId, name: TOOL } });
  return { requestId, callId };
}

// ---------------------------------------------------------------------------
// D: positive control — everything healthy must actually dispatch.
// ---------------------------------------------------------------------------
{
  const host = fakeHost();
  const handle = await host.handle;
  const a1 = agentCtx();
  host.emit('agent/created', { agent: { id: 'agent-1', session: { id: 's1' }, ctx: a1 } });
  const { callId } = armSession(handle, host, a1, 's1', { callId: 'ok-1' });
  const tool = host.registered.get(TOOL);
  const status = handle.status('s1');
  const result = await tool.execute({ target_uin: 456 }, execFor('s1', callId));
  out('D_positiveControl', {
    status: { dispatchAvailable: status.dispatchAvailable, agentAdapters: status.agentAdapters, dispatchableSessions: status.dispatchableSessions },
    result,
    dispatched: host.dispatches.length,
    healthy: status.dispatchAvailable === true && result?.ok === true && host.dispatches.length === 1,
  });
  await handle.dispose();
}

// ---------------------------------------------------------------------------
// B: adapter for s2 only; the space call comes from s1.
// ---------------------------------------------------------------------------
{
  const host = fakeHost();
  const handle = await host.handle;
  const a2 = agentCtx();
  host.emit('agent/created', { agent: { id: 'agent-2', session: { id: 's2' }, ctx: a2 } });
  // s1 gets a pending position but no adapter, so no step is ever observed for it.
  host.emit('session/event', { id: 's1' }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: TOOL } });
  const tool = host.registered.get(TOOL);
  const status = handle.status('s1');
  const result = await tool.execute({ target_uin: 456 }, execFor('s1', 'c1'));
  out('B_otherSessionAdapterOnly', {
    status: { dispatchAvailable: status.dispatchAvailable, agentAdapters: status.agentAdapters, dispatchableSessions: status.dispatchableSessions, state: status.state, generationBound: status.generationBound },
    dispatchResult: result,
    dispatched: host.dispatches.length,
    // The falsifying conjunction: status promised true, the dispatch still failed.
    falsified: status.dispatchAvailable === true && result?.ok !== true,
  });
  await handle.dispose();
}

// ---------------------------------------------------------------------------
// C: adapter for s1 in the healthy shape, then its ledger gets disconnected.
// A single malformed pre-step payload does this (`prestep-adapter.mjs:56-58`).
// ---------------------------------------------------------------------------
{
  const host = fakeHost();
  const handle = await host.handle;
  const a1 = agentCtx();
  host.emit('agent/created', { agent: { id: 'agent-1', session: { id: 's1' }, ctx: a1 } });
  // Arm first, so the failure cannot be "nothing was ever bound".
  armSession(handle, host, a1, 's1', { requestId: 'rpc-c', callId: 'c9' });
  const beforeDisconnect = handle.status('s1');
  // Malformed payload: `turn: 0` fails `positive()`, the adapter calls disconnect(),
  // which latches `continuityLost` on the ledger permanently.
  a1._fire('agent/pre-step', { turn: 0, step: 1, messages: [] }, () => {});
  const status = handle.status('s1');
  const tool = host.registered.get(TOOL);
  const result = await tool.execute({ target_uin: 456 }, execFor('s1', 'c9'));
  out('C_adapterDisconnectedLedger', {
    beforeDisconnect: { dispatchAvailable: beforeDisconnect.dispatchAvailable, agentAdapters: beforeDisconnect.agentAdapters },
    status: { dispatchAvailable: status.dispatchAvailable, agentAdapters: status.agentAdapters, dispatchableSessions: status.dispatchableSessions, adaptersDisconnected: status.adaptersDisconnected, state: status.state },
    dispatchResult: result,
    dispatched: host.dispatches.length,
    falsified: status.dispatchAvailable === true && result?.ok !== true,
  });
  await handle.dispose();
}

// ---------------------------------------------------------------------------
// E: regression guard for the half that IS fixed — a handle that never saw an agent.
// ---------------------------------------------------------------------------
{
  const host = fakeHost();
  const handle = await host.handle;
  const status = handle.status('s1');
  out('E_noAgent', {
    dispatchAvailable: status.dispatchAvailable,
    agentAdapters: status.agentAdapters,
    dispatchableSessions: status.dispatchableSessions,
    stillReportsFalse: status.dispatchAvailable === false && status.agentAdapters === 0,
  });
  await handle.dispose();
}
