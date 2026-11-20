/**
 * task-63：小黑盒身份异常降级状态机（纯模块）测试。
 *
 * 覆盖用户 2026-10-28 的安全规则：
 *  · 身份异常 → writes-paused（禁写）+ 通知管理员；通知成功 + 身份恢复 + 确认 → 自动解除。
 *  · 通知失败/结果未知 → all-paused（连读取搜索都停），只能控制台手动恢复（三条件）。
 *  · 发送成功 = QQ 接口回执，不等于管理员已读；未知不得视为成功。
 *  · stale operationId 不得改变状态；并发去重；持久化失败 degrade；损坏状态 fail-closed。
 *
 * 全部离线：临时目录 + 注入 clock，不触碰生产 state/、不联网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  XHH_IDENTITY_GUARD_SCHEMA_VERSION,
  XHH_IDENTITY_GUARD_STATES,
  XHH_IDENTITY_GUARD_NOTIFY_STATUSES,
  XHH_IDENTITY_GUARD_NOTIFY_DEADLINE_MS,
  XHH_IDENTITY_GUARD_LOAD_FAILURE_SKIP_REASONS,
  XHH_IDENTITY_GUARD_NOTIFY_MAX_ATTEMPTS,
  XHH_IDENTITY_GUARD_ANOMALY_KINDS,
  createXiaoheiheIdentityGuard,
} from '../src/core/xiaoheihe-identity-guard.mjs';

const START = 1_800_000_000_000;
const MIN = 60 * 1000;

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xhh-identity-guard-'));
}

function makeGuard(dir, overrides = {}) {
  return createXiaoheiheIdentityGuard({
    filePath: path.join(dir, 'identity-guard.json'),
    clock: overrides.clock ?? (() => START),
    ...overrides,
  });
}

function readStateFile(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'identity-guard.json'), 'utf8'));
}

test('常量与冻结值符合接口（schemaVersion / states / notify statuses / deadline）', () => {
  assert.equal(XHH_IDENTITY_GUARD_SCHEMA_VERSION, 1);
  assert.deepEqual([...XHH_IDENTITY_GUARD_STATES], ['normal', 'writes-paused', 'all-paused']);
  assert.deepEqual([...XHH_IDENTITY_GUARD_NOTIFY_STATUSES], ['pending', 'delivered', 'failed', 'unknown']);
  assert.equal(XHH_IDENTITY_GUARD_NOTIFY_DEADLINE_MS, 5 * MIN);
  assert.ok(Object.isFrozen(XHH_IDENTITY_GUARD_STATES));
  assert.ok(Object.isFrozen(XHH_IDENTITY_GUARD_NOTIFY_STATUSES));
});

test('缺文件 = 首次启动 = normal，且 snapshot 结构完整', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    assert.deepEqual(await guard.load(), { ok: true, state: 'normal' });
    const snap = guard.snapshot();
    assert.equal(snap.state, 'normal');
    assert.equal(snap.since, START);
    assert.equal(snap.anomalyId, null);
    assert.equal(snap.skipReason, null);
    assert.deepEqual(snap.notify, { status: null, operationId: null, attempts: 0, lastAt: null, lastCode: null, retriesExhausted: false });
    assert.deepEqual(snap.restoreNotify, { status: null, operationId: null, attempts: 0, lastAt: null, lastCode: null });
    assert.deepEqual(snap.manualRecovery, { required: false, lastRejectReason: null, reportReceiptBasis: null });
    assert.equal(snap.degraded, false);
    // 首次启动不该凭空写盘
    assert.equal(fs.existsSync(path.join(dir, 'identity-guard.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('异常 → writes-paused + 通知 pending；同 kind 幂等、不同 kind 保留原 anomalyId 且不重发', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    await guard.load();
    const first = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-sessions-shape' });
    assert.equal(first.ok, true);
    assert.equal(first.changed, true);
    assert.ok(first.notifyRequired && typeof first.notifyRequired.operationId === 'string');

    let snap = guard.snapshot();
    assert.equal(snap.state, 'writes-paused');
    assert.equal(snap.notify.status, 'pending');
    assert.equal(snap.notify.operationId, first.notifyRequired.operationId);
    assert.equal(snap.anomalyId, first.notifyRequired.operationId);
    assert.equal(snap.notify.attempts, 0);
    assert.equal(snap.notify.lastAt, START);

    // 幂等：同 kind 再报
    const again = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-sessions-shape' });
    assert.equal(again.ok, true);
    assert.equal(again.changed, false);
    assert.equal(again.notifyRequired, undefined);
    assert.equal(guard.snapshot().anomalyId, snap.anomalyId);

    // 不同 kind：保留原 id，不重发
    const other = await guard.reportAnomaly({ kind: 'identity-unknown-source', detail: 'classifier-unknown' });
    assert.equal(other.ok, true);
    assert.equal(other.changed, false);
    assert.equal(other.notifyRequired, undefined);
    assert.equal(guard.snapshot().anomalyId, snap.anomalyId);

    // 落盘：anomalyId 稳定，重启后仍是 writes-paused + pending
    const raw = readStateFile(dir);
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.state, 'writes-paused');
    assert.equal(raw.anomalyId, snap.anomalyId);

    const restarted = makeGuard(dir);
    assert.deepEqual(await restarted.load(), { ok: true, state: 'writes-paused' });
    const rsnap = restarted.snapshot();
    assert.equal(rsnap.state, 'writes-paused');
    assert.equal(rsnap.anomalyId, snap.anomalyId);
    assert.equal(rsnap.notify.status, 'pending');
    assert.equal(rsnap.notify.operationId, snap.anomalyId);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('通知 delivered：保持 writes-paused、记录回执；重复投递幂等', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    await guard.load();
    const { notifyRequired } = await guard.reportAnomaly({ kind: 'mapper-unavailable', detail: 'mapper-missing' });
    const opId = notifyRequired.operationId;

    const delivered = await guard.reportNotifyResult({ operationId: opId, outcome: 'delivered', code: 'qq-msg-id-1' });
    assert.equal(delivered.ok, true);
    const snap = guard.snapshot();
    assert.equal(snap.state, 'writes-paused');
    assert.equal(snap.notify.status, 'delivered');
    assert.equal(snap.notify.lastCode, 'qq-msg-id-1');
    assert.equal(snap.notify.attempts, 1);

    const dup = await guard.reportNotifyResult({ operationId: opId, outcome: 'delivered', code: 'qq-msg-id-1' });
    assert.equal(dup.ok, true);
    assert.equal(dup.changed, false);
    assert.equal(guard.snapshot().manualRecovery.required, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('完整自动解除链：异常 → 通知成功 → 身份恢复（需恢复通知）→ 恢复回执 → normal', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    await guard.load();
    const { notifyRequired } = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
    const anomalyOp = notifyRequired.operationId;
    await guard.reportNotifyResult({ operationId: anomalyOp, outcome: 'delivered' });

    // identityOk !== true：不解除、不改状态
    const notOk = await guard.reportIdentityRestored({ identityOk: false });
    assert.equal(notOk.ok, true);
    assert.equal(notOk.lifted, false);
    assert.equal(guard.snapshot().state, 'writes-paused');

    // 首次身份恢复：需要「恢复通知」
    const restored = await guard.reportIdentityRestored({ identityOk: true });
    assert.equal(restored.ok, true);
    assert.equal(restored.lifted, false);
    assert.ok(restored.restoreNotifyRequired && typeof restored.restoreNotifyRequired.operationId === 'string');
    const restoreOp = restored.restoreNotifyRequired.operationId;
    assert.equal(guard.snapshot().restoreNotify.status, 'pending');
    assert.equal(guard.snapshot().state, 'writes-paused');

    // 再次恢复：不得换 operationId、不得重复外发
    const again = await guard.reportIdentityRestored({ identityOk: true });
    assert.equal(again.lifted, false);
    assert.equal(again.restoreNotifyRequired, undefined);
    assert.equal(guard.snapshot().restoreNotify.operationId, restoreOp);

    // 恢复回执 delivered → 自动解除
    const receipt = await guard.reportRestoreNotifyResult({ operationId: restoreOp, outcome: 'delivered', code: 'qq-ok' });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.lifted, true);
    const snap = guard.snapshot();
    assert.equal(snap.state, 'normal');
    assert.equal(snap.skipReason, null);
    assert.equal(snap.anomalyId, null);
    assert.equal(snap.manualRecovery.required, false);

    // 已 normal 后重复投递旧回执：不改变状态（stale，因为异常已清除）
    const late = await guard.reportRestoreNotifyResult({ operationId: restoreOp, outcome: 'delivered' });
    assert.equal(late.ok, false);
    assert.equal(late.reason, 'stale-operation-id');
    assert.equal(guard.snapshot().state, 'normal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('恢复通知 failed/unknown：保持 writes-paused，不升级 all-paused，也不解除', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    await guard.load();
    const { notifyRequired } = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
    await guard.reportNotifyResult({ operationId: notifyRequired.operationId, outcome: 'delivered' });
    const restored = await guard.reportIdentityRestored({ identityOk: true });
    const restoreOp = restored.restoreNotifyRequired.operationId;

    const failed = await guard.reportRestoreNotifyResult({ operationId: restoreOp, outcome: 'failed', code: 'send-failed' });
    assert.equal(failed.ok, true);
    assert.equal(failed.lifted, false);
    assert.equal(failed.escalated, false);
    let snap = guard.snapshot();
    assert.equal(snap.state, 'writes-paused');
    assert.equal(snap.restoreNotify.status, 'failed');

    // unknown 同样保持 writes-paused（状态机允许同 op 的后续结果更新，但不能升级）
    const unknown = await guard.reportRestoreNotifyResult({ operationId: restoreOp, outcome: 'unknown' });
    assert.equal(unknown.ok, true);
    assert.equal(guard.snapshot().state, 'writes-paused');
    assert.equal(guard.snapshot().restoreNotify.status, 'unknown');

    // stale restore opId：拒绝、不改状态
    const stale = await guard.reportRestoreNotifyResult({ operationId: 'not-the-op', outcome: 'delivered' });
    assert.deepEqual(stale, { ok: false, reason: 'stale-operation-id' });
    assert.equal(guard.snapshot().state, 'writes-paused');
    assert.equal(guard.snapshot().restoreNotify.status, 'unknown');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('通知 failed → all-paused（skipReason notify-failed）；重启仍 all-paused；手动恢复三条件', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    await guard.load();
    const { notifyRequired } = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
    const opId = notifyRequired.operationId;

    const failed = await guard.reportNotifyResult({ operationId: opId, outcome: 'failed', code: 'send-failed' });
    assert.equal(failed.ok, true);
    assert.equal(failed.escalated, true);
    let snap = guard.snapshot();
    assert.equal(snap.state, 'all-paused');
    assert.equal(snap.skipReason, 'notify-failed');
    assert.equal(snap.manualRecovery.required, true);
    assert.equal(snap.notify.status, 'failed');

    // 重启：all-paused 必须保持
    const restarted = makeGuard(dir);
    assert.deepEqual(await restarted.load(), { ok: true, state: 'all-paused' });
    assert.equal(restarted.snapshot().state, 'all-paused');
    assert.equal(restarted.snapshot().skipReason, 'notify-failed');

    // all-paused 下身份恢复不得自动解除
    const restored = await restarted.reportIdentityRestored({ identityOk: true });
    assert.equal(restored.ok, false);
    assert.equal(restored.reason, 'manual-recovery-required');
    assert.equal(restarted.snapshot().state, 'all-paused');

    // task-75 §2.1/§2.4：调用方 reportDelivered:true 只是提示，内部没有真实 delivered 回执时仍必须拒绝
    const r0 = await restarted.recoverManually({ identityOk: true, qqCommsOk: true, reportDelivered: true });
    assert.equal(r0.ok, false);
    assert.equal(r0.reason, 'precondition-failed');
    assert.deepEqual(r0.failed, ['report-receipt']);
    assert.equal(r0.reportReceiptBasis, null);
    assert.equal(restarted.snapshot().state, 'all-paused');

    // task-75 §2.1：唯一口径 = 内部真实 delivered 回执（all-paused 下同 operationId 补报，D-2）
    const delivered = await restarted.reportNotifyResult({ operationId: opId, outcome: 'delivered' });
    assert.equal(delivered.ok, true);
    assert.equal(restarted.snapshot().state, 'all-paused');
    assert.equal(restarted.snapshot().notify.status, 'delivered');

    // 缺一：只缺身份
    const r1 = await restarted.recoverManually({ identityOk: false, qqCommsOk: true, reportDelivered: true });
    assert.equal(r1.ok, false);
    assert.equal(r1.reason, 'precondition-failed');
    assert.deepEqual(r1.failed, ['identity']);
    assert.equal(restarted.snapshot().state, 'all-paused');
    assert.equal(restarted.snapshot().manualRecovery.lastRejectReason, 'precondition-failed:identity');

    // 缺二：缺 QQ 通信 + 补报回执
    const r2 = await restarted.recoverManually({ identityOk: true, qqCommsOk: false, reportDelivered: false });
    // 真实 delivered 回执已记录，故只剩 qq-comms 不满足（task-75 后「回执」不再由调用方提示替代）
    assert.deepEqual(r2.failed, ['qq-comms']);
    assert.equal(restarted.snapshot().state, 'all-paused');
    assert.match(restarted.snapshot().manualRecovery.lastRejectReason, /qq-comms/);

    // 全满足 → 恢复 normal
    const ok = await restarted.recoverManually({ identityOk: true, qqCommsOk: true, reportDelivered: true, code: 'console-1' });
    assert.equal(ok.ok, true);
    assert.equal(ok.recovered, true);
    assert.equal(ok.skipReason, null);
    assert.equal(restarted.snapshot().state, 'normal');
    assert.equal(restarted.snapshot().manualRecovery.required, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('通知 unknown → all-paused（skipReason notify-unknown）；报告未知结果不得被当作成功', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    await guard.load();
    const { notifyRequired } = await guard.reportAnomaly({ kind: 'identity-unknown-source', detail: 'unknown-key' });
    const opId = notifyRequired.operationId;

    const unknown = await guard.reportNotifyResult({ operationId: opId, outcome: 'unknown' });
    assert.equal(unknown.ok, true);
    assert.equal(unknown.escalated, true);
    const snap = guard.snapshot();
    assert.equal(snap.state, 'all-paused');
    assert.equal(snap.skipReason, 'notify-unknown');
    assert.equal(snap.notify.status, 'unknown');
    assert.notEqual(snap.notify.status, 'delivered');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('通知超时兜底：pending 超过 deadline → unknown 且升级 all-paused；未超时不动', async () => {
  const dir = makeDir();
  let now = START;
  try {
    const guard = makeGuard(dir, { clock: () => now });
    await guard.load();
    await guard.reportAnomaly({ kind: 'mapper-unavailable', detail: 'mapper-missing' });

    now = START + XHH_IDENTITY_GUARD_NOTIFY_DEADLINE_MS - 1;
    assert.deepEqual(await guard.evaluateNotifyDeadline(), { ok: true, escalated: false });
    assert.equal(guard.snapshot().state, 'writes-paused');
    assert.equal(guard.snapshot().notify.status, 'pending');

    now = START + XHH_IDENTITY_GUARD_NOTIFY_DEADLINE_MS;
    const escalated = await guard.evaluateNotifyDeadline();
    assert.equal(escalated.ok, true);
    assert.equal(escalated.escalated, true);
    const snap = guard.snapshot();
    assert.equal(snap.state, 'all-paused');
    assert.equal(snap.notify.status, 'unknown');
    assert.equal(snap.skipReason, 'notify-unknown');
    assert.equal(snap.manualRecovery.required, true);

    // 已 delivered 的通知不会因再次评估而升级
    const dir2 = makeDir();
    const guard2 = makeGuard(dir2, { clock: () => now });
    await guard2.load();
    const second = await guard2.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
    await guard2.reportNotifyResult({ operationId: second.notifyRequired.operationId, outcome: 'delivered' });
    now += XHH_IDENTITY_GUARD_NOTIFY_DEADLINE_MS * 2;
    assert.deepEqual(await guard2.evaluateNotifyDeadline(), { ok: true, escalated: false });
    assert.equal(guard2.snapshot().state, 'writes-paused');
    fs.rmSync(dir2, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stale operationId：旧/伪造回执不得改变状态、不得触发解除', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    await guard.load();
    const { notifyRequired } = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
    const anomalyOp = notifyRequired.operationId;
    const before = guard.snapshot();

    const stale = await guard.reportNotifyResult({ operationId: 'stale-op-111', outcome: 'delivered' });
    assert.deepEqual(stale, { ok: false, reason: 'stale-operation-id' });
    assert.equal(guard.snapshot().state, before.state);
    assert.equal(guard.snapshot().notify.status, 'pending');
    assert.equal(guard.snapshot().notify.operationId, anomalyOp);

    // stale failed 也不得升级
    const staleFailed = await guard.reportNotifyResult({ operationId: 'stale-op-222', outcome: 'failed' });
    assert.equal(staleFailed.ok, false);
    assert.equal(guard.snapshot().state, 'writes-paused');
    assert.equal(guard.snapshot().skipReason, null);

    // 旧异常 id 在「已解除后再次进入异常」场景：旧 id 迟到不得解除新状态
    await guard.reportNotifyResult({ operationId: anomalyOp, outcome: 'delivered' });
    const restored = await guard.reportIdentityRestored({ identityOk: true });
    await guard.reportRestoreNotifyResult({ operationId: restored.restoreNotifyRequired.operationId, outcome: 'delivered' });
    assert.equal(guard.snapshot().state, 'normal');

    const newAnomaly = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-again' });
    assert.notEqual(newAnomaly.notifyRequired.operationId, anomalyOp);
    const lateOld = await guard.reportNotifyResult({ operationId: anomalyOp, outcome: 'delivered' });
    assert.deepEqual(lateOld, { ok: false, reason: 'stale-operation-id' });
    assert.equal(guard.snapshot().state, 'writes-paused');
    assert.equal(guard.snapshot().notify.operationId, newAnomaly.notifyRequired.operationId);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('并发 reportAnomaly × 5：只产生一个 anomalyId、一次 notifyRequired', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    await guard.load();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' })),
    );
    assert.ok(results.every((r) => r.ok === true));
    const created = results.filter((r) => r.changed === true && r.notifyRequired);
    assert.equal(created.length, 1);
    assert.equal(guard.snapshot().notify.status, 'pending');
    const raw = readStateFile(dir);
    assert.equal(raw.anomalyId, created[0].notifyRequired.operationId);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('持久化失败 → 限制增加仍提交内存（committedInMemory）并 degrade；限制减少必须落盘成功', async () => {
  const dir = makeDir();
  // 目标文件路径先不存在（首次启动 normal），随后在该路径上放一个目录：
  // tmp 写入成功，但 rename 到目录必然失败 → 触发持久化失败路径
  const badPath = path.join(dir, 'state-as-directory');
  try {
    const guard = createXiaoheiheIdentityGuard({ filePath: badPath, clock: () => START });
    assert.deepEqual(await guard.load(), { ok: true, state: 'normal' });
    fs.mkdirSync(badPath);
    const result = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'persist-failed');
    assert.equal(result.committedInMemory, true);
    assert.equal(result.state, 'writes-paused');
    const snap = guard.snapshot();
    // task-63 v3（C-1）：限制增加即使落盘失败也必须在内存生效，否则磁盘故障下写操作仍被放行
    assert.equal(snap.state, 'writes-paused', '限制增加必须提交内存（不假装成功，但限制必须生效）');
    assert.equal(snap.degraded, true);
    assert.equal(snap.notify.status, 'pending');

    // 后续变更：落盘持续失败 → 返回 persist-failed，不假装成功
    const after = await guard.reportNotifyResult({ operationId: snap.notify.operationId, outcome: 'delivered' });
    assert.equal(after.ok, false);
    assert.equal(after.reason, 'persist-failed');

    // 限制减少（解除）在磁盘坏时必须落盘成功才允许 → 仍被拒绝且保持 all-paused
    const escalated = await guard.reportNotifyResult({ operationId: snap.notify.operationId, outcome: 'failed' });
    assert.equal(escalated.committedInMemory, true);
    assert.equal(guard.snapshot().state, 'all-paused');
    // task-75 §2.4：磁盘坏时真实 delivered 回执也落不了盘 → 补报回执不满足，拒绝理由为 precondition-failed
    //（不是 persist-failed：拒绝发生在条件判定阶段，尚未尝试解除落盘）
    // task-75 §2.4：磁盘坏时真实 delivered 回执也落不了盘 → 补报回执不满足；连「拒绝原因」都写不进去，
    // 因此返回持久化失败（persist-failed），但内存状态必须仍是 all-paused（限制不得回退）
    const manual = await guard.recoverManually({ identityOk: true, qqCommsOk: true, reportDelivered: true });
    assert.equal(manual.ok, false);
    assert.equal(manual.reason, 'persist-failed');
    assert.equal(guard.snapshot().state, 'all-paused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('损坏/未知版本/未知 state 的持久化文件 → fail-closed all-paused + degraded', async () => {
  const dir = makeDir();
  try {
    const file = path.join(dir, 'identity-guard.json');
    fs.writeFileSync(file, '{ this is not json', 'utf8');
    const guard = makeGuard(dir);
    const loaded = await guard.load();
    assert.equal(loaded.ok, true);
    assert.equal(loaded.state, 'all-paused');
    assert.equal(guard.snapshot().state, 'all-paused');
    assert.equal(guard.snapshot().degraded, true);
    assert.equal(guard.snapshot().manualRecovery.required, true);

    // 未知 schemaVersion
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, state: 'normal', since: START }), 'utf8');
    const guard2 = makeGuard(dir);
    assert.equal((await guard2.load()).state, 'all-paused');
    assert.equal(guard2.snapshot().degraded, true);

    // 未知 state
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, state: 'weird', since: START, anomalyId: null }), 'utf8');
    const guard3 = makeGuard(dir);
    assert.equal((await guard3.load()).state, 'all-paused');
    assert.equal(guard3.snapshot().degraded, true);

    // 非法时间
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, state: 'normal', since: 'yesterday', anomalyId: null }), 'utf8');
    const guard4 = makeGuard(dir);
    assert.equal((await guard4.load()).state, 'all-paused');
    assert.equal(guard4.snapshot().degraded, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('all-paused 不可降级：reportAnomaly / delivered 回执都不得回 writes-paused', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    await guard.load();
    const { notifyRequired } = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
    await guard.reportNotifyResult({ operationId: notifyRequired.operationId, outcome: 'failed' });
    assert.equal(guard.snapshot().state, 'all-paused');

    const anomalyAgain = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
    assert.equal(anomalyAgain.ok, true);
    assert.equal(anomalyAgain.changed, false);
    assert.equal(anomalyAgain.notifyRequired, undefined);
    assert.equal(guard.snapshot().state, 'all-paused');

    const lateDelivered = await guard.reportNotifyResult({ operationId: notifyRequired.operationId, outcome: 'delivered' });
    assert.equal(lateDelivered.ok, true);
    assert.equal(lateDelivered.escalated, false);
    assert.equal(guard.snapshot().state, 'all-paused');
    assert.equal(guard.snapshot().notify.status, 'delivered');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('手动恢复在 writes-paused 也允许（管理员主动收口），且同样要求三条件', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    await guard.load();
    await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
    assert.equal(guard.snapshot().state, 'writes-paused');

    // task-75：先产生真实 delivered 回执（writes-paused 下 delivered 不改变 state）
    const delivered = await guard.reportNotifyResult({ operationId: guard.snapshot().notify.operationId, outcome: 'delivered' });
    assert.equal(delivered.ok, true);
    assert.equal(guard.snapshot().state, 'writes-paused');

    const rejected = await guard.recoverManually({ identityOk: true, qqCommsOk: false, reportDelivered: true });
    assert.deepEqual(rejected.failed, ['qq-comms']);
    assert.equal(guard.snapshot().state, 'writes-paused');

    const ok = await guard.recoverManually({ identityOk: true, qqCommsOk: true, reportDelivered: true });
    assert.equal(ok.ok, true);
    assert.equal(ok.recovered, true);
    assert.equal(guard.snapshot().state, 'normal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('输入校验：非法 kind / detail / outcome / 缺 operationId 均拒绝且不改状态', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    await guard.load();

    assert.equal((await guard.reportAnomaly({ kind: 'bad-kind', detail: 'x' })).ok, false);
    assert.equal((await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'HAS SPACE' })).ok, false);
    assert.equal((await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'a'.repeat(65) })).ok, false);
    assert.equal(guard.snapshot().state, 'normal');

    const created = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
    const opId = created.notifyRequired.operationId;
    assert.equal((await guard.reportNotifyResult({ operationId: opId, outcome: 'maybe' })).ok, false);
    assert.equal((await guard.reportNotifyResult({ operationId: '', outcome: 'delivered' })).ok, false);
    assert.equal(guard.snapshot().state, 'writes-paused');
    assert.equal(guard.snapshot().notify.status, 'pending');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('close() 幂等；close 后变更返回 closed（不写盘）', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    await guard.load();
    assert.deepEqual(await guard.close(), { ok: true });
    assert.deepEqual(await guard.close(), { ok: true });
    const after = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
    assert.equal(after.ok, false);
    assert.equal(after.reason, 'closed');
    assert.equal(fs.existsSync(path.join(dir, 'identity-guard.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('重启后 pending 通知不得被当作已送达（deadline 兜底仍会升级）', async () => {
  const dir = makeDir();
  let now = START;
  try {
    const guard = makeGuard(dir, { clock: () => now });
    await guard.load();
    await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });

    const restarted = makeGuard(dir, { clock: () => now });
    await restarted.load();
    const snap = restarted.snapshot();
    assert.equal(snap.notify.status, 'pending');
    assert.equal(snap.notify.deliveredAt, undefined);
    assert.equal(snap.state, 'writes-paused');

    now = START + XHH_IDENTITY_GUARD_NOTIFY_DEADLINE_MS;
    const escalated = await restarted.evaluateNotifyDeadline();
    assert.equal(escalated.escalated, true);
    assert.equal(restarted.snapshot().state, 'all-paused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// task-63 v3 规格修正（docs/superpowers/plans/2026-10-28-task63-spec-amendment.md）
// A：identityOk:false 必须持久化并作废 restoreNotify；解除前校验最近身份检查 === true
// B：时钟回拨/不可信时间 → 立即按超时处理（不静默死锁）
// C：限制增加落盘失败也提交内存；限制减少必须落盘成功；degraded 不拦 recoverManually
// D：identityOk===true 总是持久化；delivered 就地建 restoreNotify；同 op 的 delivered 补报；
//    load 跨字段一致性校验
// ─────────────────────────────────────────────────────────────────────────────

test('A1 identityOk:false 必须持久化并作废 restoreNotify：迟到 delivered → stale-operation-id 且仍 writes-paused', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    await guard.load();
    const { notifyRequired } = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
    await guard.reportNotifyResult({ operationId: notifyRequired.operationId, outcome: 'delivered' });
    const restored = await guard.reportIdentityRestored({ identityOk: true });
    const restoreOp = restored.restoreNotifyRequired.operationId;
    assert.equal(guard.snapshot().restoreNotify.operationId, restoreOp);

    // 身份又坏了：必须落盘 false，并作废待发的恢复通知
    const bad = await guard.reportIdentityRestored({ identityOk: false });
    assert.equal(bad.ok, true);
    assert.equal(bad.lifted, false);
    assert.equal(bad.identityRecorded, false);
    let snap = guard.snapshot();
    assert.equal(snap.state, 'writes-paused');
    assert.equal(snap.identityOk, false, 'identityOk:false 必须记录在内存');
    assert.equal(snap.restoreNotify.operationId, null, 'restoreNotify 必须被作废');
    // v4 §①：复用枚举 'unknown'（结果不可确认）而不是扩枚举；lastCode 记录作废原因
    assert.equal(snap.restoreNotify.status, 'unknown');
    assert.equal(snap.restoreNotify.lastCode, 'invalidated-identity-lost');

    // 落盘也要是 false（重启后不得复活旧身份检查结果）
    const raw = readStateFile(dir);
    assert.equal(raw.identityOk, false);
    assert.equal(raw.restoreNotify.operationId, null);
    assert.equal(raw.restoreNotify.status, 'unknown');
    assert.equal(raw.restoreNotify.lastCode, 'invalidated-identity-lost');

    // 迟到的旧 restore delivered：命中 stale，不得解除
    const late = await guard.reportRestoreNotifyResult({ operationId: restoreOp, outcome: 'delivered' });
    assert.deepEqual(late, { ok: false, reason: 'stale-operation-id' });
    assert.equal(guard.snapshot().state, 'writes-paused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A2 identityOk:false 后重新恢复 → 生成新的 restoreNotify（旧 op 已作废，旧回执永不生效）', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    await guard.load();
    const { notifyRequired } = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
    await guard.reportNotifyResult({ operationId: notifyRequired.operationId, outcome: 'delivered' });
    const first = await guard.reportIdentityRestored({ identityOk: true });
    const oldOp = first.restoreNotifyRequired.operationId;
    await guard.reportIdentityRestored({ identityOk: false });

    const second = await guard.reportIdentityRestored({ identityOk: true });
    assert.equal(second.ok, true);
    assert.equal(second.lifted, false);
    assert.ok(second.restoreNotifyRequired, '恢复后必须重新要求恢复通知');
    const newOp = second.restoreNotifyRequired.operationId;
    assert.notEqual(newOp, oldOp);
    assert.equal(guard.snapshot().restoreNotify.status, 'pending');

    // 旧 op 依旧 stale，新 op delivered 才解除
    const stale = await guard.reportRestoreNotifyResult({ operationId: oldOp, outcome: 'delivered' });
    assert.deepEqual(stale, { ok: false, reason: 'stale-operation-id' });
    assert.equal(guard.snapshot().state, 'writes-paused');
    const receipt = await guard.reportRestoreNotifyResult({ operationId: newOp, outcome: 'delivered' });
    assert.equal(receipt.lifted, true);
    assert.equal(guard.snapshot().state, 'normal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B1 时钟回拨 → 立即按超时升级 all-paused（skipReason notify-deadline-clock-rollback），不静默死锁', async () => {
  const dir = makeDir();
  let now = START;
  try {
    const guard = makeGuard(dir, { clock: () => now });
    await guard.load();
    await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
    assert.equal(guard.snapshot().state, 'writes-paused');

    // NTP/手动改时间导致时钟回退 60s
    now = START - 60 * 1000;
    const rolled = await guard.evaluateNotifyDeadline();
    assert.equal(rolled.ok, true);
    assert.equal(rolled.escalated, true, '回拨必须立即 fail-closed，而不是永远 pending');
    const snap = guard.snapshot();
    assert.equal(snap.state, 'all-paused');
    assert.equal(snap.skipReason, 'notify-deadline-clock-rollback');
    assert.equal(snap.notify.status, 'unknown');
    assert.equal(snap.manualRecovery.required, true);

    // 回拨后连续评估：状态保持 all-paused，不重复升级
    for (let i = 0; i < 3; i += 1) {
      const again = await guard.evaluateNotifyDeadline();
      assert.equal(again.ok, true);
      assert.equal(again.escalated, false);
      assert.equal(guard.snapshot().state, 'all-paused');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B2 NaN / Infinity 时钟仍 fail-closed；elapsed===deadline 边界仍升级', async () => {
  const dir = makeDir();
  let now = START;
  try {
    const guard = makeGuard(dir, { clock: () => now });
    await guard.load();
    await guard.reportAnomaly({ kind: 'mapper-unavailable', detail: 'mapper-missing' });
    now = Number.NaN;
    const nan = await guard.evaluateNotifyDeadline();
    assert.equal(nan.escalated, true, 'NaN 时钟不得让通知永远 pending');
    assert.equal(guard.snapshot().state, 'all-paused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const dir2 = makeDir();
  let now2 = START;
  try {
    const guard2 = makeGuard(dir2, { clock: () => now2 });
    await guard2.load();
    await guard2.reportAnomaly({ kind: 'mapper-unavailable', detail: 'mapper-missing' });
    now2 = Number.POSITIVE_INFINITY;
    const inf = await guard2.evaluateNotifyDeadline();
    assert.equal(inf.escalated, true);
    assert.equal(guard2.snapshot().state, 'all-paused');

    // 边界：elapsed === deadline 必须升级（原本就对，防回归）
    const dir3 = makeDir();
    let now3 = START;
    try {
      const guard3 = makeGuard(dir3, { clock: () => now3 });
      await guard3.load();
      await guard3.reportAnomaly({ kind: 'mapper-unavailable', detail: 'mapper-missing' });
      now3 = START + XHH_IDENTITY_GUARD_NOTIFY_DEADLINE_MS;
      assert.equal((await guard3.evaluateNotifyDeadline()).escalated, true);
    } finally {
      fs.rmSync(dir3, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('C1 限制增加落盘失败也提交内存（writes-paused），degrade 不得阻止升级 all-paused', async () => {
  const dir = makeDir();
  const badPath = path.join(dir, 'state-as-directory');
  try {
    const guard = createXiaoheiheIdentityGuard({ filePath: badPath, clock: () => START });
    assert.deepEqual(await guard.load(), { ok: true, state: 'normal' });
    // 让 persist 的 rename 必然失败：目标路径被目录占用
    fs.mkdirSync(badPath);

    const anomaly = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
    assert.equal(anomaly.ok, false);
    assert.equal(anomaly.reason, 'persist-failed');
    assert.equal(anomaly.committedInMemory, true);
    assert.equal(anomaly.state, 'writes-paused');
    let snap = guard.snapshot();
    assert.equal(snap.state, 'writes-paused', '限制增加必须提交内存（否则磁盘故障下写仍放行）');
    assert.equal(snap.degraded, true);
    const opId = snap.notify.operationId;

    // degrade latch 不得阻止「升级 all-paused」（否则永远升不到全停）
    const failed = await guard.reportNotifyResult({ operationId: opId, outcome: 'failed' });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'persist-failed');
    assert.equal(failed.committedInMemory, true);
    assert.equal(failed.state, 'all-paused');
    assert.equal(guard.snapshot().state, 'all-paused');

    // 限制减少：磁盘仍坏、真实回执不可达 → 不得假装恢复（拒绝在条件判定阶段）
    const denied = await guard.recoverManually({ identityOk: true, qqCommsOk: true, reportDelivered: true });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'persist-failed');
    assert.equal(guard.snapshot().state, 'all-paused');

    // 磁盘修复后，管理员先重发补报（task-75 §2.3 resendNotify）拿到真实回执，再手动恢复
    fs.rmdirSync(badPath);
    const resent = await guard.resendNotify({ operationId: opId });
    assert.equal(resent.ok, true, JSON.stringify(resent));
    assert.equal(guard.snapshot().notify.attempts, 0);
    const delivered = await guard.reportNotifyResult({ operationId: opId, outcome: 'delivered', code: 'console-receipt' });
    assert.equal(delivered.ok, true);
    const recovered = await guard.recoverManually({ identityOk: true, qqCommsOk: true, reportDelivered: true });
    assert.equal(recovered.reportReceiptBasis, 'delivered');
    assert.equal(recovered.ok, true);
    assert.equal(recovered.recovered, true);
    snap = guard.snapshot();
    assert.equal(snap.state, 'normal');
    assert.equal(snap.degraded, false);
    // 注意：本用例的 filePath 是 badPath（被目录占位过），修复后恢复写入的正是该路径；
    // 不能读 dir/identity-guard.json（那从来不是本实例的目标文件）。
    assert.equal(JSON.parse(fs.readFileSync(badPath, 'utf8')).state, 'normal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('C3 损坏态手动恢复不得被 degrade 拦截（控制台是唯一恢复通道，task-77 起须真实回执）', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'identity-guard.json');
  try {
    fs.writeFileSync(file, '{ this is not json', 'utf8');
    const guard = makeGuard(dir);
    assert.equal((await guard.load()).state, 'all-paused');
    assert.equal(guard.snapshot().degraded, true);

    // task-77：损坏态不再有 corruptionAck 免回执通道；任何情况下无真实回执必拒
    const noReceipt = await guard.recoverManually({ identityOk: true, qqCommsOk: true, reportDelivered: true });
    assert.equal(noReceipt.ok, false);
    assert.equal(noReceipt.reason, 'precondition-failed');
    assert.deepEqual(noReceipt.failed, ['report-receipt']);
    assert.equal(noReceipt.reportReceiptBasis, null);
    const before = guard.snapshot();
    assert.equal(before.state, 'all-paused');
    assert.equal(before.controlledRecoveryAvailable, true, '损坏且从未通知 ⇒ 允许发起受控补报，让回执可达');

    // 受控补报（正常路径）→ 真实 delivered → 才能恢复
    const declared = await guard.declareControlledRecoveryAnomaly({ detail: 'state-file-unreadable' });
    console.error(`[diag-task77-c3-declare] ${JSON.stringify(declared)}`);
    assert.equal(declared.ok, true, JSON.stringify(declared));
    assert.equal(declared.changed, true);
    assert.equal(typeof declared.notifyRequired.operationId, 'string');
    assert.equal(guard.snapshot().controlledRecoveryAvailable, false, '已生成通知后不得再声明第二条');
    assert.equal(guard.snapshot().state, 'all-paused', '声明补报不减少限制');
    const delivered = await guard.reportNotifyResult({ operationId: declared.notifyRequired.operationId, outcome: 'delivered', code: 'qq-ok' });
    assert.equal(delivered.ok, true, JSON.stringify(delivered));
    const recovered = await guard.recoverManually({ identityOk: true, qqCommsOk: true, reportDelivered: true, code: 'console-1' });
    console.error(`[diag-task77-c3-recover] ${JSON.stringify(recovered)}`);
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.reportReceiptBasis, 'delivered');
    assert.equal(recovered.recovered, true);
    assert.equal(guard.snapshot().state, 'normal');
    assert.equal(guard.snapshot().degraded, false);
    assert.equal(readStateFile(dir).state, 'normal');

    // 损坏 + 落盘仍失败 → 不得假装成功；恢复磁盘后 retryPersist 收敛
    const dir2 = makeDir();
    const file2 = path.join(dir2, 'identity-guard.json');
    try {
      fs.writeFileSync(file2, 'corrupt', 'utf8');
      const guard2 = makeGuard(dir2);
      assert.equal((await guard2.load()).state, 'all-paused');
      // 用目录占位让 rename 失败
      fs.rmSync(file2);
      fs.mkdirSync(file2);
      const blocked = await guard2.declareControlledRecoveryAnomaly({ detail: 'state-file-unreadable' });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.reason, 'persist-failed');
      assert.equal(blocked.committedInMemory, true, '限制增加必须提交内存（不得因磁盘故障而放行）');
      assert.equal(guard2.snapshot().state, 'all-paused');
      assert.equal(guard2.snapshot().degraded, true);
      // 磁盘恢复后 retryPersist 只收敛「仅内存」窗口，不解除限制
      fs.rmdirSync(file2);
      const retried = await guard2.retryPersist();
      console.error(`[diag-task77-c3-retryPersist] ${JSON.stringify(retried)}`);
      assert.equal(retried.ok, true, JSON.stringify(retried));
      assert.equal(guard2.snapshot().degraded, false);
      assert.equal(readStateFile(dir2).state, 'all-paused', 'retryPersist 不得解除限制');
      const op = guard2.snapshot().notify.operationId;
      assert.equal(typeof op, 'string', 'declare 的内存提交必须保留，回执可达');
      assert.equal((await guard2.reportNotifyResult({ operationId: op, outcome: 'delivered' })).ok, true);
      const recovered2 = await guard2.recoverManually({ identityOk: true, qqCommsOk: true });
      assert.equal(recovered2.ok, true, JSON.stringify(recovered2));
      assert.equal(recovered2.reportReceiptBasis, 'delivered');
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D1 identityOk:true 总是持久化；通知 delivered 时就地创建 restoreNotify 并返回 restoreNotifyRequired', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    await guard.load();
    const { notifyRequired } = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });

    // 通知还没送达时上报身份恢复：必须记录 identityOk=true，但还不能建恢复通知
    const early = await guard.reportIdentityRestored({ identityOk: true });
    assert.equal(early.ok, true);
    assert.equal(early.lifted, false);
    assert.equal(early.restoreNotifyRequired, undefined);
    assert.equal(guard.snapshot().identityOk, true);
    const raw = readStateFile(dir);
    assert.equal(raw.identityOk, true);

    // 通知 delivered 时身份已恢复 → 就地创建恢复通知，接线不必再反复调用
    const delivered = await guard.reportNotifyResult({ operationId: notifyRequired.operationId, outcome: 'delivered' });
    assert.equal(delivered.ok, true);
    assert.ok(delivered.restoreNotifyRequired && typeof delivered.restoreNotifyRequired.operationId === 'string');
    assert.equal(guard.snapshot().restoreNotify.status, 'pending');
    assert.equal(guard.snapshot().state, 'writes-paused');

    // 恢复回执 delivered → 自动解除
    const receipt = await guard.reportRestoreNotifyResult({ operationId: delivered.restoreNotifyRequired.operationId, outcome: 'delivered' });
    assert.equal(receipt.lifted, true);
    assert.equal(guard.snapshot().state, 'normal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D2 all-paused 下同 operationId 的 delivered 补报被接受：state 保持 all-paused、记录 deliveredAt', async () => {
  const dir = makeDir();
  let now = START;
  try {
    const guard = makeGuard(dir, { clock: () => now });
    await guard.load();
    const { notifyRequired } = await guard.reportAnomaly({ kind: 'identity-unknown-source', detail: 'unknown-key' });
    const opId = notifyRequired.operationId;

    // 首次结果未知 → 全停（只能手动恢复）
    const unknown = await guard.reportNotifyResult({ operationId: opId, outcome: 'unknown' });
    assert.equal(unknown.escalated, true);
    assert.equal(guard.snapshot().state, 'all-paused');

    // 通信恢复后补报同一 operationId 的 delivered：必须接受，但不得解除 all-paused
    now = START + 60 * 1000;
    const backfill = await guard.reportNotifyResult({ operationId: opId, outcome: 'delivered', code: 'qq-late-ok' });
    assert.equal(backfill.ok, true);
    assert.equal(backfill.changed, true);
    assert.equal(backfill.escalated, false);
    assert.equal(guard.snapshot().state, 'all-paused', '补报成功不得解除 all-paused');
    assert.equal(guard.snapshot().notify.status, 'delivered');
    assert.equal(guard.snapshot().notify.lastCode, 'qq-late-ok');
    const raw = readStateFile(dir);
    assert.equal(raw.notify.status, 'delivered');
    assert.equal(raw.notify.deliveredAt, now);
    assert.equal(raw.state, 'all-paused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D3 load 跨字段不一致 → fail-closed all-paused（skipReason state-inconsistent）', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'identity-guard.json');
  const emptyNotify = { status: null, operationId: null, attempts: 0, lastAt: null, lastCode: null, deliveredAt: null };
  const base = {
    schemaVersion: 1,
    since: START,
    degraded: false,
    notify: { ...emptyNotify },
    restoreNotify: { ...emptyNotify },
    manualRecovery: { required: false, lastRejectReason: null },
  };
  const cases = [
    // normal 但有异常 id（状态与异常记录矛盾）
    { ...base, state: 'normal', anomalyId: 'op-a' },
    // normal 但通知 pending
    { ...base, state: 'normal', anomalyId: null, notify: { status: 'pending', operationId: 'op-b', attempts: 0, lastAt: START, lastCode: null, deliveredAt: null } },
    // all-paused 但 manualRecovery.required 不是 true
    { ...base, state: 'all-paused', anomalyId: 'op-c', manualRecovery: { required: false } },
    // notify delivered 但缺 deliveredAt
    { ...base, state: 'writes-paused', anomalyId: 'op-d', notify: { status: 'delivered', operationId: 'op-d', attempts: 1, lastAt: START, lastCode: null } },
    // restoreNotify delivered 但缺 operationId
    {
      ...base,
      state: 'writes-paused',
      anomalyId: 'op-e',
      notify: { status: 'delivered', operationId: 'op-e', attempts: 1, lastAt: START, lastCode: null, deliveredAt: START },
      restoreNotify: { status: 'delivered', operationId: null, attempts: 1, lastAt: START, lastCode: null, deliveredAt: START },
    },
  ];
  try {
    for (const raw of cases) {
      fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
      const guard = makeGuard(dir);
      const loaded = await guard.load();
      assert.equal(loaded.ok, true);
      assert.equal(loaded.state, 'all-paused', `跨字段不一致必须 fail-closed：${JSON.stringify(raw)}`);
      const snap = guard.snapshot();
      assert.equal(snap.state, 'all-paused');
      assert.equal(snap.degraded, true);
      assert.equal(snap.skipReason, 'state-inconsistent');
      assert.equal(snap.manualRecovery.required, true);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot 暴露 degraded 与 identityOk，且不泄露 detail/路径/凭据', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    await guard.load();
    let snap = guard.snapshot();
    assert.equal(snap.identityOk, null);
    assert.equal(snap.degraded, false);
    assert.equal('filePath' in snap, false);
    assert.equal('anomalyDetail' in snap, false);

    await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
    await guard.reportNotifyResult({ operationId: guard.snapshot().notify.operationId, outcome: 'delivered' });
    await guard.reportIdentityRestored({ identityOk: false });
    snap = guard.snapshot();
    assert.equal(snap.identityOk, false);
    assert.equal('filePath' in snap, false);
    assert.equal('anomalyDetail' in snap, false);
    // detail 只在磁盘内部使用，snapshot 不得回显（防日志泄露）
    assert.equal(JSON.stringify(snap).includes('legacy-shape'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v4-②a degraded 自愈：任意一次成功落盘即清 latch（瞬时磁盘故障不再永久停摆）', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'identity-guard.json');
  try {
    const guard = makeGuard(dir);
    await guard.load();
    const { notifyRequired } = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
    const opId = notifyRequired.operationId;

    // 制造一次瞬时磁盘故障：用目录占位目标文件，rename 必然失败
    fs.rmSync(file);
    fs.mkdirSync(file);
    const failed = await guard.reportNotifyResult({ operationId: opId, outcome: 'delivered' });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'persist-failed');
    assert.equal(guard.snapshot().state, 'writes-paused');
    assert.equal(guard.snapshot().degraded, true, '落盘失败必须置 degraded');

    // 磁盘修复后，任意一次成功落盘都应清 latch（自愈），而不是永久 degraded 只能重启
    fs.rmdirSync(file);
    const escalate = await guard.reportNotifyResult({ operationId: opId, outcome: 'failed' });
    assert.equal(escalate.ok, true);
    let snap = guard.snapshot();
    assert.equal(snap.state, 'all-paused');
    assert.equal(snap.degraded, false, '成功落盘必须清除 degraded（自愈）');
    assert.equal(readStateFile(dir).state, 'all-paused');
    snap = guard.snapshot();
    assert.equal(snap.degraded, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v4-②b degraded 期间禁止自动解除；成功落盘自愈后解除链仍完整', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'identity-guard.json');
  try {
    const guard = makeGuard(dir);
    await guard.load();
    const { notifyRequired } = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
    await guard.reportNotifyResult({ operationId: notifyRequired.operationId, outcome: 'delivered' });
    const restored = await guard.reportIdentityRestored({ identityOk: true });
    const restoreOp = restored.restoreNotifyRequired.operationId;
    assert.equal(guard.snapshot().restoreNotify.status, 'pending');

    // 磁盘故障 → 第一次 delivered 解除尝试落盘失败 → degraded
    fs.rmSync(file);
    fs.mkdirSync(file);
    const first = await guard.reportRestoreNotifyResult({ operationId: restoreOp, outcome: 'delivered' });
    assert.equal(first.ok, false);
    assert.equal(first.reason, 'persist-failed');
    assert.equal(guard.snapshot().state, 'writes-paused', 'degraded 下不得解除');
    assert.equal(guard.snapshot().degraded, true);

    // degraded 期间再次 delivered：回执必须被记下（不减少限制），但不得解除
    const blocked = await guard.reportRestoreNotifyResult({ operationId: restoreOp, outcome: 'delivered' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'persist-failed');
    assert.equal(blocked.committedInMemory, true, 'degraded 不得吞掉 delivered 回执');
    assert.equal(guard.snapshot().restoreNotify.status, 'delivered');
    assert.equal(guard.snapshot().state, 'writes-paused');

    // 磁盘修复：一次成功落盘先自愈 degraded，再按已记录的 delivered 回执完成解除
    fs.rmdirSync(file);
    const flush = await guard.reportIdentityRestored({ identityOk: true });
    assert.equal(flush.ok, true);
    assert.equal(flush.lifted, true, 'degraded 自愈后应能按已记录回执解除');
    assert.equal(guard.snapshot().degraded, false);
    assert.equal(guard.snapshot().state, 'normal');
    assert.equal(readStateFile(dir).state, 'normal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v4-③ 拒绝手动恢复时 failed 列表可映射为具体中文原因（控制台不得显示为操作失败）', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    await guard.load();
    await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });

    // 三条件都不满足：failed 按固定顺序给出，控制台可逐项翻译成中文具体原因
    const denied = await guard.recoverManually({ identityOk: false, qqCommsOk: false, reportDelivered: false });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'precondition-failed');
    assert.deepEqual(denied.failed, ['identity', 'qq-comms', 'report-receipt']);
    assert.equal(guard.snapshot().manualRecovery.lastRejectReason, 'precondition-failed:identity,qq-comms,report-receipt');

    // 只缺后两项：failed 列表精确反映缺失项，避免运维误判
    const partial = await guard.recoverManually({ identityOk: true, qqCommsOk: false, reportDelivered: false });
    assert.deepEqual(partial.failed, ['qq-comms', 'report-receipt']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// v4-④a/b/c：磁盘预置 degraded 的残留态（上次 persist 失败 → 内存提交 → 重启读回 degraded）
// delivered 回执属于「不减少限制」的事实，degraded 时仍必须记录；成功落盘后自愈并可解除。
function degradedWritesPausedState(overrides = {}) {
  return {
    schemaVersion: 1,
    state: 'writes-paused',
    since: START,
    anomalyId: 'op-d1',
    anomalyKind: 'identity-legacy',
    anomalyDetail: null,
    skipReason: null,
    identityOk: true,
    notify: { status: 'delivered', operationId: 'n-d1', attempts: 1, lastAt: START, lastCode: null, deliveredAt: START },
    restoreNotify: { status: 'pending', operationId: 'r-d1', attempts: 0, lastAt: START, lastCode: null, deliveredAt: null },
    manualRecovery: { required: false, lastRejectReason: null },
    degraded: true,
    ...overrides,
  };
}

test('v4-④a degraded 残留态下 delivered 回执不得被吞：记录 delivered、不解除', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'identity-guard.json');
  try {
    fs.writeFileSync(file, JSON.stringify(degradedWritesPausedState()), 'utf8');
    const guard = makeGuard(dir);
    const loaded = await guard.load();
    assert.equal(loaded.state, 'writes-paused');
    assert.equal(guard.snapshot().degraded, true);

    const receipt = await guard.reportRestoreNotifyResult({ operationId: 'r-d1', outcome: 'delivered' });
    assert.equal(receipt.ok, true, 'degraded 不得吞掉 delivered 回执');
    assert.equal(receipt.changed, true);
    assert.equal(receipt.lifted, false);
    const snap = guard.snapshot();
    assert.equal(snap.restoreNotify.status, 'delivered');
    assert.equal(snap.state, 'writes-paused', '只是记录回执，不得解除');
    assert.equal(snap.degraded, false, '成功落盘后 degraded 必须自愈');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v4-④b 承接已记录的 delivered 回执：再次 delivered 即解除（磁盘恢复后自动解除不被永久锁死）', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'identity-guard.json');
  try {
    fs.writeFileSync(file, JSON.stringify(degradedWritesPausedState()), 'utf8');
    const guard = makeGuard(dir);
    await guard.load();
    const first = await guard.reportRestoreNotifyResult({ operationId: 'r-d1', outcome: 'delivered' });
    assert.equal(first.ok, true);
    assert.equal(first.lifted, false);

    const second = await guard.reportRestoreNotifyResult({ operationId: 'r-d1', outcome: 'delivered' });
    assert.equal(second.ok, true);
    assert.equal(second.lifted, true);
    assert.equal(guard.snapshot().state, 'normal');
    assert.equal(readStateFile(dir).state, 'normal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v4-④c degraded + restoreNotify 已 delivered：报 identityOk:true 应能解除', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'identity-guard.json');
  try {
    const preloaded = degradedWritesPausedState({
      identityOk: null,
      restoreNotify: { status: 'delivered', operationId: 'r-d1', attempts: 1, lastAt: START, lastCode: null, deliveredAt: START },
    });
    fs.writeFileSync(file, JSON.stringify(preloaded), 'utf8');
    const guard = makeGuard(dir);
    await guard.load();
    assert.equal(guard.snapshot().degraded, true);

    const restored = await guard.reportIdentityRestored({ identityOk: true });
    assert.equal(restored.ok, true);
    assert.equal(restored.identityRecorded, true);
    assert.equal(restored.lifted, true, 'degraded 自愈后应能按已记录回执解除');
    assert.equal(guard.snapshot().state, 'normal');
    assert.equal(guard.snapshot().degraded, false);
    assert.equal(readStateFile(dir).state, 'normal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('m01338-A 磁盘 all-paused + notify.pending（可加载）→ evaluateNotifyDeadline 能记录升级', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'identity-guard.json');
  try {
    const preloaded = {
      schemaVersion: 1,
      state: 'all-paused',
      since: START,
      anomalyId: 'an-1',
      anomalyKind: 'identity-legacy',
      anomalyDetail: null,
      skipReason: null,
      identityOk: false,
      notify: { status: 'pending', operationId: 'op-1', attempts: 1, lastAt: 1000, lastCode: null, deliveredAt: null },
      restoreNotify: { status: null, operationId: null, attempts: 0, lastAt: null, lastCode: null, deliveredAt: null },
      manualRecovery: { required: true, lastRejectReason: null },
      degraded: false,
    };
    fs.writeFileSync(file, JSON.stringify(preloaded), 'utf8');
    const guard = makeGuard(dir, { clock: () => 1000 + 10 * MIN });
    const loaded = await guard.load();
    assert.equal(loaded.ok, true, '预置的 all-paused + notify.pending 必须可加载（D-3 不禁止该组合）');
    assert.equal(loaded.state, 'all-paused');

    const deadline = await guard.evaluateNotifyDeadline();
    assert.equal(deadline.ok, true, 'rank 相等的补记必须允许落盘');
    assert.equal(deadline.escalated, true);
    const snap = guard.snapshot();
    assert.equal(snap.notify.status, 'unknown');
    assert.equal(snap.skipReason, 'notify-unknown');
    assert.equal(readStateFile(dir).notify.status, 'unknown', 'deadline 升级必须真正落盘');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('m01338-B 磁盘 writes-paused + anomalyId=null（可加载）→ reportAnomaly 能补建异常并通知', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'identity-guard.json');
  try {
    const preloaded = {
      schemaVersion: 1,
      state: 'writes-paused',
      since: START,
      anomalyId: null,
      anomalyKind: null,
      anomalyDetail: null,
      skipReason: null,
      identityOk: false,
      notify: { status: 'pending', operationId: 'op-x', attempts: 0, lastAt: null, lastCode: null, deliveredAt: null },
      restoreNotify: { status: null, operationId: null, attempts: 0, lastAt: null, lastCode: null, deliveredAt: null },
      manualRecovery: { required: false, lastRejectReason: null },
      degraded: false,
    };
    fs.writeFileSync(file, JSON.stringify(preloaded), 'utf8');
    const guard = makeGuard(dir);
    const loaded = await guard.load();
    assert.equal(loaded.ok, true, '预置的 writes-paused + anomalyId=null 必须可加载');
    assert.equal(loaded.state, 'writes-paused');

    const reported = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'x' });
    assert.equal(reported.ok, true, 'writes-paused + anomalyId=null 必须能补建异常');
    assert.equal(reported.changed, true);
    assert.ok(reported.notifyRequired && typeof reported.notifyRequired.operationId === 'string', '补建异常必须带通知 operationId');
    const snap = guard.snapshot();
    assert.equal(typeof snap.anomalyId, 'string', '补建后 snapshot.anomalyId 不得为 null');
    assert.equal(snap.notify.status, 'pending');
    assert.equal(readStateFile(dir).anomalyId, snap.anomalyId, '补建异常必须真正落盘');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v4-⑤ persistRestriction 只拒限制减少、允许 rank 相等（且只有一条提交路径）', () => {
  const src = fs.readFileSync(new URL('../src/core/xiaoheihe-identity-guard.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function persistRestriction'), src.indexOf('async function persistLift'));
  assert.ok(body.length > 0, 'persistRestriction 必须存在');
  // 不变量：只有「rank 下降」= 调用方误用 → 明确失败；rank 相等是合法的补记（m01338 回归修正：
  // all-paused+notify.pending 记录 deadline 升级、writes-paused+anomalyId=null 补建异常都必须能落盘）。
  assert.match(body, /restriction-loosened/);
  assert.ok(!/restriction-not-increased/.test(body), '旧「严格上升」语义已废弃：rank 相等必须允许');
  assert.match(body, /STATE_RANK\[next\.state\] < STATE_RANK\[state\.state\]/, '只允许拒绝 rank 下降');
  assert.ok(!/return persisted\.ok \?/.test(body), 'persistRestriction 内不得保留「失败不提交内存」的第二条路径');
  assert.ok(!/const persisted = await persist\(next\);\s*\n\s*return persisted;/.test(body), '误用分支不得退化成普通 persist 直返');
  // 正常路径必须仍由本函数负责「先提交内存再落盘」（限制必须生效）
  assert.match(body, /state = next;\s*\n\s*const persisted = await persist\(next\);/);
});

test('m01388-A 磁盘 normal + degraded:true → load 接受，且 effectiveState 必须是 all-paused', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'identity-guard.json');
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        state: 'normal',
        since: START,
        anomalyId: null,
        anomalyKind: null,
        anomalyDetail: null,
        skipReason: null,
        identityOk: null,
        notify: { status: null, operationId: null, attempts: 0, lastAt: null, lastCode: null, deliveredAt: null },
        restoreNotify: { status: null, operationId: null, attempts: 0, lastAt: null, lastCode: null, deliveredAt: null },
        manualRecovery: { required: false, lastRejectReason: null },
        degraded: true,
      }),
      'utf8',
    );
    const guard = makeGuard(dir);
    const loaded = await guard.load();
    assert.equal(loaded.ok, true, 'D-3 不禁止 normal + degraded:true，必须可加载');
    assert.equal(loaded.state, 'normal');
    const snap = guard.snapshot();
    assert.equal(snap.state, 'normal', 'state 是事实状态，不得被改写');
    assert.equal(snap.degraded, true);
    assert.equal(snap.effectiveState, 'all-paused', 'degraded 必须视同 all-paused（接线只读 effectiveState）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('m01388-B normal 态 persist 失败 → effectiveState 立即变为 all-paused（不等下一次异常）', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'identity-guard.json');
  try {
    const guard = makeGuard(dir);
    const loaded = await guard.load();
    assert.equal(loaded.ok, true);
    assert.equal(loaded.state, 'normal');
    // 制造运行期 persist 失败：把目标文件路径占成同名目录（load 时路径不存在，已正常通过）
    fs.mkdirSync(file);
    const restored = await guard.reportIdentityRestored({ identityOk: true });
    assert.equal(restored.ok, false);
    assert.equal(restored.reason, 'persist-failed');
    const snap = guard.snapshot();
    assert.equal(snap.state, 'normal', '事实状态仍是 normal（限制尚未增加）');
    assert.equal(snap.degraded, true, '落盘失败必须置 degraded');
    assert.equal(snap.effectiveState, 'all-paused', '瞬时窗口必须按 all-paused 判定，不等下一次异常');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('m01388-C recoverManually 非布尔真值不算满足（精确 failed 列表）', async () => {
  const cases = [
    [{ identityOk: 'yes', qqCommsOk: true, reportDelivered: true }, ['identity', 'report-receipt']],
    [{ identityOk: true, qqCommsOk: 1, reportDelivered: true }, ['qq-comms', 'report-receipt']],
    [{ identityOk: true, qqCommsOk: true, reportDelivered: 'false' }, ['report-receipt']],
  ];
  for (const [args, expectedFailed] of cases) {
    const dir = makeDir();
    try {
      const guard = makeGuard(dir);
      await guard.load();
      await guard.reportAnomaly({ kind: 'identity', detail: 'x' });
      await guard.reportNotifyResult({ operationId: guard.snapshot().notify.operationId, outcome: 'unknown' });
      const result = await guard.recoverManually(args);
      assert.equal(result.ok, false, `${JSON.stringify(args)} 不得被当满足`);
      assert.equal(result.reason, 'precondition-failed');
      assert.deepEqual(result.failed, expectedFailed);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ── task-69：unknown 可重发 + attempts 上限（P1-B）+ 耗尽后人工恢复逃生阀（P1-A）────

async function guardInAllPausedWithUnknown(dir, times) {
  const guard = makeGuard(dir);
  await guard.load();
  const anomaly = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'task69-deadlock' });
  const operationId = anomaly.notifyRequired.operationId;
  for (let i = 0; i < times; i += 1) {
    await guard.reportNotifyResult({ operationId, outcome: 'unknown' });
  }
  return { guard, operationId };
}

test('task-69 P1-B：同一 unknown 重复回执必须计入 attempts，达到上限 retriesExhausted=true', async () => {
  const dir = makeDir();
  try {
    const { guard } = await guardInAllPausedWithUnknown(dir, 3);
    const snap = guard.snapshot();
    console.error(`[diag-task69-b] attempts=${snap.notify.attempts} exhausted=${snap.notify.retriesExhausted} state=${snap.state} status=${snap.notify.status}`);
    assert.equal(snap.state, 'all-paused', 'unknown 必须升级全停（未知结果不得当 delivered）');
    assert.equal(snap.notify.status, 'unknown');
    assert.equal(snap.notify.attempts, 3, '重复同一 outcome 必须计入 attempts（P1-B：旧实现幂等短路吞掉计数）');
    assert.equal(snap.notify.retriesExhausted, true, '达到上限必须暴露可观察的耗尽标记');
    assert.equal(readStateFile(dir).notify.attempts, 3, 'attempts 必须落盘');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-75 t1 回归：三次 unknown 后 reportDelivered:false 必须被拒（收回 task-69「耗尽即回执」放宽，用户规则 §4/§5）', async () => {
  // 旧断言（task-69 P1-A）把「重试耗尽」当作「补报已收到发送接口成功回执」的替代依据，
  // 与用户规则 m13214 §4（必须已收到发送接口成功回执）/§5（未知结果不能视为成功）冲突；
  // 该放宽是 Lead 在 task-69 规格里写进去的，并非用户批准行为，本用例把它钉回收紧语义。
  const dir = makeDir();
  try {
    const { guard } = await guardInAllPausedWithUnknown(dir, 3);
    const snap = guard.snapshot();
    assert.equal(snap.state, 'all-paused');
    assert.equal(snap.notify.retriesExhausted, true, '耗尽仍可观测（但不得作为恢复依据）');
    assert.equal(snap.notify.status, 'unknown');
    assert.equal(snap.manualRecovery.reportReceiptBasis, null, '耗尽不得产生回执依据');
    const rejected = await guard.recoverManually({ identityOk: true, qqCommsOk: true, reportDelivered: false });
    console.error(`[diag-task75-t1] recover=${JSON.stringify(rejected)}`);
    assert.equal(rejected.ok, false, '没有任何真实回执就解锁 = 违反 §4/§5');
    assert.equal(rejected.reason, 'precondition-failed');
    assert.deepEqual(rejected.failed, ['report-receipt']);
    assert.equal(rejected.reportReceiptBasis, null);
    assert.equal(guard.snapshot().state, 'all-paused', '被拒后必须保持 all-paused');
    assert.equal(readStateFile(dir).state, 'all-paused', '被拒后磁盘保持 all-paused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-69：重试未耗尽时 manual recovery 仍拒绝 report-receipt（不得提前放宽）', async () => {
  const dir = makeDir();
  try {
    const { guard } = await guardInAllPausedWithUnknown(dir, 1);
    const rejected = await guard.recoverManually({ identityOk: true, qqCommsOk: true, reportDelivered: false });
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.failed, ['report-receipt']);
    assert.equal(guard.snapshot().state, 'all-paused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── task-69 P1-C：状态文件损坏 → 可观察 + 恢复不被 report-receipt 永久拒绝（双条件，防放宽）──

function writeGuardStateFile(dir, raw) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'identity-guard.json'), raw);
}

async function corruptGuardCase(raw, expectedReason) {
  const dir = makeDir();
  const guard = makeGuard(dir);
  writeGuardStateFile(dir, raw);
  const loaded = await guard.load();
  console.error(`[diag-task69-p1c-load-${expectedReason}] ${JSON.stringify(loaded)}`);
  assert.deepEqual(loaded, { ok: true, failClosed: true, state: 'all-paused', reason: expectedReason });
  const snap = guard.snapshot();
  assert.equal(snap.state, 'all-paused');
  assert.equal(snap.skipReason, expectedReason);
  assert.equal(snap.manualRecovery.required, true);
  // task-77：不再有免回执通道；未收到真实回执时 basis 必须是 null
  assert.equal(snap.manualRecovery.reportReceiptBasis, null);
  assert.equal(snap.notify.operationId, null);
  // 但损坏且从未通知 ⇒ 允许发起受控补报（让真实回执可达）
  assert.equal(snap.controlledRecoveryAvailable, true, '损坏且从未通知 ⇒ 可发起受控补报');
  // 无真实回执：任何调用方提示都必须被拒
  const noReceipt = await guard.recoverManually({ identityOk: true, qqCommsOk: true, reportDelivered: true });
  assert.equal(noReceipt.ok, false, JSON.stringify(noReceipt));
  assert.deepEqual(noReceipt.failed, ['report-receipt']);
  assert.equal(noReceipt.reportReceiptBasis, null);
  // 受控补报告警 → 真实回执 → 才能恢复
  const declared = await guard.declareControlledRecoveryAnomaly({ detail: 'state-file-unreadable' });
  console.error(`[diag-task77-p1c-declare-${expectedReason}] ${JSON.stringify(declared)}`);
  assert.equal(declared.ok, true, JSON.stringify(declared));
  assert.equal(declared.changed, true);
  console.error(`[diag-task77-p1c-recover-${expectedReason}] ready`);
  const declaredSnap = guard.snapshot();
  assert.equal(declaredSnap.anomalyId, declared.notifyRequired.operationId);
  assert.equal(declaredSnap.notify.operationId, declared.notifyRequired.operationId);
  assert.equal(declaredSnap.notify.status, 'pending');
  assert.equal(declaredSnap.anomalyKind, 'state-corruption');
  assert.equal(declaredSnap.skipReason, expectedReason, 'skipReason 作为损坏原因保留');
  assert.equal(declaredSnap.state, 'all-paused', '声明补报不减少限制');
  assert.equal(declaredSnap.controlledRecoveryAvailable, false, '已有通知后不得再声明');
  // 回执未到 → 仍拒
  const pending = await guard.recoverManually({ identityOk: true, qqCommsOk: true });
  assert.equal(pending.ok, false);
  assert.deepEqual(pending.failed, ['report-receipt']);
  assert.equal(pending.reportReceiptBasis, null);
  // 真实 delivered
  assert.equal((await guard.reportNotifyResult({ operationId: declared.notifyRequired.operationId, outcome: 'delivered', code: 'qq-ok' })).ok, true);
  assert.equal(guard.snapshot().manualRecovery.reportReceiptBasis, 'delivered');
  const recovered = await guard.recoverManually({ identityOk: true, qqCommsOk: true });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.reportReceiptBasis, 'delivered');
  assert.equal(guard.snapshot().state, 'normal');
  assert.equal(guard.snapshot().manualRecovery.required, false);
  assert.equal(readStateFile(dir).state, 'normal', '恢复必须落盘');
  // 身份条件仍必须满足（P1-C 不放宽 P1-A 之外的东西）
  const dir2 = makeDir();
  try {
    const guard2 = makeGuard(dir2);
    writeGuardStateFile(dir2, raw);
    assert.deepEqual(await guard2.load(), { ok: true, failClosed: true, state: 'all-paused', reason: expectedReason });
    const declared2 = await guard2.declareControlledRecoveryAnomaly({ detail: 'state-file-unreadable' });
    assert.equal(declared2.ok, true, JSON.stringify(declared2));
    assert.equal((await guard2.reportNotifyResult({ operationId: declared2.notifyRequired.operationId, outcome: 'delivered' })).ok, true);
    const rejected = await guard2.recoverManually({ identityOk: false, qqCommsOk: true });
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.failed, ['identity']);
    assert.equal(guard2.snapshot().state, 'all-paused');
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

test('task-69 P1-C：损坏 JSON → failClosed 可区分、恢复不被 report-receipt 拦住、恢复后 normal', async () => {
  await corruptGuardCase('{ bad json', 'state-corrupt');
});

test('task-69 P1-C：schema 版本不支持 → 同上（不得改 SCHEMA_VERSION 规避）', async () => {
  await corruptGuardCase(JSON.stringify({ schemaVersion: 999 }), 'schema-version-unsupported');
});

test('task-69 P1-C：空状态文件 → 同上', async () => {
  await corruptGuardCase('', 'state-corrupt');
});

test('task-69 P1-C 反向：真通知失败（operationId 存在、未耗尽）仍必须拒绝 report-receipt', async () => {
  const dir = makeDir();
  try {
    const { guard } = await guardInAllPausedWithUnknown(dir, 1);
    const snap = guard.snapshot();
    assert.equal(snap.manualRecovery.reportReceiptBasis, null, '有通知但未确认时不得用 no-notice-required 放宽');
    const rejected = await guard.recoverManually({ identityOk: true, qqCommsOk: true });
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.failed, ['report-receipt']);
    assert.equal(rejected.reportReceiptBasis, null);
    assert.equal(guard.snapshot().state, 'all-paused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-69 P1-C 反向：正常首启（无通知、skipReason=null）不得被误判 no-notice-required', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    assert.deepEqual(await guard.load(), { ok: true, state: 'normal' });
    const snap = guard.snapshot();
    assert.equal(snap.skipReason, null);
    assert.equal(snap.notify.operationId, null);
    assert.equal(snap.manualRecovery.reportReceiptBasis, null, '只凭 operationId===null 不得放行（双条件）');
    const rejected = await guard.recoverManually({ identityOk: true, qqCommsOk: true });
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.failed, ['report-receipt']);
    assert.equal(rejected.reportReceiptBasis, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('degraded 重启语义（task-78 更新）：落盘失败的内存限制在重启后由 degraded latch 检出并 fail-closed', async () => {
  // 说明：task-64 的 degraded 告警文案一度写成「重启不回滚该限制」，与真实行为相反。
  // task-78 起新增降级锁存：落盘失败的「限制只在内存」会留下 <stateFile>.degraded-latch 痕迹，
  // 重启时 applyLoad() 复核发现磁盘 rank 不足 → fail-closed 到 all-paused（load-failed），
  // 不再静默回到 normal。本用例钉死三条事实：
  //   F1 落盘失败 → 内存 writes-paused + degraded=true，磁盘仍是上一次成功写的 normal；
  //   F2 不修磁盘直接重启（新实例 load）→ fail-closed all-paused + skipReason='load-failed'（白名单内，受控补报可达）；
  //   F3 degraded 从不被持久化（磁盘 degraded 恒为 false）。
  const dir = makeDir();
  const file = path.join(dir, 'identity-guard.json');
  try {
    const guard = makeGuard(dir);
    await guard.load();
    const ok = await guard.reportIdentityRestored({ identityOk: true });
    assert.equal(ok.ok, true);
    assert.equal(readStateFile(dir).state, 'normal');

    // 只读属性制造写失败，但文件仍可读（模拟「磁盘写不进、旧文件还在」）
    fs.chmodSync(file, 0o444);
    const failed = await guard.reportAnomaly({ kind: 'mapper-unavailable', detail: 'disk-readonly' });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'persist-failed');
    assert.equal(failed.committedInMemory, true);
    assert.equal(guard.snapshot().state, 'writes-paused');
    assert.equal(guard.snapshot().degraded, true);
    assert.equal(guard.snapshot().effectiveState, 'all-paused');

    // F1：磁盘仍是上一次成功写的 normal，degraded 从未落盘（F3）；但必须留下可检测的 latch 痕迹
    const onDisk = readStateFile(dir);
    assert.equal(onDisk.state, 'normal', '落盘失败时磁盘必须保留旧状态');
    assert.equal(onDisk.degraded, false, 'degraded 是纯内存态，绝不写盘');
    assert.equal(fs.existsSync(latchPathOf(file)), true, '落盘失败必须留下 degraded latch');

    // F2（task-78）：不修磁盘直接「重启」——latch 让「限制只在内存」可检测，不得静默回到 normal
    fs.chmodSync(file, 0o644);
    const restarted = makeGuard(dir);
    const loadResult = await restarted.load();
    assert.equal(loadResult.ok, true);
    assert.equal(loadResult.failClosed, true);
    assert.equal(loadResult.reason, 'load-failed');
    assert.equal(restarted.snapshot().state, 'all-paused', '重启后不得静默回到 normal');
    assert.equal(restarted.snapshot().skipReason, 'load-failed');
    assert.equal(restarted.snapshot().effectiveState, 'all-paused');
    assert.equal(restarted.snapshot().controlledRecoveryAvailable, true, 'fail-closed 后受控补报必须可达');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('degraded 自愈（事实钉住）：磁盘修复后任意一次成功落盘即清 latch 并把磁盘对齐', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'identity-guard.json');
  try {
    const guard = makeGuard(dir);
    await guard.load();
    await guard.reportIdentityRestored({ identityOk: true });
    fs.chmodSync(file, 0o444);
    const failed = await guard.reportAnomaly({ kind: 'mapper-unavailable', detail: 'disk-readonly' });
    assert.equal(failed.reason, 'persist-failed');
    assert.equal(guard.snapshot().degraded, true);

    fs.chmodSync(file, 0o644);
    const healed = await guard.reportIdentityRestored({ identityOk: true });
    assert.equal(healed.ok, true);
    assert.equal(guard.snapshot().degraded, false, '成功落盘必须清 degraded');
    assert.equal(guard.snapshot().state, 'writes-paused', '清 degraded 不等于解除限制');
    const onDisk = readStateFile(dir);
    assert.equal(onDisk.state, 'writes-paused', '成功落盘必须把磁盘对齐到内存');
    assert.equal(onDisk.degraded, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── task-79 P2-2：degraded 是运行期事实，绝不落盘（类2 failClosed 后一次成功落盘必须归一）──

// task-80 P2-2：原来只钉一种载荷（state-corrupt），把归一收窄到仅该 reason 仍全绿（m15 变异实证），
// 但 failClosed 的每一条路径都会置 degraded=true 且都不写 latch —— 载荷必须参数化覆盖。
//
// task-82 P2-2（本轮）：参数化只做到 2/5 仍是空洞 —— `LOAD_FAILURE_SKIP_REASONS` 有五条，
// 只钉 state-corrupt/state-invalid 时，把「归一」写进某一条特定 reason 的分支仍会全绿。
// 因此载荷必须与白名单**集合相等**（见下方 TASK79_PAYLOAD_REASON_COVERAGE 断言），
// 且 load-failed 这一条要靠 latch 构造（文件本身合法，是锁存让它 fail-closed），需要 setup 钩子。
const TASK79_DEGRADED_PAYLOADS = Object.freeze([
  {
    label: 'state-corrupt：文件不是 JSON',
    payload: '{ this is not json',
    expectedReason: 'state-corrupt',
  },
  {
    label: 'schema-version-unsupported：版本号不认识',
    payload: JSON.stringify({ schemaVersion: 999, state: 'normal', since: START }),
    expectedReason: 'schema-version-unsupported',
  },
  {
    label: 'state-invalid：state 枚举非法',
    payload: JSON.stringify({ schemaVersion: 1, state: 'bogus', since: START }),
    expectedReason: 'state-invalid',
  },
  {
    label: 'state-inconsistent：normal 却带 pending notify',
    payload: JSON.stringify({
      schemaVersion: 1, state: 'normal', since: START, anomalyId: null,
      notify: { status: 'pending', operationId: 'op-1', attempts: 0, lastAt: START, lastCode: null, deliveredAt: null },
      restoreNotify: emptyNotifyForFile(), manualRecovery: { required: false }, degraded: false,
    }),
    expectedReason: 'state-inconsistent',
  },
  {
    label: 'load-failed：文件合法但降级锁存要求更高 rank',
    // 文件本身是合法的 normal（不会走 state-* 分支），fail-closed 由「磁盘 rank < latch.intendedRank」触发。
    payload: JSON.stringify({
      schemaVersion: 1, state: 'normal', since: START, anomalyId: null,
      notify: emptyNotifyForFile(), restoreNotify: emptyNotifyForFile(),
      manualRecovery: { required: false }, degraded: false,
    }),
    expectedReason: 'load-failed',
    setup: (file) => {
      // intendedState='all-paused' ⇒ STATE_RANK=2 > 磁盘 normal 的 0 ⇒ load 必须 fail-closed('load-failed')
      writeLatchFile(file, validLatchPayload({ intendedState: 'all-paused', intendedRank: 2 }));
    },
  },
]);

// 白名单是「哪些 load 失败 reason 可以发起受控补报」的唯一依据；载荷表必须与它同集合，
// 否则将来新增一种 failClosed reason 时，P2-2 的归一断言会静默漏掉那条路径（这正是 task-82 的指控）。
test('task-79 P2-2 覆盖面：degraded 载荷表必须与 LOAD_FAILURE_SKIP_REASONS 集合相等', () => {
  const covered = [...new Set(TASK79_DEGRADED_PAYLOADS.map((entry) => entry.expectedReason))].sort();
  assert.deepEqual(covered, [...XHH_IDENTITY_GUARD_LOAD_FAILURE_SKIP_REASONS].sort(),
    '载荷表与白名单不同集合 ⇒ 有 failClosed 路径没有被「degraded 不落盘」断言覆盖');
});

for (const { label, payload, expectedReason, setup } of TASK79_DEGRADED_PAYLOADS) {
  test(`task-79 P2-2（${label}）：failClosed 后一次成功落盘，磁盘上不得出现 degraded:true`, async () => {
    // 复审探针证伪的路径：failClosed（类2）置 degraded=true 但**不写 latch**（没有可写的新状态），
    // 之后任意一次成功 persist 会把内存里的 degraded:true 序列化进磁盘，重启读回一个
    // 语义已过期的降级标记（保守但违反「degraded 纯内存态」不变量，且让注释/断言失真）。
    const dir = makeDir();
    const file = path.join(dir, 'identity-guard.json');
    try {
      fs.writeFileSync(file, payload, 'utf8');
      if (typeof setup === 'function') setup(file);
      const guard = makeGuard(dir);
      const loaded = await guard.load();
      assert.equal(loaded.ok, true);
      assert.equal(loaded.failClosed, true);
      assert.equal(loaded.reason, expectedReason);
      assert.equal(guard.snapshot().degraded, true, '类2 failClosed 在内存里必须是 degraded');
      assert.equal(guard.snapshot().effectiveState, 'all-paused');

      // 受控补报告警：走 persistRestriction（rank 相等/增加），成功落盘
      const declared = await guard.declareControlledRecoveryAnomaly({ detail: 'state-file-unreadable' });
      assert.equal(declared.ok, true, `受控补报必须可达：${JSON.stringify(declared)}`);

      const onDisk = readStateFile(dir);
      assert.equal(onDisk.degraded, false, 'degraded 是纯内存态，成功落盘必须归一为 false');
      assert.equal(onDisk.state, 'all-paused', '归一 degraded 不影响真实状态：仍然 all-paused');
      assert.equal(guard.snapshot().degraded, false, '成功落盘后内存也要清 degraded（与磁盘一致）');

      // 重启：磁盘上没有残留的 degraded:true，加载得到干净的 all-paused + 待补报事实
      const restarted = makeGuard(dir);
      const reloaded = await restarted.load();
      assert.equal(reloaded.ok, true);
      assert.equal(restarted.snapshot().state, 'all-paused');
      assert.equal(restarted.snapshot().degraded, false, '磁盘无 degraded:true 时重启不得凭空 degraded');
      assert.equal(restarted.snapshot().skipReason, expectedReason, 'skipReason 仍保留，供排查');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ── task-82 P2（w4）：applyLoad 的 degradeReason 映射必须由**真实 guard** 钉住 ──
//
// 复审实证：接线侧（hook 的 degradedAlertText）按 `snapshot.degradeReason` 分支出四种文案，
// 但在此之前**只有 stub 快照**在钉这个字段——把 applyLoad 里的
// `degradeReason = degraded ? 'degraded' : null` 改成任何别的取值，接线测试仍全绿。
// 那正是「类4 文案」的唯一数据来源，必须行为级锁死。
test('task-82 P2（w4）：applyLoad 读回磁盘 degraded:true ⇒ degradeReason 必须是 degraded（不是 skipReason）', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'identity-guard.json');
  try {
    // 磁盘现场：结构完全合法，但带着旧版本误写进去的 degraded:true，且 skipReason 残留 state-invalid。
    // 两个字段取值刻意不同（'state-invalid' vs 'degraded'），才能区分映射是「读 skipReason」还是「常量 degraded」。
    writeLatchStateFile(file, {
      state: 'all-paused',
      skipReason: 'state-invalid',
      manualRecovery: { required: true, lastRejectReason: null },
      degraded: true,
    });
    const guard = makeGuard(dir);
    const loaded = await guard.load();
    // 文件本身可加载（不是 fail-closed）：degraded 只是「磁盘上留着陈旧标记」，不影响可读性
    assert.deepEqual(loaded, { ok: true, state: 'all-paused' });
    const snap = guard.snapshot();
    assert.equal(snap.degraded, true, '磁盘 degraded:true 必须被加载进内存');
    assert.equal(snap.effectiveState, 'all-paused');
    assert.equal(snap.degradeReason, 'degraded',
      '类4 的成因常量必须是 degraded —— 若这里变成 state-invalid/skipReason，接线会把它说成「文件损坏」');
    assert.notEqual(snap.degradeReason, snap.skipReason, '两个字段语义不同，不得复用 skipReason 当成因');
    // skipReason 仍然保留原值（它是「为何曾经不可读」的历史记录，与成因正交）
    assert.equal(snap.skipReason, 'state-invalid');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-82 P2（w4）反向对照：磁盘无 degraded 标记 ⇒ degradeReason 必须是 null（不得凭 skipReason 造出成因）', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'identity-guard.json');
  try {
    // 同一份 skipReason 残留、但 degraded:false：此时没有任何降级事实，成因必须是 null。
    writeLatchStateFile(file, {
      state: 'all-paused',
      skipReason: 'state-invalid',
      manualRecovery: { required: true, lastRejectReason: null },
      degraded: false,
    });
    const guard = makeGuard(dir);
    assert.deepEqual(await guard.load(), { ok: true, state: 'all-paused' });
    const snap = guard.snapshot();
    assert.equal(snap.degraded, false);
    assert.equal(snap.degradeReason, null, '未降级时不得给出成因');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── task-72：P1-C 逃生阀覆盖补齐（state-invalid / state-inconsistent 也是「从未有过通知」）──

const EMPTY_NOTIFY = Object.freeze({
  status: null, operationId: null, attempts: 0, lastAt: null, lastCode: null, deliveredAt: null,
});

const TASK72_BAD_STATES = Object.freeze([
  ['state-invalid：非 object（数组）', JSON.stringify([1, 2, 3]), 'state-invalid'],
  ['state-invalid：state 枚举非法', JSON.stringify({ schemaVersion: 1, state: 'bogus', since: START }), 'state-invalid'],
  ['state-invalid：notify 形状坏', JSON.stringify({
    schemaVersion: 1, state: 'normal', since: START, anomalyId: null,
    notify: { status: 'bogus' }, restoreNotify: { ...EMPTY_NOTIFY }, manualRecovery: { required: false },
  }), 'state-invalid'],
  ['state-inconsistent：normal 却带 pending notify', JSON.stringify({
    schemaVersion: 1, state: 'normal', since: START, anomalyId: null,
    notify: { ...EMPTY_NOTIFY, status: 'pending', operationId: 'op-1', lastAt: START },
    restoreNotify: { ...EMPTY_NOTIFY }, manualRecovery: { required: false },
  }), 'state-inconsistent'],
  ['state-inconsistent：all-paused 缺 manualRecovery.required', JSON.stringify({
    schemaVersion: 1, state: 'all-paused', since: START, anomalyId: 'an-1',
    notify: { ...EMPTY_NOTIFY }, restoreNotify: { ...EMPTY_NOTIFY }, manualRecovery: { required: false },
  }), 'state-inconsistent'],
]);

for (const [label, raw, expectedReason] of TASK72_BAD_STATES) {
  test(`task-72：坏文件可恢复（${label}）→ failClosed 可区分 + 恢复不被 report-receipt 拦住`, async () => {
    const dir = makeDir();
    try {
      const guard = makeGuard(dir);
      writeGuardStateFile(dir, raw);
      const loaded = await guard.load();
      assert.deepEqual(loaded, { ok: true, failClosed: true, state: 'all-paused', reason: expectedReason }, label);
      const snap = guard.snapshot();
      assert.equal(snap.skipReason, expectedReason, label);
      assert.equal(snap.notify.operationId, null, '从未有过通知 ⇒ operationId 必须为 null');
      assert.equal(snap.manualRecovery.reportReceiptBasis, null, `${label}：无真实回执时不得产生回执依据`);
      assert.equal(snap.controlledRecoveryAvailable, true, `${label}：损坏且从未通知 ⇒ 可发起受控补报`);
      const noReceipt = await guard.recoverManually({ identityOk: true, qqCommsOk: true, reportDelivered: false });
      assert.equal(noReceipt.ok, false, `${label}：无真实回执必须拒`);
      assert.deepEqual(noReceipt.failed, ['report-receipt']);
      const declared = await guard.declareControlledRecoveryAnomaly({ detail: 'state-file-unreadable' });
      assert.equal(declared.ok, true, `${label}：${JSON.stringify(declared)}`);
      assert.equal(guard.snapshot().controlledRecoveryAvailable, false, `${label}：声明后不得再声明`);
      assert.equal((await guard.reportNotifyResult({ operationId: declared.notifyRequired.operationId, outcome: 'delivered' })).ok, true);
      const recovered = await guard.recoverManually({ identityOk: true, qqCommsOk: true });
      console.error(`[diag-task77-recover-${expectedReason}] ${JSON.stringify(recovered)}`);
      assert.equal(recovered.recovered, true, JSON.stringify(recovered));
      assert.equal(recovered.reportReceiptBasis, 'delivered', label);
      assert.ok(!(recovered.failed ?? []).includes('report-receipt'), '不得因 report-receipt 被拒');
      const after = guard.snapshot();
      assert.equal(after.state, 'normal');
      assert.equal(after.effectiveState, 'normal');
      assert.equal(after.manualRecovery.required, false);
      assert.equal(readStateFile(dir).state, 'normal', '恢复必须落盘');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('task-72 守卫：normal 态即便残留 load-failure skipReason 也不得判 no-notice-required', async () => {
  // P3（task-70）：noNoticeRequired 必须只在 all-paused 生效，防止未来重构在正常态误用。
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    writeGuardStateFile(dir, JSON.stringify({
      schemaVersion: 1, state: 'normal', since: START, anomalyId: null, skipReason: 'state-corrupt',
      notify: { ...EMPTY_NOTIFY }, restoreNotify: { ...EMPTY_NOTIFY }, manualRecovery: { required: false },
    }));
    assert.deepEqual(await guard.load(), { ok: true, state: 'normal' });
    const snap = guard.snapshot();
    assert.equal(snap.state, 'normal');
    assert.equal(snap.skipReason, 'state-corrupt');
    assert.equal(snap.notify.operationId, null);
    assert.equal(snap.manualRecovery.reportReceiptBasis, null, 'normal 态不得判免回执');
    const rejected = await guard.recoverManually({ identityOk: true, qqCommsOk: true });
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.failed, ['report-receipt']);
    assert.equal(rejected.reportReceiptBasis, null);
    // task-77：normal 态不是 all-paused，受控补报也不适用（即便 skipReason 在白名单）
    assert.equal(snap.controlledRecoveryAvailable, false, 'normal 态不得展示受控补报');
    const declared = await guard.declareControlledRecoveryAnomaly({ detail: 'x' });
    assert.deepEqual(declared, { ok: false, reason: 'not-applicable' });
    const stillRejected = await guard.recoverManually({ identityOk: true, qqCommsOk: true });
    assert.equal(stillRejected.ok, false);
    assert.deepEqual(stillRejected.failed, ['report-receipt']);
    assert.equal(stillRejected.reportReceiptBasis, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-72 反向：notify-unknown（deadline 超时）仍必须拒绝 report-receipt', async () => {
  const dir = makeDir();
  let now = START;
  try {
    const guard = makeGuard(dir, { clock: () => now });
    await guard.load();
    await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy' });
    now = START + 10 * MIN;
    const escalated = await guard.evaluateNotifyDeadline();
    assert.equal(escalated.escalated, true);
    const snap = guard.snapshot();
    assert.equal(snap.state, 'all-paused');
    assert.equal(snap.skipReason, 'notify-unknown');
    assert.equal(snap.manualRecovery.reportReceiptBasis, null, '真通知超时不得用 no-notice-required 放宽');
    const rejected = await guard.recoverManually({ identityOk: true, qqCommsOk: true });
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.failed, ['report-receipt']);
    assert.equal(guard.snapshot().state, 'all-paused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── task-73 P2：表驱动反向覆盖（M3 变异「白名单放宽成 skipReason !== null」必须变红）──
// 上面三条反向用例走的是真实通知状态机路径，只覆盖了 skipReason 的一个子集；
// 若把 LOAD_FAILURE_SKIP_REASONS.has(x) 放宽成 x !== null，那三条仍全绿（空洞）。
// 这里直接构造「schema 合法 + all-paused + operationId=null + skipReason 非白名单」的文件，
// 逐一断言逃生阀不得放行。新增非白名单 reason 时本表会自动兜住。
const TASK73_NON_WHITELIST_REASONS = Object.freeze([
  'notify-failed',
  'notify-unknown',
  'notify-deadline-clock-rollback',
  '',                       // 空串：typeof === 'string'，任何「非 null 即放行」的放宽都会误放
  'state-corrupt-typo',     // 形近但不相等：防 startsWith / 前缀匹配式放宽
]);

for (const reason of TASK73_NON_WHITELIST_REASONS) {
  test(`task-73 反向：skipReason=${JSON.stringify(reason)} 不在 load-failure 白名单 ⇒ 必须拒绝 report-receipt`, async () => {
    const dir = makeDir();
    try {
      const guard = makeGuard(dir);
      writeGuardStateFile(dir, JSON.stringify({
        schemaVersion: 1,
        state: 'all-paused',
        since: START,
        anomalyId: null,
        skipReason: reason,
        notify: { ...EMPTY_NOTIFY },
        restoreNotify: { ...EMPTY_NOTIFY },
        manualRecovery: { required: true },
      }));
      // 文件本身 schema 合法 ⇒ load 不 failClosed（这张表测的是逃生阀判定，不是加载校验）
      assert.deepEqual(await guard.load(), { ok: true, state: 'all-paused' }, reason);
      const snap = guard.snapshot();
      assert.equal(snap.state, 'all-paused');
      assert.equal(snap.skipReason, reason);
      assert.equal(snap.notify.operationId, null, '前提：从未通知 ⇒ operationId 必须为 null');
      assert.equal(snap.manualRecovery.reportReceiptBasis, null,
        `skipReason=${JSON.stringify(reason)} 不在白名单，不得判 no-notice-required`);
      const rejected = await guard.recoverManually({ identityOk: true, qqCommsOk: true, reportDelivered: false });
      assert.equal(rejected.ok, false, `skipReason=${JSON.stringify(reason)} 不得被放行`);
      assert.deepEqual(rejected.failed, ['report-receipt']);
      assert.equal(guard.snapshot().state, 'all-paused', '拒绝后必须保持 all-paused');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('task-73 反向：白名单覆盖的 load-failure reason 才可判 no-notice-required（集合相等语义）', async () => {
  // 与上面相反的正向对照：确保本表不是「一律拒绝」的空洞断言。
  // task-75：正向对照**必须直接取白名单导出**，不能手抄一份子集
  // （task-72 的真实 P1 就是「手抄的清单漏了 state-invalid/state-inconsistent」，
  //  这里手抄 4 条漏掉 load-failed 属同一类缺陷：白名单加了新 reason，正向对照却没跟上 → 静默零覆盖）。
  const WHITELISTED = [...XHH_IDENTITY_GUARD_LOAD_FAILURE_SKIP_REASONS];
  assert.ok(WHITELISTED.length >= 5, `白名单导出异常（${WHITELISTED.length} 项），正向对照可能失效`);
  // 反向表与白名单必须互斥：若将来有人把反向表里的 reason 加进白名单，
  // 两个测试会互相矛盾，这里先给出明确失败原因。
  const overlap = TASK73_NON_WHITELIST_REASONS.filter((r) => WHITELISTED.includes(r));
  assert.deepEqual(overlap, [], `反向表与白名单重叠：${overlap.join(',')}（白名单被放宽？）`);
  for (const reason of WHITELISTED) {
    const dir = makeDir();
    try {
      const guard = makeGuard(dir);
      writeGuardStateFile(dir, JSON.stringify({
        schemaVersion: 1,
        state: 'all-paused',
        since: START,
        anomalyId: null,
        skipReason: reason,
        notify: { ...EMPTY_NOTIFY },
        restoreNotify: { ...EMPTY_NOTIFY },
        manualRecovery: { required: true },
      }));
      await guard.load();
      const snap = guard.snapshot();
      assert.equal(snap.manualRecovery.reportReceiptBasis, null, `${reason}：无真实回执时不得产生回执依据`);
      assert.equal(snap.controlledRecoveryAvailable, true, `${reason}：白名单内且从未通知 ⇒ 可发起受控补报`);
      const declared = await guard.declareControlledRecoveryAnomaly({ detail: 'state-file-unreadable' });
      assert.equal(declared.ok, true, `${reason}：${JSON.stringify(declared)}`);
      assert.equal((await guard.reportNotifyResult({ operationId: declared.notifyRequired.operationId, outcome: 'delivered' })).ok, true);
      const recovered = await guard.recoverManually({ identityOk: true, qqCommsOk: true });
      assert.equal(recovered.ok, true, `${reason}：真实回执后才可恢复`);
      assert.equal(recovered.reportReceiptBasis, 'delivered', reason);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('task-72 反向：notify-deadline-clock-rollback 仍必须拒绝 report-receipt', async () => {
  const dir = makeDir();
  let now = START;
  try {
    const guard = makeGuard(dir, { clock: () => now });
    await guard.load();
    await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy' });
    now = START - 10 * MIN; // 时钟回拨：结果不可确认
    const escalated = await guard.evaluateNotifyDeadline();
    assert.equal(escalated.escalated, true);
    const snap = guard.snapshot();
    assert.equal(snap.skipReason, 'notify-deadline-clock-rollback');
    assert.equal(snap.manualRecovery.reportReceiptBasis, null);
    const rejected = await guard.recoverManually({ identityOk: true, qqCommsOk: true });
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.failed, ['report-receipt']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── task-73 P3-2：白名单与「实际会产出的 load-failure reason」集合相等契约 ──
// 背景：task-72 的真实 P1 就是白名单只写了 3 个 reason，漏了 validator 会返回的另 2 个
// （state-invalid / state-inconsistent）。这是「两份独立写法必须保持同步」的结构性问题，
// 注释和变异测试只能降低概率。这里用静态扫描把同步关系钉死：
//   failClosed(...) 的实参 ∪ validateLoadedState() 内的 reason 字面量  ===  白名单集合
// 任一侧新增/删除而另一侧没跟上，本测试立刻变红。

test('task-73 契约：LOAD_FAILURE_SKIP_REASONS 必须等于「applyLoad 内 failClosed 实参 ∪ validator reason」', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const srcPath = path.join(here, '..', 'src', 'core', 'xiaoheihe-identity-guard.mjs');
  const src = fs.readFileSync(srcPath, 'utf8');

  // 范围内切片：只扫发生「加载失败」的那两处，不要扫全模块（别处的 failClosed 语义不同）。
  function slice(fromMarker, toMarker) {
    const from = src.indexOf(fromMarker);
    assert.ok(from > 0, `找不到起点：${fromMarker}`);
    const to = src.indexOf(toMarker, from + fromMarker.length);
    assert.ok(to > from, `找不到终点：${toMarker}`);
    return src.slice(from, to);
  }

  // ① applyLoad() 内的 failClosed('xxx') 字面量（load-failed / state-corrupt）
  const applyLoadBody = slice('async function applyLoad()', '\n  return {\n    load()');
  const failClosedReasons = new Set();
  for (const m of applyLoadBody.matchAll(/failClosed\(\s*'([^']+)'\s*\)/gu)) failClosedReasons.add(m[1]);

  // ② validateLoadedState() / validateStateConsistency() 产出的 reason 字面量
  const validatorBody = slice('function validateLoadedState(', '\n/**\n * D-3');
  const consistencyBody = slice('function validateStateConsistency(', '\n/**\n * 创建小红盒');
  const validatorReasons = new Set();
  for (const body of [validatorBody, consistencyBody]) {
    for (const m of body.matchAll(/reason:\s*'([^']+)'/gu)) validatorReasons.add(m[1]);
  }

  // 扫描器自检：任何一侧扫空都说明本测试已失效，必须红。
  assert.deepEqual([...failClosedReasons].sort(), ['load-failed', 'state-corrupt'],
    'applyLoad 内 failClosed 字面量扫描失效（预期恰好 load-failed + state-corrupt）');
  assert.ok(validatorReasons.size >= 3, `validator reason 太少（${validatorReasons.size}），扫描器可能失效`);

  // task-75（task-74 P2-1）：本测试只认**字符串字面量**，对运行期拼出来的 reason 失明
  // （复审构造的 `failClosed(dynamicReason)` / `reason: ('state-'+'forge')` 两条假绿证明过这点）。
  // 运行期兜底在 failClosed() 内（白名单外的值归一到 'load-failed'），这里从**源码侧**再钉一道：
  // applyLoad 内的 failClosed 只允许「字符串字面量」或**唯一认可的** `valid.reason`（validator 的返回值）。
  // 出现第三种实参形式 → 说明真的在动态造 reason，静态契约已无法覆盖，必须红并要求人工确认。
  const failClosedArgs = [...applyLoadBody.matchAll(/failClosed\(([^)]*)\)/gu)].map((m) => m[1].trim());
  assert.ok(failClosedArgs.length >= 3, `failClosed 调用太少（${failClosedArgs.length}），扫描可能失效`);
  const dynamicArgs = failClosedArgs.filter((arg) => !/^'[^']*'$/u.test(arg) && arg !== 'valid.reason');
  assert.deepEqual(dynamicArgs, [],
    `applyLoad 内出现了非字面量 reason 实参：[${dynamicArgs.join(' , ')}]。` +
    '静态契约看不见运行期值；若确有必要，请同时更新 contract 测试与 failClosed 的白名单归一逻辑。');

  // validator 侧同样禁止动态拼接：只允许 `reason: '字面量'`。
  for (const [name, body] of [['validateLoadedState', validatorBody], ['validateStateConsistency', consistencyBody]]) {
    const returns = [...body.matchAll(/reason:\s*([^,}\n]+)/gu)].map((m) => m[1].trim());
    const bad = returns.filter((v) => !/^'[^']*'$/u.test(v));
    assert.deepEqual(bad, [], `${name} 内出现非字面量 reason：[${bad.join(' , ')}]`);
  }

  const actual = [...new Set([...failClosedReasons, ...validatorReasons])].sort();
  const declared = [...XHH_IDENTITY_GUARD_LOAD_FAILURE_SKIP_REASONS].sort();
  assert.deepEqual(declared, actual,
    `白名单与实现产出不一致：白名单=[${declared.join(',')}] 实现=[${actual.join(',')}]；` +
    '新增 load 失败 reason 时必须同步 LOAD_FAILURE_SKIP_REASONS（否则该损坏态永久锁死）');
});

// ── task-75：补报回执完整性（收回 task-69/task-72 的「耗尽/无通知即回执」放宽）──
// 用户规则 m13214 §4：手动恢复必须确认「补报已收到发送接口成功回执」；§5：未知结果不能视为成功。
// 唯一口径：notify.status==='delivered' **且** notify.operationId===anomalyId（同一异常事件绑定）。
// 损坏态受控恢复：四条件（all-paused + operationId===null + skipReason∈白名单 + 显式 corruptionAck）。

test('task-75 t2：resendNotify 让真实回执可达（pending/attempts=0/state 仍 all-paused → delivered → 恢复 basis=delivered）', async () => {
  const dir = makeDir();
  try {
    const { guard, operationId } = await guardInAllPausedWithUnknown(dir, 3);
    assert.equal(guard.snapshot().state, 'all-paused');
    const resent = await guard.resendNotify({ operationId });
    console.error(`[diag-task75-t2-resend] ${JSON.stringify(resent)}`);
    assert.deepEqual(resent, { ok: true, operationId, attempts: 0 });
    const afterResend = guard.snapshot();
    assert.equal(afterResend.state, 'all-paused', '重发是让回执可达，不是放宽限制：状态保持 all-paused');
    assert.equal(afterResend.notify.status, 'pending');
    assert.equal(afterResend.notify.attempts, 0);
    assert.equal(afterResend.notify.operationId, operationId, '必须保留同一异常事件 operationId');
    assert.equal(afterResend.notify.retriesExhausted, false);
    assert.equal(readStateFile(dir).notify.status, 'pending', '重发必须落盘');
    const delivered = await guard.reportNotifyResult({ operationId, outcome: 'delivered', code: 'qq-ok' });
    assert.equal(delivered.ok, true, JSON.stringify(delivered));
    const snap = guard.snapshot();
    assert.equal(snap.notify.status, 'delivered');
    assert.equal(snap.notify.operationId, snap.anomalyId, '回执必须绑定同一异常事件');
    assert.equal(snap.manualRecovery.reportReceiptBasis, 'delivered');
    const recovered = await guard.recoverManually({ identityOk: true, qqCommsOk: true });
    console.error(`[diag-task75-t2-recover] ${JSON.stringify(recovered)}`);
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.reportReceiptBasis, 'delivered');
    assert.equal(guard.snapshot().state, 'normal');
    assert.equal(readStateFile(dir).state, 'normal', '解除必须落盘');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-75 t3：resendNotify 对 stale / 已 delivered 一律拒绝且不改状态', async () => {
  const dir = makeDir();
  try {
    const { guard, operationId } = await guardInAllPausedWithUnknown(dir, 2);
    const before = guard.snapshot();
    assert.deepEqual(await guard.resendNotify({ operationId: 'op-other' }), { ok: false, reason: 'stale-operation-id' });
    assert.deepEqual(await guard.resendNotify({}), { ok: false, reason: 'invalid-argument' });
    assert.deepEqual(await guard.resendNotify({ operationId: 42 }), { ok: false, reason: 'invalid-argument' });
    const unchanged = guard.snapshot();
    assert.equal(unchanged.notify.status, before.notify.status);
    assert.equal(unchanged.notify.attempts, before.notify.attempts);
    assert.equal(unchanged.state, 'all-paused');
    assert.equal(readStateFile(dir).notify.attempts, before.notify.attempts, '拒绝不得改磁盘');
    assert.equal((await guard.resendNotify({ operationId })).ok, true);
    assert.equal((await guard.reportNotifyResult({ operationId, outcome: 'delivered' })).ok, true);
    assert.deepEqual(await guard.resendNotify({ operationId }), { ok: false, reason: 'already-delivered' });
    assert.equal(guard.snapshot().notify.status, 'delivered');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-75 t4 回归：restoreNotify delivered 不得替代异常通知的补报回执（C3）', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    writeGuardStateFile(dir, JSON.stringify({
      schemaVersion: 1,
      state: 'all-paused',
      since: START,
      anomalyId: 'an-1',
      notify: { ...EMPTY_NOTIFY, status: 'pending', operationId: 'an-1', lastAt: START },
      restoreNotify: { ...EMPTY_NOTIFY, status: 'delivered', operationId: 'rn-1', lastAt: START, deliveredAt: START },
      manualRecovery: { required: true },
    }));
    assert.deepEqual(await guard.load(), { ok: true, state: 'all-paused' });
    const snap = guard.snapshot();
    assert.equal(snap.restoreNotify.status, 'delivered');
    assert.equal(snap.notify.status, 'pending');
    assert.equal(snap.manualRecovery.reportReceiptBasis, null, '解除通知回执不等于补报回执');
    const rejected = await guard.recoverManually({ identityOk: true, qqCommsOk: true, reportDelivered: true });
    console.error(`[diag-task75-t4] ${JSON.stringify(rejected)}`);
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.failed, ['report-receipt']);
    assert.equal(rejected.reportReceiptBasis, null);
    assert.equal(guard.snapshot().state, 'all-paused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-77 t5：损坏态一律拒（无真实回执）→ 受控补报告警 → 真实 delivered → 才能恢复（basis=delivered）', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    writeGuardStateFile(dir, 'null');
    assert.deepEqual(await guard.load(), { ok: true, failClosed: true, state: 'all-paused', reason: 'state-invalid' });
    // 1) 无真实回执：不论调用方怎么提示都必须拒（corruptionAck 例外已删除）
    for (const args of [
      { identityOk: true, qqCommsOk: true },
      { identityOk: true, qqCommsOk: true, reportDelivered: true },
    ]) {
      const refused = await guard.recoverManually(args);
      assert.equal(refused.ok, false, JSON.stringify(args));
      assert.equal(refused.reason, 'precondition-failed');
      assert.deepEqual(refused.failed, ['report-receipt']);
      assert.equal(refused.reportReceiptBasis, null);
    }
    const snap = guard.snapshot();
    assert.equal(snap.state, 'all-paused');
    assert.equal(snap.manualRecovery.reportReceiptBasis, null);
    assert.equal(snap.controlledRecoveryAvailable, true, '损坏且从未通知 ⇒ 可发起受控补报');
    // 2) 受控补报 → 通知可达（state 仍 all-paused）
    const declared = await guard.declareControlledRecoveryAnomaly({ detail: 'state-file-unreadable' });
    console.error(`[diag-task77-t5-declare] ${JSON.stringify(declared)}`);
    assert.equal(declared.ok, true, JSON.stringify(declared));
    assert.equal(declared.changed, true);
    const op = declared.notifyRequired.operationId;
    assert.equal(typeof op, 'string');
    const declaredSnap = guard.snapshot();
    assert.equal(declaredSnap.anomalyId, op);
    assert.equal(declaredSnap.anomalyKind, 'state-corruption');
    assert.equal(declaredSnap.notify.operationId, op);
    assert.equal(declaredSnap.notify.status, 'pending');
    assert.equal(declaredSnap.notify.attempts, 0);
    assert.equal(declaredSnap.skipReason, 'state-invalid', '保留损坏原因（可审计）');
    assert.equal(declaredSnap.state, 'all-paused');
    assert.equal(declaredSnap.controlledRecoveryAvailable, false);
    // 3) 回执未到 → 仍拒
    const pendingReject = await guard.recoverManually({ identityOk: true, qqCommsOk: true, reportDelivered: true });
    assert.equal(pendingReject.ok, false);
    assert.deepEqual(pendingReject.failed, ['report-receipt']);
    // 4) 真实 delivered → 恢复
    assert.equal((await guard.reportNotifyResult({ operationId: op, outcome: 'delivered', code: 'qq-ok' })).ok, true);
    assert.equal(guard.snapshot().manualRecovery.reportReceiptBasis, 'delivered');
    const recovered = await guard.recoverManually({ identityOk: true, qqCommsOk: true });
    console.error(`[diag-task77-t5-recover] ${JSON.stringify(recovered)}`);
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.reportReceiptBasis, 'delivered');
    assert.equal(guard.snapshot().state, 'normal');
    assert.equal(readStateFile(dir).state, 'normal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 5) skipReason 不在白名单（notify-unknown）⇒ 不是 load 损坏，不得发起受控补报
  const dir2 = makeDir();
  try {
    const guard2 = makeGuard(dir2);
    writeGuardStateFile(dir2, JSON.stringify({
      schemaVersion: 1,
      state: 'all-paused',
      since: START,
      anomalyId: null,
      skipReason: 'notify-unknown',
      notify: { ...EMPTY_NOTIFY },
      restoreNotify: { ...EMPTY_NOTIFY },
      manualRecovery: { required: true },
    }));
    assert.deepEqual(await guard2.load(), { ok: true, state: 'all-paused' });
    assert.equal(guard2.snapshot().controlledRecoveryAvailable, false);
    assert.deepEqual(await guard2.declareControlledRecoveryAnomaly({ detail: 'x' }), { ok: false, reason: 'not-applicable' });
    const rejected = await guard2.recoverManually({ identityOk: true, qqCommsOk: true });
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.failed, ['report-receipt']);
    assert.equal(guard2.snapshot().state, 'all-paused');
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('task-77 t5b：可加载的 all-paused+state-corrupt 但已有通知（operationId 非 null）→ declare 必须 notify-already-exists', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    // 可加载（D-3 不禁止 all-paused + skipReason 字段 + pending notify）；
    // 关键点：已经有真实通知，不得再发一条新通知掩盖上一个未知结果。
    writeGuardStateFile(dir, JSON.stringify({
      schemaVersion: 1,
      state: 'all-paused',
      since: START,
      anomalyId: 'an-legit-1',
      anomalyKind: 'identity-legacy',
      anomalyDetail: 'legit',
      skipReason: 'state-corrupt',
      identityOk: null,
      notify: { ...EMPTY_NOTIFY, status: 'pending', operationId: 'op-legit-1', lastAt: START },
      restoreNotify: { ...EMPTY_NOTIFY },
      manualRecovery: { required: true },
    }));
    assert.deepEqual(await guard.load(), { ok: true, state: 'all-paused' });
    const snap = guard.snapshot();
    assert.equal(snap.notify.operationId, 'op-legit-1');
    assert.equal(snap.controlledRecoveryAvailable, false, '已有通知时不得展示「可发起受控补报」');
    const declared = await guard.declareControlledRecoveryAnomaly({ detail: 'state-file-unreadable' });
    console.error(`[diag-task77-t5b-declare] ${JSON.stringify(declared)}`);
    assert.deepEqual(declared, { ok: false, reason: 'notify-already-exists' });
    const rejected = await guard.recoverManually({ identityOk: true, qqCommsOk: true, reportDelivered: true });
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.failed, ['report-receipt']);
    assert.equal(guard.snapshot().notify.operationId, 'op-legit-1', 'declare 被拒不得篡改现有通知');
    assert.equal(guard.snapshot().state, 'all-paused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-77 t8b：可加载 normal + anomalyId=null + notify.delivered(operationId=null) → recoverManually 必须拒', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    // 覆盖洞：D-3 一致性校验只禁「normal + anomalyId 非空 / pending」，不禁 delivered；
    // 这种文件可加载，但没有绑定任何异常事件（anomalyId=null），绝不能算回执。
    writeGuardStateFile(dir, JSON.stringify({
      schemaVersion: 1,
      state: 'normal',
      since: START,
      anomalyId: null,
      anomalyKind: null,
      anomalyDetail: null,
      skipReason: null,
      identityOk: null,
      notify: { ...EMPTY_NOTIFY, status: 'delivered', operationId: null, lastAt: START, deliveredAt: START },
      restoreNotify: { ...EMPTY_NOTIFY },
      manualRecovery: { required: false },
    }));
    assert.deepEqual(await guard.load(), { ok: true, state: 'normal' });
    const snap = guard.snapshot();
    assert.equal(snap.notify.status, 'delivered', '前提：notify 是 delivered');
    assert.equal(snap.anomalyId, null, '前提：没有绑定任何异常事件');
    assert.equal(snap.manualRecovery.reportReceiptBasis, null, 'anomalyId 非字符串 ⇒ 回执不得绑定本事件');
    const rejected = await guard.recoverManually({ identityOk: true, qqCommsOk: true, reportDelivered: true });
    console.error(`[diag-task77-t8b] ${JSON.stringify(rejected)}`);
    assert.equal(rejected.ok, false, '没有本事件绑定的回执时必须拒');
    assert.deepEqual(rejected.failed, ['report-receipt']);
    assert.equal(rejected.reportReceiptBasis, null);
    assert.equal(guard.snapshot().state, 'normal', '被拒不得改变状态');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-77 契约：state-corruption 是合法异常类型；corruptionAck 例外已从源码删除', async () => {
  assert.ok([...XHH_IDENTITY_GUARD_ANOMALY_KINDS].includes('state-corruption'));
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    await guard.load();
    const anomaly = await guard.reportAnomaly({ kind: 'state-corruption', detail: 'state-file-unreadable' });
    assert.equal(anomaly.ok, true, JSON.stringify(anomaly));
    assert.equal(guard.snapshot().anomalyKind, 'state-corruption');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'src', 'core', 'xiaoheihe-identity-guard.mjs'), 'utf8');
  // 只禁「代码级」残留：注释里允许出现「corruptionAck 例外已删除」这类说明。
  assert.ok(!/corruptionAckRequired\s*\(/u.test(src), 'corruptionAckRequired 必须删除');
  assert.ok(!/corruptionAck\s*===\s*true/u.test(src), 'corruptionAck===true 判定必须删除');
  assert.ok(!/reportReceiptBasis:\s*'corruption-acknowledged'/u.test(src), '不再产生 corruption-acknowledged 依据');
  assert.ok(/declareControlledRecoveryAnomaly/u.test(src), '受控补报接口必须存在');
  assert.ok(/controlledRecoveryAvailable\s*:/u.test(src), 'snapshot 必须暴露 controlledRecoveryAvailable');
});

test('task-75 t6：调用方 reportDelivered:true 但内部 notify.status=failed → 仍拒（§2.4 防御）', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    await guard.load();
    const anomaly = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 't75-failed' });
    const operationId = anomaly.notifyRequired.operationId;
    assert.equal((await guard.reportNotifyResult({ operationId, outcome: 'failed', code: 'qq-fail' })).ok, true);
    assert.equal(guard.snapshot().notify.status, 'failed');
    assert.equal(guard.snapshot().state, 'all-paused');
    const rejected = await guard.recoverManually({ identityOk: true, qqCommsOk: true, reportDelivered: true });
    console.error(`[diag-task75-t6] ${JSON.stringify(rejected)}`);
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.failed, ['report-receipt']);
    assert.equal(rejected.reportReceiptBasis, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-75 t7：retriesExhausted 保留为纯可观测字段，但不得产生 reportReceiptBasis', async () => {
  const dir = makeDir();
  try {
    const { guard } = await guardInAllPausedWithUnknown(dir, XHH_IDENTITY_GUARD_NOTIFY_MAX_ATTEMPTS);
    const snap = guard.snapshot();
    assert.equal(snap.notify.retriesExhausted, true, '可观测字段必须保留（接线据此停止自动重发）');
    assert.equal(snap.notify.attempts, XHH_IDENTITY_GUARD_NOTIFY_MAX_ATTEMPTS);
    assert.equal(snap.manualRecovery.reportReceiptBasis, null, '耗尽不得产生回执依据（不得作为恢复依据）');
    const rejected = await guard.recoverManually({ identityOk: true, qqCommsOk: true });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reportReceiptBasis, null);
    assert.equal(guard.snapshot().state, 'all-paused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-75 t8：回执必须绑定本异常事件 —— delivered 但 operationId≠anomalyId 不得放行（纵深防御）', async () => {
  const dir = makeDir();
  try {
    const guard = makeGuard(dir);
    // 公开 API 不会产出「delivered 属于上一个事件」的组合（applyNotifyResult 只认当前 operationId），
    // 因此这条只能用磁盘状态构造：外部手改 / 旧版本写入 / 磁盘损坏都可能造出这种文件。
    writeGuardStateFile(dir, JSON.stringify({
      schemaVersion: 1,
      state: 'all-paused',
      since: START,
      anomalyId: 'anomaly-current',
      anomalyKind: 'mapper-unavailable',
      anomalyDetail: 't75-t8',
      identityOk: null,
      skipReason: null,
      notify: {
        status: 'delivered',
        operationId: 'anomaly-previous',
        attempts: 1,
        lastAt: START,
        lastCode: null,
        deliveredAt: START,
      },
      restoreNotify: { ...EMPTY_NOTIFY },
      manualRecovery: { required: true },
    }));
    assert.deepEqual(await guard.load(), { ok: true, state: 'all-paused' });
    const snap = guard.snapshot();
    assert.equal(snap.notify.status, 'delivered', '前提：notify 仍是 delivered');
    assert.notEqual(snap.notify.operationId, snap.anomalyId, '前提：回执属于上一个事件');
    assert.equal(snap.manualRecovery.reportReceiptBasis, null, '上一个事件的回执不得算作本事件依据');
    const rejected = await guard.recoverManually({ identityOk: true, qqCommsOk: true, reportDelivered: true });
    console.error(`[diag-task75-t8] ${JSON.stringify(rejected)}`);
    assert.equal(rejected.ok, false, '事件不匹配时即便调用方传 reportDelivered:true 也必须拒');
    assert.deepEqual(rejected.failed, ['report-receipt']);
    assert.equal(rejected.reportReceiptBasis, null);
    assert.equal(guard.snapshot().state, 'all-paused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── task-78：降级锁存（degraded latch）──
// 背景：限制增加落盘失败时只提交内存（C-1 保证磁盘故障下限制仍生效），但磁盘仍是旧 normal；
// 进程若在此时重启，applyLoad 读回 normal ⇒ 限制静默消失且无痕迹。
// 方案：persist() 失败时尽力写 `<stateFile>.degraded-latch`，applyLoad() 复核：
//   · 无 latch → 行为不变；
//   · 磁盘状态 rank ≥ latch.intendedRank → 陈旧锁存，删掉后正常加载；
//   · 否则（rank 不足 / 状态文件 ENOENT / latch 不可解析）→ failClosed('load-failed')。
// 'load-failed' 在 LOAD_FAILURE_SKIP_REASONS 白名单内 ⇒ 「受控补报告警 → 真实回执 → 手动恢复」仍可达，
// 不会重演 task-72 P1-C 的永久锁死。
const LATCH_SUFFIX = '.degraded-latch';

function latchPathOf(filePath) {
  return `${filePath}${LATCH_SUFFIX}`;
}

function emptyNotifyForFile() {
  return { status: null, operationId: null, attempts: 0, lastAt: null, lastCode: null, deliveredAt: null };
}

function writeLatchStateFile(filePath, overrides = {}) {
  const base = {
    schemaVersion: XHH_IDENTITY_GUARD_SCHEMA_VERSION,
    state: 'normal',
    since: START,
    anomalyId: null,
    anomalyKind: null,
    anomalyDetail: null,
    skipReason: null,
    identityOk: null,
    notify: emptyNotifyForFile(),
    restoreNotify: emptyNotifyForFile(),
    manualRecovery: { required: false, lastRejectReason: null },
    degraded: false,
  };
  fs.writeFileSync(filePath, `${JSON.stringify({ ...base, ...overrides }, null, 2)}\n`, 'utf8');
}

function writeLatchFile(filePath, content) {
  fs.writeFileSync(latchPathOf(filePath), typeof content === 'string' ? content : `${JSON.stringify(content)}\n`, 'utf8');
}

function readLatchFile(filePath) {
  return JSON.parse(fs.readFileSync(latchPathOf(filePath), 'utf8'));
}

function validLatchPayload(overrides = {}) {
  return { schema: 1, reason: 'persist-failed', at: START, intendedState: 'writes-paused', intendedRank: 1, ...overrides };
}

// 构造「限制只在内存 + latch 已写 + 磁盘仍是旧 normal」的崩溃现场。
// 用「状态文件只读」制造 rename 失败（既有 chmod 注入手法，见 degraded 重启语义用例），
// 文件仍可读 ⇒ 能真实模拟「上次成功落盘的旧 normal 还在」。
async function makeLatchCrashScene(dir) {
  const statePath = path.join(dir, 'latch-state.json');
  const guard = createXiaoheiheIdentityGuard({ filePath: statePath, clock: () => START });
  assert.deepEqual(await guard.load(), { ok: true, state: 'normal' });
  assert.equal((await guard.reportIdentityRestored({ identityOk: true })).ok, true);
  fs.chmodSync(statePath, 0o444);
  const anomaly = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
  assert.equal(anomaly.ok, false);
  assert.equal(anomaly.reason, 'persist-failed');
  assert.equal(anomaly.committedInMemory, true, '前提：限制已提交内存');
  fs.chmodSync(statePath, 0o644);
  return statePath;
}

test('task-78 L1：正常落盘成功后不留下 degraded latch', async () => {
  const dir = makeDir();
  try {
    const filePath = path.join(dir, 'identity-guard.json');
    const guard = makeGuard(dir);
    assert.deepEqual(await guard.load(), { ok: true, state: 'normal' });
    const restored = await guard.reportIdentityRestored({ identityOk: true });
    assert.equal(restored.ok, true);
    assert.equal(fs.existsSync(latchPathOf(filePath)), false, '成功落盘不得留 latch');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-78 L2：限制增加落盘失败 → 内存生效 + 写 degraded latch（含 intendedRank）', async () => {
  const dir = makeDir();
  try {
    const statePath = path.join(dir, 'state-as-directory');
    const guard = createXiaoheiheIdentityGuard({ filePath: statePath, clock: () => START });
    assert.deepEqual(await guard.load(), { ok: true, state: 'normal' });
    fs.mkdirSync(statePath);
    const result = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'legacy-shape' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'persist-failed');
    assert.equal(result.committedInMemory, true);
    assert.equal(guard.snapshot().state, 'writes-paused', '限制必须在内存生效');
    assert.equal(fs.existsSync(latchPathOf(statePath)), true, '落盘失败必须留下可检测痕迹');
    const latch = readLatchFile(statePath);
    console.error(`[diag-task78-l2] ${JSON.stringify(latch)}`);
    assert.equal(latch.schema, 1);
    assert.equal(latch.reason, 'persist-failed');
    assert.equal(latch.intendedState, 'writes-paused');
    assert.equal(latch.intendedRank, 1);
    assert.ok(Number.isFinite(latch.at));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-78 L3：重启后 latch 与磁盘不一致 → fail-closed all-paused（load-failed），绝不允许 normal', async () => {
  const dir = makeDir();
  try {
    const statePath = await makeLatchCrashScene(dir);
    const restarted = createXiaoheiheIdentityGuard({ filePath: statePath, clock: () => START });
    const loaded = await restarted.load();
    console.error(`[diag-task78-l3] ${JSON.stringify({ loaded, snapshot: restarted.snapshot() })}`);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.failClosed, true);
    assert.equal(loaded.reason, 'load-failed');
    const snap = restarted.snapshot();
    assert.equal(snap.state, 'all-paused', '绝不可以在重启后静默回到 normal');
    assert.equal(snap.skipReason, 'load-failed', 'fail-closed reason 必须在 LOAD_FAILURE_SKIP_REASONS 内');
    assert.equal(snap.degraded, true);
    assert.equal(snap.controlledRecoveryAvailable, true, '坏文件必须仍能发起受控补报');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-78 L4：latch 触发 fail-closed 后 declareControlledRecoveryAnomaly 仍可达（不锁死）', async () => {
  const dir = makeDir();
  try {
    const statePath = await makeLatchCrashScene(dir);
    const restarted = createXiaoheiheIdentityGuard({ filePath: statePath, clock: () => START });
    assert.equal((await restarted.load()).reason, 'load-failed');
    const declared = await restarted.declareControlledRecoveryAnomaly({ detail: 'latch-recovered' });
    console.error(`[diag-task78-l4] ${JSON.stringify(declared)}`);
    assert.equal(declared.ok, true, '受控补报必须可达，不得永久锁死');
    assert.equal(declared.changed, true);
    assert.equal(typeof declared.notifyRequired?.operationId, 'string');
    assert.equal(restarted.snapshot().state, 'all-paused', '发起补报不放宽限制');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-78 L5：latch 内容不可解析 → fail-closed 且 skipReason 在白名单内（受控补报可达）', async () => {
  const dir = makeDir();
  try {
    const filePath = path.join(dir, 'identity-guard.json');
    writeLatchStateFile(filePath);
    writeLatchFile(filePath, '{"schema":1,"reason":"persist-failed"');
    const guard = createXiaoheiheIdentityGuard({ filePath, clock: () => START });
    const loaded = await guard.load();
    assert.equal(loaded.ok, true);
    assert.equal(loaded.reason, 'load-failed');
    const snap = guard.snapshot();
    assert.equal(snap.state, 'all-paused');
    assert.ok(XHH_IDENTITY_GUARD_LOAD_FAILURE_SKIP_REASONS.includes(snap.skipReason), 'reason 必须在白名单内');
    assert.equal(snap.controlledRecoveryAvailable, true);
    const declared = await guard.declareControlledRecoveryAnomaly({ detail: 'latch-unparseable' });
    assert.equal(declared.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-78 L6：latch 陈旧（磁盘状态 rank 更高）→ 删除并正常加载（不误判）', async () => {
  const dir = makeDir();
  try {
    const filePath = path.join(dir, 'identity-guard.json');
    writeLatchStateFile(filePath, { state: 'all-paused', manualRecovery: { required: true, lastRejectReason: null } });
    writeLatchFile(filePath, validLatchPayload());
    const guard = createXiaoheiheIdentityGuard({ filePath, clock: () => START });
    const loaded = await guard.load();
    assert.deepEqual(loaded, { ok: true, state: 'all-paused' });
    assert.equal(guard.snapshot().state, 'all-paused');
    assert.equal(fs.existsSync(latchPathOf(filePath)), false, '陈旧 latch 必须被清除');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-78 L7：latch 删除失败不影响 persist 成功语义（不抛错、不改变结果）', async () => {
  const dir = makeDir();
  try {
    const filePath = path.join(dir, 'identity-guard.json');
    const guard = createXiaoheiheIdentityGuard({ filePath, clock: () => START });
    assert.deepEqual(await guard.load(), { ok: true, state: 'normal' });
    // 先正常加载（此时无 latch），再把 latch 路径占位成目录：成功落盘后清理 latch 会 unlink 失败
    fs.mkdirSync(latchPathOf(filePath));
    const restored = await guard.reportIdentityRestored({ identityOk: true });
    assert.equal(restored.ok, true, 'latch 删除失败不得影响成功语义');
    assert.equal(guard.snapshot().state, 'normal');
    assert.equal(fs.existsSync(latchPathOf(filePath)), true, '前提：删除确实失败过');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-78 L8：latch fail-closed → 受控补报 → 真实回执 → 手动恢复后，重启不得再 fail-closed（无锁死循环）', async () => {
  const dir = makeDir();
  try {
    const statePath = await makeLatchCrashScene(dir);
    const restarted = createXiaoheiheIdentityGuard({ filePath: statePath, clock: () => START });
    assert.equal((await restarted.load()).reason, 'load-failed');
    const declared = await restarted.declareControlledRecoveryAnomaly({ detail: 'latch-loop' });
    assert.equal(declared.ok, true);
    const operationId = declared.notifyRequired.operationId;
    const delivered = await restarted.reportNotifyResult({ operationId, outcome: 'delivered' });
    assert.equal(delivered.ok, true);
    const recovered = await restarted.recoverManually({ identityOk: true, qqCommsOk: true });
    console.error(`[diag-task78-l8] ${JSON.stringify(recovered)}`);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.reportReceiptBasis, 'delivered');
    assert.equal(restarted.snapshot().state, 'normal');
    assert.equal(fs.existsSync(latchPathOf(statePath)), false, '显式恢复后 latch 必须清除，否则每次重启都会再锁');
    const third = createXiaoheiheIdentityGuard({ filePath: statePath, clock: () => START });
    const loaded = await third.load();
    assert.deepEqual(loaded, { ok: true, state: 'normal' }, '恢复并落盘后重启必须正常加载');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-78 L9：状态文件 ENOENT 但 latch 存在 → fail-closed（不得当作首启 normal）', async () => {
  const dir = makeDir();
  try {
    const filePath = path.join(dir, 'identity-guard.json');
    writeLatchFile(filePath, validLatchPayload());
    const guard = createXiaoheiheIdentityGuard({ filePath, clock: () => START });
    const loaded = await guard.load();
    assert.equal(loaded.ok, true);
    assert.equal(loaded.reason, 'load-failed');
    const snap = guard.snapshot();
    assert.equal(snap.state, 'all-paused');
    assert.equal(snap.skipReason, 'load-failed');
    const declared = await guard.declareControlledRecoveryAnomaly({ detail: 'latch-enoent' });
    assert.equal(declared.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-83 F2：锁存写失败必须留下只读事实位（degradedLatchWriteFailed=true），成功写则=false', async () => {
  // 背景（task-83 演练报告 §3 P2）：persist 与 latch 同时失败时，磁盘上连「曾经降级」的痕迹都没有，
  // 重启后限制静默消失且事后无从查证。跨文件原子性无法靠代码消除（报告已明确不宣称解决），
  // 因此这里只钉住一件事：**事发当时必须能在 snapshot 里看到「锁存也没写成功」**。
  // 该事实位只做可观测，不参与任何判定——下面同时钉住「它不影响持久化失败语义」。
  const dir = makeDir();
  try {
    const statePath = path.join(dir, 'latch-fact.json');
    const guard = createXiaoheiheIdentityGuard({ filePath: statePath, clock: () => START });
    assert.deepEqual(await guard.load(), { ok: true, state: 'normal' });
    // ENOENT 首启不会落盘，先做一次成功落盘（否则 chmod 没有对象可改）
    assert.equal((await guard.reportIdentityRestored({ identityOk: true })).ok, true);
    assert.equal(fs.existsSync(statePath), true, '前提：状态文件已存在');
    // 让 latch 路径变成目录 => rename(tmp, latchPath) 必然失败，恰好模拟「锁存也写失败」。
    fs.mkdirSync(latchPathOf(statePath));
    fs.chmodSync(statePath, 0o444); // persist 也失败（rename 覆盖只读文件失败）
    const result = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'latch-fact-both-failed' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'persist-failed');
    assert.equal(result.committedInMemory, true, '锁存失败不得回滚内存中的限制');
    const snap = guard.snapshot();
    console.error(`[diag-task83-f2] ${JSON.stringify({ degraded: snap.degraded, degradeReason: snap.degradeReason, degradedLatchWriteFailed: snap.degradedLatchWriteFailed })}`);
    assert.equal(snap.degraded, true);
    assert.equal(snap.degradeReason, 'persist-failed');
    assert.equal(snap.effectiveState, 'all-paused');
    assert.equal(snap.degradedLatchWriteFailed, true, '锁存写失败必须在 snapshot 里可见（否则事后无痕）');
    // 可观测位不得改变「限制仍然生效」这个主语义
    assert.equal(snap.state, 'writes-paused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-83 F2：锁存写成功时事实位必须=false，且成功落盘后随 degraded 一并归零', async () => {
  const dir = makeDir();
  try {
    const statePath = path.join(dir, 'latch-fact-ok.json');
    const guard = createXiaoheiheIdentityGuard({ filePath: statePath, clock: () => START });
    assert.deepEqual(await guard.load(), { ok: true, state: 'normal' });
    // ENOENT 首启不会落盘，先做一次成功落盘（否则 chmod 没有对象可改）
    assert.equal((await guard.reportIdentityRestored({ identityOk: true })).ok, true);
    assert.equal(fs.existsSync(statePath), true, '前提：状态文件已存在');
    fs.chmodSync(statePath, 0o444); // 只有 persist 失败，latch 路径可写
    const result = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'latch-fact-latch-ok' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'persist-failed');
    const snap = guard.snapshot();
    assert.equal(snap.degraded, true);
    assert.equal(snap.degradedLatchWriteFailed, false, '锁存写成功必须报 false（否则告警会吓人）');
    assert.equal(fs.existsSync(latchPathOf(statePath)), true, '前提：锁存确实写成了');

    // 修好磁盘后成功落盘 => degraded 自愈，事实位也随之不再对外呈现
    fs.chmodSync(statePath, 0o644);
    const retried = await guard.retryPersist();
    assert.equal(retried.ok, true);
    const healed = guard.snapshot();
    assert.equal(healed.degraded, false);
    assert.equal(healed.degradedLatchWriteFailed, false, '未降级时不得残留锁存失败事实（避免长期吓人）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task-84 P2-2：degraded 掩码不可省略 —— 锁存写失败后若成功落盘自愈，事实位必须归零', async () => {
  // 复审实证（task-84 §3 V1）：把 snapshot 里 `degraded === true && latchWriteFailed === true`
  // 的 `degraded === true &&` 掩码删掉后，guard 全套 120/120 仍全绿 —— 既有两条 F2 用例
  // 分别是「锁存失败且未自愈」与「锁存成功且自愈」，恰好绕过了「锁存失败 + 随后自愈」这个组合。
  // 该组合下如果只看 latchWriteFailed，事实位会在自愈后长期停在 true：运维看到「锁存也写失败、
  // 千万别重启」，而磁盘其实早已可写、限制也已落盘 —— 变成吓人的假警报。
  const dir = makeDir();
  try {
    const statePath = path.join(dir, 'latch-mask.json');
    const guard = createXiaoheiheIdentityGuard({ filePath: statePath, clock: () => START });
    assert.deepEqual(await guard.load(), { ok: true, state: 'normal' });
    assert.equal((await guard.reportIdentityRestored({ identityOk: true })).ok, true);
    assert.equal(fs.existsSync(statePath), true, '前提：状态文件已存在');

    // 让锁存必然写失败（路径被目录占用），同时让 persist 失败（只读文件）
    fs.mkdirSync(latchPathOf(statePath));
    fs.chmodSync(statePath, 0o444);
    const failed = await guard.reportAnomaly({ kind: 'identity-legacy', detail: 'latch-mask-both-failed' });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'persist-failed');
    const snapped = guard.snapshot();
    assert.equal(snapped.degraded, true, '前提：落盘失败 ⇒ degraded');
    assert.equal(snapped.degradedLatchWriteFailed, true, '前提：锁存也没写成 ⇒ 事实位 true');

    // 修好磁盘（锁存路径仍被目录占着，delete 失败被吞掉），一次成功落盘即可自愈
    fs.chmodSync(statePath, 0o644);
    const retried = await guard.retryPersist();
    assert.equal(retried.ok, true, '前提：磁盘修好后 retryPersist 成功');
    const healed = guard.snapshot();
    assert.equal(healed.degraded, false, '前提：成功落盘 ⇒ degraded 自愈');
    assert.equal(healed.degradedLatchWriteFailed, false,
      '未降级时不得再报「锁存写失败」——事实位必须被 degraded===true 掩掉，否则自愈后仍是假警报');
    assert.equal(fs.existsSync(latchPathOf(statePath)), true, '前提：锁存残留仍在（清理失败被吞），掩码才是唯一防线');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
