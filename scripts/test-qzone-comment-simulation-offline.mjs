import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { simulateOfflineComments } from '../src/core/qzone-comment-simulation-offline.mjs';

const now = Date.parse('2026-11-07T02:00:00Z');
const target = { author: '123', id: 'post-1' };
const metadata = { ...target, time: now - 1000 };
const scope = { author: '123', friend: true, admin: false, now };
const page = { author: '123', postId: 'post-1', comments: [
  { id: 'c1', author: '456', time: now - 500, content: 'visible', rawResponse: 'SECRET' },
  { id: 'c2', author: '789', time: now - 400, content: 'also visible', credential: 'SECRET' },
] };

async function withStore(t, patch = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-comments-'));
  let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), {
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    reads: 0, writes: 0, tools: { read_comments: true }, readAttempts: {}, readOutcomes: {},
    notices: [], browseDay: '2026-11-07', todayBrowses: 0, lastBrowseAt: null,
    usedOpportunities: {}, activeStart: 420, activeEnd: 1380, audit: [], ...patch,
  });
  return db;
}

const request = (patch = {}) => ({ id: 'r1', now, tool: 'read_comments', source: 'requested',
  target: '123', postId: 'post-1', activeTime: false, ...patch });

test('reads only the authorized post comments and commits intent plus outcome audit', async (t) => {
  const db = await withStore(t);
  let calls = 0;
  const result = await simulateOfflineComments(db, request(), target, metadata, scope, async (selected) => {
    calls++;
    assert.deepEqual(selected, target);
    assert.equal(db.read().audit.some((item) => item.id === 'read_intent_r1'), true);
    return page;
  });
  assert.deepEqual(result, { allowed: true, outcome: 'success', comments: [
    { id: 'c1', author: '456', time: now - 500, content: 'visible' },
    { id: 'c2', author: '789', time: now - 400, content: 'also visible' },
  ] });
  assert.equal(calls, 1);
  assert.equal(db.read().readOutcomes.r1, 'success');
  assert.equal(db.read().audit.find((item) => item.id === 'read:r1').record.result, 'success');
});

test('rejects a non-comment tool or inconsistent post target before reserving', async (t) => {
  const db = await withStore(t);
  let calls = 0;
  const fake = async () => { calls++; return page; };
  const wrongTool = await simulateOfflineComments(db, request({ tool: 'read_posts' }), target, metadata, scope, fake);
  const wrongPost = await simulateOfflineComments(db, request({ id: 'r2', postId: 'other' }), target, metadata, scope, fake);
  const malformedTarget = await simulateOfflineComments(db, request({ id: 'r3', target: 'model-claimed-user' }),
    { ...target, author: 'model-claimed-user' }, { ...metadata, author: 'model-claimed-user' },
    { ...scope, author: 'model-claimed-user' }, fake);
  assert.equal(wrongTool.outcome, 'unknown');
  assert.equal(wrongPost.outcome, 'unknown');
  assert.equal(malformedTarget.outcome, 'unknown');
  assert.deepEqual(db.read().readAttempts, {});
  assert.equal(calls, 0);
});

test('untrusted or unauthorized facts fail closed before reservation and fake dispatch', async (t) => {
  const db = await withStore(t);
  let calls = 0;
  const fake = async () => { calls++; return page; };
  const oldPost = { ...metadata, time: now - 8 * 86400000 };
  const denied = await simulateOfflineComments(db, request(), target, oldPost, scope, fake);
  const modelClaim = await simulateOfflineComments(db, request({ id: 'r2' }), target, metadata,
    { ...scope, admin: true, modelSaysAdmin: true, author: '999' }, fake);
  assert.equal(denied.outcome, 'unknown');
  assert.equal(modelClaim.outcome, 'unknown');
  assert.deepEqual(db.read().readAttempts, {});
  assert.equal(calls, 0);
});

test('a new own-comment event cannot widen access to every comment on an old post', async (t) => {
  const db = await withStore(t);
  let calls = 0;
  const oldPost = { ...metadata, time: now - 8 * 86400000 };
  const eventScope = { ...scope, friend: true, selfId: '123', isNew: true,
    event: { isNew: true, postId: 'post-1', commentId: 'new-comment' } };
  const result = await simulateOfflineComments(db, request(), target, oldPost, eventScope, async () => {
    calls++; return page;
  });
  assert.equal(result.outcome, 'unknown');
  assert.deepEqual(db.read().readAttempts, {});
  assert.equal(calls, 0);
});

