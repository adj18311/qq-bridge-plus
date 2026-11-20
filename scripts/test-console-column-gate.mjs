#!/usr/bin/env node
// scripts/test-console-column-gate.mjs
//
// task-87：小黑盒专栏密码②的**行为级**测试（真实 src/bridge.js 跑在 %TEMP% 临时仓库里，
// 真起 console server 发 HTTP；不碰仓库 config.json/state、不连 QQ/DSH）。
//
// 覆盖：
//   T1  缺 `x-column-request: 1` ⇒ 400（CSRF 纵深，不构成鉴权）
//   T2  status：unset + agentPaused 两项分别如实回报 + session.valid=false
//   T3  两项都没暂停 ⇒ setup / forgot-reset 双拒（agent-not-paused），且不写 auth 文件
//   T3b 请求体注入 agentPaused 不得绕过门槛（门槛必须服务端现算）
//   T3c 只有 socialV2 暂停、巡逻仍在运行 ⇒ setup **必须放行**（m30623 口径）
//   T4  setup 成功 ⇒ 200 + Set-Cookie（HttpOnly/SameSite=Strict/Path=/api/，回环不设 Secure），
//       且**路径必须覆盖 /api/identity-guard/*** —— 否则交付 B 不可达（m02817 修正）
//   T4b status 的 expiresAt 必须取模块的 min(绝对, 空闲)，不得写死 now+15min（task-90 P3-2）
//   T5  三个恢复端点无 Cookie ⇒ 403 `column-session-required` 且 hook 零调用（零副作用）
//   T6  有有效会话 ⇒ 三个恢复端点放行，hook 各调用 1 次
//   T7  logout 后原 Cookie ⇒ 403
//   T8  会话过期（模块用过去的 now 签发的会话）⇒ 403 且 hook 零调用
//   T8b 空闲过期 ⇒ 403 且 hook 零调用（绝对未到期，只有空闲判定能拦）
//   T8c 空闲到期边界：恰好 15 分钟即过期（`>=` 语义），差 1 秒仍有效；到期时刻取二者较小者
//   T9  forgot-reset 与 setup 同口径：只暂停巡逻、socialV2 仍运行 ⇒ agent-not-paused（两项如实回报）
//   T9b socialV2 暂停即可放行 forgot-reset（巡逻在运行也不影响），且旧 Cookie 立即失效
//   T10 密码连续错误 5 次后锁定；第 6 次即使密码正确也拒绝，并带 lockedSeconds
//   T11 请求体缺 password / 非字符串 ⇒ 400 且**不计入**失败次数
//
// ⚠️ 前置假设（task-90 P3-3，改动 harness 前务必先读）：
//   本文件用 `src/core/console-column-auth.mjs` 在本进程里签发会话，再让 VM 里的 bridge 校验它。
//   能复用 token 的唯一原因是 `scripts/busy-watchdog-harness.mjs:23` 经
//   `scripts/bridge-core-bindings.mjs` 把**同一批模块实例**注入 VM context（`sessions` Map 共享）。
//   若将来 harness 改成子进程跑 bridge、或 bindings 换了模块路径，T8/T8b/T8c 会因「token 未知 → 403」
//   而**以错误理由继续通过**（覆盖悄悄变成假绿）。改 harness 时请同时改这些用例的构造方式。
//
// 用法：node --test scripts/test-console-column-gate.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { test, before, after } from 'node:test';
import { busyHarness } from './busy-watchdog-harness.mjs';
import { verifyPassword, verifySession } from '../src/core/console-column-auth.mjs';

const TOKEN = 'test-console-token-task87-0123456789abcdef';
const PASSWORD = 'column-password-123';
const COLUMN_PATH = '/api/console/xiaoheihe-column';
const GATE_PATHS = [
  '/api/identity-guard/recover',
  '/api/identity-guard/resend-notify',
  '/api/identity-guard/declare-corruption',
];

