/**
 * @deprecated 2026-11-01 起：**概率抽签已取消**（用户决定：每次真实巡逻后由智能体自主决定是否分享）。
 * 本文件里的七档概率/抽签描述与实现均为**退役兼容**：旧快照仍可读入并结算，新流程不再抽签。
 * 现行语义见 docs/superpowers/plans/2026-11-01-patrol-autonomous-share-design.md。
 */
/**
 * 后台巡逻第三阶段（修正版）：主动汇报「一次读取至多一次尝试」纯状态机。
 *
 * 职责边界（有意保持很小）：
 *  · 只维护内存中的汇报尝试状态：idle -> prepared -> dispatched -> confirmed | failed | unknown；
 *  · 不发送 QQ、不落盘、不读文件、不联网、不启动定时器、不读取全局 Math.random；
 *  · 概率抽签只在这里发生一次，且复用 `background-patrol-report-policy.mjs` 的七档纯策略；
 *  · 持久化由调用方负责：`snapshot()` 产出可持久化快照，`restore()` 在重启/重连后恢复，
 *    因此「同一个 readIndex 在重启后也不得重发」可以离线证明，而本模块仍然不碰存储。
 *
 * 规格依据（docs/superpowers/specs/2026-10-24-background-patrol-design.md §概率汇报）：
 *  · 每次访问至多尝试发送一条主动汇报；一旦尝试，无论 success / failed / unknown 都消耗档位；
 *  · 不自动重发、不重复抽签；发送结果须记录。
 *
 * 关键规则：
 *  1. 同一 readIndex 只允许 prepare 一次（'duplicate-read'）；比 lastReadIndex 小的迟到读取一律
 *     'stale-read'（fail-closed，不补报、不倒退档位）。
 *  2. 同一 dedupeKey 是「同一逻辑读取」：即使 readIndex 不同也不再抽签（'duplicate-key'），
 *     避免调用方因重连/重试生成新序号而重复汇报。seenKeys 有上限（旧键淘汰后由 readIndex 单调性兜底）。
 *  3. 抽签未命中（shouldReport=false）时本次读取不进入 prepared、不可 dispatch；但读取序号已消费，
 *     不允许换随机数二次抽签。
 *  4. prepared / dispatched 期间不得开始下一次读取（'in-flight'）。超过 ttlMs 的 prepared 视为过期：
 *     dispatch 返回 'expired' 且绝不发送；同一读取不会因过期而重抽签。
 *  5. failed / unknown 都是终态：不自动重试、不自动重发；新读取（更大的 readIndex）可重新开始。
 *     unknown 不因「重连」变成可重试状态。
 *  6. restore() 只接受本模块 snapshot() 产出的、字段互相一致的快照；任何损坏/矛盾快照抛
 *     `REPORT_ONCE_INVALID_SNAPSHOT`，且不覆盖当前内存状态（fail-closed）。
 *  7. reset() 只用于新的北京自然日或明确的新会话，不是「同一读取重试」的后门。
 *  8. 时间戳单调（task-15 L1）：`dispatch().at` 必须 >= preparedAt、`settle().at` 必须 >= dispatchedAt。
 *     这两个 at 值直接进快照并被 `settle()`/restore 的一致性校验使用；时钟回拨若静默接受，会产出
 *     `settledAt < dispatchedAt` 或 `dispatchedAt < preparedAt` 的快照，导致本模块自己的 restore 拒绝。
 *     因此这里 fail-closed 抛 `REPORT_ONCE_CLOCK_ROLLBACK`（RangeError），**不自动钳制**——
 *     钳制会掩盖时钟异常并伪造证据时间。
 *  9. 0 概率档（第 7 次及以后）不需要随机数（task-15 L2）：`prepare()` 允许省略 `random`，
 *     返回 `random:null` 且不抽签；非 0 档省略 `random` 抛 TypeError。策略层 `decideBackgroundReport`
 *     本身仍拒绝缺省/非法 random，调用方应先用 `shouldDrawBackgroundReport()` 判断是否抽签。
 * 10. 已知限制（文档化，不实现）：
 *     · 本模块没有「北京自然日」概念：readIndex 按天重置、跨日调用 reset() 都由调用方负责；
 *       跨日若忘记 reset()，新一天的第 1 次读取会被当作 'stale-read' 拒绝（fail-closed，不误报）。
 *     · 只有 prepared 有 ttlMs；**dispatched 没有 TTL/自动超时**。已发出尝试但结果未知时，
 *       必须由调用方显式 settle('unknown')（或丢弃实例）；不得因为「等太久」而重发。
 */

