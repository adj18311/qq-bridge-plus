/**
 * xhh-quota-guard：路线 B 的 DSH profile 插件（**仓库副本未安装；本机 profile 已配置旧副本，未验证**）。
 *
 * 作用（B4 execute-first）：作为 `tools/execute` 的唯一权威异步门，对 `mcp__xiaoheihe__*`
 * 先 authorize(reserve) → commit(started) 计数 → dispatch；已知 pre-dispatch 中止时 abort 回滚；
 * 正常/异常结果 finish。拒绝/超时/异常一律返回合法 isError 结果且不 dispatch。
 *
 * task-108 fail-closed 加固（关键）：插件失效（配置非法 / enabled!==true / client 构造失败 /
 * 初始化异常）时**不再零注册**。apply 一开始就注册 fallback `tools/execute`：
 *  · 非小黑盒工具 → next()（不干预）；
 *  · 任何 `mcp__xiaoheihe__*`（含只读/写/登录/未知）→ 返回 isError 拒绝结果且**绝不 next**。
 * 插件失效时无法向授权服务确认读取额度 / accessPaused / 登录失效暂停，因此连只读也不能放行；
 * 必须整命名空间 fail-closed。真正的只读模式（管理员 readOnly）走 active 路径，读取规则不变。
 * 配置合法且 enabled===true 时才切换到 active execute-first 流程；active 行为与加固前一致。
 * apply 绝不因配置错误抛错（否则 loader 可能卸载钩子，反而回到“无门禁”）。
 *
 * 非目标：不注册任何工具、不发 QQ、不读 config/state、不实现额度逻辑（controller 在桥接侧）；
 * 本文件不含自动安装逻辑。仓库副本未被正式 profile 引用；但本机 desktop profile 已引用
 * C:\Users\user\.dsh\plugins\xhh-quota-guard\index.mjs 的旧安装副本（305 行，无 fallback），
 * 下一次 reload/restart 会加载旧代码。替换/验证旧副本不在本任务范围，需另行批准。
 *
 * **明确未覆盖（不得声称）**：
 *  · 插件文件不存在 / DSH loader 拒绝激活 / profile 未配置本插件时，插件内无法拦截——
 *    该情形需要 profile/XhhMCP 侧约束（本任务未实施，仅文档说明）；
 *  · 本插件只约束 DSH 内经 tools/execute 的工具调用，**不声称封堵本机其他客户端**直接访问
 *    XhhMCP/平台（它们不经过 DSH）。
 *
 * 契约取证（安装版 DSH 0.2.1-rc.2，app.asar 内源码）：
 *  · tools/execute：`ctx.on("tools/execute", async (exec, next) => ToolExecutionResult)`；
 *    around-dispatch waterfall，可在 dispatch 前 await；不调用 next 即阻断 dispatch。
 *    （dsh-tools/lib/index.js:3427；api-catalog:4467-4474）
 *  · pre-execute 仍是可被更早 listener 短路的 waterfall（:3321），因此 B4 不再依赖它做授权。
 *  · post-execute：`ctx.on("tools/post-execute", async (exec, result, next) => decision)`；
 *    默认 `{kind:"accept"}`；本插件只做兜底 finish。（:3598-3620）
 *  · guard：`ctx.tools.guard(fn)` 同步、单调、不能 force-allow；只用于本地 fail-closed 预检。
 *    （:3008-3032）
 *  · exec 字段：name/arguments/agent/signal/callId/rootCallId/parent/token（:3227-3252）。
 *  · 已知限制（execute-first 残余）：本插件 commit 后调用 next，更晚的 execute listener 仍可 veto
 *    且不告知本插件 → 可能“未执行但已计数”；更早 listener 可跳过本插件（安全方向）。
 *    pre/post 短路、注册顺序未承诺；详见 README「已知限制」。
 */

import { randomUUID } from 'node:crypto';
import { extractXhhPostImageUrls } from './post-image-urls.mjs';
import { downloadXhhImages } from './image-content.mjs';
import { resolveXhhImageAdmission } from './image-admission.mjs';

