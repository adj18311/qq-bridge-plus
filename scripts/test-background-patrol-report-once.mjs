#!/usr/bin/env node
// scripts/test-background-patrol-report-once.mjs
//
// 后台巡逻第三阶段（修正版）：主动汇报「一次读取至多一次尝试」纯状态机测试。
//
// 规格依据（docs/superpowers/specs/2026-10-24-background-patrol-design.md §概率汇报）：
//   · 每次访问至多尝试发送一条主动汇报；
//   · 一旦尝试发送，无论 successful / failed / unknown，均消耗当天对应概率档位，不自动重发；
//   · 不重复抽签、不重复发送；发送结果须记录。
//
// 状态机（本模块只维护内存状态，不发送 QQ、不落盘、不联网）：
//   idle -> prepared(readIndex + dedupeKey + 一次性抽签) -> dispatched(唯一一次尝试)
//        -> confirmed | failed | unknown（终态，同一 readIndex 不得再 prepare / dispatch）
//
// 契约：
//   · 同一 readIndex 第二次 prepare 返回 {ok:false, reason:'duplicate-read'}，抽签次数不变；
//   · 比已尝试 readIndex 更小的迟到读取返回 {ok:false, reason:'stale-read'}（fail-closed，不补报）；
//   · 同一 dedupeKey 即使换了 readIndex 也不得再抽签（'duplicate-key'，逻辑操作去重）；
//   · 抽签结果 shouldReport=false 时不进入 prepared，也不允许 dispatch（本次读取不汇报）；
//   · prepared / dispatched 期间不得开始下一次读取（'in-flight'）；超过 ttlMs 的 prepared 视为过期：
//     dispatch 返回 {ok:false, reason:'expired'} 且不发送，之后也不允许补发；
//   · failed / unknown 都是终态，不自动重试；新读取（更大的 readIndex）可以重新开始；
//   · snapshot()/restore() 支持「重连/重启后同 readIndex 不得重发」；restore 对损坏快照 fail-closed 抛错；
//   · reset() 只用于新的北京自然日/明确的新会话，不提供“对同一读取重试”的路径。
//
// 纯离线：不读文件、不联网、不发送任何 QQ 消息、不读取全局 Math.random。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REPORT_ONCE_STATES,
  REPORT_ONCE_OUTCOMES,
  createBackgroundPatrolReportOnce,
} from '../src/core/background-patrol-report-once.mjs';

const T0 = 1_700_000_000_000;

function harness({ ttlMs = 60_000 } = {}) {
  let now = T0;
  const machine = createBackgroundPatrolReportOnce({ now: () => now, ttlMs });
  return {
    machine,
    ttlMs,
    now: () => now,
    setNow: (value) => { now = value; },
    advance: (delta) => { now += delta; },
  };
}

function prepared(machine, readIndex, dedupeKey, random = 0, at = T0) {
  return machine.prepare({ readIndex, dedupeKey, random, at });
}

/** Node 的 assert.throws 不返回错误对象；这里取回错误并校验 code。 */
function throwsWithCode(run, expectedCode) {
  try {
    run();
  } catch (error) {
    assert.equal(error.code, expectedCode, `期望 code=${expectedCode}，实际 ${error.code}`);
    return error;
  }
  assert.fail(`期望抛出 code=${expectedCode} 的错误`);
}

function drive(machine, readIndex, { random = 0, at = T0, outcome = 'confirmed' } = {}) {
  const ready = prepared(machine, readIndex, `read-${readIndex}`, random, at);
  assert.equal(ready.ok, true, JSON.stringify(ready));
  if (!ready.shouldReport) return ready;
  assert.equal(machine.dispatch({ at }).ok, true);
  assert.equal(machine.settle({ outcome, at }).ok, true);
  return ready;
}

