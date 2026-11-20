// E6 removal + E7 hardening.
//
// Codex: E6 was my own HTTP handler with hardcoded 401/404 — the SAME circular pattern I had
// already been told twice to stop doing. It proves nothing about the host. It is REMOVED, and E6
// is reported BLOCKED (I cannot expose the real host RPC surface on a verifiable self-built
// fixture within the current constraints).
//
// E7 is real (real AgentLoop + fake model requesting a tool + registered fake tool), so it stays —
// but the assertions must be independent and each must fail on its own:
//   · toolCallCount   > 0
//   · toolResultCount > 0
//   · executorInvocations === toolCallCount
//   · the callId in the tool/call matches the one in the tool/result, and equals what the model asked
//   · the executor's return value is what the tool/result carries
// Each assertion gets its own mutation so "PASS" is not a bundle claim.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CHILD = String.raw`
import fs from 'node:fs';

const out = { checks: {}, detail: {}, notMeasured: [] };
const marker = process.env.E7_MARKER;
if (typeof marker !== 'string' || !marker) { process.stdout.write(JSON.stringify({ fatal: 'no marker' })); process.exit(2); }

let h;
try {
  const { loadOfflineHostFixture } = await import('file:///D:/QQ%20brideg/scripts/qzone-host-prestep-fixture.mjs');
  h = await loadOfflineHostFixture();
} catch (e) {
  process.stdout.write(JSON.stringify({ fatal: 'fixture load failed: ' + String(e && e.message) }));
  process.exit(3);
}

