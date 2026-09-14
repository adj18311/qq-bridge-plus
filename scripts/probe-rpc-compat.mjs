// 对比探测：逐条验证桥接实际使用的 RPC 参数形状在新版 DSH 上是否被接受。
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
  const j = await r.json();
  const slot = j.result;
  if (slot?.ok) return { ok: true, value: slot.value };
  return { ok: false, code: slot?.error?.code, msg: slot?.error?.message };
}

function report(label, r, extra = '') {
  if (r.ok) console.log(`  ✅ ${label} ${extra}`);
  else console.log(`  ❌ ${label} -> ${r.code}: ${r.msg}`);
  return r;
}

// 只报告字段校验结果，不打印敏感内容
function shapeOf(r) {
  if (!r.ok) return '';
  const v = r.value;
  if (v === null || v === undefined) return 'value=null';
  if (Array.isArray(v)) return `array(${v.length})`;
  return 'keys=' + Object.keys(v).slice(0, 12).join(',');
}

console.log('=== 1. session/create（桥接用 { cwd }） ===');
const cwd = path.join(process.cwd(), 'state', 'probe-015');
fs.mkdirSync(cwd, { recursive: true });
const created = report('session/create {cwd}', await rpc('session/create', { request: { cwd } }), '(待清理)');
const sessionId = created.ok ? created.value.sessionId : null;

console.log('\n=== 2. session/create 带 agentPreset（preset 是否存在 + 是否接受该字段） ===');
const createdPreset = report('session/create {cwd, agentPreset:"qq-chat-v2"}', await rpc('session/create', { request: { cwd, agentPreset: 'qq-chat-v2' } }));
const presetSessionId = createdPreset.ok ? createdPreset.value.sessionId : null;

console.log('\n=== 3. session/selectModel（桥接用 {sessionId, provider, model, reasoningEffort}） ===');
if (sessionId) {
  report('selectModel deepseek-official/deepseek-flash/max',
    await rpc('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } }));
  report('selectModel 旧模型 deepseek-v4-flash-vision-exp（应仍可用或报错）',
    await rpc('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp', reasoningEffort: 'max' } }));
}

console.log('\n=== 4. session/prompt（桥接用 {sessionId, mode:"queue", content:[{type:"text",text}]} + requestId） ===');
if (sessionId) {
  report('prompt 无 requestId',
    await rpc('session/prompt', { request: { sessionId, mode: 'queue', content: [{ type: 'text', text: '只回复：ok' }] } }));
  report('prompt 带 requestId',
    await rpc('session/prompt', { request: { sessionId, requestId: 'probe-' + Date.now(), mode: 'queue', content: [{ type: 'text', text: '只回复：ok' }] } }), shapeOf(await rpc('session/prompt', { request: { sessionId, requestId: 'probe2-' + Date.now(), mode: 'queue', content: [{ type: 'text', text: '只回复：ok' }] } })));
}

console.log('\n=== 5. session/list（桥接用 _request 包装） ===');
report('session/list {_request:{}}', await rpc('session/list', { _request: {} }));

console.log('\n=== 6. workspace/*（桥接用于建/查工作区） ===');
report('workspace/list', await rpc('workspace/list', { request: {} }));
report('workspace/create {title}', await rpc('workspace/create', { request: { title: '__probe-015__' } }));

console.log('\n=== 7. agentPresets/list ===');
report('agentPresets/list {}', await rpc('agentPresets/list', {}));

console.log('\n=== 8. settings/describe ===');
report('settings/describe {}', await rpc('settings/describe', {}));

console.log('\n=== 9. session/rename / session/page / session/search ===');
if (sessionId) report('session/rename', await rpc('session/rename', { request: { sessionId, title: '__probe__' } }));
report('session/page', await rpc('session/page', { request: {} }));
report('session/search', await rpc('session/search', { request: { query: 'probe' } }));

console.log('\n=== 清理探测会话 ===');
for (const sid of [sessionId, presetSessionId].filter(Boolean)) {
  const r = await rpc('workspace/archiveSession', { request: { sessionId: sid } });
  console.log(`  archive ${sid}: ${r.ok ? 'ok' : r.code + ' ' + r.msg}`);
}
// 列出 session 里是否还有探测会话
const list = await rpc('session/list', { _request: {} });
if (list.ok) {
  const ids = (list.value.items ?? []).map((i) => i.sessionId);
  console.log('  remaining sessions count:', ids.length);
}
