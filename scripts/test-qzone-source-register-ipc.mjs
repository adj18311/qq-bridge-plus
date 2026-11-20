// C11：来源登记 IPC 的定向测试（真 server + 真 client，127.0.0.1 回环；register 是假的）。
//
// 不启动 bridge、不发任何真实 QQ 请求。运行：node scripts/test-qzone-source-register-ipc.mjs
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  readQzoneSourceRegisterConfig,
  createQzoneSourceRegisterIpcServer,
  createQzoneSourceRegisterIpcClient,
  QZONE_SOURCE_REGISTER_PATH,
  QZONE_SOURCE_ORIGINS,
  QZONE_SOURCE_REGISTER_KEYS,
} from '../src/qzone-source-register-ipc.mjs';

const TOKEN = 'S'.repeat(43);
const SESSION = 'sess-c11';
const REQUEST = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const clock = () => Date.now();

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (error) { results.push(['FAIL', name + ' :: ' + (error?.message ?? error)]); }
}

/** 记录每次 register 调用，用于断言"零调用"与参数正确性。 */
function makeRegister({ result } = {}) {
  const calls = [];
  const register = async (sessionId, input) => {
    calls.push({ sessionId, requestId: input?.requestId, origin: input?.origin });
    if (result === 'throw') throw new Error('register blew up');
    if (result === 'refuse') return { ok: false };
    return { ok: true };
  };
  return { register, calls };
}

async function withServer(options, fn) {
  const server = await createQzoneSourceRegisterIpcServer({ token: TOKEN, clock, ...options });
  const client = createQzoneSourceRegisterIpcClient({
    origin: 'http://127.0.0.1:' + server.port, token: TOKEN, timeoutMs: 3000,
  });
  try { await fn({ server, client }); }
  finally { try { await client.close(); } catch {} try { await server.close(); } catch {} }
}

/** 手写 HTTP，绕过 client 看协议层状态码。 */
function raw(port, { method = 'POST', path = QZONE_SOURCE_REGISTER_PATH, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method,
      headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ── 1. 正控：合法登记 ────────────────────────────────────────────────────────────────────
await test('C11-01 合法登记 ⇒ true，register 收到正确的 sessionId/requestId/origin', async () => {
  const fake = makeRegister();
  await withServer({ register: fake.register }, async ({ client }) => {
    assert.equal(await client.register(SESSION, { requestId: REQUEST, origin: 'qq-inbound' }), true);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0], { sessionId: SESSION, requestId: REQUEST, origin: 'qq-inbound' });
    // schedule 也必须被接受（闭集里的第二个值）
    assert.equal(await client.register(SESSION, { requestId: REQUEST + '-b', origin: 'schedule' }), true);
    assert.equal(fake.calls[1].origin, 'schedule');
  });
});

// ── 2. origin 不在闭集 ⇒ 403，register 零调用 ────────────────────────────────────────────
await test("C11-02 origin 'web-ui' ⇒ 403 invalid-origin，register 零调用", async () => {
  const fake = makeRegister();
  await withServer({ register: fake.register }, async ({ server }) => {
    for (const origin of ['web-ui', 'QQ-INBOUND', '', 'admin']) {
      const r = await raw(server.port, {
        headers: { authorization: 'Bearer ' + TOKEN },
        body: JSON.stringify({ sessionId: SESSION, requestId: REQUEST, origin }),
      });
      assert.equal(r.status, 403, origin);
      assert.equal(JSON.parse(r.text).error, 'invalid-origin');
    }
    assert.equal(fake.calls.length, 0, '非法 origin 绝不能到达 register');
  });
});

// ── 3. 鉴权 ──────────────────────────────────────────────────────────────────────────────
await test('C11-03 缺 token / 错 token ⇒ 401，register 零调用', async () => {
  const fake = makeRegister();
  await withServer({ register: fake.register }, async ({ server }) => {
    const body = JSON.stringify({ sessionId: SESSION, requestId: REQUEST, origin: 'qq-inbound' });
    const missing = await raw(server.port, { body });
    assert.equal(missing.status, 401);
    const wrong = await raw(server.port, { headers: { authorization: 'Bearer ' + 'X'.repeat(43) }, body });
    assert.equal(wrong.status, 401);
    // 正确 token 长度不同也必须拒绝（定长比较）
    const short = await raw(server.port, { headers: { authorization: 'Bearer short' }, body });
    assert.equal(short.status, 401);
    assert.equal(fake.calls.length, 0);
    // 未授权时连路径都不该被确认（404 也不应出现在 body 里暴露路径）
    assert.ok(!missing.text.includes('not-found'));
  });
  // client 侧：错 token ⇒ false 且不抛
  const fake2 = makeRegister();
  const server = await createQzoneSourceRegisterIpcServer({ register: fake2.register, token: TOKEN, clock });
  try {
    const badClient = createQzoneSourceRegisterIpcClient({
      origin: 'http://127.0.0.1:' + server.port, token: 'Y'.repeat(43), timeoutMs: 3000,
    });
    try {
      assert.equal(await badClient.register(SESSION, { requestId: REQUEST, origin: 'qq-inbound' }), false);
    } finally { await badClient.close(); }
    assert.equal(fake2.calls.length, 0);
  } finally { await server.close(); }
});

