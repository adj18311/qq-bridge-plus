// scripts/test-xiaoheihe-operation-controller.mjs
// task-20：小黑盒操作控制器（唯一权威）离线测试。
// 纯模块：不联网、不读凭据、不写生产状态、不接 bridge/调度器；只用注入时钟与内存状态。
//
// TDD：先写本文件（模块尚不存在 → 红），再实现 src/core/xiaoheihe-operation-controller.mjs（绿）。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createXhhOperationController,
  parseXhhOperationControllerState,
  XHH_OPERATION_CONTROLLER_ERROR_CODES,
  XHH_OPERATION_CONTROLLER_SCHEMA_VERSION,
  XHH_OP_READ_DAILY_LIMIT,
  XHH_OP_POST_DAILY_LIMIT,
  XHH_OP_COMMENT_DAILY_LIMIT,
  XHH_OP_POST_MIN_INTERVAL_MS,
  XHH_OP_COMMENT_MIN_INTERVAL_MS,
  XHH_OP_READ_TOOLS,
  XHH_OP_SEARCH_TOOL,
} from '../src/core/xiaoheihe-operation-controller.mjs';
import { createXhhWriteLedger } from '../src/core/xiaoheihe-write-ledger.mjs';
import { createXhhOperationStore } from '../src/core/xiaoheihe-operation-store.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BEIJING_OFFSET = 8 * HOUR;
const T0 = Date.UTC(2026, 0, 15, 1, 0, 0); // 2026-01-15 09:00 北京时间

const bjDayIndex = (ms) => Math.floor((ms + BEIJING_OFFSET) / DAY);
const bjDayStart = (index) => index * DAY - BEIJING_OFFSET;
const bjTimeAt = (ms, hour) => bjDayStart(bjDayIndex(ms)) + hour * HOUR;
const nextBjMorning = (ms) => bjDayStart(bjDayIndex(ms) + 1) + 9 * HOUR;

const HOME = 'mcp__xiaoheihe__get_home_content';
const DETAIL = 'mcp__xiaoheihe__get_post_detail';
const SEARCH = 'mcp__xiaoheihe__search_content';

test('重置后保留记录、可保存且旧票据回滚不扣新额度', async () => {
  const { controller, setNow } = makeController(T0);
  const old = expectOk(await controller.reserveWrite({ kind: 'comment', id: 'reset-old' }));
  expectOk(await controller.commitTicket(old.ticket));
  expectOk(await controller.resetDailyCounts({ scope: 'comment' }));
  let saved = parseXhhOperationControllerState(controller.serialize());
  assert.equal(saved.buckets.comment.count, 0);
  assert.equal(saved.operations['reset-old'].status, 'pending');
  setNow(T0 + 3 * MINUTE);
  const next = expectOk(await controller.reserveWrite({ kind: 'comment', id: 'reset-new' }));
  expectOk(await controller.commitTicket(next.ticket));
  expectOk(await controller.abortTicket(old.ticket));
  saved = parseXhhOperationControllerState(controller.serialize());
  assert.equal(saved.buckets.comment.count, 1);
  assert.equal(saved.operations['reset-old'].status, 'aborted');
  const reloaded = createXhhOperationController({ state: saved, clock: () => T0 + 3 * MINUTE });
  assert.equal((await reloaded.status()).comment.used, 1);
});

test('重置浏览仅影响浏览，旧读取撤销不得扣除新读取', async () => {
  const { controller } = makeController(T0);
  const old = expectOk(await controller.reserveRead({ tool: HOME, id: 'reset-read-old' }));
  expectOk(await controller.commitTicket(old.ticket));
  expectOk(await controller.resetDailyCounts({ scope: 'browse' }));
  const next = expectOk(await controller.reserveRead({ tool: HOME, id: 'reset-read-new' }));
  expectOk(await controller.commitTicket(next.ticket));
  expectOk(await controller.abortTicket(old.ticket));
  const saved = parseXhhOperationControllerState(controller.serialize());
  assert.equal(saved.readCount, 1);
  assert.equal(saved.operations['reset-read-old'].status, 'aborted');
  assert.equal(saved.operations['reset-read-new'].status, 'success');
});

test('重置全部后真实临时账本可保存并重新加载，保留旧操作及间隔', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhh-reset-roundtrip-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'controller.json');
  const first = createXhhOperationStore({ filePath, clock: () => T0 });
  await first.load();
  expectOk(await first.controller.authorizeWrite({ kind: 'post', id: 'reset-post' }));
  expectOk(await first.controller.authorizeWrite({ kind: 'comment', id: 'reset-comment' }));
  expectOk(await first.controller.resetDailyCounts({ scope: 'all' }));
  assert.equal((await first.save()).ok, true);
  await first.close();
  const second = createXhhOperationStore({ filePath, clock: () => T0 });
  try {
    await second.load();
    const saved = parseXhhOperationControllerState(second.controller.serialize());
    assert.equal(saved.buckets.post.count, 0);
    assert.equal(saved.buckets.comment.count, 0);
    assert.equal(saved.operations['reset-post'].status, 'pending');
    assert.equal(saved.operations['reset-comment'].status, 'pending');
    assert.equal(saved.buckets.comment.lastActionAt, T0);
  } finally { await second.close(); }
});

test('未标记的记录仍参与计数校验，非法重置标记必须拒绝', async () => {
  const { controller } = makeController(T0);
  expectOk(await controller.authorizeWrite({ kind: 'post', id: 'guard-reset-mark' }));
  const state = JSON.parse(controller.serialize());
  state.buckets.post.count = 0;
  assert.throws(() => parseXhhOperationControllerState(state), /小于当天已记录操作数/);
  state.operations['guard-reset-mark'].quotaReset = 'yes';
  assert.throws(() => parseXhhOperationControllerState(state), /quotaReset/);
});

const tempDirs = [];

function makeClock(startMs) {
  let now = startMs;
  return {
    clock: () => now,
    setNow(ms) {
      now = ms;
    },
    now() {
      return now;
    },
  };
}

function makeController(startMs, options = {}) {
  const clock = makeClock(startMs);
  const controller = createXhhOperationController({ clock: clock.clock, ...options });
  return { controller, ...clock };
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

function expectCode(fn, code, label = '') {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, code, `${label} 期望 code ${code}，实际 ${error?.code}（${error?.message}）`);
    return true;
  });
}

async function authorizePost(controller, id, label = '') {
  return expectOk(await controller.authorizeWrite({ kind: 'post', id }), label || `post ${id}`);
}

async function authorizeComment(controller, id, label = '') {
  return expectOk(await controller.authorizeWrite({ kind: 'comment', id }), label || `comment ${id}`);
}

test('未暂停时恢复写入不改变失败链，第三次失败仍暂停', async () => {
  const { controller, setNow } = makeController(T0);
  for (let i = 0; i < 3; i += 1) {
    setNow(T0 + i * 3 * MINUTE);
    const reserved = expectOk(await controller.reserveWrite({ kind: 'comment', id: `no-op-recovery-${i}` }));
    const started = expectOk(await controller.commitTicket(reserved.ticket));
    expectOk(await controller.finish(started.ticket, { outcome: 'failure' }));
    if (i < 2) {
      const before = await controller.serialize();
      const recovered = expectOk(await controller.adminRecover({ verifiedAdminFrom: 'console', scope: 'write' }));
      assert.equal(recovered.wasPaused, false);
      assert.equal(await controller.serialize(), before, '未暂停时恢复必须不改变任何控制器状态');
    }
  }
  const paused = await controller.status();
  assert.equal(paused.writePaused, true);
  assert.equal(paused.consecutiveWriteFailures, 3);
  const recovered = expectOk(await controller.adminRecover({ verifiedAdminFrom: 'console', scope: 'write' }));
  assert.equal(recovered.wasPaused, true);
  const after = await controller.status();
  assert.equal(after.writePaused, false);
  assert.equal(after.consecutiveWriteFailures, 0);
});

test('exports: schema version, limits, tool whitelist', () => {
  assert.equal(XHH_OPERATION_CONTROLLER_SCHEMA_VERSION, 1);
  assert.equal(XHH_OP_READ_DAILY_LIMIT, 14);
  assert.equal(XHH_OP_POST_DAILY_LIMIT, 2);
  assert.equal(XHH_OP_COMMENT_DAILY_LIMIT, 12);
  assert.equal(XHH_OP_POST_MIN_INTERVAL_MS, 3 * HOUR);
  assert.equal(XHH_OP_COMMENT_MIN_INTERVAL_MS, 3 * MINUTE);
  assert.deepEqual([...XHH_OP_READ_TOOLS], [HOME, DETAIL]);
  assert.equal(XHH_OP_SEARCH_TOOL, SEARCH);
  assert.equal(typeof createXhhOperationController, 'function');
  assert.equal(typeof parseXhhOperationControllerState, 'function');
  assert.equal(XHH_OPERATION_CONTROLLER_ERROR_CODES.STATE_INVALID, 'XHH_OPERATION_CONTROLLER_STATE_INVALID');
});

test('initial status is clean and keyed to the Beijing day', async () => {
  const { controller } = makeController(T0);
  const status = await controller.status();
  assert.equal(status.day, '2026-01-15');
  assert.equal(status.read.used, 0);
  assert.equal(status.read.limit, 14);
  assert.equal(status.post.used, 0);
  assert.equal(status.post.limit, 2);
  assert.equal(status.comment.used, 0);
  assert.equal(status.comment.limit, 12);
  assert.equal(status.writePaused, false);
  assert.equal(status.writeReason, null);
  assert.equal(status.accessPaused, false);
  assert.deepEqual(status.pending, []);
  assert.deepEqual(status.unknown, []);
});

test('read: home/post-detail count, search never counts, 14/day cap, search still allowed at cap', async () => {
  const { controller } = makeController(T0);
  for (let i = 0; i < 14; i += 1) {
    const tool = i % 2 === 0 ? HOME : DETAIL;
    const result = await controller.authorizeRead({ tool, id: `read-${i}` });
    expectOk(result, `read ${i}`);
    assert.equal(result.counted, true);
  }
  expectRejected(await controller.authorizeRead({ tool: HOME, id: 'read-14' }), 'read-daily-cap', '第 15 次读取');

  const search = await controller.authorizeRead({ tool: SEARCH });
  expectOk(search, 'search 不受读取额度限制');
  assert.equal(search.counted, false);

  const status = await controller.status();
  assert.equal(status.read.used, 14);
  assert.equal(status.read.remaining, 0);
  expectRejected(await controller.authorizeRead({ tool: 'mcp__xiaoheihe__delete_post' }), 'invalid-tool', '未知工具');
});