import {
  isXiaoheiheTool,
  normalizeToolName,
  isWriteTool,
  classifyFallbackTool,
  resolveAgentKey,
  mapAuthorizeResponse,
  mapCommitResponse,
  mapAbortResponse,
  mapCompleteResponse,
  isPreDispatchAbort,
  makeExecuteDeniedResult,
  denyForAuthorizeFailure,
  outcomeForExec,
} from './decision.mjs';

export const name = 'xhh-quota-guard';
// Cordis 服务注入：本插件读取 ctx.tools.guard 做同步预检；未声明会在真实 loader 中
// 抛 “cannot get property tools without inject” 并导致插件不激活（安装时实际踩到）。
export const inject = ['tools'];

const DEFAULT_TIMEOUT_MS = 800;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 1000;

const FALLBACK_MODE_WARNING =
  'xhh-quota-guard: 未取得有效授权配置，已进入 fail-closed 模式：所有小黑盒工具（含只读）将在 dispatch 前被拒绝';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertKeyList(value, label) {
  if (value === undefined || value === null) return;
  const list = value instanceof Set ? [...value] : value;
  if (!Array.isArray(list)) throw new TypeError(`xhh-quota-guard: ${label} 必须是数组或 Set`);
  for (const item of list) {
    if (typeof item !== 'string' || item === '') throw new TypeError(`xhh-quota-guard: ${label} 只能包含非空字符串`);
  }
}

function createHttpClient(bridgeUrl, timeoutMs, consoleToken) {
  const base = bridgeUrl.replace(/\/+$/, '');
  const endpoints = {
    authorize: base.endsWith('/authorize') || base.endsWith('/complete') ? base.replace(/\/[^/]+$/, '') : base,
  };
  async function post(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': consoleToken },
      redirect: 'error',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 不在这里 throw：把 status 交给 mapAuthorizeResponse 统一 fail-closed 映射
    // （400/401/500/非法 JSON 一律 deny，绝不因解析异常被误当成 allow）。
    let payload = null;
    try {
      payload = await response.json();
      if (!isPlainObject(payload)) payload = null;
    } catch {
      payload = null;
    }
    return { status: response.status, body: payload };
  }
  return {
    authorize: (body) => post(`${endpoints.authorize}/authorize`, body),
    // B3：commit/abort 业务拒绝是 200 {ok:false,reason}；由 decision 层按 body.ok 判定。
    commit: (body) => post(`${endpoints.authorize}/commit`, body),
    abort: (body) => post(`${endpoints.authorize}/abort`, body),
    complete: (body) => post(`${endpoints.authorize}/complete`, body),
  };
}

/**
 * 规范化配置；只有 `enabled === true` 才继续校验并返回 active 所需依赖。
 * 非法时抛 TypeError（由 applyWithDeps 捕获 → 保持 fallback，绝不外抛）。
 * @param {object} config
 * @param {(bridgeUrl: string, timeoutMs: number, consoleToken: string) => object} [createClient] 测试接缝
 */
function normalizeConfig(config, createClient = createHttpClient) {
  const source = isPlainObject(config) ? config : {};
  if (source.enabled !== true) return { enabled: false };

  const timeoutMs = source.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : source.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`xhh-quota-guard: timeoutMs 必须是 ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS} 的整数`);
  }
  if (source.agentKeyResolver !== undefined && typeof source.agentKeyResolver !== 'function') {
    throw new TypeError('xhh-quota-guard: agentKeyResolver 必须是函数');
  }
  assertKeyList(source.backgroundSessionKeys, 'backgroundSessionKeys');
  assertKeyList(source.userExemptAgents, 'userExemptAgents');

  let client;
  if (typeof source.authorize === 'function') {
    if (typeof source.complete !== 'function' || typeof source.commit !== 'function' || typeof source.abort !== 'function') {
      throw new TypeError('xhh-quota-guard: 注入 authorize 时必须同时注入 commit/abort/complete（execute-first）');
    }
    client = { authorize: source.authorize, commit: source.commit, abort: source.abort, complete: source.complete };
  } else if (typeof source.bridgeUrl === 'string' && source.bridgeUrl.trim() !== '') {
    const url = new URL(source.bridgeUrl.trim());
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) {
      throw new TypeError('xhh-quota-guard: bridgeUrl 必须是本机 127.0.0.1 HTTP 地址');
    }
    if (typeof source.consoleToken !== 'string' || !source.consoleToken.trim() || /[\r\n]/.test(source.consoleToken)) {
      throw new TypeError('xhh-quota-guard: HTTP 模式需要有效 consoleToken');
    }
    // client 构造失败（如注入的 createClient 抛错）也必须由 applyWithDeps 捕获 → fallback。
    client = createClient(url.href, timeoutMs, source.consoleToken);
  } else {
    throw new TypeError('xhh-quota-guard: 需要注入 authorize/complete 或提供 bridgeUrl');
  }

  return {
    enabled: true,
    client,
    timeoutMs,
    agentKeyResolver: source.agentKeyResolver,
    backgroundSessionKeys: source.backgroundSessionKeys,
    userExemptAgents: source.userExemptAgents,
  };
}

