import assert from 'node:assert/strict';
import test from 'node:test';
import { createBindingPrototype } from './owner-patrol-binding-prototype.mjs';

const message = () => ({ id: 'm', role: 'user', source: { kind: 'schedule' }, content: [{ type: 'text', text: '巡逻机会' }] });
const request = (overrides = {}) => ({ sessionId: 's', turn: 1, step: 1, callId: 'c', tool: 'mcp__xiaoheihe__publish_content', args: { content: '测试' }, ...overrides });
function prepare() {
  const p = createBindingPrototype({ sessionId: 's', epoch: 'e' });
  const m = message();
  p.register(m, 'patrol');
  p.step({ sessionId: 's', turn: 1, step: 1, messages: [structuredClone(m)] });
  return p;
}

test('绑定真实工具和参数后，巡逻写进入额度路径；登录被拒', () => {
  const p = prepare();
  p.call(request());
  assert.equal(p.authorize(request()), 'quota');
  const credential = request({ callId: 'login', tool: 'mcp__xiaoheihe__interactive_login', args: {} });
  p.call(credential);
  assert.equal(p.authorize(credential), 'deny');
});

test('安全反例：若不可信调用方能访问样品登记接口，可自称管理员并获得登录路径', () => {
  // 这是样品的已知缺口复现，不是声称线上存在此接口或此漏洞。
  const p = createBindingPrototype({ sessionId: 's', epoch: 'e' });
  const m = message();
  p.register(m, 'owner');
  p.step({ sessionId: 's', turn: 1, step: 1, messages: [m] });
  const login = request({ callId: 'forged-owner-login', tool: 'mcp__xiaoheihe__interactive_login', args: {} });
  p.call(login);
  assert.equal(p.authorize(login), 'existing', '登记接口本身没有认证，不能作为生产信任边界');
});

test('安全反例对照：相同会话收到未登记的消息，不因私聊会话而获得管理员路径', () => {
  const p = createBindingPrototype({ sessionId: 's', epoch: 'e' });
  const m = message();
  p.step({ sessionId: 's', turn: 1, step: 1, messages: [m] });
  const login = request({ callId: 'unregistered-login', tool: 'mcp__xiaoheihe__interactive_login', args: {} });
  p.call(login);
  assert.equal(p.authorize(login), 'deny');
});

test('同 ID 替换消息内容或来源都不能通过', () => {
  for (const mutate of [m => { m.content[0].text = '替换内容'; }, m => { m.source.kind = 'user'; }]) {
    const p = createBindingPrototype({ sessionId: 's', epoch: 'e' });
    const original = message();
    p.register(original, 'patrol');
    const changed = structuredClone(original);
    mutate(changed);
    p.step({ sessionId: 's', turn: 1, step: 1, messages: [changed] });
    p.call(request());
    assert.equal(p.authorize(request()), 'deny');
  }
});

test('替换工具名、参数、会话或调用编号均不得复用绑定', () => {
  const p = prepare();
  p.call(request());
  for (const changed of [
    { tool: 'mcp__xiaoheihe__interactive_login' }, { args: { content: '篡改' } },
    { sessionId: 'other' }, { callId: 'other' },
  ]) assert.equal(p.authorize(request(changed)), 'deny');
});

test('未知工具名 fail-closed，不能由操作类别自报获得权限', () => {
  const p = prepare();
  const unknown = request({ tool: 'mcp__xiaoheihe__not_a_real_tool', operation: 'write' });
  p.call(unknown);
  assert.equal(p.authorize(unknown), 'deny');
});

test('登记后调用方修改原始对象不能改变已绑定内容', () => {
  const p = createBindingPrototype({ sessionId: 's', epoch: 'e' });
  const original = message();
  p.register(original, 'patrol');
  original.content[0].text = '篡改';
  p.step({ sessionId: 's', turn: 1, step: 1, messages: [original] });
  p.call(request());
  assert.equal(p.authorize(request()), 'deny');
});

test('同一消息 ID 重新登记不同内容时拒绝且污染实例，旧登记也不能继续授权', () => {
  const p = createBindingPrototype({ sessionId: 's', epoch: 'e' });
  const original = message();
  p.register(original, 'patrol');
  const changed = structuredClone(original);
  changed.content[0].text = '同 ID 的不同消息';
  assert.throws(() => p.register(changed, 'owner'));
  p.step({ sessionId: 's', turn: 1, step: 1, messages: [original] });
  p.call(request());
  assert.equal(p.authorize(request()), 'deny');
});

test('重复工具调用 ID 和登记后参数修改均不得获得授权', () => {
  const p = prepare();
  const call = request();
  p.call(call);
  call.args.content = '更改后';
  assert.equal(p.authorize(call), 'deny');
  p.call(request());
  assert.equal(p.authorize(request()), 'deny');
});

test('改变调用回合或步骤不能复用授权绑定', () => {
  const p = prepare();
  p.call(request());
  assert.equal(p.authorize(request({ turn: 2 })), 'deny');
  assert.equal(p.authorize(request({ step: 2 })), 'deny');
});

test('循环数据、非有限数值和访问器不能作为调用参数授权', () => {
  for (const invalid of [
    (() => { const value = {}; value.self = value; return value; })(),
    { value: Infinity },
    Object.defineProperty({}, 'value', { enumerable: true, get() { throw new Error('must not execute'); } }),
  ]) {
    const p = prepare();
    const call = request({ args: invalid });
    assert.doesNotThrow(() => p.call(call));
    assert.equal(p.authorize(call), 'deny');
  }
});

test('相同语义的对象键顺序不会破坏绑定', () => {
  const p = prepare();
  p.call(request({ args: { b: 2, a: 1 } }));
  assert.equal(p.authorize(request({ args: { a: 1, b: 2 } })), 'quota');
});
