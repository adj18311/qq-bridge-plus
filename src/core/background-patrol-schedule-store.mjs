/**
 * 后台巡逻：调度器持久衔接（**纯模块，未接线**）。
 *
 * 目标（交接卡步骤 C/D）：把「下一次机会时间 / 启动代次 / 最近一次 run|skip」从纯内存调度器
 * 接到可持久化、可重启恢复的 store；同时保持与现有 `background-patrol-scheduler.mjs`
 * 的语义对齐（**不修改该文件**，只 import 其区间表与 07:00–23:00 窗口判定）。
 *
 * 设计要点：
 *  · 单一权威状态文件：schemaVersion=1；generation 单调递增；两平台各自 nextAt/lastRun/lastSkip。
 *  · 默认无副作用：create 不创建文件；load 只读；首次成功写盘前才 mkdir 父目录。
 *  · 坏状态 fail-closed：坏 JSON / 空文件 / 未知版本 / 字段缺失或未知 / 跨字段矛盾一律拒绝加载
 *    （抛 `BACKGROUND_PATROL_SCHEDULE_LOAD_FAILED` / `...STATE_INVALID`），原文件字节保留；
 *    绝不把损坏状态静默当成空状态（那会重置 nextAt/代次，导致重复触发）。
 *  · **load 错误码契约（F1）**：非 ENOENT 读失败与「注入 clock 不可用」一律抛
 *    `LOAD_FAILED`（带 cause；坏内容也统一包成 LOAD_FAILED，其 `cause.code` 可为 STATE_INVALID）。
 *    调用方只需按 code 分支，不再出现无 code 的普通 Error；failed 后 load/snapshot 沿用同一 coded 错误。
 *  · 原子写：同目录 `${base}.${randomUUID()}.tmp` 以 'wx'+0600 排他创建 → 写入 → datasync →
 *    rename → best-effort 同步目录；失败清理临时文件并返回
 *    `{ok:false, reason:'persist-failed', causeCode}`（F5：causeCode 为底层 code，如 EACCES/ENOSPC），
 *    内存不提交。
 *  · 并发串行：实例内 Promise 队列；同一 filePath **进程内单实例**（同步注册表，重复 create 抛
 *    `SINGLETON_CONFLICT`，close 释放）。跨进程/fsync 承诺不在本切片（文档化限制）。
 *  · planNext：区间内均匀随机（与 scheduler 完全相同的取值/夹紧规则，随机源可注入）；
 *    **过期机会不补队列**：若持久 nextAt <= now，本次只是从 now 重新规划，并把 lastExpiredAt
 *    记下来；绝不返回过期时间当作「现在该跑」。
 *  · **request.random 契约（F6）**：`undefined` = 使用构造注入的随机源（缺省 Math.random）；
 *    显式传入非函数（字符串/数字/null/对象）→ `{ok:false, reason:'invalid-random'}`，不改状态。
 *  · **随机夹紧（F4）**：比例归一与取整集中在一个内部 helper，并由「与 scheduler 逐输入差分」
 *    测试锁定（不修改 scheduler）。
 *  · markOpportunity：按 generation 幂等；旧代次返回 `stale-generation`（旧定时器回调不可重入），
 *    未来代次返回 `unknown-generation`；run/skip 分别落 lastRunAt/lastSkipAt(+reason)。
 *  · **判断顺序（F7）**：输入校验 → 时间解析 → **clock-rollback（时间不可信优先 fail-closed）**
 *    → stale-generation → unknown-generation → 同代次幂等 → 持久化。
 *    因此「回拨 + 旧代次」同时出现时稳定返回 `clock-rollback`（有测试固定）。
 *  · **recordPlan（task-53）**：登记「调度器已算好的下一次机会」而**不重新抽样**。`at` 必须是
 *    真实记录时间（bridge 传 `Date.now()`），`nextAt` 必须是已算好的机会时间；时间契约：
 *    `nextAt` 严格晚于 `at`（`nextAt <= at` 是坏输入 `invalid-time`），`at` 早于 `lastSeenAt`
 *    为 `clock-rollback`。旧 `nextAt <= at` 只记 `lastExpiredAt`，绝不回填/执行。
 *    返回 `{ok:true, platform, at, nextAt, planCount}`，其中 `at` 是写入 lastSeenAt 的时间。
 *  · 时间单调：planNext/markOpportunity/advanceGeneration 都拒绝早于 lastSeenAt 的时间。
 *
 * 明确不做：不启动/不取消定时器（调度器仍由 bridge 负责）；不判断 qqBusy/DSH 可用性；
 * 不真正执行平台访问；不写审计（审计模块另行接线）；不提供跨进程锁。
 */

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { PATROL_INTERVALS, isPatrolActiveTime } from './background-patrol-scheduler.mjs';

