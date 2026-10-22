#!/usr/bin/env node
/**
 * switch-model.mjs —— 模型档位切换 + 会话退役重建（本地运维脚本，不是 DSH 插件）
 *
 * 背景（已实测确认，别推翻）
 * ---------------------------------------------------------------------------
 * 1. 模型绑在 DSH **会话**上：改 config.json 的 dsh.provider/model 只影响**新建**会话。
 *    重启桥接、重启 DSH 都不会改已有会话的模型（见 bridge.js 的 ensureChatModel /
 *    modelAppliedSessions：每个 DSH 会话在本进程内只 selectModel 一次）。
 * 2. 让会话跟随配置的唯一可靠手段 = **退役重建**：
 *    从 state/sessions.json 删掉该 key 的映射 → 重启桥接 → 下一条消息建新会话并按 config 应用模型。
 * 3. 桥接进程 PID 写在 state/bridge.lock；只杀这一个进程，守护（start.bat 的循环）会自己拉起来。
 *    本脚本**不**调用 restart.bat，也**不**重启 DSH。
 *
 * 用法
 * ---------------------------------------------------------------------------
 *   node scripts/switch-model.mjs --to minimax|deepseek [--dry-run] [--only <key>] [--json]
 *                                [--force] [--quiet]
 *
 *   --to <档位>    目标档位：minimax | deepseek（必填）
 *   --dry-run      只打印将要改动的内容：不写任何文件、不杀进程、不发消息
 *   --only <key>   只处理这一个会话 key（group:群号 / private:QQ号）。**测试用**：
 *                  正常使用请不带 --only，默认切**全部**会话。
 *   --json         机器可读输出（stdout 只有 JSON，人类可读进度走 stderr）
 *   --force        即使 config.json 已经是目标档位，也照样退役重建会话
 *   --quiet        不发送私聊通知（默认会发）
 *   -h, --help     帮助
 *
 * 做的事（按顺序）
 * ---------------------------------------------------------------------------
 *   ① 备份 config.json 与 state/sessions.json（同目录，.bak-switch-YYYYMMDDTHHMMSS）
 *   ② 改 config.json 的 dsh.provider / dsh.model 为目标档位
 *   ③ 删目标会话映射（默认全部；--only 时只删该 key），同时删掉对应的 sessionPolicies
 *   ④ 杀掉 state/bridge.lock 里的那个 PID，轮询等待守护拉起新桥接（超时 60s 报错）
 *   ⑤ 自检：读 state/token-usage.jsonl，打印每个 key 最近一次用的 provider/model
 *   ⑥ 给主人私聊发一条结果通知（--quiet 可跳过；走控制台 /api/test-send，见 README）
 *
 * 幂等
 * ---------------------------------------------------------------------------
 *   目标档位与当前一致时，明确提示「已经是该档位」并跳过（不发通知）。
 *   只想重建会话时加 --force。
 *
 * 绝不碰
 * ---------------------------------------------------------------------------
 *   记忆桶（state/social-v2.json）、slang、stickers、patrol-log、src/**、public/**、
 *   dsh/**、plugins/**、config.example.json、README.md、docs/** —— 一律不动。
 *
 * 失败安全
 * ---------------------------------------------------------------------------
 *   任一步失败都会打印**回滚命令**（用哪个备份还原哪两个文件）。
 *   若失败发生在杀进程之前，脚本还会自动把 config.json / sessions.json 还原回备份。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const STATE_DIR = path.join(ROOT, 'state');
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');
const LEDGER_FILE = path.join(STATE_DIR, 'token-usage.jsonl');
const RESTART_TIMEOUT_MS = 60_000;

/** 两个模型档位。要改档位（换模型/换 provider）就改这里，改完顺手核对 README。 */
const PROFILES = {
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    provider: 'minimax-cn',
    model: 'MiniMax-M3.1-Flash-Preview',
    otherBat: '切换模型到DeepSeek.bat',
    // M3.1 本身是推理模型（直连 MiniMax API 实测：reasoning_effort=low/high 都被接受，
    // 且确实压低思考量；只有 thinking={type:disabled} 会被 400 拒）。
    // 早先「任何档位都被 DSH 拒绝」的原因是本地模型声明缺 reasoningEfforts，
    // 已在 ~/.dsh/profiles/desktop/cordis.patch.yml 给该条目补上 reasoningEfforts: [low, high]。
    // 又因为桥接有自己的白名单（src/bridge.js 只认 low/high/max，缺键会回退成 'max'），
    // 所以这里必须显式写 'high'（写 undefined/off 会变成 'max' 而被拒）。
    // 判定脚本：scripts/check-reasoning-effort.mjs；背景见 README「已知问题 4.1」。
    reasoningEffort: 'high',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    otherBat: '切换模型到MiniMax.bat',
    // deepseek-account 走 dsh-llm-deepseek，它接受 off/low/high/max；高频一直用 high，实测正常。
    reasoningEffort: 'high',
  },
};

