// Isolated execute-first HTTP compatibility: real guard client + real route on ephemeral loopback.
// No DSH profile, production token, platform, or bridge state is accessed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { apply } from '../plugins/xhh-quota-guard/index.mjs';
import { XHH_QUOTA_TOOL_PREFIX } from '../plugins/xhh-quota-guard/decision.mjs';
import { createXhhAuthorizeRoutes } from '../src/core/xiaoheihe-authorize-route.mjs';
import { createXhhAuthorizeServer } from '../src/core/xiaoheihe-authorize-server.mjs';
import { listenFetchable, startOnFetchablePort } from './test-port-safe.mjs';

const TOKEN = 'isolated-fake-token';
const TOOL = 'mcp__xiaoheihe__get_home_content';

// 端口安全：本文件里向 bridgeUrl 发请求的是**被测插件内部的 fetch**（undici），
// 所以服务监听端口必须避开 fetch blocked 列表（listen(0) 有 ≈0.15%/次 假红）。
// 见 scripts/test-port-safe.mjs。
function listen(server) {
  return listenFetchable(server);
}

// createXhhAuthorizeServer 由服务自己 listen，因此用显式可 fetch 端口 + EADDRINUSE 重试。
function startAuthorizeServer(routes) {
  return startOnFetchablePort(async (port) => {
    const server = createXhhAuthorizeServer({ routes, port });
    const info = await server.start();
    return { server, info };
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function postJson(url, body, token) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': token }, body: JSON.stringify(body) });
}

function startGuard(options) {
  const listeners = new Map();
  const warnings = [];
  const guards = [];
  const ctx = {
    on: (name, fn) => { listeners.set(name, fn); return () => {}; },
    tools: { guard(fn) { guards.push(fn); return () => {}; } },
    logger: { warn: (message) => warnings.push(String(message)) },
  };
  apply(ctx, { enabled: true, timeoutMs: 500, ...options });
  return { ctx, listeners, warnings, guards };
}

function exec() {
  return {
    name: TOOL,
    arguments: { id: 'post-1', text: 'arg-SENSITIVE-TEXT' },
    agent: { id: 'isolated-session', session: { id: 'isolated-session' } },
    signal: { aborted: false },
  };
}

const next = async () => ({ isError: false, content: [{ type: 'text', text: 'tool-ok' }] });

async function execute(listeners, execValue = exec()) {
  const hook = listeners.get('tools/execute');
  assert.ok(hook, '必须注册 tools/execute');
  return hook(execValue, next);
}

test('HTTP execute-first：真实 route 完成 authorize(reserve)→commit(started)→next→complete', async () => {
  const audit = [];
  const completed = [];
  let authorizeCalls = 0;
  let commitCalls = 0;
  const routes = createXhhAuthorizeRoutes({
    consoleToken: TOKEN,
    backgroundSessionKeys: ['isolated-session'],
    audit: (event) => audit.push(event),
    authorizeApi: {
      authorize: async (request) => {
        authorizeCalls += 1;
        assert.equal(request.agentKey, 'isolated-session');
        return { ok: true, decision: 'allow', exemption: 'quota', ticket: { apiId: 'x', ticketId: 'ticket-1', kind: 'read' } };
      },
      commit: async (request) => { commitCalls += 1; return { ok: true, started: true, ticket: { ...request.ticket, state: 'started' } }; },
      abort: async () => ({ ok: true, aborted: true }),
      complete: async (request) => { completed.push(request); return { ok: true }; },
    },
  });
  const { server, info } = await startAuthorizeServer(routes);
  try {
    const { listeners } = startGuard({ bridgeUrl: `${info.url}/api/xiaoheihe`, consoleToken: TOKEN });
    const result = await execute(listeners);
    assert.equal(result.isError, false);
    assert.equal(authorizeCalls, 1);
    assert.equal(commitCalls, 1);
    assert.equal(completed.length, 1, 'read complete 应被 route 幂等确认');
    assert.equal(completed[0].agentKey, 'isolated-session', 'complete 必须透传 agentKey');
    assert.ok(audit.some((event) => event.type === 'authorize' && event.status === 200));
    assert.ok(audit.some((event) => event.type === 'commit' && event.decision === 'allow'));
  } finally {
    await server.stop();
  }
});

test('task-108：HTTP 配置非法时不抛错，降级 fail-closed（所有小黑盒工具 dispatch 前拒绝）', async () => {
  for (const config of [
    { bridgeUrl: 'http://127.0.0.1:12345' },
    { bridgeUrl: 'http://example.com:12345', consoleToken: 'test-token' },
    { bridgeUrl: 'http://127.0.0.1:12345', consoleToken: 'bad\ntoken' },
  ]) {
    const listeners = new Map();
    const warnings = [];
    const guards = [];
    const ctx = {
      on(event, listener) { listeners.set(event, listener); return () => {}; },
      tools: { guard(fn) { guards.push(fn); return () => {}; } },
      logger: { warn(message) { warnings.push(String(message)); } },
    };
    assert.doesNotThrow(() => apply(ctx, { enabled: true, ...config }), 'apply 不得抛错（否则 loader 可能卸载钩子）');
    assert.equal(typeof listeners.get('tools/execute'), 'function');
    assert.equal(guards.length, 1);
    assert.ok(warnings.length >= 1);
    for (const short of ['publish_content', 'get_home_content', 'search_content']) {
      const nextCalls = [];
      const result = await listeners.get('tools/execute')(
        { name: `${XHH_QUOTA_TOOL_PREFIX}${short}`, arguments: {}, agent: { id: 'isolated-session' } },
        async () => { nextCalls.push(true); return { isError: false }; },
      );
      assert.equal(nextCalls.length, 0, `非法配置下 ${short} 绝不 dispatch（含只读）`);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /fail-closed-no-authorization/);
    }
  }
});

test('wrong HTTP token：execute deny、不 dispatch、不泄漏凭据', async () => {
  let authorizeCalls = 0;
  const routes = createXhhAuthorizeRoutes({
    consoleToken: 'correct-isolated-token', backgroundSessionKeys: ['s'],
    authorizeApi: { authorize: async () => { authorizeCalls += 1; return { ok: true, decision: 'allow' }; }, commit: async () => ({ ok: true, started: true }), abort: async () => ({ ok: true }), complete: async () => ({ ok: true }) },
  });
  const { server, info } = await startAuthorizeServer(routes);
  try {
    const { listeners } = startGuard({ bridgeUrl: `${info.url}/api/xiaoheihe`, consoleToken: 'wrong-isolated-token' });
    const result = await execute(listeners);
    assert.equal(result.isError, true);
    assert.equal(authorizeCalls, 0);
    assert.doesNotMatch(JSON.stringify(result), /wrong-isolated-token|correct-isolated-token/);
  } finally {
    await server.stop();
  }
});

test('HTTP completion failure：告警但不改变工具结果', async () => {
  const requests = [];
  const routes = {
    async handleAuthorize() { requests.push('authorize'); return { status: 200, body: { ok: true, decision: 'allow', ticket: { apiId: 'x', ticketId: 'ticket-fake', kind: 'read' } } }; },
    async handleCommit() { requests.push('commit'); return { status: 200, body: { ok: true, started: true, ticket: { apiId: 'x', ticketId: 'ticket-fake', kind: 'read', state: 'started' } } }; },
    async handleComplete() { requests.push('complete'); return { status: 500, body: { ok: false, error: 'fake-error' } }; },
  };
  const { server, info } = await startAuthorizeServer(routes);
  try {
    const { listeners, warnings } = startGuard({ bridgeUrl: `${info.url}/api/xiaoheihe`, consoleToken: TOKEN });
    const result = await execute(listeners);
    assert.equal(result.isError, false);
    assert.deepEqual(requests, ['authorize', 'commit', 'complete']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /complete/);
    assert.doesNotMatch(warnings[0], /isolated-fake-token|ticket-fake/);
  } finally {
    await server.stop();
  }
});

test('HTTP 200 with unsuccessful completion produces a warning', async () => {
  const { server, info } = await startAuthorizeServer({
    handleAuthorize: async () => ({ status: 200, body: { ok: true, decision: 'allow', ticket: { apiId: 'x', ticketId: 'ticket', kind: 'read' } } }),
    handleCommit: async () => ({ status: 200, body: { ok: true, started: true, ticket: { apiId: 'x', ticketId: 'ticket', kind: 'read', state: 'started' } } }),
    handleComplete: async () => ({ status: 200, body: { ok: false, error: 'unknown-ticket' } }),
  });
  try {
    const { listeners, warnings } = startGuard({ bridgeUrl: `${info.url}/api/xiaoheihe`, consoleToken: 'isolated-token' });
    await execute(listeners);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /isolated-token|ticket/);
  } finally { await server.stop(); }
});

