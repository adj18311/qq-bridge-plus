#!/usr/bin/env node
// scripts/test-background-patrol-composition.mjs
//
// 后台巡逻步骤 E（离线部分）：纯模块**组合集成测试**（task-47）。
//
// 把已交付纯模块接起来验证真实交互，不接 bridge/DSH/网络、不发 QQ、不读写真实 state/config：
//   controller + store（os.tmpdir 临时目录）
//   authorize-api + authorize-route（fake console token）
//   plugins/xhh-quota-guard/decision.mjs（工具归一/agentClass/决策映射）
//   background-patrol-session-lifecycle（假 sessions/store）+ session（config/prompt）
//   background-patrol-orchestrator + report-once + report-policy
//   background-patrol-notify（临时目录）
//   background-patrol-audit（临时目录）
//
// 覆盖场景（每个场景独立干净状态）：用户例外、后台读取额度、写配额/unknown、暂停/恢复/跨日、
// 一次读取至多一次汇报、会话 5 天轮换/丢失重建/关闭归档、通知去重、审计固定字段。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createXhhOperationStore } from '../src/core/xiaoheihe-operation-store.mjs';
import { createXhhAuthorizeApi } from '../src/core/xiaoheihe-authorize-api.mjs';
import { createXhhAuthorizeRoutes, XHH_AUTHORIZE_ROUTE_STATUS } from '../src/core/xiaoheihe-authorize-route.mjs';
import {
  mapAuthorizeDecision,
  normalizeToolName,
  resolveAgentKey,
  outcomeForExec,
  classifyAgentKey,
} from '../plugins/xhh-quota-guard/decision.mjs';
import {
  createBackgroundPatrolSessionLifecycle,
  BACKGROUND_SESSION_AUDIT_EVENT_TYPES,
  BACKGROUND_SESSION_ROTATION_MS,
} from '../src/core/background-patrol-session-lifecycle.mjs';
import { resolveBackgroundPatrolConfig } from '../src/core/background-patrol-session.mjs';
import { createBackgroundPatrolNotifyQueue } from '../src/core/background-patrol-notify.mjs';
import { createBackgroundPatrolOrchestrator } from '../src/core/background-patrol-orchestrator.mjs';
import { createBackgroundPatrolReportOnce } from '../src/core/background-patrol-report-once.mjs';
import { backgroundReportProbability, shouldDrawBackgroundReport } from '../src/core/background-patrol-report-policy.mjs';
import { createBackgroundPatrolAudit } from '../src/core/background-patrol-audit.mjs';

const BJT_OFFSET = 8 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TOKEN = 'fake-console-token-for-composition-tests';

const BG_AGENT = 'agent:background-session-1';
const USER_AGENT = 'agent:admin-private-session-1';

const TOOL = Object.freeze({
  home: 'mcp__xiaoheihe__get_home_content',
  detail: 'mcp__xiaoheihe__get_post_detail',
  search: 'mcp__xiaoheihe__search_content',
  post: 'mcp__xiaoheihe__publish_content',
  comment: 'mcp__xiaoheihe__post_comment',
});

function bjt(year, month, day, hour = 0, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, 0) - BJT_OFFSET;
}

const T0 = bjt(2026, 10, 24, 10, 0);

async function makeTempDir(t, label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `qq-bp-comp-${label}-`));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeClock(initial = T0) {
  let now = initial;
  return {
    now: () => now,
    setNow: (value) => { now = value; },
    advance: (delta) => { now += delta; },
  };
}

/** 组合：真实 controller+store + authorize API + 授权路由 + 审计回调。 */
async function makeXhhWorld(t, clock) {
  const dir = await makeTempDir(t, 'xhh');
  const store = createXhhOperationStore({ filePath: path.join(dir, 'xhh-operation-state.json'), clock: { now: clock.now } });
  const controller = await store.load();
  const apiAudit = [];
  const routeAudit = [];
  const api = createXhhAuthorizeApi({
    controller,
    backgroundSessionKeys: [BG_AGENT],
    userExemptAgents: [USER_AGENT],
    clock: { now: clock.now },
    audit: (event) => apiAudit.push(event),
  });
  const routes = createXhhAuthorizeRoutes({
    authorizeApi: api,
    consoleToken: TOKEN,
    backgroundSessionKeys: [BG_AGENT],
    clock: { now: clock.now },
    audit: (event) => routeAudit.push(event),
  });
  return {
    dir,
    store,
    controller,
    api,
    routes,
    apiAudit,
    routeAudit,
  };
}

