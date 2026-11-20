// scripts/test-xiaoheihe-authorize-route.mjs
// task-45：路线 B 桥接授权 HTTP 路由纯处理器测试（TDD 先红后绿）。
// 覆盖：x-console-token timing-safe 鉴权 / body(agentKey/tool/args/ticket/outcome) 校验 /
// 后台 vs 用户例外分类 / authorizeApi 结果→HTTP 映射 / 异常 500 fail-closed（绝不 allow）/
// complete 幂等 / 审计固定字段 / 不泄露 token 与参数原文。
// 纯离线：fake authorizeApi/audit；不监听端口、不 import bridge、不读 config。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  XHH_AUTHORIZE_ROUTE_STATUS,
  createXhhAuthorizeRoutes,
} from '../src/core/xiaoheihe-authorize-route.mjs';

const TOKEN = 'console-token-for-tests-0123456789';
const BG = 'patrol:background';
const USER = 'private:123456789';
const T0 = Date.UTC(2026, 9, 24, 2, 0, 0);
const FULL = (short) => `mcp__xiaoheihe__${short}`;

function agentClassOf(agentKey) {
  if (agentKey === BG) return 'background';
  if (agentKey === USER) return 'user';
  return 'unknown';
}

function makeApi(overrides = {}) {
  const calls = { authorize: [], commit: [], abort: [], complete: [] };
  return {
    calls,
    async authorize(request) {
      calls.authorize.push(request);
      if (typeof overrides.authorize === 'function') return overrides.authorize(request);
      return {
        ok: true,
        decision: 'allow',
        exemption: 'quota',
        counted: true,
        ticket: { kind: 'read', id: 't-1' },
        agentClass: agentClassOf(request.agentKey),
      };
    },
    async commit(request) {
      calls.commit.push(request);
      if (typeof overrides.commit === 'function') return overrides.commit(request);
      return { ok: true, started: true, ticket: { kind: 'post', id: 't-1', at: T0 } };
    },
    async abort(request) {
      calls.abort.push(request);
      if (typeof overrides.abort === 'function') return overrides.abort(request);
      return { ok: true, aborted: true, rolledBack: false };
    },
    async complete(request) {
      calls.complete.push(request);
      if (typeof overrides.complete === 'function') return overrides.complete(request);
      return { ok: true, completed: true, outcome: request.outcome };
    },
  };
}

function makeRoutes({ api = makeApi(), token = TOKEN, backgroundSessionKeys = [BG], clock = () => T0, audit = null } = {}) {
  const events = [];
  const routes = createXhhAuthorizeRoutes({
    authorizeApi: api,
    consoleToken: token,
    backgroundSessionKeys,
    clock,
    audit: (event) => {
      events.push(event);
      if (typeof audit === 'function') audit(event);
    },
  });
  return { routes, api, events };
}

function headersWith(token = TOKEN, headerName = 'x-console-token') {
  return token === undefined ? {} : { [headerName]: token };
}

function authorizeRequest(body, { token = TOKEN, headerName = 'x-console-token', headers } = {}) {
  return { headers: headers ?? headersWith(token, headerName), body };
}

function validAuthorizeBody(overrides = {}) {
  return {
    agentKey: BG,
    tool: FULL('get_home_content'),
    args: { id: 'post-1' },
    ...overrides,
  };
}

test('exports: status 常量与工厂', () => {
  assert.equal(XHH_AUTHORIZE_ROUTE_STATUS.OK, 200);
  assert.equal(XHH_AUTHORIZE_ROUTE_STATUS.UNAUTHORIZED, 401);
  assert.equal(XHH_AUTHORIZE_ROUTE_STATUS.FORBIDDEN, 403);
  assert.equal(XHH_AUTHORIZE_ROUTE_STATUS.BAD_REQUEST, 400);
  assert.equal(XHH_AUTHORIZE_ROUTE_STATUS.INTERNAL, 500);
  assert.equal(typeof createXhhAuthorizeRoutes, 'function');
});

