/**
 * A-2：小黑盒降级载体（**纯状态模块，未接线**）。
 *
 * 用途：当身份守卫（`xiaoheihe-identity-guard`）不可用、身份来源不明、或通知重试耗尽时，
 * 由一个**独立、可持久化、重启不丢失**的降级状态记录「小黑盒现在最多能做什么」：
 *
 *   normal     — 放行（写与全量操作都允许）
 *   read-only  — 仅允许只读（写操作禁止）
 *   paused     — 全部暂停（写与读都禁止）
 *
 * 用户安全规则（2026-10-28，2026-10-29 加固）：
 *   ③ 异常发生前就存在的暂停不得被「恢复」解除；只有**仅由本次异常引入**的限制才能自动解除。
 *   ⑤ 通知发送失败或结果未知不得当作成功 → **第一次** failed/unknown 即升级 `paused`
 *      （trigger 分别记 `notify-failed` / `notify-unknown`，attempts 继续累加供补报审计）；
 *      进入 `paused` 后 `identityOk` 不再自动解除，只能由控制台（专栏密码 + 二次确认）手动恢复。
 *      **不得因为随后一次通知 delivered 就自动解除已经进入的全停状态。**
 *
 * 关键不变量（测试逐条锁定）：
 *  · 落盘成功才算成功：未知/失败不得冒充成功，写盘失败不改内存（拒绝伪造「已降级」事实）。
 *  · rank 只拒下降（normal < read-only < paused）：`enter` 不能把限制放宽；rank 相等允许（补记事实字段）。
 *  · 状态文件损坏 / 非法 / 版本不支持 / 读取失败 → fail-closed 到 `paused`；重启后仍是 paused，
 *    绝不「读坏了就当正常」。
 *  · `.tmp` 残留（崩在 rename 之前）不影响 load：只读正式文件，忽略 `.tmp`。
 *  · 自动解除**只允许从 `read-only` 回 `normal`**：`recordIdentityOk(true)` 且通知已 `delivered`
 *    且当前 trigger 属于「身份类异常」三种之一且 `level === 'read-only'`；
 *    `paused` 一律只能走 `applyManualRecovery`（用户规则：delivered 不得抬回已经进入的全停）。
 *  · 手动恢复必须 `confirmed === true` 且 `operator` 为非空字符串；否则给明确 reason。
 *
 * 明确不做：不 import bridge/hook/guard、不读 config、不联网、不硬编码状态路径、不加跨进程锁
 * （假定同一 filePath 单实例使用，调用方保证）。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

export const XHH_DEGRADE_SCHEMA_VERSION = 1;
export const XHH_DEGRADE_LEVELS = Object.freeze(['normal', 'read-only', 'paused']);
export const XHH_DEGRADE_RANK = Object.freeze({ normal: 0, 'read-only': 1, paused: 2 });
export const XHH_DEGRADE_TRIGGERS = Object.freeze([
  'identity-guard-unavailable',
  'identity-guard-load-failed',
  'identity-mode-legacy',
  // 通知失败/未知：**第一次**即全停；两者分开记录，便于 bridge 路由层区分「未送达 vs 未知结果」。
  'notify-failed',
  'notify-unknown',
  'manual',
]);

/** 通知状态：与身份守卫保持同一枚举，供接线侧直接映射。 */
export const XHH_DEGRADE_NOTIFY_STATUSES = Object.freeze(['delivered', 'failed', 'unknown']);
/** 自动解除只认「身份类异常」；notify-failed / notify-unknown / manual 不得自动解除（规则③⑤）。 */
const AUTO_LIFT_TRIGGERS = new Set([
  'identity-guard-unavailable',
  'identity-guard-load-failed',
  'identity-mode-legacy',
]);
const MAX_TEXT_LENGTH = 128;
const MAX_REASON_LENGTH = 64;

function emptyNotify() {
  return { status: null, attempts: 0, operationId: null, lastCode: null };
}

