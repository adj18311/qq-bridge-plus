#!/usr/bin/env node
// test-xhhmcp-watchdog.mjs —— 小黑盒 MCP 存活看守的离线行为测试
//
// 测什么：探测结果 → 判定 → 重启/抑制 → 状态与审计落盘。全部离线，绝不起真进程、不碰真实端口。
// 关键回归：
//   · 单次失败不得重启（防抖），连续 N 次才重启；
//   · 冷却期内不得重复重启，且抑制日志不得每轮刷屏；
//   · 每小时重启上限生效；
//   · 重启失败/重启后不健康都必须落盘可见，并且都要推进 lastRestartAt（避免热循环）；
//   · 状态文件损坏时继续看守（不能因为状态坏了就停摆）；
//   · 子进程环境变量按大小写去重（本机存在 NO_PROXY/no_proxy 重复键，实测会让启动器抛 ArgumentException）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildChildEnv,
  decideAction,
  emptyState,
  loadState,
  runCheck,
  saveState,
  WATCHDOG_DEFAULTS,
} from './xhhmcp-watchdog.mjs';

function tmpFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhh-watchdog-'));
  return {
    dir,
    stateFile: path.join(dir, 'watchdog.json'),
    auditFile: path.join(dir, 'watchdog.jsonl'),
  };
}

function readAudit(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function makeCfg(files, overrides = {}) {
  return {
    ...WATCHDOG_DEFAULTS,
    stateFile: files.stateFile,
    auditFile: files.auditFile,
    postRestartWaitMs: 0,
    ...overrides,
  };
}

test('健康时保持安静：不重启、不写审计、状态保持 0 失败', async () => {
  const files = tmpFiles();
  let restarts = 0;
  const result = await runCheck({
    cfg: makeCfg(files),
    probe: async () => true,
    restart: () => { restarts += 1; return { pid: 1 }; },
    now: () => 1_000,
  });
  assert.equal(result.action, 'noop');
  assert.equal(restarts, 0);
  assert.deepEqual(readAudit(files.auditFile), []);
  assert.equal(loadState(files.stateFile).state.failures, 0);
});

test('失败计数从 1 恢复到 0 时写 recovered 审计', async () => {
  const files = tmpFiles();
  saveState(files.stateFile, { ...emptyState(), failures: 1 });
  const result = await runCheck({
    cfg: makeCfg(files),
    probe: async () => true,
    restart: () => { throw new Error('不应重启'); },
    now: () => 5_000,
  });
  assert.equal(result.action, 'wait');
  const audit = readAudit(files.auditFile);
  assert.deepEqual(audit.map((e) => e.type), ['recovered']);
  assert.equal(loadState(files.stateFile).state.failures, 0);
});

test('单次失败不重启（阈值 2），只累加计数并写 probe-failed', async () => {
  const files = tmpFiles();
  let restarts = 0;
  const result = await runCheck({
    cfg: makeCfg(files),
    probe: async () => false,
    restart: () => { restarts += 1; return { pid: 1 }; },
    now: () => 10_000,
  });
  assert.equal(result.action, 'wait');
  assert.equal(result.reason, 'below-threshold');
  assert.equal(restarts, 0);
  assert.equal(loadState(files.stateFile).state.failures, 1);
  assert.deepEqual(readAudit(files.auditFile).map((e) => e.type), ['probe-failed']);
});

test('连续两次失败触发重启，并记录 spawned/ok 与 pid', async () => {
  const files = tmpFiles();
  saveState(files.stateFile, { ...emptyState(), failures: 1 });
  const calls = [];
  const probes = [false, true]; // 重启前不可达、重启后可达
  let probeIndex = 0;
  const result = await runCheck({
    cfg: makeCfg(files),
    probe: async () => probes[Math.min(probeIndex++, probes.length - 1)],
    restart: (cfg) => { calls.push(cfg.exePath); return { pid: 4242 }; },
    now: () => 20_000,
  });
  assert.equal(result.action, 'restarted');
  assert.equal(result.pid, 4242);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [WATCHDOG_DEFAULTS.exePath]);
  const types = readAudit(files.auditFile).map((e) => e.type);
  assert.deepEqual(types, ['restart-attempt', 'restart-spawned', 'restart-ok']);
  const state = loadState(files.stateFile).state;
  assert.equal(state.failures, 0);
  assert.equal(state.lastRestartAt, 20_000);
  assert.deepEqual(state.restarts, [20_000]);
});

test('冷却期内不重复重启，且抑制日志同一窗口只写一次', async () => {
  const files = tmpFiles();
  saveState(files.stateFile, { ...emptyState(), failures: 5, lastRestartAt: 100_000 });
  let restarts = 0;
  const deps = {
    cfg: makeCfg(files),
    probe: async () => false,
    restart: () => { restarts += 1; return { pid: 1 }; },
  };
  const first = await runCheck({ ...deps, now: () => 100_500 });
  const second = await runCheck({ ...deps, now: () => 101_000 });
  assert.equal(first.action, 'suppressed');
  assert.equal(first.reason, 'cooldown');
  assert.equal(second.action, 'suppressed');
  assert.equal(restarts, 0);
  const suppressed = readAudit(files.auditFile).filter((e) => e.type === 'restart-suppressed');
  assert.equal(suppressed.length, 1, '冷却窗口内只应写一条抑制日志');
});

