/**
 * owner-notice-outbox.mjs —— 「给 owner 发一条事实提示」的桥接侧状态机（阶段 2C，纯模块）
 *
 * 设计约束（来自 Codex 终审 m39499 与用户口径）：
 *  · 失败/未知 ⇒ **持续补报**，间隔 ≥15 分钟，**不得静默耗尽**；
 *  · 不承诺 exactly-once：同一 eventId 可能发送多次（unknown/failed 重试），审计必须诚实记录每次 attemptId；
 *  · 超时按 `unknown`（超时不证明未发出）；仅「明确未建立连接」类错误才算 `failed`；
 *  · 先写「尝试已开始」再发送（write-ahead）：崩溃后该 attempt 会被判 `unknown/attempt-interrupted` 并进入重试，
 *    因此可能重复，但不会「崩溃即永久丢失」；
 *  · 每次读写失败都可观察（返回 reason + log），且**写失败时不发送**（避免无记录的发送）；
 *  · `unknown` 会进入重试（因此可能重复发送）；`failed` 同样重试。只有 `delivered` 才停止；
 *  · **信任边界**：`consecutiveMisses`/`lastSeenAt` 由调用方自报，本模块只校验形状/范围/时间窗口，
 *    不能证明「服务端独立观测到连续 3 次缺失」；该判定属于调用方责任，本模块只负责限流与去重。
 *  · 严格输入：事件类型枚举、整数范围、无自由文本、无路径/凭据/URL。
 *  · 单实例：`open('wx')` 独占创建，**不做自动接管**（unlink→open 不是原子事务，会双持有）；
 *    **不做自动恢复，也不暴露运行期恢复接口**：`rename` 之后的瞬间锁路径为空，别的进程可以
 *    拿到新锁，恢复流程再写回就会双持有。恢复只允许离线进行 —— 先停掉所有会写这个状态文件的
 *    进程，再由人删除 `<state>.lock`；本模块重启后自然重新加锁。
 *  · 时钟：记录时间落在未来（回拨/污染）⇒ 一律 fail-closed 跳过，绝不因此缩短 15 分钟间隔。
 *
 * 明确不做：不发送 QQ（由调用方注入 send）、不决定接收人、不持有凭据、不读环境、不联网。
 */

import crypto from 'node:crypto';
import fsDefault from 'node:fs/promises';
import path from 'node:path';

export const OWNER_NOTICE_SCHEMA_VERSION = 1;
export const OWNER_NOTICE_KINDS = Object.freeze(['tool-surface-missing', 'tool-surface-recovered']);
export const OWNER_NOTICE_RETRY_MIN_MS = 15 * 60 * 1000;
export const OWNER_NOTICE_MAX_ATTEMPTS_PER_HOUR = 6;
export const OWNER_NOTICE_ATTEMPT_STALE_MS = 10 * 60 * 1000;
export const OWNER_NOTICE_MAX_REQUEST_BYTES = 2048;
export const OWNER_NOTICE_MAX_OPEN_EVENTS = 20;
export const OWNER_NOTICE_MAX_ATTEMPTS_KEPT = 50;
/** 已结算（delivered/closed）事件保留条数；超出后按 finish 时间滚动裁剪最旧的。 */
export const OWNER_NOTICE_MAX_SETTLED_EVENTS = 200;
export const OWNER_NOTICE_EVENT_ID_MAX = 64;
export const OWNER_NOTICE_INT_MAX = 64;
/** 请求里的时间戳窗口：太旧/太未来一律拒绝（防止伪造未来事件占槽位、或 MAX_SAFE_INTEGER 让渲染抛错）。 */
export const OWNER_NOTICE_REQUEST_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const OWNER_NOTICE_REQUEST_MAX_FUTURE_MS = 5 * 60 * 1000;

const KIND_SET = new Set(OWNER_NOTICE_KINDS);
const EVENT_ID_RE = /^[0-9a-f-]{16,64}$/u;
const REQUEST_KEYS = Object.freeze(['schemaVersion', 'eventId', 'kind', 'missingCount', 'consecutiveMisses', 'lastSeenAt', 'createdAt']);

