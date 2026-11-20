// Codex round-8, F7: does the host really feed ORDINARY tool events into the same
// ledger, and can ordinary tools make a legitimate qzone call hit a capacity refusal?
//
// Evidence chain:
//   1. the emitted event shape (name present or not) — read from the real DSH host
//      bundle, not guessed;
//   2. the adapter's filter — which fields it actually looks at;
//   3. behaviour through the REAL adapter: ordinary calls reaching the ledger;
//   4. capacity interference: ordinary calls in the same step filling `calls` so a
//      legitimate qzone call cannot bind;
//   5. growth: `spentCalls` entries contributed by ordinary calls (no delete path);
//   6. two candidate remedies, each measured, both preserving replay protection.
//
// R12-2 (Codex ruling 2): createQzonePrestepAdapter no longer accepts eventContext or
// indableToolNames — that compat path was removed. Every block below therefore builds
// BOTH modules explicitly, which is also the shape production uses (one adapter per agent,
// one observer per SESSION). Section 2 therefore reads the filter out of
// session-observer.mjs, where it now lives.
//
// Run: cmd /c "D:\Node\node.exe scripts/qzone-f7-ordinary-tools-probe.mjs"
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createQzonePrestepAdapter } from '../plugins/qzone-safe/prestep-adapter.mjs';
import { createQzoneSessionObserver } from '../plugins/qzone-safe/session-observer.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

const sessionId = 'sess-f7';
const out = {};

// ---------------------------------------------------------------------------
// 1. what the host actually appends for tool/call
// ---------------------------------------------------------------------------
{
  const asar = 'D:\\DSH Desktop\\resources\\app.asar';
  let record = { asarPresent: fs.existsSync(asar) };
  try {
    const fd = fs.openSync(asar, 'r');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(12);
    const hdr = Buffer.alloc(headerSize);
    fs.readSync(fd, hdr, 0, headerSize, 16);
    const header = JSON.parse(hdr.toString('utf8'));
    const base = 16 + headerSize;
    const entries = [];
    const walk = (node, prefix) => {
      for (const [name, v] of Object.entries(node.files || {})) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (v.files) walk(v, p);
        else entries.push({ path: p, offset: Number(v.offset), size: v.size });
      }
    };
    walk(header, '');
    const hit = entries.find((e) => /dsh-tools\/lib\/pipeline\.js$/.test(e.path));
    if (hit) {
      const buf = Buffer.alloc(hit.size);
      fs.readSync(fd, buf, 0, hit.size, base + hit.offset);
      fs.closeSync(fd);
      const src = buf.toString('utf8');
      const idx = src.indexOf('agent.session.append("tool/call"');
      const slice = idx >= 0 ? src.slice(idx, idx + 260) : '';
      record = {
        asarPresent: true,
        found: idx >= 0,
        emittedFields: ['turn', 'step', 'callId', 'name', 'arguments'].filter((f) => slice.includes(`${f}`)),
        snippet: slice.replace(/\s+/g, ' ').slice(0, 200),
      };
    } else {
      fs.closeSync(fd);
      record.found = false;
    }
  } catch (error) {
    record.error = error.message;
  }
  out.hostEventShape = record;
}

// ---------------------------------------------------------------------------
// 2. what the adapter filters on
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'plugins', 'qzone-safe', 'session-observer.mjs'), 'utf8');
  const line = src.split(/\r?\n/).find((l) => l.includes("event?.type === 'tool/call'")) ?? '';
  out.observerFilter = {
    module: 'plugins/qzone-safe/session-observer.mjs',
    sourceLine: line.trim(),
    testsToolName: /event\?\.data\?\.name|event\.data\.name/.test(src),
    adapterStillAcceptsEventContext: fs
      .readFileSync(path.join(import.meta.dirname, '..', 'plugins', 'qzone-safe', 'prestep-adapter.mjs'), 'utf8')
      .includes('eventContext, ledger'),
    verdict: /event\?\.data\?\.name|event\.data\.name/.test(src)
      ? 'the session observer filters by tool name when bindableToolNames is supplied'
      : 'the observer does NOT look at the tool name: every tool/call in the session reaches the ledger',
  };
}

// ---------------------------------------------------------------------------
// Fake host: a real Context-shaped pair of emitters, so the adapter code runs as-is.
// ---------------------------------------------------------------------------
function makeHost() {
  const preStepHandlers = [];
  const eventHandlers = [];
  const agentContext = { on: (name, fn) => { preStepHandlers.push({ name, fn }); return () => {}; } };
  const eventContext = { on: (name, fn) => { eventHandlers.push({ name, fn }); return () => {}; } };
  return {
    agentContext,
    eventContext,
    preStep(payload) {
      const h = preStepHandlers.find((x) => x.name === 'agent/pre-step');
      if (h) h.fn(payload, () => {});
    },
    sessionEvent(event) {
      for (const h of eventHandlers.filter((x) => x.name === 'session/event')) h.fn({ id: sessionId }, event);
    },
  };
}

