import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getAuthStatus,
  setPassword,
  verifyPassword,
} from '../src/core/console-column-auth.mjs';
import { createQzoneColumnAuthRouteOffline } from '../src/core/qzone-column-auth-route-offline.mjs';

const password = 'correct-horse-battery';
const consoleToken = 'trusted-console-token-value';

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-column-auth-offline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = {
    stateDir: root,
    consoleToken,
    authorizeConsole: () => true,
    verifyCsrf: () => true,
    isAgentPaused: () => true,
    audit: () => true,
    ...overrides,
  };
  return {
    root,
    options,
    handler: createQzoneColumnAuthRouteOffline(options),
    request(method, suffix, extra = {}) {
      return {
        method,
        pathname: `/api/console/qqspace-column/auth/${suffix}`,
        headers: {},
        ...extra,
      };
    },
  };
}

function cookieFrom(response, name = 'qqspace_column_session') {
  const cookie = response.headers['set-cookie'];
  assert.equal(typeof cookie, 'string');
  assert.match(cookie, new RegExp(`^${name}=`));
  return cookie.split(';', 1)[0];
}

test('认证状态不能接受重复的同名空间 Cookie', (t) => {
  const f = fixture(t);
  const setup = f.handler(f.request('POST', 'setup', { body: { password } }));
  const cookie = cookieFrom(setup);
  const status = f.handler(f.request('GET', 'status', { headers: { cookie: `${cookie}; ${cookie}` } }));
  assert.equal(status.body.session.valid, false);
});

test('控制台令牌轮换后设置专栏密码时核对当前令牌', (t) => {
  let current = 'old-console-token';
  const f = fixture(t, { consoleToken: () => current });
  current = 'rotated-console-token';
  const result = f.handler(f.request('POST', 'setup', { body: { password: current } }));
  assert.equal(result.status, 400);
  assert.equal(result.body.reason, 'password-equals-console-token');
  assert.equal(getAuthStatus({ stateDir: f.root, namespace: 'qqspace' }).state, 'unset');
});

test('守卫和执行使用同一递归冻结快照，外部修改不能改变操作或密码', (t) => {
  let original;
  let guardSnapshot;
  const f = fixture(t, {
    authorizeConsole: (snapshot) => {
      guardSnapshot = snapshot;
      assert.notEqual(snapshot, original);
      assert.ok(Object.isFrozen(snapshot));
      assert.ok(Object.isFrozen(snapshot.body));
      assert.ok(Object.isFrozen(snapshot.headers));
      original.pathname = '/api/console/qqspace-column/auth/forgot-reset';
      original.body.password = 'changed-password-value';
      return true;
    },
    verifyCsrf: (snapshot) => {
      assert.equal(snapshot, guardSnapshot);
      return true;
    },
  });
  original = f.request('POST', 'setup', { body: { password } });
  assert.equal(f.handler(original).status, 200);
  assert.equal(verifyPassword({ stateDir: f.root, namespace: 'qqspace', password }).ok, true);
  assert.equal(verifyPassword({ stateDir: f.root, namespace: 'qqspace', password: 'changed-password-value' }).ok, false);
});

test('请求访问器不执行、不泄露错误且不触发认证动作', (t) => {
  let invoked = 0;
  const f = fixture(t, { authorizeConsole: () => { invoked++; return true; } });
  const request = f.request('GET', 'status');
  Object.defineProperty(request, 'method', { enumerable: true, get() { throw new Error('fixture-secret'); } });
  const result = f.handler(request);
  assert.equal(result.status, 400);
  assert.equal(invoked, 0);
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
});

test('异步拒绝的守卫不放行，也不产生未处理拒绝', async (t) => {
  const f = fixture(t, { authorizeConsole: async () => { throw new Error('fixture-secret'); } });
  const unhandled = [];
  const listener = (error) => unhandled.push(error);
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  const result = f.handler(f.request('GET', 'status'));
  assert.equal(result.status, 403);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});

test('时钟返回无效值时不得回退真实时间或触发认证操作', async (t) => {
  const f = fixture(t, { now: () => NaN });
  const result = f.handler(f.request('POST', 'setup', { body: { password } }));
  assert.equal(result.status, 500);
  assert.equal(getAuthStatus({ stateDir: f.root, namespace: 'qqspace' }).state, 'unset');
});

