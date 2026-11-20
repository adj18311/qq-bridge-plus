/**
 * 后台巡逻第二阶段：持久日账与预算状态（独立可测，尚未接生产 bridge）。
 *
 * 职责边界（有意保持很小）：
 *  · 只维护北京时间日账、每日额度、桶级最小间隔、下一次计划时间，以及未来的暂停/写失败字段；
 *  · 不导入桥接、不启动定时器、不访问贴吧/小黑盒/DSH、不发网络请求、不写日志；
 *  · 不存 Cookie、令牌、模型文本或平台原始响应：schema 只有数值、日期键与白名单状态字段；
 *  · 只保证单 Node 进程、单实例、同一 filePath 内的串行一致性（不做跨进程锁）；
 *    也没有默认真实路径，filePath 必须由调用方注入（测试用临时目录）。
 *
 * 状态机：uninitialized -> ready | failed
 *  · 只有「文件不存在（ENOENT）」可以变成空白的 ready，而且 load 绝不创建文件；
 *  · 空文件、坏 JSON、缺/未知 schemaVersion 一律 failed：之后任何方法都 reject，原文件绝不覆盖；
 *  · 每次持久化都「同目录临时文件 -> rename 替换」，失败时丢弃本次克隆变更、内存与原文件保持一致，
 *    并清理临时文件；共享队列在单次失败后仍可继续服务后续调用。
 *
 * 日界线固定为北京时间（UTC+8，无夏令时）00:00：用「时间戳加 8 小时后的 UTC 字段」计算日期键，
 * 与宿主时区无关。日键只允许单调前进：更小的日期 fail-closed 返回 clock-rollback 且不写盘。
 */

import fsPromises from 'node:fs/promises';
import path from 'node:path';

/** 状态文件 schema 版本；不是这个版本一律 failed，绝不静默重置预算。 */
export const PATROL_STATE_VERSION = 1;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
/** 北京时间固定 UTC+8（无夏令时）。 */
const BEIJING_OFFSET_MS = 8 * HOUR_MS;
const MAX_EXPLICIT_CLOCK_SKEW_MS = 5 * MINUTE_MS;

/** 内部固定表（先建普通对象，再深冻结导出）。 */
const BUCKET_TABLE = {
  tieba: {
    read: { dailyCap: 6, minIntervalMs: 0 },
  },
  xiaoheihe: {
    read: { dailyCap: 14, minIntervalMs: 0 },
    post: { dailyCap: 2, minIntervalMs: 3 * HOUR_MS },
    comment: { dailyCap: 12, minIntervalMs: 3 * MINUTE_MS },
  },
};

/**
 * 平台/桶的固定额度表（深冻结）：tieba 只读 6/日；小黑盒读取 14/日、发帖 2/日且间隔 3 小时、
 * 评论/回复合计 12/日且间隔 3 分钟。贴吧原有的 3 秒 / 每分钟 6 次 / 验证冷却仍由原 limiter 管，
 * 这里不复制。
 */
export const BACKGROUND_PATROL_BUCKETS = Object.freeze(
  Object.fromEntries(
    Object.entries(BUCKET_TABLE).map(([platform, buckets]) => [
      platform,
      Object.freeze(
        Object.fromEntries(
          Object.entries(buckets).map(([bucket, rule]) => [bucket, Object.freeze({ ...rule })]),
        ),
      ),
    ]),
  ),
);

const PLATFORMS = Object.freeze(Object.keys(BACKGROUND_PATROL_BUCKETS));
/** 每个平台的桶名（顺序稳定：克隆与写盘都按它来）。 */
const BUCKETS = Object.freeze(
  Object.fromEntries(
    PLATFORMS.map((platform) => [
      platform,
      Object.freeze(Object.keys(BACKGROUND_PATROL_BUCKETS[platform])),
    ]),
  ),
);

/** status 的默认值；白名单外的字段既不能落盘，也不会出现在 snapshot 里。 */
const STATUS_DEFAULTS = Object.freeze({
  paused: false,
  pausedReason: null,
  consecutiveWriteFailures: 0,
  pausedAt: null,
  resumedAt: null,
});

