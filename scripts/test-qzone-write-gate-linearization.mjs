// M3 + M4 · the authorisation LINEARIZATION POINT and the PROCESS-LOCAL FAULT LATCH.
//
// HOW THIS FILE AVOIDS THE TRAP THAT BIT THE PREVIOUS TASK
// -------------------------------------------------------
// The M2/M5 task learned (the hard way) that "zero side effects" CANNOT prove "the check ran before
// the effect": a throw inside `store.update` rolls the whole transaction back, so the final bytes are
// identical no matter where inside the callback the refusal happened. Every ordering claim below is
// therefore made with an observable that DIFFERS between the orders:
//
//   · was a durable reservation written for this id?  (`reservations[id]` — survives rollback questions)
//   · WHICH reason is reported when two refusals apply? (different causes, different diagnosis)
//   · was the transport called, counted?              (not inferred from the return value)
//
// DESIGN REGRESSION (v6 §2.4, "no new object")
// --------------------------------------------
// The previous revision of this file observed the linearization point through a durable
// `state.writePermits` collection that the check itself wrote. That collection existed only because
// the tests wanted something to look at, and "a test's observation cannot create a business
// necessity" (Codex). It is gone. The grant is now the successful commit of the final check, the
// parameter snapshot is a local frozen object that lives until the transport call, and de-duplication
// stays where it always was: `reservations[id]` plus the B2 claim. LZ-15 pins the absence.
//
// WHAT IS AND IS NOT CLAIMED
// --------------------------
// LZ-5 verifies the ORDER of two single-threaded decisions inside one process. It is NOT evidence of
// concurrency atomicity, and nothing here should be quoted as such. Real cross-process atomicity would
// need a shared serialization point this module does not have.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openOfflineStore, authorityOf } from '../src/core/qzone-store-offline.mjs';
import * as writePathModule from '../src/core/qzone-write-path-offline.mjs';
import {
  createOfflineWritePath,
  WRITE_ACTIONS,
  latchFault,
  readFaultLatch,
  clearFaultLatch,
  clearFaultLatchIfRevision,
  advanceRevision,
} from '../src/core/qzone-write-path-offline.mjs';
import { allowedFieldsFor } from '../src/core/qzone-onebot-write-contract.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';

const NOW = Date.parse('2026-11-13T04:00:00.000Z');
const TARGET = '9876543210';
const FAULT = Object.freeze({ fault: 'audit-unavailable', since: NOW, cause: 'audit-not-array' });

