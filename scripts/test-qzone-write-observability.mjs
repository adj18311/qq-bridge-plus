// Offline observability for the write path: one audit row + at most one breaker transition per write.
//
// Drives the REAL adapter and the REAL reviewed modules (`formatAuditRecord`/`appendOfflineAudit`,
// `nextFailureState`) over a REAL temporary SQLite store. No network, no state/, no QQ.
//
// Two conventions keep the assertions honest:
//   · "the counter did not move" is always measured from a NON-ZERO baseline, so `0 === 0` can never
//     be mistaken for a passing check;
//   · every "nothing happened" claim is paired with a positive control in the same file, so a
//     completely broken adapter cannot pass by refusing/ignoring everything.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import {
  createWriteObservability,
  mapWriteResult,
  OBSERVED_RESULT,
} from '../src/core/qzone-write-observability-offline.mjs';

const T0 = 1_800_000_000_000;
const TARGET = '9876543210';

function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-wobs-${label}-`));
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

/** A store state with everything the breaker + audit need. */
const baseState = (over = {}) => ({
  enabled: true, readAllowed: true, writeAllowed: true,
  accessPaused: false, writePaused: false,
  reads: 0, writes: 0,
  audit: [],
  ...over,
});

function world({ state = baseState() } = {}) {
  const t = tempDb('w');
  const store = openOfflineStore(t.dbPath, state);
  let now = T0;
  const obs = createWriteObservability({ store, clock: () => now });
  return {
    t, store, obs,
    setNow: (v) => { now = v; },
    read: () => store.read(),
    auditRows: () => store.read().audit,
    close() { try { store.close(); } catch {} t.cleanup(); },
  };
}

const req = (over = {}) => ({
  id: 'w-1', action: 'publish', target: TARGET, postId: 'p-1', source: 'qq', content: 'hello', ...over,
});

/** Write-path result shapes, as the facade emits them. */
const RESULT = {
  success: { ok: true, stage: 'transport', outcome: 'success', quotaConsumed: true, transportCalled: true },
  failed: { ok: true, stage: 'transport', outcome: 'failed', quotaConsumed: true, transportCalled: true },
  unknown: { ok: true, stage: 'transport', outcome: 'unknown', reason: 'unknown-outcome', quotaConsumed: true, transportCalled: true },
  notSent: { ok: true, stage: 'transport', outcome: 'not-sent', quotaConsumed: true, transportCalled: true },
  deniedInterval: { ok: false, stage: 'reserve', reason: 'interval' },
  deniedLimit: { ok: false, stage: 'reserve', reason: 'limit' },
  deniedDupLike: { ok: false, stage: 'reserve', reason: 'duplicate_like' },
  pausedBeforeSend: { ok: false, stage: 'transport', reason: 'paused-before-send', quotaConsumed: true, transportCalled: false },
};

// ── 1. success: audit row + counter reset ──────────────────────────────────────────
test('OBS-1 成功写 → 审计一条 result:success，writes 计数归 0', async () => {
  const w = world({ state: baseState({ writes: 2 }) });   // non-zero baseline: a reset is observable
  try {
    assert.equal(w.read().writes, 2, '前提：writes 基线是 2，不是 0');
    const out = w.obs.record({ request: req(), result: RESULT.success });
    assert.equal(out.recorded, true);
    assert.equal(out.audit.appended, true);
    assert.equal(out.audit.failed, false);
    assert.equal(out.breaker.applied, true);
    assert.equal(out.breaker.writes, 0, 'success 必须把 writes 归 0（基线 2 → 0）');
    assert.equal(out.breaker.writePaused, false);

    const rows = w.auditRows();
    assert.equal(rows.length, 1, '恰好一条审计');
    assert.equal(rows[0].record.result, 'success');
    assert.equal(rows[0].record.action, 'publish');
    assert.equal(rows[0].record.target, TARGET);
    assert.equal(rows[0].record.time, T0);
    assert.equal(rows[0].record.redacted, false);
  } finally { w.close(); }
});

// ── 2. three consecutive real failures -> writePaused ────────────────────────────
test('OBS-2 连续 3 次真实 failure → writePaused（先推到 2 再触发第 3 次）', async () => {
  const w = world();
  try {
    const a = w.obs.record({ request: req({ id: 'f1' }), result: RESULT.failed });
    assert.equal(a.breaker.writes, 1);
    assert.equal(a.breaker.writePaused, false, '第 1 次失败不应立刻暂停');

    const b = w.obs.record({ request: req({ id: 'f2' }), result: RESULT.failed });
    assert.equal(b.breaker.writes, 2, '前提：已经到 2');
    assert.equal(b.breaker.writePaused, false, '2 次还不够');

    const c = w.obs.record({ request: req({ id: 'f3' }), result: RESULT.failed });
    assert.equal(c.breaker.writes, 3);
    assert.equal(c.breaker.writePaused, true, '第 3 次真实失败必须置位 writePaused');

    assert.deepEqual(w.auditRows().map((row) => row.record.result), ['failure', 'failure', 'failure']);
  } finally { w.close(); }
});

// ── 3. not_accessible touches NOTHING ────────────────────────────────────────────
test('OBS-3 not_accessible（隐私拒绝）既不 +1 也不重置 write 计数', async () => {
  const w = world({ state: baseState({ writes: 2, reads: 2 }) });
  try {
    // Drive the read direction with a privacy refusal.
    const before = w.read();
    assert.equal(before.writes, 2, '前提：writes 基线 2');
    assert.equal(before.reads, 2, '前提：reads 基线 2');

    const out = w.obs.recordRead({ outcome: 'not_accessible' });
    assert.equal(out.writes, 2, 'write 计数必须完全不变（既不 +1 也不重置）');
    assert.equal(out.reads, 2, 'read 计数同样不变');
    assert.equal(out.writePaused, false);
    assert.equal(out.accessPaused, false);
  } finally { w.close(); }
});

test('OBS-3b 隐私拒绝穿插在失败序列中：不打断、也不推进连续计数', async () => {
  const w = world();
  try {
    assert.equal(w.obs.record({ request: req({ id: 'f1' }), result: RESULT.failed }).breaker.writes, 1);
    // A privacy refusal in between must NOT reset the streak (that would let a caller launder
    // failures) and must NOT count as one.
    assert.equal(w.obs.recordRead({ outcome: 'not_accessible' }).writes, 1);
    assert.equal(w.obs.record({ request: req({ id: 'f2' }), result: RESULT.failed }).breaker.writes, 2);
    assert.equal(w.obs.recordRead({ outcome: 'not_accessible' }).writes, 2);
    const third = w.obs.record({ request: req({ id: 'f3' }), result: RESULT.failed });
    assert.equal(third.breaker.writes, 3);
    assert.equal(third.breaker.writePaused, true, '隐私拒绝穿插不得阻止第 3 次真实失败触发暂停');
  } finally { w.close(); }
});

// ── 4. immediate pauses ──────────────────────────────────────────────────────────
test('OBS-4 login_expired / captcha / network_unavailable 立即置 accessPaused（不累计）', async () => {
  for (const outcome of ['login_expired', 'captcha', 'network_unavailable']) {
    const w = world();
    try {
      assert.equal(w.read().reads, 0, `${outcome}: 前提 reads 为 0`);
      const out = w.obs.recordRead({ outcome });
      assert.equal(out.accessPaused, true, `${outcome} 必须立即暂停访问（无需累计）`);
      assert.equal(out.reads, 0, `${outcome}: 立即暂停走的是另一条分支，不必把计数推到 3`);
    } finally { w.close(); }
  }
});

// ── 5. success resets after failures ────────────────────────────────────────────
test('OBS-5 2 次 failure 后一次 success → writes 归 0', async () => {
  const w = world();
  try {
    assert.equal(w.obs.record({ request: req({ id: 'f1' }), result: RESULT.failed }).breaker.writes, 1);
    assert.equal(w.obs.record({ request: req({ id: 'f2' }), result: RESULT.failed }).breaker.writes, 2);
    assert.equal(w.read().writePaused, false);

    const ok = w.obs.record({ request: req({ id: 's1' }), result: RESULT.success });
    assert.equal(ok.breaker.writes, 0, '成功必须重置连续失败计数');
    assert.equal(ok.breaker.writePaused, false);

    // And the streak really restarted: two more failures must not pause.
    assert.equal(w.obs.record({ request: req({ id: 'f3' }), result: RESULT.failed }).breaker.writes, 1);
    assert.equal(w.obs.record({ request: req({ id: 'f4' }), result: RESULT.failed }).breaker.writes, 2);
    assert.equal(w.read().writePaused, false, '重置之后重新数，2 次不应触发暂停');
  } finally { w.close(); }
});

// ── 6. unknown is NOT a real failure ────────────────────────────────────────────
test('OBS-6 unknown → write 计数不变（已发出但未确认，不算真实失败）', async () => {
  const w = world({ state: baseState({ writes: 2 }) });
  try {
    assert.equal(w.read().writes, 2, '前提：writes 基线 2');
    const out = w.obs.record({ request: req(), result: RESULT.unknown });
    assert.equal(out.recorded, true, 'unknown 也必须留一条审计');
    assert.equal(out.audit.appended, true);
    assert.equal(out.breaker.applied, false, 'unknown 不走熔断转移');
    assert.equal(out.breaker.skippedReason, 'not-a-real-failure');
    assert.equal(out.breaker.writes, 2, 'unknown 不得把 write 计数 +1，也不得重置');
    assert.equal(out.breaker.writePaused, false);

    assert.equal(w.auditRows()[0].record.result, 'unknown', '审计如实记 unknown');
  } finally { w.close(); }
});

test('OBS-6b unknown 连发 5 次也不会触发 writePaused（它不是失败）', async () => {
  const w = world();
  try {
    for (let i = 0; i < 5; i += 1) {
      const out = w.obs.record({ request: req({ id: `u${i}` }), result: RESULT.unknown });
      assert.equal(out.breaker.writes, 0, `第 ${i + 1} 次 unknown 后 writes 必须仍是 0`);
    }
    assert.equal(w.read().writePaused, false, 'unknown 再多也不能触发真实失败熔断');
    assert.equal(w.auditRows().length, 5, '但每一次都留了审计');
  } finally { w.close(); }
});

// ── 7. redaction ────────────────────────────────────────────────────────────────
test('OBS-7 含 token 的 content → 审计 redacted:true 且 content 为 [REDACTED]', async () => {
  const w = world();
  try {
    const secret = 'token=abc123SECRET';
    const out = w.obs.record({ request: req({ content: secret }), result: RESULT.success });
    assert.equal(out.audit.redacted, true, '适配器必须如实报告发生了脱敏');
    const row = w.auditRows()[0];
    assert.equal(row.record.content, '[REDACTED]');
    assert.equal(row.record.redacted, true);
    assert.equal(JSON.stringify(row).includes('abc123SECRET'), false, '凭据原文绝不能落盘');
  } finally { w.close(); }
});

// ── 8. audit failure is reported, not swallowed ──────────────────────────────────
test('OBS-8 审计写入失败 → 如实上报，且熔断转移仍然生效', async () => {
  const t = tempDb('auditfail');
  const real = openOfflineStore(t.dbPath, baseState({ writes: 2 }));
  try {
    // A DEDICATED audit store whose writes fail. The `auditStore` seam keeps the failure provably an
    // AUDIT failure — a shared wrapper would leave "which update broke?" ambiguous, and the whole
    // point of this case is that the breaker still advanced.
    let failAuditWrite = false;
    const auditStore = {
      read: () => real.read(),
      update(fn) {
        if (failAuditWrite) throw new Error('audit disk full');
        return real.update(fn);
      },
    };
    const obs = createWriteObservability({ store: real, auditStore, clock: () => T0 });

    failAuditWrite = true;
    const out = obs.record({ request: req(), result: RESULT.failed });
    assert.equal(out.audit.failed, true, '审计失败必须被报告');
    assert.match(out.audit.error.message, /audit disk full/);
    assert.equal(out.audit.appended, false);
    assert.equal(out.recorded, false);
    // The safety-critical half must still have happened: the breaker moved.
    assert.equal(out.breaker.applied, true, '审计失败不得阻止熔断计数');
    assert.equal(out.breaker.failed, false);
    assert.equal(out.breaker.writes, 3, 'writes 2 → 3 已落盘');
    assert.equal(out.breaker.writePaused, true, '第 3 次失败仍必须置位暂停');
    // And the missing audit row is visible in the store, not silently invented.
    assert.equal(real.read().audit.length, 0);
  } finally { try { real.close(); } catch {} t.cleanup(); }
});

// t33 (G3): the DEFAULT path is now atomic — breaker and audit share one transaction. A failure in
// either half rolls the whole thing back, so the old "breaker failed but the audit still landed"
// behaviour no longer exists on this path. That assertion was rewritten, not deleted: what used to be
// a reported split is now a closed loop, and the case below pins the NEW contract.
test('OBS-8b 原子路径：任一半失败则两半都不落盘（熔断失败 ⇒ 审计也不写）', async () => {
  const t = tempDb('breakerfail');
  const real = openOfflineStore(t.dbPath, baseState());
  try {
    let failFirstWrite = true;
    const store = {
      ...real,
      update(fn) {
        if (failFirstWrite) { failFirstWrite = false; throw new Error('breaker disk full'); }
        return real.update(fn);
      },
    };
    const obs = createWriteObservability({ store, clock: () => T0 });
    const out = obs.record({ request: req(), result: RESULT.success });

    assert.equal(out.atomic, true, '默认路径必须是原子路径');
    assert.equal(out.rolledBack, true, '事务已回滚');
    assert.equal(out.breaker.failed, true, '熔断写入失败必须被报告');
    assert.match(out.breaker.error.message, /breaker disk full/);
    // G3: the audit half must NOT survive the rollback any more.
    assert.equal(out.audit.appended, false, '原子路径下熔断失败不得留下审计行');
    assert.equal(out.recorded, false);
    assert.equal(real.read().audit.length, 0, '两半都不落盘');
    assert.equal(real.read().writes, 0, 'writes 也没有推进（虽然它是 success，本应归零）');
  } finally { try { real.close(); } catch {} t.cleanup(); }
});

// The NON-atomic path keeps the old split behaviour, and must say so. This is the seam that exists
// precisely so "the audit alone failed" can be injected; it is labelled `atomic:false` everywhere.
test('OBS-8c 非原子路径（注入 auditStore）：熔断失败时审计仍写，返回体标 atomic:false', async () => {
  const t = tempDb('breakerfail-nonatomic');
  const real = openOfflineStore(t.dbPath, baseState());
  try {
    let failFirstWrite = true;
    const store = {
      ...real,
      update(fn) {
        if (failFirstWrite) { failFirstWrite = false; throw new Error('breaker disk full'); }
        return real.update(fn);
      },
    };
    const auditStore = { read: () => real.read(), update: (fn) => real.update(fn) };
    const obs = createWriteObservability({ store, auditStore, clock: () => T0 });
    const out = obs.record({ request: req(), result: RESULT.success });

    assert.equal(out.atomic, false, '注入 auditStore ⇒ 非原子路径必须自报');
    assert.equal(out.breaker.failed, true);
    assert.equal(out.audit.appended, true, '旧行为保留：审计仍写入');
    assert.equal(out.recorded, true);
    assert.equal(real.read().audit.length, 1);
  } finally { try { real.close(); } catch {} t.cleanup(); }
});

// ── 9. mapping table: every row of the task card ────────────────────────────────
test('OBS-9 映射表逐行对齐任务卡（reserve 拒绝 / transport 暂停 / 四种 outcome）', () => {
  const rows = [
    [RESULT.success, 'success', 'success'],
    [RESULT.failed, 'failure', 'failure'],
    [RESULT.unknown, 'unknown', null],
    [RESULT.notSent, 'unknown', null],
    [RESULT.deniedInterval, 'denied', null],
    [RESULT.deniedLimit, 'denied', null],
    [RESULT.deniedDupLike, 'denied', null],
    [RESULT.pausedBeforeSend, 'unknown', null],
  ];
  for (const [result, auditResult, breakerOutcome] of rows) {
    const mapped = mapWriteResult(result);
    assert.equal(mapped.auditResult, auditResult, `${JSON.stringify(result)} 的审计结果`);
    assert.equal(mapped.breakerOutcome, breakerOutcome, `${JSON.stringify(result)} 的熔断 outcome`);
    assert.equal(mapped.breakerDirection, 'write');
  }
  assert.deepEqual({ ...OBSERVED_RESULT }, { SUCCESS: 'success', FAILURE: 'failure', UNKNOWN: 'unknown', DENIED: 'denied' });
});

test('OBS-9b 拒绝类结果也留审计，且审计 reason 落在审计模块自己的词表内', async () => {
  const w = world();
  try {
    for (const [i, result] of [RESULT.deniedInterval, RESULT.deniedLimit, RESULT.deniedDupLike].entries()) {
      const out = w.obs.record({ request: req({ id: `d${i}` }), result });
      assert.equal(out.audit.appended, true, `第 ${i + 1} 个拒绝必须留审计`);
      assert.equal(out.audit.failed, false, '要求 reason 落在词表内，否则 formatAuditRecord 会抛');
    }
    assert.deepEqual(w.auditRows().map((row) => row.record.result), ['denied', 'denied', 'denied']);
    assert.deepEqual(w.auditRows().map((row) => row.record.reason), ['rate_limit', 'quota', 'policy']);
    // None of those touched the breaker.
    assert.equal(w.read().writes, 0);
  } finally { w.close(); }
});

// ── 10. the adapter owns no rules of its own ────────────────────────────────────
test('OBS-10 适配器不重实现规则：阈值与脱敏正则都来自被复用的模块', () => {
  const source = fs.readFileSync(new URL('../src/core/qzone-write-observability-offline.mjs', import.meta.url), 'utf8');
  // Strip comments so prose that merely mentions `[REDACTED]` (the header explains the behaviour)
  // cannot make this assertion pass or fail for the wrong reason.
  const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  // The breaker arithmetic lives in the policy module; the redaction regex lives in the audit module.
  // If either leaked in here, the two copies could drift apart.
  assert.equal(/===\s*3\b|\b3\s*===/.test(code), false, '不得在本模块里写死「3 次」阈值');
  assert.equal(/(?:cookie|p_skey|qzonetoken|Bearer)/.test(code), false, '不得在本模块里复制 SENSITIVE 正则');
  assert.equal(code.includes('[REDACTED]'), false, '不得在本模块里自己拼脱敏占位符');
  assert.match(source, /from '\.\/qzone-audit-offline\.mjs'/, '必须真的复用审计模块');
  assert.match(source, /from '\.\/qzone-policy-offline\.mjs'/, '必须真的复用熔断模块');
  assert.match(source, /appendOfflineAudit\(/, '审计写入必须走 appendOfflineAudit');
  assert.match(source, /nextFailureState\(/, '熔断转移必须走 nextFailureState');
});