export const BACKGROUND_PATROL_SCHEDULE_VERSION = 1;

export const BACKGROUND_PATROL_SCHEDULE_ERROR_CODES = Object.freeze({
  /** 持久状态损坏/矛盾（fail-closed，绝不重置 nextAt/代次）。 */
  STATE_INVALID: 'BACKGROUND_PATROL_SCHEDULE_STATE_INVALID',
  /** load 阶段读/解析失败。 */
  LOAD_FAILED: 'BACKGROUND_PATROL_SCHEDULE_LOAD_FAILED',
  /** 同一 filePath 已有活实例。 */
  SINGLETON_CONFLICT: 'BACKGROUND_PATROL_SCHEDULE_SINGLETON_CONFLICT',
  /** close() 之后再调用。 */
  CLOSED: 'BACKGROUND_PATROL_SCHEDULE_CLOSED',
  /** 尚未 await load()。 */
  NOT_LOADED: 'BACKGROUND_PATROL_SCHEDULE_NOT_LOADED',
});

export const SCHEDULE_PLATFORMS = Object.freeze(['tieba', 'xiaoheihe']);

/** 与现有 scheduler 共用同一份区间表（引用同一对象，避免语义漂移）。 */
export const BACKGROUND_PATROL_INTERVALS = PATROL_INTERVALS;

/** 北京时间 07:00（含）–23:00（不含）窗口，直接复用 scheduler 的判定。 */
export function isBackgroundPatrolActiveTime(timestamp) {
  return isPatrolActiveTime(timestamp);
}

const PLATFORM_SET = new Set(SCHEDULE_PLATFORMS);
const STATE_KEYS = Object.freeze(['schemaVersion', 'generation', 'lastSeenAt', 'platforms']);
const PLATFORM_STATE_KEYS = Object.freeze([
  'nextAt', 'lastRunAt', 'lastSkipAt', 'lastSkipReason',
  'lastRunGeneration', 'lastSkipGeneration', 'lastExpiredAt', 'planCount',
]);
const MAX_SKIP_REASON_LENGTH = 200;
const TRUNCATE_SUFFIX = '…（已截断）';
const SINGLETON_REGISTRY_SYMBOL = Symbol.for('qq-bridge.background-patrol-schedule-store.instances');
const KIND_SET = new Set(['run', 'skip']);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function asTimestamp(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return isFiniteTimestamp(value) ? value : null;
}

function stateError(message) {
  const error = new Error(`xhh 调度状态不可用：${message}`);
  error.code = BACKGROUND_PATROL_SCHEDULE_ERROR_CODES.STATE_INVALID;
  return error;
}

function rejectUnknownKeys(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw stateError(`${label} 含不支持的字段 ${key}`);
  }
}

function codedError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function safeErrorCode(error) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined;
  return typeof code === 'string' && code !== '' ? code.slice(0, 64) : 'UNKNOWN';
}

// ── 纯规划函数 ───────────────────────────────────────────────────────────────

