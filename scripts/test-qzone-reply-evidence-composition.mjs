// Tests for the evidence-age COMPOSITION (`qzone-reply-evidence-composition-offline.mjs`).
//
// ⚠️ WHAT THESE TWO TESTS DO **NOT** PROVE — READ FIRST ⚠️⚠️
// ---------------------------------------------------------
//   · Every `state.commentEvidence` row here is a FIXTURE: the projection comes from
//     `bindAuthorizedQzoneReply` called on a SYNTHETIC `get_detail`-shaped payload. No platform, QQ,
//     bridge or config was contacted; real temp SQLite files only.
//   · The module under test has NO production caller within the checked scope this repository's `src/`,
//     so a green run proves the GATE IS WIRED to the reservation — not that replies are protected in
//     any deployment. Not a claim about environments outside the checked scope.
//   · The consumer gate's own details (undated rows, future `at`, boundary, identity mismatch, clock
//     errors) are covered by the existing `REC-*` suite in
//     `scripts/test-qzone-reply-evidence-consumer.mjs`. This file deliberately does NOT repeat them:
//     it only proves the two things that were missing — that the gate is ON the path, and that its
//     refusal costs nothing while a pass reserves exactly once.
//
// WHAT THESE TESTS PIN
// --------------------
//   RC-1  an EXPIRED row ⇒ `reserveReply` refuses with `evidence-expired`, and `used.comment`,
//         `lastCommentAt`, `commentTargets`, the B2 reservation key and `audit` are unchanged;
//         measured proof that the reservation was NOT called: the `update()` counter does not move.
//   RC-2  a FRESH row ⇒ `reserveReply` allows, `used.comment` goes to 1, one B2 key is taken, and the
//         reservation used the CLOCK's instant (not the caller-supplied `request.now`).

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { bindAuthorizedQzoneReply } from '../src/core/qzone-comment-binding-offline.mjs';
import { createQzoneReplyEvidenceStore } from '../src/core/qzone-reply-evidence-store-offline.mjs';
import {
  REPLY_EVIDENCE_CONSUMER_REASONS as R,
} from '../src/core/qzone-reply-evidence-consumer-offline.mjs';
import {
  DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS,
  createQzoneReplyEvidenceComposition,
} from '../src/core/qzone-reply-evidence-composition-offline.mjs';

const NOW = Date.parse('2026-11-15T04:00:00Z');
const MAX_AGE_MS = DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS;   // 10 minutes, the module's own default
const TARGET = '123';
const POST_ID = 'old_post_1';
const COMMENT_ID = 'parent_1';
// Deliberately WRONG on the request/intent: the composition must overwrite both with the clock's
// instant, so a stale or forged caller timestamp cannot move the quota day, the interval or the audit.
const BOGUS_NOW = 999;

// ══════════════════════════════════════════════════════════════════════════════════════════════
// FIXTURES — synthetic detail payload, trusted-shaped projection, state
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** One synthetic `get_detail`-shaped envelope: a post with ONE parent comment carrying ONE reply. */
function detailFor() {
  return {
    status: 'ok', retcode: 0,
    data: {
      tid: POST_ID, content: 'synthetic post', comment_num: 1,
      comments: [{
        comment_id: COMMENT_ID, uin: 456, name: 'Parent', time: NOW / 1000 - 10,
        content: 'synthetic parent',
        replies: [{
          comment_id: 'reply_1', uin: 789, name: 'Reply Nick', time: NOW / 1000 - 5,
          content: 'synthetic reply', parent_comment_id: COMMENT_ID, parent_comment_uin: 456,
        }],
      }],
    },
  };
}

/** The reply-shaped projection, produced by a real `bindAuthorizedQzoneReply` on the FIXTURE above. */
function replyProjection() {
  const target = { author: TARGET, id: POST_ID };
  const metadata = { author: target.author, id: target.id, time: NOW / 1000 };
  // t47: `admin` no longer authorizes anything. The surviving way to reach an OLD post in this
  // fixture is the `shared` exception — the operator's own "someone shared this post with me"
  // path, which names exactly this post.
  const scope = { author: target.author, friend: false, sharedPostId: target.id, now: NOW };
  return bindAuthorizedQzoneReply(target, metadata, scope, detailFor(), COMMENT_ID, 'reply_1');
}

