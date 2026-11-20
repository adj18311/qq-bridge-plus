/**
 * 路线 B：桥接侧授权 / 回执 **HTTP 路由纯处理器**（**未接线**）。
 *
 * 只做「请求校验 → 调注入的 authorizeApi → 映射 HTTP 响应」；不监听端口、不 import bridge、
 * 不读 config、不联网、无 I/O。真正注册到 HTTP server 由未来桥接接线负责。
 *
 * HTTP 契约：
 *  · 鉴权 header `x-console-token`（大小写不敏感）必须等于注入的 consoleToken；
 *    缺失/空 → 401 `{ok:false,error:'unauthorized'}`；不匹配 → 403 `{ok:false,error:'forbidden'}`；
 *    timing-safe：对两侧 sha256 后 timingSafeEqual，长度不同也不崩、不泄露长度/token。
 *  · 请求校验失败 → 400 + 固定错误码：
 *    invalid-body / invalid-agent / invalid-tool / invalid-args / invalid-clock /
 *    invalid-ticket / invalid-outcome。
 *  · authorize 成功映射：
 *      allow → 200 `{ok:true, decision:'allow', exemption, ticket?, counted?, used?, limit?, remaining?}`
 *      deny  → **200** `{ok:true, decision:'deny', reason, controllerReason?, exemption:null}`
 *              （策略拒绝是正常授权结果，不是传输错误；由调用方插件转成 pre-execute deny。）
 *  · commit/abort 映射：均沿用 token/body 校验；commit ok → 200 `{ok:true, started:true, ticket?,used?,limit?,remaining?}`，
 *    abort ok → 200 `{ok:true, aborted:true, already?, rolledBack?}`；业务拒绝 → 200 `{ok:false, reason}`；
 *    鉴权/校验失败按 401/403/400，内部异常 500（fail-closed，绝不返回 allow）。
 *  · complete 成功映射：200 透传 `{ok:true, completed?, already?, ignored?, exempt?, outcome?}`；
 *    `unknown-ticket` → 200 `{ok:false,error:'unknown-ticket'}`（幂等，不 500）。
 *  · 内部异常 / authorizeApi 返回非法结果 → **500** `{ok:false,error:'internal-error'}`
 *    （fail-closed：调用方插件对非 200 会 deny；本处理器绝不返回 allow）。
 *
 * agentKey 语义：来自 DSH pre-execute 的 `exec.agent.session.id`（task-44 取证）。
 * **agentClass 以 authorizeApi 结果为准**（task-49）：路由只把 agentKey 原样传下去，不再自行把
 * 「非后台 key」标成 user；审计里的 agentClass 取 authorizeApi 返回的 background/user/unknown
 * （旧/第三方 API 未返回时回退：后台 key → background，其余 → unknown，绝不猜 user）。
 * body 也必须显式携带 agentKey；缺失/空/非字符串 → 400 invalid-agent（不猜会话）。
 *
 * 审计：每次请求调用注入 audit（含鉴权/校验失败），字段固定白名单
 * `{type, at, agentClass, tool, decision, status, reason, exemption, outcome, error}`；
 * **不记录 token、args 原文、ticket 细节、Cookie/凭据**。audit 抛错不影响响应。
 *
 * 明确不做：不实现超时（由 HTTP client / 插件 timeoutMs 负责）；不重试；不落审计文件；
 * 不做跨进程状态；不决定额度（controller/authorizeApi 权威）。
 */

import crypto from 'node:crypto';

import { XHH_AUTHORIZE_TOOL_NAMES } from './xiaoheihe-authorize-api.mjs';

export const XHH_AUTHORIZE_ROUTE_STATUS = Object.freeze({
  OK: 200,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  BAD_REQUEST: 400,
  INTERNAL: 500,
});

