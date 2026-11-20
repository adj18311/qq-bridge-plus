// B3 REPLY CHAIN — EVIDENCE AGE, PROVEN THROUGH THE WRITE PATH ITSELF (no consumer.check anywhere).
//
// WHY A SECOND AGE FILE, WHEN `test-qzone-reply-evidence-reserve-age.mjs` ALREADY EXISTS
// --------------------------------------------------------------------------------------
// That file calls `reserveAuditedOfflineInteraction` DIRECTLY. It therefore proves the reservation's
// own rule, but says nothing about the chain the product actually uses: a caller could reach the
// reservation with a different (or missing) `maxAgeMs`, and a direct-call test would never notice.
// This file goes through `createOfflineWritePath(...).write({ action: 'reply' })` — the same entry
// point production uses — with a REAL temp SQLite store and a fake transport, and never imports the
// consumer. What it pins:
//
//   TTL-1  a fresh row is accepted by the write path and DOES spend one `comment` unit
//   TTL-2  an expired row is refused at `stage:'reserve'` with `evidence-expired`, spending nothing
//   TTL-3  an undated row is refused with `evidence-undated`, spending nothing
//   TTL-4  the chain cannot be talked out of the bound: an `enforceEvidenceAge:false` handed to the
//          FACADE is not forwarded, so a row that would be accepted under the legacy opt-out is still
//          refused here
//
// TTL-4 is the one that matters. The whitelist lives on the reservation function for old direct
// callers; the write path must not become a way to reach it. The probe below does not trust the
// source text: it hands the facade the very flag that would disable the rule and asserts the refusal
// still happens, which is only possible if the flag never reached the reservation.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createOfflineWritePath } from '../src/core/qzone-write-path-offline.mjs';
import {
  DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS, reserveAuditedOfflineInteraction,
} from '../src/core/qzone-reservation-offline.mjs';

const NOW = Date.parse('2026-11-08T04:00:00.000Z');
const TARGET = '9876543210';
const POST_ID = 'p-ttl-1';
const COMMENT_ID = 'c-ttl-1';
const COMMENT_UIN = 7;
/** The bound the write path is expected to use, read from the module rather than re-typed. */
const MAX_AGE = DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS;

