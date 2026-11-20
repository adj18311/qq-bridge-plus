#!/usr/bin/env node
// scripts/test-background-patrol-orchestrator.mjs
//
// 后台巡逻步骤 D：后台回合编排纯模块测试（task-32）。
//
// 被测：`src/core/background-patrol-orchestrator.mjs`
//   createBackgroundPatrolOrchestrator({
//     config, getAvailability, authorizeRead, dispatch, reportOnce,
//     authorizeWrite?, finish?, session?, now?, random?, shouldDraw?, send?, destination?,
//     createDescriptor?, buildPrompt?, taskText?, sharedMemory?, advanceOnDispatchFailure?
//   })
//
// 契约（最小可用切片，全部依赖注入，不 import bridge/DSH/网络）：
//  1) 未启用 / 平台未启用 / 不可用（QQ 忙、已有后台回合、DSH 不可用、平台暂停）→
//     `{ok:true, skipped:true, reason}`，**不扣访问次数、不抽概率、不 dispatch**。
//  2) 机会到达 → 先 authorizeRead 再 dispatch；授权拒绝（含 accessPaused）→ skipped/denied 且零 dispatch；
//     dispatch 抛错/未接受 → `{dispatched:false, outcome:'unknown'}`，不自动重试、不推进概率阶梯（默认）。
//  3) dispatch 成功 → 记录 requestId/turn，等待外部 completeTurn；读成功后才做汇报决策（reportOnce），
//     同一 readIndex 至多一次汇报；send 失败/未知不重发、不重复抽签。
//  4) 幂等：同一 opportunityId 重复 run 不重复授权/不重复 dispatch；并发 run 单飞（第二个 skip busy）。
//  5) 写暂停只影响写（authorizeWrite 委托），accessPaused 由注入的 authorizeRead 拒绝读写。
//
// 纯离线：全部依赖为假对象；不联网、不访问平台、不发 QQ、不读写 state。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBackgroundPatrolOrchestrator,
} from '../src/core/background-patrol-orchestrator.mjs';
import { resolveBackgroundPatrolConfig } from '../src/core/background-patrol-session.mjs';
import { createBackgroundPatrolReportOnce } from '../src/core/background-patrol-report-once.mjs';

const T0 = Date.UTC(2026, 9, 24, 2, 0, 0) - 8 * 60 * 60 * 1000; // 北京时间 2026-10-24 10:00
const READ_TOOL = 'mcp__xiaoheihe__get_home_content';

function enabledConfig(platforms = { tieba: true, xiaoheihe: true }) {
  return resolveBackgroundPatrolConfig({ enabled: true, platforms, dryRun: true });
}

function makeDeps(overrides = {}) {
  const calls = { availability: 0, authorize: 0, authorizeWrite: 0, dispatch: 0, send: 0, random: 0, shouldDraw: 0, descriptor: 0, prompt: 0 };
  let now = T0;
  const deps = {
    calls,
    now: () => now,
    reportOnce: overrides.reportOnce ?? createBackgroundPatrolReportOnce({ now: () => now, ttlMs: 10 * 60 * 1000 }),
    config: overrides.config ?? enabledConfig(),
    getAvailability: overrides.getAvailability ?? (async () => {
      calls.availability += 1;
      return { ok: true };
    }),
    authorizeRead: overrides.authorizeRead ?? (async (request) => {
      calls.authorize += 1;
      return { ok: true, counted: true, ticket: { kind: 'read', id: request.opportunityId ?? null, at: now } };
    }),
    dispatch: overrides.dispatch ?? (async (request) => {
      calls.dispatch += 1;
      return { accepted: true, requestId: request.requestId ?? 'req-default', turn: 7 };
    }),
    authorizeWrite: overrides.authorizeWrite,
    finish: overrides.finish,
    session: overrides.session ?? { preset: 'qq-chat', model: 'inherit' },
    shouldDraw: overrides.shouldDraw ?? ((readIndex) => {
      calls.shouldDraw += 1;
      return true;
    }),
    random: overrides.random ?? (() => {
      calls.random += 1;
      return 0;
    }),
    send: overrides.send ?? (async () => {
      calls.send += 1;
      return { ok: true };
    }),
    destination: overrides.destination ?? 'admin-private',
    createDescriptor: overrides.createDescriptor,
    buildPrompt: overrides.buildPrompt,
    taskText: overrides.taskText,
    sharedMemory: overrides.sharedMemory,
    advanceOnDispatchFailure: overrides.advanceOnDispatchFailure,
    setNow: (value) => { now = value; },
  };
  return deps;
}

