#!/usr/bin/env node
// test-xhh-tool-surface-decision.mjs —— 小黑盒 MCP 工具面纯判定状态机 v2.1（离线，纯逻辑，无 IO）
//
// 契约来源：Lead 2026-10-30 阶段 2A 派工 + 勘误 + v2（Codex 终审驳回后返工）+ v2.1
// （Codex 新增硬要求：跳过/挂起的定时检查不得误算「连续三次」）。
//
// v2 核心：把两条观测路径分开，避免「事件连发」冒充「连续三次一分钟检查」：
//   · source:'scheduled' 的 absent 才累加 consecutiveMisses；
//   · source:'event' 的 absent 只记录状态/时间，计数不变、alert 恒 false；
//   · 投递结果由 noteToolSurfaceDelivery 单独记账：只有 delivered 推进 lastAlertAt；
//     failed/unknown 只写 lastAttemptAt/lastAttemptOutcome，并触发 15 分钟失败重试节流。
//   · 成功通知节流 6h；state v2（v1 → parse 返回 null，调用方回落初始 state）。
//
// v2.1 新增「间隔与断链语义」（scheduled 路径）：
//   · 太密（gap < intervalMs*0.5）→ too-soon：不计数、不推进 lastScheduledAt；
//   · 太疏（gap > intervalMs*2.5，宿主挂起/事件循环阻塞/定时器跳过）→ 链路已断，
//     计数重置为 1（chain-restarted），绝不把醒来后的补跑算成「连续」；
//   · 时钟倒退 → clock-backwards：不计数、不推进 lastScheduledAt；
//   · event 永不更新 lastScheduledAt（事件的 at 不参与间隔判定）。
//
// 其余语义沿用勘误：合法数组（可空）是可靠观测；null/非数组 → uncertain/no-observation；
// 非法元素 → uncertain/invalid-name；uncertain 必须断链；非法输入不抛异常。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  XHH_TOOL_NAME_PREFIX,
  XHH_EXPECTED_TOOL_NAMES,
  XHH_TOOL_SURFACE_MIN_CONSECUTIVE_MISSES,
  XHH_TOOL_SURFACE_ALERT_THROTTLE_MS,
  XHH_TOOL_SURFACE_FAILURE_RETRY_MS,
  XHH_TOOL_SURFACE_DEFAULT_INTERVAL_MS,
  XHH_TOOL_SURFACE_MIN_TICK_GAP_RATIO,
  XHH_TOOL_SURFACE_MAX_TICK_GAP_RATIO,
  XHH_TOOL_SURFACE_SOURCES,
  XHH_TOOL_SURFACE_STATE_VERSION,
  classifyToolSurface,
  createToolSurfaceState,
  parseToolSurfaceState,
  recordToolSurfaceObservation,
  noteToolSurfaceDelivery,
} from '../src/core/xhh-tool-surface-decision.mjs';

const FULL = XHH_EXPECTED_TOOL_NAMES;
const T0 = 1_700_000_000_000; // 固定观测时刻，避免依赖真实时钟
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const INTERVAL = XHH_TOOL_SURFACE_DEFAULT_INTERVAL_MS;

function expectPresent(result) {
  assert.equal(result.state, 'present');
  assert.equal(result.reason, 'ok');
  assert.deepEqual(result.missing, []);
  assert.equal(result.presentCount, FULL.length);
  assert.equal(result.expectedCount, FULL.length);
}

function expectAbsent(result, missingExpected) {
  assert.equal(result.state, 'absent');
  assert.equal(result.reason, 'missing-tools');
  assert.deepEqual(result.missing, missingExpected);
  assert.equal(result.expectedCount, FULL.length);
}

function expectUncertain(result, reason) {
  assert.equal(result.state, 'uncertain');
  assert.equal(result.reason, reason);
  assert.deepEqual(result.missing, []);
}

function stateSnapshot(state) {
  return JSON.parse(JSON.stringify(state));
}

/** 连续 N 次「按间隔」的 scheduled absent，返回最后一次结果与最终 state。 */
function scheduledMisses(state, count, startAt = T0, step = INTERVAL) {
  let result = null;
  let current = state;
  for (let i = 0; i < count; i += 1) {
    result = recordToolSurfaceObservation(current, {
      observedNames: [],
      at: startAt + i * step,
      source: 'scheduled',
    });
    current = result.state;
  }
  return { result, state: current };
}