test('初始状态 idle，状态/结果常量冻结且覆盖规格', () => {
  assert.equal(Object.isFrozen(REPORT_ONCE_STATES), true);
  assert.deepEqual([...REPORT_ONCE_STATES], ['idle', 'prepared', 'dispatched', 'confirmed', 'failed', 'unknown', 'declined']);
  assert.equal(Object.isFrozen(REPORT_ONCE_OUTCOMES), true);
  assert.deepEqual([...REPORT_ONCE_OUTCOMES], ['confirmed', 'failed', 'unknown', 'declined']);
  const { machine } = harness();
  const snap = machine.snapshot();
  assert.equal(snap.state, 'idle');
  assert.equal(snap.readIndex, null);
  assert.deepEqual(snap.stats, { draws: 0, attempts: 0 });
  assert.deepEqual(snap.seenKeys, []);
});

test('一次读取只抽签一次：重复 prepare 同一 readIndex 被拒绝且状态不变', () => {
  const { machine } = harness();
  const first = prepared(machine, 1, 'read-1', 0.3);
  assert.equal(first.ok, true);
  assert.equal(first.shouldReport, true);
  assert.equal(first.probability, 1, '抽签取消后固定为 1（永远有资格由模型决定）');
  const snap = machine.snapshot();
  assert.equal(snap.state, 'prepared');
  assert.equal(snap.readIndex, 1);
  assert.equal(snap.dedupeKey, 'read-1');
  assert.equal(snap.stats.draws, 1);

  // 即使这次给了“必中”随机数，也不能二次抽签、不能改写第一次的结果。
  const again = prepared(machine, 1, 'read-1', 0);
  assert.deepEqual(again, { ok: false, reason: 'duplicate-read' });
  const after = machine.snapshot();
  assert.equal(after.stats.draws, 1);
  assert.equal(after.random, null);
  assert.equal(after.state, 'prepared');
});

test('同一逻辑读取（相同 dedupeKey、不同 readIndex）也不得再抽签', () => {
  const { machine } = harness();
  drive(machine, 1);
  const reused = prepared(machine, 2, 'read-1', 0);
  assert.deepEqual(reused, { ok: false, reason: 'duplicate-key' });
  assert.equal(machine.snapshot().stats.draws, 1);
  // 新 key 的新读取可以继续。
  assert.equal(prepared(machine, 2, 'read-2', 0).ok, true);
});

test('一次读取至多一次 dispatch：未 prepare、重复 dispatch 都被拒绝', () => {
  const { machine } = harness();
  assert.deepEqual(machine.dispatch({ at: T0 }), { ok: false, reason: 'not-prepared' });
  prepared(machine, 1, 'read-1', 0);
  assert.equal(machine.dispatch({ at: T0 }).ok, true);
  const snap = machine.snapshot();
  assert.equal(snap.state, 'dispatched');
  assert.equal(snap.stats.attempts, 1);
  assert.deepEqual(machine.dispatch({ at: T0 }), { ok: false, reason: 'already-dispatched' });
  assert.equal(machine.snapshot().stats.attempts, 1);
});

test('failed 是终态：不自动重试，同一 readIndex 不得再 prepare/dispatch，新读取可重新开始', () => {
  const { machine } = harness();
  assert.equal(prepared(machine, 1, 'read-1', 0).ok, true);
  machine.dispatch({ at: T0 });
  assert.deepEqual(machine.settle({ outcome: 'failed', at: T0 + 1 }), { ok: true, state: 'failed', readIndex: 1 });
  assert.deepEqual(machine.dispatch({ at: T0 + 2 }), { ok: false, reason: 'settled' });
  assert.deepEqual(machine.settle({ outcome: 'failed', at: T0 + 2 }), { ok: false, reason: 'already-settled' });
  assert.deepEqual(prepared(machine, 1, 'read-1', 0), { ok: false, reason: 'duplicate-read' });
  // 新读取（第 2 次）可重新抽签、再尝试一条。
  const next = prepared(machine, 2, 'read-2', 0);
  assert.equal(next.ok, true);
  assert.equal(next.probability, 1);
  assert.equal(machine.dispatch({ at: T0 + 3 }).ok, true);
});

