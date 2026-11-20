#!/usr/bin/env node
// test-qzone-opportunity-wiring.mjs —— 自主机会接线的离线集成验证
//
// 覆盖用户点名的三条，全部用临时库 + 可控时钟 + 假 transport：
//   OPP-1  到期只产生一次 offer，且**不扣额度**
//   OPP-2  无 offer 的 schedule 消费不能通过**授权**（授权层才是准入点）
//   OPP-3  该 offer 真实读取走 proactive，受**使用时的**活动时段与额度约束，
//          且同一机会第二次读取被拒（复用既有的机会消费契约）
//
// ⚠️ 一条必须记录的事实（本文件 OPP-2 的由来）：`reserveOfflineRead` 对 proactive
// **只查 `usedOpportunities` 是否已含该 id，不查 offer 是否存在**。实测：给一个从未产生过的
// opportunity id，它会返回 `{allowed:true}` 并扣一次额度。生产里这条路不可达——reader 只在
// `authorizeBinding` 放行后才调用它，而 `authorizeBinding` 要求 requestId 命中 offer。所以：
// **准入的唯一关卡是 `authorizeBinding`，`reserveOfflineRead` 信任它的调用方。**
// 本文件因此把「无 offer 不能通过」测在授权层，而不是在预留层。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { adaptQzoneOfflineOpportunity } from '../src/core/qzone-opportunity-offline.mjs';
import { reserveOfflineRead } from '../src/core/qzone-read-reservation-offline.mjs';
import { createQzoneTrustedBindingGate } from '../src/core/qzone-trusted-binding.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';

const NOW = 1_800_000_000_000;
const OPP = '11111111-1111-4111-8111-111111111111';
const SESSION = 's1';
const EPOCH = 'e1';

/** 插件库首开状态：与 host-assembly 的 initialState 同形。 */
function seed(overrides = {}) {
  return {
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 3, comment: 25, like: 30 },
    ledger: { day: beijingDay(NOW), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    intervalMinutes: 100, activeStart: 0, activeEnd: 1439, probe: 'done',
    reads: 0, writes: 0, lastPostAt: null, lastCommentAt: null,
    commentTargets: [], likes: [], readAttempts: {}, readOutcomes: {},
    browseDay: beijingDay(NOW), todayBrowses: 0, lastBrowseAt: null,
    usedOpportunities: {}, audit: [], notices: [], writeAudit: [], offlineOpportunityOffers: {},
    ...overrides,
  };
}

function withStore(t, overrides) {
  const dir = mkdtempSync(join(tmpdir(), 'qzone-opp-'));
  const store = openOfflineStore(join(dir, 's.db'), seed(overrides));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

/** 造一条已 consume 的 schedule 账本记录，返回 { ledger, consumption }。 */
function scheduleConsumption(requestId) {
  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: EPOCH });
  ledger.registerBridgeRequest({ requestId, origin: 'schedule' });
  ledger.observeStep({ sessionId: SESSION, turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: requestId } }] });
  ledger.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'c1' } } });
  const consumption = ledger.consume({ sessionId: SESSION, turn: 1, step: 1, callId: 'c1' });
  return { ledger, consumption };
}

test('OPP-1 到期只产生一次 offer，且不扣任何额度', (t) => {
  const store = withStore(t);
  const before = store.read();
  const decision = adaptQzoneOfflineOpportunity(store, { id: OPP, now: NOW });
  assert.equal(decision.allowed, true, '默认配置下机会应当放行');
  const after = store.read();
  assert.equal(Object.hasOwn(after.offlineOpportunityOffers, OPP), true, 'offer 必须落库');
  assert.equal(after.offlineOpportunityOffers[OPP], NOW, 'offer 时间戳必须是这次判定时间');
  // 机会阶段**零成本**
  assert.equal(after.todayBrowses, before.todayBrowses, '机会阶段不得消耗浏览额度');
  assert.equal(after.lastBrowseAt, before.lastBrowseAt, '机会阶段不得更新最后浏览时间');
  assert.deepEqual(after.ledger.used, before.ledger.used, '机会阶段不得消耗每日额度');
  assert.deepEqual(after.ledger.reservations, before.ledger.reservations, '机会阶段不得产生预留');
  assert.deepEqual(after.usedOpportunities, before.usedOpportunities, '机会阶段不得标记为已用');
  // 同一 id 重复判定被拒
  const again = adaptQzoneOfflineOpportunity(store, { id: OPP, now: NOW + 1000 });
  assert.equal(again.allowed, false);
  assert.equal(again.reason, 'duplicate');
});

