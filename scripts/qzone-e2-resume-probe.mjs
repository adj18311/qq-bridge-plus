// E2 probe: REAL persistence-backed resume on an isolated host.
//
// What this does (and why it is not an "equivalent construction"):
//   1. Extracts the dependency closure of `@deepseek-ai/dsh-session-persistence-jsonl`
//      out of the local app.asar into a throw-away %TEMP% tree (nothing in the real DSH
//      profile, state dir, or credentials is touched).
//   2. Mounts that backend at a %TEMP% root with `compression: 'none'` on a real Cordis
//      root that also has the real SessionStore/AgentRegistry/AgentLoop/LlmRuntime/
//      ToolRuntime/native executor.
//   3. Creates an agent on a session, runs a REAL turn through the real qzone plugin and
//      the real read-only runtime wiring (fake OneBot client, fake LLM adapter).
//   4. Cleanly disposes the agent, then calls the REAL `agents.resume({ resumeSessionId })`
//      — the persistence-backed entry, not `agents.create` on the same id.
//   5. Dispatches again on the resumed agent and asserts the old bridge requestId cannot
//      be replayed.
//
// Prints one JSON line per assertion group so the report can quote actual readings.
// Usage: node scripts/qzone-e2-resume-probe.mjs [--keep]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ASAR = process.env.DSH_ASAR ?? 'D:/DSH Desktop/resources/app.asar';
const KEEP = process.argv.includes('--keep');
const findings = [];
const note = (name, value) => { findings.push({ name, value }); console.log(`[${name}]`, JSON.stringify(value)); };

// ── 1. archive helpers (same trust boundary as the existing fixture) ────────────────
function openArchive(archive) {
  const fd = fs.openSync(archive, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (fs.readSync(fd, prefix, 0, 16, 0) !== 16 || prefix.readUInt32LE(0) !== 4) throw new Error('invalid asar header');
    const headerLength = prefix.readUInt32LE(12);
    const dataOffset = 8 + prefix.readUInt32LE(4);
    const bytes = Buffer.alloc(headerLength);
    fs.readSync(fd, bytes, 0, bytes.length, 16);
    return { fd, dataOffset, header: JSON.parse(bytes.toString('utf8')) };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function findEntry(header, rel) {
  let cur = header;
  for (const part of rel.split('/')) { cur = cur?.files?.[part]; if (!cur) return null; }
  return cur;
}
function assertInside(root, destination) {
  const relative = path.relative(root, destination);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`refusing path escape: ${destination}`);
  }
}
function assertSafeSegment(segment) {
  if (typeof segment !== 'string' || !segment || segment === '.' || segment === '..' || /[\\/:\0]/u.test(segment)
    || path.posix.isAbsolute(segment) || path.win32.isAbsolute(segment)) {
    throw new Error(`refusing unsafe asar path segment: ${JSON.stringify(segment)}`);
  }
}
function extractTree({ fd, dataOffset }, entry, archivePath, root, sources) {
  const walk = (node, rel) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      assertSafeSegment(name);
      const childPath = `${rel}/${name}`;
      if (child.files) { walk(child, childPath); continue; }
      if (child.link || !Number.isSafeInteger(child.size) || child.size > 8 * 1024 * 1024) continue;
      let bytes;
      if (child.unpacked === true) {
        const unpackedRoot = path.resolve(`${ASAR}.unpacked`);
        const unpackedPath = path.resolve(unpackedRoot, ...childPath.split('/'));
        assertInside(unpackedRoot, unpackedPath);
        bytes = fs.readFileSync(unpackedPath);
      } else {
        bytes = Buffer.alloc(child.size);
        fs.readSync(fd, bytes, 0, bytes.length, dataOffset + Number(child.offset));
      }
      const destination = path.resolve(root, ...childPath.split('/'));
      assertInside(root, destination);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes);
      if (name === 'package.json' || /\.(?:mjs|cjs|js)$/u.test(name)) sources.set(childPath.slice(archivePath.length + 1), bytes.toString('utf8'));
    }
  };
  walk(entry, archivePath);
  return sources;
}
function packageNameOf(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return /^@[\w.-]+\/[\w.-]+$/u.test(name) || /^[\w.-]+$/u.test(name) ? name : null;
}

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-e2-resume-'));
const modulesRoot = path.join(workRoot, 'modules');
const sessionsRoot = path.join(workRoot, 'sessions');
fs.mkdirSync(sessionsRoot, { recursive: true });
note('workRoot', workRoot);

