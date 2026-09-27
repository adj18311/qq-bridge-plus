// DSH 适配总验证（0.1.5 建立，0.1.7 迁移后继续沿用文件名以免打断既有调用）：
// 一次性跑完所有关键断言，输出 PASS/FAIL 清单。
// 不依赖 SnowLuma；不修改任何状态（探测会话会被 archive）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { dshModulesDir } from './dsh-modules.mjs';
import { discoverDshSessionCookie } from '../src/dsh-client.js';

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

// ── 2. 部署侧：DSH 0.1.7 的 preset 机制 ──────────────────────────────────────
// 0.1.5 时这一节比的是 ~/.dsh/.agent-presets/<p>/ 下的安装副本；0.1.7 起该目录
// **完全不再被读取**（注册表既不扫目录也不接受 preset 路径），preset 变成 bundle
// patch 插入的一条 @deepseek-ai/dsh-agent-preset 行。因此这里改成核对：
//   ① bundle patch 与仓库权威源一致（生成器 --check，防手改/忘重新生成）；
//   ② bundle 已注册进 profile（link: 依赖 + bundles + node_modules junction，
//      守卫行的裸说明符就靠这个 junction 解析）；
//   ③ 守卫实现只有一份且 fail-closed。
const norm = (s) => s.replace(/\r\n/g, '\n');
const presetPatches = await import(pathToFileURL(path.join(ROOT, 'scripts/build-agent-preset-patches.mjs')).href);
for (const { file, changed } of presetPatches.buildPatches({ check: true, log: () => {} })) {
  check(`${path.relative(ROOT, file)} 与仓库源一致（未漂移）`, !changed);
}
for (const p of ['qq-chat', 'qq-chat-v2']) {
  const doc = yaml.load(fs.readFileSync(presetPatches.patchFileFor(p), 'utf8'));
  const row = doc?.[0]?.insert?.[0];
  check(`patch ${p}: 是 @deepseek-ai/dsh-agent-preset 行`, row?.name === '@deepseek-ai/dsh-agent-preset');
  check(`patch ${p}: config.id = ${p}`, row?.config?.id === p);
  const source = yaml.load(fs.readFileSync(path.join(ROOT, 'dsh/agent-presets', p, 'agent.cordis.yml'), 'utf8'));
  const srcPersona = source.find((r) => r.id === 'persona');
  const patchPersona = (row?.config?.plugins ?? []).find((r) => r.id === 'persona');
  check(`patch ${p}: persona.prefix 与源逐字一致`, norm(srcPersona?.config?.prefix ?? '') === norm(patchPersona?.config?.prefix ?? ''));
  const guardRow = (row?.config?.plugins ?? []).find((r) => r.id === 'qq-tool-restrict');
  check(`patch ${p}: 守卫行用 Profile 目录可解析的裸说明符`, guardRow?.name === presetPatches.GUARD_SPECIFIER);
}

// 守卫脚本必须是 fail-closed 的：非法工具名要被拒绝，而不是放行（权威实现只有一份）。
const canonicalGuardPath = path.join(ROOT, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
const guard = fs.readFileSync(canonicalGuardPath, 'utf8');
// 断言只看**可执行代码**：守卫的注释里会写「cordis_define/… 在 0.1.7 已被删除」做历史说明，
// 直接扫原文会把这段说明误判成「还在使用旧工具名」（实测误报）。必须**先剥块注释**
// （/∗ … ∗/ 与 JSDoc 的 ` * ` 行）**再剥行注释**，否则块注释里的旧名仍会被扫到。
// 剥行注释必须按 /\r?\n/ 切行：JS 的 `.` 不匹配 \r，CRLF 下 split('\n') 会让行尾留 \r，
// /\/\/.*$/ 的 `$` 够不到行尾。
const guardCode = guard
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
check('守卫：非法工具名 fail-closed（不接受裸 return 放行）', !/typeof name !== 'string'[^\n]*\)\s*return\s*$/m.test(guardCode));
check('守卫：不额外放行 web_search/web_fetch', !/'(?:web_search|web_fetch)'/.test(guardCode));
check('守卫：拒绝 0.1.7 已删除的 cordis 旧工具名（避免静默失效）', !/cordis_(?:define|undefine|run|stop)/.test(guardCode));

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
// 只看可执行代码，忽略注释（注释里会提到旧名做历史说明）。
// 注意必须按 /\r?\n/ 切行：JS 的 `.` 不匹配 \r，CRLF 文件直接 split('\n') 会让行尾留 \r，
// 导致 /\/\/.*$/ 的 `$` 够不到行尾、注释根本剥不掉（曾因此误报）。
const stripComments = (src) => src.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const bridgeCode = stripComments(bridgeSrc);
check('bridge.js 可执行代码无 deepseek-v4-flash-vision-exp 残留', !bridgeCode.includes('deepseek-v4-flash-vision-exp'));
check('bridge.js 可执行代码无 router-standard 残留', !bridgeCode.includes('router-standard'));
// setup-dsh.mjs 曾被漏改：0.1.5 适配只清了 bridge.js，脚本里仍在写死已下线的 preset 名。
const setupCode = stripComments(fs.readFileSync(path.join(ROOT, 'scripts/setup-dsh.mjs'), 'utf8'));
check('setup-dsh.mjs 可执行代码无 router-standard 残留', !setupCode.includes('router-standard'));
check('setup-dsh.mjs 新装默认 closedAgentPreset 留空（交给 DSH 默认 preset）', /closedAgentPreset:\s*''/.test(setupCode));
check('bridge.js 默认模型为 deepseek-flash', /model:\s*'deepseek-flash'/.test(bridgeCode));
check('bridge.js 不再有「无参创建会话」兜底', !/sessions\.create\(\{\}\)/.test(bridgeCode));
check('bridge.js 含 preset 清单/默认 preset 解析', bridgeSrc.includes('resolvePresetName') && bridgeSrc.includes('refreshPresetList'));

