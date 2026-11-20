// scripts/test-xiaoheihe-console-settings-http.mjs
// 小黑盒控制台专栏（任务卡 2026-10-27）：配置读写的**真实 HTTP 回归测试**。
//
// 覆盖三条路由（都在 /api/console/xiaoheihe-column 前缀下，必须先过专栏会话门禁）：
//   GET  /settings        读配置 + controller 状态 + 巡逻/降级摘要
//   POST /settings/apply  保存并退出：保存配置 → 下发额度 → 逐条重置/恢复，首败即停
//   GET  /audit           当日审计尾部（只回白名单字段）
//
// 为什么必须是真实 HTTP：任务卡明确「所有判断必须服务端校验，不信任模型自报」。
// 静态 pin 只能证明字面量存在，证明不了「保存后 api 门禁读到的就是新值」「失败即停」
// 这类顺序性契约。这里起真实 console server（scripts/audit-bridge-harness.mjs 跑真实
// bridge 源码），用一个记账型假 hook 观察 bridge 到底按什么顺序、用什么参数调它。
//
// 全部离线：临时 state 目录、假授权 hook、不访问平台/QQ、不重启桥接、不写仓库状态文件。
// 专栏会话走**真实机制**（POST /auth/setup 首设密码 + Set-Cookie），不伪造内部变量。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BRIDGE_SOURCE = await fs.readFile(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

const CONSOLE_TOKEN = 'console-settings-http-token-0123456789abcdef';
const AUTHORIZE_TOKEN = 'console-settings-authorize-token-0123456789abcdef';
const COLUMN_PASSWORD = 'console-settings-password-123';
const COLUMN_PATH = '/api/console/xiaoheihe-column';
const SETTINGS_PATH = `${COLUMN_PATH}/settings`;
const APPLY_PATH = `${COLUMN_PATH}/settings/apply`;
const AUDIT_PATH = `${COLUMN_PATH}/audit`;

/**
 * 记账型假授权 hook：实现 bridge 会调到的全部方法。
 * 关键点：applyConsoleSettings 读的是 bridge 注入的 consoleSettings 提供者，
 * 因此测试能验证「内存快照已替换 → 下发到 controller 的是新值」这条链路。
 */
function makeRecordingHook() {
  const calls = { apply: 0, reset: [], recover: [], providerReads: 0 };
  let options = null;
  const hook = {
    capturedOptions: () => options,
    calls,
    hook: {
      create(optionsArg) {
        options = optionsArg;
        return {
          async start() { return { ok: true, enabled: true, url: 'http://127.0.0.1:0' }; },
          async stop() {},
          async close() {},
          async reconcile() { return { ok: true, blocked: false, migrated: false, delivered: 0 }; },
          status() { return { started: true, identityMode: 'mapper' }; },
          async statusAsync() {
            return {
              started: true,
              identityMode: 'mapper',
              controller: {
                read: { used: 3, limit: 14 },
                post: { used: 0, limit: 2 },
                comment: { used: 1, limit: 12 },
                writePaused: false,
                accessPaused: false,
              },
            };
          },
          async applyConsoleSettings() {
            calls.apply += 1;
            calls.providerReads += 1;
            const settings = typeof options?.consoleSettings === 'function' ? options.consoleSettings() : null;
            const quota = settings?.quota ?? null;
            if (quota === null) return { ok: false, reason: 'invalid-console-settings' };
            return { ok: true, limits: { read: quota.browse, post: quota.post, comment: quota.comment } };
          },
          async resetDailyCounts(scope) {
            calls.reset.push(scope);
            return { ok: true, scope, reset: { read: true, post: scope === 'all', comment: scope === 'all' } };
          },
          async recoverColumnScope(scope) {
            calls.recover.push(scope);
            return { ok: true, scope, wasPaused: true, writePaused: false, accessPaused: false };
          },
        };
      },
    },
  };
  return hook;
}

const cookieFrom = (res) => {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const hit = list.find((line) => String(line).startsWith('xb_column_session='));
  if (!hit) return null;
  return String(hit).split(';')[0].trim();
};

