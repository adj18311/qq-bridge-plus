// t40 — the offline filter for a page of comments under ANY post (`plain-comments` scope).
//
// WHAT THIS FILE PROVES, AND WHAT IT CANNOT
// ----------------------------------------
// It proves the FILTER: given a page the projection already built, which comments may be shown,
// and what shape they come out in. It does NOT prove the reader wiring, the scope validation or
// the transport request shape — those live in `qzone-live-friend-read.mjs` /
// `qzone-read-scope-offline.mjs` and are covered where they belong.
//
// ⚠️ THE SEVEN-DAY WINDOW IS ON THE COMMENT, NOT THE POST. Measured against a real detail
// response: `get_qzone_msg_detail` returns `{tid, content, comment_num, comments[]}` and does NOT
// carry the post's own `time`, so "is this post within a week" cannot be answered from a detail
// read at all. Filtering on each comment's own timestamp is the only reading this layer can
// support, and it is also the useful one.
import assert from 'node:assert/strict';
import test from 'node:test';

import { filterOfflineCommentPage } from '../src/core/qzone-comment-page-offline.mjs';

const NOW = Date.parse('2026-11-18T04:00:00Z');
const DAY = 86400000;
const SCOPE = Object.freeze({ author: '456', postId: 'post-1' });

/** A well-formed page as `projectQzoneOnebotMsgDetail` would produce it (times in ms). */
function page(comments, overrides = {}) {
  return { author: '456', postId: 'post-1', comments, ...overrides };
}
function comment(id, timeOffset, extra = {}) {
  return { id, author: '789', time: NOW - timeOffset, content: 'body-' + id, ...extra };
}

test('CP-1 正常页：只保留 7 天内，字段恰为 {id,author,time,content}（无 name）', () => {
  const result = filterOfflineCommentPage(page([
    comment('c1', 1000),
    comment('c2', 3 * DAY),
    comment('c3', 6 * DAY),
  ]), SCOPE, NOW);

  assert.deepEqual(result.comments.map((entry) => entry.id), ['c1', 'c2', 'c3']);
  for (const entry of result.comments) {
    assert.deepEqual(Object.keys(entry).sort(), ['author', 'content', 'id', 'time'],
      '★ 字段必须恰为 {id,author,time,content} —— name 不得出现');
  }
  assert.deepEqual(result.parent, { author: '456', postId: 'post-1' });
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.comments) && Object.isFrozen(result.comments[0]),
    '返回体必须冻结：调用方不得改写已过滤的页');
});

test('CP-2 8 天前的评论被过滤；未来时间的评论被过滤；7 天整仍保留（含边界）', () => {
  const result = filterOfflineCommentPage(page([
    comment('week-old', 7 * DAY),
    comment('eight-days', 8 * DAY),
    comment('a-year', 365 * DAY),
    { id: 'future', author: '789', time: NOW + 1000, content: 'not yet' },
  ]), SCOPE, NOW);

  assert.deepEqual(result.comments.map((entry) => entry.id), ['week-old'],
    '★ 恰好 7 天保留，8 天/1 年/未来一律剔除');
});

test('CP-3 page 的 author / postId 不匹配 ⇒ 返回 null（拒绝，不是空页）', () => {
  assert.equal(filterOfflineCommentPage(page([comment('c1', 1000)], { author: '999' }), SCOPE, NOW), null,
    '作者不同必须是 null');
  assert.equal(filterOfflineCommentPage(page([comment('c1', 1000)], { postId: 'post-2' }), SCOPE, NOW), null,
    '说说 id 不同必须是 null');
  // Non-vacuity: the SAME page with matching identity yields comments, so the nulls above are not
  // caused by something else being wrong with the fixture.
  assert.equal(filterOfflineCommentPage(page([comment('c1', 1000)]), SCOPE, NOW).comments.length, 1);
});

