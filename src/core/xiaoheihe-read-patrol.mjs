/**
 * 小黑盒只读巡逻（第五阶段；独立可测，尚未接生产 bridge）。
 *
 * 职责边界（有意保持很小）：
 *  · 只允许三个精确的只读工具名：get_home_content / get_post_detail / search_content。
 *    其它任何名字（尾随空格、大小写变体、近似名、裸工具名）一律 fail-closed：
 *    只做严格全等比较，不 trim、不做大小写归一；未知工具绝不调用注入的 invoke。
 *  · get_home_content / get_post_detail 属于读取桶：必须先通过注入的 state.tryConsume
 *    取得 xiaoheihe/read 当日额度许可，拿到 ok:true 之后才调用注入的 invoke；
 *    search_content 不查询也不消耗读取额度，直接调用 invoke。
 *  · 拒绝、状态查询抛错（同步或异步）、额度耗尽时都绝不调用 invoke，也绝不重试；
 *    每个请求里 state.tryConsume 与 invoke 最多各调用一次。
 *  · 不导入桥接、文件系统或网络模块；不读账号、Cookie、令牌；不接生产调用，全部依赖注入。
 *  · 审计只输出固定白名单字段（tool / platform / bucket / outcome / reason / used / limit），
 *    绝不携带参数正文、工具响应、异常消息或凭据；审计同步抛错与异步拒绝一律被吞掉，
 *    不改变请求结果、不触发重试；成功审计只在真实调用发生之后记录，拒绝/状态错误的审计
 *    只标记 outcome 与固定 reason，绝不冒充一次已经发生的读取。
 *  · 额度先落盘再调用 invoke：崩溃或客户端未能发出请求时可能多计，不能当作精确到达平台的证明。
 */

const PLATFORM = 'xiaoheihe';
const READ_BUCKET = 'read';

const HOME_CONTENT = 'mcp__xiaoheihe__get_home_content';
const POST_DETAIL = 'mcp__xiaoheihe__get_post_detail';
const SEARCH_CONTENT = 'mcp__xiaoheihe__search_content';

const READ_TOOL_NAMES = Object.freeze([HOME_CONTENT, POST_DETAIL]);
const READ_TOOL_SET = new Set(READ_TOOL_NAMES);
const SEARCH_TOOL_SET = new Set([SEARCH_CONTENT]);
const ALLOWED_TOOL_SET = new Set([...READ_TOOL_NAMES, SEARCH_CONTENT]);

const QUOTA_REASON_SET = new Set(['daily-cap', 'clock-rollback', 'min-interval']);

const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'XIAOHEIHE_READ_PATROL_INVALID_REQUEST',
  TOOL_DENIED: 'XIAOHEIHE_READ_PATROL_TOOL_DENIED',
  QUOTA_DENIED: 'XIAOHEIHE_READ_PATROL_QUOTA_DENIED',
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 创建小黑盒只读巡逻实例。全部依赖注入：
 *  · state  —— 必须提供 tryConsume({platform, bucket})，返回 {ok:true,used,limit} 或 {ok:false,reason}；
 *  · invoke —— async (tool, args) => result，真实 MCP 调用的唯一入口（本模块绝不自己碰 MCP）；
 *  · audit  —— (record) => void | Promise<void>，只接收固定白名单字段的普通对象。
 *
 * 返回 { run(request) }：request 形如 { tool, args }。
 * 成功 resolve 注入 invoke 的返回值；拒绝、额度不足、状态失败时 reject（不调用 invoke）。
 */
