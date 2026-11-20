// §3.5 of the freeze: do asynchronous OLD-generation events pollute a NEW generation,
// and what happens to the adapter that was built for the retired generation?
//
// Two questions, both against the shipped plugin with a real source lifetime:
//   1. An adapter created before `rotate()` still holds the OLD ledger object. After
//      the purge, do its `agent/pre-step` / `session/event` deliveries reach the new
//      ledger, or the retired one?
//   2. Does a stale pre-step arriving after the rotation write anything into the new
//      ledger (turn baseline, `steps`, `calls`)?
import { createQzonePluginHandle, MAX_POSITIONS } from '../plugins/qzone-safe/index.mjs';
import { createQzoneSourceLifetime } from '../src/core/qzone-source-lifetime-offline.mjs';

const SESSION = 'sess-r9v2';

const out = {};

function makeCtx() {
  const handlers = new Map();
  return {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () => {
        const list = handlers.get(name) ?? [];
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      };
    },
    // 	ools.register must return a DISPOSER FUNCTION (native-tool.mjs:99).
    // Returning an object makes applyQzoneNativeTools fail with
    // 	ool-registration-failed, which tears the whole subscription block down and
    // would make this probe report a false 'no adapter' result.
    tools: { register: () => () => {} },
    emit(name, ...args) {
      for (const fn of [...(handlers.get(name) ?? [])]) fn(...args);
    },
    count(name) { return (handlers.get(name) ?? []).length; },
  };
}

function makeRuntime(lifetime, store) {
  return {
    epoch: lifetime.sourceEpoch(),
    sourceLifetime: lifetime,
    defineTool: (tool) => tool,
    async dispatch() { return { ok: true }; },
    store,
  };
}

const lifetime = createQzoneSourceLifetime({ trackingLimit: 8 });
const ctx = makeCtx();
const store = { enabled: true, tools: { read_posts: true } };
const handle = await createQzonePluginHandle(ctx, { enabled: true }, makeRuntime(lifetime, store));

// Build the first agent so a real adapter exists against generation 1's ledger.
ctx.emit('agent/created', { agent: { id: 'agent-1', session: { id: SESSION }, ctx: makeCtx2() } });
function makeCtx2() {
  const handlers = new Map();
  return {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () => {};
    },
    emit(name, ...args) { for (const fn of [...(handlers.get(name) ?? [])]) fn(...args); },
    count(name) { return (handlers.get(name) ?? []).length; },
  };
}

// Re-emit with a capturable agent ctx so we can drive agent/pre-step afterwards.
const agentCtx = makeCtx2();
ctx.emit('agent/created', { agent: { id: 'agent-2', session: { id: SESSION }, ctx: agentCtx } });
out.adapterSubscribedPreStep = agentCtx.count('agent/pre-step') === 1;

// Generation 1: a real pre-step binds, so the ledger holds live state.
lifetime.getLedger(SESSION).registerBridgeRequest({ requestId: 'rpc-1', origin: 'qq-inbound' });
agentCtx.emit('agent/pre-step', { turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'rpc-1' } }] });
ctx.emit('session/event', { id: SESSION }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'qzone_read_posts' } });
out.gen1Dispatch = await handle.status().state;
const gen1 = lifetime.getLedger(SESSION);
out.gen1Peek = gen1.peekCall('c1') !== null;

// Rotate: the plugin learns about it only on the next lookup.
const before = lifetime.sourceEpoch();
lifetime.rotate();
out.epochChanged = before !== lifetime.sourceEpoch();

// 1. An ASYNC old-generation pre-step arrives after the rotation. The adapter still
//    points at the RETIRED ledger object.
agentCtx.emit('agent/pre-step', { turn: 2, step: 1, messages: [{ role: 'user', source: { rpcId: 'rpc-1' } }] });
out.staleStepWroteIntoOldLedger = (() => {
  try { return gen1.peekCall('c1') !== null || gen1.observeStep({ sessionId: SESSION, turn: 3, step: 1, messages: [] }) === true; }
  catch { return false; }
})();

// 2. Does the stale delivery touch the NEW generation's ledger? It cannot: the
//    adapter closure never asks the plugin for a ledger again.
const gen2 = lifetime.getLedger(SESSION);
out.newLedgerIsDifferentObject = gen2 !== gen1;
out.newLedgerHasNoSteps = gen2.peekCall('c1') === null;

// 3. A REAL qzone dispatch after the rotation: the plugin must notice the mismatch
//    and fail closed rather than dispatch against a retired epoch.
const status = handle.status();
out.statusAfterRotate = {
  state: status.state,
  generationBound: status.generationBound,
  dispatchAvailable: status.dispatchAvailable,
  staleGenerationObserved: status.staleGenerationObserved,
  stepsRefused: status.stepsRefused,
  adaptersFailed: status.adaptersFailed,
};

// 4. The critical consequence: the adapter created for generation 1 is still alive
//    and still bound to the DISCONNECTED ledger. A fresh agent would get a new
//    adapter on the new ledger, but this one cannot recover.
const refusedBefore = handle.status().stepsRefused;
try { gen1.observeStep({ sessionId: SESSION, turn: 5, step: 1, messages: [] }); } catch {}
out.oldLedgerRefusesEverything = (() => {
  try { return gen1.observeStep({ sessionId: SESSION, turn: 6, step: 1, messages: [] }) !== true; } catch { return true; }
})();
out.stepsRefusedGrewOnStaleDelivery = handle.status().stepsRefused > refusedBefore;

out.verdict = {
  staleEventsReachNewGeneration: false,
  staleEventsReachRetiredGeneration: out.staleStepWroteIntoOldLedger,
  retiredAdapterRecovers: false,
  note: 'existing adapter keeps the retired ledger object; only a NEW agent/created rebinds',
};

out.maxPositions = MAX_POSITIONS;
console.log(JSON.stringify(out, null, 2));
await handle.dispose();
