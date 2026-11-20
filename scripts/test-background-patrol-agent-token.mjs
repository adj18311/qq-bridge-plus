// scripts/test-background-patrol-agent-token.mjs
// 后台巡逻受限令牌（方案 2，用户 m33778）：纯模块单测。
//
// 覆盖三件事（用户明确要求「先离线测轮换/失效/误用」）：
//   1. 轮换：rotate 后旧令牌**立即**失效、generation 递增、新令牌可用；
//   2. 失效：无状态/损坏状态/被撤销/持久化失败 → 一律 fail-closed（不产生可用令牌）；
//   3. 误用：作用域白名单之外的任何方法/路径都 deny。
//
// 零副作用：只 import 纯模块，文件系统全部注入内存实现；不写 state、不联网、不启动桥接。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBackgroundAgentTokenStore,
  parseBackgroundAgentTokenState,
  backgroundTokenAllowsRequest,
  BACKGROUND_AGENT_TOKEN_SCOPE,
  BACKGROUND_AGENT_TOKEN_VERSION,
  BACKGROUND_TIEBA_READ_PATHS,
} from '../src/core/background-patrol-agent-token.mjs';

const TOKEN_A = 'a'.repeat(48);
const TOKEN_B = 'b'.repeat(48);

/** 内存文件系统：可控制读失败、写失败。 */
function makeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const fs = {
    files,
    failRead: null,
    failWrite: false,
    writes: 0,
    async readFile(p) {
      if (fs.failRead) throw Object.assign(new Error('boom'), { code: fs.failRead });
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(p);
    },
    async writeFile(p, text) {
      if (fs.failWrite) throw new Error('write-failed');
      fs.writes += 1;
      files.set(p, text);
    },
    async rename(from, to) {
      if (!files.has(from)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      files.set(to, files.get(from));
      files.delete(from);
    },
    async mkdir() {},
  };
  return fs;
}

function makeStore({ fs, clock = () => 1_000, tokens = [TOKEN_A, TOKEN_B] } = {}) {
  let i = 0;
  return createBackgroundAgentTokenStore({
    filePath: 'C:/fake/agent-token.json',
    fs: fs ?? makeFs(),
    clock,
    makeToken: () => tokens[Math.min(i++, tokens.length - 1)],
  });
}

// ── 1. 创建与复用 ────────────────────────────────────────────────────────────
test('task-160 首次 ensure 创建令牌并落盘（generation=1、scope=tieba-read）', async () => {
  const fs = makeFs();
  const store = makeStore({ fs });
  const r = await store.ensure();
  assert.equal(r.ok, true);
  assert.equal(r.token, TOKEN_A);
  assert.equal(r.scope, BACKGROUND_AGENT_TOKEN_SCOPE);
  assert.equal(r.generation, 1);
  assert.equal(r.created, true);
  assert.equal(fs.writes, 1, '未落盘则不算创建成功');
  const disk = JSON.parse(fs.files.get('C:/fake/agent-token.json'));
  assert.equal(disk.token, TOKEN_A);
  assert.equal(disk.rotatedAt, null);
});

test('task-160 已有状态时 ensure 复用同一令牌（created=false，不再写盘）', async () => {
  const fs = makeFs();
  const store = makeStore({ fs });
  await store.ensure();
  const writesAfterFirst = fs.writes;
  const again = await store.ensure();
  assert.equal(again.ok, true);
  assert.equal(again.token, TOKEN_A);
  assert.equal(again.created, false);
  assert.equal(fs.writes, writesAfterFirst, '复用不得改写状态文件');
});

test('task-160 已落盘的令牌可被新实例读回（重启不失效）', async () => {
  const fs = makeFs();
  await makeStore({ fs }).ensure();
  const restored = makeStore({ fs, tokens: [TOKEN_B] });
  const r = await restored.ensure();
  assert.equal(r.token, TOKEN_A, '必须复用磁盘上的令牌，而不是重新生成');
  assert.equal(r.created, false);
});