export function createXiaoheiheReadPatrol(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const { state, invoke, audit } = source;

  if (!isPlainObject(state) || typeof state.tryConsume !== 'function') {
    throw new TypeError('createXiaoheiheReadPatrol: options.state.tryConsume 必须是函数');
  }
  if (typeof invoke !== 'function') {
    throw new TypeError('createXiaoheiheReadPatrol: options.invoke 必须是函数');
  }
  if (typeof audit !== 'function') {
    throw new TypeError('createXiaoheiheReadPatrol: options.audit 必须是函数');
  }

  /** 审计失败绝不影响请求结果，也不触发重试；异步拒绝必须显式接住，避免未处理拒绝。 */
  function safeAudit(record) {
    try {
      const returned = audit(record);
      if (returned !== null && typeof returned === 'object' && typeof returned.then === 'function') {
        returned.then(undefined, () => {});
      }
    } catch {
      // 审计 sink 抛错：吞掉，请求结果照常返回。
    }
  }

  function auditReturned(tool, bucket, used, limit) {
    // MCP Promise 正常返回也可能包含业务错误；仅记录返回，不能宣称平台操作成功。
    const record = { tool, platform: PLATFORM, bucket, outcome: 'returned', reason: null };
    if (Number.isFinite(used)) record.used = used;
    if (Number.isFinite(limit)) record.limit = limit;
    safeAudit(record);
  }

  function auditDenied(tool, bucket, reason) {
    safeAudit({ tool, platform: PLATFORM, bucket, outcome: 'denied', reason });
  }

  function auditError(tool, bucket, reason) {
    safeAudit({ tool, platform: PLATFORM, bucket, outcome: 'error', reason });
  }

  async function runSearch(tool, args) {
    let result;
    try {
      result = await invoke(tool, args);
    } catch (error) {
      auditError(tool, null, 'invoke-error');
      throw error;
    }
    auditReturned(tool, null);
    return result;
  }

  async function runRead(tool, args) {
    let permit;
    try {
      permit = await state.tryConsume({ platform: PLATFORM, bucket: READ_BUCKET });
    } catch (error) {
      // 状态不可用：不调用 invoke，也不重试状态查询。
      auditError(tool, READ_BUCKET, 'state-error');
      throw error;
    }

    if (!isPlainObject(permit) || permit.ok !== true) {
      const reason = isPlainObject(permit) && typeof permit.reason === 'string' && QUOTA_REASON_SET.has(permit.reason)
        ? permit.reason
        : 'quota-denied';
      auditDenied(tool, READ_BUCKET, reason);
      throw createError(ERROR_CODES.QUOTA_DENIED, `小黑盒只读巡逻：读取额度不可用（${reason}）`);
    }

    let result;
    try {
      result = await invoke(tool, args);
    } catch (error) {
      // 调用已尝试，但异常不能证明请求到达了平台；额度已落盘，原样抛出且不重试。
      auditError(tool, READ_BUCKET, 'invoke-error');
      throw error;
    }

    auditReturned(tool, READ_BUCKET, permit.used, permit.limit);
    return result;
  }

  async function run(request) {
    if (!isPlainObject(request)) {
      auditDenied(null, null, 'invalid-request');
      throw createError(ERROR_CODES.INVALID_REQUEST, '小黑盒只读巡逻：请求必须是普通对象');
    }

    const tool = request.tool;
    if (typeof tool !== 'string' || !ALLOWED_TOOL_SET.has(tool)) {
      // 未知工具 fail-closed：不 trim、不做大小写归一、不调用 invoke、不消耗额度。
      auditDenied(null, null, 'unknown-tool');
      throw createError(ERROR_CODES.TOOL_DENIED, '小黑盒只读巡逻：工具不在只读白名单内');
    }

    const args = request.args;
    if (args !== undefined && args !== null && !isPlainObject(args)) {
      auditDenied(tool, READ_TOOL_SET.has(tool) ? READ_BUCKET : null, 'invalid-args');
      throw createError(ERROR_CODES.INVALID_REQUEST, '小黑盒只读巡逻：args 必须是普通对象');
    }

    if (SEARCH_TOOL_SET.has(tool)) return runSearch(tool, args);
    return runRead(tool, args);
  }

  return { run };
}
