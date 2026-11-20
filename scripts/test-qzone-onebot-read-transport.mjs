import assert from 'node:assert/strict';
import { createQzoneOnebotReadTransport } from '../src/core/qzone-onebot-read-transport.mjs';

const secret = 'never-print-this-token';
const okEnvelope = { status: 'ok', retcode: 0, data: { msglist: [] } };

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function fakeFetchWith(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  return { fetch, calls };
}

{
  const { fetch, calls } = fakeFetchWith(() => response(okEnvelope));
  const transport = createQzoneOnebotReadTransport({
    origin: 'http://127.0.0.1:5700',
    fetch,
    authHeaders: { Authorization: `Bearer ${secret}` }
  });
  const result = await transport.get_qzone_msg_list({ target_uin: '12345', pos: 2, num: 4 });
  assert.deepEqual(result, { kind: 'trusted-envelope', envelope: okEnvelope });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:5700/get_qzone_msg_list');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.get('authorization'), `Bearer ${secret}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { target_uin: 12345, pos: 2, num: 4 });
}

{
  const { fetch, calls } = fakeFetchWith(() => response({ status: 'ok', retcode: 0, data: { tid: 'p1' } }));
  const transport = createQzoneOnebotReadTransport({ origin: 'http://[::1]:5700', fetch });
  const result = await transport.get_qzone_msg_detail({ tid: 'p1', target_uin: 12345 });
  assert.deepEqual(result, {
    kind: 'trusted-envelope',
    envelope: { status: 'ok', retcode: 0, data: { tid: 'p1' } }
  });
  assert.equal(calls[0].url, 'http://[::1]:5700/get_qzone_msg_detail');
  assert.deepEqual(JSON.parse(calls[0].init.body), { tid: 'p1', target_uin: 12345, pos: 0, num: 20 });
}

for (const origin of [
  'https://127.0.0.1',
  'http://localhost:5700',
  'http://192.168.1.2:5700',
  'http://user:pass@127.0.0.1:5700',
  'http://127.0.0.1:5700/path',
  'http://127.0.0.1:5700?x=1',
  'http://127.0.0.1:5700#fragment',
  'http://2130706433:5700',
  'http://[::ffff:127.0.0.1]:5700'
]) {
  assert.throws(() => createQzoneOnebotReadTransport({ origin, fetch: async () => response(okEnvelope) }));
}

assert.throws(() => createQzoneOnebotReadTransport({ origin: 'http://127.0.0.1:5700' }), /fetch/);
assert.throws(() => createQzoneOnebotReadTransport({
  origin: 'http://127.0.0.1:5700', fetch: async () => response(okEnvelope),
  authHeaders: { 'Content-Type': 'text/plain' }
}));

{
  const invalidAuthorization = `Bearer ${secret}\nX-Injected: value`;
  assert.throws(
    () => createQzoneOnebotReadTransport({
      origin: 'http://127.0.0.1:5700', fetch: async () => response(okEnvelope),
      authHeaders: { Authorization: invalidAuthorization }
    }),
    (error) => error.message === 'invalid authentication headers' && !error.message.includes(secret)
  );
}

assert.throws(() => createQzoneOnebotReadTransport({
  origin: 'http://127.0.0.1:5700', fetch: async () => response(okEnvelope),
  authHeaders: { 'X-OneBot-Token': secret }
}), (error) => error.message === 'invalid authentication headers' && !error.message.includes(secret));

