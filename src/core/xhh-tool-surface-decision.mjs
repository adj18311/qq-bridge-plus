// xhh-tool-surface-decision.mjs —— 小黑盒 MCP「工具面」纯判定状态机 v2.1
//
// 定位：DSH 使用方观测到的 `mcp__xiaoheihe__*` 工具名集合 → 分类 present/absent/uncertain
// → 连续可靠缺失计数 → 是否应提示管理员（仅提示，不做任何自动重启/敏感操作）。
//
// 契约 v2.1（Lead 2026-10-30 阶段 2A 派工 + 勘误 + v2 + Codex 新增硬要求，最终）：
//   · observedNames 是可靠观测：合法数组（元素均为非空字符串，可为空数组）
//       全部 expected 都在 → present/ok；缺任意（含空数组=全缺）→ absent/missing-tools（missing 排序）
//       含非法元素（null/数字/空串/带空白）→ uncertain/invalid-name
//   · null/undefined/非数组 → uncertain/no-observation
//   · expectedNames 为空或非数组 → uncertain/no-expected
//   · 两条观测路径分离（v2 核心修正）：
//       - source:'scheduled'（每分钟定时检查）的 absent 才累加 consecutiveMisses；
//       - source:'event'（tools/change 事件）的 absent 只更新 lastState/lastObservedAt，
//         计数不变、alert 恒 false —— 重连时事件可能连发，不能证明「连续三次定时检查」。
//   · 间隔与断链（v2.1，仅 scheduled 路径）：
//       - gap < intervalMs*0.5 → too-soon：不计数、不推进 lastScheduledAt（补跑/防抖不打乱链）；
//       - gap > intervalMs*2.5 → 链路已断（宿主挂起/事件循环阻塞/定时器跳过）：
//         计数重置为 1（chain-restarted），绝不能把醒来后的补跑算成「连续」；
//       - at < lastScheduledAt → clock-backwards：不计数、不推进 lastScheduledAt；
//       - too-soon / clock-backwards 会把 state.lastReason 也写成对应原因（供 watcher 公开快照
//         区分「被忽略的间隔」与「真实缺失」），计数与 lastScheduledAt 仍保持不变；
//       - event 永不更新 lastScheduledAt（事件时间不参与间隔判定）。
//   · present（任一 source）清零；uncertain（任一 source）清零（不确定必须中断计数）；
//     scheduled 的 present/uncertain 会推进 lastScheduledAt（断链后重新起链）。
//   · consecutiveMisses >= 3 才进入提示判定：成功通知节流 6h（lastAlertAt）；失败/未知投递后
//     重试节流 15 分钟（lastAttemptAt + lastAttemptOutcome !== 'delivered'）。
//   · 投递结果单独记账 noteToolSurfaceDelivery：只有 delivered 推进 lastAlertAt；
//     failed/unknown 只写 lastAttemptAt/lastAttemptOutcome，绝不冒充已送达。
//   · 非法输入（state 损坏、at 非有限数、source/intervalMs/outcome 非法）不抛异常：
//     state 原地不变 + reason:'invalid-observation'（record）/ accepted:false（note）。
//
// 纯逻辑：无 IO、无时钟（时间全部由调用方传入）、不持久化、不通知。

export const XHH_TOOL_NAME_PREFIX = 'mcp__xiaoheihe__';

// 2026-10-30T09:44:00Z 取样自 http://127.0.0.1:19489/ （只读 initialize + tools/list，
// 服务端 XiaoheiheMcpServer.Http 1.0.0.0，protocolVersion 2025-06-18，返回 12 个工具）。
export const XHH_EXPECTED_TOOL_NAMES = Object.freeze([
  'check_login_status',
  'get_home_content',
  'get_login_qr_code',
  'get_post_detail',
  'get_user_profile',
  'interactive_login',
  'post_comment',
  'publish_article',
  'publish_content',
  'publish_video',
  'reply_comment',
  'search_content',
]);

