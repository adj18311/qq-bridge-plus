// END-TO-END write-audit lifecycle: broker decision → composition → write path → sink.
//
// WHAT MAKES THIS AN E2E AND NOT A SINK-SHAPE TEST
// -----------------------------------------------
// Every layer below is the real one: a real temporary SQLite store, the real B2 replay collection,
// the real origin ledger, the real operation authorizer, the real approval BROKER (with the real
// `createQzoneApprovalAuditRecorder` as its `recordDecision`), the two real approved-write
// compositions, and the real offline write path. The only fakes are the ones a test must supply:
// `send` (the OneBot call records its payload and answers `{ok:true}`) and a pinned clock.
//
// WHAT IT PINS
//   E2E-1  success: `state.writeAudit` holds approval → intent → result(success), all three under
//          the SAME authorizationId, and the intent exists only because the write really reached
//          the send boundary.
//   E2E-2  intent row unwritable ⇒ NOTHING is sent. The refusal is the composition's controlled
//          `not-sent`, and the B2 quadruple stays claimed (that fact is not rolled back).
//   E2E-3  result row unwritable ⇒ the caller still sees the REAL outcome with `sent:true` plus
//          `auditFailed:true`, and `send` ran exactly once (no retry).
//   E2E-4  early refusal (host says no) ⇒ NO intent row and no result row: the write never reached
//          "about to send", and the approval row is the only thing the sink gets (and only when the
//          broker recorded the rejection).
//   E2E-5  the COMMENT chain: same triple, on the action whose reservation appends a second audit
//          row (into `state.audit`) inside the same call.
//   E2E-6  the REPLY chain: same triple, but the platform call is built with the reply key while the
//          quota bucket is `comment` — the one place where "which builder?" and "which bucket?" are
//          deliberately different answers.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { initializeReplayState } from '../src/core/qzone-replay-claim-offline.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createOfflineWritePath, ACTION_TO_KIND } from '../src/core/qzone-write-path-offline.mjs';
import { buildQzoneOnebotWriteRequest } from '../src/core/qzone-onebot-write-contract.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { createQzoneWriteAudit } from '../src/core/qzone-write-audit-offline.mjs';
import { createQzoneApprovalAuditRecorder } from '../src/core/qzone-write-audit-broker-adapter-offline.mjs';
import { createQzoneOperationApprovalBroker } from '../src/core/qzone-operation-approval-console.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

const NOW = Date.parse('2026-11-16T04:00:00Z');
const ACCOUNT = 123;
const SESSION = 's1';
const REQUEST = 'request-1';
const OPERATOR = 'operator-session-1';
const PUBLISH_INPUT = Object.freeze({ content: 'hello world', ugc_right: 1 });

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

/**
 * One complete world. `failOn` makes the SINK throw on that stage only (a real `{recordWrite}` that
 * forwards to the real sink otherwise) — the only way to reach "the trail could not be extended"
 * without corrupting the store the write path itself depends on.
 */
