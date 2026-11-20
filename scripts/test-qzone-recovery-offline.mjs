import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import * as recovery from '../src/core/qzone-recovery-offline.mjs';

test('管理员空间探测的领取与结果分别和审计同事务，重启后仍能关联', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-probe-audit-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'state.db');
  const initial = { enabled: true, accessPaused: true, writePaused: true, pausedAt: 1000,
    probe: 'waiting', notices: [], audit: [] };
  db = openOfflineStore(file, initial);
  const now = 1000 + 86400000;
  const opts = { now, enabled: true, serviceReady: true, activeTime: true };
  assert.equal(recovery.claimAuditedOfflineProbe(db, 'probe-test', '123456', opts).claimed, true);
  assert.equal(db.read().audit[0].record.source, 'health_probe');
  assert.equal(db.read().audit[0].record.target, '123456');
  assert.equal(db.read().audit[0].record.result, 'unknown');
  db.close(); db = openOfflineStore(file, initial);
  recovery.finishAuditedOfflineProbe(db, 'probe-test', 'success', now + 1);
  const state = db.read();
  assert.equal(state.accessPaused, false);
  assert.equal(state.writePaused, false);
  assert.deepEqual(state.audit.map(x => x.record.result), ['unknown', 'success']);
  assert.ok(state.audit.every(x => x.record.target === '123456'));
});

test('探测审计不可用或探测结果时间倒退时不改变熔断状态', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-probe-audit-fail-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, accessPaused: true, writePaused: true,
    pausedAt: 1000, probe: 'waiting', notices: [], audit: null });
  const now = 1000 + 86400000;
  const opts = { now, enabled: true, serviceReady: true, activeTime: true };
  assert.throws(() => recovery.claimAuditedOfflineProbe(db, 'p', '123456', opts));
  assert.equal(db.read().probe, 'waiting');
  db.update(s => ({ ...s, audit: [] }));
  recovery.claimAuditedOfflineProbe(db, 'p', '123456', opts);
  assert.throws(() => recovery.finishAuditedOfflineProbe(db, 'p', 'success', now - 1));
  assert.equal(db.read().accessPaused, true);
  assert.equal(db.read().probe, 'claimed');
  recovery.finishAuditedOfflineProbe(db, 'p', 'failure', now + 1, 'network');
  assert.equal(db.read().probe, 'manual_only');
  assert.equal(db.read().notices[0].cause, 'probe_failed');
  assert.equal(db.read().audit[1].record.reason, 'network');
});

test('确认探测未调用网络后释放领取，保留自动机会且不记失败', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-probe-unsent-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = 1000 + 86400000;
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, accessPaused: true, writePaused: true,
    pausedAt: 1000, probe: 'waiting', notices: [], audit: [] });
  recovery.claimAuditedOfflineProbe(db, 'unsent', '123', { now, enabled: true, serviceReady: true, activeTime: true });
  assert.equal(recovery.releaseAuditedUnsentOfflineProbe(db, 'unsent', now + 1, true).released, true);
  const state = db.read();
  assert.equal(state.probe, 'waiting');
  assert.equal(state.probeId, 'unsent');
  assert.equal(state.accessPaused, true);
  assert.equal(state.writePaused, true);
  assert.deepEqual(state.notices, []);
  assert.deepEqual(state.audit.map(x => x.record.result), ['unknown', 'denied']);
  assert.equal(state.audit[1].record.reason, 'policy');
  assert.equal(state.audit[1].record.content, 'not_dispatched');
  assert.equal(recovery.claimAuditedOfflineProbe(db, 'retry', '123', { now: now + 86400000,
    enabled: true, serviceReady: true, activeTime: true }).claimed, true);
});

test('未证明零网络调用、时钟倒退或领取关联损坏时释放拒绝且状态不变', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-probe-unsent-reject-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = 1000 + 86400000;
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, accessPaused: true, writePaused: false,
    pausedAt: 1000, probe: 'waiting', notices: [], audit: [] });
  recovery.claimAuditedOfflineProbe(db, 'unsent2', '123', { now, enabled: true, serviceReady: true, activeTime: true });
  const before = db.read();
  assert.throws(() => recovery.releaseAuditedUnsentOfflineProbe(db, 'unsent2', now + 1, false));
  assert.throws(() => recovery.releaseAuditedUnsentOfflineProbe(db, 'unsent2', now - 1, true));
  assert.deepEqual(db.read(), before);
  db.update(s => ({ ...s, audit: [] }));
  const damaged = db.read();
  assert.throws(() => recovery.releaseAuditedUnsentOfflineProbe(db, 'unsent2', now + 1, true));
  assert.deepEqual(db.read(), damaged);
});

