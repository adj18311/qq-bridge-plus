/**
 * 路线 B 授权事件 → 后台巡逻审计（background-patrol-audit）**固定字段适配器**（纯模块，未接线）。
 *
 * 背景（task-49）：`xiaoheihe-authorize-route.mjs` 与 `xiaoheihe-authorize-api.mjs` 各自产出结构化审计
 * 事件（authorize/complete），字段是传输/授权语义；`background-patrol-audit.mjs` 的字段是另一套固定
 * 白名单（action/result/platform/reason/quota/opId）。本模块只做**字段映射**，把前者安全地落进后者，
 * 避免接线时口径分散在桥接/测试里，也避免把 args 原文、Cookie/token 等带进审计。
 *
 * 映射规则：
 *  · 接受 `type:'authorize'|'commit'|'abort'|'complete'`；其它事件 → 不写（`{ok:false, reason:'unsupported-event'}`）。
 *  · action：写工具（publish_content/publish_article/publish_video/post_comment/reply_comment）→ 'write'；
 *    其它受支持工具（home/detail/search/登录/资料/二维码）→ 'read'；authorize 被拒绝 → 'skip'。
 *  · result：authorize allow→'allowed'、deny→'denied'；complete outcome success/failure/unknown 原样。
 *  · reason：优先 event.reason，其次 event.error；必须是 1..64 字小写机器码（^[a-z][a-z0-9-]{0,63}$），
 *    否则 null —— **绝不复制自由文本/args/evidence**。
 *  · at：event.at（有限毫秒）缺省用注入时钟；都没有 → 不写（不伪造时间）。
 *  · 其余字段（tool/agentClass/exemption/status/args/cookie/token/...）**一律丢弃**；quota/opId 恒为 null
 *    （授权事件里没有可核查的数值额度快照，宁缺勿造）。
 *
 * 明确不做：不发送通知、不接线、不读 config/网络、不写审计以外的文件；audit 写失败原样返回
 * `{ok:false,error}`（由调用方决定告警/降级），适配器不吞错。
 */

/** 适配器契约版本（独立于 audit 模块 schema）。 */
export const XHH_AUTHORIZE_AUDIT_ADAPTER_VERSION = 1;

const TOOL_PREFIX = 'mcp__xiaoheihe__';
const READ_TOOLS = new Set(['get_home_content', 'get_post_detail', 'search_content', 'check_login_status', 'get_user_profile', 'interactive_login', 'get_login_qr_code']);
const WRITE_TOOLS = new Set(['publish_content', 'publish_article', 'publish_video', 'post_comment', 'reply_comment']);
const AUTHORIZE_DECISIONS = new Set(['allow', 'deny']);
const COMPLETE_OUTCOMES = new Set(['success', 'failure', 'unknown']);
const REASON_RE = /^[a-z][a-z0-9-]{0,63}$/;
const PLATFORM = 'xiaoheihe';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function resolveClock(clock) {
  if (clock === undefined || clock === null) return null;
  if (typeof clock === 'function') return () => clock();
  if (isPlainObject(clock) && typeof clock.now === 'function') return () => clock.now();
  throw new TypeError('createXhhAuthorizeAuditAdapter：clock 必须是函数或带 now() 的对象');
}

function clockNow(clock) {
  if (clock === null) return null;
  let value;
  try {
    value = clock();
  } catch {
    return null;
  }
  return isFiniteTimestamp(value) ? value : null;
}

function shortToolName(tool) {
  if (typeof tool !== 'string' || tool === '') return null;
  const short = tool.startsWith(TOOL_PREFIX) ? tool.slice(TOOL_PREFIX.length) : tool;
  if (READ_TOOLS.has(short) || WRITE_TOOLS.has(short)) return short;
  return null;
}

function actionForTool(short, decision) {
  if (decision === 'deny') return 'skip';
  return WRITE_TOOLS.has(short) ? 'write' : 'read';
}

function validReasonCode(value) {
  return typeof value === 'string' && REASON_RE.test(value) ? value : null;
}

/**
 * 纯映射：授权/回执事件 → audit.record payload；不可映射返回 null。
 *
 * @param {object} event route/authorize-api 产出的事件（只读取白名单字段）
 * @param {{ now?: () => number } | (() => number)} [clock] 缺 at 时使用的时钟
 * @returns {{at:number, platform:'xiaoheihe', action:'read'|'write'|'skip',
 *            result:'allowed'|'denied'|'success'|'failure'|'unknown',
 *            reason:string|null} | null}
 */
