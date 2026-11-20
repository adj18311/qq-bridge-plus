// scripts/test-xhh-guard-failclosed.mjs
// task-108：插件失效时小黑盒门禁 fail-closed 加固的离线测试。
//
// 失效场景：配置非法 / enabled!==true / client 构造失败 / normalize 抛错 / bridge 不可达。
// 期望：apply 不抛错、仍注册 fallback tools/execute（+ post-execute + guard）；
//      fallback 下**所有**小黑盒工具（含只读）在 dispatch 前 deny（不 next、无请求），
//      防止绕过读取额度 / accessPaused / 登录失效暂停 / 来源计数；非小黑盒工具直通。
// 全部离线：fake ctx + fake client；不连真实 DSH/HTTP/桥接/平台，不读 config/state，不安装插件。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  XHH_QUOTA_TOOL_PREFIX,
  isWriteTool,
  classifyFallbackTool,
} from '../plugins/xhh-quota-guard/decision.mjs';
import { apply, applyWithDeps, inject } from '../plugins/xhh-quota-guard/index.mjs';

const FULL = (short) => `${XHH_QUOTA_TOOL_PREFIX}${short}`;
const SECRET = 'SECRET_TOKEN_DO_NOT_LOG';
const ARG_SECRET = 'ARG_SECRET_DO_NOT_LOG';

