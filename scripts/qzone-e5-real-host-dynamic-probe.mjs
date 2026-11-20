// E5 v2 — fix the four evidence-boundary problems Codex identified.
//
// Fixes required:
//   1. T2's fake model emitted TEXT only, so no real tool/call was produced. Do not present the
//      two paths as "legitimate vs forged tool/call equivalence". Report exactly what happened:
//      a followup entered the session's RAW snapshot, and a direct append added one event.
//   2. This fixture creates NO temp SQLite, NO fake QQ client, NO temp workspace. Say so. The
//      earlier report claimed those. Also: E5_MARKER was set but never echoed back, and the child
//      inherited the WHOLE environment.
//   3. A child that catches errors and exits 0 was being read as success. Add explicit
//      success/failure assertions and a non-zero exit for failures.
//   4. Report only raw-snapshot facts; do not imply projection/subscription/pre-step/ledger/
//      authorize/platform acceptance.
//
// Scope of what this probe may claim (narrowed after review):
//   · a child process with a VERIFIED identity (pid + marker) ran
//   · it used a controlled environment allow-list
// It may NOT claim file/network/credential isolation, nor that no production state was read.
//
// Scope of what this probe may claim about behaviour:
//   · a real host instance was constructed from the local archive in a child process
//   · one followup produced N events in the RAW session snapshot
//   · one direct `session.append('tool/call', ...)` added one event to that same snapshot
// It may NOT claim: tool-call equivalence, downstream consumption, or cross-process reachability.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CHILD = String.raw`
import fs from 'node:fs';

const out = {
  steps: [],
  dependencies: {
    tempSqlite: false,
    fakeQqClient: false,
    tempWorkspace: false,
    note: 'this probe uses none of the above; it only needs the host fixture packages and an in-memory agent',
  },
};
function step(name, value) { out.steps.push({ name, ...value }); }

