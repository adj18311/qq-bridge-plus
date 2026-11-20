// m33778 方案 2 接线测试：后台巡逻**受限令牌**只能用于贴吧两个只读端点。
//
// 背景（真实事故）：2026-10-29 贴吧巡逻连续三次 `未授权：智能体调用必须携带有效的会话令牌`。
// 根因是 patrolTokenLine 取 `getSocialV2State('patrol:background')` 必抛（canonicalV2Key 只认
// group:/private:），catch 吞成空串 ⇒ 那一行是空操作；而 isLiveAgentToken 只遍历 QQ 会话。
//
// 方案 2 的验收要求（用户 m33778）不是「让令牌能过 /api/status 就完事」，而是：
//   - 只能用于允许的贴吧只读端点（不能发 QQ、不能碰控制台/小黑盒写）；
//   - 轮换、失效、误用都要有用例。
// 所以这里全部走**真实桥接 + 真实 HTTP**，不用假的 backgroundBoundedTokenOk。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { BACKGROUND_AGENT_TOKEN_SCOPE } from '../src/core/background-patrol-agent-token.mjs';

const CONSOLE_TOKEN = 'fixture-console-token';
const PATROL_KEY = 'patrol:background';
const BAR_PATH = '/api/socialV2/tieba/bar';
const THREAD_PATH = '/api/socialV2/tieba/thread';

// 后台运行时的五件 fake（与 test-tieba-patrol.mjs 同构）：不真建 DSH 会话、不真排期。
/**
 * 固定巡逻时钟（北京时间 12:00）。
 * 不加这一行，测试会随真实时钟变红：贴吧 gate 在 23:00–07:00 会回 PATROL_QUIET_HOURS，
 * 断言 200 必然失败（2026-10-30 23:1x 实测抓到）。
 */
const PATROL_NOON_MS = new Date('2026-10-30T12:00:00+08:00').getTime();

function fakeE1Globals(overrides = {}) {
  return {
    createBackgroundPatrolBridgeHook: () => ({
      async start() { return { ok: true, enabled: true, url: 'http://127.0.0.1:1', port: 1 }; },
      async stop() { return { stopped: true }; },
      status() { return { started: true, identityMode: 'mapper' }; },
    }),
    createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    createBackgroundPatrolSessionLifecycle: () => ({
      async ensureSession() { return { ok: true, sessionId: 'sid-patrol' }; },
      async close() { return { ok: true }; },
      async status() { return { phase: 'ready' }; },
    }),
    createBackgroundPatrolScheduleStore: () => ({
      async load() {},
      async advanceGeneration() { return { ok: true, generation: 1 }; },
      async snapshot() { return { generation: 1, platforms: { tieba: { nextAt: null }, xiaoheihe: { nextAt: null } } }; },
      async markOpportunity() { return { ok: true }; },
      async planNext() { return { ok: true }; },
      async close() {},
    }),
    createBackgroundPatrolScheduler: () => ({ start() {}, stop() {}, snapshot() { return { started: true }; } }),
    backgroundPatrolNow: () => PATROL_NOON_MS,
    fetchBarPage: async () => ({
      ok: true, url: 'https://tieba.invalid/bar', data: { bar: 'b', blocked: false, threads: [] }, text: 'fixture-bar',
    }),
    fetchThreadPage: async (tid) => ({
      ok: true, url: `https://tieba.invalid/p/${tid}`, data: { tid, posts: [] }, text: 'fixture-thread',
    }),
    ...overrides,
  };
}

