import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createOwnerNoticeBridgeWiring } from '../src/core/owner-notice-bridge-wiring.mjs';

// 这一组用例回答一个具体问题：**发送超时、但底层仍未结算**时，stop / 锁 / 退出各自是什么行为。
// 现状（有意为之，且已在计划 §31 明确）：超时 = 停止等待，不取消底层发送；锁会释放、允许退出，
// 因此下一轮可能重复。这里把它钉成可观察行为，而不是靠口头声明。

const SHORT_TIMEOUT_MS = 60;
const T0 = 1793360000000;

function makeConsoleLogs() {
  const lines = [];
  return { lines, console: { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) } };
}

function hangingSend() {
  let settle = null;
  let settled = false;
  const promise = new Promise((resolve) => {
    settle = (value) => {
      settled = true;
      resolve(value);
    };
  });
  return {
    call: () => promise,
    settle: (value) => settle(value),
    isSettled: () => settled,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('超时到期时底层仍未结算 ⇒ 记 unknown/timeout，不误判 delivered', async () => {
  const logs = makeConsoleLogs();
  const h = await bridgeHarness({ globals: { __testSendTimeoutMs: SHORT_TIMEOUT_MS, console: logs.console } });
  const hang = hangingSend();
  h.bot.sendPrivateMessage = () => hang.call();

  const result = await h.sendOwnerPrivateWithReceipt('hello');
  assert.equal(result.outcome, 'unknown', '超时只能记 unknown');
  assert.equal(result.code, 'timeout');
  assert.equal(hang.isSettled(), false, '底层发送此时必须仍未结算（这正是本条要钉住的前提）');

  // 迟到结算：不得把已记的 unknown 改写成 delivered，但必须留下 warn 供排查
  hang.settle({ message_id: 9911 });
  await flush();
  await flush();
  assert.ok(
    logs.lines.some((line) => line.includes('超时后底层发送才结算')),
    `迟到结算必须写 warn，实际日志：${logs.lines.join(' | ')}`,
  );
  assert.equal(result.outcome, 'unknown', '迟到的成功不得回头修改已给出的判定');
  await h.close();
});

test('超时后 wiring 仍会结束本次投递：锁释放、回执记 unknown、下一轮 15 分钟后重试', async () => {
  const logs = makeConsoleLogs();
  const h = await bridgeHarness({ globals: { __testSendTimeoutMs: SHORT_TIMEOUT_MS, console: logs.console } });
  const hang = hangingSend();
  h.bot.sendPrivateMessage = () => hang.call();

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-notice-hang-'));
  const inboxDir = path.join(dir, 'inbox');
  const stateFile = path.join(dir, 'outbox.json');
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.writeFile(
    path.join(inboxDir, '0123456789abcdef.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      noticeId: '0123456789abcdef',
      kind: 'tool-surface-missing',
      platform: 'dsh',
      missingCount: 3,
      consecutiveMisses: 3,
      lastSeenAt: T0,
      createdAt: T0,
    })}\n`,
    'utf8',
  );

  const wiring = createOwnerNoticeBridgeWiring({
    inboxDir,
    stateFile,
    sendOwnerPrivateWithReceipt: h.sendOwnerPrivateWithReceipt,
    fs,
    clock: () => T0 + 1000,
    log: (line) => logs.lines.push(String(line)),
    minFileAgeMs: 0,
  });

  const run = await wiring.runOnce();
  assert.equal(run.ok, true, '超时必须是一次「已尝试」的投递，而不是对账失败');
  assert.equal(run.report.unknown, 1, '超时计入 unknown');
  assert.equal(run.report.delivered, 0, '超时绝不能计入 delivered');
  assert.equal(hang.isSettled(), false, '对账结束时底层仍未结算');

  const lockLeft = await fs.access(`${stateFile}.lock`).then(() => true, () => false);
  assert.equal(lockLeft, false, '超时后本次 drain 结束 ⇒ 锁必须已释放（下一轮才能重试）');

  const receipts = (await fs.readdir(path.join(inboxDir, 'receipts')).catch(() => [])).filter((n) => n.endsWith('.json'));
  assert.equal(receipts.length, 1, '超时也必须写回执（插件要能记账）');
  const receipt = JSON.parse(await fs.readFile(path.join(inboxDir, 'receipts', receipts[0]), 'utf8'));
  assert.equal(receipt.outcome, 'unknown');
  assert.equal(receipt.atLeastOnce, true, 'unknown 的语义必须是 at-least-once（可能重复）');

  await wiring.stop();
  await fs.rm(dir, { recursive: true, force: true });
  await h.close();
});

test('超时后 stop 不等待底层结算；shutdown 仍会走退出路径（取舍：不等待，可能重复）', async () => {
  const logs = makeConsoleLogs();
  const h = await bridgeHarness({ globals: { __testSendTimeoutMs: SHORT_TIMEOUT_MS, console: logs.console } });
  const hang = hangingSend();
  h.bot.sendPrivateMessage = () => hang.call();

  const pending = h.sendOwnerPrivateWithReceipt('hello');
  const settled = await Promise.race([pending.then(() => 'done'), new Promise((r) => setTimeout(() => r('pending'), 500))]);
  assert.equal(settled, 'done', '上层调用必须在超时后结束（不能永远挂着）');
  assert.equal(hang.isSettled(), false);

  // stop 必须很快返回：不等待底层 promise
  const stopStart = Date.now();
  await h.stopOwnerNoticeWiring();
  assert.ok(Date.now() - stopStart < 1000, 'stop 不得等待底层发送结算');

  // shutdown：即使底层仍未结算，也要走到退出路径（harness 的 process.exit 桩会抛 unexpected exit）
  let exitCode = null;
  try {
    await h.shutdownBridge();
  } catch (error) {
    const match = /unexpected exit (\d+)/u.exec(String(error?.message ?? error));
    if (match !== null) exitCode = Number(match[1]);
    else throw error;
  }
  assert.equal(exitCode, 0, '超时后 shutdown 必须能走到 process.exit(0)');
  assert.equal(hang.isSettled(), false, '退出时底层仍未结算 —— 这就是「可能重复」的根');

  // 迟到结算只写 warn，不得复活已结束的投递
  hang.settle({ message_id: 9912 });
  await flush();
  await flush();
  assert.ok(logs.lines.some((line) => line.includes('超时后底层发送才结算')));
});