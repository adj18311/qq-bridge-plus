import test from 'node:test';
import assert from 'node:assert/strict';
import { applyQzoneNativeTools } from '../plugins/qzone-safe/native-tool.mjs';
import { loadHostToolRuntime } from './host-tool-runtime-fixture.mjs';
import { QZONE_MCP_TOOLS } from '../src/core/qzone-mcp-contract.mjs';

const actions = ['read_posts', 'read_comments', 'publish', 'comment', 'reply', 'like'];

async function fixture(dispatch) {
  const registered = new Map();
  const ctx = { tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); } } };
  const defineTool = (tool) => tool;
  await applyQzoneNativeTools(ctx, { dispatch, defineTool });
  return registered;
}

const exec = { agent: { session: { id: 'session-native-1' } }, callId: 'call-native-1' };

test('注册六个 DSH 原生入口并把原生身份及业务输入交给注入 dispatch', async () => {
  const calls = [];
  const tools = await fixture(async (...args) => { calls.push(args); return { ok: true }; });
  assert.deepEqual([...tools.keys()], actions.map((action) => `qzone_${action}`));

  const result = await tools.get('qzone_read_posts').execute({ target_uin: '12345' }, exec);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [[
    'read_posts', { target_uin: '12345' },
    { sessionId: 'session-native-1', callId: 'call-native-1' },
  ]]);
});

test('模型参数不能伪造会话身份、调用标识或权限字段', async () => {
  const calls = [];
  const tools = await fixture(async (...args) => { calls.push(args); return { ok: true }; });
  assert.deepEqual(await tools.get('qzone_publish').execute({ content: 'hello', ugc_right: 1,
    sessionId: 'model-session', callId: 'model-call', source: 'owner', authorized: true }, exec),
  { ok: false, error: 'invalid-input' });
  await tools.get('qzone_publish').execute({ content: 'hello', ugc_right: 1 }, exec);
  assert.deepEqual(calls[0], ['publish', { content: 'hello', ugc_right: 1 },
    { sessionId: 'session-native-1', callId: 'call-native-1' }]);
});

test('缺失原生上下文或 dispatch 时拒绝且不调用 dispatch', async () => {
  let count = 0;
  const tools = await fixture(async () => { count += 1; });
  const tool = tools.get('qzone_like');
  for (const badExec of [null, {}, { agent: { session: { id: 'session-native-1' } } },
    { ...exec, callId: '../bad' }]) {
    assert.deepEqual(await tool.execute({ tid: 'tid-1', target_uin: '12345' }, badExec),
      { ok: false, error: 'missing-native-context' });
  }
  assert.equal(count, 0);

  const unavailable = await fixture(undefined);
  assert.deepEqual(await unavailable.get('qzone_like').execute({ tid: 'tid-1', target_uin: '12345' }, exec),
    { ok: false, error: 'dispatch-unavailable' });
});

test('非法业务输入和多余字段拒绝且不派发', async () => {
  let count = 0;
  const tools = await fixture(async () => { count += 1; });
  const invalid = [
    ['qzone_read_posts', {}],
    ['qzone_read_posts', { target_uin: '0' }],
    ['qzone_publish', { content: '', ugc_right: 1 }],
    ['qzone_publish', { content: 'x', ugc_right: 16 }],
    ['qzone_comment', { tid: 't', target_uin: '12345', content: 'x', source: 'model' }],
    ['qzone_like', { tid: '../bad', target_uin: '12345' }],
  ];
  for (const [name, args] of invalid) {
    assert.deepEqual(await tools.get(name).execute(args, exec), { ok: false, error: 'invalid-input' });
  }
  assert.equal(count, 0);
});

test('读取异常的模型输入失败关闭且不派发', async () => {
  let count = 0;
  const tools = await fixture(async () => { count += 1; });
  const args = { get target_uin() { throw new Error('untrusted getter'); } };
  assert.deepEqual(await tools.get('qzone_read_posts').execute(args, exec),
    { ok: false, error: 'invalid-input' });
  const proxy = new Proxy({}, { ownKeys() { throw new Error('untrusted proxy'); } });
  assert.deepEqual(await tools.get('qzone_read_posts').execute(proxy, exec),
    { ok: false, error: 'invalid-input' });
  assert.equal(count, 0);
});

test('dispatch 异常被转换为拒绝结果且不泄露异常信息', async () => {
  const tools = await fixture(async () => { throw new Error('secret credential'); });
  assert.deepEqual(await tools.get('qzone_read_posts').execute({ target_uin: '12345' }, exec),
    { ok: false, error: 'dispatch-failed' });
});

