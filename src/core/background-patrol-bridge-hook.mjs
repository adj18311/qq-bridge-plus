/**
 * 路线 B：**bridge 接线 hook**（默认关闭；供 `src/bridge.js` 启动/停止时调用）。
 *
 * 只做“把已有纯模块装配起来”的事：
 *   配置门禁 → 独立 authorizeToken 校验 → controller store（load/新建）→
 *   审计适配器 → session 身份集合 → createAuthorizeWiring().start()
 * 不启动调度器、不创建巡逻会话、不迁移贴吧闸门、不改 QQ/DSH 链路；
 * 不读正式 config（由 bridge 传入 cfg）、不访问平台、不 import bridge。
 *
 * 启用门禁：`config.backgroundPatrol?.enabled === true`；否则 `start()` 返回
 * `{ok:true, enabled:false}`，**零副作用**（不建 store、不校验 token、不 bind 端口）。
 *
 * fail-closed：
 *  · 启用但独立 token（`consoleToken` 参数或 `config.backgroundPatrol.authorizeToken`）
 *    缺失/空/非字符串 → `{ok:false, error:'missing-authorize-token'}`，不启动；
 *  · controller store 路径非法（空/父目录不存在或非目录/不可写）或 load 失败 →
 *    `{ok:false, error:'invalid-controller-store'}`，不启动；
 *  · wiring 启动失败（端口占用/非法 host 等）→ `{ok:false, error:'invalid-options'}`。
 *
 * session 身份（决定哪些 agentKey 是后台会话、哪些是用户例外）：
 *  · `sessions` 为数组/Set → 后台会话 id 集合；
 *  · `sessions` 为对象 → `{backgroundSessionKeys?, backgroundSessionId?, userExemptAgents?}`；
 *  · 或直接传 `backgroundSessionId`（字符串，可为 null）；
 *  · 都没有 → 空集合（authorizeApi 会对所有 agentKey fail-closed deny，不瞎猜）。
 *
 * API：`start()` / `stop()`（幂等）/ `status()`（只读副本）/ `close()`（stop + 关闭 store，幂等）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { createXhhOperationStore } from './xiaoheihe-operation-store.mjs';
import { createXhhAuthorizeAuditAdapter } from './xiaoheihe-authorize-audit-adapter.mjs';
import { createAuthorizeWiring } from './xiaoheihe-authorize-wiring.mjs';
import { createSessionIdentityMapper } from './background-patrol-session-identity.mjs';
import { XHH_IDENTITY_GUARD_NOTIFY_MAX_ATTEMPTS } from './xiaoheihe-identity-guard.mjs';

export const BACKGROUND_PATROL_BRIDGE_HOOK_VERSION = 1;
/** F7：独立 authorizeToken 的最小长度（32 字符，避免弱口令）。 */
export const MIN_AUTHORIZE_TOKEN_LENGTH = 32;

/**
 * task-62（P3-4）：身份模式 → 启动日志的纯函数。
 *
 * 接线（src/bridge.js）只调用它并输出 message，避免「日志文案只存在于 bridge.js 里，
 * 测试只能做脆弱全文匹配」。legacy / unknown 一律按降级告警处理（后台写门禁可能失效），
 * 并在 legacy 文案里给出具体的恢复/加固指引。
 *
 * @param {unknown} mode identityMode（'mapper' | 'legacy' | 其它）
 * @returns {{level:'info'|'warn', degraded:boolean, message:string}}
 */
export function describeIdentityMode(mode) {
  const normalized = typeof mode === 'string' && mode !== '' ? mode : 'unknown';
  if (normalized === 'legacy') {
    return {
      level: 'warn',
      degraded: true,
      message: '⚠️ 后台写门禁已降级（legacy 身份模式）：后台巡逻来源的写请求不会被 read-only-background 拒绝；'
        + '请把 state/sessions.json 的键名恢复为 group:/private:/patrol:background 形状，或设置 '
        + 'backgroundPatrol.requireMapperIdentity=true 强制 fail-closed。',
    };
  }
  if (normalized !== 'mapper') {
    return {
      level: 'warn',
      degraded: true,
      message: `⚠️ 后台巡逻身份模式未知（${normalized}）：无法确认后台写门禁是否生效，请检查 state/sessions.json 与身份映射。`,
    };
  }
  return { level: 'info', degraded: false, message: `后台巡逻身份模式：${normalized}` };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeKeyList(value) {
  if (value === undefined || value === null) return [];
  if (value instanceof Set) return [...value].filter((item) => typeof item === 'string' && item !== '');
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item !== '');
  return [];
}

function normalizeOwnerQQ(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[0-9]{1,20}$/.test(value)) return value;
  return null;
}

/** sessions 是否为「QQ key → sessionId」映射（区别于旧的 backgroundSessionKeys 对象）。 */
function isSessionMap(sessions) {
  if (sessions instanceof Map) return true;
  if (!isPlainObject(sessions)) return false;
  return !Object.prototype.hasOwnProperty.call(sessions, 'backgroundSessionKeys')
    && !Object.prototype.hasOwnProperty.call(sessions, 'userExemptAgents');
}

/**
 * task-78：身份解析。
 *  · mapper 模式（sessions 为 state.sessions 的 QQ key→sessionId 映射）：
 *    会话身份只能证明来源会话，不能证明具体操作由用户明确要求。
 *    patrol / owner / 允许的 group 均按 background 计额；其它 unknown deny。
 *  · legacy 模式（数组/Set 或 {backgroundSessionKeys,userExemptAgents}）：保持旧行为。
 * backgroundSessionId 缺失（null）时不得伪造：mapper 无 patrol 命中，相关会话一律 deny + warn。
 */
function resolveIdentity(source) {
  const ownerQQ = normalizeOwnerQQ(source.ownerQQ);
  const providedBg = typeof source.backgroundSessionId === 'string' && source.backgroundSessionId !== ''
    ? source.backgroundSessionId
    : null;
  const sessions = source.sessions;

  if (isSessionMap(sessions)) {
    const groupExempt = source.groupExempt !== undefined
      ? source.groupExempt === true
      : !(isPlainObject(source.config?.backgroundPatrol) && source.config.backgroundPatrol.groupExempt === false);
    let mapper = null;
    if (ownerQQ !== null) {
      try {
        mapper = createSessionIdentityMapper({
          sessions,
          backgroundSessionId: providedBg,
          ownerQQ,
          groupExempt,
        });
      } catch {
        mapper = null;
      }
    }
    // 每次按当前可信映射分类（会话可能在 hook 启动后新建、撤销或整体替换）。
    const currentMapperNow = () => {
      try {
        const currentSessions = typeof source.sessionsProvider === 'function' ? source.sessionsProvider() : sessions;
        if (!isSessionMap(currentSessions)) return null;
        let currentBg = providedBg;
        if (typeof source.sessionsProvider === 'function') {
          // 使用实时可信映射而非启动时的旧 id。冲突时不得让后台优先匹配绕过歧义检查。
          const entries = currentSessions instanceof Map ? [...currentSessions.entries()] : Object.entries(currentSessions);
          const backgroundEntry = entries.find(([key]) => key === 'patrol:background');
          const candidate = backgroundEntry?.[1];
          currentBg = typeof candidate === 'string' && candidate !== ''
            && entries.filter(([, id]) => id === candidate).length === 1 ? candidate : null;
        }
        return createSessionIdentityMapper({ sessions: currentSessions, backgroundSessionId: currentBg, ownerQQ, groupExempt });
      } catch { return null; }
    };
    const classifier = mapper === null ? () => 'unknown' : (agentKey) => {
      const currentMapper = currentMapperNow();
      if (currentMapper === null) return 'unknown';
      const result = currentMapper.classify(agentKey);
      if (!isPlainObject(result) || result.ok !== true) return 'unknown';
      if (result.class === 'patrol') return 'background';
      if (result.class === 'owner') return 'background';
      if (result.class === 'group') return currentMapper.isUserExempt(agentKey) ? 'background' : 'unknown';
      return 'unknown';
    };
    // task-49：来源（provenance）与是否计额（agentClass）正交。patrol 会话的写工具由 api 拒绝；
    // owner/群友主动写仍放行（不得误禁），来源无法判定时交给 api 侧 fail-closed（unknown-source）。
    const provenance = mapper === null ? null : (agentKey) => {
      const currentMapper = currentMapperNow();
      if (currentMapper === null) return 'unknown';
      const result = currentMapper.classify(agentKey);
      if (!isPlainObject(result) || result.ok !== true) return 'unknown';
      if (result.class === 'patrol') return 'patrol';
      if (result.class === 'owner') return 'owner';
      if (result.class === 'group') return currentMapper.isUserExempt(agentKey) ? 'group' : 'unknown';
      return 'unknown';
    };
    return {
      mode: 'mapper',
      classifier,
      provenance,
      backgroundSessionId: providedBg,
      hasOwnerQQ: ownerQQ !== null,
      mapperReady: mapper !== null,
      legacy: null,
      hasBackgroundSessionId: providedBg !== null,
    };
  }

  const background = [];
  const exempt = [];
  if (Array.isArray(sessions) || sessions instanceof Set) {
    background.push(...normalizeKeyList(sessions));
  } else if (isPlainObject(sessions)) {
    background.push(...normalizeKeyList(sessions.backgroundSessionKeys));
    if (typeof sessions.backgroundSessionId === 'string' && sessions.backgroundSessionId !== '') {
      background.push(sessions.backgroundSessionId);
    }
    exempt.push(...normalizeKeyList(sessions.userExemptAgents));
  }
  if (providedBg !== null) background.push(providedBg);
  return {
    mode: 'legacy',
    classifier: null,
    backgroundSessionId: providedBg,
    hasOwnerQQ: ownerQQ !== null,
    mapperReady: false,
    legacy: {
      backgroundSessionKeys: [...new Set(background)],
      userExemptAgents: [...new Set(exempt)],
    },
    hasBackgroundSessionId: [...new Set(background)].length > 0,
  };
}