function makeOrchestrator(overrides = {}) {
  const deps = makeDeps(overrides);
  const orchestrator = createBackgroundPatrolOrchestrator(deps);
  return { orchestrator, deps };
}

test('构造校验：必需依赖缺失/类型错误抛 TypeError', () => {
  assert.throws(() => createBackgroundPatrolOrchestrator(), TypeError);
  assert.throws(() => createBackgroundPatrolOrchestrator({}), TypeError);
  const deps = makeDeps();
  for (const key of ['config', 'getAvailability', 'authorizeRead', 'dispatch', 'reportOnce']) {
    const broken = { ...deps, [key]: undefined };
    assert.throws(() => createBackgroundPatrolOrchestrator(broken), TypeError, `缺少 ${key} 必须抛错`);
  }
  assert.throws(() => createBackgroundPatrolOrchestrator({ ...deps, reportOnce: {} }), TypeError);
  assert.throws(() => createBackgroundPatrolOrchestrator({ ...deps, config: 'enabled' }), TypeError);
  assert.throws(() => createBackgroundPatrolOrchestrator({ ...deps, random: 'rng' }), TypeError);
});

test('配置未启用：skipped disabled，不扣额/不抽概率/不 dispatch', async () => {
  const { orchestrator, deps } = makeOrchestrator({ config: resolveBackgroundPatrolConfig(undefined) });
  const result = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-1' });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'disabled');
  assert.equal(deps.calls.authorize, 0);
  assert.equal(deps.calls.dispatch, 0);
  assert.equal(deps.calls.random, 0);
  assert.equal(deps.calls.shouldDraw, 0);
});

test('平台未启用：skipped platform-disabled，其它依赖零调用', async () => {
  const { orchestrator, deps } = makeOrchestrator({ config: enabledConfig({ tieba: true, xiaoheihe: false }) });
  const result = await orchestrator.run({ platform: 'xiaoheihe', tool: READ_TOOL, opportunityId: 'chance-2' });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'platform-disabled');
  assert.equal(deps.calls.authorize, 0);
  assert.equal(deps.calls.dispatch, 0);
});

test('不可用（QQ 忙/已有后台回合/DSH 不可用/平台暂停）：skipped unavailable，零扣额零 dispatch', async () => {
  for (const reason of ['qq-busy', 'background-running', 'dsh-unavailable', 'platform-paused']) {
    const { orchestrator, deps } = makeOrchestrator({ getAvailability: async () => ({ ok: false, reason }) });
    const result = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: `chance-${reason}` });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'unavailable');
    assert.equal(result.detail, reason);
    assert.equal(deps.calls.authorize, 0);
    assert.equal(deps.calls.dispatch, 0);
  }
});

test('授权拒绝（含 accessPaused）：skipped authorization-denied，零 dispatch，不抽概率', async () => {
  let authCalls = 0;
  const { orchestrator, deps } = makeOrchestrator({
    authorizeRead: async () => {
      authCalls += 1;
      return { ok: false, reason: 'access-paused' };
    },
  });
  const result = await orchestrator.run({ platform: 'xiaoheihe', tool: READ_TOOL, opportunityId: 'chance-denied' });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'authorization-denied');
  assert.equal(result.detail, 'access-paused');
  assert.equal(deps.calls.dispatch, 0);
  assert.equal(deps.calls.random, 0);
  assert.equal(deps.calls.send, 0);

  // 同一机会重复 run：不重复授权。
  const again = await orchestrator.run({ platform: 'xiaoheihe', tool: READ_TOOL, opportunityId: 'chance-denied' });
  assert.equal(again.skipped, true);
  assert.equal(again.reason, 'duplicate-opportunity');
  assert.equal(authCalls, 1);
});

