// 读取 DSH 的 settings/describe，列出所有 namespace 与可选模型（只读）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';

function discoverToken() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const logsDir = path.join(home, 'guard', 'logs');
  let files;
  try {
    files = fs.readdirSync(logsDir).filter((n) => /^server-.*\.out\.log$/.test(n))
      .map((n) => ({ n, m: fs.statSync(path.join(logsDir, n)).mtimeMs })).sort((a, b) => b.m - a.m);
  } catch { return ''; }
  for (const { n } of files) {
    try { const m = fs.readFileSync(path.join(logsDir, n), 'utf8').match(/[?&]token=([A-Za-z0-9_-]+)/); if (m) return m[1]; } catch {}
  }
  return '';
}

const token = process.argv[2] || discoverToken();
const res = await fetch(`${BASE}/?token=${token}`, { redirect: 'manual' });
const cookie = res.headers.get('set-cookie').split(';')[0];

async function rpc(endpoint, args) {
  const r = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'p' + Math.random().toString(36).slice(2, 8), method: endpoint, payload: { args } })
  });
  return r.json();
}

const out = await rpc('settings/describe', {});
const namespaces = out.result.value.namespaces;
console.log('=== settings namespaces ===');
for (const ns of namespaces) console.log(' -', ns.ns, '| value:', JSON.stringify(ns.value)?.slice(0, 200));

const modelNs = namespaces.find((n) => n.ns === 'agent-default-model');
if (modelNs) {
  console.log('\n=== agent-default-model schema (JSON) ===');
  console.log(JSON.stringify(modelNs.schema, null, 2).slice(0, 4000));
}

// dump full describe to a file for inspection
fs.writeFileSync(path.join(process.cwd(), 'state', 'dsh-settings-describe.json'), JSON.stringify(out, null, 2));
console.log('\n[saved] state/dsh-settings-describe.json');

// try to find model list namespaces
const presets = await rpc('agentPresets/list', {});
fs.writeFileSync(path.join(process.cwd(), 'state', 'dsh-agent-presets.json'), JSON.stringify(presets, null, 2));
console.log('[saved] state/dsh-agent-presets.json');
console.log('presets:', presets.result.value.presets.map((p) => p.id).join(', '));
