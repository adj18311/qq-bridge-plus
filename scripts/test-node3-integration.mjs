#!/usr/bin/env node
/**
 * scripts/test-node3-integration.mjs —— node3 两条新缝的真桥接隔离 HTTP 集成
 * ---------------------------------------------------------------------------
 * 覆盖：
 *   ① 鉴权先行：无/错控制台令牌 → 401，人格目录与角色回调零变化；带 x-agent-token
 *      的写请求仍走集中白名单 → 403（沿用旧守卫，不新增 403/不放松）
 *   ② 六条人格路由：列表 / 内容 / 创建 / 更新 / 重命名 / 删除的成对成功与
 *      400（校验失败）/404（不存在）路径；重命名与删除会跟随当前人格
 *   ③ 原位边界：/api/roles/limit 仍在桥接自己的分支里，改上限后两个 GET 立即反映；
 *      /api/role、/api/role-mode 未被新守卫截走；错误方法/未知路径照旧落到 404
 *   ④ 反馈与工具日志：GET/clear 仍要求控制台身份（agent token → 403 且不清空），
 *      清空后确实为空；全部只碰 harness 临时 state/
 *   ⑤ 两个工厂都只构造一次，且注入的是真实实现（工厂 spy 只计数并委托）
 *
 * 隔离方式：scripts/audit-bridge-harness.mjs 把**真实** src/bridge.js 跑在 %TEMP%
 * 临时仓库（config.json / state/ / roles/ 全在临时目录），再真的起 console server 发
 * HTTP 请求；不碰仓库里的 config.json、roles/ 或真实 QQ/DSH/SnowLuma。
 *
 * 用法：node scripts/test-node3-integration.mjs        （退出码 0 = 全绿）
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createRoleRoutes } from '../src/console/role-routes.mjs';
import { createRuntimeRecordStore } from '../src/core/runtime-records.mjs';

const TOKEN = 'node3-console-token-0123456789';
const AGENT = 'fixture-agent-token';
const ROLE_A = 'node3-alpha';
const ROLE_B = 'node3-beta';
const ROLE_C = 'node3-gamma';

/** 一次 HTTP 请求（token=null 表示不带控制台令牌；body=undefined 表示空体）。 */
function request(server, { method = 'GET', pathname = '/api/roles', body, token = TOKEN, headers = {} } = {}) {
  const { port } = server.address();
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(token === null ? {} : { 'x-console-token': token }),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function listen(server) {
  if (server.listening) return Promise.resolve(server);
  return new Promise((resolve) => server.once('listening', () => resolve(server)));
}

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed += 1;
    console.log(`✅ ${name}（${Date.now() - t0}ms）`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.error(`❌ ${name}（${Date.now() - t0}ms）\n   ${error?.stack ?? error?.message ?? error}`);
  }
}

console.log('== node3 人格路由 / 运行记录 集成（隔离临时仓库，不碰真实 config/state/roles）==\n');

// 工厂 spy：只计数并委托真实实现，证明入口用的是实际模块而不是别名或桩件。
const spy = { roleFactory: 0, recordFactory: 0, roleMatches: 0, roleHandle: 0 };
const h = await bridgeHarness({
  config: {
    consoleToken: TOKEN,
    consolePort: 0,
    role: { maxInjectChars: 2000 },
  },
  globals: {
    createRoleRoutes(deps) {
      spy.roleFactory += 1;
      const real = createRoleRoutes(deps);
      return {
        matches(method, pathname) { spy.roleMatches += 1; return real.matches(method, pathname); },
        handle(req, url, capabilities) { spy.roleHandle += 1; return real.handle(req, url, capabilities); },
      };
    },
    createRuntimeRecordStore(deps) {
      spy.recordFactory += 1;
      return createRuntimeRecordStore(deps);
    },
  },
});
const server = await listen(h.startConsoleServer());
const rolesDir = path.join(h.temp, 'roles');
const roleFiles = () => { try { return fs.readdirSync(rolesDir).sort(); } catch { return []; } };
const feedbackFile = path.join(h.temp, 'state/feedback.json');
const toolLogFile = path.join(h.temp, 'state/tool-calls.jsonl');
const agentHeaders = { 'x-agent-token': AGENT };

