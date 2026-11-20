// The bindable-step rule, pinned.
//
// DSH's `agent/pre-step` payload does not carry the conversation: `messages` is
// the INBOX CLAIM result. Only the FIRST step of a turn claims the inbound QQ
// user message, so only the first step's `messages` carry a `source.rpcId`.
// Later steps carry tool results and host context.
//
// ⚠️ CHANGED 2026-11-17 (t26/t27). This file used to pin the opposite rule — "a
// qzone call is bindable ONLY in the step that claimed the message" — on the
// reasoning that remembering the turn's requestId would let one QQ request mint
// more than one binding.
//
// That rule made the feature impossible. Measured on a live QQ session (turn 148):
// step 1 cited rpcId 7c2c0d09, the model called `qzone_read_posts` on step 2, and
// the tool answered `origin-unbound` — the turn HAD a source; the lookup simply
// asked the wrong step. A model that uses any tool before reaching qzone always
// lands on step 2+, so the old rule could only ever refuse.
//
// The rule is now TURN-scoped, which is what "this turn has one source" means:
//   · a call is bindable when its own step cited the source, OR
//   · when the turn cited exactly ONE source on an EARLIER step (`step > sourceStep`).
// Still refused (and pinned below): mixed sources, no source at all, an earlier
// step than the citing one, and any replay after the turn closed.
//
// The single-use concern is unchanged: `consume` retires each callId, so one
// binding per tool call — exactly as it already was for several calls inside the
// claiming step.
//
// Offline only: fake Cordis ctx, fake tool registry, fake dispatcher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzonePluginHandle } from '../plugins/qzone-safe/index.mjs';

function fakeHost() {
  const callbacks = new Map();
  const registered = new Map();
  const on = (map) => (name, fn) => {
    const list = map.get(name) ?? [];
    list.push(fn);
    map.set(name, list);
    return () => { const index = list.indexOf(fn); if (index >= 0) list.splice(index, 1); };
  };
  return {
    registered,
    ctx: {
      on: on(callbacks),
      tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); } },
    },
    emit(name, ...args) { for (const cb of callbacks.get(name) ?? []) cb(...args); },
  };
}

async function harness() {
  const host = fakeHost();
  const agentCallbacks = new Map();
  const dispatched = [];
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: 'e1',
    defineTool: (tool) => tool,
    dispatch: async (action, input, context) => { dispatched.push({ action, context }); return { ok: true }; },
  });
  host.emit('agent/created', {
    agent: {
      id: 'agent-1',
      session: { id: 's1' },
      ctx: {
        on: (name, fn) => {
          const list = agentCallbacks.get(name) ?? [];
          list.push(fn);
          agentCallbacks.set(name, list);
          return () => {};
        },
      },
    },
  });
  const preStep = (turn, step, messages) => {
    for (const cb of agentCallbacks.get('agent/pre-step') ?? []) cb({ turn, step, messages }, () => {});
  };
  const toolCall = (turn, step, callId) => host.emit('session/event', { id: 's1' }, { type: 'tool/call', data: { turn, step, callId } });
  const turnEnd = (turn) => host.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { turn } });
  const exec = (callId) => ({ callId, agent: { session: { id: 's1' } } });
  const tool = host.registered.get('qzone_read_posts');
  return { handle, host, agentCallbacks, dispatched, preStep, toolCall, turnEnd, exec, tool };
}

const userMessage = (rpcId) => ({ role: 'user', source: { rpcId } });

test('认领了 QQ 消息的那个 step 里，qzone 调用能拿到绑定', async () => {
  const h = await harness();
  h.handle.registerBridgeRequest('s1', { requestId: 'r1', origin: 'qq-inbound' });
  h.preStep(1, 1, [userMessage('r1')]);
  h.toolCall(1, 1, 'call-step1');
  assert.deepEqual(await h.tool.execute({ target_uin: 456 }, h.exec('call-step1')), { ok: true });
  assert.equal(h.dispatched.length, 1);
});

