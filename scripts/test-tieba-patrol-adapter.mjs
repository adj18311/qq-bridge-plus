#!/usr/bin/env node
// scripts/test-tieba-patrol-adapter.mjs
//
// 后台巡逻步骤 D：贴吧请求边界钩子 ↔ 5 次/日唯一账本的适配器纯模块测试（task-26）。
//
// 被测：`src/core/tieba-patrol-adapter.mjs`
//   createTiebaPatrolAdapter({ ledger, now?, reasonOf? }) -> onBeforeTiebaRequest 兼容函数
//
// 契约：
//  1) 返回值的调用形态与 `src/tieba-lib.js` 的 onBeforeTiebaRequest 兼容：无参调用、await 后
//     返回 false 或 {ok:false} 表示拒绝（tieba-lib 会阻止抓取），其它值/undefined 表示放行。
//  2) 自主访问（reason='patrol'，缺省）→ 每次**新逻辑请求**调用一次 `ledger.reserve({reason:'patrol'})`；
//     一次多页工具调用（fetchThreadPages）在请求边界只调用一次钩子 ⇒ 账本只 +1。
//  3) user 明确查询（reason='user'）→ 直接放行，**完全不调用 ledger**（不占额度、即使额度已满也放行）。
//  4) 账本返回 daily-cap → 拒绝且可读；经 tieba-lib 时实际抓取 0 次；账本抛错/返回畸形 → fail-closed 拒绝。
//  5) 重试去重：用稳定 operation id（`forOperation({operationId})` 或 hook({operationId})）绑定同一逻辑请求，
//     重复触发同一钩子只扣一次；已拒绝的操作重试仍拒绝且不重复扣。无 operation id 的调用一律视为新请求
//     （保守计次，宁可多计也不因误去重而放行超额度访问）。
//  6) 非法 reason / operationId / context / 时钟 → 抛带 code 错误（tieba-lib 会把它转成拒绝，零抓取）。
//
// 纯离线：ledger 用真实临时目录账本或注入假实现；tieba-lib 的 fetchText/searchFetch/limiter/readFile 全部注入假实现；
// 不联网、不读 Cookie、不访问贴吧、不动 state。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  TIEBA_PATROL_ADAPTER_REASONS,
  TIEBA_PATROL_ADAPTER_MAX_OPERATIONS,
  createTiebaPatrolAdapter,
} from '../src/core/tieba-patrol-adapter.mjs';
import { createTiebaPatrolLedger, TIEBA_PATROL_DAILY_CAP } from '../src/core/tieba-patrol-ledger.mjs';
import { fetchBarPage, fetchThreadPages } from '../src/tieba-lib.js';

const BJT_OFFSET = 8 * 60 * 60 * 1000;

function bjt(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - BJT_OFFSET;
}

const T0 = bjt(2026, 10, 24, 10, 0);
const THREAD_HTML = '<!DOCTYPE html><html><head><title>第1/2页,回贴列表-测试帖子</title></head><body><p>占位帖页</p></body></html>';
const BAR_HTML = '<!DOCTYPE html><html><head><title>原神吧_百度贴吧</title></head><body><p>占位吧页</p></body></html>';

function throwsWithCode(run, expectedCode) {
  try {
    run();
  } catch (error) {
    assert.equal(error.code, expectedCode, `期望 code=${expectedCode}，实际 ${error.code}（${error.message}）`);
    return error;
  }
  assert.fail(`期望抛出 code=${expectedCode} 的错误`);
}

async function rejectsWithCode(operation, expectedCode) {
  try {
    await operation();
  } catch (error) {
    assert.equal(error.code, expectedCode, `期望 code=${expectedCode}，实际 ${error.code}（${error.message}）`);
    return error;
  }
  assert.fail(`期望 promise 以 code=${expectedCode} 拒绝`);
}

/** 真实持久账本（临时目录 + 假时钟）。 */
async function ledgerHarness(t, at = T0) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-tieba-adapter-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'tieba-patrol-ledger.json');
  let now = at;
  const ledger = createTiebaPatrolLedger({ filePath, clock: { now: () => now } });
  await ledger.load();
  return { dir, filePath, ledger, now: () => now, setNow: (value) => { now = value; } };
}

/** 假账本：记录每次 reserve 调用，按 handler 返回结果。 */
function fakeLedger(handler) {
  const calls = [];
  return {
    calls,
    async reserve(request) {
      calls.push(request);
      return handler(request, calls.length);
    },
  };
}

