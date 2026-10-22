// dsh-cli.mjs 回归测试：解析顺序（DSH_CLI → 安装目录 → PATH → none）、
// 无效候选的优雅降级、绝对路径执行、执行失败/超时的告警文案。
// 解析函数的依赖全部注入，不读真实 process.env，也不碰真实文件系统；
// 只有最后一条「默认探测」用例写 os.tmpdir() 下的临时文件。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildDshPluginInstallCommand,
  createPathInspector,
  createPathLookup,
  dshCliNames,
  formatDshPluginInstallReport,
  resolveDshCli,
  runDshPluginInstall,
} from './dsh-cli.mjs';

const HOST = process.platform;
const NAMES = dshCliNames(HOST);
const SANDBOX = path.join(os.tmpdir(), 'qq-bridge-dsh-cli-resolve');

/** 只用一组「路径 → 探测结果」冒充文件系统；解析器必须只通过注入依赖观察世界。 */
function inspectorFor(entries) {
  return (candidate) => entries.get(candidate) ?? { isFile: false, executable: false };
}

function cliCandidate(...parts) {
  return path.join(SANDBOX, ...parts);
}

test('DSH_CLI 优先于安装目录与 PATH', () => {
  const envCli = cliCandidate('env-bin', NAMES[0]);
  const asarCli = cliCandidate('install-root', 'resources', 'runtime', 'cli', 'bin', NAMES[0]);
  const pathCli = cliCandidate('path-bin', NAMES[0]);
  const inspectPath = inspectorFor(new Map([
    [envCli, { isFile: true, executable: true }],
    [asarCli, { isFile: true, executable: true }],
    [pathCli, { isFile: true, executable: true }],
  ]));
  const resolved = resolveDshCli({
    env: { DSH_CLI: envCli },
    asarPath: cliCandidate('install-root', 'resources', 'app.asar'),
    pathLookup: () => pathCli,
    inspectPath,
    platform: HOST,
  });
  assert.equal(resolved.kind, 'env');
  assert.equal(resolved.path, envCli);
  assert.match(resolved.reason, /DSH_CLI/);
});

test('未设置 DSH_CLI 时从安装包位置推导 <root>/resources/runtime/cli/bin', () => {
  const installRoot = cliCandidate('install-root');
  const asarPath = path.join(installRoot, 'resources', 'app.asar');
  const expected = path.join(installRoot, 'resources', 'runtime', 'cli', 'bin', NAMES[0]);
  const pathCli = cliCandidate('path-bin', NAMES[0]);
  const resolved = resolveDshCli({
    env: {},
    asarPath,
    pathLookup: () => pathCli, // 即使 PATH 里也有，也应优先安装目录
    inspectPath: inspectorFor(new Map([
      [expected, { isFile: true, executable: true }],
      [pathCli, { isFile: true, executable: true }],
    ])),
    platform: HOST,
  });
  assert.equal(resolved.kind, 'asar');
  assert.equal(resolved.path, expected);
  assert.ok(resolved.reason.includes(asarPath), 'reason 必须记录 ASAR 来源路径');
});

test('安装目录与 PATH 都没有可用 CLI 时回落到 PATH', () => {
  const pathCli = cliCandidate('path-bin', NAMES[0]);
  const resolved = resolveDshCli({
    env: {},
    asarPath: null,
    pathLookup: (names) => {
      assert.deepEqual(names, NAMES, 'PATH 查找必须按平台文件名');
      return pathCli;
    },
    inspectPath: inspectorFor(new Map([[pathCli, { isFile: true, executable: true }]])),
    platform: HOST,
  });
  assert.equal(resolved.kind, 'path');
  assert.equal(resolved.path, pathCli);
});

test('三个来源都没有 ⇒ kind=none 且原因可读', () => {
  const resolved = resolveDshCli({
    env: {},
    asarPath: null,
    pathLookup: () => null,
    inspectPath: () => ({ isFile: false, executable: false }),
    platform: HOST,
  });
  assert.equal(resolved.kind, 'none');
  assert.equal(resolved.path, null);
  assert.match(resolved.reason, /未设置 DSH_CLI/);
  assert.match(resolved.reason, /未发现 DSH 安装包/);
  assert.match(resolved.reason, new RegExp(`PATH 中没有 ${NAMES.map((n) => n.replace('.', '\\.')).join(' / ')}`));
});

