// Codex round-8: is a request/call id length gated at EVERY real entry point?
// "the bridge only forwards v4 UUIDs" is not an answer — that is a property of one
// caller, not of these bytes.
//
// Enumerate every place a requestId or callId enters the subsystem and measure
// whether an over-long value is refused. Each row is a real call, not a reading.
//
// Run: cmd /c "D:\Node\node.exe scripts\qzone-id-length-entries-probe.mjs"
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';
import { createQzonePluginHandle } from '../plugins/qzone-safe/index.mjs';
import { getQzoneDshSessionContext } from '../plugins/qzone-safe/session-context.mjs';

const BIG = 'x'.repeat(300);
const OK128 = 'y'.repeat(128);
const TOO129 = 'z'.repeat(129);
const out = { entries: [] };

const record = (entry, accepted, note) => out.entries.push({ entry, overLongAccepted: accepted, note });

// 1  ledger.registerBridgeRequest — requestId
{
  const ledger = createQzoneOriginLedger({ sessionId: 's1', epoch: 'e1' });
  let bigThrew = false;
  try { ledger.registerBridgeRequest({ requestId: BIG, origin: 'qq-inbound' }); } catch { bigThrew = true; }
  let okAccepted = true; let too129Threw = false;
  try { ledger.registerBridgeRequest({ requestId: OK128, origin: 'qq-inbound' }); } catch { okAccepted = false; }
  try { ledger.registerBridgeRequest({ requestId: TOO129, origin: 'qq-inbound' }); } catch { too129Threw = true; }
  record('ledger.registerBridgeRequest(requestId)', !bigThrew,
    `300 chars ${bigThrew ? 'REFUSED' : 'ACCEPTED'}, 128 ${okAccepted ? 'accepted' : 'refused'}, 129 ${too129Threw ? 'refused' : 'ACCEPTED'}`);
  out.entries.at(-1).boundaryIsExactly128 = okAccepted && too129Threw;
}

// 2  ledger.observeToolCall — callId
{
  const ledger = createQzoneOriginLedger({ sessionId: 's1', epoch: 'e1' });
  ledger.registerBridgeRequest({ requestId: 'r1', origin: 'qq-inbound' });
  ledger.observeStep({ sessionId: 's1', turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'r1' } }] });
  const big = ledger.observeToolCall({ sessionId: 's1', event: { type: 'tool/call', data: { turn: 1, step: 1, callId: BIG } } });
  const ok = ledger.observeToolCall({ sessionId: 's1', event: { type: 'tool/call', data: { turn: 1, step: 1, callId: OK128 } } });
  const too = ledger.observeToolCall({ sessionId: 's1', event: { type: 'tool/call', data: { turn: 1, step: 1, callId: TOO129 } } });
  record('ledger.observeToolCall(callId)', big === true,
    `300 chars ${big ? 'ACCEPTED' : 'refused'}, 128 ${ok ? 'accepted' : 'refused'}, 129 ${too ? 'ACCEPTED' : 'refused'}`);
  out.entries.at(-1).boundaryIsExactly128 = ok === true && too === false;
}

// 3  session-context.getQzoneDshSessionContext — sessionId and callId
{
  const bigCall = getQzoneDshSessionContext({ agent: { session: { id: 's1' } }, callId: BIG });
  const ok = getQzoneDshSessionContext({ agent: { session: { id: 's1' } }, callId: OK128 });
  const bigSession = getQzoneDshSessionContext({ agent: { session: { id: BIG } }, callId: 'c1' });
  record('session-context.getQzoneDshSessionContext', bigCall !== null,
    `over-long callId ${bigCall === null ? 'refused' : 'ACCEPTED'}, 128 ${ok ? 'accepted' : 'refused'}, over-long sessionId ${bigSession === null ? 'refused' : 'ACCEPTED'}`);
  out.entries.at(-1).boundaryIsExactly128 = bigCall === null && ok !== null && bigSession === null;
}