/** --effort 能显式指定的取值（auto = 用档位自己的默认策略）。 */
const EFFORT_VALUES = ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 把档位策略 + --effort 覆盖解析成「config.json 里该有的值」：字符串=写它，undefined=删掉这个键。 */
function resolveEffortValue(profile, override) {
  if (override && override !== 'auto') return override;
  return profile.reasoningEffort;
}

function fmtEffort(value) {
  return value === undefined ? '（删掉这个键，用模型默认）' : JSON.stringify(value);
}

// ── 小工具 ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return { raw, value: JSON.parse(text) };
}

/** 原子写 JSON：先写 .tmp 再 rename，保持仓库既有的 2 空格 + 末尾换行格式。 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-switch`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function sha12(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
  } catch {
    return '(读不到)';
  }
}

function mtimeText(file) {
  try {
    return new Date(fs.statSync(file).mtimeMs).toISOString();
  } catch {
    return '(读不到)';
  }
}

/** 本地时间戳，形如 20261009T190512（与仓库既有 .bak-m31switch-… 命名一致）。 */
function stampLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readLockPid() {
  try {
    const text = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** 取进程命令行；用于杀进程前的身份校验（PID 会被 Windows 回收，不能盲杀）。 */
function commandLineOf(pid) {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CommandLine }`],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
    );
    return out.trim();
  } catch {
    return '';
  }
}

function looksLikeBridge(cmdline) {
  const line = String(cmdline || '');
  return line.includes('bridge.js') && !line.includes('mcp-');
}

function killPid(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', timeout: 15_000, windowsHide: true });
    return true;
  } catch {
    try {
      process.kill(pid);
      return true;
    } catch {
      return false;
    }
  }
}

// ── 参数 ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { to: null, only: null, dryRun: false, json: false, force: false, quiet: false, help: false, effort: 'auto', keepEffort: false };
  const takeValue = (i, name) => {
    const a = argv[i];
    const eq = a.indexOf('=');
    if (eq >= 0) return [a.slice(eq + 1), i];
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`参数 ${name} 缺少取值`);
    return [v, i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--to' || a.startsWith('--to=')) [out.to, i] = takeValue(i, '--to');
    else if (a === '--only' || a.startsWith('--only=')) [out.only, i] = takeValue(i, '--only');
    else if (a === '--effort' || a.startsWith('--effort=')) [out.effort, i] = takeValue(i, '--effort');
    else if (a === '--keep-effort') out.keepEffort = true;
    else if (a === '--dry-run' || a === '-n') out.dryRun = true;
    else if (a === '--json') out.json = true;
    else if (a === '--force' || a === '-f') out.force = true;
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

const HELP = `模型档位切换 + 会话退役重建
用法：node scripts/switch-model.mjs --to minimax|deepseek [选项]

  --to <档位>    目标档位：minimax | deepseek（必填）
  --dry-run      只打印将要改动的内容；不写文件、不杀进程、不发消息
  --only <key>   只处理这一个会话（group:群号 / private:QQ号）——**测试用**；
                 正常使用不要带它，默认切全部会话
  --effort <值>  覆盖档位自带的思考强度策略：auto（默认，用档位策略）|
                 off | minimal | low | medium | high | xhigh | max
                 （填 off 就是「删掉 dsh.reasoningEffort」，让模型用默认）
  --keep-effort  不动 config.json 的 dsh.reasoningEffort（只切 provider/model）
  --force        即使 config.json 已是目标档位，也照样退役重建会话
  --quiet        不发私聊通知
  --json         stdout 只输出 JSON（进度信息走 stderr）
  -h, --help     本帮助

档位常量（含该档位要写的 dsh.reasoningEffort；undefined = 删掉这个键）：
  minimax  -> ${PROFILES.minimax.provider} / ${PROFILES.minimax.model}
              reasoningEffort: ${fmtEffort(PROFILES.minimax.reasoningEffort)}
  deepseek -> ${PROFILES.deepseek.provider} / ${PROFILES.deepseek.model}
              reasoningEffort: ${fmtEffort(PROFILES.deepseek.reasoningEffort)}

原理：改 config.json 后**重启桥接**让它重读配置；会话映射（state/sessions.json）保留不动，
      所以 DSH 侧会话不重建，桥接会在会话下一次活动时对**原会话**就地 selectModel 换模型，
      session id 与上下文都不变。不删映射、不重启 DSH。
      注意：不能只改 config.json 就完事 —— 桥接的 provider/model 只在启动时读入内存，
      运行中改文件它不会同步（POST /api/dsh/effort 只管 reasoningEffort），必须重启才生效。
      --force 保留为兜底：某个会话 selectModel 持续失败时用它退役重建（会清空该会话上下文）。`;

// ── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const human = (msg = '') => (args.json ? process.stderr : process.stdout).write(`${msg}\n`);
  const result = {
    ok: false,
    action: 'none',
    to: null,
    dryRun: args.dryRun,
    only: args.only,
    force: args.force,
    profiles: { minimax: PROFILES.minimax, deepseek: PROFILES.deepseek },
    before: null,
    after: null,
    backups: null,
    retiredKeys: [],
    killedPid: null,
    newPid: null,
    restartMs: null,
    selfCheck: null,
    warnings: [],
    notified: null,
    rollback: [],
    error: null,
    startedAt: new Date().toISOString(),
  };

  if (args.help) {
    human(HELP);
    result.ok = true;
    result.action = 'help';
    return result;
  }
  if (!args.to) throw new Error('缺少 --to minimax|deepseek（--help 看用法）');
  const target = PROFILES[String(args.to).toLowerCase()];
  if (!target) throw new Error(`未知档位「${args.to}」：只支持 ${Object.keys(PROFILES).join(' | ')}`);
  result.to = target.id;

  // ── 读现状 ────────────────────────────────────────────────────────────────
  const cfgDoc = readJsonFile(CONFIG_FILE);
  const cfg = cfgDoc.value;
  if (!cfg.dsh || typeof cfg.dsh !== 'object') throw new Error('config.json 里没有 dsh 配置块');
  let sessionsDoc = { raw: '', value: { sessions: {}, sessionPolicies: {} } };
  try {
    sessionsDoc = readJsonFile(SESSIONS_FILE);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`读不了 state/sessions.json：${error.message}`);
  }
  const sessions = sessionsDoc.value.sessions && typeof sessionsDoc.value.sessions === 'object' ? sessionsDoc.value.sessions : {};
  if (!sessionsDoc.value.sessionPolicies || typeof sessionsDoc.value.sessionPolicies !== 'object') sessionsDoc.value.sessionPolicies = {};

  const currentProvider = String(cfg.dsh.provider ?? '');
  const currentModel = String(cfg.dsh.model ?? '');
  const providerAlready = currentProvider === target.provider && currentModel === target.model;

  // ── 思考强度（reasoningEffort）────────────────────────────────────────────
  // DSH 的 selectModel 总是带 reasoningEffort；填错值会 UNSUPPORTED_REASONING_EFFORT，
  // 会话退回 DSH 默认模型。所以档位切换必须连这个键一起管。
  if (!EFFORT_VALUES.includes(String(args.effort))) {
    throw new Error(`--effort 只支持 ${EFFORT_VALUES.join(' | ')}，收到「${args.effort}」`);
  }
  const currentEffort = Object.prototype.hasOwnProperty.call(cfg.dsh, 'reasoningEffort') ? cfg.dsh.reasoningEffort : undefined;
  const targetEffort = args.keepEffort ? currentEffort : resolveEffortValue(target, args.effort);
  const effortSame = currentEffort === targetEffort;
  // 「已经是该档位」= provider/model/思考强度三者都对得上；只差思考强度不算「已经是」，
  // 否则 config.json 会停在一个已知会失败（或已知不一致）的组合上。
  const already = providerAlready && effortSame;
  const effortSource = args.keepEffort ? '--keep-effort' : (args.effort !== 'auto' ? `--effort ${args.effort}` : '档位策略');

  result.before = {
    provider: currentProvider,
    model: currentModel,
    reasoningEffort: currentEffort === undefined ? null : currentEffort,
    configSha12: sha12(CONFIG_FILE),
    sessionsSha12: sha12(SESSIONS_FILE),
  };

  human('=== 模型档位切换 ===');
  human(`当前档位：${currentProvider || '(空)'} / ${currentModel || '(空)'}（reasoningEffort=${fmtEffort(currentEffort)}）`);
  human(`目标档位：${target.provider} / ${target.model}（${target.label}，reasoningEffort=${fmtEffort(targetEffort)}，来自${effortSource}）`);
  if (target.id === 'minimax' && !args.keepEffort && targetEffort !== undefined && targetEffort !== 'off') {
    human(`ℹ️ minimax 档位写 reasoningEffort="high"：该模型已在 ${'cordis.patch.yml'} 声明 `
      + `reasoningEfforts: [low, high]（MiniMax 直连 API 实测接受该参数）。改完记得重启一次 DSH 生效。`);
  }

  // ── 目标 key ──────────────────────────────────────────────────────────────
  const KEY_RE = /^(group|private):(\d+)$/;
  let targetKeys;
  if (args.only) {
    const only = String(args.only).trim();
    if (!KEY_RE.test(only)) throw new Error(`--only 的 key 格式应为 group:群号 或 private:QQ号，收到「${only}」`);
    const kind = only.startsWith('group:') ? 'group' : 'private';
    const id = Number(only.split(':')[1]);
    const allowList = kind === 'group'
      ? (cfg.allow?.groups ?? []).map(Number)
      : (cfg.allow?.private ?? []).map(Number);
    const mapped = Object.prototype.hasOwnProperty.call(sessions, only);
    if (!mapped && !allowList.includes(id)) {
      throw new Error(`--only ${only} 既不在 config.json 的白名单里、也没有现存会话映射：拒绝静默成功。`
        + `（这是防呆：写错一个 key 不该看起来像成功。）`);
    }
    targetKeys = [only];
    if (!mapped) {
      human(`注意：${only} 当前**没有**会话映射，没有可退役的对象；`);
      human('      config 照改、桥接照重启，它下一条消息会按新档位建新会话。');
    }
  } else {
    targetKeys = Object.keys(sessions);
  }

  // ── 幂等 ──────────────────────────────────────────────────────────────────
  if (already && !args.force) {
    human(`已经是该档位（${target.provider} / ${target.model}，reasoningEffort=${fmtEffort(currentEffort)}），跳过：不备份、不改配置、不杀进程。`);
    human('如需强制重建会话（保留同一档位），请加 --force。');
    if (args.dryRun) human('[dry-run] 真实运行时这里同样会跳过（除非加 --force）。');
    result.action = 'skip-already';
    result.after = {
      provider: currentProvider,
      model: currentModel,
      reasoningEffort: currentEffort === undefined ? null : currentEffort,
      configSha12: sha12(CONFIG_FILE),
      sessionsSha12: sha12(SESSIONS_FILE),
    };
    result.selfCheck = selfCheck(targetKeys, target);
    printSelfCheck(human, result.selfCheck);
    result.warnings = recentModelFailures();
    for (const line of result.warnings) human(`⚠️ 桥接日志里最近的 selectModel 失败：${line}`);
    result.ok = true;
    if (result.selfCheck.staleKeys.length > 0) {
      human(`提示：有 ${result.selfCheck.staleKeys.length} 个会话的账本记录仍是旧档位；要现在就重建它们，请重跑并加 --force。`);
    }
    return result;
  }

  // ── 计划 ──────────────────────────────────────────────────────────────────
  const stamp = stampLocal();
  const configBackup = `${CONFIG_FILE}.bak-switch-${stamp}`;
  const sessionsBackup = `${SESSIONS_FILE}.bak-switch-${stamp}`;
  result.backups = { config: configBackup, sessions: sessionsBackup };
  result.rollback = rollbackCommands(configBackup, sessionsBackup);
  result.retiredKeys = targetKeys;

  const oldPid = readLockPid();
  const oldCmd = oldPid ? commandLineOf(oldPid) : '';

  human('');
  human(`会改的配置行：`);
  human(`  "provider": "${currentProvider}"  ->  "${target.provider}"`);
  human(`  "model": "${currentModel}"  ->  "${target.model}"`);
  human(`  "reasoningEffort": ${fmtEffort(currentEffort)}  ->  ${fmtEffort(targetEffort)}`
    + `${effortSame ? '（已经一致，跳过这步）' : ''}`);
  const mappedCount = targetKeys.filter((k) => Object.prototype.hasOwnProperty.call(sessions, k)).length;
  if (args.force) {
    human(`目标会话 key（${targetKeys.length} 个，--force 会退役其中有映射的 ${mappedCount} 个）：`);
  } else {
    human(`目标会话 key（${targetKeys.length} 个，全部保留映射、就地换模型，上下文不受影响）：`);
  }
  for (const k of targetKeys) {
    const sid = sessions[k];
    human(`  ${k}  ->  ${sid || '(当前无映射，下次发言时新建)'}${sid ? '  [session id 不会变]' : ''}`);
  }
  human(`会备份到：`);
  human(`  ${configBackup}`);
  human(`  ${sessionsBackup}`);
  {
    const pid0 = readLockPid();
    human(`会杀掉的进程：state/bridge.lock = ${pid0 ?? '(无锁文件)'}`
      + `（重启桥接以重读 config.json；${args.force ? '--force 还会先退役映射' : '会话映射保留，上下文不丢'}）`);
  }
  human('不会碰：记忆桶 state/social-v2.json、slang、stickers、patrol-log、src/**、public/**、dsh/**、plugins/**。');

  if (args.dryRun) {
    human('');
    const sameConfig = sha12(CONFIG_FILE) === result.before.configSha12;
    const sameSessions = sha12(SESSIONS_FILE) === result.before.sessionsSha12;
    human(`[dry-run] 未改动任何文件：config.json ${sameConfig ? 'sha256 前 12 位一致' : '已被改动！'}`
      + `（${result.before.configSha12}），sessions.json ${sameSessions ? 'sha256 前 12 位一致' : '已被改动！'}（${result.before.sessionsSha12}）`);
    human(`[dry-run] 未杀进程：bridge.lock 仍是 ${readLockPid() ?? '(无)'}；mtime config=${mtimeText(CONFIG_FILE)} sessions=${mtimeText(SESSIONS_FILE)}`);
    human('[dry-run] 未发送任何私聊消息。');
    result.action = 'dry-run';
    result.effortChange = { from: currentEffort === undefined ? null : currentEffort, to: targetEffort === undefined ? null : targetEffort, applied: false };
    result.after = {
      provider: currentProvider,
      model: currentModel,
      reasoningEffort: currentEffort === undefined ? null : currentEffort,
      configSha12: sha12(CONFIG_FILE),
      sessionsSha12: sha12(SESSIONS_FILE),
    };
    result.killedPid = null;
    result.ok = true;
    return result;
  }

  // ── ① 备份 ────────────────────────────────────────────────────────────────
  let configWritten = false;
  let sessionsWritten = false;
  let killed = false;
  try {
    fs.copyFileSync(CONFIG_FILE, configBackup);
    if (fs.existsSync(SESSIONS_FILE)) fs.copyFileSync(SESSIONS_FILE, sessionsBackup);
    human('');
    human(`① 已备份：${path.basename(configBackup)} / ${path.basename(sessionsBackup)}`);

    // ── ② 改 config（provider/model/思考强度一起改，避免出现「新模型 + 旧强度」的坏组合）──
    cfg.dsh.provider = target.provider;
    cfg.dsh.model = target.model;
    if (!effortSame) {
      if (targetEffort === undefined) delete cfg.dsh.reasoningEffort;
      else cfg.dsh.reasoningEffort = targetEffort;
    }
    writeJsonAtomic(CONFIG_FILE, cfg);
    configWritten = true;
    const check = readJsonFile(CONFIG_FILE).value.dsh;
    if (check.provider !== target.provider || check.model !== target.model) {
      throw new Error('config.json 写入后回读不一致');
    }
    const checkEffort = Object.prototype.hasOwnProperty.call(check, 'reasoningEffort') ? check.reasoningEffort : undefined;
    if (checkEffort !== targetEffort) {
      throw new Error(`config.json 写入后 reasoningEffort 回读不一致：期望 ${fmtEffort(targetEffort)}，实际 ${fmtEffort(checkEffort)}`);
    }
    result.effortChange = {
      from: currentEffort === undefined ? null : currentEffort,
      to: targetEffort === undefined ? null : targetEffort,
      applied: !effortSame,
      source: effortSource,
    };
    human(`② config.json 已改：${check.provider} / ${check.model}，`
      + `reasoningEffort ${fmtEffort(currentEffort)} -> ${fmtEffort(checkEffort)}${effortSame ? '（未变）' : ''}`);

    // ── ③ 保留会话映射（2026-10-11 起不再删） ────────────────────────────────
    // 旧做法是删掉 state/sessions.json 的映射让会话退役重建，代价是所有会话的近期上下文清零。
    // 现在保留映射：DSH 的 selectModel 支持在**既有会话**上换 provider/model，
    // 桥接重启后 modelAppliedSessions 清空，下一次活动就会对原会话就地 selectModel，
    // session id 与上下文都不变（2026-10-12 实测：切换后 session id 未变、模型已换）。
    // --force 仅作为兜底：某个会话的 selectModel 持续失败时用它退役重建。
    let removed = 0;
    if (args.force) {
      for (const k of targetKeys) {
        if (Object.prototype.hasOwnProperty.call(sessions, k)) {
          delete sessions[k];
          removed += 1;
        }
        if (Object.prototype.hasOwnProperty.call(sessionsDoc.value.sessionPolicies, k)) delete sessionsDoc.value.sessionPolicies[k];
      }
      writeJsonAtomic(SESSIONS_FILE, sessionsDoc.value);
      sessionsWritten = true;
      human(`③ --force：已删 ${removed} 个会话映射，这些会话下次发言时重建（上下文会清空）。`);
    } else {
      human(`③ 保留全部会话映射：切模型将就地生效，session id 与上下文都不变。`);
      human('   （需要强制重建时才用 --force —— 例如某会话 selectModel 持续失败。）');
    }

    // ── ④ 重启桥接，让它重新读 config.json ────────────────────────────────────
    // 为什么必须重启：桥接的 cfg.dsh.provider / cfg.dsh.model 只在**启动时**从 config.json 读入，
    // 之后不会再同步。POST /api/dsh/effort 只把 reasoningEffort 写进内存并递增 modelSelectionEpoch，
    // 它**不碰 provider/model** ⇒ 只改 config.json + 递增 epoch 的话，桥接仍会拿内存里的旧档位去
    // selectModel（2026-10-12 实测：config 已是 minimax，日志里却仍写 deepseek）。
    // 重启只清内存态，state/sessions.json 的映射不动 ⇒ 会话不重建、上下文不丢。
    const pid = readLockPid();
    if (!pid) {
      human('④ state/bridge.lock 里没有 PID（桥接可能正在重启）：跳过杀进程，直接等新进程就绪。');
    } else {
      const cmd = commandLineOf(pid);
      if (!looksLikeBridge(cmd)) {
        throw new Error(`state/bridge.lock 里的 PID ${pid} 看起来不是桥接进程（命令行：${cmd || '(取不到)'}）：拒绝盲杀。`);
      }
      if (!killPid(pid)) throw new Error(`杀进程 ${pid} 失败`);
      killed = true;
      result.killedPid = pid;
      human(`④ 已杀桥接 PID ${pid}，等待守护拉起（它会重新读 config.json）…（最多 ${RESTART_TIMEOUT_MS / 1000}s）`);
    }
    const t0 = Date.now();
    const restarted = await waitForRestart(pid, (msg) => human(msg));
    result.newPid = restarted.pid;
    result.restartMs = Date.now() - t0;
    human(`   新桥接 PID ${restarted.pid}（用了 ${(result.restartMs / 1000).toFixed(1)}s，控制台 ${restarted.consoleOk ? '就绪' : '暂未就绪'}）`);
    human('   各会话会在下一次活动时就地换到新档位，session id 与上下文保持不变。');


    // ── ⑤ 自检 ───────────────────────────────────────────────────────────────
    result.selfCheck = selfCheck(targetKeys, target);
    printSelfCheck(human, result.selfCheck);
    result.warnings = recentModelFailures();
    for (const line of result.warnings) {
      human(`⚠️ 桥接日志里最近的 selectModel 失败：${line}`);
    }
    if (result.warnings.length) {
      human('   （先看日志里的具体值：会话会因为目标 model 不支持那个 reasoningEffort 而退回 DSH 默认模型，'
        + `不会按 config 套上目标档位。本脚本这次把 dsh.reasoningEffort 写成 ${fmtEffort(targetEffort)}。`
        + '注意：桥接自己还有一份回退值 —— config.json 里没有这个键时它会用自己的默认 \'max\'，'
        + '所以「删掉这个键」并不等于「不发思考参数」。详见 scripts/README-switch-model.md 的「已知问题 4.1」。）');
    }
  } catch (error) {
    result.error = error?.message ?? String(error);
    human(`\n✗ 失败：${result.error}`);
    if (!killed) {
      // 还没杀进程：把两个文件还原回备份，避免留下半截状态。
      const restored = [];
      try {
        if (configWritten && fs.existsSync(configBackup)) { fs.copyFileSync(configBackup, CONFIG_FILE); restored.push('config.json'); }
        if (sessionsWritten && fs.existsSync(sessionsBackup)) { fs.copyFileSync(sessionsBackup, SESSIONS_FILE); restored.push('sessions.json'); }
      } catch (e) {
        human(`  （自动还原时又出错：${e?.message ?? e}）`);
      }
      if (restored.length) human(`  已自动还原：${restored.join(' / ')}`);
    } else {
      human('  注意：桥接已经被杀掉，新进程会按**新**配置起来；要退回去请按下面的命令还原文件，再杀一次桥接 PID 让它按旧配置重建。');
    }
    human('回滚命令（把两个文件还原成切换前的样子）：');
    for (const line of result.rollback) human(`  ${line}`);
    result.after = {
      provider: readConfigField('provider'),
      model: readConfigField('model'),
      reasoningEffort: readConfigField('reasoningEffort', true),
      configSha12: sha12(CONFIG_FILE),
      sessionsSha12: sha12(SESSIONS_FILE),
    };
    return result;
  }

  result.after = {
    provider: readConfigField('provider'),
    model: readConfigField('model'),
    reasoningEffort: readConfigField('reasoningEffort', true),
    configSha12: sha12(CONFIG_FILE),
    sessionsSha12: sha12(SESSIONS_FILE),
  };
  result.action = providerAlready ? 'rebuild-forced' : 'switched';
  result.ok = true;

  // ── ⑥ 通知主人 ────────────────────────────────────────────────────────────
  if (args.quiet) {
    human('\n⑥ --quiet：跳过私聊通知。');
    result.notified = { skipped: true };
  } else {
    const sc = result.selfCheck;
    const effortNote = result.effortChange && result.effortChange.applied
      ? `同时把 dsh.reasoningEffort 改成了 ${result.effortChange.to === null ? '「删掉」（模型用自己的默认）' : `"${result.effortChange.to}"`}。`
      : '';
    const text = `模型档位已切到 ${target.label}（${target.provider} / ${target.model}）。${effortNote}`
      + `这次退役重建了 ${targetKeys.length} 个会话，它们下一条消息会按新档位建新会话，上下文从零开始；记忆桶没动。`
      + `要切回去就双击『${target.otherBat}』。`
      + (sc && sc.staleKeys.length ? `（自检：${sc.staleKeys.length} 个会话账本上还是旧档位，属正常，等它们的下一条消息。）` : '');
    try {
      const sent = await notifyOwner(text);
      result.notified = sent;
      human(`\n⑥ 私聊通知：${sent.ok ? `已发送（message_id ${sent.messageId}）` : `发送失败：${sent.error}`}`);
    } catch (error) {
      result.notified = { ok: false, error: error?.message ?? String(error) };
      human(`\n⑥ 私聊通知失败：${result.notified.error}（切换本身已完成，不影响档位）`);
    }
  }
  return result;
}

/** 读 config.json 的 dsh.<field>；own=true 时区分「没有这个键」（返回 null）与「值就是 null」。 */
function readConfigField(field, own = false) {
  try {
    const dsh = readJsonFile(CONFIG_FILE).value.dsh ?? {};
    if (own) return Object.prototype.hasOwnProperty.call(dsh, field) ? dsh[field] : null;
    return String(dsh[field] ?? '');
  } catch {
    return own ? null : '';
  }
}

function rollbackCommands(configBackup, sessionsBackup) {
  return [
    `copy /Y "${configBackup}" "${CONFIG_FILE}"`,
    `copy /Y "${sessionsBackup}" "${SESSIONS_FILE}"`,
    '（还原后如要立刻生效：杀掉 state\\bridge.lock 里的 PID，守护会按还原后的配置重建桥接）',
  ];
}

/** 等守护拉起的桥接：锁文件里出现新 PID 且进程活着，再确认控制台能应答。 */
async function waitForRestart(oldPid, human) {
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  let lastSeen = null;
  while (Date.now() < deadline) {
    await sleep(1000);
    const pid = readLockPid();
    if (pid && pid !== oldPid && pidAlive(pid)) {
      lastSeen = pid;
      const consoleOk = await consoleReady();
      if (consoleOk) return { pid, consoleOk: true };
    }
  }
  if (lastSeen) return { pid: lastSeen, consoleOk: false };
  throw new Error(`等待桥接重启超时（${RESTART_TIMEOUT_MS / 1000}s）：state/bridge.lock 里没有出现新 PID（当前 ${readLockPid() ?? '无'}）。守护窗口（start.bat）是不是没在跑？`);
}

/**
 * 已废弃：曾用 POST /api/dsh/effort 递增 modelSelectionEpoch 来「不重启就换档」。
 *
 * 2026-10-12 实测确认这条路走不通：该端点只把 reasoningEffort 写进 cfg 内存并递增 epoch，
 * **不碰 provider/model**（它们只在桥接启动时从 config.json 读入）。于是 config.json 已改成
 * minimax，桥接仍拿内存里的 deepseek 去 selectModel —— 日志会看到「已设置会话模型 … -> deepseek」，
 * 表现就是「切不动」。现在改为重启桥接（映射保留，上下文不丢）。
 */

async function consoleReady() {
  try {
    const cfg = readJsonFile(CONFIG_FILE).value;
    const port = Number(cfg.consolePort) || 3100;
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { 'x-console-token': String(cfg.consoleToken ?? '') },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 自检：读 state/token-usage.jsonl，取每个 key 最近一条带 provider/model 的记录。
 * 说明：刚退役完的 key 在下一条消息到来前，账本上仍是**旧**记录 —— 这是正常的，
 * 此时结论是「等新消息」。出现 provider/model 等于目标档位才算「已切换」。
 */
function selfCheck(targetKeys, target) {
  const last = new Map();
  try {
    const raw = fs.readFileSync(LEDGER_FILE, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec.key || (!rec.provider && !rec.model)) continue;
      last.set(rec.key, { t: rec.t, sid: rec.sid, provider: rec.provider, model: rec.model });
    }
  } catch {
    return { ledgerReadable: false, rows: [], switchedKeys: [], staleKeys: [], unknownKeys: [...targetKeys] };
  }
  const rows = [];
  const switchedKeys = [];
  const staleKeys = [];
  const unknownKeys = [];
  for (const key of targetKeys) {
    const rec = last.get(key);
    let verdict;
    if (!rec) verdict = '无记录（等它的下一条消息）';
    else if (rec.provider === target.provider && rec.model === target.model) { verdict = '已切换'; switchedKeys.push(key); }
    else { verdict = '仍是旧档位（等它的下一条消息）'; staleKeys.push(key); }
    if (!rec) unknownKeys.push(key);
    rows.push({
      key,
      when: rec?.t ? new Date(rec.t).toISOString() : null,
      sid: rec?.sid ?? sessionsSidOf(key),
      provider: rec?.provider ?? null,
      model: rec?.model ?? null,
      verdict,
    });
  }
  return { ledgerReadable: true, rows, switchedKeys, staleKeys, unknownKeys };
}

function sessionsSidOf(key) {
  try {
    return readJsonFile(SESSIONS_FILE).value.sessions?.[key] ?? null;
  } catch {
    return null;
  }
}

/**
 * 扫 bridge.log 尾部，找最近（默认 10 分钟内）的「设置会话模型失败」。
 *
 * 为什么值得做：DSH 的 selectModel 会因为「这个 model 不支持当前 reasoningEffort」失败，
 * 而这时会话**照样建出来了**——它退回 DSH 的会话默认模型。若默认模型恰好等于目标档位，
 * 账本看起来是对的（本机就是这种情况），但这是巧合，不可依赖。把日志里的失败直接摆出来，
 * 比让人以为「切换成功了」诚实。
 */
function recentModelFailures(withinMs = 10 * 60 * 1000) {
  try {
    const raw = fs.readFileSync(path.join(STATE_DIR, 'bridge.log'), 'utf8');
    const lines = raw.split(/\r?\n/).slice(-400);
    const now = new Date();
    const out = [];
    for (const line of lines) {
      if (!line.includes('设置会话模型失败')) continue;
      const m = /^(\d{2}):(\d{2}):(\d{2})\s/.exec(line);
      if (!m) continue;
      const when = new Date(now);
      when.setHours(Number(m[1]), Number(m[2]), Number(m[3]), 0);
      if (now.getTime() - when.getTime() > withinMs) continue;
      out.push(line.trim());
    }
    return out.slice(-3);
  } catch {
    return [];
  }
}

function printSelfCheck(human, sc) {
  human('');
  human('⑤ 自检（state/token-usage.jsonl 里每个 key 最近一次实际使用的档位）：');
  if (!sc.ledgerReadable) {
    human('  读不了 state/token-usage.jsonl —— 跳过自检。');
    return;
  }
  if (sc.rows.length === 0) {
    human('  （本次没有目标 key）');
    return;
  }
  human('  key                          最近记录(UTC)            provider/model                          结论');
  for (const r of sc.rows) {
    const pm = `${r.provider ?? '-'} / ${r.model ?? '-'}`;
    human(`  ${String(r.key).padEnd(28)} ${String(r.when ?? '-').padEnd(22)} ${pm.padEnd(40)} ${r.verdict}`);
  }
  human(`  汇总：已切换 ${sc.switchedKeys.length} / 仍是旧档位 ${sc.staleKeys.length} / 无记录 ${sc.unknownKeys.length}`);
}

/**
 * 私聊通知。
 *
 * 通道：控制台 POST /api/test-send（只需要 x-console-token）。
 * 为什么不用 /api/socialV2/send-message：那个端点即使在控制台令牌下也强制要求
 * x-agent-token（bridge.js：「reserved2 模式发送必须携带 agent token」→ 无令牌 403），
 * 而本脚本是独立运维脚本，不该持有会话令牌。见 README 的「通知通道」一节。
 */
async function notifyOwner(text) {
  const cfg = readJsonFile(CONFIG_FILE).value;
  const port = Number(cfg.consolePort) || 3100;
  const owner = Number(cfg.ownerQQ);
  const token = String(cfg.consoleToken ?? '');
  if (!Number.isFinite(owner) || owner <= 0) throw new Error('config.json 里没有可用的 ownerQQ');
  if (!token) throw new Error('config.json 里没有 consoleToken，无法走控制台发送');
  const res = await fetch(`http://127.0.0.1:${port}/api/test-send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify({ kind: 'private', id: owner, message: text }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {}
  if (res.ok && parsed?.ok === true) return { ok: true, status: res.status, messageId: parsed.message_id ?? null, text };
  return { ok: false, status: res.status, error: parsed?.error ?? body.slice(0, 300), text };
}

// ── 入口 ─────────────────────────────────────────────────────────────────────
const jsonRequested = () => process.argv.includes('--json');

let result;
let failed = false;
try {
  result = await main();
  if (!result.ok) failed = true;
} catch (error) {
  const json = jsonRequested();
  const human = (msg = '') => (json ? process.stderr : process.stdout).write(`${msg}\n`);
  human(`\n✗ 失败：${error?.message ?? error}`);
  human('（本次没有改动 config.json / state/sessions.json，也没有杀进程；--help 看用法）');
  result = { ok: false, action: 'error', error: error?.message ?? String(error) };
  failed = true;
}
if (failed) process.exitCode = 1;
if (jsonRequested()) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
