// The runtime's write branch, with the OPTIONAL write-audit sink wired in.
//
// WHAT IS REAL HERE (nothing of the pipeline is stubbed by us):
//   · a real temporary SQLite store, a real initialized B2 replay collection, the real origin
//     ledger and BOTH consumption branches, the real host-approved operation authorizer, the real
//     offline write path, and the real approved-publish / approved-comment compositions;
//   · the real write-audit SINK (`createQzoneWriteAudit`) and the real frame builder
//     (`buildQzoneWriteAuditFrame`) — the same pair the approval broker uses.
//
// What is a FIXTURE, and only this: `approveOperation` (the host verdict), `send` (the OneBot call is
// never made; it records the payload and answers `{ok:true}`), and a pinned `clock`.
//
// ⚠️ THE ONE THING THESE TESTS DELIBERATELY INJECT IS A FAILING SINK WRAPPER. That is not a bypass
// of the code under test: it is a real `{ recordWrite }` object that forwards to the real sink and
// throws on ONE stage, which is the only way to reach "the trail could not be extended" without
// corrupting a store the write path also depends on.
//
// ⚠️ WHAT THIS DOES NOT SHOW: no real QQ/OneBot request is issued. A `send` count proves the
// composition reached this process's transport boundary and nothing beyond it.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { initializeReplayState } from '../src/core/qzone-replay-claim-offline.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createOfflineWritePath } from '../src/core/qzone-write-path-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { createQzoneWriteAudit } from '../src/core/qzone-write-audit-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';
import { createQzonePublishAuthorizer } from '../src/core/qzone-approved-publish-dispatch-offline.mjs';
import { createQzoneWriteAuthorizer } from '../src/core/qzone-approved-comment-dispatch-offline.mjs';

const NOW = Date.parse('2026-11-15T04:00:00Z');
const ACCOUNT = 123;
const SESSION = 's1';
const REQUEST = 'request-1';
const PUBLISH_INPUT = Object.freeze({ content: 'hello world', ugc_right: 1 });
const COMMENT_INPUT = Object.freeze({ tid: 'post-1', target_uin: 456, content: 'nice post' });

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
 * One world. `audit` is the sink handed to `writeWiring.audit`; `auditFailOn` makes that sink throw
 * on a single stage while every other stage still reaches the real store.
 */
function world(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-write-audit-rt-'));
  t.after(() => {
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle */ }
    }
  });
  const store = openOfflineStore(path.join(dir, 'state.db'), initialState());
  t.after(() => { try { store.close(); } catch {} });
  assert.equal(initializeReplayState(store, { now: NOW }).ok, true, '前提：replay 集合已初始化');

  const live = { now: NOW, epoch: 8 };
  const sent = [];
  const writePath = (transport) => createOfflineWritePath({ store, clock: () => live.now, transport });
  const send = async (payload) => { sent.push(payload); return { ok: true }; };

  const realSink = createQzoneWriteAudit({ store });
  /** The sink the runtime gets. `failOn` throws BEFORE forwarding, so nothing is half-written. */
  const sink = (failOn) => ({
    recordWrite(frame, stage, approval, outcome) {
      if (stage === failOn) throw new Error('synthetic write-audit outage');
      return realSink.recordWrite(frame, stage, approval, outcome);
    },
  });
  const wiring = (overrides = {}) => ({
    send, writePath, source: 'qq', actions: ['publish', 'comment', 'reply', 'like'], ...overrides,
  });

  function build(buildOptions = {}) {
    const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1' });
    ledger.registerBridgeRequest({ requestId: REQUEST, origin: 'qq-inbound' });
    assert.equal(ledger.observeStep({
      sessionId: SESSION, turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: REQUEST } }],
    }), true);
    const runtimeOptions = {
      store, botQq: ACCOUNT, sourceEpoch: 'e1',
      getConnectionEpoch: () => live.epoch,
      authorizeSource: () => true,
      getBridgeSessions: (sessionId) => (sessionId === SESSION ? ledger : null),
      clock: () => live.now,
      mode: 'enabled',
      call: async () => { throw new Error('the write path must not call the read transport'); },
      operationAuthorization: { replayStore: store, approveOperation: () => true },
      writeWiring: wiring(buildOptions.wiringOverrides ?? options.wiringOverrides ?? {}),
    };
    return { runtime: createQzoneRuntime(runtimeOptions), ledger };
  }

  return {
    store, live, sent, build, sink, wiring,
    dispatch(pair, action, input, callId = 'c1') {
      assert.equal(pair.ledger.observeToolCall({
        sessionId: SESSION, event: { type: 'tool/call', data: { turn: 1, step: 1, callId } },
      }), true, '前提：tool/call 已记录');
      return pair.runtime.dispatch(action, input, { sessionId: SESSION, callId });
    },
    writeAuditRows() { return store.read().writeAudit ?? []; },
    dispatchAuditRows() { return (store.read().audit ?? []).filter((e) => String(e.id).startsWith('dsp_')); },
    claimedKeys() { return Object.keys(store.read().usedReadKeys ?? {}); },
  };
}

