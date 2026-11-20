/**
 * task-63：小黑盒身份异常降级状态机（**纯模块，未接线**）。
 *
 * 背景（用户 2026-10-28 的安全规则）：
 *  ① 身份不能可靠区分后台/人工来源时，小黑盒必须进入临时只读（禁发帖/评论/回复）并通知管理员；
 *     通知成功 + 身份恢复 + 经确认后才自动解除**仅由该异常触发**的只读。
 *  ② 若通知发送失败或结果不能确认 → 暂停小黑盒**全部**操作（含读取/搜索），只能控制台手动恢复；
 *     不影响贴吧与 QQ。
 *  ③ 手动恢复必须同时满足：身份正常 + QQ 通信恢复 + 补报已收到发送接口成功回执；
 *     任一不满足 → 拒绝并给出具体原因。
 *  ④ 「发送成功」= QQ 接口回执，不等于管理员已读；未知结果不得视为成功。
 *  ⑤ 处理持久化、去重、恢复事件竞态，避免未知结果造成错误恢复。
 *     幂等的是「状态/异常身份」而非「发送次数」：平台无幂等键，每次重试都是一次真实外发，
 *     最多可能重复 3 次；取舍是**宁可重复通知，也不静默死锁**。
 *
 * 状态机（三态）：
 *   normal         — 正常
 *   writes-paused  — 仅小黑盒写操作被禁（读取/搜索放行）；由身份异常触发，通知成功+身份恢复后可自动解除
 *   all-paused     — 小黑盒全部操作被禁；由「通知失败/结果未知」升级而来，**只能控制台手动恢复**
 *
 * 关键不变量（本模块的测试逐条锁定）：
 *  · stale operationId 不得改变任何状态（防「未知结果造成错误恢复」的最后防线）。
 *  · all-paused 不得降级回 writes-paused；all-paused 下 reportIdentityRestored 永不自动解除。
 *  · 同一 anomaly 反复上报，幂等的是「状态/异常身份」而非「发送次数」：anomalyId 不变、attempts 累加、
 *    最多 3 次尝试；平台无幂等键 ⇒ **每次重试都是真实外发，最多可能重复 3 次**。取舍：宁可重复通知，也不静默死锁。
 *  · 限制增加落盘失败 → 尽力写 `<stateFile>.degraded-latch`；重启时若磁盘状态 rank 低于 latch.intendedRank
 *    （或状态文件缺失、latch 不可解析）→ fail-closed 到 all-paused（skipReason='load-failed'），绝不静默回到 normal。
 *  · 重启后 pending 的通知不得被当作已送达；重启后 all-paused 必须保持。
 *  · identityOk:false 必须落盘并作废待发的恢复通知（迟到的恢复回执只能命中 stale）。
 *  · 解除前必须校验「最近一次身份检查 === true」。
 *  · 时钟回拨/不可信时间 → 立即按超时处理（升级 all-paused），不得静默死锁。
 *  · 限制增加（→writes-paused / →all-paused）落盘失败也提交内存并置 degraded；
 *    限制减少（→normal）必须落盘成功才提交。
 *  · degraded 不得拦截 recoverManually（控制台是唯一恢复通道）。
 *  · 损坏状态 / 未知版本 / 未知 state / 非法时间 / 跨字段不一致 → fail-closed 到 all-paused。
 *
 * 明确不做：不发送 QQ、不读 config、不联网、不接线 api/hook/bridge；没有跨进程锁，
 * 假定同一 filePath 单实例使用（调用方需保证）。
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const XHH_IDENTITY_GUARD_SCHEMA_VERSION = 1;
export const XHH_IDENTITY_GUARD_STATES = Object.freeze(['normal', 'writes-paused', 'all-paused']);
export const XHH_IDENTITY_GUARD_NOTIFY_STATUSES = Object.freeze(['pending', 'delivered', 'failed', 'unknown']);
export const XHH_IDENTITY_GUARD_NOTIFY_DEADLINE_MS = 5 * 60 * 1000;

/**
 * task-69：同一身份异常通知的最大尝试次数（含首轮发送）。
 * 达到上限后 hook 不再自动重发（failed/unknown 都算尝试）。
 *
 * task-75/task-77：**耗尽不得替代补报回执**。用户规则 m13214 §4/§5 要求恢复前必须收到发送接口成功回执；
 * 上限只用于停止自动重发与告警，控制台如需真实回执应显式重发（resendNotify）或对损坏态发起受控补报。
 */
export const XHH_IDENTITY_GUARD_NOTIFY_MAX_ATTEMPTS = 3;

export const XHH_IDENTITY_GUARD_ANOMALY_KINDS = Object.freeze([
  'identity-legacy',
  'identity-unknown-source',
  'mapper-unavailable',
  // task-77：状态文件损坏（加载失败）也是真实异常；受控补报用它生成「可等待真实回执」的通知事件。
  'state-corruption',
]);

const ANOMALY_KIND_SET = new Set(XHH_IDENTITY_GUARD_ANOMALY_KINDS);
const STATE_SET = new Set(XHH_IDENTITY_GUARD_STATES);
const NOTIFY_STATUS_SET = new Set(XHH_IDENTITY_GUARD_NOTIFY_STATUSES);
const OUTCOME_SET = new Set(['delivered', 'failed', 'unknown']);
/**
 * task-69 P1-C / task-72：这些 skipReason 表示「状态文件加载失败 → 从未有过通知」（notify.operationId 仍为 null）。
 * task-77 起不再据此免回执放行（corruptionAck 例外已删除）；它改为**受控补报告警**
 * （declareControlledRecoveryAnomaly）的资格前提：只有「load 失败类 reason + operationId===null」时才允许
 * 生成一条真实通知事件，让管理员等到发送接口的成功回执后再手动恢复——仍不放宽回执要求。
 *
 * 正常首启同样 null，但 state 不是 all-paused，不得据此发起受控补报。
 * task-72：这里必须是 load 失败类 reason 的**全集**（与 validateLoadedState() 的返回一一对应），
 * 不能只挑其中几种「坏法」：state-invalid（字段级非法：非 object / state 枚举 / since / anomalyId /
 * notify 形状 / manualRecovery 形状）与 state-inconsistent（跨字段矛盾）同属「文件坏了、从未通知」，
 * 漏掉它们会让这两类更常见的损坏（手改字段、旧版写入、部分写）无法发起受控补报、只能手改磁盘。
 */
const LOAD_FAILURE_SKIP_REASONS = new Set([
  // validateLoadedState() → JSON 解析失败 / 版本不支持 / 读文件异常
  'state-corrupt',
  'schema-version-unsupported',
  'load-failed',
  // validateLoadedState() → 字段级非法 / 跨字段矛盾（task-72 补齐）
  'state-invalid',
  'state-inconsistent',
]);
/**
 * task-73：白名单的只读视图，**仅供契约测试**做「与 failClosed/validator 实际产出的 reason 集合相等」断言。
 * 放行/发起受控补报的判定必须走内部 `controlledRecoveryApplicable()`，不得用本导出绕过。
 *
 * 为什么需要它：白名单是「人工维护的 reason 全集」，与 validateLoadedState() 的返回是两份独立写法；
 * task-72 就漏了 state-invalid/state-inconsistent 两类（真实 P1）。有了这份导出，测试可以静态扫描
 * failClosed(...) 调用与 validator 内的 reason 字面量，与之比对，漏同步立刻变红。
 */
