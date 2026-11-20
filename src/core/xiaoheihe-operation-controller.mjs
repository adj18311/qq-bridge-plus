/**
 * 小黑盒操作控制器（**唯一权威**，离线纯模块，未接入生产）。
 *
 * 目标（交接卡步骤 B「唯一权威」）：把小黑盒的读/写预算、最小间隔、暂停/恢复、unknown 不重放
 * 收敛到**一个入口**，避免 background-patrol-state 写桶、fault policy、write ledger 三处各管一套
 * 造成的双扣、绕过与语义漂移。
 *
 * 本模块是纯内存状态机：
 *  · 不联网、不读平台、不读写文件、不发通知、不读凭据；只接受注入时钟与可选初始状态；
 *  · 持久化由调用方负责：`serialize()` 导出稳定 JSON，`parseXhhOperationControllerState()`
 *    严格校验（坏状态 fail-closed，带 code），重启时把 parse 结果交给 `state` 选项即可；
 *  · **单实例**：可选 `singletonKey`（进程内同步注册）；同一 key 第二个实例直接抛
 *    XHH_OPERATION_CONTROLLER_SINGLETON_CONFLICT；`close()` 释放。
 *    未提供 key 时由调用方保证同一状态只挂一个控制器（文档化限制，无跨进程锁）。
 *
 * 规则（与 2026-10-25 规格对齐）：
 *  · 读取：get_home_content / get_post_detail 共享 14 次/北京日；search_content 不占额度但
 *    受 accessPaused 限制；读取按「授权即计数」（原型预留口径，宁可少读不可超读）。
 *  · 发帖（图文/文章/视频共用）：2 次/日 + 任意两次 ≥ 3 小时；
 *  · 评论/回复共用：12 次/日 + 任意两次 ≥ 3 分钟；
 *  · 跨北京零点：重置日计数（read/post/comment），保留桶级 lastActionAt（最小间隔跨日仍生效）、
 *    operations（id 去重）、unknown 记录、写暂停与全访问暂停；
 *  · 连续 3 次**明确 failure** → 持久 writePaused（writeReason='consecutive-failures'），
 *    跨日不自动解除，只能 adminRecover 恢复；恢复不清额度、间隔、unknown；
 *  · unknown 不重放（同 id 再授权返回 unknown-not-replayable）、不累计失败、不清零；
 *  · accessPaused（登录失效/验证码/网络）阻塞读+写、跨日保留、仅 adminRecover 恢复；
 *  · 所有时间必须单调（now < lastSeenAt 或日键回退 → clock-rollback，不写状态）。
 *
 * 错误契约：
 *  · 状态/契约错误抛异常（带 code）：坏状态 STATE_INVALID、单实例冲突 SINGLETON_CONFLICT、
 *    close 后调用 CLOSED、adminRecover 契约缺失 TypeError；
 *  · 业务拒绝返回 {ok:false, reason}：invalid-tool / invalid-id / invalid-kind / invalid-outcome /
 *    invalid-ticket / access-paused / write-paused / duplicate / unknown-not-replayable /
 *    read-daily-cap / post-daily-cap / comment-daily-cap / min-interval / clock-rollback /
 *    unknown-operation / already-finished / read-ticket-not-finishable。
 *
 * task-70 execute-first 票据（路线 B 防「授权后未执行仍计数」）：
 *  · `reserveRead/reserveWrite` 只做**预占**：检查额度/间隔/暂停/unknown/去重，返回
 *    `{ok:true, ticket:{state:'reserved', ticketId, kind, opId, now}}`，**不增加 used、不写 operations、
 *    不动失败链**；额度判断用 `used + reserved`；间隔判断把「已预占时间」也算进来（防并发双发）；
 *  · `commitTicket(ticket,{now})` 才应用计数：读 used+1 / 写桶+1 且 operations.opId = pending(started)；
 *    重复 commit 幂等（already:true）；过期/已 abort 的票据明确拒绝（ticket-expired）；
 *  · `abortTicket(ticket,{now})` 只释放 reserved 票据（不计数、不动失败链）；重复 abort/abort 后 commit
 *    返回 invalid-ticket；已 commit 的票据 abort 返回 ticket-committed；
 *  · `authorizeRead/authorizeWrite` 保留为 reserve+commit 原子包装（行为与旧版一致）；
 *  · `status()` 增加 reservedRead/reservedWrite 只读计数。
 *  明确限制：预留票据是**纯内存**状态，不进入 serialize/持久化——进程崩溃会丢失 reserved（不会多计，
 *  但可能让同一逻辑请求在重启后重新预占；接线层需用稳定 opId/幂等键约束）；TTL 过期即不可 commit。
 *
 * 明确限制（本切片不做）：
 *  · 不接线：bridge / MCP / 预设 / 调度器 / 正式配置都未引用本模块；
 *  · 无跨进程锁、无 fsync/原子落盘：持久化由调用方按单一写者串行完成；
 *  · 不做内容指纹/永久内容封禁；稳定 operation id 必须由可信调用层生成并复用；
 *  · `adminRecover({verifiedAdminFrom:'console'})` 只是调用契约，**不是鉴权**：可信控制台必须
 *    自己验证管理员来源，模型/请求体自报无效。
 */

import { randomUUID } from 'node:crypto';

import { beijingXhhDayKey } from './xiaoheihe-write-ledger.mjs';

export const XHH_OPERATION_CONTROLLER_SCHEMA_VERSION = 1;

export const XHH_OPERATION_CONTROLLER_ERROR_CODES = Object.freeze({
  /** 初始/持久状态损坏或矛盾（fail-closed，绝不静默重置额度）。 */
  STATE_INVALID: 'XHH_OPERATION_CONTROLLER_STATE_INVALID',
  /** 同一 singletonKey 已有活实例。 */
  SINGLETON_CONFLICT: 'XHH_OPERATION_CONTROLLER_SINGLETON_CONFLICT',
  /** close() 之后再调用。 */
  CLOSED: 'XHH_OPERATION_CONTROLLER_CLOSED',
});

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const XHH_OP_READ_DAILY_LIMIT = 14;
export const XHH_OP_POST_DAILY_LIMIT = 2;
export const XHH_OP_COMMENT_DAILY_LIMIT = 12;
/** 控制台可配置额度的硬上界（任务卡：整数 0–99）。用于校验**已落盘**的计数，不随用户调低而上移。 */
export const XHH_OP_DAILY_LIMIT_MAX = 99;
export const XHH_OP_POST_MIN_INTERVAL_MS = 3 * HOUR_MS;
export const XHH_OP_COMMENT_MIN_INTERVAL_MS = 3 * MINUTE_MS;
export const XHH_OP_READ_TOOLS = Object.freeze([
  'mcp__xiaoheihe__get_home_content',
  'mcp__xiaoheihe__get_post_detail',
]);
export const XHH_OP_SEARCH_TOOL = 'mcp__xiaoheihe__search_content';
export const XHH_OP_WRITE_PAUSE_REASON = 'consecutive-failures';
export const XHH_OP_ACCESS_REASONS = Object.freeze(['login-required', 'captcha', 'network-unavailable']);
export const XHH_OP_MAX_FINISHED_OPERATIONS_DEFAULT = 50;
/** task-70 预留票据默认 TTL：reserve 后超过该时长未 commit 即过期（内存态，不持久化）。 */
export const XHH_OP_DEFAULT_RESERVATION_TTL_MS = 5 * MINUTE_MS;

const WRITE_FAILURE_THRESHOLD = 3;
const READ_TOOL_SET = new Set(XHH_OP_READ_TOOLS);
const SEARCH_TOOL = XHH_OP_SEARCH_TOOL;
// 平时按「免额读」处理的工具：# 降级只读态里用户要求「仍允许的读取必须计入额度」，
// 因此只有在 reserveRead({forceCount:true}) 时它们才被做成 counted 读票据。
export const XHH_OP_FORCE_COUNT_READ_TOOLS = Object.freeze([
  'mcp__xiaoheihe__get_user_profile',
  'mcp__xiaoheihe__check_login_status',
]);
const FORCE_COUNT_READ_SET = new Set([...XHH_OP_FORCE_COUNT_READ_TOOLS, SEARCH_TOOL]);
const ACCESS_REASON_SET = new Set(XHH_OP_ACCESS_REASONS);
const WRITE_KINDS = Object.freeze(['post', 'comment']);
const WRITE_KIND_SET = new Set(WRITE_KINDS);
const OP_KINDS = new Set(['read', 'post', 'comment']);
const OP_STATUSES = new Set(['pending', 'success', 'failure', 'unknown', 'aborted']);
const FINISH_OUTCOMES = new Set(['success', 'failure', 'unknown']);
const BUCKET_RULES = Object.freeze({
  post: Object.freeze({ dailyLimit: XHH_OP_POST_DAILY_LIMIT, minIntervalMs: XHH_OP_POST_MIN_INTERVAL_MS }),
  comment: Object.freeze({ dailyLimit: XHH_OP_COMMENT_DAILY_LIMIT, minIntervalMs: XHH_OP_COMMENT_MIN_INTERVAL_MS }),
});
const DAY_KEY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const MAX_OPERATION_ID_LENGTH = 200;
const SINGLETON_REGISTRY_SYMBOL = Symbol.for('qq-bridge.xiaoheihe-operation-controller.singletons');

