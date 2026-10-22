// 时机驱动的自主逛贴吧（巡逻，t79）离线测试：策略（tieba-lib）+ 接线（真桥接端点，VM 夹具）。
//
// 覆盖用户确认的八条规则（对应任务里的 ①~⑧）：
//   ① 每日 12 次上限：第 13 次返回 PATROL_DAILY_CAP（纯闸门 + 真端点各测一次）；
//   ② 次日重置：跨自然日再访问 ⇒ 计数从 1 重新开始（注入 now）；
//   ③ 巡逻读帖被钳到前两页、用户指定不钳制（真端点 + 纯函数）；
//   ④ socialV2.patrol.enabled=false ⇒ PATROL_DISABLED（用户指定仍可用）；
//   ⑤ 静默时段内 patrol 被拒、user 不受影响；
//   ⑥ 抓取层节流照旧（≥3 秒 / 每分钟 ≤6 次 / 撞验证页冷却 10 分钟），且巡逻路径不绕过它；
//   ⑦ patrol-log.jsonl 每行结构正确（含 cap 使用量），bridge.log 有摘要行；
//   ⑧ reason 缺省按 patrol 处理。
//
// 全程离线：不连贴吧/百度/QQ，不读仓库 config.json，不碰线上 state/。真桥接端点跑在**临时目录**
// （scripts/audit-bridge-harness.mjs），贴吧抓取层被替换成假抓取器；夹具里的吧名/tid/话题都是编的。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { z } from 'zod';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import * as tiebaLib from '../src/tieba-lib.js';
import {
  PATROL_DEFAULTS,
  PATROL_CODE_DAILY_CAP,
  PATROL_CODE_DISABLED,
  PATROL_CODE_QUIET_HOURS,
  createTiebaPatrolGate,
  normalizePatrolConfig,
  normalizePatrolReason,
  patrolDayKey,
  patrolTimestamp,
  isPatrolQuietHour,
  planPatrolThreadPages,
  buildPatrolLogEntry,
  formatPatrolLogSummary,
  createTiebaLimiter,
  fetchThreadPage
} from '../src/tieba-lib.js';

let failures = 0;
let passed = 0;
async function test(name, run) {
  const t0 = Date.now();
  try {
    await run();
    passed += 1;
    console.log(`✅ ${name}（${Date.now() - t0}ms）`);
  } catch (error) {
    failures += 1;
    console.error(`❌ ${name}（${Date.now() - t0}ms）\n   ${error?.stack ?? error?.message ?? error}`);
  }
}

// ── 假时钟：本地时间构造，避免测试受时区/机器时间影响 ──────────────────────
/** 用本地时间造一个毫秒时间戳（`month` 从 1 开始）。 */
function localMs(y, mo, d, h = 12, mi = 0) {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

// ── 假抓取器（贴吧抓取层被替换，测试只关心接线与闸门）──────────────────────
function fakeThreadPage(tid, page) {
  return { ok: true, url: `https://tieba.invalid/mo/q/m?kz=${tid}&pn=${(Number(page) || 1) - 1}`, data: { tid: String(tid), blocked: false, posts: [] }, text: '【贴吧帖子】fixture 正文' };
}
function fakeThreadPages(tid, opts = {}) {
  const pages = Array.isArray(opts.pages)
    ? opts.pages
    : String(opts.pages ?? '1').split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
  return {
    ok: true,
    url: 'https://tieba.invalid/mo/q/m?kz=fixture',
    pages,
    fetchedPages: pages,
    truncated: opts.maxPages !== undefined && pages.length > Number(opts.maxPages),
    failures: [],
    data: { tid: String(tid), blocked: false, posts: [] },
    text: '【贴吧帖子】fixture 正文'
  };
}
function fakeBarPage(bar, page) {
  return { ok: true, url: `https://tieba.invalid/mo/q/m?kw=${bar}&pn=0`, data: { bar: String(bar), blocked: false, threads: [] }, text: '【贴吧】fixture 吧页' };
}

// ── 临时目录里的真桥接 + 假抓取器 ──────────────────────────────────────────
async function patrolHarness({ config = {}, capture = {}, overrides = {} } = {}) {
  const h = await bridgeHarness({
    config: { socialV2: { tools: { tiebaList: true, tiebaRead: true }, ...(config.socialV2 ?? {}) }, ...config },
    globals: {
      fetchBarPage: async (bar, page) => { capture.bar = { bar, page }; return fakeBarPage(bar, page); },
      fetchThreadPage: async (tid, page) => { capture.thread = { tid, page }; return fakeThreadPage(tid, page); },
      fetchThreadPages: async (tid, opts) => { capture.threadPages = { tid, opts: { ...opts } }; return fakeThreadPages(tid, opts); },
      ...overrides
    }
  });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  return {
    h,
    port,
    capture,
    get: (pathname) => httpGet(port, pathname),
    patrolLog: () => readPatrolLog(h.temp),
    bridgeLog: () => { try { return fs.readFileSync(path.join(h.temp, 'state', 'bridge.log'), 'utf8'); } catch { return ''; } },
    async close() { await new Promise((resolve) => server.close(resolve)); await h.close(); }
  };
}

function httpGet(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch { parsed = { raw: body }; }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('request hung')));
    request.end();
  });
}

