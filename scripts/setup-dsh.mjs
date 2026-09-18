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
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE = process.argv[2] || 'web';

// A profile is a directory name, never a path (same boundary as DSH itself).
if (PROFILE === '.' || PROFILE === '..' || PROFILE === 'node_modules'
    || /[\\/\x00-\x1f<>:"|?*]/.test(PROFILE) || /[. ]$/.test(PROFILE)) {
  fatal(`invalid profile name: ${JSON.stringify(PROFILE)}`);
}

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

function prepareCordisPatch() {
  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const original = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  const lines = original.replace(/^\uFEFF/, '').split(/\r?\n/);
  // Repair only the historical invalid *root* [] followed by block operations.
  // A nested [] or a line inside a literal scalar is user data and must survive.
  const first = lines.findIndex((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (first >= 0 && lines[first].trim() === '[]'
      && lines.slice(first + 1).some((line) => /^-\s/.test(line))) {
    lines.splice(first, 1);
  }
  let doc;
  try { doc = yaml.load(lines.join('\n')) ?? []; }
  catch (error) { fatal(`failed to parse ${patchFile}; file unchanged: ${error.message}`); }
  if (!Array.isArray(doc)) fatal(`${patchFile} must contain a YAML array; file unchanged`);
  let removed = 0;
  const kept = [];
  for (const operation of doc) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      fatal(`invalid patch operation in ${patchFile}; file unchanged`);
    }
    if (!Object.hasOwn(operation, 'insert')) { kept.push(operation); continue; }
    if (!Array.isArray(operation.insert)) fatal(`insert must be an array in ${patchFile}; file unchanged`);
    const entries = operation.insert.filter((entry) => {
      if (!MANAGED_MCP_IDS.includes(entry?.id)) return true;
      removed++;
      return false;
    });
    // Retain shared insert parents and their selectors/other operation fields.
    if (entries.length || Object.keys(operation).length > 1) kept.push({ ...operation, insert: entries });
  }
  const text = (kept.length ? `${yaml.dump(kept, { lineWidth: -1, noRefs: true })}\n` : '') + mcpEntries();
  return { patchFile, original, text, removed };
}

function patchCordis({ patchFile, original, text, removed }) {
  ensureDir(path.dirname(patchFile));
  // Parsing/serialization normalizes formatting; keep the original text (including comments).
  if (original && original !== text) {
    try { fs.writeFileSync(`${patchFile}.qq-bridge.bak`, original, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const temporary = `${patchFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, patchFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  log(`cordis.patch.yml: MCP 条目已同步（清理旧条目 ${removed} 条，写入 ${MANAGED_MCP_IDS.length} 条）`);
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
  // DSH 0.1.5 起不再有 'router-standard' preset；留空表示「用 DSH 自己声明的默认 preset」，
  // 由 bridge.js 的 resolvePresetName() 兜底（硬编码已下线的名字只会换来每次启动的误导性告警）。
  fs.writeFileSync(modeFile, `${JSON.stringify({ mode: 'reserved2', closedAgentPreset: '' }, null, 2)}\n`, 'utf8');
  log(`state/mode.json created with mode=reserved2 (fallback if DSH settings are not available)`);
}

// qq-mode-console 以 link: 依赖注册进 profile package.json 后，DSH 首次启动需要先安装一次
// 才能解析该 bundle（否则 cold start 报 "cannot resolve profile bundle"）。dsh CLI 可用时自动执行。
function autoInstallProfileBundles() {
  if (process.env.QQ_BRIDGE_SKIP_DSH_INSTALL === '1') {
    log('auto-install skipped: QQ_BRIDGE_SKIP_DSH_INSTALL=1');
    return;
  }
  const windows = process.platform === 'win32';
  // Node cannot spawn npm's .cmd shim directly. Keep the shell command constant;
  // the validated (no quotes/control chars) profile travels through one quoted
  // environment expansion, with delayed expansion disabled to preserve '!'.
  const cmd = windows ? (process.env.ComSpec || 'cmd.exe') : 'dsh';
  const args = windows
    ? ['/d', '/v:off', '/s', '/c', 'dsh.cmd plugin --profile "%QQ_BRIDGE_SETUP_PROFILE%" install']
    : ['plugin', '--profile', PROFILE, 'install'];
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    windowsVerbatimArguments: windows,
    ...(windows ? { env: { ...process.env, QQ_BRIDGE_SETUP_PROFILE: PROFILE } } : {}),
  });
  if (r.error) {
    log(`auto-install failed to start/complete（${r.error.code || r.error.message}）。`);
    log(`若 DSH 启动报“cannot resolve profile bundle \\"qq-mode-console\\"”，请手动执行：dsh plugin --profile ${PROFILE} install`);
    return;
  }
  if (r.status === 0) {
    log(`dsh plugin --profile ${PROFILE} install: OK`);
  } else {
    log(`dsh plugin --profile ${PROFILE} install 返回退出码 ${r.status}（若 DSH 启动报 bundle 解析失败，请手动重跑该命令）`);
  }
}

// Validate the existing YAML before changing any presets or configuration.
const cordisPatch = prepareCordisPatch();
copyPreset('qq-chat');
copyPreset('qq-chat-v2');
patchCordis(cordisPatch);
const pluginLink = ensurePluginLink();
patchProfilePackage(pluginLink);
ensureLocalModeFile();
autoInstallProfileBundles();
log('Done. Please restart DSH (or reload the profile) for the new presets/MCP to take effect.');