export function mapAuthorizeAuditEvent(event, clock) {
  const clockFn = clock === undefined ? null : (typeof clock === 'function' ? clock : resolveClock(clock));
  try {
    if (!isPlainObject(event)) return null;
    const short = shortToolName(event.tool);
    if (short === null) return null;
    // 显式提供的 at 必须是有限时间戳；非法时拒绝（不静默回退时钟，避免伪造时间）。
    let at;
    if (event.at === undefined || event.at === null) {
      at = clockNow(clockFn);
    } else {
      at = isFiniteTimestamp(event.at) ? event.at : null;
    }
    if (at === null) return null;

    if (event.type === 'authorize') {
      if (!AUTHORIZE_DECISIONS.has(event.decision)) return null;
      const reason = validReasonCode(event.reason) ?? validReasonCode(event.error);
      return {
        at,
        platform: PLATFORM,
        action: actionForTool(short, event.decision),
        result: event.decision === 'allow' ? 'allowed' : 'denied',
        reason,
      };
    }
    if (event.type === 'complete') {
      if (!COMPLETE_OUTCOMES.has(event.outcome)) return null;
      return {
        at,
        platform: PLATFORM,
        action: WRITE_TOOLS.has(short) ? 'write' : 'read',
        result: event.outcome,
        reason: validReasonCode(event.reason) ?? validReasonCode(event.error),
        // task-132：暂停转换 id → 审计 opId（bridge 通知按 operationId 去重）。
        opId: typeof event.opId === 'string' && event.opId !== '' ? event.opId : null,
      };
    }
    // task-78：route 的 commit/abort 事件也落固定字段（commit allow=allowed；abort=skip/unknown）。
    if (event.type === 'commit') {
      if (!AUTHORIZE_DECISIONS.has(event.decision)) return null;
      return {
        at,
        platform: PLATFORM,
        action: event.decision === 'allow' ? (WRITE_TOOLS.has(short) ? 'write' : 'read') : 'skip',
        result: event.decision === 'allow' ? 'allowed' : 'denied',
        reason: validReasonCode(event.reason) ?? validReasonCode(event.error),
      };
    }
    if (event.type === 'abort') {
      if (!AUTHORIZE_DECISIONS.has(event.decision)) return null;
      return {
        at,
        platform: PLATFORM,
        action: 'skip',
        result: event.decision === 'allow' ? 'unknown' : 'denied',
        reason: event.decision === 'allow' ? 'aborted' : (validReasonCode(event.reason) ?? validReasonCode(event.error)),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 创建适配器：把事件写进注入的 audit 模块（真实 audit 或等价 {record} 实现）。
 *
 * @param {object} options
 * @param {{ record: Function }} options.audit `createBackgroundPatrolAudit()` 产物（或等价）
 * @param {(() => number) | { now?: () => number }} [options.clock]
 */
export function createXhhAuthorizeAuditAdapter(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('createXhhAuthorizeAuditAdapter：options 必须是对象');
  const audit = options.audit;
  if (!isPlainObject(audit) || typeof audit.record !== 'function') {
    throw new TypeError('createXhhAuthorizeAuditAdapter：audit 必须是带 record() 的审计模块实例');
  }
  const clock = resolveClock(options.clock);

  async function record(event) {
    const payload = mapAuthorizeAuditEvent(event, clock);
    if (payload === null) return { ok: false, reason: 'unsupported-event' };
    // 元数据只给内存消费者，固定格式审计 record 不包含来源、工具或输入原文。
    const meta = event.type === 'complete' && ['background', 'user', 'unknown'].includes(event.agentClass)
      ? { agentClass: event.agentClass, tool: shortToolName(event.tool),
          ...(Number.isSafeInteger(event.readIndex) && event.readIndex > 0 ? { readIndex: event.readIndex } : {}),
          ...(Number.isFinite(event.readStartedAt) ? { readStartedAt: event.readStartedAt } : {}) }
      : undefined;
    return audit.record(payload, meta);
  }

  async function recordMany(events) {
    if (!Array.isArray(events)) return { ok: false, reason: 'invalid-events' };
    const results = [];
    let written = 0;
    let skipped = 0;
    for (const event of events) {
      const result = await record(event);
      results.push(result);
      if (result.ok === true) written += 1;
      else if (result.reason === 'unsupported-event') skipped += 1;
    }
    return { ok: true, written, skipped, results };
  }

  return { record, recordMany };
}
