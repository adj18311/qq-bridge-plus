// Tests for the CONSUMER-SIDE evidence gate (`qzone-reply-evidence-consumer-offline.mjs`).
//
// ⚠️⚠️ WHAT THESE TESTS DO **NOT** PROVE — READ FIRST ⚠️⚠️
// ---------------------------------------------------------
//   · Every `state.commentEvidence` row used here is a **FIXTURE SEED**. The trusted-looking
//     projections come from `bindAuthorizedQzoneReply` called on a SYNTHETIC detail payload: no
//     platform was contacted, and no row in this file came from a real read. The other rows are
//     written straight into the store to pin the age rules (an undated row can only be a foreign
//     writer's row — `record()` always writes an `at`).
//   · The module under test is **PREPARATORY WORK, not "item 2 complete"**. It checks a database
//     row's shape and age. It cannot prove the row came from a platform read, and nothing in `src/`
//     calls the producer (`qzone-reply-evidence-store-offline.mjs#record`) today. A green test run
//     therefore proves the GATE is correct, not that replies are protected in production.
//   · Nothing here calls a network, QQ, the bridge, or any config. Real temp SQLite files only.
//
// WHAT THESE TESTS DO PIN
// -----------------------
//   REC-1  positive control: a fresh row passes `check()`, and the reservation that follows ALSO
//          allows (consistency, positive direction) — one quota unit, as expected.
//   REC-2  an EXPIRED row is refused with `evidence-expired`, and the reservation is never called
//          (measured: zero `store.update` calls, quota untouched).
//   REC-2b the COMPANION case, and it now points the other way: the reservation ALSO refuses that
//          same expired row, inside its own transaction (`evidence-expired`, still zero cost). Age is
//          no longer something only this consumer checks. The case is kept — inverted, not deleted —
//          because "the reservation is authoritative about age too" is the fact worth pinning, and
//          because its HISTORY comment records what the old, weaker arrangement actually did.
//   REC-3  a row with NO `at` is refused (`evidence-undated`) — never treated as "never expires".
//   REC-4  a malformed `at` (negative / float / string / NaN) is refused (`evidence-invalid-at`).
//   REC-5  a FUTURE `at` is refused (`evidence-future-dated`) — a negative age is not measurable.
//   REC-6  identity mismatch: no row for the triple (`missing_comment_evidence`), and a row for the
//          triple whose `commentUin`/`replyUin`/`replyName` disagree (`comment_evidence_mismatch`),
//          each matching what the reservation returns for the same state.
//   REC-7  every refusal path is ZERO-COST: `used.comment`, `lastCommentAt`, `commentTargets`,
//          the reservation map and `audit` are byte-identical, and `check()` performed no write.
//   REC-8  the age boundary is the CLOSED interval [0, maxAgeMs] (`age === maxAgeMs` passes,
//          `age === maxAgeMs + 1` fails), and `check()` refuses rather than throws on a bad clock,
//          an unreadable collection and a missing reply identity.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { reserveAuditedOfflineInteraction } from '../src/core/qzone-reservation-offline.mjs';
import { bindAuthorizedQzoneReply } from '../src/core/qzone-comment-binding-offline.mjs';
import { createQzoneReplyEvidenceStore } from '../src/core/qzone-reply-evidence-store-offline.mjs';
import {
  REPLY_EVIDENCE_CONSUMER_REASONS as R,
  createQzoneReplyEvidenceConsumer,
} from '../src/core/qzone-reply-evidence-consumer-offline.mjs';

const NOW = Date.parse('2026-11-15T04:00:00Z');
const MAX_AGE_MS = 10 * 60 * 1000;   // 10 minutes: tight enough that "fresh" and "old" never blur
const TARGET = '123';
const POST_ID = 'old_post_1';
const COMMENT_ID = 'parent_1';

