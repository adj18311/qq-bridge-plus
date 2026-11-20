#!/usr/bin/env node
// scripts/test-tieba-patrol-request-boundary.mjs
//
// 第四阶段：贴吧抓取「请求边界钩子」纯离线契约测试。
//
// 被测目标（现有签名不变，onBeforeTiebaRequest 是可选的新增钩子）：
//   fetchBarPage(bar, page, { fetchText, searchFetch, limiter, readFile, cookieFile, now, onBeforeTiebaRequest })
//   fetchThreadPage(tid, page, { ...同上 })
//   fetchThreadPages(tid, { pages, fetchText, searchFetch, limiter, readFile, cookieFile, now, onBeforeTiebaRequest })
//
// 断言的契约：
//   ① 非法参数（吧名 / tid）：钩子与 fetchText 都不调用，也不占节流名额；
//   ② 被节流器拒绝：钩子与 fetchText 都不调用；现有降级搜索只走注入的 searchFetch；
//   ③ 正常首次请求：钩子恰好先调用 1 次，随后才调用 fetchText；
//   ④ 多页一次读帖（pages=1-3）：钩子只调用 1 次，随后发出 3 次页请求；
//   ⑤ 钩子拒绝（rejected Promise）或同步抛错：fetchText 一次都不调用，函数以 {ok:false} 收场且不抛；
//   ⑥ 不提供钩子（或缺省 undefined）：与旧行为完全一致。
//
// 全程纯离线：fetchText / searchFetch / limiter / readFile 全部注入本地假实现；
// 不联网、不读真实文件、不使用任何真实账户凭据。
// 「拒绝」的约定：async 钩子 throw 等价于 rejected Promise；本文件用 rejected Promise 表示拒绝、
// 用同步 throw 表示抛错。钩子入参的形状由实现决定，这里不做形状绑定，只断言调用次序、调用次数，
// 以及拒绝之后 fetchText 一次都不被调用。

import assert from 'node:assert/strict';

import {
  TIEBA_MOBILE_UA,
  buildBarUrl,
  buildThreadUrl,
  fetchBarPage,
  fetchThreadPage,
  fetchThreadPages
} from '../src/tieba-lib.js';

// ── 固定夹具（全部离线）──────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const BAR_NAME = '原神';
const TID = '9876543210';
const COOKIE_FILE = 'C:/fake-only/tieba-cookie.txt';
const FAKE_COOKIE = 'BDUSS=fake-cookie-value; STOKEN=fake-token-value';

/** 任何真实文件读取都视为缺陷：没配置 cookieFile 时 readFile 根本不该被调用。 */
const NEVER_READ_FILE = () => {
  throw new Error('测试不应读取任何真实文件');
};

const THROTTLED_VERDICT = Object.freeze({
  ok: false,
  reason: 'too-fast',
  waitMs: 2500,
  message: '抓得太快了，两次之间至少隔 3 秒。'
});

// 最小假页面：只求「能解析、不是安全验证页」，断言点在请求边界而不是解析细节。
const BAR_HTML = '<!DOCTYPE html><html><head><title>原神吧_百度贴吧</title></head><body><p>占位吧页</p></body></html>';
const BLOCKED_HTML = '<!DOCTYPE html><html><head><title>百度安全验证</title></head><body>请完成百度安全验证</body></html>';
const THREAD_HTML = '<!DOCTYPE html><html><head><title>第2/4页,回贴列表-测试帖子标题</title></head><body><p>占位帖页</p></body></html>';
const FAKE_SEARCH_HTML = '<html><body><p>假搜索结果页：故意不含 res-list 结果块，模拟 0 条</p></body></html>';

// ── 假实现工厂 ───────────────────────────────────────────────────────

function createFakeLimiter({ verdict = { ok: true } } = {}) {
  const calls = { allow: 0, noteSuccess: 0, noteBlocked: 0, noteFailure: 0, lastNow: null };
  return {
    calls,
    allow(now) {
      calls.allow += 1;
      calls.lastNow = now;
      return typeof verdict === 'function' ? verdict(now) : { ...verdict };
    },
    noteSuccess() { calls.noteSuccess += 1; },
    noteBlocked() { calls.noteBlocked += 1; },
    noteFailure() { calls.noteFailure += 1; }
  };
}

