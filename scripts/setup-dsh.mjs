#!/usr/bin/env node
// setup-dsh.mjs — 在目标设备上安装 qq-bridge 的 DSH 端配置
//
// 功能：
//   1. 安装两套 agent preset：qq-chat、qq-chat-v2
//   2. 在 DSH profile 的 cordis.patch.yml 中挂载三个 MCP server：
//      mcp-snowluma / mcp-snowluma-host / mcp-web-search-safe
//   3. 在 profile package.json 中注册 qq-mode-console 插件
//
// 用法：
//   node scripts/setup-dsh.mjs [profile]
//
// 默认 profile 为 web；可用环境变量 DSH_HOME 指定 DSH 根目录。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE = process.argv[2] || 'web';

function log(msg) {
  console.log(`[setup-dsh] ${msg}`);
}

function fatal(msg) {
  console.error(`[setup-dsh] ERROR: ${msg}`);
  process.exit(1);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyPreset(name) {
  const src = path.join(REPO_ROOT, 'dsh', 'agent-presets', name);
  const dest = path.join(DSH_HOME, '.agent-presets', name);
  if (!fs.existsSync(src)) fatal(`preset source not found: ${src}`);
  ensureDir(path.dirname(dest));
  fs.cpSync(src, dest, { recursive: true, force: true });
  log(`preset installed: ${name}`);
}

function yamlSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// 由桥接托管的 MCP 条目 id：脚本对这三个 id 拥有所有权，可安全地按 id 增删。
const MANAGED_MCP_IDS = ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe'];

function mcpEntries() {
  const node = process.execPath;
  const servers = {
    'mcp-snowluma': { serverName: 'snowluma', script: path.join(REPO_ROOT, 'src', 'mcp-snowluma-safe.js'), toolCallTimeoutMs: 725000 },
    'mcp-snowluma-host': { serverName: 'snowluma-host', script: path.join(REPO_ROOT, 'src', 'mcp-host-server.js') },
    'mcp-web-search-safe': { serverName: 'web-search-safe', script: path.join(REPO_ROOT, 'src', 'mcp-web-search-safe.js') },
  };
  let out = '# === qq-bridge MCP BEGIN ===\n';
  out += '# 由 scripts/setup-dsh.mjs 维护；这段区块会被整体替换，请勿手工编辑内部条目。\n';
  for (const [id, s] of Object.entries(servers)) {
    out += `- insert:\n`;
    out += `    - id: ${id}\n`;
    out += `      name: '@deepseek-ai/dsh-mcp-client'\n`;
    out += `      config:\n`;
    out += `        serverName: ${s.serverName}\n`;
    out += `        transport: stdio\n`;
    out += `        command: ${yamlSingleQuote(node)}\n`;
    out += `        args:\n`;
    out += `          - ${yamlSingleQuote(s.script)}\n`;
    // qq_wait_for_messages 最长可等 10 分钟；DSH 默认 60s 会提前掐断工具调用。
    if (s.toolCallTimeoutMs) out += `        toolCallTimeoutMs: ${s.toolCallTimeoutMs}\n`;
  }
  out += '# === qq-bridge MCP END ===\n';
  return out;
}

/**
 * 按「条目 id」从 patch 文本里删掉桥接托管的 MCP 条目（含其 insert: 行）。
 * 比之前「先找 BEGIN/END 标记」更稳：历史版本装的补丁没有标记，旧逻辑会直接跳过，
 * 导致升级后缺条目（例如 mcp-web-search-safe 永远装不上）。
 */
function stripManagedMcpEntries(text) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  let removed = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*-\s*id:\s*(\S+)\s*$/.exec(lines[i]);
    if (m && MANAGED_MCP_IDS.includes(m[1])) {
      // 回退掉紧邻其上的 `- insert:` 行（如果存在且未被消费）
      const prev = kept[kept.length - 1];
      if (prev !== undefined && /^\s*-\s*insert:\s*$/.test(prev)) kept.pop();
      removed += 1;
      // 跳过该条目自身的续行（比 id 行缩进更深的行）
      const idIndent = lines[i].length - lines[i].trimStart().length;
      let j = i + 1;
      while (j < lines.length) {
        const line = lines[j];
        if (line.trim() === '') { j += 1; continue; }
        const indent = line.length - line.trimStart().length;
        if (indent > idIndent) { j += 1; continue; }
        break;
      }
      i = j - 1;
      continue;
    }
    kept.push(lines[i]);
  }
  return { text: kept.join('\n'), removed };
}

