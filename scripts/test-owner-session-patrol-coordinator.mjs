import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfflinePatrolCoordinator } from './owner-session-patrol-coordinator-prototype.mjs';

test('空闲机会保留当前管理员 session；占用时不重复派发', () => {
  const coordinator = createOfflinePatrolCoordinator();
  const first = coordinator.begin({ sessionId: 'owner-session', busy: false });
  assert.equal(first.ok, true);
  assert.equal(first.sessionId, 'owner-session');
  assert.equal(coordinator.begin({ sessionId: 'owner-session', busy: false }).ok, false);
  assert.equal(createOfflinePatrolCoordinator().begin({ sessionId: 'owner-session', busy: true }).ok, false);
});

test('巡逻期间管理员来信抑制自主分享，且原消息可交还调用方', () => {
  const coordinator = createOfflinePatrolCoordinator();
  const first = coordinator.begin({ sessionId: 'owner-session', busy: false });
  coordinator.ownerMessage({ sessionId: 'owner-session', messageId: 'owner-1' });
  const result = coordinator.finish({ taskId: first.taskId, sessionId: 'owner-session' });
  assert.equal(result.share, false);
  assert.deepEqual(result.ownerMessages, ['owner-1']);
});

test('普通结束最多产生一次分享决策，旧任务不能结束新任务', () => {
  const coordinator = createOfflinePatrolCoordinator();
  const first = coordinator.begin({ sessionId: 'owner-session', busy: false });
  assert.equal(coordinator.finish({ taskId: first.taskId, sessionId: 'owner-session' }).share, true);
  const second = coordinator.begin({ sessionId: 'owner-session', busy: false });
  assert.equal(coordinator.finish({ taskId: first.taskId, sessionId: 'owner-session' }).ok, false);
  assert.equal(coordinator.finish({ taskId: second.taskId, sessionId: 'owner-session' }).share, true);
});

test('不同 session 的来信不会干扰当前巡逻，session 失配不可结束', () => {
  const coordinator = createOfflinePatrolCoordinator();
  const first = coordinator.begin({ sessionId: 'owner-session', busy: false });
  coordinator.ownerMessage({ sessionId: 'other-session', messageId: 'other-1' });
  assert.equal(coordinator.finish({ taskId: first.taskId, sessionId: 'other-session' }).ok, false);
  assert.equal(coordinator.finish({ taskId: first.taskId, sessionId: 'owner-session' }).share, true);
});

test('已知限制：收尾后才到达的管理员来信不能撤回已经给出的分享许可', () => {
  const coordinator = createOfflinePatrolCoordinator();
  const task = coordinator.begin({ sessionId: 'owner-session', busy: false });
  const decision = coordinator.finish({ taskId: task.taskId, sessionId: 'owner-session' });
  coordinator.ownerMessage({ sessionId: 'owner-session', messageId: 'late-owner' });
  assert.equal(decision.share, true, '样品无发送临界区；许可后新来信不能倒转已返回的值');
  assert.deepEqual(decision.ownerMessages, []);
});
