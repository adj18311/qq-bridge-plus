// A PRODUCER for `state.commentEvidence` — the collection the reply gate consumes.
//
// WHERE THE INPUT COMES FROM
// --------------------------
// Every projection fed to `record()` below is produced by a REAL call to
// `bindAuthorizedQzoneReply` / `bindAuthorizedOwnNewQzoneComment`
// (`qzone-comment-binding-offline.mjs`), i.e. the trusted `{status:'ok', retcode:0}` detail-response
// projection. **That detail payload is a TEST FIXTURE**: no platform was contacted, and nothing in
// this file proves a real comment exists. What the tests DO prove is the mapping
// (trusted projection -> evidence row), the store transaction, the size/lifecycle rules and that the
// written row is genuinely consumable by `reserveAuditedOfflineInteraction`.
//
// WHAT IS NOT CLAIMED
// -------------------
//   · **No production caller.** This module is only *available to be wired in*; `src/` does not call
//     it anywhere, and these tests must not be read as "reply works in production now".
//   · The rows are written by the module under test, not seeded by the test (that is the point of the
//     file). Only the `prune` case seeds one FOREIGN row, and it says so.
//
// `bindAuthorized*` returns a plain `Object.freeze`d object, so "the caller really got this from a
// binding" is NOT provable here (see the module header) — a hand-built object of the same shape passes.
// These tests therefore pin what is actually enforced: shape, freeze flag, field domains, the
// one-row-per-comment rule and the mapping. They do not pretend to pin provenance.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore, openOfflineStoreReadOnly } from '../src/core/qzone-store-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { reserveAuditedOfflineInteraction } from '../src/core/qzone-reservation-offline.mjs';
import { DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS } from '../src/core/qzone-reservation-offline.mjs';
import {
  bindAuthorizedOwnNewQzoneComment,
  bindAuthorizedQzoneReply,
} from '../src/core/qzone-comment-binding-offline.mjs';
import {
  MAX_REPLY_EVIDENCE_ENTRIES,
  createQzoneReplyEvidenceStore,
} from '../src/core/qzone-reply-evidence-store-offline.mjs';

const NOW = Date.parse('2026-11-15T04:00:00Z');
const TARGET = '123';
const POST_ID = 'old_post_1';

// ══════════════════════════════════════════════════════════════════════════════════════════════
// FIXTURES: the trusted detail response and the state
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** One synthetic `get_detail`-shaped response: a post with ONE parent comment carrying ONE reply. */
function detailFor({
  postId = POST_ID, parentId = 'parent_1', parentQq = 456, parentName = 'Parent',
  replyId = 'reply_1', replyQq = 789, replyName = 'Reply Nick',
} = {}) {
  return {
    status: 'ok', retcode: 0,
    data: {
      tid: postId, content: 'synthetic post', comment_num: 1,
      comments: [{
        comment_id: parentId, uin: parentQq, name: parentName, time: NOW / 1000 - 10,
        content: 'synthetic parent',
        replies: [{
          comment_id: replyId, uin: replyQq, name: replyName, time: NOW / 1000 - 5,
          content: 'synthetic reply', parent_comment_id: parentId, parent_comment_uin: parentQq,
        }],
      }],
    },
  };
}

/**
 * The TRUSTED projection for a second-level reply, produced by the real binding function.
 * This is a FIXTURE input (synthetic detail), not platform evidence.
 */
function replyProjection(over = {}) {
  const detail = detailFor(over);
  const target = { author: over.target ?? TARGET, id: over.postId ?? POST_ID };
  const metadata = { author: target.author, id: target.id, time: NOW / 1000 };
  // t47: `admin` no longer authorizes anything; the `shared` exception names this exact post.
  const scope = { author: target.author, friend: false, sharedPostId: target.id, now: NOW };
  return bindAuthorizedQzoneReply(
    target, metadata, scope, detail,
    over.parentId ?? 'parent_1', over.replyId ?? 'reply_1',
  );
}

/** The TRUSTED projection for a FIRST-LEVEL comment (the bot's own new comment) — also a FIXTURE. */
function ownCommentProjection(over = {}) {
  const postId = over.postId ?? POST_ID;
  const commentId = over.commentId ?? 'parent_1';
  const target = { author: TARGET, id: postId };
  const event = { isNew: true, selfId: TARGET, author: TARGET, postId, commentId };
  return bindAuthorizedOwnNewQzoneComment(target, event, detailFor(over), commentId);
}

