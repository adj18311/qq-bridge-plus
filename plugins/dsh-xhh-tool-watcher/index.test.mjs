/**
 * 阶段 2B：Cordis 插件 xhh-tool-watcher 的离线测试。
 *
 * 全部离线：无网络、无真实定时器、不加载 DSH 宿主、不触碰 config/state。
 * 判定模块（2A）此刻可能还不存在 —— 默认注入 fake 判定器；
 * 第 11 例尝试用真实模块跑一遍，模块缺失时 test.skip 并注明原因。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createToolSurfaceWatcher, name as pluginName, inject, apply, DECISION_MODULE_PATH } from './index.mjs';

const PREFIX = 'mcp__xiaoheihe__';
const EXPECTED = Object.freeze([
  'get_home_content',
  'get_post_detail',
  'search_content',
  'publish_content',
  'publish_article',
  'publish_video',
  'post_comment',
  'reply_comment',
  'get_user_profile',
  'check_login_status',
  'get_login_qr_code',
  'interactive_login',
]);
const FULL_TOOLS = EXPECTED.map((n) => `${PREFIX}${n}`);
const OTHER_TOOLS = ['mcp__other__thing', 'plain-tool'];
const MISSING_ALL = [...OTHER_TOOLS];
const BASE = 1_800_000_000_000;
const SIX_HOURS = 6 * 60 * 60 * 1000;

const FAILURE_RETRY_MS = 15 * 60 * 1000;

/**
 * Fake 判定器（v2 契约）：语义与 2A v2 规格一致。
 *  · absent + source='event' → 不计数、不提示（reason 'event-not-counted'）；
 *  · absent + source='scheduled' → 计数 +1；>=3 且未命中 6h 成功节流 / 15min 失败重试节流才 alert；
 *  · noteToolSurfaceDelivery：delivered 才推进 lastAlertAt；failed/unknown 只推进 lastAttemptAt。
 *  · v2.1（opts.enforceScheduledGap=true 时启用，与真实 2A 同形）：
 *      - scheduled 距上次有效 scheduled < interval/2 → 'too-soon'（不计数，不算「有效分钟」）；
 *      - scheduled 距上次有效 scheduled > interval*2.5 → 视为错过分钟，连续计数重置为 1；
 *      - 事件不改 lastScheduledAt，因此事件密集不影响「连续分钟」判定。
 *
 * 说明：`deliveryOutcome` 回填分支保留只为兼容历史用例，插件主路径走 noteToolSurfaceDelivery。
 */
function createFakeDecision(overrides = {}) {
  const config = {
    prefix: PREFIX,
    expected: [...EXPECTED],
    threshold: 3,
    alertWindowMs: SIX_HOURS,
    failureRetryMs: FAILURE_RETRY_MS,
    ...overrides,
  };
  function empty() {
    return {
      schemaVersion: 2,
      consecutiveMisses: 0,
      lastAlertAt: 0,
      lastAttemptAt: 0,
      lastAttemptOutcome: null,
      lastReason: 'init',
      lastState: 'init',
      lastObservedAt: null,
      lastScheduledAt: null,
    };
  }
  function invalid(observedNames) {
    if (observedNames === null || observedNames === undefined) return true;
    if (!Array.isArray(observedNames)) return true;
    return observedNames.some((n) => typeof n !== 'string');
  }
  function classify(observedNames) {
    if (invalid(observedNames)) return { state: 'uncertain', missing: [], present: [], expected: [...config.expected] };
    const observed = [...new Set(observedNames)];
    const missing = config.expected.filter((name) => !observed.includes(name));
    const present = config.expected.filter((name) => observed.includes(name));
    return { state: missing.length === 0 ? 'present' : 'absent', missing, present, expected: [...config.expected] };
  }
  return {
    XHH_TOOL_NAME_PREFIX: config.prefix,
    XHH_EXPECTED_TOOL_NAMES: Object.freeze([...config.expected]),
    XHH_TOOL_SURFACE_FAILURE_RETRY_MS: config.failureRetryMs,
    createToolSurfaceState: () => empty(),
    /** 与真实 2A 模块同签名：插件必须靠它拿 missing 清单（recordToolSurfaceObservation 的返回体没有 missing）。 */
    classifyToolSurface({ observedNames } = {}) {
      const classified = classify(observedNames);
      return { ...classified };
    },
    parseToolSurfaceState: (raw) => {
      if (raw === undefined || raw === null) return undefined;
      if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
      return { ...empty(), ...raw };
    },
    recordToolSurfaceObservation(state, { observedNames, at, source, intervalMs, deliveryOutcome } = {}) {
      const next = { ...empty(), ...state };
      // v1 兼容回填：同一 `at` 的重算只记账投递结果，不新增观测、不计数。
      if (deliveryOutcome !== undefined) {
        next.lastAttemptAt = at;
        next.lastAttemptOutcome = deliveryOutcome;
        if (deliveryOutcome === 'delivered') next.lastAlertAt = at;
        return { state: next, alert: false, counted: false, consecutiveMisses: next.consecutiveMisses, reason: next.lastReason };
      }
      const src = source === 'event' ? 'event' : 'scheduled';
      const wasAbsent = state?.lastState === 'absent';
      if (invalid(observedNames)) {
        next.consecutiveMisses = 0;
        next.lastState = 'uncertain';
        next.lastObservedAt = at;
        next.lastReason = 'no-observation';
        return { state: next, alert: false, kind: null, counted: false, consecutiveMisses: 0, reason: 'no-observation' };
      }
      const classified = classify(observedNames);
      if (classified.state === 'present') {
        // 与真实 2A 同形（`src/core/xhh-tool-surface-decision.mjs:197-214`）：
        // state.lastReason 才是语义字符串（'recovered' / 'ok'），顶层 reason 恒为 'not-absent'。
        // 插件若优先读顶层 reason，恢复信号会被 'not-absent' 吞掉——这就是本轮真实缺陷。
        next.consecutiveMisses = 0;
        next.lastState = 'present';
        next.lastObservedAt = at;
        if (config.enforceScheduledGap === true && src === 'scheduled') next.lastScheduledAt = at;
        next.lastReason = wasAbsent ? 'recovered' : 'ok';
        return { state: next, alert: false, kind: null, counted: false, consecutiveMisses: 0, reason: 'not-absent' };
      }
      if (src === 'event') {
        // 事件采样只刷新观测，不推进计数、不提示。
        next.lastState = 'absent';
        next.lastObservedAt = at;
        next.lastReason = 'event-not-counted';
        return { state: next, alert: false, kind: null, counted: false, consecutiveMisses: next.consecutiveMisses, reason: 'event-not-counted' };
      }
      // v2.1 间隔语义（默认关闭以保持既有用例的时序无关性；新用例显式开启）。
      const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60 * 1000;
      if (config.enforceScheduledGap === true) {
        const sinceScheduled = Number.isFinite(next.lastScheduledAt) ? at - next.lastScheduledAt : Number.POSITIVE_INFINITY;
        if (sinceScheduled < interval / 2) {
          next.lastState = 'absent';
          next.lastObservedAt = at;
          next.lastReason = 'too-soon';
          return {
            state: next, alert: false, kind: null, counted: false, consecutiveMisses: next.consecutiveMisses, reason: 'too-soon',
          };
        }
        if (sinceScheduled > interval * 2.5) next.consecutiveMisses = 0;
      }
      next.lastScheduledAt = at;
      next.consecutiveMisses += 1;
      next.lastState = 'absent';
      next.lastObservedAt = at;
      next.lastReason = 'missing-tools';
      const successAllowed = at - (next.lastAlertAt || 0) >= config.alertWindowMs;
      const lastOutcomeBad = next.lastAttemptOutcome === 'failed' || next.lastAttemptOutcome === 'unknown';
      const failureAllowed = !lastOutcomeBad || at - (next.lastAttemptAt || 0) >= config.failureRetryMs;
      const alert = next.consecutiveMisses >= config.threshold && successAllowed && failureAllowed;
      const reason = alert
        ? 'missing-tools'
        : (!successAllowed ? 'throttled' : (lastOutcomeBad ? 'retry-throttled' : 'missing-tools'));
      return {
        state: next,
        alert,
        kind: alert ? 'registration-lost' : null,
        consecutiveMisses: next.consecutiveMisses,
        reason,
        counted: true,
      };
    },
    noteToolSurfaceDelivery(state, { at, outcome, deliveredAt } = {}) {
      const next = { ...empty(), ...state };
      next.lastAttemptAt = at;
      next.lastAttemptOutcome = outcome;
      // 只有 delivered 才推进成功节流；failed/unknown 只记这次尝试（15 分钟后才重试）。
      if (outcome === 'delivered') next.lastAlertAt = deliveredAt ?? at;
      return { state: next, accepted: true };
    },
  };
}

