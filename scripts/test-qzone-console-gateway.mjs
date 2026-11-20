import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createQzoneConsoleGateway } from '../src/core/qzone-console-gateway.mjs';

test('控制台入口要求主鉴权、CSRF与独立空间会话，管理操作与审计共用存储', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-gateway-'));
  const now = Date.parse('2026-11-08T03:00:00Z');
  const store = openOfflineStore(join(dir, 'qzone.db'), { enabled: false, readAllowed: true, writeAllowed: true,
    accessPaused: true, writePaused: true, reads: 3, writes: 3, probe: 'manual_only',
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 3, comment: 25, like: 30 }, intervalMinutes: 100, activeStart: 420, activeEnd: 1380,
    ledger: { day: '2026-11-08', used: { post: 2, comment: 8, like: 9 }, reservations: {} }, audit: [] });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const gateway = createQzoneConsoleGateway({ store, stateDir: dir, selfId: '123', consoleToken: 'fixture-console-token',
    authorizeConsole: (request) => request.headers.auth === 'ok', verifyCsrf: (request) => request.headers.csrf === 'ok',
    isAgentPaused: () => true, now: () => now });
  const request = (method, path, headers = {}, body) => ({ method, pathname: `/api/console/qqspace-column${path}`, headers, ...(body === undefined ? {} : { body }) });
  const auth = { auth: 'ok', csrf: 'ok' };
  assert.equal((await gateway(request('GET', '/status'))).status, 403);
  assert.equal((await gateway(request('GET', '/status', { auth: 'ok' }))).status, 403);
  assert.equal((await gateway(request('GET', '/status', auth))).status, 401);
  const setup = await gateway(request('POST', '/auth/setup', auth, { password: 'example-password-one' }));
  assert.equal(setup.status, 200);
  const cookie = setup.headers['set-cookie'].split(';')[0];
  const loggedIn = { ...auth, cookie };
  const statusResponse = await gateway(request('GET', '/status', loggedIn));
  assert.equal(statusResponse.status, 200);
  assert.equal(statusResponse.body.dispatchAvailable, false);
  assert.equal((await gateway(request('GET', '/status', { ...auth, cookie: `${cookie}; ${cookie}` }))).status, 401);
  assert.equal((await gateway(request('POST', '/quota/reset', loggedIn, { kind: 'post' }))).status, 200);
  assert.equal(store.read().ledger.used.post, 0);
  assert.equal(store.read().accessPaused, true);
  const managementAudit = store.read().audit.map(({ record }) => record).filter(({ action }) => action === 'reset_quota');
  const managementRows = managementAudit.map(({ result, content }) => ({ result, content: JSON.parse(content) }));
  assert.deepEqual(managementRows.map(({ result, content }) => ({ result,
    content: Object.fromEntries(Object.entries(content).filter(([key]) => key !== 'correlationId')) })), [
    { result: 'unknown', content: { selection: 'post', phase: 'intent' } },
    { result: 'success', content: { selection: 'post' } },
  ]);
  assert.ok(managementRows[0].content.correlationId);
  assert.equal(managementRows[0].content.correlationId, managementRows[1].content.correlationId);
  assert.equal(store.read().audit.length, 4);
  assert.equal(JSON.stringify(store.read().audit).includes(cookie), false);
  const audit = await gateway(request('GET', '/audit', loggedIn));
  assert.equal(audit.status, 200);
  assert.equal(audit.body.records.length, 4);
  assert.equal(JSON.stringify(audit.body).includes('example-password-one'), false);
  assert.equal(JSON.stringify(audit.body).includes(cookie), false);
  assert.equal((await gateway(request('GET', '/audit', auth))).status, 401);
  assert.equal((await gateway(request('POST', '/pause/restore', { ...loggedIn, csrf: 'no' }, { layer: 'both' }))).status, 403);
  assert.equal(store.read().accessPaused, true);
  let accessed = false;
  const forged = request('POST', '/pause/restore', loggedIn, { layer: 'both' });
  Object.defineProperty(forged.body, 'operator', { enumerable: true, get() { accessed = true; return 'fake'; } });
  assert.equal((await gateway(forged)).status, 400);
  assert.equal(accessed, false);
  assert.equal(store.read().accessPaused, true);
});
