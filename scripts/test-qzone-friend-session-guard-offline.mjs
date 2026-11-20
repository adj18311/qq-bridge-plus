import assert from 'node:assert/strict';
import test from 'node:test';
import { createQzoneFriendSessionGuardOffline } from '../src/core/qzone-friend-session-guard-offline.mjs';

const UNKNOWN = { trustedStatus: 'unknown', friend: false };
const TRUSTED_TRUE = { trustedStatus: 'trusted', friend: true };
const TRUSTED_FALSE = { trustedStatus: 'trusted', friend: false };

function harness(options = {}) {
  const epoch = Object.hasOwn(options, 'epoch') ? options.epoch : 4;
  const botQq = options.botQq ?? 9001;
  const friend = options.friend ?? true;
  const identity = options.identity ?? (() => botQq);
  const source = options.source;
  const state = { epoch };
  const friendSource = source ?? { isFriend: async () => ({ trustedStatus: 'trusted', friend }) };
  return {
    state,
    guard: createQzoneFriendSessionGuardOffline({
      botQq,
      friendSource,
      getBotIdentity: async () => identity(state),
      getConnectionEpoch: async () => state.epoch,
    }),
  };
}

test('稳定的连接代际和机器人身份保留好友来源结果', async () => {
  const { guard } = harness();
  assert.deepEqual(await guard.isFriend(42), TRUSTED_TRUE);
  assert.deepEqual(await guard.isFriend(84), TRUSTED_TRUE);
});

test('连接代际在查询期间变化时返回 unknown，即使机器人身份仍相同', async () => {
  const { state, guard } = harness({ source: { isFriend: async () => {
    state.epoch++;
    return TRUSTED_TRUE;
  } } });

  assert.deepEqual(await guard.isFriend(42), UNKNOWN);
});

test('最终身份读取期间连接发生 ABA 且 epoch 更新时必须返回 unknown', async () => {
  let epoch = 4;
  let identityReads = 0;
  const guard = createQzoneFriendSessionGuardOffline({
    botQq: 9001,
    friendSource: { isFriend: async () => TRUSTED_TRUE },
    getBotIdentity: async () => {
      identityReads++;
      if (identityReads === 2) {
        await Promise.resolve();
        epoch = 5; // 模拟 A→B→A；查询末尾身份仍读到同一 bot。
      }
      return 9001;
    },
    getConnectionEpoch: async () => epoch,
  });

  assert.deepEqual(await guard.isFriend(42), UNKNOWN);
});

test('身份读取期间 epoch 回拨必须返回 unknown 并保留已见高水位', async () => {
  let epoch = 4;
  let identityReads = 0;
  const guard = createQzoneFriendSessionGuardOffline({
    botQq: 9001,
    friendSource: { isFriend: async () => TRUSTED_TRUE },
    getBotIdentity: async () => {
      identityReads++;
      if (identityReads === 2) epoch = 3;
      return 9001;
    },
    getConnectionEpoch: async () => epoch,
  });

  assert.deepEqual(await guard.isFriend(42), UNKNOWN);
  epoch = 4;
  assert.deepEqual(await guard.isFriend(84), UNKNOWN);
});

test('并发查询先观察到新 epoch 后，旧查询不能用身份读取完成绕过高水位', async () => {
  let epoch = 4;
  let releaseOldIdentity;
  let identityReads = 0;
  const guard = createQzoneFriendSessionGuardOffline({
    botQq: 9001,
    friendSource: { isFriend: async () => TRUSTED_TRUE },
    getBotIdentity: async () => {
      identityReads++;
      if (identityReads === 2) return new Promise((resolve) => { releaseOldIdentity = resolve; });
      return 9001;
    },
    getConnectionEpoch: async () => epoch,
  });

  const oldQuery = guard.isFriend(42);
  await new Promise((resolve) => setImmediate(resolve));
  epoch = 5;
  assert.deepEqual(await guard.isFriend(84), TRUSTED_TRUE);
  releaseOldIdentity(9001);
  assert.deepEqual(await oldQuery, UNKNOWN);
});

