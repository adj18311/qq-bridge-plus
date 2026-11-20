// The `positions` id gate, pinned.
//
// `plugins/qzone-safe/index.mjs` used to write a position for ANY `tool/call` whose
// two ids were strings: the map is capped at MAX_POSITIONS with oldest-first
// eviction, so an id that can never dispatch (the native tool handler refuses it via
// `session-context.mjs`'s `/^[A-Za-z0-9_.:-]{1,128}$/`) could still occupy a slot and
// eventually push a pending legitimate call out, making it fail `origin-unbound`
// even though its ledger binding was valid.
//
// The fix tests the SAME charset the downstream gates already require, so it drops
// exactly the values that could never have been dispatched — nothing bindable.
//
// Offline only: fake Cordis ctx, fake tool registry, fake dispatcher, real ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzonePluginHandle, MAX_POSITIONS } from '../plugins/qzone-safe/index.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

const SESSION = 's1';
const userMessage = (rpcId) => ({ role: 'user', source: { rpcId } });
const OVER_LONG = 'x'.repeat(300);
const BAD_CHARSET = 'call id with spaces';
const OK_128 = 'y'.repeat(128);

function fakeHost() {
  const callbacks = new Map();
  const registered = new Map();
  const on = (name, fn) => {
    const list = callbacks.get(name) ?? [];
    list.push(fn);
    callbacks.set(name, list);
    return () => {};
  };
  return {
    registered,
    ctx: { on, tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); } } },
    emit(name, ...args) { for (const cb of callbacks.get(name) ?? []) cb(...args); },
  };
}

async function harness() {
  const host = fakeHost();
  const agentCallbacks = new Map();
  const dispatched = [];
  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1' });
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: 'e1',
    defineTool: (tool) => tool,
    sourceLifetime: { sourceEpoch: () => 'e1', getLedger: () => ledger },
    dispatch: async (action, input, context) => { dispatched.push({ action, context }); return { ok: true }; },
  });
  host.emit('agent/created', {
    agent: {
      id: 'agent-1', session: { id: SESSION },
      ctx: { on: (name, fn) => {
        const list = agentCallbacks.get(name) ?? [];
        list.push(fn);
        agentCallbacks.set(name, list);
        return () => {};
      } },
    },
  });
  return {
    host, ledger, dispatched, handle,
    preStep: (turn, step, messages) => {
      for (const cb of agentCallbacks.get('agent/pre-step') ?? []) cb({ turn, step, messages }, () => {});
    },
    toolCall: (turn, step, callId) => host.emit('session/event', { id: SESSION },
      { type: 'tool/call', data: { turn, step, callId, name: 'qzone_read_posts' } }),
    exec: (callId) => ({ callId, agent: { session: { id: SESSION } } }),
    tool: host.registered.get('qzone_read_posts'),
  };
}

test('超过 128 字符的 callId 不得占用 positions 位置：填满容量后合法待派发调用仍然能成功', async () => {
  const h = await harness();
  h.handle.registerBridgeRequest(SESSION, { requestId: 'r1', origin: 'qq-inbound' });
  h.preStep(1, 1, [userMessage('r1')]);
  h.toolCall(1, 1, 'legit-pending');
  for (let i = 0; i < MAX_POSITIONS + 16; i += 1) h.toolCall(1, 1, OVER_LONG);
  assert.deepEqual(await h.tool.execute({ target_uin: 456 }, h.exec('legit-pending')), { ok: true },
    '超长 id 若能占位，就会把合法待派发调用挤出 positions');
});

test('字符集不合法的 callId 同样不得占用 positions 位置', async () => {
  const h = await harness();
  h.handle.registerBridgeRequest(SESSION, { requestId: 'r2', origin: 'qq-inbound' });
  h.preStep(1, 1, [userMessage('r2')]);
  h.toolCall(1, 1, 'legit-pending');
  for (let i = 0; i < MAX_POSITIONS + 16; i += 1) h.toolCall(1, 1, `${BAD_CHARSET}-${i}`);
  assert.deepEqual(await h.tool.execute({ target_uin: 456 }, h.exec('legit-pending')), { ok: true });
});

test('恰好 128 字符的 callId 仍被接受：闸门边界必须与下游一致，不得提前收窄', async () => {
  const h = await harness();
  h.handle.registerBridgeRequest(SESSION, { requestId: 'r3', origin: 'qq-inbound' });
  h.preStep(1, 1, [userMessage('r3')]);
  h.toolCall(1, 1, OK_128);
  assert.deepEqual(await h.tool.execute({ target_uin: 456 }, h.exec(OK_128)), { ok: true });
});

test('session id 超长时同样不得写入 position：否则一份坏 session 就能占位', async () => {
  const h = await harness();
  h.handle.registerBridgeRequest(SESSION, { requestId: 'r4', origin: 'qq-inbound' });
  h.preStep(1, 1, [userMessage('r4')]);
  h.toolCall(1, 1, 'legit-pending');
  // A foreign session whose id is over-long must not consume a slot.
  for (let i = 0; i < MAX_POSITIONS + 16; i += 1) {
    h.host.emit('session/event', { id: OVER_LONG }, { type: 'tool/call', data: { turn: 1, step: 1, callId: `c-${i}`, name: 'qzone_read_posts' } });
  }
  assert.deepEqual(await h.tool.execute({ target_uin: 456 }, h.exec('legit-pending')), { ok: true });
});

test('普通工具名不得占用 positions 位置：填满容量后合法待派发调用仍然能成功', async () => {
  const h = await harness();
  h.handle.registerBridgeRequest(SESSION, { requestId: 'r5', origin: 'qq-inbound' });
  h.preStep(1, 1, [userMessage('r5')]);
  h.toolCall(1, 1, 'legit-pending');
  for (let i = 0; i < MAX_POSITIONS + 16; i += 1) {
    h.host.emit('session/event', { id: SESSION }, { type: 'tool/call', data: { turn: 1, step: 1, callId: `ord-${i}`, name: 'pi_tool_load_bash' } });
  }
  assert.deepEqual(await h.tool.execute({ target_uin: 456 }, h.exec('legit-pending')), { ok: true });
});