// ── 4. requestId 形状 ───────────────────────────────────────────────────────────────────
await test('C11-04 requestId 超长 / 空 ⇒ 400 invalid-frame，register 零调用', async () => {
  const fake = makeRegister();
  await withServer({ register: fake.register }, async ({ server }) => {
    for (const requestId of ['x'.repeat(129), '', '   ' + '', 'a'.repeat(200)]) {
      const r = await raw(server.port, {
        headers: { authorization: 'Bearer ' + TOKEN },
        body: JSON.stringify({ sessionId: SESSION, requestId, origin: 'qq-inbound' }),
      });
      assert.equal(r.status, 400, 'requestId=' + JSON.stringify(requestId).slice(0, 20));
      assert.equal(JSON.parse(r.text).error, 'invalid-frame');
    }
    // 恰好 128 字符是允许的边界
    const edge = await raw(server.port, {
      headers: { authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ sessionId: SESSION, requestId: 'a'.repeat(128), origin: 'qq-inbound' }),
    });
    assert.equal(edge.status, 200);
    assert.equal(fake.calls.length, 1);
  });
});

// ── 5. server 关闭后 client 返回 false 且不抛 ───────────────────────────────────────────
await test('C11-05 server 关闭后 register ⇒ false，不抛', async () => {
  const fake = makeRegister();
  const server = await createQzoneSourceRegisterIpcServer({ register: fake.register, token: TOKEN, clock });
  const port = server.port;
  await server.close();
  const client = createQzoneSourceRegisterIpcClient({ origin: 'http://127.0.0.1:' + port, token: TOKEN, timeoutMs: 2000 });
  try {
    assert.equal(await client.register(SESSION, { requestId: REQUEST, origin: 'qq-inbound' }), false);
  } finally { await client.close(); }
  assert.equal(fake.calls.length, 0);
});

// ── 6. 超时 ⇒ false 且不抛 ─────────────────────────────────────────────────────────────
await test('C11-06 register 卡住（server 不回应）⇒ client 超时返回 false，不抛', async () => {
  // 假 server：接受连接但永不回响应，用来逼出 client 的超时分支。
  const hung = http.createServer(() => { /* 故意不 end */ });
  await new Promise((resolve) => hung.listen(0, '127.0.0.1', resolve));
  const port = hung.address().port;
  const client = createQzoneSourceRegisterIpcClient({ origin: 'http://127.0.0.1:' + port, token: TOKEN, timeoutMs: 300 });
  try {
    const started = Date.now();
    assert.equal(await client.register(SESSION, { requestId: REQUEST, origin: 'qq-inbound' }), false);
    assert.ok(Date.now() - started < 3000, '必须在预算内返回，不能悬挂');
  } finally {
    await client.close();
    await new Promise((resolve) => { try { hung.closeAllConnections(); } catch {} hung.close(() => resolve()); });
  }
});

// ── 7. 拒绝绑 0.0.0.0 ───────────────────────────────────────────────────────────────────
await test("C11-07 server 拒绝绑 0.0.0.0 / localhost（构造时 TypeError）", async () => {
  const fake = makeRegister();
  for (const host of ['0.0.0.0', 'localhost', '::', 'example.com']) {
    await assert.rejects(
      () => createQzoneSourceRegisterIpcServer({ register: fake.register, token: TOKEN, host }),
      /loopback/, host);
  }
  // client 侧同样只接受字面量回环
  for (const origin of ['http://example.com:1', 'http://localhost:1', 'http://0.0.0.0:1']) {
    assert.throws(() => createQzoneSourceRegisterIpcClient({ origin, token: TOKEN }), /loopback/, origin);
  }
});

// ── 8. 响应/日志里不含 requestId ───────────────────────────────────────────────────────
await test('C11-08 响应体与状态码路径都不回显 requestId', async () => {
  const fake = makeRegister();
  await withServer({ register: fake.register }, async ({ server }) => {
    const h = { authorization: 'Bearer ' + TOKEN };
    const bodies = [];
    const ok = await raw(server.port, { headers: h, body: JSON.stringify({ sessionId: SESSION, requestId: REQUEST, origin: 'qq-inbound' }) });
    bodies.push(ok.text);
    const denied = await raw(server.port, { headers: h, body: JSON.stringify({ sessionId: SESSION, requestId: REQUEST, origin: 'nope' }) });
    bodies.push(denied.text);
    const failed = await raw(server.port, { headers: h, body: JSON.stringify({ sessionId: SESSION, requestId: REQUEST, origin: 'qq-inbound' }) });
    bodies.push(failed.text);
    for (const text of bodies) {
      assert.ok(!text.includes(REQUEST), '响应里不得出现 requestId：' + text);
    }
  });
});

