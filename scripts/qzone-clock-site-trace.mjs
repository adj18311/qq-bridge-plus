// Codex round-7: map each clock invocation to its actual call site, so the
// "which stage was this throw at" question is answered by the stack, not by guess.
//
// Run: cmd /c "D:\Node\node.exe scripts\qzone-clock-site-trace.mjs"
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

const sessionId = 'sess-trace';
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

// Records the innermost caller that is NOT the clock wrapper itself.
function makeTracingClock() {
  const sites = [];
  const clock = () => {
    const stack = String(new Error().stack ?? '').split('\n').slice(1);
    const frames = stack
      .map((line) => line.trim())
      .filter((line) => line.startsWith('at '))
      .map((line) => line.replace(/^at\s+/, ''))
      .filter((line) => !line.includes('makeTracingClock') && !line.includes('tracingClock'));
    // Keep the frames that identify the call site: drop the harness frame and the
    // `now` wrapper, keep `safeClock`/`read` so the stage is visible.
    const useful = frames
      .filter((line) => !line.includes('qzone-clock-site-trace.mjs'))
      .map((line) => line.replace(/\(file:\/\/\/D:\/QQ%20brideg\//, '(').replace(/\)$/, ')'));
    sites.push(useful.slice(0, 3).join(' <- '));
    return DAY;
  };
  return { clock, sites };
}

let turnCounter = 0;
function prepare(ledger, tag) {
  turnCounter += 1;
  const turn = turnCounter;
  const requestId = `req-${tag}`;
  const callId = `call-${tag}`;
  ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  const stepOk = ledger.observeStep({ sessionId, turn, step: 1, messages: [userMessage(requestId)] });
  const callOk = ledger.observeToolCall({ sessionId, event: { type: 'tool/call', data: { turn, step: 1, callId } } });
  return { turn, callId, stepOk, callOk };
}

function build(store, transport, ledger, clock) {
  return createQzoneRuntime({
    store, botQq, sourceEpoch: 'epoch-1',
    authorizeSource: (c) => ledger.ownsConsumption(c),
    getConnectionEpoch: () => 1,
    getBridgeSessions: () => ledger,
    clock,
    mode: 'read-only',
    trackingLimit: 64,
    call: transport.call,
  });
}

const out = {};

// One healthy read: every clock call, in order, with its caller.
{
  const transport = makeTransport();
  const store = makeStore();
  const ledger = createQzoneOriginLedger({ sessionId, epoch: 'epoch-1', trackingLimit: 64 });
  const { clock, sites } = makeTracingClock();
  const runtime = build(store, transport, ledger, clock);
  const p = prepare(ledger, 'trace');
  const r = await runtime.dispatch('read_posts', { target_uin: friendUin }, { sessionId, callId: p.callId });
  ledger.endTurn({ sessionId, turn: p.turn });
  out.healthyRead = {
    code: code(r),
    posts: r.ok ? r.posts.length : null,
    clockCalls: sites.length,
    msgListCalls: transport.msgList(),
    sites,
  };
}

// One read denied at the runtime tool gate (reader never runs).
{
  const transport = makeTransport();
  const store = makeStore();
  store.update((s) => ({ ...s, tools: { read_posts: false, read_comments: false } }));
  const ledger = createQzoneOriginLedger({ sessionId, epoch: 'epoch-1', trackingLimit: 64 });
  const { clock, sites } = makeTracingClock();
  const runtime = build(store, transport, ledger, clock);
  const p = prepare(ledger, 'gated');
  const r = await runtime.dispatch('read_posts', { target_uin: friendUin }, { sessionId, callId: p.callId });
  ledger.endTurn({ sessionId, turn: p.turn });
  out.toolGateDenial = { code: code(r), clockCalls: sites.length, sites, msgListCalls: transport.msgList() };
}

// One read denied at the friendship gate (reader runs, friendship fails).
{
  const transport = makeTransport();
  const store = makeStore();
  const ledger = createQzoneOriginLedger({ sessionId, epoch: 'epoch-1', trackingLimit: 64 });
  const { clock, sites } = makeTracingClock();
  const runtime = build(store, transport, ledger, clock);
  const p = prepare(ledger, 'nofriend');
  const r = await runtime.dispatch('read_posts', { target_uin: 789 }, { sessionId, callId: p.callId });
  ledger.endTurn({ sessionId, turn: p.turn });
  out.friendshipDenial = { code: code(r), clockCalls: sites.length, sites, msgListCalls: transport.msgList() };
}

console.log(JSON.stringify(out, null, 2));