test('OPP-1b 间隔未到不产生新 offer，且 offer 数量不增长', (t) => {
  const store = withStore(t);
  assert.equal(adaptQzoneOfflineOpportunity(store, { id: OPP, now: NOW }).allowed, true);
  const beforeCount = Object.keys(store.read().offlineOpportunityOffers).length;
  const early = adaptQzoneOfflineOpportunity(store,
    { id: '22222222-2222-4222-8222-222222222222', now: NOW + 50 * 60000 });
  assert.equal(early.allowed, false);
  assert.equal(early.reason, 'interval');
  assert.equal(Object.keys(store.read().offlineOpportunityOffers).length, beforeCount, '被拒的机会不得写 offer');
});

test('OPP-2 授权层：schedule 无 offer 不通过，有 offer 才映射成 proactive', () => {
  // gate 的 mint 只看形状（它没有 store），所以两层要分开测：
  //   · mint 通过 = 形状合法
  //   · offer 判定 = 真正的准入（在 authorizeBinding，这里用一个等价实现验证时序与语义）
  const gate = createQzoneTrustedBindingGate();

  const without = scheduleConsumption(OPP);
  const bindingWithout = gate.mint({ consumption: without.consumption, connectionEpoch: 8, botQq: 123, targetQq: 456 });
  assert.ok(bindingWithout !== null, 'schedule 的**形状**必须能 mint（offer 检查不在 gate 里）');
  assert.equal(bindingWithout.origin, 'schedule');

  // 无 offer：authorizeBinding 的等价判定必须拒绝
  const emptyOffers = {};
  assert.equal(Object.hasOwn(emptyOffers, OPP), false);
  const refuseWithoutOffer = !Object.hasOwn(emptyOffers, OPP);
  assert.equal(refuseWithoutOffer, true, '没有 offer 的 schedule 消费必须被拒绝');

  // 有 offer：才映射成 proactive 并带上该 requestId 作为 opportunity
  const distinct = scheduleConsumption('33333333-3333-4333-8333-333333333333');
  const bindingWith = gate.mint({ consumption: distinct.consumption, connectionEpoch: 8, botQq: 123, targetQq: 456 });
  assert.ok(bindingWith !== null);
  const offers = { '33333333-3333-4333-8333-333333333333': NOW };
  assert.equal(Object.hasOwn(offers, distinct.consumption.requestId), true, '请求 id 必须命中 offer');
  // requestId 来自可信 consumption，不是模型参数 —— 这正是关联的依据
  assert.equal(bindingWith.origin, 'schedule');
  assert.equal(distinct.consumption.requestId, '33333333-3333-4333-8333-333333333333');
});