/** 读临时 state 下的巡逻日志（每行一个 JSON）。文件不存在返回空数组。 */
function readPatrolLog(temp) {
  const file = path.join(temp, 'state', 'patrol-log.jsonl');
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const THREAD_Q = (extra = {}) => {
  const q = new URLSearchParams({ key: 'group:456', tid: '11000000002', token: 'fixture-console-token' });
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) q.set(k, String(v));
  return `/api/socialV2/tieba/thread?${q.toString()}`;
};
const BAR_Q = (extra = {}) => {
  const q = new URLSearchParams({ key: 'group:456', bar: '示例吧', token: 'fixture-console-token' });
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) q.set(k, String(v));
  return `/api/socialV2/tieba/bar?${q.toString()}`;
};

// ── ① 纯闸门：每日 12 次上限 / 计数 / 用户不计数 ───────────────────────────
await test('① 纯闸门：巡逻默认上限 12 次，第 13 次返回 PATROL_DAILY_CAP', () => {
  const gate = createTiebaPatrolGate({ config: PATROL_DEFAULTS });
  const t = localMs(2026, 10, 8, 12, 0);
  for (let i = 1; i <= 12; i += 1) {
    const r = gate.request({ reason: 'patrol', at: t + i * 1000 });
    assert.equal(r.ok, true, `第 ${i} 次应放行`);
    assert.equal(r.capUsed, i, `第 ${i} 次放行后 capUsed=${i}`);
    assert.equal(r.cap, 12);
  }
  const denied = gate.request({ reason: 'patrol', at: t + 13000 });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, PATROL_CODE_DAILY_CAP);
  assert.equal(denied.error, '今日自主访问已达 12 次上限；如确需继续，请让用户明确要求');
  assert.equal(denied.capUsed, 12, '被拒时计数不再增长');
  assert.equal(denied.patrolled, true);
});

await test('①b 纯闸门：配置上限为 N 时第 N+1 次被拒，错误文案带真实上限', () => {
  const gate = createTiebaPatrolGate({ config: { dailyVisitCap: 2 } });
  const t = localMs(2026, 10, 8, 12, 0);
  assert.equal(gate.request({ reason: 'patrol', at: t }).ok, true);
  assert.equal(gate.request({ reason: 'patrol', at: t + 1000 }).ok, true);
  const third = gate.request({ reason: 'patrol', at: t + 2000 });
  assert.equal(third.code, PATROL_CODE_DAILY_CAP);
  assert.equal(third.error, '今日自主访问已达 2 次上限；如确需继续，请让用户明确要求');
});

await test('①c 纯闸门：用户明确要求不计数、不受限（20 次 user 之后巡逻仍是第 1 次）', () => {
  const gate = createTiebaPatrolGate({ config: { dailyVisitCap: 12 } });
  const t = localMs(2026, 10, 8, 12, 0);
  for (let i = 0; i < 20; i += 1) {
    const r = gate.request({ reason: 'user', at: t + i * 1000 });
    assert.equal(r.ok, true);
    assert.equal(r.patrolled, false);
    assert.equal(r.capUsed, 0, 'user 访问不占名额');
  }
  assert.equal(gate.usedToday(t + 21000), 0);
  const first = gate.request({ reason: 'patrol', at: t + 22000 });
  assert.equal(first.ok, true);
  assert.equal(first.capUsed, 1);
});

// ── ② 次日重置 ────────────────────────────────────────────────────────────
await test('② 纯闸门：每日上限按自然日重置（跨日后再访问 ⇒ 计数从 1 开始）', () => {
  const gate = createTiebaPatrolGate({ config: { dailyVisitCap: 2 } });
  // 23:50 起算：两次访问都还在当天；第三次跨到次日才发生。
  const day1 = localMs(2026, 10, 8, 23, 50);
  assert.equal(gate.request({ reason: 'patrol', at: day1 }).ok, true);
  assert.equal(gate.request({ reason: 'patrol', at: day1 + 1000 }).ok, true);
  assert.equal(gate.request({ reason: 'patrol', at: day1 + 2000 }).code, PATROL_CODE_DAILY_CAP);
  // 跨过午夜（本地时间 2026-10-09 00:00 之后）：新的一天，计数归零。
  const day2 = localMs(2026, 10, 9, 0, 1);
  assert.notEqual(patrolDayKey(day1), patrolDayKey(day2));
  const fresh = gate.request({ reason: 'patrol', at: day2 });
  assert.equal(fresh.ok, true, '次日应重新放行');
  assert.equal(fresh.capUsed, 1, '次日计数从 1 开始');
  assert.equal(gate.usedToday(day2), 1);
});

