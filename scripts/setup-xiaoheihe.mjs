#!/usr/bin/env node
// setup-xiaoheihe.mjs — 可选：把本机「小黑盒」MCP 服务（streamable HTTP）挂进 DSH profile
//
// 背景：
//   小黑盒服务是一个独立进程（HTTP MCP，根地址形如 http://127.0.0.1:19489/），
//   它自己管理 Edge/账户/Cookie，本仓库不读取、不复制、不写入它的 data 目录。
//   本脚本只负责在 DSH 的 profile patch 里插入一条 @deepseek-ai/dsh-mcp-client
//   行，让 DSH 以 mcp__xiaoheihe__<工具名> 暴露那套工具。
//
// 行为：
//   · 默认 DRY-RUN：只打印解析后的路径、URL 与计划，不写任何文件；
//     `--apply` 才写 profile。
//   · 只维护自己的带标记区块（BEGIN/END），区块外内容逐字节保留；
//   · 区块里写入有界 reconnect 预算：该 MCP 客户端默认只重试 10 次（约 151.5s），
//     而本机 DSH 常先于小黑盒服务启动，超窗口后工具会被注销且只能重启 Host 恢复；
//     提高预算只扩大努力窗口，仍然有界，不承诺「一定自愈」；
//   · 写前备份原文件（同目录 `.bak-<时间戳>`），写入走原子替换；
//   · 已存在同 id（mcp-xiaoheihe）或同 serverName（xiaoheihe）的条目时
//     拒绝重复注册，而不是悄悄插第二条。
//
// 用法：
//   node scripts/setup-xiaoheihe.mjs [--profile desktop] [--dsh-home <绝对路径>]
//                                    [--url http://127.0.0.1:19489/] [--apply]
//
// 环境变量：DSH_HOME（同 --dsh-home）、XIAOHEIHE_MCP_URL（同 --url）。
// 详见 docs/guides/XIAOHEIHE_SETUP.md。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { backupBeforeOverwrite, writeFileAtomic } from './file-io.mjs';

// ── 固定契约 ────────────────────────────────────────────────────────────────
export const DEFAULT_PROFILE = 'desktop';
export const DEFAULT_URL = 'http://127.0.0.1:19489/';
export const MCP_ID = 'mcp-xiaoheihe';
export const MCP_PACKAGE = '@deepseek-ai/dsh-mcp-client';
// namespace 固定，DSH 里的工具名因此固定为 mcp__xiaoheihe__<原工具名>。
export const MCP_SERVER_NAME = 'xiaoheihe';
// 浏览器交互登录（扫码/跳转）可能耗时数分钟；DSH 默认 60s 会提前掐断工具调用。
// 360s 覆盖「至少 300s」要求。
export const TOOL_CALL_TIMEOUT_MS = 360000;
export const MIN_TOOL_CALL_TIMEOUT_MS = 300000;

// 连接重连预算（m33778 方案 2 的缓解措施，**不是**「保证自愈」）。
// 依据 DSH 的 @deepseek-ai/dsh-mcp-client/lib/index.js：
//   RECONNECT_DEFAULTS = { enabled:true, initialDelayMs:500, maxDelayMs:30000, maxAttempts:10 }
//   scheduleReconnect(): failedAttempts > maxAttempts 时注销全部已注册工具并打印
//   "giving up ... tools unregistered; reload the plugin or restart the Host"
//   ⇒ 默认一次故障只有约 151.5s（500+1k+2k+4k+8k+16k+30k×4）的重试窗口。
// 本机 DSH 常先于小黑盒服务启动；超过窗口后工具被注销，只能靠 Host 重启/HMR 恢复。
// 240 次按同一退避公式累加 ≈ 117.5 分钟，覆盖开机竞争；仍是有界预算，
// 服务始终起不来时照样放弃（因此不得对外宣称「保证自愈」或「零风险」）。
export const RECONNECT_POLICY = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30000,
  maxAttempts: 240,
});
// DSH 的 resolveReconnectPolicy 对未知键直接抛 `... is not a reconnect option`。
// 为避免依赖「schema 是否在解析前剥离未知键」这一未经证实的细节，这里只写这四个键。
export const RECONNECT_KEYS = Object.freeze(['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts']);
// 不得低于 DSH 默认值（10）：低于它等于主动削弱既有行为。
export const MIN_RECONNECT_MAX_ATTEMPTS = 10;
// 与 DSH 侧 setTimeout 的上限一致（2^31-1；asar 内多处定义均为该值）。
// 实际写入的 500/30000 远未触界，这里只作校验上界。
const MAX_TIMER_DELAY_MS = 2147483647;