function request(port, { method = 'GET', pathname, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request hung')));
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

/** agent 调用：同时带控制台令牌（MCP 进程两者都持有）与 x-agent-call 声明。 */
async function agentRequest(port, { token, pathname, method = 'GET', body }) {
  return request(port, {
    method,
    pathname,
    body,
    headers: {
      'x-console-token': CONSOLE_TOKEN,
      'x-agent-call': '1',
      ...(token === undefined ? {} : { 'x-agent-token': token }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  });
}

async function boot({ patrolEnabled = true, globals = fakeE1Globals(), savedState } = {}) {
  const h = await bridgeHarness({
    config: {
      backgroundPatrol: { enabled: patrolEnabled, platforms: { tieba: true, xiaoheihe: false } },
      socialV2: { enabled: true, tools: { tiebaList: true, tiebaRead: true } },
    },
    globals,
    savedState: savedState ?? { mode: 'reserved2', sessions: { [PATROL_KEY]: 'sid-patrol' } },
  });
  h.setMode('reserved2');
  h.setReady(true);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  return {
    h,
    port,
    store: () => h.getBackgroundAgentTokenStore(),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await h.close();
    },
  };
}

const barQuery = (key = PATROL_KEY) => new URLSearchParams({ key, bar: '示例吧', reason: 'patrol' }).toString();
const threadQuery = (key = PATROL_KEY) => new URLSearchParams({ key, tid: '11000000002', reason: 'patrol' }).toString();

// ── ① 缺令牌 / 空令牌：集中关卡直接 403 ──────────────────────────────────
test('① 后台回合不带令牌（x-agent-call + 空 token）⇒ 403 未授权', async () => {
  const ctx = await boot();
  try {
    const missing = await agentRequest(ctx.port, { token: undefined, pathname: `${BAR_PATH}?${barQuery()}` });
    assert.equal(missing.status, 403);
    assert.match(String(missing.body?.error), /智能体调用必须携带有效的会话令牌/);

    const empty = await agentRequest(ctx.port, { token: '', pathname: `${BAR_PATH}?${barQuery()}` });
    assert.equal(empty.status, 403);
    assert.match(String(empty.body?.error), /智能体调用必须携带有效的会话令牌/);
  } finally {
    await ctx.close();
  }
});

// ── ② 正常路径：受限令牌读贴吧两个只读端点 ────────────────────────────────
test('② 受限令牌可读贴吧 bar 与 thread（两端点都 200）', async () => {
  const ctx = await boot();
  try {
    const store = ctx.store();
    assert.ok(store, '后台运行时启动后必须已创建受限令牌 store');
    const ensured = await store.ensure();
    assert.equal(ensured.ok, true);
    assert.equal(ensured.scope, BACKGROUND_AGENT_TOKEN_SCOPE);
    const bar = await agentRequest(ctx.port, { token: ensured.token, pathname: `${BAR_PATH}?${barQuery()}` });
    assert.equal(bar.status, 200, JSON.stringify(bar.body));
    assert.equal(bar.body?.ok, true);
    assert.equal(bar.body?.key, PATROL_KEY);
    assert.equal(bar.body?.patrol?.reason, 'patrol');
    const thread = await agentRequest(ctx.port, { token: ensured.token, pathname: `${THREAD_PATH}?${threadQuery()}` });
    assert.equal(thread.status, 200, JSON.stringify(thread.body));
    assert.equal(thread.body?.ok, true);
  } finally {
    await ctx.close();
  }
});

// ── ③ 误用：受限令牌不是万能钥匙 ──────────────────────────────────────────
test('③ 受限令牌不能发 QQ、不能调其它端点', async () => {
  const ctx = await boot();
  try {
    const { token } = await ctx.store().ensure();

    // QQ 发送端点：这是「令牌泄漏也不会造成实际危害」的核心断言。
    const send = await agentRequest(ctx.port, {
      token,
      method: 'POST',
      pathname: '/api/send/private',
      body: { token, userId: '123', message: 'background-token-must-not-send' },
    });
    assert.equal(send.status, 403, JSON.stringify(send.body));
    assert.match(String(send.body?.error), /未授权/);
    assert.equal(ctx.h.calls.sent.length, 0, '受限令牌不得产生任何 QQ 发送');

    // /api/status 在 agentAllowed 白名单里，但不在贴吧只读白名单里 ⇒ 必须拒。
    const status = await agentRequest(ctx.port, { token, pathname: '/api/status' });
    assert.equal(status.status, 403, JSON.stringify(status.body));

    // 小黑盒授权端点同理（后台令牌与小黑盒凭据互不相通）。
    const authorize = await agentRequest(ctx.port, {
      token,
      method: 'POST',
      pathname: '/api/xiaoheihe/authorize',
      body: { token, agentKey: PATROL_KEY, tool: 'post_comment' },
    });
    assert.equal(authorize.status, 403, JSON.stringify(authorize.body));
  } finally {
    await ctx.close();
  }
});

// ── ④ 误用：令牌合法但 key 不是后台会话 ──────────────────────────────────
test('④ 受限令牌 + key=group:456 ⇒ 贴吧端点 403 agent token 无效', async () => {
  const ctx = await boot();
  try {
    const { token } = await ctx.store().ensure();
    const res = await agentRequest(ctx.port, { token, pathname: `${BAR_PATH}?${barQuery('group:456')}` });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(String(res.body?.error), /agent token 无效/);
  } finally {
    await ctx.close();
  }
});

// ── ⑤ 写入类端点就算路径相似也不行（方法维度）────────────────────────────
test('⑤ 受限令牌对贴吧端点只放行 GET（POST 到同名路径被集中关卡拒绝）', async () => {
  const ctx = await boot();
  try {
    const { token } = await ctx.store().ensure();
    const res = await agentRequest(ctx.port, {
      token,
      method: 'POST',
      pathname: `${BAR_PATH}?${barQuery()}`,
      body: { key: PATROL_KEY },
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(String(res.body?.error), /未授权/);
  } finally {
    await ctx.close();
  }
});

// ── ⑥ 轮换：旧令牌立即失效、新令牌可用 ──────────────────────────────────
test('⑥ 轮换后旧令牌立即 403，新令牌可继续读取', async () => {
  const ctx = await boot();
  try {
    const store = ctx.store();
    const before = await store.ensure();
    const rotated = await store.rotate();
    assert.equal(rotated.ok, true);
    assert.notEqual(rotated.token, before.token);
    assert.ok(rotated.generation > before.generation);

    const stale = await agentRequest(ctx.port, { token: before.token, pathname: `${BAR_PATH}?${barQuery()}` });
    assert.equal(stale.status, 403, '轮换后旧令牌必须立刻失效');
    assert.match(String(stale.body?.error), /智能体调用必须携带有效的会话令牌/);

    const fresh = await agentRequest(ctx.port, { token: rotated.token, pathname: `${BAR_PATH}?${barQuery()}` });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  } finally {
    await ctx.close();
  }
});

// ── ⑦ 吊销：fail-closed ─────────────────────────────────────────────────
test('⑦ 吊销后原令牌 403（store 进入 broken，不再签发）', async () => {
  const ctx = await boot();
  try {
    const store = ctx.store();
    const { token } = await store.ensure();
    const revoked = await store.revoke();
    assert.equal(revoked.ok, true);

    const res = await agentRequest(ctx.port, { token, pathname: `${BAR_PATH}?${barQuery()}` });
    assert.equal(res.status, 403, JSON.stringify(res.body));

    const again = await store.ensure();
    assert.equal(again.ok, false, '吊销后 ensure 必须 fail-closed，不得悄悄重发令牌');
  } finally {
    await ctx.close();
  }
});

// ── ⑧ 损坏状态文件：不覆盖、不放行 ──────────────────────────────────────
test('⑧ 状态文件损坏时 store fail-closed（HTTP 403 且现场不被覆盖）', async () => {
  const ctx = await boot();
  const tokenFilePath = path.join(ctx.h.temp, 'state', 'background-patrol-agent-token.json');
  try {
    const { token } = await ctx.store().ensure();
    // 模拟「磁盘被外部改坏」：重启 store 走 load 分支。
    const corrupt = '{"schemaVersion":1,"scope":"tieba-read","token":12345';
    fs.writeFileSync(tokenFilePath, corrupt);
    const store = ctx.store();
    await store.load();
    const ensured = await store.ensure();
    assert.equal(ensured.ok, false);
    assert.ok(['state-corrupt', 'state-invalid'].includes(ensured.reason), String(ensured.reason));
    assert.equal(fs.readFileSync(tokenFilePath, 'utf8'), corrupt, '损坏现场不得被静默覆盖');
    const res = await agentRequest(ctx.port, { token, pathname: `${BAR_PATH}?${barQuery()}` });
    assert.equal(res.status, 403, 'store 损坏后旧令牌不得放行');
  } finally {
    await ctx.close();
  }
});

// ── ⑨ 同会话巡逻使用管理员会话令牌 ──────────────────
test('⑨ 贴吧巡逻 prompt 使用管理员会话令牌，不混用后台受限令牌', async () => {
  const ctx = await boot();
  try {
    const { token } = await ctx.store().ensure();
    const dispatched = await ctx.h.dispatchBackgroundPatrolOpportunity('tieba', {});
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
    const prompt = ctx.h.calls.prompts.at(-1)?.content?.[0]?.text ?? '';
    const ownerToken = ctx.h.getSocialV2State('private:123').agentToken;
    assert.ok(prompt.includes(`【会话令牌】${ownerToken}`), 'prompt 必须带该管理员会话令牌');
    assert.ok(!prompt.includes(token), '不得将旧后台令牌误作为管理员会话令牌');
    assert.ok(prompt.includes('不要复述或转发'));
  } finally {
    await ctx.close();
  }
});

// ── ⑩ 后台令牌吊销不影响管理员会话令牌；旧令牌仍被拒 ───────────────────────
test('⑩ 旧后台令牌吊销后仍拒绝，但不替换管理员会话令牌', async () => {
  // 让 ensure 失败：直接注入一个 onerror 的 makeToken（store 生成后校验不过 ⇒ generated-token-invalid）。
  const ctx = await boot({
    globals: fakeE1Globals(),
    patrolEnabled: true,
  });
  try {
    const store = ctx.store();
    const { token } = await store.ensure();
    // 制造「store 不可用」的等价状态：吊销后 store 进入 broken，dispatch 时 ensure 失败。
    await store.revoke();
    const dispatched = await ctx.h.dispatchBackgroundPatrolOpportunity('tieba', {});
    assert.equal(dispatched?.ok, true, JSON.stringify(dispatched));
    const prompt = ctx.h.calls.prompts.at(-1)?.content?.[0]?.text ?? '';
    assert.ok(prompt.includes(`【会话令牌】${ctx.h.getSocialV2State('private:123').agentToken}`));
    assert.ok(!prompt.includes(token));
    const res = await agentRequest(ctx.port, { token, pathname: `${BAR_PATH}?${barQuery()}` });
    assert.equal(res.status, 403);
  } finally {
    await ctx.close();
  }
});

// ── ⑪ 副产物：令牌文件权限 0600 且不含明文泄漏到日志 ────────────────────
test('⑪ 令牌文件 0600、状态文件含 scope/generation、日志不写明文', async () => {
  const ctx = await boot();
  try {
    const { token } = await ctx.store().ensure();
    const file = path.join(ctx.h.temp, 'state', 'background-patrol-agent-token.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.scope, 'tieba-read');
    assert.equal(raw.token, token);
    assert.ok(raw.generation >= 1);
    assert.equal(raw.schemaVersion, 1);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(file).mode & 0o777;
      assert.equal(mode, 0o600, `令牌文件权限应为 600，实际 ${mode.toString(8)}`);
    }
    const logFile = path.join(ctx.h.temp, 'state', 'bridge.log');
    const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    assert.ok(!logText.includes(token), '日志不得出现令牌明文');
  } finally {
    await ctx.close();
  }
});