test('工厂校验：authorizeApi / consoleToken / backgroundSessionKeys 必填', () => {
  assert.throws(() => createXhhAuthorizeRoutes({}), TypeError);
  assert.throws(() => createXhhAuthorizeRoutes({ authorizeApi: makeApi() }), TypeError);
  assert.throws(
    () => createXhhAuthorizeRoutes({ authorizeApi: {}, consoleToken: TOKEN, backgroundSessionKeys: [BG] }),
    TypeError,
  );
  assert.throws(
    () => createXhhAuthorizeRoutes({ authorizeApi: makeApi(), consoleToken: '', backgroundSessionKeys: [BG] }),
    TypeError,
  );
  assert.throws(
    () => createXhhAuthorizeRoutes({ authorizeApi: makeApi(), consoleToken: TOKEN }),
    TypeError,
  );
});

test('鉴权：token 缺失 → 401；错误/空 → 403/401；绝不泄露 token 或内部信息', async () => {
  const { routes, api, events } = makeRoutes();

  const missing = await routes.handleAuthorize({ headers: {}, body: validAuthorizeBody() });
  assert.equal(missing.status, 401);
  assert.deepEqual(missing.body, { ok: false, error: 'unauthorized' });
  assert.ok(!JSON.stringify(missing.body).includes(TOKEN));

  const wrong = await routes.handleAuthorize(authorizeRequest(validAuthorizeBody(), { token: 'x'.repeat(TOKEN.length) }));
  assert.equal(wrong.status, 403);
  assert.deepEqual(wrong.body, { ok: false, error: 'forbidden' });

  const empty = await routes.handleAuthorize(authorizeRequest(validAuthorizeBody(), { token: '' }));
  assert.equal(empty.status, 401);

  assert.equal(api.calls.authorize.length, 0, '鉴权失败不得调用 authorizeApi');
  assert.ok(events.length >= 3, '鉴权失败也要审计');
  for (const event of events) assert.equal(event.decision, 'deny');
});

test('鉴权：不同长度 token 的 timing-safe 比较不抛错（长/短都 403）', async () => {
  const { routes } = makeRoutes();
  for (const token of ['', 'x', 'x'.repeat(TOKEN.length - 1), 'x'.repeat(TOKEN.length + 3), '§'.repeat(5)]) {
    const result = await routes.handleAuthorize(authorizeRequest(validAuthorizeBody(), { token }));
    assert.ok(result.status === 401 || result.status === 403, `token=${JSON.stringify(token)} 不应崩溃`);
  }
});

test('鉴权：header 名大小写不敏感；headers 支持类似 Headers 的 get()', async () => {
  const { routes } = makeRoutes();
  const upper = await routes.handleAuthorize(authorizeRequest(validAuthorizeBody(), {
    headers: { 'X-Console-Token': TOKEN },
  }));
  assert.equal(upper.status, 200);
  const headersLike = { get: (name) => (String(name).toLowerCase() === 'x-console-token' ? TOKEN : null) };
  const viaGet = await routes.handleAuthorize(authorizeRequest(validAuthorizeBody(), { headers: headersLike }));
  assert.equal(viaGet.status, 200);
});

test('authorize 请求校验：body 非对象/agentKey/tool/args/now 非法 → 400 固定错误码，且不调 authorizeApi', async () => {
  const { routes, api } = makeRoutes();
  const cases = [
    [null, 'invalid-body'],
    [[], 'invalid-body'],
    ['x', 'invalid-body'],
    [{ agentKey: '', tool: FULL('get_home_content'), args: {} }, 'invalid-agent'],
    [{ agentKey: 42, tool: FULL('get_home_content'), args: {} }, 'invalid-agent'],
    [{ agentKey: '  ', tool: FULL('get_home_content'), args: {} }, 'invalid-agent'],
    [{ agentKey: BG, tool: '', args: {} }, 'invalid-tool'],
    [{ agentKey: BG, tool: 'mcp__xiaoheihe__delete_post', args: {} }, 'invalid-tool'],
    [{ agentKey: BG, tool: 'qq_send_message', args: {} }, 'invalid-tool'],
    [{ agentKey: BG, tool: FULL('get_home_content'), args: 'x' }, 'invalid-args'],
    [{ agentKey: BG, tool: FULL('get_home_content'), args: [] }, 'invalid-args'],
  ];
  for (const [body, error] of cases) {
    const result = await routes.handleAuthorize(authorizeRequest(body));
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.deepEqual(result.body, { ok: false, error }, JSON.stringify(body));
  }
  const badClock = await routes.handleAuthorize({ headers: headersWith(), body: validAuthorizeBody(), now: 'now' });
  assert.equal(badClock.status, 400);
  assert.deepEqual(badClock.body, { ok: false, error: 'invalid-clock' });
  assert.equal(api.calls.authorize.length, 0);
});