test('授权抛错：fail-closed 成 authorization-denied（authorization-error），零 dispatch', async () => {
  const { orchestrator, deps } = makeOrchestrator({
    authorizeRead: async () => { throw new Error('ledger down'); },
  });
  const result = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-auth-error' });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'authorization-denied');
  assert.equal(result.detail, 'authorization-error');
  assert.equal(deps.calls.dispatch, 0);
});

test('happy path：构建后台 prompt → authorizeRead → dispatch，返回 requestId/turn', async () => {
  const authorized = [];
  const dispatched = [];
  const { orchestrator } = makeOrchestrator({
    authorizeRead: async (request) => { authorized.push(request); return { ok: true, counted: true, ticket: { kind: 'read' } }; },
    dispatch: async (request) => { dispatched.push(request); return { accepted: true, requestId: 'req-1', turn: 42 }; },
  });
  const result = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-ok', readIndex: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.dispatched, true);
  assert.equal(result.requestId, 'req-1');
  assert.equal(result.turn, 42);
  assert.equal(result.platform, 'tieba');
  assert.equal(authorized.length, 1);
  assert.deepEqual(Object.keys(authorized[0]).sort(), ['opportunityId', 'platform', 'tool']);
  assert.equal(typeof authorized[0].opportunityId, 'string');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].sessionKey, 'patrol:background');
  assert.match(dispatched[0].prompt, /后台巡逻/);
  assert.match(dispatched[0].prompt, /【平台】\ntieba/);
  assert.equal(dispatched[0].requestId, undefined);
});

test('dispatch 抛错/未接受：unknown 且不自动重试、不推进概率阶梯；同一机会不再授权', async () => {
  for (const dispatch of [
    async () => { throw new Error('dsh timeout'); },
    async () => ({ accepted: false, reason: 'dsh-rejected' }),
    async () => undefined,
  ]) {
    const { orchestrator, deps } = makeOrchestrator({ dispatch });
    const result = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-dispatch-fail' });
    assert.equal(result.ok, true);
    assert.equal(result.dispatched, false);
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.reason, 'dispatch-failed');
    assert.equal(deps.calls.random, 0);
    assert.equal(deps.calls.shouldDraw, 0);
    const again = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-dispatch-fail' });
    assert.equal(again.skipped, true);
    assert.equal(again.reason, 'duplicate-opportunity');
    assert.equal(deps.calls.authorize, 1);
  }
});

test('并发 run 单飞：第二个 skip busy，授权与 dispatch 各一次', async () => {
  let releaseDispatch;
  const dispatchGate = new Promise((resolve) => { releaseDispatch = resolve; });
  let dispatchCalls = 0;
  const { orchestrator, deps } = makeOrchestrator({
    dispatch: async () => {
      dispatchCalls += 1;
      await dispatchGate;
      return { accepted: true, requestId: 'req-concurrent', turn: 9 };
    },
  });
  const first = orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-A' });
  const second = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-B' });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'busy');
  releaseDispatch();
  const firstResult = await first;
  assert.equal(firstResult.dispatched, true);
  assert.equal(dispatchCalls, 1);
  assert.equal(deps.calls.authorize, 1);
});