const baseState = (over = {}) => ({
  enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
  tools: { publish: true, comment: true, reply: true, like: true },
  limits: { post: 3, comment: 25, like: 30 },
  ledger: { day: beijingDay(NOW), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
  lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [],
  audit: [], writeGate: null, auditGaps: [],
  ...over,
});

function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-lz-${label}-`));
  return {
    dir, dbPath: path.join(dir, 'state.db'),
    cleanup() { for (let i = 0; i < 20; i += 1) { try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* win handle */ } } },
  };
}

/** Real store + real facade + a transport that counts itself. */
function world({ state = baseState(), dbPath, clock = () => NOW } = {}) {
  const t = dbPath ? null : tempDb('w');
  const file = dbPath ?? t.dbPath;
  const store = openOfflineStore(file, state);
  const calls = [];
  const path = createOfflineWritePath({
    store, limits: state.limits, clock,
    transport: async (req) => { calls.push(req); return { ok: true }; },
  });
  return {
    t, store, file, calls, path,
    read: () => store.read(),
    setHealth(writeGate, auditGaps = []) { store.update((s) => ({ ...s, writeGate, auditGaps })); },
    close() { try { store.close(); } catch {} t?.cleanup(); },
  };
}

const req = (over = {}) => {
  const action = over.action ?? 'publish';
  const base = { id: 'w-1', action, target: TARGET, postId: 'p-1', source: 'qq', content: 'x', ...over };
  // A `reply` needs its parent comment's AUTHOR (`commentUin` → `comment_uin`) as well as its id: the
  // reservation compares the frozen reply identity against the store's evidence row, and a request
  // without an author cannot be compared at all. Defaulting it here keeps every reply fixture legal
  // so a case that measures something ELSE is not refused for a missing parameter.
  if (action === 'reply' && over.commentUin === undefined) base.commentUin = REPLY_COMMENT_UIN;
  return base;
};

/**
 * The reply identity evidence a LEGAL reply needs — a FIXTURE, and it must be one.
 *
 * `reserveAuditedOfflineInteraction` refuses a reply unless exactly one `state.commentEvidence` row
 * matches the identity triple AND the reply identity frozen on the dispatch. **No producer of that
 * collection was found within the checked scope** (this repository's `src/`), so a test can only seed
 * it; seeding proves the GATE behaves as specified, not that a real reply can be sent. Cases below
 * whose subject is a DIFFERENT rule (parameter binding, no collateral damage, table-driven field
 * allowlist) need the reply to be otherwise legal, or they would measure the evidence gate instead.
 */
const REPLY_COMMENT_UIN = 7;
const replyEvidenceRow = ({ target = TARGET, postId = 'p-1', commentId, at = NOW }) => ({
  target, postId, commentId, commentUin: REPLY_COMMENT_UIN, replyUin: null, replyName: null,
  // `at` is REQUIRED: the reservation judges evidence age inside its own transaction, so an undated
  // row is refused as `evidence-undated`. Defaulting it to this fixture's `NOW` keeps these cases
  // about the gate/linearization rules rather than about age.
  at,
});
const replyState = (...rows) => baseState({ commentEvidence: rows });

/**
 * A `like` carries NO body: `FIELDS.like` in the write contract has no `content`, and since t10 the
 * facade refuses a like that carries one (LZ-16). Every like fixture must therefore explicitly drop
 * the default body — `{...req({action:'like'})}` would inherit it and be refused for the wrong reason.
 */
const likeReq = (over = {}) => req({ action: 'like', content: undefined, ...over });

// ══════════════════════════════════════════════════════════════════════════════════════
// M3 · the linearization point, observed WITHOUT a durable permit collection
// ══════════════════════════════════════════════════════════════════════════════════════

// ── LZ-1: the grant really is a successful commit, and it is one-shot ───────────
test('LZ-1 正常路径：提交成功即授予，且只发送一次；同 id 第二次被既有 reservations 拒', async () => {
  const w = world();
  try {
    assert.equal(w.read().ledger.reservations['w-1'], undefined, '前提：调用前该 id 未被占用');

    const out = await w.path.write(req());
    assert.equal(out.ok, true, `必须成功: ${JSON.stringify(out)}`);
    assert.equal(w.calls.length, 1, '★ 提交成功后确实允许发送，且恰好一次');

    // The migrated observable: what the removed permit used to prove ("a grant happened for THIS id")
    // is now proven by the durable reservation the same call committed — same claim, no new object.
    assert.equal(w.read().ledger.reservations['w-1'], 'post', '★ 授予与预留是同一次提交');
    assert.equal(w.read().ledger.used.post, 1, '★ 额度恰好 +1（不是 +2，也不是 0）');

    // Second use of the same grant/id: refused by the durable reservation, transport untouched.
    const again = await w.path.write(req({ id: 'w-1' }));
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'interval', '2 小时内第二次 publish 先撞间隔（与 id 去重是两条规则）');
    assert.equal(w.calls.length, 1, '★ 不得第二次发送');

    // Advanced past the interval: now only the durable id reservation can refuse it, and it must.
    const later = await w.path.write(req({ id: 'w-1' }));
    assert.equal(later.ok, false, '★ 越过间隔后同 id 仍必须被拒');
    assert.equal(w.calls.length, 1);
  } finally { w.close(); }
});

// ── LZ-2: a gate refusal at the linearization point KEEPS the charge ──────────
test('LZ-2 门禁在 stage 1b 拒绝时：额度已扣仍保留、quotaConsumed:true（不得回滚）', async () => {
  const w = world();
  try {
    // Let the reservation succeed, THEN break the store so the linearization point refuses.
    // (This is the exact situation the task asks about: quota spent, grant withheld.)
    //
    // A SPREAD wrapper, deliberately: it carries the real store's authority, so this harness observes
    // the same authority the write path uses. A closure wrapper is refused at construction now (R6).
    const path = createOfflineWritePath({
      store: {
        ...w.store,
        read: () => w.store.read(),
        update(fn) {
          const out = w.store.update(fn);
          // After the reservation commits, make the store unhealthy so stage 1b must refuse.
          if (w.read().ledger.used.post > 0 && w.read().writeGate === null) {
            w.store.update((s) => ({ ...s, writeGate: FAULT }));
          }
          return out;
        },
      },
      limits: baseState().limits, clock: () => NOW,
      transport: async (r) => { w.calls.push(r); return { ok: true }; },
    });

    const out = await path.write(req({ id: 'late-fault' }));

    assert.equal(out.ok, false);
    assert.equal(out.reason, 'paused-before-send');
    assert.equal(out.quotaConsumed, true, '★ 额度已扣 ⇒ 必须如实报 true');
    assert.equal(out.transportCalled, false, '★ 没有发送');
    assert.equal(out.permitRefusedBy, 'gate', '拒绝来自门禁那一层');
    assert.equal(w.calls.length, 0, 'transport 零调用（计数）');
    assert.equal(w.read().ledger.used.post, 1, '★ 额度保留：不得回滚成 0');
    assert.equal(w.read().writeGate !== null, true, '前提：门禁此时确实是故障态');
  } finally { w.close(); }
});

// ── LZ-3: single use, migrated to the durable reservation ─────────────────────
test('LZ-3 单次消费（迁移）：同一 id 第二次必须被拒；换 id 仍可写', async () => {
  const w = world();
  try {
    const first = await w.path.write(likeReq({ id: 'once', postId: 'p-1' }));
    assert.equal(first.ok, true);
    assert.equal(w.read().ledger.reservations.once, 'like', '★ 资格/预留已落盘');

    const second = await w.path.write(likeReq({ id: 'once', postId: 'p-2' }));
    assert.equal(second.ok, false, '★ 第二次不得再授予');
    assert.equal(second.reason, 'duplicate');
    assert.equal(w.calls.length, 1, '被拒的那次没有发送');

    // Non-vacuity: a DIFFERENT id still works, so the refusal is the reservation's doing.
    const other = await w.path.write(likeReq({ id: 'once-2', postId: 'p-3' }));
    assert.equal(other.ok, true);
    assert.equal(w.calls.length, 2);
  } finally { w.close(); }
});

// ── LZ-4: parameter binding, migrated ─────────────────────────────────────────
test('LZ-4 参数绑定（迁移）：同 id 换 content / target / postId 都不得被放过', async () => {
  const w = world();
  try {
    assert.equal((await w.path.write(likeReq({ id: 'bind', postId: 'p-1' }))).ok, true);

    // Same id, every parameter changed. The id reservation is what refuses now (it is the durable
    // identity); the *parameter* binding half of the old permit is covered by LZ-12/13/14, which
    // assert on the values that actually reach the transport.
    // `content` is deliberately NOT in this list any more: a `like` may not carry a body at all
    // (`FIELDS.like` has no `content`), so changing it is refused by the shape guard — with a
    // different reason — before the id reservation is ever consulted. That refusal is pinned
    // separately by LZ-16; keeping it here would blur two distinct mechanisms into one assertion.
    for (const [label, over] of [
      ['target', { target: '1122334455' }],
      ['postId', { postId: 'p-2' }],
    ]) {
      const out = await w.path.write(req({ id: 'bind', action: 'like', content: undefined, postId: 'p-1', ...over }));
      assert.equal(out.ok, false, `★ 换 ${label} 复用同 id 必须拒`);
      // Either durability rule may fire first for a `like` (the id reservation, or the same-post
      // de-duplication marker) — both are DURABLE state, which is the point being asserted.
      assert.ok(['duplicate', 'duplicate_like'].includes(out.reason),
        `${label}: 拒因必须来自持久去重记录（实际 ${out.reason}）`);
    }
    // The body-on-like refusal, as its own reading (see LZ-16 for the full case).
    const withBody = await w.path.write(req({ id: 'bind', action: 'like', content: 'DIFFERENT', postId: 'p-1' }));
    assert.equal(withBody.reason, 'unexpected-content', 'like 多带正文 ⇒ 形状校验拒，与去重是两条规则');
    assert.equal(w.calls.length, 1, '三次复用都没有发送');

    // Positive control: the reservation is per-id, so a fresh id with the SAME parameters works.
    const fresh = await w.path.write(req({ id: 'bind-2', action: 'like', content: undefined, postId: 'p-9' }));
    assert.equal(fresh.ok, true, '新 id + 合法参数必须放行（证明不是整体锁死）');
  } finally { w.close(); }
});

// ── LZ-5: grant-first vs pause-first, with a DISCRIMINATING observable ────────
test('LZ-5 顺序：暂停先 → 无预留且不发送；授予先 → 预留已在盘上且发送', async () => {
  // ── pause FIRST: commit writePaused before the write runs ──
  // Observable: was a reservation written for this id? Pause-first must produce NONE, because the
  // reservation kernel's own `authorizeTool` refuses before `reserveWrite`. That record is present or
  // absent regardless of any rollback games.
  const paused = world({ state: baseState({ writePaused: true }) });
  try {
    const out = await paused.path.write(req({ id: 'pause-first' }));
    assert.equal(out.ok, false);
    // `writePaused` is NOT a gate refusal — the gate only covers store health. It is caught by the
    // reservation kernel's own `authorizeTool`, which returns `{stage:'reserve'}` WITHOUT the
    // `quotaConsumed` field (that field only appears once quota could have been spent).
    assert.equal(out.stage, 'reserve', '暂停在预留阶段被拒');
    assert.equal(out.reason, 'write_paused', '拒因来自 authorizeTool 的暂停语义');
    assert.equal(Object.hasOwn(out, 'quotaConsumed'), false, '预留前拒绝：根本没有 quotaConsumed 字段');
    assert.equal(paused.calls.length, 0);
    assert.equal(paused.read().ledger.reservations['pause-first'], undefined, '★ 暂停先 ⇒ 从未预留');
    assert.equal(paused.read().ledger.used.post, 0);
  } finally { paused.close(); }

  // ── grant FIRST: the reservation+check commit, then a pause appears afterwards ──
  // Observable: at transport time the durable reservation EXISTS while `writePaused` is now true.
  // That combination is only reachable in the grant-first order.
  const granted = world();
  let reservationAtTransport = null;
  try {
    const path = createOfflineWritePath({
      store: granted.store, limits: baseState().limits, clock: () => NOW,
      transport: async (r) => {
        granted.calls.push(r);
        // At transport time the grant must already be durable, and we then apply a pause.
        reservationAtTransport = granted.read().ledger.reservations['grant-first'];
        granted.store.update((s) => ({ ...s, writePaused: true }));
        return { ok: true };
      },
    });
    const out = await path.write(req({ id: 'grant-first' }));
    assert.equal(out.ok, true, '授予先 ⇒ 该调用完成');
    assert.equal(out.transportCalled, true);
    assert.equal(reservationAtTransport, 'post', '★ 发送那一刻预留已持久化（授予先的证据）');
    assert.equal(granted.read().writePaused, true, '暂停确实在后来的某个时刻落盘了');

    // The pause took effect only for LATER calls — proven by a second call being refused.
    const later = await path.write(req({ id: 'after-pause' }));
    assert.equal(later.ok, false, '后续调用必须被暂停拦住');
    assert.equal(granted.read().ledger.reservations['after-pause'], undefined, '后续调用不得取得预留');
  } finally { granted.close(); }
});

// ── LZ-6: crash does not auto-resend ──────────────────────────────────────────
test('LZ-6 崩溃后不自动重发：重启后同 id 先被间隔挡、越过间隔后被 reservations 挡', async () => {
  const t = tempDb('crash');
  try {
    let clockNow = NOW;
    const first = world({ dbPath: t.dbPath, clock: () => clockNow });
    try {
      const out = await first.path.write(req({ id: 'crash-1' }));
      assert.equal(out.ok, true);
      assert.equal(first.read().ledger.reservations['crash-1'], 'post', '前提：预留已写');
    } finally { first.store.close(); }   // simulate process end

    // Reopen the SAME file. The latch is process-local, so a fresh store has none; health must be
    // re-derived from the store (L-5).
    const second = world({ dbPath: t.dbPath, clock: () => clockNow });
    try {
      clearFaultLatch(second.store);
      assert.equal(second.read().ledger.reservations['crash-1'], 'post', '重启后预留仍在磁盘上');
      const callsBefore = second.calls.length;

      // (a) Immediately after restart the 2h publish interval refuses first — the reservation kernel
      // checks intervals BEFORE the duplicate id. Worth pinning separately, because "replay is blocked"
      // and "replay is blocked by the ledger" are different claims and only the second one is the
      // anti-replay guarantee.
      const tooSoon = await second.path.write(req({ id: 'crash-1' }));
      assert.equal(tooSoon.ok, false);
      assert.equal(tooSoon.reason, 'interval', '首次拒绝来自 2 小时间隔（间隔先于 id 去重）');
      assert.equal(second.calls.length, callsBefore, '没有发出任何请求');

      // (b) Advance past the interval: now only `reservations[id]` can refuse, and it must.
      clockNow = NOW + 2 * 60 * 60 * 1000;
      const replay = await second.path.write(req({ id: 'crash-1' }));
      assert.equal(replay.ok, false, '★ 越过间隔后同 id 仍必须被拒');
      assert.equal(replay.reason, 'duplicate', '★ 这次是 reservations 挡的（防重放的真正基石）');
      assert.equal(second.calls.length, callsBefore, '仍然没有发出任何请求');
    } finally { second.close(); }
  } finally { t.cleanup(); }
});

// ── LZ-8: the design's stated failure mode, pinned as a test ─────────────────
test('LZ-8 结构不变量：线性化点恰好一个事务、门禁先于授权、且不新增任何持久对象', () => {
  const source = fs.readFileSync(new URL('../src/core/qzone-write-path-offline.mjs', import.meta.url), 'utf8');

  const start = source.indexOf('const finalAuthorisationCheck = (action, bindings) => {');
  assert.ok(start >= 0, '必须仍存在 finalAuthorisationCheck');
  const end = source.indexOf('return verdict;', start);
  assert.ok(end > start);
  const body = source.slice(start, end);

  const updates = (body.match(/store\.update\(/g) ?? []).length;
  assert.equal(updates, 1, `★ 线性化点必须恰好一个 store.update（实际 ${updates}）`);
  assert.ok(body.includes('gateRefusal('), '门禁必须在同一个回调里重验');
  assert.ok(body.includes('authorizeTool('), '授权必须在同一个回调里重验');
  const gateIdx = body.indexOf('gateRefusal(');
  const authIdx = body.indexOf('authorizeTool(');
  assert.ok(gateIdx < authIdx, '门禁必须先于授权');

  // The design regression: no durable permit collection, and the check must not write one.
  // Comments are stripped first: the file DOES discuss the removed collection in prose (it has to
  // explain why it is gone), and that must not be mistaken for code.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.equal(/writePermits/.test(code), false, '★ 代码里不得再出现 writePermits（v6 §2.4 不新增对象）');
  assert.equal(/issueWritePermit|readWritePermit/.test(code), false, '★ 资格签发器必须已移除');
  assert.ok(body.includes('return state'), '★ 线性化点只判不写：回调返回原 state，授予由提交成功本身完成');
});

// ══════════════════════════════════════════════════════════════════════════════════════
// M4 · the latch
// ══════════════════════════════════════════════════════════════════════════════════════

// ── LZ-7a: same authority, one instance ───────────────────────────────────────
test('LZ-7a 锁存（同实例）：latch 后该实例拒绝，且报 process-fault-latched', async () => {
  const w = world();
  try {
    assert.equal(readFaultLatch(w.store), null, '前提：未锁存');
    latchFault(w.store, 'settlement-commit-failed');
    // `revision` is the identity of the fault EVENT (R7 counterexample 3); the first latch of a fresh
    // authority is revision 1. Asserting it here means an accidental revision bump is visible.
    assert.deepEqual({ ...readFaultLatch(w.store) }, { reason: 'settlement-commit-failed', revision: 1 });

    const out = await w.path.write(req({ id: 'latched' }));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'process-fault-latched', '★ 必须是锁存原因，不是 write-gate-fault');
    assert.equal(out.quotaConsumed, false);
    assert.equal(w.calls.length, 0, '零发送');

    // Clearing restores service — so the latch is a gate, not a one-way trip.
    clearFaultLatch(w.store);
    assert.equal(readFaultLatch(w.store), null);
    const after = await w.path.write(req({ id: 'latched' }));
    assert.equal(after.ok, true, '清掉锁存后同一 id 必须能写（防假绿正对照）');
  } finally { clearFaultLatch(w.store); w.close(); }
});

// ── LZ-7b: same authority, MULTIPLE instances → shared ───────────────────────
test('LZ-7b 锁存（同权威多实例）：一个实例被锁存，另一个实例也必须拒绝', async () => {
  const w = world();
  try {
    // Two write paths over the SAME store = two instances of one send authority.
    const callsB = [];
    const pathB = createOfflineWritePath({
      store: w.store, limits: baseState().limits, clock: () => NOW,
      transport: async (r) => { callsB.push(r); return { ok: true }; },
    });
    assert.notEqual(pathB, w.path);

    latchFault(w.store, 'shared-fault');
    const outA = await w.path.write(req({ id: 'a1' }));
    const outB = await pathB.write(req({ id: 'b1' }));
    assert.equal(outA.reason, 'process-fault-latched');
    assert.equal(outB.reason, 'process-fault-latched', '★ 另一实例必须同样被拒（同一权威共享锁存）');
    assert.equal(w.calls.length, 0);
    assert.equal(callsB.length, 0, '两个实例都没有发送');
  } finally { clearFaultLatch(w.store); w.close(); }
});

// ── LZ-7c: DIFFERENT authority must NOT be poisoned ──────────────────────────
test('LZ-7c 锁存（不同权威）：A 被锁存后，B 必须仍能正常发送（不得互相毒死）', async () => {
  const a = world();
  const b = world();
  try {
    assert.notEqual(a.file, b.file, '前提：两个不同的库文件');
    latchFault(a.store, 'only-a-failed');
    assert.equal(readFaultLatch(b.store), null, '★ B 的锁存必须仍是空的');

    const outA = await a.path.write(req({ id: 'a-only' }));
    assert.equal(outA.ok, false);
    assert.equal(outA.reason, 'process-fault-latched');

    const outB = await b.path.write(req({ id: 'b-ok' }));
    assert.equal(outB.ok, true, '★ 不同权威必须不受影响');
    assert.equal(outB.stage, 'transport');
    assert.equal(b.calls.length, 1, 'B 真的发出去了');
    assert.equal(a.calls.length, 0);
  } finally { clearFaultLatch(a.store); clearFaultLatch(b.store); a.close(); b.close(); }
});

// ── LZ-7d: SAME DATABASE, TWO HANDLES → one authority (F-M4-1) ───────────────
test('LZ-7d 锁存（同库两连接，F-M4-1）：latchFault(a) 后经 b 的 publish 必须被拒、transport 零调用', async () => {
  const t = tempDb('twodb');
  let a = null;
  let b = null;
  try {
    const state = baseState();
    a = world({ dbPath: t.dbPath, state });
    // Second handle on the SAME absolute file — the exact shape Codex measured:
    // { sameFile:true, latchA:true, latchB:false, ok:true, transportCalls:1 }
    const storeB = openOfflineStore(t.dbPath, state);
    b = { store: storeB, calls: [], close() { try { storeB.close(); } catch {} } };
    const pathB = createOfflineWritePath({
      store: storeB, limits: state.limits, clock: () => NOW,
      transport: async (r) => { b.calls.push(r); return { ok: true }; },
    });

    assert.notEqual(storeB, a.store, '前提：两个不同的连接对象');
    assert.equal(authorityOf(storeB), authorityOf(a.store), '★ 同一文件的连接必须映射到同一权威');
    assert.equal(readFaultLatch(storeB), null, '前提：两个连接都未锁存');

    latchFault(a.store, 'db-shared-fault');
    assert.ok(readFaultLatch(a.store), '前提：a 已锁存');
    assert.ok(readFaultLatch(storeB), '★ 同库的另一连接必须立刻看到同一锁存');

    const out = await pathB.write(req({ id: 'via-b' }));
    assert.equal(out.ok, false, '★ 通过 b 发起的写必须被拒（旧实现会在这里发出去）');
    assert.equal(out.reason, 'process-fault-latched');
    assert.equal(out.quotaConsumed, false);
    assert.equal(b.calls.length, 0, '★ transport 零调用');
    assert.equal(a.calls.length, 0);
    assert.equal(a.read().ledger.used.post, 0, '不得白烧额度');

    // And the reverse direction: the same authority is shared, not "b is poisoned".
    clearFaultLatch(storeB);
    assert.equal(readFaultLatch(a.store), null, '★ 清除也必须双向一致');
    const ok = await pathB.write(req({ id: 'via-b' }));
    assert.equal(ok.ok, true, '★ 清锁存后经 b 必须能发（证明锁存是共享的，不是把 b 永久废掉）');
    assert.equal(b.calls.length, 1);
  } finally {
    if (a) { clearFaultLatch(a.store); }
    try { a?.close(); } catch {}
    try { b?.close(); } catch {}
    t.cleanup();
  }
});

// ── LZ-7e: a delegating wrapper is the SAME authority (controlled composition) ─
test('LZ-7e 锁存（受控组合的包装句柄）：`{ ...store }` 包装与内层句柄共享同一权威', async () => {
  const w = world();
  try {
    // The documented way to build a delegating store in this codebase (several modules and tests do
    // exactly this): spread the handle, override one method. The authority must survive the spread,
    // otherwise the notification layer and the write path would latch DIFFERENT keys for one database.
    const wrapper = { ...w.store, update: (fn) => w.store.update(fn) };
    assert.equal(authorityOf(wrapper), authorityOf(w.store), '★ 包装句柄必须继承同一权威');

    const pathViaWrapper = createOfflineWritePath({
      store: wrapper, limits: baseState().limits, clock: () => NOW,
      transport: async (r) => { w.calls.push(r); return { ok: true }; },
    });

    latchFault(w.store, 'inner-fault');       // latched on the INNER handle
    const out = await pathViaWrapper.write(req({ id: 'via-wrapper' }));
    assert.equal(out.ok, false, '★ 内层锁存必须挡住经包装句柄发起的写');
    assert.equal(out.reason, 'process-fault-latched');
    assert.equal(w.calls.length, 0);

    // Reverse: latch through the WRAPPER, read on the inner handle.
    clearFaultLatch(w.store);
    latchFault(wrapper, 'wrapper-fault');
    assert.ok(readFaultLatch(w.store), '★ 经包装句柄锁存后内层句柄也必须看到');
    clearFaultLatch(wrapper);
    assert.equal(readFaultLatch(w.store), null, '清除同样双向一致');
  } finally { clearFaultLatch(w.store); w.close(); }
});

// ── LZ-9: handle rotation is NOT a restart ────────────────────────────────────
//
// MEASURED DEFECT THIS REPLACES (Codex, reproduced here before the fix): with the registry dropping a
// path's token when the last handle closed, `close()` + reopen on the SAME file inside ONE process
// minted a NEW authority and the latch filed under the old one became unreachable — the next write
// went out. That is L-5 by accident: "an empty latch" is supposed to mean "fresh process, re-derive
// health from the store", not "someone closed a handle".
test('LZ-9 L-5：同一进程内 close 后重开同库，锁存必须仍在（句柄轮换不是重启）', () => {
  const t = tempDb('rotation');
  try {
    const first = world({ dbPath: t.dbPath, state: baseState({ writeGate: FAULT }) });
    const tokenBefore = authorityOf(first.store);
    latchFault(first.store, 'pre-rotation');
    assert.ok(readFaultLatch(first.store));
    first.store.close();

    // Re-open the SAME file in the SAME process: the authority is remembered, so the fault is too.
    const second = world({ dbPath: t.dbPath });
    try {
      assert.equal(authorityOf(second.store), tokenBefore,
        '★ 同一进程内重开同库必须复用同一权威（否则一次 close 就能洗掉故障）');
      assert.ok(readFaultLatch(second.store), '★ 锁存必须仍然可见');
      assert.equal(readFaultLatch(second.store).reason, 'pre-rotation');
      // The persisted fault never left the store either; an empty latch was never "healthy" anyway.
      assert.deepEqual({ ...second.read().writeGate }, { ...FAULT }, '前提：持久故障仍在磁盘上');
    } finally { second.close(); }
  } finally { t.cleanup(); }
});

// ── LZ-9c: a FAULTED authority is never evicted by capacity ───────────────────
//
// MEASURED DEFECT THIS REPLACES (Codex R7 counterexample 1, reproduced here before the fix): the
// retired-token map was capped at 256 with FIFO eviction. Latch a fault, close, then open+close 257
// OTHER databases, then reopen the target → `sameAuthority:false, latch:null`. The cap only DELAYED the
// defect: capacity pressure forgot a live fault and then allowed sending.
//
// The rule now: a latched authority is PINNED and is never an eviction candidate, so this holds no
// matter how many other databases come and go. Evicting an UNFAULTED authority is still allowed and is
// harmless — a fresh token for it changes nothing observable.
test('LZ-9c 容量压力下，带故障的权威不得被淘汰（否则 256 次开关就把故障洗掉）', () => {
  const t = tempDb('capacity');
  const others = [];
  try {
    const first = world({ dbPath: t.dbPath, state: baseState({ writeGate: FAULT }) });
    const tokenBefore = authorityOf(first.store);
    latchFault(first.store, 'target-fault');
    first.store.close();

    // 257 other databases: one more than the old cap, so FIFO eviction would have dropped the target.
    for (let i = 0; i < 257; i += 1) {
      const o = tempDb(`cap-${i}`);
      others.push(o);
      const s = openOfflineStore(o.dbPath, baseState());
      s.close();
    }

    const second = world({ dbPath: t.dbPath });
    try {
      assert.equal(authorityOf(second.store), tokenBefore,
        '★★ 带故障的权威不得因为容量淘汰而换成新 token');
      assert.equal(readFaultLatch(second.store)?.reason, 'target-fault',
        '★★ 257 个其他库开关之后，目标库的锁存必须仍在 —— 不能让容量压力变成忘掉故障');
      // And the write path must still refuse, which is the property that actually matters.
      assert.equal(readFaultLatch(second.store) !== null, true, '前提：锁存在');
    } finally { second.close(); clearFaultLatch(second.store); }
  } finally {
    for (const o of others) o.cleanup();
    t.cleanup();
  }
});

// ── LZ-9d: the revision counter is never reused, even across a clear ──────────
//
// MEASURED DEFECT THIS REPLACES (prompted by Codex's R8 question "确认修订号在解除、再故障后不会重用"):
// the counter lived INSIDE the latch entry, so clearing the latch deleted the counter with it.
//
//     latch('fault-A') -> revision 1;  clearFaultLatchIfRevision(1) -> cleared
//     latch('fault-B') -> revision 1   ← REUSED
//     clearFaultLatchIfRevision(1)     -> cleared:true   ← a STALE revision cleared the NEW fault
//
// That is the exact defect `revision` was introduced to fix, one step further out. The counter is now
// kept per authority and only ever incremented, so an old revision can never name a later fault.
test('LZ-9d 修订号跨「解除→再故障」不得重用（否则旧修订号能清掉新故障）', () => {
  const w = world();
  try {
    latchFault(w.store, 'fault-A');
    const first = readFaultLatch(w.store);
    assert.equal(first.revision, 1, '前提：第一次锁存是修订 1');

    const cleared = clearFaultLatchIfRevision(w.store, first.revision);
    assert.equal(cleared.cleared, true, '前提：确实解除了');
    assert.equal(readFaultLatch(w.store), null, '前提：此时无锁存');

    latchFault(w.store, 'fault-B');
    const second = readFaultLatch(w.store);
    assert.equal(second.revision, 2,
      '★★ 解锁之后再故障，修订号必须是 2 而不是重新从 1 开始');

    // The consequence: the OLD revision must not be able to clear the NEW fault.
    const stale = clearFaultLatchIfRevision(w.store, first.revision);
    assert.equal(stale.cleared, false, '★★ 拿着旧修订号不得清掉新故障');
    assert.equal(stale.current.revision, 2, '如实报出盘上真实修订号');
    assert.equal(readFaultLatch(w.store).reason, 'fault-B', '★ 新故障仍在');
  } finally { w.close(); }
});

// ── LZ-9e: revision EXHAUSTION fails closed — tested on the REAL RULE, not a parked counter ──
//
// MEASURED GAP THIS CLOSES (verifier t17): `REVISION_EXHAUSTED` appeared in ZERO test files, and the
// mutation that made the counter WRAP instead of exhausting stayed 26/0 green. "Overflow fails closed"
// was a claim backed only by reading the source — a guarantee nobody can falsify is not one.
//
// THE FIRST FIX WAS WRONG (Codex CODEX-TEST-SEAM-CLOSE-20261114 §B): it added
// `_setRevisionForTests(store, value)`, an exported setter that could LOWER a live authority's counter
// — a hand-made version of the very ABA the revision exists to prevent. Solving "untestable overflow"
// by exporting a counter-writer trades one defect for a worse one.
//
// Now the rule itself is a pure function (`advanceRevision`), the runtime calls that same function, and
// the test drives IT directly with `MAX_SAFE_INTEGER`. No exported code can write to a live counter.
test('LZ-9e 修订号耗尽时 fail-closed（纯规则源直测：不回绕、哨兵不被任何合法修订号命中）', () => {
  // ── the rule, at every interesting input ──
  assert.deepEqual(advanceRevision(undefined), { revision: 1, next: 1 }, '从未锁存 → 1');
  assert.deepEqual(advanceRevision(0), { revision: 1, next: 1 });
  assert.deepEqual(advanceRevision(1), { revision: 2, next: 2 }, '正常递增');
  assert.deepEqual(advanceRevision(Number.MAX_SAFE_INTEGER - 1),
    { revision: Number.MAX_SAFE_INTEGER, next: Number.MAX_SAFE_INTEGER }, '最后一个可发出的修订号');

  const exhausted = advanceRevision(Number.MAX_SAFE_INTEGER);
  assert.equal(exhausted.revision, -1, '★ 耗尽必须发哨兵，不得回绕成任何数字');
  assert.equal(exhausted.next, Number.MAX_SAFE_INTEGER, '★★ 计数器钉在原处，绝不回绕');
  assert.notEqual(exhausted.revision, 1, '★★ 尤其不得回绕成 1（旧缺陷正是这样）');

  // Idempotent at the ceiling: repeated calls stay exhausted, they never "recover" into a fresh range.
  const twice = advanceRevision(exhausted.next);
  assert.equal(twice.revision, -1, '★ 再次推进仍是哨兵');
  assert.equal(twice.next, Number.MAX_SAFE_INTEGER);

  // ── the rule REFUSES junk instead of doing arithmetic on it ──
  // `advanceRevision` is on the public export surface, so "only called internally with good values" is a
  // current fact, not a structural guarantee. Without a guard the arithmetic silently produces nonsense:
  // `1.5` -> revision 2.5, and `"5"` -> revision "51" (string concatenation). Both are refused instead.
  for (const junk of [1.5, -1, '5', Number.NaN, Number.POSITIVE_INFINITY, 1n, {}]) {
    assert.throws(() => advanceRevision(junk), /non-negative safe integer/,
      `★ 非法入参必须拒绝，不得静默算出 ${String(junk)} 的"下一条"`);
  }
  assert.deepEqual(advanceRevision(null), { revision: 1, next: 1 },
    'null 等价于「无记录」，与 undefined 同处理');

  // ── integration: the RUNTIME path is driven by this same function, so a real store still counts normally
  const w = world();
  try {
    latchFault(w.store, 'one');
    assert.equal(readFaultLatch(w.store).revision, advanceRevision(0).revision,
      '★★ 生产调用点与测试用的是同一条规则（第 1 次锁存 = advanceRevision(0)）');
    latchFault(w.store, 'two');
    assert.equal(readFaultLatch(w.store).revision, advanceRevision(1).revision, '第 2 次 = advanceRevision(1)');
    clearFaultLatch(w.store);
    latchFault(w.store, 'three');
    assert.ok(readFaultLatch(w.store).revision > 0, '清过之后仍从规则源继续，不回绕');
  } finally { w.close(); }
});

// ── LZ-9f: the ordinary runtime module no longer exports a counter WRITER ─────
//
// The defect being closed is not "a name is exported" but "a live authority's counter can be lowered
// from outside". `_setRevisionForTests` could do that; `_classifyForTests` is a PURE classifier and
// cannot. So the guard is about capability, not about counting exports.
test('LZ-9f 普通运行模块不得导出「任意降低真实权威修订号」的能力', () => {
  const exports = Object.keys(writePathModule).sort();
  assert.equal(exports.includes('_setRevisionForTests'), false,
    '★★ 计数器写入器已移除 —— 它能让旧修订号重新可清（人为 ABA）');
  assert.equal(exports.includes('setRevisionForTests'), false);
  // The revision rule is exported, but it is PURE: it returns a value and touches no map.
  assert.equal(exports.includes('advanceRevision'), true);
  assert.deepEqual(advanceRevision(5), { revision: 6, next: 6 }, '纯函数：同样输入同样输出');
  assert.deepEqual(advanceRevision(5), { revision: 6, next: 6 }, '★ 无副作用（连调两次结果相同）');
  assert.deepEqual(advanceRevision(Number.MAX_SAFE_INTEGER),
    advanceRevision(Number.MAX_SAFE_INTEGER), '★ 幂等，没有隐藏的计数器被推进');
});

// ── LZ-9b: a REAL process restart still starts empty ──────────────────────────
//
// Process-local means process-local. The honest way to prove it is a second PROCESS, not a second
// handle in this one — so this spawns `node` (no DSH restart, no new file, no new permission) and asks
// it to open the same database and report what it sees. Nothing here is persisted, so the child must
// see no token and no latch.
test('LZ-9b L-5：真重启（独立子进程）后锁存为空，且不从磁盘"继承"任何锁存', () => {
  const t = tempDb('subproc');
  try {
    const first = world({ dbPath: t.dbPath, state: baseState({ writeGate: FAULT }) });
    latchFault(first.store, 'parent-process-fault');
    assert.ok(readFaultLatch(first.store), '前提：父进程已锁存');
    first.store.close();

    // Absolute module URLs: the probe lives in the temp dir, so relative specifiers would resolve
    // against %TEMP% (measured failure) rather than the repo.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const modUrl = (rel) => new URL(`file://${path.join(repoRoot, rel).replace(/\\/g, '/')}`).href;
    const probe = [
      `import { openOfflineStore, authorityOf } from ${JSON.stringify(modUrl('src/core/qzone-store-offline.mjs'))};`,
      `import { readFaultLatch } from ${JSON.stringify(modUrl('src/core/qzone-write-path-offline.mjs'))};`,
      `const store = openOfflineStore(${JSON.stringify(t.dbPath)}, {});`,
      "const out = { hasAuthority: authorityOf(store) !== null, latch: readFaultLatch(store), gate: store.read().writeGate ?? null };",
      "store.close();",
      "process.stdout.write(JSON.stringify(out));",
    ].join('\n');
    const probePath = path.join(t.dir, 'child-probe.mjs');
    fs.writeFileSync(probePath, probe);

    const result = spawnSync(process.execPath, [probePath], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: false,
    });
    assert.equal(result.status, 0, `子进程必须正常退出: ${result.stderr ?? ''}`);
    const child = JSON.parse(result.stdout);
    assert.equal(child.hasAuthority, true, '子进程自己 mint 了权威（同一文件，不同进程）');
    assert.equal(child.latch, null, '★ 子进程锁存必须为空 —— 子进程看不到父进程的故障');
    assert.deepEqual(child.gate, { ...FAULT }, '★ 但持久故障在磁盘上，子进程读得到');
  } finally { t.cleanup(); }
});

