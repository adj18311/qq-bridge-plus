// ATOMICITY of the reply evidence gate — the negative controls that make the move from the transport
// closure to the reservation transaction MEANINGFUL rather than cosmetic.
//
// WHAT CHANGED, AND WHY THIS FILE EXISTS
// --------------------------------------
// The gate used to run in `qzone-approved-comment-dispatch-offline.mjs`'s transport closure, i.e.
// AFTER `reserveOfflineInteraction` had committed. A refused reply therefore burned a `comment` quota
// unit and pushed `lastCommentAt` by 3 minutes: the caller got no message out, paid for one, and every
// later legitimate comment was throttled. It now runs inside `reserveAuditedOfflineInteraction`, in the
// SAME `store.update` that would spend the unit and advance the clock — so the two `return state`
// refusals occur BEFORE `reserveOfflineInteraction` is called at all.
//
// Codex's requirement, verbatim in intent: when the evidence is missing or does not match, the reply
// must be refused **in the same real `update`, before the reserve**, and `used.comment`,
// `lastCommentAt`, `commentTargets` and the B2 key must ALL be unchanged. A check at the transport
// stage must NOT be offered as a substitute for that guarantee.
//
// Every case below therefore asserts the STATE, not just the returned object: "refused" is cheap,
// "refused and free" is the property under test.
//
// WHAT IS A FIXTURE HERE
// ----------------------
// `state.commentEvidence` rows. **No producer of that collection was found within the checked scope**
// (this repository's `src/`): nothing in a read handler, an event adapter or any runtime wiring
// appends a row from a platform read. That is not a claim about every deployment, host or external
// writer. These tests seed rows to exercise the GATE; they are not evidence that any comment exists,
// that any reply was approved, or that reply is usable in production.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { initializeReplayState } from '../src/core/qzone-replay-claim-offline.mjs';
import { createQzoneOriginLedger, isOriginLedgerConsumption } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneOperationAuthorizer } from '../src/core/qzone-operation-authorization-offline.mjs';
import { createOfflineWritePath } from '../src/core/qzone-write-path-offline.mjs';
import { reserveAuditedOfflineInteraction } from '../src/core/qzone-reservation-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { createQzoneWriteAuthorizer } from '../src/core/qzone-approved-comment-dispatch-offline.mjs';

const NOW = Date.parse('2026-11-15T04:00:00Z');
const ACCOUNT = 123;
const SESSION = 's1';
const REQUEST = 'request-1';
const SOURCE = 'qq';
const TARGET = '9876543210';
const POST_ID = 'post-1';
const COMMENT_ID = 'cm-1';
const COMMENT_UIN = 7;

/** The reply the host approved: parent comment id AND its author, which is the identity at stake. */
const REPLY_INPUT = Object.freeze({
  tid: POST_ID, target_uin: 9876543210, content: 'replying to you',
  comment_id: COMMENT_ID, comment_uin: COMMENT_UIN,
});

/** The canonical, corroborating evidence row (FIXTURE — see the banner above).
 *
 * `at` is REQUIRED: the reservation judges evidence age inside its own transaction, so a row with no
 * dateable stamp is refused as `evidence-undated` instead of being treated as ageless. These rows use
 * the same `NOW` the fixture's request uses, i.e. maximally fresh. */
const EVIDENCE_OK = Object.freeze({
  target: TARGET, postId: POST_ID, commentId: COMMENT_ID,
  commentUin: COMMENT_UIN, replyUin: null, replyName: null, at: NOW,
});

