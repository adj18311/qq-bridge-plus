// Write-quota settlement chain: reserve -> persist -> transport -> classify.
//
// Every case drives the real module over a REAL temporary SQLite store (`openOfflineStore`),
// with a fake transport. Nothing here touches `state/`, QQ, or the production runtime.
//
// Two things this file is careful about, because both are easy to fake:
//
//   1. **"quota unchanged" must start from a NON-ZERO baseline.** A test that asserts `used`
//      stays 0 before and after proves nothing. Where the claim is "the count did not go up",
//      the case first forces the count to 1 and then checks it stays exactly 1.
//   2. **A negative control must exist.** Reserving once and then being refused could equally
//      be caused by a completely locked-down ledger. The happy path plus the day-rollover case
//      demand real successes so a blanket refusal cannot pass this file.
//
// Coverage map:
//   WS-1  happy path: reserve persisted, transport once, success, used 0->1
//   WS-2  persistence failure -> transport ZERO calls, quota untouched (fail-closed)
//   WS-3  same id twice -> duplicate, transport NOT called the second time
//   WS-4  unknown -> reservation kept, used NOT decremented, same id refused after
//   WS-5  transport throws -> same as unknown, no retry
//   WS-6  after a SUCCESS the same id is still refused
//   WS-7  day rollover: used resets to 0 but the old id stays blocked
//   WS-8  daily cap: new ids refused once the limit is reached
//   WS-9  "not sent" is reported distinctly from "unknown", yet quota is consumed in both
//   WS-10 transport sees the reservation before it runs (durable-first, second connection)
//   WS-11 the classifier never upgrades an unparseable answer to success
//   WS-12 same id with a DIFFERENT kind/payload is still the same id (no per-kind bypass)

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import {
  createWriteSettlement,
  SETTLEMENT_OUTCOME,
  _classifyWriteTransportResult,
} from '../src/core/qzone-write-settlement-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';

const T0 = 1_800_000_000_000; // fixed instant; its Beijing day is what the ledger will use
const DAY0 = beijingDay(T0);
const NEXT_DAY = T0 + 24 * 60 * 60 * 1000;