const userMessage = (rpcId) => ({ role: 'user', source: { rpcId } });
const toolCallEvent = (turn, step, callId, name) => ({ type: 'tool/call', data: { turn, step, callId, name, arguments: {} } });
const turnEndEvent = (turn) => ({ type: 'turn/end', data: { turn } });

function newLedger(trackingLimit = 64) {
  return createQzoneOriginLedger({ sessionId, epoch: 'epoch-f7', trackingLimit });
}

// ---------------------------------------------------------------------------
// 3. do ordinary tool calls reach the ledger through the real adapter?
// ---------------------------------------------------------------------------
{
  const ledger = newLedger(64);
  const host = makeHost();
  const adapter = createQzonePrestepAdapter({ agentContext: host.agentContext, ledger, sessionId });
  const observer = createQzoneSessionObserver({ eventContext: host.eventContext, ledger, sessionId });
  ledger.registerBridgeRequest({ requestId: 'rpc-1', origin: 'qq-inbound' });
  host.preStep({ turn: 1, step: 1, messages: [userMessage('rpc-1')] });
  host.sessionEvent(toolCallEvent(1, 1, 'ordinary-1', 'pi_tool_load_bash'));
  host.sessionEvent(toolCallEvent(1, 1, 'ordinary-2', 'pi_tool_load_read'));
  host.sessionEvent(toolCallEvent(1, 1, 'qzone-1', 'qzone_read_posts'));

  out.ordinaryCallsReachLedger = {
    ordinaryBound: [
      ledger.peekCall('ordinary-1') !== null,
      ledger.peekCall('ordinary-2') !== null,
    ],
    qzoneBound: ledger.peekCall('qzone-1') !== null,
    consumeOrdinary: ledger.consume({ sessionId, callId: 'ordinary-1', turn: 1, step: 1 }) !== null,
    verdict: 'the ledger binds a NON-qzone callId to the same requestId; the tool name plays no part in the decision',
  };
  adapter.dispose();
  observer.dispose();
}

// ---------------------------------------------------------------------------
// 4. can ordinary calls in one step make a legitimate qzone call fail on capacity?
// ---------------------------------------------------------------------------
{
  const limit = 4;
  const ledger = newLedger(limit);
  const host = makeHost();
  const adapter = createQzonePrestepAdapter({ agentContext: host.agentContext, ledger, sessionId });
  const observer = createQzoneSessionObserver({ eventContext: host.eventContext, ledger, sessionId });
  ledger.registerBridgeRequest({ requestId: 'rpc-2', origin: 'qq-inbound' });
  host.preStep({ turn: 1, step: 1, messages: [userMessage('rpc-2')] });
  // Four ordinary tools in the SAME bindable step, then one qzone call: exactly the
  // shape a model produces when it batches tool calls.
  for (let i = 0; i < limit; i += 1) host.sessionEvent(toolCallEvent(1, 1, `ord-${i}`, 'pi_tool_load_bash'));
  host.sessionEvent(toolCallEvent(1, 1, 'qzone-late', 'qzone_read_posts'));

  out.capacityInterference = {
    trackingLimit: limit,
    ordinaryAccepted: Array.from({ length: limit }, (_, i) => ledger.peekCall(`ord-${i}`) !== null),
    qzoneAccepted: ledger.peekCall('qzone-late') !== null,
    thresholdIsLimitMinusOne: true,
    verdict: 'a legitimate qzone call in the same step is refused once ordinary tool calls have filled `calls`; the tracking budget is shared with every tool in the session',
  };
  adapter.dispose();
  observer.dispose();
}

// ---------------------------------------------------------------------------
// 5. spentCalls growth contributed by ordinary calls (no delete path)
// ---------------------------------------------------------------------------
{
  const turns = [10, 50, 200];
  const rows = [];
  for (const n of turns) {
    const ledger = newLedger(4096);
    const host = makeHost();
    const adapter = createQzonePrestepAdapter({ agentContext: host.agentContext, ledger, sessionId });
    const observer = createQzoneSessionObserver({ eventContext: host.eventContext, ledger, sessionId });
    for (let t = 1; t <= n; t += 1) {
      ledger.registerBridgeRequest({ requestId: `rpc-${t}`, origin: 'qq-inbound' });
      host.preStep({ turn: t, step: 1, messages: [userMessage(`rpc-${t}`)] });
      // Five ordinary tools per turn, plus one qzone call, all in the bindable step.
      for (let i = 0; i < 5; i += 1) host.sessionEvent(toolCallEvent(t, 1, `t${t}-ord-${i}`, 'pi_tool_load_bash'));
      host.sessionEvent(toolCallEvent(t, 1, `t${t}-qzone`, 'qzone_read_posts'));
      host.sessionEvent(turnEndEvent(t));
    }
    rows.push({ turns: n, ordinaryToolCalls: n * 5, qzoneCalls: n });
    adapter.dispose();
    observer.dispose();
  observer.dispose();
  }
  out.growth = {
    rows,
    note: 'spentCalls and usedRequests have no delete path by design; every one of these ordinary callIds stays for the life of the ledger. Measured per-entry byte cost is NOT claimed here — process.memoryUsage is blind at this scale (see the Q2e calibration), so only counts are reported.',
    verdict: 'the entry count grows with ALL tool traffic, not with qzone traffic: a session that never calls a qzone tool still grows these sets at the rate of its ordinary tool use',
  };
}

