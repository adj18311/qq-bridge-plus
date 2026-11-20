import assert from 'node:assert/strict';
import test from 'node:test';
import { createQzonePrestepAdapter } from '../plugins/qzone-safe/prestep-adapter.mjs';
import { createQzoneSessionObserver } from '../plugins/qzone-safe/session-observer.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

// R12-2 (Codex ruling 2): `createQzonePrestepAdapter` no longer accepts `eventContext`
// or `bindableToolNames`. The two streams are observed by two modules at their real
// granularity — `agent/pre-step` per agent, `session/event` once per SESSION — so every
// case below builds BOTH objects explicitly. Nothing here may reach `session/event`
// through the adapter: that shape is now impossible by construction, and the last case
// pins the rejection.

const sessionId = 'qzone-adapter-session';
const requestId = 'rpc-request-1';

function rig() {
  const agentListeners = new Map();
  const eventListeners = new Map();
  const calls = [];
  const ledger = {
    observeStep(input) { calls.push(['step', input]); return true; },
    observeToolCall(input) { calls.push(['call', input]); return true; },
    endTurn(input) { calls.push(['end', input]); return true; },
    disconnect() { calls.push(['disconnect']); },
  };
  const makeContext = (listeners) => ({
    on(name, callback) {
      listeners.set(name, callback);
      return () => listeners.delete(name);
    },
  });
  const adapter = createQzonePrestepAdapter({
    agentContext: makeContext(agentListeners), ledger, sessionId,
  });
  const observer = createQzoneSessionObserver({
    eventContext: makeContext(eventListeners), ledger, sessionId,
  });
  return { adapter, observer, calls, agentListeners, eventListeners };
}

test('只把真实宿主 step 与 call 字段映射给指定会话的注入 ledger', () => {
  const { adapter, observer, calls, agentListeners, eventListeners } = rig();
  const preStep = agentListeners.get('agent/pre-step');
  let nextCount = 0;
  const messages = [{ id: 'message-1', role: 'user', source: { rpcId: requestId } }];
  preStep({ turn: 1, step: 1, messages, arguments: { sessionId: 'attacker' } }, () => { nextCount++; });
  eventListeners.get('session/event')({ id: sessionId }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1' } });
  assert.equal(nextCount, 1);
  assert.deepEqual(calls, [
    ['step', { sessionId, turn: 1, step: 1, messages }],
    ['call', { sessionId, event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1' } } }],
  ]);
  adapter.dispose();
  observer.dispose();
});

test('turn 结束立即撤销当轮关联并允许下一回合', () => {
  const { adapter, observer, calls, eventListeners } = rig();
  eventListeners.get('session/event')({ id: sessionId }, { type: 'turn/end', data: { turn: 1 } });
  assert.deepEqual(calls, [['end', { sessionId, turn: 1 }]]);
  adapter.dispose();
  observer.dispose();
});

test('空续步及混合来源原样送 ledger 判定；其他会话事件忽略', () => {
  const { adapter, observer, calls, agentListeners, eventListeners } = rig();
  agentListeners.get('agent/pre-step')({ turn: 1, step: 1, messages: [] }, () => {});
  const mixed = [
    { role: 'user', source: { rpcId: requestId } },
    { role: 'user', source: { rpcId: 'another-request' } },
  ];
  agentListeners.get('agent/pre-step')({ turn: 1, step: 2, messages: mixed }, () => {});
  eventListeners.get('session/event')({ id: 'other-session' }, { type: 'tool/call', data: { turn: 1, step: 2, callId: 'foreign' } });
  assert.deepEqual(calls.map(([kind, value]) => [kind, kind === 'step' ? value.messages : value]), [
    ['step', []], ['step', mixed],
  ]);
  adapter.dispose();
  observer.dispose();
});

test('缺字段的宿主 step fail closed 并令 ledger 失去连续性；dispose 解绑且断流', () => {
  const { adapter, observer, calls, agentListeners, eventListeners } = rig();
  agentListeners.get('agent/pre-step')({ turn: 1, step: 1 }, () => {});
  assert.deepEqual(calls, [['disconnect']]);
  adapter.dispose();
  observer.dispose();
  assert.equal(agentListeners.size + eventListeners.size, 0, '两个模块的订阅都必须被解开');
  assert.deepEqual(calls, [['disconnect']], '干净 dispose 不得追加一次 disconnect');
});

// The subscription-rollback semantics moved with the code. It used to be one test
// ("the SECOND subscription throwing must undo the first"), because one adapter owned
// both. Now each module owns exactly one subscription, so both halves are asserted
// separately, and each keeps the full contract: undo what was subscribed, disconnect the
// ledger exactly once, and throw instead of returning a half-wired handle.
test('订阅失败必须撤销已建立的订阅并关闭来源账本，然后抛错（两个模块各一条）', () => {
  // (a) pre-step subscription throws.
  {
    const listeners = new Map();
    let disconnected = 0;
    const agentContext = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); } };
    const brokenAgentContext = { on() { throw new Error('pre-step subscription failed'); } };
    const ledger = { observeStep() {}, observeToolCall() {}, endTurn() {}, disconnect() { disconnected++; } };
    assert.throws(() => createQzonePrestepAdapter({ agentContext: brokenAgentContext, ledger, sessionId }),
      /qzone prestep event subscription failed/);
    assert.equal(disconnected, 1, '订阅失败必须立刻关闭来源账本');
    // The healthy context proves the throwing one left nothing behind in a real map.
    const adapter = createQzonePrestepAdapter({ agentContext, ledger, sessionId });
    assert.equal(listeners.size, 1);
    adapter.dispose();
    assert.equal(listeners.size, 0, 'dispose 必须解开自身订阅');
  }
  // (b) session/event subscription throws — the half the adapter used to own.
  {
    const listeners = new Map();
    let disconnected = 0;
    const eventContext = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); } };
    const brokenEventContext = { on() { throw new Error('event subscription failed'); } };
    const ledger = { observeStep() {}, observeToolCall() {}, endTurn() {}, disconnect() { disconnected++; } };
    assert.throws(() => createQzoneSessionObserver({ eventContext: brokenEventContext, ledger, sessionId }),
      /qzone session observer subscription failed/);
    assert.equal(disconnected, 1, '订阅失败必须立刻关闭来源账本');
    const observer = createQzoneSessionObserver({ eventContext, ledger, sessionId });
    assert.equal(listeners.size, 1);
    observer.dispose();
    assert.equal(listeners.size, 0);
  }
});