test('unknown 同样不自动重试，也不被当成成功；重连后同一 readIndex 不得重发', () => {
  const { machine } = harness();
  prepared(machine, 1, 'read-1', 0);
  machine.dispatch({ at: T0 });
  const snapAtUnknown = (() => {
    assert.equal(machine.settle({ outcome: 'unknown', at: T0 + 1 }).ok, true);
    return machine.snapshot();
  })();
  assert.equal(snapAtUnknown.state, 'unknown');

  // 模拟重连：从快照恢复到新实例。
  const restored = createBackgroundPatrolReportOnce({ now: () => T0 + 2, ttlMs: 60_000 });
  restored.restore(snapAtUnknown);
  assert.equal(restored.snapshot().state, 'unknown');
  assert.deepEqual(restored.prepare({ readIndex: 1, dedupeKey: 'read-1', random: 0, at: T0 + 2 }), { ok: false, reason: 'duplicate-read' });
  assert.equal(restored.dispatch({ at: T0 + 2 }).ok, false);
  assert.equal(restored.snapshot().stats.attempts, 1);
  assert.deepEqual(restored.settle({ outcome: 'confirmed', at: T0 + 2 }), { ok: false, reason: 'already-settled' });
  // 新读取仍可进行，但不会重发旧读取。
  assert.equal(restored.prepare({ readIndex: 2, dedupeKey: 'read-2', random: 0, at: T0 + 3 }).ok, true);
});

test('重连快照：dispatched 状态只能收尾，不能再次 dispatch', () => {
  const { machine } = harness();
  prepared(machine, 1, 'read-1', 0);
  machine.dispatch({ at: T0 });
  const snap = machine.snapshot();
  const restored = createBackgroundPatrolReportOnce({ now: () => T0 + 5, ttlMs: 60_000 });
  restored.restore(snap);
  assert.deepEqual(restored.dispatch({ at: T0 + 5 }), { ok: false, reason: 'already-dispatched' });
  assert.deepEqual(restored.prepare({ readIndex: 1, dedupeKey: 'read-1', random: 0, at: T0 + 5 }), { ok: false, reason: 'duplicate-read' });
  assert.equal(restored.settle({ outcome: 'unknown', at: T0 + 5 }).ok, true);
  assert.equal(restored.snapshot().stats.attempts, 1);
});

test('抽签已取消：任何随机数都不影响「进入 prepared」；同一读取仍不得二次 prepare', () => {
  const { machine } = harness();
  // 传入“必不中”的旧随机数：新语义下它被忽略，每次读取都应进入 prepared。
  const first = prepared(machine, 1, 'read-1', 0.99);
  assert.equal(first.ok, true);
  assert.equal(first.shouldReport, true, '不再有未中签短路');
  assert.equal(first.probability, 1);
  assert.equal(first.random, null);
  assert.equal(machine.snapshot().state, 'prepared');
  assert.deepEqual(prepared(machine, 1, 'read-1', 0), { ok: false, reason: 'duplicate-read' });
  // 丢弃当前 prepared 后，下一次读取同样进入 prepared。
  machine.dispatch({ at: T0 });
  machine.settle({ outcome: 'declined', at: T0 + 1 });
  const second = prepared(machine, 2, 'read-2', 0.1, T0 + 2);
  assert.equal(second.shouldReport, true);
  assert.equal(second.probability, 1);
});

test('prepared/dispatched 期间不得开始下一次读取（in-flight）', () => {
  const { machine } = harness();
  prepared(machine, 1, 'read-1', 0);
  assert.deepEqual(prepared(machine, 2, 'read-2', 0), { ok: false, reason: 'in-flight' });
  assert.equal(machine.dispatch({ at: T0 }).ok, true);
  assert.deepEqual(prepared(machine, 2, 'read-2', 0), { ok: false, reason: 'in-flight' });
});

test('过期的 prepared 不会补发：dispatch 返回 expired，之后只能开始新读取', () => {
  const { machine, ttlMs } = harness({ ttlMs: 1_000 });
  prepared(machine, 1, 'read-1', 0, T0);
  assert.deepEqual(machine.dispatch({ at: T0 + ttlMs + 1 }), { ok: false, reason: 'expired' });
  assert.equal(machine.snapshot().state, 'idle');
  assert.equal(machine.snapshot().stats.attempts, 0);
  assert.deepEqual(machine.dispatch({ at: T0 + ttlMs + 2 }), { ok: false, reason: 'not-prepared' });
  // 同一读取不因过期而重抽签/重发。
  assert.deepEqual(prepared(machine, 1, 'read-1', 0, T0 + ttlMs + 2), { ok: false, reason: 'duplicate-read' });
  // 新读取可以开始。
  const next = prepared(machine, 2, 'read-2', 0, T0 + ttlMs + 3);
  assert.equal(next.ok, true);
  assert.equal(machine.dispatch({ at: T0 + ttlMs + 3 }).ok, true);
});