function createFakeFetch({ html = '', error = null, events = [] } = {}) {
  const calls = [];
  const fetchText = (url, maxChars, options) => {
    calls.push({ url, maxChars, options });
    events.push('fetch');
    if (error) return Promise.reject(error);
    return Promise.resolve(typeof html === 'function' ? html(url) : html);
  };
  return { calls, fetchText };
}

function createFakeSearch({ html = FAKE_SEARCH_HTML, events = [] } = {}) {
  const calls = [];
  const searchFetch = (url) => {
    calls.push({ url });
    events.push('search');
    return Promise.resolve(html);
  };
  return { calls, searchFetch };
}

function createPassingHook(events = []) {
  const calls = [];
  const hook = (...args) => {
    calls.push(args);
    events.push('hook');
    return Promise.resolve(undefined);
  };
  return { calls, hook };
}

function createRejectingHook(events = []) {
  const calls = [];
  const hook = (...args) => {
    calls.push(args);
    events.push('hook');
    return Promise.reject(new Error('钩子异步拒绝：不允许发出贴吧请求'));
  };
  return { calls, hook };
}

function createThrowingHook(events = []) {
  const calls = [];
  const hook = (...args) => {
    calls.push(args);
    events.push('hook');
    throw new Error('钩子同步抛错：不允许发出贴吧请求');
  };
  return { calls, hook };
}

/** 一次工具调用里：钩子只出现 1 次，且排在所有 fetchText 之前。 */
function assertHookBoundary(events, fetchCount) {
  const hookIndexes = events.map((event, index) => (event === 'hook' ? index : -1)).filter((index) => index >= 0);
  const fetchIndexes = events.map((event, index) => (event === 'fetch' ? index : -1)).filter((index) => index >= 0);
  assert.equal(hookIndexes.length, 1, '一次工具调用里钩子只能被调用 1 次');
  assert.equal(fetchIndexes.length, fetchCount, `应发出 ${fetchCount} 次 fetchText`);
  for (const index of fetchIndexes) {
    assert.ok(index > hookIndexes[0], '每次 fetchText 都必须发生在钩子之后');
  }
}

// ── 迷你测试运行器 ───────────────────────────────────────────────────

const failures = [];
let passed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`not ok - ${name}`);
    console.log(String(error?.stack ?? error));
  }
}

// ── ① 非法参数：钩子与 fetchText 都不调用，也不占节流名额 ──────────────

const INVALID_CASES = [
  { label: '空吧名', request: (options) => fetchBarPage('   ', 1, options), errorRe: /吧名不能为空/ },
  { label: '吧名含 URL 分隔符', request: (options) => fetchBarPage('原神/测试', 1, options), errorRe: /吧名不能包含/ },
  { label: '吧名超长（41 字）', request: (options) => fetchBarPage('原'.repeat(41), 1, options), errorRe: /吧名过长/ },
  { label: 'tid 非纯数字', request: (options) => fetchThreadPage('12ab', 1, options), errorRe: /纯数字/ },
  { label: 'tid 为 0', request: (options) => fetchThreadPage('0', 1, options), errorRe: /不能是 0/ },
  { label: 'tid 超长（21 位）', request: (options) => fetchThreadPage('1'.repeat(21), 1, options), errorRe: /tid 过长/ },
  { label: '多页空 tid', request: (options) => fetchThreadPages('', { ...options, pages: '1-2' }), errorRe: /tid 不能为空/ }
];