// ── 纯工具函数 ───────────────────────────────────────────────────────────────

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

function isValidDayKey(value) {
  if (typeof value !== 'string' || !DAY_KEY_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function safeDayKey(at) {
  try {
    return beijingXhhDayKey(at);
  } catch {
    return null;
  }
}

function compareDayKey(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** 操作 id 规范化：拒绝首尾空白/控制字符/空/超长；Unicode 统一 NFC 后去重。 */
function normalizeOperationId(value) {
  if (typeof value !== 'string' || value.length === 0) return { ok: false };
  if (value !== value.trim()) return { ok: false };
  if (CONTROL_CHAR_RE.test(value)) return { ok: false };
  const normalized = value.normalize('NFC');
  if (normalized.length === 0 || normalized !== normalized.trim()) return { ok: false };
  if (normalized.length > MAX_OPERATION_ID_LENGTH) return { ok: false };
  return { ok: true, id: normalized };
}

function resolveClock(clock) {
  if (clock === undefined || clock === null) return () => Date.now();
  if (typeof clock === 'function') return () => clock();
  if (typeof clock === 'object' && typeof clock.now === 'function') return () => clock.now();
  throw new TypeError('createXhhOperationController：options.clock 必须是函数或带 now() 的对象');
}

function resolveMaxFinished(value) {
  if (value === undefined || value === null) return XHH_OP_MAX_FINISHED_OPERATIONS_DEFAULT;
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError('createXhhOperationController：options.maxFinishedOperations 必须是 >=0 的整数');
  }
  return value;
}

function resolveReservationTtl(value) {
  if (value === undefined || value === null) return XHH_OP_DEFAULT_RESERVATION_TTL_MS;
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError('createXhhOperationController：options.reservationTtlMs 必须是正整数毫秒');
  }
  return value;
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

function stateError(message) {
  const error = new Error(`xhh 操作控制器状态不可用：${message}`);
  error.code = XHH_OPERATION_CONTROLLER_ERROR_CODES.STATE_INVALID;
  return error;
}

// ── 状态构造 / 深克隆 / 裁剪 ─────────────────────────────────────────────────

function createEmptyState(dayKey, timestamp) {
  return {
    schemaVersion: XHH_OPERATION_CONTROLLER_SCHEMA_VERSION,
    day: dayKey,
    lastSeenAt: timestamp,
    readCount: 0,
    buckets: {
      post: { count: 0, lastActionAt: null },
      comment: { count: 0, lastActionAt: null },
    },
    operations: Object.create(null),
    consecutiveWriteFailures: 0,
    writePaused: false,
    writeReason: null,
    accessPaused: false,
    accessReason: null,
    transitionSeq: 0,
    writePauseEventId: null,
    writePauseAt: null,
    accessPauseEventId: null,
    accessPauseAt: null,
    lastRecoverEventId: null,
    transitionEvents: [],
    transitionEventOverflow: 0,
  };
}

function cloneState(source) {
  const operations = Object.create(null);
  for (const id of Object.keys(source.operations)) {
    const from = source.operations[id];
    operations[id] = {
      kind: from.kind,
      status: from.status,
      startedAt: from.startedAt,
      finishedAt: from.finishedAt,
      late: from.late === true,
      ...(from.quotaReset === true ? { quotaReset: true } : {}),
    };
  }
  return {
    schemaVersion: XHH_OPERATION_CONTROLLER_SCHEMA_VERSION,
    day: source.day,
    lastSeenAt: source.lastSeenAt,
    readCount: source.readCount,
    buckets: {
      post: { count: source.buckets.post.count, lastActionAt: source.buckets.post.lastActionAt },
      comment: { count: source.buckets.comment.count, lastActionAt: source.buckets.comment.lastActionAt },
    },
    operations,
    consecutiveWriteFailures: source.consecutiveWriteFailures,
    writePaused: source.writePaused,
    writeReason: source.writeReason,
    accessPaused: source.accessPaused,
    accessReason: source.accessReason,
    transitionSeq: source.transitionSeq ?? 0,
    writePauseEventId: source.writePauseEventId ?? null,
    writePauseAt: source.writePauseAt ?? null,
    accessPauseEventId: source.accessPauseEventId ?? null,
    accessPauseAt: source.accessPauseAt ?? null,
    lastRecoverEventId: source.lastRecoverEventId ?? null,
    transitionEventOverflow: source.transitionEventOverflow ?? 0,
    transitionEvents: Array.isArray(source.transitionEvents)
      ? source.transitionEvents.map((item) => ({ event: item.event, reason: item.reason, operationId: item.operationId, at: item.at, deliveredAt: item.deliveredAt ?? null }))
      : [],
  };
}

/** 增长边界：pending 与 unknown 永不裁剪（unknown 仍需防重放）；只裁剪已成功/失败的旧记录。 */
function pruneFinishedOperations(state, maxFinished) {
  const prunableIds = [];
  for (const id of Object.keys(state.operations)) {
    const status = state.operations[id].status;
    if (status === 'success' || status === 'failure' || status === 'aborted') prunableIds.push(id);
  }
  if (prunableIds.length <= maxFinished) return;
  prunableIds.sort((left, right) => {
    const a = state.operations[left].finishedAt ?? 0;
    const b = state.operations[right].finishedAt ?? 0;
    if (a !== b) return a - b;
    return left < right ? -1 : 1;
  });
  const removeCount = prunableIds.length - maxFinished;
  for (let index = 0; index < removeCount; index += 1) delete state.operations[prunableIds[index]];
}

// ── 持久状态解析（fail-closed） ──────────────────────────────────────────────

const REQUIRED_STATE_KEYS = [
  'schemaVersion', 'day', 'lastSeenAt', 'readCount', 'buckets', 'operations',
  'consecutiveWriteFailures', 'writePaused', 'writeReason', 'accessPaused', 'accessReason',
];
// task-132：状态转换事件字段为可选新增；旧状态缺字段可读，新状态被旧程序读取时 fail-closed 拒绝。
const OPTIONAL_STATE_KEYS = [
  'transitionSeq', 'writePauseEventId', 'writePauseAt', 'accessPauseEventId', 'accessPauseAt', 'lastRecoverEventId',
  'transitionEvents', 'transitionEventOverflow',
];
const STATE_KEYS = [...REQUIRED_STATE_KEYS, ...OPTIONAL_STATE_KEYS];
const TRANSITION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const TRANSITION_EVENTS_MAX = 20;
// 软上限以上只允许「全部未送达」时继续增长（不得丢弃必须通知的事件）；加载侧设硬上限，
// 仅用于识别被外部损坏的巨大状态文件，正常运行由通知失败→写阻断自然限制增长。
const TRANSITION_EVENTS_LOAD_MAX = 1000;
const TRANSITION_EVENT_KINDS = new Set(['write-paused', 'access-paused', 'recovered']);

function normalizeTransitionEvent(value) {
  if (!isPlainObject(value)) return null;
  if (!TRANSITION_EVENT_KINDS.has(value.event)) return null;
  const id = normalizeTransitionId(value.operationId);
  if (id.ok !== true || id.id === null) return null;
  if (!isFiniteTimestamp(value.at)) return null;
  if (value.reason !== null && value.reason !== undefined && typeof value.reason !== 'string') return null;
  if (value.deliveredAt !== null && value.deliveredAt !== undefined && !isFiniteTimestamp(value.deliveredAt)) return null;
  return {
    event: value.event,
    reason: typeof value.reason === 'string' ? value.reason : null,
    operationId: id.id,
    at: value.at,
    deliveredAt: value.deliveredAt ?? null,
  };
}

function normalizeTransitionId(value) {
  if (value === null || value === undefined) return { ok: true, id: null };
  if (typeof value !== 'string' || !TRANSITION_ID_RE.test(value)) return { ok: false };
  return { ok: true, id: value };
}
const OPERATION_KEYS = ['kind', 'status', 'startedAt', 'finishedAt', 'late', 'quotaReset'];

/**
 * 严格解析并校验控制器状态（对象或 JSON 字符串）。
 * 坏 JSON / 未知版本 / 缺失字段 / 未知字段 / 跨字段矛盾一律抛 STATE_INVALID，
 * 绝不静默重置额度或解除暂停（finding 5 口径）。
 */
export function parseXhhOperationControllerState(rawState) {
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
  for (const key of Object.keys(raw)) {
    if (!STATE_KEYS.includes(key)) throw stateError(`状态包含不支持的字段 ${key}`);
  }
  for (const key of REQUIRED_STATE_KEYS) {
    if (!hasOwn(raw, key)) throw stateError(`状态缺少字段 ${key}`);
  }
  if (raw.schemaVersion !== XHH_OPERATION_CONTROLLER_SCHEMA_VERSION) {
    throw stateError('schemaVersion 不受支持');
  }
  if (!isValidDayKey(raw.day)) throw stateError('day 不是合法的北京时间日期键');
  if (!isFiniteTimestamp(raw.lastSeenAt)) throw stateError('lastSeenAt 必须是有限毫秒时间戳');
  const lastSeenDay = safeDayKey(raw.lastSeenAt);
  if (lastSeenDay === null) throw stateError('lastSeenAt 无法换算北京时间日键');
  if (compareDayKey(lastSeenDay, raw.day) < 0) throw stateError('lastSeenAt 早于账本日（矛盾状态）');
  // 校验用硬上界：用户把上限调低到低于当天已用次数时，已用次数必须保留、状态仍可载入。
  if (!isCount(raw.readCount) || raw.readCount > XHH_OP_DAILY_LIMIT_MAX) {
    throw stateError(`readCount 必须是 0..${XHH_OP_DAILY_LIMIT_MAX} 的整数`);
  }
  if (!isPlainObject(raw.buckets)) throw stateError('buckets 必须是对象');
  for (const kind of WRITE_KINDS) {
    const bucket = raw.buckets[kind];
    if (!isPlainObject(bucket)) throw stateError(`buckets 缺少 ${kind}`);
    if (!isCount(bucket.count) || bucket.count > XHH_OP_DAILY_LIMIT_MAX) {
      throw stateError(`buckets.${kind}.count 必须是 0..${XHH_OP_DAILY_LIMIT_MAX} 的整数`);
    }
    if (!(bucket.lastActionAt === null || isFiniteTimestamp(bucket.lastActionAt))) {
      throw stateError(`buckets.${kind}.lastActionAt 必须是有限时间戳或 null`);
    }
    if (bucket.count > 0 && bucket.lastActionAt === null) {
      throw stateError(`buckets.${kind}.count>0 时必须记录 lastActionAt`);
    }
    if (bucket.lastActionAt !== null && bucket.lastActionAt > raw.lastSeenAt) {
      throw stateError(`buckets.${kind}.lastActionAt 晚于 lastSeenAt（矛盾状态）`);
    }
  }
  if (!isCount(raw.consecutiveWriteFailures)) throw stateError('consecutiveWriteFailures 必须是 >=0 的整数');
  if (typeof raw.writePaused !== 'boolean') throw stateError('writePaused 必须是布尔值');
  if (!(raw.writeReason === null || raw.writeReason === XHH_OP_WRITE_PAUSE_REASON)) {
    throw stateError('writeReason 必须是受支持的原因或 null');
  }
  if (raw.writePaused !== (raw.consecutiveWriteFailures >= WRITE_FAILURE_THRESHOLD)) {
    throw stateError('writePaused 与连续失败次数矛盾');
  }
  if (raw.writePaused !== (raw.writeReason === XHH_OP_WRITE_PAUSE_REASON)) {
    throw stateError('writePaused 与 writeReason 矛盾');
  }
  if (typeof raw.accessPaused !== 'boolean') throw stateError('accessPaused 必须是布尔值');
  if (!(raw.accessReason === null || ACCESS_REASON_SET.has(raw.accessReason))) {
    throw stateError('accessReason 必须是受支持的暂停原因或 null');
  }
  if (raw.accessPaused !== (raw.accessReason !== null)) throw stateError('accessPaused 与 accessReason 矛盾');
  if (raw.transitionSeq !== undefined && !isCount(raw.transitionSeq)) {
    throw stateError('transitionSeq 必须是 >=0 的整数');
  }
  const transitionIds = {
    writePauseEventId: normalizeTransitionId(raw.writePauseEventId),
    accessPauseEventId: normalizeTransitionId(raw.accessPauseEventId),
    lastRecoverEventId: normalizeTransitionId(raw.lastRecoverEventId),
  };
  for (const key of Object.keys(transitionIds)) {
    if (!transitionIds[key].ok) throw stateError(`${key} 不是合法的转换事件 id`);
  }
  for (const key of ['writePauseAt', 'accessPauseAt']) {
    const value = raw[key] === undefined ? null : raw[key];
    if (!(value === null || isFiniteTimestamp(value))) throw stateError(`${key} 必须是有限时间戳或 null`);
  }
  if (!isPlainObject(raw.operations)) throw stateError('operations 必须是对象');

  const operations = Object.create(null);
  for (const id of Object.keys(raw.operations)) {
    const normalized = normalizeOperationId(id);
    if (!normalized.ok || normalized.id !== id) throw stateError('operations 含未规范化的操作 id');
    const from = raw.operations[id];
    if (!isPlainObject(from)) throw stateError('operations 条目必须是对象');
    for (const key of Object.keys(from)) {
      if (!OPERATION_KEYS.includes(key)) throw stateError(`operations 条目含不支持字段 ${key}`);
    }
    if (!OP_KINDS.has(from.kind)) throw stateError('operations 条目 kind 不受支持');
    if (!OP_STATUSES.has(from.status)) throw stateError('operations 条目 status 不受支持');
    if (!isFiniteTimestamp(from.startedAt)) throw stateError('operations 条目 startedAt 非法');
    if (from.startedAt > raw.lastSeenAt) throw stateError('operations 条目 startedAt 晚于 lastSeenAt');
    if (typeof from.late !== 'boolean') throw stateError('operations 条目 late 必须是布尔值');
    if (from.quotaReset !== undefined && typeof from.quotaReset !== 'boolean') throw stateError('operations 条目 quotaReset 必须是布尔值');
    if (from.status === 'pending') {
      if (from.finishedAt !== null) throw stateError('pending 条目不应有 finishedAt');
      if (from.late !== false) throw stateError('pending 条目不应标记 late');
    } else {
      if (!isFiniteTimestamp(from.finishedAt)) throw stateError('已结束条目必须有有限 finishedAt');
      if (from.finishedAt < from.startedAt) throw stateError('finishedAt 早于 startedAt（矛盾状态）');
      const startedDay = safeDayKey(from.startedAt);
      const finishedDay = safeDayKey(from.finishedAt);
      if (startedDay === null || finishedDay === null) throw stateError('操作时间超出可持久化日期范围');
      const expectedLate = compareDayKey(finishedDay, startedDay) !== 0;
      if (from.late !== expectedLate) throw stateError('late 标记与 startedAt/finishedAt 的日键不一致');
    }
    operations[id] = {
      kind: from.kind,
      status: from.status,
      startedAt: from.startedAt,
      finishedAt: from.finishedAt,
      late: from.late,
      ...(from.quotaReset === true ? { quotaReset: true } : {}),
    };
  }

  // 计数不能低于当天已授权的操作数（损坏状态不得放宽额度）。
  const todayOps = Object.values(operations).filter(
    (operation) => safeDayKey(operation.startedAt) === raw.day && operation.status !== 'aborted' && operation.quotaReset !== true,
  );
  const readOps = todayOps.filter((operation) => operation.kind === 'read').length;
  if (raw.readCount < readOps) throw stateError('readCount 小于当天已记录的读取数');
  for (const kind of WRITE_KINDS) {
    const used = todayOps.filter((operation) => operation.kind === kind).length;
    if (raw.buckets[kind].count < used) throw stateError(`buckets.${kind}.count 小于当天已记录操作数`);
  }

  let transitionEventOverflow = 0;
  if (raw.transitionEventOverflow !== undefined) {
    if (!Number.isInteger(raw.transitionEventOverflow) || raw.transitionEventOverflow < 0) {
      throw stateError('transitionEventOverflow 非法');
    }
    transitionEventOverflow = raw.transitionEventOverflow;
  }

  const transitionEvents = [];
  if (raw.transitionEvents !== undefined) {
    if (!Array.isArray(raw.transitionEvents)) throw stateError('transitionEvents 必须是数组');
    if (raw.transitionEvents.length > TRANSITION_EVENTS_LOAD_MAX) throw stateError('transitionEvents 数量超过硬上限');
    for (const item of raw.transitionEvents) {
      const normalized = normalizeTransitionEvent(item);
      if (normalized === null) throw stateError('transitionEvents 条目非法');
      transitionEvents.push(normalized);
    }
  }

  return {
    schemaVersion: XHH_OPERATION_CONTROLLER_SCHEMA_VERSION,
    day: raw.day,
    lastSeenAt: raw.lastSeenAt,
    readCount: raw.readCount,
    buckets: {
      post: { count: raw.buckets.post.count, lastActionAt: raw.buckets.post.lastActionAt },
      comment: { count: raw.buckets.comment.count, lastActionAt: raw.buckets.comment.lastActionAt },
    },
    operations,
    consecutiveWriteFailures: raw.consecutiveWriteFailures,
    writePaused: raw.writePaused,
    writeReason: raw.writeReason,
    accessPaused: raw.accessPaused,
    accessReason: raw.accessReason,
    transitionSeq: raw.transitionSeq ?? 0,
    writePauseEventId: transitionIds.writePauseEventId.id,
    writePauseAt: raw.writePauseAt ?? null,
    accessPauseEventId: transitionIds.accessPauseEventId.id,
    accessPauseAt: raw.accessPauseAt ?? null,
    lastRecoverEventId: transitionIds.lastRecoverEventId.id,
    transitionEvents,
    transitionEventOverflow,
  };
}

// ── 控制器 ──────────────────────────────────────────────────────────────────

/**
 * 创建小黑盒操作控制器（唯一权威，纯内存）。
 *
 * @param {object} [options]
 * @param {(() => number) | { now?: () => number }} [options.clock] 注入时钟
 * @param {object|string} [options.state] 初始持久状态（对象或 JSON 字符串，fail-closed 校验）
 * @param {string} [options.singletonKey] 进程内单实例键（同名第二个实例抛 SINGLETON_CONFLICT）
 * @param {number} [options.maxFinishedOperations] finished 记录保留条数（默认 50）
 * @param {number} [options.reservationTtlMs] reserve 票据有效期（默认 5 分钟；纯内存，不落盘）
 */
export function createXhhOperationController(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const clock = resolveClock(source.clock);
  const maxFinished = resolveMaxFinished(source.maxFinishedOperations);
  const reservationTtlMs = resolveReservationTtl(source.reservationTtlMs);
  const singletonKey =
    typeof source.singletonKey === 'string' && source.singletonKey.trim() !== '' ? source.singletonKey : null;
  const registry = getSingletonRegistry();
  // 构造期可选注入（bridge 启动时用控制台配置装配；未注入时保持常量默认）。
  const initialLimits = isPlainObject(source.limits) ? source.limits : null;

  if (singletonKey !== null) {
    if (registry.has(singletonKey)) {
      const error = new Error(`xhh 操作控制器已存在活实例（singletonKey=${singletonKey}）`);
      error.code = XHH_OPERATION_CONTROLLER_ERROR_CODES.SINGLETON_CONFLICT;
      throw error;
    }
    registry.set(singletonKey, true);
  }

  // 每日额度上限（控制台可配置）。默认等于历史常量，未配置时行为与改动前逐字一致。
  const dailyLimits = {
    read: XHH_OP_READ_DAILY_LIMIT,
    post: XHH_OP_POST_DAILY_LIMIT,
    comment: XHH_OP_COMMENT_DAILY_LIMIT,
  };
  /**
   * 应用新的每日额度上限（0–99 的整数）。0 表示禁止该类自主操作。
   * 只改内存中的上限，不动已用次数与操作间隔（任务卡：调低上限保留已用次数、不清间隔）。
   */
  function applyDailyLimits(next) {
    if (!isPlainObject(next)) return { ok: false, reason: 'invalid-limits' };
    const patch = {};
    for (const kind of ['read', 'post', 'comment']) {
      if (next[kind] === undefined) continue;
      const value = next[kind];
      if (!Number.isInteger(value) || value < 0 || value > XHH_OP_DAILY_LIMIT_MAX) {
        return { ok: false, reason: 'invalid-limit-value', field: kind };
      }
      patch[kind] = value;
    }
    Object.assign(dailyLimits, patch);
    return { ok: true, limits: { ...dailyLimits } };
  }
  function currentDailyLimits() {
    return { ...dailyLimits };
  }

  if (initialLimits !== null) {
    const applied = applyDailyLimits(initialLimits);
    if (!applied.ok) {
      throw new TypeError(`createXhhOperationController：limits.${applied.field ?? 'unknown'} 必须是 0..${XHH_OP_DAILY_LIMIT_MAX} 的整数`);
    }
  }

  let state;
  try {
    if (source.state !== undefined) {
      state = parseXhhOperationControllerState(source.state);
    } else {
      const timestamp = clock();
      if (!isFiniteTimestamp(timestamp)) throw stateError('注入时钟返回了非有限时间戳');
      const dayKey = safeDayKey(timestamp);
      if (dayKey === null) throw stateError('注入时钟无法换算北京时间日键');
      state = createEmptyState(dayKey, timestamp);
    }
  } catch (error) {
    if (singletonKey !== null) registry.delete(singletonKey);
    throw error;
  }

  let closed = false;
  let queue = Promise.resolve();

  function assertOpen() {
    if (!closed) return;
    const error = new Error('xhh 操作控制器已 close()，不能继续使用');
    error.code = XHH_OPERATION_CONTROLLER_ERROR_CODES.CLOSED;
    throw error;
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

  function resolveEventTime(explicitNow) {
    if (explicitNow === undefined || explicitNow === null) {
      const fromClock = readTimestamp();
      return fromClock === null ? { ok: false, reason: 'invalid-clock' } : { ok: true, at: fromClock };
    }
    if (explicitNow instanceof Date) {
      const ms = explicitNow.getTime();
      return Number.isFinite(ms) ? { ok: true, at: ms } : { ok: false, reason: 'invalid-clock' };
    }
    return isFiniteTimestamp(explicitNow) ? { ok: true, at: explicitNow } : { ok: false, reason: 'invalid-clock' };
  }

  /**
   * 按事件时间推进北京日键：跨日只重置日计数（read/post/comment），
   * 保留 lastActionAt、operations、unknown、写暂停/失败链、全访问暂停。
   * 返回 {ok:true, at} 或 {ok:false, reason}；不直接写 lastSeenAt（调用方按事件语义更新）。
   */
  function rollToDay(at) {
    const dayKey = safeDayKey(at);
    if (dayKey === null) return { ok: false, reason: 'invalid-clock' };
    const relation = compareDayKey(dayKey, state.day);
    if (relation < 0) return { ok: false, reason: 'clock-rollback' };
    if (relation > 0) {
      state.day = dayKey;
      state.readCount = 0;
      state.buckets.post.count = 0;
      state.buckets.comment.count = 0;
      // 暂停/失败链/operations/lastActionAt 都跨日保留（只能管理员恢复暂停）。
      if (at > state.lastSeenAt) state.lastSeenAt = at;
    }
    return { ok: true, at, dayKey };
  }

  function recordRead(id, at) {
    state.readCount += 1;
    state.lastSeenAt = at;
    if (id !== null) {
      state.operations[id] = { kind: 'read', status: 'success', startedAt: at, finishedAt: at, late: false };
      pruneFinishedOperations(state, maxFinished);
    }
  }

  function snapshot() {
    const pending = [];
    const unknown = [];
    for (const id of Object.keys(state.operations)) {
      const operation = state.operations[id];
      if (operation.status === 'pending') {
        pending.push({ id, kind: operation.kind, startedAt: operation.startedAt });
      } else if (operation.status === 'unknown') {
        unknown.push({ id, kind: operation.kind, startedAt: operation.startedAt, finishedAt: operation.finishedAt });
      }
    }
    pending.sort((left, right) => left.startedAt - right.startedAt || (left.id < right.id ? -1 : 1));
    unknown.sort((left, right) => left.finishedAt - right.finishedAt || (left.id < right.id ? -1 : 1));
    return {
      reservedRead: reservedCount('read'),
      reservedWrite: reservedWriteCount(),
      day: state.day,
      lastSeenAt: state.lastSeenAt,
      read: {
        used: state.readCount,
        limit: dailyLimits.read,
        remaining: Math.max(0, dailyLimits.read - state.readCount - reservedCount('read')),
      },
      post: {
        used: state.buckets.post.count,
        limit: dailyLimits.post,
        remaining: Math.max(0, dailyLimits.post - state.buckets.post.count - reservedCount('post')),
        lastActionAt: state.buckets.post.lastActionAt,
      },
      comment: {
        used: state.buckets.comment.count,
        limit: dailyLimits.comment,
        remaining: Math.max(0, dailyLimits.comment - state.buckets.comment.count - reservedCount('comment')),
        lastActionAt: state.buckets.comment.lastActionAt,
      },
      writePaused: state.writePaused,
      writeReason: state.writeReason,
      consecutiveWriteFailures: state.consecutiveWriteFailures,
      accessPaused: state.accessPaused,
      accessReason: state.accessReason,
      writePauseEventId: state.writePauseEventId ?? null,
      writePauseAt: state.writePauseAt ?? null,
      accessPauseEventId: state.accessPauseEventId ?? null,
      accessPauseAt: state.accessPauseAt ?? null,
      lastRecoverEventId: state.lastRecoverEventId ?? null,
      transitionEvents: state.transitionEvents.map((item) => ({ ...item })),
      transitionEventOverflow: state.transitionEventOverflow ?? 0,
      pending,
      unknown,
    };
  }

  // ── task-70：reserve / commit / abort（execute-first 票据语义） ─────────────
  /** ticketId -> {ticketId, kind, opId, tool, counted, reservedAt, expiresAt, state} */
  const reservations = new Map();
  let ticketSeq = 0;
  // 票据命名空间：每个 controller 实例独立随机前缀。store.reload 会重建 controller，
  // 旧票据在新实例上必须 invalid-ticket，绝不允许「rt-1 重号 + issuedTickets 覆盖」导致
  // 旧操作静默提交新实例的同号预占（reload 分叉部署阻断）。
  const ticketNamespace = randomUUID().replace(/-/gu, '').slice(0, 8);
  const MAX_RESERVATION_TOMBSTONES = 512;

  /** 过期清理 + 墓碑（committed 用于重复 commit 幂等）上限。 */
  function sweepReservations(now) {
    if (isFiniteTimestamp(now)) {
      for (const entry of reservations.values()) {
        if (entry.state === 'reserved' && now > entry.expiresAt) entry.state = 'expired';
      }
    }
    if (reservations.size <= MAX_RESERVATION_TOMBSTONES) return;
    for (const [ticketId, entry] of reservations) {
      if (reservations.size <= MAX_RESERVATION_TOMBSTONES) break;
      if (entry.state !== 'reserved') reservations.delete(ticketId);
    }
  }

  function reservedCount(kind) {
    let count = 0;
    for (const entry of reservations.values()) {
      if (entry.state === 'reserved' && entry.kind === kind && entry.counted !== false) count += 1;
    }
    return count;
  }

  function reservedWriteCount() {
    return reservedCount('post') + reservedCount('comment');
  }

  function reservedLastActionAt(kind) {
    let latest = null;
    for (const entry of reservations.values()) {
      if (entry.state !== 'reserved' || entry.kind !== kind) continue;
      if (latest === null || entry.reservedAt > latest) latest = entry.reservedAt;
    }
    return latest;
  }

  function hasActiveReservationForOp(opId) {
    if (opId === null) return false;
    for (const entry of reservations.values()) {
      if (entry.state === 'reserved' && entry.opId === opId) return true;
    }
    return false;
  }

  function dayRelationOf(at) {
    const dayKey = safeDayKey(at);
    if (dayKey === null) return { ok: false, reason: 'invalid-clock' };
    const relation = compareDayKey(dayKey, state.day);
    if (relation < 0) return { ok: false, reason: 'clock-rollback' };
    return { ok: true, relation };
  }

  function reservedTicketOf(entry) {
    return {
      state: 'reserved',
      ticketId: entry.ticketId,
      kind: entry.kind,
      opId: entry.opId,
      now: entry.reservedAt,
      counted: entry.counted,
      ...(entry.tool === null ? {} : { tool: entry.tool }),
    };
  }

  function registerReservation({ kind, opId, tool = null, at, counted }) {
    ticketSeq += 1;
    const entry = {
      ticketId: `rt-${ticketNamespace}-${ticketSeq}`,
      kind,
      opId,
      tool,
      counted,
      reservedAt: at,
      expiresAt: at + reservationTtlMs,
      state: 'reserved',
    };
    reservations.set(entry.ticketId, entry);
    sweepReservations(at);
    return reservedTicketOf(entry);
  }

  /**
   * 预占一次读取（search 也发 ticket，但 counted:false、不占额度）。不修改任何额度/桶/失败链。
   *
   * `forceCount:true`（仅降级只读态使用）：身份来源不可靠时不允许走「免额读」豁免，
   * search_content / get_user_profile / check_login_status 也必须占一次读额度。
   * 只影响调用方显式传 forceCount 的那一刻；缺省时行为与旧调用方逐字一致。
   */
  async function reserveReadInternal(request) {
    const payload = isPlainObject(request) ? request : {};
    const tool = payload.tool;
    const forceCount = payload.forceCount === true;
    const isSearch = tool === SEARCH_TOOL;
    // 平时走 misc 的免额读工具，在降级只读时必须能强制作成 counted 读票据。
    const forceCountable = forceCount && FORCE_COUNT_READ_SET.has(tool);
    if (!isSearch && !forceCountable && !READ_TOOL_SET.has(tool)) return { ok: false, reason: 'invalid-tool' };

    let id = null;
    if (payload.id !== undefined) {
      const normalized = normalizeOperationId(payload.id);
      if (!normalized.ok) return { ok: false, reason: 'invalid-id' };
      id = normalized.id;
    }
    const time = resolveEventTime(payload.now);
    if (!time.ok) return { ok: false, reason: time.reason };
    sweepReservations(time.at);
    if (time.at < state.lastSeenAt) return { ok: false, reason: 'clock-rollback' };
    const relation = dayRelationOf(time.at);
    if (!relation.ok) return { ok: false, reason: relation.reason };
    if (state.accessPaused) return { ok: false, reason: 'access-paused' };

    if (isSearch && !forceCount) {
      const ticket = registerReservation({ kind: 'read', opId: null, tool: SEARCH_TOOL, at: time.at, counted: false });
      return { ok: true, counted: false, ticket };
    }
    if (
      id !== null
      && ((hasOwn(state.operations, id) && state.operations[id].status !== 'aborted') || hasActiveReservationForOp(id))
    ) {
      return { ok: false, reason: 'duplicate' };
    }
    const effectiveUsed = relation.relation > 0 ? 0 : state.readCount;
    const reserved = reservedCount('read');
    if (effectiveUsed + reserved >= dailyLimits.read) return { ok: false, reason: 'read-daily-cap' };
    const ticket = registerReservation({ kind: 'read', opId: id, tool, at: time.at, counted: true });
    return {
      ok: true,
      counted: true,
      ticket,
      remaining: Math.max(0, dailyLimits.read - effectiveUsed - reserved - 1),
    };
  }

  /** 预占一次写操作：额度用 used+reserved，最小间隔也把「已预占时间」算进去（防并发双发）。 */
  async function reserveWriteInternal(request) {
    const payload = isPlainObject(request) ? request : {};
    const kind = payload.kind;
    if (!WRITE_KIND_SET.has(kind)) return { ok: false, reason: 'invalid-kind' };
    const normalized = normalizeOperationId(payload.id);
    if (!normalized.ok) return { ok: false, reason: 'invalid-id' };
    const id = normalized.id;

    const time = resolveEventTime(payload.now);
    if (!time.ok) return { ok: false, reason: time.reason };
    sweepReservations(time.at);
    if (time.at < state.lastSeenAt) return { ok: false, reason: 'clock-rollback' };
    const relation = dayRelationOf(time.at);
    if (!relation.ok) return { ok: false, reason: relation.reason };
    if (state.accessPaused) return { ok: false, reason: 'access-paused' };
    if (state.writePaused) return { ok: false, reason: 'write-paused' };

    if (hasOwn(state.operations, id)) {
      const status = state.operations[id].status;
      if (status === 'unknown') return { ok: false, reason: 'unknown-not-replayable' };
      // aborted = 已确定未执行并回滚，允许用同一 opId 重新 reserve；其它终态仍是 duplicate。
      if (status !== 'aborted') return { ok: false, reason: 'duplicate' };
    }
    if (hasActiveReservationForOp(id)) return { ok: false, reason: 'duplicate' };

    const rule = BUCKET_RULES[kind];
    const bucket = state.buckets[kind];
    const effectiveUsed = relation.relation > 0 ? 0 : bucket.count;
    const reserved = reservedCount(kind);
    if (effectiveUsed + reserved >= dailyLimits[kind]) return { ok: false, reason: `${kind}-daily-cap` };

    // 间隔：最近一次「已提交」或「已预占」时间都算占用（reserve 即占间隔，防并发双发）。
    const reservedLatest = reservedLastActionAt(kind);
    let latestActionAt = bucket.lastActionAt;
    if (reservedLatest !== null && (latestActionAt === null || reservedLatest > latestActionAt)) latestActionAt = reservedLatest;
    if (latestActionAt !== null) {
      const elapsed = time.at - latestActionAt;
      if (elapsed < 0) return { ok: false, reason: 'clock-rollback' };
      if (elapsed < rule.minIntervalMs) {
        return { ok: false, reason: 'min-interval', waitMs: rule.minIntervalMs - elapsed };
      }
    }

    const ticket = registerReservation({ kind, opId: id, at: time.at, counted: true });
    return { ok: true, ticket, used: effectiveUsed + reserved + 1, limit: dailyLimits[kind] };
  }

  /** 回滚后重算桶 lastActionAt：取该桶最近一条非 aborted 操作（startedAt 最大）。 */
  function recomputeBucketLastActionAt(kind) {
    let latest = null;
    for (const operation of Object.values(state.operations)) {
      if (operation.kind !== kind || operation.status === 'aborted') continue;
      if (latest === null || operation.startedAt > latest) latest = operation.startedAt;
    }
    return latest;
  }

  /** 提交 reserved 票据：used+1 / 写操作进入 started(pending)；重复 commit 幂等。 */
  async function commitTicketInternal(ticket, rest) {
    const payload = isPlainObject(ticket) ? ticket : {};
    const ticketId = payload.ticketId;
    if (typeof ticketId !== 'string' || ticketId === '') return { ok: false, reason: 'invalid-ticket' };
    const entry = reservations.get(ticketId);
    if (entry === undefined) return { ok: false, reason: 'invalid-ticket' };
    if (entry.state === 'committed') {
      return {
        ok: true,
        started: true,
        already: true,
        counted: entry.counted !== false,
        ticket: { kind: entry.kind, id: entry.opId, at: entry.committedAt ?? entry.reservedAt, ticketId, started: true },
      };
    }
    if (entry.state === 'aborted') return { ok: false, reason: 'ticket-aborted' };
    if (entry.state === 'expired') return { ok: false, reason: 'ticket-expired' };
    if (entry.state !== 'reserved') return { ok: false, reason: 'invalid-ticket' };

    const options = isPlainObject(rest) ? rest : {};
    const time = resolveEventTime(options.now);
    if (!time.ok) return { ok: false, reason: time.reason };
    sweepReservations(time.at);
    if (time.at > entry.expiresAt) {
      entry.state = 'expired';
      return { ok: false, reason: 'ticket-expired' };
    }
    if (time.at < entry.reservedAt || time.at < state.lastSeenAt) return { ok: false, reason: 'clock-rollback' };
    const rolled = rollToDay(time.at);
    if (!rolled.ok) return { ok: false, reason: rolled.reason };
    // 暂停可能在 reserve 之后翻转：commit 再检查一次，fail-closed（票据保持 reserved，恢复后可再 commit）。
    if (state.accessPaused) return { ok: false, reason: 'access-paused' };
    if (entry.kind !== 'read' && state.writePaused) return { ok: false, reason: 'write-paused' };

    if (entry.kind === 'read') {
      if (entry.counted === false) {
        state.lastSeenAt = Math.max(state.lastSeenAt, time.at);
      } else {
        recordRead(entry.opId, time.at);
      }
    } else {
      const bucket = state.buckets[entry.kind];
      bucket.count += 1;
      bucket.lastActionAt = time.at;
      state.lastSeenAt = time.at;
      state.operations[entry.opId] = { kind: entry.kind, status: 'pending', startedAt: time.at, finishedAt: null, late: false };
      pruneFinishedOperations(state, maxFinished);
    }
    entry.state = 'committed';
    entry.committedAt = time.at;

    const result = {
      ok: true,
      started: true,
      counted: entry.counted !== false,
      ticket: { kind: entry.kind, id: entry.opId, at: time.at, ticketId: entry.ticketId, started: true },
    };
    if (entry.kind === 'read') {
      result.remaining = Math.max(0, dailyLimits.read - state.readCount);
      if (entry.counted !== false) result.used = state.readCount;
    } else {
      result.used = state.buckets[entry.kind].count;
      result.limit = dailyLimits[entry.kind];
    }
    return result;
  }

  /**
   * 释放/回滚票据：
   *  · reserved → 直接释放（不计数、不动失败链，幂等）；
   *  · started（commitTicket 之后）→ 回滚：used-1、桶 count-1、operation 标 aborted、
   *    桶 lastActionAt 回退到上一条非 aborted 操作；不推进失败链/不触发暂停；
   *  · 已 aborted 再次 abort → 幂等 already:true；已 finish → already-finished（不回滚已确认结果）；
   *  · legacy 票据（无 ticketId）→ invalid-ticket；跨北京日回滚 → abort-day-mismatch（避免破坏新日账）。
   */
  async function abortTicketInternal(ticket, rest) {
    const payload = isPlainObject(ticket) ? ticket : {};
    const ticketId = payload.ticketId;
    if (typeof ticketId !== 'string' || ticketId === '') return { ok: false, reason: 'invalid-ticket' };
    const entry = reservations.get(ticketId);
    if (entry === undefined) return { ok: false, reason: 'invalid-ticket' };

    if (entry.state === 'aborted') {
      return { ok: true, aborted: true, already: true, rolledBack: entry.rolledBack === true, ticketId };
    }
    if (entry.state === 'expired') {
      reservations.delete(ticketId);
      return { ok: false, reason: 'ticket-expired' };
    }
    if (entry.state === 'reserved') {
      reservations.delete(ticketId);
      return { ok: true, aborted: true, rolledBack: false, ticketId };
    }
    if (entry.state !== 'committed') return { ok: false, reason: 'invalid-ticket' };

    const options = isPlainObject(rest) ? rest : {};
    const time = resolveEventTime(options.now);
    if (!time.ok) return { ok: false, reason: time.reason };
    const committedAt = entry.committedAt ?? entry.reservedAt;
    if (time.at < committedAt || time.at < state.lastSeenAt) return { ok: false, reason: 'clock-rollback' };
    const committedDay = safeDayKey(committedAt);
    const abortDay = safeDayKey(time.at);
    if (committedDay === null || abortDay === null) return { ok: false, reason: 'invalid-clock' };
    // 跨日回滚会破坏新日账（日计数已重置），明确拒绝；写操作保持 pending / 调用方按 unknown 收尾。
    if (abortDay !== committedDay) return { ok: false, reason: 'abort-day-mismatch' };

    let rolledBack = false;
    if (entry.kind === 'read') {
      if (entry.counted !== false && entry.quotaReset !== true) {
        state.readCount = Math.max(0, state.readCount - 1);
        rolledBack = true;
      }
      if (entry.opId !== null && hasOwn(state.operations, entry.opId)) {
        const operation = state.operations[entry.opId];
        if (operation.status === 'success') {
          operation.status = 'aborted';
          operation.finishedAt = time.at;
          operation.late = compareDayKey(safeDayKey(operation.startedAt), abortDay) !== 0;
        }
      }
    } else {
      const operation = entry.opId !== null && hasOwn(state.operations, entry.opId) ? state.operations[entry.opId] : null;
      if (operation === null) return { ok: false, reason: 'unknown-operation' };
      if (operation.status === 'aborted') {
        entry.state = 'aborted';
        entry.abortedAt = time.at;
        entry.rolledBack = false;
        return { ok: true, aborted: true, already: true, rolledBack: false, ticketId };
      }
      if (operation.status !== 'pending') return { ok: false, reason: 'already-finished' };
      const bucket = state.buckets[entry.kind];
      // 先标记 aborted，再重算 lastActionAt（否则会把本条已回滚操作算成“上一条”）。
      operation.status = 'aborted';
      operation.finishedAt = time.at;
      operation.late = compareDayKey(safeDayKey(operation.startedAt), abortDay) !== 0;
      if (entry.quotaReset !== true && operation.quotaReset !== true) bucket.count = Math.max(0, bucket.count - 1);
      const previousLastActionAt = recomputeBucketLastActionAt(entry.kind);
      if (previousLastActionAt !== null) {
        bucket.lastActionAt = previousLastActionAt;
      } else if (bucket.count === 0) {
        bucket.lastActionAt = null;
      }
      // 若 count>0 但历史记录被裁剪，则保守保留原 lastActionAt（宁可多等，不放宽间隔）。
      rolledBack = true;
    }

    state.lastSeenAt = Math.max(state.lastSeenAt, time.at);
    entry.state = 'aborted';
    entry.abortedAt = time.at;
    entry.rolledBack = rolledBack;
    pruneFinishedOperations(state, maxFinished);
    return { ok: true, aborted: true, rolledBack, ticketId };
  }

  // 兼容包装：authorizeRead / authorizeWrite = reserve + 立即 commit（原子，语义与旧版一致）。
  async function authorizeReadInternal(request) {
    const payload = isPlainObject(request) ? request : {};
    const reserved = await reserveReadInternal(payload);
    if (!reserved.ok) return reserved;
    const committed = await commitTicketInternal(reserved.ticket, { now: payload.now });
    if (!committed.ok) {
      await abortTicketInternal(reserved.ticket);
      return committed;
    }
    if (reserved.counted === false) {
      return { ok: true, counted: false, ticket: { kind: 'read', id: null, at: committed.ticket.at, counted: false } };
    }
    return {
      ok: true,
      counted: true,
      ticket: { kind: 'read', id: reserved.ticket.opId, at: committed.ticket.at, counted: true },
      remaining: committed.remaining,
    };
  }

  async function authorizeWriteInternal(request) {
    const payload = isPlainObject(request) ? request : {};
    const reserved = await reserveWriteInternal(payload);
    if (!reserved.ok) return reserved;
    const committed = await commitTicketInternal(reserved.ticket, { now: payload.now });
    if (!committed.ok) {
      await abortTicketInternal(reserved.ticket);
      return committed;
    }
    return {
      ok: true,
      ticket: { kind: reserved.ticket.kind, id: reserved.ticket.opId, at: committed.ticket.at },
      used: committed.used,
      limit: committed.limit,
    };
  }

  function nextTransitionId(prefix, dayKey, at) {
    state.transitionSeq += 1;
    return `${prefix}:${dayKey}:${at}:${state.transitionSeq}`;
  }

  /**
   * 记录转换事件。容量满时**不得**丢弃新产生的必须通知事件：
   * - 优先回收「已有可靠送达证明」（deliveredAt 由 reconcile 在送达账本命中后回写）的事件；
   * - 若全部未送达，则允许数组越过软上限继续追加，仅累计 transitionEventOverflow 留痕；
   * - 运行期到加载硬上限时显式拒绝（保持暂停保护），避免写出的状态重启后不可读；
   * - 暂停保护与旧 operationId 一律不动（恢复/再次暂停各自独立记录）。
   * 注：transitionEventError 现在只承载硬上限拒绝；软上限越界不再走该通道（改由 overflow 留痕）。
   */
  function recordTransitionEvent(event, reason, operationId, at) {
    if (state.transitionEvents.some((item) => item.operationId === operationId)) return { ok: true, duplicate: true };
    let overflow = false;
    if (state.transitionEvents.length >= TRANSITION_EVENTS_MAX) {
      const evictIndex = state.transitionEvents.findIndex((item) => typeof item.deliveredAt === 'number');
      if (evictIndex !== -1) {
        // 先回收已送达事件腾出空间；即使数组处于硬上限，也必须有收缩路径。
        state.transitionEvents.splice(evictIndex, 1);
      } else if (state.transitionEvents.length >= TRANSITION_EVENTS_LOAD_MAX) {
        // 无送达证明可回收且已达加载硬上限：显式拒绝（不丢语义由调用方 transitionEventError 暴露），
        // 保持暂停保护；overflow 只用于软上限越界追加的留痕，这里不计数以区分两种状态。
        return { ok: false, reason: 'transition-events-load-limit' };
      } else {
        state.transitionEventOverflow = (state.transitionEventOverflow ?? 0) + 1;
        overflow = true;
      }
    }
    state.transitionEvents.push({ event, reason: reason ?? null, operationId, at, deliveredAt: null });
    return overflow ? { ok: true, overflow: true } : { ok: true };
  }

  async function finishInternal(ticket, rest) {
    const payload = isPlainObject(ticket) ? ticket : {};
    const options = isPlainObject(rest) ? rest : {};
    if (payload.kind === 'read') return { ok: false, reason: 'read-ticket-not-finishable' };
    if (!WRITE_KIND_SET.has(payload.kind)) return { ok: false, reason: 'invalid-ticket' };
    const normalized = normalizeOperationId(payload.id);
    if (!normalized.ok) return { ok: false, reason: 'invalid-ticket' };
    const id = normalized.id;
    const outcome = options.outcome;
    if (typeof outcome !== 'string' || !FINISH_OUTCOMES.has(outcome)) {
      return { ok: false, reason: 'invalid-outcome' };
    }
    const time = resolveEventTime(options.now);
    if (!time.ok) return { ok: false, reason: time.reason };
    if (time.at < state.lastSeenAt) return { ok: false, reason: 'clock-rollback' };

    if (!hasOwn(state.operations, id)) return { ok: false, reason: 'unknown-operation' };
    const operation = state.operations[id];
    if (operation.status === 'aborted') return { ok: false, reason: 'invalid-ticket' };
    if (operation.kind !== payload.kind) return { ok: false, reason: 'invalid-ticket' };
    if (operation.status !== 'pending') return { ok: false, reason: 'already-finished' };
    if (time.at < operation.startedAt) return { ok: false, reason: 'clock-rollback' };

    // 跨日只重置日计数；迟到结果不得计入新日失败链，也不触发新日暂停。
    const rolled = rollToDay(time.at);
    if (!rolled.ok) return { ok: false, reason: rolled.reason };
    const startedDay = safeDayKey(operation.startedAt);
    const observedDay = rolled.dayKey;
    const late = compareDayKey(observedDay, startedDay) !== 0;

    operation.status = outcome;
    operation.finishedAt = time.at;
    operation.late = late;
    state.lastSeenAt = time.at;

    let notify = null;
    let transitionEventError = null;
    if (!late) {
      if (outcome === 'success') {
        state.consecutiveWriteFailures = 0;
      } else if (outcome === 'failure') {
        state.consecutiveWriteFailures += 1;
        if (!state.writePaused && state.consecutiveWriteFailures >= WRITE_FAILURE_THRESHOLD) {
          state.writePaused = true;
          state.writeReason = XHH_OP_WRITE_PAUSE_REASON;
          state.writePauseAt = time.at;
          state.writePauseEventId = nextTransitionId('write-pause', rolled.dayKey, time.at);
          const recorded = recordTransitionEvent('write-paused', state.writeReason, state.writePauseEventId, time.at);
          if (recorded.ok !== true) transitionEventError = recorded.reason;
          notify = 'write-failures';
        }
      }
    }
    pruneFinishedOperations(state, maxFinished);
    return {
      ok: true,
      id,
      outcome,
      late,
      writePaused: state.writePaused,
      notify,
      ...(notify === null ? {} : { operationId: state.writePauseEventId }),
      ...(transitionEventError === null ? {} : { transitionEventError }),
    };
  }

  async function reportAccessUnavailableInternal(request) {
    const payload = isPlainObject(request) ? request : {};
    const reason = payload.reason;
    if (!ACCESS_REASON_SET.has(reason)) return { ok: false, reason: 'invalid-access-reason' };
    const time = resolveEventTime(payload.now);
    if (!time.ok) return { ok: false, reason: time.reason };
    if (time.at < state.lastSeenAt) return { ok: false, reason: 'clock-rollback' };
    const rolled = rollToDay(time.at);
    if (!rolled.ok) return { ok: false, reason: rolled.reason };
    if (state.accessPaused) {
      state.lastSeenAt = Math.max(state.lastSeenAt, time.at);
      return { ok: true, already: true, reason: state.accessReason, notify: null };
    }
    state.accessPaused = true;
    state.accessReason = reason;
    state.accessPauseAt = time.at;
    state.accessPauseEventId = nextTransitionId('access-paused', rolled.dayKey, time.at);
    const recorded = recordTransitionEvent('access-paused', state.accessReason, state.accessPauseEventId, time.at);
    state.lastSeenAt = time.at;
    return {
      ok: true,
      already: false,
      reason,
      notify: reason,
      operationId: state.accessPauseEventId,
      ...(recorded.ok === true ? {} : { transitionEventError: recorded.reason }),
    };
  }

  async function adminRecoverInternal(request) {
    // 控制台任务卡要求「恢复写入」与「恢复全部访问」分开：前者不解除全部访问暂停，后者不解除写入暂停。
    // scope 缺省为 both，保持历史调用方（脚本/测试）行为逐字不变。
    const payload = isPlainObject(request) ? request : {};
    const scope = payload.scope === undefined ? 'both' : payload.scope;
    if (!['both', 'write', 'access'].includes(scope)) return { ok: false, reason: 'invalid-scope' };
    const recoverWrite = scope === 'both' || scope === 'write';
    const recoverAccess = scope === 'both' || scope === 'access';
    const wasPaused = (recoverWrite && state.writePaused) || (recoverAccess && state.accessPaused);
    const at = readTimestamp() ?? state.lastSeenAt;
    if (recoverWrite && state.writePaused) {
      state.consecutiveWriteFailures = 0;
      state.writePaused = false;
      state.writeReason = null;
    }
    if (recoverAccess && state.accessPaused) {
      state.accessPaused = false;
      state.accessReason = null;
    }
    // task-132：恢复不覆盖「暂停事件已产生但尚未送达」的事实：暂停事件 id/时间保留，
    // 由对账层继续投递；只有真正发生恢复转换才生成新的 recovered id。
    const recoverEventId = wasPaused ? nextTransitionId('admin-recover', safeDayKey(at) ?? state.day, at) : null;
    let transitionEventError = null;
    if (recoverEventId !== null) {
      state.lastRecoverEventId = recoverEventId;
      const recorded = recordTransitionEvent('recovered', 'admin-recover', recoverEventId, at);
      if (recorded.ok !== true) transitionEventError = recorded.reason;
    }
    // 恢复不重置：日计数/额度、lastActionAt（最小间隔）、operations（含 unknown）。
    return {
      ok: true,
      scope,
      wasPaused,
      writePaused: state.writePaused,
      accessPaused: state.accessPaused,
      recoverEventId,
      writePauseEventId: state.writePauseEventId ?? null,
      accessPauseEventId: state.accessPauseEventId ?? null,
      ...(transitionEventError === null ? {} : { transitionEventError }),
    };
  }

  /**
   * 控制台「重置额度」：把指定作用域的**已用次数**清零。
   * 明确不做：不解除暂停、不清 consecutiveWriteFailures、不清 lastActionAt（操作间隔）、
   * 不删 operations（含 unknown）—— 任务卡要求这些事实不能因为重置额度被抹掉。
   */
  async function resetDailyCountsInternal(request) {
    const payload = isPlainObject(request) ? request : {};
    const scope = payload.scope === undefined ? 'all' : payload.scope;
    if (!['all', 'browse', 'post', 'comment'].includes(scope)) return { ok: false, reason: 'invalid-scope' };
    const at = readTimestamp();
    if (at !== null && at > state.lastSeenAt) {
      const rolled = rollToDay(at);
      if (rolled.ok !== true) return { ok: false, reason: rolled.reason ?? 'clock-unavailable' };
    }
    const reset = [];
    if (scope === 'all' || scope === 'browse') { state.readCount = 0; reset.push('browse'); }
    if (scope === 'all' || scope === 'post') { state.buckets.post.count = 0; reset.push('post'); }
    if (scope === 'all' || scope === 'comment') { state.buckets.comment.count = 0; reset.push('comment'); }
    const kinds = new Set(reset.map((kind) => kind === 'browse' ? 'read' : kind));
    for (const operation of Object.values(state.operations)) {
      if (kinds.has(operation.kind) && safeDayKey(operation.startedAt) === state.day) operation.quotaReset = true;
    }
    for (const entry of reservations.values()) {
      if (entry.state === 'committed' && kinds.has(entry.kind)) entry.quotaReset = true;
    }
    // 落盘由调用方负责（controller 是纯内存状态机，只有 serialize()）：hook 重置后统一 persist。
    return { ok: true, scope, reset, writePaused: state.writePaused, accessPaused: state.accessPaused };
  }

  /**
   * task-132：为已暂停但缺转换 id 的旧状态补 legacy id（不改变暂停语义）。
   * 只做内存补写；持久化由调用方负责（与状态一起保存），因此本方法不返回「已落盘」。
   */
  /** 送达证明回写：只有通知队列确认送达（独立账本命中）后，事件才可被容量回收。 */
  async function markTransitionDeliveredInternal(request) {
    const payload = isPlainObject(request) ? request : {};
    const operationIds = Array.isArray(payload.operationIds) ? payload.operationIds : null;
    if (operationIds === null || operationIds.length === 0 || operationIds.length > TRANSITION_EVENTS_LOAD_MAX) {
      return { ok: false, reason: 'invalid-operation-ids' };
    }
    const at = readTimestamp() ?? state.lastSeenAt;
    let marked = 0;
    for (const id of operationIds) {
      const normalized = normalizeTransitionId(id);
      if (normalized.ok !== true || normalized.id === null) continue;
      const item = state.transitionEvents.find((entry) => entry.operationId === normalized.id);
      if (item === undefined || typeof item.deliveredAt === 'number') continue;
      item.deliveredAt = at;
      marked += 1;
    }
    return { ok: true, marked };
  }

  async function ensureTransitionIdsInternal() {
    let migrated = false;
    const at = state.lastSeenAt;
    let transitionEventError = null;
    if (state.writePaused && (state.writePauseEventId === null || state.writePauseEventId === undefined)) {
      state.writePauseAt = state.writePauseAt ?? at;
      state.writePauseEventId = `legacy:write-paused:${state.day}:${at}`;
      const recordedWrite = recordTransitionEvent('write-paused', 'write-paused', state.writePauseEventId, at);
      if (recordedWrite.ok !== true) transitionEventError = recordedWrite.reason;
      migrated = true;
    }
    if (state.accessPaused && (state.accessPauseEventId === null || state.accessPauseEventId === undefined)) {
      state.accessPauseAt = state.accessPauseAt ?? at;
      state.accessPauseEventId = `legacy:access-paused:${state.accessReason ?? 'unknown'}:${state.day}:${at}`;
      const recordedAccess = recordTransitionEvent('access-paused', state.accessReason, state.accessPauseEventId, at);
      if (recordedAccess.ok !== true) transitionEventError = recordedAccess.reason;
      migrated = true;
    }
    return {
      ok: true,
      migrated,
      at,
      writePaused: state.writePaused,
      accessPaused: state.accessPaused,
      writePauseEventId: state.writePauseEventId ?? null,
      accessPauseEventId: state.accessPauseEventId ?? null,
      ...(transitionEventError === null ? {} : { transitionEventError }),
    };
  }

  async function statusInternal() {
    const timestamp = readTimestamp();
    if (timestamp !== null && timestamp > state.lastSeenAt) {
      const rolled = rollToDay(timestamp);
      if (!rolled.ok) return snapshot(); // 时钟不可用时返回最后已知状态，不抛错
    }
    if (timestamp !== null) sweepReservations(timestamp);
    return snapshot();
  }

  async function closeInternal() {
    if (closed) return;
    closed = true;
    if (singletonKey !== null) registry.delete(singletonKey);
  }

  function enqueue(task) {
    const result = queue.then(() => task());
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function guarded(task) {
    return enqueue(() => {
      assertOpen();
      return task();
    });
  }

  return {
    reserveRead: (request) => guarded(() => reserveReadInternal(request)),
    reserveWrite: (request) => guarded(() => reserveWriteInternal(request)),
    commitTicket: (ticket, rest) => guarded(() => commitTicketInternal(ticket, rest)),
    abortTicket: (ticket, rest) => guarded(() => abortTicketInternal(ticket, rest)),
    authorizeRead: (request) => guarded(() => authorizeReadInternal(request)),
    authorizeWrite: (request) => guarded(() => authorizeWriteInternal(request)),
    finish: (ticket, options) => guarded(() => finishInternal(ticket, options)),
    reportAccessUnavailable: (request) => guarded(() => reportAccessUnavailableInternal(request)),
    resetDailyCounts: (request) => guarded(() => resetDailyCountsInternal(request)),
    adminRecover: (request) => {
      // 契约违反属于编程错误：同步抛 TypeError，不进队列（也不是鉴权）。
      const payload = isPlainObject(request) ? request : {};
      if (payload.verifiedAdminFrom !== 'console') {
        throw new TypeError(
          'adminRecover：必须由可信控制台传入 verifiedAdminFrom:"console"（这只是调用契约，不是鉴权）',
        );
      }
      return guarded(() => adminRecoverInternal(request));
    },
    status: () => guarded(statusInternal),
    /** 控制台保存后立即生效：只改上限，不清已用次数/间隔/暂停。 */
    setDailyLimits: (next) => guarded(() => applyDailyLimits(next)),
    dailyLimits: () => currentDailyLimits(),

    ensureTransitionIds: () => guarded(ensureTransitionIdsInternal),
    markTransitionDelivered: (request) => guarded(() => markTransitionDeliveredInternal(request)),
    serialize: () => JSON.stringify(state),
    close: () => enqueue(closeInternal),
  };
}
