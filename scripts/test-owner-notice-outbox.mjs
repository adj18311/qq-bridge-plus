import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {
  OWNER_NOTICE_RETRY_MIN_MS,
  OWNER_NOTICE_ATTEMPT_STALE_MS,
  OWNER_NOTICE_MAX_ATTEMPTS_PER_HOUR,
  OWNER_NOTICE_MAX_ATTEMPTS_KEPT,
  parseOwnerNoticeRequest,
  parseOwnerNoticeState,
  renderOwnerNotice,
  nextAttemptAt,
  createOwnerNoticeOutbox,
} from '../src/core/owner-notice-outbox.mjs';

const MIN = 60 * 1000;

function validRequest(over = {}) {
  return {
    schemaVersion: 1,
    eventId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    kind: 'tool-surface-missing',
    missingCount: 12,
    consecutiveMisses: 3,
    lastSeenAt: 1793333064000,
    createdAt: 1793333064640,
    ...over,
  };
}

async function tempFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-notice-'));
  return path.join(dir, 'owner-notice-inbox.json');
}

function fakeClock(start = 1793333064640) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
    set: (value) => { now = value; },
  };
}

function recorder() {
  const calls = [];
  const send = async (text) => {
    calls.push(text);
    const next = recorder.results.shift() ?? { outcome: 'delivered' };
    if (next instanceof Error) throw next;
    return next;
  };
  send.calls = calls;
  return send;
}
recorder.results = [];

test('parseOwnerNoticeRequest: 合法请求通过且字段被冻结', () => {
  const result = parseOwnerNoticeRequest(validRequest());
  assert.equal(result.ok, true);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(result.value.missingCount, 12);
});

test('parseOwnerNoticeRequest: 多余键一律拒绝（不接受自由文本/路径/凭据）', () => {
  for (const extra of ['text', 'message', 'url', 'path', 'token', 'qq', 'ownerUserId']) {
    const result = parseOwnerNoticeRequest(validRequest({ [extra]: 'x' }));
    assert.equal(result.ok, false, extra);
    assert.equal(result.reason, `unknown-key:${extra}`);
  }
});

test('parseOwnerNoticeRequest: 逐项拒绝非法值', () => {
  const cases = [
    [null, 'request-not-object'],
    [[], 'request-not-object'],
    [validRequest({ schemaVersion: 2 }), 'schema-version-unsupported'],
    [validRequest({ eventId: 'short' }), 'invalid-event-id'],
    [validRequest({ eventId: 'ZZZZZZZZZZZZZZZZZZZZ' }), 'invalid-event-id'],
    [validRequest({ kind: 'other' }), 'invalid-kind'],
    [validRequest({ missingCount: 0 }), 'invalid-missing-count'],
    [validRequest({ missingCount: 65 }), 'invalid-missing-count'],
    [validRequest({ missingCount: 1.5 }), 'invalid-missing-count'],
    [validRequest({ consecutiveMisses: 0 }), 'invalid-consecutive-misses'],
    [validRequest({ lastSeenAt: 0 }), 'invalid-last-seen-at'],
    [validRequest({ createdAt: -1 }), 'invalid-created-at'],
  ];
  for (const [input, reason] of cases) {
    const result = parseOwnerNoticeRequest(input);
    assert.equal(result.ok, false, reason);
    assert.equal(result.reason, reason);
  }
});

test('parseOwnerNoticeRequest: 超过 2KB 拒绝（体积判定先于键校验）', () => {
  const huge = { ...validRequest(), extraPadding: 'x'.repeat(4096) };
  const big = parseOwnerNoticeRequest(huge);
  assert.equal(big.ok, false);
  assert.equal(big.reason, 'request-too-large');
});

test('renderOwnerNotice: 固定模板，只含整数与 HH:MM（北京时间）', () => {
  const text = renderOwnerNotice({ kind: 'tool-surface-missing', missingCount: 12, consecutiveMisses: 3, lastSeenAt: 1793333064000 });
  assert.match(text, /^【工具自愈】小黑盒工具连续 3 次检查不可见（缺失 12 个，最后可见于北京时间 \d{2}:\d{2}）/u);
  assert.match(text, /不是平台报警/u);
  assert.equal(text.includes('a1b2c3d4'), false);
});

test('renderOwnerNotice: 恢复模板', () => {
  const text = renderOwnerNotice({ kind: 'tool-surface-recovered', consecutiveMisses: 5, lastSeenAt: 1793333064000 });
  assert.match(text, /已恢复可见/u);
  assert.match(text, /此前连续 5 次检查缺失/u);
});

test('nextAttemptAt: 无尝试 ⇒ createdAt；unknown ⇒ +15 分钟', () => {
  const base = { createdAt: 1000, attempts: [] };
  assert.equal(nextAttemptAt(base), 1000);
  const withAttempt = { createdAt: 1000, attempts: [{ attemptId: 'a-1', startedAt: 2000, finishedAt: 2500, outcome: 'unknown', code: 'x' }] };
  assert.equal(nextAttemptAt(withAttempt), 2500 + OWNER_NOTICE_RETRY_MIN_MS);
});

test('submit: 落盘、重复投递不新增事件', async () => {
  const filePath = await tempFile();
  const box = createOwnerNoticeOutbox({ filePath, clock: fakeClock().now, send: async () => ({ outcome: 'delivered' }) });
  const first = await box.submit(validRequest());
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  const second = await box.submit(validRequest());
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  const snap = await box.snapshot();
  assert.equal(snap.events.length, 1);
  assert.equal(snap.open, 1);
});

function seedEvents(kinds, overrides = {}) {
  return {
    schemaVersion: 1,
    events: kinds.map((kind, i) => ({
      eventId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      kind,
      missingCount: 1,
      consecutiveMisses: 3,
      lastSeenAt: 1000,
      createdAt: 1000,
      deliveredAt: null,
      closedAt: null,
      attempts: [],
      ...overrides,
    })),
  };
}

test('submit: 容量上限只拦「无法合并的新事件」（合并先于容量，否则已有事件永远刷新不了）', async () => {
  const filePath = await tempFile();
  // 20 个未结事件，但**没有**可合并的 missing ⇒ 新 missing 无法合并，必须被容量拦住。
  await fs.writeFile(filePath, JSON.stringify(seedEvents(Array.from({ length: 20 }, () => 'tool-surface-recovered'))), 'utf8');
  const box = createOwnerNoticeOutbox({ filePath, clock: fakeClock().now, send: async () => ({ outcome: 'delivered' }) });
  const overflow = await box.submit(validRequest({ eventId: '00000000-0000-0000-0000-000000000099' }));
  assert.equal(overflow.ok, false);
  assert.equal(overflow.reason, 'too-many-open-events');
  const snap = await box.snapshot();
  assert.equal(snap.capacityRejections, 1);
  assert.equal(snap.mergedRefreshes, 0);
});