for (const invalid of INVALID_CASES) {
  await check(`非法参数（${invalid.label}）· 钩子与 fetchText 都不调用`, async () => {
    const events = [];
    const hook = createPassingHook(events);
    const fetchFake = createFakeFetch({ html: BAR_HTML, events });
    const search = createFakeSearch({ events });
    const limiter = createFakeLimiter();
    const result = await invalid.request({
      fetchText: fetchFake.fetchText,
      searchFetch: search.searchFetch,
      onBeforeTiebaRequest: hook.hook,
      limiter,
      readFile: NEVER_READ_FILE,
      now: NOW
    });
    assert.equal(result.ok, false);
    assert.match(String(result.error), invalid.errorRe);
    assert.equal(hook.calls.length, 0, '非法参数不该调用钩子');
    assert.equal(fetchFake.calls.length, 0, '非法参数不该调用 fetchText');
    assert.equal(search.calls.length, 0);
    assert.equal(limiter.calls.allow, 0, '非法参数应在节流判定之前返回');
    assert.deepEqual(events, []);
  });
}

// ── ② 节流：钩子与 fetchText 都不调用（降级搜索只走注入的 searchFetch）──

await check('被节流（fetchBarPage）· 钩子与 fetchText 都不调用，降级搜索走 searchFetch', async () => {
  const events = [];
  const hook = createPassingHook(events);
  const fetchFake = createFakeFetch({ html: BAR_HTML, events });
  const search = createFakeSearch({ events });
  const limiter = createFakeLimiter({ verdict: THROTTLED_VERDICT });
  const result = await fetchBarPage(BAR_NAME, 1, {
    fetchText: fetchFake.fetchText,
    searchFetch: search.searchFetch,
    onBeforeTiebaRequest: hook.hook,
    limiter,
    readFile: NEVER_READ_FILE,
    now: NOW
  });
  assert.equal(result.ok, false);
  assert.equal(result.throttled, true);
  assert.equal(result.reason, 'too-fast');
  assert.equal(result.waitMs, 2500);
  assert.equal(result.fallback, 'search-failed');
  assert.match(String(result.error), /抓得太快了/);
  assert.match(String(result.error), /网页搜索也没成功/);
  assert.equal(hook.calls.length, 0, '被节流时不该调用钩子');
  assert.equal(fetchFake.calls.length, 0, '被节流时不该调用 fetchText');
  assert.equal(search.calls.length, 1, '只允许通过注入的 searchFetch 做降级搜索');
  assert.equal(limiter.calls.allow, 1);
  assert.equal(limiter.calls.noteSuccess, 0);
  assert.deepEqual(events, ['search']);
});

await check('被节流（fetchThreadPage）· 钩子与 fetchText 都不调用', async () => {
  const events = [];
  const hook = createPassingHook(events);
  const fetchFake = createFakeFetch({ html: THREAD_HTML, events });
  const search = createFakeSearch({ events });
  const limiter = createFakeLimiter({ verdict: THROTTLED_VERDICT });
  const result = await fetchThreadPage(TID, 1, {
    fetchText: fetchFake.fetchText,
    searchFetch: search.searchFetch,
    onBeforeTiebaRequest: hook.hook,
    limiter,
    readFile: NEVER_READ_FILE,
    now: NOW
  });
  assert.equal(result.ok, false);
  assert.equal(result.throttled, true);
  assert.match(String(result.error), /抓得太快了/);
  assert.equal(hook.calls.length, 0);
  assert.equal(fetchFake.calls.length, 0);
  assert.equal(search.calls.length, 1);
  assert.equal(limiter.calls.allow, 1);
  assert.equal(limiter.calls.noteSuccess, 0);
});

await check('被节流（fetchThreadPages）· 钩子与 fetchText 都不调用，一页也没抓', async () => {
  const events = [];
  const hook = createPassingHook(events);
  const fetchFake = createFakeFetch({ html: THREAD_HTML, events });
  const search = createFakeSearch({ events });
  const limiter = createFakeLimiter({ verdict: THROTTLED_VERDICT });
  const result = await fetchThreadPages(TID, {
    pages: '1-2',
    fetchText: fetchFake.fetchText,
    searchFetch: search.searchFetch,
    onBeforeTiebaRequest: hook.hook,
    limiter,
    readFile: NEVER_READ_FILE,
    now: NOW
  });
  assert.equal(result.ok, false);
  assert.equal(result.throttled, true);
  assert.equal(result.reason, 'too-fast');
  assert.deepEqual(result.pages, [1, 2]);
  assert.deepEqual(result.fetchedPages, []);
  assert.equal(result.requestedPageCount, 2);
  assert.equal(hook.calls.length, 0);
  assert.equal(fetchFake.calls.length, 0);
  assert.equal(search.calls.length, 1);
  assert.equal(limiter.calls.allow, 1);
});

