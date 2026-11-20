// Frozen pre-fix reference for scripts/test-xhh-guard-fallback-behavior.mjs.
// Test-only; not production code, not imported by the plugin or any runtime path.
//
// Provenance: this is a minimal, loadable reconstruction of the fallback behavior that
// existed before the task-108 terminal-review correction. The pre-fix test run captured in
// %TEMP%\xhh-failclosed-tdd\green1.log (2026-10-26 14:47) contains these old test names:
//   - "decision：fallback 只读白名单冻结、只含纯读、与写工具无交集"
//   - "失效场景：只读白名单放行 next，且不产生任何授权请求"
//   - "失效场景：guard 同步拦截写/登录/未知，放行只读与非 xhh"
// The old source file itself was overwritten and is no longer in git history.
//
// Behavior contract of this frozen reference:
//   - non-xhh tools: passthrough;
//   - 5 pure read tools: {kind:'read'}, caller next()s them (the defect);
//   - write/login/unknown xhh tools: {kind:'deny'} at dispatch, never next();
//   - guard: allows read/passthrough, blocks deny.
// Do not "fix" this fixture: its only purpose is to prove the old defect is real.

export const LEGACY_FALLBACK_READ_TOOL_NAMES = Object.freeze([
  'get_home_content',
  'get_post_detail',
  'search_content',
  'check_login_status',
  'get_user_profile',
]);

export const LEGACY_PROVENANCE = Object.freeze({
  kind: 'test-only frozen historical behavior reference',
  snapshot: '%TEMP%\\xhh-failclosed-tdd\\green1.log',
  captured: '2026-10-26T14:47+08:00',
  note: 'Hand reconstruction of pre-fix fallback; not production code and not used at runtime.',
});

const PREFIX = 'mcp__xiaoheihe__';
const READ_SET = new Set(LEGACY_FALLBACK_READ_TOOL_NAMES);

export function classifyLegacyFallbackTool(toolName) {
  if (typeof toolName !== 'string' || !toolName.startsWith(PREFIX)) {
    return { kind: 'passthrough', reason: null };
  }
  const short = toolName.slice(PREFIX.length);
  if (READ_SET.has(short)) return { kind: 'read', reason: null };
  return { kind: 'deny', reason: 'fail-closed-no-authorization' };
}

function denied(reason) {
  return {
    isError: true,
    content: [{ type: 'text', text: `xhh-quota-guard: ${reason}` }],
  };
}

/**
 * Register the pre-fix fallback execute/guard hooks. This is deliberately the same
 * registration shape as the plugin, but with the old "read next()" behavior.
 */
export function applyLegacyFallback(ctx) {
  const execute = async (exec, next) => {
    const decision = classifyLegacyFallbackTool(exec?.name);
    if (decision.kind === 'passthrough' || decision.kind === 'read') return next();
    return denied(decision.reason);
  };
  ctx.on('tools/execute', execute);
  if (typeof ctx.tools?.guard === 'function') {
    ctx.tools.guard((exec) => {
      const decision = classifyLegacyFallbackTool(exec?.name);
      return decision.kind === 'deny' ? `xhh-quota-guard: ${decision.reason}` : undefined;
    });
  }
  return { execute };
}
