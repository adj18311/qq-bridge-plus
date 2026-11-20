import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { once } from 'node:events';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createBackgroundPatrolBridgeHook } from '../src/core/background-patrol-bridge-hook.mjs';
import { postJson } from './test-port-safe.mjs';
import { createOriginPrototype } from './owner-patrol-origin-prototype.mjs';
import { createBindingPrototype } from './owner-patrol-binding-prototype.mjs';
import { createOfflineHostEventCoordinator } from './owner-session-patrol-host-events-prototype.mjs';
import { createExternalEventExperiment } from './owner-patrol-external-events-prototype.mjs';

const DEFAULT_ASAR = 'D:/DSH Desktop/resources/app.asar';
const INITIAL_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-tool-executor-native',
];

test('出厂 AgentLoop：followup 进入 next-turn，steer 进入当前 turn 的 next-step', async (t) => {
  const archive = process.env.DSH_ASAR ?? DEFAULT_ASAR;
  if (!fs.existsSync(archive)) {
    t.skip(`本机找不到 DSH app.asar：${archive}`);
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-session-contract-'));
  let ctx;
  let agentHandle;
  let disposeEvents;
  let disposePreStep;
  let disposeToolHook;
  let disposeAdapter;
  let disposeToolRegistration;
  let disposeShareToolRegistration;
  let authorizationHook;
  let offlineBridge;
  let offlineBridgeServer;
  let offlineBridgeToken;
  const gates = [];
  try {
    extractDependencyGraph(archive, tempRoot, INITIAL_PACKAGES);
    const module = (name) => path.join(tempRoot, 'dsh', 'node_modules', ...name.split('/'), 'lib', 'index.js');
    const [cordis, session, projection, agent, agentLoop, llm, tools, systemPrompt, sessionController, nativeExecutor] = await Promise.all([
      import(pathToFileURL(module('@deepseek-ai/cordis'))),
      import(pathToFileURL(module('@deepseek-ai/dsh-session'))),
      import(pathToFileURL(module('@deepseek-ai/dsh-session-projection'))),
      import(pathToFileURL(module('@deepseek-ai/dsh-agent'))),
      import(pathToFileURL(module('@deepseek-ai/dsh-agent-loop'))),
      import(pathToFileURL(module('@deepseek-ai/dsh-llm'))),
      import(pathToFileURL(module('@deepseek-ai/dsh-tools'))),
      import(pathToFileURL(module('@deepseek-ai/dsh-system-prompt'))),
      import(pathToFileURL(module('@deepseek-ai/dsh-api-session-controller'))),
      import(pathToFileURL(module('@deepseek-ai/dsh-tool-executor-native'))),
    ]);

    // 直接调用出厂方法并用离线替身接收入队参数；不连接运行中的 Host。
    const admitted = [];
    const receiver = { ctx: { invocation: undefined }, commands: { prompt: (request, source) => { admitted.push(source); return { accepted: true }; } } };
    for (const requestId of ['fixture-admin-a', 'fixture-other-b']) {
      await sessionController.SessionController.prototype.prompt.call(receiver, {
        sessionId: 'fixture-session', requestId,
        content: [{ type: 'text', text: 'offline request' }],
        source: { kind: 'owner', principal: 'owner' }, admin: true,
      }, new AbortController().signal);
    }
    assert.deepEqual(admitted.map(({ kind, principal }) => ({ kind, principal })), [
      { kind: 'user', principal: undefined }, { kind: 'user', principal: undefined },
    ], '入参伪造的管理员字段不得成为宿主生成的来源主体');
    assert.deepEqual(admitted.map(({ rpcId }) => rpcId), ['fixture-admin-a', 'fixture-other-b']);

    ctx = new cordis.Context();
    ctx.plugin(projection.SessionProjectionRegistry);
    ctx.plugin(session.SessionStore);
    ctx.plugin(agent.AgentRegistry);
    ctx.plugin(systemPrompt.SystemPrompt);
    ctx.plugin(llm.LlmRuntime);
    ctx.plugin(tools.ToolRuntime);
    ctx.plugin(nativeExecutor);
    ctx.plugin(agentLoop.AgentLoop);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const llmRuntime = ctx.get('llm');
    const modelCalls = [];
    const toolName = 'mcp__xiaoheihe__publish_content'; // 名字仿真，execute 始终是假工具
    const toolCallId = 'fixture-tool-call-001';
    const scheduledToolCallId = 'fixture-scheduled-tool-call-002';
    const ordering = [];
    const toolExecutions = [];
    const resolvedHostIdentities = [];
    const toolRuntime = ctx.get('tools');
    disposeToolRegistration = toolRuntime.register(tools.defineTool({
      name: toolName,
      description: 'Offline AgentLoop correlation fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'fixture-tool-result'; },
    }));
    const fakeShares = [];
    const fakeGatewayCalls = [];
    const shareToolName = 'qq_send_message';
    const shareCallId = 'fixture-offline-qq-send-003';
    disposeShareToolRegistration = toolRuntime.register(tools.defineTool({
      name: shareToolName,
      description: 'Offline fake QQ sender; does not call any service',
      parameters: { text: { type: 'string', description: 'offline text', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) {
        const response = await postJson(`http://127.0.0.1:${offlineBridgeServer.address().port}/api/socialV2/send-message`,
          { key: 'private:123', messages: [args.text] },
          { 'x-console-token': 'fixture-console-token', 'x-agent-token': offlineBridgeToken, 'x-agent-call': '1' });
        const result = await response.json();
        assert.equal(response.status, 200, `offline bridge refused send: ${JSON.stringify(result)}`);
        assert.equal(result.sent, 1);
        fakeShares.push(args.text);
        return 'offline-fake-qq-sent';
      },
    }));
    class OfflineAdapter extends llm.LlmAdapter {
      providerInfo(provider) { return { id: provider, name: provider }; }
      resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }); }
      async *stream(options) {
        const call = modelCalls.length;
        modelCalls.push(options);
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
        if (call === 7) throw new Error('offline simulated adapter failure');
        if (call === 0 || call === 4 || call === 10 || call === 13) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'block-end', index: 0, block: call === 10 || call === 13
            ? { type: 'tool-call', id: call === 10 ? shareCallId : 'fixture-after-owner-arrival', name: shareToolName, arguments: JSON.stringify({ text: call === 10 ? '离线自然分享' : '反例：未自动停发' }) }
            : { type: 'tool-call', id: call === 0 ? toolCallId : scheduledToolCallId, name: toolName, arguments: '{}' } };
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: `offline-response-${call}` };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `offline-response-${call}` } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    disposeAdapter = llmRuntime.registerAdapter(['fixture-provider'], new OfflineAdapter());

    offlineBridge = await bridgeHarness({
      config: { socialV2: { enabled: true }, backgroundPatrol: { enabled: true, platforms: { tieba: true } } },
      globals: { __backgroundPatrolForceStart: false, fetch: async (url, options) => {
        fakeGatewayCalls.push({ url: String(url), body: String(options?.body ?? '') });
        return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
      } },
    });
    offlineBridge.setMode('reserved2'); offlineBridge.socialV2.paused = false;
    // 使用真实桥接 ensureSession 返回的映射创建隔离宿主会话。
    const hostSessionId = await offlineBridge.ensureSession('private:123');
    // 旧后台身份门槛在此仍由夹具提供；真实生命周期未在此启动。
    offlineBridge.state.sessions['patrol:background'] = 'fixture-idle-background';
    offlineBridgeToken = offlineBridge.getSocialV2State('private:123').agentToken;
    offlineBridgeServer = offlineBridge.startConsoleServer();
    if (!offlineBridgeServer.listening) await once(offlineBridgeServer, 'listening');
    const offlineCoordinator = createOfflineHostEventCoordinator();
    const offlineStream = offlineCoordinator.createStream();
    const originPrototype = createOriginPrototype({ sessionId: hostSessionId, epoch: 'fixture-process-only' });
    const bindingPrototype = createBindingPrototype({ sessionId: hostSessionId, epoch: 'fixture-process-only' });
    const fixtureToken = 'offline-contract-token-0123456789abcdef';
    const sessions = { 'private:123456789': hostSessionId };
    const fixtureState = path.join(tempRoot, 'controller.json');
    fs.writeFileSync(fixtureState, JSON.stringify({
      schemaVersion: 1, day: '2026-10-27', lastSeenAt: Date.now(), readCount: 0,
      buckets: { post: { count: 0, lastActionAt: null }, comment: { count: 0, lastActionAt: null } },
      operations: {}, consecutiveWriteFailures: 0, writePaused: false, writeReason: null,
      accessPaused: false, accessReason: null, transitionEvents: [], transitionEventOverflow: 0,
    }));
    authorizationHook = createBackgroundPatrolBridgeHook({
      config: { backgroundPatrol: { enabled: true, platforms: { tieba: true, xiaoheihe: true }, groupExempt: true } },
      consoleToken: fixtureToken, controllerStorePath: fixtureState, ownerQQ: 123456789,
      sessions, sessionsProvider: () => sessions, backgroundSessionId: 'offline-separate-patrol',
      port: 0, logger: { warn() {}, error() {} },
    });
    const hookStarted = await authorizationHook.start();
    assert.equal(hookStarted.ok, true);
    await authorizationHook.reconcile({ enqueue: async () => ({ ok: true, id: 'seen', duplicate: true }), isDelivered: async () => ({ ok: true, delivered: true }) });
    const scheduledAuthorizations = [];
    const ownerBindings = [];
    agentHandle = await ctx.get('agents').create({ sessionId: hostSessionId, agentOptions: { provider: 'fixture-provider', model: 'fixture-model' } });
    const liveAgent = agentHandle.agent;
    const events = [];
    const claimedAtPreStep = [];
    const sourceKindsAtPreStep = [];
    let scheduledMessage;
    let sameScheduledObject = false;
    let claimedScheduledId;
    // 离线模型：模拟受信任的宿主内入口持有私有登记表；不是生产凭据实现。
    const registeredHostMessages = new Map();
    const turnOrigins = new Map();
    const callOrigins = new Map();
    // 模拟宿主内入口：创建并登记消息后同步投递；登记只存在测试进程内。
    // 这不是可供 bridge 调用的已认证入口，也不是生产实现。
    function enqueueTrustedPatrol(agent, text) {
      const message = llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'schedule', form: 'notice' } });
      registeredHostMessages.set(message.id, 'patrol');
      assert.equal(offlineCoordinator.begin({ sessionId: hostSessionId, messageId: message.id }), true);
      originPrototype.register(message.id, 'patrol');
      bindingPrototype.register(message, 'patrol');
      try { agent.followup(message); } catch (error) { registeredHostMessages.delete(message.id); throw error; }
      return message;
    }
    disposeEvents = ctx.on('session/event', (seenSession, event) => {
      if (seenSession.id === hostSessionId) {
        events.push(structuredClone(event));
        offlineStream.hostEvent({ sessionId: seenSession.id, event });
        if (event.type === 'turn/end') {
          originPrototype.end({ sessionId: seenSession.id, turn: event.data.turn });
          bindingPrototype.end({ sessionId: seenSession.id, turn: event.data.turn });
        }
        if (event.type === 'tool/call' || event.type === 'tool/result') {
          ordering.push({ kind: event.type, callId: event.data.callId ?? event.data.message?.source?.callId });
        }
        if (event.type === 'tool/call') {
          callOrigins.set(event.data.callId, turnOrigins.get(event.data.turn) ?? 'unknown');
          originPrototype.call({ sessionId: seenSession.id, turn: event.data.turn, step: event.data.step, callId: event.data.callId });
        }
      }
    });
    disposePreStep = liveAgent.ctx.on('agent/pre-step', (payload, next) => {
      offlineStream.hostStep({ sessionId: hostSessionId, turn: payload.turn, messages: payload.messages });
      originPrototype.step({ sessionId: hostSessionId, turn: payload.turn, step: payload.step, messages: payload.messages.map((message) => message.id) });
      bindingPrototype.step({ sessionId: hostSessionId, turn: payload.turn, step: payload.step, messages: payload.messages });
      if (payload.messages.some((message) => message === scheduledMessage)) sameScheduledObject = true;
      const scheduledClaim = payload.messages.find((message) => message.source?.kind === 'schedule');
      if (scheduledClaim) claimedScheduledId = scheduledClaim.id;
      if (payload.messages.length > 0) {
        const origins = new Set(payload.messages.map((message) => registeredHostMessages.get(message.id) ?? 'unknown'));
        const previous = turnOrigins.get(payload.turn);
        const proposed = origins.size === 1 ? [...origins][0] : 'unknown';
        turnOrigins.set(payload.turn, previous === undefined ? proposed : previous === proposed ? previous : 'unknown');
      }
      sourceKindsAtPreStep.push({ turn: payload.turn, step: payload.step, kinds: payload.messages.map((message) => message.source?.kind ?? null) });
      claimedAtPreStep.push({
        turn: payload.turn,
        step: payload.step,
        rpcIds: payload.messages
          .filter((message) => message.role === 'user' && message.source?.kind === 'user')
          .map((message) => message.source.rpcId ?? null),
      });
      return next();
    });
    disposeToolHook = ctx.on('tools/execute', async (exec, next) => {
      resolvedHostIdentities.push({ agentId: exec.agent?.id ?? null, sessionId: exec.agent?.session?.id ?? null });
      toolExecutions.push({ name: exec.name, callId: exec.callId, sessionId: exec.agent?.session?.id ?? null });
      ordering.push({ kind: 'tools/execute', callId: exec.callId });
      if (exec.callId === toolCallId) {
        const hostCall = events.find((event) => event.type === 'tool/call' && event.data.callId === exec.callId);
        const boundCall = { sessionId: exec.agent.session.id, turn: hostCall?.data.turn, step: hostCall?.data.step, callId: exec.callId, tool: exec.name, args: exec.arguments };
        bindingPrototype.call(boundCall);
        ownerBindings.push(bindingPrototype.authorize(boundCall));
      }
      if (exec.callId === scheduledToolCallId) {
        const hostCall = events.find((event) => event.type === 'tool/call' && event.data.callId === exec.callId);
        const hostStep = sourceKindsAtPreStep.find((step) => step.turn === hostCall?.data.turn && step.step === hostCall?.data.step);
        const boundCall = { sessionId: exec.agent.session.id, turn: hostCall?.data.turn, step: hostCall?.data.step, callId: exec.callId, tool: exec.name, args: exec.arguments };
        bindingPrototype.call(boundCall);
        const response = await postJson(`${hookStarted.url}/api/xiaoheihe/authorize`, {
          agentKey: exec.agent.session.id, tool: 'mcp__xiaoheihe__interactive_login',
          source: hostStep?.kinds[0], // 对照实验：HTTP 字段不具备可信身份，当前门禁也不采用它。
        }, { 'x-console-token': fixtureToken });
        scheduledAuthorizations.push({ kinds: hostStep?.kinds, correlatedOrigin: callOrigins.get(exec.callId), prototypeOrigin: originPrototype.lookup({ sessionId: hostSessionId, callId: exec.callId }), bindingDecision: bindingPrototype.authorize(boundCall), outcome: await response.json() });
      }
      return next();
    }, { prepend: true });

    const firstRequestId = 'fixture-followup-1';
    const firstOwnerMessage = llm.createUserMessage({
      content: [{ type: 'text', text: 'start first turn' }],
      source: { kind: 'user', rpcId: firstRequestId },
    });
    // 测试假定可信入口先认证并登记；不表示真实 DSH 提供该入口。
    registeredHostMessages.set(firstOwnerMessage.id, 'owner');
    originPrototype.register(firstOwnerMessage.id, 'owner');
    bindingPrototype.register(firstOwnerMessage, 'owner');
    liveAgent.followup(firstOwnerMessage);
    await waitFor(() => modelCalls.length === 1, 'first model call');
    gates[0].resolve();
    await waitFor(() => toolExecutions.length === 1, 'tools/execute for generated tool-call');
    await waitFor(() => modelCalls.length === 2, 'model continuation after tool result');

    const steerRequestId = 'fixture-steer-2';
    liveAgent.steer(llm.createUserMessage({
      content: [{ type: 'text', text: 'steer within current turn' }],
      source: { kind: 'user', rpcId: steerRequestId },
    }));
    const secondSteerRequestId = 'fixture-steer-unknown';
    liveAgent.steer(llm.createUserMessage({
      content: [{ type: 'text', text: 'another source within the same step' }],
      source: { kind: 'schedule', rpcId: secondSteerRequestId }, // 伪造标签但未登记
    }));
    gates[1].resolve();
    await waitFor(() => modelCalls.length === 3, 'steered next-step model call');

    const followupRequestId = 'fixture-followup-3';
    liveAgent.followup(llm.createUserMessage({
      content: [{ type: 'text', text: 'queue a distinct next turn' }],
      source: { kind: 'user', rpcId: followupRequestId },
    }));
    gates[2].resolve();
    await waitFor(() => modelCalls.length === 4, 'queued next-turn model call');
    gates[3].resolve();
    await liveAgent.whenIdle();

    // 假设宿主内可信插件发起定时机会：真实 AgentLoop 的入队接口，来源由夹具构造。
    // 这只验证宿主事件能否携带 schedule 标签，不证明桥接入站认证或防伪。
    scheduledMessage = enqueueTrustedPatrol(liveAgent, 'offline scheduled patrol opportunity');
    await waitFor(() => modelCalls.length === 5, 'scheduled patrol in existing session');
    // 测试直接模拟来信交接，不代表真实桥接已接上 coordinator。
    offlineCoordinator.ownerMessage({ sessionId: hostSessionId, messageId: 'fixture-unverified-steer' });
    liveAgent.steer(llm.createUserMessage({
      content: [{ type: 'text', text: 'unverified concurrent input' }],
      source: { kind: 'user', rpcId: 'fixture-unverified-steer' },
    }));
    gates[4].resolve();
    await waitFor(() => toolExecutions.length === 2, 'scheduled patrol tool execution');
    await waitFor(() => modelCalls.length === 6, 'scheduled tool continuation');
    gates[5].resolve();
    await liveAgent.whenIdle();
    const offlineOutcome = offlineCoordinator.decisions[0];
    assert.equal(offlineOutcome.share, false, '巡逻期间有来信时，样品不批准自主分享');
    assert.deepEqual(offlineOutcome.ownerMessages, ['fixture-unverified-steer']);
    liveAgent.followup(llm.createUserMessage({
      content: [{ type: 'text', text: 'owner followup after patrol' }],
      source: { kind: 'user', rpcId: 'fixture-owner-after-patrol' },
    }));
    await waitFor(() => modelCalls.length === 7, 'owner followup after scheduled patrol');
    gates[6].resolve();
    await liveAgent.whenIdle();

    const accepted = events.filter((event) => event.type === 'user/message');
    const external = createExternalEventExperiment();
    assert.equal(external.begin({ sessionId: hostSessionId, requestId: firstRequestId }), true);
    for (const event of events) external.accept({ sessionId: hostSessionId, event });
    assert.deepEqual(external.results, [{ turn: 1, share: false }],
      '仅依靠捕获的完整 live 帧及模拟 requestId 关联同一回合；混入其它消息不得主动分享');
    t.diagnostic(`offline-inbox-events=${JSON.stringify(events.filter((event) => event.type.startsWith('agent/inbox')).map(({ type, seq, data }) => ({ type, seq, data })))}`);
    t.diagnostic(`offline-host-timeline=${JSON.stringify(events.filter((event) => ['agent/inbox/spliced', 'turn/start', 'step/start', 'turn/end', 'user/message'].includes(event.type)).map(({ type, seq, data }) => ({ type, seq, turn: data.turn, target: data.target, start: data.start, removedCount: data.removedCount, inserted: data.inserted?.map(m => m.id), id: data.id, outcome: data.outcome })))}`);
    t.diagnostic(`offline-scheduled-user-event=${JSON.stringify(accepted.find((event) => event.data?.id === scheduledMessage.id)?.data)}`);
    const turns = events.filter((event) => event.type === 'turn/start');
    t.diagnostic(`offline-turn-end-data=${JSON.stringify(events.filter((event) => event.type === 'turn/end').map((event) => event.data))}`);
    const steps = events.filter((event) => event.type === 'step/start');
    assert.deepEqual(accepted.map((event) => event.data.source.rpcId), [firstRequestId, steerRequestId, secondSteerRequestId, followupRequestId, undefined, 'fixture-unverified-steer', 'fixture-owner-after-patrol']);
    assert.deepEqual(turns.map((event) => event.data.turn), [1, 2, 3, 4]);
    assert.deepEqual(steps.map(({ data }) => [data.turn, data.step]), [[1, 1], [1, 2], [1, 3], [2, 1], [3, 1], [3, 2], [4, 1]]);
    assert.ok(accepted.every((event) => event.data.turn === undefined), 'user/message does not itself carry a turn field');
    const lastUserSource = (call) => call.messages.filter((message) => message.role === 'user').at(-1)?.source?.rpcId;
    assert.deepEqual(modelCalls.map(lastUserSource), [firstRequestId, firstRequestId, secondSteerRequestId, followupRequestId, undefined, 'fixture-unverified-steer', 'fixture-owner-after-patrol']);
    assert.deepEqual(claimedAtPreStep, [
      { turn: 1, step: 1, rpcIds: [firstRequestId] },
      { turn: 1, step: 2, rpcIds: [] },
      { turn: 1, step: 3, rpcIds: [steerRequestId] },
      { turn: 2, step: 1, rpcIds: [followupRequestId] },
      { turn: 3, step: 1, rpcIds: [] },
      { turn: 3, step: 2, rpcIds: ['fixture-unverified-steer'] },
      { turn: 4, step: 1, rpcIds: ['fixture-owner-after-patrol'] },
    ]);
    assert.deepEqual(sourceKindsAtPreStep.slice(-3), [
      { turn: 3, step: 1, kinds: ['schedule'] },
      { turn: 3, step: 2, kinds: ['user'] },
      { turn: 4, step: 1, kinds: ['user'] },
    ]);
    assert.equal(sameScheduledObject, false, '宿主会复制消息，不能依赖内存对象身份');
    assert.equal(claimedScheduledId, scheduledMessage.id, '消息标识在此条离线链路中保留；它不是身份凭据');
    assert.ok(modelCalls[4].messages.some((message) => message.role === 'user'
      && message.source?.rpcId === firstRequestId),
    '定时机会应读取同一 session 已有的管理员对话历史');
    assert.ok(modelCalls[6].messages.some((message) => message.role === 'user'
      && message.source?.kind === 'schedule'
      && message.content?.some((block) => block.text === 'offline scheduled patrol opportunity')),
    '管理员后续回合应看到同会话中的巡逻机会');
    assert.ok(modelCalls[6].messages.some((message) => message.role === 'assistant'
      && message.content?.some((block) => block.text === 'offline-response-5')),
    '管理员后续回合应看到定时机会中模型生成的内容');
    assert.ok(modelCalls[6].messages.some((message) => message.role === 'assistant'
      && message.content?.some((block) => block.type === 'tool-call' && block.id === scheduledToolCallId)),
    '管理员后续回合应看到定时回合里的实际工具调用');
    assert.ok(modelCalls[6].messages.some((message) => message.role === 'tool'
      && message.source?.callId === scheduledToolCallId),
    '管理员后续回合应看到同一工具调用的结果，而不仅仅是桥接追加的文本');
    const toolCallEvent = events.find((event) => event.type === 'tool/call');
    const toolResultEvent = events.find((event) => event.type === 'tool/result');
    assert.ok(toolCallEvent, 'fake model tool-call must produce a session tool/call event');
    assert.equal(toolCallEvent.data.callId, toolCallId);
    assert.deepEqual([toolCallEvent.data.turn, toolCallEvent.data.step], [1, 1]);
    assert.deepEqual(toolExecutions, [
      { name: toolName, callId: toolCallId, sessionId: hostSessionId },
      { name: toolName, callId: scheduledToolCallId, sessionId: hostSessionId },
    ]);
    assert.equal(toolResultEvent?.data.message?.source?.callId, toolCallId);
    assert.deepEqual(ordering.map(({ kind }) => kind), ['tool/call', 'tools/execute', 'tool/result', 'tool/call', 'tools/execute', 'tool/result']);
    assert.ok(ordering.slice(0, 3).every(({ callId }) => callId === toolCallId));
    assert.ok(ordering.slice(3).every(({ callId }) => callId === scheduledToolCallId));
    const scheduledEvent = events.find((event) => event.type === 'tool/call' && event.data.callId === scheduledToolCallId);
    assert.deepEqual([scheduledEvent?.data.turn, scheduledEvent?.data.step], [3, 1]);
    assert.deepEqual(scheduledAuthorizations.map(({ kinds }) => kinds), [['schedule']]);
    assert.equal(scheduledAuthorizations[0].correlatedOrigin, 'patrol',
      '仅在夹具预先模拟可信入口登记的前提下，消息 ID → 回合 → callId 关联为巡逻');
    assert.equal(scheduledAuthorizations[0].prototypeOrigin, 'patrol', '样品应关联真实宿主工具调用');
    assert.equal(scheduledAuthorizations[0].bindingDecision, 'quota', '样品应按真实宿主执行名与参数分类，但不代表真正签票');
    assert.deepEqual(ownerBindings, ['existing'], '模拟可信登记的管理员调用应进入管理员既有路径');
    assert.equal(originPrototype.lookup({ sessionId: hostSessionId, callId: scheduledToolCallId }), 'unknown',
      '后续混入未经登记输入后不得再以旧调用 ID 签发新授权');
    assert.equal(callOrigins.get(toolCallId), 'owner', '仅夹具事先可信登记的管理员消息可关联 owner');
    assert.deepEqual(sourceKindsAtPreStep.find((entry) => entry.turn === 1 && entry.step === 3).kinds, ['user', 'schedule']);
    assert.equal(turnOrigins.get(1), 'unknown', '伪造 schedule 标签不应变成已登记的巡逻');
    assert.equal(turnOrigins.get(3), 'unknown', '定时回合混入未登记输入后必须降为 unknown');
    assert.equal(scheduledAuthorizations[0].outcome.decision, 'allow',
      '当前真实门禁只看到 sessionId，不能据此阻止定时巡逻请求登录；仅运行假工具');
    const laterMessages = modelCalls[3].messages;
    assert.ok(laterMessages.some((message) => message.role === 'assistant'
      && message.content?.some((block) => block.type === 'tool-call' && block.id === toolCallId)),
    '同一宿主 session 的后续回合应包含之前的工具调用');
    assert.ok(laterMessages.some((message) => message.role === 'tool'
      && message.source?.callId === toolCallId
      && message.content?.some((block) => block.type === 'text' && block.text === 'fixture-tool-result')),
    '同一宿主 session 的后续回合应包含之前的工具结果');

    // 真实 AgentLoop 生成失败和取消的事件；模型与输入仍均为离线替身。
    enqueueTrustedPatrol(liveAgent, 'offline failure opportunity');
    await waitFor(() => modelCalls.length === 8, 'failure model call');
    gates[7].resolve();
    await waitFor(() => events.some(e => e.type === 'turn/end' && e.data.turn === 5), 'failed turn end');
    assert.equal(events.find(e => e.type === 'turn/end' && e.data.turn === 5).data.reason.kind, 'error');
    assert.equal(offlineCoordinator.decisions.length, 1, '失败的巡逻不得新产生分享许可');
    await liveAgent.whenIdle();

    enqueueTrustedPatrol(liveAgent, 'offline cancellation opportunity');
    await waitFor(() => modelCalls.length === 9, 'cancellation model call');
    liveAgent.cancel({ code: 'offline-cancel', message: 'fixture cancellation' });
    gates[8].resolve();
    await waitFor(() => events.some(e => e.type === 'turn/end' && e.data.turn === 6), 'cancelled turn end');
    t.diagnostic(`offline-cancel-turn-end=${JSON.stringify(events.find(e => e.type === 'turn/end' && e.data.turn === 6).data)}`);
    assert.equal(events.find(e => e.type === 'turn/end' && e.data.turn === 6).data.reason, null,
      '此夹具中的取消实测返回 null；其他取消路径可能不同');
    assert.equal(offlineCoordinator.decisions.length, 1, '取消的巡逻不得新产生分享许可');
    await liveAgent.whenIdle();

    // 真实宿主的 idle 等待仅证明当下；随后仍可立即接受下一轮，不能当作准入锁。
    liveAgent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'new work after idle' }], source: { kind: 'user', rpcId: 'fixture-after-idle' } }));
    await waitFor(() => modelCalls.length === 10, 'new work admitted immediately after idle');
    assert.ok(events.some(e => e.type === 'turn/start' && e.data.turn === 7));
    gates[9].resolve();
    await liveAgent.whenIdle();

    // 把桥接测试桩的 prompt 代理到同一隔离 Agent；此适配器不是生产 DSH RPC。
    const deliveredPrompts = [];
    offlineBridge.api.sessions.prompt = async ({ sessionId, content, mode }) => {
      deliveredPrompts.push({ sessionId, content, mode });
      assert.equal(sessionId, hostSessionId);
      liveAgent.followup(llm.createUserMessage({ content, source: { kind: 'user', rpcId: 'fixture-bridge-opportunity' } }));
      return { result: { ok: true, value: {} } };
    };
    const delivered = await offlineBridge.dispatchBackgroundPatrolOpportunity('tieba', {});
    assert.equal(delivered.ok, true);
    assert.equal(delivered.sessionId, hostSessionId);
    assert.equal(deliveredPrompts.length, 1);
    await waitFor(() => modelCalls.length === 11, 'scheduled sharing model call');
    gates[10].resolve();
    await waitFor(() => modelCalls.length === 12, 'model continuation after fake QQ tool');
    assert.deepEqual(fakeShares, ['离线自然分享']);
    assert.ok(resolvedHostIdentities.every(({ agentId, sessionId }) => agentId === null || agentId === sessionId),
      '小黑盒现有插件优先使用 agent.id；若它与映射使用的 session.id 不同，不能声称共享会话额度门禁已接通');
    assert.equal(fakeGatewayCalls.length, 1, '真实桥接应调用一次假的 QQ 网关');
    assert.match(fakeGatewayCalls[0].body, /离线自然分享/u);
    assert.ok(offlineBridge.getSocialV2State('private:123').recentMessages.some(m => m.isSelf && String(m.text ?? m.plain ?? '').includes('离线自然分享')), '真实桥接处理假网关后应记录自身消息');
    gates[11].resolve();
    await liveAgent.whenIdle();
    liveAgent.followup(llm.createUserMessage({ content: [{ type: 'text', text: '你刚才说了什么？' }], source: { kind: 'user', rpcId: 'fixture-owner-after-share' } }));
    await waitFor(() => modelCalls.length === 13, 'owner model call after sharing');
    const afterShare = modelCalls[12].messages;
    assert.ok(afterShare.some(m => m.role === 'assistant' && m.content?.some(b => b.type === 'tool-call' && b.id === shareCallId && b.name === shareToolName && b.arguments.includes('离线自然分享'))), '后续会话保留假发送工具调用和分享内容');
    assert.ok(afterShare.some(m => m.role === 'tool' && m.source?.callId === shareCallId && m.content?.some(b => b.text === 'offline-fake-qq-sent')), '后续会话保留假发送结果');
    gates[12].resolve();
    await liveAgent.whenIdle();

    // 模拟生成过程中管理员来信；故意让假模型仍给出分享工具调用，验证宿主是否自动阻止。
    const beforeRace = await offlineBridge.deliverPrompt('private:123', 'offline owner-arrival race', { backgroundPatrol: true });
    assert.equal(beforeRace.sessionId, hostSessionId);
    await waitFor(() => modelCalls.length === 14, 'race model call');
    liveAgent.steer(llm.createUserMessage({ content: [{ type: 'text', text: '管理员先来信' }], source: { kind: 'user', rpcId: 'fixture-owner-during-race' } }));
    gates[13].resolve();
    await waitFor(() => modelCalls.length === 15, 'race continuation after fake QQ tool');
    assert.deepEqual(fakeShares, ['离线自然分享', '反例：未自动停发'], '反例：单凭宿主收到新输入不能自动阻止已生成的发送调用');
    assert.equal(fakeGatewayCalls.length, 2, '反例只调用离线假网关');
    gates[14].resolve();
    await liveAgent.whenIdle();

    liveAgent.followup(llm.createUserMessage({ content: [{ type: 'text', text: '继续刚才的聊天' }], source: { kind: 'user', rpcId: 'fixture-after-race' } }));
    await waitFor(() => modelCalls.length === 16, 'owner followup after race');
    const afterRace = modelCalls[15].messages;
    for (const id of [shareCallId, 'fixture-after-owner-arrival']) {
      assert.ok(afterRace.some(m => m.role === 'assistant' && m.content?.some(b => b.type === 'tool-call' && b.id === id)), `后续对话缺少分享调用 ${id}`);
      assert.ok(afterRace.some(m => m.role === 'tool' && m.source?.callId === id && m.content?.some(b => b.text === 'offline-fake-qq-sent')), `后续对话缺少分享结果 ${id}`);
    }
    assert.ok(afterRace.some(m => m.role === 'user' && m.source?.rpcId === 'fixture-owner-during-race'), '并发来信应留在同一会话历史');
    gates[15].resolve();
    await liveAgent.whenIdle();

    t.diagnostic(JSON.stringify({
      evidence: 'real exported AgentLoop + SessionStore + SessionProjectionRegistry from the local app.asar',
      sessionId: hostSessionId,
      userMessages: accepted.map((event) => ({ seq: event.seq, rpcId: event.data.source.rpcId })),
      turns: turns.map((event) => ({ seq: event.seq, turn: event.data.turn })),
      steps: steps.map((event) => ({ seq: event.seq, turn: event.data.turn, step: event.data.step })),
      claimsAtPreStep: claimedAtPreStep,
      modelInputs: modelCalls.map(({ messages }) => messages?.map((message) => ({
        role: message.role,
        source: message.source,
        content: message.content,
      })) ?? null),
      modelCalls: modelCalls.length,
      toolCall: { callId: toolCallEvent.data.callId, turn: toolCallEvent.data.turn, step: toolCallEvent.data.step },
      toolExecutions,
      toolOrdering: ordering,
      realHost: false,
    }));
  } finally {
    for (const gate of gates) gate.resolve();
    disposeEvents?.();
    disposePreStep?.();
    disposeToolHook?.();
    try { disposeToolRegistration?.(); } catch {}
    try { disposeShareToolRegistration?.(); } catch {}
    try { await agentHandle?.dispose?.(); } catch {}
    try { disposeAdapter?.(); } catch {}
    await authorizationHook?.close();
    if (offlineBridgeServer) { offlineBridgeServer.closeAllConnections?.(); await new Promise(resolve => offlineBridgeServer.close(resolve)); }
    await offlineBridge?.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function extractDependencyGraph(archive, targetRoot, initialPackages) {
  const { header, dataOffset, fd } = openArchive(archive);
  const seen = new Set();
  const queue = [...initialPackages];
  try {
    while (queue.length) {
      const packageName = queue.shift();
      if (seen.has(packageName)) continue;
      seen.add(packageName);
      const packagePath = `dsh/node_modules/${packageName}`;
      const packageEntry = findEntry(header, packagePath);
      if (!packageEntry?.files) {
        if (initialPackages.includes(packageName)) throw new Error(`app.asar 缺少依赖包 ${JSON.stringify(packageName)}`);
        // 某些已发布 metadata 引用了未打包的构建依赖；实际运行期缺失仍会在 import 时报错。
        continue;
      }
      const files = extractTree(fd, dataOffset, packageEntry, targetRoot, packagePath, archive);
      const packageJson = files.get('package.json');
      if (packageJson) {
        const metadata = JSON.parse(packageJson);
        queue.push(...Object.keys(metadata.dependencies ?? {}).filter(Boolean));
      }
      for (const source of files.values()) {
        for (const specifier of source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/gu)) {
          const name = packageNameOf(specifier[1]);
          if (name && !seen.has(name)) queue.push(name);
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function openArchive(archive) {
  const fd = fs.openSync(archive, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (fs.readSync(fd, prefix, 0, prefix.length, 0) !== prefix.length || prefix.readUInt32LE(0) !== 4) {
      throw new Error('app.asar header is invalid');
    }
    const headerLength = prefix.readUInt32LE(12);
    const dataOffset = 8 + prefix.readUInt32LE(4);
    const bytes = Buffer.alloc(headerLength);
    if (fs.readSync(fd, bytes, 0, bytes.length, 16) !== bytes.length) throw new Error('app.asar header is truncated');
    return { header: JSON.parse(bytes.toString('utf8')), dataOffset, fd };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function findEntry(header, relativePath) {
  let current = header;
  for (const part of relativePath.split('/')) {
    assertSafeArchiveSegment(part);
    current = current?.files?.[part];
    if (!current) return null;
  }
  return current;
}

function extractTree(fd, dataOffset, entry, targetRoot, archivePath, archive) {
  const root = path.resolve(targetRoot);
  const archiveSegments = archivePath.split('/');
  archiveSegments.forEach(assertSafeArchiveSegment);
  const sources = new Map();
  const walk = (node, relativePath) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      assertSafeArchiveSegment(name);
      const childPath = `${relativePath}/${name}`;
      if (child.files) {
        walk(child, childPath);
        continue;
      }
      if (child.link || !Number.isSafeInteger(child.size) || child.size > 8 * 1024 * 1024) continue;
      let bytes;
      if (child.unpacked === true) {
        const unpackedRoot = path.resolve(`${archive}.unpacked`);
        const unpackedPath = path.resolve(unpackedRoot, ...childPath.split('/'));
        const unpackedRelative = path.relative(unpackedRoot, unpackedPath);
        if (!unpackedRelative || unpackedRelative === '..' || unpackedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(unpackedRelative)) throw new Error('拒绝越界的 unpacked entry');
        bytes = fs.readFileSync(unpackedPath);
        if (bytes.length !== child.size) throw new Error(`app.asar unpacked entry size mismatch: ${childPath}`);
      } else {
        bytes = Buffer.alloc(child.size);
        if (child.size && fs.readSync(fd, bytes, 0, bytes.length, dataOffset + Number(child.offset)) !== bytes.length) {
          throw new Error(`app.asar entry truncated: ${childPath}`);
        }
      }
      const destination = path.resolve(root, ...childPath.split('/'));
      const relativeDestination = path.relative(root, destination);
      if (!relativeDestination || relativeDestination === '..' || relativeDestination.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDestination)) {
        throw new Error(`拒绝越界的 app.asar entry：${JSON.stringify(childPath)}`);
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes);
      if (name === 'package.json' || /\.(?:mjs|cjs|js)$/u.test(name)) {
        sources.set(childPath.slice(archivePath.length + 1), bytes.toString('utf8'));
      }
    }
  };
  walk(entry, archivePath);
  return sources;
}

function assertSafeArchiveSegment(segment) {
  if (typeof segment !== 'string' || !segment || segment === '.' || segment === '..'
    || segment.includes('/') || segment.includes('\\') || segment.includes(':') || segment.includes('\0')
    || path.posix.isAbsolute(segment) || path.win32.isAbsolute(segment)) {
    throw new Error(`拒绝不安全的 app.asar 路径段：${JSON.stringify(segment)}`);
  }
}

function packageNameOf(specifier) {
  if (!specifier) return null;
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return /^@[\w.-]+\/[\w.-]+$/u.test(name) || /^[\w.-]+$/u.test(name) ? name : null;
}

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
