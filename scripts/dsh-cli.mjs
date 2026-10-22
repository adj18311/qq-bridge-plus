// dsh-cli.mjs — 定位 DSH CLI（dsh.cmd）并用绝对路径执行 `plugin install`。
//
// 为什么需要：setup-dsh.mjs 过去直接 `cmd /c dsh.cmd plugin … install`，只依赖 PATH。
// DSH Desktop 把 CLI 装在 <安装根>/resources/runtime/cli/bin/dsh.cmd，但通常不在 PATH，
// 于是每次 setup 都拿到 exit=1（'dsh.cmd' is not recognized as an internal or external command）
// 并打出误导性的“把 bin 加进 PATH 后重跑”警告——而脚本自己的两级链接兜底其实一直在生效。
//
// 解析顺序（resolveDshCli；env / asarPath / pathLookup / inspectPath 全部可注入，
// 纯函数里不读 process.env、也不碰真实文件系统）：
//   1. DSH_CLI 环境变量（用户显式指定，优先级最高）
//   2. DSH 安装根推导：<root>/resources/runtime/cli/bin/dsh.cmd
//      root = discoverDshAsar() 找到的 <root>/resources/app.asar 取父目录的父目录
//   3. PATH 里的 dsh.cmd（Windows）/ dsh（其它平台）
//   4. 都没有 ⇒ kind='none'
// 解析只回答“用哪个 CLI、为什么”，不执行；执行入口是 runDshPluginInstall。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverDshAsar } from './dsh-asar.mjs';

export const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;

// Windows 上 Node 不能直接 spawn .cmd/.bat（CVE-2024-27980 起会 EINVAL），
// 必须借 cmd.exe；DSH Desktop 自带的是 dsh.cmd shim，.exe 也接受。
const WIN_CLI_NAMES = ['dsh.cmd', 'dsh.exe'];
const POSIX_CLI_NAMES = ['dsh'];

/** 该平台在 PATH / 安装目录里查找哪些文件名（按优先级）。 */
export function dshCliNames(platform = process.platform) {
  return platform === 'win32' ? [...WIN_CLI_NAMES] : [...POSIX_CLI_NAMES];
}

/** 默认的「这个路径存在吗、可执行吗」探测（statSync 会跟随符号链接/junction）。 */
export function createPathInspector(platform = process.platform) {
  return (candidate) => {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) return { isFile: false, executable: false };
      if (platform === 'win32') {
        const extension = path.extname(candidate).toLowerCase();
        return { isFile: true, executable: extension === '.cmd' || extension === '.bat' || extension === '.exe' };
      }
      fs.accessSync(candidate, fs.constants.X_OK);
      return { isFile: true, executable: true };
    } catch {
      return { isFile: false, executable: false };
    }
  };
}

/** 默认的 PATH 查找：按 PATH 顺序逐个目录找给定的文件名。 */
export function createPathLookup(env = {}, platform = process.platform) {
  const directories = String(env?.PATH ?? env?.Path ?? '')
    .split(path.delimiter)
    .filter(Boolean);
  return (names = dshCliNames(platform)) => {
    for (const directory of directories) {
      for (const name of names) {
        const candidate = path.join(directory, name);
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          /* 继续找下一个 */
        }
      }
    }
    return null;
  };
}

/**
 * 生产环境依赖：真实 env / 真实 ASAR 发现 / 真实 PATH / 真实文件系统。
 * 单测请直接向 resolveDshCli 注入这些依赖，不要调用本函数（否则结果依赖宿主机）。
 */
export function defaultDshCliDeps() {
  const platform = process.platform;
  return {
    env: process.env,
    asarPath: discoverDshAsar(),
    pathLookup: createPathLookup(process.env, platform),
    inspectPath: createPathInspector(platform),
    platform,
  };
}

/**
 * 按 DSH_CLI → 安装目录推导 → PATH 的顺序解析 CLI。
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   asarPath?: string | null,
 *   pathLookup?: (names: string[]) => string | null,
 *   inspectPath?: (candidate: string) => { isFile: boolean, executable: boolean },
 *   platform?: string,
 * }} deps 全部注入；缺省仅用于无法避免的 platform（测试请显式传）
 * @returns {{
 *   kind: 'env' | 'asar' | 'path' | 'none',
 *   path: string | null,
 *   reason: string,
 *   attempts: Array<{ kind: string, path: string | null, problem: string }>,
 * }}
 */
