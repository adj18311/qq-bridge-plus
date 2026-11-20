#!/usr/bin/env node
/**
 * check-model-quota.mjs —— 两个模型档位的额度检查 + 变化时私聊告警（本地运维脚本）
 *
 * 查什么
 * ---------------------------------------------------------------------------
 *   MiniMax（provider minimax-cn）
 *     · GET https://api.minimaxi.com/v1/token_plan/remains  —— 只给**窗口时间/百分比**，
 *       不给「用了多少」这种可靠用量；所以它只用来展示。
 *     · POST /v1/text/chatcompletion_v2，max_tokens: 1 —— **探针**。额度不足最可靠的
 *       信号就是调用失败；探针失败且是额度类错误 ⇒ 判定「不足」。
 *   DeepSeek（provider deepseek-account）
 *     · GET https://api.deepseek.com/user/balance —— 余额（is_available + total_balance）。
 *   两个 Key 从 ~/.dsh/.credentials.yaml 的 refs 里读（MINIMAX_CN_API_KEY / DEEPSEEK_API_KEY）。
 *   环境变量 MINIMAX_CN_API_KEY / DEEPSEEK_API_KEY 优先（方便临时换 Key 自测）。
 *
 * 告警规则
 * ---------------------------------------------------------------------------
 *   默认：**每一次手动运行都发一条余额汇报**（含两边真实数字），不再靠「状态变化」抑制。
 *     · 当前在用的那一边不足（探针失败像额度问题 / DeepSeek 余额见底）→ 汇报里追加一句处置
 *       建议，且只推**正确方向**的那个 bat（MiniMax 不足 ⇒ 切 DeepSeek，反之亦然）。
 *     · 两边都够用 → 只报数字，不给建议。
 *   state/quota-watch.json 仍然保留（记录两侧状态 + 上次汇报结果），便于以后挂定时任务；
 *   但**默认路径不再用它抑制发送**。要给将来的定时任务用「只在变化时发」，加 --only-on-change。
 *
 * 用法
 * ---------------------------------------------------------------------------
 *   node scripts/check-model-quota.mjs [--quiet] [--json] [--simulate <side>=<status>]
 *                                      [--only-on-change] [--min-balance <元>] [-h]
 *   --quiet                        只打印，不发私聊
 *   --json                         stdout 只输出 JSON（进度信息走 stderr）
 *   --only-on-change               退回旧行为：只在「当前在用的那一边」状态变化时发
 *   --min-balance <元>             DeepSeek 余额低于该值判为不足（默认 0，即只认「见底」）
 *   --simulate <side>=<status>     **测试用**：强制某一边的判定结果（insufficient|ok|unknown），
 *                                  用来验证通知通道与文案方向；此时私聊文案会带【测试】前缀
 *   -h, --help                     帮助
 *
 * 私聊通道：控制台 POST /api/test-send（只需 x-console-token）。
 * 不用 /api/socialV2/send-message：那个端点即使有控制台令牌也强制要 x-agent-token（无令牌 403）。
 *
 * 方向断言（--self-test-direction）
 * ---------------------------------------------------------------------------
 *   文案里「要切到 X」必须配 X 的 bat 名。本脚本内置一条自检：以 --simulate 驱动两边判定，
 *   检查输出/待发文案里的 bat 名与目标方向一致（错了就非 0 退出）。见 assertDirection()。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'quota-watch.json');
const LEDGER_FILE = path.join(STATE_DIR, 'token-usage.jsonl');

const MINIMAX_REMAINS_URL = 'https://api.minimaxi.com/v1/token_plan/remains';
const MINIMAX_CHAT_URL = 'https://api.minimaxi.com/v1/text/chatcompletion_v2';
const MINIMAX_PROBE_MODEL = 'MiniMax-M3.1-Flash-Preview';
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';

const SIDES = {
  minimax: { id: 'minimax', label: 'MiniMax', provider: 'minimax-cn', bat: '切换模型到MiniMax.bat' },
  deepseek: { id: 'deepseek', label: 'DeepSeek', provider: 'deepseek-account', bat: '切换模型到DeepSeek.bat' },
};

/** 额度类错误的关键词（探针失败时用来区分「额度用尽」和「网络/鉴权故障」）。 */
const QUOTA_HINTS = /(额度|余额|用尽|不足|超出|超限|欠费|限流|quota|insufficient|exceed|no enough|not enough|balance|out of credit|rate limit)/i;
const AUTH_HINTS = /(unauthor|unauthentic|invalid.*(key|token)|api[_ -]?key.*(invalid|incorrect)|鉴权|认证失败|无效.*(key|令牌|密钥)|401|403)/i;