test('迟到的小 readIndex fail-closed：不补报、不推进抽签', () => {
  const { machine } = harness();
  drive(machine, 2, { at: T0 });
  const late = prepared(machine, 1, 'late-read', 0, T0 + 1);
  assert.deepEqual(late, { ok: false, reason: 'stale-read' });
  assert.equal(machine.snapshot().stats.draws, 1);
  assert.equal(machine.snapshot().lastReadIndex, 2);
});

test('三个终态都能被如实记录，且结果字段与状态一致', () => {
  for (const outcome of REPORT_ONCE_OUTCOMES) {
    const { machine } = harness();
    prepared(machine, 1, 'read-1', 0);
    machine.dispatch({ at: T0 });
    assert.deepEqual(machine.settle({ outcome, at: T0 + 1 }), { ok: true, state: outcome, readIndex: 1 });
    const snap = machine.snapshot();
    assert.equal(snap.state, outcome);
    assert.equal(snap.outcome, outcome);
    assert.equal(snap.settledAt, T0 + 1);
  }
  const { machine } = harness();
  assert.throws(() => machine.settle({ outcome: 'maybe', at: T0 }), /outcome/);
});

test('非法输入带 code 抛错：readIndex / dedupeKey / at（不再校验 random）', () => {
  const { machine } = harness();
  for (const readIndex of [0, -1, 1.5, NaN, '1', null, undefined]) {
    throwsWithCode(() => machine.prepare({ readIndex, dedupeKey: 'k', random: 0, at: T0 }), 'REPORT_ONCE_INVALID_READ_INDEX');
  }
  for (const dedupeKey of ['', '   ', null, 42, 'x'.repeat(201)]) {
    throwsWithCode(() => machine.prepare({ readIndex: 1, dedupeKey, random: 0, at: T0 }), 'REPORT_ONCE_INVALID_DEDUPE_KEY');
  }
  throwsWithCode(() => machine.prepare({ readIndex: 1, dedupeKey: 'k', random: 0, at: NaN }), 'REPORT_ONCE_INVALID_AT');
  // 非法输入不得留下任何状态（可安全用同一 readIndex 重来）。
  assert.equal(machine.snapshot().state, 'idle');
  assert.equal(machine.snapshot().lastReadIndex, 0);
  assert.equal(machine.snapshot().stats.draws, 0);
});

test('restore 对损坏/矛盾快照 fail-closed（带 code），不覆盖当前内存状态', () => {
  const { machine } = harness();
  prepared(machine, 1, 'read-1', 0);
  const good = machine.snapshot();
  const cases = [
    null,
    {},
    { ...good, state: 'sent' },
    { ...good, state: 'prepared', preparedAt: null },
    { ...good, state: 'dispatched', dispatchedAt: null },
    { ...good, state: 'confirmed', outcome: 'failed', settledAt: T0 },
    { ...good, state: 'confirmed', outcome: 'confirmed', settledAt: null },
    { ...good, readIndex: 0 },
    { ...good, lastReadIndex: -1 },
    { ...good, stats: { draws: -1, attempts: 0 } },
    { ...good, seenKeys: 'read-1' },
    { ...good, seenKeys: [1, 2] },
    { ...good, readIndex: 1, lastReadIndex: 0, state: 'idle' },
    { ...good, state: 'prepared', shouldReport: false },
  ];
  for (const bad of cases) {
    throwsWithCode(() => machine.restore(bad), 'REPORT_ONCE_INVALID_SNAPSHOT');
  }
  // 当前状态未被损坏快照覆盖。
  assert.deepEqual(machine.snapshot(), good);
  assert.equal(machine.dispatch({ at: T0 }).ok, true);
});