function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-wsettle-${label}-`));
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

/** Fresh ledger shape accepted by `reserveWrite`. */
const freshLedger = (day = DAY0) => ({ day, used: { post: 0, comment: 0, like: 0 }, reservations: {} });

/**
 * Build one settlement over a real temp SQLite store.
 * `overrides.store` lets a case swap in a broken store for the fail-closed test.
 */
function world({ limits = { post: 3, comment: 25, like: 30 }, transport, ledger, extraState } = {}) {
  const t = tempDb('w');
  const initial = {
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { publish: true, comment: true, like: true },
    limits,
    ledger: ledger ?? freshLedger(),
    ...(extraState ?? {}),
  };
  const store = openOfflineStore(t.dbPath, initial);
  let now = T0;
  const clock = () => now;
  const calls = [];
  // ALWAYS record, including for a case-supplied transport. Without this wrapper the `calls`
  // counter silently stays 0 for custom transports, and every "transport 不得重试" assertion
  // would pass for the wrong reason (0 === 1 is not what was meant).
  const inner = transport ?? (async () => ({ ok: true }));
  const recordingTransport = async (req) => { calls.push(req); return inner(req); };
  const settlement = createWriteSettlement({ store, limits, clock, transport: recordingTransport });
  return {
    t, store, settlement, calls, dbPath: t.dbPath,
    setNow: (v) => { now = v; },
    advance: (ms) => { now += ms; },
    readLedger: () => store.read().ledger,
    close() { try { store.close(); } catch {} t.cleanup(); },
  };
}

const write = (over = {}) => ({ id: 'w-1', kind: 'post', target: '9876543210', postId: 'p-1', source: 'qq', ...over });

// ── 1. happy path ───────────────────────────────────────────────────────────────────
test('WS-1 正常路径：reserve 先落盘，transport 恰好一次，结果为 success，used 0→1', async () => {
  const w = world();
  try {
    assert.equal(w.readLedger().used.post, 0, '前提：used 从 0 开始（后面的 1 才有意义）');

    const out = await w.settlement.settle(write());
    assert.equal(out.ok, true, `应成功: ${JSON.stringify(out)}`);
    assert.equal(out.outcome, SETTLEMENT_OUTCOME.SUCCESS);
    assert.equal(out.transportCalled, true);
    assert.equal(out.quotaConsumed, true);
    assert.equal(w.calls.length, 1, 'transport 恰好一次');
    assert.deepEqual(w.calls[0], { id: 'w-1', kind: 'post', target: '9876543210', postId: 'p-1', source: 'qq' },
      'transport 收到的就是这次写请求本身');
    assert.equal(out.reservation.used, 1);
    assert.equal(out.reservation.day, DAY0);
    assert.equal(w.readLedger().used.post, 1, 'used 真的是 1');
    assert.equal(w.readLedger().reservations['w-1'], 'post', 'reservation 已落盘');
  } finally { w.close(); }
});

// ── 2. persistence failure => fail closed ───────────────────────────────────────────
test('WS-2 持久化失败：transport 零调用，配额未被消耗（fail-closed）', async () => {
  const t = tempDb('persist');
  const real = openOfflineStore(t.dbPath, {
    enabled: true, ledger: freshLedger(), limits: { post: 3 },
  });
  const calls = [];
  let failWrites = false;
  const store = {
    read: () => real.read(),
    // Fail only on the SECOND update, so the store itself is proven healthy first — otherwise a
    // factory that always throws would satisfy this case for the wrong reason.
    update(fn) {
      if (failWrites) throw new Error('disk full');
      return real.update(fn);
    },
  };
  try {
    const s = createWriteSettlement({ store, limits: { post: 3 }, clock: () => T0, transport: async (r) => { calls.push(r); return { ok: true }; } });
    assert.equal(s.ledger().used.post, 0, '前提：读得动，store 正常');

    failWrites = true;
    const out = await s.settle(write());
    assert.equal(out.ok, false);
    assert.equal(out.outcome, SETTLEMENT_OUTCOME.NOT_SENT);
    assert.equal(out.reason, 'persist-failed');
    assert.equal(out.transportCalled, false, '持久化失败时绝不可调用 transport');
    assert.equal(out.quotaConsumed, false);
    assert.equal(calls.length, 0, 'transport 零调用');
    assert.match(out.error.message, /disk full/);

    failWrites = false;
    assert.equal(s.ledger().used.post, 0, '事务已回滚，配额没有被消耗');
    assert.equal(s.ledger().reservations['w-1'], undefined);
  } finally { try { real.close(); } catch {} t.cleanup(); }
});

// ── 3. duplicate id ─────────────────────────────────────────────────────────────────
test('WS-3 同 id 第二次：duplicate 拒绝，transport 不再调', async () => {
  const w = world();
  try {
    assert.equal((await w.settlement.settle(write())).ok, true);
    assert.equal(w.readLedger().used.post, 1, '前提：used 已经到 1');

    const second = await w.settlement.settle(write());
    assert.equal(second.ok, false);
    assert.equal(second.outcome, SETTLEMENT_OUTCOME.REFUSED);
    assert.equal(second.reason, 'duplicate');
    assert.equal(second.transportCalled, false);
    assert.equal(w.calls.length, 1, '第二次不得触达 transport');
    assert.equal(w.readLedger().used.post, 1, '被拒的重复调用不得再计一次消耗');
  } finally { w.close(); }
});

// ── 4. unknown keeps everything ─────────────────────────────────────────────────────
test('WS-4 unknown：reservation 保留、used 不降、同 id 再调被拒', async () => {
  const w = world({ transport: async () => ({ unknown: true }) });
  try {
    const out = await w.settlement.settle(write());
    assert.equal(out.ok, true, '调用路径本身完整走完');
    assert.equal(out.outcome, SETTLEMENT_OUTCOME.UNKNOWN);
    assert.equal(out.transportCalled, true);
    assert.equal(out.quotaConsumed, true);

    // NOT an empty assertion: the quota really moved to 1 and must STAY there.
    assert.equal(w.readLedger().used.post, 1, 'unknown 之后 used 必须是 1，不能被退回 0');
    assert.equal(w.readLedger().reservations['w-1'], 'post', 'reservation 必须保留');

    const again = await w.settlement.settle(write());
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'duplicate', '同 id 再调必须被 reservation 挡住');
    assert.equal(w.readLedger().used.post, 1);
    assert.equal(w.calls.length, 1);
  } finally { w.close(); }
});

// ── 5. transport throws ─────────────────────────────────────────────────────────────
test('WS-5 transport 抛错：按 unknown 处理，不重试，配额保留', async () => {
  const w = world({ transport: async () => { throw new Error('socket hang up'); } });
  try {
    const out = await w.settlement.settle(write());
    assert.equal(out.ok, true);
    assert.equal(out.outcome, SETTLEMENT_OUTCOME.UNKNOWN, '抛错不等于「没发出去」');
    assert.equal(out.error.message, 'socket hang up');
    assert.equal(w.readLedger().used.post, 1, '抛错也计消耗');
    assert.equal(w.calls.length, 1, '只调一次，绝不重试');

    const again = await w.settlement.settle(write());
    assert.equal(again.reason, 'duplicate');
    assert.equal(w.calls.length, 1, '重试请求也被挡在 claim 之外');
  } finally { w.close(); }
});

// ── 6. success does not release the id ──────────────────────────────────────────────
test('WS-6 成功之后再调同 id：仍被拒（成功不是放行第二次的理由）', async () => {
  const w = world();
  try {
    const first = await w.settlement.settle(write());
    assert.equal(first.outcome, SETTLEMENT_OUTCOME.SUCCESS);
    assert.equal(w.readLedger().used.post, 1);

    const second = await w.settlement.settle(write());
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'duplicate');
    assert.equal(w.calls.length, 1);
    assert.equal(w.readLedger().used.post, 1);
    assert.equal(w.readLedger().reservations['w-1'], 'post', '成功后 reservation 仍必须留着');
  } finally { w.close(); }
});

// ── 7. day rollover ─────────────────────────────────────────────────────────────────
test('WS-7 日切：跨 00:00 后 used 归零，但旧 id 仍被 reservations 挡住', async () => {
  const w = world({ limits: { post: 3 } });
  try {
    assert.equal((await w.settlement.settle(write({ id: 'old' }))).ok, true);
    assert.equal(w.readLedger().used.post, 1, '前提：旧日确实用了 1');

    w.setNow(NEXT_DAY);
    assert.notEqual(beijingDay(NEXT_DAY), DAY0, '前提：确实跨了北京日');

    // A NEW id on the new day must be accepted — and this also proves `used` was reset, because
    // after a reset the count goes 0 -> 1 rather than 1 -> 2.
    const fresh = await w.settlement.settle(write({ id: 'new-day' }));
    assert.equal(fresh.ok, true, `新的一天新 id 必须能写: ${JSON.stringify(fresh)}`);
    assert.equal(fresh.reservation.day, beijingDay(NEXT_DAY));
    assert.equal(fresh.reservation.used, 1, 'used 已归零后重新从 1 开始（不是 2）');
    assert.equal(w.readLedger().used.post, 1);

    // The OLD id must STILL be blocked: reservations are not cleared by the day rollover, which
    // is exactly what stops a cross-day replay of yesterday's id.
    const replay = await w.settlement.settle(write({ id: 'old' }));
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, 'duplicate', '跨日之后旧 id 仍然必须是 duplicate');
    assert.equal(w.calls.length, 2, '旧 id 没有触发第三次 transport');
    assert.equal(w.readLedger().reservations.old, 'post', '日切不清空 reservations');
  } finally { w.close(); }
});

// ── 8. daily cap ────────────────────────────────────────────────────────────────────
test('WS-8 限额：达到每日上限后新 id 被拒，transport 不再调', async () => {
  const w = world({ limits: { post: 2 } });
  try {
    assert.equal((await w.settlement.settle(write({ id: 'a' }))).ok, true);
    assert.equal((await w.settlement.settle(write({ id: 'b' }))).ok, true);
    assert.equal(w.readLedger().used.post, 2, '前提：正好用满 2');

    const third = await w.settlement.settle(write({ id: 'c' }));
    assert.equal(third.ok, false);
    assert.equal(third.outcome, SETTLEMENT_OUTCOME.REFUSED);
    assert.equal(third.reason, 'limit');
    assert.equal(third.transportCalled, false);
    assert.equal(w.calls.length, 2, '被限额拒绝的调用不得触达 transport');
    assert.equal(w.readLedger().used.post, 2, '被拒不得消耗配额');
  } finally { w.close(); }
});

// ── 9. not-sent vs unknown: distinguished in the result, identical in the accounting ──
test('WS-9 「真实未发出」与「未知」在结果里必须可区分，但配额一律不退', async () => {
  for (const [label, transport, expected] of [
    ['notSent:true', async () => ({ notSent: true }), SETTLEMENT_OUTCOME.NOT_SENT],
    ['outcome:not-sent', async () => ({ outcome: 'not-sent' }), SETTLEMENT_OUTCOME.NOT_SENT],
    ['unknown:true', async () => ({ unknown: true }), SETTLEMENT_OUTCOME.UNKNOWN],
    ['throw', async () => { throw new Error('boom'); }, SETTLEMENT_OUTCOME.UNKNOWN],
  ]) {
    const w = world({ transport });
    try {
      const out = await w.settlement.settle(write());
      assert.equal(out.outcome, expected, `${label} 必须归类为 ${expected}`);
      assert.equal(out.quotaConsumed, true, `${label}：配额一律计消耗（不退）`);
      assert.equal(w.readLedger().used.post, 1, `${label}：used 必须停在 1`);
      assert.equal(w.readLedger().reservations['w-1'], 'post', `${label}：reservation 必须保留`);

      const again = await w.settlement.settle(write());
      assert.equal(again.reason, 'duplicate', `${label}：同 id 之后仍必须被拒`);
      assert.equal(w.calls.length, 1, `${label}：不得重试`);
    } finally { w.close(); }
  }

  // A definite failure (the call DID go out and the platform said no) is a third distinct
  // outcome — and it also keeps the quota, for the same reason.
  {
    const w = world({ transport: async () => ({ ok: false }) });
    try {
      const out = await w.settlement.settle(write());
      assert.equal(out.outcome, SETTLEMENT_OUTCOME.FAILED);
      assert.equal(out.quotaConsumed, true);
      assert.equal(w.readLedger().used.post, 1);
    } finally { w.close(); }
  }
});

// ── 10. durability before dispatch ──────────────────────────────────────────────────
test('WS-10 持久化严格先于 transport：transport 内用另一条连接读到 reservation 已存在', async () => {
  let observed = null;
  let w;
  const transport = async () => {
    const other = openOfflineStore(w.dbPath, {});
    try {
      const ledger = other.read().ledger;
      observed = { used: ledger.used.post, reserved: ledger.reservations['w-1'] ?? null };
    } finally { other.close(); }
    return { ok: true };
  };
  w = world({ transport });
  try {
    const out = await w.settlement.settle(write());
    assert.equal(out.ok, true);
    assert.deepEqual(observed, { used: 1, reserved: 'post' },
      'transport 被调用时，另一条连接必须已经能看到这次预留 —— 否则持久化在派发之后');
  } finally { w.close(); }
});

// ── 11. classifier robustness ───────────────────────────────────────────────────────
test('WS-11 分类器：无法解释的应答一律 unknown，绝不升级为 success', () => {
  const unknownCases = [
    undefined, null, 'ok', 42, [],
    { ok: 'true' },                 // non-boolean ok
    { ok: true, outcome: 'failed' },// contradiction
    { ok: true, notSent: true },    // contradiction: "sent" and "never sent"
    { outcome: 'weird' },
    {},
    { unknown: true, ok: true },    // unknown is contagious
  ];
  for (const value of unknownCases) {
    assert.equal(_classifyWriteTransportResult(value), 'unknown',
      `必须归类 unknown: ${JSON.stringify(value)}`);
  }
  // …while unambiguous answers keep their own label (i.e. the classifier is not stuck on
  // "unknown" for everything, which would make the cases above vacuous).
  assert.equal(_classifyWriteTransportResult({ ok: true }), 'success');
  assert.equal(_classifyWriteTransportResult({ outcome: 'success' }), 'success');
  assert.equal(_classifyWriteTransportResult({ ok: false }), 'failed');
  assert.equal(_classifyWriteTransportResult({ notSent: true }), 'not-sent');
  assert.equal(_classifyWriteTransportResult({ outcome: 'not-sent' }), 'not-sent');
  assert.equal(_classifyWriteTransportResult({ unknown: true }), 'unknown');
});

// ── 12. the id is the id, regardless of kind ────────────────────────────────────────
test('WS-12 同 id 换个 kind/内容仍是同一个 id：不得靠改参数绕过防重放', async () => {
  const w = world({ limits: { post: 3, comment: 25 } });
  try {
    assert.equal((await w.settlement.settle(write({ id: 'shared', kind: 'post' }))).ok, true);
    assert.equal(w.readLedger().used.post, 1, '前提：post 已用 1');

    const asComment = await w.settlement.settle(write({ id: 'shared', kind: 'comment', postId: 'p-2' }));
    assert.equal(asComment.ok, false, '换 kind 不得让同一个 id 再写一次');
    assert.equal(asComment.reason, 'duplicate');
    assert.equal(w.calls.length, 1);
    assert.equal(w.readLedger().used.comment, 0, '被拒的调用不得计 comment 配额');
  } finally { w.close(); }
});

// ── construction guards ─────────────────────────────────────────────────────────────
test('WS-13 构造期校验：缺 store/limits/clock/transport 或非法限额直接 TypeError', () => {
  const ok = {
    store: { read: () => ({ ledger: freshLedger() }), update: (fn) => fn({ ledger: freshLedger() }) },
    limits: { post: 1 }, clock: () => T0, transport: async () => ({ ok: true }),
  };
  const build = (over) => () => createWriteSettlement({ ...ok, ...over });
  assert.throws(build({ store: undefined }), /needs a store with read\/update/);
  assert.throws(build({ limits: undefined }), /needs a limits object/);
  assert.throws(build({ limits: [] }), /needs a limits object/);
  assert.throws(build({ limits: { post: 100 } }), /invalid daily limit/);
  assert.throws(build({ limits: { post: -1 } }), /invalid daily limit/);
  assert.throws(build({ limits: { unknownKind: 1 } }), /unknown write kind/);
  assert.throws(build({ clock: undefined }), /needs a clock/);
  assert.throws(build({ transport: undefined }), /needs a transport/);
  assert.doesNotThrow(build({}));
});
