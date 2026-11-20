import assert from 'node:assert/strict';
import test from 'node:test';
import { createOriginPrototype, decidePrototypePolicy } from './owner-patrol-origin-prototype.mjs';
import { createXhhOperationController } from '../src/core/xiaoheihe-operation-controller.mjs';
import { createXhhAuthorizeApi } from '../src/core/xiaoheihe-authorize-api.mjs';

test('已登记消息可关联回合和工具调用；参数自报来源无效', () => {
  const p = createOriginPrototype({ sessionId: 's', epoch: 'e' });
  p.register('m', 'patrol');
  p.step({ sessionId: 's', turn: 1, step: 1, messages: ['m'] });
  p.call({ sessionId: 's', turn: 1, step: 1, callId: 'c' });
  assert.equal(p.lookup({ sessionId: 's', callId: 'c', source: 'owner' }), 'patrol');
});

test('未登记、混合输入、空步骤后未知状态保持', () => {
  const p = createOriginPrototype({ sessionId: 's', epoch: 'e' });
  p.register('m', 'patrol');
  p.step({ sessionId: 's', turn: 1, step: 1, messages: ['m', 'forged'] });
  p.step({ sessionId: 's', turn: 1, step: 2, messages: [] });
  p.call({ sessionId: 's', turn: 1, step: 2, callId: 'c' });
  assert.equal(p.lookup({ sessionId: 's', callId: 'c' }), 'unknown');
});

test('巡逻开始后混入未知输入，使同一回合原有调用也不可再用于新授权', () => {
  const p = createOriginPrototype({ sessionId: 's', epoch: 'e' });
  p.register('m', 'patrol');
  p.step({ sessionId: 's', turn: 1, step: 1, messages: ['m'] });
  p.call({ sessionId: 's', turn: 1, step: 1, callId: 'c' });
  p.step({ sessionId: 's', turn: 1, step: 2, messages: ['untrusted'] });
  assert.equal(p.lookup({ sessionId: 's', callId: 'c' }), 'unknown');
});

test('重复调用 ID、错误会话及未经观察的步骤均不得建立权限', () => {
  const p = createOriginPrototype({ sessionId: 's', epoch: 'e' });
  p.register('m', 'patrol');
  p.step({ sessionId: 's', turn: 1, step: 1, messages: ['m'] });
  p.call({ sessionId: 's', turn: 1, step: 1, callId: 'c' });
  p.call({ sessionId: 's', turn: 1, step: 1, callId: 'c' });
  assert.equal(p.lookup({ sessionId: 's', callId: 'c' }), 'unknown');
  assert.equal(p.lookup({ sessionId: 'other', callId: 'c' }), 'unknown');
  p.call({ sessionId: 's', turn: 1, step: 9, callId: 'missing-step' });
  assert.equal(p.lookup({ sessionId: 's', callId: 'missing-step' }), 'unknown');
});

test('入口登记不得重复消费，重启后旧调用不可继承', () => {
  const p = createOriginPrototype({ sessionId: 's', epoch: 'old' });
  p.register('m', 'patrol');
  p.step({ sessionId: 's', turn: 1, step: 1, messages: ['m'] });
  p.step({ sessionId: 's', turn: 2, step: 1, messages: ['m'] });
  p.call({ sessionId: 's', turn: 2, step: 1, callId: 'c' });
  assert.equal(p.lookup({ sessionId: 's', callId: 'c' }), 'unknown');
  const restarted = createOriginPrototype({ sessionId: 's', epoch: 'new' });
  assert.equal(restarted.lookup({ sessionId: 's', callId: 'c' }), 'unknown');
});

test('丢失首步骤或中间步骤时不得恢复可信状态', () => {
  const p = createOriginPrototype({ sessionId: 's', epoch: 'e' });
  p.register('m', 'patrol');
  p.step({ sessionId: 's', turn: 1, step: 2, messages: ['m'] });
  p.call({ sessionId: 's', turn: 1, step: 2, callId: 'c' });
  assert.equal(p.lookup({ sessionId: 's', callId: 'c' }), 'unknown');
  p.register('n', 'patrol');
  p.step({ sessionId: 's', turn: 2, step: 1, messages: ['n'] });
  p.step({ sessionId: 's', turn: 2, step: 3, messages: [] });
  p.call({ sessionId: 's', turn: 2, step: 3, callId: 'd' });
  assert.equal(p.lookup({ sessionId: 's', callId: 'd' }), 'unknown');
});

