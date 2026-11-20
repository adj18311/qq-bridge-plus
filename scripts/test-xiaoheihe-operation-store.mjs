#!/usr/bin/env node
// scripts/test-xiaoheihe-operation-store.mjs
//
// 小黑盒唯一权威控制器：持久化 store（task-28）。
//
// 被测：`src/core/xiaoheihe-operation-store.mjs`
//   createXhhOperationStore({ filePath, clock?, fsOps?, singletonKey?, lockFilePath?, lockStaleMs? })
//
// 契约：
//  1) load()：缺文件 → 新建空控制器；有文件 → 先严格 `parseXhhOperationControllerState` 再建控制器；
//     坏 JSON / 坏 schema → fail-closed 抛带 code 错误，**原文件字节保持不变**，后续 save 不得覆盖。
//  2) save()：克隆并重新校验控制器 serialize 结果 → 同目录唯一临时文件（randomUUID + open 'wx' + 0600）
//     → writeFile → datasync（无则 fsync）→ rename → 目录 sync（best-effort）。任何失败 → degraded，
//     保留旧文件、清理临时文件、错误码明确，并**拒绝后续 save**；reload() 可从旧文件恢复。
//  3) 同实例 Promise 队列串行；可选进程内 singletonKey（第二个同名实例抛 SINGLETON_CONFLICT）；
//     可选 O_EXCL 锁文件（lockFilePath；stale 检测文档化）；close() 释放锁/单例。
//  4) load 后控制器状态与磁盘一致；写入失败后 reload 不丢旧状态；status() 暴露 degraded/lastError。
//
// 纯离线：fsOps 默认真实文件系统但只用 os.tmpdir() 临时目录；不联网、不访问小黑盒、不读 state/Cookie。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  XHH_OPERATION_STORE_ERROR_CODES,
  createXhhOperationStore,
} from '../src/core/xiaoheihe-operation-store.mjs';
import {
  XHH_OP_READ_DAILY_LIMIT,
  parseXhhOperationControllerState,
} from '../src/core/xiaoheihe-operation-controller.mjs';

const BJT_OFFSET = 8 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 24, 2, 0, 0) - BJT_OFFSET; // 北京时间 2026-10-24 10:00
const READ_TOOL = 'mcp__xiaoheihe__get_home_content';

function bjt(year, month, day, hour = 0, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, 0) - BJT_OFFSET;
}

async function exists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function rejectsWithCode(operation, expectedCode) {
  try {
    await operation();
  } catch (error) {
    assert.equal(error.code, expectedCode, `期望 code=${expectedCode}，实际 ${error.code}（${error.message}）`);
    return error;
  }
  assert.fail(`期望 promise 以 code=${expectedCode} 拒绝`);
}

function throwsWithCode(run, expectedCode) {
  try {
    run();
  } catch (error) {
    assert.equal(error.code, expectedCode, `期望 code=${expectedCode}，实际 ${error.code}（${error.message}）`);
    return error;
  }
  assert.fail(`期望抛出 code=${expectedCode} 的错误`);
}

async function harness(t, at = T0) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-xhh-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'xiaoheihe-operation-state.json');
  let now = at;
  const make = (extra) => createXhhOperationStore({
    filePath,
    clock: { now: () => now },
    ...(extra ?? {}),
  });
  return {
    dir,
    filePath,
    make,
    now: () => now,
    setNow: (value) => { now = value; },
  };
}

test('常量：错误码完整且冻结', () => {
  assert.equal(Object.isFrozen(XHH_OPERATION_STORE_ERROR_CODES), true);
  assert.deepEqual(
    Object.values(XHH_OPERATION_STORE_ERROR_CODES).sort(),
    [
      'XHH_OPERATION_STORE_BAD_OPTIONS',
      'XHH_OPERATION_STORE_CLOSED',
      'XHH_OPERATION_STORE_DEGRADED',
      'XHH_OPERATION_STORE_LOCKED',
      'XHH_OPERATION_STORE_LOAD_FAILED',
      'XHH_OPERATION_STORE_NOT_LOADED',
      'XHH_OPERATION_STORE_SINGLETON_CONFLICT',
      'XHH_OPERATION_STORE_STATE_INVALID',
      'XHH_OPERATION_STORE_WRITE_FAILED',
    ].sort(),
  );
});