// 在内存副本里把「身份守卫 hook」换成一个纯计数器桩：只看门禁是否放行，
// 不触发真实 guard/通知（否则要起完整背景巡逻生命周期，且会把临时 state 搞脏）。
// 仓库文件一个字节都不动。
function injectHookStub(source) {
  const anchor = "        if (req.method === 'POST' && url.pathname === '/api/identity-guard/recover') {";
  assert.ok(source.includes(anchor), '接线锚点缺失：bridge.js 的 recover 路由不存在');
  return source.replace(anchor, `        if (globalThis.__columnTestHook && backgroundPatrolHook === null) backgroundPatrolHook = globalThis.__columnTestHook;\n${anchor}`);
}

async function boot({ paused = true, socialPaused = false } = {}) {
  const hookCalls = { recover: 0, resend: 0, declare: 0 };
  const stub = {
    async recoverIdentityGuard() { hookCalls.recover += 1; return { ok: true }; },
    async resendIdentityGuardNotify() { hookCalls.resend += 1; return { ok: true, operationId: 'op-resend-1', notifyStatus: 'pending' }; },
    async declareIdentityGuardCorruptionAnomaly() { hookCalls.declare += 1; return { ok: true, operationId: 'an-1', notifyStatus: 'pending' }; },
  };
  const h = await busyHarness({
    config: {
      consoleToken: TOKEN,
      consolePort: 0,
      backgroundPatrol: { enabled: false, paused },
      socialV2: { enabled: true },
    },
    transformSource: injectHookStub,
    globals: { __columnTestHook: stub },
  });
  const server = await h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  // socialV2.paused 是运行时开关（src/bridge.js 里初始硬编码 false，只能经 /api/socialV2/activity 切），
  // 不是 config 字段 ⇒ 需要「已暂停」时必须真打一次接口。
  if (socialPaused === true) {
    const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/activity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': TOKEN },
      body: JSON.stringify({ paused: true }),
    });
    if (!res.ok) throw new Error(`boot: 暂停 socialV2 失败 ${res.status} ${await res.text()}`);
  }
  const close = async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  };
  return { h, port, hookCalls, close };
}

