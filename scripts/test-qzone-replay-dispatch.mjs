const OMIT = Symbol('omit');

// Dispatch-ordering tests: the wrapper must never reach the transport unless the claim was
// already durable. Uses a REAL temporary SQLite store and a FAKE transport (counter).
//
// Replaces the earlier "ordering" case, which only asserted that the store could be reopened
// and then pushed a synthetic `{ stage: 'transport' }` marker — it never called a transport
// and never exercised a dispatcher.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import {
  REPLAY_REFUSAL,
  initializeReplayState,
  createReplayClaimer,
} from '../src/core/qzone-replay-claim-offline.mjs';
import { createReplayGuardedDispatcher } from '../src/core/qzone-replay-dispatch-offline.mjs';

const ACCOUNT = 9876543210;
const identity = (over = {}) => ({ sessionId: 's1', requestId: 'r1', callId: 'c1', ...over });

function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-disp-${label}-`));
  return { dir, dbPath: path.join(dir, 'state.db'), cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** Fake transport that records every call. Nothing leaves the machine. */
function fakeTransport({ behaviour = 'success' } = {}) {
  const calls = [];
  const fn = async (action, input) => {
    calls.push({ action, input });
    if (behaviour === 'throw') throw new Error('platform unreachable');
    if (behaviour === 'unknown') return { unknown: true };
    if (behaviour === 'failed') return { ok: false, error: 'write-not-wired' };
    return { ok: true, outcome: 'success' };
  };
  return { fn, calls };
}

function rig({ behaviour } = {}) {
  const t = tempDb('rig');
  const store = openOfflineStore(t.dbPath, { enabled: false, reads: 0 });
  initializeReplayState(store, { now: 1000 });
  const claimer = createReplayClaimer({ store, accountId: ACCOUNT });
  const transport = fakeTransport({ behaviour });
  const dispatcher = createReplayGuardedDispatcher({ claimer, transport: transport.fn, clock: () => 1100 });
  return { t, store, claimer, transport, dispatcher };
}

test('D1 正常一次：恰好调用 transport 一次，且认领已落盘', async () => {
  const { t, store, claimer, transport, dispatcher } = rig();
  try {
    const out = await dispatcher.dispatch({ identity: identity(), action: 'read_posts', input: { uin: 456 } });
    assert.equal(out.ok, true);
    assert.equal(out.outcome, 'success');
    assert.equal(transport.calls.length, 1, '恰好一次');
    assert.equal(claimer.size(), 1, '认领已持久化');

    // Durable across a reopen.
    store.close();
    const reopened = openOfflineStore(t.dbPath, {});
    assert.equal(createReplayClaimer({ store: reopened, accountId: ACCOUNT }).size(), 1);
    reopened.close();
  } finally { t.cleanup(); }
});

test('D2 重复调用：第二次不再触达 transport', async () => {
  const { t, store, transport, dispatcher } = rig();
  try {
    const first = await dispatcher.dispatch({ identity: identity(), action: 'read_posts', input: {} });
    assert.equal(first.ok, true);
    const second = await dispatcher.dispatch({ identity: identity(), action: 'read_posts', input: {} });
    assert.equal(second.ok, false);
    assert.equal(second.stage, 'claim');
    assert.equal(second.reason, REPLAY_REFUSAL.REPLAY);
    assert.equal(transport.calls.length, 1, '重复调用不得再次派发');
    store.close();
  } finally { t.cleanup(); }
});

test('D3 claim 异常：transport 绝不调用（存储故障不得被吞成发送）', async () => {
  const t = tempDb('throwing-claimer');
  try {
    const store = openOfflineStore(t.dbPath, {});
    const transport = fakeTransport();
    const throwingClaimer = { claim() { throw new Error('database is locked'); } };
    const dispatcher = createReplayGuardedDispatcher({ claimer: throwingClaimer, transport: transport.fn, clock: () => 1 });

    await assert.rejects(
      () => dispatcher.dispatch({ identity: identity(), action: 'read_posts', input: {} }),
      /locked/,
      'claim 异常必须向上抛出，不能被包装成"已发送"',
    );
    assert.equal(transport.calls.length, 0, '存储异常时 transport 必须一次都没调');
    store.close();
  } finally { t.cleanup(); }
});

test('D4 claim 返回拒绝（集合丢失）：transport 绝不调用', async () => {
  const t = tempDb('lost');
  try {
    const store = openOfflineStore(t.dbPath, {});
    initializeReplayState(store, { now: 1000 });
    store.update((s) => { const n = { ...s }; delete n.usedReadKeys; return n; });   // damage
    const claimer = createReplayClaimer({ store, accountId: ACCOUNT });
    const transport = fakeTransport();
    const dispatcher = createReplayGuardedDispatcher({ claimer, transport: transport.fn, clock: () => 1100 });

    const out = await dispatcher.dispatch({ identity: identity(), action: 'read_posts', input: {} });
    assert.equal(out.ok, false);
    assert.equal(out.reason, REPLAY_REFUSAL.COLLECTION_LOST);
    assert.equal(transport.calls.length, 0, '集合不可用时不得派发');
    store.close();
  } finally { t.cleanup(); }
});

test('D5 认领后、派发前进程退出：重启后同键仍拒（claim 已持久化）', async () => {
  const t = tempDb('crash-before-dispatch');
  try {
    let store = openOfflineStore(t.dbPath, {});
    initializeReplayState(store, { now: 1000 });
    const claimer = createReplayClaimer({ store, accountId: ACCOUNT });

    // Simulate: claim committed, then the process died BEFORE the transport ran.
    assert.deepEqual(claimer.claim(identity(), { now: 1100 }), { ok: true });
    store.close();   // NOT a crash; it is a clean close. Labelled separately below.

    // New process comes up. Same key must be refused; no dispatch.
    store = openOfflineStore(t.dbPath, {});
    const reopened = createReplayClaimer({ store, accountId: ACCOUNT });
    const transport = fakeTransport();
    const dispatcher = createReplayGuardedDispatcher({ claimer: reopened, transport: transport.fn, clock: () => 1200 });
    const out = await dispatcher.dispatch({ identity: identity(), action: 'read_posts', input: {} });
    assert.equal(out.ok, false);
    assert.equal(out.reason, REPLAY_REFUSAL.REPLAY, '认领已持久化，重启后仍拒');
    assert.equal(transport.calls.length, 0);
    store.close();
  } finally { t.cleanup(); }
});

test('D6 transport 结果未知：认领保留，不自动重发', async () => {
  const { t, store, claimer, transport, dispatcher } = rig({ behaviour: 'unknown' });
  try {
    const first = await dispatcher.dispatch({ identity: identity(), action: 'read_posts', input: {} });
    assert.equal(first.ok, true);
    assert.equal(first.outcome, 'unknown', 'unknown 是一等结果');

    const retry = await dispatcher.dispatch({ identity: identity(), action: 'read_posts', input: {} });
    assert.equal(retry.ok, false);
    assert.equal(retry.reason, REPLAY_REFUSAL.REPLAY);
    assert.equal(transport.calls.length, 1, 'unknown 之后不得自动重发');
    assert.equal(claimer.size(), 1, '认领保留（fail-closed）');
    store.close();
  } finally { t.cleanup(); }
});

test('D7 transport 抛错：认领保留（无法证明平台未动作），且不重试', async () => {
  const { t, store, claimer, transport, dispatcher } = rig({ behaviour: 'throw' });
  try {
    const first = await dispatcher.dispatch({ identity: identity(), action: 'read_posts', input: {} });
    assert.equal(first.ok, false);
    assert.equal(first.stage, 'transport');
    assert.equal(first.reason, 'transport-threw');
    assert.equal(transport.calls.length, 1);

    const retry = await dispatcher.dispatch({ identity: identity(), action: 'read_posts', input: {} });
    assert.equal(retry.reason, REPLAY_REFUSAL.REPLAY, '已认领，不得重试');
    assert.equal(transport.calls.length, 1);
    assert.equal(claimer.size(), 1);
    store.close();
  } finally { t.cleanup(); }
});

test('D8 方言：clean close 不是崩溃（措辞分开，行为等价）', async () => {
  const t = tempDb('close-vs-crash');
  try {
    const store = openOfflineStore(t.dbPath, {});
    initializeReplayState(store, { now: 1000 });
    createReplayClaimer({ store, accountId: ACCOUNT }).claim(identity(), { now: 1100 });
    store.close();                       // explicit, orderly shutdown
    const reopened = openOfflineStore(t.dbPath, {});
    const c = createReplayClaimer({ store: reopened, accountId: ACCOUNT });
    assert.equal(c.size(), 1, 'clean close 后键仍在');
    // This case asserts ONLY "an orderly close keeps committed keys". It is NOT crash
    // coverage: the child-process case in test-qzone-replay-store.mjs also calls store.close()
    // before exiting, so it is equally not a crash. Real process-exit coverage lives in D9.
    reopened.close();
  } finally { t.cleanup(); }
});

// ── D9: real process exit AFTER the claim committed, BEFORE the dispatcher returns ────
//
// Codex's requirement: prove the recovery behaviour when the process dies with a committed
// claim, WITHOUT calling store.close(). The child below:
//   · opens the real store, claims through the real claimer
//   · verifies the key is durable, then calls process.exit(23) directly
//   · never calls store.close(), never touches the transport
// The parent then re-opens the same DB and runs the dispatcher again.
//
// What this proves: a committed claim survives an abrupt, non-graceful process exit and still
// blocks the retry. What it does NOT prove: power loss, media failure, or a whole-database
// rollback. No hardware-failure claims.
test('D9 认领提交后进程非正常退出（不调 store.close）：重启后同键仍拒且不派发', async () => {
  const { spawnSync: spawnSyncLocal } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const t = tempDb('exit23');
  try {
    const store = openOfflineStore(t.dbPath, {});
    initializeReplayState(store, { now: 1000 });
    store.close();

    const childPath = path.join(t.dir, 'exit-child.mjs');
    fs.writeFileSync(childPath, [
      'import { openOfflineStore } from ' + JSON.stringify(new URL('../src/core/qzone-store-offline.mjs', import.meta.url).href) + ';',
      'import { createReplayClaimer } from ' + JSON.stringify(new URL('../src/core/qzone-replay-claim-offline.mjs', import.meta.url).href) + ';',
      'const [dbPath, accountId] = process.argv.slice(2);',
      'const store = openOfflineStore(dbPath, {});',
      'const claimer = createReplayClaimer({ store, accountId: Number(accountId) });',
      "const out = claimer.claim({ sessionId: 's1', requestId: 'r1', callId: 'c-exit' }, { now: 1100 });",
      'if (!out || out.ok !== true) { process.stdout.write(JSON.stringify({ committed: false, out })); process.exit(9); }',
      // Read back through a fresh read to confirm it is on disk before dying.
      'const size = claimer.size();',
      'process.stdout.write(JSON.stringify({ committed: true, size, closedBeforeExit: false }));',
      // Abrupt exit: no store.close(), no dispatcher return.
      'process.exit(23);',
    ].join('\n'), 'utf8');

    const run = spawnSyncLocal(process.execPath, [childPath, t.dbPath, String(ACCOUNT)], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, 23, `子进程必须以 23 退出（非正常退出），实际 ${run.status} stderr=${run.stderr}`);
    const reported = JSON.parse(String(run.stdout).trim());
    assert.equal(reported.committed, true, '子进程必须报告认领已提交');
    assert.equal(reported.closedBeforeExit, false, '子进程不得在退出前调用 store.close()');
    assert.equal(reported.size, 1);

    // Parent: re-open and prove the retry is refused without any dispatch.
    const reopened = openOfflineStore(t.dbPath, {});
    const claimer = createReplayClaimer({ store: reopened, accountId: ACCOUNT });
    assert.equal(claimer.size(), 1, '非正常退出后键仍在磁盘上');

    const transport = fakeTransport();
    const dispatcher = createReplayGuardedDispatcher({ claimer, transport: transport.fn, clock: () => 5000 });
    const retry = await dispatcher.dispatch({ identity: identity({ callId: 'c-exit' }), action: 'read_posts', input: {} });
    assert.equal(retry.ok, false);
    assert.equal(retry.reason, REPLAY_REFUSAL.REPLAY, '进程退出后同键仍被拒');
    assert.equal(transport.calls.length, 0, '不得派发');
    reopened.close();
    void fileURLToPath;
  } finally { t.cleanup(); }
});

// ── D10: transport result normalisation (table-driven) ───────────────────────────────
//
// The defect Codex measured: anything unrecognised defaulted to `success`, so `undefined`,
// `null`, `false`, `0`, '' and even `{outcome:'unknown'}` all reported success. "The transport
// was called" is not "the platform did something we can confirm".
//
// Contract now: explicit success / explicit failure / explicit unknown; everything else is
// conservatively `unknown`. The claim is consumed in EVERY case, and a repeat never re-sends.
test('D10 transport 返回归一化：未知与非法形状一律按 unknown，绝不冒充成功', async () => {
  const CASES = [
    // [label, transport return value, expected outcome]
    ['明确成功 {ok:true}', { ok: true }, 'success'],
    ['明确成功 {outcome:"success"}', { outcome: 'success' }, 'success'],
    ['明确失败 {ok:false}', { ok: false }, 'failed'],
    ['明确失败 {outcome:"failed"}', { outcome: 'failed' }, 'failed'],
    ['未知 {unknown:true}', { unknown: true }, 'unknown'],
    ['未知 {outcome:"unknown"}', { outcome: 'unknown' }, 'unknown'],
    [' undefined', undefined, 'unknown'],
    [' null', null, 'unknown'],
    [' false', false, 'unknown'],
    [' 0', 0, 'unknown'],
    [' 空字符串', '', 'unknown'],
    [' 数组', [], 'unknown'],
    [' 矛盾 {ok:true,unknown:true}', { ok: true, unknown: true }, 'unknown'],
    [' 矛盾 {ok:false,outcome:"unknown"}', { ok: false, outcome: 'unknown' }, 'unknown'],
    [' 无法识别 {foo:"bar"}', { foo: 'bar' }, 'unknown'],
  ];

  for (const [label, value, expected] of CASES) {
    const t = tempDb('norm');
    try {
      const store = openOfflineStore(t.dbPath, {});
      initializeReplayState(store, { now: 1000 });
      const claimer = createReplayClaimer({ store, accountId: ACCOUNT });
      const transport = fakeTransport();
      transport.fn = async (action, input) => { transport.calls.push({ action, input }); return value; };
      const dispatcher = createReplayGuardedDispatcher({ claimer, transport: transport.fn, clock: () => 1100 });

      const out = await dispatcher.dispatch({ identity: identity(), action: 'read_posts', input: {} });
      assert.equal(out.ok, true, `${label}: 派发路径本身应完成`);
      assert.equal(out.outcome, expected, `${label}: outcome 应为 ${expected}，实际 ${out.outcome}`);
      assert.equal(transport.calls.length, 1, `${label}: transport 恰好一次`);
      assert.equal(claimer.size(), 1, `${label}: 认领保留（不退款、不改账务策略）`);

      // A repeat must be refused at the claim stage and must not reach the transport.
      const again = await dispatcher.dispatch({ identity: identity(), action: 'read_posts', input: {} });
      assert.equal(again.ok, false, `${label}: 重复必须被拒`);
      assert.equal(again.reason, REPLAY_REFUSAL.REPLAY);
      assert.equal(transport.calls.length, 1, `${label}: 重复不得再调用 transport`);
      store.close();
    } finally { t.cleanup(); }
  }
});
// ── D11: full cartesian product of the status fields ─────────────────────────────────
//
// Codex asked for the whole matrix in one pass instead of another sample-by-sample round trip.
//
// WORDING, deliberately precise: this is a **written-rules coverage matrix**. The oracle below
// is written from the rules in the module header WITHOUT calling the production function, but
// it is NOT "methodologically independent" in a strong sense — it uses the same three-step
// structure (validate -> collect claims -> reconcile) and a Set, so a shared misreading of the
// rules would show up in both. What actually carries the weight here is: the 80-cell population
// is pinned numerically (6/6/68), D10 pins specific expected values row by row, and two
// mutations (prefer-ok:true, fallback-to-success) both turn the matrix red.
//
// Written rules (module header):
//   1. every PRESENT status field must hold a legal value, else unknown:
//        ok      : boolean
//        outcome : 'success' | 'failed' | 'unknown'
//        unknown : boolean
//   2. each field that carries a conclusion contributes one claim
//   3. unknown is contagious; success+failure is a contradiction -> unknown;
//      exactly one agreed claim -> that claim; otherwise unknown
function expectedOutcome(spec) {
  // Presence must be tested on the object itself: a destructured missing key is `undefined`,
  // which is indistinguishable from a key present with value `undefined`.
  const present = (k) => Object.hasOwn(spec, k);
  const { ok, outcome, unknown } = spec;

  // 1. legality of every PRESENT field
  if (present('ok') && typeof ok !== 'boolean') return 'unknown';
  if (present('unknown') && typeof unknown !== 'boolean') return 'unknown';
  if (present('outcome') && outcome !== 'success' && outcome !== 'failed' && outcome !== 'unknown') {
    return 'unknown';
  }

  // 2. one claim per field that carries a conclusion
  const claims = new Set();
  if (present('ok')) claims.add(ok === true ? 'success' : 'failed');
  if (present('outcome')) claims.add(outcome);
  if (present('unknown') && unknown === true) claims.add('unknown');

  // 3. reconcile
  if (claims.has('unknown')) return 'unknown';
  if (claims.has('success') && claims.has('failed')) return 'unknown';
  if (claims.size === 1) return [...claims][0];
  return 'unknown';
}

test('D11 状态字段全组合矩阵（80 组）：冲突/非法一律 unknown，且计数被钉住', async () => {
  const OKS = [OMIT, true, false, 'invalid'];
  const OUTCOMES = [OMIT, 'success', 'failed', 'unknown', 'bogus'];
  const UNKNOWNS = [OMIT, true, false, 'invalid'];

  const tally = { success: 0, failed: 0, unknown: 0 };
  const mismatches = [];

  for (const ok of OKS) {
    for (const outcome of OUTCOMES) {
      for (const unknown of UNKNOWNS) {
        // Build the wire object honouring "absent" vs "present".
        const value = {};
        if (ok !== OMIT) value.ok = ok;
        if (outcome !== OMIT) value.outcome = outcome;
        if (unknown !== OMIT) value.unknown = unknown;

        const spec = {};
        if (ok !== OMIT) spec.ok = ok;
        if (outcome !== OMIT) spec.outcome = outcome;
        if (unknown !== OMIT) spec.unknown = unknown;

        const want = expectedOutcome(spec);

        // Synchronous fake claimer: the matrix is about normalisation, not persistence.
        // The real-SQLite cases above already cover claim retention and no-re-dispatch.
        let claimCount = 0;
        const claimer = { claim: () => { claimCount += 1; return { ok: true }; } };
        const transportCalls = [];
        const dispatcher = createReplayGuardedDispatcher({
          claimer,
          transport: async () => { transportCalls.push(1); return value; },
          clock: () => 1,
        });

        const out = await dispatcher.dispatch({ identity: {}, action: 'read_posts', input: {} });
        if (out.outcome !== want) {
          mismatches.push(`ok=${String(ok)} outcome=${String(outcome)} unknown=${String(unknown)} want=${want} got=${out.outcome}`);
        }
        assert.equal(out.ok, true, 'outer ok 表示派发路径完成，与本矩阵的期望无关');
        assert.equal(claimCount, 1, '每次都恰好认领一次');
        assert.equal(transportCalls.length, 1, '每次都恰好调用 transport 一次');
        tally[want] += 1;
      }
    }
  }

  assert.deepEqual(mismatches, [], `矩阵不匹配：\n${mismatches.slice(0, 10).join('\n')}`);
  // Numerical pin, derived independently:
  //   20 unknown  (ok illegal)
  // + 12 unknown  (outcome illegal, ok legal, unknown legal-minus-illegal-column)
  // + 12 unknown  (unknown illegal, ok legal, outcome legal)
  // + 12 unknown  (unknown:true -> contagious)
  // + 12 unknown  (remaining contradictions / empty)
  // = 68 unknown, 6 success, 6 failed, 80 total.
  assert.deepEqual(tally, { success: 6, failed: 6, unknown: 68 },
    '80 组的分布必须与书面规则推算一致');
});