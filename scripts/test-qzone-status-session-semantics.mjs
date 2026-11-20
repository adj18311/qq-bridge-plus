// Pins the `status(sessionId)` argument contract, which had two comments in the
// implementation disagreeing with each other and with the code:
//
//   :409-410  "`sessionId` is optional ... omit it and the answer means
//              'at least one session is wired'"
//   :427-429  "`null`/`''`/`undefined` mean 'I do not know which session I am', and
//              answering that with 'some other session can dispatch' is precisely the
//              false promise this field exists to remove"
//
// The implementation only satisfied the first. `typeof sessionId === 'string'` cannot
// tell "no argument" from "an argument whose value could not name a session", so
// `status(null)` / `status('')` / `status(undefined)` all fell through to the global
// answer and returned the s2 availability for an s1 caller.
//
// The fix keys off `arguments.length`, the ONLY signal that separates `status()` from
// `status(undefined)`. That distinction is the whole contract, so it is asserted here
// from all four directions a caller can hit: a valid session, an unusable argument, a
// different session that happens to be wired, and the no-argument compatibility form.
//
// R12-2 (reviewer finding): the first case originally claimed "can dispatch really
// dispatches" while never calling `execute()` — it emitted `agent/pre-step` on the
// HOST ctx (the plugin subscribes to it on the AGENT ctx) and dropped the agent ctx on
// the floor, so a mutation that makes every dispatch fail left this file fully green.
// The harness below therefore mirrors `test-qzone-agent-resume.mjs`: a real per-agent
// ctx whose listeners are stored and fireable, and a real `execute()` whose result is
// asserted. `makeEveryDispatchFail` below is the regression guard for exactly that.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createQzonePluginHandle } from '../plugins/qzone-safe/index.mjs';

const TOOL = 'qzone_read_posts';
const defineTool = (tool) => tool;
const execFor = (sessionId, callId) => ({ agent: { session: { id: sessionId } }, callId });
const userMessage = (requestId) => ({ role: 'user', source: { rpcId: requestId } });

function fakeHost() {
  const listeners = new Map();
  const registered = new Map();
  return {
    registered,
    ctx: {
      on(name, fn) {
        const list = listeners.get(name) ?? [];
        list.push(fn);
        listeners.set(name, list);
        return () => {
          const index = list.indexOf(fn);
          if (index >= 0) list.splice(index, 1);
        };
      },
      tools: { register: (tool) => { registered.set(tool.name, tool); return () => registered.delete(tool.name); } },
    },
    emit(name, ...args) {
      for (const fn of listeners.get(name) ?? []) fn(...args);
    },
  };
}

// The pre-step adapter subscribes on the AGENT ctx, not the host ctx. A ctx that does
// not store its listeners (the old `{ on: () => () => {} }`) makes every `fire` a no-op,
// which is precisely how the old first case could assert "dispatches" without doing it.
function agentCtx() {
  const callbacks = new Map();
  return {
    on(name, fn) {
      const list = callbacks.get(name) ?? [];
      list.push(fn);
      callbacks.set(name, list);
      return () => {};
    },
    fire(name, payload) {
      for (const fn of callbacks.get(name) ?? []) fn(payload, () => {});
    },
  };
}

const agentContexts = new Map();

async function wiredHandle(sessions) {
  const host = fakeHost();
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    dispatch: async () => ({ ok: true }), epoch: 'e1', defineTool,
  });
  for (const [index, sessionId] of sessions.entries()) {
    const agentId = `agent-${index}`;
    const ctxOf = agentCtx();
    agentContexts.set(agentId, ctxOf);
    host.emit('agent/created', { agent: { id: agentId, session: { id: sessionId }, ctx: ctxOf } });
  }
  return { host, handle };
}

