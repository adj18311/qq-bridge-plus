#!/usr/bin/env node
// test-qzone-breaker-wiring.mjs —— M2：把 success / unknown / network_unavailable 接进双层熔断
//
// WHY THIS EXISTS: 政策（qzone-policy-offline.mjs 的 nextFailureState / IMMEDIATE_PAUSE）早就完整，
// 但生产链**从未**把真实结果送进它 —— 熔断在线上等于不存在。codex 只放行三态：
// success / unknown / network_unavailable。failed / not-sent / refused 不结算，
// failure / login_expired / captcha **不接线**（写链产不出可信判据）。
//
// 钉住的七件事：
//   BW-1 写链 success ⇒ settle 一次、连续失败计数清零
//   BW-2 写链 unknown ⇒ settle 一次、计数不变、不重试
//   BW-3 写链 blocked ⇒ **零结算**，且配额仍被消耗
//   BW-4 未预期 outcome（failed/not-sent/refused）⇒ 不结算但留日志（直接测共享函数）
//   BW-5 结算抛错     ⇒ 真实 outcome/sent 保留 + settlementFailed:true，不重试
//   BW-6 重复结算同一操作 ⇒ 不重复计数（settleOfflineWrite 自带幂等）
//   BW-7 读链 gateway_unavailable ⇒ network_unavailable；其它非 success 仍 unknown
//
// 全部用临时 SQLite + 假 send/transport，不连 QQ、不发任何请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { initializeReplayState } from '../src/core/qzone-replay-claim-offline.mjs';
import { createQzoneOriginLedger, isOriginLedgerConsumption } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneOperationAuthorizer } from '../src/core/qzone-operation-authorization-offline.mjs';
import { createOfflineWritePath } from '../src/core/qzone-write-path-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { settleOfflineWrite } from '../src/core/qzone-settlement-offline.mjs';
import { createQzonePublishAuthorizer, settleApprovedWriteOutcome } from '../src/core/qzone-approved-publish-dispatch-offline.mjs';
import { createQzoneLiveFriendRead } from '../src/core/qzone-live-friend-read.mjs';

const NOW = Date.parse('2026-11-15T04:00:00Z');
const ACCOUNT = 123;
const SESSION = 's1';
const REQUEST = 'request-1';
const SOURCE = 'qq';
const PUBLISH_INPUT = Object.freeze({ content: 'hello world', ugc_right: 1 });

const baseState = (extra = {}) => ({
  enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
  tools: { publish: true, comment: true, reply: true, like: true, read_posts: true },
  limits: { post: 10, comment: 25, like: 30 },
  ledger: { day: beijingDay(NOW), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
  lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [], commentEvidence: [], audit: [],
  reads: 0, writes: 0, readAttempts: {}, readOutcomes: {}, notices: [],
  // M1（6df735a）之后真实库一定有 outcomes；结算缺它会直接抛 'missing reservation or invalid
  // settlement state'。这里带着它，才是在测这条新接的线，而不是测一个必抛的库。
  outcomes: {},
  browseDay: '2026-11-15', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
  activeStart: 0, activeEnd: 1439,
  ...extra,
});

function tempStore(t, state = baseState()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-bw-'));
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

/** A real branded consumption. A fresh ledger per consumption: consume() retires a callId. */
function consumptionFor(callId = 'cp') {
  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1' });
  ledger.registerBridgeRequest({ requestId: REQUEST, origin: 'qq-inbound' });
  ledger.observeStep({ sessionId: SESSION, turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: REQUEST } }] });
  ledger.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn: 1, step: 1, callId } } });
  const consumption = ledger.consume({ sessionId: SESSION, callId, turn: 1, step: 1 });
  assert.equal(isOriginLedgerConsumption(consumption), true, '前提：真实账本签发的 consumption');
  return consumption;
}

/** 真实 publish 组合层：真 store / 真 authorizer / 真 write path，只有 send 是桩。 */
function publishWorld(t, options = {}) {
  const store = options.store ?? tempStore(t, options.state ?? baseState());
  const live = { now: NOW, current: true };
  const authorizer = createQzoneOperationAuthorizer({
    store, accountId: ACCOUNT, sourceEpoch: 'e1', clock: () => live.now,
    approveOperation: () => true, isCurrent: () => live.current,
  });
  const sent = [];
  const send = async (payload) => {
    sent.push(payload);
    return options.send === undefined ? { ok: true } : options.send(payload);
  };
  const writePath = (transport) => createOfflineWritePath({
    store, clock: () => live.now,
    transport: options.wrapDispatch === undefined ? transport : (d) => transport(options.wrapDispatch(d)),
  });
  const logs = [];
  // `settleStore: null` = 本层不接结算（模拟未接线）；缺省 = 用同一个真实库。
  const facade = () => createQzonePublishAuthorizer({
    authorizer, writePath, send, source: SOURCE,
    ...(options.settleStore === null ? {} : { store: options.settleStore ?? store }),
    log: (line) => logs.push(line),
  });
  return {
    store, sent, logs,
    run(over = {}) {
      return facade().execute({ action: 'publish', consumption: consumptionFor(over.callId ?? 'cp'),
        connectionEpoch: 0, input: PUBLISH_INPUT, ...over });
    },
  };
}

