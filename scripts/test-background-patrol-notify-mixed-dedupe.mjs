// scripts/test-background-patrol-notify-mixed-dedupe.mjs
// task-132：对 task-131 只读复核意见的 TDD 测试（先红后绿）。
//
// 复核意见（GPT/task-131 审计）：
//  1) 旧式无 ID 与新式带 ID 混用时，旧 findDuplicate 会按 event+reason 吞掉新式独立事件；
//     关键状态转换应在全链使用同一稳定转换 ID，并测试正反混用。
//  2) recent 按 entry.at 裁剪而非 deliveredAt：长时间 pending 刚刚成功投递后，
//     可能立刻失去去重记录；需要最小修正与测试。
//  3) 排队降级 / markDelivered 落盘失败时，单靠 lastReject 不能覆盖所有失败，
//     需要明确观测并保留重试。
//
// 本测试锁定的新契约：
//  A. 去重按「记录形态」隔离：带 operationId 的入队只与带 operationId 的记录比较；
//     旧式（无 operationId）入队只与旧式记录比较。两者不得互相吞掉。
//  B. recent 的保留窗口以 deliveredAt（缺省回退 at）计算，而非 at。
//  C. markDelivered 落盘失败：status().lastFailure = { operation:'markDelivered', reason:'persist-failed', at }，
//     degraded=true；pending 记录保留（可重试）；reload() 后重试成功。
//  既有字段/语义（旧式 event+reason 10 分钟去重、lastReject）不变。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BACKGROUND_PATROL_NOTIFY_DEDUPE_WINDOW_MS,
  createBackgroundPatrolNotifyQueue,
} from '../src/core/background-patrol-notify.mjs';

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 28, 2, 0, 0); // 北京时间 2026-10-28 10:00

const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeRig(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhh-notify-mixed-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'notify-queue.json');
  let now = T0;
  const clock = () => now;
  const opened = [];
  return {
    dir,
    filePath,
    setNow: (value) => { now = value; },
    async open(overrides = {}) {
      const queue = createBackgroundPatrolNotifyQueue({ filePath, clock, ...options, ...overrides });
      await queue.load();
      opened.push(queue);
      return queue;
    },
    async closeAll() {
      for (const queue of opened) await queue.close?.().catch(() => {});
      opened.length = 0;
    },
  };
}

function expectOk(result, label = '') {
  assert.equal(result?.ok, true, `${label} 期望 ok:true，实际 ${JSON.stringify(result)}`);
  return result;
}

function expectDuplicate(result, label = '') {
  assert.equal(result?.ok, true, `${label} 期望 ok:true，实际 ${JSON.stringify(result)}`);
  assert.equal(result?.duplicate, true, `${label} 期望 duplicate:true，实际 ${JSON.stringify(result)}`);
  return result;
}

function expectRejected(result, reason, label = '') {
  assert.equal(result?.ok, false, `${label} 期望 ok:false，实际 ${JSON.stringify(result)}`);
  assert.equal(result?.reason, reason, `${label} 期望 reason:${reason}，实际 ${JSON.stringify(result)}`);
  return result;
}

test('混用去重 A1：旧式 pending 不吞带 ID 的独立新事件（同 event+reason，窗口内）', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  // 旧式记录（无 operationId）先入队。
  expectOk(await queue.enqueue({ event: 'write-paused', reason: 'consecutive-failures', at: T0 }));
  // 新式独立转换：同 event + 同 reason，但在 10 分钟窗口内，必须能入队。
  const fresh = expectOk(await queue.enqueue({
    event: 'write-paused',
    reason: 'consecutive-failures',
    meta: { operationId: 'transition-new-1' },
    at: T0 + 1000,
  }));
  assert.equal(fresh.duplicate, false);
  assert.equal((await queue.snapshot()).items.length, 2);
  await rig.closeAll();
});

test('混用去重 A2：带 ID 的 pending 不吞旧式事件（同 event+reason，窗口内）', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  expectOk(await queue.enqueue({
    event: 'recovered',
    reason: 'admin-recover',
    meta: { operationId: 'transition-new-2' },
    at: T0,
  }));
  const legacy = expectOk(await queue.enqueue({
    event: 'recovered',
    reason: 'admin-recover',
    at: T0 + 1000,
  }));
  assert.equal(legacy.duplicate, false);
  assert.equal((await queue.snapshot()).items.length, 2);
  await rig.closeAll();
});