test('常量：前缀、12 个工具名（排序）、阈值/节流/重试/间隔/来源/版本', () => {
  assert.equal(XHH_TOOL_NAME_PREFIX, 'mcp__xiaoheihe__');
  assert.equal(XHH_EXPECTED_TOOL_NAMES.length, 12);
  assert.deepEqual([...XHH_EXPECTED_TOOL_NAMES], [...XHH_EXPECTED_TOOL_NAMES].sort());
  assert.equal(new Set(XHH_EXPECTED_TOOL_NAMES).size, 12);
  for (const name of XHH_EXPECTED_TOOL_NAMES) {
    assert.equal(typeof name, 'string');
    assert.ok(name.length > 0);
    assert.doesNotMatch(name, /\s/);
  }
  assert.equal(XHH_TOOL_SURFACE_MIN_CONSECUTIVE_MISSES, 3);
  assert.equal(XHH_TOOL_SURFACE_ALERT_THROTTLE_MS, 6 * HOUR);
  assert.equal(XHH_TOOL_SURFACE_FAILURE_RETRY_MS, 15 * MINUTE);
  assert.equal(XHH_TOOL_SURFACE_DEFAULT_INTERVAL_MS, 60_000);
  assert.equal(XHH_TOOL_SURFACE_MIN_TICK_GAP_RATIO, 0.5);
  assert.equal(XHH_TOOL_SURFACE_MAX_TICK_GAP_RATIO, 2.5);
  assert.deepEqual([...XHH_TOOL_SURFACE_SOURCES], ['scheduled', 'event']);
  assert.equal(XHH_TOOL_SURFACE_STATE_VERSION, 2);
});

test('分类 present：全在（含重复与多余观测名）→ present/ok', () => {
  expectPresent(classifyToolSurface({ observedNames: [...FULL] }));
  expectPresent(classifyToolSurface({ observedNames: [...FULL, FULL[0], 'extra_tool_not_expected'] }));
});

test('分类 absent：缺一个 → missing 精确且排序', () => {
  const dropped = FULL[4];
  const observed = FULL.filter((name) => name !== dropped);
  const result = classifyToolSurface({ observedNames: observed });
  expectAbsent(result, [dropped]);
  assert.equal(result.presentCount, FULL.length - 1);
});

test('勘误：空数组是可靠观测 → absent，missing 为全部 12 个', () => {
  const result = classifyToolSurface({ observedNames: [] });
  expectAbsent(result, [...FULL].sort());
  assert.equal(result.presentCount, 0);
});

test('勘误：null/undefined/非数组 → uncertain/no-observation（不得当 absent）', () => {
  for (const observedNames of [null, undefined, 'a,b', {}, 42, true]) {
    expectUncertain(classifyToolSurface({ observedNames }), 'no-observation');
  }
});

test('分类 uncertain：含非法元素（null/数字/空串/带空格）→ invalid-name，且优先于 absent', () => {
  for (const bad of [null, 7, '', 'has space', 'x\ty', `${FULL[0]} `]) {
    const result = classifyToolSurface({ observedNames: [FULL[0], bad] });
    expectUncertain(result, 'invalid-name');
  }
});

test('分类 uncertain：expectedNames 为空或非数组 → no-expected', () => {
  for (const expectedNames of [[], 'nope', null, 7, {}]) {
    expectUncertain(classifyToolSurface({ observedNames: [...FULL], expectedNames }), 'no-expected');
  }
});

test('createToolSurfaceState：v2 初始形状固定（含 lastScheduledAt/lastAttemptAt/lastAttemptOutcome）', () => {
  assert.deepEqual(createToolSurfaceState(), {
    schemaVersion: 2,
    consecutiveMisses: 0,
    lastAlertAt: null,
    lastState: 'unknown',
    lastObservedAt: null,
    lastReason: 'init',
    lastAttemptAt: null,
    lastAttemptOutcome: null,
    lastScheduledAt: null,
  });
});

test('parseToolSurfaceState：v2 往返；任意非法输入与 v1/未知版本 → null', () => {
  const state = createToolSurfaceState();
  assert.deepEqual(parseToolSurfaceState(state), state);
  assert.deepEqual(parseToolSurfaceState(JSON.stringify(state)), state);

  const v1State = {
    schemaVersion: 1,
    consecutiveMisses: 0,
    lastAlertAt: null,
    lastState: 'unknown',
    lastObservedAt: null,
    lastReason: 'init',
  };
  const corrupt = [
    null,
    undefined,
    0,
    'not json',
    [],
    [{ schemaVersion: 2 }],
    v1State,
    JSON.stringify(v1State),
    { ...state, schemaVersion: 1 },
    { ...state, schemaVersion: 3 },
    { ...state, schemaVersion: '2' },
    { ...state, consecutiveMisses: -1 },
    { ...state, consecutiveMisses: 1.5 },
    { ...state, lastAlertAt: 'x' },
    { ...state, lastAlertAt: Number.NaN },
    { ...state, lastObservedAt: 'x' },
    { ...state, lastScheduledAt: 'x' },
    { ...state, lastScheduledAt: Number.NaN },
    { ...state, lastAttemptAt: 'x' },
    { ...state, lastAttemptAt: Number.NaN },
    { ...state, lastAttemptOutcome: 'ok' },
    { ...state, lastAttemptOutcome: 7 },
    { ...state, lastState: 'bogus' },
    { ...state, lastReason: '' },
    { ...state, lastReason: 7 },
  ];
  for (const raw of corrupt) {
    assert.equal(parseToolSurfaceState(raw), null, `应拒绝: ${JSON.stringify(raw)}`);
  }
});