async function authorizeRoute(world, clock, { agentKey, tool, args = {}, now = clock.now() }) {
  return world.routes.handleAuthorize({
    headers: { 'x-console-token': TOKEN },
    body: { agentKey, tool, args },
    now,
  });
}

async function completeRoute(world, clock, { ticket, outcome, now = clock.now() }) {
  return world.routes.handleComplete({
    headers: { 'x-console-token': TOKEN },
    body: { ticket, outcome },
    now,
  });
}

async function commitRoute(world, clock, ticket, now) {
  return world.routes.handleCommit({
    headers: { 'x-console-token': TOKEN },
    body: { ticket },
    now: now ?? clock.now(),
  });
}

async function commitAuthorize(world, clock, decision, now) {
  const committed = await commitRoute(world, clock, decision.body.ticket, now);
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  assert.equal(committed.body.started, true, JSON.stringify(committed.body));
  return committed.body.ticket;
}

/** 连续 3 次明确写失败（comment 桶，3 分钟间隔），把 controller 推进到 writePaused。 */
async function driveThreeWriteFailures(world, clock) {
  const outcomes = [];
  for (let index = 1; index <= 3; index += 1) {
    const at = clock.now();
    const decision = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.comment, args: { operationId: `op-fail-${index}` }, now: at });
    assert.equal(decision.status, 200);
    assert.equal(decision.body.decision, 'allow', JSON.stringify(decision.body));
    await commitAuthorize(world, clock, decision, at);
    const completed = await completeRoute(world, clock, { ticket: decision.body.ticket, outcome: 'failure', now: at });
    assert.equal(completed.status, 200);
    outcomes.push(completed.body);
    clock.advance(3 * MINUTE);
  }
  return outcomes;
}

// ── 场景 1：用户例外不扣额，但安全暂停仍拒绝 ─────────────────────────────────

test('组合1 用户例外：authorize allow/exemption=user/零扣额；额度满仍放行；writePaused 拒写、accessPaused 全拒', async (t) => {
  const clock = makeClock();
  const world = await makeXhhWorld(t, clock);

  // 先用后台会话把 12 次读额度用满。
  for (let index = 0; index < 14; index += 1) {
    const decision = await authorizeRoute(world, clock, {
      agentKey: BG_AGENT,
      tool: index % 2 === 0 ? TOOL.home : TOOL.detail,
      now: clock.now(),
    });
    assert.equal(decision.body.decision, 'allow');
    await commitAuthorize(world, clock, decision, clock.now());
  }
  assert.deepEqual((await world.controller.status()).read.used, 14);

  // 用户例外：allow + exemption=user + counted:false，controller 零扣额。
  const userRead = await authorizeRoute(world, clock, { agentKey: USER_AGENT, tool: TOOL.home, now: clock.now() });
  assert.equal(userRead.status, XHH_AUTHORIZE_ROUTE_STATUS.OK);
  assert.equal(userRead.body.decision, 'allow');
  assert.equal(userRead.body.exemption, 'user');
  assert.equal(userRead.body.counted, false);
  assert.equal((await world.controller.status()).read.used, 14);

  // 插件决策层组合：route body → mapAuthorizeDecision。
  const mapped = mapAuthorizeDecision(userRead.body);
  assert.equal(mapped.kind, 'allow');
  assert.equal(mapped.ticket.kind, 'exempt');
  assert.equal(classifyAgentKey(USER_AGENT, { backgroundSessionKeys: [BG_AGENT], userExemptAgents: [USER_AGENT] }), 'user');
  assert.equal(resolveAgentKey({ agent: { session: { id: USER_AGENT } } }), USER_AGENT);

  // 3 次写失败 → writePaused：用户明确要求写操作仍被拒（暂停优先于豁免），读豁免仍放行。
  await driveThreeWriteFailures(world, clock);
  assert.equal((await world.controller.status()).writePaused, true);
  const userWrite = await authorizeRoute(world, clock, {
    agentKey: USER_AGENT,
    tool: TOOL.post,
    args: { operationId: 'op-user-post-1' },
    now: clock.now(),
  });
  assert.equal(userWrite.body.decision, 'deny');
  assert.equal(userWrite.body.reason, 'write-paused');
  const userReadWhileWritePaused = await authorizeRoute(world, clock, { agentKey: USER_AGENT, tool: TOOL.home, now: clock.now() });
  assert.equal(userReadWhileWritePaused.body.decision, 'allow');
  assert.equal(userReadWhileWritePaused.body.exemption, 'user');

  // accessPaused（验证码）：读写都拒，用户例外也不例外。
  const paused = await world.controller.reportAccessUnavailable({ reason: 'captcha', now: clock.now() });
  assert.equal(paused.ok, true);
  const userReadBlocked = await authorizeRoute(world, clock, { agentKey: USER_AGENT, tool: TOOL.home, now: clock.now() });
  assert.equal(userReadBlocked.body.decision, 'deny');
  assert.equal(userReadBlocked.body.reason, 'access-paused');
  const userWriteBlocked = await authorizeRoute(world, clock, {
    agentKey: USER_AGENT,
    tool: TOOL.comment,
    args: { operationId: 'op-user-cmt-1' },
    now: clock.now(),
  });
  assert.equal(userWriteBlocked.body.decision, 'deny');
  assert.equal(userWriteBlocked.body.reason, 'access-paused');
});