test('混用去重 A3：同一稳定 ID 仍去重（忽略 reason），不同 ID 各自入队', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  expectOk(await queue.enqueue({
    event: 'recovered',
    reason: 'admin-recover',
    meta: { operationId: 'transition-x' },
    at: T0,
  }));
  expectDuplicate(await queue.enqueue({
    event: 'recovered',
    reason: 'admin-recover-retry',
    meta: { operationId: 'transition-x' },
    at: T0 + MINUTE,
  }));
  expectOk(await queue.enqueue({
    event: 'recovered',
    reason: 'admin-recover',
    meta: { operationId: 'transition-y' },
    at: T0 + 2 * MINUTE,
  }));
  assert.equal((await queue.snapshot()).items.length, 2);
  await rig.closeAll();
});

test('混用去重 A4：旧式之间的 10 分钟语义保持不变（回归保护）', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  expectOk(await queue.enqueue({ event: 'access-paused', reason: 'login-required', at: T0 }));
  expectDuplicate(await queue.enqueue({ event: 'access-paused', reason: 'login-required', at: T0 + MINUTE }));
  await rig.closeAll();
});

test('裁剪 B：recent 以 deliveredAt 计算保留窗口（长时间 pending 刚投递仍可去重）', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  const pending = expectOk(await queue.enqueue({
    event: 'recovered',
    reason: 'admin-recover',
    meta: { operationId: 'transition-late' },
    at: T0,
  }));
  // 30 分钟后才成功投递：按旧逻辑（at 窗口）这条 recent 会被立刻裁掉。
  rig.setNow(T0 + 30 * MINUTE);
  expectOk(await queue.markDelivered({ id: pending.id, delivered: true, at: T0 + 30 * MINUTE }));
  let snapshot = await queue.snapshot();
  assert.equal(snapshot.recent.length, 1, '刚投递的 recent 不应被立即裁剪');

  // 再入队一次同 ID：仍应判重（记录仍在窗口内）。
  const replay = expectDuplicate(await queue.enqueue({
    event: 'recovered',
    reason: 'admin-recover-replayed',
    meta: { operationId: 'transition-late' },
    at: T0 + 31 * MINUTE,
  }));
  assert.equal(replay.existing.delivered, true);

  // 超过 deliveredAt + 窗口后才允许裁剪。
  rig.setNow(T0 + 30 * MINUTE + BACKGROUND_PATROL_NOTIFY_DEDUPE_WINDOW_MS + 1);
  expectOk(await queue.enqueue({ event: 'write-paused', reason: 'after-window', at: T0 + 30 * MINUTE + BACKGROUND_PATROL_NOTIFY_DEDUPE_WINDOW_MS + 1 }));
  snapshot = await queue.snapshot();
  assert.equal(snapshot.recent.length, 0, '超过 deliveredAt 窗口后应被裁剪');
  await rig.closeAll();
});

test('失败观测 C：markDelivered 落盘失败暴露 lastFailure、保留 pending、reload 后可重试', async () => {
  const rig = await makeRig();
  let renameCalls = 0;
  let failRename = false;
  const queue = await rig.open({
    fsOps: {
      rename: async (from, to) => {
        renameCalls += 1;
        if (failRename) {
          const error = new Error('simulated EACCES');
          error.code = 'EACCES';
          throw error;
        }
        return fs.rename(from, to);
      },
    },
  });
  const pending = expectOk(await queue.enqueue({
    event: 'write-paused',
    reason: 'consecutive-failures',
    meta: { operationId: 'transition-fail' },
    at: T0,
  }));
  assert.equal(renameCalls, 1);

  failRename = true;
  expectRejected(await queue.markDelivered({ id: pending.id, delivered: true, at: T0 + 1000 }), 'persist-failed');
  const failedStatus = await queue.status();
  assert.equal(failedStatus.degraded, true);
  assert.equal(failedStatus.lastFailure?.operation, 'markDelivered');
  assert.equal(failedStatus.lastFailure?.reason, 'persist-failed');
  assert.equal(failedStatus.lastFailure?.at, T0 + 1000);
  assert.equal(failedStatus.lastReject, null, 'markDelivered 失败不应冒充 enqueue 拒绝');

  // 失败后 pending 仍在（保留重试），且 degrade 期间其它操作被拒。
  assert.equal((await queue.snapshot()).items.length, 1);
  expectRejected(await queue.enqueue({ event: 'recovered', reason: 'blocked', at: T0 + 1001 }), 'degraded');

  // 修复写入后 reload 并重试：成功移除并进入 recent（含 operationId）。
  failRename = false;
  expectOk(await queue.reload());
  assert.equal((await queue.status()).lastFailure, null, 'reload 成功后应清掉 lastFailure（P3）');
  expectOk(await queue.markDelivered({ id: pending.id, delivered: true, at: T0 + 2000 }));
  const okStatus = await queue.status();
  assert.equal(okStatus.degraded, false);
  assert.equal((await queue.snapshot()).items.length, 0);
  const snapshot = await queue.snapshot();
  assert.equal(snapshot.recent.length, 1);
  assert.equal(snapshot.recent[0].operationId, 'transition-fail');
  await rig.closeAll();
});