import {
  backgroundReportProbability,
  decideBackgroundReport,
  shouldDrawBackgroundReport,
} from './background-patrol-report-policy.mjs';

/** 状态机允许出现的状态（冻结）。 */
export const REPORT_ONCE_STATES = Object.freeze(['idle', 'prepared', 'dispatched', 'confirmed', 'failed', 'unknown', 'declined']);

/** 一次尝试允许的终态（冻结）。 */
export const REPORT_ONCE_OUTCOMES = Object.freeze(['confirmed', 'failed', 'unknown', 'declined']);

/** 快照 schema 版本：不是这个版本一律拒绝恢复，绝不静默丢弃/重放。 */
export const REPORT_ONCE_SNAPSHOT_VERSION = 1;

/** seenKeys 上限：只用于跨 readIndex 的逻辑去重；超限淘汰最旧键，readIndex 单调性仍是主防线。 */
export const REPORT_ONCE_MAX_SEEN_KEYS = 64;

const MAX_DEDUPE_KEY_LENGTH = 200;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

const TERMINAL_STATES = new Set(REPORT_ONCE_OUTCOMES);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function asTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Number.NaN;
}

function isDedupeKey(value) {
  return typeof value === 'string' && value.trim() !== '' && value.trim().length <= MAX_DEDUPE_KEY_LENGTH && value === value.trim();
}

