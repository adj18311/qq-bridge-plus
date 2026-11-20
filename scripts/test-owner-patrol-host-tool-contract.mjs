import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { loadHostToolRuntime } from './host-tool-runtime-fixture.mjs';
import { resolveAgentKey } from '../plugins/xhh-quota-guard/decision.mjs';

const TOOL_NAME = 'mcp__xiaoheihe__get_home_content';
const SESSION_ID = 'fixture-shared-session';

test('出厂 principalOf：owner 与无调用上下文均无可区分的主体', async () => {
  const host = await loadHostToolRuntime();
  const protocolPath = path.join(host.cacheDir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-typert-protocol', 'lib', 'index.js');
  const { principalOf } = await import(pathToFileURL(protocolPath));
  assert.equal(principalOf({ peer: { principal: { kind: 'owner' } } }), undefined);
  assert.equal(principalOf(undefined), undefined);
  const syntheticNonOwner = { kind: 'fixture-non-owner' };
  assert.equal(principalOf({ peer: { principal: syntheticNonOwner } }), syntheticNonOwner);
  // 此处输入是测试构造，不证明 Host 支持该 principal 或 bridge 能获得它。
});

// patrol/ordinary 仅是测试提供的外部 arguments 标记；forgedPatrol 显示标记可由调用输入伪造。
// 本测试只覆盖 ToolRuntime 的 tools/execute 字段与插件 resolveAgentKey；不证明 Session 排队，
// 也不证明这些工具调用关联到某个真实 Host turn。
test('真实 ToolRuntime：同 fixture agent 的不同输入具有相同 resolver key', async (t) => {
  let host;
  try {
    host = await loadHostToolRuntime();
  } catch (error) {
    if (/找不到 DSH asar/u.test(String(error?.message))) {
      t.skip('本机没有 DSH asar，跳过真实 ToolRuntime 契约夹具');
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
  runtime.register(defineContentToolFixture({
    name: TOOL_NAME,
    description: '离线身份契约探针',
    parameters: {},
    async execute(args) {
      dispatched.push(args);
      return [{ type: 'text', text: 'fixture-ok' }];
    },
  }));

  const observed = [];
  ctx.on('tools/execute', async (exec, next) => {
    observed.push({
      name: exec.name,
      callId: exec.callId,
      arguments: structuredClone(exec.arguments),
      agentId: exec.agent?.id ?? null,
      sessionId: exec.agent?.session?.id ?? null,
      pluginAgentKey: resolveAgentKey(exec),
    });
    return next();
  }, { prepend: true });

  const agent = {
    id: 'fixture-agent-same-session',
    session: {
      id: SESSION_ID,
      requestHeader: () => ({ config: { provider: 'fixture-provider', model: 'fixture-model' } }),
    },
  };
  const inputs = [
    {
      label: 'patrol',
      callId: 'fixture-call-patrol-001',
      arguments: { fixtureMarker: 'patrol', forgedPatrol: true },
    },
    {
      label: 'ordinary',
      callId: 'fixture-call-ordinary-987',
      arguments: { fixtureMarker: 'ordinary', forgedPatrol: true },
    },
  ];

  for (const input of inputs) {
    await host.runTool(ctx, runtime, {
      name: TOOL_NAME,
      arguments: input.arguments,
      callId: input.callId,
      signal: new AbortController().signal,
      agent,
    });
  }

  assert.equal(observed.length, 2, '应观察到两次真实 tools/execute');
  assert.deepEqual(observed.map(({ name }) => name), [TOOL_NAME, TOOL_NAME]);
  assert.deepEqual(observed.map(({ sessionId }) => sessionId), [SESSION_ID, SESSION_ID]);
  assert.deepEqual(observed.map(({ callId }) => callId), inputs.map(({ callId }) => callId));
  assert.notEqual(observed[0].callId, observed[1].callId, '两个不同工具调用必须保留不同 callId');
  assert.deepEqual(observed.map(({ arguments: args }) => args), inputs.map(({ arguments: args }) => args));
  assert.deepEqual(observed.map(({ agentId }) => agentId), [agent.id, agent.id]);
  assert.deepEqual(observed.map(({ pluginAgentKey }) => pluginAgentKey), [agent.id, agent.id]);
  assert.deepEqual(dispatched, inputs.map(({ arguments: args }) => args));

  assert.deepEqual({
    sameSessionId: observed[0].sessionId === observed[1].sessionId,
    distinctCallIds: observed[0].callId !== observed[1].callId,
    sameResolvedPluginKey: observed[0].pluginAgentKey === observed[1].pluginAgentKey,
    markerValuesAreExternalInputs: observed.map(({ arguments: args }) => args.fixtureMarker),
    forgedMarkersAreVisibleInputs: observed.map(({ arguments: args }) => args.forgedPatrol),
  }, {
    sameSessionId: true,
    distinctCallIds: true,
    sameResolvedPluginKey: true,
    markerValuesAreExternalInputs: ['patrol', 'ordinary'],
    forgedMarkersAreVisibleInputs: [true, true],
  });
});