function makeCtx({ withGuard = true } = {}) {
  const listeners = new Map();
  const warnings = [];
  const guards = [];
  const ctx = {
    listeners,
    warnings,
    guards,
    on(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    logger: {
      warn(message) { warnings.push(String(message)); },
      info() {},
    },
  };
  if (withGuard) {
    ctx.tools = {
      guard(fn) {
        guards.push(fn);
        return () => {};
      },
    };
  }
  return ctx;
}

function makeExec(name, overrides = {}) {
  return {
    name,
    arguments: { postId: 'post-1', text: ARG_SECRET },
    agent: { id: 'session-a', session: { id: 'session-a' } },
    signal: { aborted: false },
    ...overrides,
  };
}

function makeNext(result = { isError: false, content: [{ type: 'text', text: 'tool-result' }] }) {
  const calls = [];
  const next = async () => { calls.push(true); return result; };
  next.calls = calls;
  return next;
}

function makeClient(overrides = {}) {
  const calls = { authorize: [], commit: [], abort: [], complete: [] };
  function invoke(name, fallback, request) {
    calls[name].push(request);
    return typeof overrides[name] === 'function' ? overrides[name](request) : fallback;
  }
  return {
    calls,
    async authorize(request) {
      return invoke('authorize', { ok: true, decision: 'allow', ticket: { kind: 'read', ticketId: 'ticket-1' } }, request);
    },
    async commit(request) {
      return invoke('commit', { ok: true, started: true, ticket: { ...request.ticket, state: 'started' } }, request);
    },
    async abort(request) {
      return invoke('abort', { ok: true, aborted: true, rolledBack: true }, request);
    },
    async complete(request) {
      return invoke('complete', { ok: true, completed: true }, request);
    },
  };
}

function startWithClient(ctx, client, config = {}) {
  apply(ctx, {
    enabled: true,
    timeoutMs: 500,
    authorize: client.authorize,
    commit: client.commit,
    abort: client.abort,
    complete: client.complete,
    ...config,
  });
}

function executeHook(ctx) {
  const listener = ctx.listeners.get('tools/execute');
  assert.ok(listener, '必须始终注册 tools/execute（fallback 也要在 dispatch 前可拦截）');
  return listener;
}

function postHook(ctx) {
  const listener = ctx.listeners.get('tools/post-execute');
  assert.ok(listener, '必须注册 tools/post-execute（active 兜底 finish）');
  return listener;
}

/** 覆盖“插件失效”的全部入口场景：非法/禁用/半配置。 */
const FALLBACK_CONFIGS = [
  ['undefined', undefined],
  ['empty-object', {}],
  ['enabled-false', { enabled: false }],
  ['enabled-string', { enabled: 'true' }],
  ['enabled-number', { enabled: 1 }],
  ['invalid-timeout', { enabled: true, timeoutMs: 100, consoleToken: SECRET }],
  ['missing-commit-abort-complete', { enabled: true, authorize: async () => ({ ok: true, decision: 'allow' }) }],
  ['missing-console-token', { enabled: true, bridgeUrl: 'http://127.0.0.1:19489' }],
  ['non-loopback-bridge', { enabled: true, bridgeUrl: 'http://10.0.0.1:19489', consoleToken: SECRET }],
  ['bridge-with-query', { enabled: true, bridgeUrl: 'http://127.0.0.1:19489/?x=1', consoleToken: SECRET }],
  ['invalid-resolver', { enabled: true, agentKeyResolver: 'nope', consoleToken: SECRET }],
  ['not-an-object', 'enabled=true'],
];

test('loader 契约：inject 包含 tools（fallback 依赖 ctx.tools.guard 可选注册）', () => {
  assert.ok(Array.isArray(inject));
  assert.ok(inject.includes('tools'));
});

test('decision：fallback 对只读工具也 deny（不得绕过读取额度/暂停）', () => {
  for (const name of ['get_home_content', 'get_post_detail', 'search_content', 'check_login_status', 'get_user_profile']) {
    assert.equal(isWriteTool(name), false, `${name} 不是写工具`);
    assert.deepEqual(classifyFallbackTool(FULL(name)), { kind: 'deny', reason: 'fail-closed-no-authorization' }, name);
  }
});

test('decision：fallback 对写/登录/未知小黑盒工具一律 deny，非 xhh 直通', () => {
  for (const name of ['publish_content', 'publish_article', 'publish_video', 'post_comment', 'reply_comment']) {
    assert.deepEqual(classifyFallbackTool(FULL(name)), { kind: 'deny', reason: 'fail-closed-no-authorization' }, name);
  }
  for (const name of ['interactive_login', 'get_login_qr_code']) {
    assert.deepEqual(classifyFallbackTool(FULL(name)), { kind: 'deny', reason: 'fail-closed-no-authorization' }, name);
  }
  assert.deepEqual(classifyFallbackTool(FULL('delete_everything')), { kind: 'deny', reason: 'fail-closed-no-authorization' });
  assert.deepEqual(classifyFallbackTool('qq_send_message'), { kind: 'passthrough', reason: null });
  assert.deepEqual(classifyFallbackTool('ops_bash'), { kind: 'passthrough', reason: null });
  assert.deepEqual(classifyFallbackTool(null), { kind: 'passthrough', reason: null });
});

test('失效场景：apply 不抛错，仍注册 execute/post-execute/guard，且日志不泄露', () => {
  for (const [label, config] of FALLBACK_CONFIGS) {
    const ctx = makeCtx();
    assert.doesNotThrow(() => apply(ctx, config), `${label}: apply 不得因配置错误抛错`);
    assert.equal(typeof executeHook(ctx), 'function', `${label}: 必须有 execute 监听`);
    assert.equal(typeof postHook(ctx), 'function', `${label}: 必须有 post-execute 监听`);
    assert.equal(ctx.guards.length, 1, `${label}: 必须注册 guard`);
    assert.ok(ctx.warnings.length >= 1, `${label}: 应告警进入 fail-closed 模式`);
    assert.match(ctx.warnings[0], /fail-closed/);
    const joined = JSON.stringify(ctx.warnings);
    assert.doesNotMatch(joined, new RegExp(SECRET), `${label}: 日志不得泄露 consoleToken`);
    assert.doesNotMatch(joined, /ticket-1/, `${label}: 日志不得泄露 ticket`);
  }
});

test('失效场景：所有小黑盒工具（含只读）dispatch 前 deny（绝不 next、无任何请求）', async () => {
  const denyCases = [
    [FULL('publish_content')],
    [FULL('post_comment')],
    [FULL('publish_video')],
    [FULL('interactive_login')],
    [FULL('get_login_qr_code')],
    [FULL('get_home_content')],
    [FULL('search_content')],
    [FULL('future_unknown_tool')],
  ];
  for (const [label, config] of FALLBACK_CONFIGS) {
    for (const [toolName] of denyCases) {
      const ctx = makeCtx();
      apply(ctx, config);
      const next = makeNext();
      const result = await executeHook(ctx)(makeExec(toolName), next);
      assert.equal(next.calls.length, 0, `${label}/${toolName}: 不得 dispatch`);
      assert.equal(result?.isError, true, `${label}/${toolName}: 必须返回 isError 结果`);
      assert.equal(result?.error?.code, 'XHH_GUARD_DENIED');
      assert.match(result.content[0].text, /fail-closed-no-authorization/, `${label}/${toolName}: 固定拒绝原因`);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(`${SECRET}|${ARG_SECRET}|ticket-1`));
    }
  }
});

