/**
 * 小黑盒写入账本（离线独立原型，未接入现有账本 / bridge / 生产环境）。
 *
 * 用途：给「发帖 / 评论」这类不可逆写操作留一份最小可持久化账本，使单实例内可以做到：
 *  · 固定操作 id 只放行一次（pending 也算「已出现」，未知结果 unknown 同样不再自动重发）；
 *  · 按北京时间自然日计数（post 2/日、comment 12/日），并叠加桶级最小间隔（3 小时 / 3 分钟）；
 *  · 同一 id 重复 finish 幂等；只有「明确 failure」累计连续失败，success 清零；
 *    连续三次明确 failure 暂停本账本当天剩余写操作。
 *
 * 2026-10-25 审计加固（对应 stage6b-ledger-review 的 finding 1-9、13、15）：
 *  · 独占所有权：同一 filePath 在进程内只允许一个实例（globalThis 注册表），跨进程用
 *    `<filePath>.lock` 的 O_EXCL 创建（'wx'）做租约；锁内容带 pid/token，pid 已死或锁文件
 *    不可解析视为 stale 并接管。`close()` 是明确生命周期终点，会删除锁文件并释放注册表。
 *  · 临时文件唯一：`crypto.randomUUID()` 命名 + `fs.open(temp,'wx',0o600)` 排他创建
 *    （不再用 PID + 实例内序号）；写后 datasync，rename 后 best-effort 同步目录。
 *  · 迟到结果归属（明确规则）：finish 绝不推进日键、绝不 stage 新日。只有「结果观察日」
 *    与「操作开始日」相同的结果才影响连续失败链；跨日迟到结果只更新该操作记录并置
 *    `late:true`，既不清零也不累加任何日期的失败链、不解除/制造暂停。
 *  · 跨字段不变量：pausedDay 只能等于当天或 null；consecutiveFailures 必须 < 3；
 *    finishedAt >= startedAt；startedAt <= lastSeenAt；lastSeenAt 的北京日 >= 账本日；
 *    bucket.lastActionAt <= lastSeenAt；count 不小于当天已记录操作数。任一不满足 fail-closed。
 *  · 持久化失败：ENOSPC / EACCES / rename 失败等进入 degraded，后续 begin/finish 抛带 code
 *    的异常（XHH_WRITE_LEDGER_DEGRADED），绝不因为「暂停没落盘」而放宽写权限；旧账本不被覆盖。
 *  · 父目录：load 与 persist 前 mkdir(recursive)；账本不存在时 load 只进入空白 ready。
 *  · ID：trim 后拒绝首尾空白、控制字符、空串、超长（200）；Unicode 规范化为 NFC 后再去重；
 *    `lookup(id)` 可查 pending/已结束记录。不做内容指纹/永久封禁。
 *  · 增长边界：只保留全部 pending + 最近 `maxFinishedOperations`（默认 50）条 finished；
 *    代价是被裁剪的旧 id 日后可能再次被放行（仅限早已结束的操作），文档明确此取舍。
 *  · 文件权限：临时文件、锁文件以 0600 创建；rename 后账本继承 0600（POSIX）。
 *  · 错误契约：not-loaded / failed / closed / owned / degraded 等致命路径抛带 code 异常；
 *    额度、间隔、重复、暂停等业务拒绝才返回 {ok:false, reason}。
 *
 * 2026-10-25 task-13（task-9 审查 F1/F2/F5）补充：
 *  · F1（已修）：进程内 registry 在**任何 await 之前同步占位**，同进程并发 load 只能有一个
 *    owner；第二个实例直接 OWNED。修复前两个实例可各自被 lock 的 stale 逻辑接管成双 owner，
 *    同一北京日 post 可被授权 4 笔（上限 2）。
 *  · F2（已修）：close()/releaseOwnership 先校验锁里的 token 是否仍属于本实例，才删除锁文件；
 *    锁已被他人接管时保留对方锁，避免误删造成双 owner。
 *  · F5（契约）：**OWNED 是终态**。load 因 OWNED 失败后该实例进入 failed，重复 load 仍抛
 *    OWNED；必须 close() 旧实例后**创建新实例**，不能在失败实例上重试。
 *
 * 诚实边界（本原型刻意很小，请不要按生产语义理解它）：
 *  · 仍然只有「单账本」一致性；跨进程锁防的是同路径多写者，不是分布式共识，未做 CAS revision；
 *  · **跨进程锁是尽力而为（F3，明确限制）**：stale 接管是 read→unlink→create 非原子（TOCTOU
 *    窗口），没有 heartbeat/TTL，也没有跨进程 revision 校验；进程存活但被长时间挂起、
 *    PID 复用、网络盘/杀软干扰、两个进程几乎同时首次创建锁等场景仍可能误判或双 owner。
 *    仅支持「同一 filePath 单实例部署」；需要多写者时应在每个进程内串行并用外部协调，
 *    不要把本锁当分布式租约。
 *  · 额度是 begin 时「预留」的：pending / failure / unknown 的 id 都仍占着当天额度，
 *    真实动作数可能少于账本计数（预留计数可能多计，宁可少写不可超写）；
 *  · 去重只按调用方给的规范化 id；不同 id 不保证是同一实际操作（调用方换 id 重试时无法识别）；
 *    调用方**不要**把帖子/评论正文、目标账号等敏感内容放进 id：账本以 0600 明文保存 id
 *    （未做哈希），只应在 id 里放稳定、无敏感含义的调用层标识；
 *  · 不含「全访问暂停 / 通知 / 权限」：暂停只影响本账本的 begin；
 *  · 掉电一致性只做到「临时文件 datasync + rename」，未承诺目录项持久化与备份轮转；
 *  · 不联网、不读平台、不读凭据；filePath 必须由调用方注入（没有默认真实路径）。
 *
 * 提交顺序：先深克隆内存状态 -> 在克隆上判定/修改 -> 写同目录临时文件（wx+0600+datasync）
 * -> rename 覆盖 -> 成功之后才把克隆提交为内存状态。任何持久化失败都不会覆盖旧账本，
 * 也不会改内存状态，并把实例降级为 degraded（拒绝后续写）。
 */

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 账本文件 schema 版本：只认这一个，未知版本 fail-closed（绝不静默重置额度）。 */
export const XHH_WRITE_LEDGER_SCHEMA_VERSION = 1;