// ── ③ 页数预算：巡逻只给前两页 ─────────────────────────────────────────────
await test('③ 纯函数：巡逻读帖只给前 maxPagesPerThread 页（第 3 页起没有预算）', () => {
  const wide = planPatrolThreadPages('1-5');
  assert.deepEqual(wide.pages, [1, 2]);
  assert.equal(wide.truncated, true);
  assert.deepEqual(wide.droppedPages, [3, 4, 5]);
  assert.match(wide.note, /最多读前 2 页/);
  assert.match(wide.note, /继续读/);

  assert.deepEqual(planPatrolThreadPages(undefined).pages, [1], '缺省单页 ⇒ 第 1 页');
  assert.deepEqual(planPatrolThreadPages('2').pages, [2], '请求第 2 页仍在预算内');
  assert.deepEqual(planPatrolThreadPages('3').pages, [1], '只请求第 3 页 ⇒ 没有预算，退回第 1 页');
  assert.equal(planPatrolThreadPages('3').truncated, true);
  assert.deepEqual(planPatrolThreadPages('1,2').pages, [1, 2]);
  assert.equal(planPatrolThreadPages('1,2').note, '', '预算内不该出现钳制说明');
  assert.deepEqual(planPatrolThreadPages('2-4', { maxPagesPerThread: 3 }).pages, [2, 3], '上限可配');
});

// ── ④ 总开关 ──────────────────────────────────────────────────────────────
await test('④ 纯闸门：enabled=false ⇒ 巡逻 PATROL_DISABLED，用户指定仍可用', () => {
  const gate = createTiebaPatrolGate({ config: { enabled: false } });
  const t = localMs(2026, 10, 8, 12, 0);
  const denied = gate.request({ reason: 'patrol', at: t });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, PATROL_CODE_DISABLED);
  assert.match(denied.error, /用户明确要求/);
  const user = gate.request({ reason: 'user', at: t });
  assert.equal(user.ok, true, '关掉巡逻不等于禁用工具：用户指定照旧');
  assert.equal(user.capUsed, 0);
});

await test('④b 配置归一：非法值回默认，cap=0 是合法值（自主访问一律拒绝）', () => {
  assert.deepEqual(normalizePatrolConfig(undefined), { ...PATROL_DEFAULTS, quietHours: [...PATROL_DEFAULTS.quietHours] });
  const bad = normalizePatrolConfig({ dailyVisitCap: 'x', maxPagesPerThread: -3, quietHours: ['a', 'b'], enabled: 'yes' });
  assert.equal(bad.dailyVisitCap, 12);
  assert.equal(bad.maxPagesPerThread, 2);
  assert.deepEqual(bad.quietHours, [1, 8]);
  assert.equal(bad.enabled, true, '只有明确的 false 才算关闭');
  assert.equal(normalizePatrolConfig({ dailyVisitCap: 0 }).dailyVisitCap, 0);
  const gate = createTiebaPatrolGate({ config: { dailyVisitCap: 0 } });
  assert.equal(gate.request({ reason: 'patrol', at: localMs(2026, 10, 8, 12, 0) }).code, PATROL_CODE_DAILY_CAP);
});

// ── ⑤ 静默时段 ────────────────────────────────────────────────────────────
await test('⑤ 静默时段 01:00–08:00：patrol 被拒，user 不受影响', () => {
  assert.equal(isPatrolQuietHour(localMs(2026, 10, 8, 0, 59)), false, '00:59 还没静默');
  assert.equal(isPatrolQuietHour(localMs(2026, 10, 8, 1, 0)), true, '01:00 起静默（含起点）');
  assert.equal(isPatrolQuietHour(localMs(2026, 10, 8, 7, 59)), true);
  assert.equal(isPatrolQuietHour(localMs(2026, 10, 8, 8, 0)), false, '08:00 已放行（不含终点）');
  assert.equal(isPatrolQuietHour(localMs(2026, 10, 8, 12, 0), [23, 7]), false, '跨零点区间：中午不静默');
  assert.equal(isPatrolQuietHour(localMs(2026, 10, 8, 23, 30), [23, 7]), true, '跨零点区间：23:30 静默');

  const gate = createTiebaPatrolGate({ config: PATROL_DEFAULTS });
  const quiet = localMs(2026, 10, 8, 3, 0);
  const denied = gate.request({ reason: 'patrol', at: quiet });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, PATROL_CODE_QUIET_HOURS);
  assert.match(denied.error, /静默时段/);
  assert.equal(gate.usedToday(quiet), 0, '静默时段被拒不计次');
  const user = gate.request({ reason: 'user', at: quiet });
  assert.equal(user.ok, true, '用户指定不受静默时段限制');
});