test('agentKey 语义：backgroundSessionKeys 命中 → 后台；未命中 → 用户例外；都传给 authorizeApi', async () => {
  const { routes, api, events } = makeRoutes();
  const background = await routes.handleAuthorize(authorizeRequest(validAuthorizeBody({ agentKey: BG })));
  assert.equal(background.status, 200);
  assert.equal(api.calls.authorize[0].agentKey, BG);
  const user = await routes.handleAuthorize(authorizeRequest(validAuthorizeBody({ agentKey: USER })));
  assert.equal(user.status, 200);
  assert.equal(api.calls.authorize[1].agentKey, USER);

  const backgroundEvent = events.find((event) => event.agentClass === 'background');
  const userEvent = events.find((event) => event.agentClass === 'user');
  assert.ok(backgroundEvent && userEvent, '审计必须区分 background/user');
});

test('allow 映射：200 + decision:allow + exemption/ticket 透传；now 传给 authorizeApi', async () => {
  const { routes, api } = makeRoutes();
  const result = await routes.handleAuthorize({ headers: headersWith(), body: validAuthorizeBody(), now: T0 + 5 });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.decision, 'allow');
  assert.equal(result.body.exemption, 'quota');
  assert.equal(result.body.ticket.id, 't-1');
  assert.equal(api.calls.authorize[0].now, T0 + 5);
  assert.equal(api.calls.authorize[0].tool, FULL('get_home_content'));
  assert.deepEqual(api.calls.authorize[0].args, { id: 'post-1' });
});

test('deny 映射：HTTP 200 + decision:deny + reason/controllerReason（策略拒绝不是传输错误）', async () => {
  const api = makeApi({ authorize: async () => ({ ok: true, decision: 'deny', reason: 'read-daily-cap', controllerReason: 'read-daily-cap' }) });
  const { routes, events } = makeRoutes({ api });
  const result = await routes.handleAuthorize(authorizeRequest(validAuthorizeBody()));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, decision: 'deny', reason: 'read-daily-cap', controllerReason: 'read-daily-cap' });
  const audit = events.find((event) => event.type === 'authorize' && event.decision === 'deny');
  assert.ok(audit);
});

test('异常 fail-closed：authorizeApi 抛错/返回非法/缺 decision → 500，绝不返回 allow', async () => {
  for (const bad of [
    async () => { throw new Error('boom'); },
    async () => 'not-an-object',
    async () => null,
    async () => ({}),
    async () => ({ ok: false }),
  ]) {
    const api = makeApi({ authorize: bad });
    const { routes, events } = makeRoutes({ api });
    const result = await routes.handleAuthorize(authorizeRequest(validAuthorizeBody()));
    assert.equal(result.status, 500, String(bad));
    assert.deepEqual(result.body, { ok: false, error: 'internal-error' });
    assert.notEqual(result.body.decision, 'allow');
    assert.ok(events.some((event) => event.type === 'authorize' && event.error === 'internal-error'));
  }
});

test('complete 校验：body/ticket/outcome 非法 → 400；不调 authorizeApi', async () => {
  const { routes, api } = makeRoutes();
  const cases = [
    [null, 'invalid-body'],
    [[], 'invalid-body'],
    [{ outcome: 'success' }, 'invalid-ticket'],
    [{ ticket: null, outcome: 'success' }, 'invalid-ticket'],
    [{ ticket: 'x', outcome: 'success' }, 'invalid-ticket'],
    [{ ticket: { apiId: 'a', kind: 'write' }, outcome: 'done' }, 'invalid-outcome'],
    [{ ticket: { apiId: 'a', kind: 'write' }, outcome: '' }, 'invalid-outcome'],
  ];
  for (const [body, error] of cases) {
    const result = await routes.handleComplete({ headers: headersWith(), body });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.deepEqual(result.body, { ok: false, error }, JSON.stringify(body));
  }
  const badClock = await routes.handleComplete({ headers: headersWith(), body: { ticket: { apiId: 'a' }, outcome: 'success' }, now: Number.NaN });
  assert.equal(badClock.status, 400);
  assert.deepEqual(badClock.body, { ok: false, error: 'invalid-clock' });
  assert.equal(api.calls.complete.length, 0);
});