test('旧 epoch 好友来源仍在途时，新 epoch 查询不能复用其旧快照', async () => {
  let epoch = 4;
  let releaseOldSource;
  let sourceCalls = 0;
  const guard = createQzoneFriendSessionGuardOffline({
    botQq: 9001,
    friendSource: { isFriend: async () => {
      sourceCalls++;
      if (sourceCalls === 1) return new Promise((resolve) => { releaseOldSource = resolve; });
      return TRUSTED_TRUE;
    } },
    getBotIdentity: async () => 9001,
    getConnectionEpoch: async () => epoch,
  });

  const oldQuery = guard.isFriend(42);
  await new Promise((resolve) => setImmediate(resolve));
  epoch = 5;
  assert.deepEqual(await guard.isFriend(84), UNKNOWN);
  assert.equal(sourceCalls, 1);
  releaseOldSource(TRUSTED_TRUE);
  assert.deepEqual(await oldQuery, UNKNOWN);
  assert.deepEqual(await guard.isFriend(84), TRUSTED_TRUE);
});

test('A→B→A 身份往返期间 epoch 变化仍拒绝好友结果', async () => {
  let currentIdentity = 9001;
  const { state, guard } = harness({ identity: () => currentIdentity, source: { isFriend: async () => {
    currentIdentity = 7007;
    state.epoch++;
    currentIdentity = 9001;
    return TRUSTED_TRUE;
  } } });

  assert.deepEqual(await guard.isFriend(42), UNKNOWN);
});

test('查询开始或结束时机器人身份不是绑定账号则返回 unknown', async () => {
  let reads = 0;
  const startMismatch = harness({ identity: () => 7007 });
  assert.deepEqual(await startMismatch.guard.isFriend(42), UNKNOWN);

  const endMismatch = harness({ identity: () => ++reads <= 1 ? 9001 : 7007 });
  assert.deepEqual(await endMismatch.guard.isFriend(42), UNKNOWN);
});

test('缺失、非法或异常 epoch 在查询任一端均 fail closed', async () => {
  for (const invalidEpoch of [undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '4']) {
    const { guard } = harness({ epoch: invalidEpoch });
    assert.deepEqual(await guard.isFriend(42), UNKNOWN);
  }

  let epochCalls = 0;
  const throwingStart = createQzoneFriendSessionGuardOffline({
    botQq: 9001,
    friendSource: { isFriend: async () => TRUSTED_TRUE },
    getBotIdentity: async () => 9001,
    getConnectionEpoch: async () => { throw new Error('synthetic epoch error'); },
  });
  assert.deepEqual(await throwingStart.isFriend(42), UNKNOWN);

  const throwingEnd = createQzoneFriendSessionGuardOffline({
    botQq: 9001,
    friendSource: { isFriend: async () => TRUSTED_TRUE },
    getBotIdentity: async () => 9001,
    getConnectionEpoch: async () => ++epochCalls === 1 ? 4 : undefined,
  });
  assert.deepEqual(await throwingEnd.isFriend(42), UNKNOWN);
});

test('已观察的 epoch 倒退后持续 fail closed，来源结果不得掩盖异常', async () => {
  const { state, guard } = harness();
  assert.deepEqual(await guard.isFriend(42), TRUSTED_TRUE);
  state.epoch = 3;
  assert.deepEqual(await guard.isFriend(42), UNKNOWN);
  state.epoch = 4;
  assert.deepEqual(await guard.isFriend(42), TRUSTED_TRUE);
});

test('身份不匹配期间观察到的高 epoch 仍阻止后续 epoch 倒退', async () => {
  let identity = 7007;
  const { state, guard } = harness({ epoch: 5, identity: () => identity });
  assert.deepEqual(await guard.isFriend(42), UNKNOWN);
  state.epoch = 4;
  identity = 9001;
  assert.deepEqual(await guard.isFriend(42), UNKNOWN);
});

test('好友来源 unknown、非法目标或异常均返回无敏感细节的 unknown', async () => {
  const notTrusted = harness({ source: { isFriend: async () => UNKNOWN } });
  assert.deepEqual(await notTrusted.guard.isFriend(42), UNKNOWN);
  assert.deepEqual(await notTrusted.guard.isFriend('42'), UNKNOWN);

  const failed = harness({ source: { isFriend: async () => { throw new Error('synthetic secret'); } } });
  const result = await failed.guard.isFriend(42);
  assert.deepEqual(result, UNKNOWN);
  assert.equal(JSON.stringify(result).includes('synthetic secret'), false);
});

test('依赖必须完整且绑定正整数机器人身份', () => {
  assert.throws(() => createQzoneFriendSessionGuardOffline({ botQq: 9001 }), /invalid/);
  assert.throws(() => createQzoneFriendSessionGuardOffline({
    botQq: 0, friendSource: { isFriend() {} }, getBotIdentity() {}, getConnectionEpoch() {},
  }), /invalid/);
});
