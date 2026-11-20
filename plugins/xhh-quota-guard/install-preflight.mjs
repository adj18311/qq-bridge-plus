// 离线安装预检：只读校验「候选插件目录」是否齐全、未混版、未损坏，并能与已安装目录比对。
//
// 边界（必须如实声明）：
// 1. 这是**完整性与一致性**检查，不是防篡改安全边界 —— 同权限者可同时改文件与清单；
// 2. 预检通过**不代表** Host 已成功加载；真实加载与门禁必须在部署后用运行时事实验证；
// 3. 静态 import 缺文件时插件整体加载失败，且插件内 fallback 也不会注册，因此「缺件」必须 fail-closed。
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const XHH_PLUGIN_FILES = Object.freeze([
  'index.mjs',
  'decision.mjs',
  'post-image-urls.mjs',
  'image-content.mjs',
  'image-admission.mjs',
  'safe-fetch.mjs',
]);

// 与权威副本必须逐字节一致的文件（仓库 src/safe-fetch.js 是权威源）。
export const XHH_PLUGIN_MIRRORED_FILE = 'safe-fetch.mjs';
export const XHH_SAFE_FETCH_SOURCE = 'src/safe-fetch.js';

export const XHH_PREFLIGHT_MANIFEST_NAME = 'INSTALL-MANIFEST.json';
export const XHH_PREFLIGHT_MANIFEST_VERSION = 1;

export const XHH_PREFLIGHT_FAILURE_CODES = Object.freeze([
  'manifest-missing',
  'manifest-invalid',
  'manifest-incomplete',
  'manifest-unknown-entry',
  'missing-file',
  'not-regular-file',
  'empty-file',
  'unreadable-file',
  'hash-mismatch',
  'safe-fetch-mirror-mismatch',
  'target-missing',
  'target-unusable',
  'target-mixed-version',
  'manifest-entry-invalid',
  'manifest-entry-unknown-field',
  'manifest-entry-sha-invalid',
  'manifest-entry-bytes-invalid',
  'size-mismatch',
  'safe-fetch-source-missing',
  'safe-fetch-mirror-check-skipped',
]);

export const XHH_PREFLIGHT_WARNING_CODES = Object.freeze(['target-extra-module']);

// 清单条目只允许这两个键；多写少写都按明确错误 fail-closed。
export const XHH_MANIFEST_ENTRY_KEYS = Object.freeze(['sha256', 'bytes']);
const SHA256_HEX = /^[0-9a-f]{64}$/u;