test('v2.1-⑧：v2 快照缺 lastScheduledAt → parse 成功且视为 null（首条 tick 正常计 1）', () => {
  const legacyV2 = {
    schemaVersion: 2,
    consecutiveMisses: 0,
    lastAlertAt: null,
    lastState: 'unknown',
    lastObservedAt: null,
    lastReason: 'init',
    lastAttemptAt: null,
    lastAttemptOutcome: null,
  };
  const parsed = parseToolSurfaceState(legacyV2);
  assert.notEqual(parsed, null);
  assert.equal(parsed.lastScheduledAt, null);

  const first = recordToolSurfaceObservation(parsed, { observedNames: [], at: T0, source: 'scheduled' });
  assert.equal(first.counted, true);
  assert.equal(first.state.consecutiveMisses, 1);
  assert.equal(first.state.lastScheduledAt, T0);
});

test('计数：scheduled absent 累加；present 与 uncertain 都清零（中断，不能"先当缺失"）', () => {
  const s0 = createToolSurfaceState();
  const r1 = recordToolSurfaceObservation(s0, { observedNames: [], at: T0, source: 'scheduled' });
  assert.equal(r1.state.consecutiveMisses, 1);
  assert.equal(r1.state.lastScheduledAt, T0);
  assert.equal(r1.alert, false);
  assert.equal(r1.counted, true);

  const r2 = recordToolSurfaceObservation(r1.state, { observedNames: null, at: T0 + INTERVAL, source: 'scheduled' });
  assert.equal(r2.state.consecutiveMisses, 0, 'uncertain 必须中断计数');
  assert.equal(r2.state.lastState, 'uncertain');
  assert.equal(r2.state.lastReason, 'no-observation');
  assert.equal(r2.state.lastScheduledAt, T0 + INTERVAL);
  assert.equal(r2.alert, false);
  assert.equal(r2.counted, false);

  const r3 = recordToolSurfaceObservation(r2.state, { observedNames: [], at: T0 + 2 * INTERVAL, source: 'scheduled' });
  assert.equal(r3.state.consecutiveMisses, 1, '中断后重新从 1 开始');

  const r4 = recordToolSurfaceObservation(r3.state, { observedNames: [...FULL], at: T0 + 3 * INTERVAL, source: 'scheduled' });
  assert.equal(r4.state.consecutiveMisses, 0);
  assert.equal(r4.state.lastState, 'present');
  assert.equal(r4.state.lastScheduledAt, T0 + 3 * INTERVAL);
  assert.equal(r4.alert, false);
});

test('v2-①a：event absent 不计数、不告警，即使同一时刻连发 3 次', () => {
  let state = createToolSurfaceState();
  for (let i = 0; i < 3; i += 1) {
    const r = recordToolSurfaceObservation(state, { observedNames: [], at: T0, source: 'event' });
    assert.equal(r.consecutiveMisses, 0, 'event 缺失不得累加');
    assert.equal(r.counted, false);
    assert.equal(r.alert, false);
    assert.equal(r.state.lastState, 'absent');
    assert.equal(r.state.lastReason, 'event-not-counted');
    assert.equal(r.state.lastObservedAt, T0);
    assert.equal(r.state.lastScheduledAt, null, 'event 不更新 lastScheduledAt');
    state = r.state;
  }
  assert.equal(state.consecutiveMisses, 0, '连发 event 后计数仍为 0');

  const { result } = scheduledMisses(state, 3);
  assert.equal(result.alert, true, '随后 3 次 scheduled 缺失才允许提示');
  assert.equal(result.state.consecutiveMisses, 3);
  assert.equal(result.state.lastAlertAt, null, 'alert 本身不写 lastAlertAt（交给投递记账）');
});

test('v2-①b：3 次 scheduled absent 才提示，前两次不提示', () => {
  let state = createToolSurfaceState();
  const r1 = recordToolSurfaceObservation(state, { observedNames: [], at: T0, source: 'scheduled' });
  assert.equal(r1.alert, false);
  assert.equal(r1.state.consecutiveMisses, 1);
  assert.equal(r1.reason, 'missing-tools');
  state = r1.state;

  const r2 = recordToolSurfaceObservation(state, { observedNames: [], at: T0 + INTERVAL, source: 'scheduled' });
  assert.equal(r2.alert, false);
  state = r2.state;

  const r3 = recordToolSurfaceObservation(state, { observedNames: [], at: T0 + 2 * INTERVAL, source: 'scheduled' });
  assert.equal(r3.alert, true);
  assert.equal(r3.kind, 'registration-lost');
  assert.equal(r3.counted, true);
  assert.equal(r3.state.consecutiveMisses, 3);
  assert.equal(r3.state.lastAlertAt, null, 'alert 调用本身不写 lastAlertAt');
  assert.equal(r3.state.lastAttemptAt, null, 'alert 调用本身不写 lastAttemptAt');
  assert.equal(r3.throttleRemainingMs, 0);
  assert.equal(r3.retryRemainingMs, 0);
});

test('v2.1-①：正常链 t0/t0+60s/t0+120s → 第 3 次才 alert，lastScheduledAt 逐次推进', () => {
  const { result, state } = scheduledMisses(createToolSurfaceState(), 3, T0);
  assert.equal(result.alert, true);
  assert.equal(state.consecutiveMisses, 3);
  assert.equal(state.lastScheduledAt, T0 + 2 * INTERVAL);
});