// ── BW-1 ──────────────────────────────────────────────────────────────────────────────
test('BW-1 写链 success ⇒ 结算一次、连续失败计数清零', async (t) => {
  // 前置：连续失败已经被推到 2。success 必须清零，否则熔断永远等不到第 3 次。
  const store = tempStore(t, baseState({ writes: 2 }));
  const world = publishWorld(t, { store });
  const result = await world.run();
  assert.equal(result.outcome, 'success', `前提：写链判成功 ${JSON.stringify(result)}`);
  assert.equal(world.sent.length, 1, 'send 恰一次');
  const state = store.read();
  const keys = Object.keys(state.outcomes);
  assert.equal(keys.length, 1, `必须恰好结算一条：${JSON.stringify(state.outcomes)}`);
  assert.equal(state.outcomes[keys[0]], 'success', '结算词必须是 success');
  assert.equal(state.writes, 0, '连续失败计数必须清零');
  assert.equal(Object.hasOwn(result, 'settlementFailed'), false, '结算成功时不得挂 settlementFailed');
});

// ── BW-2 ──────────────────────────────────────────────────────────────────────────────
test('BW-2 写链 unknown ⇒ 结算一次、计数不变、不重试', async (t) => {
  const store = tempStore(t, baseState({ writes: 2 }));
  // 自相矛盾的答案 ⇒ 写链自己判 unknown（"可能发出去了"），这正是熔断必须听到的事实。
  const world = publishWorld(t, { store, send: async () => ({ ok: true, outcome: 'failed' }) });
  const result = await world.run();
  assert.equal(result.outcome, 'unknown', `前提：矛盾答案被判 unknown ${JSON.stringify(result)}`);
  assert.equal(result.sent, true);
  assert.equal(world.sent.length, 1, '绝不重试：send 仍只一次');
  const state = store.read();
  const keys = Object.keys(state.outcomes);
  assert.equal(keys.length, 1);
  assert.equal(state.outcomes[keys[0]], 'unknown', '结算词必须是 unknown，不得折成 success/failure');
  assert.equal(state.writes, 2, 'unknown 不计失败，计数必须不变');
  assert.equal(state.writePaused, false, 'unknown 不触发暂停');
});

// ── BW-3 ──────────────────────────────────────────────────────────────────────────────
test('BW-3 写链 blocked（claim 抛错）⇒ 零结算，但配额仍被消耗', async (t) => {
  const store = tempStore(t, baseState());
  // 真实的 claim 失败路径：replay store 的 update 抛错 ⇒ authorizer.claim 抛 ⇒ 闭包置 blocked。
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
    source: SOURCE, store, log: (line) => logs.push(line),
  });
  const result = await facade.execute({ action: 'publish', consumption: consumptionFor('cb'),
    connectionEpoch: 0, input: PUBLISH_INPUT });
  assert.equal(result.ok, false, `应当是一条拒发 ${JSON.stringify(result)}`);
  assert.equal(result.outcome, 'not-sent', '对外必须报 not-sent（请求没离开进程）');
  assert.equal(result.reason, 'claim-failed', `拒发原因必须是 claim-failed：${JSON.stringify(result)}`);
  assert.equal(sent.length, 0, 'send 零次');
  const state = store.read();
  assert.deepEqual(Object.keys(state.outcomes), [], `blocked 必须零结算：${JSON.stringify(state.outcomes)}`);
  assert.equal(state.writes, 0, 'blocked 不计平台失败');
  assert.equal(state.ledger.used.post, 1, '配额仍然被消耗（预约已发生，没有退还路径）');
  assert.equal(result.quotaConsumed, true, '返回体必须如实说明配额被消耗');
  assert.deepEqual(logs, [], 'blocked 不是「未预期 outcome」，不该刷日志');
});

