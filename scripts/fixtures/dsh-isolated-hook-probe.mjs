// Loaded only by the disposable DSH profile created by the diagnostic runner.
// Hardened: atomic result writes + structure validation, callId window attribution,
// explicit model-turn completion signal, and no .at(-1) authorization inference.
import fs from 'node:fs';

export const name = 'patrol-hook-probe';
export const inject = ['tools', 'agents', 'llm'];

export async function apply(ctx, config) {
  const result = {
    version: 2,
    cases: [],
    probeError: null,
    attribution: {
      method: 'per-call window keyed by callId (authorize/complete deltas)',
      limitation: 'guard authorize/complete callbacks do not receive callId; DSH pre/post events do, so association is by per-call snapshot and exec.callId recorded alongside.',
      calls: [],
    },
    turnSignals: { modelTurn: null, followupError: null },
  };

  function validateResult(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('result must be an object');
    if (value.version !== 2) throw new TypeError('result.version must be 2');
    if (!Array.isArray(value.cases)) throw new TypeError('result.cases must be an array');
    if (!Array.isArray(value.attribution?.calls)) throw new TypeError('result.attribution.calls must be an array');
    return value;
  }

  function write() {
    validateResult(result);
    const payload = `${JSON.stringify(result, null, 2)}\n`;
    const target = config.resultFile;
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
  }

  try {
    const { apply: installGuard } = await import(config.guardUrl);
    const { LlmAdapter, createUserMessage } = await import(config.llmUrl);
    let modelRequests = 0;
    let lastAssistantText = '';
    let turnFinished = false;
    const finishWaiters = new Set();
    const notifyTurnFinished = () => {
      turnFinished = true;
      for (const resolve of finishWaiters) resolve();
      finishWaiters.clear();
    };
    function waitForTurnFinish(timeoutMs) {
      if (turnFinished) return Promise.resolve({ finished: true });
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          finishWaiters.delete(onFinish);
          resolve({ finished: false, timedOut: true });
        }, timeoutMs);
        const onFinish = () => {
          clearTimeout(timer);
          resolve({ finished: true });
        };
        finishWaiters.add(onFinish);
      });
    }

    class FakeAdapter extends LlmAdapter {
      async resolveModel(provider, model) { return { provider, id: model, name: model }; }
      async *stream() {
        modelRequests++;
        const gui = fs.existsSync(config.guiTrigger);
        if (gui) fs.unlinkSync(config.guiTrigger);
        if (modelRequests === 1 || gui) {
          const toolName = 'mcp__xiaoheihe__get_home_content';
          const args = JSON.stringify({ identity: gui ? 'fake-gui' : 'fake-model' });
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'fake-call-1', name: toolName, arguments: args } };
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else {
          lastAssistantText = 'done';
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: 'done' };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } };
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
          yield { type: 'finish', reason: { kind: 'stop' } };
          notifyTurnFinished();
        }
      }
    }
    ctx.llm.registerAdapter(['isolated-fixture'], new FakeAdapter());

    const deadline = Date.now() + 12000;
    while (![...ctx.tools.view().knownNames].includes('mcp__xiaoheihe__get_home_content')) {
      if (Date.now() > deadline) throw new Error('fake MCP tool was not registered');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // B5 execute-first probe：guard 是 tools/execute 监听器；fake client 负责 reserve/commit/abort/finish。
    let guiBodyCallsBaseline = null;
    const auth = [];
    const commits = [];
    const aborts = [];
    const completion = [];
    const getBodyCalls = async () => (await (await fetch(`${config.fakeMcpUrl}metrics`)).json()).calls;
    const guardState = { used: 0, reserved: 0, authorize: auth, commit: commits, abort: aborts, complete: completion };
    const syncGuardState = () => {
      result.guardState = { used: guardState.used, reserved: guardState.reserved, commits: commits.length, aborts: aborts.length, completes: completion.length };
    };
    let ticketSeq = 0;
    const ticketFor = (request) => ({
      apiId: 'fixture-api',
      ticketId: `ticket-${++ticketSeq}`,
      kind: request.args?.identity?.startsWith('fixture-write') ? 'write' : 'read',
      agentKey: request.agentKey,
      identity: request.args?.identity ?? null,
    });
    const fakeClient = {
      enabled: true,
      authorize: async (request) => {
        auth.push(request);
        const identity = request.args?.identity ?? '';
        if (request.agentKey === 'probe-session-owner') {
          // owner 用户例外：无 ticket，插件应直接 next、不 commit/finish。
          return { ok: true, decision: 'allow', exemption: 'user' };
        }
        if (request.agentKey === 'probe-session-deny' || identity.includes('deny')) {
          return { ok: true, decision: 'deny', reason: 'fixture-deny' };
        }
        guardState.reserved += 1;
        return { ok: true, decision: 'allow', exemption: 'quota', ticket: ticketFor(request) };
      },
      commit: async (request) => {
        commits.push(request);
        guardState.reserved = Math.max(0, guardState.reserved - 1);
        guardState.used += 1;
        return { ok: true, started: true, ticket: { ...request.ticket, state: 'started' } };
      },
      abort: async (request) => {
        aborts.push(request);
        guardState.used = Math.max(0, guardState.used - 1);
        return { ok: true, aborted: true, rolledBack: true };
      },
      complete: async (request) => { completion.push(request); return { ok: true }; },
    };

    // Snapshot pre-call indices BEFORE the guard runs so GUI/async post-execute can be
    // attributed by the call window (guard callbacks do not receive callId).
    const preSnapshots = new Map();
    ctx.on('tools/execute', async (exec, next) => {
      preSnapshots.set(exec, { auth: auth.length, commit: commits.length, abort: aborts.length, completion: completion.length });
      return next();
    }, { prepend: true });
    // B5 earlier execute veto：早 listener 直接返回，guard/dispatch 都不执行（安全方向）。
    ctx.on('tools/execute', async (exec, next) =>
      exec.arguments?.identity === 'fixture-earlier-execute-veto'
        ? { isError: true, error: { code: 'EARLIER_EXECUTE_VETO', message: 'earlier execute veto' }, content: [{ type: 'text', text: 'earlier-execute-veto' }] }
        : next());
    // B5 earlier post short-circuit：post 链跳过，但 execute-first 的 finish 已在 dispatch 前/后完成。
    ctx.on('tools/post-execute', async (exec, execution, next) =>
      exec.arguments?.identity === 'fixture-post-short' ? { kind: 'accept' } : next());
    // B5 earlier pre-execute short-circuit：不再影响 execute-first 授权。
    ctx.on('tools/pre-execute', async (exec, next) =>
      exec.arguments?.identity === 'fixture-short-circuit' ? { kind: 'allow' } : next());
    installGuard(ctx, fakeClient);
    // B5 later execute veto / ABORTED：在 guard 之后注册，模拟第三方 listener 不 next dispatch。
    ctx.on('tools/execute', async (exec, next) => {
      const identity = exec.arguments?.identity;
      if (identity === 'fixture-aborted') {
        return { isError: true, error: { code: 'ABORTED_BEFORE_DISPATCH' }, content: [] };
      }
      if (identity === 'fixture-later-execute-veto') {
        return { isError: true, error: { code: 'LATER_EXECUTE_VETO', message: 'later execute veto' }, content: [{ type: 'text', text: 'later-execute-veto-without-dispatch' }] };
      }
      return next();
    });
    // 仍保留一个更晚的 pre-execute deny 场景：pre deny 时 execute 不运行（不计额度）。
    ctx.on('tools/pre-execute', async (exec, next) =>
      exec.arguments?.identity === 'fixture-later-deny' ? { kind: 'deny', reason: 'fixture-later-policy' } : next());

    /** 记录每次调用窗口的 authorize/complete 增量，不再使用 auth.at(-1) 全局推断。 */
    async function runAttributed(callId, fn) {
      const beforeAuth = auth.length;
      const beforeCommit = commits.length;
      const beforeAbort = aborts.length;
      const beforeCompletion = completion.length;
      let output;
      let error = null;
      try {
        output = await fn();
      } catch (caught) {
        error = { name: caught?.name, message: String(caught?.message ?? caught).slice(0, 200) };
        throw caught;
      } finally {
        const attributed = {
          callId,
          authorizeKeys: auth.slice(beforeAuth).map(item => item?.agentKey ?? item),
          commits: commits.slice(beforeCommit).map(item => item?.ticket?.ticketId ?? null),
          aborts: aborts.slice(beforeAbort).map(item => item?.ticket?.ticketId ?? null),
          completions: completion.slice(beforeCompletion).map(item => ({
            ticketId: item?.ticket?.ticketId ?? null,
            ticketKind: item?.ticket?.kind ?? null,
            outcome: item?.outcome ?? null,
          })),
          ...(error === null ? {} : { error }),
        };
        result.attribution.calls.push(attributed);
      }
      return output;
    }

    const handles = [];
    for (const sessionId of ['probe-session-a', 'probe-session-b', 'probe-session-deny', 'probe-session-owner']) {
      handles.push(await ctx.agents.create({ sessionId, meta: { cwd: config.workdir }, agentOptions: { provider: 'isolated-fixture', model: 'isolated-fixture' } }));
    }

    for (const [identity, handle] of [['deny', handles[2]], ['allow-a', handles[0]], ['allow-b', handles[1]]]) {
      const before = await getBodyCalls();
      const callId = `fixture-${identity}`;
      const execution = await runAttributed(callId, () => ctx.tools.execute({
        name: 'mcp__xiaoheihe__get_home_content',
        arguments: { identity },
        agent: handle.agent,
        callId,
        signal: new AbortController().signal,
      }));
      result.cases.push({ identity, callId, isError: execution.isError, bodyCalls: (await getBodyCalls()) - before });
    }
    result.authorizeKeys = auth.map(item => item.agentKey);
    result.completions = completion.map(item => ({ ticketId: item?.ticket?.ticketId ?? null, ticketKind: item?.ticket?.kind ?? null, outcome: item?.outcome ?? null }));
    syncGuardState();
    write();

    // task-59：动态身份实验（两个真实 DSH 会话 + owner/unknown）。
    async function identityCall(label, handle, identity) {
      const before = await getBodyCalls();
      const authBefore = auth.length;
      const commitBefore = commits.length;
      const completionBefore = completion.length;
      const callId = `identity-${label}`;
      const execution = await runAttributed(callId, () => ctx.tools.execute({
        name: 'mcp__xiaoheihe__get_home_content',
        arguments: { identity },
        agent: handle.agent,
        callId,
        signal: new AbortController().signal,
      }));
      const window = result.attribution.calls.find(call => call.callId === callId) ?? null;
      return {
        label,
        callId,
        execAgentId: handle.agent?.id ?? null,
        sessionId: handle.agent?.session?.id ?? null,
        pluginAgentKey: (window?.authorizeKeys ?? [])[0] ?? null,
        isError: execution.isError,
        bodyCalls: (await getBodyCalls()) - before,
        authorizeCalls: auth.length - authBefore,
        commitCalls: commits.length - commitBefore,
        completionCalls: completion.length - completionBefore,
      };
    }
    result.identityProbe = { sessions: [], owner: null, unknown: null };
    result.identityProbe.sessions.push(await identityCall('a-1', handles[0], 'identity-a-1'));
    result.identityProbe.sessions.push(await identityCall('a-2', handles[0], 'identity-a-2'));
    result.identityProbe.sessions.push(await identityCall('b-1', handles[1], 'identity-b-1'));
    result.identityProbe.owner = await identityCall('owner-1', handles[3], 'identity-owner-1');
    result.identityProbe.unknown = await identityCall('unknown-1', handles[2], 'identity-unknown-1');
    result.identityProbe.distinct = new Set(result.identityProbe.sessions.map(item => item.pluginAgentKey)).size === 2;
    result.identityProbe.stable = result.identityProbe.sessions[0].pluginAgentKey === result.identityProbe.sessions[1].pluginAgentKey;
    result.backgroundOutputIsolation = {
      status: 'unverified',
      reason: 'isolated DSH probe has no QQ bridge; background sendToQQ isolation is covered by bridge harness',
    };
    syncGuardState();
    write();

    const beforeBody = await getBodyCalls();
    const beforeAuth = auth.length;
    const beforeShortCommit = commits.length;
    const beforeShortCompletion = completion.length;
    const shortCircuit = await runAttributed('fixture-short-circuit', () => ctx.tools.execute({
      name: 'mcp__xiaoheihe__get_home_content', arguments: { identity: 'fixture-short-circuit' },
      agent: handles[0].agent, callId: 'fixture-short-circuit', signal: new AbortController().signal,
    }));
    result.shortCircuit = {
      callId: 'fixture-short-circuit',
      isError: shortCircuit.isError,
      bodyCalls: (await getBodyCalls()) - beforeBody,
      authorizeCalls: auth.length - beforeAuth,
      commitCalls: commits.length - beforeShortCommit,
      completionCalls: completion.length - beforeShortCompletion,
    };

    const beforeDeniedBody = await getBodyCalls();
    const beforeDeniedAuth = auth.length;
    const beforeDeniedCommit = commits.length;
    const beforeDeniedCompletion = completion.length;
    const laterDenied = await runAttributed('fixture-later-deny', () => ctx.tools.execute({
      name: 'mcp__xiaoheihe__get_home_content', arguments: { identity: 'fixture-later-deny' },
      agent: handles[0].agent, callId: 'fixture-later-deny', signal: new AbortController().signal,
    }));
    result.laterDeny = {
      callId: 'fixture-later-deny',
      isError: laterDenied.isError,
      bodyCalls: (await getBodyCalls()) - beforeDeniedBody,
      authorizeCalls: auth.length - beforeDeniedAuth,
      commitCalls: commits.length - beforeDeniedCommit,
      completionCalls: completion.length - beforeDeniedCompletion,
      outcome: (() => {
        const window = completion.slice(beforeDeniedCompletion);
        return window.length === 0 ? null : (window[window.length - 1]?.outcome ?? null);
      })(),
    };
    write();

    // B5：earlier execute veto（guard 完全不运行）、ABORTED（guard commit 后 abort 回滚）、
    // later execute veto（commit/finish 保留计数，dispatch 未执行）与 post short-circuit。
    async function executeScenario(identity) {
      const before = await getBodyCalls();
      const usedBefore = guardState.used;
      const authBefore = auth.length;
      const commitBefore = commits.length;
      const abortBefore = aborts.length;
      const completionBefore = completion.length;
      const execution = await runAttributed(`fixture-${identity}`, () => ctx.tools.execute({
        name: 'mcp__xiaoheihe__get_home_content',
        arguments: { identity },
        agent: handles[0].agent,
        callId: `fixture-${identity}`,
        signal: new AbortController().signal,
      }));
      return {
        callId: `fixture-${identity}`,
        isError: execution.isError,
        bodyCalls: (await getBodyCalls()) - before,
        authorizeCalls: auth.length - authBefore,
        commitCalls: commits.length - commitBefore,
        abortCalls: aborts.length - abortBefore,
        completionCalls: completion.length - completionBefore,
        usedBefore,
        usedAfter: guardState.used,
        usedDelta: guardState.used - usedBefore,
        reservedAfter: guardState.reserved,
        result: { isError: execution.isError, error: execution.error?.code ?? null, text: execution.content?.[0]?.text ?? null },
      };
    }
    result.earlierExecuteVeto = await executeScenario('fixture-earlier-execute-veto');
    result.aborted = await executeScenario('fixture-aborted');
    const usedBeforeLater = guardState.used;
    result.laterExecuteVeto = await executeScenario('fixture-later-execute-veto');
    result.laterExecuteVeto.usedBefore = usedBeforeLater;
    result.laterExecuteVeto.usedRetained = guardState.used > usedBeforeLater;
    result.postShortCircuit = await executeScenario('fixture-post-short');
    result.postShortCircuit.postSkippedByEarlierListener = true;
    syncGuardState();
    write();

    // GUI async completion: attribute by pre-call window captured here (not global .at(-1)).
    ctx.on('tools/post-execute', async (exec, execution, next) => {
      const decision = await next();
      if (exec.arguments?.identity === 'fake-gui') {
        const snapshot = preSnapshots.get(exec) ?? { auth: auth.length, completion: completion.length };
        const beforeGuiAuth = snapshot.auth;
        const beforeGuiCompletion = snapshot.completion;
        setTimeout(async () => {
          try {
            const bodyCallsTotal = await getBodyCalls();
            const baseline = typeof guiBodyCallsBaseline === 'number' ? guiBodyCallsBaseline : 0;
            result.gui = {
              status: 'complete',
              callId: exec.callId ?? null,
              agentId: exec.agent?.id,
              sessionId: exec.agent?.session?.id,
              isError: execution.isError,
              attribution: {
                authorizeKeys: auth.slice(beforeGuiAuth).map(item => item?.agentKey ?? item),
                pluginAgentKey: (auth.slice(beforeGuiAuth).map(item => item?.agentKey ?? item)[0]) ?? null,
                completions: completion.slice(beforeGuiCompletion).map(item => ({
                  ticketId: item?.ticket?.ticketId ?? null,
                  ticketKind: item?.ticket?.kind ?? null,
                  outcome: item?.outcome ?? null,
                })),
              },
              bodyCallsBaseline: baseline,
              bodyCallsTotal,
              bodyCallsDelta: bodyCallsTotal - baseline,
              bodyCalls: bodyCallsTotal,
            };
          } catch (error) {
            result.gui = { status: 'unverified', error: { name: error?.name, message: String(error?.message ?? error).slice(0, 200) } };
          }
          syncGuardState();
          write();
        }, 200);
      }
      return decision;
    });

    result.realSessions = { status: 'running', calls: [] };
    try {
      for (const handle of [handles[0], handles[1], handles[0], handles[2]]) {
        const agent = handle.agent;
        const before = await getBodyCalls();
        const callId = `real-${result.realSessions.calls.length}`;
        const execution = await runAttributed(callId, () => ctx.tools.execute({
          name: 'mcp__xiaoheihe__get_home_content',
          arguments: { identity: 'synthetic-fallback' },
          agent,
          callId,
          signal: new AbortController().signal,
        }));
        result.realSessions.calls.push({ callId, agentId: agent?.id, sessionId: agent?.session?.id, isError: execution.isError, bodyCalls: (await getBodyCalls()) - before });
      }
      result.realSessions.status = 'complete';
    } catch (error) {
      result.realSessions.status = 'unverified';
      result.realSessions.error = { name: error?.name, message: String(error?.message ?? error).slice(0, 300) };
    }
    write();

    result.ptc = { status: 'running' };
    try {
      if (!ctx.get('ptcRuntime')) throw new Error('isolated profile does not expose ptcRuntime');
      const agent = handles[1].agent;
      agent.ctx.tools.presentAs('ptc');
      const before = await getBodyCalls();
      const beforeAuth = auth.length;
      const beforeCommit = commits.length;
      const execution = await runAttributed('fixture-ptc', () => ctx.tools.execute({
        name: 'run_code', agent, callId: 'fixture-ptc',
        arguments: { code: 'return await tools.mcp__xiaoheihe__get_home_content({ identity: "fake-ptc" })', description: 'Run isolated fake MCP probe' },
        signal: new AbortController().signal,
      }));
      result.ptc = { status: execution.isError ? 'failed' : 'complete', callId: 'fixture-ptc', bodyCalls: (await getBodyCalls()) - before, authorizeCalls: auth.length - beforeAuth, commitCalls: commits.length - beforeCommit, error: execution.error?.message ?? null };
      const deniedAgent = handles[2].agent;
      deniedAgent.ctx.tools.presentAs('ptc');
      const beforeDeny = await getBodyCalls();
      const beforeDenyAuth = auth.length;
      const denied = await runAttributed('fixture-ptc-deny', () => ctx.tools.execute({
        name: 'run_code', agent: deniedAgent, callId: 'fixture-ptc-deny',
        arguments: { code: 'return await tools.mcp__xiaoheihe__get_home_content({ identity: "fake-ptc-deny" })', description: 'Run isolated deny probe' },
        signal: new AbortController().signal,
      }));
      result.ptc.deny = { callId: 'fixture-ptc-deny', isError: denied.isError, bodyCalls: (await getBodyCalls()) - beforeDeny, authorizeCalls: auth.length - beforeDenyAuth };
    } catch (error) {
      result.ptc = { status: 'unverified', error: String(error?.message ?? error).slice(0, 300) };
    }
    write();

    result.modelTurn = { status: 'running', callId: 'fixture-model-turn', finished: false };
    try {
      const before = await getBodyCalls();
      const beforeAuth = auth.length;
      const beforeCommit = commits.length;
      const beforeCompletion = completion.length;
      let followupError = null;
      try {
        const followup = handles[0].agent.followup(createUserMessage({ content: [{ type: 'text', text: 'exercise fake MCP' }], source: { kind: 'user' } }));
        if (followup !== null && typeof followup?.catch === 'function') followup.catch(error => { followupError = { name: error?.name, message: String(error?.message ?? error).slice(0, 200) }; });
      } catch (error) {
        followupError = { name: error?.name, message: String(error?.message ?? error).slice(0, 200) };
      }
      const startedAt = Date.now();
      const finished = await waitForTurnFinish(10000);
      // idle grace: allow post-execute/complete callbacks to settle after finish.
      await new Promise(resolve => setTimeout(resolve, 250));
      const bodyCallsAfter = (await getBodyCalls()) - before;
      result.turnSignals.modelTurn = { finished: finished.finished, timedOut: finished.timedOut === true, lastAssistantText, mcpDone: bodyCallsAfter > 0 };
      result.modelTurn = {
        status: finished.finished && lastAssistantText !== '' ? 'complete' : 'unverified',
        callId: 'fixture-model-turn',
        finished: finished.finished,
        outputText: lastAssistantText,
        modelRequests,
        bodyCalls: bodyCallsAfter,
        authorizeCalls: auth.length - beforeAuth,
        commitCalls: commits.length - beforeCommit,
        completionCalls: completion.length - beforeCompletion,
        followupError,
        waitedMs: Date.now() - startedAt,
        attribution: {
          authorizeKeys: auth.slice(beforeAuth).map(item => item?.agentKey ?? item),
          completions: completion.slice(beforeCompletion).map(item => ({ ticketId: item?.ticket?.ticketId ?? null, ticketKind: item?.ticket?.kind ?? null, outcome: item?.outcome ?? null })),
        },
      };
      result.turnSignals.followupError = followupError;
    } catch (error) {
      result.turnSignals.followupError = { name: error?.name, message: String(error?.message ?? error).slice(0, 200) };
      result.modelTurn = { status: 'unverified', error: { name: error?.name, message: String(error?.message ?? error).slice(0, 300) } };
    }

    guiBodyCallsBaseline = await getBodyCalls();
    result.gui = { status: 'ready', bodyCallsBaseline: guiBodyCallsBaseline };
    syncGuardState();
    result.modelAdapter = { kind: 'in-process fake', provider: 'isolated-fixture', model: 'isolated-fixture', externalNetwork: false };
    write();
  } catch (error) {
    result.probeError = { name: error?.name, message: String(error?.message ?? error).slice(0, 500) };
    try { write(); } catch { /* keep original probe error */ }
  }
}