test('认证操作先记录意图与结果，审计不含密码或会话令牌', (t) => {
  const records = [];
  const f = fixture(t, { audit: (entry) => { records.push(entry); return true; } });
  const result = f.handler(f.request('POST', 'setup', { body: { password } }));
  assert.equal(result.status, 200);
  assert.deepEqual(records.map((x) => [x.phase, x.action, x.result]), [
    ['intent', 'setup', 'unknown'], ['outcome', 'setup', 'success'],
  ]);
  assert.match(records[0].operationId, /^[a-f0-9-]{36}$/);
  assert.equal(records[0].operationId, records[1].operationId);
  assert.equal(JSON.stringify(records).includes(password), false);
  assert.equal(JSON.stringify(records).includes(result.headers['set-cookie'].split(';')[0].split('=')[1]), false);
});

test('认证审计意图写入失败时不修改密码，最终审计失败不假称操作未发生', (t) => {
  const failedIntent = fixture(t, { audit: () => false });
  const first = failedIntent.handler(failedIntent.request('POST', 'setup', { body: { password } }));
  assert.equal(first.status, 503);
  assert.equal(getAuthStatus({ stateDir: failedIntent.root, namespace: 'qqspace' }).state, 'unset');
  const failedOutcome = fixture(t, { audit: (entry) => entry.phase === 'intent' });
  const second = failedOutcome.handler(failedOutcome.request('POST', 'setup', { body: { password } }));
  assert.equal(second.status, 500);
  assert.equal(second.body.error, 'audit-outcome-unknown');
  assert.equal(getAuthStatus({ stateDir: failedOutcome.root, namespace: 'qqspace' }).state, 'set');
  assert.equal(Object.hasOwn(second.headers, 'set-cookie'), false);
});

test('错误密码记录失败结果，异步审计不能被误当成持久化成功', async (t) => {
  const records = [];
  const f = fixture(t, { audit: (entry) => { records.push(entry); return true; } });
  assert.equal(f.handler(f.request('POST', 'setup', { body: { password } })).status, 200);
  const result = f.handler(f.request('POST', 'verify', { body: { password: 'wrong-password' } }));
  assert.equal(result.status, 400);
  assert.deepEqual(records.slice(-2).map((entry) => [entry.action, entry.result]), [['verify', 'unknown'], ['verify', 'failure']]);
  const asyncAudit = fixture(t, { audit: async () => { throw new Error('fixture-secret'); } });
  const blocked = asyncAudit.handler(asyncAudit.request('POST', 'setup', { body: { password } }));
  assert.equal(blocked.status, 503);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getAuthStatus({ stateDir: asyncAudit.root, namespace: 'qqspace' }).state, 'unset');
});

test('同一密码可分别设置，但小黑盒会话不能通过 QQ 空间专栏 Cookie', (t) => {
  const f = fixture(t);
  assert.deepEqual(setPassword({ stateDir: f.root, namespace: 'xiaoheihe', password, consoleToken, agentPaused: true }), { ok: true });
  const xbLogin = verifyPassword({ stateDir: f.root, namespace: 'xiaoheihe', password });
  assert.equal(xbLogin.ok, true);

  const setup = f.handler(f.request('POST', 'setup', { body: { password } }));
  assert.equal(setup.status, 200);
  const qqCookie = cookieFrom(setup);
  assert.notEqual(qqCookie.split('=')[1], xbLogin.sessionToken);
  assert.equal(JSON.stringify(setup.body).includes(xbLogin.sessionToken), false);

  const xbCookieAtQqRoute = f.handler(f.request('GET', 'status', {
    headers: { cookie: `xb_column_session=${encodeURIComponent(xbLogin.sessionToken)}` },
  }));
  assert.equal(xbCookieAtQqRoute.body.session.valid, false);
  const xbTokenInQqCookie = f.handler(f.request('GET', 'status', {
    headers: { cookie: `qqspace_column_session=${encodeURIComponent(xbLogin.sessionToken)}` },
  }));
  assert.equal(xbTokenInQqCookie.body.session.valid, false);

  const statusWithQqSession = f.handler(f.request('GET', 'status', { headers: { cookie: qqCookie } }));
  assert.equal(statusWithQqSession.body.session.valid, true);
  assert.equal(getAuthStatus({ stateDir: f.root, namespace: 'qqspace' }).state, 'set');
});

test('注销会撤销 QQ 空间会话并清除专属 Cookie', (t) => {
  const f = fixture(t);
  const setup = f.handler(f.request('POST', 'setup', { body: { password } }));
  const cookie = cookieFrom(setup);
  const logout = f.handler(f.request('POST', 'logout', { headers: { cookie } }));
  assert.equal(logout.status, 200);
  assert.match(logout.headers['set-cookie'], /^qqspace_column_session=; Max-Age=0;/);
  const status = f.handler(f.request('GET', 'status', { headers: { cookie } }));
  assert.equal(status.body.session.valid, false);
});