export const XHH_IDENTITY_GUARD_LOAD_FAILURE_SKIP_REASONS = Object.freeze([...LOAD_FAILURE_SKIP_REASONS]);
// detail：短字符串，仅 a-z0-9-，≤64（禁止正文/凭据/路径）
const DETAIL_RE = /^[a-z0-9-]{1,64}$/;
const MAX_OPERATION_ID_LENGTH = 200;
const MAX_CODE_LENGTH = 64;
const FAILED_PRECONDITION_ORDER = Object.freeze(['identity', 'qq-comms', 'report-receipt']);
// 状态严格度：限制增加 = rank 上升；限制减少 = rank 下降（只允许 normal 方向，且必须落盘成功）
const STATE_RANK = Object.freeze({ normal: 0, 'writes-paused': 1, 'all-paused': 2 });
/**
 * task-78：降级锁存（degraded latch）。
 *
 * 背景（GPT 第三轮复核第 2 项）：限制增加落盘失败时按 C-1 仍提交内存（磁盘故障下限制必须生效），
 * 但磁盘上还是旧的 normal。若进程恰在此时重启，applyLoad() 读回 normal ⇒ 限制**静默消失**且无痕迹。
 * 做法：persist() 失败时尽力把「限制只在内存」写成 `<stateFile>.degraded-latch`；applyLoad() 读回后复核：
 *  · 无 latch → 行为完全不变；
 *  · 磁盘状态 rank ≥ latch.intendedRank → 限制确实落过盘，陈旧锁存，删掉后正常加载；
 *  · rank 不足 / 状态文件 ENOENT / latch 不可解析 → failClosed('load-failed')。
 * 'load-failed' 在 LOAD_FAILURE_SKIP_REASONS 内 ⇒ 受控补报告警 → 真实回执 → 手动恢复仍可达，
 * 不会重演 task-72 P1-C 的永久锁死（这是本设计最重要的约束）。
 * latch 只是可检测痕迹，不承诺「跨目录/跨磁盘原子一致」；状态文件与 latch 写失败都被吞掉。
 */
const DEGRADED_LATCH_SCHEMA_VERSION = 1;
const DEGRADED_LATCH_SUFFIX = '.degraded-latch';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyNotify() {
  return { status: null, operationId: null, attempts: 0, lastAt: null, lastCode: null, deliveredAt: null };
}

function emptyState() {
  return {
    schemaVersion: XHH_IDENTITY_GUARD_SCHEMA_VERSION,
    state: 'normal',
    since: null,
    anomalyId: null,
    anomalyKind: null,
    anomalyDetail: null,
    skipReason: null,
    identityOk: null,
    notify: emptyNotify(),
    restoreNotify: emptyNotify(),
    manualRecovery: { required: false, lastRejectReason: null },
    degraded: false,
  };
}

function validCode(value) {
  return value === undefined || value === null
    || (typeof value === 'string' && value.length > 0 && value.length <= MAX_CODE_LENGTH);
}

function validOperationId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_OPERATION_ID_LENGTH;
}

function validNotifyShape(notify, { allowDeliveredAt }) {
  return isPlainObject(notify)
    && (notify.status === null || notify.status === undefined || NOTIFY_STATUS_SET.has(notify.status))
    && (notify.operationId === null || notify.operationId === undefined || validOperationId(notify.operationId))
    && Number.isInteger(notify.attempts ?? 0) && (notify.attempts ?? 0) >= 0
    && (notify.lastAt === null || notify.lastAt === undefined || isFiniteTimestamp(notify.lastAt))
    && (notify.lastCode === null || notify.lastCode === undefined || validCode(notify.lastCode))
    && (!allowDeliveredAt || notify.deliveredAt === null || notify.deliveredAt === undefined
      || isFiniteTimestamp(notify.deliveredAt));
}

function normalizeNotify(notify) {
  const src = isPlainObject(notify) ? notify : {};
  return {
    status: src.status ?? null,
    operationId: src.operationId ?? null,
    attempts: Number.isInteger(src.attempts) && src.attempts >= 0 ? src.attempts : 0,
    lastAt: isFiniteTimestamp(src.lastAt) ? src.lastAt : null,
    lastCode: typeof src.lastCode === 'string' ? src.lastCode : null,
    deliveredAt: isFiniteTimestamp(src.deliveredAt) ? src.deliveredAt : null,
  };
}

function normalizeState(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const state = emptyState();
  state.state = src.state;
  state.since = src.since;
  state.anomalyId = src.anomalyId ?? null;
  state.anomalyKind = src.anomalyKind ?? null;
  state.anomalyDetail = src.anomalyDetail ?? null;
  state.skipReason = typeof src.skipReason === 'string' ? src.skipReason : null;
  state.identityOk = src.identityOk === true ? true : (src.identityOk === false ? false : null);
  state.notify = normalizeNotify(src.notify);
  state.restoreNotify = normalizeNotify(src.restoreNotify);
  const manual = isPlainObject(src.manualRecovery) ? src.manualRecovery : {};
  state.manualRecovery = {
    required: manual.required === true || state.state === 'all-paused',
    lastRejectReason: typeof manual.lastRejectReason === 'string' ? manual.lastRejectReason : null,
  };
  state.degraded = src.degraded === true;
  return state;
}

/**
 * 校验磁盘上的状态是否可用。返回 { ok:true } 或 { ok:false, reason }。
 * 任何一项不合法都 fail-closed，绝不「修复成 normal」（否则损坏状态会被当成安全）。
 */
function validateLoadedState(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: 'state-invalid' };
  if (raw.schemaVersion !== XHH_IDENTITY_GUARD_SCHEMA_VERSION) return { ok: false, reason: 'schema-version-unsupported' };
  if (!STATE_SET.has(raw.state)) return { ok: false, reason: 'state-invalid' };
  if (!isFiniteTimestamp(raw.since) || raw.since < 0) return { ok: false, reason: 'state-invalid' };
  if (raw.anomalyId !== null && raw.anomalyId !== undefined && !validOperationId(raw.anomalyId)) {
    return { ok: false, reason: 'state-invalid' };
  }
  if (!validNotifyShape(raw.notify, { allowDeliveredAt: true })) return { ok: false, reason: 'state-invalid' };
  if (!validNotifyShape(raw.restoreNotify, { allowDeliveredAt: true })) return { ok: false, reason: 'state-invalid' };
  if (raw.manualRecovery !== undefined && raw.manualRecovery !== null && !isPlainObject(raw.manualRecovery)) {
    return { ok: false, reason: 'state-invalid' };
  }
  return validateStateConsistency(raw) ? { ok: true } : { ok: false, reason: 'state-inconsistent' };
}

