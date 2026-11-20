// B3 REPLY-EVIDENCE AGE — enforced INSIDE the one real reservation transaction.
//
// WHY THIS FILE EXISTS
// --------------------
// `reserveAuditedOfflineInteraction` used to check only WHICH comment the evidence describes
// (identity triple + `matchesReplyEvidence`); it never looked at WHEN that row was recorded. An age
// check living anywhere else — the consumer's `check()`, a pre-flight — runs in a DIFFERENT
// transaction, so between "fresh" and "spent" the row can be replaced or aged out, and no separate
// transaction can make "this evidence is still fresh" true OF THE LAYER THAT SPENDS THE QUOTA.
//
// The rule therefore lives in the SAME `store.update` as the identity rule and the quota spend. This
// file pins the three states of that rule against a REAL SQLite file, the REAL reservation function,
// and the REAL quota/cooldown/audit state:
//
//   fresh   (`at = now - 1000`)              ⇒ allowed, exactly one comment unit spent
//   expired (`at = now - maxAgeMs - 1`)      ⇒ `evidence-expired`,  NOTHING moves
//   undated (no `at` at all)                 ⇒ `evidence-undated`,  NOTHING moves
//
// "NOTHING moves" is asserted on five separate surfaces on purpose (quota, cooldown clock, the
// per-target list, the reservation map, the audit array). A refusal that spends a unit is not a
// refusal, and a refusal that starts a 3-minute cooldown is a PUNISHMENT for asking — both were real
// hazards on this path (`qzone-write-path-offline.mjs:842-846`).
//
// ⚠️ THE EVIDENCE ROW IS A FIXTURE, AND SAYS SO. There IS a producer in `src/`
// (`qzone-live-friend-read.mjs` → `qzone-reply-evidence-store-offline.mjs#record`, own-new-comment
// only), but it has no production caller yet and cannot write a row for this file's arbitrary
// post/comment. Seeding proves the GATE's behaviour, not that a real reply was sent.
//
// ⚠️ ONE CLAIM IS STRUCTURAL, NOT JUST BEHAVIOURAL: the update count. The ruling this file enforces
// is "age is judged in the same transaction, before any quota is spent". If the age check ever moves
// back into a pre-flight read or a second `update`, the three verdicts above would still look right
// while the guarantee was gone — the counter catches exactly that regression.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import {
  reserveAuditedOfflineInteraction,
  DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS,
  MAX_REPLY_EVIDENCE_MAX_AGE_MS,
} from '../src/core/qzone-reservation-offline.mjs';

const NOW = Date.parse('2026-11-15T04:00:00.000Z');
const TARGET = '9876543210';   // the post owner the reply is sent as
const POST_ID = 'p-age-1';
const COMMENT_ID = 'c-age-1';
const COMMENT_UIN = 7;         // the parent comment's author — part of the full reply identity
/** Well inside `MAX_REPLY_EVIDENCE_MAX_AGE_MS`, so a request carrying it is legal. */
const MAX_AGE = 5000;

