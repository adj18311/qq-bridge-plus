/**
 * 小黑盒只读巡逻离线测试（第五阶段）。
 *
 * 覆盖：精确工具白名单与参数透传、读取额度 12 次/日、search 不消耗额度、
 * 拒绝/状态抛错/额度耗尽时不调用 invoke、工具抛错不重试、审计字段白名单且
 * 不泄露参数/结果/凭据、审计失败不掩盖真实调用结果且不触发重试、并发下额度原子性、
 * 真实 background-patrol-state 临时文件的持久化与重启恢复。
 *
 * 仅使用注入的 state/invoke/audit 与本地临时文件；不联网、不读账号、不调用真实 MCP；
 * 不验证登录态、生产接线、真实 QQ 或平台行为。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createBackgroundPatrolState } from '../src/core/background-patrol-state.mjs';
import { createXiaoheiheReadPatrol } from '../src/core/xiaoheihe-read-patrol.mjs';

const HOME_CONTENT = 'mcp__xiaoheihe__get_home_content';
const POST_DETAIL = 'mcp__xiaoheihe__get_post_detail';
const SEARCH_CONTENT = 'mcp__xiaoheihe__search_content';

const READ_TOOLS = [HOME_CONTENT, POST_DETAIL];

const FORBIDDEN_TOOLS = [
  'mcp__xiaoheihe__post_comment',
  'mcp__xiaoheihe__reply_comment',
  'mcp__xiaoheihe__publish_content',
  'mcp__xiaoheihe__publish_article',
  'mcp__xiaoheihe__publish_video',
  'mcp__xiaoheihe__get_login_qr_code',
  'mcp__xiaoheihe__interactive_login',
  'mcp__xiaoheihe__check_login_status',
  'mcp__xiaoheihe__get_user_profile',
  'mcp__xiaoheihe__get_home_content ',
  'MCP__XIAOHEIHE__GET_HOME_CONTENT',
  'get_home_content',
  'mcp__snowluma__qq_send_message',
  'mcp__xiaoheihe__get_home_content_extra',
];

const FIXED_NOW = Date.parse('2026-10-25T04:00:00.000Z');

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const SENSITIVE_AUDIT_KEY = /(arg|token|cookie|credential|secret|password|qrcode?|authorization|body|content|payload|response|raw|snippet|preview|prompt|params|query|input|output|result|data|detail)/i;

function assertAuditSafe(audit, forbiddenValues = []) {
  for (const call of audit.records) {
    assert.equal(call.length, 1, 'audit 必须只接收一个对象参数');
    const record = call[0];
    assert.ok(record !== null && typeof record === 'object' && !Array.isArray(record), 'audit 记录必须是普通对象');
    for (const [key, value] of Object.entries(record)) {
      assert.match(key, /^[A-Za-z][A-Za-z0-9]{0,31}$/, 'audit 字段名必须是简单标识符: ' + key);
      assert.doesNotMatch(key, SENSITIVE_AUDIT_KEY, 'audit 字段疑似承载参数/结果/凭据: ' + key);
      const valueType = value === null ? 'null' : typeof value;
      assert.ok(valueType === 'string' || valueType === 'number' || valueType === 'boolean' || valueType === 'null', 'audit 字段必须是原始值: ' + key);
      if (typeof value === 'number') {
        assert.ok(Number.isFinite(value), 'audit 数值字段必须有限: ' + key);
      }
      if (typeof value === 'string') {
        assert.ok(value.length <= 200, 'audit 字符串字段过长: ' + key);
        for (const secret of forbiddenValues) {
          assert.ok(!value.includes(secret), 'audit 字符串字段泄露敏感值: ' + key);
        }
      }
    }
    const serialized = JSON.stringify(record);
    for (const secret of forbiddenValues) {
      assert.ok(!serialized.includes(secret), 'audit 记录泄露敏感值');
    }
  }
}

function makeState(options = {}) {
  const calls = [];
  const events = options.events;
  async function tryConsume(request) {
    calls.push(request);
    if (events) events.push('consume');
    if (options.respond) return options.respond(request, calls.length);
    if (options.error) throw options.error;
    if (options.result !== undefined) return options.result;
    return { ok: true, used: 1, limit: 12 };
  }
  tryConsume.calls = calls;
  return { tryConsume, calls };
}

function makeInvoke(behavior, events) {
  const calls = [];
  async function invoke(tool, args) {
    if (events) events.push('invoke');
    calls.push({ tool, args });
    if (behavior) return behavior(tool, args, calls.length);
    return { ok: true, tool };
  }
  invoke.calls = calls;
  return invoke;
}

function makeAudit(options = {}) {
  const records = [];
  const events = options.events;
  function audit(...args) {
    records.push(args);
    if (events) events.push('audit');
    if (options.error) throw options.error;
  }
  audit.records = records;
  return audit;
}

async function captureRun(patrol, request) {
  try {
    const value = await patrol.run(request);
    return { status: 'resolved', value };
  } catch (error) {
    return { status: 'rejected', error };
  }
}

async function createRealState(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhh-read-patrol-test-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const filePath = path.join(dir, 'background-patrol-state.json');
  const state = createBackgroundPatrolState({ filePath, clock: () => FIXED_NOW });
  await state.load();
  return { dir, filePath, state };
}

async function readStateFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

test('允许的读取工具：先扣一次读取额度，再原样透传并只调用一次 invoke', async () => {
  for (const tool of READ_TOOLS) {
    const events = [];
    const args = { postId: 'post-42', nested: { tags: ['a', 'b'], page: 2 } };
    const argsBefore = clone(args);
    const state = makeState({ events });
    const invoke = makeInvoke(() => ({ ok: true, echoed: tool }), events);
    const audit = makeAudit({ events });
    const patrol = createXiaoheiheReadPatrol({ state, invoke, audit });

    const outcome = await captureRun(patrol, { tool, args });

    assert.equal(outcome.status, 'resolved', tool + ' 成功路径应 resolve');
    assert.equal(state.calls.length, 1, tool + ' 必须恰好消耗一次读取额度');
    assert.equal(state.calls[0].platform, 'xiaoheihe');
    assert.equal(state.calls[0].bucket, 'read');
    assert.equal(invoke.calls.length, 1, tool + ' 必须恰好调用一次 invoke');
    assert.equal(invoke.calls[0].tool, tool);
    assert.deepEqual(invoke.calls[0].args, argsBefore, '参数必须原样透传');
    assert.deepEqual(args, argsBefore, '参数对象不得被修改');
    assert.ok(events.includes('consume'));
    assert.ok(events.includes('invoke'));
    assert.ok(events.indexOf('consume') < events.indexOf('invoke'), '必须先扣额度成功再调用 invoke');
    assert.equal(events.filter((event) => event === 'consume').length, 1);
    assert.equal(events.filter((event) => event === 'invoke').length, 1);
    await tick();
    assert.ok(audit.records.length >= 1, '实际读取访问必须写审计');
    assertAuditSafe(audit);
  }
});

test('search_content：不消耗读取额度，参数原样透传并调用一次 invoke', async () => {
  const events = [];
  const state = makeState({ events, error: new Error('search 不得查询或消耗额度') });
  const invoke = makeInvoke(() => ({ ok: true }), events);
  const audit = makeAudit({ events });
  const patrol = createXiaoheiheReadPatrol({ state, invoke, audit });
  const args = { keyword: '黑盒 测试', page: 2 };

  const outcome = await captureRun(patrol, { tool: SEARCH_CONTENT, args });

  assert.equal(outcome.status, 'resolved');
  assert.equal(state.calls.length, 0, 'search 不得消耗读取额度');
  assert.equal(invoke.calls.length, 1);
  assert.equal(invoke.calls[0].tool, SEARCH_CONTENT);
  assert.deepEqual(invoke.calls[0].args, args);
  assert.ok(!events.includes('consume'));
  await tick();
  assertAuditSafe(audit);
});

test('其他工具与畸形请求：一律拒绝，不调用 invoke 也不消耗额度', async () => {
  for (const tool of FORBIDDEN_TOOLS) {
    const events = [];
    const state = makeState({ events });
    const invoke = makeInvoke(() => ({ ok: true }), events);
    const audit = makeAudit({ events });
    const patrol = createXiaoheiheReadPatrol({ state, invoke, audit });
    await captureRun(patrol, { tool, args: { keyword: 'SECRET_FORBIDDEN_QUERY_4c1' } });
    assert.equal(invoke.calls.length, 0, '工具 ' + JSON.stringify(tool) + ' 不应调用 invoke');
    assert.equal(state.calls.length, 0, '工具 ' + JSON.stringify(tool) + ' 不应消耗额度');
    await tick();
    assertAuditSafe(audit, ['SECRET_FORBIDDEN_QUERY_4c1']);
  }

  for (const request of [undefined, null, {}, { tool: '' }, { tool: null }, { tool: 42 }, { tool: {} }, { args: {} }]) {
    const state = makeState();
    const invoke = makeInvoke();
    const patrol = createXiaoheiheReadPatrol({ state, invoke, audit: makeAudit() });
    await captureRun(patrol, request);
    assert.equal(invoke.calls.length, 0, '畸形请求不应调用 invoke');
    assert.equal(state.calls.length, 0, '畸形请求不应消耗额度');
  }
});

test('真实状态文件：被拒绝的工具不会创建状态文件', async (t) => {
  const { filePath, state } = await createRealState(t);
  const invoke = makeInvoke();
  const patrol = createXiaoheiheReadPatrol({ state, invoke, audit: makeAudit() });
  for (const tool of FORBIDDEN_TOOLS) {
    await captureRun(patrol, { tool, args: {} });
  }
  assert.equal(invoke.calls.length, 0);
  await assert.rejects(fs.access(filePath), (error) => error.code === 'ENOENT');
});

test('额度拒绝（daily-cap / clock-rollback / min-interval）不调用 invoke 且只查一次状态', async () => {
  const results = [
    { ok: false, reason: 'daily-cap' },
    { ok: false, reason: 'clock-rollback' },
    { ok: false, reason: 'min-interval', waitMs: 1200 },
  ];
  for (const result of results) {
    const events = [];
    const state = makeState({ result, events });
    const invoke = makeInvoke(() => ({ ok: true }), events);
    const patrol = createXiaoheiheReadPatrol({ state, invoke, audit: makeAudit({ events }) });
    await captureRun(patrol, { tool: POST_DETAIL, args: { postId: 'quota' } });
    assert.equal(state.calls.length, 1, '额度检查只应查询一次');
    assert.equal(invoke.calls.length, 0, result.reason + ' 时严禁调用 invoke');
    assert.ok(!events.includes('invoke'));
  }
});

test('状态查询抛错（同步与异步）不调用 invoke，也不重试状态', async () => {
  const failure = Object.assign(new Error('state down'), { code: 'PATROL_STATE_FAILED' });
  const responders = [
    { label: '同步 throw', respond: () => { throw failure; } },
    { label: '异步 reject', respond: async () => { throw failure; } },
  ];
  for (const item of responders) {
    const events = [];
    const state = makeState({ respond: item.respond, events });
    const invoke = makeInvoke(() => ({ ok: true }), events);
    const patrol = createXiaoheiheReadPatrol({ state, invoke, audit: makeAudit({ events }) });
    await captureRun(patrol, { tool: HOME_CONTENT, args: {} });
    assert.equal(state.calls.length, 1, item.label + ': 状态只应查询一次');
    assert.equal(invoke.calls.length, 0, item.label + ': 状态失败时严禁调用 invoke');
  }
});

test('工具调用抛错不重试：invoke 恰一次，已预留的额度保留', async (t) => {
  const { filePath, state } = await createRealState(t);
  const events = [];
  const invoke = makeInvoke(() => {
    throw new Error('tool boom');
  }, events);
  const patrol = createXiaoheiheReadPatrol({ state, invoke, audit: makeAudit({ events }) });
  const args = { postId: 'boom-1' };

  await captureRun(patrol, { tool: POST_DETAIL, args });

  assert.equal(invoke.calls.length, 1, '工具抛错后不得重试');
  assert.equal(invoke.calls[0].tool, POST_DETAIL);
  assert.deepEqual(invoke.calls[0].args, args);
  assert.equal(events.filter((event) => event === 'invoke').length, 1);
  const snapshot = await state.snapshot();
  assert.equal(snapshot.platforms.xiaoheihe.daily.read, 1, '预留额度保留；抛错不能证明请求已到达平台');
  const persisted = await readStateFile(filePath);
  assert.equal(persisted.platforms.xiaoheihe.daily.read, 1);
});

test('12 次读取上限：超额不调用 invoke，search 仍可用且不占额度', async (t) => {
  const { state, filePath } = await createRealState(t);
  const invoke = makeInvoke();
  const patrol = createXiaoheiheReadPatrol({ state, invoke, audit: makeAudit() });

  for (let index = 0; index < 14; index += 1) {
    const tool = index % 2 === 0 ? HOME_CONTENT : POST_DETAIL;
    const outcome = await captureRun(patrol, { tool, args: { index } });
    assert.equal(outcome.status, 'resolved', '第 ' + (index + 1) + ' 次读取应成功');
  }
  assert.equal(invoke.calls.length, 14);
  assert.equal((await state.snapshot()).platforms.xiaoheihe.daily.read, 14);

  await captureRun(patrol, { tool: HOME_CONTENT, args: { over: true } });
  assert.equal(invoke.calls.length, 14, '额度耗尽后严禁调用 invoke');

  const searchOutcome = await captureRun(patrol, { tool: SEARCH_CONTENT, args: { keyword: '额度外搜索' } });
  assert.equal(searchOutcome.status, 'resolved', 'search 不受读取额度影响');
  assert.equal(invoke.calls.length, 15);
  assert.equal(invoke.calls[14].tool, SEARCH_CONTENT);

  const snapshot = await state.snapshot();
  assert.equal(snapshot.platforms.xiaoheihe.daily.read, 14, 'search 不得增加读取计数');
  const persisted = await readStateFile(filePath);
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.platforms.xiaoheihe.daily.read, 14);
});

test('并发：15 个读取请求只有 12 个真正调用 invoke，额度计数原子', async (t) => {
  const { state, filePath } = await createRealState(t);
  const invoke = makeInvoke(async () => {
    await tick();
    return { ok: true };
  });
  const patrol = createXiaoheiheReadPatrol({ state, invoke, audit: makeAudit() });

  const requests = [];
  for (let index = 0; index < 15; index += 1) {
    requests.push({ tool: HOME_CONTENT, args: { index } });
  }
  for (let index = 0; index < 3; index += 1) {
    requests.push({ tool: SEARCH_CONTENT, args: { keyword: '并发搜索 ' + index } });
  }

  const outcomes = await Promise.all(requests.map((request) => captureRun(patrol, request)));
  assert.equal(outcomes.length, 18);

  const readCalls = invoke.calls.filter((call) => call.tool === HOME_CONTENT || call.tool === POST_DETAIL);
  const searchCalls = invoke.calls.filter((call) => call.tool === SEARCH_CONTENT);
  assert.equal(readCalls.length, 14, '并发下只能有 14 次读取真正发出');
  assert.equal(searchCalls.length, 3, 'search 全部应发出');
  assert.equal(invoke.calls.length, 17);

  const snapshot = await state.snapshot();
  assert.equal(snapshot.platforms.xiaoheihe.daily.read, 14);
  const persisted = await readStateFile(filePath);
  assert.equal(persisted.platforms.xiaoheihe.daily.read, 14);
});

test('重启恢复：同一状态文件下 12 次额度耗尽后新实例仍拒绝读取', async (t) => {
  const { state, filePath } = await createRealState(t);
  const firstInvoke = makeInvoke();
  const firstPatrol = createXiaoheiheReadPatrol({ state, invoke: firstInvoke, audit: makeAudit() });
  for (let index = 0; index < 14; index += 1) {
    await captureRun(firstPatrol, { tool: HOME_CONTENT, args: { index } });
  }
  assert.equal(firstInvoke.calls.length, 14);

  const reloaded = createBackgroundPatrolState({ filePath, clock: () => FIXED_NOW });
  await reloaded.load();
  const secondInvoke = makeInvoke();
  const secondPatrol = createXiaoheiheReadPatrol({ state: reloaded, invoke: secondInvoke, audit: makeAudit() });
  await captureRun(secondPatrol, { tool: HOME_CONTENT, args: { afterRestart: true } });
  assert.equal(secondInvoke.calls.length, 0, '重启不得重置当日额度');
  assert.equal((await reloaded.snapshot()).platforms.xiaoheihe.daily.read, 14);
});

test('审计白名单：不携带参数正文、工具结果或凭据', async () => {
  const args = {
    keyword: 'SECRET_ARG_QUERY_7f3',
    token: 'SECRET_ARG_TOKEN_7f3',
    nested: { cookie: 'SECRET_NESTED_COOKIE_7f3' },
  };
  const argsBefore = clone(args);
  const result = { items: [{ title: 'SECRET_RESULT_BODY_7f3' }] };
  const state = makeState();
  const invoke = makeInvoke(() => result);
  const audit = makeAudit();
  const patrol = createXiaoheiheReadPatrol({ state, invoke, audit });

  const outcome = await captureRun(patrol, { tool: HOME_CONTENT, args });
  assert.equal(outcome.status, 'resolved');
  assert.deepEqual(args, argsBefore, '参数不得被修改');
  assert.deepEqual(invoke.calls[0].args, argsBefore, '参数必须原样透传');
  await tick();

  const secrets = ['SECRET_ARG_QUERY_7f3', 'SECRET_ARG_TOKEN_7f3', 'SECRET_NESTED_COOKIE_7f3', 'SECRET_RESULT_BODY_7f3'];
  assert.ok(audit.records.length >= 1);
  assertAuditSafe(audit, secrets);
  const serializedAudit = JSON.stringify(audit.records);
  for (const secret of secrets) {
    assert.ok(!serializedAudit.includes(secret), '审计不得出现敏感值: ' + secret);
  }
  for (const call of audit.records) {
    assert.notEqual(call[0], args, '审计不能直接接收参数对象');
    assert.notEqual(call[0], result, '审计不能直接接收结果对象');
  }
});

test('MCP 返回错误不等于成功，审计不能把返回结果标成成功', async () => {
  const state = makeState();
  const audit = makeAudit();
  const errorResult = { isError: true, content: [{ type: 'text', text: 'fake-sensitive-response' }] };
  const invoke = makeInvoke(async () => errorResult);
  const patrol = createXiaoheiheReadPatrol({ state, invoke, audit });
  assert.deepEqual(await patrol.run({ tool: HOME_CONTENT, args: {} }), errorResult);
  assert.ok(audit.records.length > 0);
  for (const [record] of audit.records) {
    assert.notEqual(record.outcome, 'ok');
    assert.ok(!JSON.stringify(record).includes('fake-sensitive-response'));
  }
});

test('审计同步抛错：不掩盖真实调用结果、不触发重试', async () => {
  const state = makeState();
  const invoke = makeInvoke(() => ({ ok: true, payloadMarker: 'RESULT_OK_1' }));
  const audit = makeAudit({ error: new Error('audit sink down') });
  const patrol = createXiaoheiheReadPatrol({ state, invoke, audit });

  const outcome = await captureRun(patrol, { tool: POST_DETAIL, args: { postId: 'audit-sync' } });
  assert.equal(outcome.status, 'resolved', '审计失败不得把成功调用变成失败');
  assert.equal(invoke.calls.length, 1, '审计失败不得触发 invoke 重试');
  assert.equal(state.calls.length, 1);
  assert.ok(audit.records.length >= 1);
  await tick();
  assert.equal(invoke.calls.length, 1);
  const resolvedText = JSON.stringify(outcome.value === undefined ? null : outcome.value);
  assert.ok(!resolvedText.includes('audit sink down'), '审计错误不应冒充调用结果');
});

test('审计异步拒绝：不掩盖真实调用结果、不产生未处理拒绝、不重试', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const state = makeState();
    const invoke = makeInvoke(() => ({ ok: true }));
    let auditAttempts = 0;
    const audit = () => {
      auditAttempts += 1;
      return Promise.reject(new Error('audit async down'));
    };
    const patrol = createXiaoheiheReadPatrol({ state, invoke, audit });

    const outcome = await captureRun(patrol, { tool: HOME_CONTENT, args: {} });
    await tick();
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(outcome.status, 'resolved');
    assert.equal(invoke.calls.length, 1);
    assert.ok(auditAttempts >= 1);
    assert.equal(unhandled.length, 0, '审计拒绝必须被处理，不能变成未处理拒绝');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});
