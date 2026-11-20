// END-TO-END coverage of the offline write path — the rules that were UNREACHABLE from this entrance
// before the t26 rewrite.
//
// Why a separate file: `test-qzone-write-path-offline.mjs` covers the facade's STAGE contract (which
// stage answers, what ran, what did not). This file covers the PRODUCT RULES as they actually behave
// through the facade, over a real temporary SQLite file and a fake transport:
//
//   · the same-post like de-duplication      (was bypassable with a fresh id)
//   · the GLOBAL 3-minute comment interval    (was bypassable by changing the target)
//   · comment and reply sharing that interval (was bypassable by alternating the tool)
//   · the 2-hour publish interval             (was bypassable with a fresh id)
//   · cross-day persistence of the cooldown state
//   · cross-restart persistence (close + reopen the database)
//   · positive controls so a blanket lock-out cannot pass this file
//   · concurrency: one winner, one duplicate, `used` +1 only
//   · exact accounting: one success = exactly +1, never +2 (no double deduction)
//
// Each assertion is written to be able to fail on its own.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createOfflineWritePath } from '../src/core/qzone-write-path-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { _classifyWriteTransportResult as classify } from '../src/core/qzone-write-settlement-offline.mjs';

/** 2026-11-07 23:59:00 Beijing — three and a half hours after T0-ish anchors used below. */
const T_BASE = Date.parse('2026-11-07T15:59:00.000Z');   // = 23:59 Beijing
/** 2026-11-07 12:00 Beijing — far from midnight, so an hours-long advance cannot roll the day. */
const T_NOON = Date.parse('2026-11-07T04:00:00.000Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const TARGET_A = '9876543210';
const TARGET_B = '1122334455';

function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-wpe2e-${label}-`));
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

const freshLedger = (day) => ({ day, used: { post: 0, comment: 0, like: 0 }, reservations: {} });

const baseState = (now = T_BASE, over = {}) => ({
  enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
  tools: { publish: true, comment: true, reply: true, like: true, read_posts: true },
  limits: { post: 10, comment: 25, like: 30 },
  ledger: freshLedger(beijingDay(now)),
  lastPostAt: null,
  lastCommentAt: null,
  commentTargets: [],
  likes: [],
  // A reply reserves through `reserveAuditedOfflineInteraction`, which appends an `unknown` intent
  // audit row in the SAME transaction as the quota unit, so the state needs the collection a real
  // store has. Non-reply actions leave it untouched.
  audit: [],
  ...over,
});

/**
 * A state in which a `reply` to `commentId` on `postId` is LEGAL, and a FIXTURE — stated, not glossed.
 *
 * The evidence gate moved into the reservation transaction, so a reply is refused unless exactly one
 * `state.commentEvidence` row matches the identity triple AND the reply identity frozen on the
 * dispatch. **No producer of that collection was found within the checked scope** (this repository's
 * `src/`), so a test can only seed it; doing so proves the GATE behaves as specified, not that a real
 * reply can be sent. Cases below that are about a DIFFERENT rule (the shared 3-minute interval) need
 * the reply to be otherwise legal, or they would measure the evidence gate instead.
 */
const REPLY_COMMENT_UIN = 7;
const replyState = (now = T_BASE, { target = TARGET_A, postId = 'p-1', commentId = 'cm-1', over = {} } = {}) => baseState(now, {
  commentEvidence: [{
    target, postId, commentId,
    commentUin: REPLY_COMMENT_UIN, replyUin: null, replyName: null,
    // ⚠️ `at` IS PART OF THE ROW NOW. The reservation judges evidence AGE inside the same transaction
    // as the identity check, so a row with no dateable stamp is refused as `evidence-undated` instead
    // of being treated as ageless. Seeding `at` with the world's own start clock keeps every case here
    // measuring what it says it measures: with the WRITE PATH's default window (10 minutes) the rows
    // stay fresh across the sub-minute advances these cases use, so a refusal still names the rule
    // under test (`interval`, `quota`, …) rather than the age gate.
    at: now,
  }],
  ...over,
});

/**
 * One world over a real temp SQLite file. `reopen()` closes and re-opens the SAME file, which is how
 * cross-restart persistence is checked.
 */
function world({ now = T_BASE, state, dbPath } = {}) {
  const t = tempDb('w');
  const file = dbPath ?? t.dbPath;
  let clockNow = now;
  const calls = [];
  let store = openOfflineStore(file, state ?? baseState(now));
  let path = build(store);

  function build(currentStore) {
    return createOfflineWritePath({
      store: currentStore,
      clock: () => clockNow,
      transport: async (req) => { calls.push(req); return { ok: true }; },
    });
  }

  return {
    t, file, calls,
    get store() { return store; },
    get path() { return path; },
    setNow: (v) => { clockNow = v; },
    advance: (ms) => { clockNow += ms; },
    readState: () => store.read(),
    readLedger: () => store.read().ledger,
    /** Close and reopen the same file: everything must come back from disk. */
    reopen() {
      store.close();
      store = openOfflineStore(file, {});
      path = build(store);
      return store.read();
    },
    close() { try { store.close(); } catch {} t.cleanup(); },
  };
}

// The facade refuses a like that carries a body (`FIELDS.like` in the write contract has no
// `content`, and snapshotRequest enforces that before reserving — t10 / LZ-16). So the default body
// is attached only to actions that HAVE a body; a `like` fixture must be body-less, exactly as the
// contract requires.
//
// A `reply` additionally carries its parent comment's AUTHOR (`commentUin`, i.e. `comment_uin`), which
// is mandatory for a reply since the reply-identity validation was added: the evidence the reservation
// compares is keyed on it. Every other default of this helper is unchanged.
const req = (over = {}) => {
  const action = over.action ?? 'comment';
  const base = { id: 'r-1', action, target: TARGET_A, postId: 'p-1', source: 'qq', content: 'hi', ...over };
  if (action === 'like' && over.content === undefined) base.content = undefined;
  if (action === 'reply' && over.commentUin === undefined) base.commentUin = REPLY_COMMENT_UIN;
  return base;
};

// ── 1. same-post like de-duplication (the named bypass) ────────────────────────────
test('E2E-1 不同 id、同一 (author, postId) 的第二次点赞 → duplicate_like', async () => {
  const w = world();
  try {
    const first = await w.path.write(req({ id: 'like-1', action: 'like', postId: 'post-9' }));
    assert.equal(first.ok, true, `第一次点赞必须成功: ${JSON.stringify(first)}`);
    assert.equal(w.calls.length, 1);
    assert.equal(w.readLedger().used.like, 1, '前提：like 桶真的 +1');

    // A FRESH id on the SAME post: the daily cap and the id reservation both allow this, so only
    // the like de-duplication can refuse it.
    const second = await w.path.write(req({ id: 'like-2', action: 'like', postId: 'post-9' }));
    assert.equal(second.ok, false, '同一帖子换新 id 点赞必须被拒');
    assert.equal(second.stage, 'reserve');
    assert.equal(second.reason, 'duplicate_like');
    assert.equal(w.calls.length, 1, '被去重拒绝的点赞不得触达 transport');
    assert.equal(w.readLedger().used.like, 1, '被拒的点赞不得消耗配额');
    assert.deepEqual(w.readState().likes, [{ author: TARGET_A, id: 'post-9' }], 'likes 里只有第一次那一条');
  } finally { w.close(); }
});

// ── 2. global 3-minute comment interval across DIFFERENT targets ────────────────────
test('E2E-2 不同 target 的 comment 在 3 分钟内 → interval（全局共享，不区分对象）', async () => {
  const w = world();
  try {
    assert.equal((await w.path.write(req({ id: 'c-1', target: TARGET_A, postId: 'p-1' }))).ok, true);
    assert.equal(w.calls.length, 1);
    assert.equal(w.readState().lastCommentAt, T_BASE, '前提：全局 lastCommentAt 已落盘');

    // Different target, different post, fresh id — everything except the clock is different.
    w.advance(3 * MIN - 1000);
    const tooSoon = await w.path.write(req({ id: 'c-2', target: TARGET_B, postId: 'p-2' }));
    assert.equal(tooSoon.ok, false, '换 target 不能绕过 3 分钟');
    assert.equal(tooSoon.stage, 'reserve');
    assert.equal(tooSoon.reason, 'interval');
    assert.equal(w.calls.length, 1, '被间隔拒绝不得触达 transport');
    assert.equal(w.readLedger().used.comment, 1, '被拒不得消耗配额');
  } finally { w.close(); }
});

// ── 3. comment and reply share the same interval ───────────────────────────────────
test('E2E-3 comment 与 reply 共享 3 分钟（交替验证）', async () => {
  // comment → reply
  {
    // The world starts in a state where THIS reply would be legal: its evidence row matches the
    // identity triple and the frozen reply identity, and the request carries the parent's author.
    // Without that fixture the refusal would be `missing_comment_evidence`, not `interval`, and the
    // case would stop measuring the shared cooldown.
    const w = world({ state: replyState(T_BASE, { target: TARGET_B, postId: 'p-1', commentId: 'cm-1' }) });
    try {
      assert.equal((await w.path.write(req({ id: 'c-1', action: 'comment', target: TARGET_A }))).ok, true);
      w.advance(30 * 1000);
      const reply = await w.path.write(req({ id: 'r-1', action: 'reply', target: TARGET_B, commentId: 'cm-1' }));
      assert.equal(reply.ok, false, 'comment 之后立刻 reply 必须被同一个间隔拒绝');
      assert.equal(reply.reason, 'interval');
      assert.equal(w.calls.length, 1);
      assert.equal(w.readLedger().used.comment, 1, '被拒的 reply 不得消耗配额（证据门已过，是间隔拒的）');
    } finally { w.close(); }
  }
  // reply → comment
  {
    const w = world({ state: replyState(T_BASE, { target: TARGET_A, postId: 'p-1', commentId: 'cm-1' }) });
    try {
      assert.equal((await w.path.write(req({ id: 'r-1', action: 'reply', target: TARGET_A, commentId: 'cm-1' }))).ok, true);
      w.advance(30 * 1000);
      const comment = await w.path.write(req({ id: 'c-1', action: 'comment', target: TARGET_B }));
      assert.equal(comment.ok, false, 'reply 之后立刻 comment 也必须被同一个间隔拒绝');
      assert.equal(comment.reason, 'interval');
      assert.equal(w.calls.length, 1);
      assert.equal(w.readLedger().used.comment, 1);
      assert.equal(w.readState().lastCommentAt, T_BASE, 'reply 真的推进了共享的评论时钟');
    } finally { w.close(); }
  }
});

// ── 4. 2-hour publish interval ─────────────────────────────────────────────────────
test('E2E-4 第二条 publish 在 2 小时内 → interval', async () => {
  const w = world();
  try {
    assert.equal((await w.path.write(req({ id: 'p-1', action: 'publish' }))).ok, true);
    assert.equal(w.readState().lastPostAt, T_BASE, '前提：lastPostAt 已落盘');

    w.advance(2 * HOUR - 1000);
    const second = await w.path.write(req({ id: 'p-2', action: 'publish' }));
    assert.equal(second.ok, false, '2 小时内第二条 publish 必须被拒');
    assert.equal(second.reason, 'interval');
    assert.equal(w.calls.length, 1);
    assert.equal(w.readLedger().used.post, 1, '被拒不得消耗配额');
  } finally { w.close(); }
});

// ── 5. cross-day: the cooldown survives midnight ───────────────────────────────────
test('E2E-5 跨自然日：23:59 comment → 00:01 comment 仍拒；publish 同理', async () => {
  const w = world();
  try {
    assert.equal(beijingDay(T_BASE), '2026-11-07', '前提：起点是 11-07 的 23:59 北京时间');
    assert.equal((await w.path.write(req({ id: 'c-1', action: 'comment' }))).ok, true);

    // 00:01 next day: the DAILY quota has rolled over (a new bucket day), but the interval has not —
    // 2 minutes elapsed, not 3.
    w.advance(2 * MIN);
    assert.equal(beijingDay(T_BASE + 2 * MIN), '2026-11-08', '前提：确实跨了北京日');
    const commentNextDay = await w.path.write(req({ id: 'c-2', action: 'comment', target: TARGET_B }));
    assert.equal(commentNextDay.ok, false, '跨日不重置 3 分钟间隔');
    assert.equal(commentNextDay.reason, 'interval');
    assert.equal(w.calls.length, 1);
  } finally { w.close(); }
  {
    const w = world();
    try {
      assert.equal((await w.path.write(req({ id: 'p-1', action: 'publish' }))).ok, true);
      w.advance(2 * MIN);   // past midnight
      const publishNextDay = await w.path.write(req({ id: 'p-2', action: 'publish' }));
      assert.equal(publishNextDay.ok, false, '跨日不重置 2 小时间隔');
      assert.equal(publishNextDay.reason, 'interval');
      assert.equal(w.calls.length, 1);
    } finally { w.close(); }
  }
});

// ── 6. cross-restart persistence ──────────────────────────────────────────────────
test('E2E-6 跨重启：close + reopen 后 lastCommentAt / lastPostAt / likes 仍在', async () => {
  const w = world();
  try {
    assert.equal((await w.path.write(req({ id: 'c-1', action: 'comment' }))).ok, true);
    assert.equal((await w.path.write(req({ id: 'l-1', action: 'like', postId: 'post-7' }))).ok, true);
    const before = w.readState();
    assert.equal(before.lastCommentAt, T_BASE);
    assert.deepEqual(before.likes, [{ author: TARGET_A, id: 'post-7' }]);

    const after = w.reopen();
    assert.equal(after.lastCommentAt, T_BASE, 'lastCommentAt 必须从磁盘回来');
    assert.equal(after.lastPostAt, null, 'lastPostAt 未被写过，必须仍是 null（不是被写成 0）');
    assert.deepEqual(after.likes, [{ author: TARGET_A, id: 'post-7' }], 'likes 必须从磁盘回来');
    assert.equal(after.ledger.used.comment, 1, 'quota 也必须在磁盘上');

    // And the rules still BITE after the restart — persistence is only useful if it is enforced.
    const comment = await w.path.write(req({ id: 'c-2', action: 'comment', target: TARGET_B }));
    assert.equal(comment.reason, 'interval', '重启后 3 分钟间隔仍生效');
    const like = await w.path.write(req({ id: 'l-2', action: 'like', postId: 'post-7' }));
    assert.equal(like.reason, 'duplicate_like', '重启后点赞去重仍生效');
    assert.equal(w.calls.length, 2, '两次被拒都没有触达 transport');
  } finally { w.close(); }
});

// ── 7. positive controls (a blanket lock-out must not pass this file) ─────────────
test('E2E-7 正对照：满 2 小时 / 满 3 分钟 / 新帖子点赞 → 必须通过', async () => {
  // Anchored at NOON, not 23:59: the +2h advance below must not roll the Beijing day, otherwise the
  // publish bucket resets and `used.post` would legitimately read 1 instead of 2 — a false failure
  // caused by the fixture, not by the rule.
  const w = world({ now: T_NOON });
  try {
    assert.equal((await w.path.write(req({ id: 'p-1', action: 'publish' }))).ok, true);

    w.advance(2 * HOUR);   // exactly 2h: `checkInterval` uses >=, so this must pass
    assert.equal((await w.path.write(req({ id: 'p-2', action: 'publish' }))).ok, true, '满 2 小时必须放行');

    assert.equal((await w.path.write(req({ id: 'c-1', action: 'comment', target: TARGET_A }))).ok, true);
    w.advance(3 * MIN);    // exactly 3min
    assert.equal((await w.path.write(req({ id: 'c-2', action: 'comment', target: TARGET_B }))).ok, true, '满 3 分钟必须放行');

    assert.equal((await w.path.write(req({ id: 'l-1', action: 'like', postId: 'post-1' }))).ok, true);
    assert.equal((await w.path.write(req({ id: 'l-2', action: 'like', postId: 'post-2' }))).ok, true, '换一个帖子点赞必须放行');

    assert.equal(w.calls.length, 6, '六次都被允许，且每次都恰好一次');
    assert.deepEqual(w.readLedger().used, { post: 2, comment: 2, like: 2 }, '每个桶各 +2');
  } finally { w.close(); }
});

// ── 8. concurrency: one winner, one duplicate, +1 only ────────────────────────────
test('E2E-8 并发同 id：恰好一个成功、一个 duplicate，used 只 +1', async () => {
  const w = world();
  try {
    assert.equal(w.readLedger().used.like, 0, '前提：从 0 开始');
    // `like` is the action used here on purpose. A second `comment` would be refused by the 3-minute
    // interval BEFORE the reservation is consulted, and a second `like` on the SAME post would be
    // refused by `wasLiked` — neither of those would demonstrate the durable id guard. Two likes on
    // DIFFERENT posts with the SAME id isolate it: the only rule that can refuse the loser is the
    // reservation keyed by id.
    //
    // Both calls are issued before either settles. Node runs them on one thread, so the interleaving
    // that matters is between the two SYNCHRONOUS reserve transactions — the second must see the
    // first's committed reservation and refuse.
    const [a, b] = await Promise.all([
      w.path.write(req({ id: 'same', action: 'like', postId: 'post-A' })),
      w.path.write(req({ id: 'same', action: 'like', postId: 'post-B' })),
    ]);
    const okCount = [a, b].filter((r) => r.ok === true).length;
    const dupCount = [a, b].filter((r) => r.ok === false && r.reason === 'duplicate').length;
    assert.equal(okCount, 1, `恰好一个成功（实际 ${JSON.stringify([a.ok, b.ok])}）`);
    assert.equal(dupCount, 1, `另一个必须是 duplicate（实际 ${JSON.stringify([a.reason, b.reason])}）`);
    assert.equal(w.readLedger().used.like, 1, 'used.like 必须只 +1（并发不是 +2）');
    assert.equal(Object.keys(w.readLedger().reservations).length, 1, '只应有一条 reservation');
    assert.equal(w.calls.length, 1, 'transport 只被调用一次');
  } finally { w.close(); }
});

// ── 9. no double deduction ────────────────────────────────────────────────────────
test('E2E-9 无双重扣额：单次成功调用后 used[kind] 恰好 +1（不是 +2）', async () => {
  for (const [action, kind] of [['publish', 'post'], ['comment', 'comment'], ['like', 'like']]) {
    const w = world();
    try {
      const before = w.readLedger().used[kind];
      assert.equal(before, 0, `${action}: 前提从 0 开始`);
      const out = await w.path.write(req({ id: `only-${action}`, action, postId: `post-${action}` }));
      assert.equal(out.ok, true, `${action}: 必须成功`);
      const after = w.readLedger().used[kind];
      assert.equal(after, 1, `${action}: used.${kind} 必须恰好是 1 —— 若为 2 说明预留被扣了两次`);
      assert.equal(after - before, 1, `${action}: 增量必须恰好 1`);
      // The reservation must be recorded exactly once as well.
      assert.equal(Object.keys(w.readLedger().reservations).length, 1, `${action}: 只应有一条 reservation`);
    } finally { w.close(); }
  }
});

// ── 10. refusals have zero side effects, measured from a non-zero baseline ────────
test('E2E-10 拒绝零副作用：先推到非零基线，再验拒绝后一切不变', async () => {
  const w = world();
  try {
    assert.equal((await w.path.write(req({ id: 'ok-1', action: 'comment', target: TARGET_A }))).ok, true);
    const baseline = w.readState();
    assert.equal(baseline.ledger.used.comment, 1, '前提：配额基线已经是 1');
    assert.equal(baseline.lastCommentAt, T_BASE, '前提：lastCommentAt 已经是非 null');
    assert.equal(w.calls.length, 1);

    // Refused by the interval (only 30s elapsed).
    w.advance(30 * 1000);
    const refused = await w.path.write(req({ id: 'refused-1', action: 'comment', target: TARGET_B }));
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'interval');

    const after = w.readState();
    assert.equal(after.ledger.used.comment, 1, '配额必须仍是 1');
    assert.equal(after.lastCommentAt, T_BASE, 'lastCommentAt 不得被拒绝的调用改写');
    assert.equal(Object.keys(after.ledger.reservations).length, 1, '不得留下新的 reservation');
    assert.equal(after.ledger.reservations['refused-1'], undefined);
    assert.equal(w.calls.length, 1, 'transport 不得被调用');
  } finally { w.close(); }
});

// ── 11. classify conflict precedence ──────────────────────────────────────────────
test('E2E-11 classify 冲突组合：unknown 优先于 notSent，且其余组合不回归', () => {
  // The dangerous direction: downgrading "I cannot tell" into "definitely not sent".
  assert.equal(classify({ notSent: true, unknown: true }), 'unknown',
    '{notSent:true, unknown:true} 必须是 unknown —— 不能相信更乐观的那一半');
  assert.equal(classify({ outcome: 'not-sent', unknown: true }), 'unknown',
    'outcome:not-sent 与 unknown:true 冲突时同样是 unknown');

  // The no-regression set the task names explicitly.
  assert.equal(classify({ unknown: true }), 'unknown');
  assert.equal(classify({ notSent: true }), 'not-sent');
  assert.equal(classify({ ok: true, unknown: true }), 'unknown');
  assert.equal(classify({ ok: false, unknown: true }), 'unknown');

  // And the unambiguous singles keep their own labels, so the assertions above are not vacuous.
  assert.equal(classify({ ok: true }), 'success');
  assert.equal(classify({ ok: false }), 'failed');
  assert.equal(classify({ outcome: 'success' }), 'success');
  assert.equal(classify({ outcome: 'failed' }), 'failed');
  assert.equal(classify({ outcome: 'not-sent' }), 'not-sent');
  assert.equal(classify({ ok: true, notSent: true }), 'unknown', 'success 与 not-sent 冲突同样是 unknown');
  assert.equal(classify({}), 'unknown');
});
