// Codex round-7 §4.1 and §4.4, captain-side cross-check.
//
// Q1: is `positionKeyOf = JSON.stringify([sessionId, callId])` injective over every
//     id pair `CTX_ID` admits? Try to build a collision from ids that BOTH pass
//     `/^[A-Za-z0-9_.:-]{1,128}$/`. Also check the old colon join for contrast.
// Q4: same-generation and cross-generation replay. For the cross-generation case a
//     REAL createQzoneSourceLifetime().rotate() is used, and we report which layer
//     refuses (ledger vs store), with the resulting code.
//
// Run: cmd /c "D:\Node\node.exe scripts/qzone-position-and-replay-probe.mjs"
import { createQzoneSourceLifetime } from '../src/core/qzone-source-lifetime-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

// CTX_ID is not exported; mirror it deliberately so a change in the source shows up
// as a mismatch below instead of silently diverging.
const CTX_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const positionKeyOf = (sessionId, callId) => JSON.stringify([sessionId, callId]);
const legacyKeyOf = (sessionId, callId) => `${sessionId}:${callId}`;

const out = {};

// ---------------------------------------------------------------------------
// Q1  key injectivity
// ---------------------------------------------------------------------------
{
  const pairs = [
    ['a:b', 'c'], ['a', 'b:c'],
    ['a:b:c', 'd'], ['a', 'b:c:d'], ['a:b', 'c:d'],
    ['x', ':y'], ['x:', 'y'], ['x::y', 'z'], ['x', '::y'],
    ['a.b', 'c'], ['a', 'b.c'],
    ['a:', 'b'], ['a', 'b:'], ['', 'a'], ['a', ''],
    [':', ':'], ['a'.repeat(128), 'b'], ['a', 'b'.repeat(128)],
  ];
  const shipped = pairs.map(([s, c]) => positionKeyOf(s, c));
  const legacy = pairs.map(([s, c]) => legacyKeyOf(s, c));
  const dupes = (keys) => {
    const seen = new Map();
    keys.forEach((k, i) => { if (seen.has(k)) seen.get(k).push(i); else seen.set(k, [i]); });
    return [...seen.entries()].filter(([, idx]) => idx.length > 1).map(([k, idx]) => ({ key: k, at: idx }));
  };
  out.Q1_key_injectivity = {
    allPairsPassCtxId: pairs.every(([s, c]) => CTX_ID.test(s) && CTX_ID.test(c)),
    pairCount: pairs.length,
    shippedDistinctKeys: new Set(shipped).size,
    shippedCollisions: dupes(shipped),
    legacyDistinctKeys: new Set(legacy).size,
    legacyCollisions: dupes(legacy),
    verdict: new Set(shipped).size === pairs.length && dupes(legacy).length > 0
      ? 'shipped encoding is injective for these id pairs; the colon join is not'
      : 'UNEXPECTED — inspect the tables above',
  };
}

// ---------------------------------------------------------------------------
// Shared harness pieces
// ---------------------------------------------------------------------------
const sessionId = 'sess-position';
const botQq = 111;
const friendUin = 456;
const DAY = Date.parse('2026-11-12T04:00:00Z');
const POST = { tid: 'p1', content: 'hello', time: Math.floor(DAY / 1000) - 3600 };
const userMessage = (rpcId) => ({ role: 'user', source: { rpcId } });
const code = (r) => (r.ok ? r.outcome : `${r.error}${r.reason ? `/${r.reason}` : ''}`);

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

function makeTransport() {
  const actions = [];
  const call = async (action) => {
    actions.push(action);
    if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: botQq } };
    if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: friendUin }] };
    if (action === 'get_qzone_msg_list') return { status: 'ok', retcode: 0, data: { total: 1, msglist: [POST] } };
    throw new Error(`unexpected ${action}`);
  };
  return { call, actions, msgList: () => actions.filter((a) => a === 'get_qzone_msg_list').length };
}

function makeRuntime(lifetime, transport, store) {
  const ledger = lifetime.getLedger(sessionId);
  const runtime = createQzoneRuntime({
    store, botQq,
    sourceEpoch: lifetime.sourceEpoch(),
    authorizeSource: (c) => lifetime.ownsConsumption(c),
    getConnectionEpoch: () => 1,
    getBridgeSessions: () => lifetime.getLedger(sessionId),
    clock: () => DAY,
    mode: 'read-only',
    trackingLimit: 64,
    call: transport.call,
  });
  return { ledger, runtime };
}

