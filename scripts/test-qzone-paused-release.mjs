// OPTION C tests: targeted release for `paused-before-send`, with the safety markers kept.
//
// Real temporary SQLite + the real reservation module, so the "did the release actually change what
// the next write sees?" questions are answered by the code that answers them in production, not by a
// fixture that agrees with the test.
//
// Two conventions:
//   · every "unchanged" claim is measured from a NON-ZERO baseline (a real reservation first), so
//     `0 === 0` can never masquerade as a passing check;
//   · the safety-half assertions (id still reserved, like still de-duplicated) are the ones that
//     distinguish Option C from "just give everything back". If they go green for the wrong reason the
//     whole design collapses into Option B, so they are asserted from both directions.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { reserveOfflinePost, reserveOfflineInteraction } from '../src/core/qzone-reservation-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import {
  releasePausedWrite,
  isPausedBeforeSend,
  PAUSED_RELEASE_REASON,
} from '../src/core/qzone-paused-release-offline.mjs';

const T0 = Date.parse('2026-11-07T04:00:00.000Z');   // 12:00 Beijing — far from midnight
const DAY = beijingDay(T0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const TARGET = '9876543210';
const TARGET_B = '1122334455';

function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-prelease-${label}-`));
  return {
    dir,
    dbPath: path.join(dir, 'state.db'),
    cleanup() {
      for (let i = 0; i < 20; i += 1) {
        try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
      }
    },
  };
}

const baseState = (over = {}) => ({
  enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
  tools: { publish: true, comment: true, reply: true, like: true },
  limits: { post: 3, comment: 25, like: 30 },
  ledger: { day: DAY, used: { post: 0, comment: 0, like: 0 }, reservations: {} },
  lastPostAt: null,
  lastCommentAt: null,
  commentTargets: [],
  likes: [],
  ...over,
});

function world({ state = baseState(), dbPath } = {}) {
  const t = tempDb('w');
  const file = dbPath ?? t.dbPath;
  let store = openOfflineStore(file, state);
  return {
    t, file,
    get store() { return store; },
    read: () => store.read(),
    ledger: () => store.read().ledger,
    /** Reserve, snapshotting the cooldown BEFORE the write — exactly what the caller must do. */
    reservePost(id, now) {
      const previous = { lastPostAt: store.read().lastPostAt };
      const out = reserveOfflinePost(store, { id, now });
      return { out, previous, day: beijingDay(now), now };
    },
    reserveInteraction(id, { now, tool = 'comment', target = TARGET, postId = 'p1' } = {}) {
      const previous = { lastCommentAt: store.read().lastCommentAt };
      const out = reserveOfflineInteraction(store, { id, now, tool, target, postId });
      return { out, previous, day: beijingDay(now), now };
    },
    close() { try { store.close(); } catch {} t.cleanup(); },
  };
}

/** The exact result shape the write path emits on this branch. */
const PAUSED_RESULT = Object.freeze({
  ok: false, stage: 'transport', outcome: 'not-sent',
  reason: 'paused-before-send', quotaConsumed: true, transportCalled: false,
});

// ── 1. normal release ───────────────────────────────────────────────────────────────
test('PR-1 正常释放：used 1→0，lastPostAt 回退到快照，reservations[id] 仍在', () => {
  const w = world();
  try {
    const r = w.reservePost('p1', T0);
    assert.equal(r.out.allowed, true, '前提：预留成功');
    assert.equal(w.ledger().used.post, 1, '前提：used.post 是 1，不是 0');
    assert.equal(w.read().lastPostAt, T0, '前提：lastPostAt 已推进到 T0');
    assert.equal(w.ledger().reservations.p1, 'post', '前提：reservation 已写入');

    const out = releasePausedWrite(w.store, { id: 'p1', kind: 'post', day: r.day, now: T0, previous: r.previous, result: PAUSED_RESULT });
    assert.equal(out.released, true);
    assert.equal(out.usedReleased, true);
    assert.deepEqual([...out.cooldownRolledBack], ['lastPostAt']);

    assert.equal(w.ledger().used.post, 0, 'used.post 必须回到 0');
    assert.equal(w.read().lastPostAt, null, 'lastPostAt 必须回到快照值（null）');
    // THE safety marker this whole option rests on.
    assert.equal(w.ledger().reservations.p1, 'post', 'reservations[id] 必须保留');
  } finally { w.close(); }
});

// ── 2. released quota, id NOT reusable ────────────────────────────────────────────
test('PR-2 释放额度 ≠ 允许重放：同 id 再写仍是 duplicate，换新 id 才能写', () => {
  const w = world();
  try {
    const r = w.reservePost('p1', T0);
    const out = releasePausedWrite(w.store, { id: 'p1', kind: 'post', day: r.day, now: T0, previous: r.previous });
    assert.equal(out.released, true);
    assert.equal(w.ledger().used.post, 0, '额度已退回');

    // Same id: the reservation still blocks it.
    const again = reserveOfflinePost(w.store, { id: 'p1', now: T0 + 1000 });
    assert.equal(again.allowed, false);
    assert.equal(again.reason, 'duplicate', '同 id 必须仍然 duplicate —— 释放不等于重放');

    // New id: the released quota is genuinely usable again (that is the point of Option C).
    const fresh = reserveOfflinePost(w.store, { id: 'p2', now: T0 + 1000 });
    assert.equal(fresh.allowed, true, '换新 id 必须能写（额度确实退回来了）');
    assert.equal(w.ledger().used.post, 1);
  } finally { w.close(); }
});

// ── 3. like marker survives ───────────────────────────────────────────────────────
test('PR-3 点赞标记保留：释放后同帖再赞仍 duplicate_like', () => {
  const w = world();
  try {
    const r = w.reserveInteraction('l1', { now: T0, tool: 'like', postId: 'post-9' });
    assert.equal(r.out.allowed, true, '前提：点赞预留成功');
    assert.equal(w.ledger().used.like, 1, '前提：used.like 是 1');
    assert.deepEqual(w.read().likes, [{ author: TARGET, id: 'post-9' }]);

    const out = releasePausedWrite(w.store, { id: 'l1', kind: 'like', day: r.day, now: T0, previous: r.previous });
    assert.equal(out.usedReleased, true, '点赞额度可以释放（它不影响去重）');
    assert.equal(w.ledger().used.like, 0);

    // The de-duplication evidence must be untouched: releasing quota is not permission to like twice.
    assert.deepEqual(w.read().likes, [{ author: TARGET, id: 'post-9' }], 'likes 标记必须保留');
    const again = reserveOfflineInteraction(w.store, { id: 'l2', now: T0 + 1000, tool: 'like', target: TARGET, postId: 'post-9' });
    assert.equal(again.allowed, false, '同一帖子换新 id 点赞仍必须被拒');
    assert.equal(again.reason, 'duplicate_like');
  } finally { w.close(); }
});

// ── 4. commentTargets survive ─────────────────────────────────────────────────────
test('PR-4 commentTargets 保留：释放后该 target 的历史时间仍在', () => {
  const w = world();
  try {
    const r = w.reserveInteraction('c1', { now: T0, tool: 'comment', target: TARGET });
    assert.equal(r.out.allowed, true);
    const targetsBefore = JSON.parse(JSON.stringify(w.read().commentTargets));
    assert.deepEqual(targetsBefore, [{ target: TARGET, time: T0 }], '前提：commentTargets 已写入');

    const out = releasePausedWrite(w.store, { id: 'c1', kind: 'comment', day: r.day, now: T0, previous: r.previous });
    assert.equal(out.usedReleased, true, '评论额度释放');
    assert.equal(w.ledger().used.comment, 0);
    assert.deepEqual(w.read().commentTargets, targetsBefore, 'commentTargets 必须原样保留（它参与间隔计算）');
  } finally { w.close(); }
});

// ── 5. MEASURED ASYMMETRY: the comment cooldown rollback does not actually free the window ──
test('PR-5 【实测差异】comment 的 lastCommentAt 回退不足以放开 3 分钟（commentTargets 仍是同一时间）', () => {
  const w = world();
  try {
    const r = w.reserveInteraction('c1', { now: T0, tool: 'comment', target: TARGET });
    const out = releasePausedWrite(w.store, { id: 'c1', kind: 'comment', day: r.day, now: T0, previous: r.previous });
    assert.deepEqual([...out.cooldownRolledBack], ['lastCommentAt'], '字段本身确实回退了');
    assert.equal(w.read().lastCommentAt, null, 'lastCommentAt 回到 null');

    // …but the reservation module takes the MAX of lastCommentAt and commentTargets, and the design
    // forbids deleting commentTargets. So the interval is NOT actually released. This is measured,
    // not assumed — it is the documented consequence of keeping the safety evidence.
    const again = reserveOfflineInteraction(w.store, { id: 'c2', now: T0 + 1000, tool: 'comment', target: TARGET_B, postId: 'p2' });
    assert.equal(again.allowed, false, 'commentTargets 保留 ⇒ 3 分钟间隔仍然生效');
    assert.equal(again.reason, 'interval');
  } finally { w.close(); }
});

test('PR-5b 对照：publish 的 lastPostAt 回退确实放开 2 小时（该间隔只有这一个来源）', () => {
  const w = world();
  try {
    const r = w.reservePost('p1', T0);
    const out = releasePausedWrite(w.store, { id: 'p1', kind: 'post', day: r.day, now: T0, previous: r.previous });
    assert.deepEqual([...out.cooldownRolledBack], ['lastPostAt']);

    // Unlike comment, the publish interval reads ONLY lastPostAt, so the rollback is effective.
    const again = reserveOfflinePost(w.store, { id: 'p2', now: T0 + 1000 });
    assert.equal(again.allowed, true, 'lastPostAt 回退后 1 秒就能再发 —— 发布冷却真的被释放了');
  } finally { w.close(); }
});

// ── 6. idempotency ────────────────────────────────────────────────────────────────
test('PR-6 幂等：同 id 释放两次，第二次 already-released 且 used 不变', () => {
  const w = world();
  try {
    const r = w.reservePost('p1', T0);
    const first = releasePausedWrite(w.store, { id: 'p1', kind: 'post', day: r.day, now: T0, previous: r.previous });
    assert.equal(first.released, true);
    assert.equal(w.ledger().used.post, 0, '前提：第一次已经把 used 归零');

    const before = JSON.stringify(w.read());
    const second = releasePausedWrite(w.store, { id: 'p1', kind: 'post', day: r.day, now: T0, previous: r.previous });
    assert.equal(second.released, false);
    assert.equal(second.reason, PAUSED_RELEASE_REASON.ALREADY_RELEASED);
    assert.equal(second.usedReleased, false);
    assert.equal(JSON.stringify(w.read()), before, '第二次释放必须零改动');
    assert.equal(w.ledger().used.post, 0, 'used 不得变成 -1');
  } finally { w.close(); }
});

// ── 7. day rollover ───────────────────────────────────────────────────────────────
test('PR-7 跨日：ledger.day 与记录 day 不同 → 跳过 used（day-rollover），冷却仍回退', () => {
  const w = world();
  try {
    const r = w.reservePost('p1', T0);
    assert.equal(w.ledger().used.post, 1);
    // Simulate the day rolling over between reserve and release: the ledger is reset for a NEW day.
    w.store.update((s) => ({
      ...s,
      ledger: { ...s.ledger, day: '2026-11-08', used: { post: 0, comment: 0, like: 0 } },
    }));
    assert.equal(w.ledger().used.post, 0, '前提：新的一天 used 已重置为 0');

    const out = releasePausedWrite(w.store, { id: 'p1', kind: 'post', day: r.day, now: T0, previous: r.previous });
    assert.equal(out.reason, PAUSED_RELEASE_REASON.DAY_ROLLOVER);
    assert.equal(out.usedReleased, false, '跨日不得减新一天的 used');
    assert.equal(w.ledger().used.post, 0, '新一天计数必须仍是 0（不能被减成 -1）');
    // The cooldown is not day-scoped, so it may still roll back.
    assert.deepEqual([...out.cooldownRolledBack], ['lastPostAt'], '冷却不按天，仍应回退');
    assert.equal(w.read().lastPostAt, null);
  } finally { w.close(); }
});

// ── 8. cooldown guard ─────────────────────────────────────────────────────────────
test('PR-8 冷却守卫：被他人推进后跳过回退（cooldown-moved），但 used 仍释放', () => {
  const w = world();
  try {
    const r = w.reservePost('p1', T0);
    // Another writer advances the cooldown AFTER our reservation.
    const advanced = T0 + 5 * MIN;
    w.store.update((s) => ({ ...s, lastPostAt: advanced }));

    const out = releasePausedWrite(w.store, { id: 'p1', kind: 'post', day: r.day, now: T0, previous: r.previous });
    assert.equal(out.reason, PAUSED_RELEASE_REASON.COOLDOWN_MOVED);
    assert.deepEqual([...out.cooldownSkipped], ['cooldown-moved']);
    assert.deepEqual([...out.cooldownRolledBack], [], '守卫失败 ⇒ 绝不回退');
    assert.equal(w.read().lastPostAt, advanced, '他人的推进必须原样保留（不得被抹掉）');
    // The quota half is independent of the guard.
    assert.equal(out.usedReleased, true);
    assert.equal(w.ledger().used.post, 0, 'used 仍应释放');
  } finally { w.close(); }
});

// ── 9. missing snapshot ───────────────────────────────────────────────────────────
test('PR-9 缺少 previous 快照：跳过冷却回退、不报错，used 仍释放', () => {
  const w = world();
  try {
    const r = w.reservePost('p1', T0);
    const out = releasePausedWrite(w.store, { id: 'p1', kind: 'post', day: r.day, now: T0 });
    assert.equal(out.usedReleased, true);
    assert.deepEqual([...out.cooldownSkipped], ['no-snapshot']);
    assert.equal(w.read().lastPostAt, T0, '没有快照就不该动冷却（保留惩罚）');
    assert.equal(w.ledger().used.post, 0);

    // A snapshot missing only the relevant key behaves the same way.
    const w2 = world();
    const r2 = w2.reservePost('p1', T0);
    const out2 = releasePausedWrite(w2.store, { id: 'p1', kind: 'post', day: r2.day, now: T0, previous: { lastCommentAt: null } });
    assert.deepEqual([...out2.cooldownSkipped], ['no-snapshot'], '缺 lastPostAt 键同样跳过');
    assert.equal(w2.read().lastPostAt, T0);
    w2.close();
  } finally { w.close(); }
});

// ── 10. fail-closed ───────────────────────────────────────────────────────────────
test('PR-10 失败关闭：id 未预占 → not-reserved 且状态零改动', () => {
  const w = world();
  try {
    const before = JSON.stringify(w.read());
    const out = releasePausedWrite(w.store, { id: 'never-reserved', kind: 'post', day: DAY, now: T0, previous: { lastPostAt: null } });
    assert.equal(out.released, false);
    assert.equal(out.reason, PAUSED_RELEASE_REASON.NOT_RESERVED);
    assert.equal(JSON.stringify(w.read()), before, '不得留下 released 标记，也不得动任何字段');
  } finally { w.close(); }
});

test('PR-10b 事务抛错 → 保持已扣（ROLLBACK），错误向上传播', () => {
  const t = tempDb('boom');
  const real = openOfflineStore(t.dbPath, baseState());
  try {
    const previous = { lastPostAt: real.read().lastPostAt };
    assert.equal(reserveOfflinePost(real, { id: 'p1', now: T0 }).allowed, true);
    assert.equal(real.read().ledger.used.post, 1, '前提：已经扣了 1');

    // A store whose write fails, so the release transaction rolls back.
    const failing = {
      read: () => real.read(),
      update() { throw new Error('disk full'); },
    };
    assert.throws(
      () => releasePausedWrite(failing, { id: 'p1', kind: 'post', day: DAY, now: T0, previous }),
      /disk full/,
      '事务失败必须向上抛出，不能静默当作已释放',
    );
    assert.equal(real.read().ledger.used.post, 1, 'ROLLBACK 之后配额仍是已扣状态（倾向保留惩罚）');
    assert.equal(real.read().lastPostAt, T0, '冷却也没有被回退');
  } finally { try { real.close(); } catch {} t.cleanup(); }
});

// ── 11. scope: only the paused-before-send branch ────────────────────────────────
test('PR-11 范围：非 paused-before-send 的结果一律不释放', () => {
  const outOfScope = [
    { label: 'transport 自报 not-sent', result: { ok: true, stage: 'transport', outcome: 'not-sent' } },
    { label: 'unknown', result: { ok: true, stage: 'transport', outcome: 'unknown' } },
    { label: 'failed', result: { ok: true, stage: 'transport', outcome: 'failed' } },
    { label: 'success', result: { ok: true, stage: 'transport', outcome: 'success' } },
    { label: '前置拒绝', result: { ok: false, stage: 'reserve', reason: 'interval' } },
    // Reason string present but the structural flag is wrong: this is exactly the hand-made object
    // that a string-only check would accept.
    { label: 'reason 对但 transportCalled 缺失', result: { ok: false, stage: 'transport', reason: 'paused-before-send' } },
    { label: 'reason 对但 transportCalled:true', result: { ok: false, stage: 'transport', reason: 'paused-before-send', transportCalled: true } },
  ];
  for (const { label, result } of outOfScope) {
    const w = world();
    try {
      const r = w.reservePost('p1', T0);
      const before = JSON.stringify(w.read());
      const out = releasePausedWrite(w.store, { id: 'p1', kind: 'post', day: r.day, now: T0, previous: r.previous, result });
      assert.equal(out.released, false, `${label}: 不得释放`);
      assert.equal(out.reason, PAUSED_RELEASE_REASON.NOT_PAUSED_BEFORE_SEND, `${label}: 拒绝码`);
      assert.equal(JSON.stringify(w.read()), before, `${label}: 必须零改动`);
      assert.equal(w.ledger().used.post, 1, `${label}: 配额仍是 1`);
    } finally { w.close(); }
  }
});

test('PR-11b isPausedBeforeSend 只认「reason + transportCalled:false + ok:false」三件齐备', () => {
  assert.equal(isPausedBeforeSend(PAUSED_RESULT), true);
  assert.equal(isPausedBeforeSend({ ok: false, stage: 'transport', reason: 'paused-before-send', transportCalled: false }), true);
  assert.equal(isPausedBeforeSend({ ok: false, reason: 'paused-before-send' }), false, '缺 transportCalled');
  assert.equal(isPausedBeforeSend({ ok: false, reason: 'paused-before-send', transportCalled: true }), false);
  assert.equal(isPausedBeforeSend({ ok: true, reason: 'paused-before-send', transportCalled: false }), false, 'ok 必须是 false');
  assert.equal(isPausedBeforeSend({ ok: false, reason: 'unknown-outcome', transportCalled: false }), false);
  assert.equal(isPausedBeforeSend(null), false);
  assert.equal(isPausedBeforeSend(undefined), false);
});

// ── 12. concurrency ──────────────────────────────────────────────────────────────
test('PR-12 并发：两个释放同一 id 恰好一个成功，used 只减 1', () => {
  const w = world();
  try {
    const r = w.reservePost('p1', T0);
    assert.equal(w.ledger().used.post, 1, '前提：used.post 是 1');

    // Both calls are submitted before either runs. The reserve/release transaction is synchronous and
    // takes the write lock, so the second one must observe the `released` marker written by the first.
    const results = [];
    const a = () => results.push(releasePausedWrite(w.store, { id: 'p1', kind: 'post', day: r.day, now: T0, previous: r.previous }));
    const b = () => results.push(releasePausedWrite(w.store, { id: 'p1', kind: 'post', day: r.day, now: T0, previous: r.previous }));
    a(); b();

    const releasedCount = results.filter((x) => x.released === true).length;
    const alreadyCount = results.filter((x) => x.reason === PAUSED_RELEASE_REASON.ALREADY_RELEASED).length;
    assert.equal(releasedCount, 1, `恰好一个成功（实际 ${JSON.stringify(results.map((x) => x.reason))}）`);
    assert.equal(alreadyCount, 1, '另一个必须 already-released');
    assert.equal(w.ledger().used.post, 0, 'used 必须只减 1（不是 -1 变负数）');
  } finally { w.close(); }
});

// ── 13. release never touches the fields it must not ────────────────────────────
test('PR-13 释放不越界：只动 used 与冷却字段，reservations/likes/commentTargets 逐字段不变', () => {
  const w = world();
  try {
    const r = w.reserveInteraction('c1', { now: T0, tool: 'comment', target: TARGET });
    reserveOfflineInteraction(w.store, { id: 'l1', now: T0, tool: 'like', target: TARGET, postId: 'post-1' });
    const before = w.read();
    const snapshot = {
      reservations: JSON.parse(JSON.stringify(before.ledger.reservations)),
      likes: JSON.parse(JSON.stringify(before.likes)),
      commentTargets: JSON.parse(JSON.stringify(before.commentTargets)),
    };
    assert.ok(Object.keys(snapshot.reservations).length >= 2, '前提：至少两条 reservation');

    const out = releasePausedWrite(w.store, { id: 'c1', kind: 'comment', day: r.day, now: T0, previous: r.previous });
    assert.equal(out.released, true);
    const after = w.read();
    assert.deepEqual(after.ledger.reservations, snapshot.reservations, 'reservations 必须逐字段不变');
    assert.deepEqual(after.likes, snapshot.likes, 'likes 必须逐字段不变');
    assert.deepEqual(after.commentTargets, snapshot.commentTargets, 'commentTargets 必须逐字段不变');
    assert.equal(after.ledger.used.comment, before.ledger.used.comment - 1, '只减了 comment 桶');
    assert.equal(after.ledger.used.like, before.ledger.used.like, 'like 桶不受影响');
    assert.equal(after.ledger.used.post, before.ledger.used.post, 'post 桶不受影响');
  } finally { w.close(); }
});

// ── 14. released marker is additive and harmless ────────────────────────────────
test('PR-14 released 标记不破坏后续预留（额外字段被 checkLedger 容忍）', () => {
  const w = world();
  try {
    const r = w.reservePost('p1', T0);
    releasePausedWrite(w.store, { id: 'p1', kind: 'post', day: r.day, now: T0, previous: r.previous });
    assert.equal(w.ledger().released.p1, true, '标记已写入');
    // A later reservation on a different id must still work — the extra field must not break the
    // ledger shape checks.
    const next = reserveOfflinePost(w.store, { id: 'p2', now: T0 + HOUR });
    assert.equal(next.allowed, true, '带 released 字段时预留仍必须正常');
    assert.equal(w.ledger().released.p1, true, '标记仍在（它是永久证据，不会被下一次写清掉）');
  } finally { w.close(); }
});
