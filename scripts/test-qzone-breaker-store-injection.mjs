#!/usr/bin/env node
// test-qzone-breaker-store-injection.mjs —— M3：把 store 接进生产装配点，让 M2 接好的结算线通电
//
// WHY THIS EXISTS:
//   M2（1a2b8cb）把 success/unknown/blocked 接进了 settleOfflineWrite，但生产装配点
//   （qzone-runtime-wiring.mjs 的两个 authorizer 构造处）**没传 store**，于是
//   settleApprovedWriteOutcome 每次都返回 {settled:false}，熔断一行都没数过。
//   M3 把 runtime 自己的可写 store 传下去，这份用例证明它真的通了。
//
// 钉住的事：
//   SI-1 传 store ⇒ 经**真实生产装配**（createQzoneRuntime）settle 落库、writes 清零，
//        且 outcomes 的键就是那个持久的 authorizationId
//   SI-2 同一临时库、同一假 transport，**不传 store** ⇒ settled:false、state 一个字节不变
//        （这是「不传 = 不结算」的 fail-quiet 语义在新装配点上的实测）
//   SI-3 可信 failed 拿不到 ⇒ 不误记成 failure，且连续三次也不会暂停
//   SI-4 blocked ⇒ 零结算；unknown ⇒ 结算但不计数
//   SI-5 重复结算同一操作 ⇒ 不重复计数
//   SI-6 post-send 结算存储失败 ⇒ 保留真实 outcome/sent、挂 settlementFailed、不重试
//
// 全部用临时 SQLite + 假 send，不连 QQ、不发任何请求、不碰仓库 state/。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { initializeReplayState } from '../src/core/qzone-replay-claim-offline.mjs';
import { createQzoneOriginLedger, isOriginLedgerConsumption } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createOfflineWritePath } from '../src/core/qzone-write-path-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { settleOfflineWrite } from '../src/core/qzone-settlement-offline.mjs';
import { createQzoneOperationAuthorizer } from '../src/core/qzone-operation-authorization-offline.mjs';
import { createQzonePublishAuthorizer } from '../src/core/qzone-approved-publish-dispatch-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

const NOW = Date.parse('2026-11-15T04:00:00Z');
const ACCOUNT = 123;
const SESSION = 's1';
const REQUEST = 'request-1';
const PUBLISH_INPUT = Object.freeze({ content: 'hello world', ugc_right: 1 });
/** The write path enforces a 2-hour interval between posts (`lastPostAt`), so repeated dispatches
 *  in one test must be spaced by exactly that much. */
const TWO_HOURS = 7_200_000;

/** Every field the real store needs for gate / reservation / quota / settlement. */
function initialState(extra = {}) {
  return {
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 10, comment: 25, like: 30 },
    ledger: { day: beijingDay(NOW), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [], commentEvidence: [], audit: [],
    reads: 0, writes: 0, readAttempts: {}, readOutcomes: {},
    browseDay: beijingDay(NOW), todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
    activeStart: 0, activeEnd: 1439,
    // settlement 需要这两个；M1（6df735a）之后真实库一定有。
    outcomes: {}, notices: [],
    ...extra,
  };
}

function tempStore(t, state = initialState()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-si-'));
  const store = openOfflineStore(path.join(dir, 'state.db'), state);
  t.after(() => {
    try { store.close(); } catch {}
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
    }
  });
  assert.equal(initializeReplayState(store, { now: NOW }).ok, true, '前提：replay 集合已初始化');
  return store;
}

function consumptionFor(callId) {
  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1' });
  ledger.registerBridgeRequest({ requestId: REQUEST, origin: 'qq-inbound' });
  ledger.observeStep({ sessionId: SESSION, turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: REQUEST } }] });
  ledger.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn: 1, step: 1, callId } } });
  const consumption = ledger.consume({ sessionId: SESSION, turn: 1, step: 1, callId });
  assert.equal(isOriginLedgerConsumption(consumption), true, '前提：真实账本签发的 consumption');
  return consumption;
}

/**
 * The REAL production assembly: `createQzoneRuntime` with a real writeWiring.
 *
 * This is the point of M3 — the store reaches the compositions through the runtime's own
 * `buildWriteWiring`, NOT through anything this fixture does. If the wiring dropped it again,
 * every assertion below about `outcomes` would fail.
 */
