/**
 * 后台巡逻第四阶段：贴吧「每天最多 N 次实际自主访问」唯一持久账本（N 可配置 0..99，默认 6）。
 *
 * 这是本任务里贴吧自主访问额度的**唯一权威**（纯模块，未接入生产）：
 *  · 不导入 bridge / tieba-lib / MCP / 预设，不启动调度器，不联网、不读 Cookie、不发请求；
 *  · 不引入内容封禁：状态文件只有 schemaVersion / 北京日键 / 当日次数 / 最近访问时间；
 *  · 未来接线点：`src/tieba-lib.js` 的 `onBeforeTiebaRequest` 在真正 fetch 之前 await 一次
 *    `reserve({reason})`，返回 `{ok:false}` 即阻止本次抓取。多页读帖（fetchThreadPages）在请求边界
 *    只调用一次钩子，因此天然只算一次；`reason:'user'` 的用户明确查询走不扣额度的分支。
 *  · 旧的内存闸门（createTiebaPatrolGate）未来必须迁移/退场，不能与新账本并行计数（否则两套权威）。
 *
 * 语义：
 *  · 自主访问（reason='patrol'，缺省）：北京时间自然日最多「当前有效上限」次（默认 6，可配置 0..99），
 *    超限返回 `{ok:false, reason:'daily-cap'}`；上限只是**判定阈值**，绝不写盘、调整上限不清空/不改写当天 used；
 *  · 用户明确查询（reason='user'）：不占自主额度、不被日上限拦住、不写盘（不留计数痕迹）；
 *  · 跨北京零点（UTC+8 00:00）：计数重置；时钟回拨 fail-closed（`clock-rollback`，不退回旧日额度）。
 *  · 时间基准（task-15 L3）：可选 `at` 只做合法性校验（不得晚于 now、不得早于 now 5 分钟），
 *    实际记账时间固定为 `max(at, clock)`，因此**不能用 at 回填跨过北京零点去借昨日剩余额度**；
 *    日键永远取注入时钟的当前北京时间日。
 *
 * 持久化（与 background-patrol-state.mjs 同风格）：
 *  · 先克隆/组装下一份状态 -> 同目录唯一临时文件（randomUUID + 'wx'）-> rename 原子替换 -> 才提交内存；
 *  · 任一步失败：清理临时文件、保留旧内存与旧文件，抛出带 code 的原始错误；
 *  · load 只把 ENOENT 当空白 ready，且绝不创建文件/目录；空文件、坏 JSON、未知版本、字段矛盾一律
 *    fail-closed（状态永久 failed，所有方法 reject，原文件字节绝不覆盖）。
 *  · 父目录缺失时 load 仍可 ready；首次成功 reserve 前会 mkdir(recursive)。
 *
 * 已知限制（如实标注）：
 *  · 许可在请求发出前落盘，若之后 fetch 根本没发出（崩溃/钩子后异常），可能多计一次；这是保守方向
 *    （不会超额度），本模块**不提供退还接口**，避免把退还变成绕过额度的后门；
 *  · 只保证单 Node 进程、单实例、同一 filePath 内的串行一致性（共享 promise 队列），
 *    **不做跨进程锁**：同一 filePath 被两个进程同时写时可能各自记账、互相覆盖（task-15 L7）；
 *  · 持久化只做「同目录临时文件 + rename 原子替换」，**没有 fsync/fdatasync**：进程崩溃时不会出现
 *    半截文件，但掉电/系统崩溃后不能保证数据已落盘（task-15 L6；rename 原子性与掉电持久性是两回事）；
 *  · 没有真实路径默认值，filePath 必须由调用方注入（测试用临时目录）。
 */

import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { beijingPatrolDayKey } from './background-patrol-state.mjs';

/** 账本 schema 版本；不是这个版本一律 failed，绝不静默重置当日额度。 */
export const TIEBA_PATROL_LEDGER_VERSION = 1;

/** 默认每日上限：北京时间自然日内最多 6 次实际自主访问（可由 options.limit / reserve({limit}) 调整 0..99）。 */
export const TIEBA_PATROL_DEFAULT_DAILY_CAP = 6;

/** 兼容别名：旧代码/旧测试引用的 TIEBA_PATROL_DAILY_CAP 仍等于默认值 6（语义不再是固定硬上限）。 */
export const TIEBA_PATROL_DAILY_CAP = TIEBA_PATROL_DEFAULT_DAILY_CAP;

/** 可配置日上限的合法闭区间 [0, 99]：0 = 完全禁止自主访问；99 = 允许的最大值。 */
export const TIEBA_PATROL_MIN_DAILY_CAP = 0;
export const TIEBA_PATROL_MAX_DAILY_CAP = 99;

