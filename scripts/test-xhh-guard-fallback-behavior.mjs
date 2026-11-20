// scripts/test-xhh-guard-fallback-behavior.mjs
//
// task-108 terminal-review follow-up: prove the pre-fix fallback defect with a *loadable
// legacy implementation* and real execute-hook behavior, not a missing-export SyntaxError.
//
// RED command (legacy target asserts the fixed contract; should fail because legacy next()s):
//   XHH_GUARD_BEHAVIOR_TARGET=legacy node scripts/test-xhh-guard-fallback-behavior.mjs
// GREEN command (current implementation):
//   node scripts/test-xhh-guard-fallback-behavior.mjs
//
// Both runs are offline: fake ctx/fake execute hook, no HTTP, no DSH, no bridge, no platform.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply as applyCurrent } from '../plugins/xhh-quota-guard/index.mjs';
import {
  applyLegacyFallback,
  classifyLegacyFallbackTool,
  LEGACY_FALLBACK_READ_TOOL_NAMES,
  LEGACY_PROVENANCE,
} from './fixtures/legacy-xhh-guard-fallback.mjs';

const PREFIX = 'mcp__xiaoheihe__';
const FULL = (short) => `${PREFIX}${short}`;
const READ_TOOLS = ['get_home_content', 'get_post_detail', 'search_content', 'check_login_status', 'get_user_profile'];
const TARGET = process.env.XHH_GUARD_BEHAVIOR_TARGET === 'legacy' ? 'legacy' : 'fixed';

function makeCtx() {
  const listeners = new Map();
  const warnings = [];
  const guards = [];
  const ctx = {
    listeners,
    warnings,
    guards,
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
      return () => {};
    },
    logger: { warn(message) { warnings.push(String(message)); }, info() {} },
    tools: { guard(fn) { guards.push(fn); return () => {}; } },
  };
  return ctx;
}

function executeHook(ctx) {
  const listeners = ctx.listeners.get('tools/execute') ?? [];
  assert.equal(listeners.length, 1, '必须恰好一个 execute 监听');
  return listeners[0];
}

function makeNext() {
  const result = { isError: false, content: [{ type: 'text', text: 'downstream-result' }] };
  const calls = [];
  const next = async () => { calls.push(true); return result; };
  next.calls = calls;
  return next;
}

async function runGuard(kind, shortName) {
  const ctx = makeCtx();
  if (kind === 'legacy') applyLegacyFallback(ctx);
  else applyCurrent(ctx, { enabled: false });

  const next = makeNext();
  const result = await executeHook(ctx)({
    name: FULL(shortName),
    arguments: { query: 'offline' },
    agent: { id: 'session-offline', session: { id: 'session-offline' } },
    signal: { aborted: false },
  }, next);
  return { ctx, next, result };
}

test('legacy fixture 可加载，且其冻结探针保留旧只读白名单（行为证据前提）', () => {
  assert.equal(LEGACY_PROVENANCE.kind, 'test-only frozen historical behavior reference');
  assert.deepEqual([...LEGACY_FALLBACK_READ_TOOL_NAMES], READ_TOOLS);
  assert.deepEqual(classifyLegacyFallbackTool(FULL('search_content')), { kind: 'read', reason: null });
  assert.deepEqual(classifyLegacyFallbackTool(FULL('publish_content')), {
    kind: 'deny',
    reason: 'fail-closed-no-authorization',
  });
  assert.deepEqual(classifyLegacyFallbackTool('mcp__other__search_content'), { kind: 'passthrough', reason: null });
  // This test passing proves the legacy module is loadable; no missing export / SyntaxError.
});

test(`[${TARGET}] fallback 下只读工具必须在 dispatch 前 deny（next 零调用）`, async () => {
  for (const short of READ_TOOLS) {
    const { next, result } = await runGuard(TARGET, short);
    assert.equal(
      next.calls.length,
      0,
      `${TARGET}/${short}: 旧实现会 next() 放行；当前实现必须拒绝（实际 next=${next.calls.length}）`,
    );
    assert.equal(result?.isError, true, `${TARGET}/${short}: 必须是 isError 拒绝结果`);
    assert.match(result?.content?.[0]?.text ?? '', /fail-closed-no-authorization/, `${TARGET}/${short}: 拒绝原因`);
  }
});

test(`[${TARGET}] fallback 下写工具必须 deny（next 零调用）`, async () => {
  const { next, result } = await runGuard(TARGET, 'publish_content');
  assert.equal(next.calls.length, 0, `${TARGET}: 写工具必须 dispatch 前拒绝`);
  assert.equal(result?.isError, true, `${TARGET}: 写工具必须是 isError 拒绝结果`);
  assert.match(result?.content?.[0]?.text ?? '', /fail-closed-no-authorization/, `${TARGET}: 写工具拒绝原因`);
});

test('legacy 实现确实错误放行只读工具（缺陷复现，固定证据；与当前目标无关）', async () => {
  const { next } = await runGuard('legacy', 'search_content');
  console.log(`legacy/search_content nextCalls=${next.calls.length}（旧实现错误放行，缺陷复现）`);
  assert.equal(next.calls.length, 1, '旧实现必须 next() 只读工具，才能证明原缺陷真实存在');
  // 写工具在旧实现中仍被 deny，用于证明缺陷范围是“只读错误放行”，不是全放行。
  const write = await runGuard('legacy', 'publish_content');
  assert.equal(write.next.calls.length, 0);
  assert.equal(write.result?.isError, true);
});

test('非小黑盒工具在 fallback 下直通（新旧语义一致）', async () => {
  const ctx = makeCtx();
  if (TARGET === 'legacy') applyLegacyFallback(ctx);
  else applyCurrent(ctx, { enabled: false });
  const next = makeNext();
  await executeHook(ctx)({ name: 'ops_bash', arguments: {} }, next);
  assert.equal(next.calls.length, 1, `${TARGET}: 非小黑盒必须直通`);
});