function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-age-${label}-`));
  return {
    dir,
    dbPath: path.join(dir, 'state.db'),
    cleanup() {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
      }
    },
  };
}

const baseState = () => ({
  enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
  tools: { read_posts: false, read_comments: true, publish: false, comment: false, reply: true, like: false },
  limits: { post: 3, comment: 25, like: 30 },
  ledger: { day: '2026-11-15', used: { post: 0, comment: 0, like: 0 }, reservations: {} },
  lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [], audit: [],
  commentEvidence: [],
});

/**
 * The request + intent shapes `qzone-write-path-offline.mjs` builds for a reply. The FULL identity
 * (`replyParams`) is supplied, as the facade always does, so these cases exercise the strict path
 * and not the pre-identity fallback.
 */
const request = (over = {}) => ({
  id: 'age-1', now: NOW, tool: 'reply', target: TARGET, postId: POST_ID,
  commentId: COMMENT_ID, source: 'qq', maxAgeMs: MAX_AGE,
  replyParams: { comment_id: COMMENT_ID, comment_uin: COMMENT_UIN },
  ...over,
});

const intent = (over = {}) => ({
  time: NOW, source: 'qq', action: 'reply', target: TARGET, postId: POST_ID,
  commentId: COMMENT_ID, content: 'age probe', result: 'unknown', reason: '', ...over,
});

/** A row matching the identity triple AND the full reply identity; `at` only when a case wants it. */
const evidenceRow = (at) => ({
  target: TARGET, postId: POST_ID, commentId: COMMENT_ID,
  commentUin: String(COMMENT_UIN), replyUin: null, replyName: null,
  ...(at === undefined ? {} : { at }),
});

/** Everything a refusal must leave byte-identical. */
const costOf = (store) => {
  const state = store.read();
  return {
    used: JSON.parse(JSON.stringify(state.ledger.used)),
    reservations: Object.keys(state.ledger.reservations ?? {}).sort(),
    lastCommentAt: state.lastCommentAt,
    commentTargets: JSON.parse(JSON.stringify(state.commentTargets ?? [])),
    auditLength: Array.isArray(state.audit) ? state.audit.length : -1,
  };
};

/**
 * A REAL temp SQLite store, seeded with `rows` through a RAW handle (so seeding is not counted), then
 * wrapped in a delegating spread that counts `update` calls. The spread inherits the store's authority
 * token: same database, same send authority, one more observation — not a second store.
 */
function world(t, rows) {
  const db = tempDb('w');
  const store = openOfflineStore(db.dbPath, baseState());
  if (rows.length > 0) store.update((state) => ({ ...state, commentEvidence: rows }));
  let updates = 0;
  const counted = {
    ...store,
    update(fn) { updates += 1; return store.update(fn); },
    close: () => store.close(),
  };
  t.after(() => { try { store.close(); } catch { /* already closed */ } db.cleanup(); });
  return { store, counted, updates: () => updates };
}

// ── 1. FRESH evidence is accepted, and it DOES cost one unit ──────────────────────────────────────
test('AGE-1 新鲜证据（at = now - 1000）⇒ allowed，且 used.comment 记为 1', (t) => {
  const { store, counted, updates } = world(t, [evidenceRow(NOW - 1000)]);
  const before = costOf(store);
  assert.equal(before.used.comment, 0, '前提：配额从 0 起（否则"扣了 1"无从判断）');
  assert.equal(before.lastCommentAt, null, '前提：没有既有冷却');

  const result = reserveAuditedOfflineInteraction(counted, request(), intent());

  assert.equal(result.allowed, true, `新鲜证据必须放行: ${JSON.stringify(result)}`);
  const after = costOf(store);
  assert.equal(after.used.comment, 1, '★★ 放行必须真的扣 1：否则"扣额"这件事本身没被观察到');
  assert.equal(after.lastCommentAt, NOW, '★ 放行必须推进评论冷却时钟');
  assert.deepEqual(after.reservations, ['age-1'], '★ 预留已落盘');
  assert.equal(after.auditLength, before.auditLength + 1, '★ 放行会追加一条意图审计');

  // ★ STRUCTURAL: the whole audited reply — age gate, identity gate, quota spend, intent append —
  // is ONE real transaction. Two would mean the age check was moved out of it.
  assert.equal(updates(), 1, '★★ 整个 audited reply 只开一个真实事务（时效判断不在别的事务里）');

  // The policy numbers are the module's, bounded, and ON by default: a caller can narrow the window
  // but the default is an enforced bound, never "off".
  assert.equal(DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS, 10 * 60 * 1000, '默认时效是有界常量，不是"关"');
  assert.equal(MAX_REPLY_EVIDENCE_MAX_AGE_MS, 60 * 60 * 1000, '硬上限有界：不能把"无期限"写成大整数');
});

// ── 2. EXPIRED evidence is refused, and NOTHING moves ─────────────────────────────────────────────
test('AGE-2 过期证据（at = now - maxAgeMs - 1）⇒ evidence-expired，五项全不变', (t) => {
  const at = NOW - MAX_AGE - 1;
  const { store, counted, updates } = world(t, [evidenceRow(at)]);
  assert.equal(NOW - at > MAX_AGE, true, '前提：这一行确实超出窗口 1ms');
  const before = costOf(store);

  const result = reserveAuditedOfflineInteraction(counted, request(), intent());

  assert.equal(result.allowed, false, '过期的证据必须被拒');
  assert.equal(result.reason, 'evidence-expired', '★★ 拒因必须点名"过期"，与"缺失/不匹配"区分');
  const after = costOf(store);
  assert.equal(after.used.comment, 0, '★★ 零配额：拒绝不得扣一个单位');
  assert.equal(after.lastCommentAt, null, '★★ 零冷却：拒绝不得推进冷却时钟');
  assert.deepEqual(after.commentTargets, before.commentTargets, '★★ commentTargets 未变');
  assert.deepEqual(after.reservations, [], '★★ 没有为该 id 写预留记录');
  assert.equal(after.auditLength, before.auditLength, '★★ 审计未增（零预留 ⇒ 零意图）');
  assert.deepEqual(after, before, '★★ 五项逐项不变（快照完全相等）');
  assert.equal(updates(), 1, '★★ 拒绝同样只经过一个事务，且它返回原 state（没有部分写入）');

  // NON-VACUITY: the SAME store with a fresh row really does reserve, so the assertions above are not
  // describing a store that could never write. (Re-seeded through the RAW handle: the update count
  // below must keep measuring the reservation alone.)
  store.update((state) => ({ ...state, commentEvidence: [evidenceRow(NOW - MAX_AGE)] }));
  const second = reserveAuditedOfflineInteraction(counted, request({ id: 'age-2' }), intent());
  assert.equal(second.allowed, true, `★ age === maxAgeMs 仍在窗口内（闭区间 [0, maxAgeMs]）: ${JSON.stringify(second)}`);
  assert.equal(store.read().ledger.used.comment, 1, '★ 并且真的扣了 1（对照组）');
  assert.equal(updates(), 2, '★ 过期拒绝 1 个事务 + 边界放行 1 个事务');
});

// ── 3. UNDATED evidence is refused, and NOTHING moves ─────────────────────────────────────────────
test('AGE-3 缺 at 的证据 ⇒ evidence-undated，五项全不变（无时间戳不等于永不过期）', (t) => {
  const row = evidenceRow(undefined);
  assert.equal(Object.hasOwn(row, 'at'), false, '前提：这一行确实没有 at');
  const { store, counted, updates } = world(t, [row]);
  const before = costOf(store);

  const result = reserveAuditedOfflineInteraction(counted, request(), intent());

  assert.equal(result.allowed, false, '没有 at 的证据必须被拒（不能当作"永不过期"）');
  assert.equal(result.reason, 'evidence-undated', '★★ 拒因必须点名"无日期"');
  const after = costOf(store);
  assert.equal(after.used.comment, 0, '★★ 零配额');
  assert.equal(after.lastCommentAt, null, '★★ 零冷却');
  assert.deepEqual(after.commentTargets, before.commentTargets, '★★ commentTargets 未变');
  assert.deepEqual(after.reservations, [], '★★ 无预留记录');
  assert.equal(after.auditLength, before.auditLength, '★★ 审计未增');
  assert.equal(updates(), 1, '★★ 拒绝只经过一个事务');

  // The bound is the module's, not the caller's whim: a hard ceiling still applies to `maxAgeMs`, and
  // the combination "don't enforce" + "enforce with this bound" is contradictory and refused.
  assert.throws(
    () => reserveAuditedOfflineInteraction(counted, request({ maxAgeMs: MAX_REPLY_EVIDENCE_MAX_AGE_MS + 1 }), intent()),
    TypeError, '★ 超过硬上限的 maxAgeMs 是契约错误，不是"放宽窗口"',
  );
  assert.throws(
    () => reserveAuditedOfflineInteraction(counted, request({ enforceEvidenceAge: false }), intent()),
    TypeError, '★ "不查时效" 与 "按这个上限查时效" 互相矛盾 ⇒ 契约错误',
  );
  // Neither contract error touched the store.
  assert.equal(updates(), 1, '★ 契约错误发生在事务之前，没有开新事务');

  // ── THE LEGACY ISOLATION, PROVEN TO BE REAL (not a comment) ────────────────────────────────────
  // A caller that genuinely cannot supply a dated row must say so EXPLICITLY. The SAME undated row is
  // then accepted — which is the documented opt-out, and proof that the "enforced by default" path
  // above is a decision and not an accident of the fixture. This is NOT the B3 chain:
  // `qzone-write-path-offline.mjs` never sets the flag, so every real reply is age-checked.
  const legacy = reserveAuditedOfflineInteraction(
    counted,
    // `maxAgeMs` is dropped (spread as `undefined` = absent): the opt-out and a bound are contradictory
    // and the module refuses that combination, as pinned above.
    request({ id: 'age-legacy', enforceEvidenceAge: false, maxAgeMs: undefined }),
    intent(),
  );
  assert.equal(legacy.allowed, true, '★ 显式 enforceEvidenceAge:false ⇒ 旧调用确实可以绕过时效（这就是"显式隔离"）');
  assert.equal(store.read().ledger.used.comment, 1, '★ 该旧调用真的扣了配额（它是一条真实的预留路径）');
  assert.equal(updates(), 2, '★ 旧调用同样只经过一个事务');
});
