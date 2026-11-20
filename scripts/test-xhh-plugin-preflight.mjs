import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleUrl = new URL('../plugins/xhh-quota-guard/install-preflight.mjs', import.meta.url);
const preflight = await import(moduleUrl);
const { XHH_PLUGIN_FILES, XHH_PREFLIGHT_MANIFEST_NAME, buildInstallManifest, preflightPluginInstall, serializeInstallManifest } = preflight;

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const PLUGIN_DIR = path.join(REPO_ROOT, 'plugins', 'xhh-quota-guard');
const SAFE_FETCH_SRC = path.join(REPO_ROOT, 'src', 'safe-fetch.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xhh-preflight-'));
}

function writeCandidate(dir, { overrides = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of XHH_PLUGIN_FILES) {
    const source = path.join(PLUGIN_DIR, name);
    const body = overrides[name] ?? fs.readFileSync(source);
    fs.writeFileSync(path.join(dir, name), body);
  }
  const { manifest } = buildInstallManifest({ dir, fs });
  fs.writeFileSync(path.join(dir, XHH_PREFLIGHT_MANIFEST_NAME), serializeInstallManifest(manifest), 'utf8');
  return manifest;
}

function codes(result) {
  return result.findings.map((item) => item.code);
}

test('清单成员必须覆盖 index.mjs 的全部静态相对 import（防新模块漏入分发集）', () => {
  const root = new URL('../plugins/xhh-quota-guard/', import.meta.url);
  const source = readFileSync(new URL('index.mjs', root), 'utf8');
  const imports = [...source.matchAll(/from '\.\/([^']+)'/gu)].map((m) => m[1]);
  assert.ok(imports.length > 0, 'index.mjs 应当有静态相对 import');
  for (const rel of imports) {
    assert.ok(XHH_PLUGIN_FILES.includes(rel), `静态 import 的 ${rel} 必须在 XHH_PLUGIN_FILES 中，否则缺文件时插件整体不加载`);
  }
});

test('预检-1：仓库真实插件目录通过（清单、五个模块、safe-fetch 与权威源一致）', () => {
  const result = preflightPluginInstall({
    candidateDir: PLUGIN_DIR,
    manifestPath: path.join(PLUGIN_DIR, XHH_PREFLIGHT_MANIFEST_NAME),
    authoritativeSafeFetchPath: SAFE_FETCH_SRC,
    fs,
  });
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.equal(result.summary.errors, 0);
  assert.equal(result.summary.checked, XHH_PLUGIN_FILES.length);
});

test('预检-2：缺文件 → missing-file，且不通过', () => {
  const dir = tempDir();
  writeCandidate(dir);
  fs.unlinkSync(path.join(dir, 'decision.mjs'));
  const result = preflightPluginInstall({ candidateDir: dir, fs });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('missing-file'), JSON.stringify(result.findings));
});

test('预检-3：内容被改（混版/损坏）→ hash-mismatch', () => {
  const dir = tempDir();
  writeCandidate(dir);
  fs.appendFileSync(path.join(dir, 'image-content.mjs'), '\n// tampered\n');
  const result = preflightPluginInstall({ candidateDir: dir, fs });
  assert.equal(result.ok, false);
  const finding = result.findings.find((item) => item.code === 'hash-mismatch');
  assert.ok(finding, JSON.stringify(result.findings));
  assert.equal(finding.file, 'image-content.mjs');
});

test('预检-4：空文件 → empty-file；读取失败 → unreadable-file；符号链接 → not-regular-file', () => {
  const emptyDir = tempDir();
  writeCandidate(emptyDir);
  fs.writeFileSync(path.join(emptyDir, 'safe-fetch.mjs'), '');
  assert.ok(codes(preflightPluginInstall({ candidateDir: emptyDir, fs })).includes('empty-file'));

  const dir = tempDir();
  writeCandidate(dir);
  const denied = {
    ...fs,
    readFileSync: (target, ...rest) => {
      if (String(target).endsWith('image-content.mjs')) {
        const error = new Error('access denied');
        error.code = 'EACCES';
        throw error;
      }
      return fs.readFileSync(target, ...rest);
    },
  };
  assert.ok(codes(preflightPluginInstall({ candidateDir: dir, fs: denied })).includes('unreadable-file'));

  const linked = {
    ...fs,
    lstatSync: (target) => (String(target).endsWith('index.mjs')
      ? { isSymbolicLink: () => true, isFile: () => false }
      : fs.lstatSync(target)),
  };
  assert.ok(codes(preflightPluginInstall({ candidateDir: dir, fs: linked })).includes('not-regular-file'));
});