export const BEGIN_MARKER = '# === xiaoheihe MCP BEGIN ===';
export const END_MARKER = '# === xiaoheihe MCP END ===';

const USAGE = `小黑盒 MCP 接入安装器（可选）

用法：
  node scripts/setup-xiaoheihe.mjs [选项]

选项：
  --apply                真正写入 profile；缺省为 dry-run（只打印计划，不写盘）
  --profile <名字>       DSH profile 目录名，默认 ${DEFAULT_PROFILE}
  --dsh-home <绝对路径>  DSH 根目录，默认取环境变量 DSH_HOME，否则 ~/.dsh
  --url <地址>           小黑盒 MCP 根地址，默认 ${DEFAULT_URL}
  -h, --help             显示本帮助

环境变量：
  DSH_HOME              同 --dsh-home
  XIAOHEIHE_MCP_URL     同 --url

约束：
  · 只接受 http:// 回环根地址（127.0.0.1 / localhost / ::1）；
    拒绝远程主机、URL 内嵌凭据、非根路径（例如 /mcp）。
  · profile 必须是单个目录名，不能包含路径分隔符或 .. 跳转。
  · 写入前备份原 patch；已存在同 id/serverName 的条目时拒绝重复注册。
  · 写入有界重连预算（reconnect：enabled/initialDelayMs/maxDelayMs/maxAttempts），
    覆盖「DSH 先启动、小黑盒服务后到」的竞争；这是缓解措施，不保证一定自愈。
  · 只改 profile 的 cordis.patch.yml，不改 preset、config.json 或服务数据。`;