export const XHH_TOOL_SURFACE_MIN_CONSECUTIVE_MISSES = 3;
export const XHH_TOOL_SURFACE_ALERT_THROTTLE_MS = 6 * 60 * 60 * 1000;
export const XHH_TOOL_SURFACE_FAILURE_RETRY_MS = 15 * 60 * 1000;
export const XHH_TOOL_SURFACE_DEFAULT_INTERVAL_MS = 60 * 1000;
export const XHH_TOOL_SURFACE_MIN_TICK_GAP_RATIO = 0.5;
export const XHH_TOOL_SURFACE_MAX_TICK_GAP_RATIO = 2.5;
export const XHH_TOOL_SURFACE_SOURCES = Object.freeze(['scheduled', 'event']);
export const XHH_TOOL_SURFACE_STATE_VERSION = 2;

const LAST_STATES = new Set(['unknown', 'present', 'absent', 'uncertain']);
const DELIVERY_OUTCOMES = new Set(['delivered', 'failed', 'unknown']);
const SOURCE_SET = new Set(XHH_TOOL_SURFACE_SOURCES);

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 工具名合法性：非空字符串且不含空白（真实工具名是 snake_case）。 */
function isValidToolName(value) {
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value);
}

/** 观测 → 分类。不抛异常。 */
export function classifyToolSurface({ observedNames, expectedNames = XHH_EXPECTED_TOOL_NAMES } = {}) {
  if (!Array.isArray(expectedNames) || expectedNames.length === 0) {
    return { state: 'uncertain', missing: [], presentCount: 0, expectedCount: 0, reason: 'no-expected' };
  }
  if (!Array.isArray(observedNames)) {
    return {
      state: 'uncertain',
      missing: [],
      presentCount: 0,
      expectedCount: expectedNames.length,
      reason: 'no-observation',
    };
  }
  if (observedNames.some((name) => !isValidToolName(name))) {
    return {
      state: 'uncertain',
      missing: [],
      presentCount: 0,
      expectedCount: expectedNames.length,
      reason: 'invalid-name',
    };
  }

  const observedSet = new Set(observedNames);
  const missing = expectedNames.filter((name) => !observedSet.has(name)).sort();
  const presentCount = expectedNames.length - missing.length;

  if (missing.length === 0) {
    return {
      state: 'present',
      missing: [],
      presentCount,
      expectedCount: expectedNames.length,
      reason: 'ok',
    };
  }
  return {
    state: 'absent',
    missing,
    presentCount,
    expectedCount: expectedNames.length,
    reason: 'missing-tools',
  };
}

export function createToolSurfaceState() {
  return {
    schemaVersion: XHH_TOOL_SURFACE_STATE_VERSION,
    consecutiveMisses: 0,
    lastAlertAt: null,
    lastState: 'unknown',
    lastObservedAt: null,
    lastReason: 'init',
    lastAttemptAt: null,
    lastAttemptOutcome: null,
    lastScheduledAt: null,
  };
}

/**
 * 任意输入 → 合法 v2 state 或 null。损坏/v1/未知版本/字段非法一律 null，绝不修补猜测。
 * 接受对象或 JSON 字符串。v2 早期快照缺 lastScheduledAt → 视为 null（向后兼容）。
 */
export function parseToolSurfaceState(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;

  const {
    schemaVersion,
    consecutiveMisses,
    lastAlertAt,
    lastState,
    lastObservedAt,
    lastReason,
    lastAttemptAt,
    lastAttemptOutcome,
  } = value;

  if (schemaVersion !== XHH_TOOL_SURFACE_STATE_VERSION) return null;
  if (!Number.isInteger(consecutiveMisses) || consecutiveMisses < 0) return null;
  if (lastAlertAt !== null && !isFiniteNumber(lastAlertAt)) return null;
  if (lastObservedAt !== null && !isFiniteNumber(lastObservedAt)) return null;
  if (lastAttemptAt !== null && !isFiniteNumber(lastAttemptAt)) return null;
  if (lastAttemptOutcome !== null && !DELIVERY_OUTCOMES.has(lastAttemptOutcome)) return null;
  if (typeof lastState !== 'string' || !LAST_STATES.has(lastState)) return null;
  if (typeof lastReason !== 'string' || lastReason.length === 0) return null;

  const lastScheduledAt = value.lastScheduledAt === undefined ? null : value.lastScheduledAt;
  if (lastScheduledAt !== null && !isFiniteNumber(lastScheduledAt)) return null;

  return {
    schemaVersion: XHH_TOOL_SURFACE_STATE_VERSION,
    consecutiveMisses,
    lastAlertAt,
    lastState,
    lastObservedAt,
    lastReason,
    lastAttemptAt,
    lastAttemptOutcome,
    lastScheduledAt,
  };
}

