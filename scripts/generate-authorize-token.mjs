// scripts/generate-authorize-token.mjs
// task-60：授权 token 生成脚本（安装辅助；**默认 dry-run，不写任何真实配置**）。
//
// 用法：
//   node scripts/generate-authorize-token.mjs                      # dry-run：打印一次 token + 保存/双写提示
//   node scripts/generate-authorize-token.mjs --json               # 单行 JSON {token,length,note}
//   node scripts/generate-authorize-token.mjs --print-plugin-snippet
//   node scripts/generate-authorize-token.mjs --apply-bridge <显式 JSON 路径> [--force]
//
// 安全约束：
//  · token = crypto.randomBytes(32).toString('hex')（64 位小写）；只在成功输出中出现一次；
//  · 没有默认写入路径：只有显式 `--apply-bridge <path>` 才写；dry-run 绝不创建/改写文件；
//  · 写入前读取并校验 JSON；已有不同 token 时拒绝（提示 --force）；非法 JSON/缺失/不可写 → 非零退出；
//  · 原子写：同目录临时文件（0600）→ rename；失败清理临时文件；
//  · 错误信息不回显 token；退出码：0 成功 / 2 参数错误 / 1 IO 或配置错误。
// 不读真实 config/profile/state（只读用户显式给的路径），不联网、不重启、不 git。

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOKEN_BYTES = 32;
export const TOKEN_HEX_LENGTH = TOKEN_BYTES * 2;
export const EXIT_OK = 0;
export const EXIT_IO = 1;
export const EXIT_USAGE = 2;

const TOKEN_RE = /^[0-9a-f]{64}$/;
const NOTE = '请把 token 保存到密码管理器，并分别写入 bridge config.json 的 backgroundPatrol.authorizeToken 与插件 profile 的 consoleToken；两处必须一致。';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function generateToken({ randomBytes = crypto.randomBytes } = {}) {
  const bytes = randomBytes(TOKEN_BYTES);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError('randomBytes 必须返回字节');
  return Buffer.from(bytes).toString('hex');
}