test('构造参数：filePath 必填；可选参数类型错误抛 BAD_OPTIONS', () => {
  assert.throws(() => createXhhOperationStore({}), TypeError);
  assert.throws(() => createXhhOperationStore({ filePath: '' }), TypeError);
  assert.throws(() => createXhhOperationStore({ filePath: '   ' }), TypeError);
  throwsWithCode(() => createXhhOperationStore({ filePath: 'x', singletonKey: '' }), 'XHH_OPERATION_STORE_BAD_OPTIONS');
  throwsWithCode(() => createXhhOperationStore({ filePath: 'x', lockFilePath: 42 }), 'XHH_OPERATION_STORE_BAD_OPTIONS');
  throwsWithCode(() => createXhhOperationStore({ filePath: 'x', lockStaleMs: -1 }), 'XHH_OPERATION_STORE_BAD_OPTIONS');
});

test('缺文件：load 新建空控制器，绝不创建文件', async (t) => {
  const h = await harness(t);
  const store = h.make();
  const controller = await store.load();
  assert.equal(typeof controller.authorizeRead, 'function');
  const status = await store.status();
  assert.equal(status.loaded, true);
  assert.equal(status.degraded, false);
  assert.equal(status.closed, false);
  assert.equal(status.day, '2026-10-24');
  assert.equal(await exists(h.filePath), false);
  const snap = await controller.status();
  assert.equal(snap.read.used, 0);
  assert.equal(snap.day, '2026-10-24');
});

test('save 后文件是严格可解析的状态 JSON；round-trip 后控制器快照一致', async (t) => {
  const h = await harness(t);
  const store = h.make();
  const controller = await store.load();
  await controller.authorizeRead({ tool: READ_TOOL, id: 'read-1', now: T0 });
  const before = await controller.status();
  const saved = await store.save();
  assert.equal(saved.ok, true);
  assert.equal(typeof saved.savedAt, 'number');
  assert.equal(saved.bytes > 0, true);
  assert.equal(await exists(h.filePath), true);

  const raw = await fs.readFile(h.filePath, 'utf8');
  const parsed = parseXhhOperationControllerState(raw);
  assert.equal(parsed.day, '2026-10-24');
  assert.equal(parsed.readCount, 1);

  const restarted = h.make();
  const controller2 = await restarted.load();
  assert.deepEqual(await controller2.status(), before);
});

test('坏 JSON / 坏 schema：load fail-closed 抛带 code，原文件字节保留且 save 不覆盖', async (t) => {
  const h = await harness(t);
  const cases = ['', '   ', '{bad json', '[]', JSON.stringify({ schemaVersion: 999 }), '{"schemaVersion":1}'];
  for (const content of cases) {
    await fs.writeFile(h.filePath, content, 'utf8');
    const store = h.make();
    const error = await rejectsWithCode(() => store.load(), XHH_OPERATION_STORE_ERROR_CODES.STATE_INVALID);
    assert.ok(String(error.message).length > 0, '错误需可读');
    const failed = await store.save();
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, XHH_OPERATION_STORE_ERROR_CODES.STATE_INVALID);
    assert.equal(await fs.readFile(h.filePath, 'utf8'), content, '损坏文件原字节必须保留');
    const status = await store.status();
    assert.equal(status.loaded, false);
    assert.equal(status.lastError.code, XHH_OPERATION_STORE_ERROR_CODES.STATE_INVALID);
  }
});

test('非 ENOENT 读取失败：LOAD_FAILED，且不创建文件', async (t) => {
  const h = await harness(t);
  const store = h.make({
    fsOps: {
      ...fs,
      readFile: async () => {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      },
    },
  });
  const error = await rejectsWithCode(() => store.load(), XHH_OPERATION_STORE_ERROR_CODES.LOAD_FAILED);
  assert.match(error.message, /permission denied/);
  assert.equal(await exists(h.filePath), false);
});

