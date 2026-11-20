import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { longWaitFetch, longWaitBudget } from '../src/long-wait-http.js';

test('client budget covers the server wait and its maximum quiet extension', () => {
  assert.equal(longWaitBudget(300000, { maxMs: 600000 }), 445000);
  assert.equal(longWaitBudget(999999, { maxMs: 600000 }), 745000);
  assert.equal(longWaitBudget(undefined, { defaultMs: 5000, minMs: 100, maxMs: 20000, minQuietAfterNewMs: 100 }), 50000);
});

test('long wait POST preserves status and body without imposing a headers deadline', async () => {
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => setTimeout(() => { res.writeHead(429, { 'content-type': 'application/json' }); res.end(body); }, 150));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await longWaitFetch(`http://127.0.0.1:${server.address().port}/wait`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"key":"fixture"}', signal: AbortSignal.timeout(1000),
    });
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { key: 'fixture' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('long wait cancellation disconnects the server', async () => {
  let disconnect;
  const closed = new Promise(resolve => { disconnect = resolve; });
  const server = http.createServer((req, res) => { req.resume(); res.on('close', disconnect); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(longWaitFetch(`http://127.0.0.1:${server.address().port}/wait`, { method: 'POST', signal: AbortSignal.timeout(100) }));
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(Error('server did not disconnect')), 1000))]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

// 回归：2026-11-06 线上 qq_wait_for_messages 超时只报 "Error: [object Object]"，
// 模型看不出是超时还是断连，只能干等。预算到期必须给出可读原因。
test('a timed-out wait reports a readable budget, never "[object Object]"', async () => {
  const server = http.createServer((req) => { req.resume(); }); // 收到请求但永不回应
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      longWaitFetch(`http://127.0.0.1:${server.address().port}/wait`, {
        method: 'POST', signal: AbortSignal.timeout(120), timeoutMs: 120,
      }),
      (error) => {
        assert.ok(error instanceof Error, 'rejects with a real Error');
        assert.match(error.message, /等待请求超时（预算 120ms）/);
        assert.doesNotMatch(error.message, /object Object/);
        return true;
      }
    );
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('a manually aborted wait says it was interrupted, not an object', async () => {
  const server = http.createServer((req) => { req.resume(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 60);
  try {
    await assert.rejects(
      longWaitFetch(`http://127.0.0.1:${server.address().port}/wait`, { method: 'POST', signal: controller.signal }),
      (error) => {
        assert.match(error.message, /等待请求被中断/);
        assert.doesNotMatch(error.message, /object Object/);
        return true;
      }
    );
  } finally { await new Promise(resolve => server.close(resolve)); }
});
