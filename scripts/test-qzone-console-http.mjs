import test from 'node:test';
import assert from 'node:assert/strict';
import { busyHarness } from './busy-watchdog-harness.mjs';
import * as runtimeModule from '../src/core/qzone-console-runtime.mjs';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { main as recover } from './qzone-admin-recover.mjs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

test('桥接真实 HTTP 管理路由：主鉴权、CSRF、独立密码和审计', async (t) => {
  const token = 'fixture-console-token-123456';
  const anchor = "await import('./core/qzone-console-runtime.mjs')";
  let runtime;
  const harness = await busyHarness({ config: { consoleToken: token, consolePort: 0,
    snowluma: { httpUrl: 'http://127.0.0.1:5700' }, backgroundPatrol: { enabled: false } },
  transformSource(source) { assert.ok(source.includes(anchor)); return source.replace(anchor, 'globalThis.__qzoneRuntimeModule'); },
  globals: { __qzoneRuntimeModule: { async openQzoneConsoleRuntime(options) {
    runtime = await runtimeModule.openQzoneConsoleRuntime(options);
    return { ...runtime, handle: (request) => runtime.handle(structuredClone(request)) };
  } }, fetch: async (url) => {
    assert.equal(String(url), 'http://127.0.0.1:5700/get_login_info');
    return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 123456 } }) };
  } } });
  // ⚠️ 控制台现在读写的是**插件库**（bridge 传的 pluginStatePath）。
  // 这个 harness 原来只建 state/ 目录，插件库不存在 ⇒ /status 会如实返回 503
  // `plugin-state-unavailable`。那不是缺陷，是「插件还没跑过」的正确回答。
  // 但这条用例要验证的是**两条库都在**的真实管理链路，所以先按插件侧的首开状态
  // 把插件库建出来（字段与 plugins/qzone-safe/host-assembly 的 initialState 同形）。
  const pluginStatePath = join(harness.temp, 'state', 'qzone-plugin-state.sqlite');
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const pluginSeed = openOfflineStore(pluginStatePath, {
    enabled: false, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 3, comment: 25, like: 30 },
    ledger: { day: today, used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    intervalMinutes: 100, activeStart: 420, activeEnd: 1380, probe: 'done',
    reads: 0, writes: 0, lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [],
    readAttempts: {}, readOutcomes: {}, browseDay: today, todayBrowses: 0, lastBrowseAt: null,
    usedOpportunities: {}, audit: [], notices: [], writeAudit: [],
  });
  pluginSeed.close();
  const server = await harness.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); runtime?.close(); await harness.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = '/api/console/qqspace-column';
  const request = (path, { method = 'GET', body, cookie, includeToken = true, column = true, agent = false, tokenValue = token } = {}) => fetch(base + path, {
    method, headers: { ...(includeToken ? { 'x-console-token': tokenValue } : {}), ...(column ? { 'x-column-request': '1' } : {}), ...(agent ? { 'x-agent-call': '1' } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await request(`${endpoint}/auth/status`, { includeToken: false })).status, 401);
  assert.equal((await request(`${endpoint}/auth/status`, { column: false })).status, 403);
  const status = await request(`${endpoint}/auth/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).state, 'unset');
  const denied = await request(`${endpoint}/auth/setup`, { method: 'POST', body: { password: 'fixture-password-123' } });
  assert.equal(denied.status, 409);
  const pause = await request('/api/socialV2/activity', { method: 'POST', body: { paused: true } });
  assert.equal(pause.status, 200);
  const setup = await request(`${endpoint}/auth/setup`, { method: 'POST', body: { password: 'fixture-password-123' } });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie?.startsWith('qqspace_column_session='));
  const before = await (await request(`${endpoint}/audit`, { cookie })).json();
  for (const [path, method, body] of [
    ['/auth/status', 'GET'], ['/auth/setup', 'POST', { password: 'fixture-password-123' }],
    ['/auth/verify', 'POST', { password: 'fixture-password-123' }], ['/auth/forgot-reset', 'POST', {}],
    ['/status', 'GET'], ['/config', 'GET'], ['/audit', 'GET'], ['/pause/restore', 'POST', { layer: 'both' }],
  ]) {
    for (const invalid of [{ includeToken: false }, { tokenValue: 'wrong-token' }, { column: false }, { agent: true }]) {
      const response = await request(`${endpoint}${path}`, { method, body, cookie, ...invalid });
      assert.ok(response.status >= 400, `${path} must reject ${JSON.stringify(invalid)}`);
    }
  }
  assert.deepEqual(await (await request(`${endpoint}/audit`, { cookie })).json(), before);
  assert.equal((await request(`${endpoint}/status`)).status, 401);
  const space = await request(`${endpoint}/status`, { cookie });
  assert.equal(space.status, 200);
  const snapshot = await space.json();
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.dispatchAvailable, false);
  const config = await request(`${endpoint}/config`, { method: 'PATCH', cookie,
    body: { intervalMinutes: 105, activeStart: 510, activeEnd: 1385 } });
  assert.equal(config.status, 200);
  const refreshed = await (await request(`${endpoint}/config`, { cookie })).json();
  assert.equal(refreshed.intervalMinutes, 105);
  assert.equal(refreshed.activeStart, 510);
  assert.equal(refreshed.activeEnd, 1385);
  const audit = await request(`${endpoint}/audit`, { cookie });
  assert.equal(audit.status, 200);
  const auditRecords = (await audit.json()).records;
  // ⚠️ 数字从「>= 3」降到「>= 1」不是放宽，是**口径变了**：
  // /audit 现在读**插件库**（空间的操作证据都在那里）。专栏密码的设置/验证属于
  // 控制台自己的簿记，仍写控制台库，因此**不出现在这里** —— 它们不是空间操作。
  // 这条用例走过 PATCH /config，插件库里必然留下一条 configure 意图行。
  assert.ok(auditRecords.length >= 1, '/audit 必须返回插件库里的管理审计行');
  assert.ok(auditRecords.every((row) => row.kind === 'intent' || row.kind === 'settle'),
    '每条审计记录都必须带 kind，前端靠它分类型列');
  // /pause/restore 现在作用于**插件库**（那是真正生效的那份），所以先把插件库的
  // writePaused 置真、writes 计数置 3，才能验证「恢复会清掉写入暂停」。
  const store = openOfflineStore(pluginStatePath, {});
  try { store.update((state) => ({ ...state, writePaused: true, pauseCycles: { access: null, write: { id: '11111111-1111-4111-8111-111111111111', operationId: 'op-1', cause: 'network_unavailable' } }, writes: 3 })); } finally { store.close(); }
  const input = new EventEmitter();
  input.isTTY = true;
  input.setRawMode = () => {};
  input.pause = () => {};
  const secrets = [token, 'fixture-password-123'];
  input.resume = () => queueMicrotask(() => input.emit('data', Buffer.from(`${secrets.shift()}\n`)));
  let output = '';
  const result = await recover(['--url', base, '--layer', 'write', '--reason', 'network'], {
    input, promptOutput: { write() {} }, stdout: (text) => { output += text; }, stderr: (text) => { output += text; },
  });
  assert.equal(result, 0, output);
  const checked = openOfflineStore(pluginStatePath, {});
  try {
    assert.equal(checked.read().writePaused, false);
    assert.ok(checked.read().audit.some(({ record }) => record.action === 'restore' && record.source === 'admin_console'));
  } finally { checked.close(); }
});