// ── 1. POSITIVE CONTROL: intent before the send, result after it, one shared audit id ──────────
test('WA-1 opt-in + audit ⇒ 成功写落 intent + result 两行，authorizationId 相同且早于/晚于发送', async (t) => {
  const w = world(t);
  const pair = w.build({ wiringOverrides: { audit: w.sink() } });
  const result = await w.dispatch(pair, 'publish', PUBLISH_INPUT);

  assert.equal(result.ok, true, `应当成功: ${JSON.stringify(result)}`);
  assert.equal(result.outcome, 'success');
  assert.equal(result.sent, true);
  assert.equal(Object.hasOwn(result, 'auditFailed'), false, '★★ 审计成功时不得带 auditFailed');

  assert.equal(w.sent.length, 1, '★ send 恰好一次');
  const rows = w.writeAuditRows();
  assert.equal(rows.length, 2, `★★ 必须恰好 intent + result 两行（实际 ${JSON.stringify(rows.map((r) => r.stage))}）`);
  assert.deepEqual(rows.map((r) => r.stage), ['intent', 'result'], '★ intent 必须先于 result');
  assert.equal(rows[0].authorizationId, rows[1].authorizationId,
    '★★ 两行必须共用同一个 authorizationId（与审批行同一口径的四元组摘要）');
  assert.equal(rows[0].outcome, null, '★ intent 行不携带 outcome');
  assert.equal(rows[1].outcome, 'success', '★★ result 行写的是真实平台 outcome');
  assert.equal(rows[0].action, 'publish');
  assert.equal(rows[0].accountId, ACCOUNT);
  assert.equal(rows[0].sessionId, SESSION);
  assert.equal(rows[0].requestId, REQUEST);
  assert.equal(rows[0].callId, 'c1');
});

// ── 2. INTENT FAILS ⇒ nothing is sent; the costs already paid stay paid ───────────────────────
test('WA-2 intent 写失败 ⇒ send 0、受控 not-sent 拒绝；已花配额与已占 B2 如实保留（不 throw）', async (t) => {
  const w = world(t, { wiringOverrides: {} });
  const failing = w.sink('intent');
  const pair = w.build({ wiringOverrides: { audit: failing } });
  const result = await w.dispatch(pair, 'comment', COMMENT_INPUT);

  // The refusal SHAPE carries all three facts separately, so a caller can tell "not sent" from
  // "failed" and from "unknown" without parsing a message.
  assert.equal(result.ok, false, '★★★ 必须是被控拒绝，不是抛错');
  assert.equal(result.sent, false, '★★★ 审计无法记录就绝不得发送');
  assert.equal(result.outcome, 'not-sent', '★★★ 必须是 not-sent（确知未调用 send），不是 unknown');
  assert.equal(result.reason, 'audit-unavailable', '★★ 拒绝原因点名审计不可用');
  assert.equal(result.stage, 'transport', '★ 拒绝发生在 transport 阶段（预留之后）');

  // THE CORE STRENGTH: the send never ran.
  assert.equal(w.sent.length, 0, '★★★ send 0 次');

  // ⚠️ THE COSTS ARE NOT REFUNDED, AND THIS TEST ASSERTS THAT RATHER THAN WISHING IT AWAY.
  //
  // The intent row is written INSIDE the transport closure, AFTER `verify` + the B2 `claim`, because
  // that is the first moment the operation is authorised AND durably claimed AND nothing has left the
  // process. An earlier row would describe a state that had not been reached. The price of that
  // ordering is exactly what is measured below: by the time the intent write fails, the comment
  // reservation has already committed (`used.comment === 1`) and the B2 quadruple is already claimed
  // (`claimedKeys().length === 1`). Neither has an undo path — `reserveWrite` has none, and deleting
  // the claim would reopen the replay window it exists to close.
  //
  // ⚠️ A STALE VERSION OF THIS CARD ASKED FOR `used.comment === 0` AND `claimedKeys() === []` HERE.
  // Those were the pre-t54 numbers, from when the intent was written in the runtime BEFORE any of this
  // had happened. Asserting them now would either fail forever or push the claim behind the intent —
  // which would break the ordering the same card requires. They are corrected to the measured truth.
  assert.equal(w.store.read().ledger.used.comment, 1,
    '★★ 配额已花且不回滚 —— 预留发生在 transport 闭包之前，「花掉的单位」是既成事实');
  assert.equal(w.claimedKeys().length, 1,
    '★★ B2 已占用且不回滚 —— 撤销 claim 会重开它要关闭的重放窗口');
  assert.equal(w.writeAuditRows().length, 0,
    '★★ 审计行一行都没写成：intent 没写进去，result 更不得凭空产生');

  // The existing dispatch audit vocabulary still records the refusal as a denial (nothing was sent).
  const rows = w.dispatchAuditRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].record.result, 'denied');
});