/**
 * 致命路径错误码（业务拒绝不抛错，只返回 {ok:false, reason}）。
 * 调用方必须区分「账本不可用」与「额度不足/被限流」。
 */
export const XHH_WRITE_LEDGER_ERROR_CODES = Object.freeze({
  /** 还没有 await load() 就调用。 */
  NOT_LOADED: 'XHH_WRITE_LEDGER_NOT_LOADED',
  /** load 时文件/IO 不可用（坏 JSON、坏字段、未知版本、读失败、时钟不可用）。 */
  LOAD_FAILED: 'XHH_WRITE_LEDGER_LOAD_FAILED',
  /** load 已进入 failed 之后的所有读写（包装 LOAD_FAILED 原因）。 */
  FAILED: 'XHH_WRITE_LEDGER_FAILED',
  /** close() 之后再调用。 */
  CLOSED: 'XHH_WRITE_LEDGER_CLOSED',
  /**
   * 同一 filePath 已被本进程另一实例或另一活进程占有。
   * **终态**：该实例进入 failed，重复 load 仍抛 OWNED；必须 close() 后创建新实例。
   */
  OWNED: 'XHH_WRITE_LEDGER_OWNED',
  /** 持久化失败后进入的只读降级状态：拒绝后续写。 */
  DEGRADED: 'XHH_WRITE_LEDGER_DEGRADED',
});

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
/** 北京时间固定 UTC+8（无夏令时）。 */
const BEIJING_OFFSET_MS = 8 * HOUR_MS;
const MAX_OPERATION_ID_LENGTH = 200;
/** 连续这么多次「明确 failure」就暂停当天的写。 */
const MAX_CONSECUTIVE_FAILURES = 3;
/** finished 记录的默认保留条数（pending 永不裁剪）。 */
const DEFAULT_MAX_FINISHED_OPERATIONS = 50;
/** 进程内所有权注册表（Symbol.for 保证同一进程内多份模块实例共享）。 */
const OWNER_REGISTRY_SYMBOL = Symbol.for('qq-bridge.xiaoheihe-write-ledger.owners');

/**
 * 桶规则（深冻结）：post 每日 2 次、间隔 3 小时；comment 每日 12 次、间隔 3 分钟。
 * 「日」是北京时间 00:00 起的自然日；最小间隔跨日仍然生效。
 */
const BUCKET_RULES = Object.freeze({
  post: Object.freeze({ dailyCap: 2, minIntervalMs: 3 * HOUR_MS }),
  comment: Object.freeze({ dailyCap: 12, minIntervalMs: 3 * MINUTE_MS }),
});
const BUCKET_NAMES = Object.freeze(['post', 'comment']);
const OPERATION_STATUSES = new Set(['pending', 'success', 'failure', 'unknown']);
const FINISH_OUTCOMES = new Set(['success', 'failure', 'unknown']);
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

// ── 纯工具函数 ───────────────────────────────────────────────────────────────

