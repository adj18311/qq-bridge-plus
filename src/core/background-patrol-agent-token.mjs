/**
 * 后台巡逻：受限智能体令牌（**纯模块，可注入文件系统**）。
 *
 * 背景（要解决的问题）：后台巡逻回合拿不到可用令牌 —— 贴吧 MCP 工具必须带
 * `x-agent-token`，而桥接的 QQ 令牌只存在于 `socialV2.conversations` 里，键必须是
 * `group:<号>` / `private:<号>`；后台会话的 key 是 `patrol:background`，`canonicalV2Key`
 * 直接拒绝，所以 `getSocialV2State('patrol:background')` 必抛、令牌无从产生。生产表现是
 * 巡逻每轮贴吧工具都回「未授权：智能体调用必须携带有效的会话令牌」（2026-10-29 连续三次）。
 *
 * 用户决策（m33778 方案 2）：给后台会话**独立**令牌，但权限必须限定 ——
 * 不能只是「让通用 isLiveAgentToken 认它」，它必须**只能**用于允许的贴吧只读端点，
 * 不能调 QQ 发送或任何管理员能力。
 *
 * 因此本模块把「作用域」写成一等公民：
 *  · 只有 `tieba-read` 一个作用域；
 *  · 该作用域只放行 `BACKGROUND_TIEBA_READ_PATHS`（两个 GET 只读端点）；
 *  · 任何其它路径一律 deny（fail-closed），由桥接的集中关卡执行。
 *
 * 持久状态（严格解析，坏状态 fail-closed 且**绝不覆盖**）：
 * `{schemaVersion, scope, token, generation, createdAt, rotatedAt}`
 *
 * 边界：本模块不联网、不 import bridge/DSH、不读写 state（文件系统由调用方注入）。
 * 令牌明文只经 `ensure()` / `rotate()` 返回给调用方注入提示词，绝不进入日志或审计；
 * `snapshot()` 只给脱敏视图。
 */

import crypto from 'node:crypto';

