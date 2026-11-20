// 任务卡（docs/QZONE-SAFE-MCP-TASK-CARD-2026-10-24.md）§4 写操作与配额的**可执行对照表**。
//
// 这个文件只做一件事：把任务卡 §4 的每一条规则翻译成一条测试，让「条款」和「断言」
// 在测试名里就一一对应。它**不修改任何生产代码**，行为一旦变化这里立刻会红。
//
// 基线说明（重要，且尚未定论）：
//   用户已于 2026-11-12 裁决：**评论与回复=全局 3 分钟，不区分对象或说说**。
//   两份任务卡的差异已由该裁决解决，不再待定：
//     · 桌面版（用户提供，2026-11-07，117 行）：同一对象至少间隔 3 分钟
//     · docs/ 版（仓库内，2026-11-08，128 行）：不区分对象或说说，任意两次至少间隔 3 分钟
//
//   docs/ 版在 commit e0b8417（2026-11-08「clarify global comment interval」）里把该行改成了全局口径：
//     -| 评论与回复 | ...同一对象至少间隔 3 分钟 |
//     +| 评论与回复 | ...不区分对象或说说，任意两次评论/回复至少间隔 3 分钟 |
//     +- 评论/回复的全局间隔跨自然日和重启保留；配额重置不清除该间隔。
//
//   ⇒ 用户裁决与 docs/ 版口径一致（也与现行实现一致）。
//   ⇒ 现有实现（全局 3 分钟）**即用户要求**，不需改动。
//
// 下面引用的 §4 原文取自 docs/ 版（逐条对应关系见每条测试名）：
//
//   | 操作       | 限制                                                     |
//   | 发说说     | 每天最多 3 条；任意两条至少间隔 2 小时                     |
//   | 评论与回复 | 合计每天最多 25 条；不区分对象或说说，任意两次至少间隔 3 分钟 |
//   | 点赞       | 每天最多 30 次；同一说说只允许一次                         |
//   - 所有日配额按北京时间每天 00:00 重置。
//   - 评论/回复的全局间隔跨自然日和重启保留；配额重置不清除该间隔。
//
// 少数条目（reservations 跨日、缺少 likes 数组等）任务卡没有明文规定，这些用
// 「[现状·…]」前缀标记为**行为记录**，不宣称是任务卡要求。
//
// 存储：真实临时 SQLite（openOfflineStore），每个用例一个 %TEMP% 目录，结束即删。
// 绝不触碰 state/ 或任何生产数据；不访问真实 QQ。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import {
  reserveOfflinePost,
  reserveOfflineInteraction,
} from '../src/core/qzone-reservation-offline.mjs';

// 任务卡 §4 的三个数字，集中放一处，避免测试里散落魔法值。
const CARD_LIMITS = Object.freeze({ post: 3, comment: 25, like: 30 });
const POST_INTERVAL_MS = 2 * 60 * 60 * 1000;      // 任意两条说说 ≥ 2 小时
const COMMENT_INTERVAL_MS = 3 * 60 * 1000;        // 评论/回复全局 ≥ 3 分钟（不区分对象或说说）

function makeState({ day = '2026-11-07', used = {}, reservations = {}, lastPostAt = null,
  lastCommentAt = null, commentTargets = [], likes = [], tools = {}, limits = {} } = {}) {
  return {
    enabled: true,
    readAllowed: true,
    writeAllowed: true,
    accessPaused: false,
    writePaused: false,
    tools: { publish: true, comment: true, reply: true, like: true, ...tools },
    limits: { ...CARD_LIMITS, ...limits },
    ledger: {
      day,
      used: { post: 0, comment: 0, like: 0, ...used },
      reservations: { ...reservations },
    },
    lastPostAt,
    lastCommentAt,
    commentTargets,
    likes,
  };
}

/** 每个用例一个真实的临时 SQLite，用例结束（含抛错）即删。 */
async function withStore(t, state, run) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-quota-conformance-'));
  const store = openOfflineStore(join(dir, 'state.db'), state);
  t.after(async () => {
    try { store.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  });
  return run(store);
}

const comment = (id, now, target, postId, tool = 'comment') =>
  ({ id, now, target, postId, tool });
const like = (id, now, target, postId) =>
  ({ id, now, target, postId, tool: 'like' });

// ════════════════════════════════════════════════════════════════════════════════
// A. 两版任务卡都一致的部分：验证现有实现确实做到
// ════════════════════════════════════════════════════════════════════════════════

