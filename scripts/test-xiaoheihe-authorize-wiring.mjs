// scripts/test-xiaoheihe-authorize-wiring.mjs
// task-52：授权端点启用门禁 + 接线工厂测试（TDD 先红后绿）。
// 覆盖：默认关闭零副作用 / 缺 token / 坏 controller fail-closed / 未知 config /
// 启用后真实 loopback allow+deny+401 / complete 透传 / start-stop 幂等 + 端口释放。
// 全部离线：fake controller 或真实 controller；不 import bridge、不读 config/state。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAuthorizeWiring } from '../src/core/xiaoheihe-authorize-wiring.mjs';
import { createXhhOperationController } from '../src/core/xiaoheihe-operation-controller.mjs';
// 端口安全：请求全部由测试自己发出（wiring 监听 OS 临时端口），用原生 http 避免命中
// undici fetch 的 blocked-port 列表（listen(0) ≈0.15%/次 假红）。见 scripts/test-port-safe.mjs。
import { httpRequest, postJson } from './test-port-safe.mjs';

const TOKEN = 'wiring-token-0123456789abcdef';
const BG = 'patrol:background';
const USER = 'private:123456789';

function enabledConfig(extraBackground = {}) {
  return { backgroundPatrol: { enabled: true, ...extraBackground } };
}

let ticketSeq = 0;
function makeController(overrides = {}) {
  const calls = { status: 0, reserveRead: [], reserveWrite: [], commit: [], abort: [], finish: [] };
  const issued = new Map();
  return {
    calls,
    async status() {
      calls.status += 1;
      return { accessPaused: false, writePaused: false };
    },
    async reserveRead(request) {
      calls.reserveRead.push(request);
      if (typeof overrides.reserveRead === 'function') return overrides.reserveRead(request);
      ticketSeq += 1;
      const ticket = { state: 'reserved', ticketId: `t-${ticketSeq}`, kind: 'read', opId: request.id ?? null, now: request.now, counted: true };
      issued.set(ticket.ticketId, ticket);
      return { ok: true, counted: true, ticket, remaining: 9 };
    },
    async reserveWrite(request) {
      calls.reserveWrite.push(request);
      if (typeof overrides.reserveWrite === 'function') return overrides.reserveWrite(request);
      ticketSeq += 1;
      const ticket = { state: 'reserved', ticketId: `t-${ticketSeq}`, kind: request.kind, opId: request.id, now: request.now, counted: true };
      issued.set(ticket.ticketId, ticket);
      return { ok: true, ticket, used: 1, limit: 2 };
    },
    async commitTicket(ticket) {
      calls.commit.push(ticket);
      if (typeof overrides.commitTicket === 'function') return overrides.commitTicket(ticket);
      if (!issued.has(ticket.ticketId)) return { ok: false, reason: 'invalid-ticket' };
      issued.get(ticket.ticketId).state = 'started';
      return { ok: true, started: true, ticket: { kind: ticket.kind, id: ticket.opId, at: ticket.now, ticketId: ticket.ticketId } };
    },
    async abortTicket(ticket) {
      calls.abort.push(ticket);
      if (typeof overrides.abortTicket === 'function') return overrides.abortTicket(ticket);
      if (!issued.has(ticket.ticketId)) return { ok: false, reason: 'invalid-ticket' };
      issued.delete(ticket.ticketId);
      return { ok: true, aborted: true, rolledBack: true };
    },
    async finish(ticket, options) {
      calls.finish.push({ ticket, options });
      return { ok: true, outcome: options?.outcome ?? null };
    },
  };
}

function makeWiring(overrides = {}) {
  return createAuthorizeWiring({
    config: enabledConfig(),
    controller: makeController(),
    consoleToken: TOKEN,
    sessionIdentity: { backgroundSessionKeys: [BG], userExemptAgents: [USER] },
    ...overrides,
  });
}

function post(url, body, headers = {}) {
  return postJson(url, body, headers);
}

test('默认关闭：undefined/null/{}/"true"/1/false → enabled:false，不监听、stop 安全', async () => {
  const configs = [undefined, null, {}, { backgroundPatrol: {} }, { backgroundPatrol: { enabled: false } }, {
    backgroundPatrol: { enabled: 'true' },
  }, { backgroundPatrol: { enabled: 1 } }, 'true', 1];
  for (const config of configs) {
    const wiring = makeWiring({ config });
    const result = await wiring.start();
    assert.deepEqual(result, { ok: true, enabled: false, reason: 'disabled' }, JSON.stringify(config));
    assert.deepEqual(await wiring.stop(), { stopped: false }, '未启用 stop 安全');
    assert.deepEqual(await wiring.stop(), { stopped: false }, 'stop 幂等');
  }
});

test('未知字段（backgroundPatrol 内/顶层）→ enabled:false（fail-closed 默认关闭）', async () => {
  for (const config of [
    { backgroundPatrol: { enabled: true, extra: 1 } },
    { backgroundPatrol: { enabled: true }, extra: 1 },
    { backgroundPatrol: { enabled: true }, consoleToken: 'x' },
  ]) {
    const wiring = makeWiring({ config });
    const result = await wiring.start();
    assert.equal(result.enabled, false, JSON.stringify(config));
    assert.equal(result.reason, 'disabled');
  }
});