// 默认权威源：由本模块位置推仓库根（plugins/xhh-quota-guard/ → ../../），不依赖运行 cwd。
export function resolveDefaultSafeFetchSource() {
  return path.resolve(fileURLToPath(new URL('../../src/safe-fetch.js', import.meta.url)));
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function fail(code, file, detail) {
  return { level: 'error', code, file, detail };
}

function warn(code, file, detail) {
  return { level: 'warn', code, file, detail };
}

function inspectFile(fsImpl, filePath) {
  let stat;
  try {
    stat = fsImpl.lstatSync(filePath);
  } catch (error) {
    const code = error?.code === 'ENOENT' ? 'missing-file' : 'unreadable-file';
    return { ok: false, code, detail: String(error?.code ?? error?.message ?? 'stat-failed') };
  }
  if (stat.isSymbolicLink?.()) return { ok: false, code: 'not-regular-file', detail: 'symbolic-link' };
  if (!stat.isFile?.()) return { ok: false, code: 'not-regular-file', detail: 'not-a-regular-file' };
  let buffer;
  try {
    buffer = fsImpl.readFileSync(filePath);
  } catch (error) {
    return { ok: false, code: 'unreadable-file', detail: String(error?.code ?? error?.message ?? 'read-failed') };
  }
  if (!buffer || buffer.length === 0) return { ok: false, code: 'empty-file', detail: 'zero-bytes' };
  return { ok: true, sha256: sha256(buffer), bytes: buffer.length };
}

// 严格校验清单条目：必须是普通对象、只含 sha256/bytes、类型与取值范围合法。
function validateManifestEntries(manifestFiles) {
  const findings = [];
  for (const name of XHH_PLUGIN_FILES) {
    const entry = manifestFiles[name];
    if (entry === undefined) {
      findings.push(fail('manifest-incomplete', name, 'missing-in-manifest'));
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      findings.push(fail('manifest-entry-invalid', name, 'entry-not-an-object'));
      continue;
    }
    const extra = Object.keys(entry).filter((key) => !XHH_MANIFEST_ENTRY_KEYS.includes(key));
    if (extra.length > 0) findings.push(fail('manifest-entry-unknown-field', name, `unexpected=${extra.join(',')}`));
    if (typeof entry.sha256 !== 'string' || !SHA256_HEX.test(entry.sha256)) {
      findings.push(fail('manifest-entry-sha-invalid', name, `sha256=${JSON.stringify(entry.sha256) ?? 'undefined'}`.slice(0, 120)));
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) {
      findings.push(fail('manifest-entry-bytes-invalid', name, `bytes=${JSON.stringify(entry.bytes) ?? 'undefined'}`.slice(0, 120)));
    }
  }
  return findings;
}

function readManifest(fsImpl, manifestPath) {
  let raw;
  try {
    raw = fsImpl.readFileSync(manifestPath, 'utf8');
  } catch (error) {
    return { ok: false, code: error?.code === 'ENOENT' ? 'manifest-missing' : 'unreadable-file', detail: String(error?.code ?? 'read-failed') };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'manifest-invalid', detail: 'not-json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, code: 'manifest-invalid', detail: 'not-an-object' };
  if (parsed.version !== XHH_PREFLIGHT_MANIFEST_VERSION) return { ok: false, code: 'manifest-invalid', detail: `version=${String(parsed.version)}` };
  if (!parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) return { ok: false, code: 'manifest-invalid', detail: 'files-missing' };
  return { ok: true, manifest: parsed };
}

/** 用目录内容生成清单（不含时间戳，便于 diff）。 */
export function buildInstallManifest({ dir, fs: fsImpl }) {
  const files = {};
  const missing = [];
  for (const name of XHH_PLUGIN_FILES) {
    const inspected = inspectFile(fsImpl, path.join(dir, name));
    if (!inspected.ok) {
      missing.push({ file: name, code: inspected.code, detail: inspected.detail });
      continue;
    }
    files[name] = { sha256: inspected.sha256, bytes: inspected.bytes };
  }
  return { manifest: { version: XHH_PREFLIGHT_MANIFEST_VERSION, files }, missing };
}

export function serializeInstallManifest(manifest) {
  const ordered = { version: manifest.version, files: {} };
  for (const name of [...XHH_PLUGIN_FILES].sort()) ordered.files[name] = manifest.files[name];
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * 离线预检。只看文件，不碰进程、不写目标目录。
 * @returns {{ok:boolean, findings:Array, summary:{checked:number, errors:number, warnings:number}}}
 */
export function preflightPluginInstall({
  candidateDir,
  manifestPath = path.join(candidateDir, XHH_PREFLIGHT_MANIFEST_NAME),
  targetDir = null,
  authoritativeSafeFetchPath = undefined, // undefined=用仓库默认源；null=显式跳过（不可作为部署预检通过）
  fs: fsImpl,
} = {}) {
  const findings = [];
  const push = (item) => findings.push(item);

  const loaded = readManifest(fsImpl, manifestPath);
  if (!loaded.ok) push(fail(loaded.code, XHH_PREFLIGHT_MANIFEST_NAME, loaded.detail));

  const manifestFiles = loaded.ok ? loaded.manifest.files : null;
  let entriesValid = false;
  if (manifestFiles) {
    for (const name of Object.keys(manifestFiles)) {
      if (!XHH_PLUGIN_FILES.includes(name)) push(fail('manifest-unknown-entry', name, 'not-a-known-module'));
    }
    const entryFindings = validateManifestEntries(manifestFiles);
    for (const item of entryFindings) push(item);
    entriesValid = entryFindings.length === 0;
  }

  const observed = {};
  for (const name of XHH_PLUGIN_FILES) {
    const inspected = inspectFile(fsImpl, path.join(candidateDir, name));
    if (!inspected.ok) {
      push(fail(inspected.code, name, inspected.detail));
      continue;
    }
    observed[name] = inspected;
    const entry = entriesValid ? manifestFiles[name] : null;
    if (entry) {
      if (entry.sha256 !== inspected.sha256) {
        push(fail('hash-mismatch', name, `manifest=${entry.sha256.slice(0, 16)} actual=${inspected.sha256.slice(0, 16)}`));
      }
      if (entry.bytes !== inspected.bytes) {
        push(fail('size-mismatch', name, `manifest=${entry.bytes} actual=${inspected.bytes}`));
      }
    }
  }

  // undefined = 用仓库默认权威源；null = 显式跳过（必须让预检不通过，不能当作部署预检通过）。
  if (authoritativeSafeFetchPath === null) {
    push(fail('safe-fetch-mirror-check-skipped', XHH_PLUGIN_MIRRORED_FILE, 'explicitly-skipped'));
  }
  const effectiveSource = authoritativeSafeFetchPath === undefined ? resolveDefaultSafeFetchSource() : authoritativeSafeFetchPath;
  if (effectiveSource !== null) {
    const authoritative = inspectFile(fsImpl, effectiveSource);
    const mirrored = observed[XHH_PLUGIN_MIRRORED_FILE];
    if (!authoritative.ok) {
      push(fail('safe-fetch-source-missing', XHH_SAFE_FETCH_SOURCE, `${authoritative.code}:${authoritative.detail}`));
    } else if (mirrored && mirrored.sha256 !== authoritative.sha256) {
      push(fail('safe-fetch-mirror-mismatch', XHH_PLUGIN_MIRRORED_FILE, `mirror=${mirrored.sha256.slice(0, 16)} source=${authoritative.sha256.slice(0, 16)}`));
    }
  }

  if (targetDir) {
    for (const name of XHH_PLUGIN_FILES) {
      const target = inspectFile(fsImpl, path.join(targetDir, name));
      if (!target.ok) {
        push(fail(target.code === 'missing-file' ? 'target-missing' : 'target-unusable', name, `${target.code}:${target.detail}`));
        continue;
      }
      const candidate = observed[name];
      if (candidate && target.sha256 !== candidate.sha256) {
        push(fail('target-mixed-version', name, `installed=${target.sha256.slice(0, 16)} candidate=${candidate.sha256.slice(0, 16)}`));
      }
    }
    let entries = [];
    try {
      entries = fsImpl.readdirSync(targetDir, { withFileTypes: true }) ?? [];
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (!name || !name.endsWith('.mjs')) continue;
      if (XHH_PLUGIN_FILES.includes(name)) continue;
      push(warn('target-extra-module', name, 'installed-but-not-in-candidate'));
    }
  }

  const errors = findings.filter((item) => item.level === 'error').length;
  const warnings = findings.filter((item) => item.level === 'warn').length;
  return {
    ok: errors === 0,
    findings,
    summary: { checked: XHH_PLUGIN_FILES.length, errors, warnings },
  };
}