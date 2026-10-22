// 人格仓库（src/core/role-store.mjs）的离线单测。
//
// 只使用系统临时目录里的假人格库；不读取生产 roles/state，不启动生产桥接。
// 重点覆盖：目录边界、保留名规则、64 KiB 多字节上限、末尾换行、运行期注入上限
// 的动态读取，以及摘要字段/模式警告与桥接原行为一致。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ROLE_CONTENT_MAX_BYTES,
  ROLE_INJECT_MAX_CHARS_DEFAULT,
  ROLE_NAME_MAX,
  createRoleStore,
  sanitizeRoleName,
} from '../src/core/role-store.mjs';
import { roleCharStats } from '../src/role-card.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('bridge role endpoints use the extracted store and observe hot-updated limits', async () => {
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (endpoint, body) => {
      const response = await fetch(base + endpoint, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, value: await response.json() };
    };
    const content = '# Fixture\n\n' + '字'.repeat(1500);
    assert.equal((await request('/api/roles/create', { name: 'fixture', content })).status, 200);
    let listing = await request('/api/roles');
    assert.deepEqual(listing.value.roles, ['fixture']);
    assert.equal(listing.value.summaries[0].truncated, false);
    assert.equal((await request('/api/roles/limit', { maxInjectChars: 1000 })).status, 200);
    listing = await request('/api/roles');
    assert.equal(listing.value.limits.injectMaxChars, 1000);
    assert.equal(listing.value.summaries[0].injectedV2, 1000);
    assert.equal(listing.value.summaries[0].truncated, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8')).role.maxInjectChars, 1000);
    const loaded = await request('/api/roles/content?name=fixture');
    assert.equal(loaded.status, 200);
    assert.equal(loaded.value.content, content + '\n');
    assert.ok(loaded.value.warnings.some(warning => warning.includes('1000')));
    assert.ok(loaded.value.sections.v2.length > 0);
    assert.equal((await request('/api/role', { role: 'fixture' })).status, 200);
    assert.equal((await request('/api/roles/update', { name: 'fixture', content: '# Updated' })).status, 200);
    const renamed = await request('/api/roles/rename', { from: 'fixture', to: 'renamed' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.value.currentFollowed, true);
    assert.equal((await request('/api/roles/content?name=renamed')).value.content, '# Updated\n');
    const deleted = await request('/api/roles/delete', { name: 'renamed' });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.value.clearedCurrent, true);
    assert.deepEqual((await request('/api/roles')).value.roles, []);
    assert.equal((await request('/api/roles/create', { name: 'CON', content: '# Device' })).status, 400);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await h.close();
  }
});