test('submit: 容量饱和时仍能刷新已有 missing（回归：容量检查不得挡住合并）', async () => {
  const filePath = await tempFile();
  // 19 条 recovered + 1 条 missing（合计 20 = 上限）；新 missing 必须合并刷新，而不是被拒。
  const kinds = [...Array.from({ length: 19 }, () => 'tool-surface-recovered'), 'tool-surface-missing'];
  await fs.writeFile(filePath, JSON.stringify(seedEvents(kinds)), 'utf8');
  const box = createOwnerNoticeOutbox({ filePath, clock: fakeClock().now, send: async () => ({ outcome: 'delivered' }) });
  const requestLastSeenAt = 1793333064500;
  const result = await box.submit(validRequest({
    eventId: '00000000-0000-0000-0000-0000000000aa',
    missingCount: 11,
    consecutiveMisses: 7,
    lastSeenAt: requestLastSeenAt,
  }));
  assert.equal(result.ok, true, `容量饱和时合并必须成功，实际 ${JSON.stringify(result)}`);
  assert.equal(result.merged, true);
  assert.equal(result.eventId, '00000000-0000-0000-0000-000000000019');

  const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const refreshed = onDisk.events.find((event) => event.eventId === '00000000-0000-0000-0000-000000000019');
  assert.equal(refreshed.missingCount, 11, '已有事件必须被刷新到最新缺失数');
  assert.equal(refreshed.consecutiveMisses, 7);
  assert.equal(refreshed.lastSeenAt, requestLastSeenAt);

  const snap = await box.snapshot();
  assert.equal(snap.mergedRefreshes, 1);
  assert.equal(snap.capacityRejections, 0);
  assert.equal(snap.open, 20, '刷新不得新增未结事件');
});

test('drain: delivered 后不再发送', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const send = recorder();
  send.calls.length = 0;
  recorder.results.length = 0;
  recorder.results.push({ outcome: 'delivered' });
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  await box.submit(validRequest());
  const first = await box.drain();
  assert.equal(first.delivered, 1);
  assert.equal(send.calls.length, 1);
  clock.advance(60 * MIN);
  const second = await box.drain();
  assert.equal(second.attempted, 0);
  assert.equal(send.calls.length, 1);
});

test('drain: unknown ⇒ 15 分钟后重试，且 repeated（不承诺 exactly-once）', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const send = recorder();
  send.calls.length = 0;
  recorder.results.length = 0;
  recorder.results.push({ outcome: 'unknown', code: 'timeout' }, { outcome: 'delivered' });
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  await box.submit(validRequest());
  const first = await box.drain();
  assert.equal(first.unknown, 1);
  const snap1 = await box.snapshot();
  assert.equal(snap1.events[0].lastOutcome, 'unknown');
  assert.equal(snap1.events[0].nextAttemptAt, clock.now() + OWNER_NOTICE_RETRY_MIN_MS);

  clock.advance(OWNER_NOTICE_RETRY_MIN_MS - 1);
  assert.equal((await box.drain()).attempted, 0, '未到 15 分钟不得重发');

  clock.advance(1);
  const third = await box.drain();
  assert.equal(third.delivered, 1);
  assert.equal(send.calls.length, 2);
  assert.equal((await box.snapshot()).open, 0);
});

test('drain: 失败持续补报，不静默耗尽（20 轮仍会再试）', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const send = recorder();
  send.calls.length = 0;
  recorder.results.length = 0;
  for (let i = 0; i < 40; i += 1) recorder.results.push({ outcome: 'failed', code: 'http-500' });
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  await box.submit(validRequest());
  let attempts = 0;
  for (let i = 0; i < 20; i += 1) {
    const report = await box.drain();
    attempts += report.attempted;
    clock.advance(OWNER_NOTICE_RETRY_MIN_MS);
  }
  assert.equal(attempts > 0, true);
  const snap = await box.snapshot();
  assert.equal(snap.open, 1, '事件必须保留');
});

test('drain: 崩溃恢复 —— 未结算的旧 attempt 判 unknown 并重试', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const send = recorder();
  send.calls.length = 0;
  recorder.results.length = 0;
  recorder.results.push({ outcome: 'delivered' });
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  await box.submit(validRequest());

  // 模拟「写完 attempt 后进程崩溃」：手工写入未结算的 attempt。
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  raw.events[0].attempts.push({
    attemptId: `${raw.events[0].eventId}-1`,
    startedAt: clock.now() - OWNER_NOTICE_ATTEMPT_STALE_MS - 1,
    finishedAt: null,
    outcome: null,
    code: null,
  });
  await fs.writeFile(filePath, JSON.stringify(raw), 'utf8');

  // 进程重启：新实例重新从磁盘加载（旧实例内存里的状态不能复用）
  const box2 = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  // 崩溃恢复后仍要遵守「两次尝试至少间隔 15 分钟」：本轮只结算、不发送。
  const settleOnly = await box2.drain();
  assert.equal(settleOnly.attempted, 0);
  assert.equal(send.calls.length, 0);
  const settled = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(settled.events[0].attempts[0].outcome, 'unknown');
  assert.equal(settled.events[0].attempts[0].code, 'attempt-interrupted');

  clock.advance(OWNER_NOTICE_RETRY_MIN_MS);
  const report = await box2.drain();
  assert.equal(report.delivered, 1);
  assert.equal(send.calls.length, 1);
  const after = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(after.events[0].attempts[0].outcome, 'unknown');
  assert.equal(after.events[0].attempts[0].code, 'attempt-interrupted');
});

test('drain: 进行中的 attempt 本轮跳过（避免并发重复发送）', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const send = recorder();
  send.calls.length = 0;
  recorder.results.length = 0;
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  await box.submit(validRequest());
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  raw.events[0].attempts.push({
    attemptId: `${raw.events[0].eventId}-1`,
    startedAt: clock.now() - 1000,
    finishedAt: null,
    outcome: null,
    code: null,
  });
  await fs.writeFile(filePath, JSON.stringify(raw), 'utf8');
  const box2 = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  const report = await box2.drain();
  assert.equal(report.attempted, 0);
  assert.equal(send.calls.length, 0);
});