test('read: provided id dedupes; read tickets cannot be finished', async () => {
  const { controller } = makeController(T0);
  const first = await controller.authorizeRead({ tool: HOME, id: 'read-dup' });
  expectOk(first);
  expectRejected(await controller.authorizeRead({ tool: HOME, id: 'read-dup' }), 'duplicate', '同 id 读取重复');
  expectRejected(await controller.finish(first.ticket, { outcome: 'success' }), 'read-ticket-not-finishable', '读取 ticket 不可 finish');
});

test('post: 2/day + 3h interval; comment: 12/day + 3min interval', async () => {
  const { controller, setNow } = makeController(T0);
  await authorizePost(controller, 'post-1');
  expectRejected(await controller.authorizeWrite({ kind: 'post', id: 'post-early' }), 'min-interval', '不足 3 小时');
  setNow(T0 + 3 * HOUR);
  await authorizePost(controller, 'post-2');
  setNow(T0 + 6 * HOUR);
  expectRejected(await controller.authorizeWrite({ kind: 'post', id: 'post-3' }), 'post-daily-cap', '当日第 3 帖');

  setNow(T0 + 7 * HOUR);
  const firstComment = await controller.authorizeWrite({ kind: 'comment', id: 'comment-1' });
  expectOk(firstComment);
  setNow(T0 + 7 * HOUR + 3 * MINUTE);
  await authorizeComment(controller, 'comment-2');
  setNow(T0 + 7 * HOUR + 5 * MINUTE);
  expectRejected(await controller.authorizeWrite({ kind: 'comment', id: 'comment-early' }), 'min-interval', '评论不足 3 分钟');
  setNow(T0 + 7 * HOUR + 9 * MINUTE);
  for (let i = 3; i <= 12; i += 1) {
    const at = T0 + 7 * HOUR + (i - 1) * 3 * MINUTE;
    setNow(at);
    await authorizeComment(controller, `comment-${i}`);
  }
  setNow(T0 + 8 * HOUR);
  expectRejected(await controller.authorizeWrite({ kind: 'comment', id: 'comment-13' }), 'comment-daily-cap', '当日第 13 条评论');
});

test('unknown: kept for review, never replayed, neither failure nor success', async () => {
  const { controller, setNow } = makeController(T0);
  const ticket = await authorizeComment(controller, 'unknown-op');
  expectOk(await controller.finish(ticket.ticket, { outcome: 'unknown' }));
  const status = await controller.status();
  assert.equal(status.unknown.length, 1);
  assert.equal(status.unknown[0].id, 'unknown-op');
  assert.equal(status.consecutiveWriteFailures, 0, 'unknown 不累计失败');
  assert.equal(status.writePaused, false, 'unknown 不清零也不暂停');

  setNow(T0 + 3 * MINUTE);
  expectRejected(
    await controller.authorizeWrite({ kind: 'comment', id: 'unknown-op' }),
    'unknown-not-replayable',
    'unknown 不得重放',
  );
  // 换 id 的新操作不受影响（内容指纹不在本模块范围，调用契约要求稳定 id）。
  await authorizeComment(controller, 'after-unknown');
  assert.equal((await controller.status()).consecutiveWriteFailures, 0);
});

test('three explicit failures pause writes persistently; midnight does not lift it', async () => {
  const start = bjTimeAt(T0, 21);
  const { controller, setNow } = makeController(start);
  for (let i = 0; i < 3; i += 1) {
    setNow(start + i * 3 * MINUTE);
    const ticket = await authorizeComment(controller, `fail-${i}`);
    const out = await controller.finish(ticket.ticket, { outcome: 'failure' });
    expectOk(out, `failure ${i}`);
  }
  const paused = await controller.status();
  assert.equal(paused.writePaused, true, '第三次明确失败应持久暂停写');
  assert.equal(paused.writeReason, 'consecutive-failures');
  assert.equal(paused.consecutiveWriteFailures, 3);
  expectRejected(await controller.authorizeWrite({ kind: 'comment', id: 'blocked' }), 'write-paused', '暂停后不得写');
  // 读不受影响
  expectOk(await controller.authorizeRead({ tool: SEARCH }), '暂停写不影响检索');

  setNow(nextBjMorning(start));
  const nextDay = await controller.status();
  assert.equal(nextDay.day, '2026-01-16', '状态应按注入时钟推进日键');
  assert.equal(nextDay.writePaused, true, '跨零点不得解除写暂停');
  assert.equal(nextDay.writeReason, 'consecutive-failures');
  expectRejected(await controller.authorizeWrite({ kind: 'comment', id: 'still-blocked' }), 'write-paused', '跨日仍暂停');
});

test('access pause (login/captcha/network) blocks reads+writes, survives midnight, admin only', async () => {
  const start = bjTimeAt(T0, 23);
  const { controller, setNow } = makeController(start);
  expectOk(await controller.reportAccessUnavailable({ reason: 'captcha' }), '记录验证码暂停');
  expectRejected(await controller.authorizeRead({ tool: HOME, id: 'r1' }), 'access-paused', '暂停时禁止读');
  expectRejected(await controller.authorizeWrite({ kind: 'post', id: 'p1' }), 'access-paused', '暂停时禁止写');

  setNow(nextBjMorning(start));
  expectRejected(await controller.authorizeRead({ tool: SEARCH }), 'access-paused', '跨零点仍暂停');
  expectOk(await controller.adminRecover({ verifiedAdminFrom: 'console' }), '管理员恢复');
  expectOk(await controller.authorizeRead({ tool: SEARCH }), '恢复后可读');
});

test('adminRecover requires the console contract and never resets quota/interval/unknown', async () => {
  const { controller, setNow } = makeController(T0);
  await authorizePost(controller, 'quota-post-1');
  setNow(T0 + 3 * HOUR);
  await authorizePost(controller, 'quota-post-2');
  setNow(T0 + 6 * HOUR);
  const ticket = await authorizeComment(controller, 'quota-unknown');
  await controller.finish(ticket.ticket, { outcome: 'unknown' });
  for (let i = 0; i < 3; i += 1) {
    setNow(T0 + 6 * HOUR + (i + 1) * 4 * MINUTE);
    const t = await authorizeComment(controller, `quota-fail-${i}`);
    await controller.finish(t.ticket, { outcome: 'failure' });
  }
  assert.equal((await controller.status()).writePaused, true);

  assert.throws(() => controller.adminRecover(), TypeError, '缺少 verifiedAdminFrom');
  assert.throws(() => controller.adminRecover({ verifiedAdminFrom: 'model' }), TypeError, '非 console 契约');
  assert.throws(() => controller.adminRecover({ verifiedAdminFrom: true }), TypeError, '布尔不是契约来源');

  expectOk(await controller.adminRecover({ verifiedAdminFrom: 'console' }));
  const status = await controller.status();
  assert.equal(status.writePaused, false, '恢复清暂停');
  assert.equal(status.writeReason, null);
  assert.equal(status.accessPaused, false);
  assert.equal(status.post.used, 2, '恢复不得重置当日发帖额度');
  assert.equal(status.unknown.length, 1, '恢复不得清 unknown 记录');
  // 恢复不清额度：当天已用 2 帖，第三帖仍被日额度拒绝（即使时间间隔已满）。
  setNow(T0 + 6 * HOUR + 20 * MINUTE);
  expectRejected(
    await controller.authorizeWrite({ kind: 'post', id: 'after-recover-same-day' }),
    'post-daily-cap',
    '恢复不得重置当日额度',
  );
  // 恢复不清最小间隔：跨日后第一帖仍以最后动作时间为基准（这里已过 24h，放行）。
  setNow(nextBjMorning(T0));
  expectOk(await controller.authorizeWrite({ kind: 'post', id: 'after-recover-next-day' }), '次日可写');
});

test('cross-day resets daily counters but keeps intervals and pauses', async () => {
  const start = bjTimeAt(T0, 21);
  const { controller, setNow } = makeController(start);
  expectOk(await controller.authorizeRead({ tool: HOME, id: 'cross-read' }));
  await authorizePost(controller, 'cross-post');
  setNow(nextBjMorning(start));
  const status = await controller.status();
  assert.equal(status.day, '2026-01-16');
  assert.equal(status.read.used, 0, '跨日重置读取计数');
  assert.equal(status.post.used, 0, '跨日重置发帖计数');
  // 跨日后的发帖仍受 3 小时间隔约束（21:00 → 次日 09:00 已满 3h，放行）。
  await authorizePost(controller, 'cross-post-next-day');
  assert.equal((await controller.status()).post.used, 1);
});

test('post interval survives Beijing midnight (2h after a 23:00 post is still too early)', async () => {
  const start = bjTimeAt(T0, 23);
  const { controller, setNow } = makeController(start);
  await authorizePost(controller, 'midnight-post');
  setNow(bjDayStart(bjDayIndex(start)) + DAY + 2 * HOUR); // 次日 02:00，距 23:00 恰 3h
  expectOk(await controller.authorizeWrite({ kind: 'post', id: 'midnight-post-ok' }), '满 3h 放行');
  assert.equal((await controller.status()).day, '2026-01-16');
});

test('cross-day late finish is marked late and does not touch the new-day failure chain', async () => {
  const start = bjTimeAt(T0, 21);
  const { controller, setNow } = makeController(start);
  const ticket = await authorizeComment(controller, 'late-op');
  setNow(nextBjMorning(start));
  expectOk(await controller.finish(ticket.ticket, { outcome: 'failure' }), '迟到 failure');
  const status = await controller.status();
  assert.equal(status.day, '2026-01-16', '事件推进日键');
  assert.equal(status.comment.used, 0, '跨日重置计数');
  assert.equal(status.consecutiveWriteFailures, 0, '迟到结果不得计入新日失败链');
  assert.equal(status.writePaused, false, '迟到结果不得触发新日暂停');
  const persisted = JSON.parse(await controller.serialize());
  assert.equal(persisted.operations['late-op'].late, true, '迟到结果必须标记 late');
});

