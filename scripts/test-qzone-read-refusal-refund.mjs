import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';
import { createQzoneBoundReadTransport, isQzoneReadNotSent } from '../src/core/qzone-bound-read-transport.mjs';

// Pins the round-7 review's high finding: a refusal raised INSIDE the transport but
// BEFORE anything is sent must not spend the tracking budget.
//
// `qzone-live-friend-read.mjs` sets `dispatched = true` immediately before calling the
// transport, and the transport's own guards (connection epoch, source authorization,
// snapshot shape) run inside that call. Their throws are indistinguishable from a lost
// platform response unless the error carries evidence that nothing left the process.
// Reporting them as post-dispatch kept the charge, so three refusals with zero
// `get_qzone_msg_list` calls exhausted `trackingLimit` — a lockout, not a conservative
// charge. The judge is capacity: a refusal that burned a slot shows up as
// `tracking-capacity` on the next attempt.

const now = Date.parse('2026-11-10T04:00:00Z');
const SESSION = 'sess-refund';
const FRIEND = 456;

function makeStore() {
  let state = {
    enabled: true, readAllowed: true, writeAllowed: false, accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: false }, reads: 0, writes: 0, readAttempts: {}, readOutcomes: {},
    notices: [], browseDay: '2026-11-10', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
    activeStart: 0, activeEnd: 1439, audit: [],
  };
  return {
    read: () => structuredClone(state),
    update(fn) { state = fn(structuredClone(state)); return structuredClone(state); },
  };
}

test('传输层在真正发出请求之前的拒绝必须退回 tracking 额度：三次拒绝不得锁死会话', async () => {
  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1', trackingLimit: 4096 });
  const platformCalls = [];
  // Each dispatch authorizes once at the gate and once more inside the transport.
  // Answering true then false puts the refusal inside the transport, after the reader
  // already claimed the dispatch — exactly the window the fix is about.
  let allowNextLookup = true;
  const runtime = createQzoneRuntime({
    store: makeStore(), botQq: 123, sourceEpoch: 'e1', trackingLimit: 2,
    authorizeSource: (consumption) => {
      if (!consumption) return false;
      const answer = allowNextLookup;
      allowNextLookup = false;
      return answer;
    },
    getConnectionEpoch: () => 8,
    getBridgeSessions: () => ledger,
    clock: () => now, mode: 'read-only',
    call: async (action, params) => {
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
      if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: FRIEND }] };
      if (action === 'get_qzone_msg_list') {
        platformCalls.push(params);
        return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
      }
      throw new Error(`unexpected action ${action}`);
    },
  });

  const results = [];
  // FOUR attempts against a budget of TWO: if any refusal spent a slot, the third and
  // fourth come back `tracking-capacity`.
  for (let turnNo = 1; turnNo <= 4; turnNo++) {
    const requestId = `rpc-${turnNo}`;
    const callId = `c-${turnNo}`;
    ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
    ledger.observeStep({ sessionId: SESSION, turn: turnNo, step: 1,
      messages: [{ role: 'user', source: { rpcId: requestId } }] });
    ledger.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn: turnNo, step: 1, callId } } });
    const result = await runtime.dispatch('read_posts', { target_uin: FRIEND }, { sessionId: SESSION, callId });
    results.push(result.ok === true ? (result.outcome ?? 'ok') : (result.error ?? 'error'));
    ledger.endTurn({ sessionId: SESSION, turn: turnNo });
    allowNextLookup = true;
  }

  assert.deepEqual(results, ['read-denied', 'read-denied', 'read-denied', 'read-denied'],
    '每一次都必须在派发前被拒，不得降级成 tracking-capacity');
  assert.equal(platformCalls.length, 0, '这些拒绝一次平台请求都没有发出');
});

