/**
 * 后台巡逻步骤 D：贴吧请求边界钩子与唯一账本的纯适配器。
 *
 * 背景：`src/tieba-lib.js` 已提供可选 `onBeforeTiebaRequest` 钩子（在参数、节流判定之后、真正 fetch
 * 之前 await；钩子抛错或返回 false / {ok:false} 即阻止本次抓取）。本模块把「钩子约定」与
 * `src/core/tieba-patrol-ledger.mjs` 的自主访问账本对接逻辑。
 *
 * 用法（未来接线形态）：
 *   const adapter = createTiebaPatrolAdapter({ ledger });          // 自主巡逻：默认 reason='patrol'
 *   await fetchThreadPages(tid, { pages:'1-3', onBeforeTiebaRequest: adapter });
 *   // 一次多页工具调用只调用钩子一次 ⇒ 账本只 +1。
 *   const userAdapter = createTiebaPatrolAdapter({ ledger, reasonOf: () => 'user' });
 *   await fetchBarPage(bar, 1, { onBeforeTiebaRequest: userAdapter });  // 用户明确查询：不调用 ledger。
 *
 * 返回值：一个与 tieba-lib 钩子兼容的 async 函数（无参调用即可）；另有扩展方法：
 *   · `hook({ reason?, operationId? })` —— 可选上下文（tieba-lib 不会传，但未来接线/测试可用）；
 *   · `hook.forOperation({ operationId, reason? })` —— 绑定一个**稳定 operation id**，返回零参钩子；
 *     上游重试复用同一个绑定钩子时只扣一次（允许继续抓取，但不再预留）；
 *   · `hook.lastDecision()` / `hook.snapshot()` —— 只读副本，供审计/排查（不含正文/凭据）。
 *
 * 语义（fail-closed）：
 *  1. reason='patrol'（缺省）：每个**新逻辑请求**调用一次 `ledger.reserve({reason:'patrol', at?})`；
 *     账本返回 ok → 放行 `{ok:true, counted:true, used, limit, remaining}`；
 *     账本返回 daily-cap/其它拒绝 → 返回 `{ok:false, reason, message}`（tieba-lib 会据此零抓取）；
 *     账本抛错、返回 undefined/null、`ok` 不是布尔 → 一律当 `ledger-unavailable` 拒绝，绝不当作放行。
 *  2. reason='user'：**完全不调用 ledger**（不占自主额度、额度已满也放行，账本故障也不影响用户查询）。
 *  3. 重试去重：只有带 operationId 的调用才去重（允许路径重复触发 → 不再预留；已拒绝的操作重复触发 →
 *     仍是同一拒绝，不重复请求账本）。**无 operationId 的调用一律视为新的逻辑请求**——这是保守方向：
 *     宁可多计一次，也不能因为误去重而放行超出额度的访问。去重表上限 256，超出淘汰最旧已结束操作。
 *  4. 非法 reason / operationId / context / 注入时钟 → 抛带 code 的错误（tieba-lib 会把它转成拒绝，
 *     零抓取），不会静默放行。
 *  5. 日上限可配置（task-15）：options.limit 固定值或 options.limitOf() 动态值（每次 patrol reserve 时求值），
 *     合法范围 0..99；非法（含 limitOf 抛错）时**不调用 ledger**，返回
 *     `{ok:false, reason:'invalid-limit', message}`（fail-closed，绝不当作放行）。
 *     未配置时不向 ledger 传 limit，沿用账本默认/实例上限；上限只做判定，不写盘、不影响当天 used。
 *
 * 已知限制（如实标注）：
 *  · tieba-lib 现有钩子调用是 `hook()` 无参，因此**无法**在这一层自动识别「同一次工具调用的上游重试」；
 *    要做到重试不重复扣，接线方必须为每个逻辑请求生成稳定 operationId 并用 `forOperation` 绑定
 *    （例如 bridge 侧按「后台巡逻回合 + 工具调用序号」生成）；
 *  · 去重表是单进程内存态，不跨进程/不跨重启（跨重启的「同 id 不重发」由账本持久化与调用方 id 保证）；
 *  · 拒绝原因只能通过 `lastDecision()`/返回值读到；经 tieba-lib 时它按既有安全约定只返回固定文案；
 *  · 本模块不发送通知、不写审计；审计由 background-patrol-audit 接线时另行调用。
 */

