// 探测 DSH 0.1.5-rc.1 的 Web API 协议表面（只读，不改动 DSH 状态）。
// 用法: node scripts/probe-015.mjs [launchToken]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';

function discoverToken() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const logsDir = path.join(home, 'guard', 'logs');
  let files;
  try {
    files = fs.readdirSync(logsDir)
      .filter((n) => /^server-.*\.out\.log$/.test(n))
      .map((n) => ({ n, m: fs.statSync(path.join(logsDir, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
  } catch { return ''; }
  for (const { n } of files) {
    try {
      const m = fs.readFileSync(path.join(logsDir, n), 'utf8').match(/[?&]token=([A-Za-z0-9_-]+)/);
      if (m) return m[1];
    } catch {}
  }
  return '';
}

const token = process.argv[2] || discoverToken();
if (!token) { console.error('no launch token'); process.exit(1); }
console.log('launch token:', token.slice(0, 12) + '...');

const res = await fetch(`${BASE}/?token=${token}`, { redirect: 'manual' });
const setCookie = res.headers.get('set-cookie');
if (!setCookie) { console.error('token exchange failed', res.status); process.exit(1); }
const cookie = setCookie.split(';')[0];
console.log('exchange status:', res.status, '| cookie name:', cookie.split('=')[0]);
console.log('');

async function rpc(endpoint, payload, method = 'POST', label = '') {
  const url = `${BASE}/api/${endpoint}`;
  const init = { method, headers: { cookie, 'content-type': 'application/json' } };
  if (method === 'POST') init.body = JSON.stringify(payload);
  let r;
  try { r = await fetch(url, init); } catch (e) { console.log(`  ${endpoint} ${label} -> NETERR ${e.message}`); return null; }
  const text = await r.text();
  let short = text.replace(/\s+/g, ' ').slice(0, 240);
  console.log(`  ${endpoint} ${label} -> ${r.status} ${short}`);
  return { status: r.status, text };
}

const envelope = (method, payload) => ({
  type: 'client-request', rpcId: 'probe-' + Math.random().toString(36).slice(2, 8), method, payload
});

console.log('=== A. 新协议信封 { type:client-request, method, payload:{args:{...}} } ===');
await rpc('session/list', envelope('session/list', { args: { _request: {} } }));
await rpc('agentPresets/list', envelope('agentPresets/list', { args: {} }));
await rpc('settings/describe', envelope('settings/describe', { args: {} }));
await rpc('host/describe', envelope('host/describe', { args: {} }));

console.log('');
console.log('=== B. 裸 payload（无信封） ===');
await rpc('session/list', { args: { _request: {} } });

console.log('');
console.log('=== C. 直接 payload（无 args 包装） ===');
await rpc('session/list', {});

console.log('');
console.log('=== D. 点号方法名 ===');
await rpc('session.list', envelope('session.list', { args: { _request: {} } }));

console.log('');
console.log('=== E. 探测方法名是否存在（用非法参数区分 404 与 400） ===');
for (const m of [
  'session/list', 'session/create', 'session/prompt', 'session/selectModel', 'session/rename',
  'session/fork', 'session/updateQueue', 'session/page', 'session/search', 'session/follow',
  'session/interrupt', 'session/delete', 'session/archive',
  'workspace/list', 'workspace/create', 'workspace/rename', 'workspace/delete',
  'workspace/archiveSession', 'workspace/insertBefore', 'workspace/insertSessionBefore',
  'settings/describe', 'settings/update', 'agentPresets/list',
  'agent/describe', 'model/list', 'models/list', 'host/describe', 'remote/mux', 'events'
]) {
  await rpc(m, envelope(m, { args: {} }));
}