test('DSH_CLI 指向不存在的路径：记录原因并继续降级到安装目录', () => {
  const missingCli = cliCandidate('missing', NAMES[0]);
  const installRoot = cliCandidate('install-root');
  const asarCli = path.join(installRoot, 'resources', 'runtime', 'cli', 'bin', NAMES[0]);
  const resolved = resolveDshCli({
    env: { DSH_CLI: missingCli },
    asarPath: path.join(installRoot, 'resources', 'app.asar'),
    pathLookup: () => null,
    inspectPath: inspectorFor(new Map([[asarCli, { isFile: true, executable: true }]])),
    platform: HOST,
  });
  assert.equal(resolved.kind, 'asar');
  assert.equal(resolved.path, asarCli);
  assert.equal(resolved.attempts[0].kind, 'env');
  assert.match(resolved.attempts[0].problem, /不存在|不是普通文件/);
});

test('DSH_CLI 指向不可执行文件：记录原因并继续降级到 PATH', () => {
  const decoy = cliCandidate('env-bin', 'not-a-cli.txt');
  const pathCli = cliCandidate('path-bin', NAMES[0]);
  const resolved = resolveDshCli({
    env: { DSH_CLI: decoy },
    asarPath: null,
    pathLookup: () => pathCli,
    inspectPath: inspectorFor(new Map([
      [decoy, { isFile: true, executable: false }],
      [pathCli, { isFile: true, executable: true }],
    ])),
    platform: HOST,
  });
  assert.equal(resolved.kind, 'path');
  assert.equal(resolved.path, pathCli);
  assert.match(resolved.attempts[0].problem, /不可执行/);
});

test('ASAR 路径推导失败（相对路径）不误判，继续走 PATH', () => {
  const pathCli = cliCandidate('path-bin', NAMES[0]);
  const resolved = resolveDshCli({
    env: {},
    asarPath: path.join('relative', 'resources', 'app.asar'),
    pathLookup: () => pathCli,
    inspectPath: inspectorFor(new Map([[pathCli, { isFile: true, executable: true }]])),
    platform: HOST,
  });
  assert.equal(resolved.kind, 'path');
  assert.ok(resolved.attempts.some((a) => a.kind === 'asar' && /不是绝对路径/.test(a.problem)));
});

test('PATH 里同名但不是 CLI（目录/不可执行）不会被当成 CLI', () => {
  const fake = cliCandidate('path-bin', NAMES[0]);
  for (const info of [{ isFile: false, executable: false }, { isFile: true, executable: false }]) {
    const resolved = resolveDshCli({
      env: {},
      asarPath: null,
      pathLookup: () => fake,
      inspectPath: () => info,
      platform: HOST,
    });
    assert.equal(resolved.kind, 'none');
    const pathAttempt = resolved.attempts.find((a) => a.kind === 'path');
    assert.ok(pathAttempt);
    assert.match(pathAttempt.problem, info.isFile ? /不可执行/ : /不存在|不是普通文件/);
  }
});

test('执行失败：绝对路径命令 + stderr 尾部 + 兜底处置，且不伪造成功', () => {
  const calls = [];
  const stderrLines = ['OLDEST_SHOULD_BE_TRIMMED', 'warn-a', 'warn-b', 'warn-c', 'warn-d', 'warn-e', 'warn-f', 'warn-g', 'LAST_FAILURE_LINE'];
  const outcome = runDshPluginInstall({
    cliPath: 'C:\\DSH Desktop\\resources\\runtime\\cli\\bin\\dsh.cmd',
    profile: 'web',
    platform: 'win32',
    env: { ComSpec: 'cmd.exe' },
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 1, signal: null, stdout: 'partial output', stderr: stderrLines.join('\r\n') };
    },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 1);
  assert.equal(calls.length, 1, '必须只执行一次 CLI');
  assert.equal(calls[0].command, 'cmd.exe');
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.equal(calls[0].options.env.QQ_BRIDGE_SETUP_PROFILE, 'web');
  assert.deepEqual(calls[0].args.slice(0, 4), ['/d', '/v:off', '/s', '/c']);
  assert.ok(calls[0].args[4].includes('C:\\DSH Desktop\\resources\\runtime\\cli\\bin\\dsh.cmd'),
    '命令必须用解析出的绝对路径执行');
  assert.match(calls[0].args[4], /^""C:\\DSH Desktop.*dsh\.cmd" plugin --profile "%QQ_BRIDGE_SETUP_PROFILE%" install"$/);

  const report = formatDshPluginInstallReport(outcome, { kind: 'asar', profile: 'web' });
  assert.ok(report.some((line) => /退出码 1/.test(line)), `失败必须报退出码：${report.join('\n')}`);
  assert.ok(report.some((line) => /CLI stderr 尾部/.test(line)));
  assert.ok(report.some((line) => line.includes('LAST_FAILURE_LINE')), '必须打印 stderr 尾部');
  assert.ok(!report.some((line) => line.includes('OLDEST_SHOULD_BE_TRIMMED')), '尾部必须截断，不能整段刷屏');
  assert.ok(report.some((line) => /两级链接兜底/.test(line)), '失败必须给出明确处置');
});