// ── BW-4 ──────────────────────────────────────────────────────────────────────────────
test('BW-4 未预期 outcome（failed/not-sent/refused）⇒ 不结算，但留一行日志', () => {
  // 直接测共享函数：三个词都必须走「不结算 + 留痕」这一条分支。
  for (const outcome of ['failed', 'not-sent', 'refused']) {
    const store = { read: () => ({ ledger: { reservations: {} }, outcomes: {} }), update: () => { throw new Error('must not settle'); } };
    const logs = [];
    const result = settleApprovedWriteOutcome({ store, id: 'op-x', blocked: null, outcome, log: (l) => logs.push(l) });
    assert.equal(result.settled, false, `${outcome} 不得结算`);
    assert.equal(result.failed, false, `${outcome} 不是结算失败`);
    assert.equal(logs.length, 1, `${outcome} 必须留一行日志`);
    assert.match(logs[0], new RegExp(outcome.replace('not-sent', 'not-sent')), `日志必须点出实际出现的是哪个词`);
    assert.match(logs[0], /本轮不结算/, '日志必须说清「本轮不结算」');
  }
  // 未接线（没有 store）时：安静地不结算，不产生日志、不抛。
  const logs = [];
  const offline = settleApprovedWriteOutcome({ blocked: null, outcome: 'success', log: (l) => logs.push(l) });
  assert.deepEqual(offline, { settled: false, failed: false }, '没有 store ⇒ 不结算');
  assert.deepEqual(logs, [], '没有 store ⇒ 不刷日志');
  // blocked 优先于一切：即便 outcome 是 success 也不结算。
  const both = settleApprovedWriteOutcome({ store: { update() { throw new Error('must not settle'); } },
    id: 'op-y', blocked: { reason: 'not-authorized' }, outcome: 'success' });
  assert.deepEqual(both, { settled: false, failed: false }, 'blocked 时无论 outcome 是什么都不结算');
});

// ── BW-5 ──────────────────────────────────────────────────────────────────────────────
test('BW-5 结算抛错 ⇒ 返回体保留真实 outcome/sent/quotaConsumed，挂 settlementFailed:true，不重试', async (t) => {
  const store = tempStore(t, baseState());
  // 结算目标是一个 update 一定抛错的库：结算失败，但**写本身成功了**。
  const brokenSettle = {
    read: () => store.read(),
    update: () => { throw new Error('settlement store unavailable'); },
  };
  const world = publishWorld(t, { store, settleStore: brokenSettle });
  const result = await world.run();
  assert.equal(result.ok, true, `写成功了，返回体不得因为结算失败而变 ${JSON.stringify(result)}`);
  assert.equal(result.outcome, 'success', '真实 outcome 必须保留');
  assert.equal(result.sent, true, 'sent 必须保留 true');
  assert.equal(result.quotaConsumed, true, 'quotaConsumed 必须保留');
  assert.equal(result.settlementFailed, true, '必须额外挂 settlementFailed:true');
  assert.equal(world.sent.length, 1, '不重试：send 仍只一次');
  // 结算确实没落进真实库（它指向的是坏库），且真实库里的计数没被改。
  assert.deepEqual(Object.keys(store.read().outcomes), [], '坏库上的结算不得污染真实库');
});

// ── BW-6 ──────────────────────────────────────────────────────────────────────────────
test('BW-6 重复结算同一操作 ⇒ 不重复计数（settleOfflineWrite 自带幂等）', async (t) => {
  const store = tempStore(t, baseState({ writes: 2 }));
  world: {
    const world = publishWorld(t, { store });
    const result = await world.run();
    assert.equal(result.outcome, 'success');
    assert.equal(store.read().writes, 0, '第一次结算把计数清零');
  }
  const keys = Object.keys(store.read().outcomes);
  assert.equal(keys.length, 1, '只有一个操作 id 被结算');
  const id = keys[0];
  // 同一个 id、同一个 outcome 再来两次：applied=false，但状态必须**逐字不变**。
  const before = JSON.stringify(store.read());
  const again1 = settleOfflineWrite(store, id, 'success');
  const again2 = settleOfflineWrite(store, id, 'success');
  assert.deepEqual(again1, { applied: false }, '第二次结算必须报告 applied:false');
  assert.deepEqual(again2, { applied: false }, '第三次同理');
  assert.equal(JSON.stringify(store.read()), before, '重复结算不得改变任何状态（不重复计数）');
  // 而一个**不同**的 outcome 必须被拒绝，而不是被当成又一次成功。
  assert.throws(() => settleOfflineWrite(store, id, 'unknown'), /conflicting outcome/,
    '同一个 id 换个 outcome 必须冲突报错，不能悄悄改写');
  assert.equal(JSON.stringify(store.read()), before, '冲突报错也不得留下改动');
});

