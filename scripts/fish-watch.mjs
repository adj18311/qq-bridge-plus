#!/usr/bin/env node
/**
 * 鱼塘（卧底游戏）盯梢 —— 适配本项目的版本。
 *
 * 原脚本是桌面上一个独立文件，靠 `POST /receive` 把话塞进会话。本项目没有 `/receive`，
 * 真正能把提示词投进 DSH 会话的管理端入口是 `POST /api/console/notify-ai`
 * （src/bridge.js:9008，需 x-console-token，走「后台控制端提醒」分支、silent 投递）。
 * 这个脚本就是把它接上，并补齐原来没有的东西：
 *
 *   · 目标会话不用手填 —— 没给 --key 就按白名单第一个群 / owner 私聊自动挑（pickDefaultFishKey）；
 *   · 令牌不用贴命令行 —— 默认读 config.json 的 consoleToken，缺失时读 state/console-token；
 *   · 去重可持久化 —— --persist 把「叫过哪些轮」落到 state/，重启不会重复叫；
 *   · 每条叫醒都打印真实 HTTP 状态，失败不再静默。
 *
 * 用法：
 *   node scripts/fish-watch.mjs --room=<房间号> --player=<player_id> [选项]
 *
 * 选项（除 --room/--player 外都可选）：
 *   --name=鲸鲸          你在游戏里的昵称（服务端只给 turn_name 时靠它判断轮次）
 *   --key=group:123456   叫醒目标；默认自动挑
 *   --base=<url>         站点根地址；默认 FISH_DEFAULT_BASE
 *   --interval=8         轮询间隔秒（≥4）
 *   --minutes=40         最多盯多久（≤240）
 *   --token=xxx          覆盖控制台令牌
 *   --bridge=<url>       覆盖桥接根地址（默认 http://127.0.0.1:<consolePort>）
 *   --persist            去重键落盘到 state/fish-watch-<room>.json
 *   --once               只查一次状态并打印判定结果（不循环，失败不重试）
 *   --dry-run            正常轮询但只打印「本来会叫」，不真的投递
 *   --doctor             自检：桥接可达性 + 站点可达性 + 目标是否在白名单
 *
 * 退出码：0 正常（含「这局已结束」）/ 1 自检发现问题 / 2 参数或环境不成立。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parseFishWatchArgs,
  pickDefaultFishKey,
  deriveFishWatchEvents,
  fishStateUrl,
  FISH_DEFAULT_BASE,
} from '../src/core/fish-watch-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(ROOT, 'state');

const 中文时间 = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

const 用法 = [
  '用法：node scripts/fish-watch.mjs --room=<房间号> --player=<player_id> [选项]',
  '',
  '  --name=鲸鲸          你在游戏里的昵称（服务端只给 turn_name 时靠它判断轮次）',
  '  --key=group:123456   叫醒目标；默认按白名单第一个群 / owner 私聊自动挑',
  `  --base=<url>         站点根地址；默认 ${FISH_DEFAULT_BASE}`,
  '  --interval=8         轮询间隔秒（≥4）',
  '  --minutes=40         最多盯多久分钟（≤240）',
  '  --token=xxx          覆盖控制台令牌',
  '  --bridge=<url>       覆盖桥接根地址（默认 http://127.0.0.1:<consolePort>）',
  '  --persist            去重键落盘到 state/fish-watch-<room>.json',
  '  --once               只查一次状态并打印判定结果（不循环，失败不重试）',
  '  --dry-run            正常轮询但只打印「本来会叫」，不真的投递',
  '  --doctor             自检：桥接可达性 + 站点可达性 + 目标是否在白名单',
  '  --help               显示这段说明',
].join('\n');

/** 读 config.json，读不到就返回 {}（脚本要能在「还没配好」的状态下给出可读报错）。 */
function 读配置() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** 控制台令牌：config.consoleToken 优先，其次 state/console-token（bridge 自动生成的那个）。 */
function 取控制台令牌(cfg, override) {
  if (override) return override;
  const configured = String(cfg?.consoleToken ?? '').trim();
  if (configured) return configured;
  try {
    return fs.readFileSync(path.join(STATE_DIR, 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function 去重文件(config) {
  return path.join(STATE_DIR, `fish-watch-${config.room}.json`);
}

function 读去重键(config) {
  if (!config.persist) return new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(去重文件(config), 'utf8'));
    return new Set(Array.isArray(raw?.called) ? raw.called.map(String) : []);
  } catch {
    return new Set();
  }
}

function 存去重键(config, already, logError) {
  if (!config.persist) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const payload = { room: config.room, player: config.player, called: [...already], savedAt: Date.now() };
    const target = 去重文件(config);
    const temp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2));
    fs.renameSync(temp, target);
  } catch (error) {
    logError('去重键落盘失败（不影响本次运行）：', error?.message ?? error);
  }
}