test('启用但缺 consoleToken（undefined/空/非字符串）→ missing-console-token，不启动 server', async () => {
  for (const consoleToken of [undefined, '', 42, null]) {
    const wiring = makeWiring({ consoleToken });
    const result = await wiring.start();
    assert.deepEqual(result, { ok: false, error: 'missing-console-token' }, String(consoleToken));
    assert.deepEqual(await wiring.stop(), { stopped: false });
  }
});

test('启用但 controller 非法（缺 status/authorizeRead/authorizeWrite/finish）→ invalid-controller，不启动', async () => {
  const valid = makeController();
  const cases = [
    null,
    {},
    { ...valid, status: undefined },
    { ...valid, reserveRead: undefined },
    { ...valid, reserveWrite: undefined },
    { ...valid, commitTicket: undefined },
    { ...valid, abortTicket: undefined },
    { ...valid, finish: undefined },
  ];
  for (const controller of cases) {
    const wiring = makeWiring({ controller });
    const result = await wiring.start();
    assert.deepEqual(result, { ok: false, error: 'invalid-controller' }, JSON.stringify(Object.keys(controller ?? {})));
    assert.deepEqual(await wiring.stop(), { stopped: false });
  }
});

test('非法 host/port → invalid-options（非回环不监听）', async () => {
  for (const overrides of [{ host: '0.0.0.0' }, { host: '192.168.1.5' }, { port: -1 }, { port: 70000 }, { port: 'x' }]) {
    const wiring = makeWiring(overrides);
    const result = await wiring.start();
    assert.deepEqual(result, { ok: false, error: 'invalid-options' }, JSON.stringify(overrides));
  }
});

test('启用：真实 loopback start，返回 url/port/stop；start 幂等；stop 幂等且端口释放', async () => {
  const wiring = makeWiring();
  const first = await wiring.start();
  assert.equal(first.ok, true);
  assert.equal(first.enabled, true);
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(first.port > 0);
  assert.equal(typeof first.stop, 'function');

  const again = await wiring.start();
  assert.equal(again.port, first.port, 'start 幂等：复用同一监听');

  const response = await post(`${first.url}/api/xiaoheihe/authorize`, {
    agentKey: BG,
    tool: 'mcp__xiaoheihe__get_home_content',
    args: { id: 'p1' },
  }, { 'x-console-token': TOKEN });
  assert.equal(response.status, 200);

  assert.deepEqual(await first.stop(), { stopped: true });
  assert.deepEqual(await wiring.stop(), { stopped: false }, 'stop 幂等（已停止）');
  await assert.rejects(() => httpRequest(`${first.url}/api/xiaoheihe/authorize`), 'stop 后连接必须失败');

  // 端口释放：同一端口可再次绑定。
  const port = first.port;
  const second = makeWiring({ port });
  const started = await second.start();
  assert.equal(started.ok, true);
  assert.equal(started.port, port);
  await second.stop();
});

test('组合正确性：后台 allow / 用户例外 allow / 未知 agent deny / 无 token 401 / 错 token 403', async () => {
  const controller = makeController();
  const wiring = makeWiring({ controller });
  const { url } = await wiring.start();
  try {
    const background = await post(`${url}/api/xiaoheihe/authorize`, {
      agentKey: BG,
      tool: 'mcp__xiaoheihe__get_home_content',
      args: { id: 'p1' },
    }, { 'x-console-token': TOKEN });
    assert.equal(background.status, 200);
    const backgroundBody = await background.json();
    assert.equal(backgroundBody.decision, 'allow');
    assert.equal(backgroundBody.exemption, 'quota');
    assert.equal(controller.calls.reserveRead.length, 1, '后台会话必须走 controller 预占');

    const revoked = await post(`${url}/api/xiaoheihe/authorize`, {
      agentKey: USER,
      tool: 'mcp__xiaoheihe__get_home_content',
      args: { id: 'p2' },
    }, { 'x-console-token': TOKEN });
    assert.equal(revoked.status, 200);
    const userBody = await revoked.json();
    assert.equal(userBody.decision, 'allow');
    assert.equal(userBody.exemption, 'user', '用户例外不扣额度');
    assert.equal(controller.calls.reserveRead.length, 1, '用户例外不得调用 controller');

    const stranger = await post(`${url}/api/xiaoheihe/authorize`, {
      agentKey: 'unknown-agent',
      tool: 'mcp__xiaoheihe__get_home_content',
      args: {},
    }, { 'x-console-token': TOKEN });
    assert.equal(stranger.status, 200);
    const strangerBody = await stranger.json();
    assert.equal(strangerBody.decision, 'deny');
    assert.equal(strangerBody.reason, 'unknown-agent');

    const noToken = await post(`${url}/api/xiaoheihe/authorize`, { agentKey: BG, tool: 'mcp__xiaoheihe__get_home_content', args: {} });
    assert.equal(noToken.status, 401);
    const wrongToken = await post(`${url}/api/xiaoheihe/authorize`, { agentKey: BG, tool: 'mcp__xiaoheihe__get_home_content', args: {} }, { 'x-console-token': 'wrong' });
    assert.equal(wrongToken.status, 403);
  } finally {
    await wiring.stop();
  }
});

