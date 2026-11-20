// 小黑盒专栏独立密码：认证核心模块（task-86）。
//
// 契约来源：docs/superpowers/plans/2026-10-30-console-column-password-spec.md
//   §3.1 导出面 / §3.5 fail-closed 清单。
// 用户裁定（m19958）：独立专栏密码，防止智能体自行修改敏感权限；忘记密码必须先在
// 控制台暂停整个智能体后再重设，重设不额外要求人为验证。
//
// 设计要点（与规格逐条对应）：
// · 小黑盒存储 state/xiaoheihe-console-column-auth.json，QQ 空间使用独立固定文件名；
//   写入时传 mode 0o600 + 临时文件 + rename 原子写；
//   只存 scrypt 哈希 + 16B 盐，不存明文密码。
//   ⚠️ Windows 上 `mode: 0o600` 是**空操作**（实测 stat.mode 恒为 666，chmod 不改 ACL）——
//   本机「auth 文件仅本人可读」实际由 **state/ 目录的 ACL** 兜住（`src/state-acl.mjs`
//   hardenDir：只保留当前用户 + SYSTEM + Administrators）。若 state/ 的 ACL 收紧失败
//   （需管理员），同一台机器上其它已登录用户可读走派生哈希并离线爆破口令——该风险由
//   bridge 启动时的 ACL 收紧与「访问与安全」页的重试按钮承担，本模块不重复实现
//   （task-89 P3-2：不要在 POSIX 之外假装 0600 有效）。
// · 失败锁定：每累计 5 次失败升一档（60s → 300s → 900s 封顶），锁定写文件（重启不清零）；
//   锁定期内即使密码正确也拒绝。
// · 会话：模块级 Map（进程内，重启即失效），空闲 15 分钟 / 绝对 2 小时过期；token 为
//   32B 随机值（base64url）。
// · fail-closed：文件缺失 = unset（不等于放行）；文件损坏 / 算法未知 / 长度非法 =
//   untrusted，绝不当作无密码，只能走 forgotResetPassword；落盘失败一律 persist-failed，
//   绝不因为「内存里算好了」就报告成功（本模块本身无内存缓存，读盘为准）。
// · untrusted 下 forgotResetPassword 可以成功 —— 这是**已知且被用户接受的**绕过路径
//   （规格 §2.5 第 2 条：有 consoleToken 者可破坏文件后重设），不是遗漏，下位复审不要
//   当 P1 重报。本模块不提供任何「untrusted → 自动放行」的路径，只提供这条显式重设通道。
// · agentPaused !== true 时 setPassword / forgotResetPassword 不触碰磁盘，返回
//   agent-not-paused（规格 §3.5）。模块**不读 config、不假设两个动作门槛相同**：
//   setPassword 的布尔由调用方传「巡逻是否暂停」，forgotResetPassword 传「两项是否都暂停」，
//   模块只认传入的布尔（规格 §2.2 两个门槛不同，接线见 bridge）。
// · 密码 / 哈希 / 盐 / 会话 token 不出现在日志、异常 message、返回值（本模块不写日志；
//   错误只返回固定 reason 字符串，不携带任何输入或文件路径）。
//
// 与规格的两处补充（均为防御性，不改变既有语义）：
// 1. password 非字符串时返回 reason 'invalid-password'（规格 reason 表未列，但至少必须有
//    一个明确的拒绝原因，且不写入文件）。
// 2. `fsOps` 是仅用于测试的注入缝（默认使用 node:fs），让「落盘失败」用例可确定性复现；
//    生产调用不传该参数。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_NAMESPACE = 'xiaoheihe';
const AUTH_FILE_NAMES = Object.freeze({
  [DEFAULT_NAMESPACE]: 'xiaoheihe-console-column-auth.json',
  qqspace: 'qqspace-console-column-auth.json',
});
const SCHEMA_VERSION = 1;
const ALGORITHM = 'scrypt';
const PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32 });
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const MIN_PASSWORD_CHARS = 10;
const ATTEMPTS_PER_TIER = 5;
const LOCK_TIERS_MS = Object.freeze([60 * 1000, 300 * 1000, 900 * 1000]);
const SESSION_IDLE_MS = 15 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 2 * 60 * 60 * 1000;
// Fixed namespaces select only hard-coded basenames; external values never form paths.
const ALLOWED_NAMESPACES = new Set(Object.keys(AUTH_FILE_NAMES));