/** 原生 http 请求（避免 undici blocked-port 假红）；默认带控制台令牌 + x-column-request。 */
function request(port, { method = 'GET', pathname, body, cookie, columnRequest = '1', token = TOKEN } = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const headers = {
    ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
    ...(token === null ? {} : { 'x-console-token': token }),
    ...(columnRequest === null ? {} : { 'x-column-request': columnRequest }),
    ...(cookie ? { cookie } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
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

let main = null;
// 2026-10-29 口径变更（用户 m30623）：控制台「暂停智能体」= 「二代仿真」页的「暂停二代 AI」，
// 后台巡逻的暂停要改 config + 重启桥接，不能当交互式门槛 ⇒ 两处门槛只看 socialV2。
// 主实例让 socialV2 处于暂停态（门槛放行），巡逻保持运行 —— 顺带证明「巡逻运行中」不阻塞。
before(async () => { main = await boot({ paused: false, socialPaused: true }); });
after(async () => { if (main) await main.close(); });

test('T1 缺 x-column-request ⇒ 400（CSRF 纵深，不是鉴权）', async () => {
  const r = await request(main.port, { method: 'POST', pathname: `${COLUMN_PATH}/auth/verify`, body: { password: PASSWORD }, columnRequest: null });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json?.error, 'column-request-header-required');
});

test('T2 status：unset + agentPaused 两项分别回报 + session 无效', async () => {
  const r = await request(main.port, { pathname: `${COLUMN_PATH}/auth/status` });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json?.ok, true);
  assert.equal(r.json?.state, 'unset');
  assert.deepEqual(r.json?.agentPaused, { backgroundPatrol: false, socialV2: true });
  assert.equal(r.json?.session?.valid, false);
  assert.equal(r.json?.session?.expiresAt, null);
});

test('T4 setup 成功：200 + Set-Cookie Path=/api/（覆盖 /api/identity-guard/*）', async () => {
  const r = await request(main.port, { method: 'POST', pathname: `${COLUMN_PATH}/auth/setup`, body: { password: PASSWORD } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json?.ok, true);
  const cookie = cookieFrom(r);
  assert.ok(cookie, `缺少 Set-Cookie：${JSON.stringify(r.headers)}`);
  const raw = String(r.headers['set-cookie']);
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Strict/i);
  assert.match(raw, /Path=\/api\//);
  assert.doesNotMatch(raw, /Path=\/api\/console\/xiaoheihe-column/);
  assert.doesNotMatch(raw, /Secure/i, '回环 HTTP 不应设 Secure');
  // task-89 P2-1：有效会话的 status 必须回报**有限的到期时刻**（原先恒 null，前端无法算剩余分钟）。
  // 变异「expiresAt 写死 null」在补这条断言前是全绿的（M5b），所以这里是回归保护。
  const st = await request(main.port, { pathname: `${COLUMN_PATH}/auth/status`, cookie });
  assert.equal(st.status, 200, st.text);
  assert.equal(st.json?.session?.valid, true);
  assert.equal(typeof st.json?.session?.expiresAt, 'number', `有效会话必须回报 expiresAt：${st.text}`);
  assert.ok(Number.isFinite(st.json.session.expiresAt));
  assert.ok(st.json.session.expiresAt > Date.now(), 'expiresAt 必须在未来');
  assert.ok(st.json.session.expiresAt <= Date.now() + 15 * 60 * 1000 + 5000, '空闲续期上限不超过 15 分钟（含容忍）');
  main.cookie = cookie;
});

// task-90 P3-2（M-STATUS-FIXED 变异洞）：T4 只钉了**上界**（`<= now+15min`），
// 所以桥接完全忽略模块返回值、自己写死 `now+15min` 也全绿。
// 要区分二者，必须构造一个「绝对到期比空闲更近」的有效会话：创建于 106 分钟前（绝对只剩 14 分钟），
// 再以 10 分钟为步长逐次校验把 lastSeenAt 续到 10 分钟前（每步都 < 15 分钟空闲窗口）。
// 此时模块返回 min(绝对=now+14min, 空闲=now+15min) = **绝对**；写死的实现会回 now+15min，
// 差额 1 分钟，大于这里的 30 秒余量 ⇒ 变异必然变红。
test('T4b status 的 expiresAt 必须取模块的 min(绝对, 空闲)，不得写死 now+15min', async () => {
  const stateDir = path.join(main.h.temp, 'state');
  const base = Date.now();
  const created = verifyPassword({ stateDir, password: PASSWORD, now: base - 106 * 60 * 1000 });
  assert.equal(created.ok, true, JSON.stringify(created));
  const absolute = created.expiresAt; // base + 14min
  for (const step of [96, 86, 76, 66, 56, 46, 36, 26, 16, 10]) {
    const walked = verifySession({ sessionToken: created.sessionToken, now: base - step * 60 * 1000 });
    assert.equal(walked.ok, true, `第 ${step} 分钟必须仍然有效：${JSON.stringify(walked)}`);
  }
  const r = await request(main.port, { pathname: `${COLUMN_PATH}/auth/status`, cookie: `xb_column_session=${created.sessionToken}` });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json?.session?.valid, true, r.text);
  const expiresAt = r.json?.session?.expiresAt;
  assert.equal(typeof expiresAt, 'number', `有效会话必须回报 expiresAt：${r.text}`);
  assert.ok(Math.abs(expiresAt - absolute) < 5000, `到期时刻必须是绝对到期（${absolute}），实际 ${expiresAt}`);
  assert.ok(
    expiresAt < Date.now() + 15 * 60 * 1000 - 30 * 1000,
    `不得回落到 now+15min（实际 ${expiresAt}，上界 ${Date.now() + 15 * 60 * 1000}）`
  );
});

test('T6 有效会话 ⇒ 三个恢复端点放行，hook 各 1 次', async () => {
  for (const pathname of GATE_PATHS) {
    const r = await request(main.port, { method: 'POST', pathname, body: {}, cookie: main.cookie });
    assert.equal(r.status, 200, `${pathname}: ${r.text}`);
  }
  assert.deepEqual(main.hookCalls, { recover: 1, resend: 1, declare: 1 });
});

test('T5 无 Cookie ⇒ 403 column-session-required 且 hook 零调用（零副作用）', async () => {
  const before = JSON.stringify(main.hookCalls);
  for (const pathname of GATE_PATHS) {
    const r = await request(main.port, { method: 'POST', pathname, body: {} });
    assert.equal(r.status, 403, `${pathname}: ${r.text}`);
    assert.equal(r.json?.error, 'column-session-required');
  }
  assert.equal(JSON.stringify(main.hookCalls), before, '403 分支不得调用 hook');
});

test('T8 过期会话 ⇒ 403（模块用过去的 now 签发，桥接侧 verifySession 判过期）', async () => {
  const stateDir = path.join(main.h.temp, 'state');
  const issued = verifyPassword({
    stateDir,
    password: PASSWORD,
    now: Date.now() - 3 * 60 * 60 * 1000, // 3h 前签发 ⇒ 绝对 2h 已过期
  });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  // task-90 P3-1（M-WEAK 变异洞）：原用例只断言 403，不断言**零副作用**。
  // 变异「过期分支先调 hook 再 403」在旧套件下 14/14 全绿 —— 门禁顺序被破坏也测不出来。
  const before = JSON.stringify(main.hookCalls);
  const r = await request(main.port, { method: 'POST', pathname: GATE_PATHS[0], body: {}, cookie: `xb_column_session=${issued.sessionToken}` });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json?.error, 'column-session-required');
  assert.equal(JSON.stringify(main.hookCalls), before, '会话无效时不得触达 hook（零副作用）');
});