const baseState = (now = NOW) => ({
  enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
  selfId: TARGET,
  tools: { publish: true, comment: true, reply: true, like: true },
  limits: { post: 5, comment: 5, like: 5 },
  ledger: { day: beijingDay(now), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
  lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [],
  outcomes: {}, dispatchClaims: {}, notices: [], audit: [],
  // EMPTY, not absent: "no corroborating row" is the baseline, so every positive control has to
  // produce its row through `record()`.
  commentEvidence: [],
});

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qzone-reply-evidence-store-${label}-`));
}

function removeDir(t, dir) {
  t.after(() => {
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
    }
  });
}

/** A real temp SQLite file + the module under test over it. */
function world(t, { state = baseState(), maxEntries } = {}) {
  const dir = tempDir('world');
  removeDir(t, dir);
  const file = path.join(dir, 'state.db');
  const store = openOfflineStore(file, state);
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  const evidence = createQzoneReplyEvidenceStore(maxEntries === undefined ? { store } : { store, maxEntries });
  return { dir, file, store, evidence };
}

/** The reply request the host would issue, plus its matching audit intent. */
function replyCall({
  id = 'r1', target = TARGET, postId = POST_ID, commentId = 'parent_1',
  commentUin = 456, replyUin = 789, replyName = 'Reply Nick',
} = {}) {
  const replyParams = { comment_id: commentId, comment_uin: commentUin };
  if (replyUin !== null) { replyParams.reply_uin = replyUin; replyParams.reply_name = replyName; }
  return {
    request: { id, now: NOW, tool: 'reply', target, postId, commentId, source: 'qq', replyParams },
    intent: {
      time: NOW, source: 'qq', action: 'reply', target, postId, commentId,
      content: 'synthetic reply body', result: 'unknown',
    },
  };
}

/** Every field a refused reply must leave untouched. */
function costSnapshot(store) {
  const state = store.read();
  return {
    used: { ...state.ledger.used },
    lastCommentAt: state.lastCommentAt,
    commentTargets: JSON.parse(JSON.stringify(state.commentTargets)),
    reservations: Object.keys(state.ledger.reservations).sort(),
    auditLength: Array.isArray(state.audit) ? state.audit.length : -1,
    commentEvidence: JSON.parse(JSON.stringify(state.commentEvidence ?? [])),
  };
}

const rows = (store) => store.read().commentEvidence;

const EXPECTED_ROW = Object.freeze({
  target: TARGET, postId: POST_ID, commentId: 'parent_1',
  commentUin: '456', replyUin: '789', replyName: 'Reply Nick',
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// RES-1 — positive control: the trusted projection becomes exactly the row the gate reads
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('RES-1 可信投影 → record() → state.commentEvidence 得到六字段正确的一行（真实 SQLite）', async (t) => {
  const { file, store, evidence } = world(t);
  const projection = replyProjection();

  const result = evidence.record(projection, { now: NOW });
  assert.equal(result.written, true);
  assert.equal(result.duplicate, false);

  const stored = rows(store);
  assert.equal(stored.length, 1, '只写一行');
  assert.deepEqual(stored[0], { ...EXPECTED_ROW, at: NOW }, '六字段逐字段等于映射表的期望值，外加 at');
  assert.equal(Object.getPrototypeOf(stored[0]), Object.prototype, '是 plain object（不是 class 实例）');

  // 真实落盘：用一个独立的只读 handle 打开同一个文件仍然读得到（不是进程内内存态）。
  const reopened = openOfflineStoreReadOnly(file);
  try {
    const persisted = reopened.read().commentEvidence;
    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0], { ...EXPECTED_ROW, at: NOW });
  } finally { reopened.close(); }

  // `list()` 是只读副本，且过滤按 identity 三元组。
  const listed = evidence.list({ commentId: 'parent_1' });
  assert.equal(listed.length, 1);
  assert.ok(Object.isFrozen(listed) && Object.isFrozen(listed[0]));
  assert.deepEqual(listed[0], { ...EXPECTED_ROW, at: NOW });
  assert.equal(evidence.list({ commentId: 'nope' }).length, 0);

  // 投影里被校验但不入库的字段：`replyCommentId` 不是消费者需要的字段，写进去只会误导。
  assert.equal(Object.hasOwn(stored[0], 'replyCommentId'), false);
  assert.equal(Object.hasOwn(stored[0], 'parentCommentId'), false);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// RES-2 — end to end: the row this module wrote actually unlocks the reply gate
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('RES-2 写入后 reserveAuditedOfflineInteraction 的 reply 预留成功（行真能被消费者用）', async (t) => {
  const { store, evidence } = world(t);
  assert.equal(costSnapshot(store).used.comment, 0);

  evidence.record(replyProjection(), { now: NOW });

  const { request, intent } = replyCall();
  const reserved = reserveAuditedOfflineInteraction(store, request, intent);
  assert.equal(reserved.allowed, true, '有本模块写的行 ⇒ 预留放行');
  assert.equal(store.read().ledger.used.comment, 1, '放行时确实花掉一个 comment 配额');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// RES-3 — no row: refuse for free (this module is not a bypass for the gate)
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('RES-3 不调用 record() ⇒ missing_comment_evidence，且零消耗', async (t) => {
  const { store } = world(t);
  const before = costSnapshot(store);
  const { request, intent } = replyCall();
  const reserved = reserveAuditedOfflineInteraction(store, request, intent);
  assert.equal(reserved.allowed, false);
  assert.equal(reserved.reason, 'missing_comment_evidence');
  assert.deepEqual(costSnapshot(store), before, '拒绝不花配额、不推时钟、不写 audit');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// RES-4 — a row for a DIFFERENT identity never corroborates this reply
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('RES-4 写入的行与请求的 target/postId/commentId 不一致 ⇒ 拒绝，零消耗', async (t) => {
  // 4a: same post/parent, different post owner.
  {
    const { store, evidence } = world(t);
    evidence.record(replyProjection({ target: '999' }), { now: NOW });
    const before = costSnapshot(store);
    const { request, intent } = replyCall();
    assert.equal(reserveAuditedOfflineInteraction(store, request, intent).reason, 'missing_comment_evidence');
    assert.deepEqual(costSnapshot(store), before);
  }
  // 4b: same owner, different post.
  {
    const { store, evidence } = world(t);
    evidence.record(replyProjection({ postId: 'other_post' }), { now: NOW });
    const before = costSnapshot(store);
    const { request, intent } = replyCall();
    assert.equal(reserveAuditedOfflineInteraction(store, request, intent).reason, 'missing_comment_evidence');
    assert.deepEqual(costSnapshot(store), before);
  }
  // 4c: same triple, different PARENT AUTHOR -> the full-identity predicate must reject it.
  {
    const { store, evidence } = world(t);
    evidence.record(replyProjection({ parentQq: 111 }), { now: NOW });
    const before = costSnapshot(store);
    const { request, intent } = replyCall();
    assert.equal(reserveAuditedOfflineInteraction(store, request, intent).reason, 'comment_evidence_mismatch');
    assert.deepEqual(costSnapshot(store), before);
  }
  // 4d: same triple, different ADDRESSED-TO person -> also a mismatch, not a pass.
  {
    const { store, evidence } = world(t);
    evidence.record(replyProjection({ replyQq: 222, replyName: 'Someone Else' }), { now: NOW });
    const before = costSnapshot(store);
    const { request, intent } = replyCall();
    assert.equal(reserveAuditedOfflineInteraction(store, request, intent).reason, 'comment_evidence_mismatch');
    assert.deepEqual(costSnapshot(store), before);
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// RES-5 — the reply pair is a pair
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('RES-5 replyUin 有而 replyName 无（或相反）⇒ record() 拒绝，不写入', async (t) => {
  const { store, evidence } = world(t);
  const valid = replyProjection();
  // FORGED SHAPE (not a binding output): the binding can never emit a half pair — that is exactly
  // the shape error this module must catch before it reaches the gate.
  const halfName = Object.freeze({ ...valid, replyName: null });
  const halfUin = Object.freeze({ ...valid, replyQq: null });

  assert.throws(() => evidence.record(halfName, { now: NOW }), TypeError);
  assert.throws(() => evidence.record(halfUin, { now: NOW }), TypeError);
  assert.equal(rows(store).length, 0, '拒绝时一行都没写');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// RES-6 — the size cap: oldest-first eviction, and eviction may only ever REFUSE a reply
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('RES-6 超过条数上限 ⇒ 最旧优先淘汰，被淘汰的那条使 reply 被拒（零消耗）', async (t) => {
  const maxEntries = 3;
  const { store, evidence } = world(t, { maxEntries });
  const projections = [1, 2, 3, 4].map((i) => replyProjection({
    parentId: `p${i}`, parentQq: 500 + i, replyId: `r${i}`, replyQq: 700 + i, replyName: `N${i}`,
  }));
  for (const projection of projections) evidence.record(projection, { now: NOW });

  const stored = rows(store);
  assert.equal(stored.length, maxEntries, '条数不超过上限');
  assert.deepEqual(stored.map((row) => row.commentId), ['p2', 'p3', 'p4'], '淘汰最旧的三条里最早那条');

  // The evicted identity can no longer be corroborated: the gate refuses, and it refuses for free.
  const evicted = replyCall({ id: 'evicted', commentId: 'p1', commentUin: 501, replyUin: 701, replyName: 'N1' });
  const before = costSnapshot(store);
  assert.equal(reserveAuditedOfflineInteraction(store, evicted.request, evicted.intent).reason, 'missing_comment_evidence');
  assert.deepEqual(costSnapshot(store), before);

  // The newest row still works.
  const fresh = replyCall({ id: 'fresh', commentId: 'p4', commentUin: 504, replyUin: 704, replyName: 'N4' });
  assert.equal(reserveAuditedOfflineInteraction(store, fresh.request, fresh.intent).allowed, true);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// RES-7 — field-length caps
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('RES-7 字段长度超限 ⇒ 拒绝，不写入', async (t) => {
  const { store, evidence } = world(t);
  const valid = replyProjection();
  const cases = {
    'postId 129 字符': Object.freeze({ ...valid, postId: 'p'.repeat(129) }),
    'parentCommentId 129 字符': Object.freeze({ ...valid, parentCommentId: 'c'.repeat(129) }),
    'parentCommentId 含非法字符': Object.freeze({ ...valid, parentCommentId: 'c 1/../2' }),
    'replyName 257 字符': Object.freeze({ ...valid, replyName: 'n'.repeat(257) }),
    'replyName 空串': Object.freeze({ ...valid, replyName: '' }),
    'replyName 含控制字符': Object.freeze({ ...valid, replyName: 'a\nb' }),
    'parentQq 21 位': Object.freeze({ ...valid, parentQq: '1'.repeat(21) }),
    'parentQq 非规范形式 007': Object.freeze({ ...valid, parentQq: '007' }),
    'targetQq 非数字': Object.freeze({ ...valid, targetQq: 'abc' }),
  };
  for (const [name, projection] of Object.entries(cases)) {
    assert.throws(() => evidence.record(projection, { now: NOW }), TypeError, name);
  }
  assert.equal(rows(store).length, 0);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// RES-8 — transaction safety: one row per (target, postId, commentId)
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('RES-8 同一条记录写两次 ⇒ 不产生重复行（真实 store 事务内去重）', async (t) => {
  const { store, evidence } = world(t);
  const projection = replyProjection();

  assert.equal(evidence.record(projection, { now: NOW }).written, true);
  // AN EQUAL `now`: still a duplicate, and it must NOT touch the stored stamp. (A STRICTLY LATER
  // `now` deliberately DOES refresh `at` — that is the point of RES-13, and pinning the equal case
  // here is what keeps "not every duplicate moves the age basis" from being lost.)
  const second = evidence.record(projection, { now: NOW });
  assert.equal(second.written, false);
  assert.equal(second.duplicate, true, '幂等：第二次是重复而非新行');
  assert.equal(second.refreshed, false, '相等的 now 不得刷新 at（只有严格更晚才可以）');
  assert.equal(rows(store).length, 1, '仍然只有一行');
  assert.equal(rows(store)[0].at, NOW, '相等的 now 不改存量的 at');

  // Same triple but a CONTRADICTORY identity: refuse loudly and leave the stored row alone.
  const conflicting = replyProjection({ parentQq: 111 });
  let conflict;
  try { evidence.record(conflicting, { now: NOW }); } catch (error) { conflict = error; }
  assert.ok(conflict instanceof TypeError, '冲突必须抛 TypeError');
  assert.equal(conflict.code, 'EVIDENCE_KEY_CONFLICT');
  assert.equal(rows(store).length, 1, '冲突不写、不覆盖');
  assert.equal(rows(store)[0].commentUin, '456', '存量行原样保留');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// RES-9 — shape errors are refused (this is the guarantee the module can actually give)
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('RES-9 形状错误的输入 ⇒ 拒绝，不写入', async (t) => {
  const { store, evidence } = world(t);
  const valid = replyProjection();
  const bad = [
    ['裸 evidence 行（六字段，模型自报的形状）', { ...EXPECTED_ROW }],
    ['未冻结的拷贝', { ...valid }],
    ['少一个字段', Object.freeze(Object.fromEntries(Object.entries(valid).filter(([k]) => k !== 'parentQq')))],
    ['多一个字段', Object.freeze({ ...valid, extra: 'x' })],
    ['null', null],
    ['数组', Object.freeze([valid])],
    ['字符串', 'targetQq'],
    ['类实例', Object.freeze(Object.assign(new (class Projection {})(), valid))],
  ];
  for (const [name, projection] of bad) {
    assert.throws(() => evidence.record(projection, { now: NOW }), TypeError, name);
  }
  // Missing / malformed clock: refused before the store is touched.
  assert.throws(() => evidence.record(valid), TypeError);
  assert.throws(() => evidence.record(valid, {}), TypeError);
  assert.throws(() => evidence.record(valid, { now: 'now' }), TypeError);
  assert.equal(rows(store).length, 0);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// RES-10 — the OTHER trusted projection (first-level own comment) maps to a null reply pair
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('RES-10 一级评论投影 → replyUin/replyName 同为 null，且能放行不带 reply 对的 reply', async (t) => {
  const { store, evidence } = world(t);
  const written = evidence.record(ownCommentProjection(), { now: NOW });
  assert.equal(written.written, true);
  const stored = rows(store);
  assert.deepEqual(stored[0], {
    target: TARGET, postId: POST_ID, commentId: 'parent_1',
    commentUin: '456', replyUin: null, replyName: null, at: NOW,
  });
  // `commentName` 有意不入库：消费者没有这个字段，存它只是多一份无关昵称。
  assert.equal(Object.hasOwn(stored[0], 'commentName'), false);

  const { request, intent } = replyCall({ id: 'first-level', replyUin: null });
  assert.equal(reserveAuditedOfflineInteraction(store, request, intent).allowed, true);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// RES-11 — lifecycle: prune by an explicit, caller-supplied clock; foreign rows retained
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('RES-11 prune 按调用方时钟做显式清理，无法解读（无 at）的外来行保留', async (t) => {
  const { store, evidence } = world(t);
  evidence.record(replyProjection({ parentId: 'old', parentQq: 456 }), { now: NOW });
  evidence.record(replyProjection({ parentId: 'new', parentQq: 456 }), { now: NOW + 60000 });
  // FOREIGN row (not written by this module): seeded so the "keep what we cannot read" rule is real.
  store.update((state) => ({ ...state, commentEvidence: [...state.commentEvidence, { target: TARGET, postId: POST_ID, commentId: 'foreign' }] }));

  // cutoff = (NOW+100000) - 60000 = NOW+40000: the first row is older, the second is not.
  assert.deepEqual(evidence.prune({ now: NOW + 100000, maxAgeMs: 60000 }), { removed: 1 });
  const remaining = rows(store).map((row) => row.commentId).sort();
  assert.deepEqual(remaining, ['foreign', 'new'], '旧行被清、新行保留、无 at 的外来行保留');

  assert.throws(() => evidence.prune({ now: NOW }), TypeError);
  assert.throws(() => evidence.prune({ now: NOW, maxAgeMs: -1 }), TypeError);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// RES-12 — the default cap is a real positive bound (not "unbounded, documented as bounded")
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('RES-12 默认上限是有限正整数，且 maxEntries 可收紧但不可放大成无界', async (t) => {
  assert.equal(Number.isSafeInteger(MAX_REPLY_EVIDENCE_ENTRIES), true);
  assert.ok(MAX_REPLY_EVIDENCE_ENTRIES >= 100 && MAX_REPLY_EVIDENCE_ENTRIES <= 100000);

  const { store } = world(t);
  assert.throws(() => createQzoneReplyEvidenceStore({ store, maxEntries: 0 }), TypeError);
  assert.throws(() => createQzoneReplyEvidenceStore({ store, maxEntries: Number.POSITIVE_INFINITY }), TypeError);
  assert.throws(() => createQzoneReplyEvidenceStore({}), TypeError, '缺 store');
  assert.throws(() => createQzoneReplyEvidenceStore({ store: { update() {} } }), TypeError, '缺 read()');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// RES-13 — a REAL re-read refreshes the age basis, so the same comment does not expire forever
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// THE DEFECT THIS PINS: a duplicate used to return `duplicate:true` and leave `at` untouched. So once
// a row aged past the enforcement window, every later genuine read of the SAME comment was still a
// "duplicate", the stale stamp stayed, and the reply gate refused that comment for ever — until
// somebody called `prune` by hand. Nothing about a re-read could renew it.
//
// The fix refreshes the DERIVED `at` (never the identity) when the trusted `now` is STRICTLY later.
// A test that only asserted `refreshed:true` would not show the refresh is worth anything, so this
// case also drives the real consumer: the reservation must ACCEPT the refreshed row at a time when
// the un-refreshed row is refused.
test('RES-13 真实读取两次、时间前进 ⇒ 刷新 at 后能通过预留时效检查（不刷新则过期）', async (t) => {
  const { store, evidence } = world(t);
  const maxAgeMs = DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS;
  const T0 = NOW;
  const T1 = T0 + maxAgeMs + 1;          // one ms past the window: the T0 row is now expired

  // ── first real read ──
  const first = evidence.record(replyProjection(), { now: T0 });
  assert.equal(first.written, true, '第一次是写入');
  assert.equal(first.refreshed, false, '写入不是刷新');
  assert.equal(rows(store)[0].at, T0, 'at 取第一次的 now');

  // Precondition, measured rather than assumed: at T1 the UNREFRESHED row is refused. This is the
  // control the refresh has to beat — without it, "the reservation allowed" would prove nothing.
  const { request: staleRequest, intent: staleIntent } = replyCall();
  const stale = reserveAuditedOfflineInteraction(
    store,
    { ...staleRequest, now: T1, maxAgeMs },
    { ...staleIntent, time: T1 },
  );
  assert.equal(stale.allowed, false, '对照：未刷新的旧行在 T1 必须被拒');
  assert.equal(stale.reason, 'evidence-expired', '对照：理由正是过期');
  assert.equal(store.read().ledger.used.comment, 0, '对照：拒绝零消耗');

  // ── second real read of the SAME comment, later ──
  const second = evidence.record(replyProjection(), { now: T1 });
  assert.equal(second.written, false, '同一身份不新增行');
  assert.equal(second.duplicate, true, '仍然是重复');
  assert.equal(second.refreshed, true, '★ 严格更晚的 now ⇒ 刷新（与 duplicate 可区分）');
  assert.equal(rows(store).length, 1, '★ 刷新不产生第二行');
  assert.equal(rows(store)[0].at, T1, '★ at 已推进到 T1');
  assert.equal(rows(store)[0].commentUin, '456', '刷新只动 at，身份字段一字不动');

  // ── and the consumer now ACCEPTS it ──
  const { request, intent } = replyCall();
  const afterRefresh = reserveAuditedOfflineInteraction(
    store,
    { ...request, now: T1, maxAgeMs },
    { ...intent, time: T1 },
  );
  assert.equal(afterRefresh.allowed, true, '★ 刷新后同一预留放行（刷新对消费端真的有效）');
  assert.equal(store.read().ledger.used.comment, 1, '放行时才花配额');

  // ── CLOCK DIRECTION IS ONE-WAY: an EARLIER now must not move `at` back ──
  const backwards = evidence.record(replyProjection(), { now: T0 });
  assert.equal(backwards.refreshed, false, '★ 更早的 now 不得刷新（否则回拨时钟可延长证据寿命）');
  assert.equal(rows(store)[0].at, T1, '★ at 仍是 T1，没有被倒退');
  assert.equal(rows(store).length, 1);

  // Equal `now` is also a no-op (pinned in RES-8 as well; repeated here because this case owns the
  // T1 baseline the two directions are compared against).
  const equal = evidence.record(replyProjection(), { now: T1 });
  assert.equal(equal.refreshed, false, '相等的 now 不刷新');
  assert.equal(rows(store)[0].at, T1);

  // ── no trusted `now` ⇒ refused outright, nothing written or refreshed ──
  for (const badOptions of [undefined, {}, { now: -1 }, { now: 1.5 }, { now: '5' }, { now: Number.NaN }]) {
    assert.throws(() => evidence.record(replyProjection(), badOptions), TypeError,
      `无可信 now 必须拒绝: ${JSON.stringify(badOptions)}`);
  }
  assert.equal(rows(store).length, 1, '这些拒绝没有写任何行');
  assert.equal(rows(store)[0].at, T1, '这些拒绝也没有改动 at');
});