test('适配器连接真实离线 ledger 后只认证匹配的 request-step-call 链', () => {
  const agentListeners = new Map();
  const eventListeners = new Map();
  const context = (listeners) => ({ on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name); } });
  const ledger = createQzoneOriginLedger({ sessionId, epoch: 'epoch-1' });
  ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  const adapter = createQzonePrestepAdapter({
    agentContext: context(agentListeners), ledger, sessionId,
  });
  const observer = createQzoneSessionObserver({
    eventContext: context(eventListeners), ledger, sessionId,
  });
  agentListeners.get('agent/pre-step')({ turn: 1, step: 1, messages: [
    { id: 'host-message', role: 'user', source: { kind: 'user', rpcId: requestId } },
  ] }, () => {});
  eventListeners.get('session/event')({ id: sessionId }, {
    type: 'tool/call', data: { turn: 1, step: 1, callId: 'host-call' },
  });
  assert.deepEqual(ledger.consume({ sessionId, turn: 1, step: 1, callId: 'host-call' }), {
    requestId, origin: 'qq-inbound', sessionId, epoch: 'epoch-1', turn: 1, step: 1, callId: 'host-call',
  });
  adapter.dispose();
  observer.dispose();
});

// The removal is enforced, not documented: a caller that still believes it configured
// session observation through the adapter must fail loudly at construction time. Being
// silently ignored is strictly worse — it yields a session that looks wired, filtered
// nothing, and records no `session/event` at all.
test('已移除的 eventContext / bindableToolNames 必须显式抛错，不得静默忽略', () => {
  const ledger = { observeStep() {}, observeToolCall() {}, endTurn() {}, disconnect() {} };
  const agentContext = { on: () => () => {} };
  assert.throws(() => createQzonePrestepAdapter({ agentContext, eventContext: { on: () => () => {} }, ledger, sessionId }),
    /no longer accepts eventContext/);
  assert.throws(() => createQzonePrestepAdapter({ agentContext, ledger, sessionId, bindableToolNames: new Set(['qzone_read_posts']) }),
    /no longer accepts bindableToolNames/);
  // Spreading an absent option (`undefined`) must keep working: optional-key objects are
  // a normal call shape and none of the three cases above is a real configuration.
  const adapter = createQzonePrestepAdapter({ agentContext, ledger, sessionId, eventContext: undefined, bindableToolNames: undefined });
  adapter.dispose();
});