// task-89 P3（M2 单点覆盖）：T8 只覆盖「绝对 2 小时过期」这一条判定分支；
// 变异「verifySession 对过期会话也返回有效」如果只被 T8 一条抓，单点失效就会全绿。
// 这里补**空闲过期**分支（16 分钟前签发：绝对到期还早，只有空闲 15 分钟判定能拦住），
// 让两条独立的过期判定各自都有断言。
test('T8b 空闲过期会话 ⇒ 403（绝对未到期，只有空闲判定能拦）', async () => {
  const stateDir = path.join(main.h.temp, 'state');
  const issued = verifyPassword({
    stateDir,
    password: PASSWORD,
    now: Date.now() - 16 * 60 * 1000, // 16min 前签发 ⇒ 空闲 15min 已过、绝对 2h 未到
  });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  const before = JSON.stringify(main.hookCalls);
  const r = await request(main.port, { method: 'POST', pathname: GATE_PATHS[1], body: {}, cookie: `xb_column_session=${issued.sessionToken}` });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json?.error, 'column-session-required');
  assert.equal(JSON.stringify(main.hookCalls), before, '会话无效时不得触达 hook（零副作用）');
});

// task-90 P3-1/P3-2（补边界断言）：过期判定是 `>=`，**恰好** 15 分钟就已经过期。
// 只测「15 分钟多一点」时，把 `>=` 写成 `>` 的变异照样全绿；且到期时刻必须等于
// 「本次续期后的空闲到期」与「绝对到期」的较小者 —— 桥接若忽略模块的 expiresAt、
// 自己写死 `now + 15min`（M-STATUS-FIXED），上界断言也拦不住（恒等于上界）。
test('T8c 空闲到期边界：恰好 15 分钟即过期（>= 语义），且到期时刻取二者较小者', async () => {
  const stateDir = path.join(main.h.temp, 'state');
  // 必须把签发时刻**钉死**（显式传 now），否则 Date.now() 在两次调用之间会漂移几毫秒，
  // 「恰好 15 分钟」就变成「15 分钟 + ε」，把 `>=` 写成 `>` 的变异依然全绿（本用例首版就是这样漏的）。
  const t0 = Date.now();
  const issued = verifyPassword({ stateDir, password: PASSWORD, now: t0 });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  // 反向对照必须用**另一个**会话：verifySession 在判过期时会 delete 掉该 token，
  // 同一个会话先测「已过期」再测「差 1 秒仍有效」必然拿到 unknown-session（首版就是这样假红的）。
  const sibling = verifyPassword({ stateDir, password: PASSWORD, now: t0 });
  assert.equal(sibling.ok, true, JSON.stringify(sibling));

  // ① 模块层：恰好 15 分钟（`>=`）判过期，不返回 expiresAt。
  const at15 = verifySession({ sessionToken: issued.sessionToken, now: t0 + 15 * 60 * 1000 });
  assert.equal(at15.ok, false, `恰好 15 分钟必须判过期：${JSON.stringify(at15)}`);
  assert.equal(at15.reason, 'expired');
  assert.equal(at15.expiresAt, undefined, '过期结果不得带 expiresAt');
  // 反向对照：同一签发时刻、早 1 秒仍然有效（否则「已过期」可能只是别的原因造成的）。
  const justBefore = verifySession({ sessionToken: sibling.sessionToken, now: t0 + 15 * 60 * 1000 - 1000 });
  assert.equal(justBefore.ok, true, `15 分钟差 1 秒必须仍然有效：${JSON.stringify(justBefore)}`);

  // ② 模块层：绝对 2 小时比空闲更近时，到期时刻必须是绝对到期（不是 now+15min）。
  //    必须边走边续（每隔 10 分钟校验一次，空闲窗口 15 分钟不会被触发），
  //    最终走到「距签发 115 分钟」——此时 now+15min 已经越过绝对到期，min() 必须选出绝对到期。
  const second = verifyPassword({ stateDir, password: PASSWORD, now: Date.now() });
  assert.equal(second.ok, true, JSON.stringify(second));
  const issuedAt = Date.now();
  // 注意：second.expiresAt 是这次签发时的 now+2h，与 issuedAt 相差毫秒级，直接用它的绝对值比较，
  // 不要用 issuedAt 反推（会有 1~2ms 漂移导致等值断言假红）。
  let lastOk = null;
  for (let step = 10; step <= 115; step += 10) {
    lastOk = verifySession({ sessionToken: second.sessionToken, now: issuedAt + step * 60 * 1000 });
    assert.equal(lastOk.ok, true, `第 ${step} 分钟必须仍然有效：${JSON.stringify(lastOk)}`);
  }
  assert.equal(lastOk.expiresAt, second.expiresAt, '绝对到期更近时必须回绝对到期');
  assert.ok(
    lastOk.expiresAt < issuedAt + 115 * 60 * 1000 + 15 * 60 * 1000 - 60 * 1000,
    '不得回落到 now+15min（否则说明没取 min）'
  );
});