test('A1 30x 重定向：authorize 302 时 execute deny 且不跟随，目标端口零请求', async () => {
  const targetRequests = [];
  const target = http.createServer((req, res) => { targetRequests.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"decision":"allow"}'); });
  const targetInfo = await listen(target);
  const source = http.createServer((req, res) => { res.writeHead(302, { location: `${targetInfo.url}/authorize` }); res.end(); });
  const sourceInfo = await listen(source);
  try {
    const { listeners } = startGuard({ bridgeUrl: `${sourceInfo.url}/api/xiaoheihe`, consoleToken: 'redirect-guard-token' });
    const result = await execute(listeners);
    assert.equal(result.isError, true);
    assert.equal(targetRequests.length, 0, '不得跟随重定向到目标地址');
    assert.doesNotMatch(JSON.stringify(result), /redirect-guard-token/);
  } finally {
    await close(source);
    await close(target);
  }
});

test('A2 200 但坏 JSON/缺 ok/ok:false/缺 decision/非对象 → execute deny，固定文案且不回显正文', async () => {
  let current = { status: 200, body: '{}' };
  const server = http.createServer((req, res) => {
    res.writeHead(current.status, { 'content-type': 'application/json' });
    res.end(current.body);
  });
  const info = await listen(server);
  try {
    const { listeners } = startGuard({ bridgeUrl: `${info.url}/api/xiaoheihe`, consoleToken: 'bad-json-token' });
    const cases = [
      { status: 200, body: 'not-json-SENSITIVE-BODY' },
      { status: 200, body: '{"ok":true}' },
      { status: 200, body: '{"ok":false,"decision":"allow"}' },
      { status: 200, body: '{"decision":"allow"}' },
      { status: 200, body: '[]' },
      { status: 200, body: '{"ok":true,"decision":"maybe"}' },
    ];
    for (const item of cases) {
      current = item;
      const result = await execute(listeners);
      assert.equal(result.isError, true, item.body);
      assert.doesNotMatch(JSON.stringify(result), /SENSITIVE-BODY|not-json/, '不得回显响应正文');
    }
  } finally { await close(server); }
});

test('A3 complete 500/坏 JSON/超时 → 告警不崩溃；同一 exec 重复 post 只 complete 一次', async () => {
  let completeCount = 0;
  let completeMode = '500';
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/authorize')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, decision: 'allow', ticket: { apiId: 'x', ticketId: 'ticket-SENSITIVE-ID', kind: 'read' } }));
      return;
    }
    if (req.url.endsWith('/commit')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, started: true, ticket: { apiId: 'x', ticketId: 'ticket-SENSITIVE-ID', kind: 'read', state: 'started' } }));
      return;
    }
    completeCount += 1;
    if (completeMode === 'hang') return;
    if (completeMode === 'bad-json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('not-json-SENSITIVE-COMPLETE'); return; }
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"ok":false,"error":"SENSITIVE-COMPLETE-ERROR"}');
  });
  const info = await listen(server);
  try {
    for (const mode of ['500', 'bad-json', 'hang']) {
      completeMode = mode;
      const { listeners, warnings } = startGuard({ bridgeUrl: `${info.url}/api/xiaoheihe`, consoleToken: 'complete-token' });
      const target = exec();
      const first = await execute(listeners, target);
      assert.deepEqual(first, { isError: false, content: [{ type: 'text', text: 'tool-ok' }] });
      assert.equal(warnings.length, 1, `${mode}: 必须告警一次`);
      assert.doesNotMatch(JSON.stringify(warnings), /complete-token|ticket-SENSITIVE-ID|arg-SENSITIVE|SENSITIVE-COMPLETE/);
      await listeners.get('tools/post-execute')(target, { isError: false }, async () => ({ kind: 'allow' }));
      assert.equal(warnings.length, 1, `${mode}: 重复 post 不应再次告警`);
    }
    assert.equal(completeCount, 3, '每个 exec 只 complete 一次');
  } finally { await close(server); }
});