// 4  runtime.dispatch ctx — via CTX_ID
{
  const store = { read: () => ({ enabled: true, readAllowed: true, writeAllowed: false, accessPaused: false, writePaused: false, tools: { read_posts: true }, writes: 0, reads: 0, readAttempts: {}, readOutcomes: {}, activeStart: 0, activeEnd: 1439, audit: [], notices: [], usedOpportunities: {}, todayBrowses: 0, browseDay: '2026-11-12', lastBrowseAt: null }), update: (fn) => fn(store.read()) };
  const ledger = createQzoneOriginLedger({ sessionId: 's1', epoch: 'e1' });
  const runtime = createQzoneRuntime({
    store, botQq: 1, sourceEpoch: 'e1',
    authorizeSource: () => true, getConnectionEpoch: () => 1,
    getBridgeSessions: () => ledger, clock: () => 0, mode: 'read-only', trackingLimit: 8,
    call: async () => ({ status: 'ok', retcode: 0, data: { total: 0, msglist: [] } }),
  });
  const big = await runtime.dispatch('read_posts', { target_uin: 2 }, { sessionId: 's1', callId: BIG });
  const ok = await runtime.dispatch('read_posts', { target_uin: 2 }, { sessionId: 's1', callId: OK128 });
  record('runtime.dispatch(ctx.callId) via CTX_ID', big.error !== 'missing-native-context',
    `over-long ${JSON.stringify(big)}, 128 ${JSON.stringify(ok)}`);
  out.entries.at(-1).boundaryIsExactly128 = big.error === 'missing-native-context';
}

// 5  plugin `positions` map — the session/event announce path. This is the one path
//    that is NOT behind any of the gates above.
//
//    `ready` needs runtime.dispatch AND a non-empty runtime.epoch; tool registration
//    needs a defineTool (the real one lives in @deepseek-ai/dsh-tools, which is not
//    resolvable here), so a stub factory is injected to reach DISPATCH_READY and the
//    registered tools are captured by the fake `ctx.tools.register`. That lets the
//    probe drive the whole real chain: announce -> positions -> tool execute ->
//    dispatchBound -> positions lookup -> ledger.consume.
{
  const handlers = [];
  const tools = new Map();
  const ctx = {
    on: (name, fn) => { handlers.push({ name, fn }); return () => {}; },
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } },
  };
  const defineTool = (definition) => definition;
  const seen = [];
  const handle = await createQzonePluginHandle(ctx, { enabled: true }, {
    dispatch: async (action, input, context) => { seen.push({ action, callId: context?.callId }); return { ok: true }; },
    epoch: 'e1',
    defineTool,
    getConnectionEpoch: () => 1,
  });
  const sub = handlers.find((h) => h.name === 'session/event');
  const announce = (callId) => sub?.fn({ id: 's1' }, { type: 'tool/call', data: { turn: 1, step: 1, callId } });
  const tool = tools.get('qzone_read_posts');
  const exec = (callId) => ({ callId, agent: { session: { id: 's1' } } });
  const runTool = async (callId) => {
    announce(callId);
    return tool ? await tool.execute({ target_uin: 2 }, exec(callId)) : 'tool-not-registered';
  };

  out.positionsEntry = {
    subscriptionFound: Boolean(sub),
    toolsRegistered: tools.size,
    handleState: handle.status().state,
    overLongCallId: JSON.stringify(await runTool(BIG)),
    withinLimitCallId: JSON.stringify(await runTool(OK128)),
    dispatchCalls: seen.length,
    note: 'The announce path now drops ids that could never dispatch: `plugins/qzone-safe/index.mjs` tests POSITION_ID (/^[A-Za-z0-9_.:-]{1,128}$/) before writing a position, the same charset the tool surface and the ledger already require. The over-long id is therefore refused twice over: not stored as a position, and refused at the tool handler by getQzoneDshSessionContext.',
  };
  out.positionsEntry.lengthGateIsDownstream = out.positionsEntry.overLongCallId.includes('missing-native-context');

  // Occupancy is pinned in `test-qzone-position-id-gate.mjs` against a REAL ledger:
  // this probe's runtime has no sourceLifetime, so every dispatch ends `origin-unbound`
  // from the ledger and would not distinguish "position refused" from "position lost".
  out.positionsEntry.occupancyProof = 'see scripts/test-qzone-position-id-gate.mjs';

  if (handle.dispose) await handle.dispose();
}

console.log(JSON.stringify(out, null, 2));