// ── 场景 2：后台读取 12/13、search 不占、重启保持 ────────────────────────────

test('组合2 后台读取额度：12 次 home/detail 允许、第 13 次 deny；search 不计数；store 重启后计数保持', async (t) => {
  const clock = makeClock();
  const world = await makeXhhWorld(t, clock);
  const decisions = [];
  for (let index = 0; index < 14; index += 1) {
    const decision = await authorizeRoute(world, clock, {
      agentKey: BG_AGENT,
      tool: index % 2 === 0 ? TOOL.home : TOOL.detail,
      now: clock.now(),
    });
    decisions.push(decision.body);
    await commitAuthorize(world, clock, decision, clock.now());
    clock.advance(1000);
  }
  assert.equal(decisions.filter((body) => body.decision === 'allow').length, 14);
  const thirteenth = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.home, now: clock.now() });
  assert.equal(thirteenth.status, 200);
  assert.equal(thirteenth.body.decision, 'deny');
  assert.equal(thirteenth.body.reason, 'read-daily-cap');
  assert.equal(thirteenth.body.controllerReason, 'read-daily-cap');
  assert.equal(mapAuthorizeDecision(thirteenth.body).kind, 'deny');
  assert.equal(mapAuthorizeDecision(thirteenth.body).reason, 'read-daily-cap');

  // search 不占读取额度：额度满时仍 allow，且 used 不变。
  const search = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.search, args: {}, now: clock.now() });
  assert.equal(search.body.decision, 'allow');
  assert.equal(search.body.counted, false);
  assert.equal((await world.controller.status()).read.used, 14);
  assert.equal(normalizeToolName(TOOL.search), 'search_content');

  // 落盘 + 重启：新 store 实例从磁盘恢复，13 次仍 deny、search 仍允许。
  assert.equal((await world.store.save()).ok, true);
  const store2 = createXhhOperationStore({
    filePath: path.join(world.dir, 'xhh-operation-state.json'),
    clock: { now: clock.now },
  });
  const controller2 = await store2.load();
  const reloaded = await controller2.status();
  assert.equal(reloaded.read.used, 14);
  const api2 = createXhhAuthorizeApi({ controller: controller2, backgroundSessionKeys: [BG_AGENT], clock: { now: clock.now } });
  const deniedAfterRestart = await api2.authorize({ agentKey: BG_AGENT, tool: TOOL.home, args: {}, now: clock.now() });
  assert.equal(deniedAfterRestart.decision, 'deny');
  assert.equal(deniedAfterRestart.reason, 'read-daily-cap');
  const searchAfterRestart = await api2.authorize({ agentKey: BG_AGENT, tool: TOOL.search, args: {}, now: clock.now() });
  assert.equal(searchAfterRestart.decision, 'allow');
  await store2.close();
});

// ── 场景 3：写配额（2/日+3h、10/日+3min）与 unknown 不重放 ────────────────────

