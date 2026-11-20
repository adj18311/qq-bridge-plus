#!/usr/bin/env node
// xhhmcp-watchdog.mjs —— XhhMCP（小黑盒 MCP）存活看守
//
// 背景（2026-10-29 事故）：
//   XhhMCP 是 `D:\XhhMCP\XiaoheiheMcpServer.Http.exe`，监听 127.0.0.1:19489，供 DSH 的
//   `mcp__xiaoheihe__*` 12 个工具使用。它**不是** Windows 服务、没有计划任务、也没有健康重启，
//   唯一的持久启动点是开机启动项 `qqagent-xhh-mcp.vbs`。一旦它先挂、DSH 后启，DSH 侧的
//   `mcp-xiaoheihe` 是 `failOnStartupError: false`（连不上就放弃、不重试）⇒ 12 个工具变成
//   `unknown tool`，而且**不会自愈**，只能人工重启 DSH。
//
// 本脚本做一件事：探测端口，连续 N 次失败就用「脱离调用者会话」的方式把服务拉起来，并写审计。
//
// 用法：
//   node scripts/xhhmcp-watchdog.mjs            # 等价于 --check：探测 + 必要时重启（计划任务每分钟跑一次）
//   node scripts/xhhmcp-watchdog.mjs --check
//   node scripts/xhhmcp-watchdog.mjs --dry-run  # 只判定与记录，不真的重启
//   node scripts/xhhmcp-watchdog.mjs --status   # 打印当前状态快照（只读）
//
// 退出码：0 = 正常/无事发生/已恢复；1 = 本轮重启后仍不健康（需要人看）；2 = 参数错误。
//
// 设计要点（都是踩过的坑）：
//   · 只探 TCP，不做 MCP 握手：每分钟一次的任务不该每轮都拉浏览器/跑 initialize；
//     代价是「端口在听但服务卡死」抓不到 —— 记为已知边界，由人工 healthcheck 兜底。
//   · 重启必须 detached + unref：否则进程会随调用它的 DSH/计划任务会话一起死
//     （10-29 那次 XhhMCP 被 DSH 重启带走，就是因为它当时是 DSH 的子进程）。
//   · 子进程环境变量要**去重**：本机同时存在 `NO_PROXY`/`no_proxy`、`HTTPS_PROXY`/`https_proxy`
//     两套大小写重复键，PowerShell 的 Start-Process 直接抛 ArgumentException（实测）。
//     所以这里按小写键去重后再交给 spawn。
//   · 连续失败阈值 + 冷却 + 每小时上限：避免「服务本身起不来」时每分钟狂拉一次进程。

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(HERE);

export const WATCHDOG_DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 19489,
  exePath: 'D:\\XhhMCP\\XiaoheiheMcpServer.Http.exe',
  workDir: 'D:\\XhhMCP',
  dataDir: 'D:\\XhhMCP\\data',
  chromiumPath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  userId: '105762184',
  stateFile: path.join(REPO_ROOT, 'state', 'xhhmcp-watchdog.json'),
  auditFile: path.join(REPO_ROOT, 'state', 'xhhmcp-watchdog.jsonl'),
  failureThreshold: 2,
  restartCooldownMs: 5 * 60 * 1000,
  maxRestartsPerHour: 6,
  probeTimeoutMs: 3000,
  postRestartWaitMs: 15_000,
  enabled: true,
});

const PROXY_LIKE = new Set(['http_proxy', 'https_proxy', 'no_proxy', 'all_proxy']);

/**
 * 构造子进程环境：按小写键去重（后出现者覆盖），再叠加 overrides。
 * 必要性见文件头：本机存在大小写重复的代理变量，PowerShell 会因此拒绝启动进程。
 */
export function buildChildEnv(baseEnv, overrides = {}) {
  const out = {};
  const seen = new Map(); // lowerKey -> 实际写入的键名
  for (const [key, value] of Object.entries(baseEnv ?? {})) {
    if (typeof value !== 'string') continue;
    const lower = key.toLowerCase();
    // 代理类变量保留一份即可（Windows 环境变量名不区分大小写，重复会炸启动器）。
    if (PROXY_LIKE.has(lower)) {
      const prev = seen.get(lower);
      if (prev !== undefined) delete out[prev];
    }
    out[key] = value;
    seen.set(lower, key);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue;
    const lower = key.toLowerCase();
    const prev = seen.get(lower);
    if (prev !== undefined && prev !== key) delete out[prev];
    out[key] = String(value);
    seen.set(lower, key);
  }
  return out;
}

/** 运行态：{ failures, lastRestartAt, restarts[], lastSuppressedAt } */
export function emptyState() {
  return { failures: 0, lastRestartAt: 0, restarts: [], lastSuppressedAt: 0 };
}