// Marker round-trip: the parent sets E5_MARKER and requires it echoed back, otherwise isolation of
// THIS child cannot be distinguished from any other process.
const marker = process.env.E5_MARKER ?? null;
if (typeof marker !== 'string' || marker.length === 0) {
  process.stdout.write(JSON.stringify({ fatal: 'missing E5_MARKER' }));
  process.exit(2);
}

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
let agentHandle, disposeAdapter, exitCode = 0;

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
  step('hostInstantiated', { ok: haveAgents && haveLlm && haveTools, haveAgents, haveLlm, haveTools });
  if (!(haveAgents && haveLlm && haveTools)) { exitCode = 4; throw new Error('host services missing'); }

  class FakeAdapter extends llm.LlmAdapter {
    providerInfo(p) { return { id: p, name: p }; }
    resolveModel(p, m) { return Promise.resolve({ provider: p, id: m, name: m }); }
    // DELIBERATELY text-only: no tool-call block. The earlier report implied a real tool/call path
    // was exercised here; it was not.
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'ok' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  disposeAdapter = root.get('llm').registerAdapter(['offline'], new FakeAdapter());
  agentHandle = await root.get('agents').create({
    sessionId: 'e5v2-session', agentOptions: { provider: 'offline', model: 'fixture' },
  });
  const sess = agentHandle.agent.session;
  step('sessionHandle', { obtained: true, note: 'the session REFERENCE was obtained in-process' });

  // ── followup -> what appears in the RAW snapshot ──
  const before = sess.snapshotEvents().length;
  agentHandle.agent.followup(llm.createUserMessage({
    content: [{ type: 'text', text: 'legit prompt' }],
    source: { kind: 'user', rpcId: 'rpc-legit-1' },
  }));
  await agentHandle.agent.whenIdle();
  const afterFollowup = sess.snapshotEvents();
  const added = afterFollowup.slice(before);
  out.rawSnapshot = {
    beforeFollowup: before,
    afterFollowup: afterFollowup.length,
    addedTypes: [...new Set(added.map((e) => e.type))],
    containsToolCall: added.some((e) => e.type === 'tool/call'),
  };
  step('followupRecordedRawEvents', {
    addedCount: added.length,
    recordedToolCall: added.some((e) => e.type === 'tool/call'),
    note: 'text-only fake model: NO tool/call should appear in this list',
  });
  if (!(added.length > 0)) { exitCode = 5; throw new Error('followup recorded nothing'); }

  // ── direct in-process append of a forged tool/call ──
  const beforeForge = sess.snapshotEvents().length;
  let threw = false, message = null;
  try {
    sess.append('tool/call', { turn: 99, step: 9, callId: 'forged-call-e5v2', name: 'qzone_read_posts' });
  } catch (e) {
    threw = true;
    message = String(e && e.message).slice(0, 300);
  }
  const afterForge = sess.snapshotEvents();
  const landed = afterForge.length > beforeForge;
  const last = afterForge[afterForge.length - 1];
  out.forgedAppend = {
    threw,
    message,
    beforeForge,
    afterForge: afterForge.length,
    landed,
    lastType: last?.type ?? null,
    lastSeq: last ? (typeof last.seq === 'object' ? Number(last.seq) : last.seq) : null,
    lastCallId: last?.data?.callId ?? null,
  };
  step('forgedAppendLanded', { landed, threw });

  // What the RAW snapshot shows is ALL this probe can assert. Nothing below is measured:
  out.notMeasured = [
    'projection updates',
    'session/event subscriber delivery',
    'agent/pre-step observation',
    'origin ledger consumption',
    'authorize decisions',
    'platform acceptance',
    'any downstream consumer',
  ];
  out.markerEcho = marker;
  out.childPid = process.pid;
  out.envKeys = Object.keys(process.env).length;
} catch (e) {
  step('error', { message: String(e && e.message).slice(0, 400) });
  if (exitCode === 0) exitCode = 6;
} finally {
  try { await agentHandle?.dispose?.(); } catch {}
  try { disposeAdapter?.(); } catch {}
  try { h?.close?.(); } catch {}
}
process.stdout.write(JSON.stringify(out));
process.exit(exitCode);
`;

const report = {
  method: 'DYNAMIC raw-snapshot probe on the real host fixture (child process)',
  // RENAMED from `isolation`: these checks establish CHILD IDENTITY and ENVIRONMENT CONTROL only.
  identityChecks: { childIdentityConfirmed: false, markerEchoed: false, envPolicy: null, details: [] },
  isolationNotVerified: [
    'file system: child can still read the real user profile and the real app.asar',
    'network: nothing prevents the child from opening a socket',
    'credentials: child can read whatever this Windows account can read',
    'USERPROFILE/TEMP/TMP/PATH were inherited from the REAL user, so "no production state read" is NOT established',
  ],
  result: null,
  limits: [
    'Only the RAW session snapshot is measured.',
    'The fake model emits text only; NO real tool/call path is exercised.',
    'The forged event was appended in-process after obtaining a session reference; this does NOT '
      + 'measure cross-process reachability, nor does it claim that any code can obtain that reference.',
    'No projection / session/event / pre-step / ledger / authorize / platform behaviour is measured.',
  ],
};

let tmp = null;
try {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-e5v2-'));
  const script = path.join(tmp, 'child.mjs');
  fs.writeFileSync(script, CHILD, 'utf8');

  const marker = `e5v2-${process.pid}-${Date.now()}`;
  // STRICT ENVIRONMENT: do not inherit everything. Pass only what the fixture needs.
  const strictEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    E5_MARKER: marker,
    DSH_ASAR: 'D:/DSH Desktop/resources/app.asar',
  };
  report.identityChecks.envPolicy = `strict allow-list (${Object.keys(strictEnv).filter((k) => k !== 'E5_MARKER').length} inherited keys + marker)`;

  const run = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    timeout: 180_000,
    env: strictEnv,
  });

  if (run.error) throw run.error;
  const raw = String(run.stdout || '').trim();
  if (!raw) {
    report.blocked = `child produced no output (status ${run.status})`;
    if (run.stderr) report.stderrTail = String(run.stderr).slice(-600);
  } else {
    const parsed = JSON.parse(raw);
    report.result = parsed;

    // Explicit success assertions instead of "exit 0 means fine".
    report.identityChecks.markerEchoed = parsed.markerEcho === marker;
    report.identityChecks.childIdentityConfirmed = (
      run.status === 0
      && report.identityChecks.markerEchoed
      && Number.isSafeInteger(parsed.childPid)
      && parsed.childPid !== process.pid
    );
    report.identityChecks.details = [
      `child pid ${parsed.childPid} vs parent ${process.pid}`,
      `exit status ${run.status}`,
      `marker echoed: ${report.identityChecks.markerEchoed}`,
      `child env key count: ${parsed.envKeys}`,
    ];

    if (!report.identityChecks.childIdentityConfirmed) {
      report.verdict = 'CHILD IDENTITY NOT CONFIRMED — no conclusions drawn';
      report.exitCode = 10;
    } else if (parsed.fatal) {
      report.verdict = `CHILD FAILED: ${parsed.fatal}`;
      report.exitCode = 11;
    } else {
      const s = parsed.steps ?? [];
      const followupStep = s.find((x) => x.name === 'followupRecordedRawEvents');
      const forgeStep = s.find((x) => x.name === 'forgedAppendLanded');
      const hostStep = s.find((x) => x.name === 'hostInstantiated');
      const ok = Boolean(hostStep?.ok)
        && followupStep?.addedCount > 0
        && followupStep?.recordedToolCall === false   // text-only model MUST NOT produce tool/call
        && forgeStep?.landed === true;
      report.verdict = ok
        ? 'PASS (identity + raw snapshot only): host instantiated, followup recorded raw events, '
          + 'in-process forged append landed. Downstream consumption and isolation are NOT claimed.'
        : 'FAIL: one or more expected observations were not made';
      report.exitCode = ok ? 0 : 12;
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