test('concurrent authorize calls are serialized (same-instant comments: exactly one allowed)', async () => {
  const { controller } = makeController(T0);
  const results = await Promise.all([
    controller.authorizeWrite({ kind: 'comment', id: 'con-1' }),
    controller.authorizeWrite({ kind: 'comment', id: 'con-2' }),
    controller.authorizeWrite({ kind: 'comment', id: 'con-3' }),
  ]);
  const ok = results.filter((item) => item?.ok === true).length;
  assert.equal(ok, 1, '同一时刻只应放行一笔评论');
  assert.equal(results.filter((item) => item?.ok === false && item.reason === 'min-interval').length, 2);
});

test('bad state is fail-closed with a code; valid state round-trips through serialize/parse', async () => {
  const { controller } = makeController(T0);
  await authorizePost(controller, 'serialize-post');
  const raw = await controller.serialize();
  const restored = createXhhOperationController({ clock: () => T0 + HOUR, state: raw });
  const status = await restored.status();
  assert.equal(status.post.used, 1);
  expectRejected(
    await restored.authorizeWrite({ kind: 'post', id: 'serialize-post' }),
    'duplicate',
    '重启后旧 id 仍去重',
  );

  for (const [label, bad] of [
    ['坏 JSON', '{'],
    ['空文件', ''],
    ['未知版本', JSON.stringify({ ...JSON.parse(raw), schemaVersion: 999 })],
    ['坏 day', JSON.stringify({ ...JSON.parse(raw), day: '2026-1-1' })],
    // task: 上限可配置到 99，因此 100 才是「不可能」的越界值；99 在硬上界内属合法状态。
    ['读计数超限', JSON.stringify({ ...JSON.parse(raw), readCount: 100 })],
    ['失败链 3 但未暂停', JSON.stringify({ ...JSON.parse(raw), consecutiveWriteFailures: 3 })],
    ['暂停无原因', JSON.stringify({ ...JSON.parse(raw), writePaused: true, writeReason: null })],
    ['原因但未暂停', JSON.stringify({ ...JSON.parse(raw), writePaused: false, writeReason: 'consecutive-failures' })],
    ['access 暂停无原因', JSON.stringify({ ...JSON.parse(raw), accessPaused: true, accessReason: null })],
    ['未知顶层字段', JSON.stringify({ ...JSON.parse(raw), extraQuota: 1 })],
    ['非法操作 id', JSON.stringify({ ...JSON.parse(raw), operations: { ' padded ': { kind: 'post', status: 'pending', startedAt: T0, finishedAt: null, late: false } } })],
    ['finishedAt 早于 startedAt', JSON.stringify({ ...JSON.parse(raw), operations: { x: { kind: 'post', status: 'success', startedAt: T0, finishedAt: T0 - 1, late: false } } })],
    ['late 与日键不符', JSON.stringify({ ...JSON.parse(raw), operations: { y: { kind: 'post', status: 'success', startedAt: T0, finishedAt: T0 + 1, late: true } } })],
  ]) {
    expectCode(() => parseXhhOperationControllerState(bad), XHH_OPERATION_CONTROLLER_ERROR_CODES.STATE_INVALID, label);
    expectCode(
      () => createXhhOperationController({ clock: () => T0, state: bad }),
      XHH_OPERATION_CONTROLLER_ERROR_CODES.STATE_INVALID,
      `${label}（create）`,
    );
  }
});

test('clock rollback is rejected as a business reason and never mutates state', async () => {
  const { controller, setNow } = makeController(T0 + HOUR);
  const before = await controller.serialize();
  setNow(T0);
  expectRejected(await controller.authorizeWrite({ kind: 'comment', id: 'rollback' }), 'clock-rollback', '时钟回拨');
  expectRejected(await controller.authorizeRead({ tool: HOME }), 'clock-rollback', '读取也要拒绝回拨');
  assert.equal(await controller.serialize(), before, '拒绝时状态不得变化');
});

test('single instance: same singletonKey cannot be created twice; close allows recreate', async () => {
  const first = createXhhOperationController({ clock: () => T0, singletonKey: 'xhh-ctlr' });
  expectCode(
    () => createXhhOperationController({ clock: () => T0, singletonKey: 'xhh-ctlr' }),
    XHH_OPERATION_CONTROLLER_ERROR_CODES.SINGLETON_CONFLICT,
    '重复创建',
  );
  await first.close();
  const again = createXhhOperationController({ clock: () => T0, singletonKey: 'xhh-ctlr' });
  await again.close();
  await expectCodeAsync(() => first.status(), XHH_OPERATION_CONTROLLER_ERROR_CODES.CLOSED, 'close 后调用');
});

async function expectCodeAsync(fn, code, label = '') {
  await assert.rejects(fn, (error) => {
    assert.equal(error?.code, code, `${label} 期望 code ${code}，实际 ${error?.code}`);
    return true;
  });
}

test('controller and ledger agree on caps/intervals/dedupe (no double deduction)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhh-ctlr-ledger-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'ledger.json');
  const clock = makeClock(T0);
  const controller = createXhhOperationController({ clock: clock.clock });
  const ledger = createXhhWriteLedger({ filePath, clock: clock.clock });
  await ledger.load();

  const script = [
    { kind: 'post', id: 'dup', at: 0 },
    { kind: 'post', id: 'dup', at: 0 },
    { kind: 'post', id: 'p1', at: 0 },
    { kind: 'post', id: 'p2', at: 3 * HOUR },
    { kind: 'post', id: 'p3', at: 3 * HOUR + 1 },
    { kind: 'comment', id: 'c1', at: 3 * HOUR + 2 },
    { kind: 'comment', id: 'c2', at: 3 * HOUR + 2 + MINUTE },
    { kind: 'comment', id: 'c2b', at: 3 * HOUR + 2 + 2 * MINUTE },
    { kind: 'comment', id: 'c2c', at: 3 * HOUR + 2 + 3 * MINUTE },
  ];

  try {
    for (const step of script) {
      clock.setNow(T0 + step.at);
      const controllerResult = await controller.authorizeWrite({ kind: step.kind, id: step.id });
      const ledgerResult = await ledger.begin({ id: step.id, bucket: step.kind });
      assert.equal(controllerResult.ok, ledgerResult.ok, `${step.id} 的放行结果必须一致`);
    }
    const status = await controller.status();
    const snapshot = await ledger.snapshot();
    assert.equal(status.post.used, snapshot.buckets.post.count, '发帖计数一致');
    assert.equal(status.comment.used, snapshot.buckets.comment.count, '评论计数一致');
  } finally {
    await ledger.close();
  }
});

test('controller works with injected state object and does not mutate the input', async () => {
  const { controller } = makeController(T0);
  await authorizePost(controller, 'state-post');
  const raw = await controller.serialize();
  const parsed = JSON.parse(raw);
  const frozen = JSON.stringify(parsed);
  const restored = createXhhOperationController({ clock: () => T0, state: parsed });
  assert.equal(JSON.stringify(parsed), frozen, '传入的 state 对象不得被修改');
  assert.equal((await restored.status()).post.used, 1);
});

test('growth pruning keeps unknown records so they can never be replayed', async () => {
  const { controller, setNow } = makeController(T0, { maxFinishedOperations: 1 });
  const unknownTicket = await authorizeComment(controller, 'prune-unknown');
  await controller.finish(unknownTicket.ticket, { outcome: 'unknown' });
  for (let i = 0; i < 4; i += 1) {
    setNow(T0 + (i + 1) * 3 * MINUTE);
    const ticket = await authorizeComment(controller, `prune-success-${i}`);
    await controller.finish(ticket.ticket, { outcome: 'success' });
  }
  const status = await controller.status();
  assert.equal(status.unknown.length, 1, 'unknown 记录不得被增长裁剪掉');

  const restored = createXhhOperationController({
    clock: () => T0 + HOUR,
    state: await controller.serialize(),
  });
  expectRejected(
    await restored.authorizeWrite({ kind: 'comment', id: 'prune-unknown' }),
    'unknown-not-replayable',
    '裁剪后 unknown 仍不得重放',
  );
});

// ── task-70：reserve / commit / abort 票据语义（execute-first） ──────────────

test('task70 reserveRead 只预占：不计数、不写 operation、status 暴露 reservedRead；commit 才 +1', async () => {
  const { controller } = makeController(T0);
  const reserved = expectOk(await controller.reserveRead({ tool: HOME, id: 'reserve-read-1' }));
  assert.equal(reserved.ticket.state, 'reserved');
  assert.equal(reserved.ticket.kind, 'read');
  assert.equal(reserved.ticket.opId, 'reserve-read-1');
  assert.equal(typeof reserved.ticket.ticketId, 'string');
  assert.equal(reserved.ticket.now, T0);

  let status = await controller.status();
  assert.equal(status.read.used, 0, 'reserve 不得增加 used');
  assert.equal(status.reservedRead, 1);
  assert.equal(JSON.parse(await controller.serialize()).readCount, 0, 'reserve 不落盘计数');

  const committed = expectOk(await controller.commitTicket(reserved.ticket));
  assert.equal(committed.started, true);
  status = await controller.status();
  assert.equal(status.read.used, 1);
  assert.equal(status.reservedRead, 0);
  assert.equal(status.pending.length, 0);
  assert.equal(JSON.parse(await controller.serialize()).operations['reserve-read-1'].status, 'success');
});

test('task-134b 不同 controller 实例的 ticketId 不得重号：旧票据在新 controller 上必须 invalid-ticket', async () => {
  // 背景：reload 会重建 controller；若 ticketId 仍从 rt-1 开始，旧票据在 issuedTickets 里
  // 可能被同号新票据覆盖，造成「旧操作静默提交新预占」。ticketId 必须带实例命名空间。
  const first = makeController(T0).controller;
  const second = makeController(T0).controller;
  const a = expectOk(await first.reserveRead({ tool: HOME, id: 'ns-ticket-a' }));
  const b = expectOk(await second.reserveRead({ tool: HOME, id: 'ns-ticket-b' }));
  assert.match(a.ticket.ticketId, /^rt-/);
  assert.match(b.ticket.ticketId, /^rt-/);
  assert.notEqual(a.ticket.ticketId, b.ticket.ticketId, '跨 controller 实例不得复用同一 ticketId');
  expectRejected(await second.commitTicket(a.ticket), 'invalid-ticket', '新 controller 必须拒绝旧实例票据');
  expectRejected(await second.abortTicket(a.ticket), 'invalid-ticket', '新 controller 不得释放旧实例票据');
  // 本实例票据语义不变：仍可正常 commit。
  expectOk(await first.commitTicket(a.ticket));
});