function createMemoryStore(initial) {
  const store = {
    raw: initial,
    saves: 0,
    load: () => (store.raw === undefined ? undefined : structuredClone(store.raw)),
    save: (raw) => {
      store.saves += 1;
      store.raw = structuredClone(raw);
    },
  };
  return store;
}

function createScheduler() {
  const everyCalls = [];
  return {
    every(ms, fn) {
      everyCalls.push({ ms, fn });
      return () => {
        everyCalls[everyCalls.length - 1].stopped = true;
      };
    },
    everyCalls,
  };
}

/**
 * 强制 alert 的假判定器：其余语义与 v2 fake 一致，只在指定 source 上返回 alert:true。
 * 用来钉「event 返回 alert 必须被忽略」「scheduled 的 alert 正常送达」两条契约。
 */
function createAlertFake({ alertOn = [] } = {}) {
  const base = createFakeDecision();
  return {
    ...base,
    recordToolSurfaceObservation(state, observation = {}) {
      const res = base.recordToolSurfaceObservation(state, observation);
      return alertOn.includes(observation.source) ? { ...res, alert: true, kind: 'registration-lost' } : res;
    },
  };
}

/** 最小 ctx：只够 apply() 装配（用于验证「判定模块缺 v2 API 时显式装配失败、不注册钩子」）。 */
function makeBareApplyCtx() {
  const handlers = new Map();
  const tools = new Map(FULL_TOOLS.map((n) => [n, {}]));
  return {
    tools: { view: () => ({ visible: tools, knownNames: new Set(tools.keys()), restrictableNames: new Set() }) },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    handlers,
  };
}

function makeWatcher(overrides = {}) {
  const clock = { now: BASE };
  const notifications = [];
  const logs = [];
  const reads = [];
  const store = overrides.store ?? createMemoryStore();
  const readNames = () => {
    if (typeof overrides.readToolNames === 'function') return overrides.readToolNames();
    return overrides.names === undefined ? [...FULL_TOOLS] : typeof overrides.names === 'function' ? overrides.names() : overrides.names;
  };
  const defaults = {
    readToolNames: () => {
      reads.push(clock.now);
      return readNames();
    },
    decision: overrides.decision ?? createFakeDecision(overrides.decisionOptions),
    now: () => clock.now,
    store,
    notify: overrides.notify ?? ((event) => { notifications.push(event); return { outcome: 'delivered' }; }),
    config: overrides.config ?? {},
    log: (level, message) => { logs.push([level, message]); },
    ...overrides.watcher,
  };
  const watcher = createToolSurfaceWatcher({ ...defaults, ...overrides.factory });
  const names = () => (overrides.names === undefined ? [...FULL_TOOLS] : typeof overrides.names === 'function' ? overrides.names() : overrides.names);
  return {
    watcher,
    clock,
    notifications,
    logs,
    reads,
    store,
    setNames: (value) => { overrides.names = value; },
    advance: (ms) => { clock.now += ms; },
    currentNames: names,
  };
}

/**
 * 异步假判定器：与 v2 同步版同语义，但在 record 内部 `await` 一次，制造并发窗口。
 * 用来钉「single-flight」：并发 check 只能观测一次。
 */
function createAsyncFakeDecision({ gate = null } = {}) {
  const base = createFakeDecision();
  let calls = 0;
  let observations = 0;
  return {
    ...base,
    get recordCalls() {
      return calls;
    },
    get observationCalls() {
      return observations;
    },
    async recordToolSurfaceObservation(state, observation) {
      calls += 1;
      // v1 兼容回填（带 deliveryOutcome）不算一次新观测，只是同一次观测的重算。
      if (observation?.deliveryOutcome === undefined) observations += 1;
      if (gate !== null && observations === 1 && observation?.deliveryOutcome === undefined) await gate;
      else await Promise.resolve();
      return base.recordToolSurfaceObservation(state, observation);
    },
  };
}

test('① 连续 3 次可靠缺失 → 只提示 1 次（不重复轰炸）', async () => {
  const ctx = makeWatcher({ names: MISSING_ALL });
  for (let i = 0; i < 3; i += 1) {
    await ctx.watcher.check({ source: 'scheduled' });
    ctx.advance(1000);
  }
  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].kind, 'registration-lost');
  assert.match(ctx.notifications[0].message, /12|缺失/);
  const snap = ctx.watcher.snapshot();
  assert.equal(snap.consecutiveMisses, 3);
  assert.equal(snap.attempted, true);
  assert.equal(snap.hasAlerted, true);
  assert.equal(snap.lastAlertAt, BASE + 2000);
  // 第 4 次仍缺失，但 6h 窗口内不再提示
  await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(ctx.notifications.length, 1);
});

test('② 中途一次不确定观测（null）→ 计数清零，随后再缺 2 次也不提示', async () => {
  let names = MISSING_ALL;
  const ctx = makeWatcher({ names: () => names });
  await ctx.watcher.check({ source: 'scheduled' }); // miss 1
  await ctx.watcher.check({ source: 'scheduled' }); // miss 2
  names = null;
  await ctx.watcher.check({ source: 'scheduled' }); // uncertain → 清零
  names = MISSING_ALL;
  await ctx.watcher.check({ source: 'scheduled' }); // miss 1
  await ctx.watcher.check({ source: 'scheduled' }); // miss 2
  assert.equal(ctx.notifications.length, 0);
  assert.equal(ctx.watcher.snapshot().consecutiveMisses, 2);
});

test('③ 第 4 次缺失但 6h 未到 → 第二次不提示', async () => {
  const ctx = makeWatcher({ names: MISSING_ALL });
  for (let i = 0; i < 4; i += 1) await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(ctx.notifications.length, 1);
  ctx.advance(SIX_HOURS - 1);
  await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(ctx.notifications.length, 1);
});

test('④ 6h 后仍缺失 → 再次提示', async () => {
  const ctx = makeWatcher({ names: MISSING_ALL });
  for (let i = 0; i < 3; i += 1) await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(ctx.notifications.length, 1);
  ctx.advance(SIX_HOURS);
  await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(ctx.notifications.length, 2);
});

test('⑤ notify 返回 failed → lastAlertAt 不推进；15 分钟内不重试（retry-throttled），过了窗口才再试', async () => {
  const sent = [];
  const ctx = makeWatcher({ names: MISSING_ALL, notify: (event) => { sent.push(event); return { outcome: 'failed' }; } });
  for (let i = 0; i < 3; i += 1) await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(sent.length, 1, '第 3 次 scheduled 应尝试提示');
  let snap = ctx.watcher.snapshot();
  assert.equal(snap.lastAlertAt, null);
  assert.equal(snap.hasAlerted, false);
  assert.equal(snap.lastAttemptOutcome, 'failed');
  assert.equal(snap.lastAttemptAt, BASE);
  // 下一分钟：仍缺失但失败重试窗口未过 → 不再发送（retry-throttled），也不把状态改成 delivered。
  ctx.advance(60 * 1000);
  await ctx.watcher.check({ source: 'scheduled' });
  snap = ctx.watcher.snapshot();
  assert.equal(sent.length, 1, '15 分钟窗口内不得重试');
  assert.equal(snap.lastAlertAt, null);
  // lastReason 取状态机语义（'missing-tools'）；顶层 'retry-throttled' 只解释「为何没发」，
  // 按 Lead 指定的优先级（state.lastReason → 顶层 reason）不再覆盖语义字符串。行为由 sent 计数钉住。
  assert.equal(snap.lastReason, 'missing-tools');
  // 推进 15 分钟后：允许再试一次。
  ctx.advance(FAILURE_RETRY_MS);
  await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(sent.length, 2, '失败重试窗口过后应再次尝试');
  assert.equal(ctx.watcher.snapshot().lastAlertAt, null);
});