test('complete 透传 agentKey：错误 agentKey → 200 {ok:false,reason:"invalid-ticket"}，不假装成功', async () => {
  const api = makeApi({
    complete: async (request) => (request.agentKey === 'right-agent'
      ? { ok: true, completed: true }
      : { ok: false, reason: 'invalid-ticket' }),
  });
  const { routes } = makeRoutes({ api });
  const good = await routes.handleComplete({
    headers: headersWith(),
    body: { ticket: { apiId: 'a', kind: 'write', agentKey: 'right-agent' }, outcome: 'success', agentKey: 'right-agent' },
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.ok, true);
  const bad = await routes.handleComplete({
    headers: headersWith(),
    body: { ticket: { apiId: 'a', kind: 'write', agentKey: 'right-agent' }, outcome: 'success', agentKey: 'wrong-agent' },
  });
  assert.equal(bad.status, 200);
  assert.deepEqual(bad.body, { ok: false, reason: 'invalid-ticket' });
  assert.equal(api.calls.complete[1].agentKey, 'wrong-agent');
});

test('complete 映射：成功 → 200 透传 completed/outcome；already → 200 already:true', async () => {
  const { routes, api } = makeRoutes();
  const first = await routes.handleComplete({ headers: headersWith(), body: { ticket: { apiId: 'a', kind: 'write' }, outcome: 'success' }, now: T0 + 1 });
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.completed, true);
  assert.equal(api.calls.complete[0].outcome, 'success');
  assert.equal(api.calls.complete[0].now, T0 + 1);

  const idempotentApi = makeApi({ complete: async () => ({ ok: true, completed: false, already: true }) });
  const idempotent = makeRoutes({ api: idempotentApi });
  const again = await idempotent.routes.handleComplete({ headers: headersWith(), body: { ticket: { apiId: 'a', kind: 'write' }, outcome: 'unknown' } });
  assert.equal(again.status, 200);
  assert.equal(again.body.already, true);
});

test('重复读取回执审计保留首次结果并标识重复', async () => {
  const api = makeApi({ complete: async () => ({ ok: true, completed: false, ignored: true, already: true, outcome: 'failure' }) });
  const { routes, events } = makeRoutes({ api });
  const result = await routes.handleComplete({ headers: headersWith(), body: {
    ticket: { apiId: 'a', kind: 'read', agentKey: BG, tool: FULL('get_home_content') }, outcome: 'success',
  } });
  assert.equal(result.body.outcome, 'failure');
  const entry = events.find((event) => event.type === 'complete');
  assert.equal(entry.outcome, 'failure');
  assert.equal(entry.reason, 'duplicate-complete');
});

test('成功读取的可信序号透传到完成事件', async () => {
  const api = makeApi({ complete: async () => ({ ok: true, ignored: true, outcome: 'success', readIndex: 2, readStartedAt: T0 - 1 }) });
  const { routes, events } = makeRoutes({ api });
  await routes.handleComplete({ headers: headersWith(), body: {
    ticket: { apiId: 'a', kind: 'read', agentKey: BG, tool: FULL('get_home_content') }, outcome: 'success',
  } });
  assert.equal(events.find((event) => event.type === 'complete')?.readIndex, 2);
  assert.equal(events.find((event) => event.type === 'complete')?.readStartedAt, T0 - 1);
});

