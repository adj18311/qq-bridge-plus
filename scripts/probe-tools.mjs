// 端到端验证 QQ preset 的「工具面」与「工具协议」：
//  1. 建会话挂 preset（qq-chat / qq-chat-v2）
//  2. 注入一条 prompt，要求 agent 调 mcp__snowluma-host__snowluma_status（不依赖 SnowLuma 在线）
//  3. 观测 turn 事件里的 tool/call 与 tool/result，确认 MCP 工具真的可调用
//  4. 同时确认本地危险工具（pwsh/bash 等）不在工具面里
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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

const PRESET = process.argv[2] || 'qq-chat';
const dir = path.join(process.cwd(), 'state', 'e2e');
fs.mkdirSync(dir, { recursive: true });
const ws = await rpc('workspace/create', { request: { path: dir } });
const wsId = ws.value.workspace.workspaceId;
const model = await rpc('session/selectModel', { request: { sessionId: 'x', provider: 'x', model: 'x' } }); // 仅探测形状，忽略

const sc = await rpc('session/create', { request: { workspaceId: wsId, agentPreset: PRESET } });
if (!sc.ok) { console.error(`❌ preset ${PRESET} 挂载失败: ${sc.error.code}: ${sc.error.message}`); process.exit(2); }
const sessionId = sc.value.sessionId;
console.log(`session ${sessionId} (preset=${PRESET})`);

// 模型切换（桥接 ensureChatModel 的等价操作）
const sm = await rpc('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } });
console.log('selectModel ->', sm.ok ? JSON.stringify(sm.value.selected) : `FAIL ${sm.error.code}: ${sm.error.message}`);

const url = new URL('/api/remote.mux', BASE); url.protocol = 'ws:';
const socket = new WebSocket(url, { headers: { cookie } });
const streamId = randomUUID();
const eventStreamId = randomUUID();
const toolCalls = [];
const toolResults = [];
let text = '';

const done = new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 120_000);
  const finish = (why) => { clearTimeout(timer); resolve(why); };
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } }));
    socket.send(JSON.stringify({ type: 'open', streamId: eventStreamId, endpoint: '$events', payload: { args: {} } }));
    setTimeout(async () => {
      const p = await rpc('session/prompt', {
        request: {
          sessionId, requestId: randomUUID(), mode: 'queue',
          content: [{ type: 'text', text: '请调用 mcp__snowluma-host__snowluma_status 工具一次，然后只回复：完成' }]
        }
      });
      console.log('prompt ->', JSON.stringify(p).slice(0, 120));
    }, 700);
  });
  socket.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== 'item' || m.streamId === eventStreamId) return;
    const v = m.value;
    if (v?.type !== 'event') return;
    const e = v.event;
    if (e.type === 'assistant/message') for (const b of e.data?.message?.content ?? []) if (b?.type === 'text') text += b.text;
    if (e.type === 'tool/call') toolCalls.push({ name: e.data?.name ?? e.data?.toolName, args: e.data?.arguments ?? e.data?.args });
    if (e.type === 'tool/result') toolResults.push({ name: e.data?.name ?? e.data?.toolName, isError: e.data?.isError ?? e.data?.error !== undefined });
    if (e.type === 'turn/end') finish('done');
  });
  socket.addEventListener('close', () => finish('closed'));
  socket.addEventListener('error', () => finish('error'));
});

const why = await done;
console.log(`\n结果: ${why}`);
console.log('最终文本:', JSON.stringify(text.slice(0, 200)));
console.log('tool/call:', JSON.stringify(toolCalls));
console.log('tool/result:', JSON.stringify(toolResults));

const calledMcp = toolCalls.some((c) => String(c.name).startsWith('mcp__snowluma-host__'));
const calledLocal = toolCalls.some((c) => /^(pwsh|bash|write|edit|read|glob|grep)$/.test(String(c.name)));
console.log('\n判定:');
console.log(`  MCP 工具可调用          : ${calledMcp ? '✅' : '❌ 未观测到 mcp__snowluma-host__ 调用'}`);
console.log(`  未调用本地危险工具      : ${calledLocal ? '❌ 出现了本地工具调用' : '✅'}`);

try { socket.close(); } catch {}
await rpc('workspace/archiveSession', { request: { sessionId } });
console.log('[cleanup] archived');
process.exit(calledMcp && !calledLocal ? 0 : 1);