// ── 3. RESULT FAILS ⇒ both facts visible at once, real outcome kept, no retry ─────────────────
test('WA-3 result 写失败 ⇒ 返回体同时含真实 outcome 与 auditFailed:true；send 恰 1 次、不重试', async (t) => {
  const w = world(t);
  const failing = w.sink('result');
  const pair = w.build({ wiringOverrides: { audit: failing } });
  const result = await w.dispatch(pair, 'publish', PUBLISH_INPUT);

  assert.equal(result.ok, true, '★★★ 审计失败不得把已发送的写改判为失败');
  assert.equal(result.outcome, 'success', '★★★ 真实 outcome 必须原样保留（不得改写成 not-sent）');
  assert.equal(result.sent, true, '★★ sent 必须仍是 true');
  assert.equal(result.auditFailed, true, '★★★ 同时必须表达「审计写失败」');
  assert.equal(result.quotaConsumed, true, '★ quotaConsumed 等原字段不得丢');
  assert.equal(w.sent.length, 1, '★★★ 不得重试：send 仍然只有 1 次');
  assert.equal(w.claimedKeys().length, 1, '★ B2 仍恰好一条（不因审计失败而重开）');

  const rows = w.writeAuditRows();
  assert.deepEqual(rows.map((r) => r.stage), ['intent'], '★ intent 落盘了，result 没落盘');
  assert.equal(rows[0].outcome, null);
});

// ── 4. `state.audit` IS NOT TOUCHED BY THIS SINK ──────────────────────────────────────────────
test('WA-4 state.audit 未被污染：既有 dsp_ 行照旧，write-audit 只写 state.writeAudit', async (t) => {
  const w = world(t);
  const pair = w.build();
  const result = await w.dispatch(pair, 'publish', PUBLISH_INPUT);
  assert.equal(result.ok, true);

  const rows = w.dispatchAuditRows();
  assert.equal(rows.length, 1, '★★ 既有 dsp_ 审计仍是恰好一条');
  assert.equal(rows[0].record.action, 'publish');
  assert.equal(rows[0].record.result, 'success');
  assert.equal(rows[0].record.source, 'qq');
  assert.equal(rows[0].record.target, '0');
  // The two sinks are disjoint: a write-audit id must never appear in `state.audit`.
  for (const row of w.writeAuditRows()) {
    assert.equal((w.store.read().audit ?? []).some((e) => e.id === row.authorizationId), false,
      '★★ write-audit 的行不得混进 state.audit');
  }
  assert.equal(w.store.read().audit.length, 1, '★★ state.audit 行数不变（只有那一条 dsp_）');
});

// ── 5. THE BODY IS HASHED, NEVER STORED ──────────────────────────────────────────────────────
test('WA-5 正文不落盘：writeAudit 两行都不含正文，只有 inputDigest', async (t) => {
  const w = world(t);
  const pair = w.build({ wiringOverrides: { audit: w.sink() } });
  const result = await w.dispatch(pair, 'publish', PUBLISH_INPUT);
  assert.equal(result.ok, true);

  const rows = w.writeAuditRows();
  assert.equal(rows.length, 2);
  const serialized = JSON.stringify(rows);
  assert.equal(serialized.includes('hello world'), false,
    '★★★ 正文不得出现在 write-audit 行里');
  for (const row of rows) {
    assert.match(row.inputDigest, /^[0-9a-f]{64}$/, '★★ 每行只带 sha256 摘要');
    assert.equal(Object.hasOwn(row, 'content'), false, '★★ 行里没有 content 字段');
  }
  // And the whole persisted state is checked too, so a leak into any other field would be caught.
  assert.equal(JSON.stringify(w.store.read()).includes('hello world'), false,
    '★★★ 整份 state 序列化后也不得含正文');
});