test('超时错误 ⇒ unknown；连接被拒绝 ⇒ failed', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const timeoutError = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
  const refusedError = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
  const send = recorder();
  send.calls.length = 0;
  recorder.results.length = 0;
  recorder.results.push(timeoutError, refusedError);
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  await box.submit(validRequest());
  const first = await box.drain();
  assert.equal(first.unknown, 1);
  let snap = await box.snapshot();
  assert.equal(snap.events[0].lastOutcome, 'unknown');
  assert.equal(snap.events[0].lastCode, 'ETIMEDOUT');

  clock.advance(OWNER_NOTICE_RETRY_MIN_MS);
  const second = await box.drain();
  assert.equal(second.failed, 1);
  snap = await box.snapshot();
  assert.equal(snap.events[0].lastOutcome, 'failed');
  assert.equal(snap.events[0].lastCode, 'ECONNREFUSED');
});

test('drain: 每小时尝试次数受限（不放大）', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const send = recorder();
  send.calls.length = 0;
  recorder.results.length = 0;
  for (let i = 0; i < 40; i += 1) recorder.results.push({ outcome: 'unknown' });
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  // 8 个事件 > 每小时上限 6：第一轮只能发 6 条。
  // 同类 missing 会合并，所以直接预置状态（两种 kind 交替，容量上限/限速语义保持不变）。
  const seeded = {
    schemaVersion: 1,
    events: Array.from({ length: 8 }, (_, i) => ({
      eventId: `11111111-1111-1111-1111-${String(i).padStart(12, '0')}`,
      kind: i % 2 === 0 ? 'tool-surface-missing' : 'tool-surface-recovered',
      missingCount: 1,
      consecutiveMisses: 3,
      lastSeenAt: 1000,
      createdAt: 1000,
      deliveredAt: null,
      closedAt: null,
      attempts: [],
    })),
  };
  await fs.writeFile(filePath, JSON.stringify(seeded), 'utf8');
  const first = await box.drain();
  assert.equal(first.attempted, OWNER_NOTICE_MAX_ATTEMPTS_PER_HOUR);
  assert.equal(first.rateLimited, true);
  assert.equal(send.calls.length, OWNER_NOTICE_MAX_ATTEMPTS_PER_HOUR);
  assert.equal((await box.snapshot()).open, 8, '被限速的事件必须保留');

  // 一小时后额度恢复，但旧事件此时也都到期：仍受每小时 6 次上限约束
  clock.advance(61 * MIN);
  const second = await box.drain();
  assert.equal(second.attempted, OWNER_NOTICE_MAX_ATTEMPTS_PER_HOUR);
  assert.equal(send.calls.length, 12);
  assert.equal((await box.snapshot()).open, 8, '未送达事件不得被丢弃');
});

test('persist 失败 ⇒ 不发送且可观察', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const send = recorder();
  send.calls.length = 0;
  recorder.results.length = 0;
  const failingFs = {
    open: fs.open,
    stat: fs.stat,
    unlink: fs.unlink,
    mkdir: fs.mkdir,
    readFile: fs.readFile,
    rename: fs.rename,
    writeFile: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
  };
  const logs = [];
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send, fs: failingFs, log: (...args) => logs.push(args) });
  // persist-first：写盘失败时 submit 必须如实失败，且**不得**在内存里留下"已接收"的假象。
  const submitted = await box.submit(validRequest());
  assert.equal(submitted.ok, false);
  assert.equal(submitted.reason, 'persist-failed');
  const report = await box.drain();
  assert.equal(report.attempted, 0);
  assert.equal(send.calls.length, 0, '写不下去就不许发');
  assert.equal(logs.length > 0, true);

  // 磁盘恢复后，同一 eventId 重投必须被当作**新事件**接收（不能因为内存残留而返回 duplicate）。
  const healthy = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  const retried = await healthy.submit(validRequest());
  assert.equal(retried.ok, true);
  assert.equal(retried.duplicate, false);
});

test('写盘失败后同一实例不得留下"已接收"的假内存态（重投必须 duplicate:false）', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  let writes = 0;
  const flakyFs = {
    open: fs.open,
    stat: fs.stat,
    unlink: fs.unlink,
    mkdir: fs.mkdir,
    readFile: fs.readFile,
    rename: fs.rename,
    writeFile: async (...args) => {
      writes += 1;
      if (writes === 1) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return fs.writeFile(...args);
    },
  };
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send: recorder(), fs: flakyFs });
  const first = await box.submit(validRequest());
  assert.equal(first.ok, false);
  assert.equal(first.reason, 'persist-failed');
  const second = await box.submit(validRequest());
  assert.equal(second.ok, true, '磁盘恢复后必须能接收');
  assert.equal(second.duplicate, false, '不能因为内存残留就把新事件当重复');
});

test('跨实例交替 submit 不得丢事件（拿锁后必须重读磁盘）', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const boxA = createOwnerNoticeOutbox({ filePath, clock: clock.now, send: recorder() });
  const boxB = createOwnerNoticeOutbox({ filePath, clock: clock.now, send: recorder() });

  assert.equal((await boxA.submit(validRequest({ eventId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }))).ok, true);
  clock.advance(1000);
  // 恢复类事件不与缺失类合并：B 的写入必须留在磁盘上（这是「拿锁后重读」的核心断言）
  assert.equal((await boxB.submit(validRequest({ eventId: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890', kind: 'tool-surface-recovered' }))).ok, true);
  clock.advance(1000);
  const mergedSubmit = await boxA.submit(validRequest({ eventId: 'c1b2c3d4-e5f6-7890-abcd-ef1234567890' }));
  assert.equal(mergedSubmit.ok, true);
  assert.equal(mergedSubmit.merged, true, '同类缺失提醒合并到已有未结事件');

  const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const ids = saved.events.map((event) => event.eventId).sort();
  assert.deepEqual(ids, [
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    'b1b2c3d4-e5f6-7890-abcd-ef1234567890',
  ], 'A 的旧内存态绝不能覆盖 B 刚写的事件；同类缺失提醒合并而非新增');
});

test('释放锁时校验所有者：外部替换的锁不得被本实例删除', async () => {
  const filePath = await tempFile();
  const lockPath = `${filePath}.lock`;
  const clock = fakeClock();
  const slowFs = {
    ...fs,
    open: fs.open,
    stat: fs.stat,
    unlink: fs.unlink,
    mkdir: fs.mkdir,
    readFile: fs.readFile,
    rename: fs.rename,
    writeFile: async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return fs.writeFile(...args);
    },
  };
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send: recorder(), fs: slowFs });
  const pending = box.submit(validRequest());
  // 有界等待锁真正出现：超时即断言失败（绝不允许"等不到就继续"变成空转仍绿）。
  let lockSeen = false;
  for (let index = 0; index < 200 && !lockSeen; index += 1) {
    try { await fs.stat(lockPath); lockSeen = true; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  assert.equal(lockSeen, true, '锁文件必须在 1s 内出现，否则本用例没有测到"释放时核对所有者"');
  const foreign = { instanceId: 'foreign-instance', pid: 999999, at: clock.now() };
  await fs.writeFile(lockPath, JSON.stringify(foreign), 'utf8');
  const submitted = await pending;
  assert.equal(submitted.ok, true);
  const stillThere = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  assert.equal(stillThere.instanceId, 'foreign-instance', '不是自己的锁就不许删');
});

test('状态文件是非法 JSON ⇒ state-corrupt，且绝不覆盖原文件', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const garbage = '{"schemaVersion":1,"events":[';
  await fs.writeFile(filePath, garbage, 'utf8');
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send: recorder() });
  const submitted = await box.submit(validRequest());
  assert.equal(submitted.ok, false);
  assert.equal(submitted.reason, 'state-corrupt');
  assert.equal(await fs.readFile(filePath, 'utf8'), garbage);
});

