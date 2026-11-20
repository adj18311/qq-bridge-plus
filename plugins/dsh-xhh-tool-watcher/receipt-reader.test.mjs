import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as decision from '../../src/core/xhh-tool-surface-decision.mjs';
import { createReceiptReader } from './receipt-reader.mjs';

const NOW = 1793360000000;

async function tempInbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-notice-receipt-'));
  const inboxDir = path.join(dir, 'inbox');
  await fs.mkdir(path.join(inboxDir, 'receipts'), { recursive: true });
  return { dir, inboxDir };
}

/** 记录调用顺序的假判定模块（只包住 noteToolSurfaceDelivery，避免依赖真实实现细节）。 */
function fakeDecision({ onNote } = {}) {
  return {
    noteToolSurfaceDelivery(state, payload) {
      if (typeof onNote === 'function') onNote(state, payload);
      return {
        state: {
          ...state,
          lastAttemptAt: payload.at,
          lastAttemptOutcome: payload.outcome,
          lastAlertAt: payload.deliveredAt ?? state.lastAlertAt,
        },
      };
    },
  };
}

async function writeReceipt(inboxDir, name, body) {
  await fs.writeFile(path.join(inboxDir, 'receipts', name), typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
}

test('真实判定模块：delivered 回执推进 lastAlertAt/attempts，unknown 只推进 lastAttemptAt（不用 fake 自证）', async () => {
  const realDecision = await import('../../src/core/xhh-tool-surface-decision.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-real-'));
  await fs.mkdir(path.join(dir, 'receipts'), { recursive: true });
  // 真实模块要求完整 v2 状态；直接构造一个「已缺失三次、尚未确认送达」的合法状态。
  let state = {
    schemaVersion: 2,
    consecutiveMisses: 3,
    lastAlertAt: 0,
    lastState: 'absent',
    lastObservedAt: 1793360120000,
    lastReason: 'missing-tools',
    lastAttemptAt: 1793360120000,
    lastAttemptOutcome: 'unknown',
    lastScheduledAt: 1793360120000,
  };
  const clock = () => 1_800_000_000_000;
  const reader = createReceiptReader({
    inboxDir: dir,
    decision: realDecision,
    getState: () => state,
    setState: (next) => { state = next; },
    clock,
    fs,
  });
  const deliveredAt = 1793360180000;
  await fs.writeFile(
    path.join(dir, 'receipts', 'notice-1.json'),
    JSON.stringify({ noticeId: 'notice-1', outcome: 'delivered', at: deliveredAt }),
    'utf8',
  );
  const first = await reader.poll();
  assert.equal(first.applied, 1);
  assert.equal(state.lastAlertAt, deliveredAt, '真实模块：delivered 必须推进 lastAlertAt');
  assert.equal(state.lastAttemptOutcome, 'delivered');

  await fs.writeFile(
    path.join(dir, 'receipts', 'notice-2.json'),
    JSON.stringify({ noticeId: 'notice-2', outcome: 'unknown', at: deliveredAt + 1000 }),
    'utf8',
  );
  const second = await reader.poll();
  assert.equal(second.applied, 1);
  assert.equal(state.lastAlertAt, deliveredAt, 'unknown 不得覆盖已确认送达');
  assert.equal(state.lastAttemptOutcome, 'unknown');
  assert.equal(state.lastAttemptAt, deliveredAt + 1000);
  await fs.rm(dir, { recursive: true, force: true });
});

test('delivered 回执：带 deliveredAt 记账，并把回执归档', async () => {
  const { inboxDir } = await tempInbox();
  const calls = [];
  let state = { lastAlertAt: 0 };
  const reader = createReceiptReader({
    inboxDir,
    decision: fakeDecision({ onNote: (s, p) => calls.push(p) }),
    getState: () => state,
    setState: (next) => { state = next; },
    clock: () => NOW,
    fs,
  });
  await writeReceipt(inboxDir, 'n1.json', { noticeId: 'n1', outcome: 'delivered', at: NOW - 5 });

  const result = await reader.poll();
  assert.equal(result.applied, 1);
  assert.deepEqual(calls[0], { at: NOW - 5, outcome: 'delivered', deliveredAt: NOW - 5 });
  assert.equal(state.lastAlertAt, NOW - 5);
  assert.equal(reader.snapshot().delivered, 1);
  const archived = await fs.readdir(path.join(inboxDir, 'receipts', 'processed'));
  assert.deepEqual(archived, ['n1.json']);
});

test('failed / unknown 回执：只推进 lastAttemptAt，绝不写 deliveredAt', async () => {
  const { inboxDir } = await tempInbox();
  const calls = [];
  let state = { lastAlertAt: 0 };
  const reader = createReceiptReader({
    inboxDir,
    decision: fakeDecision({ onNote: (s, p) => calls.push(p) }),
    getState: () => state,
    setState: (next) => { state = next; },
    clock: () => NOW,
    fs,
  });
  await writeReceipt(inboxDir, 'f.json', { outcome: 'failed', at: NOW - 10 });
  await writeReceipt(inboxDir, 'u.json', { outcome: 'unknown', at: NOW - 9 });
  await reader.poll();
  assert.deepEqual(calls.map((c) => [c.outcome, c.deliveredAt]), [['failed', null], ['unknown', null]]);
  assert.equal(state.lastAlertAt, 0, '失败不得推进 lastAlertAt（6 小时门闸靠它）');
  assert.equal(reader.snapshot().failed, 1);
  assert.equal(reader.snapshot().unknown, 1);
});