test('每小时重启上限生效', async () => {
  const files = tmpFiles();
  const now = 1_000_000;
  const restarts = [now - 60_000, now - 50_000, now - 40_000, now - 30_000, now - 20_000, now - 10_000];
  saveState(files.stateFile, { ...emptyState(), failures: 3, lastRestartAt: now - 10_000, restarts });
  let spawns = 0;
  const result = await runCheck({
    cfg: makeCfg(files, { maxRestartsPerHour: 6, restartCooldownMs: 1 }),
    probe: async () => false,
    restart: () => { spawns += 1; return { pid: 1 }; },
    now: () => now,
  });
  assert.equal(result.action, 'suppressed');
  assert.equal(result.reason, 'hourly-cap');
  assert.equal(spawns, 0);
});

test('重启抛错要落盘 restart-error 并返回 1，同时推进 lastRestartAt 防热循环', async () => {
  const files = tmpFiles();
  saveState(files.stateFile, { ...emptyState(), failures: 1 });
  const result = await runCheck({
    cfg: makeCfg(files),
    probe: async () => false,
    restart: () => { throw new Error('spawn ENOENT'); },
    now: () => 30_000,
  });
  assert.equal(result.action, 'restart-error');
  assert.equal(result.exitCode, 1);
  const audit = readAudit(files.auditFile);
  assert.equal(audit.at(-1).type, 'restart-error');
  assert.match(audit.at(-1).error, /ENOENT/);
  const state = loadState(files.stateFile).state;
  assert.equal(state.lastRestartAt, 30_000);
  assert.deepEqual(state.restarts, [30_000]);
});

test('重启后仍不可达 → restart-unhealthy，退出码 1，失败计数保留', async () => {
  const files = tmpFiles();
  saveState(files.stateFile, { ...emptyState(), failures: 1 });
  const result = await runCheck({
    cfg: makeCfg(files),
    probe: async () => false,
    restart: () => ({ pid: 9 }),
    now: () => 40_000,
  });
  assert.equal(result.action, 'restart-unhealthy');
  assert.equal(result.exitCode, 1);
  assert.equal(readAudit(files.auditFile).at(-1).type, 'restart-unhealthy');
  assert.equal(loadState(files.stateFile).state.failures, 2);
});

test('状态文件损坏：按空状态继续看守，并写 state-corrupt', async () => {
  const files = tmpFiles();
  fs.writeFileSync(files.stateFile, '{ this is not json', 'utf8');
  const result = await runCheck({
    cfg: makeCfg(files),
    probe: async () => true,
    restart: () => { throw new Error('不应重启'); },
    now: () => 50_000,
  });
  assert.equal(result.action, 'noop');
  assert.deepEqual(readAudit(files.auditFile).map((e) => e.type), ['state-corrupt']);
});

test('--dry-run 只判定不启动进程', async () => {
  const files = tmpFiles();
  saveState(files.stateFile, { ...emptyState(), failures: 1 });
  let spawns = 0;
  const result = await runCheck({
    cfg: makeCfg(files),
    probe: async () => false,
    restart: () => { spawns += 1; return { pid: 1 }; },
    now: () => 60_000,
    dryRun: true,
  });
  assert.equal(result.action, 'restart-dry-run');
  assert.equal(spawns, 0);
  assert.equal(readAudit(files.auditFile).at(-1).type, 'restart-dry-run');
  assert.equal(loadState(files.stateFile).state.lastRestartAt, 0);
});

test('enabled=false 时直接跳过（不探测、不写文件）', async () => {
  const files = tmpFiles();
  let probed = 0;
  const result = await runCheck({
    cfg: makeCfg(files, { enabled: false }),
    probe: async () => { probed += 1; return false; },
    restart: () => { throw new Error('不应重启'); },
    now: () => 70_000,
  });
  assert.equal(result.action, 'disabled');
  assert.equal(probed, 0);
  assert.equal(fs.existsSync(files.auditFile), false);
});

test('buildChildEnv：按大小写去重代理变量并叠加 ASPNETCORE_URLS', () => {
  const env = buildChildEnv(
    { NO_PROXY: 'a', no_proxy: 'b', PATH: 'C:\\x', HTTPS_PROXY: 'h', https_proxy: 'i' },
    { ASPNETCORE_URLS: 'http://127.0.0.1:19489', XIAOHEIHE_USER_ID: '105762184' },
  );
  const lowerKeys = Object.keys(env).map((k) => k.toLowerCase());
  assert.equal(lowerKeys.filter((k) => k === 'no_proxy').length, 1);
  assert.equal(lowerKeys.filter((k) => k === 'https_proxy').length, 1);
  assert.equal(env.ASPNETCORE_URLS, 'http://127.0.0.1:19489');
  assert.equal(env.XIAOHEIHE_USER_ID, '105762184');
  assert.equal(env.PATH, 'C:\\x');
});

test('decideAction 纯判定：健康/低于阈值/触发/冷却/上限', () => {
  const now = 1_000_000;
  assert.equal(decideAction(emptyState(), true, now).action, 'noop');
  assert.equal(decideAction({ ...emptyState(), failures: 2 }, true, now).action, 'wait');
  assert.equal(decideAction(emptyState(), false, now).action, 'wait');
  assert.equal(decideAction({ ...emptyState(), failures: 1 }, false, now).action, 'restart');
  const cool = decideAction({ ...emptyState(), failures: 3, lastRestartAt: now - 1000 }, false, now);
  assert.equal(cool.action, 'suppressed');
  assert.equal(cool.reason, 'cooldown');
  assert.match(String(cool.retryAfterMs), /^\d+$/);
  const capped = decideAction(
    { ...emptyState(), failures: 3, lastRestartAt: 1, restarts: Array.from({ length: 6 }, (_, i) => now - i * 1000) },
    false,
    now,
    { ...WATCHDOG_DEFAULTS, restartCooldownMs: 1 },
  );
  assert.equal(capped.reason, 'hourly-cap');
});