test('登录成功只通过 QQ 空间专属 Cookie 签发会话 token', (t) => {
  const f = fixture(t);
  const setup = f.handler(f.request('POST', 'setup', { body: { password } }));
  assert.equal(setup.status, 200);

  const login = f.handler(f.request('POST', 'verify', { body: { password } }));
  assert.equal(login.status, 200);
  cookieFrom(login);
  assert.equal(Object.hasOwn(login.body, 'sessionToken'), false);
  assert.equal(JSON.stringify(login.body).includes('sessionToken'), false);

  const wrong = f.handler(f.request('POST', 'verify', { body: { password: 'incorrect-password' } }));
  assert.equal(wrong.status, 400);
  assert.deepEqual(wrong.body, {
    ok: false,
    reason: 'wrong-password',
    failedAttempts: 1,
    lockedSeconds: 0,
  });
});

test('未知路径、方法和畸形密码请求均以固定错误响应拒绝', (t) => {
  const f = fixture(t);
  assert.equal(f.handler(f.request('GET', 'unknown')).status, 404);
  assert.equal(f.handler(f.request('DELETE', 'status')).status, 404);
  const missing = f.handler(f.request('POST', 'verify', { body: { password: 42 } }));
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body, { ok: false, error: 'password-required' });
  const malformed = f.handler(f.request('POST', 'verify', { body: null }));
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.body, { ok: false, error: 'invalid-body' });
});

test('主控制台身份与 CSRF 都必须由可信依赖明确返回 true', (t) => {
  const deniedIdentity = fixture(t, { authorizeConsole: () => false });
  const identityResponse = deniedIdentity.handler(deniedIdentity.request('GET', 'status'));
  assert.equal(identityResponse.status, 403);
  assert.deepEqual(identityResponse.body, { ok: false, error: 'console-auth-required' });

  const thrownIdentity = fixture(t, { authorizeConsole: () => { throw new Error('private detail'); } });
  const thrownResponse = thrownIdentity.handler(thrownIdentity.request('GET', 'status'));
  assert.equal(thrownResponse.status, 403);
  assert.equal(JSON.stringify(thrownResponse).includes('private detail'), false);

  const deniedCsrf = fixture(t, { verifyCsrf: () => false });
  const csrfResponse = deniedCsrf.handler(deniedCsrf.request('GET', 'status'));
  assert.equal(csrfResponse.status, 403);
  assert.deepEqual(csrfResponse.body, { ok: false, error: 'csrf-required' });

  const missingGuards = createQzoneColumnAuthRouteOffline({ stateDir: os.tmpdir(), consoleToken });
  assert.equal(missingGuards({ method: 'GET', pathname: '/api/console/qqspace-column/auth/status' }).status, 403);
});

test('状态文件损坏显示 untrusted，不能被当成未设密码', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'qqspace-console-column-auth.json'), '{broken', 'utf8');
  const response = f.handler(f.request('GET', 'status'));
  assert.equal(response.status, 200);
  assert.equal(response.body.state, 'untrusted');
  const setup = f.handler(f.request('POST', 'setup', { body: { password } }));
  assert.equal(setup.status, 409);
  assert.deepEqual(setup.body, { ok: false, reason: 'state-untrusted' });
});

test('忘记重设只使用可信暂停值，成功后撤销该专栏全部会话', (t) => {
  let paused = true;
  const f = fixture(t, { isAgentPaused: () => paused });
  const setup = f.handler(f.request('POST', 'setup', { body: { password } }));
  const cookie = cookieFrom(setup);
  paused = false;
  const denied = f.handler(f.request('POST', 'forgot-reset', { body: { password: 'different-valid-password' } }));
  assert.equal(denied.status, 409);
  assert.equal(denied.body.reason, 'agent-not-paused');
  assert.equal(f.handler(f.request('GET', 'status', { headers: { cookie } })).body.session.valid, true);

  paused = true;
  const reset = f.handler(f.request('POST', 'forgot-reset', { body: { password: 'different-valid-password' } }));
  assert.equal(reset.status, 200);
  assert.equal(f.handler(f.request('GET', 'status', { headers: { cookie } })).body.session.valid, false);
  assert.equal(getAuthStatus({ stateDir: f.root, namespace: 'qqspace' }).state, 'set');
});

test('暂停状态函数异常时按未暂停处理，且请求体不能伪造暂停状态或会话 token', (t) => {
  const f = fixture(t, { isAgentPaused: () => { throw new Error('sensitive'); } });
  const result = f.handler(f.request('POST', 'forgot-reset', {
    body: { password, agentPaused: true, sessionToken: 'attacker-token' },
  }));
  assert.equal(result.status, 409);
  assert.equal(result.body.reason, 'agent-not-paused');
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
});