/** 明确「请求根本没建立连接」的错误码 —— 只有这些算 failed，其余传输错误一律 unknown。 */
const DEFINITELY_NOT_SENT_CODES = Object.freeze(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL']);

function invalid(reason) {
  return { ok: false, reason };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInt(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

/** 请求校验：多余键、类型、范围、事件 id 形状，任何异常一律拒绝（不做宽容修正）。 */
export function parseOwnerNoticeRequest(raw, options = {}) {
  if (!isPlainObject(raw)) return invalid('request-not-object');
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8'); } catch { return invalid('request-unserializable'); }
  if (bytes > OWNER_NOTICE_MAX_REQUEST_BYTES) return invalid('request-too-large');
  for (const key of Object.keys(raw)) {
    if (!REQUEST_KEYS.includes(key)) return invalid(`unknown-key:${key}`);
  }
  if (raw.schemaVersion !== OWNER_NOTICE_SCHEMA_VERSION) return invalid('schema-version-unsupported');
  if (typeof raw.eventId !== 'string' || !EVENT_ID_RE.test(raw.eventId) || raw.eventId.length > OWNER_NOTICE_EVENT_ID_MAX) {
    return invalid('invalid-event-id');
  }
  if (typeof raw.kind !== 'string' || !KIND_SET.has(raw.kind)) return invalid('invalid-kind');
  if (!isSafeInt(raw.missingCount, 1, OWNER_NOTICE_INT_MAX)) return invalid('invalid-missing-count');
  if (!isSafeInt(raw.consecutiveMisses, 1, OWNER_NOTICE_INT_MAX)) return invalid('invalid-consecutive-misses');
  if (!Number.isSafeInteger(raw.lastSeenAt) || raw.lastSeenAt <= 0) return invalid('invalid-last-seen-at');
  if (!Number.isSafeInteger(raw.createdAt) || raw.createdAt <= 0) return invalid('invalid-created-at');
  // 时间窗口只在调用方给出 now 时校验（submit 一定会给）；单独解析时保持纯结构校验。
  const now = options?.now;
  if (Number.isSafeInteger(now)) {
    const earliest = now - OWNER_NOTICE_REQUEST_MAX_AGE_MS;
    const latest = now + OWNER_NOTICE_REQUEST_MAX_FUTURE_MS;
    if (raw.createdAt < earliest || raw.createdAt > latest) return invalid('invalid-created-at-window');
    if (raw.lastSeenAt < earliest || raw.lastSeenAt > latest) return invalid('invalid-last-seen-at-window');
  }
  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: OWNER_NOTICE_SCHEMA_VERSION,
      eventId: raw.eventId,
      kind: raw.kind,
      missingCount: raw.missingCount,
      consecutiveMisses: raw.consecutiveMisses,
      lastSeenAt: raw.lastSeenAt,
      createdAt: raw.createdAt,
    }),
  };
}

/** 固定模板：只允许整数与北京时间的 HH:MM，绝不拼接调用方提供的字符串。 */
export function renderOwnerNotice(event, { timeZoneOffsetMinutes = 480 } = {}) {
  const clock = typeof event?.lastSeenAt === 'number' && Number.isFinite(event.lastSeenAt) ? event.lastSeenAt : null;
  let hhmm = '未知时间';
  if (clock !== null) {
    try {
      const shifted = new Date(clock + timeZoneOffsetMinutes * 60_000);
      const ms = shifted.getTime();
      // 超出 Date 可表示范围时 toISOString() 会抛 RangeError：宁可写「未知时间」也不能让提示永远发不出去。
      if (Number.isFinite(ms)) hhmm = shifted.toISOString().slice(11, 16);
    } catch {
      hhmm = '未知时间';
    }
  }
  if (event?.kind === 'tool-surface-recovered') {
    return `【工具自愈】小黑盒工具已恢复可见（此前连续 ${event.consecutiveMisses} 次检查缺失，最近一次缺失在北京时间 ${hhmm}）。本提示由本地插件触发，不是平台报警。`;
  }
  return `【工具自愈】小黑盒工具连续 ${event.consecutiveMisses} 次检查不可见（缺失 ${event.missingCount} 个，最后可见于北京时间 ${hhmm}）。本提示由本地插件触发，不是平台报警；若持续出现请检查 XhhMCP 服务与 DSH 插件是否加载。`;
}

function freshState() {
  return { schemaVersion: OWNER_NOTICE_SCHEMA_VERSION, events: [] };
}