test('new own-comment events return only the exact comment despite admin or per-post share scope', async (t) => {
  const db = await withStore(t);
  const oldPost = { ...metadata, time: now - 8 * 86400000 };
  const event = { isNew: true, selfId: '123', author: '123', postId: 'post-1', commentId: 'c1' };
  const eventPage = { ...page, comments: [
    { id: 'c1', author: '456', time: now - 500, content: 'event comment', hidden: 'no' },
    { id: 'c2', author: '789', time: now - 400, content: 'unrelated old comment' },
  ] };
  let calls = 0;
  const fake = async (selected) => {
    calls++;
    assert.deepEqual(selected, { ...target, commentId: 'c1' });
    return eventPage;
  };
  const admin = await simulateOfflineComments(db, request({ commentId: 'c1' }), target, oldPost,
    { ...scope, selfId: '123', event, admin: true }, fake);
  const shared = await simulateOfflineComments(db, request({ id: 'r2', commentId: 'c1' }), target, oldPost,
    { ...scope, selfId: '123', event, sharedPostId: 'post-1' }, fake);
  assert.deepEqual(admin.comments, [{ id: 'c1', author: '456', time: now - 500, content: 'event comment' }]);
  assert.deepEqual(shared.comments, admin.comments);
  assert.equal(db.read().audit.find((item) => item.id === 'read:r1').record.commentId, 'c1');
  assert.equal(db.read().audit.find((item) => item.id === 'read:r2').record.commentId, 'c1');
  assert.equal(calls, 2);
});

test('own-comment event and request comment IDs must match exactly before dispatch', async (t) => {
  const db = await withStore(t);
  const event = { isNew: true, selfId: '123', author: '123', postId: 'post-1', commentId: 'c1' };
  let calls = 0;
  const mismatches = [
    [request({ commentId: 'c2' }), { ...scope, selfId: '123', event, admin: true }],
    [request({ id: 'r2', postId: 'other', commentId: 'c1' }), { ...scope, selfId: '123', event, admin: true }],
    [request({ id: 'r3', commentId: 'c1' }), { ...scope, selfId: '123', event: { ...event, author: '999' }, admin: true }],
    [request({ id: 'r4', commentId: 'c1' }), { ...scope, selfId: '123', event: { ...event, selfId: '999' }, admin: true }],
    [request({ id: 'r5', commentId: 'c1' }), { ...scope, selfId: '123', event: { ...event, postId: 'other' }, admin: true }],
    [request({ id: 'r6', commentId: 'c1' }), { ...scope, selfId: '123', event: { ...event, isNew: false }, admin: true }],
  ];
  for (const [req, eventScope] of mismatches) {
    const result = await simulateOfflineComments(db, req, target, metadata, eventScope, async () => {
      calls++; return page;
    });
    assert.equal(result.outcome, 'unknown');
    assert.deepEqual(result.comments, []);
  }
  assert.equal(calls, 0);
  assert.deepEqual(db.read().readAttempts, {});
});

test('own-comment event rejects duplicate matching comments and page identity mismatch', async (t) => {
  const db = await withStore(t);
  const event = { isNew: true, selfId: '123', author: '123', postId: 'post-1', commentId: 'c1' };
  const eventScope = { ...scope, selfId: '123', event, admin: true };
  const matching = page.comments[0];
  const duplicate = await simulateOfflineComments(db, request({ commentId: 'c1' }), target, metadata, eventScope,
    async () => ({ ...page, comments: [matching, { ...matching }] }));
  const wrongPage = await simulateOfflineComments(db, request({ id: 'r2', commentId: 'c1' }), target, metadata, eventScope,
    async () => ({ ...page, postId: 'other' }));
  assert.equal(duplicate.outcome, 'unknown');
  assert.deepEqual(duplicate.comments, []);
  assert.equal(wrongPage.outcome, 'unknown');
  assert.deepEqual(wrongPage.comments, []);
});

test('a commentId audit on a non-event full-page request is conservatively rejected', async (t) => {
  const db = await withStore(t);
  let calls = 0;
  const result = await simulateOfflineComments(db, request({ commentId: 'c1' }), target, metadata, scope, async () => {
    calls++; return page;
  });
  assert.equal(result.outcome, 'unknown');
  assert.equal(calls, 0);
  assert.deepEqual(db.read().readAttempts, {});
});