// 进程内会话（重启即失效；按用户裁定，不在磁盘上写任何会话材料）。
const sessions = new Map();

const DEFAULT_FS_OPS = Object.freeze({
  mkdirSync: (...args) => fs.mkdirSync(...args),
  writeFileSync: (...args) => fs.writeFileSync(...args),
  renameSync: (...args) => fs.renameSync(...args),
  unlinkSync: (...args) => fs.unlinkSync(...args),
});

function currentTime(now) {
  return Number.isFinite(now) ? now : Date.now();
}

function resolveNamespace(namespace) {
  const resolved = namespace === undefined ? DEFAULT_NAMESPACE : namespace;
  return ALLOWED_NAMESPACES.has(resolved) ? resolved : null;
}

function authFilePath(stateDir, namespace) {
  return path.join(stateDir, AUTH_FILE_NAMES[namespace]);
}

function decodeBase64Exact(value, expectedBytes) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length !== expectedBytes) return null;
  return buffer;
}

// 校验落盘结构；任何一项不合法都返回 null（调用方按 untrusted 处理，绝不降级为 unset）。
function validateStoredState(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
  if (parsed.algorithm !== ALGORITHM) return null;
  const params = parsed.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return null;
  if (
    params.N !== PARAMS.N ||
    params.r !== PARAMS.r ||
    params.p !== PARAMS.p ||
    params.keylen !== PARAMS.keylen
  ) {
    return null;
  }
  const salt = decodeBase64Exact(parsed.salt, SALT_BYTES);
  const hash = decodeBase64Exact(parsed.hash, HASH_BYTES);
  if (salt === null || hash === null) return null;
  if (!Number.isFinite(parsed.passwordUpdatedAt)) return null;
  if (!Number.isInteger(parsed.failedAttempts) || parsed.failedAttempts < 0) return null;
  if (parsed.lockedUntil !== null && !Number.isFinite(parsed.lockedUntil)) return null;
  if (parsed.lastFailedAt !== null && !Number.isFinite(parsed.lastFailedAt)) return null;
  return { salt, hash };
}