// ══════════════════════════════════════════════════════════════════════════════════════════════
// FIXTURES — synthetic detail response, trusted projection, state
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** One synthetic `get_detail`-shaped envelope: a post with ONE parent comment carrying ONE reply. */
function detailFor({
  postId = POST_ID, parentId = COMMENT_ID, parentQq = 456, parentName = 'Parent',
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
 * The reply-shaped TRUSTED projection, produced by a real call to `bindAuthorizedQzoneReply`.
 * FIXTURE INPUT: the detail payload above is synthetic, so this is NOT platform evidence.
 */
function replyProjection(over = {}) {
  const target = { author: over.target ?? TARGET, id: over.postId ?? POST_ID };
  const detail = detailFor(over);
  const metadata = { author: target.author, id: target.id, time: NOW / 1000 };
  // t47: `admin` no longer authorizes anything; the `shared` exception names this exact post.
  const scope = { author: target.author, friend: false, sharedPostId: target.id, now: NOW };
  return bindAuthorizedQzoneReply(
    target, metadata, scope, detail,
    over.parentId ?? COMMENT_ID, over.replyId ?? 'reply_1',
  );
}

const baseState = (now = NOW) => ({
  enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
  selfId: TARGET,
  tools: { publish: true, comment: true, reply: true, like: true },
  limits: { post: 5, comment: 5, like: 5 },
  ledger: { day: beijingDay(now), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
  lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [],
  outcomes: {}, dispatchClaims: {}, notices: [], audit: [],
  commentEvidence: [],
});

/** The reply request + its audit intent, exactly as the write path shapes them. */
function replyCall({
  id = 'r1', target = TARGET, postId = POST_ID, commentId = COMMENT_ID,
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

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qzone-reply-evidence-consumer-${label}-`));
}

function removeDir(t, dir) {
  t.after(() => {
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
    }
  });
}

/**
 * A real temp SQLite file, wrapped in a DELEGATING handle that counts `update()` calls.
 *
 * The wrapper is the documented composition in `qzone-store-offline.mjs` (`{ ...store, update }`
 * inherits the send authority). Counting updates is how "the reservation was NOT called" is proved
 * as an observation instead of a comment: `check()` must leave the counter at 0.
 */
function world(t, { state = baseState(), maxAgeMs = MAX_AGE_MS, clock = () => NOW } = {}) {
  const dir = tempDir('world');
  removeDir(t, dir);
  const file = path.join(dir, 'state.db');
  const inner = openOfflineStore(file, state);
  t.after(() => { try { inner.close(); } catch { /* already closed */ } });
  let updates = 0;
  const store = {
    ...inner,
    update(fn) { updates += 1; return inner.update(fn); },
  };
  const producer = createQzoneReplyEvidenceStore({ store });
  const consumer = createQzoneReplyEvidenceConsumer({ store, clock, maxAgeMs });
  return { dir, file, inner, store, producer, consumer, updates: () => updates };
}

/** Everything a refused reply must leave untouched. */
function costSnapshot(store) {
  const state = store.read();
  return {
    used: { ...state.ledger.used },
    lastCommentAt: state.lastCommentAt,
    commentTargets: JSON.parse(JSON.stringify(state.commentTargets)),
    reservations: Object.keys(state.ledger.reservations).sort(),
    auditLength: Array.isArray(state.audit) ? state.audit.length : -1,
  };
}

/** Seed a FOREIGN-format row directly. Used ONLY where `record()` cannot produce the shape. */
function seedRow(store, row) {
  store.update((state) => ({ ...state, commentEvidence: [...(state.commentEvidence ?? []), row] }));
}

const EXPECTED_ROW = Object.freeze({
  target: TARGET, postId: POST_ID, commentId: COMMENT_ID,
  commentUin: '456', replyUin: '789', replyName: 'Reply Nick',
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// REC-1 — positive control, and consistency in the ALLOW direction
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('REC-1 未过期行 ⇒ check() 通过 ⇒ 紧接着 reserveAuditedOfflineInteraction 也放行（正控一致性）', (t) => {
  const { store, producer, consumer } = world(t);

  // Written through the REAL producer from a trusted-shaped (but synthetic) projection.
  assert.equal(producer.record(replyProjection(), { now: NOW - 1000 }).written, true);

  const before = costSnapshot(store);
  const decision = consumer.check({
    target: TARGET, postId: POST_ID, commentId: COMMENT_ID, replyParams: replyCall().request.replyParams,
  });

  assert.equal(decision.ok, true, `check() 通过：${decision.reason ?? ''}`);
  assert.equal(decision.at, NOW - 1000, '返回的是实际读到的 at');
  assert.equal(decision.ageMs, 1000);
  assert.equal(decision.maxAgeMs, MAX_AGE_MS);
  assert.ok(Object.isFrozen(decision));
  // A PRE-gate must be free: checking is not reserving.
  assert.deepEqual(costSnapshot(store), before, 'check() 本身零消耗（不花配额、不写 audit）');

  const { request, intent } = replyCall();
  const reserved = reserveAuditedOfflineInteraction(store, request, intent);
  assert.equal(reserved.allowed, true, 'check() 通过 ⇒ 预留器必须也放行');
  assert.equal(store.read().ledger.used.comment, 1, '放行时确实花掉一个 comment 配额');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// REC-1b — same consistency, for the COMMENT-shaped row (reply to the thread, no reply pair)
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('REC-1b 一级评论形状的行（replyUin/replyName 同为 null）⇒ check() 通过 ⇒ 预留器也放行', (t) => {
  const { store, producer, consumer } = world(t);

  // The comment-shaped projection: a first-level comment addresses the thread, so the pair is
  // null/null. This is the case where a half-pair normalisation would silently diverge, hence the
  // separate control.
  const projection = replyProjection();
  const commentShaped = Object.freeze({
    targetQq: projection.targetQq, postId: projection.postId,
    commentId: projection.parentCommentId,
    commentQq: projection.parentQq, commentName: 'Parent',
  });
  assert.equal(producer.record(commentShaped, { now: NOW - 2000 }).written, true);

  const replyParams = { comment_id: COMMENT_ID, comment_uin: 456 };   // no reply pair at all
  const decision = consumer.check({
    target: TARGET, postId: POST_ID, commentId: COMMENT_ID, replyParams,
  });
  assert.equal(decision.ok, true, `check() 通过：${decision.reason ?? ''}`);
  assert.equal(decision.ageMs, 2000);

  const { intent } = replyCall();
  const reserved = reserveAuditedOfflineInteraction(
    store,
    { id: 'r1b', now: NOW, tool: 'reply', target: TARGET, postId: POST_ID, commentId: COMMENT_ID, source: 'qq', replyParams },
    intent,
  );
  assert.equal(reserved.allowed, true, 'check() 通过 ⇒ 预留器必须也放行');
  assert.equal(store.read().ledger.used.comment, 1);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// REC-2 — expiry is refused HERE, and the reservation is never called
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('REC-2 过期行 ⇒ check() 拒绝 evidence-expired，且不调用预留器（配额未花）', (t) => {
  const { store, producer, consumer, updates } = world(t);

  // One millisecond past the window. Written by the REAL producer with an OLD `now`, i.e. an
  // honestly time-stamped but stale row — exactly what a delayed/forgotten read would leave behind.
  assert.equal(producer.record(replyProjection(), { now: NOW - MAX_AGE_MS - 1 }).written, true);

  const before = costSnapshot(store);
  const updatesBefore = updates();

  const { request } = replyCall();
  const decision = consumer.check({
    target: TARGET, postId: POST_ID, commentId: COMMENT_ID, replyParams: request.replyParams,
  });

  assert.equal(decision.ok, false);
  assert.equal(decision.reason, R.EVIDENCE_EXPIRED, '理由必须明确是过期（不是笼统的 mismatch）');
  assert.equal(decision.ageMs, MAX_AGE_MS + 1);
  assert.equal(decision.maxAgeMs, MAX_AGE_MS);

  // THE POINT: a refused pre-check means the reservation is never entered, so nothing is spent.
  assert.equal(updates(), updatesBefore, '拒绝时不得调用预留器（store.update 次数不变）');
  assert.deepEqual(costSnapshot(store), before, '拒绝零消耗：used.comment / lastCommentAt / audit 全部不变');
  assert.equal(store.read().ledger.used.comment, 0);
  assert.equal(store.read().lastCommentAt, null);

  // Not a throw: a pre-gate returns a decision.
  assert.ok(Object.isFrozen(decision));
});

test('REC-2b 预留器自己也查 at：同一条过期行在预留事务内被拒且零消耗', (t) => {
  const { store, producer } = world(t);
  assert.equal(producer.record(replyProjection(), { now: NOW - MAX_AGE_MS - 1 }).written, true);

  // HISTORY: this case used to assert the OPPOSITE — that the reservation layer ignored `at`, so an
  // expired row still reserved and spent a unit. That was true, and it was exactly why a separate
  // pre-flight gate was the only place age could bite. The age check now lives INSIDE
  // `reserveAuditedOfflineInteraction`'s own `store.update`, before `reserveOfflineInteraction`, so
  // the same expired row is refused there and costs nothing. The assertion is inverted rather than
  // deleted, because "the reservation is now authoritative about age" is the fact worth pinning.
  const { request, intent } = replyCall();
  const reserved = reserveAuditedOfflineInteraction(store, request, intent);

  assert.equal(reserved.allowed, false, '★ 过期行在预留事务内就被拒 —— 时效已由预留器自己执行');
  assert.equal(reserved.reason, 'evidence-expired', '★ 拒绝理由是过期，不是"缺失"或"不匹配"');
  assert.equal(store.read().ledger.used.comment, 0, '★ 零消耗：拒绝发生在 reserveWrite 之前');
  assert.equal(store.read().lastCommentAt, null, '★ 无冷却');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// REC-3 — no `at` is NOT "never expires"
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('REC-3 无 at 的行（外部写入/旧格式）⇒ 拒绝 evidence-undated，绝不当成永不过期', (t) => {
  const { store, consumer, updates } = world(t);
  // A foreign/legacy row: identity agrees, but it carries no `at`. `record()` can never produce
  // this shape, so it is seeded directly.
  seedRow(store, { ...EXPECTED_ROW });

  const before = costSnapshot(store);
  const updatesBefore = updates();
  const { request } = replyCall();
  const decision = consumer.check({
    target: TARGET, postId: POST_ID, commentId: COMMENT_ID, replyParams: request.replyParams,
  });

  assert.equal(decision.ok, false);
  assert.equal(decision.reason, R.EVIDENCE_UNDATED);
  assert.equal(updates(), updatesBefore, '不调用预留器');
  assert.deepEqual(costSnapshot(store), before, '零消耗');
  assert.equal(store.read().ledger.used.comment, 0);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// REC-4 — a malformed `at` is refused, never coerced
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('REC-4 at 非法（负数/浮点/字符串/NaN/Infinity）⇒ 拒绝 evidence-invalid-at，零消耗', (t) => {
  const badValues = [-1, -NOW, 1.5, NOW + 0.25, String(NOW), 'now', NaN, Infinity, -Infinity, true, {}, []];
  for (const bad of badValues) {
    const { store, consumer, updates } = world(t);
    seedRow(store, { ...EXPECTED_ROW, at: bad });

    const before = costSnapshot(store);
    const updatesBefore = updates();
    const { request } = replyCall();
    const decision = consumer.check({
      target: TARGET, postId: POST_ID, commentId: COMMENT_ID, replyParams: request.replyParams,
    });

    const label = typeof bad === 'number' ? String(bad) : JSON.stringify(bad);
    assert.equal(decision.ok, false, `at=${label} 必须被拒绝`);
    assert.equal(decision.reason, R.EVIDENCE_INVALID_AT, `at=${label} 的理由`);
    assert.equal(updates(), updatesBefore, `at=${label}：不调用预留器`);
    assert.deepEqual(costSnapshot(store), before, `at=${label}：零消耗`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// REC-5 — a future `at` is not clamped, it is refused
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('REC-5 at 在未来 ⇒ 拒绝 evidence-future-dated（负的 age 不可测量），零消耗', (t) => {
  const { store, consumer, updates } = world(t);
  seedRow(store, { ...EXPECTED_ROW, at: NOW + 1 });

  const before = costSnapshot(store);
  const updatesBefore = updates();
  const { request } = replyCall();
  const decision = consumer.check({
    target: TARGET, postId: POST_ID, commentId: COMMENT_ID, replyParams: request.replyParams,
  });

  assert.equal(decision.ok, false);
  assert.equal(decision.reason, R.EVIDENCE_FUTURE_DATED);
  assert.equal(decision.ageMs, -1);
  assert.equal(updates(), updatesBefore);
  assert.deepEqual(costSnapshot(store), before);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// REC-6 — identity: absent triple, and full-match failure, both agreeing with the reservation
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('REC-6 身份不匹配 ⇒ missing_comment_evidence / comment_evidence_mismatch，与预留器结论一致', (t) => {
  // 6a: the triple is absent -> same string the reservation produces, and the reservation agrees.
  {
    const { store, consumer, updates } = world(t);
    // A row for a DIFFERENT comment exists; it must not corroborate this one.
    seedRow(store, { ...EXPECTED_ROW, commentId: 'parent_other', at: NOW });

    const before = costSnapshot(store);
    const updatesBefore = updates();
    const { request, intent } = replyCall();
    const decision = consumer.check({
      target: TARGET, postId: POST_ID, commentId: COMMENT_ID, replyParams: request.replyParams,
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, R.MISSING_EVIDENCE);
    assert.equal(updates(), updatesBefore, '6a：不调用预留器');
    assert.deepEqual(costSnapshot(store), before);

    const reserved = reserveAuditedOfflineInteraction(store, request, intent);
    assert.equal(reserved.allowed, false);
    assert.equal(reserved.reason, R.MISSING_EVIDENCE, '6a：预留器给同一个理由');
    assert.equal(store.read().ledger.used.comment, 0);
  }

  // 6b: the triple is present but the parent author disagrees -> full-match failure.
  {
    const { store, producer, consumer, updates } = world(t);
    producer.record(replyProjection({ parentQq: 111 }), { now: NOW - 1000 });

    const before = costSnapshot(store);
    const updatesBefore = updates();
    const { request, intent } = replyCall();
    const decision = consumer.check({
      target: TARGET, postId: POST_ID, commentId: COMMENT_ID, replyParams: request.replyParams,
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, R.EVIDENCE_MISMATCH, '6b：全量匹配失败');
    assert.equal(updates(), updatesBefore, '6b：不调用预留器');
    assert.deepEqual(costSnapshot(store), before);

    const reserved = reserveAuditedOfflineInteraction(store, request, intent);
    assert.equal(reserved.allowed, false);
    assert.equal(reserved.reason, R.EVIDENCE_MISMATCH, '6b：预留器给同一个理由');
    assert.equal(store.read().ledger.used.comment, 0);
  }

  // 6c: the addressed-to person disagrees -> mismatch, not a pass.
  {
    const { store, producer, consumer } = world(t);
    producer.record(replyProjection({ replyQq: 222, replyName: 'Someone Else' }), { now: NOW - 1000 });
    const { request } = replyCall();
    const decision = consumer.check({
      target: TARGET, postId: POST_ID, commentId: COMMENT_ID, replyParams: request.replyParams,
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, R.EVIDENCE_MISMATCH);
    assert.equal(store.read().ledger.used.comment, 0);
  }

  // 6d: two rows for one comment -> ambiguous; picking one would guess which AGE applies.
  {
    const { store, consumer } = world(t);
    seedRow(store, { ...EXPECTED_ROW, at: NOW });
    seedRow(store, { ...EXPECTED_ROW, at: NOW - 1000 });
    const { request } = replyCall();
    const decision = consumer.check({
      target: TARGET, postId: POST_ID, commentId: COMMENT_ID, replyParams: request.replyParams,
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, R.EVIDENCE_MISMATCH);
    assert.equal(decision.candidates, 2);
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// REC-7 — every refusal path is zero-cost (gathered in one place, so a new early-return cannot
//          quietly start writing)
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('REC-7 所有拒绝路径都零消耗且不写库（含构造/时钟/请求形状错误）', (t) => {
  const cases = [
    ['过期', () => { const w = world(t); seedRow(w.store, { ...EXPECTED_ROW, at: NOW - MAX_AGE_MS - 1 }); return w; }],
    ['无 at', () => { const w = world(t); seedRow(w.store, { ...EXPECTED_ROW }); return w; }],
    ['at 非法', () => { const w = world(t); seedRow(w.store, { ...EXPECTED_ROW, at: 'not-a-time' }); return w; }],
    ['未来', () => { const w = world(t); seedRow(w.store, { ...EXPECTED_ROW, at: NOW + 99999 }); return w; }],
    ['无证据', () => world(t)],
    ['重复证据', () => { const w = world(t); seedRow(w.store, { ...EXPECTED_ROW, at: NOW }); seedRow(w.store, { ...EXPECTED_ROW, at: NOW }); return w; }],
  ];

  for (const [label, build] of cases) {
    const { store, consumer, updates } = build();
    const before = costSnapshot(store);
    const updatesBefore = updates();
    const { request } = replyCall();
    const decision = consumer.check({
      target: TARGET, postId: POST_ID, commentId: COMMENT_ID, replyParams: request.replyParams,
    });
    assert.equal(decision.ok, false, `${label} 必须被拒绝`);
    assert.equal(updates(), updatesBefore, `${label}：不得调用预留器`);
    assert.deepEqual(costSnapshot(store), before, `${label}：状态字节级不变`);
    assert.equal(store.read().ledger.used.comment, 0, `${label}：配额未动`);
    assert.equal(store.read().lastCommentAt, null, `${label}：评论时钟未动`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// REC-8 — boundary + refusal-not-throw for the remaining refusal classes
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('REC-8 age 边界为闭区间 [0, maxAgeMs]；其余异常形状一律返回拒绝而不是抛错', (t) => {
  // 8a: age === maxAgeMs is INSIDE the window.
  {
    const { store, consumer } = world(t);
    seedRow(store, { ...EXPECTED_ROW, at: NOW - MAX_AGE_MS });
    const { request } = replyCall();
    assert.equal(consumer.check({
      target: TARGET, postId: POST_ID, commentId: COMMENT_ID, replyParams: request.replyParams,
    }).ok, true, 'age 恰好等于上限 ⇒ 通过');
  }
  // 8b: one millisecond past the window fails.
  {
    const { store, consumer } = world(t);
    seedRow(store, { ...EXPECTED_ROW, at: NOW - MAX_AGE_MS - 1 });
    const { request } = replyCall();
    assert.equal(consumer.check({
      target: TARGET, postId: POST_ID, commentId: COMMENT_ID, replyParams: request.replyParams,
    }).reason, R.EVIDENCE_EXPIRED);
  }
  // 8c: a clock that throws or lies is a REFUSAL, not an exception.
  {
    for (const clock of [() => NaN, () => -1, () => 1.5, () => { throw new Error('boom'); }]) {
      const { store, consumer } = world(t, { clock });
      seedRow(store, { ...EXPECTED_ROW, at: NOW });
      const { request } = replyCall();
      const decision = consumer.check({
        target: TARGET, postId: POST_ID, commentId: COMMENT_ID, replyParams: request.replyParams,
      });
      assert.equal(decision.ok, false);
      assert.equal(decision.reason, R.CLOCK_INVALID);
    }
  }
  // 8d: an unreadable `commentEvidence` collection is refused, never silently treated as empty
  //     (an empty read would also be refused, but for the DISHONEST reason `missing_comment_evidence`).
  {
    const { store, consumer } = world(t);
    store.update((state) => ({ ...state, commentEvidence: 'not-an-array' }));
    const { request } = replyCall();
    const decision = consumer.check({
      target: TARGET, postId: POST_ID, commentId: COMMENT_ID, replyParams: request.replyParams,
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, R.EVIDENCE_STORE_UNREADABLE);
  }
  // 8e: a reply whose identity was never stated is refused — the pre-gate has no lenient path.
  {
    const { store, consumer } = world(t);
    seedRow(store, { ...EXPECTED_ROW, at: NOW });
    assert.equal(consumer.check({ target: TARGET, postId: POST_ID, commentId: COMMENT_ID }).reason,
      R.REPLY_IDENTITY_REQUIRED);
    assert.equal(consumer.check({
      target: TARGET, postId: POST_ID, commentId: COMMENT_ID, replyParams: null,
    }).reason, R.REPLY_IDENTITY_REQUIRED);
    // Half a reply pair names nobody, so it is invalid rather than "reply to the thread".
    assert.equal(consumer.check({
      target: TARGET, postId: POST_ID, commentId: COMMENT_ID,
      replyParams: { comment_id: COMMENT_ID, comment_uin: 456, reply_uin: 789 },
    }).reason, R.REPLY_IDENTITY_INVALID);
    // `comment_id` must name the same comment the request reserves against.
    assert.equal(consumer.check({
      target: TARGET, postId: POST_ID, commentId: COMMENT_ID,
      replyParams: { comment_id: 'other_comment', comment_uin: 456 },
    }).reason, R.REPLY_IDENTITY_MISMATCH);
  }
  // 8f: a request that could never become a valid audit intent is refused for free.
  {
    const { store, consumer } = world(t);
    seedRow(store, { ...EXPECTED_ROW, at: NOW });
    const { request } = replyCall();
    for (const bad of [
      { target: 'not-a-qq', postId: POST_ID, commentId: COMMENT_ID, replyParams: request.replyParams },
      { target: TARGET, postId: 'bad id!', commentId: COMMENT_ID, replyParams: request.replyParams },
      { target: TARGET, postId: POST_ID, commentId: 'bad id!', replyParams: request.replyParams },
      null,
    ]) {
      assert.equal(consumer.check(bad).reason, R.INVALID_REQUEST);
    }
  }
  // 8g: construction refuses the dependencies it cannot work without (no hidden defaults).
  {
    const { store } = world(t);
    assert.throws(() => createQzoneReplyEvidenceConsumer({ clock: () => NOW, maxAgeMs: MAX_AGE_MS }), TypeError);
    assert.throws(() => createQzoneReplyEvidenceConsumer({ store, maxAgeMs: MAX_AGE_MS }), TypeError, '缺 clock');
    assert.throws(() => createQzoneReplyEvidenceConsumer({ store, clock: () => NOW }), TypeError, '缺 maxAgeMs');
    assert.throws(() => createQzoneReplyEvidenceConsumer({ store, clock: () => NOW, maxAgeMs: -1 }), TypeError);
    assert.throws(() => createQzoneReplyEvidenceConsumer({ store, clock: () => NOW, maxAgeMs: 1.5 }), TypeError);
    // The read-only export handle cannot be the reservation store, so it is not a valid gate store.
    assert.throws(() => createQzoneReplyEvidenceConsumer({
      store: { read: () => ({}) }, clock: () => NOW, maxAgeMs: MAX_AGE_MS,
    }), TypeError, '缺 update()');
  }
});