/** 带超时的请求：对端隧道经常是「连上了但不回」，没有超时会挂在这里一小时。 */
async function 请求(fetchImpl, url, init = {}, timeoutMs = 10000) {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** 投递一句话到 DSH 会话（失败必须如实返回，调用方据此决定要不要留着重试）。 */
async function 叫醒桥接({ fetchImpl, bridge, token, key, text, dryRun, log, logError }) {
  if (dryRun) {
    log(`[dry-run] 本来要投给 ${key}：${text}`);
    return { ok: true, dryRun: true };
  }
  const url = `${bridge}/api/console/notify-ai`;
  try {
    const response = await 请求(fetchImpl, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: JSON.stringify({ key, message: text }),
    }, 30000);
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      const detail = body?.error ?? `HTTP ${response.status}`;
      logError(`投递失败 → ${key}：${detail}`);
      return { ok: false, error: detail, status: response.status };
    }
    log(`已叫醒 ${key}：${text}`);
    return { ok: true, sessionId: body?.sessionId ?? null };
  } catch (error) {
    logError(`投递异常 → ${key}：${error?.message ?? error}`);
    return { ok: false, error: String(error?.message ?? error) };
  }
}

async function 抓状态(fetchImpl, config) {
  const url = fishStateUrl({ base: config.base, room: config.room, player: config.player });
  const response = await 请求(fetchImpl, url, { headers: { accept: 'application/json' } }, 10000);
  if (response.status === 404) return { ended: true, reason: '房间不存在（404）' };
  if (!response.ok) return { retry: true, reason: `HTTP ${response.status}` };
  const state = await response.json().catch(() => null);
  if (!state || typeof state !== 'object') return { retry: true, reason: '响应不是 JSON 状态' };
  return { state };
}

async function 自检({ fetchImpl, config, bridge, token, key, log, logError }) {
  let 有问题 = false;

  let status = null;
  try {
    const response = await 请求(fetchImpl, `${bridge}/api/status`, { headers: { 'x-console-token': token } }, 8000);
    if (response.ok) {
      status = await response.json().catch(() => ({}));
      log(`桥接 OK：mode=${status?.mode} dshReady=${status?.dshReady} role=${status?.role} ownerQQ=${status?.ownerQQ}`);
      if (status?.dshReady === false) { logError('桥接在跑但 DSH 未就绪：notify-ai 会回 503'); 有问题 = true; }
    } else {
      logError(`桥接 /api/status 返回 HTTP ${response.status}${response.status === 401 ? '（控制台令牌不对）' : ''}`);
      有问题 = true;
    }
  } catch (error) {
    logError(`连不上桥接 ${bridge}：${error?.message ?? error}`);
    有问题 = true;
  }

  try {
    const response = await 请求(fetchImpl, fishStateUrl({ base: config.base, room: config.room, player: config.player }), {}, 10000);
    log(`站点 ${config.base} → HTTP ${response.status}`);
    if (response.status === 404) { logError('房间不存在：--room 或 --player 写错了，或这局已经结束'); 有问题 = true; }
  } catch (error) {
    logError(`连不上站点 ${config.base}：${error?.message ?? error}`);
    if (config.base === FISH_DEFAULT_BASE) {
      logError('这是原脚本里的 trycloudflare 隧道，早就可能失效了 —— 请确认当前的真实地址并用 --base 覆盖');
    }
    有问题 = true;
  }

  if (status) {
    const allowGroups = (status?.allowGroups ?? []).map(String);
    const allowPrivate = (status?.allowPrivate ?? []).map(String);
    const kind = key.startsWith('group:') ? 'group' : 'private';
    const id = key.slice(key.indexOf(':') + 1);
    const inList = kind === 'group' ? allowGroups.includes(id) : allowPrivate.includes(id);
    if (!inList) {
      logError(`目标 ${key} 不在白名单（${kind === 'group' ? allowGroups.join(',') : allowPrivate.join(',')}）：notify-ai 会回 403`);
      有问题 = true;
    } else {
      log(`目标会话 ${key} 在白名单内`);
    }
    if (status?.mode !== 'reserved2') { logError(`当前模式是 ${status?.mode}，二代仿真接口只在 reserved2 下可用`); 有问题 = true; }
    if (status?.socialV2Paused) { logError('二代 AI 处于暂停状态：投递会被拒'); 有问题 = true; }
  }

  return 有问题 ? 1 : 0;
}

/**
 * 主流程（可注入 argv / fetch / 日志，便于回归测试；CLI 入口在文件末尾）。
 *
 * @returns {Promise<number>} 退出码
 */