const TOOL_PREFIX = 'mcp__xiaoheihe__';
const TOOL_SET = new Set(XHH_AUTHORIZE_TOOL_NAMES);
const OUTCOMES = new Set(['success', 'failure', 'unknown']);
const MAX_AGENT_KEY_LENGTH = 256;
const AUDIT_KEYS = new Set([
  'type', 'at', 'agentClass', 'tool', 'decision', 'status', 'reason', 'exemption', 'outcome', 'error', 'opId', 'readIndex', 'readStartedAt',
]);
const ALLOW_BODY_KEYS = ['counted', 'ticket', 'used', 'limit', 'remaining'];
// task-130：complete 回执可带 pause 事件字段（notify/writePaused/writeReason/consecutiveWriteFailures），
// 路由只白名单透传，不推断、不生成 recovered。
const COMPLETE_BODY_KEYS = [
  'completed', 'already', 'ignored', 'exempt', 'outcome',
  'notify', 'operationId', 'writePaused', 'writeReason', 'consecutiveWriteFailures',
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeToolName(tool) {
  if (typeof tool !== 'string' || tool === '') return null;
  if (tool.startsWith(TOOL_PREFIX)) {
    const short = tool.slice(TOOL_PREFIX.length);
    return TOOL_SET.has(short) ? short : null;
  }
  return TOOL_SET.has(tool) ? tool : null;
}

function fullToolName(short) {
  return `${TOOL_PREFIX}${short}`;
}

function readHeader(headers, name) {
  if (headers === undefined || headers === null) return null;
  const wanted = name.toLowerCase();
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return typeof value === 'string' && value !== '' ? value : null;
  }
  if (headers instanceof Map) {
    for (const [key, value] of headers.entries()) {
      if (String(key).toLowerCase() === wanted) {
        return typeof value === 'string' && value !== '' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
      }
    }
    return null;
  }
  if (typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== wanted) continue;
      const value = headers[key];
      if (typeof value === 'string' && value !== '') return value;
      if (Array.isArray(value) && typeof value[0] === 'string' && value[0] !== '') return value[0];
      return null;
    }
  }
  return null;
}