const PAUSE_REASONS = new Set(['login-required', 'captcha', 'write-failures', 'network-unavailable']);

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDayKey(value) {
  if (typeof value !== 'string' || !DAY_KEY_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Number.NaN;
}

/**
 * 毫秒时间戳 -> 北京时间日期键（YYYY-MM-DD）。
 *
 * 固定 UTC+8：先把时间戳加 8 小时，再取 UTC 字段，所以结果与宿主机时区 / 夏令时无关。
 * 纯函数从严：非法时间直接抛 TypeError。
 */
export function beijingPatrolDayKey(at) {
  const ms = asTimestamp(at);
  if (!Number.isFinite(ms)) {
    throw new TypeError('beijingPatrolDayKey: at 必须是有限毫秒时间戳');
  }
  const shifted = new Date(ms + BEIJING_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  if (!Number.isFinite(shifted.getTime()) || year < 1000 || year > 9999) {
    throw new RangeError('beijingPatrolDayKey: at 超出可持久化的北京时间日期范围');
  }
  return `${year}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

function defaultStatus() {
  return { ...STATUS_DEFAULTS };
}

function emptyPlatformState(platform) {
  const daily = {};
  const lastActionAt = {};
  for (const bucket of BUCKETS[platform]) {
    daily[bucket] = 0;
    lastActionAt[bucket] = null;
  }
  return {
    daily,
    reportAttempts: 0,
    nextAt: null,
    status: defaultStatus(),
    lastActionAt,
  };
}

function emptyState(dayKey) {
  const platforms = {};
  for (const platform of PLATFORMS) platforms[platform] = emptyPlatformState(platform);
  return { schemaVersion: PATROL_STATE_VERSION, day: dayKey, platforms };
}

/**
 * 只按 schema 克隆：未知字段不复制（因此永远不落盘），返回值可安全交给调用方。
 * 也是 snapshot 深拷贝的唯一实现。
 */
function cloneState(source) {
  const platforms = {};
  for (const platform of PLATFORMS) {
    const from = source.platforms[platform];
    const daily = {};
    const lastActionAt = {};
    for (const bucket of BUCKETS[platform]) {
      daily[bucket] = from.daily[bucket];
      lastActionAt[bucket] = from.lastActionAt[bucket];
    }
    platforms[platform] = {
      daily,
      reportAttempts: from.reportAttempts,
      nextAt: from.nextAt,
      status: {
        paused: from.status.paused,
        pausedReason: from.status.pausedReason,
        consecutiveWriteFailures: from.status.consecutiveWriteFailures,
        pausedAt: from.status.pausedAt,
        resumedAt: from.status.resumedAt,
      },
      lastActionAt,
    };
  }
  return { schemaVersion: PATROL_STATE_VERSION, day: source.day, platforms };
}

function isCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNullableTimestamp(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isNotFoundError(error) {
  if (error === null || typeof error !== 'object') return false;
  return error.code === 'ENOENT';
}

function parseStatus(raw) {
  if (raw === undefined) return { ok: true, status: defaultStatus() };
  if (!isPlainObject(raw)) return { ok: false, error: 'status 必须是对象' };
  const status = defaultStatus();
  if (hasOwn(raw, 'paused')) {
    if (typeof raw.paused !== 'boolean') return { ok: false, error: 'status.paused 必须是布尔值' };
    status.paused = raw.paused;
  }
  if (hasOwn(raw, 'pausedReason')) {
    if (raw.pausedReason !== null && (typeof raw.pausedReason !== 'string' || !PAUSE_REASONS.has(raw.pausedReason))) {
      return { ok: false, error: 'status.pausedReason 必须是受支持的暂停原因或 null' };
    }
    status.pausedReason = raw.pausedReason;
  }
  if (hasOwn(raw, 'consecutiveWriteFailures')) {
    if (!isCount(raw.consecutiveWriteFailures)) {
      return { ok: false, error: 'status.consecutiveWriteFailures 必须是 >=0 的整数' };
    }
    status.consecutiveWriteFailures = raw.consecutiveWriteFailures;
  }
  if (hasOwn(raw, 'pausedAt')) {
    if (!isNullableTimestamp(raw.pausedAt)) {
      return { ok: false, error: 'status.pausedAt 必须是有限时间戳或 null' };
    }
    status.pausedAt = raw.pausedAt;
  }
  if (hasOwn(raw, 'resumedAt')) {
    if (!isNullableTimestamp(raw.resumedAt)) {
      return { ok: false, error: 'status.resumedAt 必须是有限时间戳或 null' };
    }
    status.resumedAt = raw.resumedAt;
  }
  return { ok: true, status };
}

/**
 * 解析并严格校验状态文件。
 *
 * 预算数据（daily counts）缺失/非法 -> 直接失败：默认成 0 等于静默重置预算，是这里最不能犯的错。
 * reportAttempts 不参与任何放行判定（只是记录），缺失时补 0 不会放宽额度，所以允许缺省。
 * 未知字段一律丢弃（不落盘），未知平台也丢弃（向前兼容）。
 */
function parseStateText(rawText) {
  const text = typeof rawText === 'string' ? rawText : String(rawText ?? '');
  if (text.trim() === '') return { ok: false, error: '状态文件是空的' };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '状态不是合法 JSON' };
  }
  if (!isPlainObject(raw)) return { ok: false, error: '状态根必须是对象' };
  if (raw.schemaVersion !== PATROL_STATE_VERSION) {
    return { ok: false, error: `state schemaVersion 不受支持（期望 ${PATROL_STATE_VERSION}，绝不自动重置）` };
  }
  if (!isValidDayKey(raw.day)) {
    return { ok: false, error: 'day 不是合法的北京时间日期键' };
  }
  if (!isPlainObject(raw.platforms)) return { ok: false, error: 'platforms 必须是对象' };
  const platforms = {};
  for (const platform of PLATFORMS) {
    const source = raw.platforms[platform];
    if (!isPlainObject(source)) return { ok: false, error: `platforms.${platform} 缺失或不是对象` };
    if (!isPlainObject(source.daily)) return { ok: false, error: `platforms.${platform}.daily 必须是对象` };
    const daily = {};
    for (const bucket of BUCKETS[platform]) {
      if (!isCount(source.daily[bucket])) {
        return { ok: false, error: `platforms.${platform}.daily.${bucket} 必须是 >=0 的整数` };
      }
      daily[bucket] = source.daily[bucket];
    }
    let reportAttempts = 0;
    if (hasOwn(source, 'reportAttempts')) {
      if (!isCount(source.reportAttempts)) {
        return { ok: false, error: `platforms.${platform}.reportAttempts 必须是 >=0 的整数` };
      }
      reportAttempts = source.reportAttempts;
    }
    let nextAt = null;
    if (hasOwn(source, 'nextAt')) {
      if (!isNullableTimestamp(source.nextAt)) {
        return { ok: false, error: `platforms.${platform}.nextAt 必须是有限时间戳或 null` };
      }
      nextAt = source.nextAt;
    }
    const parsedStatus = parseStatus(source.status);
    if (!parsedStatus.ok) return { ok: false, error: `platforms.${platform}.${parsedStatus.error}` };
    const lastActionAt = {};
    const rawLast = source.lastActionAt;
    if (hasOwn(source, 'lastActionAt') && !isPlainObject(rawLast)) {
      return { ok: false, error: `platforms.${platform}.lastActionAt 必须是对象` };
    }
    for (const bucket of BUCKETS[platform]) {
      const value = isPlainObject(rawLast) && hasOwn(rawLast, bucket) ? rawLast[bucket] : null;
      if (!isNullableTimestamp(value)) {
        return { ok: false, error: `platforms.${platform}.lastActionAt.${bucket} 必须是有限时间戳或 null` };
      }
      lastActionAt[bucket] = value;
    }
    platforms[platform] = {
      daily,
      reportAttempts,
      nextAt,
      status: parsedStatus.status,
      lastActionAt,
    };
  }
  return { ok: true, state: { schemaVersion: PATROL_STATE_VERSION, day: raw.day, platforms } };
}

/**
 * 创建后台巡逻状态实例。返回的方法全是异步的；调用方必须先 await load()。
 *
 * 返回：
 *  · load() —— 读文件。ENOENT -> 空白 ready（不创建文件）；空/坏/未知版本 -> failed，promise reject；
 *  · snapshot() —— 当前状态的深拷贝（schemaVersion/day/platforms）；
 *  · tryConsume({platform,bucket,at?}) —— 同一临界区内做日切换、日上限、桶级最小间隔，
 *    成功才落盘；返回 {ok:true,used,limit} / {ok:false,reason:'daily-cap'} /
 *    {ok:false,reason:'min-interval',waitMs} / {ok:false,reason:'clock-rollback'}；
 *  · setNextAt(platform,nextAt,at?) —— 记录下一次计划时间（有限时间戳或 null）；
 *  · noteReportAttempt(platform,at?) —— 当天汇报尝试 +1（不改任何额度，也不提高概率）；
 *  · setPlatformStatus(platform,patch,at?) —— 只复制白名单状态字段，未知字段不落盘。
 *
 * 所有 mutation 走同一条 promise 队列串行执行；单次失败只让那一次 reject，队列继续可用。
 *
 * @param {object} options
 * @param {string} options.filePath 状态文件路径（必须由调用方注入；没有默认真实路径）
 * @param {{ now?: () => number } | (() => number)} [options.clock] 可注入时钟
 * @param {{ readFile?: Function, mkdir?: Function, writeFile?: Function, rename?: Function, unlink?: Function }} [options.fsOps]
 */
export function createBackgroundPatrolState(options = {}) {
  const source = options !== null && typeof options === 'object' ? options : {};
  const { filePath, clock, fsOps } = source;

  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new TypeError('createBackgroundPatrolState: options.filePath 必须是非空字符串（不提供默认真实路径）');
  }

  let now;
  if (typeof clock === 'function') now = () => clock();
  else if (clock !== null && typeof clock === 'object' && typeof clock.now === 'function') now = () => clock.now();
  else now = () => Date.now();

  const ops = fsOps !== null && typeof fsOps === 'object' ? fsOps : {};
  const readFile = typeof ops.readFile === 'function' ? ops.readFile : fsPromises.readFile;
  const mkdir = typeof ops.mkdir === 'function' ? ops.mkdir : fsPromises.mkdir;
  const writeFile = typeof ops.writeFile === 'function' ? ops.writeFile : fsPromises.writeFile;
  const rename = typeof ops.rename === 'function' ? ops.rename : fsPromises.rename;
  const unlink = typeof ops.unlink === 'function' ? ops.unlink : fsPromises.unlink;

  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);

  let phase = 'uninitialized';
  let current = null;
  let failure = null;
  let queue = Promise.resolve();
  let tempSeq = 0;

  function createError(message, code, cause) {
    const error = new Error(message);
    error.code = code;
    if (cause !== undefined) error.cause = cause;
    return error;
  }

  function assertReady() {
    if (phase === 'failed') {
      const detail = failure !== null && failure.message ? failure.message : '状态文件损坏或版本不受支持';
      throw createError(`背景巡逻状态不可用（已 failed）：${detail}`, 'PATROL_STATE_FAILED', failure);
    }
    if (phase !== 'ready') {
      throw createError('背景巡逻状态尚未加载：调用方必须先 await load()', 'PATROL_STATE_NOT_LOADED');
    }
  }

  function resolveAt(value) {
    const clockNow = now();
    if (typeof clockNow !== 'number' || !Number.isFinite(clockNow)) {
      throw new TypeError('背景巡逻状态：clock.now() 必须返回有限毫秒时间戳');
    }
    if (value === undefined) {
      return clockNow;
    }
    const timestamp = asTimestamp(value);
    if (!Number.isFinite(timestamp)) {
      throw new TypeError('背景巡逻状态：at 必须是有限毫秒时间戳（或 Date）');
    }
    if (timestamp > clockNow || clockNow - timestamp > MAX_EXPLICIT_CLOCK_SKEW_MS) {
      throw new RangeError('背景巡逻状态：at 只能是当前或最近的历史时间，不能借未来/过久历史时间推进日账');
    }
    return timestamp;
  }

  function assertPlatform(platform) {
    if (typeof platform !== 'string' || !hasOwn(BACKGROUND_PATROL_BUCKETS, platform)) {
      throw new TypeError(`背景巡逻状态：未知平台 ${String(platform)}`);
    }
  }

  function bucketRule(platform, bucket) {
    if (typeof bucket !== 'string' || !hasOwn(BACKGROUND_PATROL_BUCKETS[platform], bucket)) {
      throw new TypeError(`背景巡逻状态：平台 ${platform} 没有桶 ${String(bucket)}`);
    }
    return BACKGROUND_PATROL_BUCKETS[platform][bucket];
  }

  /** 比较传入日期键与当前日期键：-1 回拨、0 同日、1 前进。日期键定长，字典序即时间序。 */
  function dayRelation(dayKey) {
    if (dayKey === current.day) return 0;
    return dayKey < current.day ? -1 : 1;
  }

  /** 按本次 at 的日期键准备一份待提交克隆：前进则清空日计数，同日则原样复制。 */
  function stagedForDay(dayKey, relation) {
    const next = cloneState(current);
    if (relation <= 0) return next;
    next.day = dayKey;
    for (const platform of PLATFORMS) {
      const platformState = next.platforms[platform];
      for (const bucket of BUCKETS[platform]) platformState.daily[bucket] = 0;
      platformState.reportAttempts = 0;
    }
    return next;
  }

  /**
   * 持久化：同目录临时文件 -> rename 替换 -> 之后才允许调用方提交内存。
   * 任一环节失败：清理临时文件、把原错误（保留 code，例如 EPERM）抛出，
   * 内存状态与磁盘原文件都不动。
   */
  async function persist(nextState) {
    tempSeq += 1;
    const tempPath = path.join(directory, `.${baseName}.${process.pid}.${tempSeq}.tmp`);
    const payload = JSON.stringify(nextState);
    let tempAttempted = false;
    try {
      await mkdir(directory, { recursive: true });
      tempAttempted = true;
      await writeFile(tempPath, payload, 'utf8');
      await rename(tempPath, filePath);
    } catch (error) {
      if (tempAttempted) {
        try {
          await unlink(tempPath);
        } catch {
          // 清理失败不掩盖原始错误：临时文件可能留在同目录，但内存与原文件仍未被提交。
        }
      }
      if (error !== null && typeof error === 'object') {
        try {
          error.patrolStatePersist = true;
        } catch {
          // 冻结/只读的错误对象：不改它，直接抛。
        }
      }
      throw error;
    }
  }

  async function loadInternal() {
    if (phase === 'ready') return cloneState(current);
    if (phase === 'failed') {
      const detail = failure !== null && failure.message ? failure.message : '状态文件损坏或版本不受支持';
      throw createError(`背景巡逻状态不可用（已 failed）：${detail}`, 'PATROL_STATE_FAILED', failure);
    }
    let rawText;
    try {
      rawText = await readFile(filePath, 'utf8');
    } catch (error) {
      if (!isNotFoundError(error)) {
        const detail = error !== null && typeof error === 'object' && error.message ? error.message : String(error);
        failure = createError(`背景巡逻状态读取失败：${detail}`, 'PATROL_STATE_LOAD_FAILED', error);
        phase = 'failed';
        throw failure;
      }
      // 只有「文件不存在」才是空白 ready：绝不创建文件、绝不 mkdir。
      current = emptyState(beijingPatrolDayKey(resolveAt(undefined)));
      phase = 'ready';
      return cloneState(current);
    }
    const parsed = parseStateText(rawText);
    if (!parsed.ok) {
      failure = createError(`背景巡逻状态文件不可用（${parsed.error}）`, 'PATROL_STATE_LOAD_FAILED');
      phase = 'failed';
      throw failure;
    }
    current = parsed.state;
    phase = 'ready';
    return cloneState(current);
  }

  async function snapshotInternal() {
    assertReady();
    return cloneState(current);
  }

  async function tryConsumeInternal(request) {
    assertReady();
    const payload = request !== null && typeof request === 'object' ? request : {};
    const platform = payload.platform;
    const bucket = payload.bucket;
    assertPlatform(platform);
    const rule = bucketRule(platform, bucket);
    const timestamp = resolveAt(payload.at);
    const dayKey = beijingPatrolDayKey(timestamp);
    const relation = dayRelation(dayKey);
    if (relation < 0) return { ok: false, reason: 'clock-rollback' };
    // 日切换、日上限、最小间隔都在这一份克隆上判定；失败直接返回，绝不写盘、绝不提交内存。
    const next = stagedForDay(dayKey, relation);
    const platformState = next.platforms[platform];
    const used = platformState.daily[bucket];
    if (used >= rule.dailyCap) return { ok: false, reason: 'daily-cap' };
    const lastActionAt = platformState.lastActionAt[bucket];
    if (lastActionAt !== null) {
      const elapsed = timestamp - lastActionAt;
      if (rule.minIntervalMs > 0) {
        if (elapsed < rule.minIntervalMs) {
          return { ok: false, reason: 'min-interval', waitMs: rule.minIntervalMs - elapsed };
        }
      } else if (elapsed < 0) {
        // 无最小间隔的桶也要对「同一天内的时钟回拨」fail-closed。
        return { ok: false, reason: 'clock-rollback' };
      }
    }
    platformState.daily[bucket] = used + 1;
    platformState.lastActionAt[bucket] = timestamp;
    await persist(next);
    current = next;
    return { ok: true, used: used + 1, limit: rule.dailyCap };
  }

  async function setNextAtInternal(platform, nextAt, at) {
    assertReady();
    assertPlatform(platform);
    if (!(nextAt === null || (typeof nextAt === 'number' && Number.isFinite(nextAt)))) {
      throw new TypeError('背景巡逻状态：nextAt 必须是有限毫秒时间戳或 null');
    }
    const timestamp = resolveAt(at);
    if (nextAt !== null && nextAt <= timestamp) {
      throw new TypeError('背景巡逻状态：nextAt 必须晚于记录时刻，过期计划应由调度器重排而非补偿执行');
    }
    const dayKey = beijingPatrolDayKey(timestamp);
    const relation = dayRelation(dayKey);
    if (relation < 0) return { ok: false, reason: 'clock-rollback' };
    const next = stagedForDay(dayKey, relation);
    next.platforms[platform].nextAt = nextAt;
    await persist(next);
    current = next;
    return { ok: true };
  }

  async function noteReportAttemptInternal(platform, at) {
    assertReady();
    assertPlatform(platform);
    const timestamp = resolveAt(at);
    const dayKey = beijingPatrolDayKey(timestamp);
    const relation = dayRelation(dayKey);
    if (relation < 0) return { ok: false, reason: 'clock-rollback' };
    const next = stagedForDay(dayKey, relation);
    // 只加「对应平台」的汇报尝试次数；额度、间隔、概率都不在这里改动。
    next.platforms[platform].reportAttempts += 1;
    await persist(next);
    current = next;
    return { ok: true };
  }

  /** 白名单复制：只取已知的五个字段，未知字段忽略（因此永远不落盘），值非法则拒绝。 */
  function cleanStatusPatch(patch) {
    if (!isPlainObject(patch)) {
      throw new TypeError('背景巡逻状态：status patch 必须是对象');
    }
    const cleaned = {};
    if (hasOwn(patch, 'paused')) {
      if (typeof patch.paused !== 'boolean') {
        throw new TypeError('背景巡逻状态：status.paused 必须是布尔值');
      }
      cleaned.paused = patch.paused;
    }
    if (hasOwn(patch, 'pausedReason')) {
      if (patch.pausedReason !== null && (typeof patch.pausedReason !== 'string' || !PAUSE_REASONS.has(patch.pausedReason))) {
        throw new TypeError('背景巡逻状态：status.pausedReason 必须是受支持的暂停原因或 null');
      }
      cleaned.pausedReason = patch.pausedReason;
    }
    if (hasOwn(patch, 'consecutiveWriteFailures')) {
      if (!isCount(patch.consecutiveWriteFailures)) {
        throw new TypeError('背景巡逻状态：status.consecutiveWriteFailures 必须是 >=0 的整数');
      }
      cleaned.consecutiveWriteFailures = patch.consecutiveWriteFailures;
    }
    if (hasOwn(patch, 'pausedAt')) {
      if (!isNullableTimestamp(patch.pausedAt)) {
        throw new TypeError('背景巡逻状态：status.pausedAt 必须是有限时间戳或 null');
      }
      cleaned.pausedAt = patch.pausedAt;
    }
    if (hasOwn(patch, 'resumedAt')) {
      if (!isNullableTimestamp(patch.resumedAt)) {
        throw new TypeError('背景巡逻状态：status.resumedAt 必须是有限时间戳或 null');
      }
      cleaned.resumedAt = patch.resumedAt;
    }
    return cleaned;
  }

  async function setPlatformStatusInternal(platform, patch, at) {
    assertReady();
    assertPlatform(platform);
    const cleaned = cleanStatusPatch(patch);
    const timestamp = resolveAt(at);
    const dayKey = beijingPatrolDayKey(timestamp);
    const relation = dayRelation(dayKey);
    if (relation < 0) return { ok: false, reason: 'clock-rollback' };
    if (Object.keys(cleaned).length === 0) return { ok: true };
    const next = stagedForDay(dayKey, relation);
    // 纯复制：恢复（paused=false）也不回滚/清零任何 counts。
    Object.assign(next.platforms[platform].status, cleaned);
    await persist(next);
    current = next;
    return { ok: true };
  }

  function enqueue(task) {
    const result = queue.then(() => task());
    // 队列指针只反映「是否结束」，不把失败传给下一次调用：单次失败不能毒化后续队列。
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    load: () => enqueue(loadInternal),
    snapshot: () => enqueue(snapshotInternal),
    tryConsume: (request) => enqueue(() => tryConsumeInternal(request)),
    setNextAt: (platform, nextAt, at) => enqueue(() => setNextAtInternal(platform, nextAt, at)),
    noteReportAttempt: (platform, at) => enqueue(() => noteReportAttemptInternal(platform, at)),
    setPlatformStatus: (platform, patch, at) => enqueue(() => setPlatformStatusInternal(platform, patch, at)),
  };
}