test('组合3 写配额：post 2/日+3h、comment 10/日+3min；第 3 帖 deny；unknown 同 operationId 再授权 deny', async (t) => {
  const clock = makeClock();
  const world = await makeXhhWorld(t, clock);

  const post1 = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.post, args: { operationId: 'op-post-1' }, now: clock.now() });
  assert.equal(post1.body.decision, 'allow');
  await commitAuthorize(world, clock, post1, clock.now());
  assert.equal((await completeRoute(world, clock, { ticket: post1.body.ticket, outcome: 'success', now: clock.now() })).body.completed, true);

  clock.advance(3 * HOUR);
  const post2 = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.post, args: { operationId: 'op-post-2' }, now: clock.now() });
  assert.equal(post2.body.decision, 'allow');
  await commitAuthorize(world, clock, post2, clock.now());
  await completeRoute(world, clock, { ticket: post2.body.ticket, outcome: 'success', now: clock.now() });

  clock.advance(3 * HOUR);
  const post3 = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.post, args: { operationId: 'op-post-3' }, now: clock.now() });
  assert.equal(post3.body.decision, 'deny');
  assert.equal(post3.body.reason, 'post-daily-cap');

  // comment：同一操作 unknown 后不得重放。
  clock.advance(1 * MINUTE);
  const unknownComment = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.comment, args: { operationId: 'op-comment-unknown' }, now: clock.now() });
  assert.equal(unknownComment.body.decision, 'allow');
  await commitAuthorize(world, clock, unknownComment, clock.now());
  const completedUnknown = await completeRoute(world, clock, { ticket: unknownComment.body.ticket, outcome: 'unknown', now: clock.now() });
  assert.equal(completedUnknown.body.ok, true);
  clock.advance(1 * MINUTE);
  const replay = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.comment, args: { operationId: 'op-comment-unknown' }, now: clock.now() });
  assert.equal(replay.body.decision, 'deny');
  assert.equal(replay.body.reason, 'unknown-not-replayable');

  // comment 最小间隔 3 分钟。
  clock.advance(10 * MINUTE);
  const comment1 = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.comment, args: { operationId: 'op-comment-2' }, now: clock.now() });
  assert.equal(comment1.body.decision, 'allow');
  await commitAuthorize(world, clock, comment1, clock.now());
  await completeRoute(world, clock, { ticket: comment1.body.ticket, outcome: 'success', now: clock.now() });
  clock.advance(1 * MINUTE);
  const tooSoon = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.comment, args: { operationId: 'op-comment-3' }, now: clock.now() });
  assert.equal(tooSoon.body.decision, 'deny');
  assert.equal(tooSoon.body.reason, 'min-interval');
  clock.advance(3 * MINUTE);
  const afterInterval = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.comment, args: { operationId: 'op-comment-3' }, now: clock.now() });
  assert.equal(afterInterval.body.decision, 'allow');
  await commitAuthorize(world, clock, afterInterval, clock.now());

  const snapshot = await world.controller.status();
  assert.equal(snapshot.post.used, 2);
  assert.equal(snapshot.comment.used, 3, 'unknown 也占写额度：unknown + comment1 + afterInterval');
  assert.equal(snapshot.writePaused, false, 'unknown 不累计失败');
  // 插件侧 outcome 映射组合：超时/取消 → unknown，普通 error → failure。
  assert.equal(outcomeForExec({ signal: { aborted: true } }, { isError: true }), 'unknown');
  assert.equal(outcomeForExec({ signal: { aborted: false } }, { isError: true }), 'failure');
  assert.equal(outcomeForExec({}, { isError: false }), 'success');
});

// ── 场景 4：暂停与恢复（跨日、adminRecover、accessPaused）───────────────────