function pad2(value) {
  return String(value).padStart(2, '0');
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isFiniteTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidDayKey(value) {
  if (typeof value !== 'string' || !DAY_KEY_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * 毫秒时间戳 -> 北京时间日期键（YYYY-MM-DD）。
 * 固定 UTC+8：先把时间戳加 8 小时，再取 UTC 字段，所以结果与宿主机时区 / 夏令时无关。
 * 纯函数从严：非法时间直接抛错。
 */
export function beijingXhhDayKey(at) {
  if (!isFiniteTimestamp(at)) {
    throw new TypeError('beijingXhhDayKey: at 必须是有限毫秒时间戳');
  }
  const shifted = new Date(at + BEIJING_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  if (!Number.isFinite(shifted.getTime()) || !Number.isFinite(year) || year < 1000 || year > 9999) {
    throw new RangeError('beijingXhhDayKey: at 超出可持久化的北京时间日期范围');
  }
  return `${year}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

function safeDayKey(at) {
  try {
    return beijingXhhDayKey(at);
  } catch {
    return null;
  }
}

function compareDayKey(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * 操作 id 规范化（findings 8/14）：拒绝非字符串、首尾空白、空串、控制字符、超长；
 * Unicode 统一为 NFC，使 `é`（NFC）与 `e + 组合重音`（NFD）被视为同一操作。
 */
function normalizeOperationId(value) {
  if (typeof value !== 'string') return { ok: false };
  if (value.length === 0) return { ok: false };
  if (value !== value.trim()) return { ok: false };
  if (CONTROL_CHAR_RE.test(value)) return { ok: false };
  const normalized = value.normalize('NFC');
  if (normalized.length === 0 || normalized !== normalized.trim()) return { ok: false };
  if (normalized.length > MAX_OPERATION_ID_LENGTH) return { ok: false };
  return { ok: true, id: normalized };
}

function createEmptyState(dayKey, timestamp) {
  const buckets = {};
  for (const name of BUCKET_NAMES) buckets[name] = { count: 0, lastActionAt: null };
  return {
    schemaVersion: XHH_WRITE_LEDGER_SCHEMA_VERSION,
    day: dayKey,
    lastSeenAt: timestamp,
    buckets,
    operations: Object.create(null),
    consecutiveFailures: 0,
    pausedDay: null,
  };
}

/**
 * 只按 schema 深克隆：未知字段不复制（因此不会被落盘），返回值可安全交给调用方。
 * 这也是 snapshot 深拷贝的唯一实现，保证调用方拿到的对象改不动内部状态。
 */
function cloneState(source) {
  const buckets = {};
  for (const name of BUCKET_NAMES) {
    const from = source.buckets[name];
    buckets[name] = { count: from.count, lastActionAt: from.lastActionAt };
  }
  const operations = Object.create(null);
  for (const id of Object.keys(source.operations)) {
    const from = source.operations[id];
    operations[id] = {
      bucket: from.bucket,
      status: from.status,
      startedAt: from.startedAt,
      finishedAt: from.finishedAt,
      late: from.late === true,
    };
  }
  return {
    schemaVersion: XHH_WRITE_LEDGER_SCHEMA_VERSION,
    day: source.day,
    lastSeenAt: source.lastSeenAt,
    buckets,
    operations,
    consecutiveFailures: source.consecutiveFailures,
    pausedDay: source.pausedDay,
  };
}

/**
 * 按本次时间准备一份待提交克隆：
 *  · relation === 0：同日，原样复制；
 *  · relation > 0：跨日，清空日计数、连续失败链与当天暂停；
 *    lastActionAt 与 operations（操作 id）跨日保留，因此跨日仍受最小间隔约束、旧 id 不重发；
 *  · relation < 0：调用方已按 clock-rollback 拒绝，这里只做防御性克隆（不前进日期）。
 *
 * 注意：只有 begin 会调用本函数。finish 绝不推进日键（迟到结果归属规则）。
 */
function stageForDay(state, dayKey, relation) {
  const next = cloneState(state);
  if (relation <= 0) return next;
  next.day = dayKey;
  for (const name of BUCKET_NAMES) next.buckets[name].count = 0;
  next.consecutiveFailures = 0;
  next.pausedDay = null;
  return next;
}

/**
 * 增长边界（finding 9）：pending 永不裁剪；finished 只保留最近 `maxFinishedOperations` 条。
 * 取舍：被裁剪的旧 finished id 之后可能再次被 begin 放行——只在「早已结束」的操作上发生，
 * 且平台额度/间隔仍然生效；这是控制文件增长的明确代价，不能用来给最近操作去重。
 */
function pruneFinishedOperations(state, maxFinishedOperations) {
  if (!Number.isInteger(maxFinishedOperations) || maxFinishedOperations < 0) return;
  const finishedIds = [];
  for (const id of Object.keys(state.operations)) {
    if (state.operations[id].status !== 'pending') finishedIds.push(id);
  }
  if (finishedIds.length <= maxFinishedOperations) return;
  finishedIds.sort((left, right) => {
    const a = state.operations[left].finishedAt ?? 0;
    const b = state.operations[right].finishedAt ?? 0;
    if (a !== b) return a - b;
    return left < right ? -1 : 1;
  });
  const removeCount = finishedIds.length - maxFinishedOperations;
  for (let index = 0; index < removeCount; index += 1) {
    delete state.operations[finishedIds[index]];
  }
}

/** 解析失败时统一返回结构。 */
function parseFailure(message) {
  return { ok: false, error: message };
}

/**
 * 解析并严格校验账本文件。
 *
 * 额度、操作记录、连续失败链、暂停日都是放行判定的一部分，缺失 / 非法一律 fail-closed：
 * 把它们默认成 0 等于静默放宽额度 / 解除暂停，是这里最不能犯的错。
 * 未知字段一律丢弃（不落盘）；未知 schemaVersion 直接失败，绝不自动重置。
 *
 * 2026-10-25 加固：新增跨字段不变量（finding 4/5）。注意 `lastSeenAt` 允许落在比 `day`
 * 更晚的北京日——迟到 finish 不会推进 day，但会推进 lastSeenAt，这属于合法状态。
 */
export function parseLedgerText(rawText) {
  const text = typeof rawText === 'string' ? rawText : String(rawText ?? '');
  if (text.trim() === '') {
    return parseFailure('账本文件是空的（fail-closed，不重置额度）');
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return parseFailure('账本不是合法 JSON（fail-closed，不重置额度）');
  }

  if (!isPlainObject(raw)) return parseFailure('账本根必须是对象');
  if (raw.schemaVersion !== XHH_WRITE_LEDGER_SCHEMA_VERSION) {
    return parseFailure('schemaVersion 不受支持（绝不自动重置额度）');
  }
  if (!isValidDayKey(raw.day)) return parseFailure('day 不是合法的北京时间日期键');
  if (!isFiniteTimestamp(raw.lastSeenAt)) return parseFailure('lastSeenAt 必须是有限毫秒时间戳');
  if (!isCount(raw.consecutiveFailures)) return parseFailure('consecutiveFailures 必须是 >=0 的整数');
  if (raw.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return parseFailure('consecutiveFailures 达到阈值时必须落 pausedDay（矛盾状态）');
  }
  if (!(raw.pausedDay === null || isValidDayKey(raw.pausedDay))) {
    return parseFailure('pausedDay 必须是北京时间日期键或 null');
  }
  if (raw.pausedDay !== null && raw.pausedDay !== raw.day) {
    return parseFailure('pausedDay 只能等于账本当天或为 null');
  }
  const lastSeenDay = safeDayKey(raw.lastSeenAt);
  if (lastSeenDay === null) return parseFailure('lastSeenAt 无法换算北京时间日键');
  if (compareDayKey(lastSeenDay, raw.day) < 0) {
    return parseFailure('lastSeenAt 早于账本日（矛盾状态）');
  }
  if (!isPlainObject(raw.buckets)) return parseFailure('buckets 必须是对象');

  const buckets = {};
  for (const name of BUCKET_NAMES) {
    const from = raw.buckets[name];
    if (!isPlainObject(from)) return parseFailure(`buckets 缺少 ${name}`);
    if (!isCount(from.count)) return parseFailure(`buckets.${name}.count 必须是 >=0 的整数`);
    if (!(from.lastActionAt === null || isFiniteTimestamp(from.lastActionAt))) {
      return parseFailure(`buckets.${name}.lastActionAt 必须是有限时间戳或 null`);
    }
    if (from.lastActionAt !== null && from.lastActionAt > raw.lastSeenAt) {
      return parseFailure(`buckets.${name}.lastActionAt 晚于 lastSeenAt（矛盾状态）`);
    }
    buckets[name] = { count: from.count, lastActionAt: from.lastActionAt };
  }

  if (!isPlainObject(raw.operations)) return parseFailure('operations 必须是对象');
  const operations = Object.create(null);
  for (const id of Object.keys(raw.operations)) {
    const normalized = normalizeOperationId(id);
    if (!normalized.ok || normalized.id !== id) return parseFailure('operations 含未规范化的操作 id');
    const from = raw.operations[id];
    if (!isPlainObject(from)) return parseFailure('operations 条目必须是对象');
    if (typeof from.bucket !== 'string' || !hasOwn(BUCKET_RULES, from.bucket)) {
      return parseFailure('operations 条目 bucket 不受支持');
    }
    if (typeof from.status !== 'string' || !OPERATION_STATUSES.has(from.status)) {
      return parseFailure('operations 条目 status 不受支持');
    }
    if (!isFiniteTimestamp(from.startedAt)) return parseFailure('operations 条目 startedAt 非法');
    if (from.startedAt > raw.lastSeenAt) {
      return parseFailure('operations 条目 startedAt 晚于 lastSeenAt（矛盾状态）');
    }
    if (from.status === 'pending') {
      if (from.finishedAt !== null) return parseFailure('pending 条目不应有 finishedAt');
      if (from.late === true) return parseFailure('pending 条目不应有 late 标记');
    } else {
      if (!isFiniteTimestamp(from.finishedAt)) return parseFailure('已结束条目必须有有限 finishedAt');
      if (from.finishedAt < from.startedAt) return parseFailure('finishedAt 早于 startedAt（矛盾状态）');
      const startedDay = safeDayKey(from.startedAt);
      const finishedDay = safeDayKey(from.finishedAt);
      if (startedDay === null || finishedDay === null) return parseFailure('操作时间超出可持久化日期范围');
      const expectedLate = compareDayKey(finishedDay, startedDay) !== 0;
      const actualLate = from.late === true;
      if (actualLate !== expectedLate) return parseFailure('late 标记与 startedAt/finishedAt 的日键不一致');
    }
    operations[id] = {
      bucket: from.bucket,
      status: from.status,
      startedAt: from.startedAt,
      finishedAt: from.finishedAt,
      late: from.late === true,
    };
  }

  // 计数不能低于账本中当天已经授权的次数，否则损坏状态可能放宽限额。
  for (const name of BUCKET_NAMES) {
    const recorded = Object.values(operations).filter(
      (operation) => operation.bucket === name && safeDayKey(operation.startedAt) === raw.day,
    ).length;
    if (buckets[name].count < recorded) {
      return parseFailure(`buckets.${name}.count 小于当天已记录操作数`);
    }
  }

  return {
    ok: true,
    state: {
      schemaVersion: XHH_WRITE_LEDGER_SCHEMA_VERSION,
      day: raw.day,
      lastSeenAt: raw.lastSeenAt,
      buckets,
      operations,
      consecutiveFailures: raw.consecutiveFailures,
      pausedDay: raw.pausedDay,
    },
  };
}

function resolveClock(clock) {
  if (clock === undefined || clock === null) return () => Date.now();
  if (typeof clock === 'function') return () => clock();
  if (typeof clock === 'object' && typeof clock.now === 'function') return () => clock.now();
  throw new TypeError('createXhhWriteLedger: options.clock 必须是函数或带 now() 的对象');
}

/**
 * 可注入文件系统原语（与 background-patrol-state.mjs 一致的风格）。
 * 默认实现全部走 node:fs/promises；测试只覆盖需要的键即可（其余键自动合并默认实现）。
 * 所有写原语都要求：临时文件 / 锁文件以 0600、'wx' 排他创建。
 */
export function createXhhWriteLedgerFsOps(overrides = {}) {
  const defaults = {
    readFile: (target, encoding) => fsPromises.readFile(target, encoding),
    mkdir: (target) => fsPromises.mkdir(target, { recursive: true }),
    /** 锁文件专用：'wx' + 0600 + datasync（失败时抛出 EEXIST 等原始错误）。 */
    createFileExclusive: async (target, payload) => {
      const handle = await fsPromises.open(target, 'wx', 0o600);
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.datasync();
      } finally {
        await handle.close();
      }
    },
    /** 账本临时文件专用：'wx' + 0600 + datasync。 */
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
    stat: (target) => fsPromises.stat(target),
    /** rename 之后 best-effort 同步目录（Windows 不支持打开目录，直接跳过）。 */
    syncDirectory: async (directory) => {
      if (process.platform === 'win32') return;
      let handle = null;
      try {
        handle = await fsPromises.open(directory, 'r');
        await handle.sync();
      } catch {
        // best-effort：掉电一致性不承诺，失败不影响主流程。
      } finally {
        if (handle !== null) await handle.close().catch(() => {});
      }
    },
  };
  const merged = { ...defaults };
  if (isPlainObject(overrides)) {
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === 'function') merged[key] = value;
    }
  }
  return merged;
}

function resolveMaxFinishedOperations(value) {
  if (value === undefined || value === null) return DEFAULT_MAX_FINISHED_OPERATIONS;
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError('createXhhWriteLedger: options.maxFinishedOperations 必须是 >=0 的整数');
  }
  return value;
}

function getOwnerRegistry() {
  if (!(globalThis[OWNER_REGISTRY_SYMBOL] instanceof Map)) {
    Object.defineProperty(globalThis, OWNER_REGISTRY_SYMBOL, {
      value: new Map(),
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
  return globalThis[OWNER_REGISTRY_SYMBOL];
}

/**
 * 进程存活判断（用于 stale 锁接管）：
 *  · pid 非法 / 本进程 -> 不视为活（同进程第二实例由进程内注册表拦截，锁里的本进程 pid 只能是残留）；
 *  · kill(pid, 0) 成功或 EPERM（存在但无权限）-> 活；ESRCH -> 死。
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * 创建小黑盒写入账本实例（离线原型）。
 *
 * 返回的方法都是异步且互相串行：
 *  · load() —— 先独占所有权（进程内注册表 + 跨进程 O_EXCL 锁），再读账本文件。
 *    ENOENT -> 空白 ready（会 mkdir 父目录以放锁）；空文件 / 坏 JSON / 字段非法 /
 *    未知 schemaVersion / 时钟不可用 -> 进入 failed 并 reject（code: LOAD_FAILED）。
 *  · begin({ id, bucket }) —— 校验输入、时钟与日切，做 id 去重、当天暂停、日额度、
 *    桶级最小间隔判定，通过则「预留」额度并把 pending 写盘；业务拒绝返回 {ok:false, reason}。
 *    写盘失败 -> 返回 {ok:false, reason:'persist-failed'} 并进入 degraded。
 *  · finish({ id, outcome }) —— outcome 只能是 success / failure / unknown；只对 pending 生效，
 *    重复 finish 返回 already-finished；结果只在「观察日 == 操作开始日」时影响失败链，
 *    跨日迟到结果标记 late:true 且不触碰失败链/暂停，也绝不推进日键。
 *  · lookup(id) —— 按规范化 id 返回 {found,status,bucket,startedAt,finishedAt,late} 或 null。
 *  · snapshot() —— 当前状态的深拷贝（可 JSON 序列化；degraded 时仍可读最后提交状态）。
 *  · close() —— 释放所有权并删除锁文件；幂等。close 之后所有调用抛 CLOSED。
 *
 * 致命状态（not-loaded / failed / closed / owned / degraded）抛带 code 的异常；
 * 只有业务拒绝（额度、间隔、重复、暂停、输入非法）返回 ok:false。
 *
 * @param {object} options
 * @param {string} options.filePath 账本文件路径（必须由调用方注入；没有默认真实路径）
 * @param {(() => number) | { now?: () => number }} [options.clock] 可注入时钟
 * @param {object} [options.fsOps] 可注入文件系统原语（测试用；缺省键自动合并默认实现）
 * @param {number} [options.maxFinishedOperations] finished 记录保留条数（默认 50）
 */
export function createXhhWriteLedger(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const filePath = source.filePath;

  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new TypeError('createXhhWriteLedger: options.filePath 必须是非空字符串（本原型不提供默认真实路径）');
  }

  const now = resolveClock(source.clock);
  const ops = createXhhWriteLedgerFsOps(source.fsOps);
  const maxFinishedOperations = resolveMaxFinishedOperations(source.maxFinishedOperations);
  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const lockPath = `${filePath}.lock`;
  const registryKey = path.resolve(filePath);
  const registry = getOwnerRegistry();

  /** uninitialized -> ready；或 failed / degraded / closed。failed 之后任何调用都不写盘。 */
  let phase = 'uninitialized';
  let current = null;
  let failure = null;
  let unavailableError = null;
  let degradedError = null;
  let queue = Promise.resolve();
  let lockToken = null;

  function createLedgerError(message, code, cause) {
    const error = new Error(message);
    error.code = code;
    if (cause !== undefined) error.cause = cause;
    return error;
  }

  function readTimestamp() {
    let value;
    try {
      value = now();
    } catch {
      return null;
    }
    return isFiniteTimestamp(value) ? value : null;
  }

  // ── 所有权 ────────────────────────────────────────────────────────────────

  async function readLockInfo() {
    let raw;
    try {
      raw = await ops.readFile(lockPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined; // 锁消失了，重试创建
      return null; // 读不到 = 视为损坏/stale，允许接管
    }
    try {
      const info = JSON.parse(raw);
      return isPlainObject(info) ? info : null;
    } catch {
      return null;
    }
  }

  /**
   * 取得跨进程锁文件（O_EXCL 'wx'）。token 由调用方生成并在 registry 同步占位后传入。
   * 已知限制（task-9 审查 F3，明确接受、不在本次实现 heartbeat）：
   * stale 接管是 read→unlink→create 三步、**非原子**，存在 TOCTOU 窗口；没有 heartbeat/TTL，
   * 所以「进程存活但被长时间挂起」「PID 复用」「网络盘上锁语义不可靠」都可能让接管判断出错。
   * 跨进程并发是尽力而为的互斥，不是分布式租约；同一 filePath 只应有一个部署实例。
   */
  async function acquireLockFile(token) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const timestamp = readTimestamp();
      const payload = JSON.stringify({ pid: process.pid, token, createdAt: timestamp });
      let createError = null;
      try {
        await ops.createFileExclusive(lockPath, payload);
        return;
      } catch (error) {
        createError = error;
      }
      if (createError?.code !== 'EEXIST') {
        throw createLedgerError(
          `xhh 写账本无法创建锁文件：${createError?.message ?? String(createError)}`,
          XHH_WRITE_LEDGER_ERROR_CODES.LOAD_FAILED,
          createError,
        );
      }
      const info = await readLockInfo();
      if (info === undefined) continue; // 锁已消失：立刻重试创建
      if (info !== null && isProcessAlive(info.pid)) {
        throw createLedgerError(
          `xhh 写账本已被另一进程独占（pid=${info.pid}，${filePath}）`,
          XHH_WRITE_LEDGER_ERROR_CODES.OWNED,
        );
      }
      // stale：占用者已死或锁文件损坏 -> 接管（见上文非原子 TOCTOU 限制）
      try {
        await ops.unlink(lockPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw createLedgerError(
            `xhh 写账本无法清理 stale 锁：${error?.message ?? String(error)}`,
            XHH_WRITE_LEDGER_ERROR_CODES.LOAD_FAILED,
            error,
          );
        }
      }
    }
    throw createLedgerError(
      `xhh 写账本无法取得独占锁（${filePath}）`,
      XHH_WRITE_LEDGER_ERROR_CODES.OWNED,
    );
  }

  /**
   * 取得所有权：**必须在任何 await 之前同步占位进程内 registry**（task-9 审查 F1 阻断项）。
   * 反例（修复前）：registry.has 检查与 registry.set 之间隔着 await ops.mkdir()，
   * 同进程第二个实例能在第一个尚未 set 时通过检查；随后它创建锁得到 EEXIST、
   * 读到 pid==本进程（isProcessAlive 对自身 pid 返回 false）把先到者的锁当 stale 删掉，
   * 于是两个实例同时成为 owner —— 同日 post 可被授权 4 笔（上限 2）。
   * 现在先同步 set 占位（失败时回滚），第二个实例在任何 await 之前就拿到 OWNED。
   */
  async function acquireOwnership() {
    if (registry.has(registryKey)) {
      const existingToken = registry.get(registryKey);
      throw createLedgerError(
        `xhh 写账本已被本进程另一实例独占（${filePath}，token=${existingToken}）`,
        XHH_WRITE_LEDGER_ERROR_CODES.OWNED,
      );
    }
    const token = randomUUID();
    // 关键顺序：同步占位必须早于任何 await（F1）。
    registry.set(registryKey, token);
    try {
      // 先建父目录：锁文件与账本都放在同一目录，缺目录时 load 也能 ready。
      try {
        await ops.mkdir(directory);
      } catch (error) {
        throw createLedgerError(
          `xhh 写账本无法创建父目录：${error?.message ?? String(error)}`,
          XHH_WRITE_LEDGER_ERROR_CODES.LOAD_FAILED,
          error,
        );
      }
      await acquireLockFile(token);
      lockToken = token;
    } catch (error) {
      if (registry.get(registryKey) === token) registry.delete(registryKey);
      throw error;
    }
  }

  /**
   * 释放所有权：先清 registry，再**校验锁文件仍是自己的 token** 才删除（task-9 审查 F2）。
   * 修复前无条件 unlink：若本实例的锁已被另一个 owner 接管（stale 接管/人工干预），
   * close() 会把对方的锁删掉，造成两个活 owner。现在 token 不匹配（或锁不可读）就保留。
   */
  async function releaseOwnership() {
    if (lockToken === null) return;
    const token = lockToken;
    lockToken = null;
    if (registry.get(registryKey) === token) registry.delete(registryKey);
    let info;
    try {
      info = await readLockInfo();
    } catch {
      info = null;
    }
    if (info === undefined || info === null) return; // 锁已消失/损坏：不冒险删除
    if (info.token !== token) return; // 已被他人接管：保留对方锁
    try {
      await ops.unlink(lockPath);
    } catch {
      // 锁清理失败不掩盖主流程；下一次 acquire 会把死 pid 锁当 stale 接管。
    }
  }

  // ── 状态/阶段 ─────────────────────────────────────────────────────────────

  function notLoadedError() {
    return createLedgerError(
      'xhh 写账本尚未 load()：调用方必须先 await load()',
      XHH_WRITE_LEDGER_ERROR_CODES.NOT_LOADED,
    );
  }

  function closedError() {
    return createLedgerError(
      'xhh 写账本已 close()，不能继续使用',
      XHH_WRITE_LEDGER_ERROR_CODES.CLOSED,
    );
  }

  function failedError() {
    if (unavailableError === null) {
      unavailableError = createLedgerError(
        'xhh 写账本不可用（load 失败过）',
        XHH_WRITE_LEDGER_ERROR_CODES.FAILED,
        failure ?? undefined,
      );
    }
    return unavailableError;
  }

  function degradedStateError() {
    if (degradedError === null) {
      degradedError = createLedgerError(
        'xhh 写账本处于 degraded 只读状态（持久化失败，拒绝后续写）',
        XHH_WRITE_LEDGER_ERROR_CODES.DEGRADED,
      );
    }
    return degradedError;
  }

  /** 写路径的致命状态检查：not-loaded / failed / closed / degraded 一律 throw。 */
  function ensureWritable() {
    if (phase === 'ready') return;
    if (phase === 'degraded') throw degradedStateError();
    if (phase === 'failed') throw failedError();
    if (phase === 'closed') throw closedError();
    throw notLoadedError();
  }

  /** 读路径：degraded 仍可读最后提交状态；failed/closed/uninitialized 抛对应错误。 */
  function ensureReadable() {
    if (phase === 'ready' || phase === 'degraded') {
      if (current === null) throw notLoadedError();
      return;
    }
    if (phase === 'failed') throw failedError();
    if (phase === 'closed') throw closedError();
    throw notLoadedError();
  }

  function enterDegraded(error) {
    phase = 'degraded';
    degradedError = createLedgerError(
      `xhh 写账本持久化失败，进入 degraded 只读状态：${error?.message ?? String(error)}`,
      XHH_WRITE_LEDGER_ERROR_CODES.DEGRADED,
      error,
    );
  }

  function failLoad(error) {
    failure = error;
    unavailableError = null;
    phase = 'failed';
    return error;
  }

  // ── 持久化 ────────────────────────────────────────────────────────────────

  /**
   * 同目录临时文件 -> rename 覆盖。
   * 临时名带 randomUUID 并用 'wx' 排他创建（finding 2）；任一环节失败：清理临时文件、
   * 抛出原始错误；旧账本与内存状态都没有被提交。
   */
  async function persist(nextState) {
    const tempPath = path.join(directory, `${baseName}.${randomUUID()}.tmp`);
    const payload = JSON.stringify(nextState);
    try {
      await ops.writeFileExclusive(tempPath, payload);
      await ops.rename(tempPath, filePath);
    } catch (error) {
      try {
        await ops.unlink(tempPath);
      } catch {
        // 临时文件清理失败不掩盖原始错误：旧账本没有被覆盖，内存状态也没有提交。
      }
      throw error;
    }
    // rename 已成功；目录同步是 best-effort（失败不回滚已提交的数据）。
    try {
      await ops.syncDirectory(directory);
    } catch {
      // ignore
    }
  }

  // ── load ─────────────────────────────────────────────────────────────────

  async function loadInternal() {
    if (phase === 'ready' || phase === 'degraded') return cloneState(current);
    if (phase === 'failed') throw failure;
    if (phase === 'closed') throw closedError();

    try {
      await acquireOwnership();
    } catch (error) {
      throw failLoad(error);
    }

    let rawText;
    try {
      rawText = await ops.readFile(filePath, 'utf8');
    } catch (error) {
      const isMissing = error !== null && typeof error === 'object' && error.code === 'ENOENT';
      if (!isMissing) {
        const detail =
          error !== null && typeof error === 'object' && typeof error.message === 'string'
            ? error.message
            : String(error);
        await releaseOwnership();
        throw failLoad(
          createLedgerError(
            `xhh 写账本读取失败：${detail}`,
            XHH_WRITE_LEDGER_ERROR_CODES.LOAD_FAILED,
            error,
          ),
        );
      }
      const timestamp = readTimestamp();
      const dayKey = timestamp === null ? null : safeDayKey(timestamp);
      if (timestamp === null || dayKey === null) {
        await releaseOwnership();
        throw failLoad(
          createLedgerError(
            'xhh 写账本：clock 不可用，无法确定北京时间日键',
            XHH_WRITE_LEDGER_ERROR_CODES.LOAD_FAILED,
          ),
        );
      }
      current = createEmptyState(dayKey, timestamp);
      phase = 'ready';
      return cloneState(current);
    }

    const parsed = parseLedgerText(rawText);
    if (!parsed.ok) {
      await releaseOwnership();
      throw failLoad(
        createLedgerError(
          `xhh 写账本文件不可用（${parsed.error}）`,
          XHH_WRITE_LEDGER_ERROR_CODES.LOAD_FAILED,
        ),
      );
    }
    current = parsed.state;
    phase = 'ready';
    return cloneState(current);
  }

  // ── begin ────────────────────────────────────────────────────────────────

  async function beginInternal(request) {
    ensureWritable();

    const payload = isPlainObject(request) ? request : {};
    const normalized = normalizeOperationId(payload.id);
    if (!normalized.ok) return { ok: false, reason: 'invalid-id' };
    const id = normalized.id;
    const bucket = payload.bucket;

    if (typeof bucket !== 'string' || !hasOwn(BUCKET_RULES, bucket)) {
      return { ok: false, reason: 'invalid-bucket' };
    }

    const timestamp = readTimestamp();
    if (timestamp === null) return { ok: false, reason: 'invalid-clock' };
    // 全局水位：时钟一旦回拨到已见时间之前，写请求一律 fail-closed（不写盘、不消耗额度）。
    if (timestamp < current.lastSeenAt) return { ok: false, reason: 'clock-rollback' };

    const dayKey = safeDayKey(timestamp);
    if (dayKey === null) return { ok: false, reason: 'invalid-clock' };
    const relation = compareDayKey(dayKey, current.day);
    if (relation < 0) return { ok: false, reason: 'clock-rollback' };

    const next = stageForDay(current, dayKey, relation);

    // 去重：只要这个 id 出现过（pending / success / failure / unknown），就只放行一次。
    if (hasOwn(next.operations, id)) return { ok: false, reason: 'duplicate' };
    // 连续三次明确 failure 之后，当天剩余写操作全部暂停（跨重启保留）。
    if (next.pausedDay !== null && next.pausedDay === dayKey) return { ok: false, reason: 'write-paused' };

    const rule = BUCKET_RULES[bucket];
    const bucketState = next.buckets[bucket];
    if (bucketState.count >= rule.dailyCap) return { ok: false, reason: 'daily-cap' };
    if (bucketState.lastActionAt !== null) {
      const elapsed = timestamp - bucketState.lastActionAt;
      if (elapsed < 0) return { ok: false, reason: 'clock-rollback' };
      if (elapsed < rule.minIntervalMs) {
        return { ok: false, reason: 'min-interval', waitMs: rule.minIntervalMs - elapsed };
      }
    }

    // 预留：begin 就占额度并把 id 记为 pending（所以 pending / failure / unknown 也会计入当天额度）。
    bucketState.count += 1;
    bucketState.lastActionAt = timestamp;
    next.operations[id] = {
      bucket,
      status: 'pending',
      startedAt: timestamp,
      finishedAt: null,
      late: false,
    };
    next.lastSeenAt = timestamp;
    pruneFinishedOperations(next, maxFinishedOperations);

    try {
      await persist(next);
    } catch (error) {
      enterDegraded(error);
      return { ok: false, reason: 'persist-failed' };
    }
    current = next;
    return { ok: true, id, bucket, used: bucketState.count, limit: rule.dailyCap };
  }

  // ── finish ───────────────────────────────────────────────────────────────

  async function finishInternal(request) {
    ensureWritable();

    const payload = isPlainObject(request) ? request : {};
    const normalized = normalizeOperationId(payload.id);
    if (!normalized.ok) return { ok: false, reason: 'invalid-id' };
    const id = normalized.id;
    const outcome = payload.outcome;

    if (typeof outcome !== 'string' || !FINISH_OUTCOMES.has(outcome)) {
      return { ok: false, reason: 'invalid-outcome' };
    }
    if (!hasOwn(current.operations, id)) return { ok: false, reason: 'unknown-operation' };
    if (current.operations[id].status !== 'pending') return { ok: false, reason: 'already-finished' };

    const timestamp = readTimestamp();
    if (timestamp === null) return { ok: false, reason: 'invalid-clock' };
    if (timestamp < current.lastSeenAt) return { ok: false, reason: 'clock-rollback' };

    const dayKey = safeDayKey(timestamp);
    if (dayKey === null) return { ok: false, reason: 'invalid-clock' };

    // 迟到结果归属规则（finding 3）：finish 绝不 stage 新日，也绝不推进日键。
    const next = cloneState(current);
    const operation = next.operations[id];
    const startedDay = safeDayKey(operation.startedAt);
    if (startedDay === null) return { ok: false, reason: 'invalid-clock' };
    if (timestamp < operation.startedAt) return { ok: false, reason: 'clock-rollback' };
    const late = compareDayKey(dayKey, startedDay) !== 0;

    operation.status = outcome;
    operation.finishedAt = timestamp;
    operation.late = late;

    // 只有「观察日 == 开始日」的结果才可能影响连续失败链/当天暂停；
    // 跨日迟到结果既不清零也不累加任何日期的失败链（否则昨日 success 会解除今天暂停）。
    if (!late) {
      if (outcome === 'success') {
        next.consecutiveFailures = 0;
      } else if (outcome === 'failure') {
        next.consecutiveFailures += 1;
        if (next.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          next.pausedDay = next.day;
          next.consecutiveFailures = 0;
        }
      }
      // outcome === 'unknown'：可能写成功也可能没写，既不清零也不累计连续失败链。
    }

    if (timestamp > next.lastSeenAt) next.lastSeenAt = timestamp;
    pruneFinishedOperations(next, maxFinishedOperations);

    try {
      await persist(next);
    } catch (error) {
      enterDegraded(error);
      return { ok: false, reason: 'persist-failed' };
    }
    current = next;
    return { ok: true, id, outcome, late, pausedToday: next.pausedDay === next.day };
  }

  // ── lookup / snapshot / close ────────────────────────────────────────────

  async function lookupInternal(rawId) {
    ensureReadable();
    const normalized = normalizeOperationId(rawId);
    if (!normalized.ok) return null;
    const operation = current.operations[normalized.id];
    if (operation === undefined) return null;
    return {
      found: true,
      id: normalized.id,
      bucket: operation.bucket,
      status: operation.status,
      startedAt: operation.startedAt,
      finishedAt: operation.finishedAt,
      late: operation.late === true,
    };
  }

  async function snapshotInternal() {
    ensureReadable();
    return cloneState(current);
  }

  async function closeInternal() {
    if (phase === 'closed') return;
    phase = 'closed';
    current = null;
    await releaseOwnership();
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
    begin: (request) => enqueue(() => beginInternal(request)),
    finish: (request) => enqueue(() => finishInternal(request)),
    lookup: (id) => enqueue(() => lookupInternal(id)),
    snapshot: () => enqueue(snapshotInternal),
    close: () => enqueue(closeInternal),
  };
}
