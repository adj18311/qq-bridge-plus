import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzoneBoundReadTransport, isQzoneReadNotSent } from '../src/core/qzone-bound-read-transport.mjs';

// Pins the `sent !== true` ordering in the transport's catch
// (`src/core/qzone-bound-read-transport.mjs:77`), which a full-suite mutation proves is
// unpinned: deleting it leaves 664/664 green.
//
// Why the ordering matters at all: the marker unlocks a tracking refund in
// `src/core/qzone-runtime-wiring.mjs`. If a marker-bearing error could be reported as
// "nothing was sent" AFTER the platform read really happened, that read would be free.
// The marker itself cannot be forged (module-private symbol + WeakSet of the exact error
// objects this module created), so the only way to obtain one is to make the transport
// raise it — which a malformed snapshot does.
//
// This test does exactly that: capture a genuine marker object from a pre-send refusal,
// then re-inject it through `getConnectionEpoch`, which the transport calls a SECOND time
// after `sent = true`. With the guard the refusal must look like an ordinary unreadable
// failure; the same re-injection on the FIRST epoch call must still be credited, so the
// guard is not over-broad.

const GOOD = Object.freeze({ target_uin: 456, pos: 0, num: 20, botQq: 123,
  connectionEpoch: 8, sourceProofId: 'sp-1' });
// Missing `sourceProofId` -> the field-set check throws before anything is sent.
const BAD = Object.freeze({ target_uin: 456, pos: 0, num: 20, botQq: 123, connectionEpoch: 8 });

async function captureMarker() {
  const transport = createQzoneBoundReadTransport({
    botQq: 123, getConnectionEpoch: () => 8,
    transport: { async get_qzone_msg_list() { throw new Error('must not be called'); } },
  });
  try {
    await transport(BAD, () => true);
    return null;
  } catch (error) {
    return error;
  }
}

test('传输层在发出之后的异常不得被当成未发出：真正的 marker 对象在 sent 之后重投也必须被抑制', async () => {
  const marker = await captureMarker();
  assert.ok(marker, '形状非法的快照必须在发出之前抛错');
  assert.equal(isQzoneReadNotSent(marker), true, '该拒绝必须带未发出标记（否则本用例没有真正的 marker 可用）');

  // The send happens on the 1st path; the 2nd `getConnectionEpoch` call (after
  // `sent = true`) throws the captured marker object.
  let epochCalls = 0;
  const sentCalls = [];
  const transport = createQzoneBoundReadTransport({
    botQq: 123,
    getConnectionEpoch: () => {
      epochCalls += 1;
      if (epochCalls === 2) throw marker;
      return 8;
    },
    transport: {
      async get_qzone_msg_list(params) {
        sentCalls.push(params);
        return { kind: 'trusted-envelope', envelope: { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } } };
      },
    },
  });

  let thrown = null;
  try { await transport(GOOD, () => true); } catch (error) { thrown = error; }
  assert.equal(sentCalls.length, 1, '本场景必须真的发出过一次请求，否则测的不是「已发出」');
  assert.equal(thrown?.message, 'qzone read unavailable', '外观必须统一，不得泄漏内部原因');
  assert.equal(isQzoneReadNotSent(thrown), false,
    '已发出的读即使拿到真正的 marker 对象也不得报成「未发出」，否则会退掉本该保留的额度');
});

test('同一个 marker 对象在发出之前被重投时仍必须被承认为未发出：守卫不得过宽', async () => {
  const marker = await captureMarker();
  assert.ok(marker);

  let epochCalls = 0;
  const transport = createQzoneBoundReadTransport({
    botQq: 123,
    getConnectionEpoch: () => {
      epochCalls += 1;
      if (epochCalls === 1) throw marker;
      return 8;
    },
    transport: { async get_qzone_msg_list() { throw new Error('must not be called'); } },
  });

  let thrown = null;
  try { await transport(GOOD, () => true); } catch (error) { thrown = error; }
  assert.equal(isQzoneReadNotSent(thrown), true,
    '发出之前的拒绝必须仍被承认，否则预派发拒绝会重新变成锁死类缺陷');
});
