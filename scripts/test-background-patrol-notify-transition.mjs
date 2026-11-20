// scripts/test-background-patrol-notify-transition.mjs
// task-131：通知队列「按状态转换去重 + 拒绝可观察」的 TDD 测试（先红后绿）。
//
// 背景（Codex 复审 task-29 的建议）：
//  · 旧去重仅按 `event + reason` 在 10 分钟窗口内 → 10 分钟内两次独立恢复（transition）
//    会被误吞；反过来，恢复/暂停事件的 reason 若被重新措辞，又可能重复通知。
//  · 队列满 / 持久化失败目前只返回 reason，桥接侧没有可观察状态可用于告警。
//
// 本测试锁定的新契约（向后兼容）：
//  1) 入队 meta 带 operationId 时，按 (event, operationId) 去重，忽略 reason，且 pending 中
//     的记录不受 10 分钟窗口限制（转换标识天然唯一）；已投递的 recent 也按 operationId 去重。
//  2) 未带 operationId 时保持旧语义：event + reason 在 10 分钟窗口内去重。
//  3) status() 暴露 lastReject（最近一次因 queue-full / persist-failed 被拒的时间与原因），
//     供桥接侧告警；不影响既有字段。
//  4) 旧版状态文件（recent 无 operationId）仍可加载；recent 带 operationId 可持久化/重启恢复。
//
// 纯离线：只用 os.tmpdir 临时目录与注入时钟；不联网、不发 QQ、不读 config/state。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BACKGROUND_PATROL_NOTIFY_MAX_PENDING,
  createBackgroundPatrolNotifyQueue,
} from '../src/core/background-patrol-notify.mjs';

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 27, 6, 0, 0); // 北京时间 2026-10-27 14:00

const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeRig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhh-notify-transition-'));
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
      const queue = createBackgroundPatrolNotifyQueue({ filePath, clock, ...overrides });
      await queue.load();
      opened.push(queue);
      return queue;
    },
    createRaw(overrides = {}) {
      return createBackgroundPatrolNotifyQueue({ filePath, clock, ...overrides });
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

test('旧语义保留：无 operationId 时同 event+reason 在 10 分钟内仍去重', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  const first = expectOk(await queue.enqueue({ event: 'write-paused', reason: 'consecutive-failures', at: T0 }));
  const again = expectDuplicate(await queue.enqueue({ event: 'write-paused', reason: 'consecutive-failures', at: T0 + MINUTE }));
  assert.equal(again.existing.id, first.id);
  assert.equal((await queue.snapshot()).items.length, 1);
  await rig.closeAll();
});

test('不同 operationId 的同类恢复事件在 10 分钟内都必须入队（旧实现会误吞）', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  const first = expectOk(await queue.enqueue({
    event: 'recovered',
    reason: 'admin-recover',
    meta: { operationId: 'transition-1' },
    at: T0,
  }));
  const second = expectOk(await queue.enqueue({
    event: 'recovered',
    reason: 'admin-recover',
    meta: { operationId: 'transition-2' },
    at: T0 + MINUTE,
  }));
  assert.notEqual(first.id, second.id);
  assert.equal((await queue.snapshot()).items.length, 2);
  await rig.closeAll();
});

test('同一 operationId 的 pending 记录按转换去重：忽略 reason，且不受 10 分钟窗口限制', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  const first = expectOk(await queue.enqueue({
    event: 'recovered',
    reason: 'admin-recover',
    meta: { operationId: 'transition-x' },
    at: T0,
  }));
  // reason 被重新措辞、时间远超 10 分钟窗口，但仍是同一次转换 → 必须去重。
  const again = expectDuplicate(await queue.enqueue({
    event: 'recovered',
    reason: 'admin-recover-replayed',
    meta: { operationId: 'transition-x' },
    at: T0 + 30 * MINUTE,
  }));
  assert.equal(again.existing.id, first.id);
  assert.equal((await queue.snapshot()).items.length, 1);
  await rig.closeAll();
});