// 安全不变量回归防线：群聊/仿真会话在 preset 缺失时必须 fail-closed。
// 旧实现会在 preset 不在 DSH 清单里时静默回退到 DSH 默认 preset（standard，含 bash/
// 文件读写），把本地工具暴露给 QQ 群 —— 与 RULES.md「无本地工具」的承诺直接矛盾。
check('preset 解析带 strict 开关', /resolvePresetName\(name, \{ strict = false \} = \{\}\)/.test(bridgeCode));
check('非 closed-agent 模式以 strict 解析 preset', /resolvePresetName\(wanted, \{ strict: true \}\)/.test(bridgeCode));
check('群聊模式缺少 preset 时拒绝建会话（fail-closed）', /strictPreset && !preset/.test(bridgeCode));
check('群聊模式不再重试「无 preset」建会话', /strictPreset \? \[true\] : \[true, false\]/.test(bridgeCode));

// ── 3b. 版本身份一致性 ──────────────────────────────────────────────────────
// v0.1.5 曾带着自称 0.1.2-alpha.1 的 package-lock.json 发布出去（package.json 却是
// 0.1.5），三个 MCP server 的 serverInfo.version 也停在 0.1.0。版本漂移没有防线就会
// 复发，这里把「所有对外自称的版本号必须等于 package.json」固定下来。
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lockJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const pluginPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/qq-mode-console/package.json'), 'utf8'));
check('package-lock.json 顶层 version 与 package.json 一致', lockJson.version === pkgJson.version, `lock=${lockJson.version} pkg=${pkgJson.version}`);
check('package-lock.json packages[""] version 与 package.json 一致', lockJson.packages?.['']?.version === pkgJson.version, `lock=${lockJson.packages?.['']?.version}`);
check('qq-mode-console 插件版本与主包一致', pluginPkg.version === pkgJson.version, `plugin=${pluginPkg.version}`);
for (const f of ['src/mcp-snowluma-safe.js', 'src/mcp-host-server.js', 'src/mcp-web-search-safe.js']) {
  const m = /new McpServer\(\{[^}]*version:\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  check(`${f} 的 MCP serverInfo.version 与主包一致`, m?.[1] === pkgJson.version, `声明=${m?.[1]} 主包=${pkgJson.version}`);
}

// ── 4. 语法检查 ─────────────────────────────────────────────────────────────
for (const f of ['src/bridge.js', 'src/dsh-client.js', 'src/mcp-snowluma-safe.js', 'src/mcp-host-server.js', 'src/mcp-web-search-safe.js', 'src/slang-learner.js', 'src/self-test.js', 'scripts/setup-dsh.mjs']) {
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
  check(`${f} 语法正确`, r.status === 0, (r.stderr || '').split('\n')[0]);
}

// ── 5. 运行中的 DSH（0.1.7）─────────────────────────────────────────────────
// 鉴权改用与桥接生产代码同一条路：用 ~/.dsh 里持久化的签名密钥离线铸造会话 Cookie。
// 旧写法是从 ~/.dsh/guard/logs/server-*.out.log 里抓 `?token=`，这条路在 0.1.7 已经死了：
//   · 0.1.7 的进程启动 token 是现生成的 32 字节随机数，只存在内存 WeakMap 里，不落盘；
//   · guard 插件退役后也没有启动器再把 `dsh web` 的 stdout 重定向到那个目录，
//     日志里剩下的是**上一个进程**的陈旧 token，换 Cookie 只会得到 401。
const cookie = discoverDshSessionCookie(BASE);
check('本机签名密钥 → 铸造会话 Cookie 成功', Boolean(cookie), cookie ? `${cookie.length} 字节` : '读不到 browser-session 密钥');
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
// 0.1.7 把设置命名空间从 `agent-presets` 改名为 `agent-preset-registry`，而且「用户默认」
// 是易失字段 selectedDefault，不会出现在 describe 的 value 里。部署默认由 registry 行的
// config.default 决定（dsh-web-app 的 patch 写的是 standard）。桥接在 closedAgentPreset
// 留空时依赖的正是它，所以这里断言「注册表已装载」+「standard 预设存在」这两件可观测的事。
const registryNs = st.value?.namespaces?.find((n) => n.ns === 'agent-preset-registry');
check('DSH 0.1.7 preset 注册表命名空间已装载', registryNs !== undefined, st.value?.namespaces?.map((n) => n.ns).filter((n) => n.includes('preset')).join(', '));
check('closed-agent 兜底所需的 standard 预设可用', presetIds.includes('standard'), presetIds.join(', '));

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
// 用 process.exitCode 而不是 process.exit()：后者会在 undici 的 keep-alive socket
// 仍在关闭途中强行拆掉事件循环，在 Windows 上触发 libuv 断言
// （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c）。
// 结果是「断言全过但退出码非 0」，CI 会误判失败。设 exitCode 让循环自然排空即可。
process.exitCode = fail === 0 ? 0 : 1;
