import assert from 'node:assert/strict';
import { createQzoneFriendSource } from '../src/core/qzone-friend-source.mjs';

const ok = (friend) => ({ trustedStatus: 'trusted', friend });
const unknown = { trustedStatus: 'unknown', friend: false };
const login = async () => ({ user_id: 9001, nickname: 'bot' });
const source = (getFriendList, getLoginInfo = login) => createQzoneFriendSource({
  botQq: 9001, getLoginInfo, getFriendList
});

assert.deepEqual(await source(async () => ({ status: 'ok', retcode: 0, data: [{ user_id: 42 }] })).isFriend(42), ok(true));
assert.deepEqual(await source(async () => ({ status: 'ok', retcode: 0, data: [{ user_id: 84 }] })).isFriend(42), ok(false));
assert.deepEqual(await source(async () => ({ status: 'ok', retcode: 0, data: [] }), async () => ({ user_id: 7 })).isFriend(42), unknown);
assert.deepEqual(await source(async () => ({ status: 'ok', retcode: 0, data: [{ user_id: 42 }] })).isFriend({
  targetQq: 42, trustedCurrentRead: true, envelope: { status: 'ok', retcode: 0, data: [{ user_id: 42 }] }
}), unknown);

const secret = 'credential-sensitive synthetic text';
const failed = await source(async () => { throw new Error(secret); }).isFriend(42);
assert.deepEqual(failed, unknown);
assert.equal(JSON.stringify(failed).includes(secret), false);
assert.deepEqual(await source(async () => ({ status: 'failed', retcode: 1, data: [{ user_id: 42 }], token: secret })).isFriend(42), unknown);
assert.deepEqual(await source(async () => ({ status: 'ok', retcode: 0, data: [{ user_id: '42' }] })).isFriend(42), unknown);

let releaseA;
let releaseB;
const calls = [];
const concurrent = source(() => new Promise((resolve) => {
  calls.push(undefined);
  if (calls.length === 1) releaseA = () => resolve({ status: 'ok', retcode: 0, data: [{ user_id: 42 }] });
  else if (calls.length === 2) releaseB = () => resolve({ status: 'ok', retcode: 0, data: [{ user_id: 84 }] });
}));
const a = concurrent.isFriend(42);
const b = concurrent.isFriend(84);
await new Promise((resolve) => setImmediate(resolve));
releaseB();
releaseA();
assert.deepEqual(await Promise.all([a, b]), [ok(true), ok(true)]);
assert.deepEqual(calls, [undefined, undefined]);

let loginCalls = 0;
const switched = source(async () => ({ status: 'ok', retcode: 0, data: [{ user_id: 42 }] }),
  async () => ({ user_id: ++loginCalls === 1 ? 9001 : 7 }));
assert.deepEqual(await switched.isFriend(42), unknown, '读取好友期间账号发生切换必须拒绝');

console.log('qzone-friend-source: all assertions passed');