try {
  // ── ① 鉴权先行 + 构造期无副作用 ──────────────────────────────────────────
  await test('构造只发生一次：两个工厂各 1 次，且未调用任何角色回调', () => {
    assert.equal(spy.roleFactory, 1, 'createRoleRoutes 应恰好构造一次');
    assert.equal(spy.recordFactory, 1, 'createRuntimeRecordStore 应恰好构造一次');
    assert.equal(spy.roleHandle, 0, '构造期不应调用 handle');
    assert.deepEqual(roleFiles(), [], '构造期不应触碰人格目录');
  });

  await test('无令牌 / 错令牌 → 401，且无人格文件或回调变化', async () => {
    const beforeFiles = roleFiles();
    const beforeHandle = spy.roleHandle;
    const beforeMatches = spy.roleMatches;
    const missing = await request(server, { token: null, pathname: '/api/roles' });
    assert.equal(missing.status, 401, missing.text);
    assert.match(String(missing.json?.error ?? ''), /未授权/);
    const wrong = await request(server, { method: 'POST', pathname: '/api/roles/create', token: 'wrong-token-wrong-token', body: { name: ROLE_A, content: 'x' } });
    assert.equal(wrong.status, 401, wrong.text);
    assert.deepEqual(roleFiles(), beforeFiles, '401 不应创建/改动人格文件');
    assert.equal(spy.roleHandle, beforeHandle, '401 不应进入角色路由 handler');
    assert.equal(spy.roleMatches, beforeMatches, '鉴权应在同步 matches 之前结束');
  });

  await test('带 agent token 的人格写请求仍是 403（沿用集中白名单）', async () => {
    const beforeFiles = roleFiles();
    const r = await request(server, { method: 'POST', pathname: '/api/roles/create', headers: agentHeaders, body: { name: ROLE_A, content: 'x' } });
    assert.equal(r.status, 403, r.text);
    assert.match(String(r.json?.error ?? ''), /仅控制台可用/);
    assert.deepEqual(roleFiles(), beforeFiles);
    assert.equal(spy.roleHandle, 0, '403 发生在守卫之前，不应进入 handler');
  });

  // ── ② 六条人格路由 ───────────────────────────────────────────────────────
  await test('GET /api/roles 初始为空，limits 来自运行期注入上限', async () => {
    const r = await request(server, { pathname: '/api/roles' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.roles, []);
    assert.deepEqual(r.json.summaries, []);
    assert.equal(r.json.current, null);
    assert.deepEqual(r.json.limits, { nameMax: 40, contentMaxBytes: 65536, injectMaxChars: 2000 });
  });

  await test('POST /api/roles/create：校验失败 400，成功落盘，重复 400', async () => {
    const badName = await request(server, { method: 'POST', pathname: '/api/roles/create', body: { name: '', content: 'x' } });
    assert.equal(badName.status, 400, badName.text);
    assert.match(String(badName.json?.error ?? ''), /人格名不能为空/);
    const badContent = await request(server, { method: 'POST', pathname: '/api/roles/create', body: { name: ROLE_A, content: '' } });
    assert.equal(badContent.status, 400, badContent.text);
    assert.match(String(badContent.json?.error ?? ''), /人格内容不能为空/);
    const ok = await request(server, { method: 'POST', pathname: '/api/roles/create', body: { name: ROLE_A, content: `# ${ROLE_A}\n人格测试内容` } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.role, ROLE_A);
    assert.ok(Array.isArray(ok.json.warnings));
    assert.ok(roleFiles().includes(`${ROLE_A}.md`), '人格文件应写入临时 roles/');
    const dup = await request(server, { method: 'POST', pathname: '/api/roles/create', body: { name: ROLE_A, content: 'y' } });
    assert.equal(dup.status, 400, dup.text);
    assert.match(String(dup.json?.error ?? ''), /已存在/);
  });

  await test('GET /api/roles/content：成功带统计/分区，未知 404，空名 400', async () => {
    const ok = await request(server, { pathname: `/api/roles/content?name=${ROLE_A}` });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.name, ROLE_A);
    assert.match(ok.json.content, /人格测试内容/);
    assert.equal(ok.json.chars, ok.json.content.length);
    assert.equal(ok.json.bytes, Buffer.byteLength(ok.json.content, 'utf8'));
    assert.equal(ok.json.limits.injectMaxChars, 2000);
    assert.ok(ok.json.stats && ok.json.sections?.v1 && ok.json.sections?.v2);
    const missing = await request(server, { pathname: '/api/roles/content?name=node3-missing' });
    assert.equal(missing.status, 404, missing.text);
    assert.match(String(missing.json?.error ?? ''), /不存在/);
    const empty = await request(server, { pathname: '/api/roles/content?name=' });
    assert.equal(empty.status, 400, empty.text);
  });

  await test('POST /api/roles/update：成功/未知 404/校验 400', async () => {
    const ok = await request(server, { method: 'POST', pathname: '/api/roles/update', body: { name: ROLE_A, content: `# ${ROLE_A} v2` } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.role, ROLE_A);
    assert.equal(ok.json.chars, `# ${ROLE_A} v2`.length, 'chars 应为更新后内容长度');
    const missing = await request(server, { method: 'POST', pathname: '/api/roles/update', body: { name: 'node3-missing', content: 'x' } });
    assert.equal(missing.status, 404, missing.text);
    const bad = await request(server, { method: 'POST', pathname: '/api/roles/update', body: { name: ROLE_A, content: '' } });
    assert.equal(bad.status, 400, bad.text);
  });

  await test('POST /api/role（排除路由）仍可设置当前人格', async () => {
    const r = await request(server, { method: 'POST', pathname: '/api/role', body: { role: ROLE_A } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.role, ROLE_A);
    const unknown = await request(server, { method: 'POST', pathname: '/api/role', body: { role: 'node3-missing' } });
    assert.equal(unknown.status, 400, unknown.text);
  });

  await test('POST /api/roles/rename：重命名跟随当前人格；同/未知/重名分支', async () => {
    const followed = await request(server, { method: 'POST', pathname: '/api/roles/rename', body: { from: ROLE_A, to: ROLE_B } });
    assert.equal(followed.status, 200, followed.text);
    assert.deepEqual({ role: followed.json.role, renamed: followed.json.renamed, currentFollowed: followed.json.currentFollowed }, { role: ROLE_B, renamed: true, currentFollowed: true });
    const listed = await request(server, { pathname: '/api/roles' });
    assert.equal(listed.json.current, ROLE_B, '当前人格应跟随重命名');
    assert.ok(roleFiles().includes(`${ROLE_B}.md`) && !roleFiles().includes(`${ROLE_A}.md`));
    const same = await request(server, { method: 'POST', pathname: '/api/roles/rename', body: { from: ROLE_B, to: ROLE_B } });
    assert.equal(same.status, 200, same.text);
    assert.equal(same.json.renamed, false);
    const missing = await request(server, { method: 'POST', pathname: '/api/roles/rename', body: { from: 'node3-missing', to: ROLE_C } });
    assert.equal(missing.status, 404, missing.text);
    const second = await request(server, { method: 'POST', pathname: '/api/roles/create', body: { name: ROLE_C, content: '# gamma' } });
    assert.equal(second.status, 200, second.text);
    const clash = await request(server, { method: 'POST', pathname: '/api/roles/rename', body: { from: ROLE_B, to: ROLE_C } });
    assert.equal(clash.status, 400, clash.text);
    assert.match(String(clash.json?.error ?? ''), /已存在/);
  });

  // ── ③ 原位边界：/roles/limit、/role-mode、错误方法/未知路径 ──────────────
  await test('POST /api/roles/limit 仍走原分支：改上限后两个 GET 立即反映', async () => {
    const set = await request(server, { method: 'POST', pathname: '/api/roles/limit', body: { maxInjectChars: 1500 } });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.json.maxInjectChars, 1500);
    assert.deepEqual(set.json.limits, { injectMaxChars: 1500 });
    const listed = await request(server, { pathname: '/api/roles' });
    assert.equal(listed.json.limits.injectMaxChars, 1500);
    const content = await request(server, { pathname: `/api/roles/content?name=${ROLE_B}` });
    assert.equal(content.json.limits.injectMaxChars, 1500);
    const onDisk = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
    assert.equal(onDisk.role.maxInjectChars, 1500, '上限应落到临时 config.json');
    const getLimit = await request(server, { pathname: '/api/roles/limit' });
    assert.equal(getLimit.status, 404, 'GET /api/roles/limit 不在六条路由里，照旧回落 404');
  });

  await test('POST /api/role-mode（排除路由）行为不变', async () => {
    const r = await request(server, { method: 'POST', pathname: '/api/role-mode', body: { mode: 'silent' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.roleMode, 'silent');
  });

  await test('错误方法 / 未知路径：同步 matches 为假 → 回落 404 且不进入 handler', async () => {
    const beforeHandle = spy.roleHandle;
    for (const attempt of [
      { method: 'POST', pathname: '/api/roles', body: {} },
      { method: 'PUT', pathname: '/api/roles/create', body: { name: ROLE_C, content: 'x' } },
      { method: 'GET', pathname: '/api/roles/create' },
      { method: 'GET', pathname: '/api/roles/nope' },
    ]) {
      const r = await request(server, attempt);
      assert.equal(r.status, 404, `${attempt.method} ${attempt.pathname} → ${r.status} ${r.text}`);
    }
    assert.equal(spy.roleHandle, beforeHandle, '未命中的路由不应调用 handler');
    assert.ok(roleFiles().includes(`${ROLE_C}.md`), 'PUT 不应改动人格文件');
  });

  await test('POST /api/roles/delete：删除非当前 400/404 分支与当前人格清除', async () => {
    const invalid = await request(server, { method: 'POST', pathname: '/api/roles/delete', body: { name: '' } });
    assert.equal(invalid.status, 400, invalid.text);
    const missing = await request(server, { method: 'POST', pathname: '/api/roles/delete', body: { name: 'node3-missing' } });
    assert.equal(missing.status, 404, missing.text);
    const other = await request(server, { method: 'POST', pathname: '/api/roles/delete', body: { name: ROLE_C } });
    assert.equal(other.status, 200, other.text);
    assert.deepEqual({ deleted: other.json.deleted, clearedCurrent: other.json.clearedCurrent }, { deleted: ROLE_C, clearedCurrent: false });
    assert.ok(!roleFiles().includes(`${ROLE_C}.md`));
    const current = await request(server, { method: 'POST', pathname: '/api/roles/delete', body: { name: ROLE_B } });
    assert.equal(current.status, 200, current.text);
    assert.equal(current.json.clearedCurrent, true, '删除当前人格应同时清除当前人格');
    const listed = await request(server, { pathname: '/api/roles' });
    assert.equal(listed.json.current, null);
    assert.deepEqual(listed.json.roles, []);
  });

  // ── ④ 反馈 / 工具日志：GET/clear 仍要求控制台身份 ───────────────────────
  await test('反馈：追加后 GET 可见；agent token 的 GET/clear 403 且不清空', async () => {
    const appended = await request(server, { method: 'POST', pathname: '/api/socialV2/feedback', body: { key: 'private:123', message: 'node3 fixture feedback' } });
    assert.equal(appended.status, 200, appended.text);
    const listed = await request(server, { pathname: '/api/socialV2/feedback' });
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.json.entries.length, 1);
    assert.equal(listed.json.entries[0].message, 'node3 fixture feedback');
    const deniedGet = await request(server, { pathname: '/api/socialV2/feedback', headers: agentHeaders });
    assert.equal(deniedGet.status, 403, deniedGet.text);
    const deniedClear = await request(server, { method: 'POST', pathname: '/api/socialV2/feedback-clear', body: {}, headers: agentHeaders });
    assert.equal(deniedClear.status, 403, deniedClear.text);
    assert.equal(JSON.parse(fs.readFileSync(feedbackFile, 'utf8')).length, 1, '403 不应清空反馈');
    const cleared = await request(server, { method: 'POST', pathname: '/api/socialV2/feedback-clear', body: {} });
    assert.equal(cleared.status, 200, cleared.text);
    const after = await request(server, { pathname: '/api/socialV2/feedback' });
    assert.deepEqual(after.json.entries, []);
  });

  await test('工具日志：追加后 GET 可见；agent token 403 且不清空；clear 后为空', async () => {
    h.appendToolLog({ tool: 'node3_fixture', args: '{"a":1}' });
    const listed = await request(server, { pathname: '/api/socialV2/tool-log?limit=10' });
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.json.entries.length, 1);
    assert.equal(listed.json.entries[0].tool, 'node3_fixture');
    const deniedGet = await request(server, { pathname: '/api/socialV2/tool-log', headers: agentHeaders });
    assert.equal(deniedGet.status, 403, deniedGet.text);
    const deniedClear = await request(server, { method: 'POST', pathname: '/api/socialV2/tool-log/clear', body: {}, headers: agentHeaders });
    assert.equal(deniedClear.status, 403, deniedClear.text);
    assert.ok(fs.statSync(toolLogFile).size > 0, '403 不应截断工具日志');
    const cleared = await request(server, { method: 'POST', pathname: '/api/socialV2/tool-log/clear', body: {} });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(fs.statSync(toolLogFile).size, 0, '控制台 clear 应截断工具日志');
    const after = await request(server, { pathname: '/api/socialV2/tool-log?limit=10' });
    assert.deepEqual(after.json.entries, []);
  });

  // ── ⑤ 工厂接线证据 ───────────────────────────────────────────────────────
  await test('两个工厂始终只构造一次，且角色 handler 确实被真实模块消费', () => {
    assert.equal(spy.roleFactory, 1);
    assert.equal(spy.recordFactory, 1);
    assert.ok(spy.roleHandle > 0, '人格路由应经过注入的真实实现');
  });
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await h.close();
}

console.log(`\n== 结果：${passed} passed / ${failed} failed ==`);
if (failed) {
  for (const { name, error } of failures) console.error(`\n❌ ${name}\n${error?.stack ?? error}`);
  process.exitCode = 1;
}