let handle, agentA, agentB, disposeAdapter, offAdapter;
const platformCalls = [];
const outputs = [];
try {
  // ── 2. extract the jsonl backend closure ─────────────────────────────────────────
  const archive = openArchive(ASAR);
  const queue = ['@deepseek-ai/dsh-session-persistence-jsonl'];
  const seen = new Set();
  const missing = [];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const asarPath = `dsh/node_modules/${name}`;
    const entry = findEntry(archive.header, asarPath);
    if (!entry?.files) { missing.push(name); continue; }
    const sources = extractTree(archive, entry, asarPath, modulesRoot, new Map());
    for (const [rel, source] of sources) {
      if (rel === 'package.json') {
        const metadata = JSON.parse(source);
        for (const dep of Object.keys(metadata.dependencies ?? {})) queue.push(dep);
        for (const dep of Object.keys(metadata.peerDependencies ?? {})) queue.push(dep);
      }
      for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/gu)) {
        const dep = packageNameOf(match[1]);
        if (dep && !seen.has(dep)) queue.push(dep);
      }
    }
  }
  fs.closeSync(archive.fd);
  note('backendClosure', { packages: seen.size, missing });
  const backendEntry = path.join(modulesRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'index.js');
  assert.equal(fs.existsSync(backendEntry), true, 'jsonl backend entry must exist after extraction');
  const backend = await import(pathToFileURL(backendEntry).href);
  note('backendImport', { name: backend.name, apply: typeof backend.apply });

  // ── 3. real host, same component set as the offline chain test ───────────────────
  const { loadOfflineHostFixture } = await import('./qzone-host-prestep-fixture.mjs');
  const { createQzonePluginHandle } = await import('../plugins/qzone-safe/index.mjs');
  const { createQzoneRuntime } = await import('../src/core/qzone-runtime-wiring.mjs');
  const { openOfflineStore } = await import('../src/core/qzone-store-offline.mjs');
  const { createQzoneConnectionSourceCoordinator } = await import('../src/core/qzone-connection-source-coordinator-offline.mjs');
  const { SnowLumaWebSocketClient } = await import('@snowluma/sdk');

  const h = await loadOfflineHostFixture();
  const { cordis, session, projection, agent, agentLoop, llm, tools, systemPrompt, nativeExecutor } = h;
  const root = new cordis.Context();
  const now = Date.parse('2026-11-11T04:00:00Z');
  const initialState = { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true }, reads: 0, writes: 0, readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-11', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {}, activeStart: 0, activeEnd: 1439, audit: [] };
  const store = openOfflineStore(path.join(workRoot, 'state.db'), initialState);
  class NeverConnect {}
  const fakeClient = new SnowLumaWebSocketClient({ webSocket: NeverConnect, reconnect: false });
  fakeClient.getLoginInfo = async () => ({ user_id: 123 });
  fakeClient.request = async (action) => {
    platformCalls.push(action);
    if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
    if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
    if (action === 'get_qzone_msg_list') return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
    throw new Error(`unexpected fake action ${action}`);
  };
  const coordinator = createQzoneConnectionSourceCoordinator({ client: fakeClient, expectedUserId: 123 });
  const platformReads = () => platformCalls.filter((action) => action === 'get_qzone_msg_list').length;

  const modelQueue = [];
  class Scripted extends llm.LlmAdapter {
    providerInfo(p) { return { id: p, name: p }; }
    resolveModel(p, m) { return Promise.resolve({ provider: p, id: m, name: m }); }
    async *stream() {
      const step = modelQueue.shift() ?? { kind: 'text' };
      if (step.kind === 'tool') {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: step.callId, name: 'qzone_read_posts', arguments: '{"target_uin":456}' } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'done' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }

  try {
    fakeClient.emitter.emit('open');
    assert.equal(await coordinator.verify(), true, '前提：离线来源通过校验');
    for (const plugin of [projection.SessionProjectionRegistry, session.SessionStore, agent.AgentRegistry,
      systemPrompt.SystemPrompt, llm.LlmRuntime, tools.ToolRuntime, nativeExecutor, agentLoop.AgentLoop]) root.plugin(plugin);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Mount the REAL jsonl persistence backend at the temp root, before any agent exists.
    const backendFiber = root.plugin({ name: backend.name, apply: backend.apply },
      { root: sessionsRoot, compression: 'none' });
    await backendFiber.await();
    const persistence = root.get('sessionPersistence');
    note('persistenceMounted', { kind: typeof persistence, identity: typeof persistence?.identity });
    note('persistenceRoot', sessionsRoot);

    const capturedTools = new Map();
    const pluginCtx = {
      on: (name, fn) => root.on(name, fn),
      tools: { register: (definition) => { capturedTools.set(definition.name, definition); return root.get('tools').register(definition); } },
    };
    const runtime = createQzoneRuntime({ store, botQq: 123, sourceEpoch: coordinator.sourceEpoch(),
      authorizeSource: (c) => coordinator.ownsConsumption(c), getConnectionEpoch: coordinator.connectionEpoch,
      getBridgeSessions: () => null, clock: () => now, mode: 'read-only',
      call: (action, params) => fakeClient.request(action, params) });
    handle = await createQzonePluginHandle(pluginCtx, { enabled: true },
      { epoch: coordinator.sourceEpoch(), sourceLifetime: coordinator, defineTool: tools.defineTool,
        dispatch: async (...args) => { const out = await runtime.dispatch(...args); outputs.push(out); return out; } });
    assert.equal(handle.status().state, 'enabled-dispatch-ready');
    offAdapter = root.get('llm').registerAdapter(['offline'], new Scripted());
    const S = 'e2-resume-session';

    // ── 4. first life: create → real turn → clean dispose ────────────────────────
    agentA = await root.get('agents').create({ sessionId: S, agentOptions: { provider: 'offline', model: 'fixture' } });
    assert.equal(agentA.agent.session.id, S);
    const readsBefore = platformReads();
    handle.registerBridgeRequest(S, { requestId: 'e2-rpc-1', origin: 'qq-inbound' });
    modelQueue.push({ kind: 'tool', callId: 'e2-call-1' }, { kind: 'text' });
    agentA.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user', rpcId: 'e2-rpc-1' } }));
    await agentA.agent.whenIdle();
    note('firstLife.dispatch', { outputs: outputs.slice(-1), platformReadsDelta: platformReads() - readsBefore, status: handle.status(S).dispatchAvailable });
    assert.equal(platformReads(), readsBefore + 1, '第一个生命必须真的走到平台读');
    assert.deepEqual(outputs.at(-1), { ok: true, outcome: 'success', posts: [] });

    await agentA.dispose();
    agentA = null;
    note('afterCleanDispose', { adapters: handle.status(S).agentAdapters, dispatchAvailable: handle.status(S).dispatchAvailable, blocked: handle.status(S).adaptersBlocked });

    // The backend must actually hold a durably stored session now.
    const listed = await persistence.list?.();
    const stat = await persistence.stat?.(S).catch((error) => ({ error: error.message }));
    note('storedSession', { stat: stat ?? null, hasList: typeof persistence.list === 'function' });

    // ── 5. REAL resume (persistence-backed, not create-on-same-id) ───────────────
    let resumeError = null;
    try {
      agentB = await root.get('agents').resume({ resumeSessionId: S, agentOptions: { provider: 'offline', model: 'fixture' } });
    } catch (error) { resumeError = error.message; }
    note('resume', resumeError === null
      ? { ok: true, agentId: agentB.agent.id, sessionId: agentB.agent.session.id, restoredEvents: agentB.agent.session.log.length }
      : { ok: false, error: resumeError });
    assert.equal(resumeError, null, `真实 resume 必须成功，实际抛：${resumeError}`);

    // ── 6. dispatch on the resumed agent ─────────────────────────────────────────
    const readsBeforeResume = platformReads();
    handle.registerBridgeRequest(S, { requestId: 'e2-rpc-2', origin: 'qq-inbound' });
    modelQueue.push({ kind: 'tool', callId: 'e2-call-2' }, { kind: 'text' });
    agentB.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user', rpcId: 'e2-rpc-2' } }));
    await agentB.agent.whenIdle();
    note('resumedDispatch', { outputs: outputs.slice(-1), platformReadsDelta: platformReads() - readsBeforeResume, status: handle.status(S).dispatchAvailable });
    assert.equal(platformReads(), readsBeforeResume + 1, 'resume 之后必须真的走到平台读');
    assert.deepEqual(outputs.at(-1), { ok: true, outcome: 'success', posts: [] }, 'resume 之后必须真的派发成功');

    // ── 7. old request must not be replayable across the resume ──────────────────
    let replayError = null;
    try { handle.registerBridgeRequest(S, { requestId: 'e2-rpc-1', origin: 'qq-inbound' }); }
    catch (error) { replayError = error.message; }
    const replayProbe = await capturedTools.get('qzone_read_posts').execute({ target_uin: 456 }, { agent: { session: { id: S } }, callId: 'e2-call-1' });
    note('replayAcrossResume', { registerThrew: replayError, dispatch: replayProbe });
    assert.equal(replayProbe.ok, false, 'resume 之前的旧 callId 不得再派发');
    assert.equal(replayProbe.error, 'origin-unbound');

    assert.equal(store.read().writes, 0, 'write-not-wired 全程成立');
    note('verdict', { e2: 'REAL persistence-backed resume PASSED on isolated host', writes: store.read().writes });
  } finally {
    await handle?.dispose?.();
    coordinator.dispose();
    try { await agentB?.dispose?.(); } catch {}
    try { await agentA?.dispose?.(); } catch {}
    try { offAdapter?.(); } catch {}
    await root.dispose?.();
    h.close();
    store.close();
  }
} catch (error) {
  note('probeError', { message: error.message, stack: (error.stack ?? '').split('\n').slice(0, 4) });
  process.exitCode = 1;
} finally {
  if (KEEP) console.log('[kept]', workRoot);
  else fs.rmSync(workRoot, { recursive: true, force: true });
}
console.log('\nJSON ' + JSON.stringify({ findings }));
