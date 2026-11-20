// scripts/test-background-patrol-notify.mjs
// task-34：管理员通知队列纯模块测试（TDD 先红后绿）。
// 覆盖：事件白名单 / 持久化（原子写、并发串行）/ pending 按 at 排序最多 50 /
// markDelivered 幂等（成功移除、失败保留不重投）/ 同 event+reason 10 分钟窗口去重 /
// meta 白名单（platform/operationId/attempts/code，禁 message/cookie/token/path/qq）/
// 写入失败 degraded / 重启恢复 / 坏状态 fail-closed。
// 纯离线：只用 os.tmpdir 临时目录与注入时钟；不联网、不发 QQ、不读 config/state。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BACKGROUND_PATROL_NOTIFY_QUEUE_VERSION,
  BACKGROUND_PATROL_NOTIFY_EVENTS,
  BACKGROUND_PATROL_NOTIFY_DEDUPE_WINDOW_MS,
  BACKGROUND_PATROL_NOTIFY_MAX_PENDING,
  BACKGROUND_PATROL_NOTIFY_META_KEYS,
  BACKGROUND_PATROL_NOTIFY_ERROR_CODES,
  createBackgroundPatrolNotifyQueue,
} from '../src/core/background-patrol-notify.mjs';

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 24, 2, 0, 0); // 北京时间 2026-10-24 10:00

const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeRig(startMs = T0, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhh-notify-queue-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'notify-queue.json');
  let now = startMs;
  const clock = () => now;
  const opened = [];
  return {
    dir,
    filePath,
    clock,
    setNow: (value) => { now = value; },
    async open(overrides = {}) {
      const queue = createBackgroundPatrolNotifyQueue({ filePath, clock, ...options, ...overrides });
      await queue.load();
      opened.push(queue);
      return queue;
    },
    createRaw(overrides = {}) {
      return createBackgroundPatrolNotifyQueue({ filePath, clock, ...options, ...overrides });
    },
    async closeAll() {
      for (const queue of opened) await queue.close?.().catch(() => {});
      opened.length = 0;
      return dir;
    },
  };
}

function expectOk(result, label = '') {
  assert.equal(result?.ok, true, `${label} 期望 ok:true，实际 ${JSON.stringify(result)}`);
  return result;
}

function expectRejected(result, reason, label = '') {
  assert.equal(result?.ok, false, `${label} 期望 ok:false，实际 ${JSON.stringify(result)}`);
  assert.equal(result?.reason, reason, `${label} 期望 reason:${reason}，实际 ${JSON.stringify(result)}`);
  return result;
}

async function expectLoadCode(fn, code, label = '') {
  await assert.rejects(fn, (error) => {
    assert.equal(error?.code, code, `${label} 期望 code=${code}，实际 ${error?.code}（${error?.message}）`);
    return true;
  }, label);
}

async function enqueueMany(queue, count, { event = 'write-paused', reasonPrefix = 'r', startAt = T0 } = {}) {
  const results = [];
  for (let i = 0; i < count; i += 1) {
    results.push(await queue.enqueue({ event, reason: `${reasonPrefix}-${i}`, at: startAt + i }));
  }
  return results;
}

test('exports: version, event whitelist, dedupe window, max pending, meta whitelist, error codes', () => {
  assert.equal(BACKGROUND_PATROL_NOTIFY_QUEUE_VERSION, 1);
  assert.deepEqual([...BACKGROUND_PATROL_NOTIFY_EVENTS].sort(), ['access-paused', 'recovered', 'report-unknown', 'write-paused'].sort());
  assert.ok(Object.isFrozen(BACKGROUND_PATROL_NOTIFY_EVENTS));
  assert.equal(BACKGROUND_PATROL_NOTIFY_DEDUPE_WINDOW_MS, 10 * MINUTE);
  assert.equal(BACKGROUND_PATROL_NOTIFY_MAX_PENDING, 50);
  assert.deepEqual([...BACKGROUND_PATROL_NOTIFY_META_KEYS].sort(), ['attempts', 'code', 'operationId', 'platform'].sort());
  assert.equal(BACKGROUND_PATROL_NOTIFY_ERROR_CODES.STATE_INVALID, 'BACKGROUND_PATROL_NOTIFY_STATE_INVALID');
  assert.equal(BACKGROUND_PATROL_NOTIFY_ERROR_CODES.LOAD_FAILED, 'BACKGROUND_PATROL_NOTIFY_LOAD_FAILED');
  assert.equal(typeof createBackgroundPatrolNotifyQueue, 'function');
});