test('A4 失败路径日志/决策文本不泄漏 token、完整 ticket、args 原文', async () => {
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/authorize')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, decision: 'allow', ticket: { apiId: 'x', ticketId: 'ticket-FULL-SECRET-123', kind: 'read' } }));
      return;
    }
    if (req.url.endsWith('/commit')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, started: true, ticket: { apiId: 'x', ticketId: 'ticket-FULL-SECRET-123', kind: 'read', state: 'started' } }));
      return;
    }
    res.writeHead(500);
    res.end();
  });
  const info = await listen(server);
  try {
    const { listeners, warnings } = startGuard({ bridgeUrl: `${info.url}/api/xiaoheihe`, consoleToken: 'log-token-SECRET' });
    await execute(listeners);
    const joined = JSON.stringify(warnings);
    for (const secret of ['log-token-SECRET', 'ticket-FULL-SECRET-123', 'arg-SENSITIVE-TEXT']) {
      assert.ok(!joined.includes(secret), `日志不得包含 ${secret}`);
    }
  } finally { await close(server); }
});


test('complete 不带 agentKey 兼容旧行为；错误 agentKey 由服务端 invalid-ticket（不假装成功）', async () => {
  const seen = [];
  const routes = createXhhAuthorizeRoutes({
    consoleToken: TOKEN,
    backgroundSessionKeys: ['isolated-session'],
    authorizeApi: {
      authorize: async () => ({ ok: true, decision: 'allow', ticket: { apiId: 'x', ticketId: 't-complete', kind: 'read' } }),
      commit: async (request) => ({ ok: true, started: true, ticket: { ...request.ticket, state: 'started' } }),
      abort: async () => ({ ok: true }),
      complete: async (request) => {
        seen.push(request);
        if (request.agentKey === undefined) return { ok: true };
        return request.agentKey === 'isolated-session' ? { ok: true } : { ok: false, reason: 'invalid-ticket' };
      },
    },
  });
  const { server, info } = await startAuthorizeServer(routes);
  try {
    const ticket = { apiId: 'x', ticketId: 't-complete', kind: 'read', agentKey: 'isolated-session' };
    const legacy = await postJson(`${info.url}/api/xiaoheihe/complete`, { ticket, outcome: 'success' }, TOKEN);
    assert.equal(legacy.status, 200);
    assert.equal((await legacy.json()).ok, true, '不带 agentKey 的旧请求仍兼容');
    assert.equal(seen[0].agentKey, undefined);

    const wrong = await postJson(`${info.url}/api/xiaoheihe/complete`, { ticket, outcome: 'success', agentKey: 'wrong-session' }, TOKEN);
    assert.equal(wrong.status, 200);
    const wrongBody = await wrong.json();
    assert.equal(wrongBody.ok, false);
    assert.equal(wrongBody.reason, 'invalid-ticket', '错误 agentKey 必须由服务端拒绝');
  } finally {
    await server.stop();
  }
});