function createError(message, code, cause) {
  const error = new TypeError(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/** L1：时间戳回拨是显式错误（RangeError），不静默钳制、不写入会污染快照的时间。 */
function createClockRollbackError(detail) {
  const error = new RangeError(`汇报状态机：${detail}`);
  error.code = 'REPORT_ONCE_CLOCK_ROLLBACK';
  return error;
}

/**
 * 创建汇报一次性状态机。
 *
 * @param {object} [options]
 * @param {() => number} [options.now] 可注入时钟（毫秒时间戳）；默认 Date.now
 * @param {number} [options.ttlMs] prepared 状态的有效期；过期不发送、不补发；默认 30 分钟
 */
export function createBackgroundPatrolReportOnce(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const now = typeof source.now === 'function' ? source.now : () => Date.now();
  const ttlMs = hasOwn(source, 'ttlMs') ? source.ttlMs : DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw createError('createBackgroundPatrolReportOnce: ttlMs 必须是正整数毫秒', 'REPORT_ONCE_INVALID_TTL');
  }

  let current = null;
  let lastReadIndex = 0;
  let seenKeys = [];
  const stats = { draws: 0, attempts: 0 };

  function clockNow() {
    const value = now();
    if (!isTimestamp(value)) {
      throw createError('汇报状态机：now() 必须返回有限毫秒时间戳', 'REPORT_ONCE_INVALID_CLOCK');
    }
    return value;
  }

  function resolveAt(value) {
    const timestamp = value === undefined ? clockNow() : asTimestamp(value);
    if (!isTimestamp(timestamp)) {
      throw createError('汇报状态机：at 必须是有限毫秒时间戳或 Date', 'REPORT_ONCE_INVALID_AT');
    }
    return timestamp;
  }

  function stateOf() {
    if (current === null) return 'idle';
    if (current.settledAt !== null) return current.outcome;
    if (current.dispatchedAt !== null) return 'dispatched';
    return 'prepared';
  }

  function rememberKey(key) {
    seenKeys.push(key);
    if (seenKeys.length > REPORT_ONCE_MAX_SEEN_KEYS) {
      seenKeys = seenKeys.slice(seenKeys.length - REPORT_ONCE_MAX_SEEN_KEYS);
    }
  }

  function clearCurrent() {
    current = null;
  }

  function isPreparedExpired(at) {
    return current !== null && current.dispatchedAt === null && current.settledAt === null
      ? at - current.preparedAt > ttlMs
      : false;
  }

  function snapshot() {
    return {
      schemaVersion: REPORT_ONCE_SNAPSHOT_VERSION,
      state: stateOf(),
      readIndex: current === null ? null : current.readIndex,
      dedupeKey: current === null ? null : current.dedupeKey,
      probability: current === null ? null : current.probability,
      shouldReport: current === null ? null : current.shouldReport,
      random: current === null ? null : current.random,
      preparedAt: current === null ? null : current.preparedAt,
      dispatchedAt: current === null ? null : current.dispatchedAt,
      settledAt: current === null ? null : current.settledAt,
      outcome: current === null ? null : current.outcome,
      lastReadIndex,
      seenKeys: [...seenKeys],
      stats: { draws: stats.draws, attempts: stats.attempts },
    };
  }

  /**
   * 为某一次实际读取做「唯一一次」概率抽签。
   *
   * @param {{ readIndex:number, dedupeKey:string, random?:number, at?:number|Date }} request
   *   `random` 在非 0 概率档必填；第 7 次及以后（0 档）可省略，此时不抽签、返回 random:null。
   * @returns {{ok:true, readIndex:number, dedupeKey:string, probability:number, random:number|null,
   *            shouldReport:boolean, state:'idle'|'prepared'}
   *          | {ok:false, reason:'duplicate-read'|'stale-read'|'duplicate-key'|'in-flight'}}
   */
  function prepare(request) {
    if (!isPlainObject(request)) {
      throw createError('汇报状态机：prepare 的入参必须是对象', 'REPORT_ONCE_INVALID_INPUT');
    }
    const { readIndex, dedupeKey, random } = request;
    if (!Number.isSafeInteger(readIndex) || readIndex < 1) {
      throw createError('汇报状态机：readIndex 必须是 >=1 的安全整数', 'REPORT_ONCE_INVALID_READ_INDEX');
    }
    if (!isDedupeKey(dedupeKey)) {
      throw createError(
        `汇报状态机：dedupeKey 必须是去除首尾空白后 1..${MAX_DEDUPE_KEY_LENGTH} 字的字符串`,
        'REPORT_ONCE_INVALID_DEDUPE_KEY',
      );
    }
    // 抽签已取消（用户 2026-11-01 决定）：不再要求随机数、不再受七档概率约束。
    // 每次「实际读取成功」都会进入 prepared，由模型在回合结束时决定是否分享（declined 语义）。
    // 旧快照里的 probability/random 仍可读入并结算（兼容），但新状态固定 probability=1、random=null。
    const at = resolveAt(request.at);

    if (readIndex === lastReadIndex) return { ok: false, reason: 'duplicate-read' };
    if (readIndex < lastReadIndex) return { ok: false, reason: 'stale-read' };

    if (current !== null && current.settledAt === null) {
      if (!isPreparedExpired(at)) {
        // prepared（等待 dispatch）或 dispatched（已在尝试）都不允许开始下一次读取。
        return { ok: false, reason: 'in-flight' };
      }
      // 过期 prepared：丢弃，不发送；readIndex/dedupeKey 检查继续兜底。
      clearCurrent();
    }

    if (seenKeys.includes(dedupeKey)) return { ok: false, reason: 'duplicate-key' };

    lastReadIndex = readIndex;
    const key = dedupeKey;
    rememberKey(key);
    // 抽签已取消，但保留 draws 计数（旧快照/审计字段仍可读；语义退化为「进入 prepared 的次数」）。
    stats.draws += 1;

    current = {
      readIndex,
      dedupeKey: key,
      probability: 1,
      shouldReport: true,
      random: null,
      preparedAt: at,
      dispatchedAt: null,
      settledAt: null,
      outcome: null,
    };
    return {
      ok: true,
      readIndex,
      dedupeKey: key,
      probability: 1,
      random: null,
      shouldReport: true,
      state: 'prepared',
    };
  }

  /**
   * 唯一一次发送尝试。只有 prepared 且未过期才放行。
   *
   * @param {{ at?: number|Date }} [request]
   * @returns {{ok:true, readIndex:number, state:'dispatched'}
   *          | {ok:false, reason:'not-prepared'|'already-dispatched'|'settled'|'expired'}}
   */
  function dispatch(request = {}) {
    const at = resolveAt(isPlainObject(request) ? request.at : undefined);
    if (current === null) return { ok: false, reason: 'not-prepared' };
    if (current.settledAt !== null) return { ok: false, reason: 'settled' };
    if (current.dispatchedAt !== null) return { ok: false, reason: 'already-dispatched' };
    // L1：dispatchedAt 不得早于 preparedAt，否则快照会被自身 restore 拒绝。
    if (at < current.preparedAt) {
      throw createClockRollbackError('dispatch 的 at 早于 preparedAt（拒绝写入回拨时间戳）');
    }
    if (isPreparedExpired(at)) {
      // 过期机会不补发：清空尝试态，但读取序号仍已消费（不能重抽签）。
      clearCurrent();
      return { ok: false, reason: 'expired' };
    }
    current.dispatchedAt = at;
    stats.attempts += 1;
    return { ok: true, readIndex: current.readIndex, state: 'dispatched' };
  }

  /**
   * 记录唯一一次尝试的结果。终态一旦写入不再改变（unknown 也是终态，不自动重试）。
   *
   * @param {{ outcome:'confirmed'|'failed'|'unknown', at?: number|Date }} request
   * @returns {{ok:true, state:'confirmed'|'failed'|'unknown', readIndex:number}
   *          | {ok:false, reason:'not-dispatched'|'already-settled'}}
   */
  function settle(request) {
    if (!isPlainObject(request)) {
      throw createError('汇报状态机：settle 的入参必须是对象', 'REPORT_ONCE_INVALID_INPUT');
    }
    const { outcome } = request;
    if (!TERMINAL_STATES.has(outcome)) {
      throw createError(
        `汇报状态机：outcome 必须是 ${REPORT_ONCE_OUTCOMES.join('/')} 之一`,
        'REPORT_ONCE_INVALID_OUTCOME',
      );
    }
    const at = resolveAt(request.at);
    if (current === null || current.dispatchedAt === null) return { ok: false, reason: 'not-dispatched' };
    if (current.settledAt !== null) return { ok: false, reason: 'already-settled' };
    // L1：settledAt 不得早于 dispatchedAt，否则快照会被自身 restore 拒绝。
    if (at < current.dispatchedAt) {
      throw createClockRollbackError('settle 的 at 早于 dispatchedAt（拒绝写入回拨时间戳）');
    }
    current.settledAt = at;
    current.outcome = outcome;
    return { ok: true, state: outcome, readIndex: current.readIndex };
  }

  /**
   * 恢复快照（重连/重启）。只接受字段互相一致的快照；损坏快照抛错且不覆盖当前状态。
   */
  function restore(raw) {
    const parsed = parseSnapshot(raw);
    if (!parsed.ok) {
      throw createError(`汇报状态机：拒绝恢复快照（${parsed.error}）`, 'REPORT_ONCE_INVALID_SNAPSHOT');
    }
    current = parsed.current;
    lastReadIndex = parsed.lastReadIndex;
    seenKeys = parsed.seenKeys;
    stats.draws = parsed.stats.draws;
    stats.attempts = parsed.stats.attempts;
    return snapshot();
  }

  /** 供新北京自然日/明确新会话使用：清空当前读取与去重历史，但保留累计统计（审计用）。 */
  function reset() {
    clearCurrent();
    lastReadIndex = 0;
    seenKeys = [];
    return snapshot();
  }

  return { prepare, dispatch, settle, snapshot, restore, reset };
}

function invalid(error) {
  return { ok: false, error };
}

function finiteOrNull(value) {
  return value === null || isTimestamp(value);
}

/**
 * 严格解析快照。字段缺失/类型错误/状态与字段矛盾都失败（fail-closed）。
 * 只依赖本模块 snapshot() 的产出形态，不做任何默认值回填——默认值等于静默放宽重发边界。
 */
function parseSnapshot(raw) {
  if (!isPlainObject(raw)) return invalid('快照必须是对象');
  if (raw.schemaVersion !== REPORT_ONCE_SNAPSHOT_VERSION) {
    return invalid(`schemaVersion 不受支持（期望 ${REPORT_ONCE_SNAPSHOT_VERSION}）`);
  }
  if (typeof raw.state !== 'string' || !REPORT_ONCE_STATES.includes(raw.state)) return invalid('state 非法');
  if (!isCount(raw.lastReadIndex)) return invalid('lastReadIndex 必须是 >=0 的整数');
  const stats = raw.stats;
  if (!isPlainObject(stats)) return invalid('stats 必须是对象');
  if (!isCount(stats.draws)) return invalid('stats.draws 必须是 >=0 的整数');
  if (!isCount(stats.attempts)) return invalid('stats.attempts 必须是 >=0 的整数');
  if (!Array.isArray(raw.seenKeys)) return invalid('seenKeys 必须是数组');
  if (raw.seenKeys.length > REPORT_ONCE_MAX_SEEN_KEYS) return invalid('seenKeys 超过上限');
  const seenKeys = [];
  const seen = new Set();
  for (const key of raw.seenKeys) {
    if (!isDedupeKey(key)) return invalid('seenKeys 含非法 dedupeKey');
    if (seen.has(key)) return invalid('seenKeys 含重复项');
    seen.add(key);
    seenKeys.push(key);
  }

  const state = raw.state;
  const idleFields = ['readIndex', 'dedupeKey', 'probability', 'shouldReport', 'random', 'preparedAt', 'dispatchedAt', 'settledAt', 'outcome'];
  if (state === 'idle') {
    for (const field of idleFields) {
      if (raw[field] !== null) return invalid(`idle 状态下 ${field} 必须是 null`);
    }
    return { ok: true, current: null, lastReadIndex: raw.lastReadIndex, seenKeys, stats: { draws: stats.draws, attempts: stats.attempts } };
  }

  if (!Number.isSafeInteger(raw.readIndex) || raw.readIndex < 1) return invalid('readIndex 必须是 >=1 的整数');
  if (!isDedupeKey(raw.dedupeKey)) return invalid('dedupeKey 非法');
  // 终态快照可能「落后」于 lastReadIndex：例如第 1 次读命中并汇报后，后续又读到 5、6，
  // 快照仍停在 readIndex=1 的终态。这种形状是合法的（prepare 侧的 duplicate-read/stale-read
  // 仍会兜住重放），因此只拒绝「超前于 lastReadIndex」这种不可能组合。
  if (raw.readIndex > raw.lastReadIndex) return invalid('readIndex 不得大于 lastReadIndex');
  if (!seen.has(raw.dedupeKey)) return invalid('seenKeys 必须包含当前 dedupeKey');
  if (raw.shouldReport !== true) return invalid('非 idle 状态下 shouldReport 必须为 true');
  if (!isTimestamp(raw.probability) || raw.probability <= 0 || raw.probability > 1) {
    return invalid('probability 必须是 (0,1] 内的数字');
  }
  // 抽签取消后新状态固定 probability=1 / random=null；旧快照仍按七档校验（只用于兼容恢复）。
  const legacyProbabilityOk = raw.probability === backgroundReportProbability(raw.readIndex);
  if (raw.probability !== 1 && !legacyProbabilityOk) {
    return invalid('probability 与当前约定不一致');
  }
  const newShape = raw.probability === 1 && (raw.random === null || raw.random === undefined);
  if (!newShape && (!isTimestamp(raw.random) || raw.random < 0 || raw.random >= 1)) return invalid('random 必须在 [0,1) 内');
  if (!isTimestamp(raw.preparedAt)) return invalid('preparedAt 必须是有限时间戳');
  if (!finiteOrNull(raw.dispatchedAt)) return invalid('dispatchedAt 必须是有限时间戳或 null');
  if (!finiteOrNull(raw.settledAt)) return invalid('settledAt 必须是有限时间戳或 null');
  if (raw.outcome !== null && !REPORT_ONCE_OUTCOMES.includes(raw.outcome)) return invalid('outcome 非法');

  if (state === 'prepared') {
    if (raw.dispatchedAt !== null || raw.settledAt !== null || raw.outcome !== null) {
      return invalid('prepared 状态下 dispatchedAt/settledAt/outcome 必须为 null');
    }
  } else if (state === 'dispatched') {
    if (raw.dispatchedAt === null) return invalid('dispatched 状态缺少 dispatchedAt');
    if (raw.dispatchedAt < raw.preparedAt) return invalid('dispatchedAt 早于 preparedAt');
    if (raw.settledAt !== null || raw.outcome !== null) return invalid('dispatched 状态下 settledAt/outcome 必须为 null');
  } else if (TERMINAL_STATES.has(state)) {
    if (raw.dispatchedAt === null) return invalid('终态缺少 dispatchedAt');
    if (raw.dispatchedAt < raw.preparedAt) return invalid('dispatchedAt 早于 preparedAt');
    if (raw.settledAt === null) return invalid('终态缺少 settledAt');
    if (raw.settledAt < raw.dispatchedAt) return invalid('settledAt 早于 dispatchedAt');
    if (raw.outcome !== state) return invalid('outcome 必须等于 state');
  } else {
    return invalid('state 非法');
  }

  return {
    ok: true,
    current: {
      readIndex: raw.readIndex,
      dedupeKey: raw.dedupeKey,
      probability: raw.probability,
      shouldReport: true,
      random: raw.random,
      preparedAt: raw.preparedAt,
      dispatchedAt: raw.dispatchedAt,
      settledAt: raw.settledAt,
      outcome: raw.outcome,
    },
    lastReadIndex: raw.lastReadIndex,
    seenKeys,
    stats: { draws: stats.draws, attempts: stats.attempts },
  };
}