test('load：缺文件 → 空白 ready，绝不创建文件；未 load 调用返回 not-loaded', async () => {
  const rig = await makeRig();
  const raw = rig.createRaw();
  expectRejected(await raw.enqueue({ event: 'recovered', reason: 'boot' }), 'not-loaded');
  const queue = await rig.open();
  const snapshot = await queue.snapshot();
  assert.deepEqual(snapshot.items, []);
  const stat = await fs.stat(rig.filePath).catch((error) => error);
  assert.equal(stat.code, 'ENOENT', 'load 不得创建文件');
  await rig.closeAll();
});

test('enqueue：合法事件/原因/meta 持久化，pending 按 at 升序，meta 白名单字段保留', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  expectOk(await queue.enqueue({ event: 'recovered', reason: 'timeout' }));
  const result = expectOk(await queue.enqueue({
    event: 'write-paused',
    reason: 'consecutive-failures',
    at: T0 + 1000,
    meta: { platform: 'xiaoheihe', operationId: 'op-1', attempts: 3, code: 'EACCES' },
  }));
  assert.equal(typeof result.id, 'string');
  const snapshot = await queue.snapshot();
  assert.equal(snapshot.items.length, 2);
  assert.deepEqual(snapshot.items.map((item) => item.event), ['recovered', 'write-paused']);
  assert.deepEqual(snapshot.items[1].meta, { platform: 'xiaoheihe', operationId: 'op-1', attempts: 3, code: 'EACCES' });
  assert.equal(snapshot.items[1].attempts, 0);

  // 重启恢复：新实例从文件加载到同样的 pending。
  const restarted = await rig.open();
  const restored = await restarted.snapshot();
  assert.deepEqual(restored.items, snapshot.items);
  await rig.closeAll();
});

test('原子写：randomUUID 临时名 + rename；0600（POSIX）', async (t) => {
  const rig = await makeRig();
  const tempPaths = [];
  const renamed = [];
  const queue = await rig.open({
    fsOps: {
      open: async (target, flags, mode) => {
        if (flags === 'wx' && String(target).includes('.tmp')) {
          tempPaths.push(target);
          return fs.open(target, flags, mode);
        }
        return fs.open(target, flags, mode);
      },
      rename: async (from, to) => {
        renamed.push({ from, to });
        await fs.rename(from, to);
      },
    },
  });
  expectOk(await queue.enqueue({ event: 'recovered', reason: 'atomic' }));
  assert.equal(tempPaths.length, 1);
  assert.match(path.basename(tempPaths[0]), /^notify-queue\.json\.[0-9a-f-]{36}\.tmp$/, '临时名必须带 randomUUID');
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0].to, rig.filePath);
  if (process.platform !== 'win32') {
    const stat = await fs.stat(rig.filePath);
    assert.equal(stat.mode & 0o777, 0o600);
  }
  await rig.closeAll();
});

test('事件白名单：未知事件拒绝；四种合法事件均可入队', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  expectRejected(await queue.enqueue({ event: 'publish-done', reason: 'x' }), 'invalid-event');
  expectRejected(await queue.enqueue({ event: '', reason: 'x' }), 'invalid-event');
  expectRejected(await queue.enqueue({ event: 42, reason: 'x' }), 'invalid-event');
  for (const [index, event] of BACKGROUND_PATROL_NOTIFY_EVENTS.entries()) {
    expectOk(await queue.enqueue({ event, reason: `reason-${index}`, at: T0 + index }));
  }
  assert.equal((await queue.snapshot()).items.length, BACKGROUND_PATROL_NOTIFY_EVENTS.length);
  await rig.closeAll();
});

test('reason 校验：空/超长/非字符串拒绝；正常 reason 保留', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  expectRejected(await queue.enqueue({ event: 'write-paused', reason: '' }), 'invalid-reason');
  expectRejected(await queue.enqueue({ event: 'write-paused', reason: '   ' }), 'invalid-reason');
  expectRejected(await queue.enqueue({ event: 'write-paused', reason: 'x'.repeat(300) }), 'invalid-reason');
  expectRejected(await queue.enqueue({ event: 'write-paused', reason: 42 }), 'invalid-reason');
  expectRejected(await queue.enqueue({ event: 'write-paused' }), 'invalid-reason');
  await rig.closeAll();
});