test('未派发结果审计冲突时领取与暂停保持不变', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-probe-unsent-conflict-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = 1000 + 86400000;
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, accessPaused: true, writePaused: true,
    pausedAt: 1000, probe: 'waiting', notices: [], audit: [] });
  recovery.claimAuditedOfflineProbe(db, 'conflict-unsent', '123', { now, enabled: true, serviceReady: true, activeTime: true });
  db.update(s => ({ ...s, audit: [...s.audit, { id: 'probe_result_conflict-unsent', record: { result: 'existing' } }] }));
  const before = db.read();
  assert.throws(() => recovery.releaseAuditedUnsentOfflineProbe(db, 'conflict-unsent', now + 1, true));
  assert.deepEqual(db.read(), before);
});

test('结果审计冲突不能解除暂停或产生通知', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-probe-audit-conflict-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = 1000 + 86400000;
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, accessPaused: true, writePaused: false,
    pausedAt: 1000, probe: 'waiting', notices: [], audit: [] });
  recovery.claimAuditedOfflineProbe(db, 'conflict', '123456', { now, enabled: true, serviceReady: true, activeTime: true });
  db.update(s => ({ ...s, audit: [...s.audit, { id: 'probe_result_conflict', record: { result: 'existing' } }] }));
  const before = db.read();
  assert.throws(() => recovery.finishAuditedOfflineProbe(db, 'conflict', 'failure', now + 1, 'network'));
  assert.deepEqual(db.read(), before);
});

test('探测审计拒绝无效日期与非规范管理员号码', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-probe-audit-clock-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, accessPaused: true, writePaused: false,
    pausedAt: 1000, probe: 'waiting', notices: [], audit: [] });
  const opts = { now: 1000 + 86400000, enabled: true, serviceReady: true, activeTime: true };
  assert.throws(() => recovery.claimAuditedOfflineProbe(db, 'bad-target', '00123', opts));
  assert.throws(() => recovery.claimAuditedOfflineProbe(db, 'bad-date', '123', { ...opts, now: 9e15 }));
  assert.equal(db.read().probe, 'waiting');
  recovery.claimAuditedOfflineProbe(db, 'valid-date', '123', opts);
  assert.throws(() => recovery.finishAuditedOfflineProbe(db, 'valid-date', 'success', 9e15));
  assert.equal(db.read().probe, 'claimed');
});

test('探测中断需确认独占后才转人工恢复，且中断结果与通知同事务审计', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-probe-interrupt-audit-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = 1000 + 86400000;
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, accessPaused: true, writePaused: false,
    pausedAt: 1000, probe: 'waiting', notices: [], audit: [] });
  recovery.claimAuditedOfflineProbe(db, 'lost', '123', { now, enabled: true, serviceReady: true, activeTime: true });
  assert.throws(() => recovery.recoverAuditedAbandonedOfflineProbe(db, false, now + 1));
  assert.equal(db.read().probe, 'claimed');
  assert.equal(recovery.recoverAuditedAbandonedOfflineProbe(db, true, now + 1).recovered, true);
  const state = db.read();
  assert.equal(state.probe, 'manual_only');
  assert.equal(state.notices[0].cause, 'probe_interrupted');
  assert.equal(state.audit[1].record.result, 'unknown');
  assert.equal(state.audit[1].record.target, '123');
  assert.equal(state.audit[1].record.content, 'probe_interrupted');
  assert.equal(recovery.recoverAuditedAbandonedOfflineProbe(db, true, now + 2).recovered, false);
});

test('中断恢复结果审计冲突时暂停及通知均不改变', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-probe-interrupt-conflict-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = 1000 + 86400000;
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, accessPaused: true, writePaused: false,
    pausedAt: 1000, probe: 'waiting', notices: [], audit: [] });
  recovery.claimAuditedOfflineProbe(db, 'lost-conflict', '123', { now, enabled: true, serviceReady: true, activeTime: true });
  db.update(s => ({ ...s, audit: [...s.audit, { id: 'probe_result_lost-conflict', record: { result: 'existing' } }] }));
  const before = db.read();
  assert.throws(() => recovery.recoverAuditedAbandonedOfflineProbe(db, true, now + 1));
  assert.deepEqual(db.read(), before);
});

