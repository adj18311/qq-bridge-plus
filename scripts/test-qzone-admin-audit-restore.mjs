// M9 · AUDIT / STORAGE FAULT RECOVERY — pins §5.2's three steps and §5.3's four boundaries.
//
// WHAT IS BEING PINNED (and why each assertion exists)
// ---------------------------------------------------
//   AR-1..AR-4, AR-6..AR-8 are BEHAVIOURAL: they drive `restoreOfflineAuditFault` against a real
//   temporary SQLite store and read the persisted result back.
//   AR-5 injects a REAL audit-write failure through the real code path (two different ways) instead
//   of mocking the module, so "the transaction rolled back" is proven by the store, not by a stub.
//   AR-7/AR-8 additionally carry SOURCE-SHAPE assertions. That is deliberate and it is not laziness:
//   with ONE transactional store, moving "clear the fault" above "append the audit row" is
//   behaviourally invisible (a throw rolls both back), so a behavioural test alone cannot see the
//   swap. The source assertions catch the code motion; the runtime assertions catch the variant that
//   also rewrites the recorded content. Both are needed, and the report states which one fired.
//
// WHAT THIS FILE DOES NOT CLAIM
// -----------------------------
// It does not prove the caller is authenticated — that belongs to the console/script entry point.
// `restoreOfflineAuditFault` is a library function; the checks here are about the TRANSACTION, not
// about who may call it.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openOfflineStore, authorityOf } from '../src/core/qzone-store-offline.mjs';
import * as admin from '../src/core/qzone-admin-offline.mjs';
import { checkWriteGate, beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { formatAuditGap, isAuditGap } from '../src/core/qzone-audit-offline.mjs';
import { latchFault, readFaultLatch, createOfflineWritePath } from '../src/core/qzone-write-path-offline.mjs';
import { createWriteObservability } from '../src/core/qzone-write-observability-offline.mjs';

const T0 = 1_800_000_000_000;
const NOW = T0 + 1_000;
/** Shapes match `gapGenerationFor()`: 'g' + 24 hex. Values are arbitrary but distinct. */
const GEN = 'g0123456789abcdef01234567';
const OTHER_GEN = 'gfedcba9876543210fedcba98';
const GATE = Object.freeze({ fault: 'audit-unavailable', since: T0 - 5_000, cause: 'audit-state-invalid' });

const gap = (over = {}) => formatAuditGap({
  key: 'settle-1', reason: 'audit-state-invalid', generation: GEN, time: T0, ...over,
});

/**
 * A store that is faulted AND carries everything R-2 says recovery must NOT touch: a spent quota,
 * a comment cooldown, a like's dedup evidence, a live reservation, and a platform pause on both
 * layers. Every one of them is a separate sentinel for AR-6.
 */
const baseState = (over = {}) => ({
  enabled: true, readAllowed: true, writeAllowed: true,
  accessPaused: true, writePaused: true, reads: 2, writes: 3, probe: 'manual_only',
  ledger: { day: '2026-11-13', used: { post: 2, comment: 8, like: 9 }, reservations: { 'res-1': 'post' } },
  commentTargets: [{ target: '10001', time: T0 - 60_000 }],
  likes: [{ author: '10001', id: 'p-1' }],
  audit: [],
  writeGate: { ...GATE },
  auditGaps: [gap()],
  ...over,
});

const actor = (over = {}) => ({
  operator: 'ops-1', source: 'admin_console', target: '123456', time: NOW,
  auditId: 'restore-audit-fault-1', ...over,
});

/**
 * A store with NOTHING wrong: no gate, no gaps, no pause, quota available. This is what a real
 * process-latch-only fault leaves behind — the settlement transaction rolled back, so it recorded
 * nothing, and the latch is the ONLY evidence.
 */
const healthyState = (over = {}) => ({
  enabled: true, readAllowed: true, writeAllowed: true,
  accessPaused: false, writePaused: false, reads: 0, writes: 0,
  tools: { publish: true, comment: true, reply: true, like: true },
  limits: { post: 3, comment: 25, like: 30 },
  intervalMinutes: 30, activeStart: 0, activeEnd: 1440,
  ledger: { day: beijingDay(NOW), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
  commentTargets: [], likes: [], audit: [], writeGate: null, auditGaps: [],
  ...over,
});

/** A `like` carries no body (t10): the facade refuses one that does. */
const likeReq = (over = {}) => ({
  id: 'like-1', action: 'like', target: '10001', postId: 'p-1', source: 'qq', ...over,
});

async function fixture(t, initial) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-audit-restore-'));
  const db = openOfflineStore(join(dir, 'state.db'), initial);
  // Some tests close the store themselves (to prove persistence or to seed a second store). Closing
  // twice is an error in `qzone-store-offline.mjs`, so the cleanup is tolerant on purpose.
  t.after(async () => { try { db.close(); } catch { /* already closed by the test */ } await rm(dir, { recursive: true, force: true }); });
  return db;
}

const MODULE_SOURCE = readFileSync(new URL('../src/core/qzone-admin-offline.mjs', import.meta.url), 'utf8');
const RECOVERY_BODY = MODULE_SOURCE.slice(MODULE_SOURCE.indexOf('export function restoreOfflineAuditFault'));

// ══════════════════════════════════════════════════════════════════════════════════════════════
// AR-1 正常：结构有效 + 代际匹配 + 审计成功 ⇒ 故障清除；gap 只标记不删除；writeGate 消失
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('AR-1 结构有效且代际匹配 ⇒ 故障清除：gap 全部写入 resolvedBy 后仍在数组里，writeGate 消失', async (t) => {
  const db = await fixture(t, baseState());
  assert.deepEqual(checkWriteGate(db.read()), { allowed: false, reason: 'write-gate-fault' },
    '前提：初始状态必须被 write gate 拒绝，否则「恢复」没有可观察的对象');
  const before = db.read();
  const auditBefore = before.audit.length;

  const out = admin.restoreOfflineAuditFault(db, { expectedGeneration: GEN }, actor());
  assert.equal(out.ok, true, '结构有效 + 代际匹配 + 审计成功必须恢复成功');
  assert.equal(out.generation, GEN);
  assert.equal(out.resolvedGapCount, 1);
  assert.equal(out.auditId, 'restore-audit-fault-1');

  const state = db.read();
  // ★ 故障标记消失
  assert.equal(Object.hasOwn(state, 'writeGate'), false,
    'writeGate 必须消失：不消失则 gate 继续拒绝，恢复等于没做');
  assert.deepEqual(checkWriteGate(state), { allowed: true },
    '恢复后必须被同一套 gate 判为可写（shift 的是 gate 自己的判据，不是测试自己的谓词）');

  // ★ gap 只标记不删除（G-4）
  assert.equal(state.auditGaps.length, 1, 'gap 条目不得被删除 —— 它就是「审计行丢了」的证据');
  assert.deepEqual(state.auditGaps[0].resolvedBy, { generation: GEN, at: NOW, operator: 'ops-1' });
  assert.equal(state.auditGaps[0].key, 'settle-1', 'key 必须原样保留，否则无法追回是哪一次结算');
  assert.equal(state.auditGaps[0].time, T0, 'time 必须原样保留');
  assert.equal(isAuditGap(state.auditGaps[0]), true,
    '标记后的条目仍必须是一个合法 gap（五个字段的形状不变）—— 否则写法把证据改坏了');

  // ★ 管理审计恰好一条，且含代际/操作者/来源/时间/结果（R-1、R-4）
  assert.equal(state.audit.length, auditBefore + 1);
  const row = state.audit.at(-1);
  assert.equal(row.id, 'restore-audit-fault-1');
  const record = row.record;
  assert.equal(record.operator, 'ops-1');
  assert.equal(record.source, 'admin_console');
  assert.equal(record.time, NOW);
  assert.equal(record.target, '123456');
  assert.equal(record.result, 'success');
  const content = JSON.parse(record.content);
  assert.equal(content.intent, 'restore_audit_fault', '审计行必须能把自己与「解除平台暂停」区分开');
  assert.equal(content.generation, GEN, 'R-1：审计里必须保留故障代际');
  assert.equal(content.openGapCount, 1, 'R-1：必须记录此前打开着几个缺口');
  assert.deepEqual(content.gapReasons, { 'audit-state-invalid': 1 }, '「此前暂停原因摘要」：缺口原因');
  assert.equal(content.writeGate.fault, 'audit-unavailable',
    '被清除的 writeGate 值必须留在审计里 —— 否则清除动作本身不可复核');
  assert.equal(content.pauseScope, 'both', '「此前暂停原因摘要」：平台暂停范围');
  assert.deepEqual(content.pauseCauses, { access: 'unknown', write: 'unknown' },
    '「此前暂停原因摘要」：两层暂停原因（此处无 pauseCycles，如实记为 unknown，不猜）');
  assert.equal(content.result, 'success');
});

test('AR-1b 恢复结果跨重开持久：writeGate 消失、resolvedBy 留在磁盘上', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-audit-restore-'));
  const file = join(dir, 'state.db');
  let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(file, baseState());
  admin.restoreOfflineAuditFault(db, { expectedGeneration: GEN }, actor());
  db.close();
  db = openOfflineStore(file, {});
  const reopened = db.read();
  assert.equal(Object.hasOwn(reopened, 'writeGate'), false, '重开后 writeGate 仍不得回来');
  assert.deepEqual(reopened.auditGaps[0].resolvedBy, { generation: GEN, at: NOW, operator: 'ops-1' });
  assert.deepEqual(checkWriteGate(reopened), { allowed: true });
  assert.equal(reopened.audit.length, 1);
});