test('CP-4 畸形输入 ⇒ TypeError（不是静默空页）', () => {
  const good = page([comment('c1', 1000)]);
  const bad = [
    [undefined, SCOPE],
    [null, SCOPE],
    [good, undefined],
    [good, null],
    [{ ...good, comments: 'not-an-array' }, SCOPE],
    [{ ...good, author: '' }, SCOPE],
    [{ ...good, postId: 123 }, SCOPE],
    [{ author: '456', postId: 'post-1' }, SCOPE],
    [{ ...good, comments: [null] }, SCOPE],
    [{ ...good, comments: [{ id: 'c', author: '789', time: NOW, content: 42 }] }, SCOPE],
    [{ ...good, comments: [{ id: 'c', author: '789', time: NOW }] }, SCOPE],
    [{ ...good, comments: [{ author: '789', time: NOW, content: 'x' }] }, SCOPE],
  ];
  for (const [pageValue, scopeValue] of bad) {
    assert.throws(() => filterOfflineCommentPage(pageValue, scopeValue, NOW),
      (error) => error instanceof TypeError,
      '畸形输入必须抛 TypeError: ' + JSON.stringify(pageValue)?.slice(0, 60));
  }
  // A non-finite clock is a caller bug, not "no comments".
  assert.throws(() => filterOfflineCommentPage(good, SCOPE, Number.NaN), (error) => error instanceof TypeError);
  assert.throws(() => filterOfflineCommentPage(good, SCOPE, undefined), (error) => error instanceof TypeError);
});

test('CP-5 时间不可用时丢弃该条而非整体失败；空评论页返回空数组', () => {
  const result = filterOfflineCommentPage(page([
    { id: 'no-time', author: '789', content: 'x' },
    { id: 'nan-time', author: '789', time: Number.NaN, content: 'x' },
    { id: 'string-time', author: '789', time: '1700000000000', content: 'x' },
    comment('ok', 1000),
  ]), SCOPE, NOW);
  assert.deepEqual(result.comments.map((entry) => entry.id), ['ok'],
    '没有可用时间戳的评论被丢弃，好的那条仍然保留');

  const empty = filterOfflineCommentPage(page([]), SCOPE, NOW);
  assert.deepEqual(empty.comments, [], '空评论页是合法的：返回空数组而不是抛错');
  assert.deepEqual(empty.parent, { author: '456', postId: 'post-1' });
});

test('CP-6 name 等额外字段不透传（用 descriptor 读取，accessor 一律抛错）', () => {
  const withName = filterOfflineCommentPage(page([
    { id: 'c1', author: '789', name: '昵称', time: NOW - 1000, content: 'x' },
  ]), SCOPE, NOW);
  assert.equal(Object.hasOwn(withName.comments[0], 'name'), false, '★ name 不得透传到返回体');

  const hostile = { id: 'c2', author: '789', time: NOW - 1000, content: 'x' };
  Object.defineProperty(hostile, 'id', { enumerable: true, get() { throw new Error('getter ran'); } });
  assert.throws(() => filterOfflineCommentPage(page([hostile]), SCOPE, NOW),
    (error) => error instanceof TypeError,
    'accessor 型字段不得被执行，必须按畸形输入拒绝');
});

// ══════════════════════════════════════════════════════════════════════════════════════
// The `plain-comments` scope and the reader branch — the wiring the filter plugs into.
// ══════════════════════════════════════════════════════════════════════════════════════