const { cordis, session, projection, agent, agentLoop, llm, tools, systemPrompt, nativeExecutor } = h;
const root = new cordis.Context();
let exitCode = 0;
try {
  for (const plugin of [projection.SessionProjectionRegistry, session.SessionStore, agent.AgentRegistry,
    systemPrompt.SystemPrompt, llm.LlmRuntime, tools.ToolRuntime, nativeExecutor, agentLoop.AgentLoop]) {
    root.plugin(plugin);
  }
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  const haveAgents = Boolean(root.get('agents'));
  const haveLlm = Boolean(root.get('llm'));
  const haveTools = Boolean(root.get('tools'));
  out.checks.hostInstantiated = haveAgents && haveLlm && haveTools;
  if (!out.checks.hostInstantiated) { process.stdout.write(JSON.stringify(out)); process.exit(4); }

  const TOOL_NAME = 'e7_probe';
  const REQUESTED_CALL_ID = 'e7-call-1';
  // Measured: the host validates tool output against the declared schema with
  // additionalProperties: false, and REJECTS undeclared keys:
  //   Error: tool "e7_probe" returned invalid output: "value.marker" is not a declared property
  // So the executor must return EXACTLY the declared shape. The earlier version returned an extra
  // marker key and produced an INVALID_TOOL_OUTPUT error — the probe's own bug, now fixed.
  const EXECUTOR_RESULT = { ok: true };
  let executed = 0;
  let lastExecArgs = null;

  let modelStep = 0;
  class ToolAdapter extends llm.LlmAdapter {
    providerInfo(p) { return { id: p, name: p }; }
    resolveModel(p, m) { return Promise.resolve({ provider: p, id: m, name: m }); }
    async *stream() {
      if (modelStep++ === 0) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: {
          type: 'tool-call', id: REQUESTED_CALL_ID, name: TOOL_NAME, arguments: JSON.stringify({ probe: 1 }),
        } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'done' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const disposeAdapter = root.get('llm').registerAdapter(['offline'], new ToolAdapter());
  const disposeTool = root.get('tools').register({
    name: TOOL_NAME,
    description: 'e7 probe tool',
    parameters: { probe: { type: 'number', required: false } },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: false },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
    },
    execute: async (args) => { executed += 1; lastExecArgs = args; return EXECUTOR_RESULT; },
  });
  void disposeTool;

  const agentHandle = await root.get('agents').create({
    sessionId: 'e7-session', agentOptions: { provider: 'offline', model: 'fixture' },
  });
  const sess = agentHandle.agent.session;
  const before = sess.snapshotEvents().length;
  agentHandle.agent.followup(llm.createUserMessage({
    content: [{ type: 'text', text: 'go' }],
    source: { kind: 'user', rpcId: 'rpc-e7' },
  }));
  await agentHandle.agent.whenIdle();
  const added = sess.snapshotEvents().slice(before);

  const toolCalls = added.filter((e) => e.type === 'tool/call');
  const toolResults = added.filter((e) => e.type === 'tool/result');
  const firstCall = toolCalls[0];
  const firstResult = toolResults[0];

  out.detail = {
    addedCount: added.length,
    addedTypes: [...new Set(added.map((e) => e.type))],
    toolCallCount: toolCalls.length,
    toolResultCount: toolResults.length,
    executorInvocations: executed,
    requestedCallId: REQUESTED_CALL_ID,
    callEventCallId: firstCall?.data?.callId ?? null,
    callEventName: firstCall?.data?.name ?? null,
    // MEASURED STRUCTURE: a tool/result event carries the call id at
    // data.message.source.callId and data.message.toolCallId — NOT at data.callId.
    // My first assertion looked at the wrong path and reported a false failure.
    resultEventCallId: firstResult?.data?.message?.source?.callId ?? null,
    resultEventToolCallId: firstResult?.data?.message?.toolCallId ?? null,
    resultIsError: firstResult?.data?.message?.isError ?? null,
    resultPayload: firstResult?.data?.result ?? firstResult?.data ?? null,
    executorArgs: lastExecArgs,
  };

  // ── independent assertions ──
  out.checks.toolCallObserved = toolCalls.length === 1;
  out.checks.toolResultObserved = toolResults.length === 1;
  out.checks.executorRanExactlyOnce = executed === 1;
  out.checks.callIdMatchesRequest =
    firstCall?.data?.callId === REQUESTED_CALL_ID
    && out.detail.resultEventCallId === REQUESTED_CALL_ID
    && out.detail.resultEventToolCallId === REQUESTED_CALL_ID;
  out.checks.toolNameMatches = firstCall?.data?.name === TOOL_NAME;
  out.checks.executorArgsForwarded =
    lastExecArgs !== null && typeof lastExecArgs === 'object' && lastExecArgs.probe === 1;
  // The result event must carry the executor's payload AND not be an error.
  // The rendered text embeds JSON with escaped quotes, so a naive '"ok":true' substring test fails
  // even when the value IS propagated (measured: text is "{\"ok\":true}"). Parse the content instead.
  out.checks.executorResultPropagated = (() => {
    // STRICT: the contract is "a tool/result that is NOT an error". Requiring === false (not just
    // "not true") means a missing/undefined isError is a failure too, rather than silently passing.
    if (out.detail.resultIsError !== false) return false;
    const content = firstResult?.data?.message?.content;
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
      if (part?.type !== 'text' || typeof part.text !== 'string') return false;
      try { return JSON.parse(part.text)?.ok === true; } catch { return false; }
    });
  })();

  out.notMeasured = [
    'session/event subscribers outside this process',
    'agent/pre-step observers wired by plugins',
    'origin ledger consumption',
    'authorize decisions',
    'platform acceptance',
    'cross-process reachability of this path',
  ];
  out.markerEcho = marker;
  out.childPid = process.pid;
} catch (e) {
  out.fatal = 'runtime: ' + String(e && e.message);
  exitCode = 6;
}

