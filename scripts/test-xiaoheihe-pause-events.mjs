// scripts/test-xiaoheihe-pause-events.mjs
// task-130：第三次明确写失败 → 暂停事件的 API/route 层行为测试（离线，真实 HTTP 链可选）。
//
// 契约（用户 2026-10-27 决定）：
//  · complete 只在「真实发生暂停转变」时透传 notify='write-failures' 与
//    writePaused/writeReason/consecutiveWriteFailures；前两次失败不带任何事件；
//  · 落盘失败（persist-failed）时事件暂存 entry，重试成功后才交付且只交付一次；
//  · 重复回执（already-finished / 重复 HTTP complete）不得重复交付 notify，
//    bridge 通知队列因此不会重复通知；
//  · 本模块**绝不**把任意 allow/success 判定为「恢复」：恢复只能由调用方比对 status()
//    的真实变化（writePaused true→false，来自管理员 adminRecover）后自行处理；
//  · route 在 complete allow 审计里为 write-failures 附带 reason='write-paused'（bridge 只认这个 reason）；
//  · status 只暴露安全白名单字段，不返回额度/操作/token。
//
// 纯离线：真实 controller + 真实 route/server（随机端口），不访问平台、不发 QQ、不读写 config/state。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createXhhAuthorizeApi } from '../src/core/xiaoheihe-authorize-api.mjs';
import { createXhhOperationController } from '../src/core/xiaoheihe-operation-controller.mjs';
import { createXhhAuthorizeRoutes } from '../src/core/xiaoheihe-authorize-route.mjs';
import { createXhhAuthorizeServer } from '../src/core/xiaoheihe-authorize-server.mjs';
import { mapAuthorizeAuditEvent } from '../src/core/xiaoheihe-authorize-audit-adapter.mjs';
import { startOnFetchablePort } from './test-port-safe.mjs';

const T0 = Date.UTC(2026, 9, 27, 2, 0, 0);
const MINUTE = 60_000;
const BG = 'patrol:background';
const TOKEN = 'task130-console-token';

/** 真实 controller + 真实 authorizeApi（可选 persist 失败注入），记录审计事件。 */
function makeHarness({ persist } = {}) {
  const events = [];
  const persistCalls = [];
  let failNextPersist = false;
  let finishCalls = 0;
  const controller = createXhhOperationController({ clock: () => T0 });
  const countedController = {
    ...controller,
    finish: (ticket, options) => {
      finishCalls += 1;
      return controller.finish(ticket, options);
    },
  };
  const api = createXhhAuthorizeApi({
    controller: countedController,
    backgroundSessionKeys: [BG],
    clock: () => T0,
    audit: (event) => events.push(event),
    persist: persist === undefined
      ? async () => {
        persistCalls.push(1);
        if (failNextPersist) {
          failNextPersist = false;
          return { ok: false };
        }
        return { ok: true };
      }
      : async () => { persistCalls.push(1); return persist(); },
  });
  return {
    api,
    controller,
    events,
    persistCalls,
    finishCalls: () => finishCalls,
    failNextPersist() { failNextPersist = true; },
  };
}

/** 走完整授权链（authorize→commit→complete），返回三段结果与票据。 */
async function writeChain(api, { op, now, outcome = 'failure', tool = 'post_comment' }) {
  const authorized = await api.authorize({
    agentKey: BG,
    tool: `mcp__xiaoheihe__${tool}`,
    args: { operationId: op },
    now,
  });
  assert.equal(authorized?.decision, 'allow', `authorize 期望 allow：${JSON.stringify(authorized)}`);
  const committed = await api.commit({ ticket: authorized.ticket, agentKey: BG, now });
  assert.equal(committed?.ok, true, `commit 期望 ok：${JSON.stringify(committed)}`);
  const completed = await api.complete({ ticket: committed.ticket, agentKey: BG, outcome, now });
  return { authorized, committed, completed };
}

/** 连续三次明确写失败（评论桶要求 ≥3 分钟间隔，这里留 4 分钟余量）。 */
async function threeWriteFailures(h, base = T0) {
  const chain1 = await writeChain(h.api, { op: 'c-1', now: base });
  const chain2 = await writeChain(h.api, { op: 'c-2', now: base + 4 * MINUTE });
  const chain3 = await writeChain(h.api, { op: 'c-3', now: base + 8 * MINUTE });
  return [chain1, chain2, chain3];
}