test('caller mutation during fake await cannot change the snapshotted event comment ID', async (t) => {
  const db = await withStore(t);
  const req = request({ commentId: 'c1' });
  const selectedTarget = { ...target };
  const selectedMetadata = { ...metadata, time: now - 8 * 86400000 };
  const event = { isNew: true, selfId: '123', author: '123', postId: 'post-1', commentId: 'c1' };
  const selectedScope = { ...scope, selfId: '123', event, admin: true };
  const twoComments = { author: '123', postId: 'post-1', comments: [
    { id: 'c1', author: '456', time: now - 500, content: 'authorized c1' },
    { id: 'c2', author: '789', time: now - 400, content: 'must not leak c2' },
  ] };
  const result = await simulateOfflineComments(db, req, selectedTarget, selectedMetadata, selectedScope, async (selected) => {
    assert.equal(selected.commentId, 'c1');
    req.commentId = 'c2';
    selectedScope.event.commentId = 'c2';
    await Promise.resolve();
    return twoComments;
  });
  assert.deepEqual(result, { allowed: true, outcome: 'success', comments: [
    { id: 'c1', author: '456', time: now - 500, content: 'authorized c1' },
  ] });
  assert.equal(db.read().audit.find((item) => item.id === 'read:r1').record.commentId, 'c1');
});

test('caller mutation of target, metadata and scope during fake await cannot authorize another post', async (t) => {
  const db = await withStore(t);
  const selectedTarget = { ...target };
  const selectedMetadata = { ...metadata };
  const selectedScope = { ...scope };
  const result = await simulateOfflineComments(db, request(), selectedTarget, selectedMetadata, selectedScope, async () => {
    selectedTarget.id = 'post-2';
    selectedMetadata.id = 'post-2';
    selectedScope.admin = true;
    selectedScope.sharedPostId = 'post-2';
    await Promise.resolve();
    return { author: '123', postId: 'post-2', comments: [
      { id: 'c2', author: '789', time: now, content: 'unauthorized post' },
    ] };
  });
  assert.deepEqual(result, { allowed: true, outcome: 'unknown', comments: [] });
  assert.equal(db.read().audit.find((item) => item.id === 'read:r1').record.postId, 'post-1');
});

test('accessor-backed event authorization fields are rejected without invoking getters', async (t) => {
  const db = await withStore(t);
  let getterReads = 0;
  let calls = 0;
  const event = { isNew: true, selfId: '123', author: '123', postId: 'post-1' };
  Object.defineProperty(event, 'commentId', { enumerable: true, get() { getterReads++; return 'c1'; } });
  const result = await simulateOfflineComments(db, request({ commentId: 'c1' }), target, metadata,
    { ...scope, selfId: '123', event, admin: true }, async () => { calls++; return page; });
  assert.equal(result.outcome, 'unknown');
  assert.equal(getterReads, 0);
  assert.equal(calls, 0);
  assert.deepEqual(db.read().readAttempts, {});
});

test('t47：只有「精确分享这一条」能读历史帖评论 —— admin 不再放行', async (t) => {
  const db = await withStore(t);
  const oldPost = { ...metadata, time: now - 8 * 86400000 };
  // 用户裁决取消「管理员看全部」：这条旧正控现在必须被拒（outcome unknown = 没有放行）。
  const admin = await simulateOfflineComments(db, request(), target, oldPost,
    { ...scope, admin: true, friend: false }, async () => page);
  const shared = await simulateOfflineComments(db, request({ id: 'r2' }), target, oldPost,
    { ...scope, friend: false, sharedPostId: 'post-1' }, async () => page);
  const otherShare = await simulateOfflineComments(db, request({ id: 'r3' }), target, oldPost,
    { ...scope, friend: false, sharedPostId: 'another-post' }, async () => page);
  assert.equal(admin.outcome, 'unknown', '★ admin 不得再读 8 天前的帖子评论');
  assert.deepEqual(admin.comments ?? [], [], '★ 拒绝时不得带出任何评论');
  assert.equal(shared.comments.length, 2, '精确分享仍然放行（这才是用户要保留的那条路）');
  assert.equal(otherShare.outcome, 'unknown', '分享的是别的帖子 ⇒ 不放行');
});

test('rechecks the read permission immediately before dispatch', async (t) => {
  const db = await withStore(t);
  let calls = 0;
  let flipped = false;
  const proxy = { read: () => db.read(), update(fn) {
    const result = db.update(fn);
    if (!flipped) { flipped = true; db.update((state) => ({ ...state, readAllowed: false })); }
    return result;
  } };
  const result = await simulateOfflineComments(proxy, request(), target, metadata, scope, async () => {
    calls++; return page;
  });
  assert.deepEqual(result, { allowed: false, reason: 'permission', outcome: 'unknown', reserved: true });
  assert.equal(calls, 0);
  assert.equal(db.read().audit.some((item) => item.id === 'read_intent_r1'), true);
  assert.equal(db.read().readOutcomes.r1, 'unknown');
  assert.equal(db.read().audit.some((item) => item.id === 'read:r1' && item.record.result === 'unknown'), true);
});