test('预检-5：清单缺失/坏 JSON/版本不符/缺条目/多条目不通过', () => {
  const dir = tempDir();
  const manifest = writeCandidate(dir);
  const manifestPath = path.join(dir, XHH_PREFLIGHT_MANIFEST_NAME);

  fs.unlinkSync(manifestPath);
  assert.ok(codes(preflightPluginInstall({ candidateDir: dir, fs })).includes('manifest-missing'));

  fs.writeFileSync(manifestPath, '{not json', 'utf8');
  assert.ok(codes(preflightPluginInstall({ candidateDir: dir, fs })).includes('manifest-invalid'));

  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: 2 }), 'utf8');
  assert.ok(codes(preflightPluginInstall({ candidateDir: dir, fs })).includes('manifest-invalid'));

  const incomplete = { version: 1, files: { ...manifest.files } };
  delete incomplete.files['post-image-urls.mjs'];
  fs.writeFileSync(manifestPath, JSON.stringify(incomplete), 'utf8');
  assert.ok(codes(preflightPluginInstall({ candidateDir: dir, fs })).includes('manifest-incomplete'));

  const extra = { version: 1, files: { ...manifest.files, 'evil.mjs': { sha256: 'x', bytes: 1 } } };
  fs.writeFileSync(manifestPath, JSON.stringify(extra), 'utf8');
  assert.ok(codes(preflightPluginInstall({ candidateDir: dir, fs })).includes('manifest-unknown-entry'));
});

test('预检-6：候选 safe-fetch 与权威源不一致 → safe-fetch-mirror-mismatch', () => {
  const dir = tempDir();
  writeCandidate(dir);
  const drifted = Buffer.concat([fs.readFileSync(path.join(dir, 'safe-fetch.mjs')), Buffer.from('\n// drift\n')]);
  fs.writeFileSync(path.join(dir, 'safe-fetch.mjs'), drifted);
  const { manifest } = buildInstallManifest({ dir, fs });
  fs.writeFileSync(path.join(dir, XHH_PREFLIGHT_MANIFEST_NAME), serializeInstallManifest(manifest), 'utf8');
  const result = preflightPluginInstall({ candidateDir: dir, authoritativeSafeFetchPath: SAFE_FETCH_SRC, fs });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('safe-fetch-mirror-mismatch'), JSON.stringify(result.findings));
});

test('预检-7：与已安装目录比对 —— 缺文件 / 混版 / 多出模块（多出只告警）', () => {
  const candidateDir = tempDir();
  writeCandidate(candidateDir);

  const targetMissing = tempDir();
  writeCandidate(targetMissing);
  fs.unlinkSync(path.join(targetMissing, 'safe-fetch.mjs'));
  const missingResult = preflightPluginInstall({ candidateDir, targetDir: targetMissing, fs });
  assert.equal(missingResult.ok, false);
  assert.ok(codes(missingResult).includes('target-missing'));

  const targetMixed = tempDir();
  writeCandidate(targetMixed);
  fs.appendFileSync(path.join(targetMixed, 'decision.mjs'), '\n// older version\n');
  const mixedResult = preflightPluginInstall({ candidateDir, targetDir: targetMixed, fs });
  assert.equal(mixedResult.ok, false);
  assert.ok(codes(mixedResult).includes('target-mixed-version'));

  const targetExtra = tempDir();
  writeCandidate(targetExtra);
  fs.writeFileSync(path.join(targetExtra, 'legacy-helper.mjs'), 'export const x = 1;\n');
  const extraResult = preflightPluginInstall({ candidateDir, targetDir: targetExtra, fs });
  assert.equal(extraResult.ok, true, JSON.stringify(extraResult.findings));
  assert.ok(codes(extraResult).includes('target-extra-module'));
  assert.equal(extraResult.summary.warnings, 1);
});

test('预检-8：清单序列化稳定（可 diff），且不含时间戳', () => {
  const dir = tempDir();
  const manifest = writeCandidate(dir);
  const a = serializeInstallManifest(manifest);
  const b = serializeInstallManifest(manifest);
  assert.equal(a, b);
  assert.doesNotMatch(a, /timestamp|generatedAt|date/iu);
  assert.deepEqual(Object.keys(JSON.parse(a).files), [...XHH_PLUGIN_FILES].sort());
});