// ── 参数与路径 ──────────────────────────────────────────────────────────────
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseArgs(argv = []) {
  const options = { profile: undefined, dshHome: undefined, url: undefined, apply: false, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = (label) => {
      i += 1;
      if (i >= argv.length || argv[i].startsWith('--')) throw new Error(`${label} 需要一个值`);
      return argv[i];
    };
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--profile') options.profile = takeValue('--profile');
    else if (arg === '--dsh-home') options.dshHome = takeValue('--dsh-home');
    else if (arg === '--url') options.url = takeValue('--url');
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}（见 --help）`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new Error(`最多接受一个 profile 位置参数：${positional.join(' ')}`);
  if (positional.length === 1) {
    if (options.profile) throw new Error('profile 不能同时用位置参数和 --profile 指定');
    options.profile = positional[0];
  }
  return options;
}

export function resolveDshHome(raw) {
  const text = String(raw ?? '').trim();
  const value = text || path.join(os.homedir(), '.dsh');
  if (!path.isAbsolute(value)) throw new Error(`DSH_HOME 必须是绝对路径：${JSON.stringify(value)}`);
  return path.resolve(value);
}

export function validateProfileName(profile) {
  if (typeof profile !== 'string' || profile.length === 0) throw new Error('profile 不能为空');
  // 与 DSH 自身的边界一致：profile 是单个目录名，不是路径。
  const invalid = profile === '.' || profile === '..' || profile === 'node_modules'
    || /[\\/\x00-\x1f<>:"|?*]/.test(profile) || /[. ]$/.test(profile);
  if (invalid) {
    throw new Error(`invalid profile name: ${JSON.stringify(profile)}（必须是单个目录名，不能含路径分隔符或 ..）`);
  }
  return profile;
}

/** profile 目录，并强制校验解析结果仍在 <DSH_HOME>/profiles 下（防路径穿越）。 */
export function profileDirFor(dshHome, profile) {
  const profilesRoot = path.resolve(dshHome, 'profiles');
  const dir = path.resolve(profilesRoot, profile);
  const rel = path.relative(profilesRoot, dir);
  if (!rel || path.isAbsolute(rel) || rel.startsWith('..') || rel.split(path.sep).includes('..')) {
    throw new Error(`profile 路径越界：${JSON.stringify(profile)}`);
  }
  return dir;
}

/**
 * 只接受「本机回环 + http + 根路径」的 MCP 地址。
 *
 * 三项都是安全边界，不是风格偏好：
 *   · 回环：避免把本机 MCP 端点暴露给 / 指向远端主机；
 *   · 无内嵌凭据：URL 会被原样写进 profile，禁止 user:pass@；
 *   · 根路径：该服务把 MCP 端点挂在 `/`，写成 /mcp 会 404（不是「更规范」）。
 */
export function normalizeLoopbackUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('URL 不能为空');
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    // 不回显原始输入：URL 里可能带凭据，错误信息禁止泄漏。
    throw new Error('URL 无效（无法解析为 http(s) 地址）');
  }
  // 先查内嵌凭据：下面所有错误信息都只拼 protocol/host，不拼原始 URL。
  if (parsed.username || parsed.password) {
    throw new Error('URL 不能内嵌凭据（user:pass@）；请由服务的本地登录态处理鉴权');
  }
  // 去掉 userinfo 的安全重建，仅用于错误提示。
  const safeUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  if (parsed.protocol !== 'http:') {
    throw new Error(`只接受 http:// 回环地址（收到 ${parsed.protocol}）：${safeUrl}`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`URL 不能带 query 或 hash；只接受根地址：${safeUrl}`);
  }
  if (parsed.pathname !== '/') {
    throw new Error(`URL 必须是根路径（以 / 结尾），不能是 ${parsed.pathname}；该服务 /mcp 会返回 404`);
  }
  const host = parsed.hostname.toLowerCase();
  const isV4Loopback = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host);
  const isLoopback = host === 'localhost' || host === '[::1]' || host === '::1' || isV4Loopback;
  if (!isLoopback) {
    throw new Error(`只接受本机回环地址（127.0.0.1 / localhost / ::1），拒绝 ${host}`);
  }
  return parsed.href;
}

export function resolveOptions(args, env = process.env) {
  const dshHome = resolveDshHome(args.dshHome ?? env.DSH_HOME);
  const profile = validateProfileName(args.profile ?? DEFAULT_PROFILE);
  const url = normalizeLoopbackUrl(args.url ?? env.XIAOHEIHE_MCP_URL ?? DEFAULT_URL);
  const profileDir = profileDirFor(dshHome, profile);
  return {
    apply: Boolean(args.apply),
    dshHome,
    profile,
    url,
    profileDir,
    patchFile: path.join(profileDir, 'cordis.patch.yml'),
  };
}

// ── patch 文本：带标记区块 ──────────────────────────────────────────────────
function yamlSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 校验 reconnect 策略：键集合、类型、范围与 DSH 的 resolveReconnectPolicy 对齐。
 *
 * 任何不合法都抛错（调用方 fail-closed、不写盘），绝不静默修正：
 * 写进正式 profile 的未知键会让 mcp-client 插件实例直接加载失败。
 */
export function validateReconnectPolicy(policy = RECONNECT_POLICY) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('reconnect 配置必须是对象');
  }
  for (const key of Object.keys(policy)) {
    if (!RECONNECT_KEYS.includes(key)) {
      throw new Error(`reconnect 不接受未知键：${key}（DSH 会因此让插件加载失败）`);
    }
  }
  const { enabled, initialDelayMs, maxDelayMs, maxAttempts } = policy;
  if (typeof enabled !== 'boolean') throw new Error('reconnect.enabled 必须是布尔值');
  if (!Number.isInteger(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`reconnect.initialDelayMs 必须是 1..${MAX_TIMER_DELAY_MS} 的整数`);
  }
  if (!Number.isInteger(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`reconnect.maxDelayMs 必须是 1..${MAX_TIMER_DELAY_MS} 的整数`);
  }
  if (initialDelayMs > maxDelayMs) throw new Error('reconnect.initialDelayMs 不能大于 maxDelayMs');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('reconnect.maxAttempts 必须是正整数');
  }
  // 本安装器只写 enabled:true 的策略；这里不按 enabled 分支放宽，保持「预算不缩水」这一条不变量。
  if (maxAttempts < MIN_RECONNECT_MAX_ATTEMPTS) {
    throw new Error(`reconnect.maxAttempts=${maxAttempts} 低于底线 ${MIN_RECONNECT_MAX_ATTEMPTS}（不得低于 DSH 默认预算）`);
  }
  return { enabled, initialDelayMs, maxDelayMs, maxAttempts };
}

