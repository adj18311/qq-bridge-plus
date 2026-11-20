import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHostToolRuntime } from './host-tool-runtime-fixture.mjs';
import { getQzoneDshSessionContext } from '../plugins/qzone-safe/session-context.mjs';

test('DSH 0.2.2 原生工具运行链把执行上下文会话传给空间插件', async (t) => {
  let host;
  try { host = await loadHostToolRuntime(); }
  catch (error) {
    if (/找不到 DSH asar/u.test(String(error?.message))) {
      t.skip('本机没有 DSH asar，跳过宿主工具契约测试');
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
  const ctx = new Context(); ctx.plugin(FakePrompt);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const runtime = new ToolRuntime(ctx, { mode: 'native' });
  const seen = [];
  runtime.register(defineContentToolFixture({ name: 'qzone_session_probe', description: 'offline probe',
    parameters: {}, async execute(_args, exec) {
      seen.push(getQzoneDshSessionContext(exec));
      return [{ type: 'text', text: 'ok' }];
    } }));
  for (const [sessionId, callId] of [['session-a', 'call-a'], ['session-b', 'call-b']]) {
    await host.runTool(ctx, runtime, { name: 'qzone_session_probe', arguments: {}, callId,
      signal: new AbortController().signal,
      agent: { id: 'agent-fixture', options: { provider: 'fixture', model: 'fixture' },
        session: { id: sessionId, requestHeader: () => ({ config: { provider: 'fixture', model: 'fixture' } }) } } });
  }
  assert.deepEqual(seen, [{ sessionId: 'session-a', callId: 'call-a' }, { sessionId: 'session-b', callId: 'call-b' }]);
});
