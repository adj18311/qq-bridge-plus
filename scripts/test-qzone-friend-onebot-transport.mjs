import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createQzoneFriendOnebotTransport } from '../src/core/qzone-friend-onebot-transport.mjs';

test('仅将固定好友身份动作发送到本机网关', async () => {
  const calls = [];
  const call = createQzoneFriendOnebotTransport({ origin: 'http://127.0.0.1:13000', token: () => 'private',
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, body: init.body, auth: init.headers.get('authorization') });
      return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 123 } }),
        { headers: { 'content-type': 'application/json' } });
    } });
  assert.equal((await call('get_login_info', {})).data.user_id, 123);
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:13000/get_login_info', method: 'POST', body: '{}', auth: 'Bearer private' }]);
  await assert.rejects(() => call('send_qzone_msg', {}));
  await assert.rejects(() => call('get_friend_list', { target: 456 }));
  assert.equal(calls.length, 1);
});

test('拒绝非回环地址并对异常响应失败关闭', async () => {
  assert.throws(() => createQzoneFriendOnebotTransport({ origin: 'http://example.com', token: () => '', fetch: async () => null }));
  const call = createQzoneFriendOnebotTransport({ origin: 'http://127.0.0.1:13000', token: () => '',
    fetch: async () => new Response('bad', { status: 500 }) });
  await assert.rejects(() => call('get_friend_list', {}));
});

test('网关不响应时在超时后失败关闭', async () => {
  const call = createQzoneFriendOnebotTransport({ origin: 'http://127.0.0.1:13000', token: () => '', timeoutMs: 20,
    fetch: async () => new Promise(() => {}) });
  await assert.rejects(() => call('get_login_info', {}));
});

test('凭据读取卡住时也有总超时且不派发请求', async () => {
  let sent = false;
  const call = createQzoneFriendOnebotTransport({ origin: 'http://127.0.0.1:13000', timeoutMs: 20,
    token: () => new Promise(() => {}), fetch: async () => { sent = true; } });
  const result = await Promise.race([call('get_login_info', {}).then(() => 'success', () => 'failed'),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 100))]);
  assert.equal(result, 'failed');
  assert.equal(sent, false);
});

test('超时后迟到的凭据不能触发网络请求', async () => {
  let release; let sent = false;
  const call = createQzoneFriendOnebotTransport({ origin: 'http://127.0.0.1:13000', timeoutMs: 20,
    token: () => new Promise((resolve) => { release = resolve; }), fetch: async () => { sent = true; } });
  await assert.rejects(() => call('get_login_info', {}));
  release('private');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent, false);
});

test('过大响应被拒绝且错误不得暴露令牌或响应正文', async () => {
  const call = createQzoneFriendOnebotTransport({ origin: 'http://127.0.0.1:13000', token: () => 'private-secret',
    fetch: async () => new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(() => call('get_friend_list', {}), (error) => {
    assert.equal(error.message, 'friend request unavailable'); return true;
  });
});

test('超时后迟到的网关响应必须取消且不可读取', async () => {
  let resolveResponse; let canceled = false; let read = false;
  const call = createQzoneFriendOnebotTransport({ origin: 'http://127.0.0.1:13000', timeoutMs: 20,
    token: () => '', fetch: () => new Promise((resolve) => { resolveResponse = resolve; }) });
  await assert.rejects(() => call('get_login_info', {}));
  resolveResponse({ ok: true, headers: new Headers({ 'content-type': 'application/json' }),
    body: { cancel: async () => { canceled = true; }, getReader: () => { read = true; } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(canceled, true);
  assert.equal(read, false);
});

test('超时取消读取器同步抛错时仍能安全结束', () => {
  const script = `import { createQzoneFriendOnebotTransport } from './src/core/qzone-friend-onebot-transport.mjs';
    process.on('uncaughtException', () => process.exit(7));
    const call = createQzoneFriendOnebotTransport({ origin: 'http://127.0.0.1:1', timeoutMs: 20, token: () => '',
      fetch: async () => ({ ok: true, headers: new Headers({ 'content-type':'application/json' }),
        body: { getReader: () => ({ read: () => new Promise(() => {}), cancel() { throw new Error('cancel'); }, releaseLock() {} }) } }) });
    await call('get_login_info', {}).then(() => process.exit(8), () => process.exit(0));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 2000 });
  assert.equal(child.status, 0);
});
