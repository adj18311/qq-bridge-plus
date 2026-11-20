// Offline rotation harness — run with:
//   cmd /c "D:\Node\node.exe scripts\qzone-rotation-harness.mjs"
//
// Why this file exists: the earlier rotation probes lived under
// `.qzone-channel-lab/`, a DOT directory. Ripgrep, VS Code's default search and
// PowerShell's `Get-ChildItem -Recurse` (without `-Force`) all skip dot
// directories, so a search for `sourceLifetime.rotate()` from the repo root finds
// nothing even though it is called in seven places. That is why Codex reported "no
// actual rotate() call found". This harness lives in `scripts/` so an ordinary
// search can find it, and it calls the REAL rotate().
//
// What it proves, in this order:
//   A  a genuine successful read, its persisted state, then a REAL rotate()
//   B  rotate() while a read is parked inside the transport (controllable barrier)
//   C  rotate() BEFORE the dispatch call
//   D  rotate() after the platform already returned
//   E  old event payloads injected into the new generation
//   F  old consumption credential injected into the new generation
//
// Every generation is `createQzoneSourceLifetime().rotate()` + a NEW ledger + a NEW
// createQzoneRuntime. The only fakes are an in-memory store and local transport
// functions. No network, no real QQ, no credentials, no DSH config.
import { createQzoneSourceLifetime } from '../src/core/qzone-source-lifetime-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

const sessionId = 'sess-harness';
const botQq = 111;
const friendUin = 456;
const DAY = Date.parse('2026-11-12T04:00:00Z');
// Inside the friend window (`now - 7d <= time <= now`) or `filterOfflinePosts`
// silently drops it and the read looks "successful with zero posts".
const POST_TIME_S = Math.floor(DAY / 1000) - 3600;
const POST = { tid: 'p1', content: 'hello from the friend', time: POST_TIME_S };
const userMessage = (rpcId) => ({ role: 'user', source: { rpcId } });
const code = (r) => (r.ok ? r.outcome : r.error);

function makeStore() {
  let state = {
    enabled: true, readAllowed: true, writeAllowed: false,
    accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: false },
    reads: 0, writes: 0, readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-12', todayBrowses: 0, lastBrowseAt: null,
    usedOpportunities: {}, activeStart: 0, activeEnd: 1439, audit: [],
  };
  return {
    read: () => structuredClone(state),
    update(fn) { state = fn(structuredClone(state)); return state; },
    dump: () => structuredClone(state),
  };
}

// The barrier: arm(n) parks the next n get_qzone_msg_list calls inside an await
// until release() is called, so a rotation can be executed while a read is
// genuinely in flight.
function makeTransport() {
  const actions = [];
  let barrier = Promise.resolve();
  let releaseBarrier = () => {};
  let target = 0;
  let entered = 0;
  return {
    actions,
    async call(action) {
      actions.push(action);
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: botQq } };
      if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: friendUin }] };
      if (action === 'get_qzone_msg_list') {
        if (entered < target) { entered += 1; await barrier; }
        return { status: 'ok', retcode: 0, data: { total: 1, msglist: [POST] } };
      }
      throw new Error(`unexpected fake action ${action}`);
    },
    arm(count = 1) {
      barrier = new Promise((resolve) => { releaseBarrier = resolve; });
      target = count;
      entered = 0;
      return { reached: () => entered >= target, release: () => releaseBarrier() };
    },
    platformCalls: () => actions.filter((a) => a === 'get_qzone_msg_list').length,
  };
}

function buildGeneration(lifetime, transport, store) {
  const ledger = lifetime.getLedger(sessionId);
  const epoch = lifetime.sourceEpoch();
  const runtime = createQzoneRuntime({
    store, botQq, sourceEpoch: epoch,
    authorizeSource: (c) => ledger.ownsConsumption(c),
    getConnectionEpoch: () => 1,
    getBridgeSessions: () => ledger,
    clock: () => DAY, mode: 'read-only', trackingLimit: 8,
    call: transport.call,
  });
  return { ledger, epoch, runtime };
}

function prepare(ledger, { turn, requestId, callId, step = 1 }) {
  let registered;
  try { ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' }); registered = 'ok'; }
  catch (error) { registered = String(error.message); }
  const stepOk = ledger.observeStep({ sessionId, turn, step, messages: [userMessage(requestId)] });
  const callOk = ledger.observeToolCall({ sessionId, event: { type: 'tool/call', data: { turn, step, callId } } });
  return { registered, stepOk, callOk };
}

async function until(predicate, label, budgetMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > budgetMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setImmediate(r));
  }
}

const input = { target_uin: friendUin };
const out = {};

