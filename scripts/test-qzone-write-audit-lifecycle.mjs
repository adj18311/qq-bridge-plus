// The write-audit LIFECYCLE: one authorisation, several facts, several rows.
//
// OFFLINE INTERFACE. No production consumer of `createQzoneWriteAudit` exists in `src/`; the only
// importer is this file and `scripts/test-qzone-write-audit.mjs`. A passing test here proves the
// STAGE MODEL works against a real temporary SQLite store. It is NOT production verification, and
// it does NOT prove that any actor recorded here is real — see the module header's statement that
// `recordWrite` validates shape, never truth.
//
// WHY THIS FILE EXISTS
// --------------------
// The sink started as ONE row per `authorizationId`. That cannot express what actually happens: an
// approval is DECIDED, a send is ATTEMPTED, and the attempt ENDS somehow. Collapsing those into one
// row loses facts (a later `unknown` would overwrite the approval that licensed it), and a
// single-row idempotency key makes the second write look like a duplicate, so the lifecycle could
// never be recorded at all. Hence: one row per `(authorizationId, stage)`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createQzoneWriteAudit, _STAGES } from '../src/core/qzone-write-audit-offline.mjs';
import { initializeReplayState } from '../src/core/qzone-replay-claim-offline.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createOfflineWritePath } from '../src/core/qzone-write-path-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

const NOW = Date.parse('2026-11-15T04:00:00Z');
const AUTH_ID = 'auth-lifecycle';
const DIGEST = 'b'.repeat(64);

/** The OPERATION frame. It must be identical across the three stages of one authorisation. */
const FRAME = Object.freeze({
  time: NOW,
  authorizationId: AUTH_ID,
  accountId: 123,
  sessionId: 's1',
  requestId: 'request-1',
  callId: 'c1',
  connectionEpoch: 3,
  action: 'publish',
  inputDigest: DIGEST,
  ugcRight: 1,
  targetUins: null,
});

/** What the console gateway's `recordDecision` callback supplies: a server session id. */
const APPROVED = Object.freeze({
  operatorSessionId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  decidedAt: NOW,
  decision: 'approved',
});

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-write-audit-life-'));
  t.after(() => {
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle */ }
    }
  });
  const store = openOfflineStore(path.join(dir, 'state.db'), {
    enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false,
    tools: { publish: true, comment: true, reply: true, like: true, read_posts: true },
    limits: { post: 10, comment: 25, like: 30 },
    ledger: { day: '2026-11-15', used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [], commentEvidence: [], audit: [],
  });
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  return { store, audit: createQzoneWriteAudit({ store }) };
}

// ── 1. the three-stage happy path ───────────────────────────────────────────────────────────
test('WAL-1 生命周期三步：approval → intent → result，三行同一 authorizationId、阶段各不相同', t => {
  const { audit } = world(t);

  assert.equal(audit.recordWrite(FRAME, 'approval', APPROVED, null).appended, true);
  assert.equal(audit.recordWrite(FRAME, 'intent', null, null).appended, true);
  assert.equal(audit.recordWrite(FRAME, 'result', null, 'success').appended, true);

  const rows = audit.stagesFor(AUTH_ID);
  assert.deepEqual(rows.map((row) => row.stage), ['approval', 'intent', 'result'], '★ 三行、三种阶段、写入顺序');

  // The decision lives ONLY on the approval row.
  assert.equal(rows[0].decision, 'approved');
  assert.equal(rows[0].operatorSessionId, APPROVED.operatorSessionId, '★ 服务端会话 id 记在 approval 行');
  assert.equal(rows[0].outcome, null, '★ approval 行没有 outcome —— 批准不等于结果');

  // The intent row says "we were about to send", nothing more.
  assert.equal(rows[1].decision, null, '★ intent 行不带决策');
  assert.equal(rows[1].outcome, null, '★ intent 行也不带 outcome');

  // The result row carries the outcome and no decision.
  assert.equal(rows[2].decision, null, '★ result 行不带决策');
  assert.equal(rows[2].outcome, 'success');

  // The operation frame is identical on all three: the stage says WHICH FACT, not WHAT operation.
  for (const row of rows) {
    assert.equal(row.inputDigest, DIGEST);
    assert.equal(row.ugcRight, 1);
    assert.equal(row.accountId, 123);
  }
});

// ── 2. a rejection is terminal: approval row only ─────────────────────────────────────────
test('WAL-2 拒绝：只有一条 approval 行，decision=rejected，无 intent/result', t => {
  const { audit } = world(t);
  audit.recordWrite(FRAME, 'approval', { ...APPROVED, decision: 'rejected' }, null);

  const rows = audit.stagesFor(AUTH_ID);
  assert.equal(rows.length, 1, '★ 拒绝后没有后续阶段');
  assert.equal(rows[0].stage, 'approval');
  assert.equal(rows[0].decision, 'rejected');
  assert.equal(rows[0].outcome, null);
});