function tokenEquals(candidate, expected) {
  if (typeof candidate !== 'string' || candidate === '' || typeof expected !== 'string' || expected === '') {
    return false;
  }
  const left = crypto.createHash('sha256').update(candidate, 'utf8').digest();
  const right = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

function normalizeKeySet(value, label) {
  if (value instanceof Set) {
    for (const key of value) {
      if (typeof key !== 'string' || key === '') throw new TypeError(`createXhhAuthorizeRoutes：${label} 只能包含非空字符串`);
    }
    return new Set(value);
  }
  if (!Array.isArray(value)) throw new TypeError(`createXhhAuthorizeRoutes：${label} 必填（数组或 Set）`);
  for (const key of value) {
    if (typeof key !== 'string' || key === '') throw new TypeError(`createXhhAuthorizeRoutes：${label} 只能包含非空字符串`);
  }
  return new Set(value);
}

function resolveClock(clock) {
  if (clock === undefined || clock === null) return () => Date.now();
  if (typeof clock === 'function') return () => clock();
  if (typeof clock === 'object' && typeof clock.now === 'function') return () => clock.now();
  throw new TypeError('createXhhAuthorizeRoutes：clock 必须是函数或带 now() 的对象');
}

/**
 * 创建授权/回执 HTTP 处理器。
 *
 * @param {object} options
 * @param {object} options.authorizeApi `xiaoheihe-authorize-api.mjs` 工厂产物（authorize/complete 必填）
 * @param {string} options.consoleToken 控制台共享 token（非空字符串）
 * @param {string[]|Set<string>} options.backgroundSessionKeys 后台会话 agentKey 集合（必填）
 * @param {(() => number) | { now?: () => number }} [options.clock]
 * @param {(event: object) => void} [options.audit] 结构化审计回调
 */
export function createXhhAuthorizeRoutes(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const authorizeApi = isPlainObject(source.authorizeApi) ? source.authorizeApi : null;
  if (
    authorizeApi === null
    || typeof authorizeApi.authorize !== 'function'
    || typeof authorizeApi.complete !== 'function'
  ) {
    throw new TypeError('createXhhAuthorizeRoutes：authorizeApi 必须提供 authorize/complete');
  }
  const consoleToken = source.consoleToken;
  if (typeof consoleToken !== 'string' || consoleToken === '') {
    throw new TypeError('createXhhAuthorizeRoutes：consoleToken 必须是非空字符串');
  }
  const backgroundSessionKeys = normalizeKeySet(source.backgroundSessionKeys, 'backgroundSessionKeys');
  const agentKeyClassifier = typeof source.agentKeyClassifier === 'function' ? source.agentKeyClassifier : null;
  const clock = resolveClock(source.clock);
  const audit = typeof source.audit === 'function' ? source.audit : null;

  function clockNow() {
    try {
      const value = clock();
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  function resolveNow(explicit) {
    if (explicit === undefined || explicit === null) return clockNow();
    return typeof explicit === 'number' && Number.isFinite(explicit) ? explicit : null;
  }

  function emitAudit(event) {
    if (audit === null) return;
    const safe = {};
    for (const key of Object.keys(event)) {
      if (AUDIT_KEYS.has(key)) safe[key] = event[key];
    }
    try {
      audit(safe);
    } catch {
      // 审计回调异常不得影响响应。
    }
  }

  function authenticate(headers) {
    const token = readHeader(headers, 'x-console-token');
    if (token === null) return { ok: false, status: XHH_AUTHORIZE_ROUTE_STATUS.UNAUTHORIZED, error: 'unauthorized' };
    if (!tokenEquals(token, consoleToken)) return { ok: false, status: XHH_AUTHORIZE_ROUTE_STATUS.FORBIDDEN, error: 'forbidden' };
    return { ok: true };
  }

  /** 调 authorizeApi 之前的分类：有注入 classifier 时以它为准（background/user），否则后台 key 才标 background。 */
  function preApiAgentClass(agentKey) {
    if (agentKeyClassifier !== null) {
      try {
        const classified = agentKeyClassifier(agentKey);
        if (classified === 'background' || classified === 'user') return classified;
      } catch {
        // fall through
      }
      return 'unknown';
    }
    return backgroundSessionKeys.has(agentKey) ? 'background' : 'unknown';
  }

  /** 以 authorizeApi 返回的 agentClass 为准；缺失/非法时回退保守分类（不猜 user）。 */
  function resolveAgentClass(apiClass, agentKey) {
    if (apiClass === 'background' || apiClass === 'user' || apiClass === 'unknown') return apiClass;
    return preApiAgentClass(agentKey);
  }

  function badRequest(status, error, context = {}) {
    emitAudit({ type: context.type ?? 'authorize', at: context.at ?? clockNow(), agentClass: context.agentClass ?? 'unknown', tool: context.tool, decision: 'deny', status, error });
    return { status, body: { ok: false, error } };
  }

  function internalError(context = {}) {
    emitAudit({ type: context.type ?? 'authorize', at: context.at ?? clockNow(), agentClass: context.agentClass ?? 'unknown', tool: context.tool, decision: 'error', status: XHH_AUTHORIZE_ROUTE_STATUS.INTERNAL, error: 'internal-error' });
    return { status: XHH_AUTHORIZE_ROUTE_STATUS.INTERNAL, body: { ok: false, error: 'internal-error' } };
  }

  async function handleAuthorize(request = {}) {
    const payload = isPlainObject(request) ? request : {};
    const at = resolveNow(payload.now);
    const auth = authenticate(payload.headers);
    if (!auth.ok) {
      emitAudit({ type: 'authorize', at, agentClass: 'unknown', decision: 'deny', status: auth.status, error: auth.error });
      return { status: auth.status, body: { ok: false, error: auth.error } };
    }
    if (at === null) return badRequest(XHH_AUTHORIZE_ROUTE_STATUS.BAD_REQUEST, 'invalid-clock');
    const body = payload.body;
    if (!isPlainObject(body)) return badRequest(XHH_AUTHORIZE_ROUTE_STATUS.BAD_REQUEST, 'invalid-body', { at });

    const agentKey = body.agentKey;
    if (typeof agentKey !== 'string' || agentKey.trim() === '' || agentKey.length > MAX_AGENT_KEY_LENGTH) {
      return badRequest(XHH_AUTHORIZE_ROUTE_STATUS.BAD_REQUEST, 'invalid-agent', { at });
    }
    const tool = normalizeToolName(body.tool);
    if (tool === null) return badRequest(XHH_AUTHORIZE_ROUTE_STATUS.BAD_REQUEST, 'invalid-tool', { at, agentClass: preApiAgentClass(agentKey) });
    const args = body.args === undefined ? {} : body.args;
    if (!isPlainObject(args)) return badRequest(XHH_AUTHORIZE_ROUTE_STATUS.BAD_REQUEST, 'invalid-args', { at, agentClass: preApiAgentClass(agentKey), tool });
    const preAgentClass = preApiAgentClass(agentKey);

    let result;
    try {
      result = await authorizeApi.authorize({ agentKey, tool: fullToolName(tool), args, now: at });
    } catch {
      return internalError({ type: 'authorize', at, agentClass: preAgentClass, tool });
    }
    if (!isPlainObject(result) || (result.decision !== 'allow' && result.decision !== 'deny')) {
      return internalError({ type: 'authorize', at, agentClass: preAgentClass, tool });
    }
    const agentClass = resolveAgentClass(result.agentClass, agentKey);

    if (result.decision === 'allow') {
      const response = {
        ok: true,
        decision: 'allow',
        exemption: result.exemption ?? 'quota',
      };
      for (const key of ALLOW_BODY_KEYS) {
        if (result[key] !== undefined) response[key] = result[key];
      }
      emitAudit({ type: 'authorize', at, agentClass, tool, decision: 'allow', status: XHH_AUTHORIZE_ROUTE_STATUS.OK, exemption: response.exemption });
      return { status: XHH_AUTHORIZE_ROUTE_STATUS.OK, body: response };
    }

    const response = {
      ok: true,
      decision: 'deny',
      reason: typeof result.reason === 'string' && result.reason !== '' ? result.reason : 'denied',
      ...(result.controllerReason === undefined ? {} : { controllerReason: result.controllerReason }),
      ...(typeof result.hint === 'string' && result.hint.trim() !== '' ? { hint: result.hint } : {}),
      ...(typeof result.retryAfterMs === 'number' && Number.isFinite(result.retryAfterMs) && result.retryAfterMs > 0 ? { retryAfterMs: result.retryAfterMs } : {}),
    };
    emitAudit({ type: 'authorize', at, agentClass, tool, decision: 'deny', status: XHH_AUTHORIZE_ROUTE_STATUS.OK, reason: response.reason });
    return { status: XHH_AUTHORIZE_ROUTE_STATUS.OK, body: response };
  }

  async function handleComplete(request = {}) {
    const payload = isPlainObject(request) ? request : {};
    const at = resolveNow(payload.now);
    const auth = authenticate(payload.headers);
    if (!auth.ok) {
      emitAudit({ type: 'complete', at, agentClass: 'unknown', decision: 'deny', status: auth.status, error: auth.error });
      return { status: auth.status, body: { ok: false, error: auth.error } };
    }
    if (at === null) return badRequest(XHH_AUTHORIZE_ROUTE_STATUS.BAD_REQUEST, 'invalid-clock', { type: 'complete', at: clockNow() });
    const body = payload.body;
    if (!isPlainObject(body)) return badRequest(XHH_AUTHORIZE_ROUTE_STATUS.BAD_REQUEST, 'invalid-body', { type: 'complete', at });

    const ticket = body.ticket;
    if (!isPlainObject(ticket) || Object.keys(ticket).length === 0) {
      return badRequest(XHH_AUTHORIZE_ROUTE_STATUS.BAD_REQUEST, 'invalid-ticket', { type: 'complete', at });
    }
    const outcome = body.outcome;
    if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) {
      return badRequest(XHH_AUTHORIZE_ROUTE_STATUS.BAD_REQUEST, 'invalid-outcome', { type: 'complete', at });
    }
    const agentClass = typeof ticket.agentKey === 'string' && ticket.agentKey !== ''
      ? preApiAgentClass(ticket.agentKey)
      : 'unknown';
    // 审计适配器靠 tool 判断 read/write 并映射事件；complete 事件必须带上（否则被丢弃）。
    const ticketTool = typeof ticket.tool === 'string' ? ticket.tool : undefined;

    let result;
    try {
      // agentKey 透传（与 commit/abort 一致）：仅在 body 显式提供时传递，API 层做绑定校验。
      const completeRequest = { ticket, outcome, now: at };
      if (typeof body.agentKey === 'string' && body.agentKey !== '') completeRequest.agentKey = body.agentKey;
      result = await authorizeApi.complete(completeRequest);
    } catch {
      return internalError({ type: 'complete', at, agentClass });
    }
    if (!isPlainObject(result) || typeof result.ok !== 'boolean') {
      return internalError({ type: 'complete', at, agentClass });
    }

    if (result.ok === true) {
      const response = { ok: true };
      for (const key of COMPLETE_BODY_KEYS) {
        if (result[key] !== undefined) response[key] = result[key];
      }
      // task-130：暂停事件要让审计适配器能映射成 write-paused（bridge 通知队列只认该 reason）。
      // 只在真实暂停转变（notify==='write-failures'）时附带 reason，普通成功/重复回执不带。
      const pauseReason = result.notify === 'write-failures' ? 'write-paused' : undefined;
      const auditOutcome = OUTCOMES.has(result.outcome) ? result.outcome : outcome;
      const auditReason = pauseReason ?? (result.already === true && ticket.kind === 'read' ? 'duplicate-complete' : undefined);
      emitAudit({
        type: 'complete',
        at,
        agentClass,
        outcome: auditOutcome,
        decision: 'allow',
        status: XHH_AUTHORIZE_ROUTE_STATUS.OK,
        ...(Number.isSafeInteger(result.readIndex) && result.readIndex > 0 ? { readIndex: result.readIndex } : {}),
        ...(Number.isFinite(result.readStartedAt) ? { readStartedAt: result.readStartedAt } : {}),
        ...(auditReason === undefined ? {} : { reason: auditReason }),
        ...(typeof result.operationId === 'string' && result.operationId !== '' ? { opId: result.operationId } : {}),
        ...(ticketTool === undefined ? {} : { tool: ticketTool }),
      });
      return { status: XHH_AUTHORIZE_ROUTE_STATUS.OK, body: response };
    }

    if (result.reason === 'unknown-ticket') {
      emitAudit({ type: 'complete', at, agentClass, outcome, decision: 'deny', status: XHH_AUTHORIZE_ROUTE_STATUS.OK, error: 'unknown-ticket', ...(ticketTool === undefined ? {} : { tool: ticketTool }) });
      return { status: XHH_AUTHORIZE_ROUTE_STATUS.OK, body: { ok: false, error: 'unknown-ticket' } };
    }

    // 业务拒绝（execute-first 票据状态错误）→ 200 {ok:false, reason}；其它失败才 500。
    const businessReasons = new Set(['not-started', 'invalid-ticket', 'ticket-aborted', 'ticket-expired', 'already-finished', 'unknown-ticket']);
    if (typeof result.reason === 'string' && businessReasons.has(result.reason)) {
      emitAudit({ type: 'complete', at, agentClass, outcome, decision: 'deny', status: XHH_AUTHORIZE_ROUTE_STATUS.OK, reason: result.reason, ...(ticketTool === undefined ? {} : { tool: ticketTool }) });
      return { status: XHH_AUTHORIZE_ROUTE_STATUS.OK, body: { ok: false, reason: result.reason } };
    }

    // 其它失败一律视为内部错误（fail-closed；不把半成功结果映射成 2xx allow）。
    return internalError({ type: 'complete', at, agentClass });
  }

  /**
   * task-130：只读状态端点（POST /api/xiaoheihe/status，空 body 亦可）。
   * 只暴露 controller 的安全状态白名单字段，供 bridge 比对「真实暂停/恢复变化」：
   * 只有在先前观测到 writePaused=true、之后观测到 false（真实 adminRecover）时，调用方才可判定
   * 恢复；本路由**绝不**因为某次 authorize/complete 成功就生成 recovered 事件或清除暂停。
   */
  async function handleStatus(request = {}) {
    const payload = isPlainObject(request) ? request : {};
    const at = resolveNow(payload.now);
    const auth = authenticate(payload.headers);
    if (!auth.ok) {
      emitAudit({ type: 'status', at, agentClass: 'unknown', decision: 'deny', status: auth.status, error: auth.error });
      return { status: auth.status, body: { ok: false, error: auth.error } };
    }
    if (at === null) return badRequest(XHH_AUTHORIZE_ROUTE_STATUS.BAD_REQUEST, 'invalid-clock', { type: 'status', at: clockNow() });
    if (typeof authorizeApi.status !== 'function') {
      return internalError({ type: 'status', at, agentClass: 'unknown' });
    }
    let result;
    try {
      result = await authorizeApi.status();
    } catch {
      return internalError({ type: 'status', at, agentClass: 'unknown' });
    }
    if (!isPlainObject(result) || typeof result.ok !== 'boolean') {
      return internalError({ type: 'status', at, agentClass: 'unknown' });
    }
    if (result.ok !== true) {
      return internalError({ type: 'status', at, agentClass: 'unknown' });
    }
    const response = {
      ok: true,
      writePaused: result.writePaused === true,
      accessPaused: result.accessPaused === true,
    };
    if (typeof result.writeReason === 'string' && result.writeReason !== '') response.writeReason = result.writeReason;
    if (typeof result.accessReason === 'string' && result.accessReason !== '') response.accessReason = result.accessReason;
    if (Number.isInteger(result.consecutiveWriteFailures) && result.consecutiveWriteFailures >= 0) {
      response.consecutiveWriteFailures = result.consecutiveWriteFailures;
    }
    emitAudit({ type: 'status', at, agentClass: 'unknown', decision: 'allow', status: XHH_AUTHORIZE_ROUTE_STATUS.OK });
    return { status: XHH_AUTHORIZE_ROUTE_STATUS.OK, body: response };
  }

  /** 从 body 读取 ticket（对象且非空）+ 可选 agentKey；非法返回固定错误码。 */
  function readTicketBody(body, at, type) {
    const ticket = body.ticket;
    if (!isPlainObject(ticket) || Object.keys(ticket).length === 0) {
      return { ok: false, response: badRequest(XHH_AUTHORIZE_ROUTE_STATUS.BAD_REQUEST, 'invalid-ticket', { type, at }) };
    }
    const agentKey = body.agentKey;
    if (agentKey !== undefined && (typeof agentKey !== 'string' || agentKey.trim() === '' || agentKey.length > MAX_AGENT_KEY_LENGTH)) {
      return { ok: false, response: badRequest(XHH_AUTHORIZE_ROUTE_STATUS.BAD_REQUEST, 'invalid-agent', { type, at }) };
    }
    return { ok: true, ticket, agentKey };
  }

  async function handleCommit(request = {}) {
    const payload = isPlainObject(request) ? request : {};
    const at = resolveNow(payload.now);
    const auth = authenticate(payload.headers);
    if (!auth.ok) {
      emitAudit({ type: 'commit', at, agentClass: 'unknown', decision: 'deny', status: auth.status, error: auth.error });
      return { status: auth.status, body: { ok: false, error: auth.error } };
    }
    if (at === null) return badRequest(XHH_AUTHORIZE_ROUTE_STATUS.BAD_REQUEST, 'invalid-clock', { type: 'commit', at: clockNow() });
    const body = payload.body;
    if (!isPlainObject(body)) return badRequest(XHH_AUTHORIZE_ROUTE_STATUS.BAD_REQUEST, 'invalid-body', { type: 'commit', at });
    const read = readTicketBody(body, at, 'commit');
    if (!read.ok) return read.response;
    const agentClass = typeof read.agentKey === 'string' ? preApiAgentClass(read.agentKey) : 'unknown';
    if (typeof authorizeApi.commit !== 'function') {
      return internalError({ type: 'commit', at, agentClass });
    }

    let result;
    try {
      result = await authorizeApi.commit({ ticket: read.ticket, agentKey: read.agentKey, now: at });
    } catch {
      return internalError({ type: 'commit', at, agentClass });
    }
    if (!isPlainObject(result) || typeof result.ok !== 'boolean') {
      return internalError({ type: 'commit', at, agentClass });
    }
    if (result.ok === true) {
      const response = { ok: true, started: true };
      for (const key of ['ticket', 'used', 'limit', 'remaining', 'already']) {
        if (result[key] !== undefined) response[key] = result[key];
      }
      emitAudit({ type: 'commit', at, agentClass, tool: typeof read.ticket?.tool === 'string' ? read.ticket.tool : null, decision: 'allow', status: XHH_AUTHORIZE_ROUTE_STATUS.OK });
      return { status: XHH_AUTHORIZE_ROUTE_STATUS.OK, body: response };
    }
    const response = {
      ok: false,
      reason: typeof result.reason === 'string' && result.reason !== '' ? result.reason : 'commit-failed',
      ...(result.controllerReason === undefined ? {} : { controllerReason: result.controllerReason }),
    };
    emitAudit({ type: 'commit', at, agentClass, tool: typeof read.ticket?.tool === 'string' ? read.ticket.tool : null, decision: 'deny', status: XHH_AUTHORIZE_ROUTE_STATUS.OK, reason: response.reason });
    return { status: XHH_AUTHORIZE_ROUTE_STATUS.OK, body: response };
  }

  async function handleAbort(request = {}) {
    const payload = isPlainObject(request) ? request : {};
    const at = resolveNow(payload.now);
    const auth = authenticate(payload.headers);
    if (!auth.ok) {
      emitAudit({ type: 'abort', at, agentClass: 'unknown', decision: 'deny', status: auth.status, error: auth.error });
      return { status: auth.status, body: { ok: false, error: auth.error } };
    }
    if (at === null) return badRequest(XHH_AUTHORIZE_ROUTE_STATUS.BAD_REQUEST, 'invalid-clock', { type: 'abort', at: clockNow() });
    const body = payload.body;
    if (!isPlainObject(body)) return badRequest(XHH_AUTHORIZE_ROUTE_STATUS.BAD_REQUEST, 'invalid-body', { type: 'abort', at });
    const read = readTicketBody(body, at, 'abort');
    if (!read.ok) return read.response;
    const agentClass = typeof read.agentKey === 'string' ? preApiAgentClass(read.agentKey) : 'unknown';
    if (typeof authorizeApi.abort !== 'function') {
      return internalError({ type: 'abort', at, agentClass });
    }

    let result;
    try {
      result = await authorizeApi.abort({ ticket: read.ticket, agentKey: read.agentKey, now: at });
    } catch {
      return internalError({ type: 'abort', at, agentClass });
    }
    if (!isPlainObject(result) || typeof result.ok !== 'boolean') {
      return internalError({ type: 'abort', at, agentClass });
    }
    if (result.ok === true) {
      const response = { ok: true, aborted: true };
      for (const key of ['already', 'rolledBack']) {
        if (result[key] !== undefined) response[key] = result[key];
      }
      emitAudit({ type: 'abort', at, agentClass, tool: typeof read.ticket?.tool === 'string' ? read.ticket.tool : null, decision: 'allow', status: XHH_AUTHORIZE_ROUTE_STATUS.OK });
      return { status: XHH_AUTHORIZE_ROUTE_STATUS.OK, body: response };
    }
    const response = {
      ok: false,
      reason: typeof result.reason === 'string' && result.reason !== '' ? result.reason : 'abort-failed',
      ...(result.controllerReason === undefined ? {} : { controllerReason: result.controllerReason }),
    };
    emitAudit({ type: 'abort', at, agentClass, tool: typeof read.ticket?.tool === 'string' ? read.ticket.tool : null, decision: 'deny', status: XHH_AUTHORIZE_ROUTE_STATUS.OK, reason: response.reason });
    return { status: XHH_AUTHORIZE_ROUTE_STATUS.OK, body: response };
  }

  return { handleAuthorize, handleCommit, handleAbort, handleComplete, handleStatus };
}
