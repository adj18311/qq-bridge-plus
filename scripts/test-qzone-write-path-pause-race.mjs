// 定性测试：最终暂停检查（stage 1b）之后的窗口 —— 「检查返回」到「transport 调用」之间。
//
// 这个文件**不判对错、不改实现**，只把 `src/core/qzone-write-path-offline.mjs` 的真实时序
// 钉成可复核的读数，好让「检查的保障范围」这个说法有据可依。
//
// ── 被钉死的时序（来自实现，逐行可核） ────────────────────────────────────────────────
//
//   stage 1   reserveOfflinePost / reserveOfflineInteraction
//               └─ 内部一次 store.update：BEGIN IMMEDIATE … COMMIT  → **锁在这里释放**
//   stage 1b  finalAuthorisationCheck(action)
//               └─ 也是一次 store.update(state => state)：
//                    BEGIN IMMEDIATE → read → authorizeTool(state) → COMMIT → **锁在这里释放**
//                  检查在**事务内**完成，所以「检查那一刻」的状态是可信的：此刻已暂停则一定不发送。
//   ←── 窗口在这里打开：stage 1b 的 COMMIT 之后、下一行 await transport(...) 之前 ──→
//   stage 2   await transport(...)，独立调用，**此时不持有任何锁**
//
// 窗口内另一个写者可以提交 `writePaused: true`。本文件用「同一个 SQLite 文件上的第二个连接」
// 扮演那个写者（见下面 notes 里对「这不是真并发进程」的说明），并在**精确的交错点**注入，
// 于是把结论变成可复现的读数而不是竞态运气：
//
//   · 注入点在 stage 1b 之前 → transport 零调用（正面：检查时已暂停则不发）
//   · 注入点在 stage 1b 之后 → **transport 仍然被调用**，且被调用那一刻 writePaused 已经是 true
//
// ── 本文件明确**不**主张的事 ──────────────────────────────────────────────────────────
//   ❌ 检查与发送是原子的
//   ❌ 暂停不可能被违反
//   ❌ 最终检查消除了 check-then-act
//   ✅ 它把窗口从「reserve 之后」缩短到「检查返回之后」；窗口仍然存在，跨进程写入可以插进来。
//
// ── 关于「另一个写者」的诚实说明 ──────────────────────────────────────────────────────
// 真正的第二个**进程**无法在亚毫秒级边界上被确定性地交错，所以这里用同一 SQLite 文件上的
// **第二个 DatabaseSync 连接**（`openOfflineStore` 再打开一次同一个 dbPath）来扮演它：
//   · 它是**独立的连接与独立的事务**，不是同一个 store 句柄，能真实证明「锁已释放、写入成功」；
//   · 但它跑在**同一个进程**里，所以本文件证明的是「窗口存在且窗口内写入可以生效」，
//     **不**证明真实多进程调度下的概率分布。概率/时序分布需要另一套压测，不在本文件里。

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createOfflineWritePath } from '../src/core/qzone-write-path-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';

const T0 = 1_800_000_000_000;
const DAY0 = beijingDay(T0);
const TARGET = '9876543210';

