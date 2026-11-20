// task-132 终审 blocking：hook 对账的故障行为测试。
// 覆盖：恢复后补投暂停事实、同类事件不相互覆盖、送达查询失败阻断、迁移落盘失败重试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createBackgroundPatrolBridgeHook } from '../src/core/background-patrol-bridge-hook.mjs';

const NOW = Date.now();
const BG = 'patrol:background';
const TOKEN = 'task132-faults-console-token-0123456789ab';

function baseState(overrides = {}) {
  return {
    schemaVersion: 1,
    day: '2026-10-27',
    lastSeenAt: NOW,
    readCount: 0,
    buckets: { post: { count: 0, lastActionAt: null }, comment: { count: 0, lastActionAt: null } },
    operations: {},
    consecutiveWriteFailures: 0,
    writePaused: false,
    writeReason: null,
    accessPaused: false,
    accessReason: null,
    ...overrides,
  };
}

async function withHarness(state, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'patrol-reconcile-faults-'));
  const storePath = path.join(dir, 'controller.json');
  await writeFile(storePath, JSON.stringify(state), 'utf8');
  const hook = createBackgroundPatrolBridgeHook({
    config: { backgroundPatrol: { enabled: true, platforms: { tieba: true, xiaoheihe: true }, groupExempt: true } },
    consoleToken: TOKEN,
    controllerStorePath: storePath,
    ownerQQ: 10001,
    sessions: { [BG]: 'fixture-session' },
    sessionsProvider: () => ({ [BG]: 'fixture-session' }),
    backgroundSessionId: 'fixture-session',
    port: 0,
    logger: { warn() {}, error() {} },
  });
  try {
    const started = await hook.start();
    assert.equal(started.ok, true, JSON.stringify(started));
    return await fn({ hook, storePath, dir });
  } finally {
    await hook.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeLedger() {
  const delivered = new Set();
  const calls = [];
  const failures = [];
  return {
    calls,
    failures,
    enqueue: async (event, reason, meta) => {
      calls.push({ event, reason, meta });
      if (failures.includes(event)) return { ok: false, reason: 'queue-full' };
      return { ok: true, id: `${event}-${calls.length}`, duplicate: false };
    },
    isDelivered: async (event, operationId) => ({ ok: true, delivered: delivered.has(`${event}|${operationId}`) }),
    markDelivered(event, operationId) {
      delivered.add(`${event}|${operationId}`);
    },
  };
}

test('adminRecover 之后：暂停事件与恢复事件都按转换列表补投（不再只看 active pause）', async () => {
  const idA = `write-pause:2026-10-27:${NOW}:1`;
  const idB = `admin-recover:2026-10-27:${NOW + 1000}:2`;
  const state = baseState({
    transitionSeq: 2,
    writePauseEventId: idA,
    writePauseAt: NOW,
    lastRecoverEventId: idB,
    transitionEvents: [
      { event: 'write-paused', reason: 'write-paused', operationId: idA, at: NOW },
      { event: 'recovered', reason: 'admin-recover', operationId: idB, at: NOW + 1000 },
    ],
  });
  await withHarness(state, async ({ hook }) => {
    const ledger = fakeLedger();
    const result = await hook.reconcile(ledger);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.blocked, false, JSON.stringify(result.blockReasons));
    assert.deepEqual(ledger.calls.map((call) => call.event), ['write-paused', 'recovered']);
    assert.equal(ledger.calls[0].meta.operationId, idA);
    assert.equal(ledger.calls[1].meta.operationId, idB);
  });
});

