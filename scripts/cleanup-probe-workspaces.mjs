// 删除本次适配探测自动创建的测试工作区（state/e2e、state/probe-015）。
// workspace/list 在 DSH 0.1.5 不是可用 RPC（404），因此工作区清单直接从
// ~/.dsh/storages/workspace.json 读取，再用 workspace/delete 删除。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:3080';
const ROOT = process.cwd();
const STORE = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json');
const TEST_PATHS = [
  path.join(ROOT, 'state', 'e2e'),
  path.join(ROOT, 'state', 'probe-015'),
];

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
  const res = await fetch(`${BASE}/api/${e}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'd' + Math.random().toString(36).slice(2, 8), method: e, payload: { args: a } }) });
  const text = await res.text();
  try { return JSON.parse(text).result; } catch { return { ok: false, error: { code: `http-${res.status}`, message: text.slice(0, 120) } }; }
}

const store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
const workspaces = Object.entries(store.tables.workspaces ?? {}).map(([id, w]) => ({ workspaceId: id, ...w }));
console.log(`storage 中共 ${workspaces.length} 个 workspace：`);
for (const w of workspaces) console.log(`  - ${w.title} | ${w.path} | sessions=${(w.sessionIds ?? []).length}`);

const targets = workspaces.filter((w) => TEST_PATHS.some((p) => path.resolve(String(w.path)) === path.resolve(p)));
console.log(`\n匹配到的测试 workspace: ${targets.length}`);

let ok = 0;
for (const w of targets) {
  const r = await rpc('workspace/delete', { request: { workspaceId: w.workspaceId } });
  if (r.ok) {
    ok += 1;
    const n = (r.value?.archivedSessionIds ?? []).length;
    console.log(`  ✅ 已删除 ${w.title}（级联归档会话 ${n} 个）`);
  } else {
    console.log(`  ❌ 删除失败 ${w.title}: ${r.error?.code} ${r.error?.message}`);
  }
}
console.log(`\n已删除 ${ok}/${targets.length}`);