function resolveAuthorizeToken(source, config) {
  const candidate = source.consoleToken !== undefined
    ? source.consoleToken
    : config.backgroundPatrol?.authorizeToken;
  return typeof candidate === 'string' && candidate !== '' ? candidate : null;
}

function buildAudit(source) {
  const audit = source.audit;
  if (typeof audit === 'function') return audit;
  if (isPlainObject(audit) && typeof audit.record === 'function') {
    let adapter;
    try {
      adapter = createXhhAuthorizeAuditAdapter({ audit });
    } catch {
      return undefined;
    }
    return (event) => {
      try {
        const pending = adapter.record(event);
        if (pending !== null && typeof pending?.catch === 'function') pending.catch(() => {});
      } catch {
        // 审计失败不影响授权响应（适配器/审计模块自行记录失败）。
      }
    };
  }
  return undefined;
}

/** task-78：审计模块（带 load）在接线前先 load；失败则告警并禁用审计（不影响授权结果）。 */
async function prepareAudit(source) {
  const raw = source.audit;
  if (isPlainObject(raw) && typeof raw.load === 'function' && typeof raw.record === 'function') {
    try {
      await raw.load();
    } catch {
      return undefined;
    }
  }
  return buildAudit(source);
}

/**
 * 创建 bridge 接线 hook（不自动启动）。
 *
 * @param {object} options
 * @param {unknown} options.config bridge 的完整 cfg（只读 `backgroundPatrol`）
 * @param {string} [options.consoleToken] 独立 authorizeToken（优先于 config.backgroundPatrol.authorizeToken）
 * @param {string} options.controllerStorePath controller 持久化文件路径（必须显式提供）
 * @param {number} [options.ownerQQ] 管理员 QQ（仅记录到 status，不用于判定）
 * @param {unknown} [options.sessions] 后台会话身份（数组/Set/对象）
 * @param {string|null} [options.backgroundSessionId] 后台会话 id（可为 null）
 * @param {unknown} [options.audit] 审计函数或带 record() 的审计模块（会经适配器映射）
 * @param {object} [options.logger] 只接收固定字段（无 token）
 * @param {string} [options.host] 仅回环（默认 127.0.0.1）
 * @param {number} [options.port] 默认 0
 */
export function classifyUnconfirmedWrites(snapshot) {
  const invalid = { known: false, pendingWrites: 0, unknownWrites: 0, reason: 'unconfirmed-query-failed' };
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.pending) || !Array.isArray(snapshot.unknown)) return invalid;
  const valid = (item) => isPlainObject(item) && ['read', 'post', 'comment'].includes(item.kind);
  if (!snapshot.pending.every(valid) || !snapshot.unknown.every(valid)) return invalid;
  const pendingWrites = snapshot.pending.filter((item) => item.kind !== 'read').length;
  const unknownWrites = snapshot.unknown.filter((item) => item.kind !== 'read').length;
  return { known: true, pendingWrites, unknownWrites, reason: pendingWrites > 0 ? 'unconfirmed-write' : null };
}

