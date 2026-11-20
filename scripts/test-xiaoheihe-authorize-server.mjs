// scripts/test-xiaoheihe-authorize-server.mjs
// task-48：授权端点 HTTP 服务器工厂测试（TDD 先红后绿）。
// 覆盖：回环绑定拒绝 / 404/405/415/413/400 / authorize+complete 透传 / 500 不泄露 /
// 408(read)/504(handler) 超时且绝不放行 / start-stop 幂等 / 并发 / 端口占用报错。
// 全部离线：真实 127.0.0.1 临时端口 + fetch；不 import bridge、不读 config/state。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  XHH_AUTHORIZE_SERVER_DEFAULTS,
  createXhhAuthorizeServer,
} from '../src/core/xiaoheihe-authorize-server.mjs';
// 端口安全：本文件的请求全部由测试自己发出（服务监听 OS 临时端口），改用原生 http，
// 避免 listen(0) 落到 undici fetch 的 blocked-port 列表导致 `fetch failed (bad port)` 假红。
// 见 scripts/test-port-safe.mjs（httpRequest.headers 兼容 fetch 的 headers.get()）。
import { httpRequest, postJson } from './test-port-safe.mjs';

const AUTHORIZE_PATH = '/api/xiaoheihe/authorize';
const COMMIT_PATH = '/api/xiaoheihe/commit';
const ABORT_PATH = '/api/xiaoheihe/abort';
const COMPLETE_PATH = '/api/xiaoheihe/complete';
const TOKEN = 'server-test-token-0123456789';

function makeRoutes(overrides = {}) {
  const calls = { authorize: [], commit: [], abort: [], complete: [] };
  return {
    calls,
    async handleAuthorize(request) {
      calls.authorize.push(request);
      if (typeof overrides.authorize === 'function') return overrides.authorize(request);
      return { status: 200, body: { ok: true, decision: 'allow', exemption: 'quota', ticket: { id: 't-1' } } };
    },
    async handleCommit(request) {
      calls.commit.push(request);
      if (typeof overrides.commit === 'function') return overrides.commit(request);
      return { status: 200, body: { ok: true, started: true } };
    },
    async handleAbort(request) {
      calls.abort.push(request);
      if (typeof overrides.abort === 'function') return overrides.abort(request);
      return { status: 200, body: { ok: true, aborted: true } };
    },
    async handleComplete(request) {
      calls.complete.push(request);
      if (typeof overrides.complete === 'function') return overrides.complete(request);
      return { status: 200, body: { ok: true, already: false, completed: true } };
    },
  };
}

async function startServer(options = {}) {
  const routes = options.routes ?? makeRoutes();
  const server = createXhhAuthorizeServer({ routes, ...options });
  const info = await server.start();
  return { server, routes, info };
}

function post(url, body, headers = {}) {
  return postJson(url, body, headers);
}

test('exports: 默认值（127.0.0.1 / port 0 / 64KiB / 2000ms）与工厂', () => {
  assert.equal(XHH_AUTHORIZE_SERVER_DEFAULTS.host, '127.0.0.1');
  assert.equal(XHH_AUTHORIZE_SERVER_DEFAULTS.port, 0);
  assert.equal(XHH_AUTHORIZE_SERVER_DEFAULTS.maxBodyBytes, 64 * 1024);
  assert.equal(XHH_AUTHORIZE_SERVER_DEFAULTS.requestTimeoutMs, 2000);
  assert.equal(typeof createXhhAuthorizeServer, 'function');
});

test('构造校验：routes 必填、非回环 host 拒绝、端口/限额/超时非法拒绝', () => {
  const routes = makeRoutes();
  assert.throws(() => createXhhAuthorizeServer({}), TypeError);
  assert.throws(() => createXhhAuthorizeServer({ routes: {} }), TypeError);
  for (const host of ['0.0.0.0', '192.168.1.5', '::', 'example.com', '', 42]) {
    assert.throws(() => createXhhAuthorizeServer({ routes, host }), TypeError, String(host));
  }
  for (const port of [-1, 65536, 1.5, '0']) {
    assert.throws(() => createXhhAuthorizeServer({ routes, port }), TypeError, String(port));
  }
  for (const maxBodyBytes of [0, -1, 1.5, '1024']) {
    assert.throws(() => createXhhAuthorizeServer({ routes, maxBodyBytes }), TypeError, String(maxBodyBytes));
  }
  for (const requestTimeoutMs of [0, -1, 1.5, '2000']) {
    assert.throws(() => createXhhAuthorizeServer({ routes, requestTimeoutMs }), TypeError, String(requestTimeoutMs));
  }
});

