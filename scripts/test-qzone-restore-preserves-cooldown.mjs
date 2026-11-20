// 用户裁决明文：「恢复暂停不清除冷却」。
//
// 这条裁决有两个可观察后果，必须分开钉住：
//   1. `manualRestore(state, layer)` 返回的新状态里，冷却证据（`lastCommentAt` 与
//      `commentTargets`）**逐字段保持不变**；
//   2. 恢复之后**冷却真的仍然生效** —— 立刻评论另一个对象仍被 `interval` 拒绝。
//
// 为什么第 2 条不能省：只断言「字段没变」在两种情况下会假绿 ——
//   · 若字段本来就是 undefined，「undefined 还是 undefined」什么都没证明；
//   · 若恢复后整条写路径被别的原因挡住（例如仍处于 writePaused），断言「被拒」也会成立，
//     但拒因不是冷却。
// 所以本文件每次都先**真的评论一次**（把 `lastCommentAt` 推成真实时间戳），
// 并在恢复前做一次负控：确认暂停期间被拒的**原因是暂停**（`access_paused` /
// `write_paused`），恢复后才换成 `interval`。这样「interval」才唯一指向冷却。
//
// 覆盖三个 layer：access / write / both（参数化，见文件末尾的三条用例）。
// 另有一条覆盖 `pauseCycles` 分支：`manualRestore` 在 state 带 pauseCycles 时会浅拷贝它，
// 那是与「无 pauseCycles」不同的代码路径，同样不得顺手清掉冷却。
//
// 本文件**只加测试**，不修改 `src/core/qzone-policy-offline.mjs`（行为已正确，缺的是覆盖）。
// 存储：真实临时 SQLite（openOfflineStore），每个用例一个 %TEMP% 目录，结束即删。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { manualRestore } from '../src/core/qzone-policy-offline.mjs';
import { reserveOfflineInteraction } from '../src/core/qzone-reservation-offline.mjs';

const COMMENT_INTERVAL_MS = 3 * 60 * 1000;
const BASE_NOW = Date.parse('2026-11-12T02:00:00Z');   // 北京 11-12 10:00，远离日切
let idCounter = 0;
const nextId = (prefix) => `${prefix}-${++idCounter}`;