test('v2.1-②：挂起 10 分钟后补跑 → 计数必须回到 1（不是 2/3），不 alert', () => {
  const first = recordToolSurfaceObservation(createToolSurfaceState(), {
    observedNames: [],
    at: T0,
    source: 'scheduled',
  });
  assert.equal(first.state.consecutiveMisses, 1);

  const afterSuspend = recordToolSurfaceObservation(first.state, {
    observedNames: [],
    at: T0 + 10 * MINUTE,
    source: 'scheduled',
  });
  assert.equal(afterSuspend.consecutiveMisses, 1, '挂起后补跑不得续链（旧实现会算成 2）');
  assert.equal(afterSuspend.counted, true);
  assert.equal(afterSuspend.reason, 'chain-restarted');
  assert.equal(afterSuspend.alert, false);
  assert.equal(afterSuspend.state.lastScheduledAt, T0 + 10 * MINUTE);

  const second = recordToolSurfaceObservation(afterSuspend.state, {
    observedNames: [],
    at: T0 + 10 * MINUTE + INTERVAL,
    source: 'scheduled',
  });
  assert.equal(second.consecutiveMisses, 2);
  assert.equal(second.alert, false);

  const third = recordToolSurfaceObservation(second.state, {
    observedNames: [],
    at: T0 + 10 * MINUTE + 2 * INTERVAL,
    source: 'scheduled',
  });
  assert.equal(third.consecutiveMisses, 3);
  assert.equal(third.alert, true);
});

test('v2.1-③：跳过两次（t0+3min > 2.5×）→ 重置为 1；t0+4min → 2；不 alert', () => {
  let state = recordToolSurfaceObservation(createToolSurfaceState(), { observedNames: [], at: T0, source: 'scheduled' }).state;
  const skipped = recordToolSurfaceObservation(state, { observedNames: [], at: T0 + 3 * MINUTE, source: 'scheduled' });
  assert.equal(skipped.consecutiveMisses, 1, '3 分钟 > 2.5 倍间隔 → 重新起链');
  assert.equal(skipped.reason, 'chain-restarted');
  assert.equal(skipped.alert, false);
  state = skipped.state;

  const next = recordToolSurfaceObservation(state, { observedNames: [], at: T0 + 4 * MINUTE, source: 'scheduled' });
  assert.equal(next.consecutiveMisses, 2);
  assert.equal(next.alert, false);
  assert.equal(next.reason, 'missing-tools');
});

test('v2.1-④：太密（t0+1ms）→ too-soon，不计数、不推进 lastScheduledAt；t0+60s → 2', () => {
  const first = recordToolSurfaceObservation(createToolSurfaceState(), { observedNames: [], at: T0, source: 'scheduled' });
  assert.equal(first.state.consecutiveMisses, 1);
  assert.equal(first.state.lastScheduledAt, T0);

  const tooSoon = recordToolSurfaceObservation(first.state, { observedNames: [], at: T0 + 1, source: 'scheduled' });
  assert.equal(tooSoon.counted, false);
  assert.equal(tooSoon.consecutiveMisses, 1);
  assert.equal(tooSoon.reason, 'too-soon');
  assert.equal(tooSoon.alert, false);
  assert.equal(tooSoon.state.lastScheduledAt, T0, 'too-soon 不得推进 lastScheduledAt');

  const normal = recordToolSurfaceObservation(tooSoon.state, { observedNames: [], at: T0 + INTERVAL, source: 'scheduled' });
  assert.equal(normal.consecutiveMisses, 2);
  assert.equal(normal.counted, true);
});

test('v2.1-⑤：事件不影响链路（t0 scheduled → 1；t0+1s event absent → 仍 1；t0+60s scheduled → 2）', () => {
  let state = recordToolSurfaceObservation(createToolSurfaceState(), { observedNames: [], at: T0, source: 'scheduled' }).state;
  assert.equal(state.consecutiveMisses, 1);

  const event = recordToolSurfaceObservation(state, { observedNames: [], at: T0 + 1000, source: 'event' });
  assert.equal(event.counted, false);
  assert.equal(event.consecutiveMisses, 1);
  assert.equal(event.state.lastScheduledAt, T0, 'event 不推进 lastScheduledAt');
  state = event.state;

  const next = recordToolSurfaceObservation(state, { observedNames: [], at: T0 + INTERVAL, source: 'scheduled' });
  assert.equal(next.consecutiveMisses, 2, 'gap 仍按上次 scheduled 的 t0 计算');
  assert.equal(next.counted, true);
});