/** 随机比例归一（F4）：非有限或 <0 → 0；>1 → 1（与 scheduler 的 nextDelay 完全一致）。 */
function clampScheduleRatio(value) {
  const ratio = Number(value);
  if (!Number.isFinite(ratio) || ratio < 0) return 0;
  if (ratio > 1) return 1;
  return ratio;
}

/** 区间取整（F4）：delay = min + floor(ratio*(max-min))，再夹在 [min,max]。 */
function scheduleDelayForRatio(platform, ratio) {
  const { minMs, maxMs } = PATROL_INTERVALS[platform];
  let delayMs = minMs + Math.floor(clampScheduleRatio(ratio) * (maxMs - minMs));
  if (delayMs < minMs) delayMs = minMs;
  if (delayMs > maxMs) delayMs = maxMs;
  return delayMs;
}

/**
 * 规划下一次机会时间（纯函数，不改状态）。
 *
 * 均匀区间取法与现有 scheduler 完全一致（由上方 helper 集中实现，差分测试锁定）：
 *   ratio 非有限或 <0 → 0；>1 → 1；
 *   delay = min + floor(ratio * (max-min))，并夹在 [min,max]。
 * 本函数不判断 07:00–23:00：与 scheduler 一样，窗口在机会触发时判定；
 * 23:30 规划出的机会可以落在次日（跨日允许），过期与否由调用方用
 * `classifyPersistedOpportunity` 判定。
 *
 * @returns {{ok:true, platform:string, at:number, delayMs:number} | {ok:false, reason:string}}
 */
export function planNextOpportunity({ platform, now, random } = {}) {
  if (typeof platform !== 'string' || !PLATFORM_SET.has(platform)) {
    return { ok: false, reason: 'invalid-platform' };
  }
  const at = asTimestamp(now);
  if (at === null) return { ok: false, reason: 'invalid-time' };
  if (typeof random !== 'function') return { ok: false, reason: 'invalid-random' };

  let ratio;
  try {
    ratio = random();
  } catch {
    return { ok: false, reason: 'invalid-random' };
  }
  const delayMs = scheduleDelayForRatio(platform, ratio);
  return { ok: true, platform, at: at + delayMs, delayMs };
}

/**
 * 判定持久 nextAt 的类别（不返回 due，防止把过期机会补跑）。
 * 'none'（无计划）/ 'future' / 'expired'；坏输入返回 {ok:false}。
 */
export function classifyPersistedOpportunity({ nextAt, now } = {}) {
  const at = asTimestamp(now);
  if (at === null) return { ok: false, reason: 'invalid-time' };
  if (nextAt === null || nextAt === undefined) return 'none';
  if (!isFiniteTimestamp(nextAt)) return { ok: false, reason: 'invalid-time' };
  return nextAt <= at ? 'expired' : 'future';
}

// ── 状态构造 / 克隆 / 解析 ───────────────────────────────────────────────────

function createEmptyPlatformState() {
  return {
    nextAt: null,
    lastRunAt: null,
    lastSkipAt: null,
    lastSkipReason: null,
    lastRunGeneration: null,
    lastSkipGeneration: null,
    lastExpiredAt: null,
    planCount: 0,
  };
}

function createEmptyState(timestamp) {
  return {
    schemaVersion: BACKGROUND_PATROL_SCHEDULE_VERSION,
    generation: 0,
    lastSeenAt: timestamp,
    platforms: {
      tieba: createEmptyPlatformState(),
      xiaoheihe: createEmptyPlatformState(),
    },
  };
}

function cloneState(source) {
  const platforms = {};
  for (const platform of SCHEDULE_PLATFORMS) {
    const from = source.platforms[platform];
    platforms[platform] = {
      nextAt: from.nextAt,
      lastRunAt: from.lastRunAt,
      lastSkipAt: from.lastSkipAt,
      lastSkipReason: from.lastSkipReason,
      lastRunGeneration: from.lastRunGeneration,
      lastSkipGeneration: from.lastSkipGeneration,
      lastExpiredAt: from.lastExpiredAt,
      planCount: from.planCount,
    };
  }
  return {
    schemaVersion: BACKGROUND_PATROL_SCHEDULE_VERSION,
    generation: source.generation,
    lastSeenAt: source.lastSeenAt,
    platforms,
  };
}