test('task70 reserveWrite 只预占：post/comment 计数不变；commit 后 used+1 且写操作进入 started(pending)', async () => {
  const { controller } = makeController(T0);
  const post = expectOk(await controller.reserveWrite({ kind: 'post', id: 'reserve-post-1' }));
  let status = await controller.status();
  assert.equal(status.post.used, 0);
  assert.equal(status.reservedWrite, 1);

  const committed = expectOk(await controller.commitTicket(post.ticket));
  assert.equal(committed.started, true);
  status = await controller.status();
  assert.equal(status.post.used, 1);
  assert.equal(status.reservedWrite, 0);
  assert.equal(status.pending.length, 1);
  assert.equal(status.pending[0].id, 'reserve-post-1');

  // commit 返回的 started 票据可直接 finish（成功后计数保持）。
  expectOk(await controller.finish(committed.ticket, { outcome: 'success' }));
  assert.equal((await controller.status()).post.used, 1);
});

test('task70 abortTicket 仅释放 reserved、同 opId 可重新 reserve；重复 abort/commit 明确拒绝', async () => {
  const { controller } = makeController(T0);
  const reserved = expectOk(await controller.reserveWrite({ kind: 'comment', id: 'abort-comment-1' }));
  const aborted = expectOk(await controller.abortTicket(reserved.ticket));
  assert.equal(aborted.aborted, true);
  assert.equal((await controller.status()).reservedWrite, 0);
  assert.equal((await controller.status()).comment.used, 0, 'abort 不计数');

  // abort 后同 opId 可重新 reserve（operations 未被写入）。
  const again = expectOk(await controller.reserveWrite({ kind: 'comment', id: 'abort-comment-1' }));
  expectOk(await controller.abortTicket(again.ticket));

  // 重复 abort / abort 后 commit：明确拒绝，不静默成功。
  expectRejected(await controller.abortTicket(reserved.ticket), 'invalid-ticket', '重复 abort');
  expectRejected(await controller.commitTicket(reserved.ticket), 'invalid-ticket', 'abort 后 commit');

  // task-73 起：已 commit(started) 的票据 abort 改为回滚（不再 ticket-committed）。
  const third = expectOk(await controller.reserveWrite({ kind: 'comment', id: 'abort-comment-2' }));
  const thirdCommitted = expectOk(await controller.commitTicket(third.ticket));
  const rolled = expectOk(await controller.abortTicket(thirdCommitted.ticket));
  assert.equal(rolled.rolledBack, true);
  assert.equal((await controller.status()).comment.used, 0);
});

test('task70 重复 commit 幂等：第二次返回 already:true，计数只 +1', async () => {
  const { controller } = makeController(T0);
  const reserved = expectOk(await controller.reserveRead({ tool: DETAIL, id: 'idem-read-1' }));
  const first = expectOk(await controller.commitTicket(reserved.ticket));
  assert.equal(first.already, undefined);
  const second = expectOk(await controller.commitTicket(reserved.ticket));
  assert.equal(second.started, true);
  assert.equal(second.already, true);
  assert.equal((await controller.status()).read.used, 1);
});

test('task70 并发 20 个 reserveRead 在 cap=14 下恰好 14 个成功，其余 read-daily-cap；commit 后 used=14', async () => {
  const { controller } = makeController(T0);
  const results = await Promise.all(
    Array.from({ length: 20 }, () => controller.reserveRead({ tool: HOME })),
  );
  const ok = results.filter((item) => item?.ok === true);
  assert.equal(ok.length, XHH_OP_READ_DAILY_LIMIT, `并发 reserve 恰好 ${XHH_OP_READ_DAILY_LIMIT} 个成功`);
  assert.equal(results.filter((item) => item?.ok === false && item.reason === 'read-daily-cap').length, 6);
  let status = await controller.status();
  assert.equal(status.read.used, 0, 'reserve 阶段不计数');
  assert.equal(status.reservedRead, XHH_OP_READ_DAILY_LIMIT);
  assert.equal(status.read.remaining, 0);

  for (const item of ok) expectOk(await controller.commitTicket(item.ticket));
  status = await controller.status();
  assert.equal(status.read.used, XHH_OP_READ_DAILY_LIMIT);
  assert.equal(status.reservedRead, 0);
  expectRejected(await controller.reserveRead({ tool: HOME }), 'read-daily-cap');
});

test('task70 reserve 也占用最小间隔（并发第二个写 reserve 被 min-interval 拒绝），abort 后释放', async () => {
  const { controller } = makeController(T0);
  const first = expectOk(await controller.reserveWrite({ kind: 'post', id: 'interval-post-1' }));
  expectRejected(
    await controller.reserveWrite({ kind: 'post', id: 'interval-post-2' }),
    'min-interval',
    'reserve 已占最小间隔，防止并发双发',
  );
  expectOk(await controller.abortTicket(first.ticket));
  // abort 释放间隔占用后，同一时刻的新 reserve 可以成功。
  const second = expectOk(await controller.reserveWrite({ kind: 'post', id: 'interval-post-2' }));
  expectOk(await controller.abortTicket(second.ticket));
});

test('task70 reserved 期间写 quota 用 used+reserved：2 帖 cap 下 reserve 两笔后第 3 笔 deny', async () => {
  // 该场景横跨 3 小时，显式放宽预留 TTL，确保两笔 reserved 仍然存活（默认 TTL 为 5 分钟）。
  const { controller } = makeController(T0, { reservationTtlMs: 12 * HOUR });
  const p1 = expectOk(await controller.reserveWrite({ kind: 'post', id: 'cap-post-1' }));
  const later = T0 + 3 * HOUR;
  const p2 = expectOk(await controller.reserveWrite({ kind: 'post', id: 'cap-post-2', now: later }));
  expectRejected(
    await controller.reserveWrite({ kind: 'post', id: 'cap-post-3', now: T0 + 6 * HOUR }),
    'post-daily-cap',
    'used+reserved 达上限',
  );
  expectOk(await controller.commitTicket(p1.ticket));
  expectOk(await controller.commitTicket(p2.ticket, { now: later }));
  const status = await controller.status();
  assert.equal(status.post.used, 2);
});

test('task70 abort 不影响失败链；unknown opId 仍不可重放（reserveWrite 也拒绝）', async () => {
  const { controller, setNow } = makeController(T0);
  const ticket = expectOk(await controller.reserveWrite({ kind: 'comment', id: 'chain-comment-1' }));
  const committed = expectOk(await controller.commitTicket(ticket.ticket));
  expectOk(await controller.finish(committed.ticket, { outcome: 'failure' }));
  assert.equal((await controller.status()).consecutiveWriteFailures, 1);

  setNow(T0 + 3 * MINUTE);
  const aborted = expectOk(await controller.reserveWrite({ kind: 'comment', id: 'chain-comment-abort', now: T0 + 3 * MINUTE }));
  expectOk(await controller.abortTicket(aborted.ticket, { now: T0 + 3 * MINUTE }));
  assert.equal((await controller.status()).consecutiveWriteFailures, 1, 'abort 不得改变失败链');

  // unknown 不可重放：即使通过 reserve 入口也拒绝。
  setNow(T0 + 6 * MINUTE);
  const unknownTicket = expectOk(await controller.reserveWrite({ kind: 'comment', id: 'unknown-reserve', now: T0 + 6 * MINUTE }));
  const unknownCommitted = expectOk(await controller.commitTicket(unknownTicket.ticket, { now: T0 + 6 * MINUTE }));
  expectOk(await controller.finish(unknownCommitted.ticket, { outcome: 'unknown', now: T0 + 6 * MINUTE }));
  setNow(T0 + 9 * MINUTE);
  expectRejected(
    await controller.reserveWrite({ kind: 'comment', id: 'unknown-reserve', now: T0 + 9 * MINUTE }),
    'unknown-not-replayable',
    'reserve 也不得重放 unknown',
  );
});

test('task70 reserve 同样受 writePaused/accessPaused 约束；adminRecover 后可重新 reserve', async () => {
  const { controller, setNow } = makeController(T0);
  for (let i = 0; i < 3; i += 1) {
    const at = T0 + i * 3 * MINUTE;
    setNow(at);
    const ticket = expectOk(await controller.reserveWrite({ kind: 'comment', id: `pause-comment-${i}`, now: at }));
    const committed = expectOk(await controller.commitTicket(ticket.ticket, { now: at }));
    expectOk(await controller.finish(committed.ticket, { outcome: 'failure', now: at }));
  }
  assert.equal((await controller.status()).writePaused, true);
  expectRejected(await controller.reserveWrite({ kind: 'comment', id: 'paused-reserve' }), 'write-paused');
  expectOk(await controller.reserveRead({ tool: SEARCH }));
  await controller.adminRecover({ verifiedAdminFrom: 'console' });
  setNow(T0 + 12 * MINUTE);
  expectOk(await controller.reserveWrite({ kind: 'comment', id: 'after-recover-reserve', now: T0 + 12 * MINUTE }));

  await controller.reportAccessUnavailable({ reason: 'captcha', now: T0 + 12 * MINUTE });
  expectRejected(await controller.reserveWrite({ kind: 'comment', id: 'access-reserve' }), 'access-paused');
  expectRejected(await controller.reserveRead({ tool: HOME }), 'access-paused');
});

test('task70 兼容：authorizeRead/authorizeWrite 仍是 reserve+commit 原子包装，行为不变', async () => {
  const { controller } = makeController(T0);
  const read = expectOk(await controller.authorizeRead({ tool: HOME, id: 'compat-read' }));
  assert.equal(read.counted, true);
  assert.equal(read.ticket.kind, 'read');
  assert.equal(read.ticket.id, 'compat-read');
  assert.equal((await controller.status()).read.used, 1);

  const write = expectOk(await controller.authorizeWrite({ kind: 'post', id: 'compat-post' }));
  assert.equal(write.ticket.kind, 'post');
  assert.equal(write.ticket.id, 'compat-post');
  assert.equal((await controller.status()).post.used, 1);
  expectOk(await controller.finish(write.ticket, { outcome: 'success' }));
  expectRejected(await controller.commitTicket(read.ticket), 'invalid-ticket', 'legacy 票据不可 commit');
});