/**
 * 生成完整标记区块（末尾带换行，便于直接替换/追加）。
 * `newline` 用于跟随目标文件已有的换行风格（`\n` / `\r\n`），默认 LF。
 * `policy` 只允许在测试里替换；默认写入 {@link RECONNECT_POLICY}。
 */
export function buildPatchBlock(url = DEFAULT_URL, newline = '\n', policy = RECONNECT_POLICY) {
  const rootUrl = normalizeLoopbackUrl(url);
  const eol = newline === '\r\n' ? '\r\n' : '\n';
  if (TOOL_CALL_TIMEOUT_MS < MIN_TOOL_CALL_TIMEOUT_MS) {
    throw new Error(`toolCallTimeoutMs=${TOOL_CALL_TIMEOUT_MS} 低于登录所需下限 ${MIN_TOOL_CALL_TIMEOUT_MS}ms`);
  }
  const reconnect = validateReconnectPolicy(policy);
  return [
    BEGIN_MARKER,
    '# 由 scripts/setup-xiaoheihe.mjs 维护；整块会被整体替换，请勿手工编辑内部条目。',
    '# 可选接入：小黑盒 MCP（streamable HTTP，本机回环根地址；服务需独立运行）。',
    '- insert:',
    `    - id: ${MCP_ID}`,
    `      name: ${yamlSingleQuote(MCP_PACKAGE)}`,
    '      config:',
    `        serverName: ${MCP_SERVER_NAME}`,
    '        transport: streamable-http',
    `        url: ${yamlSingleQuote(rootUrl)}`,
    `        toolCallTimeoutMs: ${TOOL_CALL_TIMEOUT_MS}`,
    '        reconnect:',
    `          enabled: ${reconnect.enabled}`,
    `          initialDelayMs: ${reconnect.initialDelayMs}`,
    `          maxDelayMs: ${reconnect.maxDelayMs}`,
    `          maxAttempts: ${reconnect.maxAttempts}`,
    '        failOnStartupError: false',
    END_MARKER,
    '',
  ].join(eol);
}

function matchMarkerLines(text, marker) {
  const re = new RegExp(`^${escapeRegExp(marker)}[ \\t]*\\r?$`, 'gm');
  const out = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    out.push({ index: match.index, end: match.index + match[0].length });
  }
  return out;
}

/** 找到唯一的 BEGIN/END 区块；没有则返回 null；重复/残缺/顺序异常直接抛错。 */
export function findMarkedBlock(text) {
  const begins = matchMarkerLines(text, BEGIN_MARKER);
  const ends = matchMarkerLines(text, END_MARKER);
  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length !== 1 || ends.length !== 1) {
    throw new Error(`标记区块不完整或重复（BEGIN ${begins.length} 个 / END ${ends.length} 个）`);
  }
  const begin = begins[0];
  const end = ends[0];
  if (end.index < begin.index) throw new Error('标记区块顺序异常（END 出现在 BEGIN 之前）');
  let blockEnd = end.end;
  if (text[blockEnd] === '\n') blockEnd += 1;
  return { start: begin.index, end: blockEnd, raw: text.slice(begin.index, blockEnd) };
}

function parsePatchArray(text, label) {
  if (!String(text).trim()) return [];
  let doc;
  try {
    doc = yaml.load(text);
  } catch (error) {
    throw new Error(`${label} 不是合法 YAML：${error.message}`);
  }
  if (doc === null || doc === undefined) return [];
  if (!Array.isArray(doc)) throw new Error(`${label} 顶层必须是 YAML 数组`);
  return doc;
}