function world(t, {
  failOn, action = 'publish', input = PUBLISH_INPUT, actions = ['publish', 'comment'], evidence,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-write-audit-e2e-'));
  t.after(() => {
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle */ }
    }
  });
  const store = openOfflineStore(path.join(dir, 'state.db'), initialState());
  t.after(() => { try { store.close(); } catch {} });
  assert.equal(initializeReplayState(store, { now: NOW }).ok, true, '前提：replay 集合已初始化');
  // ⚠️ FIXTURE, NOT PRODUCTION EVIDENCE. A reply's reservation refuses without a corroborating
  // `state.commentEvidence` row (the gate lives inside `reserveAuditedOfflineInteraction`). Seeding
  // it here is the only way to drive the reply chain end to end; it proves the GATE behaves as
  // specified and nothing about production.
  if (evidence !== undefined) {
    store.update((state) => ({ ...state, commentEvidence: evidence }));
  }

  const sent = [];
  const live = { now: NOW, epoch: 8 };
  const realSink = createQzoneWriteAudit({ store });
  const sink = failOn === undefined ? realSink : {
    recordWrite(frame, stage, approval, outcome) {
      if (stage === failOn) throw new Error(`synthetic write-audit outage (${stage})`);
      return realSink.recordWrite(frame, stage, approval, outcome);
    },
  };

  // The REAL broker, with the REAL approval recorder as its decision sink.
  const broker = createQzoneOperationApprovalBroker({
    clock: () => live.now,
    recordDecision: createQzoneApprovalAuditRecorder({ audit: sink, clock: () => live.now }),
  });

  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1' });
  ledger.registerBridgeRequest({ requestId: REQUEST, origin: 'qq-inbound' });
  assert.equal(ledger.observeStep({
    sessionId: SESSION, turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: REQUEST } }],
  }), true);

  const runtime = createQzoneRuntime({
    store, botQq: ACCOUNT, sourceEpoch: 'e1',
    getConnectionEpoch: () => live.epoch,
    authorizeSource: () => true,
    getBridgeSessions: (sessionId) => (sessionId === SESSION ? ledger : null),
    clock: () => live.now,
    mode: 'enabled',
    call: async () => { throw new Error('the write path must not call the read transport'); },
    operationAuthorization: { replayStore: store, approveOperation: broker.approveOperation },
    writeWiring: {
      send: async (payload) => { sent.push(payload); return { ok: true }; },
      writePath: (transport) => createOfflineWritePath({ store, clock: () => live.now, transport }),
      source: 'qq', actions: [...actions], audit: sink,
    },
  });

  assert.equal(ledger.observeToolCall({
    sessionId: SESSION, event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1' } },
  }), true);

  return {
    store, sent, broker, ledger, runtime,
    /** Dispatch, and let the test answer the broker's pending request. */
    async dispatch({ approve = true, callId = 'c1' } = {}) {
      const pending = runtime.dispatch(action, input, { sessionId: SESSION, callId });
      // `prepare` blocks on the host verdict, so the decision must be made while it waits.
      await new Promise((resolve) => setImmediate(resolve));
      const [operation] = broker.listPending();
      assert.ok(operation, '前提：broker 里确实有一个待决操作');
      assert.equal(broker.decide({ authorizationId: operation.authorizationId,
        inputDigest: operation.inputDigest, approved: approve }, { operator: OPERATOR }),
      true, '前提：决定被 broker 接受');
      return pending;
    },
    rows() { return (store.read().writeAudit ?? []).map((row) => ({ ...row })); },
    claimedKeys() { return Object.keys(store.read().usedReadKeys ?? {}); },
  };
}

test('E2E-1 成功链路：approval → intent → result(success) 三行，同一 authorizationId', async (t) => {
  const w = world(t);
  const result = await w.dispatch();

  assert.equal(result.ok, true, `写入应当成功: ${JSON.stringify(result)}`);
  assert.equal(result.outcome, 'success');
  assert.equal(result.sent, true);
  assert.equal(result.auditFailed, undefined, '★ 审计正常时不得带 auditFailed');
  assert.equal(w.sent.length, 1, '★ send 恰好一次');

  const rows = w.rows();
  assert.deepEqual(rows.map((r) => r.stage), ['approval', 'intent', 'result'],
    `★★★ 生命周期必须是 approval → intent → result（实际 ${JSON.stringify(rows.map((r) => r.stage))}）`);

  const ids = new Set(rows.map((r) => r.authorizationId));
  assert.equal(ids.size, 1, `★★★ 三行必须共用同一个 authorizationId（实际 ${JSON.stringify([...ids])}）`);
  // The id is the durable quadruple digest, so it must be reproducible from the B2 identity.
  assert.match(rows[0].authorizationId, /^[0-9a-f]{32}$/);

  assert.equal(rows[0].decision, 'approved', '★★ approval 行记录真实批准');
  assert.equal(rows[0].operatorSessionId, OPERATOR, '★★ operatorSessionId 来自认证会话，不是请求体');
  assert.equal(rows[1].outcome, null, '★ intent 行不携带 outcome');
  assert.equal(rows[2].outcome, 'success', '★★ result 行写的是真实平台 outcome');
  for (const row of rows) {
    assert.equal(row.accountId, ACCOUNT);
    assert.equal(row.sessionId, SESSION);
    assert.equal(row.requestId, REQUEST);
    assert.equal(row.callId, 'c1');
    assert.equal(row.action, 'publish');
  }
  // The body is hashed, never stored.
  assert.equal(JSON.stringify(w.store.read()).includes('hello world'), false,
    '★ 正文不得落盘（整份 state 序列化也不含）');
});

