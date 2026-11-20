import test from 'node:test';
import assert from 'node:assert/strict';
import { projectQzoneOnebotMsgDetail } from '../src/core/qzone-onebot-comment-projection-offline.mjs';
import { filterOfflineComments } from '../src/core/qzone-comment-filter-offline.mjs';
import { filterOfflineOwnNewComment } from '../src/core/qzone-own-comment-offline.mjs';

const now = Date.parse('2026-11-08T03:00:00.000Z');
const selfId = '123';
const postId = 'old-post-1';
const postTime = now - 120 * 86400000;

function makeComment(commentId, uin, seconds, content, extra = {}) {
  return { comment_id: commentId, uin, name: `user-${uin}`, time: seconds, content, ...extra };
}

function detailEnvelope() {
  return {
    status: 'ok',
    retcode: 0,
    data: {
      tid: postId,
      content: 'old post body',
      comment_num: 3,
      comments: [
        { ...makeComment('older-1', 456, now / 1000 - 20, 'ordinary comment', { raw: 'raw-comment-secret' }), replies: [] },
        { ...makeComment('new-event-comment', 789, now / 1000 - 10, 'new comment body', { token: 'raw-token-secret' }), replies: [] },
        { ...makeComment('other-1', 999, now / 1000 - 5, 'unrelated body', { cookie: 'raw-cookie-secret' }), replies: [] },
      ],
      rawResponse: 'raw-response-secret',
      authorization: 'raw-authorization-secret',
    },
  };
}

function project() {
  return projectQzoneOnebotMsgDetail(selfId, postId, detailEnvelope(), now);
}

test('ordinary friend comment chain returns safe comments only for the authorized recent post', () => {
  const page = project();
  const target = { author: selfId, id: postId };
  const metadata = { ...target, time: now - 1000 };
  const scope = { author: selfId, friend: true, admin: false, now };

  assert.deepEqual(filterOfflineComments(target, metadata, scope, page), [
    { id: 'older-1', author: '456', time: now - 20000, content: 'ordinary comment' },
    { id: 'new-event-comment', author: '789', time: now - 10000, content: 'new comment body' },
    { id: 'other-1', author: '999', time: now - 5000, content: 'unrelated body' },
  ]);
});

test('ordinary comment chain returns nothing when history range or page target does not match', () => {
  const page = project();
  const target = { author: selfId, id: postId };
  const recentMetadata = { ...target, time: now - 1000 };
  const scope = { author: selfId, friend: true, admin: false, now };

  assert.deepEqual(filterOfflineComments(target, { ...recentMetadata, time: postTime }, scope, page), []);
  assert.deepEqual(filterOfflineComments(target, recentMetadata, { ...scope, author: '456' }, page), []);
  assert.deepEqual(filterOfflineComments({ ...target, id: 'different-post' }, recentMetadata, scope, page), []);
  assert.deepEqual(filterOfflineComments(target, recentMetadata, scope, { ...page, postId: 'different-post' }), []);
});

test('verified new-comment event on an old own post returns exactly the named comment', () => {
  const page = project();
  const event = { isNew: true, selfId, author: selfId, postId, commentId: 'new-event-comment' };
  const target = { author: selfId, postId, commentId: event.commentId };

  assert.deepEqual(filterOfflineOwnNewComment(event, target, page), {
    id: 'new-event-comment', author: '789', time: now - 10000, content: 'new comment body',
  });
});

test('new-comment event does not disclose page comments when event or page target mismatches', () => {
  const page = project();
  const event = { isNew: true, selfId, author: selfId, postId, commentId: 'new-event-comment' };
  const target = { author: selfId, postId, commentId: event.commentId };

  assert.equal(filterOfflineOwnNewComment({ ...event, isNew: false }, target, page), null);
  assert.equal(filterOfflineOwnNewComment(event, { ...target, commentId: 'other-1' }, page), null);
  assert.equal(filterOfflineOwnNewComment(event, target, { ...page, postId: 'different-post' }), null);
});

test('projection failures expose only a generic error and no raw envelope fields', () => {
  const malformed = detailEnvelope();
  malformed.data.comments[0].time = now / 1000 + 60;
  let thrown;
  try {
    projectQzoneOnebotMsgDetail(selfId, postId, malformed, now);
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof TypeError);
  assert.equal(thrown.message, 'invalid qzone OneBot detail response');
  assert.equal(thrown.message.includes('raw-response-secret'), false);
  assert.equal(thrown.message.includes('raw-cookie-secret'), false);
});
