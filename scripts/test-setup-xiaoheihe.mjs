// setup-xiaoheihe.mjs 专项测试：
//   · 在系统临时目录里建独立 DSH_HOME，**真实执行**安装脚本（不 mock）；
//   · 覆盖新建 / 已有 patch / 二次幂等 / 备份 / 原内容保留 / 错误 URL /
//     profile 穿越 / 同 id、serverName 冲突 / 标记区块损坏；
//   · 不连接真实小黑盒服务，不写正式 profile，不读取任何服务数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'setup-xiaoheihe.mjs');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-xhh-setup-'));
const PATCH_NAME = 'cordis.patch.yml';

let failures = 0;
let caseIndex = 0;
let runIndex = 0;

// 子进程输出用文件重定向而不是 pipe：
// 某些受限环境（如 DSH 沙箱）禁止子进程通过命名管道回传 stdio，
// 用普通文件句柄既避开该限制，也仍然是对安装脚本的「真实执行」。
function runScript(args, env) {
  const runDir = path.join(SANDBOX, '_runs');
  fs.mkdirSync(runDir, { recursive: true });
  runIndex += 1;
  const outFile = path.join(runDir, `${runIndex}.out.log`);
  const errFile = path.join(runDir, `${runIndex}.err.log`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [SCRIPT, ...args], {
      env,
      cwd: ROOT,
      timeout: 20000,
      stdio: ['ignore', outFd, errFd],
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  if (result.error) throw new Error(`无法执行安装脚本：${result.error.message}`);
  return {
    status: result.status,
    signal: result.signal,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

// 一段「用户自己的」patch：含自定义 loader 行、stdio MCP、flow 写法、注释。
// 安装器必须逐字节保留它，只追加/替换自己的标记区块。
const USER_PATCH = `# 用户自维护 patch，不能被安装器改写
- id: ui-chat
  name: '@deepseek-ai/dsh-client-ui-chat'
  config:
    transcriptView: standard
- insert:
    - id: 'mcp-other'
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: other
        transport: stdio
        command: node
        args:
          - other-server.js
- {insert: [{id: custom-flow, name: custom-plugin}]}
# 末尾注释：必须保留
`;

function readPatch(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function backupFiles(profileDir) {
  return fs.readdirSync(profileDir).filter((name) => name.startsWith(`${PATCH_NAME}.bak-`));
}

function backupContents(profileDir) {
  return backupFiles(profileDir).map((name) => fs.readFileSync(path.join(profileDir, name), 'utf8'));
}

/** 预置一批「历史备份」快照，用于验证安装器不会裁剪回滚点。 */
function seedOldBackups(profileDir, count = 7) {
  const seeds = [];
  for (let i = 0; i < count; i += 1) {
    const name = `${PATCH_NAME}.bak-2000-01-${String(i + 1).padStart(2, '0')}T00-00-00-000Z`;
    const content = `old-backup-${i}\n`;
    fs.writeFileSync(path.join(profileDir, name), content, 'utf8');
    seeds.push({ name, content });
  }
  return seeds;
}

function assertNoSecrets(text, label) {
  assert.ok(!/(cookie|authorization|bearer|password\s*=|token\s*=)/i.test(text), `${label} 输出疑似含凭据：${text}`);
}

/** 每个用例一个独立 DSH_HOME；默认带一个 desktop profile。 */
function fixture(label, { patch, patchExists = true } = {}) {
  caseIndex += 1;
  const home = path.join(SANDBOX, `${String(caseIndex).padStart(2, '0')}-${label}`, 'dsh-home');
  const profileDir = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(profileDir, { recursive: true });
  const patchFile = path.join(profileDir, PATCH_NAME);
  if (patchExists && patch !== undefined) fs.writeFileSync(patchFile, patch, 'utf8');
  const env = { ...process.env, DSH_HOME: home };
  delete env.XIAOHEIHE_MCP_URL;
  delete env.DSH_PROFILE;
  const run = (args = [], extraEnv = {}) => runScript(args, { ...env, ...extraEnv });
  return { home, profileDir, patchFile, run };
}

function parsedEntries(text) {
  const doc = yaml.load(text);
  assert.ok(Array.isArray(doc), 'patch 顶层必须是数组');
  return doc.flatMap((operation) => (Array.isArray(operation?.insert) ? operation.insert : [operation]));
}

function xiaoheiheEntries(text) {
  return parsedEntries(text).filter((entry) => entry && typeof entry === 'object'
    && (entry.id === 'mcp-xiaoheihe' || entry?.config?.serverName === 'xiaoheihe'));
}

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`❌ ${name}: ${error.message}`);
  }
}

// ── 0. 模块可 import + 纯函数契约 ────────────────────────────────────────────
const mod = await import(pathToFileURL(SCRIPT).href);

test('模块可 import，入口不自动执行 CLI，且导出纯函数', () => {
  for (const name of [
    'parseArgs', 'resolveDshHome', 'validateProfileName', 'profileDirFor',
    'normalizeLoopbackUrl', 'buildPatchBlock', 'findMarkedBlock', 'planInstall', 'run',
  ]) {
    assert.equal(typeof mod[name], 'function', `缺少导出 ${name}`);
  }
  assert.equal(mod.DEFAULT_PROFILE, 'desktop');
  assert.equal(mod.DEFAULT_URL, 'http://127.0.0.1:19489/');
  assert.equal(mod.MCP_ID, 'mcp-xiaoheihe');
  assert.equal(mod.MCP_PACKAGE, '@deepseek-ai/dsh-mcp-client');
  assert.equal(mod.MCP_SERVER_NAME, 'xiaoheihe');
  // 工具名由 namespace 固定推导：mcp__xiaoheihe__<原工具名>
  assert.equal(`mcp__${mod.MCP_SERVER_NAME}__check_login_status`, 'mcp__xiaoheihe__check_login_status');
  assert.ok(mod.TOOL_CALL_TIMEOUT_MS >= 300000, 'toolCallTimeoutMs 必须至少覆盖 300 秒登录窗口');
  assert.ok(mod.TOOL_CALL_TIMEOUT_MS >= mod.MIN_TOOL_CALL_TIMEOUT_MS);
});

test('URL 规范化：只收 http 回环根地址', () => {
  assert.equal(mod.normalizeLoopbackUrl('http://127.0.0.1:19489'), 'http://127.0.0.1:19489/');
  assert.equal(mod.normalizeLoopbackUrl(' http://localhost:19489/ '), 'http://localhost:19489/');
  for (const bad of [
    'http://example.com:19489/',
    'http://10.0.0.2:19489/',
    'http://0.0.0.0:19489/',
    'https://127.0.0.1:19489/',
    'http://user:pass@127.0.0.1:19489/',
    'http://127.0.0.1:19489/mcp',
    'http://127.0.0.1:19489/?x=1',
    'http://127.0.0.1:19489/#frag',
    '',
    'not-a-url',
  ]) {
    assert.throws(() => mod.normalizeLoopbackUrl(bad), undefined, `应拒绝 URL: ${bad}`);
  }
});

test('profile / DSH_HOME 边界：拒绝相对路径与路径穿越', () => {
  assert.equal(mod.validateProfileName('desktop'), 'desktop');
  for (const bad of ['..', '.', '../x', 'a/b', 'a\\b', 'node_modules', 'x ', 'x.']) {
    assert.throws(() => mod.validateProfileName(bad), undefined, `应拒绝 profile: ${bad}`);
  }
  assert.throws(() => mod.resolveDshHome('relative/home'));
  assert.equal(mod.resolveDshHome(path.join(SANDBOX, 'abs-home')), path.resolve(SANDBOX, 'abs-home'));
  const home = path.join(SANDBOX, 'path-check');
  assert.equal(mod.profileDirFor(home, 'desktop'), path.join(home, 'profiles', 'desktop'));
  assert.throws(() => mod.profileDirFor(home, '../escape'));
});

test('planInstall：新建 → 幂等 unchanged → URL 变化 update', () => {
  const created = mod.planInstall({ patchText: '', url: 'http://127.0.0.1:19489/' });
  assert.equal(created.status, 'create');
  const blockDoc = yaml.load(created.block);
  assert.ok(Array.isArray(blockDoc) && blockDoc.length === 1);
  const entry = blockDoc[0].insert[0];
  assert.equal(entry.id, 'mcp-xiaoheihe');
  assert.equal(entry.name, '@deepseek-ai/dsh-mcp-client');
  assert.equal(entry.config.serverName, 'xiaoheihe');
  assert.equal(entry.config.transport, 'streamable-http');
  assert.equal(entry.config.url, 'http://127.0.0.1:19489/');
  assert.ok(entry.config.toolCallTimeoutMs >= 300000);
  assert.equal(entry.config.failOnStartupError, false);

  const again = mod.planInstall({ patchText: created.text, url: 'http://127.0.0.1:19489/' });
  assert.equal(again.status, 'unchanged');
  assert.equal(again.text, created.text);

  const changed = mod.planInstall({ patchText: created.text, url: 'http://127.0.0.1:19600/' });
  assert.equal(changed.status, 'update');
  assert.ok(changed.text.includes("url: 'http://127.0.0.1:19600/'"));
});

// ── 0b. DSH 新 profile 模板的根 []（空列表字面量）──────────────────────────
const REAL_WEB_TEMPLATE = '# Your patch layer for this dsh profile, applied after every bundle layer:\n'
  + '# a top-level YAML array of loader patch entries (id-targeted config\n'
  + '# overrides, disables, and insert lists; `!!js` expressions allowed).\n'
  + '[]\n';

test('根 [] 修复：只移除空列表 token，保留注释/行尾注释/CRLF，不碰注释里的 []', () => {
  const cases = [
    ['模板', '# c1\n# c2\n[]\n', '# c1\n# c2\n'],
    ['行尾注释', '# c\n[] # empty root\n', '# c\n # empty root\n'],
    ['空白', '  [ ]  \n', ''],
    ['注释含 []', '# note []\n[]\n', '# note []\n'],
    ['CRLF', '# c\r\n[]\r\n', '# c\r\n'],
    ['旧式块列表', '[]\n- id: legacy\n  name: x\n', '- id: legacy\n  name: x\n'],
  ];
  for (const [label, input, expected] of cases) {
    const repaired = mod.repairEmptyRootSequence(input);
    assert.equal(repaired.repaired, true, label);
    assert.equal(repaired.text, expected, `${label} 修复结果不符`);
  }
  const untouched = '# c\n- id: a\n  name: a\n';
  assert.deepEqual(mod.repairEmptyRootSequence(untouched), { text: untouched, repaired: false });
  // 非空 flow 根数组：拒绝并解释，绝不悄悄重写
  for (const bad of ['[{id: demo, name: demo}]\n', '[1, 2]\n']) {
    assert.throws(() => mod.repairEmptyRootSequence(bad), /非空 flow/, bad);
  }
});

test('真实 web 模板（注释 + 根 [] + 末尾换行）：安装成功、注释保留、二次幂等', () => {
  const f = fixture('real-web-template', { patch: REAL_WEB_TEMPLATE });
  const first = f.run(['--apply']);
  assert.equal(first.status, 0, first.stderr);
  const text = readPatch(f.patchFile);
  for (const line of REAL_WEB_TEMPLATE.split('\n').filter((item) => item.startsWith('#'))) {
    assert.ok(text.includes(line), `模板注释丢失：${line}`);
  }
  assert.ok(!/^[ \t]*\[[ \t]*\][ \t]*(?:#.*)?$/m.test(text), '根 [] 必须被移除');
  assert.ok(Array.isArray(yaml.load(text)), '写入后必须是合法 YAML 数组');
  assert.equal(xiaoheiheEntries(text).length, 1);
  assert.match(first.stdout, /根 \[\]/);
  assert.ok(backupContents(f.profileDir).includes(REAL_WEB_TEMPLATE), '备份应保留模板原文');

  const second = f.run(['--apply']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readPatch(f.patchFile), text, '二次运行必须幂等');
  assert.match(second.stdout, /无需改动/);
});

test('带行尾注释的 [] 与空白 []：保留注释、二次幂等', () => {
  const cases = [
    ['行尾注释', '# header\n[] # 这是空列表的说明\n'],
    ['空白', '# header\n\n  [ ]  \n\n'],
  ];
  for (const [label, patch] of cases) {
    const f = fixture(`empty-root-${label}`, { patch });
    const first = f.run(['--apply']);
    assert.equal(first.status, 0, `${label}: ${first.stderr}`);
    const text = readPatch(f.patchFile);
    assert.ok(text.includes('# header'), `${label} 注释丢失`);
    assert.ok(!/^[ \t]*\[[ \t]*\]/m.test(text), `${label} 根 [] 未移除`);
    if (label === '行尾注释') assert.ok(text.includes('# 这是空列表的说明'), '行尾注释必须保留');
    assert.ok(Array.isArray(yaml.load(text)), `${label} 写入后必须是合法 YAML`);

    const second = f.run(['--apply']);
    assert.equal(second.status, 0, `${label}: ${second.stderr}`);
    assert.equal(readPatch(f.patchFile), text, `${label} 二次运行必须幂等`);
    assert.match(second.stdout, /无需改动/);
  }
});

test('CRLF 模板：注释换行风格保留，新区块跟随 CRLF 且二次幂等', () => {
  const f = fixture('crlf-template', { patch: '# c1\r\n# c2\r\n[]\r\n' });
  const first = f.run(['--apply']);
  assert.equal(first.status, 0, first.stderr);
  const text = readPatch(f.patchFile);
  assert.ok(text.startsWith('# c1\r\n# c2\r\n'), '原注释与 CRLF 换行必须保留');
  assert.ok(text.includes('# === xiaoheihe MCP BEGIN ===\r\n'), '新区块应跟随 CRLF');
  assert.ok(!/\r\n\[[ \t]*\]\r\n/.test(text), '根 [] 必须被移除');
  assert.ok(Array.isArray(yaml.load(text)));

  const second = f.run(['--apply']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readPatch(f.patchFile), text, '二次运行必须幂等');
  assert.match(second.stdout, /无需改动/);
});

test('非空 flow 根数组：拒绝并解释，不改文件', () => {
  const cases = [['对象数组', '[{id: demo, name: demo}]\n'], ['数字数组', '[1, 2]\n']];
  for (const [label, patch] of cases) {
    const f = fixture(`flow-root-${label}`, { patch });
    const result = f.run(['--apply']);
    assert.notEqual(result.status, 0, `${label} 应失败`);
    assert.match(result.stderr, /非空 flow/);
    assert.match(result.stderr, /手工/);
    assert.equal(readPatch(f.patchFile), patch, `${label} 不能改文件`);
    assert.equal(backupFiles(f.profileDir).length, 0, `${label} 不能产生备份`);
    assert.ok(!readPatch(f.patchFile).includes('xiaoheihe'), `${label} 不能写入区块`);
  }
});

// ── 1. 默认 dry-run 不写盘 ───────────────────────────────────────────────────
test('默认 dry-run：只打印计划，不写文件、不备份', () => {
  const f = fixture('dry-run', { patch: USER_PATCH });
  const before = readPatch(f.patchFile);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readPatch(f.patchFile), before, 'dry-run 不应改写 patch');
  assert.equal(backupFiles(f.profileDir).length, 0, 'dry-run 不应产生备份');
  assert.match(result.stdout, /DRY-RUN/);
  assert.match(result.stdout, /--apply/);
  assert.match(result.stdout, /追加标记区块/);
  assert.match(result.stdout, new RegExp(PATCH_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assertNoSecrets(result.stdout + result.stderr, 'dry-run');
});

// ── 2. 新建 patch 文件 ──────────────────────────────────────────────────────
test('apply：patch 不存在时新建，写入完整标记区块', () => {
  const f = fixture('create', { patchExists: false });
  const result = f.run(['--apply']);
  assert.equal(result.status, 0, result.stderr);
  const text = readPatch(f.patchFile);
  assert.ok(text, '应创建 cordis.patch.yml');
  assert.match(text, /^# === xiaoheihe MCP BEGIN ===$/m);
  assert.match(text, /^# === xiaoheihe MCP END ===$/m);
  assert.equal(backupFiles(f.profileDir).length, 0, '原文件不存在时无需备份');
  assert.match(result.stdout, /新建 patch 文件/);
  const entries = xiaoheiheEntries(text);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].config.serverName, 'xiaoheihe');
  assert.equal(entries[0].config.transport, 'streamable-http');
  assert.equal(entries[0].config.url, 'http://127.0.0.1:19489/');
  assert.ok(entries[0].config.toolCallTimeoutMs >= 300000);
  assert.equal(entries[0].config.failOnStartupError, false);
  assertNoSecrets(result.stdout + result.stderr, 'apply-create');
});

// ── 3. 已有 patch：原内容保留 + 备份 ────────────────────────────────────────
test('apply：已有 patch 逐字节保留原内容，并备份修改前文件', () => {
  const f = fixture('preserve', { patch: USER_PATCH });
  const result = f.run(['--apply']);
  assert.equal(result.status, 0, result.stderr);
  const text = readPatch(f.patchFile);
  assert.ok(text.startsWith(USER_PATCH), '区块外原有内容必须逐字节保留');
  assert.equal(xiaoheiheEntries(text).length, 1);

  // 原有条目仍在且未被改写
  const entries = parsedEntries(text);
  assert.equal(entries.find((entry) => entry.id === 'ui-chat').config.transcriptView, 'standard');
  assert.equal(entries.find((entry) => entry.id === 'mcp-other').config.serverName, 'other');
  assert.equal(entries.find((entry) => entry.id === 'custom-flow').name, 'custom-plugin');

  const backups = backupContents(f.profileDir);
  assert.ok(backups.includes(USER_PATCH), '备份必须包含修改前的完整原文');
  assertNoSecrets(result.stdout + result.stderr, 'apply-preserve');
});

// ── 4. 二次幂等：不重复注册、不产生新备份 ───────────────────────────────────
test('再次 apply：内容与备份数都不变（幂等）', () => {
  const f = fixture('idempotent', { patch: USER_PATCH });
  const first = f.run(['--apply']);
  assert.equal(first.status, 0, first.stderr);
  const textAfterFirst = readPatch(f.patchFile);
  const backupsAfterFirst = backupFiles(f.profileDir).length;
  assert.ok(backupsAfterFirst >= 1);

  const second = f.run(['--apply']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readPatch(f.patchFile), textAfterFirst, '二次运行不应改写文件');
  assert.equal(backupFiles(f.profileDir).length, backupsAfterFirst, '二次运行不应产生新备份');
  assert.equal(xiaoheiheEntries(readPatch(f.patchFile)).length, 1, '不允许重复注册');
  assert.match(second.stdout, /无需改动/);
});

// ── 5. 备份策略：不裁剪旧快照，失败时不写盘 ────────────────────────────────
test('apply 不裁剪历史备份（keep: Infinity，保留全部回滚点）', () => {
  const f = fixture('keep-backups', { patch: USER_PATCH });
  const seeds = seedOldBackups(f.profileDir, 7);
  const result = f.run(['--apply']);
  assert.equal(result.status, 0, result.stderr);
  const names = backupFiles(f.profileDir);
  assert.equal(names.length, seeds.length + 1, `旧备份必须全部保留（现有 ${names.length} 份，期望 ${seeds.length + 1} 份）`);
  for (const seed of seeds) {
    const file = path.join(f.profileDir, seed.name);
    assert.ok(fs.existsSync(file), `旧备份被裁掉：${seed.name}`);
    assert.equal(fs.readFileSync(file, 'utf8'), seed.content, `旧备份内容被改动：${seed.name}`);
  }
});

test('备份失败：中止写入，原 patch 与旧快照都不动', () => {
  const f = fixture('backup-fail', { patch: USER_PATCH });
  const seeds = seedOldBackups(f.profileDir, 7);
  const logs = [];
  const errors = [];
  // 注入「备份失败」：真实 backupBeforeOverwrite 失败时同样返回 null。
  const code = mod.run({
    argv: ['--apply'],
    env: { ...process.env, DSH_HOME: f.home },
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
    backup: () => null,
  });
  assert.equal(code, 1, '没有回滚点时必须返回失败');
  assert.equal(readPatch(f.patchFile), USER_PATCH, '不能在没有备份的情况下覆盖原 patch');
  assert.equal(backupFiles(f.profileDir).length, seeds.length, '不能产生新备份，也不能清理旧快照');
  for (const seed of seeds) {
    assert.equal(fs.readFileSync(path.join(f.profileDir, seed.name), 'utf8'), seed.content);
  }
  const output = `${logs.join('\n')}\n${errors.join('\n')}`;
  assert.match(output, /备份失败/);
  assert.match(output, /已中止写入/);
  assert.ok(!output.includes('已写入'), '备份失败后不能报告写入成功');
  assertNoSecrets(output, 'backup-fail');
});

// ── 6. URL 变化：替换区块并备份 ─────────────────────────────────────────────
test('apply --url：替换自己的区块，不碰区块外内容，并保留替换前备份', () => {
  const f = fixture('url-change', { patch: USER_PATCH });
  assert.equal(f.run(['--apply']).status, 0);
  const beforeChange = readPatch(f.patchFile);

  const result = f.run(['--apply', '--url', 'http://127.0.0.1:19600/']);
  assert.equal(result.status, 0, result.stderr);
  const text = readPatch(f.patchFile);
  assert.ok(text.startsWith(USER_PATCH), '区块外内容不能被改写');
  assert.ok(text.includes("url: 'http://127.0.0.1:19600/'"), '应写入新 URL');
  assert.ok(!text.includes('19489'), '旧 URL 应被整块替换');
  assert.equal(xiaoheiheEntries(text).length, 1);
  assert.ok(backupContents(f.profileDir).includes(beforeChange), '备份应包含替换前的完整文件');
});

// ── 7. 环境变量指定 URL ────────────────────────────────────────────────────
test('XIAOHEIHE_MCP_URL 生效（合法的 localhost 根地址）', () => {
  const f = fixture('env-url', { patch: USER_PATCH });
  const result = f.run(['--apply'], { XIAOHEIHE_MCP_URL: 'http://localhost:19489' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readPatch(f.patchFile).includes("url: 'http://localhost:19489/'"));
});

// ── 8. 错误 URL：拒绝且不改文件 ────────────────────────────────────────────
test('错误 URL：远程/内嵌凭据/https/非根路径/query 均拒绝，文件不变', () => {
  const cases = [
    ['远程地址', 'http://example.com:19489/'],
    ['内嵌凭据', 'http://user:secret@127.0.0.1:19489/'],
    ['https', 'https://127.0.0.1:19489/'],
    ['非根路径', 'http://127.0.0.1:19489/mcp'],
    ['非回环', 'http://10.0.0.2:19489/'],
    ['query', 'http://127.0.0.1:19489/?x=1'],
  ];
  for (const [label, url] of cases) {
    const f = fixture(`bad-url-${label}`, { patch: USER_PATCH });
    const result = f.run(['--apply', '--url', url]);
    assert.notEqual(result.status, 0, `${label} 应失败`);
    assert.equal(readPatch(f.patchFile), USER_PATCH, `${label} 不应改文件`);
    assert.equal(backupFiles(f.profileDir).length, 0, `${label} 不应产生备份`);
    const output = result.stdout + result.stderr;
    assertNoSecrets(output, label);
    assert.ok(!output.includes('secret'), `${label} 不应回显凭据`);
  }
  // 环境变量传入远程地址同样拒绝
  const f = fixture('bad-env-url', { patch: USER_PATCH });
  const result = f.run(['--apply'], { XIAOHEIHE_MCP_URL: 'http://example.com/' });
  assert.notEqual(result.status, 0);
  assert.equal(readPatch(f.patchFile), USER_PATCH);
});

// ── 9. profile 路径穿越 ─────────────────────────────────────────────────────
test('profile 穿越：../、..\\、..、node_modules 均拒绝，不落盘', () => {
  const f = fixture('traversal', { patch: USER_PATCH });
  for (const profile of ['../../escape', '..\\escape', '..', 'node_modules', 'a/b']) {
    const result = f.run(['--apply', '--profile', profile]);
    assert.notEqual(result.status, 0, `应拒绝 profile ${profile}`);
    assert.equal(readPatch(f.patchFile), USER_PATCH, `profile ${profile} 不应改文件`);
    assert.equal(backupFiles(f.profileDir).length, 0);
  }
  assert.ok(!fs.existsSync(path.join(f.home, 'escape')), '不能写出 profiles 目录');
  // 位置参数形式同样拒绝
  const positional = f.run(['../../escape', '--apply']);
  assert.notEqual(positional.status, 0);
  // 相对 DSH_HOME 拒绝
  const relativeHome = f.run(['--apply'], { DSH_HOME: 'relative-dsh-home' });
  assert.notEqual(relativeHome.status, 0);
});

// ── 10. 同 id / serverName 冲突 ────────────────────────────────────────────
test('冲突：区块外已有同 id 或同 serverName，拒绝重复注册且不改文件', () => {
  const byId = `- insert:\n    - id: mcp-xiaoheihe\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: xiaoheihe\n        transport: streamable-http\n        url: 'http://127.0.0.1:1/'\n`;
  const byServerName = `- id: some-other-row\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    serverName: xiaoheihe\n    transport: http\n    url: 'http://127.0.0.1:1/'\n`;
  for (const [label, patch] of [['id', byId], ['serverName', byServerName]]) {
    const f = fixture(`conflict-${label}`, { patch });
    const result = f.run(['--apply']);
    assert.notEqual(result.status, 0, `冲突(${label})应失败`);
    assert.match(result.stderr, /拒绝重复注册/);
    assert.equal(readPatch(f.patchFile), patch, '冲突时不能改文件');
    assert.equal(backupFiles(f.profileDir).length, 0);
    assertNoSecrets(result.stdout + result.stderr, `conflict-${label}`);
  }
});

// ── 11. 标记区块损坏 ──────────────────────────────────────────────────────
test('标记区块损坏/重复/被塞入额外条目：拒绝修改', () => {
  const block = mod.buildPatchBlock('http://127.0.0.1:19489/');
  const cases = {
    '缺 END': `${block.replace(`${mod.END_MARKER}\n`, '')}\n`,
    '有两个区块': `${block}${block}`,
    '区块被塞额外条目': block.replace(mod.END_MARKER, `- insert:\n    - id: rogue\n      name: rogue\n${mod.END_MARKER}`),
  };
  for (const [label, patch] of Object.entries(cases)) {
    const f = fixture(`broken-${label}`, { patch });
    const result = f.run(['--apply']);
    assert.notEqual(result.status, 0, `${label} 应失败`);
    assert.equal(readPatch(f.patchFile), patch, `${label} 不应改文件`);
    assert.equal(backupFiles(f.profileDir).length, 0);
  }
  // 损坏的标记也应被 dry-run 拒绝（fail-closed）
  const f = fixture('broken-dry', { patch: cases['缺 END'] });
  assert.notEqual(f.run().status, 0);
});

// ── 12. profile 目录不存在 ─────────────────────────────────────────────────
test('profile 目录不存在：报错且不创建目录/文件', () => {
  const home = path.join(SANDBOX, `${String(++caseIndex).padStart(2, '0')}-missing-profile`, 'dsh-home');
  const result = runScript(['--apply'], { ...process.env, DSH_HOME: home });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /profile 目录不存在/);
  assert.ok(!fs.existsSync(home), '不应创建 DSH_HOME 或 profile 目录');
});

// ── 13. 帮助与未知参数 ────────────────────────────────────────────────────
test('--help 退出码 0；未知参数退出码非 0', () => {
  const f = fixture('cli', { patch: USER_PATCH });
  const help = f.run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--apply/);
  assertNoSecrets(help.stdout, 'help');
  const unknown = f.run(['--nope']);
  assert.notEqual(unknown.status, 0);
  assert.equal(readPatch(f.patchFile), USER_PATCH);
});

// ── 14. reconnect 预算（有限窗口缓解，不承诺自愈）────────────────────────────
// 事实依据（DSH 的 @deepseek-ai/dsh-mcp-client/lib/index.js）：
//   RECONNECT_DEFAULTS = {enabled:true, initialDelayMs:500, maxDelayMs:30000, maxAttempts:10}
//   scheduleReconnect() 在 failedAttempts > maxAttempts 时注销全部工具并打印
//   "giving up ... tools unregistered; reload the plugin or restart the Host"
//   ⇒ 默认一次故障只有约 151.5s 窗口；本机 DSH 常先于小黑盒服务启动。
// 因此安装器写入更大的**有限**预算：够覆盖开机竞争，仍然会停，不是「保证自愈」。
const DSH_RECONNECT_KEYS = ['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts'];

test('reconnect：生成区块带有限重连预算，键集合与 DSH 白名单完全一致', () => {
  assert.equal(typeof mod.validateReconnectPolicy, 'function', '缺少导出 validateReconnectPolicy');
  assert.ok(mod.RECONNECT_POLICY && typeof mod.RECONNECT_POLICY === 'object', '缺少导出 RECONNECT_POLICY');
  const doc = yaml.load(mod.buildPatchBlock('http://127.0.0.1:19489/'));
  const config = doc[0].insert[0].config;
  assert.ok(config.reconnect && typeof config.reconnect === 'object', '必须生成 reconnect 配置');
  assert.deepEqual(Object.keys(config.reconnect), DSH_RECONNECT_KEYS,
    '键集合必须与 DSH resolveReconnectPolicy 白名单一致（多余键会让插件加载失败）');
  assert.equal(config.reconnect.enabled, true);
  assert.equal(config.reconnect.initialDelayMs, mod.RECONNECT_POLICY.initialDelayMs);
  assert.equal(config.reconnect.maxDelayMs, mod.RECONNECT_POLICY.maxDelayMs);
  assert.equal(config.reconnect.maxAttempts, mod.RECONNECT_POLICY.maxAttempts);
  assert.equal(config.reconnect.maxAttempts, 240);
  assert.ok(Number.isInteger(config.reconnect.maxAttempts), 'maxAttempts 必须是整数（DSH schema 为 step(1)）');
  assert.ok(config.reconnect.initialDelayMs <= config.reconnect.maxDelayMs);
  assert.equal(config.failOnStartupError, false, '不得把启动失败改成致命');
  // 墙钟口径：按 DSH 的退避公式累加，确认窗口足够覆盖开机竞争（有限，不承诺成功）
  let totalMs = 0;
  for (let attempt = 1; attempt <= config.reconnect.maxAttempts; attempt += 1) {
    totalMs += Math.min(config.reconnect.maxDelayMs, config.reconnect.initialDelayMs * 2 ** (attempt - 1));
  }
  assert.equal(totalMs, 7051500, `重试窗口应为 7 051 500ms（实测 ${totalMs}ms）`);
  assert.equal(totalMs / 60000, 117.525, '文档口径 117.5 分钟');
});

test('validateReconnectPolicy：未知键/非整数/越界/低于底线一律拒绝（fail-closed）', () => {
  const ok = { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 240 };
  assert.deepEqual(mod.validateReconnectPolicy(ok), ok);
  assert.doesNotThrow(() => mod.validateReconnectPolicy());
  const bad = [
    ['未知键', { ...ok, retryForever: true }],
    ['enabled 非布尔', { ...ok, enabled: 'yes' }],
    ['maxAttempts 非整数', { ...ok, maxAttempts: 1.5 }],
    ['maxAttempts 为 0', { ...ok, maxAttempts: 0 }],
    ['maxAttempts 低于底线', { ...ok, maxAttempts: 5 }],
    ['initialDelayMs 为 0', { ...ok, initialDelayMs: 0 }],
    ['maxDelayMs 为 0', { ...ok, maxDelayMs: 0 }],
    ['initialDelayMs > maxDelayMs', { ...ok, initialDelayMs: 60000 }],
    ['非对象', 'not-an-object'],
    ['null', null],
  ];
  for (const [label, policy] of bad) {
    assert.throws(() => mod.validateReconnectPolicy(policy), undefined, `应拒绝：${label}`);
    assert.throws(() => mod.buildPatchBlock('http://127.0.0.1:19489/', '\n', policy),
      undefined, `${label}：buildPatchBlock 必须 fail-closed`);
  }
});

test('apply：首次生成即带 reconnect；旧区块（无 reconnect）升级为 update 且幂等', () => {
  const created = fixture('reconnect-create', { patchExists: false });
  assert.equal(created.run(['--apply']).status, 0);
  const firstText = readPatch(created.patchFile);
  assert.equal(xiaoheiheEntries(firstText)[0].config.reconnect.maxAttempts, 240);
  const second = created.run(['--apply']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readPatch(created.patchFile), firstText, '重复运行必须幂等');

  // 升级前生成的历史区块（没有 reconnect）：必须被整块替换，区块外逐字节保留
  const legacyBlock = [
    mod.BEGIN_MARKER,
    '# 由 scripts/setup-xiaoheihe.mjs 维护；整块会被整体替换，请勿手工编辑内部条目。',
    '- insert:',
    `    - id: ${mod.MCP_ID}`,
    `      name: '${mod.MCP_PACKAGE}'`,
    '      config:',
    `        serverName: ${mod.MCP_SERVER_NAME}`,
    '        transport: streamable-http',
    "        url: 'http://127.0.0.1:19489/'",
    `        toolCallTimeoutMs: ${mod.TOOL_CALL_TIMEOUT_MS}`,
    '        failOnStartupError: false',
    mod.END_MARKER,
    '',
  ].join('\n');
  const legacyPatch = USER_PATCH + legacyBlock;
  const plan = mod.planInstall({ patchText: legacyPatch });
  assert.equal(plan.status, 'update', '旧区块必须被判为 update（补齐 reconnect）');
  const f = fixture('reconnect-upgrade', { patch: legacyPatch });
  const applied = f.run(['--apply']);
  assert.equal(applied.status, 0, applied.stderr);
  const text = readPatch(f.patchFile);
  assert.ok(text.startsWith(USER_PATCH), '区块外内容必须逐字节保留');
  const entry = xiaoheiheEntries(text)[0];
  assert.equal(entry.config.reconnect.maxAttempts, 240);
  assert.equal(entry.config.failOnStartupError, false);
  assert.equal(xiaoheiheEntries(text).length, 1, '不允许重复注册');
  assert.ok(backupContents(f.profileDir).includes(legacyPatch), '升级前必须留备份');
  const again = f.run(['--apply']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readPatch(f.patchFile), text, '升级后二次运行必须幂等');
  assert.match(again.stdout, /无需改动/);
});

// ── 收尾 ───────────────────────────────────────────────────────────────────
fs.rmSync(SANDBOX, { recursive: true, force: true });
if (failures === 0) {
  console.log('\n✅ setup-xiaoheihe.mjs 专项测试全部通过');
  process.exit(0);
} else {
  console.error(`\n❌ ${failures} 个用例失败`);
  process.exit(1);
}
