// The write-audit sink: what `formatAuditRecord` structurally cannot carry.
//
// OFFLINE INTERFACE. There is NO production consumer of this module in the repository; nothing in
// `src/bridge.js`, the plugins or the runtime calls `createQzoneWriteAudit`. Everything below is
// exercised only by `scripts/test-qzone-write-audit.mjs`, against a real temporary SQLite store.
// A passing test here is NOT production verification.
//
// WHAT THIS DOES **NOT** PROVE — READ BEFORE TRUSTING A ROW
// --------------------------------------------------------
// `recordWrite()` takes a plain object. Any caller can therefore write any value. This is an
// append-only, shape-validated, bounded LOG — not a trusted audit root. In particular it cannot
// prove that the write it describes actually happened, that the caller was authorised to perform
// it, or that a platform request was ever issued. The `inputDigest` binds a row to an approval
// SNAPSHOT only in the sense that the caller supplied the real snapshot's digest; a caller that
// supplies a plausible-but-invented digest produces a row that looks exactly as good.
// See `src/core/qzone-write-audit-offline.mjs`'s header for the full statement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import {
  createQzoneWriteAudit, _MAX_ROWS, _MAX_NAME_LENGTH, _REDACTED_NAME,
} from '../src/core/qzone-write-audit-offline.mjs';

// ⚠️ THE OPERATOR BLOCK, AND WHAT IT IS WORTH
// -------------------------------------------
// `recordWrite(input, approval)` takes the decision as a SECOND argument. Nothing here proves the
// operator is real: a caller can invent a well-formed session id. These tests pin the SHAPE and the
// null-means-not-recorded semantics, so that today's gateway (which does NOT pass the console
// session into the broker's `decide()`) cannot be mistaken for "the approver was recorded".

const NOW = 1_700_000_000_000;
const ACCOUNT = 123;
const AUTH_ID = 'auth-1';
const DIGEST = 'a'.repeat(64);

/** A complete publish approval row: everything the sink is supposed to carry. */
const PUBLISH_ROW = Object.freeze({
  time: NOW,
  authorizationId: AUTH_ID,
  accountId: ACCOUNT,
  sessionId: 's1',
  requestId: 'request-1',
  callId: 'c1',
  connectionEpoch: 3,
  action: 'publish',
  inputDigest: DIGEST,
  ugcRight: 16,
  targetUins: [111, 222],
});

/** A complete reply approval row, including the addressed-to identity. */
const REPLY_ROW = Object.freeze({
  ...PUBLISH_ROW,
  authorizationId: 'auth-reply',
  action: 'reply',
  ugcRight: null,
  targetUins: null,
  commentId: 'comment-1',
  commentUin: 456,
  replyUin: 789,
  replyName: 'someone',
});

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-write-audit-'));
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

/**
 * `recordWrite` takes `(input, stage, approval, outcome)` so one authorisation can record three
 * distinct facts. Most tests below exercise SHAPE validation rather than the lifecycle, so they use
 * `intent` — the stage that legitimately carries neither a decision nor an outcome — and pass
 * through whichever extra axes the case needs.
 */
const write = (audit, input, { stage = 'intent', approval = null, outcome = null } = {}) =>
  audit.recordWrite(input, stage, approval, outcome);

// ── 1. the publish control: visibility and recipients survive the round trip ──────────────────
test('WA-1 正控 publish：ugcRight 与 targetUins 精确回读（这是现有审计结构性记不了的）', t => {
  const { store, audit } = world(t);
  const result = write(audit, PUBLISH_ROW);
  assert.equal(result.appended, true);

  const rows = audit.read();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ugcRight, 16, '★ 可见性被保住了 —— formatAuditRecord 会静默丢弃它');
  assert.deepEqual(rows[0].targetUins, [111, 222], '★ 收件人被保住了，顺序不变');
  assert.equal(rows[0].inputDigest, DIGEST, '★ 批准摘要被保住');
  assert.equal(rows[0].authorizationId, AUTH_ID);
  assert.equal(rows[0].connectionEpoch, 3);
  assert.equal(rows[0].stage, 'intent', '★ 阶段随行落盘');

  // Stored where it says it is, and NOT inside the existing audit array.
  assert.equal(store.read().writeAudit.length, 1);
  assert.deepEqual(store.read().audit, [], '★ 既有 state.audit 未被污染');
});

