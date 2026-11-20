import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzoneWriteBinding, takeQzoneWriteRequest, consumeQzoneWriteBinding } from '../src/core/qzone-write-binding-offline.mjs';

const audit = (overrides = {}) => ({ time: 1000, source: 'qq', target: '123', result: 'unknown', reason: '', ...overrides });

test('操作 ID 含疑似密钥时不能生成会进入状态和审计的绑定', () => {
  assert.throws(() => createQzoneWriteBinding('sk-abcdefghijklmnop', 'like', { tid: 'p', target_uin: 123 }, audit()));
});

test('创建不可变请求快照和脱敏审计投影', () => {
  const binding = createQzoneWriteBinding('op_1', 'comment',
    { tid: 'post_1', target_uin: 123, content: 'Bearer topsecretvalue' }, audit());
  assert.equal(binding.id, 'op_1');
  assert.equal(binding.audit.action, 'comment');
  assert.equal(binding.audit.postId, 'post_1');
  assert.equal(binding.audit.content, '[REDACTED]');
  assert.equal(JSON.stringify(binding.audit).includes('topsecretvalue'), false);
  assert.ok(Object.isFrozen(binding));
  assert.deepEqual(takeQzoneWriteRequest(binding.id, binding.capability), {
    action: 'comment_qzone', params: { tid: 'post_1', target_uin: 123, content: 'Bearer topsecretvalue' },
  });
});

test('输入后续变化不影响请求快照', () => {
  const input = { tid: 'post_1', target_uin: 123, content: 'original' };
  const binding = createQzoneWriteBinding('op_2', 'comment', input, audit());
  input.content = 'changed';
  assert.equal(binding.audit.content, 'original');
  assert.equal(takeQzoneWriteRequest(binding.id, binding.capability).params.content, 'original');
});

test('单次凭证不能重复提取请求', () => {
  const binding = createQzoneWriteBinding('op_3', 'like', { tid: 'p', target_uin: 123 }, audit());
  takeQzoneWriteRequest(binding.id, binding.capability);
  assert.throws(() => takeQzoneWriteRequest(binding.id, binding.capability));
});

test('可信消费者可用一次性私有 capability 同取冻结请求和对应原始审计输入', () => {
  const binding = createQzoneWriteBinding('op_consume', 'comment',
    { tid: 'post_1', target_uin: 123, content: 'Bearer bound-secret' }, audit());
  const consumed = consumeQzoneWriteBinding(binding.id, binding.capability);
  assert.equal(consumed.request.params.content, 'Bearer bound-secret');
  assert.equal(Object.isFrozen(consumed.request), true);
  assert.equal(Object.isFrozen(consumed.request.params), true);
  assert.equal(consumed.auditInput.content, consumed.request.params.content);
  assert.equal(consumed.audit.content, '[REDACTED]');
  assert.throws(() => consumeQzoneWriteBinding(binding.id, binding.capability));
  assert.throws(() => consumeQzoneWriteBinding(binding.id, Object.freeze(Object.create(null))));
});

test('拒绝替换操作标识和审计字段', () => {
  const binding = createQzoneWriteBinding('op_4', 'comment', { tid: 'p', target_uin: 123, content: 'hello' }, audit());
  assert.throws(() => takeQzoneWriteRequest('other', binding.capability));
  assert.throws(() => createQzoneWriteBinding('op_5', 'comment', { tid: 'p', target_uin: 123, content: 'hello' }, audit({ action: 'reply' })));
  assert.throws(() => createQzoneWriteBinding('op_6', 'comment', { tid: 'p', target_uin: 123, content: 'hello' }, audit({ postId: 'different' })));
});

test('拒绝修改快照和输入访问器', () => {
  const binding = createQzoneWriteBinding('op_7', 'comment', { tid: 'p', target_uin: 123, content: 'hello' }, audit());
  assert.throws(() => { binding.audit.action = 'like'; }, TypeError);
  let invoked = false;
  const hostile = { tid: 'p', target_uin: 123, get content() { invoked = true; return 'hello'; } };
  assert.throws(() => createQzoneWriteBinding('op_8', 'comment', hostile, audit()));
  assert.equal(invoked, false);
});

test('审计目标必须与互动请求中的目标 QQ 一致', () => {
  for (const [kind, input] of [
    ['like', { tid: 'p', target_uin: 123 }],
    ['comment', { tid: 'p', target_uin: 123, content: 'hello' }],
    ['reply', { tid: 'p', target_uin: 123, content: 'hello', comment_id: 'c', comment_uin: 234 }],
  ]) {
    assert.throws(() => createQzoneWriteBinding(`wrong_${kind}`, kind, input, audit({ target: '999' })));
  }
});
