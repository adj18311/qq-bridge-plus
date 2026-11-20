import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQzoneLiveFriendRead } from '../src/core/qzone-live-friend-read.mjs';
import { createQzoneLiveFriendProof } from '../src/core/qzone-live-friend-proof.mjs';
import { createQzoneOnebotReadTransport } from '../src/core/qzone-onebot-read-transport.mjs';
import { createQzoneBoundReadTransport } from '../src/core/qzone-bound-read-transport.mjs';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';

const now = Date.parse('2026-11-10T04:00:00Z');
function makeStore(overrides = {}) {
  let state = { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true }, reads: 0, writes: 0, readAttempts: {}, readOutcomes: {},
    notices: [], browseDay: '2026-11-10', todayBrowses: 0, lastBrowseAt: null,
    usedOpportunities: {}, activeStart: 0, activeEnd: 1439, audit: [], ...overrides };
  return { read: () => structuredClone(state), update(fn) { state = fn(structuredClone(state)); return structuredClone(state); } };
}
function setup({ requestProof, friendship = defaultFriendship, transport, store = makeStore(), clock = () => now } = {}) {
  let calls = 0;
  const fakeTransport = transport ?? (async (args) => { calls++; assert.equal(args.target_uin, 456); return {
    status: 'ok', retcode: 0, data: { total: 3, msglist: [
      { tid: 'fresh', time: now / 1000 - 5, content: 'recent', cookie: 'never-return' },
      { tid: 'stale', time: now / 1000 - 8 * 86400, content: 'old private' },
      { tid: 'future', time: now / 1000 + 30, content: 'future private' }
    ] }
  }; });
  const reader = createQzoneLiveFriendRead({ store, clock,
    verifyRequestProof: requestProof ?? (async () => ({ id: 'r1', sourceProofId: 'src1', source: 'requested',
      targetQq: 456, botQq: 123, connectionEpoch: 8 })),
    verifyFriendship: friendship, offlineTestFixture: true,
    transport: fakeTransport });
  return { reader, store, calls: () => calls };
}
const defaultFriendship = async (proof) => ({ status: 'friend', sourceProofId: proof.sourceProofId,
  botQq: proof.botQq, targetQq: proof.targetQq, connectionEpoch: proof.connectionEpoch });

test('真实好友证明组件可接入离线读取器，并只收到目标和连接绑定字段', async () => {
  const verifier = createQzoneLiveFriendProof({ botQq: 123, getConnectionEpoch: () => 8,
    call: async (action) => action === 'get_login_info'
      ? { status: 'ok', retcode: 0, data: { user_id: 123 } }
      : { status: 'ok', retcode: 0, data: [{ user_id: 456 }] } });
  const { reader, calls } = setup({ friendship: verifier.verify });
  const result = await reader.read({ targetQq: 999 });
  assert.equal(result.outcome, 'success');
  assert.equal(calls(), 1);
  assert.deepEqual(result.posts.map((post) => post.id), ['fresh']);
});