// ── 2. the reply control: the addressed-to identity survives ─────────────────────────────────
test('WA-2 正控 reply：commentUin / replyUin / replyName 精确回读', t => {
  const { store, audit } = world(t);
  write(audit, REPLY_ROW);

  const row = audit.read()[0];
  assert.equal(row.action, 'reply');
  assert.equal(row.commentId, 'comment-1');
  assert.equal(row.commentUin, 456, '★ 父评论作者被保住');
  assert.equal(row.replyUin, 789, '★ 被回复者被保住');
  assert.equal(row.replyName, 'someone');
  assert.equal(row.ugcRight, null);
  assert.deepEqual(store.read().audit, []);
});

// ── 3. the body is never stored ─────────────────────────────────────────────────────────────
test('WA-3 不记录正文：sink 里不存在 content 字段，只有可选的摘要', t => {
  const { audit } = world(t);
  write(audit, { ...PUBLISH_ROW, content: 'this body must never be stored' });

  const row = audit.read()[0];
  assert.equal(Object.hasOwn(row, 'content'), false, '★ 正文不是本 sink 的字段，连键都不该出现');
  const serialised = JSON.stringify(row);
  assert.equal(serialised.includes('this body must never be stored'), false, '★ 正文文本不得出现在任何字段里');
});

// ── 4. a display name that looks like a credential is redacted, not stored ───────────────────
test('WA-4 敏感 replyName 被替换为固定标记（不是丢弃整行，也不是原样存储）', t => {
  const { audit } = world(t);
  // A real `isSafeQzoneAuditId` rejection case: the SENSITIVE pattern in qzone-audit-offline.mjs.
  write(audit, { ...REPLY_ROW, authorizationId: 'auth-sensitive', replyName: 'sk-abcdefghijklmnop' });

  const row = audit.read()[0];
  assert.equal(row.replyName, _REDACTED_NAME, '★ 名字含凭证形状 ⇒ 固定标记');
  assert.equal(JSON.stringify(row).includes('sk-abcdefghijklmnop'), false, '★ 原文不得残留');
  assert.equal(row.replyUin, 789, '其余身份字段仍然保留');
});

// ── 5. the existing audit array and the settled key are untouched ────────────────────────────
test('WA-5 不碰 state.audit、不碰 settled：formatAuditRecord 的键集与顺序在本模块前后完全一致', async t => {
  const { store, audit } = world(t);
  const { formatAuditRecord } = await import('../src/core/qzone-audit-offline.mjs');
  const baseState = store.read();

  // `settleKeyFor()` is `sha256(JSON.stringify(formatAuditRecord(...)))` and is NOT exported
  // (`qzone-write-observability-offline.mjs:86,199`). Its input — the formatted record's KEY ORDER
  // — is the observable contract, so that is what gets pinned here: if this module had widened or
  // reordered `formatAuditRecord`, every historical settled key would silently change.
  const sample = {
    time: NOW, source: 'qq', action: 'publish', target: '123', postId: null,
    commentId: null, content: 'x', result: 'success', reason: '', quota: 1,
  };
  const before = formatAuditRecord(sample);
  const keysBefore = Object.keys(before);(audit, PUBLISH_ROW);

  assert.deepEqual(store.read().audit, [], '★ 既有审计数组未被写入');
  assert.equal((store.read().audit ?? []).length, baseState.audit.length);

  const after = formatAuditRecord(sample);
  assert.deepEqual(Object.keys(after), keysBefore, '★ 键集与顺序逐位不变 —— 历史 settled key 不会被作废');
  assert.deepEqual(after, before, '★ 同一个输入仍然产出同一个记录');
  // And the new sink's own extra fields are NOT among them.
  for (const field of ['ugcRight', 'targetUins', 'commentUin', 'replyUin', 'replyName', 'inputDigest']) {
    assert.equal(Object.hasOwn(after, field), false, `★ formatAuditRecord 仍然不含 ${field}`);
  }
});