async function postJson(url, path, body, token = TOKEN, now) {
  const payload = now === undefined ? body : { ...body, now };
  const headers = { 'content-type': 'application/json' };
  if (token !== null) headers['x-console-token'] = token;
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

/** 起真实 HTTP 服务（随机可 fetch 端口）：route + server，审计事件共享。 */
async function startStack(harness) {
  const events = harness.events;
  // route 的 now 来自注入 clock（HTTP body 的 now 不参与时间判定）；测试通过 setNow 控制时间。
  const clock = { now: T0 };
  const routes = createXhhAuthorizeRoutes({
    consoleToken: TOKEN,
    backgroundSessionKeys: [BG],
    authorizeApi: harness.api,
    clock: () => clock.now,
    audit: (event) => events.push(event),
  });
  const started = await startOnFetchablePort(async (port) => {
    const server = createXhhAuthorizeServer({ routes, port });
    const info = await server.start();
    return { server, url: info.url };
  });
  return {
    url: started.url,
    setNow(value) { clock.now = value; },
    close: async () => { await started.server.stop(); },
  };
}

async function httpWriteFailure(url, op, now) {
  const auth = await postJson(url, '/api/xiaoheihe/authorize', {
    agentKey: BG,
    tool: 'mcp__xiaoheihe__post_comment',
    args: { operationId: op },
  }, TOKEN, now);
  assert.equal(auth.status, 200);
  assert.equal(auth.body.decision, 'allow', JSON.stringify(auth.body));
  const commit = await postJson(url, '/api/xiaoheihe/commit', { ticket: auth.body.ticket, agentKey: BG }, TOKEN, now);
  assert.equal(commit.status, 200);
  assert.equal(commit.body.started, true, JSON.stringify(commit.body));
  const complete = await postJson(url, '/api/xiaoheihe/complete', {
    ticket: commit.body.ticket,
    agentKey: BG,
    outcome: 'failure',
  }, TOKEN, now);
  return { complete, ticket: commit.body.ticket };
}

test('第三次明确写失败：complete 透传 write-failures 暂停事件；前两次不带', async () => {
  const h = makeHarness();
  const chains = await threeWriteFailures(h);
  assert.equal(chains[0].completed.notify, undefined, '第一次失败不得产生暂停事件');
  assert.equal(chains[1].completed.notify, undefined, '第二次失败不得产生暂停事件');
  const third = chains[2].completed;
  assert.equal(third.ok, true);
  assert.equal(third.notify, 'write-failures');
  assert.equal(third.writePaused, true);
  assert.equal(third.writeReason, 'consecutive-failures');
  assert.equal(third.consecutiveWriteFailures, 3);
  assert.equal(h.finishCalls(), 3, 'controller.finish 恰好三次（每次回执一次）');
});

test('persist-pending：落盘失败不提前交付事件，重试成功交付一次，重复回执不重复交付', async () => {
  const h = makeHarness();
  // 前两次失败正常落盘；第三次 makeHarness 内 persist 由 setPersistOk 控制。
  const chain1 = await writeChain(h.api, { op: 'p-1', now: T0 });
  const chain2 = await writeChain(h.api, { op: 'p-2', now: T0 + 4 * MINUTE });
  assert.equal(chain1.completed.ok, true);
  assert.equal(chain2.completed.ok, true);

  // 第三次：commit 落盘正常，仅在 complete 的 persist 上注入一次失败（模拟落盘失败）。
  const authorized3 = await h.api.authorize({
    agentKey: BG,
    tool: 'mcp__xiaoheihe__post_comment',
    args: { operationId: 'p-3' },
    now: T0 + 8 * MINUTE,
  });
  assert.equal(authorized3.decision, 'allow');
  const committed3 = await h.api.commit({ ticket: authorized3.ticket, agentKey: BG, now: T0 + 8 * MINUTE });
  assert.equal(committed3.ok, true);
  h.failNextPersist();
  const chain3 = { committed: committed3, completed: await h.api.complete({ ticket: committed3.ticket, agentKey: BG, outcome: 'failure', now: T0 + 8 * MINUTE }) };
  assert.equal(chain3.completed.ok, false);
  assert.equal(chain3.completed.reason, 'persist-failed');
  assert.equal(chain3.completed.notify, undefined, '落盘失败不得提前泄漏暂停事件');

  const retry = await h.api.complete({
    ticket: chain3.committed.ticket,
    agentKey: BG,
    outcome: 'failure',
    now: T0 + 9 * MINUTE,
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.notify, 'write-failures', '重试成功后必须交付一次暂停事件');
  assert.equal(retry.consecutiveWriteFailures, 3);
  assert.equal(h.finishCalls(), 3, 'persist 重试不得重复调用 controller.finish');
  const failureAudits = h.events.filter((event) => event.type === 'complete' && event.outcome === 'failure');
  assert.equal(failureAudits.length, 3, `persist 失败不得产生 complete 审计（2 次成功 + 1 次重试成功）；实际=${JSON.stringify(failureAudits)}`);

  const duplicate = await h.api.complete({
    ticket: chain3.committed.ticket,
    agentKey: BG,
    outcome: 'failure',
    now: T0 + 10 * MINUTE,
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.already, true);
  assert.equal(duplicate.notify, undefined, '重复回执不得重复交付暂停事件');

  const afterDuplicate = h.events.filter((event) => event.type === 'complete' && event.outcome === 'failure');
  assert.equal(afterDuplicate.length, 4, '重复回执只追加一条普通 complete 审计，不再追加暂停审计');
});

test('恢复判定：allow/success 不等于恢复；只有真实 adminRecover 改变 status 后才视为恢复', async () => {
  const h = makeHarness();
  await threeWriteFailures(h);

  const before = await h.api.status();
  assert.equal(before.ok, true);
  assert.equal(before.writePaused, true);
  assert.equal(before.consecutiveWriteFailures, 3);
  assert.equal(before.writeReason, 'consecutive-failures');

  // 暂停期间写授权被拒绝（readOnly/pause 边界不受成功回执影响）。
  const blocked = await h.api.authorize({
    agentKey: BG,
    tool: 'mcp__xiaoheihe__post_comment',
    args: { operationId: 'blocked-op' },
    now: T0 + 9 * MINUTE,
  });
  assert.equal(blocked.decision, 'deny');
  assert.equal(blocked.reason, 'write-paused');

  // 一次成功的读回执绝不等于恢复。
  const readAuthorized = await h.api.authorize({
    agentKey: BG,
    tool: 'mcp__xiaoheihe__get_home_content',
    now: T0 + 10 * MINUTE,
  });
  assert.equal(readAuthorized.decision, 'allow');
  const readCommitted = await h.api.commit({ ticket: readAuthorized.ticket, agentKey: BG, now: T0 + 10 * MINUTE });
  const readCompleted = await h.api.complete({ ticket: readCommitted.ticket, agentKey: BG, outcome: 'success', now: T0 + 10 * MINUTE });
  assert.equal(readCompleted.ok, true);
  assert.equal(readCompleted.notify, undefined);
  assert.equal(readCompleted.recovered, undefined);

  const stillPaused = await h.api.status();
  assert.equal(stillPaused.writePaused, true, '成功回执不得清除暂停');

  // 真实管理员恢复：status 变为 writePaused=false、失败链清零。
  h.controller.adminRecover({ verifiedAdminFrom: 'console', now: T0 + 11 * MINUTE });
  const recovered = await h.api.status();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.writePaused, false);
  assert.equal(recovered.consecutiveWriteFailures, 0);
  assert.equal(recovered.writeReason, undefined);

  // API 自身从不产生 recovered 事件/字段。
  assert.equal(h.events.some((event) => event.notify === 'recovered' || event.reason === 'recovered'), false);
  assert.equal(h.events.some((event) => event.notify === 'write-failures' && event.type !== 'complete'), false);
});

test('真实 HTTP 链：第三次失败返回 pause 事件；route 审计带 write-paused；重复回执不重复通知', async () => {
  const h = makeHarness();
  const stack = await startStack(h);
  try {
    stack.setNow(T0);
    const first = await httpWriteFailure(stack.url, 'h-1', T0);
    stack.setNow(T0 + 4 * MINUTE);
    const second = await httpWriteFailure(stack.url, 'h-2', T0 + 4 * MINUTE);
    stack.setNow(T0 + 8 * MINUTE);
    const third = await httpWriteFailure(stack.url, 'h-3', T0 + 8 * MINUTE);
    assert.equal(first.complete.body.notify, undefined);
    assert.equal(second.complete.body.notify, undefined);
    assert.equal(third.complete.status, 200);
    assert.equal(third.complete.body.ok, true);
    assert.equal(third.complete.body.notify, 'write-failures');
    assert.equal(third.complete.body.writePaused, true);
    assert.equal(third.complete.body.writeReason, 'consecutive-failures');
    assert.equal(third.complete.body.consecutiveWriteFailures, 3);

    const pauseAudit = h.events.filter((event) => event.type === 'complete' && event.reason === 'write-paused');
    assert.equal(pauseAudit.length, 1, '恰有一条 write-paused 审计供 bridge 通知队列消费');

    // 重复回执：不得再带 notify，也不得再产生 write-paused 审计。
    stack.setNow(T0 + 9 * MINUTE);
    const duplicate = await postJson(stack.url, '/api/xiaoheihe/complete', {
      ticket: third.ticket,
      agentKey: BG,
      outcome: 'failure',
    }, TOKEN, T0 + 9 * MINUTE);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.ok, true);
    assert.equal(duplicate.body.notify, undefined);
    const pauseAuditAfter = h.events.filter((event) => event.type === 'complete' && event.reason === 'write-paused');
    assert.equal(pauseAuditAfter.length, 1, '重复回执不得重复产生 write-paused 审计');
  } finally {
    await stack.close();
  }
});

test('HTTP status 端点：token 鉴权 + 真实恢复前后快照 + 不泄漏额度/token', async () => {
  const h = makeHarness();
  await threeWriteFailures(h);
  const stack = await startStack(h);
  try {
    const unauthorized = await postJson(stack.url, '/api/xiaoheihe/status', {}, null, T0 + 9 * MINUTE);
    assert.equal(unauthorized.status, 401);

    const paused = await postJson(stack.url, '/api/xiaoheihe/status', {}, TOKEN, T0 + 9 * MINUTE);
    assert.equal(paused.status, 200);
    assert.equal(paused.body.ok, true);
    assert.equal(paused.body.writePaused, true);
    assert.equal(paused.body.accessPaused, false);
    assert.equal(paused.body.writeReason, 'consecutive-failures');
    assert.equal(paused.body.consecutiveWriteFailures, 3);
    assert.equal('readCount' in paused.body, false);
    assert.equal('used' in paused.body, false);
    assert.equal('token' in paused.body, false);

    h.controller.adminRecover({ verifiedAdminFrom: 'console', now: T0 + 10 * MINUTE });
    const recovered = await postJson(stack.url, '/api/xiaoheihe/status', {}, TOKEN, T0 + 10 * MINUTE);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.ok, true);
    assert.equal(recovered.body.writePaused, false);
    assert.equal(recovered.body.consecutiveWriteFailures, 0);
    assert.equal(recovered.body.writeReason, undefined);
    // status 读取不得被误当成恢复事件：审计里没有 recovered。
    assert.equal(h.events.some((event) => event.reason === 'recovered' || event.notify === 'recovered'), false);
  } finally {
    await stack.close();
  }
});

