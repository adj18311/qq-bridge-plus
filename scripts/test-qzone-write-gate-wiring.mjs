// M2 + M5 · the H3 write gate, wired at BOTH ends: the write facade, and the reservation kernels.
//
// WHY BOTH, AND WHY THIS FILE EXISTS
// ----------------------------------
// The gate is worthless if it can be walked around. Two things could:
//   · a caller that goes straight to `reserveOfflinePost` / `reserveOfflineInteraction` (the audited
//     variants and several tests do exactly that), and
//   · a caller that enters through `write()` and must not be charged anything for a refusal.
// So the gate lives in the kernels (M5) — that is the floor every reservation passes — and ALSO at
// the facade (M2), where it can refuse before even reading the clock-derived reservation path.
//
// THE ASSERTION THAT MATTERS MOST IS NOT "it returns ok:false". It is:
//   · the transport was never called (counted, not inferred), and
//   · the durable state is byte-identical to before (no quota, no reservation, no cooldown).
// A gate that "refused" after spending a quota unit would pass a return-value-only test and still be
// wrong, so every case below inspects the store.
//
// AND THE SECOND MOST IMPORTANT: the gate must not be a permanent lock. GW-7 clears the fault and
// demands the SAME request succeed. Without it, an implementation that refuses unconditionally would
// satisfy every other case in this file.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createOfflineWritePath } from '../src/core/qzone-write-path-offline.mjs';
import { reserveOfflinePost, reserveOfflineInteraction } from '../src/core/qzone-reservation-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { mapWriteResult } from '../src/core/qzone-write-observability-offline.mjs';

const NOW = Date.parse('2026-11-13T04:00:00.000Z');   // 12:00 Beijing
const TARGET = '9876543210';