// ── ⑧ reason 缺省按 patrol ─────────────────────────────────────────────────
await test('⑧ reason 归一：缺省/空/拼错一律按 patrol（保守），只有明确的 user 才算用户指定', () => {
  for (const raw of [undefined, null, '', '   ', 'patrol', 'PATROL', 'wat', '0', 'USER ', 'User']) {
    const expected = String(raw ?? '').trim().toLowerCase() === 'user' ? 'user' : 'patrol';
    assert.equal(normalizePatrolReason(raw), expected, `raw=${JSON.stringify(raw)}`);
  }
  assert.equal(normalizePatrolReason('user'), 'user');
  const gate = createTiebaPatrolGate({ config: { dailyVisitCap: 1 } });
  const t = localMs(2026, 10, 8, 12, 0);
  assert.equal(gate.request({ at: t }).ok, true, '不传 reason ⇒ 按 patrol 放行并计数');
  assert.equal(gate.request({ at: t + 1000 }).code, PATROL_CODE_DAILY_CAP, '不传 reason ⇒ 一样吃上限');
});

// ── ⑦ 日志行 ──────────────────────────────────────────────────────────────
await test('⑦ 日志行结构：ts/key/reason/action/bar|tid/pages/outcome/capUsed/cap（bar 与 tid 互斥）', () => {
  const entry = buildPatrolLogEntry({
    at: localMs(2026, 10, 8, 21, 3),
    key: 'group:456',
    reason: 'patrol',
    action: 'thread',
    tid: '11000000002',
    pages: [1, 2],
    outcome: 'silent',
    capUsed: 3,
    cap: 12,
    trigger: '群里在聊  示例话题\n第二行'
  });
  assert.deepEqual(Object.keys(entry), ['ts', 'key', 'reason', 'action', 'tid', 'pages', 'outcome', 'capUsed', 'cap', 'trigger']);
  assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/, `ts 要带本地时区偏移：${entry.ts}`);
  assert.deepEqual(entry.pages, [1, 2]);
  assert.equal(entry.trigger, '群里在聊 示例话题 第二行', 'trigger 压成单行');
  assert.equal('bar' in entry, false, 'tid 访问不该同时出现 bar');
  const barEntry = buildPatrolLogEntry({ at: Date.now(), key: 'group:456', reason: 'user', action: 'bar', bar: '示例吧', pages: [1], outcome: 'blocked', capUsed: 0, cap: 12 });
  assert.deepEqual(Object.keys(barEntry), ['ts', 'key', 'reason', 'action', 'bar', 'pages', 'outcome', 'capUsed', 'cap']);
  assert.equal(barEntry.reason, 'user');
  assert.equal('tid' in barEntry, false);
  assert.equal(JSON.stringify(barEntry).includes('\n'), false, '一行必须是一个 JSON');
  assert.match(formatPatrolLogSummary(entry), /自主逛贴吧 · group:456 · 发起=patrol/);
  assert.match(formatPatrolLogSummary(barEntry), /发起=user/);
  // 畸形输入不抛
  assert.equal(typeof buildPatrolLogEntry({}).ts, 'string');
  assert.equal(typeof formatPatrolLogSummary(null), 'string');
});

// ── ⑥ 抓取层节流：与发起方无关，巡逻不绕过 ────────────────────────────────
await test('⑥ 抓取节流：≥3 秒 / 每分钟 ≤6 次 / 撞验证页冷却 10 分钟（注入 now）', async () => {
  const limiter = createTiebaLimiter();
  const t = localMs(2026, 10, 8, 12, 0);
  assert.equal(limiter.allow(t).ok, true);
  const tooFast = limiter.allow(t + 2000);
  assert.equal(tooFast.ok, false);
  assert.equal(tooFast.reason, 'too-fast');
  assert.equal(tooFast.waitMs, 1000);
  assert.equal(limiter.allow(t + 3000).ok, true);

  const burst = createTiebaLimiter();
  const t2 = localMs(2026, 10, 8, 13, 0);
  for (let i = 0; i < 6; i += 1) assert.equal(burst.allow(t2 + i * 5000).ok, true, `第 ${i + 1} 次应放行`);
  const over = burst.allow(t2 + 31_000);
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'rate-limited');

  const blocked = createTiebaLimiter();
  assert.equal(blocked.allow(t).ok, true);
  blocked.noteBlocked(t);
  const cooling = blocked.allow(t + 60_000);
  assert.equal(cooling.ok, false);
  assert.equal(cooling.reason, 'blocked-cooldown');
  assert.equal(blocked.allow(t + 11 * 60_000).ok, true, '10 分钟冷却过后恢复');

  // 真抓取函数被节流时的**返回形状**：桥接据此把 outcome 记成 `throttled`（而不是 failed）。
  const limiter2 = createTiebaLimiter();
  const t3 = localMs(2026, 10, 8, 14, 0);
  let fetched = 0;
  const fetchText = async (url) => { fetched += 1; return '<!-- fixture -->'; };
  const call = (at) => fetchThreadPage('11000000002', 1, { limiter: limiter2, now: at, fetchText, searchFetch: async () => { throw new Error('fixture: search off'); } });
  assert.equal((await call(t3)).ok, true);
  const throttled = await call(t3 + 1000);
  assert.equal(throttled.ok, false);
  assert.equal(throttled.throttled, true);
  assert.equal(fetched, 1, '被节流时不再发贴吧请求');
});

