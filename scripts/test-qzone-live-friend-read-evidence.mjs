// THE REAL READ CHAIN -> `state.commentEvidence` -> reply reservation.
//
// WHAT THIS FILE PROVES (and what it deliberately does not)
// --------------------------------------------------------
// The gap this closes: `qzone-reply-evidence-store-offline.mjs` had no producer inside `src/`, so
// every reply in the offline composition was refused with `missing_comment_evidence` and every test
// that exercised the reply gate had to SEED the collection. Here the row is produced by driving
// `createQzoneLiveFriendRead`'s `read_comments` success path with a fake host adapter, and the reply
// reservation is then fed ONLY that row — no `store.update(commentEvidence: ...)` seed anywhere in
// the positive control.
//
// The fake pieces are the ones the task allows to be fake: the platform adapter (`fetchCommentPage`)
// and the per-request host scope lookup. Everything else is the real code: the real read chain, the
// real `bindAuthorizedOwnNewQzoneComment`, the real evidence store, a real SQLite file, and the real
// `reserveAuditedOfflineInteraction`.
//
// NOT claimed: that a real QQ platform was contacted, or that provenance is provable. A frozen
// projection can be forged in-process (see the evidence store's own header). The guarantees pinned
// here are about PLACEMENT (only after every gate) and about RANGE (only own-new-comment).
//
// ⚠️ EVERY NEGATIVE CONTROL ASSERTS THE COLLECTION LENGTH IS UNCHANGED. That is the whole point:
// "the read failed" is not enough — the evidence must not be written either.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createQzoneLiveFriendRead } from '../src/core/qzone-live-friend-read.mjs';
import { reserveAuditedOfflineInteraction } from '../src/core/qzone-reservation-offline.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const NOW = Date.parse('2026-11-15T04:00:00Z');
const BOT = '123';
const COMMENT_ID = 'c7';
const POST_ID = 'p1';
const PARENT_QQ = 777;
const PARENT_NAME = 'Parent Name';

// ══════════════════════════════════════════════════════════════════════════════════════════════
// FIXTURES
// ══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The state the reader needs (read reservation + settle + policy gates) AND the reply reservation
 * needs (write quota + `commentEvidence`). `commentEvidence` starts EMPTY and is never seeded by a
 * test helper: the only writer in this file's positive control is the reader.
 */
function baseState(over = {}) {
  return {
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: false, read_comments: true, publish: false, comment: false, reply: true, like: false },
    reads: 0, writes: 0, readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-15', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
    activeStart: 0, activeEnd: 1439, audit: [], commentEvidence: [],
    limits: { post: 5, comment: 5, like: 5 },
    ledger: { day: '2026-11-15', used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    lastCommentAt: null, commentTargets: [], likes: [],
    ...over,
  };
}

/** A `get_detail`-shaped response: one post, one first-level comment `c7`, no replies. */
function detailPage({
  postId = POST_ID, commentId = COMMENT_ID, uin = PARENT_QQ, name = PARENT_NAME,
  extraComments = [],
} = {}) {
  return {
    status: 'ok', retcode: 0,
    data: {
      tid: postId, content: 'own older post body', comment_num: 1,
      comments: [
        { comment_id: commentId, uin, name, time: NOW / 1000 - 60, content: 'new own comment', replies: [] },
        ...extraComments,
      ],
    },
  };
}

/** The trusted per-call scope an `own-new-comment` read needs. Every field is host-supplied. */
function ownNewCommentScope(over = {}) {
  return {
    kind: 'own-new-comment', readId: 'r1', requester: '777',
    author: BOT, postId: POST_ID, commentId: COMMENT_ID, grantId: null, question: null,
    event: { isNew: true, selfId: BOT, author: BOT, postId: POST_ID, commentId: COMMENT_ID },
    ...over,
  };
}

const PROOF = () => ({
  id: 'r1', sourceProofId: 'src1', source: 'requested',
  targetQq: Number(BOT), botQq: Number(BOT), connectionEpoch: 8,
});

/** A plain in-memory store with `read()`/`update()` — the same interface `openOfflineStore` has. */
function memoryStore(initial) {
  let state = structuredClone(initial);
  return {
    read: () => structuredClone(state),
    update(fn) {
      const next = fn(structuredClone(state));
      state = next;
      return structuredClone(state);
    },
    /** Out-of-band mutation, used ONLY to simulate the host revoking something mid-request. */
    patch(patch) { state = { ...state, ...patch }; },
  };
}

