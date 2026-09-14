// DSH 0.1.5 适配总验证：一次性跑完所有关键断言，输出 PASS/FAIL 清单。
// 不依赖 SnowLuma；不修改任何状态（探测会话会被 archive）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { dshModulesDir } from './dsh-modules.mjs';

const ROOT = process.cwd();
const DSH_MODULES = dshModulesDir();
const DSH_HOME = path.join(os.homedir(), '.dsh');
const BASE = 'http://127.0.0.1:3080';

let pass = 0, fail = 0;
const results = [];
function check(label, cond, extra = '') {
  if (cond) { pass += 1; results.push(`✅ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; results.push(`❌ ${label}${extra ? ' — ' + extra : ''}`); }
  return cond;
}

// ── 1. 仓库侧：preset persona schema ────────────────────────────────────────
const persona = await import(pathToFileURL(path.join(DSH_MODULES, '@deepseek-ai/dsh-persona/lib/index.js')).href);
const YAML = await import(pathToFileURL(path.join(DSH_MODULES, 'js-yaml/index.js')).href);
const yaml = YAML.default ?? YAML;

let oldRejected = false;
try { persona.Config({ text: 'x' }); } catch { oldRejected = true; }
check('dsh-persona 仍拒绝旧字段 text（故障前提成立）', oldRejected);

for (const p of ['qq-chat', 'qq-chat-v2']) {
  const f = path.join(ROOT, 'dsh/agent-presets', p, 'agent.cordis.yml');
  const row = yaml.load(fs.readFileSync(f, 'utf8')).find((r) => r.id === 'persona');
  let schemaOk = false;
  try { persona.Config(row.config); schemaOk = true; } catch {}
  check(`preset ${p}: persona.config 通过 DSH schema`, schemaOk);
  check(`preset ${p}: 保留 {{model}} / {{cwd}} 变量`, /\{\{model\}\}/.test(row.config.prefix) && /\{\{cwd\}\}/.test(row.config.suffix ?? ''));
}

// ── 2. 部署侧：~/.dsh 已同步 ────────────────────────────────────────────────
for (const p of ['qq-chat', 'qq-chat-v2']) {
  const repo = fs.readFileSync(path.join(ROOT, 'dsh/agent-presets', p, 'agent.cordis.yml'), 'utf8');
  const inst = path.join(DSH_HOME, '.agent-presets', p, 'agent.cordis.yml');
  const same = fs.existsSync(inst) && fs.readFileSync(inst, 'utf8') === repo;
  check(`~/.dsh/.agent-presets/${p} 与仓库一致`, same);
}

const patch = fs.readFileSync(path.join(DSH_HOME, 'profiles/web/cordis.patch.yml'), 'utf8');
const patchDoc = yaml.load(patch);
const mcpIds = patchDoc.filter((e) => e?.insert).flatMap((e) => e.insert.map((x) => x.id));
check('profile patch 含 3 个 MCP 且无重复', mcpIds.length === 3 && new Set(mcpIds).size === 3, mcpIds.join(', '));
const snowlumaEntry = patchDoc.filter((e) => e?.insert).flatMap((e) => e.insert).find((x) => x.id === 'mcp-snowluma');
check('mcp-snowluma 带 toolCallTimeoutMs=725000', snowlumaEntry?.config?.toolCallTimeoutMs === 725000);
check('mcp 路径指向本仓库', mcpIds.every((id) => {
  const e = patchDoc.filter((x) => x?.insert).flatMap((x) => x.insert).find((y) => y.id === id);
  return String(e.config.args[0]).includes('qq-bridge');
}));

const pkg = JSON.parse(fs.readFileSync(path.join(DSH_HOME, 'profiles/web/package.json'), 'utf8'));
check('profile bundles 含 qq-mode-console', pkg.dsh.profile.bundles.includes('qq-mode-console'));
check('qq-mode-console link 依赖已注册', String(pkg.dependencies['qq-mode-console'] ?? '').startsWith('link:'));
check('qq-mode-console 已 link 进 node_modules', fs.existsSync(path.join(DSH_HOME, 'profiles/web/node_modules/qq-mode-console')));

// ── 3. 仓库配置：模型 ───────────────────────────────────────────────────────
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
check('config.json dsh.model = deepseek-flash', cfg.dsh?.model === 'deepseek-flash', `当前 ${cfg.dsh?.model}`);
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
// 只看可执行代码，忽略注释（注释里会提到旧名做历史说明）
const bridgeCode = bridgeSrc.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
check('bridge.js 可执行代码无 deepseek-v4-flash-vision-exp 残留', !bridgeCode.includes('deepseek-v4-flash-vision-exp'));
check('bridge.js 可执行代码无 router-standard 残留', !bridgeCode.includes('router-standard'));
check('bridge.js 默认模型为 deepseek-flash', /model:\s*'deepseek-flash'/.test(bridgeCode));
check('bridge.js 不再有「无参创建会话」兜底', !/sessions\.create\(\{\}\)/.test(bridgeCode));
check('bridge.js 含 preset 清单/默认 preset 解析', bridgeSrc.includes('resolvePresetName') && bridgeSrc.includes('refreshPresetList'));

// ── 4. 语法检查 ─────────────────────────────────────────────────────────────
for (const f of ['src/bridge.js', 'src/dsh-client.js', 'src/mcp-snowluma-safe.js', 'src/mcp-host-server.js', 'src/mcp-web-search-safe.js', 'src/slang-learner.js', 'src/self-test.js', 'scripts/setup-dsh.mjs']) {
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
  check(`${f} 语法正确`, r.status === 0, (r.stderr || '').split('\n')[0]);
}

// ── 5. 运行中的 DSH（0.1.5）─────────────────────────────────────────────────
function tok() {
  const d = path.join(DSH_HOME, 'guard', 'logs');
  try {
    const f = fs.readdirSync(d).filter((n) => /^server-.*\.out\.log$/.test(n))
      .map((n) => ({ n, m: fs.statSync(path.join(d, n)).mtimeMs })).sort((a, b) => b.m - a.m);
    for (const { n } of f) { try { const m = fs.readFileSync(path.join(d, n), 'utf8').match(/[?&]token=([A-Za-z0-9_-]+)/); if (m) return m[1]; } catch {} }
  } catch {}
  return '';
}
const t = tok();
const r0 = await fetch(`${BASE}/?token=${t}`, { redirect: 'manual' });
const cookie = r0.headers.get('set-cookie')?.split(';')[0];
check('DSH launch token → Cookie 换取成功', r0.status === 303 && !!cookie, `HTTP ${r0.status}`);
async function rpc(e, a) {
  const r = await fetch(`${BASE}/api/${e}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'v' + Math.random().toString(36).slice(2, 8), method: e, payload: { args: a } }) });
  return (await r.json()).result;
}
const st = await rpc('settings/describe', {});
check('settings/describe 可用', st.ok === true);
const dm = st.value?.namespaces?.find((n) => n.ns === 'agent-default-model');
check('DSH 全局默认模型 = deepseek-flash', dm?.value?.model === 'deepseek-flash', `当前 ${dm?.value?.model}`);
const ap = await rpc('agentPresets/list', {});
const presetIds = ap.value?.presets?.map((p) => p.id) ?? [];
check('agentPresets/list 含 qq-chat 与 qq-chat-v2', presetIds.includes('qq-chat') && presetIds.includes('qq-chat-v2'), presetIds.join(', '));
check('DSH 默认 preset 为 standard（closed-agent 留空时的兜底）', st.value?.namespaces?.find((n) => n.ns === 'agent-presets')?.value?.default === 'standard');

// 点号 endpoint（旧协议）应返回纯文本 404（不是 JSON 信封）——证明协议确为斜杠式
const dotRes = await fetch(`${BASE}/api/session.list`, {
  method: 'POST', headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: 'v-dot', method: 'session.list', payload: { args: { _request: {} } } }),
});
const dotBody = await dotRes.text();
check('点号 endpoint /api/session.list 不可用（旧协议已废弃）', dotRes.status === 404 && /not found/i.test(dotBody), `HTTP ${dotRes.status}`);

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(results.join('\n'));
console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