function baseState() {
  return {
    enabled: true,
    readAllowed: true,
    writeAllowed: true,
    accessPaused: false,
    writePaused: false,
    reads: 0,
    writes: 0,
    probe: 'waiting',
    tools: { publish: true, comment: true, reply: true, like: true },
    limits: { post: 3, comment: 25, like: 30 },
    ledger: { day: '2026-11-12', used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    lastPostAt: null,
    lastCommentAt: null,
    commentTargets: [],
    likes: [],
  };
}

/** 每个用例一份真实临时 SQLite；用例结束（含抛错）即删。 */
async function withStore(t, state, run) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-restore-cooldown-'));
  const store = openOfflineStore(join(dir, 'state.db'), state);
  t.after(async () => {
    try { store.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  });
  return run(store);
}

const commentOn = (target, postId, now) =>
  ({ id: nextId('c'), now, target, postId, tool: 'comment' });

/**
 * 三个 layer 共用的完整流程。`pausedFlags` 与 `expectAfter` 由调用方按 layer 给出。
 */
async function runLayerScenario(t, { layer, pausedFlags, expectAfter }) {
  await withStore(t, baseState(), (store) => {
    // ── 1. 先真的评论一次，把冷却证据推成真实时间戳 ─────────────────────────────
    const first = reserveOfflineInteraction(store, commentOn('10001', 'p-a', BASE_NOW));
    assert.equal(first.allowed, true, '前提：暂停之前的这条评论必须成功');

    const afterComment = store.read();
    assert.equal(afterComment.lastCommentAt, BASE_NOW, '前提：lastCommentAt 必须是真实的非零时间戳');
    assert.ok(Number.isFinite(afterComment.lastCommentAt) && afterComment.lastCommentAt > 0,
      '前提：lastCommentAt 不能是 undefined/null/0 —— 否则后面的「保持不变」是空断言');
    assert.deepEqual(afterComment.commentTargets, [{ target: '10001', time: BASE_NOW }],
      '前提：commentTargets 也带上了这次评论的时间');

    // ── 2. 暂停（模拟真实生命周期：评论之后才发生熔断/暂停） ────────────────────
    store.update((state) => ({
      ...state,
      reads: 2,
      writes: 1,
      probe: 'waiting',
      ...pausedFlags,
      ...(layer === 'both' ? {} : {}),
      pauseCycles: { access: BASE_NOW + 1000, write: BASE_NOW + 2000 },
    }));
    const paused = store.read();
    const cooldownBefore = paused.lastCommentAt;
    const targetsBefore = paused.commentTargets;

    // ── 3. 负控：暂停期间的拒绝必须来自暂停，而不是冷却 ─────────────────────────
    //        这样第 5 步的 `interval` 才唯一指向冷却。
    const deniedWhilePaused = reserveOfflineInteraction(store, commentOn('10002', 'p-b', BASE_NOW + 1000));
    assert.equal(deniedWhilePaused.allowed, false, '前提：暂停期间评论必须被拒');
    assert.ok(['access_paused', 'write_paused'].includes(deniedWhilePaused.reason),
      `暂停期间的拒因必须是暂停，实际是 ${deniedWhilePaused.reason}`);
    assert.equal(store.read().lastCommentAt, cooldownBefore, '被暂停拒掉的尝试不得改动冷却证据');

    // ── 4. 调 manualRestore ──────────────────────────────────────────────────
    const restored = manualRestore(store.read(), layer);

    // ── 5. 冷却证据必须逐字段保持不变（用户裁决的核心断言） ─────────────────────
    assert.ok(Object.hasOwn(restored, 'lastCommentAt'),
      '恢复后的状态里必须仍然**存在** lastCommentAt 这个字段（不能是删掉）');
    assert.equal(restored.lastCommentAt, cooldownBefore,
      `manualRestore(...,'${layer}') 不得清除 lastCommentAt（用户裁决：恢复暂停不清除冷却）`);
    assert.deepEqual(restored.commentTargets, targetsBefore,
      'manualRestore 不得清空 commentTargets —— 它和 lastCommentAt 是同一份冷却证据');

    // 同一份裁决的另一半：恢复也不重置当天配额。
    assert.deepEqual(restored.ledger.used, paused.ledger.used,
      'manualRestore 不得重置当日配额（恢复暂停不重置已经使用的配额）');

    // 恢复本身该做的三件事仍然要做（避免把「什么都没变」当成通过）。
    assert.deepEqual(
      { accessPaused: restored.accessPaused, writePaused: restored.writePaused,
        reads: restored.reads, writes: restored.writes, probe: restored.probe },
      expectAfter,
      `manualRestore(...,'${layer}') 的恢复效果必须正确`);

    // ── 6. 把恢复结果落盘，再断言冷却**真的仍然生效** ─────────────────────────
    store.update(() => restored);
    const afterRestore = store.read();
    assert.equal(afterRestore.lastCommentAt, cooldownBefore, '落盘后 lastCommentAt 仍必须是原值');

    const deniedByCooldown = reserveOfflineInteraction(store,
      commentOn('10003', 'p-c', cooldownBefore + 60_000));
    assert.deepEqual(deniedByCooldown, { allowed: false, reason: 'interval' },
      `manualRestore(...,'${layer}') 之后 1 分钟内评论另一个对象仍必须被冷却拒绝（reason 必须是 interval，不是暂停）`);

    // 被冷却拒掉不得消耗额度、不得推进冷却。
    const settled = store.read();
    assert.equal(settled.lastCommentAt, cooldownBefore, '冷却拒绝不得推进 lastCommentAt');
    assert.equal(settled.ledger.used.comment, paused.ledger.used.comment, '冷却拒绝不得消耗评论额度');

    // ── 7. 反向正控：冷却满 3 分钟后必须放行（证明是冷却，不是全锁死） ──────────
    const allowedAfterCooldown = reserveOfflineInteraction(store,
      commentOn('10004', 'p-d', cooldownBefore + COMMENT_INTERVAL_MS));
    assert.equal(allowedAfterCooldown.allowed, true,
      '冷却满 3 分钟后必须放行：证明拒绝确实来自冷却而不是恢复后整体锁死');
    assert.equal(store.read().lastCommentAt, cooldownBefore + COMMENT_INTERVAL_MS,
      '放行后 lastCommentAt 才推进');
  });
}

// ── 参数化：access / write / both ─────────────────────────────────────────────────

for (const { layer, pausedFlags, expectAfter } of [
  {
    layer: 'access',
    pausedFlags: { accessPaused: true, writePaused: false },
    expectAfter: { accessPaused: false, writePaused: false, reads: 0, writes: 1, probe: 'done' },
  },
  {
    layer: 'write',
    pausedFlags: { accessPaused: false, writePaused: true },
    expectAfter: { accessPaused: false, writePaused: false, reads: 2, writes: 0, probe: 'waiting' },
  },
  {
    layer: 'both',
    pausedFlags: { accessPaused: true, writePaused: true },
    expectAfter: { accessPaused: false, writePaused: false, reads: 0, writes: 0, probe: 'done' },
  },
]) {
  test(`[用户裁决·恢复不清除冷却] layer=${layer}：manualRestore 后 lastCommentAt 不变且冷却仍生效`, async (t) => {
    await runLayerScenario(t, { layer, pausedFlags, expectAfter });
  });
}

// ── pauseCycles 分支：manualRestore 会浅拷贝它，是另一条代码路径 ────────────────────

test('[用户裁决·恢复不清除冷却] 带 pauseCycles 时（both）清空暂停周期但不得顺手清掉冷却', async (t) => {
  await withStore(t, baseState(), (store) => {
    const first = reserveOfflineInteraction(store, commentOn('10001', 'p-a', BASE_NOW));
    assert.equal(first.allowed, true);

    store.update((state) => ({
      ...state,
      reads: 2,
      writes: 3,
      accessPaused: true,
      writePaused: true,
      pauseCycles: { access: BASE_NOW - 5000, write: BASE_NOW - 4000 },
    }));
    const paused = store.read();
    const cooldownBefore = paused.lastCommentAt;
    assert.ok(Number.isFinite(cooldownBefore) && cooldownBefore > 0, '前提：冷却证据是真实时间戳');

    const restored = manualRestore(store.read(), 'both');

    // pauseCycles 这一支自己的效果：两个周期都要被清成 null。
    assert.deepEqual(restored.pauseCycles, { access: null, write: null },
      'manualRestore 必须清空 pauseCycles 的两个周期');
    // 而冷却证据与 pauseCycles 是两回事，必须原样保留。
    assert.equal(restored.lastCommentAt, cooldownBefore,
      'pauseCycles 分支不得顺手清掉 lastCommentAt（用户裁决：恢复暂停不清除冷却）');
    assert.deepEqual(restored.commentTargets, paused.commentTargets,
      'pauseCycles 分支不得清空 commentTargets');

    store.update(() => restored);
    const denied = reserveOfflineInteraction(store, commentOn('10002', 'p-b', cooldownBefore + 1000));
    assert.deepEqual(denied, { allowed: false, reason: 'interval' },
      '带 pauseCycles 的恢复之后，冷却仍必须生效');

    const allowed = reserveOfflineInteraction(store, commentOn('10003', 'p-c', cooldownBefore + COMMENT_INTERVAL_MS));
    assert.equal(allowed.allowed, true, '冷却满 3 分钟后必须放行');
  });
});

// ── 反例保险：本文件对「层参数非法」不负责，但确认 manualRestore 仍会拒绝 ─────────

test('[用户裁决·恢复不清除冷却] 参照：非法 layer 必须被拒绝（证明本文件的 layer 参数是走真实校验的）', async (t) => {
  await withStore(t, baseState(), (store) => {
    assert.equal(reserveOfflineInteraction(store, commentOn('10001', 'p-a', BASE_NOW)).allowed, true);
    const state = store.read();
    for (const bad of ['all', '', null, undefined, 'ACCESS']) {
      assert.throws(() => manualRestore(state, bad), /invalid restore/u, `layer=${String(bad)} 必须被拒绝`);
    }
    // 非法调用不得改动持久状态，冷却证据也还在。
    assert.equal(store.read().lastCommentAt, BASE_NOW, '非法调用不得影响冷却证据');
  });
});
