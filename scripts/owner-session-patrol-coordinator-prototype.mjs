// 离线样品；不得作为真实会话锁、发送回执或生产权限控制。
import { randomUUID } from 'node:crypto';

export function createOfflinePatrolCoordinator() {
  let active = null;
  return {
    begin({ sessionId, busy } = {}) {
      if (typeof sessionId !== 'string' || !sessionId.trim() || busy !== false || active) return { ok: false };
      active = { sessionId, taskId: randomUUID(), ownerMessages: [] };
      return { ok: true, sessionId, taskId: active.taskId };
    },
    ownerMessage({ sessionId, messageId } = {}) {
      if (!active || sessionId !== active.sessionId || typeof messageId !== 'string' || !messageId) return;
      active.ownerMessages.push(messageId);
    },
    finish({ taskId, sessionId } = {}) {
      if (!active || taskId !== active.taskId || sessionId !== active.sessionId) return { ok: false };
      const ownerMessages = active.ownerMessages.slice();
      active = null;
      return { ok: true, share: ownerMessages.length === 0, ownerMessages };
    },
  };
}