/** 假抓取器：统计真正发出的页请求数。 */
function fakeFetch(events, html = THREAD_HTML, error = null) {
  const calls = [];
  const fetchText = async (url) => {
    calls.push(url);
    events.push('fetch');
    if (error) throw error;
    return html;
  };
  return { calls, fetchText };
}

function fakeLimiter(verdict = { ok: true }) {
  return { allow: () => ({ ...verdict }), noteSuccess() {}, noteBlocked() {}, noteFailure() {} };
}

function threadOptions(fetchText, searchFetch = async () => '') {
  return {
    fetchText,
    searchFetch,
    limiter: fakeLimiter(),
    readFile: () => {
      throw new Error('本测试不应读取任何 Cookie 文件');
    },
    now: T0,
  };
}

test('常量：允许的 reason 与去重操作表上限（冻结）', () => {
  assert.deepEqual([...TIEBA_PATROL_ADAPTER_REASONS], ['patrol', 'user']);
  assert.equal(Object.isFrozen(TIEBA_PATROL_ADAPTER_REASONS), true);
  assert.equal(TIEBA_PATROL_ADAPTER_MAX_OPERATIONS, 256);
});

test('构造校验：必须注入带 reserve 的 ledger；reasonOf 必须是函数或省略', () => {
  assert.throws(() => createTiebaPatrolAdapter(), TypeError);
  assert.throws(() => createTiebaPatrolAdapter({}), TypeError);
  assert.throws(() => createTiebaPatrolAdapter({ ledger: null }), TypeError);
  assert.throws(() => createTiebaPatrolAdapter({ ledger: {} }), TypeError);
  assert.throws(() => createTiebaPatrolAdapter({ ledger: { reserve: 'nope' } }), TypeError);
  assert.throws(() => createTiebaPatrolAdapter({ ledger: { reserve: async () => ({ ok: true }) }, reasonOf: 'patrol' }), TypeError);
});

test('兼容 tieba-lib 钩子：无参调用返回 {ok:true} 放行；每次无参调用都视为新逻辑请求', async (t) => {
  const h = await ledgerHarness(t);
  const hook = createTiebaPatrolAdapter({ ledger: h.ledger });
  assert.equal(typeof hook, 'function');
  assert.equal(typeof hook.forOperation, 'function');

  const first = await hook();
  assert.equal(first.ok, true);
  assert.equal(first.counted, true);
  assert.equal(first.reason, 'patrol');
  assert.equal(first.used, 1);
  assert.equal(first.limit, TIEBA_PATROL_DAILY_CAP);
  assert.equal(first.remaining, 5);
  assert.equal((await hook()).used, 2);
  assert.equal((await h.ledger.snapshot()).used, 2);
});

test('一次多页工具调用只预留一次：fetchThreadPages(pages=1-3) 钩子 1 次、抓 3 页、账本 +1', async (t) => {
  const h = await ledgerHarness(t);
  const adapter = createTiebaPatrolAdapter({ ledger: h.ledger });
  const events = [];
  const fetchFake = fakeFetch(events);

  const first = await fetchThreadPages('9876543210', { ...threadOptions(fetchFake.fetchText), pages: '1-3', onBeforeTiebaRequest: adapter });
  assert.equal(first.ok, true);
  assert.deepEqual(first.fetchedPages, [1, 2, 3]);
  assert.equal(events.filter((event) => event === 'fetch').length, 3);
  assert.equal((await h.ledger.snapshot()).used, 1);

  const second = await fetchThreadPages('9876543210', { ...threadOptions(fakeFetch(events).fetchText), pages: '1', onBeforeTiebaRequest: adapter });
  assert.equal(second.ok, true);
  assert.equal((await h.ledger.snapshot()).used, 2);
});

test('吧页读取与读帖共用同一 5 次日账：fetchBarPage 也算一次', async (t) => {
  const h = await ledgerHarness(t);
  const adapter = createTiebaPatrolAdapter({ ledger: h.ledger });
  const bar = await fetchBarPage('原神', 1, {
    fetchText: fakeFetch([], BAR_HTML).fetchText,
    searchFetch: async () => '',
    onBeforeTiebaRequest: adapter,
    limiter: fakeLimiter(),
    readFile: () => {
      throw new Error('不应读取 Cookie');
    },
    now: T0,
  });
  assert.equal(bar.ok, true);
  assert.equal((await h.ledger.snapshot()).used, 1);
});