test('失败观测 C2：初始 lastFailure 为 null（新增字段不破坏既有调用方）', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  const status = await queue.status();
  assert.equal(Object.prototype.hasOwnProperty.call(status, 'lastFailure'), true);
  assert.equal(status.lastFailure, null);
  assert.equal(status.lastReject, null);
  await rig.closeAll();
});

test('混用去重 A5：带 ID 的 recent 不吞旧式事件（recent 侧形态隔离）', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  const pending = expectOk(await queue.enqueue({
    event: 'recovered',
    reason: 'admin-recover',
    meta: { operationId: 'transition-recent-iso' },
    at: T0,
  }));
  expectOk(await queue.markDelivered({ id: pending.id, delivered: true, at: T0 + 1000 }));
  // 旧式事件：同 event + 同 reason，at 在窗口内；若 recent 侧不隔离 operationId，会被误判 duplicate。
  const legacy = expectOk(await queue.enqueue({
    event: 'recovered',
    reason: 'admin-recover',
    at: T0 + 2000,
  }));
  assert.equal(legacy.duplicate, false);
  assert.equal((await queue.snapshot()).items.length, 1);
  await rig.closeAll();
});

test('混用去重 A6：同一 operationId 跨 event 不得互相吞（ID 需配合 event 维度）', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  // 生产侧应保证 ID 全局唯一；但队列契约仍须把 event 纳入比较，避免同一 ID 跨事件时漏报。
  expectOk(await queue.enqueue({
    event: 'write-paused',
    reason: 'consecutive-failures',
    meta: { operationId: 'shared-id' },
    at: T0,
  }));
  const recovered = await queue.enqueue({
    event: 'recovered',
    reason: 'admin-recover',
    meta: { operationId: 'shared-id' },
    at: T0 + 1000,
  });
  expectOk(recovered);
  assert.equal(recovered.duplicate, false, '不同 event 即使同 ID 也必须各自入队');
  assert.equal((await queue.snapshot()).items.length, 2);
  await rig.closeAll();
});

test('混用去重 A6b：recent 侧同一 operationId 跨 event 不得互相吞（recent 也需 event 维度）', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  const pending = expectOk(await queue.enqueue({
    event: 'write-paused',
    reason: 'consecutive-failures',
    meta: { operationId: 'shared-recent-id' },
    at: T0,
  }));
  rig.setNow(T0 + 1000);
  expectOk(await queue.markDelivered({ id: pending.id, delivered: true, at: T0 + 1000 }));

  const recovered = await queue.enqueue({
    event: 'recovered',
    reason: 'admin-recover',
    meta: { operationId: 'shared-recent-id' },
    at: T0 + 2000,
  });
  expectOk(recovered);
  assert.equal(recovered.duplicate, false, 'recent 侧不同 event 即使同 ID 也必须各自入队');
  assert.equal((await queue.snapshot()).items.length, 1);
  await rig.closeAll();
});

test('裁剪 B2：deliveredAt + 窗口的精确边界保留，超出 1ms 才裁剪', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  const pending = expectOk(await queue.enqueue({
    event: 'recovered',
    reason: 'admin-recover',
    meta: { operationId: 'transition-boundary' },
    at: T0,
  }));
  const deliveredAt = T0 + 5 * MINUTE;
  rig.setNow(deliveredAt);
  expectOk(await queue.markDelivered({ id: pending.id, delivered: true, at: deliveredAt }));

  // 恰好等于窗口：仍应保留。
  rig.setNow(deliveredAt + BACKGROUND_PATROL_NOTIFY_DEDUPE_WINDOW_MS);
  expectOk(await queue.enqueue({
    event: 'write-paused',
    reason: 'boundary-keep',
    at: deliveredAt + BACKGROUND_PATROL_NOTIFY_DEDUPE_WINDOW_MS,
  }));
  assert.equal((await queue.snapshot()).recent.length, 1, '恰好窗口边界应保留');

  // 超出 1ms：应被裁剪。
  rig.setNow(deliveredAt + BACKGROUND_PATROL_NOTIFY_DEDUPE_WINDOW_MS + 1);
  expectOk(await queue.enqueue({
    event: 'write-paused',
    reason: 'boundary-prune',
    at: deliveredAt + BACKGROUND_PATROL_NOTIFY_DEDUPE_WINDOW_MS + 1,
  }));
  assert.equal((await queue.snapshot()).recent.length, 0, '超出窗口 1ms 应裁剪');
  await rig.closeAll();
});

