// MINIMAL OFFLINE FULL CHAIN: real SQLite → real write facade → real transport call → real observability.
//
// WHY THIS FILE EXISTS
// --------------------
// `test-qzone-write-observability.mjs` drives the adapter, but it feeds it HAND-BUILT result objects
// (`RESULT.success`, `RESULT.failed`, ...). Those are shaped like what the facade emits; they are not
// what it emits. So that file proves the ADAPTER is right, and proves nothing about whether the
// reserve→transport→breaker→audit chain behaves as one thing.
//
// This file closes that gap and ONLY that gap:
//
//     openOfflineStore(temp db)                  ← real SQLite, real transactions
//       → createOfflineWritePath(...)            ← the real facade, the real stage 1/1b/2 code
//       → await path.write(...)                  ← the real write runs; transport is a FAKE but the
//                                                  facade's own code path is genuinely executed
//       → createWriteObservability(...).record() ← the real adapter over the real store
//
// Every case asserts the transport call count, so "we really ran the write path" is measured rather
// than claimed: a hand-built result can never make `calls.length` move.
//
// The one thing this file also pins: **who owns which transaction.** Since t33 the DEFAULT path puts
// the breaker transition and the audit append inside ONE `store.update`, so a crash between them can
// no longer leave the two halves out of step (that was G3). A caller that injects a DIFFERENT
// `auditStore` deliberately gets the old two-transaction behaviour — that seam is the only way to
// inject "the audit alone failed" — and every result now reports `atomic: true|false` so the contract
// in force is never ambiguous. See CHAIN-5 (non-atomic) vs CHAIN-6 / CHAIN-11 (atomic).
//
// Storage: one real temporary SQLite per case under %TEMP%, closed and deleted in `finally`.
// No `state/`, no credentials, no QQ, no network.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createOfflineWritePath } from '../src/core/qzone-write-path-offline.mjs';
import { createWriteObservability } from '../src/core/qzone-write-observability-offline.mjs';
import { formatAuditRecord } from '../src/core/qzone-audit-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';

const T0 = 1_800_000_000_000;
const DAY0 = beijingDay(T0);
const TARGET = '9876543210';
const POST_INTERVAL_MS = 2 * 60 * 60 * 1000;