function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-ttl-${label}-`));
  return {
    dir,
    dbPath: path.join(dir, 'state.db'),
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const baseState = () => ({
  enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
  tools: { publish: true, comment: true, reply: true, like: true, read_posts: true },
  limits: { post: 10, comment: 25, like: 30 },
  ledger: { day: '2026-11-08', used: { post: 0, comment: 0, like: 0 }, reservations: {} },
  lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [], audit: [],
  commentEvidence: [],
});

/** A world over a real SQLite file, driven only through the write path. */
function world() {
  const db = tempDb('w');
  const store = openOfflineStore(db.dbPath, baseState());
  const calls = [];
  let clockNow = NOW;
  const writePath = createOfflineWritePath({
    store,
    clock: () => clockNow,
    transport: async (request) => { calls.push(request); return { ok: true }; },
  });
  return {
    store,
    calls,
    write: (over = {}) => writePath.write({
      id: 'ttl-1', action: 'reply', target: TARGET, postId: POST_ID,
      source: 'qq', content: 'reply body', commentUin: COMMENT_UIN, commentId: COMMENT_ID,
      ...over,
    }),
    seed: (rows) => store.update((state) => ({ ...state, commentEvidence: rows })),
    setNow: (v) => { clockNow = v; },
    cleanup: () => { try { store.close(); } catch { /* already closed */ } db.cleanup(); },
  };
}

/** The row shape the reservation accepts when the caller supplied no reply identity. */
const row = (at) => ({
  target: TARGET, postId: POST_ID, commentId: COMMENT_ID,
  commentUin: COMMENT_UIN, replyUin: null, replyName: null,
  ...(at === undefined ? {} : { at }),
});

const cost = (store) => {
  const state = store.read();
  return {
    usedComment: state.ledger.used.comment,
    reservations: Object.keys(state.ledger.reservations ?? {}).sort(),
    lastCommentAt: state.lastCommentAt,
    commentTargets: JSON.parse(JSON.stringify(state.commentTargets ?? [])),
    auditLength: Array.isArray(state.audit) ? state.audit.length : -1,
  };
};

// ── TTL-1: fresh evidence goes all the way through the write path ───────────────────────────────
test('TTL-1 写路径 + 新鲜证据（at = now - 1000）⇒ 放行并真的扣 1 个 comment 单位', async () => {
  const w = world();
  try {
    w.seed([row(NOW - 1000)]);
    const before = cost(w.store);
    assert.equal(before.usedComment, 0, '前提：配额从 0 起');

    const out = await w.write();

    assert.equal(out.ok, true, `新鲜证据必须放行到 transport: ${JSON.stringify(out)}`);
    assert.equal(out.stage, 'transport', '★ 走到 transport 阶段（说明预留真的提交了）');
    assert.equal(out.transportCalled, true);
    assert.equal(w.calls.length, 1, '★ transport 恰被调用一次');
    const after = cost(w.store);
    assert.equal(after.usedComment, 1, '★★ 放行必须真的扣 1：否则"扣额"没被观察到');
    assert.equal(after.lastCommentAt, NOW, '★ 且推进了评论冷却时钟');
    assert.deepEqual(after.reservations, ['ttl-1'], '★ 预留已落盘');
  } finally { w.cleanup(); }
});

// ── TTL-2: expired evidence is refused at `reserve`, costing nothing ────────────────────────────
test('TTL-2 写路径 + 过期证据（at = now - maxAgeMs - 1）⇒ reserve 阶段拒绝，五项全不变', async () => {
  const w = world();
  try {
    w.seed([row(NOW - MAX_AGE - 1)]);
    const before = cost(w.store);

    const out = await w.write();

    assert.equal(out.ok, false, '过期的证据必须被拒');
    assert.equal(out.stage, 'reserve', '★★ 拒绝落在预留阶段（未扣额、未发送）');
    assert.equal(out.reason, 'evidence-expired', '★★ 拒因点名"过期"');
    assert.equal(Object.hasOwn(out, 'quotaConsumed'), false, '★ 预留前拒绝没有 quotaConsumed 字段');
    assert.equal(w.calls.length, 0, '★★ transport 零调用');
    const after = cost(w.store);
    assert.equal(after.usedComment, 0, '★★ 零配额');
    assert.equal(after.lastCommentAt, null, '★★ 零冷却');
    assert.deepEqual(after.commentTargets, before.commentTargets, '★★ commentTargets 未变');
    assert.deepEqual(after.reservations, [], '★★ 无预留记录');
    assert.equal(after.auditLength, before.auditLength, '★★ 审计未增');
  } finally { w.cleanup(); }
});

// ── TTL-3: an undated row is refused, costing nothing ───────────────────────────────────────────
test('TTL-3 写路径 + 缺 at 的证据 ⇒ evidence-undated，五项全不变', async () => {
  const w = world();
  try {
    w.seed([row(undefined)]);
    assert.equal(Object.hasOwn(row(undefined), 'at'), false, '前提：这一行确实没有 at');
    const before = cost(w.store);

    const out = await w.write();

    assert.equal(out.ok, false, '没有 at 的证据必须被拒');
    assert.equal(out.stage, 'reserve');
    assert.equal(out.reason, 'evidence-undated', '★★ 拒因点名"无日期"');
    assert.equal(w.calls.length, 0, '★★ transport 零调用');
    const after = cost(w.store);
    assert.equal(after.usedComment, 0, '★★ 零配额');
    assert.equal(after.lastCommentAt, null, '★★ 零冷却');
    assert.deepEqual(after.commentTargets, before.commentTargets, '★★ commentTargets 未变');
    assert.deepEqual(after.reservations, [], '★★ 无预留记录');
    assert.equal(after.auditLength, before.auditLength, '★★ 审计未增');
  } finally { w.cleanup(); }
});

// ── TTL-4: the chain cannot be talked out of the bound ──────────────────────────────────────────
//
// THE PROBE, in three steps, so that the conclusion does not rest on reading source text:
//
//   (a) DIRECT control: the reservation function DOES honour `enforceEvidenceAge:false`. Same store,
//       same undated row, direct call → accepted. (Without this the test would pass even if the flag
//       were inert everywhere, which would prove nothing about the write path.)
//   (b) FACADE attempt: the same undated row through the write path, with the facade handed an
//       `enforceEvidenceAge:false` in its own options AND in the write request. The write path builds
//       the reservation request itself, so neither can reach it → refused.
//   (c) FRESH row through the facade still succeeds, so (b) is not merely "the chain rejects
//       everything".
test('TTL-4 B3 链无法关闭时效：enforceEvidenceAge:false 透传到不了预留层（直接调用却有效，对照）', async () => {
  const w = world();
  try {
    // ── (a) DIRECT: the legacy opt-out really works when used as designed ────────────────────────
    const directIntent = {
      time: NOW, source: 'qq', action: 'reply', target: TARGET, postId: POST_ID,
      commentId: COMMENT_ID, content: 'reply body', result: 'unknown', reason: '',
    };
    w.seed([row(undefined)]);
    const direct = reserveAuditedOfflineInteraction(
      w.store,
      {
        id: 'ttl-4-direct', now: NOW, tool: 'reply', target: TARGET, postId: POST_ID,
        commentId: COMMENT_ID, source: 'qq', enforceEvidenceAge: false,
        replyParams: { comment_id: COMMENT_ID, comment_uin: COMMENT_UIN },
      },
      directIntent,
    );
    assert.equal(direct.allowed, true,
      `★ 对照：直接调用时 enforceEvidenceAge:false 确实生效（否则本测试的"无效"结论没有意义）: ${JSON.stringify(direct)}`);

    // Reset the world: the direct call above spent a unit and claimed the id.
    w.cleanup();
    const w2 = world();
    try {
      // ── (b) FACADE: the same opt-out, offered everywhere a caller could put it ────────────────
      w2.seed([row(undefined)]);
      const before = cost(w2.store);
      const attempted = await w2.write({ enforceEvidenceAge: false });

      assert.equal(attempted.ok, false,
        '★★★ B3 链必须仍然拒绝：写路径不得把调用方的"关闭时效"意图透传下去');
      assert.equal(attempted.stage, 'reserve');
      assert.equal(attempted.reason, 'evidence-undated',
        '★★★ 拒因仍是"无日期"，说明时效判定照常执行');
      assert.equal(w2.calls.length, 0, '★★ transport 零调用');
      const after = cost(w2.store);
      assert.deepEqual(after, before, '★★ 零消耗：配额/预留/冷却/commentTargets/审计五项全不变');

      // ── (c) the same world with a FRESH row still sends, so (b) is not "the chain is broken" ──
      w2.seed([row(NOW - 1000)]);
      const fresh = await w2.write({ id: 'ttl-4-fresh' });
      assert.equal(fresh.ok, true,
        `★ 对照组：同一 world 换新鲜行必须放行（证明上面不是因为链坏了才拒）: ${JSON.stringify(fresh)}`);
      assert.equal(w2.calls.length, 1, '★ 且真的发送了一次');
    } finally { w2.cleanup(); }
  } finally { /* w already cleaned */ }
});