test('reason=user：不调用 ledger、不占额度、额度已满也放行并真实抓取', async (t) => {
  const fake = fakeLedger(() => ({ ok: true, counted: true, used: 1, limit: 5, remaining: 4 }));
  const userHook = createTiebaPatrolAdapter({ ledger: fake, reasonOf: () => 'user' });
  assert.equal((await userHook()).counted, false);
  assert.equal((await userHook()).reason, 'user');
  assert.equal(fake.calls.length, 0, 'user 查询绝不能调用 ledger.reserve');

  // 真实账本已满 5 次：user 查询仍允许抓取，且不改变计数。
  const h = await ledgerHarness(t);
  for (let index = 0; index < TIEBA_PATROL_DAILY_CAP; index += 1) await h.ledger.reserve({ reason: 'patrol' });
  assert.equal((await h.ledger.snapshot()).used, TIEBA_PATROL_DAILY_CAP);
  const adapter = createTiebaPatrolAdapter({ ledger: h.ledger, reasonOf: () => 'user' });
  const events = [];
  const result = await fetchThreadPages('9876543210', { ...threadOptions(fakeFetch(events).fetchText), pages: '1', onBeforeTiebaRequest: adapter });
  assert.equal(result.ok, true);
  assert.equal(events.filter((event) => event === 'fetch').length, 1);
  assert.equal((await h.ledger.snapshot()).used, TIEBA_PATROL_DAILY_CAP);
});

test('user 查询连账本故障都不影响：ledger.reserve 抛错也不会被调用', async () => {
  const fake = fakeLedger(() => {
    throw new Error('ledger down');
  });
  const hook = createTiebaPatrolAdapter({ ledger: fake, reasonOf: () => 'user' });
  assert.equal((await hook()).ok, true);
  assert.equal(fake.calls.length, 0);
});

test('自主访问满 6 次：拒绝可读、零抓取、账本不超限', async (t) => {
  const h = await ledgerHarness(t);
  const adapter = createTiebaPatrolAdapter({ ledger: h.ledger });
  for (let index = 0; index < TIEBA_PATROL_DAILY_CAP; index += 1) assert.equal((await adapter()).ok, true);

  const events = [];
  const denied = await fetchThreadPages('9876543210', { ...threadOptions(fakeFetch(events).fetchText), pages: '1-2', onBeforeTiebaRequest: adapter });
  assert.equal(denied.ok, false);
  assert.equal(events.filter((event) => event === 'fetch').length, 0, '被账本拒绝后绝不能发出贴吧请求');
  assert.equal((await h.ledger.snapshot()).used, TIEBA_PATROL_DAILY_CAP);

  const decision = adapter.lastDecision();
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'daily-cap');
  assert.match(decision.message, /每日上限/);
});

test('重试去重（允许路径）：同一 operationId 重复触发只扣一次，快照计数一致', async (t) => {
  const h = await ledgerHarness(t);
  const adapter = createTiebaPatrolAdapter({ ledger: h.ledger });
  const bound = adapter.forOperation({ operationId: 'op-allow-1' });
  assert.equal(typeof bound, 'function');
  const first = await bound();
  const second = await bound();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.used, 1);
  assert.equal(second.used, 1);
  assert.equal((await h.ledger.snapshot()).used, 1);
  assert.equal(adapter.snapshot().operations, 1);
  assert.equal(adapter.snapshot().decisions.allowed, 1);

  // 用真实 fetchThreadPages 复用同一个绑定钩子（模拟上游重试）：抓取仍发生，但账本不再 +1。
  const events = [];
  const options = { ...threadOptions(fakeFetch(events).fetchText), pages: '1', onBeforeTiebaRequest: bound };
  assert.equal((await fetchThreadPages('9876543210', options)).ok, true);
  assert.equal((await fetchThreadPages('9876543210', options)).ok, true);
  assert.equal(events.filter((event) => event === 'fetch').length, 2);
  assert.equal((await h.ledger.snapshot()).used, 1);
});