/** 校验磁盘状态；任何不符一律 `state-invalid`（绝不「尽量修复」）。 */
export function parseOwnerNoticeState(raw) {
  if (!isPlainObject(raw)) return invalid('state-not-object');
  if (raw.schemaVersion !== OWNER_NOTICE_SCHEMA_VERSION) return invalid('state-schema-unsupported');
  if (!Array.isArray(raw.events)) return invalid('state-events-not-array');
  const events = [];
  for (const item of raw.events) {
    if (!isPlainObject(item)) return invalid('state-event-not-object');
    if (typeof item.eventId !== 'string' || !EVENT_ID_RE.test(item.eventId)) return invalid('state-event-id-invalid');
    if (typeof item.kind !== 'string' || !KIND_SET.has(item.kind)) return invalid('state-kind-invalid');
    if (!isSafeInt(item.createdAt, 1, Number.MAX_SAFE_INTEGER)) return invalid('state-created-at-invalid');
    if (!Array.isArray(item.attempts)) return invalid('state-attempts-not-array');
    const attempts = [];
    for (const attempt of item.attempts) {
      if (!isPlainObject(attempt)) return invalid('state-attempt-not-object');
      if (typeof attempt.attemptId !== 'string' || attempt.attemptId.length > 128) return invalid('state-attempt-id-invalid');
      if (!isSafeInt(attempt.startedAt, 1, Number.MAX_SAFE_INTEGER)) return invalid('state-attempt-started-invalid');
      if (attempt.finishedAt !== null && !isSafeInt(attempt.finishedAt, 1, Number.MAX_SAFE_INTEGER)) return invalid('state-attempt-finished-invalid');
      if (attempt.outcome !== null && !['delivered', 'unknown', 'failed'].includes(attempt.outcome)) return invalid('state-attempt-outcome-invalid');
      if (attempt.code !== null && (typeof attempt.code !== 'string' || attempt.code.length > 64)) return invalid('state-attempt-code-invalid');
      attempts.push({
        attemptId: attempt.attemptId,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt ?? null,
        outcome: attempt.outcome ?? null,
        code: attempt.code ?? null,
      });
    }
    events.push({
      eventId: item.eventId,
      kind: item.kind,
      missingCount: isSafeInt(item.missingCount, 1, OWNER_NOTICE_INT_MAX) ? item.missingCount : 1,
      consecutiveMisses: isSafeInt(item.consecutiveMisses, 1, OWNER_NOTICE_INT_MAX) ? item.consecutiveMisses : 1,
      lastSeenAt: isSafeInt(item.lastSeenAt, 1, Number.MAX_SAFE_INTEGER) ? item.lastSeenAt : item.createdAt,
      createdAt: item.createdAt,
      deliveredAt: isSafeInt(item.deliveredAt, 1, Number.MAX_SAFE_INTEGER) ? item.deliveredAt : null,
      closedAt: isSafeInt(item.closedAt, 1, Number.MAX_SAFE_INTEGER) ? item.closedAt : null,
      attempts,
    });
  }
  return { ok: true, value: { schemaVersion: OWNER_NOTICE_SCHEMA_VERSION, events } };
}

function lastAttempt(event) {
  return event.attempts.length === 0 ? null : event.attempts[event.attempts.length - 1];
}

/** 一个事件「下一次可以尝试」的时间；无尝试记录 ⇒ 立即。 */
export function nextAttemptAt(event, now = null) {
  const last = lastAttempt(event);
  if (last === null) return event.createdAt;
  const base = last.finishedAt ?? last.startedAt;
  // 时钟回拨 / 时间戳被写成未来 ⇒ fail-closed：按「记录时间 + 间隔」计算到期时刻。
  // 绝不因为 now 追不上 base 就把重试提前——那会让一次回拨绕开 15 分钟节流。
  void now;
  return base + OWNER_NOTICE_RETRY_MIN_MS;
}

