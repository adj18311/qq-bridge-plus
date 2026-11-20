/**
 * 路线 B：授权端点 **HTTP 服务器工厂**（独立模块，**未接线**）。
 *
 * 只把「HTTP 请求 → 注入的 routes.handleAuthorize/handleComplete → JSON 响应」串起来；
 * 不 import bridge、不读 config/state、不访问平台。未来 bridge 可以直接 start/stop 本模块。
 *
 * HTTP 契约：
 *  · 仅监听回环地址（默认 `127.0.0.1`；`host` 非回环直接 TypeError 拒绝构造，防误暴露）；
 *  · 仅处理 `POST /api/xiaoheihe/{authorize,commit,abort,complete}`：
 *      未知路径 → 404 `not-found`；已知路径非 POST → 405 + `Allow: POST`；
 *  · Content-Type 必须是 `application/json`（允许 `; charset=...`）；缺失/错误 → 415；
 *  · 请求体上限 `maxBodyBytes`（默认 64 KiB）：超限 → 413，且**不解析、不调用 routes**；
 *  · 非法/空 JSON → 400 `invalid-json`（固定错误码，不回显解析细节）；
 *  · routes 返回 `{status, body}` 原样响应（JSON）；routes 抛错 / 非法返回 → 500 `internal-error`，
 *    **不回显堆栈/token/内部异常**；日志只记固定字段（code/status），不含 body/token；
 *  · 超时：请求体读取超时 → 408 `request-timeout`；routes 处理超时 → 504 `gateway-timeout`；
 *    超时后销毁连接、忽略迟到结果，**绝不返回 allow**；
 *  · 响应头：`content-type: application/json; charset=utf-8`、`cache-control: no-store`、
 *    `x-content-type-options: nosniff`、`connection: close`（内部端点不复用连接）。
 *  · 生命周期：`start()` 幂等（重复调用返回同一监听）、`stop()` 幂等（关闭并销毁所有连接）、
 *    未 start 时 stop 安全；`port:0` 由 OS 分配；端口占用时 start 以原始 EADDRINUSE 错误拒绝。
 *
 * 明确不做：TLS（仅回环）、身份/额度逻辑（routes/authorizeApi 负责）、重试、审计落盘、
 * 路由前缀配置化、请求体 gzip 解压；不做 keep-alive 优化。
 */

import http from 'node:http';

export const XHH_AUTHORIZE_SERVER_DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 0,
  maxBodyBytes: 64 * 1024,
  requestTimeoutMs: 2000,
});

