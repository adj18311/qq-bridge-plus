// DSH 0.2.1 profile Team 片段（F.2）回归测试。
//
// 全部夹具自建在系统临时目录（%TEMP%）下，不读写真实 profile，也不碰仓库 state/。
// 覆盖：干净 profile 首次部署、重复部署零变化、用户条目不被移动、只缺一半时补齐、
// 版本读不到时跳过、片段文件缺失时报错、[] 根节点修复，以及版本门控本身。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';
import { readDshVersionFromAsar } from './dsh-asar.mjs';
import {
  FORCE_ENV,
  SKIP_ENV,
  TEAM_ENTRY_ID,
  FILTER_ENTRY_ID,
  deployTeamPatch,
  detectDshVersion,
  isDshAtLeast,
  mergeTeamPatch,
  parseDshVersion,
  planTeamPatchDeployment,
} from './dsh-021-team-patch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const FRAGMENT_TEXT = fs.readFileSync(
  path.join(ROOT, 'plugins', 'qq-agent-presets', 'compat', 'dsh-021-team.patch.yml'),
  'utf8',
);
// 测试里同样直接引用仓库片段文件，顺带验证它本身可解析、结构完整。
const FRAGMENT_FILE = path.join(ROOT, 'plugins', 'qq-agent-presets', 'compat', 'dsh-021-team.patch.yml');

function detected(version) {
  return { status: 'detected', version, parsed: parseDshVersion(version), source: 'test-fixture' };
}

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-021-profile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeAsar(file, sources) {
  const tree = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const [name, text] of Object.entries(sources)) {
    const names = name.split('/');
    let parent = tree;
    for (const part of names.slice(0, -1)) {
      parent.files[part] ??= { files: {} };
      parent = parent.files[part];
    }
    const buffer = Buffer.from(text);
    parent.files[names.at(-1)] = { size: buffer.length, offset: String(offset) };
    chunks.push(buffer);
    offset += buffer.length;
  }
  const header = Buffer.from(JSON.stringify(tree));
  const padding = (4 - (header.length % 4)) % 4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + header.length + padding, 4);
  prefix.writeUInt32LE(4 + header.length + padding, 8);
  prefix.writeUInt32LE(header.length, 12);
  fs.writeFileSync(file, Buffer.concat([prefix, header, Buffer.alloc(padding), ...chunks]));
}

