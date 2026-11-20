// Production wiring: does the approval broker actually record the decision, and does the runtime
// assembly stay FAIL-CLOSED on writes unless a caller explicitly injects a write path?
//
// WHAT IS REAL HERE
//   · a real temporary SQLite store (openOfflineStore) opened under the OS temp dir;
//   · the real write-audit SINK, the real broker adapter recorder and the real approval broker;
//   · the real runtime composition root, the real origin ledger, the real operation authorizer, the
//     real offline write path and the real approved-publish dispatch.
//
// WHAT IS A FIXTURE, AND ONLY THIS
//   · send (records the payload; answers { ok: true } — no OneBot call is made);
//   · call (the read transport; answers nothing usable and is ASSERTED to be untouched);
//   · a pinned clock;
//   · approveOperation (the host verdict: strict true), which is exactly the host's job.
//
// WHAT THIS FILE DOES NOT PROVE: that a real approval came from a human, that the platform received
// anything, or that the audit rows describe what actually left the process. The sink validates
// SHAPE, never truth (qzone-write-audit-offline.mjs header), and send is injected everywhere.
//
// NO NETWORK, NO REAL state/ FILE: every store lives in a fresh mkdtemp directory, and call is a
// local function that only counts.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { initializeReplayState } from '../src/core/qzone-replay-claim-offline.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createOfflineWritePath } from '../src/core/qzone-write-path-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { createQzoneWriteAudit } from '../src/core/qzone-write-audit-offline.mjs';
import {
  createQzoneProductionApprovalBroker,
  createQzoneProductionRuntime,
  createQzoneStrictDecisionRecorder,
} from '../src/core/qzone-production-wiring.mjs';

const NOW = Date.parse('2026-11-15T04:00:00Z');
const ACCOUNT = 123;
const SESSION = 's1';
const REQUEST = 'request-1';
const CALL = 'c1';
const OPERATOR = 'console-session-abc';
const PUBLISH_INPUT = Object.freeze({ content: 'hello world', ugc_right: 1 });
const COMMENT_INPUT = Object.freeze({ tid: 'post-1', target_uin: 456, content: 'nice post' });
// sha256 of the canonical rendering of ADAPTER_INPUT — a literal computed INDEPENDENTLY of the module
// under test (the same value scripts/test-qzone-write-audit-broker-adapter.mjs pins), so the
// recorder's digest cross-check is not circular.
const ADAPTER_DIGEST = '75455d47faa4d3e205e6545a9b0aa58e990e532d6ab69e3189874014d601531f';
const ADAPTER_INPUT = Object.freeze({ content: 'hello there', ugc_right: 1 });
// The audit id of one authorisation, derived here from the DOCUMENTED formula
// (sha256('qzone-write-audit' + newline + accountId + sessionId + requestId + callId), first 32 hex)
// rather than by calling the module's own helper.
const AUTH_ID = createHash('sha256')
  .update('qzone-write-audit' + String.fromCharCode(10) + ACCOUNT + String.fromCharCode(10) + SESSION
    + String.fromCharCode(10) + REQUEST + String.fromCharCode(10) + CALL, 'utf8')
  .digest('hex')
  .slice(0, 32);

function initialState(now = NOW) {
  return {
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 10, comment: 25, like: 30 },
    ledger: { day: beijingDay(now), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [],
    reads: 0, writes: 0, readAttempts: {}, readOutcomes: {},
    browseDay: beijingDay(now), todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
    activeStart: 0, activeEnd: 1439, audit: [], notices: [],
  };
}

/** One real temp SQLite store + the real ledger, cleaned up even when an assertion throws. */
function world(t, { replay = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-production-wiring-'));
  t.after(() => {
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle */ }
    }
  });
  const store = openOfflineStore(path.join(dir, 'state.db'), initialState());
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  if (replay) assert.equal(initializeReplayState(store, { now: NOW }).ok, true, '前提：B2 replay 集合已初始化');
  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1' });
  ledger.registerBridgeRequest({ requestId: REQUEST, origin: 'qq-inbound' });
  return { store, ledger };
}