test('组合4 暂停恢复：3 次失败→writePaused；跨北京日仍暂停；adminRecover 不清额度/间隔/unknown；accessPaused 双拒', async (t) => {
  const clock = makeClock();
  const world = await makeXhhWorld(t, clock);

  // unknown 操作（稍后验证 recover 不清 unknown）。
  const unknownDecision = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.comment, args: { operationId: 'op-kept-unknown' }, now: clock.now() });
  assert.equal(unknownDecision.body.decision, 'allow');
  await commitAuthorize(world, clock, unknownDecision, clock.now());
  await completeRoute(world, clock, { ticket: unknownDecision.body.ticket, outcome: 'unknown', now: clock.now() });
  clock.advance(3 * MINUTE);

  await driveThreeWriteFailures(world, clock);
  let snapshot = await world.controller.status();
  assert.equal(snapshot.writePaused, true);
  assert.equal(snapshot.writeReason, 'consecutive-failures');
  assert.equal(snapshot.consecutiveWriteFailures, 3);

  // 写被拒、读仍允许。
  const writeDenied = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.comment, args: { operationId: 'op-after-pause' }, now: clock.now() });
  assert.equal(writeDenied.body.decision, 'deny');
  assert.equal(writeDenied.body.reason, 'write-paused');
  const readAllowed = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.home, now: clock.now() });
  assert.equal(readAllowed.body.decision, 'allow');
  await commitAuthorize(world, clock, readAllowed, clock.now());

  // 跨北京日：写暂停不自动解除；日计数重置（读 used 从 1 重新变 1）。
  clock.setNow(bjt(2026, 10, 25, 10, 0));
  const writeStillPaused = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.comment, args: { operationId: 'op-next-day' }, now: clock.now() });
  assert.equal(writeStillPaused.body.decision, 'deny');
  assert.equal(writeStillPaused.body.reason, 'write-paused');
  const readNextDay = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.home, now: clock.now() });
  assert.equal(readNextDay.body.decision, 'allow');
  await commitAuthorize(world, clock, readNextDay, clock.now());
  snapshot = await world.controller.status();
  assert.equal(snapshot.day, '2026-10-25');
  assert.equal(snapshot.read.used, 1);
  assert.equal(snapshot.writePaused, true);

  // 管理员恢复（调用契约，非鉴权）：写恢复；额度/间隔/unknown 不重置。
  await world.controller.adminRecover({ verifiedAdminFrom: 'console' });
  snapshot = await world.controller.status();
  assert.equal(snapshot.writePaused, false);
  assert.equal(snapshot.read.used, 1, '恢复不重置当日读取额度');
  const afterRecover = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.comment, args: { operationId: 'op-after-recover' }, now: clock.now() });
  assert.equal(afterRecover.body.decision, 'allow');
  await commitAuthorize(world, clock, afterRecover, clock.now());
  const unknownReplay = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.comment, args: { operationId: 'op-kept-unknown' }, now: clock.now() });
  assert.equal(unknownReplay.body.decision, 'deny');
  assert.equal(unknownReplay.body.reason, 'unknown-not-replayable', '恢复不清 unknown');

  // accessPaused：读写都拒；管理员恢复后读恢复。
  await world.controller.reportAccessUnavailable({ reason: 'login-required', now: clock.now() });
  const readBlocked = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.home, now: clock.now() });
  assert.equal(readBlocked.body.reason, 'access-paused');
  const writeBlocked = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.comment, args: { operationId: 'op-access-blocked' }, now: clock.now() });
  assert.equal(writeBlocked.body.reason, 'access-paused');
  await world.controller.adminRecover({ verifiedAdminFrom: 'console' });
  const readRecovered = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.home, now: clock.now() });
  assert.equal(readRecovered.body.decision, 'allow');
  await commitAuthorize(world, clock, readRecovered, clock.now());
});

// ── 场景 5：orchestrator + report-once + policy：一次读取至多一次汇报 ────────