/** 读状态文件；损坏一律当空状态（绝不因为状态坏了就停止看守）。 */
export function loadState(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { state: emptyState(), corrupt: false };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { state: emptyState(), corrupt: true };
    const state = emptyState();
    if (Number.isFinite(parsed.failures) && parsed.failures >= 0) state.failures = Math.trunc(parsed.failures);
    if (Number.isFinite(parsed.lastRestartAt) && parsed.lastRestartAt >= 0) state.lastRestartAt = Math.trunc(parsed.lastRestartAt);
    if (Number.isFinite(parsed.lastSuppressedAt) && parsed.lastSuppressedAt >= 0) state.lastSuppressedAt = Math.trunc(parsed.lastSuppressedAt);
    if (Array.isArray(parsed.restarts)) state.restarts = parsed.restarts.filter((n) => Number.isFinite(n));
    return { state, corrupt: false };
  } catch {
    return { state: emptyState(), corrupt: true };
  }
}

export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function appendAudit(file, event) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
}

/** TCP 探测：能连上即视为存活。 */
export function probePort({ host, port, timeoutMs = 3000 }) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/**
 * 纯判定：是否该重启。
 * 返回 { action: 'noop'|'wait'|'suppressed'|'restart', reason }
 */
export function decideAction(state, reachable, now, cfg = WATCHDOG_DEFAULTS) {
  if (reachable) {
    return { action: state.failures === 0 ? 'noop' : 'wait', reason: 'healthy' };
  }
  const failures = state.failures + 1;
  if (failures < cfg.failureThreshold) return { action: 'wait', reason: 'below-threshold' };
  const sinceRestart = now - (state.lastRestartAt || 0);
  if (state.lastRestartAt > 0 && sinceRestart < cfg.restartCooldownMs) {
    return { action: 'suppressed', reason: 'cooldown', retryAfterMs: cfg.restartCooldownMs - sinceRestart };
  }
  const hourAgo = now - 60 * 60 * 1000;
  const recent = (state.restarts || []).filter((at) => Number.isFinite(at) && at >= hourAgo);
  if (recent.length >= cfg.maxRestartsPerHour) {
    return { action: 'suppressed', reason: 'hourly-cap', restartsLastHour: recent.length };
  }
  return { action: 'restart', reason: 'unreachable' };
}