// ---------------------------------------------------------------------------
// A  genuine success, persisted state, REAL rotate, then reuse
// ---------------------------------------------------------------------------
{
  const lifetime = createQzoneSourceLifetime({ sessionLimit: 8, trackingLimit: 8 });
  const store = makeStore();
  const transport = makeTransport();
  const gen1 = buildGeneration(lifetime, transport, store);

  const prepared = prepare(gen1.ledger, { turn: 1, requestId: 'rpc-1', callId: 'call-1' });
  const read = await gen1.runtime.dispatch('read_posts', input, { sessionId, callId: 'call-1' });
  const state1 = store.dump();
  const platformAfterSuccess = transport.platformCalls();

  const sameGenReplay = await gen1.runtime.dispatch('read_posts', input, { sessionId, callId: 'call-1' });

  const epoch1 = gen1.epoch;
  const epoch2 = lifetime.rotate();
  const gen2 = buildGeneration(lifetime, transport, store);

  const oldRegister = (() => {
    try { gen1.ledger.registerBridgeRequest({ requestId: 'rpc-late', origin: 'qq-inbound' }); return 'accepted'; }
    catch (error) { return String(error.message); }
  })();
  const oldObserve = gen1.ledger.observeStep({ sessionId, turn: 2, step: 1, messages: [userMessage('rpc-late')] });
  const oldDispatch = await gen1.runtime.dispatch('read_posts', input, { sessionId, callId: 'call-1' });

  const state2 = store.dump();

  const reuseSameTurn = prepare(gen2.ledger, { turn: 1, requestId: 'rpc-1', callId: 'call-1' });
  const reuseDispatch = await gen2.runtime.dispatch('read_posts', input, { sessionId, callId: 'call-1' });
  gen2.ledger.endTurn({ sessionId, turn: 1 });

  const nextPrepared = prepare(gen2.ledger, { turn: 2, requestId: 'rpc-2', callId: 'call-2' });
  const nextRead = await gen2.runtime.dispatch('read_posts', input, { sessionId, callId: 'call-2' });

  out.A_success_then_rotate = {
    prepared,
    read: { code: code(read), posts: Array.isArray(read.posts) ? read.posts.length : null },
    persisted: {
      readAttemptKeys: Object.keys(state1.readAttempts),
      readOutcomes: Object.values(state1.readOutcomes),
      audit: state1.audit.map((a) => `${a.record.action}:${a.record.result}`),
      platformCallsForThisRead: platformAfterSuccess,
    },
    sameGenerationReplay: code(sameGenReplay),
    rotation: {
      epochChanged: epoch1 !== epoch2,
      epochIsPlainUuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(epoch1),
    },
    retiredGeneration: { registerRequest: oldRegister, observeStep: oldObserve, dispatch: code(oldDispatch) },
    survivesRotation: { auditEntries: state2.audit.length, readAttempts: Object.keys(state2.readAttempts).length },
    reuseSameIdSameTurnInNewGeneration: { ...reuseSameTurn, code: code(reuseDispatch) },
    genuineNextTurnInNewGeneration: { ...nextPrepared, code: code(nextRead) },
  };
}

// ---------------------------------------------------------------------------
// B  REAL rotate while a read is parked inside the transport
// ---------------------------------------------------------------------------
{
  const lifetime = createQzoneSourceLifetime({ sessionLimit: 8, trackingLimit: 8 });
  const store = makeStore();
  const transport = makeTransport();
  const gen1 = buildGeneration(lifetime, transport, store);

  prepare(gen1.ledger, { turn: 1, requestId: 'rpc-1', callId: 'call-1' });
  const gate = transport.arm(1);
  const inflight = gen1.runtime.dispatch('read_posts', input, { sessionId, callId: 'call-1' });
  await until(() => gate.reached(), 'transport barrier');
  const issuedAtRotation = transport.platformCalls();

  lifetime.rotate();
  const gen2 = buildGeneration(lifetime, transport, store);
  gate.release();
  const inflightResult = await inflight;

  const freshPrepared = prepare(gen2.ledger, { turn: 1, requestId: 'rpc-9', callId: 'call-9' });
  const fresh = await gen2.runtime.dispatch('read_posts', input, { sessionId, callId: 'call-9' });

  out.B_rotate_during_transport = {
    platformIssuedBeforeRotation: issuedAtRotation,
    inflight: { code: code(inflightResult), posts: Array.isArray(inflightResult.posts) ? inflightResult.posts.length : null },
    oldLedgerObserveStep: gen1.ledger.observeStep({ sessionId, turn: 2, step: 1, messages: [userMessage('x')] }),
    oldLedgerConsumeIsNull: gen1.ledger.consume({ sessionId, turn: 1, step: 1, callId: 'call-1' }) === null,
    oldRuntimeReplay: code(await gen1.runtime.dispatch('read_posts', input, { sessionId, callId: 'call-1' })),
    freshInNewGeneration: { ...freshPrepared, code: code(fresh) },
    platformCallsTotal: transport.platformCalls(),
    note: 'the platform call at the barrier was already issued and cannot be revoked; only bookkeeping and future authorization are revoked.',
  };
}