test('崩溃残留的空锁 ⇒ fail-closed（需人工删除），绝不自动接管', async () => {
  const filePath = await tempFile();
  await fs.writeFile(`${filePath}.lock`, '', 'utf8');
  const clock = fakeClock();
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send: recorder() });
  const submitted = await box.submit(validRequest());
  assert.equal(submitted.ok, false);
  assert.equal(submitted.reason, 'lock-empty-needs-recovery');
  const kept = await fs.stat(`${filePath}.lock`);
  assert.equal(kept.isFile(), true, '锁文件必须原样保留（不自动删除）');
  assert.equal(typeof box.forceReleaseStaleLock, 'undefined', '不得暴露运行期恢复接口');
  // 离线恢复：停止所有写入进程后，由人删除锁文件；新实例自然重新加锁。
  await fs.unlink(`${filePath}.lock`);
  const recovered = createOwnerNoticeOutbox({ filePath, clock: clock.now, send: recorder() });
  const submittedAgain = await recovered.submit(validRequest());
  assert.equal(submittedAgain.ok, true, '离线删除残留锁后必须能重新开工');
});

test('已结算事件超过保留上限 ⇒ 滚动裁剪最旧的，未结事件与进行中的尝试不受影响', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const base = clock.now();
  const events = [];
  for (let index = 0; index < 260; index += 1) {
    events.push({
      eventId: `${String(index).padStart(8, '0')}-e5f6-7890-abcd-ef1234567890`,
      kind: 'tool-surface-missing',
      missingCount: 12,
      consecutiveMisses: 3,
      lastSeenAt: base - 10 * MIN - index,
      createdAt: base - 10 * MIN - index,
      deliveredAt: base - 5 * MIN - index,
      closedAt: null,
      attempts: [],
    });
  }
  await fs.writeFile(filePath, JSON.stringify({ schemaVersion: 1, events }), 'utf8');
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send: recorder() });
  const submitted = await box.submit(validRequest({ eventId: 'ffffffff-e5f6-7890-abcd-ef1234567890' }));
  assert.equal(submitted.ok, true);
  const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const settled = saved.events.filter((event) => event.deliveredAt !== null);
  assert.equal(settled.length, 200, '已结算事件必须滚动裁剪到上限');
  assert.equal(saved.events.some((event) => event.eventId === 'ffffffff-e5f6-7890-abcd-ef1234567890'), true);
});

test('write-ahead 写盘失败 ⇒ 不发送（不产生"发过但没记录"的消息）', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const send = recorder();
  send.calls.length = 0;
  recorder.results.length = 0;
  recorder.results.push({ outcome: 'delivered' });
  let writes = 0;
  const flakyFs = {
    open: fs.open,
    stat: fs.stat,
    unlink: fs.unlink,
    mkdir: fs.mkdir,
    readFile: fs.readFile,
    rename: fs.rename,
    writeFile: async (...args) => {
      writes += 1;
      if (writes >= 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return fs.writeFile(...args);
    },
  };
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send, fs: flakyFs });
  const submitted = await box.submit(validRequest());
  assert.equal(submitted.ok, true);
  const report = await box.drain();
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'persist-failed');
  assert.equal(send.calls.length, 0, '尝试未落盘就不许发');
});

test('发送后落盘失败 ⇒ drain 必须 ok:false/blocked（即使本轮已送达）', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const send = recorder();
  send.calls.length = 0;
  recorder.results.length = 0;
  recorder.results.push({ outcome: 'delivered' });
  let writes = 0;
  const flakyFs = {
    open: fs.open,
    stat: fs.stat,
    unlink: fs.unlink,
    mkdir: fs.mkdir,
    readFile: fs.readFile,
    rename: fs.rename,
    writeFile: async (...args) => {
      writes += 1;
      // 第 1 次=提交状态；第 2 次=发送前 write-ahead；第 3 次=发送结果 ⇒ 让第 3 次失败。
      if (writes >= 3) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return fs.writeFile(...args);
    },
  };
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send, fs: flakyFs });
  const submitted = await box.submit(validRequest());
  assert.equal(submitted.ok, true);
  const report = await box.drain();
  assert.equal(send.calls.length, 1, '写入前失败才算「未发送」，这里必须已经发出');
  assert.equal(report.ok, false, '落盘失败不能因为 report.ok 被覆盖成 true');
  assert.equal(report.blocked, true);
  assert.equal(report.reason, 'persist-failed');
  assert.equal(report.delivered, 1, '本轮确实送达的事实不得丢失');
});

test('状态损坏 ⇒ blocked，不覆盖原文件', async () => {
  const filePath = await tempFile();
  await fs.writeFile(filePath, '{"schemaVersion":9}', 'utf8');
  const before = await fs.readFile(filePath, 'utf8');
  const box = createOwnerNoticeOutbox({ filePath, clock: fakeClock().now, send: async () => ({ outcome: 'delivered' }) });
  const report = await box.drain();
  assert.equal(report.ok, false);
  assert.equal(report.blocked, true);
  assert.equal(await fs.readFile(filePath, 'utf8'), before);
});