const baseState = (over = {}) => ({
  enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
  tools: { publish: true, comment: true, reply: true, like: true },
  limits: { post: 3, comment: 25, like: 30 },
  ledger: { day: beijingDay(NOW), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
  lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [],
  // `audit` is the array the audited reservation variants append their intent row to; present so a
  // case can assert "not even an intent row was written".
  audit: [],
  writeGate: null,
  auditGaps: [],
  ...over,
});

const FAULT = Object.freeze({ fault: 'audit-unavailable', since: NOW, cause: 'audit-not-array' });

function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-wg-wire-${label}-`));
  return {
    dir, dbPath: path.join(dir, 'state.db'),
    cleanup() { for (let i = 0; i < 20; i += 1) { try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* win handle delay */ } } },
  };
}

/** A real store + a real facade + a transport that COUNTS its own calls. */
function world({ state = baseState() } = {}) {
  const t = tempDb('w');
  const store = openOfflineStore(t.dbPath, state);
  const calls = [];
  const path = createOfflineWritePath({
    store, limits: state.limits, clock: () => NOW,
    transport: async (req) => { calls.push(req); return { ok: true }; },
  });
  return {
    store, calls, path,
    read: () => store.read(),
    /** Move the store to a new health state WITHOUT going through the gate. */
    setHealth(writeGate, auditGaps = []) { store.update((s) => ({ ...s, writeGate, auditGaps })); },
    close() { try { store.close(); } catch {} t.cleanup(); },
  };
}

const req = (over = {}) => ({ id: 'w-1', action: 'publish', target: TARGET, postId: 'p-1', source: 'qq', content: 'x', ...over });

/** Snapshot the parts of the state a refused write must leave untouched. */
const financials = (state) => ({
  used: { ...state.ledger.used },
  reservations: { ...state.ledger.reservations },
  lastPostAt: state.lastPostAt,
  lastCommentAt: state.lastCommentAt,
  likes: JSON.parse(JSON.stringify(state.likes)),
  commentTargets: JSON.parse(JSON.stringify(state.commentTargets)),
});

// ── GW-1: positive control — a healthy state really does reach the transport ─────
test('GW-1 正对照：健康 state 下 write() 真的走到 transport', async () => {
  const w = world();
  try {
    const out = await w.path.write(req());
    assert.equal(out.ok, true, `必须成功: ${JSON.stringify(out)}`);
    assert.equal(out.stage, 'transport');
    assert.equal(w.calls.length, 1, '★ transport 真的被调用一次');
    assert.equal(w.read().ledger.used.post, 1, '健康路径确实消耗了额度');
  } finally { w.close(); }
});

// ── GW-2: a fault refuses, and NOTHING is spent ─────────────────────────────────
test('GW-2 writeGate 有故障 → ok:false、transport 零调用、quotaConsumed:false、used 全 0', async () => {
  const w = world({ state: baseState({ writeGate: FAULT }) });
  try {
    const before = financials(w.read());
    assert.equal(before.used.post, 0, '前提：起始 used 为 0');
    assert.equal(Object.keys(before.reservations).length, 0, '前提：起始无预留');

    const out = await w.path.write(req());

    assert.equal(out.ok, false);
    assert.equal(out.reason, 'write-gate-fault', '必须报出门禁原因，而不是一个笼统的失败');
    assert.equal(out.quotaConsumed, false, '★ 显式 false（缺省不能被读成「可能已消耗」）');
    assert.equal(w.calls.length, 0, '★ transport 零调用（计数断言，不是看返回值）');

    const after = financials(w.read());
    assert.deepEqual(after.used, { post: 0, comment: 0, like: 0 }, 'used 必须全 0');
    assert.deepEqual(after.used, before.used, '与调用前逐字段相同');
  } finally { w.close(); }
});

// ── GW-3: audit gaps refuse too, same zero-cost guarantee ───────────────────────
test('GW-3 auditGaps 非空 → 同 GW-2：拒绝且零消耗零调用', async () => {
  const w = world({ state: baseState({ auditGaps: [{ at: NOW, cause: 'audit-not-array' }] }) });
  try {
    const before = financials(w.read());
    const out = await w.path.write(req());

    assert.equal(out.ok, false);
    assert.equal(out.reason, 'audit-gap-present');
    assert.equal(out.quotaConsumed, false);
    assert.equal(w.calls.length, 0, '★ transport 零调用');
    assert.deepEqual(financials(w.read()), before, '整个财务面逐字段不变');
  } finally { w.close(); }
});

// ── GW-4: no reservation entry is created ──────────────────────────────────────
test('GW-4 门禁拒绝时 reservations 无新增条目（可达的「零预留」证明）', async () => {
  for (const [label, health] of [
    ['fault', { writeGate: FAULT, auditGaps: [] }],
    ['gaps', { writeGate: null, auditGaps: [{ at: NOW }] }],
  ]) {
    const w = world({ state: baseState({ writeGate: health.writeGate, auditGaps: health.auditGaps }) });
    try {
      assert.deepEqual(Object.keys(w.read().ledger.reservations), [], '前提：起始无预留');
      await w.path.write(req({ id: `gate-${label}` }));
      assert.deepEqual(Object.keys(w.read().ledger.reservations), [], `${label}: 不得新增 reservations[id]`);
      assert.equal(Object.hasOwn(w.read().ledger.reservations, `gate-${label}`), false, `${label}: 该 id 不得被占用`);
      // And the id stays USABLE: nothing was reserved, so after clearing the fault it must work.
      w.setHealth(null, []);
      const retry = await w.path.write(req({ id: `gate-${label}` }));
      assert.equal(retry.ok, true, `${label}: 门禁拒绝不得烧掉这个 id`);
    } finally { w.close(); }
  }
});

// ── GW-5: the kernel gate (M5) — direct reserveOfflinePost ─────────────────────
test('GW-5 直接调 reserveOfflinePost 时门禁生效（绕过门面也拦得住）', () => {
  const w = world({ state: baseState({ writeGate: FAULT }) });
  try {
    const before = financials(w.read());
    const out = reserveOfflinePost(w.store, { id: 'direct-post', now: NOW });
    assert.equal(out.allowed, false, '★ 绕过门面也必须被拒');
    assert.equal(out.reason, 'write-gate-fault');
    assert.deepEqual(financials(w.read()), before, '零消耗');

    // Positive control: same call with the fault cleared succeeds, so the refusal was the gate's doing.
    w.setHealth(null, []);
    assert.equal(reserveOfflinePost(w.store, { id: 'direct-post', now: NOW }).allowed, true);
    assert.equal(w.read().ledger.used.post, 1);
  } finally { w.close(); }
});

// ── GW-6: the kernel gate (M5) — direct reserveOfflineInteraction ─────────────
test('GW-6 直接调 reserveOfflineInteraction 时门禁生效', () => {
  const w = world({ state: baseState({ auditGaps: [{ at: NOW }] }) });
  try {
    const before = financials(w.read());
    for (const tool of ['comment', 'reply', 'like']) {
      const out = reserveOfflineInteraction(w.store, { id: `direct-${tool}`, now: NOW, tool, target: TARGET, postId: 'p-9' });
      assert.equal(out.allowed, false, `${tool}: 必须被拒`);
      assert.equal(out.reason, 'audit-gap-present', `${tool}: reason 必须透出门禁原因`);
    }
    assert.deepEqual(financials(w.read()), before, '三个 action 都零消耗');

    w.setHealth(null, []);
    assert.equal(reserveOfflineInteraction(w.store, { id: 'direct-like', now: NOW, tool: 'like', target: TARGET, postId: 'p-9' }).allowed, true);
    assert.equal(w.read().ledger.used.like, 1);
  } finally { w.close(); }
});

// ── GW-7: not a permanent lock ────────────────────────────────────────────────
test('GW-7 防假绿：清掉故障后同一请求必须成功（否则门禁等于永久锁死）', async () => {
  const w = world({ state: baseState({ writeGate: FAULT }) });
  try {
    const blocked = await w.path.write(req({ id: 'same-id' }));
    assert.equal(blocked.ok, false, '前提：故障期间必须拒');
    assert.equal(w.calls.length, 0);

    w.setHealth(null, []);
    const ok = await w.path.write(req({ id: 'same-id' }));   // SAME id, SAME everything
    assert.equal(ok.ok, true, '★ 解除故障后同一 id 必须能写（证明拒绝来自门禁，不是别的原因）');
    assert.equal(ok.stage, 'transport');
    assert.equal(w.calls.length, 1, '这时 transport 才被真正调用');
    assert.equal(w.read().ledger.used.post, 1, '并且额度真的被消耗了（正对照的落点）');
  } finally { w.close(); }
});

// ── GW-8: the stage label is `reserve`, and that is load-bearing ───────────────
test('GW-8 stage 选择：门禁拒绝标 reserve，使 mapWriteResult 归为 denied（而非 unknown）', async () => {
  const w = world({ state: baseState({ writeGate: FAULT }) });
  try {
    const out = await w.path.write(req());

    // The label is an INPUT to the classifier, so assert the classifier's verdict, not just the word.
    assert.equal(out.stage, 'reserve', '门禁拒绝必须标 reserve');
    const mapped = mapWriteResult(out);
    assert.equal(mapped.auditResult, 'denied', '★ 必须归为 denied：什么都没发出、什么都没失败');
    assert.equal(mapped.breakerOutcome, null, '不得计入真实失败');
    assert.equal(mapped.breakerDirection, 'write');

    // Contrast: the OTHER pre-reserve refusal in this module uses 'authorize', which maps to
    // 'unknown'. Pinned so the difference stays deliberate rather than accidental.
    const authOut = await w.path.write(req({ action: 'not-a-write-action' }));
    assert.equal(authOut.stage, 'authorize');
    assert.equal(mapWriteResult(authOut).auditResult, 'unknown', '既有 stage 0 的行为未变');
  } finally { w.close(); }
});

// ── GW-9: the audited variants inherit the gate (they call the kernels) ────────
test('GW-9 审计型入口（audited variants）也继承门禁：它们走的是同一个内核', async () => {
  const { reserveAuditedOfflinePost } = await import('../src/core/qzone-reservation-offline.mjs');
  const w = world({ state: baseState({ writeGate: FAULT, selfId: TARGET }) });
  try {
    const before = financials(w.read());
    const out = reserveAuditedOfflinePost(w.store, { id: 'audited-1', now: NOW }, {
      time: NOW, source: 'qq', action: 'publish', target: TARGET,
      postId: null, content: '', result: 'unknown', reason: '', quota: null,
    });
    assert.equal(out.allowed, false, '★ audited 入口也必须被门禁拦住');
    assert.equal(out.reason, 'write-gate-fault');
    assert.deepEqual(financials(w.read()), before, '零消耗');
    assert.equal(w.read().audit.length, 0, '连 intent 审计行都不该产生');
  } finally { w.close(); }
});

// ── GW-10: the gate does not run twice in a way that double-charges ───────────
test('GW-10 双层门禁不重复收费：门面已拦则内核根本不会被调用（同一状态只判一次）', async () => {
  const w = world({ state: baseState({ writeGate: FAULT }) });
  try {
    let gateCalls = 0;
    // Count invocations by wrapping the store's read (the facade's gate calls store.read()).
    const originalRead = w.store.read;
    const spy = { ...w.store, read() { gateCalls += 1; return originalRead(); }, update: (fn) => w.store.update(fn) };
    const spyPath = createOfflineWritePath({
      store: spy, limits: baseState().limits, clock: () => NOW,
      transport: async (r) => { w.calls.push(r); return { ok: true }; },
    });
    const out = await spyPath.write(req());
    assert.equal(out.ok, false);
    assert.equal(gateCalls >= 1, true, '门面至少读一次状态做门禁判断');
    // The decisive part: no transaction ran, so the kernel gate was never reached and nothing was
    // written. `used` staying 0 is what proves it — a double gate would still be 0, but a gate that
    // ran AFTER the reservation would show 1 here.
    assert.equal(w.read().ledger.used.post, 0);
    assert.equal(w.calls.length, 0);
  } finally { w.close(); }
});

// ── GW-11: source-level invariants ────────────────────────────────────────────
test('GW-11 源码级：reserveWrite 签名与 checkLedger 判据逐字不变，门禁在两处调用', () => {
  const policy = fs.readFileSync(new URL('../src/core/qzone-policy-offline.mjs', import.meta.url), 'utf8');
  const reserve = policy.match(/export function reserveWrite\(([^)]*)\)/);
  assert.ok(reserve, 'reserveWrite 必须仍然导出');
  assert.equal(reserve[1].replace(/\s+/g, ' ').trim(), 'state, { day, kind, limit, id } = {}',
    '★ reserveWrite 签名必须逐字不变（M6 要求）');
  // The gate must NOT have been folded into reserveWrite.
  assert.equal(/function reserveWrite[\s\S]{0,400}?checkWriteGate/.test(policy), false,
    'reserveWrite 内不得调用 checkWriteGate（门禁在它之前，不在它之内）');

  const reservation = fs.readFileSync(new URL('../src/core/qzone-reservation-offline.mjs', import.meta.url), 'utf8');
  const gateCalls = (reservation.match(/checkWriteGate\(/g) ?? []).length;
  assert.equal(gateCalls, 2, `两个入口各一次门禁（实际 ${gateCalls}）`);
  assert.match(reservation, /import \{[^}]*checkWriteGate[^}]*\} from '\.\/qzone-policy-offline\.mjs'/,
    '必须从 policy 导入同一个实现，不得本地复刻');

  const writePath = fs.readFileSync(new URL('../src/core/qzone-write-path-offline.mjs', import.meta.url), 'utf8');
  assert.equal((writePath.match(/checkWriteGate\(/g) ?? []).length, 1, 'write-path 只允许一处 checkWriteGate 调用（在 gateRefusal 内）');
  // And the facade gate must sit AFTER `const now = clock()` (it takes `now`) and BEFORE stage 1.
  // t66: the facade no longer calls `checkWriteGate` directly — it calls `gateRefusal`, which combines
  // the process-local latch with that same gate. So the anchor moved, and the assertion follows it.
  const nowIdx = writePath.indexOf('const now = clock();');
  const gateIdx = writePath.indexOf('const health = gateRefusal(');
  const stage1Idx = writePath.indexOf('// ── stage 1: THE atomic reservation');
  assert.ok(nowIdx >= 0 && gateIdx > nowIdx, '★ 门禁必须在 now 定义之后');
  assert.ok(stage1Idx > gateIdx, '★ 门禁必须在 stage 1 预留之前');
  // The combined gate must still consult the persisted health check (it is the latch that was ADDED,
  // not the store check that was removed).
  assert.match(writePath, /function gateRefusal\((?:[^)]*)\)\s*\{[\s\S]{0,400}?checkWriteGate\(/,
    '★ gateRefusal 必须仍然调用 checkWriteGate（锁存是叠加，不是替换）');
});

// ── GW-12: the gate must be checked BEFORE every other reservation rule ────────
//
// M-c proved this needed a test of its own. Moving the gate to AFTER `reserveWrite` survived the
// whole file, because `Denied` rolls the transaction back — the state ends up identical either way,
// so "zero consumption" cannot distinguish the two orders. What DOES differ is WHICH reason is
// reported when the gate AND another refusal are both true: if the gate runs first it wins, if it
// runs last the caller hears about the quota/interval instead and never learns the store is unhealthy.
// That is a real diagnosis difference, so it is pinned here.
test('GW-12 优先级：门禁与额度/间隔同时命中时，必须报门禁（证明门禁排在最前）', () => {
  // faulted AND daily post limit is 0 → `reserveWrite` would say 'limit'.
  const w = world({ state: baseState({ writeGate: FAULT, limits: { post: 0, comment: 25, like: 30 } }) });
  try {
    const post = reserveOfflinePost(w.store, { id: 'order-post', now: NOW });
    assert.equal(post.allowed, false);
    assert.equal(post.reason, 'write-gate-fault',
      '★ 必须报门禁原因；若报 limit 说明门禁被排到了 reserveWrite 之后');

    // Same shape for an interaction: faulted AND a like that would be a duplicate.
    const w2 = world({ state: baseState({ writeGate: FAULT, likes: [{ author: TARGET, id: 'p-9' }] }) });
    try {
      const like = reserveOfflineInteraction(w2.store, { id: 'order-like', now: NOW, tool: 'like', target: TARGET, postId: 'p-9' });
      assert.equal(like.allowed, false);
      assert.equal(like.reason, 'write-gate-fault',
        '★ 必须报门禁原因；若报 duplicate_like 说明门禁被排到了后面');
    } finally { w2.close(); }

    // And through the facade, where the gate sits before stage 1 entirely.
    // (uses its own world because `write` is async)
  } finally { w.close(); }
});

test('GW-12b 优先级（门面）：故障 + 额度耗尽时 write() 报门禁而不是 limit', async () => {
  const w = world({ state: baseState({ writeGate: FAULT, limits: { post: 0, comment: 25, like: 30 } }) });
  try {
    const out = await w.path.write(req({ id: 'order-facade' }));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'write-gate-fault', '★ 门面也必须先报门禁');
    assert.equal(out.quotaConsumed, false);
    assert.equal(w.calls.length, 0);

    // Control: with the fault cleared, the SAME request must now report the quota problem instead —
    // proving the gate was masking a real, different refusal, not replacing it.
    w.setHealth(null, []);
    const now = await w.path.write(req({ id: 'order-facade' }));
    assert.equal(now.ok, false);
    assert.equal(now.reason, 'limit', '清掉故障后应当浮现真正的额度拒绝');
  } finally { w.close(); }
});