test('v2.1-⑥：时钟倒退 → clock-backwards，计数与 lastScheduledAt 都不变', () => {
  const { state } = scheduledMisses(createToolSurfaceState(), 2, T0); // t0、t0+60s → 2
  const backwards = recordToolSurfaceObservation(state, { observedNames: [], at: T0 + 30 * MINUTE, source: 'scheduled' });
  assert.equal(backwards.alert, false);
  assert.equal(backwards.counted, true);
  assert.equal(backwards.consecutiveMisses, 1, '30 分钟 > 2.5 倍 → 链路重启');
  assert.equal(backwards.reason, 'chain-restarted');

  // 真正的倒退：at < lastScheduledAt
  const first = recordToolSurfaceObservation(createToolSurfaceState(), { observedNames: [], at: T0, source: 'scheduled' });
  const tick2 = recordToolSurfaceObservation(first.state, { observedNames: [], at: T0 + INTERVAL, source: 'scheduled' });
  const clockBack = recordToolSurfaceObservation(tick2.state, { observedNames: [], at: T0 + 30 * 1000, source: 'scheduled' });
  assert.equal(clockBack.counted, false);
  assert.equal(clockBack.consecutiveMisses, 2);
  assert.equal(clockBack.reason, 'clock-backwards');
  assert.equal(clockBack.state.lastScheduledAt, T0 + INTERVAL);
  assert.equal(clockBack.alert, false);

  const tooClose = recordToolSurfaceObservation(tick2.state, { observedNames: [], at: T0 + INTERVAL + 1, source: 'scheduled' });
  assert.equal(tooClose.counted, false);
  assert.equal(tooClose.consecutiveMisses, 2);
  assert.equal(tooClose.reason, 'too-soon');
});

test('v2.1-⑦：event 的 present/uncertain 断链清零，但不更新 lastScheduledAt', () => {
  let state = recordToolSurfaceObservation(createToolSurfaceState(), { observedNames: [], at: T0, source: 'scheduled' }).state;
  assert.equal(state.consecutiveMisses, 1);

  const present = recordToolSurfaceObservation(state, { observedNames: [...FULL], at: T0 + 30_000, source: 'event' });
  assert.equal(present.consecutiveMisses, 0);
  assert.equal(present.state.lastScheduledAt, T0, 'event 不推进 lastScheduledAt');
  state = present.state;

  const next = recordToolSurfaceObservation(state, { observedNames: [], at: T0 + 90_000, source: 'scheduled' });
  assert.equal(next.consecutiveMisses, 1, 'gap 仍从上次 scheduled 的 t0 算（90s 在 0.5~2.5 倍内）');
  assert.equal(next.counted, true);

  const uncertain = recordToolSurfaceObservation(next.state, { observedNames: null, at: T0 + 95_000, source: 'event' });
  assert.equal(uncertain.consecutiveMisses, 0);
  assert.equal(uncertain.state.lastScheduledAt, T0 + 90_000);
});

test('v2.1-⑨：非法 intervalMs（0/-1/NaN/"60"）→ invalid-observation、state 原样', () => {
  const base = recordToolSurfaceObservation(createToolSurfaceState(), { observedNames: [], at: T0, source: 'scheduled' }).state;
  const snapshot = stateSnapshot(base);
  for (const intervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '60', null, {}]) {
    const r = recordToolSurfaceObservation(base, {
      observedNames: [],
      at: T0 + INTERVAL,
      source: 'scheduled',
      intervalMs,
    });
    assert.equal(r.alert, false);
    assert.equal(r.counted, false);
    assert.equal(r.reason, 'invalid-observation');
    assert.deepEqual(r.state, snapshot, `intervalMs=${JSON.stringify(intervalMs)} 必须原地不变`);
  }
  assert.deepEqual(base, snapshot);
});

test('v2-②：2 次 scheduled + 1 次 event absent 仍停在 2；再来 1 次 scheduled 触发', () => {
  let state = createToolSurfaceState();
  state = recordToolSurfaceObservation(state, { observedNames: [], at: T0, source: 'scheduled' }).state;
  state = recordToolSurfaceObservation(state, { observedNames: [], at: T0 + INTERVAL, source: 'scheduled' }).state;
  const eventMiss = recordToolSurfaceObservation(state, { observedNames: [], at: T0 + 2 * INTERVAL, source: 'event' });
  assert.equal(eventMiss.consecutiveMisses, 2, 'event 缺失不推进计数');
  assert.equal(eventMiss.alert, false);
  state = eventMiss.state;

  const third = recordToolSurfaceObservation(state, { observedNames: [], at: T0 + 3 * INTERVAL, source: 'scheduled' });
  assert.equal(third.consecutiveMisses, 3);
  assert.equal(third.alert, true);
});

test('v2-③：3 次 scheduled 之间夹 event present → 链断（计数回 0）', () => {
  let state = createToolSurfaceState();
  state = recordToolSurfaceObservation(state, { observedNames: [], at: T0, source: 'scheduled' }).state;
  state = recordToolSurfaceObservation(state, { observedNames: [], at: T0 + INTERVAL, source: 'scheduled' }).state;
  const present = recordToolSurfaceObservation(state, { observedNames: [...FULL], at: T0 + 2 * INTERVAL, source: 'event' });
  assert.equal(present.consecutiveMisses, 0);
  assert.equal(present.state.lastState, 'present');
  assert.equal(present.alert, false);
  state = present.state;

  const again = recordToolSurfaceObservation(state, { observedNames: [], at: T0 + 3 * INTERVAL, source: 'scheduled' });
  assert.equal(again.consecutiveMisses, 1, '断链后重新从 1 开始');
  assert.equal(again.alert, false);
});

