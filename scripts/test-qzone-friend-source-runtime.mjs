import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzoneFriendSourceRuntime, createQzoneBoundFriendSource } from '../src/core/qzone-friend-source-runtime.mjs';

test('真实来源只使用固定动作核验机器人和好友', async () => {
  const calls = [];
  const source = createQzoneFriendSourceRuntime({ botQq: 123, call: async (action, params) => {
    calls.push([action, params]);
    return action === 'get_login_info'
      ? { status: 'ok', retcode: 0, data: { user_id: 123 } }
      : { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
  } });
  assert.deepEqual(await source.isFriend(456), { trustedStatus: 'trusted', friend: true });
  assert.deepEqual(calls, [['get_login_info', {}], ['get_friend_list', {}], ['get_login_info', {}]]);
});

test('机器人身份在读取期间改变时拒绝可信结果', async () => {
  let calls = 0;
  const source = createQzoneFriendSourceRuntime({ botQq: 123, call: async (action) => {
    if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
    return { status: 'ok', retcode: 0, data: { user_id: ++calls === 1 ? 123 : 789 } };
  } });
  assert.deepEqual(await source.isFriend(456), { trustedStatus: 'unknown', friend: false });
});

test('失败响应与调用异常不能证明好友身份', async () => {
  for (const call of [async () => ({ status: 'failed', retcode: 1, data: { user_id: 123 } }),
    async () => { throw new Error('secret'); }]) {
    const source = createQzoneFriendSourceRuntime({ botQq: 123, call });
    assert.deepEqual(await source.isFriend(456), { trustedStatus: 'unknown', friend: false });
  }
});

test('不接受无效身份或非函数传输', () => {
  assert.throws(() => createQzoneFriendSourceRuntime({ botQq: 0, call: async () => ({}) }));
  assert.throws(() => createQzoneFriendSourceRuntime({ botQq: 123, call: null }));
});

test('连接代际稳定时允许验证好友', async () => {
  const call = async (action) => action === 'get_login_info'
    ? { status: 'ok', retcode: 0, data: { user_id: 123 } }
    : { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
  const source = createQzoneBoundFriendSource({ botQq: 123, call, getConnectionEpoch: () => 4 });
  assert.deepEqual(await source.isFriend(456), { trustedStatus: 'trusted', friend: true });
});

test('好友查询过程中重连即使账号相同也拒绝', async () => {
  let epoch = 4;
  const source = createQzoneBoundFriendSource({ botQq: 123, getConnectionEpoch: () => epoch,
    call: async (action) => {
      if (action === 'get_friend_list') { epoch++; return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] }; }
      return { status: 'ok', retcode: 0, data: { user_id: 123 } };
    } });
  assert.deepEqual(await source.isFriend(456), { trustedStatus: 'unknown', friend: false });
});

test('没有连接代际读取器时不得建立真实来源', () => {
  assert.throws(() => createQzoneBoundFriendSource({ botQq: 123, call: async () => ({}) }));
});
