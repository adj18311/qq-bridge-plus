import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzoneOnebotWriteTransport } from '../src/core/qzone-onebot-write-transport.mjs';

test('受注入的测试传输只派发白名单动作，投影成功结果且不泄漏响应', async () => {
  const calls = [];
  const transport = createQzoneOnebotWriteTransport({ origin: 'http://127.0.0.1:3210', fetch: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { tid: 'p1', time: 123, token: 'fixture-secret' } }),
      { headers: { 'content-type': 'application/json' } });
  } });
  const result = await transport.send('publish', { content: 'hello', ugc_right: 4 });
  assert.deepEqual(result, { outcome: 'success', postId: 'p1' });
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:3210/send_qzone_msg', body: { content: 'hello', ugc_right: 4 } }]);
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
});

test('超时、异常、失败响应均为未知且不自动重发', async () => {
  let calls = 0;
  const transport = createQzoneOnebotWriteTransport({ origin: 'http://127.0.0.1:3210', timeoutMs: 10,
    fetch: async () => { calls++; return new Promise(() => {}); } });
  assert.deepEqual(await transport.send('like', { tid: 'p1', target_uin: 123 }), { outcome: 'unknown' });
  assert.equal(calls, 1);
  const throwing = createQzoneOnebotWriteTransport({ origin: 'http://127.0.0.1:3210', fetch: async () => { throw new Error('fixture-secret'); } });
  assert.deepEqual(await throwing.send('like', { tid: 'p1', target_uin: 123 }), { outcome: 'unknown' });
});

test('非法输入及非本机地址不得触发传输', async () => {
  let calls = 0;
  assert.throws(() => createQzoneOnebotWriteTransport({ origin: 'http://example.com', fetch: async () => { calls++; } }));
  const transport = createQzoneOnebotWriteTransport({ origin: 'http://127.0.0.1:3210', fetch: async () => { calls++; } });
  assert.deepEqual(await transport.send('delete', { tid: 'p1' }), { outcome: 'unknown' });
  assert.deepEqual(await transport.send('publish', { content: 'hello' }), { outcome: 'unknown' });
  assert.equal(calls, 0);
});

test('响应体读取超时时取消读取器，不遗留悬挂响应', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { 'content-type': 'application/json' } });
  const transport = createQzoneOnebotWriteTransport({ origin: 'http://127.0.0.1:3210', timeoutMs: 10, fetch: async () => response });
  assert.deepEqual(await transport.send('like', { tid: 'p1', target_uin: 123 }), { outcome: 'unknown' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('拒绝状态、类型或大小异常的响应时取消响应体', async () => {
  for (const init of [
    { status: 503, headers: { 'content-type': 'application/json' } },
    { status: 200, headers: { 'content-type': 'text/plain' } },
    { status: 200, headers: { 'content-type': 'application/json', 'content-length': '1048577' } },
  ]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), init);
    const transport = createQzoneOnebotWriteTransport({ origin: 'http://127.0.0.1:3210', fetch: async () => response });
    assert.deepEqual(await transport.send('like', { tid: 'p1', target_uin: 123 }), { outcome: 'unknown' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
  }
});

test('确定的网络不可用返回独立状态以触发访问熔断，不重放且不泄露异常', async () => {
  let calls = 0;
  const transport = createQzoneOnebotWriteTransport({ origin: 'http://127.0.0.1:3210', fetch: async () => {
    calls++;
    const error = new Error('fixture-secret');
    error.cause = { code: 'ECONNREFUSED' };
    throw error;
  } });
  assert.deepEqual(await transport.send('like', { tid: 'p1', target_uin: 123 }), { outcome: 'network_unavailable' });
  assert.equal(calls, 1);
});

test('收到响应后读取失败不能推断写操作未发生', async () => {
  const error = new Error('fixture-secret');
  error.cause = { code: 'ECONNREFUSED' };
  const response = new Response(new ReadableStream({ pull(controller) { controller.error(error); } }),
    { headers: { 'content-type': 'application/json' } });
  const transport = createQzoneOnebotWriteTransport({ origin: 'http://127.0.0.1:3210', fetch: async () => response });
  assert.deepEqual(await transport.send('like', { tid: 'p1', target_uin: 123 }), { outcome: 'unknown' });
});