test('单飞：并发 drain 复用同一个 Promise，send 只调一次', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  let calls = 0;
  const send = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { outcome: 'delivered' }; };
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  await box.submit(validRequest());
  const [a, b] = await Promise.all([box.drain(), box.drain()]);
  assert.equal(calls, 1);
  assert.equal(a.delivered, 1);
  assert.equal(b.delivered, 1);
});

test('close: 结案后不再发送', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const send = recorder();
  send.calls.length = 0;
  recorder.results.length = 0;
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  await box.submit(validRequest());
  await box.close('a1b2c3d4-e5f6-7890-abcd-ef1234567890', { at: clock.now() });
  const report = await box.drain();
  assert.equal(report.attempted, 0);
  assert.equal(send.calls.length, 0);
});

test('parseOwnerNoticeState: 拒绝未知 outcome / 负时间 / 非数组 attempts', () => {
  const base = {
    schemaVersion: 1,
    events: [{
      eventId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      kind: 'tool-surface-missing',
      missingCount: 1,
      consecutiveMisses: 1,
      lastSeenAt: 1000,
      createdAt: 1000,
      deliveredAt: null,
      closedAt: null,
      attempts: [],
    }],
  };
  assert.equal(parseOwnerNoticeState(base).ok, true);
  assert.equal(parseOwnerNoticeState({ ...base, events: [{ ...base.events[0], attempts: 'x' }] }).reason, 'state-attempts-not-array');
  assert.equal(
    parseOwnerNoticeState({ ...base, events: [{ ...base.events[0], attempts: [{ attemptId: 'a', startedAt: 1, finishedAt: null, outcome: 'weird', code: null }] }] }).reason,
    'state-attempt-outcome-invalid',
  );
  assert.equal(parseOwnerNoticeState({ ...base, events: [{ ...base.events[0], attempts: [{ attemptId: 'a', startedAt: -5, finishedAt: null, outcome: null, code: null }] }] }).reason, 'state-attempt-started-invalid');
});

// —— 独立复审 P2 补齐：attemptId 随机性 / 跨实例 claim / 时间窗口 / 时钟回拨 / 渲染兜底 ——

test('attemptId 每次尝试都不同（不得用 eventId+序号这种确定性拼接）', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const send = recorder();
  send.calls.length = 0;
  recorder.results.length = 0;
  recorder.results.push({ outcome: 'unknown', code: 'ETIMEDOUT' }, { outcome: 'unknown', code: 'ETIMEDOUT' });
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  await box.submit(validRequest({ lastSeenAt: clock.now() - MIN, createdAt: clock.now() }));
  await box.drain();
  clock.advance(OWNER_NOTICE_RETRY_MIN_MS + 1000);
  await box.drain();
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const ids = raw.events[0].attempts.map((item) => item.attemptId);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) {
    assert.equal(id.startsWith(raw.events[0].eventId), false, 'attemptId 不得从 eventId 推导');
  }
});

test('单实例锁：锁被活着的进程持有 ⇒ reason=owner-held 且不发送', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const send = recorder();
  send.calls.length = 0;
  recorder.results.length = 0;
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  await box.submit(validRequest({ lastSeenAt: clock.now() - MIN, createdAt: clock.now() }));
  // 用「本进程自己」当持有者：pid 一定活着（如果实现退化成「同 pid 就放过」，这里会变成发送）。
  await fs.writeFile(`${filePath}.lock`, JSON.stringify({ instanceId: 'other', pid: process.pid, at: clock.now() }), 'utf8');
  const report = await box.drain();
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'owner-held');
  assert.equal(send.calls.length, 0, '不得在别人持锁时发送');
  const kept = JSON.parse(await fs.readFile(`${filePath}.lock`, 'utf8'));
  assert.equal(kept.instanceId, 'other', '不是自己的锁不能删');
  await box.dispose();
});

test('死 pid 的锁不自动接管（fail-closed）；只能由人离线删锁恢复', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const send = recorder();
  send.calls.length = 0;
  recorder.results.length = 0;
  // 启动一个子进程让它立刻退出，拿到一个确定为「已死」的 pid。
  const deadPid = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', () => resolve(child.pid));
  });
  await fs.writeFile(`${filePath}.lock`, JSON.stringify({ instanceId: 'dead', pid: deadPid, at: clock.now() }), 'utf8');
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  await box.submit(validRequest({ lastSeenAt: clock.now() - MIN, createdAt: clock.now() }));
  const blocked = await box.drain();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'owner-held', '死 pid 也不能自动接管：unlink→open 不是原子的');
  assert.equal(blocked.holderPid, deadPid);
  assert.equal(send.calls.length, 0);
  assert.equal(typeof box.forceReleaseStaleLock, 'undefined', '不得暴露运行期恢复接口');

  // 离线恢复：确认没有任何写入进程后，由人删除锁文件。
  await box.dispose();
  await fs.unlink(`${filePath}.lock`);
  const reopened = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  const resubmitted = await reopened.submit(validRequest({ lastSeenAt: clock.now() - MIN, createdAt: clock.now() }));
  assert.equal(resubmitted.ok, true, '离线删锁后必须能重新接收');
  const report = await reopened.drain();
  assert.equal(report.delivered, 1);
  assert.equal(send.calls.length, 1);
  await reopened.dispose();
});

test('同进程第二实例：不得共享发件权（owner-held 而非并发送）', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = deferred();
  const slowSend = async () => { entered.resolve(); await gate; return { outcome: 'delivered' }; };
  const boxA = createOwnerNoticeOutbox({ filePath, clock: clock.now, send: slowSend });
  await boxA.submit(validRequest({ lastSeenAt: clock.now() - MIN, createdAt: clock.now() }));
  const draining = boxA.drain();
  // 不睡任何毫秒：send 只在 acquireLock 之后被调用，进到这里即已持锁。
  await entered.promise;
  const boxB = createOwnerNoticeOutbox({ filePath, clock: clock.now, send: async () => ({ outcome: 'delivered' }) });
  const submitted = await boxB.submit(validRequest({ lastSeenAt: clock.now() - MIN, createdAt: clock.now() }));
  assert.equal(submitted.ok, false);
  assert.equal(submitted.reason, 'owner-held', '第二个实例必须 fail-closed');
  release();
  const report = await draining;
  assert.equal(report.delivered, 1);
  await boxA.dispose();
});

