/**
 * 回归测试：deepseek_send_prompt(waitForResult=true) 必须**等这一轮真正结束**才返回，
 * 而且不能返回上一轮的旧回答。
 *
 * 背景（历史缺陷）：
 *   - 旧实现把「订阅事件流」与「session.prompt」并发发起，turn/start 可能在 follow 生效前
 *     就被发走；DSH 的 session/follow 开场只补快照、不回放窗口内事件，于是 turn/end 永远
 *     等不到 → 只能干等到 120 秒超时（DeepSeek 实际 1.2 秒就答完了）。
 *   - 修好后又暴露第二个坑：把本轮自己的 turn/start 也算进 baseline，会让
 *     `turn/end.turn > baseline` 永远不成立。
 *
 * 覆盖三件事：
 *   1. 返回的文本与模型实际回答一致；
 *   2. 用时远小于超时（证明是真等到结果，而不是等到超时才放弃）；
 *   3. 第二轮拿到的是**新一轮**的回答（baseline 正确，不返回上一轮）。
 *
 * 代价：会创建 1 个临时会话、发 2 次 prompt（各一次模型调用），结束时归档该会话。
 * 只想做零成本的前置探测，请跑 test-deepseek-harness-mcp.mjs。
 *
 * 用法：node scripts/test-deepseek-harness-wait.mjs
 *      DSH_MCP_DEBUG=1 可看到桥接内部的事件/轮询轨迹（stderr）。
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp-deepseek-harness.js');
const NODE = process.execPath;
const TIMEOUT_MS = 45_000;

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`OK   ${label}${detail ? ' — ' + detail : ''}`); }
  else { fail += 1; console.error(`FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};

const child = spawn(NODE, [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, DSH_BASE_URL: process.env.DSH_BASE_URL || 'http://127.0.0.1:19387', ...(process.env.DSH_MCP_DEBUG ? { DSH_MCP_DEBUG: '1' } : {}) },
});
child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
let seq = 0;
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => reject(new Error('rpc timeout ' + method)), TIMEOUT_MS + 30_000);
});
const toolText = (r) => (r?.content ?? []).map((c) => c.text ?? '').join('\n');
const callTool = async (name, args) => {
  const raw = toolText(await rpc('tools/call', { name, arguments: args }));
  try { return JSON.parse(raw); } catch { return { __raw: raw }; }
};

let sessionId;
try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-wait-test', version: '1.0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  const created = await callTool('deepseek_create_session', {
    cwd: path.join(os.tmpdir(), 'dsh-wait-test-' + Date.now()),
    agentPreset: 'minimal',
  });
  sessionId = created.sessionId;
  check('创建临时会话', typeof sessionId === 'string' && sessionId.startsWith('session-'), String(sessionId));

  const rounds = [
    { prompt: '请只回复六个字：桥接修复成功', expect: '桥接修复成功' },
    { prompt: '请只回复三个字：第二轮', expect: '第二轮' },
  ];
  for (const [index, round] of rounds.entries()) {
    const t0 = Date.now();
    const out = await callTool('deepseek_send_prompt', {
      sessionId,
      prompt: round.prompt,
      waitForResult: true,
      timeoutMs: TIMEOUT_MS,
    });
    const ms = Date.now() - t0;
    const text = out?.result?.text ?? '';
    check(`第${index + 1}轮：文本与模型回答一致`, text === round.expect, JSON.stringify(text));
    check(`第${index + 1}轮：用时远小于超时`, ms < TIMEOUT_MS / 2, `${ms}ms / 超时 ${TIMEOUT_MS}ms`);
    check(`第${index + 1}轮：结果标注了来源`, out?.result?.source === 'event' || out?.result?.source === 'poll', String(out?.result?.source));
    if (index > 0) check('第2轮没有返回第1轮的旧回答', text !== rounds[0].expect, JSON.stringify(text));
  }
} catch (error) {
  fail += 1;
  console.error('FAIL 等待回复往返测试异常:', error?.message ?? error);
} finally {
  if (sessionId) {
    try { await callTool('deepseek_archive_session', { sessionId }); console.log(`(已归档临时会话 ${sessionId})`); } catch {}
  }
  child.kill();
}

console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
