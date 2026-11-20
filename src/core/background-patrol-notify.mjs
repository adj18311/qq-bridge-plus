/**
 * 后台巡逻：管理员通知队列（**纯模块，未接线**）。
 *
 * 目的：把「需要通知管理员」的事件排成可持久化队列，由桥接负责最终通过 QQ 私聊发送；
 * 本模块**不发送、不读 config、不联网**，只维护 pending/最近投递记录与幂等投递结果。
 *
 * 事件白名单（按用户 2026-10-25 决策）：write-paused / access-paused / recovered / report-unknown。
 *
 * 规则：
 *  · 持久化：同目录 `${base}.${randomUUID()}.tmp`（'wx'+0600）→ writeFile → datasync →
 *    rename → 目录 sync（best-effort）；失败 → 进入 **degraded**（旧文件保留、内存不提交、
 *    后续写返回 degraded；`reload()` 可从磁盘恢复）。
 *  · 并发：实例内 Promise 队列串行。
 *  · pending：按 `at` 升序保存，最多 50 条（满了返回 queue-full，不静默丢弃）。
 *  · 去重：同 `event + reason` 在 10 分钟窗口内（含边界，覆盖 pending 与最近已投递记录）→
 *    返回 `{ok:true, duplicate:true}`，不新增条目。
 *  · markDelivered：成功 → 移除并写入 recent；失败 → **保留 pending、attempts+1、记录 lastError**，
 *    模块不自动重投；同一 (id, at) 重复失败幂等（already:true），未知/已移除 id 的投递结果为幂等成功。
 *  · meta 白名单：`platform`（tieba/xiaoheihe）、`operationId`（≤200）、`attempts`（>=0 整数）、
 *    `code`（≤64）；禁止 `message / cookie / token / path / qq`（明确 forbidden-meta）；
 *    其它未知键 invalid-meta。绝不写 prompt/正文/凭据/路径。
 *  · close() 只停止本实例（不做归档/网络操作）。
 *
 * 明确不做：不发送 QQ、不持有发送凭据、不决定接收人、不做节流/重试、不落审计（审计另行接线）；
 * 不接线 bridge/调度器；没有跨进程锁；假定同一 filePath 单实例使用。
 */

import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

export const BACKGROUND_PATROL_NOTIFY_QUEUE_VERSION = 1;
export const BACKGROUND_PATROL_NOTIFY_EVENTS = Object.freeze([
  'write-paused',
  'access-paused',
  'recovered',
  'report-unknown',
]);
export const BACKGROUND_PATROL_NOTIFY_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
export const BACKGROUND_PATROL_NOTIFY_MAX_PENDING = 50;
export const BACKGROUND_PATROL_NOTIFY_MAX_RECENT = 100;
// task-132：独立「送达账本」上限（最近 N 个转换的送达事实，重启后仍可判定，不被 recent 10 分钟窗口裁掉）。
export const BACKGROUND_PATROL_NOTIFY_MAX_DELIVERED = 500;
const DELIVERED_VERSION = 1;
// 与审计 OPID_RE 对齐：新入队才收紧；旧状态 parse 保持宽松以兼容回滚。
const OPID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const BACKGROUND_PATROL_NOTIFY_META_KEYS = Object.freeze(['platform', 'operationId', 'attempts', 'code']);
export const BACKGROUND_PATROL_NOTIFY_ERROR_CODES = Object.freeze({
  STATE_INVALID: 'BACKGROUND_PATROL_NOTIFY_STATE_INVALID',
  LOAD_FAILED: 'BACKGROUND_PATROL_NOTIFY_LOAD_FAILED',
});

