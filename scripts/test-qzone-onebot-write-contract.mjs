import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQzoneOnebotWriteRequest } from '../src/core/qzone-onebot-write-contract.mjs';

test('构造 SnowLuma 2.3.4 纯文字说说、点赞与评论参数', () => {
  assert.deepEqual(buildQzoneOnebotWriteRequest('publish', { content: 'hello', ugc_right: 1 }),
    { action: 'send_qzone_msg', params: { content: 'hello', ugc_right: 1 } });
  assert.deepEqual(buildQzoneOnebotWriteRequest('like', { tid: 'post-1', target_uin: '123', abstime: 42 }),
    { action: 'like_qzone', params: { tid: 'post-1', target_uin: 123, abstime: 42 } });
  assert.deepEqual(buildQzoneOnebotWriteRequest('comment', { tid: 'post-1', target_uin: 123, content: 'hello' }),
    { action: 'comment_qzone', params: { tid: 'post-1', target_uin: 123, content: 'hello' } });
});

test('回复要求父评论及作者，支持父评论编号零和楼中楼', () => {
  assert.deepEqual(buildQzoneOnebotWriteRequest('reply', { tid: 'p1', target_uin: 123, content: 'hi', comment_id: '0', comment_uin: 456, reply_uin: 789, reply_name: 'name' }),
    { action: 'comment_qzone', params: { tid: 'p1', target_uin: 123, content: 'hi', comment_id: '0', comment_uin: 456, reply_uin: 789, reply_name: 'name' } });
  assert.throws(() => buildQzoneOnebotWriteRequest('reply', { tid: 'p1', target_uin: 123, content: 'hi', comment_id: '0' }));
  assert.throws(() => buildQzoneOnebotWriteRequest('reply', { tid: 'p1', target_uin: 123, content: 'hi', comment_id: '0', comment_uin: 456, reply_uin: 789 }));
});

test('权限名单必须匹配平台规则，防止意外公开', () => {
  assert.deepEqual(buildQzoneOnebotWriteRequest('publish', { content: 'hi', ugc_right: 16, target_uins: [123, '456'] }).params,
    { content: 'hi', ugc_right: 16, target_uins: [123, 456] });
  for (const input of [{ content: 'hi' }, { content: 'hi', ugc_right: 16 }, { content: 'hi', ugc_right: 2 }, { content: 'hi', ugc_right: 1, target_uins: [123] }]) {
    assert.throws(() => buildQzoneOnebotWriteRequest('publish', input));
  }
});

test('拒绝不明字段、图片路径、不安全身份与访问器，不执行访问器', () => {
  let accessed = false;
  const malicious = { tid: 'p1', target_uin: 123, content: 'hello' };
  Object.defineProperty(malicious, 'images', { enumerable: true, get() { accessed = true; return []; } });
  assert.throws(() => buildQzoneOnebotWriteRequest('comment', malicious));
  assert.equal(accessed, false);
  assert.throws(() => buildQzoneOnebotWriteRequest('like', { tid: 'p1', target_uin: '001' }));
  assert.throws(() => buildQzoneOnebotWriteRequest('like', { tid: 'p1', target_uin: 123, action: 'delete_qzone_msg' }));
  assert.throws(() => buildQzoneOnebotWriteRequest('comment', { tid: 'p1', target_uin: 123, content: '  ' }));
});