/**
 * D-3：最小跨字段一致性校验。以下组合一律视为损坏（防「状态字段与事实字段互相矛盾」被当成安全）：
 *  · state==='normal' 但存在 anomalyId 或 notify.status==='pending'
 *  · state==='all-paused' 但 manualRecovery.required !== true
 *  · notify.status==='delivered' 但 deliveredAt 为空
 *  · restoreNotify.status==='delivered' 但 restoreNotify.operationId 为空
 */
function validateStateConsistency(raw) {
  const notify = isPlainObject(raw.notify) ? raw.notify : {};
  const restore = isPlainObject(raw.restoreNotify) ? raw.restoreNotify : {};
  const manual = isPlainObject(raw.manualRecovery) ? raw.manualRecovery : {};
  if (raw.state === 'normal' && ((raw.anomalyId !== null && raw.anomalyId !== undefined) || notify.status === 'pending')) {
    return false;
  }
  if (raw.state === 'all-paused' && manual.required !== true) return false;
  if (notify.status === 'delivered' && !isFiniteTimestamp(notify.deliveredAt)) return false;
  if (restore.status === 'delivered' && !validOperationId(restore.operationId)) return false;
  return true;
}

/**
 * 创建小红盒身份异常降级状态机。
 *
 * @param {{ filePath: string, clock?: () => number, notifyDeadlineMs?: number }} options
 */