test('时间窗口：未来过远的 createdAt / 超大 lastSeenAt 一律拒绝', async () => {
  const clock = fakeClock();
  const now = clock.now();
  const farFuture = parseOwnerNoticeRequest(validRequest({ createdAt: now + 365 * 24 * 60 * MIN }), { now });
  assert.equal(farFuture.ok, false);
  assert.equal(farFuture.reason, 'invalid-created-at-window');
  const tooOld = parseOwnerNoticeRequest(validRequest({ createdAt: now - 365 * 24 * 60 * MIN }), { now });
  assert.equal(tooOld.ok, false);
  assert.equal(tooOld.reason, 'invalid-created-at-window');
  const huge = parseOwnerNoticeRequest(validRequest({ lastSeenAt: Number.MAX_SAFE_INTEGER }), { now });
  assert.equal(huge.ok, false);
  assert.equal(huge.reason, 'invalid-last-seen-at-window');
  // 不传 now 时保持纯结构校验（向后兼容）
  assert.equal(parseOwnerNoticeRequest(validRequest({ lastSeenAt: Number.MAX_SAFE_INTEGER })).ok, true);
});

test('renderOwnerNotice：非法时间戳不抛错，渲染为「未知时间」', () => {
  const text = renderOwnerNotice({
    kind: 'tool-surface-missing',
    missingCount: 3,
    consecutiveMisses: 3,
    lastSeenAt: Number.MAX_SAFE_INTEGER,
  });
  assert.match(text, /未知时间/u);
  const text2 = renderOwnerNotice({ kind: 'tool-surface-recovered', consecutiveMisses: 3, lastSeenAt: null });
  assert.match(text2, /未知时间/u);
});

test('时钟回拨：finishedAt 落在未来 ⇒ fail-closed 不提前到期，墙钟追上后才重试', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const send = recorder();
  send.calls.length = 0;
  recorder.results.length = 0;
  recorder.results.push({ outcome: 'unknown', code: 'ETIMEDOUT' }, { outcome: 'delivered' });
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  await box.submit(validRequest({ lastSeenAt: clock.now() - MIN, createdAt: clock.now() }));
  await box.drain();
  const futureAt = clock.now() + 3 * 60 * MIN;
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  raw.events[0].attempts[0].finishedAt = futureAt;
  await fs.writeFile(filePath, JSON.stringify(raw), 'utf8');

  const box2 = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  clock.advance(OWNER_NOTICE_RETRY_MIN_MS + 1000);
  const early = await box2.drain();
  assert.equal(early.delivered, 0, '一次回拨不得绕开 15 分钟节流');
  assert.equal(early.skewed, 1, '必须可观察地记为 clock-skew');
  assert.equal(send.calls.length, 1, '不得因为回拨多发一条');

  clock.set(futureAt + OWNER_NOTICE_RETRY_MIN_MS + 1);
  const late = await box2.drain();
  assert.equal(late.delivered, 1, '墙钟追上记录时间后才允许重试');
  assert.equal(send.calls.length, 2);
});

test('双进程屏障：并发抢锁时只有一个进程能拿到发件权', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const barrier = `${filePath}.barrier`;
  const ready = `${filePath}.ready`;
  const children = [];
  const moduleUrl = new URL('../src/core/owner-notice-outbox.mjs', import.meta.url).href;
  const script = `
    const { createOwnerNoticeOutbox } = await import(${JSON.stringify(moduleUrl)});
    const [filePath, barrier, ready] = process.argv.slice(1);
    await import('node:fs/promises').then((fs) => fs.appendFile(ready, process.pid + String.fromCharCode(10)));
    while (true) {
      try { await import('node:fs/promises').then((fs) => fs.stat(barrier)); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
    }
    const box = createOwnerNoticeOutbox({ filePath, clock: () => ${clock.now()}, send: async () => ({ outcome: 'delivered' }) });
    const result = await box.submit({ schemaVersion: 1, eventId: process.argv[4], kind: 'tool-surface-missing', missingCount: 12, consecutiveMisses: 3, lastSeenAt: ${clock.now()} - 60000, createdAt: ${clock.now()} });
    process.stdout.write(JSON.stringify(result));
    await box.dispose();
  `;
  for (let index = 0; index < 4; index += 1) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, filePath, barrier, ready, `0000000${index}-e5f6-7890-abcd-ef1234567890`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    children.push(new Promise((resolve) => child.on('exit', () => resolve({ code: child.exitCode, out: Buffer.concat(out).toString(), err: Buffer.concat(err).toString() }))));
  }
  for (let index = 0; index < 200; index += 1) {
    const text = await fs.readFile(ready, 'utf8').catch(() => '');
    if (text.trim().split(String.fromCharCode(10)).length >= 4) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await fs.writeFile(barrier, 'go', 'utf8');
  const results = await Promise.all(children);
  for (const item of results) {
    if (item.out.trim() === '') throw new Error(`子进程没有输出（exit=${item.code}）：${item.err}`);
  }
  const parsed = results.map((item) => JSON.parse(item.out));
  const winners = parsed.filter((item) => item.ok === true);
  assert.equal(winners.length, 1, `只能有一个进程拿到锁，实际 ${winners.length}`);
  assert.equal(parsed.filter((item) => item.reason === 'owner-held').length, 3);
  const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(saved.events.length, 1, '磁盘上只能有一个事件');
});

test('in-flight attempt：10 分钟内不得被结算，超过后才判 attempt-interrupted', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const send = recorder();
  send.calls.length = 0;
  recorder.results.length = 0;
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  await box.submit(validRequest({ lastSeenAt: clock.now() - MIN, createdAt: clock.now() }));
  const startedAt = clock.now();
  const raw = {
    schemaVersion: 1,
    events: [{
      eventId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      kind: 'tool-surface-missing',
      missingCount: 12,
      consecutiveMisses: 3,
      lastSeenAt: startedAt - MIN,
      createdAt: startedAt,
      deliveredAt: null,
      closedAt: null,
      attempts: [{ attemptId: 'in-flight-attempt', startedAt, finishedAt: null, outcome: null, code: null }],
    }],
  };
  await fs.writeFile(filePath, JSON.stringify(raw), 'utf8');

  clock.advance(MIN); // 1 分钟：仍在 stale 窗口内
  const box2 = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  const fresh = await box2.drain();
  assert.equal(fresh.attempted, 0);
  assert.equal(send.calls.length, 0);
  const afterFirst = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(afterFirst.events[0].attempts[0].finishedAt, null, '10 分钟内的进行中尝试不得被结算');
  assert.equal(afterFirst.events[0].attempts[0].outcome, null);

  clock.advance(OWNER_NOTICE_ATTEMPT_STALE_MS); // 超过 10 分钟
  const box3 = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  await box3.drain();
  const after = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(after.events[0].attempts[0].outcome, 'unknown');
  assert.equal(after.events[0].attempts[0].code, 'attempt-interrupted');
});