test('v2-④：event uncertain 也断链（计数回 0，不告警）', () => {
  let state = createToolSurfaceState();
  state = recordToolSurfaceObservation(state, { observedNames: [], at: T0, source: 'scheduled' }).state;
  state = recordToolSurfaceObservation(state, { observedNames: [], at: T0 + INTERVAL, source: 'scheduled' }).state;
  const uncertain = recordToolSurfaceObservation(state, { observedNames: null, at: T0 + 2 * INTERVAL, source: 'event' });
  assert.equal(uncertain.consecutiveMisses, 0);
  assert.equal(uncertain.state.lastState, 'uncertain');
  assert.equal(uncertain.alert, false);

  const next = recordToolSurfaceObservation(uncertain.state, { observedNames: [], at: T0 + 3 * INTERVAL, source: 'scheduled' });
  assert.equal(next.consecutiveMisses, 1);
  assert.equal(next.alert, false);
});

test('v2-⑤：非法 source → invalid-observation，state 原样、不抛异常', () => {
  const base = recordToolSurfaceObservation(createToolSurfaceState(), { observedNames: [], at: T0, source: 'scheduled' }).state;
  const snapshot = stateSnapshot(base);
  for (const source of ['timer', 'manual', '', 'SCHEDULED', null, 7, {}]) {
    const r = recordToolSurfaceObservation(base, { observedNames: [], at: T0 + 1000, source });
    assert.equal(r.alert, false);
    assert.equal(r.counted, false);
    assert.equal(r.reason, 'invalid-observation');
    assert.deepEqual(r.state, snapshot, `source=${JSON.stringify(source)} 必须原地不变`);
  }
  assert.deepEqual(base, snapshot);
});

test('v2-⑥：note(failed) 后 15 分钟内到阈值 → retry-throttled；满 15 分钟允许', () => {
  const { result, state: blocked } = scheduledMisses(createToolSurfaceState(), 3, T0);
  assert.equal(result.alert, true);

  const noted = noteToolSurfaceDelivery(blocked, { at: T0 + 3 * MINUTE, outcome: 'failed' });
  assert.equal(noted.accepted, true);
  assert.equal(noted.state.lastAttemptAt, T0 + 3 * MINUTE);
  assert.equal(noted.state.lastAttemptOutcome, 'failed');
  assert.equal(noted.state.lastAlertAt, null, 'failed 绝不写 lastAlertAt');
  assert.equal(noted.state.consecutiveMisses, 3, '投递记账不改变计数');

  // 之后按 1 分钟间隔持续检查；到阈值但仍在 15 分钟失败重试窗口内 → retry-throttled
  let state = noted.state;
  let tick = null;
  for (let t = 4 * MINUTE; t < 18 * MINUTE; t += MINUTE) {
    tick = recordToolSurfaceObservation(state, { observedNames: [], at: T0 + t, source: 'scheduled' });
    state = tick.state;
  }
  assert.equal(tick.reason, 'retry-throttled');
  assert.equal(tick.alert, false);
  assert.equal(tick.consecutiveMisses, 17);
  assert.equal(tick.retryRemainingMs, MINUTE);

  const boundary = recordToolSurfaceObservation(state, {
    observedNames: [],
    at: T0 + 3 * MINUTE + XHH_TOOL_SURFACE_FAILURE_RETRY_MS,
    source: 'scheduled',
  });
  assert.equal(boundary.alert, true, '满 15 分钟后允许再次提示');
  assert.equal(boundary.reason, 'missing-tools');
  assert.equal(boundary.retryRemainingMs, 0);
});

test('v2-⑦：note(delivered) 后 6 小时内 throttled；满 6 小时允许', () => {
  const { result, state: missed } = scheduledMisses(createToolSurfaceState(), 3, T0);
  assert.equal(result.alert, true);

  const noted = noteToolSurfaceDelivery(missed, { at: T0 + 3 * MINUTE, outcome: 'delivered', deliveredAt: T0 + 3 * MINUTE });
  assert.equal(noted.accepted, true);
  assert.equal(noted.state.lastAlertAt, T0 + 3 * MINUTE);
  assert.equal(noted.state.lastAttemptAt, T0 + 3 * MINUTE);
  assert.equal(noted.state.lastAttemptOutcome, 'delivered');

  const tooSoon = recordToolSurfaceObservation(noted.state, { observedNames: [], at: T0 + 4 * MINUTE, source: 'scheduled' });
  assert.equal(tooSoon.alert, false);
  assert.equal(tooSoon.reason, 'throttled');
  assert.equal(tooSoon.throttleRemainingMs, 6 * HOUR - MINUTE);
  assert.equal(tooSoon.counted, true);
  assert.equal(tooSoon.consecutiveMisses, 4, '节流期间计数继续累加');

  // 持续按 1 分钟间隔直到恰好满 6h（从 deliveredAt 起算）；最后一次应允许提示
  const limitAt = noted.state.lastAlertAt + XHH_TOOL_SURFACE_ALERT_THROTTLE_MS;
  let state = tooSoon.state;
  let last = tooSoon;
  for (let at = T0 + 5 * MINUTE; at <= limitAt; at += MINUTE) {
    last = recordToolSurfaceObservation(state, { observedNames: [], at, source: 'scheduled' });
    state = last.state;
  }
  assert.equal(last.alert, true, '满 6 小时允许再次提示');
  assert.equal(last.reason, 'missing-tools');
  assert.equal(last.throttleRemainingMs, 0);
  assert.ok(last.consecutiveMisses > 4);
});