// ── 小工具 ───────────────────────────────────────────────────────────────────
function readJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return JSON.parse(text);
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-quota`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function loadCredential(name) {
  const fromEnv = process.env[name];
  if (fromEnv && String(fromEnv).trim()) return { value: String(fromEnv).trim(), source: 'env' };
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const file = path.join(dshHome, '.credentials.yaml');
  const doc = YAML.load(fs.readFileSync(file, 'utf8'));
  const value = doc?.refs?.[name];
  if (!value) throw new Error(`读不到凭据 ${name}（${file} 的 refs 里没有，也没有同名环境变量）`);
  return { value: String(value).trim(), source: 'file' };
}

/** 只用于打印的掩码：绝不输出完整 Key。 */
const mask = (v) => (v ? `${String(v).slice(0, 6)}…（len=${String(v).length}）` : '(空)');

function fmtTime(ms) {
  if (!Number.isFinite(Number(ms))) return '-';
  return new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

function fmtDuration(ms) {
  if (!Number.isFinite(Number(ms))) return '-';
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

async function getJson(url, headers, body, timeoutMs = 20_000) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
}

// ── 参数 ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { quiet: false, json: false, help: false, simulate: null, minBalance: 0, onlyOnChange: false, selfTestDirection: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--only-on-change') out.onlyOnChange = true;
    else if (a === '--self-test-direction') { out.selfTestDirection = true; out.quiet = true; }
    else if (a === '--simulate' || a.startsWith('--simulate=')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      const m = /^(minimax|deepseek)=(insufficient|ok|unknown)$/.exec(String(v ?? ''));
      if (!m) throw new Error(`--simulate 取值应为 <minimax|deepseek>=<insufficient|ok|unknown>，收到「${v}」`);
      out.simulate = { side: m[1], status: m[2] };
    } else if (a === '--min-balance' || a.startsWith('--min-balance=')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`--min-balance 需要一个 >= 0 的数字，收到「${v}」`);
      out.minBalance = n;
    } else throw new Error(`未知参数：${a}`);
  }
  return out;
}

const HELP = `模型额度检查 + 每次运行都私聊汇报余额
用法：node scripts/check-model-quota.mjs [选项]

  --quiet               只打印，不发私聊
  --json                stdout 只输出 JSON（进度信息走 stderr）
  --only-on-change      退回旧行为：只在「当前在用的那一边」状态变化时发
  --min-balance <元>    DeepSeek 余额低于该值判为不足（默认 0）
  --simulate <s>=<v>    **测试用**：强制某一侧的判定（minimax|deepseek）=（insufficient|ok|unknown）
  --self-test-direction **测试用**：自检文案方向（bat 名是否配对该边），只打印不发消息
  -h, --help            本帮助

