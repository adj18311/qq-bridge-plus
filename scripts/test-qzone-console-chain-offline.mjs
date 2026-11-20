import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createOfflineColumnAuthAudit } from '../src/core/qzone-column-auth-audit-offline.mjs';
import { createQzoneColumnAuthRouteOffline } from '../src/core/qzone-column-auth-route-offline.mjs';
import { createOfflineQzoneAdminRouter } from '../src/core/qzone-admin-router-offline.mjs';
import { verifySession, setPassword, verifyPassword } from '../src/core/console-column-auth.mjs';

test('独立密码会话与管理路由离线组合：跨专栏拒绝、额度与恢复分开审计', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-console-chain-')); let store;
  t.after(async () => { store?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-08T03:00:00Z');
  store = openOfflineStore(join(dir, 'state.db'), { enabled: false, readAllowed: true, writeAllowed: true,
    accessPaused: true, writePaused: true, reads: 3, writes: 3, probe: 'manual_only',
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 3, comment: 25, like: 30 }, intervalMinutes: 100, activeStart: 420, activeEnd: 1380,
    ledger: { day: '2026-11-08', used: { post: 2, comment: 8, like: 9 }, reservations: {} }, audit: [] });
  const password = 'temporary-example-password';
  const authRoute = createQzoneColumnAuthRouteOffline({ stateDir: dir, consoleToken: 'console-fixture',
    authorizeConsole: () => true, verifyCsrf: () => true, isAgentPaused: () => true,
    now: () => now, audit: createOfflineColumnAuthAudit(store, { selfId: '123' }) });
  assert.equal(setPassword({ stateDir: dir, password, consoleToken: 'console-fixture', agentPaused: true, now }).ok, true);
  const xhh = verifyPassword({ stateDir: dir, password, now });
  const setup = authRoute({ method: 'POST', pathname: '/api/console/qqspace-column/auth/setup', headers: {}, body: { password } });
  assert.equal(setup.status, 200);
  const token = decodeURIComponent(setup.headers['set-cookie'].split(';')[0].split('=')[1]);
  const router = createOfflineQzoneAdminRouter({ store, clock: () => now, selfId: '123',
    authenticate: ({ sessionToken }) => {
      const session = verifySession({ sessionToken, namespace: 'qqspace', now });
      return session.ok ? { valid: true, operator: session.sessionId } : { valid: false, operator: 'none' };
    } });
  assert.equal((await router({ method: 'GET', path: '/status', sessionToken: xhh.sessionToken })).status, 401);
  assert.equal((await router({ method: 'POST', path: '/quota/reset', body: { kind: 'post' }, sessionToken: token })).status, 200);
  assert.equal(store.read().accessPaused, true);
  assert.equal(store.read().ledger.used.post, 0);
  assert.equal((await router({ method: 'POST', path: '/pause/restore', body: { layer: 'both' }, sessionToken: token })).status, 200);
  assert.equal(store.read().accessPaused, false);
  assert.equal(store.read().writePaused, false);
  assert.deepEqual(store.read().ledger.used, { post: 0, comment: 8, like: 9 });
  assert.equal(store.read().enabled, false);
  const managementAudit = store.read().audit.map(({ record }) => record).filter(({ action }) => ['reset_quota', 'restore'].includes(action));
  const managementRows = managementAudit.map(({ action, result, content }) => ({ action, result, content: JSON.parse(content) }));
  assert.deepEqual(managementRows.map(({ action, result, content }) => ({ action, result,
    content: Object.fromEntries(Object.entries(content).filter(([key]) => key !== 'correlationId')) })), [
    { action: 'reset_quota', result: 'unknown', content: { selection: 'post', phase: 'intent' } },
    { action: 'reset_quota', result: 'success', content: { selection: 'post' } },
    { action: 'restore', result: 'unknown', content: { selection: 'both', phase: 'intent' } },
    { action: 'restore', result: 'success', content: { selection: 'both', pauseReasons: { access: 'unknown', write: 'unknown' } } },
  ]);
  assert.ok(managementRows[0].content.correlationId);
  assert.equal(managementRows[0].content.correlationId, managementRows[1].content.correlationId);
  assert.ok(managementRows[2].content.correlationId);
  assert.equal(managementRows[2].content.correlationId, managementRows[3].content.correlationId);
  assert.notEqual(managementRows[0].content.correlationId, managementRows[2].content.correlationId);
  assert.equal(store.read().audit.length, 6);
  assert.equal(JSON.stringify(store.read().audit).includes(password), false);
  assert.equal(JSON.stringify(store.read().audit).includes(token), false);
  store.close();
  store = openOfflineStore(join(dir, 'state.db'), { audit: [] });
  const reopened = store.read();
  assert.equal(reopened.enabled, false);
  assert.equal(reopened.accessPaused, false);
  assert.equal(reopened.writePaused, false);
  assert.deepEqual(reopened.ledger.used, { post: 0, comment: 8, like: 9 });
  assert.equal(reopened.audit.length, 6);
  assert.equal(JSON.stringify(reopened.audit).includes(password), false);
  assert.equal(JSON.stringify(reopened.audit).includes(token), false);
});