function withDeadline(promise, timeoutMs, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`xhh-quota-guard: ${label} 超时（${timeoutMs}ms）`);
      error.name = 'TimeoutError';
      error.code = 'ETIMEDOUT';
      reject(error);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** 初始化失败归类（只用于固定日志，不记录异常原文/配置值）。 */
function initFailureReason(error) {
  return error instanceof TypeError ? 'invalid-config' : 'client-init-failed';
}

/**
 * active 模式（配置合法且 enabled===true）的 execute-first 处理器。
 * 行为与 task-44/task-76 一致：authorize(reserve) → commit(started) → next → finish/abort。
 */
function createActiveExecuteHandler(normalized, tickets, warn, deps = {}) {
  const { client, timeoutMs, agentKeyResolver } = normalized;

  /**
   * 在 tools/post-execute 阶段把图片内容块追加到最终 content。
   *
   * 为什么必须在这里：`tools/execute` 返回的结果会被 DSH 的 normalizeDispatchResult 用冻结的
   * `value` 重新 render（dsh-tools/lib/index.js 的 normalizeDispatchResult / createSuccessResult），
   * around-hook 追加到 content 的内容会被**静默丢弃**；只有 post-execute 的
   * `{kind:'accept', content}` 会被 markCanonical 保留。
   *
   * 边界：只在「本插件登记过 + 真执行成功 + 下游 accept 且没有自带 content/value」时追加；
   * block、value、下游已给 content、非详情工具、失败结果一律原样返回。
   */
  async function decoratePostDecision(exec, result, decision, hostCtx = {}) {
    try {
      if (decision?.kind !== 'accept') return decision;
      if (Object.hasOwn(decision, 'value')) return decision;
      if (Object.hasOwn(decision, 'content')) {
        if (normalizeToolName(exec?.name) === 'get_post_detail') {
          warn('xhh-quota-guard: post-execute 的 content 已被下游插件改写，跳过图片附件');
        }
        return decision;
      }
      if (normalizeToolName(exec?.name) !== 'get_post_detail') return decision;
      // 只处理**本插件授权过**的执行（含用户豁免：豁免分支也会登记 exempt 票据）。
      if (!tickets.has(exec)) return decision;
      if (!isPlainObject(result) || result.isError === true) return decision;
      if (!Array.isArray(result.content)) return decision;
      if (outcomeForExec(exec, result) !== 'success') return decision;
      const { urls, notes = [] } = extractXhhPostImageUrls(result);
      if (!urls.length) return decision;

      const downloaded = await downloadXhhImages(urls, { fetchBuffer: deps.fetchBuffer, signal: exec?.signal });
      const extra = [...notes, ...downloaded.notes];
      const imageBlocks = [];

      if (downloaded.images.length > 0) {
        let admission;
        try {
          admission = await resolveXhhImageAdmission(hostCtx.ctx ?? {}, exec);
        } catch {
          // 准入本身抛错（服务异常/ctx.get 抛）：保留原文、给不泄敏的说明，不得静默。
          admission = { ok: false, reason: '无法核实当前模型能力' };
        }
        if (admission.ok !== true) {
          for (const image of downloaded.images) extra.push(`[图片：未附上（${admission.reason}），地址：${image.url}]`);
        } else {
          try {
            const inputs = downloaded.images.map((image) => ({ data: image.buffer, mediaType: image.mimeType }));
            const refs = await admission.attachments.saveImages(inputs);
            const usable = Array.isArray(refs)
              && refs.length === downloaded.images.length
              && refs.every((ref) => ref !== null && typeof ref === 'object');
            if (!usable) {
              for (const image of downloaded.images) extra.push(`[图片：附件存储返回异常，未附上，地址：${image.url}]`);
            } else {
              for (let i = 0; i < refs.length; i++) {
                imageBlocks.push({ type: 'image', attachment: refs[i] });
                extra.push(`[图片：已附上，可用 qq_send_image 发送：${downloaded.images[i].url}]`);
              }
            }
          } catch {
            for (const image of downloaded.images) extra.push(`[图片：附件存储失败，未附上，地址：${image.url}]`);
          }
        }
      }

      const content = [
        ...result.content,
        ...(extra.length ? [{ type: 'text', text: extra.join(String.fromCharCode(10)) }] : []),
        ...imageBlocks,
      ];
      return { ...decision, content };
    } catch {
      warn('xhh-quota-guard: 帖子图片处理失败，保留原始工具结果');
      return decision;
    }
  }

  async function finishTicket(ticket, outcome, agentKey) {
    // B4-polish：complete 透传 agentKey（B3 route/api 已支持绑定校验；缺失仍兼容旧行为）。
    const request = { ticket, outcome, now: Date.now() };
    if (typeof agentKey === 'string' && agentKey !== '') request.agentKey = agentKey;
    try {
      const completion = await withDeadline(client.complete(request), timeoutMs, 'complete');
      const mapped = mapCompleteResponse(completion);
      if (!mapped.ok) throw new Error(mapped.reason);
    } catch {
      // 回报失败不得破坏工具结果；不记录异常原文（可能含凭据/ticket/请求内容）。
      warn('xhh-quota-guard: complete 失败，请检查授权服务状态');
    }
  }

  async function abortTicket(ticket, agentKey) {
    try {
      const result = await withDeadline(client.abort({ ticket, agentKey, now: Date.now() }), timeoutMs, 'abort');
      const mapped = mapAbortResponse(result);
      if (!mapped.ok) warn('xhh-quota-guard: abort 失败，请检查授权服务状态');
    } catch {
      warn('xhh-quota-guard: abort 失败，请检查授权服务状态');
    }
  }

  async function execute(exec, next) {
    const toolName = exec?.name;
    if (!isXiaoheiheTool(toolName)) return next();

    const agentKey = resolveAgentKey(exec, agentKeyResolver);
    if (agentKey === null) return makeExecuteDeniedResult('missing-agent-key');

    // F-A：写操作需要授权层内部 operationId；真实小黑盒工具 schema 不含该参数。
    // 只在发给 authorize/commit 的副本里注入，绝不修改 exec.arguments。
    const originalArgs = isPlainObject(exec.arguments) ? exec.arguments : {};
    const authorizeArgs = { ...originalArgs };
    let internalOperationId = null;
    if (isWriteTool(toolName)) {
      const existing = typeof originalArgs.operationId === 'string' && originalArgs.operationId !== '' ? originalArgs.operationId : null;
      internalOperationId = existing ?? randomUUID();
      authorizeArgs.operationId = internalOperationId;
    }

    let authorized;
    try {
      authorized = await withDeadline(
        client.authorize({
          agentKey,
          tool: toolName,
          args: authorizeArgs,
          now: Date.now(),
        }),
        timeoutMs,
        'authorize',
      );
    } catch (error) {
      return makeExecuteDeniedResult(denyForAuthorizeFailure(error).reason);
    }
    const mapped = mapAuthorizeResponse(authorized);
    if (mapped.kind !== 'allow') return makeExecuteDeniedResult(mapped.reason, mapped);
    // 用户例外：不计数、不 commit/complete，直接放行。
    // 注意：**无 ticket 的 allow 不是用户例外**——必须 fail-closed，否则会未 commit 即 dispatch。
    const exemptTicket = isPlainObject(mapped.ticket) && mapped.ticket.kind === 'exempt';
    if (mapped.exemption === 'user' || exemptTicket) {
      // 用户例外：不计数、不 commit/complete；仍登记一次，让 post-execute 知道这次是本插件放行的。
      tickets.set(exec, { ticket: null, agentKey, started: true, finished: false, exempt: true });
      return next();
    }

    const reserved = mapped.ticket;
    if (!isPlainObject(reserved) || typeof reserved.ticketId !== 'string' || reserved.ticketId === '') {
      return makeExecuteDeniedResult('missing-ticket');
    }
    tickets.set(exec, { ticket: reserved, agentKey, started: false, finished: false });

    // commit（started）才计数；失败不得 dispatch。
    let committed;
    try {
      committed = await withDeadline(client.commit({
        ticket: reserved,
        agentKey,
        now: Date.now(),
        ...(internalOperationId === null ? {} : { args: { operationId: internalOperationId } }),
      }), timeoutMs, 'commit');
    } catch {
      tickets.delete(exec);
      return makeExecuteDeniedResult('commit-failed');
    }
    const commitMapped = mapCommitResponse(committed);
    if (!commitMapped.ok) {
      // commit 失败不得 dispatch；删除票据登记，post-execute 也不得回报。
      tickets.delete(exec);
      return makeExecuteDeniedResult(commitMapped.reason);
    }
    const startedTicket = commitMapped.ticket ?? reserved;
    tickets.set(exec, { ticket: startedTicket, agentKey, started: true, finished: false });

    let result;
    try {
      result = await next();
    } catch (error) {
      const code = error?.code;
      if (code === 'ABORTED_BEFORE_DISPATCH' || code === 'UNKNOWN_TOOL') await abortTicket(startedTicket, agentKey);
      else await finishTicket(startedTicket, 'failure', agentKey);
      tickets.set(exec, { ticket: startedTicket, agentKey, started: true, finished: true });
      return makeExecuteDeniedResult('dispatch-error');
    }

    if (isPreDispatchAbort(result)) {
      await abortTicket(startedTicket, agentKey);
      tickets.set(exec, { ticket: startedTicket, agentKey, started: true, finished: true });
      return result;
    }

    await finishTicket(startedTicket, outcomeForExec(exec, result), agentKey);
    tickets.set(exec, { ticket: startedTicket, agentKey, started: true, finished: true });
    // 注意：execute 阶段**不得**改写 content —— 宿主归一化会用冻结的 value 重渲染，改写会被丢弃。
    return result;
  }

  return { execute, finishTicket, decoratePostDecision };
}

