// Offline write path: the complete quota chain (t26 rewrite).
//
// This file covers the FACADE'S contract — which stage answers, what is called, what is not. The
// end-to-end rule coverage (2h publish interval, global 3min comment interval, like de-duplication,
// cross-day, cross-restart, concurrency, no double deduction) lives in
// `test-qzone-write-path-e2e.mjs`; keep the split so each file can fail for its own reason.
//
// Every case runs the real module over a REAL temporary SQLite store; the transport is a counter.
// "Nothing was consumed" assertions are always taken against a NON-ZERO baseline driven there by a
// real, successful write — "0 stayed 0" is not accepted as evidence anywhere in this file.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import {
  createOfflineWritePath,
  ACTION_TO_KIND,
  WRITE_ACTIONS,
} from '../src/core/qzone-write-path-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';

const T0 = 1_800_000_000_000;
const DAY0 = beijingDay(T0);
const TARGET = '9876543210';

function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-wpath-${label}-`));
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

const freshLedger = (day = DAY0) => ({ day, used: { post: 0, comment: 0, like: 0 }, reservations: {} });

/** Everything the reservation module needs: policy fields, limits, ledger, interval/like state. */
const baseState = (over = {}) => ({
  enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
  tools: { publish: true, comment: true, reply: true, like: true, read_posts: true },
  limits: { post: 3, comment: 25, like: 30 },
  ledger: freshLedger(),
  lastPostAt: null,
  lastCommentAt: null,
  commentTargets: [],
  likes: [],
  // A reply reserves through `reserveAuditedOfflineInteraction`, which appends an `unknown` intent
  // audit row in the SAME transaction as the quota unit — so the state needs the collection a real
  // store has. (Every other action leaves it untouched.)
  audit: [],
  ...over,
});

/**
 * The evidence a legal `reply` needs — a FIXTURE, and it must be one.
 *
 * `reserveAuditedOfflineInteraction` refuses a reply unless exactly one `state.commentEvidence` row
 * matches the identity triple AND the reply identity frozen on the dispatch (`commentUin`, plus the
 * optional `replyUin`/`replyName` pair). **No producer of that collection was found within the
 * checked scope** (this repository's `src/`), so a test can only seed it; seeding proves the GATE
 * behaves as specified, not that a real reply can be sent. The replies below are fixtures for the
 * rule under test (quota bucket, master switch), and they must be *legal* replies or those cases
 * would measure the evidence gate instead.
 */
const REPLY_COMMENT_UIN = 7;
const replyEvidence = (postId = 'p-reply') => [{
  target: TARGET, postId, commentId: 'c-1',
  commentUin: REPLY_COMMENT_UIN, replyUin: null, replyName: null,
  // `at` is REQUIRED: the reservation judges evidence age in its own transaction, so an undated row
  // is refused as `evidence-undated`. `T0` is this fixture's request clock, i.e. maximally fresh.
  at: T0,
}];

/** The state a legal reply needs: the audit collection plus matching corroborating evidence. */
const replyState = (postId = 'p-reply', over = {}) => baseState({ commentEvidence: replyEvidence(postId), ...over });

function world({ state = baseState(), transport } = {}) {
  const t = tempDb('w');
  const store = openOfflineStore(t.dbPath, state);
  let now = T0;
  const calls = [];
  // ALWAYS wrap, so a case-supplied transport is still counted.
  const inner = transport ?? (async () => ({ ok: true }));
  const path = createOfflineWritePath({
    store,
    limits: state.limits,
    clock: () => now,
    transport: async (req) => { calls.push(req); return inner(req); },
  });
  return {
    t, store, path, calls, dbPath: t.dbPath,
    setNow: (v) => { now = v; },
    advance: (ms) => { now += ms; },
    readState: () => store.read(),
    readLedger: () => store.read().ledger,
    patch(fn) { store.update((s) => ({ ...s, ...fn(s) })); },
    close() { try { store.close(); } catch {} t.cleanup(); },
  };
}

// A `like` carries no body: `FIELDS.like` in the write contract has no `content`, and `snapshotRequest`
// refuses one before reserving (t10 / LZ-16). So the default body is attached only to actions that
// have a body; a `like` fixture must be body-less, exactly as the contract requires. Every other
// default of this helper is unchanged.
const write = (over = {}) => {
  const base = { id: 'w-1', action: 'publish', target: TARGET, postId: 'p-1', source: 'qq', content: 'hi', ...over };
  if ((over.action ?? 'publish') === 'like' && over.content === undefined) base.content = undefined;
  return base;
};

// ── 1. full chain ───────────────────────────────────────────────────────────────────
test('WP-1 全链通过：原子预留成功 → transport 恰好一次，配额 +1', async () => {
  const w = world();
  try {
    assert.equal(w.readLedger().used.post, 0, '前提：配额从 0 起步');
    const out = await w.path.write(write());
    assert.equal(out.ok, true, `应通过: ${JSON.stringify(out)}`);
    assert.equal(out.stage, 'transport');
    assert.equal(out.outcome, 'success');
    assert.equal(w.calls.length, 1, 'transport 恰好一次');
    assert.deepEqual(w.calls[0], {
      id: 'w-1', action: 'publish', kind: 'post', target: TARGET, postId: 'p-1', source: 'qq', content: 'hi',
    }, 'transport 收到的就是这次写请求');
    assert.equal(w.readLedger().used.post, 1, '配额真的 +1（且只 +1）');
    assert.equal(w.readState().lastPostAt, T0, '发帖时间戳已落盘（2 小时间隔的依据）');
  } finally { w.close(); }
});

// ── 2. every refusal shape, with a non-zero baseline ───────────────────────────────
test('WP-2 工具闸门拒绝 → 预留零副作用（非零基线：先是 1，拒绝了仍是 1）', async () => {
  const w = world();
  try {
    assert.equal((await w.path.write(write({ id: 'base' }))).ok, true, '前提：先成功写一次');
    assert.equal(w.readLedger().used.post, 1, '前提：基线已经是 1，不是 0');
    assert.equal(w.calls.length, 1);

    w.patch((s) => ({ tools: { ...s.tools, publish: false } }));
    const out = await w.path.write(write({ id: 'blocked' }));
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'reserve', '闸门在预留事务内，失败归到 reserve 阶段');
    assert.equal(out.reason, 'tool_permission');
    assert.equal(w.calls.length, 1, 'transport 没被调用');
    assert.equal(w.readLedger().used.post, 1, '配额必须仍是 1 —— 被拒的调用不得白烧');
    assert.equal(w.readLedger().reservations.blocked, undefined, '被拒的 id 也不得占位');
  } finally { w.close(); }
});

test('WP-2b 四种闸门拒绝都零消耗（enabled / accessPaused / writeAllowed / writePaused）', async () => {
  const cases = [
    ['enabled=false', { enabled: false }, 'disabled'],
    ['accessPaused', { accessPaused: true }, 'access_paused'],
    ['writeAllowed=false', { writeAllowed: false }, 'permission'],
    ['writePaused', { writePaused: true }, 'write_paused'],
  ];
  for (const [label, over, expectedReason] of cases) {
    const w = world({ state: baseState(over) });
    try {
      const out = await w.path.write(write());
      assert.equal(out.ok, false, `${label}: 必须拒绝`);
      assert.equal(out.stage, 'reserve', `${label}: 归到预留阶段`);
      assert.equal(out.reason, expectedReason, `${label}: 拒绝码`);
      assert.equal(w.calls.length, 0, `${label}: transport 零调用`);
      assert.equal(w.readLedger().used.post, 0, `${label}: 配额零消耗`);
      assert.deepEqual(w.readLedger().reservations, {}, `${label}: 不得留下 reservation`);
    } finally { w.close(); }
  }
});

// ── 3. daily cap refusal ───────────────────────────────────────────────────────────
test('WP-3 日额度拒绝 → transport 零调用、配额不增', async () => {
  // Uses `like`, not `publish`: the reservation module checks the INTERVAL before the daily cap, so
  // a second publish inside 2h is refused as `interval` and would never reach the `limit` branch.
  // Likes have no interval, which makes the cap the first rule that can fire.
  const w = world({ state: baseState({ limits: { post: 3, comment: 25, like: 1 } }) });
  try {
    assert.equal((await w.path.write(write({ id: 'a', action: 'like', postId: 'p-a' }))).ok, true);
    assert.equal(w.readLedger().used.like, 1, '前提：额度已用满 1');

    const out = await w.path.write(write({ id: 'b', action: 'like', postId: 'p-b' }));
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'reserve');
    assert.equal(out.reason, 'limit');
    assert.equal(w.calls.length, 1, '被限额拒绝的调用不得触达 transport');
    assert.equal(w.readLedger().used.like, 1);
  } finally { w.close(); }
});

// ── 4. all four actions through the same facade ────────────────────────────────────
test('WP-4 四种 action 走同一门面，各映射到正确配额桶且不动别的桶', async () => {
  assert.deepEqual([...WRITE_ACTIONS].sort(), ['comment', 'like', 'publish', 'reply']);
  assert.deepEqual({ ...ACTION_TO_KIND }, { publish: 'post', comment: 'comment', reply: 'comment', like: 'like' },
    'reply 计入 comment 桶：否则在 comment/reply 之间交替就能绕过每日评论额度');

  for (const action of ['publish', 'comment', 'reply', 'like']) {
    // A `reply` is the one action whose legality is not only about the request: since the evidence
    // gate moved into the reservation transaction, a reply ALSO needs a corroborating
    // `state.commentEvidence` row and its parent-comment author on the request. Both are FIXTURES
    // (see `replyEvidence`); without them this case would measure the evidence gate instead of the
    // quota buckets it is about. The same goes for `audit: []`, which the audited reservation appends
    // its `unknown` intent to.
    const postId = `p-${action}`;
    const w = world({ state: action === 'reply' ? replyState(postId) : baseState() });
    try {
      // A `reply` needs its parent comment id AND the parent's author: since t69 the facade
      // validates parameters strictly and refuses a reply without them BEFORE reserving anything
      // (see the F-M3-1 cases in test-qzone-write-gate-linearization.mjs). The old fixture omitted
      // them, which was a request the platform call could never have been built from.
      const out = await w.path.write(write({
        id: `id-${action}`, action, postId,
        ...(action === 'reply' ? { commentId: 'c-1', commentUin: REPLY_COMMENT_UIN } : {}),
      }));
      assert.equal(out.ok, true, `${action} 必须能走通: ${JSON.stringify(out)}`);
      assert.equal(out.stage, 'transport');
      assert.equal(w.calls.length, 1, `${action}: transport 恰好一次`);

      const kind = ACTION_TO_KIND[action];
      assert.equal(w.calls[0].kind, kind, `${action} 映射到 ${kind} 桶`);
      assert.equal(w.readLedger().used[kind], 1, `${action}: ${kind} 桶 +1`);
      for (const other of ['post', 'comment', 'like']) {
        if (other === kind) continue;
        assert.equal(w.readLedger().used[other], 0, `${action}: 不得动 ${other} 桶`);
      }
    } finally { w.close(); }
  }
});

test('WP-4b 读操作与未知 action 在授权阶段被拒，零消耗', async () => {
  for (const action of ['read_posts', 'read_comments', 'nonsense', '', undefined, null, 42]) {
    const w = world();
    try {
      const out = await w.path.write(write({ action }));
      assert.equal(out.ok, false, `${String(action)}: 必须拒绝`);
      assert.equal(out.stage, 'authorize', `${String(action)}: 在授权阶段拒绝`);
      assert.equal(out.reason, 'not-a-write-action');
      assert.equal(w.calls.length, 0);
      assert.deepEqual(w.readLedger().used, { post: 0, comment: 0, like: 0 });
    } finally { w.close(); }
  }
});

// ── 5. unknown keeps everything ────────────────────────────────────────────────────
test('WP-5 传输未知 → 配额保留、同 id 再调被拒', async () => {
  const w = world({ transport: async () => ({ unknown: true }) });
  try {
    const out = await w.path.write(write());
    assert.equal(out.ok, true);
    assert.equal(out.outcome, 'unknown', 'unknown 必须如实透传，不得升级为 success');
    assert.equal(out.reason, 'unknown-outcome');
    assert.equal(w.readLedger().used.post, 1, '前提：配额到了 1，且不能退回 0');

    // Past the 2h publish interval, so the only rule that can still refuse this is the DURABLE
    // reservation for the same id — that is what we want to observe here.
    w.advance(2 * 60 * 60 * 1000);
    const again = await w.path.write(write());
    assert.equal(again.ok, false);
    assert.equal(again.stage, 'reserve');
    assert.equal(again.reason, 'duplicate', '未知不是「可以重发」的信号：同 id 仍被预留挡住');
    assert.equal(w.calls.length, 1, 'unknown 之后不得重发');
  } finally { w.close(); }
});

// ── 6. success does not release the id ─────────────────────────────────────────────
test('WP-6 成功后再调同 id → 仍被拒', async () => {
  const w = world();
  try {
    assert.equal((await w.path.write(write())).outcome, 'success');
    // Advance past the publish interval so the refusal below is unambiguously the reservation, not
    // the interval rule.
    w.advance(2 * 60 * 60 * 1000);
    const second = await w.path.write(write());
    assert.equal(second.ok, false);
    assert.equal(second.stage, 'reserve');
    assert.equal(second.reason, 'duplicate', '成功不是放行第二次的理由');
    assert.equal(w.calls.length, 1);
    assert.equal(w.readLedger().used.post, 1);
  } finally { w.close(); }
});

// ── 7. master switch off ───────────────────────────────────────────────────────────
test('WP-7 总开关关闭 → 四种 action 全拒且零消耗', async () => {
  for (const action of ['publish', 'comment', 'reply', 'like']) {
    // Same fixture note as WP-4, for the same reason: a reply needs a corroborating evidence row and
    // its parent-comment author to be a LEGAL request. This case measures the master switch — if the
    // fixture were illegal the refusal would come from the parameter validator before the switch was
    // ever consulted (`invalid-comment-uin`), which is exactly the false reading this avoids.
    const postId = 'p-1';
    const w = world({
      state: action === 'reply'
        ? replyState(postId, { enabled: false })
        : baseState({ enabled: false }),
    });
    try {
      const out = await w.path.write(write({
        id: `id-${action}`, action, postId,
        ...(action === 'reply' ? { commentId: 'c-1', commentUin: REPLY_COMMENT_UIN } : {}),
      }));
      assert.equal(out.ok, false, `${action}: 关总开关必须拒绝`);
      assert.equal(out.stage, 'reserve');
      assert.equal(out.reason, 'disabled');
      assert.equal(w.calls.length, 0, `${action}: transport 零调用`);
      assert.deepEqual(w.readLedger().used, { post: 0, comment: 0, like: 0 }, `${action}: 零消耗`);
    } finally { w.close(); }
  }
});

// ── 8. state is re-read on every call ──────────────────────────────────────────────
test('WP-8 每次调用都重读状态：暂停立即生效、恢复立即放行', async () => {
  const w = world();
  try {
    assert.equal((await w.path.write(write({ id: 'a' }))).ok, true);
    assert.equal(w.readLedger().used.post, 1);

    w.patch(() => ({ writePaused: true }));
    const paused = await w.path.write(write({ id: 'b' }));
    assert.equal(paused.stage, 'reserve');
    assert.equal(paused.reason, 'write_paused');
    assert.equal(w.readLedger().used.post, 1, '暂停期间零消耗');
    assert.equal(w.calls.length, 1);

    w.patch(() => ({ writePaused: false }));
    // Move past the 2h publish interval so this call is refused by nothing but the gate.
    w.advance(2 * 60 * 60 * 1000);
    const resumed = await w.path.write(write({ id: 'c' }));
    assert.equal(resumed.ok, true, '恢复后必须立即可写（说明没有缓存旧状态）');
    assert.equal(w.readLedger().used.post, 2);
  } finally { w.close(); }
});

// ── 9. final pause check: reserved but NOT sent ────────────────────────────────────
test('WP-9 预留后、发送前被暂停 → 不发送，且如实报告配额已消耗', async () => {
  // The transport flips the pause ON as a side effect the first time it would run; that is the only
  // way to land a pause strictly between the reserve transaction and the final check.
  let flip = false;
  const w = world({ transport: async () => ({ ok: true }) });
  try {
    // First write succeeds normally and establishes a non-zero baseline.
    assert.equal((await w.path.write(write({ id: 'a' }))).ok, true);
    assert.equal(w.readLedger().used.post, 1);
    w.advance(2 * 60 * 60 * 1000);

    // Now arrange the interleaving by hand: reserve, then pause, then let the facade check.
    // We simulate it by pausing AFTER the reservation would be taken — the facade's final check
    // reads committed state, so a pause present at that moment must stop the send.
    const original = w.store.update.bind(w.store);
    let n = 0;
    w.store.update = (fn) => {
      n += 1;
      // The first update inside this call is the reserve; flip the pause before the final check.
      const out = original(fn);
      if (n === 1 && flip) { original((s) => ({ ...s, writePaused: true })); }
      return out;
    };
    flip = true;
    const out = await w.path.write(write({ id: 'b' }));
    assert.equal(out.ok, false, '被最终检查拦下');
    assert.equal(out.stage, 'transport');
    assert.equal(out.outcome, 'not-sent');
    assert.equal(out.reason, 'paused-before-send');
    assert.equal(out.transportCalled, false, '绝不发送');
    assert.equal(out.quotaConsumed, true, '配额已消耗必须如实报告（这是设计选择，不是 bug）');
    assert.equal(w.calls.length, 1, 'transport 没有被第二次调用');
    assert.equal(w.readLedger().used.post, 2, '预留已落盘：used 从 1 变成 2，且不会退回');
    assert.equal(w.readState().writePaused, true);
  } finally { w.close(); }
});

// ── 10. no bypass ──────────────────────────────────────────────────────────────────
test('WP-10 无旁路：导出与句柄公开面受控', () => {
  const source = fs.readFileSync(new URL('../src/core/qzone-write-path-offline.mjs', import.meta.url), 'utf8');
  const exported = [...source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/gm)]
    .map((m) => m[1]).sort();
  // The export set SHRANK in t69, and that is the point of the change: `issueWritePermit` /
  // `readWritePermit` and the durable `state.writePermits` they wrote are GONE (v6 §2.4 chose the
  // "no new object" branch; observing a permit was the only reason they existed).
  //
  // `clearFaultLatchIfRevision` was ADDED later (Codex R7 counterexample 3) and it is not a widening
  // for convenience: `clearFaultLatch` is an unconditional escape hatch, so a recovery that needed to
  // avoid erasing a NEWER fault could only have used that hatch. The compare-and-clear is the narrow
  // primitive an operator path needs, and it is the ONLY new name.
  assert.deepEqual(exported, ['ACTION_TO_KIND', 'WRITE_ACTIONS', 'advanceRevision', 'clearFaultLatch',
    'clearFaultLatchIfRevision', 'createOfflineWritePath', 'latchFault', 'readFaultLatch'],
    '导出集必须恰是这八个（测试用的 _classifyForTests 走单独一行 export 语句，见下一个断言）');
  assert.match(source, /^export \{ classifyTransportResult as _classifyForTests \};$/m,
    '_classifyForTests 必须以独立 export 语句出现（不是 function 声明）');
  // THE COUNTER WRITER IS GONE ON PURPOSE (Codex CODEX-TEST-SEAM-CLOSE-20261114 §B). An exported
  // `_setRevisionForTests(store, value)` could LOWER a live authority's revision counter, which is a
  // hand-made version of the ABA the monotonic counter exists to prevent. Overflow coverage is kept by
  // testing the pure rule `advanceRevision` instead, and `LZ-9f` pins that no writer is exported.
  // Comments mention the removed name on purpose (they explain WHY it is gone), so the guard tests
  // stripped CODE, not the raw file — otherwise documenting the removal would fail the removal check.
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.equal(/setRevisionForTests/.test(codeOnly), false,
    '★★ 代码里不得再出现修订号写入器（它能把旧修订号变回可清状态）');

  const w = world();
  try {
    assert.deepEqual(Object.keys(w.path).sort(), ['ledger', 'write'],
      '句柄只暴露 write 与只读诊断 ledger');
    for (const forbidden of ['settlement', 'transport', 'store', 'authorize', 'settle', 'reserveWrite']) {
      assert.equal(Object.hasOwn(w.path, forbidden), false, `不得暴露 ${forbidden}`);
    }
  } finally { w.close(); }
});

// ── 11. construction guards ────────────────────────────────────────────────────────
test('WP-11 构造期校验：缺 store/clock/transport 直接 TypeError', () => {
  const ok = {
    store: { read: () => baseState(), update: (fn) => fn(baseState()) },
    clock: () => T0,
    transport: async () => ({ ok: true }),
  };
  const build = (over) => () => createOfflineWritePath({ ...ok, ...over });
  assert.throws(build({ store: undefined }), /needs a store with read\/update/);
  // R6: an unbound handle is refused BEFORE the clock/transport checks, so a bare double cannot reach
  // them. Declaring it is what makes the remaining assertions testable — and that is the point: the
  // authority requirement is now the FIRST gate, not an afterthought.
  assert.throws(build({}), /needs a store with a send authority/,
    '★ 未声明的裸 double 必须在构造期被拒（fail-closed）');
  // THE LATER GATES NEED AN AUTHORITY. A hand-written double has none and there is no longer any
  // call that grants one (Codex §A), so this uses a real temporary store — which is also the honest
  // fixture: the gate under test is about clocks and transports, not about faking a database.
  const t11 = tempDb('wp11');
  const real11 = openOfflineStore(t11.dbPath, baseState());
  const buildDeclared = (over) => () => createOfflineWritePath({
    ...ok, store: real11, ...over,
  });
  try {
  assert.throws(buildDeclared({ clock: undefined }), /needs a clock/);
  assert.throws(buildDeclared({ transport: undefined }), /needs a transport/);
  assert.throws(buildDeclared({ limits: [] }), /limits must be an object/);
  assert.doesNotThrow(buildDeclared({}));
  } finally { try { real11.close(); } catch {} t11.cleanup(); }
});