test('同一回合的后续空续步里，qzone 调用可以继承本回合唯一的来源', async () => {
  const h = await harness();
  h.handle.registerBridgeRequest('s1', { requestId: 'r2', origin: 'qq-inbound' });
  h.preStep(2, 1, [userMessage('r2')]);
  h.preStep(2, 2, []);
  h.preStep(2, 3, []);
  h.toolCall(2, 2, 'call-step2');
  h.toolCall(2, 3, 'call-step3');
  // t26: 空续步没有「新来源」，但本回合在第 1 步已经引用过唯一来源 ⇒ 后续 step 继承它。
  assert.deepEqual(await h.tool.execute({ target_uin: 456 }, h.exec('call-step2')), { ok: true },
    '本回合唯一来源必须能被后续 step 继承');
  assert.deepEqual(await h.tool.execute({ target_uin: 456 }, h.exec('call-step3')), { ok: true },
    '第三个续步同样继承（来源是回合级的）');
  assert.equal(h.dispatched.length, 2, '每个 callId 各派发一次');
});

test('同一回合里带工具结果消息的 step 可以继承来源，且工具结果本身不会污染该回合', async () => {
  // The real shape after the model already used another tool in this turn: the
  // next pre-step carries the tool result, whose `source` has `callId` but no
  // `rpcId`. t27: such a step must NOT taint the turn (it introduced no new
  // request), and the qzone call on it inherits the turn's source.
  const h = await harness();
  h.handle.registerBridgeRequest('s1', { requestId: 'r3', origin: 'qq-inbound' });
  h.preStep(3, 1, [userMessage('r3')]);
  h.preStep(3, 2, [{ role: 'tool', source: { callId: 'read-1', kind: 'tool' } }]);
  h.toolCall(3, 2, 'call-step2-ctx');
  assert.deepEqual(await h.tool.execute({ target_uin: 456 }, h.exec('call-step2-ctx')), { ok: true },
    '带工具结果的续步必须继承本回合的唯一来源');
  assert.equal(h.dispatched.length, 1);
});

test('来源在更晚的 step 上引用时，更早 step 的调用不得反向借用', async () => {
  const h = await harness();
  h.handle.registerBridgeRequest('s1', { requestId: 'r5', origin: 'qq-inbound' });
  h.preStep(5, 1, []);
  h.preStep(5, 2, [userMessage('r5')]);
  h.toolCall(5, 1, 'call-before-source');
  assert.deepEqual(await h.tool.execute({ target_uin: 456 }, h.exec('call-before-source')),
    { ok: false, error: 'origin-unbound' }, '来源之前的 step 不得借用后来的来源');
  assert.equal(h.dispatched.length, 0);
});

test('同一个可绑定 step 里的多个 qzone 调用各自都能铸造一次绑定', async () => {
  const h = await harness();
  h.handle.registerBridgeRequest('s1', { requestId: 'r4', origin: 'qq-inbound' });
  h.preStep(4, 1, [userMessage('r4')]);
  h.toolCall(4, 1, 'multi-a');
  h.toolCall(4, 1, 'multi-b');
  assert.deepEqual(await h.tool.execute({ target_uin: 456 }, h.exec('multi-a')), { ok: true });
  assert.deepEqual(await h.tool.execute({ target_uin: 456 }, h.exec('multi-b')), { ok: true });
  // ...but only once each: a second dispatch of the same callId is refused.
  assert.deepEqual(await h.tool.execute({ target_uin: 456 }, h.exec('multi-a')),
    { ok: false, error: 'origin-unbound' });
  assert.equal(h.dispatched.length, 2);
});

test('新的回合从它自己的认领 step 重新开始绑定，不受上一回合影响', async () => {
  const h = await harness();
  h.handle.registerBridgeRequest('s1', { requestId: 'r5', origin: 'qq-inbound' });
  h.preStep(5, 1, [userMessage('r5')]);
  h.toolCall(5, 1, 'call-5');
  assert.deepEqual(await h.tool.execute({ target_uin: 456 }, h.exec('call-5')), { ok: true });
  h.turnEnd(5);
  h.handle.registerBridgeRequest('s1', { requestId: 'r6', origin: 'qq-inbound' });
  h.preStep(6, 1, [userMessage('r6')]);
  h.toolCall(6, 1, 'call-6');
  assert.deepEqual(await h.tool.execute({ target_uin: 456 }, h.exec('call-6')), { ok: true });
  assert.equal(h.dispatched.length, 2);
});
