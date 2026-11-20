// task-132：通知队列「独立送达账本」测试（离线，临时目录）。
// 目标：转换送达事实跨重启可判定、不被 recent 10 分钟窗口裁掉；对新入队收紧 OPID；旧状态保持可读。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createBackgroundPatrolNotifyQueue } from '../src/core/background-patrol-notify.mjs';

const T0 = Date.UTC(2026, 9, 27, 3, 0, 0);
const OPID = 'write-pause:2026-10-27:1793000000000:1';

async function withDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notify-delivered-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function makeQueue(dir, nowRef = { now: T0 }) {
  return createBackgroundPatrolNotifyQueue({
    filePath: path.join(dir, 'notify.json'),
    clock: () => nowRef.now,
  });
}

test('markDelivered 携带 operationId 时写入送达账本，新实例可查询（跨重启）', async () => {
  await withDir(async (dir) => {
    const q1 = makeQueue(dir);
    await q1.load();
    const enq = await q1.enqueue({ event: 'write-paused', reason: 'write-paused', at: T0, meta: { platform: 'xiaoheihe', operationId: OPID } });
    assert.equal(enq.ok, true, JSON.stringify(enq));
    assert.equal((await q1.wasDelivered('write-paused', OPID)).delivered, false);
    const marked = await q1.markDelivered({ id: enq.id, delivered: true, at: T0 + 1000 });
    assert.equal(marked.ok, true);
    assert.equal(marked.deliveredRecorded, true);
    assert.equal((await q1.wasDelivered('write-paused', OPID)).delivered, true);
    await q1.close();

    const q2 = makeQueue(dir);
    await q2.load();
    const seen = await q2.wasDelivered('write-paused', OPID);
    assert.equal(seen.delivered, true, '重启后必须仍能判定已送达');
    assert.equal(seen.deliveredAt, T0 + 1000);
    await q2.close();
  });
});

test('未送达的转换查询为 false；不同转换互不影响', async () => {
  await withDir(async (dir) => {
    const q = makeQueue(dir);
    await q.load();
    assert.equal((await q.wasDelivered('write-paused', OPID)).delivered, false);
    const other = 'write-pause:2026-10-27:1793000000000:2';
    await q.recordDelivered({ event: 'write-paused', operationId: other, at: T0 });
    assert.equal((await q.wasDelivered('write-paused', OPID)).delivered, false);
    assert.equal((await q.wasDelivered('write-paused', other)).delivered, true);
    await q.close();
  });
});

test('recordDelivered 幂等：重复记录返回 already 且不重复写入', async () => {
  await withDir(async (dir) => {
    const q = makeQueue(dir);
    await q.load();
    assert.equal((await q.recordDelivered({ event: 'recovered', operationId: 'admin-recover:a:b:1', at: T0 })).recorded, true);
    const again = await q.recordDelivered({ event: 'recovered', operationId: 'admin-recover:a:b:1', at: T0 + 1 });
    assert.equal(again.already, true);
    assert.equal(again.deliveredAt, T0);
    await q.close();
  });
});

test('新入队收紧 OPID 字符集；非法 operationId 被拒绝且不写盘', async () => {
  await withDir(async (dir) => {
    const q = makeQueue(dir);
    await q.load();
    const bad = await q.enqueue({ event: 'write-paused', reason: 'write-paused', at: T0, meta: { operationId: 'bad id!' } });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'invalid-meta');
    await assert.rejects(readFile(path.join(dir, 'notify.json'), 'utf8'));
    await q.close();
  });
});

test('旧状态（宽松 operationId）仍可加载；查询时按严格契约返回 invalid-operation-id', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'notify.json');
    const legacy = {
      schemaVersion: 1,
      items: [],
      recent: [{ id: 'r1', event: 'write-paused', reason: 'write-paused', at: T0, deliveredAt: T0, operationId: 'legacy id with spaces' }],
    };
    await writeFile(file, JSON.stringify(legacy), 'utf8');
    const q = makeQueue(dir);
    await q.load();
    const result = await q.wasDelivered('write-paused', 'legacy id with spaces');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid-operation-id');
    await q.close();
  });
});

test('recent 裁剪不会清掉送达账本；status 暴露 deliveredCount', async () => {
  await withDir(async (dir) => {
    const now = { now: T0 };
    const q = makeQueue(dir, now);
    await q.load();
    const enq = await q.enqueue({ event: 'access-paused', reason: 'login-required', at: T0, meta: { platform: 'xiaoheihe', operationId: 'access-paused:2026-10-27:100:1' } });
    await q.markDelivered({ id: enq.id, delivered: true, at: T0 });
    now.now = T0 + 60 * 60 * 1000; // 超过 recent 10 分钟窗口
    // 触发一次写入，推进 recent 裁剪
    await q.enqueue({ event: 'report-unknown', reason: 'no-change', at: now.now });
    const snap = await q.snapshot();
    assert.equal(snap.recent.some((item) => item.operationId === 'access-paused:2026-10-27:100:1'), false, 'recent 已按窗口裁剪');
    assert.equal((await q.wasDelivered('access-paused', 'access-paused:2026-10-27:100:1')).delivered, true, '送达账本不受 recent 裁剪影响');
    const status = await q.status();
    assert.equal(status.deliveredCount, 1);
    assert.equal(status.deliveredLoaded, true);
    await q.close();
  });
});