test('时钟回拨：attempt.startedAt 落在未来（负 elapsed）也要结算为 clock-rollback 并继续', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const send = recorder();
  send.calls.length = 0;
  recorder.results.length = 0;
  recorder.results.push({ outcome: 'delivered' });
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  const eventId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const raw = {
    schemaVersion: 1,
    events: [{
      eventId,
      kind: 'tool-surface-missing',
      missingCount: 12,
      consecutiveMisses: 3,
      lastSeenAt: clock.now() - MIN,
      createdAt: clock.now() - 2 * MIN,
      deliveredAt: null,
      closedAt: null,
      attempts: [{
        attemptId: 'from-the-future',
        startedAt: clock.now() + 5 * MIN,
        finishedAt: null,
        outcome: null,
        code: null,
      }],
    }],
  };
  await fs.writeFile(filePath, JSON.stringify(raw), 'utf8');
  const box2 = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  const settle = await box2.drain();
  // 先把未来的未结算尝试结算成 unknown/clock-rollback，再按 15 分钟间隔重试
  assert.equal(settle.attempted, 0);
  const settled = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(settled.events[0].attempts[0].outcome, 'unknown');
  assert.equal(settled.events[0].attempts[0].code, 'clock-rollback');

  clock.advance(OWNER_NOTICE_RETRY_MIN_MS + 1000);
  const box3 = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  const report = await box3.drain();
  assert.equal(report.delivered, 1);
});

test('锁文件内容不可读 ⇒ 一律不抢（lock-unreadable）', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const send = recorder();
  send.calls.length = 0;
  recorder.results.length = 0;
  await fs.writeFile(`${filePath}.lock`, 'not-json', 'utf8');
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  const submitted = await box.submit(validRequest({ lastSeenAt: clock.now() - MIN, createdAt: clock.now() }));
  assert.equal(submitted.ok, false);
  assert.equal(submitted.reason, 'lock-unreadable');
  assert.equal(send.calls.length, 0);
  const kept = await fs.readFile(`${filePath}.lock`, 'utf8');
  assert.equal(kept, 'not-json', '读不懂的锁不得被删');
});

test('历史尝试超过保留上限：滚动裁剪已结算记录，仍必须继续补报', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const now = clock.now();
  const eventId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  // 造一个「有 2000 条已结算历史尝试、最后一次尝试在 20 分钟前」的事件：
  // 旧实现会在这里永久 skip（不裁剪 = 永不再发）。
  const attempts = [];
  for (let index = 0; index < 2000; index += 1) {
    attempts.push({
      attemptId: `old-${index}`,
      startedAt: now - 60 * 60 * 1000 - (2000 - index) * 1000,
      finishedAt: now - 60 * 60 * 1000 - (2000 - index) * 1000 + 5,
      outcome: 'unknown',
      code: 'send-timeout',
    });
  }
  attempts[attempts.length - 1].startedAt = now - 20 * MIN;
  attempts[attempts.length - 1].finishedAt = now - 20 * MIN + 5;
  const raw = {
    schemaVersion: 1,
    events: [{
      eventId,
      kind: 'tool-surface-missing',
      missingCount: 12,
      consecutiveMisses: 3,
      lastSeenAt: now - MIN,
      createdAt: now - MIN,
      deliveredAt: null,
      closedAt: null,
      attempts,
    }],
  };
  await fs.writeFile(filePath, JSON.stringify(raw), 'utf8');

  const send = recorder();
  send.calls.length = 0;
  recorder.results.length = 0;
  recorder.results.push({ outcome: 'delivered' });
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  const report = await box.drain();
  assert.equal(report.attempted, 1, '超过历史条数上限也必须继续补报');
  assert.equal(report.delivered, 1);
  assert.equal(send.calls.length, 1);

  const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const kept = saved.events[0].attempts;
  assert.equal(kept.length <= OWNER_NOTICE_MAX_ATTEMPTS_KEPT + 1, true, '已结算历史必须被滚动裁剪');
  assert.equal(kept[kept.length - 1].outcome, 'delivered');
});

test('时钟非法（非安全整数）时 submit fail-closed', async () => {
  const filePath = await tempFile();
  const box = createOwnerNoticeOutbox({ filePath, clock: () => 1.5, send: async () => ({ outcome: 'delivered' }) });
  const result = await box.submit(validRequest());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'clock-invalid');
});

test('state 目录不存在 ⇒ reason=state-dir-missing（而不是含糊的 claim-failed）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-notice-missing-'));
  const filePath = path.join(dir, 'nope', 'deep', 'inbox.json');
  const clock = fakeClock();
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send: async () => ({ outcome: 'delivered' }) });
  const result = await box.drain();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'state-dir-missing');
});