// ── ③ 正常首次请求：钩子 1 次 → fetchText ────────────────────────────

await check('正常首次请求（fetchBarPage）· 先钩子后 fetchText，cookie 只进请求头', async () => {
  const events = [];
  const hook = createPassingHook(events);
  const fetchFake = createFakeFetch({ html: BAR_HTML, events });
  const search = createFakeSearch({ events });
  const limiter = createFakeLimiter();
  const readFiles = [];
  const readFile = (file, encoding) => {
    readFiles.push({ file, encoding });
    return FAKE_COOKIE;
  };
  const result = await fetchBarPage(BAR_NAME, 1, {
    fetchText: fetchFake.fetchText,
    searchFetch: search.searchFetch,
    onBeforeTiebaRequest: hook.hook,
    cookieFile: COOKIE_FILE,
    readFile,
    limiter,
    now: NOW
  });
  const expectedUrl = buildBarUrl(BAR_NAME, 1);
  assert.equal(result.ok, true);
  assert.equal(result.url, expectedUrl);
  assert.equal(typeof result.text, 'string');
  assert.equal(hook.calls.length, 1);
  assert.equal(fetchFake.calls.length, 1);
  assert.deepEqual(events, ['hook', 'fetch']);
  assert.equal(search.calls.length, 0);
  assert.equal(limiter.calls.allow, 1);
  assert.equal(limiter.calls.noteSuccess, 1);
  assert.equal(fetchFake.calls[0].url, expectedUrl);
  assert.equal(fetchFake.calls[0].maxChars, 200000);
  assert.deepEqual(fetchFake.calls[0].options, {
    headers: { cookie: FAKE_COOKIE, 'user-agent': TIEBA_MOBILE_UA }
  });
  assert.deepEqual(readFiles, [{ file: COOKIE_FILE, encoding: 'utf8' }]);
  assert.ok(!JSON.stringify({ data: result.data, text: result.text }).includes('BDUSS'), 'cookie 值不得泄漏进返回内容');
});

await check('正常首次请求（fetchThreadPage）· 先钩子后 fetchText，URL 与长度上限不变', async () => {
  const events = [];
  const hook = createPassingHook(events);
  const fetchFake = createFakeFetch({ html: THREAD_HTML, events });
  const search = createFakeSearch({ events });
  const limiter = createFakeLimiter();
  const result = await fetchThreadPage(TID, 1, {
    fetchText: fetchFake.fetchText,
    searchFetch: search.searchFetch,
    onBeforeTiebaRequest: hook.hook,
    limiter,
    readFile: NEVER_READ_FILE,
    now: NOW
  });
  const expectedUrl = buildThreadUrl(TID, 1);
  assert.equal(result.ok, true);
  assert.equal(result.url, expectedUrl);
  assert.equal(typeof result.text, 'string');
  assert.ok(Array.isArray(result.images));
  assert.equal(hook.calls.length, 1);
  assert.equal(fetchFake.calls.length, 1);
  assert.deepEqual(events, ['hook', 'fetch']);
  assert.equal(fetchFake.calls[0].url, expectedUrl);
  assert.equal(fetchFake.calls[0].maxChars, 300000);
  assert.equal(search.calls.length, 0);
  assert.equal(limiter.calls.allow, 1);
  assert.equal(limiter.calls.noteSuccess, 1);
});