test('complete 幂等：authorizeApi 返回 unknown-ticket → 200（不是 500）；内部异常 → 500', async () => {
  const unknownApi = makeApi({ complete: async () => ({ ok: false, reason: 'unknown-ticket' }) });
  const unknown = makeRoutes({ api: unknownApi });
  const result = await unknown.routes.handleComplete({ headers: headersWith(), body: { ticket: { apiId: 'x' }, outcome: 'success' } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: false, error: 'unknown-ticket' });

  const throwingApi = makeApi({ complete: async () => { throw new Error('bridge down'); } });
  const throwing = makeRoutes({ api: throwingApi });
  const failed = await throwing.routes.handleComplete({ headers: headersWith(), body: { ticket: { apiId: 'x' }, outcome: 'success' } });
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { ok: false, error: 'internal-error' });
});

test('审计：固定字段白名单、无 token/args/evidence 原文；auth 失败/校验失败/正常/异常都覆盖', async () => {
  const { routes, events } = makeRoutes();
  await routes.handleAuthorize(authorizeRequest(validAuthorizeBody({ args: { operationId: 'op-1', text: 'SENSITIVE_TEXT' } }), { token: 'wrong-token' }));
  await routes.handleAuthorize(authorizeRequest({ agentKey: BG, tool: 'bad', args: {} }));
  await routes.handleAuthorize(authorizeRequest(validAuthorizeBody()));
  await routes.handleComplete({ headers: headersWith(), body: { ticket: { apiId: 'a' }, outcome: 'success' } });

  const allowedKeys = new Set(['type', 'at', 'agentClass', 'tool', 'decision', 'status', 'reason', 'exemption', 'outcome', 'error']);
  assert.ok(events.length >= 4);
  for (const event of events) {
    assert.ok(['authorize', 'complete'].includes(event.type));
    assert.equal(typeof event.at, 'number');
    for (const key of Object.keys(event)) {
      assert.ok(allowedKeys.has(key), `审计含未声明字段 ${key}`);
    }
    const serialized = JSON.stringify(event);
    assert.ok(!serialized.includes(TOKEN), '审计不得包含 token');
    assert.ok(!serialized.includes('SENSITIVE_TEXT'), '审计不得包含 args 原文');
  }
});

test('审计回调抛错：不影响响应（仍是 200/400/500 正常结果）', async () => {
  const { routes } = makeRoutes({ audit: () => { throw new Error('audit boom'); } });
  const allow = await routes.handleAuthorize(authorizeRequest(validAuthorizeBody()));
  assert.equal(allow.status, 200);
  const bad = await routes.handleAuthorize(authorizeRequest({}));
  assert.equal(bad.status, 400);
});

test('响应体可 JSON 序列化且不含循环引用/敏感原文', async () => {
  const { routes } = makeRoutes({ api: makeApi({ authorize: async () => ({ ok: true, decision: 'deny', reason: 'write-paused' }) }) });
  const result = await routes.handleAuthorize(authorizeRequest(validAuthorizeBody()));
  assert.doesNotThrow(() => JSON.stringify(result.body));
  assert.ok(!JSON.stringify(result.body).includes('SENSITIVE'));
});

