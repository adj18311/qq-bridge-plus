// 诊断 archiveSession 行为 + 列出 workspace，判断测试会话是否真的被归档。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:3080';
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
  const res = await fetch(`${BASE}/api/${e}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'w' + Math.random().toString(36).slice(2, 8), method: e, payload: { args: a } }) });
  return (await res.json()).result;
}

const sid = 'session-53a6812e-5136-41d5-a773-28f5c9670363';
const ar = await rpc('workspace/archiveSession', { request: { sessionId: sid } });
console.log('archive 单条:', JSON.stringify(ar).slice(0, 300));

const ws = await rpc('workspace/list', { request: {} });
console.log('\nworkspaces:');
for (const w of (ws.value?.workspaces ?? [])) {
  console.log(`  ${w.title} | ${w.path} | sessions=${(w.sessionIds ?? []).length}`);
}

const list = await rpc('session/list', { _request: {} });
const items = list.value.items;
console.log('\nsession/list 字段样例:', JSON.stringify(items[0]));
const probe = items.filter((s) => /qq-bridge[\\/]state[\\/](e2e|probe-015)/.test(String(s.cwd)));
console.log(`\n仍出现在 session/list 的探测会话: ${probe.length}`);
for (const s of probe) console.log('  -', s.sessionId, s.cwd);