test('重试去重（拒绝路径）：已满额的操作重复触发仍拒绝且不重复请求账本', async (t) => {
  const h = await ledgerHarness(t);
  for (let index = 0; index < TIEBA_PATROL_DAILY_CAP; index += 1) await h.ledger.reserve({ reason: 'patrol' });
  const adapter = createTiebaPatrolAdapter({ ledger: h.ledger });
  const bound = adapter.forOperation({ operationId: 'op-denied-1' });
  const first = await bound();
  const second = await bound();
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(first.reason, 'daily-cap');
  assert.equal((await h.ledger.snapshot()).used, TIEBA_PATROL_DAILY_CAP);
  assert.equal(adapter.snapshot().decisions.denied, 1);
});

test('并发：同一 operationId 并发触发只调用一次 ledger（其余镜像结果）', async () => {
  let resolveReserve;
  const calls = [];
  const ledger = {
    reserve(request) {
      calls.push(request);
      return new Promise((resolve) => { resolveReserve = () => resolve({ ok: true, counted: true, used: 1, limit: 5, remaining: 4 }); });
    },
  };
  const adapter = createTiebaPatrolAdapter({ ledger });
  const bound = adapter.forOperation({ operationId: 'op-concurrent' });
  const pending = Array.from({ length: 5 }, () => bound());
  await new Promise((resolve) => setTimeout(resolve, 10));
  resolveReserve();
  const results = await Promise.all(pending);
  assert.equal(calls.length, 1, '同一 operationId 并发只允许预留一次');
  assert.equal(results.every((result) => result.ok === true && result.used === 1), true);
});

test('并发：不同逻辑请求（无 operationId）各自预留，真实账本恰好放行 6 个', async (t) => {
  const h = await ledgerHarness(t);
  const adapter = createTiebaPatrolAdapter({ ledger: h.ledger });
  const results = await Promise.all(Array.from({ length: 10 }, () => adapter()));
  assert.equal(results.filter((result) => result.ok).length, 6);
  assert.equal(results.filter((result) => result.reason === 'daily-cap').length, 4);
  assert.equal((await h.ledger.snapshot()).used, TIEBA_PATROL_DAILY_CAP);
});

test('账本故障 fail-closed：抛错/畸形返回都拒绝且零抓取（不当作放行）', async (t) => {
  for (const reserve of [
    async () => { const error = new Error('disk full'); error.code = 'TIEBA_PATROL_LEDGER_FAILED'; throw error; },
    async () => undefined,
    async () => null,
    async () => ({ ok: 'yes' }),
    async () => ({}),
  ]) {
    const ledger = { reserve };
    const adapter = createTiebaPatrolAdapter({ ledger });
    const events = [];
    const result = await fetchThreadPages('9876543210', { ...threadOptions(fakeFetch(events).fetchText), pages: '1', onBeforeTiebaRequest: adapter });
    assert.equal(result.ok, false, `ledger 返回 ${String(reserve)} 时必须 fail-closed`);
    assert.equal(events.filter((event) => event === 'fetch').length, 0);
    const decision = adapter.lastDecision();
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'ledger-unavailable');
    assert.match(decision.message, /账本不可用/);
  }
});

test('非法 reason fail-closed：reasonOf 返回非法值 / 显式 context.reason 非法都抛带 code 错误', async (t) => {
  const h = await ledgerHarness(t);
  for (const reason of ['admin', 'USER', '', null, 42, {}, []] ) {
    const adapter = createTiebaPatrolAdapter({ ledger: h.ledger, reasonOf: () => reason });
    const error = await rejectsWithCode(() => adapter(), 'TIEBA_PATROL_ADAPTER_INVALID_REASON');
    assert.match(error.message, /reason/);
  }
  const adapter = createTiebaPatrolAdapter({ ledger: h.ledger });
  await rejectsWithCode(() => adapter({ reason: 'admin' }), 'TIEBA_PATROL_ADAPTER_INVALID_REASON');
  assert.equal((await h.ledger.snapshot()).used, 0, '非法 reason 不得扣额度');

  // 经 tieba-lib：抛错被钩子包装成拒绝，零抓取。
  const bad = createTiebaPatrolAdapter({ ledger: h.ledger, reasonOf: () => 'admin' });
  const events = [];
  const result = await fetchThreadPages('9876543210', { ...threadOptions(fakeFetch(events).fetchText), pages: '1', onBeforeTiebaRequest: bad });
  assert.equal(result.ok, false);
  assert.equal(events.filter((event) => event === 'fetch').length, 0);
});

