// Decides the "publish口径" question with behaviour instead of prose.
//
// Claim under test: `WRITE_TOOLS` lists four actions and every one of them returns
// `write-not-wired` at `src/core/qzone-runtime-wiring.mjs:354`. The review said
// `publish` never reaches that line because its MCP schema has no single
// `target_uin` (`src/core/qzone-mcp-contract.mjs:24-28` only allows `target_uins`),
// so `normalizeTarget(input)` returns null for every legal publish input and the
// earlier origin check returns `origin-unverified` at `:349`.
//
// If that is true, then "the write surface is closed by WRITE_TOOLS" is wrong for
// publish: it is closed EARLIER and by a DIFFERENT rule (no per-post target). That
// distinction matters because a future `target_uins`-aware normalizer would silently
// move publish's refusal point onto the WRITE_TOOLS line, and any test that only
// asserts "publish is refused" would stay green either way.

import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';
import { QZONE_MCP_TOOLS } from '../src/core/qzone-mcp-contract.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

const NOW = Date.parse('2026-11-10T04:00:00Z');
const SESSION = 'session-publish';
const BOT = 123;

function store() {
  let state = {
    enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    reads: 0, writes: 0, readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-10', todayBrowses: 0, lastBrowseAt: null,
    usedOpportunities: {}, activeStart: 0, activeEnd: 1439, audit: [],
  };
  return { read: () => structuredClone(state), update(fn) { state = fn(structuredClone(state)); return structuredClone(state); } };
}

const platformCalls = [];

function makeRuntime(ledger) {
  return createQzoneRuntime({
    store: store(), botQq: BOT, mode: 'enabled', trackingLimit: 8,
    getConnectionEpoch: () => 1, sourceEpoch: 'epoch-1',
    authorizeSource: () => true,
    clock: () => NOW,
    call: async (action, params) => { platformCalls.push({ action, params }); return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } }; },
    getBridgeSessions: () => ledger,
  });
}

// One dispatch = one freshly registered request, one step, one callId. The ledger
// only binds inside the step that cited a registered request.
function makeTurn(ledger, turn, requestId, callId) {
  ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  ledger.observeStep({ sessionId: SESSION, turn, step: 1, messages: [{ role: 'user', source: { rpcId: requestId } }] });
  ledger.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn, step: 1, callId, name: 'qzone_publish' } } });
  return { sessionId: SESSION, callId };
}

async function probeAction(runtime, ledger, action, input, turn) {
  const callId = `call-${action}-${turn}`;
  const ctx = makeTurn(ledger, turn, `req-${action}-${turn}`, callId);
  const before = platformCalls.length;
  const result = await runtime.dispatch(action, input, ctx);
  const after = platformCalls.length;
  ledger.endTurn({ sessionId: SESSION, turn });
  return { action, result, platformCalls: after - before };
}

const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'epoch-1', trackingLimit: 8 });
const runtime = makeRuntime(ledger);

const legalInputs = {
  read_posts: { target_uin: 456 },
  read_comments: { tid: 'p1', target_uin: 456 },
  publish: { content: 'hello', ugc_right: 1 },
  comment: { tid: 'p1', target_uin: 456, content: 'hi' },
  reply: { tid: 'p1', target_uin: 456, content: 'hi', comment_id: 'c1', comment_uin: 789 },
  like: { tid: 'p1', target_uin: 456 },
};

const rows = [];
let turn = 0;
for (const [action, input] of Object.entries(legalInputs)) {
  turn += 1;
  rows.push(await probeAction(runtime, ledger, action, input, turn));
}

// The decisive extra case: publish WITH target_uins, which is the only legal way to
// aim a publish at other people's walls. If normalizeTarget ignores it (as the
// schema/no-single-target argument claims), the refusal point does not move.
turn += 1;
rows.push(await probeAction(runtime, ledger, 'publish', { content: 'hello', ugc_right: 16, target_uins: [456] }, turn));

const byAction = Object.fromEntries(rows.map((row) => [row.action + (row.result.error === 'origin-unverified' && row.platformCalls === 0 ? '' : ''), row]));
const summary = rows.map((row) => ({
  action: row.action, error: row.result.error ?? null, ok: row.result.ok ?? null,
  outcome: row.result.outcome ?? null, reason: row.result.reason ?? null, platformCalls: row.platformCalls,
}));

const writeTools = ['publish', 'comment', 'reply', 'like'];
const table = Object.fromEntries(summary.map((row) => [row.action, row]));
const report = {
  probe: 'publish-write-gate-reachability',
  schemaActions: Object.keys(QZONE_MCP_TOOLS ?? {}),
  rows: summary,
  // Is `write-not-wired` reachable for each declared write tool?
  writeNotWiredReachable: Object.fromEntries(writeTools.map((action) => [action, table[action]?.error === 'write-not-wired'])),
  allRefused: summary.every((row) => row.ok !== true || row.outcome === 'unknown'),
  everyWriteIssuedZeroPlatformCalls: writeTools.every((action) => table[action]?.platformCalls === 0),
  readPostsReachedTransport: table.read_posts?.platformCalls === 1,
  readCommentsRefusedBeforeTransport: table.read_comments?.platformCalls === 0,
  publishWithTargetUinsStillOriginUnverified: null,
};
report.publishWithTargetUinsStillOriginUnverified = rows[rows.length - 1].result.error === 'origin-unverified'
  && rows[rows.length - 1].platformCalls === 0;

console.log(JSON.stringify(report, null, 2));

// The verdict this probe supports, stated as assertions so a future change breaks it.
const failures = [];
if (!report.everyWriteIssuedZeroPlatformCalls) failures.push('write tool issued a platform call');
if (table.comment?.error !== 'write-not-wired') failures.push('comment should reach the write gate');
if (table.reply?.error !== 'write-not-wired') failures.push('reply should reach the write gate');
if (table.like?.error !== 'write-not-wired') failures.push('like should reach the write gate');
if (table.publish?.error === 'write-not-wired') failures.push('publish unexpectedly reached the write gate');
if (!report.publishWithTargetUinsStillOriginUnverified) failures.push('publish with target_uins should still be refused before the write gate');
if (!report.readPostsReachedTransport) failures.push('read_posts should still reach the transport');
console.log(JSON.stringify({ done: true, failures }));
if (failures.length > 0) process.exitCode = 1;