test('T7 logout 后原 Cookie ⇒ 403', async () => {
  const out = await request(main.port, { method: 'POST', pathname: `${COLUMN_PATH}/auth/logout`, body: {}, cookie: main.cookie });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json?.ok, true);
  const r = await request(main.port, { method: 'POST', pathname: GATE_PATHS[0], body: {}, cookie: main.cookie });
  assert.equal(r.status, 403, r.text);
});

test('T9 forgot-reset 同口径：只暂停巡逻、socialV2 仍运行 ⇒ agent-not-paused 且两项如实回报', async () => {
  const patrolOnly = await boot({ paused: true, socialPaused: false });
  try {
    const r = await request(patrolOnly.port, { method: 'POST', pathname: `${COLUMN_PATH}/auth/forgot-reset`, body: { password: 'column-password-456' } });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json?.reason, 'agent-not-paused');
    assert.deepEqual(r.json?.agentPaused, { backgroundPatrol: true, socialV2: false }, '回报必须如实：巡逻已暂停但门槛不认它');
  } finally {
    await patrolOnly.close();
  }
});

test('T11 请求体缺 password / 非字符串 ⇒ 400 且不计入失败次数', async () => {
  const r1 = await request(main.port, { method: 'POST', pathname: `${COLUMN_PATH}/auth/verify`, body: {} });
  assert.equal(r1.status, 400, r1.text);
  const r2 = await request(main.port, { method: 'POST', pathname: `${COLUMN_PATH}/auth/verify`, body: { password: 12345 } });
  assert.equal(r2.status, 400, r2.text);
  const st = await request(main.port, { pathname: `${COLUMN_PATH}/auth/status` });
  assert.equal(st.json?.failedAttempts, 0, '非字符串密码不得计入失败次数（防灌水锁死）');
});