test('agentClass 以 authorizeApi 结果为准：未知 key 不被 route 标 user；后台/用户以 API 分类为准', async () => {
  // 未知 key：authorizeApi 判 unknown 并 deny unknown-agent → route 200 deny，审计 agentClass=unknown。
  const unknownApi = makeApi({ authorize: async () => ({ ok: true, decision: 'deny', reason: 'unknown-agent', agentClass: 'unknown' }) });
  const unknown = makeRoutes({ api: unknownApi });
  const unknownResult = await unknown.routes.handleAuthorize(authorizeRequest(validAuthorizeBody({ agentKey: 'agent:not-listed-anywhere' })));
  assert.equal(unknownResult.status, 200);
  assert.deepEqual(unknownResult.body, { ok: true, decision: 'deny', reason: 'unknown-agent' });
  const unknownAudit = unknown.events.find((event) => event.type === 'authorize' && event.decision === 'deny');
  assert.equal(unknownAudit.agentClass, 'unknown', 'route 不得再把未知 key 标成 user');

  // 后台 key：authorizeApi 返回 agentClass=background。
  const backgroundApi = makeApi({ authorize: async () => ({ ok: true, decision: 'allow', exemption: 'quota', agentClass: 'background', ticket: { kind: 'read' } }) });
  const background = makeRoutes({ api: backgroundApi });
  await background.routes.handleAuthorize(authorizeRequest(validAuthorizeBody({ agentKey: BG })));
  assert.equal(background.events.at(-1).agentClass, 'background');

  // 用户 key：authorizeApi 返回 agentClass=user（豁免是 API 的决定）。
  const userApi = makeApi({ authorize: async () => ({ ok: true, decision: 'allow', exemption: 'user', counted: false, agentClass: 'user', ticket: { kind: 'exempt' } }) });
  const user = makeRoutes({ api: userApi });
  const userResult = await user.routes.handleAuthorize(authorizeRequest(validAuthorizeBody({ agentKey: USER })));
  assert.equal(userResult.body.exemption, 'user');
  assert.equal(user.events.at(-1).agentClass, 'user');

  // 兼容旧/第三方 authorizeApi 未返回 agentClass：非后台 key 回退 unknown（绝不猜 user）。
  const legacyApi = makeApi({ authorize: async () => ({ ok: true, decision: 'allow' }) });
  const legacy = makeRoutes({ api: legacyApi });
  await legacy.routes.handleAuthorize(authorizeRequest(validAuthorizeBody({ agentKey: USER })));
  assert.equal(legacy.events.at(-1).agentClass, 'unknown');
});

test('commit 端点：鉴权/body/ticket 校验，200 透传 started/ticket', async () => {
  const { routes, api, events } = makeRoutes();
  const ticket = { kind: 'post', id: 'p1' };
  const ok = await routes.handleCommit({ headers: headersWith(), body: { ticket, agentKey: BG } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.started, true);
  assert.deepEqual(api.calls.commit[0].ticket, ticket);
  assert.equal(api.calls.commit[0].agentKey, BG);
  const audit = events.find((event) => event.type === 'commit');
  assert.ok(audit);
  assert.equal(audit.decision, 'allow');

  const missingToken = await routes.handleCommit({ headers: {}, body: { ticket } });
  assert.equal(missingToken.status, 401);
  const badTicket = await routes.handleCommit({ headers: headersWith(), body: {} });
  assert.equal(badTicket.status, 400);
  assert.deepEqual(badTicket.body, { ok: false, error: 'invalid-ticket' });
  const badAgent = await routes.handleCommit({ headers: headersWith(), body: { ticket, agentKey: 42 } });
  assert.equal(badAgent.status, 400);
  assert.deepEqual(badAgent.body, { ok: false, error: 'invalid-agent' });
});

test('commit/abort 业务拒绝映射 200 {ok:false,reason}；abort 幂等透传 already/rolledBack；内部异常 500', async () => {
  const deniedApi = makeApi({ commit: async () => ({ ok: false, reason: 'ticket-expired', controllerReason: 'ticket-expired' }) });
  const denied = makeRoutes({ api: deniedApi });
  const deniedResult = await denied.routes.handleCommit({ headers: headersWith(), body: { ticket: { ticketId: 'x' } } });
  assert.equal(deniedResult.status, 200);
  assert.deepEqual(deniedResult.body, { ok: false, reason: 'ticket-expired', controllerReason: 'ticket-expired' });

  const abortApi = makeApi({ abort: async () => ({ ok: true, aborted: true, already: true, rolledBack: true }) });
  const aborted = makeRoutes({ api: abortApi });
  const abortResult = await aborted.routes.handleAbort({ headers: headersWith(), body: { ticket: { ticketId: 'x' } } });
  assert.equal(abortResult.status, 200);
  assert.deepEqual(abortResult.body, { ok: true, aborted: true, already: true, rolledBack: true });

  for (const [label, method] of [['commit', 'handleCommit'], ['abort', 'handleAbort']]) {
    const throwingApi = makeApi({
      [label]: async () => { throw new Error('boom'); },
    });
    const throwing = makeRoutes({ api: throwingApi });
    const response = await throwing.routes[method]({ headers: headersWith(), body: { ticket: { ticketId: 'x' } } });
    assert.equal(response.status, 500, label);
    assert.deepEqual(response.body, { ok: false, error: 'internal-error' });
  }
});
