import test from 'node:test';
import assert from 'node:assert/strict';
import { filterOfflineOwnNewComment } from '../src/core/qzone-own-comment-offline.mjs';

const event = { isNew: true, selfId: '123', author: '123', postId: 'old1', commentId: 'new1' };
const target = { author: '123', postId: 'old1', commentId: 'new1' };
const data = { author: '123', postId: 'old1', comments: [
  { id: 'new1', author: '456', time: 1000, content: 'hi', cookie: 'must-not-leak' },
  { id: 'old2', author: '789', time: 500, content: 'hidden' },
] };

test('可信的新评论事件只返回精确对应的一条评论及白名单字段', () => {
  assert.deepEqual(filterOfflineOwnNewComment(event, target, data),
    { id: 'new1', author: '456', time: 1000, content: 'hi' });
});

test('事件或页面身份不匹配时拒绝，绝不返回同页其他评论', () => {
  assert.equal(filterOfflineOwnNewComment({ ...event, isNew: false }, target, data), null);
  assert.equal(filterOfflineOwnNewComment(event, { ...target, commentId: 'old2' }, data), null);
  assert.equal(filterOfflineOwnNewComment(event, target, { ...data, author: '456' }), null);
  assert.equal(filterOfflineOwnNewComment(event, target, { ...data, postId: 'other' }), null);
  assert.equal(filterOfflineOwnNewComment(event, target, { ...data, comments: [data.comments[1]] }), null);
});

test('同一评论标识重复或评论缺少字段时拒绝歧义数据', () => {
  assert.equal(filterOfflineOwnNewComment(event, target, { ...data, comments: [data.comments[0], data.comments[0]] }), null);
  assert.equal(filterOfflineOwnNewComment(event, target, { ...data, comments: [{ id: 'new1' }] }), null);
});