test('预检-9：CLI 退出码与 --json 输出', async () => {
  const cli = await import(new URL('../scripts/xhh-plugin-preflight.mjs', import.meta.url));
  assert.equal(cli.main(['--check', PLUGIN_DIR, '--safe-fetch-src', SAFE_FETCH_SRC]), 0);

  const broken = tempDir();
  writeCandidate(broken);
  fs.unlinkSync(path.join(broken, 'index.mjs'));
  const capture = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => capture.push(args.join(' '));
  console.error = (...args) => capture.push(args.join(' '));
  try {
    assert.equal(cli.main(['--check', broken, '--json']), 1);
    assert.equal(cli.main(['--help']), 0);
    assert.equal(cli.main(['--bogus']), 2);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.ok(capture.some((line) => line.includes('missing-file')), capture.join('\n'));
});

// ---- Codex 终审阻断项：清单条目严格校验 + 默认权威源 ----

function manifestWith(dir, mutate) {
  const manifestPath = path.join(dir, XHH_PREFLIGHT_MANIFEST_NAME);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  mutate(manifest.files);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  return manifestPath;
}

test('预检-10：清单条目为 {} ⇒ 明确报错且不通过（复现 Codex 用例）', () => {
  const dir = tempDir();
  const good = writeCandidate(dir);
  manifestWith(dir, (files) => { files['index.mjs'] = {}; });
  const result = preflightPluginInstall({ candidateDir: dir, fs });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('manifest-entry-sha-invalid'), JSON.stringify(result.findings));
  assert.ok(codes(result).includes('manifest-entry-bytes-invalid'), JSON.stringify(result.findings));
  fs.writeFileSync(path.join(dir, XHH_PREFLIGHT_MANIFEST_NAME), serializeInstallManifest(good), 'utf8');
  assert.equal(preflightPluginInstall({ candidateDir: dir, fs }).ok, true);
});

test('预检-11：sha256 类型/长度/字符集非法一律 fail-closed', () => {
  const badShas = [null, 0, 'x'.repeat(64), 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), ' a'.repeat(32)];
  for (const badSha of badShas) {
    const dir = tempDir();
    writeCandidate(dir);
    manifestWith(dir, (files) => { files['decision.mjs'].sha256 = badSha; });
    const result = preflightPluginInstall({ candidateDir: dir, fs });
    assert.equal(result.ok, false, 'sha=' + String(badSha));
    assert.ok(codes(result).includes('manifest-entry-sha-invalid'), 'sha=' + String(badSha));
  }
});

test('预检-12：bytes 非正整数或与实际不符 ⇒ 明确报错', () => {
  const badBytesList = [0, -1, 1.5, '12', null, undefined, Number.MAX_SAFE_INTEGER + 2];
  for (const badBytes of badBytesList) {
    const dir = tempDir();
    writeCandidate(dir);
    manifestWith(dir, (files) => { files['image-content.mjs'].bytes = badBytes; });
    const result = preflightPluginInstall({ candidateDir: dir, fs });
    assert.equal(result.ok, false, 'bytes=' + String(badBytes));
    assert.ok(codes(result).includes('manifest-entry-bytes-invalid'), 'bytes=' + String(badBytes));
  }

  const dir = tempDir();
  writeCandidate(dir);
  manifestWith(dir, (files) => { files['image-content.mjs'].bytes = 1; });
  const mismatch = preflightPluginInstall({ candidateDir: dir, fs });
  assert.equal(mismatch.ok, false);
  assert.ok(codes(mismatch).includes('size-mismatch'), JSON.stringify(mismatch.findings));
});

test('预检-13：条目多字段 / 非对象 ⇒ 明确报错', () => {
  const extra = tempDir();
  writeCandidate(extra);
  manifestWith(extra, (files) => { files['index.mjs'].note = 'x'; });
  const extraResult = preflightPluginInstall({ candidateDir: extra, fs });
  assert.equal(extraResult.ok, false);
  assert.ok(codes(extraResult).includes('manifest-entry-unknown-field'));

  const bads = [null, 'x', [], 5];
  for (const bad of bads) {
    const dir = tempDir();
    writeCandidate(dir);
    manifestWith(dir, (files) => { files['index.mjs'] = bad; });
    const result = preflightPluginInstall({ candidateDir: dir, fs });
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.ok(codes(result).includes('manifest-entry-invalid'), JSON.stringify(bad));
  }
});

test('预检-14：默认权威源按模块位置解析，与 cwd 无关；缺源/显式跳过均不通过', () => {
  const resolved = preflight.resolveDefaultSafeFetchSource();
  assert.equal(path.basename(resolved), 'safe-fetch.js');
  assert.equal(fs.statSync(resolved).isFile(), true);

  const dir = tempDir();
  writeCandidate(dir);
  assert.equal(preflightPluginInstall({ candidateDir: dir, fs }).ok, true);

  const missing = preflightPluginInstall({ candidateDir: dir, authoritativeSafeFetchPath: path.join(tempDir(), 'nope.js'), fs });
  assert.equal(missing.ok, false);
  assert.ok(codes(missing).includes('safe-fetch-source-missing'), JSON.stringify(missing.findings));

  const skipped = preflightPluginInstall({ candidateDir: dir, authoritativeSafeFetchPath: null, fs });
  assert.equal(skipped.ok, false);
  assert.ok(codes(skipped).includes('safe-fetch-mirror-check-skipped'));
});