function backupNames(patchFile) {
  return fs.readdirSync(path.dirname(patchFile))
    .filter((name) => name.startsWith(`${path.basename(patchFile)}.bak-`))
    .sort();
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

// ① 干净 profile 首次部署：追加两个操作、保留用户条目、生成时间戳备份。
test('clean profile: first deployment appends both operations and backs up the original', (t) => {
  const dir = sandbox(t);
  const patchFile = path.join(dir, 'cordis.patch.yml');
  const original = "# 用户自己的注释\n- id: my-custom\n  name: 'file:///C:/custom/index.mjs'\n";
  fs.writeFileSync(patchFile, original, 'utf8');
  const logs = [];
  const result = deployTeamPatch({
    patchFile,
    fragmentFile: FRAGMENT_FILE,
    versionInfo: detected('0.2.1-rc.2'),
    log: (message) => logs.push(message),
  });

  assert.equal(result.deployed, true);
  assert.equal(result.changed, true);
  assert.equal(result.written, true);
  assert.ok(result.backupFile, 'deployment must report the backup file');
  assert.equal(read(result.backupFile), original, 'backup must contain the untouched original');
  assert.equal(backupNames(patchFile).length, 1);

  const after = read(patchFile);
  assert.ok(after.startsWith(original), 'surgical append must keep every original byte and entry order');
  const doc = yaml.load(after);
  assert.equal(doc[0].id, 'my-custom');
  assert.equal(doc.filter((op) => op.id === TEAM_ENTRY_ID && op.disabled === true).length, 1);
  const filters = doc.flatMap((op) => op.insert ?? []).filter((entry) => entry.id === FILTER_ENTRY_ID);
  assert.equal(filters.length, 1);
  assert.equal(filters[0].config.freshProvider, 'spawn');
  assert.ok(logs.some((line) => line.includes('备份')), 'backup filename must be logged');
});

// ② 已部署再跑一次：字节零变化、不新增备份。
test('second deployment is byte-identical and creates no extra backup', (t) => {
  const dir = sandbox(t);
  const patchFile = path.join(dir, 'cordis.patch.yml');
  fs.writeFileSync(patchFile, "- id: keep\n  name: keep.mjs\n", 'utf8');
  const options = { patchFile, fragmentFile: FRAGMENT_FILE, versionInfo: detected('0.2.1-rc.2') };
  deployTeamPatch(options);
  const firstText = read(patchFile);
  const firstBackups = backupNames(patchFile);

  const again = deployTeamPatch(options);
  assert.equal(again.deployed, true);
  assert.equal(again.changed, false);
  assert.equal(again.written, false);
  assert.equal(again.backupFile, null);
  assert.equal(read(patchFile), firstText, 'rerun must not change a single byte');
  assert.deepEqual(backupNames(patchFile), firstBackups, 'rerun must not create another backup');
  assert.equal(yaml.load(firstText).filter((op) => op.id === TEAM_ENTRY_ID).length, 1);
});

// ③ 用户自定义条目在旁边时不被移动、不被重写（纯函数层字节前缀断言）。
test('user entries and comments next to the fragment stay untouched', () => {
  const original = [
    '# top comment',
    '- id: ui-chat',
    "  name: '@deepseek-ai/dsh-client-ui-chat'",
    '- id: my-plugin',
    '  disabled: true',
    '',
    '# bottom comment',
    '- insert:',
    '    - id: other-tool',
    '      name: file:///C:/other/index.mjs',
    '',
  ].join('\n');
  const merged = mergeTeamPatch(original, FRAGMENT_TEXT);
  assert.equal(merged.changed, true);
  assert.ok(merged.text.startsWith(original), 'merge must only append, never reorder or rewrite');
  assert.ok(merged.text.includes('# top comment') && merged.text.includes('# bottom comment'));
  const doc = yaml.load(merged.text);
  assert.deepEqual(
    doc.slice(0, 3).map((op) => op.id ?? op.insert[0].id),
    ['ui-chat', 'my-plugin', 'other-tool'],
  );
  assert.equal(doc[3].id, TEAM_ENTRY_ID);
  assert.equal(doc[4].insert[0].id, FILTER_ENTRY_ID);
});

// ④ 只有 tool-agent-team: disabled、没有 filter：只补 filter，不改写已有条目。
test('existing disabled entry without filter only gains the insert operation', () => {
  const original = '- id: tool-agent-team\n  disabled: true\n- id: other\n  name: other.mjs\n';
  const merged = mergeTeamPatch(original, FRAGMENT_TEXT);
  assert.ok(merged.text.startsWith(original));
  assert.equal(merged.diagnostics.addedDisable, false);
  assert.equal(merged.diagnostics.addedFilter, true);
  const doc = yaml.load(merged.text);
  assert.equal(doc.filter((op) => op.id === TEAM_ENTRY_ID).length, 1, 'existing disable must not be duplicated');
  assert.ok(merged.text.includes('- id: tool-agent-team\n  disabled: true\n- id: other\n  name: other.mjs'));
  const filters = doc.flatMap((op) => op.insert ?? []).filter((entry) => entry.id === FILTER_ENTRY_ID);
  assert.equal(filters.length, 1);
});

// ⑤ 只有 filter、没有 disable：只补 disable，filter 的现有 config 原样保留。
test('existing filter without disable keeps its config and only gains the disable operation', () => {
  const original = [
    '- insert:',
    `    - id: ${FILTER_ENTRY_ID}`,
    '      name: qq-agent-presets/qq-native-team-filter.mjs',
    '      config:',
    '        freshProvider: spawn',
    '        forkProvider: keep-me',
    '',
  ].join('\n');
  const merged = mergeTeamPatch(original, FRAGMENT_TEXT);
  assert.ok(merged.text.startsWith(original));
  assert.equal(merged.diagnostics.addedDisable, true);
  assert.equal(merged.diagnostics.addedFilter, false);
  assert.ok(merged.text.includes('forkProvider: keep-me'), 'existing filter config must not be rewritten');
  const doc = yaml.load(merged.text);
  const filters = doc.flatMap((op) => op.insert ?? []).filter((entry) => entry.id === FILTER_ENTRY_ID);
  assert.equal(filters.length, 1, 'existing filter must not be duplicated');
  assert.equal(filters[0].config.forkProvider, 'keep-me');
  assert.equal(doc.filter((op) => op.id === TEAM_ENTRY_ID && op.disabled === true).length, 1);
});

// ⑥ 版本读不到：跳过部署、文件不动、不产生备份，并给出明确原因。
test('unreadable DSH version skips deployment and leaves the profile untouched', (t) => {
  const dir = sandbox(t);
  const versionlessAsar = path.join(dir, 'no-version.asar');
  writeAsar(versionlessAsar, {
    'dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-desktop-runtime' }),
  });
  const versionInfo = detectDshVersion({ archive: versionlessAsar, env: {} });
  assert.equal(versionInfo.status, 'unavailable');
  assert.match(versionInfo.reason, /没有版本信息/);

  const patchFile = path.join(dir, 'cordis.patch.yml');
  const original = '- id: keep\n  name: keep.mjs\n';
  fs.writeFileSync(patchFile, original, 'utf8');
  const logs = [];
  const result = deployTeamPatch({
    patchFile,
    fragmentFile: FRAGMENT_FILE,
    versionInfo,
    log: (message) => logs.push(message),
  });
  assert.equal(result.deployed, false);
  assert.equal(result.changed, false);
  assert.match(result.plan.reason, /无法读取 DSH 版本/);
  assert.equal(read(patchFile), original);
  assert.deepEqual(backupNames(patchFile), []);
  assert.ok(logs.some((line) => line.includes('跳过')));

  // 归档文件本身不存在时同样只降级为「读不到」，不能猜。
  assert.equal(detectDshVersion({ archive: path.join(dir, 'missing.asar'), env: {} }).status, 'unavailable');
});