/**
 * 注册插件钩子。**永远先注册 fallback execute**，再尝试初始化；任何配置/初始化异常都只降级为
 * fail-closed 模式，绝不从 apply 抛出（否则 loader 可能卸载钩子，回到“无门禁”）。
 *
 * @param {object} ctx DSH 插件上下文（需要 ctx.on / ctx.logger；可选 ctx.tools.guard）
 * @param {object} [config] README 中列出的配置；默认未启用
 */
export function apply(ctx, config = {}) {
  return applyWithDeps(ctx, config, {});
}

/**
 * 测试接缝：允许注入 createClient / normalizeConfig 以离线模拟“client 构造失败 / 初始化异常”。
 * 生产路径 `apply()` 使用上面的真实依赖。
 * @param {object} ctx
 * @param {object} [config]
 * @param {{ createClient?: Function, normalizeConfig?: Function }} [deps]
 */
export function applyWithDeps(ctx, config = {}, deps = {}) {
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(message);
    } catch {
      // 日志失败不得影响门禁。
    }
  };
  /** fallback/active 状态机：初始必须是 fallback（初始化完成前不允许任何写工具漏过）。 */
  const runtime = {
    mode: 'fallback',
    fallbackReason: 'initializing',
    normalized: null,
    activeExecute: null,
    finishTicket: null,
    decoratePostDecision: null,
  };
  /** exec -> {ticket, started, finished}；post-execute 只做兜底，不重复 complete。 */
  const tickets = new WeakMap();

  const createClient = typeof deps.createClient === 'function' ? deps.createClient : createHttpClient;
  const normalize = typeof deps.normalizeConfig === 'function'
    ? deps.normalizeConfig
    : (cfg) => normalizeConfig(cfg, createClient);

  function fallbackExecute(exec, next) {
    const decision = classifyFallbackTool(exec?.name);
    // 非小黑盒：放行。任何小黑盒工具（含只读）都因无法授权而拒绝：既避免写入，
    // 也避免绕过读取额度 / accessPaused / 登录失效暂停 / 来源计数。
    if (decision.kind === 'passthrough') return next();
    return makeExecuteDeniedResult(decision.reason);
  }

  function guardExec(exec) {
    if (runtime.mode === 'fallback') {
      const decision = classifyFallbackTool(exec?.name);
      return decision.kind === 'deny' ? `xhh-quota-guard: ${decision.reason}` : undefined;
    }
    if (!isXiaoheiheTool(exec?.name)) return undefined;
    if (runtime.normalized !== null && resolveAgentKey(exec, runtime.normalized.agentKeyResolver) === null) {
      return 'xhh-quota-guard: missing-agent-key';
    }
    return undefined;
  }

  // ── 1) 先注册 execute（fallback 起点）：配置解析/初始化之前就具备 dispatch 前拦截能力
  ctx.on('tools/execute', async (exec, next) => {
    if (runtime.mode === 'active' && typeof runtime.activeExecute === 'function') {
      return runtime.activeExecute(exec, next);
    }
    return fallbackExecute(exec, next);
  });

  // ── 2) tools.guard：同步 fail-closed 预检（fallback 拒绝所有小黑盒；active 只查 agentKey）。
  // 注册失败不致命：execute 门仍为权威，且绝不因此放行。
  if (typeof ctx.tools?.guard === 'function') {
    try {
      ctx.tools.guard((exec) => guardExec(exec));
    } catch {
      warn('xhh-quota-guard: guard 注册失败，execute 门仍为唯一权威（fail-closed 不回退放行）');
    }
  }

  // ── 3) tools/post-execute：active 兜底 finish；fallback 下无票据，直接 next
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const entry = tickets.get(exec);
    const decision = await next();
    if (entry === undefined) return decision;
    // 兜底 finish：正常路径 execute 里已经 finish 过，这里只处理异常路径，不重复 complete。
    if (entry.finished === false) {
      tickets.set(exec, { ...entry, finished: true });
      if (runtime.mode === 'active' && entry.exempt !== true && typeof runtime.finishTicket === 'function') {
        await runtime.finishTicket(entry.ticket, outcomeForExec(exec, result), entry.agentKey);
      }
    }
    // 图片只能在 post-execute 阶段追加（execute 阶段的改写会被宿主归一化丢弃）。
    if (runtime.mode === 'active' && typeof runtime.decoratePostDecision === 'function') {
      // 传整个 ctx：图片准入要用 ctx.get('attachments') 与 ctx.get('llm') 做与宿主一致的判定。
      return runtime.decoratePostDecision(exec, result, decision, { ctx });
    }
    return decision;
  });

  // ── 4) 尝试进入 active；任何失败都保持 fallback，且 apply 不抛错
  let normalized;
  try {
    normalized = normalize(config);
  } catch (error) {
    runtime.fallbackReason = initFailureReason(error);
    warn(`${FALLBACK_MODE_WARNING} [原因: ${runtime.fallbackReason}]`);
    return;
  }
  if (normalized === null || typeof normalized !== 'object' || normalized.enabled !== true) {
    runtime.fallbackReason = 'disabled';
    warn(`${FALLBACK_MODE_WARNING} [原因: disabled]`);
    return;
  }

  try {
    const handler = createActiveExecuteHandler(normalized, tickets, warn, deps);
    runtime.normalized = normalized;
    runtime.finishTicket = handler.finishTicket;
    runtime.decoratePostDecision = handler.decoratePostDecision;
    runtime.activeExecute = handler.execute;
    runtime.mode = 'active';
    runtime.fallbackReason = null;
  } catch {
    runtime.normalized = null;
    runtime.activeExecute = null;
    runtime.finishTicket = null;
    runtime.decoratePostDecision = null;
    runtime.mode = 'fallback';
    runtime.fallbackReason = 'init-failed';
    warn(`${FALLBACK_MODE_WARNING} [原因: init-failed]`);
  }
}