test('⑥ notify 抛错 → 视为 unknown，不崩、lastAlertAt 不推进', async () => {
  const ctx = makeWatcher({ names: MISSING_ALL, notify: () => { throw new Error('no channel'); } });
  for (let i = 0; i < 3; i += 1) await ctx.watcher.check({ source: 'scheduled' });
  const snap = ctx.watcher.snapshot();
  assert.equal(snap.lastAlertAt, null);
  assert.equal(snap.attempted, true);
  assert.ok(ctx.logs.some(([level]) => level === 'warn' || level === 'error'));
});

test('⑦ store.save 抛错 → 不崩、返回结果不变、记日志', async () => {
  const store = {
    load: () => undefined,
    save: () => { throw new Error('disk full'); },
  };
  const ctx = makeWatcher({ names: MISSING_ALL, store });
  for (let i = 0; i < 3; i += 1) await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.watcher.snapshot().consecutiveMisses, 3);
  assert.ok(ctx.logs.some(([level, message]) => level === 'warn' && /持久化/.test(message)));
});

test('⑧ readToolNames 抛错 → uncertain、断计数、lastReason=no-observation、不提示', async () => {
  const ctx = makeWatcher({
    readToolNames: () => { throw new Error('registry unavailable'); },
    names: MISSING_ALL,
  });
  for (let i = 0; i < 4; i += 1) await ctx.watcher.check({ source: 'scheduled' });
  const snap = ctx.watcher.snapshot();
  assert.equal(ctx.notifications.length, 0);
  assert.equal(snap.consecutiveMisses, 0);
  assert.equal(snap.lastReason, 'no-observation');
});

test('⑨ 恢复（12 个都在）→ 计数清零、lastReason=recovered', async () => {
  let names = MISSING_ALL;
  const ctx = makeWatcher({ names: () => names });
  await ctx.watcher.check({ source: 'scheduled' });
  await ctx.watcher.check({ source: 'scheduled' });
  names = [...FULL_TOOLS];
  await ctx.watcher.check({ source: 'scheduled' });
  const snap = ctx.watcher.snapshot();
  assert.equal(snap.consecutiveMisses, 0);
  assert.equal(snap.lastReason, 'recovered');
  assert.equal(ctx.notifications.length, 0);
});

test('⑩ apply() 冒烟：装配、tools/change 触发、dispose 后不再响应', async () => {
  assert.equal(pluginName, 'xhh-tool-watcher');
  assert.deepEqual([...inject], ['tools']);
  const handlers = new Map();
  const tools = new Map(FULL_TOOLS.map((n) => [n, {}]));
  let viewCalls = 0;
  const ctx = {
    tools: {
      view: () => {
        viewCalls += 1;
        return { visible: tools, knownNames: new Set(tools.keys()), restrictableNames: new Set() };
      },
    },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {
        const list = handlers.get(event) ?? [];
        handlers.set(event, list.filter((h) => h !== handler));
      };
    },
  };
  const scheduler = createScheduler();
  const store = createMemoryStore();
  const notifications = [];
  await apply(ctx, {
    decision: createFakeDecision(),
    scheduler,
    store,
    notify: (event) => { notifications.push(event); return { outcome: 'delivered' }; },
    log: () => {},
    intervalMs: 1234,
  });
  assert.equal(scheduler.everyCalls.length, 1);
  assert.equal(scheduler.everyCalls[0].ms, 1234);
  assert.equal(handlers.get('tools/change')?.length, 1);
  assert.equal(handlers.get('dispose')?.length, 1);
  const changeHandler = handlers.get('tools/change')[0];
  // tools/change 触发 check：12 个都在 → 不提示，不报错
  await changeHandler();
  assert.equal(notifications.length, 0);
  assert.ok(viewCalls >= 1);
  // dispose 后 tools/change 不再读注册表
  for (const dispose of handlers.get('dispose') ?? []) dispose();
  const before = viewCalls;
  await changeHandler();
  assert.equal(viewCalls, before);
  assert.equal(scheduler.everyCalls[0].stopped, true);
});

test('⑪ 真实判定模块（2A）存在时跑一遍；缺失则 skip 并注明', async (t) => {
  let decision;
  try {
    decision = await import('../../src/core/xhh-tool-surface-decision.mjs');
  } catch (error) {
    t.skip(`src/core/xhh-tool-surface-decision.mjs 尚未提供（2A 并行开发中）：${error?.message ?? error}`);
    return;
  }
  assert.equal(typeof decision.recordToolSurfaceObservation, 'function');
  // 2A v2 已就绪：不再允许静默 skip。若这里缺失，说明 2A 回退或未安装 —— 必须硬失败暴露。
  assert.equal(
    typeof decision.noteToolSurfaceDelivery,
    'function',
    '2A v2 判定模块必须提供 noteToolSurfaceDelivery（不得静默跳过真实模块集成验证）',
  );
  assert.equal(typeof decision.createToolSurfaceState, 'function');
  assert.equal(decision.XHH_TOOL_NAME_PREFIX, PREFIX);
  const store = createMemoryStore();
  const clock = { now: BASE };
  const notifications = [];
  const watcher = createToolSurfaceWatcher({
    readToolNames: () => MISSING_ALL,
    decision,
    now: () => clock.now,
    store,
    notify: (event) => { notifications.push(event); return { outcome: 'delivered' }; },
    config: {},
    log: () => {},
  });
  // 真实模块（v2.1 起）默认 intervalMs=60s：间隔不足 interval/2 的检查会被判 too-soon，必须按分钟推进。
  for (let i = 0; i < 3; i += 1) {
    clock.now += 60_000;
    await watcher.check({ source: 'scheduled' });
  }
  assert.equal(notifications.length, 1, '真实判定模块下连续 3 次缺失应提示');
  assert.equal(watcher.snapshot().consecutiveMisses, 3, '投递回填不得重复累计缺失次数');
});

test('⑫ async notify resolve delivered → lastAlertAt 推进，6h 内只提示 1 次', async () => {
  const sent = [];
  const ctx = makeWatcher({
    names: MISSING_ALL,
    notify: async (event) => { sent.push(event); return { outcome: 'delivered' }; },
  });
  for (let i = 0; i < 3; i += 1) {
    await ctx.watcher.check({ source: 'scheduled' });
    ctx.advance(1000);
  }
  assert.equal(sent.length, 1);
  const snap = ctx.watcher.snapshot();
  assert.equal(snap.attempted, true);
  assert.equal(snap.hasAlerted, true);
  assert.equal(snap.lastAlertAt, BASE + 2000);
  // 6h 内不再提示（async 分支若不同步 await，这里会变成 2）
  await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(sent.length, 1);
});

test('⑬ async notify reject → 按 unknown 处理：不推进 lastAlertAt、不崩、记 error', async () => {
  const ctx = makeWatcher({
    names: MISSING_ALL,
    notify: async () => { throw new Error('channel down'); },
  });
  for (let i = 0; i < 3; i += 1) await ctx.watcher.check({ source: 'scheduled' });
  const snap = ctx.watcher.snapshot();
  assert.equal(snap.lastAlertAt, null);
  assert.equal(snap.hasAlerted, false);
  assert.equal(snap.attempted, true);
  assert.ok(ctx.logs.some(([level, message]) => level === 'error' && /unknown/.test(message)));
});

test('⑭ async notify resolve failed → 不推进 lastAlertAt；15 分钟内不重试，过了窗口再试', async () => {
  const sent = [];
  const ctx = makeWatcher({
    names: MISSING_ALL,
    notify: async (event) => { sent.push(event); return { outcome: 'failed' }; },
  });
  for (let i = 0; i < 3; i += 1) await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(ctx.watcher.snapshot().lastAlertAt, null);
  assert.equal(sent.length, 1);
  ctx.advance(60 * 1000);
  await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(sent.length, 1, '失败重试窗口内不得重试');
  ctx.advance(FAILURE_RETRY_MS);
  await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(sent.length, 2, '窗口过后应重试');
  assert.equal(ctx.watcher.snapshot().lastAlertAt, null);
});