test('CP-7 scope 校验：plain-comments 合格形状通过；带 event / 错 action / commentId 非空 一律 TypeError', async () => {
  const { snapshotReadScope } = await import('../src/core/qzone-read-scope-offline.mjs');
  const proof = Object.freeze({ id: 'r1', source: 'requested', targetQq: 456, botQq: 123,
    sourceProofId: 'src1', connectionEpoch: 8 });
  const base = { kind: 'plain-comments', readId: 'r1', requester: '456', author: '456',
    postId: 'post-1', commentId: null, grantId: null, question: null };

  const accepted = snapshotReadScope({ ...base }, proof, '999', 'read_comments', 'post-1');
  assert.equal(accepted.kind, 'plain-comments');
  assert.ok(Object.isFrozen(accepted), 'scope 必须冻结');

  const bad = [
    // An event belongs to own-new-comment only: accepting one here would let a caller smuggle the
    // reply-evidence machinery into a page read.
    [{ ...base, event: { isNew: true, selfId: '123', author: '456', postId: 'post-1', commentId: 'c1' } }, 'read_comments', 'post-1'],
    [{ ...base }, 'read_posts', 'post-1'],                       // wrong action
    [{ ...base, postId: null }, 'read_comments', null],           // no post id
    [{ ...base }, 'read_comments', 'post-2'],                     // postId must match the call
    [{ ...base, commentId: 'c1' }, 'read_comments', 'post-1'],    // page read, not a single comment
    [{ ...base, grantId: 'g1' }, 'read_comments', 'post-1'],      // own-history machinery
    [{ ...base, postIds: ['post-1'] }, 'read_comments', 'post-1'],// own-history machinery
    [{ ...base, author: '999' }, 'read_comments', 'post-1'],      // must bind to the request target
  ];
  for (const [scope, action, postId] of bad) {
    assert.throws(() => snapshotReadScope(scope, proof, '999', action, postId),
      (error) => error instanceof TypeError,
      '必须拒绝: ' + JSON.stringify(scope));
  }
});

test('CP-8 reader：plain-comments 走普通 transport，请求是 detail 形状，且不写任何证据', async (t) => {
  const { createQzoneLiveFriendRead } = await import('../src/core/qzone-live-friend-read.mjs');
  const seen = [];
  // THE STORE IS INSPECTED AFTERWARDS for a commentEvidence row. A page read must not create one:
  // the evidence row exists so a later REPLY can cite a comment the operator received, and this
  // scope has no trusted "new comment" event to base that claim on.
  let state = { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: true }, reads: 0, writes: 0, readAttempts: {}, readOutcomes: {},
    notices: [], browseDay: '2026-11-18', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
    activeStart: 0, activeEnd: 1439, audit: [], grants: {}, commentEvidence: {} };
  const store = { read: () => structuredClone(state),
    update(fn) { state = fn(structuredClone(state)); return structuredClone(state); } };
  const detail = { status: 'ok', retcode: 0, data: { tid: 'post-1', content: 'body', comment_num: 2, comments: [
    { comment_id: 'c1', uin: 789, name: 'nick', time: Math.floor((NOW - 1000) / 1000), content: 'recent', replies: [] },
    { comment_id: 'c2', uin: 790, name: 'nick2', time: Math.floor((NOW - 8 * DAY) / 1000), content: 'old', replies: [] },
  ] } };
  const reader = createQzoneLiveFriendRead({
    store, clock: () => NOW, offlineTestFixture: true,
    verifyRequestProof: async () => ({ id: 'cr1', sourceProofId: 'src1', source: 'requested',
      targetQq: 456, botQq: 123, connectionEpoch: 8 }),
    // ⚠️ THE RECEIPT MUST BE THE REAL SHAPE (t50). This fixture used to answer
    // `{ trustedStatus, friend }` — the shape `createQzoneLiveFriendProof` returns from its own
    // `verify`, NOT the shape `boundFriendReceipt` accepts. Nobody noticed because this scope is
    // supplied by `resolveScope` (not derived), so before t50 NEITHER friend check ran for it.
    // Now that a plain-comments read is friendship-gated at both ends, the wrong shape is caught:
    // the read correctly refuses with `unverified`. Fixing the fixture (not the assertion) is the
    // honest repair — a receipt the real verifier would never produce is not a valid fixture.
    verifyFriendship: async () => ({ status: 'friend', sourceProofId: 'src1',
      botQq: 123, targetQq: 456, connectionEpoch: 8 }),
    exceptionReads: { adminQq: '999',
      resolveScope: async () => ({ kind: 'plain-comments', readId: 'cr1', requester: '456', author: '456',
        postId: 'post-1', commentId: null, grantId: null, question: null }),
      isScopeCurrent: () => true, finishScope: () => {}, contextFor: () => ({ readId: 'cr1' }) },
    transport: async (request) => { seen.push({ ...request }); return detail; },
  });

  const result = await reader.readComments({ targetQq: 456 }, 'post-1');

  assert.equal(seen.length, 1, '★ 必须恰好一次平台调用');
  assert.deepEqual(seen[0], {
    action: 'get_qzone_msg_detail', tid: 'post-1', target_uin: 456, pos: 0, num: 20,
    botQq: 123, connectionEpoch: 8, sourceProofId: 'src1',
  }, '★ transport 必须收到约定好的 detail 形状（与 t41 的唯一契约）');

  assert.equal(result.outcome, 'success', '前提：这次读必须成功: ' + JSON.stringify(result));
  assert.deepEqual(result.parent, { author: '456', postId: 'post-1' });
  assert.deepEqual(result.comments, [{ id: 'c1', author: '789', time: NOW - 1000, content: 'recent' }],
    '★ 只保留 7 天内的评论（8 天前那条被过滤）');

  const evidence = state.commentEvidence ?? {};
  assert.deepEqual(Object.keys(evidence), [], '★ plain-comments 不得写入任何 commentEvidence 行');
});

