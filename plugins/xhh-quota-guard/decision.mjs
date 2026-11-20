/**
 * xhh-quota-guard：路线 B 授权门禁的**纯决策层**（可离线单测，无 I/O）。
 *
 * 只做数据到决策的纯转换：工具名归一、agentClass 分类、authorize 结果 → allow/deny、
 * 超时/异常 → deny、工具结果 → complete outcome、agentKey 解析。
 * 真正的 DSH 钩子注册 / HTTP / 计时器在 index.mjs。
 *
 * 契约依据（安装版 DSH 0.2.1-rc.2，app.asar 内源码取证）：
 *  · dsh-tools/lib/index.js:3321 pre-execute waterfall，默认 {kind:'allow'}；
 *  · dsh-tools/lib/index.js:3336-3350 deny/ask/cancel 的物化语义；
 *  · dsh-tools/lib/index.js:3227-3252 ToolExecution 字段（name/arguments/agent/signal/callId/rootCallId/parent）；
 *  · dsh-tools/lib/index.js:3598-3620 post-execute waterfall（accept/block/content/value）；
 *  · dsh-tool-jobs/lib/index.js:235 pre-execute listener `(exec, next) => next()`；
 *  · dsh-experimental-auto-review/lib/index.js:443-500 async listener + deny/cancel/ask 返回形状；
 *  · dsh-agent/lib/index.js:243 与 dsh-session/lib/types/index.js:421-426：agent.session.id 即会话身份。
 */

export const XHH_QUOTA_TOOL_PREFIX = 'mcp__xiaoheihe__';

/** 12 个小黑盒工具短名（与 src/core/xiaoheihe-authorize-api.mjs 保持单一来源；测试防漂移）。 */
export const XHH_QUOTA_GUARD_TOOL_NAMES = Object.freeze([
  'get_home_content',
  'get_post_detail',
  'search_content',
  'check_login_status',
  'get_user_profile',
  'publish_content',
  'publish_article',
  'publish_video',
  'post_comment',
  'reply_comment',
  'interactive_login',
  'get_login_qr_code',
]);

const TOOL_SET = new Set(XHH_QUOTA_GUARD_TOOL_NAMES);

/** F-A：需要授权层内部 operationId 的写工具（真实工具 schema 不含该参数）。 */
export const XHH_QUOTA_WRITE_TOOL_NAMES = Object.freeze([
  'publish_content',
  'publish_article',
  'publish_video',
  'post_comment',
  'reply_comment',
]);

const WRITE_TOOL_SET = new Set(XHH_QUOTA_WRITE_TOOL_NAMES);

/** 工具名（完整或短名）是否为写操作。 */
export function isWriteTool(toolName) {
  const short = normalizeToolName(toolName);
  return short !== null && WRITE_TOOL_SET.has(short);
}

/**
 * task-108 修正：插件失效（fallback）时**所有** `mcp__xiaoheihe__*` 工具一律 deny。
 *
 * 早期实现把 5 个“纯只读”工具直接 next，绕过授权服务；这会同时绕过：
 *   · 小黑盒读取日额度（read reserve/commit）；
 *   · accessPaused / 登录失效 / 验证码等全访问暂停；
 *   · 来源计数与审计。
 * 这些工具本身没有平台写副作用，但“能否读取”仍必须由授权服务决定；插件无法授权时
 * 没有安全依据放行，因此只能整命名空间 fail-closed。真正的只读模式（管理员开启
 * readOnly）在 active 路径下仍保留读取规则：读工具照常 authorize/commit，写工具被拒。
 *
 *  · `passthrough`：非小黑盒命名空间，交给下游，不干预；
 *  · `deny`：任何小黑盒工具（读/写/登录/未知）固定原因，调用方必须在 dispatch 前拒绝（绝不 next）。
 */
export function classifyFallbackTool(toolName) {
  if (typeof toolName !== 'string' || !toolName.startsWith(XHH_QUOTA_TOOL_PREFIX)) {
    return { kind: 'passthrough', reason: null };
  }
  return { kind: 'deny', reason: 'fail-closed-no-authorization' };
}

/** 是否属于需要门禁的小黑盒命名空间（只按前缀判断；未知短名由 normalize 判 null）。 */
export function isXiaoheiheTool(toolName) {
  return typeof toolName === 'string' && toolName.startsWith(XHH_QUOTA_TOOL_PREFIX);
}

