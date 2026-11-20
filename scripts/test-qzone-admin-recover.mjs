import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { main } from './qzone-admin-recover.mjs';

const PASSWORD = 'synthetic-qqspace-password';
const CONSOLE_TOKEN = 'synthetic-console-token';

async function fixture(t, handler) {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    let parsed;
    try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = null; }
    try { await handler({ request, response, body: parsed, rawBody: body }); }
    catch { response.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function invoke(baseUrl, secrets, extra = {}) {
  const rawModes = [];
  const input = new EventEmitter();
  input.isTTY = true;
  input.setRawMode = (enabled) => { rawModes.push(enabled); };
  input.pause = () => {};
  let nextSecret = 0;
  input.resume = () => {
    const secret = secrets[nextSecret++];
    queueMicrotask(() => input.emit('data', Buffer.from(`${secret ?? ''}\n`)));
  };
  const output = { stdout: '', stderr: '' };
  return {
    rawModes,
    output,
    run: () => main(['--url', baseUrl, '--layer', 'write', '--reason', 'network'], {
      input,
      promptOutput: { write: (value) => { output.stderr += value; } },
      stdout: (value) => { output.stdout += value; },
      stderr: (value) => { output.stderr += value; },
      ...extra,
    }),
  };
}

test('恢复经 loopback HTTP 先 verify 再 restore，凭据仅经隐藏输入且身份审计由服务端会话确定', async (t) => {
  const calls = [];
  const baseUrl = await fixture(t, ({ request, response, body }) => {
    calls.push({ method: request.method, url: request.url, cookie: request.headers.cookie, body });
    if (request.url === '/api/console/qqspace-column/auth/verify') {
      assert.equal(request.method, 'POST');
      assert.deepEqual(body, { password: PASSWORD });
      assert.equal(request.headers['x-console-token'], CONSOLE_TOKEN);
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'qqspace_column_session=verified-session-1234567890; HttpOnly; SameSite=Strict' });
      response.end('{"ok":true}');
      return;
    }
    assert.equal(request.url, '/api/console/qqspace-column/pause/restore');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.cookie, 'qqspace_column_session=verified-session-1234567890');
    assert.deepEqual(body, { layer: 'write', reason: 'network' });
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  const run = invoke(baseUrl, [CONSOLE_TOKEN, PASSWORD]);
  assert.equal(await run.run(), 0);
  assert.deepEqual(run.rawModes, [true, false, true, false]);
  assert.equal(calls.length, 2);
  assert.equal(run.output.stdout.includes(CONSOLE_TOKEN), false);
  assert.equal(run.output.stdout.includes(PASSWORD), false);
  assert.equal(run.output.stderr.includes(CONSOLE_TOKEN), false);
  assert.equal(run.output.stderr.includes(PASSWORD), false);
});

test('认证失败、重定向、超大响应均不重试且绝不调用恢复接口', async (t) => {
  for (const [name, verifyResponse] of [
    ['认证拒绝', (response) => response.writeHead(423, { 'content-type': 'application/json' }).end('{"ok":false,"reason":"locked"}')],
    ['重定向', (response) => response.writeHead(302, { location: '/elsewhere' }).end()],
    ['伪造 JSON 类型', (response) => response.writeHead(200, { 'content-type': 'text/plain; note=application/json', 'set-cookie': 'qqspace_column_session=verified-session-1234567890' }).end('{"ok":true}')],
    ['超大响应', (response) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, padding: 'x'.repeat(1024 * 1024) }))],
  ]) {
    let verifyCount = 0;
    let restoreCount = 0;
    const baseUrl = await fixture(t, ({ request, response }) => {
      if (request.url.endsWith('/auth/verify')) { verifyCount++; verifyResponse(response); }
      else { restoreCount++; response.writeHead(200).end('{"ok":true}'); }
    });
    const run = invoke(baseUrl, [CONSOLE_TOKEN, PASSWORD]);
    assert.notEqual(await run.run(), 0, name);
    assert.equal(verifyCount, 1, `${name}: no retry`);
    assert.equal(restoreCount, 0, `${name}: no restore/fallback`);
  }
});

test('恢复请求失败不重试且不调用任何本地回退', async (t) => {
  let verifyCount = 0;
  let restoreCount = 0;
  const baseUrl = await fixture(t, ({ request, response }) => {
    if (request.url.endsWith('/auth/verify')) {
      verifyCount++;
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'qqspace_column_session=verified-session-1234567890; HttpOnly' }).end('{"ok":true}');
      return;
    }
    restoreCount++;
    response.writeHead(503, { 'content-type': 'application/json' }).end('{"ok":false}');
  });
  const run = invoke(baseUrl, [CONSOLE_TOKEN, PASSWORD]);
  assert.notEqual(await run.run(), 0);
  assert.equal(verifyCount, 1);
  assert.equal(restoreCount, 1);
  assert.match(run.output.stderr, /未重试，未执行本地回退/);
});

test('恢复请求发出后断连视为结果未确认，不重试或宣称未执行', async (t) => {
  let restores = 0;
  const baseUrl = await fixture(t, ({ request, response }) => {
    if (request.url.endsWith('/auth/verify')) {
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'qqspace_column_session=verified-session-1234567890' }).end('{"ok":true}');
    } else { restores++; request.socket.destroy(); }
  });
  const run = invoke(baseUrl, [CONSOLE_TOKEN, PASSWORD]);
  assert.notEqual(await run.run(), 0);
  assert.equal(restores, 1);
  assert.match(run.output.stderr, /未确认/);
  assert.doesNotMatch(run.output.stderr, /暂停状态未更改|未执行恢复/);
});

test('非 loopback 地址被拒绝，未发出请求', async () => {
  const run = invoke('http://example.com', [CONSOLE_TOKEN, PASSWORD]);
  assert.notEqual(await run.run(), 0);
  assert.deepEqual(run.rawModes, []);
});

test('凭据不能通过参数传入；非交互 CLI 在任何网络请求前拒绝执行', async () => {
  const code = await main(['--url', 'http://127.0.0.1:3100', '--layer', 'write', '--reason', 'network', '--password', PASSWORD], {
    input: { isTTY: false }, stdout() {}, stderr() {},
  });
  assert.notEqual(code, 0);

  const cli = spawnSync(process.execPath, [resolve('scripts/qzone-admin-recover.mjs'), '--url', 'http://127.0.0.1:1',
    '--layer', 'both', '--reason', 'other'], { encoding: 'utf8', input: '' });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /交互式终端/);
});

test('输入终端关闭时结束读取、退出原始模式且不发请求', async () => {
  for (const event of ['end', 'close', 'error']) {
    const input = new EventEmitter();
    const modes = [];
    input.isTTY = true;
    input.setRawMode = (value) => modes.push(value);
    input.pause = () => {};
    input.resume = () => queueMicrotask(() => input.emit(event, new Error('synthetic terminal failure')));
    const result = await Promise.race([
      main(['--url', 'http://127.0.0.1:1', '--layer', 'write', '--reason', 'network'],
        { input, promptOutput: { write() {} }, stdout() {}, stderr() {} }),
      new Promise((resolve) => setTimeout(() => resolve('stuck'), 100)),
    ]);
    assert.equal(result, 2);
    assert.deepEqual(modes, [true, false]);
  }
});
