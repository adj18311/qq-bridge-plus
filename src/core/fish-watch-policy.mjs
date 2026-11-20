/**
 * 鱼塘（卧底游戏）盯梢的纯策略层：参数解析 + 事件派生 + 默认目标解析。
 *
 * 背景：原本这是一个散落在桌面上的独立脚本，靠「每 8 秒抓一次 /web/state，只在
 * 轮到我说话 / 该投票 / 结束了时叫一次」把模型从沉睡里叫醒，从而避免每回合重放
 * 全量 context（实测单次唤醒 input 约 6.7 万~15 万 token）。要接进本项目，必须把
 * 两件容易出错的事从 IO 里拆出来单独锁定：
 *
 *   1) **什么时候该叫**（deriveFishWatchEvents）—— 叫早了白花钱，叫漏了直接漏轮；
 *   2) **参数怎么解**（parseFishWatchArgs）—— 缺 --room/--player 必须当场报错，
 *      间隔/时长要钳到安全区，否则一个手滑的 --interval=0 就是死循环打满桥接。
 *
 * 本模块是纯函数：不读配置、不做网络、不落盘、不注册定时器，便于单测与复用。
 */

/** 默认站点：原脚本里那条 trycloudflare 隧道，随时可能失效，所以必须可覆盖。 */
export const FISH_DEFAULT_BASE = 'https://fifteen-cooler-cheap-vault.trycloudflare.com';

/** 轮询间隔下限：再快也没有意义（服务端状态不是毫秒级变化的），只会打满对端。 */
export const FISH_MIN_INTERVAL_SECONDS = 4;
export const FISH_DEFAULT_INTERVAL_SECONDS = 8;

/** 单次盯梢时长上限：默认 40 分钟，防止忘了关的常驻进程。 */
export const FISH_DEFAULT_MINUTES = 40;
export const FISH_MAX_MINUTES = 240;

/**
 * 解析 `--k=v` / `--k v` 两种写法的参数表。
 *
 * 只做「拆键值」这一件事：不做类型转换、不认别名、不报错。
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{ flags: Record<string, string>, unknown: string[] }}
 */
export function parseFishWatchFlags(argv) {
  const flags = Object.create(null);
  const unknown = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const raw = String(list[i] ?? '');
    const match = /^--([^=]+)(?:=(.*))?$/.exec(raw);
    if (!match) { unknown.push(raw); continue; }
    const name = match[1];
    if (match[2] !== undefined) { flags[name] = match[2]; continue; }
    // `--persist` 这类布尔开关：下一个 token 是另一个 --flag 或已到末尾时视为空串。
    const next = list[i + 1];
    if (next !== undefined && !String(next).startsWith('--')) {
      flags[name] = String(next);
      i += 1;
    } else {
      flags[name] = '';
    }
  }
  return { flags, unknown };
}

/** 布尔开关：只要出现过就算 true（`--dry-run` / `--dry-run=1` / `--dry-run=false` 都按出现算，除了显式 0/false）。 */
function flagOn(flags, name) {
  if (!(name in flags)) return false;
  const value = String(flags[name] ?? '').trim().toLowerCase();
  if (value === '') return true;
  return !(value === '0' || value === 'false' || value === 'no' || value === 'off');
}

function clampInt(value, { min, max, fallback }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < min) return min;
  if (Number.isFinite(max) && rounded > max) return max;
  return rounded;
}

/**
 * 解析并校验命令行参数。
 *
 * 返回 `{ ok, errors, warnings, config }`：`ok=false` 时调用方必须直接退出（exit 2），
 * 绝不能带着半个配置去轮询——那会变成「每 8 秒打一次桥接、每次都 400」。
 *
 * @param {string[]} argv process.argv.slice(2)
 * @param {{ now?: number }} [options]
 */