function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-wpath-race-${label}-`));
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
  tools: { publish: true, comment: true, reply: true, like: true, read_posts: true },
  limits: { post: 3, comment: 25, like: 30 },
  ledger: { day: DAY0, used: { post: 0, comment: 0, like: 0 }, reservations: {} },
  lastPostAt: null,
  lastCommentAt: null,
  commentTargets: [],
  likes: [],
  ...over,
});

const write = (over = {}) => ({
  id: 'w-1', action: 'publish', target: TARGET, postId: 'p-1', source: 'qq', content: 'hi', ...over,
});

/**
 * 搭一个 world，并把 store.update 按「是不是最终检查」分流，好在精确点注入暂停。
 *
 * 如何识别最终检查：`finalAuthorisationCheck` 的回调**原样返回它收到的 state**（identity），
 * 而两个 reserve 入口成功时都返回**新对象**、失败时抛 Denied（事务回滚）。所以
 * `next === state` 唯一指向 stage 1b。
 */
function world({ injectAt }) {
  const t = tempDb('w');
  const store = openOfflineStore(t.dbPath, baseState());
  // 第二个连接 = 扮演「另一个写者」。它读的是同一个文件，用自己独立的事务。
  const otherWriter = openOfflineStore(t.dbPath, baseState());

  let now = T0;
  const calls = [];
  /** 每次 transport 被调用时，从**第二条连接**读到的现场。 */
  const transportSightings = [];
  const injections = [];

  let updates = 0;
  let permittingCheckReturned = false;
  let injected = false;

  const injectPause = (when) => {
    injected = true;
    const before = otherWriter.read().writePaused;
    // 真正通过**另一个连接**提交，独立事务。它成功本身就说明主流程此时不持有写锁。
    otherWriter.update((s) => ({ ...s, writePaused: true }));
    const after = otherWriter.read().writePaused;
    injections.push({ when, writePausedBefore: before, writePausedAfter: after, atUpdateIndex: updates });
    assert.equal(before, false, `注入前 writePaused 必须是 false（when=${when}）`);
    assert.equal(after, true, `注入必须真的落盘到同一个文件（when=${when}）—— 这只能说明写入成功，不等于主流程不持锁`);
  };

  // SPREAD: the racing wrapper must be the SAME send authority as the database it races, otherwise
  // a fault latched through the wrapper would be invisible to the real handle (Codex §A).
  const racingStore = {
    ...store,
    update(fn) {
      // WHICH TRANSACTION IS THIS? (t69 / M3 reverted to the "no new object" branch.)
      //
      // History, because this heuristic has now moved twice:
      //   · originally: stage 1b was a no-mutation check, so it detected itself by the callback
      //     returning the SAME state object.
      //   · t66/M3: the check wrote a one-shot permit, so it returned a NEW state; the identity test
      //     stopped firing and this harness switched to "did the number of permits grow?".
      //   · t69: that permit collection is GONE (v6 §2.4 — no new object; a test's observation need
      //     is not a business reason to add one). The check again returns the state unchanged, so the
      //     identity marker is valid again — and it is now the ONLY difference left between the two
      //     transactions inside one `write()` call, because neither of them creates anything.
      //
      // `reserveOffline*` always returns a NEW object on success (and throws a `Denied` on refusal,
      // which rolls back), so `next === state` can only be stage 1b.
      let createdPermit = false;
      const out = store.update((state) => {
        const next = fn(state);
        if (next === state) createdPermit = true;
        return next;
      });
      updates += 1;
      // ← 此刻 store.update 已经 COMMIT 并返回：锁已释放。
      if (createdPermit) {
        permittingCheckReturned = true;
        if (injectAt === 'after-final-check' && !injected) injectPause('after-final-check');
      } else if (injectAt === 'after-reserve' && !injected && !permittingCheckReturned) {
        injectPause('after-reserve');
      }
      return out;
    },
  };

  const pathHandle = createOfflineWritePath({
    store: racingStore,
    limits: baseState().limits,
    clock: () => now,
    transport: async (req) => {
      calls.push(req);
      // 在 transport **被调用时**读取现场：这是「发送发生在暂停之后」的直接证据。
      transportSightings.push({
        writePausedAtTransportTime: otherWriter.read().writePaused,
        finalCheckReturned: permittingCheckReturned,
      });
      return { ok: true };
    },
  });

  return {
    t, store, otherWriter, path: pathHandle, calls, transportSightings, injections,
    dbPath: t.dbPath,
    advance: (ms) => { now += ms; },
    readState: () => store.read(),
    readLedger: () => store.read().ledger,
    updateIndex: () => updates,
    close() {
      try { store.close(); } catch {}
      try { otherWriter.close(); } catch {}
      t.cleanup();
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════
// 正面：注入点在 stage 1b **之前** → 检查时已暂停 → transport 零调用
// ══════════════════════════════════════════════════════════════════════════════════════

test('RACE-1 正面独立证明：暂停在最终检查之前落盘 → transport 零调用（transportCalled:false）', async () => {
  const w = world({ injectAt: 'after-reserve' });
  try {
    const out = await w.path.write(write({ id: 'a' }));

    // 注入确实发生在 reserve 之后、最终检查之前。
    assert.equal(w.injections.length, 1);
    assert.equal(w.injections[0].when, 'after-reserve');
    assert.equal(w.injections[0].writePausedAfter, true, '前提：暂停真的写进了同一个库（第二个连接）');

    // 最终检查在事务内看到了这个暂停，于是决定不发送。
    assert.equal(out.ok, false, `应被最终检查拦下，实际 ${JSON.stringify(out)}`);
    assert.equal(out.stage, 'transport');
    assert.equal(out.outcome, 'not-sent');
    assert.equal(out.reason, 'paused-before-send');
    assert.equal(out.transportCalled, false, '检查时已暂停 → 绝不发送');
    assert.equal(out.quotaConsumed, true, '配额已消耗必须如实报告（预留先于暂停，不可退）');

    assert.equal(w.calls.length, 0, 'transport 一次都没有被调用');
    assert.equal(w.transportSightings.length, 0);
    assert.equal(w.readLedger().used.post, 1, '预留已落盘：used 从 0 变成 1，且不会退回');
    assert.equal(w.readState().writePaused, true);
  } finally { w.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 窗口：注入点在 stage 1b **之后**、transport 调用之前 → transport **仍然被调用**
// ══════════════════════════════════════════════════════════════════════════════════════

test('RACE-2 窗口定性：最终检查返回未暂停后、transport 调用前写入 writePaused → transport 仍被调用', async () => {
  const w = world({ injectAt: 'after-final-check' });
  try {
    const out = await w.path.write(write({ id: 'b' }));

    // ① 注入点确实在最终检查**返回之后**。
    assert.equal(w.injections.length, 1);
    assert.equal(w.injections[0].when, 'after-final-check');
    assert.equal(w.injections[0].writePausedBefore, false, '注入前（即最终检查当时）确实是未暂停');
    assert.equal(w.injections[0].writePausedAfter, true, '暂停通过第二个连接成功落盘');

    // ② 关键读数：transport **仍然被调用**了。
    assert.equal(w.calls.length, 1, '窗口内落盘的暂停没有阻止 transport');
    assert.equal(out.ok, true, `实际行为：发送照常进行，实际 ${JSON.stringify(out)}`);
    assert.equal(out.stage, 'transport');
    assert.equal(out.outcome, 'success');
    assert.equal(out.transportCalled, true, '窗口口径下 transportCalled 是 true —— 与 RACE-1 的分水岭');
    assert.equal(out.quotaConsumed, true);

    // ③ 直接证据：transport 被调用的**那一刻**，库里的 writePaused 已经是 true。
    assert.equal(w.transportSightings.length, 1);
    assert.equal(w.transportSightings[0].finalCheckReturned, true, '调用前最终检查已经返回过');
    assert.equal(w.transportSightings[0].writePausedAtTransportTime, true,
      'transport 调用时 writePaused 已经为 true：发送确实发生在暂停提交之后');

    // ④ 这就是窗口本身：最终检查通过了，但暂停仍然生效了，而消息已经发出。
    assert.equal(w.readState().writePaused, true, '发送之后库里的暂停状态仍然是 true');
    assert.equal(w.readLedger().used.post, 1, '配额照常 +1');
  } finally { w.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 窗口的边界刻画：两个注入点只差「一个 update 的返回」，结论就相反
// ══════════════════════════════════════════════════════════════════════════════════════

test('RACE-3 窗口边界：同一个注入手法，早一格 → 不发送；晚一格 → 照发（唯一变量是注入点）', async () => {
  // 两条支线用完全相同的 store 包装、相同的注入函数、相同的 transport，
  // 唯一差别是 `injectAt`。所以结论的差异只能归因于「注入发生在最终检查之前还是之后」。
  const early = world({ injectAt: 'after-reserve' });
  const late = world({ injectAt: 'after-final-check' });
  try {
    const earlyOut = await early.path.write(write({ id: 'c-early' }));
    const lateOut = await late.path.write(write({ id: 'c-late' }));

    assert.equal(early.calls.length, 0, '早一格：transport 未被调用');
    assert.equal(earlyOut.transportCalled, false);
    assert.equal(earlyOut.reason, 'paused-before-send');

    assert.equal(late.calls.length, 1, '晚一格：transport 被调用');
    assert.equal(lateOut.transportCalled, true);

    // 最锋利的一句读数：两种情况下暂停都真的生效了，区别只在它何时生效。
    assert.equal(early.readState().writePaused, true);
    assert.equal(late.readState().writePaused, true);
    assert.equal(late.transportSightings[0].writePausedAtTransportTime, true,
      '晚一格时，暂停在发送那一刻已经生效，但发送仍然发生了');
  } finally { early.close(); late.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 顺带钉死：最终检查确实在**事务内**读状态（所以它能看见窗口之前的任何提交）
// ══════════════════════════════════════════════════════════════════════════════════════

test('RACE-4 前提核实：最终检查用 store.update（拿写锁）而不是 read，且会看见此前任何已提交的暂停', async () => {
  // 这条不测窗口，只测「检查比朴素 read 强在哪」：它在事务内读，所以检查**那一刻**的状态可信。
  // 同时它明确**不**证明「检查与发送原子」—— 见 RACE-2。
  const w = world({ injectAt: null });
  try {
    const out = await w.path.write(write({ id: 'd' }));
    assert.equal(out.ok, true);
    // 一次成功的 publish：reserve 一次 update + 最终检查一次 update = 2 次。
    assert.equal(w.updateIndex(), 2,
      '每次成功写恰好两次 store.update：先 reserve，再最终检查（后者的回调原样返回 state）');
  } finally { w.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// `paused-before-send` 的真实代价：预留已经落盘，配额与冷却证据都被占用
// ══════════════════════════════════════════════════════════════════════════════════════
//
// 上面几条只说明「没发送」。但 `not-sent` 分支**不退任何东西**：stage 1 的 reserve 事务
// 已经提交，配额 +1、`lastCommentAt` 推进、`commentTargets` 写入（like 则是去重标记写入）。
// 这一节把这些代价逐项量出来 —— 它们是「(b) 再检查一次」这个设计选择的实际账单。

test('RACE-5 代价（评论）：paused-before-send 之后配额 +1、冷却时间戳推进，1 分钟后评论另一对象仍被 interval 拒', async () => {
  // 用 comment 走同一条链路：reserve 成功 → 暂停在最终检查之前落盘 → 不发送。
  const w = world({ injectAt: 'after-reserve' });
  try {
    const out = await w.path.write(write({
      id: 'cost-comment-1', action: 'comment', target: '10001', postId: 'p-a', content: 'hello',
    }));

    // ── ① 没有发送 ────────────────────────────────────────────────────────────────
    assert.equal(out.ok, false);
    assert.equal(out.outcome, 'not-sent');
    assert.equal(out.reason, 'paused-before-send');
    assert.equal(out.transportCalled, false);
    assert.equal(w.calls.length, 0, 'transport 零调用');

    // ── ② 但代价已经产生：配额 +1 ────────────────────────────────────────────────
    assert.equal(out.quotaConsumed, true);
    assert.equal(w.readLedger().used.comment, 1,
      '配额已经 +1：reserve 事务在暂停出现之前就提交了，且不退');

    // ── ③ 冷却证据也被占用了 ─────────────────────────────────────────────────────
    const stuckCooldown = w.readState().lastCommentAt;
    assert.equal(stuckCooldown, T0,
      'lastCommentAt 已被推到本次时间：reserveOfflineInteraction 在同一个事务里写了冷却证据');
    assert.deepEqual(w.readState().commentTargets, [{ target: '10001', time: T0 }],
      'commentTargets 也被写入（与 lastCommentAt 是同一份冷却证据）');

    // ── ④ 恢复之后，1 分钟内评论**另一个对象**仍被 interval 拒 ────────────────────
    // 先解除暂停，否则下一个调用会先撞 write_paused，看不到冷却这一层。
    w.otherWriter.update((s) => ({ ...s, writePaused: false }));
    w.advance(60_000);   // 1 分钟后，另一个对象
    const followUp = await w.path.write(write({
      id: 'cost-comment-2', action: 'comment', target: '10002', postId: 'p-b', content: 'again',
    }));
    assert.equal(followUp.ok, false, '1 分钟后评论另一对象必须被拒');
    assert.equal(followUp.stage, 'reserve');
    assert.deepEqual(followUp, { ok: false, stage: 'reserve', reason: 'interval' },
      '拒因是 interval：这次「没发出去」的调用把全局 3 分钟冷却也一起消耗掉了');
    assert.equal(w.calls.length, 0, '被冷却拒掉的那次同样没有发送');
    assert.equal(w.readLedger().used.comment, 1, '被拒的第二次不消耗配额');

    // ── ⑤ 反向正控：冷却满 3 分钟后必须恢复可写 ─────────────────────────────────
    w.advance(3 * 60 * 1000 - 60_000);
    const afterCooldown = await w.path.write(write({
      id: 'cost-comment-3', action: 'comment', target: '10003', postId: 'p-c', content: 'later',
    }));
    assert.equal(afterCooldown.ok, true, '冷却满 3 分钟后必须放行（证明不是整体锁死）');
    assert.equal(w.calls.length, 1);
    assert.equal(w.readLedger().used.comment, 2);
  } finally { w.close(); }
});

test('RACE-6 代价（点赞）：paused-before-send 之后同帖去重标记已被占用，后续点赞被判 duplicate_like', async () => {
  // like 的代价比评论更尖锐：冷却会自然过期，但**同帖去重标记永久保留**（没有 TTL、没有清理）。
  const w = world({ injectAt: 'after-reserve' });
  try {
    const out = await w.path.write(write({
      id: 'cost-like-1', action: 'like', target: '777', postId: 'post-1', content: undefined,
    }));

    assert.equal(out.ok, false);
    assert.equal(out.outcome, 'not-sent');
    assert.equal(out.reason, 'paused-before-send');
    assert.equal(out.transportCalled, false);
    assert.equal(w.calls.length, 0, '这条「点赞」根本没有发出去');

    // 配额 +1，且去重标记已写入。
    assert.equal(w.readLedger().used.like, 1, '点赞配额已 +1');
    assert.deepEqual(w.readState().likes, [{ author: '777', id: 'post-1' }],
      '同帖去重标记已占用：即使什么都没发出去');

    // 解除暂停，再点同一帖 → duplicate_like。这就是「没发出去也无法重试」的形态。
    w.otherWriter.update((s) => ({ ...s, writePaused: false }));
    w.advance(1000);
    const retry = await w.path.write(write({
      id: 'cost-like-2', action: 'like', target: '777', postId: 'post-1', content: undefined,
    }));
    assert.deepEqual(retry, { ok: false, stage: 'reserve', reason: 'duplicate_like' },
      '同帖再点赞被去重规则拒：这条没发出去的点赞永久占用了该帖的点赞名额');
    assert.equal(w.readLedger().used.like, 1, '被拒的重试不再消耗配额');

    // 另一帖仍然可以点赞（证明是「这一帖」被占用，不是点赞整体坏掉）。
    const otherPost = await w.path.write(write({
      id: 'cost-like-3', action: 'like', target: '777', postId: 'post-2', content: undefined,
    }));
    assert.equal(otherPost.ok, true, '另一帖必须仍可点赞');
    assert.equal(w.calls.length, 1);
    assert.equal(w.readLedger().used.like, 2);
  } finally { w.close(); }
});
