/**
 * 后台巡逻步骤 D：结构化审计 + 7 自然日轮转（纯模块，尚未接入生产）。
 *
 * 职责边界（有意保持很小）：
 *  · 只写「本模块」审计文件：`<filePath 目录>/background-patrol-audit-YYYY-MM-DD.jsonl`（JSONL 追加）；
 *  · 不导入 bridge / 调度器 / MCP / 预设，不联网、不访问平台、不读 Cookie/凭据/QQ 数据；
 *  · 不记录消息正文、Cookie、token、文件路径、QQ 号等敏感内容：记录字段是固定白名单，
 *    未知字段一律拒绝（见下）；
 *  · 只保证「单进程、单实例、同一目录」的串行追加；不做跨进程锁，不提供 fsync/掉电持久性保证。
 *
 * 记录字段白名单（JSONL 每行一个对象，字段固定）：
 *  {
 *    v: 1,
 *    day: 'YYYY-MM-DD',            // 北京时间自然日（由 at 换算，固定 UTC+8）
 *    at: <有限毫秒时间戳>,          // 事件时间（缺省 = 注入时钟的 now）
 *    platform: 'tieba' | 'xiaoheihe',
 *    action: 'read'|'write'|'skip'|'pause'|'resume'|'report'|'unknown',
 *    result: 'allowed'|'denied'|'success'|'failure'|'unknown',
 *    reason: null | <原因码>,       // 小写机器码（^[a-z][a-z0-9-]{0,63}$），不接受自由文本
 *    quota: null | { <额度键>: <>=0 的安全整数> },  // 只允许 AUDIT_QUOTA_KEYS 里的固定键
 *    opId: null | <稳定操作 id>,    // ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$（调用方给的稳定 id）
 *    report: null | {               // 仅 action='report' 的结构化元数据；纯枚举，不含正文
 *      contentSource: 'model'|'template',
 *      classification: 'non-sensitive'|'sensitive'|'blocked',
 *      destination: 'owner'|'group',
 *      reportBlockPresent: boolean
 *    }
 *  }
 *  传入白名单外字段（message/cookie/token/path/qq/content/tid/url…）→ 整条拒绝、不落盘、不崩溃。
 *
 * 写入失败：`record()` 不抛异常，返回 `{ok:false, error:{code:'AUDIT_WRITE_FAILED', …}}`，
 * 并在 `status()` 里暴露 `failed` 计数、`lastWriteError`（原始错误码 + 截断消息）、
 * `lastWriteErrorAt`、`lastWriteOk`；`lastWriteError` 保持可见直到下一个成功写入之后也**不静默抹掉**
 * （避免“吞掉失败后声称完整记录”）。
 *
 * 7 自然日保留：`cleanup()` 只清理**本模块目录内**、文件名严格匹配
 * `^background-patrol-audit-\d{4}-\d{2}-\d{2}\.jsonl$` 的**普通文件**；保留今天 + 前 6 天（共 7 天）。
 * 安全规则（任何一条不满足都只拒绝，不 unlink）：
 *  · 名字含 `/`、`\` 或盘符前缀、解析后父目录不是本目录（`../`、绝对路径、子目录）→ 拒绝（path-escape）；
 *  · `lstat` 报告符号链接/junction → 拒绝（symlink）；
 *  · 非普通文件（目录等）→ 拒绝（not-a-file）；
 *  · 文件名日期非法 → 拒绝（invalid-day）；不匹配本模块命名的文件一律不动。
 *
 * 已知限制（如实标注）：
 *  · 无 fsync/fdatasync：append + rename 之外没有掉电持久性保证；
 *  · 单进程单实例；跨进程并发写同一目录未做锁；
 *  · 读取（readDay）只做 JSON 解析容错，不重新校验历史字段（历史 schema 兼容由调用方决定）；
 *  · `lastWriteError` 是内存态，不进审计文件（避免把底层路径/错误正文写进审计日志）；
 *  · `filePath` 是目录（不是单个文件）：构造函数不创建目录，首次成功写入时才 mkdir(recursive)。
 */

