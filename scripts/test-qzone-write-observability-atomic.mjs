// G3 (t33): the breaker transition and the audit append must commit together or not at all.
//
// WHAT WAS WRONG (measured by t31, reproduced here)
// ------------------------------------------------
// `record()` used to run two independent `store.update` transactions:
//     ① breaker  → COMMIT     ② audit → COMMIT
// so a crash / failure between them left permanent, non-self-healing drift:
//     (b) breaker committed, audit failed   → writes advanced, no audit row  (missing evidence)
//     (c) breaker failed, audit committed   → audit row, writes NOT advanced  ← the dangerous one:
//         a missed count means "three consecutive real failures" can quietly fail to pause.
//
// The fix puts BOTH inside one `store.update`, breaker first, audit second. Because the audit body can
// throw (id conflict, malformed state, a validation error from `formatAuditRecord`), the SQLite
// transaction rolls BOTH halves back. Either both land, or neither does.
//
// The `auditStore` seam is KEPT on purpose: it is the only way to inject "the audit alone failed", and
// forcing atomicity there would delete that ability. It is therefore the explicit non-atomic path and
// every result says which contract it got (`atomic:true|false`).
//
// Every "nothing changed" assertion below is taken against a NON-ZERO baseline written by a real
// prior transaction, so a broken adapter cannot pass by doing nothing at all.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createWriteObservability } from '../src/core/qzone-write-observability-offline.mjs';
import { formatAuditRecord } from '../src/core/qzone-audit-offline.mjs';
import { readFaultLatch, clearFaultLatch } from '../src/core/qzone-write-path-offline.mjs';

const T0 = 1_800_000_000_000;
const TARGET = '9876543210';