test('同一机会重复 run（成功路径）：duplicate-opportunity，不再授权/不再 dispatch', async () => {
  const { orchestrator, deps } = makeOrchestrator();
  assert.equal((await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-dup' })).dispatched, true);
  const again = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-dup' });
  assert.equal(again.skipped, true);
  assert.equal(again.reason, 'duplicate-opportunity');
  assert.equal(deps.calls.authorize, 1);
  assert.equal(deps.calls.dispatch, 1);
});

test('completeTurn 成功 + 概率命中：至多一次汇报发送，重放同一 turn 被拒绝', async () => {
  const { orchestrator, deps } = makeOrchestrator();
  const run = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-report', readIndex: 1 });
  assert.equal(run.dispatched, true);

  const completed = await orchestrator.completeTurn({ turn: run.turn, outcome: 'success' });
  assert.equal(completed.ok, true);
  assert.equal(completed.report.attempted, true);
  assert.equal(completed.report.outcome, 'confirmed');
  assert.equal(deps.reportOnce.snapshot().state, 'confirmed');
  assert.equal(deps.reportOnce.snapshot().stats.draws, 1);
  assert.equal(deps.calls.send, 1);
  assert.equal(deps.calls.random, 1);

  const replay = await orchestrator.completeTurn({ turn: run.turn, outcome: 'success' });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'unknown-turn');
  assert.equal(deps.calls.send, 1);
});

test('send 收到非敏感文本与默认目的地；reportOnce 记录已尝试', async () => {
  const sent = [];
  const { orchestrator } = makeOrchestrator({
    send: async (request) => { sent.push(request); return { ok: true }; },
  });
  const run = await orchestrator.run({ platform: 'xiaoheihe', tool: READ_TOOL, opportunityId: 'chance-send', readIndex: 2 });
  await orchestrator.completeTurn({ turn: run.turn, outcome: 'success' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].destination, 'admin-private');
  assert.equal(sent[0].platform, 'xiaoheihe');
  assert.equal(sent[0].readIndex, 2);
  assert.equal(typeof sent[0].text, 'string');
  assert.ok(sent[0].text.length > 0);
  assert.equal(/cookie|token|bduss/i.test(sent[0].text), false);
});

test('send 抛错：settle unknown，不重发、不被当成成功', async () => {
  let sendCalls = 0;
  const { orchestrator, deps } = makeOrchestrator({
    send: async () => { sendCalls += 1; throw new Error('qq down'); },
  });
  const run = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-send-throw', readIndex: 3 });
  const completed = await orchestrator.completeTurn({ turn: run.turn, outcome: 'success' });
  assert.equal(completed.report.attempted, true);
  assert.equal(completed.report.outcome, 'unknown');
  assert.equal(deps.reportOnce.snapshot().state, 'unknown');
  // 再 complete 同 turn：不重发。
  assert.equal((await orchestrator.completeTurn({ turn: run.turn, outcome: 'success' })).ok, false);
  assert.equal(sendCalls, 1);
});

test('send 明确失败：settle failed；同一次读取仍不会得到第二次发送', async () => {
  let sendCalls = 0;
  const { orchestrator, deps } = makeOrchestrator({
    send: async () => {
      sendCalls += 1;
      return { ok: false, reason: 'qq-rate-limited' };
    },
  });
  const run = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-send-fail', readIndex: 4 });
  const completed = await orchestrator.completeTurn({ turn: run.turn, outcome: 'success' });
  assert.equal(completed.report.outcome, 'failed');
  assert.equal(deps.reportOnce.snapshot().state, 'failed');
  assert.equal(sendCalls, 1);
});

test('完整读取失败/unknown 不汇报（不抽概率、不发送）', async () => {
  for (const outcome of ['failure', 'unknown']) {
    const { orchestrator, deps } = makeOrchestrator();
    const run = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: `chance-outcome-${outcome}`, readIndex: 5 });
    const completed = await orchestrator.completeTurn({ turn: run.turn, outcome });
    assert.equal(completed.ok, true);
    assert.equal(completed.report.attempted, false);
    assert.equal(deps.calls.send, 0);
    assert.equal(deps.calls.random, 0);
    assert.equal(deps.calls.shouldDraw, 0);
  }
});