test('meta 白名单：允许 platform/operationId/attempts/code；未知键拒绝；敏感键（message/cookie/token/path/qq）明确拒绝', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  expectRejected(
    await queue.enqueue({ event: 'write-paused', reason: 'r1', meta: { message: 'secret text' } }),
    'forbidden-meta',
  );
  for (const key of ['cookie', 'token', 'path', 'qq']) {
    expectRejected(
      await queue.enqueue({ event: 'write-paused', reason: `r-${key}`, meta: { [key]: 'x' } }),
      'forbidden-meta',
      key,
    );
  }
  expectRejected(
    await queue.enqueue({ event: 'write-paused', reason: 'r2', meta: { unknown: 1 } }),
    'invalid-meta',
  );
  // 值类型/范围校验
  expectRejected(await queue.enqueue({ event: 'write-paused', reason: 'r3', meta: { platform: 'weibo' } }), 'invalid-meta');
  expectRejected(await queue.enqueue({ event: 'write-paused', reason: 'r4', meta: { attempts: -1 } }), 'invalid-meta');
  expectRejected(await queue.enqueue({ event: 'write-paused', reason: 'r5', meta: { attempts: 1.5 } }), 'invalid-meta');
  expectRejected(await queue.enqueue({ event: 'write-paused', reason: 'r6', meta: { operationId: 'x'.repeat(300) } }), 'invalid-meta');
  expectRejected(await queue.enqueue({ event: 'write-paused', reason: 'r7', meta: { code: 'x'.repeat(100) } }), 'invalid-meta');
  expectRejected(await queue.enqueue({ event: 'write-paused', reason: 'r8', meta: 'platform' }), 'invalid-meta');
  // 合法 meta
  expectOk(await queue.enqueue({ event: 'write-paused', reason: 'r9', meta: { platform: 'tieba', code: 'EACCES' } }));
  await rig.closeAll();
});

test('at：缺省用注入时钟；非法 at 拒绝；显式 at 生效', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  expectRejected(await queue.enqueue({ event: 'recovered', reason: 'bad-at', at: 'now' }), 'invalid-time');
  expectRejected(await queue.enqueue({ event: 'recovered', reason: 'bad-at2', at: Number.NaN }), 'invalid-time');
  const result = expectOk(await queue.enqueue({ event: 'recovered', reason: 'clock-at' }));
  assert.equal(result.at, T0);
  expectOk(await queue.enqueue({ event: 'recovered', reason: 'explicit-at', at: T0 + 5 * MINUTE }));
  const items = (await queue.snapshot()).items;
  assert.deepEqual(items.map((item) => item.at), [T0, T0 + 5 * MINUTE]);
  await rig.closeAll();
});

test('pending 排序与上限：乱序入队按 at 升序；最多 50，第 51 条 queue-full', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  // 乱序入队（原因不同以避免去重）。
  const offsets = [30, 10, 20, 0, 40];
  for (const offset of offsets) {
    expectOk(await queue.enqueue({ event: 'recovered', reason: `order-${offset}`, at: T0 + offset }));
  }
  const sorted = (await queue.snapshot()).items.map((item) => item.at);
  assert.deepEqual(sorted, [...offsets].sort((a, b) => a - b).map((offset) => T0 + offset));

  // 填满到 50（前面 5 条 + 45 条）。
  for (let i = 0; i < 45; i += 1) {
    expectOk(await queue.enqueue({ event: 'access-paused', reason: `fill-${i}`, at: T0 + 1000 + i }));
  }
  assert.equal((await queue.snapshot()).items.length, BACKGROUND_PATROL_NOTIFY_MAX_PENDING);
  expectRejected(
    await queue.enqueue({ event: 'access-paused', reason: 'overflow', at: T0 + 10_000 }),
    'queue-full',
  );
  assert.equal((await queue.snapshot()).items.length, BACKGROUND_PATROL_NOTIFY_MAX_PENDING);
  await rig.closeAll();
});

test('去重：同 event+reason 10 分钟窗口内 duplicate（含边界），超过窗口才允许；跨 event/reason 不去重', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  expectOk(await queue.enqueue({ event: 'write-paused', reason: 'dup', at: T0 }));
  const duplicate = await queue.enqueue({ event: 'write-paused', reason: 'dup', at: T0 + 5 * MINUTE });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal((await queue.snapshot()).items.length, 1, '去重不得新增条目');

  const boundary = await queue.enqueue({ event: 'write-paused', reason: 'dup', at: T0 + BACKGROUND_PATROL_NOTIFY_DEDUPE_WINDOW_MS });
  assert.equal(boundary.duplicate, true, '恰好 10 分钟边界算重复');

  expectOk(await queue.enqueue({ event: 'write-paused', reason: 'dup', at: T0 + BACKGROUND_PATROL_NOTIFY_DEDUPE_WINDOW_MS + 1 }), '超过窗口允许');
  expectOk(await queue.enqueue({ event: 'write-paused', reason: 'other', at: T0 + 10 * MINUTE + 2 }), '不同 reason 允许');
  expectOk(await queue.enqueue({ event: 'recovered', reason: 'dup', at: T0 + 10 * MINUTE + 3 }), '不同 event 允许');
  await rig.closeAll();
});