test('E2E-2 intent 行写不进去 ⇒ 一次 send 都没有，B2 已占用不回滚', async (t) => {
  const w = world(t, { failOn: 'intent' });
  const result = await w.dispatch();

  assert.equal(w.sent.length, 0, '★★★ intent 写失败就绝不得调用 send');
  assert.equal(result.sent, false, '★★ 必须如实报未发送');
  assert.equal(result.outcome, 'not-sent');
  assert.equal(result.reason, 'audit-unavailable', '★★ 拒绝原因点名审计不可用');
  assert.equal(result.ok, false);

  const rows = w.rows();
  assert.deepEqual(rows.map((r) => r.stage), ['approval'],
    '★★ 只有 approval 行：intent 没写进去，result 也不得凭空产生');
  assert.equal(w.claimedKeys().length, 1,
    '★★ B2 已占用且不回滚 —— “这个四元组用过”是既成事实，撤销会重开重放窗口');
  assert.equal(w.store.read().ledger.used.post, 1, '★ 配额已花，如实在返回值里');
});

test('E2E-3 result 行写不进去 ⇒ 真实 outcome + sent:true + auditFailed:true，且不重试', async (t) => {
  const w = world(t, { failOn: 'result' });
  const result = await w.dispatch();

  assert.equal(result.ok, true, '★★★ 审计写失败不得把已发送的写改判为失败');
  assert.equal(result.outcome, 'success', '★★★ 真实 outcome 必须原样保留（不得改成 not-sent）');
  assert.equal(result.sent, true, '★★ sent 必须仍是 true');
  assert.equal(result.auditFailed, true, '★★★ 同时必须表达审计写失败');
  assert.equal(result.quotaConsumed, true, '★ 原字段不得丢');
  assert.equal(w.sent.length, 1, '★★★ 不得重试：send 仍然只有一次');

  assert.deepEqual(w.rows().map((r) => r.stage), ['approval', 'intent'],
    '★★ intent 落盘、result 没落盘 —— 两件事各自如实');
});

