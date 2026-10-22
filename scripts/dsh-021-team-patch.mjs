// DSH 0.2.1 Team 适配片段的部署逻辑（F.2）。
//
// 为什么需要这段：DSH 0.2.1 把原生 Team 工具安装进每个 Agent 自己的 scope，
// qq-tool-restrict 的全局 restrict 管不到；profile 必须禁用 tool-agent-team 并插入
// qq-agent-presets/qq-native-team-filter.mjs。该片段只对 0.2.1+ 有效，所以不能
// 放进通用 bundle，只能由 setup-dsh.mjs 按版本部署。
//
// 设计约束：
//   · mergeTeamPatch() 是纯函数：只吃字符串、只吐字符串 + 诊断，便于单测；
//   · 幂等：两个操作都在就一个字节都不改；
//   · 非破坏：只把缺失的操作追加到文件末尾，绝不重排/重写既有条目；
//   · 版本门控：ASAR 读不到版本就跳过，绝不猜；
//   · 备份 + 原子替换：由 scripts/file-io.mjs 统一提供。
//
// 生产写入路径：prepareTeamPatchDeployment() 只在内存里合并，setup-dsh.mjs 再把
// 合并结果交给 MCP 同步一起原子写入（一次 setup 只写一次 profile）。
// deployTeamPatch() 是同一流程的独立落盘版本，供测试与单独调用。
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { discoverDshAsar, readDshVersionFromAsar } from './dsh-asar.mjs';
import { backupBeforeOverwrite, writeFileAtomic } from './file-io.mjs';

export const TEAM_ENTRY_ID = 'tool-agent-team';
export const FILTER_ENTRY_ID = 'qq-native-team-filter';
export const TEAM_FRAGMENT_PATH = 'plugins/qq-agent-presets/compat/dsh-021-team.patch.yml';
export const SKIP_ENV = 'QQ_SKIP_021_TEAM_PATCH';
export const FORCE_ENV = 'QQ_FORCE_021_TEAM_PATCH';
export const DSH_021_MINIMUM = Object.freeze({ major: 0, minor: 2, patch: 1 });

const VERSION_PATTERN = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:[+-][0-9A-Za-z.-]+)?\s*$/;

/**
 * Parse a DSH version string.
 *
 * Only the numeric major.minor.patch takes part in the gate: the deployed desktop
 * build is `0.2.1-rc.2`, and strict SemVer precedence would rank that *below* 0.2.1,
 * which is the exact build this fragment targets. Prerelease/build suffixes of the
 * same numeric version are therefore treated as that version on purpose.
 */
export function parseDshVersion(raw) {
  if (typeof raw !== 'string') return null;
  const match = VERSION_PATTERN.exec(raw);
  if (!match) return null;
  const version = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: raw.trim(),
  };
  if (![version.major, version.minor, version.patch].every(Number.isSafeInteger)) return null;
  return version;
}

export function compareDshVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  return 0;
}

export function isDshAtLeast(version, minimum = DSH_021_MINIMUM) {
  return Boolean(version) && compareDshVersions(version, minimum) >= 0;
}

/**
 * Read the installed DSH version from the desktop ASAR.
 * Never guesses: an unreadable archive/metadata yields `{ status: 'unavailable', reason }`.
 */
export function detectDshVersion({ archive, env = process.env } = {}) {
  const asar = archive ?? env.DSH_INSTALL_ASAR ?? discoverDshAsar();
  if (!asar) {
    return {
      status: 'unavailable',
      reason: '找不到 DSH 安装包 app.asar（DSH 未运行、非 Windows 桌面版，或未设置 DSH_INSTALL_ASAR）',
    };
  }
  let read;
  try {
    read = readDshVersionFromAsar(asar);
  } catch (error) {
    return { status: 'unavailable', reason: `无法读取 ASAR：${error.message}`, archive: asar };
  }
  if (!read.version) {
    return { status: 'unavailable', reason: `ASAR 里没有版本信息（${read.problem}）`, archive: asar };
  }
  const parsed = parseDshVersion(read.version);
  if (!parsed) {
    return { status: 'unavailable', reason: `版本号无法解析：${JSON.stringify(read.version)}`, archive: asar };
  }
  return { status: 'detected', version: read.version, parsed, source: read.source, archive: asar };
}