await check('钩子被真正 await：钩子 settle 之前不会发出 fetchText', async () => {
  const events = [];
  let hookSettled = false;
  const hook = async () => {
    events.push('hook:start');
    await new Promise((resolve) => setTimeout(resolve, 5));
    hookSettled = true;
    events.push('hook:settled');
  };
  const calls = [];
  const fetchText = (url, maxChars, options) => {
    calls.push({ url, maxChars, options, hookSettled });
    events.push('fetch');
    return Promise.resolve(BAR_HTML);
  };
  const limiter = createFakeLimiter();
  const result = await fetchBarPage(BAR_NAME, 1, {
    fetchText,
    searchFetch: createFakeSearch({ events }).searchFetch,
    onBeforeTiebaRequest: hook,
    limiter,
    readFile: NEVER_READ_FILE,
    now: NOW
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hookSettled, true, 'fetchText 必须在钩子 settle 之后才可被调用');
  assert.deepEqual(events, ['hook:start', 'hook:settled', 'fetch']);
});

// ── ④ 多页一次读帖：钩子 1 次 → 多次页请求 ───────────────────────────

await check('多页一次读帖（pages=1-3）· 钩子只调用 1 次，随后发出 3 次页请求', async () => {
  const events = [];
  const hook = createPassingHook(events);
  const fetchFake = createFakeFetch({ html: THREAD_HTML, events });
  const search = createFakeSearch({ events });
  const limiter = createFakeLimiter();
  const result = await fetchThreadPages(TID, {
    pages: '1-3',
    fetchText: fetchFake.fetchText,
    searchFetch: search.searchFetch,
    onBeforeTiebaRequest: hook.hook,
    limiter,
    readFile: NEVER_READ_FILE,
    now: NOW
  });
  assert.equal(result.ok, true);
  assert.equal(hook.calls.length, 1, '多页一次读帖只允许调用 1 次钩子');
  assert.equal(fetchFake.calls.length, 3);
  assertHookBoundary(events, 3);
  assert.deepEqual(result.pages, [1, 2, 3]);
  assert.deepEqual(result.fetchedPages, [1, 2, 3]);
  assert.equal(result.requestedPageCount, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.urls, fetchFake.calls.map((call) => call.url));
  assert.deepEqual(
    fetchFake.calls.map((call) => new URL(call.url).searchParams.get('pn')),
    [null, '30', '60']
  );
  for (const call of fetchFake.calls) assert.equal(call.maxChars, 300000);
  assert.equal(limiter.calls.allow, 1, '整批多页只应向节流器申请 1 次');
  assert.equal(limiter.calls.noteSuccess, 1);
  assert.equal(search.calls.length, 0);
});

// ── ⑤ 钩子拒绝 / 抛错：fetchText 一次都不调用，函数不抛 ──────────────

await check('钩子拒绝（rejected Promise）· fetchBarPage 不调用 fetchText，返回 ok:false 且不抛', async () => {
  const events = [];
  const hook = createRejectingHook(events);
  const fetchFake = createFakeFetch({ html: BAR_HTML, events });
  const search = createFakeSearch({ events });
  const limiter = createFakeLimiter();
  const result = await fetchBarPage(BAR_NAME, 1, {
    fetchText: fetchFake.fetchText,
    searchFetch: search.searchFetch,
    onBeforeTiebaRequest: hook.hook,
    limiter,
    readFile: NEVER_READ_FILE,
    now: NOW
  });
  assert.equal(result.ok, false);
  assert.ok(String(result.error ?? '').trim().length > 0, '拒绝时应给出可读说明');
  assert.equal(hook.calls.length, 1);
  assert.equal(fetchFake.calls.length, 0, '钩子拒绝后绝不能发出贴吧请求');
  assert.equal(limiter.calls.noteSuccess, 0);
  assert.equal(events.filter((event) => event === 'fetch').length, 0);
});

await check('钩子同步抛错 · fetchThreadPage 不调用 fetchText，返回 ok:false 且不抛', async () => {
  const events = [];
  const hook = createThrowingHook(events);
  const fetchFake = createFakeFetch({ html: THREAD_HTML, events });
  const search = createFakeSearch({ events });
  const limiter = createFakeLimiter();
  const result = await fetchThreadPage(TID, 1, {
    fetchText: fetchFake.fetchText,
    searchFetch: search.searchFetch,
    onBeforeTiebaRequest: hook.hook,
    limiter,
    readFile: NEVER_READ_FILE,
    now: NOW
  });
  assert.equal(result.ok, false);
  assert.ok(String(result.error ?? '').trim().length > 0, '抛错时应给出可读说明');
  assert.equal(hook.calls.length, 1);
  assert.equal(fetchFake.calls.length, 0, '钩子抛错后绝不能发出贴吧请求');
  assert.equal(events.filter((event) => event === 'fetch').length, 0);
});

await check('钩子拒绝 · fetchThreadPages 一页都不抓、钩子只调用 1 次', async () => {
  const events = [];
  const hook = createRejectingHook(events);
  const fetchFake = createFakeFetch({ html: THREAD_HTML, events });
  const search = createFakeSearch({ events });
  const limiter = createFakeLimiter();
  const result = await fetchThreadPages(TID, {
    pages: '1-2',
    fetchText: fetchFake.fetchText,
    searchFetch: search.searchFetch,
    onBeforeTiebaRequest: hook.hook,
    limiter,
    readFile: NEVER_READ_FILE,
    now: NOW
  });
  assert.equal(result.ok, false);
  assert.equal(hook.calls.length, 1);
  assert.equal(fetchFake.calls.length, 0, '钩子拒绝后一页都不能抓');
  assert.equal(events.filter((event) => event === 'fetch').length, 0);
});

// ── ⑥ 缺省钩子：旧行为逐字节不变 ─────────────────────────────────────

await check('未提供钩子（fetchBarPage）· 旧行为不变：1 次 fetchText、成功返回', async () => {
  const events = [];
  const fetchFake = createFakeFetch({ html: BAR_HTML, events });
  const search = createFakeSearch({ events });
  const limiter = createFakeLimiter();
  const result = await fetchBarPage(BAR_NAME, 1, {
    fetchText: fetchFake.fetchText,
    searchFetch: search.searchFetch,
    limiter,
    readFile: NEVER_READ_FILE,
    now: NOW
  });
  assert.equal(result.ok, true);
  assert.equal(result.url, buildBarUrl(BAR_NAME, 1));
  assert.equal(fetchFake.calls.length, 1);
  assert.deepEqual(events, ['fetch']);
  assert.equal(limiter.calls.allow, 1);
  assert.equal(limiter.calls.noteSuccess, 1);
});

await check('onBeforeTiebaRequest 显式 undefined（fetchThreadPage）· 等价于未提供', async () => {
  const events = [];
  const fetchFake = createFakeFetch({ html: THREAD_HTML, events });
  const search = createFakeSearch({ events });
  const limiter = createFakeLimiter();
  const result = await fetchThreadPage(TID, 1, {
    fetchText: fetchFake.fetchText,
    searchFetch: search.searchFetch,
    onBeforeTiebaRequest: undefined,
    limiter,
    readFile: NEVER_READ_FILE,
    now: NOW
  });
  assert.equal(result.ok, true);
  assert.equal(fetchFake.calls.length, 1);
  assert.deepEqual(events, ['fetch']);
});

await check('未提供钩子（fetchThreadPages，pages=1-2）· 旧行为不变：2 次页请求', async () => {
  const events = [];
  const fetchFake = createFakeFetch({ html: THREAD_HTML, events });
  const search = createFakeSearch({ events });
  const limiter = createFakeLimiter();
  const result = await fetchThreadPages(TID, {
    pages: '1-2',
    fetchText: fetchFake.fetchText,
    searchFetch: search.searchFetch,
    limiter,
    readFile: NEVER_READ_FILE,
    now: NOW
  });
  assert.equal(result.ok, true);
  assert.equal(fetchFake.calls.length, 2);
  assert.deepEqual(result.pages, [1, 2]);
  assert.deepEqual(result.fetchedPages, [1, 2]);
  assert.deepEqual(events, ['fetch', 'fetch']);
  assert.equal(limiter.calls.allow, 1);
});

// ── ⑦ 边界补充：调用隔离、抓取失败、被拦降级 ───────────────────────

await check('每次工具调用各调用 1 次钩子：连续两次 fetchBarPage = 钩子 2 次 / fetch 2 次', async () => {
  const events = [];
  const hook = createPassingHook(events);
  const fetchFake = createFakeFetch({ html: BAR_HTML, events });
  const search = createFakeSearch({ events });
  const limiter = createFakeLimiter();
  const options = {
    fetchText: fetchFake.fetchText,
    searchFetch: search.searchFetch,
    onBeforeTiebaRequest: hook.hook,
    limiter,
    readFile: NEVER_READ_FILE,
    now: NOW
  };
  const first = await fetchBarPage(BAR_NAME, 1, options);
  const second = await fetchBarPage(BAR_NAME, 2, options);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(hook.calls.length, 2);
  assert.equal(fetchFake.calls.length, 2);
  assert.deepEqual(events, ['hook', 'fetch', 'hook', 'fetch']);
  assert.deepEqual(
    fetchFake.calls.map((call) => call.url),
    [buildBarUrl(BAR_NAME, 1), buildBarUrl(BAR_NAME, 2)]
  );
});

await check('钩子放行后 fetchText 失败 · 不重试、结果 ok:false（钩子不吞掉抓取错误）', async () => {
  const events = [];
  const hook = createPassingHook(events);
  const fetchFake = createFakeFetch({ error: new Error('网络断了'), events });
  const search = createFakeSearch({ events });
  const limiter = createFakeLimiter();
  const result = await fetchThreadPage(TID, 1, {
    fetchText: fetchFake.fetchText,
    searchFetch: search.searchFetch,
    onBeforeTiebaRequest: hook.hook,
    limiter,
    readFile: NEVER_READ_FILE,
    now: NOW
  });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /抓取失败/);
  assert.match(String(result.error), /网络断了/);
  assert.equal(hook.calls.length, 1);
  assert.equal(fetchFake.calls.length, 1);
  assert.equal(limiter.calls.noteFailure, 1);
  assert.equal(search.calls.length, 0);
  assert.deepEqual(events, ['hook', 'fetch']);
});

