// scripts/test-generate-authorize-token.mjs
// task-60：授权 token 生成脚本测试（TDD 先红后绿）。
// 覆盖：32 字节 hex、dry-run 只打印一次、--json、--print-plugin-snippet、
// --apply-bridge 原子写/保留其它键/拒绝不同 token/--force/非法 JSON/缺失或不可写路径、
// 无默认真实路径、退出码 0/1/2、错误不泄露 token。
// 全部离线：临时目录 + 临时 JSON；不写真实 config/profile/state。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  TOKEN_BYTES,
  generateToken,
  isValidToken,
  buildPluginSnippet,
  applyTokenToBridgeConfig,
} from './generate-authorize-token.mjs';

const SCRIPT = fileURLToPath(new URL('./generate-authorize-token.mjs', import.meta.url));
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhh-token-gen-'));
  tempDirs.push(dir);
  return dir;
}

function run(args, { cwd } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

function countToken(text, token) {
  return token === undefined || token === '' ? 0 : text.split(token).length - 1;
}

test('生成格式：32 字节 → 64 位小写 hex；两次生成不同；isValidToken 严格', () => {
  assert.equal(TOKEN_BYTES, 32);
  const first = generateToken();
  const second = generateToken();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.match(second, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
  assert.equal(isValidToken(first), true);
  assert.equal(isValidToken(first.toUpperCase()), false);
  assert.equal(isValidToken(first.slice(1)), false);
  assert.equal(isValidToken(''), false);
  assert.equal(isValidToken(42), false);
});

test('插件 YAML 片段：enabled: false + consoleToken 引号字符串（键名与插件 normalizeConfig 一致）', () => {
  const token = 'a'.repeat(64);
  const snippet = buildPluginSnippet(token);
  assert.match(snippet, /enabled: false/);
  assert.match(snippet, /consoleToken: "a{64}"/);
  assert.match(snippet, /xhh-quota-guard/);
  assert.throws(() => buildPluginSnippet('not-a-token'), TypeError);
});

test('默认 dry-run：只打印一次 token、不写任何文件、提示两处配置必须一致', async () => {
  const dir = await makeDir();
  const before = await fs.readdir(dir);
  const result = run([], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  const token = result.stdout.match(/\b[0-9a-f]{64}\b/)?.[0];
  assert.ok(token, 'stdout 必须包含 64 位 token');
  assert.equal(countToken(result.stdout, token), 1, 'token 只能打印一次');
  assert.match(result.stdout, /backgroundPatrol\.authorizeToken/);
  assert.match(result.stdout, /密码管理器|password manager/i);
  assert.match(result.stdout, /一致/);
  assert.deepEqual(await fs.readdir(dir), before, 'dry-run 不得创建文件');
});

test('--json：单对象输出 {token,length,note}，token 只出现一次', async () => {
  const dir = await makeDir();
  const result = run(['--json'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, '--json 只能输出一行');
  const payload = JSON.parse(lines[0]);
  assert.match(payload.token, /^[0-9a-f]{64}$/);
  assert.equal(payload.length, 64);
  assert.equal(typeof payload.note, 'string');
  assert.equal(countToken(result.stdout, payload.token), 1);
  assert.deepEqual(await fs.readdir(dir), [], '不写文件');
});

test('--print-plugin-snippet：片段含 token 且只出现一次（不再单独打印 token 行）', async () => {
  const dir = await makeDir();
  const result = run(['--print-plugin-snippet'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  const token = result.stdout.match(/\b[0-9a-f]{64}\b/)?.[0];
  assert.ok(token);
  assert.equal(countToken(result.stdout, token), 1);
  assert.match(result.stdout, /enabled: false/);
  assert.match(result.stdout, /consoleToken: "[0-9a-f]{64}"/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('--apply-bridge：写入 backgroundPatrol.authorizeToken，保留其它键，不残留临时文件', async () => {
  const dir = await makeDir();
  const configPath = path.join(dir, 'bridge.json');
  const original = { dsh: { model: 'x' }, keep: 1, backgroundPatrol: { enabled: false, other: 'y' } };
  await fs.writeFile(configPath, JSON.stringify(original, null, 2), 'utf8');
  const result = run(['--apply-bridge', configPath], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已写入|written/i);
  assert.ok(!/\b[0-9a-f]{64}\b/.test(result.stdout), 'apply 模式不应再打印 token');
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.match(saved.backgroundPatrol.authorizeToken, /^[0-9a-f]{64}$/);
  assert.equal(saved.keep, 1);
  assert.deepEqual(saved.dsh, { model: 'x' });
  assert.equal(saved.backgroundPatrol.enabled, false);
  assert.equal(saved.backgroundPatrol.other, 'y');
  const leftovers = (await fs.readdir(dir)).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, [], '不得残留临时文件');
});

test('--apply-bridge：文件没有 backgroundPatrol 时自动创建', async () => {
  const dir = await makeDir();
  const configPath = path.join(dir, 'bridge.json');
  await fs.writeFile(configPath, JSON.stringify({ dsh: {} }), 'utf8');
  const result = run(['--apply-bridge', configPath], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.match(saved.backgroundPatrol.authorizeToken, /^[0-9a-f]{64}$/);
});

test('已有相同 token：applyTokenToBridgeConfig 幂等（already:true，不要求 --force）', async () => {
  const dir = await makeDir();
  const configPath = path.join(dir, 'bridge.json');
  const token = 'a'.repeat(64);
  await fs.writeFile(configPath, JSON.stringify({ backgroundPatrol: { authorizeToken: token } }), 'utf8');
  const applied = await applyTokenToBridgeConfig({ configPath, token });
  assert.deepEqual(applied, { path: configPath, changed: false, already: true });
});

test('已有不同 token：拒绝、退出 1、提示 --force、文件不变、不泄露 token', async () => {
  const dir = await makeDir();
  const configPath = path.join(dir, 'bridge.json');
  const existing = 'a'.repeat(64);
  const text = JSON.stringify({ backgroundPatrol: { authorizeToken: existing } }, null, 2);
  await fs.writeFile(configPath, text, 'utf8');
  const result = run(['--apply-bridge', configPath], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--force/);
  assert.equal(result.stdout, '');
  assert.equal(await fs.readFile(configPath, 'utf8'), text, '拒绝时不得改文件');
  assert.ok(!result.stderr.includes(existing), '错误信息不得回显已有 token');
  assert.ok(!/\b[0-9a-f]{64}\b/.test(result.stderr), '错误信息不得回显新 token');
});

test('--force：覆盖已有不同 token', async () => {
  const dir = await makeDir();
  const configPath = path.join(dir, 'bridge.json');
  const existing = 'a'.repeat(64);
  await fs.writeFile(configPath, JSON.stringify({ backgroundPatrol: { authorizeToken: existing } }), 'utf8');
  const result = run(['--apply-bridge', configPath, '--force'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.match(saved.backgroundPatrol.authorizeToken, /^[0-9a-f]{64}$/);
  assert.notEqual(saved.backgroundPatrol.authorizeToken, existing);
});

test('非法 JSON：拒绝（退出 1），文件字节不变', async () => {
  const dir = await makeDir();
  const configPath = path.join(dir, 'bridge.json');
  const text = '{not valid json';
  await fs.writeFile(configPath, text, 'utf8');
  const result = run(['--apply-bridge', configPath], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /JSON|json/);
  assert.equal(await fs.readFile(configPath, 'utf8'), text);
  assert.ok(!/\b[0-9a-f]{64}\b/.test(result.stderr));
});

test('缺失路径 / 父目录不存在 / 路径是目录：非零退出且不创建文件', async () => {
  const dir = await makeDir();
  const missing = path.join(dir, 'missing.json');
  const missingResult = run(['--apply-bridge', missing], { cwd: dir });
  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /不存在|not found|ENOENT/i);
  await assert.rejects(() => fs.access(missing), '不得创建文件');

  const nested = run(['--apply-bridge', path.join(dir, 'no-such-dir', 'x.json')], { cwd: dir });
  assert.equal(nested.status, 1);
  await assert.rejects(() => fs.access(path.join(dir, 'no-such-dir')), '不得创建父目录');

  const asDir = path.join(dir, 'as-dir.json');
  await fs.mkdir(asDir);
  const dirResult = run(['--apply-bridge', asDir], { cwd: dir });
  assert.equal(dirResult.status, 1);
  assert.ok(await fs.stat(asDir).then((stat) => stat.isDirectory()));
});

test('参数错误：未知参数 / --apply-bridge 缺值 → 退出 2', async () => {
  const dir = await makeDir();
  const unknown = run(['--nope'], { cwd: dir });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /用法|unknown|未知/);
  const missingValue = run(['--apply-bridge'], { cwd: dir });
  assert.equal(missingValue.status, 2);
  assert.match(missingValue.stderr, /--apply-bridge|path|路径/i);
});

test('无默认真实路径：dry-run 即使 cwd 有 config.json 也不改写它', async () => {
  const dir = await makeDir();
  const configPath = path.join(dir, 'config.json');
  const text = JSON.stringify({ backgroundPatrol: { enabled: false } }, null, 2);
  await fs.writeFile(configPath, text, 'utf8');
  const result = run([], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(configPath, 'utf8'), text, 'dry-run 不得写 config.json');
});

test('--json + --apply-bridge：单行 JSON 且同时完成写入', async () => {
  const dir = await makeDir();
  const configPath = path.join(dir, 'bridge.json');
  await fs.writeFile(configPath, JSON.stringify({ dsh: {} }), 'utf8');
  const result = run(['--json', '--apply-bridge', configPath], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0]);
  assert.match(payload.token, /^[0-9a-f]{64}$/);
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(saved.backgroundPatrol.authorizeToken, payload.token);
});