await test('⑥b 巡逻路径没有自己的节流旁路：桥接不改写 limiter、不新增定时器', () => {
  const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  // 巡逻只用 tieba-lib 的默认节流实例（不传 `limiter:`）——传一份自己的账本＝绕过 3 秒/每分钟 6 次。
  const patrolBlock = source.slice(source.indexOf('function beginTiebaPatrol'), source.indexOf('function finishTiebaPatrol'));
  assert.ok(patrolBlock.length > 0, '应能取到巡逻闸门函数');
  assert.equal(/limiter\s*:/.test(patrolBlock), false, '巡逻闸门不许自带 limiter');
  const endpoints = source.slice(source.indexOf("url.pathname === '/api/socialV2/tieba/bar'"), source.indexOf("url.pathname === '/api/socialV2/mark-read'"));
  assert.equal(/limiter\s*:/.test(endpoints), false, '两个贴吧端点都不许传自定义 limiter');
  // 规则 1：只做时机驱动 —— 巡逻这一段不许出现任何定时器。
  const patrolHelpers = source.slice(source.indexOf('// ── 时机驱动的自主逛贴吧（巡逻，t79）'), source.indexOf('function startConsoleServer()'));
  assert.equal(/setInterval|setTimeout/.test(patrolHelpers), false, '巡逻功能不许新增定时器');
});

// ── 真端点接线（临时目录里的真桥接 + 假抓取器）────────────────────────────
await test('③b 端点：reason=patrol 时读帖被钳到前两页（并如实说明），响应里给出 clampedPages', async () => {
  const t = await patrolHarness();
  try {
    const res = await t.get(THREAD_Q({ pages: '1-5', reason: 'patrol', trigger: '群里在聊示例话题' }));
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual([...t.capture.threadPages.opts.pages], [1, 2], '巡逻只该抓前两页');
    assert.equal(res.body.truncated, true);
    assert.deepEqual(res.body.patrol.clampedPages, [1, 2]);
    assert.equal(res.body.patrol.reason, 'patrol');
    assert.equal(res.body.patrol.capUsed, 1);
    assert.equal(res.body.patrol.cap, 12);
    assert.match(res.body.text, /巡逻单次最多读前 2 页/, '钳制必须如实写在正文里');
  } finally { await t.close(); }
});

await test('③c 端点：reason=user 不钳制页数、不计数', async () => {
  const t = await patrolHarness();
  try {
    const res = await t.get(THREAD_Q({ pages: '1-5', reason: 'user' }));
    assert.equal(res.status, 200);
    assert.equal(t.capture.threadPages.opts.pages, '1-5', '用户指定原样透传');
    assert.equal(t.capture.threadPages.opts.maxPages, undefined);
    assert.equal(res.body.patrol.reason, 'user');
    assert.equal(res.body.patrol.capUsed, 0);
    assert.equal(/巡逻单次最多读前/.test(res.body.text), false, '用户指定不该出现巡逻钳制说明');
  } finally { await t.close(); }
});

await test('③d 端点：巡逻单页请求仍走原单页入口（未钳制时路由与改动前一致）', async () => {
  const t = await patrolHarness();
  try {
    const single = await t.get(THREAD_Q({ reason: 'patrol', page: 2 }));
    assert.equal(single.status, 200);
    assert.ok(t.capture.thread, '单页巡逻应走 fetchThreadPage');
    assert.equal(t.capture.thread.page, '2');
    assert.equal(t.capture.threadPages, undefined, '预算内不该走多页入口');
    assert.equal(single.body.patrol.clampedPages, undefined);
    // 页码超出巡逻预算（第 5 页）⇒ 退回第 1 页并如实说明（走多页入口以免真的去抓第 5 页）
    const out = await t.get(THREAD_Q({ reason: 'patrol', page: 5 }));
    assert.equal(out.status, 200);
    assert.deepEqual([...t.capture.threadPages.opts.pages], [1]);
    assert.match(out.body.text, /这次只读第 1 页/);
  } finally { await t.close(); }
});