test('v2-⑧：投递回填不增加 consecutiveMisses（连续 3 次 note(failed) 计数不变）', () => {
  const { result, state: blocked } = scheduledMisses(createToolSurfaceState(), 3, T0);
  assert.equal(result.alert, true);
  let current = blocked;
  for (let i = 0; i < 3; i += 1) {
    const noted = noteToolSurfaceDelivery(current, { at: T0 + (4 + i) * MINUTE, outcome: 'failed' });
    assert.equal(noted.accepted, true);
    assert.equal(noted.state.consecutiveMisses, 3, 'note 不得改变计数');
    assert.equal(noted.state.lastAlertAt, null);
    current = noted.state;
  }
  assert.equal(current.consecutiveMisses, 3);
});

test('v2：投递记账非法输入：accepted:false 且 state 原样', () => {
  const base = noteToolSurfaceDelivery(createToolSurfaceState(), { at: T0, outcome: 'failed' }).state;
  const snapshot = stateSnapshot(base);
  for (const call of [
    { at: T0 + 1, outcome: 'ok' },
    { at: T0 + 1, outcome: null },
    { at: Number.NaN, outcome: 'failed' },
    { at: T0 + 1 },
    { outcome: 'failed' },
  ]) {
    const r = noteToolSurfaceDelivery(base, call);
    assert.equal(r.accepted, false);
    assert.deepEqual(r.state, snapshot);
  }
  for (const badState of [null, undefined, 'x', { schemaVersion: 1 }]) {
    const r = noteToolSurfaceDelivery(badState, { at: T0, outcome: 'failed' });
    assert.equal(r.accepted, false);
    assert.equal(r.state, badState);
  }
  assert.deepEqual(base, snapshot);
});

test('恢复：absent → present 清零且 lastReason 为 recovered，kind 不混入 registration-lost', () => {
  let r = recordToolSurfaceObservation(createToolSurfaceState(), { observedNames: [], at: T0, source: 'scheduled' });
  r = recordToolSurfaceObservation(r.state, { observedNames: [], at: T0 + INTERVAL, source: 'scheduled' });
  const back = recordToolSurfaceObservation(r.state, { observedNames: [...FULL], at: T0 + 2 * INTERVAL, source: 'scheduled' });
  assert.equal(back.alert, false);
  assert.equal(back.kind, null);
  assert.equal(back.state.consecutiveMisses, 0);
  assert.equal(back.state.lastState, 'present');
  assert.equal(back.state.lastReason, 'recovered');
});

test('非法输入不抛异常：at 非有限数 / state 非法 → 原地不变 + invalid-observation', () => {
  const good = recordToolSurfaceObservation(createToolSurfaceState(), { observedNames: [], at: T0, source: 'scheduled' });
  const snapshot = stateSnapshot(good.state);
  for (const at of [Number.NaN, Number.POSITIVE_INFINITY, 'x', null, undefined, {}]) {
    const r = recordToolSurfaceObservation(good.state, { observedNames: [], at, source: 'scheduled' });
    assert.equal(r.alert, false);
    assert.equal(r.reason, 'invalid-observation');
    assert.equal(r.counted, false);
    assert.deepEqual(r.state, snapshot, '非法输入必须原地不变');
    assert.deepEqual(good.state, snapshot);
  }
  for (const badState of [null, undefined, 'x', 0, {}, { schemaVersion: 2 }]) {
    const r = recordToolSurfaceObservation(badState, { observedNames: [], at: T0, source: 'scheduled' });
    assert.equal(r.alert, false);
    assert.equal(r.reason, 'invalid-observation');
    assert.equal(r.state, badState);
  }
});

test('不可变：record/note 不修改入参 state（返回新对象）', () => {
  const base = recordToolSurfaceObservation(createToolSurfaceState(), { observedNames: [], at: T0, source: 'scheduled' }).state;
  const before = stateSnapshot(base);

  const recorded = recordToolSurfaceObservation(base, { observedNames: [], at: T0 + INTERVAL, source: 'scheduled' });
  assert.deepEqual(base, before);
  assert.notEqual(recorded.state, base);

  const noted = noteToolSurfaceDelivery(base, { at: T0 + INTERVAL, outcome: 'delivered' });
  assert.deepEqual(base, before);
  assert.notEqual(noted.state, base);
});

test('deliveredAt 优先作为 lastAlertAt；非法 deliveredAt 回退到 at', () => {
  const { state: blocked } = scheduledMisses(createToolSurfaceState(), 3, T0);
  const noted = noteToolSurfaceDelivery(blocked, { at: T0 + 5 * MINUTE, outcome: 'delivered', deliveredAt: T0 + 5 * MINUTE + 777 });
  assert.equal(noted.state.lastAlertAt, T0 + 5 * MINUTE + 777);

  const notedFallback = noteToolSurfaceDelivery(blocked, { at: T0 + 5 * MINUTE, outcome: 'delivered', deliveredAt: Number.NaN });
  assert.equal(notedFallback.state.lastAlertAt, T0 + 5 * MINUTE);
});

