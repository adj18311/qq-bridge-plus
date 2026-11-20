import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyQzoneOutcome, QZONE_OUTCOMES } from '../src/core/qzone-outcome-offline.mjs';

test('只将规范化的终态值映射为内部结果', () => {
  const cases = [
    [{ status: 'success' }, 'success'],
    [{ status: 'not_accessible' }, 'not_accessible'],
    [{ status: 'login_expired' }, 'login_expired'],
    [{ status: 'captcha' }, 'captcha'],
    [{ status: 'network_unavailable' }, 'network_unavailable'],
    [{ status: 'failure' }, 'failure'],
  ];

  for (const [input, outcome] of cases) {
    assert.deepEqual(classifyQzoneOutcome(input), { outcome });
  }
});

test('超时、异常及未识别的状态一律保持 unknown', () => {
  for (const input of [
    { status: 'timeout' },
    { status: 'exception' },
    { status: 'pending' },
    { status: 'failed' },
    { status: '验证码' },
    { status: 'success', error: new Error('secret token') },
    { status: 'failure', message: '验证码' },
    { status: 'unknown', message: '登录已失效' },
    null,
    [],
    Object.defineProperty({}, 'status', { enumerable: true, get() { throw new Error('secret token'); } }),
  ]) {
    assert.deepEqual(classifyQzoneOutcome(input), { outcome: 'unknown' });
  }
});

test('不从任意文案或未授权字段推断分类', () => {
  assert.deepEqual(classifyQzoneOutcome({ outcome: 'captcha' }), { outcome: 'unknown' });
});

test('输出仅含内部 outcome，且允许值表不可变', () => {
  const result = classifyQzoneOutcome({ status: 'network_unavailable', message: 'secret' });
  assert.deepEqual(Object.keys(result), ['outcome']);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(QZONE_OUTCOMES, [
    'success', 'not_accessible', 'login_expired', 'captcha',
    'network_unavailable', 'failure', 'unknown',
  ]);
  assert.equal(Object.isFrozen(QZONE_OUTCOMES), true);
});