export function parseFishWatchArgs(argv, options = {}) {
  const { flags, unknown } = parseFishWatchFlags(argv);
  const errors = [];
  const warnings = [];

  const room = String(flags.room ?? '').trim();
  const player = String(flags.player ?? '').trim();
  if (!room) errors.push('缺 --room=<房间号>');
  if (!player) errors.push('缺 --player=<player_id>');

  const name = String(flags.name ?? '').trim();
  if (!name) {
    warnings.push('未给 --name：只能靠 turn_id 判断「轮到我」，若服务端不返回 turn_id 就会漏轮');
  }

  const base = String(flags.base ?? FISH_DEFAULT_BASE).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) errors.push(`--base 必须是 http(s) 地址，收到 ${base || '(空)'}`);

  const intervalSeconds = clampInt(flags.interval, {
    min: FISH_MIN_INTERVAL_SECONDS,
    max: 600,
    fallback: FISH_DEFAULT_INTERVAL_SECONDS,
  });
  const minutes = clampInt(flags.minutes, { min: 1, max: FISH_MAX_MINUTES, fallback: FISH_DEFAULT_MINUTES });

  // `--key` 允许 group:<群号> / private:<QQ号>；格式错必须当场拒，不能等到 POST 才 400。
  const key = String(flags.key ?? '').trim();
  if (key && !/^(group|private):\d+$/.test(key)) {
    errors.push(`--key 格式应为 group:<群号> 或 private:<QQ号>，收到 ${key}`);
  }

  for (const item of unknown) {
    if (item) warnings.push(`忽略无法识别的参数 ${item}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    config: {
      room,
      player,
      name,
      base,
      token: String(flags.token ?? '').trim(),
      bridge: String(flags.bridge ?? '').trim(),
      key,
      intervalMs: intervalSeconds * 1000,
      minutes,
      intervalSeconds,
      dryRun: flagOn(flags, 'dry-run'),
      once: flagOn(flags, 'once'),
      doctor: flagOn(flags, 'doctor'),
      persist: flagOn(flags, 'persist'),
      startedAt: Number(options.now) || Date.now(),
    },
  };
}

/**
 * 在没给 `--key` 时挑一个默认目标会话。
 *
 * 优先级：白名单第一个群 → owner 私聊。都没有就返回 ''（调用方报错退出）。
 * 之所以不猜「随便一个会话」：notify-ai 会真的把提示词投进 DSH 会话并消耗一次
 * 模型回合，猜错的目标要么 403、要么把一个无关会话叫醒。
 *
 * @param {{ allowGroups?: string[], allowPrivate?: string[], ownerQQ?: string|number }} input
 * @returns {{ key: string, reason: string }}
 */
export function pickDefaultFishKey(input = {}) {
  const groups = Array.isArray(input.allowGroups) ? input.allowGroups.map((v) => String(v).trim()).filter(Boolean) : [];
  if (groups.length > 0) return { key: `group:${groups[0]}`, reason: '白名单第一个群' };
  const privates = Array.isArray(input.allowPrivate) ? input.allowPrivate.map((v) => String(v).trim()).filter(Boolean) : [];
  if (privates.length > 0) return { key: `private:${privates[0]}`, reason: '白名单第一个私聊' };
  const owner = String(input.ownerQQ ?? '').trim();
  if (/^\d+$/.test(owner)) return { key: `private:${owner}`, reason: 'ownerQQ' };
  return { key: '', reason: '无可用目标' };
}

/**
 * 从一份 `/web/state` 响应里派生「这次该不该叫醒模型」。
 *
 * 返回 `{ action, reason, events }`：
 *   · action='stop'：本局结束 / 房间不存在，调用方应退出循环；
 *   · action='continue'：继续轮询；
 *   · events：需要投递的文本数组（可能为空 —— 空就是「这一轮不花钱」的本意）。
 *
 * @param {object} input
 * @param {any} input.state `/web/state` 的 JSON
 * @param {string|number} input.playerId
 * @param {string} [input.playerName]
 * @param {string} [input.room] 仅用于文案
 * @param {Set<string>|string[]} [input.already] 已经叫过的去重键
 */
export function deriveFishWatchEvents(input = {}) {
  const state = input.state;
  const playerId = String(input.playerId ?? '').trim();
  const playerName = String(input.playerName ?? '').trim();
  const room = String(input.room ?? '').trim();
  const already = input.already instanceof Set
    ? input.already
    : new Set(Array.isArray(input.already) ? input.already.map(String) : []);

  if (!state || typeof state !== 'object' || typeof state.phase !== 'string' || !state.phase) {
    return { action: 'continue', reason: 'no-phase', events: [], phase: '', round: 0 };
  }

  const phase = state.phase;
  const round = Number.isFinite(Number(state.round)) ? Number(state.round) : 0;
  const players = Array.isArray(state.players) ? state.players : [];
  const me = players.find((p) => p && String(p.id ?? '') === playerId) || {};

  if (phase === 'ended') {
    const reveal = Array.isArray(state.reveal) ? state.reveal : [];
    const undercover = reveal.find((p) => p && p.role === 'undercover');
    const winnerText = state.winner === 'undercover' ? '卧底赢' : state.winner === 'civilian' ? '平民赢' : '结束';
    const detail = undercover ? `，卧底是 ${undercover.name}（${undercover.word}）` : '';
    const id = 'ended';
    if (already.has(id)) return { action: 'stop', reason: 'already-ended', events: [], phase, round };
    return {
      action: 'stop',
      reason: 'ended',
      phase,
      round,
      events: [`（鱼塘）${room || '房间'} 结束了：${winnerText}${detail}`],
      ids: [id],
    };
  }

  // 「轮到我」：优先按 turn_id 判（服务端有就给，比昵称可靠），退回 turn_name 比对。
  //
  // 注意这里是**二选一**而不是 `||`：只要服务端给了 turn_id，就必须以它为准。
  // 昵称会重名，把名字命中当兜底去「补」turn_id 的否定结论，等于把判据作废。
  const turnId = state.turn_id === undefined || state.turn_id === null ? '' : String(state.turn_id);
  const turnName = String(state.turn_name ?? '').trim();
  const isMyTurn = turnId
    ? turnId === playerId
    : (!!playerName && turnName === playerName);

  const events = [];
  const ids = [];

  if (phase === 'speaking' && isMyTurn && !me.said) {
    const id = `say:${round}`;
    if (!already.has(id)) {
      ids.push(id);
      events.push(`（鱼塘）第 ${round} 轮轮到你了，该你说词了`);
    }
  }

  if (phase === 'voting' && !me.voted) {
    const id = `vote:${round}`;
    if (!already.has(id)) {
      ids.push(id);
      events.push(`（鱼塘）第 ${round} 轮投票了，去投你怀疑的卧底`);
    }
  }

  return {
    action: 'continue',
    reason: events.length > 0 ? 'notify' : 'nothing-to-do',
    phase,
    round,
    events,
    ids,
  };
}

/**
 * 拼状态查询地址（带 cache-buster，防止中间层缓存旧状态）。
 * @param {{ base: string, room: string, player: string, now?: number }} input
 */
export function fishStateUrl(input = {}) {
  const base = String(input.base ?? '').replace(/\/+$/, '');
  const room = encodeURIComponent(String(input.room ?? ''));
  const player = encodeURIComponent(String(input.player ?? ''));
  const at = Number(input.now) || Date.now();
  return `${base}/web/state?room=${room}&player_id=${player}&t=${at}`;
}
