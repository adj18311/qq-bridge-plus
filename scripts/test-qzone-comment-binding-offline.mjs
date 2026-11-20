import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindAuthorizedQzoneReply,
  bindAuthorizedOwnNewQzoneComment,
  bindAuthorizedOwnNewQzoneReply,
} from '../src/core/qzone-comment-binding-offline.mjs';

const now = Date.parse('2026-11-08T03:00:00.000Z');
const target = { author: '123', id: 'post_1' };
const metadata = { ...target, time: now - 1000 };
const scope = { author: '123', friend: true, admin: false, now };

function comment(commentId, uin, name, content, extra = {}) {
  return { comment_id: commentId, uin, name, time: now / 1000 - 1, content, ...extra };
}

function detail(overrides = {}) {
  return {
    status: 'ok', retcode: 0,
    data: {
      tid: 'post_1', content: 'post body', comment_num: 3,
      comments: [
        { ...comment('parent_1', 456, 'parent name', 'parent text'), replies: [
          { ...comment('reply_1', 789, 'reply nick', 'reply text'),
            parent_comment_id: 'parent_1', parent_comment_uin: 456 },
          { ...comment('reply_2', 987, 'other nick', 'other text'),
            parent_comment_id: 'parent_1', parent_comment_uin: 456 },
        ] },
        { ...comment('parent_2', 654, 'another parent', 'other parent text'), replies: [] },
      ],
      ...overrides,
    },
  };
}

const bind = (response = detail(), t = target, m = metadata, s = scope, parent = 'parent_1', reply = 'reply_1') =>
  bindAuthorizedQzoneReply(t, m, s, response, parent, reply);

const oldTarget = { author: '123', id: 'old_post_1' };
function oldDetail() {
  const response = detail();
  response.data.tid = 'old_post_1';
  return response;
}
const ownEvent = (patch = {}) => ({ isNew: true, selfId: '123', author: '123',
  postId: 'old_post_1', commentId: 'reply_1', ...patch });

test('binds exactly the authorized reply and returns only target, post, parent and reply identity', () => {
  const result = bind();
  assert.deepEqual(result, {
    targetQq: '123', postId: 'post_1',
    parentCommentId: 'parent_1', parentQq: '456',
    replyCommentId: 'reply_1', replyQq: '789', replyName: 'reply nick',
  });
  assert.equal(JSON.stringify(result).includes('reply text'), false);
  assert.equal(JSON.stringify(result).includes('other text'), false);
  assert.ok(Object.isFrozen(result));
});

test('fails closed when the existing offline read authorization is absent or mismatched', () => {
  assert.throws(() => bind(detail(), target, metadata, { ...scope, friend: false }));
  assert.throws(() => bind(detail(), target, { ...metadata, id: 'other' }, scope));
  assert.throws(() => bind(detail(), { ...target, author: '999' }, metadata, scope));
  assert.throws(() => bind(detail(), { ...target, author: 'not-a-qq' }, metadata, scope));
});

test('rejects detail post mismatch and does not bind a reply from another parent', () => {
  assert.throws(() => bind(detail({ tid: 'other' })));
  const wrongParent = detail();
  wrongParent.data.comments[0].replies[0].parent_comment_id = 'parent_2';
  assert.throws(() => bind(wrongParent));
});

test('requires exact unique parent and reply IDs', () => {
  assert.throws(() => bind(detail(), target, metadata, scope, 'missing', 'reply_1'));
  assert.throws(() => bind(detail(), target, metadata, scope, 'parent_1', 'missing'));
  const duplicateParent = detail();
  duplicateParent.data.comments.push({ ...duplicateParent.data.comments[0] });
  assert.throws(() => bind(duplicateParent));
  const duplicateReply = detail();
  duplicateReply.data.comments[0].replies.push({ ...duplicateReply.data.comments[0].replies[0] });
  assert.throws(() => bind(duplicateReply));
});

test('rejects malformed selected identities, nickname and parent QQ evidence', () => {
  for (const update of [
    (parent, reply) => { parent.uin = 0; },
    (parent, reply) => { reply.uin = Number.MAX_SAFE_INTEGER + 1; },
    (parent, reply) => { reply.name = '  '; },
    (parent, reply) => { reply.parent_comment_uin = 654; },
    (parent, reply) => { reply.comment_id = ''; },
  ]) {
    const response = detail();
    update(response.data.comments[0], response.data.comments[0].replies[0]);
    assert.throws(() => bind(response));
  }
});

