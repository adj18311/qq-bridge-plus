import assert from 'node:assert/strict';
import test from 'node:test';
import { loadOfflineHostFixture } from './qzone-host-prestep-fixture.mjs';
import { createQzonePrestepAdapter } from '../plugins/qzone-safe/prestep-adapter.mjs';
import { createQzoneSessionObserver } from '../plugins/qzone-safe/session-observer.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

test('隔离 DSH 宿主 pre-step 可见本步消息；续步可能为空', async (t) => {
  let fixture;
  try { fixture = await loadOfflineHostFixture(); }
  catch (error) {
    if (/本机找不到 DSH app\.asar/u.test(error.message)) { t.skip(error.message); return; }
    throw error;
  }

  const { cordis, session, projection, agent, agentLoop, llm, tools, systemPrompt, nativeExecutor } = fixture;
  const root = new cordis.Context();
  let agentHandle;
  let disposeAdapter;
  let disposeTool;
  let disposeCordisPlugin;
  const gates = [];
  const preSteps = [];
  const calls = [];
  const bindings = [];
  let originAdapter;
  let originObserver;
  const toolName = 'qzone_offline_correlation_probe';
  const callIds = ['offline-call-a', 'offline-call-b', 'offline-call-c'];

  try {
    root.plugin(projection.SessionProjectionRegistry);
    root.plugin(session.SessionStore);
    root.plugin(agent.AgentRegistry);
    root.plugin(systemPrompt.SystemPrompt);
    root.plugin(llm.LlmRuntime);
    root.plugin(tools.ToolRuntime);
    root.plugin(nativeExecutor);
    root.plugin(agentLoop.AgentLoop);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const toolRuntime = root.get('tools');
    disposeTool = toolRuntime.register(tools.defineTool({
      name: toolName,
      description: 'Offline host correlation fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'offline-result'; },
    }));
    const modelCalls = [];
    class OfflineAdapter extends llm.LlmAdapter {
      providerInfo(provider) { return { id: provider, name: provider }; }
      resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }); }
      async *stream(options) {
        const index = modelCalls.length;
        modelCalls.push(options);
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
        const toolIndex = index === 3 ? 2 : index;
        if (index === 0 || index === 1 || index === 3) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callIds[toolIndex], name: toolName, arguments: '{}' } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: 'offline-done' };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'offline-done' } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
    }
    disposeAdapter = root.get('llm').registerAdapter(['offline'], new OfflineAdapter());

    // 插件注册在真实 Cordis 根 Context；其事件订阅必须通过宿主的 context 生命周期工作。
    const hostPreStepPlugin = (ctx) => ctx.on('agent/pre-step', (payload, next) => {
      preSteps.push({
        turn: payload.turn,
        step: payload.step,
        messages: payload.messages.map((message) => ({
          id: message.id,
          role: message.role,
          rpcId: message.source?.rpcId ?? null,
        })),
      });
      return next();
    });
    disposeCordisPlugin = root.plugin(hostPreStepPlugin);

    root.on('session/event', (hostSession, event) => {
      if (hostSession.id === 'qzone-offline-session' && event.type === 'tool/call') {
        calls.push({ turn: event.data.turn, step: event.data.step, callId: event.data.callId });
      }
    });
    const originLedger = createQzoneOriginLedger({ sessionId: 'qzone-offline-session', epoch: 'fixture-epoch' });
    for (const requestId of ['qzone-rpc-1', 'qzone-rpc-2a', 'qzone-rpc-2b', 'qzone-rpc-3']) {
      originLedger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
    }
    root.on('tools/execute', (exec, next) => {
      const hostCall = calls.find((call) => call.callId === exec.callId);
      bindings.push(hostCall ? originLedger.consume({ sessionId: 'qzone-offline-session',
        turn: hostCall.turn, step: hostCall.step, callId: hostCall.callId }) : null);
      return next();
    });
    agentHandle = await root.get('agents').create({
      sessionId: 'qzone-offline-session',
      agentOptions: { provider: 'offline', model: 'fixture' },
    });
    // R12-2: the two streams are observed by two modules. `agent/pre-step` is
    // agent-scoped (the adapter) and `session/event` is HOST-scoped, so it is observed
    // once per session by the observer — the adapter no longer accepts `eventContext`.
    originAdapter = createQzonePrestepAdapter({ agentContext: agentHandle.agent.ctx,
      ledger: originLedger, sessionId: 'qzone-offline-session' });
    originObserver = createQzoneSessionObserver({ eventContext: root,
      ledger: originLedger, sessionId: 'qzone-offline-session' });

    const inputs = [
      [{ text: 'turn one primary', rpcId: 'qzone-rpc-1' }],
      [
        { text: 'same step input A', rpcId: 'qzone-rpc-2a' },
        { text: 'same step input B', rpcId: 'qzone-rpc-2b' },
      ],
      [{ text: 'next turn input', rpcId: 'qzone-rpc-3' }],
    ];
    const makeMessage = ({ text, rpcId }) => llm.createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId },
    });
    for (const item of inputs[0]) agentHandle.agent.followup(makeMessage(item));
    await waitFor(() => modelCalls.length === 1, 'turn 1 step 1 model request');
    gates[0].resolve();
    await waitFor(() => modelCalls.length === 2, 'turn 1 continuation');

    // 两条 steer 在同一 continuation 边界混合投递，pre-step 应保留二者各自 ID/rpcId。
    for (const item of inputs[1]) agentHandle.agent.steer(makeMessage(item));
    gates[1].resolve();
    await waitFor(() => modelCalls.length === 3, 'turn 1 mixed-input next step');
    gates[2].resolve();
    await agentHandle.agent.whenIdle();

    agentHandle.agent.followup(makeMessage(inputs[2][0]));
    await waitFor(() => modelCalls.length === 4, 'turn 2 continuation');
    gates[3].resolve();
    await waitFor(() => modelCalls.length === 5, 'turn 2 tool continuation');
    gates[4].resolve();
    await agentHandle.agent.whenIdle();

    assert.deepEqual(calls.map(({ callId }) => callId), callIds);
    assert.equal(new Set(calls.map(({ turn, step, callId }) => `${turn}/${step}/${callId}`)).size, calls.length,
      '每个 tool/call 的 turn/step/callId 三元组均唯一');
    assert.deepEqual(calls.map(({ turn, step }) => [turn, step]), [[1, 1], [1, 2], [2, 1]]);
    assert.deepEqual(preSteps.map(({ turn, step, messages }) => ({
      turn, step, ids: messages.map(({ id }) => id), rpcIds: messages.map(({ rpcId }) => rpcId),
    })), [
      { turn: 1, step: 1, ids: [preSteps[0].messages[0].id], rpcIds: ['qzone-rpc-1'] },
      { turn: 1, step: 2, ids: [], rpcIds: [] },
      { turn: 1, step: 3, ids: preSteps[2].messages.map(({ id }) => id), rpcIds: ['qzone-rpc-2a', 'qzone-rpc-2b'] },
      { turn: 2, step: 1, ids: [preSteps[3].messages[0].id], rpcIds: ['qzone-rpc-3'] },
      { turn: 2, step: 2, ids: [], rpcIds: [] },
    ]);

    const correlated = calls.map((call) => {
      const step = preSteps.find(({ turn, step }) => turn === call.turn && step === call.step);
      assert.ok(step, `tool/call ${call.callId} 找到对应 pre-step`);
      return { ...call, messageIds: step.messages.map(({ id }) => id), rpcIds: step.messages.map(({ rpcId }) => rpcId) };
    });
    assert.deepEqual(correlated.map(({ rpcIds }) => rpcIds), [['qzone-rpc-1'], [], ['qzone-rpc-3']]);
    // ⚠️ CHANGED 2026-11-17 (t26/t27). Expected `['qzone-rpc-1', null, 'qzone-rpc-3']` before.
    //
    // Turn 1 step 2 is an empty continuation: its pre-step carries NO messages, so it introduces
    // no new source. The old rule bound only the CALLING STEP and therefore refused it. Measured
    // on a live QQ session, that is the normal case — a model that uses any tool before reaching
    // qzone always issues the qzone call on step 2+, so the feature could only ever answer
    // `origin-unbound`.
    //
    // The source is now TURN-scoped: step 2 inherits turn 1's single source (qzone-rpc-1). That
    // is not a widening of single-use — `consume` still retires each callId exactly once, so one
    // QQ request yields one binding per tool call, which is what multi-call turns already did
    // inside the claiming step. Still refused: mixed sources, no source, a step earlier than the
    // citing step, and any replay after the turn closed.
    assert.deepEqual(bindings.map((binding) => binding?.requestId ?? null),
      ['qzone-rpc-1', 'qzone-rpc-1', 'qzone-rpc-3']);
    t.diagnostic(JSON.stringify({ archive: fixture.archive, evidence: '本机 app.asar 导出的 Cordis/AgentLoop/ToolRuntime；无模型网络、无 QQ 调用', preSteps, toolCalls: correlated }));
  } finally {
    for (const gate of gates) gate.resolve();
    try { originAdapter?.dispose(); } catch {}
    try { originObserver?.dispose(); } catch {}
    try { disposeCordisPlugin?.(); } catch {}
    try { await agentHandle?.dispose?.(); } catch {}
    try { disposeTool?.(); } catch {}
    try { disposeAdapter?.(); } catch {}
    try { await root.dispose?.(); } catch {}
    fixture.close();
  }
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待 ${label} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