function collectConflicts(doc) {
  const conflicts = [];
  doc.forEach((operation, index) => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return;
    const rows = Array.isArray(operation.insert) ? operation.insert : [operation];
    for (const entry of rows) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const id = typeof entry.id === 'string' ? entry.id : undefined;
      const serverName = entry.config && typeof entry.config === 'object' ? entry.config.serverName : undefined;
      if (id === MCP_ID) {
        conflicts.push({ kind: 'id', id, operation: index });
      } else if (serverName === MCP_SERVER_NAME) {
        conflicts.push({ kind: 'serverName', serverName, id: id ?? '(无 id)', operation: index });
      }
    }
  });
  return conflicts;
}

function validateExistingBlock(raw) {
  const doc = parsePatchArray(raw, '已有标记区块');
  const entries = doc.flatMap((operation) => (Array.isArray(operation?.insert) ? operation.insert : []));
  const isOurs = (entry) => entry && typeof entry === 'object' && entry.id === MCP_ID;
  if (entries.length !== 1 || !isOurs(entries[0])) {
    throw new Error('已有标记区块内容异常（期望恰好一条 mcp-xiaoheihe 条目）；为避免误删，本次未改动文件');
  }
}

function appendBlock(text, block) {
  if (!text) return block;
  return `${text}${text.endsWith('\n') ? '\n' : '\n\n'}${block}`;
}

/** 文件里第一个换行符的风格；没有换行时按 LF。 */
function detectNewline(text) {
  return String(text ?? '').includes('\r\n') ? '\r\n' : '\n';
}

/** 按原始换行符拆行，保留每行的 ending，便于做到「只删目标 token」。 */
function splitLines(text) {
  const parts = String(text ?? '').split(/(\r\n|\r|\n)/);
  const lines = [];
  for (let index = 0; index < parts.length; index += 2) {
    const content = parts[index];
    const ending = parts[index + 1] ?? '';
    if (content === '' && ending === '' && index === parts.length - 1) continue;
    lines.push({ content, ending });
  }
  return lines;
}

/**
 * 处理 DSH 新建 profile 的模板：注释 + 根 `[]`（空列表字面量）。
 *
 * 只把「表示空列表的根 token」去掉（行内 `[]`/`[ ]`，可带行尾注释），
 * 其它内容包括注释里的 `[]`、空行、换行风格都原样保留。
 * 根节点若是**非空** flow 数组，则拒绝并解释——不猜、不重写用户配置。
 *
 * 返回 { text, repaired }；抛错表示必须人工处理（调用方 fail-closed，不写盘）。
 */