test('does not invoke accessors or reveal exception details from hostile response fields', () => {
  const response = detail();
  let reads = 0;
  Object.defineProperty(response.data.comments[0].replies[0], 'name', {
    enumerable: true, get() { reads += 1; throw new Error('private comment data'); },
  });
  let thrown;
  try { bind(response); } catch (error) { thrown = error; }
  assert.ok(thrown instanceof TypeError);
  assert.equal(thrown.message, 'invalid authorized qzone reply binding');
  assert.equal(reads, 0);
});

test('rejects oversized reply identity rather than propagating unbounded text', () => {
  const response = detail();
  response.data.comments[0].replies[0].name = 'x'.repeat(1024 * 1024 + 1);
  assert.throws(() => bind(response));
});

test('accepts SnowLuma comment ID zero without treating it as missing', () => {
  const response = detail();
  response.data.comments[0].comment_id = '0';
  response.data.comments[0].replies[0].parent_comment_id = '0';
  response.data.comments[0].replies[0].comment_id = '0';
  assert.deepEqual(bind(response, target, metadata, scope, '0', '0'), {
    targetQq: '123', postId: 'post_1', parentCommentId: '0', parentQq: '456',
    replyCommentId: '0', replyQq: '789', replyName: 'reply nick',
  });
});

test('binds only the exact new second-level reply on the bot own old post', () => {
  const result = bindAuthorizedOwnNewQzoneReply(oldTarget, ownEvent(), oldDetail(), 'parent_1', 'reply_1');
  assert.deepEqual(result, {
    targetQq: '123', postId: 'old_post_1', parentCommentId: 'parent_1', parentQq: '456',
    replyCommentId: 'reply_1', replyQq: '789', replyName: 'reply nick',
  });
  assert.equal(JSON.stringify(result).includes('other text'), false);
  assert.equal(Object.hasOwn(result, 'comments'), false);
});

test('the own-old-post second-level exception rejects wrong event bot, author, post, or reply ID', () => {
  for (const event of [
    ownEvent({ selfId: '999' }), ownEvent({ author: '999' }),
    ownEvent({ postId: 'another_post' }), ownEvent({ commentId: 'reply_2' }),
  ]) assert.throws(() => bindAuthorizedOwnNewQzoneReply(oldTarget, event, oldDetail(), 'parent_1', 'reply_1'));
  assert.throws(() => bindAuthorizedOwnNewQzoneReply({ ...oldTarget, author: '999' }, ownEvent(), oldDetail(), 'parent_1', 'reply_1'));
  assert.throws(() => bindAuthorizedOwnNewQzoneReply(oldTarget, ownEvent(), oldDetail(), 'parent_2', 'reply_1'));
  assert.throws(() => bindAuthorizedOwnNewQzoneReply(oldTarget, ownEvent(), oldDetail(), 'parent_1', 'reply_2'));
});

test('binds an exact new first-level comment on the bot own old post without widening the page', () => {
  const event = ownEvent({ commentId: 'parent_1' });
  const result = bindAuthorizedOwnNewQzoneComment(oldTarget, event, oldDetail(), 'parent_1');
  assert.deepEqual(result, {
    targetQq: '123', postId: 'old_post_1', commentId: 'parent_1', commentQq: '456', commentName: 'parent name',
  });
  assert.equal(JSON.stringify(result).includes('parent text'), false);
  assert.equal(JSON.stringify(result).includes('reply nick'), false);
  assert.throws(() => bindAuthorizedOwnNewQzoneComment(oldTarget, event, oldDetail(), 'parent_2'));
});

test('the own-old-post first-level exception rejects cross-bot, cross-post, and cross-comment events', () => {
  for (const event of [
    ownEvent({ selfId: '999', commentId: 'parent_1' }),
    ownEvent({ author: '999', commentId: 'parent_1' }),
    ownEvent({ postId: 'another_post', commentId: 'parent_1' }),
    ownEvent({ commentId: 'parent_2' }),
  ]) assert.throws(() => bindAuthorizedOwnNewQzoneComment(oldTarget, event, oldDetail(), 'parent_1'));
  assert.throws(() => bindAuthorizedOwnNewQzoneComment(oldTarget, ownEvent({ commentId: 'parent_1' }),
    detail(), 'parent_1'));
});