判定：MiniMax 用 max_tokens:1 的探针（失败且是额度类错误 ⇒ 不足）；DeepSeek 看 user/balance。
默认**每次运行都发一条汇报**（含两边真实数字）；只有当前在用的那一边不足时，才追加一句
「双击对应 bat 切到另一边」的处置建议，方向由 SIDES 表决定，绝不给反方向的 bat。
状态仍写 state/quota-watch.json（默认不再用它抑制发送）。`;

// ── 检查逻辑 ─────────────────────────────────────────────────────────────────
async function checkMinimax(key) {
  const side = { side: 'minimax', id: 'minimax', label: 'MiniMax', provider: SIDES.minimax.provider, status: 'unknown', detail: '', window: null, probe: null };

  // ① 窗口信息（只展示，不作为判定依据）
  try {
    const r = await getJson(MINIMAX_REMAINS_URL, { authorization: `Bearer ${key}` });
    const row = r.json?.model_remains?.[0];
    if (r.status === 200 && row) {
      side.window = {
        model: row.model_name ?? null,
        intervalStart: fmtTime(row.start_time),
        intervalEnd: fmtTime(row.end_time),
        intervalRemains: fmtDuration(row.remains_time),
        intervalRemainingPercent: row.current_interval_remaining_percent ?? null,
        intervalStatus: row.current_interval_status ?? null,
        weeklyEnd: fmtTime(row.weekly_end_time),
        weeklyRemains: fmtDuration(row.weekly_remains_time),
        weeklyRemainingPercent: row.current_weekly_remaining_percent ?? null,
        weeklyStatus: row.current_weekly_status ?? null,
      };
    } else {
      side.window = { error: `HTTP ${r.status} ${r.text.slice(0, 160)}` };
    }
  } catch (error) {
    side.window = { error: error?.message ?? String(error) };
  }

  // ② 探针：max_tokens: 1，真正的额度判据
  try {
    const r = await getJson(
      MINIMAX_CHAT_URL,
      { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      { model: MINIMAX_PROBE_MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
    );
    const baseCode = r.json?.base_resp?.status_code;
    const apiOk = r.status === 200 && baseCode === 0 && Array.isArray(r.json?.choices);
    side.probe = {
      httpStatus: r.status,
      apiStatus: baseCode ?? null,
      apiMessage: r.json?.base_resp?.status_msg ?? '',
      ok: apiOk,
      usage: r.json?.usage ?? null,
    };
    if (apiOk) {
      side.status = 'ok';
      side.detail = `探针成功（返回 ${r.json.choices.length} 个 choice）`;
    } else {
      const blob = `${r.status} ${baseCode ?? ''} ${r.json?.base_resp?.status_msg ?? ''} ${r.text.slice(0, 300)}`;
      if (r.status === 402 || r.status === 429 || (QUOTA_HINTS.test(blob) && !AUTH_HINTS.test(blob))) {
        side.status = 'insufficient';
        side.detail = `探针失败且像额度问题：HTTP ${r.status} ${r.json?.base_resp?.status_msg || r.text.slice(0, 120)}`;
      } else {
        side.status = 'unknown';
        side.detail = `探针失败（原因不像额度问题，按未知处理）：HTTP ${r.status} ${r.json?.base_resp?.status_msg || r.text.slice(0, 120)}`;
      }
    }
  } catch (error) {
    side.status = 'unknown';
    side.detail = `探针请求异常：${error?.message ?? error}`;
    side.probe = { ok: false, error: error?.message ?? String(error) };
  }
  return side;
}

async function checkDeepseek(key, minBalance) {
  const side = { side: 'deepseek', id: 'deepseek', label: 'DeepSeek', provider: SIDES.deepseek.provider, status: 'unknown', detail: '', balance: null };
  try {
    const r = await getJson(DEEPSEEK_BALANCE_URL, { authorization: `Bearer ${key}` });
    if (r.status === 200 && r.json) {
      const info = Array.isArray(r.json.balance_infos) ? r.json.balance_infos[0] : null;
      const total = info ? Number(info.total_balance) : NaN;
      side.balance = {
        isAvailable: r.json.is_available === true,
        currency: info?.currency ?? null,
        totalBalance: Number.isFinite(total) ? total : null,
        grantedBalance: info ? Number(info.granted_balance) : null,
        toppedUpBalance: info ? Number(info.topped_up_balance) : null,
      };
      if (r.json.is_available !== true) {
        side.status = 'insufficient';
        side.detail = '账号 is_available=false（余额不足或账户不可用）';
      } else if (Number.isFinite(total) && total <= minBalance) {
        side.status = 'insufficient';
        side.detail = `余额 ${total} ${info?.currency ?? ''} <= 阈值 ${minBalance}`;
      } else {
        side.status = 'ok';
        side.detail = `余额 ${Number.isFinite(total) ? total : '?'} ${info?.currency ?? ''}（阈值 ${minBalance}）`;
      }
    } else if (r.status === 401 || r.status === 403) {
      side.status = 'unknown';
      side.detail = `HTTP ${r.status}：鉴权失败（不是额度结论）`;
    } else {
      side.status = 'unknown';
      side.detail = `HTTP ${r.status} ${r.text.slice(0, 160)}`;
    }
  } catch (error) {
    side.status = 'unknown';
    side.detail = `请求异常：${error?.message ?? error}`;
  }
  return side;
}

// ── 状态 + 通知 ──────────────────────────────────────────────────────────────
function loadWatchState() {
  try {
    const st = readJsonFile(STATE_FILE);
    if (st && typeof st === 'object') return st;
  } catch {}
  return { version: 1, currentSide: null, sides: {}, lastNotified: null, updatedAt: null };
}

/** 变化触发的短告警文案（--only-on-change 且当前这边不足时用；方向同样由 other 决定）。 */
function buildMessage({ kind, side, other, detail, simulated }) {
  const prefix = simulated ? '【测试，请忽略】' : '';
  const id = side.id ?? side.side;
  if (kind === 'insufficient') {
    const why = id === 'minimax' ? '额度用尽了（5 小时窗口）' : '余额见底了';
    return `${prefix}${side.label} 的${why}，现在跑在它上面的会话可能会报错。`
      + `要切到 ${other.label} 就双击『${other.bat}』。`;
  }
  return `${prefix}${side.label} 的额度已恢复，可以正常用了。（${detail}）`;
}

/** 「钱」的数字尽量短：21.1 而不是 21.10；>100 取整。 */
function fmtMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '?';
  return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 100) / 100);
}

/** MiniMax 这边的一句话：报 5h 窗口与周窗口的**剩余百分比**（外加各自的重置时间）。
 *  字段可信度：2026-10-09 20:08 窗口刷新时实测 `current_interval_remaining_percent` 由 0 跳到 99，
 *  随后随使用稳步下降 ⇒ 它就是"剩余百分比"。注意窗口耗尽（0%）后小请求（探针）仍可能被放行。 */
function minimaxPhrase(side) {
  const w = side.window;
  const ip = w && !w.error ? w.intervalRemainingPercent : null;
  const wp = w && !w.error ? w.weeklyRemainingPercent : null;
  if (ip === null || ip === undefined) {
    if (side.status === 'insufficient') return '额度看起来用尽了（探针失败）';
    return side.status === 'ok' ? '探针正常（窗口信息取不到）' : '状态未知（探针/窗口没给出结论）';
  }
  const seg = [`5h 窗口剩余 ${ip}%${w.intervalRemains && w.intervalRemains !== '-' ? `（${w.intervalRemains} 后重置）` : ''}`];
  if (wp !== null && wp !== undefined) {
    seg.push(`周窗口剩余 ${wp}%${w.weeklyRemains && w.weeklyRemains !== '-' ? `（${w.weeklyRemains} 后重置）` : ''}`);
  }
  if (Number(ip) <= 0) {
    seg.push(side.status === 'ok' ? '5h 额度已耗尽（探针仍通，可能只是小请求被放行）' : '5h 额度已耗尽');
  }
  return seg.join('；');
}

function deepseekPhrase(side) {
  if (side.status === 'ok' && side.balance && side.balance.totalBalance !== null) {
    return `余额 ${fmtMoney(side.balance.totalBalance)} 元`;
  }
  if (side.status === 'insufficient') {
    return side.detail?.includes('is_available') ? '余额见底了' : '余额不足';
  }
  if (side.balance && side.balance.totalBalance !== null) return `余额 ${fmtMoney(side.balance.totalBalance)} 元（判定未知）`;
  return '余额取不到';
}

function buildBalanceReport({ sides, currentSideId, simulated }) {
  const prefix = simulated ? '【测试，请忽略】' : '';
  const mm = sides.minimax;
  const ds = sides.deepseek;
  const chunks = [];
  chunks.push(`额度检查：MiniMax ${minimaxPhrase(mm)}（探针${mm.status === 'ok' ? '正常' : mm.status === 'insufficient' ? '失败' : '无结论'}）`);
  chunks.push(`DeepSeek ${deepseekPhrase(ds)}`);

  const cur = currentSideId ? SIDES[currentSideId] : null;
  const curSide = currentSideId ? sides[currentSideId] : null;
  if (!cur || !curSide) {
    chunks.push('现在跑在未知档位（config.json 的 provider 不在已知两个里），先不判定够不够用');
    return `${prefix}${chunks.join('，')}。`;
  }
  const verdict = curSide.status === 'ok'
    ? `现在跑在 ${cur.label} 上，这边够用`
    : curSide.status === 'insufficient'
      ? `现在跑在 ${cur.label} 上，这边不够用`
      : `现在跑在 ${cur.label} 上，这边状态不确定`;
  chunks.push(verdict);
  let text = `${prefix}${chunks.join('，')}。`;
  if (curSide.status === 'insufficient') {
    const other = SIDES[currentSideId === 'minimax' ? 'deepseek' : 'minimax'];
    const why = currentSideId === 'minimax' ? '这边额度用尽' : '这边余额见底';
    text += `要马上切走就双击『${other.bat}』切到 ${other.label}（${why}）。`;
  }
  return text;
}

/**
 * 方向自检：文案里每个 bat 名附近的「切到/切回 X」必须与这个 bat 指向同一边。
 * 「双击『X.bat』切到 Y」和「要切到 Y 就双击『X.bat』」两种语序都检查：
 * bat 名前后各看 24 个字，前文说的是这一边、后文说的也是这一边。
 */
function assertDirection(text, expectTarget) {
  const problems = [];
  const otherOf = (side) => Object.values(SIDES).find((s) => s.id !== side.id);
  const mentions = (chunk, side) => chunk.includes(`切到 ${side.label}`) || chunk.includes(`切到${side.label}`)
    || chunk.includes(`切回 ${side.label}`) || chunk.includes(`切回${side.label}`);

  for (const side of Object.values(SIDES)) {
    const idx = text.indexOf(`『${side.bat}』`);
    if (idx < 0) continue;
    const before = text.slice(Math.max(0, idx - 24), idx);
    const after = text.slice(idx + `『${side.bat}』`.length, idx + `『${side.bat}』`.length + 24);
    const other = otherOf(side);
    if (mentions(before, other) || mentions(after, other)) {
      problems.push(`『${side.bat}』被说成了另一个方向：…${before}『${side.bat}』${after}…`);
      continue;
    }
    if (!mentions(before, side) && !mentions(after, side)) {
      problems.push(`『${side.bat}』前后都没说明切到 ${side.label}：…${before}『${side.bat}』${after}…`);
    }
  }
  if (expectTarget) {
    const wanted = SIDES[expectTarget];
    if (!text.includes(`『${wanted.bat}』`)) problems.push(`期望文案指向 ${wanted.label}（${wanted.bat}），但没有出现`);
    const wrong = Object.values(SIDES).filter((s) => s.id !== expectTarget && text.includes(`『${s.bat}』`));
    if (wrong.length) problems.push(`文案里出现了反方向的 bat：${wrong.map((s) => s.bat).join('、')}`);
  }
  return { ok: problems.length === 0, problems };
}

async function notifyOwner(text) {
  const cfg = readJsonFile(CONFIG_FILE);
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
  if (res.ok && parsed?.ok === true) return { ok: true, status: res.status, messageId: parsed.message_id ?? null };
  return { ok: false, status: res.status, error: parsed?.error ?? body.slice(0, 300) };
}

/**
 * 每个 key 最近一次实际用的 provider（用来提示「哪些会话跟当前档位不一致」）。
 */
function lastProviderByKey() {
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
      if (rec.key && rec.provider) last.set(rec.key, rec.provider);
    }
  } catch {}
  return last;
}

/**
 * 该建议切到哪一边：只有「当前在用的那一边不足」才给方向，否则 null。
 * 方向必须由 SIDES 表推出（当前是 minimax 就指向 deepseek），不写死文案。
 */
function directionTarget(currentSideId, sides) {
  if (!currentSideId || !sides?.[currentSideId]) return null;
  if (sides[currentSideId].status !== 'insufficient') return null;
  return currentSideId === 'minimax' ? 'deepseek' : 'minimax';
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const human = (msg = '') => (args.json ? process.stderr : process.stdout).write(`${msg}\n`);
  const result = {
    ok: false,
    checkedAt: new Date().toISOString(),
    currentSide: null,
    minBalance: args.minBalance,
    sides: {},
    sessionsOnOtherSide: [],
    notification: { attempted: false, sent: false, kind: null, message: null, messageId: null, error: null },
    stateFile: path.relative(ROOT, STATE_FILE).split(path.sep).join('/'),
    error: null,
  };
  if (args.help) {
    human(HELP);
    result.ok = true;
    result.help = true;
    return result;
  }

  const cfg = readJsonFile(CONFIG_FILE);
  const provider = String(cfg.dsh?.provider ?? '');
  const currentSideId = provider === SIDES.minimax.provider ? 'minimax' : (provider === SIDES.deepseek.provider ? 'deepseek' : null);
  result.currentSide = currentSideId;
  result.provider = provider;
  result.model = String(cfg.dsh?.model ?? '');

  human('=== 模型额度检查 ===');
  human(`当前档位（config.json）：${provider || '(空)'} / ${result.model || '(空)'}`
    + `（${currentSideId ? `当前在用：${SIDES[currentSideId].label}` : '不在已知两个档位里'}）`);

  const creds = {};
  for (const name of ['MINIMAX_CN_API_KEY', 'DEEPSEEK_API_KEY']) {
    try {
      creds[name] = loadCredential(name);
      human(`凭据 ${name}：${mask(creds[name].value)}（来自 ${creds[name].source === 'env' ? '环境变量' : '~/.dsh/.credentials.yaml'}）`);
    } catch (error) {
      creds[name] = { error: error?.message ?? String(error) };
      human(`凭据 ${name}：读不到（${creds[name].error}）`);
    }
  }
  human('');

  if (creds.MINIMAX_CN_API_KEY?.value) result.sides.minimax = await checkMinimax(creds.MINIMAX_CN_API_KEY.value);
  else result.sides.minimax = { side: 'minimax', id: 'minimax', label: 'MiniMax', provider: SIDES.minimax.provider, status: 'unknown', detail: `没有可用的 MINIMAX_CN_API_KEY：${creds.MINIMAX_CN_API_KEY?.error ?? ''}`, window: null, probe: null };

  if (creds.DEEPSEEK_API_KEY?.value) result.sides.deepseek = await checkDeepseek(creds.DEEPSEEK_API_KEY.value, args.minBalance);
  else result.sides.deepseek = { side: 'deepseek', id: 'deepseek', label: 'DeepSeek', provider: SIDES.deepseek.provider, status: 'unknown', detail: `没有可用的 DEEPSEEK_API_KEY：${creds.DEEPSEEK_API_KEY?.error ?? ''}`, balance: null };

  // 【测试用】强制判定，只用于验证通知通道。
  let simulated = false;
  if (args.simulate) {
    const s = result.sides[args.simulate.side];
    if (s) {
      s.status = args.simulate.status;
      s.detail = `[--simulate 强制] ${s.detail}`;
      simulated = true;
    }
  }

  // ── 打印 ──────────────────────────────────────────────────────────────────
  const mm = result.sides.minimax;
  human(`MiniMax: ${mm.status === 'ok' ? '✅ 正常' : mm.status === 'insufficient' ? '⛔ 额度不足' : '⚠️ 未知'}  ${mm.detail}`);
  if (mm.window && !mm.window.error) {
    human(`  窗口：${mm.window.intervalStart} ~ ${mm.window.intervalEnd}（剩 ${mm.window.intervalRemains}，区间剩余 ${mm.window.intervalRemainingPercent}%，status=${mm.window.intervalStatus}）`);
    human(`  周窗口：到 ${mm.window.weeklyEnd}（剩 ${mm.window.weeklyRemains}，周剩余 ${mm.window.weeklyRemainingPercent}%，status=${mm.window.weeklyStatus}）`);
    human('  （窗口百分比仅供参考：这个端点只给窗口时间，不给可靠用量；判定以探针为准）');
  } else if (mm.window?.error) {
    human(`  窗口信息取不到：${mm.window.error}`);
  }
  const ds = result.sides.deepseek;
  human(`DeepSeek: ${ds.status === 'ok' ? '✅ 正常' : ds.status === 'insufficient' ? '⛔ 余额不足' : '⚠️ 未知'}  ${ds.detail}`);
  if (ds.balance) {
    human(`  余额：${ds.balance.totalBalance} ${ds.balance.currency ?? ''}（充值 ${ds.balance.toppedUpBalance} / 赠送 ${ds.balance.grantedBalance}，is_available=${ds.balance.isAvailable}）`);
  }
  if (simulated) human(`⚠️ 本次用了 --simulate（测试用），上面的判定不是真实结果。`);

  const last = lastProviderByKey();
  result.sessionsOnOtherSide = [...last.entries()]
    .filter(([, p]) => currentSideId && p !== SIDES[currentSideId].provider)
    .map(([key, p]) => ({ key, provider: p }));
  if (result.sessionsOnOtherSide.length) {
    human(`提示：账本上另有 ${result.sessionsOnOtherSide.length} 个会话的最近记录不在当前档位（退役后没来过消息就会这样）：`
      + result.sessionsOnOtherSide.map((x) => `${x.key}(${x.provider})`).join('、'));
  }

  // ── 状态与通知 ────────────────────────────────────────────────────────────
  const prev = loadWatchState();
  const prevNotified = prev.lastNotified ?? null;
  const nextState = {
    version: 1,
    updatedAt: new Date().toISOString(),
    currentSide: currentSideId,
    minBalance: args.minBalance,
    sides: Object.fromEntries(Object.entries(result.sides).map(([k, v]) => [k, { status: v.status, detail: v.detail, checkedAt: new Date().toISOString() }])),
    lastNotified: prevNotified,
  };

  // ── 汇报文案（默认每次都发；--only-on-change 时才看状态变化）─────────────────
  if (!currentSideId) {
    human(`当前 provider「${provider}」不在已知两个档位里：不判定档位处置建议。`);
  }
  const direction = directionTarget(currentSideId, result.sides);
  const report = buildBalanceReport({ sides: result.sides, currentSideId, simulated });
  const directionCheck = assertDirection(report, direction);
  result.direction = { expect: direction, ...directionCheck };

  if (args.selfTestDirection) {
    // 自检模式：用 --simulate 覆盖两个方向，检查文案方向；只打印，绝不发消息。
    const cases = [];
    for (const cur of ['minimax', 'deepseek']) {
      for (const otherSide of Object.values(SIDES)) {
        if (otherSide.id === cur) continue;
        const fakeSides = {
          minimax: { ...result.sides.minimax },
          deepseek: { ...result.sides.deepseek },
        };
        fakeSides[cur] = { ...fakeSides[cur], status: 'insufficient', detail: '[self-test] 强制不足' };
        fakeSides[otherSide.id] = { ...fakeSides[otherSide.id], status: 'ok', detail: '[self-test] 强制正常' };
        const text = buildBalanceReport({ sides: fakeSides, currentSideId: cur, simulated: true });
        const check = assertDirection(text, directionTarget(cur, fakeSides));
        cases.push({ currentSide: cur, expectBat: SIDES[otherSide.id].bat, text, ok: check.ok, problems: check.problems });
      }
    }
    const failedCases = cases.filter((c) => !c.ok);
    result.selfTest = { cases, ok: failedCases.length === 0 };
    human('\n=== 方向自检（--self-test-direction，只打印不发消息）===');
    for (const c of cases) {
      human(`${c.ok ? '✅' : '❌'} 当前在 ${SIDES[c.currentSide].label} 且不足 ⇒ 应指向『${c.expectBat}』`);
      human(`   ${c.text}`);
      for (const p of c.problems) human(`   ⚠️ ${p}`);
    }
    human(failedCases.length ? `\n❌ 自检失败：${failedCases.length} 个用例方向不对。` : '\n✅ 自检通过：所有处置建议的方向都与目标 bat 一致。');
    result.ok = failedCases.length === 0;
    result.notification = { attempted: false, sent: false, kind: 'self-test', message: null, messageId: null, error: null };
    result.notification.quiet = true;
    if (!result.ok) process.exitCode = 2;
    return result;
  }

  let pending;
  if (args.onlyOnChange) {
    const cur = currentSideId ? result.sides[currentSideId] : null;
    const same = Boolean(prevNotified) && prevNotified.side === currentSideId && prevNotified.status === (cur?.status ?? null);
    const changed = Boolean(currentSideId) && !same;
    const insufficientAlert = changed && cur.status === 'insufficient';
    const otherSide = currentSideId === 'minimax' ? SIDES.deepseek : SIDES.minimax;
    pending = changed
      ? {
        kind: insufficientAlert ? 'insufficient' : 'balance',
        // 变化触发时，不足就发短告警（方向由 otherSide 决定）；其余用同样的余额汇报。
        message: insufficientAlert
          ? buildMessage({ kind: 'insufficient', side: cur, other: otherSide, detail: cur.detail, simulated })
          : report,
        status: cur.status,
      }
      : null;
  } else {
    // 默认：每次运行都汇报（用户明确要求），不再用 state 抑制。
    pending = { kind: currentSideId ? (result.sides[currentSideId].status === 'insufficient' ? 'insufficient' : 'balance') : 'balance', message: report, status: currentSideId ? result.sides[currentSideId].status : null };
  }

  if (args.quiet) {
    result.notification = {
      attempted: false, sent: false, kind: pending?.kind ?? null, message: pending?.message ?? null, messageId: null, error: null, quiet: true,
    };
    human(pending ? `\n--quiet：本应发送（未发）：${pending.message}` : `\n--quiet：本次按 --only-on-change 判定为无需发送（上次：${prevNotified ? `${prevNotified.side}/${prevNotified.status}` : '无'}）`);
  } else if (pending) {
    const message = pending.message;
    result.notification = { attempted: true, sent: false, kind: pending.kind, message, messageId: null, error: null };
    try {
      const sent = await notifyOwner(message);
      result.notification.sent = sent.ok === true;
      result.notification.messageId = sent.messageId ?? null;
      result.notification.error = sent.ok ? null : sent.error;
      if (sent.ok) {
        nextState.lastNotified = {
          side: currentSideId,
          status: pending.status,
          at: new Date().toISOString(),
          kind: pending.kind,
          messageId: sent.messageId ?? null,
        };
        human(`\n私聊汇报已发送（${pending.kind}，message_id ${sent.messageId}）：${message}`);
      } else {
        human(`\n私聊汇报发送失败（${sent.status}）：${sent.error}`);
        human(`  文案本来是：${message}`);
      }
    } catch (error) {
      result.notification.error = error?.message ?? String(error);
      human(`\n私聊汇报异常：${result.notification.error}`);
      human(`  文案本来是：${message}`);
    }
  } else {
    human(`\n--only-on-change：当前在用 ${currentSideId ? SIDES[currentSideId].label : '-'} 状态没变，本次不发（上次：`
      + `${prevNotified ? `${prevNotified.side}/${prevNotified.status}` : '无'}）。`);
    result.notification = { attempted: false, sent: false, kind: null, message: null, messageId: null, error: null };
  }

  if (direction && !directionCheck.ok) {
    human(`⚠️ 方向自检未通过（文案仍已发出，请检查）：${directionCheck.problems.join('；')}`);
  }

  try {
    writeJsonAtomic(STATE_FILE, nextState);
    human(`状态已写入 ${result.stateFile}`);
  } catch (error) {
    human(`⚠️ 状态文件写入失败：${error?.message ?? error}`);
    result.stateWriteError = error?.message ?? String(error);
  }

  result.ok = true;
  result.notification.quiet = args.quiet;
  result.simulated = simulated;
  return result;
}

// ── 入口 ─────────────────────────────────────────────────────────────────────
const jsonRequested = () => process.argv.includes('--json');
let result;
let failed = false;
try {
  result = await main();
} catch (error) {
  const json = jsonRequested();
  const human = (msg = '') => (json ? process.stderr : process.stdout).write(`${msg}\n`);
  human(`\n✗ 失败：${error?.message ?? error}`);
  result = { ok: false, error: error?.message ?? String(error) };
  failed = true;
}
if (failed) process.exitCode = 1;
if (jsonRequested()) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