export function repairEmptyRootSequence(patchText) {
  const text = String(patchText ?? '');
  if (!text.trim()) return { text, repaired: false };
  const lines = splitLines(text);
  const firstContent = lines.findIndex((line) => {
    const trimmed = line.content.trim();
    return trimmed !== '' && !trimmed.startsWith('#');
  });
  if (firstContent < 0) return { text, repaired: false };
  const content = lines[firstContent].content;
  const leading = content.match(/^[ \t]*/)?.[0] ?? '';
  const rest = content.slice(leading.length);
  if (!rest.startsWith('[')) return { text, repaired: false };
  // 空列表 token：[] 或 [ ]，后面只允许空白或「空白 + # 行尾注释」。
  const empty = /^\[[ \t]*\]((?:[ \t]+#.*|[ \t]*))$/.exec(rest);
  if (!empty) {
    throw new Error(
      'profile patch 的根节点是非空 flow 数组（以 [ 开头）。'
      + '本安装器只移除表示空列表的根 []，不会静默重写非空 flow 数组；'
      + '请先手工把它改成块列表（每项以 - 开头）后重试。'
    );
  }
  const trailing = empty[1];
  const nextLines = lines.slice();
  if (trailing.includes('#')) {
    // 保留行尾注释文本（含其前面的空白），只去掉 []。
    nextLines[firstContent] = { content: `${leading}${trailing}`, ending: lines[firstContent].ending };
  } else {
    nextLines.splice(firstContent, 1);
  }
  return { text: nextLines.map((line) => line.content + line.ending).join(''), repaired: true };
}

/**
 * 计算安装计划（纯函数，不碰磁盘）。
 *
 * 先处理 DSH 新 profile 模板的根 `[]`（只移除空列表 token，注释/换行原样保留）；
 * 根节点若是非空 flow 数组则抛错拒绝，不静默重写。
 *
 * 返回 status：
 *   create    —— patch 为空（不存在、空文件或只有根 []），写入区块
 *   append    —— 已有 patch（含模板注释），追加区块
 *   update    —— 已有本脚本区块，整体替换（例如 URL 变化）；或需要顺带移除根 []
 *   unchanged —— 已有区块与目标逐字节一致，且无需修复根 []
 *   conflict  —— 区块外存在同 id/serverName 条目，拒绝重复注册
 */
export function planInstall({ patchText = '', url = DEFAULT_URL } = {}) {
  const original = String(patchText ?? '');
  const repair = repairEmptyRootSequence(original);
  const text = repair.text;
  const block = buildPatchBlock(url, detectNewline(original));
  const existing = findMarkedBlock(text);
  if (existing) validateExistingBlock(existing.raw);
  const outside = existing ? text.slice(0, existing.start) + text.slice(existing.end) : text;
  const outsideDoc = parsePatchArray(outside, '区块外的 profile patch');
  const conflicts = collectConflicts(outsideDoc);
  const preservedOperations = outsideDoc.length;
  if (conflicts.length) {
    return { status: 'conflict', block, text: null, conflicts, preservedOperations, repairedRoot: repair.repaired };
  }
  if (existing) {
    if (existing.raw === block) {
      // 区块已正确；若同时存在历史根 []，仍需写一次把空列表 token 去掉。
      return {
        status: repair.repaired ? 'update' : 'unchanged',
        block,
        text,
        preservedOperations,
        repairedRoot: repair.repaired,
      };
    }
    const next = text.slice(0, existing.start) + block + text.slice(existing.end);
    parsePatchArray(next, '写入后的 profile patch');
    return { status: 'update', block, text: next, preservedOperations, repairedRoot: repair.repaired };
  }
  const next = appendBlock(text, block);
  parsePatchArray(next, '写入后的 profile patch');
  return {
    status: text === '' ? 'create' : 'append',
    block,
    text: next,
    preservedOperations,
    repairedRoot: repair.repaired,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────
function describePlan(status, { patchExists }) {
  switch (status) {
    case 'create': return patchExists ? '写入空 patch 文件（新建标记区块）' : '新建 patch 文件（写入标记区块）';
    case 'append': return '追加标记区块（区块外内容逐字节保留）';
    case 'update': return '替换已有标记区块（区块外内容逐字节保留）';
    case 'unchanged': return '标记区块已是目标内容，无需改动';
    case 'conflict': return '存在同 id/serverName 条目，拒绝重复注册';
    default: return status;
  }
}

/**
 * 执行一次安装/计划。返回进程退出码（0 成功，1 失败）。
 * 注入 log/error 便于测试；`backup` 默认是 file-io 的备份实现，测试可注入失败以验证
 * 「无回滚点不写盘」；不读取任何服务数据，也不输出凭据。
 */
export function run({
  argv = [],
  env = process.env,
  log = console.log,
  error = console.error,
  backup = backupBeforeOverwrite,
} = {}) {
  const prefix = '[setup-xiaoheihe]';
  let args;
  try {
    args = parseArgs(argv);
  } catch (cause) {
    error(`${prefix} ERROR: ${cause.message}`);
    return 1;
  }
  if (args.help) {
    log(USAGE);
    return 0;
  }

  let options;
  try {
    options = resolveOptions(args, env);
  } catch (cause) {
    error(`${prefix} ERROR: ${cause.message}`);
    error(`${prefix} 本次未改动任何文件。`);
    return 1;
  }

  const { dshHome, profile, profileDir, patchFile, url, apply } = options;
  const patchExists = fs.existsSync(patchFile);
  log(`${prefix} DSH_HOME：${dshHome}`);
  log(`${prefix} profile：${profile}`);
  log(`${prefix} patch 文件：${patchFile}（${patchExists ? '已存在' : '不存在'}）`);
  log(`${prefix} MCP URL：${url}（仅本机回环）`);

  if (!fs.existsSync(profileDir)) {
    error(`${prefix} ERROR: profile 目录不存在：${profileDir}`);
    error(`${prefix} 请先在 DSH 中创建该 profile，或检查 --profile / DSH_HOME。本次未改动任何文件。`);
    return 1;
  }

  let original = '';
  try {
    original = patchExists ? fs.readFileSync(patchFile, 'utf8') : '';
  } catch (cause) {
    error(`${prefix} ERROR: 读取 patch 文件失败：${cause.message}`);
    return 1;
  }

  let plan;
  try {
    plan = planInstall({ patchText: original, url });
  } catch (cause) {
    error(`${prefix} ERROR: ${cause.message}`);
    error(`${prefix} 本次未改动任何文件。`);
    return 1;
  }

  if (plan.status === 'conflict') {
    error(`${prefix} ERROR: profile patch 中已存在同 id/serverName 的 MCP 条目，拒绝重复注册：`);
    for (const conflict of plan.conflicts) {
      const label = conflict.kind === 'id'
        ? `id=${conflict.id}`
        : `serverName=${conflict.serverName}（id=${conflict.id}）`;
      error(`${prefix}   · ${label} 位于第 ${conflict.operation + 1} 个顶层操作`);
    }
    error(`${prefix} 请先确认并手工处理上述条目；本次未改动任何文件。`);
    return 1;
  }

  if (plan.repairedRoot) {
    log(`${prefix} 根 []：已识别为空列表标记，仅移除该 token（注释、空行与内容原样保留）。`);
  }
  log(`${prefix} 计划：${describePlan(plan.status, { patchExists })}`);
  log(`${prefix} 区块外原有顶层操作：${plan.preservedOperations} 个（${plan.status === 'unchanged' ? '未写盘' : '不会被改写'}）`);

  if (!apply) {
    log(`${prefix} 模式：DRY-RUN（未写盘）。确认计划无误后加 --apply 部署。`);
    return 0;
  }

  log(`${prefix} 模式：APPLY`);
  if (plan.status === 'unchanged') {
    log(`${prefix} 无需改动：未写盘，也未产生新备份。`);
    return 0;
  }

  // 正式配置必须保留全部回滚点：keep: Infinity ⇒ 不裁剪历史备份。
  // 备份失败（返回 null）时中止写入——没有备份就不能覆盖正式 profile。
  let backupFile = null;
  if (patchExists) {
    backupFile = backup(patchFile, { keep: Infinity, log: (message) => log(`${prefix} ${message}`) });
    if (!backupFile) {
      error(`${prefix} ERROR: 备份失败，已中止写入；原 patch 未被修改。`);
      error(`${prefix} 请确认 patch 文件可读、同目录可写后重试。`);
      return 1;
    }
    log(`${prefix} 备份：${backupFile}`);
  } else {
    log(`${prefix} 备份：无（原文件不存在，无需备份）`);
  }
  writeFileAtomic(patchFile, plan.text);
  log(`${prefix} 已写入：${patchFile}`);
  log(`${prefix} 下一步：重启 DSH（或让它重新加载 profile），新 MCP 工具才会出现。`);
  log(`${prefix} 注意：本脚本不改 preset 工具白名单；若预设限制了工具面，需要预设维护者放行 mcp__${MCP_SERVER_NAME}__*。`);
  return 0;
}

function isEntryPoint() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    const invokedUrl = pathToFileURL(path.resolve(invoked)).href;
    return process.platform === 'win32'
      ? invokedUrl.toLowerCase() === import.meta.url.toLowerCase()
      : invokedUrl === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // 不用 process.exit：让 stdout/stderr 正常 flush，测试直接读退出码。
  process.exitCode = run({ argv: process.argv.slice(2) });
}
