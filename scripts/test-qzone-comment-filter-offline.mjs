import test from 'node:test';
import assert from 'node:assert/strict';
import { filterOfflineComments } from '../src/core/qzone-comment-filter-offline.mjs';

const now = Date.parse('2026-11-07T00:00:00Z');
const target = { author: '123', id: 'post-1' };
const metadata = { ...target, time: now - 1000 };
const scope = { author: '123', friend: true, admin: false, now };
const page = {
  author: '123', postId: 'post-1',
  comments: [
    { id: 'c1', author: '456', time: now - 500, content: 'hello', rawResponse: 'SECRET', credential: 'SECRET' },
    { id: 'c2', author: '789', time: now - 400, content: 'second', extra: 'SECRET' },
  ],
};

test('returns only safe whitelist fields for comments bound to the authorized post', () => {
  assert.deepEqual(filterOfflineComments(target, metadata, scope, page), [
    { id: 'c1', author: '456', time: now - 500, content: 'hello' },
    { id: 'c2', author: '789', time: now - 400, content: 'second' },
  ]);
});

test('fails closed when target, trusted metadata, or comment page identity is missing or mismatched', () => {
  assert.deepEqual(filterOfflineComments(null, metadata, scope, page), []);
  assert.deepEqual(filterOfflineComments(target, null, scope, page), []);
  assert.deepEqual(filterOfflineComments(target, { ...metadata, id: 'other' }, scope, page), []);
  assert.deepEqual(filterOfflineComments(target, { ...metadata, author: '456' }, scope, page), []);
  assert.deepEqual(filterOfflineComments(target, metadata, scope, { ...page, postId: 'other' }), []);
  assert.deepEqual(filterOfflineComments(target, metadata, scope, { ...page, author: '456' }), []);
});

test('applies existing friend, admin, and exact shared-post scope rules', () => {
  const oldMeta = { ...metadata, time: now - 8 * 86400000 };
  assert.deepEqual(filterOfflineComments(target, oldMeta, scope, page), []);
  // t47：admin 特权已取消，这条旧正控现在必须是 0。
  assert.equal(filterOfflineComments(target, oldMeta, { ...scope, admin: true }, page).length, 0,
    '★ admin 不得再把 8 天前的评论放进来：特权已取消');
  assert.equal(filterOfflineComments(target, oldMeta, { ...scope, friend: false, sharedPostId: 'post-1' }, page).length, 2);
  assert.deepEqual(filterOfflineComments(target, oldMeta, { ...scope, sharedPostId: 'other' }, page), []);
});

test('rejects malformed comments individually and never treats model assertions as authorization', () => {
  const mixed = { ...page, comments: [
    ...page.comments,
    null,
    { id: 'missing-author', time: now, content: 'no author' },
    { id: 'model', author: '123', time: now, content: 'claim', modelSaysTrusted: true },
  ] };
  assert.deepEqual(filterOfflineComments(target, metadata, scope, mixed), [
    { id: 'c1', author: '456', time: now - 500, content: 'hello' },
    { id: 'c2', author: '789', time: now - 400, content: 'second' },
    { id: 'model', author: '123', time: now, content: 'claim' },
  ]);
  assert.deepEqual(filterOfflineComments(target, metadata, { ...scope, author: '456', modelSaysAdmin: true }, page), []);
});

test('handles malformed containers conservatively and does not mutate inputs', () => {
  const before = structuredClone(page);
  assert.deepEqual(filterOfflineComments(target, metadata, scope, { ...page, comments: 'not-an-array' }), []);
  assert.deepEqual(filterOfflineComments(target, metadata, scope, { ...page, rawResponse: 'SECRET' }).map((x) => x.id), ['c1', 'c2']);
  assert.deepEqual(page, before);
});

test('comment fields are captured once before validation and projection', () => {
  let reads = 0;
  const item = { id: 'c3', author: '456', time: now, get content() {
    reads++; return reads === 1 ? 'safe text' : { credential: 'secret' };
  } };
  const result = filterOfflineComments(target, metadata, scope, { ...page, comments: [item] });
  assert.equal(reads, 1);
  assert.deepEqual(result, [{ id: 'c3', author: '456', time: now, content: 'safe text' }]);
});
