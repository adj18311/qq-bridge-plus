import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotBoundaryExperiment } from './owner-patrol-snapshot-boundary-prototype.mjs';

const e = (seq, type, data) => ({ seq, type, data });
const start = n => e(n, 'turn/start', { turn: 1 });
const msg = n => e(n, 'user/message', { source: { kind: 'user', rpcId: 'p' } });
const end = n => e(n, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
const snap = cursor => ({ type: 'snapshot', cursor, records: [start(2), msg(3), end(4)] });

test('无快照或快照坏时不开始新巡逻', () => {
  const a = createSnapshotBoundaryExperiment();
  assert.equal(a.begin({ sessionId: 's', requestId: 'p', ownerPending: false }), false);
  assert.equal(a.snapshot({ sessionId: 's', snapshot: snap(NaN) }), false);
  assert.equal(a.begin({ sessionId: 's', requestId: 'p', ownerPending: false }), false);
});
test('快照历史不触发分享；快照边界后的完整实时帧才可决定', () => {
  const a = createSnapshotBoundaryExperiment();
  assert.equal(a.snapshot({ sessionId: 's', snapshot: snap(4) }), true);
  assert.equal(a.begin({ sessionId: 's', requestId: 'p', ownerPending: false }), true);
  for (const event of [start(5), msg(6), end(7)]) a.live({ sessionId: 's', event });
  assert.deepEqual(a.results, [{ turn: 1, share: true }]);
});
test('重复/旧实时帧、跳号、重订阅期间均不误决定且不阻塞恢复', () => {
  const a = createSnapshotBoundaryExperiment(); a.snapshot({ sessionId: 's', snapshot: snap(4) });
  a.begin({ sessionId: 's', requestId: 'p', ownerPending: false });
  a.live({ sessionId: 's', event: start(5) }); a.live({ sessionId: 's', event: start(5) });
  a.live({ sessionId: 's', event: msg(6) }); a.live({ sessionId: 's', event: end(7) });
  assert.equal(a.results.length, 0);
  assert.equal(a.begin({ sessionId: 's', requestId: 'p', ownerPending: false }), false);
  a.snapshot({ sessionId: 's', snapshot: snap(9) });
  assert.equal(a.begin({ sessionId: 's', requestId: 'p', ownerPending: false }), true);
  a.live({ sessionId: 's', event: start(11) });
  assert.equal(a.begin({ sessionId: 's', requestId: 'p2', ownerPending: false }), false);
  assert.equal(a.results.length, 0);
});
test('单流中断仅使对应会话失效，旧结束帧不发分享', () => {
  const a = createSnapshotBoundaryExperiment(); a.snapshot({ sessionId: 's', snapshot: snap(4) });
  a.begin({ sessionId: 's', requestId: 'p', ownerPending: false }); a.live({ sessionId: 's', event: start(5) });
  a.followEnded({ sessionId: 'other' }); a.live({ sessionId: 's', event: msg(6) });
  a.followEnded({ sessionId: 's' }); a.live({ sessionId: 's', event: end(7) });
  assert.equal(a.results.length, 0);
  assert.equal(a.begin({ sessionId: 's', requestId: 'p2', ownerPending: false }), false);
});

test('旧订阅迟到快照不能重新打开权限，也不能覆盖新订阅', () => {
  const a = createSnapshotBoundaryExperiment();
  const old = a.openFollow({ sessionId: 's' });
  assert.equal(old.snapshot(snap(4)), true);
  old.end();
  const current = a.openFollow({ sessionId: 's' });
  assert.equal(old.snapshot(snap(4)), false);
  assert.equal(a.begin({ sessionId: 's', requestId: 'p', ownerPending: false }), false);
  assert.equal(current.snapshot(snap(10)), true);
  assert.equal(old.snapshot(snap(4)), false);
  assert.equal(a.begin({ sessionId: 's', requestId: 'p', ownerPending: false }), true);
  for (const event of [start(11), msg(12), end(13)]) current.live(event);
  assert.equal(a.results.length, 1);
});

test('管理员未读已存在时，不得开始定时机会', () => {
  const a = createSnapshotBoundaryExperiment(); a.snapshot({ sessionId: 's', snapshot: snap(4) });
  assert.equal(a.begin({ sessionId: 's', requestId: 'p' }), false, '未知未读状态时保守跳过');
  assert.equal(a.begin({ sessionId: 's', requestId: 'p', ownerPending: true }), false);
  assert.equal(a.begin({ sessionId: 's', requestId: 'p', ownerPending: false }), true);
});