test('持久化失败（ENOSPC）：返回 WRITE_FAILED、degraded、旧文件保留、临时文件清理、后续 save 拒绝', async (t) => {
  const h = await harness(t);
  const store = h.make();
  const controller = await store.load();
  await controller.authorizeRead({ tool: READ_TOOL, id: 'read-1', now: T0 });
  assert.equal((await store.save()).ok, true);
  const beforeBytes = await fs.readFile(h.filePath, 'utf8');

  // 让下一次写入在临时文件 writeFile 阶段失败。
  const failing = h.make({
    fsOps: {
      ...fs,
      open: async (target, flags, mode) => {
        const handle = await fs.open(target, flags, mode);
        return {
          writeFile: async () => {
            await handle.close();
            const error = new Error('no space left on device');
            error.code = 'ENOSPC';
            throw error;
          },
          datasync: async () => handle.datasync(),
          sync: async () => handle.sync(),
          close: async () => handle.close(),
        };
      },
    },
  });
  await failing.load();
  const c2 = failing.controller;
  await c2.authorizeRead({ tool: READ_TOOL, id: 'read-2', now: T0 });
  const failed = await failing.save();
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, XHH_OPERATION_STORE_ERROR_CODES.WRITE_FAILED);
  assert.equal(failed.error.causeCode, 'ENOSPC');

  const status = await failing.status();
  assert.equal(status.degraded, true);
  assert.equal(status.lastError.code, XHH_OPERATION_STORE_ERROR_CODES.WRITE_FAILED);
  assert.equal(status.lastError.causeCode, 'ENOSPC');
  assert.equal(await fs.readFile(h.filePath, 'utf8'), beforeBytes, '旧文件必须保留');

  const again = await failing.save();
  assert.equal(again.ok, false);
  assert.equal(again.error.code, XHH_OPERATION_STORE_ERROR_CODES.DEGRADED);
  assert.equal(await fs.readFile(h.filePath, 'utf8'), beforeBytes);
  const leftovers = (await fs.readdir(h.dir)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '失败后不得残留临时文件');
});

test('持久化失败（rename EPERM）：degraded、旧文件保留；reload 恢复旧状态后可继续 save', async (t) => {
  const h = await harness(t);
  const store = h.make();
  const controller = await store.load();
  await controller.authorizeRead({ tool: READ_TOOL, id: 'read-1', now: T0 });
  assert.equal((await store.save()).ok, true);
  const diskState = await fs.readFile(h.filePath, 'utf8');
  const diskSnapshot = await controller.status();

  let failRename = false;
  const flaky = h.make({
    fsOps: {
      ...fs,
      rename: async (...args) => {
        if (failRename) {
          const error = new Error('simulated lock');
          error.code = 'EPERM';
          throw error;
        }
        return fs.rename(...args);
      },
    },
  });
  const c2 = await flaky.load();
  await c2.authorizeRead({ tool: READ_TOOL, id: 'read-2', now: T0 });
  failRename = true;
  const failed = await flaky.save();
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, XHH_OPERATION_STORE_ERROR_CODES.WRITE_FAILED);
  assert.equal(failed.error.causeCode, 'EPERM');
  assert.equal(await fs.readFile(h.filePath, 'utf8'), diskState);
  assert.equal((await flaky.status()).degraded, true);
  assert.deepEqual((await flaky.status()).lastError.causeCode, 'EPERM');

  // 恢复：reload 从旧文件读取，degraded 清除；磁盘状态 = read-1（未落盘的 read-2 丢弃）。
  failRename = false;
  const recoveredController = await flaky.reload();
  assert.deepEqual(await recoveredController.status(), diskSnapshot);
  assert.equal((await flaky.status()).degraded, false);
  assert.equal((await flaky.status()).lastError, null);
  await recoveredController.authorizeRead({ tool: READ_TOOL, id: 'read-3', now: T0 });
  assert.equal((await flaky.save()).ok, true);
  const reparsed = parseXhhOperationControllerState(await fs.readFile(h.filePath, 'utf8'));
  assert.equal(reparsed.readCount, 2);
});