test('回合结束后不能再用旧调用签发新授权', () => {
  const p = createOriginPrototype({ sessionId: 's', epoch: 'e' });
  p.register('m', 'patrol');
  p.step({ sessionId: 's', turn: 1, step: 1, messages: ['m'] });
  p.call({ sessionId: 's', turn: 1, step: 1, callId: 'c' });
  assert.equal(p.lookup({ sessionId: 's', callId: 'c' }), 'patrol');
  p.end({ sessionId: 's', turn: 1 });
  assert.equal(p.lookup({ sessionId: 's', callId: 'c' }), 'unknown');
  p.step({ sessionId: 's', turn: 1, step: 2, messages: [] });
  p.call({ sessionId: 's', turn: 1, step: 2, callId: 'late' });
  assert.equal(p.lookup({ sessionId: 's', callId: 'late' }), 'unknown');
});

test('策略样品：巡逻写入必须走额度；登录一律拒绝', () => {
  assert.equal(decidePrototypePolicy('patrol', 'write'), 'quota');
  assert.equal(decidePrototypePolicy('patrol', 'credential'), 'deny');
});

test('策略样品：owner 沿用既有门禁，未知来源拒绝敏感操作', () => {
  assert.equal(decidePrototypePolicy('owner', 'write'), 'existing');
  assert.equal(decidePrototypePolicy('owner', 'credential'), 'existing');
  assert.equal(decidePrototypePolicy('unknown', 'write'), 'deny');
  assert.equal(decidePrototypePolicy('unknown', 'credential'), 'deny');
});

test('同会话独立管理员回合与巡逻回合不互相覆盖', () => {
  const p = createOriginPrototype({ sessionId: 's', epoch: 'e' });
  p.register('owner-message', 'owner');
  p.register('patrol-message', 'patrol');
  p.step({ sessionId: 's', turn: 1, step: 1, messages: ['owner-message'] });
  p.call({ sessionId: 's', turn: 1, step: 1, callId: 'owner-call' });
  assert.equal(p.lookup({ sessionId: 's', callId: 'owner-call' }), 'owner');
  p.end({ sessionId: 's', turn: 1 });
  p.step({ sessionId: 's', turn: 2, step: 1, messages: ['patrol-message'] });
  p.call({ sessionId: 's', turn: 2, step: 1, callId: 'patrol-call' });
  assert.equal(p.lookup({ sessionId: 's', callId: 'owner-call' }), 'unknown');
  assert.equal(p.lookup({ sessionId: 's', callId: 'patrol-call' }), 'patrol');
});

test('同一批消息重复 ID 不能被误判成可信来源', () => {
  const p = createOriginPrototype({ sessionId: 's', epoch: 'e' });
  p.register('m', 'patrol');
  p.step({ sessionId: 's', turn: 1, step: 1, messages: ['m', 'm'] });
  p.call({ sessionId: 's', turn: 1, step: 1, callId: 'c' });
  assert.equal(p.lookup({ sessionId: 's', callId: 'c' }), 'unknown');
});

test('已知缺口复现：样品只接收消息 ID，不能发现消息内容被替换', () => {
  const p = createOriginPrototype({ sessionId: 's', epoch: 'e' });
  p.register('trusted-id', 'patrol');
  // content 在样品接口中没有绑定；此测试不证明真实宿主允许外部篡改消息 ID。
  p.step({ sessionId: 's', turn: 1, step: 1, messages: ['trusted-id'], content: 'different content' });
  p.call({ sessionId: 's', turn: 1, step: 1, callId: 'c' });
  assert.equal(p.lookup({ sessionId: 's', callId: 'c' }), 'patrol', '仅表示复现未绑定内容的缺口，不能用于生产');
});

test('已知缺口复现：策略样品依赖传入操作分类，不能认证真实工具名', () => {
  // 假设调用方错误地把登录工具分类成 write，样品自身无法识别工具名。
  assert.equal(decidePrototypePolicy('patrol', 'write', 'interactive_login'), 'quota');
});