/**
 * Observe one pre-step and one tool/call.
 *
 * A (turn, step) pair is single-use, AND a bridge requestId may be cited by only ONE step (a reused id
 * is poisoned and the step is refused — qzone-origin-ledger-offline.mjs:199-207). So a second dispatch
 * needs its own requestId, registered first.
 */
function observe(ledger, callId = CALL, { step = 1, requestId = REQUEST } = {}) {
  if (requestId !== REQUEST) ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  assert.equal(ledger.observeStep({
    sessionId: SESSION, turn: 1, step, messages: [{ role: 'user', source: { rpcId: requestId } }],
  }), true, '前提：step ' + step + '（' + requestId + '）已观察');
  assert.equal(ledger.observeToolCall({
    sessionId: SESSION, event: { type: 'tool/call', data: { turn: 1, step, callId } },
  }), true, '前提：tool/call ' + callId + ' 已观察');
}

/** The frozen operation the broker queues — the real authorizer's shape, with a real digest. */
function operation(over = {}) {
  return Object.freeze({
    authorizationId: 'ticket-uuid-1',
    accountId: ACCOUNT,
    sessionId: SESSION,
    requestId: REQUEST,
    callId: CALL,
    connectionEpoch: 8,
    action: 'publish',
    input: ADAPTER_INPUT,
    inputDigest: ADAPTER_DIGEST,
    expiresAt: NOW + 30000,
    ...over,
  });
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 1. APPROVAL SINK — a decision becomes a durable approval row in state.writeAudit
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('PW-1 decide(approved) ⇒ state.writeAudit 落一条 approval 行，operator 来自传入值', async (t) => {
  const { store } = world(t);
  const { broker, audit } = createQzoneProductionApprovalBroker({ store, clock: () => NOW });
  assert.equal(typeof broker.approveOperation, 'function');
  assert.equal(typeof broker.decide, 'function');
  assert.equal(typeof audit.recordWrite, 'function', '★ 同一个 sink 必须对外可见，写路径要复用它');

  const op = operation();
  const pending = broker.approveOperation(op);
  assert.equal(broker.listPending().length, 1, '前提：票据已入队');

  const decided = broker.decide(
    { authorizationId: op.authorizationId, inputDigest: op.inputDigest, approved: true },
    { operator: OPERATOR },
  );
  assert.equal(decided, true, '★★★ 审计写成功时 decide 必须返回 true');
  assert.equal(await pending, true, '★ approveOperation 的 promise 以「批准」收尾');
  assert.equal(broker.listPending().length, 0, '★ 票据已释放');

  const rows = store.read().writeAudit ?? [];
  assert.equal(rows.length, 1, '★★★ 必须恰好一条 write-audit 行');
  const [row] = rows;
  assert.equal(row.stage, 'approval');
  assert.equal(row.decision, 'approved');
  assert.equal(row.operatorSessionId, OPERATOR, '★★ operator 身份来自 decide 的 operator 参数');
  // The display LABEL is a different field, and the broker never supplies one: only the
  // server-minted session id is recorded. null means "no label recorded", never "no operator".
  assert.equal(row.operator, null, '★ 未传显示名 ⇒ operator 为 null（不是匿名批准）');
  assert.equal(row.decidedAt, NOW, '★ decidedAt 来自注入的 clock');
  assert.equal(row.outcome, null, '★★ 决定不是平台结果');
  assert.equal(row.authorizationId, AUTH_ID, '★★ 审计 id 是 B2 四元组摘要，不是票据 UUID');
  assert.notEqual(row.authorizationId, op.authorizationId, '★ 不是 ticket uuid');
  assert.equal(row.accountId, ACCOUNT);
  assert.equal(row.sessionId, SESSION);
  assert.equal(row.requestId, REQUEST);
  assert.equal(row.callId, CALL);
  assert.equal(row.connectionEpoch, 8);
  assert.equal(row.action, 'publish');
  assert.equal(JSON.stringify(rows).includes('hello there'), false, '★★★ 正文不得进入审计行');
  assert.equal(row.inputDigest, ADAPTER_DIGEST);
});

test('PW-2 decide(rejected) ⇒ 也落一行 approval，decision=rejected，票据关闭且不批准', async (t) => {
  const { store } = world(t);
  const { broker } = createQzoneProductionApprovalBroker({ store, clock: () => NOW });
  const op = operation({ authorizationId: 'ticket-uuid-2' });
  const pending = broker.approveOperation(op);
  assert.equal(broker.decide(
    { authorizationId: op.authorizationId, inputDigest: op.inputDigest, approved: false },
    { operator: OPERATOR },
  ), true, '★ 记录成功才返回 true（记录成功 ≠ 批准）');
  assert.equal(await pending, false, '★★ 拒绝的票据以 false 收尾');
  const rows = store.read().writeAudit ?? [];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, 'rejected');
  assert.equal(rows[0].operatorSessionId, OPERATOR);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 2. FAIL-CLOSED — the audit cannot be written ⇒ decide false AND the ticket is closed
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('PW-3 审计写失败 ⇒ decide 返回 false、票据关闭（不批准），store 里零行', async (t) => {
  const { store: real } = world(t);
  // The ONLY injected fault: a store whose transaction throws. That is the real failure shape of
  // "the sink could not extend the trail" — nothing is half-written, and the sink propagates.
  const brokenStore = {
    read: () => real.read(),
    update() { throw new Error('synthetic write-audit outage'); },
  };
  const { broker, recordDecision } = createQzoneProductionApprovalBroker({ store: brokenStore, clock: () => NOW });

  assert.equal(recordDecision(Object.freeze({
    operation: operation(), operator: OPERATOR, approved: true,
  })), false, '★ 审计写不进去 ⇒ 记录器回答 false（不抛错）');

  const op = operation({ authorizationId: 'ticket-uuid-3' });
  const pending = broker.approveOperation(op);
  assert.equal(broker.listPending().length, 1, '前提：票据已入队');
  const decided = broker.decide(
    { authorizationId: op.authorizationId, inputDigest: op.inputDigest, approved: true },
    { operator: OPERATOR },
  );
  assert.equal(decided, false, '★★★ 记录失败时绝不能批准');
  assert.equal(await pending, false, '★★★ 票据被关闭为「不批准」（不是悬空 promise）');
  assert.equal(broker.listPending().length, 0, '★★★ 票据已被关闭');
  assert.equal((real.read().writeAudit ?? []).length, 0, '★★ 一行都没写成');
  assert.equal(broker.decide(
    { authorizationId: op.authorizationId, inputDigest: op.inputDigest, approved: true },
    { operator: OPERATOR },
  ), false, '★★ 已关闭的票据不能被二次批准');
});

test('PW-4 记录器返回 thenable ⇒ 归一化为 false（同步歧义不得流出）', () => {
  assert.equal(createQzoneStrictDecisionRecorder(async () => true)({}), false,
    '★★★ 异步 true 不是 true：审批路径必须同步可判');
  assert.equal(createQzoneStrictDecisionRecorder(() => true)({}), true);
  assert.equal(createQzoneStrictDecisionRecorder(() => false)({}), false);
  assert.equal(createQzoneStrictDecisionRecorder(() => { throw new Error('x'); })({}), false);
  assert.equal(createQzoneStrictDecisionRecorder(() => 1)({}), false, '★ 真值但不是 true');
  assert.equal(createQzoneStrictDecisionRecorder(() => undefined)({}), false);
  assert.throws(() => createQzoneStrictDecisionRecorder(null), TypeError);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 3. RUNTIME ASSEMBLY — no writeWiring means the write is REFUSED, and nothing is sent
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('PW-5 不传 writeWiring ⇒ comment 被拒为 write-not-wired，send/call 调用 0 次', async (t) => {
  const { store, ledger } = world(t, { replay: true });
  const calls = [];
  const sent = [];
  const call = async (...args) => { calls.push(args); return { status: 'ok', retcode: 0, data: {} }; };
  const send = async (payload) => { sent.push(payload); return { ok: true }; };

  const built = createQzoneProductionRuntime({
    store, botQq: ACCOUNT, sourceEpoch: 'e1',
    authorizeSource: (consumption) => ledger.ownsConsumption(consumption),
    getConnectionEpoch: () => 8,
    call,
    getBridgeSessions: (sid) => (sid === SESSION ? ledger : null),
    clock: () => NOW,
    mode: 'enabled',
    operationAuthorization: { replayStore: store, approveOperation: () => true },
  });
  const { runtime, teardown } = built;
  assert.equal(typeof teardown, 'function');
  // `send` exists in this scope on purpose and is NEVER injected: the point of this test is that the
  // assembly offers no route to it at all.

  observe(ledger);
  const result = await runtime.dispatch('comment', COMMENT_INPUT, { sessionId: SESSION, callId: CALL });
  assert.equal(result.ok, false, '★★★ 写必须被拒: ' + JSON.stringify(result));
  assert.equal(result.error, 'write-not-wired', '★★★ 缺省失败关闭：write-not-wired');
  assert.equal(sent.length, 0, '★★★ 零次 send');
  assert.equal(calls.length, 0, '★★★ 零次平台 call（读传输也没被碰）');
  // t43: read_comments is now wired (plain comment pages). The property this line protects is
  // unchanged — the assembly must not quietly wire a WRITE tool — and writes are still refused
  // in the assertion above.
  assert.deepEqual(runtime.status().wiredTools, ['read_posts', 'read_comments'],
    '★ 装配没有偷偷多接一个写工具（读工具接齐，写工具仍全部拒绝）');

  // publish carries no target_uin, so the runtime refuses it EARLIER (origin-unverified) — the
  // pre-existing behaviour this assembly must not change. Pinned as measured, not as wished.
  observe(ledger, 'c2', { step: 2, requestId: 'request-2' });
  const publish = await runtime.dispatch('publish', PUBLISH_INPUT, { sessionId: SESSION, callId: 'c2' });
  assert.equal(publish.ok, false);
  assert.equal(publish.error, 'origin-unverified', '★ publish 的老拒绝原因原样保留');
  assert.equal(sent.length, 0, '★★★ 仍然零次 send');

  assert.equal(teardown(), true, '★ 首次 teardown 报告一次');
  assert.equal(teardown(), false, '★ 幂等');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 4. RUNTIME ASSEMBLY + EXPLICIT writeWiring — the write reaches the injected send
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('PW-6 传 writeWiring ⇒ publish 走到注入的假 send（记录 payload），call 0 次，无真实请求', async (t) => {
  const { store, ledger } = world(t, { replay: true });
  const calls = [];
  const sent = [];
  const call = async (...args) => { calls.push(args); return { status: 'ok', retcode: 0, data: {} }; };
  const send = async (payload) => { sent.push(payload); return { ok: true }; };
  const writePath = (transport) => createOfflineWritePath({ store, clock: () => NOW, transport });

  const { runtime } = createQzoneProductionRuntime({
    store, botQq: ACCOUNT, sourceEpoch: 'e1',
    authorizeSource: (consumption) => ledger.ownsConsumption(consumption),
    getConnectionEpoch: () => 8,
    call,
    getBridgeSessions: (sid) => (sid === SESSION ? ledger : null),
    clock: () => NOW,
    mode: 'enabled',
    operationAuthorization: { replayStore: store, approveOperation: () => true },
    writeWiring: { send, writePath, source: 'qq', actions: ['publish'] },
  });

  observe(ledger);
  const result = await runtime.dispatch('publish', PUBLISH_INPUT, { sessionId: SESSION, callId: CALL });
  assert.equal(result.ok, true, '★★★ 显式接线后应当成功: ' + JSON.stringify(result));
  assert.equal(result.outcome, 'success');
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1, '★★★ send 恰好一次');
  assert.deepEqual(sent[0], {
    action: 'send_qzone_msg', params: { content: 'hello world', ugc_right: 1 },
  }, '★★ 发给 send 的就是平台请求（参数不得被改写）');
  assert.equal(calls.length, 0, '★★★ 读传输 0 次：这是离线假 send，没有真实请求');

  assert.equal(store.read().ledger.used.post, 1, '★ 配额记账发生了一次');
  const dsp = (store.read().audit ?? []).filter((e) => String(e.id).startsWith('dsp_'));
  assert.equal(dsp.length, 1);
  assert.equal(dsp[0].record.result, 'success');
});

test('PW-7 writeWiring + audit（装配侧透传）⇒ approval 与 intent/result 行共用同一 authorizationId', async (t) => {
  const { store, ledger } = world(t, { replay: true });
  const sent = [];
  const call = async () => { throw new Error('读传输不应被调用'); };
  const send = async (payload) => { sent.push(payload); return { ok: true }; };
  const writePath = (transport) => createOfflineWritePath({ store, clock: () => NOW, transport });
  // The SAME sink the approval broker uses. This is the production invariant: three rows, one id.
  const { broker, audit } = createQzoneProductionApprovalBroker({ store, clock: () => NOW });

  const { runtime } = createQzoneProductionRuntime({
    store, botQq: ACCOUNT, sourceEpoch: 'e1',
    authorizeSource: (consumption) => ledger.ownsConsumption(consumption),
    getConnectionEpoch: () => 8,
    call,
    getBridgeSessions: (sid) => (sid === SESSION ? ledger : null),
    clock: () => NOW,
    mode: 'enabled',
    operationAuthorization: { replayStore: store, approveOperation: () => true },
    writeWiring: { send, writePath, source: 'qq', actions: ['publish'] },
    audit,
  });

  observe(ledger);
  const result = await runtime.dispatch('publish', PUBLISH_INPUT, { sessionId: SESSION, callId: CALL });
  assert.equal(result.ok, true, '★★ 应当成功: ' + JSON.stringify(result));
  assert.equal(Object.hasOwn(result, 'auditFailed'), false, '★ 审计成功时不得带 auditFailed');

  const op = operation();
  const pending = broker.approveOperation(op);
  assert.equal(broker.decide(
    { authorizationId: op.authorizationId, inputDigest: op.inputDigest, approved: true },
    { operator: OPERATOR },
  ), true);
  assert.equal(await pending, true);

  const rows = store.read().writeAudit ?? [];
  assert.deepEqual(rows.map((r) => r.stage), ['intent', 'result', 'approval'],
    '★★ 三条事实各占一行，且 intent 先于 result（approval 由 broker 后写）');
  assert.equal(new Set(rows.map((r) => r.authorizationId)).size, 1, '★★★ 三行必须共用一个 authorizationId');
  assert.equal(rows[0].authorizationId, AUTH_ID, '★★ 且等于四元组摘要');
  assert.equal(rows[0].outcome, null, '★ intent 无 outcome');
  assert.equal(rows[1].outcome, 'success', '★★ result 写的是真实 outcome');
  assert.equal(rows[2].decision, 'approved');
  assert.equal(rows[2].operatorSessionId, OPERATOR);
  assert.equal(sent.length, 1, '★★★ 只有一个 send（审批后不重发）');
});

test('PW-8 传 writeWiring 但 action 未包含 ⇒ write-action-not-composed，send 0 次', async (t) => {
  const { store, ledger } = world(t, { replay: true });
  const sent = [];
  const { runtime } = createQzoneProductionRuntime({
    store, botQq: ACCOUNT, sourceEpoch: 'e1',
    authorizeSource: (consumption) => ledger.ownsConsumption(consumption),
    getConnectionEpoch: () => 8,
    call: async () => { throw new Error('读传输不应被调用'); },
    getBridgeSessions: (sid) => (sid === SESSION ? ledger : null),
    clock: () => NOW,
    mode: 'enabled',
    operationAuthorization: { replayStore: store, approveOperation: () => true },
    writeWiring: {
      send: async (payload) => { sent.push(payload); return { ok: true }; },
      writePath: (transport) => createOfflineWritePath({ store, clock: () => NOW, transport }),
      source: 'qq', actions: ['publish'],
    },
  });
  observe(ledger);
  const result = await runtime.dispatch('comment', COMMENT_INPUT, { sessionId: SESSION, callId: CALL });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'write-action-not-composed', '★★ 未接线的动作保持拒绝');
  assert.equal(sent.length, 0, '★★★ 零次 send');
});

test('PW-9 只传 audit、不传 writeWiring ⇒ 写能力不因此打开，write-not-wired 且零行审计', async (t) => {
  const { store, ledger } = world(t, { replay: true });
  const audit = createQzoneWriteAudit({ store });
  const sent = [];
  const { runtime } = createQzoneProductionRuntime({
    store, botQq: ACCOUNT, sourceEpoch: 'e1',
    authorizeSource: (consumption) => ledger.ownsConsumption(consumption),
    getConnectionEpoch: () => 8,
    call: async () => { throw new Error('读传输不应被调用'); },
    getBridgeSessions: (sid) => (sid === SESSION ? ledger : null),
    clock: () => NOW,
    mode: 'enabled',
    audit,
  });
  observe(ledger);
  const result = await runtime.dispatch('comment', COMMENT_INPUT, { sessionId: SESSION, callId: CALL });
  assert.equal(result.error, 'write-not-wired', '★★★ 审计 sink 本身不是写能力');
  assert.equal(sent.length, 0);
  assert.equal((store.read().writeAudit ?? []).length, 0, '★★ 没接线 ⇒ 不会凭空产生审计行');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 5. INVALID DEPENDENCIES — TypeError, never a silently invented default
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('PW-10 createQzoneProductionApprovalBroker 参数非法 ⇒ TypeError', (t) => {
  const { store } = world(t);
  const cases = [
    [{}, '缺少 store'],
    [{ store: {}, clock: () => NOW }, 'store 无 read/update'],
    [{ store }, '缺少 clock'],
    [{ store, clock: 1 }, 'clock 不是函数'],
    [{ store, clock: () => NOW, capacity: 0 }, 'capacity 过小'],
    [{ store, clock: () => NOW, capacity: 1025 }, 'capacity 过大'],
    [{ store, clock: () => NOW, capacity: 2.5 }, 'capacity 非整数'],
    [{ store, clock: () => NOW, extra: true }, '未知键不得被静默忽略'],
    [null, 'null options'],
    [[], '数组 options'],
  ];
  for (const [options, why] of cases) {
    assert.throws(() => createQzoneProductionApprovalBroker(options), TypeError, why);
  }
  // An accessor is refused too: reading it would run caller code once and pin the result.
  const withGetter = { store, clock: () => NOW };
  Object.defineProperty(withGetter, 'capacity', { enumerable: true, get: () => 8 });
  assert.throws(() => createQzoneProductionApprovalBroker(withGetter), TypeError, 'accessor 必须被拒');
  // An EXPLICIT undefined is "omitted", not "0": the broker keeps its own default of 64.
  const explicitUndefined = createQzoneProductionApprovalBroker({ store, clock: () => NOW, capacity: undefined });
  assert.equal(typeof explicitUndefined.broker.decide, 'function', '显式 undefined 等同于省略');
});

test('PW-11 createQzoneProductionRuntime 参数非法 ⇒ TypeError（不造默认值）', (t) => {
  const { store, ledger } = world(t);
  const base = {
    store, botQq: ACCOUNT, sourceEpoch: 'e1',
    authorizeSource: () => true, getConnectionEpoch: () => 8, call: async () => ({}),
    getBridgeSessions: () => ledger, clock: () => NOW, mode: 'enabled',
  };
  const without = (key) => { const copy = { ...base }; delete copy[key]; return copy; };

  assert.throws(() => createQzoneProductionRuntime(undefined), TypeError, '未传 options');
  assert.throws(() => createQzoneProductionRuntime(null), TypeError, 'null options');
  assert.throws(() => createQzoneProductionRuntime([]), TypeError, '数组 options');

  for (const key of ['store', 'botQq', 'sourceEpoch', 'authorizeSource', 'getConnectionEpoch', 'call', 'getBridgeSessions', 'clock', 'mode']) {
    assert.throws(() => createQzoneProductionRuntime(without(key)), TypeError, '缺少 ' + key + ' 必须 TypeError');
  }
  assert.throws(() => createQzoneProductionRuntime({ ...base, store: {} }), TypeError, 'store 形状不对');
  assert.throws(() => createQzoneProductionRuntime({ ...base, botQq: 0 }), TypeError, 'botQq 必须为正');
  assert.throws(() => createQzoneProductionRuntime({ ...base, botQq: '123' }), TypeError, 'botQq 不得为字符串');
  assert.throws(() => createQzoneProductionRuntime({ ...base, sourceEpoch: 'bad epoch!' }), TypeError, 'sourceEpoch 字符集');
  assert.throws(() => createQzoneProductionRuntime({ ...base, mode: 'write' }), TypeError, 'mode 闭集');
  assert.throws(() => createQzoneProductionRuntime({ ...base, writeWiring: null }), TypeError, 'writeWiring null');
  assert.throws(() => createQzoneProductionRuntime({ ...base, writeWiring: [] }), TypeError, 'writeWiring 数组');
  assert.throws(() => createQzoneProductionRuntime({ ...base, audit: {} }), TypeError, 'audit 无 recordWrite');
  assert.throws(() => createQzoneProductionRuntime({ ...base, trackingLimit: 10 }), TypeError,
    '本版未接受的键不得被静默忽略');

  // Two different sinks would split one authorisation across two trails: refuse.
  const sinkA = createQzoneWriteAudit({ store });
  assert.throws(() => createQzoneProductionRuntime({
    ...base, audit: sinkA,
    writeWiring: {
      send: async () => ({ ok: true }), writePath: () => ({ write: async () => ({}) }),
      source: 'qq', actions: ['publish'], audit: { recordWrite() {} },
    },
  }), TypeError, '两个不同 audit sink 必须被拒');

  // The audit merge must not launder a writeWiring the runtime would otherwise refuse: an unknown
  // string key and a symbol key both stay refusals.
  const goodWiring = { send: async () => ({ ok: true }), writePath: () => ({ write: async () => ({}) }), source: 'qq', actions: ['publish'] };
  assert.throws(() => createQzoneProductionRuntime({
    ...base, audit: sinkA, writeWiring: { ...goodWiring, bogus: true },
  }), TypeError, '未知 writeWiring 键在合并后仍必须被拒');
  const symbolic = { ...goodWiring };
  symbolic[Symbol('x')] = true;
  assert.throws(() => createQzoneProductionRuntime({ ...base, audit: sinkA, writeWiring: symbolic }),
    TypeError, 'symbol 键不得在合并时被静默丢弃');

  // Control: the valid base really does construct, so the throws above are about the fault, not noise.
  const { runtime, teardown } = createQzoneProductionRuntime(base);
  assert.equal(typeof runtime.dispatch, 'function');
  assert.equal(teardown(), true);
});