await test('①d 端点：dailyVisitCap=2 时第 3 次巡逻被拒（PATROL_DAILY_CAP，HTTP 429）', async () => {
  const t = await patrolHarness({ config: { socialV2: { patrol: { dailyVisitCap: 2 } } } });
  try {
    const first = await t.get(BAR_Q({ reason: 'patrol' }));
    const second = await t.get(THREAD_Q({ reason: 'patrol' }));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.body.patrol.capUsed, 1, '吧页访问也算 1 次');
    assert.equal(second.body.patrol.capUsed, 2);
    const third = await t.get(BAR_Q({ reason: 'patrol' }));
    assert.equal(third.status, 429);
    assert.equal(third.body.ok, false);
    assert.equal(third.body.code, PATROL_CODE_DAILY_CAP);
    assert.equal(third.body.error, '今日自主访问已达 2 次上限；如确需继续，请让用户明确要求');
    // 用户明确要求仍然放行，且**不增加计数**
    const user = await t.get(THREAD_Q({ reason: 'user' }));
    assert.equal(user.status, 200);
    assert.equal(user.body.patrol.capUsed, 2, 'user 访问不占名额');
    const stillDenied = await t.get(THREAD_Q({ reason: 'patrol' }));
    assert.equal(stillDenied.body.code, PATROL_CODE_DAILY_CAP);
  } finally { await t.close(); }
});

await test('⑧b 端点：不带 reason 的调用按 patrol 处理（一样吃上限）', async () => {
  const t = await patrolHarness({ config: { socialV2: { patrol: { dailyVisitCap: 1 } } } });
  try {
    const first = await t.get(THREAD_Q());
    assert.equal(first.status, 200);
    assert.equal(first.body.patrol.reason, 'patrol');
    assert.equal(first.body.patrol.capUsed, 1);
    const second = await t.get(THREAD_Q());
    assert.equal(second.status, 429);
    assert.equal(second.body.code, PATROL_CODE_DAILY_CAP);
  } finally { await t.close(); }
});

await test('④c 端点：patrol.enabled=false ⇒ PATROL_DISABLED（用户指定仍可用）', async () => {
  const t = await patrolHarness({ config: { socialV2: { patrol: { enabled: false } } } });
  try {
    const denied = await t.get(THREAD_Q({ reason: 'patrol' }));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, PATROL_CODE_DISABLED);
    const user = await t.get(THREAD_Q({ reason: 'user' }));
    assert.equal(user.status, 200, '关掉巡逻不等于禁用工具');
    assert.equal(user.body.patrol.reason, 'user');
  } finally { await t.close(); }
});

await test('④d 端点：控制台那一行（tools.patrol=false）也能关掉自主巡逻', async () => {
  const t = await patrolHarness({ config: { socialV2: { tools: { tiebaList: true, tiebaRead: true, patrol: false } } } });
  try {
    const denied = await t.get(THREAD_Q({ reason: 'patrol' }));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, PATROL_CODE_DISABLED);
    const user = await t.get(THREAD_Q({ reason: 'user' }));
    assert.equal(user.status, 200);
  } finally { await t.close(); }
});

await test('⑤b 端点：静默时段内 patrol 被拒（403 / PATROL_QUIET_HOURS），user 照旧放行', async () => {
  // 把静默时段设成全天：等价于「现在就是静默时段」，不用去改系统时钟。
  const t = await patrolHarness({ config: { socialV2: { patrol: { quietHours: [0, 24] } } } });
  try {
    const denied = await t.get(THREAD_Q({ reason: 'patrol' }));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, PATROL_CODE_QUIET_HOURS);
    assert.match(denied.body.error, /静默时段/);
    const user = await t.get(THREAD_Q({ reason: 'user' }));
    assert.equal(user.status, 200);
    assert.equal(user.body.patrol.capUsed, 0);
  } finally { await t.close(); }
});

await test('⑦b 端点：patrol-log.jsonl 每行结构正确且含 cap 使用量，bridge.log 有摘要行', async () => {
  const t = await patrolHarness({ config: { socialV2: { patrol: { dailyVisitCap: 1 } } } });
  try {
    assert.deepEqual(t.patrolLog(), [], '还没访问过时不该有日志');
    await t.get(THREAD_Q({ reason: 'patrol', pages: '1-5', trigger: '群里在聊示例话题' }));
    await t.get(THREAD_Q({ reason: 'patrol' }));           // 被上限拒绝 ⇒ 也要有一行
    await t.get(BAR_Q({ reason: 'user' }));                 // 用户指定 ⇒ 记一行 reason=user
    const lines = t.patrolLog();
    assert.equal(lines.length, 3, `三次访问应有三行，实际 ${lines.length}`);
    for (const line of lines) {
      for (const key of ['ts', 'key', 'reason', 'action', 'pages', 'outcome', 'capUsed', 'cap']) {
        assert.ok(Object.hasOwn(line, key), `每行都要有 ${key}：${JSON.stringify(line)}`);
      }
      assert.ok(Object.hasOwn(line, 'bar') || Object.hasOwn(line, 'tid'), 'bar 与 tid 至少有一个');
      assert.equal(typeof line.ts, 'string');
      assert.equal(line.key, 'group:456');
      assert.ok(Array.isArray(line.pages));
      assert.equal(typeof line.capUsed, 'number');
      assert.equal(line.cap, 1, 'cap 使用量要如实写当日上限');
    }
    assert.deepEqual(lines.map((l) => l.outcome), ['silent', 'rejected', 'silent']);
    assert.deepEqual(lines.map((l) => l.reason), ['patrol', 'patrol', 'user']);
    assert.deepEqual(lines.map((l) => l.action), ['thread', 'thread', 'bar']);
    assert.deepEqual(lines[0].pages, [1, 2], '日志里记的是**真的去抓**的页码');
    assert.equal(lines[0].capUsed, 1);
    assert.equal(lines[1].capUsed, 1, '被拒时 capUsed 不再增长');
    assert.equal(lines[2].bar, '示例吧');
    assert.equal(lines[2].capUsed, 1, 'user 访问不占名额');
    assert.equal(lines[0].trigger, '群里在聊示例话题');
    const human = t.bridgeLog();
    assert.match(human, /🀄 自主逛贴吧 · group:456 · 发起=patrol/);
    assert.match(human, /今日第 1\/1 次/);
  } finally { await t.close(); }
});

