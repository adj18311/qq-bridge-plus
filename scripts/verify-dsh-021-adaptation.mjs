// Live DSH compatibility check. Only a disposable workspace/session is mutated.
// The probe has no QQ session token and must not call any QQ tools.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NodeApiClient, unwrap, createTurnCollector } from '../src/dsh-client.js';

const root = path.resolve(import.meta.dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
let base = process.env.DSH_BASE_URL || cfg.dsh.baseUrl;
const api = new NodeApiClient(base, 10000, { tokenExplicit: false });
const expectedText = '兼容通过';
const probePreset = process.argv[2] ?? 'qq-chat-v2';
assert.ok(['qq-chat', 'qq-chat-v2', 'standard'].includes(probePreset), 'supported probe presets: qq-chat, qq-chat-v2, standard');
const results = [];
let sessionId;
let workspaceId;
let probeDir;
let streamController;
let streamTask;

function check(label, condition, detail = '') {
  assert.ok(condition, `${label}${detail ? `: ${detail}` : ''}`);
  results.push(label);
  console.log(`PASS ${label}${detail ? ` (${detail})` : ''}`);
}

async function timeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function readyEvents() {
  await api.ensureAuth();
  const url = new URL('/api/remote.mux', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url, { headers: { cookie: api.cookie } });
  const streamId = randomUUID();
  try {
    return await timeout(new Promise((resolve, reject) => {
      socket.addEventListener('open', () => socket.send(JSON.stringify({
        type: 'open', streamId, endpoint: '$events', payload: { args: {} },
      })));
      socket.addEventListener('message', (event) => {
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
        if (frame.streamId !== streamId) return;
        if (frame.type === 'item' && frame.value?.type === 'ready') resolve(frame.value);
        if (frame.type === 'error') reject(new Error(`$events: ${frame.error?.code}`));
      });
      socket.addEventListener('error', () => reject(new Error('$events socket failed')));
      socket.addEventListener('close', () => reject(new Error('$events closed before ready')));
    }), 10000, '$events ready');
  } finally { socket.close(); }
}

try {
  let settingsResponse;
  try { settingsResponse = await api.settings.describe({}); }
  catch (error) {
    if (cfg.dsh.autoDiscoverDesktop === false || !await api.refreshDesktopEndpoint()) throw error;
    base = api.resolveBase();
    settingsResponse = await api.settings.describe({});
    console.log(`RECOVERED desktop endpoint ${base}`);
  }
  const settings = unwrap(settingsResponse, 'settings.describe');
  check('Cookie auth and qq-mode settings', settings.namespaces?.some((ns) => ns.ns === 'qq-mode'));
  const presets = unwrap(await api.agentPresets.list({}), 'agentPresets.list').presets;
  check('QQ presets registered', ['qq-chat', 'qq-chat-v2'].every((id) => presets.some((p) => p.id === id)));
  const sessions = unwrap(await api.sessions.list({}), 'session.list');
  check('Existing sessions readable', Array.isArray(sessions.items), `${sessions.items?.length} sessions`);
  const models = unwrap(await api.callUnary('session/modelCatalog', {}), 'session/modelCatalog');
  check('Model catalog readable', Array.isArray(models.groups), `${models.groups?.length} groups`);
  const ready = await readyEvents();
  check('$events ready frame', typeof ready.clientId === 'string');

  probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-021-live-'));
  const workspace = unwrap(await api.workspace.create({ path: probeDir }), 'workspace.create');
  workspaceId = workspace.workspace.workspaceId;
  check('Disposable workspace created', typeof workspaceId === 'string');
  const created = unwrap(await api.sessions.create({ workspaceId, agentPreset: probePreset }), 'session.create');
  sessionId = created.sessionId;
  check('Preset session created', typeof sessionId === 'string', probePreset);
  unwrap(await api.sessions.selectModel({
    sessionId, provider: cfg.dsh.provider, model: cfg.dsh.model, reasoningEffort: cfg.dsh.reasoningEffort,
  }), 'session.selectModel');
  check('Configured model selected', true, `${cfg.dsh.provider}/${cfg.dsh.model}`);
  const projection = unwrap(await api.callUnary('session/projections', { sessionId }), 'session/projections');
  check('Inbox projection readable', projection?.values?.inbox !== undefined);

  streamController = new AbortController();
  const stream = api.events.mux({}, streamController.signal);
  stream.follow(sessionId);
  const collector = createTurnCollector();
  const toolNames = new Set();
  let calls = 0;
  let resolveSnapshot;
  const snapshot = new Promise((resolve) => { resolveSnapshot = resolve; });
  let resolveTurn;
  let rejectTurn;
  const turn = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  // Attach rejection handlers before any RPC can fail.
  turn.catch(() => {});
  streamTask = (async () => {
    try {
      for await (const envelope of stream) {
        const frame = envelope.payload;
        if (frame.sessionId !== sessionId) continue;
        if (frame.type === 'session/snapshot') { resolveSnapshot(frame.snapshot); continue; }
        if (frame.type !== 'session/event') continue;
        const event = frame.event;
        if (event.type === 'request/header') {
          for (const tool of event.data?.header?.tools ?? []) toolNames.add(tool.name);
        }
        if (event.type === 'tool/call') calls++;
        const ended = collector.push(event);
        if (ended) { resolveTurn(ended); return; }
      }
      if (!streamController.signal.aborted) rejectTurn(new Error('Event stream ended before turn/end'));
    } catch (error) {
      if (!streamController.signal.aborted) rejectTurn(error);
    }
  })();
  const initial = await timeout(snapshot, 10000, 'session/follow snapshot');
  check('Session snapshot received before prompt', initial?.type === 'snapshot');
  unwrap(await api.sessions.prompt({
    sessionId, mode: 'queue', content: [{ type: 'text', text:
      `这是隔离的 DSH 兼容性自检，不是 QQ 对话。不要调用任何工具，不要读取文件或会话，也不要发 QQ 消息。只输出四个字：${expectedText}` }],
  }), 'session.prompt');
  const ended = await timeout(turn, 90000, 'model response');
  check('Model turn completed', ended.reason.kind === 'completed', JSON.stringify(ended.reason));
  check('Assistant text collected once', ended.text.trim() === expectedText, ended.text.trim());
  check('Probe made no tool calls', calls === 0, `${calls} calls`);
  check('Actual model tool schema captured', toolNames.size > 0, `${toolNames.size} tools`);
  const allowed = (name) => ['ask_user_question', 'todo_write'].includes(name)
    || ['mcp__snowluma__', 'mcp__snowluma-host__', 'mcp__web-search-safe__'].some((prefix) => name.startsWith(prefix));
  const unexpected = [...toolNames].filter((name) => !allowed(name));
  if (probePreset === 'standard') {
    check('Ordinary DSH sessions retain native Team tools', toolNames.has('spawn_teammate') && toolNames.has('team_task_list'));
  } else {
    check('Actual QQ schema excludes local/session/team tools', unexpected.length === 0, unexpected.join(', '));
  }
  check('QQ send, memory and safe web tools retained', [
    'mcp__snowluma__qq_send_message', 'mcp__snowluma__qq_memory_append', 'mcp__web-search-safe__web_fetch',
  ].every((name) => toolNames.has(name)));
  const stopped = await api.stopSessionWork(sessionId, AbortSignal.timeout(10000));
  check('Session queue cleanup and cancellation', typeof stopped.removed === 'number');
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  streamController?.abort();
  await streamTask;
  if (sessionId) {
    try {
      unwrap(await api.callUnary('session/cancel', { sessionId }), 'session/cancel');
      unwrap(await api.workspace.archiveSession({ sessionId }), 'workspace.archiveSession');
      console.log('CLEANUP probe session archived');
    } catch (error) { console.error(`CLEANUP FAILED ${error.message}`); process.exitCode = 1; }
  }
  if (workspaceId) {
    try {
      unwrap(await api.callUnary('workspace/delete', { workspaceId }), 'workspace/delete');
      console.log('CLEANUP probe workspace removed');
    } catch (error) { console.error(`CLEANUP FAILED ${error.message}`); process.exitCode = 1; }
  }
  if (probeDir) fs.rmSync(probeDir, { recursive: true, force: true });
}
console.log(`DSH 0.2.1 live compatibility: ${results.length} checks passed; ${process.exitCode ? 'FAILED' : 'PASSED'}.`);
