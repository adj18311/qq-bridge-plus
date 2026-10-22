// 测试地基自身的契约回归：清单成员、quick/full 选择、runner 的失败/超时/退出码。
// 只用 os.tmpdir() 里的一次性子脚本验证 runner，不重复启动全量审计。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CORE_TESTS, DEFAULT_SCRIPT_TIMEOUT_MS, FULL_TESTS, ORIGINAL_FULL_TESTS,
  QUICK_TESTS, TEST_FOUNDATION_TESTS, SESSION_ROUTER_TESTS, REPLY_TIMING_BASELINE_TESTS
} from './test-suite-manifest.mjs';
import { resolveSuite, runScripts, SUITES } from './test-suite-runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RUNNER_URL = pathToFileURL(path.join(HERE, 'test-suite-runner.mjs')).href;

function makeSandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-test-suite-'));
}

function writeDouble(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), body);
  return name;
}

function withDoubles(fn) {
  const dir = makeSandbox();
  try {
    writeDouble(dir, 'pass.mjs', 'process.exit(0);\n');
    writeDouble(dir, 'fail.mjs', 'process.exit(3);\n');
    writeDouble(dir, 'hang.mjs', 'setTimeout(() => {}, 10000);\n');
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 通过真实 CLI 的模块入口验证退出码（子进程里跑 runner，不启动真实测试清单）。
function runHarness(script, timeoutMs) {
  return withDoubles((dir) => {
    const harness = path.join(dir, 'harness.mjs');
    fs.writeFileSync(harness, [
      `import { runSuiteCli } from ${JSON.stringify(RUNNER_URL)};`,
      'runSuiteCli(process.argv[2], {',
      '  tests: [process.argv[3]],',
      '  scriptsDir: process.argv[4],',
      '  timeoutMs: Number(process.argv[5]),',
      "  stdio: 'ignore', log: () => {}, errorLog: () => {}",
      '});',
      ''
    ].join('\n'));
    const result = spawnSync(process.execPath, [harness, 'quick', script, dir, String(timeoutMs)], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    return result.status;
  });
}

test('清单：原 48 项全部保留且唯一，quick 是 full 的真子集', () => {
  assert.equal(ORIGINAL_FULL_TESTS.length, 48, '原注册数必须仍是 48');
  assert.equal(new Set(ORIGINAL_FULL_TESTS).size, 48, '原注册不得重复');
  for (const name of ORIGINAL_FULL_TESTS) {
    assert.ok(FULL_TESTS.includes(name), `full 缺少原注册 ${name}`);
  }
  assert.equal(new Set(FULL_TESTS).size, FULL_TESTS.length, 'full 不得重复');
  assert.equal(new Set(QUICK_TESTS).size, QUICK_TESTS.length, 'quick 不得重复');
  assert.ok(QUICK_TESTS.length < FULL_TESTS.length, 'quick 必须是真子集');
  for (const name of QUICK_TESTS) {
    assert.ok(FULL_TESTS.includes(name), `quick 含不在 full 里的 ${name}`);
  }
  assert.deepEqual(CORE_TESTS, ORIGINAL_FULL_TESTS.slice(0, 7), 'quick 的 7 项核心必须取原列表前 7 项');
  for (const name of TEST_FOUNDATION_TESTS) {
    assert.ok(FULL_TESTS.includes(name), `full 缺少地基回归 ${name}`);
    assert.ok(QUICK_TESTS.includes(name), `quick 缺少地基回归 ${name}`);
  }
  assert.deepEqual(SESSION_ROUTER_TESTS, ['../src/core/session-router.test.mjs']);
  for (const name of SESSION_ROUTER_TESTS) {
    assert.equal(FULL_TESTS.filter((item) => item === name).length, 1, '路由单测必须在 full 中恰好注册一次');
    assert.ok(!QUICK_TESTS.includes(name), '路由单测仅追加至 full，既有 quick 范围不变');
  }
  assert.deepEqual(REPLY_TIMING_BASELINE_TESTS, ['test-reply-timing-baseline.mjs']);
  for (const name of REPLY_TIMING_BASELINE_TESTS) {
    assert.equal(FULL_TESTS.filter(item => item === name).length, 1);
    assert.equal(QUICK_TESTS.filter(item => item === name).length, 1);
  }
  for (const name of FULL_TESTS) {
    assert.ok(fs.existsSync(path.join(HERE, name)), `清单注册但脚本不存在：${name}`);
  }
});

test('选择：默认 full，quick 显式，未知套件报错', () => {
  assert.equal(resolveSuite(undefined), 'full');
  assert.equal(resolveSuite('full'), 'full');
  assert.equal(resolveSuite('quick'), 'quick');
  assert.deepEqual(SUITES.full.tests, FULL_TESTS);
  assert.deepEqual(SUITES.quick.tests, QUICK_TESTS);
  assert.throws(() => resolveSuite('all'), /未知测试套件/);
  assert.throws(() => resolveSuite(''), /未知测试套件/);
});

test('runner：串行执行、通过/失败计数与 FAILED 文案', () => {
  withDoubles((dir) => {
    const lines = [];
    const errors = [];
    const result = runScripts(['pass.mjs', 'fail.mjs'], {
      root: ROOT,
      scriptsDir: dir,
      stdio: 'pipe',
      log: (line) => lines.push(line),
      errorLog: (line) => errors.push(line)
    });
    assert.deepEqual(result, { total: 2, failed: 1, passed: 1 });
    assert.deepEqual(lines, ['\nRunning pass.mjs', '\nRunning fail.mjs']);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^FAILED fail\.mjs: exit 3$/);
  });
});

test('runner：超时按失败上报，保留 ETIMEDOUT 证据', () => {
  withDoubles((dir) => {
    const errors = [];
    const result = runScripts(['hang.mjs'], {
      root: ROOT,
      scriptsDir: dir,
      timeoutMs: 250,
      stdio: 'pipe',
      log: () => {},
      errorLog: (line) => errors.push(line)
    });
    assert.equal(result.failed, 1);
    assert.equal(result.passed, 0);
    assert.match(errors[0], /^FAILED hang\.mjs:/);
    assert.match(errors[0], /ETIMEDOUT|timed out/i);
  });
});

test('CLI：坏参数退出码 2，且不启动任何真实测试', () => {
  for (const [entry, arg] of [['test-audit.mjs', 'bogus'], ['test-quick.mjs', 'extra']]) {
    const result = spawnSync(process.execPath, [path.join(HERE, entry), arg], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    assert.equal(result.status, 2, `${entry} ${arg} 应以 2 退出：${result.stderr}`);
    assert.match(result.stderr, /未知参数/);
  }
});

test('退出码传播：通过=0，失败=1，超时=1', () => {
  assert.equal(runHarness('pass.mjs', DEFAULT_SCRIPT_TIMEOUT_MS), 0);
  assert.equal(runHarness('fail.mjs', DEFAULT_SCRIPT_TIMEOUT_MS), 1);
  assert.equal(runHarness('hang.mjs', 300), 1);
});