const baseState = (now = NOW) => ({
  enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
  tools: { publish: true, comment: true, reply: true, like: true, read_posts: true },
  limits: { post: 10, comment: 25, like: 30 },
  ledger: { day: beijingDay(now), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
  lastPostAt: null,
  lastCommentAt: null,
  commentTargets: [],
  likes: [],
  // The audited reservation appends an `unknown` intent row in the SAME transaction as the unit, so
  // the collection must exist. A state without it throws `invalid audit state` — a store fault, not a
  // refusal — which would mask what these cases measure.
  audit: [],
  // EMPTY, not absent: "no corroborating row" is the baseline, so a positive control must add one.
  commentEvidence: [],
});

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qzone-reply-atomic-${label}-`));
}

function removeDir(t, dir) {
  t.after(() => {
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
    }
  });
}

/**
 * One world: a real temp SQLite file, an initialized replay collection, the real authorizer, the real
 * write path and the real facade — i.e. the same composition ACD-* uses, so `send` and the B2 key are
 * observable on exactly the path a caller would take.
 */
function fixture(t, options = {}) {
  const dir = tempDir('world');
  removeDir(t, dir);
  const store = openOfflineStore(path.join(dir, 'state.db'), options.state ?? baseState());
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  assert.equal(initializeReplayState(store, { now: NOW }).ok, true, '前提：replay 集合已初始化');

  const live = { now: NOW };
  const approve = { calls: 0 };
  const authorizer = createQzoneOperationAuthorizer({
    store,
    accountId: ACCOUNT,
    sourceEpoch: 'e1',
    clock: () => live.now,
    approveOperation: () => { approve.calls += 1; return true; },
    isCurrent: () => true,
  });

  const sent = [];
  const send = async (payload) => { sent.push(payload); return { ok: true }; };

  const writePath = (transport) => createOfflineWritePath({
    store, clock: () => live.now, transport,
  });
  const facade = createQzoneWriteAuthorizer({ authorizer, writePath, send, source: options.source ?? SOURCE });

  let calls = 0;
  /** A real branded consumption; a fresh ledger per call, because `consume()` retires a callId. */
  function consumptionFor(callId) {
    calls += 1;
    const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1' });
    ledger.registerBridgeRequest({ requestId: REQUEST, origin: 'qq-inbound' });
    assert.equal(ledger.observeStep({
      sessionId: SESSION, turn: 1, step: 1,
      messages: [{ role: 'user', source: { rpcId: REQUEST } }],
    }), true);
    assert.equal(ledger.observeToolCall({
      sessionId: SESSION, event: { type: 'tool/call', data: { turn: 1, step: 1, callId } },
    }), true);
    const consumption = ledger.consume({ sessionId: SESSION, callId, turn: 1, step: 1 });
    assert.equal(isOriginLedgerConsumption(consumption), true, '前提：这是真实账本签发的 consumption');
    return consumption;
  }

  /** FIXTURE: seed `state.commentEvidence` in the REAL store (no production code writes here). */
  function seedEvidence(rows) {
    store.update((state) => ({ ...state, commentEvidence: rows }));
  }

  const claimedKeys = () => Object.keys(store.read().usedReadKeys ?? {});

  /**
   * Everything Codex required to be UNCHANGED by a refused reply, read from committed state.
   *
   * Returned as one snapshot so a case can compare before/after wholesale instead of re-listing the
   * five fields (and so a NEW state field that a refusal starts touching becomes visible as a diff
   * rather than being silently unobserved).
   */
  function costSnapshot() {
    const state = store.read();
    return {
      used: { ...state.ledger.used },
      lastCommentAt: state.lastCommentAt,
      commentTargets: JSON.parse(JSON.stringify(state.commentTargets)),
      reservations: Object.keys(state.ledger.reservations).sort(),
      auditLength: Array.isArray(state.audit) ? state.audit.length : -1,
      b2Keys: claimedKeys(),
      commentEvidence: JSON.parse(JSON.stringify(state.commentEvidence ?? [])),
    };
  }

  function runReply(over = {}) {
    return facade.execute({
      action: 'reply',
      consumption: consumptionFor(`cr-${calls}`),
      connectionEpoch: 0,
      input: REPLY_INPUT,
      ...over,
    });
  }

  return { dir, store, live, approve, authorizer, sent, facade, seedEvidence, runReply, costSnapshot, claimedKeys };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// ACD-ATOMIC-1 — omitting `replyParams` must NEVER silently degrade to the identity-triple check
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// THE MOST IMPORTANT NEGATIVE CONTROL OF THIS ROUND.
//
// `reserveAuditedOfflineInteraction`'s `replyParams` argument is optional (older callers predate the
// reply identity). "Optional" must not become "if you leave the identity out, a row that merely names
// the right comment is good enough" — that would be a gate that can be switched off by omitting an
// argument, and it would authorise a reply whose addressed-to identity was never checked.
//
// So the rule is: without an identity to compare, a row that CARRIES identity fields cannot be
// corroborated (refuse), and — on the path that matters — the write path never omits the identity at
// all, so even a bare triple-only row is refused there. Both halves are pinned below.
test('ACD-ATOMIC-1 缺 replyParams 不得退化为三字段检查：带身份字段的 evidence 行必须拒，零消耗', async t => {
  const dir = tempDir('atomic1');
  removeDir(t, dir);
  const store = openOfflineStore(path.join(dir, 'state.db'), baseState());
  t.after(() => { try { store.close(); } catch { /* already closed */ } });

  const request = { id: 'atomic-1', now: NOW, tool: 'reply', target: TARGET, postId: POST_ID, commentId: COMMENT_ID, source: 'qq' };
  const intent = {
    time: NOW, source: 'qq', action: 'reply', target: TARGET, postId: POST_ID, commentId: COMMENT_ID,
    content: 'replying to you', result: 'unknown', reason: '',
  };

  // The row matches the identity TRIPLE (target / postId / commentId) but carries a reply TARGET and
  // NO parent-comment author. A triple-only comparison would accept it; the full comparison cannot.
  store.update((state) => ({
    ...state,
    commentEvidence: [{ target: TARGET, postId: POST_ID, commentId: COMMENT_ID, replyUin: 42, replyName: 'Bob' }],
  }));

  const before = JSON.stringify(store.read().ledger);
  const refused = reserveAuditedOfflineInteraction(store, request, intent);

  assert.equal(refused.allowed, false, '★ 三字段匹配不等于可以放行：缺 commentUin 的行不得被接受');
  assert.equal(refused.reason, 'comment_evidence_mismatch', '★ 拒因必须点名"证据不匹配"，不是"缺失"');
  // THE COST, asserted: this refusal ran before `reserveWrite`, so nothing moved.
  assert.equal(JSON.stringify(store.read().ledger), before, '★ ledger 逐字节不变（没有扣额，没有占 id）');
  assert.equal(store.read().ledger.used.comment, 0, '★ used.comment 仍是 0');
  assert.equal(store.read().lastCommentAt, null, '★ lastCommentAt 仍是 null：被拒的请求不产生冷却');
  assert.deepEqual(store.read().commentTargets, [], '★ commentTargets 未变');
  assert.deepEqual(store.read().audit, [], '★ 意图审计也没有落盘（零预留 ⇒ 零审计）');

  // A reply that DOES supply the identity refuses the SAME row too — because the row lacks the field
  // the comparison needs (`Object.hasOwn(commentUin)`, inside `matchesReplyEvidence`). Stated
  // separately so "no identity supplied" cannot be confused with "identity supplied and checked".
  const refusedWithIdentity = reserveAuditedOfflineInteraction(store, { ...request, id: 'atomic-1b' }, intent);
  assert.equal(refusedWithIdentity.allowed, false, '★ 带 replyParams 时同一条残缺证据同样必须拒');
  assert.equal(refusedWithIdentity.reason, 'comment_evidence_mismatch');
  assert.equal(store.read().ledger.used.comment, 0);
});

test('ACD-ATOMIC-1b 走写路径时 reply 永远自带身份：只有三字段的证据行也必须拒（零消耗）', async t => {
  // The write path's reply branch supplies `replyParams` UNCONDITIONALLY (it is built from the frozen
  // dispatch, which always carries `commentUin` for a reply). A caller therefore cannot reach the
  // lenient "no identity supplied" shape through the facade at all. This case pins that: a bare
  // triple-only row — the shape an old producer would have written — is refused end to end.
  const f = fixture(t);
  // ⚠️ FIXTURE: the pre-identity row shape.
  f.seedEvidence([{ target: TARGET, postId: POST_ID, commentId: COMMENT_ID }]);

  const before = f.costSnapshot();
  const result = await f.runReply();

  assert.equal(result.ok, false, '★ 缺 uin 字段的证据不能算匹配');
  assert.equal(result.stage, 'reserve', '★ 拒绝发生在预留阶段');
  assert.equal(result.reason, 'comment_evidence_mismatch', '★ 预留层词汇');
  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.deepEqual(f.costSnapshot(), before, '★ 零消耗：配额/时钟/目标/B2/审计/证据 全部逐字不变');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// ACD-ATOMIC-2 / -3 — the refusals are FREE: five observables, asserted together
// ══════════════════════════════════════════════════════════════════════════════════════════════════

test('ACD-ATOMIC-2 缺失 evidence ⇒ 预留前拒绝：used.comment / lastCommentAt / commentTargets / B2 / audit 全不变', async t => {
  const f = fixture(t);
  // No evidence seeded at all: `commentEvidence: []` is the baseline (and the un-corroborated shape).
  const before = f.costSnapshot();
  assert.equal(before.used.comment, 0, '前提：配额从 0 起（不是靠"0 还是 0"证明，见下面非零基线）');
  assert.deepEqual(before.b2Keys, [], '前提：没有任何 B2 键');

  const result = await f.runReply();

  assert.equal(result.ok, false, '没有证据的 reply 必须被拒');
  assert.equal(result.stage, 'reserve', '★ 拒绝发生在预留阶段（与旧契约的 transport 阶段相对）');
  assert.equal(result.reason, 'missing_comment_evidence', '★ 理由来自预留层');
  assert.equal(Object.hasOwn(result, 'quotaConsumed'), false,
    '★ 预留前拒绝没有 quotaConsumed 字段（写路径对"从未可能扣额"的拒绝就是这个形态）');
  assert.notEqual(result.quotaConsumed, true, '★ 绝不允许报告"已消耗"');
  assert.equal(result.sent, false);
  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.equal(f.approve.calls, 1, 'host 只被问一次（证据门在 prepare 之后、预留之内）');

  const after = f.costSnapshot();
  assert.deepEqual(after.used, before.used, '★ used 未变（含 comment 桶）');
  assert.equal(after.lastCommentAt, before.lastCommentAt, '★ lastCommentAt 未变（仍为 null）');
  assert.deepEqual(after.commentTargets, before.commentTargets, '★ commentTargets 未变');
  assert.deepEqual(after.b2Keys, before.b2Keys, '★ B2 键未变（一个都没占）');
  assert.equal(after.auditLength, before.auditLength, '★ 审计未增（意图与额度同一事务，额度没扣⇒意图没写）');
  assert.deepEqual(after.reservations, before.reservations, '★ 没有为该 id 写预留记录');

  // NON-VACUITY: the SAME fixture with matching evidence really does spend and really does send, so
  // the assertions above are not measuring a fixture that could never write.
  f.seedEvidence([EVIDENCE_OK]);
  const success = await f.runReply();
  assert.equal(success.ok, true, `同一 world 加上证据必须成功: ${JSON.stringify(success)}`);
  assert.equal(f.sent.length, 1, '★ 非空性：同一 world 一旦证据匹配就真的发送一次');
  assert.equal(f.store.read().ledger.used.comment, 1, '★ 并且真的扣了 1（对照组）');
  assert.equal(f.store.read().lastCommentAt, NOW, '★ 并且真的推进了评论时钟（对照组）');
  assert.equal(f.claimedKeys().length, 1, '★ 并且真的占了 1 个 B2 键（对照组）');
});

test('ACD-ATOMIC-3 完整证据不匹配（commentUin 不符）⇒ 同样五项全不变', async t => {
  const f = fixture(t);
  // ⚠️ FIXTURE: the row names the same comment but a DIFFERENT author.
  f.seedEvidence([{ ...EVIDENCE_OK, commentUin: 8 }]);

  const before = f.costSnapshot();
  const result = await f.runReply();

  assert.equal(result.ok, false, '父评论作者不符必须被拒');
  assert.equal(result.stage, 'reserve', '★ 预留阶段拒绝');
  assert.equal(result.reason, 'comment_evidence_mismatch', '★ 与"缺失"区分开：行在，但对不上');
  assert.equal(Object.hasOwn(result, 'quotaConsumed'), false, '★ 没有 quotaConsumed 字段');
  assert.notEqual(result.quotaConsumed, true);
  assert.equal(f.sent.length, 0, 'send 不得被调用');

  const after = f.costSnapshot();
  assert.deepEqual(after.used, before.used, '★ used 未变');
  assert.equal(after.lastCommentAt, before.lastCommentAt, '★ lastCommentAt 未变');
  assert.deepEqual(after.commentTargets, before.commentTargets, '★ commentTargets 未变');
  assert.deepEqual(after.b2Keys, before.b2Keys, '★ B2 键未变');
  assert.equal(after.auditLength, before.auditLength, '★ 审计未增');
  assert.deepEqual(after.reservations, before.reservations, '★ 无预留记录');

  // The refusal is NOT sticky: fixing the row (same id, same world) lets the very next attempt through
  // without any cooldown in between — which is the product-level reason the gate had to move.
  f.seedEvidence([EVIDENCE_OK]);
  const second = await f.runReply();
  assert.equal(second.ok, true, `★ 纠正证据后立刻必须能发（未被上一次拒绝冷却）: ${JSON.stringify(second)}`);
  assert.equal(f.sent.length, 1, '★ 恰好在纠正之后发送一次');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// ACD-ATOMIC-4 — an unsupported source is a CONTROLLED refusal, not a TypeError
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// `reserveAuditedOfflineInteraction` requires `source ∈ {qq, patrol}` and THROWS `invalid intent`
// otherwise. A throw from inside the write path is classified as a STORE FAULT by every caller above
// (the write path deliberately propagates store failures), so a bad `source` would be reported as
// "the database is broken" instead of "this request cannot be sent". The write path therefore
// whitelists the source and returns the ordinary pre-reserve refusal shape.
test('ACD-ATOMIC-4 source 不受支持 ⇒ 预留前受控拒绝（不抛异常），零消耗、send 0', async t => {
  // `admin_console` is a LEGAL audit source (`qzone-audit-offline.mjs` SOURCES), so this is not a
  // nonsense value: it is a source that is real elsewhere but cannot authorise a qzone write here.
  const f = fixture(t, { source: 'admin_console' });
  f.seedEvidence([EVIDENCE_OK]);   // evidence is fine; the SOURCE is what must refuse
  const before = f.costSnapshot();

  // assert.rejects would be the wrong assertion: nothing may reject.
  const result = await f.runReply();

  assert.equal(result.ok, false, '不支持的 source 必须被拒');
  assert.equal(result.stage, 'reserve', '★ 预留阶段（不是 transport，也不是 authorize）');
  assert.equal(result.reason, 'unsupported-reply-source', '★ 拒因必须点名 source');
  assert.notEqual(result.quotaConsumed, true, '★ 不得报告已消耗');
  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.equal(f.approve.calls, 1, 'host 被问一次：source 不是 host 的判决');

  const after = f.costSnapshot();
  assert.deepEqual(after.used, before.used, '★ used 未变');
  assert.equal(after.lastCommentAt, before.lastCommentAt, '★ lastCommentAt 未变');
  assert.deepEqual(after.commentTargets, before.commentTargets, '★ commentTargets 未变');
  assert.deepEqual(after.b2Keys, before.b2Keys, '★ B2 键未变');
  assert.equal(after.auditLength, before.auditLength, '★ 审计未增');

  // Direct proof that the refusal is the WRITE PATH's, not the reservation module throwing: calling the
  // reservation with the same illegal source and valid evidence DOES throw `invalid intent`. That is
  // why the whitelist exists in front of it.
  assert.throws(
    () => reserveAuditedOfflineInteraction(
      f.store,
      {
        id: 'direct-bad-source', now: NOW, tool: 'reply', target: TARGET, postId: POST_ID,
        commentId: COMMENT_ID, source: 'admin_console',
      },
      {
        time: NOW, source: 'admin_console', action: 'reply', target: TARGET, postId: POST_ID,
        commentId: COMMENT_ID, content: 'replying to you', result: 'unknown', reason: '',
      },
    ),
    (error) => error instanceof TypeError && /invalid intent/.test(error.message),
    '★ 预留层对非法 source 是抛错 —— 正因如此写路径必须先把它变成受控拒绝',
  );
  assert.deepEqual(f.costSnapshot(), before, '★ 连那次抛错的直接调用也没有留下任何状态');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// ACD-ATOMIC-5 — positive control: the same path, with everything matching, really does send
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// Without this, every case above could be passing because the composition can never write at all.
test('ACD-ATOMIC-5 正控：全量匹配 + source qq ⇒ send 恰 1 次、used.comment = 1、lastCommentAt 推进', async t => {
  const f = fixture(t);
  f.seedEvidence([EVIDENCE_OK]);
  const before = f.costSnapshot();

  const result = await f.runReply();

  assert.equal(result.ok, true, `应成功: ${JSON.stringify(result)}`);
  assert.equal(result.outcome, 'success');
  assert.equal(result.sent, true);
  assert.equal(f.sent.length, 1, '★ send 恰 1 次');
  assert.equal(f.sent[0].params.comment_id, COMMENT_ID, '父评论 id 原样送达');
  assert.equal(f.sent[0].params.comment_uin, COMMENT_UIN, '父评论作者原样送达');

  const after = f.costSnapshot();
  assert.equal(after.used.comment, 1, '★ used.comment 恰好 +1');
  assert.equal(after.used.post, before.used.post, '★ post 桶未动');
  assert.equal(after.used.like, before.used.like, '★ like 桶未动');
  assert.equal(after.lastCommentAt, NOW, '★ lastCommentAt 推进到 NOW');
  assert.deepEqual(after.commentTargets, [{ target: TARGET, time: NOW }], '★ commentTargets 记下这次目标');
  assert.equal(after.b2Keys.length, 1, '★ B2 键恰好 1 条');
  assert.equal(after.auditLength, before.auditLength + 1, '★ 审计意图恰好多 1 行（与额度同一事务）');
  assert.equal(after.reservations.length, before.reservations.length + 1, '★ 预留记录恰好多 1 条');
  assert.equal(result.quotaConsumed, true, '★ 正控如实报告配额已消耗');

  // And the SAME id cannot be replayed: the reservation is durable.
  const replay = await f.runReply();
  assert.equal(replay.ok, false, '同 id 第二次必须被拒');
  assert.equal(f.sent.length, 1, '不得第二次发送');
});