import { TIEBA_PATROL_MIN_DAILY_CAP, TIEBA_PATROL_MAX_DAILY_CAP } from './tieba-patrol-ledger.mjs';

/** 允许的 reason 取值（冻结）：patrol=自主访问（计额度）；user=用户明确查询（不占额度）。 */
export const TIEBA_PATROL_ADAPTER_REASONS = Object.freeze(['patrol', 'user']);

/** operationId 去重表上限（防内存无限增长）。 */
export const TIEBA_PATROL_ADAPTER_MAX_OPERATIONS = 256;

const REASON_SET = new Set(TIEBA_PATROL_ADAPTER_REASONS);
const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_OPERATION_ID_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 200;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createError(message, code, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function safeErrorCode(error) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined;
  return typeof code === 'string' && code.trim() !== '' ? code.slice(0, 64) : 'UNKNOWN';
}

/** 日上限合法性：[0, 99] 的整数（与账本同一区间；拒绝 NaN/Infinity/小数/字符串/null 等）。 */
function isAdapterLimit(value) {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= TIEBA_PATROL_MIN_DAILY_CAP
    && value <= TIEBA_PATROL_MAX_DAILY_CAP;
}

/** 错误/拒绝文案里安全展示非法配置值。 */
function describeValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function cloneDecision(decision) {
  return decision === null || decision === undefined ? null : { ...decision };
}

/**
 * 创建贴吧请求边界适配器。
 *
 * @param {object} options
 * @param {{ reserve: Function }} options.ledger 自主访问唯一账本（如 createTiebaPatrolLedger 的实例）
 * @param {() => number} [options.now] 可注入时钟；提供时把解析后的 at 传给 ledger.reserve
 * @param {() => ('patrol'|'user')} [options.reasonOf] 每次无参调用时决定 reason；缺省 'patrol'
 * @param {number} [options.limit] 固定日上限（整数 0..99）；与 limitOf 二选一；非法抛 TypeError
 * @param {() => number} [options.limitOf] 动态日上限：每次 patrol reserve 时求值（0..99），非法 fail-closed
 * @returns {Function} 与 onBeforeTiebaRequest 兼容的 async 函数（附带 forOperation/lastDecision/snapshot）
 */