test('失效场景：只读工具也不放行（读取额度/暂停不能在插件外被绕过）', async () => {
  for (const [label, config] of FALLBACK_CONFIGS) {
    const ctx = makeCtx();
    apply(ctx, config);
    for (const short of ['get_home_content', 'get_post_detail', 'search_content', 'check_login_status', 'get_user_profile']) {
      const next = makeNext();
      const result = await executeHook(ctx)(makeExec(FULL(short), { arguments: { postId: 'p1' } }), next);
      assert.equal(next.calls.length, 0, `${label}/${short}: 只读也不得 dispatch`);
      assert.equal(result?.isError, true, `${label}/${short}: 必须返回 isError`);
      assert.match(result.content[0].text, /fail-closed-no-authorization/, `${label}/${short}: 固定原因`);
    }
  }
});

test('失效场景：fallback 下 client 授权方法零调用（结构性断言，不替代网络计数）', async () => {
  const ctx = makeCtx();
  const client = makeClient();
  // 即使把合法的注入函数也一并传入，只要 enabled!==true 就必须保持 fallback。
  startWithClient(ctx, client, { enabled: false });
  for (const toolName of [FULL('publish_content'), FULL('get_home_content'), FULL('future_unknown_tool')]) {
    await executeHook(ctx)(makeExec(toolName), makeNext());
  }
  assert.equal(client.calls.authorize.length, 0, 'fallback 不得调用 authorize');
  assert.equal(client.calls.commit.length, 0, 'fallback 不得调用 commit');
  assert.equal(client.calls.abort.length, 0, 'fallback 不得调用 abort');
  assert.equal(client.calls.complete.length, 0, 'fallback 不得调用 complete');
});

test('失效场景：fallback 不构造 client（结构性证据，不宣称覆盖所有网络路径）', async () => {
  let factoryCalls = 0;
  const ctx = makeCtx();
  applyWithDeps(
    ctx,
    { enabled: false, bridgeUrl: 'http://127.0.0.1:19489', consoleToken: SECRET },
    {
      createClient() {
        factoryCalls += 1;
        return makeClient();
      },
    },
  );
  const writeNext = makeNext();
  const denied = await executeHook(ctx)(makeExec(FULL('publish_content')), writeNext);
  assert.equal(writeNext.calls.length, 0, 'fallback 写工具不得 dispatch');
  assert.equal(denied?.isError, true);
  const readNext = makeNext();
  const readDenied = await executeHook(ctx)(makeExec(FULL('search_content')), readNext);
  assert.equal(readNext.calls.length, 0, 'fallback 只读也不得 dispatch');
  assert.equal(readDenied?.isError, true);
  assert.equal(factoryCalls, 0, 'fallback 不得构造授权 client');
});

test('失效场景：非小黑盒工具直通，不误拦', async () => {
  const ctx = makeCtx();
  apply(ctx, { enabled: false });
  const payload = { isError: false, content: [{ type: 'text', text: 'bash-ok' }] };
  const next = makeNext(payload);
  const result = await executeHook(ctx)(makeExec('ops_bash'), next);
  assert.equal(next.calls.length, 1);
  assert.deepEqual(result, payload);
});

test('失效场景：guard 同步拦截所有小黑盒工具，非 xhh 放行', () => {
  const ctx = makeCtx();
  apply(ctx, { enabled: false });
  const guard = ctx.guards[0];
  for (const short of ['publish_content', 'interactive_login', 'future_unknown_tool', 'get_home_content', 'search_content']) {
    assert.match(guard(makeExec(FULL(short))), /fail-closed-no-authorization/, short);
  }
  assert.equal(guard(makeExec('qq_send_message')), undefined);
});

test('失效场景：无 ctx.tools.guard 时仍能注册 execute 并 fail-closed（缺 guard 不致命）', async () => {
  const ctx = makeCtx({ withGuard: false });
  assert.doesNotThrow(() => apply(ctx, { enabled: true, timeoutMs: 100 }));
  const next = makeNext();
  const result = await executeHook(ctx)(makeExec(FULL('publish_content')), next);
  assert.equal(next.calls.length, 0);
  assert.match(result.content[0].text, /fail-closed-no-authorization/);
});

