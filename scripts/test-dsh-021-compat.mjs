// DSH 0.2.1 regression checks. Offline fixtures contain only synthetic tools.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';
import { collectDshToolNames } from './dsh-tool-names.mjs';
import { apply } from '../plugins/qq-agent-presets/qq-tool-restrict.mjs';
import { NodeApiClient } from '../src/dsh-client.js';

function writeAsar(file, sources) {
  const tree = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const [name, text] of Object.entries(sources)) {
    const names = name.split('/');
    let parent = tree;
    for (const part of names.slice(0, -1)) {
      parent.files[part] ??= { files: {} };
      parent = parent.files[part];
    }
    const buffer = Buffer.from(text);
    parent.files[names.at(-1)] = { size: buffer.length, offset: String(offset) };
    chunks.push(buffer);
    offset += buffer.length;
  }
  const header = Buffer.from(JSON.stringify(tree));
  const padding = (4 - (header.length % 4)) % 4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + header.length + padding, 4);
  prefix.writeUInt32LE(4 + header.length + padding, 8);
  prefix.writeUInt32LE(header.length, 12);
  fs.writeFileSync(file, Buffer.concat([prefix, header, Buffer.alloc(padding), ...chunks]));
}

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-021-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('tool inventory reads 0.2.1 ASAR sources and nested preset patches', (t) => {
  const dir = sandbox(t);
  const asarPath = path.join(dir, 'app.asar');
  writeAsar(asarPath, {
    'dsh/node_modules/@deepseek-ai/dsh-tool-terminal/lib/index.js':
      'ctx.tools.register(defineTool({ name: "terminal_open", execute() {} }));',
    'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/test.patch.yml':
      '- id: external-agent\n  config:\n    toolName: subagent_codex\n',
    'unrelated/index.js': 'defineTool({ name: "unrelated_tool" })',
  });
  const inventory = collectDshToolNames({ packagesDir: dir, pluginDirs: [], asarPath });
  assert.ok(inventory.names.has('terminal_open'), 'ASAR tool must not silently disappear');
  assert.ok(inventory.names.has('subagent_codex'), 'nested patch toolName must be scanned');
  assert.ok(!inventory.names.has('unrelated_tool'), 'scan only the DSH package subtree');
  assert.ok(inventory.packages.includes('dsh-tool-terminal'));
});

test('explicit malformed ASAR fails instead of reporting an empty successful scan', (t) => {
  const dir = sandbox(t);
  const asarPath = path.join(dir, 'app.asar');
  fs.writeFileSync(asarPath, 'not an ASAR');
  assert.throws(() => collectDshToolNames({ packagesDir: dir, pluginDirs: [], asarPath }), /ASAR/i);
});

test('tool inventory follows a linked plugin directory', (t) => {
  const dir = sandbox(t);
  const plugins = path.join(dir, 'plugins');
  const real = path.join(dir, 'actual-plugin');
  fs.mkdirSync(plugins);
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'index.mjs'),
    'ctx.tools.register(defineTool({ name: "agent_teams_create" }));');
  fs.symlinkSync(real, path.join(plugins, 'team-plugin'), process.platform === 'win32' ? 'junction' : 'dir');
  const inventory = collectDshToolNames({ packagesDir: path.join(dir, 'absent'), pluginDirs: [plugins] });
  assert.ok(inventory.names.has('agent_teams_create'));
});

test('tool inventory follows a linked package inside an npm scope', (t) => {
  const dir = sandbox(t);
  const plugins = path.join(dir, 'plugins');
  const scope = path.join(plugins, '@vendor');
  const real = path.join(dir, 'actual-plugin');
  fs.mkdirSync(scope, { recursive: true });
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'index.mjs'), 'return defineTool({ name: "ssh_download" });');
  fs.symlinkSync(real, path.join(scope, 'ssh'), process.platform === 'win32' ? 'junction' : 'dir');
  const inventory = collectDshToolNames({ packagesDir: path.join(dir, 'absent'), pluginDirs: [plugins] });
  assert.ok(inventory.names.has('ssh_download'));
});