test('task70 运行时回拨拒绝：reserve/commit 均不得在时间回退时改状态', async () => {
  const { controller, setNow } = makeController(T0 + HOUR);
  const before = await controller.serialize();
  setNow(T0);
  expectRejected(await controller.reserveRead({ tool: HOME }), 'clock-rollback', 'reserve 回拨');
  expectRejected(await controller.reserveWrite({ kind: 'comment', id: 'rollback-reserve' }), 'clock-rollback', '写 reserve 回拨');
  setNow(T0 + HOUR);
  const reserved = expectOk(await controller.reserveRead({ tool: HOME }));
  setNow(T0 + 30 * MINUTE);
  expectRejected(await controller.commitTicket(reserved.ticket), 'clock-rollback', 'commit 回拨');
  assert.equal(await controller.serialize(), before, '回拨拒绝时状态字节不变');
});

test('task70 search reserve/commit：不占额度、commit 只推进 lastSeenAt', async () => {
  const { controller } = makeController(T0);
  const reserved = expectOk(await controller.reserveRead({ tool: SEARCH }));
  assert.equal(reserved.counted, false);
  assert.equal(reserved.ticket.counted, false);
  const committed = expectOk(await controller.commitTicket(reserved.ticket));
  assert.equal(committed.counted, false);
  const status = await controller.status();
  assert.equal(status.read.used, 0);
  assert.equal(status.reservedRead, 0);
  assert.equal(status.lastSeenAt, T0);
});

test('task70 预留 TTL：过期的 reserved 不可 commit，status 不再计入 reserved', async () => {
  const { controller, setNow } = makeController(T0, { reservationTtlMs: 1000 });
  const reserved = expectOk(await controller.reserveRead({ tool: HOME, id: 'ttl-read' }));
  setNow(T0 + 1500);
  expectRejected(await controller.commitTicket(reserved.ticket, { now: T0 + 1500 }), 'ticket-expired', '过期票据');
  const status = await controller.status();
  assert.equal(status.reservedRead, 0, '过期预留不再计入 reserved');
  assert.equal(status.read.used, 0);
});

// ── task-73：abort 支持 started→aborted 回滚（execute-first 已知未执行） ──────

test('task73 commit(started) 后 abort 回滚额度：used-1、operation 标 aborted、可重新 reserve 同 opId', async () => {
  const { controller } = makeController(T0);
  const reserved = expectOk(await controller.reserveWrite({ kind: 'post', id: 'rollback-post-1' }));
  const committed = expectOk(await controller.commitTicket(reserved.ticket));
  assert.equal((await controller.status()).post.used, 1);
  assert.deepEqual((await controller.status()).pending.map((item) => item.id), ['rollback-post-1']);

  const aborted = expectOk(await controller.abortTicket(committed.ticket));
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.rolledBack, true);
  const status = await controller.status();
  assert.equal(status.post.used, 0, 'started→aborted 必须回滚 used');
  assert.equal(status.reservedWrite, 0);
  assert.equal(status.pending.length, 0);
  assert.equal(status.consecutiveWriteFailures, 0, 'abort 不进失败链');

  const persisted = JSON.parse(await controller.serialize());
  assert.equal(persisted.operations['rollback-post-1'].status, 'aborted', 'operation 保留为 aborted 审计记录');

  // 确定未执行：同 opId 可重新 reserve/commit；finish 对 aborted 明确拒绝。
  expectRejected(await controller.finish(committed.ticket, { outcome: 'success' }), 'invalid-ticket', 'aborted 不可 finish');
  const again = expectOk(await controller.reserveWrite({ kind: 'post', id: 'rollback-post-1' }));
  expectOk(await controller.commitTicket(again.ticket));
  assert.equal((await controller.status()).post.used, 1);
});

test('task73 回滚 lastActionAt 到上一条非 aborted：abort 后紧邻时刻被 min-interval 拒绝', async () => {
  const { controller } = makeController(T0);
  const first = expectOk(await controller.reserveWrite({ kind: 'comment', id: 'rb-comment-1' }));
  expectOk(await controller.commitTicket(first.ticket));
  const second = expectOk(await controller.reserveWrite({ kind: 'comment', id: 'rb-comment-2', now: T0 + 3 * MINUTE }));
  const secondCommitted = expectOk(await controller.commitTicket(second.ticket, { now: T0 + 3 * MINUTE }));
  assert.equal((await controller.status()).comment.used, 2);

  expectOk(await controller.abortTicket(secondCommitted.ticket, { now: T0 + 3 * MINUTE }));
  assert.equal((await controller.status()).comment.used, 1);
  // lastActionAt 应回退到 first 的 T0（而不是被回滚的第二次 T0+3min）。
  const persisted = JSON.parse(await controller.serialize());
  assert.equal(persisted.buckets.comment.count, 1);
  assert.equal(persisted.buckets.comment.lastActionAt, T0, 'lastActionAt 必须回退到上一条非 aborted 操作');
  // 在 T0+3min 重新 reserve：若间隔基线正确（T0），恰好满 3 分钟 → 放行；
  // 若错误地保留被回滚操作的时间（T0+3min），elapsed=0 会被 min-interval 拒绝。
  const third = expectOk(await controller.reserveWrite({ kind: 'comment', id: 'rb-comment-3', now: T0 + 3 * MINUTE }));
  expectOk(await controller.abortTicket(third.ticket, { now: T0 + 3 * MINUTE }));
});

test('task73 读操作 started→aborted 同样回滚 used，且同 opId 可重新 reserve/commit', async () => {
  const { controller } = makeController(T0);
  const reserved = expectOk(await controller.reserveRead({ tool: HOME, id: 'rb-read-1' }));
  const committed = expectOk(await controller.commitTicket(reserved.ticket));
  assert.equal((await controller.status()).read.used, 1);
  const aborted = expectOk(await controller.abortTicket(committed.ticket));
  assert.equal(aborted.rolledBack, true);
  assert.equal((await controller.status()).read.used, 0);
  const persisted = JSON.parse(await controller.serialize());
  assert.equal(persisted.operations['rb-read-1'].status, 'aborted');
  const again = expectOk(await controller.reserveRead({ tool: HOME, id: 'rb-read-1' }));
  expectOk(await controller.commitTicket(again.ticket));
  assert.equal((await controller.status()).read.used, 1);
});

test('task73 重复 abort 幂等；reserved abort 行为不变；已 finish 的 ticket abort 返回 already-finished', async () => {
  const { controller } = makeController(T0);
  // reserved → 释放（不计数）。
  const reservedOnly = expectOk(await controller.reserveWrite({ kind: 'comment', id: 'rb-reserved' }));
  expectOk(await controller.abortTicket(reservedOnly.ticket));
  expectRejected(await controller.abortTicket(reservedOnly.ticket), 'invalid-ticket', 'reserved 重复 abort');

  // started → 回滚，重复 abort 幂等 already:true。
  const reserved = expectOk(await controller.reserveWrite({ kind: 'comment', id: 'rb-idem' }));
  const committed = expectOk(await controller.commitTicket(reserved.ticket));
  expectOk(await controller.abortTicket(committed.ticket));
  const second = expectOk(await controller.abortTicket(committed.ticket));
  assert.equal(second.aborted, true);
  assert.equal(second.already, true);

  // 已 finish（success）的 ticket abort → already-finished，且不回滚额度。
  const finishedReserve = expectOk(await controller.reserveWrite({ kind: 'comment', id: 'rb-finished', now: T0 + 3 * MINUTE }));
  const finishedCommit = expectOk(await controller.commitTicket(finishedReserve.ticket, { now: T0 + 3 * MINUTE }));
  expectOk(await controller.finish(finishedCommit.ticket, { outcome: 'success', now: T0 + 3 * MINUTE }));
  const before = await controller.serialize();
  expectRejected(await controller.abortTicket(finishedCommit.ticket, { now: T0 + 3 * MINUTE }), 'already-finished', '已 finish 不得回滚');
  assert.equal(await controller.serialize(), before, 'already-finished 拒绝时状态不变');
  assert.equal((await controller.status()).comment.used, 1);
});

test('task73 legacy 票据 abort → invalid-ticket；unknown 不可重放不受 abort 影响', async () => {
  const { controller } = makeController(T0);
  const legacy = expectOk(await controller.authorizeWrite({ kind: 'post', id: 'rb-legacy' }));
  expectRejected(await controller.abortTicket(legacy.ticket), 'invalid-ticket', 'legacy 无 ticketId');

  // unknown 结果：ticket 来自 commit；finish unknown 后 abort 不得回滚额度（unknown 已计且不可重放）。
  const reserved = expectOk(await controller.reserveWrite({ kind: 'comment', id: 'rb-unknown' }));
  const committed = expectOk(await controller.commitTicket(reserved.ticket));
  expectOk(await controller.finish(committed.ticket, { outcome: 'unknown' }));
  expectRejected(await controller.abortTicket(committed.ticket), 'already-finished', 'unknown 已定结果');
  assert.equal((await controller.status()).comment.used, 1, 'unknown 不回退额度');
  expectRejected(
    await controller.reserveWrite({ kind: 'comment', id: 'rb-unknown', now: T0 + 3 * MINUTE }),
    'unknown-not-replayable',
    'unknown 仍不可重放',
  );
});