test('[任务卡 §4-post] 发说说每天最多 3 条：第 4 条被拒（limit）', async (t) => {
  await withStore(t, makeState(), (store) => {
    const base = Date.parse('2026-11-07T00:00:00Z');   // 北京时间 11-07 08:00
    assert.equal(beijingDay(base), '2026-11-07', '前提：起点落在同一个北京自然日');

    // 间隔严格取 2 小时，保证这条用例里被拒的原因只可能是「日配额」而不是「间隔」。
    for (let i = 0; i < CARD_LIMITS.post; i += 1) {
      const result = reserveOfflinePost(store, { id: `post-${i}`, now: base + i * POST_INTERVAL_MS });
      assert.equal(result.allowed, true, `第 ${i + 1} 条说说必须被允许（任务卡：每天最多 3 条）`);
    }
    assert.equal(store.read().ledger.used.post, 3, '三条说说必须记满当日额度');

    const fourth = reserveOfflinePost(store, { id: 'post-4', now: base + 3 * POST_INTERVAL_MS });
    assert.deepEqual(fourth, { allowed: false, reason: 'limit' },
      '第 4 条必须被拒，且拒绝原因必须是日配额 limit（间隔此时已满足）');
    assert.equal(store.read().ledger.used.post, 3, '被拒的说说不得消耗额度');
    assert.equal(store.read().ledger.day, '2026-11-07', '被拒不得改写账本日期');
  });
});

test('[任务卡 §4-comment] 评论与回复合计每天最多 25 条：第 26 条被拒（limit）', async (t) => {
  await withStore(t, makeState(), (store) => {
    const base = Date.parse('2026-11-07T00:00:00Z');   // 北京时间 08:00，留足 25×3 分钟
    assert.equal(beijingDay(base), '2026-11-07');

    // 交替使用 comment / reply，直接证明任务卡的「评论与回复**合计**」语义。
    for (let i = 0; i < CARD_LIMITS.comment; i += 1) {
      const tool = i % 2 === 0 ? 'comment' : 'reply';
      const result = reserveOfflineInteraction(store, comment(`c-${i}`, base + i * COMMENT_INTERVAL_MS,
        `1000${i % 5}`, `p-${i}`, tool));
      assert.equal(result.allowed, true, `第 ${i + 1} 条（${tool}）必须被允许`);
    }
    assert.equal(store.read().ledger.used.comment, 25, '评论+回复必须共用同一个 25 的计数器');
    assert.equal(store.read().ledger.used.like, 0, '评论额度不得污染点赞额度');

    // 第 26 条同样取满 3 分钟，确保被拒原因是「日配额」而不是「间隔」。
    const denied = reserveOfflineInteraction(store,
      comment('c-26', base + CARD_LIMITS.comment * COMMENT_INTERVAL_MS, '10000', 'p-26'));
    assert.deepEqual(denied, { allowed: false, reason: 'limit' },
      '第 26 条必须被拒，且拒绝原因必须是合计日配额 limit');
    assert.equal(store.read().ledger.used.comment, 25, '被拒的评论不得消耗额度');
  });
});

test('[任务卡 §4-like] 点赞每天最多 30 次：第 31 次被拒（limit）', async (t) => {
  await withStore(t, makeState(), (store) => {
    const base = Date.parse('2026-11-07T00:00:00Z');
    assert.equal(beijingDay(base), '2026-11-07');

    // 点赞没有冷却间隔，所以每条用不同的 postId 绕过「同一说说只允许一次」，
    // 让被拒原因只可能是「日配额」。
    for (let i = 0; i < CARD_LIMITS.like; i += 1) {
      const result = reserveOfflineInteraction(store, like(`like-${i}`, base + i * 1000, '456', `p-${i}`));
      assert.equal(result.allowed, true, `第 ${i + 1} 次点赞必须被允许（任务卡：每天最多 30 次）`);
    }
    assert.equal(store.read().ledger.used.like, 30, '点赞额度必须记满 30');

    const denied = reserveOfflineInteraction(store, like('like-31', base + 60_000, '456', 'p-31'));
    assert.deepEqual(denied, { allowed: false, reason: 'limit' },
      '第 31 次必须被拒，且拒绝原因必须是日配额 limit');
    assert.equal(store.read().ledger.used.like, 30, '被拒的点赞不得消耗额度');
  });
});