// ── 6. THE INPUT-DIGEST GUARD: "approved bytes" == "attempted bytes", or refuse ──────────────
//
// The guard lives twice — `qzone-approved-publish-dispatch-offline.mjs:399-404` and
// `qzone-approved-comment-dispatch-offline.mjs:602-607`:
//
//     if (auditFrame !== null && auditFrame.inputDigest !== ticket.operation.inputDigest) {
//       authorizer.finish(ticket);
//       return { ok:false, stage:'authorize', reason:'audit-digest-mismatch', sent:false };
//     }
//
// It is the ONLY comparison in either composition between "the digest the approval recorded" and
// "the digest of the bytes about to be sent". Nothing below it re-checks that pairing: the
// `authorizationId` is a digest of the QUADRUPLE (session/request/call/account), so two different
// bodies share it, and `intent`/`result` rows would then sit under the same id as an approval row
// describing other bytes. Delete the guard and the whole suite used to stay green — this test is
// what makes that deletion red.
//
// HOW THE MISMATCH IS BUILT WITHOUT TOUCHING `src/` (plan B): the authorizer is HAND-BUILT, not the
// real one. `prepare` answers a ticket whose `operation` carries every field both compositions read
// (`authorizationId`/`input`/`accountId`/`sessionId`/`requestId`/`callId`/`connectionEpoch`/
// `action`) — real values, so nothing else can refuse first — but its `inputDigest` is a
// WELL-FORMED WRONG value. The composition then derives the frame from `operation.input` with the
// REAL builder, so the two digests genuinely disagree. Nothing else is stubbed: the audit sink, the
// frame builder, the write path and the SQLite store are the real modules, and `verify`/transport
// are counters precisely so "did the run get past the guard?" is measurable.
//
// ⚠️ WHAT THIS DOES NOT CLAIM: that a real approval would ever disagree with itself. The real
// authorizer derives both values from the same snapshot, and WA-1..WA-5 pin that agreeing case
// end-to-end. What is pinned here is the GUARD: if the two ever diverge, the write must die before
// the claim and before the send, and the ticket must still be released.
const WRONG_DIGEST = 'f'.repeat(64);

/**
 * One hand-built authorizer + the counters the guard is supposed to sit IN FRONT OF.
 *
 * `claimCalls`/`sentCalls` nonzero would mean the write walked past it; `finishCalls === 1` means the
 * refused ticket was still released. `sent` (the payload list) is kept alongside so "the transport was
 * never entered" is measured twice — once by the counter, once by what was collected.
 */
function digestGuardWorld(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-digest-guard-'));
  t.after(() => {
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle */ }
    }
  });
  const store = openOfflineStore(path.join(dir, 'state.db'), initialState());
  t.after(() => { try { store.close(); } catch {} });

  let prepareCalls = 0;
  let verifyCalls = 0;
  let claimCalls = 0;
  let finishCalls = 0;
  let sentCalls = 0;
  const sent = [];
  const clockNow = NOW;

  const authorizer = {
    // The REAL ticket shape, with ONE wrong field — the digest the approval "recorded".
    async prepare({ action, input }) {
      prepareCalls += 1;
      return {
        operation: Object.freeze({
          authorizationId: 'auth-digest-guard',
          accountId: ACCOUNT,
          sessionId: SESSION,
          requestId: REQUEST,
          callId: 'c1',
          connectionEpoch: 8,
          action,
          // A clone, so the frame is built from a plain object with no accessors — exactly the
          // shape a real snapshot has. Its digest cannot equal WRONG_DIGEST.
          input: structuredClone(input),
          inputDigest: WRONG_DIGEST,
        }),
      };
    },
    verify() { verifyCalls += 1; return true; },
    claim() { claimCalls += 1; return { ok: true }; },
    finish() { finishCalls += 1; return true; },
  };

  const send = async (payload) => { sentCalls += 1; sent.push(payload); return { ok: true }; };
  const writePath = (transport) => createOfflineWritePath({ store, clock: () => clockNow, transport });
  const audit = createQzoneWriteAudit({ store });

  return {
    store, sent, send, writePath, authorizer, audit,
    calls() {
      return { prepareCalls, verifyCalls, claimCalls, finishCalls, sentCalls };
    },
    writeAuditRows() { return store.read().writeAudit ?? []; },
    publish() {
      return createQzonePublishAuthorizer({
        authorizer, writePath, send, source: 'qq', audit, clock: () => clockNow,
      });
    },
    interaction() {
      return createQzoneWriteAuthorizer({
        authorizer, writePath, send, source: 'qq', audit, clock: () => clockNow,
      });
    },
  };
}

