// 共享测试辅助（非测试脚本，不注册进 full/quick）：绕开 Node 内置 fetch（undici）的 blocked-port。
//
// 背景（环境 flake，已离线复现）：
//  · harness 用 `listen(0)` 让 OS 分配临时端口；本机 Windows 动态端口范围是 1024–15000
//    （`netsh int ipv4 show dynamicportrange tcp`），与 undici 的 blocked-port 列表（Fetch 规范的
//    "bad port"）重叠 13 个：3659/4045/5060/5061/6000/6566/6665-6669/6697/10080。
//  · 实测 8000 次 listen(0)：min=2831 max=11233，12 次命中（≈0.15%/次）；一旦命中且测试用
//    `fetch()` 连它，就会抛 `TypeError: fetch failed`（cause: `bad port`）——既不是被测逻辑错，
//    也不该当真实失败。
//
// 两条互补路线（按「谁的 fetch 发请求」选，不要混用）：
//  1) 请求由被测插件/生产模块自己 fetch（如 xhh-quota-guard 的 bridgeUrl）：
//     端口由测试分配 ⇒ 必须让服务监听 fetch 可用的端口：
//       reserveFetchablePort() / listenFetchable(server) / startOnFetchablePort(start)。
//     显式端口 + EADDRINUSE 重试，绝不把「换端口」写成吞掉真实请求失败。
//  2) 请求由测试自己发（bridge/hook/authorize-server 直测）：用原生 http：
//       httpRequest(url, opts) / postJson(url, body, headers)。
//     原生 http 没有 undici 的 bad-port 限制（已在 6000 上实测：fetch 抛 bad port，原生 200）。
//
// 约束：仅测试使用；不 import 生产实现、不写 config/profile/state、不访问真实平台/QQ。
import http from 'node:http';
import net from 'node:net';

/**
 * undici/Fetch 规范的 blocked（bad）端口。语义是「fetch 永远拒绝连接」，与服务是否在听无关。
 * 与 scripts/test-group-wait.mjs 历史内联列表保持一致（本模块成为唯一来源）。
 */
export const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

/** 拿 blocked 端口时的最大重试次数（25 次全命中概率 ≈ 1e-47，纯保险）。 */
export const MAX_PORT_ATTEMPTS = 25;

/** port 是否在 fetch blocked 列表内（非整数/越界一律 false，交给调用方自己校验）。 */
export function isFetchBlockedPort(port) {
  return Number.isInteger(port) && FETCH_BLOCKED_PORTS.has(port);
}

/** 关闭一个 http/net server（幂等；未 listening 时直接返回）。 */
export async function closeServer(server) {
  if (server === null || server === undefined || !server.listening) return;
  await new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/**
 * 预留一个 fetch 可用端口：反复 `listen(0)` 探测，命中 blocked 端口就关闭重探。
 * 返回的端口在「close 之后」才交给调用方绑定，存在极小的 TOCTOU 窗口；
 * 调用方（listenFetchable/startOnFetchablePort）会在 EADDRINUSE 时换端口重试。
 */
export async function reserveFetchablePort({
  host = '127.0.0.1',
  maxAttempts = MAX_PORT_ATTEMPTS,
  onRetry = null,
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const probe = net.createServer();
    const port = await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      probe.once('error', onError);
      probe.listen({ host, port: 0 }, () => {
        probe.off('error', onError);
        resolve(probe.address().port);
      });
    });
    await new Promise((resolve) => probe.close(() => resolve()));
    if (!isFetchBlockedPort(port)) {
      if (attempt > 1) onRetry?.(attempt, port);
      return port;
    }
    // 命中 blocked 端口：只换端口，不吞后续真实请求失败。
  }
  throw new Error(`test-port-safe: 连续 ${maxAttempts} 次拿到 fetch blocked 端口`);
}

/**
 * 让一个已创建但未监听的 server 监听 fetch 可用端口。
 * 返回 { port, url }；EADDRINUSE（预留端口被抢占）时自动换端口重试。
 *
 * @param {import('node:net').Server} server
 */
export async function listenFetchable(server, {
  host = '127.0.0.1',
  maxAttempts = MAX_PORT_ATTEMPTS,
  onRetry = null,
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const port = await reserveFetchablePort({ host, maxAttempts, onRetry });
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('error', onError);
          reject(error);
        };
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          resolve();
        });
      });
    } catch (error) {
      if (error?.code !== 'EADDRINUSE' || attempt === maxAttempts) throw error;
      continue;
    }
    const actual = server.address().port;
    if (!isFetchBlockedPort(actual)) {
      if (attempt > 1) onRetry?.(attempt, actual);
      return { port: actual, url: `http://${host}:${actual}` };
    }
    // 理论上不会发生（显式端口一定不在 blocked 列表）；双保险，绝不带着坏端口返回。
    await closeServer(server);
  }
  throw new Error(`test-port-safe: 连续 ${maxAttempts} 次无法让服务监听可 fetch 端口`);
}

/**
 * 用显式端口创建并启动「由工厂自己 listen」的服务（如 createXhhAuthorizeServer），
 * 直到拿到 fetch 可用的真实端口。工厂可以返回任意结果；结果里的 port 会被校验。
 *
 * @param {(port: number) => Promise<any>} start 接收显式端口，启动成功后返回 { port, ... }
 */
export async function startOnFetchablePort(start, {
  host = '127.0.0.1',
  maxAttempts = MAX_PORT_ATTEMPTS,
  onRetry = null,
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const port = await reserveFetchablePort({ host, maxAttempts, onRetry });
    let result;
    try {
      result = await start(port);
    } catch (error) {
      if (error?.code === 'EADDRINUSE' && attempt < maxAttempts) continue;
      throw error;
    }
    const actual = typeof result === 'number' ? result : (result?.port ?? port);
    if (isFetchBlockedPort(actual)) {
      throw new Error(`test-port-safe: 服务实际端口 ${actual} 命中 fetch blocked 列表`);
    }
    if (attempt > 1) onRetry?.(attempt, actual);
    return result;
  }
  throw new Error(`test-port-safe: 连续 ${maxAttempts} 次无法启动到可 fetch 端口`);
}

/**
 * 原生 http 请求（不受 undici blocked-port 限制），返回与 fetch Response 相近的最小接口：
 * { status, headers, body, text(), json() }。连接失败/超时一律 reject（绝不伪造 200）。
 */
export function httpRequest(url, {
  method = 'GET',
  headers = {},
  body = undefined,
  timeoutMs = 5000,
  signal = undefined,
} = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const req = http.request({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        // 兼容 fetch Response.headers.get()（部分测试断言 Allow/Content-Type 等安全头），
        // 同时保留 Node 原始小写键，非枚举 get 不会污染 deepEqual / JSON 展开。
        const headerBag = { ...res.headers };
        Object.defineProperty(headerBag, 'get', {
          value: (name) => {
            const key = String(name).toLowerCase();
            return Object.prototype.hasOwnProperty.call(res.headers, key) ? res.headers[key] : null;
          },
        });
        done(resolve, {
          status: res.statusCode,
          headers: headerBag,
          body: text,
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
      res.on('error', (error) => done(reject, error));
    });
    function onAbort() {
      req.destroy(new Error('test-port-safe: 请求已中止（AbortSignal）'));
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('timeout', () => req.destroy(new Error(`test-port-safe: 请求超时 ${url}`)));
    req.on('error', (error) => done(reject, error));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** POST JSON 的便捷封装（body 为对象时自动序列化）。 */
export function postJson(url, body, headers = {}, options = {}) {
  return httpRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...options,
  });
}