export function isValidToken(token) {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

/**
 * 可粘贴到插件 profile 的 YAML 片段（enabled 默认 false；与 bridge 使用同一 token）。
 * 键名是插件 normalizeConfig 读取的 `consoleToken`（不是 `authorizeToken`，后者是 bridge 侧键名）；
 * task-108 修正起 enabled:false 进入 fail-closed 模式（所有小黑盒工具，含只读，均被拒），
 * 确认门禁可用后再改 true 进入 active 授权流程。
 */
export function buildPluginSnippet(token) {
  if (!isValidToken(token)) throw new TypeError('buildPluginSnippet：token 必须是 64 位小写 hex');
  return [
    '# 粘贴到 DSH profile 的 xhh-quota-guard 配置（enabled 默认 false = fail-closed 模式，所有小黑盒工具被拒；确认后再改 true）',
    '- xhh-quota-guard:',
    '    enabled: false',
    '    bridgeUrl: "http://127.0.0.1:<bridge-port>/xhh"',
    '    timeoutMs: 800',
    `    consoleToken: "${token}"`,
  ].join('\n');
}

export function buildJsonPayload(token, { includeSnippet = false } = {}) {
  if (!isValidToken(token)) throw new TypeError('buildJsonPayload：token 必须是 64 位小写 hex');
  const payload = { token, length: TOKEN_HEX_LENGTH, note: NOTE };
  if (includeSnippet) payload.pluginSnippet = buildPluginSnippet(token);
  return payload;
}

/**
 * 把 token 写入显式指定的 bridge JSON 配置。
 * @returns {Promise<{path:string, changed:boolean, already:boolean}>}
 */
export async function applyTokenToBridgeConfig({ configPath, token, force = false, fsOps = fs } = {}) {
  if (typeof configPath !== 'string' || configPath.trim() === '') {
    throw codedError('INVALID_PATH', '必须通过 --apply-bridge <显式 JSON 路径> 指定配置文件');
  }
  if (!isValidToken(token)) throw codedError('INVALID_TOKEN', 'token 格式非法');
  const resolved = path.resolve(configPath);

  let raw;
  try {
    raw = await fsOps.readFile(resolved, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw codedError('CONFIG_NOT_FOUND', `配置文件不存在：${resolved}`);
    throw codedError('READ_FAILED', `读取配置文件失败：${resolved}（${error?.code ?? 'UNKNOWN'}）`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw codedError('INVALID_JSON', `配置文件不是合法 JSON：${resolved}`);
  }
  if (!isPlainObject(parsed)) throw codedError('INVALID_CONFIG', '配置文件顶层必须是对象');
  if (parsed.backgroundPatrol !== undefined && !isPlainObject(parsed.backgroundPatrol)) {
    throw codedError('INVALID_CONFIG', 'backgroundPatrol 必须是对象');
  }
  const existing = parsed.backgroundPatrol?.authorizeToken;
  if (existing !== undefined && typeof existing !== 'string') {
    throw codedError('INVALID_CONFIG', 'backgroundPatrol.authorizeToken 必须是字符串');
  }
  if (existing === token) return { path: resolved, changed: false, already: true };
  if (existing !== undefined && existing !== token && force !== true) {
    throw codedError('TOKEN_EXISTS', `目标配置已有不同的 authorizeToken；确认要覆盖请加 --force（${resolved}）`);
  }

  const updated = {
    ...parsed,
    backgroundPatrol: { ...(parsed.backgroundPatrol ?? {}), authorizeToken: token },
  };
  const payload = `${JSON.stringify(updated, null, 2)}\n`;
  const directory = path.dirname(resolved);
  const tempPath = path.join(directory, `${path.basename(resolved)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    await fsOps.writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fsOps.rename(tempPath, resolved);
  } catch (error) {
    try {
      await fsOps.unlink(tempPath);
    } catch {
      // ignore
    }
    throw codedError('WRITE_FAILED', `写入配置文件失败：${resolved}（${error?.code ?? 'UNKNOWN'}）`);
  }
  return { path: resolved, changed: true, already: false };
}

function printUsage(stream) {
  stream.write([
    '用法：node scripts/generate-authorize-token.mjs [选项]',
    '',
    '默认 dry-run：生成 32 字节随机 token（64 位 hex）并只打印一次；不写任何文件。',
    '  --json                      单行 JSON 输出 {token,length,note}',
    '  --print-plugin-snippet      额外输出可粘贴到插件 profile 的 YAML 片段',
    '  --apply-bridge <path>       把 token 写入显式指定的 bridge JSON 配置的 backgroundPatrol.authorizeToken',
    '  --force                     目标已有不同 token 时允许覆盖',
    '  --help                      显示本帮助',
    '',
    '退出码：0 成功 / 2 参数错误 / 1 IO 或配置错误。',
    '',
  ].join('\n'));
}

function parseArgs(argv) {
  const options = { json: false, snippet: false, applyBridge: null, force: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--print-plugin-snippet') options.snippet = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--apply-bridge') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
        return { error: '--apply-bridge 需要一个显式 JSON 路径参数' };
      }
      options.applyBridge = value;
      index += 1;
    } else {
      return { error: `未知参数：${arg}` };
    }
  }
  return { options };
}

/**
 * CLI 主函数（可注入 stdout/stderr 便于测试；默认 process）。
 * @returns {Promise<0|1|2>}
 */
export async function main(argv = [], { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, randomBytes } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    stderr.write(`[xhh-token] ${parsed.error}\n`);
    printUsage(stderr);
    return EXIT_USAGE;
  }
  const options = parsed.options;
  if (options.help) {
    printUsage(stdout);
    return EXIT_OK;
  }

  const token = randomBytes === undefined ? generateToken() : generateToken({ randomBytes });
  const snippet = options.snippet ? buildPluginSnippet(token) : null;

  if (options.applyBridge !== null) {
    let applied;
    try {
      applied = await applyTokenToBridgeConfig({ configPath: path.resolve(cwd, options.applyBridge), token, force: options.force });
    } catch (error) {
      stderr.write(`[xhh-token] ${error?.message ?? '写入失败'}\n`);
      return EXIT_IO;
    }
    if (options.json) {
      const payload = buildJsonPayload(token, { includeSnippet: options.snippet });
      payload.applied = { path: applied.path, changed: applied.changed };
      stdout.write(`${JSON.stringify(payload)}\n`);
      return EXIT_OK;
    }
    if (snippet !== null) stdout.write(`${snippet}\n\n`);
    stdout.write(`[xhh-token] 已写入 ${applied.path}（backgroundPatrol.authorizeToken，${applied.changed ? '已更新' : '已存在相同值'}）\n`);
    stdout.write(`${NOTE}\n`);
    return EXIT_OK;
  }

  if (options.json) {
    stdout.write(`${JSON.stringify(buildJsonPayload(token, { includeSnippet: options.snippet }))}\n`);
    return EXIT_OK;
  }
  if (snippet !== null) {
    stdout.write(`${snippet}\n\n${NOTE}\n`);
    return EXIT_OK;
  }
  stdout.write(`${token}\n`);
  stdout.write(`${NOTE}\n`);
  return EXIT_OK;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[xhh-token] 未预期错误：${error?.code ?? 'UNKNOWN'}\n`);
    process.exitCode = EXIT_IO;
  }
}