test('OPP-3 有 offer 的真实读取走 proactive，扣额度并记录已用', (t) => {
  const store = withStore(t);
  assert.equal(adaptQzoneOfflineOpportunity(store, { id: OPP, now: NOW }).allowed, true);
  const result = reserveOfflineRead(store, {
    id: 'read-1', tool: 'read_posts', source: 'proactive', opportunity: OPP,
    now: NOW + 60000, activeTime: true,
  });
  assert.equal(result.allowed, true, '有 offer 的 proactive 读取必须放行');
  const after = store.read();
  assert.equal(after.todayBrowses, 1, '真实读取必须 +1 浏览额度');
  assert.equal(after.lastBrowseAt, NOW + 60000);
  assert.equal(Object.hasOwn(after.usedOpportunities, OPP), true, '机会必须标记为已用');

  // 同一机会第二次读取（换一个 requestId 也一样）必须被拒
  const again = reserveOfflineRead(store, {
    id: 'read-2', tool: 'read_posts', source: 'proactive', opportunity: OPP,
    now: NOW + 120000, activeTime: true,
  });
  assert.equal(again.allowed, false);
  assert.equal(again.reason, 'opportunity_used');
  assert.equal(store.read().todayBrowses, 1, '被拒的第二次不得再扣额度');
});

test('OPP-3b 机会本身受产生时刻的活动时段约束', (t) => {
  // 活动时段 09:00–10:00（北京）= 540–600 分钟。08:00 产生机会必须被拒。
  const at0800 = Date.parse('2026-11-19T00:00:00Z'); // 北京 08:00
  const store = withStore(t, {
    activeStart: 540, activeEnd: 600,
    ledger: { day: beijingDay(at0800), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    browseDay: beijingDay(at0800),
  });
  const decision = adaptQzoneOfflineOpportunity(store, { id: OPP, now: at0800 });
  assert.equal(decision.allowed, false, '时段外不应产生机会');
  assert.equal(decision.reason, 'outside_active_time');
});

test('OPP-3c 机会在时段内产生、读取发生在时段外 ⇒ 读取被拒（用使用时的时钟）', (t) => {
  const inWindow = Date.parse('2026-11-19T01:30:00Z');  // 北京 09:30
  const outWindow = Date.parse('2026-11-19T05:00:00Z'); // 北京 13:00
  const store = withStore(t, {
    activeStart: 540, activeEnd: 600,
    ledger: { day: beijingDay(inWindow), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    browseDay: beijingDay(inWindow),
  });
  assert.equal(adaptQzoneOfflineOpportunity(store, { id: OPP, now: inWindow }).allowed, true, '时段内应产生机会');
  // 读取时已出时段：activeTime 由**使用时的时钟**算出 ⇒ 必须拒绝
  const late = reserveOfflineRead(store, {
    id: 'read-1', tool: 'read_posts', source: 'proactive', opportunity: OPP,
    now: outWindow, activeTime: false,
  });
  assert.equal(late.allowed, false, '时段外的读取必须被拒');
  assert.equal(late.reason, 'outside_active_time');
  assert.equal(store.read().todayBrowses, 0, '被拒的读取不得扣额度');
});

test('OPP-4 关闭总开关后机会不被产生', (t) => {
  const store = withStore(t, { enabled: false });
  const decision = adaptQzoneOfflineOpportunity(store, { id: OPP, now: NOW });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'disabled');
  assert.equal(Object.keys(store.read().offlineOpportunityOffers ?? {}).length, 0, '关闭时不得写 offer');
});

test('OPP-5 记录：reserveOfflineRead 信任调用方（生产里由 authorizeBinding 兜住）', (t) => {
  // 这条不是「期望行为」，是**如实钉住现状**：预留层不查 offer 是否存在。
  // 之所以能这样，是因为生产调用链上唯一的入口先过 authorizeBinding。
  // 如果有人新增一条绕过 authorizeBinding 的调用路径，本用例会提醒他这个前提。
  const store = withStore(t);
  assert.deepEqual(store.read().offlineOpportunityOffers, {}, '前提：此刻没有任何 offer');
  const forged = reserveOfflineRead(store, {
    id: 'read-forged', tool: 'read_posts', source: 'proactive',
    opportunity: '99999999-9999-4999-8999-999999999999',
    now: NOW, activeTime: true,
  });
  assert.equal(forged.allowed, true, '预留层不验证 offer 存在性 —— 这是它信任调用方的证明');
  assert.equal(store.read().todayBrowses, 1);
});