function readStoredState(stateDir, namespace) {
  let raw;
  try {
    raw = fs.readFileSync(authFilePath(stateDir, namespace));
  } catch (error) {
    if (error && error.code === 'ENOENT') return { kind: 'unset' };
    // 其它读错误（权限、EISDIR、目录不可用…）一律 fail-closed，不得当成 unset。
    return { kind: 'untrusted' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { kind: 'untrusted' };
  }
  const checked = validateStoredState(parsed);
  if (checked === null) return { kind: 'untrusted' };
  return { kind: 'valid', state: parsed, salt: checked.salt, hash: checked.hash };
}

function persistState(stateDir, state, fsOps, namespace) {
  const ops = fsOps ?? DEFAULT_FS_OPS;
  const filePath = authFilePath(stateDir, namespace);
  const tmpPath = `${filePath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    ops.mkdirSync(stateDir, { recursive: true });
    ops.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    ops.renameSync(tmpPath, filePath);
    return { ok: true };
  } catch {
    try {
      ops.unlinkSync(tmpPath);
    } catch {
      // 清理失败不改变结论：落盘失败就是落盘失败。
    }
    return { ok: false, reason: 'persist-failed' };
  }
}

function hashPassword(password, salt) {
  try {
    return crypto.scryptSync(password, salt, PARAMS.keylen, {
      N: PARAMS.N,
      r: PARAMS.r,
      p: PARAMS.p,
      maxmem: 96 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function matchesPassword(password, salt, expectedHash) {
  const actual = hashPassword(password, salt);
  if (actual === null) return false;
  if (actual.length !== expectedHash.length) return false;
  return crypto.timingSafeEqual(actual, expectedHash);
}

// 每累计 5 次失败升一档；只有恰好达到 5 的倍数时才加锁（6..9 次仍只累计）。
function lockDurationMs(failedAttempts) {
  if (failedAttempts < ATTEMPTS_PER_TIER) return 0;
  if (failedAttempts % ATTEMPTS_PER_TIER !== 0) return 0;
  const tierIndex = Math.min(failedAttempts / ATTEMPTS_PER_TIER - 1, LOCK_TIERS_MS.length - 1);
  return LOCK_TIERS_MS[tierIndex];
}

function lockedSecondsUntil(lockedUntil, current) {
  return Math.max(1, Math.ceil((lockedUntil - current) / 1000));
}

function validateNewPassword(password, consoleToken) {
  if (typeof password !== 'string') return { ok: false, reason: 'invalid-password' };
  if ([...password].length < MIN_PASSWORD_CHARS) return { ok: false, reason: 'password-too-short' };
  if (typeof consoleToken === 'string' && consoleToken.length > 0 && password === consoleToken) {
    return { ok: false, reason: 'password-equals-console-token' };
  }
  return null;
}

function createSession(current, namespace) {
  const token = crypto.randomBytes(32).toString('base64url');
  const sessionId = crypto.randomUUID();
  sessions.set(token, {
    namespace,
    sessionId,
    createdAt: current,
    lastSeenAt: current,
    absoluteExpiresAt: current + SESSION_ABSOLUTE_MS,
  });
  return { token, sessionId, expiresAt: current + SESSION_ABSOLUTE_MS };
}

function buildStoredState(password, passwordUpdatedAt) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = hashPassword(password, salt);
  if (hash === null) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    algorithm: ALGORITHM,
    params: { ...PARAMS },
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    passwordUpdatedAt,
    failedAttempts: 0,
    lockedUntil: null,
    lastFailedAt: null,
  };
}

/**
 * 当前密码状态。
 *
 * 额外字段（规格澄清 m02715，属「只增不改」）：`passwordSetAt`（= 存储里的
 * passwordUpdatedAt，毫秒时间戳或 null）与 `lockedUntil`（绝对的毫秒时间戳或 null）。
 * bridge 需要它们把绝对时间如实回报给 UI 并每秒重算倒计时；`lockedSeconds` 保留为
 * 服务端算好的相对差值，两者自洽（lockedSeconds = ceil((lockedUntil - now)/1000)）。
 * untrusted / unset 也返回这两个字段（null），保证形状稳定、且本函数在 untrusted 下不抛异常。
 * @returns {{state:'unset'|'set'|'locked'|'untrusted', lockedSeconds:number, failedAttempts:number,
 *   passwordSetAt:number|null, lockedUntil:number|null}}
 */
export function getAuthStatus({ stateDir, now, namespace } = {}) {
  const resolvedNamespace = resolveNamespace(namespace);
  if (resolvedNamespace === null) {
    return { state: 'untrusted', lockedSeconds: 0, failedAttempts: 0, passwordSetAt: null, lockedUntil: null };
  }
  const current = currentTime(now);
  const stored = readStoredState(stateDir, resolvedNamespace);
  if (stored.kind === 'unset') {
    return { state: 'unset', lockedSeconds: 0, failedAttempts: 0, passwordSetAt: null, lockedUntil: null };
  }
  if (stored.kind === 'untrusted') {
    // untrusted 仍然返回（不抛异常）：UI 需要如实显示「锁定，只能忘记重设」。
    return { state: 'untrusted', lockedSeconds: 0, failedAttempts: 0, passwordSetAt: null, lockedUntil: null };
  }
  const { state } = stored;
  const passwordSetAt = typeof state.passwordUpdatedAt === 'number' ? state.passwordUpdatedAt : null;
  if (typeof state.lockedUntil === 'number' && state.lockedUntil > current) {
    return {
      state: 'locked',
      lockedSeconds: lockedSecondsUntil(state.lockedUntil, current),
      failedAttempts: state.failedAttempts,
      passwordSetAt,
      lockedUntil: state.lockedUntil,
    };
  }
  return { state: 'set', lockedSeconds: 0, failedAttempts: state.failedAttempts, passwordSetAt, lockedUntil: null };
}

/**
 * 首次设置密码（已设置过、未暂停、untrusted 都拒绝）。
 * @returns {{ok:true}|{ok:false,reason:'already-set'|'agent-not-paused'|'password-too-short'|
 *   'password-equals-console-token'|'state-untrusted'|'invalid-password'|'persist-failed'}}
 */
export function setPassword({ stateDir, password, consoleToken, agentPaused, now, fsOps, namespace } = {}) {
  const resolvedNamespace = resolveNamespace(namespace);
  if (resolvedNamespace === null) return { ok: false, reason: 'invalid-namespace' };
  const current = currentTime(now);
  if (agentPaused !== true) return { ok: false, reason: 'agent-not-paused' };
  const invalid = validateNewPassword(password, consoleToken);
  if (invalid !== null) return invalid;

  const stored = readStoredState(stateDir, resolvedNamespace);
  if (stored.kind === 'untrusted') return { ok: false, reason: 'state-untrusted' };
  if (stored.kind === 'valid') return { ok: false, reason: 'already-set' };

  const state = buildStoredState(password, current);
  if (state === null) return { ok: false, reason: 'persist-failed' };
  const persisted = persistState(stateDir, state, fsOps, resolvedNamespace);
  if (!persisted.ok) return persisted;
  return { ok: true };
}

/**
 * 校验密码；成功签发进程内会话（32B token，绝对 2 小时过期）。
 * @returns {{ok:true, sessionToken:string, expiresAt:number}|
 *   {ok:false, reason:'unset'|'untrusted'|'locked'|'wrong-password'|'invalid-password'|'persist-failed',
 *    failedAttempts:number, lockedSeconds:number}}
 */
export function verifyPassword({ stateDir, password, now, fsOps, namespace } = {}) {
  const resolvedNamespace = resolveNamespace(namespace);
  if (resolvedNamespace === null) {
    return { ok: false, reason: 'invalid-namespace', failedAttempts: 0, lockedSeconds: 0 };
  }
  const current = currentTime(now);
  const stored = readStoredState(stateDir, resolvedNamespace);
  if (stored.kind === 'unset') return { ok: false, reason: 'unset', failedAttempts: 0, lockedSeconds: 0 };
  if (stored.kind === 'untrusted') return { ok: false, reason: 'untrusted', failedAttempts: 0, lockedSeconds: 0 };

  const { state } = stored;
  if (typeof state.lockedUntil === 'number' && state.lockedUntil > current) {
    return {
      ok: false,
      reason: 'locked',
      failedAttempts: state.failedAttempts,
      lockedSeconds: lockedSecondsUntil(state.lockedUntil, current),
    };
  }
  if (typeof password !== 'string') {
    // 非字符串不是一次「密码猜测」，不计入失败次数（防止构造请求把账户灌锁）。
    return { ok: false, reason: 'invalid-password', failedAttempts: state.failedAttempts, lockedSeconds: 0 };
  }

  if (matchesPassword(password, stored.salt, stored.hash)) {
    const cleared = { ...state, failedAttempts: 0, lockedUntil: null };
    const persisted = persistState(stateDir, cleared, fsOps, resolvedNamespace);
    if (!persisted.ok) {
      // 连「清零计数」都写不进时 fail-closed：不发会话（本模块无内存态可被误用）。
      return { ok: false, reason: 'persist-failed', failedAttempts: state.failedAttempts, lockedSeconds: 0 };
    }
    const session = createSession(current, resolvedNamespace);
    return { ok: true, sessionToken: session.token, expiresAt: session.expiresAt };
  }

  const failedAttempts = state.failedAttempts + 1;
  const lockMs = lockDurationMs(failedAttempts);
  const next = {
    ...state,
    failedAttempts,
    lastFailedAt: current,
    lockedUntil: lockMs > 0 ? current + lockMs : state.lockedUntil,
  };
  const persisted = persistState(stateDir, next, fsOps, resolvedNamespace);
  if (!persisted.ok) return { ok: false, reason: 'persist-failed', failedAttempts: state.failedAttempts, lockedSeconds: 0 };
  if (lockMs > 0) return { ok: false, reason: 'locked', failedAttempts, lockedSeconds: Math.ceil(lockMs / 1000) };
  return { ok: false, reason: 'wrong-password', failedAttempts, lockedSeconds: 0 };
}

/**
 * 校验专栏会话：空闲 15 分钟 / 绝对 2 小时过期；过期即删除。
 *
 * task-89 P2-1：除了 `sessionId`，同时返回**本次校验之后**的到期时刻 `expiresAt`，
 * 取「绝对到期」与「本次已续期后的空闲到期」的较小者——只读控制台要显示「剩余 N 分钟」，
 * 否则 UI 只能把 `expiresAt` 恒写成 null、自己猜一个倒计时（task-87 交付时就是这个妥协）。
 * 注意：本次调用已经把 lastSeenAt 续到 current，所以空闲到期必然是 `current + SESSION_IDLE_MS`。
 * @returns {{ok:true,sessionId:string,expiresAt:number}|{ok:false,reason:'unknown-session'|'expired'}}
 */
export function verifySession({ sessionToken, now, namespace } = {}) {
  const resolvedNamespace = resolveNamespace(namespace);
  if (resolvedNamespace === null) return { ok: false, reason: 'unknown-session' };
  const current = currentTime(now);
  if (typeof sessionToken !== 'string' || sessionToken.length === 0) {
    return { ok: false, reason: 'unknown-session' };
  }
  const session = sessions.get(sessionToken);
  if (session === undefined) return { ok: false, reason: 'unknown-session' };
  if (session.namespace !== resolvedNamespace) return { ok: false, reason: 'unknown-session' };
  if (current >= session.absoluteExpiresAt || current - session.lastSeenAt >= SESSION_IDLE_MS) {
    sessions.delete(sessionToken);
    return { ok: false, reason: 'expired' };
  }
  session.lastSeenAt = current;
  return {
    ok: true,
    sessionId: session.sessionId,
    expiresAt: Math.min(session.absoluteExpiresAt, current + SESSION_IDLE_MS),
  };
}

/** 注销单个会话（退出专栏）。 */
export function revokeSession(sessionToken, { namespace } = {}) {
  const resolvedNamespace = resolveNamespace(namespace);
  const session = typeof sessionToken === 'string' ? sessions.get(sessionToken) : undefined;
  const revoked = resolvedNamespace !== null && session?.namespace === resolvedNamespace
    ? sessions.delete(sessionToken)
    : false;
  return { ok: true, revoked };
}

/** 注销指定命名空间的全部会话（忘记重设成功后自动调用）。 */
export function revokeAllSessions({ namespace } = {}) {
  const resolvedNamespace = resolveNamespace(namespace);
  if (resolvedNamespace === null) return { ok: true, revoked: 0 };
  let revoked = 0;
  for (const [token, session] of sessions) {
    if (session.namespace === resolvedNamespace) {
      sessions.delete(token);
      revoked += 1;
    }
  }
  return { ok: true, revoked };
}

/**
 * 忘记密码重设：仅当整个智能体已暂停（agentPaused === true）且新密码合规；
 * 允许覆盖已存在或被判定 untrusted/损坏的文件；成功后废除全部会话。
 * 不引入额外人为验证（用户裁定 m19958）。
 * @returns {{ok:true}|{ok:false,reason: 'agent-not-paused'|'password-too-short'|
 *   'password-equals-console-token'|'invalid-password'|'persist-failed'}}
 */
export function forgotResetPassword({ stateDir, password, consoleToken, agentPaused, now, fsOps, namespace } = {}) {
  const resolvedNamespace = resolveNamespace(namespace);
  if (resolvedNamespace === null) return { ok: false, reason: 'invalid-namespace' };
  const current = currentTime(now);
  if (agentPaused !== true) return { ok: false, reason: 'agent-not-paused' };
  const invalid = validateNewPassword(password, consoleToken);
  if (invalid !== null) return invalid;

  const state = buildStoredState(password, current);
  if (state === null) return { ok: false, reason: 'persist-failed' };
  const persisted = persistState(stateDir, state, fsOps, resolvedNamespace);
  if (!persisted.ok) return persisted;
  revokeAllSessions({ namespace: resolvedNamespace });
  return { ok: true };
}
