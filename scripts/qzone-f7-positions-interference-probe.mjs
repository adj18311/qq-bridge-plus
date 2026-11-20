// F7, part two: does ordinary tool traffic interfere with the plugin's `positions`
// map the same way it interferes with the ledger's `calls` map?
//
// `plugins/qzone-safe/index.mjs:127-139` writes a position for EVERY `tool/call`
// event in the session, with a 4096-entry cap and oldest-first eviction. If ordinary
// tool calls share that map, a burst of them can evict a pending qzone position and
// make a legitimate qzone call fail with `origin-unbound` even though its ledger
// binding is perfectly valid.
//
// Run: cmd /c "D:\Node\node.exe scripts\qzone-f7-positions-interference-probe.mjs"
import { createQzonePluginHandle, MAX_POSITIONS } from '../plugins/qzone-safe/index.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

const userMessage = (rpcId) => ({ role: 'user', source: { rpcId } });

function fakeHost() {
  const callbacks = new Map();
  const registered = new Map();
  const on = (name, fn) => {
    const list = callbacks.get(name) ?? [];
    list.push(fn);
    callbacks.set(name, list);
    return () => {};
  };
  return {
    registered,
    ctx: {
      on,
      tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); } },
    },
    emit(name, ...args) { for (const cb of callbacks.get(name) ?? []) cb(...args); },
  };
}

async function harness() {
  const host = fakeHost();
  const agentCallbacks = new Map();
  const dispatched = [];
  const ledger = createQzoneOriginLedger({ sessionId: 's1', epoch: 'e1' });
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: 'e1',
    defineTool: (tool) => tool,
    // Inject the real ledger so this probe exercises the actual consume path.
    sourceLifetime: { sourceEpoch: () => 'e1', getLedger: () => ledger },
    dispatch: async (action, input, context) => { dispatched.push({ action, context }); return { ok: true }; },
  });
  host.emit('agent/created', {
    agent: {
      id: 'agent-1',
      session: { id: 's1' },
      ctx: {
        on: (name, fn) => {
          const list = agentCallbacks.get(name) ?? [];
          list.push(fn);
          agentCallbacks.set(name, list);
          return () => {};
        },
      },
    },
  });
  const preStep = (turn, step, messages) => {
    for (const cb of agentCallbacks.get('agent/pre-step') ?? []) cb({ turn, step, messages }, () => {});
  };
  const toolCall = (turn, step, callId, name) => host.emit('session/event', { id: 's1' }, { type: 'tool/call', data: { turn, step, callId, name } });
  const exec = (callId) => ({ callId, agent: { session: { id: 's1' } } });
  const tool = host.registered.get('qzone_read_posts');
  return { handle, host, ledger, dispatched, preStep, toolCall, exec, tool };
}

const out = { maxPositions: MAX_POSITIONS, scenarios: [] };

// S1: a pending qzone position survives N ordinary tool calls when N < cap.
{
  const h = await harness();
  h.handle.registerBridgeRequest('s1', { requestId: 'r1', origin: 'qq-inbound' });
  h.preStep(1, 1, [userMessage('r1')]);
  h.toolCall(1, 1, 'qzone-pending', 'qzone_read_posts');
  for (let i = 0; i < 100; i += 1) h.toolCall(1, 1, `ord-${i}`, 'pi_tool_load_bash');
  const result = await h.tool.execute({ target_uin: 456 }, h.exec('qzone-pending'));
  out.scenarios.push({
    scenario: 'S1 100 ordinary calls, well under the cap',
    result,
    verdict: result.ok === true ? 'SURVIVED' : 'INTERFERED',
  });
}

// S2: enough ordinary tool calls to reach the positions cap evict the pending qzone
//     position even though the ledger binding is untouched.
{
  const h = await harness();
  h.handle.registerBridgeRequest('s1', { requestId: 'r2', origin: 'qq-inbound' });
  h.preStep(1, 1, [userMessage('r2')]);
  h.toolCall(1, 1, 'qzone-pending', 'qzone_read_posts');
  // The qzone position was written first, so it is the oldest entry and is the first
  // thing evicted once the map is full.
  for (let i = 0; i < MAX_POSITIONS; i += 1) h.toolCall(1, 1, `ord-${i}`, 'pi_tool_load_bash');
  const result = await h.tool.execute({ target_uin: 456 }, h.exec('qzone-pending'));
  out.scenarios.push({
    scenario: `S2 ${MAX_POSITIONS} ordinary calls, at the cap`,
    result,
    verdict: result.ok === true ? 'SURVIVED' : 'EVICTED — a legitimate qzone call lost its position to ordinary traffic',
    // peekCall takes the bare callId; passing an object silently returns null and
    // would look like "the ledger lost the binding too", which is not what happens.
    ledgerBindingStillValid: h.ledger.peekCall('qzone-pending'),
  });
}

// S3: control — the same call with no ordinary traffic at all.
{
  const h = await harness();
  h.handle.registerBridgeRequest('s1', { requestId: 'r3', origin: 'qq-inbound' });
  h.preStep(1, 1, [userMessage('r3')]);
  h.toolCall(1, 1, 'qzone-only', 'qzone_read_posts');
  const result = await h.tool.execute({ target_uin: 456 }, h.exec('qzone-only'));
  out.scenarios.push({ scenario: 'S3 control, zero ordinary traffic', result, verdict: result.ok === true ? 'OK' : 'BROKEN-CONTROL' });
}

console.log(JSON.stringify(out, null, 2));
