import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzoneBoundReadTransport } from '../src/core/qzone-bound-read-transport.mjs';

test('连接检查期间来源撤销，发送点同步阻止空间请求', async () => {
  let allowed = true, calls = 0;
  const read = createQzoneBoundReadTransport({ botQq: 123, getConnectionEpoch: async () => {
    allowed = false; return 7;
  }, transport: { async get_qzone_msg_list() { calls++; return { kind: 'trusted-envelope', envelope: {} }; } } });
  const input = { target_uin: 456, pos: 0, num: 20, botQq: 123, connectionEpoch: 7, sourceProofId: 'proof-1' };
  await assert.rejects(read(input, () => allowed));
  assert.equal(calls, 0);
});

test('缺少来源守卫时即使连接正常也不得调用传输', async () => {
  let calls = 0;
  const read = createQzoneBoundReadTransport({ botQq: 123, getConnectionEpoch: () => 7,
    transport: { async get_qzone_msg_list() { calls++; return { kind: 'trusted-envelope', envelope: {} }; } } });
  await assert.rejects(read({ target_uin: 456, pos: 0, num: 20, botQq: 123, connectionEpoch: 7, sourceProofId: 'p' }));
  assert.equal(calls, 0);
});

test('仅透传固定空间读取字段并要求返回前连接代际仍相同', async () => {
  let epoch = 7;
  const calls = [];
  const envelope = { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
  const read = createQzoneBoundReadTransport({ botQq: 123, getConnectionEpoch: () => epoch,
    transport: { async get_qzone_msg_list(input) { calls.push(input); return { kind: 'trusted-envelope', envelope }; } } });
  const input = { target_uin: 456, pos: 0, num: 20, botQq: 123, connectionEpoch: 7, sourceProofId: 'proof-1' };
  assert.equal(await read(input, () => true), envelope);
  assert.deepEqual(calls, [{ target_uin: 456, pos: 0, num: 20 }]);
  epoch = 8;
  await assert.rejects(read(input, () => true));
  assert.equal(calls.length, 1);
});

test('连接在请求期间变化、bot 不匹配或传输结果未知时拒绝返回内容', async () => {
  let epoch = 7;
  let result = { kind: 'trusted-envelope', envelope: { status: 'ok' } };
  let switchEpoch = true;
  const read = createQzoneBoundReadTransport({ botQq: 123, getConnectionEpoch: () => epoch,
    transport: { async get_qzone_msg_list() { if (switchEpoch) epoch++; return result; } } });
  const input = { target_uin: 456, pos: 0, num: 20, botQq: 123, connectionEpoch: 7, sourceProofId: 'proof-1' };
  await assert.rejects(read(input, () => true));
  switchEpoch = false;
  await assert.rejects(read({ ...input, botQq: 999, connectionEpoch: 8 }, () => true));
  result = { status: 'unknown' };
  await assert.rejects(read({ ...input, connectionEpoch: 8 }, () => true));
});