function emptyState() {
  return {
    schemaVersion: XHH_DEGRADE_SCHEMA_VERSION,
    level: 'normal',
    trigger: null,
    since: null,
    updatedAt: null,
    identityOk: null,
    notify: emptyNotify(),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validText(value, max = MAX_TEXT_LENGTH) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validOptionalText(value, max = MAX_TEXT_LENGTH) {
  return value === null || value === undefined || validText(value, max);
}

function validNotify(notify) {
  if (notify === null || typeof notify !== 'object' || Array.isArray(notify)) return false;
  const statusOk = notify.status === null || XHH_DEGRADE_NOTIFY_STATUSES.includes(notify.status);
  const attemptsOk = Number.isInteger(notify.attempts) && notify.attempts >= 0;
  return statusOk && attemptsOk && validOptionalText(notify.operationId) && validOptionalText(notify.lastCode);
}

/** 校验磁盘上的状态是否可被信任（不可信 ⇒ fail-closed，绝不猜成 normal）。 */
function validState(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  if (candidate.schemaVersion !== XHH_DEGRADE_SCHEMA_VERSION) return false;
  if (!XHH_DEGRADE_LEVELS.includes(candidate.level)) return false;
  const triggerOk = candidate.trigger === null || XHH_DEGRADE_TRIGGERS.includes(candidate.trigger);
  if (!triggerOk) return false;
  if (!isFiniteNumber(candidate.since) && candidate.since !== null) return false;
  if (!isFiniteNumber(candidate.updatedAt) && candidate.updatedAt !== null) return false;
  if (candidate.identityOk !== null && typeof candidate.identityOk !== 'boolean') return false;
  return validNotify(candidate.notify);
}

function stablePayload(state) {
  // 固定键序 + 2 空格 + LF：磁盘文件可被逐字节断言，也方便人肉排查。
  return {
    schemaVersion: XHH_DEGRADE_SCHEMA_VERSION,
    level: state.level,
    trigger: state.trigger,
    since: state.since,
    updatedAt: state.updatedAt,
    identityOk: state.identityOk,
    notify: {
      status: state.notify.status,
      attempts: state.notify.attempts,
      operationId: state.notify.operationId,
      lastCode: state.notify.lastCode,
    },
  };
}

/**
 * @param {{
 *   filePath: string,
 *   clock?: () => number,
 *   notify?: null | ((event: {level: string, trigger: string|null, reason: string|null, since: number|null}) => unknown),
 *   logger?: null | ((level: 'warn'|'info', code: string, detail?: unknown) => unknown),
 * }} options
 */
export function createXiaoheiheDegrade({ filePath, clock = Date.now, notify = null, logger = null } = {}) {
  if (typeof filePath !== 'string' || filePath.trim() === '') throw new TypeError('filePath 必须是非空字符串');
  if (typeof clock !== 'function') throw new TypeError('clock 必须是函数');
  if (notify !== null && typeof notify !== 'function') throw new TypeError('notify 必须是函数或 null');
  if (logger !== null && typeof logger !== 'function') throw new TypeError('logger 必须是函数或 null');

  let state = emptyState();
  let failClosedReason = null;

  function now() {
    try {
      const value = clock();
      return isFiniteNumber(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  }

  function log(level, code, detail) {
    if (logger === null) return;
    try {
      logger(level, code, detail);
    } catch {
      /* 日志失败不得影响状态机 */
    }
  }

  function view() {
    return {
      ok: true,
      level: state.level,
      trigger: state.trigger,
      since: state.since,
      identityOk: state.identityOk,
      notify: clone(state.notify),
    };
  }

  function failClosed(reason) {
    // 坏文件不是「没有状态」：进入 paused 并在内存里保留原因（重启会再次 fail-closed）。
    state = emptyState();
    state.level = 'paused';
    state.since = now();
    state.updatedAt = state.since;
    failClosedReason = reason;
    log('warn', `degrade-fail-closed-${reason}`);
    return { ok: true, failClosed: true, level: 'paused', reason };
  }

  /** 原子落盘：`<file>.tmp` + rename；成功才把内存切到 next；失败不改内存。 */
  async function persist(next) {
    const target = filePath;
    const tmp = `${target}.tmp`;
    const payload = stablePayload(next);
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(tmp, target);
      state = next;
      failClosedReason = null;
      return { ok: true };
    } catch (error) {
      try {
        await fsp.unlink(tmp);
      } catch {
        /* 清理失败不覆盖原始语义 */
      }
      log('warn', 'degrade-persist-failed', error && error.code ? error.code : String(error));
      return { ok: false, reason: 'degrade-persist-failed' };
    }
  }

  function emitNotify(next, reason) {
    if (notify === null || next.level === 'normal') return;
    try {
      const result = notify({ level: next.level, trigger: next.trigger, reason, since: next.since });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      /* 通知失败由调用方用 markNotify 记录，不能影响状态机 */
    }
  }

  async function load() {
    let raw;
    try {
      raw = await fsp.readFile(filePath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        state = emptyState();
        state.updatedAt = now();
        failClosedReason = null;
        return view();
      }
      return failClosed('load-failed');
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return failClosed('state-corrupt');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return failClosed('state-invalid');
    if (parsed.schemaVersion !== XHH_DEGRADE_SCHEMA_VERSION) return failClosed('schema-version-unsupported');
    if (!validState(parsed)) return failClosed('state-invalid');
    state = {
      schemaVersion: XHH_DEGRADE_SCHEMA_VERSION,
      level: parsed.level,
      trigger: parsed.trigger,
      since: parsed.since,
      updatedAt: parsed.updatedAt,
      identityOk: parsed.identityOk,
      notify: {
        status: parsed.notify.status,
        attempts: parsed.notify.attempts,
        operationId: parsed.notify.operationId,
        lastCode: parsed.notify.lastCode,
      },
    };
    failClosedReason = null;
    return view();
  }

  function snapshot() {
    return {
      level: state.level,
      trigger: state.trigger,
      since: state.since,
      identityOk: state.identityOk,
      notify: clone(state.notify),
      blockWrite: state.level !== 'normal',
      blockAll: state.level === 'paused',
      failClosed: failClosedReason !== null,
      reason: failClosedReason,
    };
  }

  async function enter({ level, trigger = null, reason = null, at = null } = {}) {
    if (!XHH_DEGRADE_LEVELS.includes(level)) return { ok: false, reason: 'invalid-argument' };
    if (trigger !== null && !XHH_DEGRADE_TRIGGERS.includes(trigger)) return { ok: false, reason: 'invalid-argument' };
    if (XHH_DEGRADE_RANK[level] < XHH_DEGRADE_RANK[state.level]) {
      // rank 只拒下降：限制可以升级、可以补记，绝不能被 enter 放宽（放宽只走手动恢复）。
      return { ok: false, reason: 'degrade-rank-downgrade-refused' };
    }
    const changed = level !== state.level;
    const next = clone(state);
    next.level = level;
    next.trigger = level === 'normal' ? null : trigger;
    next.since = changed ? (isFiniteNumber(at) ? at : now()) : state.since;
    next.updatedAt = now();
    const persisted = await persist(next);
    if (!persisted.ok) return persisted;
    if (changed) emitNotify(next, typeof reason === 'string' && reason.length <= MAX_REASON_LENGTH ? reason : null);
    return { ok: true, level: next.level, trigger: next.trigger, since: next.since };
  }

  async function recordIdentityOk(identityOk) {
    if (typeof identityOk !== 'boolean') return { ok: false, reason: 'invalid-argument' };
    const next = clone(state);
    next.identityOk = identityOk;
    next.updatedAt = now();
    let autoLifted = false;
    if (
      identityOk === true
      && next.level === 'read-only'
      && next.notify.status === 'delivered'
      && AUTO_LIFT_TRIGGERS.has(next.trigger)
    ) {
      next.level = 'normal';
      next.trigger = null;
      next.since = null;
      autoLifted = true;
    }
    const persisted = await persist(next);
    if (!persisted.ok) return persisted;
    return { ok: true, level: next.level, identityOk, autoLifted };
  }

  async function markNotify({ status, operationId = null, lastCode = null } = {}) {
    if (!XHH_DEGRADE_NOTIFY_STATUSES.includes(status)) return { ok: false, reason: 'invalid-argument' };
    if (!validOptionalText(operationId) || !validOptionalText(lastCode)) return { ok: false, reason: 'invalid-argument' };
    const next = clone(state);
    next.notify.status = status;
    next.notify.attempts = state.notify.attempts + 1;
    if (operationId !== null) next.notify.operationId = operationId;
    if (lastCode !== null) next.notify.lastCode = lastCode;
    next.updatedAt = now();
    const escalated = status === 'failed' || status === 'unknown';
    if (escalated) {
      // 用户规则⑤ + 2026-10-29 口径：通知失败/结果未知的**第一次**即升级全停，不再等 3 次；
      // trigger 按状态区分，便于控制台与路由层判断「未送达 vs 结果未知」；attempts 继续累加供补报审计。
      next.level = 'paused';
      next.trigger = status === 'failed' ? 'notify-failed' : 'notify-unknown';
      next.since = state.level === 'paused' && isFiniteNumber(state.since) ? state.since : now();
    }
    const persisted = await persist(next);
    if (!persisted.ok) return persisted;
    if (escalated) log('warn', 'degrade-notify-escalated', status === 'failed' ? 'notify-failed' : 'notify-unknown');
    return {
      ok: true,
      status: next.notify.status,
      attempts: next.notify.attempts,
      level: next.level,
      escalated,
    };
  }

  async function applyManualRecovery({ operator, confirmed, at = null } = {}) {
    if (confirmed !== true) return { ok: false, reason: 'recovery-not-confirmed' };
    if (typeof operator !== 'string' || operator.trim() === '') return { ok: false, reason: 'invalid-operator' };
    const next = clone(state);
    next.level = 'normal';
    next.trigger = null;
    next.since = null;
    next.notify = emptyNotify();
    next.updatedAt = isFiniteNumber(at) ? at : now();
    const persisted = await persist(next);
    if (!persisted.ok) return persisted;
    return { ok: true, level: 'normal', operator: operator.trim() };
  }

  return { load, snapshot, enter, recordIdentityOk, markNotify, applyManualRecovery };
}
