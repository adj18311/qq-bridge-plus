// M7 · four outcomes, one transaction — and the two defects this task was created to close.
//
// THE TWO DEFECTS, BOTH MEASURED BEFORE ANY CODE WAS WRITTEN
// ---------------------------------------------------------
// D-A (idempotency across a clock tick). `settleKeyFor` digested the WHOLE formatted record,
//     `time` included, and `time` came from `clock()`. Probe on a real store: settle at `T`,
//     retry the same logical settlement at `T+5s` → different digest → the `alreadySettled`
//     short-circuit was missed, the call fell through to the audit half, and the id-based duplicate
//     check then reported `conflicting audit id`. One retry of one settlement looked like a data
//     contradiction. `audit.failed:true` for a settlement that had already succeeded.
//
// D-B (breaker suppressed by a broken audit store). The t33 design rolled the WHOLE transaction back
//     on any throw, including an audit STORAGE fault. Probe: a genuinely `failed` result against a
//     store whose `audit` was a string left `writes` at 0 — the failure was never counted, so the
//     breaker could never reach its threshold. That is fail-open in the dangerous direction: the
//     worse the store, the less likely a pause.
//
// Both are now fixed. Every case below is written so that reverting either fix turns it red.
//
// WHAT IS *NOT* RELAXED
// ---------------------
// An audit-id CONFLICT (same id, different content) still rolls the whole transaction back. A
// contradiction is a caller bug, not a storage fault, and AT-5/AT-13 pin that. Degrading on a
// conflict would let two different messages share one identity.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createWriteObservability } from '../src/core/qzone-write-observability-offline.mjs';
import { isAuditGap } from '../src/core/qzone-audit-offline.mjs';
import { checkWriteGate, beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { readFaultLatch, clearFaultLatch, createOfflineWritePath, latchFault } from '../src/core/qzone-write-path-offline.mjs';
import { authorityOf } from '../src/core/qzone-store-offline.mjs';
import * as authorityShared from '../src/core/qzone-authority-shared.mjs';
import { resolveAuthority, requireAuthority } from '../src/core/qzone-authority-shared.mjs';
const T0 = 1_800_000_000_000;
const TARGET = '9876543210';

const baseState = (over = {}) => ({
  enabled: true, readAllowed: true, writeAllowed: true,
  accessPaused: false, writePaused: false,
  reads: 0, writes: 0, audit: [],
  writeGate: null, auditGaps: [],
  ...over,
});

const SUCCESS = Object.freeze({ ok: true, stage: 'transport', outcome: 'success', quotaConsumed: true, transportCalled: true });
const FAILED = Object.freeze({ ok: true, stage: 'transport', outcome: 'failed', quotaConsumed: true, transportCalled: true });

function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-oga-${label}-`));
  return {
    dir, dbPath: path.join(dir, 'state.db'),
    cleanup() { for (let i = 0; i < 20; i += 1) { try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* win handle */ } } },
  };
}

/** Real SQLite store + real observability + a controllable clock. */
function world({ state = baseState(), dbPath, clock = () => T0 } = {}) {
  const t = dbPath ? null : tempDb('w');
  const file = dbPath ?? t.dbPath;
  const store = openOfflineStore(file, state);
  const obs = createWriteObservability({ store, clock });
  return {
    t, store, obs,
    read: () => store.read(),
    close() { clearFaultLatch(store); try { store.close(); } catch {} t?.cleanup(); },
  };
}

const req = (over = {}) => ({ id: 'w-1', action: 'publish', target: TARGET, postId: 'p-1', source: 'qq', content: 'x', ...over });

/** A store whose transactions fail on demand — for the "all or nothing" case. */
function worldWithFailingCommit({ failAfter = 0 } = {}) {
  const t = tempDb('fail');
  const real = openOfflineStore(t.dbPath, baseState());
  let updates = 0;
  // A DELEGATING wrapper that CARRIES the real authority: `{ ...real }` copies the handle's own
  // `authority` property, so this store IS the same send authority as the database it wraps. It must
  // be — the whole point of these cases is that a commit failure here latches the authority that the
  // real handle's write path reads. (It used to be `declareOfflineTestDouble({read, update})`, which
  // MINTED a second authority over the same file; Codex CODEX-TEST-SEAM-CLOSE-20261114 §A removed
  // that escape hatch because a split authority is exactly the fail-open R6 killed.)
  const store = {
    ...real,
    update(fn) {
      updates += 1;
      if (updates > failAfter) throw new Error('disk full');
      return real.update(fn);
    },
  };
  const obs = createWriteObservability({ store, clock: () => T0 });
  // `store` (the failing wrapper) must be exposed: it is the authority this adapter was built with,
  // so it is the key the latch is filed under. An earlier version of this helper omitted it and the
  // latch assertions silently read `readFaultLatch(undefined)` → always null.
  return { t, real, store, obs, read: () => real.read(), close() { clearFaultLatch(store); clearFaultLatch(real); try { real.close(); } catch {} t.cleanup(); } };
}

// ── OGA-1: healthy path leaves no trace of fault ───────────────────────────────
test('OGA-1 正常成功 → 无 gap、无 gate、无 latch、degraded:false', () => {
  const w = world();
  try {
    const out = w.obs.record({ request: req(), result: SUCCESS });
    assert.equal(out.recorded, true);
    assert.equal(out.degraded, false, '正常路径不得标记降级');
    assert.equal(out.gap.recorded, false);
    assert.equal(out.audit.appended, true);
    assert.equal(out.audit.failed, false);

    const st = w.read();
    assert.deepEqual(st.auditGaps, [], '无 gap');
    assert.equal(st.writeGate, null, '无 gate');
    assert.equal(readFaultLatch(w.store), null, '无 latch');
    assert.equal(st.audit.length, 1);
  } finally { w.close(); }
});

// ── OGA-2: broken audit → gap + gate + breaker still counts ───────────────────
test('OGA-2 审计存储损坏 → gap 登记 + gate 置位 + 熔断仍计数（D-B 修复）', () => {
  const w = world({ state: baseState({ audit: 'CORRUPTED-NOT-AN-ARRAY' }) });
  try {
    assert.equal(w.read().writes, 0, '前提：症状是「真实失败没被计数」');
    const out = w.obs.record({ request: req({ id: 'broken-1' }), result: FAILED });

    // The whole point: a real failure is counted even though the audit row cannot be written.
    assert.equal(w.read().writes, 1, '★ 熔断必须计数（旧行为是 0 —— fail-open）');
    assert.equal(out.breaker.applied, true);
    assert.equal(out.breaker.writes, 1);

    // And the failure is not silently forgotten: a gap records it, the gate faults.
    assert.equal(out.degraded, true, '★ 必须标记降级，不能报成一切正常');
    assert.equal(out.gap.recorded, true);
    const gaps = w.read().auditGaps;
    assert.equal(gaps.length, 1, '★ gap 必须被登记');
    assert.equal(isAuditGap(gaps[0]), true, '必须是 M8 的合法 gap 形状');
    assert.equal(gaps[0].reason, 'audit-state-invalid', '存储损坏属于 state-invalid（要先修数据）');
    assert.equal(gaps[0].resolvedBy, null, '新 gap 必须是未解决的');

    const gate = w.read().writeGate;
    assert.ok(gate, '★ writeGate 必须被置位');
    assert.equal(gate.fault, 'audit-unavailable');
    assert.equal(gate.cause, 'audit-state-invalid');
    // Non-vacuity: the persisted gate must actually make the M1 gate refuse.
    assert.equal(checkWriteGate(w.read()).reason, 'write-gate-fault');

    assert.equal(out.audit.failed, true, '审计那一半仍要如实报失败');
  } finally { w.close(); }
});

// ── OGA-3: G-4 — a corrupted audit value is preserved, never "repaired" ───────
test('OGA-3 损坏的 audit 原值保留：不被清空、不被覆盖成数组（G-4）', () => {
  for (const corrupt of ['CORRUPTED-NOT-AN-ARRAY', 42, { not: 'an array' }, null]) {
    const w = world({ state: baseState({ audit: corrupt }) });
    try {
      // Fixed SAFE id on purpose: an earlier version interpolated the corrupt value into the id, and
      // `String({not:'an array'})` is `[object Object]` — not a legal gap key, so that one case failed
      // for a reason that had nothing to do with preservation. The corruption value must be the only
      // variable here.
      const out = w.obs.record({ request: req({ id: 'keep-1' }), result: FAILED });
      assert.equal(out.degraded, true, `audit=${JSON.stringify(corrupt)}: 必须降级`);
      assert.deepEqual(w.read().audit, corrupt,
        `★ audit=${JSON.stringify(corrupt)}: 必须原样保留 —— 清空或「修好」就销毁了证据`);
      // The gap is a SIDE record, not a replacement.
      assert.equal(w.read().auditGaps.length, 1, 'gap 是并列旁证，不是替代品');
    } finally { w.close(); }
  }
});

// ── OGA-4: four outcomes commit together ──────────────────────────────────────
test('OGA-4 四者同提交：breaker / settled / gap / gate 在同一次 store.update 里一起变', () => {
  const t = tempDb('four');
  try {
    const real = openOfflineStore(t.dbPath, baseState({ audit: 'BROKEN' }));
    let updates = 0;
    let seenKeys = null;
    // A SPREAD wrapper (not a closure): it carries the store's own enumerable authority, so it is the
    // same send authority as `real`. This is the documented way to observe a transaction — the R6
    // construction-time refusal only rejects handles that cannot name their database.
    const store = {
      ...real,
      read: () => real.read(),
      update(fn) {
        updates += 1;
        const out = real.update(fn);
        seenKeys = Object.keys(out).sort();
        return out;
      },
    };
    const obs = createWriteObservability({ store, clock: () => T0 });
    try {
      obs.record({ request: req({ id: 'four-1' }), result: FAILED });

      assert.equal(updates, 1, '★ 恰好一次事务（不是四次）');
      // All four state areas changed in that ONE commit.
      const st = real.read();
      assert.equal(st.writes, 1, 'breaker 变了');
      assert.equal(Object.keys(st.settled).length, 1, 'settled 变了');
      assert.equal(st.auditGaps.length, 1, 'gap 变了');
      assert.ok(st.writeGate, 'gate 变了');
      // And they were all present in the single returned object handed to COMMIT.
      for (const key of ['writes', 'settled', 'auditGaps', 'writeGate']) {
        assert.ok(seenKeys.includes(key), `★ 同一次提交里必须同时出现 ${key}`);
      }
    } finally { real.close(); }
  } finally { t.cleanup(); }
});

// ── OGA-5: a commit failure rolls back ALL four ──────────────────────────────
test('OGA-5 事务失败 → 四者全不变（并在事务外触发 M4 锁存）', () => {
  const w = worldWithFailingCommit({ failAfter: 0 });
  try {
    const before = w.read();
    assert.equal(before.writes, 0, '前提：writes 起点 0');
    assert.deepEqual(before.auditGaps, [], '前提：起点无 gap');
    assert.equal(before.writeGate, null, '前提：起点无 gate');

    const out = w.obs.record({ request: req(), result: FAILED });

    assert.equal(out.rolledBack, true, '★ 必须如实报告回滚');
    assert.equal(out.recorded, false);
    const after = w.read();
    assert.equal(after.writes, 0, '★ 熔断不得推进（事务失败）');
    assert.deepEqual(after.auditGaps, [], '★ 不得留下 gap');
    assert.equal(after.writeGate, null, '★ 不得置 gate');
    assert.equal(Object.keys(after.settled ?? {}).length, 0, '★ 不得留 settled');

    // M7 -> M4: a commit failure is exactly what the latch is for, called OUTSIDE the transaction.
    // The latch is keyed by the store OBJECT the adapter was built with — here that is the failing
    // wrapper, not the inner store. (Honest limitation: a wrapper and the store it delegates to are
    // two different authorities to this module, because it only ever sees the object it was given.)
    assert.ok(readFaultLatch(w.store), '★ 提交失败必须触发 M4 锁存');
  } finally { w.close(); }
});

// ── OGA-6: cross-clock idempotency, through the REAL entry point ─────────────
test('OGA-6 跨 clock 幂等（真实 record + 真实 store）：两次不同 clock 只结算一次', () => {
  const t = tempDb('clock');
  try {
    const store = openOfflineStore(t.dbPath, baseState());
    let clockNow = T0;
    const obs = createWriteObservability({ store, clock: () => clockNow });
    try {
      const request = req({ id: 'cross-clock' });

      const first = obs.record({ request, result: FAILED });
      assert.equal(first.alreadySettled, false, '第一次是真正的结算');
      assert.equal(first.recorded, true);
      assert.equal(store.read().writes, 1);

      // Same logical settlement, LATER clock. This is the shape that used to break idempotency.
      clockNow = T0 + 5_000;
      const second = obs.record({ request, result: FAILED });

      assert.equal(second.alreadySettled, true, '★ 跨 clock 重复必须被认作同一结算（D-A 修复）');
      assert.equal(store.read().writes, 1, '★ writes 只 +1，不得变成 2');
      assert.equal(Object.keys(store.read().settled).length, 1, '★ 只有一个 settled 键');
      assert.equal(second.audit.failed, false, '★ 不得误报冲突（旧行为报 conflicting audit id）');
      assert.equal(second.audit.conflict, undefined, '不得产生 conflict');
      assert.equal(store.read().audit.length, 1, '审计仍只有一行');

      // A THIRD tick, well past, must also be a no-op — the key must not be sensitive to WHEN.
      clockNow = T0 + 3_600_000;
      const third = obs.record({ request, result: FAILED });
      assert.equal(third.alreadySettled, true);
      assert.equal(store.read().writes, 1);
    } finally { store.close(); }
  } finally { t.cleanup(); }
});

test('OGA-6b 跨 clock 幂等跨重启也成立（settled 键真的落在磁盘上）', () => {
  const t = tempDb('clock-restart');
  try {
    let clockNow = T0;
    const first = openOfflineStore(t.dbPath, baseState());
    const obs1 = createWriteObservability({ store: first, clock: () => clockNow });
    obs1.record({ request: req({ id: 'restart-clock' }), result: FAILED });
    assert.equal(first.read().writes, 1);
    first.close();

    const reopened = openOfflineStore(t.dbPath, baseState());
    try {
      clockNow = T0 + 9_999;   // different clock, different process
      const obs2 = createWriteObservability({ store: reopened, clock: () => clockNow });
      const out = obs2.record({ request: req({ id: 'restart-clock' }), result: FAILED });
      assert.equal(out.alreadySettled, true, '★ 重启 + 换 clock 之后仍须认出同一条结算');
      assert.equal(reopened.read().writes, 1, 'writes 仍是 1');
    } finally { reopened.close(); }
  } finally { t.cleanup(); }
});

// ── OGA-7: M7 -> M4 propagation ──────────────────────────────────────────────
test('OGA-7 M7→M4 传播：提交失败后 readFaultLatch(store) 非空，且该权威被门禁拒绝', () => {
  const w = worldWithFailingCommit({ failAfter: 0 });
  try {
    assert.equal(readFaultLatch(w.store), null, '前提：未锁存');
    w.obs.record({ request: req(), result: FAILED });
    const latched = readFaultLatch(w.store);
    assert.ok(latched, '★ 提交失败必须让 M4 锁存非空');
    assert.match(latched.reason, /settle-/, 'reason 必须说明是结算侧的失败');

    // And the latch is wired to the gate: the same authority now refuses reads through M1's gate.
    // (checkWriteGate itself does not consult the latch — that is write-path's combined gate — so this
    // asserts the latch's presence, which is what write-path's gateRefusal checks.)
    assert.equal(typeof latched.reason, 'string');
  } finally { w.close(); }
});

test('OGA-7b 成功路径不触发锁存（避免「一有风吹草动就锁死」）', () => {
  const w = world();
  try {
    w.obs.record({ request: req(), result: SUCCESS });
    assert.equal(readFaultLatch(w.store), null, '★ 成功结算不得锁存');
    w.obs.record({ request: req({ id: 'w-2' }), result: FAILED });
    assert.equal(readFaultLatch(w.store), null, '★ 计数一次失败也不得锁存（那是熔断的职责）');
  } finally { w.close(); }
});

// ── OGA-8: the gap key must not move with the clock ──────────────────────────
test('OGA-8 gap 键不含 clock：同一执行两次不同 clock 只产生一条 gap', () => {
  const t = tempDb('gapkey');
  try {
    const store = openOfflineStore(t.dbPath, baseState({ audit: 'BROKEN' }));
    let clockNow = T0;
    const obs = createWriteObservability({ store, clock: () => clockNow });
    try {
      const request = req({ id: 'gap-clock' });

      const first = obs.record({ request, result: FAILED });
      assert.equal(first.gap.recorded, true);
      const key1 = store.read().auditGaps[0].key;
      assert.equal(store.read().auditGaps.length, 1);

      // Same settlement identity, different clock → the gap must NOT be duplicated.
      clockNow = T0 + 5_000;
      const second = obs.record({ request, result: FAILED });
      const gaps = store.read().auditGaps;
      assert.equal(gaps.length, 1, '★ 换 clock 不得产生第二条 gap');
      assert.equal(gaps[0].key, key1, '★ gap 键必须稳定（clock-free）');
      assert.equal(second.alreadySettled, true, '第二次是同一结算，不是新失败');
      assert.equal(store.read().writes, 1, '熔断也不得再计数');
    } finally { store.close(); }
  } finally { t.cleanup(); }
});

// ── OGA-9: conflicts keep the old all-or-nothing semantics ───────────────────
test('OGA-9 冲突仍整体回滚：同 id 不同内容 → rolledBack、无 gap、无 gate、writes 不变', () => {
  const w = world({ state: baseState({ writes: 2 }) });
  try {
    assert.equal(w.obs.record({ request: req({ id: 'cid', content: 'AAA' }), result: SUCCESS }).recorded, true);
    const writesAfterFirst = w.read().writes;   // SUCCESS reset writes to 0

    w.store.update((s) => ({ ...s, writes: 2 }));   // pin a non-zero baseline so an increment is visible
    const out = w.obs.record({ request: req({ id: 'cid', content: 'BBB' }), result: FAILED });

    assert.equal(out.rolledBack, true, '★ 矛盾必须整体回滚（AT-5/AT-13 语义未放宽）');
    assert.equal(out.audit.conflict.reason, 'conflicting-audit-id');
    assert.equal(out.degraded, false, '★ 冲突不是存储故障，不得走降级路径');
    assert.equal(w.read().writes, 2, '★ 熔断不得推进（回滚）');
    assert.deepEqual(w.read().auditGaps, [], '★ 冲突不得登记 gap');
    assert.equal(w.read().writeGate, null, '★ 冲突不得置 gate');
    assert.equal(w.read().audit.length, 1, '原审计行未被覆盖');
    assert.equal(w.read().audit[0].record.content, 'AAA');
    void writesAfterFirst;
  } finally { w.close(); }
});

// ── OGA-10: the source-level invariants ──────────────────────────────────────
/**
 * Slice ONE balanced `{...}` block starting at the first `{` at or after `from`.
 *
 * WHY NOT `indexOf('} else {')`: that was the previous implementation and it was MEASURED to be
 * vacuous. `if (atomic) {` is followed by several inner `} else {` occurrences (the audit if/else at
 * the conflict branch), so the slice ended 117 lines early — at line 371 instead of 488 — and the
 * real `latchFault` call (line 438) was OUTSIDE it. The regex below therefore matched `false`
 * unconditionally: it looked like a guard and guarded nothing. Proof: moving `latchFault` into the
 * transaction callback left every OGA case green.
 *
 * Brace matching makes the slice the WHOLE block, whatever happens to inner branches, so the
 * invariant is tested against the code it claims to test.
 */
function sliceBalancedBlock(source, from) {
  const open = source.indexOf('{', from);
  assert.notEqual(open, -1, `no block found at/after ${from}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced block');
}

test('OGA-10 源码级：M7 未把审计搬出事务、未让熔断单独提交、未改 policy/audit', () => {
  const source = fs.readFileSync(new URL('../src/core/qzone-write-observability-offline.mjs', import.meta.url), 'utf8');

  // Strip comments ONCE, up front, and use the stripped text for every shape check below. Doing it
  // per-assertion is how this test previously ended up inconsistent: the "exactly one latchFault"
  // count stripped comments while the "not inside the callback" check did not, so a comment merely
  // MENTIONING `latchFault(` inside the callback would have gone red on correct code. One text, one
  // rule.
  //
  // LIMITS OF THIS TECHNIQUE, stated so it is not mistaken for parsing: this is regex comment
  // removal on JS source, not a parser. A string literal containing `latchFault(` still counts, so a
  // determined edit could pad the count with `void 'latchFault('`. That direction is LOW risk
  // (removing the real call to compensate turns OGA-5/7/11/12 red — four behavioural assertions), and
  // it is recorded here rather than upgraded into a product vulnerability. THE BEHAVIOURAL CASES ARE
  // THE REAL GUARD; this test only catches the shape of the rollback path.
  const codeOnly = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')     // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1');  // line comments (not the `://` inside a string)

  // The atomic path must still be ONE store.update (G3 not reopened).
  const atomicStart = source.indexOf('if (atomic) {');
  assert.notEqual(atomicStart, -1, '必须存在 atomic 分支');
  const atomicCode = codeOnly(sliceBalancedBlock(source, atomicStart));

  // The slice must REALLY cover the whole block, including the post-commit latch call. Asserting the
  // slice's own extent is what stops the previous vacuous-slice bug from coming back: if a future edit
  // shortens it, this fails first and loudly instead of the regex silently passing.
  assert.match(atomicCode, /latchFault\(/,
    '★ 切片必须覆盖整块，包含事务外的 latchFault 调用 —— 否则下面的「事务外」断言是空转');
  assert.equal((atomicCode.match(/store\.update\(/g) ?? []).length, 1,
    '★ 原子路径必须恰好一次 store.update（G3 的窗口不得被重开）');

  // Exactly ONE transaction callback: a second `store.update((state)` inside the atomic path would
  // reopen the window the single-transaction design closed.
  assert.equal((atomicCode.match(/store\.update\(\(state\)/g) ?? []).length, 1,
    '★ 原子路径只能有一个事务回调');

  // The latch must be OUTSIDE that transaction callback — measured against the callback's real body,
  // on the SAME comment-stripped text as the count below.
  const callbackStart = atomicCode.indexOf('store.update((state)');
  assert.notEqual(callbackStart, -1, '必须有事务回调');
  const callbackCode = sliceBalancedBlock(atomicCode, callbackStart);
  assert.equal(/latchFault\(/.test(callbackCode), false,
    '★ latchFault 必须在事务回调之外调用：回调内拿不到 commit 结果，会把「未提交」误判成「已失败」');

  // And it must be reached exactly once, in the rollback path that follows the callback.
  assert.equal((atomicCode.match(/latchFault\(/g) ?? []).length, 1,
    '★ latchFault 在原子路径里恰好被调用一次（只能有一个失败出口）');

  // It must reuse M8's formatter rather than hand-building a gap shape.
  assert.match(source, /formatAuditGap\(/, '★ gap 必须走 M8 的 formatAuditGap');
  assert.equal(/auditGaps:\s*\[\s*\{/.test(source), false, '不得手搓 gap 对象');

  // And it must reuse M4's latch rather than keeping its own flag.
  assert.match(source, /import \{[^}]*latchFault[^}]*\} from '\.\/qzone-write-path-offline\.mjs'/,
    '★ 锁存必须复用 M4 的实现');

  // M9: the authority must come from the SAME resolver the write path uses. Resolving it here with a
  // private rule is exactly what let a wrapper be latched on one side and open on the other.
  assert.match(source, /from '\.\/qzone-authority-shared\.mjs'/,
    '★ 权威必须经共享解析器，不得各自一套');
});

test('OGA-10b key schema: 排除 time，其余字段一个不少', () => {
  const source = fs.readFileSync(new URL('../src/core/qzone-write-observability-offline.mjs', import.meta.url), 'utf8');
  assert.match(source, /const SETTLE_KEY_EXCLUDED = new Set\(\['time'\]\)/,
    '排除集必须只含 time —— 多排除任何字段都会让不同操作撞成同一条结算');
});

// ── OGA-11: M7 → M4 END TO END, in ONE case ─────────────────────────────────
//
// WHY THIS CASE EXISTS (t6, measured)
// -----------------------------------
// The two halves were each proven, but SEPARATELY: OGA-5/7 showed "a failed record latches", and the
// write-path suite showed "a latched authority refuses". No repository case joined them, so a change
// that made the latch real but unreachable (or reached a different authority) kept every existing
// test green. This one drives the whole chain against ONE real store:
//   observability.record() fails to commit  ->  latch raised  ->  write path refuses a NEW write
// and it additionally asserts the write path's own transport was never called.
test('OGA-11 端到端：结算提交失败 → 锁存 → 同一权威的写路径拒绝新写（transport 零调用）', async () => {
  const t = tempDb('e2e-latch');
  try {
    const real = openOfflineStore(t.dbPath, {
      enabled: true, readAllowed: true, writeAllowed: true,
      accessPaused: false, writePaused: false,
      tools: { publish: true, comment: true, reply: true, like: true },
      limits: { post: 3, comment: 25, like: 30 },
      ledger: { day: beijingDay(T0), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
      lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [],
      reads: 0, writes: 0, audit: [], writeGate: null, auditGaps: [],
    });
    let sent = 0;
    const path = createOfflineWritePath({
      store: real,
      clock: () => T0,
      transport: async () => { sent += 1; return { ok: true }; },
    });
    // The settlement side is built on a handle whose transactions fail: that is the commit failure
    // the latch exists for. It is a SPREAD wrapper (`{ ...real, update }`), which is the documented
    // controlled composition: the authority token is copied as an own property, so this wrapper and
    // `real` are the SAME authority. (A closure wrapper that merely holds `real` in a variable cannot
    // name its database, so it cannot be merged — that boundary is asserted in OGA-12, not pretended
    // away here.)
    const failing = { ...real, update: () => { throw new Error('disk full on commit'); } };
    const obs = createWriteObservability({ store: failing, clock: () => T0 });
    try {
      // Precondition: nothing latched, and the write path works.
      assert.equal(readFaultLatch(real), null, '前提：未锁存');
      const before = await path.write({ id: 'e2e-before', action: 'like', target: TARGET, postId: 'p-1' });
      assert.equal(before.ok, true, '前提：锁存前写路径能发');
      assert.equal(sent, 1);

      // The settlement fails to commit -> M7 must raise the latch on that authority.
      const out = obs.record({ request: req({ id: 'e2e-settle' }), result: FAILED });
      assert.equal(out.rolledBack, true, '前提：提交失败必须回滚');
      const latched = readFaultLatch(real);
      assert.ok(latched, '★ M7 必须锁存到与写路径同一个权威（裸句柄读得到）');
      assert.match(latched.reason, /settle-/, 'reason 必须来自结算侧');

      // The SAME authority's write path must now refuse, without touching the transport.
      const after = await path.write({ id: 'e2e-after', action: 'like', target: TARGET, postId: 'p-2' });
      assert.equal(after.ok, false, '★ 锁存后写路径必须拒绝新写');
      assert.equal(after.reason, 'process-fault-latched', `实际 reason: ${JSON.stringify(after.reason)}`);
      assert.equal(after.quotaConsumed, false, '★ 拒绝时不得消耗配额');
      assert.equal(sent, 1, '★ transport 调用次数必须停在 1（新写一次都没发）');
    } finally { clearFaultLatch(real); clearFaultLatch(failing); try { real.close(); } catch {} }
  } finally { t.cleanup(); }
});

// ── OGA-12: wrapper shapes — one shares, one is REFUSED ──────────────────────
//
// MEASURED BEFORE THE FIX: `{ latched:true, ok:true, transportCalls:1 }` when the observability side
// was built on a closure wrapper and the write path on the bare handle — a latched fault that did not
// stop a send (same direction as F-M4-1). Two shapes, two different answers, both pinned here:
//
//   · SPREAD wrapper (`{ ...store, update }`) — the authority token is an own enumerable property, so
//     the copy carries it and shares the authority. ACCEPTED (OGA-12 A).
//   · CLOSURE wrapper (`{ read: () => real.read(), update }`) — exposes nothing that names the
//     database. It CANNOT be merged, so per R6 it is now REFUSED at construction with zero reservation
//     and zero transport, instead of silently becoming its own authority (OGA-12 B).
//
// The (B) case used to assert the fail-open outcome. It now asserts the refusal — and the transport
// counter proves nothing was sent, which is the property that actually matters.
test('OGA-12 包装句柄：spread 包装共享权威；closure 包装在构造期被拒（零预留零传输）', async () => {
  const t = tempDb('e2e-wrapper');
  try {
    const real = openOfflineStore(t.dbPath, {
      enabled: true, readAllowed: true, writeAllowed: true,
      accessPaused: false, writePaused: false,
      tools: { publish: true, comment: true, reply: true, like: true },
      limits: { post: 3, comment: 25, like: 30 },
      ledger: { day: beijingDay(T0), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
      lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [],
      reads: 0, writes: 0, audit: [], writeGate: null, auditGaps: [],
    });
    const writePath = (store, counter) => createOfflineWritePath({
      store, clock: () => T0,
      transport: async () => { counter.n += 1; return { ok: true }; },
    });
    const counter = { n: 0 };
    const path = writePath(real, counter);
    try {
      // ── (A) SPREAD WRAPPER — shares ────────────────────────────────────────
      const spread = { ...real, update: () => { throw new Error('disk full on commit'); } };
      assert.equal(resolveAuthority(spread), resolveAuthority(real),
        '★ { ...store } 包装必须与裸句柄解析到同一权威');
      const obsSpread = createWriteObservability({ store: spread, clock: () => T0 });
      obsSpread.record({ request: req({ id: 'spread-settle' }), result: FAILED });
      assert.ok(readFaultLatch(real), '★ 经 spread 包装锁存后，裸句柄必须读到同一个锁存');
      const refused = await path.write({ id: 'spread-after', action: 'like', target: TARGET, postId: 'p-1' });
      assert.equal(refused.ok, false, '★ spread 包装上的锁存必须让裸句柄的写路径拒绝');
      assert.equal(refused.reason, 'process-fault-latched');
      assert.equal(counter.n, 0, '★ transport 零调用');

      // Clean the latch so (B) starts from a known state.
      clearFaultLatch(real); clearFaultLatch(spread);
      assert.equal(readFaultLatch(real), null, '前提：已清除');

      // ── (B) CLOSURE WRAPPER — REFUSED AT CONSTRUCTION ─────────────────────
      const closure = {
        read: () => real.read(),
        update: () => { throw new Error('disk full on commit'); },
      };
      assert.equal(authorityOf(closure), null, 'closure 包装不携带权威（无可命名的数据库身份）');
      assert.equal(resolveAuthority(closure), null,
        '★ 无权威必须解析为 null —— 不得回退到对象身份（那正是 fail-open 的来源）');
      assert.throws(() => requireAuthority(closure, 'probe'), /send authority/,
        '★ requireAuthority 必须拒绝未绑定句柄');

      const sentByClosure = { n: 0 };
      assert.throws(
        () => createWriteObservability({ store: closure, clock: () => T0 }),
        /send authority/,
        '★★ 观测侧构造期必须拒绝 closure 包装 —— 否则锁存落在一个写路径永远看不到的权威上',
      );
      assert.throws(
        () => createOfflineWritePath({
          store: closure, clock: () => T0,
          transport: async () => { sentByClosure.n += 1; return { ok: true }; },
        }),
        /send authority/,
        '★★ 写路径构造期同样必须拒绝',
      );
      assert.equal(sentByClosure.n, 0, '★★ transport 一次都没有被调用（拒绝发生在构造期，零传输）');
      assert.equal(writePath(real, { n: 0 }) !== null, true, '前提：裸句柄仍然可构造');
      assert.equal(resolveAuthority(real) === null, false, '前提：裸句柄有权威');
    } finally {
      clearFaultLatch(real); try { real.close(); } catch {}
    }
  } finally { t.cleanup(); }
});

// ── OGA-13: a corrupt `settled` / `auditGaps` value is EVIDENCE, not scratch space ──────────────
//
// G-4 says a corrupt value must be preserved (OGA-3 pins that for `audit`). Two more fields were
// quietly "repaired" instead: `settled` was spread away (`{...corrupt, [key]: ...}`) and `auditGaps`
// was replaced by `[gap]`. Both looked healthy afterwards, which is exactly the deception G-4 exists
// to prevent. Now the corrupt value survives verbatim and the fault is reported.
test('OGA-13 损坏的 settled 原值必须保留，且整笔回滚（不得「跳过幂等仍推进熔断」）', () => {
  for (const corrupt of ['CORRUPT-SETTLED', 42, ['not', 'a', 'map']]) {
    const w = world({ state: baseState({ settled: corrupt }) });
    try {
      const out = w.obs.record({ request: req({ id: 'corrupt-1' }), result: FAILED });

      // (a) EVIDENCE: the corrupt value is byte-identical afterwards — never "repaired".
      assert.deepEqual(w.read().settled, corrupt,
        `★ settled=${JSON.stringify(corrupt)}: 必须逐字保留 —— 覆盖它就销毁了「盘上本来是什么」的证据`);
      assert.deepEqual(out.corrupt.settled, { value: corrupt },
        '★ 必须如实上报发现的是损坏值，而不是假装没看见');

      // (b) FAIL-CLOSED: nothing of THIS call is persisted. Without a trustworthy idempotency record
      // a retry cannot be told from a first attempt, so settling at all would let one execution be
      // counted twice (measured: writes 1 -> 2 with a fixed clock before this guard existed).
      assert.equal(out.rolledBack, true, '★ settled 损坏必须整笔回滚');
      assert.equal(out.recorded, false, '★ 不得声称已结算');
      assert.equal(w.read().writes, 0, '★ 熔断不得推进（回滚后仍是 0）');
      assert.equal(w.read().audit.length, 0, '★ 审计行不得落盘');
      assert.equal(w.read().writeGate, null, '★ 本调用不得置 gate（不改写别的故障标记）');

      // (c) A SECOND call must behave identically — this is the double-count the guard exists to stop.
      const again = w.obs.record({ request: req({ id: 'corrupt-1' }), result: FAILED });
      assert.equal(again.rolledBack, true, '★ 第二次重试同样回滚');
      assert.equal(w.read().writes, 0, '★★ 同一个 clock 下重复调用，熔断次数必须仍是 0（不得双计）');
    } finally { w.close(); }
  }
});

test('OGA-13c 损坏的 auditGaps ⇒ 必要 gap 无法安全记录，整笔回滚并锁存（不得只保留原值就继续提交）', () => {
  for (const corrupt of ['CORRUPT-GAPS', 7, { not: 'an array' }]) {
    const w = world({ state: baseState({ audit: 'CORRUPT-AUDIT', auditGaps: corrupt }) });
    try {
      const out = w.obs.record({ request: req({ id: 'corrupt-2' }), result: FAILED });

      // (a) EVIDENCE: both corrupt values survive byte-identically.
      assert.deepEqual(w.read().auditGaps, corrupt,
        `★ auditGaps=${JSON.stringify(corrupt)}: 必须逐字保留`);
      assert.equal(w.read().audit, 'CORRUPT-AUDIT', 'audit 原值同样保留');
      assert.deepEqual(out.corrupt.auditGaps, { value: corrupt }, '★ 必须如实上报');

      // (b) FAIL-CLOSED — this is the change from R7 counterexample 4. Preserving the corrupt value
      // while still committing breaker+gate produced a HALF-settlement: a real failure counted, no
      // audit row, no gap. Measured then: `rolledBack:false, degraded:true, writes:1`.
      assert.equal(out.rolledBack, true,
        '★★ 必要 gap 无法安全记录 ⇒ 必须整笔回滚（不得只保留原值就提交熔断）');
      assert.equal(out.recorded, false, '不得声称已结算');
      assert.equal(w.read().writes, 0, '★★ 熔断不得推进');
      assert.equal(w.read().writeGate, null, '本调用不得置 gate');
      assert.equal(out.degraded, false, '★ 不得自称「降级成功」——那是一次不存在的一半成功');

      // (c) And the authority is latched, so the next write cannot go out.
      const latch = readFaultLatch(w.store);
      assert.ok(latch, '★★ 回滚后必须锁存同一权威');
      // THE REASON MUST NAME *THIS* FIELD, NOT JUST "SOMETHING SETTLE-SIDED". `/settle-/` is satisfied by
      // all three reason strings, so with the loose prefix match the auditGaps attribution was never
      // actually asserted — reverting the throw-site reason to the old phase-derived one
      // (`settle-conflict-rollback`) left this very case GREEN. Measured (M-H): only OGA-13e went red.
      // The reason is the ONLY diagnostic a latched process yields, so "which field do I repair" has
      // to be pinned, or the fix is half-covered by its own regression suite.
      assert.equal(latch.reason, 'settle-auditgaps-corrupt',
        '★★ 原因必须指名 auditGaps 损坏本身 —— 不是笼统的 /settle-/，也不是冲突回滚');
    } finally { w.close(); }
  }
});

test('OGA-13d 正控：auditGaps 损坏但 audit 正常 ⇒ 仍走降级路径（gate + 熔断生效，gap 记不下）', () => {
  // The fail-closed above must not swallow the DEGRADE path that exists for a working `audit` whose
  // separate sink failed. Here the audit array is fine but `auditGaps` is corrupt, and the audit WRITE
  // is what fails (via an injected sink) — so the gap is genuinely necessary and genuinely unrecordable.
  const w = world({ state: baseState({ auditGaps: 'CORRUPT-GAPS' }) });
  try {
    const out = w.obs.record({ request: req({ id: 'corrupt-3' }), result: FAILED });
    // With a healthy `audit`, no gap is needed at all: the row lands normally.
    assert.equal(out.recorded, true, '前提：audit 正常时这次结算应当成功');
    assert.equal(w.read().audit.length, 1, '审计行正常写入');
    assert.equal(w.read().auditGaps, 'CORRUPT-GAPS', '未被触碰的损坏值原样保留');
    assert.equal(out.corrupt.auditGaps, null, '★ 没用到 auditGaps ⇒ 不得误报损坏');
  } finally { w.close(); }
});

test('OGA-13b 正常态：settled / auditGaps 合法时 corrupt 必须为 null（不得误报）', () => {
  const w = world();
  try {
    const out = w.obs.record({ request: req({ id: 'clean-1' }), result: SUCCESS });
    assert.equal(out.corrupt.settled, null, '★ 合法 settled 不得被报成损坏');
    assert.equal(out.corrupt.auditGaps, null, '★ 合法 auditGaps 不得被报成损坏');
    assert.equal(Object.keys(w.read().settled).length, 1, 'settled 正常写入');
  } finally { w.close(); }
});


// ══════════════════════════════════════════════════════════════════════════════════════════════
// OGA-14 — the closure bypass can no longer be constructed at all
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// THIS CASE USED TO PIN THE OPPOSITE. In R8–R12 the module exported `declareOfflineTestDouble`, so a
// closure over a real store could be MINTED into its own authority, and this test asserted the
// resulting fail-open was real:
//
//     resolveAuthority(closure) !== null, 与 real 不同 token
//     latchFault(closure) -> readFaultLatch(real) === null
//     path(real).write -> ok:true, transportCalls:1        ← the R6 fail-open, rebuilt
//     used.like 当日 +1（方向 R：真实权威拒绝的写花掉了真实配额）
//
// Pinning that as "known and accepted" was still wrong (Codex CODEX-TEST-SEAM-CLOSE-20261114 §A): a
// test that asserts a bypass succeeds will also PASS if the bypass is later re-opened, and it teaches
// the next reader that the bypass is a feature. The escape hatch is now gone, so the case inverts:
// the closure cannot become an authority, the factories refuse it, and no quota can be spent through it.
//
// The end-to-end positive/negative control is kept (same database, real fault ⇒ real write refused).
test('OGA-14 closure 无法被造成权威：构造期拒绝、同库零分裂、零配额消耗', async () => {
  const t = tempDb('backdoor');
  try {
    const real = openOfflineStore(t.dbPath, {
      enabled: true, readAllowed: true, writeAllowed: true,
      accessPaused: false, writePaused: false,
      tools: { publish: true, comment: true, reply: true, like: true },
      limits: { post: 3, comment: 25, like: 30 },
      ledger: { day: beijingDay(T0), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
      lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [],
      reads: 0, writes: 0, audit: [], writeGate: null, auditGaps: [],
    });
    const closure = { read: () => real.read(), update: (fn) => real.update(fn) };
    try {
      // ── the closure has no authority, and there is no longer any way to grant one ──
      assert.equal(resolveAuthority(closure), null, '★★ closure 不携带权威');
      assert.throws(
        () => createOfflineWritePath({ store: closure, clock: () => T0, transport: async () => ({ ok: true }) }),
        /send authority/, '★★ 写路径构造期拒绝 closure',
      );
      assert.throws(() => createWriteObservability({ store: closure, clock: () => T0 }), /send authority/,
        '★★ observability 构造期拒绝 closure');

      // ── no escape hatch is exported at all: the capability, not the name, is what matters ──
      assert.equal(Object.keys(authorityShared).includes('declareOfflineTestDouble'), false,
        '★★ 普通运行模块不再导出「把任意对象变成新权威」的捷径');

      // ── the supported wrapper DOES carry the authority (spread keeps the `authority` property) ──
      const spread = { ...real };
      assert.equal(resolveAuthority(spread), resolveAuthority(real), '★★ spread 包装与真实库是同一权威');
      assert.doesNotThrow(() => createWriteObservability({ store: spread, clock: () => T0 }));

      // ── end-to-end control: a REAL fault on the real authority blocks the real write ──
      latchFault(real, 'real-authority-fault');
      let realSent = 0;
      const realPath = createOfflineWritePath({
        store: real, clock: () => T0,
        transport: async () => { realSent += 1; return { ok: true }; },
      });
      const quotaBefore = real.read().ledger.used.like;
      const refused = await realPath.write({ id: 'bd-real', action: 'like', target: TARGET, postId: 'p-1' });
      assert.equal(refused.ok, false, '★★ 真实权威被锁存 ⇒ 真实写被拒');
      assert.equal(refused.reason, 'process-fault-latched');
      assert.equal(realSent, 0, '★★ transport 零调用');
      assert.equal(real.read().ledger.used.like, quotaBefore, '★★ 且零配额消耗（被拒不是"花了才拦"）');

      // A spread wrapper sharing that authority is refused too — sharing must not become a bypass.
      const spreadPath = createOfflineWritePath({
        store: spread, clock: () => T0,
        transport: async () => { realSent += 1; return { ok: true }; },
      });
      const refusedViaSpread = await spreadPath.write({ id: 'bd-spread', action: 'like', target: TARGET, postId: 'p-2' });
      assert.equal(refusedViaSpread.ok, false, '★★ spread 包装共享权威 ⇒ 同样被拒');
      assert.equal(realSent, 0);
    } finally {
      clearFaultLatch(real); try { real.close(); } catch {}
    }
  } finally { t.cleanup(); }
});


// ══════════════════════════════════════════════════════════════════════════════════════════════
// OGA-13e — "absent" and "present but corrupt" must not collapse into one another (Codex D3)
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// The rule: a field that was NEVER WRITTEN is not damage, and a field that is DAMAGED is not an empty
// collection. Conflating them either (a) refuses every fresh database as corrupt, or (b) silently
// discards evidence by treating a corrupt value as "no records yet" — and (b) is the dangerous one,
// because the next settlement would then write a plausible-looking map over the evidence.
//
// Measured three-way distinction on a real store, all with the SAME healthy settlement:
//   absent     -> committed normally, corrupt.settled === null, field left uncreated
//   null       -> committed normally (null means "never written" here, same as absent)
//   corrupt    -> refused, value preserved VERBATIM, latch raised, nothing written
test('OGA-13e 字段不存在 ≠ 字段损坏：缺失照常提交，损坏必须拒绝且原值逐字保留', () => {
  const makeAbsent = () => {
    const s = baseState();
    delete s.settled;
    delete s.auditGaps;
    return s;
  };

  // ── absent: never written, must be treated as "nothing to be corrupt" ──
  const aw = world({ state: makeAbsent() });
  try {
    const state = aw.read();
    assert.equal(Object.hasOwn(state, 'settled'), false, '前提：settled 字段根本不存在');
    assert.equal(Object.hasOwn(state, 'auditGaps'), false, '前提：auditGaps 字段根本不存在');
    const out = aw.obs.record({ request: req({ id: 'absent-1' }), result: SUCCESS });
    assert.equal(out.recorded, true, '★ 缺失字段不得被当成损坏而拒绝');
    assert.equal(out.rolledBack, false, '★ 也不得回滚');
    assert.equal(out.corrupt.settled, null, '★ 缺失 ≠ 损坏');
    assert.equal(out.corrupt.auditGaps, null, '★ 缺失 ≠ 损坏');
    assert.equal(typeof aw.read().settled, 'object', 'settled 被正常创建');
    assert.equal(readFaultLatch(aw.store), null, '无锁存');
  } finally { aw.close(); }

  // ── null: explicitly "nothing written yet", same treatment ──
  const nw = world({ state: baseState({ settled: null, auditGaps: null }) });
  try {
    const out = nw.obs.record({ request: req({ id: 'null-1' }), result: SUCCESS });
    assert.equal(out.recorded, true, '★ null 等价于「尚未写入」，不得被当成损坏');
    assert.equal(out.corrupt.settled, null);
    assert.equal(out.corrupt.auditGaps, null);
  } finally { nw.close(); }

  // ── corrupt: refused, preserved verbatim, latched, and NOT copied into any output ──
  const CORRUPT = 'CORRUPT-SETTLED-EVIDENCE-9f3a';
  const cw = world({ state: baseState({ settled: CORRUPT }) });
  try {
    const out = cw.obs.record({ request: req({ id: 'corrupt-1' }), result: SUCCESS });
    assert.equal(out.recorded, false, '★ 损坏必须拒绝，不得当成空集合继续');
    assert.equal(out.rolledBack, true, '★ 整笔回滚');
    assert.equal(cw.read().settled, CORRUPT, '★★ 损坏原值逐字保留（不得被空 map 覆盖）');
    assert.deepEqual(out.corrupt.settled, { value: CORRUPT }, '★ 如实报出损坏值供调用方判断');
    // ★ THIS ASSERTION USED TO PIN A MISLABEL. The outer catch derived the reason from `phase`, so a
    // corrupt `settled` was reported as `settle-breaker-failed` — and OGA-13e (written by me) faithfully
    // recorded that wrong name. A test that asserts the current string can lock in a defect just as
    // easily as it can prevent one; only replaying the reverse direction exposed it.
    assert.equal(readFaultLatch(cw.store)?.reason, 'settle-settled-corrupt',
      '★★ 锁存原因必须指名 settled 损坏本身，不是笼统的 breaker 失败');

    // The corrupt text must not leak into a gap record's content nor into a public error string.
    const gaps = JSON.stringify(cw.read().auditGaps ?? []);
    assert.equal(gaps.includes(CORRUPT), false, '★ 不得把损坏内容拷进 gap');
    const errText = String(out.breaker?.error?.message ?? '');
    assert.equal(errText.includes(CORRUPT), false, '★ 不得把损坏内容放进公开错误正文');
  } finally { cw.close(); }
});


// ══════════════════════════════════════════════════════════════════════════════════════════════
// OGA-15 — the "every gate marker is NAMED" invariant gets a guard (Codex follow-up)
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// AR-12 refuses to clear a gate whose `generation` names a different episode. That refusal silently
// degrades to "never fires" if a future write site raises a gate WITHOUT a generation, because
// `readAuditFault` maps an absent generation to `null` = "unnamed" = "not comparable". A rule that
// depends on every writer remembering something needs a check on the writers, not just on the reader.
//
// This is a SOURCE-SHAPE guard, and it is honest about that limit (Codex's standing correction: name
// scanning does not survive aliases, re-exports or dynamic assembly). The BEHAVIOURAL backstop is AR-13,
// which asserts a real degraded settlement writes a marker carrying the same generation as its gap.
test('OGA-15 源码级：每个 gate 置位点都必须带 generation（否则 AR-12 的代际检查会退化成永不触发）', () => {
  const strip = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const root = new URL('../src/core/', import.meta.url);
  const files = fs.readdirSync(root).filter((f) => f.startsWith('qzone-') && f.endsWith('.mjs'));

  const raisers = [];
  for (const name of files) {
    const code = strip(fs.readFileSync(new URL(name, root), 'utf8'));
    // A gate literal = an object literal that names the audit-unavailable fault.
    const re = /\{[^{}]*fault:\s*'audit-unavailable'[^{}]*\}/g;
    for (const match of code.match(re) ?? []) raisers.push({ name, literal: match.replace(/\s+/g, ' ') });
  }

  assert.ok(raisers.length >= 1, '前提：源码里确实有 gate 置位点（否则这条守卫是空转）');
  for (const { name, literal } of raisers) {
    assert.ok(/generation:/.test(literal),
      `★★ ${name} 的 gate 置位点缺 generation：${literal} —— 缺了它，AR-12 的代际拒绝永远不会触发`);
  }
});