/** 允许的预留原因：patrol=自主访问（计额度）；user=用户明确查询（不占额度）。 */
export const TIEBA_PATROL_RESERVE_REASONS = Object.freeze(['patrol', 'user']);

const MINUTE_MS = 60 * 1000;
const MAX_EXPLICIT_CLOCK_SKEW_MS = 5 * MINUTE_MS;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 日上限合法性：必须是 [0, 99] 的整数（拒绝 NaN/Infinity/小数/字符串/null 等）。 */
function isDailyCap(value) {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= TIEBA_PATROL_MIN_DAILY_CAP
    && value <= TIEBA_PATROL_MAX_DAILY_CAP;
}

/** 错误信息里安全展示非法配置值（不抛错、不泄漏对象内容）。 */
function describeConfigValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function asTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Number.NaN;
}

function isValidDayKey(value) {
  if (typeof value !== 'string' || !DAY_KEY_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isNotFoundError(error) {
  return error !== null && typeof error === 'object' && error.code === 'ENOENT';
}

function createError(message, code, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * 创建贴吧自主访问唯一账本。返回方法全部异步；调用方必须先 await load()。
 *
 * @param {object} options
 * @param {string} options.filePath 账本文件路径（必须注入；没有默认真实路径）
 * @param {{ now?: () => number } | (() => number)} [options.clock] 可注入时钟
 * @param {{ readFile?: Function, mkdir?: Function, writeFile?: Function, rename?: Function, unlink?: Function }} [options.fsOps] 可注入文件系统
 * @param {number} [options.limit] 每日自主访问上限，整数 0..99（缺省 6）；非法值构造期抛 TypeError
 */
export function createTiebaPatrolLedger(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const { filePath, clock, fsOps, limit } = source;

  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new TypeError('createTiebaPatrolLedger: options.filePath 必须是非空字符串（不提供默认真实路径）');
  }

  // L15：日上限可配置 0..99，缺省 6；非法值在构造期就抛 TypeError（绝不静默降级成默认值）。
  // limit 只是判定阈值，不进入持久化状态（见 parseLedgerText / persist 的字段白名单）。
  const configuredLimit = limit === undefined ? TIEBA_PATROL_DEFAULT_DAILY_CAP : limit;
  if (!isDailyCap(configuredLimit)) {
    throw new TypeError(
      `createTiebaPatrolLedger: options.limit 必须是 ${TIEBA_PATROL_MIN_DAILY_CAP}..${TIEBA_PATROL_MAX_DAILY_CAP} 的整数`
      + `（收到 ${describeConfigValue(limit)}，绝不静默降级）`,
    );
  }

  let now;
  if (typeof clock === 'function') now = () => clock();
  else if (clock !== null && typeof clock === 'object' && typeof clock.now === 'function') now = () => clock.now();
  else now = () => Date.now();

  const ops = isPlainObject(fsOps) ? fsOps : {};
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

  function clockNow() {
    const value = now();
    if (!isTimestamp(value)) {
      throw createError('贴吧账本：clock.now() 必须返回有限毫秒时间戳', 'TIEBA_PATROL_LEDGER_INVALID_CLOCK');
    }
    return value;
  }

  function resolveAt(value) {
    const clockValue = clockNow();
    if (value === undefined) return clockValue;
    const timestamp = asTimestamp(value);
    if (!isTimestamp(timestamp)) {
      throw new TypeError('贴吧账本：at 必须是有限毫秒时间戳（或 Date）');
    }
    if (timestamp > clockValue || clockValue - timestamp > MAX_EXPLICIT_CLOCK_SKEW_MS) {
      throw new RangeError('贴吧账本：at 只能是当前或最近的历史时间，不能借未来/过久历史时间推进日账');
    }
    // L3：`at` 只用于兼容调用方显式时间戳；实际记账时间不得早于时钟，
    // 否则跨零点回填会继续消耗昨日额度（同一窗口可能出现昨日 5 次 + 今日 5 次）。
    return Math.max(timestamp, clockValue);
  }

  /**
   * 解析本次 reserve 的有效上限：单次 `limit` 覆盖实例值；非法值抛带 code 的错误（fail-closed，
   * 绝不静默回落到默认值/实例值）。注意 undefined 表示「未覆盖」，null 是非法值。
   */
  function resolveLimit(perCallLimit) {
    if (perCallLimit === undefined) return configuredLimit;
    if (!isDailyCap(perCallLimit)) {
      throw createError(
        `贴吧账本：reserve.limit 必须是 ${TIEBA_PATROL_MIN_DAILY_CAP}..${TIEBA_PATROL_MAX_DAILY_CAP} 的整数`
        + `（收到 ${describeConfigValue(perCallLimit)}，fail-closed）`,
        'TIEBA_PATROL_LEDGER_INVALID_LIMIT',
      );
    }
    return perCallLimit;
  }

  function assertReady() {
    if (phase === 'failed') {
      const detail = failure !== null && failure.message ? failure.message : '账本文件损坏或版本不受支持';
      throw createError(`贴吧账本不可用（已 failed）：${detail}`, 'TIEBA_PATROL_LEDGER_FAILED', failure);
    }
    if (phase !== 'ready') {
      throw createError('贴吧账本尚未加载：调用方必须先 await load()', 'TIEBA_PATROL_LEDGER_NOT_LOADED');
    }
  }

  /**
   * 只读视图：相对「今天」的当前计数（跨零点但尚未 reserve 时按 0 显示，不落盘）。
   * `limit` 用调用方给定的有效上限（缺省为实例 configuredLimit）；`used` 可能大于 `limit`
   * （例如调低上限后），此时 `remaining` 恒为 0，绝不出现负值。
   */
  function effectiveView(todayKey, limit = configuredLimit) {
    const relation = todayKey === current.day ? 0 : (todayKey < current.day ? -1 : 1);
    const day = relation > 0 ? todayKey : current.day;
    const used = relation > 0 ? 0 : current.used;
    const lastAccessAt = relation > 0 ? null : current.lastAccessAt;
    return {
      schemaVersion: TIEBA_PATROL_LEDGER_VERSION,
      day,
      used,
      limit,
      remaining: Math.max(0, limit - used),
      lastAccessAt,
      clockRollback: relation < 0,
    };
  }

  function snapshotView() {
    // 使用注入时钟的“现在”判断跨界；只读，不写盘。
    return effectiveView(beijingPatrolDayKey(clockNow()));
  }

  /**
   * 持久化：唯一临时文件（randomUUID + 'wx' 排他创建）-> rename 替换 -> 之后才提交内存。
   * 失败时清理临时文件、保留旧内存/旧文件，并原样抛出（保留 code 如 EPERM/ENOSPC）。
   */
  async function persist(nextState) {
    const tempPath = path.join(directory, `.${baseName}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const payload = JSON.stringify(nextState);
    let tempAttempted = false;
    try {
      await mkdir(directory, { recursive: true });
      tempAttempted = true;
      await writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(tempPath, filePath);
    } catch (error) {
      if (tempAttempted) {
        try {
          await unlink(tempPath);
        } catch {
          // 清理失败不掩盖原始错误：内存与正式文件仍未被提交。
        }
      }
      if (error !== null && typeof error === 'object') {
        try {
          error.tiebaPatrolLedgerPersist = true;
        } catch {
          // 冻结/只读错误对象：不改它，直接抛。
        }
      }
      throw error;
    }
  }

  function parseLedgerText(rawText) {
    const text = typeof rawText === 'string' ? rawText : String(rawText ?? '');
    if (text.trim() === '') return { ok: false, error: '账本文件是空的' };
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, error: '账本不是合法 JSON' };
    }
    if (!isPlainObject(raw)) return { ok: false, error: '账本根必须是对象' };
    if (raw.schemaVersion !== TIEBA_PATROL_LEDGER_VERSION) {
      return { ok: false, error: `schemaVersion 不受支持（期望 ${TIEBA_PATROL_LEDGER_VERSION}，绝不自动重置额度）` };
    }
    if (!isValidDayKey(raw.day)) return { ok: false, error: 'day 不是合法的北京时间日期键' };
    // L15：used 的合法范围是 0..99（旧的 used<=6 文件一律可读）；不得再用 <=6 或 <=当前 limit 拒绝，
    // 否则调低上限后旧状态会被误判成损坏。limit 本身不是持久字段，这里只校验 used。
    if (!isCount(raw.used) || raw.used > TIEBA_PATROL_MAX_DAILY_CAP) {
      return { ok: false, error: `used 必须是 0..${TIEBA_PATROL_MAX_DAILY_CAP} 的整数` };
    }
    if (!(raw.lastAccessAt === null || isTimestamp(raw.lastAccessAt))) {
      return { ok: false, error: 'lastAccessAt 必须是有限时间戳或 null' };
    }
    if (raw.used === 0 && raw.lastAccessAt !== null) {
      return { ok: false, error: 'used=0 时 lastAccessAt 必须是 null' };
    }
    if (raw.used > 0) {
      if (raw.lastAccessAt === null) return { ok: false, error: 'used>0 时 lastAccessAt 不能是 null' };
      let accessDay;
      try {
        accessDay = beijingPatrolDayKey(raw.lastAccessAt);
      } catch {
        return { ok: false, error: 'lastAccessAt 超出可持久化范围' };
      }
      if (accessDay !== raw.day) return { ok: false, error: 'lastAccessAt 与 day 不在同一北京自然日' };
    }
    return {
      ok: true,
      state: {
        schemaVersion: TIEBA_PATROL_LEDGER_VERSION,
        day: raw.day,
        used: raw.used,
        lastAccessAt: raw.lastAccessAt,
      },
    };
  }

  async function loadInternal() {
    if (phase === 'ready') return snapshotView();
    if (phase === 'failed') {
      const detail = failure !== null && failure.message ? failure.message : '账本文件损坏或版本不受支持';
      throw createError(`贴吧账本不可用（已 failed）：${detail}`, 'TIEBA_PATROL_LEDGER_FAILED', failure);
    }
    let rawText;
    try {
      rawText = await readFile(filePath, 'utf8');
    } catch (error) {
      if (!isNotFoundError(error)) {
        const detail = error !== null && typeof error === 'object' && error.message ? error.message : String(error);
        failure = createError(`贴吧账本读取失败：${detail}`, 'TIEBA_PATROL_LEDGER_LOAD_FAILED', error);
        phase = 'failed';
        throw failure;
      }
      // 只有「文件不存在」才是空白 ready：绝不创建文件、绝不 mkdir。
      current = {
        schemaVersion: TIEBA_PATROL_LEDGER_VERSION,
        day: beijingPatrolDayKey(clockNow()),
        used: 0,
        lastAccessAt: null,
      };
      phase = 'ready';
      return snapshotView();
    }
    const parsed = parseLedgerText(rawText);
    if (!parsed.ok) {
      failure = createError(`贴吧账本文件不可用（${parsed.error}）`, 'TIEBA_PATROL_LEDGER_FAILED');
      phase = 'failed';
      throw failure;
    }
    current = parsed.state;
    phase = 'ready';
    return snapshotView();
  }

  async function snapshotInternal() {
    assertReady();
    return snapshotView();
  }

  async function reserveInternal(request) {
    assertReady();
    const payload = isPlainObject(request) ? request : {};
    const reason = hasOwn(payload, 'reason') ? payload.reason : 'patrol';
    if (!TIEBA_PATROL_RESERVE_REASONS.includes(reason)) {
      throw createError(
        `贴吧账本：reason 必须是 ${TIEBA_PATROL_RESERVE_REASONS.join('/')} 之一（未知原因 fail-closed）`,
        'TIEBA_PATROL_LEDGER_INVALID_REASON',
      );
    }
    // 有效上限：单次 limit 覆盖实例值；非法值在这里 fail-closed（抛带 code 的错误，不写盘）。
    const effectiveLimit = resolveLimit(payload.limit);
    const timestamp = resolveAt(payload.at);
    const todayKey = beijingPatrolDayKey(timestamp);

    if (reason === 'user') {
      // 用户明确查询：不占自主额度、不被上限拦住、不写盘。
      const view = effectiveView(todayKey, effectiveLimit);
      return { ok: true, counted: false, used: view.used, limit: view.limit, remaining: view.remaining };
    }

    const relation = todayKey === current.day ? 0 : (todayKey < current.day ? -1 : 1);
    if (relation < 0) return { ok: false, reason: 'clock-rollback' };

    const base = relation > 0
      ? { schemaVersion: TIEBA_PATROL_LEDGER_VERSION, day: todayKey, used: 0, lastAccessAt: null }
      : current;
    if (base.used >= effectiveLimit) {
      // used 可能大于 effectiveLimit（调低上限/旧状态），原样返回 used；remaining 恒为 0。
      return { ok: false, reason: 'daily-cap', used: base.used, limit: effectiveLimit, remaining: 0 };
    }
    const next = {
      schemaVersion: TIEBA_PATROL_LEDGER_VERSION,
      day: base.day,
      used: base.used + 1,
      lastAccessAt: timestamp,
    };
    // 先持久化成功，才提交内存并发放许可：落盘失败 = 不放行。
    // 注意：持久化对象不含 limit（上限不是持久字段，调上限不能改写当天 used/文件字节）。
    await persist(next);
    current = next;
    return {
      ok: true,
      counted: true,
      used: next.used,
      limit: effectiveLimit,
      remaining: Math.max(0, effectiveLimit - next.used),
    };
  }

  function enqueue(task) {
    const result = queue.then(() => task());
    // 队列指针只反映“是否结束”：单次失败不能毒化后续调用。
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    load: () => enqueue(loadInternal),
    snapshot: () => enqueue(snapshotInternal),
    reserve: (request) => enqueue(() => reserveInternal(request)),
  };
}