function request(port, { method = 'GET', pathname, body, cookie, token = CONSOLE_TOKEN, columnRequest = '1' } = {}) {
  const payload = method === 'GET'
    ? null
    : Buffer.from(JSON.stringify(body === undefined ? {} : body), 'utf8');
  const headers = {
    ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
    ...(token === null ? {} : { 'x-console-token': token }),
    ...(columnRequest === null ? {} : { 'x-column-request': columnRequest }),
    ...(cookie ? { cookie } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 交给调用方看 text */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function boot({ config, globals = {} }) {
  // consoleSettings:false ⇒ 临时目录里不写配置快照，bridge 必须走 ENOENT 默认值（任务卡口径）。
  const h = await bridgeHarness({ config, globals, consoleSettings: false });
  const server = await h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const close = async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  };
  return { h, port, close };
}

/** 真实专栏流程：先按 m30623 口径暂停 socialV2，再首设密码取 Cookie。 */
async function enrollColumnSession(instance) {
  const pause = await request(instance.port, {
    method: 'POST',
    pathname: '/api/socialV2/activity',
    body: { paused: true },
  });
  assert.equal(pause.status, 200, `暂停二代仿真失败：${pause.text}`);
  const setup = await request(instance.port, {
    method: 'POST',
    pathname: `${COLUMN_PATH}/auth/setup`,
    body: { password: COLUMN_PASSWORD },
  });
  assert.equal(setup.status, 200, `专栏首设密码失败：${setup.text}`);
  const cookie = cookieFrom(setup);
  assert.ok(cookie, `首设密码后必须签发会话 Cookie：${JSON.stringify(setup.headers)}`);
  return cookie;
}

let recorder = null;
let instance = null;

before(async () => {
  recorder = makeRecordingHook();
  instance = await boot({
    config: {
      consoleToken: CONSOLE_TOKEN,
      consolePort: 0,
      slang: { enabled: false },
      backgroundPatrol: { enabled: true, paused: true, authorizeToken: AUTHORIZE_TOKEN },
    },
    globals: {
      // 假授权 hook：不 bind 端口；方法齐全，避免 bridge 的 apply/statusAsync 调用炸在 undefined 上。
      createBackgroundPatrolBridgeHook: (options) => recorder.hook.create(options),
      // 审计只进内存，避免临时目录里多出并发写的账本文件。
      createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    },
  });
  instance.cookie = await enrollColumnSession(instance);
});

after(async () => {
  if (instance) await instance.close();
});

// ── 门禁：三条路由在没有专栏会话时一律 403 ────────────────────────────────────
test('T1 无专栏会话 ⇒ settings / apply / audit 一律 403 column-session-required', async () => {
  const cases = [
    { method: 'GET', pathname: SETTINGS_PATH },
    { method: 'POST', pathname: APPLY_PATH, body: {} },
    { method: 'GET', pathname: AUDIT_PATH },
  ];
  for (const item of cases) {
    const r = await request(instance.port, item);
    assert.equal(r.status, 403, `${item.method} ${item.pathname} 应被会话门禁拒绝：${r.text}`);
    assert.equal(r.json?.ok, false, r.text);
    assert.equal(r.json?.error, 'column-session-required', r.text);
    // 门禁必须在任何业务逻辑之前：不得泄漏配置。
    assert.equal(r.json?.settings, undefined, '被门禁拒绝时不得泄漏配置');
  }
});

// ── GET /settings：默认值形状 ────────────────────────────────────────────────
test('T2 GET /settings ⇒ 200 且返回任务卡约定的默认值（浏览 14 / 发帖 2 / 评论 12，时段 07:00–23:00）', async () => {
  const r = await request(instance.port, { pathname: SETTINGS_PATH, cookie: instance.cookie });
  assert.equal(r.status, 200, r.text);
  const body = r.json;
  assert.equal(body.ok, true, r.text);
  assert.equal(body.quotaMax, 99, '页面需要用同一个上限渲染输入框');
  assert.deepEqual(body.settings.capabilities, { browse: true, post: true, comment: true, reply: true });
  assert.equal(body.settings.readOnly, false);
  assert.deepEqual(body.settings.patrol, { enabled: true, window: { start: '07:00', end: '23:00' } });
  assert.deepEqual(body.settings.quota, { browse: 14, post: 2, comment: 12 });
  // controller 状态来自 hook.statusAsync()，页面直接展示「已用/上限」。
  assert.equal(body.controller.read.used, 3, r.text);
  // 巡逻与降级摘要必须同时给，页面才不用二次请求。
  assert.equal(typeof body.patrol.phase, 'string', r.text);
  assert.ok(body.degrade === null || typeof body.degrade === 'object', r.text);
});

// ── POST /settings/apply：顺序、持久化、内存快照 ──────────────────────────────
test('T3 apply：保存 → 下发额度 → 重置 → 恢复，顺序固定；保存后 GET 立刻读到新值', async () => {
  const before = { apply: recorder.calls.apply, reset: recorder.calls.reset.length, recover: recorder.calls.recover.length };
  const next = {
    capabilities: { browse: true, post: false, comment: true, reply: false },
    readOnly: true,
    patrol: { enabled: false, window: { start: '22:00', end: '06:00' } },
    quota: { browse: 5, post: 0, comment: 12 },
  };
  const r = await request(instance.port, {
    method: 'POST',
    pathname: APPLY_PATH,
    cookie: instance.cookie,
    body: { settings: next, actions: [{ type: 'reset', scope: 'all' }, { type: 'recover', scope: 'write' }] },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true, r.text);
  const types = r.json.steps.map((step) => step.type);
  assert.deepEqual(types, ['save-settings', 'apply-quota', 'reset', 'recover'], `执行顺序必须固定：${r.text}`);
  assert.equal(recorder.calls.apply, before.apply + 1, '必须下发一次额度');
  assert.equal(recorder.calls.reset.length, before.reset + 1);
  assert.equal(recorder.calls.recover.length, before.recover + 1);
  assert.equal(recorder.calls.reset.at(-1), 'all');
  assert.equal(recorder.calls.recover.at(-1), 'write');
  assert.equal(r.json.steps.at(-1).wasPaused, true, '恢复步骤要如实回报「本来有没有暂停」');

  // 关键：api 门禁读的是内存快照，必须与磁盘一致（这里经 GET 读同一个快照）。
  const after = await request(instance.port, { pathname: SETTINGS_PATH, cookie: instance.cookie });
  assert.equal(after.status, 200, after.text);
  // normalizeSettings 会补 schemaVersion（写盘与回读都带它），断言时显式对齐。
  assert.deepEqual(after.json.settings, { schemaVersion: 1, ...next }, `保存后必须立刻读到新值：${after.text}`);
});

// ── 非法配置：不保存、不改变内存快照 ─────────────────────────────────────────
test('T4 apply 非法配置 ⇒ 400 validate 且不保存（拒绝 100 / 未知键 / 非法时段）', async () => {
  const good = (await request(instance.port, { pathname: SETTINGS_PATH, cookie: instance.cookie })).json.settings;
  const applyBefore = recorder.calls.apply;
  const cases = [
    { label: '额度越界', settings: { ...good, quota: { ...good.quota, browse: 100 } } },
    { label: '未知键', settings: { ...good, bogus: true } },
    { label: '非法时段', settings: { ...good, patrol: { enabled: true, window: { start: '25:00', end: '06:00' } } } },
  ];
  for (const item of cases) {
    const r = await request(instance.port, {
      method: 'POST',
      pathname: APPLY_PATH,
      cookie: instance.cookie,
      body: { settings: item.settings },
    });
    assert.equal(r.status, 400, `${item.label} 必须被拒：${r.text}`);
    assert.equal(r.json?.ok, false, r.text);
    assert.equal(r.json?.step, 'validate', `${item.label}：${r.text}`);
  }
  // 三次非法请求都不得下发额度、不得改动已保存的配置。
  assert.equal(recorder.calls.apply, applyBefore, '非法配置不得下发额度');
  const still = (await request(instance.port, { pathname: SETTINGS_PATH, cookie: instance.cookie })).json.settings;
  assert.deepEqual(still, good, '非法配置不得改动已保存配置');
});

// ── 首败即停：后续动作不得执行 ───────────────────────────────────────────────
test('T5 apply 动作首败即停（不重试、不回滚）：非法动作之后的 reset/recover 一律不执行', async () => {
  const before = { reset: recorder.calls.reset.length, recover: recorder.calls.recover.length };
  const current = (await request(instance.port, { pathname: SETTINGS_PATH, cookie: instance.cookie })).json.settings;
  const r = await request(instance.port, {
    method: 'POST',
    pathname: APPLY_PATH,
    cookie: instance.cookie,
    body: {
      settings: current,
      actions: [{ type: 'bogus' }, { type: 'reset', scope: 'all' }, { type: 'recover', scope: 'access' }],
    },
  });
  assert.equal(r.status, 500, `首败必须整体失败：${r.text}`);
  assert.equal(r.json?.ok, false, r.text);
  assert.match(String(r.json?.failed), /^bogus:/u, `失败步骤要能定位到具体动作：${r.text}`);
  assert.deepEqual(r.json.steps.map((step) => step.type), ['save-settings', 'apply-quota', 'bogus']);
  assert.equal(recorder.calls.reset.length, before.reset, '首败后不得继续 reset');
  assert.equal(recorder.calls.recover.length, before.recover, '首败后不得继续 recover');
});

// ── GET /audit：只回白名单字段 ───────────────────────────────────────────────
test('T6 GET /audit ⇒ 200 且每条只含白名单字段（不含审计原文/正文/令牌）', async () => {
  const r = await request(instance.port, { pathname: `${AUDIT_PATH}?limit=5`, cookie: instance.cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true, r.text);
  assert.ok(Array.isArray(r.json.entries), r.text);
  assert.match(String(r.json.day), /^\d{4}-\d{2}-\d{2}$/u, r.text);
  const allowed = new Set(['at', 'platform', 'action', 'result', 'reason', 'opId', 'operator']);
  for (const entry of r.json.entries) {
    for (const key of Object.keys(entry)) {
      assert.ok(allowed.has(key), `审计视图不得暴露额外字段：${key}`);
    }
  }
});

// ── P2-1：apply 的审计必须逐步骤 + 带操作者，且平台不得错标 ────────────────
// 这里刻意**不桩掉审计模块**（用真实的 background-patrol-audit 写临时目录），
// 这样才能同时验证：字段能过审计模块校验、能落盘、能被 GET /audit 读回。
test('T8 apply 审计：逐步骤各一行、platform=console、带 operator 指纹（真实审计模块）', async () => {
  const real = await boot({
    config: {
      consoleToken: CONSOLE_TOKEN,
      consolePort: 0,
      slang: { enabled: false },
      backgroundPatrol: { enabled: true, paused: true, authorizeToken: AUTHORIZE_TOKEN },
    },
    globals: {
      createBackgroundPatrolBridgeHook: (options) => makeRecordingHook().hook.create(options),
    },
  });
  try {
    const cookie = await enrollColumnSession(real);
    const apply = await request(real.port, {
      method: 'POST',
      pathname: APPLY_PATH,
      cookie,
      body: {
        settings: {
          capabilities: { browse: true, post: true, comment: true, reply: true },
          readOnly: false,
          patrol: { enabled: true, window: { start: '00:00', end: '00:00' } },
          quota: { browse: 14, post: 2, comment: 12 },
        },
        actions: [{ type: 'reset', scope: 'all' }],
      },
    });
    assert.equal(apply.json.ok, true, apply.text);
    // 审计是异步落盘（record 返回 promise，bridge 不 await）：轮询等它写完，避免读到空目录。
    let audit = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      audit = await request(real.port, { pathname: `${AUDIT_PATH}?limit=50`, cookie });
      if (Array.isArray(audit.json.entries) && audit.json.entries.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(audit.status, 200, audit.text);
    const rows = audit.json.entries;
    const consoleRows = rows.filter((row) => row.platform === 'console');
    assert.ok(consoleRows.length >= 3, `apply 必须逐步骤记审计（save-settings/apply-quota/reset + 总结果）：${audit.text}`);
    const reasons = new Set(consoleRows.map((row) => row.reason));
    for (const expected of ['console-step-save-settings', 'console-step-apply-quota', 'console-step-reset', 'console-settings-apply']) {
      assert.ok(reasons.has(expected), `缺少审计行 ${expected}（实际：${[...reasons].join(',')}）`);
    }
    for (const row of consoleRows) {
      assert.match(String(row.operator), /^col-[0-9a-f]{12}$/u, `控制台审计行必须带操作者指纹：${JSON.stringify(row)}`);
      assert.equal(row.action, 'write');
      assert.equal(row.result, 'success');
    }
    // 反向：不能把控制台操作错标成 xiaoheihe（旧代码把 platform 塞进第 4 参被忽略）。
    const mislabelled = rows.filter((row) => row.platform === 'xiaoheihe' && String(row.reason).startsWith('console-'));
    assert.equal(mislabelled.length, 0, `控制台审计行不得错标成 xiaoheihe：${JSON.stringify(mislabelled)}`);
  } finally {
    await real.close();
  }
});

// ── 静态契约：bridge 的接线不能悄悄退化 ──────────────────────────────────────
test('T7 静态契约：settings 路径独立于 config、巡逻门控在投递前、三端点存在', () => {
  assert.ok(
    BRIDGE_SOURCE.includes("const CONSOLE_SETTINGS_PATH = path.join(ROOT, CONSOLE_SETTINGS_RELATIVE_PATH);"),
    '配置必须落在 state/ 下的独立文件（不是 config.json）',
  );
  assert.ok(
    BRIDGE_SOURCE.includes('consoleSettings: () => ensureConsoleColumnSettings(),'),
    'hook 必须拿到「读当前配置」的函数，而不是一次性快照',
  );
  assert.ok(
    BRIDGE_SOURCE.includes("const patrolGate = decidePatrolDispatch(ensureConsoleColumnSettings(), Date.now());"),
    '巡逻总开关必须在投递前判定',
  );
  assert.ok(
    BRIDGE_SOURCE.includes("recordBackgroundPatrolAudit(patrolGate.reason, 'skip'"),
    '巡逻时段必须在投递前判定',
  );
  assert.ok(
    BRIDGE_SOURCE.includes("if (req.method === 'GET' && subPath === '/settings') {"),
    'GET /settings 必须存在',
  );
  assert.ok(
    BRIDGE_SOURCE.includes("if (req.method === 'POST' && subPath === '/settings/apply') {"),
    'POST /settings/apply 必须存在',
  );
  assert.ok(
    BRIDGE_SOURCE.includes("if (req.method === 'GET' && subPath === '/audit') {"),
    'GET /audit 必须存在',
  );
});