// ── 2. 轮换：旧令牌立即失效 ──────────────────────────────────────────────────
test('task-160 rotate 后旧令牌立即失效、新令牌可用、generation 递增', async () => {
  const fs = makeFs();
  const store = makeStore({ fs });
  await store.ensure();
  assert.equal(store.verify(TOKEN_A).ok, true);
  const rotated = await store.rotate();
  assert.equal(rotated.ok, true);
  assert.equal(rotated.token, TOKEN_B);
  assert.equal(rotated.generation, 2);
  assert.equal(store.verify(TOKEN_A).ok, false, '轮换后旧令牌必须立即失效（无宽限期）');
  assert.equal(store.verify(TOKEN_A).reason, 'unknown-token');
  assert.equal(store.verify(TOKEN_B).ok, true);
  const disk = JSON.parse(fs.files.get('C:/fake/agent-token.json'));
  assert.equal(disk.token, TOKEN_B);
  assert.equal(disk.generation, 2);
});

test('task-160 rotate 落盘失败时回滚内存态（旧令牌仍然有效，不出现"只在内存里"的令牌）', async () => {
  const fs = makeFs();
  const store = makeStore({ fs });
  await store.ensure();
  fs.failWrite = true;
  const rotated = await store.rotate();
  assert.equal(rotated.ok, false);
  assert.equal(rotated.reason, 'persist-failed');
  assert.equal(store.verify(TOKEN_A).ok, true, '落盘失败不得改变生效令牌');
  assert.equal(store.verify(TOKEN_B).ok, false);
});

test('task-160 ensure 落盘失败时不产生可用令牌（fail-closed）', async () => {
  const fs = makeFs();
  fs.failWrite = true;
  const store = makeStore({ fs });
  const r = await store.ensure();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'persist-failed');
  assert.equal(store.verify(TOKEN_A).ok, false);
  assert.equal(store.snapshot().present, false);
});

// ── 3. 失效：损坏/读失败/撤销 ───────────────────────────────────────────────
test('task-160 状态文件损坏 → ensure 返回 state-corrupt，不覆盖原文件', async () => {
  const fs = makeFs({ 'C:/fake/agent-token.json': '{not json' });
  const store = makeStore({ fs });
  const r = await store.ensure();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'state-corrupt');
  assert.equal(fs.writes, 0, '损坏状态绝不被覆盖（要留给人工排查）');
  assert.equal(fs.files.get('C:/fake/agent-token.json'), '{not json');
  assert.equal(store.verify(TOKEN_A).ok, false);
});

test('task-160 状态字段非法（版本/作用域/令牌格式）→ state-invalid', async () => {
  const bad = [
    { ...baseState(), schemaVersion: 99 },
    { ...baseState(), scope: 'qq-send' },
    { ...baseState(), token: 'short' },
    { ...baseState(), generation: 0 },
    { ...baseState(), extra: 1 },
  ];
  for (const state of bad) {
    const fs = makeFs({ 'C:/fake/agent-token.json': JSON.stringify(state) });
    const r = await makeStore({ fs }).ensure();
    assert.equal(r.ok, false, `应拒绝：${JSON.stringify(state)}`);
    assert.equal(r.reason, 'state-invalid');
    assert.equal(fs.writes, 0);
  }
});

test('task-160 读失败 → read-failed（fail-closed，不退化成"没状态"）', async () => {
  const fs = makeFs();
  fs.failRead = 'EACCES';
  const r = await makeStore({ fs }).ensure();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'read-failed');
});

test('task-160 revoke 后 verify 一律失败', async () => {
  const fs = makeFs();
  const store = makeStore({ fs });
  await store.ensure();
  assert.equal(store.verify(TOKEN_A).ok, true);
  const r = await store.revoke();
  assert.equal(r.ok, true);
  assert.equal(store.verify(TOKEN_A).ok, false);
  assert.equal(store.snapshot().present, false);
});