/**
 * Build a reader wired to a fake host adapter.
 *
 * `host` keeps the CLOSED key set `qzone-read-scope-offline.mjs#closedOwnData` demands for
 * `exceptionReads` — an extra key is a construction error, not a warning.
 */
function fixture({
  store = memoryStore(baseState()),
  detail = detailPage(),
  scope = ownNewCommentScope(),
  proof = PROOF,
  adapter,
  finishScope,
  isScopeCurrent,
  resolveScope,
  // LFR-EV-9 needs the TWO knobs below; every other test keeps the original
  // behaviour, so the defaults are exactly what this fixture always did.
  //   `friendship` — the receipt `verifyFriendship` returns. `null` means "never a
  //     friend", which is fine for scoped reads (they skip the check) and is what
  //     a plain-comments read must NOT get.
  //   `transport`  — the ordinary bound transport. The default throws because a
  //     scoped read must never touch it; a plain-comments read is an ordinary
  //     transport read, so LFR-EV-9 supplies a page here.
  friendship = null,
  transport = async () => { throw new Error('read_comments must never use the list transport'); },
} = {}) {
  const calls = [];
  const finished = [];
  const host = {
    adminQq: '999',
    resolveScope: async () => (resolveScope ? resolveScope() : scope),
    isScopeCurrent: isScopeCurrent ?? (() => true),
    finishScope: (context, selected) => {
      finished.push({ context, scope: selected });
      return finishScope ? finishScope(context, selected) : undefined;
    },
    contextFor: () => Object.freeze({ action: 'read_comments', targetQq: BOT, readId: 'ctx' }),
    fetchCommentPage: async (operation) => {
      calls.push(operation);
      return adapter ? adapter(operation) : detail;
    },
  };
  const reader = createQzoneLiveFriendRead({
    store, clock: () => NOW, offlineTestFixture: true,
    verifyRequestProof: async () => proof(),
    verifyFriendship: async (binding) => (friendship ? friendship(binding) : null),
    transport,
    exceptionReads: host,
  });
  return { reader, store, calls, finished, host };
}

const rows = (store) => store.read().commentEvidence ?? [];
const rowCount = (store) => rows(store).length;

/** The reply request + its audit intent, addressed to the parent comment the read returned. */
function replyCall({ commentUin = PARENT_QQ } = {}) {
  return {
    request: {
      id: 'reply-1', now: NOW, tool: 'reply', target: BOT, postId: POST_ID, commentId: COMMENT_ID,
      source: 'qq', replyParams: { comment_id: COMMENT_ID, comment_uin: commentUin },
    },
    intent: {
      time: NOW, source: 'qq', action: 'reply', target: BOT, postId: POST_ID, commentId: COMMENT_ID,
      content: 'a reply body', result: 'unknown',
    },
  };
}