test('生命周期：address() 未启动为 null；start 幂等；stop 幂等且可重启；url 为 127.0.0.1', async () => {
  const routes = makeRoutes();
  const server = createXhhAuthorizeServer({ routes });
  assert.equal(server.address(), null);

  const first = await server.start();
  assert.equal(typeof first.port, 'number');
  assert.ok(first.port > 0);
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(server.address().port, first.port);

  const again = await server.start();
  assert.equal(again.port, first.port, '重复 start 必须复用同一监听');
  assert.equal(again.url, first.url);

  assert.deepEqual(await server.stop(), { stopped: true });
  assert.deepEqual(await server.stop(), { stopped: false }, '重复 stop 安全');
  assert.equal(server.address(), null);

  const restarted = await server.start();
  assert.ok(restarted.port > 0);
  await server.stop();
});

test('404/405：未知路径 404（先于方法），已知路径非 POST 405 + Allow: POST', async () => {
  const { server, routes, info } = await startServer();
  try {
    const notFound = await post(`${info.url}/api/xiaoheihe/nope`, {});
    assert.equal(notFound.status, 404);
    assert.deepEqual(await notFound.json(), { ok: false, error: 'not-found' });

    const getAuthorize = await httpRequest(`${info.url}${AUTHORIZE_PATH}`);
    assert.equal(getAuthorize.status, 405);
    assert.equal(getAuthorize.headers.get('allow'), 'POST');
    const getComplete = await httpRequest(`${info.url}${COMPLETE_PATH}`);
    assert.equal(getComplete.status, 405);

    const put = await httpRequest(`${info.url}${AUTHORIZE_PATH}`, { method: 'PUT', body: '{}' });
    assert.equal(put.status, 405);
    assert.equal(routes.calls.authorize.length, 0, '方法/路径错误不调用 routes');
  } finally {
    await server.stop();
  }
});