test('同类事件多次发生：每次暂停/恢复都有独立 operationId，不被覆盖', async () => {
  const id1 = `write-pause:2026-10-27:${NOW}:1`;
  const id2 = `write-pause:2026-10-27:${NOW + 1000}:2`;
  const id3 = `admin-recover:2026-10-27:${NOW + 2000}:3`;
  const state = baseState({
    transitionSeq: 3,
    transitionEvents: [
      { event: 'write-paused', reason: 'write-paused', operationId: id1, at: NOW },
      { event: 'write-paused', reason: 'write-paused', operationId: id2, at: NOW + 1000 },
      { event: 'recovered', reason: 'admin-recover', operationId: id3, at: NOW + 2000 },
    ],
  });
  await withHarness(state, async ({ hook }) => {
    const ledger = fakeLedger();
    const result = await hook.reconcile(ledger);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.blocked, false, JSON.stringify(result.blockReasons));
    assert.equal(ledger.calls.length, 3);
    assert.equal(new Set(ledger.calls.map((call) => call.meta.operationId)).size, 3);
  });
});

test('送达查询失败：不投递、标记 blocked（delivered-query-failed），修好后可补投', async () => {
  const state = baseState({
    writePaused: true,
    writeReason: 'consecutive-failures',
    consecutiveWriteFailures: 3,
  });
  await withHarness(state, async ({ hook }) => {
    const calls = [];
    let broken = true;
    const ledger = {
      enqueue: async (event, reason, meta) => {
        calls.push({ event, reason, meta });
        return { ok: true, id: String(calls.length) };
      },
      isDelivered: async () => {
        if (broken) throw new Error('ledger-broken');
        return { ok: true, delivered: false };
      },
    };
    const first = await hook.reconcile(ledger);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.blocked, true);
    assert.ok(first.blockReasons.includes('delivered-query-failed'), JSON.stringify(first.blockReasons));
    assert.equal(calls.length, 0, '查询失败时不得投递（宁缺勿重）');
    broken = false;
    const second = await hook.reconcile(ledger);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.blocked, false, JSON.stringify(second.blockReasons));
    assert.equal(calls.length, 1);
  });
});

test('迁移落盘失败：首次 blocked=persist-failed，恢复写入能力后重试保存并解除 blocked', async () => {
  const original = baseState({ writePaused: true, writeReason: 'consecutive-failures', consecutiveWriteFailures: 3 });
  await withHarness(original, async ({ hook, storePath }) => {
    await rm(storePath);
    await mkdir(storePath);
    const ledger = fakeLedger();
    const first = await hook.reconcile(ledger);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.migrated, true);
    assert.equal(first.blocked, true);
    assert.ok(first.blockReasons.includes('persist-failed'), JSON.stringify(first.blockReasons));
    // 修复磁盘：恢复原状态文件（模拟运维恢复写入能力），第二次对账必须重试保存。
    await rm(storePath, { recursive: true, force: true });
    await writeFile(storePath, JSON.stringify(original), 'utf8');
    const second = await hook.reconcile(ledger);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.persisted, true, JSON.stringify(second));
    assert.equal(second.blocked, false, JSON.stringify(second.blockReasons));
    const saved = JSON.parse(await readFile(storePath, 'utf8'));
    assert.equal(saved.writePaused, true);
    assert.equal(typeof saved.writePauseEventId, 'string');
  });
});

test('P2-2 送达查询返回 ok:false（非抛错）：同样不投递且 blocked=delivered-query-failed', async () => {
  const state = baseState({ writePaused: true, writeReason: 'consecutive-failures', consecutiveWriteFailures: 3 });
  await withHarness(state, async ({ hook }) => {
    const calls = [];
    let unavailable = true;
    const ledger = {
      enqueue: async (event, reason, meta) => { calls.push({ event, reason, meta }); return { ok: true, id: String(calls.length) }; },
      isDelivered: async () => (unavailable ? { ok: false, reason: 'delivered-unavailable' } : { ok: true, delivered: false }),
    };
    const first = await hook.reconcile(ledger);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.blocked, true);
    assert.ok(first.blockReasons.includes('delivered-query-failed'), JSON.stringify(first.blockReasons));
    assert.equal(calls.length, 0, 'ok:false 时不得投递');
    unavailable = false;
    const second = await hook.reconcile(ledger);
    assert.equal(second.blocked, false, JSON.stringify(second.blockReasons));
    assert.equal(calls.length, 1, '恢复后可补投');
  });
});