test('组合5 汇报闭环：dispatch 成功→prepare/dispatch/settle 各一次；同 readIndex 第二个 turn 不重发；send 失败不重发', async (t) => {
  let now = T0;
  let turnSeq = 100;
  const reportOnce = createBackgroundPatrolReportOnce({ now: () => now, ttlMs: 30 * MINUTE });
  const sent = [];
  const sendLog = [];
  const config = resolveBackgroundPatrolConfig({ enabled: true, platforms: { tieba: true }, dryRun: true });

  const orchestrator = createBackgroundPatrolOrchestrator({
    config,
    getAvailability: async () => ({ ok: true }),
    authorizeRead: async () => ({ ok: true, counted: true, ticket: { kind: 'read' } }),
    dispatch: async (request) => ({ accepted: true, requestId: `req-${turnSeq}`, turn: turnSeq + 1 }),
    reportOnce,
    session: { preset: 'qq-chat', model: 'inherit' },
    now: () => now,
    random: () => 0,
    shouldDraw: (readIndex) => shouldDrawBackgroundReport(readIndex),
    send: async (request) => {
      sendLog.push(request);
      if (sent.length === 0) {
        sent.push(request);
        return { ok: true };
      }
      return { ok: false, reason: 'qq-down' };
    },
    destination: 'admin-private',
    taskText: '测试后台巡逻任务',
  });

  const first = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-1', readIndex: 1 });
  assert.equal(first.dispatched, true);
  const completed = await orchestrator.completeTurn({ turn: first.turn, outcome: 'success' });
  assert.equal(completed.report.attempted, true);
  assert.equal(completed.report.outcome, 'confirmed');
  assert.equal(reportOnce.snapshot().stats.draws, 1);
  assert.equal(reportOnce.snapshot().stats.attempts, 1);
  assert.equal(reportOnce.snapshot().state, 'confirmed');
  assert.equal(sendLog.length, 1);

  // 同一 readIndex 的第二个 turn：report-once duplicate-read → 不重复发送、不重复抽签。
  const second = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-2', readIndex: 1 });
  const secondCompleted = await orchestrator.completeTurn({ turn: second.turn, outcome: 'success' });
  assert.equal(secondCompleted.report.attempted, false);
  assert.equal(secondCompleted.report.reason, 'duplicate-read');
  assert.equal(sendLog.length, 1);

  // send 失败：settle failed，不重发；同 turn 重放被拒绝。
  const third = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-3', readIndex: 2 });
  const thirdCompleted = await orchestrator.completeTurn({ turn: third.turn, outcome: 'success' });
  assert.equal(thirdCompleted.report.attempted, true);
  assert.equal(thirdCompleted.report.outcome, 'failed');
  assert.equal(reportOnce.snapshot().state, 'failed');
  assert.equal(sendLog.length, 2);
  assert.equal((await orchestrator.completeTurn({ turn: third.turn, outcome: 'success' })).ok, false);

  // policy 组合：七档概率表仍被使用（第 1 次 60%、第 7 次起 0 不抽签）。
  assert.equal(backgroundReportProbability(1), 0.6);
  assert.equal(backgroundReportProbability(7), 0);
  assert.equal(shouldDrawBackgroundReport(7), false);
  assert.equal(orchestrator.snapshot().pending, 0);
  await orchestrator.close();
});

// ── 场景 6：会话生命周期 5 天轮换 / 丢失重建 / 关闭归档 + 审计事件 ───────────

test('组合6 会话生命周期：5 天边界轮换、丢失重建、关闭归档，审计事件有记录', async (t) => {
  await makeTempDir(t, 'lifecycle');
  const clock = makeClock();
  let persisted = null;
  const storeAdapter = {
    async load() { return persisted; },
    async save(state) { persisted = state; return { ok: true }; },
  };
  const existing = new Set();
  const archived = [];
  let sessionSeq = 0;
  const sessions = {
    async createSession() {
      sessionSeq += 1;
      const id = `bg-session-${sessionSeq}`;
      existing.add(id);
      return id;
    },
    async sessionExists(id) { return existing.has(id); },
    async archiveSession(id) { archived.push(id); existing.delete(id); },
  };
  const auditEvents = [];
  const lifecycle = createBackgroundPatrolSessionLifecycle({
    config: { enabled: true, platforms: { tieba: true, xiaoheihe: true } },
    store: storeAdapter,
    sessions,
    clock: { now: clock.now },
    audit: (event) => auditEvents.push(event),
  });

  const created = await lifecycle.ensureSession({ now: clock.now() });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.sessionId, 'bg-session-1');
  assert.equal(auditEvents.at(-1).type, 'create');

  const reused = await lifecycle.ensureSession({ now: clock.now() + 1 });
  assert.equal(reused.reused, true);
  assert.equal(reused.sessionId, 'bg-session-1');

  // 恰好 5 天边界 → 轮换（旧 session 归档）。
  clock.setNow(T0 + BACKGROUND_SESSION_ROTATION_MS);
  const rotated = await lifecycle.ensureSession({ now: clock.now() });
  assert.equal(rotated.ok, true);
  assert.equal(rotated.rotated, true);
  assert.equal(rotated.previousSessionId, 'bg-session-1');
  assert.equal(rotated.rotationCount, 1);
  assert.deepEqual(archived, ['bg-session-1']);
  assert.equal(auditEvents.at(-1).type, 'rotate');

  // 模拟 session 丢失 → 重建（不静默复用失效 id）。
  existing.delete(rotated.sessionId);
  const rebuilt = await lifecycle.ensureSession({ now: clock.now() + 1000 });
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.rebuilt, true);
  assert.equal(rebuilt.previousSessionId, rotated.sessionId);
  assert.equal(rebuilt.sessionId, 'bg-session-3');
  assert.equal(auditEvents.at(-1).type, 'rebuild');

  // 关闭 → 归档；之后再 ensure 返回 closed。
  const closed = await lifecycle.close({ now: clock.now() + 2000 });
  assert.equal(closed.ok, true);
  assert.equal(closed.archived, true);
  assert.equal(archived.at(-1), 'bg-session-3');
  const afterClose = await lifecycle.ensureSession({ now: clock.now() + 3000 });
  assert.equal(afterClose.ok, false);
  assert.equal(afterClose.reason, 'closed');
  const status = await lifecycle.status();
  assert.equal(status.archived, true);
  assert.equal(status.sessionId, 'bg-session-3');

  // 审计事件全部在白名单内且带 sessionId；不出现敏感内容。
  for (const event of auditEvents) {
    assert.ok(BACKGROUND_SESSION_AUDIT_EVENT_TYPES.includes(event.type), `未知审计事件 ${event.type}`);
  }
  assert.deepEqual(
    [...new Set(auditEvents.map((event) => event.type))].sort(),
    ['archive', 'create', 'disabled', 'rebuild', 'reuse', 'rotate'],
  );
  assert.equal(/cookie|token|bduss/i.test(JSON.stringify(auditEvents)), false);
});