process.stdout.write(JSON.stringify(out));
process.exit(exitCode);
`;

const report = {
  e6: {
    status: 'BLOCKED — withdrawn',
    reason:
      'The previous E6 stood up MY OWN HTTP handler with hardcoded 401/404 and a /prompt that only '
      + 'returned JSON without ever invoking the host prompt. That is the same circular pattern '
      + 'already rejected twice, and it contradicts the explicit instruction not to substitute '
      + 'self-written handlers for the host. No evidence about host RPC was produced, so the claim '
      + '"illegal RPC refused / legitimate typed prompt accepted" is RETRACTED.',
    whatWouldBeNeeded:
      'A verifiable self-built fixture that EXPOSES THE REAL host RPC surface (session controller '
      + 'over a real transport) with temporary config and a fake credential. Until that exists, E6 '
      + 'stays blocked rather than being faked.',
    withdrewAlso: 'M20 mutation — it only mutated my own token check, so it is not host security evidence.',
  },
  e7: { status: 'pending' },
  defineToolVsRegister: {
    status: 'observation only, insufficient as a product-path claim',
    measured: [
      'defineTool({output:{schema:{type:"json"}}}) -> accepted',
      'ctx.tools.register({output:{schema:{type:"json"}}}) -> rejected: schema.type must be one of object/...',
    ],
    notEstablished:
      'Which path the PRODUCT actually uses at runtime for each of its tools. The repo code calls '
      + 'defineTool (native-tool.mjs:56-63), but I have not exercised every product registration '
      + 'path, and a comment is not a test. Reported as an observation, not a compatibility claim.',
  },
  envPolicy: null,
};

let tmp = null;
try {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-e7-'));
  const fakeHome = path.join(tmp, 'home');
  const fakeTemp = path.join(tmp, 'temp');
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(fakeTemp, { recursive: true });

  const script = path.join(tmp, 'child.mjs');
  fs.writeFileSync(script, CHILD, 'utf8');

  const marker = `e7-${process.pid}-${Date.now()}`;
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    windir: process.env.windir,
    NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS,
    USERPROFILE: fakeHome,
    TEMP: fakeTemp,
    TMP: fakeTemp,
    E7_MARKER: marker,
    DSH_ASAR: 'D:/DSH Resources/resources/app.asar',
  };
  env.DSH_ASAR = 'D:/DSH Desktop/resources/app.asar';
  report.envPolicy = {
    inheritedFromRealUser: ['PATH', 'SystemRoot', 'windir', 'NUMBER_OF_PROCESSORS'],
    redirected: ['USERPROFILE', 'TEMP', 'TMP'],
    readOnlyArchive: 'DSH_ASAR',
    note: 'environment control only — NOT file/network/credential isolation',
  };

  const run = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 180_000, env });
  if (run.error) throw run.error;
  const raw = String(run.stdout || '').trim();
  if (!raw) {
    report.e7 = { status: 'BLOCKED', reason: `child produced no output (status ${run.status})`, stderr: String(run.stderr || '').slice(-500) };
    report.exitCode = 10;
  } else {
    const parsed = JSON.parse(raw);
    if (parsed.fatal) {
      report.e7 = { status: 'FAILED', reason: parsed.fatal };
      report.exitCode = 11;
    } else {
      const c = parsed.checks ?? {};
      // A child that exits non-zero has failed even if its JSON happens to contain green checks.
      // Codex caught that PASS was computed without looking at run.status.
      const exitStatusOk = run.status === 0;
      const identityOk = exitStatusOk
        && parsed.markerEcho === marker
        && Number.isSafeInteger(parsed.childPid)
        && parsed.childPid !== process.pid;
      const allChecks = [
        'hostInstantiated', 'toolCallObserved', 'toolResultObserved', 'executorRanExactlyOnce',
        'callIdMatchesRequest', 'toolNameMatches', 'executorArgsForwarded', 'executorResultPropagated',
      ];
      const failing = allChecks.filter((k) => c[k] !== true);
      report.e7 = {
        status: identityOk && failing.length === 0 ? 'PASS' : 'FAIL',
        identityOk,
        exitStatus: run.status,
        exitStatusOk,
        checks: c,
        failingChecks: failing,
        detail: parsed.detail,
        notMeasured: parsed.notMeasured,
      };
      report.exitCode = identityOk && failing.length === 0 ? 0 : 12;
    }
  }
} catch (error) {
  report.error = String(error?.message ?? error);
  report.exitCode = 13;
} finally {
  if (tmp) {
    for (let i = 0; i < 10; i += 1) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); break; } catch { /* windows delay */ }
    }
  }
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.exitCode ?? 0);