/**
 * 严格解析并校验调度状态（对象或 JSON 字符串）。矛盾/缺失/未知字段抛 STATE_INVALID。
 * nextAt 允许是过去时间（那代表「过期机会」，由 planNext 重新规划，绝不直接执行）。
 */
export function parseScheduleState(rawState) {
  let raw = rawState;
  if (typeof raw === 'string') {
    if (raw.trim() === '') throw stateError('状态是空字符串');
    try {
      raw = JSON.parse(raw);
    } catch {
      throw stateError('状态不是合法 JSON');
    }
  }
  if (!isPlainObject(raw)) throw stateError('状态根必须是对象');
  rejectUnknownKeys(raw, STATE_KEYS, '状态');
  for (const key of STATE_KEYS) {
    if (!hasOwn(raw, key)) throw stateError(`状态缺少字段 ${key}`);
  }
  if (raw.schemaVersion !== BACKGROUND_PATROL_SCHEDULE_VERSION) throw stateError('schemaVersion 不受支持');
  if (!isCount(raw.generation)) throw stateError('generation 必须是 >=0 的整数');
  if (!isFiniteTimestamp(raw.lastSeenAt)) throw stateError('lastSeenAt 必须是有限毫秒时间戳');
  if (!isPlainObject(raw.platforms)) throw stateError('platforms 必须是对象');
  rejectUnknownKeys(raw.platforms, SCHEDULE_PLATFORMS, 'platforms');

  const platforms = {};
  for (const platform of SCHEDULE_PLATFORMS) {
    const from = raw.platforms[platform];
    if (!isPlainObject(from)) throw stateError(`platforms 缺少 ${platform}`);
    rejectUnknownKeys(from, PLATFORM_STATE_KEYS, `platforms.${platform}`);
    for (const key of PLATFORM_STATE_KEYS) {
      if (!hasOwn(from, key)) throw stateError(`platforms.${platform} 缺少字段 ${key}`);
    }
    if (!(from.nextAt === null || isFiniteTimestamp(from.nextAt))) {
      throw stateError(`platforms.${platform}.nextAt 必须是有限时间戳或 null`);
    }
    if (!(from.lastRunAt === null || isFiniteTimestamp(from.lastRunAt))) {
      throw stateError(`platforms.${platform}.lastRunAt 必须是有限时间戳或 null`);
    }
    if (!(from.lastSkipAt === null || isFiniteTimestamp(from.lastSkipAt))) {
      throw stateError(`platforms.${platform}.lastSkipAt 必须是有限时间戳或 null`);
    }
    if (!(from.lastExpiredAt === null || isFiniteTimestamp(from.lastExpiredAt))) {
      throw stateError(`platforms.${platform}.lastExpiredAt 必须是有限时间戳或 null`);
    }
    for (const key of ['lastRunAt', 'lastSkipAt', 'lastExpiredAt']) {
      if (from[key] !== null && from[key] > raw.lastSeenAt) {
        throw stateError(`platforms.${platform}.${key} 晚于 lastSeenAt（矛盾状态）`);
      }
    }
    if (!(from.lastSkipReason === null
      || (typeof from.lastSkipReason === 'string'
        && from.lastSkipReason.trim() !== ''
        && from.lastSkipReason.length <= MAX_SKIP_REASON_LENGTH))) {
      throw stateError(`platforms.${platform}.lastSkipReason 非法`);
    }
    if ((from.lastSkipAt === null) !== (from.lastSkipReason === null)) {
      throw stateError(`platforms.${platform} 的 lastSkipAt 与 lastSkipReason 互相矛盾`);
    }
    for (const key of ['lastRunGeneration', 'lastSkipGeneration']) {
      if (!(from[key] === null || isCount(from[key]))) {
        throw stateError(`platforms.${platform}.${key} 必须是 >=0 的整数或 null`);
      }
      if (from[key] !== null && from[key] > raw.generation) {
        throw stateError(`platforms.${platform}.${key} 大于当前 generation（矛盾状态）`);
      }
    }
    if ((from.lastRunAt === null) !== (from.lastRunGeneration === null)) {
      throw stateError(`platforms.${platform} 的 lastRunAt 与 lastRunGeneration 互相矛盾`);
    }
    if ((from.lastSkipAt === null) !== (from.lastSkipGeneration === null)) {
      throw stateError(`platforms.${platform} 的 lastSkipAt 与 lastSkipGeneration 互相矛盾`);
    }
    if (!isCount(from.planCount)) throw stateError(`platforms.${platform}.planCount 必须是 >=0 的整数`);
    platforms[platform] = {
      nextAt: from.nextAt,
      lastRunAt: from.lastRunAt,
      lastSkipAt: from.lastSkipAt,
      lastSkipReason: from.lastSkipReason,
      lastRunGeneration: from.lastRunGeneration,
      lastSkipGeneration: from.lastSkipGeneration,
      lastExpiredAt: from.lastExpiredAt,
      planCount: from.planCount,
    };
  }
  return {
    schemaVersion: BACKGROUND_PATROL_SCHEDULE_VERSION,
    generation: raw.generation,
    lastSeenAt: raw.lastSeenAt,
    platforms,
  };
}