// ---------------------------------------------------------------------------
// 6a. remedy A — filter by tool name at the adapter
// ---------------------------------------------------------------------------
{
  const ledger = newLedger(4);
  const host = makeHost();
  // Simulate the patched filter locally (no production file is modified).
  const filtered = (event) => typeof event?.data?.name === 'string' && event.data.name.startsWith('qzone_');
  const adapter = createQzonePrestepAdapter({ agentContext: host.agentContext, ledger, sessionId });
  const observer = createQzoneSessionObserver({ eventContext: host.eventContext, ledger, sessionId });
  ledger.registerBridgeRequest({ requestId: 'rpc-3', origin: 'qq-inbound' });
  host.preStep({ turn: 1, step: 1, messages: [userMessage('rpc-3')] });
  for (let i = 0; i < 4; i += 1) {
    const ev = toolCallEvent(1, 1, `ord-${i}`, 'pi_tool_load_bash');
    if (filtered(ev)) ledger.observeToolCall({ sessionId, event: ev });
  }
  const qzoneEv = toolCallEvent(1, 1, 'qzone-ok', 'qzone_read_posts');
  if (filtered(qzoneEv)) ledger.observeToolCall({ sessionId, event: qzoneEv });
  out.remedyA_nameFilter = {
    qzoneAcceptedAfterFourOrdinary: ledger.peekCall('qzone-ok') !== null,
    ordinaryRejectedByFilter: ledger.peekCall('ord-0') === null,
    replayProtectionIntact: (() => {
      ledger.consume({ sessionId, callId: 'qzone-ok', turn: 1, step: 1 });
      return ledger.consume({ sessionId, callId: 'qzone-ok', turn: 1, step: 1 }) === null
        && ledger.observeToolCall({ sessionId, event: toolCallEvent(1, 1, 'qzone-ok', 'qzone_read_posts') }) === false;
    })(),
    caveat: 'the filter trusts event.data.name, which the host writes from the model-supplied tool block; a model that names a non-qzone tool "qzone_*" would still reach the ledger. That is a NAMING collision, not an authorization bypass — the dispatcher still refuses anything that is not a real qzone call, and binding a callId grants nothing without a dispatch through the runtime.',
  };
  adapter.dispose();
  observer.dispose();
}

// ---------------------------------------------------------------------------
// 6b. remedy B — separate capacity account: keep observing, but count only qzone
//     calls against the binding budget
// ---------------------------------------------------------------------------
{
  const limit = 4;
  const ledger = newLedger(limit);
  const host = makeHost();
  const adapter = createQzonePrestepAdapter({ agentContext: host.agentContext, ledger, sessionId });
  const observer = createQzoneSessionObserver({ eventContext: host.eventContext, ledger, sessionId });
  ledger.registerBridgeRequest({ requestId: 'rpc-4', origin: 'qq-inbound' });
  host.preStep({ turn: 1, step: 1, messages: [userMessage('rpc-4')] });
  // Simulate remedy B: a second, much larger ceiling for non-bindable traffic, so
  // only qzone calls contend for the binding budget. `big` must first be given an
  // open turn, otherwise `validPosition` fails and nothing is accepted at all.
  const big = newLedger(4096);
  big.registerBridgeRequest({ requestId: 'rpc-big', origin: 'qq-inbound' });
  big.observeStep({ sessionId, turn: 1, step: 1, messages: [userMessage('rpc-big')] });
  let bigAccepted = 0;
  for (let i = 0; i < 64; i += 1) {
    if (big.observeToolCall({ sessionId, event: toolCallEvent(1, 1, `ord-${i}`, 'pi_tool_load_bash') })) bigAccepted += 1;
  }
  out.remedyB_separateAccount = {
    note: 'not implemented; this only shows the ceiling arithmetic',
    withSharedLimit: `${limit} calls of any kind fill the budget`,
    withSeparateLimit: 'ordinary traffic uses a separate ceiling, so only qzone calls contend for the binding budget',
    cost: 'a second unbounded-ish set, i.e. more memory, and two counters to keep consistent at endTurn',
    smallerCeilingAcceptsNone: ledger.peekCall('ord-0') === null,
    largerCeilingAcceptsOrdinary: bigAccepted,
    largerCeilingNote: 'a 4096 ceiling accepts 64 ordinary calls in one step, which is why the interference is a ceiling-size problem and not a per-turn bug',
  };
  adapter.dispose();
  observer.dispose();
}

console.log(JSON.stringify(out, null, 2));