function productionRuntime(t, options = {}) {
  const store = options.store ?? tempStore(t);
  // `live.now` is advanceable: the write path enforces a 2-hour interval between posts, so a test
  // that dispatches more than once MUST move the clock (otherwise it measures the interval, not the
  // settlement).
  const live = { now: NOW, epoch: 8 };
  const advance = (ms) => { live.now += ms; };
  const sent = [];
  const send = async (payload) => {
    sent.push(payload);
    return options.send === undefined ? { ok: true } : options.send(payload);
  };
  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1' });
  ledger.registerBridgeRequest({ requestId: REQUEST, origin: 'qq-inbound' });
  // One observed step, then one observed tool/call per dispatch (the ledger's own ordering rule).
  assert.equal(ledger.observeStep({ sessionId: SESSION, turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: REQUEST } }] }), true, '前提：step 已记录');
  const runtime = createQzoneRuntime({
    store, botQq: ACCOUNT, sourceEpoch: 'e1',
    getConnectionEpoch: () => live.epoch,
    authorizeSource: (consumption) => ledger.ownsConsumption(consumption),
    getBridgeSessions: (sessionId) => (sessionId === SESSION ? ledger : null),
    clock: () => live.now,
    mode: 'enabled',
    call: async (action) => {
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: ACCOUNT } };
      if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
      throw new Error(`unexpected fixture action ${action}`);
    },
    operationAuthorization: { replayStore: store, approveOperation: () => true },
    writeWiring: {
      send, source: 'qq', actions: ['publish'],
      writePath: (transport) => createOfflineWritePath({ store, clock: () => live.now, transport }),
    },
  });
  let seq = 0;
  async function dispatch() {
    seq += 1;
    // Space the dispatches past the 2-hour post interval so each one reaches the transport.
    live.now = NOW + (seq - 1) * TWO_HOURS;
    const callId = `c${seq}`;
    assert.equal(ledger.observeToolCall({
      sessionId: SESSION, event: { type: 'tool/call', data: { turn: 1, step: 1, callId } },
    }), true, '前提：tool/call 已记录');
    return runtime.dispatch('publish', PUBLISH_INPUT, { sessionId: SESSION, callId });
  }
  return { store, sent, runtime, dispatch, advance };
}

// ── SI-1：传 store ⇒ 真实生产装配下 settle 落库、writes 清零 ───────────────────────────
test('SI-1 经真实 createQzoneRuntime 的 publish success ⇒ outcomes 落库、writes 清零', async (t) => {
  // 前置：连续失败计数已经被推到 2，success 必须清零，否则熔断永远等不到第 3 次。
  const store = tempStore(t, initialState({ writes: 2 }));
  const world = productionRuntime(t, { store });
  const result = await world.dispatch();
  assert.equal(result.ok, true, `写应当成功：${JSON.stringify(result)}`);
  assert.equal(result.outcome, 'success');
  assert.equal(result.sent, true);
  assert.equal(world.sent.length, 1, 'send 恰一次');
  const state = store.read();
  const keys = Object.keys(state.outcomes);
  assert.equal(keys.length, 1, `必须恰好结算一条：${JSON.stringify(state.outcomes)}`);
  assert.equal(state.outcomes[keys[0]], 'success', '结算词必须是 success');
  assert.equal(state.writes, 0, '连续失败计数必须清零（证明这一行真的通了电）');
  assert.equal(Object.hasOwn(result, 'settlementFailed'), false, '结算成功时不得挂 settlementFailed');
  // 结算键就是那个持久的 authorizationId —— 也就是 ledger.reservations 的键。
  assert.equal(Object.hasOwn(state.ledger.reservations, keys[0]), true,
    'outcomes 的键必须与 ledger.reservations 同键（同一个库、同一个 id）');
});