function tempStore(t, label, state = baseState()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-live-read-evidence-${label}-`));
  const file = path.join(dir, 'state.db');
  const store = openOfflineStore(file, state);
  const opened = [store];
  t.after(() => {
    for (const handle of opened) { try { handle.close(); } catch { /* already closed */ } }
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
    }
  });
  return { store, file, opened };
}

const readComments = (reader) => reader.readComments({ target: BOT }, POST_ID);

// ══════════════════════════════════════════════════════════════════════════════════════════════
// LFR-EV-1 — POSITIVE CONTROL: the real read chain produces the row, and the row unlocks a reply
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('LFR-EV-1 真实读取链成功 ⇒ state.commentEvidence 出现一条六字段记录，且该记录能放行 reply 预留', async (t) => {
  // REAL SQLite file, REAL evidence store, REAL reply reservation. The only fakes are the platform
  // adapter and the host scope lookup.
  const { store } = tempStore(t, 'positive');

  // PROOF THAT NOTHING IS SEEDED: the collection is empty BEFORE the read, and this file contains no
  // `store.update` writing `commentEvidence` anywhere. The row below can only come from the reader.
  assert.deepEqual(rows(store), [], '前提：读取之前集合是空的（没有任何 seed）');

  const { reader, calls } = fixture({ store });
  const result = await readComments(reader);

  assert.equal(result.outcome, 'success', '读取本身必须成功');
  assert.deepEqual(result.comments.map((c) => c.id), [COMMENT_ID]);
  assert.equal(calls.length, 1, '恰好一次 host adapter 调用');

  const stored = rows(store);
  assert.equal(stored.length, 1, '读取链写出了恰好一条证据');
  assert.deepEqual(stored[0], {
    target: BOT,
    postId: POST_ID,
    commentId: COMMENT_ID,
    commentUin: String(PARENT_QQ),
    replyUin: null,        // first-level comment addresses the THREAD, not a person
    replyName: null,
    at: NOW,
  }, '六个证据字段 + at，逐字段来自 bindAuthorizedOwnNewQzoneComment 的映射');
  // Fields nobody reads are NOT stored: the name is dropped, and no reply id was invented.
  assert.equal(Object.hasOwn(stored[0], 'commentName'), false);
  assert.equal(Object.hasOwn(stored[0], 'replyCommentId'), false);

  // ── CONSUME: the reply transaction, fed only the row the read chain produced ───────────────
  const { request, intent } = replyCall();
  const reserved = reserveAuditedOfflineInteraction(store, request, intent);
  assert.equal(reserved.allowed, true, '读取链写出的证据必须能放行 reply 预留');
  assert.equal(store.read().ledger.used.comment, 1, '放行时确实花掉一个 comment 配额');
});

test('LFR-EV-1b 同一读取链写出的证据在重开 SQLite 后仍然存在（真落盘，不是进程内态）', async (t) => {
  const { store, file, opened } = tempStore(t, 'persist');
  const { reader } = fixture({ store });
  assert.equal((await readComments(reader)).outcome, 'success');
  assert.equal(rows(store).length, 1, '前提：读取链写出了一条');
  store.close();
  // Re-open the SAME file: the row is in the store, not in the reader's memory.
  const again = openOfflineStore(file, baseState());
  opened.push(again);
  const persisted = rows(again);
  assert.equal(persisted.length, 1, '重开后证据仍在（真事务落盘）');
  assert.deepEqual(persisted[0], {
    target: BOT, postId: POST_ID, commentId: COMMENT_ID,
    commentUin: String(PARENT_QQ), replyUin: null, replyName: null, at: NOW,
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// NEGATIVE CONTROLS — each one must leave the collection length UNCHANGED
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('LFR-EV-2 读取失败（adapter throw）⇒ 不写证据', async () => {
  const store = memoryStore(baseState());
  const before = rowCount(store);
  const { reader, calls } = fixture({ store, adapter: () => { throw new Error('platform exploded: SECRET'); } });
  const result = await readComments(reader);
  assert.equal(result.outcome, 'unknown', '读取失败必须如实报 unknown');
  assert.equal(calls.length, 1, 'adapter 确实被调用过（失败发生在读取之后）');
  assert.equal(rowCount(store), before, '★ 失败路径不得写证据');
  assert.equal(JSON.stringify(store.read()).includes('SECRET'), false, '不泄露上游异常文本');
});

test('LFR-EV-3 读取中 epoch 变化（复验证明不再 sameProof）⇒ 不写证据', async () => {
  const store = memoryStore(baseState());
  const before = rowCount(store);
  let proofs = 0;
  const { reader } = fixture({
    store,
    // 1st: the initial proof, 2nd: pre-dispatch, 3rd: the post-I/O revalidation. Bumping the epoch
    // on the LAST one is exactly "the connection changed while the read was in flight".
    proof: () => ({ ...PROOF(), connectionEpoch: ++proofs <= 2 ? 8 : 9 }),
  });
  const result = await readComments(reader);
  assert.equal(result.outcome, 'unknown', 'epoch 变化后结果被丢弃');
  assert.equal(rowCount(store), before, '★ epoch 变化不得写证据');
});

test('LFR-EV-4 finishScope 失败 ⇒ 不写证据', async () => {
  const store = memoryStore(baseState());
  const before = rowCount(store);
  let finishes = 0;
  const { reader, finished } = fixture({
    store,
    finishScope: () => { finishes += 1; throw new Error('lease close failed'); },
  });
  const result = await readComments(reader);
  assert.equal(finishes, 1, 'finishScope 恰好被调用一次');
  assert.equal(finished.length, 1);
  assert.equal(result.outcome, 'unknown', '关闭 lease 失败必须降级为 unknown');
  assert.equal(rowCount(store), before, '★ finishScope 失败不得写证据');
});

test('LFR-EV-5 finishScope 返回非法值（异步 thenable）⇒ 同样不写证据', async () => {
  const store = memoryStore(baseState());
  const before = rowCount(store);
  const { reader } = fixture({ store, finishScope: () => Promise.reject(new Error('nope')) });
  const result = await readComments(reader);
  assert.equal(result.outcome, 'unknown');
  assert.equal(rowCount(store), before, '★ 非同步 true 的 finish 不得写证据');
  await new Promise((resolve) => setImmediate(resolve));   // observe the rejection
});

test('LFR-EV-6 最终策略检查失败（关闭 lease 后 read_comments 被关掉）⇒ 不写证据', async () => {
  const store = memoryStore(baseState());
  const before = rowCount(store);
  const { reader } = fixture({
    store,
    // ONLY flip the policy at lease-close time: `current()` (the synchronous in-flight recheck) is
    // still true, so this exercises the FINAL `authorizeTool` gate specifically.
    finishScope: () => store.patch({ tools: { ...store.read().tools, read_comments: false } }),
  });
  const result = await readComments(reader);
  assert.equal(result.outcome, 'unknown', '策略在 lease 关闭后失效 ⇒ 结果被丢弃');
  assert.equal(rowCount(store), before, '★ 最终策略检查失败不得写证据');
});

test('LFR-EV-6b 最终策略检查失败（关闭 lease 后 readAllowed=false）⇒ 不写证据', async () => {
  const store = memoryStore(baseState());
  const before = rowCount(store);
  const { reader } = fixture({ store, finishScope: () => store.patch({ readAllowed: false }) });
  const result = await readComments(reader);
  assert.equal(result.outcome, 'unknown');
  assert.equal(rowCount(store), before, '★ 同一失败门的不同原因都不得写证据');
});

test('LFR-EV-7 scope.event 与页面不匹配（filterOfflineOwnNewComment 返回 null）⇒ 不写证据', async () => {
  const store = memoryStore(baseState());
  const before = rowCount(store);
  const { reader } = fixture({
    store,
    // The page is well-formed but does NOT contain the event's comment id.
    detail: detailPage({ commentId: 'someone-else' }),
  });
  const result = await readComments(reader);
  assert.equal(result.outcome, 'unknown', '找不到事件指定的评论 ⇒ unknown');
  assert.equal(rowCount(store), before, '★ 过滤返回 null 时不得写证据');
});

test('LFR-EV-7b 投影过滤通过但可信绑定拒绝（事件 id 指向一条“回复”而非顶层评论）⇒ 不写证据', async () => {
  const store = memoryStore(baseState());
  const before = rowCount(store);
  // `projectQzoneOnebotMsgDetail` FLATTENS parents and replies into one list, so the offline filter
  // finds `c7` as a REPLY and passes. `bindAuthorizedOwnNewQzoneComment` only searches TOP-LEVEL
  // `data.comments`, so it refuses. This is the "filter said yes, trusted binding said no" path, and
  // the evidence write must not happen.
  const detail = {
    status: 'ok', retcode: 0,
    data: {
      tid: POST_ID, content: 'own older post body', comment_num: 1,
      comments: [{
        comment_id: 'parent_x', uin: 555, name: 'Someone', time: NOW / 1000 - 120, content: 'old comment',
        replies: [{ comment_id: COMMENT_ID, uin: PARENT_QQ, name: PARENT_NAME, time: NOW / 1000 - 60,
          content: 'a reply, not a top-level comment', parent_comment_id: 'parent_x', parent_comment_uin: 555 }],
      }],
    },
  };
  const { reader } = fixture({ store, detail });
  const result = await readComments(reader);
  assert.equal(result.outcome, 'success', '读取链本身仍然成功（收敛到一条评论）');
  assert.deepEqual(result.comments.map((c) => c.id), [COMMENT_ID]);
  assert.equal(rowCount(store), before, '★ 可信绑定拒绝时不得写证据（投影通过不等于可写）');
});

test('LFR-EV-8 释放前来源失效（in-flight current() 失败）⇒ 不写证据', async () => {
  const store = memoryStore(baseState());
  const before = rowCount(store);
  let current = true;
  const { reader } = fixture({
    store,
    isScopeCurrent: () => current,
    adapter: () => { current = false; return detailPage(); },   // revoke while the read is in flight
  });
  const result = await readComments(reader);
  assert.equal(result.outcome, 'unknown');
  assert.equal(rowCount(store), before, '★ 读取中被撤销的 scope 不得写证据');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// RANGE — only own-new-comment is supported, and only it can reach the writer
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('LFR-EV-9 模型输入无法自行写入证据：resolveScope 返回 null 时 read_comments 读成功但证据仍为 0 条', async () => {
  // WHAT THIS USED TO PIN: with no host scope, `read_comments` was refused with
  // `tool-not-wired` before dispatch, and the assertion was "zero rows written"
  // (trivially true, because nothing ran).
  //
  // WHAT IT PINS NOW (t42): a null scope DERIVES a `plain-comments` scope, so the
  // model-supplied request really does reach the platform and success is returned.
  // The property being protected has NOT changed — a model must not be able to
  // conjure an evidence row — but the failure mode to guard against is different:
  // before, "the read never happens"; now, "the read happens and must still write
  // nothing". The assertion below is therefore STRONGER, not weaker: identical
  // "zero rows" invariant, checked on a path that actually executed.
  //
  // The model input is stuffed with every field an evidence row would want
  // (including a full `commentEvidence` array and an `event`) precisely so that a
  // reader that trusted any of them would show up as a non-zero row count here.
  const store = memoryStore(baseState());
  const before = rowCount(store);
  const { reader, calls, host } = fixture({
    store,
    resolveScope: () => null,
    // A plain-comments read is an ORDINARY bound-transport read, so the friendship
    // receipt is required (the derived scope is built only after it passes). This is
    // the real receipt shape `boundFriendReceipt` accepts — NOT a bypass.
    friendship: (binding) => ({
      status: 'friend', sourceProofId: binding.sourceProofId,
      botQq: binding.botQq, targetQq: binding.targetQq, connectionEpoch: binding.connectionEpoch,
    }),
    transport: async () => detailPage(),
  });
  const result = await reader.readComments({
    target: BOT,
    commentId: COMMENT_ID,
    postId: POST_ID,
    event: { isNew: true, selfId: BOT, author: BOT, postId: POST_ID, commentId: COMMENT_ID },
    commentEvidence: [{ target: BOT, postId: POST_ID, commentId: COMMENT_ID, commentUin: String(PARENT_QQ) }],
    scope: ownNewCommentScope(),
  }, POST_ID);
  assert.equal(result.allowed, true, 'plain-comments 现在读得到：这条断言本身就是「不再是 tool-not-wired」的证据');
  assert.equal(result.outcome, 'success');
  assert.deepEqual(result.comments.map((comment) => comment.id), [COMMENT_ID],
    '返回的必须是平台那一页的评论，而不是模型自报的 commentId');
  assert.equal(calls.length, 0,
    'plain-comments 不得走 host 的 own-new-comment 适配器（fetchCommentPage）');
  assert.equal(host.fetchCommentPage !== undefined, true);
  assert.deepEqual(rows(store), [],
    '★ 核心不变量未变：读取成功也绝不能产生证据——模型自报的 event/commentEvidence 一个字段都不得落库');
  assert.equal(rowCount(store), before, '★ 证据条数必须仍为 0');
});

test('LFR-EV-10 读取链是 src 里唯一 import 证据存储的文件（模型输入不是第二个入口）', () => {
  const importer = /from\s+['"]\.\/qzone-reply-evidence-store-offline\.mjs['"]/;
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.mjs')) continue;
      if (importer.test(fs.readFileSync(full, 'utf8'))) found.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.deepEqual(found, ['src/core/qzone-live-friend-read.mjs'],
    '★ 唯一 importer 必须是读取链：多一个就是多一个可以写证据的入口');
});

test('LFR-EV-11 非 own-new-comment 的读取不产生证据（read_posts 成功路径）', async (t) => {
  const { store } = tempStore(t, 'read-posts', baseState({
    tools: { read_posts: true, read_comments: true, publish: false, comment: false, reply: true, like: false },
  }));
  const before = rowCount(store);
  const reader = createQzoneLiveFriendRead({
    store, clock: () => NOW, offlineTestFixture: true,
    verifyRequestProof: async () => ({ id: 'r2', sourceProofId: 'src2', source: 'requested',
      targetQq: 456, botQq: 123, connectionEpoch: 8 }),
    verifyFriendship: async (proof) => ({ status: 'friend', sourceProofId: proof.sourceProofId,
      botQq: proof.botQq, targetQq: proof.targetQq, connectionEpoch: proof.connectionEpoch }),
    transport: async () => ({ status: 'ok', retcode: 0, data: { total: 1, msglist: [
      { tid: 'fresh', time: NOW / 1000 - 60, content: 'recent' },
    ] } }),
  });
  const result = await reader.read({});
  assert.equal(result.outcome, 'success');
  assert.deepEqual(result.posts.map((p) => p.id), ['fresh']);
  assert.equal(rowCount(store), before, '★ 普通好友读不产生评论证据（没有可信 event/authorization）');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// LFR-EV-12 — THE EVIDENCE MUST DESCRIBE THE BYTES THAT WERE READ, not the object afterwards
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// The defect this pins (Codex, t52): an earlier revision captured `detail: raw` — a REFERENCE to the
// platform payload — and projected it only at the bottom of `read()`. Between the capture and that
// projection run `finishScope` and the post-lease policy recheck, both HOST callbacks, and a host
// callback can synchronously mutate the very object it was handed. "No `await` in between" does not
// mean "cannot change": a synchronous mutation needs no suspension point.
//
// So this host does exactly that: it keeps the payload by reference and flips the parent comment's
// `uin` inside `finishScope`. What must then be stored is the identity bound at READ time —
// `PARENT_QQ` — not the mutated `PARENT_QQ + 1`. If the row ever shows the mutated value, the chain
// wrote a claim about bytes nobody read.
//
// Both outcomes the card allows are checked for explicitly: the row must EXIST (this implementation
// binds early, so the projection survives) and it must still authorise a reply, which is what makes
// it a usable row rather than an empty collection that merely looks safe.
test('LFR-EV-12 finishScope 同步篡改 raw 的评论 uin ⇒ 存下的证据仍是最初读取的那条', async (t) => {
  const { store } = tempStore(t, 'tamper');
  assert.deepEqual(rows(store), [], '前提：读取之前集合是空的（没有任何 seed）');

  // The payload object the platform "returned". The test keeps it BY REFERENCE, exactly as a host
  // adapter would — that is what makes a synchronous mutation possible at all.
  const payload = detailPage();
  const originalUin = payload.data.comments[0].uin;
  assert.equal(originalUin, PARENT_QQ, '前提：最初读到的是 PARENT_QQ');

  const { reader } = fixture({
    store,
    adapter: () => payload,                        // the SAME object every time, not a clone
    finishScope: () => {
      // ★ THE MUTATION, SYNCHRONOUS, INSIDE A HOST CALLBACK. No await anywhere around it.
      payload.data.comments[0].uin = PARENT_QQ + 1;
      return undefined;
    },
  });

  const result = await readComments(reader);

  // The read itself still succeeds: mutating the payload must not be "detected" as a read failure,
  // because the reader already has its own frozen projection by then.
  assert.equal(result.outcome, 'success', '读取本身必须仍然成功');
  assert.equal(payload.data.comments[0].uin, PARENT_QQ + 1, '前提：篡改确实发生了（否则本用例什么都没测）');

  const stored = rows(store);
  assert.equal(stored.length, 1, '★★ 证据仍必须写出一条（绑定发生在读取处，篡改不影响它）');
  assert.equal(stored[0].commentUin, String(PARENT_QQ),
    '★★★ 存下的 commentUin 必须是最初读取的值，不是 finishScope 篡改后的值');
  assert.notEqual(stored[0].commentUin, String(PARENT_QQ + 1),
    '★★★ 尤其不能是被篡改的那个值');

  // And it is a USABLE row: the reply reservation accepts it. An empty collection would also "not
  // contain the mutated value" while being useless, so this half is what makes the assertion above
  // mean something.
  const { request, intent } = replyCall();
  const reserved = reserveAuditedOfflineInteraction(store, request, intent);
  assert.equal(reserved.allowed, true,
    `★★ 该证据必须仍是可用行（能放行 reply 预留），而不是"安全但无用"的空集: ${JSON.stringify(reserved)}`);
  assert.equal(store.read().ledger.used.comment, 1, '★ 放行时确实花掉一个 comment 配额');
});
