// task-132：hook 对账（reconcile）离线测试：legacy 迁移、幂等补投递、未确认写 fail-closed、恢复事件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createBackgroundPatrolBridgeHook } from '../src/core/background-patrol-bridge-hook.mjs';

const NOW = Date.now();
const BG = 'patrol:background';
const TOKEN = 'task132-console-token-0123456789abcdef';

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'patrol-reconcile-'));
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
    markDelivered(event, operationId) { delivered.add(`${event}|${operationId}`); },
  };
}

test('legacy 暂停状态补转换 id、落盘并补投递；重复对账不重复投递', async () => {
  await withHarness(baseState({ writePaused: true, writeReason: 'consecutive-failures', consecutiveWriteFailures: 3 }), async ({ hook, storePath }) => {
    const ledger = fakeLedger();
    const first = await hook.reconcile(ledger);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.migrated, true);
    assert.equal(first.blocked, false);
    assert.equal(ledger.calls.length, 1);
    assert.equal(ledger.calls[0].event, 'write-paused');
    assert.match(ledger.calls[0].meta.operationId, /^legacy:write-paused:/);
    const persisted = JSON.parse(await readFile(storePath, 'utf8'));
    assert.match(persisted.writePauseEventId, /^legacy:write-paused:/, '迁移后的 id 必须与状态一起落盘');

    ledger.markDelivered(ledger.calls[0].event, ledger.calls[0].meta.operationId);
    const second = await hook.reconcile(ledger);
    assert.equal(second.ok, true);
    assert.equal(second.blocked, false);
    assert.equal(ledger.calls.length, 1, '已送达的暂停事件不得重复入队');
    assert.equal(second.skipped >= 1, true);
  });
});

test('存在未完成写（pending）→ blocked，且跨日也不自动放行', async () => {
  await withHarness(baseState({
    consecutiveWriteFailures: 2,
    buckets: { post: { count: 1, lastActionAt: NOW }, comment: { count: 0, lastActionAt: null } },
    operations: { 'op-pending': { kind: 'post', status: 'pending', startedAt: NOW, finishedAt: null, late: false } },
  }), async ({ hook }) => {
    const ledger = fakeLedger();
    const result = await hook.reconcile(ledger);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.blocked, true);
    assert.equal(result.pendingWriteCount, 1);
    assert.equal(result.blockReasons.includes('unconfirmed-write-pending'), true);
    assert.equal(ledger.calls.length, 0, '被阻塞时不补投递暂停事件（本来也没有暂停）');
  });
});

test('已计额的未知写保留记录但不阻断后续巡逻', async () => {
  await withHarness(baseState({
    buckets: { post: { count: 0, lastActionAt: null }, comment: { count: 1, lastActionAt: NOW } },
    operations: { 'op-unknown': { kind: 'comment', status: 'unknown', startedAt: NOW, finishedAt: NOW + 1, late: false } },
  }), async ({ hook }) => {
    const result = await hook.reconcile(fakeLedger());
    assert.equal(result.blocked, false);
    assert.equal(result.unknownWriteCount, 1);
    assert.equal(result.blockReasons.includes('unconfirmed-write-unknown'), false);
  });
});

test('恢复事件只在「未暂停 + 有恢复 id」时补投递一次（不把 allow/success 当恢复）', async () => {
  await withHarness(baseState({ lastRecoverEventId: 'admin-recover:2026-10-27:100:7' }), async ({ hook }) => {
    const ledger = fakeLedger();
    const result = await hook.reconcile(ledger);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(ledger.calls.length, 1);
    assert.equal(ledger.calls[0].event, 'recovered');
    assert.equal(ledger.calls[0].meta.operationId, 'admin-recover:2026-10-27:100:7');
    ledger.markDelivered('recovered', 'admin-recover:2026-10-27:100:7');
    await hook.reconcile(ledger);
    assert.equal(ledger.calls.length, 1, '恢复事件不得重复投递');
  });
});

test('入队失败：结果可见（failures），不会假装成功；下次对账可重试', async () => {
  await withHarness(baseState({ writePaused: true, writeReason: 'consecutive-failures', consecutiveWriteFailures: 3 }), async ({ hook }) => {
    const ledger = fakeLedger();
    ledger.failures.push('write-paused');
    const first = await hook.reconcile(ledger);
    assert.equal(first.ok, true);
    assert.equal(first.enqueued, 0);
    assert.equal(first.delivered, 0);
    assert.equal(first.blocked, true);
    assert.ok(first.blockReasons.includes('notify-enqueue-failed'));
    assert.equal(first.failures.length, 1);
    assert.equal(first.failures[0].reason, 'queue-full');
    ledger.failures.length = 0;
    const second = await hook.reconcile(ledger);
    assert.equal(second.enqueued, 1, '失败后下一次对账必须能补投');
    assert.equal(second.blocked, false);
  });
});

test('未启动 / callbacks 缺失 → ok:false（不猜测状态）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'patrol-reconcile-notstarted-'));
  try {
    const hook = createBackgroundPatrolBridgeHook({
      config: { backgroundPatrol: { enabled: true } },
      consoleToken: TOKEN,
      controllerStorePath: path.join(dir, 'controller.json'),
      ownerQQ: 10001,
      port: 0,
      logger: { warn() {}, error() {} },
    });
    const notStarted = await hook.reconcile(fakeLedger());
    assert.equal(notStarted.ok, false);
    assert.equal(notStarted.reason, 'not-started');
    await hook.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