// One complete dispatchable turn, in real DSH order: the tool runs INSIDE the turn and
// `turn/end` comes after it (`endTurn` reaps that turn's `calls`, so emitting it first
// makes every dispatch fail `origin-unbound`).
let turnCounter = 0;
async function armAndRun(host, handle, sessionId, { agentKey, requestId, callId }) {
  turnCounter += 1;
  const turn = turnCounter;
  handle.registerBridgeRequest(sessionId, { requestId, origin: 'qq-inbound' });
  agentContexts.get(agentKey).fire('agent/pre-step', { turn, step: 1, messages: [userMessage(requestId)] });
  host.emit('session/event', { id: sessionId }, { type: 'tool/call', data: { turn, step: 1, callId, name: TOOL } });
  const result = await host.registered.get(TOOL).execute({ target_uin: 456 }, execFor(sessionId, callId));
  host.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn } });
  return result;
}

test('有效会话：精确 id 按该会话回答，且承诺的派发真的能成', async () => {
  const { host, handle } = await wiredHandle(['s1']);
  const status = handle.status('s1');
  assert.equal(status.dispatchAvailable, true, 's1 真的接线了，必须报 true');
  assert.deepEqual(status.dispatchableSessions, ['s1']);

  // R12-2: `status` promising dispatchability is only honest if a dispatch then works.
  const result = await armAndRun(host, handle, 's1', { agentKey: 'agent-0', requestId: 'r-1', callId: 'c-1' });
  assert.deepEqual(result, { ok: true }, 'status 说能派，真实的 tool.execute 就必须返回 ok');
  await handle.dispose();
});

test('无效参数：null / 空串 / 显式 undefined 都不得替别的会话回答', async () => {
  const { handle } = await wiredHandle(['s1']);
  // s1 is wired, so any fallthrough to the global answer would return true here.
  assert.equal(handle.status('s1').dispatchAvailable, true, '前提：全局答案确实是 true');

  for (const bogus of [null, '', undefined]) {
    const label = bogus === '' ? "status('')" : `status(${JSON.stringify(bogus) ?? 'undefined'})`;
    assert.equal(handle.status(bogus).dispatchAvailable, false,
      `${label} 表示「我说不出我是哪个会话」，不得拿 s1 的可用性回答`);
  }
  // `dispatchableSessions` is the session-independent field and stays honest.
  assert.deepEqual(handle.status(null).dispatchableSessions, ['s1']);
  await handle.dispose();
});

test('其他会话可用：别的会话活着不能让我这个会话变成可派发', async () => {
  const { handle } = await wiredHandle(['s1', 's2']);
  assert.equal(handle.status('s1').dispatchAvailable, true);
  assert.equal(handle.status('s2').dispatchAvailable, true);
  // Never-registered session: exact answer is false even though two others are live.
  const other = handle.status('s3');
  assert.equal(other.dispatchAvailable, false, 's3 从没接过线，不得报可派发');
  assert.deepEqual([...other.dispatchableSessions].sort(), ['s1', 's2'], '集合仍要如实列出真正有线的那两个');
  await handle.dispose();
});

test('调用方兼容性：省略参数仍是「至少有一个会话可派」，且与显式 undefined 不同', async () => {
  const { handle } = await wiredHandle(['s1']);
  assert.equal(handle.status().dispatchAvailable, true, '无参形式必须继续反映「有线」');
  assert.deepEqual(handle.status().dispatchableSessions, ['s1']);

  // The whole point of `arguments.length`: these two calls are distinguishable.
  assert.notEqual(handle.status().dispatchAvailable, handle.status(undefined).dispatchAvailable,
    'status() 与 status(undefined) 必须给出不同答案，否则接线方无法表达「我不知道我是谁」');

  // And with nothing wired, neither form may promise anything.
  const empty = await wiredHandle([]);
  assert.equal(empty.handle.status().dispatchAvailable, false, '一个会话都没有时无参形式必须为假');
  assert.equal(empty.handle.status(undefined).dispatchAvailable, false);
  await empty.handle.dispose();
  await handle.dispose();
});