test('预检-15：不同 cwd 下 CLI 仍用默认权威源，能发现镜像漂移', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = tempDir();
  writeCandidate(dir);
  const drifted = Buffer.concat([fs.readFileSync(path.join(dir, 'safe-fetch.mjs')), Buffer.from('\n// drift\n')]);
  fs.writeFileSync(path.join(dir, 'safe-fetch.mjs'), drifted);
  const { manifest } = buildInstallManifest({ dir, fs });
  fs.writeFileSync(path.join(dir, XHH_PREFLIGHT_MANIFEST_NAME), serializeInstallManifest(manifest), 'utf8');

  const cliPath = fileURLToPath(new URL('../scripts/xhh-plugin-preflight.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [cliPath, '--check', dir], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /safe-fetch-mirror-mismatch/u);
});

test('预检-16：CLI --no-mirror-check 必须失败（不得作为部署预检）', async () => {
  const cli = await import(new URL('../scripts/xhh-plugin-preflight.mjs', import.meta.url));
  const dir = tempDir();
  writeCandidate(dir);
  const capture = [];
  const originalLog = console.log;
  console.log = (...args) => capture.push(args.join(' '));
  try {
    assert.equal(cli.main(['--check', dir, '--no-mirror-check']), 1);
  } finally {
    console.log = originalLog;
  }
  assert.ok(capture.some((line) => line.includes('safe-fetch-mirror-check-skipped')), capture.join('\n'));
});

test('预检-17：CLI 参数错误一律 exit 2（缺值 / 冲突 / 自比较）', async () => {
  const cli = await import(new URL('../scripts/xhh-plugin-preflight.mjs', import.meta.url));
  const dir = tempDir();
  writeCandidate(dir);
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(cli.main(['--check', dir, '--safe-fetch-src']), 2, '缺值必须 exit 2');
    assert.equal(cli.main(['--check', dir, '--no-mirror-check', '--safe-fetch-src', SAFE_FETCH_SRC]), 2, '冲突必须 exit 2');
    assert.equal(cli.main(['--check', dir, '--safe-fetch-src', path.join(dir, 'safe-fetch.mjs')]), 2, '自比较必须 exit 2');
  } finally {
    console.error = originalError;
  }
});

test('预检-18：target 不可用（非缺文件)报 target-unusable，不冒充 target-missing', () => {
  const candidateDir = tempDir();
  writeCandidate(candidateDir);
  const targetDir = tempDir();
  writeCandidate(targetDir);
  fs.mkdirSync(path.join(targetDir, 'image-content.mjs.bak'));
  fs.rmSync(path.join(targetDir, 'image-content.mjs'));
  fs.mkdirSync(path.join(targetDir, 'image-content.mjs'));
  const result = preflightPluginInstall({ candidateDir, targetDir, fs });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('target-unusable'), JSON.stringify(result.findings));
  assert.ok(!codes(result).includes('target-missing'), '目录不能被冒充成缺文件');
});

test('预检-19：重新生成清单会掩盖漂移；冻结清单能抓住（部署前禁止 --write-manifest）', () => {
  const dir = tempDir();
  writeCandidate(dir);
  const manifestPath = path.join(dir, XHH_PREFLIGHT_MANIFEST_NAME);

  // 独立冻结：把经审查的清单复制到候选目录之外
  const frozenDir = tempDir();
  const frozenPath = path.join(frozenDir, XHH_PREFLIGHT_MANIFEST_NAME);
  fs.copyFileSync(manifestPath, frozenPath);

  assert.equal(preflightPluginInstall({ candidateDir: dir, manifestPath: frozenPath, fs }).ok, true, '冻结基线应通过');

  // 漂移：候选文件被改动（模拟意外变化 / 混版）
  fs.appendFileSync(path.join(dir, 'index.mjs'), '\n// drift\n');

  const withFrozen = preflightPluginInstall({ candidateDir: dir, manifestPath: frozenPath, fs });
  assert.equal(withFrozen.ok, false, '冻结清单必须报告漂移');
  assert.ok(codes(withFrozen).includes('hash-mismatch'), JSON.stringify(withFrozen.findings));

  // 危险动作：用当前文件重新生成清单
  const { manifest: regenerated } = buildInstallManifest({ dir, fs });
  fs.writeFileSync(manifestPath, serializeInstallManifest(regenerated), 'utf8');

  const withRegenerated = preflightPluginInstall({ candidateDir: dir, manifestPath, fs });
  assert.equal(withRegenerated.ok, true, '这正是掩盖漂移的路径（故部署流程禁止）');

  const withFrozenAgain = preflightPluginInstall({ candidateDir: dir, manifestPath: frozenPath, fs });
  assert.equal(withFrozenAgain.ok, false, '冻结清单不会因重新生成而放过漂移');
  assert.ok(codes(withFrozenAgain).includes('hash-mismatch'));
});