// ── SI-2：不传 store ⇒ 与改动前逐字一致 ────────────────────────────────────────────────
test('SI-2 同一临时库、同一假 send，不经运行时（组合层不传 store）⇒ settled:false 且 state 无变化', async (t) => {
  const store = tempStore(t, initialState({ writes: 2 }));
  const live = { now: NOW };
  const authorizer = createQzoneOperationAuthorizer({
    store, accountId: ACCOUNT, sourceEpoch: 'e1', clock: () => live.now,
    approveOperation: () => true, isCurrent: () => true,
  });
  const sent = [];
  const facade = createQzonePublishAuthorizer({
    authorizer,
    writePath: (transport) => createOfflineWritePath({ store, clock: () => live.now, transport }),
    send: async (p) => { sent.push(p); return { ok: true }; },
    source: 'qq',
    // store 刻意不传 —— 这就是「未接线」路径。
  });
  const before = store.read();
  const result = await facade.execute({ action: 'publish', consumption: consumptionFor('c1'),
    connectionEpoch: 0, input: PUBLISH_INPUT });
  assert.equal(result.ok, true, '写本身必须照常成功');
  assert.equal(result.outcome, 'success');
  assert.equal(sent.length, 1, 'send 仍恰一次');
  assert.equal(Object.hasOwn(result, 'settlementFailed'), false, '未接线不是「结算失败」，不得挂 settlementFailed');
  const after = store.read();
  // 只断言**结算那部分**没变。B2 claim / 配额 / lastPostAt 本来就该变 —— 那是写入本身，
  // 不是结算；拿整个 state JSON 比对会把「写成功」误判成「结算发生了」。
  assert.deepEqual(after.outcomes, before.outcomes, '不传 store ⇒ outcomes 一个字节都不许变');
  assert.deepEqual(Object.keys(after.outcomes), [], '不传 store ⇒ outcomes 保持空');
  assert.equal(after.writes, before.writes, '不传 store ⇒ 连续失败计数保持原值');
  assert.equal(after.notices.length, before.notices.length, '不传 store ⇒ 不产生任何熔断通知');
  assert.equal(after.accessPaused, before.accessPaused);
  assert.equal(after.writePaused, before.writePaused);
  // 正对照：写入本身确实发生了（否则上面的「没结算」就成了空断言）。
  assert.equal(after.ledger.used.post, 1, '配额必须被消耗 —— 写入真的发生了');
  assert.equal(Object.keys(after.usedReadKeys ?? {}).length, 1, 'B2 claim 必须落在同一库');
});

// ── SI-3：拿不到可信 failed ⇒ 不误记 failure，三次也不暂停 ─────────────────────────────
test('SI-3 可信 failure 无可信分类：三次矛盾答案都不计入失败，也不会触发写熔断', async (t) => {
  const store = tempStore(t, initialState());
  // 自相矛盾的答案 ⇒ 写链判 unknown（"可能发出去了"），这正是当前唯一能得到的不确定分类。
  const world = productionRuntime(t, { store, send: async () => ({ ok: true, outcome: 'failed' }) });
  for (let i = 1; i <= 3; i += 1) {
    const result = await world.dispatch();
    assert.equal(result.outcome, 'unknown', `第 ${i} 次必须是 unknown：${JSON.stringify(result)}`);
  }
  const state = store.read();
  assert.equal(Object.keys(state.outcomes).length, 3, '三次操作各结算一条');
  assert.ok(Object.values(state.outcomes).every((word) => word === 'unknown'),
    `三次都必须是 unknown，绝不能因为 failed 就记成 failure：${JSON.stringify(state.outcomes)}`);
  assert.equal(state.writes, 0, 'unknown 不计失败，三次之后计数仍是 0');
  assert.equal(state.writePaused, false,
    '三次失败熔断**不**会在这里触发 —— 因为在拿不到可信 failure 之前它根本不该触发');
  assert.equal(world.sent.length, 3, '每次都是真发出去一次（未重试）');
});

// ── SI-4：blocked 零结算 / unknown 不计数 ───────────────────────────────────────────────
test('SI-4a blocked（claim 抛错）⇒ 零结算，配额仍消耗', async (t) => {
  const store = tempStore(t, initialState());
  const brokenReplay = { read: () => store.read(), update: () => { throw new Error('claim store unavailable'); } };
  const authorizer = createQzoneOperationAuthorizer({
    store: brokenReplay, accountId: ACCOUNT, sourceEpoch: 'e1', clock: () => NOW,
    approveOperation: () => true, isCurrent: () => true,
  });
  const sent = [];
  const logs = [];
  const facade = createQzonePublishAuthorizer({
    authorizer,
    writePath: (transport) => createOfflineWritePath({ store, clock: () => NOW, transport }),
    send: async (p) => { sent.push(p); return { ok: true }; },
    source: 'qq', store, log: (line) => logs.push(line),
  });
  const result = await facade.execute({ action: 'publish', consumption: consumptionFor('cb'),
    connectionEpoch: 0, input: PUBLISH_INPUT });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'not-sent');
  assert.equal(result.reason, 'claim-failed');
  assert.equal(sent.length, 0, 'send 零次');
  const state = store.read();
  assert.deepEqual(Object.keys(state.outcomes), [], `blocked 必须零结算：${JSON.stringify(state.outcomes)}`);
  assert.equal(state.writes, 0, 'blocked 不计平台失败');
  assert.equal(state.ledger.used.post, 1, '配额仍被消耗（预约已发生）');
  assert.equal(result.quotaConsumed, true);
  assert.deepEqual(logs, [], 'blocked 不是「未预期 outcome」，不刷日志');
});