export function createTiebaPatrolAdapter(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const { ledger, now, reasonOf, limit, limitOf } = source;

  if (ledger === null || typeof ledger !== 'object' || typeof ledger.reserve !== 'function') {
    throw new TypeError('createTiebaPatrolAdapter: options.ledger 必须是带 reserve() 的账本实例');
  }
  if (now !== undefined && typeof now !== 'function') {
    throw new TypeError('createTiebaPatrolAdapter: options.now 必须是函数');
  }
  if (reasonOf !== undefined && typeof reasonOf !== 'function') {
    throw new TypeError('createTiebaPatrolAdapter: options.reasonOf 必须是函数');
  }
  if (limit !== undefined && limitOf !== undefined) {
    throw new TypeError('createTiebaPatrolAdapter: options.limit 与 options.limitOf 只能二选一');
  }
  if (limit !== undefined && !isAdapterLimit(limit)) {
    throw new TypeError(
      `createTiebaPatrolAdapter: options.limit 必须是 ${TIEBA_PATROL_MIN_DAILY_CAP}..${TIEBA_PATROL_MAX_DAILY_CAP} 的整数`
      + `（收到 ${describeValue(limit)}，绝不静默降级）`,
    );
  }
  if (limitOf !== undefined && typeof limitOf !== 'function') {
    throw new TypeError('createTiebaPatrolAdapter: options.limitOf 必须是函数');
  }

  /** opId -> { status:'in-flight'|'allowed'|'denied', promise, result } */
  const operations = new Map();
  const decisions = { allowed: 0, denied: 0, user: 0 };
  let lastDecision = null;

  function resolveReason(context) {
    let reason;
    if (isPlainObject(context) && context.reason !== undefined) reason = context.reason;
    else if (typeof reasonOf === 'function') reason = reasonOf();
    else reason = 'patrol';
    if (typeof reason !== 'string' || !REASON_SET.has(reason)) {
      throw createError(
        `贴吧巡逻适配器：reason 必须是 ${TIEBA_PATROL_ADAPTER_REASONS.join('/')} 之一（未知原因 fail-closed）`,
        'TIEBA_PATROL_ADAPTER_INVALID_REASON',
      );
    }
    return reason;
  }

  function resolveOperationId(context) {
    if (!isPlainObject(context) || !Object.prototype.hasOwnProperty.call(context, 'operationId') || context.operationId === undefined) {
      return null;
    }
    const operationId = context.operationId;
    if (
      typeof operationId !== 'string'
      || operationId.length === 0
      || operationId.length > MAX_OPERATION_ID_LENGTH
      || !OPERATION_ID_RE.test(operationId)
    ) {
      throw createError(
        '贴吧巡逻适配器：operationId 必须是 1..128 字的稳定 id（[A-Za-z0-9._:-]）',
        'TIEBA_PATROL_ADAPTER_INVALID_OPERATION_ID',
      );
    }
    return operationId;
  }

  function resolveAt() {
    if (typeof now !== 'function') return undefined;
    const value = now();
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw createError('贴吧巡逻适配器：now() 必须返回有限毫秒时间戳', 'TIEBA_PATROL_ADAPTER_INVALID_CLOCK');
    }
    return value;
  }

  /**
   * 求值本次 patrol reserve 的有效上限（动态 limitOf 每次调用重新求值）：
   *  · 未配置 limit/limitOf → { ok:true, value:null }：不向 ledger 传 limit，沿用账本默认/实例值；
   *  · limitOf 返回非法值或抛错 → { ok:false, detail }：调用方 fail-closed，且**绝不调用 ledger**。
   */
  function evaluateLimit() {
    if (typeof limitOf === 'function') {
      let value;
      try {
        value = limitOf();
      } catch (error) {
        return { ok: false, detail: `limitOf() 抛出错误（${safeErrorCode(error)}）` };
      }
      if (!isAdapterLimit(value)) return { ok: false, detail: `limitOf() 返回了非法值 ${describeValue(value)}` };
      return { ok: true, value };
    }
    return { ok: true, value: limit === undefined ? null : limit };
  }

  function remember(decision) {
    lastDecision = cloneDecision(decision);
  }

  function deny(reason, message, operationId, extras = null) {
    const decision = { ok: false, reason, message, operationId: operationId ?? null };
    // 账本拒绝（如 daily-cap）时也透传 used/limit/remaining，便于审计「为什么拒绝」。
    if (isPlainObject(extras)) {
      if (typeof extras.used === 'number') decision.used = extras.used;
      if (typeof extras.limit === 'number') decision.limit = extras.limit;
      if (typeof extras.remaining === 'number') decision.remaining = extras.remaining;
    }
    decisions.denied += 1;
    remember(decision);
    return decision;
  }

  /**
   * 真正向账本预留一次（不做去重）。任何账本异常都映射成可读拒绝，绝不返回 ok:true。
   * `effectiveLimit` 为 null 表示适配器未配置上限（不向账本传 limit）。
   */
  async function reserveOnce(operationId, at, effectiveLimit) {
    const request = { reason: 'patrol' };
    if (at !== undefined) request.at = at;
    if (effectiveLimit !== null) request.limit = effectiveLimit;
    let ledgerResult;
    try {
      ledgerResult = await ledger.reserve(request);
    } catch (error) {
      return deny(
        'ledger-unavailable',
        `贴吧自主访问账本不可用（fail-closed，${safeErrorCode(error)}），本次未发出请求`,
        operationId,
      );
    }
    if (!isPlainObject(ledgerResult) || typeof ledgerResult.ok !== 'boolean') {
      return deny('ledger-unavailable', '贴吧自主访问账本不可用：返回了畸形结果（fail-closed），本次未发出请求', operationId);
    }
    if (ledgerResult.ok === true) {
      const decision = {
        ok: true,
        counted: true,
        reason: 'patrol',
        operationId: operationId ?? null,
        used: typeof ledgerResult.used === 'number' ? ledgerResult.used : null,
        limit: typeof ledgerResult.limit === 'number' ? ledgerResult.limit : null,
        remaining: typeof ledgerResult.remaining === 'number' ? ledgerResult.remaining : null,
        at: at ?? null,
      };
      decisions.allowed += 1;
      remember(decision);
      return decision;
    }
    const reason = typeof ledgerResult.reason === 'string' && ledgerResult.reason !== '' ? ledgerResult.reason : 'unknown';
    const message = reason === 'daily-cap'
      ? '贴吧自主访问今日已达每日上限，本次未发出请求'
      : truncate(`贴吧自主访问额度检查未通过（${reason}），本次未发出请求`, MAX_MESSAGE_LENGTH);
    return deny(reason, message, operationId, ledgerResult);
  }

  function trimOperations() {
    while (operations.size > TIEBA_PATROL_ADAPTER_MAX_OPERATIONS) {
      let removed = false;
      for (const [key, entry] of operations) {
        if (entry.status !== 'in-flight') {
          operations.delete(key);
          removed = true;
          break;
        }
      }
      if (!removed) return;
    }
  }

  async function decide(context) {
    if (context !== undefined && !isPlainObject(context)) {
      throw createError('贴吧巡逻适配器：钩子参数必须是对象或省略', 'TIEBA_PATROL_ADAPTER_INVALID_CONTEXT');
    }
    const reason = resolveReason(context);
    if (reason === 'user') {
      // 用户明确查询：直接放行，不调用 ledger（不占额度、额度满也放行）。
      const decision = { ok: true, counted: false, reason: 'user' };
      decisions.user += 1;
      remember(decision);
      return decision;
    }

    const operationId = resolveOperationId(context);
    const at = resolveAt();
    // L15：日上限可配置（limit/limitOf）。非法上限 fail-closed：返回可读拒绝且**绝不调用 ledger**。
    const limitDecision = evaluateLimit();
    if (!limitDecision.ok) {
      return deny(
        'invalid-limit',
        truncate(`贴吧自主访问上限配置非法（${limitDecision.detail}），fail-closed，本次未发出请求`, MAX_MESSAGE_LENGTH),
        operationId,
      );
    }
    if (operationId === null) {
      // 无稳定 id：无法安全区分「重试」与「新请求」，按新请求保守计次。
      return reserveOnce(null, at, limitDecision.value);
    }

    const existing = operations.get(operationId);
    if (existing !== undefined) {
      if (existing.status === 'in-flight') return existing.promise;
      return existing.result;
    }

    const entry = { status: 'in-flight', promise: null, result: null };
    operations.set(operationId, entry);
    const promise = reserveOnce(operationId, at, limitDecision.value).then(
      (result) => {
        entry.status = result.ok === true ? 'allowed' : 'denied';
        entry.result = result;
        return result;
      },
      (error) => {
        // 只有适配器自身错误（如时钟非法）会走到这里：删掉半成品记录，允许调用方修复后重试。
        operations.delete(operationId);
        throw error;
      },
    );
    entry.promise = promise;
    trimOperations();
    return promise;
  }

  async function hook(context) {
    return decide(context);
  }

  hook.forOperation = (context) => {
    if (!isPlainObject(context) || typeof context.operationId !== 'string' || context.operationId === '') {
      throw createError('贴吧巡逻适配器：forOperation 必须提供稳定 operationId', 'TIEBA_PATROL_ADAPTER_INVALID_OPERATION_ID');
    }
    // 提前校验 id 形态（失败立即暴露，而不是等到第一次调用）。
    resolveOperationId({ operationId: context.operationId });
    const frozen = { ...context };
    return () => hook(frozen);
  };

  hook.lastDecision = () => cloneDecision(lastDecision);

  hook.snapshot = () => ({
    operations: operations.size,
    decisions: { ...decisions },
    lastDecision: cloneDecision(lastDecision),
  });

  return hook;
}
