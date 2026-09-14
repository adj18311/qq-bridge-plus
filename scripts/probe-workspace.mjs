// 验证 workspace/session RPC 参数形状与返回值结构（对照 bridge.js 实际用法）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';
function tok() {
  const d = path.join(os.homedir(), '.dsh', 'guard', 'logs');
  try {
    const f = fs.readdirSync(d).filter((n) => /^server-.*\.out\.log$/.test(n))
      .map((n) => ({ n, m: fs.statSync(path.join(d, n)).mtimeMs })).sort((a, b) => b.m - a.m);
    for (const { n } of f) { try { const m = fs.readFileSync(path.join(d, n), 'utf8').match(/[?&]token=([A-Za-z0-9_-]+)/); if (m) return m[1]; } catch {} }
  } catch {}
  return '';
}
const t = tok();
const r0 = await fetch(`${BASE}/?token=${t}`, { redirect: 'manual' });
const cookie = r0.headers.get('set-cookie').split(';')[0];
async function rpc(e, a) {
  const r = await fetch(`${BASE}/api/${e}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'x' + Math.random().toString(36).slice(2, 8), method: e, payload: { args: a } }) });
  return (await r.json()).result;
}
const sh = (r, n = 400) => r.ok ? JSON.stringify(r.value).slice(0, n) : `${r.error.code}: ${r.error.message}`;

const dir = path.join(process.cwd(), 'state', 'agents');
fs.mkdirSync(dir, { recursive: true });

console.log('=== workspace/create {path} ===');
const ws = await rpc('workspace/create', { request: { path: dir } });
console.log('  ', sh(ws));
const wsId = ws.ok ? ws.value.workspace.workspaceId : null;
console.log('   created =', ws.ok ? ws.value.created : 'n/a');

console.log('\n=== workspace/create 幂等（第二次） ===');
const ws2 = await rpc('workspace/create', { request: { path: dir } });
console.log('   created =', ws2.ok ? ws2.value.created : sh(ws2), '| same id =', ws2.ok && ws2.value.workspace.workspaceId === wsId);

console.log('\n=== workspace/rename {workspaceId,title} ===');
console.log('  ', sh(await rpc('workspace/rename', { request: { workspaceId: wsId, title: '__probe_title__' } })));

console.log('\n=== session/create {workspaceId} 无 preset ===');
const s1 = await rpc('session/create', { request: { workspaceId: wsId } });
console.log('  ', sh(s1));
const sid = s1.ok ? s1.value.sessionId : null;

console.log('\n=== session/create {workspaceId, agentPreset: 不存在的名字} 看报错形态 ===');
console.log('  ', sh(await rpc('session/create', { request: { workspaceId: wsId, agentPreset: '__nope__' } }), 200));

console.log('\n=== session/list 结构（bridge 用 items） ===');
const list = await rpc('session/list', { _request: {} });
console.log('   keys =', list.ok ? Object.keys(list.value).join(',') : sh(list));
if (list.ok) console.log('   item0 keys =', Object.keys(list.value.items?.[0] ?? {}).join(','));

console.log('\n=== session/selectModel 返回结构（bridge 读 result.selected） ===');
const sm = await rpc('session/selectModel', { request: { sessionId: sid, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } });
console.log('  ', sh(sm, 300));

console.log('\n=== session/prompt 返回结构（bridge 读 accepted） ===');
console.log('  ', sh(await rpc('session/prompt', { request: { sessionId: sid, requestId: 'pr-' + Date.now(), mode: 'queue', content: [{ type: 'text', text: '只回复：pong' }] } }), 200));

console.log('\n=== session/page（bridge 是否用到结构） ===');
console.log('  ', sh(await rpc('session/page', { request: { sessionId: sid } }), 200));

console.log('\n=== 清理：archive ===');
console.log('  ', sh(await rpc('workspace/archiveSession', { request: { sessionId: sid } })));