// —— dispose 与在途 send 的并发语义（Codex 增量复审要求） ——

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * 只让出 macrotask、不等待任何毫秒数。
 * 用于「必须仍然挂起」的否定断言：真正决定性的信号是被测函数的握手 promise，
 * 这里只负责把已有微任务冲干净，不能用 sleep 赌调度速度（负载高时会假红）。
 */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('dispose：在途 send 挂起时不得提前释放锁（第二实例拿不到锁）', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const gate = deferred();
  const entered = deferred(); // send 真正进入后再放行后续断言，避免依赖 fs I/O 时序
  const send = async () => {
    entered.resolve();
    await gate.promise;
    return { outcome: 'delivered' };
  };
  const first = createOwnerNoticeOutbox({ filePath, clock: clock.now, send });
  await first.submit(validRequest());
  const drainPromise = first.drain();
  await entered.promise;

  let disposed = false;
  const disposePromise = first.dispose().then((value) => { disposed = true; return value; });
  // 不放宽到 sleep 去赌速度：send 由 gate 卡住，dispose 在语义上就不可能先返回。
  await flush();
  await flush();
  assert.equal(disposed, false, '在途 send 未结束，dispose 不得 resolve');
  const lockWhileDisposing = await fs.readFile(`${filePath}.lock`, 'utf8').then(() => true, () => false);
  assert.equal(lockWhileDisposing, true, 'dispose 等待期间锁必须仍被持有');

  // 第二个实例：此时锁仍被持有，必须 owner-held（不得趁虚而入）
  const second = createOwnerNoticeOutbox({ filePath, clock: clock.now, send: async () => ({ outcome: 'delivered' }) });
  const blocked = await second.submit(validRequest({ eventId: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890' }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'owner-held');

  // 放行 send：drain 落盘 → dispose 才释放锁
  gate.resolve({});
  const drainReport = await drainPromise;
  assert.equal(drainReport.delivered, 1);
  const disposeResult = await disposePromise;
  assert.equal(disposeResult.ok, true);

  const after = await second.submit(validRequest({ eventId: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890' }));
  assert.equal(after.ok, true, 'dispose 完成后第二个实例应能提交');

  // 顺序不得颠倒：第二个实例读到的是「第一条已送达」的磁盘状态
  const snap = await second.snapshot();
  const firstEvent = snap.events.find((event) => event.eventId === validRequest().eventId);
  assert.equal(firstEvent.deliveredAt !== null, true);
  assert.equal(snap.events.length, 2);
});

test('dispose：无界挂起的 send 使 dispose 永不 resolve，且不提前解锁', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const gate = deferred(); // 永不 resolve
  const entered = deferred();
  const first = createOwnerNoticeOutbox({
    filePath,
    clock: clock.now,
    send: async () => { entered.resolve(); await gate.promise; return { outcome: 'delivered' }; },
  });
  await first.submit(validRequest());
  void first.drain();
  await entered.promise;

  const disposePromise = first.dispose();
  const disposeSettled = await Promise.race([
    disposePromise.then(() => 'settled'),
    flush().then(() => 'pending'),
  ]);
  assert.equal(disposeSettled, 'pending', 'send 无界挂起时 dispose 不得提前结束');

  const lockStillThere = await fs.readFile(`${filePath}.lock`, 'utf8').then(() => true, () => false);
  assert.equal(lockStillThere, true, '锁必须仍被持有（fail-closed）');

  gate.resolve({});
  const disposeResult = await disposePromise;
  assert.equal(disposeResult.ok, true, '放行后 dispose 必须结束');
  assert.equal(disposeResult.lockStillHeld ?? false, false, '放行后不得残留锁');
  const lockAfter = await fs.readFile(`${filePath}.lock`, 'utf8').then(() => true, () => false);
  assert.equal(lockAfter, false, '放行后锁文件必须被删除');
});

test('锁释放：submit / close / drain 正常结束后不得残留 .lock（每次操作都要还锁）', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send: async () => ({ outcome: 'delivered' }) });
  const lockPath = `${filePath}.lock`;
  const exists = () => fs.readFile(lockPath, 'utf8').then(() => true, () => false);

  await box.submit(validRequest());
  assert.equal(await exists(), false, 'submit 结束后锁必须已释放');

  await box.drain();
  assert.equal(await exists(), false, 'drain 结束后锁必须已释放');

  await box.close(validRequest().eventId);
  assert.equal(await exists(), false, 'close 结束后锁必须已释放');

  await box.dispose();
  assert.equal(await exists(), false, 'dispose 之后锁必须已释放');
});

test('dispose：关闭后 submit / close / drain 一律 disposed，且不再拿锁', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send: async () => ({ outcome: 'delivered' }) });
  await box.submit(validRequest());
  assert.equal((await box.dispose()).ok, true);

  const afterSubmit = await box.submit(validRequest({ eventId: 'c1b2c3d4-e5f6-7890-abcd-ef1234567890' }));
  assert.equal(afterSubmit.reason, 'disposed');
  const afterDrain = await box.drain();
  assert.equal(afterDrain.reason, 'disposed');
  const afterClose = await box.close(validRequest().eventId);
  assert.equal(afterClose.reason, 'disposed');

  const lockExists = await fs.readFile(`${filePath}.lock`, 'utf8').then(() => true, () => false);
  assert.equal(lockExists, false, '关闭后不得重新拿锁');

  // 幂等：再次 dispose 直接返回 ok，不会重入串行链
  assert.equal((await box.dispose()).ok, true);
});

test('dispose：只读接口（snapshot / load）在关闭后仍然可用', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send: async () => ({ outcome: 'delivered' }) });
  await box.submit(validRequest());
  assert.equal((await box.dispose()).ok, true);

  // 关闭是「不再接收新事件 / 不再发送」，不是「禁止读取」——排障必须能看状态
  const snap = await box.snapshot();
  assert.equal(snap.ok, true);
  assert.equal(snap.events.length, 1);
  const loaded = await box.load();
  assert.equal(loaded.ok, true); // load() 只回读盘并刷新内存，不返回列表
  const afterLoad = await box.snapshot();
  assert.equal(afterLoad.events.length, 1);
  assert.equal(afterLoad.events[0].eventId, validRequest().eventId);
});

test('dispose：锁属于他人时返回 lockStillHeld，且不偷偷删除别人的锁', async () => {
  const filePath = await tempFile();
  const clock = fakeClock();
  const box = createOwnerNoticeOutbox({ filePath, clock: clock.now, send: async () => ({ outcome: 'delivered' }) });
  await box.submit(validRequest());

  // 模拟「外部残留锁」：把锁内容改成另一个实例（不是本实例），dispose 不得删它
  const foreign = { instanceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', pid: process.pid, at: clock.now() };
  await fs.writeFile(`${filePath}.lock`, `${JSON.stringify(foreign)}
`, 'utf8');

  const result = await box.dispose();
  assert.equal(result.ok, true);
  assert.equal(result.lockStillHeld, true, 'whose lock is not ours must be reported, not silently ok');

  const stillThere = await fs.readFile(`${filePath}.lock`, 'utf8').then(() => true, () => false);
  assert.equal(stillThere, true, '他人的锁不得被删除');

  // 正常路径（锁属于自己）不返回 lockStillHeld
  const filePath2 = await tempFile();
  const box2 = createOwnerNoticeOutbox({ filePath: filePath2, clock: clock.now, send: async () => ({ outcome: 'delivered' }) });
  await box2.submit(validRequest());
  const clean = await box2.dispose();
  assert.equal(clean.ok, true);
  assert.equal('lockStillHeld' in clean, false, '清干净时不应带该字段');
});