export function resolveDshCli({
  env = {},
  asarPath = null,
  pathLookup = null,
  inspectPath = null,
  platform = process.platform,
} = {}) {
  const names = dshCliNames(platform);
  const attempts = [];

  const reject = (kind, candidate, problem) => {
    attempts.push({ kind, path: candidate ?? null, problem });
    return null;
  };

  // 候选必须：绝对路径 + 普通文件 + 该平台可执行。任一不满足都只记录原因并继续下一来源。
  const check = (kind, candidate, label) => {
    const fail = (problem) => reject(kind, typeof candidate === 'string' ? candidate : null, label ? `${label}：${problem}` : problem);
    if (typeof candidate !== 'string' || !candidate.trim()) return fail('路径为空');
    if (!path.isAbsolute(candidate)) return fail('不是绝对路径');
    let info = null;
    try {
      info = inspectPath ? inspectPath(candidate) : null;
    } catch {
      info = null;
    }
    if (!info?.isFile) return fail('文件不存在或不是普通文件');
    if (!info.executable) {
      return fail('文件不可执行（Windows 需要 .cmd/.bat/.exe，其它平台需要可执行位）');
    }
    return candidate;
  };

  // ① DSH_CLI：用户显式指定。设置了但不可用时不硬失败，继续按安装目录/PATH 找。
  const explicit = typeof env?.DSH_CLI === 'string' ? env.DSH_CLI.trim() : '';
  if (!explicit) {
    attempts.push({ kind: 'env', path: null, problem: '未设置 DSH_CLI' });
  } else {
    const found = check('env', explicit, 'DSH_CLI 指向的 CLI');
    if (found) return { kind: 'env', path: found, reason: 'DSH_CLI 环境变量（用户显式指定）', attempts };
  }

  // ② 从 DSH 安装包位置推导安装根：<root>/resources/app.asar → <root>。
  if (!asarPath) {
    reject('asar', null, '未发现 DSH 安装包（DSH 桌面端未运行、非 Windows 或解包安装）');
  } else if (typeof asarPath !== 'string' || !path.isAbsolute(asarPath)) {
    reject('asar', typeof asarPath === 'string' ? asarPath : null, 'ASAR 路径不是绝对路径，无法推导安装根');
  } else {
    const installRoot = path.dirname(path.dirname(asarPath));
    for (const name of names) {
      const candidate = path.join(installRoot, 'resources', 'runtime', 'cli', 'bin', name);
      const found = check('asar', candidate, '安装目录推导的 CLI');
      if (found) {
        return { kind: 'asar', path: found, reason: `从 DSH 安装包推导（${asarPath}）`, attempts };
      }
    }
  }

  // ③ PATH。pathLookup 的返回值仍走同一套校验：PATH 里同名但不是 CLI 的会被拒绝。
  let fromPath = null;
  try {
    fromPath = pathLookup ? pathLookup(names) : null;
  } catch {
    fromPath = null;
  }
  if (!fromPath) {
    attempts.push({ kind: 'path', path: null, problem: `PATH 中没有 ${names.join(' / ')}` });
  } else {
    const found = check('path', fromPath, 'PATH 中的 CLI');
    if (found) return { kind: 'path', path: found, reason: `PATH 中的 ${path.basename(found)}`, attempts };
  }

  // ④ 都没有：reason 汇总每一步的原因（去重，避免同文件名的候选重复刷屏）。
  return {
    kind: 'none',
    path: null,
    reason: [...new Set(attempts.map((attempt) => attempt.problem))].join('；'),
    attempts,
  };
}