test('the new-comment event exception does not widen the ordinary old-post read boundary', () => {
  const oldMetadata = { ...metadata, author: '123', id: 'old_post_1', time: now - 8 * 86400000 };
  const event = ownEvent({ commentId: 'parent_1' });
  assert.equal(bindAuthorizedOwnNewQzoneComment(oldTarget, event, oldDetail(), 'parent_1').commentId, 'parent_1');
  assert.throws(() => bind(oldDetail(), oldTarget, oldMetadata, scope, 'parent_1', 'reply_1'));
});

test('own-old-post event binding rejects a comment ID duplicated anywhere across first- and second-level rows', () => {
  const duplicateAsReply = oldDetail();
  duplicateAsReply.data.comments.push({
    comment_id: 'parent_3', uin: 333, name: 'Third parent', time: now / 1000 - 2,
    content: 'third parent text', replies: [{
      comment_id: 'reply_1', uin: 222, name: 'duplicate reply', time: now / 1000 - 1,
      content: 'duplicate text', parent_comment_id: 'parent_3', parent_comment_uin: 333,
    }],
  });
  assert.throws(() => bindAuthorizedOwnNewQzoneReply(oldTarget, ownEvent(), duplicateAsReply, 'parent_1', 'reply_1'));

  const duplicateAsParent = oldDetail();
  duplicateAsParent.data.comments.push({
    comment_id: 'reply_1', uin: 222, name: 'duplicate parent', time: now / 1000 - 1,
    content: 'duplicate text', replies: [],
  });
  assert.throws(() => bindAuthorizedOwnNewQzoneReply(oldTarget, ownEvent(), duplicateAsParent, 'parent_1', 'reply_1'));

  const duplicateFirstLevel = oldDetail();
  duplicateFirstLevel.data.comments.push({
    comment_id: 'parent_1', uin: 222, name: 'duplicate parent', time: now / 1000 - 1,
    content: 'duplicate text', replies: [],
  });
  assert.throws(() => bindAuthorizedOwnNewQzoneComment(oldTarget,
    ownEvent({ commentId: 'parent_1' }), duplicateFirstLevel, 'parent_1'));
});

test('own-old-post event binding rejects malformed unrelated rows and non-string IDs', () => {
  const malformedParent = oldDetail();
  malformedParent.data.comments.push({ uin: 222, name: 'missing ID', time: now / 1000 - 1,
    content: 'malformed', replies: [] });
  assert.throws(() => bindAuthorizedOwnNewQzoneComment(oldTarget,
    ownEvent({ commentId: 'parent_1' }), malformedParent, 'parent_1'));

  const numericReplyId = oldDetail();
  numericReplyId.data.comments[0].replies[0].comment_id = 777;
  assert.throws(() => bindAuthorizedOwnNewQzoneReply(oldTarget, ownEvent(), numericReplyId, 'parent_1', 'reply_1'));

  const malformedReplyParent = oldDetail();
  malformedReplyParent.data.comments[0].replies[0].parent_comment_uin = 999;
  assert.throws(() => bindAuthorizedOwnNewQzoneComment(oldTarget,
    ownEvent({ commentId: 'parent_1' }), malformedReplyParent, 'parent_1'));

  const missingReplies = oldDetail();
  delete missingReplies.data.comments[1].replies;
  assert.throws(() => bindAuthorizedOwnNewQzoneReply(oldTarget, ownEvent(), missingReplies, 'parent_1', 'reply_1'));
});

test('own-old-post event binding enforces a total page limit of 100 comments including replies', () => {
  const makeParent = (index) => ({ comment_id: `parent_${index}`, uin: 1000 + index,
    name: `Parent ${index}`, time: now / 1000 - 1, content: 'text', replies: [] });
  const withinLimit = oldDetail();
  withinLimit.data.comments = Array.from({ length: 100 }, (_, index) => makeParent(index));
  const selectedParentId = 'parent_0';
  assert.equal(bindAuthorizedOwnNewQzoneComment(oldTarget,
    ownEvent({ commentId: selectedParentId }), withinLimit, selectedParentId).commentId, selectedParentId);

  const aboveLimit = oldDetail();
  aboveLimit.data.comments = Array.from({ length: 100 }, (_, index) => makeParent(index));
  aboveLimit.data.comments[0] = { ...aboveLimit.data.comments[0], comment_id: 'parent_1', replies: [
    { comment_id: 'reply_1', uin: 789, name: 'Reply', time: now / 1000 - 1,
      content: 'text', parent_comment_id: 'parent_1', parent_comment_uin: 1000 },
  ] };
  assert.throws(() => bindAuthorizedOwnNewQzoneReply(oldTarget, ownEvent(), aboveLimit, 'parent_1', 'reply_1'));
});
