import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createOfflineColumnAuthAudit } from '../src/core/qzone-column-auth-audit-offline.mjs';
import { createQzoneColumnAuthRouteOffline } from '../src/core/qzone-column-auth-route-offline.mjs';
import { setPassword } from '../src/core/console-column-auth.mjs';
import { verifyOfflineColumnPassword } from '../src/core/qzone-column-auth-audit-offline.mjs';

test('本机备用恢复可只读验证 qqspace 密码，且不创建会话或改写登录状态', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-auth-readonly-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const password = 'synthetic-recovery-password';
  assert.deepEqual(setPassword({ stateDir: dir, namespace: 'qqspace', password, agentPaused: true, now: 1 }), { ok: true });
  const filename = join(dir, 'qqspace-console-column-auth.json');
  const before = await readFile(filename, 'utf8');
  assert.equal(verifyOfflineColumnPassword({ stateDir: dir, namespace: 'qqspace', password, now: 2 }), true);
  assert.equal(verifyOfflineColumnPassword({ stateDir: dir, namespace: 'qqspace', password: 'wrong synthetic password', now: 2 }), false);
  assert.equal(verifyOfflineColumnPassword({ stateDir: dir, namespace: 'xiaoheihe', password, now: 2 }), false);
  assert.equal(await readFile(filename, 'utf8'), before);
});

test('专栏认证意图和结果以同一操作标识写入安全审计', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-auth-audit-')); let store;
  t.after(async () => { store?.close(); await rm(dir, { recursive: true, force: true }); });
  store = openOfflineStore(join(dir, 'state.db'), { audit: [] });
  const audit = createOfflineColumnAuthAudit(store, { selfId: '123' });
  const event = { operationId: 'op-1', action: 'verify', time: 1000, source: 'admin_console' };
  assert.equal(audit({ ...event, phase: 'intent', result: 'unknown' }), true);
  assert.equal(audit({ ...event, phase: 'outcome', result: 'failure' }), true);
  const records = store.read().audit;
  assert.equal(records.length, 2);
  assert.equal(records[0].id, 'auth_op-1_intent');
  assert.equal(records[1].id, 'auth_op-1_outcome');
  assert.equal(records[1].record.action, 'authenticate');
  assert.equal(records[1].record.result, 'failure');
});

test('无意图的结果、额外字段、不同动作和重复事件不能写入审计', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-auth-audit-')); let store;
  t.after(async () => { store?.close(); await rm(dir, { recursive: true, force: true }); });
  store = openOfflineStore(join(dir, 'state.db'), { audit: [] });
  const audit = createOfflineColumnAuthAudit(store, { selfId: '123' });
  const event = { operationId: 'op-1', action: 'verify', time: 1000, source: 'admin_console' };
  assert.equal(audit({ ...event, phase: 'outcome', result: 'success' }), false);
  assert.equal(audit({ ...event, phase: 'intent', result: 'unknown', password: 'fixture-secret' }), false);
  assert.equal(audit({ ...event, phase: 'intent', result: 'unknown' }), true);
  assert.equal(audit({ ...event, phase: 'intent', result: 'unknown' }), false);
  assert.equal(audit({ ...event, action: 'setup', phase: 'outcome', result: 'success' }), false);
  assert.equal(store.read().audit.length, 1);
  assert.equal(JSON.stringify(store.read()).includes('fixture-secret'), false);
});

test('认证路由与持久化审计适配器组合时不保存密码或 cookie', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-auth-audit-')); let store;
  t.after(async () => { store?.close(); await rm(dir, { recursive: true, force: true }); });
  store = openOfflineStore(join(dir, 'state.db'), { audit: [] });
  const handler = createQzoneColumnAuthRouteOffline({ stateDir: dir, consoleToken: 'control-token',
    authorizeConsole: () => true, verifyCsrf: () => true, isAgentPaused: () => true,
    now: () => 1000, audit: createOfflineColumnAuthAudit(store, { selfId: '123' }) });
  const result = handler({ method: 'POST', pathname: '/api/console/qqspace-column/auth/setup',
    headers: {}, body: { password: 'fixture-private-password' } });
  assert.equal(result.status, 200);
  assert.equal(store.read().audit.length, 2);
  assert.equal(JSON.stringify(store.read().audit).includes('fixture-private-password'), false);
  assert.equal(JSON.stringify(store.read().audit).includes(result.headers['set-cookie'].split(';')[0].split('=')[1]), false);
});

test('重启存储后仍能关联未完成的认证意图，且不能重复写入结果', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-auth-reopen-')); let store;
  t.after(async () => { store?.close(); await rm(dir, { recursive: true, force: true }); });
  const path = join(dir, 'state.db');
  store = openOfflineStore(path, { audit: [] });
  const event = { operationId: 'restart-1', action: 'logout', time: 1000, source: 'admin_console' };
  assert.equal(createOfflineColumnAuthAudit(store, { selfId: '123' })({ ...event, phase: 'intent', result: 'unknown' }), true);
  store.close();
  store = openOfflineStore(path, { audit: [] });
  const audit = createOfflineColumnAuthAudit(store, { selfId: '123' });
  assert.equal(store.read().audit.length, 1);
  assert.equal(audit({ ...event, phase: 'outcome', result: 'success' }), true);
  assert.equal(audit({ ...event, phase: 'outcome', result: 'success' }), false);
  store.close();
  store = openOfflineStore(path, { audit: [] });
  assert.deepEqual(store.read().audit.map((entry) => entry.id), ['auth_restart-1_intent', 'auth_restart-1_outcome']);
});

test('异步存储回调不得在审计返回失败后迟到写入', async () => {
  let state = { audit: [] };
  const store = { update(callback) { return Promise.resolve().then(() => { state = callback(state); }); } };
  const audit = createOfflineColumnAuthAudit(store, { selfId: '123' });
  assert.equal(audit({ operationId: 'late-1', action: 'verify', time: 1000,
    source: 'admin_console', phase: 'intent', result: 'unknown' }), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.audit, []);
});

test('异步存储拒绝和抛错后的迟到回调均不会写入审计', async () => {
  let state = { audit: [] };
  const event = { operationId: 'late-2', action: 'verify', time: 1000,
    source: 'admin_console', phase: 'intent', result: 'unknown' };
  const rejecting = createOfflineColumnAuthAudit({ update() { return Promise.reject(new Error('fixture')); } }, { selfId: '123' });
  assert.equal(rejecting(event), false);
  const throwing = createOfflineColumnAuthAudit({ update(callback) {
    setImmediate(() => { state = callback(state); });
    throw new Error('fixture');
  } }, { selfId: '123' });
  assert.equal(throwing(event), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.audit, []);
});
