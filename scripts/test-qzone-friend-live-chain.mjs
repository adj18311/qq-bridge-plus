import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { bindQzoneConnectionEpoch } from '../src/core/qzone-connection-epoch-runtime.mjs';
import { createQzoneFriendOnebotTransport } from '../src/core/qzone-friend-onebot-transport.mjs';
import { createQzoneBoundFriendSource } from '../src/core/qzone-friend-source-runtime.mjs';

test('身份、认证传输与连接代际组合；重连前后均不泄露凭据', async () => {
  const bot = new EventEmitter(); const epoch = bindQzoneConnectionEpoch(bot);
  const requested = [];
  const call = createQzoneFriendOnebotTransport({ origin: 'http://127.0.0.1:13000', token: () => 'secret',
    fetch: async (url, init) => {
      assert.equal(init.headers.get('authorization'), 'Bearer secret');
      requested.push(new URL(url).pathname);
      const data = url.endsWith('/get_login_info') ? { user_id: 123 } : [{ user_id: 456 }];
      return new Response(JSON.stringify({ status: 'ok', retcode: 0, data }),
        { headers: { 'content-type': 'application/json' } });
    } });
  const source = createQzoneBoundFriendSource({ botQq: 123, call, getConnectionEpoch: epoch.current });
  assert.deepEqual(await source.isFriend(456), { trustedStatus: 'unknown', friend: false });
  bot.emit('open');
  assert.deepEqual(await source.isFriend(456), { trustedStatus: 'trusted', friend: true });
  assert.ok(requested.includes('/get_friend_list'));
  bot.emit('close');
  assert.deepEqual(await source.isFriend(456), { trustedStatus: 'unknown', friend: false });
  epoch.close();
});

test('真实本地 HTTP 传输组合链正常工作且重连后拒绝旧查询', async () => {
  const bot = new EventEmitter(); const epoch = bindQzoneConnectionEpoch(bot);
  let friendRequest;
  const seenFriend = new Promise((resolve) => { friendRequest = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer local-test-only');
    const isFriend = req.url === '/get_friend_list';
    if (isFriend) { friendRequest(); await gate; }
    const data = isFriend ? [{ user_id: 456 }] : { user_id: 123 };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const call = createQzoneFriendOnebotTransport({ origin, token: () => 'local-test-only', fetch });
    const source = createQzoneBoundFriendSource({ botQq: 123, call, getConnectionEpoch: epoch.current });
    bot.emit('open');
    const pending = source.isFriend(456);
    await seenFriend;
    bot.emit('close'); bot.emit('open');
    release();
    assert.deepEqual(await pending, { trustedStatus: 'unknown', friend: false });
  } finally {
    release(); epoch.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