test('task73 abort 不推进失败链/不触发暂停；暂停状态下仍允许回滚清理', async () => {
  const { controller, setNow } = makeController(T0);
  const first = expectOk(await controller.reserveWrite({ kind: 'comment', id: 'rb-chain-1' }));
  const firstCommitted = expectOk(await controller.commitTicket(first.ticket));
  expectOk(await controller.finish(firstCommitted.ticket, { outcome: 'failure' }));
  assert.equal((await controller.status()).consecutiveWriteFailures, 1);

  setNow(T0 + 3 * MINUTE);
  const second = expectOk(await controller.reserveWrite({ kind: 'comment', id: 'rb-chain-2', now: T0 + 3 * MINUTE }));
  const secondCommitted = expectOk(await controller.commitTicket(second.ticket, { now: T0 + 3 * MINUTE }));
  expectOk(await controller.abortTicket(secondCommitted.ticket, { now: T0 + 3 * MINUTE }));
  const status = await controller.status();
  assert.equal(status.consecutiveWriteFailures, 1, 'abort 不改失败链');
  assert.equal(status.writePaused, false);

  // 暂停（accessPaused）下仍允许回滚清理（不执行平台操作）。
  setNow(T0 + 6 * MINUTE);
  const third = expectOk(await controller.reserveWrite({ kind: 'comment', id: 'rb-chain-3', now: T0 + 6 * MINUTE }));
  const thirdCommitted = expectOk(await controller.commitTicket(third.ticket, { now: T0 + 6 * MINUTE }));
  await controller.reportAccessUnavailable({ reason: 'captcha', now: T0 + 6 * MINUTE });
  const aborted = expectOk(await controller.abortTicket(thirdCommitted.ticket, { now: T0 + 6 * MINUTE }));
  assert.equal(aborted.rolledBack, true);
  assert.equal((await controller.status()).comment.used, 1);
});

test('task73 持久化：aborted 操作可被 parse 加载且不计入 used；旧文件（无 aborted）仍可加载', async () => {
  const { controller } = makeController(T0);
  const reserved = expectOk(await controller.reserveWrite({ kind: 'post', id: 'rb-persist' }));
  const committed = expectOk(await controller.commitTicket(reserved.ticket));
  expectOk(await controller.abortTicket(committed.ticket));
  const raw = await controller.serialize();
  const parsed = JSON.parse(raw);
  assert.equal(parsed.buckets.post.count, 0, 'aborted 不计入桶 count');
  assert.equal(parsed.readCount, 0);
  assert.equal(parsed.operations['rb-persist'].status, 'aborted');
  const restored = createXhhOperationController({ clock: () => T0 + MINUTE, state: raw });
  const status = await restored.status();
  assert.equal(status.post.used, 0);
  assert.equal(status.pending.length, 0);
  // 旧格式（无 aborted 记录）仍可加载。
  const legacyState = JSON.parse(await makeController(T0).controller.serialize());
  assert.doesNotThrow(() => parseXhhOperationControllerState(JSON.stringify(legacyState)));
});

test('task73 回拨/跨日 abort 语义明确：时间回拨拒绝；跨北京日回滚拒绝且状态不变', async () => {
  const { controller, setNow } = makeController(bjTimeAt(T0, 23));
  const reserved = expectOk(await controller.reserveWrite({ kind: 'comment', id: 'rb-crossday' }));
  const committed = expectOk(await controller.commitTicket(reserved.ticket));
  // 回拨：abort 时间早于 commit 时间。
  expectRejected(await controller.abortTicket(committed.ticket, { now: T0 }), 'clock-rollback', 'abort 回拨');
  // 跨日：不允许在日切后回滚昨日已提交额度（避免破坏新日账）。
  setNow(nextBjMorning(T0));
  expectRejected(await controller.abortTicket(committed.ticket), 'abort-day-mismatch', '跨日回滚明确拒绝');
  assert.equal((await controller.status()).comment.used, 0, '跨日后旧日计数已重置，不得被回滚影响');
});

test('task-132 三次失败记录 write-paused 转换事件（operationId 可投递）', async () => {
  const start = bjTimeAt(T0, 21);
  const { controller, setNow } = makeController(start);
  for (let i = 0; i < 3; i += 1) {
    setNow(start + i * 3 * MINUTE);
    const ticket = await authorizeComment(controller, `evt-fail-${i}`);
    expectOk(await controller.finish(ticket.ticket, { outcome: 'failure' }), `failure ${i}`);
  }
  const status = await controller.status();
  assert.equal(status.writePaused, true);
  assert.match(status.writePauseEventId, /^write-pause:/);
  const events = status.transitionEvents.filter((item) => item.event === 'write-paused');
  assert.equal(events.length, 1, '同一暂停转换只记录一次');
  assert.equal(events[0].operationId, status.writePauseEventId);
  assert.equal(events[0].reason, 'consecutive-failures');
});

test('task-132 管理员恢复记录 recovered 事件且保留暂停事件 id', async () => {
  const start = bjTimeAt(T0, 21);
  const { controller, setNow } = makeController(start);
  for (let i = 0; i < 3; i += 1) {
    setNow(start + i * 3 * MINUTE);
    const ticket = await authorizeComment(controller, `rec-fail-${i}`);
    await controller.finish(ticket.ticket, { outcome: 'failure' });
  }
  const before = await controller.status();
  const recovered = await controller.adminRecover({ verifiedAdminFrom: 'console' });
  expectOk(recovered, 'adminRecover');
  assert.equal(recovered.wasPaused, true);
  assert.match(recovered.recoverEventId, /^admin-recover:/);
  assert.equal(recovered.writePauseEventId, before.writePauseEventId, '不得覆盖未送达的暂停事件 id');
  const after = await controller.status();
  assert.equal(after.writePaused, false);
  assert.equal(after.writePauseEventId, before.writePauseEventId);
  assert.equal(after.lastRecoverEventId, recovered.recoverEventId);
  const events = after.transitionEvents.map((item) => item.event);
  assert.deepEqual(events, ['write-paused', 'recovered'], '暂停事实与恢复事实都保留');
  const again = await controller.adminRecover({ verifiedAdminFrom: 'console' });
  assert.equal(again.wasPaused, false, '未暂停时再次恢复不得产生新转换');
});

test('task-132 legacy 暂停状态补齐稳定转换 id（ensureTransitionIds 幂等）', async () => {
  const start = bjTimeAt(T0, 21);
  const { controller, setNow } = makeController(start);
  for (let i = 0; i < 3; i += 1) {
    setNow(start + i * 3 * MINUTE);
    const ticket = await authorizeComment(controller, `legacy-fail-${i}`);
    await controller.finish(ticket.ticket, { outcome: 'failure' });
  }
  const raw = JSON.parse(await controller.serialize());
  delete raw.writePauseEventId;
  delete raw.writePauseAt;
  delete raw.transitionEvents;
  delete raw.transitionSeq;
  const legacy = createXhhOperationController({ clock: () => start, state: raw });
  const migrated = await legacy.ensureTransitionIds();
  expectOk(migrated, 'ensureTransitionIds');
  assert.equal(migrated.migrated, true);
  assert.match(migrated.writePauseEventId, /^legacy:write-paused:/);
  const second = await legacy.ensureTransitionIds();
  assert.equal(second.migrated, false, '幂等：补齐后不得再生成新 id');
  assert.equal(second.writePauseEventId, migrated.writePauseEventId);
});

test('task-132 损坏的 transitionEvents 解析 fail-closed', async () => {
  const { controller } = makeController(T0);
  const raw = JSON.parse(await controller.serialize());
  raw.transitionEvents = [{ event: 'bogus', operationId: 'x', at: T0 }];
  expectCode(() => parseXhhOperationControllerState(JSON.stringify(raw)), 'XHH_OPERATION_CONTROLLER_STATE_INVALID');
});
test('task-133 转换事件容量满且无送达证明时继续记录新事件并保持暂停保护', async () => {
  const base = bjTimeAt(T0, 8);
  const { controller, setNow } = makeController(base);
  let at = base;
  // 10 轮「三次失败→暂停→管理员恢复」= 20 条转换事件（软上限 20）；每轮换一天，避开评论 12/日上限。
  for (let cycle = 0; cycle < 10; cycle += 1) {
    at = base + cycle * DAY;
    for (let i = 0; i < 3; i += 1) {
      at += 3 * MINUTE;
      setNow(at);
      const ticket = await authorizeComment(controller, `cap-fail-${cycle}-${i}`);
      await controller.finish(ticket.ticket, { outcome: 'failure' });
    }
    setNow(at);
    await controller.adminRecover({ verifiedAdminFrom: 'console' });
  }
  at = base + 10 * DAY;
  let status = await controller.status();
  assert.equal(status.transitionEvents.length, 20, '事件软上限恰好满');
  assert.equal(status.transitionEventOverflow, 0);

  // 第 11 轮：容量满且没有任何送达证明的事件 → 不得丢弃新产生的必须通知事件，只允许越界并留痕。
  for (let i = 0; i < 3; i += 1) {
    at += 3 * MINUTE;
    setNow(at);
    const ticket = await authorizeComment(controller, `cap-overflow-${i}`);
    const finished = await controller.finish(ticket.ticket, { outcome: 'failure' });
    if (i === 2) assert.equal(finished.transitionEventError ?? null, null, JSON.stringify(finished));
  }
  status = await controller.status();
  assert.equal(status.writePaused, true, '容量越界不得解除暂停保护');
  assert.equal(status.transitionEvents.length, 21, '新事件必须被记录（允许越过软上限）');
  assert.ok(status.transitionEventOverflow >= 1, `overflow 必须显式计数，实际 ${status.transitionEventOverflow}`);

  // 送达证明回写后，暂停事件允许被回收（容量仍可自愈）。
  const delivered = await controller.markTransitionDelivered({ operationIds: [status.transitionEvents[0].operationId] });
  expectOk(delivered, 'markTransitionDelivered');
  const rawMarked = JSON.parse(await controller.serialize());
  assert.ok(rawMarked.transitionEvents.some((item) => typeof item.deliveredAt === 'number'), 'deliveredAt 必须持久化');
  const recovered = await controller.adminRecover({ verifiedAdminFrom: 'console' });
  expectOk(recovered, 'adminRecover');
  const after2 = await controller.status();
  assert.equal(after2.transitionEvents.length, 21, '回收已送达事件后再追加 recovered，长度不变');
  assert.ok(after2.transitionEvents.some((item) => item.event === 'recovered' && item.operationId === recovered.recoverEventId));
  const raw = JSON.parse(await controller.serialize());
  const reloaded = createXhhOperationController({ clock: () => at, state: raw });
  const reloadedStatus = await reloaded.status();
  assert.equal(reloadedStatus.transitionEventOverflow, after2.transitionEventOverflow, 'overflow 计数重启后可读');
});
test('task-133 markTransitionDelivered 校验与幂等', async () => {
  const start = bjTimeAt(T0, 8);
  const { controller, setNow } = makeController(start);
  for (let i = 0; i < 3; i += 1) {
    setNow(start + i * 3 * MINUTE);
    const ticket = await authorizeComment(controller, `mark-fail-${i}`);
    await controller.finish(ticket.ticket, { outcome: 'failure' });
  }
  const status = await controller.status();
  const pauseId = status.transitionEvents.find((item) => item.event === 'write-paused').operationId;

  assert.equal((await controller.markTransitionDelivered()).ok, false, '缺参数拒绝');
  assert.equal((await controller.markTransitionDelivered({ operationIds: [] })).ok, false, '空数组拒绝');
  assert.equal((await controller.markTransitionDelivered({ operationIds: Array.from({ length: 1001 }, (_, i) => `t-${i}`) })).ok, false, '批量超过硬上限拒绝');
  const twentyOne = await controller.markTransitionDelivered({ operationIds: Array.from({ length: 21 }, (_, i) => `unknown-${i}`) });
  expectOk(twentyOne, '批量 21 条合法（与容量新契约一致）');
  assert.equal(twentyOne.marked, 0, '未知 id 不标记');
  assert.equal((await controller.markTransitionDelivered({ operationIds: ['unknown-transition'] })).marked, 0);

  const first = await controller.markTransitionDelivered({ operationIds: [pauseId] });
  expectOk(first, '首次标记');
  assert.equal(first.marked, 1, JSON.stringify(first));
  const second = await controller.markTransitionDelivered({ operationIds: [pauseId] });
  expectOk(second, '重复标记幂等');
  assert.equal(second.marked, 0, '已标记不得重复写');
});