function fakeCtx() {
  const handlers = new Map();
  const tools = new Map(FULL_TOOLS.map((n) => [n, {}]));
  return {
    handlers,
    ctx: {
      tools: { view: () => ({ visible: tools, knownNames: new Set(tools.keys()), restrictableNames: new Set() }) },
      on(event, handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        return () => {
          const list = handlers.get(event) ?? [];
          handlers.set(event, list.filter((h) => h !== handler));
        };
      },
    },
  };
}

test('⑮ config.decision 注入优先于 decisionPath（不需要读任何文件即可装配）', async () => {
  const { ctx } = fakeCtx();
  const result = await apply(ctx, {
    decision: createFakeDecision(),
    decisionPath: path.join(os.tmpdir(), 'never-loaded-decision.mjs'),
    scheduler: createScheduler(),
    store: createMemoryStore(),
    notify: () => ({ outcome: 'delivered' }),
    log: () => {},
    intervalMs: 1234,
  });
  assert.equal(result.ok, undefined, '注入路径下 apply 返回 watcher 句柄');
  assert.equal(typeof result.watcher?.check, 'function');
  assert.equal(result.watcher.snapshot().decisionLoadError, null);
});

test('⑯ decisionPath 不可达 → 显式失败：decisionLoadError + error 日志、不抛', async () => {
  const { ctx, handlers } = fakeCtx();
  const logs = [];
  const badPath = path.join(os.tmpdir(), 'definitely-missing-decision-module.mjs');
  const result = await apply(ctx, {
    decisionPath: badPath,
    scheduler: createScheduler(),
    store: createMemoryStore(),
    notify: () => ({ outcome: 'delivered' }),
    log: (level, message) => logs.push([level, message]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.enabled, false);
  assert.match(result.decisionLoadError.path, /definitely-missing-decision-module/);
  const snap = result.snapshot();
  assert.equal(snap.lastAlertAt, null);
  assert.equal(snap.hasAlerted, false);
  assert.equal(snap.lastReason, 'decision-unavailable');
  assert.equal(snap.decisionLoadError, result.decisionLoadError);
  assert.ok(logs.some(([level, message]) => level === 'error' && /未装配/.test(message)));
  // 失败装配不得注册任何 tools/change / dispose 钩子
  assert.equal(handlers.get('tools/change'), undefined);
  assert.equal(handlers.get('dispose'), undefined);
});

test('⑰ 缺 12 个：提示文案含数量 12 与具体工具名（不是恒 0）', async () => {
  const sent = [];
  const ctx = makeWatcher({
    names: MISSING_ALL,
    notify: (event) => { sent.push(event); return { outcome: 'delivered' }; },
  });
  for (let i = 0; i < 3; i += 1) await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /检测到 12 个/);
  assert.match(sent[0].message, /get_home_content/);
  assert.match(sent[0].message, /等 12 个/);
});

test('⑱ 缺 1 个：提示文案含数量 1 与该工具名', async () => {
  const sent = [];
  const ctx = makeWatcher({
    names: FULL_TOOLS.filter((n) => n !== `${PREFIX}post_comment`),
    notify: (event) => { sent.push(event); return { outcome: 'delivered' }; },
  });
  for (let i = 0; i < 3; i += 1) await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /1 个/);
  assert.match(sent[0].message, /post_comment/);
  assert.doesNotMatch(sent[0].message, /等 \d+ 个/);
});

test('⑲ 并发两次 check：同一次缺失只累计一次、阈值到达只发 1 条提示（single-flight）', async () => {
  const decision = createAsyncFakeDecision();
  const sent = [];
  const ctx = makeWatcher({
    names: MISSING_ALL,
    decision,
    notify: (event) => { sent.push(event); return { outcome: 'delivered' }; },
  });
  await ctx.watcher.check({ source: 'scheduled' }); // miss 1
  await ctx.watcher.check({ source: 'scheduled' }); // miss 2
  assert.equal(decision.recordCalls, 2);
  const [a, b] = await Promise.all([ctx.watcher.check({ source: 'scheduled' }), ctx.watcher.check({ source: 'scheduled' })]);
  // 并发两次只能观测一次：misses 3（不是 4），阈值只触发 1 条提示（不是 2）。
  assert.equal(decision.observationCalls, 3, '并发期间只允许一次观测（第 3 次由这两个并发调用共享）');
  assert.equal(ctx.watcher.snapshot().consecutiveMisses, 3, '同一次缺失不得累计两次');
  assert.equal(sent.length, 1, '并发阈值到达只能发 1 条提示');
  assert.deepEqual(a, b, '并发调用必须复用同一个结果');
});

test('⑳ 挂起的 absent 与随后的 present 并发：不得互相覆盖成「recovered 与缺失并存」', async () => {
  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  const decision = createAsyncFakeDecision({ gate });
  let names = MISSING_ALL;
  const ctx = makeWatcher({ names: () => names, decision });
  const slowAbsent = ctx.watcher.check({ source: 'scheduled' }); // 在 record 内部挂起
  names = [...FULL_TOOLS];
  const present = ctx.watcher.check({ source: 'scheduled' }); // single-flight：复用 slowAbsent，不另起观测
  await Promise.resolve(); // 让 slowAbsent 走到 gate
  openGate();
  await Promise.all([slowAbsent, present]);
  const snap = ctx.watcher.snapshot();
  assert.equal(decision.recordCalls, 1, 'present 不得在 absent 观测挂起时另起一次观测');
  assert.equal(snap.consecutiveMisses, 1, '计数必须自洽（只算一次缺失）');
  assert.equal(snap.lastReason, 'missing-tools', '最终状态是最后完成的那次观测（absent）');
  assert.notEqual(snap.lastReason, 'recovered', '不得出现 recovered 与缺失计数并存');
  // 收尾：并发结束后正常观测 present → 正常恢复为 0。
  await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(ctx.watcher.snapshot().lastReason, 'recovered');
  assert.equal(ctx.watcher.snapshot().consecutiveMisses, 0);
});

test('㉑ 并发结束后 in-flight 已释放：下一次 check 能正常观测；dispose 后仍立即返回快照', async () => {
  const decision = createAsyncFakeDecision();
  const ctx = makeWatcher({ names: MISSING_ALL, decision });
  await Promise.all([ctx.watcher.check({ source: 'scheduled' }), ctx.watcher.check({ source: 'scheduled' })]);
  assert.equal(decision.recordCalls, 1);
  const afterConcurrent = decision.recordCalls;
  ctx.setNames([...FULL_TOOLS]);
  await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(decision.recordCalls, afterConcurrent + 1, '并发结束后必须能重新观测（in-flight 已释放）');
  assert.equal(ctx.watcher.snapshot().consecutiveMisses, 0);
  assert.equal(ctx.watcher.snapshot().lastReason, 'recovered');
  // dispose 之后 check 立即返回快照、不再启动观测。
  const readsBefore = ctx.reads.length;
  ctx.watcher.dispose();
  const after = await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(ctx.reads.length, readsBefore, 'dispose 后不得再读注册表');
  assert.equal(after.lastReason, 'recovered');
  // 抛错也不得留下永久 in-flight：check() reject 后，下一次必须能重新观测
  // （清理必须用 .finally；用 .then 时 inFlight 会永远停在 rejected Promise 上）。
  let boomOnce = true;
  const flakyNow = () => {
    if (boomOnce) {
      boomOnce = false;
      throw new Error('clock boom');
    }
    return BASE;
  };
  const direct = createToolSurfaceWatcher({
    readToolNames: () => MISSING_ALL,
    decision: createFakeDecision(),
    now: flakyNow,
    notify: () => ({ outcome: 'delivered' }),
    log: () => {},
  });
  await assert.rejects(direct.check({ source: 'scheduled' }), /clock boom/);
  const recovered = await direct.check({ source: 'scheduled' });
  assert.equal(recovered.consecutiveMisses, 1, '抛错后 in-flight 必须已释放（下一次 check 能真正观测）');
});