// ⑦ 片段文件缺失：明确报错，profile 与备份目录都保持原样。
test('missing fragment file fails loudly instead of quietly succeeding', (t) => {
  const dir = sandbox(t);
  const patchFile = path.join(dir, 'cordis.patch.yml');
  const original = '- id: keep\n  name: keep.mjs\n';
  fs.writeFileSync(patchFile, original, 'utf8');
  assert.throws(
    () => deployTeamPatch({
      patchFile,
      fragmentFile: path.join(dir, 'does-not-exist.patch.yml'),
      versionInfo: detected('0.2.1-rc.2'),
    }),
    /片段文件缺失|ENOENT/,
  );
  assert.equal(read(patchFile), original);
  assert.deepEqual(backupNames(patchFile), []);
});

// 版本门控：0.2.1+（含 rc 预发布）才部署；0.2.0 跳过；环境变量可强制/跳过。
test('version gate deploys only on 0.2.1+ and honours skip/force env', () => {
  assert.equal(isDshAtLeast(parseDshVersion('0.2.1-rc.2')), true, 'the deployed 0.2.1-rc.2 build must pass the gate');
  assert.equal(isDshAtLeast(parseDshVersion('0.2.1')), true);
  assert.equal(isDshAtLeast(parseDshVersion('0.3.0')), true);
  assert.equal(isDshAtLeast(parseDshVersion('0.2.0')), false);
  assert.equal(isDshAtLeast(parseDshVersion('1.0.0-rc.1')), true);
  assert.equal(parseDshVersion('0.2'), null);

  assert.equal(planTeamPatchDeployment({ versionInfo: detected('0.2.1-rc.2'), env: {} }).deploy, true);
  const old = planTeamPatchDeployment({ versionInfo: detected('0.2.0'), env: {} });
  assert.equal(old.deploy, false);
  assert.match(old.reason, /< 0\.2\.1/);
  assert.equal(planTeamPatchDeployment({ versionInfo: detected('0.2.0'), env: { [FORCE_ENV]: '1' } }).deploy, true);
  assert.equal(planTeamPatchDeployment({ versionInfo: detected('0.2.1'), env: { [SKIP_ENV]: '1' } }).deploy, false);
  assert.equal(planTeamPatchDeployment({
    versionInfo: { status: 'unavailable', reason: 'no asar' }, env: {},
  }).deploy, false);
});