test('执行超时：报超时而不是伪装成退出码失败', () => {
  const timeoutError = Object.assign(new Error('spawnSync cmd.exe ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const outcome = runDshPluginInstall({
    cliPath: 'C:\\DSH Desktop\\resources\\runtime\\cli\\bin\\dsh.cmd',
    profile: 'web',
    platform: 'win32',
    env: { ComSpec: 'cmd.exe' },
    spawn: () => ({ error: timeoutError, status: null, signal: null, stdout: '', stderr: '' }),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'ETIMEDOUT');
  const report = formatDshPluginInstallReport(outcome, { kind: 'asar' });
  assert.ok(report.some((line) => /执行超时/.test(line)), report.join('\n'));
  assert.ok(report.some((line) => /两级链接兜底/.test(line)));
});

test('执行成功：报告写清 CLI 来源', () => {
  const outcome = runDshPluginInstall({
    cliPath: '/opt/dsh/bin/dsh',
    profile: 'web',
    platform: 'linux',
    env: {},
    spawn: () => ({ status: 0, signal: null, stdout: 'installed', stderr: '' }),
  });
  assert.equal(outcome.ok, true);
  const report = formatDshPluginInstallReport(outcome, { kind: 'path', profile: 'web' });
  assert.deepEqual(report, ['dsh CLI 物化完成（来源=path）']);
});

test('非 Windows 直接执行 CLI，不走 cmd', () => {
  const spec = buildDshPluginInstallCommand('/opt/dsh/bin/dsh', 'web', { platform: 'linux', env: {} });
  assert.equal(spec.command, '/opt/dsh/bin/dsh');
  assert.deepEqual(spec.args, ['plugin', '--profile', 'web', 'install']);
  assert.equal(spec.windowsVerbatimArguments, false);
  assert.deepEqual(spec.extraEnv, {});
});

test('解析函数不读 process.env / 真实文件系统（依赖全部注入）', () => {
  const previous = process.env.DSH_CLI;
  process.env.DSH_CLI = cliCandidate('should-not-be-used', NAMES[0]);
  try {
    const resolved = resolveDshCli({
      env: {}, // 注入的空 env：process.env.DSH_CLI 必须被忽略
      asarPath: null,
      pathLookup: () => null,
      inspectPath: () => ({ isFile: false, executable: false }),
      platform: HOST,
    });
    assert.equal(resolved.kind, 'none');
    assert.ok(resolved.attempts.every((attempt) => attempt.path !== process.env.DSH_CLI));
  } finally {
    if (previous === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previous;
  }
});

test('默认探测：PATH 查找 + 可执行判定（只用 os.tmpdir() 临时文件）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-dsh-cli-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = dshCliNames(HOST);
  const cli = path.join(dir, names[0]);
  fs.writeFileSync(cli, HOST === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
  if (HOST !== 'win32') fs.chmodSync(cli, 0o755);

  const lookup = createPathLookup({ PATH: dir }, HOST);
  assert.equal(lookup(names), cli, 'PATH 查找必须命中临时目录里的 CLI');
  assert.equal(lookup(['definitely-missing-cli-name']), null);

  const inspectPath = createPathInspector(HOST);
  assert.deepEqual(inspectPath(cli), { isFile: true, executable: true });

  const decoy = path.join(dir, 'decoy.txt');
  fs.writeFileSync(decoy, 'not a cli');
  assert.deepEqual(inspectPath(decoy), { isFile: true, executable: false }, '.txt 不是可执行 CLI');
  assert.equal(inspectPath(dir).isFile, false, '目录不是 CLI');

  const resolved = resolveDshCli({
    env: {},
    asarPath: null,
    pathLookup: () => decoy,
    inspectPath,
    platform: HOST,
  });
  assert.equal(resolved.kind, 'none', 'PATH 里同名但不是 CLI 时不能误判');
});
