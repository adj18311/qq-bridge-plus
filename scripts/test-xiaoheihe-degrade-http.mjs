// scripts/test-xiaoheihe-degrade-http.mjs
// A-2 小黑盒降级只读层：三条 HTTP 路由的**真实回归测试**（不是静态 pin）。
//
// 背景：src/bridge.js 里已实现三条路由 ——
//   GET  /api/degrade/status        降级状态只读视图 + 手动恢复三条件
//   POST /api/degrade/recover       受控恢复（条件不满足 ⇒ 400 precondition-failed）
//   POST /api/degrade/resend-notify 重发降级通知（回执照实记录）
// 但它们此前只有静态 pin，没有一次真实 HTTP 往返。本文件起**真实 console server**
// （scripts/audit-bridge-harness.mjs 跑真实 bridge 源码）逐条打过去，锁死四件事：
//   (a) 三条路由在没有专栏会话时一律 403 column-session-required（门禁在最前）；
//   (b) status 在「降级层为 null」与「降级层可用」两种状态下都是 200，且形状稳定；
//   (c) recover 在会话有效但前置条件不满足时 400 + reason==='precondition-failed'
//       + failed 非空数组，且**绝不调用** applyManualRecovery（用计数假降级层钉住）；
//   (d) resend-notify 会话有效时 200 且带 notifyStatus（假降级层 + 假 bot，不发真实 QQ）。
//
// 全部离线：临时 state 目录、假降级层、假授权 hook、FakeBot（只记账不发送）。
// 不读正式 config、不访问平台/QQ、不重启桥接、不写仓库里的任何状态文件。
//
// 专栏会话走**真实机制**：控制台 HTTP 的 POST /auth/setup 首设密码（要求巡逻已暂停）
// 并取回 Set-Cookie 里的 xb_column_session。不使用「伪造门禁内部变量」的写法。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BRIDGE_SOURCE = await fs.readFile(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

const CONSOLE_TOKEN = 'degrade-http-console-token-0123456789abcdef';
const AUTHORIZE_TOKEN = 'degrade-http-authorize-token-0123456789abcdef';
const COLUMN_PASSWORD = 'degrade-column-password-123';
const COLUMN_PATH = '/api/console/xiaoheihe-column';
const STATUS_PATH = '/api/degrade/status';
const RECOVER_PATH = '/api/degrade/recover';
const RESEND_PATH = '/api/degrade/resend-notify';
// 三条路由的失败响应形状（与 src/bridge.js 的 sendJson 逐字对齐）。
const SESSION_REQUIRED = 'column-session-required';

/**
 * 假降级层：bridge 只依赖这 6 个方法。
 * - snapshot() 给出 bridge 侧 backgroundPatrolDegradeView() 需要的全部字段；
 * - applyManualRecovery 只计数（(c) 要靠它证明失败分支没被调用）；
 * - markNotify 记下每次回执（(d) 要靠它证明通知确实走了「发送 + 记回执」）。
 */
function makeFakeDegrade() {
  const calls = { load: 0, enter: [], markNotify: [], applyManualRecovery: 0 };
  const state = {
    level: 'read-only',
    trigger: 'identity-guard-unavailable',
    since: 1_700_000_000_000,
    notify: { status: 'unknown', attempts: 1, operationId: null, lastCode: null },
  };
  const degrade = {
    async load() { calls.load += 1; return { ok: true, failClosed: false }; },
    snapshot() {
      return {
        level: state.level,
        trigger: state.trigger,
        since: state.since,
        identityOk: false,
        blockWrite: true,
        blockAll: false,
        failClosed: false,
        reason: null,
        notify: { ...state.notify },
      };
    },
    async enter(info) {
      calls.enter.push(info);
      if (typeof info?.level === 'string') state.level = info.level;
      if (typeof info?.trigger === 'string') state.trigger = info.trigger;
      return { ok: true };
    },
    async recordIdentityOk() { return { ok: true }; },
    async markNotify(info) {
      calls.markNotify.push(info);
      state.notify = { ...state.notify, status: info?.status ?? null, lastCode: info?.lastCode ?? null };
      return { ok: true };
    },
    async applyManualRecovery(request) {
      calls.applyManualRecovery += 1;
      calls.lastRecovery = request;
      return { ok: true, level: 'normal', received: request };
    },
  };
  return { degrade, calls, state };
}