for (const options of [
  { origin: 'http://127.0.0.1:5700', fetch: async () => response(okEnvelope),
    get authHeaders() { throw new Error(secret); } },
  new Proxy({ origin: 'http://127.0.0.1:5700', fetch: async () => response(okEnvelope) }, {
    get(target, key) {
      if (key === 'authHeaders') throw new Error(secret);
      return Reflect.get(target, key);
    }
  })
]) {
  let caught;
  try {
    createQzoneOnebotReadTransport(options);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(String(caught.message).includes(secret), false);
  assert.equal(caught.message, 'invalid transport options');
}

for (const makeResult of [
  () => new Response('not-json', { status: 200 }),
  () => response({ status: 'failed', retcode: 1, message: secret }),
  () => response(okEnvelope, 302),
  () => new Response('x'.repeat(128), { status: 200, headers: { 'content-type': 'application/json' } })
]) {
  const { fetch } = fakeFetchWith(() => makeResult());
  const transport = createQzoneOnebotReadTransport({
    origin: 'http://127.0.0.1:5700', fetch, maxResponseBytes: 64
  });
  const result = await transport.get_qzone_msg_list({ target_uin: 12345 });
  assert.deepEqual(result, { status: 'unknown' });
  assert.equal(JSON.stringify(result).includes(secret), false);
}

for (const testCase of [
  { status: 503, headers: { 'content-type': 'application/json' }, cancel: 'pending' },
  { status: 200, headers: { 'content-type': 'text/plain' }, cancel: 'reject' },
  { status: 200, headers: { 'content-type': 'application/json', 'content-length': '65' }, cancel: 'throw' }
]) {
  let cancelCount = 0;
  let readerRequested = false;
  const rejectedResponse = {
    status: testCase.status,
    headers: new Headers(testCase.headers),
    body: {
      cancel() {
        cancelCount += 1;
        if (testCase.cancel === 'throw') throw new Error(secret);
        if (testCase.cancel === 'reject') return Promise.reject(new Error(secret));
        return new Promise(() => {});
      },
      getReader() { readerRequested = true; throw new Error(secret); }
    }
  };
  const transport = createQzoneOnebotReadTransport({
    origin: 'http://127.0.0.1:5700', maxResponseBytes: 64,
    fetch: async () => rejectedResponse
  });
  let deadline;
  const result = await Promise.race([
    transport.get_qzone_msg_list({ target_uin: 12345 }),
    new Promise((resolve) => { deadline = setTimeout(() => resolve('blocked'), 250); })
  ]);
  clearTimeout(deadline);
  assert.deepEqual(result, { status: 'unknown' });
  assert.equal(cancelCount, 1);
  assert.equal(readerRequested, false);
  await new Promise((resolve) => setImmediate(resolve));
}

for (const cancelBehavior of ['pending', 'reject', 'throw']) {
  let cancelCount = 0;
  let releaseCount = 0;
  const transport = createQzoneOnebotReadTransport({
    origin: 'http://127.0.0.1:5700',
    fetch: async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: {
        getReader() {
          return {
            read: async () => ({ done: false, value: 'invalid chunk' }),
            cancel() {
              cancelCount += 1;
              if (cancelBehavior === 'throw') throw new Error(secret);
              if (cancelBehavior === 'reject') return Promise.reject(new Error(secret));
              return new Promise(() => {});
            },
            releaseLock() { releaseCount += 1; }
          };
        }
      }
    })
  });
  let deadline;
  const result = await Promise.race([
    transport.get_qzone_msg_list({ target_uin: 12345 }),
    new Promise((resolve) => { deadline = setTimeout(() => resolve('blocked'), 250); })
  ]);
  clearTimeout(deadline);
  assert.deepEqual(result, { status: 'unknown' });
  assert.equal(cancelCount, 1);
  assert.equal(releaseCount, 1);
  await new Promise((resolve) => setImmediate(resolve));
}

{
  let signal;
  let attempts = 0;
  const transport = createQzoneOnebotReadTransport({
    origin: 'http://127.0.0.1:5700',
    timeoutMs: 25,
    fetch: async (_url, init) => {
      attempts += 1;
      signal = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error(secret))));
    }
  });
  const result = await transport.get_qzone_msg_list({ target_uin: 12345 });
  assert.deepEqual(result, { status: 'unknown' });
  assert.equal(signal.aborted, true);
  assert.equal(attempts, 1);
}

{
  let cancelCalled = false;
  const hangingReaderResponse = {
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: {
      getReader() {
        return {
          read: () => new Promise(() => {}),
          cancel() {
            cancelCalled = true;
            return new Promise(() => {});
          },
          releaseLock() {}
        };
      }
    }
  };
  const transport = createQzoneOnebotReadTransport({
    origin: 'http://127.0.0.1:5700',
    timeoutMs: 20,
    fetch: async () => hangingReaderResponse
  });
  const result = await transport.get_qzone_msg_list({ target_uin: 12345 });
  assert.deepEqual(result, { status: 'unknown' });
  assert.equal(cancelCalled, true);
}

