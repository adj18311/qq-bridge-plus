// C11：QQ 入站消息的**来源登记**通道（bridge 进程 ↔ 插件进程）。
//
// 为什么需要它
// ------------
// 插件侧来源账本（src/core/qzone-origin-ledger-offline.mjs:192-209）只承认**已登记**的 rpcId：
//   observeStep 拿 message.source.rpcId 去 requests 里查，查不到 ⇒ requestId=null ⇒ 该 step 的
//   所有 tool call 都绑不上来源 ⇒ consume 返回 null ⇒ origin-unbound。
// 而 requests 只由 registerBridgeRequest({ requestId, origin }) 写入，那个方法是**插件进程内**的。
// bridge 是独立进程，没有通道 ⇒ 永远登记不上。本文件就是那条通道。
//
// 它证明什么、不证明什么
// ----------------------
// 证明：**bridge 进程**声明「这条 requestId 来自 qq-inbound（或 schedule）」。插件据此把该 id
// 视作可信桥接来源。
// 不证明：这条 requestId 真的对应一条 QQ 消息 —— 那取决于 bridge 在**哪个调用点**登记。
// 所以 origin 的正确性完全落在这条通道的**唯一调用方**（src/bridge.js 的 deliverPromptNow）
// 身上：它只有在一次真实的 QQ 入站投递（或后台巡逻投递）之前才会登记。
//
// 安全形状（照抄 qzone-approval-ipc-* 的既有约定，但本文件独立实现、不 import 对方）
// ----------------------------------------------------------------------------------
//   · 只绑字面量回环地址（127.0.0.1 / ::1；'localhost' 会走 hosts 重解析，是另一条信任路径）；
//   · 独立 Bearer token，调用方提供，定长比较；鉴权先于路由（未授权对端问不出有哪些路径）；
//   · 帧上限 16 KiB，超限在读的过程中就拒绝；
//   · origin 闭集（'qq-inbound' / 'schedule'），与账本 registerBridgeRequest 的判定一致；
//   · **不写任何日志**：requestId 是关联一条 QQ 消息的标识，写进日志就等于把投递图谱落盘。

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

// ── 协议常量 ────────────────────────────────────────────────────────────────────────────────
export const QZONE_SOURCE_REGISTER_PATH = '/source/register';
/** 三个短字段；16 KiB 已是宽松上界，同时给恶意本地对端一个硬顶。 */
export const QZONE_SOURCE_REGISTER_MAX_FRAME_BYTES = 16 * 1024;
export const QZONE_SOURCE_REGISTER_MAX_RESPONSE_BYTES = 8 * 1024;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
/** 溢出后最多再读这么多就断链，免得对端无限流式写入拖住事件循环。 */
const OVERFLOW_DRAIN_BYTES = QZONE_SOURCE_REGISTER_MAX_FRAME_BYTES * 2;
/** 只接受字面量回环地址。 */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1']);
const TOKEN = /^[\x21-\x7E]{16,512}$/;

/** origin 闭集，与 qzone-origin-ledger-offline.mjs:83 的判定逐字一致。 */
export const QZONE_SOURCE_ORIGINS = Object.freeze(['qq-inbound', 'schedule']);

/** requestId / sessionId 的长度与字符约束（与账本 SESSION_ID / requestId 上限一致）。 */
const ID_TEXT = /^[^\u0000-\u001F\u007F]{1,128}$/;

/**
 * 长度/字符合法 **且** 不是纯空白。
 *
 * 账本那一侧只要求 `!id`（空串）与 ≤128，纯空白能过；但纯空白的 id 既不是一条消息的身份，
 * 也不可能是真实的 rpcId（它是 UUID）。这里比账本更严一档：拒绝它是 fail-closed 方向，
 * 不会拒掉任何真实调用。
 */
function isValidText(value) {
  return typeof value === 'string' && ID_TEXT.test(value) && value.trim() !== '';
}

const REGISTER_KEYS = Object.freeze(['sessionId', 'requestId', 'origin']);

const JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 读一个自有 **数据** 属性；getter / 缺失 / 抛异常一律 undefined。 */
function ownData(target, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** 闭集读取：键集必须**恰好**是 allowed。 */
function readClosedRecord(value, allowed) {
  try {
    if (!isPlainRecord(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== allowed.length) return null;
    for (const key of keys) {
      if (typeof key !== 'string' || allowed.includes(key) === false) return null;
    }
    const out = Object.create(null);
    for (const key of allowed) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || Object.hasOwn(descriptor, 'value') === false) return null;
      out[key] = descriptor.value;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 读一帧登记请求。
 * @returns {{sessionId:string, requestId:string, origin:string}|null}
 *   origin 不在闭集 / id 形状不符 / 键集不符 ⇒ null（调用方区分 400 与 403，故这里分两步）。
 */
function readRegisterFrame(value) {
  const frame = readClosedRecord(value, REGISTER_KEYS);
  if (frame === null) return null;
  if (isValidText(frame.sessionId) === false) return null;
  if (isValidText(frame.requestId) === false) return null;
  if (typeof frame.origin !== 'string') return null;
  return frame;
}

// ── 配置解读 ────────────────────────────────────────────────────────────────────────────────
/** 允许出现在 `qzone.sourceRegister` 里的键；多一个都算配置错误。 */
export const QZONE_SOURCE_REGISTER_KEYS = Object.freeze(['token', 'port']);

/**
 * 解读 `cfg.qzone.sourceRegister`。
 *
 * @param {unknown} qzone 整个 `cfg.qzone`。
 * @returns {{enabled:false, reason:string} | {enabled:true, token:string, port:number}}
 *   `enabled:false` 不是错误：调用方 log 原因后照常继续（fail-soft）。
 */
export function readQzoneSourceRegisterConfig(qzone) {
  const section = isPlainRecord(qzone) ? ownData(qzone, 'sourceRegister') ?? null : null;
  if (section === undefined || section === null) return { enabled: false, reason: 'not-configured' };
  if (!isPlainRecord(section)) return { enabled: false, reason: 'invalid-section' };
  for (const key of Reflect.ownKeys(section)) {
    if (typeof key !== 'string' || QZONE_SOURCE_REGISTER_KEYS.includes(key) === false) {
      return { enabled: false, reason: 'unknown-field' };
    }
  }
  const token = ownData(section, 'token');
  if (typeof token !== 'string' || token === '') return { enabled: false, reason: 'token-missing' };
  if (/^[A-Za-z0-9_-]{32,256}$/.test(token) === false) return { enabled: false, reason: 'token-invalid' };
  const rawPort = ownData(section, 'port');
  const port = rawPort === undefined ? 0 : rawPort;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) return { enabled: false, reason: 'port-invalid' };
  return { enabled: true, token, port };
}

// ── 服务端（插件侧起；本轮不由 bridge 起，契约仍在这里定死）────────────────────────────────
/**
 * 起一个只绑回环的来源登记 listener。
 *
 * @param {object} options
 * @param {(sessionId: string, input: {requestId: string, origin: string}) => unknown} options.register
 *   插件侧的登记实现（例如 `handle.registerBridgeRequest`）。返回 `{ok:true}` 表示登记成功；
 *   抛错或返回其它值 ⇒ 500（bridge 侧据此只记一行、继续投递）。
 * @param {string} options.token  调用方提供的 Bearer token（本模块从不生成、不读盘）。
 * @param {() => number} [options.clock]
 * @param {string} [options.host]  '127.0.0.1'（默认）或 '::1'。
 * @param {number} [options.port]  0（默认）= 系统分配，实际端口在返回值里。
 * @returns {Promise<{close: () => Promise<void>, port: number, address: string}>}
 */
export async function createQzoneSourceRegisterIpcServer({
  register, token, clock = Date.now, host = '127.0.0.1', port = 0,
} = {}) {
  if (typeof register !== 'function') {
    throw new TypeError('source register ipc server needs a register function');
  }
  if (typeof token !== 'string' || TOKEN.test(token) === false) {
    throw new TypeError('source register ipc server needs a 16-512 character printable bearer token supplied by the caller');
  }
  if (typeof clock !== 'function') throw new TypeError('source register ipc server needs a clock function');
  if (typeof host !== 'string' || LOOPBACK_ADDRESSES.has(host) === false) {
    throw new TypeError('source register ipc server only listens on a loopback address (127.0.0.1 or ::1)');
  }
  if (Number.isSafeInteger(port) === false || port < 0 || port > 65535) {
    throw new TypeError('source register ipc server needs a valid port');
  }

  const expected = Buffer.from(token, 'utf8');
  let closed = false;

  function respond(response, status, body, extraHeaders) {
    try {
      if (response.writableEnded === true || response.destroyed === true) return;
      response.writeHead(status, extraHeaders === undefined ? JSON_HEADERS : { ...JSON_HEADERS, ...extraHeaders });
      response.end(JSON.stringify(body));
    } catch {
      try { response.destroy(); } catch {}
    }
  }

  function discard(request) {
    try { request.resume(); } catch {}
  }

  function isAuthorized(request) {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || header.startsWith('Bearer ') === false) return false;
    const supplied = Buffer.from(header.slice(7), 'utf8');
    if (supplied.length !== expected.length) return false;
    try { return timingSafeEqual(supplied, expected); } catch { return false; }
  }

  function pathOf(url) {
    if (typeof url !== 'string') return null;
    const mark = url.indexOf('?');
    return mark === -1 ? url : url.slice(0, mark);
  }

  function readBody(request) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      let drained = 0;
      let overflow = false;
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        request.removeListener('data', onData);
        request.removeListener('end', onEnd);
        request.removeListener('error', onError);
        request.removeListener('aborted', onAbort);
        resolve(result);
      };

      const deadline = setTimeout(() => {
        finish({ ok: false, status: 408 });
        try { request.destroy(); } catch {}
      }, DEFAULT_TIMEOUT_MS);

      function onData(chunk) {
        if (overflow) {
          drained += chunk.length;
          if (drained > OVERFLOW_DRAIN_BYTES) {
            finish({ ok: false, status: 413 });
            try { request.destroy(); } catch {}
          }
          return;
        }
        size += chunk.length;
        if (size > QZONE_SOURCE_REGISTER_MAX_FRAME_BYTES) {
          overflow = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      }

      function onEnd() {
        if (overflow) finish({ ok: false, status: 413 });
        else if (size === 0) finish({ ok: false, status: 400 });
        else finish({ ok: true, buffer: Buffer.concat(chunks, size) });
      }

      function onError() { finish({ ok: false, status: 400 }); }
      function onAbort() { finish({ ok: false, status: 400 }); }

      request.on('data', onData);
      request.on('end', onEnd);
      request.on('error', onError);
      request.on('aborted', onAbort);
    });
  }

  function parseJson(buffer) {
    try {
      const text = buffer.toString('utf8');
      if (Buffer.byteLength(text, 'utf8') > QZONE_SOURCE_REGISTER_MAX_FRAME_BYTES) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function handle(request, response) {
    if (closed === true) { respond(response, 503, { ok: false, error: 'closed' }); discard(request); return; }
    // 鉴权先于路由：未授权对端连「有没有这个路径」都不该问出来。
    if (isAuthorized(request) === false) {
      respond(response, 401, { ok: false, error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      discard(request);
      return;
    }
    if (pathOf(request.url) !== QZONE_SOURCE_REGISTER_PATH) {
      respond(response, 404, { ok: false, error: 'not-found' });
      discard(request);
      return;
    }
    if (request.method !== 'POST') {
      respond(response, 405, { ok: false, error: 'method-not-allowed' }, { Allow: 'POST' });
      discard(request);
      return;
    }
    const body = await readBody(request);
    if (body.ok !== true) { respond(response, body.status, { ok: false, error: 'invalid-frame' }); return; }
    const frame = readRegisterFrame(parseJson(body.buffer));
    if (frame === null) { respond(response, 400, { ok: false, error: 'invalid-frame' }); return; }
    // origin 单独判定：形状没错、但来源不在闭集 ⇒ 403（可诊断且不误报成"参数写错了"）。
    if (QZONE_SOURCE_ORIGINS.includes(frame.origin) === false) {
      respond(response, 403, { ok: false, error: 'invalid-origin' });
      return;
    }
    try {
      const result = await register(frame.sessionId, Object.freeze({
        requestId: frame.requestId, origin: frame.origin,
      }));
      if (result === undefined || result === null || (result !== undefined && result.ok === false)) {
        // 插件侧明确拒绝（例如会话未就绪 / 账本不可用）：如实回 500，不伪装成成功。
        respond(response, 500, { ok: false, error: 'register-refused' });
        return;
      }
      respond(response, 200, { ok: true });
    } catch {
      // 不把异常文案回给对端（可能含会话 id / 账本内部状态）。
      respond(response, 500, { ok: false, error: 'register-failed' });
    }
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch(() => {
      respond(response, 500, { ok: false, error: 'internal' });
      discard(request);
    });
  });
  server.headersTimeout = Math.min(DEFAULT_TIMEOUT_MS + 5000, 30000);
  server.requestTimeout = DEFAULT_TIMEOUT_MS + 5000;
  server.keepAliveTimeout = 5000;
  server.on('clientError', (_error, socket) => { try { socket.destroy(); } catch {} });

  await new Promise((resolve, reject) => {
    const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen({ host, port, exclusive: true });
    } catch (error) {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
      reject(error);
    }
  });

  const bound = server.address();
  if (bound === null || typeof bound !== 'object' || LOOPBACK_ADDRESSES.has(bound.address) === false) {
    await new Promise((resolve) => server.close(() => resolve()));
    throw new Error('source register ipc server refused to start: the bound address is not loopback');
  }
  // listen 之后的 'error' 若无人接会变成杀死宿主的未捕获事件；把它变成"关掉的 listener"。
  server.on('error', () => { closed = true; });

  async function close() {
    if (closed === true) return;
    closed = true;
    try { server.closeAllConnections(); } catch {}
    await new Promise((resolve) => {
      try { server.close(() => resolve()); } catch { resolve(); }
    });
  }

  return Object.freeze({ close, port: bound.port, address: bound.address });
}

// ── 客户端（bridge 侧用）────────────────────────────────────────────────────────────────────
/** 只接受字面量回环 origin（不接受 localhost，理由同服务端）。 */
function readOrigin(value) {
  if (typeof value !== 'string') return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]' && parsed.hostname !== '::1') return null;
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  return parsed.origin;
}