import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { beijingPatrolDayKey } from './background-patrol-state.mjs';

/** 审计文件 schema 版本（写入每行的 v 字段）。 */
export const BACKGROUND_PATROL_AUDIT_VERSION = 1;

/** 平台枚举（冻结）。 */
export const AUDIT_PLATFORMS = Object.freeze(['tieba', 'xiaoheihe', 'console']);

/** 动作枚举（冻结）。 */
export const AUDIT_ACTIONS = Object.freeze(['read', 'write', 'skip', 'pause', 'resume', 'report', 'unknown']);

/**
 * 结果枚举（冻结）。
 * allowed/denied：授权闸门判定；success/failure：已执行动作的真实结果；
 * unknown：已发起但结果无法确认（不得当成功）。
 * skipped/pending 为后续追加的封闭值，用于诚实区分「本次有意不处理」与「未送达待重试」，
 * 避免调用方把这两类语义塞进 failure/unknown 而丢失信息。
 */
export const AUDIT_RESULTS = Object.freeze(['allowed', 'denied', 'success', 'failure', 'unknown', 'skipped', 'pending']);

/**
 * 额度快照允许的固定数值键（冻结）：只存数值，不含任何正文/凭据/路径/QQ 号。
 * 未知键一律拒绝；值必须是 >=0 的安全整数（上限 1e9，防御异常大数）。
 */
export const AUDIT_QUOTA_KEYS = Object.freeze([
  'readUsed', 'readLimit', 'readRemaining',
  'writeUsed', 'writeLimit', 'writeRemaining',
  'postUsed', 'postLimit', 'commentUsed', 'commentLimit',
  'reportTier', 'readIndex', 'failures',
]);

/** 保留 7 个自然日（今天 + 前 6 天）。 */
export const AUDIT_RETENTION_DAYS = 7;

/** 本模块审计文件名前缀/后缀。 */
export const AUDIT_FILE_PREFIX = 'background-patrol-audit-';
export const AUDIT_FILE_SUFFIX = '.jsonl';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_QUOTA_VALUE = 1_000_000_000;
const MAX_OPID_LENGTH = 128;
const MAX_FILE_NAME_LENGTH = 200;
const MAX_ERROR_MESSAGE_LENGTH = 200;
const REASON_RE = /^[a-z][a-z0-9-]{0,63}$/;
const OPID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * operator：控制台操作者标识。只允许短机器码（专栏会话指纹），不含 QQ 号/昵称/令牌。
 * 巡逻/后台操作没有 operator（保持旧行字段集合不变）。
 */
const OPERATOR_RE = /^[a-z0-9][a-z0-9-]{4,38}[a-z0-9]$/;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * tooLongChars：汇报因超长被丢弃时的码点数（纯数值，不含正文）。
 * 与 operator 同样的追加方式：只有携带它的记录才出现该键，既有行字段集合与顺序不变。
 */
const ALLOWED_INPUT_FIELDS = new Set(['at', 'platform', 'action', 'result', 'reason', 'quota', 'opId', 'report', 'operator', 'tooLongChars']);

/** 汇报元数据（report 字段）允许的固定键与枚举：纯枚举、无自由文本，不能携带正文。 */
export const AUDIT_REPORT_FIELDS = Object.freeze(['contentSource', 'classification', 'destination', 'reportBlockPresent']);
const REPORT_SOURCES = Object.freeze(['model', 'template', 'none']);
const REPORT_CLASSIFICATIONS = Object.freeze(['non-sensitive', 'sensitive', 'blocked']);
const REPORT_DESTINATIONS = Object.freeze(['owner', 'group']);
/** destination 允许为 null：汇报未产出内容时没有去向，不能伪造 owner/group。 */
const REPORT_DESTINATION_NULLABLE = true;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function safeErrorCode(error) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined;
  return typeof code === 'string' && code.trim() !== '' ? code.slice(0, 64) : 'UNKNOWN';
}

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