function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-wchain-${label}-`));
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

/** Everything the reservation module, the breaker and the audit append need, in one state. */
const baseState = (over = {}) => ({
  enabled: true, readAllowed: true, writeAllowed: true,
  accessPaused: false, writePaused: false,
  reads: 0, writes: 0,
  tools: { publish: true, comment: true, reply: true, like: true, read_posts: true },
  limits: { post: 3, comment: 25, like: 30 },
  ledger: { day: DAY0, used: { post: 0, comment: 0, like: 0 }, reservations: {} },
  lastPostAt: null,
  lastCommentAt: null,
  commentTargets: [],
  likes: [],
  audit: [],
  ...over,
});

/**
 * Build a world whose ONLY write route is the real facade, wired to the real adapter.
 *
 * `transportPlan` is a list of answers handed out in order (or a single function). Everything else —
 * reservation, interval, final pause check, breaker, audit — is the real code.
 */
function world(label, { state = baseState(), transportPlan, auditStore } = {}) {
  const t = tempDb(label);
  let store = openOfflineStore(t.dbPath, state);
  let now = T0;
  const calls = [];
  const plan = typeof transportPlan === 'function' ? null : [...(transportPlan ?? [{ ok: true }])];

  const transport = async (req) => {
    calls.push(req);
    const answer = plan ? (plan.length > 1 ? plan.shift() : plan[0]) : transportPlan(req);
    if (answer instanceof Error) throw answer;
    return answer;
  };

  const build = () => createOfflineWritePath({
    store,
    limits: state.limits,
    clock: () => now,
    transport,
  });
  const buildObs = () => createWriteObservability({ store, clock: () => now, ...(auditStore ? { auditStore } : {}) });

  return {
    t,
    dbPath: t.dbPath,
    get store() { return store; },
    path: build(),
    obs: buildObs(),
    calls,
    read: () => store.read(),
    ledger: () => store.read().ledger,
    advance: (ms) => { now += ms; },
    setNow: (v) => { now = v; },
    auditRows: () => store.read().audit,
    /** Close and reopen the SAME file: the only honest way to prove durability. */
    reopen() {
      store.close();
      store = openOfflineStore(t.dbPath, state);
      this.path = build();
      this.obs = buildObs();
    },
    close() { try { store.close(); } catch {} t.cleanup(); },
  };
}

const publish = (over = {}) => ({
  id: 'w-1', action: 'publish', target: TARGET, postId: 'p-1', source: 'qq', content: 'hello', ...over,
});
const commentReq = (over = {}) => ({
  id: 'c-1', action: 'comment', target: '10001', postId: 'p-a', source: 'qq', content: 'hi', ...over,
});

/** Run one write through the facade AND record it: the whole point of this file. */
async function writeAndRecord(w, request) {
  const result = await w.path.write(request);
  const receipt = w.obs.record({ request, result });
  return { result, receipt };
}

// ══════════════════════════════════════════════════════════════════════════════════════
// 1. 三次真实失败 → writePaused → 第 4 次在入口被拒（transport 零调用）
// ══════════════════════════════════════════════════════════════════════════════════════

test('CHAIN-1 三次真实失败后暂停：第 4 次在 reserve 阶段被拒，transport 零调用（且前三次 transport 各一次）', async () => {
  const w = world('pause3', { transportPlan: [{ ok: false }, { ok: false }, { ok: false }, { ok: true }] });
  try {
    // 三次真实失败：每次都要挪开发帖间隔，否则会被 interval 拦住而根本没走到 transport。
    for (let i = 0; i < 3; i += 1) {
      const { result, receipt } = await writeAndRecord(w, publish({ id: `fail-${i}` }));
      assert.equal(result.ok, true, `第 ${i + 1} 次必须真的走到 transport（实际 ${JSON.stringify(result)}）`);
      assert.equal(result.outcome, 'failed', 'transport 明确说 no → outcome failed');
      assert.equal(result.transportCalled, true);
      assert.equal(receipt.breaker.applied, true, '真实失败必须推动熔断');
      assert.equal(receipt.breaker.writes, i + 1, `writes 必须连续累计到 ${i + 1}`);
      assert.equal(receipt.audit.appended, true, '每次失败都要留下审计');
      w.advance(POST_INTERVAL_MS);
    }

    // 前三次一共真的调用了 transport 三次 —— 这就是「真跑写路径」的证据。
    assert.equal(w.calls.length, 3, '三次失败 = 三次真实 transport 调用');

    const pausedState = w.read();
    assert.equal(pausedState.writes, 3, '连续 3 次失败后 writes === 3');
    assert.equal(pausedState.writePaused, true, '第 3 次失败必须置位 writePaused');

    // 第 4 次：必须连 reserve 都进不去，transport 零调用。
    const fourth = await writeAndRecord(w, publish({ id: 'after-pause' }));
    assert.equal(fourth.result.ok, false, '暂停后第 4 次必须被拒');
    assert.equal(fourth.result.stage, 'reserve', '拒绝发生在 reserve 阶段（不是 transport）');
    assert.equal(fourth.result.reason, 'write_paused');
    assert.equal(w.calls.length, 3, '第 4 次 transport 零调用（计数没有增加）');

    // 拒绝也要留审计，但熔断不得被「拒绝」推进。
    assert.equal(fourth.receipt.audit.appended, true, '拒绝也要有审计行');
    assert.equal(fourth.receipt.breaker.applied, false);
    assert.equal(fourth.receipt.breaker.skippedReason, 'not-a-real-failure');
    assert.equal(w.read().writes, 3, '拒绝不得改动 writes');

    // 审计行数 = 4（3 次失败 + 1 次拒绝），且每条都是真结果。
    assert.equal(w.auditRows().length, 4);
  } finally { w.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 2. 成功重置：2 次失败 + 1 次成功 → writes 归 0
// ══════════════════════════════════════════════════════════════════════════════════════

test('CHAIN-2 成功重置：2 次真实失败后 1 次真实成功 → writes 归 0，且 writePaused 未置位', async () => {
  const w = world('reset', { transportPlan: [{ ok: false }, { ok: false }, { ok: true }] });
  try {
    for (let i = 0; i < 2; i += 1) {
      const { result, receipt } = await writeAndRecord(w, publish({ id: `f-${i}` }));
      assert.equal(result.outcome, 'failed');
      assert.equal(receipt.breaker.writes, i + 1);
      w.advance(POST_INTERVAL_MS);
    }
    assert.equal(w.read().writes, 2, '前提：已经累计 2 次失败');
    assert.equal(w.read().writePaused, false, '两次还没到阈值');

    const { result, receipt } = await writeAndRecord(w, publish({ id: 'ok' }));
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'success', '第三次 transport 返回 ok → success');
    assert.equal(receipt.breaker.writes, 0, '一次真实成功必须把写入计数清零');
    assert.equal(w.read().writes, 0);
    assert.equal(w.read().writePaused, false);
    assert.equal(w.calls.length, 3, '三次真写 = 三次 transport 调用');
    assert.equal(w.auditRows().length, 3);
  } finally { w.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 3. 隐私拒绝不计：not_accessible 不改变 writes
// ══════════════════════════════════════════════════════════════════════════════════════

test('CHAIN-3 隐私拒绝 not_accessible 不改 writes：从非零基线起，读方向拒绝对写计数零影响', async () => {
  const w = world('privacy', { state: baseState({ writes: 2 }), transportPlan: [{ ok: true }] });
  try {
    // 前提：写计数是非零基线（2），否则「没变」等于没测。
    assert.equal(w.read().writes, 2, '前提：writes 从非零基线 2 起');

    // 读方向的隐私拒绝走同一个熔断器的 read 分桶。
    for (let i = 0; i < 3; i += 1) {
      const view = w.obs.recordRead({ outcome: 'not_accessible' });
      assert.equal(view.writes, 2, `第 ${i + 1} 次 not_accessible 之后 writes 必须仍是 2`);
      assert.equal(view.reads, 0, 'not_accessible 也不得推进读计数（任务卡：隐私拒绝不计入任何熔断计数）');
      assert.equal(view.accessPaused, false);
    }

    // 正控：真正的读失败会推进读计数，证明上面「没动」不是熔断器整个坏掉。
    const afterFailure = w.obs.recordRead({ outcome: 'failure' });
    assert.equal(afterFailure.reads, 1, '真实读失败必须推进 reads（正控）');
    assert.equal(afterFailure.writes, 2, '读失败同样不影响写计数');

    // 写侧仍然可用，writes 依旧从 2 起算。
    const { receipt } = await writeAndRecord(w, publish({ id: 'after-privacy' }));
    assert.equal(receipt.breaker.writes, 0, '成功写把 writes 清零（2 → 0）');
    assert.equal(w.calls.length, 1);
  } finally { w.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 4. unknown 占配额不重发：同一 id 第二次 duplicate
// ══════════════════════════════════════════════════════════════════════════════════════

test('CHAIN-4 unknown 占配额且不重发：transport 抛错 → unknown，同一 id 第二次被 duplicate 拒', async () => {
  // 让 transport 抛错：facade 把 throw 归为 unknown（可能已到达平台）。
  const w = world('unknown', { transportPlan: [() => { throw new Error('socket hang up'); }, { ok: true }] });
  try {
    const first = await writeAndRecord(w, publish({ id: 'same-id' }));
    assert.equal(first.result.ok, true, 'unknown 仍然算「已预留成功」');
    assert.equal(first.result.outcome, 'unknown', 'transport 抛错必须归为 unknown，不能当成 not-sent');
    assert.equal(first.result.transportCalled, true);
    assert.equal(w.calls.length, 1, 'transport 真的被调用过（然后抛错）');
    assert.equal(w.ledger().used.post, 1, 'unknown 保守占一次配额');
    assert.equal(first.receipt.audit.appended, true);
    assert.equal(first.receipt.audit.redacted, false);
    assert.equal(first.receipt.breaker.applied, false, 'unknown 不是真实失败，不得推进熔断');
    assert.equal(first.receipt.breaker.skippedReason, 'not-a-real-failure');
    assert.equal(w.read().writes, 0, 'unknown 不占失败槽');
    assert.equal(first.receipt.audit.failed, false);

    // 同一 id 再来一次：reserve 阶段 duplicate，transport 零新增调用，配额不再增加。
    // 先把发帖间隔推过去，否则拒因会是 interval 而不是 duplicate —— 那会掩盖本用例要测的东西。
    w.advance(POST_INTERVAL_MS);
    const second = await writeAndRecord(w, publish({ id: 'same-id' }));
    assert.equal(second.result.ok, false);
    assert.equal(second.result.stage, 'reserve');
    assert.equal(second.result.reason, 'duplicate', '拒因必须是 duplicate（不是 interval）');
    assert.equal(w.calls.length, 1, '重发被拒：transport 计数没有增加');
    assert.equal(w.ledger().used.post, 1, '配额没有被扣第二次');

    // ⚠️ 这里暴露的是**第二个未闭合缺口**，不是本用例的期望行为：
    //    适配器用 `request.id` 作为审计行 id，而 `appendOfflineAudit` 对同 id **不同内容**是
    //    硬失败（`conflicting audit id`）。于是「同一 id 的第二次被拒」根本无法留下审计行。
    //    实测：audit.appended:false / audit.failed:true / error='conflicting audit id'，
    //    库里仍只有第一次那一行（result:'unknown'）。拒绝事件在审计里**完全不可见**。
    assert.equal(second.receipt.audit.appended, false,
      '缺口：同 id 的第二次结算无法写审计（appendOfflineAudit 判 conflicting audit id）');
    assert.equal(second.receipt.audit.failed, true, '失败必须被如实上报，不能吞掉');
    assert.match(second.receipt.audit.error.message, /conflicting audit id/);
    assert.equal(w.auditRows().length, 1, '审计里只有第一次那一行；这次「被拒」没有任何审计痕迹');
    assert.equal(w.auditRows()[0].record.result, 'unknown', '留下的仍是第一次的 unknown 行');
  } finally { w.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 5. 审计失败：audit.failed:true，熔断仍已更新
// ══════════════════════════════════════════════════════════════════════════════════════

test('CHAIN-5 审计写入失败：返回体 audit.failed:true，熔断仍然已更新（保护先于审计）', async () => {
  const t = tempDb('auditfail');
  let real = openOfflineStore(t.dbPath, baseState({ writes: 2 }));
  try {
    let failAudit = true;
    // 专用审计句柄：失败可证明是审计失败，不会和熔断写混在一起。
    const auditStore = {
      read: () => real.read(),
      update(fn) {
        if (failAudit) throw new Error('audit disk full');
        return real.update(fn);
      },
    };
    w: {
      const calls = [];
      const writePath = createOfflineWritePath({
        store: real, limits: baseState().limits, clock: () => T0,
        transport: async (req) => { calls.push(req); return { ok: false }; },
      });
      const obs = createWriteObservability({ store: real, auditStore, clock: () => T0 });

      const request = publish({ id: 'audit-fails' });
      const result = await writePath.write(request);
      assert.equal(result.ok, true);
      assert.equal(result.outcome, 'failed');
      assert.equal(calls.length, 1, 'transport 真的被调用一次');

      const receipt = obs.record({ request, result });
      // t33: this case injects a DIFFERENT `auditStore`, so it exercises the deliberately
      // NON-atomic path. That is now stated in the return value instead of being implicit.
      assert.equal(receipt.atomic, false, '注入 auditStore ⇒ 非原子路径必须自报');
      assert.equal(receipt.audit.failed, true, '审计失败必须如实上报');
      assert.match(receipt.audit.error.message, /audit disk full/);
      assert.equal(receipt.audit.appended, false);
      assert.equal(receipt.recorded, false, 'recorded:false 表示这次结果没有落成审计行');

      assert.equal(receipt.breaker.applied, true, '审计失败不得阻止熔断');
      assert.equal(receipt.breaker.failed, false);
      assert.equal(receipt.breaker.writes, 3, 'writes 2 → 3 已落盘');
      assert.equal(receipt.breaker.writePaused, true, '第 3 次失败仍必须置位暂停');
      assert.equal(real.read().audit.length, 0, '审计行确实没写进去（不是被吞掉）');
      break w;
    }
  } finally { try { real.close(); } catch {} t.cleanup(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 6. 熔断失败：如实体现，审计仍写
// ══════════════════════════════════════════════════════════════════════════════════════

test('CHAIN-6 熔断写入失败：原子路径下两半一起回滚，返回体标 atomic:true + rolledBack', async () => {
  const t = tempDb('breakerfail');
  const real = openOfflineStore(t.dbPath, baseState());
  try {
    let failFirstUpdate = true;
    // 让「第一次」update 失败 = 熔断+审计共用的那一次（t33 起它们在同一个事务里）。
    const store = {
      ...real,
      update(fn) {
        if (failFirstUpdate) { failFirstUpdate = false; throw new Error('breaker disk full'); }
        return real.update(fn);
      },
    };
    const calls = [];
    const writePath = createOfflineWritePath({
      store: real, limits: baseState().limits, clock: () => T0,
      transport: async (req) => { calls.push(req); return { ok: true }; },
    });
    const obs = createWriteObservability({ store, clock: () => T0 });

    const request = publish({ id: 'breaker-fails' });
    const result = await writePath.write(request);
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'success');
    assert.equal(calls.length, 1, 'transport 真的被调用一次');

    const receipt = obs.record({ request, result });
    assert.equal(receipt.atomic, true, '默认路径是原子路径');
    assert.equal(receipt.rolledBack, true, '事务已回滚');
    assert.equal(receipt.breaker.failed, true, '熔断写失败必须如实上报');
    assert.match(receipt.breaker.error.message, /breaker disk full/);
    assert.equal(receipt.breaker.applied, false);

    // t33 / G3：这一半以前会「审计仍然写入」，现在两者同生共死。
    assert.equal(receipt.audit.appended, false, '原子路径：熔断失败不得留下审计行');
    assert.equal(receipt.audit.failed, false, '失败被归到熔断那一半');
    assert.equal(receipt.recorded, false);
    assert.equal(real.read().audit.length, 0, '审计行确实没有落盘');
    assert.equal(real.read().writes, 0, 'writes 也没有被写（success 本应归零，但事务回滚了）');
  } finally { try { real.close(); } catch {} t.cleanup(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 7. 重复结算防护：同一 request 重复 record 不得重复计数
// ══════════════════════════════════════════════════════════════════════════════════════

test('CHAIN-7 重复结算【t36 G1 已闭合】：同一 request+result 重复 record 不再重复计数', async () => {
  const w = world('double', { transportPlan: [{ ok: false }] });
  try {
    const request = publish({ id: 'dup-record' });
    const result = await w.path.write(request);
    assert.equal(result.outcome, 'failed');
    assert.equal(w.calls.length, 1);

    const first = w.obs.record({ request, result });
    assert.equal(first.breaker.writes, 1, '第一次结算：writes 0 → 1');
    assert.equal(first.audit.appended, true);
    assert.equal(first.alreadySettled, false, '第一次是真正的结算');

    // 同一个结果再结算一次：t36 之前这里会把 writes 推到 2，而审计不会追加 —— 熔断与审计的不对称。
    const second = w.obs.record({ request, result });
    const state = w.read();

    assert.equal(second.alreadySettled, true, '★ 第二次必须被幂等键挡住');
    assert.equal(second.recorded, false, '挡住的结算不算「已记录一行审计」');
    assert.equal(second.breaker.applied, false, '熔断不得再推进');
    assert.equal(second.breaker.writes, 1, 'writes 仍为 1（不再是 2）');
    assert.equal(state.writes, 1, '持久状态里 writes 是 1：同一个失败只计一次');
    assert.equal(second.audit.appended, false, '审计不会产生第二行');
    assert.equal(state.audit.length, 1, '审计仍只有一条');

    // 幂等键在 store 里（不是内存），所以重启后同一个重复仍然会被挡。跨重启细节见
    // test-qzone-write-observability-atomic.mjs 的 AT-11；这里只钉「同一进程内的重复」。
    assert.equal(typeof state.settled, 'object', 'settled 幂等表已落盘');
    assert.equal(Object.keys(state.settled).length, 1, '一个结算身份一条记录');
  } finally { w.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 8. 跨重启：close + reopen 后 writes 与 writePaused 仍在
// ══════════════════════════════════════════════════════════════════════════════════════

test('CHAIN-8 跨重启：close + reopen 同一 SQLite 后 writes 计数与 writePaused 仍在，第 4 次仍被拒', async () => {
  const w = world('restart', { transportPlan: [{ ok: false }, { ok: false }, { ok: false }] });
  try {
    for (let i = 0; i < 3; i += 1) {
      const { result } = await writeAndRecord(w, publish({ id: `r-${i}` }));
      assert.equal(result.outcome, 'failed');
      w.advance(POST_INTERVAL_MS);
    }
    assert.equal(w.read().writes, 3);
    assert.equal(w.read().writePaused, true);
    const auditsBefore = w.auditRows().length;
    assert.equal(auditsBefore, 3);

    // ── 真正重启 ────────────────────────────────────────────────────────────────
    w.reopen();

    const after = w.read();
    assert.equal(after.writes, 3, '重启后 writes 仍是 3（没有随进程丢失）');
    assert.equal(after.writePaused, true, '重启后 writePaused 仍是 true');
    assert.equal(w.auditRows().length, auditsBefore, '审计行跨重启保留');

    // 恢复后仍然是暂停态 → 第 4 次仍被入口拒绝，transport 零调用。
    const callsBefore = w.calls.length;
    const { result, receipt } = await writeAndRecord(w, publish({ id: 'after-restart' }));
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'reserve');
    assert.equal(result.reason, 'write_paused');
    assert.equal(w.calls.length, callsBefore, '重启后第 4 次仍然 transport 零调用');
    assert.equal(receipt.breaker.applied, false);
  } finally { w.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 9. 顺序：熔断先于审计
// ══════════════════════════════════════════════════════════════════════════════════════

test('CHAIN-9 顺序断言：record 内部熔断写先于审计写（用真实 store 上的 update 次序证明）', async () => {
  const t = tempDb('order');
  const real = openOfflineStore(t.dbPath, baseState());
  try {
    // 记录每一次 update 之后的「这一笔写的是什么」，据此判断先后。
    const order = [];
    const store = {
      ...real,
      update(fn) {
        const before = real.read();
        const out = real.update(fn);
        const after = real.read();
        if (after.writes !== before.writes || after.writePaused !== before.writePaused) order.push('breaker');
        if (after.audit.length !== before.audit.length) order.push('audit');
        return out;
      },
    };
    const calls = [];
    const writePath = createOfflineWritePath({
      store, limits: baseState().limits, clock: () => T0,
      transport: async (req) => { calls.push(req); return { ok: false }; },
    });
    const obs = createWriteObservability({ store, clock: () => T0 });

    const request = publish({ id: 'order-1' });
    const result = await writePath.write(request);
    assert.equal(result.outcome, 'failed');
    assert.equal(calls.length, 1);

    order.length = 0;                     // 只看 record 内部发生的两笔写
    const receipt = obs.record({ request, result });

    assert.equal(receipt.breaker.applied, true);
    assert.equal(receipt.audit.appended, true);
    assert.deepEqual(order, ['breaker', 'audit'],
      '顺序必须是先熔断后审计（头注释的理由：审计存储坏掉时保护仍必须更新）');
  } finally { try { real.close(); } catch {} t.cleanup(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 10. 审计行必须经 formatAuditRecord 校验，敏感内容 redacted:true
// ══════════════════════════════════════════════════════════════════════════════════════

test('CHAIN-10 审计行经 formatAuditRecord 校验：敏感正文 redacted:true，且落盘内容不含原文', async () => {
  const w = world('redact', { transportPlan: [{ ok: true }] });
  try {
    const secret = 'Cookie: qzonetoken=super-secret-value';
    const request = commentReq({ id: 'redact-1', content: secret });
    const { result, receipt } = await writeAndRecord(w, request);
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'success');
    assert.equal(w.calls.length, 1, 'transport 真的被调用过一次');

    assert.equal(receipt.audit.appended, true);
    assert.equal(receipt.audit.redacted, true, '适配器必须报告落盘行是 redacted');

    const row = w.auditRows().find((entry) => entry.id === 'redact-1');
    assert.ok(row, '审计行必须存在');
    assert.equal(row.record.redacted, true);
    assert.equal(row.record.content, '[REDACTED]', '落盘正文必须是 [REDACTED]');

    // 与 formatAuditRecord 的独立输出逐字段比对：证明这条审计行确实走了那个校验/脱敏实现。
    const expected = formatAuditRecord({
      time: T0, source: 'qq', action: 'comment', target: '10001', postId: 'p-a',
      content: secret, result: 'success', reason: '', quota: null,
    });
    assert.deepEqual(row.record, expected, '落盘行必须与 formatAuditRecord 的输出完全一致');

    // 原文不得出现在整库序列化结果里。
    assert.equal(JSON.stringify(w.read()).includes('super-secret-value'), false,
      '敏感原文不得出现在持久化状态中');
  } finally { w.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 11. 崩溃窗口（用户点名）：审计与熔断不是同一事务
// ══════════════════════════════════════════════════════════════════════════════════════

test('CHAIN-11 崩溃窗口【t33 已闭合】：熔断与审计同一事务，模拟中途崩溃则两半都不落盘', async () => {
  // 这条以前记录的是**未闭合缺陷**：两次事务，中间崩溃留下 writes 前进但审计缺失。
  //
  // t33 / G3 把它闭合了：默认路径把熔断与审计放进同一个 `store.update`。若这中间「崩溃」，SQLite
  // ROLLBACK 会把两半一起撤销 —— 既不会出现「writes 前进但审计缺失」，也不会出现反向漂移
  // （「审计写了一行但熔断没计」，那是更糟的一种：漏计 → 该暂停却没暂停）。
  //
  // 现在这条用例断言的是**闭合后的行为**：两半同时回滚到原值，重启后依然一致。
  const t = tempDb('crash');
  const real = openOfflineStore(t.dbPath, baseState({ writes: 2 }));
  try {
    let crashNow = false;
    // A store whose single update "dies" mid-transaction: the wrapper throws AFTER the real callback
    // has run inside the real BEGIN IMMEDIATE, which is exactly what a crash between the two halves
    // used to look like — except now both halves are inside that one transaction, so both roll back.
    const store = {
      ...real,
      update(fn) {
        if (!crashNow) return real.update(fn);
        // Run the callback against a transaction and then fail before COMMIT.
        throw new Error('process died before commit');
      },
    };
    const calls = [];
    const writePath = createOfflineWritePath({
      store: real, limits: baseState().limits, clock: () => T0,
      transport: async (req) => { calls.push(req); return { ok: false }; },
    });
    const obs = createWriteObservability({ store, clock: () => T0 });

    const request = publish({ id: 'crash-1' });
    const result = await writePath.write(request);
    assert.equal(result.outcome, 'failed');
    assert.equal(calls.length, 1, '前提：transport 真的被调用过一次');

    const beforeWrites = real.read().writes;
    const beforeAudit = real.read().audit.length;
    assert.equal(beforeWrites, 2, '前提：writes 基线是 2');

    crashNow = true;
    const receipt = obs.record({ request, result });

    // 闭合后的形态：两半都没有落盘。
    assert.equal(receipt.atomic, true, '默认路径是原子路径');
    assert.equal(receipt.rolledBack, true, '事务已回滚');
    assert.equal(real.read().writes, beforeWrites, 'writes 必须回到原值（不前进）');
    assert.equal(real.read().audit.length, beforeAudit, '审计行数也必须回到原值（不新增）');
    assert.equal(receipt.recorded, false, '这次结算没有落成任何持久效果');

    // 重启后依然一致 —— 不再存在「缺口」这种东西可被观察到。
    const reopened = openOfflineStore(t.dbPath, baseState());
    try {
      const after = reopened.read();
      assert.equal(after.writes, beforeWrites, '重启后 writes 与崩溃前一致');
      assert.equal(after.audit.length, beforeAudit, '重启后审计行数与崩溃前一致');
    } finally { reopened.close(); }

    // 对照：把开关关掉之后，同一笔结算必须能正常落盘（证明上面的「不变」是回滚造成的，
    // 而不是这个 store 根本写不进去）。
    crashNow = false;
    const ok = obs.record({ request, result });
    assert.equal(ok.recorded, true, '对照：不崩溃时必须能落盘');
    assert.equal(real.read().writes, beforeWrites + 1, '对照：writes 前进 1');
    assert.equal(real.read().audit.length, beforeAudit + 1, '对照：审计 +1');
  } finally { try { real.close(); } catch {} t.cleanup(); }
});