test('新回合已开始但未收到旧回合结束时，旧调用和新回合都不可授权', () => {
  const p = createOriginPrototype({ sessionId: 's', epoch: 'e' });
  p.register('m', 'patrol');
  p.register('n', 'owner');
  p.step({ sessionId: 's', turn: 1, step: 1, messages: ['m'] });
  p.call({ sessionId: 's', turn: 1, step: 1, callId: 'old-call' });
  p.step({ sessionId: 's', turn: 2, step: 1, messages: ['n'] });
  p.call({ sessionId: 's', turn: 2, step: 1, callId: 'new-call' });
  assert.equal(p.lookup({ sessionId: 's', callId: 'old-call' }), 'unknown');
  assert.equal(p.lookup({ sessionId: 's', callId: 'new-call' }), 'unknown');
});

test('旧回合迟到结束不能关闭已正常开始的新回合', () => {
  const p = createOriginPrototype({ sessionId: 's', epoch: 'e' });
  p.register('m', 'patrol');
  p.register('n', 'owner');
  p.step({ sessionId: 's', turn: 1, step: 1, messages: ['m'] });
  p.end({ sessionId: 's', turn: 1 });
  p.step({ sessionId: 's', turn: 2, step: 1, messages: ['n'] });
  p.call({ sessionId: 's', turn: 2, step: 1, callId: 'new-call' });
  p.end({ sessionId: 's', turn: 1 });
  assert.equal(p.lookup({ sessionId: 's', callId: 'new-call' }), 'owner');
});

test('断线后旧调用失效，重连回放不能在同一实例恢复可信状态', () => {
  const p = createOriginPrototype({ sessionId: 's', epoch: 'e' });
  p.register('m', 'patrol');
  p.step({ sessionId: 's', turn: 1, step: 1, messages: ['m'] });
  p.call({ sessionId: 's', turn: 1, step: 1, callId: 'old' });
  p.disconnect();
  assert.equal(p.lookup({ sessionId: 's', callId: 'old' }), 'unknown');
  p.end({ sessionId: 's', turn: 1 });
  p.register('n', 'owner');
  p.step({ sessionId: 's', turn: 2, step: 1, messages: ['n'] });
  p.call({ sessionId: 's', turn: 2, step: 1, callId: 'new' });
  assert.equal(p.lookup({ sessionId: 's', callId: 'new' }), 'unknown');
});

test('真实额度控制器：旧授权契约可保留 reserve→commit 计数，但不等于巡逻接线', async () => {
  const now = Date.UTC(2026, 9, 24, 2, 0, 0);
  const controller = createXhhOperationController({ clock: () => now });
  // 旧兼容模式没有 provenanceClassifier；仅证明真实额度机制，不能用于生产巡逻认证。
  const api = createXhhAuthorizeApi({ controller, backgroundSessionKeys: ['fixture'], clock: () => now });
  const reserved = await api.authorize({ agentKey: 'fixture', tool: 'publish_content', args: { operationId: 'offline-probe' }, now });
  assert.equal(reserved.decision, 'allow');
  assert.equal((await controller.status()).post.used, 0);
  const committed = await api.commit({ ticket: reserved.ticket, agentKey: 'fixture', now });
  assert.equal(committed.started, true);
  assert.equal((await controller.status()).post.used, 1);
  const again = await api.commit({ ticket: reserved.ticket, agentKey: 'fixture', now });
  assert.equal(again.ok, true);
  assert.equal((await controller.status()).post.used, 1);
});

test('真实现有门禁：已判巡逻时写入和登录都被拒绝，仍需更改写入政策', async () => {
  const now = Date.UTC(2026, 9, 24, 2, 0, 0);
  const controller = createXhhOperationController({ clock: () => now });
  const api = createXhhAuthorizeApi({ controller, backgroundSessionKeys: ['fixture'], clock: () => now, provenanceClassifier: () => 'patrol' });
  const write = await api.authorize({ agentKey: 'fixture', tool: 'publish_content', args: { operationId: 'offline-patrol' }, now });
  const login = await api.authorize({ agentKey: 'fixture', tool: 'interactive_login', args: {}, now });
  assert.equal(write.decision, 'deny');
  assert.equal(write.reason, 'read-only-background');
  assert.equal(login.decision, 'deny');
  assert.equal(login.reason, 'credential-requires-user-present');
});