test('v2：成功节流优先于失败重试节流；delivered 后不再走 retry-throttled', () => {
  const { state: blocked } = scheduledMisses(createToolSurfaceState(), 3, T0);
  const deliveredState = noteToolSurfaceDelivery(blocked, { at: T0 + 3 * MINUTE, outcome: 'delivered', deliveredAt: T0 + 3 * MINUTE }).state;
  const next = recordToolSurfaceObservation(deliveredState, { observedNames: [], at: T0 + 4 * MINUTE, source: 'scheduled' });
  assert.equal(next.alert, false);
  assert.equal(next.reason, 'throttled');
  assert.ok(next.throttleRemainingMs > 0);
  assert.equal(next.retryRemainingMs, 0);
});

test('v2：event absent 只更新观测字段，不改 lastAlertAt/lastAttemptAt', () => {
  const { state: blocked } = scheduledMisses(createToolSurfaceState(), 3, T0);
  const noted = noteToolSurfaceDelivery(blocked, { at: T0 + 5 * MINUTE, outcome: 'delivered' }).state;
  const eventMiss = recordToolSurfaceObservation(noted, { observedNames: [], at: T0 + 6 * MINUTE, source: 'event' });
  assert.equal(eventMiss.consecutiveMisses, 3);
  assert.equal(eventMiss.state.lastAlertAt, T0 + 5 * MINUTE);
  assert.equal(eventMiss.state.lastAttemptAt, T0 + 5 * MINUTE);
  assert.equal(eventMiss.state.lastObservedAt, T0 + 6 * MINUTE);
  assert.equal(eventMiss.state.lastReason, 'event-not-counted');
});

test('P2-1：too-soon 在 state.lastReason 中可区分（计数/lastScheduledAt/lastState 不变）', () => {
  const { state } = scheduledMisses(createToolSurfaceState(), 2, T0); // t0、t0+60s → 2
  assert.equal(state.lastScheduledAt, T0 + INTERVAL);
  const tooSoon = recordToolSurfaceObservation(state, {
    observedNames: [],
    at: T0 + INTERVAL + 1000,
    source: 'scheduled',
  });
  // 返回体 reason 仍是 too-soon；watcher 公开快照依赖的 state.lastReason 必须也是 too-soon。
  assert.equal(tooSoon.reason, 'too-soon');
  assert.equal(tooSoon.state.lastReason, 'too-soon');
  assert.equal(tooSoon.counted, false);
  assert.equal(tooSoon.consecutiveMisses, 2, 'too-soon 不改变计数');
  assert.equal(tooSoon.state.consecutiveMisses, 2);
  assert.equal(tooSoon.state.lastScheduledAt, T0 + INTERVAL, 'too-soon 不推进 lastScheduledAt');
  assert.equal(tooSoon.state.lastState, 'absent');
});

test('P2-1：clock-backwards 在 state.lastReason 中可区分（计数/lastScheduledAt 不变）', () => {
  const { state } = scheduledMisses(createToolSurfaceState(), 2, T0);
  const backwards = recordToolSurfaceObservation(state, {
    observedNames: [],
    at: T0 + INTERVAL - 1000,
    source: 'scheduled',
  });
  assert.equal(backwards.reason, 'clock-backwards');
  assert.equal(backwards.state.lastReason, 'clock-backwards');
  assert.equal(backwards.counted, false);
  assert.equal(backwards.consecutiveMisses, 2);
  assert.equal(backwards.state.lastScheduledAt, T0 + INTERVAL, 'clock-backwards 不推进 lastScheduledAt');
  assert.equal(backwards.state.lastState, 'absent');
});

test('P2-1：too-soon/clock-backwards 之后正常 tick 恢复 missing-tools 并正常 +1', () => {
  const { state } = scheduledMisses(createToolSurfaceState(), 2, T0);
  const ignored = recordToolSurfaceObservation(state, {
    observedNames: [],
    at: T0 + INTERVAL + 1000,
    source: 'scheduled',
  });
  assert.equal(ignored.state.lastReason, 'too-soon');

  const next = recordToolSurfaceObservation(ignored.state, {
    observedNames: [],
    at: T0 + 2 * INTERVAL,
    source: 'scheduled',
  });
  assert.equal(next.reason, 'missing-tools');
  assert.equal(next.state.lastReason, 'missing-tools');
  assert.equal(next.counted, true);
  assert.equal(next.consecutiveMisses, 3);
  assert.equal(next.alert, true, '第 3 次正常 tick 仍触发提示');

  // 不破坏既有公开语义：present/recovered 与 uncertain 的 lastReason 仍按原契约。
  const recovered = recordToolSurfaceObservation(next.state, { observedNames: [...FULL], at: T0 + 3 * INTERVAL, source: 'scheduled' });
  assert.equal(recovered.state.lastReason, 'recovered');
  const ok = recordToolSurfaceObservation(createToolSurfaceState(), { observedNames: [...FULL], at: T0, source: 'scheduled' });
  assert.equal(ok.state.lastReason, 'ok');
  const uncertain = recordToolSurfaceObservation(state, { observedNames: null, at: T0 + 2 * INTERVAL, source: 'scheduled' });
  assert.equal(uncertain.state.lastReason, 'no-observation');
});