test('非法 operationId / context fail-closed：抛带 code 错误且不扣额度', async (t) => {
  const h = await ledgerHarness(t);
  const adapter = createTiebaPatrolAdapter({ ledger: h.ledger });
  for (const operationId of ['has space', 'path/../x', '中文', 'x'.repeat(129), '', 42, null, {}]) {
    await rejectsWithCode(() => adapter({ operationId }), 'TIEBA_PATROL_ADAPTER_INVALID_OPERATION_ID');
    await rejectsWithCode(() => Promise.resolve().then(() => adapter.forOperation({ operationId })), 'TIEBA_PATROL_ADAPTER_INVALID_OPERATION_ID');
  }
  for (const context of ['x', 42, [], null]) {
    await rejectsWithCode(() => adapter(context), 'TIEBA_PATROL_ADAPTER_INVALID_CONTEXT');
  }
  assert.equal((await h.ledger.snapshot()).used, 0);
});

test('user 与 operationId 组合：不调用 ledger、不记录去重状态', async () => {
  const fake = fakeLedger(() => ({ ok: true, counted: true, used: 1, limit: 5, remaining: 4 }));
  const adapter = createTiebaPatrolAdapter({ ledger: fake, reasonOf: () => 'user' });
  assert.equal((await adapter({ operationId: 'op-user-1' })).counted, false);
  assert.equal((await adapter({ operationId: 'op-user-1' })).counted, false);
  assert.equal(fake.calls.length, 0);
  assert.equal(adapter.snapshot().operations, 0);
});

test('now 注入：适配器把解析后的 at 传给 ledger（不做跨日借额度）', async () => {
  const fake = fakeLedger(() => ({ ok: true, counted: true, used: 1, limit: 5, remaining: 4 }));
  const adapter = createTiebaPatrolAdapter({ ledger: fake, now: () => T0 });
  await adapter();
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].reason, 'patrol');
  assert.equal(fake.calls[0].at, T0);
  // 非法时钟返回 fail-closed。
  const badClock = createTiebaPatrolAdapter({ ledger: fake, now: () => Number.NaN });
  await rejectsWithCode(() => badClock(), 'TIEBA_PATROL_ADAPTER_INVALID_CLOCK');
  assert.equal(fake.calls.length, 1);
});

test('lastDecision/snapshot：允许含额度快照、user 标记 counted:false、返回值是副本', async (t) => {
  const h = await ledgerHarness(t);
  const adapter = createTiebaPatrolAdapter({ ledger: h.ledger });
  await adapter();
  const allowed = adapter.lastDecision();
  assert.deepEqual(
    { ok: allowed.ok, counted: allowed.counted, reason: allowed.reason, used: allowed.used, limit: allowed.limit, remaining: allowed.remaining },
    { ok: true, counted: true, reason: 'patrol', used: 1, limit: 6, remaining: 5 },
  );
  allowed.used = 999;
  assert.equal(adapter.lastDecision().used, 1, 'lastDecision 必须是副本');

  const user = createTiebaPatrolAdapter({ ledger: h.ledger, reasonOf: () => 'user' });
  await user();
  assert.equal(user.lastDecision().counted, false);
  assert.equal(user.lastDecision().reason, 'user');

  const snapshot = adapter.snapshot();
  assert.deepEqual(snapshot.decisions, { allowed: 1, denied: 0, user: 0 });
  assert.equal(snapshot.operations, 0);
  snapshot.decisions.allowed = 99;
  assert.equal(adapter.snapshot().decisions.allowed, 1);
});

test('operationId 去重表有上限（防内存无限增长，淘汰最旧已结束操作）', async () => {
  const fake = fakeLedger(() => ({ ok: true, counted: true, used: 1, limit: 5, remaining: 4 }));
  const bounded = createTiebaPatrolAdapter({ ledger: fake });
  const total = TIEBA_PATROL_ADAPTER_MAX_OPERATIONS + 10;
  for (let index = 0; index < total; index += 1) {
    assert.equal((await bounded({ operationId: `op-${index}` })).ok, true);
  }
  assert.ok(bounded.snapshot().operations <= TIEBA_PATROL_ADAPTER_MAX_OPERATIONS, `operations 应有上限，实际 ${bounded.snapshot().operations}`);
  // 最旧的操作已被淘汰：再次触发会重新预留（而不是命中无限增长的历史）。
  await bounded({ operationId: 'op-0' });
  assert.equal(fake.calls.length, total + 1);
});