export const XHH_AUTHORIZE_SERVER_PATHS = Object.freeze({
  authorize: '/api/xiaoheihe/authorize',
  commit: '/api/xiaoheihe/commit',
  abort: '/api/xiaoheihe/abort',
  complete: '/api/xiaoheihe/complete',
  // task-130：只读状态端点，供 bridge 比对真实暂停/恢复（POST，body 可为 {}）。
  status: '/api/xiaoheihe/status',
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const PATH_TO_HANDLER = new Map([
  [XHH_AUTHORIZE_SERVER_PATHS.authorize, 'handleAuthorize'],
  [XHH_AUTHORIZE_SERVER_PATHS.commit, 'handleCommit'],
  [XHH_AUTHORIZE_SERVER_PATHS.abort, 'handleAbort'],
  [XHH_AUTHORIZE_SERVER_PATHS.complete, 'handleComplete'],
  [XHH_AUTHORIZE_SERVER_PATHS.status, 'handleStatus'],
]);
const RESPONSE_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  connection: 'close',
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function formatUrl(host, port) {
  return host.includes(':') ? `http://[${host}]:${port}` : `http://${host}:${port}`;
}

/**
 * 创建授权端点 HTTP 服务器（不自动监听；调用 start() 才开始）。
 *
 * @param {object} options
 * @param {object} options.routes 必须提供 handleAuthorize/handleComplete（纯路由处理器）
 * @param {string} [options.host] 只允许回环地址
 * @param {number} [options.port] 0 表示 OS 分配
 * @param {number} [options.maxBodyBytes]
 * @param {number} [options.requestTimeoutMs]
 * @param {object} [options.logger] 可选；只接收固定字段日志（无 body/token）
 */
export function createXhhAuthorizeServer(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const routes = isPlainObject(source.routes) ? source.routes : null;
  if (
    routes === null
    || typeof routes.handleAuthorize !== 'function'
    || typeof routes.handleComplete !== 'function'
  ) {
    throw new TypeError('createXhhAuthorizeServer：routes 必须提供 handleAuthorize/handleComplete');
  }
  const host = source.host === undefined ? XHH_AUTHORIZE_SERVER_DEFAULTS.host : source.host;
  if (typeof host !== 'string' || !LOOPBACK_HOSTS.has(host)) {
    throw new TypeError('createXhhAuthorizeServer：host 只允许回环地址（127.0.0.1 / ::1 / localhost）');
  }
  const port = source.port === undefined ? XHH_AUTHORIZE_SERVER_DEFAULTS.port : source.port;
  if (!(typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65535)) {
    throw new TypeError('createXhhAuthorizeServer：port 必须是 0-65535 的整数');
  }
  const maxBodyBytes = source.maxBodyBytes === undefined
    ? XHH_AUTHORIZE_SERVER_DEFAULTS.maxBodyBytes
    : source.maxBodyBytes;
  if (!isPositiveInteger(maxBodyBytes)) {
    throw new TypeError('createXhhAuthorizeServer：maxBodyBytes 必须是正整数');
  }
  const requestTimeoutMs = source.requestTimeoutMs === undefined
    ? XHH_AUTHORIZE_SERVER_DEFAULTS.requestTimeoutMs
    : source.requestTimeoutMs;
  if (!isPositiveInteger(requestTimeoutMs)) {
    throw new TypeError('createXhhAuthorizeServer：requestTimeoutMs 必须是正整数');
  }
  const logger = isPlainObject(source.logger) ? source.logger : null;

  let server = null;
  let sockets = new Set();
  let startPromise = null;
  let stopPromise = null;

  function log(level, code) {
    if (logger === null) return;
    const fn = typeof logger[level] === 'function' ? logger[level] : undefined;
    if (fn === undefined) return;
    try {
      fn.call(logger, 'xhh-authorize-server', { code });
    } catch {
      // 日志失败不影响请求。
    }
  }

  function addressInfo() {
    if (server === null || !server.listening) return null;
    const info = server.address();
    if (info === null || typeof info === 'string') return null;
    return { host: info.address, port: info.port, url: formatUrl(info.address, info.port) };
  }

  function writeJson(res, status, body) {
    try {
      res.writeHead(status, RESPONSE_HEADERS);
      res.end(JSON.stringify(body));
    } catch {
      // 连接已断开。
    }
  }

  function handleRequest(req, res) {
    let settled = false;
    let phase = 'reading';
    let timer = null;
    const chunks = [];
    let received = 0;

    const finalize = (status, body, { code } = {}) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (code !== undefined) log(status >= 500 ? 'error' : 'warn', code);
      writeJson(res, status, body);
      // 内部端点不复用连接；响应刷出后关闭请求侧。
      res.on('finish', () => {
        try {
          req.destroy();
        } catch {
          // ignore
        }
      });
    };

    timer = setTimeout(() => {
      if (settled) return;
      if (phase === 'reading') {
        finalize(408, { ok: false, error: 'request-timeout' }, { code: 'request-timeout' });
      } else {
        finalize(504, { ok: false, error: 'gateway-timeout' }, { code: 'gateway-timeout' });
      }
    }, requestTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    req.on('error', () => {
      settled = true;
      if (timer !== null) clearTimeout(timer);
    });
    res.on('error', () => {
      settled = true;
      if (timer !== null) clearTimeout(timer);
    });

    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      pathname = '';
    }
    const handlerName = PATH_TO_HANDLER.get(pathname);
    if (handlerName === undefined) {
      finalize(404, { ok: false, error: 'not-found' }, { code: 'not-found' });
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      finalize(405, { ok: false, error: 'method-not-allowed' }, { code: 'method-not-allowed' });
      return;
    }
    if (typeof routes[handlerName] !== 'function') {
      // commit/abort 是 task-71 新端点：旧 routes 只实现 authorize/complete 时保持兼容，
      // 但对新端点 fail-closed（500），绝不返回 allow。
      finalize(500, { ok: false, error: 'internal-error' }, { code: 'handler-unavailable' });
      return;
    }
    const contentType = typeof req.headers['content-type'] === 'string'
      ? req.headers['content-type'].split(';')[0].trim().toLowerCase()
      : '';
    if (contentType !== 'application/json') {
      finalize(415, { ok: false, error: 'unsupported-media-type' }, { code: 'unsupported-media-type' });
      return;
    }
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      finalize(413, { ok: false, error: 'payload-too-large' }, { code: 'payload-too-large' });
      return;
    }

    req.on('data', (chunk) => {
      if (settled) return;
      received += chunk.length;
      if (received > maxBodyBytes) {
        finalize(413, { ok: false, error: 'payload-too-large' }, { code: 'payload-too-large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      phase = 'handling';
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        finalize(400, { ok: false, error: 'invalid-json' }, { code: 'invalid-json' });
        return;
      }
      let pending;
      try {
        pending = routes[handlerName]({ headers: req.headers, body });
      } catch {
        finalize(500, { ok: false, error: 'internal-error' }, { code: 'internal-error' });
        return;
      }
      Promise.resolve(pending).then((result) => {
        if (settled) return;
        if (!isPlainObject(result)
          || !(typeof result.status === 'number' && Number.isInteger(result.status) && result.status >= 100 && result.status <= 599)
          || !isPlainObject(result.body)) {
          finalize(500, { ok: false, error: 'internal-error' }, { code: 'internal-error' });
          return;
        }
        finalize(result.status, result.body);
      }, () => {
        if (settled) return;
        finalize(500, { ok: false, error: 'internal-error' }, { code: 'internal-error' });
      });
    });
  }

  async function start() {
    if (server !== null && server.listening) return addressInfo();
    if (startPromise !== null) return startPromise;
    startPromise = (async () => {
      const candidate = http.createServer(handleRequest);
      candidate.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          candidate.off('error', onError);
          try {
            candidate.close();
          } catch {
            // ignore
          }
          reject(error);
        };
        candidate.once('error', onError);
        candidate.listen({ host, port }, () => {
          candidate.off('error', onError);
          resolve();
        });
      });
      server = candidate;
      return addressInfo();
    })().finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  async function stop() {
    if (stopPromise !== null) return stopPromise;
    if (server === null || !server.listening) {
      server = null;
      return { stopped: false };
    }
    stopPromise = (async () => {
      const closing = server;
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }
      sockets = new Set();
      await new Promise((resolve) => {
        closing.close(() => resolve());
      });
      if (server === closing) server = null;
      return { stopped: true };
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }

  return {
    server: {
      get listening() {
        return server !== null && server.listening;
      },
    },
    start,
    stop,
    address: addressInfo,
  };
}