test('client 构造失败：apply 不抛错，保持 fallback（含只读一律 deny），日志无异常原文', async () => {
  const ctx = makeCtx();
  assert.doesNotThrow(() => applyWithDeps(
    ctx,
    { enabled: true, bridgeUrl: 'http://127.0.0.1:19489', consoleToken: SECRET },
    { createClient: () => { throw new Error(`构造爆炸 ${SECRET}`); } },
  ));
  assert.equal(typeof executeHook(ctx), 'function');
  assert.equal(ctx.guards.length, 1);
  const joined = JSON.stringify(ctx.warnings);
  assert.doesNotMatch(joined, new RegExp(SECRET));
  assert.doesNotMatch(joined, /构造爆炸/);

  const deniedNext = makeNext();
  const denied = await executeHook(ctx)(makeExec(FULL('publish_content')), deniedNext);
  assert.equal(deniedNext.calls.length, 0);
  assert.match(denied.content[0].text, /fail-closed-no-authorization/);

  const readNext = makeNext();
  const readDenied = await executeHook(ctx)(makeExec(FULL('get_home_content')), readNext);
  assert.equal(readNext.calls.length, 0);
  assert.match(readDenied.content[0].text, /fail-closed-no-authorization/);
});

test('bridge 不可达（active 但 authorize 抛错）：写工具 dispatch 前 deny，不静默放行', async () => {
  const ctx = makeCtx();
  const client = makeClient({ authorize: () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); } });
  startWithClient(ctx, client);
  const next = makeNext();
  const result = await executeHook(ctx)(makeExec(FULL('publish_content')), next);
  assert.equal(next.calls.length, 0, '授权服务不可达时写工具绝不 dispatch');
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /authorize-failed/);
  assert.equal(client.calls.commit.length, 0);
  assert.equal(client.calls.complete.length, 0);
});

test('合法 enabled：正常 execute-first 流程不被 fallback 误拒（写 allow→commit→next→complete）', async () => {
  const ctx = makeCtx();
  const client = makeClient();
  startWithClient(ctx, client);
  assert.equal(ctx.warnings.filter((m) => /fail-closed|只读模式/.test(m)).length, 0, '合法配置不得进入 fallback');
  const toolResult = { isError: false, content: [{ type: 'text', text: '发布成功' }] };
  const next = makeNext(toolResult);
  const result = await executeHook(ctx)(makeExec(FULL('publish_content')), next);
  assert.deepEqual(result, toolResult);
  assert.equal(next.calls.length, 1);
  assert.equal(client.calls.authorize.length, 1);
  assert.equal(client.calls.commit.length, 1);
  assert.equal(client.calls.complete.length, 1);
  assert.equal(client.calls.complete[0].outcome, 'success');
});

test('合法 enabled：授权 deny 仍不 next（active 语义不变）', async () => {
  const ctx = makeCtx();
  const client = makeClient({ authorize: () => ({ ok: true, decision: 'deny', reason: 'read-daily-cap' }) });
  startWithClient(ctx, client);
  const next = makeNext();
  const result = await executeHook(ctx)(makeExec(FULL('get_home_content')), next);
  assert.equal(next.calls.length, 0);
  assert.match(result.content[0].text, /read-daily-cap/);
});

test('合法 enabled：guard 仍做 missing-agent-key 检查，且不误拒正常 agent', () => {
  const ctx = makeCtx();
  startWithClient(ctx, makeClient());
  assert.equal(ctx.guards.length, 1);
  assert.equal(ctx.guards[0](makeExec(FULL('publish_content'), { agent: {} })), 'xhh-quota-guard: missing-agent-key');
  assert.equal(ctx.guards[0](makeExec(FULL('get_home_content'))), undefined);
  assert.equal(ctx.guards[0]({ name: 'qq_send_message' }), undefined);
});

test('fallback：post-execute 无票据直接 next，不调用 complete', async () => {
  const ctx = makeCtx();
  apply(ctx, {});
  const calls = [];
  await postHook(ctx)(makeExec(FULL('get_home_content')), { isError: false }, async () => { calls.push(true); return { kind: 'allow' }; });
  assert.equal(calls.length, 1);
});

test('单一 execute 监听：fallback/active 都只注册一个（避免双门互相覆盖）', () => {
  for (const config of [{}, { enabled: false }, { enabled: true, timeoutMs: 500, authorize: async () => ({}), commit: async () => ({}), abort: async () => ({}), complete: async () => ({}) }]) {
    const ctx = makeCtx();
    apply(ctx, config);
    assert.equal(ctx.listeners.size, 2, '应恰好注册 tools/execute + tools/post-execute 各一个');
    assert.equal(typeof ctx.listeners.get('tools/execute'), 'function');
    assert.equal(typeof ctx.listeners.get('tools/post-execute'), 'function');
  }
});