function envEnabled(env, name) {
  const value = String(env?.[name] ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * Decide whether the 0.2.1 fragment may be deployed. Pure policy: no I/O unless
 * `versionInfo` is omitted, in which case the ASAR is read exactly once.
 * Precedence: explicit skip > explicit force > version gate.
 */
export function planTeamPatchDeployment({ versionInfo, archive, env = process.env } = {}) {
  if (envEnabled(env, SKIP_ENV)) {
    return { deploy: false, forced: false, reason: `${SKIP_ENV}=1：按环境变量显式跳过 DSH 0.2.1 Team 片段` };
  }
  if (envEnabled(env, FORCE_ENV)) {
    return {
      deploy: true,
      forced: true,
      reason: `${FORCE_ENV}=1：跳过版本门控强制部署（仅用于明确知道目标版本的场景）`,
    };
  }
  const info = versionInfo ?? detectDshVersion({ archive, env });
  if (!info || info.status !== 'detected') {
    return {
      deploy: false,
      forced: false,
      reason: `无法读取 DSH 版本：${info?.reason ?? '未知原因'}；跳过部署（不猜测版本，避免装到老版本上）`,
    };
  }
  if (!isDshAtLeast(info.parsed)) {
    return {
      deploy: false,
      forced: false,
      version: info.version,
      reason: `检测到 DSH ${info.version}（${info.source}）< 0.2.1：片段仅适用于 0.2.1+，跳过`,
    };
  }
  return {
    deploy: true,
    forced: false,
    version: info.version,
    source: info.source,
    reason: `检测到 DSH ${info.version}（${info.source}）>= 0.2.1`,
  };
}

export function stripBom(text) {
  return String(text ?? '').replace(/^\uFEFF/, '');
}

/**
 * Remove the historical invalid root `[]` when block operations follow it.
 * A nested `[]` or a line inside a literal scalar is user data and must survive.
 */
export function repairBareRootArray(text) {
  const source = stripBom(text);
  const lines = source.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (first >= 0 && lines[first].trim() === '[]'
      && lines.slice(first + 1).some((line) => /^-\s/.test(line))) {
    // Only normalize line endings when the repair itself is needed; otherwise the
    // caller's bytes (including mixed endings) stay untouched.
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    lines.splice(first, 1);
    return lines.join(newline);
  }
  return source;
}

function parsePatchArray(text, label) {
  let doc;
  try {
    doc = yaml.load(text);
  } catch (error) {
    throw new Error(`${label} 不是合法 YAML：${error.message}`);
  }
  const operations = doc ?? [];
  if (!Array.isArray(operations)) throw new Error(`${label} 顶层必须是 YAML 数组`);
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new Error(`${label} 含非对象条目：${JSON.stringify(operation)}`);
    }
    if (Object.hasOwn(operation, 'insert') && !Array.isArray(operation.insert)) {
      throw new Error(`${label} 的 insert 必须是数组`);
    }
  }
  return operations;
}

/**
 * Read the two facts that decide the merge: is `tool-agent-team` already disabled,
 * and is `qq-native-team-filter` already inserted? Throws on malformed patches so a
 * bad profile is never "repaired" by guessing.
 */
export function inspectTeamPatch(text) {
  const operations = parsePatchArray(stripBom(text), 'profile patch');
  let hasDisable = false;
  let filterCount = 0;
  let filterEntry = null;
  for (const operation of operations) {
    if (operation.id === TEAM_ENTRY_ID && operation.disabled === true) hasDisable = true;
    for (const entry of operation.insert ?? []) {
      if (entry?.id !== FILTER_ENTRY_ID) continue;
      filterCount += 1;
      filterEntry ??= entry;
    }
  }
  return { operations: operations.length, hasDisable, hasFilter: filterCount > 0, filterCount, filterEntry };
}

/** Parse the checked-in fragment and extract the two operations appended on demand. */
export function parseTeamFragment(fragmentText) {
  const operations = parsePatchArray(stripBom(fragmentText), 'Team 片段');
  const disableOp = operations.find((operation) => operation.id === TEAM_ENTRY_ID && operation.disabled === true);
  if (!disableOp) throw new Error(`Team 片段缺少 "${TEAM_ENTRY_ID}" 的 disabled: true 操作`);
  const insertOp = operations.find((operation) => Array.isArray(operation.insert)
    && operation.insert.some((entry) => entry?.id === FILTER_ENTRY_ID));
  if (!insertOp) throw new Error(`Team 片段缺少插入 ${FILTER_ENTRY_ID} 的操作`);
  const filterEntry = insertOp.insert.find((entry) => entry?.id === FILTER_ENTRY_ID);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  return { disableOp: clone(disableOp), insertOp: clone(insertOp), filterEntry: clone(filterEntry) };
}

/**
 * Pure merge: original profile patch text + fragment text (+ optional "already
 * applied" hint) -> new text + diagnostics. No filesystem access.
 *
 * The only mutation is appending the missing operation(s) at the end of the file.
 * Existing entries, their order, comments and the fragment's own contents are kept.
 * When both operations are already present the input is returned byte-for-byte.
 */