// ── 3. a failed result is recorded as failed, not as a refusal ────────────────────────────
test('WAL-3 结果 failed：result 行记录 failed（发送确实尝试过）', t => {
  const { audit } = world(t);
  audit.recordWrite(FRAME, 'approval', APPROVED, null);
  audit.recordWrite(FRAME, 'intent', null, null);
  audit.recordWrite(FRAME, 'result', null, 'failed');

  const rows = audit.stagesFor(AUTH_ID);
  assert.equal(rows[rows.length - 1].outcome, 'failed');
});

// ── 4. UNKNOWN must never be downgraded to "not sent" ────────────────────────────────────
test('WAL-4 unknown 绝不写成 not-sent：结果未知就如实记 unknown', t => {
  const { audit } = world(t);
  audit.recordWrite(FRAME, 'approval', APPROVED, null);
  audit.recordWrite(FRAME, 'intent', null, null);
  audit.recordWrite(FRAME, 'result', null, 'unknown');

  const rows = audit.stagesFor(AUTH_ID);
  const last = rows[rows.length - 1];
  assert.equal(last.outcome, 'unknown', '★ 真正发出去但结果不可知 → unknown');
  assert.notEqual(last.outcome, 'not-sent', '★ 绝不能因为本地因素把它降级成"没发出去"');
  // And `not-sent` remains available as a DISTINCT value for the case that really is provable.
  assert.notEqual(last.outcome, 'success');
});

// ── 5. idempotency is per (authorizationId, stage) ───────────────────────────────────────
test('WAL-5 幂等键是 (authorizationId, stage)：同阶段重写 no-op，跨阶段不冲突', t => {
  const { store, audit } = world(t);

  assert.equal(audit.recordWrite(FRAME, 'approval', APPROVED, null).appended, true);
  assert.equal(audit.recordWrite(FRAME, 'approval', APPROVED, null).appended, false, '★ 同阶段重试 no-op');
  assert.equal(store.read().writeAudit.length, 1, '★ 不产生重复行');

  // The NEXT stage is NOT a duplicate: single-id keying would have thrown here.
  assert.equal(audit.recordWrite(FRAME, 'intent', null, null).appended, true, '★ 下一阶段必须能写入');
  assert.equal(store.read().writeAudit.length, 2);
});

// ── 6. same stage, different content ⇒ typed conflict ────────────────────────────────────
test('WAL-6 同 (id, stage) 内容不同 ⇒ 带 code 的冲突，不静默改写已有事实', t => {
  const { store, audit } = world(t);
  audit.recordWrite(FRAME, 'result', null, 'success');

  let thrown = null;
  try {
    audit.recordWrite(FRAME, 'result', null, 'unknown');
  } catch (error) { thrown = error; }

  assert.ok(thrown instanceof Error, '同一阶段的两份不同结果必须拒绝');
  assert.equal(thrown.code, 'WRITE_AUDIT_ID_CONFLICT', '★ typed code，不靠消息文本');
  assert.equal(store.read().writeAudit.length, 1);
  assert.equal(audit.stagesFor(AUTH_ID)[0].outcome, 'success', '★ 原有事实未被覆盖');
});

// ── 7. a store failure PROPAGATES: the caller must not believe it was recorded ───────────
test('WAL-7 审计写入失败必须向上传播：调用方不得以为已持久化', t => {
  const { store, audit } = world(t);
  // A store whose transaction throws once. The sink must not swallow it — a caller that treated a
  // failed write as success would report a durable audit that does not exist.
  let broken = false;
  const wrapped = {
    read: () => store.read(),
    update: (fn) => {
      if (broken) throw new Error('store unavailable');
      return store.update(fn);
    },
  };
  const failing = createQzoneWriteAudit({ store: wrapped });

  assert.equal(failing.recordWrite(FRAME, 'approval', APPROVED, null).appended, true);
  broken = true;

  assert.throws(() => failing.recordWrite(FRAME, 'result', null, 'unknown'), /store unavailable/,
    '★ store 事务失败必须抛出，不得返回 {appended:false} 让人以为"只是没写"');
  // The earlier row is intact: a failed transaction does not corrupt what was already committed.
  assert.equal(audit.stagesFor(AUTH_ID).length, 1);
});