/**
 * 终审追加：容量满时不得丢弃「新产生的必须通知事件」，未送达事实不得被恢复/再次暂停/重启覆盖。
 * 旧契约（容量满且无送达证明 → 显式拒绝、不记录）会让第三次失败通知永久丢失，现改为：
 * - 有 deliveredAt 的事件优先回收；
 * - 全部未送达时允许数组越过软上限继续追加（overflow 计数留痕），暂停保护不变；
 * - 重启加载允许越过软上限（仅设防损坏硬上限）；
 * - 恢复/再次暂停各自保留独立事件，不覆盖旧 operationId。
 */
async function seedUndeliveredTransitions(controller, setNow, base, cycles = 10) {
  let at = base;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    at = base + cycle * DAY;
    for (let i = 0; i < 3; i += 1) {
      at += 3 * MINUTE;
      setNow(at);
      const ticket = await authorizeComment(controller, `seed-${cycle}-${i}`);
      await controller.finish(ticket.ticket, { outcome: 'failure' });
    }
    setNow(at);
    await controller.adminRecover({ verifiedAdminFrom: 'console' });
  }
  return at;
}

test('任务容量：全未送达时容量满仍记录新暂停事件并留 overflow 痕迹', async () => {
  const base = bjTimeAt(T0, 8);
  const { controller, setNow } = makeController(base);
  let at = await seedUndeliveredTransitions(controller, setNow, base);
  let status = await controller.status();
  assert.equal(status.transitionEvents.length, 20, '种子事件容量恰好满');
  assert.equal(status.transitionEventOverflow, 0);

  const beforeIds = new Set(status.transitionEvents.map((item) => item.operationId));
  at = base + 10 * DAY;
  let lastFinished = null;
  for (let i = 0; i < 3; i += 1) {
    at += 3 * MINUTE;
    setNow(at);
    const ticket = await authorizeComment(controller, `overflow-${i}`);
    lastFinished = await controller.finish(ticket.ticket, { outcome: 'failure' });
  }
  assert.equal(lastFinished.transitionEventError ?? null, null, '容量满不得再返回丢掉事件式错误');
  status = await controller.status();
  assert.equal(status.writePaused, true, '暂停保护必须保持');
  assert.equal(status.transitionEvents.length, 21, '新产生的暂停事件必须被记录（允许越过软上限）');
  assert.ok(status.transitionEventOverflow >= 1, `容量越界必须留痕，实际 ${status.transitionEventOverflow}`);
  const added = status.transitionEvents.filter((item) => !beforeIds.has(item.operationId));
  assert.equal(added.length, 1, '只追加一条新事件，旧事件不得被覆盖');
  assert.equal(added[0].event, 'write-paused');
  assert.equal(added[0].operationId, status.writePauseEventId);
  for (const id of beforeIds) {
    assert.ok(status.transitionEvents.some((item) => item.operationId === id), `旧事件 ${id} 不得丢失`);
  }
});

test('任务容量：有送达证明时只回收已送达事件，未送达事实保留', async () => {
  const base = bjTimeAt(T0, 8);
  const { controller, setNow } = makeController(base);
  let at = await seedUndeliveredTransitions(controller, setNow, base);
  const seeded = await controller.status();
  const deliveredId = seeded.transitionEvents[0].operationId;
  const undeliveredIds = seeded.transitionEvents.slice(1).map((item) => item.operationId);
  expectOk(await controller.markTransitionDelivered({ operationIds: [deliveredId] }), '标记首个事件已送达');

  // 次日再次触发第三次失败 → 产生新的 write-paused 事件，应优先回收已送达事件。
  at = nextBjMorning(at);
  for (let i = 0; i < 3; i += 1) {
    at += 3 * MINUTE;
    setNow(at);
    const ticket = await authorizeComment(controller, `evict-${i}`);
    await controller.finish(ticket.ticket, { outcome: 'failure' });
  }
  const status = await controller.status();
  assert.ok(!status.transitionEvents.some((item) => item.operationId === deliveredId), '已送达事件应被优先回收');
  assert.equal(status.transitionEvents.length, 20, '回收一条后再追加一条，长度保持软上限');
  for (const id of undeliveredIds) {
    assert.ok(status.transitionEvents.some((item) => item.operationId === id), `未送达事件 ${id} 不得被回收`);
  }
  assert.equal(status.writePaused, true);
});

test('任务容量：重启可加载超过软上限的未送达事件且迁移不重复', async () => {
  const base = bjTimeAt(T0, 8);
  const { controller, setNow } = makeController(base);
  let at = await seedUndeliveredTransitions(controller, setNow, base);
  at = base + 10 * DAY;
  for (let i = 0; i < 3; i += 1) {
    at += 3 * MINUTE;
    setNow(at);
    const ticket = await authorizeComment(controller, `reload-overflow-${i}`);
    await controller.finish(ticket.ticket, { outcome: 'failure' });
  }
  const raw = JSON.parse(await controller.serialize());
  assert.equal(raw.transitionEvents.length, 21, '持久化状态必须包含 21 条事件');
  const ids = raw.transitionEvents.map((item) => item.operationId);

  const reloaded = createXhhOperationController({ clock: () => at, state: raw });
  const status = await reloaded.status();
  assert.equal(status.transitionEvents.length, 21, '重启不得丢弃超过软上限的未送达事件');
  assert.equal(status.writePaused, true, '重启后暂停保护保持');
  assert.equal(status.transitionEventOverflow, raw.transitionEventOverflow);
  for (const id of ids) {
    assert.ok(status.transitionEvents.some((item) => item.operationId === id), `重启后事件 ${id} 不得丢失`);
  }
  const migration = await reloaded.ensureTransitionIds();
  expectOk(migration, 'ensureTransitionIds');
  assert.equal(migration.migrated, false, '已有转换 id 时不得重复迁移');
  const after = await reloaded.status();
  assert.equal(after.transitionEvents.length, 21, '迁移不得重复追加事件');
});

test('任务容量：恢复后再次暂停保留两条独立暂停事件，不覆盖未送达事实', async () => {
  const base = bjTimeAt(T0, 8);
  const { controller, setNow } = makeController(base);
  let at = base;
  for (let i = 0; i < 3; i += 1) {
    at += 3 * MINUTE;
    setNow(at);
    const ticket = await authorizeComment(controller, `repause-1-${i}`);
    await controller.finish(ticket.ticket, { outcome: 'failure' });
  }
  const first = await controller.status();
  const pauseId1 = first.writePauseEventId;
  expectOk(await controller.adminRecover({ verifiedAdminFrom: 'console' }), '第一次恢复');
  const afterRecover = await controller.status();
  const recoverId = afterRecover.lastRecoverEventId;
  assert.ok(recoverId !== null, '恢复事件 id 必须记录');

  // 次日再触发第三次失败（避免 12/日评论上限），产生第二条暂停事件。
  at = nextBjMorning(at);
  for (let i = 0; i < 3; i += 1) {
    at += 3 * MINUTE;
    setNow(at);
    const ticket = await authorizeComment(controller, `repause-2-${i}`);
    await controller.finish(ticket.ticket, { outcome: 'failure' });
  }
  const second = await controller.status();
  const pauseId2 = second.writePauseEventId;
  assert.notEqual(pauseId2, pauseId1, '再次暂停必须生成新转换 id');
  const events = second.transitionEvents;
  assert.ok(events.some((item) => item.event === 'write-paused' && item.operationId === pauseId1 && item.deliveredAt === null), '第一次暂停的未送达事实不得被覆盖');
  assert.ok(events.some((item) => item.event === 'write-paused' && item.operationId === pauseId2), '第二次暂停必须记录');
  assert.ok(events.some((item) => item.event === 'recovered' && item.operationId === recoverId), '恢复事件必须保留');

  const raw = JSON.parse(await controller.serialize());
  const reloaded = createXhhOperationController({ clock: () => at, state: raw });
  const status = await reloaded.status();
  for (const id of [pauseId1, pauseId2, recoverId]) {
    assert.ok(status.transitionEvents.some((item) => item.operationId === id), `重启后 ${id} 不得丢失`);
  }
});

