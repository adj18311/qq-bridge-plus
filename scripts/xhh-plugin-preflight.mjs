// 运维用离线预检 CLI：不写任何安装目录、不碰进程。
//
//   node scripts/xhh-plugin-preflight.mjs --write-manifest plugins/xhh-quota-guard
//   node scripts/xhh-plugin-preflight.mjs --check plugins/xhh-quota-guard
//   node scripts/xhh-plugin-preflight.mjs --check plugins/xhh-quota-guard \
//     --safe-fetch-src src/safe-fetch.js --target C:/Users/<you>/.dsh/plugins/xhh-quota-guard --json
import fs from 'node:fs';
import path from 'node:path';
import {
  buildInstallManifest,
  preflightPluginInstall,
  serializeInstallManifest,
  XHH_PREFLIGHT_MANIFEST_NAME,
  XHH_SAFE_FETCH_SOURCE,
} from '../plugins/xhh-quota-guard/install-preflight.mjs';

const USAGE = `用法：
  node scripts/xhh-plugin-preflight.mjs --write-manifest <candidateDir>
  node scripts/xhh-plugin-preflight.mjs --check <candidateDir> [选项]

选项：
  --manifest <path>          清单路径（默认 <candidateDir>/${XHH_PREFLIGHT_MANIFEST_NAME}）
  --target <dir>             与已安装目录比对（可选）
  --safe-fetch-src <path>    安全下载权威源（默认按模块位置定位仓库 ${XHH_SAFE_FETCH_SOURCE}）
  --no-mirror-check          显式跳过镜像比对（会让预检失败，仅供诊断，不得作为部署预检）
  --json                     输出 JSON

退出码：0 = 通过；1 = 有错误；2 = 参数错误。`;

function takeValue(argv, index, option) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} 缺少取值`);
  return value;
}

function parseArgs(argv) {
  const options = { mode: null, candidateDir: null, manifest: null, target: null, safeFetchSrc: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write-manifest') options.mode = 'write';
    else if (arg === '--check') options.mode = 'check';
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-mirror-check') options.skipMirrorCheck = true;
    else if (arg === '--manifest') options.manifest = takeValue(argv, ++i, arg);
    else if (arg === '--target') options.target = takeValue(argv, ++i, arg);
    else if (arg === '--safe-fetch-src') options.safeFetchSrc = takeValue(argv, ++i, arg);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--')) throw new Error(`未知选项：${arg}`);
    else if (!options.candidateDir) options.candidateDir = arg;
    else throw new Error(`多余参数：${arg}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(String(error.message));
    console.error(USAGE);
    return 2;
  }
  if (options.help || !options.mode || !options.candidateDir) {
    console.log(USAGE);
    return options.help ? 0 : 2;
  }

  const candidateDir = path.resolve(options.candidateDir);
  try {
    if (options.skipMirrorCheck && options.safeFetchSrc) throw new Error('--no-mirror-check 不能与 --safe-fetch-src 同时使用');
    if (options.safeFetchSrc && path.resolve(path.dirname(path.resolve(options.safeFetchSrc))) === candidateDir) {
      throw new Error('--safe-fetch-src 不能指向候选目录自身的 safe-fetch.mjs（自比较会掩盖漂移）');
    }
  } catch (error) {
    console.error(String(error.message));
    console.error(USAGE);
    return 2;
  }

  if (options.mode === 'write') {
    const { manifest, missing } = buildInstallManifest({ dir: candidateDir, fs });
    if (missing.length > 0) {
      console.error('无法生成清单，以下文件不可用：');
      for (const item of missing) console.error(`  - ${item.file}: ${item.code} (${item.detail})`);
      return 1;
    }
    const manifestPath = options.manifest ? path.resolve(options.manifest) : path.join(candidateDir, XHH_PREFLIGHT_MANIFEST_NAME);
    fs.writeFileSync(manifestPath, serializeInstallManifest(manifest), 'utf8');
    console.log(`已写入清单：${manifestPath}`);
    for (const [name, meta] of Object.entries(manifest.files)) console.log(`  ${name} ${meta.sha256.slice(0, 16)} ${meta.bytes}B`);
    return 0;
  }

  const result = preflightPluginInstall({
    candidateDir,
    manifestPath: options.manifest ? path.resolve(options.manifest) : path.join(candidateDir, XHH_PREFLIGHT_MANIFEST_NAME),
    targetDir: options.target ? path.resolve(options.target) : null,
    authoritativeSafeFetchPath: options.safeFetchSrc
      ? path.resolve(options.safeFetchSrc)
      : (options.skipMirrorCheck ? null : undefined),
    fs,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const item of result.findings) {
      console.log(`${item.level === 'error' ? '✖' : '⚠'} ${item.code} ${item.file} — ${item.detail}`);
    }
    console.log(result.ok ? '预检通过（仅代表文件齐全一致，不代表 Host 已加载）' : '预检失败：请勿继续安装');
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? '')) {
  process.exitCode = main();
}

export { main, parseArgs };