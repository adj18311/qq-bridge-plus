/**
 * 路线 B 桥接侧「授权 / 回执」纯处理器（**未接线**）。
 *
 * 背景：规格 2026-10-25 决定采用路线 B（DSH profile 插件 + 异步 `tools/pre-execute` 授权）；
 * 本模块只承载**桥接侧纯逻辑**：给定 agentKey/tool/args/now，返回 allow/deny 与 ticket；
 * 真正接入 DSH 插件、bridge 与 QQ 发送不在本文件。controller 与 audit 全部注入，
 * 本模块不 import bridge/DSH、不发 QQ、不读 config/state、无 I/O。
 *
 * 语义（与用户 2026-10-25 决策对齐）：
 *  · 工具白名单：只接受 12 个小黑盒工具（短名或 `mcp__xiaoheihe__*` 全名）；其它一律 deny
 *    `unknown-tool`（fail-closed，绝不因“看起来像”而放行）。
 *  · agentClass：
 *      - agentKey ∈ backgroundSessionKeys → `background`（后台会话，计额度）；
 *      - agentKey ∈ userExemptAgents    → `user`（管理员明确要求，豁免额度）；
 *      - 其它 → deny `unknown-agent`（fail-closed；不调用 controller）。
 *  · 暂停优先于豁免：先读 controller.status() 的 accessPaused/writePaused——
 *      accessPaused → 读/写/misc 一律 deny；writePaused → 仅写 deny，读/misc 放行。
 *    因此「用户明确要求」也不豁免安全暂停（用户 2026-10-25 决定）。
 *  · 用户例外：allow + exemption:'user' + counted:false + exempt ticket；不调用 authorizeRead/Write。
 *  · 后台会话：读（home/detail）走 controller.authorizeRead（14/日）；search 不计数；
 *    写（post 类→post 桶、comment/reply→comment 桶）走 controller.authorizeWrite（2/10+间隔），
 *    必须从 args.operationId 取稳定操作 id；misc（登录/资料/二维码）不占额度但受 accessPaused 限制。
 *    misc 也必须签发带 ticketId 的票据：DSH 插件对非豁免 allow 强制要求 ticketId 并 commit，
 *    否则会被 missing-ticket 误拒（task-129）；misc 的 commit/abort 是空操作（不触 controller、不计额）。
 *  · complete：write ticket → controller.finish(outcome)；unknown 只标记不重放（再次授权同 id 由
 *    controller 返回 unknown-not-replayable）；read/misc/exempt ticket 幂等忽略；未知/外部 ticket →
 *    `unknown-ticket`；已结束 → 幂等 `already:true`。
 *  · 额度口径（明确）：写操作「授权即计数」——**unknown 结果也占额度**（不是只有 success 才占），
 *    这是保守方向（宁可少写不可超写）；失败/未知均不回退额度。
 *  · 审计：每次 authorize/complete 调 audit 回调，固定字段 {type, at, tool, decision, reason,
 *    exemption, agentClass, outcome, controllerReason}；不记录 args 原文 / evidence / Cookie / token。
 *
 * 明确不做：不拦截真实工具调用（由 DSH 插件接线负责）；不自行发送 QQ 通知（队列/发送由 bridge 负责）；
 * 不读 config/凭据；不做 QQ 会话到 agentKey 的映射（由调用方提供）；没有跨进程状态。
 *
 * task-130 暂停事件契约：
 *  · complete 的 write 回执会把 controller.finish 返回的暂停事件（第三次明确写失败时
 *    notify='write-failures' + writePaused/writeReason/consecutiveWriteFailures）原样透传；
 *  · 若落盘失败（persist-failed），事件暂存在 entry，重试成功时交付且只交付一次；
 *  · 重复 complete（already-finished）不重复交付 notify，避免 bridge 重复通知；
 *  · status() 只读暴露 controller 的安全状态快照，供调用方比对真实变化后判定「恢复」；
 *    本模块**不会**把任何 allow/success 结果判定为恢复，也不产生 recovered 事件。
 */

import { randomUUID } from 'node:crypto';
import { capabilityOfTool, decideCapability } from './xiaoheihe-console-settings.mjs';