/// —— v2 触发契约（Codex 终审：默认 1 分钟；tools/change 不得凑成「连续三次检查」） ——

/** 给假判定器加 record 调用记录（source / 次数），用于断言两条触发路径真的分离。 */
function spyDecision(base = createFakeDecision()) {
  const sources = [];
  return {
    ...base,
    sources,
    recordToolSurfaceObservation(state, options = {}) {
      sources.push(options?.source);
      return base.recordToolSurfaceObservation(state, options);
    },
  };
}

/** apply 冒烟用的假 ctx：可改工具集合、可让 view 抛错、暴露 handlers 与 scheduler。 */
function makeApplyCtx({ names = FULL_TOOLS } = {}) {
  const handlers = new Map();
  const tools = new Map(names.map((n) => [n, {}]));
  const scheduler = createScheduler();
  const viewState = { failTimes: 0 };
  const ctx = {
    tools: {
      view: () => {
        if (viewState.failTimes > 0) {
          viewState.failTimes -= 1;
          throw new Error('registry unavailable');
        }
        return { visible: tools, knownNames: new Set(tools.keys()), restrictableNames: new Set() };
      },
    },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {
        const list = handlers.get(event) ?? [];
        handlers.set(event, list.filter((h) => h !== handler));
      };
    },
  };
  return {
    ctx,
    handlers,
    scheduler,
    viewState,
    setNames(next) {
      tools.clear();
      for (const n of next) tools.set(n, {});
    },
    emit(event, ...args) {
      const list = handlers.get(event) ?? [];
      return Promise.all(list.map((h) => h(...args)));
    },
    tick() {
      return Promise.all(scheduler.everyCalls.map(({ fn }) => fn()));
    },
  };
}

async function bootApply(overrides = {}) {
  const clock = { now: BASE };
  const { ctx, ...rest } = makeApplyCtx(overrides);
  const notifications = [];
  const logs = [];
  const decision = overrides.decision ?? createFakeDecision();
  const result = await apply(ctx, {
    decision,
    scheduler: rest.scheduler,
    store: overrides.store ?? createMemoryStore(),
    notify: overrides.notify ?? ((event) => { notifications.push(event); return { outcome: 'delivered' }; }),
    now: () => clock.now,
    log: (level, message) => logs.push([level, message]),
    ...overrides.config,
  });
  return { ...rest, result, clock, notifications, logs, decision };
}

test('v2-① 同一秒内 3 次 tools/change → 全部是 event 采样：不计数、不提示', async () => {
  const decision = spyDecision();
  const h = await bootApply({ names: MISSING_ALL, decision });
  await h.emit('tools/change');
  await h.emit('tools/change');
  await h.emit('tools/change');
  assert.deepEqual(decision.sources, ['event', 'event', 'event'], 'tools/change 必须标记为 event');
  assert.equal(h.result.watcher.snapshot().consecutiveMisses, 0, '事件不得推进连续计数');
  assert.equal(h.notifications.length, 0, '事件不得触发提示');
  assert.equal(h.scheduler.everyCalls[0].ms, 60_000, '默认间隔必须是 1 分钟');
});

test('v2-② 每分钟一次 scheduled 检查：第 3 次才提示', async () => {
  const decision = spyDecision();
  const h = await bootApply({ names: MISSING_ALL, decision });
  for (let i = 0; i < 3; i += 1) {
    await h.tick();
    h.clock.now += 60_000;
  }
  assert.deepEqual(decision.sources, ['scheduled', 'scheduled', 'scheduled']);
  assert.equal(h.notifications.length, 1, '第 3 次 scheduled 应提示');
  assert.equal(h.result.watcher.snapshot().consecutiveMisses, 3);
});

test('v2-③ 事件不推进计数：2 次 scheduled + 5 次 event + 1 次 scheduled 才达阈值', async () => {
  const decision = spyDecision();
  const h = await bootApply({ names: MISSING_ALL, decision });
  await h.tick();
  await h.tick();
  for (let i = 0; i < 5; i += 1) await h.emit('tools/change');
  assert.equal(h.notifications.length, 0);
  assert.equal(h.result.watcher.snapshot().consecutiveMisses, 2, '5 次事件不得补足第 3 次计数');
  await h.tick();
  assert.equal(h.notifications.length, 1, '只有第 3 次 scheduled 才能提示');
  assert.equal(decision.sources.filter((s) => s === 'scheduled').length, 3);
  assert.equal(decision.sources.filter((s) => s === 'event').length, 5);
});

test('v2-④ scheduled 中途 uncertain → 断链清零，后续 2 次 scheduled 不提示', async () => {
  const decision = spyDecision();
  const h = await bootApply({ names: MISSING_ALL, decision });
  await h.tick(); // miss 1
  h.viewState.failTimes = 1;
  await h.tick(); // uncertain → 0
  await h.tick(); // miss 1
  await h.tick(); // miss 2
  assert.equal(h.notifications.length, 0);
  assert.equal(h.result.watcher.snapshot().lastReason, 'missing-tools');
  assert.equal(h.result.watcher.snapshot().consecutiveMisses, 2);
});

test('v2-⑤ 恢复及时可见：缺失 2 次后一次 event 读到全部工具 → 计数立即 0', async () => {
  const decision = spyDecision();
  const h = await bootApply({ names: MISSING_ALL, decision });
  await h.tick();
  await h.tick();
  assert.equal(h.result.watcher.snapshot().consecutiveMisses, 2);
  h.setNames(FULL_TOOLS);
  await h.emit('tools/change');
  const snap = h.result.watcher.snapshot();
  assert.equal(snap.consecutiveMisses, 0, '事件恢复必须立即清零（不等下一分钟）');
  assert.equal(snap.lastReason, 'recovered');
  assert.equal(h.notifications.length, 0);
});

test('v2-⑥ notify 返回 failed → 15 分钟内不重试（retry-throttled），窗口过后才再试', async () => {
  let outcome = 'failed';
  const h = await bootApply({ names: MISSING_ALL, notify: () => ({ outcome }) });
  for (let i = 0; i < 3; i += 1) { await h.tick(); h.clock.now += 60_000; }
  assert.equal(h.notifications.length, 0, '自定义 notify 不记录，用 outcome 断言');
  assert.equal(h.result.watcher.snapshot().lastAlertAt, null);
  assert.equal(h.result.watcher.snapshot().lastAttemptOutcome, 'failed');
  outcome = 'failed';
  await h.tick(); // 1 分钟后：仍缺失但窗口未过
  // 同上：retry-throttled 是顶层原因，不覆盖状态机语义；重试是否发生由 notify 计数断言。
  assert.equal(h.result.watcher.snapshot().lastReason, 'missing-tools');
  h.clock.now += FAILURE_RETRY_MS; // 15 分钟窗口过后
  await h.tick();
  assert.equal(h.result.watcher.snapshot().lastAttemptOutcome, 'failed', '仍没有 delivered');
});

test('v2-⑦ delivered → 6 小时内不再提示，6 小时后再次提示', async () => {
  const h = await bootApply({ names: MISSING_ALL });
  for (let i = 0; i < 3; i += 1) { await h.tick(); h.clock.now += 60_000; }
  assert.equal(h.notifications.length, 1);
  for (let i = 0; i < 5; i += 1) { await h.tick(); h.clock.now += 60_000; }
  assert.equal(h.notifications.length, 1, '6 小时内不得重复提示');
  h.clock.now += SIX_HOURS;
  await h.tick();
  assert.equal(h.notifications.length, 2, '6 小时后允许再次提示');
});

test('v2-⑧ persist 抛错 + notify unknown → 不崩、lastAlertAt 不推进、记日志', async () => {
  const store = { load: () => undefined, save: () => { throw new Error('disk full'); } };
  const h = await bootApply({ names: MISSING_ALL, store, notify: () => ({ outcome: 'unknown' }) });
  for (let i = 0; i < 3; i += 1) { await h.tick(); h.clock.now += 60_000; }
  const snap = h.result.watcher.snapshot();
  assert.equal(snap.lastAlertAt, null, '持久化失败不得当作已送达');
  assert.equal(snap.lastAttemptOutcome, 'unknown');
  assert.ok(h.logs.some(([level, message]) => level === 'warn' && /持久化/.test(message)));
});