test('去重也覆盖「已成功投递」的近期记录（窗口内不重复通知）', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  const first = expectOk(await queue.enqueue({ event: 'write-paused', reason: 'state', at: T0 }));
  expectOk(await queue.markDelivered({ id: first.id, delivered: true, at: T0 + 1 }));
  const again = await queue.enqueue({ event: 'write-paused', reason: 'state', at: T0 + 5 * MINUTE });
  assert.equal(again.duplicate, true, '已投递但仍在窗口内 → 去重');
  // 窗口外允许重发。
  expectOk(await queue.enqueue({ event: 'write-paused', reason: 'state', at: T0 + 11 * MINUTE }));
  await rig.closeAll();
});

test('markDelivered：成功移除并持久化；重复成功/未知 id 幂等 already:true', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  const first = expectOk(await queue.enqueue({ event: 'access-paused', reason: 'captcha', at: T0 }));
  const delivered = expectOk(await queue.markDelivered({ id: first.id, delivered: true, at: T0 + 1 }));
  assert.equal(delivered.removed, true);
  assert.equal((await queue.snapshot()).items.length, 0);

  const again = expectOk(await queue.markDelivered({ id: first.id, delivered: true, at: T0 + 2 }));
  assert.equal(again.already, true);
  const unknown = expectOk(await queue.markDelivered({ id: 'no-such-id', delivered: true, at: T0 + 3 }));
  assert.equal(unknown.already, true);

  const restarted = await rig.open();
  assert.deepEqual((await restarted.snapshot()).items, []);
  await rig.closeAll();
});

test('markDelivered 失败：保留 pending、attempts+1、lastError 持久化；同 (id,at) 幂等不重投', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  const first = expectOk(await queue.enqueue({ event: 'report-unknown', reason: 'send-timeout', at: T0 }));
  const failed = expectOk(await queue.markDelivered({ id: first.id, delivered: false, at: T0 + 1, code: 'ETIMEDOUT' }));
  assert.equal(failed.retained, true);
  assert.equal(failed.attempts, 1);
  let item = (await queue.snapshot()).items[0];
  assert.equal(item.attempts, 1);
  assert.equal(item.lastError, 'ETIMEDOUT');
  assert.equal(item.lastAttemptAt, T0 + 1);

  // 同 (id, at) 重试幂等：不重复累加。
  const sameAgain = expectOk(await queue.markDelivered({ id: first.id, delivered: false, at: T0 + 1, code: 'ETIMEDOUT' }));
  assert.equal(sameAgain.already, true);
  assert.equal((await queue.snapshot()).items[0].attempts, 1, '同 at 失败不重复累计');

  // 新的一次尝试（不同 at）→ attempts 2；仍然保留、不被自动重投。
  expectOk(await queue.markDelivered({ id: first.id, delivered: false, at: T0 + 2, code: 'EACCES' }));
  item = (await queue.snapshot()).items[0];
  assert.equal(item.attempts, 2);
  assert.equal(item.lastError, 'EACCES');
  assert.equal((await queue.snapshot()).items.length, 1);

  // 重启后失败状态保留。
  const restarted = await rig.open();
  const restored = (await restarted.snapshot()).items[0];
  assert.equal(restored.attempts, 2);
  assert.equal(restored.lastError, 'EACCES');
  await rig.closeAll();
});

test('markDelivered 输入校验：id/delivered/code 类型错误拒绝', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  const first = expectOk(await queue.enqueue({ event: 'recovered', reason: 'validate', at: T0 }));
  expectRejected(await queue.markDelivered({ id: '', delivered: true }), 'invalid-id');
  expectRejected(await queue.markDelivered({ id: 42, delivered: true }), 'invalid-id');
  expectRejected(await queue.markDelivered({ id: first.id, delivered: 'yes' }), 'invalid-delivered');
  expectRejected(await queue.markDelivered({ id: first.id, delivered: false, code: 'x'.repeat(100), at: T0 + 1 }), 'invalid-code');
  await rig.closeAll();
});