await test('⑦c 端点：被拦（安全验证）与总开关关闭分别记 blocked / disabled', async () => {
  const blockedHarness = await patrolHarness({
    overrides: {
      fetchThreadPage: async (tid, page) => ({
        ok: true,
        url: 'https://tieba.invalid/mo/q/m?kz=fixture',
        data: { tid: String(tid), blocked: true, posts: [] },
        blocked: true,
        text: '【贴吧帖子】fixture：被百度安全验证拦住'
      })
    }
  });
  try {
    await blockedHarness.get(THREAD_Q({ reason: 'patrol' }));
    assert.deepEqual(blockedHarness.patrolLog().map((l) => l.outcome), ['blocked']);
    assert.match(blockedHarness.bridgeLog(), /结果=blocked/);
  } finally { await blockedHarness.close(); }

  const offHarness = await patrolHarness({ config: { socialV2: { patrol: { enabled: false } } } });
  try {
    await offHarness.get(THREAD_Q({ reason: 'patrol' }));
    assert.deepEqual(offHarness.patrolLog().map((l) => l.outcome), ['disabled']);
  } finally { await offHarness.close(); }
});

await test('⑦d 端点：巡逻之后真的发言 ⇒ 那一行的 outcome 由 silent 改写成 spoke（不新增行）', async () => {
  const t = await patrolHarness();
  try {
    await t.get(THREAD_Q({ reason: 'patrol' }));
    assert.deepEqual(t.patrolLog().map((l) => l.outcome), ['silent']);
    t.h.recordSentMessagesV2('group:456', ['我看完了，还行']);
    const lines = t.patrolLog();
    assert.equal(lines.length, 1, '改写而不是新增一行');
    assert.equal(lines[0].outcome, 'spoke');
    assert.equal(lines[0].capUsed, 1, '改写不能丢字段');
    // 别的会话发言不该改写这一行
    await t.get(THREAD_Q({ key: 'group:456', reason: 'patrol' }));
    t.h.recordSentMessagesV2('private:123', ['无关会话']);
    assert.deepEqual(t.patrolLog().map((l) => l.outcome), ['spoke', 'silent']);
  } finally { await t.close(); }
});

// ── 配置默认值（旧 config.json 缺这一节时也不能丢）────────────────────────
await test('配置：socialV2.patrol 默认值与 tieba-lib 的 PATROL_DEFAULTS 一致，旧 config.json 缺这一节照样生效', async () => {
  const t = await patrolHarness();
  try {
    const patrol = t.h.cfg.socialV2.patrol;
    // 桥接的默认表是**字面量**（理由见 bridge.js 里那段注释），所以这里必须钉住两边一致：
    // 一旦有人只改一边，「策略默认 12 次、配置默认 20 次」这种漂移会静默生效。
    assert.equal(patrol.enabled, PATROL_DEFAULTS.enabled);
    assert.equal(patrol.dailyVisitCap, PATROL_DEFAULTS.dailyVisitCap);
    assert.equal(patrol.maxPagesPerThread, PATROL_DEFAULTS.maxPagesPerThread);
    assert.deepEqual([...patrol.quietHours], [...PATROL_DEFAULTS.quietHours]);
    assert.equal(t.h.cfg.socialV2.tools.patrol, true, '控制台那一行默认开');
  } finally { await t.close(); }
});

// ── MCP 侧透传（reason / trigger / 巡逻页数预算下的超时）────────────────────
/**
 * 用假 transport 加载真的 `src/mcp-snowluma-safe.js`，拿到 qq_tieba_list / qq_tieba_read 的
 * **真实回调**（与 scripts/test-tieba-lib.mjs 的加载方式同源）：断言的是「参数怎么进 URL、
 * 超时怎么算」这两件接线事实，不是 MCP 库本身。
 */