// ---------------------------------------------------------------------------
// C  REAL rotate BEFORE the dispatch call
// ---------------------------------------------------------------------------
{
  const lifetime = createQzoneSourceLifetime({ sessionLimit: 8, trackingLimit: 8 });
  const store = makeStore();
  const transport = makeTransport();
  const gen1 = buildGeneration(lifetime, transport, store);
  prepare(gen1.ledger, { turn: 1, requestId: 'rpc-1', callId: 'call-1' });

  lifetime.rotate();
  const gen2 = buildGeneration(lifetime, transport, store);
  const onOld = await gen1.runtime.dispatch('read_posts', input, { sessionId, callId: 'call-1' });
  const platformAfterOld = transport.platformCalls();

  out.C_rotate_before_dispatch = {
    oldGenerationDispatch: code(onOld),
    oldGenerationIssuedNoPlatformCall: platformAfterOld === 0,
  };
}

// ---------------------------------------------------------------------------
// D  REAL rotate after the platform already returned
// ---------------------------------------------------------------------------
{
  const lifetime = createQzoneSourceLifetime({ sessionLimit: 8, trackingLimit: 8 });
  const store = makeStore();
  const transport = makeTransport();
  const gen1 = buildGeneration(lifetime, transport, store);
  prepare(gen1.ledger, { turn: 1, requestId: 'rpc-1', callId: 'call-1' });

  // Wrap only the qzone call so the rotation lands after the bytes came back but
  // before the caller resumes.
  let rotatedMidCallback = false;
  const hooked = createQzoneRuntime({
    store, botQq, sourceEpoch: gen1.epoch,
    authorizeSource: (c) => gen1.ledger.ownsConsumption(c),
    getConnectionEpoch: () => 1,
    getBridgeSessions: () => gen1.ledger,
    clock: () => DAY, mode: 'read-only', trackingLimit: 8,
    async call(action) {
      const result = await transport.call(action);
      if (action === 'get_qzone_msg_list' && !rotatedMidCallback) {
        rotatedMidCallback = true;
        lifetime.rotate();
      }
      return result;
    },
  });
  const callerResult = await hooked.dispatch('read_posts', input, { sessionId, callId: 'call-1' });

  out.D_rotate_after_platform_return = {
    rotationHappened: rotatedMidCallback,
    caller: { code: code(callerResult), posts: Array.isArray(callerResult.posts) ? callerResult.posts.length : null },
    platformCalls: transport.platformCalls(),
  };
}

// ---------------------------------------------------------------------------
// E  old event payloads into the new generation
// ---------------------------------------------------------------------------
{
  const lifetime = createQzoneSourceLifetime({ sessionLimit: 8, trackingLimit: 8 });
  const store = makeStore();
  const transport = makeTransport();
  const gen1 = buildGeneration(lifetime, transport, store);
  prepare(gen1.ledger, { turn: 1, requestId: 'rpc-1', callId: 'call-1' });

  const staleStep = { sessionId, turn: 1, step: 1, messages: [userMessage('rpc-1')] };
  const staleCall = { sessionId, event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1' } } };

  lifetime.rotate();
  const gen2 = buildGeneration(lifetime, transport, store);

  out.E_stale_event_injection = {
    staleStepAccepted: gen2.ledger.observeStep(staleStep),
    staleCallAccepted: gen2.ledger.observeToolCall(staleCall),
    staleConsumeIsNull: gen2.ledger.consume({ sessionId, turn: 1, step: 1, callId: 'call-1' }) === null,
    staleDispatch: code(await gen2.runtime.dispatch('read_posts', input, { sessionId, callId: 'call-1' })),
    platformCalls: transport.platformCalls(),
  };
}

// ---------------------------------------------------------------------------
// F  old consumption credential into the new generation
// ---------------------------------------------------------------------------
{
  const lifetime = createQzoneSourceLifetime({ sessionLimit: 8, trackingLimit: 8 });
  const store = makeStore();
  const transport = makeTransport();
  const gen1 = buildGeneration(lifetime, transport, store);
  prepare(gen1.ledger, { turn: 1, requestId: 'rpc-1', callId: 'call-1' });
  const captured = gen1.ledger.consume({ sessionId, turn: 1, step: 1, callId: 'call-1' });
  const copy = captured ? { ...captured } : null;

  lifetime.rotate();
  const gen2 = buildGeneration(lifetime, transport, store);
  prepare(gen2.ledger, { turn: 1, requestId: 'rpc-new', callId: 'call-new' });
  gen2.ledger.observeToolCall({ sessionId, event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-new2' } } });

  out.F_old_consumption_injection = {
    capturedOk: captured !== null,
    intoNewRuntime: code(await gen2.runtime.dispatch('read_posts', input, { sessionId, callId: 'call-new', binding: captured })),
    spreadCopyIntoNewRuntime: code(await gen2.runtime.dispatch('read_posts', input, { sessionId, callId: 'call-new2', binding: copy })),
    intoRetiredRuntime: code(await gen1.runtime.dispatch('read_posts', input, { sessionId, callId: 'call-1', binding: captured })),
    platformCalls: transport.platformCalls(),
  };
}

console.log(JSON.stringify(out, null, 2));