/** 归一为短名；不是小黑盒工具或不在 12 名单内返回 null（fail-closed）。
 *  同时兼容已归一短名（便于纯决策层单测/日志），但 index 的拦截判定仍只按前缀。 */
export function normalizeToolName(toolName) {
  if (typeof toolName !== 'string') return null;
  if (!toolName.startsWith(XHH_QUOTA_TOOL_PREFIX)) {
    return TOOL_SET.has(toolName) ? toolName : null;
  }
  const short = toolName.slice(XHH_QUOTA_TOOL_PREFIX.length);
  return TOOL_SET.has(short) ? short : null;
}

function toSet(value) {
  if (value === undefined || value === null) return new Set();
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.filter((item) => typeof item === 'string' && item !== ''));
  return new Set();
}

/** 与 authorize API 相同口径的 agentClass 分类（仅用于本地日志/升级排查）。 */
export function classifyAgentKey(agentKey, { backgroundSessionKeys = [], userExemptAgents = [] } = {}) {
  if (typeof agentKey !== 'string' || agentKey === '') return 'unknown';
  if (toSet(backgroundSessionKeys).has(agentKey)) return 'background';
  if (toSet(userExemptAgents).has(agentKey)) return 'user';
  return 'unknown';
}

/**
 * authorize() 结果 → pre-execute 决策。
 * 只接受明确 `decision:'allow'|'deny'`；其余（null/缺字段/非对象/ok:false）一律 deny invalid-authorize-result。
 */
export function mapAuthorizeDecision(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return { kind: 'deny', reason: 'invalid-authorize-result' };
  }
  if (result.decision === 'allow' && result.ok !== false) {
    return {
      kind: 'allow',
      ticket: result.ticket,
      exemption: typeof result.exemption === 'string' ? result.exemption : null,
    };
  }
  if (result.decision === 'deny') {
    return {
      kind: 'deny', reason: typeof result.reason === 'string' && result.reason !== '' ? result.reason : 'denied',
      ...(typeof result.hint === 'string' && result.hint.trim() !== '' ? { hint: result.hint } : {}),
      ...(typeof result.retryAfterMs === 'number' && Number.isFinite(result.retryAfterMs) && result.retryAfterMs > 0 ? { retryAfterMs: result.retryAfterMs } : {}),
    };
  }
  return { kind: 'deny', reason: 'invalid-authorize-result' };
}

/**
 * HTTP 响应（`{status, body}`）→ pre-execute 决策（task-49，fail-closed）。
 *
 * 规则：**只有 `status === 200 && body.decision === 'allow'` 才 allow**；
 *  · 非 200（400/401/403/500…）一律 deny，reason=`http-<status>`（即使 body 伪装成 allow）；
 *  · 200 但 body 非法/缺 decision/ok:false 也 deny（invalid-authorize-result）；
 *  · 兼容注入 client 的「裸 body」契约（无 status 字段时退回 mapAuthorizeDecision 的严格判定）。
 */
export function mapAuthorizeResponse(response) {
  const isObject = response !== null && typeof response === 'object' && !Array.isArray(response);
  const hasStatus = isObject && Object.prototype.hasOwnProperty.call(response, 'status');
  if (hasStatus) {
    if (response.status !== 200) {
      return { kind: 'deny', reason: `http-${typeof response.status === 'number' ? response.status : 'unknown'}` };
    }
    if (response.body?.ok !== true) return { kind: 'deny', reason: 'invalid-authorize-result' };
    return mapAuthorizeDecision(response.body);
  }
  return mapAuthorizeDecision(response);
}

/** authorize 调用失败（异常/超时）→ deny；超时单独归类，便于 bridge 侧告警。 */
export function denyForAuthorizeFailure(error) {
  const name = error !== null && typeof error === 'object' ? error.name : undefined;
  const code = error !== null && typeof error === 'object' ? error.code : undefined;
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT' || code === 'ABORT_ERR') {
    return { kind: 'deny', reason: 'authorize-timeout' };
  }
  return { kind: 'deny', reason: 'authorize-failed' };
}


function fixedReason(value, fallback) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : fallback;
}

/**
 * commit 响应 → {ok, ticket?, reason?}。
 * B3 业务拒绝是 HTTP 200 `{ok:false, reason}`，必须按 body.ok 判断（不能只看 status）。
 * HTTP 形态 `{status, body}`；注入 client 可返回裸 body。
 */