test('自动探测先持久领取，同一个暂停周期不会重复领取', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-recovery-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'state.db');
  const initial = { enabled: true, accessPaused: true, writePaused: true, pausedAt: 1000, probe: 'waiting', used: { post: 2 }, notices: [] };
  db = openOfflineStore(file, initial);
  const options = { now: 1000 + 86400000, enabled: true, serviceReady: true, activeTime: true };
  assert.equal(typeof recovery.claimOfflineProbe, 'function');
  assert.equal(recovery.claimOfflineProbe(db, 'probe-a', options).claimed, true);
  db.close(); db = openOfflineStore(file, initial);
  assert.equal(recovery.claimOfflineProbe(db, 'probe-b', options).claimed, false);
  assert.throws(() => recovery.finishOfflineProbe(db, 'probe-b', 'success'));
  recovery.finishOfflineProbe(db, 'probe-a', 'success');
  assert.equal(db.read().accessPaused, false);
  assert.equal(db.read().writePaused, false);
  assert.equal(db.read().used.post, 2);
});

test('探测期间迟到的写失败触发新暂停时，旧探测成功不能清除新写暂停', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-recovery-race-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, accessPaused: true, writePaused: false,
    reads: 3, writes: 2, pausedAt: 1000, probe: 'waiting', pauseCycles: { access: null, write: null },
    ledger: { day: '2026-11-07', used: { post: 0, comment: 1, like: 0 }, reservations: { delayed: 'comment' } }, outcomes: {}, notices: [] });
  const options = { now: 1000 + 86400000, enabled: true, serviceReady: true, activeTime: true };
  assert.equal(recovery.claimOfflineProbe(db, 'probe-race', options).claimed, true);
  const { settleOfflineWrite } = await import('../src/core/qzone-settlement-offline.mjs');
  settleOfflineWrite(db, 'delayed', 'failure', options.now + 1);
  const cycle = db.read().pauseCycles.write;
  assert.ok(cycle?.id);
  recovery.finishOfflineProbe(db, 'probe-race', 'success');
  assert.equal(db.read().accessPaused, false);
  assert.equal(db.read().writePaused, true);
  assert.equal(db.read().writes, 3);
  assert.deepEqual(db.read().pauseCycles.write, cycle);
});

test('探测开始前的写暂停在探测成功时解除，缺少快照的旧探测保守保留写暂停', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-recovery-legacy-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const cycle = { id: 'ad3f7fbc-1828-4ce2-a3e0-8d450955a4a1', operationId: 'write-1', cause: 'failure' };
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, accessPaused: true, writePaused: true,
    reads: 3, writes: 3, pausedAt: 1000, probe: 'waiting', pauseCycles: { access: null, write: cycle }, notices: [] });
  recovery.claimOfflineProbe(db, 'p1', { now: 1000 + 86400000, enabled: true, serviceReady: true, activeTime: true });
  recovery.finishOfflineProbe(db, 'p1', 'success');
  assert.equal(db.read().writePaused, false);
  assert.equal(db.read().pauseCycles.write, null);
  db.update((s) => { const n = { ...s, accessPaused: true, writePaused: true, writes: 3, probe: 'claimed', probeId: 'old', pauseCycles: { access: null, write: cycle } }; delete n.probeWriteSnapshot; return n; });
  recovery.finishOfflineProbe(db, 'old', 'success');
  assert.equal(db.read().accessPaused, false);
  assert.equal(db.read().writePaused, true);
  assert.deepEqual(db.read().pauseCycles.write, cycle);
});

test('探测期间写暂停被人工恢复后又产生新周期，旧探测不得解除新周期', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-recovery-repause-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const prior = { id: 'ad3f7fbc-1828-4ce2-a3e0-8d450955a4a1', operationId: 'previous', cause: 'failure' };
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, accessPaused: true, writePaused: true,
    reads: 3, writes: 3, pausedAt: 1000, probe: 'waiting', pauseCycles: { access: null, write: prior }, notices: [] });
  recovery.claimOfflineProbe(db, 'p', { now: 1000 + 86400000, enabled: true, serviceReady: true, activeTime: true });
  const { manualRestore } = await import('../src/core/qzone-policy-offline.mjs');
  db.update((s) => manualRestore(s, 'write'));
  const newer = { id: 'ed67e115-ac65-40f8-94f6-d36c65f0fb77', operationId: 'later', cause: 'failure' };
  db.update((s) => ({ ...s, writePaused: true, writes: 3, pauseCycles: { ...s.pauseCycles, write: newer } }));
  recovery.finishOfflineProbe(db, 'p', 'success');
  assert.equal(db.read().accessPaused, false);
  assert.equal(db.read().writePaused, true);
  assert.deepEqual(db.read().pauseCycles.write, newer);
});