// ── 可注入 fs ────────────────────────────────────────────────────────────────

function createDefaultFsOps() {
  return {
    readFile: (target, encoding) => fsPromises.readFile(target, encoding),
    mkdir: (target) => fsPromises.mkdir(target, { recursive: true }),
    writeFileExclusive: async (target, payload) => {
      const handle = await fsPromises.open(target, 'wx', 0o600);
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.datasync();
      } finally {
        await handle.close();
      }
    },
    rename: (from, to) => fsPromises.rename(from, to),
    unlink: (target) => fsPromises.unlink(target),
    syncDirectory: async (directory) => {
      if (process.platform === 'win32') return;
      let handle = null;
      try {
        handle = await fsPromises.open(directory, 'r');
        await handle.sync();
      } catch {
        // best-effort：掉电一致性不承诺。
      } finally {
        if (handle !== null) await handle.close().catch(() => {});
      }
    },
  };
}

function resolveFsOps(overrides) {
  const merged = createDefaultFsOps();
  if (isPlainObject(overrides)) {
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === 'function') merged[key] = value;
    }
  }
  return merged;
}

function resolveClock(clock) {
  if (clock === undefined || clock === null) return () => Date.now();
  if (typeof clock === 'function') return () => clock();
  if (typeof clock === 'object' && typeof clock.now === 'function') return () => clock.now();
  throw new TypeError('createBackgroundPatrolScheduleStore：clock 必须是函数或带 now() 的对象');
}