await check('命中百度安全验证页 · 钩子仍只调用 1 次，降级搜索走注入的 searchFetch', async () => {
  const events = [];
  const hook = createPassingHook(events);
  const fetchFake = createFakeFetch({ html: BLOCKED_HTML, events });
  const search = createFakeSearch({ events });
  const limiter = createFakeLimiter();
  const result = await fetchBarPage(BAR_NAME, 1, {
    fetchText: fetchFake.fetchText,
    searchFetch: search.searchFetch,
    onBeforeTiebaRequest: hook.hook,
    limiter,
    readFile: NEVER_READ_FILE,
    now: NOW
  });
  assert.equal(result.ok, true);
  assert.equal(result.blocked, true);
  assert.equal(result.fallback, 'search-failed');
  assert.equal(hook.calls.length, 1);
  assert.equal(fetchFake.calls.length, 1);
  assert.equal(search.calls.length, 1);
  assert.equal(limiter.calls.noteBlocked, 1);
  assert.deepEqual(events, ['hook', 'fetch', 'search']);
});

for (const verdict of [false, { ok: false, reason: 'daily-cap', secret: 'test-secret' }]) {
  for (const [label, invoke] of [
    ['吧页', (opts) => fetchBarPage(BAR_NAME, 1, opts)],
    ['单页', (opts) => fetchThreadPage(TID, 1, opts)],
    ['多页', (opts) => fetchThreadPages(TID, { ...opts, pages: '1-2' })]
  ]) {
    await check(`${label}：钩子明确返回拒绝时禁止抓取`, async () => {
      const fake = createFakeFetch();
      const result = await invoke({
        fetchText: fake.fetchText,
        searchFetch: createFakeSearch({ events: [] }).searchFetch,
        onBeforeTiebaRequest: async () => verdict,
        limiter: createFakeLimiter(),
        readFile: NEVER_READ_FILE,
        now: NOW
      });
      assert.equal(result.ok, false);
      assert.equal(fake.calls.length, 0);
      assert.ok(!JSON.stringify(result).includes('test-secret'));
    });
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────────

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n✗ ${failures.length}/${total} 个用例失败（纯离线测试：fetchText / searchFetch / limiter / readFile 均为本地假实现，未发出任何真实请求）`);
  process.exitCode = 1;
} else {
  console.log(`\n✓ 全部 ${total} 个用例通过（纯离线：未联网、未读真实文件、未使用任何真实账户凭据）`);
}