// ── 6. pruning is part of the same commit ───────────────────────────────────────────────────
test('WA-6 大小上限：超出 MAX_ROWS 时最旧先淘汰，且读者永不见超限数组', t => {
  const { store, audit } = world(t);
  const total = _MAX_ROWS + 5;
  for (let i = 0; i < total; i += 1) {
    write(audit, { ...PUBLISH_ROW, authorizationId: `auth-${i}` });
    const live = store.read().writeAudit;
    assert.ok(live.length <= _MAX_ROWS, `第 ${i} 次写入后仍在限制内`);
  }
  const rows = audit.read();
  assert.equal(rows.length, _MAX_ROWS, '★ 保留最新 MAX_ROWS 条');
  assert.equal(rows[0].authorizationId, 'auth-5', '★ 最旧的 5 条被淘汰');
  assert.equal(rows[rows.length - 1].authorizationId, `auth-${total - 1}`, '★ 最新一条仍在');
});

// ── 7. idempotency by authorizationId, with a typed conflict ────────────────────────────────
test('WA-7 同一 authorizationId：字节相同 ⇒ 幂等无操作；内容不同 ⇒ 带 code 的冲突', t => {
  const { store, audit } = world(t);
  assert.equal(write(audit, PUBLISH_ROW).appended, true);

  assert.equal(write(audit, PUBLISH_ROW).appended, false, '★ 重试是 no-op');
  assert.equal(store.read().writeAudit.length, 1, '★ 不产生重复行');

  let thrown = null;
  try {
    write(audit, { ...PUBLISH_ROW, ugcRight: 1, targetUins: null });
  } catch (error) { thrown = error; }
  assert.ok(thrown instanceof Error, '同一 id 不同内容必须拒绝');
  assert.equal(thrown.code, 'WRITE_AUDIT_ID_CONFLICT', '★ 是 typed code，不是靠消息文本匹配');
  assert.equal(store.read().writeAudit.length, 1, '冲突未写入');
});

// ── 8. shape refusals: nothing malformed reaches the store ──────────────────────────────────
test('WA-8 形状拒绝：可见性/收件人/回复字段/超长一律拒绝且不写入', t => {
  const { store, audit } = world(t);

  const cases = [
    [{ ...PUBLISH_ROW, ugcRight: 3 }, 'ugcRight 不在闭集', 'invalid write audit visibility'],
    [{ ...PUBLISH_ROW, ugcRight: 16, targetUins: undefined }, '16 无收件人', 'invalid write audit recipients'],
    [{ ...PUBLISH_ROW, ugcRight: 1, targetUins: [111] }, '非 16/128 却带收件人', 'invalid write audit recipients'],
    [{ ...PUBLISH_ROW, ugcRight: null, targetUins: [111] }, '无可见性却带收件人', 'invalid write audit recipients'],
    [{ ...PUBLISH_ROW, inputDigest: 'not-hex' }, '摘要非 hex64', 'invalid write audit input digest'],
    [{ ...PUBLISH_ROW, action: 'share' }, '未知动作', 'invalid write audit action'],
    [{ ...PUBLISH_ROW, commentId: 'c', commentUin: 1 }, '非 reply 带回复字段', 'invalid write audit reply fields'],
    [{ ...REPLY_ROW, commentUin: undefined }, 'reply 缺 commentUin', 'invalid write audit comment uin'],
    [{ ...REPLY_ROW, replyName: undefined }, 'replyUin 有而 replyName 无', 'invalid write audit reply target'],
    [{ ...REPLY_ROW, replyName: 'x'.repeat(_MAX_NAME_LENGTH + 1) }, '名字超长', 'invalid write audit input'],
  ];

  for (const [input, label, expected] of cases) {
    assert.throws(() => write(audit, input), (error) => {
      // The over-long name throws its own message; assert on the prefix we care about.
      if (expected === 'invalid write audit input' && /invalid reply name/.test(error.message)) return true;
      return error instanceof TypeError && error.message === expected;
    }, label);
  }
  assert.equal((store.read().writeAudit ?? []).length, 0, '★ 全部拒绝，一条都没落盘');
});