export function mapCommitResponse(response) {
  const isObject = response !== null && typeof response === 'object' && !Array.isArray(response);
  const hasStatus = isObject && Object.prototype.hasOwnProperty.call(response, 'status');
  const body = hasStatus ? response.body : response;
  if (hasStatus && response.status !== 200) return { ok: false, reason: `commit-http-${typeof response.status === 'number' ? response.status : 'unknown'}` };
  if (!isObject || !isPlainObjectLike(body)) return { ok: false, reason: 'commit-failed' };
  if (body.ok !== true || body.started !== true) {
    return { ok: false, reason: fixedReason(body.reason, body.ok === false ? 'commit-rejected' : 'commit-failed') };
  }
  return { ok: true, ticket: body.ticket };
}

function isPlainObjectLike(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** abort 响应 → {ok, rolledBack, reason?}；同样按 body.ok 判断 200 业务拒绝。 */
export function mapAbortResponse(response) {
  const isObject = response !== null && typeof response === 'object' && !Array.isArray(response);
  const hasStatus = isObject && Object.prototype.hasOwnProperty.call(response, 'status');
  const body = hasStatus ? response.body : response;
  if (hasStatus && response.status !== 200) return { ok: false, reason: `abort-http-${typeof response.status === 'number' ? response.status : 'unknown'}` };
  if (!isObject || !isPlainObjectLike(body)) return { ok: false, reason: 'abort-failed' };
  if (body.ok !== true) return { ok: false, reason: `abort-${fixedReason(body.reason, 'failed')}` };
  return { ok: true, rolledBack: body.rolledBack === true };
}

/** finish/complete 响应 → {ok, reason?}；HTTP 200 的 body.ok=false 一律不当作成功。 */
export function mapCompleteResponse(response) {
  const isObject = response !== null && typeof response === 'object' && !Array.isArray(response);
  const hasStatus = isObject && Object.prototype.hasOwnProperty.call(response, 'status');
  const body = hasStatus ? response.body : response;
  if (hasStatus && response.status !== 200) return { ok: false, reason: `complete-http-${typeof response.status === 'number' ? response.status : 'unknown'}` };
  if (!isObject || !isPlainObjectLike(body) || body.ok !== true) return { ok: false, reason: 'complete-failed' };
  return { ok: true };
}

/** dispatch 前中止：可用已知错误码识别平台未被调用，从而 abort 回滚。 */
export function isPreDispatchAbort(result) {
  if (!isPlainObjectLike(result) || result.isError !== true) return false;
  const code = result.error?.code ?? result.code;
  return code === 'ABORTED_BEFORE_DISPATCH' || code === 'UNKNOWN_TOOL';
}

/** execute-first deny 结果：合法 ToolExecutionResult 形状（isError + 固定文案），不泄漏内部细节。 */
export function makeExecuteDeniedResult(reason, details = {}) {
  const safeReason = fixedReason(reason, 'denied');
  let message = `xhh-quota-guard: ${safeReason}`;
  if (typeof details?.hint === 'string' && details.hint.trim() !== '') message += `\n${details.hint}`;
  if (typeof details?.retryAfterMs === 'number' && Number.isFinite(details.retryAfterMs) && details.retryAfterMs > 0) {
    message += `\n请等待约 ${Math.ceil(details.retryAfterMs / 60000)} 分钟后重试。`;
  }
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    error: { code: 'XHH_GUARD_DENIED', message },
  };
}

/**
 * F-B：从 ToolExecutionResult 中提取文本内容（只读，不执行/不猜）。
 * 支持 content:[{type:'text',text}]、字符串 content、result.text。
 */
export function resultText(result) {
  if (result === null || typeof result !== 'object') return typeof result === 'string' ? result : '';
  const parts = [];
  if (typeof result.text === 'string') parts.push(result.text);
  if (typeof result.content === 'string') parts.push(result.content);
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (typeof item === 'string') parts.push(item);
      else if (item !== null && typeof item === 'object' && typeof item.text === 'string') parts.push(item.text);
    }
  }
  return parts.join('\n');
}

/**
 * F-B：已知的小黑盒业务失败标记（当前 PublishService 会返回普通文本且不设 IsError）。
 * 只认明确标记，不用“成功/失败”字眼模糊猜测；长期应由服务端设置 IsError。
 */
