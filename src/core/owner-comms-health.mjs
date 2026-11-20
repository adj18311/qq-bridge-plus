/**
 * task-77（GPT 复核 #2）：「QQ 通信已恢复」的现算口径。
 *
 * 背景：手动恢复的第三前置条件原文是「QQ 通信已恢复」。旧实现只看
 * 「最近 10 分钟内是否有过一次成功发送回执」（`lastSendReceiptAt` 窗口），
 * 这只能证明**过去**成功过一次 —— 链路此刻已经断了也照样返回 true。
 * 用户规则 m13214 §4 要求「已恢复」，因此必须叠加**当前**连接事实。
 *
 * 判定（全部满足才算 up）：
 *   ① 最近窗口内确有一次发送接口成功回执（证明这条链路曾经真的通）；
 *   ② SnowLuma WS 当前处于已连接（`connected === true`）；
 *   ③ 上游没有自报接收链路坏（`good !== false`；null/未知不算坏，但也不算证据）；
 *   ④ 账号没有被明确报告为离线（`accountOnline !== false`）；
 *   ⑤ 确实收到过事件包，且没有落入「静默」（长时间无任何包 ⇒ 上游可能卡死）；
 *   ⑥ 没有落入「静默」判定。
 *
 * 保守方向：任何字段缺失/类型不对/抛出异常都返回 false。
 * 未知 ≠ 成功（用户规则 §5），因此本函数**永不**把「不知道」当成「已恢复」。
 *
 * ── task-78（GPT 第三轮复核 #4）：这个函数回答的到底是什么 ──────────────
 * 它回答的是**「现有证据是否足以放行管理员手动恢复」**（一个门禁问题），
 * 而**不是**「账号此刻一定在线」（一个事实问题）。两者不可混为一谈：
 *
 *   · ③④ 两条用的是「未明确报坏就放行」的**可用性折中**（availability tradeoff）：
 *     老运行时不上报 `good`/`accountOnline`（值为 null/undefined），若要求必须
 *     `=== true`，则这些运行时下**永远**无法恢复 —— 那是把「未知」当成「坏」，
 *     同样是拿未知当结论，只是方向相反，且会把保护锁死（task-72 P1-C 同类缺陷）。
 *   · 因此「up === true」**只表示**：有真实发送回执 + WS 当前连着 + 事件包在流动，
 *     且上游没有给出任何明确的坏信号。它**不**证明账号在线、不证明消息能被读走、
 *     不证明对端可达。
 *   · 需要区分这两种语义的调用方（控制台展示、审计文案）必须用
 *     `describeOwnerComms()` 拿 `evidence` 与 `unknownTolerated`，不要自己从布尔反推。
 *
 * ── 验证强度的边界（诚实声明，勿在汇报里夸大）──────────────────────────
 * 本模块的全部证据来自**纯函数单测**与**静态接线断言**：它们只能证明「给定这些
 * facts 时判定是什么」，**不能**证明真实传输层断连时 facts 会如实变化。后者需要
 * 真实桥接 + 真实 SnowLuma 的运行时验证，属于用户授权事项，当前未做。
 */

/** 最近一次成功回执的有效窗口（与巡逻停摆去重保持一致：10 分钟）。 */
export const OWNER_COMMS_RECEIPT_WINDOW_MS = 10 * 60 * 1000;

/**
 * 详细判定：返回布尔门禁结果 + 证据强度，供展示/审计区分「确认在线」与「容忍未知」。
 *
 * @param {object} facts 见 {@link ownerCommsCurrentlyUp}
 * @returns {{up: boolean, evidence: 'confirmed'|'tolerated-unknown'|'insufficient',
 *            unknownTolerated: string[], failedOn: string|null}}
 *   · `evidence='confirmed'`        —— 上游明确报了好（good===true 且 accountOnline===true）；
 *   · `evidence='tolerated-unknown'`—— 门禁放行，但 good/accountOnline 至少一项为未知；
 *   · `evidence='insufficient'`     —— 门禁拒绝（`failedOn` 给出第一条不满足项）。
 */
export function describeOwnerComms(facts = {}) {
  const unknownTolerated = [];
  /** @type {string|null} */
  let failedOn = null;
  try {
    const now = Number.isFinite(facts.now) ? facts.now : Date.now();
    const windowMs = Number.isFinite(facts.receiptWindowMs) && facts.receiptWindowMs > 0
      ? facts.receiptWindowMs
      : OWNER_COMMS_RECEIPT_WINDOW_MS;

    // ① 曾经真的收到过发送接口回执，且还在窗口内
    const receiptAt = facts.lastSendReceiptAt;
    if (!Number.isFinite(receiptAt) || receiptAt <= 0) failedOn = 'no-send-receipt';
    else {
      const age = now - receiptAt;
      if (!(age >= 0 && age <= windowMs)) failedOn = 'send-receipt-stale';
    }

    // ② WS 必须当前是连着的（断线 = 现在发不出去）
    if (failedOn === null && facts.connected !== true) failedOn = 'ws-not-connected';

    // ③ 上游自报接收链路坏 → 消息进不来，不算恢复；未知则**放行但记录为折中**
    if (failedOn === null) {
      if (facts.good === false) failedOn = 'upstream-good-false';
      else if (facts.good !== true) unknownTolerated.push('good');
    }

    // ④ 账号明确离线 → 不算恢复；未知同样放行但记录
    if (failedOn === null) {
      if (facts.accountOnline === false) failedOn = 'account-offline';
      else if (facts.accountOnline !== true) unknownTolerated.push('accountOnline');
    }

    // ⑤ 至少要观测到过一次事件包（连心跳都没有说明链路没真正跑起来）
    if (failedOn === null) {
      const lastPacketAt = facts.lastPacketAt;
      if (!Number.isFinite(lastPacketAt) || lastPacketAt <= 0) failedOn = 'no-event-packet';
    }

    // ⑥ 静默（长时间无任何包）说明上游可能卡死，不是「已恢复」
    if (failedOn === null && facts.silent === true) failedOn = 'silent';

    if (failedOn !== null) {
      return { up: false, evidence: 'insufficient', unknownTolerated: [], failedOn };
    }
    return {
      up: true,
      evidence: unknownTolerated.length === 0 ? 'confirmed' : 'tolerated-unknown',
      unknownTolerated,
      failedOn: null,
    };
  } catch {
    // 未知 ≠ 成功：任何异常都按「未恢复」处理，调用方据此拒绝手动恢复。
    return { up: false, evidence: 'insufficient', unknownTolerated: [], failedOn: 'exception' };
  }
}

/**
 * @param {object} facts
 * @param {number|null|undefined} facts.lastSendReceiptAt 最近一次成功发送回执的时间戳（ms）
 * @param {number} [facts.now] 当前时间（ms），便于测试注入
 * @param {number} [facts.receiptWindowMs] 回执窗口，默认 10 分钟
 * @param {boolean|null|undefined} facts.connected SnowLuma WS 是否已连接
 * @param {boolean|null|undefined} facts.good SnowLuma 自评的接收链路健康度（false = 确认坏了）
 * @param {boolean|null|undefined} facts.accountOnline 账号是否在线（null = 老运行时不上报）
 * @param {number|null|undefined} facts.lastPacketAt 最近一个事件包的时间戳（ms）
 * @param {boolean} [facts.silent] 是否已被判定为静默
 * @returns {boolean} 门禁结果（true ≠ 账号一定在线，见文件头「这个函数回答的到底是什么」）
 */
export function ownerCommsCurrentlyUp(facts = {}) {
  return describeOwnerComms(facts).up;
}
