import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzoneBoundReadTransport, isQzoneReadNotSent } from '../src/core/qzone-bound-read-transport.mjs';
import { createQzoneLiveFriendRead } from '../src/core/qzone-live-friend-read.mjs';

// Round-9 review, medium-2. `src/core/qzone-bound-read-transport.mjs` reads the live
// connection epoch BEFORE building anything, and that read can itself throw when the
// source is gone. The throw used to escape without the not-sent marker, so a call
// that never reached `get_qzone_msg_list` was charged as an "unknown outcome" and
// kept its tracking slot. Three of those exhaust `trackingLimit` with zero platform
// calls — exactly the lockout the marker was introduced to prevent. The marker must
// cover the epoch read too, and only while nothing has been sent.

const now = Date.parse('2026-11-10T04:00:00Z');

function makeStore(overrides = {}) {
  let state = { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true }, reads: 0, writes: 0, readAttempts: {}, readOutcomes: {},
    notices: [], browseDay: '2026-11-10', todayBrowses: 0, lastBrowseAt: null,
    usedOpportunities: {}, activeStart: 0, activeEnd: 1439, audit: [], ...overrides };
  return { read: () => structuredClone(state), update(fn) { state = fn(structuredClone(state)); return structuredClone(state); } };
}

const snapshot = () => ({ target_uin: 456, pos: 0, num: 20, botQq: 123, connectionEpoch: 8, sourceProofId: 'src1' });

test('连接纪元读取本身抛错属于派发前拒绝：必须带未发出标记，且一次平台调用都没有', async () => {
  let platformCalls = 0;
  const bound = createQzoneBoundReadTransport({ botQq: 123,
    getConnectionEpoch: () => { throw new Error('disconnected'); },
    transport: { get_qzone_msg_list: async () => { platformCalls += 1; return { kind: 'trusted-envelope', envelope: {} }; } } });

  let error;
  try {
    await bound(snapshot(), () => true);
  } catch (thrown) {
    error = thrown;
  }

  assert.equal(platformCalls, 0, '纪元读取失败时绝不能发出平台请求');
  assert.equal(error instanceof Error, true, '必须抛出错误');
  assert.equal(isQzoneReadNotSent(error), true,
    '纪元读取抛错同样是派发前拒绝，未标记会被按 unknown 计费并锁死额度');
});

test('reader 经真实 transport 遇到纪元抛错时返回派发前拒绝，调用方可以退额度', async () => {
  const proof = { id: 'r1', sourceProofId: 'src1', source: 'requested', targetQq: 456, botQq: 123, connectionEpoch: 8 };
  const bound = createQzoneBoundReadTransport({ botQq: 123,
    getConnectionEpoch: () => { throw new Error('disconnected'); },
    transport: { get_qzone_msg_list: async () => { throw new Error('must not be called'); } } });
  const reader = createQzoneLiveFriendRead({ store: makeStore(), clock: () => now,
    verifyRequestProof: async () => proof,
    verifyFriendship: async (value) => ({ status: 'friend', sourceProofId: value.sourceProofId,
      botQq: value.botQq, targetQq: value.targetQq, connectionEpoch: value.connectionEpoch }),
    transport: bound, offlineTestFixture: true });

  const result = await reader.read({ targetQq: 456 });

  assert.deepEqual(result, { allowed: false, reason: 'unverified', reserved: true, dispatched: false },
    '零平台调用的拒绝必须带 dispatched:false，否则三次就能耗尽 trackingLimit');
});

test('已经发出之后的纪元复检抛错仍然不得带标记：收窄不能反向放宽', async () => {
  let epochCalls = 0;
  let platformCalls = 0;
  const bound = createQzoneBoundReadTransport({ botQq: 123,
    // 第 1 次是发送前预检（通过），第 2 次是发送后复检（抛）。
    getConnectionEpoch: () => { epochCalls += 1; if (epochCalls === 1) return 8; throw new Error('disconnected'); },
    transport: { get_qzone_msg_list: async () => { platformCalls += 1; return { kind: 'trusted-envelope', envelope: {} }; } } });

  let error;
  try {
    await bound(snapshot(), () => true);
  } catch (thrown) {
    error = thrown;
  }

  assert.equal(platformCalls, 1, '前提：平台请求确实已经发出');
  assert.equal(isQzoneReadNotSent(error), false,
    '发出之后的复检失败必须保持不可区分，否则一次真实读会退掉额度');
});