{
  const transport = createQzoneOnebotReadTransport({
    origin: 'http://127.0.0.1:5700',
    fetch: async () => { throw new Error(secret); }
  });
  assert.deepEqual(await transport.get_qzone_msg_list({ target_uin: 12345 }), { status: 'unknown' });
}

for (const code of ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']) {
  let attempts = 0;
  const transport = createQzoneOnebotReadTransport({
    origin: 'http://127.0.0.1:5700',
    fetch: async () => {
      attempts += 1;
      const error = new Error(secret);
      error.cause = { code };
      throw error;
    }
  });
  assert.deepEqual(await transport.get_qzone_msg_list({ target_uin: 12345 }), {
    status: 'gateway_unavailable'
  });
  assert.equal(attempts, 1);
}

{
  let invoked = false;
  const error = new Error(secret);
  Object.defineProperty(error, 'cause', { get() { invoked = true; return { code: 'ECONNREFUSED' }; } });
  const transport = createQzoneOnebotReadTransport({ origin: 'http://127.0.0.1:5700', fetch: async () => { throw error; } });
  assert.deepEqual(await transport.get_qzone_msg_list({ target_uin: 12345 }), { status: 'unknown' });
  assert.equal(invoked, false);
}

{
  const transport = createQzoneOnebotReadTransport({
    origin: 'http://127.0.0.1:5700',
    fetch: async () => response({ status: 'failed', retcode: 401, message: secret }, 401)
  });
  assert.deepEqual(await transport.get_qzone_msg_list({ target_uin: 12345 }), { status: 'unknown' });
}

for (const code of ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']) {
  const transport = createQzoneOnebotReadTransport({
    origin: 'http://127.0.0.1:5700',
    fetch: async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: {
        getReader() {
          return {
            async read() {
              const error = new Error(secret);
              error.cause = { code };
              throw error;
            },
            cancel() {},
            releaseLock() {}
          };
        }
      }
    })
  });
  assert.deepEqual(await transport.get_qzone_msg_list({ target_uin: 12345 }), { status: 'unknown' });
}

{
  const { fetch, calls } = fakeFetchWith(() => response(okEnvelope));
  const transport = createQzoneOnebotReadTransport({ origin: 'http://127.0.0.1:5700', fetch });
  assert.deepEqual(await transport.get_qzone_msg_list({ target_uin: 12345, token: secret }), { status: 'unknown' });
  assert.equal(calls.length, 0);
}

{
  const { fetch, calls } = fakeFetchWith(() => response(okEnvelope));
  const transport = createQzoneOnebotReadTransport({
    origin: 'http://127.0.0.1:5700', path: '/onebot/v11/', fetch
  });
  await transport.get_qzone_msg_list({ target_uin: 12345 });
  assert.equal(calls[0].url, 'http://127.0.0.1:5700/onebot/v11/get_qzone_msg_list');
}

for (const path of [
  '../admin',
  '/onebot/../admin',
  '/%2e%2e/admin',
  '/onebot%2fadmin',
  '/onebot%2Fadmin',
  '/onebot?x=1',
  '/onebot#fragment',
  '//other-host/path',
  '/onebot/./api',
  '/onebot\\admin'
]) {
  assert.throws(() => createQzoneOnebotReadTransport({
    origin: 'http://127.0.0.1:5700', path, fetch: async () => response(okEnvelope)
  }), (error) => error.message === 'invalid OneBot path');
}

{
  let deliverResponse;
  let cancelCalled = false;
  let readerRequested = false;
  const lateResponse = {
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: {
      cancel() {
        cancelCalled = true;
        return Promise.reject(new Error(secret));
      },
      getReader() {
        readerRequested = true;
        return {
          read: () => new Promise(() => {}),
          cancel() { return new Promise(() => {}); },
          releaseLock() {}
        };
      }
    }
  };
  const transport = createQzoneOnebotReadTransport({
    origin: 'http://127.0.0.1:5700',
    timeoutMs: 15,
    fetch: async () => new Promise((resolve) => { deliverResponse = resolve; })
  });
  assert.deepEqual(await transport.get_qzone_msg_list({ target_uin: 12345 }), { status: 'unknown' });
  deliverResponse(lateResponse);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelCalled, true);
  assert.equal(readerRequested, false);
}

console.log('qzone-onebot-read-transport: all assertions passed');
