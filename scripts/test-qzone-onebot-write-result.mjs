import test from 'node:test';
import assert from 'node:assert/strict';
import { projectQzoneWriteResult } from '../src/core/qzone-onebot-write-result.mjs';

test('只对明确成功且符合动作结构的响应返回白名单结果', () => {
  assert.deepEqual(projectQzoneWriteResult('publish', { status: 'ok', retcode: 0, data: { tid: 'p1', time: 123, token: 'secret' } }),
    { outcome: 'success', postId: 'p1' });
  assert.deepEqual(projectQzoneWriteResult('like', { status: 'ok', retcode: 0, data: null }), { outcome: 'success' });
  assert.deepEqual(projectQzoneWriteResult('comment', { status: 'ok', retcode: 0, data: { comment_id: '' } }), { outcome: 'success' });
  assert.deepEqual(projectQzoneWriteResult('reply', { status: 'ok', retcode: 0, data: { comment_id: '0' } }), { outcome: 'success', commentId: '0' });
});

test('失败、格式异常或不可信返回一律未知，不回显原始错误或凭据', () => {
  for (const value of [null, { status: 'failed', retcode: 1, wording: 'secret' },
    { status: 'ok', retcode: 0, data: {} }, { status: 'ok', retcode: '0', data: { tid: 'p1', time: 1 } }]) {
    const result = projectQzoneWriteResult('publish', value);
    assert.deepEqual(result, { outcome: 'unknown' });
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
  assert.deepEqual(projectQzoneWriteResult('delete', { status: 'ok', retcode: 0, data: null }), { outcome: 'unknown' });
});

test('恶意访问器不得执行', () => {
  let called = false;
  const response = { retcode: 0, data: null };
  Object.defineProperty(response, 'status', { get() { called = true; return 'ok'; }, enumerable: true });
  assert.deepEqual(projectQzoneWriteResult('like', response), { outcome: 'unknown' });
  assert.equal(called, false);
});