const newRestricted = [
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  'working_directory', 'create_worktree', 'wait_agent', 'plugin_market',
  'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read',
  'agent_teams_create', 'agent_teams_approve', 'agent_teams_send_message',
  'ssh_exec', 'ssh_download', 'ssh_upload', 'ssh_tunnel', 'ssh_cluster', 'ssh_list',
];

test('QQ presets hide and deny 0.2.1 local/session/team capabilities', () => {
  const denied = new Set();
  let guard;
  apply({ tools: {
    restrict({ deny }) { deny.forEach((name) => denied.add(name)); },
    guard(fn) { guard = fn; },
  } });
  for (const name of newRestricted) {
    assert.ok(denied.has(name), `${name} must be hidden from the QQ tool schema`);
    assert.equal(typeof guard({ name }), 'string', `${name} must also be denied at execution`);
  }
  for (const name of ['ask_user_question', 'todo_write', 'mcp__snowluma__qq_memory_append',
    'mcp__snowluma__qq_send_message', 'mcp__web-search-safe__web_fetch']) {
    assert.ok(!denied.has(name));
    assert.equal(guard({ name }), undefined);
  }
});

test('QQ personas assemble with only the variables provided by DSH 0.2.1', () => {
  for (const id of ['qq-chat', 'qq-chat-v2']) {
    const source = yaml.load(fs.readFileSync(new URL(`../dsh/agent-presets/${id}/agent.cordis.yml`, import.meta.url), 'utf8'));
    const persona = source.find((row) => row.id === 'persona').config;
    const variables = [...`${persona.prefix}\n${persona.suffix ?? ''}`.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1]);
    assert.ok(variables.every((name) => ['provider', 'model'].includes(name)),
      `${id}: DSH 0.2.1 only registers provider/model; unsupported variables: ${variables.join(', ')}`);
  }
});

test('desktop port recovery verifies candidates and preserves desired subscriptions', async (t) => {
  const dir = sandbox(t);
  const previousHome = process.env.DSH_HOME;
  const previousFetch = globalThis.fetch;
  process.env.DSH_HOME = dir;
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });
  const checked = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    checked.push(url.origin);
    const envelope = JSON.parse(init.body);
    const result = url.port === '41002'
      ? { ok: true, value: { namespaces: [{ ns: 'qq-mode' }] } }
      : { ok: true, value: { namespaces: [{ ns: 'unrelated-profile' }] } };
    return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result });
  };
  const api = new NodeApiClient('http://127.0.0.1:19387', 1000, {
    discoverDesktopOrigins: async () => ['https://remote.invalid', 'http://127.0.0.1:41001', 'http://127.0.0.1:41002'],
  });
  api.events.follow('existing-session');
  assert.equal(typeof api.refreshDesktopEndpoint, 'function', 'client must recover a random desktop port');
  assert.equal(await api.refreshDesktopEndpoint(), true);
  assert.equal(api.resolveBase(), 'http://127.0.0.1:41002');
  assert.deepEqual(checked, ['http://127.0.0.1:41001', 'http://127.0.0.1:41002']);
  assert.ok(api._desiredFollows.has('existing-session'));
});

test('desktop discovery never redirects an explicitly remote DSH connection', async () => {
  let discovered = false;
  const api = new NodeApiClient('https://remote.invalid', 1000, {
    discoverDesktopOrigins: async () => { discovered = true; return ['http://127.0.0.1:41002']; },
  });
  assert.equal(typeof api.refreshDesktopEndpoint, 'function');
  assert.equal(await api.refreshDesktopEndpoint(), false);
  assert.equal(discovered, false);
  assert.equal(api.resolveBase(), 'https://remote.invalid');
});