export const XHH_AUTHORIZE_TOOL_NAMES = Object.freeze([
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

export const XHH_AUTHORIZE_READ_TOOLS = Object.freeze(['get_home_content', 'get_post_detail']);
export const XHH_AUTHORIZE_WRITE_TOOLS = Object.freeze([
  'publish_content', 'publish_article', 'publish_video', 'post_comment', 'reply_comment',
]);

/**
 * 用户 2026-10-29 决定：登录/二维码属于**第三桶「凭据」**，既不算读也不算写。
 *  · 扫码必须由人完成（智能体无法自助登录），所以扫码本身就是人工因子 ⇒ owner/group 可发起；
 *  · 无人值守发起会阻塞 120–180 秒、把登录页/图片查看器窗口弹到桌面、
 *    往进程 CWD 写 `qrcode.png`，且可被不可信平台内容诱导（「继续之前先重新登录」）⇒
 *    patrol/unknown 一律拒绝，并附可执行提示；
 *  · group 另受「整机 30 分钟最多 1 次」限制，防一条消息刷出十个二维码。
 * 注意：这两个工具 isWrite=false，`readOnly` 只拦写、后台写门禁也只拦写，
 * 两条都管不到它们 —— 必须显式判定，不能靠复用 `readOnly` 兜。
 */
export const XHH_AUTHORIZE_CREDENTIAL_TOOLS = Object.freeze(['interactive_login', 'get_login_qr_code']);
export const XHH_AUTHORIZE_CREDENTIAL_COOLDOWN_MS = 30 * 60 * 1000;
/** deny 必须带回可执行提示，否则智能体只会回「失败了」，用户无法知道下一步该做什么。 */
export const XHH_AUTHORIZE_CREDENTIAL_DENY_HINT =
  '请在私聊中要求我重新登录（我会发起二维码让你扫），或直接在小黑盒网页自行登录';
const CREDENTIAL_SET = new Set(XHH_AUTHORIZE_CREDENTIAL_TOOLS);
/** 来源不可信时的拒绝原因：patrol（后台巡逻）与 unknown（来源不可判定）必须可区分。 */
const CREDENTIAL_DENY_PATROL = 'credential-requires-user-present';
const CREDENTIAL_DENY_UNKNOWN = 'credential-source-unknown';
const CREDENTIAL_DENY_COOLDOWN = 'credential-cooldown';

const TOOL_PREFIX = 'mcp__xiaoheihe__';
const TOOL_SET = new Set(XHH_AUTHORIZE_TOOL_NAMES);
const READ_SET = new Set(XHH_AUTHORIZE_READ_TOOLS);
const SEARCH_TOOL = 'search_content';
const WRITE_KIND = Object.freeze({
  publish_content: 'post',
  publish_article: 'post',
  publish_video: 'post',
  post_comment: 'comment',
  reply_comment: 'comment',
});
const OUTCOMES = new Set(['success', 'failure', 'unknown']);
const MAX_OPERATION_ID_LENGTH = 200;
const AUDIT_KEYS = new Set([
  'type', 'at', 'tool', 'decision', 'reason', 'exemption', 'agentClass', 'outcome', 'controllerReason',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * task-64：把守卫快照归一成「是否全停 / 是否只停写」。
 * 判定刻意保守：snapshot 缺失、抛错、字段类型不对都按 all-paused 处理（fail-closed），
 * 绝不因为读不到状态就放行。degraded 视同 all-paused（重启不会抹掉这条降级语义）。
 */
function readIdentityGuardState(guard) {
  let snapshot;
  try {
    snapshot = guard.snapshot();
  } catch {
    return { allPaused: true, writesPaused: false };
  }
  if (!isPlainObject(snapshot)) return { allPaused: true, writesPaused: false };
  const state = typeof snapshot.effectiveState === 'string' && snapshot.effectiveState !== ''
    ? snapshot.effectiveState
    : snapshot.state;
  if (snapshot.degraded === true || state === 'all-paused') {
    return { allPaused: true, writesPaused: false };
  }
  return { allPaused: false, writesPaused: state === 'writes-paused' };
}

function isFiniteTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 统一工具名：接受短名或 `mcp__xiaoheihe__` 全名；不在 12 名单内返回 null。 */
function normalizeToolName(tool) {
  if (typeof tool !== 'string') return null;
  const short = tool.startsWith(TOOL_PREFIX) ? tool.slice(TOOL_PREFIX.length) : tool;
  return TOOL_SET.has(short) ? short : null;
}

function fullToolName(short) {
  return `${TOOL_PREFIX}${short}`;
}

function normalizeKeySet(value, label, { required }) {
  if (value === undefined || value === null) {
    if (required) throw new TypeError(`createXhhAuthorizeApi：${label} 必填`);
    return null;
  }
  const list = value instanceof Set ? [...value] : Array.isArray(value) ? value : null;
  if (list === null) throw new TypeError(`createXhhAuthorizeApi：${label} 必须是数组或 Set`);
  for (const key of list) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new TypeError(`createXhhAuthorizeApi：${label} 只能包含非空字符串`);
    }
  }
  return new Set(list);
}

function resolveClock(clock) {
  if (clock === undefined || clock === null) return () => Date.now();
  if (typeof clock === 'function') return () => clock();
  if (typeof clock === 'object' && typeof clock.now === 'function') return () => clock.now();
  throw new TypeError('createXhhAuthorizeApi：clock 必须是函数或带 now() 的对象');
}

function isOperationIdValid(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_OPERATION_ID_LENGTH;
}

function mapControllerReason(reason) {
  if (reason === 'invalid-id' || reason === 'invalid-kind' || reason === 'invalid-tool') return 'invalid-args';
  return typeof reason === 'string' && reason !== '' ? reason : 'controller-denied';
}

/**
 * 创建授权/回执处理器（纯逻辑 + 注入依赖）。
 *
 * @param {object} options
 * @param {object} options.controller 控制器接口（status/authorizeRead/authorizeWrite/finish 必填）
 * @param {string[]|Set<string>} options.backgroundSessionKeys 后台会话 agentKey 集合（必填）
 * @param {string[]|Set<string>} [options.userExemptAgents] 用户例外 agentKey 集合
 * @param {((event: object) => void)} [options.audit] 结构化审计回调
 * @param {(): Promise<unknown>} [options.persist] 状态持久化（授权/回执成功后 await；失败 fail-closed）
 * @param {(() => ({ blocked: boolean, reason?: string }))} [options.writeBlocker] 写门禁回调（未确认写入/
 *   通知未送达时，所有来源（含用户豁免）的写操作都必须被拒绝；读不经过此门禁）。
 * @param {(() => number) | { now?: () => number }} [options.clock]
 */
export function createXhhAuthorizeApi(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const controller = isPlainObject(source.controller) ? source.controller : null;
  if (
    controller === null
    || typeof controller.status !== 'function'
    || typeof controller.reserveRead !== 'function'
    || typeof controller.reserveWrite !== 'function'
    || typeof controller.commitTicket !== 'function'
    || typeof controller.abortTicket !== 'function'
    || typeof controller.finish !== 'function'
  ) {
    throw new TypeError('createXhhAuthorizeApi：controller 必须提供 status/reserveRead/reserveWrite/commitTicket/abortTicket/finish');
  }
  if (source.writeBlocker !== undefined && typeof source.writeBlocker !== 'function') {
    throw new TypeError('createXhhAuthorizeApi：writeBlocker 必须是函数');
  }
  if (source.persist !== undefined && typeof source.persist !== 'function') {
    throw new TypeError('createXhhAuthorizeApi：persist 必须是函数');
  }
  const writeBlocker = typeof source.writeBlocker === 'function' ? source.writeBlocker : null;
  // 只读门禁（默认 false）：true 时任何 agent（owner/group/background）的写工具一律 deny，
  // 读取/搜索与 QQ 汇报不受影响；拒绝发生在用户豁免/额度/票据之前，不触碰 controller。
  const readOnly = source.readOnly === true;
  if (source.readOnly !== undefined && typeof source.readOnly !== 'boolean') {
    throw new TypeError('createXhhAuthorizeApi：readOnly 必须是 boolean');
  }
  const agentKeyClassifier = typeof source.agentKeyClassifier === 'function' ? source.agentKeyClassifier : null;
  // task-49 来源门禁：provenanceClassifier 区分「后台巡逻(patrol) / 管理员(owner) / 群友(group)」，
  // 与 agentClass（是否计额）正交。不注入时保持旧行为（legacy 兼容），拒绝只发生在可信工具边界。
  if (source.provenanceClassifier !== undefined && typeof source.provenanceClassifier !== 'function') {
    throw new TypeError('createXhhAuthorizeApi：provenanceClassifier 必须是函数');
  }
  const provenanceClassifier = typeof source.provenanceClassifier === 'function' ? source.provenanceClassifier : null;
  // task-64：身份守卫（xiaoheihe-identity-guard）的生产消费点。guard 是纯状态机，本模块只读
  // snapshot() 做放行判定，不写状态、不发送通知。未注入时保持既有行为（旧部署可回退）。
  const identityGuard = isPlainObject(source.identityGuard) && typeof source.identityGuard.snapshot === 'function'
    ? source.identityGuard
    : null;
  if (source.identityGuard !== undefined && identityGuard === null) {
    throw new TypeError('createXhhAuthorizeApi：identityGuard 必须提供 snapshot()');
  }
  // 凭据桶（interactive_login / get_login_qr_code）完成后的归属通知：登录改变的是整机
  // 凭据（共享 cookie context），属安全事件，owner 必须有机会知道「谁在何时发起了登录」。
  // 未注入时保持既有行为；回调异常绝不影响回执（登录结果本身已由 complete 落审计）。
  const credentialNotify = typeof source.credentialNotify === 'function' ? source.credentialNotify : null;
  // A-2 降级只读层（xiaoheihe-degrade）：身份守卫不可用/身份来源不可判定时，本模块改判
  // 「写全拒、读放行但强制计入额度、凭据类拒绝」。semantics 全部由 degrade 模块持有（含
  // 落盘与 fail-closed），这里只读 snapshot() 做判定，绝不自行推断级别。
  // 未注入时保持既有行为（旧部署/旧调用方可回退）。
  const degrade = isPlainObject(source.degrade) && typeof source.degrade.snapshot === 'function'
    ? source.degrade
    : null;
  if (source.degrade !== undefined && degrade === null) {
    throw new TypeError('createXhhAuthorizeApi：degrade 必须提供 snapshot()');
  }

  // 控制台专栏配置（四个能力开关 + 只读模式）：任务是「服务端统一执行，不靠提示词」。
  // 注入的是**读快照的函数**而不是配置对象：保存后必须立即生效，不能等重启。
  const consoleSettings = typeof source.consoleSettings === 'function' ? source.consoleSettings : null;
  if (source.consoleSettings !== undefined && typeof source.consoleSettings !== 'function') {
    throw new TypeError('createXhhAuthorizeApi：consoleSettings 必须是返回配置对象的函数');
  }
  const backgroundSessionKeys = agentKeyClassifier === null
    ? normalizeKeySet(source.backgroundSessionKeys, 'backgroundSessionKeys', { required: true })
    : normalizeKeySet(source.backgroundSessionKeys, 'backgroundSessionKeys', { required: false }) ?? new Set();
  const userExemptAgents = normalizeKeySet(source.userExemptAgents, 'userExemptAgents', { required: false });
  const clock = resolveClock(source.clock);
  const audit = typeof source.audit === 'function' ? source.audit : null;
  const persist = typeof source.persist === 'function' ? source.persist : null;
  const apiId = `xhh-auth-${Math.random().toString(16).slice(2)}-${Date.now().toString(36)}`;

  function clockNow() {
    let value;
    try {
      value = clock();
    } catch {
      return null;
    }
    return isFiniteTimestamp(value) ? value : null;
  }

  function resolveNow(explicit) {
    if (explicit === undefined || explicit === null) return clockNow();
    return isFiniteTimestamp(explicit) ? explicit : null;
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
      // 审计回调异常不得影响授权结果。
    }
  }

  // 凭据桶整机冷却状态（group 来源）：null = 从未发起。刻意放在实例内而非模块级，
  // 免得同一进程里的多个 api 实例（测试夹具、影子实例）互相影响额度。
  let groupCredentialAt = null;

  // 降级只读态下必须计入额度的「平时免额读」工具（用户 2026-10-29 口径：
  // 身份不可靠时不允许用免额豁免逃过账本）。
  const DEGRADE_COUNTED_READS = new Set(['get_user_profile', 'check_login_status']);

  /**
   * 读取降级快照。查询自身抛错或返回非法形状一律按「全停」处理 —— 这是 fail-closed：
   * 身份层出问题时，宁可把小黑盒全部工具停掉，也不能当没事发生。
   * 未注入 degrade 时返回 null，保持旧行为。
   */
  function degradeSnapshot() {
    if (degrade === null) return null;
    let value;
    try {
      value = degrade.snapshot();
    } catch {
      value = null;
    }
    if (!isPlainObject(value) || typeof value.level !== 'string') {
      return { level: 'paused', trigger: null, blockWrite: true, blockAll: true, failClosed: true, queryFailed: true };
    }
    return {
      ...value,
      blockWrite: value.blockWrite === true || value.level !== 'normal',
      blockAll: value.blockAll === true || value.level === 'paused',
    };
  }

  function deny({ at, tool, agentClass, reason, controllerReason, exemption = null, hint, retryAfterMs }) {
    emitAudit({
      type: 'authorize',
      at,
      tool,
      decision: 'deny',
      reason,
      exemption,
      agentClass,
      ...(controllerReason === undefined ? {} : { controllerReason }),
    });
    return {
      ok: true,
      decision: 'deny',
      exemption,
      agentClass,
      reason,
      ...(controllerReason === undefined ? {} : { controllerReason }),
      // 提示与冷却剩余时间只回给调用方（智能体要照着提示行动、插件也可能展示），
      // 刻意不进 AUDIT_KEYS：审计要钉住「为何拒绝」的稳定契约，提示文案会随运维口味变。
      ...(typeof hint === 'string' && hint !== '' ? { hint } : {}),
      ...(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? { retryAfterMs } : {}),
    };
  }

  function allow({ at, tool, agentClass, exemption, counted, ticket, extra }) {
    emitAudit({
      type: 'authorize',
      at,
      tool,
      decision: 'allow',
      exemption,
      agentClass,
    });
    return {
      ok: true,
      decision: 'allow',
      exemption,
      agentClass,
      counted,
      ticket,
      ...(extra === undefined ? {} : extra),
    };
  }

  function classifyAgent(agentKey) {
    if (agentKeyClassifier !== null) {
      let classified;
      try {
        classified = agentKeyClassifier(agentKey);
      } catch {
        return 'unknown';
      }
      if (classified === 'background' || classified === 'user') return classified;
      return 'unknown';
    }
    if (backgroundSessionKeys.has(agentKey)) return 'background';
    if (userExemptAgents !== null && userExemptAgents.has(agentKey)) return 'user';
    return 'unknown';
  }

  /**
   * task-49：来源判定（与 agentClass 正交）。返回 'patrol' | 'owner' | 'group' | 'unknown'；
   * 未注入 provenanceClassifier 时返回 null，表示调用方未启用来源门禁（保持旧行为）。
   * 抛错/返回值不合法一律按 'unknown'（保守）。
   */
  function classifyProvenance(agentKey) {
    if (provenanceClassifier === null) return null;
    let classified;
    try {
      classified = provenanceClassifier(agentKey);
    } catch {
      return 'unknown';
    }
    if (classified === 'patrol' || classified === 'owner' || classified === 'group') return classified;
    return 'unknown';
  }

  /**
   * F1：controller 状态变更后落盘。失败（抛错或 {ok:false}）返回 false，
   * 调用方必须 fail-closed（不得放行未落盘额度）。
   */
  async function persistState() {
    if (persist === null) return true;
    try {
      const result = await persist();
      if (isPlainObject(result) && result.ok === false) return false;
      return true;
    } catch {
      return false;
    }
  }

  async function readPauseState() {
    let status;
    try {
      status = await controller.status();
    } catch {
      return { ok: false };
    }
    if (!isPlainObject(status)) return { ok: false };
    return {
      ok: true,
      accessPaused: status.accessPaused === true,
      writePaused: status.writePaused === true,
    };
  }

  /**
   * task-130：从 controller.finish 结果提取「暂停事件」字段（只保留安全相关的白名单字段）。
   * 暂停事件只在 action 真正造成写暂停状态转变时由 controller 返回 notify，API 原样透传，
   * 不自行推断、不把普通 success 当成「恢复」。恢复必须由调用方观测 status() 的真实状态变化
   * （writePaused true→false，通常来自管理员 adminRecover）来判定，本模块不产生 recovered 事件。
   */
  function pauseEventFields(source) {
    const fields = {};
    if (typeof source.notify === 'string' && source.notify !== '') fields.notify = source.notify;
    // task-132：暂停转换的稳定 id（用于通知按转换去重）；只接受契约字符集，非法值丢弃而不是外泄。
    if (typeof source.operationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(source.operationId)) {
      fields.operationId = source.operationId;
    }
    if (source.writePaused === true) fields.writePaused = true;
    if (typeof source.writeReason === 'string' && source.writeReason !== '') fields.writeReason = source.writeReason;
    if (Number.isInteger(source.consecutiveWriteFailures) && source.consecutiveWriteFailures >= 0) {
      fields.consecutiveWriteFailures = source.consecutiveWriteFailures;
    }
    return fields;
  }

  const MAX_ISSUED_TICKETS = 512;
  /** ticketId -> {agentKey, tool, kind, state, controllerTicket, startedTicket, pendingNotify?, pendingPause?} */
  const issuedTickets = new Map();

  function rememberIssued(ticket, meta) {
    issuedTickets.set(ticket.ticketId, { ...meta, controllerTicket: ticket.controllerTicket ?? ticket, state: 'reserved' });
    if (issuedTickets.size > MAX_ISSUED_TICKETS) {
      for (const [ticketId, entry] of issuedTickets) {
        if (issuedTickets.size <= MAX_ISSUED_TICKETS) break;
        if (entry.state === 'reserved' || entry.state === 'started') continue;
        issuedTickets.delete(ticketId);
      }
    }
  }

  function lookupIssued(ticket, agentKey) {
    if (!isPlainObject(ticket) || typeof ticket.ticketId !== 'string' || ticket.ticketId === '') return null;
    // 只认本实例签发的票据：ticketId 仅在 controller 内唯一，apiId 用于跨实例/他人票据隔离。
    if (ticket.apiId !== apiId) return null;
    const entry = issuedTickets.get(ticket.ticketId);
    if (entry === undefined) return null;
    if (typeof ticket.agentKey === 'string' && ticket.agentKey !== '' && entry.agentKey !== ticket.agentKey) return null;
    if (typeof agentKey === 'string' && agentKey !== '' && entry.agentKey !== agentKey) return null;
    return entry;
  }

  function mapTicketKind(shortTool, controllerKind) {
    if (controllerKind === 'read') return shortTool === SEARCH_TOOL ? 'read' : 'read';
    return controllerKind;
  }

  async function authorize(request) {
    const payload = isPlainObject(request) ? request : {};
    const at = resolveNow(payload.now);
    const agentClass = classifyAgent(typeof payload.agentKey === 'string' ? payload.agentKey : '');
    const shortTool = normalizeToolName(payload.tool);
    const auditTool = shortTool ?? (typeof payload.tool === 'string' ? payload.tool : null);

    if (at === null) {
      return deny({ at: clockNow(), tool: auditTool, agentClass, reason: 'invalid-clock' });
    }
    if (shortTool === null) {
      return deny({ at, tool: auditTool, agentClass, reason: 'unknown-tool' });
    }
    const args = payload.args === undefined ? {} : payload.args;
    if (!isPlainObject(args)) {
      return deny({ at, tool: shortTool, agentClass, reason: 'invalid-args' });
    }
    if (agentClass === 'unknown') {
      return deny({ at, tool: shortTool, agentClass, reason: 'unknown-agent' });
    }

    // task-64：身份守卫门禁。位置固定：unknown-agent 之后、暂停/只读/来源门禁之前。
    // · all-paused（或 degraded 半一致态）→ 读与写全拒：身份不可靠时任何授权决策都不可信。
    // · writes-paused → 写类工具拒绝、读/搜索放行（临时只读仍允许观察）。
    // degraded 是「限制增加但落盘失败」的内存态：重启会回到磁盘上的 normal，绝不能靠它自愈，
    // 所以这里必须把 degraded===true 视同 all-paused（task-67 P2-1/P2-2）。
    if (identityGuard !== null) {
      const guardState = readIdentityGuardState(identityGuard);
      if (guardState.allPaused) {
        return deny({ at, tool: shortTool, agentClass, reason: 'identity-guard-all-paused' });
      }
      if (guardState.writesPaused && hasOwn(WRITE_KIND, shortTool)) {
        return deny({ at, tool: shortTool, agentClass, reason: 'identity-guard-writes-paused' });
      }
    }

    // 暂停状态优先于额度/豁免：用户明确要求也不豁免安全暂停。
    const pause = await readPauseState();
    if (!pause.ok) {
      return deny({ at, tool: shortTool, agentClass, reason: 'controller-unavailable' });
    }
    const kind = WRITE_KIND[shortTool] ?? null;
    const isWrite = kind !== null;
    if (pause.accessPaused) {
      return deny({ at, tool: shortTool, agentClass, reason: 'access-paused' });
    }
    if (isWrite && pause.writePaused) {
      return deny({ at, tool: shortTool, agentClass, reason: 'write-paused' });
    }

    // ── A-2 降级只读层 ────────────────────────────────────────────────────────
    // 用户口径（2026-10-29）：身份守卫不可用/身份来源不可判定 ⇒ 小黑盒进入「降级只读」：
    //   写全拒 · 读放行但必须计入额度（不许走免额豁免）· 凭据类拒绝 · 全停时读写全拒。
    // 级别由 degrade 模块持有（含落盘与 fail-closed），本模块只读快照；查询失败按全停。
    const degradeState = degradeSnapshot();
    if (degradeState !== null && degradeState.blockAll === true) {
      return deny({ at, tool: shortTool, agentClass, reason: 'degrade-paused' });
    }
    const degradeReadOnly = degradeState !== null && degradeState.blockWrite === true;
    // 只读模式下写一律拒绝（owner/group/background 均不例外）：比下面的 readOnly 更严格，
    // 因为它来自「身份不可判定」，不能靠人工开关绕过。
    if (degradeReadOnly && isWrite) {
      return deny({ at, tool: shortTool, agentClass, reason: 'degrade-read-only' });
    }

    // ── 控制台专栏能力门禁（任务卡「能力开关与只读模式」）──────────────────────
    // 四个总开关 + 只读模式对**所有来源**生效（智能体自主、管理员/群友明确要求都不例外），
    // 所以位置固定在来源判定之前：一旦关闭，连 provenance 都不需要算。
    // 搜索归浏览开关管；登录类工具不在这四个开关范围内（走上面的凭据门禁）。
    if (consoleSettings !== null) {
      let snapshot = null;
      try {
        snapshot = consoleSettings();
      } catch {
        snapshot = null;
      }
      const capability = capabilityOfTool(shortTool);
      if (capability !== null) {
        // 读不到配置时按「最保守」处理：写一律拒绝；读保持可用（读不到配置不该让只读观察也瘫掉）。
        const verdict = snapshot === null
          ? (capability === 'browse' ? { allowed: true, reason: null } : { allowed: false, reason: 'console-settings-unavailable' })
          : decideCapability(snapshot, capability);
        if (!verdict.allowed) {
          return deny({ at, tool: shortTool, agentClass, reason: verdict.reason });
        }
      }
    }

    // 来源判定只算一次：凭据门禁与写门禁共用同一结果，避免两次调用 classifier 时因
    // 外部状态漂移而出现「凭据按 owner 放行、写入按 patrol 拒绝」的矛盾。
    const provenance = classifyProvenance(typeof payload.agentKey === 'string' ? payload.agentKey : '');

    // ── 凭据桶门禁（interactive_login / get_login_qr_code）─────────────────────────
    // 用户 2026-10-29 定案：这两个工具既不是读也不是写（isWrite=false），readOnly 与后台
    // 写门禁都管不到它们，必须独立判定；复用 readOnly 会静默放行登录流程。
    //   patrol / unknown→ 拒：无人值守回合会阻塞 120–180s、弹桌面窗口、还会把 cookies.json
    //                      整份覆盖（共享 context ⇒ 一次登录切换所有工具的运行身份），
    //                      且平台内容不可信，可被诱导发「先重新登录」。
    //   null             → 拒：调用方没启用来源判定时，**不得**再拿「旧兼容」当放行依据
    //                      （用户 2026-10-29 明确：来源不可判定 = unknown）。legacy 身份
    //                      模式正落在这条路径上，它必须和 patrol 一样被拒。
    //   owner            → 放行，不限次（用户亲自要求，扫码本身就是最强的人工因子）。
    //   group            → 放行，但整机 30 分钟最多 1 次，防一条群消息刷十个二维码。
    if (CREDENTIAL_SET.has(shortTool)) {
      const credentialSourceUnknown = provenance === null || provenance === 'unknown';
      if (provenance === 'patrol' || credentialSourceUnknown) {
        return deny({
          at,
          tool: shortTool,
          agentClass,
          // 两种来源的危险不同：patrol 是「无人值守回合自己发起」，
          // unknown 是「来源不可判定」。分开记，事后审计才查得清。
          reason: provenance === 'patrol' ? CREDENTIAL_DENY_PATROL : CREDENTIAL_DENY_UNKNOWN,
          hint: XHH_AUTHORIZE_CREDENTIAL_DENY_HINT,
        });
      }
      if (provenance === 'group') {
        if (groupCredentialAt !== null) {
          const elapsed = at - groupCredentialAt;
          if (elapsed < XHH_AUTHORIZE_CREDENTIAL_COOLDOWN_MS) {
            return deny({
              at,
              tool: shortTool,
              agentClass,
              reason: CREDENTIAL_DENY_COOLDOWN,
              hint: XHH_AUTHORIZE_CREDENTIAL_DENY_HINT,
              retryAfterMs: Math.max(1, XHH_AUTHORIZE_CREDENTIAL_COOLDOWN_MS - Math.max(0, elapsed)),
            });
          }
        }
        groupCredentialAt = at;
      }
    }

    // 只读模式：写操作一律拒绝（owner/group/background 均不例外），不 reserve/commit、不扣额度、
    // 不推进失败链；读/搜索不经过此分支，正常读取与 QQ 汇报不受影响。
    if (readOnly && isWrite) {
      return deny({ at, tool: shortTool, agentClass, reason: 'read-only-mode' });
    }
    // task-49 后台巡逻只读门禁：真实 F1 回合里 patrol 会话真的发出了一条评论
    // （controller buckets.comment.count=1）。patrol 来源的写工具一律拒绝，且发生在
    // writeBlocker/用户豁免/额度/票据之前：不 reserve/commit、不产生 controller 写计数、
    // 不签发可 commit 的写票据（否则插件仍会 dispatch），拒绝本身通过 deny 落审计。
    // owner/群友主动写不受影响；来源不可判定时 fail-closed，且与后台只读拒绝可区分。
    // provenance 已在上方「凭据桶门禁」前算好（只算一次），这里直接复用。
    if (isWrite && provenance === 'patrol') {
      return deny({ at, tool: shortTool, agentClass, reason: 'read-only-background' });
    }
    // task-58：防御性保留 —— 若 classifier 放宽，本分支是最后防线，**不得删除**。
    // 正常链路上未知 agentKey 会先在 classifyAgent 处被拒为 unknown-agent（即
    // 「provenance 严格度 ≤ agentClass 严格度」），所以这里平时不可达；它约束的是「将来有人
    // 把 unknown 放宽成 background」的情形。scripts/test-read-only-gate.mjs 的 task-58 不变量
    // 测试用两层场景钉住该顺序，删除本分支会直接变红。
    if (isWrite && provenance === 'unknown') {
      return deny({ at, tool: shortTool, agentClass, reason: 'unknown-source' });
    }

    // 未确认写入 / 通知未送达时，写操作对所有来源 fail-closed；读/搜索不受影响。
    // 门禁查询自身抛错也按阻塞处理（保守）。
    if (isWrite && writeBlocker !== null) {
      let blocked = true;
      let reason = 'write-blocked';
      try {
        const outcome = writeBlocker();
        if (isPlainObject(outcome) && typeof outcome.blocked === 'boolean' && typeof outcome.then !== 'function') {
          blocked = outcome.blocked !== false;
          if (typeof outcome.reason === 'string' && outcome.reason !== '') reason = outcome.reason;
        }
      } catch {
        blocked = true;
        reason = 'write-block-query-failed';
      }
      if (blocked) return deny({ at, tool: shortTool, agentClass, reason });
    }

    // F-A：用户豁免先于写操作 operationId 校验（暂停检查仍在最前）。
    // 真实小黑盒写工具没有 operationId 参数，用户主动发帖/评论不能被 invalid-args 拒绝。
    // 凭据类（登录/二维码）**不参与**这条提前返回：豁免票据在插件侧不经过 commit/complete，
    // 生命周期根本不存在，登录归属通知就永远发不出去（A-1 独立复审的 P1）。它们改走
    // 下方 misc 分支 —— 一样不计额度，但有可追踪的 commit/complete。
    if (agentClass === 'user' && !CREDENTIAL_SET.has(shortTool)) {
      return allow({
        at,
        tool: shortTool,
        agentClass,
        exemption: 'user',
        counted: false,
        ticket: {
          apiId,
          kind: 'exempt',
          tool: fullToolName(shortTool),
          agentKey: payload.agentKey,
          at,
          // 标记是否凭据类：仅用于审计与排障，不再触发豁免分支的通知（凭据类已不走这里）。
          credential: CREDENTIAL_SET.has(shortTool),
        },
      });
    }

    let operationId = null;
    if (isWrite) {
      if (!isOperationIdValid(args.operationId)) {
        return deny({ at, tool: shortTool, agentClass, reason: 'invalid-args' });
      }
      operationId = args.operationId;
    }

    // ── 后台会话：reserve（预占），不计数；commit 才计数 ────────────────────
    const fullTool = fullToolName(shortTool);
    if (READ_SET.has(shortTool) || shortTool === SEARCH_TOOL || (degradeReadOnly && DEGRADE_COUNTED_READS.has(shortTool))) {
      // 降级只读态：连「平时免额」的 search / get_user_profile / check_login_status
      // 也强制占一次读额度（forceCount），否则身份不可靠时账本会被免额豁免架空。
      const forceCount = degradeReadOnly
        && (shortTool === SEARCH_TOOL || DEGRADE_COUNTED_READS.has(shortTool));
      let result;
      try {
        result = await controller.reserveRead({
          tool: fullTool,
          now: at,
          ...(forceCount ? { forceCount: true } : {}),
          ...(shortTool === SEARCH_TOOL || args.id === undefined ? {} : { id: args.id }),
        });
      } catch {
        return deny({ at, tool: shortTool, agentClass, reason: 'controller-unavailable' });
      }
      if (!isPlainObject(result)) {
        return deny({ at, tool: shortTool, agentClass, reason: 'controller-unavailable' });
      }
      if (result.ok !== true) {
        const controllerReason = mapControllerReason(result.reason);
        return deny({ at, tool: shortTool, agentClass, reason: controllerReason, controllerReason: result.reason });
      }
      const controllerTicket = result.ticket;
      const ticket = {
        apiId,
        kind: 'read',
        tool: fullTool,
        agentKey: payload.agentKey,
        at,
        state: 'reserved',
        counted: controllerTicket.counted !== false,
        ticketId: controllerTicket.ticketId,
        opId: controllerTicket.opId ?? null,
        controllerTicket,
      };
      rememberIssued(ticket, { agentKey: payload.agentKey, tool: shortTool, kind: 'read' });
      return allow({
        at,
        tool: shortTool,
        agentClass,
        exemption: 'quota',
        counted: false,
        ticket,
        extra: result.remaining === undefined ? undefined : { remaining: result.remaining },
      });
    }

    if (isWrite) {
      let result;
      try {
        result = await controller.reserveWrite({ kind, id: operationId, now: at });
      } catch {
        return deny({ at, tool: shortTool, agentClass, reason: 'controller-unavailable' });
      }
      if (!isPlainObject(result)) {
        return deny({ at, tool: shortTool, agentClass, reason: 'controller-unavailable' });
      }
      if (result.ok !== true) {
        const controllerReason = mapControllerReason(result.reason);
        return deny({ at, tool: shortTool, agentClass, reason: controllerReason, controllerReason: result.reason });
      }
      const controllerTicket = result.ticket;
      const ticket = {
        apiId,
        kind,
        tool: fullTool,
        agentKey: payload.agentKey,
        at,
        state: 'reserved',
        counted: true,
        ticketId: controllerTicket.ticketId,
        opId: controllerTicket.opId ?? operationId,
        controllerTicket,
      };
      rememberIssued(ticket, { agentKey: payload.agentKey, tool: shortTool, kind });
      return allow({
        at,
        tool: shortTool,
        agentClass,
        exemption: 'quota',
        counted: false,
        ticket,
        extra: {
          ...(result.used === undefined ? {} : { used: result.used }),
          ...(result.limit === undefined ? {} : { limit: result.limit }),
        },
      });
    }

    // 登录/资料/二维码：不占额度，但 accessPaused 已在上方拒绝；不打 controller 票据。
    // task-129：仍须签发带 ticketId 的票据并登记，否则 DSH 插件按 missing-ticket 拒绝，
    // 登录/资料/二维码工具在插件启用后不可用。misc 的 commit/abort 为空操作（不计数、不持久化）。
    const miscTicket = {
      apiId,
      kind: 'misc',
      tool: fullToolName(shortTool),
      agentKey: payload.agentKey,
      at,
      state: 'reserved',
      counted: false,
      ticketId: `misc-${randomUUID()}`,
      // 凭据类票据要能被 complete 认出来，才能走「登录归属通知」；普通 misc（资料/登录状态）
      // 不发通知，避免噪声。
      credential: CREDENTIAL_SET.has(shortTool),
    };
    rememberIssued(miscTicket, {
      agentKey: payload.agentKey,
      tool: shortTool,
      kind: 'misc',
      credential: CREDENTIAL_SET.has(shortTool),
    });
    return allow({
      at,
      tool: shortTool,
      agentClass,
      exemption: 'quota',
      counted: false,
      ticket: miscTicket,
    });
  }

  let commitQueue = Promise.resolve();
  function commit(request) {
    const result = commitQueue.then(() => commitInternal(request));
    commitQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function commitInternal(request) {
    const payload = isPlainObject(request) ? request : {};
    const at = resolveNow(payload.now);
    if (at === null) return { ok: false, reason: 'invalid-clock' };
    const entry = lookupIssued(payload.ticket, payload.agentKey);
    if (entry === null) return { ok: false, reason: 'invalid-ticket' };
    if (entry.state === 'started') return { ok: true, started: true, already: true, ticket: entry.startedApiTicket ?? payload.ticket };
    if (entry.state === 'aborted') return { ok: false, reason: 'ticket-aborted' };
    // F2：finish/unknown 之后不得再 started（否则同一票据可再执行一次而额度只计一次）。
    if (entry.state === 'finished' || entry.state === 'unknown' || entry.state === 'persist-pending') {
      return { ok: false, reason: 'already-finished' };
    }

    // task-129：misc 不占额度、无 controller 票据；commit 仅把票据标记 started（空操作、不持久化），
    // 让插件契约（allow→commit→dispatch→complete）成立。
    if (entry.kind === 'misc') {
      entry.state = 'started';
      const startedApiTicket = { ...payload.ticket, state: 'started', startedAt: at };
      entry.startedApiTicket = startedApiTicket;
      return { ok: true, started: true, ticket: startedApiTicket };
    }

    // 终审①：authorize→commit 之间若出现未确认写 / 提交未送达 / 持久故障，commit 也必须拒绝
    // （票据保持 reserved，可 abort 或重试）。读与 misc 不在此校验。
    if (entry.kind !== 'read' && writeBlocker !== null) {
      let blocked = true;
      let reason = 'write-blocked';
      try {
        const outcome = writeBlocker();
        if (isPlainObject(outcome) && typeof outcome.blocked === 'boolean' && typeof outcome.then !== 'function') {
          blocked = outcome.blocked !== false;
          if (typeof outcome.reason === 'string' && outcome.reason !== '') reason = outcome.reason;
        }
      } catch {
        blocked = true;
        reason = 'write-block-query-failed';
      }
      if (blocked) return { ok: false, reason };
    }
    let result;
    try {
      result = await controller.commitTicket(entry.controllerTicket, { now: at });
    } catch {
      return { ok: false, reason: 'controller-unavailable' };
    }
    if (!isPlainObject(result)) return { ok: false, reason: 'controller-unavailable' };
    if (result.ok !== true) return { ok: false, reason: mapControllerReason(result.reason), controllerReason: result.reason };
    if (!(await persistState())) {
      // 落盘失败不得放行：回滚刚提交的额度，票据回到 reserved（调用方可重试/abort）。
      try {
        await controller.abortTicket(result.ticket, { now: at });
      } catch {
        // 回滚失败也不放行；调用方看到 persist-failed 必须 deny。
      }
      entry.state = 'reserved';
      entry.startedTicket = null;
      return { ok: false, reason: 'persist-failed' };
    }
    entry.state = 'started';
    entry.startedTicket = result.ticket;
    if (entry.kind === 'read' && result.counted === true && Number.isSafeInteger(result.used)) {
      entry.readIndex = result.used;
      entry.readStartedAt = at;
    }
    // 关键：返回给调用方的票据必须仍是**本 API 签发的票据**（带 apiId/ticketId/agentKey），
    // 否则插件把 controller 票据回传 complete/abort 时 lookupIssued 找不到 → unknown-ticket。
    // controller 票据只保存在 entry.startedTicket 内部，供 finish/abort 使用。
    const startedApiTicket = { ...payload.ticket, state: 'started', startedAt: at };
    entry.startedApiTicket = startedApiTicket;
    return {
      ok: true,
      started: true,
      ticket: startedApiTicket,
      ...(result.used === undefined ? {} : { used: result.used }),
      ...(result.limit === undefined ? {} : { limit: result.limit }),
      ...(result.remaining === undefined ? {} : { remaining: result.remaining }),
    };
  }

  async function abort(request) {
    const payload = isPlainObject(request) ? request : {};
    const at = resolveNow(payload.now);
    if (at === null) return { ok: false, reason: 'invalid-clock' };
    const entry = lookupIssued(payload.ticket, payload.agentKey);
    if (entry === null) return { ok: false, reason: 'invalid-ticket' };
    // F1：complete 之后只允许 reserved|started 回滚；finished/unknown 拒绝且绝不调 controller（防退款绕过）。
    if (entry.state === 'finished' || entry.state === 'unknown' || entry.state === 'persist-pending') {
      return { ok: false, reason: 'already-finished' };
    }
    if (entry.state === 'aborted') {
      return { ok: true, aborted: true, already: true, rolledBack: entry.rolledBack === true };
    }

    // task-129：misc 不占额度，abort 为空操作（无 controller 票据可回滚）。
    if (entry.kind === 'misc') {
      entry.state = 'aborted';
      return { ok: true, aborted: true, rolledBack: false };
    }

    let result;
    try {
      result = await controller.abortTicket(entry.state === 'started' ? (entry.startedTicket ?? payload.ticket) : entry.controllerTicket, { now: at });
    } catch {
      return { ok: false, reason: 'controller-unavailable' };
    }
    if (!isPlainObject(result)) return { ok: false, reason: 'controller-unavailable' };
    if (result.ok !== true) return { ok: false, reason: mapControllerReason(result.reason), controllerReason: result.reason };
    entry.state = 'aborted';
    if (result.rolledBack === true && !(await persistState())) {
      return { ok: false, reason: 'persist-failed', rolledBack: true };
    }
    return {
      ok: true,
      aborted: true,
      already: result.already === true,
      rolledBack: result.rolledBack === true,
    };
  }

  async function complete(request) {
    const payload = isPlainObject(request) ? request : {};
    const at = resolveNow(payload.now);
    if (at === null) return { ok: false, reason: 'invalid-clock' };
    const ticket = payload.ticket;
    if (!isPlainObject(ticket) || ticket.apiId !== apiId) {
      return { ok: false, reason: 'unknown-ticket' };
    }
    const outcome = payload.outcome;
    if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) {
      return { ok: false, reason: 'invalid-outcome' };
    }
    const tool = typeof ticket.tool === 'string' ? ticket.tool : null;

    if (ticket.kind === 'exempt') {
      emitAudit({ type: 'complete', at, tool, outcome });
      // 凭据类不走这条分支：authorize 里凭据工具被显式排除在「用户豁免提前返回」之外，
      // 一律发 misc 票据（一样不计额度，但有 commit/complete 生命周期）。这里刻意不发
      // 归属通知 —— 豁免票据没有终态跟踪，重复 complete 会把同一次登录报两遍。
      return { ok: true, completed: false, exempt: true, outcome };
    }
    if (ticket.kind === 'misc') {
      // task-129 复审 P2-1：misc 票据在 complete 后必须进入终态。否则 issuedTickets 的驱逐
      //（只回收非 reserved/started 条目）永远不会回收 misc 条目，512 上限对其形同虚设；
      // 终态同时保证重复 commit 被拒绝（与 read/write 终态语义一致）。misc 依旧不 persist。
      const miscEntry = lookupIssued(ticket, payload.agentKey);
      // 只有「本次才让它进入终态」的那一次 complete 才算数：重复 complete 不得重复通知
      //（复审 P2-6：通知被 await 且幂等分支也会走到，会把同一次登录报两遍）。
      const firstTerminal = miscEntry !== null && miscEntry.state !== 'finished' && miscEntry.state !== 'unknown';
      if (firstTerminal) {
        miscEntry.state = outcome === 'unknown' ? 'unknown' : 'finished';
      }
      emitAudit({ type: 'complete', at, tool, outcome });
      // 凭据类（interactive_login / get_login_qr_code）：登录改变的是整机凭据（共享 cookie
      // context），必须让 owner 能追溯「谁在何时发起了登录、结果如何」。通知是旁路：
      // 抛错不得改变回执，因为票据已经终结，回执是既成事实。
      if (firstTerminal && miscEntry.credential === true && credentialNotify !== null) {
        try {
          await credentialNotify({
            tool: typeof miscEntry.tool === 'string' ? miscEntry.tool : tool,
            outcome,
            at,
            agentKey: typeof miscEntry.agentKey === 'string' ? miscEntry.agentKey : null,
          });
        } catch {
          // 通知失败不影响登录结果本身；审计已由 emitAudit 落盘。
        }
      }
      return { ok: true, completed: false, ignored: true, outcome };
    }

    // F4：complete 也绑定 agentKey（提供时）；不提供保持兼容。
    if (payload.agentKey !== undefined && payload.agentKey !== null
      && (typeof payload.agentKey !== 'string' || payload.agentKey !== ticket.agentKey)) {
      return { ok: false, reason: 'invalid-ticket' };
    }
    const entry = lookupIssued(ticket, payload.agentKey);
    if (entry === null) return { ok: false, reason: 'unknown-ticket' };
    if (payload.agentKey !== undefined && payload.agentKey !== null
      && (typeof payload.agentKey !== 'string' || payload.agentKey !== entry.agentKey)) {
      return { ok: false, reason: 'invalid-ticket' };
    }
    if (entry.state === 'reserved') return { ok: false, reason: 'not-started' };
    if (entry.state === 'aborted') return { ok: false, reason: 'invalid-ticket' };

    // F3：上次 finish 成功但 persist 失败 → 重试只补 persist，不重复 finish。
    if (entry.state === 'persist-pending') {
      if (!(await persistState())) return { ok: false, reason: 'persist-failed' };
      const pendingOutcome = entry.pendingOutcome ?? outcome;
      // task-130：暂停事件随重试一起交付，且只交付一次（交付后清空，重复回执不再带 notify）。
      const pendingPause = isPlainObject(entry.pendingPause) ? entry.pendingPause : {};
      emitAudit({ type: 'complete', at, tool, outcome: pendingOutcome });
      entry.state = pendingOutcome === 'unknown' ? 'unknown' : 'finished';
      entry.persistPending = false;
      entry.pendingNotify = null;
      entry.pendingPause = null;
      return {
        ok: true,
        completed: true,
        outcome: pendingOutcome,
        unknown: pendingOutcome === 'unknown',
        ...pendingPause,
      };
    }

    if (ticket.kind === 'read') {
      // 已完成的读取回执不可被重放改写结果；汇报必须依据首次实际结果。
      if (entry.state === 'finished' || entry.state === 'unknown') {
        return { ok: true, completed: false, ignored: true, already: true, outcome: entry.outcome };
      }
      // F1：读 complete 必须把 entry 置 finished/unknown，之后 abort 被 already-finished 拒绝。
      entry.state = outcome === 'unknown' ? 'unknown' : 'finished';
      entry.finishedAt = at;
      entry.outcome = outcome;
      // 额度口径（m33778，最终定论）：以**是否已实际向平台发起调用**为界。
      //  · 已经发起 —— 即使平台返回失败也计数（读的额度在 commit 时已扣，这里不退还）；
      //  · 发起前失败 —— 不计数，退还走 abort 路径（插件在 dispatch 前用
      //    ABORTED_BEFORE_DISPATCH / UNKNOWN_TOOL 调 abortTicket，本 API 的 abort() 负责回滚）。
      //
      // 所以 complete(outcome='failure') **绝不退还**：能走到 complete 就说明 execute 已经
      // 派发过（插件只在派发前中止时才 abort，其余一律 finish('failure')）。此处曾按 m31637
      // 的「派发失败退还」做退款，被 m33778 判定为违反口径 —— 未知结果更不能当成功处理。
      emitAudit({ type: 'complete', at, tool, outcome });
      return { ok: true, completed: false, ignored: true, outcome,
        ...(Number.isSafeInteger(entry.readIndex) ? { readIndex: entry.readIndex, readStartedAt: entry.readStartedAt } : {}) };
    }

    let result;
    try {
      result = await controller.finish(entry.startedTicket ?? ticket, { outcome, now: at });
    } catch {
      return { ok: false, reason: 'controller-unavailable' };
    }
    if (!isPlainObject(result)) return { ok: false, reason: 'controller-unavailable' };
    if (result.ok === true) {
      // task-130：暂停事件（第三次明确写失败触发的 write-failures）必须与「状态已落盘」一起交付；
      // 落盘失败时只保存到 entry，重试 persist 成功后再交付一次，绝不提前泄漏。
      let pauseFields = pauseEventFields(result);
      if (pauseFields.notify !== undefined) {
        // controller.finish 只返回 writePaused/notify；writeReason/失败链长度用只读 status() 补齐。
        // 读不到就只交付已有字段（不猜测），绝不因为补字段失败而放行或改判。
        try {
          const snapshot = await controller.status();
          if (isPlainObject(snapshot)) {
            if (typeof snapshot.writeReason === 'string' && snapshot.writeReason !== '') {
              pauseFields.writeReason = snapshot.writeReason;
            }
            if (Number.isInteger(snapshot.consecutiveWriteFailures) && snapshot.consecutiveWriteFailures >= 0) {
              pauseFields.consecutiveWriteFailures = snapshot.consecutiveWriteFailures;
            }
            if (snapshot.writePaused === true) pauseFields.writePaused = true;
          }
        } catch {
          // 状态快照失败不阻断事件交付（已含 notify/writePaused）。
        }
      }
      if (!(await persistState())) {
        // F3：controller 已 finish，但落盘失败；标记 persistPending，重试时只补 persist。
        entry.state = 'persist-pending';
        entry.persistPending = true;
        entry.pendingOutcome = outcome;
        entry.pendingNotify = pauseFields.notify ?? null;
        entry.pendingPause = pauseFields;
        entry.finishedAt = at;
        return { ok: false, reason: 'persist-failed' };
      }
      emitAudit({ type: 'complete', at, tool, outcome });
      entry.state = outcome === 'unknown' ? 'unknown' : 'finished';
      entry.pendingNotify = null;
      entry.pendingPause = null;
      return {
        ok: true,
        completed: result.already !== true,
        already: result.already === true,
        outcome,
        unknown: outcome === 'unknown',
        ...pauseFields,
      };
    }
    if (result.reason === 'already-finished') {
      if (entry.persistPending === true && !(await persistState())) {
        return { ok: false, reason: 'persist-failed' };
      }
      emitAudit({ type: 'complete', at, tool, outcome });
      entry.persistPending = false;
      entry.state = outcome === 'unknown' ? 'unknown' : 'finished';
      return { ok: true, completed: false, already: true, outcome };
    }
    if (result.reason === 'unknown-operation') {
      return { ok: false, reason: 'unknown-ticket' };
    }
    emitAudit({ type: 'complete', at, tool, outcome, reason: mapControllerReason(result.reason) });
    return { ok: false, reason: mapControllerReason(result.reason), controllerReason: result.reason };
  }

  /**
   * task-130：只读状态快照（供 bridge 比对真实暂停/恢复变化）。
   * 白名单字段：writePaused/writeReason/consecutiveWriteFailures/accessPaused/accessReason；
   * 不返回额度用量、操作 id、ticket、token。controller 异常 → {ok:false}（fail-closed，不猜状态）。
   */
  async function status() {
    let snapshot;
    try {
      snapshot = await controller.status();
    } catch {
      return { ok: false, reason: 'controller-unavailable' };
    }
    if (!isPlainObject(snapshot)) return { ok: false, reason: 'controller-unavailable' };
    const result = {
      ok: true,
      writePaused: snapshot.writePaused === true,
      accessPaused: snapshot.accessPaused === true,
    };
    if (typeof snapshot.writeReason === 'string' && snapshot.writeReason !== '') result.writeReason = snapshot.writeReason;
    if (typeof snapshot.accessReason === 'string' && snapshot.accessReason !== '') result.accessReason = snapshot.accessReason;
    if (Number.isInteger(snapshot.consecutiveWriteFailures) && snapshot.consecutiveWriteFailures >= 0) {
      result.consecutiveWriteFailures = snapshot.consecutiveWriteFailures;
    }
    return result;
  }

  return { authorize, commit, abort, complete, status };
}