test('好友证明、epoch 包装和真实 OneBot 读取适配器可组成离线读取链', async () => {
  const verifier = createQzoneLiveFriendProof({ botQq: 123, getConnectionEpoch: () => 8,
    call: async (action) => action === 'get_login_info'
      ? { status: 'ok', retcode: 0, data: { user_id: 123 } }
      : { status: 'ok', retcode: 0, data: [{ user_id: 456 }] } });
  let calls = 0;
  const transport = createQzoneOnebotReadTransport({ origin: 'http://127.0.0.1:15000',
    fetch: async (_url, options) => {
      calls++;
      assert.deepEqual(JSON.parse(options.body), { target_uin: 456, pos: 0, num: 20 });
      return new Response(JSON.stringify({ status: 'ok', retcode: 0,
        data: { total: 1, msglist: [{ tid: 'post', time: now / 1000 - 5, content: 'recent' }] } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    } });
  const bound = createQzoneBoundReadTransport({ botQq: 123, getConnectionEpoch: () => 8, transport });
  const { reader } = setup({ friendship: verifier.verify, transport: (input) => bound(input, () => true) });
  const result = await reader.read({});
  assert.equal(result.outcome, 'success');
  assert.equal(calls, 1);
  assert.deepEqual(result.posts.map((post) => post.id), ['post']);
});

test('离线链使用 SQLite 真实事务保存读取结果，重开后仍可查询审计', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-bound-read-'));
  const file = join(dir, 'state.sqlite');
  let store = openOfflineStore(file, makeStore().read());
  t.after(async () => { store?.close(); await rm(dir, { recursive: true, force: true }); });
  const { reader } = setup({ store });
  assert.equal((await reader.read({})).outcome, 'success');
  store.close();
  store = openOfflineStore(file, makeStore().read());
  assert.equal(store.read().readOutcomes.r1, 'success');
  assert.equal(store.read().audit.find((entry) => entry.id === 'read:r1')?.record.result, 'success');
});

test('隔离读取样品没有显式夹具标记时不得构造', () => {
  assert.throws(() => createQzoneLiveFriendRead({ store: makeStore(), clock: () => now,
    verifyRequestProof: async () => null, verifyFriendship: defaultFriendship,
    transport: async () => null }), /offline fixture/);
});

test('验证外部来源与好友关系、门禁、预留审计后才读取并只返回近期投影', async () => {
  const { reader, store, calls } = setup();
  const result = await reader.read({ targetQq: 999, friend: true, now, source: 'requested' });
  // The return shape is `posts` and NOTHING else — no count of what the platform sent. An earlier
  // revision carried `page: {requested, received, upstreamTotal}` here; it was removed because
  // `received - posts.length` tells the caller exactly how many rows were withheld (see the reader's
  // "WHY NO COUNT IS RETURNED" header). This `deepEqual` therefore proves the ABSENCE of those
  // numbers: any reintroduced count field fails it immediately.
  assert.deepEqual(result, { allowed: true, outcome: 'success', posts: [
    { author: '456', id: 'fresh', time: now - 5000, content: 'recent' }
  ] }, '返回体只能有 posts，不得带任何计数（计数会构成侧信道）');
  assert.equal(Object.hasOwn(result, 'page'), false, '不得返回 page');
  assert.equal(calls(), 1);
  const state = store.read();
  assert.equal(state.audit.find(x => x.id === 'read_intent_r1').record.result, 'unknown');
  assert.equal(state.audit.find(x => x.id === 'read:r1').record.result, 'success');
  assert.equal(JSON.stringify(result).includes('never-return'), false);
  assert.equal(JSON.stringify(result).includes('old private'), false);
});

test('缺失或不可信外部证明、非好友、模型自报身份/时间/范围均在传输前拒绝', async (t) => {
  for (const verifyRequestProof of [async () => null,
    async () => ({ id: 'r2', sourceProofId: 'src2', source: 'requested', targetQq: 456, botQq: 123, connectionEpoch: 8, now }),
    async () => ({ id: '__proto__', sourceProofId: 'src2', source: 'requested', targetQq: 456, botQq: 123, connectionEpoch: 8 })]) {
    const { reader, calls } = setup({ requestProof: verifyRequestProof });
    const result = await reader.read({ targetQq: 456, now, friend: true, source: 'requested', contentScope: 'all' });
    assert.equal(result.allowed, false); assert.equal(calls(), 0);
  }
  const { reader, calls } = setup({ friendship: async () => ({ status: 'friend', sourceProofId: 'wrong',
    botQq: 123, targetQq: 456, connectionEpoch: 8 }) });
  assert.equal((await reader.read({})).allowed, false); assert.equal(calls(), 0);
  const unboundBoolean = setup({ friendship: async () => true });
  assert.equal((await unboundBoolean.reader.read({})).allowed, false);
  assert.equal(unboundBoolean.calls(), 0);
  t.after(() => {});
});

test('任一策略门禁关闭时不预留、不调用传输', async () => {
  const store = makeStore({ readAllowed: false });
  const { reader, calls } = setup({ store });
  assert.equal((await reader.read({})).allowed, false);
  assert.equal(calls(), 0); assert.deepEqual(store.read().readAttempts, {});
});

test('来源在审计预留期间失效时不得发起读取', async () => {
  const inner = makeStore();
  let valid = true;
  const store = { read: inner.read, update(fn) { const state = inner.update(fn); valid = false; return state; } };
  const requestProof = async () => valid ? { id: 'r1', sourceProofId: 'src1', source: 'requested',
    targetQq: 456, botQq: 123, connectionEpoch: 8 } : null;
  const { reader, calls } = setup({ store, requestProof });
  const result = await reader.read({});
  assert.equal(result.allowed, false);
  assert.equal(calls(), 0);
  assert.ok(store.read().audit.some((entry) => entry.id === 'read_intent_r1'));
  // The reservation was already committed here, so the caller has to be able to tell
  // this apart from a rejection that never touched the store (Codex round-7 point 2).
  assert.equal(result.reserved, true);
  assert.equal(result.dispatched, false);
});

test('预约之后、派发之前抛异常时要如实报告已消耗意图且未派发，而不是报成什么都没做', async () => {
  // `reserved: true` means the one-shot audited read intent is committed; it does
  // NOT mean the platform request was issued. Between the two, the reader runs
  // safeClock / verifyRequestProof / authorizeTool, and any of them can throw.
  // Reporting a bare `unverified` there hid a consumed reservation from the caller.
  let clockCalls = 0;
  const throwingClock = () => {
    clockCalls++;
    if (clockCalls === 2) throw new TypeError('clock failed after the reservation');
    return now;
  };
  const { reader, store, calls } = setup({ clock: throwingClock });
  const result = await reader.read({});
  assert.deepEqual(result, { allowed: false, reason: 'unverified', reserved: true, dispatched: false });
  assert.equal(calls(), 0, '不得发出任何平台请求');
  assert.ok(store.read().audit.some((entry) => entry.id === 'read_intent_r1'), '一次性意图已被消耗');
});

test('好友证明在预约之前失败时必须不带 reserved 标记，调用方才知道什么都没消耗', async () => {
  const { reader, store, calls } = setup({ friendship: async () => null });
  const result = await reader.read({});
  assert.deepEqual(result, { allowed: false, reason: 'unverified' });
  assert.equal(Object.hasOwn(result, 'reserved'), false,
    '未提交预约的拒绝不得带 reserved，否则调用方无法区分「什么都没做」与「意图已烧掉」');
  assert.equal(calls(), 0);
  assert.deepEqual(store.read().readAttempts, {});
});

test('transport 异常及未知响应 fail-closed 并结算 unknown，不泄露原响应', async () => {
  for (const transport of [async () => { throw new Error('secret response'); }, async () => ({ raw: 'secret' })]) {
    const { reader, store } = setup({ transport });
    const result = await reader.read({});
    assert.deepEqual(result, { allowed: true, outcome: 'unknown', posts: [] });
    assert.equal(store.read().readOutcomes.r1, 'unknown');
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('dispatch 后复验异常或结算存储异常只返回 unknown，保留已提交的读取意图', async () => {
  let proofCalls = 0;
  const changingVerifier = async () => {
    proofCalls++;
    if (proofCalls === 3) throw new Error('epoch verifier failed');
    return { id: 'r1', sourceProofId: 'src1', source: 'requested', targetQq: 456, botQq: 123, connectionEpoch: 8 };
  };
  const afterVerifyFails = setup({ requestProof: changingVerifier,
    transport: async () => ({ status: 'ok', retcode: 0, data: { total: 0, msglist: [] } }) });
  assert.deepEqual(await afterVerifyFails.reader.read({}), { allowed: true, outcome: 'unknown', posts: [] });
  assert.ok(afterVerifyFails.store.read().audit.some((x) => x.id === 'read_intent_r1'));
  assert.equal(afterVerifyFails.store.read().readOutcomes.r1, 'unknown');

  let state = makeStore().read();
  let dispatched = false;
  const failingStore = {
    read: () => structuredClone(state),
    update(fn) {
      const next = fn(structuredClone(state));
      if (dispatched && next.readOutcomes?.r1) throw new Error('settlement store failed');
      state = next;
      return structuredClone(state);
    }
  };
  const afterStoreFails = setup({ store: failingStore, transport: async () => {
    dispatched = true;
    return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
  } });
  assert.deepEqual(await afterStoreFails.reader.read({}), { allowed: true, outcome: 'unknown', posts: [] });
  assert.ok(state.audit.some((x) => x.id === 'read_intent_r1'));
  assert.equal(Object.hasOwn(state.readOutcomes, 'r1'), false);
});

test('好友状态变化/epoch失效后结果被丢弃', async () => {
  let checks = 0;
  const { reader } = setup({ friendship: async (proof) => ++checks === 1 ? defaultFriendship(proof) : null,
    transport: async () => ({ status: 'ok', retcode: 0, data: { total: 0, msglist: [] } }) });
  assert.deepEqual(await reader.read({}), { allowed: true, outcome: 'unknown', posts: [] });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// t48/t30 — INVARIANCE: the output must not move when the upstream total moves
// ══════════════════════════════════════════════════════════════════════════════════════
//
// This is the regression guard for R12b-24. The leak it closes was NOT a boolean named `truncated`
// — it was two raw counts that let a caller build that boolean themselves:
//
//     hidden | received | posts.length | caller computes received - posts.length
//        0   |    3     |      3       |  0
//        1   |    4     |      3       |  1   ← leaks
//        5   |    8     |      3       |  5   ← leaks
//       17   |   20     |      3       | 17   ← leaks
//
// So the assertion is not "page is absent" (a shape check that a future field could sneak past).
// It is: HOLD THE VISIBLE POSTS FIXED, VARY EVERYTHING ELSE, AND REQUIRE BYTE-IDENTICAL OUTPUT.
// If any count of the platform's rows or the upstream total reaches the caller, one of these
// combinations produces a different result and this test fails.

/** 3 rows the reader is allowed to show; identical in every combination. */
const INVARIANT_VISIBLE = Object.freeze([
  { tid: 'v0', time: now / 1000 - 5, content: 'visible-0' },
  { tid: 'v1', time: now / 1000 - 6, content: 'visible-1' },
  { tid: 'v2', time: now / 1000 - 7, content: 'visible-2' },
]);

/**
 * Rows the reader will NOT return.
 *
 * ⚠️ After t30 these are FUTURE-DATED, not old: the 7-day floor is gone, so age no longer hides
 * anything, and `time <= now` is the only row-level refusal left. Keeping a helper that produces
 * genuinely-invisible rows is still useful — it is what proves the output does not move when the
 * platform sends more than it shows (INV-1 still varies `total` with zero hidden rows; this helper
 * is retained for the platform-side sanity checks below).
 */
function invariantHiddenRows(count) {
  return Array.from({ length: count }, (_, i) => ({
    tid: `h${i}`, time: now / 1000 + 3600, content: `hidden-${i}`,
  }));
}

/** Run one read against an envelope built from `visible + hidden` and a chosen upstream `total`. */
async function invariantOutput(hiddenCount, total) {
  const msglist = [...INVARIANT_VISIBLE, ...invariantHiddenRows(hiddenCount)];
  // NOTE: `setup()`只在自己创建默认 transport 时才计数，注入 transport 时它内部的 counter 恒为 0。
  // 所以这里自己数，否则断言会变成「0 !== 1」这种没意义的失败。
  let dispatches = 0;
  const { reader } = setup({ transport: async () => {
    dispatches += 1;
    return { status: 'ok', retcode: 0, data: { total, msglist } };
  } });
  const result = await reader.read({ targetQq: 456, friend: true, now, source: 'requested' });
  assert.equal(dispatches, 1, '每次恰好一次请求（不翻页）');
  return result;
}

test('INV-1 reader：只改 upstream total，输出必须完全相同（侧信道防护的真实意图）', async () => {
  // ⚠️ REWRITTEN FOR t30. This test used to vary the number of HIDDEN rows, relying on the 7-day
  // window to hide them. That window is gone: every returned row is now visible, so "hidden rows"
  // no longer exist as a category and the old construction would have been vacuous (0 hidden rows
  // in every case). What the invariance was really protecting is still true and now tested
  // directly: the upstream `total` is a platform number the caller must never be able to read, and
  // the SAME visible page must produce BYTE-IDENTICAL output no matter what it says.
  const totals = [0, 3, 20, 137, 999, Number.MAX_SAFE_INTEGER];
  const outputs = [];
  for (const total of totals) outputs.push({ total, result: await invariantOutput(0, total) });
  assert.equal(outputs.length, totals.length, '每个 total 都跑了一次');

  const baseline = outputs[0].result;
  // Non-vacuity: the baseline must actually contain the three visible posts. Without this, "all
  // equal" could be satisfied by identical EMPTY results.
  assert.equal(baseline.outcome, 'success');
  assert.deepEqual(baseline.posts.map((p) => p.id), ['v0', 'v1', 'v2'], '前提：三条可见行确实被返回');

  for (const { total, result } of outputs) {
    assert.deepEqual(result, baseline,
      `total=${total} 时输出必须与基准完全相同 —— 任何差异都是计数侧信道`);
  }
});

test('INV-2 reader：返回体里没有任何能推出隐藏行数的字段', async () => {
  // A structural check on top of INV-1: enumerate the keys the caller actually receives. Any new
  // key is a deliberate decision, so this list is meant to need updating when the shape changes
  // on purpose — it is not meant to be relaxed to make a count fit.
  const result = await invariantOutput(17, 999);
  assert.deepEqual(Object.keys(result).sort(), ['allowed', 'outcome', 'posts'],
    'success 返回体只允许 allowed/outcome/posts 三个键');
  assert.equal(Object.hasOwn(result, 'page'), false);
  assert.equal(Object.hasOwn(result, 'received'), false);
  assert.equal(Object.hasOwn(result, 'upstreamTotal'), false);
  assert.equal(Object.hasOwn(result, 'requested'), false);

  // The 20 hidden rows must not be inferable from `posts.length` either — that is the point.
  assert.equal(result.posts.length, 3);
});

test('INV-3 reader：极端 total 对比 —— 0 与 MAX_SAFE_INTEGER 必须不可区分', async () => {
  // REWRITTEN FOR t30 with INV-1: with no window there are no hidden rows to contrast, so the
  // extremes are now the platform's own `total`. An implausibly large total must not change one
  // byte of what the caller sees.
  const none = await invariantOutput(0, 0);
  const many = await invariantOutput(0, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(none, many,
    'total=0 与 total=MAX 必须给出完全相同的返回体；差异 = 侧信道');
  assert.equal(none.posts.length, 3, '对照：两个极端都确实返回了那三条可见行');
});

test('INV-4 reader：默认 transport 参数仍是 pos:0/num:20；显式 paging 逐字透传；始终单次调用', async () => {
  const seen = [];
  const msglist = [...INVARIANT_VISIBLE];
  const { reader } = setup({ transport: async (args) => {
    seen.push({ ...args });
    return { status: 'ok', retcode: 0, data: { total: 3, msglist } };
  } });
  await reader.read({ targetQq: 456, friend: true, now, source: 'requested' });
  assert.equal(seen.length, 1, '★ 单次请求，没有翻页循环');
  assert.equal(seen[0].pos, 0, 'pos 必须仍是 0');
  assert.equal(seen[0].num, 20, 'num 必须仍是 DEFAULT_PAGE_WINDOW.num(=20)');

  // t30: the page window is now caller-controlled. A second, FRESH reader is used because the read
  // id would otherwise collide (`duplicate`) — the assertion is about the transport arguments, not
  // about replay.
  const pagedSeen = [];
  const paged = setup({ transport: async (args) => {
    pagedSeen.push({ ...args });
    return { status: 'ok', retcode: 0, data: { total: 3, msglist } };
  } });
  const result = await paged.reader.read({ targetQq: 456, friend: true, now, source: 'requested' },
    { pos: 40, num: 7 });
  assert.equal(result.outcome, 'success', '前提：分页读必须真实发生');
  assert.equal(pagedSeen.length, 1, '★ 分页仍然只发一次请求（本层不翻页）');
  assert.equal(pagedSeen[0].pos, 40, '★ 调用方的 pos 必须逐字透传');
  assert.equal(pagedSeen[0].num, 7, '★ 调用方的 num 必须逐字透传');
});

// ══════════════════════════════════════════════════════════════════════════════════════
// t30 — the three read-path changes: no recency floor, images carried, paging forwarded
// ══════════════════════════════════════════════════════════════════════════════════════

test('WIN-1 窗口：8 天前 / 30 天前 / 1 年前的说说都要保留，未来的仍拒绝', async () => {
  const { _recentEnvelopeForTests: narrow } = await import('../src/core/qzone-live-friend-read.mjs');
  const rows = [
    { tid: 'today', time: now / 1000 - 60, content: 'today' },
    { tid: 'd8', time: now / 1000 - 8 * 86400, content: 'eight days' },
    { tid: 'd30', time: now / 1000 - 30 * 86400, content: 'thirty days' },
    { tid: 'd365', time: now / 1000 - 365 * 86400, content: 'a year' },
    { tid: 'future', time: now / 1000 + 30, content: 'future' },
  ];
  const narrowed = narrow({ status: 'ok', retcode: 0, data: { total: rows.length, msglist: rows } }, now);
  assert.deepEqual(narrowed.data.msglist.map((row) => row.tid), ['today', 'd8', 'd30', 'd365'],
    '★ 7 天窗口必须已经去掉：8 天/30 天/1 年前的都必须保留');
  assert.equal(narrowed.data.msglist.some((row) => row.tid === 'future'), false,
    '未来时间的行仍必须被拒绝（时钟合理性防护，不是时效策略）');
  // The upstream total still travels to the projection (which range-checks it) and no further.
  assert.equal(narrowed.data.total, rows.length, 'total 仍透传给投影层做范围校验');
});

test('IMG-1 images：有 images 的行原样带出，没有该字段的行不带', async () => {
  const { _recentEnvelopeForTests: narrow } = await import('../src/core/qzone-live-friend-read.mjs');
  const pictures = ['https://img.example/a.jpg', 'https://img.example/b.jpg'];
  const rows = [
    { tid: 'with', time: now / 1000 - 60, content: 'has pictures', images: pictures },
    { tid: 'without', time: now / 1000 - 120, content: 'no pictures' },
  ];
  const narrowed = narrow({ status: 'ok', retcode: 0, data: { total: 2, msglist: rows } }, now);
  const withRow = narrowed.data.msglist.find((row) => row.tid === 'with');
  const withoutRow = narrowed.data.msglist.find((row) => row.tid === 'without');
  assert.deepEqual(withRow.images, pictures,
    '★ images 必须原样透传 —— 投影层做 URL 白名单，这一层不校验也不改写');
  assert.equal(Object.hasOwn(withoutRow, 'images'), false,
    '没有 images 字段的行不得凭空多出一个空数组');
  // A hostile getter must not be executed: the descriptor read is what makes this safe.
  const hostile = { tid: 'hostile', time: now / 1000 - 60, content: 'x' };
  Object.defineProperty(hostile, 'images', { enumerable: true, get() { throw new Error('getter ran'); } });
  const hostileNarrowed = narrow({ status: 'ok', retcode: 0, data: { total: 1, msglist: [hostile] } }, now);
  assert.equal(Object.hasOwn(hostileNarrowed.data.msglist[0], 'images'), false,
    'accessor 型 images 必须被忽略（不得执行 getter）');
});

test('PAGE-1 分页：read(..., {pos, num}) 原样传给 transport；不传则仍是 pos:0/num:20', async () => {
  // ONE READ PER FIXTURE. The store refuses a second read with the same readId (`duplicate`), and a
  // sequence of ids cannot be used either: the reader verifies the proof TWICE (before and after the
  // platform call) and requires `sameProof`, so a proof that changes between the two calls is
  // correctly rejected as `unverified`. A fresh store per read keeps each assertion about paging.
  async function oneRead(paging) {
    const seen = [];
    const { reader } = setup({ transport: async (args) => {
      seen.push({ ...args });
      return { status: 'ok', retcode: 0, data: { total: 1, msglist: [
        { tid: 'p1', time: now / 1000 - 5, content: 'x' },
      ] } };
    } });
    const result = await reader.read({ targetQq: 456 }, paging);
    assert.equal(result.outcome, 'success', '前提：这次读必须真实发生: ' + JSON.stringify(result));
    assert.equal(seen.length, 1, '分页请求仍是单次调用（本层不做翻页循环）');
    return seen[0];
  }

  const paged = await oneRead({ pos: 20, num: 10 });
  assert.equal(paged.pos, 20, 'pos 必须被透传');
  assert.equal(paged.num, 10, 'num 必须被透传');

  const defaults = await oneRead(undefined);
  assert.equal(defaults.pos, 0, '不传 paging 时必须回到 pos:0');
  assert.equal(defaults.num, 20, '不传 paging 时必须回到 num:20');

  const half = await oneRead({ num: 5 });
  assert.equal(half.pos, 0, '只给 num 时 pos 取默认 0');
  assert.equal(half.num, 5, '给了 num 就用它');
});

test('PAGE-2 分页参数非法 ⇒ 抛出且不调用 transport（坏窗口不得花掉一次读）', async () => {
  let calls = 0;
  const { reader } = setup({ transport: async () => {
    calls += 1;
    return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
  } });
  for (const bad of [{ pos: -1 }, { pos: 1.5 }, { num: 0 }, { num: 101 }, { pos: '2' }, { num: null }, []]) {
    await assert.rejects(() => reader.read({ targetQq: 456 }, bad),
      (error) => error instanceof TypeError,
      '非法窗口必须抛 TypeError: ' + JSON.stringify(bad));
  }
  assert.equal(calls, 0, '★ 非法窗口不得发起任何平台请求');
});

test('IMG-2 images 端到端：read() 的 posts 里必须带 images（含投影层的 http/https 过滤）', async () => {
  // WHY THIS EXISTS ON TOP OF IMG-1: `recentEnvelope` carrying the field is necessary but NOT
  // sufficient — `filterOfflinePosts` rebuilds every post into `{author, id, time, content}` and
  // used to drop media on the floor, so the caller still saw no pictures. This test pins the whole
  // path, and pins that the projection's URL allowlist is what decides which entries survive.
  const { reader } = setup({ transport: async () => ({ status: 'ok', retcode: 0, data: { total: 2, msglist: [
    { tid: 'pics', time: now / 1000 - 5, content: 'with pictures',
      images: ['https://img.example/a.jpg', 'http://img.example/b.jpg', 'javascript:alert(1)', 'data:image/png;base64,xx'] },
    { tid: 'plain', time: now / 1000 - 6, content: 'no pictures' },
  ] } }) });
  const result = await reader.read({ targetQq: 456 });
  assert.equal(result.outcome, 'success');
  const pics = result.posts.find((post) => post.id === 'pics');
  const plain = result.posts.find((post) => post.id === 'plain');
  assert.deepEqual(pics.images, ['https://img.example/a.jpg', 'http://img.example/b.jpg'],
    '★ 图片必须到达调用方，且只有 http/https 两种 scheme 保留');
  assert.equal(Object.hasOwn(plain, 'images'), false,
    '没有图片的帖子不得凭空多出一个空数组');
});

// ── t37: ONE 7-day window for everyone, the administrator's own space included ───────────────
test('管理员读自己的空间同样只看 7 天内：一个窗口，不因身份放宽', async () => {
  // The operator's ruling: "if reading the administrator's full history is a large change, make
  // it a uniform 7-day read instead." So this pins the AGREED behaviour rather than a defect:
  // there is no admin branch on the friend path, and the policy module is the only place that
  // decides recency. If someone later adds an admin bypass, this case fails and they must ask.
  const { canReadPost } = await import('../src/core/qzone-policy-offline.mjs');
  const at = Date.parse('2026-11-17T00:00:00Z');
  const ADMIN = '1234567890';
  const scope = { author: ADMIN, friend: true, now: at };
  for (const [days, expected] of [[0, true], [6, true], [7, true], [8, false], [30, false], [400, false]]) {
    const post = { author: ADMIN, id: 'p' + days, time: at - days * 86400000, content: 'x' };
    assert.equal(canReadPost(post, scope), expected,
      days + ' 天前的说说：期望 ' + expected + '（统一 7 天窗口）');
  }
  // And there is NO admin bypass reachable from a friend scope: the flag must be explicit.
  assert.equal(canReadPost({ author: ADMIN, id: 'p8', time: at - 8 * 86400000, content: 'x' },
    { author: ADMIN, friend: true, now: at, admin: false }), false,
    'admin:false 不得放宽窗口');
  // A future-dated row is still refused regardless of identity.
  assert.equal(canReadPost({ author: ADMIN, id: 'pf', time: at + 1000, content: 'x' }, scope), false,
    '未来时间戳仍必须拒绝');
});

// ══════════════════════════════════════════════════════════════════════════════════════
// t50 — a `plain-comments` read must not keep a friendship verdict it got BEFORE the I/O.
// ══════════════════════════════════════════════════════════════════════════════════════
//
// THE DEFECT THIS PINS. Both friend checks used to be spelled `!scope`. The plain-comments
// scope is DERIVED between them, so the pre-dispatch check ran (scope was still null) and the
// post-I/O re-check did NOT (scope existed by then). A friendship revoked during the platform
// call was therefore invisible on exactly one path, while an ordinary `read_posts` — whose scope
// stays null — was re-checked. Two reads, two different answers to the same question.

test('t50 plain-comments：I/O 期间好友关系失效 ⇒ unknown，绝不返回已取到的评论', async () => {
  const now = Date.parse('2026-11-18T04:00:00Z');
  let state = { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: true }, reads: 0, writes: 0, readAttempts: {}, readOutcomes: {},
    notices: [], browseDay: '2026-11-18', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
    activeStart: 0, activeEnd: 1439, audit: [], grants: {}, commentEvidence: {} };
  const store = { read: () => structuredClone(state),
    update(fn) { state = fn(structuredClone(state)); return structuredClone(state); } };
  const proof = { id: 'fc1', sourceProofId: 'src1', source: 'requested', targetQq: 456, botQq: 123, connectionEpoch: 8 };
  // A page that WOULD be returned if the re-check were skipped — so "comments: []" below cannot be
  // explained by an empty or filtered page.
  const detail = { status: 'ok', retcode: 0, data: { tid: 'post-1', content: 'body', comment_num: 1, comments: [
    { comment_id: 'c1', uin: 789, name: 'nick', time: Math.floor((now - 1000) / 1000), content: 'recent', replies: [] },
  ] } };
  // FIRST call ⇒ still a friend (pre-dispatch gate passes). SECOND call (after the platform
  // returned) ⇒ null, i.e. the friendship is gone.
  let friendshipCalls = 0;
  const reader = createQzoneLiveFriendRead({
    store, clock: () => now, offlineTestFixture: true,
    verifyRequestProof: async () => proof,
    verifyFriendship: async () => {
      friendshipCalls += 1;
      return friendshipCalls === 1
        ? { status: 'friend', sourceProofId: proof.sourceProofId, botQq: proof.botQq,
          targetQq: proof.targetQq, connectionEpoch: proof.connectionEpoch }
        : null;
    },
    exceptionReads: { adminQq: '999',
      // No host scope ⇒ the reader DERIVES `plain-comments`, which is exactly the path under test.
      resolveScope: async () => null,
      isScopeCurrent: () => true, finishScope: () => {}, contextFor: () => ({ readId: 'fc1' }) },
    transport: async () => detail,
  });

  const result = await reader.readComments({ targetQq: 456 }, 'post-1');

  assert.equal(friendshipCalls, 2,
    '好友关系必须被查两次（派发前 + I/O 后）：只查一次就说明复查被跳过了');
  assert.deepEqual(result, { allowed: true, outcome: 'unknown', comments: [] },
    '★ 好友在 I/O 期间失效 ⇒ 必须 unknown 且零评论，而不是把已取到的评论交出去');
  assert.equal(Object.hasOwn(result, 'parent'), false, '拒绝时不得返回 parent 身份信息');
});