function patchCordis() {
  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  ensureDir(profileDir);
  let text = '';
  if (fs.existsSync(patchFile)) {
    text = fs.readFileSync(patchFile, 'utf8');
  }
  const beginMarker = '# === qq-bridge MCP BEGIN ===';
  const endMarker = '# === qq-bridge MCP END ===';

  // 1) 先删掉旧的托管条目（含历史版本无标记时写入的条目），避免 id 重复导致 DSH 启动失败
  const stripped = stripManagedMcpEntries(text);
  text = stripped.text;
  // 2) 再删掉旧的标记区块（如果还残留）
  if (text.includes(beginMarker) && text.includes(endMarker)) {
    text = text.replace(
      new RegExp(`${beginMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${endMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`),
      '',
    );
  }
  // 3) 清掉「独立成行的空数组 []」——它们会和追加的 block 组成两个 YAML 根节点，
  //    DSH 启动时报 “end of the stream or a document separator is expected”。
  text = text.replace(/^[ \t]*\[\][ \t]*(?:\r?\n|$)/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  const block = mcpEntries();
  text = text.trim().length > 0 ? `${text}\n\n${block}` : block;
  fs.writeFileSync(patchFile, text, 'utf8');
  log(`cordis.patch.yml: MCP 条目已同步（清理旧条目 ${stripped.removed} 条，写入 ${MANAGED_MCP_IDS.length} 条）`);
}

function ensurePluginLink() {
  const repoPlugin = path.join(REPO_ROOT, 'plugins', 'qq-mode-console');
  const pluginLink = path.join(DSH_HOME, 'plugins', 'qq-mode-console');
  if (!fs.existsSync(repoPlugin)) fatal(`plugin not found: ${repoPlugin}`);
  ensureDir(path.dirname(pluginLink));

  let existing = null;
  try {
    existing = fs.lstatSync(pluginLink);
  } catch (error) {
    if (error?.code !== 'ENOENT') fatal(`failed to inspect plugin link: ${error?.message ?? error}`);
  }

  if (existing) {
    if (!existing.isSymbolicLink()) {
      fatal(`plugin path already exists and is not a symlink/junction: ${pluginLink}. Please remove it manually or move it out of the way, then rerun.`);
    }
    // 符号链接/junction 存在时，校验是否指向当前仓库；指向旧路径/失效时自动重建。
    let sameTarget = false;
    try {
      const target = fs.realpathSync(pluginLink);
      const expected = fs.realpathSync(repoPlugin);
      sameTarget = process.platform === 'win32'
        ? String(target).toLowerCase() === String(expected).toLowerCase()
        : String(target) === String(expected);
    } catch {}
    if (sameTarget) {
      log(`plugin link already exists and points to this repo: ${pluginLink}`);
      return pluginLink;
    }
    log(`plugin link exists but points elsewhere/broken, recreating: ${pluginLink}`);
    fs.rmSync(pluginLink, { recursive: true, force: true });
  }

  try {
    if (process.platform === 'win32') {
      fs.symlinkSync(repoPlugin, pluginLink, 'junction');
    } else {
      fs.symlinkSync(repoPlugin, pluginLink, 'dir');
    }
    log(`plugin link created: ${pluginLink}`);
  } catch (e) {
    fatal(`failed to create plugin link: ${e.message}`);
  }
  return pluginLink;
}

function patchProfilePackage(pluginLink) {
  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  const pkgFile = path.join(profileDir, 'package.json');
  ensureDir(profileDir);
  let pkg = { name: `dsh-profile-${PROFILE}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  if (fs.existsSync(pkgFile)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    } catch (e) {
      fatal(`failed to parse ${pkgFile}: ${e.message}`);
    }
  }
  pkg.name = pkg.name || `dsh-profile-${PROFILE}`;
  pkg.private = pkg.private !== false;
  if (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)) pkg.dependencies = {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];
  const linkVal = `link:${pluginLink.replace(/\\/g, '/')}`;
  if (pkg.dependencies['qq-mode-console'] !== linkVal) {
    pkg.dependencies['qq-mode-console'] = linkVal;
    log(`package.json dependency qq-mode-console -> ${linkVal}`);
  }
  if (!pkg.dsh.profile.bundles.includes('qq-mode-console')) {
    pkg.dsh.profile.bundles.push('qq-mode-console');
    log(`package.json bundle added: qq-mode-console`);
  }
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  log(`profile package.json ensured: ${pkgFile}`);
}

function ensureLocalModeFile() {
  const stateDir = path.join(REPO_ROOT, 'state');
  const modeFile = path.join(stateDir, 'mode.json');
  if (fs.existsSync(modeFile)) {
    log(`state/mode.json already exists; leave as-is (current mode may be user-configured)`);
    return;
  }
  ensureDir(stateDir);
  fs.writeFileSync(modeFile, `${JSON.stringify({ mode: 'reserved2', closedAgentPreset: 'router-standard' }, null, 2)}\n`, 'utf8');
  log(`state/mode.json created with mode=reserved2 (fallback if DSH settings are not available)`);
}

// qq-mode-console 以 link: 依赖注册进 profile package.json 后，DSH 首次启动需要先安装一次
// 才能解析该 bundle（否则 cold start 报 "cannot resolve profile bundle"）。dsh CLI 可用时自动执行。
function autoInstallProfileBundles() {
  const cmd = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
  const r = spawnSync(cmd, ['plugin', '--profile', PROFILE, 'install'], {
    encoding: 'utf8',
    timeout: 120000,
  });
  if (r.error) {
    log(`auto-install skipped: dsh CLI 未找到（${r.error.code || r.error.message}）。`);
    log(`若 DSH 启动报“cannot resolve profile bundle \\"qq-mode-console\\"”，请手动执行：dsh plugin --profile ${PROFILE} install`);
    return;
  }
  if (r.status === 0) {
    log(`dsh plugin --profile ${PROFILE} install: OK`);
  } else {
    log(`dsh plugin --profile ${PROFILE} install 返回退出码 ${r.status}（若 DSH 启动报 bundle 解析失败，请手动重跑该命令）`);
  }
}

copyPreset('qq-chat');
copyPreset('qq-chat-v2');
patchCordis();
const pluginLink = ensurePluginLink();
patchProfilePackage(pluginLink);
ensureLocalModeFile();
autoInstallProfileBundles();
log('Done. Please restart DSH (or reload the profile) for the new presets/MCP to take effect.');
