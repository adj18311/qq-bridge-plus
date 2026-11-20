// F7, pinned: ordinary tool traffic shares the ledger's `calls` budget with space
// calls, and the session observer can be restricted to bindable tool names.
//
// The host emits one `tool/call` per invocation of ANY tool
// (`dsh-tools/lib/pipeline.js:188 agent.session.append("tool/call", { turn, step,
// callId, name, arguments })`), and the observer used to forward all of them
// (`session-observer.mjs`, `if (event?.type === 'tool/call') ledger.observeToolCall(…)`).
// `qzone-origin-ledger-offline.mjs` spends one `calls` slot per observation against a
// per-ledger `trackingLimit`, so with `trackingLimit: 4` four `bash` calls in one step
// make a legitimate `qzone_*` call in that same step fail `tracking-capacity`.
//
// The fix is opt-in: `createQzoneSessionObserver({ bindableToolNames })`. Omitting it
// keeps today's observe-everything behaviour on purpose — narrowing the observed set
// is an owner decision, not something the observer should decide silently.
//
// R12-2 (Codex ruling 2): the option lived on `createQzonePrestepAdapter` together with
// a compat `eventContext`. Both are gone; the adapter only handles `agent/pre-step`, so
// the six low-level cases below build the observer directly. The last two cases still go
// through `createQzonePluginHandle` — they pin the WIRING (that the entry passes the
// allow-list), which is a different claim from the observer's ability to filter.
//
// Offline only: fake Cordis ctx, fake tool registry, fake dispatcher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzonePrestepAdapter } from '../plugins/qzone-safe/prestep-adapter.mjs';
import { createQzoneSessionObserver } from '../plugins/qzone-safe/session-observer.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { QZONE_TOOL_NAMES } from '../plugins/qzone-safe/index.mjs';

const SESSION = 's1';
const userMessage = (rpcId) => ({ role: 'user', source: { rpcId } });

function harness({ bindableToolNames } = {}) {
  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1', trackingLimit: 4 });
  const agentListeners = new Map();
  const eventListeners = new Map();
  const collect = (map) => (name, fn) => {
    const list = map.get(name) ?? [];
    list.push(fn);
    map.set(name, list);
    return () => {};
  };
  const adapter = createQzonePrestepAdapter({
    agentContext: { on: collect(agentListeners) },
    ledger,
    sessionId: SESSION,
  });
  const observer = createQzoneSessionObserver({
    eventContext: { on: collect(eventListeners) },
    ledger,
    sessionId: SESSION,
    ...(bindableToolNames === undefined ? {} : { bindableToolNames }),
  });
  const fire = (map, name, ...args) => { for (const fn of map.get(name) ?? []) fn(...args); };
  return {
    adapter,
    observer,
    ledger,
    preStep: (turn, step, messages) => fire(agentListeners, 'agent/pre-step', { turn, step, messages }, () => {}),
    toolCall: (turn, step, callId, name) => fire(eventListeners, 'session/event', { id: SESSION },
      { type: 'tool/call', data: { turn, step, callId, ...(name === undefined ? {} : { name }) } }),
    turnEnd: (turn) => fire(eventListeners, 'session/event', { id: SESSION }, { type: 'turn/end', data: { turn } }),
  };
}

const ORDINARY = 'pi_tool_load_bash';

test('默认（不传 bindableToolNames）会把普通工具的 tool/call 也送进账本，并占满空间调用的预算', () => {
  const h = harness();
  h.ledger.registerBridgeRequest({ requestId: 'r1', origin: 'qq-inbound' });
  h.preStep(1, 1, [userMessage('r1')]);
  // Four ordinary calls fill the per-ledger budget of 4 before the qzone call runs.
  for (let i = 0; i < 4; i += 1) h.toolCall(1, 1, `ord-${i}`, ORDINARY);
  h.toolCall(1, 1, 'space-call', 'qzone_read_posts');
  assert.equal(h.ledger.peekCall('ord-0')?.turn, 1, '普通工具确实被账本观测到了');
  assert.equal(h.ledger.peekCall('space-call'), null,
    '普通工具挤满 calls 之后，同一步的合法空间调用拿不到位置（这就是 F7 的真实影响）');
  h.adapter.dispose();
  h.observer.dispose();
});

test('传入 qzone 工具名白名单后，普通工具不再进账本，同一步的空间调用仍然能绑定', () => {
  const h = harness({ bindableToolNames: QZONE_TOOL_NAMES });
  h.ledger.registerBridgeRequest({ requestId: 'r2', origin: 'qq-inbound' });
  h.preStep(1, 1, [userMessage('r2')]);
  for (let i = 0; i < 64; i += 1) h.toolCall(1, 1, `ord-${i}`, ORDINARY);
  h.toolCall(1, 1, 'space-call', 'qzone_read_posts');
  assert.equal(h.ledger.peekCall('ord-0'), null, '普通工具不得进入账本');
  // peekCall returns only { turn, step } by design — the requestId is ledger-owned
  // evidence and only `consume` hands it out. Asserting the projection, then consume.
  assert.deepEqual(h.ledger.peekCall('space-call'), { turn: 1, step: 1 },
    '被过滤掉的只是非绑定工具，空间调用照旧拿到位置');
  // `consume` re-validates the position, so turn/step must be repeated by the caller
  // (that is the point: the binding is not handed out on a bare callId).
  assert.deepEqual(h.ledger.consume({ sessionId: SESSION, turn: 1, step: 1, callId: 'space-call' }),
    { origin: 'qq-inbound', requestId: 'r2', turn: 1, step: 1, epoch: 'e1', sessionId: SESSION, callId: 'space-call' });
  h.adapter.dispose();
  h.observer.dispose();
});

