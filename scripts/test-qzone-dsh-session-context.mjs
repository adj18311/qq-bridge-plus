import test from 'node:test';
import assert from 'node:assert/strict';
import { getQzoneDshSessionContext } from '../plugins/qzone-safe/session-context.mjs';

test('会话身份只来自 DSH 原生执行上下文，不接受模型参数覆盖', () => {
  const exec = { agent: { id: 'agent-1', session: { id: 'session-abc' } }, callId: 'call-1' };
  assert.deepEqual(getQzoneDshSessionContext(exec, { sessionId: 'session-forged' }),
    { sessionId: 'session-abc', callId: 'call-1' });
});

test('没有会话身份不能回退到 agent ID 或模型参数', () => {
  assert.equal(getQzoneDshSessionContext({ agent: { id: 'session-abc' }, callId: 'call-1' },
    { sessionId: 'session-abc' }), null);
});

test('空、非法或过长的会话标识和调用标识失败关闭', () => {
  for (const id of ['', '../secret', 'x'.repeat(129)]) {
    assert.equal(getQzoneDshSessionContext({ agent: { session: { id } }, callId: 'call-1' }), null);
    assert.equal(getQzoneDshSessionContext({ agent: { session: { id: 'session-abc' } }, callId: id }), null);
  }
});

test('异常上下文失败关闭，不泄漏异常内容', () => {
  const exec = { get agent() { throw new Error('secret'); } };
  assert.equal(getQzoneDshSessionContext(exec), null);
});