test('写入失败 → degraded：persist-failed；后续写拒绝 degraded；修复后 reload 恢复磁盘 pending', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  const first = expectOk(await queue.enqueue({ event: 'write-paused', reason: 'before-failure', at: T0 }));

  // 注入 rename 失败（模拟 EACCES）。
  const failing = await rig.open({
    fsOps: {
      rename: async () => {
        const error = new Error('simulated EACCES');
        error.code = 'EACCES';
        throw error;
      },
    },
  });
  const result = await failing.enqueue({ event: 'access-paused', reason: 'during-failure', at: T0 + 1 });
  expectRejected(result, 'persist-failed');
  const status = await failing.status();
  assert.equal(status.degraded, true);
  assert.equal(status.lastError.code, 'WRITE_FAILED');
  expectRejected(await failing.enqueue({ event: 'recovered', reason: 'blocked', at: T0 + 2 }), 'degraded');
  // reload 用修好的 fsOps 恢复磁盘状态。
  const recovered = await rig.open();
  const items = (await recovered.snapshot()).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, first.id);
  await failing.close();
  await rig.closeAll();
});

test('坏状态 fail-closed：坏 JSON/未知版本/未知字段/非法 meta/超上限 → 拒绝加载且保留原字节', async () => {
  const rig = await makeRig();
  const valid = await rig.open();
  expectOk(await valid.enqueue({ event: 'write-paused', reason: 'valid', at: T0 }));
  await valid.close();
  const validText = await fs.readFile(rig.filePath, 'utf8');
  const validState = JSON.parse(validText);

  const variants = [
    ['空文件', ''],
    ['坏 JSON', '{'],
    ['根是数组', '[]'],
    ['未知版本', JSON.stringify({ ...validState, schemaVersion: 999 })],
    ['未知字段', JSON.stringify({ ...validState, extra: 1 })],
    ['未知事件', JSON.stringify({ ...validState, items: [{ ...validState.items[0], event: 'publish-done' }] })],
    ['敏感 meta', JSON.stringify({ ...validState, items: [{ ...validState.items[0], meta: { token: 'abc' } }] })],
    ['负 attempts', JSON.stringify({ ...validState, items: [{ ...validState.items[0], attempts: -1 }] })],
    ['pending 超上限', JSON.stringify({
      ...validState,
      items: Array.from({ length: 51 }, (_, index) => ({ ...validState.items[0], id: `id-${index}`, at: T0 + index })),
    })],
  ];
  for (const [label, text] of variants) {
    await fs.writeFile(rig.filePath, text, 'utf8');
    const queue = rig.createRaw();
    await expectLoadCode(() => queue.load(), BACKGROUND_PATROL_NOTIFY_ERROR_CODES.LOAD_FAILED, label);
    assert.equal(await fs.readFile(rig.filePath, 'utf8'), text, `${label}：拒绝加载时必须保留原字节`);
    await queue.close().catch(() => {});
  }
  // 合法文件仍可加载。
  await fs.writeFile(rig.filePath, validText, 'utf8');
  const reopened = await rig.open();
  assert.equal((await reopened.snapshot()).items.length, 1);
  await rig.closeAll();
});

test('并发 enqueue：串行落盘，全部成功且 pending 数量/排序正确', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) => queue.enqueue({
      event: index % 2 === 0 ? 'write-paused' : 'access-paused',
      reason: `concurrent-${index}`,
      at: T0 + (12 - index) * 1000,
    })),
  );
  assert.equal(results.filter((result) => result.ok).length, 12);
  const items = (await queue.snapshot()).items;
  assert.equal(items.length, 12);
  for (let index = 1; index < items.length; index += 1) {
    assert.ok(items[index - 1].at <= items[index].at, 'pending 必须按 at 升序');
  }
  const restarted = await rig.open();
  assert.equal((await restarted.snapshot()).items.length, 12);
  await rig.closeAll();
});

test('snapshot/status 返回副本；status 暴露 pendingCount/degraded/lastError', async () => {
  const rig = await makeRig();
  const queue = await rig.open();
  expectOk(await queue.enqueue({ event: 'recovered', reason: 'view', at: T0 }));
  const snapshot = await queue.snapshot();
  snapshot.items[0].reason = 'tampered';
  assert.equal((await queue.snapshot()).items[0].reason, 'view');
  const status = await queue.status();
  assert.equal(status.pendingCount, 1);
  assert.equal(status.degraded, false);
  assert.equal(status.lastError, null);
  await rig.closeAll();
});
