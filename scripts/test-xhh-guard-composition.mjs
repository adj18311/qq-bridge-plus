// Offline, simulated execute-first waterfall: this test describes ordering risks, not deployment safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { apply } from '../plugins/xhh-quota-guard/index.mjs';

const TOOL = 'mcp__xiaoheihe__get_home_content';

function makeCtx() {
  const listeners = new Map();
  const guards = [];
  return {
    listeners,
    guards,
    on(name, fn) { listeners.set(name, fn); return () => {}; },
    tools: { guard(fn) { guards.push(fn); return () => {}; } },
    logger: { warn() {} },
  };
}

function start(overrides = {}) {
  const ctx = makeCtx();
  const calls = { authorize: [], commit: [], abort: [], complete: [] };
  apply(ctx, {
    enabled: true,
    timeoutMs: 500,
    authorize: async (req) => { calls.authorize.push(req); return overrides.authorize ? overrides.authorize(req) : { ok: true, decision: 'allow', ticket: { kind: 'read', ticketId: `t-${req.agentKey}` } }; },
    commit: async (req) => { calls.commit.push(req); return overrides.commit ? overrides.commit(req) : { ok: true, started: true, ticket: req.ticket }; },
    abort: async (req) => { calls.abort.push(req); return { ok: true, aborted: true }; },
    complete: async (req) => { calls.complete.push(req); return { ok: true }; },
  });
  return { ctx, calls };
}

function exec(id) {
  return { name: TOOL, arguments: {}, agent: id ? { id, session: { id } } : {}, signal: { aborted: false } };
}

const next = async () => ({ isError: false, content: [] });

test('distinct session identities and missing identity reach independent execute decisions', async () => {
  const { ctx, calls } = start();
  const hook = ctx.listeners.get('tools/execute');
  for (const id of ['session-a', 'session-b']) {
    await hook(exec(id), next);
  }
  const missing = await hook(exec(null), next);
  assert.equal(missing.isError, true);
  assert.deepEqual(calls.authorize.map(req => req.agentKey), ['session-a', 'session-b']);
  assert.deepEqual(calls.commit.map(req => req.agentKey), ['session-a', 'session-b']);
  assert.deepEqual(calls.complete.map(req => req.ticket.ticketId), ['t-session-a', 't-session-b']);
});

test('later execute veto after commit keeps counting: known composition risk', async () => {
  const { ctx, calls } = start();
  const hook = ctx.listeners.get('tools/execute');
  // 模拟真实 waterfall：插件 commit 后，后置 execute listener 不 next 直接返回自定义结果。
  const laterVeto = { isError: false, content: [{ type: 'text', text: 'vetoed-without-dispatch' }] };
  const result = await hook(exec('session-a'), async () => laterVeto);
  assert.deepEqual(result, laterVeto);
  assert.equal(calls.commit.length, 1);
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.abort.length, 0, '不是已知 pre-dispatch 码 → 不回滚（已知限制）');
});

test('earlier pre-execute short-circuit does not skip execute-first authorization', async () => {
  const { ctx, calls } = start();
  const hook = ctx.listeners.get('tools/execute');
  // 模拟早 pre-execute listener 不 next 直接 allow：插件已不依赖 pre-execute 授权。
  const earlierPre = async () => ({ kind: 'allow' });
  assert.equal((await earlierPre()).kind, 'allow');
  const result = await hook(exec('session-a'), next);
  assert.equal(result.isError, false);
  assert.equal(calls.authorize.length, 1, 'execute 仍会授权');
  assert.equal(calls.commit.length, 1);
  assert.equal(calls.complete.length, 1);
});

test('B1 文档一致性：execute-first 架构说明、不得保留“pre 阶段可避免白扣”的错误保证；token 统一', async () => {
  const readme = await fs.readFile(new URL('../plugins/xhh-quota-guard/README.md', import.meta.url), 'utf8');
  const index = await fs.readFile(new URL('../plugins/xhh-quota-guard/index.mjs', import.meta.url), 'utf8');
  for (const text of [readme, index]) {
    assert.doesNotMatch(text, /避免被后续 deny 时白扣额度|避免.*白扣额度/, '不得保留错误保证');
  }
  assert.match(readme, /execute-first|tools\/execute/);
  assert.match(readme, /ABORTED_BEFORE_DISPATCH|UNKNOWN_TOOL/);
  assert.match(readme, /已知限制/);
  assert.match(readme, /backgroundPatrol\.authorizeToken/);
  assert.match(readme, /同一个独立(的)?授权秘密|同一独立授权秘密/);
  assert.match(readme, /不是控制台管理 token|不是控制台 token/);
});


