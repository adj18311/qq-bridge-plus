// Offline experiment only: awaitTurn and ownerMessage are supplied by the fixture,
// not authoritative host events. Never use this as a production session lock.
import { createBackgroundPatrolScheduler } from '../src/core/background-patrol-scheduler.mjs';
import { createOfflinePatrolCoordinator } from './owner-session-patrol-coordinator-prototype.mjs';

export function createOfflineOwnerPatrolWiring({ clock, sessionId, ownerKey, deliverPrompt, awaitTurn, getAvailability, hasOwnerUnread, onDecision, onEvent }) {
  const coordinator = createOfflinePatrolCoordinator();
  const scheduler = createBackgroundPatrolScheduler({ clock, random: () => 0, getAvailability, onEvent,
    async run({ platform }) {
      // 离线接缝：未知未读状态时不投递；此检查没有解决检查后新消息的竞态。
      if (typeof hasOwnerUnread !== 'function' || hasOwnerUnread() !== false) {
        onEvent?.({ type: 'skipped', reason: 'owner-unread', platform });
        return;
      }
      const task = coordinator.begin({ sessionId, busy: false });
      if (!task.ok) return;
      let completed = false;
      try {
        const result = await deliverPrompt(ownerKey, `离线巡逻机会：${platform}`, { backgroundPatrol: true });
        if (!result.ok || result.sessionId !== sessionId) return;
        await awaitTurn({ sessionId, taskId: task.taskId, platform });
        completed = true;
      } finally {
        const decision = coordinator.finish({ sessionId, taskId: task.taskId });
        if (completed && decision.ok) onDecision(decision);
      }
    },
  });
  return { start: scheduler.start, stop: scheduler.stop, snapshot: scheduler.snapshot,
    ownerMessage: message => coordinator.ownerMessage(message) };
}
