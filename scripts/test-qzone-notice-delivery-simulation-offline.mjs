import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { settleOfflineWrite } from '../src/core/qzone-settlement-offline.mjs';
import { finishOfflineProbe } from '../src/core/qzone-recovery-offline.mjs';
import { simulateOfflineNoticeDelivery } from '../src/core/qzone-notice-delivery-simulation-offline.mjs';

async function withStore(t, state) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-notice-delivery-'));
  let db = openOfflineStore(join(dir, 'state.sqlite'), { offlineTestFixture: true, ...state });
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    get db() { return db; },
    reopen() { db.close(); db = openOfflineStore(join(dir, 'state.sqlite'), state); return db; },
  };
}

test('三次真实离线结算生成通知，模拟成功持久化且重开后不重复领取', async (t) => {
  const holder = await withStore(t, { reads: 0, writes: 0, accessPaused: false, writePaused: false,
    ledger: { day: '2026-11-09', used: { post: 0, comment: 3, like: 0 }, reservations: { a: 'comment', b: 'comment', c: 'comment' } },
    outcomes: {}, notices: [] });
  settleOfflineWrite(holder.db, 'a', 'failure', 1);
  settleOfflineWrite(holder.db, 'b', 'failure', 2);
  settleOfflineWrite(holder.db, 'c', 'failure', 3);
  const result = simulateOfflineNoticeDelivery(holder.db, [{ index: 0, result: 'success' }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'sent');
  assert.equal(result[0].message, 'QQ空间写入连续失败，写入已暂停。请管理员检查状态并手动处理。');
  assert.equal(holder.db.read().notices[0].delivery, 'sent');
  holder.reopen();
  assert.deepEqual(simulateOfflineNoticeDelivery(holder.db, [{ index: 0, result: 'success' }]), []);
  assert.equal(holder.db.read().notices[0].delivery, 'sent');
});

test('不带测试夹具标记的状态不得被模拟器标记为已送达', async (t) => {
  const holder = await withStore(t, { offlineTestFixture: false, notices: [{ layer: 'write', cause: 'failure', operationId: 'op1' }] });
  assert.throws(() => simulateOfflineNoticeDelivery(holder.db, [{ index: 0, result: 'success' }]), /fixture/);
  assert.equal(holder.db.read().notices[0].delivery, undefined);
});

test('探测失败经离线结算入队，明确模拟失败保留待重试且不暴露夹具或凭据', async (t) => {
  const holder = await withStore(t, { accessPaused: true, writePaused: false, pausedAt: 1, probe: 'claimed', probeId: 'probe-1', notices: [] });
  finishOfflineProbe(holder.db, 'probe-1', 'failure', 'network');
  const outcomes = simulateOfflineNoticeDelivery(holder.db, [{ index: 0, result: 'failure' }]);
  assert.equal(outcomes[0].status, 'pending');
  assert.equal(outcomes[0].message, 'QQ空间自动恢复探测失败，需管理员手动检查。');
  assert.equal(outcomes[0].message.includes('network'), false);
  assert.equal(holder.db.read().notices[0].delivery, 'pending');
  assert.equal(simulateOfflineNoticeDelivery(holder.db, [{ index: 0, result: 'success' }])[0].status, 'sent');
});

test('未知结果持久为 unknown；重开不重发，重复索引在单轮内只领取一次', async (t) => {
  const holder = await withStore(t, { notices: [{ layer: 'access', cause: 'probe_failed', reason: 'network', operationId: 'p1' }] });
  const result = simulateOfflineNoticeDelivery(holder.db, [
    { index: 0, result: 'unknown' }, { index: 0, result: 'success' },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'unknown');
  holder.reopen();
  assert.deepEqual(simulateOfflineNoticeDelivery(holder.db, [{ index: 0, result: 'success' }]), []);
  assert.equal(holder.db.read().notices[0].delivery, 'unknown');
});

test('遗留 claimed 不恢复、不重发；格式化只使用白名单固定文案', async (t) => {
  const holder = await withStore(t, { notices: [
    { layer: 'write', cause: 'failure', operationId: 'op1', delivery: 'claimed', claimToken: 'old' },
    { layer: 'access', cause: 'unexpected-secret', reason: 'Bearer secret', operationId: 'op2' },
  ] });
  assert.deepEqual(simulateOfflineNoticeDelivery(holder.db, [
    { index: 0, result: 'success' }, { index: 1, result: 'success' },
  ]), []);
  assert.equal(holder.db.read().notices[0].delivery, 'claimed');
  assert.equal(holder.db.read().notices[1].delivery, undefined);
});

test('拒绝任意发送回调和未预定结果', async (t) => {
  const holder = await withStore(t, { notices: [{ layer: 'write', cause: 'failure', operationId: 'op1' }] });
  assert.throws(() => simulateOfflineNoticeDelivery(holder.db, () => 'success'), /fixtures/);
  assert.throws(() => simulateOfflineNoticeDelivery(holder.db, [{ index: 0, result: 'sent' }]), /fixture/);
  assert.equal(holder.db.read().notices[0].delivery, undefined);
});