// ── 8. no body anywhere in the lifecycle ────────────────────────────────────────────────
test('WAL-8 三行都不含正文：content 连键都不存在', t => {
  const { audit } = world(t);
  audit.recordWrite({ ...FRAME, content: 'a body that must never be audited' }, 'approval', APPROVED, null);
  audit.recordWrite({ ...FRAME, content: 'a body that must never be audited' }, 'intent', null, null);
  audit.recordWrite({ ...FRAME, content: 'a body that must never be audited' }, 'result', null, 'success');

  for (const row of audit.stagesFor(AUTH_ID)) {
    assert.equal(Object.hasOwn(row, 'content'), false, '★ 正文不是本 sink 的字段');
    assert.equal(JSON.stringify(row).includes('must never be audited'), false, '★ 正文不得出现在任何字段里');
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// WAL-10 / WAL-11 — the same lifecycle, driven end-to-end through the REAL runtime
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// The tests above exercise the sink's API directly. These two drive the INTEGRATED chain the
// requirement is actually about: the real runtime (`createQzoneRuntime`), the real host-approved
// operation authorizer, the real offline write path, and the real approved-publish composition.
//
// The wiring under test is NOT in this file's control — the pre-send `intent` row and the post-send
// `result` row are written by `qzone-runtime-wiring.mjs`, and the `approval` row by
// `createQzoneApprovalAuditRecorder` inside the approval broker. What is asserted here is the
// OBSERVABLE consequence: one `authorizationId` shared by the rows, `unknown` never downgraded to
// `not-sent`, and a failed result write that stays visible without changing what happened.
//
// What is a FIXTURE: `approveOperation` (there is no human), `send` (no OneBot call is made) and a
// pinned `clock`. Everything else is the production module.

/** The full store shape the write path's gate/reservation/quota code requires. */
function runtimeState(now = NOW) {
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
 * One integrated world over the REAL chain.
 *
 * `sendOutcome` is what the injected transport does at the irreversible step:
 *   `'ok'`    — return `{ ok: true }`
 *   `'throw'` — throw AFTER being called, which the write path classifies as `unknown`
 * `failResultOn` makes the sink wrapper throw on ONE stage while every other stage still reaches
 * the real store (the only way to reach "the trail could not be extended" without corrupting the
 * store the write path itself depends on).
 */
function runtimeWorld(t, { sendOutcome = 'ok', failResultOn = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-write-audit-life-e2e-'));
  t.after(() => {
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle */ }
    }
  });
  const store = openOfflineStore(path.join(dir, 'state.db'), runtimeState());
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  assert.equal(initializeReplayState(store, { now: NOW }).ok, true, '前提：replay 集合已初始化');

  const live = { now: NOW, epoch: 8 };
  const session = 's1';
  const request = 'request-1';
  const sent = [];
  const send = async (payload) => {
    sent.push(payload);
    if (sendOutcome === 'throw') throw new Error('transport blew up after the request left');
    return { ok: true };
  };
  const writePath = (transport) => createOfflineWritePath({ store, clock: () => live.now, transport });

  const realSink = createQzoneWriteAudit({ store });
  const sink = {
    recordWrite(frame, stage, approval, outcome) {
      if (stage === failResultOn) throw new Error('synthetic write-audit outage');
      return realSink.recordWrite(frame, stage, approval, outcome);
    },
  };

  const ledger = createQzoneOriginLedger({ sessionId: session, epoch: 'e1' });
  ledger.registerBridgeRequest({ requestId: request, origin: 'qq-inbound' });
  assert.equal(ledger.observeStep({
    sessionId: session, turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: request } }],
  }), true);

  const runtime = createQzoneRuntime({
    store, botQq: 123, sourceEpoch: 'e1',
    getConnectionEpoch: () => live.epoch,
    authorizeSource: () => true,
    getBridgeSessions: (id) => (id === session ? ledger : null),
    clock: () => live.now,
    mode: 'enabled',
    call: async () => { throw new Error('the write path must not call the read transport'); },
    operationAuthorization: { replayStore: store, approveOperation: () => true },
    writeWiring: { send, writePath, source: 'qq', actions: ['publish'], audit: sink },
  });

  return {
    store, sent,
    async dispatch(callId, input = { content: 'hello world', ugc_right: 1 }) {
      assert.equal(ledger.observeToolCall({
        sessionId: session, event: { type: 'tool/call', data: { turn: 1, step: 1, callId } },
      }), true, '前提：tool/call 已记录');
      return runtime.dispatch('publish', input, { sessionId: session, callId });
    },
    rows() { return store.read().writeAudit ?? []; },
  };
}