const EVENT_SET = new Set(BACKGROUND_PATROL_NOTIFY_EVENTS);
const META_KEY_SET = new Set(BACKGROUND_PATROL_NOTIFY_META_KEYS);
const FORBIDDEN_META_KEYS = Object.freeze(['message', 'cookie', 'token', 'path', 'qq']);
const FORBIDDEN_META_KEY_SET = new Set(FORBIDDEN_META_KEYS);
const MAX_REASON_LENGTH = 200;
const MAX_OPERATION_ID_LENGTH = 200;
const MAX_CODE_LENGTH = 64;
const MAX_ATTEMPTS_VALUE = 1_000_000;
const PLATFORM_SET = new Set(['tieba', 'xiaoheihe']);
const TOP_KEYS = Object.freeze(['schemaVersion', 'items', 'recent']);
const ITEM_KEYS = Object.freeze(['id', 'event', 'reason', 'at', 'meta', 'attempts', 'lastAttemptAt', 'lastError']);
const RECENT_KEYS = Object.freeze(['id', 'event', 'reason', 'at', 'deliveredAt', 'operationId']);
const RECENT_REQUIRED_KEYS = Object.freeze(['id', 'event', 'reason', 'at', 'deliveredAt']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isFiniteTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function stateInvalid(message) {
  const error = new Error(`xhh 通知队列状态不可用：${message}`);
  error.code = BACKGROUND_PATROL_NOTIFY_ERROR_CODES.STATE_INVALID;
  return error;
}

function validateMeta(meta, options = {}) {
  const strictOperationId = options.strictOperationId === true;
  if (meta === undefined || meta === null) return { ok: true, meta: {} };
  if (!isPlainObject(meta)) return { ok: false, reason: 'invalid-meta' };
  for (const key of Object.keys(meta)) {
    if (FORBIDDEN_META_KEY_SET.has(key)) return { ok: false, reason: 'forbidden-meta' };
    if (!META_KEY_SET.has(key)) return { ok: false, reason: 'invalid-meta' };
  }
  const normalized = {};
  if (hasOwn(meta, 'platform')) {
    if (typeof meta.platform !== 'string' || !PLATFORM_SET.has(meta.platform)) return { ok: false, reason: 'invalid-meta' };
    normalized.platform = meta.platform;
  }
  if (hasOwn(meta, 'operationId')) {
    if (typeof meta.operationId !== 'string'
      || meta.operationId.length === 0
      || meta.operationId.length > MAX_OPERATION_ID_LENGTH
      || (strictOperationId && !OPID_RE.test(meta.operationId))) return { ok: false, reason: 'invalid-meta' };
    normalized.operationId = meta.operationId;
  }
  if (hasOwn(meta, 'attempts')) {
    if (!isCount(meta.attempts) || meta.attempts > MAX_ATTEMPTS_VALUE) return { ok: false, reason: 'invalid-meta' };
    normalized.attempts = meta.attempts;
  }
  if (hasOwn(meta, 'code')) {
    if (typeof meta.code !== 'string' || meta.code.length === 0 || meta.code.length > MAX_CODE_LENGTH) {
      return { ok: false, reason: 'invalid-meta' };
    }
    normalized.code = meta.code;
  }
  return { ok: true, meta: normalized };
}

function validateReason(reason) {
  return typeof reason === 'string' && reason.trim() !== '' && reason.length <= MAX_REASON_LENGTH;
}

function cloneItems(items) {
  return items.map((item) => ({ ...item, meta: { ...item.meta } }));
}

function sortItems(items) {
  return [...items].sort((left, right) => {
    if (left.at !== right.at) return left.at - right.at;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function createEmptyState() {
  return { schemaVersion: BACKGROUND_PATROL_NOTIFY_QUEUE_VERSION, items: [], recent: [] };
}

function cloneState(state) {
  return {
    schemaVersion: state.schemaVersion,
    items: cloneItems(state.items),
    recent: state.recent.map((entry) => ({ ...entry })),
  };
}

function parseNotifyState(raw) {
  if (!isPlainObject(raw)) throw stateInvalid('状态根必须是对象');
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.includes(key)) throw stateInvalid(`状态含不支持字段 ${key}`);
  }
  for (const key of TOP_KEYS) {
    if (!hasOwn(raw, key)) throw stateInvalid(`状态缺少字段 ${key}`);
  }
  if (raw.schemaVersion !== BACKGROUND_PATROL_NOTIFY_QUEUE_VERSION) throw stateInvalid('schemaVersion 不受支持');
  if (!Array.isArray(raw.items)) throw stateInvalid('items 必须是数组');
  if (raw.items.length > BACKGROUND_PATROL_NOTIFY_MAX_PENDING) throw stateInvalid('items 超过 pending 上限');
  if (!Array.isArray(raw.recent)) throw stateInvalid('recent 必须是数组');
  if (raw.recent.length > BACKGROUND_PATROL_NOTIFY_MAX_RECENT) throw stateInvalid('recent 超过上限');

  const seenIds = new Set();
  const items = raw.items.map((item) => {
    if (!isPlainObject(item)) throw stateInvalid('items 条目必须是对象');
    for (const key of Object.keys(item)) {
      if (!ITEM_KEYS.includes(key)) throw stateInvalid(`items 条目含不支持字段 ${key}`);
    }
    for (const key of ITEM_KEYS) {
      if (!hasOwn(item, key)) throw stateInvalid(`items 条目缺少字段 ${key}`);
    }
    if (typeof item.id !== 'string' || item.id.length === 0 || seenIds.has(item.id)) throw stateInvalid('items id 非法或重复');
    seenIds.add(item.id);
    if (typeof item.event !== 'string' || !EVENT_SET.has(item.event)) throw stateInvalid('items event 不受支持');
    if (!validateReason(item.reason)) throw stateInvalid('items reason 非法');
    if (!isFiniteTimestamp(item.at)) throw stateInvalid('items at 非法');
    const meta = validateMeta(item.meta);
    if (!meta.ok) throw stateInvalid(`items meta 非法（${meta.reason}）`);
    if (!isCount(item.attempts) || item.attempts > MAX_ATTEMPTS_VALUE) throw stateInvalid('items attempts 非法');
    if (!(item.lastAttemptAt === null || isFiniteTimestamp(item.lastAttemptAt))) throw stateInvalid('items lastAttemptAt 非法');
    if (!(item.lastError === null
      || (typeof item.lastError === 'string' && item.lastError.length > 0 && item.lastError.length <= MAX_CODE_LENGTH))) {
      throw stateInvalid('items lastError 非法');
    }
    return {
      id: item.id,
      event: item.event,
      reason: item.reason,
      at: item.at,
      meta: meta.meta,
      attempts: item.attempts,
      lastAttemptAt: item.lastAttemptAt,
      lastError: item.lastError,
    };
  });

  const recent = raw.recent.map((entry) => {
    if (!isPlainObject(entry)) throw stateInvalid('recent 条目必须是对象');
    for (const key of Object.keys(entry)) {
      if (!RECENT_KEYS.includes(key)) throw stateInvalid(`recent 条目含不支持字段 ${key}`);
    }
    for (const key of RECENT_REQUIRED_KEYS) {
      if (!hasOwn(entry, key)) throw stateInvalid(`recent 条目缺少字段 ${key}`);
    }
    if (typeof entry.id !== 'string' || entry.id.length === 0) throw stateInvalid('recent id 非法');
    if (typeof entry.event !== 'string' || !EVENT_SET.has(entry.event)) throw stateInvalid('recent event 不受支持');
    if (!validateReason(entry.reason)) throw stateInvalid('recent reason 非法');
    if (!isFiniteTimestamp(entry.at) || !isFiniteTimestamp(entry.deliveredAt)) throw stateInvalid('recent 时间非法');
    const parsed = { id: entry.id, event: entry.event, reason: entry.reason, at: entry.at, deliveredAt: entry.deliveredAt };
    if (hasOwn(entry, 'operationId')) {
      if (typeof entry.operationId !== 'string'
        || entry.operationId.length === 0
        || entry.operationId.length > MAX_OPERATION_ID_LENGTH) throw stateInvalid('recent operationId 非法');
      parsed.operationId = entry.operationId;
    }
    return parsed;
  });

  return { schemaVersion: BACKGROUND_PATROL_NOTIFY_QUEUE_VERSION, items, recent };
}

function defaultFsOps() {
  return {
    readFile: (target, encoding) => fsPromises.readFile(target, encoding),
    mkdir: (target) => fsPromises.mkdir(target, { recursive: true }),
    open: (target, flags, mode) => fsPromises.open(target, flags, mode),
    rename: (from, to) => fsPromises.rename(from, to),
    unlink: (target) => fsPromises.unlink(target),
  };
}

function resolveClock(clock) {
  if (clock === undefined || clock === null) return () => Date.now();
  if (typeof clock === 'function') return () => clock();
  if (typeof clock === 'object' && typeof clock.now === 'function') return () => clock.now();
  throw new TypeError('createBackgroundPatrolNotifyQueue：clock 必须是函数或带 now() 的对象');
}

/**
 * 创建管理员通知队列（纯模块）。
 *
 * @param {object} options
 * @param {string} options.filePath 队列状态文件路径（必须显式注入，无默认真实路径；本模块不读 config）
 * @param {(() => number) | { now?: () => number }} [options.clock]
 * @param {object} [options.fsOps] 可注入文件系统原语（测试用：readFile/mkdir/open/rename/unlink）
 */
export function createBackgroundPatrolNotifyQueue(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const filePath = source.filePath;
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new TypeError('createBackgroundPatrolNotifyQueue：options.filePath 必须是非空字符串（无默认路径）');
  }
  const resolvedFilePath = path.resolve(filePath);
  const directory = path.dirname(resolvedFilePath);
  const baseName = path.basename(resolvedFilePath);
  const clock = resolveClock(source.clock);
  const overrides = isPlainObject(source.fsOps) ? source.fsOps : {};
  const ops = { ...defaultFsOps() };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'function') ops[key] = value;
  }

  let phase = 'uninitialized'; // uninitialized | ready | degraded | closed
  let state = createEmptyState();
  let lastError = null;
  let lastReject = null;
  let lastFailure = null;
  let queue = Promise.resolve();

  function recordReject(reason, at) {
    lastReject = { reason, at: isFiniteTimestamp(at) ? at : clockNow() };
  }

  // task-132：把「非入队类」的落盘失败也显式暴露（markDelivered/reload），
  // 与 lastReject（入队被拒）区分，便于桥接侧告警与重试判断。
  function recordFailure(operation, reason, at) {
    lastFailure = { operation, reason, at: isFiniteTimestamp(at) ? at : clockNow() };
  }

  function clockNow() {
    let value;
    try {
      value = clock();
    } catch {
      return null;
    }
    return isFiniteTimestamp(value) ? value : null;
  }

  function resolveAt(explicit) {
    if (explicit === undefined || explicit === null) return clockNow();
    return isFiniteTimestamp(explicit) ? explicit : null;
  }

  function recordWriteError(causeCode) {
    lastError = {
      code: 'WRITE_FAILED',
      causeCode: causeCode ?? null,
      message: 'xhh 通知队列写入失败',
      at: clockNow(),
    };
  }

  async function writeAtomicallyTo(payload, targetPath) {
    const targetDirectory = path.dirname(targetPath);
    const targetBase = path.basename(targetPath);
    const tempPath = path.join(targetDirectory, `${targetBase}.${crypto.randomUUID()}.tmp`);
    await ops.mkdir(targetDirectory, { recursive: true });
    const handle = await ops.open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      if (typeof handle.datasync === 'function') await handle.datasync();
      else if (typeof handle.sync === 'function') await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
    try {
      await ops.rename(tempPath, targetPath);
    } catch (error) {
      await ops.unlink(tempPath).catch(() => {});
      throw error;
    }
    // 目录 sync best-effort（Windows 打开目录可能失败，忽略）。
    try {
      const dirHandle = await ops.open(targetDirectory, 'r');
      try {
        if (typeof dirHandle.sync === 'function') await dirHandle.sync();
      } finally {
        await dirHandle.close().catch(() => {});
      }
    } catch {
      // ignore
    }
  }

  async function writeAtomically(payload) {
    await writeAtomicallyTo(payload, resolvedFilePath);
  }

  async function persist(nextState) {
    try {
      await writeAtomically(JSON.stringify(nextState));
    } catch (error) {
      phase = 'degraded';
      recordWriteError(error?.code);
      return false;
    }
    state = cloneState(nextState);
    return true;
  }

  // task-132：独立送达账本（`<queue>.delivered.json`）。不改变队列 schema，旧程序回滚可忽略此文件，
  // 最坏结果是重复通知（用户已确认可接受）。用于「暂停/恢复转换是否已送达」的跨重启判定。
  const deliveredFilePath = path.join(directory, `${baseName}.delivered.json`);
  let delivered = [];
  let deliveredLoaded = false;

  async function ensureDeliveredLoaded() {
    if (deliveredLoaded) return;
    let text;
    try {
      text = await ops.readFile(deliveredFilePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        delivered = [];
        deliveredLoaded = true;
        return;
      }
      throw stateInvalid('delivered 账本读取失败');
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw stateInvalid('delivered 账本不是合法 JSON');
    }
    if (!isPlainObject(parsed) || parsed.schemaVersion !== DELIVERED_VERSION || !Array.isArray(parsed.entries)) {
      throw stateInvalid('delivered 账本结构不合法');
    }
    const entries = [];
    for (const entry of parsed.entries) {
      if (!isPlainObject(entry)
        || !EVENT_SET.has(entry.event)
        || typeof entry.operationId !== 'string'
        || !OPID_RE.test(entry.operationId)
        || !isFiniteTimestamp(entry.deliveredAt)) {
        throw stateInvalid('delivered 账本条目不合法');
      }
      entries.push({ event: entry.event, operationId: entry.operationId, deliveredAt: entry.deliveredAt });
    }
    delivered = entries.slice(-BACKGROUND_PATROL_NOTIFY_MAX_DELIVERED);
    deliveredLoaded = true;
  }

  async function persistDelivered(nextEntries) {
    try {
      await writeAtomicallyTo(
        JSON.stringify({ schemaVersion: DELIVERED_VERSION, entries: nextEntries }),
        deliveredFilePath,
      );
    } catch {
      recordFailure('delivered', 'persist-failed', clockNow());
      return false;
    }
    delivered = nextEntries;
    return true;
  }

  async function wasDeliveredInternal(event, operationId) {
    if (!EVENT_SET.has(event)) return { ok: false, reason: 'invalid-event' };
    if (typeof operationId !== 'string' || !OPID_RE.test(operationId)) {
      return { ok: false, reason: 'invalid-operation-id' };
    }
    await ensureDeliveredLoaded();
    const hit = delivered.find((entry) => entry.event === event && entry.operationId === operationId);
    return { ok: true, delivered: hit !== undefined, deliveredAt: hit === undefined ? null : hit.deliveredAt, count: delivered.length };
  }

  async function recordDeliveredInternal(request) {
    const payload = isPlainObject(request) ? request : {};
    if (!EVENT_SET.has(payload.event)) return { ok: false, reason: 'invalid-event' };
    if (typeof payload.operationId !== 'string' || !OPID_RE.test(payload.operationId)) {
      return { ok: false, reason: 'invalid-operation-id' };
    }
    const at = resolveAt(payload.at);
    if (at === null) return { ok: false, reason: 'invalid-time' };
    await ensureDeliveredLoaded();
    const existing = delivered.find((entry) => entry.event === payload.event && entry.operationId === payload.operationId);
    if (existing !== undefined) return { ok: true, already: true, deliveredAt: existing.deliveredAt };
    const next = [...delivered, { event: payload.event, operationId: payload.operationId, deliveredAt: at }]
      .slice(-BACKGROUND_PATROL_NOTIFY_MAX_DELIVERED);
    if (!(await persistDelivered(next))) return { ok: false, reason: 'persist-failed' };
    return { ok: true, recorded: true, deliveredAt: at };
  }

  function readyGuard() {
    if (phase === 'closed') return { ok: false, reason: 'closed' };
    if (phase === 'degraded') return { ok: false, reason: 'degraded' };
    if (phase !== 'ready') return { ok: false, reason: 'not-loaded' };
    return null;
  }

  function pruneRecent(recent, now) {
    // task-132：保留窗口按 deliveredAt 计算（缺省回退 at）。旧实现按 at 计算，
    // 长时间 pending 的记录一旦刚投递成功，就可能因 at 过旧被立刻裁掉，失去去重依据。
    const kept = recent
      .filter((entry) => now === null || now - (entry.deliveredAt ?? entry.at) <= BACKGROUND_PATROL_NOTIFY_DEDUPE_WINDOW_MS)
      .slice(-BACKGROUND_PATROL_NOTIFY_MAX_RECENT);
    return kept;
  }

  function findDuplicate(event, reason, now, operationId) {
    // 状态转换去重（task-131）：调用方在 meta 带 operationId 时，按 (event, operationId)
    // 判定同一转换，忽略 reason 文本与 10 分钟窗口；pending 与 recent 都参与匹配。
    if (typeof operationId === 'string' && operationId.length > 0) {
      for (const item of state.items) {
        if (item.event === event && item.meta?.operationId === operationId) {
          return { id: item.id, event: item.event, reason: item.reason, at: item.at, delivered: false, operationId };
        }
      }
      for (const entry of state.recent) {
        if (entry.event === event && entry.operationId === operationId) {
          return { id: entry.id, event: entry.event, reason: entry.reason, at: entry.at, delivered: true, operationId };
        }
      }
      return null;
    }
    if (now === null) return null;
    const within = (at) => Math.abs(now - at) <= BACKGROUND_PATROL_NOTIFY_DEDUPE_WINDOW_MS;
    // task-132：旧式（无 operationId）记录只与旧式记录比较，避免 event+reason 误吞带 ID 的
    // 独立转换事件（反之亦然，见上面的 operationId 分支）。
    for (const item of state.items) {
      if (item.meta?.operationId !== undefined) continue;
      if (item.event === event && item.reason === reason && within(item.at)) {
        return { id: item.id, event: item.event, reason: item.reason, at: item.at, delivered: false };
      }
    }
    for (const entry of state.recent) {
      if (entry.operationId !== undefined) continue;
      if (entry.event === event && entry.reason === reason && within(entry.at)) {
        return { id: entry.id, event: entry.event, reason: entry.reason, at: entry.at, delivered: true };
      }
    }
    return null;
  }

  async function loadInternal() {
    if (phase === 'closed') return { ok: false, reason: 'closed' };
    if (phase === 'ready' || phase === 'degraded') return { ok: true };
    let rawText;
    try {
      rawText = await ops.readFile(resolvedFilePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        const wrapped = new Error(`xhh 通知队列读取失败：${error?.message ?? String(error)}`);
        wrapped.code = BACKGROUND_PATROL_NOTIFY_ERROR_CODES.LOAD_FAILED;
        wrapped.cause = error;
        throw wrapped;
      }
      state = createEmptyState();
      phase = 'ready';
      lastError = null;
      return { ok: true };
    }
    try {
      state = parseNotifyState(JSON.parse(rawText));
    } catch (error) {
      const wrapped = new Error(`xhh 通知队列状态不可用：${error?.message ?? String(error)}`);
      wrapped.code = BACKGROUND_PATROL_NOTIFY_ERROR_CODES.LOAD_FAILED;
      wrapped.cause = error;
      throw wrapped;
    }
    state.recent = pruneRecent(state.recent, clockNow());
    phase = 'ready';
    lastError = null;
    return { ok: true };
  }

  async function enqueueInternal(request) {
    const guard = readyGuard();
    if (guard !== null) return guard;
    const payload = isPlainObject(request) ? request : {};
    if (typeof payload.event !== 'string' || !EVENT_SET.has(payload.event)) {
      return { ok: false, reason: 'invalid-event' };
    }
    if (!validateReason(payload.reason)) return { ok: false, reason: 'invalid-reason' };
    const metaResult = validateMeta(payload.meta, { strictOperationId: true });
    if (!metaResult.ok) return metaResult;
    const at = resolveAt(payload.at);
    if (at === null) return { ok: false, reason: 'invalid-time' };

    const duplicate = findDuplicate(payload.event, payload.reason, at, metaResult.meta.operationId);
    if (duplicate !== null) return { ok: true, duplicate: true, existing: duplicate };
    if (state.items.length >= BACKGROUND_PATROL_NOTIFY_MAX_PENDING) {
      recordReject('queue-full', at);
      return { ok: false, reason: 'queue-full' };
    }

    const next = cloneState(state);
    const item = {
      id: crypto.randomUUID(),
      event: payload.event,
      reason: payload.reason,
      at,
      meta: metaResult.meta,
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
    };
    next.items.push(item);
    next.items = sortItems(next.items);
    next.recent = pruneRecent(next.recent, clockNow());
    if (!(await persist(next))) {
      recordReject('persist-failed', at);
      return { ok: false, reason: 'persist-failed' };
    }
    return { ok: true, id: item.id, at, pending: state.items.length, duplicate: false };
  }

  async function markDeliveredInternal(request) {
    const guard = readyGuard();
    if (guard !== null) return guard;
    const payload = isPlainObject(request) ? request : {};
    if (typeof payload.id !== 'string' || payload.id.length === 0 || payload.id.length > 200) {
      return { ok: false, reason: 'invalid-id' };
    }
    if (typeof payload.delivered !== 'boolean') return { ok: false, reason: 'invalid-delivered' };
    let code = null;
    if (payload.code !== undefined && payload.code !== null) {
      if (typeof payload.code !== 'string' || payload.code.length === 0 || payload.code.length > MAX_CODE_LENGTH) {
        return { ok: false, reason: 'invalid-code' };
      }
      code = payload.code;
    }
    const at = resolveAt(payload.at);
    if (at === null) return { ok: false, reason: 'invalid-time' };

    const index = state.items.findIndex((item) => item.id === payload.id);
    if (payload.delivered === true) {
      if (index < 0) return { ok: true, already: true };
      const next = cloneState(state);
      const [removed] = next.items.splice(index, 1);
      const deliveredEntry = {
        id: removed.id,
        event: removed.event,
        reason: removed.reason,
        at: removed.at,
        deliveredAt: at,
      };
      // 状态转换去重（task-131）：recent 保留 meta.operationId，供重启后重放判定。
      if (typeof removed.meta?.operationId === 'string' && removed.meta.operationId.length > 0) {
        deliveredEntry.operationId = removed.meta.operationId;
      }
      next.recent.push(deliveredEntry);
      next.recent = pruneRecent(next.recent, clockNow());
      if (!(await persist(next))) {
        recordFailure('markDelivered', 'persist-failed', at);
        return { ok: false, reason: 'persist-failed' };
      }
      // task-132：成功投递后把「转换已送达」写入独立账本（失败只记录、不撤销已投递事实）。
      let deliveredRecorded = null;
      if (typeof removed.meta?.operationId === 'string' && removed.meta.operationId.length > 0) {
        const recorded = await recordDeliveredInternal({
          event: removed.event,
          operationId: removed.meta.operationId,
          at,
        });
        deliveredRecorded = recorded.ok === true;
      }
      return {
        ok: true,
        removed: true,
        id: removed.id,
        ...(deliveredRecorded === null ? {} : { deliveredRecorded }),
      };
    }

    if (index < 0) return { ok: true, already: true };
    const existing = state.items[index];
    if (existing.lastAttemptAt === at) return { ok: true, already: true };
    const next = cloneState(state);
    const target = next.items[index];
    target.attempts += 1;
    target.lastAttemptAt = at;
    target.lastError = code ?? 'UNKNOWN';
    if (!(await persist(next))) {
      recordFailure('markDelivered', 'persist-failed', at);
      return { ok: false, reason: 'persist-failed' };
    }
    return { ok: true, retained: true, id: target.id, attempts: target.attempts };
  }

  async function reloadInternal() {
    if (phase === 'closed') return { ok: false, reason: 'closed' };
    phase = 'uninitialized';
    lastError = null;
    try {
      await loadInternal();
      // task-132（P3）：reload 成功表示已重新建立一致状态，清掉上一次失败观测，
      // 避免 lastFailure 永久悬挂；失败时下面会重新记录。
      lastFailure = null;
      return { ok: true, pendingCount: state.items.length };
    } catch {
      phase = 'degraded';
      recordWriteError('RELOAD_FAILED');
      recordFailure('reload', 'reload-failed', null);
      return { ok: false, reason: 'reload-failed' };
    }
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
    phase = 'closed';
    return { ok: true };
  }

  return {
    load: () => enqueue(loadInternal),
    reload: () => enqueue(reloadInternal),
    enqueue: (request) => enqueue(() => enqueueInternal(request)),
    markDelivered: (request) => enqueue(() => markDeliveredInternal(request)),
    wasDelivered: (event, operationId) => enqueue(async () => {
      try {
        return await wasDeliveredInternal(event, operationId);
      } catch (error) {
        if (error?.code === BACKGROUND_PATROL_NOTIFY_ERROR_CODES.STATE_INVALID) {
          return { ok: false, reason: 'delivered-state-invalid' };
        }
        throw error;
      }
    }),
    recordDelivered: (request) => enqueue(async () => {
      try {
        return await recordDeliveredInternal(request);
      } catch (error) {
        if (error?.code === BACKGROUND_PATROL_NOTIFY_ERROR_CODES.STATE_INVALID) {
          return { ok: false, reason: 'delivered-state-invalid' };
        }
        throw error;
      }
    }),
    snapshot: () => enqueue(async () => ({
      schemaVersion: state.schemaVersion,
      items: sortItems(cloneItems(state.items)),
      recent: state.recent.map((entry) => ({ ...entry })),
    })),
    status: () => enqueue(async () => ({
      version: BACKGROUND_PATROL_NOTIFY_QUEUE_VERSION,
      filePath: resolvedFilePath,
      pendingCount: state.items.length,
      degraded: phase === 'degraded',
      phase,
      lastError: lastError === null ? null : { ...lastError },
      // 入队被拒（queue-full / persist-failed）的可观察信号，供桥接侧告警。
      lastReject: lastReject === null ? null : { ...lastReject },
      // 非入队类落盘失败（markDelivered/reload/delivered 账本）的可观察信号（task-132）。
      lastFailure: lastFailure === null ? null : { ...lastFailure },
      // 送达账本条目数：供对账层判断是否有历史转换记录（0 表示尚未写或文件不存在）。
      deliveredCount: delivered.length,
      deliveredLoaded,
    })),
    close: () => enqueue(closeInternal),
  };
}
