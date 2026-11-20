import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineHostEventCoordinator } from './owner-session-patrol-host-events-prototype.mjs';

test('只有被登记的消息关联的真实回合结束才产生一次决定', () => {
  const a = createOfflineHostEventCoordinator();
  a.begin({ sessionId: 's', messageId: 'patrol' });
  a.hostStep({ sessionId: 's', turn: 7, messages: [{ id: 'patrol' }] });
  a.hostEvent({ sessionId: 's', event: { type: 'turn/end', data: { turn: 6 } } });
  assert.equal(a.decisions.length, 0);
  a.hostEvent({ sessionId: 's', event: { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } } });
  a.hostEvent({ sessionId: 's', event: { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } } });
  assert.equal(a.decisions.length, 1);
  assert.equal(a.decisions[0].share, true);
});

test('来信在回合结束前到达时不分享，其他会话不能干扰', () => {
  const a = createOfflineHostEventCoordinator();
  a.begin({ sessionId: 's', messageId: 'p' });
  a.hostStep({ sessionId: 's', turn: 3, messages: [{ id: 'p' }] });
  a.ownerMessage({ sessionId: 'other', messageId: 'x' });
  a.ownerMessage({ sessionId: 's', messageId: 'm' });
  a.hostEvent({ sessionId: 's', event: { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } } });
  assert.equal(a.decisions[0].share, false);
  assert.deepEqual(a.decisions[0].ownerMessages, ['m']);
});

test('缺少消息关联时不因同会话旧结束帧决定分享', () => {
  const a = createOfflineHostEventCoordinator();
  a.begin({ sessionId: 's', messageId: 'p' });
  a.hostStep({ sessionId: 's', turn: 4, messages: [{ id: 'another' }] });
  a.hostEvent({ sessionId: 's', event: { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } } });
  assert.equal(a.decisions.length, 0);
});

test('已认证来信处理尚未完成时，回合结束也不得误判可以分享', async () => {
  const a = createOfflineHostEventCoordinator();
  a.begin({ sessionId: 's', messageId: 'p' });
  a.hostStep({ sessionId: 's', turn: 4, messages: [{ id: 'p' }] });
  let finish;
  const pending = a.receiveOwner({ sessionId: 's', messageId: 'm', receive: () => new Promise(r => { finish = r; }) });
  a.hostEvent({ sessionId: 's', event: { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } } });
  assert.equal(a.decisions[0].share, false);
  finish(); await pending;
});

for (const kind of ['error', 'aborted', 'blocked', 'max-tokens', undefined, null]) {
  test(`回合结束原因 ${String(kind)} 不产生分享许可`, () => {
    const a = createOfflineHostEventCoordinator();
    a.begin({ sessionId: 's', messageId: 'p' });
    a.hostStep({ sessionId: 's', turn: 4, messages: [{ id: 'p' }] });
    a.hostEvent({ sessionId: 's', event: { type: 'turn/end', data: { turn: 4, reason: kind ? { kind } : undefined } } });
    assert.equal(a.decisions.length, 0);
    assert.equal(a.begin({ sessionId: 's', messageId: 'next' }), true, '非正常结束必须释放样品状态');
  });
}

test('事件流断开使旧任务失效，重连后迟到帧不能结束新任务', () => {
  const a = createOfflineHostEventCoordinator();
  a.begin({ sessionId: 's', messageId: 'old' });
  a.hostStep({ sessionId: 's', turn: 3, messages: [{ id: 'old' }] });
  a.disconnect();
  assert.equal(a.begin({ sessionId: 's', messageId: 'new' }), true);
  a.hostStep({ sessionId: 's', turn: 4, messages: [{ id: 'new' }] });
  a.hostEvent({ sessionId: 's', event: { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } } });
  assert.equal(a.decisions.length, 0);
  a.hostEvent({ sessionId: 's', event: { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } } });
  assert.equal(a.decisions.length, 1);
});

test('会话重建后旧 session 的结束事件不影响新 session', () => {
  const a = createOfflineHostEventCoordinator();
  a.begin({ sessionId: 'old', messageId: 'p1' });
  a.hostStep({ sessionId: 'old', turn: 1, messages: [{ id: 'p1' }] });
  a.disconnect();
  a.begin({ sessionId: 'new', messageId: 'p2' });
  a.hostStep({ sessionId: 'new', turn: 1, messages: [{ id: 'p2' }] });
  a.hostEvent({ sessionId: 'old', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } });
  assert.equal(a.decisions.length, 0);
  a.hostEvent({ sessionId: 'new', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } });
  assert.equal(a.decisions.length, 1);
});

test('流世代不同，即使会话和回合号复用旧回调也不能结束新巡逻', () => {
  const a = createOfflineHostEventCoordinator();
  const oldStream = a.createStream();
  a.begin({ sessionId: 's', messageId: 'old' });
  oldStream.hostStep({ sessionId: 's', turn: 1, messages: [{ id: 'old' }] });
  a.disconnect();
  const newStream = a.createStream();
  a.begin({ sessionId: 's', messageId: 'new' });
  newStream.hostStep({ sessionId: 's', turn: 1, messages: [{ id: 'new' }] });
  const end = { sessionId: 's', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } };
  oldStream.hostEvent(end);
  assert.equal(a.decisions.length, 0);
  newStream.hostEvent(end);
  assert.equal(a.decisions.length, 1);
});

test('替换流时未显式断连必须拒绝，避免旧任务被新流继承', () => {
  const a = createOfflineHostEventCoordinator();
  a.createStream();
  a.begin({ sessionId: 's', messageId: 'p' });
  assert.throws(() => a.createStream(), /active/);
});