// ── 10. an UNKNOWN transport answer is recorded and reported as `unknown` ─────────────────
test('WAL-10 端到端 unknown：transport 抛错 ⇒ result 行写 unknown，调用方拿到的仍是 unknown（不是 not-sent）', async (t) => {
  // A throwing transport IS the write path's `unknown` case: the request may have reached the
  // platform before the failure surfaced. The one thing it must never become is "we did not send".
  const w = runtimeWorld(t, { sendOutcome: 'throw' });
  const result = await w.dispatch('c1');

  assert.equal(w.sent.length, 1, '★ send 恰好一次');
  assert.equal(result.ok, true, `应当是被分类的 unknown 而不是拒绝: ${JSON.stringify(result)}`);
  assert.equal(result.outcome, 'unknown', '★★★ 结果不可知 ⇒ unknown');
  assert.notEqual(result.outcome, 'not-sent', '★★★ 绝不能因为本地异常就报成"没发出去"');
  assert.equal(result.sent, true, '★ 已经交给运输层 ⇒ sent:true');

  const rows = w.store.read().writeAudit ?? [];
  assert.deepEqual(rows.map((r) => r.stage), ['intent', 'result'], '★ intent → result');
  assert.equal(rows[0].authorizationId, rows[1].authorizationId,
    '★★ 两行必须共用同一个 authorizationId');
  assert.equal(rows[0].outcome, null, '★ intent 行没有 outcome');
  assert.equal(rows[1].outcome, 'unknown', '★★★ result 行写的是 unknown，不是 not-sent');
  assert.notEqual(rows[1].outcome, 'not-sent', '★★★ 落盘值同样不得被降级');
  assert.equal((w.store.read().audit ?? []).length, 1, '★ 既有 dsp_ 审计仍恰好一条');
});

// ── 11. a FAILED result write keeps `unknown` visible, and never flips it to not-sent ─────
test('WAL-11 result 审计写失败 ⇒ 调用方仍看到真实 unknown 且 auditFailed:true（不改成 not-sent、不重试）', async (t) => {
  const w = runtimeWorld(t, { sendOutcome: 'throw', failResultOn: 'result' });
  const result = await w.dispatch('c1');

  // THE WHOLE POINT: the audit is incomplete AND the truth about the send is intact.
  assert.equal(result.outcome, 'unknown', '★★★ 审计写失败不得改变已经确定的 outcome');
  assert.notEqual(result.outcome, 'not-sent', '★★★ 更不得把"可能已发"改判成"没发"');
  assert.equal(result.sent, true, '★★ 已交给运输层，仍然是 true');
  assert.equal(result.auditFailed, true, '★★★ 审计缺口必须同时可见');
  assert.equal(w.sent.length, 1, '★★★ 不因审计失败而重试');

  const rows = w.store.read().writeAudit ?? [];
  assert.deepEqual(rows.map((r) => r.stage), ['intent'], '★ intent 落盘，result 没落盘');
  assert.equal(rows[0].outcome, null);
  assert.equal((w.store.read().audit ?? []).length, 1, '★ 既有 dsp_ 行仍是如实的一条');
});

test('WAL-9 阶段与另两轴矛盾 ⇒ 拒绝：approval 必须有 decision 无 outcome；result 反之', t => {
  const { store, audit } = world(t);

  const bad = [
    ['approval 带 outcome', () => audit.recordWrite(FRAME, 'approval', APPROVED, 'success'), 'invalid write audit outcome'],
    ['approval 无 decision', () => audit.recordWrite(FRAME, 'approval', null, null), 'invalid write audit decision'],
    ['intent 带 decision', () => audit.recordWrite(FRAME, 'intent', APPROVED, null), 'invalid write audit decision'],
    ['intent 带 outcome', () => audit.recordWrite(FRAME, 'intent', null, 'success'), 'invalid write audit outcome'],
    ['result 带 decision', () => audit.recordWrite(FRAME, 'result', APPROVED, 'success'), 'invalid write audit decision'],
    ['result 无 outcome', () => audit.recordWrite(FRAME, 'result', null, null), 'invalid write audit outcome'],
    ['未知阶段', () => audit.recordWrite(FRAME, 'sent', null, null), 'invalid write audit stage'],
  ];
  for (const [label, fn, expected] of bad) {
    assert.throws(fn, (error) => error instanceof TypeError && error.message === expected, label);
  }
  assert.equal((store.read().writeAudit ?? []).length, 0, '★ 全部拒绝，一条都没落盘');

  // And the frame itself cannot smuggle the stage/outcome axes.
  assert.throws(() => audit.recordWrite({ ...FRAME, stage: 'result' }, 'intent', null, null),
    /invalid write audit input/);
  assert.throws(() => audit.recordWrite({ ...FRAME, outcome: 'success' }, 'intent', null, null),
    /invalid write audit input/);

  // The stage set is closed.
  assert.deepEqual([..._STAGES].sort(), ['approval', 'intent', 'result']);
});
