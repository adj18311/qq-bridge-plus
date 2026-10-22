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
