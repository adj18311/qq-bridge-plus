import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfflinePatrolSendGate } from './owner-patrol-send-gate-prototype.mjs';

test('巡逻期间管理员来信先于发送，禁止本次主动发送；结束后正常回复不受禁令影响', () => {
  const g = createOfflinePatrolSendGate();
  assert.equal(g.begin({ sessionId: 's', turn: 1 }), true);
  g.ownerArrived({ sessionId: 's' });
  assert.equal(g.claimSend({ sessionId: 's', turn: 1 }).allow, false);
  assert.equal(g.finish({ sessionId: 's', turn: 1 }), true);
  assert.equal(g.claimSend({ sessionId: 's', turn: 2 }).kind, 'not-patrol');
});
test('发送决定先于来信则该次许可不撤回，后续新的发送重新判断', () => {
  const g = createOfflinePatrolSendGate(); g.begin({ sessionId: 's', turn: 1 });
  const first = g.claimSend({ sessionId: 's', turn: 1 });
  g.ownerArrived({ sessionId: 's' });
  assert.equal(first.allow, true);
  assert.equal(g.claimSend({ sessionId: 's', turn: 1 }).allow, false);
});
test('旧回合不能关闭新回合，不同会话互不干扰', () => {
  const g = createOfflinePatrolSendGate(); g.begin({ sessionId: 's', turn: 2 });
  g.ownerArrived({ sessionId: 'other' });
  assert.equal(g.finish({ sessionId: 's', turn: 1 }), false);
  assert.equal(g.claimSend({ sessionId: 's', turn: 2 }).allow, true);
});

test('订阅中断后不可信结束帧不得解除发送保护；仅确认旧回合停止后释放', () => {
  const g = createOfflinePatrolSendGate(); g.begin({ sessionId: 's', turn: 1 });
  g.interrupt({ sessionId: 's' });
  assert.equal(g.claimSend({ sessionId: 's', turn: 1 }).allow, false);
  assert.equal(g.finish({ sessionId: 's', turn: 1 }), false);
  assert.equal(g.confirmStopped({ sessionId: 's', turn: 1, stopped: false }), false);
  assert.equal(g.confirmStopped({ sessionId: 's', turn: 1, stopped: true }), true);
  assert.equal(g.claimSend({ sessionId: 's', turn: 2 }).kind, 'not-patrol');
});

test('空闲探测等待期间观察到新回合，不得用旧结果释放', async () => {
  const g = createOfflinePatrolSendGate(); g.begin({ sessionId: 's', turn: 1 }); g.interrupt({ sessionId: 's' });
  let done; const probe = g.probeStopped({ sessionId: 's', turn: 1, query: () => new Promise(r => { done = r; }) });
  g.observeTurnStart({ sessionId: 's', turn: 2 });
  done({ sessionId: 's', running: false });
  assert.equal(await probe, false);
  assert.equal(g.claimSend({ sessionId: 's', turn: 2 }).allow, false);
});
test('探测异常、字段缺失、错误会话或 running=true 不得释放', async () => {
  for (const result of [null, { sessionId: 's' }, { sessionId: 'wrong', running: false }, { sessionId: 's', running: true }]) {
    const g = createOfflinePatrolSendGate(); g.begin({ sessionId: 's', turn: 1 }); g.interrupt({ sessionId: 's' });
    assert.equal(await g.probeStopped({ sessionId: 's', turn: 1, query: async () => result }), false);
    assert.equal(g.claimSend({ sessionId: 's', turn: 1 }).allow, false);
  }
  const g = createOfflinePatrolSendGate(); g.begin({ sessionId: 's', turn: 1 }); g.interrupt({ sessionId: 's' });
  assert.equal(await g.probeStopped({ sessionId: 's', turn: 1, query: async () => { throw new Error('offline'); } }), false);
});
test('无新事件且目标明确空闲的样品探测可释放，别的会话的事件不影响', async () => {
  const g = createOfflinePatrolSendGate(); g.begin({ sessionId: 's', turn: 1 }); g.interrupt({ sessionId: 's' });
  const ok = await g.probeStopped({ sessionId: 's', turn: 1, query: async () => {
    g.observeTurnStart({ sessionId: 'other', turn: 3 });
    return { sessionId: 's', running: false };
  } });
  assert.equal(ok, true);
  assert.equal(g.claimSend({ sessionId: 's', turn: 2 }).kind, 'not-patrol');
});