test('task-160 verify 拒绝空/非字符串/长度不同的令牌', async () => {
  const fs = makeFs();
  const store = makeStore({ fs });
  await store.ensure();
  for (const value of ['', null, undefined, 123, TOKEN_A.slice(0, 47), `${TOKEN_A}a`]) {
    assert.equal(store.verify(value).ok, false, `应拒绝 ${String(value)}`);
  }
});

// ── 4. 误用：作用域白名单 ───────────────────────────────────────────────────
test('task-160 作用域只放行两个贴吧只读端点的 GET', async () => {
  for (const pathname of BACKGROUND_TIEBA_READ_PATHS) {
    assert.equal(backgroundTokenAllowsRequest(BACKGROUND_AGENT_TOKEN_SCOPE, { method: 'GET', pathname }), true);
    assert.equal(backgroundTokenAllowsRequest(BACKGROUND_AGENT_TOKEN_SCOPE, { method: 'POST', pathname }), false);
  }
});

test('task-160 作用域拒绝所有非贴吧只读端点（QQ 发送/管理/小黑盒写）', async () => {
  const forbidden = [
    '/api/socialV2/send',
    '/api/socialV2/send-image',
    '/api/send/voice',
    '/api/socialV2/state',
    '/api/xiaoheihe/authorize',
    '/api/console/xiaoheihe-column/settings',
    '/api/restart',
    '/api/socialV2/tieba/bar/extra',
    '/api/socialV2/tieba',
    '/',
  ];
  for (const pathname of forbidden) {
    assert.equal(
      backgroundTokenAllowsRequest(BACKGROUND_AGENT_TOKEN_SCOPE, { method: 'GET', pathname }),
      false,
      `不得放行 ${pathname}`,
    );
  }
});

test('task-160 未知作用域/非法请求对象一律 deny（fail-closed）', async () => {
  const path = BACKGROUND_TIEBA_READ_PATHS[0];
  assert.equal(backgroundTokenAllowsRequest('qq-send', { method: 'GET', pathname: path }), false);
  assert.equal(backgroundTokenAllowsRequest('', { method: 'GET', pathname: path }), false);
  assert.equal(backgroundTokenAllowsRequest(undefined, { method: 'GET', pathname: path }), false);
  assert.equal(backgroundTokenAllowsRequest(BACKGROUND_AGENT_TOKEN_SCOPE, null), false);
  assert.equal(backgroundTokenAllowsRequest(BACKGROUND_AGENT_TOKEN_SCOPE, {}), false);
  assert.equal(backgroundTokenAllowsRequest(BACKGROUND_AGENT_TOKEN_SCOPE, { method: 'get', pathname: `${path}/` }), false);
});

// ── 5. 严格解析与脱敏视图 ───────────────────────────────────────────────────
test('task-160 parse 接受合法状态、拒绝 null 之外的畸形输入', async () => {
  assert.equal(parseBackgroundAgentTokenState(null), null);
  assert.equal(parseBackgroundAgentTokenState(undefined), null);
  const parsed = parseBackgroundAgentTokenState(baseState());
  assert.equal(parsed.token, TOKEN_A);
  for (const value of [[], 'x', 1, true]) {
    assert.throws(() => parseBackgroundAgentTokenState(value), /后台令牌状态不可用/u);
  }
});

test('task-160 snapshot 不含令牌明文', async () => {
  const fs = makeFs();
  const store = makeStore({ fs });
  await store.ensure();
  const snap = store.snapshot();
  assert.equal(snap.present, true);
  assert.equal(snap.generation, 1);
  assert.equal(JSON.stringify(snap).includes(TOKEN_A), false, '快照不得泄露令牌');
});

function baseState() {
  return {
    schemaVersion: BACKGROUND_AGENT_TOKEN_VERSION,
    scope: BACKGROUND_AGENT_TOKEN_SCOPE,
    token: TOKEN_A,
    generation: 1,
    createdAt: 1_000,
    rotatedAt: null,
  };
}