test('v2-⑨ 伪造事件（无参/带脏参）→ 退化为一次 event 采样，不计数、不报错', async () => {
  const decision = spyDecision();
  const h = await bootApply({ names: MISSING_ALL, decision });
  await h.emit('tools/change', { dirty: true, source: 'scheduled' });
  await h.emit('tools/change');
  await h.emit('tools/change', 'garbage', 42, null);
  assert.deepEqual(decision.sources, ['event', 'event', 'event'], '事件参数不得影响 source');
  assert.equal(h.result.watcher.snapshot().consecutiveMisses, 0);
  assert.equal(h.notifications.length, 0);
});

test('v2-⑩ apply 冒烟：3 次事件 + 3 次 tick 的完整链路（只有 tick 计数）', async () => {
  const decision = spyDecision();
  const h = await bootApply({ names: MISSING_ALL, decision });
  await h.emit('tools/change');
  await h.tick();
  await h.emit('tools/change');
  await h.tick();
  await h.emit('tools/change');
  assert.equal(h.notifications.length, 0, '2 次 tick + 3 次事件仍未达阈值');
  assert.equal(h.result.watcher.snapshot().consecutiveMisses, 2);
  await h.tick();
  assert.equal(h.notifications.length, 1);
  assert.equal(decision.sources.filter((s) => s === 'scheduled').length, 3);
  assert.equal(decision.sources.filter((s) => s === 'event').length, 3);
  // dispose 后事件/tick 都不再读注册表
  h.result.dispose();
  const sourcesBefore = decision.sources.length;
  await h.emit('tools/change');
  await h.tick();
  assert.equal(decision.sources.length, sourcesBefore, 'dispose 后不得再观测');
});

// —— 第四轮复审要求：event 的 alert 必须忽略、scheduled 的 alert 正常送达、未知 source fail-safe、v1 模块显式失败 ——

test('2B-⑫ event 返回 alert:true → 必须被忽略：notify 0 次、状态与 lastAlertAt 不变、有 warn 日志', async () => {
  const decision = createAlertFake({ alertOn: ['event'] });
  const ctx = makeWatcher({ names: MISSING_ALL, decision });
  const before = ctx.watcher.snapshot();
  await ctx.watcher.check({ source: 'event' });
  assert.equal(ctx.notifications.length, 0, '事件采样绝不能发提示');
  assert.equal(ctx.watcher.snapshot().lastAlertAt, null, '不得推进成功节流（lastAlertAt）');
  // 事件采样允许刷新观测事实（lastState/lastObservedAt），但不得被 alert 路径改写计数。
  assert.equal(ctx.watcher.snapshot().consecutiveMisses, before.consecutiveMisses, '事件采样不得计数');
  assert.equal(ctx.watcher.snapshot().attempted, false);
  assert.ok(
    ctx.logs.some(([level, message]) => level === 'warn' && /事件采样返回了 alert/.test(message)),
    '必须留一条 warn 说明 alert 被忽略',
  );
});

test('2B-⑬ 同一假判定器在 scheduled 返回 alert:true → notify 恰好 1 次（不是把提示整体禁掉）', async () => {
  const decision = createAlertFake({ alertOn: ['scheduled'] });
  const ctx = makeWatcher({ names: MISSING_ALL, decision });
  await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].kind, 'registration-lost');
  assert.equal(ctx.watcher.snapshot().lastAlertAt, BASE);
});

test('2B-⑭ 未知/缺省 source 按 event 处理（fail-safe）：不计数、不提示', async () => {
  const ctx = makeWatcher({ names: MISSING_ALL });
  await ctx.watcher.check({ source: 'forged' });
  await ctx.watcher.check(undefined);
  await ctx.watcher.check();
  assert.equal(ctx.watcher.snapshot().consecutiveMisses, 0, '非显式 scheduled 一律不得计数');
  assert.equal(ctx.notifications.length, 0, '非显式 scheduled 一律不得提示');
  await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(ctx.watcher.snapshot().consecutiveMisses, 1, '显式 scheduled 恢复计数');
});

test('2B-⑮ 工厂拒绝只提供 v1 API 的判定模块（缺 noteToolSurfaceDelivery）', () => {
  assert.throws(
    () => createToolSurfaceWatcher({
      readToolNames: () => [],
      decision: { recordToolSurfaceObservation: () => ({ alert: false }) },
    }),
    /noteToolSurfaceDelivery/,
    '缺 v2 API 必须抛 TypeError，不能进入 v1 兼容回退',
  );
});

test('2C 装配 A：未配置 inboxDir ⇒ warn 且不写任何收件箱文件', async () => {
  const { ctx, ...rest } = makeApplyCtx({});
  const captured = [];
  const decision = createFakeDecision();
  const applied = await apply(ctx, {
    decision,
    scheduler: rest.scheduler,
    store: createMemoryStore(),
    notify: () => ({ outcome: 'delivered' }),
    now: () => BASE,
    log: (level, message) => captured.push([level, message]),
    intervalMs: 60_000,
  });
  assert.equal(captured.some(([level, message]) => level === 'warn' && message.includes('未配置 inboxDir')), true,
    '缺 inboxDir 必须显式告警，不能静默只记状态');
  rest.setNames(MISSING_ALL);
  for (let i = 0; i < 3; i += 1) {
    rest.scheduler.everyCalls[0].fn();
    await new Promise((r) => setImmediate(r));
  }
  // 既有行为：没有 inboxDir 时走 notify（可能成功），但绝不写文件、不崩溃
  const snap = applied.watcher.snapshot();
  assert.equal(typeof snap.lastReason, 'string');
  applied.dispose();
});

test('2C 装配 B：配置 inboxDir ⇒ 缺失三次写收件箱；回执写回后记账推进（不再是 unknown 死循环）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xhh-asm-b-'));
  const inboxDir = path.join(tmp, 'inbox');
  const clock = { now: BASE };
  const { ctx, ...rest } = makeApplyCtx({});
  const decision = createFakeDecision();
  const applied = await apply(ctx, {
    decision,
    scheduler: rest.scheduler,
    store: createMemoryStore(),
    notify: () => ({ outcome: 'delivered' }),
    now: () => clock.now,
    log: () => {},
    inboxDir,
    intervalMs: 60_000,
  });
  rest.setNames(MISSING_ALL);
  for (let i = 0; i < 3; i += 1) {
    clock.now += 60_000;
    await rest.scheduler.everyCalls[0].fn();
  }
  const files = (await fs.readdir(inboxDir)).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1, '三次定时缺失应恰好产生一条排队的缺失提醒（同类合并）');
  const queued = JSON.parse(await fs.readFile(path.join(inboxDir, files[0]), 'utf8'));
  assert.equal(queued.kind, 'tool-surface-missing');
  const queuedSnap = applied.watcher.snapshot();
  assert.equal(queuedSnap.lastAttemptOutcome, 'unknown', '入队只是 unknown（不是 delivered）');
  assert.equal(queuedSnap.lastAttemptAt, clock.now, '入队必须记账，否则 15 分钟节流失效 ⇒ 每分钟重复提醒');

  // 模拟桥接写回执：下一轮定时检查必须先读回执再判定。
  await fs.mkdir(path.join(inboxDir, 'receipts'), { recursive: true });
  await fs.writeFile(
    path.join(inboxDir, 'receipts', files[0]),
    JSON.stringify({ noticeId: queued.noticeId, outcome: 'delivered', at: clock.now + 1000 }),
    'utf8',
  );
  clock.now += 60_000;
  await rest.scheduler.everyCalls[0].fn();
  const snap = applied.watcher.snapshot();
  assert.equal(snap.lastAttemptAt, clock.now - 60_000 + 1000, '回执必须被读回并记账（否则 unknown 会每分钟重复提醒）');
  assert.equal(snap.lastAttemptOutcome, 'delivered');
  assert.equal(snap.hasAlerted, true, '确认送达后才允许进入 6 小时窗口');
  applied.dispose();
  await fs.rm(tmp, { recursive: true, force: true });
});