// ── 场景 7：3 次失败 → 通知队列出现 write-paused（去重窗口内只一条）───────────

test('组合7 通知：3 次失败后 enqueue write-paused；去重窗口内重复只一条；投递后窗口内仍不重复', async (t) => {
  const clock = makeClock();
  const dir = await makeTempDir(t, 'notify');
  const notify = createBackgroundPatrolNotifyQueue({ filePath: path.join(dir, 'notify-state.json'), clock: { now: clock.now } });
  await notify.load();
  const world = await makeXhhWorld(t, clock);

  // 与场景 4 同构：连续 3 次写失败 → 第 3 次起 enqueue 通知。
  const failures = await driveThreeWriteFailures(world, clock);
  assert.equal(failures.length, 3);
  assert.equal((await world.controller.status()).writePaused, true);

  const first = await notify.enqueue({
    event: 'write-paused',
    reason: 'consecutive-failures',
    meta: { platform: 'xiaoheihe', attempts: 3 },
    at: clock.now(),
  });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal((await notify.snapshot()).items.length, 1);

  const duplicate = await notify.enqueue({ event: 'write-paused', reason: 'consecutive-failures', at: clock.now() + 1000 });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal((await notify.snapshot()).items.length, 1);

  // 投递成功 → 移入 recent；窗口内再次 enqueue 仍判重（不重复打扰管理员）。
  const itemId = (await notify.snapshot()).items[0].id;
  const delivered = await notify.markDelivered({ id: itemId, delivered: true, at: clock.now() + 2000 });
  assert.equal(delivered.ok, true);
  assert.equal(delivered.removed, true);
  assert.equal((await notify.snapshot()).items.length, 0);
  const duplicateAfterDelivery = await notify.enqueue({ event: 'write-paused', reason: 'consecutive-failures', at: clock.now() + 3000 });
  assert.equal(duplicateAfterDelivery.duplicate, true);
  assert.equal(duplicateAfterDelivery.existing.delivered, true);

  // 10 分钟窗口外可再次通知（去重只覆盖窗口）。
  const outsideWindow = await notify.enqueue({
    event: 'write-paused',
    reason: 'consecutive-failures',
    at: clock.now() + 11 * MINUTE,
  });
  assert.equal(outsideWindow.ok, true);
  assert.equal(outsideWindow.duplicate, false);
  assert.equal((await notify.snapshot()).items.length, 1);
  await notify.close();
});

// ── 场景 8：authorize/deny/complete → 审计固定字段，无 args 原文 ──────────────