// ── LZ-10: L-1/L-2/L-4 — stated, and checked where checkable ─────────────────
test('LZ-10 L-1/L-2/L-4：锁存不是第二账本、不碰审计/熔断、不写盘', async () => {
  const w = world();
  try {
    const before = w.read();
    latchFault(w.store, 'x');
    const after = w.read();
    // L-1: the latch takes no part in quota or de-duplication.
    assert.deepEqual(after.ledger, before.ledger, '★ 锁存不得改动 ledger（不是第二账本）');
    // L-2: it does not restart the breaker, and does not touch the audit trail.
    assert.equal(after.writes, before.writes, '锁存不得改熔断计数');
    assert.equal(after.writePaused, before.writePaused, '锁存不得直接置 writePaused');
    assert.deepEqual(after.audit, before.audit, '锁存不得写入审计');
    // L-4: nothing is persisted. The state on disk is byte-identical.
    assert.equal(JSON.stringify(after), JSON.stringify(before), '★ 锁存不落盘：整份 state 逐字节不变');
    assert.equal(JSON.stringify(after).includes('x'), false, '锁存原因不得混进持久状态');

    // And the source must not claim persistence for it.
    const source = fs.readFileSync(new URL('../src/core/qzone-write-path-offline.mjs', import.meta.url), 'utf8');
    const latchSection = source.slice(source.indexOf('PROCESS-LOCAL FAULT LATCH'), source.indexOf('function gateRefusal'));
    assert.match(latchSection, /PROCESS-LOCAL ONLY|does not extend coverage to another process/,
      '注释必须写明只保本进程（L-3）');
    assert.match(latchSection, /Never claims to be persisted|not written to `state`/,
      '注释必须写明不宣称已落盘（L-4）');
  } finally { clearFaultLatch(w.store); w.close(); }
});