for (const [status, code] of [[401, 'http-401'], [403, 'http-403']]) {
  test(`desktop recovery reports a real HTTP ${status} auth failure as unauthorized`, async (t) => {
    const dir = sandbox(t);
    const previousHome = process.env.DSH_HOME;
    const previousFetch = globalThis.fetch;
    process.env.DSH_HOME = dir;
    t.after(() => {
      globalThis.fetch = previousFetch;
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
    });
    const diagnostics = [];
    let probed = 0;
    globalThis.fetch = async () => {
      probed += 1;
      return new Response(JSON.stringify({ error: 'sensitive auth fixture' }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    };
    const api = new NodeApiClient('http://127.0.0.1:19387', 1000, {
      onDesktopDiagnostic: (event) => diagnostics.push(event),
      discoverDesktopOrigins: async () => ['http://127.0.0.1:41001'],
    });
    assert.equal(await api.refreshDesktopEndpoint(), false);
    assert.ok(probed > 0, 'the discovered local candidate must be probed');
    assert.equal(api.resolveBase(), 'http://127.0.0.1:19387');
    const unauthorized = diagnostics.filter((event) => event?.reason === 'unauthorized');
    assert.ok(unauthorized.length > 0, 'a 401/403 probe must not be reported as a generic failure');
    const probe = unauthorized.find((event) => event.phase === 'probe');
    assert.ok(probe, 'diagnostic phase must be probe');
    assert.equal(probe.code, code);
    const serialized = JSON.stringify(diagnostics);
    assert.ok(!serialized.includes('transport failure'), 'raw transport message must not surface');
    assert.ok(!serialized.includes('sensitive auth fixture'), 'auth response fixture must not leak');
  });
}

test('native team tools are excluded only from QQ presets, including late-created agents', async () => {
  const mod = await import('../plugins/qq-agent-presets/qq-team-tools-context.mjs').catch(() => null);
  assert.equal(typeof mod?.qqFilteredTeamContext, 'function', 'QQ team-scope adapter is required');
  const qq = { session: { header: { agentPreset: 'qq-chat-v2' } } };
  const ordinary = { session: { header: { agentPreset: 'standard' } } };
  let created;
  const original = { agents: { list: () => [qq, ordinary] },
    on(event, callback) { assert.equal(event, 'agent/created'); created = callback; return 'disposer'; },
    agentTeams: { marker: true },
  };
  const filtered = mod.qqFilteredTeamContext(original);
  assert.deepEqual(filtered.agents.list(), [ordinary]);
  assert.equal(filtered.agentTeams, original.agentTeams);
  const seen = [];
  assert.equal(filtered.on('agent/created', (event) => seen.push(event.agent)), 'disposer');
  created({ agent: qq });
  created({ agent: ordinary });
  assert.deepEqual(seen, [ordinary]);
  assert.deepEqual(original.agents.list(), [qq, ordinary], 'other consumers must retain their original service');
});

test('QQ restrictions follow tools registered after preset startup without recursive notifications', () => {
  const available = new Set(['working_directory']);
  const denied = new Set();
  let changed;
  apply({
    on(event, callback) { assert.equal(event, 'tools/change'); changed = callback; },
    tools: {
      view: () => ({ restrictableNames: available }),
      restrict({ deny }) {
        for (const name of deny) {
          assert.ok(available.has(name), 'only currently registered global names may be restricted');
          assert.ok(!denied.has(name), 'must not add recursive duplicate restrictions');
          denied.add(name);
        }
        changed?.();
      },
      guard() {},
    },
  });
  assert.ok(denied.has('working_directory'));
  available.add('ssh_exec');
  available.add('future_local_tool');
  available.add('mcp__snowluma__qq_memory_append');
  assert.equal(typeof changed, 'function', 'late registrations must trigger a restriction refresh');
  changed();
  assert.ok(denied.has('ssh_exec'));
  assert.ok(denied.has('future_local_tool'));
  assert.ok(!denied.has('mcp__snowluma__qq_memory_append'));
});

test('native Team adapter loads through the DSH loader, not external Node resolution', async () => {
  const mod = await import('../plugins/qq-agent-presets/qq-native-team-filter.mjs').catch(() => null);
  assert.equal(typeof mod?.apply, 'function', 'external plugin must load without resolving ASAR-only packages in Node');
  assert.ok(mod.inject.includes('sessionProjections'), 'the QQ filter reads the current preset projection');
  let installed;
  const ctx = {
    loader: { async import(name) {
      assert.equal(name, '@deepseek-ai/dsh-experimental-tool-agent-team');
      return { apply(context, config) { installed = { context, config }; } };
    } },
    agents: { list: () => [] },
    on() {},
  };
  const config = { freshProvider: 'spawn', forkProvider: 'fork', interrupt: true };
  await mod.apply(ctx, config);
  assert.equal(installed.config, config);
  assert.deepEqual(installed.context.agents.list(), []);
});
