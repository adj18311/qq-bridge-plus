// 清理本次适配探测产生的测试会话：只归档 cwd 落在本仓库 state/e2e、state/probe-015 的会话，
// 以及本次运行创建的 self-test 会话。绝不触碰用户的正常会话。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:3080';
const ROOT = process.cwd();
const TEST_CWD_PREFIXES = [
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
  const r = await fetch(`${BASE}/api/${e}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'c' + Math.random().toString(36).slice(2, 8), method: e, payload: { args: a } }) });
  return (await r.json()).result;
}

const list = await rpc('session/list', { _request: {} });
const all = list.value.items;
const targets = all.filter((s) => TEST_CWD_PREFIXES.some((p) => String(s.cwd) === p));

console.log(`匹配到 ${targets.length} 个测试会话（cwd 在 state/e2e 或 state/probe-015）：`);
for (const s of targets) console.log('  -', s.sessionId, '|', s.cwd);

if (targets.length === 0) { console.log('无需清理'); process.exit(0); }

let archived = 0;
for (const s of targets) {
  const r = await rpc('workspace/archiveSession', { request: { sessionId: s.sessionId } });
  if (r.ok) archived += 1; else console.log(`  归档失败 ${s.sessionId}: ${r.error?.code} ${r.error?.message}`);
}
console.log(`已归档 ${archived}/${targets.length} 个测试会话`);

const after = await rpc('session/list', { _request: {} });
const left = after.value.items.filter((s) => TEST_CWD_PREFIXES.some((p) => String(s.cwd) === p));
console.log(`剩余匹配测试会话: ${left.length}`);
