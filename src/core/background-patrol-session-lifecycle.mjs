/**
 * 后台巡逻：会话生命周期（**纯模块，未接线**）。
 *
 * 按用户 2026-10-25 决策实现（规格「后台会话生命周期」）：
 *  · 固定 session key `patrol:background`：首次创建，之后复用；
 *  · **每 5 天重建一次**（边界精确到毫秒：`now - createdAt >= 5 天` 即轮换），旧 session 归档保留；
 *  · session 丢失/损坏时重建新 session 并写审计，绝不静默复用失效 id；
 *  · 功能关闭：归档保留（可审计、可回滚），之后 ensure 一律拒绝、不再创建；
 *  · 默认关闭：config.enabled !== true → disabled，且**零副作用**（不 load/store、不调会话操作）；
 *  · 并发 ensure 串行，只创建一次；任何持久化失败 **fail-closed**（不把未落盘的会话当可复用，
 *    后续调用直接返回 persist-failed，直到调用方新建实例/修复存储）；
 *  · 结构化审计事件（固定字段、无敏感内容）。
 *
 * 注入边界（本模块不真实调 DSH/网络/文件）：
 *  · `sessions: { createSession(), sessionExists(id), archiveSession(id) }`（全部 async）；
 *  · `store: { load(), save(state) }`（load 返回 state 或 null/undefined；save 抛错或返回
 *    `{ok:false}` 都视为持久化失败）；
 *  · `clock`（毫秒时钟）；`audit(event)` 可选回调（回调异常不影响生命周期）；
 *  · `config` 走与 `background-patrol-session.mjs` 相同的 `resolveBackgroundPatrolConfig`
 *    默认关闭/白名单校验，避免两套门禁口径。
 *
 * 持久状态 schema（严格解析，坏状态 fail-closed，绝不覆盖）：
 * `{schemaVersion, sessionKey, sessionId, createdAt, lastUsedAt, runCount, rotationCount,
 *   archived, archivedAt}`
 *
 * 明确不做：不接线 bridge/调度器；不创建真实会话；不投递 prompt；不写审计落盘；
 * 不实现 DSH session 内容清理（归档由 DSH 负责）；不处理跨进程并发。
 */

import {
  BACKGROUND_SESSION_KEY,
  resolveBackgroundPatrolConfig,
} from './background-patrol-session.mjs';

export { BACKGROUND_SESSION_KEY };

export const BACKGROUND_SESSION_LIFECYCLE_VERSION = 1;
/** 轮换周期：5 天（毫秒）。恰好达到该值即轮换。 */
export const BACKGROUND_SESSION_ROTATION_MS = 5 * 24 * 60 * 60 * 1000;

/** 审计事件类型白名单（固定字段见 `emitAudit`）。 */
export const BACKGROUND_SESSION_AUDIT_EVENT_TYPES = Object.freeze([
  'create',
  'reuse',
  'rotate',
  'rebuild',
  'archive',
  'disabled',
  'persist-failed',
]);

const STATE_KEYS = Object.freeze([
  'schemaVersion', 'sessionKey', 'sessionId', 'createdAt', 'lastUsedAt',
  'runCount', 'rotationCount', 'archived', 'archivedAt',
]);
const MAX_SESSION_ID_LENGTH = 200;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

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

function isValidSessionId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SESSION_ID_LENGTH
    && !CONTROL_CHAR_RE.test(value);
}

function createEmptyState() {
  return {
    schemaVersion: BACKGROUND_SESSION_LIFECYCLE_VERSION,
    sessionKey: BACKGROUND_SESSION_KEY,
    sessionId: null,
    createdAt: null,
    lastUsedAt: null,
    runCount: 0,
    rotationCount: 0,
    archived: false,
    archivedAt: null,
  };
}

function cloneState(state) {
  return {
    schemaVersion: state.schemaVersion,
    sessionKey: state.sessionKey,
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    lastUsedAt: state.lastUsedAt,
    runCount: state.runCount,
    rotationCount: state.rotationCount,
    archived: state.archived,
    archivedAt: state.archivedAt,
  };
}

function stateInvalid(message) {
  const error = new Error(`xhh 后台会话状态不可用：${message}`);
  error.code = 'BACKGROUND_SESSION_LIFECYCLE_STATE_INVALID';
  return error;
}

/**
 * 严格解析持久状态（对象）。未知字段/版本/字段矛盾一律抛 STATE_INVALID。
 * `null`/`undefined` 表示还没有持久状态（首次运行）。
 */