export const BACKGROUND_AGENT_TOKEN_VERSION = 1;
/** 唯一允许的作用域：贴吧只读。新增作用域必须先加白名单端点再放开，不得隐式放行。 */
export const BACKGROUND_AGENT_TOKEN_SCOPE = 'tieba-read';
export const BACKGROUND_AGENT_TOKEN_SCOPES = Object.freeze([BACKGROUND_AGENT_TOKEN_SCOPE]);
/** 该作用域**唯一**放行的端点（GET 只读）。 */
export const BACKGROUND_TIEBA_READ_PATHS = Object.freeze([
  '/api/socialV2/tieba/bar',
  '/api/socialV2/tieba/thread',
]);
/** 令牌字节数：24 → 48 位十六进制，与 QQ 会话令牌同强度。 */
export const BACKGROUND_AGENT_TOKEN_BYTES = 24;
const TOKEN_PATTERN = /^[0-9a-f]{48}$/u;
const STATE_KEYS = Object.freeze([
  'schemaVersion', 'scope', 'token', 'generation', 'createdAt', 'rotatedAt',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isFiniteTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function stateInvalid(message) {
  const error = new Error(`后台令牌状态不可用：${message}`);
  error.code = 'BACKGROUND_AGENT_TOKEN_STATE_INVALID';
  return error;
}

/**
 * 严格解析持久状态。`null`/`undefined` 表示还没有持久状态（首次运行）。
 * 未知字段、版本不符、字段矛盾一律抛 {@link stateInvalid}。
 */
export function parseBackgroundAgentTokenState(raw) {
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) throw stateInvalid('不是对象');
  for (const key of Object.keys(raw)) {
    if (!STATE_KEYS.includes(key)) throw stateInvalid(`未知字段 ${key}`);
  }
  if (raw.schemaVersion !== BACKGROUND_AGENT_TOKEN_VERSION) {
    throw stateInvalid(`schemaVersion 不支持（${String(raw.schemaVersion)}）`);
  }
  if (!BACKGROUND_AGENT_TOKEN_SCOPES.includes(raw.scope)) {
    throw stateInvalid(`作用域不在白名单（${String(raw.scope)}）`);
  }
  if (typeof raw.token !== 'string' || !TOKEN_PATTERN.test(raw.token)) {
    throw stateInvalid('令牌格式非法');
  }
  if (!Number.isInteger(raw.generation) || raw.generation < 1) {
    throw stateInvalid('generation 非法');
  }
  if (!isFiniteTimestamp(raw.createdAt)) throw stateInvalid('createdAt 非法');
  if (raw.rotatedAt !== null && !isFiniteTimestamp(raw.rotatedAt)) {
    throw stateInvalid('rotatedAt 非法');
  }
  return {
    schemaVersion: raw.schemaVersion,
    scope: raw.scope,
    token: raw.token,
    generation: raw.generation,
    createdAt: raw.createdAt,
    rotatedAt: raw.rotatedAt,
  };
}

/**
 * 作用域 → 是否允许该请求。**唯一**判定点：调用方不得自己写 path 白名单。
 * 只允许 `GET` 且路径精确命中；其它方法/路径/未知作用域一律 false（fail-closed）。
 */
export function backgroundTokenAllowsRequest(scope, request) {
  if (scope !== BACKGROUND_AGENT_TOKEN_SCOPE) return false;
  if (!isPlainObject(request)) return false;
  const method = String(request.method ?? '').toUpperCase();
  if (method !== 'GET') return false;
  const pathname = String(request.pathname ?? '');
  return BACKGROUND_TIEBA_READ_PATHS.includes(pathname);
}

function makeToken() {
  return crypto.randomBytes(BACKGROUND_AGENT_TOKEN_BYTES).toString('hex');
}

/**
 * 后台令牌存储。
 *
 * @param {object} options
 * @param {string} options.filePath 持久状态路径
 * @param {() => number} [options.clock]
 * @param {object} [options.fs] `{ readFile, writeFile, rename, mkdir }`（promise 版）
 * @param {() => string} [options.makeToken] 便于测试注入确定值
 */
export function createBackgroundAgentTokenStore(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('options 必须是对象');
  const filePath = options.filePath;
  if (typeof filePath !== 'string' || filePath === '') {
    throw new TypeError('filePath 必须是非空字符串');
  }
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const fsAdapter = isPlainObject(options.fs) ? options.fs : null;
  const makeTokenFn = typeof options.makeToken === 'function' ? options.makeToken : makeToken;

  let state = null;
  let loaded = false;
  let broken = null; // 状态损坏原因：一旦置位，verify 一律 fail-closed

  async function readStateFile() {
    if (fsAdapter === null) {
      const fsp = await import('node:fs/promises');
      return fsp.readFile(filePath, 'utf8');
    }
    return fsAdapter.readFile(filePath, 'utf8');
  }

  async function writeStateFile(text) {
    if (fsAdapter === null) {
      const fsp = await import('node:fs/promises');
      const path = await import('node:path');
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tempPath, text, { mode: 0o600 });
      await fsp.rename(tempPath, filePath);
      return;
    }
    if (typeof fsAdapter.writeFile !== 'function') throw new TypeError('fs.writeFile 缺失');
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fsAdapter.writeFile(tempPath, text, { mode: 0o600 });
    if (typeof fsAdapter.rename !== 'function') throw new TypeError('fs.rename 缺失');
    await fsAdapter.rename(tempPath, filePath);
  }

  /**
   * 读取持久状态。返回：
   *  · `{ok:true, state:null}` —— 还没有状态（首次运行）；
   *  · `{ok:true, state}` —— 解析成功的状态；
   *  · `{ok:false, reason}` —— 读失败或状态损坏（fail-closed：调用方必须按「无可用令牌」处理）。
   */
  async function load() {
    let text;
    try {
      text = await readStateFile();
    } catch (error) {
      if (error?.code === 'ENOENT') {
        state = null;
        loaded = true;
        broken = null;
        return { ok: true, state: null };
      }
      broken = 'read-failed';
      return { ok: false, reason: 'read-failed' };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      broken = 'state-corrupt';
      return { ok: false, reason: 'state-corrupt' };
    }
    try {
      state = parseBackgroundAgentTokenState(parsed);
    } catch (error) {
      broken = error?.code === 'BACKGROUND_AGENT_TOKEN_STATE_INVALID' ? 'state-invalid' : 'state-invalid';
      return { ok: false, reason: broken };
    }
    loaded = true;
    broken = null;
    return { ok: true, state };
  }

  async function persist() {
    if (state === null) throw stateInvalid('没有可持久化的状态');
    await writeStateFile(JSON.stringify(state));
  }

  /**
   * 取得（必要时创建）后台令牌。
   * 返回 `{ok:true, token, scope, generation, created}` 或 `{ok:false, reason}`。
   * 持久化失败一律 fail-closed：**绝不**把未落盘的令牌当可复用（否则重启后模型手里的
   * 令牌立刻失效，且没有任何地方知道它曾经有效过）。
   */
  async function ensure() {
    if (!loaded) {
      const result = await load();
      if (result.ok !== true) return { ok: false, reason: result.reason };
    }
    if (broken !== null) return { ok: false, reason: broken };
    if (state !== null) {
      return {
        ok: true,
        token: state.token,
        scope: state.scope,
        generation: state.generation,
        created: false,
      };
    }
    const now = clock();
    if (!isFiniteTimestamp(now)) return { ok: false, reason: 'clock-invalid' };
    const next = {
      schemaVersion: BACKGROUND_AGENT_TOKEN_VERSION,
      scope: BACKGROUND_AGENT_TOKEN_SCOPE,
      token: makeTokenFn(),
      generation: 1,
      createdAt: now,
      rotatedAt: null,
    };
    let parsed;
    try {
      parsed = parseBackgroundAgentTokenState(next);
    } catch {
      return { ok: false, reason: 'generated-token-invalid' };
    }
    const previous = state;
    state = parsed;
    try {
      await persist();
    } catch {
      state = previous; // 回滚内存态：未落盘的令牌不算存在
      return { ok: false, reason: 'persist-failed' };
    }
    return { ok: true, token: parsed.token, scope: parsed.scope, generation: parsed.generation, created: true };
  }

  /**
   * 轮换令牌：新令牌立即生效，旧令牌**立即失效**（不留宽限期 —— 宽限期等于给旧值续命，
   * 而旧值可能已经出现在某个模型上下文里）。
   */
  async function rotate() {
    if (!loaded) {
      const result = await load();
      if (result.ok !== true) return { ok: false, reason: result.reason };
    }
    if (broken !== null) return { ok: false, reason: broken };
    const now = clock();
    if (!isFiniteTimestamp(now)) return { ok: false, reason: 'clock-invalid' };
    const previous = state;
    const next = {
      schemaVersion: BACKGROUND_AGENT_TOKEN_VERSION,
      scope: BACKGROUND_AGENT_TOKEN_SCOPE,
      token: makeTokenFn(),
      generation: previous === null ? 1 : previous.generation + 1,
      createdAt: previous === null ? now : previous.createdAt,
      rotatedAt: now,
    };
    let parsed;
    try {
      parsed = parseBackgroundAgentTokenState(next);
    } catch {
      return { ok: false, reason: 'generated-token-invalid' };
    }
    state = parsed;
    try {
      await persist();
    } catch {
      state = previous;
      return { ok: false, reason: 'persist-failed' };
    }
    return { ok: true, token: parsed.token, scope: parsed.scope, generation: parsed.generation };
  }

  /**
   * 作废当前令牌（保留状态文件，`token` 置空由调用方 `load()` 重新 ensure）。
   * 这里不删文件：删除会让「曾经有过令牌」这件事从磁盘上消失。
   */
  async function revoke() {
    if (!loaded) {
      const result = await load();
      if (result.ok !== true) return { ok: false, reason: result.reason };
    }
    const previous = state;
    state = null;
    try {
      if (previous !== null) {
        // 落盘为「无令牌」：写一个显式的空态而不是删文件。
        await writeStateFile(JSON.stringify({ revoked: true, at: clock() }));
      }
    } catch {
      state = previous;
      return { ok: false, reason: 'persist-failed' };
    }
    broken = 'revoked';
    return { ok: true };
  }

  /**
   * 校验令牌。定长比较（令牌同样是凭据，`===` 会短路）。
   * 返回 `{ok:true, scope}` 或 `{ok:false, reason}`。
   */
  function verify(token) {
    if (typeof token !== 'string' || token === '') return { ok: false, reason: 'no-token' };
    if (broken !== null) return { ok: false, reason: broken };
    if (state === null) return { ok: false, reason: 'no-token' };
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(state.token, 'utf8');
    if (a.length !== b.length) return { ok: false, reason: 'unknown-token' };
    if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'unknown-token' };
    return { ok: true, scope: state.scope, generation: state.generation };
  }

  /** 脱敏快照（不含令牌明文，供状态接口/审计使用）。 */
  function snapshot() {
    if (broken !== null) {
      return { present: false, reason: broken, scope: null, generation: null, createdAt: null, rotatedAt: null };
    }
    if (state === null) {
      return { present: false, reason: loaded ? 'absent' : 'not-loaded', scope: null, generation: null, createdAt: null, rotatedAt: null };
    }
    return {
      present: true,
      reason: null,
      scope: state.scope,
      generation: state.generation,
      createdAt: state.createdAt,
      rotatedAt: state.rotatedAt,
    };
  }

  return { load, ensure, rotate, revoke, verify, snapshot, filePath };
}