export async function runFishWatch({
  argv = process.argv.slice(2),
  fetchImpl = globalThis.fetch,
  log = (...parts) => console.log(`[${中文时间()}]`, ...parts),
  logError = (...parts) => console.error(`[${中文时间()}]`, ...parts),
  print = (...parts) => console.log(...parts),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  readConfig = 读配置,
  readToken = 取控制台令牌,
  now = () => Date.now(),
} = {}) {
  const parsed = parseFishWatchArgs(argv);
  // --help 优先于一切校验：用户想看说明时不该先被「缺 --room」教育一顿。
  if (argv.includes('--help') || argv.includes('-h')) {
    print(用法);
    return 0;
  }
  for (const warning of parsed.warnings) logError(`提示：${warning}`);
  if (!parsed.ok) {
    for (const error of parsed.errors) logError(`参数错误：${error}`);
    logError(用法);
    return 2;
  }

  const config = parsed.config;
  const cfg = readConfig();
  const bridge = config.bridge || `http://127.0.0.1:${Number(cfg?.consolePort) || 3100}`;
  const token = readToken(cfg, config.token);
  if (!token) {
    logError('拿不到控制台令牌：config.json 没有 consoleToken，state/console-token 也读不到');
    return 2;
  }

  let key = config.key;
  if (!key) {
    const picked = pickDefaultFishKey({
      allowGroups: cfg?.allow?.groups,
      allowPrivate: cfg?.allow?.private,
      ownerQQ: cfg?.ownerQQ,
    });
    if (!picked.key) {
      logError('没有可用的默认会话：config.json 的 allow.groups / allow.private 都是空的，请用 --key=group:<群号> 指定');
      return 2;
    }
    key = picked.key;
    log(`未指定 --key，自动选中 ${key}（${picked.reason}）`);
  }

  if (config.doctor) {
    return await 自检({ fetchImpl, config, bridge, token, key, log, logError });
  }

  const already = 读去重键(config);
  log(`开始盯：房间 ${config.room} / 玩家 ${config.name || config.player} / 每 ${config.intervalSeconds} 秒 / 最多 ${config.minutes} 分钟`);
  log(`站点 ${config.base} → 桥接 ${bridge} → 目标 ${key}${config.dryRun ? '（dry-run，不投递）' : ''}${config.persist ? '（去重键落盘）' : ''}`);

  // 用注入的时钟算截止时间：测试把 sleep 换成空实现时，Date.now() 不会前进，
  // 依赖真实时间会让「永不结束的局」变成死循环（曾经直接把 node 跑到 OOM）。
  const deadline = now() + config.minutes * 60 * 1000;
  let cycles = 0;

  // 硬护栏：即便时钟不前进，也不能无限轮询。达到上限就收工并如实报告。
  // 注意 maxCycles 只防死循环，正常退出仍由 deadline 决定。
  const maxCycles = Math.max(1, Math.ceil((config.minutes * 60 * 1000) / config.intervalMs) + 8);

  while (config.once || now() < deadline) {
    if (cycles >= maxCycles) {
      logError(`已轮询 ${cycles} 次达到上限，提前收工（检查 --interval/--minutes 或系统时间）`);
      break;
    }
    cycles += 1;
    let result = null;
    try {
      result = await 抓状态(fetchImpl, config);
    } catch (error) {
      logError(`[${cycles}] 抓取失败：${error?.message ?? error}${config.once ? '' : '，5 秒后重试'}`);
    }

    if (result?.ended) {
      log(`[${cycles}] ${result.reason}，收工`);
      break;
    }
    if (!result) {
      // 抛了异常（DNS/TLS/超时）：--once 的语义是「查一次就报结果」，直接收尾；否则重试。
      if (config.once) break;
      await sleep(5000);
      continue;
    }
    if (result.retry) {
      logError(`[${cycles}] ${result.reason}，5 秒后重试`);
      if (config.once) break;
      await sleep(5000);
      continue;
    }

    const derived = deriveFishWatchEvents({
      state: result.state,
      playerId: config.player,
      playerName: config.name,
      room: config.room,
      already,
    });

    for (let i = 0; i < derived.events.length; i += 1) {
      const text = derived.events[i];
      const dedupeId = derived.ids?.[i] ?? '';
      const sent = await 叫醒桥接({ fetchImpl, bridge, token, key, text, dryRun: config.dryRun, log, logError });
      // 只有真投递成功（或 dry-run）才算叫过：失败必须留着下次重试，否则漏一轮就直接输。
      if (sent.ok && dedupeId) {
        already.add(dedupeId);
        存去重键(config, already, logError);
      }
    }

    if (config.once) {
      log(`[once] phase=${derived.phase} round=${derived.round} 判定=${derived.reason}`
        + (derived.events.length ? ` 事件=${derived.events.length}` : '（这一轮不用叫）'));
      break;
    }

    if (cycles % 15 === 0) log(`[${cycles}] 还在盯：phase=${derived.phase} round=${derived.round}`);

    await sleep(config.intervalMs);
  }

  if (config.persist) 存去重键(config, already, logError);
  log('收工');
  return 0;
}

const 直接运行 = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
})();

if (直接运行) {
  runFishWatch().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`[${中文时间()}]`, '未捕获异常：', error?.stack ?? error);
    process.exitCode = 1;
  });
}