test('[任务卡 §4-post] 任意两条说说至少间隔 2 小时：1 毫秒之差被拒（interval）', async (t) => {
  await withStore(t, makeState(), (store) => {
    const base = Date.parse('2026-11-07T00:00:00Z');
    assert.equal(reserveOfflinePost(store, { id: 'a', now: base }).allowed, true, '第 1 条必须被允许');

    const early = reserveOfflinePost(store, { id: 'b', now: base + POST_INTERVAL_MS - 1 });
    assert.deepEqual(early, { allowed: false, reason: 'interval' },
      '差 1 毫秒不足 2 小时，必须被间隔规则拒绝（任务卡：任意两条至少间隔 2 小时）');
    assert.equal(store.read().ledger.used.post, 1, '间隔被拒不得消耗额度');
    assert.equal(store.read().lastPostAt, base, '间隔被拒不得推进 lastPostAt');

    const onTime = reserveOfflinePost(store, { id: 'b', now: base + POST_INTERVAL_MS });
    assert.equal(onTime.allowed, true, '间隔恰好 2 小时的边界必须放行（边界含等于）');
    assert.equal(store.read().lastPostAt, base + POST_INTERVAL_MS, '放行后 lastPostAt 必须推进');
  });
});

test('[任务卡 §4-like] 同一说说只允许点赞一次：第二次被拒（duplicate_like）', async (t) => {
  await withStore(t, makeState(), (store) => {
    const base = Date.parse('2026-11-07T00:00:00Z');
    assert.equal(reserveOfflineInteraction(store, like('l1', base, '456', 'p1')).allowed, true,
      '第一次点赞必须被允许');

    const dup = reserveOfflineInteraction(store, like('l2', base + 1000, '456', 'p1'));
    assert.deepEqual(dup, { allowed: false, reason: 'duplicate_like' },
      '同一 (作者, 说说) 的第二次点赞必须被拒（任务卡：同一说说只允许一次）');
    assert.equal(store.read().ledger.used.like, 1, '去重被拒不得消耗额度');

    // 钉死去重键的形状：判重是 (author, postId) 而不是裸 postId。
    // 任务卡只说「同一说说」，实现按 (作者, 说说) 判定；不同作者复用同一 postId 视为不同对象。
    // 这是现状记录，不是判对错（postId 是否跨作者唯一由平台决定，不在这里假设）。
    assert.equal(reserveOfflineInteraction(store, like('l3', base + 2000, '456', 'p2')).allowed, true,
      '同一作者的另一条说说必须能点赞');
    assert.equal(reserveOfflineInteraction(store, like('l4', base + 3000, '789', 'p1')).allowed, true,
      '不同作者的同一 postId 在现实现中视为不同对象（去重键是 (author, postId)）');
    assert.equal(store.read().ledger.used.like, 3);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// B. 评论/回复的**全局** 3 分钟间隔 —— 任务卡 §4 明文要求（权威版）
// ════════════════════════════════════════════════════════════════════════════════

test('[任务卡 §4-comment] 评论间隔为全局 3 分钟（不区分对象）：A 对象评论后 1 分钟评论 B 对象必须被拒', async (t) => {
  // 任务卡 §4 原文（用户已裁决采用全局口径）：
  //
  //   | 评论与回复 | 合计每天最多 25 条；不区分对象或说说，任意两次评论/回复至少间隔 3 分钟 |
  //
  // 也就是说「同一对象 3 分钟」是**已被改掉的旧口径**：现行要求就是全局冷却，
  // 不区分对象、不区分说说。qzone-reservation-offline.mjs 取 lastCommentAt 与
  // commentTargets 的最大值，正好实现这个全局间隔。
  //
  // 因此这条**不是**「实现严于任务卡」，而是**用户裁定的正确行为**：
  //   · 换对象不能绕过冷却 —— 否则「同一对象 3 分钟」会被稀释成事实上的无间隔；
  //   · 本用例是行为闸门：谁把冷却改成按对象计算，这里会立刻变红。
  await withStore(t, makeState(), (store) => {
    const base = Date.parse('2026-11-07T00:00:00Z');
    assert.equal(beijingDay(base), '2026-11-07');

    const first = reserveOfflineInteraction(store, comment('a', base, '10001', 'p-a'));
    assert.equal(first.allowed, true, '前提：对 A 对象的评论成功');

    // B 对象（不同 target、不同 postId）在仅仅 1 分钟后 —— 全局间隔下必须被拒。
    const crossTarget = reserveOfflineInteraction(store, comment('b', base + 60_000, '10002', 'p-b'));
    assert.deepEqual(crossTarget, { allowed: false, reason: 'interval' },
      '1 分钟后评论**另一个对象**仍必须被拒：任务卡 §4 要求的是不区分对象/说说的全局 3 分钟间隔');

    // reply 与 comment 共用同一个冷却（任务卡：合计 25 条，间隔同样合并计算）。
    const crossReply = reserveOfflineInteraction(store, comment('c', base + 60_000, '10003', 'p-c', 'reply'));
    assert.deepEqual(crossReply, { allowed: false, reason: 'interval' },
      'reply 与 comment 共用同一个全局冷却（任务卡把它俩当同一类操作）');

    assert.equal(store.read().ledger.used.comment, 1, '被冷却拒掉的尝试不得消耗额度');
    assert.deepEqual(store.read().commentTargets, [{ target: '10001', time: base }],
      '被拒的跨对象尝试不得写入 commentTargets');
  });
});

test('[任务卡 §4-comment] 反向正控：冷却满 3 分钟后评论另一个对象必须放行', async (t) => {
  // 反向正控：如果这条红，说明冷却退化成了「全锁死」，那是另一种故障。
  // 必须与上面那条（跨对象被拒）分开，才能区分「全局间隔按 3 分钟生效」和「一直拒绝」。
  await withStore(t, makeState(), (store) => {
    const base = Date.parse('2026-11-07T00:00:00Z');
    assert.equal(reserveOfflineInteraction(store, comment('a', base, '10001', 'p-a')).allowed, true);

    const atBoundary = reserveOfflineInteraction(store,
      comment('b', base + COMMENT_INTERVAL_MS, '10002', 'p-b'));
    assert.equal(atBoundary.allowed, true,
      '冷却恰好满 3 分钟后，评论另一个对象必须放行（证明是冷却而不是全锁死）');
    assert.equal(store.read().ledger.used.comment, 2);

    // 同一对象在冷却内同样被拒（全局间隔的必然推论）。
    const sameTargetEarly = reserveOfflineInteraction(store,
      comment('c', base + COMMENT_INTERVAL_MS + 1, '10002', 'p-b'));
    assert.deepEqual(sameTargetEarly, { allowed: false, reason: 'interval' },
      '同一对象在 3 分钟内再评论必须被拒（全局间隔本就覆盖同一对象）');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// C. 边界：北京时间日切与跨日状态
// ════════════════════════════════════════════════════════════════════════════════

test('[任务卡 §4 日切] 北京时间 23:59 额度用尽，00:01 必须重置为可用', async (t) => {
  // 任务卡 §4：「所有日配额按北京时间每天 00:00 重置」。
  // 直接以「额度已满」的持久状态作为起点，把边界钉在时间上而不是靠跑 25 条评论。
  const lastMinute = Date.parse('2026-11-07T15:59:00Z');   // 北京 11-07 23:59
  const firstMinute = Date.parse('2026-11-07T16:01:00Z');  // 北京 11-08 00:01
  assert.equal(beijingDay(lastMinute), '2026-11-07', '前提：15:59Z 是北京 11-07 23:59');
  assert.equal(beijingDay(firstMinute), '2026-11-08', '前提：16:01Z 是北京 11-08 00:01');

  await withStore(t, makeState({
    day: '2026-11-07',
    used: { post: 3, comment: 25, like: 30 },
  }), (store) => {
    // 23:59：三种额度都必须仍然拒绝。
    assert.deepEqual(reserveOfflinePost(store, { id: 'p-before', now: lastMinute }),
      { allowed: false, reason: 'limit' }, '23:59 的发说说额度必须已用尽');
    assert.deepEqual(reserveOfflineInteraction(store, comment('c-before', lastMinute, '10001', 'p1')),
      { allowed: false, reason: 'limit' }, '23:59 的评论额度必须已用尽');
    assert.deepEqual(reserveOfflineInteraction(store, like('l-before', lastMinute, '456', 'p1')),
      { allowed: false, reason: 'limit' }, '23:59 的点赞额度必须已用尽');

    // 00:01：跨过北京零点，三种额度都必须重置。
    assert.equal(reserveOfflinePost(store, { id: 'p-after', now: firstMinute }).allowed, true,
      '00:01 发说说额度必须重置');
    assert.equal(reserveOfflineInteraction(store, comment('c-after', firstMinute, '10001', 'p1')).allowed, true,
      '00:01 评论额度必须重置');
    assert.equal(reserveOfflineInteraction(store, like('l-after', firstMinute + 1000, '456', 'p1')).allowed, true,
      '00:01 点赞额度必须重置');
    assert.equal(store.read().ledger.day, '2026-11-08', '放行后账本日期必须推进到新的北京日');
    assert.deepEqual(store.read().ledger.used, { post: 1, comment: 1, like: 1 },
      '新一天三个计数器各自从 0 起算，只记本日已用的 1 次');
  });
});

test('[任务卡 §4 日切] 发帖间隔不随日切重置：23:59 发过，00:01 仍受 2 小时间隔约束', async (t) => {
  // 这是 §4 两条规则的交互：日配额按北京日重置，但「任意两条至少间隔 2 小时」跨日仍然成立。
  // 实现用 lastPostAt 存绝对时间，天然满足；本用例把该行为钉死，避免有人「重置配额时顺手清 lastPostAt」。
  const lastMinute = Date.parse('2026-11-07T15:59:00Z');   // 北京 11-07 23:59
  const firstMinute = Date.parse('2026-11-07T16:01:00Z');  // 北京 11-08 00:01
  await withStore(t, makeState({ day: '2026-11-07', used: { post: 3 }, lastPostAt: lastMinute }), (store) => {
    const crossMidnight = reserveOfflinePost(store, { id: 'p-after', now: firstMinute });
    assert.deepEqual(crossMidnight, { allowed: false, reason: 'interval' },
      '跨过北京零点后 2 分钟内不得发第二条说说：日配额重置不等于间隔重置');
    assert.equal(store.read().lastPostAt, lastMinute, '被拒不得推进 lastPostAt');

    const later = reserveOfflinePost(store, { id: 'p-later', now: lastMinute + POST_INTERVAL_MS });
    assert.equal(later.allowed, true, '间隔满 2 小时后（已是北京 11-08）必须放行');
    assert.equal(store.read().ledger.day, '2026-11-08', '放行时账本日期才推进');
    assert.equal(store.read().ledger.used.post, 1, '新一天的 post 计数从 0 起算');
  });
});

test('[任务卡 §4-comment] 全局评论间隔跨自然日与重启保留：23:59 评论过，00:01 仍受 3 分钟约束', async (t) => {
  // 任务卡（权威版）§4 明文补的一条：
  //
  //   「评论/回复的全局间隔跨自然日和重启保留；配额重置不清除该间隔。」
  //
  // 它与「所有日配额按北京时间每天 00:00 重置」是同一条规则的两个维度：
  // 日配额（25 条）跨零点重置，但**间隔**不重置。这条是任务卡的**明文要求**，
  // 不是现状记录 —— 谁在日切时顺手清掉 lastCommentAt / commentTargets，这里立刻红。
  //
  // 同时把「重启」也覆盖进去：close 后再 open 同一份 SQLite，间隔证据必须还在。
  const lastMinute = Date.parse('2026-11-07T15:59:00Z');   // 北京 11-07 23:59
  const firstMinute = Date.parse('2026-11-07T16:01:00Z');  // 北京 11-08 00:01
  const afterCooldown = lastMinute + COMMENT_INTERVAL_MS;  // 北京 11-08 00:02
  assert.equal(beijingDay(lastMinute), '2026-11-07', '前提：15:59Z 是北京 11-07 23:59');
  assert.equal(beijingDay(firstMinute), '2026-11-08', '前提：16:01Z 是北京 11-08 00:01');
  assert.equal(beijingDay(afterCooldown), '2026-11-08', '前提：冷却结束时刻已在新北京日');

  const dir = await mkdtemp(join(tmpdir(), 'qzone-quota-conformance-'));
  const file = join(dir, 'state.db');
  const initial = makeState({ day: '2026-11-07' });
  let store = openOfflineStore(file, initial);
  t.after(async () => {
    try { store.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  });

  // 23:59（北京）评论一条，成功。
  assert.equal(reserveOfflineInteraction(store, comment('before-midnight', lastMinute, '10001', 'p-a')).allowed, true,
    '前提：北京 23:59 的这条评论必须成功');
  assert.equal(store.read().ledger.day, '2026-11-07');
  assert.equal(store.read().lastCommentAt, lastMinute, '前提：间隔证据已落盘');

  // 关闭再打开同一份库：模拟进程重启（间隔证据必须持久化，不能靠内存）。
  store.close();
  store = openOfflineStore(file, initial);
  assert.equal(store.read().lastCommentAt, lastMinute, '重启后 lastCommentAt 必须仍在');

  // 00:01（跨过北京零点，日配额已重置）评论另一个对象：仍必须被间隔拒绝。
  const crossMidnight = reserveOfflineInteraction(store, comment('after-midnight', firstMinute, '10002', 'p-b'));
  assert.deepEqual(crossMidnight, { allowed: false, reason: 'interval' },
    '跨过北京零点后 1 分钟内仍不得评论：日配额重置不等于间隔重置（任务卡明文）');
  assert.equal(store.read().lastCommentAt, lastMinute, '被拒不得推进 lastCommentAt');
  assert.equal(store.read().ledger.day, '2026-11-07',
    '间隔拒绝发生在配额检查之前，所以账本日期还停在旧的自然日（被拒事务整体回滚）');

  // 冷却满 3 分钟后（已是北京 11-08）：放行，并在这次真正落盘日切与计数重置。
  const allowed = reserveOfflineInteraction(store, comment('after-cooldown', afterCooldown, '10003', 'p-c'));
  assert.equal(allowed.allowed, true, '全局间隔满 3 分钟后必须放行（证明不是全锁死）');
  assert.equal(store.read().ledger.day, '2026-11-08', '放行时才落盘日切');
  assert.equal(store.read().ledger.used.comment, 1, '新一天 comment 计数从 0 起算，本次记为 1');
  assert.equal(store.read().lastCommentAt, afterCooldown, '放行后 lastCommentAt 必须推进到本次时间');
});

test('[现状·跨日] reservations 不随日切清空：同一 id 跨日仍判 duplicate，且被拒时不落盘日切', async (t) => {
  // 任务卡 §4 只说「日配额」按北京零点重置，没有说「预留 id 表」要清空。
  // 现实现保留 reservations，因此 id 是一次性标识而不是「每日一次」。
  // 这条只记录实际行为（不判对错），并钉死一个容易忽略的副作用：
  // 被拒的那次 update 会回滚，所以「日期推进」只在真正放行时才落盘。
  const day1 = Date.parse('2026-11-07T00:00:00Z');          // 北京 11-07 08:00
  const day2 = Date.parse('2026-11-08T00:00:00Z');          // 北京 11-08 08:00（跨过零点）
  assert.equal(beijingDay(day1), '2026-11-07');
  assert.equal(beijingDay(day2), '2026-11-08');

  await withStore(t, makeState({ day: '2026-11-07' }), (store) => {
    // 第一天用掉一个 id（额度本身没记满，隔离出「id 重复」这一个变量）。
    assert.equal(reserveOfflineInteraction(store, comment('same-id', day1, '10001', 'p1')).allowed, true);

    // 第二天用同一个 id：日配额已重置，仍然被 duplicate 拒绝 → reservations 跨日保留。
    const reused = reserveOfflineInteraction(store, comment('same-id', day2, '10002', 'p2'));
    assert.deepEqual(reused, { allowed: false, reason: 'duplicate' },
      '现实现中 reservations 不跨日清空：同一 id 在次日仍判 duplicate');

    // 被拒的那次事务回滚，所以账本日期与计数都还停在昨天（只有放行才会落盘日切）。
    assert.equal(store.read().ledger.day, '2026-11-07', '被拒的跨日尝试不得落盘日切');
    assert.equal(store.read().ledger.used.comment, 1, '被拒不得改动计数');

    // 换一个新鲜 id 在第二天：放行，并在这次真正完成日切与重置。
    assert.equal(reserveOfflineInteraction(store, comment('fresh-id', day2, '10003', 'p3')).allowed, true,
      '新鲜的 id 在次日必须放行（证明不是整体锁死）');
    assert.equal(store.read().ledger.day, '2026-11-08', '放行时才落盘日切');
    assert.equal(store.read().ledger.used.comment, 1, '新一天计数从 0 起算，本次记为 1');
    assert.equal(Object.hasOwn(store.read().ledger.reservations, 'same-id'), true,
      '旧 id 仍留在 reservations 里（这是现状记录）');
    assert.equal(Object.hasOwn(store.read().ledger.reservations, 'fresh-id'), true);
  });
});