export function parseBackgroundSessionState(raw) {
  if (raw === null || raw === undefined) return createEmptyState();
  if (!isPlainObject(raw)) throw stateInvalid('状态根必须是对象');
  for (const key of Object.keys(raw)) {
    if (!STATE_KEYS.includes(key)) throw stateInvalid(`状态含不支持字段 ${key}`);
  }
  for (const key of STATE_KEYS) {
    if (!hasOwn(raw, key)) throw stateInvalid(`状态缺少字段 ${key}`);
  }
  if (raw.schemaVersion !== BACKGROUND_SESSION_LIFECYCLE_VERSION) throw stateInvalid('schemaVersion 不受支持');
  if (raw.sessionKey !== BACKGROUND_SESSION_KEY) throw stateInvalid('sessionKey 不匹配');
  if (!(raw.sessionId === null || isValidSessionId(raw.sessionId))) throw stateInvalid('sessionId 非法');
  if (!(raw.createdAt === null || isFiniteTimestamp(raw.createdAt))) throw stateInvalid('createdAt 非法');
  if (!(raw.lastUsedAt === null || isFiniteTimestamp(raw.lastUsedAt))) throw stateInvalid('lastUsedAt 非法');
  if ((raw.sessionId === null) !== (raw.createdAt === null)) throw stateInvalid('sessionId 与 createdAt 不一致');
  if ((raw.sessionId === null) !== (raw.lastUsedAt === null)) throw stateInvalid('sessionId 与 lastUsedAt 不一致');
  if (raw.createdAt !== null && raw.lastUsedAt < raw.createdAt) throw stateInvalid('lastUsedAt 早于 createdAt');
  if (!isCount(raw.runCount)) throw stateInvalid('runCount 必须是 >=0 的整数');
  if (raw.sessionId === null && raw.runCount !== 0) throw stateInvalid('无 session 时 runCount 必须为 0');
  if (!isCount(raw.rotationCount)) throw stateInvalid('rotationCount 必须是 >=0 的整数');
  if (typeof raw.archived !== 'boolean') throw stateInvalid('archived 必须是布尔值');
  if (!(raw.archivedAt === null || isFiniteTimestamp(raw.archivedAt))) throw stateInvalid('archivedAt 非法');
  if (raw.archived !== (raw.archivedAt !== null)) throw stateInvalid('archived 与 archivedAt 互相矛盾');
  if (raw.archivedAt !== null && raw.createdAt !== null && raw.archivedAt < raw.createdAt) {
    throw stateInvalid('archivedAt 早于 createdAt');
  }
  return cloneState(raw);
}

function resolveClock(clock) {
  if (clock === undefined || clock === null) return () => Date.now();
  if (typeof clock === 'function') return () => clock();
  if (typeof clock === 'object' && typeof clock.now === 'function') return () => clock.now();
  throw new TypeError('createBackgroundPatrolSessionLifecycle：clock 必须是函数或带 now() 的对象');
}

/**
 * 创建后台会话生命周期控制器（注入一切外部操作）。
 *
 * @param {object} options
 * @param {unknown} options.config 原始后台巡逻配置（enabled !== true → 默认关闭）
 * @param {object} options.store {load(), save(state)}（必填；本模块不直接写文件）
 * @param {object} options.sessions {createSession(), sessionExists(id), archiveSession(id)}（必填）
 * @param {(() => number) | { now?: () => number }} [options.clock]
 * @param {(event: object) => void} [options.audit] 结构化审计回调（异常被吞，不影响生命周期）
 */
