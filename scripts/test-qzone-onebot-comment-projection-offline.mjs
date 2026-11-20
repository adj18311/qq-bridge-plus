import test from 'node:test';
import assert from 'node:assert/strict';
import { projectQzoneOnebotMsgDetail } from '../src/core/qzone-onebot-comment-projection-offline.mjs';

const now = Date.parse('2026-11-08T03:00:00.000Z');
const tid = '1127000000f1536501000000';

function envelope(data) {
  return { status: 'ok', retcode: 0, data };
}

function comment(commentId, uin, time, content, extra = {}) {
  return { comment_id: commentId, uin, name: 'display name', time, content, ...extra };
}

test('projects SnowLuma detail comments and inline replies into the existing filtered-page contract', () => {
  const response = envelope({
    tid,
    content: 'post body',
    comment_num: 2,
    comments: [
      { ...comment('0', 456, now / 1000 - 2, 'first'), replies: [
        { ...comment('r1', 789, now / 1000 - 1, 'reply'), parent_comment_id: '0', parent_comment_uin: 456 },
      ] },
    ],
  });

  assert.deepEqual(projectQzoneOnebotMsgDetail('123', tid, response, now), {
    author: '123',
    postId: tid,
    comments: [
      { id: '0', author: '456', time: now - 2000, content: 'first' },
      { id: 'r1', author: '789', time: now - 1000, content: 'reply' },
    ],
  });
});

test('rejects wrong envelope, detail identity, malformed comment fields, and future times', () => {
  const base = { tid, content: 'post body', comment_num: 1,
    comments: [{ ...comment('c1', 456, now / 1000 - 1, 'hello'), replies: [] }] };
  assert.throws(() => projectQzoneOnebotMsgDetail('123', tid, { ...envelope(base), retcode: 1 }, now));
  assert.throws(() => projectQzoneOnebotMsgDetail('123', tid, envelope({ ...base, tid: 'other' }), now));
  assert.throws(() => projectQzoneOnebotMsgDetail('123', tid, envelope({ ...base,
    comments: [{ ...base.comments[0], uin: 0 }] }), now));
  assert.throws(() => projectQzoneOnebotMsgDetail('123', tid, envelope({ ...base,
    comments: [{ ...base.comments[0], time: now / 1000 + 1 }] }), now));
});

test('does not inspect or retain unknown sensitive fields and rejects accessor-backed fields', () => {
  const row = { ...comment('c1', 456, now / 1000 - 1, 'hello', { token: 'must-not-leak' }), replies: [] };
  const response = envelope({ tid, content: 'post body', comment_num: 1, comments: [row], cookie: 'secret' });
  assert.deepEqual(projectQzoneOnebotMsgDetail('123', tid, response, now).comments, [
    { id: 'c1', author: '456', time: now - 1000, content: 'hello' },
  ]);

  const accessorRow = { ...comment('c1', 456, now / 1000 - 1, 'hello'), replies: [] };
  Object.defineProperty(accessorRow, 'content', { enumerable: true, get() { throw new Error('must not run'); } });
  assert.throws(() => projectQzoneOnebotMsgDetail('123', tid, envelope({
    tid, content: 'post body', comment_num: 1, comments: [accessorRow],
  }), now));
});

test('rejects oversized inline reply collections rather than projecting unbounded data', () => {
  const reply = { ...comment('r1', 789, now / 1000 - 1, 'reply'), parent_comment_id: 'c1', parent_comment_uin: 456 };
  const row = { ...comment('c1', 456, now / 1000 - 1, 'parent'), replies: Array(1001).fill(reply) };
  assert.throws(() => projectQzoneOnebotMsgDetail('123', tid, envelope({ tid, content: '', comment_num: 1002, comments: [row] }), now));
});

test('page output fits the downstream 100-comment boundary without silently truncating', () => {
  const reply = { ...comment('r1', 789, now / 1000 - 1, 'reply'), parent_comment_id: 'c1', parent_comment_uin: 456 };
  const row = { ...comment('c1', 456, now / 1000 - 1, 'parent'), replies: Array(99).fill(reply) };
  assert.equal(projectQzoneOnebotMsgDetail('123', tid, envelope({ tid, content: '', comment_num: 100, comments: [row] }), now).comments.length, 100);
  assert.throws(() => projectQzoneOnebotMsgDetail('123', tid, envelope({ tid, content: '', comment_num: 101, comments: [{ ...row, replies: Array(100).fill(reply) }] }), now));
});

test('rejects comment text above the transport envelope budget', () => {
  const row = { ...comment('c1', 456, now / 1000 - 1, 'a'.repeat(1024 * 1024 + 1)), replies: [] };
  assert.throws(() => projectQzoneOnebotMsgDetail('123', tid, envelope({ tid, content: '', comment_num: 1, comments: [row] }), now));
});