/**
 * 假授权 hook：只有 status() 会被三条路由消费（identityMode）。
 * 故意报 legacy —— 身份来源「不可判定」，identity 条件必然不满足（(c) 的前置条件来源）。
 * 不 bind 任何端口（避免端口残留把测试进程挂死）。
 */
function makeFakeHook(identityMode = 'legacy') {
  return {
    async start() { return { ok: true, enabled: true, url: 'http://127.0.0.1:1', port: 1 }; },
    async close() { return { stopped: true }; },
    async stop() { return { stopped: true }; },
    status() { return { started: true, identityMode }; },
    async reconcile() { return { ok: true, blocked: false }; },
  };
}

/**
 * 原生 http 请求（避免 undici 的 blocked-port 假红）；默认带控制台令牌。
 * 非 GET 一律带 `application/json` 请求体：控制台有 CSRF 中间件，缺这个头会先吃 415，
 * 根本走不到路由自己的会话门禁（见 src/bridge.js:6552-6559）。
 */
function request(port, { method = 'GET', pathname, body, cookie, token = CONSOLE_TOKEN, columnRequest = null } = {}) {
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
    // agent:false ⇒ 每条请求独立连接，不会被 keep-alive 池拖住 server.close()。
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 响应交给调用方看 text */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const cookieFrom = (res) => {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const hit = list.find((line) => String(line).startsWith('xb_column_session='));
  if (!hit) return null;
  return String(hit).split(';')[0].trim();
};

/**
 * 起一个真实 bridge + 真实 console server。
 * `globals` 透传给 harness 的 VM 上下文（最后展开，可覆盖任意注入）。
 */
async function boot({ config, globals = {} }) {
  const h = await bridgeHarness({ config, globals });
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

/** 用真实专栏流程首设密码并取回会话 Cookie（不是伪造门禁内部变量）。 */
async function enrollColumnSession(instance) {
  // m30623 口径：门槛只看 socialV2（=「二代仿真」页的「暂停二代 AI」），巡逻状态已不参与。
  // socialV2.paused 是运行时开关，只能经 /api/socialV2/activity 切，所以这里先真打一次。
  const pause = await request(instance.port, {
    method: 'POST',
    pathname: '/api/socialV2/activity',
    body: { paused: true },
    columnRequest: '1',
  });
  assert.equal(pause.status, 200, `暂停二代仿真失败：${pause.text}`);
  const setup = await request(instance.port, {
    method: 'POST',
    pathname: `${COLUMN_PATH}/auth/setup`,
    body: { password: COLUMN_PASSWORD },
    columnRequest: '1',
  });
  assert.equal(setup.status, 200, `专栏首设密码失败：${setup.text}`);
  assert.equal(setup.json?.ok, true, setup.text);
  const cookie = cookieFrom(setup);
  assert.ok(cookie, `首设密码后必须签发会话 Cookie：${JSON.stringify(setup.headers)}`);
  return cookie;
}

// patrolOff：backgroundPatrol.enabled=false ⇒ 从不创建降级层（backgroundPatrolDegrade === null）。
// paused=true 已不再影响专栏门槛（m30623 起只看 socialV2），保留它只为贴近生产配置。
let patrolOff = null;
// patrolOn：注入假降级层 + 假授权 hook ⇒ 降级层可用、身份模式为 legacy。
let patrolOn = null;
let fakeDegrade = null;
// patrolRecover：三条前置条件**全部齐备**的实例（成功路径回归用）。
let patrolRecover = null;
let recoverDegrade = null;

before(async () => {
  patrolOff = await boot({
    config: {
      consoleToken: CONSOLE_TOKEN,
      consolePort: 0,
      slang: { enabled: false },
      backgroundPatrol: { enabled: false, paused: true },
    },
  });
  patrolOff.cookie = await enrollColumnSession(patrolOff);

  fakeDegrade = makeFakeDegrade();
  patrolOn = await boot({
    config: {
      consoleToken: CONSOLE_TOKEN,
      consolePort: 0,
      slang: { enabled: false },
      backgroundPatrol: { enabled: true, paused: true, authorizeToken: AUTHORIZE_TOKEN },
    },
    globals: {
      // 假降级层：完全内存记账，不落盘、不发通知。
      createXiaoheiheDegrade: () => fakeDegrade.degrade,
      // 假授权 hook：不 bind 端口；identityMode=legacy 让 identity 条件必然失败。
      createBackgroundPatrolBridgeHook: () => makeFakeHook('legacy'),
      // 审计只进内存，避免临时目录里多出并发写的账本文件。
      createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
    },
  });
  patrolOn.cookie = await enrollColumnSession(patrolOn);

  // (d) 成功路径：身份 mapper + QQ 通信现算为通 + 降级通知已有 delivered 回执。
  // ownerCommsCurrentlyUp 走 harness 的 globals 覆盖（`...globals` 最后展开，优先于 coreBindings）——
  // 这样不必真连 SnowLuma，也不必给生产代码加接缝。
  recoverDegrade = makeFakeDegrade();
  recoverDegrade.state.notify = { status: 'delivered', attempts: 2, operationId: 'op-fixture', lastCode: null };
  patrolRecover = await boot({
    config: {
      consoleToken: CONSOLE_TOKEN,
      consolePort: 0,
      slang: { enabled: false },
      backgroundPatrol: { enabled: true, paused: true, authorizeToken: AUTHORIZE_TOKEN },
    },
    globals: {
      createXiaoheiheDegrade: () => recoverDegrade.degrade,
      createBackgroundPatrolBridgeHook: () => makeFakeHook('mapper'),
      createBackgroundPatrolAudit: () => ({ async load() {}, async record() { return { ok: true }; } }),
      ownerCommsCurrentlyUp: () => true,
    },
  });
  patrolRecover.cookie = await enrollColumnSession(patrolRecover);
});

after(async () => {
  if (patrolRecover) await patrolRecover.close();
  if (patrolOn) await patrolOn.close();
  if (patrolOff) await patrolOff.close();
});

// ── (a) 门禁：三条路由在没有专栏会话时一律 403 ────────────────────────────────
test('T1 无专栏会话 ⇒ 三条降级路由一律 403 column-session-required', async () => {
  for (const instance of [patrolOff, patrolOn]) {
    const cases = [
      { method: 'GET', pathname: STATUS_PATH },
      { method: 'POST', pathname: RECOVER_PATH },
      { method: 'POST', pathname: RESEND_PATH },
    ];
    for (const item of cases) {
      // 控制台令牌照常携带：403 必须来自「会话门禁」，而不是 401 令牌门禁。
      const r = await request(instance.port, item);
      assert.equal(r.status, 403, `${item.method} ${item.pathname} 应被会话门禁拒绝：${r.text}`);
      assert.equal(r.json?.ok, false, r.text);
      assert.equal(r.json?.error, SESSION_REQUIRED, `${item.method} ${item.pathname}：${r.text}`);
      // 门禁必须发生在任何业务逻辑之前：不得下发降级快照。
      assert.equal(r.json?.degrade, undefined, '被门禁拒绝时不得泄漏降级状态');
    }
  }
});

test('T2 403 分支零副作用：不触发手动恢复、不写审计、不发任何通知', async () => {
  const sentBefore = patrolOn.h.calls.sent.length;
  const recoveryBefore = fakeDegrade.calls.applyManualRecovery;
  const notifyBefore = fakeDegrade.calls.markNotify.length;
  const enteredBefore = fakeDegrade.calls.enter.length;

  for (const item of [
    { method: 'GET', pathname: STATUS_PATH },
    { method: 'POST', pathname: RECOVER_PATH },
    { method: 'POST', pathname: RESEND_PATH },
  ]) {
    await request(patrolOn.port, item);
  }

  assert.equal(fakeDegrade.calls.applyManualRecovery, recoveryBefore, '403 时绝不能调用 applyManualRecovery');
  assert.equal(fakeDegrade.calls.markNotify.length, notifyBefore, '403 时绝不能记通知回执');
  assert.equal(fakeDegrade.calls.enter.length, enteredBefore, '403 时不得进入/变更降级级别');
  assert.equal(patrolOn.h.calls.sent.length, sentBefore, '403 时不得发任何私聊');
});

// ── (b) GET /api/degrade/status 的两种状态 ───────────────────────────────────
test('T3 会话有效 + 降级层为 null ⇒ 200 {ok:true, available:false, degrade:null}', async () => {
  const r = await request(patrolOff.port, { pathname: STATUS_PATH, cookie: patrolOff.cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json?.ok, true, r.text);
  assert.equal(r.json?.available, false, '没有降级层时必须如实报 available:false');
  assert.equal(r.json?.degrade, null, r.text);
  assert.equal(r.json?.conditions, null, r.text);
  assert.equal(r.json?.identityMode, null, r.text);
  // 没有降级层就不该给出「可恢复」的假象。
  assert.equal(r.json?.canRecover, undefined, '没有降级层时不得报 canRecover');
});

test('T4 会话有效 + 降级层可用 ⇒ 200 且 degrade/conditions/failed/canRecover 形状稳定', async () => {
  const r = await request(patrolOn.port, { pathname: STATUS_PATH, cookie: patrolOn.cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json?.ok, true, r.text);
  assert.equal(r.json?.available, true, r.text);
  assert.equal(r.json?.identityMode, 'legacy', `identityMode 必须来自 hook.status()：${r.text}`);

  // degrade：只断言形状（具体业务值由降级层自身单测覆盖）。
  const degrade = r.json?.degrade;
  assert.equal(typeof degrade, 'object', r.text);
  assert.ok(degrade !== null && !Array.isArray(degrade), r.text);
  for (const key of ['level', 'trigger', 'since', 'blockWrite', 'blockAll', 'failClosed', 'failClosedReason', 'notify']) {
    assert.ok(key in degrade, `降级快照缺少字段 ${key}：${JSON.stringify(degrade)}`);
  }
  assert.equal(typeof degrade.blockWrite, 'boolean', 'blockWrite 必须被映射成布尔');
  assert.equal(typeof degrade.blockAll, 'boolean', 'blockAll 必须被映射成布尔');
  assert.equal(typeof degrade.failClosed, 'boolean', 'failClosed 必须被映射成布尔');

  // conditions：固定三项，且全部是布尔（服务端现算，绝不从请求体读）。
  const conditions = r.json?.conditions;
  assert.equal(typeof conditions, 'object', r.text);
  assert.deepEqual(
    Object.keys(conditions).sort(),
    ['identity', 'qq-comms', 'report-receipt'],
    `恢复三条件必须固定：${JSON.stringify(conditions)}`,
  );
  for (const [key, value] of Object.entries(conditions)) {
    assert.equal(typeof value, 'boolean', `条件 ${key} 必须是布尔：${JSON.stringify(value)}`);
  }

  // failed / messages / canRecover 三者必须互相自洽。
  const failed = r.json?.failed;
  assert.ok(Array.isArray(failed), `failed 必须是数组：${r.text}`);
  for (const item of failed) assert.equal(typeof item, 'string', 'failed 元素必须是条件名');
  assert.deepEqual(
    failed.slice().sort(),
    Object.keys(conditions).filter((key) => conditions[key] !== true).sort(),
    'failed 必须恰好是未满足的条件集合',
  );
  assert.ok(Array.isArray(r.json?.messages), 'messages 必须是数组');
  assert.equal(r.json?.messages.length, failed.length, 'messages 与 failed 必须一一对应');
  assert.equal(r.json?.canRecover, failed.length === 0, 'canRecover 必须等价于「三条件全满足」');
  // 本夹具的 hook 报 legacy ⇒ 身份条件必然不满足，绝不能报「可恢复」。
  assert.ok(failed.includes('identity'), `legacy 身份模式必须让 identity 条件失败：${r.text}`);
  assert.equal(r.json?.canRecover, false, r.text);
});

test('T5 会话有效但降级层为 null ⇒ recover / resend-notify 均 503（明确告知未初始化）', async () => {
  const recover = await request(patrolOff.port, { method: 'POST', pathname: RECOVER_PATH, cookie: patrolOff.cookie });
  assert.equal(recover.status, 503, recover.text);
  assert.equal(recover.json?.ok, false, recover.text);
  assert.match(String(recover.json?.error ?? ''), /未初始化/, `必须说明降级层未初始化：${recover.text}`);

  const resend = await request(patrolOff.port, { method: 'POST', pathname: RESEND_PATH, cookie: patrolOff.cookie });
  assert.equal(resend.status, 503, resend.text);
  assert.equal(resend.json?.ok, false, resend.text);
  assert.match(String(resend.json?.error ?? ''), /未初始化/, `必须说明降级层未初始化：${resend.text}`);
});

// ── (c) POST /api/degrade/recover：前置条件不满足 ─────────────────────────────
test('T6 会话有效 + 前置条件不满足 ⇒ 400 precondition-failed，且绝不调用 applyManualRecovery', async () => {
  const recoveryBefore = fakeDegrade.calls.applyManualRecovery;
  const notifyBefore = fakeDegrade.calls.markNotify.length;
  const sentBefore = patrolOn.h.calls.sent.length;

  const r = await request(patrolOn.port, {
    method: 'POST',
    pathname: RECOVER_PATH,
    cookie: patrolOn.cookie,
    // 故意塞一个「看起来能过」的请求体：三个条件必须服务端现算，请求体一律无效。
    body: { identity: true, 'qq-comms': true, 'report-receipt': true, confirmed: true },
  });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json?.ok, false, r.text);
  assert.equal(r.json?.reason, 'precondition-failed', `失败原因必须可机读：${r.text}`);

  const failed = r.json?.failed;
  assert.ok(Array.isArray(failed) && failed.length > 0, `failed 必须是非空数组：${r.text}`);
  for (const item of failed) assert.equal(typeof item, 'string', 'failed 元素必须是条件名');
  assert.ok(Array.isArray(r.json?.messages), 'messages 必须是数组');
  assert.equal(r.json?.messages.length, failed.length, 'messages 与 failed 必须一一对应');
  // 该分支必须带上当前快照，供 UI 显示「为什么恢复不了」。
  assert.equal(typeof r.json?.degrade, 'object', '拒绝时应回报当前降级快照');
  assert.equal(r.json?.degrade?.level, 'read-only', r.text);

  // 核心断言：失败分支必须在 applyManualRecovery 之前 return。
  assert.equal(
    fakeDegrade.calls.applyManualRecovery,
    recoveryBefore,
    '前置条件不满足时绝不能调用 applyManualRecovery（否则降级会被静默解除）',
  );
  assert.equal(fakeDegrade.calls.markNotify.length, notifyBefore, '恢复被拒时不得记通知回执');
  assert.equal(patrolOn.h.calls.sent.length, sentBefore, '恢复被拒时不得发任何私聊');
});

// ── (d) POST /api/degrade/resend-notify：会话有效 ────────────────────────────
test('T7 会话有效 ⇒ 200 且带 notifyStatus；通知走假 bot（不发真实 QQ）', async () => {
  const recoveryBefore = fakeDegrade.calls.applyManualRecovery;
  const notifyBefore = fakeDegrade.calls.markNotify.length;
  const sentBefore = patrolOn.h.calls.sent.length;

  const r = await request(patrolOn.port, { method: 'POST', pathname: RESEND_PATH, cookie: patrolOn.cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json?.ok, true, r.text);
  assert.ok('notifyStatus' in r.json, `响应必须带 notifyStatus 字段：${r.text}`);
  const notifyStatus = r.json?.notifyStatus;
  assert.ok(
    ['delivered', 'failed', 'unknown'].includes(notifyStatus),
    `notifyStatus 必须是回执枚举之一（null 也不行）：${r.text}`,
  );
  assert.equal(typeof r.json?.degrade, 'object', '重发后必须回报最新降级快照');

  // 通知确实走了「发送 + 记回执」这条真实链路，只是发送方是假 bot。
  assert.equal(fakeDegrade.calls.markNotify.length, notifyBefore + 1, '重发必须调用一次 markNotify');
  const receipt = fakeDegrade.calls.markNotify.at(-1);
  assert.equal(receipt?.status, notifyStatus, '响应里的 notifyStatus 必须与降级层记下的回执同源');
  // FakeBot 的 sendPrivateMessage 返回 undefined ⇒ 发送接口没给 message_id ⇒ 只能是 unknown。
  // 这条断言钉的是「未知 ≠ 成功」：一旦有人把未知当成功，这里立刻红。
  if (receipt?.lastCode === 'no-message-id') {
    assert.equal(notifyStatus, 'unknown', `发送接口未回 message_id 时绝不能报成功：${r.text}`);
  }
  const degradeMessages = patrolOn.h.calls.sent
    .slice(sentBefore)
    .map((item) => String(item?.text ?? ''))
    .filter((text) => text.includes('【小黑盒降级】'));
  assert.equal(degradeMessages.length, 1, `必须恰好发出一条降级通知（假 bot 记账）：${JSON.stringify(patrolOn.h.calls.sent.slice(sentBefore))}`);
  assert.equal(fakeDegrade.calls.applyManualRecovery, recoveryBefore, '重发通知不得顺手解除降级');
});

// ── 接线静态 pin（防止路由/响应字段在重构中被悄悄改掉）────────────────────────
test('T8 接线静态 pin：三条路由存在、门禁在最前、恢复条件服务端现算', async () => {
  assert.match(BRIDGE_SOURCE, /url\.pathname === '\/api\/degrade\/status'/, '必须存在降级状态只读端点');
  assert.match(BRIDGE_SOURCE, /url\.pathname === '\/api\/degrade\/recover'/, '必须存在降级受控恢复端点');
  assert.match(BRIDGE_SOURCE, /url\.pathname === '\/api\/degrade\/resend-notify'/, '必须存在降级通知重发端点');

  // 三条路由都必须先过专栏会话门禁，且响应体逐字为 column-session-required。
  const gateHits = BRIDGE_SOURCE.match(/sendJson\(\{ ok: false, error: 'column-session-required' \}, 403\)/g) ?? [];
  assert.ok(gateHits.length >= 3, `三条降级路由都要有会话门禁（实测 ${gateHits.length} 处）`);

  // 失败分支必须在 applyManualRecovery 之前 return。
  const preconditionAt = BRIDGE_SOURCE.indexOf("reason: 'precondition-failed'");
  const applyAt = BRIDGE_SOURCE.indexOf('applyManualRecovery({');
  assert.ok(preconditionAt > 0 && applyAt > 0, '恢复端点必须同时有前置条件判定与恢复调用');
  assert.ok(preconditionAt < applyAt, '前置条件判定必须早于 applyManualRecovery —— 否则失败分支会静默解除降级');

  // 重发端点必须回报 notifyStatus，且回执分级只认发送接口结果。
  assert.match(BRIDGE_SOURCE, /sendJson\(\{ ok: true, notifyStatus, degrade: after \}\)/, '重发端点必须回报 notifyStatus');
  assert.match(BRIDGE_SOURCE, /notifyStatus === 'delivered' \? 'success' : 'unknown'/, '未 delivered 一律不得记 success');

  // 三个前置条件必须服务端现算（identityMode / 当前连接事实 / 降级层快照）。
  assert.match(BRIDGE_SOURCE, /'qq-comms': ownerCommsUpNow\(\) === true,/, 'qq-comms 必须看当前连接事实');
  assert.match(BRIDGE_SOURCE, /'report-receipt': snapshot !== null && snapshot\.notify !== null/, 'report-receipt 必须来自降级层快照');
  assert.doesNotMatch(BRIDGE_SOURCE, /degrade\/recover[\s\S]{0,1200}readBody\(\)/, '受控恢复不得从请求体取条件');
});

// ── (d) POST /api/degrade/recover：三条前置条件齐备的成功路径 ─────────────────
test('T9 三条前置条件齐备 ⇒ 200 ok:true 且 applyManualRecovery 收到 confirmed:true', async () => {
  const before = recoverDegrade.calls.applyManualRecovery;
  const res = await request(patrolRecover.port, {
    method: 'POST',
    pathname: RECOVER_PATH,
    cookie: patrolRecover.cookie,
    // 故意塞一堆「看起来能绕过」的字段：服务端必须完全忽略请求体、只认现算事实。
    body: { identityOk: false, qqCommsOk: false, reportDelivered: false, confirmed: false },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json?.ok, true, res.text);
  assert.equal(res.json?.level, 'normal', res.text);
  assert.equal(
    recoverDegrade.calls.applyManualRecovery,
    before + 1,
    '条件齐备时必须真的调用一次 applyManualRecovery'
  );
  // 跨 VM realm 的对象原型不同，deepEqual 会误报；逐字段断言。
  assert.equal(recoverDegrade.calls.lastRecovery?.confirmed, true, 'confirmed 必须由服务端置 true');
  assert.equal(recoverDegrade.calls.lastRecovery?.operator, 'console-column', 'operator 必须是控制台专栏而非请求体');
  assert.equal('identityOk' in (recoverDegrade.calls.lastRecovery ?? {}), false, '恢复请求不得带请求体里的字段');
});