function getSingletonRegistry() {
  if (!(globalThis[SINGLETON_REGISTRY_SYMBOL] instanceof Map)) {
    Object.defineProperty(globalThis, SINGLETON_REGISTRY_SYMBOL, {
      value: new Map(),
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
  return globalThis[SINGLETON_REGISTRY_SYMBOL];
}

// ── Store ───────────────────────────────────────────────────────────────────

/**
 * 创建调度状态 store（进程内单实例 / 原子写 / 串行队列）。
 *
 * @param {object} options
 * @param {string} options.filePath 状态文件路径（必须显式注入，无默认生产路径）
 * @param {(() => number) | { now?: () => number }} [options.clock] 注入时钟
 * @param {() => number} [options.random] 注入随机源（缺省 Math.random）
 * @param {object} [options.fsOps] 可注入文件系统原语（测试用，缺省键自动合并）
 */
export function createBackgroundPatrolScheduleStore(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const filePath = source.filePath;
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new TypeError('createBackgroundPatrolScheduleStore：options.filePath 必须是非空字符串（无默认路径）');
  }
  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const registryKey = path.resolve(filePath);
  const clock = resolveClock(source.clock);
  const randomSource = typeof source.random === 'function' ? source.random : Math.random;
  const ops = resolveFsOps(source.fsOps);
  const registry = getSingletonRegistry();

  if (registry.has(registryKey)) {
    const error = new Error(`xhh 调度状态已被本进程另一实例独占（${filePath}）`);
    error.code = BACKGROUND_PATROL_SCHEDULE_ERROR_CODES.SINGLETON_CONFLICT;
    throw error;
  }
  const token = randomUUID();
  registry.set(registryKey, token);

  let phase = 'uninitialized';
  let current = null;
  let failure = null;
  let closed = false;
  let queue = Promise.resolve();

  function releaseSingleton() {
    if (registry.get(registryKey) === token) registry.delete(registryKey);
  }

  function notLoadedError() {
    const error = new Error('xhh 调度状态尚未 load()：调用方必须先 await load()');
    error.code = BACKGROUND_PATROL_SCHEDULE_ERROR_CODES.NOT_LOADED;
    return error;
  }

  function closedError() {
    const error = new Error('xhh 调度状态已 close()，不能继续使用');
    error.code = BACKGROUND_PATROL_SCHEDULE_ERROR_CODES.CLOSED;
    return error;
  }

  function assertReady() {
    if (closed) throw closedError();
    if (phase === 'ready') return;
    if (phase === 'failed') throw failure;
    throw notLoadedError();
  }

  function readTimestamp() {
    let value;
    try {
      value = clock();
    } catch {
      return null;
    }
    return isFiniteTimestamp(value) ? value : null;
  }

  function resolveEventTime(explicit) {
    const at = explicit === undefined || explicit === null ? readTimestamp() : asTimestamp(explicit);
    return at;
  }

  async function persist(nextState) {
    const tempPath = path.join(directory, `${baseName}.${randomUUID()}.tmp`);
    const payload = JSON.stringify(nextState);
    try {
      await ops.mkdir(directory);
      await ops.writeFileExclusive(tempPath, payload);
      await ops.rename(tempPath, filePath);
    } catch (error) {
      try {
        await ops.unlink(tempPath);
      } catch {
        // 清理失败不掩盖原始错误：旧文件未被覆盖，内存也未提交。
      }
      throw error;
    }
    try {
      await ops.syncDirectory(directory);
    } catch {
      // best-effort
    }
  }

  async function commit(nextState, failureReason) {
    try {
      await persist(nextState);
    } catch (error) {
      // F5：persist-failed 必须携带底层 causeCode（EACCES/ENOSPC/EPERM…），供调用方/审计区分。
      return { ok: false, reason: failureReason, causeCode: safeErrorCode(error) };
    }
    current = nextState;
    return null;
  }

  function failLoad(error) {
    failure = error;
    phase = 'failed';
    releaseSingleton();
    return error;
  }

  async function loadInternal() {
    if (closed) throw closedError();
    if (phase === 'ready') return cloneState(current);
    if (phase === 'failed') throw failure;

    let rawText;
    try {
      rawText = await ops.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // F1：非 ENOENT 读失败必须有 code（LOAD_FAILED），不能抛普通 Error。
        throw failLoad(codedError(
          BACKGROUND_PATROL_SCHEDULE_ERROR_CODES.LOAD_FAILED,
          `xhh 调度状态读取失败：${error?.message ?? String(error)}`,
          error,
        ));
      }
      const timestamp = readTimestamp();
      if (timestamp === null) {
        // F1：clock 不可用同样归入 LOAD_FAILED（无法安全创建空白状态）。
        throw failLoad(codedError(
          BACKGROUND_PATROL_SCHEDULE_ERROR_CODES.LOAD_FAILED,
          'xhh 调度状态：注入 clock 不可用，无法创建空白状态',
        ));
      }
      current = createEmptyState(timestamp);
      phase = 'ready';
      return cloneState(current);
    }
    try {
      current = parseScheduleState(rawText);
    } catch (error) {
      // 坏内容统一包成 LOAD_FAILED，cause.code 保留 STATE_INVALID 供排查。
      const wrapped = codedError(
        BACKGROUND_PATROL_SCHEDULE_ERROR_CODES.LOAD_FAILED,
        `xhh 调度状态文件不可用：${error?.message ?? String(error)}`,
        error,
      );
      throw failLoad(wrapped);
    }
    phase = 'ready';
    return cloneState(current);
  }

  async function planNextInternal(request) {
    assertReady();
    const payload = isPlainObject(request) ? request : {};
    const platform = payload.platform;
    if (typeof platform !== 'string' || !PLATFORM_SET.has(platform)) {
      return { ok: false, reason: 'invalid-platform' };
    }
    const at = resolveEventTime(payload.now);
    if (at === null) return { ok: false, reason: 'invalid-time' };
    if (at < current.lastSeenAt) return { ok: false, reason: 'clock-rollback' };

    // F6：request.random 契约——undefined 才表示“用构造注入的随机源”；显式传入非函数一律拒绝
    // （不再静默回退，避免调用方以为注入生效但其实用了 Math.random）。
    if (payload.random !== undefined && typeof payload.random !== 'function') {
      return { ok: false, reason: 'invalid-random' };
    }
    const randomFn = payload.random !== undefined
      ? payload.random
      : () => randomSource();
    const planned = planNextOpportunity({ platform, now: at, random: randomFn });
    if (!planned.ok) return planned;

    const next = cloneState(current);
    const platformState = next.platforms[platform];
    const previousNextAt = platformState.nextAt;
    const expired = previousNextAt !== null && previousNextAt <= at;
    platformState.nextAt = planned.at;
    platformState.planCount += 1;
    if (expired) platformState.lastExpiredAt = at;
    next.lastSeenAt = at;

    const failed = await commit(next, 'persist-failed');
    if (failed !== null) return failed;
    return {
      ok: true,
      platform,
      at: planned.at,
      delayMs: planned.delayMs,
      expired,
      previousNextAt,
    };
  }

  /**
   * task-53：登记「调度器已算好的下一次机会」，而不是把未来时间当成 now 再随机/再延迟。
   *  · at：真实记录时间（写入 lastSeenAt）；nextAt：已算好的下次机会（写入 platforms[*].nextAt）。
   *  · 契约：nextAt 必须**严格晚于** at（`nextAt <= at` → invalid-time；过期机会不补）；
   *    at 必须不早于 lastSeenAt（否则 clock-rollback）；两者都不改状态/不写盘。
   *  · 旧 nextAt <= at 只记 lastExpiredAt（过期不补），随后用本次 nextAt 覆盖。
   */
  async function recordPlanInternal(request) {
    assertReady();
    const payload = isPlainObject(request) ? request : {};
    if (typeof payload.platform !== 'string' || !PLATFORM_SET.has(payload.platform)) return { ok: false, reason: 'invalid-platform' };
    const at = resolveEventTime(payload.at);
    if (at === null || !isFiniteTimestamp(payload.nextAt)) return { ok: false, reason: 'invalid-time' };
    // F6：nextAt <= at 不是「马上就到」，而是坏输入——过期/零延迟机会不补，交由上层用真实 now 重算。
    if (payload.nextAt <= at) return { ok: false, reason: 'invalid-time' };
    if (at < current.lastSeenAt) return { ok: false, reason: 'clock-rollback' };
    const next = cloneState(current);
    const platform = next.platforms[payload.platform];
    if (platform.nextAt !== null && platform.nextAt <= at) platform.lastExpiredAt = at;
    platform.nextAt = payload.nextAt;
    platform.planCount += 1;
    next.lastSeenAt = at;
    const failed = await commit(next, 'persist-failed');
    if (failed !== null) return failed;
    return { ok: true, platform: payload.platform, at, nextAt: payload.nextAt, planCount: platform.planCount };
  }

  async function advanceGenerationInternal(request) {
    assertReady();
    const payload = isPlainObject(request) ? request : {};
    const at = resolveEventTime(payload.at);
    if (at === null) return { ok: false, reason: 'invalid-time' };
    if (at < current.lastSeenAt) return { ok: false, reason: 'clock-rollback' };
    const next = cloneState(current);
    next.generation += 1;
    next.lastSeenAt = at;
    const failed = await commit(next, 'persist-failed');
    if (failed !== null) return failed;
    return { ok: true, generation: next.generation };
  }

  async function markOpportunityInternal(request) {
    assertReady();
    const payload = isPlainObject(request) ? request : {};
    const platform = payload.platform;
    if (typeof platform !== 'string' || !PLATFORM_SET.has(platform)) {
      return { ok: false, reason: 'invalid-platform' };
    }
    const generation = payload.generation;
    if (!isCount(generation)) return { ok: false, reason: 'invalid-generation' };
    const kind = payload.kind;
    if (typeof kind !== 'string' || !KIND_SET.has(kind)) return { ok: false, reason: 'invalid-kind' };
    const at = resolveEventTime(payload.at);
    if (at === null) return { ok: false, reason: 'invalid-time' };

    let reason = null;
    if (kind === 'skip') {
      if (typeof payload.reason !== 'string'
        || payload.reason.trim() === ''
        || payload.reason.length > MAX_SKIP_REASON_LENGTH) {
        return { ok: false, reason: 'invalid-reason' };
      }
      reason = payload.reason;
    }

    if (at < current.lastSeenAt) return { ok: false, reason: 'clock-rollback' };
    if (generation < current.generation) return { ok: false, reason: 'stale-generation' };
    if (generation > current.generation) return { ok: false, reason: 'unknown-generation' };

    const existing = current.platforms[platform];
    if (kind === 'run' && existing.lastRunGeneration === generation) {
      return { ok: true, platform, generation, kind, duplicate: true };
    }
    if (kind === 'skip' && existing.lastSkipGeneration === generation) {
      return { ok: true, platform, generation, kind, duplicate: true };
    }

    const next = cloneState(current);
    const platformState = next.platforms[platform];
    if (kind === 'run') {
      platformState.lastRunAt = at;
      platformState.lastRunGeneration = generation;
    } else {
      platformState.lastSkipAt = at;
      platformState.lastSkipReason = reason;
      platformState.lastSkipGeneration = generation;
    }
    next.lastSeenAt = at;

    const failed = await commit(next, 'persist-failed');
    if (failed !== null) return failed;
    return { ok: true, platform, generation, kind, duplicate: false };
  }

  async function snapshotInternal() {
    assertReady();
    return cloneState(current);
  }

  function enqueue(task) {
    const result = queue.then(() => task());
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function closeInternal() {
    if (closed) return;
    closed = true;
    current = null;
    releaseSingleton();
  }

  return {
    load: () => enqueue(loadInternal),
    snapshot: () => enqueue(snapshotInternal),
    planNext: (request) => enqueue(() => planNextInternal(request)),
    recordPlan: (request) => enqueue(() => recordPlanInternal(request)),
    advanceGeneration: (request) => enqueue(() => advanceGenerationInternal(request)),
    markOpportunity: (request) => enqueue(() => markOpportunityInternal(request)),
    /** 当前内存状态的 JSON（供调用方自行原子落盘/诊断；不触发写入）。 */
    serialize: () => {
      if (closed) throw closedError();
      if (current === null) throw notLoadedError();
      return JSON.stringify(current);
    },
    close: () => enqueue(closeInternal),
  };
}