// ── 9. register 抛错 / 拒绝 ⇒ 500，且不泄露异常文案 ─────────────────────────────────────
await test('C11-09 register 抛错 ⇒ 500 register-failed；返回 ok:false ⇒ 500 register-refused；都不泄露文案', async () => {
  const throwing = makeRegister({ result: 'throw' });
  await withServer({ register: throwing.register }, async ({ server }) => {
    const r = await raw(server.port, {
      headers: { authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ sessionId: SESSION, requestId: REQUEST, origin: 'qq-inbound' }),
    });
    assert.equal(r.status, 500);
    assert.equal(JSON.parse(r.text).error, 'register-failed');
    assert.ok(!r.text.includes('blew up'), '不得回传异常文案');
  });
  const refusing = makeRegister({ result: 'refuse' });
  await withServer({ register: refusing.register }, async ({ client, server }) => {
    assert.equal(await client.register(SESSION, { requestId: REQUEST, origin: 'qq-inbound' }), false,
      '插件拒绝不能被当成成功');
    const r = await raw(server.port, {
      headers: { authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ sessionId: SESSION, requestId: REQUEST, origin: 'qq-inbound' }),
    });
    assert.equal(r.status, 500);
    assert.equal(JSON.parse(r.text).error, 'register-refused');
  });
});

// ── 10. 配置解读 ────────────────────────────────────────────────────────────────────────
await test('C11-10 readQzoneSourceRegisterConfig：缺省关闭、闭集、token/port 校验', async () => {
  assert.deepEqual(readQzoneSourceRegisterConfig(undefined), { enabled: false, reason: 'not-configured' });
  assert.deepEqual(readQzoneSourceRegisterConfig({}), { enabled: false, reason: 'not-configured' });
  assert.deepEqual(readQzoneSourceRegisterConfig({ sourceRegister: null }), { enabled: false, reason: 'not-configured' });
  assert.deepEqual(readQzoneSourceRegisterConfig({ sourceRegister: true }), { enabled: false, reason: 'invalid-section' });
  assert.equal(readQzoneSourceRegisterConfig({ sourceRegister: {} }).reason, 'token-missing');
  assert.equal(readQzoneSourceRegisterConfig({ sourceRegister: { token: 'A'.repeat(31) } }).reason, 'token-invalid');
  assert.equal(readQzoneSourceRegisterConfig({ sourceRegister: { token: 'A'.repeat(257) } }).reason, 'token-invalid');
  assert.equal(readQzoneSourceRegisterConfig({ sourceRegister: { token: 'A'.repeat(31) + '!' } }).reason, 'token-invalid');
  assert.equal(readQzoneSourceRegisterConfig({ sourceRegister: { token: TOKEN, port: -1 } }).reason, 'port-invalid');
  assert.equal(readQzoneSourceRegisterConfig({ sourceRegister: { token: TOKEN, port: 70000 } }).reason, 'port-invalid');
  assert.equal(readQzoneSourceRegisterConfig({ sourceRegister: { token: TOKEN, extra: 1 } }).reason, 'unknown-field');
  assert.deepEqual(readQzoneSourceRegisterConfig({ sourceRegister: { token: TOKEN } }), { enabled: true, token: TOKEN, port: 0 });
  assert.deepEqual(readQzoneSourceRegisterConfig({ sourceRegister: { token: TOKEN, port: 41234 } }), { enabled: true, token: TOKEN, port: 41234 });
  assert.deepEqual([...QZONE_SOURCE_REGISTER_KEYS], ['token', 'port']);
  assert.deepEqual([...QZONE_SOURCE_ORIGINS], ['qq-inbound', 'schedule']);
  assert.ok(Object.isFrozen(QZONE_SOURCE_REGISTER_KEYS));
  assert.ok(Object.isFrozen(QZONE_SOURCE_ORIGINS));
});

// ── 11. 关闭后的 client 一律 false ──────────────────────────────────────────────────────
await test('C11-11 client.close() 后 register ⇒ false，不再发请求', async () => {
  const fake = makeRegister();
  await withServer({ register: fake.register }, async ({ client }) => {
    await client.close();
    assert.equal(await client.register(SESSION, { requestId: REQUEST, origin: 'qq-inbound' }), false);
    assert.equal(fake.calls.length, 0);
  });
});

const failed = results.filter((r) => r[0] === 'FAIL');
for (const [status, name] of results) console.log(status + '  ' + name);
console.log('---');
console.log('total=' + results.length + ' failed=' + failed.length);
process.exitCode = failed.length === 0 ? 0 : 1;