test('损坏的暂停周期容器不能被成功探测悄悄覆盖', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-recovery-corrupt-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { accessPaused: true, writePaused: true, pausedAt: 1000,
    probe: 'claimed', probeId: 'bad', pauseCycles: [], notices: [] });
  assert.throws(() => recovery.finishOfflineProbe(db, 'bad', 'success'), /invalid pause cycles/);
  assert.equal(db.read().accessPaused, true);
  assert.equal(db.read().writePaused, true);
  assert.deepEqual(db.read().pauseCycles, []);
});

test('手动恢复后旧探测结果不得重置新的状态；失败只能人工恢复', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-recovery-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const initial = { enabled: true, accessPaused: true, writePaused: true, pausedAt: 1000, probe: 'waiting', notices: [] };
  db = openOfflineStore(join(dir, 'state.db'), initial);
  const options = { now: 1000 + 86400000, enabled: true, serviceReady: true, activeTime: true };
  recovery.claimOfflineProbe(db, 'a', options);
  db.update((s) => ({ ...s, accessPaused: false, probe: 'done' }));
  assert.throws(() => recovery.finishOfflineProbe(db, 'a', 'success'));
  db.update((s) => ({ ...s, accessPaused: true, probe: 'waiting', pausedAt: options.now }));
  recovery.claimOfflineProbe(db, 'b', { ...options, now: options.now + 86400000 });
  recovery.finishOfflineProbe(db, 'b', 'failure');
  assert.equal(db.read().probe, 'manual_only');
  assert.equal(db.read().notices.length, 1);
  assert.equal(recovery.claimOfflineProbe(db, 'c', { ...options, now: options.now + 3 * 86400000 }).claimed, false);
});

test('确认前次探测进程已退出后，将未完成探测转为人工恢复并产生待通知事件', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-recovery-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { accessPaused: true, writePaused: true, pausedAt: 1000, probe: 'claimed', probeId: 'a', notices: [] });
  assert.equal(typeof recovery.recoverAbandonedOfflineProbe, 'function');
  assert.throws(() => recovery.recoverAbandonedOfflineProbe(db, false));
  assert.equal(db.read().probe, 'claimed');
  assert.equal(recovery.recoverAbandonedOfflineProbe(db, true).recovered, true);
  assert.equal(db.read().probe, 'manual_only');
  assert.equal(db.read().notices[0].cause, 'probe_interrupted');
  assert.equal(recovery.recoverAbandonedOfflineProbe(db, true).recovered, false);
  assert.equal(db.read().notices.length, 1);
});

test('探测失败记录结构化原因而非原始错误或凭据', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-recovery-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { accessPaused: true, writePaused: true, pausedAt: 1000, probe: 'claimed', probeId: 'a', notices: [] });
  assert.throws(() => recovery.finishOfflineProbe(db, 'a', 'failure', 'Bearer secret'));
  recovery.finishOfflineProbe(db, 'a', 'failure', 'network');
  assert.equal(db.read().notices[0].reason, 'network');
  assert.equal(db.read().probeFailureReason, 'network');
});

test('持久化总开关关闭时，即使调用参数过期也不能领取探测', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-recovery-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { enabled: false, accessPaused: true, writePaused: true,
    pausedAt: 1000, probe: 'waiting', notices: [] });
  const options = { now: 1000 + 86400000, enabled: true, serviceReady: true, activeTime: true };
  assert.equal(recovery.claimOfflineProbe(db, 'stale', options).claimed, false);
  assert.equal(db.read().probe, 'waiting');
  db.update((s) => { const next = { ...s }; delete next.enabled; return next; });
  assert.equal(recovery.claimOfflineProbe(db, 'missing', options).claimed, false);
  assert.equal(db.read().probe, 'waiting');
});

test('探测恢复清除已解除暂停层的失败计数，不改变额度', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-recovery-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, accessPaused: true, writePaused: true,
    reads: 3, writes: 3, pausedAt: 1000, probe: 'waiting', notices: [], used: { post: 2 } });
  recovery.claimOfflineProbe(db, 'p', { now: 1000 + 86400000, enabled: true, serviceReady: true, activeTime: true });
  recovery.finishOfflineProbe(db, 'p', 'success');
  assert.equal(db.read().reads, 0);
  assert.equal(db.read().writes, 0);
  assert.equal(db.read().used.post, 2);
  db.update((s) => ({ ...s, accessPaused: true, writePaused: false, reads: 3, writes: 2, probe: 'claimed', probeId: 'p2' }));
  recovery.finishOfflineProbe(db, 'p2', 'success');
  assert.equal(db.read().reads, 0);
  assert.equal(db.read().writes, 2);
});
