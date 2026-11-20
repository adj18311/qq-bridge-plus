/**
 * 后台巡逻第三阶段：把后台 prompt 精确关联到其 DSH 回合。
 *
 * 本模块不发送 QQ、不访问 DSH，也不决定人格、模型或工具权限。它只记录桥接自己生成的
 * requestId。只有调用方已经从 DSH 获得同一条请求与 turn 的明确关联证据时，才可用
 * `bindTurn()` 绑定。没有精确匹配时永远返回 false（即桥接按原逻辑转发），因此绝不能
 * 用 session 级“静默”、事件顺序或时间猜测误吞正常 QQ 回复。
 */

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PENDING = 64;

function validNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function validTurn(value) {
  return (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.length > 0);
}

function turnKey(sessionId, turn) {
  return `${sessionId}\u0000${typeof turn}:${String(turn)}`;
}

/**
 * @param {{ now?: () => number, ttlMs?: number, maxPending?: number }} [options]
 * @returns {{ registerPrompt: Function, cancelPrompt: Function, bindTurn: Function,
 *   consumeTurn: Function, clearSession: Function, snapshot: Function }}
 */
export function createBackgroundPatrolOutputGate(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const maxPending = Number.isInteger(options.maxPending) && options.maxPending > 0
    ? options.maxPending : DEFAULT_MAX_PENDING;

  // requestId -> { sessionId, at }; 只接受 bridge 明确登记的后台 prompt。
  const pending = new Map();
  // sessionId + turn -> at；完成时一次性消费。
  const markedTurns = new Map();

  function atNow() {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  }

  function purge(at = atNow()) {
    const oldest = at - ttlMs;
    for (const [requestId, marker] of pending) {
      if (marker.at < oldest) pending.delete(requestId);
    }
    for (const [key, markerAt] of markedTurns) {
      if (markerAt < oldest) markedTurns.delete(key);
    }
  }

  function trimPending() {
    while (pending.size > maxPending) {
      const oldest = pending.keys().next().value;
      pending.delete(oldest);
    }
  }

  function registerPrompt({ sessionId, requestId }) {
    if (!validNonEmptyString(sessionId)) throw new TypeError('background patrol sessionId 必须是非空字符串');
    if (!validNonEmptyString(requestId)) throw new TypeError('background patrol requestId 必须是非空字符串');
    const at = atNow();
    purge(at);
    pending.set(requestId, { sessionId, at });
    trimPending();
    return requestId;
  }

  function cancelPrompt({ requestId }) {
    if (!validNonEmptyString(requestId)) return false;
    const existed = pending.delete(requestId);
    return existed;
  }

  /**
   * 把已被外部协议证据确认的 requestId 精确绑定到 turn。
   * 注意：不能用「user/message 后的下一个 turn/start」推断；同会话队列可能交错，
   * 这种猜测会把后台标记错绑到普通 QQ 回合。
   */
  function bindTurn({ sessionId, requestId, turn }) {
    if (!validNonEmptyString(sessionId) || !validNonEmptyString(requestId) || !validTurn(turn)) return false;
    const at = atNow();
    purge(at);
    const marker = pending.get(requestId);
    if (!marker || marker.sessionId !== sessionId) return false;
    pending.delete(requestId);
    markedTurns.set(turnKey(sessionId, turn), at);
    return true;
  }

  /** 只在 turn/end 收尾时调用；无匹配/重复调用都 fail-open。 */
  function consumeTurn({ sessionId, turn }) {
    if (!validNonEmptyString(sessionId) || !validTurn(turn)) return false;
    purge();
    const key = turnKey(sessionId, turn);
    const existed = markedTurns.has(key);
    markedTurns.delete(key);
    return existed;
  }

  function clearSession(sessionId) {
    if (!validNonEmptyString(sessionId)) return;
    for (const [requestId, marker] of pending) {
      if (marker.sessionId === sessionId) pending.delete(requestId);
    }
    for (const key of markedTurns.keys()) {
      if (key.startsWith(`${sessionId}\u0000`)) markedTurns.delete(key);
    }
  }

  function snapshot() {
    purge();
    return Object.freeze({
      pending: pending.size,
      markedTurns: markedTurns.size,
    });
  }

  return { registerPrompt, cancelPrompt, bindTurn, consumeTurn, clearSession, snapshot };
}