test('snapshot 是深拷贝：外部改写不影响状态机', () => {
  const { machine } = harness();
  drive(machine, 1);
  const snap = machine.snapshot();
  snap.state = 'idle';
  snap.seenKeys.push('injected');
  snap.stats.draws = 99;
  const fresh = machine.snapshot();
  assert.equal(fresh.state, 'confirmed');
  assert.deepEqual(fresh.seenKeys, ['read-1']);
  assert.equal(fresh.stats.draws, 1);
});

test('seenKeys 有上限（防内存无限增长），旧键淘汰后 readIndex 单调性仍兜底', () => {
  const { machine } = harness();
  for (let readIndex = 1; readIndex <= 80; readIndex += 1) {
    drive(machine, readIndex, { at: T0 + readIndex * 10 });
  }
  const snap = machine.snapshot();
  assert.ok(snap.seenKeys.length <= 64, `seenKeys 应有上限，实际 ${snap.seenKeys.length}`);
  assert.equal(snap.stats.draws, 80);
  // 取消抽签后每次读取都会进入 prepared 并尝试一次 dispatch。
  assert.equal(snap.stats.attempts, 80);
  // 旧 readIndex 仍然被拒绝（不是靠 seenKeys，而是 lastReadIndex 单调）。
  assert.deepEqual(prepared(machine, 1, 'read-1', 0, T0 + 10_000), { ok: false, reason: 'stale-read' });
});

test('reset() 只清当前读取/去重历史（供新北京日或明确新会话使用）', () => {
  const { machine } = harness();
  drive(machine, 3);
  const before = machine.snapshot();
  assert.equal(before.lastReadIndex, 3);
  const after = machine.reset();
  assert.equal(after.state, 'idle');
  assert.equal(after.lastReadIndex, 0);
  assert.deepEqual(after.seenKeys, []);
  // 累计统计保留（审计用），但新的第 1 次读取可以正常抽签。
  assert.equal(after.stats.draws, 1);
  const first = prepared(machine, 1, 'read-1', 0.5);
  assert.equal(first.ok, true);
  assert.equal(first.probability, 1, '抽签取消后固定为 1（永远有资格由模型决定）');
});

test('不读取全局 Math.random，且时钟默认值可注入', () => {
  const original = Math.random;
  Math.random = () => {
    throw new Error('汇报状态机不得调用全局随机源');
  };
  try {
    const { machine } = harness();
    prepared(machine, 1, 'read-1', 0);
    machine.dispatch({ at: T0 });
    machine.settle({ outcome: 'confirmed', at: T0 });
  } finally {
    Math.random = original;
  }
  // 不传 at 时使用注入的 now()。
  const machine = createBackgroundPatrolReportOnce({ now: () => T0 });
  const ready = machine.prepare({ readIndex: 1, dedupeKey: 'read-1', random: 0 });
  assert.equal(ready.ok, true);
  assert.equal(machine.snapshot().preparedAt, T0);
  assert.equal(machine.dispatch().ok, true);
  assert.equal(machine.snapshot().dispatchedAt, T0);
});

// ── task-15 审查修复：L1 时间戳单调、L2 0 概率档 random 约定 ─────────────────

test('L1 dispatch 的 at 早于 preparedAt 时抛 REPORT_ONCE_CLOCK_ROLLBACK，且状态不变（不产出自身 restore 拒绝的快照）', () => {
  const { machine } = harness();
  prepared(machine, 1, 'read-1', 0, T0);
  const error = throwsWithCode(() => machine.dispatch({ at: T0 - 1 }), 'REPORT_ONCE_CLOCK_ROLLBACK');
  assert.ok(error instanceof RangeError, `回拨应抛 RangeError，实际 ${error?.constructor?.name}`);
  assert.equal(machine.snapshot().state, 'prepared');
  assert.equal(machine.snapshot().stats.attempts, 0);

  // 等于 preparedAt 允许（>= 语义），且快照可被 restore 接受。
  assert.equal(machine.dispatch({ at: T0 }).ok, true);
  const restored = createBackgroundPatrolReportOnce({ now: () => T0, ttlMs: 60_000 });
  assert.doesNotThrow(() => restored.restore(machine.snapshot()));
  assert.equal(restored.snapshot().state, 'dispatched');
});