test('并发 save 串行：20 个并发 save 全部成功、文件合法、无临时文件残留', async (t) => {
  const h = await harness(t);
  const store = h.make();
  const controller = await store.load();
  await controller.authorizeRead({ tool: READ_TOOL, id: 'read-1', now: T0 });
  const results = await Promise.all(Array.from({ length: 20 }, () => store.save()));
  assert.equal(results.filter((result) => result.ok).length, 20);
  parseXhhOperationControllerState(await fs.readFile(h.filePath, 'utf8'));
  const leftovers = (await fs.readdir(h.dir)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('reload 后再 save：重启 load 恢复，跨北京日状态正确持久化', async (t) => {
  const h = await harness(t);
  const first = h.make();
  const c1 = await first.load();
  await c1.authorizeRead({ tool: READ_TOOL, id: 'read-day24', now: bjt(2026, 10, 24, 23, 50) });
  assert.equal((await first.save()).ok, true);

  // 次日继续：控制器按事件时间滚动日键，重新 save。
  h.setNow(bjt(2026, 10, 25, 0, 5));
  await c1.authorizeRead({ tool: READ_TOOL, id: 'read-day25', now: bjt(2026, 10, 25, 0, 5) });
  assert.equal((await first.save()).ok, true);
  const day25Snapshot = await c1.status();
  assert.equal(day25Snapshot.day, '2026-10-25');
  assert.equal(day25Snapshot.read.used, 1);

  const restarted = h.make();
  const c2 = await restarted.load();
  assert.deepEqual(await c2.status(), day25Snapshot);
  const parsed = parseXhhOperationControllerState(await fs.readFile(h.filePath, 'utf8'));
  assert.equal(parsed.day, '2026-10-25');
  assert.equal(parsed.readCount, 1);
  assert.equal(Object.keys(parsed.operations).sort().join(','), 'read-day24,read-day25');
});

test('单实例（进程内 singletonKey）：第二个同名实例抛 SINGLETON_CONFLICT，close 后可重建', async () => {
  const key = `store-test-${Date.now()}-${Math.random()}`;
  const a = createXhhOperationStore({ filePath: `tmp-store-${key}.json`, singletonKey: key, clock: { now: () => T0 } });
  const error = throwsWithCode(
    () => createXhhOperationStore({ filePath: `tmp-store-${key}.json`, singletonKey: key, clock: { now: () => T0 } }),
    XHH_OPERATION_STORE_ERROR_CODES.SINGLETON_CONFLICT,
  );
  assert.match(error.message, new RegExp(key));
  await a.close();
  const c = createXhhOperationStore({ filePath: `tmp-store-${key}.json`, singletonKey: key, clock: { now: () => T0 } });
  await c.close();
});

test('close：释放单例，之后 load/save 返回 CLOSED；close 幂等', async (t) => {
  const h = await harness(t);
  const store = h.make();
  const controller = await store.load();
  await controller.authorizeRead({ tool: READ_TOOL, id: 'read-1', now: T0 });
  assert.equal((await store.save()).ok, true);
  await store.close();
  await store.close();
  assert.equal((await store.status()).closed, true);
  const saved = await store.save();
  assert.equal(saved.ok, false);
  assert.equal(saved.error.code, XHH_OPERATION_STORE_ERROR_CODES.CLOSED);
  await rejectsWithCode(() => store.load(), XHH_OPERATION_STORE_ERROR_CODES.CLOSED);
});

test('O_EXCL 锁文件：占用时 load 返回 LOCKED；close 释放；stale 锁可按时间替换', async (t) => {
  const h = await harness(t);
  const lockFilePath = path.join(h.dir, 'xiaoheihe-operation-state.lock');
  const first = h.make({ lockFilePath });
  await first.load();
  assert.equal(await exists(lockFilePath), true);
  const lockContent = JSON.parse(await fs.readFile(lockFilePath, 'utf8'));
  assert.equal(lockContent.pid, process.pid);
  assert.equal(Number.isFinite(lockContent.createdAt), true);

  const second = h.make({ lockFilePath });
  const locked = await rejectsWithCode(() => second.load(), XHH_OPERATION_STORE_ERROR_CODES.LOCKED);
  assert.match(locked.message, /锁/);
  await first.close();
  assert.equal(await exists(lockFilePath), false, 'close 必须释放锁文件');

  // 过期锁（内容为旧时间戳）：允许替换并继续。
  await fs.writeFile(lockFilePath, JSON.stringify({ pid: 999_999, createdAt: T0 - 60 * 60 * 1000 }), 'utf8');
  const stale = h.make({ lockFilePath, lockStaleMs: 10 * 60 * 1000 });
  await stale.load();
  const replaced = JSON.parse(await fs.readFile(lockFilePath, 'utf8'));
  assert.equal(replaced.pid, process.pid);
  await stale.close();

  // 新鲜锁（刚创建）→ LOCKED。
  await fs.writeFile(lockFilePath, JSON.stringify({ pid: 999_999, createdAt: T0 }), 'utf8');
  const fresh = h.make({ lockFilePath, lockStaleMs: 10 * 60 * 1000 });
  await rejectsWithCode(() => fresh.load(), XHH_OPERATION_STORE_ERROR_CODES.LOCKED);
});

test('save 前未 load：NOT_LOADED，且不创建文件', async (t) => {
  const h = await harness(t);
  const store = h.make();
  const saved = await store.save();
  assert.equal(saved.ok, false);
  assert.equal(saved.error.code, XHH_OPERATION_STORE_ERROR_CODES.NOT_LOADED);
  assert.equal(await exists(h.filePath), false);
  assert.equal((await store.status()).loaded, false);
});

test('status() 暴露 loaded/degraded/lastError/day，返回副本', async (t) => {
  const h = await harness(t);
  const store = h.make();
  await store.load();
  const status = await store.status();
  assert.deepEqual(
    { loaded: status.loaded, degraded: status.degraded, closed: status.closed, day: status.day, lastSavedAt: status.lastSavedAt },
    { loaded: true, degraded: false, closed: false, day: '2026-10-24', lastSavedAt: null },
  );
  assert.equal(status.filePath, path.resolve(h.filePath));
  status.day = '1999-01-01';
  assert.equal((await store.status()).day, '2026-10-24');
});

test('权限：状态文件与临时文件 0600（POSIX；Windows skip）', { skip: process.platform === 'win32' }, async (t) => {
  const h = await harness(t);
  const store = h.make();
  await store.load();
  assert.equal((await store.save()).ok, true);
  const stat = await fs.stat(h.filePath);
  assert.equal(stat.mode & 0o777, 0o600);
  const dirEntries = await fs.readdir(h.dir);
  for (const name of dirEntries) {
    if (!name.endsWith('.tmp')) continue;
    const tempStat = await fs.stat(path.join(h.dir, name));
    assert.equal(tempStat.mode & 0o777, 0o600);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// task-35（task-33 审查阻断项）：reload 的锁/生命周期（F1）、锁 token 归属（F2）、
// reload 失败契约（F3）。以下测试在修复前必须失败（或固定契约）。
// ─────────────────────────────────────────────────────────────────────────────

async function writeValidStateFile(h, id = 'probe-read') {
  // 用一个临时 store（不配锁）生成合法状态文件，返回其字节。
  const producer = h.make();
  const controller = await producer.load();
  await controller.authorizeRead({ tool: READ_TOOL, id, now: T0 });
  assert.equal((await producer.save()).ok, true);
  await producer.close();
  return fs.readFile(h.filePath, 'utf8');
}

test('F1：未 load 直接 reload 抛 NOT_LOADED，且不创建锁文件/状态文件', async (t) => {
  const h = await harness(t);
  const lockFilePath = path.join(h.dir, 'state.lock');
  const store = h.make({ lockFilePath });
  await rejectsWithCode(() => store.reload(), XHH_OPERATION_STORE_ERROR_CODES.NOT_LOADED);
  assert.equal(await exists(lockFilePath), false, '未 load 的实例不得创建锁');
  assert.equal(await exists(h.filePath), false, '未 load 的实例不得创建状态文件');
});

test('F1：load 因坏文件失败后，修好文件 reload 必须重新取得锁，之后 save 仍持锁', async (t) => {
  const h = await harness(t);
  const lockFilePath = path.join(h.dir, 'state.lock');
  const validBytes = await writeValidStateFile(h, 'reload-after-failure');

  await fs.writeFile(h.filePath, '{bad json', 'utf8');
  const store = h.make({ lockFilePath });
  await rejectsWithCode(() => store.load(), XHH_OPERATION_STORE_ERROR_CODES.STATE_INVALID);
  assert.equal(await exists(lockFilePath), false, 'load 失败应释放锁');

  await fs.writeFile(h.filePath, validBytes, 'utf8');
  const controller = await store.reload();
  assert.equal(typeof controller.authorizeRead, 'function');
  assert.equal(await exists(lockFilePath), true, 'reload 必须重新取得锁');
  const lockContent = JSON.parse(await fs.readFile(lockFilePath, 'utf8'));
  assert.equal(lockContent.pid, process.pid);
  assert.equal(typeof lockContent.token, 'string', '锁内容必须带归属 token（F2）');

  // 另一 store 此时 load 必须 LOCKED（说明 reload 的锁真实生效）。
  const other = h.make({ lockFilePath });
  await rejectsWithCode(() => other.load(), XHH_OPERATION_STORE_ERROR_CODES.LOCKED);
  assert.equal((await store.save()).ok, true, 'reload 后 save 必须仍持锁并成功');
  await store.close();
  assert.equal(await exists(lockFilePath), false);
});

test('F1：它人持锁时 reload 必须 LOCKED 拒绝，且不得写盘（不再绕过 LOCKED）', async (t) => {
  const h = await harness(t);
  const lockFilePath = path.join(h.dir, 'state.lock');
  const validBytes = await writeValidStateFile(h, 'reload-blocked-by-lock');

  // A 先在坏文件上 load 失败（释放锁）。
  await fs.writeFile(h.filePath, '{bad json', 'utf8');
  const a = h.make({ lockFilePath });
  await rejectsWithCode(() => a.load(), XHH_OPERATION_STORE_ERROR_CODES.STATE_INVALID);

  // 恢复合法文件，B 取得锁。
  await fs.writeFile(h.filePath, validBytes, 'utf8');
  const b = h.make({ lockFilePath });
  await b.load();

  // A 的 reload 必须被 B 的锁拒绝。
  await rejectsWithCode(() => a.reload(), XHH_OPERATION_STORE_ERROR_CODES.LOCKED);
  const saved = await a.save();
  assert.equal(saved.ok, false);
  assert.equal(saved.error.code, XHH_OPERATION_STORE_ERROR_CODES.LOCKED, 'reload 被拒后 save 也必须 LOCKED，不得写盘');
  assert.equal(await fs.readFile(h.filePath, 'utf8'), validBytes, '被拒的实例不得改动文件');
  assert.equal((await a.status()).loaded, false);
  await b.close();
});

test('F1：reload（degraded 恢复）后仍持锁；close 才能释放', async (t) => {
  const h = await harness(t);
  const lockFilePath = path.join(h.dir, 'state.lock');
  const validBytes = await writeValidStateFile(h, 'reload-hold-lock');

  const store = h.make({ lockFilePath });
  await store.load();
  await fs.writeFile(h.filePath, validBytes, 'utf8');
  const controller = await store.reload();
  assert.equal(typeof controller.authorizeRead, 'function');
  assert.equal(await exists(lockFilePath), true);

  const other = h.make({ lockFilePath });
  await rejectsWithCode(() => other.load(), XHH_OPERATION_STORE_ERROR_CODES.LOCKED);
  assert.equal((await store.save()).ok, true);
  await store.close();
  assert.equal(await exists(lockFilePath), false, 'close 释放自己的锁');
  const rebuilt = h.make({ lockFilePath });
  await rebuilt.load();
  await rebuilt.close();
});

test('F2：close 只删除自己 token 的锁；foreign token 锁必须保留', async (t) => {
  const h = await harness(t);
  const lockFilePath = path.join(h.dir, 'state.lock');
  const store = h.make({ lockFilePath });
  await store.load();
  // 模拟锁被另一个 owner 接管：替换成 foreign token 的合法锁。
  const foreign = { pid: 999_999, createdAt: T0, filePath: h.filePath, token: 'foreign-owner-token' };
  await fs.writeFile(lockFilePath, JSON.stringify(foreign), 'utf8');

  await store.close();
  assert.equal(await exists(lockFilePath), true, 'close 不得删除不属于自己的锁');
  const content = JSON.parse(await fs.readFile(lockFilePath, 'utf8'));
  assert.equal(content.token, 'foreign-owner-token');
});

test('F2：close 不得删除损坏/不可解析的锁（不做危险接管）', async (t) => {
  const h = await harness(t);
  const lockFilePath = path.join(h.dir, 'state.lock');
  const store = h.make({ lockFilePath });
  await store.load();
  await fs.writeFile(lockFilePath, '{broken lock json', 'utf8');

  await store.close();
  assert.equal(await exists(lockFilePath), true, '损坏锁必须保留（人工排查）');
  assert.equal(await fs.readFile(lockFilePath, 'utf8'), '{broken lock json');
});

test('F3：reload 失败契约——抛带 code 异常（load 族），save 仍返回 {ok:false}', async (t) => {
  const h = await harness(t);
  const store = h.make();
  await store.load();
  assert.equal((await store.save()).ok, true);

  await fs.writeFile(h.filePath, '{bad json', 'utf8');
  const error = await rejectsWithCode(() => store.reload(), XHH_OPERATION_STORE_ERROR_CODES.STATE_INVALID);
  assert.match(error.message, /reload/);

  // save 的成功/失败契约不变：返回结构化结果，不抛异常。
  const saved = await store.save();
  assert.equal(saved.ok, false);
  assert.equal(saved.error.code, XHH_OPERATION_STORE_ERROR_CODES.STATE_INVALID);
  assert.equal(await fs.readFile(h.filePath, 'utf8'), '{bad json', '失败时不得覆盖原文件');
});

