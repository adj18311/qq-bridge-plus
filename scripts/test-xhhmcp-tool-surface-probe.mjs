#!/usr/bin/env node
// test-xhhmcp-tool-surface-probe.mjs —— 小黑盒 MCP 服务端「工具表」探针（离线）
//
// 全部用 127.0.0.1 上临时端口起的假 MCP 服务，不触达真实 19489、不触达 xiaoheihe.com。
// 覆盖：ok(JSON/SSE)、500、非 JSON-RPC、超时、tools 非法、连接拒绝、CLI --check 退出码与输出。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { probeMcpToolSurface } from './xhhmcp-tool-surface-probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_SCRIPT = path.join(ROOT, 'scripts', 'xhhmcp-tool-surface-probe.mjs');

/** 起一个临时 HTTP 服务，handler(req, res, parsedBody) 自行写响应。 */
async function startServer(handler) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = null;
      }
      try {
        handler(req, res, body);
      } catch (error) {
        res.statusCode = 500;
        res.end(String(error));
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function sendJson(res, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function sendSse(res, payload, headers = {}) {
  const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/** 标准 ok handler：initialize + tools/list，协议 JSON 或 SSE 可选。 */
function okHandler({ sse = false, names = ['beta', 'alpha', 'alpha'], sessionId = 'sess-test-1' } = {}) {
  const send = sse ? sendSse : sendJson;
  return (req, res, body) => {
    if (body && body.method === 'initialize') {
      send(res, rpcResult(body.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-xhh', version: '0.0.0' },
      }), sessionId === null ? {} : { 'mcp-session-id': sessionId });
      return;
    }
    if (body && body.method === 'tools/list') {
      send(res, rpcResult(body.id, { tools: names.map((name) => ({ name, description: 'x' })) }));
      return;
    }
    res.statusCode = 400;
    res.end('unexpected');
  };
}

test('探针 ok（JSON）：去重排序、协议版本、sessionId、elapsedMs', async () => {
  const server = await startServer(okHandler());
  try {
    const result = await probeMcpToolSurface({ url: server.url, timeoutMs: 2000 });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'ok');
    assert.deepEqual(result.toolNames, ['alpha', 'beta']);
    assert.equal(result.protocolVersion, '2025-06-18');
    assert.equal(result.sessionId, 'sess-test-1');
    assert.equal(typeof result.elapsedMs, 'number');
    assert.ok(result.elapsedMs >= 0 && result.elapsedMs < 5000);
  } finally {
    await server.close();
  }
});

test('探针 ok（SSE，真实服务端形状）：仍能解析，sessionId 为空', async () => {
  const server = await startServer(okHandler({ sse: true, names: ['only'], sessionId: null }));
  try {
    const result = await probeMcpToolSurface({ url: server.url, timeoutMs: 2000 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.toolNames, ['only']);
    assert.equal(result.sessionId, null);
    assert.equal(result.protocolVersion, '2025-06-18');
  } finally {
    await server.close();
  }
});

test('探针失败：HTTP 500 → http-error', async () => {
  const server = await startServer((req, res) => {
    res.statusCode = 500;
    res.end('boom');
  });
  try {
    const result = await probeMcpToolSurface({ url: server.url, timeoutMs: 2000 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'http-error');
    assert.deepEqual(result.toolNames, []);
  } finally {
    await server.close();
  }
});

test('探针失败：响应不是 JSON-RPC（非 JSON / 缺 result）→ bad-jsonrpc', async () => {
  const notJson = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello, not json');
  });
  try {
    const r1 = await probeMcpToolSurface({ url: notJson.url, timeoutMs: 2000 });
    assert.equal(r1.ok, false);
    assert.equal(r1.reason, 'bad-jsonrpc');
  } finally {
    await notJson.close();
  }

  const wrongShape = await startServer((req, res) => sendJson(res, { jsonrpc: '1.0', id: 1, result: {} }));
  try {
    const r2 = await probeMcpToolSurface({ url: wrongShape.url, timeoutMs: 2000 });
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'bad-jsonrpc');
  } finally {
    await wrongShape.close();
  }
});

test('探针失败：tools 非法（非数组 / name 不是非空字符串）→ invalid-tools', async () => {
  for (const badTools of [null, 'nope', [{ name: '' }], [{ name: 7 }], [{ description: 'no name' }], [null]]) {
    const server = await startServer((req, res, body) => {
      if (body.method === 'initialize') {
        sendJson(res, rpcResult(body.id, { protocolVersion: '2025-06-18' }));
        return;
      }
      sendJson(res, rpcResult(body.id, { tools: badTools }));
    });
    try {
      const result = await probeMcpToolSurface({ url: server.url, timeoutMs: 2000 });
      assert.equal(result.ok, false, `应拒绝 tools=${JSON.stringify(badTools)}`);
      assert.equal(result.reason, 'invalid-tools');
    } finally {
      await server.close();
    }
  }
});

test('探针失败：服务端不响应 → timeout（且不拖过预算太多）', async () => {
  const server = await startServer(() => {});
  try {
    const started = Date.now();
    const result = await probeMcpToolSurface({ url: server.url, timeoutMs: 150 });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'timeout');
    assert.ok(elapsed < 3000, `超时预算外拖太久：${elapsed}ms`);
  } finally {
    await server.close();
  }
});

test('探针失败：连接拒绝 → unreachable', async () => {
  const server = await startServer(okHandler());
  const { url } = server;
  await server.close();
  const result = await probeMcpToolSurface({ url, timeoutMs: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unreachable');
});

test('CLI：--check --json 成功退出 0，单行 JSON 且标注用途', async () => {
  const server = await startServer(okHandler({ names: ['get_home_content', 'search_content'] }));
  try {
    const { code, stdout, stderr } = await runCli(['--check', '--json', `--url=${server.url}`]);
    assert.equal(code, 0, stderr);
    const line = stdout.trim().split('\n').filter(Boolean).at(-1);
    const payload = JSON.parse(line);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.toolNames, ['get_home_content', 'search_content']);
    assert.equal(payload.protocolVersion, '2025-06-18');
  } finally {
    await server.close();
  }
});

test('CLI：--check 失败退出 1，文本明确标注"服务端工具表 ≠ DSH 已注册"', async () => {
  const server = await startServer(okHandler({ names: ['a', 'b'] }));
  const { url } = server;
  await server.close();
  const { code, stdout, stderr } = await runCli(['--check', `--url=${url}`]);
  assert.equal(code, 1, `stdout=${stdout} stderr=${stderr}`);
  const all = `${stdout}\n${stderr}`;
  assert.match(all, /服务端工具表/);
  assert.match(all, /不等于\s*DSH\s*已注册|DSH 已注册/);
});

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROBE_SCRIPT, ...args], { cwd: ROOT, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