test('白名单不得削弱防重放：被观测过的空间 callId 重放仍必须被拒', () => {
  const h = harness({ bindableToolNames: QZONE_TOOL_NAMES });
  h.ledger.registerBridgeRequest({ requestId: 'r3', origin: 'qq-inbound' });
  h.preStep(1, 1, [userMessage('r3')]);
  h.toolCall(1, 1, 'space-call', 'qzone_read_posts');
  assert.ok(h.ledger.consume({ sessionId: SESSION, turn: 1, step: 1, callId: 'space-call' }));
  // Same callId reported a second time in the same turn: the ledger poisons it.
  h.toolCall(1, 1, 'space-call', 'qzone_read_posts');
  assert.equal(h.ledger.consume({ sessionId: SESSION, turn: 1, step: 1, callId: 'space-call' }), null,
    '重放同一个空间 callId 必须仍然是 null');
  h.adapter.dispose();
  h.observer.dispose();
});

test('缺 name 的 tool/call 仍然被观测：把宿主异常变成静默派发失败更糟', () => {
  const h = harness({ bindableToolNames: QZONE_TOOL_NAMES });
  h.ledger.registerBridgeRequest({ requestId: 'r4', origin: 'qq-inbound' });
  h.preStep(1, 1, [userMessage('r4')]);
  // DSH always writes `name`, so a nameless event is not the shape the filter was
  // reasoned about. Observing it fails closed exactly as before; filtering it would
  // turn a host quirk into an unexplained `origin-unbound`.
  h.toolCall(1, 1, 'nameless-call', undefined);
  assert.deepEqual(h.ledger.peekCall('nameless-call'), { turn: 1, step: 1 },
    '缺 name 时必须照旧观测，不得因为白名单而静默丢事件');
  h.adapter.dispose();
  h.observer.dispose();
});

test('白名单是 Set 形状契约：传别的类型必须立刻抛错，不得静默退化成不过滤', () => {
  assert.throws(() => createQzoneSessionObserver({
    eventContext: { on: () => () => {} },
    ledger: createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1' }),
    sessionId: SESSION,
    bindableToolNames: ['qzone_read_posts'],
  }), /bindableToolNames must be a Set/);
});

test('QZONE_TOOL_NAMES 必须覆盖插件真正注册的每一个工具名', () => {
  assert.deepEqual([...QZONE_TOOL_NAMES].sort(), [
    'qzone_comment', 'qzone_like', 'qzone_publish', 'qzone_read_comments', 'qzone_read_posts', 'qzone_reply',
  ], 'native-tool.mjs 注册的是 qzone_<action>，白名单必须与之逐字一致');
});

// The observer option only helps if the entry actually passes it. These two cases go
// through `createQzonePluginHandle` so the wiring itself is pinned, not just the
// observer's ability to filter. Unchanged by R12-2: the plugin already went through the
// session observer and never used the adapter's compat `eventContext`.
import { createQzonePluginHandle, MAX_POSITIONS } from '../plugins/qzone-safe/index.mjs';

function pluginHost() {
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

async function pluginHarness() {
  const host = pluginHost();
  const agentCallbacks = new Map();
  const ledger = createQzoneOriginLedger({ sessionId: 's1', epoch: 'e1', trackingLimit: 4 });
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: 'e1',
    defineTool: (tool) => tool,
    sourceLifetime: { sourceEpoch: () => 'e1', getLedger: () => ledger },
    dispatch: async () => ({ ok: true }),
  });
  host.emit('agent/created', {
    agent: {
      id: 'agent-1', session: { id: 's1' },
      ctx: { on: (name, fn) => {
        const list = agentCallbacks.get(name) ?? [];
        list.push(fn);
        agentCallbacks.set(name, list);
        return () => {};
      } },
    },
  });
  return {
    host, ledger, handle,
    preStep: (turn, step, messages) => {
      for (const cb of agentCallbacks.get('agent/pre-step') ?? []) cb({ turn, step, messages }, () => {});
    },
    toolCall: (turn, step, callId, name) => host.emit('session/event', { id: 's1' },
      { type: 'tool/call', data: { turn, step, callId, ...(name === undefined ? {} : { name }) } }),
    exec: (callId) => ({ callId, agent: { session: { id: 's1' } } }),
    tool: host.registered.get('qzone_read_posts'),
  };
}

test('插件入口默认启用名字过滤：普通工具不再占用账本预算，同一步的空间调用照旧成功', async () => {
  const h = await pluginHarness();
  h.handle.registerBridgeRequest('s1', { requestId: 'r10', origin: 'qq-inbound' });
  h.preStep(1, 1, [userMessage('r10')]);
  for (let i = 0; i < 16; i += 1) h.toolCall(1, 1, `ord-${i}`, ORDINARY);
  h.toolCall(1, 1, 'space-call', 'qzone_read_posts');
  assert.deepEqual(await h.tool.execute({ target_uin: 456 }, h.exec('space-call')), { ok: true },
    '普通工具不得挤掉同一步的合法空间调用');
});

test('插件入口默认启用名字过滤：普通工具不再把待派发的位置挤出 positions', async () => {
  const h = await pluginHarness();
  h.handle.registerBridgeRequest('s1', { requestId: 'r11', origin: 'qq-inbound' });
  h.preStep(1, 1, [userMessage('r11')]);
  h.toolCall(1, 1, 'space-pending', 'qzone_read_posts');
  // Enough ordinary calls to overflow a 4096-entry map if they were stored.
  for (let i = 0; i < MAX_POSITIONS + 8; i += 1) h.toolCall(1, 1, `ord-${i}`, ORDINARY);
  assert.deepEqual(await h.tool.execute({ target_uin: 456 }, h.exec('space-pending')), { ok: true },
    '普通工具不得把待派发的空间位置挤出容量');
});