test('传输层在发出之后的失败仍必须按 unknown 计费：不得把已发出的读退成免费', async () => {
  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1', trackingLimit: 4096 });
  const transport = createQzoneBoundReadTransport({
    botQq: 123,
    getConnectionEpoch: () => 8,
    // The send happens, then the response is lost.
    transport: { async get_qzone_msg_list() { throw new Error('socket hang up'); } },
  });
  await assert.rejects(
    () => transport(Object.freeze({ target_uin: FRIEND, pos: 0, num: 20, botQq: 123,
      connectionEpoch: 8, sourceProofId: 'sp-1' }), () => true),
    (error) => {
      assert.equal(isQzoneReadNotSent(error), false,
        '已发出的请求失败绝不能被标记成「未发出」，否则会退掉本该保留的额度');
      return true;
    });
  void ledger;
});

test('快照形状非法属于派发前拒绝：必须带未发出标记', async () => {
  const transport = createQzoneBoundReadTransport({
    botQq: 123,
    getConnectionEpoch: () => 8,
    transport: { async get_qzone_msg_list() { throw new Error('must not be called'); } },
  });
  // A missing field fails the field-set check, which happens before the send.
  await assert.rejects(
    () => transport(Object.freeze({ target_uin: FRIEND, pos: 0, num: 20, botQq: 123, connectionEpoch: 8 }), () => true),
    (error) => isQzoneReadNotSent(error) === true);
});

test('未发出标记不得被同进程伪造：Symbol.for 与普通字符串键都无法冒充', async () => {
  // The marker unlocks a quota refund, so a forgeable one is a quota bypass: an error
  // raised AFTER the send, tagged from an unrelated module, would make the read free.
  // `Symbol.for` reads the GLOBAL registry, so the first shipped version was
  // forgeable by any same-process module that spelled the key. The shipped marker is a
  // module-private symbol plus a WeakSet of the exact error objects the transport
  // created, so membership cannot be claimed — only received.
  const forgedRegistry = Object.assign(new Error('forged'), { [Symbol.for('qzone.read.not-sent')]: true });
  const forgedString = Object.assign(new Error('forged'), { 'qzone.read.not-sent': true });
  assert.equal(isQzoneReadNotSent(forgedRegistry), false, 'Symbol.for 伪造必须不被承认');
  assert.equal(isQzoneReadNotSent(forgedString), false, '普通字符串键伪造必须不被承认');
  assert.equal(isQzoneReadNotSent(null), false);
  assert.equal(isQzoneReadNotSent(new Error('plain')), false);

  // A refusal raised by the CALLER's guard (not by this module) is also foreign: it is
  // thrown inside the transport call, but the error object is not ours.
  const transport = createQzoneBoundReadTransport({
    botQq: 123,
    getConnectionEpoch: () => 8,
    transport: { async get_qzone_msg_list() { throw new Error('must not be called'); } },
  });
  const foreign = Object.assign(new Error('guard blew up'), { [Symbol.for('qzone.read.not-sent')]: true });
  await assert.rejects(
    () => transport(Object.freeze({ target_uin: FRIEND, pos: 0, num: 20, botQq: 123,
      connectionEpoch: 8, sourceProofId: 'sp-1' }), () => { throw foreign; }),
    (error) => {
      assert.equal(isQzoneReadNotSent(error), false, '调用方守卫抛出的异常不得被当成未发出');
      assert.equal(error.message, 'qzone read unavailable', '外观仍必须统一，不得泄漏内部原因');
      return true;
    });

  // And the genuine case still works: the transport's OWN pre-send refusal is credited.
  // The guard answers false, so the refusal happens before `sent = true`, and this
  // transport's `get_qzone_msg_list` is never reached.
  await assert.rejects(
    () => transport(Object.freeze({ target_uin: FRIEND, pos: 0, num: 20, botQq: 123,
      connectionEpoch: 8, sourceProofId: 'sp-1' }), () => false),
    (error) => isQzoneReadNotSent(error) === true, '本模块自己的派发前拒绝必须仍被承认');
});