function auditFileName(dayKey) {
  return `${AUDIT_FILE_PREFIX}${dayKey}${AUDIT_FILE_SUFFIX}`;
}

const AUDIT_FILE_RE = new RegExp(`^${AUDIT_FILE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d{4}-\\d{2}-\\d{2})${AUDIT_FILE_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

function assertReadyFor(phase, failureDetail) {
  if (phase === 'ready') return;
  const error = new Error('后台巡逻审计尚未加载：调用方必须先 await load()');
  error.code = 'AUDIT_NOT_LOADED';
  error.cause = failureDetail;
  throw error;
}

function cloneError(value) {
  if (!value || typeof value !== 'object') return null;
  return { code: value.code, message: value.message };
}

/**
 * 创建后台巡逻审计实例。
 *
 * @param {object} options
 * @param {string} options.filePath **本模块审计文件所在目录**（不是单个文件；必须显式注入）
 * @param {{ now?: () => number } | (() => number)} [options.clock] 可注入时钟
 * @param {{ mkdir?: Function, appendFile?: Function, readFile?: Function, readdir?: Function,
 *           lstat?: Function, unlink?: Function }} [options.fsOps] 可注入文件系统
 */
export function createBackgroundPatrolAudit(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const { filePath, clock, fsOps } = source;
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new TypeError('createBackgroundPatrolAudit: options.filePath 必须是审计目录的非空路径（不提供默认真实目录）');
  }
  const directory = path.resolve(filePath);

  let now;
  if (typeof clock === 'function') now = () => clock();
  else if (clock !== null && typeof clock === 'object' && typeof clock.now === 'function') now = () => clock.now();
  else now = () => Date.now();

  const ops = isPlainObject(fsOps) ? fsOps : {};
  const mkdir = typeof ops.mkdir === 'function' ? ops.mkdir : fsPromises.mkdir;
  const appendFile = typeof ops.appendFile === 'function' ? ops.appendFile : fsPromises.appendFile;
  const readFile = typeof ops.readFile === 'function' ? ops.readFile : fsPromises.readFile;
  const readdir = typeof ops.readdir === 'function' ? ops.readdir : fsPromises.readdir;
  const lstat = typeof ops.lstat === 'function' ? ops.lstat : fsPromises.lstat;
  const unlink = typeof ops.unlink === 'function' ? ops.unlink : fsPromises.unlink;

  let phase = 'uninitialized';
  let queue = Promise.resolve();
  const counters = { written: 0, failed: 0, rejected: 0 };
  let lastWriteError = null;
  let lastWriteErrorAt = null;
  let lastWriteOk = null;
  let lastWriteAt = null;

  function clockNow() {
    const value = now();
    if (!isTimestamp(value)) {
      const error = new TypeError('后台巡逻审计：clock.now() 必须返回有限毫秒时间戳');
      error.code = 'AUDIT_INVALID_CLOCK';
      throw error;
    }
    return value;
  }

  function assertReady() {
    assertReadyFor(phase, null);
  }

  function resolveAt(value, clockValue) {
    if (value === undefined) return { ok: true, at: clockValue };
    const timestamp = asTimestamp(value);
    if (!isTimestamp(timestamp)) return failure('AUDIT_INVALID_AT', 'at 必须是有限毫秒时间戳（或 Date）');
    if (timestamp > clockValue + MAX_FUTURE_SKEW_MS) {
      return failure('AUDIT_INVALID_AT', 'at 不能明显晚于当前时钟');
    }
    return { ok: true, at: timestamp };
  }

  function validateQuota(quota) {
    if (quota === undefined || quota === null) return { ok: true, quota: null };
    if (!isPlainObject(quota)) return failure('AUDIT_INVALID_QUOTA', 'quota 必须是对象或 null');
    const keys = Object.keys(quota);
    for (const key of keys) {
      if (!AUDIT_QUOTA_KEYS.includes(key)) return failure('AUDIT_INVALID_QUOTA', 'quota 含白名单以外的键');
      const value = quota[key];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_QUOTA_VALUE) {
        return failure('AUDIT_INVALID_QUOTA', 'quota 的值必须是 0..1e9 的安全整数');
      }
    }
    if (keys.length === 0) return { ok: true, quota: null };
    const normalized = {};
    for (const key of keys.slice().sort()) normalized[key] = quota[key];
    return { ok: true, quota: normalized };
  }

  function validateReport(report) {
    if (report === undefined || report === null) return { ok: true, report: null };
    if (!isPlainObject(report)) return failure('AUDIT_INVALID_REPORT', 'report 必须是对象或 null');
    for (const key of Object.keys(report)) {
      if (!AUDIT_REPORT_FIELDS.includes(key)) return failure('AUDIT_INVALID_REPORT', 'report 含白名单以外的键');
    }
    if (!REPORT_SOURCES.includes(report.contentSource)) return failure('AUDIT_INVALID_REPORT', 'report.contentSource 不在白名单');
    if (!REPORT_CLASSIFICATIONS.includes(report.classification)) return failure('AUDIT_INVALID_REPORT', 'report.classification 不在白名单');
    if (!(REPORT_DESTINATION_NULLABLE && report.destination === null)
      && !REPORT_DESTINATIONS.includes(report.destination)) {
      return failure('AUDIT_INVALID_REPORT', 'report.destination 不在白名单');
    }
    if (typeof report.reportBlockPresent !== 'boolean') return failure('AUDIT_INVALID_REPORT', 'report.reportBlockPresent 必须是布尔值');
    return {
      ok: true,
      report: {
        contentSource: report.contentSource,
        classification: report.classification,
        destination: report.destination,
        reportBlockPresent: report.reportBlockPresent,
      },
    };
  }

  function validateRecordRequest(payload, clockValue) {
    if (!isPlainObject(payload)) return failure('AUDIT_INVALID_RECORD', '审计记录必须是对象');
    for (const key of Object.keys(payload)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        // 不回显字段名/值：避免把可能的敏感文本带进错误信息。
        return failure('AUDIT_UNKNOWN_FIELD', '审计记录包含白名单以外的字段（敏感字段一律拒绝）');
      }
    }
    if (!AUDIT_PLATFORMS.includes(payload.platform)) {
      return failure('AUDIT_INVALID_ENUM', 'platform 必须是 tieba/xiaoheihe');
    }
    if (!AUDIT_ACTIONS.includes(payload.action)) {
      return failure('AUDIT_INVALID_ENUM', 'action 不在白名单');
    }
    if (!AUDIT_RESULTS.includes(payload.result)) {
      return failure('AUDIT_INVALID_ENUM', 'result 不在白名单');
    }
    let reason = null;
    if (payload.reason !== undefined && payload.reason !== null) {
      if (typeof payload.reason !== 'string' || !REASON_RE.test(payload.reason)) {
        return failure('AUDIT_INVALID_REASON', 'reason 必须是 1..64 字的小写机器原因码');
      }
      reason = payload.reason;
    }
    let opId = null;
    if (payload.opId !== undefined && payload.opId !== null) {
      if (typeof payload.opId !== 'string' || payload.opId.length > MAX_OPID_LENGTH || !OPID_RE.test(payload.opId)) {
        return failure('AUDIT_INVALID_OPID', 'opId 必须是 1..128 字的稳定操作 id');
      }
      opId = payload.opId;
    }
    let operator = null;
    if (payload.operator !== undefined && payload.operator !== null) {
      if (typeof payload.operator !== 'string' || !OPERATOR_RE.test(payload.operator)) {
        return failure('AUDIT_INVALID_OPERATOR', 'operator 必须是 6..40 字的小写机器码');
      }
      operator = payload.operator;
    }
    let tooLongChars = null;
    if (payload.tooLongChars !== undefined && payload.tooLongChars !== null) {
      const value = payload.tooLongChars;
      if (!Number.isSafeInteger(value) || value < 0 || value > MAX_QUOTA_VALUE) {
        return failure('AUDIT_INVALID_TOOLONG', 'tooLongChars 必须是 0..1e9 的安全整数');
      }
      tooLongChars = value;
    }
    const quotaResult = validateQuota(payload.quota);
    if (!quotaResult.ok) return quotaResult;
    const reportResult = validateReport(payload.report);
    if (!reportResult.ok) return reportResult;
    const atResult = resolveAt(payload.at, clockValue);
    if (!atResult.ok) return atResult;
    let day;
    try {
      day = beijingPatrolDayKey(atResult.at);
    } catch {
      return failure('AUDIT_INVALID_AT', 'at 超出可持久化的北京时间范围');
    }
    return {
      ok: true,
      record: {
        v: BACKGROUND_PATROL_AUDIT_VERSION,
        day,
        at: atResult.at,
        platform: payload.platform,
        action: payload.action,
        result: payload.result,
        reason,
        quota: quotaResult.quota,
        opId,
        // 兼容既有固定格式：只有汇报记录才追加 report；其余记录保持旧字段集合不变。
        ...(reportResult.report === null ? {} : { report: reportResult.report }),
        // 控制台专栏操作才追加 operator（巡逻行没有该字段，逐字节不变）。
        ...(operator === null ? {} : { operator }),
        // 只有超长丢弃的汇报才追加该数值键；其余行不含此字段。
        ...(tooLongChars === null ? {} : { tooLongChars }),
      },
    };
  }

  function statusInternal() {
    const clockValue = clockNow();
    const todayKey = beijingPatrolDayKey(clockValue);
    return {
      ok: phase === 'ready' && counters.failed === 0,
      directory,
      day: todayKey,
      filePath: path.resolve(path.join(directory, auditFileName(todayKey))),
      written: counters.written,
      failed: counters.failed,
      rejected: counters.rejected,
      lastWriteOk,
      lastWriteAt,
      lastWriteError: cloneError(lastWriteError),
      lastWriteErrorAt,
      retentionDays: AUDIT_RETENTION_DAYS,
    };
  }

  async function recordInternal(payload) {
    assertReady();
    const clockValue = clockNow();
    const validated = validateRecordRequest(payload, clockValue);
    if (!validated.ok) {
      counters.rejected += 1;
      return validated;
    }
    const record = validated.record;
    const target = path.resolve(path.join(directory, auditFileName(record.day)));
    const line = `${JSON.stringify(record)}\n`;
    try {
      await mkdir(directory, { recursive: true });
      await appendFile(target, line, 'utf8');
      counters.written += 1;
      lastWriteOk = true;
      lastWriteAt = clockValue;
      return { ok: true, record };
    } catch (error) {
      // 写入失败不崩溃：抛给调用方只会打断主流程；这里暴露状态让调用方自行降级。
      counters.failed += 1;
      lastWriteOk = false;
      lastWriteErrorAt = clockValue;
      lastWriteError = {
        code: safeErrorCode(error),
        message: truncate(error !== null && typeof error === 'object' && error.message ? error.message : error, MAX_ERROR_MESSAGE_LENGTH),
      };
      return failure('AUDIT_WRITE_FAILED', `审计写入失败（${lastWriteError.code}）：${lastWriteError.message}`);
    }
  }

  async function statusAsync() {
    assertReady();
    return statusInternal();
  }

  function parseDayKey(value) {
    const dayKey = value === undefined ? beijingPatrolDayKey(clockNow()) : value;
    if (!isValidDayKey(dayKey)) return failure('AUDIT_INVALID_DAY', 'day 必须是合法的北京时间日期键 YYYY-MM-DD');
    return { ok: true, day: dayKey };
  }

  async function readDayInternal(dayKey) {
    assertReady();
    const parsed = parseDayKey(dayKey);
    if (!parsed.ok) return parsed;
    const file = path.resolve(path.join(directory, auditFileName(parsed.day)));
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (isNotFoundError(error)) {
        return { ok: true, day: parsed.day, filePath: file, records: [], badLines: 0, blankLines: 0 };
      }
      return failure('AUDIT_READ_FAILED', `审计读取失败（${safeErrorCode(error)}）`);
    }
    const records = [];
    let badLines = 0;
    let blankLines = 0;
    for (const line of String(text).split('\n')) {
      if (line.trim() === '') {
        blankLines += 1;
        continue;
      }
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        badLines += 1;
        continue;
      }
      if (!isPlainObject(value)) {
        badLines += 1;
        continue;
      }
      records.push(value);
    }
    return { ok: true, day: parsed.day, filePath: file, records, badLines, blankLines };
  }

  function isEscapingName(name) {
    if (typeof name !== 'string' || name === '' || name.length > MAX_FILE_NAME_LENGTH) return true;
    if (name.includes('/') || name.includes('\\')) return true;
    if (/^[A-Za-z]:/.test(name)) return true;
    const target = path.resolve(directory, name);
    return path.dirname(target) !== directory;
  }

  async function cleanupInternal(request) {
    assertReady();
    const clockValue = clockNow();
    const payload = isPlainObject(request) ? request : {};
    const atResult = resolveAt(payload.at, clockValue);
    if (!atResult.ok) return atResult;
    const nowValue = atResult.at;
    const cutoffDay = beijingPatrolDayKey(nowValue - (AUDIT_RETENTION_DAYS - 1) * DAY_MS);
    let entries;
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (isNotFoundError(error)) {
        return { ok: true, cutoffDay, removed: [], kept: [], refused: [], ignored: 0 };
      }
      return failure('AUDIT_CLEANUP_FAILED', `审计目录读取失败（${safeErrorCode(error)}）`);
    }
    const removed = [];
    const kept = [];
    const refused = [];
    const errors = [];
    let ignored = 0;
    for (const name of entries) {
      if (isEscapingName(name)) {
        refused.push({ name: truncate(name, MAX_FILE_NAME_LENGTH), reason: 'path-escape' });
        continue;
      }
      const match = AUDIT_FILE_RE.exec(name);
      if (!match) {
        ignored += 1;
        continue;
      }
      const dayKey = match[1];
      if (!isValidDayKey(dayKey)) {
        refused.push({ name, reason: 'invalid-day' });
        continue;
      }
      const target = path.resolve(path.join(directory, name));
      let stat;
      try {
        stat = await lstat(target);
      } catch (error) {
        if (isNotFoundError(error)) continue;
        errors.push({ name, reason: 'lstat-failed', code: safeErrorCode(error) });
        continue;
      }
      // 不跟随符号链接/junction：只允许本目录下的普通文件。
      if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) {
        refused.push({ name, reason: 'symlink' });
        continue;
      }
      if (typeof stat.isFile === 'function' && !stat.isFile()) {
        refused.push({ name, reason: 'not-a-file' });
        continue;
      }
      if (dayKey >= cutoffDay) {
        kept.push(name);
        continue;
      }
      try {
        await unlink(target);
        removed.push(name);
      } catch (error) {
        if (isNotFoundError(error)) continue;
        errors.push({ name, reason: 'unlink-failed', code: safeErrorCode(error) });
      }
    }
    return {
      ok: errors.length === 0,
      cutoffDay,
      removed,
      kept,
      refused,
      ignored,
      ...(errors.length > 0 ? { errors } : {}),
    };
  }

  function enqueue(task) {
    const result = queue.then(() => task());
    // 队列指针只反映“是否结束”：单次失败不毒化后续调用。
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    load: () => enqueue(() => {
      phase = 'ready';
      return statusInternal();
    }),
    record: (payload) => enqueue(() => recordInternal(payload)),
    status: () => enqueue(statusAsync),
    readDay: (dayKey) => enqueue(() => readDayInternal(dayKey)),
    cleanup: (request) => enqueue(() => cleanupInternal(request)),
  };
}