test('E2E-4 早期拒绝（host 说 no）⇒ 不伪造 intent：没有任何 intent/result 行', async (t) => {
  const w = world(t);
  const result = await w.dispatch({ approve: false });

  assert.equal(result.ok, false);
  assert.equal(w.sent.length, 0, '★ 未批准不得发送');
  assert.deepEqual(w.claimedKeys(), [], '★ 未批准不得占用 B2');

  const stages = w.rows().map((r) => r.stage);
  assert.equal(stages.includes('intent'), false,
    `★★★ 早期拒绝绝不能留下 intent 行（实际 ${JSON.stringify(stages)}）`);
  assert.equal(stages.includes('result'), false, '★★ 更不得凭空产生 result 行');
  // The rejection, if recorded at all, belongs to the approval layer — never to the write path.
  for (const row of w.rows()) assert.equal(row.stage, 'approval');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// E2E-5 — the COMMENT chain, end to end (every case above drives `publish`)
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// WHY A SEPARATE CASE: `publish` and `comment` are two DIFFERENT compositions with two different
// reservation entry points. Proving the lifecycle on publish says nothing about comment, and a
// comment is the action whose reservation appends its own `unknown` intent row into `state.audit` —
// a second sink in the same call. This case pins that the write-AUDIT rows still come out as one
// approval → intent → result triple, and that all three agree on the INPUT digest, not just on the
// quadruple id.
test('E2E-5 comment 写链：approval → intent → result(success)，同 authorizationId 且 inputDigest 一致', async (t) => {
  const COMMENT_INPUT_LOCAL = Object.freeze({ tid: 'post-1', target_uin: 456, content: 'nice post' });
  const w = world(t, { action: 'comment', input: COMMENT_INPUT_LOCAL });
  const result = await w.dispatch();

  assert.equal(result.ok, true, `comment 写入应当成功: ${JSON.stringify(result)}`);
  assert.equal(result.outcome, 'success');
  assert.equal(result.sent, true);
  assert.equal(result.auditFailed, undefined, '★ 审计正常时不得带 auditFailed');
  assert.equal(w.sent.length, 1, '★ send 恰好一次');
  // MEASURED, not guessed: the comment transport is `comment_qzone`, NOT the publish action.
  assert.equal(w.sent[0]?.action, 'comment_qzone', '★ 真的是 comment 的 OneBot 请求形状');

  const rows = w.rows();
  assert.deepEqual(rows.map((r) => r.stage), ['approval', 'intent', 'result'],
    `★★★ comment 链也必须是被 approval → intent → result（实际 ${JSON.stringify(rows.map((r) => r.stage))}）`);

  // ONE operation across all three rows — identity AND bytes.
  const ids = new Set(rows.map((r) => r.authorizationId));
  assert.equal(ids.size, 1, `★★★ 三行必须共用同一个 authorizationId（实际 ${JSON.stringify([...ids])}）`);
  const digests = new Set(rows.map((r) => r.inputDigest));
  assert.equal(digests.size, 1, `★★★ 三行必须共用同一个 inputDigest（实际 ${JSON.stringify([...digests])}）`);
  assert.match([...digests][0], /^[0-9a-f]{64}$/, '★ digest 是 sha256 形状');
  // The digest is NOT the quadruple id: two different facts must not collapse into one column.
  assert.notEqual([...digests][0], [...ids][0], '★★ 四元组 id 与 inputDigest 是两个不同的值');

  for (const row of rows) {
    assert.equal(row.action, 'comment');
    assert.equal(row.accountId, ACCOUNT);
    assert.equal(row.sessionId, SESSION);
    assert.equal(row.requestId, REQUEST);
    assert.equal(row.callId, 'c1');
  }
  assert.equal(rows[0].decision, 'approved', '★★ approval 行记录真实批准');
  assert.equal(rows[0].operatorSessionId, OPERATOR, '★★ operatorSessionId 来自认证会话');
  assert.equal(rows[1].outcome, null, '★ intent 行不携带 outcome');
  assert.equal(rows[2].outcome, 'success', '★★ result 行写的是真实平台 outcome');

  // The body still never reaches the store, on this chain either.
  assert.equal(JSON.stringify(w.store.read()).includes('nice post'), false,
    '★ comment 正文不得落盘（整份 state 序列化也不含）');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// E2E-6 — the REPLY chain, end to end
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// WHY A THIRD CASE: a reply is the ONLY write action where "the quota bucket" and "the platform
// request shape" are deliberately DIFFERENT answers. `ACTION_TO_KIND` ('qzone-write-path-offline.mjs')
// maps `reply` onto `'comment'` — one shared daily allowance and one shared 3-minute interval —
// while the approved-write composition picks the platform BUILDER from the business action
// (`platformKindFor` in 'qzone-approved-comment-dispatch-offline.mjs', "THE BUILDER IS CHOSEN BY
// BUSINESS `action`, NEVER BY THE QUOTA `kind`"). A kind-keyed builder would send a reply as a
// plain comment: a DIFFERENT operation, under an approved reply, invisible to the audit trail.
//
// MEASURED SHAPE OF THAT SEND (read off 'qzone-onebot-write-contract.mjs', whose reply branch ends
// `return { action: 'comment_qzone', params }` at :113): the OneBot action is **`comment_qzone`**,
// exactly like a comment, and what makes it a reply are the two extra params — `comment_id` and
// `comment_uin`. So the assertion pins BOTH: the envelope action, and the presence of the reply
// identity in `params`. Its negative half runs the SAME builder keyed by the quota bucket instead,
// and shows it produces a `comment_qzone` request with NO `comment_id` — the silent downgrade a
// kind-keyed builder would send.
//
// ⚠️ THE SEEDED `commentEvidence` ROW IS A FIXTURE, NOT PRODUCTION EVIDENCE. A reply reserves
// through `reserveAuditedOfflineInteraction`, which refuses (fail closed) unless the store holds
// exactly one corroborating row for this (target, postId, commentId) whose identity fields agree.
// Seeding it is the only way to drive this chain end to end; it proves the gate and the composition
// behave as specified and proves NOTHING about whether such a comment exists on the platform.
test('E2E-6 reply 写链：approval → intent → result(success)，同一 authorizationId/inputDigest，且发的是 reply 形状', async (t) => {
  const TARGET = 456;
  const REPLY_INPUT_LOCAL = Object.freeze({
    tid: 'post-1', target_uin: TARGET, content: 'replying to you',
    comment_id: 'cm-1', comment_uin: 789,
  });
  // FIXTURE (see the banner above): the canonical corroborating row for REPLY_INPUT_LOCAL.
  const EVIDENCE = Object.freeze([Object.freeze({
    target: String(TARGET), postId: 'post-1', commentId: 'cm-1',
    commentUin: 789, replyUin: null, replyName: null, at: NOW,
  })]);
  const w = world(t, {
    action: 'reply', input: REPLY_INPUT_LOCAL, actions: ['comment', 'reply'], evidence: EVIDENCE,
  });
  const result = await w.dispatch();

  assert.equal(result.ok, true, `reply 写入应当成功: ${JSON.stringify(result)}`);
  assert.equal(result.outcome, 'success');
  assert.equal(result.sent, true);
  assert.equal(result.auditFailed, undefined, '★ 审计正常时不得带 auditFailed');
  assert.equal(w.sent.length, 1, '★ send 恰好一次');

  // ── THE PLATFORM SHAPE, measured against the contract rather than guessed ────────────────────
  // A reply goes out under the COMMENT OneBot action ('comment_qzone'), because a reply IS a comment
  // on the platform; its reply-ness is carried by `comment_id`/`comment_uin` inside `params`.
  assert.equal(w.sent[0]?.action, 'comment_qzone',
    '★★ reply 的平台动作仍是 comment_qzone（qzone-onebot-write-contract.mjs 的 reply 分支）');
  assert.deepEqual(w.sent[0]?.params, {
    tid: 'post-1', target_uin: TARGET, content: 'replying to you',
    comment_id: 'cm-1', comment_uin: 789,
  }, '★★ reply 的 params 必须带齐 comment_id/comment_uin（这正是它与 comment 的差别）');
  // The optional reply-target pair was NOT approved, so it must not appear: the payload is built
  // from the frozen snapshot, not re-assembled with defaults.
  assert.deepEqual(Object.keys(w.sent[0]?.params ?? {}).sort(),
    ['comment_id', 'comment_uin', 'content', 'target_uin', 'tid'],
    '★ 批准里没有 reply_uin/reply_name，载荷里也不得出现');
  // And it really is the contract's own output for this input, not a hand-built lookalike.
  assert.deepEqual(w.sent[0], buildQzoneOnebotWriteRequest('reply', REPLY_INPUT_LOCAL),
    '★ 载荷必须与按批准 input 构造的 reply 请求一致');
  // NOT the comment shape: the very same builder, keyed by the QUOTA bucket ('comment'), drops the
  // reply identity entirely — which is exactly the wrong send a kind-keyed builder would produce.
  assert.deepEqual(buildQzoneOnebotWriteRequest(ACTION_TO_KIND.reply, {
    tid: 'post-1', target_uin: TARGET, content: 'replying to you',
  }), {
    action: 'comment_qzone',
    params: { tid: 'post-1', target_uin: TARGET, content: 'replying to you' },
  }, '★ 用配额桶当键会构造出「没有 comment_id 的 comment」—— 所以 builder 必须按业务 action 选');

  // ── the write-audit triple ───────────────────────────────────────────────────────────────────
  const rows = w.rows();
  assert.deepEqual(rows.map((r) => r.stage), ['approval', 'intent', 'result'],
    `★★★ reply 链也必须是 approval → intent → result（实际 ${JSON.stringify(rows.map((r) => r.stage))}）`);

  // ONE operation across all three rows — identity AND bytes.
  const ids = new Set(rows.map((r) => r.authorizationId));
  assert.equal(ids.size, 1, `★★★ 三行必须共用同一个 authorizationId（实际 ${JSON.stringify([...ids])}）`);
  const digests = new Set(rows.map((r) => r.inputDigest));
  assert.equal(digests.size, 1, `★★★ 三行必须共用同一个 inputDigest（实际 ${JSON.stringify([...digests])}）`);
  assert.match([...digests][0], /^[0-9a-f]{64}$/, '★ digest 是 sha256 形状');
  // The digest is NOT the quadruple id: two different facts must not collapse into one column.
  assert.notEqual([...digests][0], [...ids][0], '★★ 四元组 id 与 inputDigest 是两个不同的值');

  for (const row of rows) {
    assert.equal(row.action, 'reply', '★ 三行记录的都是 reply（不是 comment）');
    assert.equal(row.accountId, ACCOUNT);
    assert.equal(row.sessionId, SESSION);
    assert.equal(row.requestId, REQUEST);
    assert.equal(row.callId, 'c1');
    // The reply identity rides the SAME frame on every stage, and the audit frame takes it from the
    // approved snapshot (never from the caller).
    assert.equal(row.commentId, 'cm-1');
    assert.equal(row.commentUin, 789);
    assert.equal(row.replyUin, null, '★ 没有 reply 目标 ⇒ replyUin 为 null');
    assert.equal(row.replyName, null);
  }
  assert.equal(rows[0].decision, 'approved', '★★ approval 行记录真实批准');
  assert.equal(rows[0].operatorSessionId, OPERATOR, '★★ operatorSessionId 来自认证会话');
  assert.equal(rows[1].outcome, null, '★ intent 行不携带 outcome');
  assert.equal(rows[2].outcome, 'success', '★★ result 行写的是真实平台 outcome');

  // ── the quote bucket is COMMENT, not a fourth bucket ────────────────────────────────────────
  assert.equal(w.store.read().ledger.used.comment, 1, '★ reply 记在 comment 配额桶');
  assert.equal(w.store.read().ledger.used.post, 0);
  assert.equal(w.store.read().ledger.used.like, 0);

  // ── the body is hashed, never stored ────────────────────────────────────────────────────────
  // Per-row first (the sink has no `content` field at all), then the whole persisted state, so a
  // leak into any other field is caught too.
  const writeAuditRows = w.rows();
  for (const row of writeAuditRows) {
    assert.equal(Object.hasOwn(row, 'content'), false, '★ 审计行里没有 content 字段');
    assert.equal(JSON.stringify(row).includes('replying to you'), false, '★★ 行里不含正文原文');
    assert.match(row.inputDigest, /^[0-9a-f]{64}$/, '★ 只有 sha256 摘要');
  }
  // ⚠️ WHERE THE BODY *IS*, STATED RATHER THAN WISHED AWAY. `state.audit` is the OTHER sink (the
  // reservation's conservative `unknown` intent, `qzone-reservation-offline.mjs` ->
  // `appendFormattedIntent` -> `formatAuditRecord`), and `formatAuditRecord` DOES carry a
  // `content` field — that is its settled format, not something this test may pretend is absent.
  // So the scope is stated instead of hidden:
  //   · in the WRITE-AUDIT sink there is no body (asserted per row above);
  //   · in `state.audit` the body appears EXACTLY ONCE — the reservation intent — and nowhere else
  //     in the persisted state. A second copy (or a copy in a row that is not the intent) fails here.
  const persisted = w.store.read();
  const occurrences = JSON.stringify(persisted).split('replying to you').length - 1;
  const intentRows = (persisted.audit ?? []).filter((entry) => {
    const record = entry?.record;
    return record && record.action === 'reply' && record.content === 'replying to you';
  });
  assert.equal(intentRows.length, 1, '★ reply 正文在 state.audit 里恰好一条（预留意图）');
  assert.equal(occurrences, 1,
    `★★★ reply 正文在整份 state 里恰好出现一次（实际 ${occurrences} 次）：写入审计 sink 里一次都不许有`);
});