test('组合8 审计：authorize allow/deny/complete 产生固定字段记录，不含 args 原文/凭据', async (t) => {
  const clock = makeClock();
  const world = await makeXhhWorld(t, clock);
  const auditDir = await makeTempDir(t, 'audit');
  const audit = createBackgroundPatrolAudit({ filePath: auditDir, clock: { now: clock.now } });
  await audit.load();

  const rawArgsSecret = 'must-not-persist-raw-args';
  const writeAuditEvents = async () => {
    let snapshot = await world.controller.status();
    for (const event of [...world.apiAudit]) {
      const isComplete = event.type === 'complete';
      const isWriteTool = typeof event.tool === 'string' && /publish|comment/.test(event.tool);
      const action = isComplete ? (isWriteTool ? 'write' : 'read') : (event.decision === 'allow' ? (isWriteTool ? 'write' : 'read') : 'skip');
      const result = isComplete
        ? (event.outcome === 'success' ? 'success' : event.outcome === 'failure' ? 'failure' : 'unknown')
        : (event.decision === 'allow' ? 'allowed' : 'denied');
      const reason = typeof event.reason === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(event.reason) ? event.reason : null;
      snapshot = await world.controller.status();
      const recorded = await audit.record({
        at: event.at,
        platform: 'xiaoheihe',
        action,
        result,
        reason,
        quota: { readUsed: snapshot.read.used, readLimit: snapshot.read.limit, postUsed: snapshot.post.used, postLimit: snapshot.post.limit },
      });
      assert.equal(recorded.ok, true, JSON.stringify(recorded));
    }
  };

  // 1) 允许读；2) 未知 agent deny；3) 写 allow + complete success；4) 写 complete failure。
  const allowed = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.home, args: { id: 'read-1', note: rawArgsSecret }, now: clock.now() });
  assert.equal(allowed.body.decision, 'allow');
  const denied = await authorizeRoute(world, clock, { agentKey: 'agent:unknown-not-listed', tool: TOOL.home, args: { secret: rawArgsSecret }, now: clock.now() });
  assert.equal(denied.status, XHH_AUTHORIZE_ROUTE_STATUS.OK);
  assert.equal(denied.body.decision, 'deny');
  assert.equal(denied.body.reason, 'unknown-agent');
  clock.advance(1000);
  const writeOk = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.post, args: { operationId: 'op-audit-post', content: rawArgsSecret }, now: clock.now() });
  assert.equal(writeOk.body.decision, 'allow');
  await commitAuthorize(world, clock, writeOk, clock.now());
  clock.advance(1000);
  await completeRoute(world, clock, { ticket: writeOk.body.ticket, outcome: 'success', now: clock.now() });
  clock.advance(1000);
  const writeFail = await authorizeRoute(world, clock, { agentKey: BG_AGENT, tool: TOOL.comment, args: { operationId: 'op-audit-cmt', content: rawArgsSecret }, now: clock.now() });
  assert.equal(writeFail.body.decision, 'allow');
  await commitAuthorize(world, clock, writeFail, clock.now());
  clock.advance(1000);
  await completeRoute(world, clock, { ticket: writeFail.body.ticket, outcome: 'failure', now: clock.now() });

  await writeAuditEvents();

  const read = await audit.readDay('2026-10-24');
  assert.equal(read.ok, true);
  assert.ok(read.records.length >= 6, `审计记录应覆盖 authorize/complete 全部事件，实际 ${read.records.length}`);
  const FIXED_KEYS = ['action', 'at', 'day', 'opId', 'platform', 'quota', 'reason', 'result', 'v'];
  for (const record of read.records) {
    assert.deepEqual(Object.keys(record).sort(), FIXED_KEYS);
    assert.equal(record.platform, 'xiaoheihe');
    assert.ok(['read', 'write', 'skip', 'pause', 'resume', 'report', 'unknown'].includes(record.action));
    assert.ok(['allowed', 'denied', 'success', 'failure', 'unknown'].includes(record.result));
  }
  assert.ok(read.records.some((record) => record.result === 'allowed'));
  assert.ok(read.records.some((record) => record.result === 'denied' && record.action === 'skip'));
  assert.ok(read.records.some((record) => record.action === 'write' && record.result === 'success'));
  assert.ok(read.records.some((record) => record.action === 'write' && record.result === 'failure'));
  for (const record of read.records) {
    if (record.quota !== null) {
      for (const value of Object.values(record.quota)) assert.equal(typeof value, 'number');
    }
  }
  const raw = await fs.readFile(path.join(auditDir, 'background-patrol-audit-2026-10-24.jsonl'), 'utf8');
  assert.equal(raw.includes(rawArgsSecret), false, '审计文件绝不能出现 args 原文/凭据');
  assert.equal(/cookie|token|bduss/i.test(raw), false);
});