test('概率未命中（shouldDraw=false）：不生成随机数、不发送', async () => {
  const { orchestrator, deps } = makeOrchestrator({ shouldDraw: () => false });
  const run = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-nodraw', readIndex: 9 });
  const completed = await orchestrator.completeTurn({ turn: run.turn, outcome: 'success' });
  assert.equal(completed.report.attempted, false);
  assert.equal(deps.calls.random, 0);
  assert.equal(deps.calls.send, 0);
});

test('同一 readIndex 至多一次汇报：两个 turn 共享 readIndex 时第二次被去重', async () => {
  let turnSeq = 100;
  const { orchestrator, deps } = makeOrchestrator({
    dispatch: async () => {
      turnSeq += 1;
      return { accepted: true, requestId: `req-${turnSeq}`, turn: turnSeq };
    },
  });
  const first = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-r1', readIndex: 6 });
  const second = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-r2', readIndex: 6 });
  assert.equal((await orchestrator.completeTurn({ turn: first.turn, outcome: 'success' })).report.attempted, true);
  const secondCompleted = await orchestrator.completeTurn({ turn: second.turn, outcome: 'success' });
  assert.equal(secondCompleted.ok, true);
  assert.equal(secondCompleted.report.attempted, false);
  assert.equal(secondCompleted.report.reason, 'duplicate-read');
  assert.equal(deps.reportOnce.snapshot().stats.attempts, 1);
  assert.equal(deps.calls.send, 1);
});

test('completeTurn：未知 turn 返回 unknown-turn；写委托 authorizeWrite 失败不影响读路径', async () => {
  const { orchestrator } = makeOrchestrator({
    authorizeWrite: async () => ({ ok: false, reason: 'write-paused' }),
  });
  const unknown = await orchestrator.completeTurn({ turn: 123456, outcome: 'success' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'unknown-turn');

  const write = await orchestrator.authorizeWrite({ platform: 'xiaoheihe', kind: 'post', id: 'op-w1' });
  assert.equal(write.ok, false);
  assert.equal(write.reason, 'write-paused');

  // 写暂停不影响读：读路径仍正常授权并 dispatch。
  const run = await orchestrator.run({ platform: 'xiaoheihe', tool: READ_TOOL, opportunityId: 'chance-read-ok' });
  assert.equal(run.dispatched, true);
});

test('快照与 close：running/processed/pending 计数正确；close 后 run skipped、completeTurn 拒绝', async () => {
  const { orchestrator } = makeOrchestrator();
  const run = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-snap' });
  const snap = orchestrator.snapshot();
  assert.equal(snap.running, false);
  assert.equal(snap.processed, 1);
  assert.equal(snap.pending, 1);
  assert.equal(snap.closed, false);
  await orchestrator.completeTurn({ turn: run.turn, outcome: 'success' });
  assert.equal(orchestrator.snapshot().pending, 0);

  await orchestrator.close();
  assert.equal(orchestrator.snapshot().closed, true);
  const afterClose = await orchestrator.run({ platform: 'tieba', tool: 'tieba:read', opportunityId: 'chance-after-close' });
  assert.equal(afterClose.skipped, true);
  assert.equal(afterClose.reason, 'closed');
  const completeAfterClose = await orchestrator.completeTurn({ turn: 1, outcome: 'success' });
  assert.equal(completeAfterClose.ok, false);
  assert.equal(completeAfterClose.reason, 'closed');
});

test('非法 run 入参：fail-closed 跳过且零副作用', async () => {
  const { orchestrator, deps } = makeOrchestrator();
  for (const request of [null, undefined, 'x', 42, [], {}, { platform: 'weibo', opportunityId: 'o' }, { platform: 'tieba', opportunityId: '' }]) {
    const result = await orchestrator.run(request);
    assert.equal(result.ok, true, `非法入参 ${JSON.stringify(request)} 应返回 skipped`);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'invalid-request');
  }
  assert.equal(deps.calls.authorize, 0);
  assert.equal(deps.calls.dispatch, 0);
});