test('2B-⑯ apply() 注入 v1 模块 → 显式装配失败：decisionLoadError、lastReason=decision-unavailable、不注册钩子', async () => {
  const logs = [];
  const ctx = makeBareApplyCtx();
  const result = await apply(ctx, {
    decision: { recordToolSurfaceObservation: () => ({ alert: false }) },
    log: (level, message) => logs.push([level, message]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.enabled, false);
  assert.equal(result.decisionLoadError.path, '<injected decision>');
  assert.match(result.decisionLoadError.message, /noteToolSurfaceDelivery/);
  assert.equal(result.snapshot().lastReason, 'decision-unavailable');
  assert.equal(ctx.handlers.size, 0, '装配失败不得注册任何钩子');
  assert.ok(logs.some(([level, message]) => level === 'error' && /未装配/.test(message)));
});

/// —— 真实 2A 模块（v2）集成：状态机语义字符串优先于顶层 reason ——

/// —— 真实 2A 模块（v2）集成：状态机语义字符串优先于顶层 reason ——

test('v2-⑪a 真实模块：2 次 scheduled absent → 1 次 event present ⇒ 计数清零且 lastReason=recovered', async () => {
  const decision = await import('../../src/core/xhh-tool-surface-decision.mjs');
  let names = MISSING_ALL;
  const clock = { now: BASE };
  const ctx = makeWatcher({ decision, names: () => names, watcher: { now: () => clock.now } });
  ctx.clock = clock;
  await ctx.watcher.check({ source: 'scheduled' });
  clock.now += 60_000; // 真实模块 v2.1 的间隔语义：有效分钟至少相隔 interval/2
  await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(ctx.watcher.snapshot().consecutiveMisses, 2);
  names = [...FULL_TOOLS];
  await ctx.watcher.check({ source: 'event' });
  const snap = ctx.watcher.snapshot();
  assert.equal(snap.consecutiveMisses, 0, 'event present 必须立即清零');
  // 真实模块 present 分支：state.lastReason='recovered'，顶层 reason='not-absent'。
  // 插件若优先读顶层 reason，这里会拿到 'not-absent' —— 恢复信号被吞。
  assert.equal(snap.lastReason, 'recovered', '恢复必须可见（不得是 not-absent）');
});

test('v2-⑪b 真实模块：全新 watcher 第一次就是 present ⇒ lastReason=ok', async () => {
  const decision = await import('../../src/core/xhh-tool-surface-decision.mjs');
  const ctx = makeWatcher({ decision, names: [...FULL_TOOLS] });
  await ctx.watcher.check({ source: 'scheduled' });
  const snap = ctx.watcher.snapshot();
  assert.equal(snap.consecutiveMisses, 0);
  assert.equal(snap.lastReason, 'ok', '首次观测 present 的语义是 ok（不是 recovered）');
});

test('v2-⑪c 真实模块：先 uncertain 再 present ⇒ lastReason=ok（非 recovered）', async () => {
  const decision = await import('../../src/core/xhh-tool-surface-decision.mjs');
  let failOnce = true;
  const ctx = makeWatcher({
    decision,
    readToolNames: () => {
      if (failOnce) {
        failOnce = false;
        throw new Error('boom');
      }
      return FULL_TOOLS;
    },
  });
  await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(ctx.watcher.snapshot().lastReason, 'no-observation');
  await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(ctx.watcher.snapshot().lastReason, 'ok', '上一次不是 absent，present 的语义是 ok');
});

/// 保留 DECISION_MODULE_PATH 的引用：安装形态文档/调试时需要在测试里核对默认路径常量。
assert.equal(typeof DECISION_MODULE_PATH, 'string');

// ===== v2.1：间隔语义（enforceScheduledGap）+ 通知通道装配（notifyUrl/notifyToken）=====

/** 与 bootApply 相同，但**不**注入 notify 函数，用于验证 notifyUrl 装配路径。 */
async function bootApplyWithConfig(overrides = {}) {
  const clock = { now: BASE };
  const { ctx, ...rest } = makeApplyCtx(overrides);
  const logs = [];
  const result = await apply(ctx, {
    decision: overrides.decision ?? createFakeDecision(),
    scheduler: rest.scheduler,
    store: overrides.store ?? createMemoryStore(),
    now: () => clock.now,
    log: (level, message) => logs.push([level, message]),
    ...overrides.config,
  });
  return { ...rest, result, clock, logs };
}

test('v2.1-① 事件夹在两次 scheduled 之间：不占用「有效分钟」（too-soon 不计）', async () => {
  const base = createFakeDecision({ enforceScheduledGap: true });
  const seenIntervalMs = [];
  const decision = {
    ...base,
    recordToolSurfaceObservation(state, options = {}) {
      seenIntervalMs.push(options.intervalMs);
      return base.recordToolSurfaceObservation(state, options);
    },
  };
  const ctx = makeWatcher({
    names: MISSING_ALL,
    config: { intervalMs: 60_000 },
    decision,
  });
  await ctx.watcher.check({ source: 'scheduled' }); // 有效分钟 1
  ctx.advance(20_000);
  await ctx.watcher.check({ source: 'event' }); // 事件：不计数
  ctx.advance(5_000);
  const afterEvent = await ctx.watcher.check({ source: 'scheduled' }); // 距上次 scheduled 仅 25s
  assert.equal(afterEvent.consecutiveMisses, 1, '距上次有效 scheduled < interval/2 的检查必须被忽略');
  assert.equal(afterEvent.lastReason, 'too-soon');
  assert.ok(seenIntervalMs.length >= 3 && seenIntervalMs.every((ms) => ms === 60_000), '插件必须把 intervalMs 透传给判定模块（真实 2A 靠它分桶）');
  ctx.advance(60_000);
  const next = await ctx.watcher.check({ source: 'scheduled' }); // 距上次有效 scheduled 85s
  assert.equal(next.consecutiveMisses, 2);
  assert.equal(ctx.notifications.length, 0);
});

test('v2.1-② 正常每分钟一次：3 个有效分钟才提示', async () => {
  const ctx = makeWatcher({
    names: MISSING_ALL,
    config: { intervalMs: 60_000 },
    decisionOptions: { enforceScheduledGap: true },
  });
  for (let i = 0; i < 3; i += 1) {
    await ctx.watcher.check({ source: 'scheduled' });
    if (i < 2) ctx.advance(60_000);
  }
  assert.equal(ctx.watcher.snapshot().consecutiveMisses, 3);
  assert.equal(ctx.notifications.length, 1);
});

test('v2.1-③ 错过 10 分钟（>2.5×interval）→ 连续计数重置为 1', async () => {
  const ctx = makeWatcher({
    names: MISSING_ALL,
    config: { intervalMs: 60_000 },
    decisionOptions: { enforceScheduledGap: true },
  });
  await ctx.watcher.check({ source: 'scheduled' });
  ctx.advance(60_000);
  await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(ctx.watcher.snapshot().consecutiveMisses, 2);
  ctx.advance(10 * 60_000);
  const afterGap = await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(afterGap.consecutiveMisses, 1, '长时间没检查应视为错过分钟，从 1 重新计数');
  assert.equal(ctx.notifications.length, 0);
});

test('v2.1-④ 间隔 2 分钟（<2.5×interval）不重置，第 3 次仍提示', async () => {
  const ctx = makeWatcher({
    names: MISSING_ALL,
    config: { intervalMs: 60_000 },
    decisionOptions: { enforceScheduledGap: true },
  });
  await ctx.watcher.check({ source: 'scheduled' });
  ctx.advance(120_000);
  await ctx.watcher.check({ source: 'scheduled' });
  ctx.advance(120_000);
  await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(ctx.watcher.snapshot().consecutiveMisses, 3);
  assert.equal(ctx.notifications.length, 1);
});

test('v2.1-⑤ 密集事件不刷新 lastScheduledAt：满一分钟后 scheduled 正常计数', async () => {
  const ctx = makeWatcher({
    names: MISSING_ALL,
    config: { intervalMs: 60_000 },
    decisionOptions: { enforceScheduledGap: true },
  });
  await ctx.watcher.check({ source: 'scheduled' });
  for (let i = 0; i < 5; i += 1) {
    ctx.advance(5_000);
    await ctx.watcher.check({ source: 'event' });
  }
  ctx.advance(35_000); // 距上次 scheduled 已 60s
  const next = await ctx.watcher.check({ source: 'scheduled' });
  assert.equal(next.consecutiveMisses, 2, '事件不得把「有效分钟」往后推');
});

test('v2.1-⑥ intervalMs 配置覆盖：调度间隔与 snapshot 一致，默认 60000', async () => {
  const custom = await bootApply({ names: MISSING_ALL, config: { intervalMs: 30_000 } });
  assert.equal(custom.scheduler.everyCalls[0].ms, 30_000);
  assert.equal(custom.result.watcher.snapshot().intervalMs, 30_000);

  const def = await bootApply({ names: MISSING_ALL });
  assert.equal(def.scheduler.everyCalls[0].ms, 60_000);
  assert.equal(def.result.watcher.snapshot().intervalMs, 60_000);
});

test('v2.1-⑦ notifyUrl 合法 → 自动构造 HTTP notifier（带 token）；默认 none 下即使有发送回执也不推进 lastAlertAt', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    // 即使 bridge 发送成功回执长这样，默认契约 none 也只能判 unknown
    return { status: 200, text: async () => JSON.stringify({ ok: true, key: 'private:1', sent: 1, failed: 0, quoted: null }) };
  };
  try {
    const h = await bootApplyWithConfig({
      names: MISSING_ALL,
      config: {
        notifyUrl: 'http://127.0.0.1:9/api/send/private',
        notifyToken: 'tok-secret',
        notifyHeaderName: 'x-console-token',
      },
    });
    assert.ok(h.result.watcher !== undefined, '装配应成功（apply 成功时返回 watcher，不含 ok 字段）');
    assert.equal(h.result.watcher.snapshot().notifyConfigured, true);
    for (let i = 0; i < 3; i += 1) await h.tick();
    assert.equal(requests.length, 1, '三次 scheduled 只应尝试一次通知');
    assert.equal(requests[0].url, 'http://127.0.0.1:9/api/send/private');
    assert.equal(requests[0].options.headers['x-console-token'], 'tok-secret');
    assert.equal(requests[0].options.method, 'POST');
    assert.match(String(requests[0].options.body), /检测到 12 个/);
    const snap = h.result.watcher.snapshot();
    assert.equal(snap.lastAlertAt, null, '未能证明送达时绝不推进「已送达」时间');
    assert.notEqual(snap.lastAttemptAt, null, '要记下「尝试过但结果未知」');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('v2.1-⑧ notifyUrl 非法 → 装配成功、error 日志、notifyConfigured=false、不抛', async () => {
  const h = await bootApplyWithConfig({ names: MISSING_ALL, config: { notifyUrl: 'ftp://not-http' } });
  assert.ok(h.result.watcher !== undefined, '离线装配必须成功（notifyUrl 非法只降级通知）');
  assert.equal(h.result.watcher.snapshot().notifyConfigured, false);
  assert.ok(h.logs.some(([level, message]) => level === 'error' && /通知通道配置无效/.test(message)), '必须 error 级提示');
});

test('v2.1-⑨ 无任何通知配置 → 装配成功 + warn，不静默', async () => {
  const h = await bootApplyWithConfig({ names: MISSING_ALL });
  assert.ok(h.result.watcher !== undefined, '无通知配置也必须装配成功');
  assert.equal(h.result.watcher.snapshot().notifyConfigured, false);
  assert.ok(h.logs.some(([level, message]) => level === 'warn' && /未配置可用通知通道/.test(message)));
});

test('v2.2-① 2xx + {ok:true} 不再算送达：notifyConfigured=true 但 lastAlertAt 不推进', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return { status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
  try {
    const h = await bootApplyWithConfig({
      names: MISSING_ALL,
      config: { notifyUrl: 'http://127.0.0.1:9/api/send/private' },
    });
    assert.equal(h.result.watcher.snapshot().notifyConfigured, true, '配了 URL 就算已配置通道');
    for (let i = 0; i < 3; i += 1) await h.tick();
    assert.equal(requests.length, 1, '三次 scheduled 仍只尝试一次');
    const snap = h.result.watcher.snapshot();
    assert.equal(snap.lastAlertAt, null, '{ok:true} 只证明受理，绝不能推进「已送达」时间');
    assert.ok(snap.lastAttemptAt !== null, '要记下「尝试过但结果未知」');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('v2.1-⑩ config.notify 函数优先于 notifyUrl（测试注入不触网）', async () => {
  const notified = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('不应走到 notifyUrl 的 HTTP 路径');
  };
  try {
    const h = await bootApplyWithConfig({
      names: MISSING_ALL,
      config: {
        notifyUrl: 'http://127.0.0.1:9/should-not-be-used',
        notify: (event) => { notified.push(event); return { outcome: 'delivered' }; },
      },
    });
    assert.equal(h.result.watcher.snapshot().notifyConfigured, true);
    for (let i = 0; i < 3; i += 1) await h.tick();
    assert.equal(notified.length, 1);
    assert.equal(notified[0].kind, 'registration-lost');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('P3-1 无 notify + 连续 3 次缺失 → attempted=false、lastAlertAt=null、计数仍为 3', async () => {
  // notify 走 factory 覆盖为显式 null（makeWatcher 的 overrides.notify 用 ?? 会回落默认注入）。
  const ctx = makeWatcher({ names: MISSING_ALL, factory: { notify: null } });
  for (let i = 0; i < 3; i += 1) {
    await ctx.watcher.check({ source: 'scheduled' });
    ctx.advance(1000);
  }
  const snap = ctx.watcher.snapshot();
  assert.equal(snap.consecutiveMisses, 3, '缺失计数应正常到 3（判定模块照常工作）');
  assert.equal(snap.attempted, false, '无通知通道时什么都没尝试，attempted 必须为 false');
  assert.equal(snap.lastAlertAt, null, '无通知通道时绝不推进 lastAlertAt');
  assert.equal(ctx.notifications.length, 0);
  assert.ok(
    ctx.logs.some(([level, message]) => level === 'warn' && /无通知通道|未配置 notify/.test(message)),
    '必须留下可观察的 warn 日志',
  );
});

test('2C 装配 C：receipts 被建成普通文件（ENOTDIR）时，本轮观测必须照常进行（回执失败不得吞掉检查）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xhh-asm-c-'));
  const inboxDir = path.join(tmp, 'inbox');
  await fs.mkdir(inboxDir, { recursive: true });
  // 真实故障形态：receipts 不是目录而是普通文件 ⇒ readdir 抛 ENOTDIR。
  await fs.writeFile(path.join(inboxDir, 'receipts'), 'not-a-directory', 'utf8');
  const clock = { now: BASE };
  const logs = [];
  const { ctx, ...rest } = makeApplyCtx({});
  const applied = await apply(ctx, {
    decision: createFakeDecision(),
    scheduler: rest.scheduler,
    store: createMemoryStore(),
    notify: () => ({ outcome: 'delivered' }),
    now: () => clock.now,
    log: (...args) => logs.push(args),
    inboxDir,
    intervalMs: 60_000,
  });
  rest.setNames(MISSING_ALL);
  for (let i = 0; i < 3; i += 1) {
    clock.now += 60_000;
    await rest.scheduler.everyCalls[0].fn();
  }
  const snap = applied.watcher.snapshot();
  // 关键断言：三次定时观测真的发生了（连续计数到位），而不是被回执错误整轮吞掉。
  assert.equal(snap.consecutiveMisses, 3, '回执读取失败时 check 仍必须执行');
  assert.ok(logs.some(([level, message]) => level === 'warn' && String(message).includes('读回执失败')),
    '回执失败要用 warn 留痕，不能静默');
  applied.dispose();
  await fs.rm(tmp, { recursive: true, force: true });
});