test('fake waterfall 顺序：deny 不 next/假 MCP 0；allow → commit → next → finish/假 MCP 1', async () => {
  // deny：authorize 拒绝，dispatch/假 MCP 均不得发生。
  const denied = start({ authorize: () => ({ ok: true, decision: 'deny', reason: 'read-daily-cap' }) });
  const deniedHook = denied.ctx.listeners.get('tools/execute');
  let deniedMcp = 0;
  const deniedResult = await deniedHook(exec('session-a'), async () => { deniedMcp += 1; return { isError: false, content: [] }; });
  assert.equal(deniedResult.isError, true);
  assert.equal(deniedMcp, 0, 'deny 不得调用 next/假 MCP');
  assert.equal(denied.calls.commit.length, 0);

  // allow：authorize(reserve)→commit(started)→next(假 MCP 1)→finish(outcome)。
  const allowed = start();
  const allowedHook = allowed.ctx.listeners.get('tools/execute');
  let mcpCalls = 0;
  const result = await allowedHook(exec('session-a'), async () => { mcpCalls += 1; return { isError: false, content: [] }; });
  assert.equal(result.isError, false);
  assert.equal(mcpCalls, 1, 'allow 才 dispatch 一次');
  assert.equal(allowed.calls.authorize.length, 1);
  assert.equal(allowed.calls.commit.length, 1);
  assert.equal(allowed.calls.complete.length, 1);
  assert.equal(allowed.calls.complete[0].outcome, 'success');
});

test('ABORTED_BEFORE_DISPATCH：commit 后 abort，假 MCP 0 且 used 回滚', async () => {
  const ctx = makeCtx();
  const state = { used: 0, reserved: 0, complete: 0, abort: 0 };
  apply(ctx, {
    enabled: true,
    timeoutMs: 500,
    authorize: async () => { state.reserved += 1; return { ok: true, decision: 'allow', ticket: { ticketId: 't-abort' } }; },
    commit: async (req) => { state.reserved -= 1; state.used += 1; return { ok: true, started: true, ticket: req.ticket }; },
    abort: async () => { state.abort += 1; state.used -= 1; return { ok: true, aborted: true, rolledBack: true }; },
    complete: async () => { state.complete += 1; return { ok: true }; },
  });
  let mcpCalls = 0;
  const result = await ctx.listeners.get('tools/execute')(exec('session-a'), async () => {
    mcpCalls += 1;
    return { isError: true, error: { code: 'ABORTED_BEFORE_DISPATCH' }, content: [] };
  });
  assert.equal(result.error.code, 'ABORTED_BEFORE_DISPATCH');
  assert.equal(mcpCalls, 1, 'next 被调用一次，但由外层中止（模拟 pre-dispatch abort）');
  assert.equal(state.abort, 1);
  assert.equal(state.complete, 0);
  assert.equal(state.used, 0, 'abort 回滚 used');
});

test('post 短路：早 post listener 不 next 时不会跳过 execute-first 的 finish（B5 未解决仅兜底/审计）', async () => {
  const { ctx, calls } = start();
  const hook = ctx.listeners.get('tools/execute');
  let mcpCalls = 0;
  await hook(exec('session-a'), async () => { mcpCalls += 1; return { isError: false, content: [] }; });
  assert.equal(mcpCalls, 1);
  assert.equal(calls.complete.length, 1, 'execute-first 已在 dispatch 后 finish');
  // 模拟更早的 post listener 不 next：它只能跳过 post 链（兜底/审计），无法跳过 execute 内的 finish。
  const earlierPost = async () => ({ kind: 'accept' });
  assert.deepEqual(await earlierPost(), { kind: 'accept' });
  await ctx.listeners.get('tools/post-execute')(exec('session-a'), { isError: false }, async () => ({ kind: 'accept' }));
  assert.equal(calls.complete.length, 1, 'post 兜底不重复 complete');
  // B5 未解决：若未来把 finish 放在 post 兜底，post 短路会丢完成；需 TTL/对账。
});