async function readCappedText(response, maxBytes) {
  const stream = response.body;
  if (stream === null || typeof stream !== 'object' || typeof stream.getReader !== 'function') {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > maxBytes ? null : text;
  }
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) break;
      const chunk = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
      size += chunk.length;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch {}
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/**
 * 登记一条桥接来源（bridge 侧）。
 *
 * 契约：**从不抛**。超时 / 非 2xx / 非法 JSON / 对端拒绝 ⇒ 一律 `false`。
 * 调用方（deliverPromptNow）据此只记一行日志并**继续投递** —— 来源登记失败不该卡住一条 QQ 消息；
 * 代价是这一次投递在插件侧会以 origin-unbound 被拒（fail-closed 的正确方向）。
 *
 * @param {object} options
 * @param {string} options.origin  形如 'http://127.0.0.1:41234'（只接受字面量回环）。
 * @param {string} options.token   Bearer token，16..512 个可打印 ASCII。
 * @param {number} [options.timeoutMs] 单次预算 1..60000（默认 10000）。
 * @param {Function} [options.fetch]   注入的 fetch（默认全局 fetch）。
 * @returns {{register: (sessionId: string, input: {requestId: string, origin: string}) => Promise<boolean>,
 *            close: () => Promise<void>}}
 */
export function createQzoneSourceRegisterIpcClient({ origin, token, timeoutMs = DEFAULT_TIMEOUT_MS, fetch: fetchImpl } = {}) {
  const base = readOrigin(origin);
  if (base === null) throw new TypeError('source register ipc client needs a loopback http origin such as http://127.0.0.1:1234');
  if (typeof token !== 'string' || TOKEN.test(token) === false) {
    throw new TypeError('source register ipc client needs a 16-512 character printable bearer token supplied by the caller');
  }
  if (Number.isSafeInteger(timeoutMs) === false || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError('source register ipc client needs a timeoutMs between 1 and ' + MAX_TIMEOUT_MS);
  }
  const doFetch = fetchImpl === undefined ? globalThis.fetch : fetchImpl;
  if (typeof doFetch !== 'function') throw new TypeError('source register ipc client needs a fetch function');

  const controllers = new Set();
  let closed = false;

  async function post(body, controller) {
    let response;
    try {
      response = await doFetch(base + QZONE_SOURCE_REGISTER_PATH, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        // 重定向会把这次 POST 悄悄发到别处；端点固定。
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch {
      return null;
    }
    try {
      if (Number.isInteger(response.status) === false || response.status < 200 || response.status > 299) {
        try { await response.body?.cancel?.(); } catch {}
        return null;
      }
      const text = await readCappedText(response, QZONE_SOURCE_REGISTER_MAX_RESPONSE_BYTES);
      if (text === null) return null;
      const parsed = JSON.parse(text);
      return isPlainRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * 登记一次。永远 resolve 布尔，永不 reject。
   */
  async function register(sessionId, input) {
    if (closed === true) return false;
    if (isValidText(sessionId) === false) return false;
    const requestId = ownData(input, 'requestId');
    const sourceOrigin = ownData(input, 'origin');
    if (isValidText(requestId) === false) return false;
    if (typeof sourceOrigin !== 'string' || QZONE_SOURCE_ORIGINS.includes(sourceOrigin) === false) return false;

    const controller = new AbortController();
    controllers.add(controller);
    let timer = null;
    try {
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => {
          try { controller.abort(); } catch {}
          resolve(null);
        }, timeoutMs);
      });
      const answer = await Promise.race([
        post({ sessionId, requestId, origin: sourceOrigin }, controller),
        deadline,
      ]);
      return answer !== null && answer.ok === true;
    } catch {
      return false;
    } finally {
      if (timer !== null) clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  /** 中止在途登记；之后 register 一律 false。幂等。 */
  async function close() {
    closed = true;
    for (const controller of controllers) {
      try { controller.abort(); } catch {}
    }
    controllers.clear();
  }

  return Object.freeze({ register, close });
}