const GUARD_EXPECTATIONS = Object.freeze({
  ok: false,
  stage: 'authorize',
  reason: 'audit-digest-mismatch',
  sent: false,
});

test('WA-6a publish：审计帧 inputDigest 与审批摘要不一致 ⇒ 授权阶段拒绝；claim 0、send 0、finish 1、审计 0 行', async (t) => {
  const g = digestGuardWorld(t);
  const result = await g.publish().execute({
    action: 'publish', input: PUBLISH_INPUT, consumption: Object.freeze({ tag: 'c' }), connectionEpoch: 8,
  });
  const { prepareCalls, verifyCalls, claimCalls, finishCalls, sentCalls } = g.calls();

  assert.equal(prepareCalls, 1, '前提：prepare 被问过一次（拒绝发生在授权之后，否则会先被别的理由拒绝）');
  assert.equal(result.ok, GUARD_EXPECTATIONS.ok, `★★★ 必须是被控拒绝: ${JSON.stringify(result)}`);
  assert.equal(result.stage, GUARD_EXPECTATIONS.stage, '★★★ 拒绝发生在 authorize 阶段');
  assert.equal(result.reason, GUARD_EXPECTATIONS.reason, '★★★ 原因必须点名 audit-digest-mismatch');
  assert.equal(result.sent, GUARD_EXPECTATIONS.sent, '★★★ 明确未发送');
  assert.equal(sentCalls, 0, '★★★ send 调用 0 次');
  assert.equal(g.sent.length, 0, '★★★ transport 一次都没被调用（收集到的 payload 为空）');
  assert.equal(claimCalls, 0, '★★★ 守卫在 claim 之前：B2 一次都没占用');
  assert.equal(verifyCalls, 0, '★★ 守卫在 verify 之前：连发送边界的校验都没走到');
  assert.equal(finishCalls, 1, '★★★ ticket 被释放恰好一次（拒绝 ≠ 悬空）');
  assert.equal(g.writeAuditRows().length, 0, '★★★ 一行审计都没写：守卫在任何 recordWrite 之前');
});

test('WA-6b comment：同一守卫在 approved-comment 组合里同样拒绝（claim 0、send 0、finish 1、审计 0 行）', async (t) => {
  const g = digestGuardWorld(t);
  const result = await g.interaction().execute({
    action: 'comment', input: COMMENT_INPUT, consumption: Object.freeze({ tag: 'c' }), connectionEpoch: 8,
  });
  const { prepareCalls, verifyCalls, claimCalls, finishCalls, sentCalls } = g.calls();

  assert.equal(prepareCalls, 1, '前提：prepare 被问过一次');
  assert.equal(result.ok, GUARD_EXPECTATIONS.ok, `★★★ 必须是被控拒绝: ${JSON.stringify(result)}`);
  assert.equal(result.stage, GUARD_EXPECTATIONS.stage, '★★★ stage 必须是 authorize');
  assert.equal(result.reason, GUARD_EXPECTATIONS.reason, '★★★ 原因必须点名 audit-digest-mismatch');
  assert.equal(result.sent, GUARD_EXPECTATIONS.sent, '★★★ 明确未发送');
  assert.equal(sentCalls, 0, '★★★ send 调用 0 次');
  assert.equal(g.sent.length, 0, '★★★ transport 一次都没被调用');
  assert.equal(claimCalls, 0, '★★★ 守卫在 claim 之前：B2 一次都没占用');
  assert.equal(verifyCalls, 0, '★★ 守卫在 verify 之前');
  assert.equal(finishCalls, 1, '★★★ ticket 被释放恰好一次');
  assert.equal(g.writeAuditRows().length, 0, '★★★ 一行审计都没写');
});