/** 每个用例一个系统临时目录，finally 里整棵删掉。 */
function withTempRoles(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-role-store-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('工厂创建不读写目录，缺失目录被当作空人格库', () => withTempRoles((root) => {
  const rolesDir = path.join(root, 'roles-not-created');
  const store = createRoleStore({ rolesDir, getInjectLimit: () => ROLE_INJECT_MAX_CHARS_DEFAULT });
  assert.equal(fs.existsSync(rolesDir), false, '工厂创建不得创建目录');
  assert.deepEqual(store.listRoles(), []);
  assert.equal(fs.existsSync(rolesDir), false, '只读列表也不得创建目录');
}));

test('listRoles 只列 .md、排除 README.md，并按 zh-CN 排序', () => withTempRoles((root) => {
  const rolesDir = path.join(root, 'roles');
  fs.mkdirSync(rolesDir);
  for (const file of ['b.md', 'a.md', 'c.md', 'README.md', 'notes.txt', 'draft.md.bak']) {
    fs.writeFileSync(path.join(rolesDir, file), `# ${file}\n`, 'utf8');
  }
  const store = createRoleStore({ rolesDir });
  assert.deepEqual(store.listRoles(), ['a', 'b', 'c']);
}));

test('roleFilePath 固定在人格目录下，读写走同一路径', () => withTempRoles((root) => {
  const rolesDir = path.join(root, 'roles');
  const store = createRoleStore({ rolesDir });
  const file = path.join(rolesDir, '小鲸鱼.md');
  assert.equal(store.roleFilePath('小鲸鱼'), file);
  store.writeRoleContent('小鲸鱼', '# 小鲸鱼');
  assert.equal(fs.existsSync(file), true);
  assert.equal(store.readRoleContent('小鲸鱼'), '# 小鲸鱼\n');
}));

test('validateRoleName 先净化再套用原有保留名/Windows 设备名规则', () => withTempRoles((root) => {
  const store = createRoleStore({ rolesDir: path.join(root, 'roles') });
  // 净化：空白、标点、路径分隔符都不进文件名。
  assert.equal(store.validateRoleName('  傲娇 助手!! '), '傲娇助手');
  assert.equal(store.validateRoleName('../evil'), 'evil');
  assert.equal(store.validateRoleName('a_b-1'), 'a_b-1');
  assert.equal(sanitizeRoleName('a/b\\c.d e'), 'abcde');
  // 净化后为空 → 拒绝。
  assert.throws(() => store.validateRoleName('!!!'), /人格名不能为空/);
  // 长度按净化后的字符数计算。
  assert.equal(store.validateRoleName('a'.repeat(ROLE_NAME_MAX)), 'a'.repeat(ROLE_NAME_MAX));
  assert.throws(() => store.validateRoleName('a'.repeat(ROLE_NAME_MAX + 1)), /人格名过长/);
  // README 保留名大小写敏感（与历史行为一致）。
  assert.throws(() => store.validateRoleName('README'), /「README」是保留名称/);
  assert.equal(store.validateRoleName('readme'), 'readme');
  // Windows 设备名不区分大小写；COM10/LPT10 不在保留集合里。
  for (const reserved of ['CON', 'con', 'Prn', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9']) {
    assert.throws(() => store.validateRoleName(reserved), /系统保留名称（Windows 设备名）/);
  }
  assert.equal(store.validateRoleName('COM10'), 'COM10');
  assert.equal(store.validateRoleName('LPT10'), 'LPT10');
}));

test('validateRoleContent 统一换行、裁剪，并在 64 KiB 字节上限拒绝多字节内容', () => withTempRoles((root) => {
  const store = createRoleStore({ rolesDir: path.join(root, 'roles') });
  assert.equal(store.validateRoleContent('  # 人格卡\r\n\r\n第一行  \r\n'), '# 人格卡\n\n第一行');
  assert.throws(() => store.validateRoleContent(' \r\n\t '), /人格内容不能为空/);

  // 21845 个「中」= 65535 字节，再加 1 个 ASCII 正好 65536 字节（边界内）。
  const atLimit = '中'.repeat(21845) + 'a';
  assert.equal(Buffer.byteLength(atLimit, 'utf8'), ROLE_CONTENT_MAX_BYTES);
  assert.equal(store.validateRoleContent(atLimit), atLimit);

  // 再加一个多字节字符 → 65538 字节，按字节而不是字符数拒绝。
  const overLimit = atLimit + '中';
  assert.throws(
    () => store.validateRoleContent(overLimit),
    { message: '人格内容过长（64.0 KB，上限 64 KB）' }
  );
}));

test('writeRoleContent 只在缺失时补一个末尾换行，readRoleContent 原样读回', () => withTempRoles((root) => {
  const rolesDir = path.join(root, 'nested', 'roles');
  const store = createRoleStore({ rolesDir });
  store.writeRoleContent('补换行', '# 小鲸鱼\n\n你好');
  assert.equal(store.readRoleContent('补换行'), '# 小鲸鱼\n\n你好\n');

  store.writeRoleContent('已有换行', '内容\n');
  assert.equal(store.readRoleContent('已有换行'), '内容\n');

  // 原有多个末尾换行不折叠（历史行为）。
  store.writeRoleContent('保留多换行', '内容\n\n');
  assert.equal(store.readRoleContent('保留多换行'), '内容\n\n');

  assert.deepEqual(store.listRoles(), ['保留多换行', '已有换行', '补换行'].sort((a, b) => a.localeCompare(b, 'zh-CN')));
  assert.deepEqual(
    fs.readdirSync(rolesDir).filter((file) => file.endsWith('.tmp')),
    [],
    '原子写失败/成功都不应留下临时文件'
  );
  assert.throws(() => store.readRoleContent('不存在'), /ENOENT/);
}));

test('roleWarnings / roleSummaries 每次经 getInjectLimit 读取上限，不缓存工厂时的值', () => withTempRoles((root) => {
  const rolesDir = path.join(root, 'roles');
  let limit = 3;
  let calls = 0;
  const store = createRoleStore({
    rolesDir,
    getInjectLimit: () => {
      calls += 1;
      return limit;
    },
  });
  assert.equal(calls, 0, '工厂创建时不得读取注入上限');

  const content = '# 长卡\n\n' + '字'.repeat(20);
  store.writeRoleContent('长卡', content);
  const stats = roleCharStats(content);
  assert.ok(stats.v2 > limit);

  const limited = store.roleSummaries()[0];
  assert.equal(limited.injectedV1, Math.min(stats.v1, 3));
  assert.equal(limited.injectedV2, 3);
  assert.equal(limited.truncated, true);
  assert.equal(limited.warnings, 1);
  const limitedWarnings = store.roleWarnings(content);
  assert.equal(limitedWarnings.length, 1);
  assert.match(limitedWarnings[0], /只有前 3 字符/);

  // 运行期上限提高后，同一 store 立即返回新结果。
  limit = 10000;
  const full = store.roleSummaries()[0];
  assert.equal(full.injectedV1, stats.v1);
  assert.equal(full.injectedV2, stats.v2);
  assert.equal(full.truncated, false);
  assert.deepEqual(store.roleWarnings(content), []);
  assert.ok(calls >= 4, '每次摘要/警告都应重新读取 getter');
}));

test('roleSummaries 保留原有字段与值，异常项返回完全一致的零值字段', () => withTempRoles((root) => {
  const rolesDir = path.join(root, 'roles');
  const store = createRoleStore({ rolesDir, getInjectLimit: () => ROLE_INJECT_MAX_CHARS_DEFAULT });
  const content = [
    '# 通用',
    '',
    '你好',
    '',
    '## 一代 〔一代〕',
    '',
    '[SILENT] 空格分隔',
    '',
    '## 二代 〔二代〕',
    '',
    '工具发言',
    '',
  ].join('\n');
  store.writeRoleContent('带模式', content);
  const file = store.roleFilePath('带模式');
  const stat = fs.statSync(file);
  const stats = roleCharStats(content);

  const summary = store.roleSummaries().find((item) => item.name === '带模式');
  assert.deepEqual(Object.keys(summary), [
    'name', 'bytes', 'chars', 'lines', 'mtime', 'excerpt',
    'injectedV1', 'injectedV2', 'charsV1', 'charsV2',
    'hasModeTags', 'truncated', 'warnings',
  ]);
  assert.equal(summary.name, '带模式');
  assert.equal(summary.bytes, stat.size);
  assert.equal(summary.chars, content.length);
  assert.equal(summary.lines, content.split('\n').length);
  assert.equal(summary.mtime, stat.mtimeMs);
  assert.equal(summary.excerpt, '通用');
  assert.equal(summary.injectedV1, Math.min(stats.v1, ROLE_INJECT_MAX_CHARS_DEFAULT));
  assert.equal(summary.injectedV2, Math.min(stats.v2, ROLE_INJECT_MAX_CHARS_DEFAULT));
  assert.equal(summary.charsV1, stats.v1);
  assert.equal(summary.charsV2, stats.v2);
  assert.equal(summary.hasModeTags, true);
  assert.equal(summary.truncated, false);
  assert.equal(summary.warnings, 0);
  assert.deepEqual(store.roleWarnings(content), [], '已标记的一代指令不应在二代误报');

  // 目录被误命名为 .md 时，stat/read 失败走 catch 分支：字段必须与原来完全一致。
  fs.mkdirSync(path.join(rolesDir, '坏卡.md'));
  const broken = store.roleSummaries().find((item) => item.name === '坏卡');
  assert.deepEqual(broken, {
    name: '坏卡',
    bytes: 0,
    chars: 0,
    lines: 0,
    mtime: 0,
    excerpt: '',
    injectedV1: 0,
    injectedV2: 0,
    charsV1: 0,
    charsV2: 0,
    hasModeTags: false,
    truncated: false,
    warnings: 0,
  });
}));

test('roleWarnings 默认按二代统计，并保留原有中文提示', () => withTempRoles((root) => {
  const rolesDir = path.join(root, 'roles');
  const tagged = [
    '# 通用',
    '',
    '公共内容',
    '',
    '## 分条方式 〔一代〕',
    '',
    '[SILENT] 空格分隔',
    '',
    '## 发言方式 〔二代〕',
    '',
    '工具发言',
  ].join('\n');
  const stats = roleCharStats(tagged);
  assert.ok(stats.v1 > stats.v2, '用例需要一代内容长于二代');

  // 上限正好等于二代实际注入量：默认（v2）不告警，显式 v1 才告警。
  const store = createRoleStore({ rolesDir, getInjectLimit: () => stats.v2 });
  assert.deepEqual(store.roleWarnings(tagged), []);
  assert.deepEqual(store.roleWarnings(tagged, 'v1'), [
    `超出注入上限：当前模式实际注入 ${stats.v1} 字符，只有前 ${stats.v2} 字符会进入提示词（可在配置里调 role.maxInjectChars）`,
  ]);

  // 未标记小节里的一代指令要被提示；标记过的一代小节不算误报。
  const fixedStore = createRoleStore({ rolesDir, getInjectLimit: () => ROLE_INJECT_MAX_CHARS_DEFAULT });
  assert.deepEqual(fixedStore.roleWarnings('# 通用\n\n[SILENT] 空格分隔'), [
    '未标记的小节里含一代仿真专用指令（[SILENT] / 空格分句 / 自动转发…），二代下这些行会被兜底过滤——建议把它们移到带 〔一代〕 标记的小节里',
  ]);
  assert.deepEqual(fixedStore.roleWarnings('# 通用\n\n## 分条方式 〔一代〕\n\n[SILENT]'), []);

  // “回复示例”里的中文空格提示只针对未标记小节。
  assert.deepEqual(fixedStore.roleWarnings('# 通用\n\n## 回复示例\n\n你 好'), [
    '“回复示例”节里的中文空格会被自动改写成逗号（二代不用空格分条），建议直接写逗号，或把该节标记为 〔一代〕',
  ]);
  assert.deepEqual(fixedStore.roleWarnings('# 通用\n\n## 回复示例 〔一代〕\n\n你 好'), []);
}));

test('未注入 getInjectLimit 时默认上限为 6000 字符', () => withTempRoles((root) => {
  const rolesDir = path.join(root, 'roles');
  const store = createRoleStore({ rolesDir });
  const content = '# 大卡\n\n' + '字'.repeat(6001);
  store.writeRoleContent('大卡', content);
  assert.equal(ROLE_INJECT_MAX_CHARS_DEFAULT, 6000);

  const stats = roleCharStats(content);
  const summary = store.roleSummaries()[0];
  assert.equal(summary.injectedV1, Math.min(stats.v1, 6000));
  assert.equal(summary.injectedV2, 6000);
  assert.equal(summary.truncated, true);
  assert.equal(summary.warnings, 1);
  assert.deepEqual(store.roleWarnings(content), [
    `超出注入上限：当前模式实际注入 ${stats.v2} 字符，只有前 6000 字符会进入提示词（可在配置里调 role.maxInjectChars）`,
  ]);
}));