export function createBackgroundPatrolSessionLifecycle(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const resolvedConfig = resolveBackgroundPatrolConfig(source.config);
  const enabled = resolvedConfig.enabled === true;
  const clock = resolveClock(source.clock);
  const store = isPlainObject(source.store) ? source.store : {};
  const sessions = isPlainObject(source.sessions) ? source.sessions : {};
  if (typeof store.load !== 'function' || typeof store.save !== 'function') {
    throw new TypeError('createBackgroundPatrolSessionLifecycle：store 必须提供 load() 与 save(state)');
  }
  if (typeof sessions.createSession !== 'function'
    || typeof sessions.sessionExists !== 'function'
    || typeof sessions.archiveSession !== 'function') {
    throw new TypeError('createBackgroundPatrolSessionLifecycle：sessions 必须提供 createSession/sessionExists/archiveSession');
  }
  const audit = typeof source.audit === 'function' ? source.audit : null;

  let state = createEmptyState();
  let phase = 'uninitialized'; // uninitialized | ready | failed
  let failureReason = null;
  let queue = Promise.resolve();

  function clockNow() {
    let value;
    try {
      value = clock();
    } catch {
      return null;
    }
    return isFiniteTimestamp(value) ? value : null;
  }

  function resolveNow(explicit) {
    if (explicit === undefined || explicit === null) return clockNow();
    return isFiniteTimestamp(explicit) ? explicit : null;
  }

  function emitAudit(type, fields = {}) {
    if (audit === null) return;
    const event = {
      type,
      at: clockNow() ?? Date.now(),
      sessionKey: BACKGROUND_SESSION_KEY,
      ...fields,
    };
    try {
      audit(event);
    } catch {
      // 审计回调异常不得影响生命周期。
    }
  }

  function fail(reason) {
    phase = 'failed';
    failureReason = reason;
    return { ok: false, reason };
  }

  async function persist(nextState) {
    try {
      const result = await store.save(cloneState(nextState));
      if (isPlainObject(result) && result.ok === false) throw new Error('store.save returned {ok:false}');
    } catch {
      emitAudit('persist-failed', { reason: 'persist-failed' });
      return false;
    }
    state = cloneState(nextState);
    return true;
  }

  async function loadState() {
    if (phase === 'ready') return { ok: true };
    if (phase === 'failed') return { ok: false, reason: failureReason };
    let raw;
    try {
      raw = await store.load();
    } catch {
      return fail('store-load-failed');
    }
    try {
      state = parseBackgroundSessionState(raw);
    } catch {
      return fail('state-invalid');
    }
    phase = 'ready';
    return { ok: true };
  }

  function disabledResult(reason = 'disabled') {
    emitAudit('disabled', { reason });
    return { ok: false, reason };
  }

  // task-62（P2-1）：resolve 阶段的精确原因（如 invalid-require-mapper-identity / unknown-config-field）
  // 必须透出，否则运维只能看到笼统 'disabled'，分不清是「配置写错」还是「明确关闭」。
  function configDisabledReason() {
    return resolvedConfig.ok === true ? 'disabled' : resolvedConfig.reason;
  }

  async function ensureSessionInternal(request) {
    const payload = isPlainObject(request) ? request : {};
    if (!enabled) return disabledResult(configDisabledReason());
    if (phase === 'failed') return { ok: false, reason: failureReason };

    const loaded = await loadState();
    if (!loaded.ok) return loaded;
    if (state.archived) return disabledResult('closed');

    const now = resolveNow(payload.now);
    if (now === null) return { ok: false, reason: 'invalid-clock' };

    // 1) 无 session：首次创建。
    if (state.sessionId === null) {
      let sessionId;
      try {
        sessionId = await sessions.createSession();
      } catch {
        return { ok: false, reason: 'create-failed' };
      }
      if (!isValidSessionId(sessionId)) return { ok: false, reason: 'create-failed' };
      const next = {
        ...createEmptyState(),
        sessionId,
        createdAt: now,
        lastUsedAt: now,
        runCount: 1,
      };
      if (!(await persist(next))) return fail('persist-failed');
      emitAudit('create', { sessionId, runCount: 1 });
      return { ok: true, sessionId, created: true, runCount: 1 };
    }

    // 2) session 是否还存在（丢失/损坏 → 重建）。
    let exists;
    try {
      exists = await sessions.sessionExists(state.sessionId);
    } catch {
      return { ok: false, reason: 'session-check-failed' };
    }
    if (exists !== true) {
      let sessionId;
      try {
        sessionId = await sessions.createSession();
      } catch {
        return { ok: false, reason: 'create-failed' };
      }
      if (!isValidSessionId(sessionId)) return { ok: false, reason: 'create-failed' };
      const previousSessionId = state.sessionId;
      const next = {
        ...cloneState(state),
        sessionId,
        createdAt: now,
        lastUsedAt: now,
        runCount: 1,
      };
      if (!(await persist(next))) return fail('persist-failed');
      emitAudit('rebuild', { sessionId, previousSessionId, runCount: 1 });
      return { ok: true, sessionId, created: true, rebuilt: true, previousSessionId };
    }

    // 3) 满 5 天：归档旧 session 后轮换（归档失败 fail-closed，不创建第二个）。
    if (now - state.createdAt >= BACKGROUND_SESSION_ROTATION_MS) {
      const previousSessionId = state.sessionId;
      try {
        await sessions.archiveSession(previousSessionId);
      } catch {
        return { ok: false, reason: 'archive-failed' };
      }
      let sessionId;
      try {
        sessionId = await sessions.createSession();
      } catch {
        return { ok: false, reason: 'create-failed' };
      }
      if (!isValidSessionId(sessionId)) return { ok: false, reason: 'create-failed' };
      const next = {
        ...cloneState(state),
        sessionId,
        createdAt: now,
        lastUsedAt: now,
        runCount: 1,
        rotationCount: state.rotationCount + 1,
      };
      if (!(await persist(next))) return fail('persist-failed');
      emitAudit('rotate', {
        sessionId,
        previousSessionId,
        runCount: 1,
        rotationCount: next.rotationCount,
      });
      return {
        ok: true,
        sessionId,
        created: true,
        rotated: true,
        previousSessionId,
        rotationCount: next.rotationCount,
      };
    }

    // 4) 正常复用。
    const next = {
      ...cloneState(state),
      lastUsedAt: now,
      runCount: state.runCount + 1,
    };
    if (!(await persist(next))) return fail('persist-failed');
    emitAudit('reuse', { sessionId: state.sessionId, runCount: next.runCount });
    return { ok: true, sessionId: state.sessionId, created: false, reused: true, runCount: next.runCount };
  }

  async function closeInternal(request) {
    const payload = isPlainObject(request) ? request : {};
    const shouldArchive = payload.archive !== false;
    if (!enabled) return disabledResult(configDisabledReason());
    if (phase === 'failed') return { ok: false, reason: failureReason };

    const loaded = await loadState();
    if (!loaded.ok) return loaded;
    if (state.archived) return { ok: true, archived: true, sessionId: state.sessionId };

    const now = resolveNow(payload.now);
    if (now === null) return { ok: false, reason: 'invalid-clock' };
    const sessionId = state.sessionId;
    // 关键：never-created / 创建失败后的清理不得把状态标记 archived，否则后续 ensure 永远
    // 返回 closed，必须手工删状态文件才能恢复（安装时实际踩到过）。
    if (sessionId === null) {
      return { ok: true, archived: false, sessionId: null };
    }
    // 关键：archive:false = “释放本次运行、保留会话供下次复用”，绝不能把状态标 archived；
    // 否则一次失败清理（如调度加载失败）就会让后续所有启动返回 closed（安装时实际踩到过）。
    if (!shouldArchive) {
      return { ok: true, archived: false, sessionId };
    }
    try {
      await sessions.archiveSession(sessionId);
    } catch {
      return { ok: false, reason: 'archive-failed' };
    }
    const next = {
      ...cloneState(state),
      archived: true,
      archivedAt: now,
    };
    if (!(await persist(next))) return fail('persist-failed');
    emitAudit('archive', { sessionId, archivedAt: now });
    return { ok: true, archived: true, sessionId };
  }

  function statusInternal() {
    const base = {
      enabled,
      sessionKey: BACKGROUND_SESSION_KEY,
      schemaVersion: BACKGROUND_SESSION_LIFECYCLE_VERSION,
      sessionId: state.sessionId,
      createdAt: state.createdAt,
      lastUsedAt: state.lastUsedAt,
      runCount: state.runCount,
      rotationCount: state.rotationCount,
      archived: state.archived,
      archivedAt: state.archivedAt,
      phase,
      failureReason,
      // task-62（P2-1）：配置层原因可查（成功时 'enabled'/'disabled'，失败时为精确 invalid-* 原因），
      // 与 failureReason 一起回答「为什么没跑」。
      configReason: resolvedConfig.reason,
    };
    return base;
  }

  function enqueue(task) {
    const result = queue.then(() => task());
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    /** 首次使用前也可调用；enabled=false 时不触发任何 store/session 操作。 */
    ensureSession: (request) => enqueue(() => ensureSessionInternal(request)),
    close: (request) => enqueue(() => closeInternal(request)),
    status: () => enqueue(async () => {
      if (enabled && phase === 'uninitialized') {
        // status 只读：允许尝试加载，但加载失败不抛错，错误通过 phase/failureReason 暴露。
        await loadState();
      }
      return statusInternal();
    }),
    /** 后端持久化状态快照（供调用方诊断/审计；不触发读写）。 */
    snapshot: () => cloneState(state),
  };
}