test('route 纯处理器：complete 透传 notify 且只在 write-failures 时附 reason；重复回执无事件', async () => {
  const events = [];
  let completeResult = {
    ok: true,
    completed: true,
    outcome: 'failure',
    notify: 'write-failures',
    writePaused: true,
    writeReason: 'consecutive-failures',
    consecutiveWriteFailures: 3,
  };
  const routes = createXhhAuthorizeRoutes({
    consoleToken: TOKEN,
    backgroundSessionKeys: [BG],
    audit: (event) => events.push(event),
    authorizeApi: {
      async authorize() { return { ok: true, decision: 'deny', reason: 'not-used' }; },
      async complete() { return completeResult; },
      async status() { return { ok: true, writePaused: false, accessPaused: false }; },
    },
  });

  const ticket = { apiId: 'x', ticketId: 't-1', kind: 'comment', tool: 'mcp__xiaoheihe__post_comment', agentKey: BG };
  const first = await routes.handleComplete({
    headers: { 'x-console-token': TOKEN },
    body: { ticket, outcome: 'failure' },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.notify, 'write-failures');
  assert.equal(first.body.consecutiveWriteFailures, 3);
  assert.equal(events.filter((event) => event.reason === 'write-paused').length, 1);

  completeResult = { ok: true, completed: false, already: true, outcome: 'failure' };
  const duplicate = await routes.handleComplete({
    headers: { 'x-console-token': TOKEN },
    body: { ticket, outcome: 'failure' },
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.notify, undefined);
  assert.equal(events.filter((event) => event.reason === 'write-paused').length, 1, '重复回执不得新增 write-paused 审计');

  const status = await routes.handleStatus({ headers: { 'x-console-token': TOKEN }, body: {} });
  assert.equal(status.status, 200);
  assert.equal(status.body.writePaused, false);
  assert.equal(status.body.accessPaused, false);
});

// ---- task-132：暂停转换稳定 id（operationId）在 API / HTTP / 审计三层一致 ----

test('第三次失败响应携带稳定 operationId；与 controller 状态一致；重复回执不重复下发', async () => {
  const h = makeHarness();
  const chains = await threeWriteFailures(h);
  assert.equal(chains[0].completed.operationId, undefined);
  assert.equal(chains[1].completed.operationId, undefined);
  const third = chains[2].completed;
  assert.match(third.operationId, /^write-pause:/, `期望稳定转换 id：${JSON.stringify(third.operationId)}`);
  const snapshot = await h.controller.status();
  assert.equal(third.operationId, snapshot.writePauseEventId, 'API 透传的 id 必须与 controller 持久状态一致');

  const duplicate = await h.api.complete({
    ticket: chains[2].committed.ticket,
    agentKey: BG,
    outcome: 'failure',
    now: T0 + 8 * MINUTE + 1000,
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.already, true);
  assert.equal(duplicate.operationId, undefined, '重复回执不得重复下发暂停事件 id');
});

test('真实 HTTP：第三次失败 response body 带 operationId，complete 审计恰好一条 write-paused 且 opId 相同', async () => {
  const h = makeHarness();
  const stack = await startStack(h);
  try {
    for (const [index, op] of ['h-1', 'h-2', 'h-3'].entries()) {
      const now = T0 + index * 4 * MINUTE;
      stack.setNow(now);
      const result = await httpWriteFailure(stack.url, op, now);
      assert.equal(result.complete.status, 200);
      assert.equal(result.complete.body.ok, true, JSON.stringify(result.complete.body));
      if (index < 2) {
        assert.equal(result.complete.body.operationId, undefined);
      } else {
        assert.match(result.complete.body.operationId, /^write-pause:/);
        const pauseAudits = h.events.filter((event) => event.type === 'complete' && event.reason === 'write-paused');
        assert.equal(pauseAudits.length, 1, '暂停审计恰好一条');
        assert.equal(pauseAudits[0].opId, result.complete.body.operationId, '审计 opId 必须与响应一致');
      }
    }
  } finally {
    await stack.close();
  }
});

test('审计适配器保留 opId；无 opId 时为 null（不伪造）', () => {
  const mapped = mapAuthorizeAuditEvent({
    type: 'complete',
    at: T0,
    tool: 'mcp__xiaoheihe__post_comment',
    outcome: 'failure',
    reason: 'write-paused',
    opId: 'write-pause:2026-10-27:1793000000000:1',
  }, () => T0);
  assert.equal(mapped.opId, 'write-pause:2026-10-27:1793000000000:1');
  const without = mapAuthorizeAuditEvent({
    type: 'complete',
    at: T0,
    tool: 'mcp__xiaoheihe__post_comment',
    outcome: 'success',
    reason: 'write-ok',
  }, () => T0);
  assert.equal(without.opId, null);
});