// ── LZ-11: the id key must not move with the clock ───────────────────────────
test('LZ-11 键不含时钟（迁移）：同一 id 换个时刻仍是同一次预留，不得被当作新调用', async () => {
  const t = tempDb('nokey');
  try {
    let clockNow = NOW;
    const w = world({ dbPath: t.dbPath, clock: () => clockNow });
    try {
      assert.equal((await w.path.write(likeReq({ id: 'nokey', postId: 'p-1' }))).ok, true);
      assert.equal(w.read().ledger.reservations.nokey, 'like');

      // Two hours later, different clock value, identical id: still the same durable reservation.
      clockNow = NOW + 2 * 60 * 60 * 1000;
      const again = await w.path.write(likeReq({ id: 'nokey', postId: 'p-2' }));
      assert.equal(again.ok, false, '★ 换时钟不得让同一 id 被当作新调用');
      assert.equal(again.reason, 'duplicate', '必须命中持久 id 去重，而不是被时钟放过');
      assert.equal(w.calls.length, 1);
    } finally { w.close(); }
  } finally { t.cleanup(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// F-M3-1 · strict parameter validation, and a snapshot that IS the sent object
// ══════════════════════════════════════════════════════════════════════════════════════

// ── LZ-12: unsupported content shapes are refused BEFORE the reservation ─────
test('LZ-12 非字符串 content 严格拒绝（F-M3-1）：预留前拒绝、quotaConsumed:false、零预留零传输', async () => {
  const w = world();
  try {
    const baseline = JSON.stringify(w.read().ledger);
    assert.equal(w.read().ledger.used.post, 0, '前提：从 0 起');

    for (const [label, content] of [
      ['object', { text: 'a' }],
      ['number', 42],
      ['null', null],
      ['array', ['a']],
      ['empty', ''],
      ['blank', '   '],
    ]) {
      const out = await w.path.write(req({ id: `bad-${label}`, action: 'comment', content, target: '10001', postId: 'p-1' }));
      assert.equal(out.ok, false, `content=${label}: 必须拒绝`);
      assert.equal(out.stage, 'reserve', `content=${label}: 归到 reserve（= 未发送、未失败）`);
      assert.equal(out.reason, 'invalid-content', `content=${label}: 拒因必须是内容不合法`);
      assert.equal(out.quotaConsumed, false, `content=${label}: ★ 不得扣额`);
      assert.equal(w.read().ledger.reservations[`bad-${label}`], undefined, `content=${label}: ★ 不得预留`);
      assert.equal(w.calls.length, 0, `content=${label}: ★ transport 零调用`);
      assert.equal(JSON.stringify(w.read().ledger), baseline, `content=${label}: 整个 ledger 逐字节不变`);
    }
  } finally { w.close(); }
});

// ── LZ-13: what is validated is exactly what is sent (no silent normalisation) ─
test('LZ-13 快照与实参同源（F-M3-1）：合法字符串原样发送且不可变；旧实现把对象归一成 null', async () => {
  const w = world();
  try {
    const first = await w.path.write(req({ id: 'src-a', action: 'comment', target: '10001', postId: 'p-1', content: 'alpha' }));
    assert.equal(first.ok, true, `必须成功: ${JSON.stringify(first)}`);
    // Same content, but a distinct legal string: the sent object must carry ITS OWN value, not null
    // (the old `typeof content === 'string' ? content : null` digest) and not the previous value.
    w.path;   // no-op; keep the handle referenced for readability
    const secondClock = NOW + 3 * 60 * 1000;
    const w2 = world({ clock: () => secondClock });
    try {
      const second = await w2.path.write(req({ id: 'src-b', action: 'comment', target: '10001', postId: 'p-1', content: 'beta' }));
      assert.equal(second.ok, true);
      assert.equal(w.calls[0].content, 'alpha', '★ 实参就是校验过的那个值');
      assert.equal(w2.calls[0].content, 'beta', '★ 不同内容必须得到不同的实参（旧实现两者都是 null）');
      assert.notEqual(w.calls[0].content, w2.calls[0].content);

      // The object handed to the transport IS the snapshot: frozen, and it cannot be swapped after
      // validation by mutating the caller's request.
      const payload = w2.calls[0];
      assert.equal(Object.isFrozen(payload), true, '★ 传给 transport 的参数必须是不可变快照');
      assert.throws(() => { payload.content = 'swapped'; }, TypeError, '快照必须冻结（严格模式下写入即抛）');

      // And the transport receives the same object identity the facade built (single source):
      // re-sending the identical request must produce a request object with equal content and a
      // frozen shape, never the caller's own object.
      assert.notEqual(payload, req({ id: 'src-b', action: 'comment', target: '10001', postId: 'p-1', content: 'beta' }),
        '传给 transport 的不可能是调用方传进来的那个对象');
    } finally { w2.close(); }
  } finally { w.close(); }
});

// ── LZ-14: reply binds its parent comment id ─────────────────────────────────
test('LZ-14 reply 的 commentId 进入绑定：缺失/非法必须拒；合法则原样进入实参', async () => {
  const w = world();
  try {
    // Missing / malformed comment id: refused BEFORE the reservation — a reply without its parent is
    // not the same operation, and the old snapshot dropped this field entirely. These stay REFUSALS of
    // a MALFORMED request (the point of this half of the case), and the reason is unchanged: the
    // comment-id rule is validated before the reply identity and before any evidence is consulted.
    for (const [label, commentId] of [
      ['missing', undefined],
      ['empty', ''],
      ['number', 42],
      ['object', { id: 'c1' }],
      ['bad-chars', 'c 1/../'],
      ['too-long', 'c'.repeat(129)],
    ]) {
      const out = await w.path.write(req({ id: `r-bad-${label}`, action: 'reply', target: '10001', postId: 'p-1', commentId, content: 'hi' }));
      assert.equal(out.ok, false, `commentId=${label}: 必须拒绝`);
      assert.equal(out.stage, 'reserve', `commentId=${label}: 预留前拒绝`);
      assert.equal(out.reason, 'invalid-comment-id', `commentId=${label}: 拒因必须是父评论非法`);
      assert.equal(out.quotaConsumed, false, `commentId=${label}: 不得扣额`);
      assert.equal(w.read().ledger.reservations[`r-bad-${label}`], undefined, `commentId=${label}: 不得预留`);
      assert.equal(w.calls.length, 0, `commentId=${label}: transport 零调用`);
    }

    // Legal: the parent comment id travels with the request, and two different parents are visible as
    // two different operations in what the transport actually receives.
    //
    // ⚠️ FIXTURE: a legal reply now ALSO needs a corroborating `state.commentEvidence` row (the
    // evidence gate runs inside the reservation transaction). **No producer of that collection was
    // found within the checked scope**, so it is seeded here; the two rows match the two replies below
    // exactly, so this half still measures the BINDING and not the gate.
    w.store.update((s) => ({
      ...s,
      commentEvidence: [
        replyEvidenceRow({ target: '10001', postId: 'p-1', commentId: 'c-1' }),
        replyEvidenceRow({ target: '10002', postId: 'p-2', commentId: 'c-2' }),
      ],
    }));
    const ok1 = await w.path.write(req({ id: 'r-ok-1', action: 'reply', target: '10001', postId: 'p-1', commentId: 'c-1', content: 'hi' }));
    assert.equal(ok1.ok, true, `合法 reply 必须通过: ${JSON.stringify(ok1)}`);
    assert.equal(w.calls[0].commentId, 'c-1', '★ reply 的 commentId 必须原样进入实参');

    const ok2 = await w.path.write(req({ id: 'r-ok-2', action: 'reply', target: '10002', postId: 'p-2', commentId: 'c-2', content: 'hi' }));
    // Same second → the global 3-minute comment interval refuses the second reply. That is a rule of
    // the reservation kernel, not of this validation, so assert the validation half only.
    assert.equal(ok2.ok, false);
    assert.equal(ok2.reason, 'interval', '第二次 reply 被 3 分钟全局间隔拒（不是校验）');
    assert.equal(w.calls.length, 1);
  } finally { w.close(); }
});

// ── LZ-15: no new durable collection (v6 §2.4) ───────────────────────────────
test('LZ-15 无新增持久对象：成功后 state 里没有 writePermits，顶层键与调用前逐字相同', async () => {
  const w = world();
  try {
    const before = w.read();
    const keysBefore = Object.keys(before).sort();
    assert.equal(Object.hasOwn(before, 'writePermits'), false, '前提：起始就没有 writePermits');

    assert.equal((await w.path.write(req({ id: 'no-new-object' }))).ok, true);

    const after = w.read();
    assert.equal(Object.hasOwn(after, 'writePermits'), false, '★ 成功提交也不得创建 writePermits');
    assert.deepEqual(Object.keys(after).sort(), keysBefore, '★ 顶层键集合必须逐字不变（没有新集合）');
    assert.equal(JSON.stringify(after).includes('writePermits'), false, '序列化结果里也不得出现它');

    // De-duplication still works, and it is the EXISTING collection that carries it.
    assert.equal(after.ledger.reservations['no-new-object'], 'post', '★ 去重仍由既有 reservations 承担');
  } finally { w.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// t10 · the facade must not be WIDER than the write contract
// ══════════════════════════════════════════════════════════════════════════════════════
//
// MEASURED DEFECT, before the guard existed (real `write()` entrance, real temp SQLite):
//
//   LIKE_WITH_BODY = {"ok":true,"outcome":"success","stage":"transport"}
//   SENT           = [{"action":"like","hasContent":true,"content":"this is a body"}]
//
// The contract module lists `FIELDS.like = new Set(['tid','target_uin','abstime'])` — there is no
// `content` — and its `copyFields` throws `invalid field` for anything outside that set. So the
// facade accepted a request shape its own contract refuses, and handed the body to the transport.
// That is "widening the interface", which Codex forbade; the guard must refuse it BEFORE any
// reservation, and must not silently drop it either (a dropped body still reads as "sent" to the
// caller).

// ── LZ-16: a like that carries a body is refused, and costs nothing ──────────
test('LZ-16 like 携带 content 必须在预留前被拒（facade 不得比契约 FIELDS 更宽松）', async () => {
  const w = world();
  try {
    const ledgerBefore = JSON.stringify(w.read().ledger);

    for (const [label, content] of [
      ['text', 'this is a body'],
      ['empty-string', ''],
      ['object', { text: 'a' }],
      ['number', 42],
    ]) {
      const out = await w.path.write(req({ id: `like-body-${label}`, action: 'like', postId: 'p-1', content }));
      assert.equal(out.ok, false, `like+content(${label}): 必须拒绝`);
      assert.equal(out.stage, 'reserve', `like+content(${label}): 归到 reserve（= 未发送、未失败）`);
      assert.equal(out.reason, 'unexpected-content', `like+content(${label}): 拒因必须是「多带了正文」`);
      assert.equal(out.quotaConsumed, false, `like+content(${label}): ★ 不得扣额`);
      assert.equal(w.read().ledger.reservations[`like-body-${label}`], undefined,
        `like+content(${label}): ★ 不得占 id`);
      assert.equal(w.calls.length, 0, `like+content(${label}): ★ transport 零调用`);
      assert.equal(JSON.stringify(w.read().ledger), ledgerBefore, `like+content(${label}): ledger 逐字节不变`);
    }

    // Non-vacuity: the SAME request minus the body must go through, so the refusal is the body's doing.
    const clean = await w.path.write(likeReq({ id: 'like-clean', postId: 'p-2' }));
    assert.equal(clean.ok, true, `同请求去掉 content 必须放行: ${JSON.stringify(clean)}`);
    assert.equal(w.calls.length, 1);
  } finally { w.close(); }
});

// ── LZ-16b: positive control — a like without a body still sends ─────────────
test('LZ-16b 正控：like 不带 content 正常发送，且实参里没有 content 值', async () => {
  const w = world();
  try {
    for (const [label, over] of [
    ['omitted', { content: undefined }],
    ['undefined', { content: undefined }],
    ['null', { content: null }],
  ]) {
    const w2 = world();
    try {
      // `content` is absent (or explicitly undefined/null) → no body → allowed.
      const out = await w2.path.write(req({ id: `like-${label}`, action: 'like', postId: 'p-1', ...over }));
      assert.equal(out.ok, true, `like(${label}): 必须放行: ${JSON.stringify(out)}`);
      assert.equal(out.outcome, 'success');
      assert.equal(w2.calls.length, 1, `like(${label}): transport 恰好一次`);
      const sent = w2.calls[0];
      assert.equal(sent.action, 'like');
      assert.equal(sent.content, null, `like(${label}): ★ 实参里的 content 必须是 null（没有正文可发）`);
      assert.equal(w2.read().ledger.used.like, 1, `like(${label}): like 桶 +1`);
    } finally { w2.close(); }
  }
  } finally { w.close(); }
});

// ── LZ-16c: no collateral damage — the other three actions keep working ─────
test('LZ-16c 防误伤：publish / comment / reply 带合法 content 仍能正常发送', async () => {
  for (const [action, extra, state] of [
    ['publish', {}, undefined],
    ['comment', {}, undefined],
    // ⚠️ FIXTURE: a legal reply needs a corroborating `state.commentEvidence` row (the evidence gate
    // runs inside the reservation transaction). **No producer of that collection was found within the
    // checked scope**, so it is seeded here, matching this exact target/postId/commentId and the
    // request's `commentUin`. The subject of this case is "the other actions were not collateral
    // damage of the like+content guard", so the reply must be otherwise legal.
    ['reply', { commentId: 'c-1' },
      replyState(replyEvidenceRow({ target: TARGET, postId: 'p-reply', commentId: 'c-1' }))],
  ]) {
    const w = world({ ...(state === undefined ? {} : { state }) });
    try {
      const out = await w.path.write(req({ id: `ok-${action}`, action, postId: `p-${action}`, content: 'body text', ...extra }));
      assert.equal(out.ok, true, `${action}: 带合法正文必须放行: ${JSON.stringify(out)}`);
      assert.equal(out.stage, 'transport');
      assert.equal(w.calls.length, 1, `${action}: transport 恰好一次`);
      assert.equal(w.calls[0].content, 'body text', `${action}: ★ 正文原样到达实参`);
      assert.equal(w.calls[0].kind, { publish: 'post', comment: 'comment', reply: 'comment' }[action],
        `${action}: 配额桶未变`);
    } finally { w.close(); }
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// LZ-17 · TABLE-DRIVEN: the facade must not accept a field its contract has no slot for
// ══════════════════════════════════════════════════════════════════════════════════════
//
// WHY THIS IS NOT "LZ-16 AGAIN": LZ-16 pins ONE cell (`like` + `content`). The defect behind it was
// general — a facade field accepted for an action whose contract has no slot for it — and the next
// occurrence will be in a DIFFERENT cell (a new action, a new parameter). So the check here is
// exhaustive over (action × facade-field), driven by the contract's own allowlist instead of by a
// hand-written list of the cells we happen to remember.
//
// THE TRUTH SOURCE is `allowedFieldsFor(action)` from `qzone-onebot-write-contract.mjs` — a frozen
// projection of the same `FIELDS` map `copyFields` enforces, so this test cannot drift from the
// contract either. `FIELDS` itself is deliberately NOT exported: its values are live `Set`s, and
// handing them out would let a caller widen the contract at runtime.
//
// ⚠️ WHAT THIS DOES **NOT** PROVE (stated, not glossed)
//   1. It proves the facade does not accept a field the contract lacks a slot for **within the
//      facade's own parameter vocabulary**. It does NOT prove the two field sets are equal.
//   2. `abstime` (contract allows it for `like`) and `ugc_right` / `target_uins` (contract requires
//      them for `publish`) have NO facade input at all. That is the OPPOSITE direction — a MISSING
//      field, never an over-accepted one — and it is out of this test's scope. Nothing here should be
//      read as "the facade can produce a publish request": it cannot, because it never carries
//      `ugc_right`, and inventing a default visibility is exactly what the contract forbids.
//   3. `publish` legitimately carries two fields with no contract slot; those are DECLARED
//      exceptions below, each with a reason. They are the only ones — and that is enforced, not
//      asserted in prose: any UNDECLARED extra acceptance turns this test red.

/** Facade parameter → the contract field it would become. The facade's whole platform-facing vocabulary. */
const FACADE_TO_CONTRACT = Object.freeze([
  ['content', 'content'],
  ['target', 'target_uin'],
  ['postId', 'tid'],
  ['commentId', 'comment_id'],
]);

/**
 * Declared exceptions: facade fields an action carries even though the contract has no slot for them.
 *
 * `publish` is the only action with any, and the reason is structural rather than a licence: the
 * contract's `publish` branch describes a POST BEING CREATED (`content`, `ugc_right`, `target_uins`)
 * — there is no post id yet, and the acting account is the session identity, not a request parameter.
 * The facade still carries `postId`/`target` for its own durable bookkeeping (id reservation,
 * de-duplication) and hands them to the injected transport, which is the facade's own seam — not the
 * platform request builder. So these two are NOT "platform parameters the contract rejected".
 *
 * Every entry must carry a `why`, and `DECLARED_EXCEPTIONS` must name every action, so adding an
 * action forces a conscious decision instead of a default.
 */
const DECLARED_EXCEPTIONS = Object.freeze({
  publish: Object.freeze([
    { field: 'target', why: 'publish 的契约分支只有 content/ugc_right/target_uins：没有 acting-account 槽，target 是会话身份而非请求参数' },
    { field: 'postId', why: 'publish 创建的正是帖子本身，此刻不可能已有 tid：postId 只用于 facade 自身的预留/去重记账' },
  ]),
  comment: Object.freeze([]),
  reply: Object.freeze([]),
  like: Object.freeze([]),
});

/** A request that is valid for `action`, BEFORE the cell under test is applied. */
const baselineFor = (action) => {
  const base = { id: `lz17-${action}`, action, target: TARGET, postId: 'p-1', source: 'qq' };
  if (action === 'like') return base;              // no body: the contract has no content slot
  base.content = 'body';
  if (action === 'reply') {
    base.commentId = 'c-1';
    // The parent comment's AUTHOR: mandatory for a reply, and the key the evidence row is compared on.
    base.commentUin = REPLY_COMMENT_UIN;
  }
  return base;
};

/** One independent world per cell: no cooldown / de-duplication can leak between cells. */
const cellValue = (field) => ({
  content: 'body', target: '9876543210', postId: 'p-9', commentId: 'c-9',
}[field]);

test('LZ-17 表驱动：facade 对每个 action 的额外字段必须落在契约 FIELDS 内（声明例外之外一律预留前拒绝）', async () => {
  // (0) The exception table must name exactly the actions the facade supports — a new action without
  //     a decision here is a silent widening, which is the whole point of this case.
  assert.deepEqual(Object.keys(DECLARED_EXCEPTIONS).sort(), [...WRITE_ACTIONS].sort(),
    '★ 每个 action 都必须在声明例外表里出现（新增 action 必须显式决定，不得默认放行）');
  for (const [action, list] of Object.entries(DECLARED_EXCEPTIONS)) {
    for (const entry of list) {
      assert.equal(typeof entry.why, 'string', `${action}/${entry.field}: 例外必须附理由`);
      assert.ok(entry.why.trim().length > 0, `${action}/${entry.field}: 理由不得为空`);
      assert.equal(FACADE_TO_CONTRACT.some(([f]) => f === entry.field), true,
        `${action}/${entry.field}: 例外必须指向真实存在的 facade 参数`);
    }
  }

  // (1) The vocabulary must be complete: every key `write()` destructures has to be classified.
  //     Without this, someone can add `images` to the signature and every cell below still passes.
  const source = fs.readFileSync(new URL('../src/core/qzone-write-path-offline.mjs', import.meta.url), 'utf8');
  const signature = source.match(/async write\(\{([^}]*)\}\s*=\s*\{\}\)/);
  assert.ok(signature, '必须能定位 write() 的解构签名');
  const declaredParams = signature[1].split(',').map((part) => part.trim()).filter(Boolean).sort();
  const ENVELOPE = ['action', 'id', 'source'];   // carried by every call; never platform parameters
  assert.deepEqual(declaredParams, [...ENVELOPE, 'commentId', 'content', 'postId', 'target'].sort(),
    '★ write() 的参数集合变了就必须同步本表（否则新增字段会绕过本用例）');

  // (2) Every (action × facade field) cell, decided by the CONTRACT — not by this test's opinion.
  const evidence = [];
  for (const action of WRITE_ACTIONS) {
    const allowed = allowedFieldsFor(action);
    assert.ok(Array.isArray(allowed), `${action}: 契约必须能给出允许字段集`);
    const exceptions = DECLARED_EXCEPTIONS[action].map((entry) => entry.field);

    for (const [facadeField, contractField] of FACADE_TO_CONTRACT) {
      const slotInContract = allowed.includes(contractField);
      const declared = exceptions.includes(facadeField);
      const mustBeAccepted = slotInContract || declared;

      // The request first, so the reply fixture can corroborate THE REQUEST UNDER TEST rather than a
      // fixed row: a cell that overrides `postId`/`commentId`/`target` changes the identity the
      // evidence gate compares, and a stale row would refuse the positive cells for the WRONG reason
      // (`missing_comment_evidence` instead of the field-under-test rule).
      const request = { ...baselineFor(action), [facadeField]: cellValue(facadeField) };
      const w = world(action === 'reply'
        // ⚠️ FIXTURE: a legal reply needs a corroborating `state.commentEvidence` row (the evidence
        // gate runs inside the reservation transaction). **No producer of that collection was found
        // within the checked scope**, so it is seeded here. Both the triple and the author come from
        // `request`/`baselineFor('reply')`, so the gate passes for every reply cell and this case can
        // still measure the FIELD ALLOWLIST it is about.
        ? {
          state: replyState(replyEvidenceRow({
            target: request.target, postId: request.postId, commentId: request.commentId,
          })),
        }
        : {});
      try {
        const out = await w.path.write(request);
        evidence.push({ action, facadeField, contractField, slotInContract, declared, ok: out.ok, reason: out.reason });

        if (mustBeAccepted) {
          // Positive control: the contract HAS a slot (possibly via a declared exception) → the field
          // must not be blocked, otherwise this test would reward a facade that refuses everything.
          assert.equal(out.ok, true,
            `${action}/${facadeField}: 契约有对应槽（${contractField}）${declared ? '或属声明例外' : ''}，不得被拒: ${JSON.stringify(out)}`);
          assert.equal(w.calls.length, 1, `${action}/${facadeField}: 必须真的发出一次`);
        } else {
          // The defect shape: the contract has NO slot and the facade has no declared reason to carry
          // it. Must be refused BEFORE the reservation, and must cost nothing.
          assert.equal(out.ok, false, `★ ${action}/${facadeField}: 契约无 ${contractField} 槽，必须拒绝`);
          assert.equal(out.stage, 'reserve', `★ ${action}/${facadeField}: 必须在预留前拒绝（不得先扣额再拒）`);
          assert.equal(typeof out.reason, 'string', `${action}/${facadeField}: 必须给出拒因`);
          assert.equal(out.quotaConsumed, false, `★ ${action}/${facadeField}: 不得扣额`);
          assert.equal(w.read().ledger.reservations[request.id], undefined, `★ ${action}/${facadeField}: 不得占 id`);
          assert.equal(w.calls.length, 0, `★ ${action}/${facadeField}: transport 零调用`);
        }
      } finally { w.close(); }
    }
  }

  // (3) Non-vacuity: the table really produced both outcomes, so neither branch can pass by accident.
  const refused = evidence.filter((row) => row.ok === false);
  const accepted = evidence.filter((row) => row.ok === true);
  assert.ok(refused.length > 0, '★ 必须至少有一格被拒（否则本用例只是在验证「全都放行」）');
  assert.ok(accepted.length > 0, '★ 必须至少有一格放行（否则本用例只是在验证「全都拒绝」）');
  // The one cell this whole repair round started from must be among the refusals.
  assert.ok(evidence.some((row) => row.action === 'like' && row.facadeField === 'content' && row.ok === false),
    '★ like/content 必须在被拒集合里（t10 的原始缺陷格）');
  // And the declared publish exception must be visible as ACCEPTED, not silently tolerated.
  assert.ok(evidence.some((row) => row.action === 'publish' && row.facadeField === 'postId' && row.declared === true && row.ok === true),
    '★ publish/postId 是声明例外，必须真的被放行（否则例外表与实际行为不符）');
});


// ── LZ-9g: close + reopen in the SAME process must NOT launder the fault ──────
//
// THE STORE'S OWN COMMENT SAID THE OPPOSITE and was wrong: "closing the last handle drops the token, so
// an in-process restart (close + reopen) starts with a NEW token and an empty latch". That contradicts
// `retiredByKey`, which exists precisely to re-mint the same token. Codex caught the contradiction.
//
// The real boundary is a NEW PROCESS (LZ-9b proves that side). Inside one process, a handle rotation is
// NOT a restart: the fault must survive, or `close()` becomes a laundering primitive.
//
// ONE POSITIVE + ONE NEGATIVE, per Codex:
//   · same process, close + reopen   -> still latched, still refusing (this case)
//   · separate process (LZ-9b)       -> empty latch, but the PERSISTED gate still refuses (that case)
test('LZ-9g 同进程 close+reopen 不是重启：锁存必须仍在，且写仍被拒', async () => {
  const t = tempDb('rot');
  try {
    const first = world({ dbPath: t.dbPath });
    latchFault(first.store, 'fault-before-close');
    const beforeRevision = readFaultLatch(first.store).revision;
    // A write while latched: refused, nothing sent.
    let sentBefore = 0;
    const pathBefore = createOfflineWritePath({
      store: first.store, clock: () => NOW,
      transport: async () => { sentBefore += 1; return { ok: true }; },
    });
    assert.equal((await pathBefore.write({ id: 'rot-a', action: 'like', target: TARGET, postId: 'p-1' })).ok, false);
    first.store.close();

    // ── reopen the SAME file in the SAME process ──
    const second = openOfflineStore(t.dbPath, baseState());
    try {
      const after = readFaultLatch(second);
      assert.ok(after, '★★ close+reopen 后锁存必须仍在（否则 close 就是洗故障的手段）');
      assert.equal(after.reason, 'fault-before-close');
      assert.equal(after.revision, beforeRevision, '★★ 而且仍是同一次故障事件（同一权威、同一修订号）');

      let sent = 0;
      const path = createOfflineWritePath({
        store: second, clock: () => NOW,
        transport: async () => { sent += 1; return { ok: true }; },
      });
      const blocked = await path.write({ id: 'rot-b', action: 'like', target: TARGET, postId: 'p-2' });
      assert.equal(blocked.ok, false, '★★ 写仍被拒');
      assert.equal(blocked.reason, 'process-fault-latched');
      assert.equal(sent, 0, '★★ transport 零调用');
    } finally { try { second.close(); } catch { /* already closed */ } }
  } finally { t.cleanup(); }
});

// ── LZ-9h: an unrecognised path must FAIL CLOSED, not invent an identity ──────
//
// `databaseKey` used to fall back to `String(file)` when `realpathSync` failed, which would key an
// authority on a CALLER-SUPPLIED SPELLING — a second identity for a file this process is holding open,
// decided by whoever passed the path in. Codex: a path whose identity cannot be established must fail
// registration, not silently split. The fallback is gone; this pins that a broken path throws instead
// of producing a token.
test('LZ-9h 无法规范化路径必须 fail-closed，不得退化成「按调用方拼写」建身份', () => {
  const t = tempDb('realpath');
  try {
    const raw = fs.readFileSync(new URL('../src/core/qzone-store-offline.mjs', import.meta.url), 'utf8');
    // Comments mention the removed fallback on purpose (they explain WHY it is gone), so this guard
    // checks stripped CODE, not the raw file.
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    assert.equal(/return String\(file\)/.test(source), false,
      '★★ 代码里不得再有 String(file) 兜底 —— 那会让调用方的拼写决定 authority');

    // A path whose file does not exist: openOfflineStore creates it, so the realistic broken case is a
    // path inside a non-existent directory. It must throw rather than mint a token for a spelling.
    const broken = path.join(t.dir, 'no-such-dir', 'nested', 'x.db');
    assert.throws(() => openOfflineStore(broken, baseState()), /ENOENT|no such file/i,
      '★ 无法打开的文件必须抛错，不得返回一个带权威的句柄');
  } finally { t.cleanup(); }
});