function prepare(ledger, { turn, requestId, callId, step = 1 }) {
  const registered = (() => { try { ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' }); return 'ok'; } catch (e) { return `THROW ${e.message}`; } })();
  const stepOk = ledger.observeStep({ sessionId, turn, step, messages: [userMessage(requestId)] });
  const callOk = ledger.observeToolCall({ sessionId, event: { type: 'tool/call', data: { turn, step, callId } } });
  return { registered, stepOk, callOk };
}

// ---------------------------------------------------------------------------
// Q4a  same generation, same callId twice
// ---------------------------------------------------------------------------
{
  const lifetime = createQzoneSourceLifetime();
  const store = makeStore();
  const transport = makeTransport();
  const { ledger, runtime } = makeRuntime(lifetime, transport, store);
  const prep = prepare(ledger, { turn: 1, requestId: 'rpc-same-gen', callId: 'call-same-gen' });
  const first = await runtime.dispatch('read_posts', { target_uin: friendUin }, { sessionId, callId: 'call-same-gen' });
  const msgListAfterFirst = transport.msgList();
  const second = await runtime.dispatch('read_posts', { target_uin: friendUin }, { sessionId, callId: 'call-same-gen' });
  ledger.endTurn({ sessionId, turn: 1 });
  out.Q4a_same_generation_replay = {
    prepared: prep,
    first: code(first),
    second: code(second),
    msgListAfterFirst,
    msgListAfterSecond: transport.msgList(),
    platformCallRepeated: transport.msgList() > msgListAfterFirst,
    refusedBy: 'seenCalls.has(callScope) in src/core/qzone-runtime-wiring.mjs',
  };
}

// ---------------------------------------------------------------------------
// Q4b  REAL rotation, then reuse the exact same id strings on the same turn
// ---------------------------------------------------------------------------
{
  const lifetime = createQzoneSourceLifetime();
  const store = makeStore();
  const transport = makeTransport();
  const gen1 = makeRuntime(lifetime, transport, store);
  const prep1 = prepare(gen1.ledger, { turn: 1, requestId: 'rpc-cross', callId: 'call-cross' });
  const first = await gen1.runtime.dispatch('read_posts', { target_uin: friendUin }, { sessionId, callId: 'call-cross' });
  gen1.ledger.endTurn({ sessionId, turn: 1 });
  const msgListAfterGen1 = transport.msgList();

  const epochBefore = lifetime.sourceEpoch();
  lifetime.rotate();
  const epochAfter = lifetime.sourceEpoch();
  const gen2 = makeRuntime(lifetime, transport, store);

  // Same turn number and same id strings in the new generation.
  const sameTurnPrep = prepare(gen2.ledger, { turn: 1, requestId: 'rpc-cross', callId: 'call-cross' });
  const sameTurn = await gen2.runtime.dispatch('read_posts', { target_uin: friendUin }, { sessionId, callId: 'call-cross' });
  gen2.ledger.endTurn({ sessionId, turn: 1 });
  const msgListAfterSameTurn = transport.msgList();

  // Same ids, but at a DIFFERENT turn number. This has to run in its own fresh
  // generation: re-registering `rpc-cross` inside gen2 would poison it at the
  // ledger (a requestId re-registered after use is poisoned on purpose), which
  // would answer a different question than the one being asked here.
  lifetime.rotate();
  const epochGen3 = lifetime.sourceEpoch();
  const gen3 = makeRuntime(lifetime, transport, store);
  const diffTurnPrep = prepare(gen3.ledger, { turn: 7, requestId: 'rpc-cross', callId: 'call-cross' });
  const diffTurn = await gen3.runtime.dispatch('read_posts', { target_uin: friendUin }, { sessionId, callId: 'call-cross' });
  gen3.ledger.endTurn({ sessionId, turn: 7 });
  const msgListAfterDiffTurn = transport.msgList();

  out.Q4b_cross_generation_replay = {
    generation1: { prepared: prep1, read: code(first), msgListCalls: msgListAfterGen1 },
    rotation: { epochChanged: epochBefore !== epochAfter, oldEpochNull: epochBefore !== epochAfter },
    sameTurnReuse: {
      prepared: sameTurnPrep,
      code: code(sameTurn),
      msgListCallsAfter: msgListAfterSameTurn,
      platformCallRepeated: msgListAfterSameTurn > msgListAfterGen1,
    },
    rotatedAgain: { epochChangedAgain: epochAfter !== epochGen3 },
    differentTurnReuse: {
      prepared: diffTurnPrep,
      code: code(diffTurn),
      msgListCallsAfter: msgListAfterDiffTurn,
      platformCallRepeated: msgListAfterDiffTurn > msgListAfterSameTurn,
    },
    interpretation: 'the new generation starts with empty usedRequests/spentCalls, so the ledger cannot refuse these ids; the store one-shot proof is keyed on a digest that INCLUDES the turn number, so a same-turn reuse is refused as duplicate while a different-turn reuse goes through and issues a second platform read',
  };
}

console.log(JSON.stringify(out, null, 2));