test('已投递的 recent 记录携带 operationId：重放同一转换仍去重（即使 reason 不同）', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  const first = expectOk(await queue.enqueue({
    event: 'recovered',
    reason: 'admin-recover',
    meta: { operationId: 'transition-delivered' },
    at: T0,
  }));
  expectOk(await queue.markDelivered({ id: first.id, delivered: true, at: T0 + 500 }));
  let snapshot = await queue.snapshot();
  assert.equal(snapshot.items.length, 0);
  assert.equal(snapshot.recent.length, 1);
  assert.equal(snapshot.recent[0].operationId, 'transition-delivered');

  const again = expectDuplicate(await queue.enqueue({
    event: 'recovered',
    reason: 'admin-recover-replayed',
    meta: { operationId: 'transition-delivered' },
    at: T0 + 2 * MINUTE,
  }));
  assert.equal(again.existing.delivered, true);
  snapshot = await queue.snapshot();
  assert.equal(snapshot.items.length, 0);
  assert.equal(snapshot.recent.length, 1);

  // 重启后从磁盘恢复，去重仍然成立。
  await queue.close();
  const restarted = await rig.open();
  const replayAfterRestart = expectDuplicate(await restarted.enqueue({
    event: 'recovered',
    reason: 'admin-recover-replayed',
    meta: { operationId: 'transition-delivered' },
    at: T0 + 3 * MINUTE,
  }));
  assert.equal(replayAfterRestart.existing.delivered, true);
  await rig.closeAll();
});

test('status() 暴露 lastReject：queue-full 与 persist-failed 都可观察', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  for (let index = 0; index < BACKGROUND_PATROL_NOTIFY_MAX_PENDING; index += 1) {
    expectOk(await queue.enqueue({
      event: 'write-paused',
      reason: `fill-${index}`,
      at: T0 + index,
    }));
  }
  expectRejected(
    await queue.enqueue({ event: 'write-paused', reason: 'overflow', at: T0 + BACKGROUND_PATROL_NOTIFY_MAX_PENDING }),
    'queue-full',
  );
  let status = await queue.status();
  assert.equal(status.lastReject?.reason, 'queue-full');
  assert.equal(status.lastReject?.at, T0 + BACKGROUND_PATROL_NOTIFY_MAX_PENDING);

  const failing = await makeRig();
  const failingQueue = await failing.open({
    fsOps: {
      rename: async () => {
        const error = new Error('simulated EACCES');
        error.code = 'EACCES';
        throw error;
      },
    },
  });
  expectRejected(
    await failingQueue.enqueue({ event: 'access-paused', reason: 'persist-broken', at: T0 + 1 }),
    'persist-failed',
  );
  status = await failingQueue.status();
  assert.equal(status.degraded, true);
  assert.equal(status.lastReject?.reason, 'persist-failed');
  assert.equal(status.lastReject?.at, T0 + 1);
  await rig.closeAll();
  await failing.closeAll();
});

test('状态文件向后兼容：旧 recent（无 operationId）可加载，新 recent 可持久化', async () => {
  const rig = await makeRig();
  const legacy = {
    schemaVersion: 1,
    items: [],
    recent: [{
      id: 'legacy-1',
      event: 'write-paused',
      reason: 'consecutive-failures',
      at: T0 - MINUTE,
      deliveredAt: T0,
    }],
  };
  await fs.writeFile(rig.filePath, JSON.stringify(legacy), 'utf8');
  const legacyQueue = await rig.open();
  const legacySnapshot = await legacyQueue.snapshot();
  assert.equal(legacySnapshot.recent.length, 1);
  assert.equal(legacySnapshot.recent[0].id, 'legacy-1');
  expectOk(await legacyQueue.enqueue({
    event: 'recovered',
    reason: 'admin-recover',
    meta: { operationId: 'after-legacy' },
    at: T0 + 1,
  }));
  await legacyQueue.close();

  const restarted = await rig.open();
  const snapshot = await restarted.snapshot();
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].meta.operationId, 'after-legacy');
  await rig.closeAll();
});