export function isKnownBusinessFailureText(text) {
  if (typeof text !== 'string' || text.trim() === '') return false;
  if (/(?:❌|发布失败|未能自动点击发布|未能自动发布)/.test(text)) return true;
  if (/建议[：:][^\n]*(?:发布|重试|手动)/.test(text)) return true;
  return false;
}

/** 已知的小黑盒客户端超时正文：不能推断平台写入是否发生。 */
function isExplicitTimeoutText(text) {
  return typeof text === 'string' && (/^\s*❌\s*[^\n]{0,80}失败\s*[:：]\s*Timeout\s+\d+ms\s+exceeded\b/i.test(text) || /^\s*❌\s*回复评论失败\s*[:：]\s*超时（步骤:\s*[a-z_]+，/.test(text));
}

/** 小黑盒回复工具在提交后无法核实结果时使用的固定前缀。 */
function isUnconfirmedReplyText(text) {
  return typeof text === 'string' && /^\s*⚠️\s*(?:已尝试点击发送|回复已点击提交)[^\n]*结果未知[^\n]*请勿自动重发/.test(text);
}

/** 工具结果三态分类：明确超时 → unknown；已知失败 → failure；其余 → success。 */
export function classifyToolResult(result) {
  if (result === undefined || result === null) return { outcome: 'failure', reason: 'empty-result' };
  if (isExplicitTimeoutText(resultText(result)) || isUnconfirmedReplyText(resultText(result))) return { outcome: 'unknown', reason: 'unconfirmed' };
  if (result.isError === true) return { outcome: 'failure', reason: 'is-error' };
  if (isKnownBusinessFailureText(resultText(result))) return { outcome: 'failure', reason: 'business-failure-marker' };
  return { outcome: 'success', reason: 'text-success' };
}

/** 工具结果 → complete outcome：已知业务失败标记→failure；取消/超时（结果未知）unknown；其余 success。 */
export function outcomeForExec(exec, result) {
  if (result === undefined || result === null) return 'failure';
  if (exec?.signal?.aborted === true || isExplicitTimeoutText(resultText(result)) || isUnconfirmedReplyText(resultText(result))) return 'unknown';
  if (result.isError === true) {
    if (exec?.signal?.aborted === true) return 'unknown';
    const code = result?.error?.code;
    if (code === 'TOOL_TIMEOUT' || code === 'TIMEOUT' || code === 'ABORT_ERR') return 'unknown';
    return 'failure';
  }
  return isKnownBusinessFailureText(resultText(result)) ? 'failure' : 'success';
}

/** 仅用于日志，不改变 DSH 工具结果或其他工具的发送判定。 */
export function xhhToolLogOutcome(tool, result) {
  if (!isXiaoheiheTool(tool)) return null;
  const outcome = outcomeForExec({}, result);
  const diagnosticSteps = new Set(['gate_wait', 'initialize', 'navigate', 'network_idle', 'render_wait', 'account_probe', 'target_resolve', 'open_composer', 'find_composer', 'edit_reply', 'baseline', 'recheck_composer', 'check_editor', 'submit', 'verify', 'save_cookies']);
  const text = resultText(result);
  const match = outcome !== 'success' && normalizeToolName(tool) === 'reply_comment' ? /步骤\s*:\s*([a-z_]+)(?=[，；）])/.exec(text) : null;
  const diagnosticStep = match && diagnosticSteps.has(match[1]) ? match[1] : null;
  return { ok: outcome === 'success', outcome, ...(diagnosticStep ? { diagnosticStep } : {}) };
}

/**
 * 解析本次调用的 agentKey：
 *  · 注入 resolver 优先（异常/空串 → null，绝不猜）；
 *  · 默认取 `exec.agent.session.id`（DSH 中 agent.session.id 即会话身份）；
 *  · 兼容 `exec.agent.id`，都没有则 null（调用方 fail-closed deny）。
 */
export function resolveAgentKey(exec, resolver) {
  if (typeof resolver === 'function') {
    try {
      const value = resolver(exec);
      return typeof value === 'string' && value !== '' ? value : null;
    } catch {
      return null;
    }
  }
  // B4 execute-first 契约：agentKey = exec.agent?.id ?? exec.agent?.session?.id
  const candidate = exec?.agent?.id ?? exec?.agent?.session?.id;
  return typeof candidate === 'string' && candidate !== '' ? candidate : null;
}