const baseState = () => ({
  enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
  selfId: TARGET,
  tools: { publish: true, comment: true, reply: true, like: true },
  limits: { post: 5, comment: 5, like: 5 },
  ledger: { day: beijingDay(NOW), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
  lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [],
  outcomes: {}, dispatchClaims: {}, notices: [], audit: [],
  commentEvidence: [],
});

/** The audited reply request + its intent, exactly as the write path shapes them. */
function replyCall() {
  return {
    request: {
      id: 'r1', now: BOGUS_NOW, tool: 'reply', target: TARGET, postId: POST_ID, commentId: COMMENT_ID,
      source: 'qq',
      replyParams: { comment_id: COMMENT_ID, comment_uin: 456, reply_uin: 789, reply_name: 'Reply Nick' },
    },
    intent: {
      time: BOGUS_NOW, source: 'qq', action: 'reply', target: TARGET, postId: POST_ID,
      commentId: COMMENT_ID, content: 'synthetic reply body', result: 'unknown',
    },
  };
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qzone-reply-evidence-composition-${label}-`));
}

function removeDir(t, dir) {
  t.after(() => {
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
    }
  });
}

/**
 * A real temp SQLite file behind a DELEGATING wrapper that counts `update()` calls and clock reads.
 * Counting updates is how "the reservation was NOT called" is an OBSERVATION rather than a comment;
 * counting clock reads is how "read exactly once per `reserveReply`" is observed too.
 */
function world(t, { maxAgeMs } = {}) {
  const dir = tempDir('world');
  removeDir(t, dir);
  const inner = openOfflineStore(path.join(dir, 'state.db'), baseState());
  t.after(() => { try { inner.close(); } catch { /* already closed */ } });
  let updates = 0;
  let clockReads = 0;
  const store = { ...inner, update(fn) { updates += 1; return inner.update(fn); } };
  const producer = createQzoneReplyEvidenceStore({ store });
  const composition = createQzoneReplyEvidenceComposition({
    store,
    clock: () => { clockReads += 1; return NOW; },
    ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
  });
  return { store, producer, composition, updates: () => updates, clockReads: () => clockReads };
}

/** Everything a refused reply must leave byte-identical. */
function costSnapshot(store) {
  const state = store.read();
  return {
    used: { ...state.ledger.used },
    lastCommentAt: state.lastCommentAt,
    commentTargets: JSON.parse(JSON.stringify(state.commentTargets)),
    reservations: Object.keys(state.ledger.reservations).sort(),   // the B2 key is one of these
    auditLength: Array.isArray(state.audit) ? state.audit.length : -1,
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// RC-1 — expired row: the gate is on the path, and its refusal costs nothing
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('RC-1 过期证据 ⇒ reserveReply 拒绝，且配额/冷却/B2 键/audit 全不变（预留器未被调用）', (t) => {
  const { store, producer, composition, updates, clockReads } = world(t);

  // One row old enough to be outside the window by exactly ONE millisecond, written through the REAL
  // producer (so its `at` comes from the same kind of trusted `now` the write path would pass).
  assert.equal(producer.record(replyProjection(), { now: NOW - MAX_AGE_MS - 1 }).written, true);
  const updatesAfterSeed = updates();

  const before = costSnapshot(store);
  const decision = composition.reserveReply(replyCall());

  // The refusal comes from the GATE, in the gate's own vocabulary and shape.
  assert.equal(decision.ok, false, '过期的行不得授权回复');
  assert.equal(decision.reason, R.EVIDENCE_EXPIRED, `实际 reason=${decision.reason}`);
  assert.equal(decision.maxAgeMs, MAX_AGE_MS);
  assert.ok(Object.isFrozen(decision));

  // The decisive observation: the seed was the LAST write. A called reservation would have updated.
  assert.equal(updates(), updatesAfterSeed, '预留器未被调用（update 计数未增加）');
  assert.deepEqual(costSnapshot(store), before, '拒绝零消耗：used/lastCommentAt/commentTargets/B2/audit 均不变');
  assert.equal(store.read().ledger.used.comment, 0, 'comment 配额未消耗');
  assert.equal(store.read().lastCommentAt, null, '冷却时间未推进');
  assert.deepEqual(Object.keys(store.read().ledger.reservations), [], 'B2 键未被占用');
  // Exactly one clock read for the whole call: the gate's.
  assert.equal(clockReads(), 1, 'clock 只被读一次');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// RC-2 — fresh row: the gate passes and the reservation actually happens, once
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('RC-2 新鲜证据 ⇒ reserveReply 放行，used.comment +1、占用一个 B2 键，且用的是 clock 的时刻', (t) => {
  const { store, producer, composition, clockReads } = world(t);

  assert.equal(producer.record(replyProjection(), { now: NOW - 1000 }).written, true);

  const decision = composition.reserveReply(replyCall());

  assert.equal(decision.allowed, true, `放行失败：${decision.reason ?? ''}`);
  const state = store.read();
  assert.equal(state.ledger.used.comment, 1, '放行时花掉一个 comment 配额');
  assert.equal(state.lastCommentAt, NOW, '冷却时间推进到 clock 的时刻');
  assert.deepEqual(Object.keys(state.ledger.reservations), ['r1'], '占用了一个 B2 键');
  // The caller's bogus `now`/`time` were overwritten with the instant the age was measured against.
  assert.equal(state.audit.length, 1);
  assert.equal(state.audit[0].record.time, NOW, 'audit 用的是 clock 的时刻，不是调用方传入的 now');
  assert.equal(state.ledger.day, beijingDay(NOW));
  assert.equal(clockReads(), 1, 'clock 只被读一次');
});