// ── BW-7 ──────────────────────────────────────────────────────────────────────────────
/** 读链的最小世界：真 reader + 假 transport/proof/friendship。 */
function readWorld(t, { transport, store = tempStore(t, baseState()), clock = () => NOW } = {}) {
  const reader = createQzoneLiveFriendRead({
    store, clock, offlineTestFixture: true, transport,
    verifyRequestProof: async () => ({ id: 'r1', sourceProofId: 'src1', source: 'requested',
      targetQq: 456, botQq: 123, connectionEpoch: 8 }),
    verifyFriendship: async (proof) => ({ status: 'friend', sourceProofId: proof.sourceProofId,
      botQq: proof.botQq, targetQq: proof.targetQq, connectionEpoch: proof.connectionEpoch }),
  });
  return { reader, store };
}
const OK_PAGE = Object.freeze({ status: 'ok', retcode: 0, data: { total: 1, msglist: [
  { tid: 'fresh', time: NOW / 1000 - 5, content: 'recent' }] } });

test('BW-7a 读链 gateway_unavailable ⇒ 结算 outcome=network_unavailable', async (t) => {
  const { reader, store } = readWorld(t, { transport: async () => ({ status: 'gateway_unavailable' }) });
  const result = await reader.read({ targetQq: 456 });
  assert.equal(result.outcome, 'unknown', `对外仍报 unknown（不把平台数据伪装出来）${JSON.stringify(result)}`);
  const state = store.read();
  assert.equal(state.readOutcomes.r1, 'network_unavailable',
    `结算词必须是 network_unavailable：${JSON.stringify(state.readOutcomes)}`);
  const row = state.audit.find((e) => e.id === 'read:r1');
  assert.ok(row, '必须落一条读结果审计');
  assert.equal(row.record.result, 'failure', 'network_unavailable 在审计里是 failure');
  assert.equal(row.record.reason, 'network', 'reason 必须是 network（settlement 的固定映射）');
  assert.equal(state.accessPaused, true, 'network_unavailable 属于 IMMEDIATE_PAUSE ⇒ 首次即暂停访问');
});

test('BW-7b 读链普通失败（非 gateway_unavailable）⇒ 仍是 unknown，不扩大', async (t) => {
  // 平台答了一个非 ok 信封：不是网关不可用，不能升级成 network_unavailable。
  const { reader, store } = readWorld(t, { transport: async () => ({ status: 'failed', retcode: -1 }) });
  const result = await reader.read({ targetQq: 456 });
  assert.equal(result.outcome, 'unknown', '对外仍是 unknown');
  const state = store.read();
  assert.equal(state.readOutcomes.r1, 'unknown', '结算词必须仍是 unknown');
  assert.equal(state.accessPaused, false, 'unknown 不暂停访问');
  assert.equal(state.reads, 0, 'unknown 不计失败');
  // 成功路径的正对照：同一个世界换成正常信封，必须结算 success 且清零计数。
  const ok = readWorld(t, { transport: async () => OK_PAGE, store: tempStore(t, baseState({ reads: 2 })) });
  const okResult = await ok.reader.read({ targetQq: 456 });
  assert.equal(okResult.outcome, 'success');
  assert.equal(ok.store.read().readOutcomes.r1, 'success', '正对照：成功必须结算 success');
  assert.equal(ok.store.read().reads, 0, '正对照：success 清零连续失败计数');
});

// ── BW-8：未接线声明（静态，防有人顺手把禁止的三态塞进来） ──────────────────────────
test('BW-8 failure / login_expired / captcha 未接线：写链映射表只认 success 与 unknown', async () => {
  const source = fs.readFileSync(new URL('../src/core/qzone-approved-publish-dispatch-offline.mjs', import.meta.url), 'utf8');
  const fnStart = source.indexOf('export function settleApprovedWriteOutcome');
  assert.ok(fnStart > 0, '共享结算函数必须存在');
  const fnEnd = source.indexOf('\n}', fnStart);
  const body = source.slice(fnStart, fnEnd);
  // 只允许 success / unknown 被写进 settleOfflineWrite。
  assert.equal(/word = 'failure'/.test(body), false, '写链不得把 failure 接进结算（产不出可信判据）');
  assert.equal(/login_expired/.test(body), false, '写链不得把 login_expired 接进结算');
  assert.equal(/captcha/.test(body), false, '写链不得把 captcha 接进结算');
  assert.match(body, /word = 'success'/, 'success 必须接线');
  assert.match(body, /word = 'unknown'/, 'unknown 必须接线');
  // 读链同理：只有 gateway_unavailable 这一个码级判据能升级。
  const readSource = fs.readFileSync(new URL('../src/core/qzone-live-friend-read.mjs', import.meta.url), 'utf8');
  assert.equal(/login_expired/.test(readSource), false, '读链不得把 login_expired 接进结算');
  assert.equal(/captcha/.test(readSource), false, '读链不得把 captcha 接进结算');
  assert.match(readSource, /network_unavailable/, '读链必须接 network_unavailable');
});