test('任务容量：markTransitionDelivered 支持一次回写超过软上限的送达证明', async () => {
  const base = bjTimeAt(T0, 8);
  const { controller, setNow } = makeController(base);
  let at = await seedUndeliveredTransitions(controller, setNow, base);
  at = base + 10 * DAY;
  for (let i = 0; i < 3; i += 1) {
    at += 3 * MINUTE;
    setNow(at);
    const ticket = await authorizeComment(controller, `batch-mark-${i}`);
    await controller.finish(ticket.ticket, { outcome: 'failure' });
  }
  const before = await controller.status();
  assert.equal(before.transitionEvents.length, 21, '先生成 21 条未送达事件');
  const ids = before.transitionEvents.map((item) => item.operationId);
  const marked = await controller.markTransitionDelivered({ operationIds: ids });
  expectOk(marked, '一次标记 21 条');
  assert.equal(marked.marked, 21, JSON.stringify(marked));
  const after = await controller.status();
  assert.equal(after.transitionEvents.filter((item) => typeof item.deliveredAt === 'number').length, 21, '全部写入送达证明');
  assert.equal(after.transitionEvents.length, 21, '标记不删除事件');
});

test('任务容量：加载硬上限 1000 可读、1001 fail-closed', async () => {
  const base = bjTimeAt(T0, 8);
  const { controller, setNow } = makeController(base);
  for (let i = 0; i < 3; i += 1) {
    setNow(base + i * 3 * MINUTE);
    const ticket = await authorizeComment(controller, `bound-fail-${i}`);
    await controller.finish(ticket.ticket, { outcome: 'failure' });
  }
  const raw = JSON.parse(await controller.serialize());
  const template = raw.transitionEvents[0];
  const makeEvents = (count) => Array.from({ length: count }, (_, i) => ({
    event: 'write-paused',
    reason: 'consecutive-failures',
    operationId: `write-pause:2026-01-15:${template.at}:${1000 + i}`,
    at: template.at,
    deliveredAt: null,
  }));
  const okRaw = { ...raw, transitionEvents: makeEvents(1000) };
  const reloaded = createXhhOperationController({ clock: () => base, state: okRaw });
  assert.equal((await reloaded.status()).transitionEvents.length, 1000, '1000 条可加载');
  const badRaw = { ...raw, transitionEvents: makeEvents(1001) };
  expectCode(
    () => createXhhOperationController({ clock: () => base, state: badRaw }),
    XHH_OPERATION_CONTROLLER_ERROR_CODES.STATE_INVALID,
    '1001 条必须 fail-closed',
  );
});

function makeLimitRaw(count, deliveredIndex = -1) {
  const base = bjTimeAt(T0, 8);
  const { controller, setNow } = makeController(base);
  return (async () => {
    for (let i = 0; i < 3; i += 1) {
      setNow(base + i * 3 * MINUTE);
      const ticket = await authorizeComment(controller, `limit-seed-${i}`);
      await controller.finish(ticket.ticket, { outcome: 'failure' });
    }
    const raw = JSON.parse(await controller.serialize());
    delete raw.writePauseEventId;
    delete raw.writePauseAt;
    const template = raw.transitionEvents[0];
    raw.transitionEvents = Array.from({ length: count }, (_, i) => ({
      event: 'write-paused',
      reason: 'consecutive-failures',
      operationId: `write-pause:2026-01-15:${template.at}:${3000 + i}`,
      at: template.at,
      deliveredAt: i === deliveredIndex ? template.at : null,
    }));
    return { raw, now: base + 3 * MINUTE };
  })();
}

test('任务容量：加载硬上限拒绝时不丢语义且不污染 overflow（1000 条全未送达）', async () => {
  const { raw, now } = await makeLimitRaw(1000);
  const controller = createXhhOperationController({ clock: () => now, state: raw });
  const migration = await controller.ensureTransitionIds();
  expectOk(migration, 'ensureTransitionIds');
  assert.equal(migration.migrated, true, 'legacy 暂停 id 需要迁移');
  assert.equal(migration.transitionEventError, 'transition-events-load-limit', '硬上限拒绝必须显式暴露');
  const status = await controller.status();
  assert.equal(status.transitionEvents.length, 1000, '硬上限下不得越过');
  assert.equal(status.transitionEventOverflow, 0, '硬上限拒绝不得计入 overflow');
  assert.equal(status.writePaused, true, '暂停保护保持');
});

test('任务容量：1000 条含已送达事件时必须能回收并记录新事件', async () => {
  const { raw, now } = await makeLimitRaw(1000, 0);
  const controller = createXhhOperationController({ clock: () => now, state: raw });
  const migration = await controller.ensureTransitionIds();
  expectOk(migration, 'ensureTransitionIds');
  assert.equal(migration.transitionEventError, undefined, '可回收时不得报硬上限');
  const status = await controller.status();
  assert.equal(status.transitionEvents.length, 1000, '回收一条后追加一条，长度回到硬上限');
  assert.equal(status.transitionEvents.filter((item) => typeof item.deliveredAt === 'number').length, 0, '已送达事件被回收');
  assert.equal(status.transitionEventOverflow, 0, '回收路径不得计 overflow');
  assert.ok(status.transitionEvents.some((item) => item.operationId === migration.writePauseEventId), '新迁移事件必须记录');
});

test('任务容量：软上限越界增长计 overflow，且与硬上限拒绝可区分', async () => {
  const { raw, now } = await makeLimitRaw(999);
  const controller = createXhhOperationController({ clock: () => now, state: raw });
  const migration = await controller.ensureTransitionIds();
  expectOk(migration, 'ensureTransitionIds');
  assert.equal(migration.transitionEventError, undefined, '未到硬上限不得拒绝');
  const status = await controller.status();
  assert.equal(status.transitionEvents.length, 1000, '软上限越界增长到 1000');
  assert.equal(status.transitionEventOverflow, 1, '软上限越界必须计一次 overflow');
});

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// ── A-2：降级只读态的「强制计额度读」（用户 2026-10-29 规则③） ──────────────
// 身份来源不可判定时，平时免额的读（search / get_user_profile / check_login_status）
// 必须按「无法可靠豁免」处理并占读额度；forceCount 只在显式传入时生效。

test('A-2 forceCount：search 平时不计额度，强制后必须计入并占用读额度', async () => {
  const { controller } = makeController(T0);
  const normal = expectOk(await controller.reserveRead({ tool: SEARCH }));
  assert.equal(normal.counted, false, 'search 缺省仍免额（旧调用方行为不得变化）');

  const forced = expectOk(await controller.reserveRead({ tool: SEARCH, forceCount: true }));
  assert.equal(forced.counted, true, '降级只读时 search 必须计额度');
  assert.equal(forced.ticket.counted, true);
  expectOk(await controller.commitTicket(forced.ticket));

  const status = await controller.status();
  assert.equal(status.read.used, 1, '强制计的 search 必须真的占掉一次读额度');
  assert.equal(JSON.parse(await controller.serialize()).readCount, 1);
});

test('A-2 forceCount：免额读工具平时 invalid-tool，强制后成为 counted 读', async () => {
  const { controller } = makeController(T0);
  const PROFILE = 'mcp__xiaoheihe__get_user_profile';
  const LOGIN = 'mcp__xiaoheihe__check_login_status';

  expectRejected(await controller.reserveRead({ tool: PROFILE }), 'invalid-tool', '平时该工具不走读票据');
  expectRejected(await controller.reserveRead({ tool: LOGIN }), 'invalid-tool', '平时该工具不走读票据');

  const profile = expectOk(await controller.reserveRead({ tool: PROFILE, forceCount: true }));
  assert.equal(profile.counted, true);
  expectOk(await controller.commitTicket(profile.ticket));

  const login = expectOk(await controller.reserveRead({ tool: LOGIN, forceCount: true }));
  assert.equal(login.counted, true);
  expectOk(await controller.commitTicket(login.ticket));

  assert.equal((await controller.status()).read.used, 2);
});

test('A-2 forceCount：不得把任意工具洗白成读（写工具仍 invalid-tool）', async () => {
  const { controller } = makeController(T0);
  expectRejected(
    await controller.reserveRead({ tool: 'mcp__xiaoheihe__publish_content', forceCount: true }),
    'invalid-tool',
    'forceCount 只能放宽白名单读工具，不能放宽到写工具',
  );
  expectRejected(
    await controller.reserveRead({ tool: 'mcp__xiaoheihe__unknown_tool', forceCount: true }),
    'invalid-tool',
  );
});
test('控制台可配置额度：setDailyLimits 立即生效、0 禁止、调低保留已用次数', async () => {
  const controller = createXhhOperationController({ clock: () => T0 });
  const ticket = expectOk(await controller.reserveRead({ tool: HOME, id: 'cfg-read-1' }));
  expectOk(await controller.commitTicket(ticket.ticket));
  assert.equal((await controller.status()).read.used, 1);

  // 调低到低于已用次数：保留已用、不再放行新的自主读。
  const lowered = await controller.setDailyLimits({ read: 0 });
  assert.equal(lowered.ok, true);
  assert.equal(lowered.limits.read, 0);
  const after = await controller.status();
  assert.equal(after.read.used, 1, '已用次数必须保留，不能因调低上限被清零');
  assert.equal(after.read.limit, 0);
  assert.equal(after.read.remaining, 0);
  const denied = await controller.reserveRead({ tool: HOME, id: 'cfg-read-2' });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'read-daily-cap');

  // 调回后立刻恢复放行（不需要重建实例 / 重启）。
  await controller.setDailyLimits({ read: 14 });
  const again = await controller.reserveRead({ tool: DETAIL, id: 'cfg-read-3' });
  assert.equal(again.ok, true);
  await controller.close();
});

test('控制台可配置额度：写桶上限同样可调，且非法值被拒绝', async () => {
  const controller = createXhhOperationController({ clock: () => T0, limits: { post: 1, comment: 99 } });
  assert.deepEqual(controller.dailyLimits(), { read: 14, post: 1, comment: 99 });
  assert.equal((await controller.status()).post.limit, 1);

  const bad = await controller.setDailyLimits({ post: 100 });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'invalid-limit-value');

  const first = expectOk(await controller.reserveWrite({ kind: 'post', id: 'cfg-post-1' }));
  expectOk(await controller.commitTicket(first.ticket));
  const second = await controller.reserveWrite({ kind: 'post', id: 'cfg-post-2' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'post-daily-cap');
  await controller.close();
});
test('控制台可配置额度：构造期注入非法值抛 TypeError（不当成运行期错误吞掉）', () => {
  assert.throws(
    () => createXhhOperationController({ clock: () => T0, limits: { read: -1 } }),
    (error) => error instanceof TypeError && /limits.read/.test(error.message),
  );
});