export function mergeTeamPatch(originalText, fragmentText, { applied } = {}) {
  const source = stripBom(originalText);
  if (applied === true) {
    return {
      text: source,
      changed: false,
      diagnostics: {
        action: 'unchanged',
        reason: 'already-applied',
        addedDisable: false,
        addedFilter: false,
      },
    };
  }
  const fragment = parseTeamFragment(fragmentText);
  const repaired = repairBareRootArray(source);
  const state = inspectTeamPatch(repaired);
  if (state.hasDisable && state.hasFilter) {
    return {
      text: source,
      changed: false,
      diagnostics: {
        action: 'unchanged',
        reason: 'complete',
        addedDisable: false,
        addedFilter: false,
        alreadyDisabled: true,
        alreadyFiltered: true,
        filterCount: state.filterCount,
        operationsBefore: state.operations,
        operationsAfter: state.operations,
      },
    };
  }
  let base = repaired;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  // A root `[]` followed by block items is invalid YAML; drop that line, keep comments.
  if (state.operations === 0 && /^[ \t]*\[\][ \t]*$/m.test(base)) {
    base = base.split(/\r?\n/).filter((line) => !/^[ \t]*\[\][ \t]*$/.test(line)).join(newline);
  }
  const missing = [];
  if (!state.hasDisable) missing.push(fragment.disableOp);
  if (!state.hasFilter) missing.push(fragment.insertOp);
  const block = yaml.dump(missing, { lineWidth: -1, noRefs: true }).replace(/\n/g, newline);
  const header = `# === qq-bridge DSH 0.2.1 Team adaptation (managed by scripts/setup-dsh.mjs) ===${newline}`;
  const separator = base.length === 0 ? '' : (base.endsWith(newline) ? newline : `${newline}${newline}`);
  const text = `${base}${separator}${header}${block}`;
  return {
    text,
    changed: text !== source,
    diagnostics: {
      action: missing.length === 2 ? 'inserted' : 'completed',
      addedDisable: !state.hasDisable,
      addedFilter: !state.hasFilter,
      alreadyDisabled: state.hasDisable,
      alreadyFiltered: state.hasFilter,
      filterCount: state.filterCount,
      operationsBefore: state.operations,
      operationsAfter: state.operations + missing.length,
    },
  };
}

function readPatchIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw new Error(`无法读取 profile patch：${file}（${error?.code ?? error?.message}）`, { cause: error });
  }
}

function readTeamFragment(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`DSH 0.2.1 Team 片段文件缺失或不可读：${file}（${error?.code ?? error?.message}）；拒绝静默跳过`, { cause: error });
  }
}

/**
 * Gate + read + merge, but never write. setup-dsh.mjs combines `text` with the MCP
 * sync so one setup run rewrites the profile at most once.
 */
export function prepareTeamPatchDeployment({
  patchFile,
  fragmentFile,
  text,
  versionInfo,
  archive,
  env = process.env,
  log = () => {},
} = {}) {
  if (typeof patchFile !== 'string' || !patchFile) throw new Error('prepareTeamPatchDeployment: patchFile 必填');
  if (typeof fragmentFile !== 'string' || !fragmentFile) throw new Error('prepareTeamPatchDeployment: fragmentFile 必填');
  const plan = planTeamPatchDeployment({ versionInfo, archive, env });
  if (!plan.deploy) {
    log(`DSH 0.2.1 Team 片段：跳过（${plan.reason}）`);
    return { deployed: false, changed: false, plan, text: text ?? readPatchIfExists(patchFile), diagnostics: null };
  }
  log(`DSH 0.2.1 Team 片段：${plan.reason}`);
  const fragmentText = readTeamFragment(fragmentFile);
  const original = text ?? readPatchIfExists(patchFile);
  const current = inspectTeamPatch(repairBareRootArray(original));
  const merge = mergeTeamPatch(original, fragmentText, {
    applied: current.hasDisable && current.hasFilter,
  });
  if (merge.changed) {
    const parts = [];
    if (merge.diagnostics.addedDisable) parts.push(`disabled: true（${TEAM_ENTRY_ID}）`);
    if (merge.diagnostics.addedFilter) parts.push(FILTER_ENTRY_ID);
    log(`DSH 0.2.1 Team 片段：需要部署（追加 ${parts.join(' + ')}）`);
  } else {
    log('DSH 0.2.1 Team 片段：已部署且完整（disable + filter 均在），未改动（幂等）');
  }
  return { deployed: true, changed: merge.changed, plan, text: merge.text, diagnostics: merge.diagnostics };
}

/**
 * Standalone deployment: same gate/merge as prepare, plus timestamped backup and
 * atomic replacement. setup-dsh.mjs uses prepare + its combined write instead, so a
 * single run does not rewrite the profile twice.
 */
export function deployTeamPatch(options = {}) {
  const { patchFile, log = () => {} } = options;
  const prepared = prepareTeamPatchDeployment(options);
  if (!prepared.deployed || !prepared.changed) {
    return { ...prepared, written: false, backupFile: null };
  }
  fs.mkdirSync(path.dirname(patchFile), { recursive: true });
  const backupFile = backupBeforeOverwrite(patchFile, { log });
  if (backupFile) log(`备份：${backupFile}`);
  else log('备份：无（原文件不存在，无需备份）');
  writeFileAtomic(patchFile, prepared.text);
  log(`DSH 0.2.1 Team 片段：已写入 ${patchFile}`);
  return { ...prepared, written: true, backupFile };
}