test('注册无法撤销时立即失败并撤销已成功登记的工具', async () => {
  const active = new Set();
  let orphan;
  let dispatched = 0;
  let calls = 0;
  const ctx = { tools: { register(tool) {
    calls++;
    if (calls === 3) { orphan = tool; return undefined; }
    active.add(tool.name);
    return () => active.delete(tool.name);
  } } };
  const result = await applyQzoneNativeTools(ctx, { defineTool: (tool) => tool, dispatch: async () => { dispatched++; } });
  assert.equal(result.ok, false);
  assert.equal(active.size, 0);
  assert.deepEqual(await orphan.execute({ content: 'x', ugc_right: 1 }, exec), { ok: false, error: 'tool-unavailable' });
  assert.equal(dispatched, 0);
});

test('注销后仍持有的工具引用不能再次派发', async () => {
  let count = 0;
  const registered = new Map();
  const registration = await applyQzoneNativeTools({ tools: { register(tool) {
    registered.set(tool.name, tool);
    return () => registered.delete(tool.name);
  } } }, { defineTool: (tool) => tool, dispatch: async () => { count++; } });
  const stale = registered.get('qzone_read_posts');
  registration.dispose();
  assert.deepEqual(await stale.execute({ target_uin: '12345' }, exec), { ok: false, error: 'tool-unavailable' });
  assert.equal(count, 0);
});

test('工具调用已取消时不得发出任何读写请求', async () => {
  let count = 0;
  const tools = await fixture(async () => { count++; });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await tools.get('qzone_publish').execute({ content: 'x', ugc_right: 1 },
    { ...exec, signal: controller.signal }), { ok: false, error: 'call-cancelled' });
  assert.equal(count, 0);
});

test('真实 DSH 0.2.2 ToolRuntime 注册、执行 read_posts、渲染结果并注销', async (t) => {
  let host;
  try { host = await loadHostToolRuntime(); }
  catch (error) {
    if (/找不到 DSH asar/u.test(String(error?.message))) {
      t.skip('本机没有 DSH asar，跳过真实 ToolRuntime 契约测试');
      return;
    }
    throw error;
  }

  const { Context, Service, ToolRuntime, defineContentToolFixture } = host;
  class FakePrompt extends Service {
    constructor(ctx) { super(ctx, 'systemPrompt', true); }
    tools() { return { dispose() {} }; }
    section() { return { dispose() {} }; }
    getSectionOrder() { return 0; }
  }
  const ctx = new Context();
  ctx.plugin(FakePrompt);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const runtime = new ToolRuntime(ctx, { mode: 'native' });
  const dispatched = [];
  const registerReturns = [];
  const registration = await applyQzoneNativeTools({ tools: { register(tool) {
    const disposer = runtime.register(tool);
    registerReturns.push(typeof disposer);
    return disposer;
  } } }, {
    defineTool: defineContentToolFixture,
    dispatch: async (...args) => {
      dispatched.push(args);
      return { ok: true, posts: [{ tid: 'fixture-post' }] };
    },
  });

  assert.equal(registration.ok, true);
  assert.deepEqual(registerReturns, Array(6).fill('function'),
    'DSH ToolRuntime.register must return one disposer per registered tool');
  const tool = runtime.get('qzone_read_posts');
  assert.ok(tool, 'native read_posts must be present in ToolRuntime');
  const expected = QZONE_MCP_TOOLS.read_posts.inputSchema;
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.required, expected.required);
  assert.deepEqual(tool.parameters.properties.target_uin.oneOf.map(({ type }) => type), ['integer', 'string']);
  assert.ok(tool.parameters.required.includes('target_uin'));
  assert.ok(!tool.parameters.required.includes('pos'));
  assert.equal(tool.parameters.properties.pos.type, 'integer');
  assert.equal(tool.parameters.properties.num.type, 'integer');

  const callId = 'host-call-read-posts';
  const sessionId = 'host-session-read-posts';
  const result = await host.runTool(ctx, runtime, {
    name: 'qzone_read_posts',
    arguments: { target_uin: '12345', pos: 0, num: 5 },
    callId,
    signal: new AbortController().signal,
    agent: { id: 'host-fixture-agent', options: { provider: 'fixture', model: 'fixture' },
      session: { id: sessionId, requestHeader: () => ({ config: { provider: 'fixture', model: 'fixture' } }) } },
  });
  assert.deepEqual(dispatched, [['read_posts', { target_uin: '12345', pos: 0, num: 5 },
    { sessionId, callId }]]);
  assert.deepEqual(result.content, [{ type: 'text', text: '{"ok":true,"posts":[{"tid":"fixture-post"}]}' }]);

  registration.dispose();
  assert.equal(runtime.get('qzone_read_posts'), undefined, 'dispose must remove the DSH registration');
  assert.equal(runtime.get('qzone_like'), undefined, 'dispose must remove every Qzone native tool');
});