test('execute-first 闭环：authorize(reserve) → commit → complete；未 commit 的 complete 返回 not-started', async () => {
  const controller = makeController();
  const wiring = makeWiring({ controller });
  const { url } = await wiring.start();
  try {
    const allowed = await post(`${url}/api/xiaoheihe/authorize`, {
      agentKey: BG,
      tool: 'mcp__xiaoheihe__publish_content',
      args: { operationId: 'op-1' },
    }, { 'x-console-token': TOKEN });
    assert.equal(allowed.status, 200);
    const reserved = (await allowed.json()).ticket;
    assert.ok(reserved);
    assert.equal(reserved.state, 'reserved');

    // 未 commit 就 complete → 明确 not-started（不得当成功）。
    const premature = await post(`${url}/api/xiaoheihe/complete`, { ticket: reserved, outcome: 'success' }, { 'x-console-token': TOKEN });
    assert.equal(premature.status, 200);
    assert.equal((await premature.json()).reason, 'not-started');
    assert.equal(controller.calls.finish.length, 0);

    const committed = await post(`${url}/api/xiaoheihe/commit`, { ticket: reserved }, { 'x-console-token': TOKEN });
    assert.equal(committed.status, 200);
    assert.equal((await committed.json()).started, true);
    assert.equal(controller.calls.commit.length, 1);

    const completed = await post(`${url}/api/xiaoheihe/complete`, { ticket: reserved, outcome: 'success' }, { 'x-console-token': TOKEN });
    assert.equal(completed.status, 200);
    const body = await completed.json();
    assert.equal(body.ok, true);
    assert.equal(controller.calls.finish.length, 1);
    assert.equal(controller.calls.finish[0].options.outcome, 'success');
  } finally {
    await wiring.stop();
  }
});

test('真实 controller 集成：reserve+commit 计满 12 次读后 deny read-daily-cap；search 不占额度', async () => {
  let now = Date.UTC(2026, 9, 24, 2, 0, 0);
  const controller = createXhhOperationController({ clock: () => now });
  const wiring = makeWiring({ controller });
  const { url } = await wiring.start();
  try {
    for (let index = 0; index < 14; index += 1) {
      const response = await post(`${url}/api/xiaoheihe/authorize`, {
        agentKey: BG,
        tool: index % 2 === 0 ? 'mcp__xiaoheihe__get_home_content' : 'mcp__xiaoheihe__get_post_detail',
        args: { id: `read-${index}` },
      }, { 'x-console-token': TOKEN });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.decision, 'allow', `第 ${index + 1} 次读应允许`);
      const committed = await post(`${url}/api/xiaoheihe/commit`, { ticket: body.ticket }, { 'x-console-token': TOKEN });
      assert.equal(committed.status, 200);
      assert.equal((await committed.json()).started, true);
    }
    const search = await post(`${url}/api/xiaoheihe/authorize`, {
      agentKey: BG,
      tool: 'mcp__xiaoheihe__search_content',
      args: {},
    }, { 'x-console-token': TOKEN });
    assert.equal((await search.json()).decision, 'allow', 'search 不占读取额度');
    const over = await post(`${url}/api/xiaoheihe/authorize`, {
      agentKey: BG,
      tool: 'mcp__xiaoheihe__get_home_content',
      args: { id: 'read-over' },
    }, { 'x-console-token': TOKEN });
    assert.equal(over.status, 200);
    const overBody = await over.json();
    assert.equal(overBody.decision, 'deny');
    assert.equal(overBody.reason, 'read-daily-cap');
    assert.equal(overBody.controllerReason, 'read-daily-cap');
  } finally {
    await wiring.stop();
  }
});

test('审计：注入 audit 后 allow/deny 都收到结构化事件（不含 token/args 原文）', async () => {
  const events = [];
  const wiring = makeWiring({
    audit: (event) => events.push(event),
    controller: makeController(),
  });
  const { url } = await wiring.start();
  try {
    await post(`${url}/api/xiaoheihe/authorize`, {
      agentKey: BG,
      tool: 'mcp__xiaoheihe__get_home_content',
      args: { id: 'p1', text: 'SENSITIVE_TEXT' },
    }, { 'x-console-token': TOKEN });
    await post(`${url}/api/xiaoheihe/authorize`, {
      agentKey: 'unknown-agent',
      tool: 'mcp__xiaoheihe__get_home_content',
      args: {},
    }, { 'x-console-token': TOKEN });
    assert.ok(events.length >= 2);
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes(TOKEN), '审计不得含 token');
    assert.ok(!serialized.includes('SENSITIVE_TEXT'), '审计不得含 args 原文');
  } finally {
    await wiring.stop();
  }
});