test('415：缺失/错误 Content-Type 拒绝（text/plain、无 header、application/json; charset=utf-8 允许）', async () => {
  const { server, routes, info } = await startServer();
  try {
    const text = await httpRequest(`${info.url}${AUTHORIZE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength('{}')) },
      body: '{}',
    });
    assert.equal(text.status, 415);
    assert.deepEqual(await text.json(), { ok: false, error: 'unsupported-media-type' });

    const noHeader = await httpRequest(`${info.url}${AUTHORIZE_PATH}`, { method: 'POST', body: '{}' });
    assert.equal(noHeader.status, 415);

    const withCharset = await post(`${info.url}${AUTHORIZE_PATH}`, { agentKey: 'a' }, { 'content-type': 'application/json; charset=utf-8' });
    assert.equal(withCharset.status, 200);
    assert.equal(routes.calls.authorize.length, 1);
  } finally {
    await server.stop();
  }
});

test('413：请求体超过 maxBodyBytes → 413 且不解析、不调用 routes', async () => {
  const { server, routes, info } = await startServer({ maxBodyBytes: 64 });
  try {
    const big = JSON.stringify({ agentKey: 'a', tool: 'get_home_content', args: {}, padding: 'x'.repeat(500) });
    const response = await post(`${info.url}${AUTHORIZE_PATH}`, big);
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { ok: false, error: 'payload-too-large' });
    assert.equal(routes.calls.authorize.length, 0);
  } finally {
    await server.stop();
  }
});

test('400：非法 JSON / 空 body → 400 固定错误码，不调用 routes', async () => {
  const { server, routes, info } = await startServer();
  try {
    const bad = await post(`${info.url}${AUTHORIZE_PATH}`, '{bad json');
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { ok: false, error: 'invalid-json' });

    const empty = await post(`${info.url}${AUTHORIZE_PATH}`, '');
    assert.equal(empty.status, 400);
    assert.deepEqual(await empty.json(), { ok: false, error: 'invalid-json' });

    const array = await post(`${info.url}${AUTHORIZE_PATH}`, '[]');
    assert.equal(array.status, 200, '数组是合法 JSON；由 routes 决定 400（服务端只负责 JSON 解析）');
    assert.equal(routes.calls.authorize.length, 1);
  } finally {
    await server.stop();
  }
});

test('authorize 透传：headers/body 交给 routes，status/body 原样返回；401/403 也透传', async () => {
  const routes = makeRoutes({
    authorize: async ({ headers, body }) => {
      if (headers['x-console-token'] === 'missing') return { status: 401, body: { ok: false, error: 'unauthorized' } };
      if (headers['x-console-token'] === 'wrong') return { status: 403, body: { ok: false, error: 'forbidden' } };
      return { status: 200, body: { ok: true, decision: 'deny', reason: 'read-daily-cap', echo: body.agentKey } };
    },
  });
  const { server, info } = await startServer({ routes });
  try {
    const allow = await post(`${info.url}${AUTHORIZE_PATH}`, { agentKey: 'patrol:background' }, { 'x-console-token': TOKEN });
    assert.equal(allow.status, 200);
    assert.deepEqual(await allow.json(), { ok: true, decision: 'deny', reason: 'read-daily-cap', echo: 'patrol:background' });

    const unauthorized = await post(`${info.url}${AUTHORIZE_PATH}`, {}, { 'x-console-token': 'missing' });
    assert.equal(unauthorized.status, 401);
    const forbidden = await post(`${info.url}${AUTHORIZE_PATH}`, {}, { 'x-console-token': 'wrong' });
    assert.equal(forbidden.status, 403);

    const request = routes.calls.authorize[0];
    assert.equal(request.headers['x-console-token'], TOKEN, '必须把 headers 交给 routes');
    assert.deepEqual(request.body, { agentKey: 'patrol:background' });
  } finally {
    await server.stop();
  }
});

test('complete 透传：POST /complete 走 handleComplete，status/body 原样返回', async () => {
  const routes = makeRoutes({
    complete: async ({ body }) => ({ status: 200, body: { ok: true, already: true, outcome: body.outcome } }),
  });
  const { server, info } = await startServer({ routes });
  try {
    const response = await post(`${info.url}${COMPLETE_PATH}`, { ticket: { apiId: 'a' }, outcome: 'unknown' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, already: true, outcome: 'unknown' });
    assert.equal(routes.calls.complete.length, 1);
    assert.equal(routes.calls.complete[0].body.outcome, 'unknown');
  } finally {
    await server.stop();
  }
});

test('500：routes 抛错 → 固定 internal-error，不回显堆栈/token；logger 只记固定字段', async () => {
  const logs = [];
  const routes = makeRoutes({
    authorize: async () => {
      throw new Error(`boom ${TOKEN}`);
    },
  });
  const logger = {
    warn: (...args) => logs.push(args),
    error: (...args) => logs.push(args),
    info: (...args) => logs.push(args),
  };
  const { server, info } = await startServer({ routes, logger });
  try {
    const response = await post(`${info.url}${AUTHORIZE_PATH}`, { agentKey: 'a' }, { 'x-console-token': TOKEN });
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { ok: false, error: 'internal-error' });
    assert.ok(!text.includes(TOKEN), '响应不得回显 token');
    assert.ok(!/at .*\.mjs|Error: boom/.test(text), '响应不得回显堆栈/内部异常');
    const logText = JSON.stringify(logs);
    assert.ok(!logText.includes(TOKEN), '日志不得包含 token');
    assert.ok(!logText.includes('{"agentKey"'), '日志不得包含 body 原文');
  } finally {
    await server.stop();
  }
});

test('504：routes 处理超过 requestTimeoutMs → gateway-timeout，绝不放行', async () => {
  const routes = makeRoutes({ authorize: () => new Promise(() => {}) });
  const { server, info } = await startServer({ routes, requestTimeoutMs: 250 });
  try {
    const started = Date.now();
    const response = await post(`${info.url}${AUTHORIZE_PATH}`, { agentKey: 'a' });
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { ok: false, error: 'gateway-timeout' });
    assert.ok(Date.now() - started < 2000, '超时响应应及时返回');
  } finally {
    await server.stop();
  }
});

test('408：请求体读取超过 requestTimeoutMs → request-timeout，并销毁连接', async () => {
  const { server, info } = await startServer({ requestTimeoutMs: 250 });
  const port = Number(new URL(info.url).port);
  try {
    const raw = await new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.write(
          `POST ${AUTHORIZE_PATH} HTTP/1.1\r\n`
          + 'Host: 127.0.0.1\r\n'
          + 'Content-Type: application/json\r\n'
          + 'Content-Length: 100\r\n'
          + '\r\n'
          + '{"agentKey":',
        );
      });
      let buffer = '';
      socket.setEncoding('utf8');
      socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('socket timeout')); });
      socket.on('data', (chunk) => { buffer += chunk; });
      socket.on('end', () => { socket.destroy(); resolve(buffer); });
      socket.on('close', () => resolve(buffer));
      socket.on('error', (error) => { if (buffer === '') reject(error); });
    });
    assert.match(raw, /HTTP\/1\.1 408/, '必须返回 408');
    assert.match(raw, /request-timeout/);
  } finally {
    await server.stop();
  }
});

test('stop 期间挂起请求：stop 关闭连接；调用方不会无限等待；stop 幂等', async () => {
  const routes = makeRoutes({ authorize: () => new Promise(() => {}) });
  const { server, info } = await startServer({ routes, requestTimeoutMs: 10_000 });
  const pending = post(`${info.url}${AUTHORIZE_PATH}`, { agentKey: 'a' }).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await server.stop(), { stopped: true });
  const outcome = await pending;
  assert.ok(outcome instanceof Error, '挂起请求应因连接关闭而失败，而不是永久挂起');
  assert.deepEqual(await server.stop(), { stopped: false });
});

test('并发请求：10 个并发 POST 全部正确响应', async () => {
  const routes = makeRoutes({
    authorize: async ({ body }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { status: 200, body: { ok: true, decision: 'allow', agentKey: body.agentKey } };
    },
  });
  const { server, info } = await startServer({ routes });
  try {
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) => post(`${info.url}${AUTHORIZE_PATH}`, { agentKey: `agent-${index}` }).then((r) => r.json())),
    );
    assert.equal(responses.length, 10);
    responses.forEach((body, index) => assert.equal(body.agentKey, `agent-${index}`));
  } finally {
    await server.stop();
  }
});

test('端口占用：第二个 server.start() 以 EADDRINUSE/占用错误拒绝；失败实例 stop 安全', async () => {
  const first = await startServer();
  try {
    const second = createXhhAuthorizeServer({ routes: makeRoutes(), port: first.info.port });
    await assert.rejects(() => second.start(), (error) => {
      assert.match(String(error?.message ?? error), /EADDRINUSE|占用|address already in use/i);
      return true;
    });
    assert.deepEqual(await second.stop(), { stopped: false });
  } finally {
    await first.server.stop();
  }
});

test('响应安全头：application/json + no-store + nosniff', async () => {
  const { server, info } = await startServer();
  try {
    const response = await post(`${info.url}${AUTHORIZE_PATH}`, {});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await server.stop();
  }
});

test('commit/abort 端点路由：POST + JSON 透传 routes 结果；非 POST 405；未知路径仍 404', async () => {
  const { server, routes, info } = await startServer();
  try {
    for (const [pathname, handler] of [[COMMIT_PATH, routes.calls.commit], [ABORT_PATH, routes.calls.abort]]) {
      const response = await post(`${info.url}${pathname}`, { ticket: { ticketId: 't-1' } });
      assert.equal(response.status, 200, pathname);
      assert.equal((await response.json()).ok, true, pathname);
      assert.equal(handler.length, 1, `${pathname} 必须调用对应 handler`);
      const get = await httpRequest(`${info.url}${pathname}`, { method: 'GET' });
      assert.equal(get.status, 405, `${pathname} 非 POST 必须 405`);
    }
    const unknown = await post(`${info.url}/api/xiaoheihe/unknown`, {});
    assert.equal(unknown.status, 404);
  } finally {
    await server.stop();
  }
});

test('兼容：旧 routes 只有 authorize/complete 仍可构造；commit/abort 端点 fail-closed 500', async () => {
  const legacyRoutes = {
    async handleAuthorize() { return { status: 200, body: { ok: true, decision: 'allow' } }; },
    async handleComplete() { return { status: 200, body: { ok: true } }; },
  };
  const server = createXhhAuthorizeServer({ routes: legacyRoutes });
  const info = await server.start();
  try {
    const authorize = await post(`${info.url}${AUTHORIZE_PATH}`, {});
    assert.equal(authorize.status, 200);
    const commit = await post(`${info.url}${COMMIT_PATH}`, { ticket: { ticketId: 'x' } });
    assert.equal(commit.status, 500);
    assert.deepEqual(await commit.json(), { ok: false, error: 'internal-error' });
  } finally {
    await server.stop();
  }
});