/** 拉起服务：detached + unref，脱离调用者会话；返回 { pid }。 */
export function restartService(cfg = WATCHDOG_DEFAULTS, { spawnImpl = spawn, baseEnv = process.env } = {}) {
  const env = buildChildEnv(baseEnv, {
    ASPNETCORE_URLS: `http://${cfg.host}:${cfg.port}`,
    XIAOHEIHE_CHROMIUM_PATH: cfg.chromiumPath,
    XIAOHEIHE_USER_ID: cfg.userId,
    XIAOHEIHE_DATA_DIR: cfg.dataDir,
  });
  const child = spawnImpl(cfg.exePath, ['--show-browser'], {
    cwd: cfg.workDir,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref?.();
  return { pid: child.pid ?? null };
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 主流程（可注入依赖以便离线测试）。
 * deps: { now, probe, restart, wait, cfg }
 */
export async function runCheck(deps = {}) {
  const cfg = { ...WATCHDOG_DEFAULTS, ...(deps.cfg ?? {}) };
  const now = deps.now ?? (() => Date.now());
  const probe = deps.probe ?? probePort;
  const restart = deps.restart ?? ((c) => restartService(c));
  const wait = deps.wait ?? sleep;
  const dryRun = deps.dryRun === true;
  const result = { action: 'noop', reason: 'healthy', reachable: null, restarted: false, pid: null, exitCode: 0 };

  if (cfg.enabled !== true) {
    result.action = 'disabled';
    result.reason = 'disabled';
    return result;
  }

  const { state, corrupt } = loadState(cfg.stateFile);
  const at = now();
  if (corrupt) {
    appendAudit(cfg.auditFile, { type: 'state-corrupt', at, note: '状态文件不可解析，按空状态继续看守' });
  }

  const reachable = await probe({ host: cfg.host, port: cfg.port, timeoutMs: cfg.probeTimeoutMs });
  result.reachable = reachable;
  const decision = decideAction(state, reachable, at, cfg);
  result.action = decision.action;
  result.reason = decision.reason;

  if (reachable) {
    if (state.failures !== 0) {
      state.failures = 0;
      saveState(cfg.stateFile, state);
      appendAudit(cfg.auditFile, { type: 'recovered', at, note: '端口恢复可连' });
    }
    return result;
  }

  // 不可达：先累加失败计数（无论后面是否重启，都要落盘）。
  state.failures += 1;
  if (decision.action === 'wait') {
    saveState(cfg.stateFile, state);
    appendAudit(cfg.auditFile, {
      type: 'probe-failed', at, failures: state.failures, threshold: cfg.failureThreshold,
    });
    return result;
  }

  if (decision.action === 'suppressed') {
    // 每轮都记会刷屏；同一冷却窗口只记一次。
    const lastLog = state.lastSuppressedAt || 0;
    if (at - lastLog >= Math.min(cfg.restartCooldownMs, 60 * 1000)) {
      state.lastSuppressedAt = at;
      appendAudit(cfg.auditFile, {
        type: 'restart-suppressed', at, failures: state.failures, reason: decision.reason,
      });
    }
    saveState(cfg.stateFile, state);
    return result;
  }

  // action === 'restart'
  if (dryRun) {
    appendAudit(cfg.auditFile, { type: 'restart-dry-run', at, failures: state.failures });
    saveState(cfg.stateFile, state);
    result.action = 'restart-dry-run';
    return result;
  }

  appendAudit(cfg.auditFile, { type: 'restart-attempt', at, failures: state.failures, exe: cfg.exePath });
  let pid = null;
  try {
    const spawned = restart(cfg);
    pid = spawned?.pid ?? null;
    result.restarted = true;
    result.pid = pid;
  } catch (error) {
    // 记录 lastRestartAt 也照样推进，避免「起不来就每分钟重试」把机器拖死。
    state.lastRestartAt = at;
    state.restarts = [...(state.restarts || []), at].slice(-64);
    saveState(cfg.stateFile, state);
    appendAudit(cfg.auditFile, {
      type: 'restart-error', at, error: error instanceof Error ? error.message : String(error),
    });
    result.exitCode = 1;
    result.action = 'restart-error';
    return result;
  }

  state.lastRestartAt = at;
  state.restarts = [...(state.restarts || []), at].slice(-64);
  saveState(cfg.stateFile, state);
  appendAudit(cfg.auditFile, { type: 'restart-spawned', at, pid });

  if (cfg.postRestartWaitMs > 0) await wait(cfg.postRestartWaitMs);
  const healthyAfter = await probe({ host: cfg.host, port: cfg.port, timeoutMs: cfg.probeTimeoutMs });
  if (healthyAfter) {
    state.failures = 0;
    saveState(cfg.stateFile, state);
    appendAudit(cfg.auditFile, { type: 'restart-ok', at: now(), pid });
    result.action = 'restarted';
    result.exitCode = 0;
  } else {
    appendAudit(cfg.auditFile, { type: 'restart-unhealthy', at: now(), pid });
    result.action = 'restart-unhealthy';
    result.exitCode = 1;
  }
  return result;
}

function readStatus(cfg) {
  const { state, corrupt } = loadState(cfg.stateFile);
  return { ok: true, stateFile: cfg.stateFile, auditFile: cfg.auditFile, corrupt, state };
}

async function main(argv = process.argv.slice(2)) {
  const cfg = { ...WATCHDOG_DEFAULTS };
  // 环境变量可覆盖（运维/测试用；默认值来自本文件顶部常量）。
  for (const [envKey, cfgKey] of [
    ['XHH_WATCHDOG_HOST', 'host'],
    ['XHH_WATCHDOG_EXE', 'exePath'],
    ['XHH_WATCHDOG_WORKDIR', 'workDir'],
    ['XHH_WATCHDOG_DATA_DIR', 'dataDir'],
    ['XHH_WATCHDOG_STATE_FILE', 'stateFile'],
    ['XHH_WATCHDOG_AUDIT_FILE', 'auditFile'],
  ]) {
    if (typeof process.env[envKey] === 'string' && process.env[envKey] !== '') cfg[cfgKey] = process.env[envKey];
  }
  if (process.env.XHH_WATCHDOG_PORT) cfg.port = Number(process.env.XHH_WATCHDOG_PORT);
  if (process.env.XHH_WATCHDOG_ENABLED === 'false') cfg.enabled = false;
  if (process.env.XHH_WATCHDOG_POST_RESTART_WAIT_MS) cfg.postRestartWaitMs = Number(process.env.XHH_WATCHDOG_POST_RESTART_WAIT_MS);

  let mode = 'check';
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--check') mode = 'check';
    else if (arg === '--status') mode = 'status';
    else if (arg === '--dry-run') { mode = 'check'; dryRun = true; }
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('用法：node scripts/xhhmcp-watchdog.mjs [--check|--dry-run|--status]\n');
      return 0;
    } else {
      process.stderr.write(`未知参数：${arg}\n`);
      return 2;
    }
  }

  if (mode === 'status') {
    process.stdout.write(`${JSON.stringify(readStatus(cfg), null, 2)}\n`);
    return 0;
  }

  const result = await runCheck({ cfg, dryRun });
  // 计划任务每分钟跑一次：健康时保持安静，只在有动作时输出，避免刷日志。
  if (result.action !== 'noop' || result.exitCode !== 0) {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`);
  }
  return result.exitCode;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`watchdog 异常：${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}