export function createXiaoheiheIdentityGuard(options = {}) {
  const { filePath, clock, notifyDeadlineMs } = options ?? {};
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('createXiaoheiheIdentityGuard 需要 filePath');
  }
  const now = typeof clock === 'function' ? clock : () => Date.now();
  const deadlineMs = Number.isFinite(notifyDeadlineMs) && notifyDeadlineMs > 0
    ? notifyDeadlineMs
    : XHH_IDENTITY_GUARD_NOTIFY_DEADLINE_MS;
  const degradedLatchPath = `${filePath}${DEGRADED_LATCH_SUFFIX}`;

  /**
   * task-78：读降级锁存。返回 { present:false } / { present:true, valid:false } / { present:true, valid:true, latch }。
   * 读文件失败（含 EISDIR 等）一律视为「存在但不可用」——绝不当成「没有 latch」而放行。
   */
  async function readDegradedLatch() {
    let text;
    try {
      text = await fsp.readFile(degradedLatchPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { present: false };
      return { present: true, valid: false };
    }
    try {
      if (typeof text === 'string' && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      const latch = JSON.parse(text);
      const valid = isPlainObject(latch)
        && latch.schema === DEGRADED_LATCH_SCHEMA_VERSION
        && latch.reason === 'persist-failed'
        && typeof latch.intendedState === 'string' && Object.prototype.hasOwnProperty.call(STATE_RANK, latch.intendedState)
        && Number.isInteger(latch.intendedRank) && latch.intendedRank === STATE_RANK[latch.intendedState]
        && isFiniteTimestamp(latch.at);
      return valid ? { present: true, valid: true, latch } : { present: true, valid: false };
    } catch {
      return { present: true, valid: false };
    }
  }

  /**
   * task-78：落盘失败时尽力写 latch（原子写：tmp + rename）。任何失败都被吞掉，
   * 不得改变 persist() 的返回值语义（仍返回 persist-failed），也不得抛错。
   *
   * task-84 P3-1（消费契约）：函数体内的 latchWriteFailed 事实位只描述「**最近一次**写锁存尝试」，
   * 没有时间戳。全仓唯一消费点是 hook 的 maybeNotifyDegraded()，而它在 flush 内**排在
   * retryPersist() 之后**（顺序由 wiring 的「顺序契约」用例钉住）。若有新的消费点要读这个事实，
   * 必须同样保证「先 retryPersist、再读事实」，否则会拿到陈旧值（自愈后仍显示锁存失败）。
   */
  async function writeDegradedLatch(next) {
    const payload = {
      schema: DEGRADED_LATCH_SCHEMA_VERSION,
      reason: 'persist-failed',
      at: now(),
      intendedState: next.state,
      intendedRank: STATE_RANK[next.state],
    };
    const tmp = `${degradedLatchPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    // task-83（GPT 复核）：锁存的唯一目的就是**跨崩溃存活**，因此必须与 persist() 同级持久化：
    // 写 tmp → fsync 文件 → rename → best-effort fsync 目录。此前只 writeFile+rename 不 fsync，
    // 掉电/崩溃后目录项可能丢，锁存形同不存在 —— 那不是「尽力而为」，而是「看起来写了其实不保证」。
    // 注意：即使加了 fsync，本函数仍然吞掉所有错误（见下方 catch），所以它依旧是 best-effort：
    // 【不可宣称】「限制增加失败后重启一定 fail-closed」。无法覆盖的窗口见报告 §5。
    try {
      await fsp.mkdir(path.dirname(degradedLatchPath), { recursive: true });
      const handle = await fsp.open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsp.rename(tmp, degradedLatchPath);
      try {
        const dirHandle = await fsp.open(path.dirname(degradedLatchPath), 'r');
        try { await dirHandle.sync(); } finally { await dirHandle.close(); }
      } catch { /* 目录 sync 是 best-effort：Windows 上可能直接抛错 */ }
      // task-83 F2：锁存写成 ⇒ 跨重启这条防线成立，清掉「写失败」事实。
      latchWriteFailed = false;
    } catch {
      // task-83 F2：此前这里完全静默——出问题时现场无法自证「latch 曾写失败」，
      // 而写失败正是「重启后限制可能静默消失」的直接前兆。只置一个只读事实位，不改任何判定。
      latchWriteFailed = true;
      try { await fsp.unlink(tmp); } catch { /* 清理失败不影响主流程 */ }
    }
  }

  /**
   * task-78：成功落盘后清理锁存。满足任一即删除：
   *  · 新状态 rank ≥ latch.intendedRank（限制确实落过盘）；
   *  · 新状态是 normal（唯一 rank 下降目标，只可能来自管理员显式恢复；若保留 latch，
   *    恢复后每次重启都会再 fail-closed，等于制造新的锁死循环）；
   *  · latch 不可读/不可解析（无法据此复核，尽力自愈）。
   * 删除失败只记录在注释里（模块无日志通道），不得影响 persist 成功语义。
   */
  async function clearDegradedLatchIfCovered(next) {
    const latch = await readDegradedLatch();
    if (!latch.present) return;
    // task-79 P3（复审建议）：`next.state !== 'normal' && rank < intendedRank` 这个「保留」分支
    // 在当前公开 API 下**不可达**——会走到 persist 的调用方要么 rank 相等/增加（persistRestriction），
    // 要么只到 normal（persistLift / 手动恢复），没有任何公开 mutator 能把 rank 写回更低的值。
    // 保留它是纵深防御：将来若新增「rank 下降但不到 normal」的路径（例如分级降级），
    // 这里会自动阻止误删锁存。零覆盖是已知的，故此行注释明确标注。
    if (latch.valid && next.state !== 'normal' && STATE_RANK[next.state] < latch.latch.intendedRank) return;
    try { await fsp.unlink(degradedLatchPath); } catch { /* 删除失败忽略 */ }
  }

  let state = emptyState();
  let closed = false;
  let degraded = false;
  let degradeReason = null;
  // task-83 F2：最近一次「降级锁存写失败」的事实位（纯可观测，不参与任何判定）。
  // 为什么需要：persist 失败 + latch 也写失败 ⇒ 重启后限制静默消失且磁盘无痕（报告 §3 的 P2），
  // 这是唯一能在事发时留下线索的地方。语义边界：它只表示**最近一次**写锁存的尝试是否失败，
  // 成功写一次即清；进程重启后自然归 false（本来也不可能跨进程记住）。
  let latchWriteFailed = false;
  let queue = Promise.resolve();

  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * v4 §②：degraded latch 只拦「限制减少」，不拦限制增加/不减少限制的变更与手动恢复。
   * - reducesRestriction=false（限制增加、记录 identityOk、补报 delivered 等）：degraded 时仍允许；
   * - reducesRestriction=true（自动解除到 normal）：degraded 时拒绝，磁盘与内存可能不一致，不能信任解除；
   * - recoverManually 是控制台唯一恢复通道（C-3），调用时不传该标志，不受 latch 拦截。
   */
  function ensureMutable({ reducesRestriction = false } = {}) {
    if (closed) return { ok: false, reason: 'closed' };
    if (degraded && reducesRestriction) return { ok: false, reason: degradeReason ?? 'persist-failed', state: state.state };
    return null;
  }

  /**
   * 原子落盘。成功时提交内存；失败时置 degrade（不回滚内存——调用方决定是否已先提交）。
   * 注意：限制增加的调用方必须使用 persistRestriction()。
   */
  async function persist(next) {
    const target = filePath;
    const dir = path.dirname(target);
    const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    // task-79 P2-2（degraded 不落盘的不变量被证伪后修正）：
    // `degraded` 的语义是「内存领先于磁盘 / 磁盘此刻不可信」，是**运行期事实**，不是落盘事实。
    // 走到这里说明本次写入**成功**，磁盘与内存已一致，因此序列化时一律归一为 `degraded:false`。
    // 否则 failClosed（类2：状态文件损坏，degraded=true 但从不写 latch）之后任意一次成功落盘
    // 都会把 `"degraded": true` 写进磁盘，重启读回一个语义已过期的降级标记——
    // 保守（只会多暂停）但会让「degraded 纯内存态」这条已被测试与注释依赖的不变量失真。
    const forDisk = { ...next, degraded: false };
    try {
      await fsp.mkdir(dir, { recursive: true });
      const handle = await fsp.open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(forDisk, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsp.rename(tmp, target);
      // 目录 sync 是 best-effort：Windows 上对目录 fsync 可能直接抛错，不应让状态写失败
      try {
        const dirHandle = await fsp.open(dir, 'r');
        try { await dirHandle.sync(); } finally { await dirHandle.close(); }
      } catch { /* best-effort */ }
      state = next;
      // v4 §②：任意一次成功落盘 ⇒ 内存与磁盘一致，degraded 前提消失（自愈），避免瞬时磁盘错误永久停摆
      degraded = false;
      degradeReason = null;
      // task-79 P2-2：内存副本与刚写出的磁盘内容保持一致（磁盘侧已在 forDisk 里归一为 false），
      // 否则 `state.degraded` 会长期停在 true，与 snapshot().degraded/effectiveState 打架。
      // task-80 P3-1：`state.degraded` 目前**没有任何消费者**——判定只看内存变量 `degraded` 与
      // `effectiveState`，持久化另有 `forDisk` 归一。保留它纯粹是让内存副本与磁盘逐字段一致；
      // 若将来有人改成读它做控制，请先补断言（当前删掉这一行也不会有测试变红：复审 m2/m13 实证）。
      state.degraded = false;
      // task-78：成功落盘后清理陈旧/已覆盖的降级锁存（best-effort，失败不影响成功语义）
      await clearDegradedLatchIfCovered(next);
      return { ok: true };
    } catch {
      try { await fsp.unlink(tmp); } catch { /* 清理失败不覆盖原始错误语义 */ }
      degraded = true;
      degradeReason = 'persist-failed';
      // task-78：限制增加/补记（rank 不下降）落盘失败时，把「限制只在内存」写成可检测痕迹。
      // 限制减少（persistLift 到 normal）失败不写：磁盘仍受限，重启后保护仍在，无需锁存。
      if (STATE_RANK[next.state] >= STATE_RANK[state.state]) {
        await writeDegradedLatch(next);
      }
      return { ok: false, reason: 'persist-failed' };
    }
  }

  /**
   * C-1 核心不变量：限制增加/记录新的限制事实（→writes-paused、→all-paused，以及“限制已增加但事实字段缺失”的补齐）
   * 落盘失败也提交内存，保证磁盘故障时限制仍然生效（接线只要看 snapshot().state/degraded 就不会放行）。
   *
   * 调用契约（v4 复审 + 复审回归修正）：
   *  · 本函数禁止「限制减少」（STATE_RANK 下降）：那属于调用方误用，响亮返回 restriction-loosened，
   *    绝不静默退化成普通 persist（那会引入第二种提交流程：失败不提交内存）。
   *  · rank 相等是允许的：磁盘上可能已有更受限状态但事实字段缺失（all-paused + notify.pending 需要
   *    记录 deadline 升级；writes-paused + anomalyId=null 需要补建异常），这些都必须能落盘，
   *    否则「限制已生效但事实永远记不上」——异常报不出、deadline 升级永远 pending。
   *  · 走 persistRestriction 的调用方不得自行 `state = next` —— 内存提交由本函数负责；
   *    走普通 persist 的调用方若需「失败仍提交」必须自己先 `state = next` 并返回 committedInMemory:true。
   */
  async function persistRestriction(next) {
    // 唯一禁止的是「限制减少」（rank 下降）；rank 相等是合法的补记（见上）。
    if (STATE_RANK[next.state] < STATE_RANK[state.state]) {
      return { ok: false, reason: 'restriction-loosened', committedInMemory: false, state: state.state };
    }
    state = next;
    const persisted = await persist(next);
    if (!persisted.ok) {
      return { ok: false, reason: 'persist-failed', committedInMemory: true, state: next.state, degraded: true };
    }
    return { ok: true };
  }

  /** 限制减少：必须落盘成功才提交（失败保持受限状态，绝不假装恢复）。 */
  async function persistLift(next) {
    const persisted = await persist(next);
    if (!persisted.ok) return { ok: false, reason: 'persist-failed', state: state.state };
    degraded = false;
    degradeReason = null;
    return { ok: true };
  }

  function failClosed(reason) {
    // task-75（task-74 P2-1）：不变量——failClosed 产出的 skipReason 必须落在 LOAD_FAILURE_SKIP_REASONS 内。
    // 它是「本事件从未产生过通知」的唯一凭据：控制台据此允许发起**受控补报告警**
    // （task-77；不再有免回执的 corruptionAck 例外）。一旦写进白名单外的值，这份坏文件就只能手改磁盘逃生。
    // 正常路径的 reason 都是字面量且在白名单内；若将来有人改成动态拼接，这里兜住：归一到最保守的
    // 'load-failed'（同为 load 失败类），保证受控补报永远可达，同时用 rawReason 保留原始值供排查。
    const skip = LOAD_FAILURE_SKIP_REASONS.has(reason) ? reason : 'load-failed';
    state = emptyState();
    state.state = 'all-paused';
    state.since = now();
    state.skipReason = skip;
    state.manualRecovery = { required: true, lastRejectReason: null };
    state.degraded = true;
    degraded = true;
    degradeReason = skip;
    // P1-C：ok:true 表达「进程还能跑」，与「磁盘态已坏」是两件事；failClosed:true 供接线侧告警。
    const result = { ok: true, failClosed: true, state: 'all-paused', reason: skip };
    if (skip !== reason) result.rawReason = String(reason).slice(0, MAX_CODE_LENGTH);
    return result;
  }

  function commitAnomaly(kind, detail) {
    const at = now();
    const anomalyId = crypto.randomUUID();
    const next = clone(state);
    next.state = 'writes-paused';
    next.since = at;
    next.anomalyId = anomalyId;
    next.anomalyKind = kind;
    next.anomalyDetail = detail;
    next.skipReason = null;
    next.identityOk = null;
    next.notify = { status: 'pending', operationId: anomalyId, attempts: 0, lastAt: at, lastCode: null, deliveredAt: null };
    next.restoreNotify = emptyNotify();
    next.manualRecovery = { required: false, lastRejectReason: null };
    next.degraded = false;
    return { next, anomalyId };
  }

  async function applyAnomaly(kind, detail) {
    const blocked = ensureMutable();
    if (blocked) return blocked;
    // all-paused 或已有 anomaly：保持原 anomalyId，不重发（幂等 by anomalyId）
    if (state.state === 'all-paused') return { ok: true, changed: false };
    if (state.state === 'writes-paused' && state.anomalyId) return { ok: true, changed: false };

    const { next, anomalyId } = commitAnomaly(kind, detail);
    const persisted = await persistRestriction(next);
    if (!persisted.ok) return persisted;
    return { ok: true, changed: true, notifyRequired: { operationId: anomalyId } };
  }

  async function applyNotifyResult({ operationId, outcome, code }) {
    const blocked = ensureMutable();
    if (blocked) return blocked;
    if (!validOperationId(operationId) || !OUTCOME_SET.has(outcome) || !validCode(code)) {
      return { ok: false, reason: 'invalid-argument' };
    }
    // stale/旧/伪造 operationId：不得改变任何状态（防错误恢复的关键）
    if (!state.anomalyId || operationId !== state.notify.operationId) {
      return { ok: false, reason: 'stale-operation-id' };
    }
    // task-69 P1-B：同一 outcome 的重复投递也必须计入 attempts。
    // 旧实现把幂等短路放在 attempts 自增之前，导致接线侧「attempts < 3」上限永远不成立，
    // failed/unknown 结果会被每 60s 无限重发。这里幂等只保证「状态不重复改变」，事实（计数/时间）必须落盘。
    if (state.notify.status === outcome) {
      const at = now();
      const next = clone(state);
      next.notify.lastAt = at;
      next.notify.attempts += 1;
      if (code !== undefined && code !== null) next.notify.lastCode = code;
      if (outcome === 'delivered') next.notify.deliveredAt = at;
      const persisted = await persist(next);
      if (!persisted.ok) return persisted;
      return {
        ok: true,
        changed: false,
        escalated: false,
        attempts: next.notify.attempts,
        retriesExhausted: notifyExhausted(next),
      };
    }

    const at = now();
    const next = clone(state);
    next.notify.status = outcome;
    next.notify.lastAt = at;
    next.notify.attempts += 1;
    if (code !== undefined && code !== null) next.notify.lastCode = code;
    if (outcome === 'delivered') next.notify.deliveredAt = at;

    if (next.state === 'all-paused') {
      // D-2：all-paused 下接受同一 operationId 的补报（failed/unknown/pending → delivered），
      // 只更新回执事实，**状态保持 all-paused 不变**（手动恢复的第三条件因此可以完成）。
      const persisted = await persist(next);
      if (!persisted.ok) return persisted;
      return {
        ok: true,
        changed: true,
        escalated: false,
        state: 'all-paused',
        attempts: next.notify.attempts,
        retriesExhausted: notifyExhausted(next),
      };
    }

    if (outcome === 'delivered') {
      // D-1：delivered 时若身份已恢复，就地创建恢复通知，接线不必再反复调用。
      let restoreRequired = null;
      if (next.identityOk === true && !next.restoreNotify.operationId) {
        restoreRequired = createRestoreNotify(next, at);
      }
      const persisted = await persist(next);
      if (!persisted.ok) return persisted;
      return {
        ok: true,
        changed: true,
        escalated: false,
        attempts: next.notify.attempts,
        retriesExhausted: notifyExhausted(next),
        ...(restoreRequired ? { restoreNotifyRequired: { operationId: restoreRequired } } : {}),
      };
    }

    // failed / unknown：结果不可确认 → 升级全停
    next.state = 'all-paused';
    next.since = at;
    next.skipReason = outcome === 'failed' ? 'notify-failed' : 'notify-unknown';
    next.manualRecovery = { required: true, lastRejectReason: null };
    const persisted = await persistRestriction(next);
    if (!persisted.ok) return persisted;
    return {
      ok: true,
      changed: true,
      escalated: true,
      attempts: next.notify.attempts,
      retriesExhausted: notifyExhausted(next),
    };
  }

  function createRestoreNotify(target, at) {
    const operationId = crypto.randomUUID();
    target.restoreNotify = {
      status: 'pending',
      operationId,
      attempts: 0,
      lastAt: at,
      lastCode: null,
      deliveredAt: null,
    };
    return operationId;
  }

  /**
   * task-69：是否已耗尽自动重发次数（failed/unknown 都算「不可确认」的尝试）。
   * 派生判定，不落盘（避免 schema 漂移）；仅作为 snapshot 的**纯可观测字段**，供接线停止自动重发。
   *
   * task-75：**不得作为手动恢复依据**。用户规则 m13214 §4/§5 要求「补报已收到发送接口成功回执」，
   * 「重试耗尽」只是未知结果的累计，不是回执；此前把它当 report-receipt 的替代是错误放宽，已收回。
   */
  function notifyExhausted(target) {
    const status = target.notify?.status ?? null;
    const attempts = target.notify?.attempts ?? 0;
    return (status === 'failed' || status === 'unknown')
      && attempts >= XHH_IDENTITY_GUARD_NOTIFY_MAX_ATTEMPTS;
  }

  /**
   * task-77：状态文件损坏时是否允许发起**受控补报告警**（让真实回执可达，而不是伪造送达）。
   * 三条件全部成立才可用：all-paused；从未有过通知（notify.operationId 为 null）；skipReason ∈ load 失败类全集。
   *
   * 注意：本函数只决定「能否新建一条通知事件」，**不构成恢复依据**。恢复仍然只看真实 delivered 回执
   * （notifyDeliveredForAnomaly）。已有通知时不得另起一条掩盖未知结果，因此 operationId 非 null ⇒ 不可用。
   */
  function controlledRecoveryApplicable(target) {
    const skipReason = typeof target.skipReason === 'string' ? target.skipReason : null;
    return target.state === 'all-paused'
      && (target.notify?.operationId ?? null) === null
      && skipReason !== null
      && LOAD_FAILURE_SKIP_REASONS.has(skipReason);
  }

  /** task-75 §2.1：补报回执唯一口径 —— 同一异常事件的真实成功回执（delivered 且 operationId===anomalyId）。 */
  function notifyDeliveredForAnomaly(target) {
    return target.notify?.status === 'delivered'
      && typeof target.anomalyId === 'string'
      && target.notify?.operationId === target.anomalyId;
  }

  /**
   * task-75/task-77：reportReceiptBasis 派生（§2.1/§2.4）。只认内部真实回执；调用方传入的 reportDelivered
   * 只是提示（不信任调用方）。task-77 起删除 corruptionAck 例外：损坏态必须先发受控补报并收到真实回执。
   */
  function deriveReportReceiptBasis(target) {
    return notifyDeliveredForAnomaly(target) ? 'delivered' : null;
  }

  async function applyDeadline() {
    const blocked = ensureMutable();
    if (blocked) return blocked;
    if (state.notify.status !== 'pending') return { ok: true, escalated: false };
    if (state.notify.lastAt === null) return { ok: true, escalated: false };

    const current = now();
    const elapsed = current - state.notify.lastAt;
    // B：时间不可信（NaN/Infinity/回拨）⇒ 结果不可确认 ⇒ 立即 fail-closed，绝不静默 pending
    const rollback = !Number.isFinite(elapsed) || elapsed < 0;
    if (!rollback && elapsed < deadlineMs) return { ok: true, escalated: false };

    const safeAt = Number.isFinite(current) ? current : (state.notify.lastAt ?? state.since ?? 0);
    const next = clone(state);
    next.notify.status = 'unknown';
    next.notify.lastAt = safeAt;
    next.notify.attempts += 1;
    next.state = 'all-paused';
    next.since = safeAt;
    next.skipReason = rollback ? 'notify-deadline-clock-rollback' : 'notify-unknown';
    next.manualRecovery = { required: true, lastRejectReason: null };
    const persisted = await persistRestriction(next);
    if (!persisted.ok) return persisted;
    return {
      ok: true,
      escalated: true,
      changed: true,
      attempts: next.notify.attempts,
      retriesExhausted: notifyExhausted(next),
    };
  }

  async function applyIdentityRestored({ identityOk }) {
    const blocked = ensureMutable();
    if (blocked) return blocked;

    if (identityOk !== true) {
      // A：false 必须落盘 + 作废待发的恢复通知；迟到的 restore delivered 只能命中 stale。
      const at = now();
      const next = clone(state);
      next.identityOk = false;
      const invalidated = next.restoreNotify.operationId !== null || next.restoreNotify.status !== null;
      if (invalidated) {
        // v4 §①：复用枚举 'unknown'（结果不可确认，与「不得解除」自洽）+ operationId=null（任何迟到回执命中 stale）。
        // 不扩 XHH_IDENTITY_GUARD_NOTIFY_STATUSES 枚举；lastCode 便于审计区分「通知超时」与「身份丢失导致作废」。
        next.restoreNotify = {
          status: 'unknown',
          operationId: null,
          attempts: next.restoreNotify.attempts,
          lastAt: at,
          lastCode: 'invalidated-identity-lost',
          deliveredAt: null,
        };
      }
      // 安全方向（身份更坏）先提交内存，落盘失败也不能让旧 true 复活
      state = next;
      const persisted = await persist(next);
      if (!persisted.ok) {
        return { ok: false, reason: 'persist-failed', identityRecorded: false, committedInMemory: true, degraded: true };
      }
      return { ok: true, lifted: false, identityRecorded: false, ...(invalidated ? { restoreNotifyInvalidated: true } : {}) };
    }

    const at = now();
    const next = clone(state);
    next.identityOk = true;

    // D-1：identityOk===true 总是持久化。先落盘身份事实（不减少限制，degraded 时也允许；
    // 成功落盘会清 degraded 自愈），再判断是否满足解除条件——避免「记录事实」被解除门禁一起拦掉。
    let restoreRequired = null;
    if (next.state === 'writes-paused' && next.notify.status === 'delivered' && !next.restoreNotify.operationId) {
      restoreRequired = createRestoreNotify(next, at);
    }
    const persisted = await persist(next);
    if (!persisted.ok) return persisted;

    // 最近一次身份检查为 true（刚持久化），且恢复通知回执已 delivered → 解除（A-3 的校验就在 identityOk 上）
    if (state.state === 'writes-paused' && state.restoreNotify.status === 'delivered') {
      const canLift = ensureMutable({ reducesRestriction: true });
      if (canLift) return canLift;
      const lifted = await persistLift(liftToNormal(state, at));
      if (!lifted.ok) return lifted;
      return { ok: true, lifted: true, identityRecorded: true };
    }

    if (state.state === 'all-paused') return { ok: false, reason: 'manual-recovery-required' };
    return {
      ok: true,
      lifted: false,
      identityRecorded: true,
      ...(restoreRequired ? { restoreNotifyRequired: { operationId: restoreRequired } } : {}),
    };
  }

  async function applyRestoreNotifyResult({ operationId, outcome, code }) {
    const blocked = ensureMutable();
    if (blocked) return blocked;
    if (!validOperationId(operationId) || !OUTCOME_SET.has(outcome) || !validCode(code)) {
      return { ok: false, reason: 'invalid-argument' };
    }
    if (!state.restoreNotify.operationId || operationId !== state.restoreNotify.operationId) {
      return { ok: false, reason: 'stale-operation-id' };
    }
    if (state.restoreNotify.status === outcome) {
      // 幂等重复回执：若上一次 delivered 因 degraded 只记录了回执、没有解除，此时条件已满足则补做解除，
      // 避免「回执已 delivered 但状态永久停在 writes-paused」。
      if (outcome === 'delivered' && state.state === 'writes-paused' && state.identityOk === true && !degraded) {
        const lifted = await persistLift(liftToNormal(clone(state), now()));
        if (!lifted.ok) return lifted;
        return { ok: true, changed: false, lifted: true };
      }
      return { ok: true, changed: false, lifted: false };
    }

    const at = now();
    const next = clone(state);
    next.restoreNotify.status = outcome;
    next.restoreNotify.lastAt = at;
    next.restoreNotify.attempts += 1;
    if (code !== undefined && code !== null) next.restoreNotify.lastCode = code;

    if (outcome === 'delivered') {
      next.restoreNotify.deliveredAt = at;
      const canLiftNow = next.state === 'writes-paused' && next.identityOk === true;
      if (!canLiftNow) {
        // 记录回执本身不减少限制：degraded 时仍允许落盘（失败也提交内存，绝不吞回执）
        state = next;
        const persisted = await persist(next);
        if (!persisted.ok) {
          return { ok: false, reason: 'persist-failed', changed: true, committedInMemory: true, state: next.state, degraded: true };
        }
        return { ok: true, changed: true, lifted: false };
      }
      const canLift = ensureMutable({ reducesRestriction: true });
      if (canLift) {
        // degraded：先把「回执已 delivered」落盘/提交内存（不减少限制），只是不解除；
        // 这次成功落盘会清 degraded（自愈），下一次 delivered 即可正常解除。
        state = next;
        const persisted = await persist(next);
        if (!persisted.ok) {
          return { ok: false, reason: 'persist-failed', changed: true, committedInMemory: true, state: next.state, degraded: true };
        }
        return { ok: true, changed: true, lifted: false, skippedLiftReason: canLift.reason };
      }
      const lifted = await persistLift(liftToNormal(next, at));
      if (!lifted.ok) return lifted;
      return { ok: true, changed: true, lifted: true };
    }

    // failed / unknown：保持 writes-paused（恢复通知失败不升级 all-paused），也不解除
    const persisted = await persist(next);
    if (!persisted.ok) return persisted;
    return { ok: true, changed: true, escalated: false, lifted: false };
  }

  function liftToNormal(base, at) {
    const next = clone(base);
    next.state = 'normal';
    next.since = at;
    next.anomalyId = null;
    next.anomalyKind = null;
    next.anomalyDetail = null;
    next.skipReason = null;
    next.identityOk = null;
    next.notify = emptyNotify();
    next.restoreNotify = emptyNotify();
    next.manualRecovery = { required: false, lastRejectReason: null };
    next.degraded = false;
    return next;
  }

  async function applyManualRecovery({ identityOk, qqCommsOk, reportDelivered }) {
    // C-3：recoverManually 不受 degrade latch 拦截（控制台是唯一恢复通道，必须能自救）
    const blocked = ensureMutable();
    if (blocked) return blocked;

    // task-75 §2.1：补报回执唯一口径 = 同一异常事件（operationId===anomalyId）的真实 delivered 回执。
    // 「重试耗尽」与「从未通知」都不得替代回执（用户规则 §4/§5）；restoreNotify 回执同样不得替代。
    // task-77：corruptionAck 例外已彻底删除；损坏态必须先经 declareControlledRecoveryAnomaly 发起受控补报，
    // 拿到真实回执后才能恢复（不伪造送达、也不需要新授权）。
    // §2.4：reportDelivered 只是调用方提示；deriveReportReceiptBasis() 只认内部 notify 状态。
    const reportReceiptBasis = deriveReportReceiptBasis(state);
    const satisfied = {
      identity: identityOk === true,
      'qq-comms': qqCommsOk === true,
      'report-receipt': reportReceiptBasis !== null,
    };
    const failed = FAILED_PRECONDITION_ORDER.filter((key) => !satisfied[key]);
    if (failed.length > 0) {
      const next = clone(state);
      next.manualRecovery = {
        required: next.state === 'all-paused' || next.manualRecovery?.required === true,
        lastRejectReason: `precondition-failed:${failed.join(',')}`,
      };
      const persisted = await persist(next);
      if (!persisted.ok) return persisted;
      return { ok: false, reason: 'precondition-failed', failed, reportReceiptBasis };
    }

    if (state.state === 'normal') return { ok: true, recovered: false, skipReason: null, reportReceiptBasis };
    const lifted = await persistLift(liftToNormal(state, now()));
    if (!lifted.ok) return lifted;
    return { ok: true, recovered: true, skipReason: null, reportReceiptBasis };
  }

  /**
   * task-75 §2.3：管理员显式发起一次补报重试，让**真实回执**可达（去掉放宽后不能重造 P1-A 死锁）。
   * 只接受「同一异常事件、尚未 delivered」的 operationId；重置 pending/attempts=0/lastAt，保留 operationId，
   * state 保持 all-paused（不减少限制）。每次调用=一次显式重发，自动重发上限不因此被绕过（重置后仍最多 3 次）。
   */
  async function applyResendNotify({ operationId } = {}) {
    const blocked = ensureMutable();
    if (blocked) return blocked;
    if (!validOperationId(operationId)) return { ok: false, reason: 'invalid-argument' };
    if (state.notify.status === 'delivered') return { ok: false, reason: 'already-delivered' };
    if (!state.anomalyId || operationId !== state.notify.operationId) {
      return { ok: false, reason: 'stale-operation-id' };
    }
    const at = now();
    const next = clone(state);
    next.notify.status = 'pending';
    next.notify.attempts = 0;
    next.notify.lastAt = at;
    next.notify.lastCode = null;
    next.notify.deliveredAt = null;
    const persisted = await persist(next);
    if (!persisted.ok) return persisted;
    return { ok: true, operationId, attempts: 0 };
  }

  /**
   * task-77 §A：受控补报告警（替代已删除的 corruptionAck 例外）。
   *
   * 状态文件损坏（load 失败）时，本事件从未产生过通知，因此不存在「可等待的发送接口回执」——
   * 但直接免回执放行违反用户规则 §4/§5。正确做法是：由管理员显式发起一条针对该损坏事件的
   * 真实通知（anomalyKind='state-corruption'），之后照常由接线发送并回写真实 delivered；只有
   * 收到真实成功回执后 recoverManually 才会放行。state 保持 all-paused（限制不因磁盘故障回退）。
   *
   * 只允许在「无既有通知」时发起，避免用新通知掩盖上一个未知结果。
   */
  async function applyDeclareControlledRecoveryAnomaly({ detail } = {}) {
    const blocked = ensureMutable();
    if (blocked) return blocked;
    if (state.state !== 'all-paused') return { ok: false, reason: 'not-applicable' };
    if (!controlledRecoveryApplicable(state)) {
      // 区分两种不可用：已有通知（防覆盖未知结果）vs 其余（不是 load 损坏 / 白名单外 reason）
      if ((state.notify?.operationId ?? null) !== null) return { ok: false, reason: 'notify-already-exists' };
      return { ok: false, reason: 'not-applicable' };
    }
    const at = now();
    const anomalyId = crypto.randomUUID();
    const anomalyDetail = typeof detail === 'string' && detail.trim().length > 0
      ? detail.trim().slice(0, MAX_CODE_LENGTH)
      : 'state-file-unreadable';
    const next = clone(state);
    next.anomalyId = anomalyId;
    next.anomalyKind = 'state-corruption';
    next.anomalyDetail = anomalyDetail;
    // skipReason 保留：它仍是「文件为何不可读」的原因记录；note：state 不变（all-paused）
    next.notify = {
      status: 'pending',
      operationId: anomalyId,
      attempts: 0,
      lastAt: at,
      lastCode: null,
      deliveredAt: null,
    };
    next.restoreNotify = emptyNotify();
    next.manualRecovery = { required: true, lastRejectReason: null };
    const persisted = await persistRestriction(next);
    if (!persisted.ok) {
      return { ok: false, reason: 'persist-failed', committedInMemory: persisted.committedInMemory === true, degraded: true };
    }
    return { ok: true, changed: true, notifyRequired: { operationId: anomalyId } };
  }

  /**
   * task-77 §A4：把当前内存状态再落一次盘（不改状态），用于磁盘故障恢复后缩短「限制只在内存」的窗口。
   * 不作任何放宽：只写盘、不解除限制、不伪造回执。
   */
  async function applyRetryPersist() {
    const blocked = ensureMutable();
    if (blocked) return blocked;
    const persisted = await persist(state);
    return persisted.ok ? { ok: true } : { ok: false, reason: 'persist-failed' };
  }

  async function applyLoad() {
    if (closed) return { ok: false, reason: 'closed' };
    let text;
    try {
      text = await fsp.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // task-78：状态文件缺失本身可能是「首次启动」，但若存在降级锁存，
        // 说明上次有「限制只在内存」的落盘失败 → 必须 fail-closed，不得当成首启 normal。
        const missingFileLatch = await readDegradedLatch();
        if (missingFileLatch.present) return failClosed('load-failed');
        state = emptyState();
        state.since = now();
        degraded = false;
        degradeReason = null;
        return { ok: true, state: 'normal' };
      }
      return failClosed('load-failed');
    }
    let parsed;
    try {
      if (typeof text === 'string' && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      parsed = JSON.parse(text);
    } catch {
      return failClosed('state-corrupt');
    }
    const valid = validateLoadedState(parsed);
    if (!valid.ok) return failClosed(valid.reason);
    // task-78：latch 复核（在提交加载结果之前）。
    // · 不可读/不可解析 → 无法证明「磁盘上的限制与内存一致」→ fail-closed；
    // · 磁盘状态 rank 不足 latch.intendedRank → 上次的限制增加只落在内存 → fail-closed；
    // · 否则视为陈旧锁存，删除后正常加载（不得误判）。
    const latch = await readDegradedLatch();
    if (latch.present) {
      if (!latch.valid) return failClosed('load-failed');
      if (STATE_RANK[parsed.state] < latch.latch.intendedRank) return failClosed('load-failed');
      try { await fsp.unlink(degradedLatchPath); } catch { /* 删除失败不影响加载结果 */ }
    }
    state = normalizeState(parsed);
    state.degraded = parsed.degraded === true;
    degraded = state.degraded;
    degradeReason = degraded ? 'degraded' : null;
    return { ok: true, state: state.state };
  }

  return {
    load() {
      return enqueue(applyLoad);
    },
    snapshot() {
      const snap = {
        state: state.state,
        since: state.since,
        anomalyId: state.anomalyId,
        anomalyKind: state.anomalyKind,
        skipReason: state.skipReason,
        // task-80（P2-1 四类成因）：degraded 的**成因**，纯可观测字段，不得据此放行/恢复。
        // 取值：null（未降级）/ 'persist-failed'（落盘失败，类1）/ 白名单 skipReason（failClosed，类2）/
        // 'degraded'（从磁盘读到的陈旧标记，类4）。注意类3 的判据是组合
        // （degradeReason==='persist-failed' 且 skipReason!==null），不是本字段的某个取值。
        // 为什么单列：`skipReason` 是「state 文件为何不可读」的**历史**记录，会在 case 1 修复后继续留在
        // state 里；只看 skipReason 会把「损坏后修复、随后落盘又失败」误判成类2（说「这不是落盘失败」）。
        degradeReason: degraded ? degradeReason : null,
        // task-77：损坏态是否允许发起受控补报（控制台据此诚实展示按钮；仍不构成恢复依据）
        controlledRecoveryAvailable: controlledRecoveryApplicable(state),
        // 接线自检用：最近一次身份检查结果（null=未知）；不得据此放行，只能用于告警/恢复
        identityOk: state.identityOk,
        notify: {
          status: state.notify.status,
          operationId: state.notify.operationId,
          attempts: state.notify.attempts,
          lastAt: state.notify.lastAt,
          lastCode: state.notify.lastCode,
          // task-69：已达重发上限（failed/unknown），接线据此停止自动重发。
          // task-75：纯可观测字段，**不得作为手动恢复依据**（回执只看 status==='delivered' && operationId===anomalyId）。
          retriesExhausted: notifyExhausted(state),
        },
        restoreNotify: {
          status: state.restoreNotify.status,
          operationId: state.restoreNotify.operationId,
          attempts: state.restoreNotify.attempts,
          lastAt: state.restoreNotify.lastAt,
          lastCode: state.restoreNotify.lastCode,
        },
        manualRecovery: {
          required: state.state === 'all-paused' || state.manualRecovery?.required === true,
          lastRejectReason: state.manualRecovery?.lastRejectReason ?? null,
          // task-75 §2.1 / task-77：唯一口径 = 同一异常事件的真实 delivered 回执。
          // 'corruption-acknowledged' 已随 corruptionAck 例外删除；受控补报拿到真实回执后同样显示 'delivered'。
          reportReceiptBasis: deriveReportReceiptBasis(state),
        },
        degraded,
        // task-83 F2：最近一次「降级锁存写失败」的事实（纯可观测，不参与判定、不据此放行/恢复）。
        // true 的含义：persist 失败之后，连「限制只在内存」的锁存都没写成功 ⇒ 一旦重启，
        // 该限制会静默消失且磁盘无痕（报告 §3 P2）。运维看到它应当先修磁盘/权限再处置，
        // **不要用重启「解决」**——重启正是会丢掉限制的那一步。
        degradedLatchWriteFailed: degraded === true && latchWriteFailed === true,
        // m01388：有效状态。state 是事实状态（例如磁盘 normal + degraded:true 可加载），
        // 接线侧（task-64 §C-2）必须按「degraded 视同 all-paused」判定；给明确字段避免误读 state。
        effectiveState: degraded ? 'all-paused' : state.state,
      };
      return snap;
    },
    reportAnomaly({ kind, detail } = {}) {
      return enqueue(async () => {
        if (!ANOMALY_KIND_SET.has(kind)) return { ok: false, reason: 'invalid-argument' };
        if (typeof detail !== 'string' || !DETAIL_RE.test(detail)) return { ok: false, reason: 'invalid-argument' };
        return applyAnomaly(kind, detail);
      });
    },
    reportNotifyResult({ operationId, outcome, code } = {}) {
      return enqueue(async () => applyNotifyResult({ operationId, outcome, code }));
    },
    evaluateNotifyDeadline() {
      return enqueue(applyDeadline);
    },
    reportIdentityRestored({ identityOk } = {}) {
      return enqueue(async () => applyIdentityRestored({ identityOk }));
    },
    reportRestoreNotifyResult({ operationId, outcome, code } = {}) {
      return enqueue(async () => applyRestoreNotifyResult({ operationId, outcome, code }));
    },
    recoverManually({ identityOk, qqCommsOk, reportDelivered, code } = {}) {
      return enqueue(async () => {
        if (code !== undefined && !validCode(code)) return { ok: false, reason: 'invalid-argument' };
        // reportDelivered 仅为兼容旧调用方保留；回执判定一律由内部状态复核（§2.4）
        return applyManualRecovery({ identityOk, qqCommsOk, reportDelivered });
      });
    },
    declareControlledRecoveryAnomaly({ detail } = {}) {
      return enqueue(async () => applyDeclareControlledRecoveryAnomaly({ detail }));
    },
    retryPersist() {
      return enqueue(applyRetryPersist);
    },
    resendNotify({ operationId } = {}) {
      return enqueue(async () => applyResendNotify({ operationId }));
    },
    close() {
      return enqueue(async () => {
        closed = true;
        return { ok: true };
      });
    },
  };
}