test('L1 settle 的 at 早于 dispatchedAt 时抛 REPORT_ONCE_CLOCK_ROLLBACK，且状态仍可合法收尾', () => {
  const { machine } = harness();
  prepared(machine, 1, 'read-1', 0, T0);
  machine.dispatch({ at: T0 + 10 });
  const error = throwsWithCode(() => machine.settle({ outcome: 'confirmed', at: T0 + 9 }), 'REPORT_ONCE_CLOCK_ROLLBACK');
  assert.ok(error instanceof RangeError);
  const snap = machine.snapshot();
  assert.equal(snap.state, 'dispatched');
  assert.equal(snap.settledAt, null);
  // 合法的 >= 收尾（同一时刻也允许），且快照能 restore 往返。
  assert.equal(machine.settle({ outcome: 'confirmed', at: T0 + 10 }).ok, true);
  const restored = createBackgroundPatrolReportOnce({ now: () => T0 + 10, ttlMs: 60_000 });
  assert.doesNotThrow(() => restored.restore(machine.snapshot()));
  assert.equal(restored.snapshot().state, 'confirmed');
});

test('L2（已废弃）：readIndex≥7 仍进入 prepared；缺省 random 不再抛错', () => {
  const late = harness();
  const out = late.machine.prepare({ readIndex: 7, dedupeKey: 'read-7', at: T0 });
  assert.equal(out.ok, true);
  assert.equal(out.shouldReport, true, '取消抽签后不再有 0 概率档');
  assert.equal(out.probability, 1);
  assert.equal(out.random, null);
  assert.equal(late.machine.snapshot().state, 'prepared');
  assert.deepEqual(late.machine.prepare({ readIndex: 7, dedupeKey: 'read-7', at: T0 }), { ok: false, reason: 'duplicate-read' });
});

test('restore 接受「终态快照落后于 lastReadIndex」（重启后汇报不得被永久禁用）', () => {
  // 2026-10-29 实测生产状态：state=confirmed / readIndex=1 / lastReadIndex=6。
  // 旧校验要求两者相等，导致重启时 restore 拒绝快照 → 桥接「禁用小黑盒汇报」，
  // 巡逻汇报再也发不出去（22:32 那轮就是这样丢的）。终态落后是合法形状：
  // 第 1 次读命中并汇报后，后续又读到 5、6，快照仍停在 1。
  const { machine } = harness();
  prepared(machine, 1, 'read-1', 0);
  machine.dispatch({ at: T0 });
  machine.settle({ outcome: 'confirmed', at: T0 });
  const snap = machine.snapshot();
  assert.equal(snap.readIndex, 1);
  const behind = { ...snap, lastReadIndex: 6 };
  const fresh = harness().machine;
  assert.doesNotThrow(() => fresh.restore(behind));
  assert.equal(fresh.snapshot().state, 'confirmed');
  assert.equal(fresh.snapshot().readIndex, 1);
  assert.equal(fresh.snapshot().lastReadIndex, 6);
  // 落后快照恢复后，新读取（更大 readIndex）仍可正常抽签，不会被去重挡住。
  const r = fresh.prepare({ readIndex: 7, dedupeKey: 'read-7', random: 0, at: T0 });
  assert.equal(r.ok, true);

  // 反向：快照超前于 lastReadIndex 是不可能的组合，必须继续 fail-closed。
  const ahead = { ...snap, readIndex: 2, lastReadIndex: 1 };
  throwsWithCode(() => harness().machine.restore(ahead), 'REPORT_ONCE_INVALID_SNAPSHOT');
});

test('declined 是合法终态：快照可恢复，不得因一次「不分享」在重启后永久禁用', () => {
  const a = harness();
  prepared(a.machine, 1, 'read-1');
  a.machine.dispatch({ at: T0 });
  assert.equal(a.machine.settle({ outcome: 'declined', at: T0 + 1 }).ok, true);
  const snap = a.machine.snapshot();
  assert.equal(snap.state, 'declined');
  const b = harness();
  b.machine.restore(snap);
  assert.equal(b.machine.snapshot().state, 'declined');
  assert.equal(b.machine.snapshot().lastReadIndex, 1);
});