// ── CP-9/CP-10: 读评论同样受「好友 + 7 天」双重限制（t46） ─────────────────────────
//
// 用户的裁决：读评论不是特权通道 —— 它和读帖走同一套约束。
// 这两条把口径钉死，避免以后有人为了「读得更全」在评论路径上偷偷放宽。

test('CP-9 读评论的 7 天窗口是硬边界：8 天前的一条都不返回，边界整 7 天仍保留', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  // ⚠️ `time` 是 epoch 毫秒（projection 的契约），不是秒 —— 这里直接给毫秒。
  const at = (days) => now - days * 86400000;
  const page = {
    author: '456',
    postId: 'p1',
    comments: [
      { id: 'c1', author: '789', time: at(0), content: 'today' },
      { id: 'c2', author: '789', time: at(6.9), content: 'six-nine' },
      { id: 'c3', author: '789', time: at(7), content: 'exactly-seven' },
      { id: 'c4', author: '789', time: at(7.01), content: 'just-over' },
      { id: 'c5', author: '789', time: at(30), content: 'a-month' },
      { id: 'c6', author: '789', time: at(400), content: 'a-year' },
    ],
  };
  const out = filterOfflineCommentPage(page, Object.freeze({ author: '456', postId: 'p1' }), now);
  assert.ok(out !== null, '合法页必须返回对象');
  const ids = out.comments.map((c) => c.id);
  assert.deepEqual(ids, ['c1', 'c2', 'c3'],
    '只保留 7 天内（含边界），8 天前/一个月前/一年前的一条都不许漏进来；实得 ' + ids.join(','));
});

test('CP-10 读评论没有 admin 豁免：即使页面上写着某些特权字段也不放宽窗口', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const old = now - 30 * 86400000;
  // 上游 payload 里塞特权字样不能改变过滤结果 —— 过滤只看 scope 与时间。
  const page = {
    author: '456',
    postId: 'p1',
    admin: true,
    isAdmin: true,
    privileged: true,
    comments: [{ id: 'c1', author: '789', time: old, content: 'old' }],
  };
  const out = filterOfflineCommentPage(page, Object.freeze({ author: '456', postId: 'p1' }), now);
  assert.deepEqual(out.comments, [], '30 天前的评论必须被丢弃，页面上的任何字样都不能放宽窗口');
});