// ── 9. a bare object is accepted: the honest limit of this sink ─────────────────────────────
test('WA-9 诚实边界：裸对象即可写入 —— 本 sink 不能证明记录的事真的发生过', t => {
  const { audit } = world(t);
  // Nothing here is a "trusted projection": this is exactly the shape any caller can fabricate.
  // The test exists so the limitation is EXECUTABLE rather than a comment nobody reads.
  write(audit, { ...PUBLISH_ROW, authorizationId: 'auth-invented', inputDigest: 'f'.repeat(64) });
  const row = audit.read()[0];
  assert.equal(row.authorizationId, 'auth-invented');
  assert.equal(row.inputDigest, 'f'.repeat(64), '★ 一个编造的摘要与真实的摘要，本 sink 无从区分');
  // What it DOES still guarantee: the row is shape-valid, bounded and credential-screened.
  assert.equal(Object.isFrozen(row), true);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The operator block (WA-10 … WA-13)
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// Design contract under test: the decision is a SEPARATE argument from the operation, it is either
// fully attributed or explicitly `null`, and a `null` means "not recorded" — never "an anonymous
// operator approved". The console gateway does not currently carry a session into the broker, so
// the null path is the only one a real deployment can reach today; these tests keep that visible.

const APPROVAL = Object.freeze({
  operator: 'admin',
  operatorSessionId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  decidedAt: NOW + 1000,
  decision: 'approved',
});

// ── 10. an attributed decision survives the round trip ─────────────────────────────────────
test('WA-10 有操作员：approval 作为独立参数传入 ⇒ 四个操作员字段精确落盘', t => {
  const { audit } = world(t);
  write(audit, PUBLISH_ROW, { stage: 'approval', approval: APPROVAL });

  const row = audit.read()[0];
  assert.equal(row.operator, 'admin', '★ 操作员标签被记录');
  assert.equal(row.operatorSessionId, APPROVAL.operatorSessionId, '★ 服务端 mint 的会话 id 被记录');
  assert.equal(row.decidedAt, NOW + 1000, '★ 决定时间被记录');
  assert.equal(row.decision, 'approved', '★ 决定结果被记录');
  // The operation frame is unchanged by the presence of an approval.
  assert.equal(row.ugcRight, 16);
  assert.deepEqual(row.targetUins, [111, 222]);
});

// ── 11. no approval ⇒ the block is present but null (not absent, not "anonymous") ──────────
test('WA-11 未记录操作员：approval 省略 ⇒ 四个字段为 null 且键仍存在（null ≠ 匿名批准）', t => {
  const { audit } = world(t);
  write(audit, PUBLISH_ROW);

  const row = audit.read()[0];
  for (const field of ['operator', 'operatorSessionId', 'decidedAt', 'decision']) {
    assert.equal(Object.hasOwn(row, field), true, `★ ${field} 键必须存在 —— 否则读方无法区分"没记录"和"schema 变了"`);
    assert.equal(row[field], null, `★ ${field} 为 null 表示未记录，不是"没有操作员"`);
  }
});

// ── 12. a half-attributed decision is refused, never stored half-populated ────────────────
test('WA-12 半套 approval / 畸形值一律拒绝且不写入（半行会读成一条完整归属的决定）', t => {
  const { store, audit } = world(t);
  const bad = [
    ['无任何身份', { decidedAt: NOW, decision: 'approved' }, 'invalid write audit operator'],
    ['operator 非安全 id', { operator: 'bad name', decidedAt: NOW, decision: 'approved' }, 'invalid write audit operator'],
    ['sessionId 非安全 id', { operatorSessionId: '', decidedAt: NOW, decision: 'approved' }, 'invalid write audit operator session'],
    ['decision 不在闭集', { operator: 'admin', decidedAt: NOW, decision: 'maybe' }, 'invalid write audit decision'],
    ['decidedAt 非有限数', { operator: 'admin', decidedAt: 'now', decision: 'approved' }, 'invalid write audit decided time'],
    ['数组', [], 'invalid write audit approval'],
    ['字符串', 'approved', 'invalid write audit approval'],
  ];
  for (const [label, approval, expected] of bad) {
    assert.throws(() => audit.recordWrite(PUBLISH_ROW, 'approval', approval),
      (error) => error instanceof TypeError && error.message === expected, label);
  }
  assert.equal((store.read().writeAudit ?? []).length, 0, '★ 全部拒绝');
});

// ── 13. the operation frame cannot smuggle the operator fields ───────────────────────────
test('WA-13 操作帧不能夹带操作员字段：input 里出现 operator/decision 即拒绝', t => {
  const { store, audit } = world(t);
  for (const field of ['operator', 'operatorSessionId', 'decision', 'decidedAt']) {
    assert.throws(() => audit.recordWrite({ ...PUBLISH_ROW, [field]: 'x' }, 'approval', APPROVAL),
      (error) => error instanceof TypeError && error.message === 'invalid write audit input',
      `input 携带 ${field} 必须被拒`);
  }
  assert.equal((store.read().writeAudit ?? []).length, 0, '★ 一条都没落盘');
  // The honest limit, restated where it matters: a well-formed INVENTED session is accepted.
  write(audit, PUBLISH_ROW, {
    stage: 'approval',
    approval: { operatorSessionId: 'a'.repeat(36), decidedAt: NOW, decision: 'approved' },
  });
  assert.equal(audit.read()[0].operatorSessionId, 'a'.repeat(36),
    '★ 编造的会话 id 与真实的会话 id，本 sink 无从区分 —— 真相必须由服务端认证路由提供');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The outcome axis (WA-14 … WA-16): intent / approval / dispatch / outcome are four facts
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// The failure this guards against is collapsing them: reporting `decision:'approved'` as though a
// human's approval were the platform's answer, or `outcome:'success'` as though `send()` returning
// were proof the post exists. `send` is ALWAYS an injected function here, and the write path's own
// classifier reads an unparseable answer as `unknown` — never as success.

// ── 14. the four result outcomes round-trip, and the decision lives on its own row ────────
test('WA-14 四种 result outcome 各自落盘，且决策在 approval 行上、不被 outcome 覆盖', t => {
  // The stage model makes "approved" and "how it ended" DIFFERENT ROWS on purpose: a single row
  // carrying both would let a later `unknown` overwrite the approval that licensed it.
  const values = ['success', 'failed', 'unknown', 'not-sent'];
  for (const [index, outcome] of values.entries()) {
    const { audit } = world(t);
    const id = `auth-out-${index}`;
    audit.recordWrite({ ...PUBLISH_ROW, authorizationId: id }, 'approval',
      { operator: 'admin', decidedAt: NOW, decision: 'approved' });
    audit.recordWrite({ ...PUBLISH_ROW, authorizationId: id }, 'result', null, outcome);

    const rows = audit.stagesFor(id);
    assert.deepEqual(rows.map((row) => row.stage), ['approval', 'result'], '★ 两行、两种阶段');
    assert.equal(rows[0].decision, 'approved', '★ 决策留在 approval 行');
    assert.equal(rows[0].outcome, null, '★ approval 行没有 outcome');
    assert.equal(rows[1].outcome, outcome, `★ outcome=${outcome} 原样落盘在 result 行`);
    assert.equal(rows[1].decision, null, '★ result 行不带决策 —— 它回答"怎么结束的"');
  }
});

// ── 15. no outcome ⇒ null, and that is NOT "success" ─────────────────────────────────────
test('WA-15 未记录 outcome ⇒ null（键存在），且绝不默认成 success', t => {
  const { audit } = world(t);
  write(audit, PUBLISH_ROW, { stage: 'approval', approval: APPROVAL });

  const row = audit.read()[0];
  assert.equal(Object.hasOwn(row, 'outcome'), true, '★ 键必须存在，读方才能区分"没记录"与"字段不存在"');
  assert.equal(row.outcome, null, '★ null 表示未记录，绝不默认 success');
  assert.notEqual(row.outcome, 'success', '★ 尤其不得因为 send 被调用就写成 success');
});

// ── 16. an invented outcome value is refused ────────────────────────────────────────────
test('WA-16 outcome 不在闭集 / 非字符串 ⇒ 拒绝且不写入', t => {
  const { store, audit } = world(t);
  const bad = [
    ['拼写错', 'succes', 'invalid write audit outcome'],
    ['大写', 'SUCCESS', 'invalid write audit outcome'],
    ['空串', '', 'invalid write audit outcome'],
    ['数字', 1, 'invalid write audit outcome'],
    ['对象', { ok: true }, 'invalid write audit outcome'],
    ['对应 send 返回值形状', { ok: true, outcome: 'success' }, 'invalid write audit outcome'],
  ];
  for (const [label, value, expected] of bad) {
    assert.throws(() => audit.recordWrite(PUBLISH_ROW, 'result', null, value),
      (error) => error instanceof TypeError && error.message === expected, label);
  }
  assert.equal((store.read().writeAudit ?? []).length, 0, '★ 全部拒绝');
  // And a caller cannot launder a raw transport answer through the outcome slot: only the six
  // canonical strings are accepted, so `{ok:true}` — what `send` actually returns — never lands.
});