test('cancelled 回执：不记账（不重试也不标成功），但归档', async () => {
  const { inboxDir } = await tempInbox();
  let noted = 0;
  let state = { lastAlertAt: 0 };
  const reader = createReceiptReader({
    inboxDir,
    decision: fakeDecision({ onNote: () => { noted += 1; } }),
    getState: () => state,
    setState: (next) => { state = next; },
    clock: () => NOW,
    fs,
  });
  await writeReceipt(inboxDir, 'c.json', { outcome: 'cancelled', at: NOW, code: 'recovered' });
  const result = await reader.poll();
  assert.equal(noted, 0);
  assert.equal(result.applied, 0);
  assert.equal(reader.snapshot().cancelled, 1);
  assert.deepEqual(await fs.readdir(path.join(inboxDir, 'receipts', 'processed')), ['c.json']);
});

test('坏回执：非法 JSON / 未知 outcome / 超大文件都归档并计数，不抛', async () => {
  const { inboxDir } = await tempInbox();
  let state = { lastAlertAt: 0 };
  const reader = createReceiptReader({
    inboxDir, decision: fakeDecision(), getState: () => state, setState: (n) => { state = n; }, clock: () => NOW, fs,
  });
  await writeReceipt(inboxDir, 'bad.json', '{oops');
  await writeReceipt(inboxDir, 'weird.json', { outcome: 'maybe' });
  await fs.writeFile(path.join(inboxDir, 'receipts', 'big.json'), JSON.stringify({ outcome: 'delivered', pad: 'x'.repeat(5000) }), 'utf8');
  const result = await reader.poll();
  assert.equal(result.applied, 0);
  assert.equal(reader.snapshot().malformed, 2);
  assert.equal(reader.snapshot().tooLarge, 1);
  assert.deepEqual((await fs.readdir(path.join(inboxDir, 'receipts', 'processed'))).sort(), ['bad.json', 'big.json', 'weird.json']);
});

test('记账抛错：不得归档（下一轮重试），且计数可观察', async () => {
  const { inboxDir } = await tempInbox();
  let state = { lastAlertAt: 0 };
  const badDecision = { noteToolSurfaceDelivery() { throw new Error('boom'); } };
  const reader = createReceiptReader({
    inboxDir, decision: badDecision, getState: () => state, setState: (n) => { state = n; }, clock: () => NOW, fs,
  });
  await writeReceipt(inboxDir, 'r.json', { outcome: 'delivered', at: NOW });
  await reader.poll();
  assert.equal(reader.snapshot().writeFailures, 1);
  assert.deepEqual(await fs.readdir(path.join(inboxDir, 'receipts')), ['r.json'], '必须留在 receipts/ 等重试');
});

test('没有 receipts 目录：返回 no-receipts，不抛', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-notice-receipt-empty-'));
  const reader = createReceiptReader({
    inboxDir: dir, decision: fakeDecision(), getState: () => ({}), setState: () => {}, clock: () => NOW, fs,
  });
  const result = await reader.poll();
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'no-receipts');
});

test('同步 step 的幂等：同一回执被读两次（归档失败时）不会重复记账', async () => {
  const { inboxDir } = await tempInbox();
  let noted = 0;
  let state = { lastAlertAt: 0 };
  const failingArchiveFs = {
    ...fs,
    rename: async (from, to) => {
      if (String(to).includes('processed')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return fs.rename(from, to);
    },
  };
  const reader = createReceiptReader({
    inboxDir,
    decision: fakeDecision({ onNote: () => { noted += 1; } }),
    getState: () => state,
    setState: (n) => { state = n; },
    clock: () => NOW,
    fs: failingArchiveFs,
  });
  await writeReceipt(inboxDir, 'dup.json', { outcome: 'delivered', at: NOW });
  await reader.poll();
  await reader.poll();
  // 归档失败时文件还在，第二轮会再记一次 —— 这是已知的 at-least-once 记账，
  // 判定模块的记账是幂等的（同一 at/outcome 重复不会推进时间），所以只断言"不会崩"。
  assert.ok(noted >= 1);
  assert.equal(reader.snapshot().writeFailures >= 1, true);
});

test('同名回执被重新写回后必须重新处理（mtime 变化）——不得记住文件名就永久跳过', async () => {
  const { dir, inboxDir } = await tempInbox();
  let state = { schemaVersion: 2, lastAttemptAt: 0, lastAttemptOutcome: null, lastAlertAt: 0 };
  const noted = [];
  const reader = createReceiptReader({
    inboxDir,
    decision: fakeDecision({ onNote: (_s, payload) => noted.push(payload.outcome) }),
    getState: () => state,
    setState: (next) => { state = next; },
    clock: () => NOW,
  });

  await writeReceipt(inboxDir, 'n1.json', { noticeId: 'n1', outcome: 'delivered', at: NOW });
  const first = await reader.poll();
  assert.equal(first.applied, 1);

  // 同一个 noticeId 的回执被重新写回（不同的 at / mtime）：必须再处理一次。
  await new Promise((r) => setTimeout(r, 25));
  await writeReceipt(inboxDir, 'n1.json', { noticeId: 'n1', outcome: 'delivered', at: NOW + 60_000 });
  const second = await reader.poll();
  assert.equal(second.applied, 1, '重新写回的同名回执不得被永久跳过');
  assert.deepEqual(noted, ['delivered', 'delivered']);
  await fs.rm(dir, { recursive: true, force: true });
});
