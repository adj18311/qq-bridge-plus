// Read-only access to the packages shipped inside the DSH desktop archive.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 默认的命令执行器：跑 PowerShell 并拿 stdout（可注入以便离线测试）。 */
function runPowerShell(query) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query],
    { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}

// 两段式：CIM 可能被禁用 / 不可用 / 超时（实测偶发返回空），故再退一步用 Get-Process。
// 任一段成功即可定位安装目录；都失败才返回 null（调用方据此跳过或报错）。
// 注意：两段各有独立的失败形态（返回空、抛错、超时、JSON 非法、路径不带 resources/app.asar），
// 不能只用一个成功用例就宣称覆盖。
export const DSH_PROCESS_QUERIES = Object.freeze({
  cim: "@(Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" | Select-Object -ExpandProperty ExecutablePath -Unique) | ConvertTo-Json -Compress",
  getProcess: "@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique) | ConvertTo-Json -Compress",
});

/**
 * @param {object} [options]
 * @param {string} [options.platform] 覆盖 process.platform（测试非 Windows 分支）
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(query:string)=>string} [options.runCommand] 执行一次查询并返回 stdout
 * @param {(p:string)=>boolean} [options.exists] 判断候选 app.asar 是否存在
 */
export function discoverDshAsar(options = {}) {
  const {
    platform = process.platform,
    env = process.env,
    runCommand = runPowerShell,
    exists = fs.existsSync,
  } = options;
  if (env.DSH_INSTALL_ASAR) return env.DSH_INSTALL_ASAR;
  if (platform !== 'win32') return null;
  for (const query of [DSH_PROCESS_QUERIES.cim, DSH_PROCESS_QUERIES.getProcess]) {
    let output;
    try {
      output = runCommand(query);
    } catch { continue; /* 这一段不可用（抛错 / 超时 / 退出码非 0），继续试下一段。 */ }
    if (typeof output !== 'string' || output.trim() === '') continue;
    let value;
    try { value = JSON.parse(output); } catch { continue; /* 输出不是合法 JSON，继续试下一段。 */ }
    for (const executable of Array.isArray(value) ? value : [value]) {
      if (typeof executable !== 'string' || executable === '') continue;
      const candidate = path.join(path.dirname(executable), 'resources', 'app.asar');
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Open the archive header once and run `fn` with the parsed tree.
 * Read-only: no archive code is extracted or executed.
 */
function openAsar(archive, fn) {
  let fd;
  try {
    fd = fs.openSync(archive, 'r');
    const stat = fs.fstatSync(fd);
    const prefix = Buffer.alloc(16);
    if (fs.readSync(fd, prefix, 0, 16, 0) !== 16 || prefix.readUInt32LE(0) !== 4) {
      throw new Error('invalid header');
    }
    const headerLength = prefix.readUInt32LE(12);
    const dataOffset = 8 + prefix.readUInt32LE(4);
    if (headerLength > 32 * 1024 * 1024 || headerLength < 2
      || dataOffset < 16 + headerLength || dataOffset > stat.size) throw new Error('invalid header size');
    const header = Buffer.alloc(headerLength);
    if (fs.readSync(fd, header, 0, headerLength, 16) !== headerLength) throw new Error('truncated header');
    const tree = JSON.parse(header.toString('utf8'));
    return fn({ tree, dataOffset, stat, fd });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readEntryText({ dataOffset, stat, fd }, entry) {
  const offset = Number(entry.offset);
  if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isSafeInteger(offset)
    || offset < 0 || dataOffset + offset + entry.size > stat.size) throw new Error('invalid entry');
  const buffer = Buffer.alloc(entry.size);
  if (fs.readSync(fd, buffer, 0, buffer.length, dataOffset + offset) !== buffer.length) {
    throw new Error('truncated entry');
  }
  return buffer.toString('utf8');
}

/** Visit only JS/TS/YAML package sources; never extract or execute archive code. */
export function visitDshAsarSources(archive, visit) {
  try {
    return openAsar(archive, ({ tree, dataOffset, stat, fd }) => {
      const packages = tree.files?.dsh?.files?.node_modules?.files?.['@deepseek-ai']?.files;
      if (!packages) throw new Error('DSH package subtree is missing');
      function walk(entry, filename, pkg, depth = 0) {
        if (depth > 8) return;
        for (const [name, item] of Object.entries(entry.files ?? {})) {
          if (name === 'node_modules' || name === '.git') continue;
          const relative = `${filename}/${name}`;
          if (item.files) { walk(item, relative, pkg, depth + 1); continue; }
          if (!/\.(?:js|mjs|cjs|ts|ya?ml)$/.test(name) || item.link || item.size > 8 * 1024 * 1024) continue;
          let text;
          if (item.unpacked) {
            text = fs.readFileSync(path.join(`${archive}.unpacked`, ...relative.split('/')), 'utf8');
          } else {
            try {
              text = readEntryText({ dataOffset, stat, fd }, item);
            } catch (error) {
              throw new Error(`${error.message} ${relative}`);
            }
          }
          visit({ filename: relative, text, pkg });
        }
      }
      const names = Object.keys(packages).filter((name) => name.startsWith('dsh-'));
      for (const name of names) walk(packages[name], `dsh/node_modules/@deepseek-ai/${name}`, name);
      return names;
    });
  } catch (error) {
    throw new Error(`Cannot scan DSH ASAR ${archive}: ${error.message}`, { cause: error });
  }
}

/** Read one file from the archive (null when absent); directories and links are null. */
export function readDshAsarEntry(archive, entryPath) {
  const parts = String(entryPath).split('/').filter(Boolean);
  try {
    return openAsar(archive, (context) => {
      let entry = context.tree;
      for (const part of parts) {
        entry = entry?.files?.[part];
        if (!entry) return null;
      }
      if (entry.files || entry.link || !Number.isSafeInteger(entry.size)) return null;
      try {
        return readEntryText(context, entry);
      } catch (error) {
        throw new Error(`${error.message} ${parts.join('/')}`);
      }
    });
  } catch (error) {
    throw new Error(`Cannot read DSH ASAR ${archive}: ${error.message}`, { cause: error });
  }
}

// 版本候选：桌面安装包把 runtime 的 package.json 放在 dsh/ 下；解包安装或
// 精简归档可能只剩根 package.json。全部读不到才算「读不到版本」。
const DSH_VERSION_SOURCES = [
  'dsh/package.json',
  'package.json',
  'dsh/node_modules/@deepseek-ai/dsh-desktop-runtime/package.json',
];

/**
 * Read the installed DSH version from the desktop ASAR.
 * Returns `{ version, source }`, or `{ version: null, problem }` when no source
 * carries a version string. Archive/read failures throw (callers decide to skip).
 */
export function readDshVersionFromAsar(archive) {
  const problems = [];
  for (const entryPath of DSH_VERSION_SOURCES) {
    // Archive/entry read failures are archive-level problems: let the caller
    // report "cannot read the ASAR" instead of pretending the version is absent.
    const text = readDshAsarEntry(archive, entryPath);
    if (text === null) continue;
    let version;
    try {
      version = JSON.parse(text)?.version;
    } catch (error) {
      problems.push(`${entryPath}: invalid JSON (${error.message})`);
      continue;
    }
    if (typeof version === 'string' && version.trim()) {
      return { version: version.trim(), source: entryPath };
    }
    problems.push(`${entryPath}: no version field`);
  }
  return { version: null, source: null, problem: problems.join('; ') || 'no version metadata entry' };
}