async function loadTiebaTools({ patrolMaxPages } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-patrol-mcp-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    socialV2: patrolMaxPages === undefined ? {} : { patrol: { maxPagesPerThread: patrolMaxPages } }
  }));
  const tools = new Map();
  const calls = { urls: [], timeouts: [] };
  const source = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('const __dirname = path.dirname(fileURLToPath(import.meta.url));', `const __dirname = ${JSON.stringify(path.join(dir, 'src'))};`)
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());')
    .replace("import('./tieba-lib.js')", 'Promise.resolve(__tiebaLib)');
  class McpServer {
    constructor() {}
    tool(name, description, schema, callback) { tools.set(name, { description, schema, callback }); }
    connect() {}
  }
  vm.runInNewContext(source, {
    McpServer,
    StdioServerTransport: class {},
    z,
    URL,
    URLSearchParams,
    path,
    fs,
    Buffer,
    process,
    console,
    setTimeout,
    clearTimeout,
    SENSITIVE_RE: { test: () => false },
    serializeModelData: (value) => JSON.stringify(value),
    AbortSignal: { timeout: (ms) => { calls.timeouts.push(ms); return AbortSignal.timeout(ms); } },
    fetch: async (url) => { calls.urls.push(String(url)); return Response.json({ ok: true, text: 'fixture 贴吧正文' }); },
    __tiebaLib: tiebaLib
  });
  const call = async (name, args) => {
    const tool = tools.get(name);
    assert.ok(tool, `${name} 必须注册`);
    return { result: await tool.callback(z.object(tool.schema).parse(args)), tool };
  };
  return { call, calls, tools, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

await test('MCP：qq_tieba_read/list 接受 reason 与 trigger，并原样带进桥接 URL', async () => {
  const m = await loadTiebaTools();
  try {
    const read = await m.call('qq_tieba_read', { key: 'group:456', token: 'fixture-token', tid: '11000000002', pages: '1-5', reason: 'patrol', trigger: '群里在聊示例话题' });
    const readUrl = new URL(m.calls.urls.at(-1));
    assert.equal(readUrl.searchParams.get('reason'), 'patrol');
    assert.equal(readUrl.searchParams.get('trigger'), '群里在聊示例话题');
    assert.equal(readUrl.searchParams.get('pages'), '1-5', 'pages 原样交给桥接（钳制在桥接侧做）');
    assert.ok(read.result.content[0].text.startsWith('fixture 贴吧正文'), '桥接 text 原样透传（后面可能追加图片说明）');

    const list = await m.call('qq_tieba_list', { key: 'group:456', token: 'fixture-token', bar: '示例吧', reason: 'user' });
    const listUrl = new URL(m.calls.urls.at(-1));
    assert.equal(listUrl.searchParams.get('reason'), 'user');
    assert.equal(listUrl.searchParams.get('trigger'), null, '没给 trigger 就不该编一个出来');

    // 两个工具的参数说明里都要写清「发起方」这套规矩（模型只看得见 schema 与描述）
    assert.ok(/patrol/.test(m.tools.get('qq_tieba_read').schema.reason.description));
    assert.deepEqual(m.tools.get('qq_tieba_read').schema.reason.unwrap().options, ['patrol', 'user']);
    assert.ok(m.tools.get('qq_tieba_list').description.includes('PATROL_DAILY_CAP'));
    assert.ok(m.tools.get('qq_tieba_read').description.includes('这条帖后面还有料'));
  } finally { m.cleanup(); }
});

await test('MCP：reason=patrol 时等待预算按巡逻页数预算算（不传 reason 时与改动前一致）', async () => {
  const m = await loadTiebaTools({ patrolMaxPages: 3 });
  try {
    await m.call('qq_tieba_read', { key: 'group:456', token: 'fixture-token', tid: '11000000002', pages: '1-10', reason: 'patrol' });
    assert.equal(m.calls.timeouts.at(-1), 60000 + 20000 * 3, '巡逻：60s + 20s × 巡逻页数上限');
    await m.call('qq_tieba_read', { key: 'group:456', token: 'fixture-token', tid: '11000000002', pages: '1-10' });
    assert.equal(m.calls.timeouts.at(-1), 60000 + 20000 * 10, '不传 reason ⇒ 与改动前逐字节一致（10 页 260 秒）');
    await m.call('qq_tieba_read', { key: 'group:456', token: 'fixture-token', tid: '11000000002', pages: '1-10', reason: 'user' });
    assert.equal(m.calls.timeouts.at(-1), 60000 + 20000 * 10, 'user ⇒ 不钳制');
  } finally { m.cleanup(); }
});

console.log(`\n${failures === 0 ? '🎉' : '❌'} 巡逻测试：通过 ${passed} 项，失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
