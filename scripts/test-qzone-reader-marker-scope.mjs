import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzoneLiveFriendRead } from '../src/core/qzone-live-friend-read.mjs';
import { createQzoneBoundReadTransport, isQzoneReadNotSent } from '../src/core/qzone-bound-read-transport.mjs';

// Independent review (R9V2) high-2: the reader's outer catch used to treat ANY error
// carrying the not-sent marker as "nothing was sent", without asking whether the
// platform call had already gone out. `dispatched = true` sits before
// `await transport(...)`, so the post-send rechecks (`verifyRequestProof`,
// `verifyFriendship`, `isStillAuthorized` at src/core/qzone-live-friend-read.mjs:184)
// run with `dispatched === true`. If one of them THROWS an object carrying the
// marker, the caller was told `dispatched: false` and refunded the tracking charge
// even though a real `get_qzone_msg_list` had been issued — a quota bypass.
//
// The marker is only meaningful inside the transport's own `sent === false` window,
// so the reader now checks it in a narrow try around the transport call and lets
// every later failure fall through to the unknown-outcome branch. These two cases
// pin both halves of that split.

const now = Date.parse('2026-11-10T04:00:00Z');

function makeStore(overrides = {}) {
  let state = { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true }, reads: 0, writes: 0, readAttempts: {}, readOutcomes: {},
    notices: [], browseDay: '2026-11-10', todayBrowses: 0, lastBrowseAt: null,
    usedOpportunities: {}, activeStart: 0, activeEnd: 1439, audit: [], ...overrides };
  return { read: () => structuredClone(state), update(fn) { state = fn(structuredClone(state)); return structuredClone(state); } };
}

// Obtain a GENUINE marker object without forging anything: one malformed snapshot into
// the real transport produces a real `notSent()` error. It never needs a store, an
// epoch, or a platform call.
async function captureGenuineMarker() {
  const probe = createQzoneBoundReadTransport({ botQq: 123, getConnectionEpoch: () => 8,
    transport: { get_qzone_msg_list: async () => { throw new Error('must not be called'); } } });
  try {
    await probe(null, () => true);
  } catch (error) {
    assert.equal(isQzoneReadNotSent(error), true, '捕获到的必须是真标记对象');
    return error;
  }
  throw new Error('unreachable: null 快照必须被拒绝');
}

const proof = () => ({ id: 'r1', sourceProofId: 'src1', source: 'requested',
  targetQq: 456, botQq: 123, connectionEpoch: 8 });
const friendship = async (value) => ({ status: 'friend', sourceProofId: value.sourceProofId,
  botQq: value.botQq, targetQq: value.targetQq, connectionEpoch: value.connectionEpoch });

test('dispatch 之后的复检抛出真 marker 时仍必须判为结果未知：不得借标记退额度', async () => {
  const marker = await captureGenuineMarker();
  let authCalls = 0;
  let platformCalls = 0;
  const reader = createQzoneLiveFriendRead({ store: makeStore(), clock: () => now,
    verifyRequestProof: async () => proof(), verifyFriendship: friendship,
    // 模拟真实 transport 的形状：发送前的守卫通过之后才发平台请求。
    transport: async (_input, guard) => {
      assert.equal(guard(), true, '前提：发送前守卫必须通过');
      platformCalls += 1;
      return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
    },
    // 第 1 次来自 transport 的发送前守卫（通过）；第 2 次来自
    // `src/core/qzone-live-friend-read.mjs:184` 的复检 —— 平台请求已经发出。
    isStillAuthorized: () => { authCalls += 1; if (authCalls === 1) return true; throw marker; },
    offlineTestFixture: true });

  const result = await reader.read({ targetQq: 456 });

  assert.equal(platformCalls, 1, '前提：平台请求确实已经发出过');
  assert.equal(authCalls >= 2, true, '前提：第 2 次复检确实到达了');
  assert.equal(result.outcome, 'unknown', '已发出的读只能报结果未知，绝不能报成派发前拒绝');
  assert.equal(result.allowed, true, 'unknown 结果沿用既有形状（allowed: true + outcome 字段）');
  assert.notEqual(result.dispatched, false,
    '已发出之后失败不得带 dispatched:false —— 那会让调用方按「没发出」退掉 tracking 额度');
});

test('transport 内部的派发前拒绝仍然必须被识别为未发出：收窄不得变成过宽', async () => {
  let platformCalls = 0;
  // 用真 transport：epoch 在发送前就对不上，走 `src/core/qzone-bound-read-transport.mjs:61` 的 notSent()。
  const bound = createQzoneBoundReadTransport({ botQq: 123, getConnectionEpoch: () => 99,
    transport: { get_qzone_msg_list: async () => { platformCalls += 1; return { kind: 'trusted-envelope', envelope: {} }; } } });
  const reader = createQzoneLiveFriendRead({ store: makeStore(), clock: () => now,
    verifyRequestProof: async () => proof(), verifyFriendship: friendship,
    transport: bound, offlineTestFixture: true });

  const result = await reader.read({ targetQq: 456 });

  assert.equal(platformCalls, 0, '派发前拒绝必须一次平台调用都没发');
  assert.deepEqual(result, { allowed: false, reason: 'unverified', reserved: true, dispatched: false },
    '真·派发前拒绝必须继续带 dispatched:false，否则零平台调用的拒绝会锁死额度');
});