/**
 * 构造 `dsh plugin --profile <profile> install` 的 spawn 参数。
 *
 * Windows 必须经 cmd.exe。profile 仍通过环境变量单次展开（与旧实现同一策略）：
 * profile 里允许出现 `& % !` 等字符，直接拼进 /c 的命令串会被 cmd 二次解析
 * （`%CD%` 会被展开、`&` 会切分命令）。/v:off 保住 `!`，环境变量展开只做一遍。
 * CLI 路径用绝对路径并加引号（安装路径通常带空格）。
 */
export function buildDshPluginInstallCommand(cliPath, profile, { platform = process.platform, env = process.env } = {}) {
  if (typeof cliPath !== 'string' || !cliPath) throw new Error('DSH CLI 路径为空');
  if (typeof profile !== 'string' || !profile) throw new Error('profile 为空');
  if (platform === 'win32') {
    return {
      command: env?.ComSpec || env?.COMSPEC || 'cmd.exe',
      // /s 会剥掉命令串首尾的一对引号：`""<cli>" … install"` → `"<cli>" … install`。
      args: ['/d', '/v:off', '/s', '/c', `""${cliPath}" plugin --profile "%QQ_BRIDGE_SETUP_PROFILE%" install"`],
      extraEnv: { QQ_BRIDGE_SETUP_PROFILE: profile },
      windowsVerbatimArguments: true,
    };
  }
  return {
    command: cliPath,
    args: ['plugin', '--profile', profile, 'install'],
    extraEnv: {},
    windowsVerbatimArguments: false,
  };
}

/**
 * 用解析出的绝对路径执行 CLI 物化；返回结构化结果，不在内部打印/退出。
 *
 * @param {{
 *   cliPath: string, profile: string,
 *   platform?: string, env?: NodeJS.ProcessEnv,
 *   spawn?: typeof spawnSync, timeoutMs?: number, windowsHide?: boolean,
 * }} deps
 * @returns {{
 *   ok: boolean, status: number | null, signal: string | null,
 *   error: { code: string | null, message: string } | null,
 *   stdout: string, stderr: string, cliPath: string, command: string, args: string[],
 * }}
 */
export function runDshPluginInstall({
  cliPath,
  profile,
  platform = process.platform,
  env = process.env,
  spawn = spawnSync,
  timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
  windowsHide = true,
} = {}) {
  const spec = buildDshPluginInstallCommand(cliPath, profile, { platform, env });
  const result = spawn(spec.command, spec.args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
    env: { ...env, ...spec.extraEnv },
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status ?? null,
    signal: result.signal ?? null,
    error: result.error ? { code: result.error.code ?? null, message: result.error.message } : null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    cliPath,
    command: spec.command,
    args: spec.args,
  };
}

/** stderr 尾部：最多 limit 行、忽略空行（用于失败告警，不刷屏）。 */
export function tailLines(text, limit = 8) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-limit);
}

/**
 * 生成 setup 要打印的结论行：成功一行；失败含 stderr 尾部与明确处置。
 * 两级链接兜底始终存在，所以失败也只降级为提示，不阻断安装。
 */
export function formatDshPluginInstallReport(outcome, { kind = 'unknown', profile = '', tailLimit = 8 } = {}) {
  if (outcome.ok) return [`dsh CLI 物化完成（来源=${kind}）`];
  const lines = [];
  if (outcome.error) {
    const reason = outcome.error.code || outcome.error.message || '未知错误';
    const label = reason === 'ETIMEDOUT' ? '执行超时' : '无法启动';
    lines.push(`dsh CLI 物化未完成（来源=${kind}，${label}：${reason}）`);
  } else {
    lines.push(`dsh CLI 物化失败（来源=${kind}，退出码 ${outcome.status}）`);
  }
  const tail = tailLines(outcome.stderr, tailLimit);
  if (tail.length) {
    lines.push('CLI stderr 尾部：');
    for (const line of tail) lines.push(`  | ${line}`);
  }
  lines.push(
    `已用两级链接兜底（插件目录 + profile node_modules），DSH bundle 仍可解析；`
    + `若 DSH 启动报 bundle 解析失败，先按上面的 CLI 输出排查，或设置 DSH_CLI 指向可用的 dsh.cmd 后重跑本脚本`
    + `${profile ? `（profile=${profile}）` : ''}。`,
  );
  return lines;
}