export function createBackgroundPatrolBridgeHook(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const config = isPlainObject(source.config) ? source.config : {};
  const logger = isPlainObject(source.logger) ? source.logger : null;

  let store = null;
  let wiring = null;
  let started = false;
  let url = null;
  let port = null;
  let lastError = null;
  let startPromise = null;
  let closed = false;
  let identityStatus = null;
  let auditEnabled = false;
  // task-64：身份守卫接线（可选注入；由 bridge 创建并持有同一实例，供恢复端点与 /api/status 复用）。
  // · guard 为 task-63 的纯状态机：异常 → writes-paused，通知 failed/unknown → all-paused。
  // · notifyOwner(text) 必须返回 {outcome:'delivered'|'failed'|'unknown', code?}：只有 delivered
  //   代表发送接口给了回执；不得把 promise resolve 当送达。
  const identityGuard = isPlainObject(source.guard) && typeof source.guard.snapshot === 'function'
    ? source.guard
    : null;
  const notifyOwner = typeof source.notifyOwner === 'function' ? source.notifyOwner : null;
  // A-1：凭据类（交互式登录 / 二维码登录）完成时的归属通知。这些人知道「谁在何时发起了登录」
  // 是必须的（登录会覆盖写整机共享的 cookies.json），但它是**旁路**：不参与任何判定，
  // 未注入或抛错都不影响工具回执（api 侧已 try/catch）。
  const credentialNotify = typeof source.credentialNotify === 'function' ? source.credentialNotify : null;
  // A-2：降级只读层（身份守卫不可用时的替代门禁）。纯状态机的只读消费点 —— hook 不写它，
  // 只把它原样透传给 authorize-wiring；级别由 degrade 模块自己持有（含落盘与 fail-closed）。
  const degrade = isPlainObject(source.degrade) && typeof source.degrade.snapshot === 'function'
    ? source.degrade
    : null;
  if (source.degrade !== undefined && degrade === null) {
    throw new TypeError('createBackgroundPatrolBridgeHook：degrade 必须提供 snapshot()');
  }
  // 控制台专栏配置（四个能力开关/只读/巡逻开关与时段/每日额度）。注入读快照的函数：
  // 保存后必须立刻生效，不能等重启；读不到时 api 侧按「写全拒、读可用」处理。
  const consoleSettings = typeof source.consoleSettings === 'function' ? source.consoleSettings : null;
  if (source.consoleSettings !== undefined && typeof source.consoleSettings !== 'function') {
    throw new TypeError('createBackgroundPatrolBridgeHook：consoleSettings 必须是返回配置对象的函数');
  }
  const qqCommsProvider = typeof source.qqCommsProvider === 'function' ? source.qqCommsProvider : null;
  // task-71 P2-2：可选审计回调（由 bridge 注入 recordBackgroundPatrolAudit）。
  // 只用于可观测性：审计失败不得影响任何判定；不是本模块的权威账本接口。
  const recordAudit = typeof source.recordAudit === 'function' ? source.recordAudit : null;
  // m21233（独立故障注入复核）：身份守卫不可用时绝不能「少一层继续放行」写请求。
  // 默认 false = 保留既有调用方契约（脚本/测试不传 guard 仍可用；task-49 起 guard 就是可选注入）；
  // 生产 bridge 入口显式传 true，把「守卫构造/加载失败」变成拒绝启动整个授权端点。
  // 非 undefined 的非布尔值不得静默当 false（与 readOnly / requireMapperIdentity 同口径）。
  const rawRequireIdentityGuard = source.requireIdentityGuard;
  const requireIdentityGuard = rawRequireIdentityGuard === true;
  const requireIdentityGuardInvalid = rawRequireIdentityGuard !== undefined
    && typeof rawRequireIdentityGuard !== 'boolean';
  function auditGuardEvent(reason, action, result) {
    if (recordAudit === null) return;
    try {
      const pending = recordAudit(reason, action, result);
      if (pending !== null && typeof pending === 'object' && typeof pending.then === 'function') {
        pending.catch(() => {});
      }
    } catch { /* ignore */ }
  }
  let guardFlushPromise = null;
  let unknownSourceReported = false;
  let lastReportedIdentityOk = null;
  // task-64 / P2-2：degraded 是内存态（落盘失败时限制只存在于当前进程），重启会静默回到磁盘上的
  // normal —— 这不是「自愈」，必须主动告警。复用 task-65 的 owner 通知通道，同因 10 分钟去重。
  const DEGRADED_ALERT_WINDOW_MS = 10 * 60 * 1000;
  let lastDegradedAlertAt = 0; // true / false / null（只在状态变化时调用 reportIdentityRestored）
  // task-69：重发耗尽只告警一次（每个 operationId 一次），避免日志刷屏
  let lastNotifyExhaustedOperationId = null;

  function log(level, code) {
    if (logger === null) return;
    const fn = typeof logger[level] === 'function' ? logger[level] : null;
    if (fn === null) return;
    try {
      fn.call(logger, 'background-patrol-bridge-hook', { code });
    } catch {
      // ignore
    }
  }

  async function ensureControllerStore() {
    const storePath = source.controllerStorePath;
    if (typeof storePath !== 'string' || storePath.trim() === '') {
      return { ok: false, error: 'invalid-controller-store' };
    }
    const resolved = path.resolve(storePath);
    const directory = path.dirname(resolved);
    try {
      const stat = await fs.stat(directory);
      if (!stat.isDirectory()) return { ok: false, error: 'invalid-controller-store' };
      await fs.access(directory, fs.constants.W_OK);
      const fileStat = await fs.stat(resolved).catch(() => null);
      if (fileStat !== null && !fileStat.isFile()) return { ok: false, error: 'invalid-controller-store' };
    } catch {
      return { ok: false, error: 'invalid-controller-store' };
    }

    let candidate;
    try {
      candidate = createXhhOperationStore({
        filePath: resolved,
        ...(isPlainObject(source.fsOps) ? { fsOps: source.fsOps } : {}),
      });
    } catch {
      return { ok: false, error: 'invalid-controller-store' };
    }
    try {
      await candidate.load();
    } catch {
      try {
        await candidate.close?.();
      } catch {
        // ignore
      }
      return { ok: false, error: 'invalid-controller-store' };
    }
    store = candidate;
    return { ok: true };
  }

  /** 缓存 controller 只读状态，供同步 status() 暴露 reserved/used（B3）。 */
  let controllerStatus = null;
  let lastReconcile = null;
  // 终审①：未确认写状态必须来自「当前 controller 事实」，不能依赖上一次 reconcile 的 blocked 快照。
  // 查询失败/未初始化时保持 unknown，写门禁 fail-closed。
  let persistFailureLatched = false;
  let unconfirmedWrite = { known: false, pendingWrites: 0, unknownWrites: 0, reason: 'unconfirmed-query-failed' };

  async function refreshUnconfirmedWrites() {
    if (store === null) {
      unconfirmedWrite = { known: false, pendingWrites: 0, unknownWrites: 0, reason: 'unconfirmed-query-failed' };
      return unconfirmedWrite;
    }
    try {
      const snapshot = await store.controller.status();
      unconfirmedWrite = classifyUnconfirmedWrites(snapshot);
    } catch {
      unconfirmedWrite = { known: false, pendingWrites: 0, unknownWrites: 0, reason: 'unconfirmed-query-failed' };
    }
    return unconfirmedWrite;
  }

  // 可信串行包装：API 的每次 controller 调用都走这里；写类调用完成后立即刷新未确认写事实，
  // 使 authorize→commit 之间的第二笔写也能看到第一笔已 commit 的 pending。
  // reload 分叉部署阻断：**不得**在 start()/wiring 时捕获 controller 实例（store.reload 会替换它），
  // 每次属性访问/调用都现解析 store.controller；旧实例票据由 controller 侧的实例命名空间拒绝。
  function controllerForApi() {
    return new Proxy({}, {
      get(_target, property) {
        if (store === null) throw new Error('controller store 未就绪');
        const raw = store.controller;
        if (raw === null || raw === undefined) throw new Error('controller 未就绪');
        const value = Reflect.get(raw, property, raw);
        if (typeof value !== 'function') return value;
        const bound = value.bind(raw);
        if (property === 'status' || property === 'reserveRead') return bound;
        return (...args) => {
          const outcome = bound(...args);
          return Promise.resolve(outcome).then(async (result) => {
            await refreshUnconfirmedWrites();
            return result;
          });
        };
      },
    });
  }
  async function refreshControllerStatus() {
    if (store === null) { controllerStatus = null; return; }
    try {
      const snapshot = await store.controller.status();
      controllerStatus = {
        reserved: { read: snapshot.reservedRead ?? 0, write: snapshot.reservedWrite ?? 0 },
        used: {
          read: snapshot.read?.used ?? 0,
          post: snapshot.post?.used ?? 0,
          comment: snapshot.comment?.used ?? 0,
        },
        paused: { access: snapshot.accessPaused === true, write: snapshot.writePaused === true },
        day: snapshot.day ?? null,
      };
    } catch {
      controllerStatus = null;
    }
  }

  /** F1：controller 状态落盘（authorize-api 在 commit/abort/started-complete 成功后 await；reserve 不落盘）。 */
  async function persistControllerState() {
    if (store === null) throw new Error('controller store 未就绪');
    const result = await store.save();
    if (isPlainObject(result) && result.ok === false) {
      const safeCode = (value) => typeof value === 'string' && /^[A-Z0-9_-]{1,64}$/.test(value) ? value : null;
      const code = safeCode(result.error?.code) ?? safeCode(result.code) ?? 'WRITE_FAILED';
      const cause = safeCode(result.error?.causeCode);
      const error = new Error(`controller store save 失败（${code}${cause ? `：${cause}` : ''}）`);
      error.code = code;
      throw error;
    }
    await refreshControllerStatus();
    return result;
  }

  /** stop/close 兜底 save：失败只记固定字段日志，不阻塞退出。 */
  async function saveBestEffort() {
    if (store === null) return;
    try {
      const result = await store.save();
      if (isPlainObject(result) && result.ok === false) log('warn', 'controller-save-failed');
    } catch {
      log('warn', 'controller-save-failed');
    }
  }

  /** task-64：只读快照（供 bridge /api/status 与恢复端点复用；读不到返回 null）。 */
  function guardSnapshot() {
    if (identityGuard === null) return null;
    try {
      const snapshot = identityGuard.snapshot();
      return isPlainObject(snapshot) ? snapshot : null;
    } catch {
      return null;
    }
  }

  /** 把 owner 通知回执归一成 guard 只接受的三种 outcome；任何异常都按 failed（不得当 delivered）。 */
  async function deliverOwnerNotice(message) {
    if (notifyOwner === null) return { outcome: 'failed', code: 'notify-unavailable' };
    let result;
    try {
      result = await notifyOwner(message);
    } catch (error) {
      return { outcome: 'failed', code: typeof error?.code === 'string' ? error.code : 'notify-threw' };
    }
    if (!isPlainObject(result)) return { outcome: 'unknown', code: 'invalid-receipt' };
    if (result.outcome === 'delivered' || result.outcome === 'failed' || result.outcome === 'unknown') {
      return { outcome: result.outcome, code: typeof result.code === 'string' ? result.code : null };
    }
    return { outcome: 'unknown', code: 'invalid-receipt' };
  }

  /**
   * task-64 / P2-2：degraded 运营告警（同因 10 分钟去重）。
   * degraded 表示「限制增加但落盘失败」：当前进程内是 all-paused，但磁盘上仍是上一次成功写的旧状态。
   *
   * task-78 更新：重启后果**取决于降级锁存是否写成**，不能一句话说死：
   *  · 锁存写成（`<stateFile>.degraded-latch`）→ 重启时 `applyLoad()` 复核 rank 不足 → fail-closed 到 all-paused，
   *    限制不会静默消失；
   *  · 锁存也没写成（典型：state 目录本身不可写，与 persist 失败同源）→ 只有「限制增加」失败这一支
   *    会真的丢保护（重启读回旧状态）；「限制减少」失败（persistLift）本就未写 latch，重启后磁盘仍受限。
   * 所以文案必须同时说清「有保护」与「保护本身可能失效」两条路，否则运维会在其中一种情况下误判。
   * 守卫 guard 的 `degraded` 仍是内存态、且 degraded 本身从不落盘（见 guard 测试）。
   */
  /**
   * task-79 P2-1 / task-80：degraded 有**四类**来源，告警必须按 `snapshot.degradeReason` 分支，
   * 否则会把运营引向错误的排查方向。
   *  · 类1「落盘失败」：degradeReason === 'persist-failed' —— 内存已增加限制但写盘失败，
   *    `<stateFile>.degraded-latch` 决定重启是否回滚（见 task-78）；
   *  · 类2「状态文件损坏/不可读」：degradeReason ∈ 白名单 —— `failClosed()` 同样置 degraded=true，
   *    但它**根本不写 latch**（没有可写的「新状态」，磁盘上的坏文件才是事实）。
   *    对类2 说「请检查磁盘写入权限」是误导：该查的是那个坏文件本身。
   *  · 类3「两者叠加」：degradeReason === 'persist-failed' 且 skipReason 非 null —— 损坏态修复后
   *    又发生落盘失败。两条事实都要说，任何单边说辞都会漏掉一半真相。
   *  · 类4「历史陈旧标记」：degradeReason === 'degraded' —— 磁盘上留着旧版本误写进去的
   *    `degraded:true`。文件结构合法、既非损坏也非本次落盘失败，该做的是核对限制、清标记、走人工恢复。
   * 判据取 `degradeReason` 而**不是** `skipReason`：后者是「文件为何不可读」的历史记录，
   * 修好之后仍留在 state 里，只看它会把类3 误判成类2（task-80 探针实证可达）。
   */
  function degradedAlertText(snapshot) {
    const skipReason = typeof snapshot.skipReason === 'string' ? snapshot.skipReason : null;
    // 契约：degraded===true 时 guard 一定给出非空 degradeReason。若字段缺失（旧快照/热更新不一致），
    // 退回 task-80 之前的判据（只看 skipReason）——宁可退化成旧文案，也不要输出「unknown」这种假事实。
    const reason = typeof snapshot.degradeReason === 'string' && snapshot.degradeReason !== ''
      ? snapshot.degradeReason
      : (skipReason === null ? 'persist-failed' : skipReason);
    const COMMON_TAIL = '重启≠恢复，重启后必须复查 degraded 与回执。';
    if (reason === 'persist-failed') {
      // task-83 F2（事实可用后必须用）：guard 现在会把「最近一次降级锁存是否写失败」作为只读事实给出。
      // 在此之前文案只能写「若锁存也写失败……」，运维无法判断自己处在哪一半——而这正是
      // 「重启到底安不安全」的分水岭。有了事实位就必须分开说，不能让运维去猜。
      const latchFailed = snapshot.degradedLatchWriteFailed === true;
      const latchSucceeded = snapshot.degradedLatchWriteFailed === false;
      const base = '【身份守卫】降级状态写入磁盘失败（degraded）：内存与磁盘可能不一致。请检查 state 目录写入权限/磁盘并尽快人工处置。';
      const tail = '重启≠恢复，重启后必须复查 degraded 与回执。';
      // 类3（任何分支都必须叠加）：先前的损坏仍未清理，本次落盘又失败 —— 两个问题都在，必须都说。
      const residue = skipReason === null
        ? ''
        : `另外，本次落盘失败之前该状态文件还有未清理的损坏记录（${skipReason}），两条问题都要处置：先修文件，再修磁盘写入。`;
      let consequence;
      if (latchFailed) {
        // 两处写路径同源失败（state 目录整体不可写）：磁盘上连「曾经降级」的痕迹都没有。
        consequence = '**本次降级锁存也写失败**：磁盘上不会留下任何降级痕迹。若本次失败的是「限制增加」，则重启会读回旧状态、该限制被静默回滚，且事后无从查证——**不要用重启处置，先修磁盘/权限**，修好后再确认限制仍在。';
      } else if (latchSucceeded) {
        consequence = '降级锁存已写成（本次写锁存成功）：重启会由它检出并继续 fail-closed，限制不会消失。';
      } else {
        // 旧快照/热更新不一致：没有该事实位，只能保留两种可能的条件表述（宁可含糊，不可编事实）。
        consequence = '重启后果分两种（本进程未报告锁存写入结果）：若降级锁存已写成，重启会由它检出并继续 fail-closed（限制不会消失）；若锁存也写失败（state 目录整体不可写时两者同源），且本次失败的是「限制增加」，则重启会读回旧状态、该限制被静默回滚。';
      }
      return base + consequence + residue + tail;
    }
    // 类4：磁盘上带着旧版本（task-80 之前）写下的 degraded:true。
    // 这不是损坏、也不是本次落盘失败，而是「上一版把纯内存态误写进了磁盘」。
    // task-80 已在 persist 里归一为 false，此分支只为兼容历史文件；判定方向保守（仍全部暂停）。
    if (reason === 'degraded') {
      const base = '【身份守卫】状态文件里带有旧版本写入的降级标记（degraded:true）：文件本身可读、结构合法，这不是损坏、也不是本次落盘失败，请勿按「修坏文件」或「查磁盘权限」处置。当前按保守方向全部暂停（effectiveState=all-paused）。新版本已不再把该标记写入磁盘，任一次成功落盘后即可清除。请核对本次限制是否与预期一致，必要时在控制台发起「受控补报告警」并走人工恢复。';
      // task-80 P3-5：类4 可能与历史 skipReason 并存（旧文件既带 degraded:true 又带 skipReason）。
      // 此时「清除降级标记」只是让它不再重复告警，**不等于解除暂停**——暂停由 skipReason 那条历史事实撑着。
      // 不说清这一点，运维会以为清掉标记就恢复了。
      //
      // task-82 P3（措辞）：不再断言「当前 all-paused 是因为它（skipReason）而成立」。
      // 旧产物可能是 `writes-paused + skipReason + degraded:true`：那时 effectiveState 之所以是
      // all-paused 是**降级标记**造成的，skipReason 只决定「清标记之后还剩哪种暂停」（writes-paused）。
      // 断言因果关系会在这种组合下说错话；只说「暂停判定仍按该历史记录生效」即可，两种情况都不假。
      if (skipReason === null) return base + COMMON_TAIL;
      return `${base}注意：该文件还带着历史记录（${skipReason}），暂停判定仍按这条记录生效；清除降级标记只是让这条告警不再重复，不会解除暂停。要恢复仍须走受控补报告警 + 真实回执 + 人工恢复。${COMMON_TAIL}`;
    }
    // 类2：损坏态。reason 这里应等于某个白名单 skipReason。
    const shown = reason ?? skipReason ?? 'unknown';
    return `【身份守卫】状态文件损坏/不可读（${shown}）已 fail-closed 到全部暂停：这不是落盘失败，本次不会写降级锁存（没有可写的新状态），请直接检查并修复/移走身份守卫状态文件。重启会用同一个文件重新加载，若文件未修复则仍 fail-closed；若文件被外部替换成更宽松的内容，重启会按新内容加载。修复后须在控制台发起「受控补报告警」，拿到真实发送回执后再人工恢复。${COMMON_TAIL}`;
  }

  async function maybeNotifyDegraded(snapshot) {
    if (snapshot === null || snapshot.degraded !== true) return;
    const now = Date.now();
    if (now - lastDegradedAlertAt < DEGRADED_ALERT_WINDOW_MS) return;
    lastDegradedAlertAt = now;
    const outcome = await deliverOwnerNotice(degradedAlertText(snapshot));
    if (outcome.outcome !== 'delivered') {
      // task-84 P2-1：告警**没送出去**时，事实位（锁存也写失败）若只活在进程内存里，
      // 运维在日志/审计/控制台都查不到——而这恰好是最危险的组合：重启会静默回滚限制、
      // 且没有任何人知道。所以把该布尔随日志码与审计一起外泄（仍然只读，不改判定）。
      const latchWriteFailed = snapshot.degradedLatchWriteFailed === true;
      log('warn', `identity-guard-degraded-alert-${outcome.outcome}${outcome.code === null ? '' : `-${outcome.code}`}${latchWriteFailed ? '-latch-write-failed' : ''}`);
      // task-71 P2-4：运营告警发送失败只写日志，事后无法追责「降级了但没人知道」。
      // 纯可观测（不改任何判定），每个 10 分钟窗口至多一行。
      auditGuardEvent('identity-guard-degraded-alert-failed', 'pause', 'failure');
      if (latchWriteFailed) {
        // 独立 reason 而不是给原 reason 加后缀/参数：审计 reason 是机器码白名单（^[a-z][a-z0-9-]{0,63}$），
        // 这样 grep 一个码就能捞出「告警没送达 **且** 锁存也没写成」的全部历史。
        auditGuardEvent('identity-guard-degraded-alert-failed-latch-write-failed', 'pause', 'failure');
      }
    }
  }

  /**
   * task-64：补发/重发身份守卫通知（防死锁：all-paused 下仍可发送，不走自身门禁）。
   * 串行化：reconcile 与启动可能并发触发，同一时刻只允许一个 flush。
   */
  async function flushIdentityGuardNotifications() {
    if (identityGuard === null) return { ok: true, skipped: true };
    if (guardFlushPromise !== null) return guardFlushPromise;
    guardFlushPromise = (async () => {
      try {
        try {
          await identityGuard.evaluateNotifyDeadline();
        } catch { /* 时钟异常由 guard 自己升级 all-paused */ }
        let snapshot = guardSnapshot();
        // task-77（GPT 复核 #5）：degraded 表示「限制只存在于内存、磁盘上还是旧的 normal」——
        // 进程重启会静默回滚。这里每轮 reconcile 都重试一次落盘，把窗口压到最小（能自愈就自愈）；
        // 仍失败则下面 maybeNotifyDegraded 继续告警。绝对耐久性取决于磁盘可写，这一点无法靠代码伪造。
        if (snapshot !== null && snapshot.degraded === true
          && typeof identityGuard.retryPersist === 'function') {
          try { await identityGuard.retryPersist(); } catch { /* 失败即仍 degraded */ }
          snapshot = guardSnapshot();
        }
        await maybeNotifyDegraded(snapshot);
        // 补报重试：pending 必发；failed/unknown 且未达上限时重发（同一 operationId）。
        // task-69 P1-A：unknown 也必须重发（旧实现只认 failed，一次 unknown 就永久停发 → all-paused 死锁）；
        // task-69 P1-B：上限由 guard 常量统一（attempts 在 guard 侧对重复 outcome 也计数）。
        // all-paused 下 delivered 迟到补报会被 guard 接受但不会自动解除。
        const notifyRetryable = snapshot !== null && snapshot.notify
          && typeof snapshot.notify.operationId === 'string'
          && (snapshot.notify.status === 'pending'
            || ((snapshot.notify.status === 'failed' || snapshot.notify.status === 'unknown')
              && (snapshot.notify.attempts ?? 0) < XHH_IDENTITY_GUARD_NOTIFY_MAX_ATTEMPTS));
        if (notifyRetryable) {
          const outcome = await deliverOwnerNotice(
            `【身份守卫】检测到身份异常（${snapshot.anomalyId ?? 'unknown'}）：后台授权写入已暂停。请检查后台会话身份配置；如需人工恢复，请在控制台调用恢复入口。`,
          );
          try {
            await identityGuard.reportNotifyResult({
              operationId: snapshot.notify.operationId,
              outcome: outcome.outcome,
              ...(outcome.code === null ? {} : { code: outcome.code }),
            });
          } catch { /* guard 自身 fail-closed 已在状态里 */ }
          snapshot = guardSnapshot();
          // task-69：耗尽必须可观察（不能静默停发）；每个 operationId 只记一次。
          if (snapshot !== null && snapshot.notify?.retriesExhausted === true
            && snapshot.notify.operationId !== lastNotifyExhaustedOperationId) {
            lastNotifyExhaustedOperationId = snapshot.notify.operationId;
            log('error', 'identity-guard-notify-retries-exhausted');
            // task-71 P2-2：耗尽必须进审计（可观测性），每个 operationId 一次。
            auditGuardEvent('identity-guard-notify-retries-exhausted', 'pause', 'failure');
          }
        }
        if (snapshot !== null && snapshot.restoreNotify?.status === 'pending' && typeof snapshot.restoreNotify.operationId === 'string') {
          const outcome = await deliverOwnerNotice(
            '【身份守卫】身份识别已恢复；恢复通知送达后会解除后台授权写入限制（写入仍会在守卫重新判定前保持暂停）。',
          );
          try {
            await identityGuard.reportRestoreNotifyResult({
              operationId: snapshot.restoreNotify.operationId,
              outcome: outcome.outcome,
              ...(outcome.code === null ? {} : { code: outcome.code }),
            });
          } catch { /* ignore */ }
        }
        return { ok: true };
      } finally {
        guardFlushPromise = null;
      }
    })();
    return guardFlushPromise;
  }

  /**
   * task-64：把当前身份解析结果同步给 guard（只在状态变化时调用 reportIdentityRestored）。
   * · legacy / mapper 不完整 → reportAnomaly（kind 固定三类，detail 只用类别不用 QQ）。
   * · mapper 完整且 guard 仍认为 identityOk=false → reportIdentityRestored({identityOk:true})。
   * · legacy 而 guard 曾认为 identityOk=true → reportIdentityRestored({identityOk:false})（作废迟到回执）。
   */
  async function syncIdentityGuardState(identity) {
    if (identityGuard === null) return;
    const snapshot = guardSnapshot();
    const identityOkKnown = snapshot !== null && snapshot.identityOk === true;
    if (identity.mode === 'legacy') {
      // 先报告异常（commitAnomaly 会把 identityOk 归 null、清空 restoreNotify、置 notify pending），
      // 再显式落盘 identityOk:false —— 顺序反了会被 commitAnomaly 覆盖。
      try { await identityGuard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-session-shape' }); } catch { /* ignore */ }
      try { await identityGuard.reportIdentityRestored({ identityOk: false }); } catch { /* ignore */ }
      lastReportedIdentityOk = false;
    } else if (identity.mapperReady !== true || identity.hasBackgroundSessionId !== true || identity.hasOwnerQQ !== true) {
      try { await identityGuard.reportAnomaly({ kind: 'mapper-unavailable', detail: 'mapper-not-ready' }); } catch { /* ignore */ }
      try { await identityGuard.reportIdentityRestored({ identityOk: false }); } catch { /* ignore */ }
      lastReportedIdentityOk = false;
    } else if (identityOkKnown !== true) {
      try { await identityGuard.reportIdentityRestored({ identityOk: true }); } catch { /* ignore */ }
      lastReportedIdentityOk = true;
    }
    await flushIdentityGuardNotifications();
  }

  /**
   * task-64：手动恢复入口（供 bridge 控制台管理员端点调用）。
   * 三个前置条件全部在服务端现算，绝不从请求体读取；缺一返回 guard 的 failed 列表。
   * task-77：qqCommsOk 的口径已从「最近 10 分钟内有过成功回执」改为**现算当前连接事实**
   * （core/owner-comms-health.mjs：回执窗口 + WS 连接 + 上游自评 + 账号在线 + 事件包流动）。
   * 它回答的是「QQ 通信此刻是否可用」，**仍不等于本次通知已送达** —— 那是第三条件。
   *
   * task-75（用户规则 m13214 §4/§5）：第三条件「补报已收到发送接口成功回执」只能由
   * **同一异常事件**的真实回执满足：
   *  · 必须 notify.status==='delivered'，且 notify.operationId === anomalyId（事件绑定）；
   *  · restoreNotify 的回执**不得**替代（它是「身份已恢复」的解除通知，不是异常补报）；
   *  · 「重试耗尽」不再作为替代依据（旧 task-69 放宽已收回，违反「未知结果不能视为成功」）。
   * task-77：**删除 corruptionAck 例外**。用户规则没有给「损坏态免回执」的授权；损坏态要走
   * declareIdentityGuardCorruptionAnomaly() 先产生一条真实补报告警，拿到 delivered 回执后
   * 才能恢复（本函数因此不再从请求体读任何字段）。
   */
  async function recoverIdentityGuard() {
    if (identityGuard === null) return { ok: false, reason: 'guard-unavailable', failed: ['identity', 'qq-comms', 'report-receipt'] };
    const identity = resolveIdentity(source);
    const identityOk = identity.mode === 'mapper'
      && identity.mapperReady === true
      && identity.hasBackgroundSessionId === true
      && identity.hasOwnerQQ === true;
    let qqCommsOk = false;
    if (qqCommsProvider !== null) {
      try { qqCommsOk = qqCommsProvider() === true; } catch { qqCommsOk = false; }
    }
    const snapshot = guardSnapshot();
    const reportDelivered = snapshot !== null
      && snapshot.notify?.status === 'delivered'
      && typeof snapshot.anomalyId === 'string'
      && snapshot.notify?.operationId === snapshot.anomalyId;
    const recovered = await identityGuard.recoverManually({
      identityOk,
      qqCommsOk,
      reportDelivered,
    });
    // task-77：恢复依据必须可区分地留痕。
    //  · 'delivered'：同一异常事件收到真实发送回执（唯一合法依据）。
    // 损坏态不再有「ack 免回执」通道 —— 它必须先用 declareIdentityGuardCorruptionAnomaly()
    // 产生一条真实补报告警（operationId===anomalyId），回执送达后 basis 同样是 'delivered'。
    return recovered;
  }

  /**
   * task-77：损坏态受控补报告警（替代被删除的 corruptionAck 例外）。
   * 语义：状态文件损坏 → 从未产生过通知 → 管理员在控制台显式发起一次**真实**补报告警；
   * 它走与普通异常完全相同的发送链路与回执口径（operationId===anomalyId），失败/未知照旧升级全停，
   * 绝不伪造送达。只有这条通知真的 delivered 之后，手动恢复的第三条件才可能满足。
   */
  async function declareIdentityGuardCorruptionAnomaly({ detail = null } = {}) {
    if (identityGuard === null) return { ok: false, reason: 'guard-unavailable' };
    let declared;
    try {
      declared = await identityGuard.declareControlledRecoveryAnomaly({ detail });
    } catch {
      return { ok: false, reason: 'declare-failed' };
    }
    if (declared?.ok !== true) {
      auditGuardEvent('identity-guard-declare-corruption-rejected', 'pause', 'denied');
      return { ok: false, reason: declared?.reason ?? 'declare-failed' };
    }
    auditGuardEvent('identity-guard-declare-corruption', 'pause', 'success');
    // 立刻尝试真实发送（不等待下一轮 reconcile）：管理员点了就该看到结果。
    await flushIdentityGuardNotifications();
    const after = guardSnapshot();
    return {
      ok: true,
      operationId: declared?.notifyRequired?.operationId ?? null,
      notifyStatus: after?.notify?.status ?? null,
    };
  }

  /**
   * task-75：管理员**显式**重发补报（让真实回执可达，而不是把「耗尽」当回执）。
   * 收回 retries-exhausted 放宽后，若补报一直发不出去，恢复会永久被拒；正解是给管理员一个
   * 可点击的重发动作：每次点击 = 一次真实发送尝试，成功后 notify.status 变 delivered，
   * 第三条件因此可达。guard 侧的自动重发上限不因它被绕过（resendNotify 把 attempts 归零后
   * 仍是最多 3 次）。
   */
  async function resendIdentityGuardNotify() {
    if (identityGuard === null) return { ok: false, reason: 'guard-unavailable' };
    const snapshot = guardSnapshot();
    const operationId = snapshot?.notify?.operationId;
    if (typeof operationId !== 'string' || operationId.length === 0) {
      return { ok: false, reason: 'no-pending-notify' };
    }
    const resent = await identityGuard.resendNotify({ operationId });
    if (resent?.ok !== true) {
      auditGuardEvent('identity-guard-resend-notify-rejected', 'resume', 'denied');
      return { ok: false, reason: resent?.reason ?? 'resend-failed' };
    }
    await flushIdentityGuardNotifications();
    const after = guardSnapshot();
    const notifyStatus = after?.notify?.status ?? null;
    const delivered = notifyStatus === 'delivered';
    auditGuardEvent('identity-guard-resend-notify', 'resume', delivered ? 'success' : 'pending');
    return { ok: true, operationId, notifyStatus };
  }

  /** F4：start 失败/异常统一 close（释放 store/server）并返回 fail-closed 错误。 */
  async function failClosed(code) {
    lastError = code;
    log('error', code);
    try {
      await close();
    } catch {
      // ignore
    }
    return { ok: false, error: code };
  }

  async function start() {
    if (closed) return { ok: false, error: 'closed' };
    if (config.backgroundPatrol?.enabled !== true) return { ok: true, enabled: false };
    if (started) return { ok: true, enabled: true, url, port };
    if (startPromise !== null) return startPromise;
    // F1（独立审查）：只读开关必须是严格 boolean；非 undefined 的非布尔值（如 'yes'）
    // 若静默当 false 会造成 fail-open（写请求 allow 并 reserve）。这里直接拒绝启动。
    const rawReadOnly = config.backgroundPatrol?.readOnly;
    if (rawReadOnly !== undefined && typeof rawReadOnly !== 'boolean') {
      return failClosed('invalid-read-only');
    }
    // task-58：legacy 身份模式的可配置升级开关。legacy 是既有兼容路径（task-49 明确保留其旧行为），
    // 默认 false ⇒ 只告警不拒绝；显式 true ⇒ 非 mapper 身份直接 fail-closed。与 readOnly 同口径：
    // 非 undefined 的非布尔值不得静默当 false（否则拼错配置会悄悄降级回 fail-open）。
    const rawRequireMapperIdentity = config.backgroundPatrol?.requireMapperIdentity;
    if (rawRequireMapperIdentity !== undefined && typeof rawRequireMapperIdentity !== 'boolean') {
      return failClosed('invalid-require-mapper-identity');
    }
    const requireMapperIdentity = rawRequireMapperIdentity === true;
    // m21233：把「身份门禁不可用」做成启动期 fail-closed，而不是运行期少一层。
    // 端点不监听 ⇒ 全部小黑盒工具被拒（插件的 authorize 请求连不上），这正是期望的后果。
    // 契约放在 hook 的启动判定里（而不是只写进 bridge），任何调用方都绕不过；
    // 但只有显式 requireIdentityGuard:true 才生效，保持旧调用方零行为变化。
    if (requireIdentityGuardInvalid) return failClosed('invalid-require-identity-guard');
    if (requireIdentityGuard && identityGuard === null) return failClosed('identity-guard-unavailable');

    startPromise = (async () => {
      try {
        const token = resolveAuthorizeToken(source, config);
        if (token === null) return failClosed('missing-authorize-token');
        if (token.length < MIN_AUTHORIZE_TOKEN_LENGTH) return failClosed('weak-authorize-token');
        if (store === null) {
          const prepared = await ensureControllerStore();
          if (!prepared.ok) return failClosed(prepared.error);
        }
        await refreshControllerStatus();

        const identity = resolveIdentity(source);
        // task-62（P3-1）：身份解析结果必须在任何 failClosed 之前记录，否则严格失败后
        // status().identityMode 是 null，运维只能看到 lastError 却不知道是身份降级导致。
        identityStatus = {
          mode: identity.mode,
          hasBackgroundSessionId: identity.hasBackgroundSessionId,
          hasOwnerQQ: identity.hasOwnerQQ,
          mapperReady: identity.mapperReady,
          backgroundSessionId: identity.backgroundSessionId,
        };
        // task-64：身份异常必须先落盘到身份守卫（fail-closed 前），否则严格失败后恢复链没有
        // 稳定依据（identityOk=false 会作废迟到回执）。守卫读取失败不阻塞启动（自身状态机 fail-closed）。
        try {
          await syncIdentityGuardState(identity);
        } catch (error) {
          log('warn', 'identity-guard-sync-failed');
        }
        // task-58（task-55 复审 P3-1）：非 mapper 身份不得静默。legacy 分支不产 provenance ⇒
        // task-49 的「后台来源写一律拒绝」门禁整体失效；本文件无法凭空造 provenance（会伪造身份），
        // 所以默认只做显式告警（identity-mode-legacy）+ status().identityMode 可观测；
        // 需要严格 fail-closed 的部署可设 backgroundPatrol.requireMapperIdentity=true。
        if (identity.mode !== 'mapper') {
          // A-2：存在降级层时，legacy 身份不再「拒绝启动端点」（那会让 12 个工具全停），
          // 而是照常启动、由 bridge 在启动成功后进入「降级只读」并通知管理员 —— 用户规则①
          // 要的是「临时只读 + 明确通知」，不是整体停摆。没有降级层时保持旧的严格 fail-closed。
          if (requireMapperIdentity && degrade === null) return failClosed('identity-mode-legacy');
          log('warn', 'identity-mode-legacy');
        }
        // task-64：身份来源不可判定（classifier 返回 unknown）时向守卫报告一次（启动/状态变化有界，
        // 不是每次请求都报）；detail 只用类别，不写 QQ 号。
        const classifyAgent = identity.mode !== 'mapper'
          ? identity.classifier
          : (key) => {
            const classified = typeof identity.classifier === 'function' ? identity.classifier(key) : 'unknown';
            if (classified === 'unknown' && identityGuard !== null && !unknownSourceReported) {
              unknownSourceReported = true;
              try {
                Promise.resolve(identityGuard.reportAnomaly({ kind: 'identity-unknown-source', detail: 'unclassified-agent' }))
                  .then(() => flushIdentityGuardNotifications())
                  .catch(() => { /* ignore */ });
              } catch { /* ignore */ }
            }
            return classified;
          };
        const audit = await prepareAudit(source);
        auditEnabled = audit !== undefined;
        const readOnly = rawReadOnly === true;
        const candidate = createAuthorizeWiring({
          config: {
            backgroundPatrol: {
              enabled: true,
              ...(readOnly ? { readOnly: true } : {}),
            },
          },
          controller: controllerForApi(),
          consoleToken: token,
          ...(identity.mode === 'mapper'
            ? {
              agentKeyClassifier: classifyAgent,
              // task-49：patrol 来源的写工具在 api 可信边界被拒绝（不 reserve/commit、不签票据）。
              ...(typeof identity.provenance === 'function' ? { provenanceClassifier: identity.provenance } : {}),
            }
            : { sessionIdentity: identity.legacy }),
          persist: persistControllerState,
        writeBlocker: () => {
          if (lastReconcile === null) return { blocked: true, reason: 'reconcile-pending' };
          if (unconfirmedWrite.known !== true) return { blocked: true, reason: 'unconfirmed-query-failed' };
          if (unconfirmedWrite.pendingWrites > 0) {
            return { blocked: true, reason: 'unconfirmed-write' };
          }
          if (persistFailureLatched || migrationPersistPending) return { blocked: true, reason: 'persist-failed' };
          if (pendingEnqueueFailures.size > 0) return { blocked: true, reason: 'notify-enqueue-failed' };
          return { blocked: false };
        },
          ...(audit === undefined ? {} : { audit }),
          ...(identityGuard === null ? {} : { guard: identityGuard }),
          ...(credentialNotify === null ? {} : { credentialNotify }),
          ...(degrade === null ? {} : { degrade }),
          ...(consoleSettings === null ? {} : { consoleSettings }),
          ...(source.host === undefined ? {} : { host: source.host }),
          ...(source.port === undefined ? {} : { port: source.port }),
        });
        const result = await candidate.start();
        if (!result.ok || result.enabled === false) {
          return failClosed(result.error ?? result.reason ?? 'start-failed');
        }
        wiring = candidate;
        started = true;
        url = result.url;
        port = result.port;
        lastError = null;
        await refreshUnconfirmedWrites();
        // F5 / task-78：端点可启动但语义不完整时必须明确告警（不得伪造 backgroundSessionId）。
        if (identity.mode === 'mapper') {
          if (identity.hasBackgroundSessionId !== true || identity.mapperReady !== true) log('warn', 'no-session-identity');
          if (identity.hasOwnerQQ !== true) log('warn', 'no-owner-qq');
        } else if (identity.legacy.backgroundSessionKeys.length === 0) {
          log('warn', 'no-session-identity');
        }
        if (audit === undefined) log('warn', 'audit-disabled');
        return { ok: true, enabled: true, url, port };
      } catch {
        return failClosed('start-failed');
      }
    })().finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  async function stop() {
    if (wiring === null) {
      await saveBestEffort();
      return { stopped: false };
    }
    const target = wiring;
    const result = await target.stop();
    if (target === wiring) {
      wiring = null;
      started = false;
      url = null;
      port = null;
    }
    await saveBestEffort();
    return result;
  }

  async function close() {
    await stop();
    if (store !== null) {
      try {
        await store.save();
      } catch {
        // ignore
      }
      try {
        await store.close?.();
      } catch {
        // ignore
      }
      store = null;
    }
    closed = true;
    return { ok: true };
  }

  function status() {
    return {
      version: BACKGROUND_PATROL_BRIDGE_HOOK_VERSION,
      enabled: config.backgroundPatrol?.enabled === true,
      started,
      url,
      port,
      lastError,
      closed,
      ownerQQ: typeof source.ownerQQ === 'number' ? source.ownerQQ : null,
      identityMode: identityStatus === null ? null : identityStatus.mode,
      hasBackgroundSessionId: identityStatus === null ? null : identityStatus.hasBackgroundSessionId,
      hasOwnerQQ: identityStatus === null ? null : identityStatus.hasOwnerQQ,
      auditEnabled,
      // task-132：最近一次对账结果（blocked/未确认写/迁移/投递统计），供桥接侧门禁与告警。
      lastReconcile: lastReconcile === null ? null : { ...lastReconcile, failures: lastReconcile.failures.map((item) => ({ ...item })) },
      // B3：同步缓存字段；reserve 后需 await statusAsync() 刷新（reserve 不触发 persist）。
      reserved: controllerStatus === null ? null : { ...controllerStatus.reserved },
      used: controllerStatus === null ? null : { ...controllerStatus.used },
      reservedRead: controllerStatus?.reserved?.read ?? null,
      reservedWrite: controllerStatus?.reserved?.write ?? null,
      readUsed: controllerStatus?.used?.read ?? null,
      postUsed: controllerStatus?.used?.post ?? null,
      commentUsed: controllerStatus?.used?.comment ?? null,
    };
  }

  /**
   * task-132：启动/周期对账（只读 + 幂等补投递，不自动解除暂停）。
   *
   * 由 bridge 在启动后与固定周期调用，传入：
   *  · enqueue(event, reason, meta) —— 通知队列入队（失败不抛，返回 {ok:false,reason}）；
   *  · isDelivered(event, operationId) —— 独立送达账本查询（返回 {delivered:boolean}）。
   *
   * 契约：
   *  · 先给旧状态补 legacy 转换 id 并落盘；落盘失败 → blocked=true（fail-closed）。
   *  · 暂停事件按稳定 id 补投；已送达（账本命中）则跳过，重复调用不重复投递。
   *  · 恢复事件只在「当前未暂停 + 有恢复 id + 未送达」时补投，绝不把 allow/success 当恢复。
   *  · 未完成写（pending）阻断；已计额 unknown 保留记录和防重放，不阻断新操作。
   *  · 本方法**不修改暂停状态**，恢复只由管理员显式操作触发。
   */
  // task-132 终审 blocking：迁移落盘待重试、入队失败粘性（直到同一 operationId 成功入队）。
  let migrationPersistPending = false;
  // reload 分叉部署阻断：reload 会替换 controller 实例，旧实例的票据/未确认写快照全部作废。
  let controllerReloadCount = 0;

  // store 写失败后进入 degraded（拒绝后续 save），必须先 reload 再从磁盘状态重做；
  // 对账层把「保存失败」记为待重试，而不是假装已落盘。
  async function persistWithRecovery() {
    try {
      await persistControllerState();
      return { failure: null, reloaded: false };
    } catch (error) {
      let reloaded = false;
      if (store !== null && typeof store.reload === 'function') {
        try {
          await store.reload();
          reloaded = true;
        } catch {
          // reload 失败保持 degraded；下次对账继续尝试。
        }
      }
      if (reloaded) {
        // reload 后：旧 controller 的票据在新实例上必为 invalid-ticket（实例命名空间）；
        // 未确认写事实也一律作废——在 reconcile 用新实例重建之前，写门禁必须 fail-closed
        // （lastReconcile=null → reconcile-pending；unconfirmedWrite unknown → query-failed）。
        controllerReloadCount += 1;
        lastReconcile = null;
        unconfirmedWrite = { known: false, pendingWrites: 0, unknownWrites: 0, reason: 'unconfirmed-query-failed' };
        await refreshControllerStatus();
      }
      return { failure: error?.code ?? 'WRITE_FAILED', reloaded };
    }
  }
  const pendingEnqueueFailures = new Map();

  async function reconcileInternal(callbacks = {}) {
    if (!started || store === null) return { ok: false, reason: 'not-started' };
    const enqueue = typeof callbacks.enqueue === 'function' ? callbacks.enqueue : null;
    const isDelivered = typeof callbacks.isDelivered === 'function' ? callbacks.isDelivered : null;
    if (enqueue === null || isDelivered === null) return { ok: false, reason: 'invalid-callbacks' };
    let ids = null;
    let persisted = true;
    let persistError = null;
    // store 在写失败后会降级；若 reload 成功则用磁盘状态重做一次迁移+落盘（最多两轮）。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        ids = await store.controller.ensureTransitionIds();
      } catch {
        return { ok: false, reason: 'controller-unavailable' };
      }
      if (!isPlainObject(ids) || ids.ok !== true) return { ok: false, reason: 'controller-unavailable' };
      if (ids.migrated === true) migrationPersistPending = true;
      if (!migrationPersistPending) break;
      const outcome = await persistWithRecovery();
      if (outcome.failure === null) {
        migrationPersistPending = false;
        persisted = true;
        persistError = null;
        break;
      }
      persisted = false;
      persistError = outcome.failure;
      if (outcome.reloaded === true && attempt === 0) continue;
      break;
    }
    let snapshot;
    try {
      snapshot = await store.controller.status();
    } catch {
      return { ok: false, reason: 'controller-unavailable' };
    }
    if (!isPlainObject(snapshot)) return { ok: false, reason: 'controller-unavailable' };
    const pending = Array.isArray(snapshot.pending) ? snapshot.pending : [];
    const unknown = Array.isArray(snapshot.unknown) ? snapshot.unknown : [];
    const pendingWrites = pending.filter((op) => isPlainObject(op) && op.kind !== 'read').length;
    const unknownWrites = unknown.filter((op) => isPlainObject(op) && op.kind !== 'read').length;
    const at = Date.now();
    // task-132 终审 blocking：desired 来自 controller 的转换事件列表，而不是「当前 active pause」。
    // 这样 adminRecover 之后暂停事件不会丢，同一类的新暂停也不会覆盖旧事件。
    const events = Array.isArray(snapshot.transitionEvents) ? snapshot.transitionEvents : [];
    const desired = [];
    for (const item of events) {
      if (!isPlainObject(item) || typeof item.operationId !== 'string' || item.operationId === '') continue;
      if (item.event === 'write-paused' || item.event === 'access-paused' || item.event === 'recovered') {
        desired.push({ event: item.event, reason: item.event === 'recovered' ? 'admin-recover' : (typeof item.reason === 'string' && item.reason !== '' ? item.reason : item.event), operationId: item.operationId });
      }
    }
    if (desired.length === 0) {
      // 兼容旧状态/fake controller：没有转换事件时退化为「当前 active pause + lastRecover」，但只作兜底。
      if (snapshot.writePaused === true && typeof snapshot.writePauseEventId === 'string' && snapshot.writePauseEventId !== '') {
        desired.push({ event: 'write-paused', reason: 'write-paused', operationId: snapshot.writePauseEventId });
      }
      if (snapshot.accessPaused === true && typeof snapshot.accessPauseEventId === 'string' && snapshot.accessPauseEventId !== '') {
        desired.push({ event: 'access-paused', reason: typeof snapshot.accessReason === 'string' && snapshot.accessReason !== '' ? snapshot.accessReason : 'access-paused', operationId: snapshot.accessPauseEventId });
      }
      if (snapshot.writePaused !== true && snapshot.accessPaused !== true && typeof snapshot.lastRecoverEventId === 'string' && snapshot.lastRecoverEventId !== '') {
        desired.push({ event: 'recovered', reason: 'admin-recover', operationId: snapshot.lastRecoverEventId });
      }
    }
    // 终审②：事件列表容量溢出后可能缺当前 active pause id，兜底按 controller 当前事实补投。
    if (snapshot.writePaused === true && typeof snapshot.writePauseEventId === 'string' && snapshot.writePauseEventId !== ''
      && !desired.some((entry) => entry.operationId === snapshot.writePauseEventId)) {
      desired.push({ event: 'write-paused', reason: 'write-paused', operationId: snapshot.writePauseEventId });
    }
    if (snapshot.accessPaused === true && typeof snapshot.accessPauseEventId === 'string' && snapshot.accessPauseEventId !== ''
      && !desired.some((entry) => entry.operationId === snapshot.accessPauseEventId)) {
      desired.push({
        event: 'access-paused',
        reason: typeof snapshot.accessReason === 'string' && snapshot.accessReason !== '' ? snapshot.accessReason : 'access-paused',
        operationId: snapshot.accessPauseEventId,
      });
    }
    if (snapshot.writePaused !== true && snapshot.accessPaused !== true
      && typeof snapshot.lastRecoverEventId === 'string' && snapshot.lastRecoverEventId !== ''
      && !desired.some((entry) => entry.operationId === snapshot.lastRecoverEventId)) {
      desired.push({ event: 'recovered', reason: 'admin-recover', operationId: snapshot.lastRecoverEventId });
    }
    const enqueued = [];
    const skipped = [];
    const duplicates = [];
    const failures = [];
    let deliveredQueryFailed = false;
    for (const item of desired) {
      let deliveredBefore = false;
      try {
        const seen = await isDelivered(item.event, item.operationId);
        if (!isPlainObject(seen) || seen.ok === false) {
          deliveredQueryFailed = true;
          continue;
        }
        deliveredBefore = seen.delivered === true;
      } catch {
        deliveredQueryFailed = true;
        continue;
      }
      if (deliveredBefore) {
        skipped.push(item);
        continue;
      }
      let result;
      try {
        result = await enqueue(item.event, item.reason, { platform: 'xiaoheihe', operationId: item.operationId });
      } catch {
        result = { ok: false, reason: 'enqueue-failed' };
      }
      if (isPlainObject(result) && result.ok === true) {
        pendingEnqueueFailures.delete(item.operationId);
        if (result.duplicate === true) duplicates.push(item);
        else enqueued.push(item);
      } else {
        const reason = isPlainObject(result) && typeof result.reason === 'string' ? result.reason : 'enqueue-failed';
        failures.push({ ...item, reason });
        pendingEnqueueFailures.set(item.operationId, { reason, at });
      }
    }
    // 终审②：账本命中即「已送达」的稳定证明；只有这种事件才允许被容量回收。
    if (skipped.length > 0 && typeof store.controller.markTransitionDelivered === 'function') {
      try {
        await store.controller.markTransitionDelivered({ operationIds: skipped.map((item) => item.operationId) });
      } catch {
        // 回写失败保留事件，下次对账重试；不影响本次投递结果。
      }
    }
    persistFailureLatched = !persisted;
    const blockReasons = [];
    if (!persisted) blockReasons.push('persist-failed');
    if (pendingWrites > 0) blockReasons.push('unconfirmed-write-pending');
    if (deliveredQueryFailed) blockReasons.push('delivered-query-failed');
    if (pendingEnqueueFailures.size > 0) blockReasons.push('notify-enqueue-failed');
    lastReconcile = {
      ok: true,
      at,
      blocked: blockReasons.length > 0,
      blockReasons,
      migrated: ids.migrated === true,
      persisted,
      persistError,
      pendingWriteCount: pendingWrites,
      unknownWriteCount: unknownWrites,
      desiredCount: desired.length,
      enqueued: enqueued.length,
      delivered: skipped.length,
      skipped: skipped.length,
      duplicates: duplicates.length,
      failures: failures.map((item) => ({ event: item.event, operationId: item.operationId, reason: item.reason })),
      writePaused: snapshot.writePaused === true,
      accessPaused: snapshot.accessPaused === true,
      writePauseEventId: snapshot.writePauseEventId ?? null,
      accessPauseEventId: snapshot.accessPauseEventId ?? null,
      lastRecoverEventId: snapshot.lastRecoverEventId ?? null,
      transitionEventOverflow: snapshot.transitionEventOverflow ?? 0,
      controllerReloads: controllerReloadCount,
    };
    await refreshUnconfirmedWrites();
    await refreshControllerStatus();
    // task-64：对账 tick 顺带同步身份守卫（超时判定 + 待发通知补发 + 身份恢复检测）；
    // 守卫异常不得让对账失败（内部已 try/catch，仍兜底）。
    try {
      await syncIdentityGuardState(resolveIdentity(source));
    } catch {
      log('warn', 'identity-guard-sync-failed');
    }
    return { ...lastReconcile };
  }
  /** 异步刷新后的完整 status（含 controller 原始快照）。 */
  async function statusAsync() {
    await refreshControllerStatus();
    let controllerStore = null;
    if (store !== null) {
      try {
        const view = await store.status();
        const safe = (v) => typeof v === 'string' && /^[A-Z0-9_-]{1,64}$/.test(v) ? v : null;
        controllerStore = {
          loaded: view.loaded === true,
          degraded: view.degraded === true,
          closed: view.closed === true,
          lastError: view.lastError ? { code: safe(view.lastError.code), causeCode: safe(view.lastError.causeCode) } : null,
        };
      } catch { /* 状态不可用时明确返回 null。 */ }
    }
    return {
      ...status(),
      controller: store === null ? null : await store.controller.status(),
      controllerStore,
    };
  }

  /**
   * 把控制台配置里的每日额度上限应用到当前 controller（保存后调用，立即生效）。
   * 只改上限，不动已用次数/间隔/暂停；调用失败返回 {ok:false}，由调用方如实上报。
   */
  async function applyConsoleSettings() {
    if (consoleSettings === null) return { ok: false, reason: 'console-settings-not-injected' };
    if (store === null) return { ok: false, reason: 'controller-unavailable' };
    let snapshot = null;
    try { snapshot = consoleSettings(); } catch { snapshot = null; }
    const quota = isPlainObject(snapshot?.quota) ? snapshot.quota : null;
    if (quota === null) return { ok: false, reason: 'invalid-console-settings' };
    try {
      const result = await store.controller.setDailyLimits({ read: quota.browse, post: quota.post, comment: quota.comment });
      return result?.ok === true ? { ok: true, limits: result.limits } : { ok: false, reason: result?.reason ?? 'invalid-limits' };
    } catch {
      return { ok: false, reason: 'controller-unavailable' };
    }
  }

  /**
   * 控制台「重置额度」：清指定作用域已用次数并落盘；不清间隔/暂停/失败链。
   * 失败时如实返回，由调用方决定是否继续后续步骤（任务卡：一步失败立即停止）。
   */
  async function resetDailyCounts(scope) {
    if (store === null) return { ok: false, reason: 'controller-unavailable' };
    let result;
    try {
      result = await store.controller.resetDailyCounts({ scope });
    } catch {
      return { ok: false, reason: 'controller-unavailable' };
    }
    if (result?.ok !== true) return { ok: false, reason: result?.reason ?? 'reset-failed' };
    const persisted = await persistControllerState();
    if (persisted !== true && persisted?.ok !== true) return { ok: false, reason: 'persist-failed' };
    return { ok: true, scope: result.scope, reset: result.reset };
  }

  /**
   * 控制台「恢复」：scope='write' 只解写暂停、scope='access' 只解全部访问暂停。
   * 恢复不重置额度/间隔；本来没暂停时按「无操作」返回 ok（任务卡明确不算失败）。
   */
  async function recoverColumnScope(scope) {
    if (store === null) return { ok: false, reason: 'controller-unavailable' };
    if (!['write', 'access'].includes(scope)) return { ok: false, reason: 'invalid-scope' };
    let result;
    try {
      result = await store.controller.adminRecover({ verifiedAdminFrom: 'console', scope });
    } catch {
      return { ok: false, reason: 'controller-unavailable' };
    }
    if (result?.ok !== true) return { ok: false, reason: result?.reason ?? 'recover-failed' };
    if (result.wasPaused !== true) {
      return { ok: true, scope, wasPaused: false, writePaused: result.writePaused === true, accessPaused: result.accessPaused === true };
    }
    const persisted = await persistControllerState();
    if (persisted !== true && persisted?.ok !== true) return { ok: false, reason: 'persist-failed' };
    return {
      ok: true, scope, wasPaused: result.wasPaused === true,
      writePaused: result.writePaused === true, accessPaused: result.accessPaused === true,
    };
  }

  return {
    start, stop, status, statusAsync, reconcile: reconcileInternal, close, applyConsoleSettings,
    resetDailyCounts, recoverColumnScope,
    guardSnapshot, flushIdentityGuardNotifications, recoverIdentityGuard, resendIdentityGuardNotify,
    // task-77：损坏态受控补报告警（替代被删除的 corruptionAck 例外）。
    declareIdentityGuardCorruptionAnomaly,
  };
}