test('fake transport failure settles as unknown without exposing thrown text', async (t) => {
  const db = await withStore(t);
  const result = await simulateOfflineComments(db, request(), target, metadata, scope, async () => {
    throw new Error('SECRET transport detail');
  });
  assert.deepEqual(result, { allowed: true, outcome: 'unknown', comments: [] });
  assert.equal(db.read().readOutcomes.r1, 'unknown');
  assert.equal(JSON.stringify(db.read()).includes('SECRET transport detail'), false);
});

for (const mode of ['event', 'ordinary']) {
  test(`${mode}: explicit failure takes priority over comments and updates pause audit`, async (t) => {
    const reasons = { failure: 'other', not_accessible: 'not_accessible', login_expired: 'login_expired',
      captcha: 'captcha', network_unavailable: 'network' };
    const event = { isNew: true, selfId: '123', author: '123', postId: 'post-1', commentId: 'c1' };
    for (const [outcome, reason] of Object.entries(reasons)) {
      const db = await withStore(t);
      const req = mode === 'event' ? request({ commentId: 'c1' }) : request();
      const readScope = mode === 'event' ? { ...scope, selfId: '123', event } : scope;
      const result = await simulateOfflineComments(db, req, target, metadata, readScope,
        async () => ({ ...page, outcome }));
      assert.deepEqual(result, { allowed: true, outcome, comments: [] });
      assert.equal(db.read().readOutcomes.r1, outcome);
      assert.equal(db.read().audit.find((item) => item.id === 'read:r1').record.reason, reason);
      assert.equal(db.read().accessPaused, ['login_expired', 'captcha', 'network_unavailable'].includes(outcome));
    }
  });

  test(`${mode}: captcha is classified before inspecting an accessor-backed comments field`, async (t) => {
    const db = await withStore(t);
    let reads = 0;
    const event = { isNew: true, selfId: '123', author: '123', postId: 'post-1', commentId: 'c1' };
    const req = mode === 'event' ? request({ commentId: 'c1' }) : request();
    const readScope = mode === 'event' ? { ...scope, selfId: '123', event } : scope;
    const response = { outcome: 'captcha', get comments() { reads++; throw new Error('SECRET'); } };
    const result = await simulateOfflineComments(db, req, target, metadata, readScope, async () => response);
    assert.deepEqual(result, { allowed: true, outcome: 'captcha', comments: [] });
    assert.equal(reads, 0);
    assert.equal(db.read().accessPaused, true);
    assert.equal(db.read().audit.find((item) => item.id === 'read:r1').record.reason, 'captcha');
  });

  test(`${mode}: unknown or contradictory outcomes do not expose comments`, async (t) => {
    const event = { isNew: true, selfId: '123', author: '123', postId: 'post-1', commentId: 'c1' };
    for (const response of [
      { ...page, outcome: 'unknown' },
      { ...page, outcome: 'invented' },
      { ...page, outcome: 'success', page },
      { outcome: 'success', page: { ...page, outcome: 'captcha' } },
    ]) {
      const db = await withStore(t);
      const req = mode === 'event' ? request({ commentId: 'c1' }) : request();
      const readScope = mode === 'event' ? { ...scope, selfId: '123', event } : scope;
      const result = await simulateOfflineComments(db, req, target, metadata, readScope, async () => response);
      assert.deepEqual(result, { allowed: true, outcome: 'unknown', comments: [] });
      assert.equal(db.read().readOutcomes.r1, 'unknown');
      assert.equal(db.read().audit.find((item) => item.id === 'read:r1').record.result, 'unknown');
    }
  });

  test(`${mode}: pages above 100 are rejected before reading array elements`, async (t) => {
    const event = { isNew: true, selfId: '123', author: '123', postId: 'post-1', commentId: 'c1' };
    for (const length of [101, 1_000_000]) {
      const db = await withStore(t);
      let elementReads = 0;
      const comments = new Proxy(new Array(length), { getOwnPropertyDescriptor(array, key) {
        if (key !== 'length') { elementReads++; throw new Error('unexpected element traversal'); }
        return Reflect.getOwnPropertyDescriptor(array, key);
      } });
      const req = mode === 'event' ? request({ commentId: 'c1' }) : request();
      const readScope = mode === 'event' ? { ...scope, selfId: '123', event } : scope;
      const result = await simulateOfflineComments(db, req, target, metadata, readScope,
        async () => ({ author: '123', postId: 'post-1', comments }));
      assert.deepEqual(result, { allowed: true, outcome: 'unknown', comments: [] });
      assert.equal(elementReads, 0);
      assert.equal(db.read().readOutcomes.r1, 'unknown');
      assert.equal(db.read().audit.find((item) => item.id === 'read:r1').record.result, 'unknown');
    }
  });

  test(`${mode}: a page with exactly 100 comments is permitted`, async (t) => {
    const db = await withStore(t);
    const event = { isNew: true, selfId: '123', author: '123', postId: 'post-1', commentId: 'c1' };
    const comments = Array.from({ length: 100 }, (_, index) => ({
      id: `c${index + 1}`, author: '456', time: now, content: 'visible',
    }));
    const req = mode === 'event' ? request({ commentId: 'c1' }) : request();
    const readScope = mode === 'event' ? { ...scope, selfId: '123', event } : scope;
    const result = await simulateOfflineComments(db, req, target, metadata, readScope,
      async () => ({ author: '123', postId: 'post-1', comments }));
    assert.equal(result.outcome, 'success');
    assert.equal(result.comments.length, mode === 'event' ? 1 : 100);
    const wrapped = await simulateOfflineComments(db, { ...req, id: 'r2' }, target, metadata, readScope,
      async () => ({ outcome: 'success', page: { author: '123', postId: 'post-1', comments } }));
    assert.equal(wrapped.outcome, 'success');
    assert.equal(wrapped.comments.length, mode === 'event' ? 1 : 100);
  });

  test(`${mode}: a changing comments getter cannot prevent unknown settlement`, async (t) => {
    const db = await withStore(t);
    let reads = 0;
    const response = { author: '123', postId: 'post-1', get comments() {
      reads++;
      if (reads > 1) throw new Error('SECRET response getter');
      return page.comments;
    } };
    const event = { isNew: true, selfId: '123', author: '123', postId: 'post-1', commentId: 'c1' };
    const req = mode === 'event' ? request({ commentId: 'c1' }) : request();
    const readScope = mode === 'event' ? { ...scope, selfId: '123', event } : scope;
    const result = await simulateOfflineComments(db, req, target, metadata, readScope, async () => response);
    assert.deepEqual(result, { allowed: true, outcome: 'unknown', comments: [] });
    assert.ok(reads <= 1);
    assert.equal(db.read().readOutcomes.r1, 'unknown');
    assert.equal(db.read().audit.find((item) => item.id === 'read:r1').record.result, 'unknown');
    assert.equal(JSON.stringify({ result, state: db.read() }).includes('SECRET'), false);
  });

  test(`${mode}: an exception while projecting a comment settles as unknown`, async (t) => {
    const db = await withStore(t);
    const comment = { id: 'c1', author: '456', time: now, get content() { throw new Error('SECRET comment getter'); } };
    const event = { isNew: true, selfId: '123', author: '123', postId: 'post-1', commentId: 'c1' };
    const req = mode === 'event' ? request({ commentId: 'c1' }) : request();
    const readScope = mode === 'event' ? { ...scope, selfId: '123', event } : scope;
    const result = await simulateOfflineComments(db, req, target, metadata, readScope,
      async () => ({ author: '123', postId: 'post-1', comments: [comment] }));
    assert.deepEqual(result, { allowed: true, outcome: 'unknown', comments: [] });
    assert.equal(db.read().readOutcomes.r1, 'unknown');
    assert.equal(db.read().audit.find((item) => item.id === 'read:r1').record.result, 'unknown');
    assert.equal(JSON.stringify({ result, state: db.read() }).includes('SECRET'), false);
  });
}

test('trusted failure outcome records failure and pauses reads at the existing threshold', async (t) => {
  const db = await withStore(t, { reads: 2 });
  const result = await simulateOfflineComments(db, request(), target, metadata, scope, async () => ({ outcome: 'failure' }));
  assert.deepEqual(result, { allowed: true, outcome: 'failure', comments: [] });
  assert.equal(db.read().accessPaused, true);
  assert.equal(db.read().readOutcomes.r1, 'failure');
  assert.equal(db.read().audit.find((item) => item.id === 'read:r1').record.reason, 'other');
});