test('AR-1c 遗留四字段缺口（没有 resolvedBy 字段）按「打开」处理，恢复后补成五字段且仍合法', async (t) => {
  // G-4 的向后兼容口径：`resolvedBy` 缺失与 `null` 同义（gate 就是按这个读的）。若这里判成「已解决」，
  // 恢复就会信任一个从未存在过的字段。
  const db = await fixture(t, baseState({
    auditGaps: [{ key: 'settle-legacy', reason: 'audit-write-failed', generation: GEN, time: T0 }],
  }));
  const out = admin.restoreOfflineAuditFault(db, { expectedGeneration: GEN }, actor());
  assert.equal(out.ok, true, '遗留缺口必须能被本次恢复清掉，否则老库永远解锁不了');
  assert.equal(out.resolvedGapCount, 1);
  const entry = db.read().auditGaps[0];
  assert.deepEqual(entry, {
    key: 'settle-legacy', reason: 'audit-write-failed', generation: GEN, time: T0,
    resolvedBy: { generation: GEN, at: NOW, operator: 'ops-1' },
  }, '只能补 resolvedBy，其余四个字段逐字不动');
  assert.equal(isAuditGap(entry), true);
  assert.deepEqual(checkWriteGate(db.read()), { allowed: true });
});

test('AR-1d 重复恢复不得「再成功一次」：第二次以 no-open-gap 拒绝并留 denied 痕迹', async (t) => {
  const db = await fixture(t, baseState());
  admin.restoreOfflineAuditFault(db, { expectedGeneration: GEN }, actor());
  const again = admin.restoreOfflineAuditFault(db, { expectedGeneration: GEN },
    actor({ auditId: 'restore-audit-fault-2' }));
  assert.equal(again.ok, false, '没有打开缺口时不得再报一次成功（否则一次恢复会被记成两次）');
  assert.equal(again.reason, 'no-open-gap');
  assert.equal(again.resolvedGapCount, 0);
  const state = db.read();
  assert.equal(state.audit.length, 2);
  assert.equal(state.audit[1].record.result, 'denied');
  assert.deepEqual(state.auditGaps[0].resolvedBy, { generation: GEN, at: NOW, operator: 'ops-1' },
    '第二次拒绝不得改写第一次写下的标记');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// AR-2 结构无效 ⇒ 拒绝，故障保持，零部分修复
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('AR-2 audit / auditGaps 结构损坏 ⇒ 拒绝且故障保持，不做任何猜测式修复', async (t) => {
  const cases = [
    ['audit 不是数组', 'invalid-structure', { audit: null }],
    ['audit 行缺 record', 'invalid-structure', { audit: [{ id: 'broken-row' }] }],
    ['audit 行 id 非法', 'invalid-structure', { audit: [{ id: 'bad id!', record: {} }] }],
    ['audit 行 id 重复', 'invalid-structure', { audit: [{ id: 'dup', record: {} }, { id: 'dup', record: {} }] }],
    ['auditGaps 不是数组', 'invalid-structure', { auditGaps: { 0: gap() } }],
    ['gap 条目带未知字段（会被静默丢弃）', 'invalid-structure', { auditGaps: [{ ...gap(), extra: 'x' }] }],
    ['gap 条目 reason 非法', 'invalid-structure', { auditGaps: [{ key: 'k1', reason: 'whatever', generation: GEN, time: T0, resolvedBy: null }] }],
    ['writeGate 是不可读的标量', 'invalid-structure', { writeGate: 'audit-unavailable' }],
    ['writeGate 的 fault 名字未知', 'unknown-fault', { writeGate: { fault: 'something-else', since: T0 } }],
  ];
  for (const [name, expected, over] of cases) {
    const db = await fixture(t, baseState(over));
    const before = db.read();
    const out = admin.restoreOfflineAuditFault(db, { expectedGeneration: GEN }, actor());
    assert.equal(out.ok, false, `${name}: 结构无效必须拒绝`);
    assert.equal(out.reason, expected, `${name}: 拒绝原因必须是结构问题（不认识的东西不猜、不修）`);
    assert.equal(out.trail, 'not-recorded',
      `${name}: ①失败时审计汇本身不可读，留痕只能靠返回值（与业务性拒绝的区分点）`);
    assert.deepEqual(db.read(), before,
      `${name}: 故障必须保持 —— 一个字节都不许被「顺手修好」，也不许留下半条审计`);
    assert.deepEqual(checkWriteGate(db.read()).allowed, false, `${name}: gate 必须仍然拒绝`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// AR-3 代际不符 ⇒ 拒绝，故障保持，并留痕（R-4 业务性拒绝 vs 审计写失败）
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('AR-3 代际不符 ⇒ 拒绝且故障保持，但必须留一条 denied 审计让操作员知道为什么没恢复', async (t) => {
  const db = await fixture(t, baseState());
  const out = admin.restoreOfflineAuditFault(db, { expectedGeneration: OTHER_GEN }, actor());
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'generation-mismatch');
  assert.deepEqual(out.observedGenerations, [GEN], '必须回报现网真实代际，否则操作员无从比对');
  assert.equal(out.resolvedGapCount, 0);
  assert.equal(out.trail, 'recorded', '业务性拒绝必须留痕（R-4），与 ①失败时无法留痕区分');

  const state = db.read();
  assert.deepEqual(state.writeGate, GATE, '故障必须保持：writeGate 原样');
  assert.equal(state.auditGaps[0].resolvedBy, null, '故障必须保持：gap 未被标记');
  assert.equal(state.audit.length, 1, '代际不符只允许留下「拒绝」这一条，不得留下恢复记录');
  assert.equal(state.audit[0].record.result, 'denied');
  const content = JSON.parse(state.audit[0].record.content);
  assert.equal(content.denial, 'generation-mismatch');
  assert.equal(content.expectedGeneration, OTHER_GEN);
  assert.deepEqual(content.observedGenerations, [GEN]);
  assert.equal(content.openGapCount, 1, '拒绝时也必须写清「当时打开着几个缺口」');
  assert.equal(content.result, 'denied');
});

test('AR-3b 有故障标记但没有任何打开缺口 ⇒ 拒绝（不猜代际）', async (t) => {
  const db = await fixture(t, baseState({ auditGaps: [] }));
  const out = admin.restoreOfflineAuditFault(db, { expectedGeneration: GEN }, actor());
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-open-gap',
    '没有打开缺口就没有可核对的持久代际 —— 此时清 writeGate 等于凭空信任一个猜出来的代际');
  assert.deepEqual(db.read().writeGate, GATE, '故障必须保持');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// AR-4 多代际并存 ⇒ 拒绝（不猜是哪一次故障）
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('AR-4 两个不同 generation 并存 ⇒ 拒绝，绝不「取最新/取第一条」', async (t) => {
  const db = await fixture(t, baseState({
    auditGaps: [gap(), gap({ key: 'settle-2', generation: OTHER_GEN, time: T0 + 1 })],
  }));
  // 用其中任一真实代际都必须被拒：没有哪一个能被证明是「操作员看过的那一组」。
  for (const [index, expected] of [GEN, OTHER_GEN].entries()) {
    const out = admin.restoreOfflineAuditFault(db, { expectedGeneration: expected },
      actor({ auditId: `restore-multi-${index}` }));
    assert.equal(out.ok, false, `期望代际 ${expected} 也不得放行：多代际并存必须人工分别确认`);
    assert.equal(out.reason, 'multiple-generations');
    assert.deepEqual(out.observedGenerations, [GEN, OTHER_GEN].sort(), '必须把全部代际按序回报');
  }
  const state = db.read();
  assert.deepEqual(state.writeGate, GATE);
  assert.deepEqual(state.auditGaps.map((entry) => entry.resolvedBy), [null, null],
    '两个缺口都必须保持打开 —— 只清其中一个就是替另一次故障做决定');
  assert.equal(state.audit.length, 2, '两次拒绝留两条 denied 记录');
  assert.deepEqual(new Set(state.audit.map((entry) => entry.record.result)), new Set(['denied']));
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// AR-5 审计写入失败 ⇒ 整笔回滚，故障保持，gap 未被标记（不得先清后记）
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('AR-5a 审计写冲突（同 id 不同内容）⇒ 抛错、整笔回滚、gap 未被标记', async (t) => {
  const db = await fixture(t, baseState({
    audit: [{
      id: 'restore-audit-fault-1',
      record: {
        time: T0, source: 'admin_script', action: 'restore', target: '999999',
        postId: null, commentId: null, content: '{"selection":"access"}', redacted: false,
        result: 'success', reason: '', quota: null, operator: 'ops-2', pauseScope: 'none',
      },
    }],
  }));
  const before = db.read();
  assert.throws(() => admin.restoreOfflineAuditFault(db, { expectedGeneration: GEN }, actor()),
    /conflicting audit id/, '审计写入必须真失败（由 appendOfflineAudit 抛出，不是 mock）');
  assert.deepEqual(db.read(), before,
    '审计写失败 ⇒ 整笔回滚：writeGate、gap、audit 三者都必须和调用前一模一样');
  assert.equal(db.read().auditGaps[0].resolvedBy, null, '关键断言：gap 不得先被标记后回滚，更不得留在已标记状态');
});

test('AR-5b 审计 id 已存在且内容相同（appended:false）⇒ 同样抛错回滚，不得声称恢复成功', async (t) => {
  // 用一次真实成功恢复，取得本实现自己写出的那条 record（字段顺序由 formatAuditRecord 决定），
  // 再把它原样放进另一个同构 store —— 于是本次 append 必然走 `appended:false` 分支。
  const scratch = await fixture(t, baseState());
  admin.restoreOfflineAuditFault(scratch, { expectedGeneration: GEN }, actor());
  const seeded = scratch.read().audit[0];
  scratch.close();

  const db = await fixture(t, baseState({ audit: [seeded] }));
  const before = db.read();
  assert.throws(() => admin.restoreOfflineAuditFault(db, { expectedGeneration: GEN }, actor()),
    /duplicate audit id/, 'appended:false 必须被当作失败处理，而不是当作「已经记过了」');
  assert.deepEqual(db.read(), before,
    '没有新审计行 ⇒ 不得清故障：这就是「不得先清后记」的方向性证据');
  assert.deepEqual(db.read().writeGate, GATE);
  assert.equal(db.read().auditGaps[0].resolvedBy, null);
});

test('AR-5c 存储提交失败（update 抛错）⇒ 故障保持且不上报成功', async (t) => {
  const real = await fixture(t, baseState());
  // 提交阶段失败：回调跑完后、落盘前抛错。真实 SQLite 的 ROLLBACK 由 AR-5a/5b 覆盖；这里证明的是
  // 「提交失败 ⇒ 函数不吞错、不返回 ok」。
  // SPREAD wrapper：携带真实 store 的权威，所以它能通过构造期校验（R6 只拒无法命名数据库的句柄）。
  const failing = {
    ...real,
    read: () => real.read(),
    update(fn) { fn(real.read()); throw new Error('commit failed'); },
  };
  const before = real.read();
  assert.throws(() => admin.restoreOfflineAuditFault(failing, { expectedGeneration: GEN }, actor()),
    /commit failed/);
  assert.deepEqual(real.read(), before, '提交失败不得留下任何部分写入');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// AR-6 R-2 边界：恢复审计故障 ≠ 清配额 ≠ 清冷却 ≠ 解平台暂停
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('AR-6 恢复后：ledger/commentTargets/likes/reservations 逐字段不变，accessPaused/writePaused 不被顺带解除', async (t) => {
  const db = await fixture(t, baseState());
  const before = db.read();
  admin.restoreOfflineAuditFault(db, { expectedGeneration: GEN }, actor());
  const after = db.read();

  assert.deepEqual(after.ledger.used, before.ledger.used, 'R-2：配额用量不得被这次恢复清零');
  assert.deepEqual(after.ledger.reservations, before.ledger.reservations, 'R-2：预留不得被顺手清掉');
  assert.equal(after.ledger.day, before.ledger.day);
  assert.deepEqual(after.commentTargets, before.commentTargets,
    'R-2：comment 冷却（commentTargets）逐字段不变');
  assert.deepEqual(after.likes, before.likes, 'R-2：like 去重证据不变');
  assert.equal(after.accessPaused, true, 'R-2：平台暂停不得被顺带解除（access）');
  assert.equal(after.writePaused, true, 'R-2：平台暂停不得被顺带解除（write）');
  assert.equal(after.reads, before.reads, 'reads 计数不动');
  assert.equal(after.writes, before.writes, 'writes 计数不动');
  assert.equal(after.probe, before.probe, '健康探测状态不动');
  assert.equal(after.enabled, true, '配置不动');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// AR-7 三步顺序不可交换
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('AR-7 顺序：代际核对已发生但无恢复记录；成功记录必须描述「恢复前」的故障', async (t) => {
  const db = await fixture(t, baseState());
  // ② 先发生：代际不符被核出来 —— 留下 denied，但一条 resolvedBy 都不许写。
  const denied = admin.restoreOfflineAuditFault(db, { expectedGeneration: OTHER_GEN }, actor());
  assert.equal(denied.reason, 'generation-mismatch');
  assert.equal(db.read().audit.length, 1, '②发生过 ⇒ 有一条拒绝留痕');
  assert.equal(db.read().audit[0].record.result, 'denied');
  assert.equal(db.read().auditGaps[0].resolvedBy, null, '②发生但③未发生 ⇒ 不允许出现恢复结果');

  // ③ 在 ④ 之前：成功那行的内容必须是「清除之前」的快照。若实现先清后记，这两个字段会变成
  // null / 0 —— 因为记账时故障已经不在了。
  const ok = admin.restoreOfflineAuditFault(db, { expectedGeneration: GEN }, actor({ auditId: 'restore-audit-fault-2' }));
  assert.equal(ok.ok, true);
  const state = db.read();
  const success = state.audit.at(-1).record;
  assert.equal(success.result, 'success');
  const content = JSON.parse(success.content);
  assert.equal(content.writeGate.fault, 'audit-unavailable',
    '③在④之前：审计行必须记下被清除的故障标记本体，而不是记 null');
  assert.equal(content.openGapCount, 1, '③在④之前：审计行必须记下恢复前打开着的缺口数，而不是 0');
  assert.equal(content.generation, GEN);
  assert.equal(state.auditGaps[0].resolvedBy.at, NOW, '④写下的标记时间必须就是③那行审计的时间');
});

test('AR-7s 源码形状：审计追加必须早于 resolvedBy 标记与 writeGate 清除（直接钉住代码次序）', () => {
  // Why this exists ON TOP of AR-7: AR-7 catches a swap only because this implementation derives the
  // cleared state from the post-append `next` (measured: a pure move of the append below the clear
  // loses the audit row, so AR-1/AR-7 go red). If a future revision rewrote that data flow so the
  // two orders produced identical state, the behavioural tests would go quiet — a same-transaction
  // throw rolls both halves back, so "which came first" would stop being observable. This assertion
  // is the one that keeps pinning the intended sequence directly.
  // The SUCCESS-path append is the one that must precede the clear. It is located by its full text
  // (the DENIED path appends `safeRecord(record)`), so a mutation that moves only the success append
  // cannot hide behind the other call site.
  const successAppend = "    if (!appendOfflineAudit(txn, auditId, record).appended) throw new Error('duplicate audit id');";
  const appendAt = RECOVERY_BODY.indexOf(successAppend);
  const markerAt = RECOVERY_BODY.indexOf('const marker = { generation, at: time, operator }');
  const clearAt = RECOVERY_BODY.indexOf("withoutKey(cleared, 'writeGate')");
  const guardAt = RECOVERY_BODY.indexOf('checkWriteGate(cleared).allowed');
  assert.ok(appendAt > 0, '必须能在源码里定位成功路径的审计追加（改名/挪走本断言应随之更新）');
  assert.ok(markerAt > 0, '必须能定位 resolvedBy 标记构造');
  assert.ok(clearAt > 0, '必须能定位 writeGate 清除');
  assert.ok(appendAt < markerAt,
    '③记审计必须在 ④清故障之前：这条红了说明顺序被调换（先清后记），单事务回滚会掩盖它');
  assert.ok(appendAt < clearAt, '③记审计必须早于 writeGate 清除');
  assert.ok(markerAt < guardAt && clearAt < guardAt,
    '提交前的 gate 自检必须排在清除之后，否则自检的是旧状态，等于没自检');
  // 正控：被清除的故障必须在「记账那一刻」仍读得到（描述恢复前状态），不是 null。`recoveryContent`
  // 定义在恢复函数之前，所以这条对着全文件查，而不是只查函数体。
  assert.ok(MODULE_SOURCE.includes('writeGate: view.gate,'),
    '审计内容必须读「恢复前」的 writeGate（view.gate），而不是清除后的 undefined');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// AR-8 既有三条导出语义一个字不改（本文件自建断言，不改 test-qzone-admin-offline.mjs）
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('AR-8a manualRestore 的 access / write / both 语义逐条不变', async (t) => {
  const cases = [
    { layer: 'access', expect: { accessPaused: false, writePaused: true, reads: 0, writes: 3, probe: 'done' } },
    { layer: 'write', expect: { accessPaused: true, writePaused: false, reads: 2, writes: 0, probe: 'manual_only' } },
    { layer: 'both', expect: { accessPaused: false, writePaused: false, reads: 0, writes: 0, probe: 'done' } },
  ];
  for (const { layer, expect } of cases) {
    const db = await fixture(t, baseState({
      pauseCycles: {
        access: { id: '01234567-89ab-4cde-8123-0123456789ab', operationId: 'read-1', cause: 'captcha' },
        write: { id: '11234567-89ab-4cde-8123-0123456789ab', operationId: 'write-1', cause: 'network_unavailable' },
      },
    }));
    admin.restoreOfflinePause(db, layer, {
      operator: '123', source: 'admin_script', target: '123', time: NOW, auditId: `restore-${layer}`,
    });
    const state = db.read();
    for (const [key, value] of Object.entries(expect)) {
      assert.equal(state[key], value, `${layer}: ${key} 语义必须不变（manualRestore 一个字没改）`);
    }
    if (layer === 'access' || layer === 'both') assert.equal(state.pauseCycles.access, null);
    else assert.notEqual(state.pauseCycles.access, null, 'write 恢复不得顺带清 access 的暂停周期');
    if (layer === 'write' || layer === 'both') assert.equal(state.pauseCycles.write, null);
    else assert.notEqual(state.pauseCycles.write, null, 'access 恢复不得顺带清 write 的暂停周期');
    assert.deepEqual(state.commentTargets, [{ target: '10001', time: T0 - 60_000 }],
      '恢复暂停不得清 commentTargets 冷却');
    // 平台暂停恢复了，但审计故障属于另一件事：它必须原样留在那里（§5.1 特别禁止）
    assert.deepEqual(state.writeGate, GATE,
      '§5.1 特别禁止：既有 both/单层恢复不得顺带解除审计故障');
    assert.equal(state.auditGaps[0].resolvedBy, null, '§5.1 特别禁止：暂停恢复不得标记缺口');
    db.close();
  }
});

test('AR-8b resetOfflineQuota 语义不变，且同样不碰审计故障', async (t) => {
  const db = await fixture(t, baseState());
  admin.resetOfflineQuota(db, 'post', {
    operator: '123', source: 'admin_script', target: '123', time: NOW, auditId: 'reset-post',
  });
  const state = db.read();
  assert.deepEqual(state.ledger.used, { post: 0, comment: 8, like: 9 }, '只清指定 kind');
  assert.deepEqual(state.ledger.reservations, { 'res-1': 'post' }, 'reservations 不动');
  assert.equal(state.accessPaused, true, '配额重置不解暂停');
  assert.equal(state.writePaused, true);
  assert.deepEqual(state.writeGate, GATE, '配额重置不碰审计故障');
  assert.equal(state.auditGaps[0].resolvedBy, null);
});

test('AR-8c 导出面：三条既有导出原样保留，新增的只有两个专用恢复函数；都没有接进不鉴权旁路', () => {
  // THE EXPECTED LIST IS EXACT ON PURPOSE, so a function cannot be added to this module without someone
  // consciously updating this line. Its job is not "count the exports" but "no recovery entry point
  // appears that nobody reviewed": the three ORIGINAL exports must survive untouched, and every addition
  // must be a dedicated recovery function rather than a widening of `restoreOfflinePause`.
  assert.deepEqual(Object.keys(admin).sort(),
    [
      'configureOfflineQzone', 'resetOfflineQuota',
      'restoreOfflineAuditFault', 'restoreOfflinePause',
      'restoreOfflineSettledCorruption',
    ],
    '既有三条导出一个不少；新增的只有两个专用恢复函数（审计故障 / settled 损坏）');
  assert.equal(typeof admin.restoreOfflineAuditFault, 'function');
  assert.equal(typeof admin.restoreOfflineSettledCorruption, 'function');

  // The original three keep their exact meaning: a settled repair must NOT be reachable through them.
  // This is the R-2 boundary in code — clearing an idempotency record is not clearing a pause.
  assert.equal(admin.restoreOfflinePause.length, 3, 'restoreOfflinePause 签名未变');

  // Recovery functions are LIBRARY functions called by the existing authenticated entry point; they
  // must not appear on an unauthenticated path. The router
  // (`qzone-admin-router-offline.mjs` → `handleOfflineAdminRequest`) authenticates FIRST, so it is
  // deliberately not asserted here: wiring recovery onto that route is the designed future.
  for (const file of ['../scripts/qzone-admin-cli.mjs', '../src/bridge.js']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const fn of ['restoreOfflineAuditFault', 'restoreOfflineSettledCorruption']) {
      assert.equal(text.includes(fn), false,
        `${file} 不得引用 ${fn}：那会绕过 console/脚本那条既有鉴权路径`);
    }
  }
});

test('AR-8d 入参是编程错误而非业务拒绝：坏 store / 坏 request / 坏 actor 一律 TypeError 且不动状态', async (t) => {
  const db = await fixture(t, baseState());
  const before = db.read();
  assert.throws(() => admin.restoreOfflineAuditFault(null, { expectedGeneration: GEN }, actor()), TypeError);
  assert.throws(() => admin.restoreOfflineAuditFault(db, { expectedGeneration: GEN, extra: true }, actor()), TypeError);
  assert.throws(() => admin.restoreOfflineAuditFault(db, { expectedGeneration: 'bad id!' }, actor()), TypeError);
  assert.throws(() => admin.restoreOfflineAuditFault(db, { expectedGeneration: GEN }, actor({ operator: '' })), TypeError);
  assert.throws(() => admin.restoreOfflineAuditFault(db, { expectedGeneration: GEN }, actor({ source: 'qq' })), TypeError);
  assert.throws(() => admin.restoreOfflineAuditFault(db, { expectedGeneration: GEN }, actor({ target: 'abc' })), TypeError);
  assert.throws(() => admin.restoreOfflineAuditFault(db, { expectedGeneration: GEN }, actor({ time: -1 })), TypeError);
  assert.throws(() => admin.restoreOfflineAuditFault(db, { expectedGeneration: GEN }, actor({ auditId: '__proto__' })), TypeError);
  assert.deepEqual(db.read(), before, '入参校验必须在事务之前，且不得留下任何状态变化');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// AR-9 · M9 × M4 COMBINED BEHAVIOUR (Codex R6-2026-11-14, item 4)
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// The question this section answers: M9 could already clear a PERSISTED fault, but a real component
// failure leaves a PROCESS LATCH with NO GAP AT ALL (the settlement transaction rolled back before it
// could record one — OGA-11/OGA-13). Without an operator path for that, the only way out was the test
// escape hatch `clearFaultLatch`, which is not recovery.
//
// Every case below uses the REAL latch (`latchFault`/`readFaultLatch`), not a stub, because the whole
// point is that the two layers talk about the same send authority.

test('AR-9a 只有内存锁存、没有 open gap ⇒ 受控恢复能解除它（不是只能靠 clearFaultLatch）', async (t) => {
  const db = await fixture(t, healthyState());   // no gate, no gap: a real latch-only fault
  latchFault(db, 'settle-breaker-failed');
  const live = readFaultLatch(db);
  assert.equal(live.reason, 'settle-breaker-failed', '前提：锁存已在');
  assert.equal(db.read().writeGate, null, '前提：没有持久故障');
  assert.deepEqual(db.read().auditGaps, [], '前提：没有 gap —— 这正是真实故障的样子');

  const out = admin.restoreOfflineAuditFault(
    db, { expectedGeneration: GEN, expectedLatchRevision: live.revision }, actor(),
  );
  assert.equal(out.ok, true, '只有锁存时也必须能受控恢复: ' + JSON.stringify(out));
  assert.equal(out.generation, null, '没有 gap ⇒ 没有代际，如实报 null 而不是编一个');
  assert.deepEqual(out.releasedLatch, { reason: 'settle-breaker-failed', revision: live.revision },
    '解除的必须是那次核对过的修订');
  assert.equal(readFaultLatch(db), null, '★ 提交成功后同一权威的锁存必须真的解除');
  assert.equal(db.read().writeGate, null, '不得因此造出一个持久故障');

  // 审计里必须留下这次解除的证据，且带 discriminator（与平台暂停 restore 不混淆）。
  const row = db.read().audit.at(-1);
  assert.equal(row.record.action, 'restore');
  const content = JSON.parse(row.record.content);
  assert.equal(content.intent, 'restore_audit_fault');
  assert.deepEqual(content.releasedLatch, { reason: 'settle-breaker-failed', revision: live.revision });
});

test('AR-9b 解除后写路径真的能再发（解除不是"改了个字段"）', async (t) => {
  const db = await fixture(t, healthyState());
  let sent = 0;
  const path = createOfflineWritePath({
    store: db, clock: () => NOW,
    transport: async () => { sent += 1; return { ok: true }; },
  });
  latchFault(db, 'settle-breaker-failed');
  const refused = await path.write(likeReq());
  assert.equal(refused.ok, false, '前提：锁存后写路径拒绝');
  assert.equal(refused.reason, 'process-fault-latched');
  assert.equal(sent, 0, '前提：零发送');

  admin.restoreOfflineAuditFault(
    db, { expectedGeneration: GEN, expectedLatchRevision: readFaultLatch(db).revision }, actor(),
  );
  const allowed = await path.write(likeReq({ id: 'after-recovery' }));
  assert.equal(allowed.ok, true, '★ 解除后必须能真正发出: ' + JSON.stringify(allowed));
  assert.equal(sent, 1, '★ transport 真的被调用了一次');
});

test('AR-9c 提交失败 ⇒ 锁存必须仍在（失败的恢复不得解锁发送）', async (t) => {
  const db = await fixture(t, healthyState());
  latchFault(db, 'settle-breaker-failed');
  const revision = readFaultLatch(db).revision;
  // IMPORTANT: this double RUNS the callback and THEN throws. A double that throws without running
  // the callback cannot distinguish "release the latch outside the transaction" from "release it
  // inside the callback" — measured: with the release moved INSIDE the callback, a non-running double
  // still left the latch intact and this case stayed green. Running the callback first is what makes
  // the assertion about the commit outcome rather than about the double.
  let callbackRan = false;
  const failing = {
    ...db,
    update(fn) {
      callbackRan = true;
      db.update(fn);                       // the callback's state work is applied…
      throw new Error('commit failed');    // …then the commit is reported as failed.
    },
  };
  assert.throws(() => admin.restoreOfflineAuditFault(
    failing, { expectedGeneration: GEN, expectedLatchRevision: revision }, actor(),
  ), /commit failed/);
  assert.equal(callbackRan, true, '前提：回调确实跑过（否则这条测不到「提交前解锁」）');
  assert.equal(readFaultLatch(db).reason, 'settle-breaker-failed',
    '★ 提交没成功 ⇒ 锁存必须保持，否则恢复失败会变成一次静默解锁');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// AR-9d..9e — NARROWED after Codex R7 counterexample 3
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// The OLD AR-9d claimed "a stale recovery cannot clear a newer fault" but only passed a DIFFERENT
// REASON — that is not evidence of a new fault occurring, it is evidence of a typo. The real case is
// AR-9g below (a genuinely NEW latch event). What remains here is the narrower, still-true statement.

test('AR-9d 修订号不符 ⇒ 拒绝（不写审计行、不清锁存）', async (t) => {
  const db = await fixture(t, healthyState());
  latchFault(db, 'settle-breaker-failed');           // revision 1
  const stale = admin.restoreOfflineAuditFault(
    db, { expectedGeneration: GEN, expectedLatchRevision: 99 }, actor(),
  );
  assert.equal(stale.ok, false, '★ 修订号不符必须拒绝');
  assert.equal(stale.reason, 'latch-revision-mismatch');
  assert.equal(stale.observedLatchRevision, 1, '如实报出盘上真实修订号');
  assert.equal(db.read().audit.length, 0, '前置拒绝 ⇒ 不写审计行');
  assert.equal(stale.trail, 'not-recorded');
  assert.equal(readFaultLatch(db).reason, 'settle-breaker-failed', '★ 锁存没被清');
});

test('AR-9e 没有锁存却要求解锁存 ⇒ 明确拒绝 no-latch，不得假装成功', async (t) => {
  const db = await fixture(t, healthyState());
  const out = admin.restoreOfflineAuditFault(
    db, { expectedGeneration: GEN, expectedLatchRevision: 1 }, actor(),
  );
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-latch');
  assert.equal(db.read().audit.length, 0, '业务拒绝但前置不可读 ⇒ 不写审计行，且如实说 trail:not-recorded');
  assert.equal(out.trail, 'not-recorded');
});

test('AR-9f 未绑定权威的句柄必须在构造期被拒（不能半恢复）', async (t) => {
  const db = await fixture(t, healthyState());
  latchFault(db, 'settle-breaker-failed');
  const revision = readFaultLatch(db).revision;
  const closure = { read: () => db.read(), update: (fn) => db.update(fn) };
  assert.throws(() => admin.restoreOfflineAuditFault(
    closure, { expectedGeneration: GEN, expectedLatchRevision: revision }, actor(),
  ), /send authority/, '★ 无法命名数据库的句柄无法解除它的锁存，必须在构造期拒绝');
  assert.equal(readFaultLatch(db).reason, 'settle-breaker-failed', '前提：锁存未被误清');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// AR-9g — Codex R7 counterexample 3: a recovery must not erase a fault that arrived DURING it
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// MEASURED BEFORE THE FIX: latch 'old-fault'; the recovery's own commit then latched 'new-fault' on
// the same authority; the recovery finished with ok:true and latch:null — the NEW fault was gone.
// Comparing REASONS could never catch this: latchFault keeps the first reason, so even a different
// new fault left the string unchanged, and a repeat of the same reason changed nothing at all.
//
// revision is monotonic per authority, so a compare-and-clear of the INSPECTED revision cannot remove
// anything that arrived later.
test('AR-9g 恢复提交期间到达的新故障必须保留（单比 reason 抓不到，必须比修订号）', async (t) => {
  const db = await fixture(t, healthyState());
  latchFault(db, 'old-fault');                       // revision 1
  const inspected = readFaultLatch(db);
  assert.equal(inspected.revision, 1, '前提：操作者看到的修订号是 1');

  // A wrapper on the SAME authority whose commit lands a NEW fault. This is the "committed, but
  // before the recovery clears the latch" observation point — not a callback holding the lock.
  const racing = {
    ...db,
    update(fn) {
      const out = db.update(fn);                     // the recovery's transaction really commits
      latchFault(db, 'new-fault');                   // …and a NEW fault lands right after it
      return out;
    },
  };
  const out = admin.restoreOfflineAuditFault(
    racing, { expectedGeneration: GEN, expectedLatchRevision: inspected.revision }, actor(),
  );

  assert.equal(out.ok, true, '恢复本身确实提交成功');
  assert.equal(out.releasedLatch, null, '★ 不得声称解除了锁存');
  assert.ok(out.latchRetained, '★ 必须如实报告锁存被保留');
  assert.equal(out.latchRetained.requestedRevision, 1);
  assert.ok(out.latchRetained.current.revision > 1, '盘上的修订号已经前进');

  const after = readFaultLatch(db);
  assert.ok(after, '★★ 新故障必须仍然在 —— 这才是「旧恢复不能清新故障」的实证');
  assert.equal(after.revision, 2, '修订号 2 = 那次新故障');
  assert.equal(after.reason, 'old-fault', '首个 reason 仍作诊断保留（R7 允许）');

  // And the property that matters: the write path still refuses.
  let sent = 0;
  const path = createOfflineWritePath({ store: db, clock: () => NOW, transport: async () => { sent += 1; return { ok: true }; } });
  const refused = await path.write(likeReq({ id: 'after-g' }));
  assert.equal(refused.ok, false, '★★ 新故障必须继续阻写');
  assert.equal(refused.reason, 'process-fault-latched');
  assert.equal(sent, 0, 'transport 零调用');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// AR-9h — Codex R7 counterexample 2: recovery must NOT launder an unrepaired storage fault
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// MEASURED BEFORE THE FIX: start from settled='CORRUPT-SETTLED'; a real record fails and latches;
// restoreOfflineAuditFault then returned ok:true with latch:null, the corrupt value still in place —
// and path.write(like) returned ok:true with the transport called once. Clearing the latch while the
// store still cannot settle is laundering, not recovery.
//
// Now ① STRUCTURE refuses a corrupt settled: nothing is cleared, no success row is written, the
// corrupt value stays verbatim, and the latch stays.
test('AR-9h settled 仍损坏时恢复必须拒绝（不得清锁存后放行发送）', async (t) => {
  const db = await fixture(t, healthyState({ settled: 'CORRUPT-SETTLED' }));
  latchFault(db, 'settle-breaker-failed');
  const revision = readFaultLatch(db).revision;

  const out = admin.restoreOfflineAuditFault(
    db, { expectedGeneration: GEN, expectedLatchRevision: revision }, actor(),
  );
  assert.equal(out.ok, false, '★ 存储结构未修复 ⇒ 恢复必须拒绝');
  assert.equal(out.reason, 'settled-corrupt');
  // UPDATED after verifier t17: `settled-corrupt` means the AUDIT SINK IS FINE and something else is
  // broken, so the refusal can and must leave a `denied` row (R-4). Reporting `not-recorded` made the
  // two very different refusals ("nowhere to write" vs "wrote a refusal") indistinguishable.
  assert.equal(out.trail, 'recorded', '★ 审计可写 ⇒ 拒绝必须留下 denied 行，不能静默');
  const refusalRow = db.read().audit.at(-1);
  assert.equal(refusalRow.id, 'restore-audit-fault-1');
  assert.equal(refusalRow.record.result, 'denied');
  assert.equal(JSON.parse(refusalRow.record.content).structuralRefusal, 'settled-corrupt',
    '★ 拒绝原因必须落盘 —— 否则运维只看到"它不帮我"却不知道为什么');
  assert.equal(db.read().settled, 'CORRUPT-SETTLED', '★ 损坏原值逐字保留');
  assert.equal(readFaultLatch(db).revision, revision, '★ 锁存必须保持');

  // The property that matters: sending is still blocked.
  let sent = 0;
  const path = createOfflineWritePath({ store: db, clock: () => NOW, transport: async () => { sent += 1; return { ok: true }; } });
  const refused = await path.write(likeReq({ id: 'after-h' }));
  assert.equal(refused.ok, false, '★★ 未修复时不得放行发送');
  assert.equal(refused.reason, 'process-fault-latched');
  assert.equal(sent, 0, 'transport 零调用');
});

test('AR-9h2 正控：把 settled 修好后，同样的恢复能成功并真正重开', async (t) => {  const db = await fixture(t, healthyState({ settled: 'CORRUPT-SETTLED' }));
  latchFault(db, 'settle-breaker-failed');
  const revision = readFaultLatch(db).revision;

  // Controlled repair IN THE TEST (this is the "fix the disk" step the module refuses to guess at).
  db.update((s) => ({ ...s, settled: {} }));

  const out = admin.restoreOfflineAuditFault(
    db, { expectedGeneration: GEN, expectedLatchRevision: revision }, actor(),
  );
  assert.equal(out.ok, true, '修好后必须能恢复: ' + JSON.stringify(out));
  assert.equal(readFaultLatch(db), null, '锁存已解除');

  let sent = 0;
  const path = createOfflineWritePath({ store: db, clock: () => NOW, transport: async () => { sent += 1; return { ok: true }; } });
  const allowed = await path.write(likeReq({ id: 'after-h2' }));
  assert.equal(allowed.ok, true, '★ 修好并恢复后必须真的能发出: ' + JSON.stringify(allowed));
  assert.equal(sent, 1, 'transport 真的被调用了一次');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// AR-10 — ABA: revision must survive a successful clear (Codex R8)
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// MEASURED BEFORE THE FIX: the revision counter lived inside the latch entry, and compare-and-clear
// deletes that entry. So the sequence "fault A (rev 1) → real recovery of A → fault B" produced REV 1
// AGAIN, and the recovery request that had been written for A could clear B. That is an ABA, and
// "+1 within one latch lifetime" cannot fix it — the counter has to outlive the entry.
//
// This case drives TWO REAL RECOVERIES with different `auditId`s against one real database, so it is an
// end-to-end lifecycle check, not a probe of one primitive.
test('AR-10 ABA：旧修订号被成功清除后不得重用；用旧请求也清不掉新故障', async (t) => {
  const db = await fixture(t, healthyState());

  // ── fault A, recovered for real ──
  latchFault(db, 'fault-A');
  const revA = readFaultLatch(db).revision;
  const restoredA = admin.restoreOfflineAuditFault(
    db, { expectedGeneration: GEN, expectedLatchRevision: revA },
    actor({ auditId: 'audit-A', time: NOW }),
  );
  assert.equal(restoredA.ok, true, '前提：A 的恢复真的成功');
  assert.equal(restoredA.releasedLatch.revision, revA);
  assert.equal(readFaultLatch(db), null, '前提：A 已解除');

  // ── fault B, after A was cleared ──
  latchFault(db, 'fault-B');
  const revB = readFaultLatch(db).revision;
  assert.notEqual(revB, revA,
    '★★ 解锁之后再故障，修订号必须前进（不得回到 revA）—— 这就是 ABA 的入口');
  assert.equal(revB, revA + 1, '同一权威生命周期内单调 +1');

  // ── the stale request: same body that recovered A, different auditId ──
  const stale = admin.restoreOfflineAuditFault(
    db, { expectedGeneration: GEN, expectedLatchRevision: revA },
    actor({ auditId: 'audit-stale-A', time: NOW + 1000 }),
  );
  assert.equal(stale.ok, false, '★★ 用 A 的旧修订号不得清掉 B');
  assert.equal(stale.reason, 'latch-revision-mismatch');
  assert.equal(stale.observedLatchRevision, revB);
  assert.equal(readFaultLatch(db).reason, 'fault-B', '★★ B 必须仍在');

  // ── and the correct request does clear it ──
  const restoredB = admin.restoreOfflineAuditFault(
    db, { expectedGeneration: GEN, expectedLatchRevision: revB },
    actor({ auditId: 'audit-B', time: NOW + 2000 }),
  );
  assert.equal(restoredB.ok, true, '前提：B 的恢复真的成功');
  assert.equal(readFaultLatch(db), null, 'B 已解除');

  // Both successes are on disk under their own ids; the refused one wrote nothing.
  const ids = db.read().audit.map((entry) => entry.id);
  assert.ok(ids.includes('audit-A') && ids.includes('audit-B'), '两次成功恢复各有一行');
  assert.equal(ids.includes('audit-stale-A'), false, '被拒的旧请求不写审计行');
});
// ══════════════════════════════════════════════════════════════════════════════════════════════
// AR-9i — a STRUCTURAL refusal where the audit sink is UNREADABLE must say so honestly
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// The counterpart to AR-9h: `trail: 'recorded'` must mean a row was really written. When the audit
// array ITSELF is broken there is genuinely nowhere to record the refusal, and the return value is the
// only trace — that must stay distinguishable, not be papered over as "recorded".
test('AR-9i 审计本身不可读时，拒绝必须如实报 not-recorded（无处可写）', async (t) => {
  const db = await fixture(t, healthyState({ audit: 'CORRUPT-AUDIT' }));
  latchFault(db, 'settle-breaker-failed');
  const revision = readFaultLatch(db).revision;
  const before = db.read();

  const out = admin.restoreOfflineAuditFault(
    db, { expectedGeneration: GEN, expectedLatchRevision: revision }, actor(),
  );
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'invalid-structure');
  assert.equal(out.trail, 'not-recorded', '★ 审计数组坏了 ⇒ 确实无处可写，如实说');
  assert.equal(db.read().audit, 'CORRUPT-AUDIT', '损坏原值逐字保留');
  assert.deepEqual({ ...db.read(), audit: before.audit }, { ...before }, '状态未变（除审计原值本身）');
  assert.equal(readFaultLatch(db).revision, revision, '★ 锁存必须保持');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// AR-11 — the COMBINED ABA: a recovery must not outlive its own view
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// MEASURED BEFORE THE FIX (Codex CODEX-R14-COMBINED-ABA-20261114, real M9, real temp SQLite):
//
//     {initialRevision:1, initialRecoveryOk:true, sameAuthority:false, newRevision:1,
//      staleRecoveryOk:true, staleReleased:{reason:'new-fault',revision:1},
//      latchAfter:null, writeOk:true, sent:1}          <- the write went out
//
// Every step is legitimate on its own:
//   1) latch('old-fault') -> revision 1; recover with auditId 'recover-A' -> cleared
//   2) close the handle           (the recovered authority is retired, and was UNPINNED on clear)
//   3) open+close 300 other DBs   (the retired token is evicted — nothing pinned it any more)
//   4) reopen the SAME database   (fresh token => the revision counter restarts)
//   5) latch('new-fault') -> revision 1 AGAIN
//   6) replay step 1's SAVED VIEW (expectedLatchRevision: 1) -> it MATCHED the new fault and cleared it
//
// ROOT CAUSE: the pin protected "still faulted" tokens but not "recovered, yet a revision was already
// issued against this identity". No live fault is NOT the same as "no history an old request can still
// name". AR-10 (same token) and LZ-9c (never recovered) were each green while their COMBINATION was not.
//
// FIX: once an authority has issued a revision, its token stays pinned for the life of the process
// (`releasePinIfNoHistory`). Never-faulted authorities remain evictable.
//
// ⚠️ WHAT THIS CASE ACTUALLY MEASURES (verifier t23 correctly pushed back on my first title): with the
// fix in place the token is NOT rotated by the churn — the pin prevents it. So the case proves the
// OBSERVABLE requirement ("an old view cannot clear a new fault after close + churn + reopen") but it
// does not prove "revision survives an actual rotation". Asserting `tokenReused === true` below makes
// that honest: if a future change lets the pin go, this assertion fails FIRST and the title's old
// promise never silently becomes fiction.
test('AR-11 组合 ABA：恢复+关闭+300 库容量压力+重开后，旧视图不得清掉新故障', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-combined-aba-'));
  const dbPath = join(dir, 'target.db');
  const first = openOfflineStore(dbPath, healthyState());
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  // 1) latch old-fault and recover it FOR REAL
  latchFault(first, 'old-fault');
  const initialRevision = readFaultLatch(first).revision;
  assert.equal(initialRevision, 1, '前提：第一次故障是修订 1');
  const restored = admin.restoreOfflineAuditFault(
    first, { expectedGeneration: GEN, expectedLatchRevision: initialRevision },
    actor({ auditId: 'recover-A' }),
  );
  assert.equal(restored.ok, true, '前提：A 的恢复真的成功');

  // Capture the identity BEFORE closing so the reopen can be compared against it honestly.
  const tokenBeforeClose = authorityOf(first);

  // 2) close, 3) churn 300 other databases, 4) reopen — a legitimate handle-rotation storm
  first.close();
  for (let i = 0; i < 300; i += 1) {
    const p = join(dir, `noise-${i}.db`);
    const noise = openOfflineStore(p, healthyState());
    noise.close();
    await rm(p, { force: true });
  }

  const reopened = openOfflineStore(dbPath, healthyState());
  try {
    // ★ THE HONEST PREMISE: with the pin in place the churn does NOT rotate the token. Stating it turns
    // the title into a measurable claim — if the pin is ever weakened this fails first, instead of the
    // case silently passing through a different path than its name promises.
    //
    // ⚠️ LAYERING, STATED SO NOBODY OVER-READS THIS CASE (verifier t24 measured all three variants):
    //   · this assertion and the next one (revision not reused) both derive from the SAME root cause —
    //     `releasePinIfNoHistory`. Break the pin and BOTH go red; the weaker one fires first and aborts
    //     the case, so the BEHAVIOURAL assertions below (old request refused, zero transport) do NOT get
    //     exercised in that variant.
    //   · verifier's variant 2 (weaken the pin AND delete this assertion) still went red, on the revision
    //     assertion — so the case is not single-threaded: it has two independent checks over the same fix.
    //   · LZ-9c does NOT substitute for the behaviour layer here, and it does NOT cover this branch.
    //     Measured twice (verifier t24, then me): under the V-H mutant LZ-9c stays 30/30 GREEN, because its
    //     fault is NEVER CLEARED — `releasePinIfNoHistory` is never called in that case. LZ-9c guards the
    //     OTHER pin branch (a LIVE fault surviving capacity pressure, R7-1, via `pinAuthority`); this case
    //     guards "recovered, but a revision was already issued" (R14).
    //   · BUT THE BEHAVIOURAL LAYER *IS* REACHABLE — corrected after measuring, because I had written the
    //     opposite. If BOTH same-root assertions above are removed and V-H is applied, this case still goes
    //     RED, on `'★★ 旧视图发出的新请求必须被拒'` (measured: V-H + both assertions deleted ⇒ 31/1, failing
    //     at the stale-request refusal; same variant with the pin intact ⇒ 32/0 green). So the behaviour
    //     assertions are not dead code behind the identity ones — they are simply SEQUENCED after them, and
    //     a regression confined to this pin branch does surface as the wrong acceptance of an old view.
    //     Verifier's experiment 2 stopped at the revision assertion only because that one still remained.
    assert.equal(authorityOf(reopened), tokenBeforeClose,
      '★★ 本次修复的直接效果：发出过修订号的权威不会被容量压力淘汰（token 未轮换）');

    // 5) a genuinely NEW fault
    latchFault(reopened, 'new-fault');
    const newRevision = readFaultLatch(reopened).revision;
    assert.notEqual(newRevision, initialRevision,
      '★★ 重开之后修订号也不得重用 —— 否则旧视图能命中新故障（这就是组合 ABA）');

    // 6) replay the SAVED VIEW: same numbers as step 1, brand-new auditId (a fresh admin action, which
    //    is exactly what the revision guard exists to refuse)
    const stale = admin.restoreOfflineAuditFault(
      reopened, { expectedGeneration: GEN, expectedLatchRevision: initialRevision },
      actor({ auditId: 'recover-stale', time: NOW + 2000 }),
    );
    assert.equal(stale.ok, false, '★★ 旧视图发出的新请求必须被拒');
    assert.equal(stale.reason, 'latch-revision-mismatch');
    assert.equal(readFaultLatch(reopened).reason, 'new-fault', '★★ 新故障仍在');

    // 7) the write path agrees: zero transport
    let sent = 0;
    const path = createOfflineWritePath({
      store: reopened, clock: () => NOW,
      transport: async () => { sent += 1; return { ok: true }; },
    });
    const blocked = await path.write(likeReq({ id: 'aba-1' }));
    assert.equal(blocked.ok, false, '★★ 写必须被拒');
    assert.equal(blocked.reason, 'process-fault-latched');
    assert.equal(sent, 0, '★★ transport 零调用');

    // 8) positive control: the request that HOLDS the new view still works
    const fresh = admin.restoreOfflineAuditFault(
      reopened, { expectedGeneration: GEN, expectedLatchRevision: newRevision },
      actor({ auditId: 'recover-fresh', time: NOW + 3000 }),
    );
    assert.equal(fresh.ok, true, '正控：持有新视图的合法恢复必须成功');
    assert.equal(readFaultLatch(reopened), null, '且锁存已解除');
  } finally { try { reopened.close(); } catch { /* already closed */ } }
});


// ══════════════════════════════════════════════════════════════════════════════════════════════
// AR-12 — an OLD gap must not clear a gate that belongs to a NEWER episode
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// MEASURED BEFORE THE FIX (Codex CODEX-R14-COMBINED-ABA, real store, real M9):
//
//     gap G1 still OPEN, gate raised by a LATER G2 episode
//     -> {recoveryOk:true, gateAfter:"allowed", writeGateAfter:null, gapsAfter:1}
//
// The gate marker was ANONYMOUS (no generation), so the generation check only looked at the OPEN GAPS
// and happily "recovered" an episode it had never been asked about. Note the surviving gap G1 is
// untouched — the recovery really was about G1, which is precisely why it must not clear G2.
//
// FIX: the marker now carries the generation of the settlement that raised it, and recovery refuses
// when the persisted marker names a DIFFERENT episode (`gate-generation-mismatch`).
test('AR-12 旧代际的 gap 不得清掉新代际的 gate（gate 现在带 generation）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-gate-gen-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const oldGap = gap({ key: 'old-k', generation: GEN });
  const db = openOfflineStore(join(dir, 'state.db'), healthyState({
    auditGaps: [oldGap],
    writeGate: { ...GATE, generation: OTHER_GEN },
  }));

  try {
    assert.equal(checkWriteGate(db.read()).allowed, false, '前提：gate 正在拒绝');

    const out = admin.restoreOfflineAuditFault(db, { expectedGeneration: GEN }, actor({ auditId: 'xgen-1' }));
    assert.equal(out.ok, false, '★★ 用 G1 的 gap 清 G2 的 gate 必须被拒');
    assert.equal(out.reason, 'gate-generation-mismatch');
    assert.equal(out.trail, 'recorded', '拒绝也要留审计行（R-4）');

    const gateAfter = db.read().writeGate;
    assert.equal(typeof gateAfter, 'object', '★★ gate 必须仍在');
    assert.equal(gateAfter.generation, OTHER_GEN, '且仍归属 G2');
    assert.equal(checkWriteGate(db.read()).allowed, false, '★★ 仍然拒绝写');
    assert.equal((db.read().auditGaps ?? []).length, 1, '旧 gap 原样保留（未被当成已解决）');
  } finally { try { db.close(); } catch { /* already closed */ } }
});

// AR-13 — the gate marker WRITTEN BY THIS MODULE must carry its own episode id, or AR-12 cannot hold.
//
// A test that only checks "a mismatch is refused" would pass even if the writer never recorded a
// generation (the marker would always be unnamed, always fall back to the gap check). This pins the
// write side: after a degraded settlement, the persisted marker names the SAME generation as the gap
// recorded beside it.
test('AR-13 降级结算写下的 gate 必须自带本次故障的代际（与相邻 gap 同源）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-gate-gen-write-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const db = openOfflineStore(join(dir, 'state.db'), healthyState());
  try {
    // Make the audit half unreadable so a gap MUST be recorded (degrade path).
    db.update((s) => ({ ...s, audit: 'CORRUPT-AUDIT' }));
    const obs = createWriteObservability({ store: db, clock: () => NOW });
    const result = { ok: true, stage: 'transport', outcome: 'failed', quotaConsumed: true, transportCalled: true };
    const out = obs.record({ request: likeReq({ id: 'gen-write-1', action: 'publish', content: 'x' }), result });
    assert.equal(out.degraded, true, '前提：走了降级路径');

    const state = db.read();
    const marker = state.writeGate;
    assert.equal(typeof marker, 'object', '★ gate 必须被置位');
    assert.equal(typeof marker.generation, 'string', '★★ 而且必须带 generation —— 否则 AR-12 无从比较');

    const openGaps = (state.auditGaps ?? []).filter((g) => g.resolvedBy === null);
    assert.equal(openGaps.length, 1, '前提下写入了一条 open gap');
    assert.equal(marker.generation, openGaps[0].generation,
      '★★ marker 与相邻 gap 必须同源（同一个 episode），否则两套代际各说各话');
  } finally { try { db.close(); } catch { /* already closed */ } }
});


// ══════════════════════════════════════════════════════════════════════════════════════════════
// AR-14 — a MIXED state must not be laundered through the pure-latch shortcut
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// MEASURED BEFORE THE FIX (Codex CODEX-R19-MIXED-RECOVERY-20261114, real store, real M9):
//
//   state: complete legal base, audit: [], auditGaps: [], writeGate { ... generation: G2 }
//          PLUS a real `latchFault(store, 'old-memory-fault')`
//   call : expectedGeneration G1 (≠ G2) + the CORRECT current expectedLatchRevision
//   out  : {restoreOk:true, gateAfter:null, latchAfter:null, writeOk:true, sent:1}
//
// A memory latch laundered a PERSISTENT gate fault of a different generation, and the fake transport
// was really called once. Root cause: `latchOnly` was computed from the IN-MEMORY latch alone, so
// naming a latch revision short-circuited the persisted-gate generation check.
//
// FIX: the shortcut applies only when the persisted state carries nothing else to recover. With a gate
// or an unresolved gap present, every layer must satisfy its own constraint, and the latch becomes one
// more thing the request covers rather than a way around the others. "Cannot say how it maps" is
// answered by refusing and PRESERVING.
test('AR-14 混合故障(C2 gate + 内存锁存)不得被「纯锁存」短路：G1 请求被拒且两层都保留', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-mixed-recovery-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const db = openOfflineStore(join(dir, 'state.db'), healthyState({
    audit: [], auditGaps: [],
    writeGate: { ...GATE, generation: OTHER_GEN },
  }));

  try {
    // A REAL in-memory fault, and the request holds its CORRECT revision.
    latchFault(db, 'old-memory-fault');
    const revision = readFaultLatch(db).revision;

    const out = admin.restoreOfflineAuditFault(
      db, { expectedGeneration: GEN, expectedLatchRevision: revision },
      actor({ auditId: 'mixed-1' }),
    );

    assert.equal(out.ok, false, '★★ 混合状态不得被纯锁存捷径放行');
    assert.equal(out.reason, 'gate-generation-mismatch', '★ 拒绝原因必须是持久 gate 的代际不符');
    assert.equal(out.trail, 'recorded', '拒绝也留审计行（R-4）');
    // A REFUSAL MUST NOT CLAIM TO HAVE RELEASED ANYTHING (verifier t25 low-3). The latch is intact, so
    // reporting `releasedLatch` here would be the same class of lie this whole round is about: a record
    // saying an effect happened that did not. Pinned so a future edit cannot report it unconditionally.
    assert.equal(out.releasedLatch, undefined, '★★ 被拒时不得声称解除了锁存');

    // ── BOTH layers preserved ──
    const gateAfter = db.read().writeGate;
    assert.equal(typeof gateAfter, 'object', '★★ 持久 gate 必须仍在，不得被内存锁存"顺带"清掉');
    assert.equal(gateAfter.generation, OTHER_GEN, '且仍归属它自己的代际 G2');
    assert.deepEqual(readFaultLatch(db), { reason: 'old-memory-fault', revision },
      '★★ 内存锁存也必须仍在（不是"两边都清"）');

    // ── and the write really does not go out ──
    let sent = 0;
    const path = createOfflineWritePath({
      store: db, clock: () => NOW,
      transport: async () => { sent += 1; return { ok: true }; },
    });
    const blocked = await path.write(likeReq({ id: 'mixed-w' }));
    assert.equal(blocked.ok, false, '★★ 写必须被拒');
    assert.equal(sent, 0, '★★ 真实写零 transport');
  } finally { try { db.close(); } catch { /* already closed */ } }
});

// AR-15 — the shortcut must still WORK when the state really is latch-only.
//
// AR-14's fix is only correct if it does not kill the case the shortcut exists for. Without this,
// "refuse everything that names a latch revision" would also pass AR-14 and would strand every pure
// commit-failure fault with no operator path out (AR-9b covers the send side, this pins the decision).
test('AR-15 正控：确实只有内存锁存时，捷径仍必须生效（否则纯锁存故障永久卡死）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-pure-latch-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const db = openOfflineStore(join(dir, 'state.db'), healthyState());

  try {
    assert.equal(db.read().writeGate ?? null, null, '前提：没有持久 gate');
    assert.deepEqual(db.read().auditGaps ?? [], [], '前提：没有 gap');
    latchFault(db, 'settle-breaker-failed');
    const revision = readFaultLatch(db).revision;

    const out = admin.restoreOfflineAuditFault(
      db, { expectedGeneration: GEN, expectedLatchRevision: revision },
      actor({ auditId: 'pure-1' }),
    );
    assert.equal(out.ok, true, '★★ 纯锁存恢复必须成功');
    assert.equal(out.releasedLatch.revision, revision);
    assert.equal(readFaultLatch(db), null, '锁存已解除');

    let sent = 0;
    const path = createOfflineWritePath({
      store: db, clock: () => NOW,
      transport: async () => { sent += 1; return { ok: true }; },
    });
    const allowed = await path.write(likeReq({ id: 'pure-w' }));
    assert.equal(allowed.ok, true, '★ 恢复后写真的能发');
    assert.equal(sent, 1);
  } finally { try { db.close(); } catch { /* already closed */ } }
});


// AR-16 — an ANONYMOUS (legacy) gate plus a memory latch must also refuse, not be laundered.
//
// AR-14 covers a gate that NAMES an episode. A marker persisted before `generation` existed has no
// name at all, so `gate-generation-mismatch` cannot fire — the coarse check is unavailable and the
// fine-grained ones must decide instead. This pins the answer for that shape: still refused, still
// preserved, still zero transport. Without it, "no generation to compare" would silently become
// "nothing to compare, go ahead" for any caller that also happened to name a latch revision.
test('AR-16 匿名(旧格式) gate + 内存锁存也必须拒绝并保留（"无法比较"不等于"可以放行"）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-anon-gate-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  // The marker as it was written BEFORE generations existed: fault + since + cause, nothing else.
  const db = openOfflineStore(join(dir, 'state.db'), healthyState({
    audit: [], auditGaps: [],
    writeGate: { fault: 'audit-unavailable', since: T0 - 5_000, cause: 'audit-state-invalid' },
  }));

  try {
    latchFault(db, 'legacy-mixed-fault');
    const revision = readFaultLatch(db).revision;

    const out = admin.restoreOfflineAuditFault(
      db, { expectedGeneration: GEN, expectedLatchRevision: revision },
      actor({ auditId: 'anon-1' }),
    );

    assert.equal(out.ok, false, '★★ 匿名 gate + 锁存也不得被捷径放行');
    assert.equal(out.trail, 'recorded', '拒绝留审计行');
    assert.equal(typeof db.read().writeGate, 'object', '★★ gate 必须仍在');
    assert.deepEqual(readFaultLatch(db), { reason: 'legacy-mixed-fault', revision }, '★★ 锁存也必须仍在');
    assert.equal(checkWriteGate(db.read()).allowed, false, '★ 写门禁仍拒绝');

    let sent = 0;
    const path = createOfflineWritePath({
      store: db, clock: () => NOW,
      transport: async () => { sent += 1; return { ok: true }; },
    });
    const blocked = await path.write(likeReq({ id: 'anon-w' }));
    assert.equal(blocked.ok, false);
    assert.equal(sent, 0, '★★ 真实写零 transport');
  } finally { try { db.close(); } catch { /* already closed */ } }
});

// AR-17 — when EVERY layer can be satisfied at once, the recovery must go through all of them.
//
// The fix that makes AR-14/AR-16 refuse must not turn into "mixed states are unrecoverable". A state
// carrying gate G1 + an open gap G1 + a real latch is fully recoverable IF the request names G1 and the
// current latch revision: every layer's own constraint is met, so nothing is being guessed. Measured
// shape: resolvedGapCount 1, releasedLatch {reason,revision}, gate key dropped, latch gone, write sends.
test('AR-17 三层并存但各层都能满足时，恢复必须真的走完三层（不得退化成"混合一律拒绝"）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-triple-layer-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const db = openOfflineStore(join(dir, 'state.db'), healthyState({
    auditGaps: [gap({ key: 'triple-k', generation: GEN })],
    writeGate: { ...GATE, generation: GEN },
  }));

  try {
    latchFault(db, 'triple-fault');
    const revision = readFaultLatch(db).revision;

    const out = admin.restoreOfflineAuditFault(
      db, { expectedGeneration: GEN, expectedLatchRevision: revision },
      actor({ auditId: 'triple-1' }),
    );

    assert.equal(out.ok, true, '★★ 各层都满足时必须成功，否则混合状态永久不可恢复');
    assert.equal(out.resolvedGapCount, 1, '★ gap 被解（不是被删：resolvedBy 已置）');
    assert.deepEqual(out.releasedLatch, { reason: 'triple-fault', revision }, '★ 锁存如实记录被解除');
    assert.equal(db.read().writeGate ?? null, null, '★ gate 已清');
    assert.equal(readFaultLatch(db), null, '★ 锁存已解');
    assert.equal((db.read().auditGaps ?? []).length, 1, '证据保留：gap 仍在，只是 resolvedBy 非空');
    assert.equal(db.read().auditGaps[0].resolvedBy !== null, true);

    let sent = 0;
    const path = createOfflineWritePath({
      store: db, clock: () => NOW,
      transport: async () => { sent += 1; return { ok: true }; },
    });
    const allowed = await path.write(likeReq({ id: 'triple-w' }));
    assert.equal(allowed.ok, true, '★ 恢复后写真的能发');
    assert.equal(sent, 1);
  } finally { try { db.close(); } catch { /* already closed */ } }
});
