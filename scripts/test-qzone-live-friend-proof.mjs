import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzoneLiveFriendProof } from '../src/core/qzone-live-friend-proof.mjs';

function harness({ epoch = 7, login = 123, friend = true, onCall } = {}) {
  let currentEpoch = epoch;
  const calls = [];
  const verifier = createQzoneLiveFriendProof({ botQq: 123,
    getConnectionEpoch: () => currentEpoch,
    call: async (action, params) => {
      calls.push([action, params]);
      await onCall?.(action, () => { currentEpoch++; });
      return action === 'get_login_info'
        ? { status: 'ok', retcode: 0, data: { user_id: login } }
        : { status: 'ok', retcode: 0, data: friend ? [{ user_id: 456 }] : [] };
    } });
  return { verifier, calls, setEpoch(value) { currentEpoch = value; } };
}
const proof = { sourceProofId: 'source-1', targetQq: 456, botQq: 123, connectionEpoch: 7 };

test('绑定可信好友并返回读取端要求的精确结构化回执', async () => {
  const { verifier, calls } = harness();
  assert.deepEqual(await verifier.verify(proof), { status: 'friend', ...proof });
  assert.deepEqual(calls.map(([action]) => action), ['get_login_info', 'get_login_info', 'get_friend_list',
    'get_login_info', 'get_login_info']);
  assert.ok(calls.every(([, params]) => Object.keys(params).length === 0));
});

test('非法目标、bot 或输入结构在调用 API 前拒绝', async () => {
  const { verifier, calls } = harness();
  for (const invalid of [{ ...proof, targetQq: 0 }, { ...proof, botQq: 999 },
    { ...proof, extra: true }, { ...proof, targetQq: '456' }, null]) {
    assert.equal(await verifier.verify(invalid), null);
  }
  assert.equal(calls.length, 0);
});

test('epoch 初始不匹配、验证中重连或连接代际不可用均拒绝', async () => {
  const mismatch = harness({ epoch: 8 });
  assert.equal(await mismatch.verifier.verify(proof), null);
  assert.equal(mismatch.calls.length, 0);

  const switched = harness({ onCall(action, reconnect) { if (action === 'get_friend_list') reconnect(); } });
  assert.equal(await switched.verifier.verify(proof), null);

  const disconnected = createQzoneLiveFriendProof({ botQq: 123, call: async () => { throw Error('disconnected'); },
    getConnectionEpoch: () => { throw Error('disconnected'); } });
  assert.equal(await disconnected.verify(proof), null);
});

test('身份不匹配、非好友、来源异常都 fail closed', async () => {
  const wrongBot = harness({ login: 789 });
  assert.equal(await wrongBot.verifier.verify(proof), null);
  const notFriend = harness({ friend: false });
  assert.equal(await notFriend.verifier.verify(proof), null);
  const failed = createQzoneLiveFriendProof({ botQq: 123, getConnectionEpoch: () => 7,
    call: async () => { throw Error('private response'); } });
  assert.equal(await failed.verify(proof), null);
});