export function createOwnerNoticeOutbox(options = {}) {
  const filePath = typeof options.filePath === 'string' ? options.filePath : '';
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const fs = options.fs ?? fsDefault;
  const send = typeof options.send === 'function' ? options.send : null;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const makeId = typeof options.makeId === 'function' ? options.makeId : () => crypto.randomUUID();

  let state = null;
  // 可观察性（Codex 增量要求）：容量拒绝与合并刷新都必须能被读到，
  // 否则「上限导致已有事件刷新不了」这类退化只能靠猜。
  let mergedRefreshes = 0;
  let capacityRejections = 0;
  let draining = null;

  function makeAttemptId() {
    const id = makeId();
    if (typeof id !== 'string' || id === '' || id.length > 128) {
      // 生成器异常时退回随机 uuid：尝试身份绝不能用可推断的确定值（否则跨实例会撞号）。
      return crypto.randomUUID();
    }
    return id;
  }

  const lockPath = filePath === '' ? '' : `${filePath}.lock`;
  const lockSupported = lockPath !== '' && typeof fs.open === 'function';
  const instanceId = makeAttemptId();

  /**
   * 单实例锁：只做 `open('wx')` 独占创建，**不做任何自动接管**。
   * 理由（Codex 2026-10-30 指出）：`readLockHolder → isPidAlive → unlink → open` 不是原子事务，
   * 两个进程可能同时读到同一个死 pid：A 删旧锁并建新锁后，B 的 unlink 会删掉 A 的新锁，
   * 随后 B 也能创建成功 ⇒ 双持有、并发发送。日常路径无法证明原子所有权，就一律 fail-closed，
   * 把恢复交给「先停写进程、再离线删锁」这个流程，而不是在运行期猜。
   */
  async function readLockHolder() {
    try {
      const text = await fs.readFile(lockPath, 'utf8');
      if (text.trim() === '') return { pid: null, instanceId: null, empty: true };
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object') return null;
      if (!Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) return null;
      return { pid: parsed.pid, instanceId: typeof parsed.instanceId === 'string' ? parsed.instanceId : null };
    } catch {
      return null;
    }
  }

  let lockHeld = false;
  /**
   * 关闭闸门：dispose() 同步置位，此后不再接受任何会拿锁的操作。
   * dispose() 自身排进 withMutex，因此会等在途 submit/close/drain（含 send）结束 ——
   * 若 send 无界挂起，dispose 也就永远不 resolve，锁一直被持有（fail-closed，宁可不放行第二个实例）。
   */
  let disposed = false;
  let disposing = null;

  async function acquireLock() {
    if (filePath === '') return { ok: true };
    if (lockHeld) return { ok: true };
    if (!lockSupported) return { ok: false, reason: 'lock-unsupported' };
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify({ instanceId, pid: process.pid, at: clock() })}
`, 'utf8');
      } finally {
        await handle.close();
      }
      lockHeld = true;
      return { ok: true };
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: false, reason: 'state-dir-missing' };
      if (error?.code !== 'EEXIST') return { ok: false, reason: 'lock-failed' };
      const holder = await readLockHolder();
      if (holder === null) return { ok: false, reason: 'lock-unreadable' };
      if (holder.empty === true) return { ok: false, reason: 'lock-empty-needs-recovery' };
      if (holder.pid === process.pid && holder.instanceId === instanceId) {
        // 上一次释放失败留下的「本实例自己的锁」：重新持有，不算抢别人的锁。
        lockHeld = true;
        return { ok: true };
      }
      return { ok: false, reason: 'owner-held', holderPid: holder.pid, holderInstanceId: holder.instanceId };
    }
  }

  /**
   * 释放本实例持有的锁：只删除内容仍属于本实例的锁文件。
   * 返回是否「确认已无锁」——false 表示锁文件仍在（内容属于他人或释放失败），
   * 调用方据此如实上报，不把 ok 当成"锁已清理"。
   */
  async function releaseLock() {
    if (!lockHeld) return (await readLockHolderUnsafe()) === null;
    lockHeld = false;
    try {
      const holder = await readLockHolder();
      if (holder !== null && holder.instanceId === instanceId) await fs.unlink(lockPath);
    } catch {
      // 释放失败不影响正确性：锁仍在，后续操作会 fail-closed 为 owner-held（不自动接管）。
    }
    return (await readLockHolderUnsafe()) === null;
  }

  /** 只读探测锁文件是否存在且可解析（不上报、不改状态）。 */
  async function readLockHolderUnsafe() {
    try {
      const text = await fs.readFile(lockPath, 'utf8');
      if (text.trim() === '') return { instanceId: null, pid: null };
      return JSON.parse(text);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      return { instanceId: null, pid: null };
    }
  }

  // —— 进程内串行化：submit/close/drain 的状态读写段共享一条 Promise 链，避免内存态互相覆盖 ——
  let opChain = Promise.resolve();
  function withMutex(fn) {
    const run = opChain.then(fn, fn);
    opChain = run.then(() => {}, () => {});
    return run;
  }

  /** 滚动裁剪：只保留最近 N 条已结算尝试 + 全部未结算尝试（绝不因为次数多而永久停发）。 */
  function trimAttempts(event) {
    if (event.attempts.length <= OWNER_NOTICE_MAX_ATTEMPTS_KEPT) return false;
    const settled = event.attempts.filter((attempt) => attempt.finishedAt !== null);
    const unsettled = event.attempts.filter((attempt) => attempt.finishedAt === null);
    const kept = settled.slice(Math.max(0, settled.length - OWNER_NOTICE_MAX_ATTEMPTS_KEPT));
    event.attempts = [...kept, ...unsettled].sort((a, b) => a.startedAt - b.startedAt);
    return true;
  }

  function normalizeErrorCode(error) {
    if (typeof error?.code === 'string' && error.code !== '') return error.code.slice(0, 64);
    const text = String(error?.message ?? '');
    return text === '' ? 'send-failed' : text.slice(0, 64);
  }

  /** 发送结果归一：只有收到明确回执才算 delivered；超时与传输歧义一律 unknown。 */
  function classifySendResult(raw) {
    if (isPlainObject(raw) && raw.outcome === 'delivered') {
      return { outcome: 'delivered', code: null };
    }
    if (isPlainObject(raw) && raw.outcome === 'failed') {
      const code = typeof raw.code === 'string' && raw.code !== '' ? raw.code.slice(0, 64) : 'send-failed';
      return { outcome: 'failed', code };
    }
    if (isPlainObject(raw) && raw.outcome === 'unknown') {
      return { outcome: 'unknown', code: typeof raw.code === 'string' && raw.code !== '' ? raw.code.slice(0, 64) : 'unknown' };
    }
    return { outcome: 'unknown', code: 'invalid-send-result' };
  }

  function classifySendError(error) {
    const code = normalizeErrorCode(error);
    const outcome = DEFINITELY_NOT_SENT_CODES.includes(code) ? 'failed' : 'unknown';
    return { outcome, code };
  }

  async function persist(next) {
    if (filePath === '') return { ok: false, reason: 'no-file-path' };
    const dir = path.dirname(filePath);
    try {
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${filePath}.${process.pid}.${clock()}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, filePath);
      return { ok: true };
    } catch (error) {
      log('owner-notice: 状态写盘失败', normalizeErrorCode(error));
      return { ok: false, reason: 'persist-failed' };
    }
  }

  async function load() {
    try {
      const text = await fs.readFile(filePath, 'utf8');
      let parsed;
      try { parsed = JSON.parse(text); } catch { log('owner-notice: 状态文件不是合法 JSON'); return { ok: false, reason: 'state-corrupt' }; }
      const validated = parseOwnerNoticeState(parsed);
      if (validated.ok !== true) {
        log('owner-notice: 状态文件不合法', validated.reason);
        return { ok: false, reason: validated.reason };
      }
      state = validated.value;
      return { ok: true };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        state = freshState();
        return { ok: true, created: true };
      }
      log('owner-notice: 状态读取失败', normalizeErrorCode(error));
      return { ok: false, reason: 'read-failed' };
    }
  }

  /** 崩溃恢复：超过 stale 仍未结算的 attempt ⇒ unknown/attempt-interrupted（可能已发出）。 */
  function settleInterruptedAttempts(now) {
    let changed = false;
    for (const event of state.events) {
      const last = lastAttempt(event);
      if (last !== null && last.finishedAt === null) {
        const elapsed = now - last.startedAt;
        const rolledBack = elapsed < 0;
        if (rolledBack || elapsed >= OWNER_NOTICE_ATTEMPT_STALE_MS) {
          last.finishedAt = now;
          last.outcome = 'unknown';
          last.code = rolledBack ? 'clock-rollback' : 'attempt-interrupted';
          changed = true;
          log(
            rolledBack
              ? 'owner-notice: 检测到时钟回拨，未结算的尝试按 unknown 处理（可能已发出）'
              : 'owner-notice: 上次发送尝试未结算，按 unknown 处理（可能已发出）',
            event.eventId,
          );
        }
      }
    }
    return changed;
  }

  /** 纯函数版：给定事件数组，返回滚动裁剪后的新数组（不修改入参）。 */
  function trimSettledEventsIn(events) {
    const settled = events.filter((event) => event.deliveredAt !== null || event.closedAt !== null);
    if (settled.length <= OWNER_NOTICE_MAX_SETTLED_EVENTS) return events;
    const sortKey = (event) => event.deliveredAt ?? event.closedAt ?? 0;
    settled.sort((a, b) => sortKey(a) - sortKey(b));
    const drop = new Set(settled.slice(0, settled.length - OWNER_NOTICE_MAX_SETTLED_EVENTS).map((event) => event.eventId));
    return events.filter((event) => !drop.has(event.eventId));
  }

  function openEvents() {
    return state.events.filter((event) => event.deliveredAt === null && event.closedAt === null);
  }

  async function submit(raw) {
    if (disposed) return { ok: false, reason: 'disposed' };
    const now = clock();
    if (!Number.isSafeInteger(now)) return { ok: false, reason: 'clock-invalid' };
    const parsed = parseOwnerNoticeRequest(raw, { now });
    if (parsed.ok !== true) return { ok: false, reason: parsed.reason };
    return withMutex(async () => {
      const lock = await acquireLock();
      if (lock.ok !== true) {
        // 与 drain 保持同一形状：把"谁持有锁"回传给调用方，便于诊断为 fail-closed 而非静默丢事件。
        return { ok: false, reason: lock.reason, holderPid: lock.holderPid ?? null, holderInstanceId: lock.holderInstanceId ?? null };
      }
      try {
        // 拿锁后无条件重读：磁盘才是唯一真相，内存可能来自上一次操作（跨进程交替时尤其关键）。
        const loaded = await load();
        if (loaded.ok !== true) return { ok: false, reason: loaded.reason };
      const request = parsed.value;
      if (state.events.some((event) => event.eventId === request.eventId)) {
        // 同一事件重复投递：不新增事件、不清除已有尝试记录（幂等接收，发送仍按状态机重试）。
        return { ok: true, duplicate: true, eventId: request.eventId };
      }
      // 同类未结事件只保留一个：插件每分钟都可能重复投递「同一个缺失状态」，
      // 若每次都新建事件，发送次数会随分钟线性增长（复审实测 45 分钟 6 条、125 分钟 13 条）。
      // 合并而不是丢弃：missingCount/lastSeenAt 取最新，attempts 历史保留（节流靠它）。
      // 只对「缺失提醒」去重；恢复/取消走 close 路径，不参与合并。
      // 顺序很重要：**先合并、再判容量**。反过来的话，未结事件一旦达到上限，
      // 已有事件就再也刷新不了（missingCount/lastSeenAt 停在旧值），而上限本身
      // 又被合并语义压得几乎不可能达到 —— 等于用一条不可达的闸门换掉一条能用的刷新。
      const sameKindOpen = request.kind === 'tool-surface-missing'
        ? openEvents().find((event) => event.kind === 'tool-surface-missing')
        : undefined;
      if (sameKindOpen !== undefined) {
        const merged = {
          ...sameKindOpen,
          missingCount: request.missingCount,
          consecutiveMisses: request.consecutiveMisses,
          lastSeenAt: request.lastSeenAt,
        };
        const nextMerged = {
          schemaVersion: OWNER_NOTICE_SCHEMA_VERSION,
          events: state.events.map((event) => (event.eventId === sameKindOpen.eventId ? merged : event)),
        };
        const mergedSaved = await persist(nextMerged);
        if (mergedSaved.ok !== true) return { ok: false, reason: mergedSaved.reason };
        state = nextMerged;
        mergedRefreshes += 1;
        return { ok: true, duplicate: true, merged: true, eventId: sameKindOpen.eventId };
      }

      // 走到这里说明这是一条**无法合并**的新事件：此时才用容量上限兜底。
      if (openEvents().length >= OWNER_NOTICE_MAX_OPEN_EVENTS) {
        capacityRejections += 1;
        log('owner-notice: 未结事件过多，拒绝新事件', request.eventId);
        return { ok: false, reason: 'too-many-open-events' };
      }
      const event = {
        eventId: request.eventId,
        kind: request.kind,
        missingCount: request.missingCount,
        consecutiveMisses: request.consecutiveMisses,
        lastSeenAt: request.lastSeenAt,
        createdAt: request.createdAt,
        deliveredAt: null,
        closedAt: null,
        attempts: [],
      };
      // persist-first：先落盘成功，才把新状态提交到内存；写失败时内存态保持不变，
      // 因此不会出现「内存说 duplicate、磁盘其实没有」的假幂等。
      const withNew = [...state.events, event];
      const next = { schemaVersion: OWNER_NOTICE_SCHEMA_VERSION, events: trimSettledEventsIn(withNew) };
      const saved = await persist(next);
      if (saved.ok !== true) return { ok: false, reason: saved.reason };
      state = next;
      return { ok: true, duplicate: false, eventId: request.eventId };
      } finally {
        await releaseLock();
      }
    });
  }

  function attemptsInWindow(now, windowMs) {
    let count = 0;
    for (const event of state.events) {
      for (const attempt of event.attempts) {
        if (now - attempt.startedAt < windowMs) count += 1;
      }
    }
    return count;
  }

  async function runDrainOnce() {
    if (send === null) return { ok: false, reason: 'send-not-configured' };
    const lock = await acquireLock();
    if (lock.ok !== true) return { ok: false, reason: lock.reason, blocked: false, holderPid: lock.holderPid ?? null, holderInstanceId: lock.holderInstanceId ?? null, attempted: 0, delivered: 0, unknown: 0, failed: 0, skipped: 0, attemptedIds: [] };
    try {
      return await runDrainBody();
    } finally {
      await releaseLock();
    }
  }

  const EMPTY_REPORT = { attempted: 0, delivered: 0, unknown: 0, failed: 0, skipped: 0, attemptedIds: [] };

  async function runDrainBody() {
    const now = clock();
    const loaded = await load();
    if (loaded.ok !== true) return { ok: false, reason: loaded.reason, blocked: true, ...EMPTY_REPORT };
    if (loaded.created === true) {
      const saved = await persist(state);
      if (saved.ok !== true) return { ok: false, reason: saved.reason, blocked: true, ...EMPTY_REPORT };
    }
    if (settleInterruptedAttempts(now)) {
      const saved = await persist(state);
      if (saved.ok !== true) return { ok: false, reason: saved.reason, blocked: true, ...EMPTY_REPORT };
    }

    const report = { ok: true, attempted: 0, delivered: 0, unknown: 0, failed: 0, skipped: 0, attemptedIds: [] };
    for (const event of state.events) {
      if (event.deliveredAt !== null || event.closedAt !== null) continue;
      const last = lastAttempt(event);
      if (last !== null && last.finishedAt === null) {
        // 仍在进行中（未超 stale）：本轮跳过，避免并发重复发送。
        report.skipped += 1;
        continue;
      }
      const lastBase = last === null ? null : (last.finishedAt ?? last.startedAt);
      if (lastBase !== null && Number.isSafeInteger(lastBase) && lastBase > now) {
        // 记录时间在未来（时钟回拨/时间戳污染）：fail-closed 跳过，并单独计数以便排障。
        report.skewed = (report.skewed ?? 0) + 1;
        report.skipped += 1;
        continue;
      }
      if (now < nextAttemptAt(event, now)) {
        report.skipped += 1;
        continue;
      }
      if (attemptsInWindow(now, 60 * 60 * 1000) >= OWNER_NOTICE_MAX_ATTEMPTS_PER_HOUR) {
        report.rateLimited = true;
        report.skipped += 1;
        continue;
      }
      // write-ahead：先把「尝试已开始」落盘，再发送。
      const attempt = {
        attemptId: makeAttemptId(),
        startedAt: now,
        finishedAt: null,
        outcome: null,
        code: null,
      };
      event.attempts.push(attempt);
      const savedBeforeSend = await persist(state);
      if (savedBeforeSend.ok !== true) {
        // 写不下去就不发：否则会产生「发过但没记录」的消息。
        event.attempts.pop();
        return { ok: false, reason: savedBeforeSend.reason, blocked: true, ...EMPTY_REPORT };
      }

      let result;
      try {
        result = classifySendResult(await send(renderOwnerNotice(event)));
      } catch (error) {
        result = classifySendError(error);
      }
      attempt.finishedAt = clock();
      attempt.outcome = result.outcome;
      attempt.code = result.code;
      if (result.outcome === 'delivered') event.deliveredAt = attempt.finishedAt;
      report.attempted += 1;
      report.attemptedIds.push(attempt.attemptId);
      if (result.outcome === 'delivered') report.delivered += 1;
      else if (result.outcome === 'failed') report.failed += 1;
      else report.unknown += 1;

      trimAttempts(event);
      const savedAfterSend = await persist(state);
      if (savedAfterSend.ok !== true) {
        log('owner-notice: 发送结果落盘失败（下次可能重复）', attempt.attemptId);
        // 顺序是刻意的：report.ok 可能为 true（本次确实送达），但落盘失败必须让整轮 drain 失败。
        return { ...report, ok: false, reason: savedAfterSend.reason, blocked: true };
      }
    }
    return report;
  }

  /** 单飞 drain：并发调用复用同一个在飞 Promise。 */
  function drain() {
    if (disposed) return Promise.resolve({ ok: false, reason: 'disposed' });
    if (draining !== null) return draining;
    // 与 submit/close 串行：避免一次 drain 的 send（可能很慢）与写入互相覆盖内存态。
    draining = withMutex(runDrainOnce).finally(() => { draining = null; });
    return draining;
  }

  async function close(eventId, options2 = {}) {
    if (disposed) return { ok: false, reason: 'disposed' };
    return withMutex(async () => {
      const lock = await acquireLock();
      if (lock.ok !== true) return { ok: false, reason: lock.reason };
      try {
        const loaded = await load();
        if (loaded.ok !== true) return { ok: false, reason: loaded.reason };
      const event = state.events.find((item) => item.eventId === eventId);
      if (event === undefined) return { ok: false, reason: 'event-not-found' };
      if (event.closedAt !== null) return { ok: true, alreadyClosed: true };
      const closedAt = Number.isSafeInteger(options2.at) ? options2.at : clock();
      const next = {
        schemaVersion: OWNER_NOTICE_SCHEMA_VERSION,
        events: state.events.map((item) => (item === event ? { ...item, closedAt } : item)),
      };
      const saved = await persist(next);
      if (saved.ok !== true) return { ok: false, reason: saved.reason };
      state = next;
      return { ok: true, closedAt };
      } finally {
        await releaseLock();
      }
    });
  }

  async function snapshot() {
    if (state === null) {
      const loaded = await load();
      if (loaded.ok !== true) return { ok: false, reason: loaded.reason };
    }
    return {
      ok: true,
      open: openEvents().length,
      mergedRefreshes,
      capacityRejections,
      events: state.events.map((event) => ({
        eventId: event.eventId,
        kind: event.kind,
        createdAt: event.createdAt,
        deliveredAt: event.deliveredAt,
        closedAt: event.closedAt,
        attempts: event.attempts.length,
        lastOutcome: lastAttempt(event)?.outcome ?? null,
        lastCode: lastAttempt(event)?.code ?? null,
        nextAttemptAt: event.deliveredAt === null && event.closedAt === null ? nextAttemptAt(event) : null,
      })),
    };
  }

  return {
    filePath,
    load,
    submit,
    drain,
    close,
    snapshot,
    /**
     * 优雅关闭：进入同一条串行链，等在途 submit/close/drain（含 send）结束后才释放锁。
     * - 关闭后 submit/close/drain 一律返回 `disposed`，不再拿锁；
     * - 在途 send 无界挂起时本 Promise 也不 resolve，锁保持被持有（fail-closed）；
     * - **关闭 ≠ 取消**：dispose 之前已被受理的 drain 仍会把那一批发完；
     * - 返回 `lockStillHeld`：`true` 表示锁文件仍存在（属于他人或释放失败），需离线人工处理。
     */
    dispose: () => {
      if (disposed) return disposing ?? Promise.resolve({ ok: true });
      disposed = true;
      disposing = withMutex(async () => {
        const cleared = await releaseLock();
        return cleared ? { ok: true } : { ok: true, lockStillHeld: true };
      });
      return disposing;
    },
    /** 仅供测试：内部纯函数，不改变锁与状态语义。 */
    _internal: { settleInterruptedAttempts, attemptsInWindow, trimAttempts },
  };
}