test('SI-4b unknown ⇒ 结算一次但不计数、不暂停', async (t) => {
  const store = tempStore(t, initialState({ writes: 2 }));
  const world = productionRuntime(t, { store, send: async () => ({ ok: true, outcome: 'failed' }) });
  const result = await world.dispatch();
  assert.equal(result.outcome, 'unknown');
  const state = store.read();
  const keys = Object.keys(state.outcomes);
  assert.equal(keys.length, 1);
  assert.equal(state.outcomes[keys[0]], 'unknown');
  assert.equal(state.writes, 2, 'unknown 不改计数');
  assert.equal(state.writePaused, false, 'unknown 不暂停');
});

// ── SI-5：幂等 ────────────────────────────────────────────────────────────────────────
test('SI-5 重复结算同一操作 ⇒ 不重复计数，且状态逐字不变', async (t) => {
  const store = tempStore(t, initialState({ writes: 2 }));
  const world = productionRuntime(t, { store });
  await world.dispatch();
  assert.equal(store.read().writes, 0, '第一次结算把计数清零');
  const id = Object.keys(store.read().outcomes)[0];
  const before = JSON.stringify(store.read());
  const again1 = settleOfflineWrite(store, id, 'success');
  const again2 = settleOfflineWrite(store, id, 'success');
  assert.deepEqual(again1, { applied: false }, '第二次必须报告 applied:false');
  assert.deepEqual(again2, { applied: false });
  assert.equal(JSON.stringify(store.read()), before, '重复结算不得改变任何状态（不重复计数）');
  assert.throws(() => settleOfflineWrite(store, id, 'unknown'), /conflicting outcome/,
    '同一 id 换 outcome 必须冲突报错，不能悄悄改写');
  assert.equal(JSON.stringify(store.read()), before, '冲突报错也不得留下改动');
});

// ── SI-6：post-send 结算存储失败 ───────────────────────────────────────────────────────
test('SI-6 结算存储失败 ⇒ 保留真实 outcome/sent、挂 settlementFailed、不重试', async (t) => {
  const store = tempStore(t, initialState());
  // 结算目标是一个 update 一定抛错的句柄：写本身成功，只有计数落不下去。
  const brokenSettle = { read: () => store.read(), update: () => { throw new Error('settlement store unavailable'); } };
  const live = { now: NOW };
  const authorizer = createQzoneOperationAuthorizer({
    store, accountId: ACCOUNT, sourceEpoch: 'e1', clock: () => live.now,
    approveOperation: () => true, isCurrent: () => true,
  });
  const sent = [];
  const facade = createQzonePublishAuthorizer({
    authorizer,
    writePath: (transport) => createOfflineWritePath({ store, clock: () => live.now, transport }),
    send: async (p) => { sent.push(p); return { ok: true }; },
    source: 'qq', store: brokenSettle,
  });
  const result = await facade.execute({ action: 'publish', consumption: consumptionFor('cs'),
    connectionEpoch: 0, input: PUBLISH_INPUT });
  assert.equal(result.ok, true, `写成功了，返回体不得因结算失败而变：${JSON.stringify(result)}`);
  assert.equal(result.outcome, 'success', '真实 outcome 必须保留');
  assert.equal(result.sent, true, 'sent 必须保留 true');
  assert.equal(result.quotaConsumed, true, 'quotaConsumed 必须保留');
  assert.equal(result.settlementFailed, true, '必须额外挂 settlementFailed:true');
  assert.equal(sent.length, 1, '不重试：send 仍只一次');
  assert.deepEqual(Object.keys(store.read().outcomes), [], '坏库上的结算不得污染真实库');
});