function invalidObservation(state, consecutiveMisses) {
  return {
    state,
    alert: false,
    kind: null,
    consecutiveMisses,
    reason: 'invalid-observation',
    counted: false,
    retryRemainingMs: 0,
    throttleRemainingMs: 0,
  };
}

/**
 * 核心：吃一次观测，返回「要不要提示」+ 新 state。不修改入参。
 * @param {object|string} state  v2 state（对象或 JSON 字符串）
 * @param {{observedNames: unknown, at: number, source?: 'scheduled'|'event', intervalMs?: number}} observation
 * @returns {{state:object, alert:boolean, kind:'registration-lost'|null, consecutiveMisses:number,
 *            reason:string, counted:boolean, retryRemainingMs:number, throttleRemainingMs:number}}
 */
export function recordToolSurfaceObservation(
  state,
  { observedNames, at, source = 'scheduled', intervalMs = XHH_TOOL_SURFACE_DEFAULT_INTERVAL_MS } = {},
) {
  const base = parseToolSurfaceState(state);
  if (base === null) return invalidObservation(state, 0);
  if (!isFiniteNumber(at)) return invalidObservation(state, base.consecutiveMisses);
  if (!SOURCE_SET.has(source)) return invalidObservation(state, base.consecutiveMisses);
  if (!isFiniteNumber(intervalMs) || intervalMs <= 0) {
    return invalidObservation(state, base.consecutiveMisses);
  }

  const isScheduled = source === 'scheduled';
  const classified = classifyToolSurface({ observedNames });

  if (classified.state === 'present') {
    return {
      state: {
        ...base,
        consecutiveMisses: 0,
        lastState: 'present',
        lastObservedAt: at,
        lastReason: base.lastState === 'absent' ? 'recovered' : 'ok',
        lastScheduledAt: isScheduled ? at : base.lastScheduledAt,
      },
      alert: false,
      kind: null,
      consecutiveMisses: 0,
      reason: 'not-absent',
      counted: false,
      retryRemainingMs: 0,
      throttleRemainingMs: 0,
    };
  }

  if (classified.state === 'uncertain') {
    return {
      state: {
        ...base,
        consecutiveMisses: 0,
        lastState: 'uncertain',
        lastObservedAt: at,
        lastReason: classified.reason,
        lastScheduledAt: isScheduled ? at : base.lastScheduledAt,
      },
      alert: false,
      kind: null,
      consecutiveMisses: 0,
      reason: 'not-absent',
      counted: false,
      retryRemainingMs: 0,
      throttleRemainingMs: 0,
    };
  }

  // absent：事件路径不计数、不参与间隔判定（v2.1）。
  if (!isScheduled) {
    return {
      state: {
        ...base,
        lastState: 'absent',
        lastObservedAt: at,
        lastReason: 'event-not-counted',
      },
      alert: false,
      kind: null,
      consecutiveMisses: base.consecutiveMisses,
      reason: 'event-not-counted',
      counted: false,
      retryRemainingMs: 0,
      throttleRemainingMs: 0,
    };
  }

  // absent + scheduled：先判间隔（v2.1）。
  const gap = base.lastScheduledAt === null ? null : at - base.lastScheduledAt;

  if (gap !== null && gap < 0) {
    return {
      state: {
        ...base,
        lastState: 'absent',
        lastObservedAt: at,
        lastReason: 'clock-backwards',
      },
      alert: false,
      kind: null,
      consecutiveMisses: base.consecutiveMisses,
      reason: 'clock-backwards',
      counted: false,
      retryRemainingMs: 0,
      throttleRemainingMs: 0,
    };
  }

  if (gap !== null && gap < intervalMs * XHH_TOOL_SURFACE_MIN_TICK_GAP_RATIO) {
    return {
      state: {
        ...base,
        lastState: 'absent',
        lastObservedAt: at,
        lastReason: 'too-soon',
      },
      alert: false,
      kind: null,
      consecutiveMisses: base.consecutiveMisses,
      reason: 'too-soon',
      counted: false,
      retryRemainingMs: 0,
      throttleRemainingMs: 0,
    };
  }

  if (gap !== null && gap > intervalMs * XHH_TOOL_SURFACE_MAX_TICK_GAP_RATIO) {
    // 链路已断（宿主挂起/事件循环阻塞/定时器跳过）：重新起链，绝不算「连续」。
    // lastReason 仍为 'missing-tools'：chain-restarted 是真实缺失观测（计数已重置为 1 后继续），
    // 与 too-soon/clock-backwards 这种「被忽略的间隔」不同，故公开快照仍显示缺失语义。
    return {
      state: {
        ...base,
        consecutiveMisses: 1,
        lastState: 'absent',
        lastObservedAt: at,
        lastReason: 'missing-tools',
        lastScheduledAt: at,
      },
      alert: false,
      kind: null,
      consecutiveMisses: 1,
      reason: 'chain-restarted',
      counted: true,
      retryRemainingMs: 0,
      throttleRemainingMs: 0,
    };
  }

  const consecutiveMisses = base.consecutiveMisses + 1;
  const next = {
    ...base,
    consecutiveMisses,
    lastState: 'absent',
    lastObservedAt: at,
    lastReason: 'missing-tools',
    lastScheduledAt: at,
  };

  if (consecutiveMisses < XHH_TOOL_SURFACE_MIN_CONSECUTIVE_MISSES) {
    return {
      state: next,
      alert: false,
      kind: null,
      consecutiveMisses,
      reason: 'missing-tools',
      counted: true,
      retryRemainingMs: 0,
      throttleRemainingMs: 0,
    };
  }

  // 成功通知节流：距上次「已送达」提示不足 6h 不重复提示，但计数继续累加。
  const throttleRemainingMs = base.lastAlertAt === null
    ? 0
    : Math.max(0, base.lastAlertAt + XHH_TOOL_SURFACE_ALERT_THROTTLE_MS - at);
  if (base.lastAlertAt !== null && at - base.lastAlertAt < XHH_TOOL_SURFACE_ALERT_THROTTLE_MS) {
    return {
      state: next,
      alert: false,
      kind: null,
      consecutiveMisses,
      reason: 'throttled',
      counted: true,
      retryRemainingMs: 0,
      throttleRemainingMs,
    };
  }

  // 失败重试节流：上次投递失败/未知后 15 分钟内不重试；delivered 后不再走这条。
  const retryRemainingMs = base.lastAttemptAt === null
    ? 0
    : Math.max(0, base.lastAttemptAt + XHH_TOOL_SURFACE_FAILURE_RETRY_MS - at);
  if (
    base.lastAttemptAt !== null
    && base.lastAttemptOutcome !== 'delivered'
    && at - base.lastAttemptAt < XHH_TOOL_SURFACE_FAILURE_RETRY_MS
  ) {
    return {
      state: next,
      alert: false,
      kind: null,
      consecutiveMisses,
      reason: 'retry-throttled',
      counted: true,
      retryRemainingMs,
      throttleRemainingMs: 0,
    };
  }

  // 应发提示：本次调用不改 lastAlertAt/lastAttemptAt，投递结果交给 noteToolSurfaceDelivery。
  return {
    state: next,
    alert: true,
    kind: 'registration-lost',
    consecutiveMisses,
    reason: 'missing-tools',
    counted: true,
    retryRemainingMs: 0,
    throttleRemainingMs: 0,
  };
}

/**
 * 投递记账：调用方拿到通知结果后回填。不修改入参 state。
 * delivered → 推进 lastAlertAt（成功通知节流起点）；failed/unknown → 只记录尝试，绝不冒充已送达。
 * @param {object|string} state v2 state
 * @param {{at:number, outcome:'delivered'|'failed'|'unknown', deliveredAt?:number}} delivery
 * @returns {{state:object, accepted:boolean}}
 */
export function noteToolSurfaceDelivery(state, { at, outcome, deliveredAt } = {}) {
  const base = parseToolSurfaceState(state);
  if (base === null) return { state, accepted: false };
  if (!isFiniteNumber(at)) return { state, accepted: false };
  if (!DELIVERY_OUTCOMES.has(outcome)) return { state, accepted: false };

  if (outcome === 'delivered') {
    return {
      state: {
        ...base,
        lastAlertAt: isFiniteNumber(deliveredAt) ? deliveredAt : at,
        lastAttemptAt: at,
        lastAttemptOutcome: 'delivered',
      },
      accepted: true,
    };
  }

  return {
    state: {
      ...base,
      lastAttemptAt: at,
      lastAttemptOutcome: outcome,
    },
    accepted: true,
  };
}