// 版本读取直接走 ASAR 工具：dsh/package.json 优先，根 package.json 兜底。
test('DSH version is read from the installed ASAR', (t) => {
  const dir = sandbox(t);
  const asarPath = path.join(dir, 'app.asar');
  writeAsar(asarPath, {
    'dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-desktop-runtime', version: '0.2.1-rc.2' }),
    'package.json': JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '9.9.9' }),
  });
  assert.deepEqual(readDshVersionFromAsar(asarPath), { version: '0.2.1-rc.2', source: 'dsh/package.json' });
  const info = detectDshVersion({ archive: asarPath, env: {} });
  assert.equal(info.status, 'detected');
  assert.deepEqual(info.parsed, { major: 0, minor: 2, patch: 1, raw: '0.2.1-rc.2' });

  const rootOnly = path.join(dir, 'root-only.asar');
  writeAsar(rootOnly, { 'package.json': JSON.stringify({ version: '0.2.1' }) });
  assert.deepEqual(readDshVersionFromAsar(rootOnly), { version: '0.2.1', source: 'package.json' });
});

// 历史遗留的非法根 [] 先修复再追加，结果仍是合法 YAML。
test('legacy bare [] root is repaired before the fragment is appended', () => {
  const legacy = '# legacy\n[]\n- insert:\n    - id: mcp-old\n      name: old.mjs\n';
  const merged = mergeTeamPatch(legacy, FRAGMENT_TEXT);
  assert.equal(merged.changed, true);
  const doc = yaml.load(merged.text);
  assert.ok(Array.isArray(doc));
  assert.equal(doc[0].insert[0].id, 'mcp-old');
  assert.equal(doc.filter((op) => op.id === TEAM_ENTRY_ID).length, 1);
  assert.ok(!/^[ \t]*\[\][ \t]*$/m.test(merged.text));

  // 纯 [] 的空文档也要能追加（否则会出现「[] 后面接 - id」的非法 YAML）。
  const empty = mergeTeamPatch('[]\n', FRAGMENT_TEXT);
  assert.equal(yaml.load(empty.text).length, 2);
});

// CRLF profile：追加块跟随文件行尾，不制造混合行尾。
test('CRLF profile keeps CRLF line endings in the appended fragment', () => {
  const original = '- id: keep\r\n  name: keep.mjs\r\n';
  const merged = mergeTeamPatch(original, FRAGMENT_TEXT);
  assert.ok(merged.text.startsWith(original));
  const appended = merged.text.slice(original.length);
  assert.ok(appended.includes('\r\n- id: tool-agent-team\r\n'));
  assert.equal(appended.replace(/\r\n/g, '').includes('\n'), false, 'appended block must not contain bare LF');
});

// applied 提示：调用方已确认部署过时，纯函数必须零变化。
test('applied hint returns the input unchanged', () => {
  const original = '- id: keep\n  name: keep.mjs\n';
  const merged = mergeTeamPatch(original, FRAGMENT_TEXT, { applied: true });
  assert.equal(merged.changed, false);
  assert.equal(merged.text, original);
});