test('T3 两项都没暂停 ⇒ setup / forgot-reset 双拒（agent-not-paused，不写文件）', async () => {
  const paused = await boot({ paused: false, socialPaused: false });
  try {
    const r = await request(paused.port, { method: 'POST', pathname: `${COLUMN_PATH}/auth/setup`, body: { password: PASSWORD } });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json?.reason, 'agent-not-paused');
    assert.deepEqual(r.json?.agentPaused, { backgroundPatrol: false, socialV2: false });
    const r2 = await request(paused.port, { method: 'POST', pathname: `${COLUMN_PATH}/auth/forgot-reset`, body: { password: PASSWORD } });
    assert.equal(r2.status, 409, r2.text);
  } finally {
    await paused.close();
  }
});

test('T9b socialV2 暂停即可 forgot-reset（巡逻在运行也不影响），旧 Cookie 立即失效', async () => {
  const socialOnly = await boot({ paused: false, socialPaused: true });
  try {
    const setup = await request(socialOnly.port, { method: 'POST', pathname: `${COLUMN_PATH}/auth/setup`, body: { password: PASSWORD } });
    assert.equal(setup.status, 200, setup.text);
    const oldCookie = cookieFrom(setup);
    const reset = await request(socialOnly.port, { method: 'POST', pathname: `${COLUMN_PATH}/auth/forgot-reset`, body: { password: 'column-password-456' }, cookie: oldCookie });
    assert.equal(reset.status, 200, reset.text);
    assert.equal(reset.json?.ok, true);
    const r = await request(socialOnly.port, { method: 'POST', pathname: GATE_PATHS[0], body: {}, cookie: oldCookie });
    assert.equal(r.status, 403, 'forgot-reset 必须废掉全部旧会话');
  } finally {
    await socialOnly.close();
  }
});

// task-89 P2-2（M5 变异洞）：门槛必须**服务端现算**，请求体里的 agentPaused 一律无效。
// 变异「改成读 body.agentPaused」在旧套件下 gate 12/12 + wiring 27/27 全绿 ⇒ 是测试洞。
// 这里在「巡逻未暂停」的实例上注入 agentPaused:true，两个写入口都必须 409 且不改磁盘 auth 文件。
test('T3b 请求体注入 agentPaused 不得绕过门槛（服务端现算，且不写 auth 文件）', async () => {
  const notPaused = await boot({ paused: false });
  try {
    const fake = { password: PASSWORD, agentPaused: { backgroundPatrol: true, socialV2: true }, agentPausedAll: true, paused: true };
    const setup = await request(notPaused.port, { method: 'POST', pathname: `${COLUMN_PATH}/auth/setup`, body: fake });
    assert.equal(setup.status, 409, `setup 必须拒绝：${setup.text}`);
    assert.equal(setup.json?.reason, 'agent-not-paused');
    assert.deepEqual(setup.json?.agentPaused, { backgroundPatrol: false, socialV2: false }, '回报的暂停状态必须是服务端事实');
    assert.equal(setup.headers['set-cookie'], undefined, '被拒的 setup 不得签发会话');

    const reset = await request(notPaused.port, { method: 'POST', pathname: `${COLUMN_PATH}/auth/forgot-reset`, body: fake });
    assert.equal(reset.status, 409, `forgot-reset 必须拒绝：${reset.text}`);
    assert.equal(reset.json?.reason, 'agent-not-paused');

    const st = await request(notPaused.port, { pathname: `${COLUMN_PATH}/auth/status` });
    assert.equal(st.json?.state, 'unset', '被拒的两个入口都不得创建/覆盖密码文件');
    assert.equal(st.json?.session?.valid, false);
  } finally {
    await notPaused.close();
  }
});