function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-wobs-at-${label}-`));
  return {
    dir,
    dbPath: path.join(dir, 'state.db'),
    cleanup() {
      for (let i = 0; i < 20; i += 1) {
        try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
      }
    },
  };
}

const baseState = (over = {}) => ({
  enabled: true, readAllowed: true, writeAllowed: true,
  accessPaused: false, writePaused: false,
  reads: 0, writes: 0, audit: [],
  ...over,
});

function world({ state = baseState() } = {}) {
  const t = tempDb('w');
  const store = openOfflineStore(t.dbPath, state);
  const obs = createWriteObservability({ store, clock: () => T0 });
  return {
    t, store, obs,
    read: () => store.read(),
    close() { try { store.close(); } catch {} t.cleanup(); },
  };
}

const req = (over = {}) => ({
  id: 'w-1', action: 'publish', target: TARGET, postId: 'p-1', source: 'qq', content: 'hello', ...over,
});

const SUCCESS = Object.freeze({ ok: true, stage: 'transport', outcome: 'success', quotaConsumed: true, transportCalled: true });
const FAILED = Object.freeze({ ok: true, stage: 'transport', outcome: 'failed', quotaConsumed: true, transportCalled: true });

// ── 1. the happy path, with the contract label ─────────────────────────────────────
test('AT-1 正常：writes +1、audit +1，且返回 atomic:true（默认路径）', () => {
  const w = world();
  try {
    assert.equal(w.read().writes, 0);
    assert.equal(w.read().audit.length, 0);

    const out = w.obs.record({ request: req(), result: FAILED });
    assert.equal(out.atomic, true, '不传 auditStore ⇒ 原子路径');
    assert.equal(out.recorded, true);
    assert.equal(out.breaker.applied, true);
    assert.equal(out.audit.appended, true);

    assert.equal(w.read().writes, 1, 'writes 前进 1');
    assert.equal(w.read().audit.length, 1, '审计 +1');
  } finally { w.close(); }
});

// ── 2. crash window: both halves roll back together ────────────────────────────────
test('AT-2 崩溃窗口闭合：update 内抛错 ⇒ writes 与 audit.length 同时回到原值', () => {
  const t = tempDb('crash');
  const real = openOfflineStore(t.dbPath, baseState({ writes: 2, audit: [] }));
  try {
    let crash = false;
    // Throws INSTEAD of committing. Since both halves now live in this one call, neither is written.
    // SPREAD, not a fresh object: '{ ...real }' keeps the handle's own 'authority' property, so this
    // wrapper IS the same send authority as the database it wraps. A closure over 'real' would be
    // refused at construction and, if it could be forced, would latch a fault the real handle never
    // sees (Codex CODEX-TEST-SEAM-CLOSE-20261114 §A).
    const store = {
      ...real,
      update(fn) {
        if (crash) throw new Error('process died before commit');
        return real.update(fn);
      },
    };
    const obs = createWriteObservability({ store, clock: () => T0 });

    assert.equal(real.read().writes, 2, '前提：writes 基线是 2，不是 0');

    crash = true;
    const out = obs.record({ request: req(), result: FAILED });
    assert.equal(out.atomic, true);
    assert.equal(out.rolledBack, true, '必须明确告知事务已回滚');
    assert.equal(out.recorded, false);
    assert.equal(real.read().writes, 2, 'writes 不得前进（旧行为会变成 3）');
    assert.equal(real.read().audit.length, 0, '审计也不得新增（旧行为在这里也是 0，但 writes 已经脏了）');

    // Positive control: with the crash removed the SAME call must write both halves, so the
    // "unchanged" above is attributable to the rollback and not to a store that cannot write.
    crash = false;
    const ok = obs.record({ request: req(), result: FAILED });
    assert.equal(ok.recorded, true, '对照：不崩溃时必须能落盘');
    assert.equal(real.read().writes, 3, '对照：writes 前进 1');
    assert.equal(real.read().audit.length, 1, '对照：审计 +1');
  } finally { try { real.close(); } catch {} t.cleanup(); }
});

// ── 3. reverse drift: an audit-side throw must also undo the breaker ───────────────
test('AT-3 反向漂移闭合：审计侧抛错（id 冲突）⇒ 熔断也不生效', () => {
  const t = tempDb('reversedrift');
  const real = openOfflineStore(t.dbPath, baseState({ writes: 2 }));
  try {
    const obs = createWriteObservability({ store: real, clock: () => T0 });

    // Seed one audit row with a given content.
    const first = obs.record({ request: req({ id: 'seed', content: 'first' }), result: SUCCESS });
    assert.equal(first.recorded, true, '前提：第一次落盘成功');
    const writesAfterSeed = real.read().writes;   // SUCCESS reset writes to 0
    assert.equal(writesAfterSeed, 0, '前提：success 把 writes 归零');
    assert.equal(real.read().audit.length, 1);

    // Force a failure first so the breaker WOULD move, then make the audit half throw with an id
    // conflict (same id, different content). The two halves are in one transaction now, so the
    // breaker increment must be undone.
    // Put the baseline back to a non-zero value so a successful increment is observable.
    real.update((s) => ({ ...s, writes: 2 }));
    const conflict = obs.record({ request: req({ id: 'seed', content: 'SECOND-DIFFERENT' }), result: FAILED });
    assert.equal(conflict.atomic, true);
    assert.equal(conflict.rolledBack, true);
    assert.equal(conflict.audit.failed, true, '失败应归到审计那一半');
    assert.match(conflict.audit.error.message, /conflicting audit id/);
    assert.equal(conflict.breaker.applied, false, '熔断那次推进已被回滚');
    assert.equal(real.read().writes, 2, '★ writes 必须仍是 2（旧行为会变成 3 —— 这就是反向漂移）');
    assert.equal(real.read().audit.length, 1, '审计行数没变，也没有被覆盖');
  } finally { try { real.close(); } catch {} t.cleanup(); }
});

// ── 4. the explicit non-atomic path ───────────────────────────────────────────────
test('AT-4 非原子路径（注入 auditStore）：atomic:false，且熔断推进、审计失败时 writes 仍 +1', () => {
  const t = tempDb('nonatomic');
  const real = openOfflineStore(t.dbPath, baseState({ writes: 2 }));
  try {
    let failAudit = true;
    const auditStore = {
      read: () => real.read(),
      update(fn) { if (failAudit) throw new Error('audit disk full'); return real.update(fn); },
    };
    const obs = createWriteObservability({ store: real, auditStore, clock: () => T0 });

    const out = obs.record({ request: req(), result: FAILED });
    assert.equal(out.atomic, false, '注入 auditStore ⇒ 必须自报非原子');
    assert.equal(out.audit.failed, true);
    assert.match(out.audit.error.message, /audit disk full/);
    assert.equal(out.breaker.applied, true, '旧行为保留：熔断照常推进');
    assert.equal(real.read().writes, 3, 'writes 2 → 3 已落盘');
    assert.equal(real.read().audit.length, 0, '审计确实没写进去');
  } finally { try { real.close(); } catch {} t.cleanup(); }
});

// ── 5. id conflict semantics survive the inlining ─────────────────────────────────
test('AT-5 保留 id 冲突语义：同 id 不同内容抛 conflicting audit id 并整笔回滚', () => {
  const w = world();
  try {
    assert.equal(w.obs.record({ request: req({ id: 'dup', content: 'aaa' }), result: SUCCESS }).recorded, true);
    const before = w.read();
    assert.equal(before.audit.length, 1, '前提：一行已存在');

    // Same id, DIFFERENT content -> the inlined append must refuse rather than silently overwrite.
    const out = w.obs.record({ request: req({ id: 'dup', content: 'bbb' }), result: FAILED });
    assert.equal(out.rolledBack, true);
    assert.equal(out.audit.failed, true);
    assert.match(out.audit.error.message, /conflicting audit id/);

    const after = w.read();
    assert.equal(after.audit.length, 1, '没有新增行');
    assert.equal(after.audit[0].record.content, 'aaa', '原行内容没有被覆盖');
    assert.equal(after.writes, before.writes, '熔断也没有动（整笔回滚）');
  } finally { w.close(); }
});

// ── 6. idempotency: same id + same content = no append, no error ──────────────────
test('AT-6 幂等：同 id 同内容 → 不追加、不报错（事务正常提交）', () => {
  const w = world();
  try {
    const r1 = w.obs.record({ request: req({ id: 'same', content: 'same' }), result: SUCCESS });
    assert.equal(r1.audit.appended, true);
    assert.equal(w.read().audit.length, 1);
    const writesAfter1 = w.read().writes;

    const r2 = w.obs.record({ request: req({ id: 'same', content: 'same' }), result: SUCCESS });
    assert.equal(r2.rolledBack, false, '同内容不算冲突，事务应当正常提交');
    assert.equal(r2.audit.appended, false, '没有追加第二行');
    assert.equal(w.read().audit.length, 1, '仍然只有一行');
    // The breaker half still runs (this adapter has no settlement-level idempotency key — a separate,
    // already-documented property). What matters here is that the audit half did not throw.
    assert.equal(w.read().writes, writesAfter1, 'success 两次都把 writes 归零，值不变');
  } finally { w.close(); }
});

// ── 7. formatAuditRecord is still the authority for validation + redaction ────────
test('AT-7 原子路径仍走 formatAuditRecord：脱敏不变，且非法字段整笔回滚', () => {
  const w = world();
  try {
    // (a) redaction still happens inside the transaction.
    const out = w.obs.record({ request: req({ content: 'cookie: p_skey=abc123SECRET' }), result: SUCCESS });
    assert.equal(out.audit.redacted, true, '落盘行必须是 redacted');
    const row = w.read().audit[0];
    assert.equal(row.record.content, '[REDACTED]');
    assert.equal(JSON.stringify(w.read()).includes('abc123SECRET'), false, '原文不得落盘');

    // (b) a record `formatAuditRecord` rejects must roll the whole thing back — including the breaker.
    const w2 = world();
    const before = w2.read();
    let threw = null;
    const badReq = { id: 'bad', action: 'publish', target: 'not-a-uin', postId: 'p', source: 'qq', content: 'x' };
    try { w2.obs.record({ request: badReq, result: FAILED }); } catch (error) { threw = error; }
    // The adapter reports rather than throws; either way nothing may be persisted.
    assert.equal(w2.read().writes, before.writes, '非法审计输入 ⇒ 熔断不得落盘');
    assert.equal(w2.read().audit.length, 0, '非法审计输入 ⇒ 不得留下半行');
    void threw;
    w2.close();
  } finally { w.close(); }
});

// ── 8. ordering inside the one transaction ────────────────────────────────────────
test('AT-8 顺序仍在：同一个 update 内部先熔断、后审计', () => {
  const t = tempDb('order');
  const real = openOfflineStore(t.dbPath, baseState({ writes: 2 }));
  try {
    const seen = [];
    // Observe the callback's own behaviour: `state` handed in has the PRE-breaker, PRE-audit shape.
    const store = {
      ...real,
      update(fn) {
        return real.update((state) => {
          const beforeWrites = state.writes;
          const beforeAudit = state.audit.length;
          const next = fn(state);
          // After the single callback: BOTH must have changed, and only ONE update happened.
          seen.push({
            beforeWrites, beforeAudit,
            afterWrites: next.writes, afterAudit: next.audit.length,
            updates: 1,
          });
          return next;
        });
      },
    };
    const obs = createWriteObservability({ store, clock: () => T0 });
    const out = obs.record({ request: req(), result: FAILED });
    assert.equal(out.atomic, true);
    assert.equal(seen.length, 1, '★ 恰好一次 store.update（旧实现是两次）');
    assert.equal(seen[0].beforeWrites, 2);
    assert.equal(seen[0].afterWrites, 3, '熔断在同一个回调里推进了');
    assert.equal(seen[0].beforeAudit, 0);
    assert.equal(seen[0].afterAudit, 1, '审计也在同一个回调里追加了');
  } finally { try { real.close(); } catch {} t.cleanup(); }
});

// ── 9. no-op results still take exactly one transaction ───────────────────────────
test('AT-9 unknown（不推进熔断）仍只开一个事务，且审计照写', () => {
  const w = world({ state: baseState({ writes: 2 }) });
  try {
    assert.equal(w.read().writes, 2, '前提：writes 基线 2');
    const UNKNOWN = { ok: true, stage: 'transport', outcome: 'unknown', quotaConsumed: true, transportCalled: true };
    const out = w.obs.record({ request: req(), result: UNKNOWN });
    assert.equal(out.atomic, true);
    assert.equal(out.breaker.applied, false);
    assert.equal(out.breaker.skippedReason, 'not-a-real-failure');
    assert.equal(w.read().writes, 2, 'unknown 不得改 writes');
    assert.equal(w.read().audit.length, 1, '但审计必须写进去');
  } finally { w.close(); }
});

// ── 10. cross-restart: what was committed is what survives ────────────────────────
test('AT-10 跨重启：原子提交的两半一起存活，回滚的两半一起消失', () => {
  const t = tempDb('restart');
  const real = openOfflineStore(t.dbPath, baseState({ writes: 2 }));
  try {
    const good = createWriteObservability({ store: real, clock: () => T0 });
    assert.equal(good.record({ request: req({ id: 'kept' }), result: FAILED }).recorded, true);
    assert.equal(real.read().writes, 3);
    assert.equal(real.read().audit.length, 1);

    // Now simulate a crash on the NEXT one.
    let crash = false;
    const flaky = {
      ...real,
      update(fn) { if (crash) throw new Error('boom'); return real.update(fn); },
    };
    const obs2 = createWriteObservability({ store: flaky, clock: () => T0 });
    crash = true;
    const out = obs2.record({ request: req({ id: 'lost' }), result: FAILED });
    assert.equal(out.rolledBack, true);

    const reopened = openOfflineStore(t.dbPath, baseState());
    try {
      const after = reopened.read();
      assert.equal(after.writes, 3, '重启后 writes 仍是 3（成功那笔在，崩溃那笔不在）');
      assert.equal(after.audit.length, 1, '重启后审计仍只有 1 行');
      assert.equal(after.audit[0].id, 'kept', '存活的是成功那一条');
    } finally { reopened.close(); }
  } finally { try { real.close(); } catch {} t.cleanup(); }
});

// ── 11. G1: settlement idempotency key (persisted, cross-restart) ────────────────
test('AT-11 G1 幂等键：同一 (id+内容) 重复 record 只计一次，且键落在 store 里跨重启有效', () => {
  const t = tempDb('idempotent');
  let real = openOfflineStore(t.dbPath, baseState());
  try {
    const obs = createWriteObservability({ store: real, clock: () => T0 });
    const request = req({ id: 'settle-1' });
    assert.equal(real.read().writes, 0, '前提：writes 基线 0');

    const first = obs.record({ request, result: FAILED });
    assert.equal(first.alreadySettled, false, '第一次是真正的结算');
    assert.equal(first.recorded, true);
    assert.equal(real.read().writes, 1);
    assert.equal(real.read().audit.length, 1);

    const second = obs.record({ request, result: FAILED });
    assert.equal(second.alreadySettled, true, '★ 同一结算身份第二次必须被挡');
    assert.equal(second.recorded, false);
    assert.equal(second.breaker.applied, false, '熔断不得再推进');
    assert.equal(real.read().writes, 1, '★ writes 仍为 1（不是 2）');
    assert.equal(real.read().audit.length, 1, '审计也不追加第二行');

    // The key is IN THE STORE, so it survives a restart.
    const settledKeys = Object.keys(real.read().settled);
    assert.equal(settledKeys.length, 1, '一个结算身份一条记录');
    assert.match(settledKeys[0], /^settle-1#[0-9a-f]{32}$/, '键是 id + 内容摘要');

    // Capture what is actually on disk before reopening: the store persists, so the reopened state
    // starts from these values (NOT from `baseState()` — that is only the seed for a fresh file).
    const persistedWrites = real.read().writes;
    const persistedAudit = real.read().audit.length;
    real.close();
    real = openOfflineStore(t.dbPath, baseState());
    assert.equal(real.read().writes, persistedWrites, '前提：重启后状态从磁盘恢复');
    const obs2 = createWriteObservability({ store: real, clock: () => T0 });
    const afterRestart = obs2.record({ request, result: FAILED });
    assert.equal(afterRestart.alreadySettled, true, '★ 跨重启后同一个重复仍被挡');
    assert.equal(real.read().writes, persistedWrites, '被挡住 ⇒ writes 不前进');
    assert.equal(real.read().audit.length, persistedAudit, '也没有新的审计行');
  } finally { try { real.close(); } catch {} t.cleanup(); }
});

test('AT-12 G1 不误伤：不同 id 照常结算，同 id 换内容走冲突而不是被当重复', () => {
  const w = world();
  try {
    const a = w.obs.record({ request: req({ id: 'a1' }), result: FAILED });
    assert.equal(a.alreadySettled, false);
    assert.equal(w.read().writes, 1);

    // Different id: the key differs, so this must settle normally.
    const b = w.obs.record({ request: req({ id: 'b1' }), result: FAILED });
    assert.equal(b.alreadySettled, false, '不同 id 不得被幂等键误挡');
    assert.equal(w.read().writes, 2, '第二个失败照常计数');

    // Same id, DIFFERENT content: NOT a repeat — it is a contradiction, and the audit half must see
    // it and report it rather than being swallowed as "already settled".
    const c = w.obs.record({ request: req({ id: 'a1', content: 'other' }), result: FAILED });
    assert.equal(c.alreadySettled, false, '同 id 不同内容不是重复结算');
    assert.equal(c.audit.conflict.reason, 'conflicting-audit-id');
    assert.equal(w.read().writes, 2, '冲突导致整笔回滚，writes 不变');
  } finally { w.close(); }
});

// ── 12. G2: the audit-id collision is STRUCTURED, not just failed:true ───────────
test('AT-13 G2 冲突可观察：返回体带 reason + existing/incoming 摘要，且状态零改动', () => {
  const w = world();
  try {
    assert.equal(w.obs.record({ request: req({ id: 'cid', content: 'original' }), result: SUCCESS }).recorded, true);
    const before = w.read();
    assert.equal(before.audit.length, 1, '前提：已有一行');

    const out = w.obs.record({ request: req({ id: 'cid', content: 'DIFFERENT' }), result: FAILED });
    assert.equal(out.rolledBack, true);
    assert.equal(out.audit.failed, true);

    // The distinction G2 is about: a COLLISION is diagnosable, a broken store is not this.
    assert.ok(out.audit.conflict, '★ 必须带结构化 conflict');
    assert.equal(out.audit.conflict.reason, 'conflicting-audit-id');
    assert.equal(out.audit.conflict.existing.content, 'original', '已有行的内容摘要');
    assert.equal(out.audit.conflict.incoming.content, 'DIFFERENT', '本次要写的内容摘要');
    assert.equal(out.audit.conflict.existing.result, 'success');
    assert.equal(out.audit.conflict.incoming.result, 'failure');
    assert.equal(out.audit.error.message, 'conflicting audit id', '底层错误仍如实透出');

    const after = w.read();
    assert.equal(after.audit.length, 1, '没有新增行');
    assert.equal(after.audit[0].record.content, 'original', '原行未被覆盖');
    assert.equal(after.writes, before.writes, '熔断也没有动');
  } finally { w.close(); }
});

test('AT-14 G2 不误报：存储类错误仍然只是 error，不伪装成 conflict', () => {
  const t = tempDb('notconflict');
  const real = openOfflineStore(t.dbPath, baseState());
  try {
    let breakStore = false;
    const store = {
      ...real,
      update(fn) {
        if (breakStore) throw new Error('disk full');
        return real.update(fn);
      },
    };
    const obs = createWriteObservability({ store, clock: () => T0 });
    breakStore = true;
    const out = obs.record({ request: req(), result: FAILED });
    // A store fault kills the ONE transaction, so the module cannot tell which half it "belongs" to;
    // it attributes it by the phase that was executing (breaker). What matters for G2 is the
    // DISTINCTION: an infrastructure failure must never be dressed up as an id collision.
    assert.equal(out.breaker.failed, true, '整笔事务失败被如实上报');
    assert.equal(out.breaker.error.message, 'disk full');
    assert.equal(out.audit.conflict, undefined, '★ 存储故障不得被报成 id 冲突（那是两种不同的处置）');
    assert.equal(out.audit.failed, false, '不是审计侧的错误');
  } finally { try { real.close(); } catch {} t.cleanup(); }
});

test('AT-15 幂等键与冲突判定互不干扰：同内容重复不会误报 conflict', () => {
  const w = world();
  try {
    const request = req({ id: 'same-content', content: 'same' });
    assert.equal(w.obs.record({ request, result: SUCCESS }).audit.conflict, undefined, '第一次没有冲突');
    const second = w.obs.record({ request, result: SUCCESS });
    assert.equal(second.alreadySettled, true);
    assert.equal(second.audit.conflict, undefined, '★ 重复被幂等键挡下，不该走到冲突分支');
    assert.equal(second.audit.failed, false);
  } finally { w.close(); }
});

// ════════════════════════════════════════════════════════════════════════════════════════
// AT-16 守卫：settled 幂等键依赖 formatAuditRecord 的**字段插入顺序**
// ════════════════════════════════════════════════════════════════════════════════════════
//
// `settleKeyFor()` 算的是 `sha256(JSON.stringify(formatAuditRecord(...)))`，而
// `JSON.stringify` 序列化对象时用的是**属性插入顺序**。所以 settled 键的稳定性，
// 隐含地依赖 `formatAuditRecord` 按固定顺序构造那个对象。
//
// 这不是「代码风格」问题：一旦有人调整 `formatAuditRecord` 的字段顺序，
// **所有已经落盘的历史 settled 键会同时失效**（旧键再也匹配不上任何新结算），
// 于是跨重启的幂等保护整体归零 —— G1 会在不报错的情况下退回未修复状态。
//
// 这条守卫就是为了让那种改动**立刻红**，并且让看到红的人先读后果再动手。

test('AT-16 守卫：settled 幂等键依赖 formatAuditRecord 的字段顺序（改动会静默破坏 G1）', () => {
  // 用一组「每个字段都出现」的参数：任何字段被删、被改名或被挪位都会改变 keys 序列。
  const formatted = formatAuditRecord({
    time: T0,
    source: 'qq',
    action: 'publish',
    target: TARGET,
    postId: 'p-1',
    commentId: null,
    content: 'hello',
    result: 'success',
    reason: '',
    quota: null,
  });

  const expectedOrder = [
    'time', 'source', 'action', 'target', 'postId', 'commentId',
    'content', 'redacted', 'result', 'reason', 'quota',
  ];

  // ★ 失败消息就是这份守卫的说明书：先讲后果，再讲怎么办。
  //   故意不用 "字段不匹配" 这种措辞 —— 那会让人以为改一下测试就行。
  assert.deepEqual(
    Object.keys(formatted),
    expectedOrder,
    '【不要直接改这条断言来让它变绿】\n'
    + 'settled 幂等键 = sha256(JSON.stringify(formatAuditRecord(...)))，而 JSON.stringify 依赖属性的\n'
    + '插入顺序。改动 formatAuditRecord 的字段顺序会让**所有历史 settled 键立刻失效**：旧键再也匹配\n'
    + '不上新结算，跨重启的 G1 幂等保护整体归零，而且不报错、不告警 —— 看起来一切正常，实际已经退回\n'
    + '未修复状态（同一结算身份会被第二次计数，重开 G1 关掉的重复计数洞）。\n'
    + '若确实必须改动字段（增删改名或换序），必须同时提供一个存量键的迁移/重建方案，并在同一个变更里\n'
    + '补上验证；否则请把字段顺序改回上面 expectedOrder。',
  );

  // 附带的直接实证：顺序真的会改变序列化结果，因此真的会改变 settled 键。
  // 这条不依赖任何模块内部实现，是纯语言语义的证明。
  const sameDataDifferentOrder = {
    a: JSON.stringify({ time: 1, source: 'qq' }),
    b: JSON.stringify({ source: 'qq', time: 1 }),
  };
  assert.notEqual(sameDataDifferentOrder.a, sameDataDifferentOrder.b,
    '字段顺序影响 JSON.stringify 的结果，因此同样会影响 settled 的 sha256 键');

  // 把实证推到 digest 层面：同一份数据、两种顺序 → 两个不同的键摘要。
  const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
  assert.notEqual(
    digestOf({ time: 1, source: 'qq' }),
    digestOf({ source: 'qq', time: 1 }),
    '★ 顺序变了，settled 键摘要也真的变了（这就是「历史键全部失效」的机制）',
  );
  // 正控：同一顺序同一数据必须得到同一个键，否则上面那条 notEqual 可能只是「每次都不同」。
  assert.equal(
    digestOf({ time: 1, source: 'qq' }),
    digestOf({ time: 1, source: 'qq' }),
    '正控：顺序与数据都相同时，键必须稳定（否则上面的 notEqual 不构成证据）',
  );

  // 端到端把它接回 settled：真实结算一次，落盘键必须与「按当前顺序算出的摘要」一致。
  const w = world();
  try {
    const request = req({ id: 'order-guard' });
    const out = w.obs.record({ request, result: SUCCESS });
    assert.equal(out.recorded, true, '前提：这一次是真正的结算');

    const storedKeys = Object.keys(w.read().settled);
    assert.equal(storedKeys.length, 1, '前提：只落了一个 settled 键');
    const recordedRow = w.read().audit.find((entry) => entry.id === request.id);
    assert.ok(recordedRow, '前提：审计行已写入');

    // 用落盘的审计记录重算一次键：这正是模块内部的做法，而且刻意走**读回的对象**
    // （经过 SQLite 的 JSON 往返），证明顺序在持久化之后仍然保持。
    //
    // t68 / M7 改了两件事，这条断言随之更新（不是放宽，是跟着键的定义走）：
    //   ① `settled` 键现在**排除 `time`**（跨 clock 重试必须命中同一条结算，实测修复见 OGA-6）；
    //   ② 重算时必须按同样的排除规则算，否则算的是旧定义的键。
    // 仍然钉住原本的要害：键必须完全由**持久化后的审计记录**决定 —— 若字段顺序在 JSON 往返
    // 或格式化过程中被动过，重算结果就不再等于落盘键。
    const stablePart = {};
    for (const key of Object.keys(recordedRow.record)) {
      if (key !== 'time') stablePart[key] = recordedRow.record[key];
    }
    const recomputed = `${request.id}#${digestOf(stablePart)}`;
    assert.equal(storedKeys[0], recomputed,
      '落盘的 settled 键必须等于「对持久化后的审计记录重新算一次摘要」——'
      + '若这条红，说明字段顺序在 JSON 往返或格式化过程中被动过');
  } finally { w.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// AT-17 / AT-18 — the NON-ATOMIC path has to honour the same two rules as the atomic one
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// D3 (Codex, this round): a corrupt `settled` must never be SPREAD AWAY, on EITHER path. The atomic
// path threw at (0b); this branch still did `{ ...(settledMap ?? {}), [key]: … }`, so the evidence was
// replaced by a plausible-looking map and the caller was told nothing was corrupt.
//
// MEASURED BEFORE THE FIX (real stores, injected auditStore):
//   {atomic:false, recorded:true, corrupt:{settled:null}, settledAfter:'{"…-1#09a7…":{…}}'}
// i.e. the corrupt value was GONE and the return said everything was fine.
test('AT-17 非原子路径：settled 损坏不得被展开覆盖，必须拒绝并锁存（G-4 同规则）', () => {
  const CORRUPT = 'CORRUPT-SETTLED-EVIDENCE-AT17';
  const t0 = tempDb('na-corrupt');
  const real = openOfflineStore(t0.dbPath, baseState({ settled: CORRUPT }));
  try {
    const auditStore = { read: () => real.read(), update: (fn) => real.update(fn) };
    const obs = createWriteObservability({ store: real, auditStore, clock: () => T0 });

    const out = obs.record({ request: req({ id: 'na-corrupt-1' }), result: FAILED });

    assert.equal(out.atomic, false, '前提：注入 auditStore ⇒ 非原子路径');
    assert.equal(out.recorded, false, '★★ 不得声称已结算（幂等记录不可信就不能结算）');
    assert.equal(out.breaker.applied, false, '★★ 熔断也不得推进');
    assert.deepEqual(out.corrupt.settled, { value: CORRUPT }, '★★ 必须如实报出损坏值');
    assert.equal(real.read().settled, CORRUPT, '★★ 原值逐字保留，不得被 map 覆盖');
    assert.equal(real.read().writes, 0, 'writes 未推进');
    // AT-17 的锁存断言（我自己写错过一次：初版写成"前提：尚未锁存"，与本次修复正好相反）。
    // D3 要求「无法安全降级时回滚、保留原值、锁存」，所以这里必须断言锁存 **在**。
    const latch = readFaultLatch(real);
    assert.ok(latch, '★★ 必须锁存该权威（保留证据之后还要停止继续发送）');
    assert.equal(latch.reason, 'settle-settled-corrupt', '★ 原因必须指名是 settled 损坏');
  } finally {
    clearFaultLatch(real);
    try { real.close(); } catch { /* closed */ }
    t0.cleanup();
  }
});

// AT-18 / D2: a REAL storage failure on the non-atomic path must stop new sending for this authority.
//
// Codex D2 verbatim: "非原子分支实际存储失败同样要停止该权威新资格，保留atomic:false".
// Reporting `audit.failed:true` and then letting the process keep sending is the fail-open shape the
// atomic path's M7 fix removed — the operator sees a red receipt while the writes continue.
//
// Deliberately NOT a formatter error or an id conflict: those are caller bugs, and latching a healthy
// authority over bad input is the opposite failure. Only STORAGE faults latch.
test('AT-18 非原子路径：审计存储真失败必须锁存该权威（atomic:false 保留），而非只是回执变红', () => {
  const t0 = tempDb('na-latch');
  const real = openOfflineStore(t0.dbPath, baseState({ writes: 2 }));
  try {
    const brokenAudit = {
      read: () => real.read(),
      update() { throw new TypeError('audit disk full'); },
    };
    const obs = createWriteObservability({ store: real, auditStore: brokenAudit, clock: () => T0 });

    const out = obs.record({ request: req({ id: 'na-latch-1' }), result: FAILED });

    assert.equal(out.atomic, false, '★★ 仍必须自报非原子（不因为加了锁存就改性质）');
    assert.equal(out.audit.failed, true, '审计失败如实上报');
    assert.equal(out.breaker.applied, true, '旧行为保留：熔断照常推进');
    assert.equal(real.read().writes, 3, 'writes 2 → 3 已落盘');

    const latch = readFaultLatch(real);
    assert.ok(latch, '★★ 存储失败必须锁存该权威（否则进程继续发送）');
    assert.equal(latch.reason, 'settle-audit-storage-failed', '★ 原因必须指名是审计存储，不是笼统故障');
  } finally {
    clearFaultLatch(real);
    try { real.close(); } catch { /* closed */ }
    t0.cleanup();
  }
});


// AT-19 / D2's exact wording is "实际存储失败" — a REAL STORAGE failure, not any error.
//
// The distinction is load-bearing in BOTH directions:
//   · under-latching  = a broken disk keeps sending (the fail-open shape AT-18 closes);
//   · over-latching   = a CALLER BUG locks a healthy authority out of every future write.

// AT-19 边界：caller bug（id 冲突 / formatter 报错）绝不得锁存健康权威 —— 只有存储故障才锁
test('AT-19 边界：id 冲突与 formatter 报错不得锁存（只锁真存储故障）', () => {
  // (a) id conflict on the non-atomic path
  {
    const t0 = tempDb('na-conflict');
    const real = openOfflineStore(t0.dbPath, baseState());
    try {
      const auditStore = { read: () => real.read(), update: (fn) => real.update(fn) };
      const obs = createWriteObservability({ store: real, auditStore, clock: () => T0 });
      obs.record({ request: req({ id: 'dup', content: 'aaa' }), result: SUCCESS });
      const out = obs.record({ request: req({ id: 'dup', content: 'bbb' }), result: SUCCESS });

      assert.equal(out.audit.failed, true, '冲突要如实上报');
      assert.ok(out.audit.conflict, '★ 而且必须是 conflict 形状，不是笼统 error');
      assert.equal(readFaultLatch(real), null, '★★ 同 id 换内容是 CALLER BUG，不得锁存健康权威');
    } finally {
      clearFaultLatch(real);
      try { real.close(); } catch { /* closed */ }
      t0.cleanup();
    }
  }

  // (b) formatter rejection on the non-atomic path
  {
    const t0 = tempDb('na-formatter');
    const real = openOfflineStore(t0.dbPath, baseState());
    try {
      const auditStore = { read: () => real.read(), update: (fn) => real.update(fn) };
      const obs = createWriteObservability({ store: real, auditStore, clock: () => T0 });
      const out = obs.record({ request: req({ id: 'fmt-1', action: 'not-a-real-action' }), result: SUCCESS });

      assert.equal(out.audit.failed, true, '非法记录要如实上报');
      assert.equal(readFaultLatch(real), null, '★★ formatter 报错也是 CALLER BUG，不得锁存');
    } finally {
      clearFaultLatch(real);
      try { real.close(); } catch { /* closed */ }
      t0.cleanup();
    }
  }
});


// AT-20 / AT-21 — the two gaps verifier t26 named: consequences that were never exercised.

// AT-20 非原子路径第三类后果：结算事务本身存储失败也要锁存
//
// AT-17 covers "settled corrupt", AT-18 covers "audit storage failed". The middle case — the SETTLEMENT
// transaction itself failing to store — had NO case at all, so `nonAtomicStorageFailed` could have been
// deleted without a single test noticing. That is the same shape as earlier rounds' "green because
// nothing ran" findings.
//
// Note which handle fails: the SETTLEMENT handle throws before running the callback, while the audit
// handle is healthy. That isolates the settlement half instead of re-testing the audit half.
test('AT-20 非原子路径：结算事务存储失败必须锁存该权威（settle-breaker-failed 分支）', () => {
  const t0 = tempDb('na-settlefail');
  const real = openOfflineStore(t0.dbPath, baseState({ writes: 2 }));
  try {
    let failSettle = true;
    const brokenStore = {
      ...real,
      update(fn) {
        if (failSettle) { failSettle = false; throw new Error('state disk full'); }
        return real.update(fn);
      },
    };
    const auditStore = { ...real, update: (fn) => real.update(fn) };
    const obs = createWriteObservability({ store: brokenStore, auditStore, clock: () => T0 });

    const out = obs.record({ request: req({ id: 'na-settle-1' }), result: FAILED });

    assert.equal(out.atomic, false, '★★ 仍自报非原子（加了锁存也不改性质）');
    assert.equal(out.breaker.failed, true, '★ 结算事务失败必须如实上报');
    assert.equal(real.read().writes, 2, '★ 结算没提交：writes 停在 2，不得凭空推进');

    const latch = readFaultLatch(real);
    assert.ok(latch, '★★ 结算存储失败必须锁存（否则进程继续发送）');
    assert.equal(latch.reason, 'settle-breaker-failed', '★ 原因必须指名是结算事务，不是审计');
  } finally {
    clearFaultLatch(real);
    try { real.close(); } catch { /* closed */ }
    t0.cleanup();
  }
});

// AT-21 判据类型化：冲突按 error.code 识别，改消息措辞不得把 caller bug 变成锁存理由
//
// verifier t26 low-1: the classification used to be a regex on the MESSAGE. Rewording that message inside
// the audit module would have reclassified a caller bug as a storage fault — and a storage fault LATCHES,
// so a wording change could lock every healthy authority out. This pins the discrimination to `code`,
// and pins that both the thrower and the consumer actually carry it.
test('AT-21 判据：冲突按 error.code 识别（不依赖消息措辞），且不得因此锁存', () => {
  const t0 = tempDb('na-typed');
  const real = openOfflineStore(t0.dbPath, baseState());
  try {
    const auditStore = { ...real, update: (fn) => real.update(fn) };
    const obs = createWriteObservability({ store: real, auditStore, clock: () => T0 });

    // Same id, different content -> the real conflict path, produced by the real append.
    obs.record({ request: req({ id: 'typed-1', content: 'aaa' }), result: SUCCESS });
    const out = obs.record({ request: req({ id: 'typed-1', content: 'bbb' }), result: SUCCESS });

    assert.equal(out.audit.failed, true, '冲突要如实上报');
    assert.ok(out.audit.conflict, '★★ 仍必须被识别为 conflict（不是笼统 error）');
    assert.equal(readFaultLatch(real), null, '★★ caller bug 不得锁存健康权威');

    // The discriminator must be the CODE, on BOTH sides.
    const throwerSrc = fs.readFileSync(new URL('../src/core/qzone-audit-offline.mjs', import.meta.url), 'utf8');
    assert.match(throwerSrc, /code = 'AUDIT_ID_CONFLICT'/,
      '★ 抛出方必须带类型化 code，否则判据仍依赖措辞');
    const consumerSrc = fs.readFileSync(new URL('../src/core/qzone-write-observability-offline.mjs', import.meta.url), 'utf8');
    assert.match(consumerSrc, /code === 'AUDIT_ID_CONFLICT'/,
      '★ 消费方必须按 code 判定');
  } finally {
    clearFaultLatch(real);
    try { real.close(); } catch { /* closed */ }
    t0.cleanup();
  }
});


// AT-22 原子路径的冲突判定也必须按 code（verifier t27：同一个攻击面还剩一半没关）
//
// The two branches draw OPPOSITE conclusions, which is why both need the typed discriminator:
//   · non-atomic: conflict -> do NOT latch      (lenient, AT-19 covers it)
//   · atomic    : conflict -> ROLL BACK         (strict,  this case)
// A reworded message would push the atomic case into `auditAttemptThrew`, i.e. DEGRADE — commit the
// breaker, record a gap, fault the gate — instead of rolling back. The strict path silently becomes
// lenient. That is the reverse of the non-atomic risk and it is not covered by AT-21.
test('AT-22 原子路径：冲突按 code 识别 ⇒ 整笔回滚（不得因措辞变化降级为 degrade）', () => {
  const t0 = tempDb('atomic-typed');
  const real = openOfflineStore(t0.dbPath, baseState({ writes: 2 }));
  try {
    const obs = createWriteObservability({ store: real, clock: () => T0 });
    // First record lands normally.
    const first = obs.record({ request: req({ id: 'atyped-1', content: 'aaa' }), result: SUCCESS });
    assert.equal(first.recorded, true, '前提：第一行已落');

    const before = real.read();
    // Same id, DIFFERENT content -> conflict on the ATOMIC path.
    const out = obs.record({ request: req({ id: 'atyped-1', content: 'bbb' }), result: FAILED });

    assert.equal(out.atomic, true, '前提：默认路径是原子');
    assert.equal(out.rolledBack, true, '★★ 冲突必须整笔回滚，不得走 degrade');
    assert.equal(out.degraded ?? false, false, '★★ 尤其不得自报降级成功');
    assert.equal(out.audit.failed, true);
    assert.ok(out.audit.conflict, '★ conflict 形状仍在');
    assert.equal(real.read().writes, before.writes, '★★ 熔断未推进（回滚）');
    assert.equal((real.read().auditGaps ?? []).length, 0, '★★ 不得凭空记一条 gap');
    assert.equal(real.read().writeGate ?? null, null, '★★ 不得置 gate');

    // And the discriminator must be the code here too.
    const consumerSrc = fs.readFileSync(new URL('../src/core/qzone-write-observability-offline.mjs', import.meta.url), 'utf8');
    assert.match(consumerSrc, /isAuditIdConflict\(auditError0\)/,
      '★ 原子路径必须用 isAuditIdConflict，而不是又一处消息正则');
  } finally {
    clearFaultLatch(real);
    try { real.close(); } catch { /* closed */ }
    t0.cleanup();
  }
});
