// 修复：探测过程中把用户的「QQ 聊天」工作区误改名为 __probe_title__，改回原名，
// 并归档探测时在其中误建的会话（workspace.create 之后 sessions.create 之前那次调用）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:3080';
const ROOT = process.cwd();
const STORE = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json');

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
  const res = await fetch(`${BASE}/api/${e}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'f' + Math.random().toString(36).slice(2, 8), method: e, payload: { args: a } }) });
  const text = await res.text();
  try { return JSON.parse(text).result; } catch { return { ok: false, error: { code: `http-${res.status}`, message: text.slice(0, 120) } }; }
}

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const wantTitle = cfg.workspaceTitle || 'QQ 聊天';
const agentsPath = path.join(ROOT, 'state', 'agents');

const store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
const workspaces = Object.entries(store.tables.workspaces ?? {}).map(([id, w]) => ({ workspaceId: id, ...w }));

const target = workspaces.find((w) => path.resolve(String(w.path)) === path.resolve(agentsPath));
if (!target) { console.log('找不到 state/agents 对应的工作区'); process.exit(0); }

console.log(`找到工作区: id=${target.workspaceId} title="${target.title}" path=${target.path}`);

if (target.title !== wantTitle) {
  const r = await rpc('workspace/rename', { request: { workspaceId: target.workspaceId, title: wantTitle } });
  console.log(r.ok ? `✅ 标题已改回「${r.value.workspace.title}」` : `❌ 改名失败: ${r.error?.code} ${r.error?.message}`);
} else {
  console.log(`✅ 标题已是「${wantTitle}」，无需修改`);
}

// 归档这个工作区里、且 cwd 指向 state/agents 的会话中，来自本次探测的那一个
// （真正属于 QQ 桥接的会话保留；探测会话 mtime 是刚才，且不在 state/sessions.json 里）
let sessionsState = {};
try { sessionsState = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'sessions.json'), 'utf8')); } catch {}
const known = new Set(Object.values(sessionsState.sessions ?? sessionsState ?? {}));
const list = await rpc('session/list', { _request: {} });
const inWs = (list.value?.items ?? []).filter((s) => path.resolve(String(s.cwd)) === path.resolve(agentsPath));
console.log(`\n该工作区内的会话 ${inWs.length} 个：`);
for (const s of inWs) console.log(`  - ${s.sessionId} ${known.has(s.sessionId) ? '(桥接在用，保留)' : '(非桥接会话)'}`);

let archived = 0;
for (const s of inWs) {
  if (known.has(s.sessionId)) continue;
  const r = await rpc('workspace/archiveSession', { request: { sessionId: s.sessionId } });
  if (r.ok) { archived += 1; console.log(`  ✅ 归档探测会话 ${s.sessionId}`); }
  else console.log(`  ❌ 归档失败 ${s.sessionId}: ${r.error?.message}`);
}
console.log(`\n已归档 ${archived} 个探测会话`);