// task-90 P2-1（M5c 变异洞）：门槛分离的**反向**用例。
// 变异「setup 门槛放宽成 backgroundPatrol || socialV2」在旧套件下 gate/auth/wiring 全绿——
// 因为没有用例覆盖「巡逻未暂停、只有 socialV2 暂停」这一格。它只证明仓库缺该用例（不代表生产语义错），
// 但 setup 只看巡逻是规格 §2.2 的硬要求，必须钉住。
test('T3c 只有 socialV2 暂停、巡逻仍在运行 ⇒ setup 必须放行（m30623 口径）', async () => {
  const onlySocialPaused = await boot({ paused: false, socialPaused: true });
  try {
    const st0 = await request(onlySocialPaused.port, { pathname: `${COLUMN_PATH}/auth/status` });
    assert.deepEqual(st0.json?.agentPaused, { backgroundPatrol: false, socialV2: true }, '前置条件：只有 socialV2 暂停');

    const setup = await request(onlySocialPaused.port, { method: 'POST', pathname: `${COLUMN_PATH}/auth/setup`, body: { password: PASSWORD } });
    assert.equal(setup.status, 200, `setup 必须放行（门槛只看 socialV2）：${setup.text}`);
    assert.equal(setup.json?.ok, true);
    assert.ok(cookieFrom(setup), '放行的 setup 必须签发会话');
  } finally {
    await onlySocialPaused.close();
  }
});

test('T10 连续错误 5 次后锁定；第 6 次正确密码仍拒且带 lockedSeconds', async () => {
  const locked = await boot({ paused: true, socialPaused: true });
  try {
    const setup = await request(locked.port, { method: 'POST', pathname: `${COLUMN_PATH}/auth/setup`, body: { password: PASSWORD } });
    assert.equal(setup.status, 200, setup.text);
    // 前 4 次是普通错误（400）；第 5 次达到阈值，按模块语义直接进入锁定（423）。
    for (let i = 0; i < 4; i += 1) {
      const bad = await request(locked.port, { method: 'POST', pathname: `${COLUMN_PATH}/auth/verify`, body: { password: `wrong-password-${i}` } });
      assert.equal(bad.status, 400, `第 ${i + 1} 次错误密码：${bad.text}`);
    }
    const fifth = await request(locked.port, { method: 'POST', pathname: `${COLUMN_PATH}/auth/verify`, body: { password: 'wrong-password-4' } });
    assert.equal(fifth.status, 423, fifth.text);
    assert.equal(fifth.json?.reason, 'locked');
    const st = await request(locked.port, { pathname: `${COLUMN_PATH}/auth/status` });
    assert.equal(st.json?.state, 'locked');
    assert.ok(Number(st.json?.lockedSeconds) > 0, st.text);
    const good = await request(locked.port, { method: 'POST', pathname: `${COLUMN_PATH}/auth/verify`, body: { password: PASSWORD } });
    assert.equal(good.status, 423, good.text);
    assert.equal(good.json?.reason, 'locked');
    assert.ok(Number(good.json?.lockedSeconds) > 0, good.text);
  } finally {
    await locked.close();
  }
});
