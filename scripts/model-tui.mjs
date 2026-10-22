#!/usr/bin/env node
/**
 * scripts/model-tui.mjs — 交互式「模型管理器」（纯 node 内置 + ANSI，无第三方依赖）
 * ---------------------------------------------------------------------------
 * 干什么：
 *   ① 顶部状态行：本版本不查询任何供应商额度/余额（不读取供应商凭据，不请求供应商额度接口；本地模型目录/热更新保留），只固定说明额度显示已停用；
 *   ② 第二行常驻目录行：本次模型菜单来自 `GET /api/dsh/models`（A① 只读接口）的 DSH 目录；
 *      目录读不到时明确显示「已降级 + 原因」，菜单退回**只含 DeepSeek 家族**的兜底（A⑤）；
 *   ③ 列出 config.json 里 allow.private / allow.groups 的**全部**会话（私人/群），
 *      每行显示「将要生效的模型 / 思考强度 (实际: 最近一次使用的模型)」；
 *   ④ 方向键上下选，Enter 打开模型列表（= 目录内容；单会话条目多一项「跟随全局」）；
 *      选中模型后再进入「思考强度」子菜单 —— 只列该模型 reasoning.efforts 里声明的档位
 *      （带 name/description），无档位就显示「该模型不支持思考强度」并允许直接确认（A③）；
 *   ⑤ 所有修改只累积在内存里；选中最后的 exit 按 Enter 才一次性原子写入 config.json。
 *
 * 四条硬约束（改代码前先读）：
 *   - **exit 之前磁盘上的 config.json 字节不变**（sha256 + mtime 都不变）：本脚本只在
 *     finish() 里写盘（先重读比对 sha256 防覆盖别人的改动 → 备份 → 临时文件 + rename → 回读自检）；
 *   - **state/token-usage.jsonl 只读**：只用来看「实际模型」，永远不写；
 *   - **任何退出路径都恢复终端**：raw mode 关掉、光标显示、属性复位（Ctrl+C / 异常 / 正常）；
 *   - **写盘之后才热生效**：写盘成功后调一次 `POST /api/dsh/model`（见 hotApplyModel），
 *     让运行中的桥接不重启就换档；调不到就如实说「未能热生效，需重启」，绝不谎报。
 *
 * 「将要生效的模型」与 src/bridge.js 的 modelSelectionFor(key) 保持一致：
 *   全局 dsh.provider / dsh.model 打底 → socialV2.modelOverrides[key] 覆盖 → 未写的字段继承全局。
 * 「跟随全局」的语义 = 从 modelOverrides 里**删掉**这个 key，而不是把全局值写进去。
 *
 * 两种输入模式（同一个渲染与同一套状态机，只是按键习惯不同）：
 *   --input arrows（默认）：↑/↓ 移光标，Enter 打开/确认；
 *   --input number        ：数字键直接跳到第 N 项，Enter 打开/确认。
 *   任何一种模式下两种键都认得（方向键与数字互为快捷方式），所以两种模式都能走完
 *   「选择 → 改模型 → exit 保存」。
 *
 * 自动化：
 *   --script <文件>  从文件读按键序列（支持 \e \r \n \t \\ \xNN 转义），不改变交互与写盘语义；
 *   --dry-run        exit 时只打印将要写入的变更，不写盘；
 *   --config <文件>  **测试用**：换一个配置文件路径（默认仓库根的 config.json）；
 *   --no-quota       兼容参数：接受但不生效（不读取供应商凭据，不请求供应商额度接口；本地模型目录/热更新保留）。
 *
 * 用法 / 退出码 / 详细说明见 --help。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const STATE_DIR = path.join(ROOT, 'state');
const LEDGER_FILE = path.join(STATE_DIR, 'token-usage.jsonl');

const RULE_WIDTH = 74;

/**
 * 模型菜单内容 = `GET /api/dsh/models` 的 DSH 目录（方案 A②）。
 *
 * 原来这里写死三个候选（minimax-cn/MiniMax-M3.1、minimax-cn/MiniMax-M3、deepseek-account/deepseek-flash），
 * 那是 A② 要修掉的问题：DSH 目录里明明有 `local-codex-app-server` 的 7 个模型，写死清单却永远选不到。
 * 现在 **MODEL_CANDIDATES 已删除**，正常菜单只来自目录；下面的 DEEPSEEK_FALLBACK_PROVIDERS 只在
 * 「目录读不到」这一种情况下使用（A⑤），并且界面上会明确标「兜底 · 未验证」。
 *
 * 为什么兜底不能带 MiniMax：A⑤ 定稿的理由是「本项目与 DSH 深度绑定，DeepSeek 是 DSH 自带、一定存在；
 * 第三方模型别人不一定装，塞进兜底会让项目落空」。所以兜底只允许 DeepSeek 家族。
 */
const DEEPSEEK_FALLBACK_PROVIDERS = [
  {
    id: 'deepseek-account',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-flash', name: 'deepseek-flash', note: '本项目零写入探针见过的真实 id' },
      { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', note: '本项目零写入探针见过的真实 id' },
    ],
  },
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-flash', name: 'deepseek-flash', note: '桥接内置默认 provider id' },
    ],
  },
];

/** 已知 provider 的显示名（目录里给不出 name 时用；绝不臆造模型能力）。 */
const KNOWN_PROVIDER_NAMES = Object.freeze({
  'minimax-cn': 'MiniMax',
  'deepseek-account': 'DeepSeek',
  'deepseek-official': 'DeepSeek',
  'local-codex-app-server': '本地 Codex',
});

/**
 * 桥接热更新端点 `POST /api/dsh/model` 的 normalizeReasoningEffort 当前**只接受**这三个
 * （src/bridge.js:622，t1 已核实并交接）。目录里声明的 medium / xhigh / off … 一律原样显示、
 * 原样写盘，绝不在这里过滤或映射成 high/max；只是「能不能热生效」要如实说（见 A③ 契约限制）。
 */
const ENDPOINT_EFFORT_VALUES = ['low', 'high', 'max'];
/** 桥接 loadConfig 在 dsh.reasoningEffort 缺失时的回落值（src/bridge.js REASONING_EFFORT_DEFAULT），仅用于显示。 */
const BRIDGE_DEFAULT_EFFORT = 'max';
/** GET /api/dsh/models 的本地超时：桥接侧是 5s（session/modelCatalog），这里留 1s 余量。 */
const CATALOG_TIMEOUT_MS = 6000;

/** 子菜单里的「跟随全局」哨兵项：确认 = 从 modelOverrides 删掉这个 key。 */
const FOLLOW_GLOBAL = { follow: true, provider: null, model: null, label: '跟随全局（从 modelOverrides 删除这个 key）' };

// ── ANSI ─────────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  inv: '\x1b[7m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

// ── 宽字符（CJK 按 2 列算，用于列对齐；chcp 65001 下终端也是这么算的）────────────
function charWidth(cp) {
  if (cp >= 0x1100 && (
    cp <= 0x115f
    || cp === 0x2329 || cp === 0x232a
    || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f64f)
    || (cp >= 0x20000 && cp <= 0x3fffd)
  )) return 2;
  return 1;
}

function displayWidth(text) {
  let w = 0;
  for (const ch of String(text)) w += charWidth(ch.codePointAt(0));
  return w;
}

function pad(text, width) {
  return String(text) + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

// ── 小工具 ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return { raw, value: JSON.parse(text) };
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function fileSha256(file) {
  try {
    return sha256Hex(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/** 本地时间戳，形如 20261012T190512（与仓库既有的 .bak-* 命名一致）。 */
function stampLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 变更摘要里的一格：对象/undefined 都要可读。 */
function jsonShort(value) {
  if (value === undefined) return '(无)';
  return JSON.stringify(value);
}

// ── state/token-usage.jsonl（只读！）────────────────────────────────────────
/**
 * 每个 key 最后一条带 provider/model 的记录 —— 就是「实际使用的模型」。
 * 只读这个文件，绝不写（它与「将要生效的模型」是两回事：那个来自 config.json）。
 */
function actualModelsByKey() {
  const last = new Map();
  let raw = '';
  try {
    raw = fs.readFileSync(LEDGER_FILE, 'utf8');
  } catch {
    return { map: last, readable: false, mtimeMs: null, loadedAt: Date.now() };
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || !rec.key) continue;
    if (rec.provider === undefined && rec.model === undefined) continue;
    const prev = last.get(rec.key) ?? {};
    last.set(rec.key, {
      provider: rec.provider ?? prev.provider ?? null,
      model: rec.model ?? prev.model ?? null,
    });
  }
  return { map: last, readable: true, mtimeMs: ledgerMtime(), loadedAt: Date.now() };
}

/** ledger 的 mtime（毫秒）；读不到返回 null。 */
function ledgerMtime() {
  try {
    return fs.statSync(LEDGER_FILE).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 重读「实际模型」快照。列表每次重绘都会调用：只有 mtime 变了才真的重读（懒加载），
 * 所以对聊得正欢的桥接来说开销就是一次 statSync。按 r 时 force=true 强制重读。
 */
function reloadLedger(force = false) {
  if (force) {
    state.ledger = actualModelsByKey();
    state.ledgerReloadedAt = Date.now();
    return true;
  }
  const now = ledgerMtime();
  if (now !== null && state.ledger.mtimeMs !== null && now === state.ledger.mtimeMs) return false;
  // mtime 读不到（文件被删/没权限）也要走一次：让「实际模型」能正确回退成无记录。
  if (now === null && state.ledger.mtimeMs === null && state.ledger.readable === false) return false;
  state.ledger = actualModelsByKey();
  state.ledgerReloadedAt = Date.now();
  return true;
}

// ── config 里的档位解析（与 src/bridge.js modelSelectionFor 同规则）──────────
const GLOBAL_PROVIDER_FALLBACK = 'deepseek-official';
const GLOBAL_MODEL_FALLBACK = 'deepseek-flash';

function globalSelection(cfg) {
  return {
    provider: String(cfg?.dsh?.provider || GLOBAL_PROVIDER_FALLBACK),
    model: String(cfg?.dsh?.model || GLOBAL_MODEL_FALLBACK),
  };
}

function overrideTable(cfg) {
  const table = cfg?.socialV2?.modelOverrides;
  if (!table || typeof table !== 'object' || Array.isArray(table)) return {};
  return table;
}

function overrideOf(cfg, key) {
  const ov = overrideTable(cfg)[key];
  if (!ov || typeof ov !== 'object' || Array.isArray(ov)) return null;
  return ov;
}

/** 与 modelSelectionFor 一致：全局打底 + 该 key 的覆盖，未写字段继承全局。 */
function effectiveSelection(cfg, key) {
  const base = globalSelection(cfg);
  if (!key) return base;
  const ov = overrideOf(cfg, key);
  if (!ov) return base;
  return {
    provider: String(ov.provider || base.provider),
    model: String(ov.model || base.model),
  };
}

/** 会话 key 列表：私人在前、群在后，各自按号码升序（非纯数字兜底按字符串）。 */
function sessionKeys(cfg) {
  const numAsc = (a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a).localeCompare(String(b));
  };
  const priv = [...new Set((Array.isArray(cfg?.allow?.private) ? cfg.allow.private : []).map(String))].sort(numAsc);
  const groups = [...new Set((Array.isArray(cfg?.allow?.groups) ? cfg.allow.groups : []).map(String))].sort(numAsc);
  // 白名单只有 private / groups 两类（config.json 与 config.example.json 里都没有 allow.others，
  // 桥接侧也只认这两个），所以这里不再臆造一个 others 分支。
  return [
    ...priv.map((qq) => ({ key: `private:${qq}`, kind: '私人会话', id: qq })),
    ...groups.map((g) => ({ key: `group:${g}`, kind: '群会话', id: g })),
  ];
}

// ── 思考强度（A③）：只读目录声明，不裁剪、不映射 ─────────────────────────────
/** 全局 reasoningEffort 的原始值（未设置 = null，桥接会回落到 BRIDGE_DEFAULT_EFFORT）。 */
function globalEffortValue(cfg = state.work) {
  const v = cfg?.dsh?.reasoningEffort;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** 该条目自己写的 reasoningEffort（只有单会话覆盖表里才有；没有 = null）。 */
function ownEffortValue(entry) {
  if (!entry || entry.type !== 'session') return null;
  const v = overrideOf(state.work, entry.key)?.reasoningEffort;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** 界面上显示的「当前强度」：全局看 dsh，单会话先看覆盖、再看全局（与 modelSelectionFor 同规则）。 */
function effortDisplay(entry) {
  if (entry?.type === 'global') {
    const raw = state.work?.dsh?.reasoningEffort;
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    // t5 协议：空字符串 = 显式「未设置」（selectModel 省略该档位，由模型自身默认决定）；
    // 缺字段 = 老配置，桥接仍按旧默认 max 处理。两者必须分开显示，不能混。
    if (raw === '') return '未设置（跟随模型默认档位）';
    return `未设置（缺字段：旧配置按 ${BRIDGE_DEFAULT_EFFORT} 处理）`;
  }
  const own = ownEffortValue(entry);
  if (own) return own;
  const g = globalEffortValue();
  return `跟随全局（${g ?? '未设置/模型默认'}）`;
}

const EFFORT_KEEP = Object.freeze({ mode: 'keep' });
const EFFORT_CLEAR = Object.freeze({ mode: 'clear' });
const effortSet = (value) => ({ mode: 'set', value });

/**
 * 把档位模式落到一个对象上：set = 写字段；clear = **写空字符串**（t5 协议：显式未设置，
 * 不是删字段 —— 缺字段在旧配置里代表默认 max）；keep = 不动。
 * 只用于全局 dsh（单会话的清空由 applyOverride 处理成删字段）。
 */
function applyEffortMode(target, mode) {
  if (!target || typeof target !== 'object' || !mode) return;
  if (mode.mode === 'set') target.reasoningEffort = mode.value;
  else if (mode.mode === 'clear') target.reasoningEffort = '';
}

/**
 * A③：切换模型后 reasoningEffort 重置为该模型的 defaultEffort。
 * 没有 defaultEffort（或模型不在目录里、目录不可用）⇒ 留空/跟随（clear），
 * **绝不把旧模型的档位留在配置里**。至于这个档位能不能热生效，由热更新摘要如实报告。
 */
function resetEffortModeForModel(model) {
  if (!model) return EFFORT_CLEAR;
  const efforts = Array.isArray(model.efforts) ? model.efforts : [];
  const def = typeof model.defaultEffort === 'string' ? model.defaultEffort.trim() : '';
  if (def && efforts.some((e) => e.id === def)) return effortSet(def);
  return EFFORT_CLEAR;
}

// ── DSH 模型目录（A②/A⑤）：菜单内容的唯一来源 ────────────────────────────────
/** 压成单行、去控制字符、限长：目录错误要显示，但不能带换行/ANSI/整段栈把界面撑坏。 */
function sanitizeInline(text, max = 200) {
  const s = String(text ?? '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function catalogUrl() {
  return `http://127.0.0.1:${consolePort()}/api/dsh/models`;
}

/** 把 A① 的 providers 再做一遍防御性校验（id 必须非空；name 缺失回落 id；efforts 缺失 = 空数组）。 */
function normalizeCatalogProviders(raw) {
  if (!Array.isArray(raw)) return [];
  const providers = [];
  for (const p of raw) {
    const id = typeof p?.id === 'string' ? p.id.trim() : '';
    if (!id) continue;
    const models = [];
    for (const m of Array.isArray(p.models) ? p.models : []) {
      const mid = typeof m?.id === 'string' ? m.id.trim() : '';
      if (!mid) continue;
      const r = m?.reasoning && typeof m.reasoning === 'object' ? m.reasoning : null;
      const efforts = [];
      for (const e of Array.isArray(r?.efforts) ? r.efforts : []) {
        const eid = typeof e?.id === 'string' ? e.id.trim() : '';
        if (!eid) continue;
        efforts.push({
          id: eid,
          name: typeof e.name === 'string' && e.name.trim() ? e.name : eid,
          description: typeof e.description === 'string' ? e.description : '',
        });
      }
      models.push({
        id: mid,
        name: typeof m.name === 'string' && m.name.trim() ? m.name : mid,
        efforts,
        defaultEffort: typeof r?.defaultEffort === 'string' && r.defaultEffort.trim() ? r.defaultEffort.trim() : null,
      });
    }
    if (!models.length) continue;
    providers.push({ id, name: typeof p.name === 'string' && p.name.trim() ? p.name : id, models });
  }
  return providers;
}

function degradedCatalog(error, extra = {}) {
  return {
    loadedAt: Date.now(),
    status: 'degraded',
    degraded: true,
    source: 'fallback',
    error: sanitizeInline(error || '未知原因'),
    providers: [],
    ...extra,
  };
}

/**
 * 读 `GET /api/dsh/models`（A① 契约）。**永远不抛**：连不上/401/形状不对/桥接报降级，
 * 一律变成可渲染的 degraded 状态（A⑤ 再据此退回 DeepSeek 兜底）。
 * 判定目录可用只看 degraded/source —— 那个 ok 恒为 true，不能当目录能力用（t1 交接明确要求）。
 */
async function fetchCatalog() {
  const url = catalogUrl();
  const { token, source: tokenSource } = consoleToken();
  const headers = {};
  if (token) headers['x-console-token'] = token;
  let res;
  let text = '';
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
    text = await res.text();
  } catch (error) {
    const reason = error?.name === 'TimeoutError'
      ? `${Math.round(CATALOG_TIMEOUT_MS / 1000)} 秒超时`
      : (error?.cause?.code ?? error?.message ?? error);
    return degradedCatalog(`调不到桥接的模型目录接口 ${url}（${reason}）`, { tokenSource });
  }
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok || !json) {
    const authHint = (res.status === 401 || res.status === 403)
      ? `；控制台令牌来源：${tokenSource}${token ? '' : '（没有取到任何令牌）'}`
      : '';
    return degradedCatalog(`GET /api/dsh/models 返回 HTTP ${res.status} ${sanitizeInline(json?.error ?? text, 160)}${authHint}`, { tokenSource });
  }
  // 桥接自己报告的降级（目录异常/超时/空）优先：哪怕 providers 里混了东西也不当成功。
  if (json.degraded === true || json.source === 'fallback') {
    return degradedCatalog(`桥接报告目录降级：${sanitizeInline(json.error || '未给出原因')}`, { tokenSource });
  }
  const providers = normalizeCatalogProviders(json.providers);
  if (!providers.length) {
    return degradedCatalog('DSH 模型目录为空：没有可用的 provider/model', { tokenSource });
  }
  return { loadedAt: Date.now(), status: 'ok', degraded: false, source: 'dsh', error: null, providers, tokenSource };
}

/**
 * A⑤ 兜底清单：只 DeepSeek 家族，兼容 deepseek-account / deepseek-official 两个 id。
 * 当前 config 里用的那个 deepseek provider（以及它当前的 model）排最前，方便「保持现状」。
 * **本次目录读不到 ⇒ 所有兜底项都标未验证**，界面会写清「兜底 · 未验证」，不冒称已验证 provider。
 */
function fallbackProviders() {
  const curProvider = String(state.orig?.dsh?.provider ?? '').trim();
  const curModel = String(state.orig?.dsh?.model ?? '').trim();
  const providers = DEEPSEEK_FALLBACK_PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    fallback: true,
    note: '目录不可用：provider id 兼容清单',
    models: p.models.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      efforts: [],
      defaultEffort: null,
      fallback: true,
      note: m.note ?? '',
    })),
  }));
  if (providerFamily(curProvider) === 'deepseek') {
    let p = providers.find((x) => x.id === curProvider);
    if (!p) {
      p = {
        id: curProvider,
        name: KNOWN_PROVIDER_NAMES[curProvider] ?? curProvider,
        fallback: true,
        note: '当前 config.json 正在使用它（目录不可用，未验证）',
        models: [],
      };
      providers.push(p);
    }
    if (curModel && !p.models.some((m) => m.id === curModel)) {
      p.models.push({ id: curModel, name: curModel, efforts: [], defaultEffort: null, fallback: true, note: '当前 config.json 正在使用它（目录不可用，未验证）' });
    }
    providers.sort((a, b) => (a.id === curProvider ? -1 : b.id === curProvider ? 1 : 0));
  }
  return providers.filter((p) => p.models.length);
}

/** 菜单用的 provider 列表：目录可用用目录，否则用 DeepSeek 兜底（带降级原因）。 */
function catalogProvidersForMenu() {
  const c = state.catalog;
  if (!c || !c.loadedAt) return { providers: fallbackProviders(), degraded: true, reason: '目录尚未读取完成' };
  if (c.degraded || !Array.isArray(c.providers) || !c.providers.length) {
    return { providers: fallbackProviders(), degraded: true, reason: c.error || '目录不可用' };
  }
  return { providers: c.providers, degraded: false, reason: null };
}

/** 菜单可选项的扁平列表（provider × model），顺序与目录一致。 */
function catalogModelList() {
  const { providers, degraded } = catalogProvidersForMenu();
  const list = [];
  for (const p of providers) {
    for (const m of p.models) {
      list.push({
        provider: p.id,
        providerName: p.name || p.id,
        model: m.id,
        modelName: m.name || m.id,
        efforts: Array.isArray(m.efforts) ? m.efforts : [],
        defaultEffort: m.defaultEffort ?? null,
        fallback: degraded || p.fallback === true || m.fallback === true,
        note: m.note || p.note || '',
      });
    }
  }
  return list;
}

/** 按 provider/model 找目录条目；找不到返回 null（= 不臆造能力）。 */
function catalogModelFor(provider, model) {
  return catalogModelList().find((m) => m.provider === provider && m.model === model) ?? null;
}

function providerFamily(id) {
  const s = String(id ?? '').toLowerCase();
  if (s.startsWith('minimax')) return 'minimax';
  if (s.startsWith('deepseek')) return 'deepseek';
  return 'none';
}

/** 一句话概括一个模型的档位能力（只按目录声明说，不猜）。 */
function effortSummary(model) {
  if (!model) return '思考强度未知（不在目录里）';
  const efforts = Array.isArray(model.efforts) ? model.efforts : [];
  if (!efforts.length) return model.fallback ? '思考强度未知（兜底未验证）' : '不支持思考强度';
  return `档位 ${efforts.map((e) => e.id).join('/')}${model.defaultEffort ? `（默认 ${model.defaultEffort}）` : '（无默认）'}`;
}

// ── 变更（内存里累积 → exit 时一次性应用）──────────────────────────────────
/**
 * 只改内存里的工作副本：全局档位改 cfg.dsh.provider/model；单会话写/删 modelOverrides[key]。
 * 这里同时给出「变更摘要」的行（key / 字段 / 旧→新），它既是渲染用的改动计数，
 * 也是 exit 时打印的摘要 —— 保证「显示的」和「真正写盘的」是同一份差异。
 */
function computeChanges(orig, work) {
  const rows = [];
  for (const field of ['provider', 'model']) {
    const a = jsonShort(orig?.dsh?.[field]);
    const b = jsonShort(work?.dsh?.[field]);
    if (a !== b) rows.push({ key: '全局档位', field: `dsh.${field}`, old: a, new: b });
  }
  // 全局思考强度（A③）：undefined = 未设置（桥接回落默认），所以要把 undefined 和具体值都如实列出。
  {
    const a = jsonShort(orig?.dsh?.reasoningEffort);
    const b = jsonShort(work?.dsh?.reasoningEffort);
    if (a !== b) rows.push({ key: '全局档位', field: 'dsh.reasoningEffort', old: a, new: b });
  }
  const oTable = overrideTable(orig);
  const wTable = overrideTable(work);
  const keys = [...new Set([...Object.keys(oTable), ...Object.keys(wTable)])];
  for (const k of keys) {
    const a = jsonShort(oTable[k]);
    const b = jsonShort(wTable[k]);
    if (a !== b) rows.push({ key: k, field: `socialV2.modelOverrides["${k}"]`, old: a, new: b });
  }
  return rows;
}

function ensureOverrideTable(cfg) {
  if (!cfg.socialV2 || typeof cfg.socialV2 !== 'object' || Array.isArray(cfg.socialV2)) cfg.socialV2 = {};
  const table = cfg.socialV2.modelOverrides;
  if (!table || typeof table !== 'object' || Array.isArray(table)) cfg.socialV2.modelOverrides = {};
  return cfg.socialV2.modelOverrides;
}

/** 写一条覆盖：provider/model（和本次真正要改的 reasoningEffort）在前，其余未知字段原样保留。 */
function applyOverride(work, key, sel, effortMode = EFFORT_KEEP) {
  const table = ensureOverrideTable(work);
  const prev = overrideOf({ socialV2: { modelOverrides: table } }, key) ?? {};
  const next = { provider: sel.provider, model: sel.model };
  for (const [k, v] of Object.entries(prev)) {
    if (k === 'provider' || k === 'model' || k === 'reasoningEffort') continue;
    next[k] = v;
  }
  // 桥接只允许这三个字段，reasoningEffort 必须由 effortMode 明确决定：keep = 保留原值，
  // set = 写本次选中的档位，clear = 删掉（留空/跟随）——绝不把旧模型的档位默默留着。
  if (effortMode?.mode === 'set') next.reasoningEffort = effortMode.value;
  else if (effortMode?.mode === 'keep' && prev.reasoningEffort !== undefined) next.reasoningEffort = prev.reasoningEffort;
  table[key] = next;
}

/** 「跟随全局」 = 删掉这个 key（不是把全局值写进去）。 */
function applyFollowGlobal(work, key) {
  const table = ensureOverrideTable(work);
  delete table[key];
}

function applyGlobal(work, sel, effortMode = EFFORT_KEEP) {
  if (!work.dsh || typeof work.dsh !== 'object' || Array.isArray(work.dsh)) work.dsh = {};
  work.dsh.provider = sel.provider;
  work.dsh.model = sel.model;
  applyEffortMode(work.dsh, effortMode);
}

// ── 写盘（只在 exit 时发生）─────────────────────────────────────────────────
/** 从原始字节里认出格式，写回时继续保持：BOM / 缩进 / 换行符 / 末尾换行。 */
function detectFormat(raw) {
  const bom = raw.charCodeAt(0) === 0xfeff;
  const text = bom ? raw.slice(1) : raw;
  const m = /^([ \t]+)"/m.exec(text);
  const indent = m ? m[1] : '  ';
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  return { bom, indent, eol, trailingNewline: text.endsWith('\n') };
}

function serializeConfig(value, format) {
  let out = JSON.stringify(value, null, format.indent);
  if (format.eol !== '\n') out = out.split('\n').join(format.eol);
  if (format.trailingNewline) out += format.eol;
  if (format.bom) out = '\ufeff' + out;
  return out;
}

/** 备份名：config.json.bak-tui-<YYYYMMDDTHHMMSS>；同一秒撞了就加 -2、-3…；冲突中止时带 -conflict 后缀。 */
function backupPath(file, d = new Date(), suffix = '') {
  const base = `${file}.bak-tui-${stampLocal(d)}${suffix ? `-${suffix}` : ''}`;
  if (!fs.existsSync(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`备份名冲突太多：${base}`);
}

/** 回读自检：解析磁盘上的文件，和内存里的工作副本做深比较（含键顺序）。 */
function deepEqualJson(a, b) {
  if (JSON.stringify(a) === JSON.stringify(b)) return true;
  // 键顺序不同但内容相同也算一致（保守起见仍以 canonical 比较兜底）
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
    }
    return v;
  };
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

// ── 参数 ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    dryRun: false,
    input: 'arrows',
    script: null,
    config: CONFIG_FILE,
    noQuota: false, // 兼容参数：接受 --no-quota 但不生效（本版本不查询额度）
    consolePort: null,
    noHotApply: false,
    drainMs: 80,
    help: false,
  };
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
    if (a === '--dry-run' || a === '-n') out.dryRun = true;
    else if (a === '--no-quota') out.noQuota = true;
    else if (a === '--no-hot-apply') out.noHotApply = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--input' || a.startsWith('--input=')) { let v; [v, i] = takeValue(i, '--input'); out.input = String(v).toLowerCase(); }
    else if (a === '--script' || a.startsWith('--script=')) { let v; [v, i] = takeValue(i, '--script'); out.script = v; }
    else if (a === '--config' || a.startsWith('--config=')) { let v; [v, i] = takeValue(i, '--config'); out.config = path.resolve(v); }
    else if (a === '--console-port' || a.startsWith('--console-port=')) {
      let v; [v, i] = takeValue(i, '--console-port');
      const port = Number(v);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--console-port 只支持 1-65535 的整数，收到「${v}」`);
      out.consolePort = port;
    }
    else if (a === '--drain-ms' || a.startsWith('--drain-ms=')) {
      let v; [v, i] = takeValue(i, '--drain-ms');
      const ms = Number(v);
      if (!Number.isFinite(ms) || ms < 0 || ms > 5000) {
        throw new Error(`--drain-ms 只支持 0-5000 的整数（毫秒；0 = 退出前不做残留输入清理），收到「${v}」`);
      }
      out.drainMs = Math.round(ms);
    } else throw new Error(`未知参数：${a}`);
  }
  if (out.input === 'arrow') out.input = 'arrows';
  if (out.input === 'num' || out.input === 'digits') out.input = 'number';
  if (out.input !== 'arrows' && out.input !== 'number') {
    throw new Error(`--input 只支持 arrows | number，收到「${out.input}」`);
  }
  return out;
}

const HELP = `交互式模型管理器（会话模型 / 全局档位，只在 exit 时一次性写盘）
用法：node scripts/model-tui.mjs [选项]

  --input <arrows|number>  输入模式（默认 arrows）
                             arrows：↑/↓ 移动高亮，Enter 打开模型列表/确认
                             number：直接输入编号跳到第 N 项（多位数字可以连打，例如 12），Enter 打开/确认
                             两种模式下方向键与编号都认（互为快捷方式）
  --dry-run                 exit 时只打印将要写入的变更，**不写盘**
  --script <文件>           从文件读按键序列（自动化测试用）；不改变交互与写盘语义
                             支持转义：\\e=Esc \\r/\\n=Enter \\t \\\\ \\xNN；文件末尾的一个换行不算按键
  --config <文件>           测试用：操作指定的配置文件（默认仓库根的 config.json）
  --console-port <端口>     桥接控制台端口（默认取 config.json 的 consolePort，缺省 3100），热生效用
  --no-hot-apply            写盘后不调 POST /api/dsh/model（只写盘，自己决定什么时候重启）
  --no-quota                兼容参数：接受但不生效（本版本不读取供应商凭据，不请求供应商额度接口；本地模型目录/热更新保留；热生效仍访问本机 127.0.0.1）
  --drain-ms <毫秒>         退出前清残留输入的静默窗口（默认 80，0=关掉）
  -h, --help                本帮助

环境变量：
  BRIDGE_CONSOLE_TOKEN      覆盖热生效用的控制台令牌（不设时取 config.json 的 consoleToken，
                            再取 state/console-token；401/403 时摘要会告诉你用的是哪一个）

界面：
  顶部是固定说明行：本版本不查询供应商额度/余额（不读取供应商凭据，不请求供应商额度接口；本地模型目录/热更新保留；热生效仍访问本机 127.0.0.1）；--no-quota 只是兼容参数。
  第二行是目录行：菜单内容来自运行中桥接的 GET /api/dsh/models（DSH 模型目录）；目录读不到时明确显示
  「已降级 + 原因」，菜单只保留 DeepSeek 家族兜底（兼容 deepseek-account / deepseek-official，标「兜底·未验证」）。
  中间是列表：全部单会话条目（私人在前、群在后，各自号码升序）→ 全局档位 → exit；
  每行形如「2. 私人会话 private:10001   deepseek-flash · 强度 high (实际: 无记录) ［跟随全局］」。
  Enter 打开模型列表（=目录内容；单会话条目多一项「跟随全局」；光标默认停在**当前生效模型**上），
  选中模型后进入思考强度子菜单：只列该模型 reasoning.efforts 声明的档位（带 name/description），
  无档位就显示「该模型不支持思考强度」并可直接 Enter 确认；切换模型会把 reasoningEffort 重置为
  该模型 defaultEffort（无 default 则留空/跟随）并提示。列表里按 e 也可以直接改当前条目的强度。
  Esc（或 b）返回；r 刷新目录/实际模型。

安全约束：
  - 选中 exit 按 Enter 之前，磁盘上的 config.json 一个字节都不会变；
  - exit 有改动时：先备份成 config.json.bak-tui-<YYYYMMDDTHHMMSS>，再写临时文件 + rename
    原子替换，最后回读自检并打印变更摘要（key / 字段 / 旧→新）；
  - 落盘前会重新读盘比对启动时的 sha256：磁盘被别的进程改过就中止写盘（exit 1），
    把当前内容备份成 config.json.bak-tui-<时间戳>-conflict，绝不覆盖别人的改动；
  - exit 无改动时：提示「无改动，未写盘」，不新建备份、不改动任何文件；
  - Ctrl+C（或任何异常）都恢复终端（关 raw mode、显示光标、复位属性）且不写盘；
  - state/token-usage.jsonl 只读，绝不写。

生效时机：写盘成功后，本工具会自动调一次运行中桥接的 POST /api/dsh/model 做**热生效**：
  ① 端点那边**有变化** → 它自己备份 + 原子写 + 同步内存 + 递增档位 epoch；
  ② **无变化**（本工具先把盘写好了，端点看到的就是这个值，属常态）→ 只同步内存：
     wrote:false、backup:null、changes:[]，不写盘、不备份、不递增 epoch；
  两种情况都会让已存在的会话在下一条消息就地重新 selectModel（不重启、不丢上下文），摘要按这两支给结论。
  思考强度按目标模型的真实目录声明校验：声明的 medium/xhigh/off 等原样发送（本工具不过滤、不映射）；
  清空/留空用显式 null 表达（省略字段 = 保持现值）。端点回读的 provider/model/强度/覆盖表全部一致
  才打印「已热生效」。
  - 端点不可达 / 报错 / 回读不一致：摘要明确打印「未能热生效」+ 原因，按里面给的命令重启桥接即可；
  - 控制台端口取自 config.json 的 consolePort，可用 --console-port 覆盖；--no-hot-apply 可跳过调用。


退出码：0 正常（含无改动退出）/ 1 运行失败或检测到并发修改 / 2 用法错误 / 130 用户 Ctrl+C 取消。

例：
  node scripts/model-tui.mjs
  node scripts/model-tui.mjs --input number
  node scripts/model-tui.mjs --dry-run --input number --script keys.txt
（keys.txt 的写法见上面 --script 一行的转义说明。）
`;

// ── 按键 ─────────────────────────────────────────────────────────────────────
/** 把一段完整的按键文本解析成按键对象数组（转义序列必须完整，否则按 Esc 处理）。 */
function parseKeys(text) {
  const keys = [];
  const s = String(text);
  const ESC_MAP = { A: 'up', B: 'down', C: 'right', D: 'left' };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\x1b') {
      const rest = s.slice(i);
      let m = /^\x1b\[([ABCD])/.exec(rest) || /^\x1bO([ABCD])/.exec(rest);
      if (m) {
        keys.push({ t: ESC_MAP[m[1]] });
        i += m[0].length;
        continue;
      }
      m = /^\x1b\[[0-9;]*[~A-Za-z]/.exec(rest);
      if (m) {
        keys.push({ t: 'unknown', seq: m[0] });
        i += m[0].length;
        continue;
      }
      keys.push({ t: 'esc' });
      i += 1;
      continue;
    }
    if (ch === '\ufeff') { i += 1; continue; } // 文本编辑器可能给脚本文件塞 BOM
    if (ch === '\r' || ch === '\n') { keys.push({ t: 'enter' }); i += 1; continue; }
    if (ch === '\x03') { keys.push({ t: 'ctrl-c' }); i += 1; continue; }
    if (ch === '\x04') { keys.push({ t: 'eof' }); i += 1; continue; }
    if (ch === '\x7f' || ch === '\x08') { keys.push({ t: 'backspace' }); i += 1; continue; }
    if (ch === '\t') { keys.push({ t: 'unknown', seq: 'TAB' }); i += 1; continue; }
    if (ch >= '0' && ch <= '9') { keys.push({ t: 'digit', d: Number(ch) }); i += 1; continue; }
    keys.push({ t: 'char', c: ch });
    i += 1;
  }
  return keys;
}

/** --script 文件里的转义（写在文本文件里就能表达 Esc/Enter，不必塞控制字节）。 */
function decodeScript(text) {
  return String(text).replace(/\\(x[0-9a-fA-F]{2}|[ernbt0\\])/g, (whole, g) => {
    switch (g[0]) {
      case 'x': return String.fromCharCode(parseInt(g.slice(1), 16));
      case 'e': return '\x1b';
      case 'r': return '\r';
      case 'n': return '\n';
      case 't': return '\t';
      case 'b': return '\b';
      case '0': return '\0';
      case '\\': return '\\';
      default: return whole;
    }
  });
}

function readScriptKeys(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM 不是按键
  // 文本编辑器保存时通常会补一个末尾换行；它不该被当成多按一次 Enter。
  if (text.endsWith('\r\n')) text = text.slice(0, -2);
  else if (text.endsWith('\n')) text = text.slice(0, -1);
  return parseKeys(decodeScript(text));
}

// ── 主状态 ───────────────────────────────────────────────────────────────────
const state = {
  entries: [],
  cursor: 0,
  numberBuffer: '', // 编号输入模式：多位数字连打（例如 1 再 2 = 第 12 项）
  submenu: null, // { title, key, items:[{sel,label,detail}], cursor }
  message: '',
  frame: 0,
  done: false,
  orig: null,
  origHash: null, // 启动时读到的 config.json 字节 sha256：落盘前再比一次，防覆盖别人的改动
  work: null,
  format: null,
  ledger: { map: new Map(), readable: true, mtimeMs: null, loadedAt: null },
  // A②/A⑤：模型菜单的唯一数据源（GET /api/dsh/models）；degraded 时菜单退回 DeepSeek 兜底。
  catalog: { loadedAt: null, status: 'idle', degraded: false, source: null, error: null, providers: [] },
  input: 'arrows',
};

function entryLine(entry, index) {
  const idx = String(index + 1);
  if (entry.type === 'session') {
    const sel = effectiveSelection(state.work, entry.key);
    const actual = state.ledger.map.get(entry.key)?.model ?? null;
    return {
      col1: `${entry.kind} ${entry.key}`,
      col2: `${sel.model} · 强度 ${effortDisplay(entry)} (实际: ${actual ?? '无记录'})`,
      col3: overrideOf(state.work, entry.key) ? '［单独设置］' : '［跟随全局］',
    };
  }
  if (entry.type === 'global') {
    const sel = globalSelection(state.work);
    return {
      col1: '全局档位',
      col2: `${sel.model}（provider ${sel.provider}） · 强度 ${effortDisplay(entry)}`,
      col3: '［新会话/未单独设置的会话］',
    };
  }
  const rows = computeChanges(state.orig, state.work);
  return {
    col1: 'exit',
    col2: rows.length ? `保存并退出（改动 ${rows.length} 项）` : '退出（无改动，不写盘）',
    col3: '',
  };
}

function timeOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 发布版（纯净代码包）不查询任何供应商额度：不读取供应商凭据，不请求供应商额度接口，不探测任何额度窗口。
 * 本地模型目录与热生效保留（热生效仍访问本机 127.0.0.1），因此不宣称完全不联网。
 * 保留固定一行说明，避免使用者以为额度显示坏了；--no-quota 只是兼容参数，传不传都不请求额度接口。
 */
function quotaLine() {
  return `额度  ${C.dim}本版本不查询供应商额度/余额（不读取供应商凭据，不请求供应商额度接口；本地模型目录/热更新保留；--no-quota 为兼容参数，不影响行为）${C.reset}`;
}

/** 目录行（A②/A⑤）：正常时报告目录规模与拉取时间；降级时**必须**显示降级 + 原因，不许静默。 */
function catalogLine() {
  const c = state.catalog;
  if (!c || !c.loadedAt) {
    return `目录  ${C.dim}正在读取 ${catalogUrl()} …（DSH 目录 = 模型菜单内容）${C.reset}`;
  }
  if (c.degraded) {
    return `目录  ${C.yellow}已降级：DSH 目录读取失败，已退回仅 DeepSeek 的兜底${C.reset}`
      + ` ${C.dim}（原因：${sanitizeInline(c.error, 240)}；兜底项未经本次目录验证，菜单里标「兜底·未验证」）${C.reset}`;
  }
  const models = c.providers.reduce((n, p) => n + p.models.length, 0);
  return `目录  ${C.green}DSH 模型目录${C.reset} ${c.providers.length} 个 provider / ${models} 个模型`
    + ` ${C.dim}（${timeOf(c.loadedAt)} 拉取，按 r 刷新；菜单内容 = 目录内容）${C.reset}`;
}

function interactiveTty() {
  return Boolean(process.stdout.isTTY) && !state.scriptMode;
}

function emitLines(lines) {
  const body = `${lines.join('\n')}\n`;
  if (interactiveTty()) {
    process.stdout.write(`\x1b[2J\x1b[H${body}`);
  } else {
    state.frame += 1;
    process.stdout.write(`\n───── 渲染帧 ${state.frame} ─────\n${body}`);
  }
}

function render() {
  if (state.done) return;
  reloadLedger(); // 懒加载：只有 token-usage.jsonl 的 mtime 变了才真的重读
  const lines = [];
  lines.push(`${C.bold}模型管理器${C.reset}  ${C.dim}（改动只留在内存，选中 exit 按 Enter 才写盘${state.dryRun ? '；--dry-run：不写盘' : ''}）${C.reset}`);
  lines.push(quotaLine());
  lines.push(catalogLine());
  lines.push(C.dim + '─'.repeat(RULE_WIDTH) + C.reset);

  if (state.submenu) {
    const sm = state.submenu;
    lines.push(`${C.bold}${sm.title}${C.reset}`);
    for (const note of sm.notice ?? []) lines.push(`${C.yellow}${note}${C.reset}`);
    lines.push('');
    for (let i = 0; i < sm.items.length; i += 1) {
      const item = sm.items[i];
      const marker = i === sm.cursor ? '>' : ' ';
      const line = `${marker}${pad(`${i + 1}.`, 4)}${pad(item.label, sm.labelWidth)}${C.dim}${item.detail}${C.reset}`;
      lines.push(i === sm.cursor ? `${C.inv}${line}${C.reset}` : line);
    }
  } else {
    const widths = { col1: 0, col2: 0 };
    const rows = state.entries.map((entry, i) => {
      const r = entryLine(entry, i);
      widths.col1 = Math.max(widths.col1, displayWidth(r.col1));
      widths.col2 = Math.max(widths.col2, displayWidth(r.col2));
      return r;
    });
    for (let i = 0; i < state.entries.length; i += 1) {
      const r = rows[i];
      const marker = i === state.cursor ? '>' : ' ';
      const line = `${marker}${pad(`${i + 1}.`, 4)}${pad(r.col1, widths.col1 + 3)}${pad(r.col2, widths.col2 + 3)}${r.col3}`;
      lines.push(i === state.cursor ? `${C.inv}${line}${C.reset}` : line);
    }
  }

  lines.push(C.dim + '─'.repeat(RULE_WIDTH) + C.reset);
  if (state.submenu) {
    lines.push(`${C.dim}${state.input === 'number' ? '编号=跳到第 N 项（可连打多位数字） · ' : ''}Enter 确认 · Esc/b 返回 · ↕ 选择 · 档位只列该模型目录声明${C.reset}`);
  } else {
    const modeHint = state.input === 'number'
      ? '编号=跳到对应项（多位数字可以直接连打，例如 12）· Enter 打开/确认 · e 选思考强度'
      : '↑/↓ 选择 · Enter 打开模型列表（编号也可以直接跳：1~99）· e 选思考强度';
    lines.push(`${C.dim}${modeHint} · r 刷新目录/实际模型 · Ctrl+C 放弃（不写盘）${C.reset}`);
  }
  const rows = computeChanges(state.orig, state.work);
  lines.push(`${C.dim}内存累计改动：${rows.length} 项${C.reset}`);
  if (state.numberBuffer) lines.push(`${C.cyan}编号输入：${state.numberBuffer}  （Enter 确认这一项）${C.reset}`);
  lines.push(ledgerFootLine());
  if (state.message) lines.push(`${C.yellow}${state.message}${C.reset}`);
  emitLines(lines);
}

/** 脚注：实际模型快照来自哪里、什么时候读的（列表每次重绘按 mtime 懒加载，r 强制重读）。 */
function ledgerFootLine() {
  const at = state.ledger.loadedAt ? new Date(state.ledger.loadedAt) : null;
  const hhmmss = at
    ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:${String(at.getSeconds()).padStart(2, '0')}`
    : '未读到';
  if (!state.ledger.readable) {
    return `${C.dim}实际模型快照：读不到 state/token-usage.jsonl（${hhmmss} 尝试；按 r 重试）${C.reset}`;
  }
  return `${C.dim}实际模型快照：state/token-usage.jsonl @ ${hhmmss}（列表重绘时按 mtime 自动重读，r 强制重读）${C.reset}`;
}

// ── 交互动作 ─────────────────────────────────────────────────────────────────
function currentEntry() {
  return state.entries[state.cursor];
}

function moveCursor(delta) {
  const n = state.entries.length;
  state.cursor = ((state.cursor + delta) % n + n) % n;
  state.message = '';
}

function jumpTo(number) {
  if (number >= 1 && number <= state.entries.length) {
    state.cursor = number - 1;
    state.message = '';
    return true;
  }
  state.message = `没有第 ${number} 项：这里一共 ${state.entries.length} 项（输入 1~${state.entries.length} 之间的编号即可，多位数字可以连打）`;
  return false;
}

/** 目录降级时子菜单顶部的两行说明（A⑤：不静默、不空菜单、不冒称已验证）。 */
function catalogMenuNotice() {
  const menu = catalogProvidersForMenu();
  if (!menu.degraded) return [];
  return [
    `目录降级：DSH 目录读取失败，已退回仅 DeepSeek 的兜底（原因：${sanitizeInline(menu.reason, 200)}）。`,
    '以下兜底项的 provider/model 未经本次目录验证（标「兜底·未验证」）；目录恢复后按 r 重新读取。',
  ];
}

function modelItemDetail(model, { isGlobal, isCurrent, sameAsGlobal }) {
  const bits = [`provider ${model.provider}`];
  if (model.modelName && model.modelName !== model.model) bits.push(model.modelName);
  if (model.fallback) bits.push('兜底·未验证');
  bits.push(effortSummary(model));
  if (isCurrent) bits.push(isGlobal ? '← 当前全局档位' : '← 当前生效档位');
  else if (sameAsGlobal) bits.push('← 与全局相同');
  return bits.join(' · ');
}

/** 二级菜单①：模型列表 = DSH 目录内容（A②）；当前配置里的未知模型显示成「保持当前」（A⑥）。 */
function openModelSubmenu(entry) {
  const isGlobal = entry.type === 'global';
  const models = catalogModelList();
  const cur = isGlobal ? globalSelection(state.work) : effectiveSelection(state.work, entry.key);
  const globalSel = globalSelection(state.work);
  const own = isGlobal ? null : overrideOf(state.work, entry.key);
  const menu = catalogProvidersForMenu();
  const menuName = menu.degraded ? '兜底菜单' : 'DSH 目录';
  const items = [];
  let note = '';
  const curInList = models.some((m) => m.provider === cur.provider && m.model === cur.model);
  if (!curInList) {
    items.push({
      sel: { provider: cur.provider, model: cur.model },
      keepCurrent: true,
      label: `保持当前 ${cur.model}`,
      detail: `provider ${cur.provider} · 不在${menuName}里：选它 = 不改动、不自动改写（A⑥）`,
    });
    note = `（当前 ${cur.provider}/${cur.model} 不在${menuName}里，已显示为「保持当前」，不会自动改写）`;
  }
  for (const m of models) {
    items.push({
      sel: { provider: m.provider, model: m.model },
      model: m,
      label: m.model,
      detail: modelItemDetail(m, {
        isGlobal,
        isCurrent: m.provider === cur.provider && m.model === cur.model,
        sameAsGlobal: !isGlobal && m.provider === globalSel.provider && m.model === globalSel.model,
      }),
    });
  }
  if (!isGlobal) items.push({ sel: FOLLOW_GLOBAL, follow: true, label: '跟随全局', detail: FOLLOW_GLOBAL.label });

  let cursor = 0;
  if (curInList) {
    cursor = items.findIndex((i) => i.model && i.sel.provider === cur.provider && i.sel.model === cur.model);
  }
  if (!isGlobal) {
    if (!own) {
      cursor = items.findIndex((i) => i.follow);
      note = `（${entry.key} 现在就是跟随全局）`;
    } else if (!curInList) {
      cursor = 0;
    }
  }
  if (cursor < 0) cursor = 0;
  const labelWidth = Math.max(...items.map((i) => displayWidth(i.label))) + 3;
  state.submenu = {
    level: 'model',
    title: isGlobal
      ? `选择全局档位（dsh.provider / dsh.model / dsh.reasoningEffort；菜单 = ${menuName}）`
      : `为 ${entry.key} 选择模型（socialV2.modelOverrides；菜单 = ${menuName}）`,
    entry,
    items,
    cursor,
    labelWidth,
    notice: catalogMenuNotice(),
    afterSwitch: null,
  };
  state.message = note;
}

/**
 * 档位提示（A③ 用户授权修订）：档位按目标模型的真实目录声明校验，TUI 不过滤、不映射。
 * 唯一要提醒的是**桥接版本**：只有已包含 t5（A① 授权修订）的桥接才会按目录声明接受
 * medium/xhigh/off；更老的桥接仍只认 low/high/max，会在热更新时 400（改动仍已写盘）。
 */
function effortContractNotice(model) {
  const declared = [];
  if (model?.defaultEffort) declared.push(model.defaultEffort);
  for (const e of model?.efforts ?? []) declared.push(e.id);
  const outsideLegacy = [...new Set(declared)].filter((id) => !ENDPOINT_EFFORT_VALUES.includes(String(id).toLowerCase()));
  if (!outsideLegacy.length) return [];
  return [
    `提示：${outsideLegacy.join('/')} 是目标模型目录声明的档位，会被原样写入配置并原样发给热更新端点（不过滤、不改名）。`
      + `桥接需为含 t5 兼容扩展的版本才会按声明接受它；更老的桥接只认 ${ENDPOINT_EFFORT_VALUES.join('/')}，`
      + '会被 400 拒绝热生效（改动已写盘，重启后按磁盘加载）。这是已知的版本差异，摘要会如实报告成败。',
  ];
}

/** 二级菜单②：思考强度 = 所选模型 reasoning.efforts 的档位（A③）；没有档位时给一条可确认的信息项。 */
function openEffortSubmenu(entry, model, { afterSwitch = null } = {}) {
  const isGlobal = entry.type === 'global';
  const shown = isGlobal ? globalEffortValue() : ownEffortValue(entry);
  const items = [];
  const notice = [];
  if (afterSwitch) notice.push(afterSwitch.summary);
  let cursor = 0;
  if (!model) {
    items.push({
      info: true,
      label: '该模型不在目录里：思考强度未知',
      detail: '不做改动（保持现有 reasoningEffort；目录恢复后可再进来选）',
    });
  } else if (!model.efforts.length) {
    items.push({
      info: true,
      label: model.fallback ? '思考强度未知（兜底·未验证）' : '该模型不支持思考强度',
      detail: model.fallback
        ? '目录不可用，无法确认它声明了哪些档位：直接按 Enter 确认（不写 reasoningEffort）'
        : 'reasoning.efforts 为空：直接按 Enter 确认（不写 reasoningEffort）',
    });
  } else {
    for (const e of model.efforts) {
      const bits = [
        e.name && e.name !== e.id ? e.name : null,
        e.description || null,
        e.id === model.defaultEffort ? '（defaultEffort）' : null,
        shown === e.id ? '← 当前' : null,
      ].filter(Boolean);
      items.push({ effort: e, label: e.id, detail: bits.join(' · '), current: shown === e.id });
    }
    // 全局「留空/跟随」= 写 ""（显式未设置）；会话 = 覆盖表里没有 reasoningEffort（跟随时才是当前）。
    // 全局「缺字段」表示老配置默认 max，不能标成「当前=留空」，否则会把状态说错。
    const clearIsCurrent = isGlobal ? state.work?.dsh?.reasoningEffort === '' : !shown;
    items.push({
      clear: true,
      label: '留空 / 跟随',
      detail: isGlobal
        ? '写 dsh.reasoningEffort = ""（显式未设置：下一条 selectModel 省略该档位、用模型自身默认；缺字段才是旧默认 max）'
        : '从该 key 的覆盖里删掉 reasoningEffort（强度跟随全局）',
      // 当前就是「留空/跟随」时把光标停在这一项 —— 无 default 的模型切过来后按 Enter 才是「保持留空」，
      // 不会被悄悄选中列表第一档。
      current: clearIsCurrent,
    });
    const hit = items.findIndex((i) => i.current);
    cursor = hit >= 0 ? hit : items.findIndex((i) => i.effort && i.effort.id === model.defaultEffort);
  }
  notice.push(...effortContractNotice(model));
  const labelWidth = Math.max(...items.map((i) => displayWidth(i.label))) + 3;
  state.submenu = {
    level: 'effort',
    title: isGlobal
      ? '选择全局思考强度（dsh.reasoningEffort；只列当前模型声明过的档位）'
      : `为 ${entry.key} 选择思考强度（modelOverrides 的 reasoningEffort；只列该模型声明过的档位）`,
    entry,
    model,
    items,
    cursor: Math.max(0, cursor),
    labelWidth,
    notice,
    afterSwitch,
  };
}

function closeSubmenu(explicitMessage) {
  const sm = state.submenu;
  state.submenu = null;
  if (explicitMessage) {
    state.message = explicitMessage;
    return;
  }
  // 从「刚切完模型」的档位菜单里返回：模型改动已经记进内存了，不能说「未改动」（踩过这种误导）。
  if (sm?.level === 'effort' && sm.afterSwitch) {
    state.message = `已返回列表：${sm.afterSwitch.summary}；思考强度保持当前值（未再改动）`;
    return;
  }
  state.message = '已返回列表（未改动）';
}

function effortSnapshot(entry) {
  return JSON.stringify({
    sel: entry.type === 'global' ? globalSelection(state.work) : effectiveSelection(state.work, entry.key),
    // 全局用原始值（区分 undefined 缺字段 / '' 显式未设置 / 具体档位），单会话用覆盖表里的值。
    effort: entry.type === 'global' ? state.work?.dsh?.reasoningEffort : ownEffortValue(entry),
  });
}

function confirmSubmenu() {
  const sm = state.submenu;
  if (!sm) return;
  if (sm.level === 'effort') {
    confirmEffortItem();
    return;
  }
  confirmModelItem();
}

/** 模型项确认：切模型 → 按 A③ 重置 reasoningEffort → 立刻进档位菜单（不给空菜单，也不藏能力）。 */
function confirmModelItem() {
  const sm = state.submenu;
  const item = sm.items[sm.cursor];
  const entry = sm.entry;
  const label = entry.type === 'global' ? '全局档位' : entry.key;
  if (item.follow) {
    applyFollowGlobal(state.work, entry.key);
    state.submenu = null;
    state.message = `已记录（内存）：${entry.key} → 跟随全局（从 modelOverrides 删除该 key，思考强度随之继承全局）`;
    return;
  }
  if (item.keepCurrent) {
    state.submenu = null;
    state.message = `保持当前：${item.sel.model}（provider ${item.sel.provider}）不在当前菜单里，未做任何改动`
      + '（A⑥：配置里的未知模型只显示、不自动改写；要改它请按 Esc 返回后手工处理）';
    return;
  }
  const model = item.model;
  const cur = entry.type === 'global' ? globalSelection(state.work) : effectiveSelection(state.work, entry.key);
  const sameModel = cur.provider === model.provider && cur.model === model.model;
  const beforeEffort = entry.type === 'global' ? globalEffortValue() : ownEffortValue(entry);
  const reset = sameModel ? EFFORT_KEEP : resetEffortModeForModel(model);
  if (entry.type === 'global') applyGlobal(state.work, { provider: model.provider, model: model.model }, reset);
  else applyOverride(state.work, entry.key, { provider: model.provider, model: model.model }, reset);
  const afterEffort = entry.type === 'global' ? globalEffortValue() : ownEffortValue(entry);
  let summary;
  if (sameModel && beforeEffort === afterEffort) {
    summary = `模型未变化：${model.model}（provider ${model.provider}）`;
  } else if (reset.mode === 'set') {
    summary = `已记录（内存）：${label} → ${model.model}（provider ${model.provider}）；`
      + `思考强度已重置为该模型 defaultEffort「${reset.value}」`;
  } else {
    const clearText = entry.type === 'global'
      ? 'reasoningEffort 已留空（dsh.reasoningEffort = ""，跟随模型默认档位）'
      : 'reasoningEffort 已留空/跟随';
    const why = model.fallback
      ? '该兜底模型未经目录验证（档位未知）'
      : (model.efforts.length ? '该模型没有 defaultEffort' : '该模型未声明任何思考档位（不支持思考强度）');
    summary = `已记录（内存）：${label} → ${model.model}（provider ${model.provider}）；${why} ⇒ ${clearText}`;
    if (beforeEffort !== null && beforeEffort !== '') summary += `（原档位「${beforeEffort}」已清除，不残留旧模型的档位）`;
  }
  openEffortSubmenu(entry, model, { afterSwitch: { summary } });
}

/** 档位项确认：把选中的真实档位写进内存（global → dsh.reasoningEffort；会话 → 覆盖表）。 */
function confirmEffortItem() {
  const sm = state.submenu;
  const item = sm.items[sm.cursor];
  const entry = sm.entry;
  const label = entry.type === 'global' ? '全局档位' : entry.key;
  if (item.info) {
    const model = sm.model;
    const before = effortSnapshot(entry);
    if (model) {
      const cur = entry.type === 'global' ? globalSelection(state.work) : effectiveSelection(state.work, entry.key);
      if (entry.type === 'global') applyGlobal(state.work, cur, EFFORT_CLEAR);
      else applyOverride(state.work, entry.key, cur, EFFORT_CLEAR);
    }
    const changed = before !== effortSnapshot(entry);
    const head = model
      ? (model.fallback ? '思考强度未知（兜底·未验证）' : '该模型不支持思考强度')
      : '该模型不在目录里：思考强度未知';
    const tail = model
      ? (changed ? '；reasoningEffort 已留空/跟随（旧档位已清除）' : '；没有需要清除的 reasoningEffort')
      : '；未改动（不臆造能力）';
    state.submenu = null;
    state.message = [sm.afterSwitch?.summary, `${head}，已确认${tail}（${label}）`].filter(Boolean).join('；');
    return;
  }
  const before = effortSnapshot(entry);
  const mode = item.clear ? EFFORT_CLEAR : effortSet(item.effort.id);
  const cur = entry.type === 'global' ? globalSelection(state.work) : effectiveSelection(state.work, entry.key);
  if (entry.type === 'global') applyGlobal(state.work, cur, mode);
  else applyOverride(state.work, entry.key, cur, mode);
  const changed = before !== effortSnapshot(entry);
  const text = item.clear ? '留空/跟随' : item.effort.id;
  let head = changed
    ? `已记录（内存）：${label} 思考强度 → ${text}（${entry.type === 'global' ? 'dsh.reasoningEffort' : '覆盖表 reasoningEffort'}）`
    : (sm.afterSwitch
      ? `保持 ${label} 的思考强度 ${text}（换模型时已重置到该值，未再改动）`
      : `未变化：${label} 的思考强度已经是 ${text}`);
  if (item.clear && entry.type === 'global') {
    head += '；磁盘写 ""（显式未设置，重启也不会回退 max）';
  }
  if (!item.clear && !ENDPOINT_EFFORT_VALUES.includes(String(item.effort.id).toLowerCase())) {
    head += `；提示：该档位已按目录声明原样写入并发给端点；若桥上仍是旧版（只认 ${ENDPOINT_EFFORT_VALUES.join('/')}）会被拒，摘要会如实报告`;
  }
  state.submenu = null;
  state.message = [sm.afterSwitch?.summary, head].filter(Boolean).join('；');
}

/** 主列表里按 e：直接给当前条目的生效模型选思考强度（不换模型）。 */
function openEffortForCurrentEntry() {
  const entry = currentEntry();
  if (!entry) return;
  if (entry.type === 'exit') {
    state.message = 'exit 行没有思考强度可选：先回到某个会话或全局档位上再按 e';
    return;
  }
  const sel = entry.type === 'global' ? globalSelection(state.work) : effectiveSelection(state.work, entry.key);
  openEffortSubmenu(entry, catalogModelFor(sel.provider, sel.model), { afterSwitch: null });
}

function moveSubmenuCursor(delta) {
  const n = state.submenu.items.length;
  state.submenu.cursor = ((state.submenu.cursor + delta) % n + n) % n;
}

/** r：强制重读「实际模型」快照 + 重新读 DSH 目录（A② 的菜单可能变）。本版本不查询任何额度。 */
async function refreshAll() {
  reloadLedger(true); // r 也强制重读「实际模型」快照（与目录一起刷新）
  state.catalog = { ...state.catalog, loading: true };
  render();
  state.catalog = await fetchCatalog();
  render();
}

async function handleKey(key) {
  if (state.done) return;
  switch (key.t) {
    case 'ctrl-c':
      await cancel('收到 Ctrl+C');
      return;
    case 'eof':
      await cancel('stdin 结束（Ctrl+D / EOF）');
      return;
    case 'enter':
      if (state.submenu) {
        state.numberBuffer = '';
        confirmSubmenu();
        render();
      } else {
        const entry = currentEntry();
        if (entry.type === 'exit') await finish();
        else { state.numberBuffer = ''; openModelSubmenu(entry); render(); }
      }
      return;
    case 'up':
      state.numberBuffer = '';
      if (state.submenu) moveSubmenuCursor(-1); else moveCursor(-1);
      render();
      return;
    case 'down':
      state.numberBuffer = '';
      if (state.submenu) moveSubmenuCursor(1); else moveCursor(1);
      render();
      return;
    case 'left':
    case 'right':
      state.message = '左右键未绑定：用 ↑/↓ 移动，Enter 打开/确认（编号也可以直接跳）';
      render();
      return;
    case 'esc':
      state.numberBuffer = '';
      if (state.submenu) { closeSubmenu('已返回列表（未改动）'); render(); }
      else { state.message = 'Esc 只用于子菜单返回；不写盘也不会退出（Ctrl+C 放弃，选中 exit 按 Enter 保存）'; render(); }
      return;
    case 'digit': {
      // 编号输入：数字立刻跳转；连打多位数字时（例如 1 再 2 = 第 12 项）按「能接上就接」处理，
      // 接不上就把这一位当成新编号的开头 —— 列表多长都支持，不再有「只有前 9 项能用数字」的限制。
      const list = state.submenu ? state.submenu.items : state.entries;
      const extended = `${state.numberBuffer}${key.d}`;
      const attempted = Number(extended);
      let target = attempted;
      if (!(target >= 1 && target <= list.length)) {
        target = key.d;
        state.numberBuffer = String(key.d);
      } else {
        state.numberBuffer = extended;
      }
      if (target >= 1 && target <= list.length) {
        if (state.submenu) state.submenu.cursor = target - 1;
        else jumpTo(target);
        state.message = state.numberBuffer.length > 1 ? `已跳到第 ${target} 项` : '';
      } else {
        state.numberBuffer = '';
        state.message = `没有第 ${attempted} 项：这里一共 ${list.length} 项（输入 1~${list.length} 之间的编号即可，多位数字可以连打）`;
      }
      render();
      return;
    }
    case 'backspace':
      state.numberBuffer = state.numberBuffer.slice(0, -1);
      state.message = '';
      render();
      return;
    case 'char': {
      const c = key.c.toLowerCase();
      if (c === 'r') { state.numberBuffer = ''; await refreshAll(); return; }
      if (c === 'b' && state.submenu) { state.numberBuffer = ''; closeSubmenu('已返回列表（未改动）'); render(); return; }
      if (c === 'e' && !state.submenu) { state.numberBuffer = ''; openEffortForCurrentEntry(); render(); return; }
      state.numberBuffer = '';
      state.message = `未绑定的按键：${JSON.stringify(key.c)}（r=刷新目录，e=思考强度，Enter=打开/确认，数字=跳转，Ctrl+C=放弃）`;
      render();
      return;
    }
    default:
      state.message = `忽略按键：${key.seq ?? key.t}`;
      render();
  }
}

async function cancel(reason) {
  state.done = true;
  const rows = computeChanges(state.orig, state.work);
  process.stdout.write(`\n${C.yellow}已取消（${reason}）：未写盘${C.reset}\n`
    + `  config.json 未被改动（内存里累积的 ${rows.length} 项改动已丢弃）\n`);
  await finishAndExit(130);
}

async function finishAndExit(code) {
  await drainBeforeExit(); // 先清残留输入，再恢复终端（顺序不能反：恢复后就交还给外层 shell 了）
  restoreTerminal();
  process.exitCode = code;
  process.exit(code);
}

// ── exit：一次性原子写盘 ─────────────────────────────────────────────────────
async function finish() {
  state.done = true;
  const rows = computeChanges(state.orig, state.work);
  const out = [];
  const push = (line = '') => out.push(line);

  if (!rows.length) {
    push('无改动，未写盘（未新建备份、未改动任何文件）。');
    process.stdout.write(`\n${out.join('\n')}\n`);
    return;
  }

  // 落盘前的并发保护：启动时读到的字节 sha256 与现在磁盘上的不一致，说明**别的进程**改过
  // config.json（控制台保存 / switch-model / 手工编辑）。此时绝不覆盖：把当前磁盘内容备份一份，
  // 中止写盘并说清楚，剩下的交给用户决定。
  const conflict = detectExternalChange();

  if (state.args.dryRun) {
    push(`${C.bold}【--dry-run】${C.reset}不会写盘。将要写入的变更：`);
    for (const r of rows) push(`  - ${r.key} / ${r.field}: ${r.old} → ${r.new}`);
    push(`  目标文件：${path.relative(ROOT, state.args.config) || state.args.config}`);
    push(runSelfCheckSummary() + '（未写盘，仅内存）');
    if (conflict.changed) {
      push(`  ${C.yellow}并发检查：磁盘上的 config.json 与启动时不一致（sha256 ${shortSha(conflict.orig)} → ${shortSha(conflict.now)}）；`
        + `真写盘时会被拒绝，不会覆盖别人的改动。${C.reset}`);
    } else {
      push(`  并发检查：磁盘上的 config.json 与启动时一致（sha256=${shortSha(state.origHash)}），真写盘时可以安全写入。`);
    }
    for (const line of closingHint()) push(line);
    process.stdout.write(`\n${out.join('\n')}\n`);
    return;
  }

  if (conflict.changed) {
    const file = state.args.config;
    const backup = backupPath(file, new Date(), 'conflict');
    fs.copyFileSync(file, backup);
    push(`${C.red}config.json 已被其它进程修改，本次改动未写入。${C.reset}`);
    push(`  启动时 sha256=${shortSha(conflict.orig)} → 现在 sha256=${shortSha(conflict.now)}`);
    push(`  磁盘上的当前内容（含别人的改动）已备份：${path.basename(backup)}`);
    push(`  本次内存里的改动（${rows.length} 项）已丢弃；确认外部改动没问题后重新打开本工具再做一次即可。`);
    push('  变更摘要（key / 字段 / 旧→新，**未写入**）：');
    for (const r of rows) push(`  - ${r.key} / ${r.field}: ${r.old} → ${r.new}`);
    process.stdout.write(`\n${out.join('\n')}\n`);
    await finishAndExit(1);
    return;
  }

  const file = state.args.config;
  const backup = backupPath(file);
  fs.copyFileSync(file, backup);
  const nextText = serializeConfig(state.work, state.format);
  const tmp = `${file}.tmp-tui-${process.pid}`;
  fs.writeFileSync(tmp, nextText, 'utf8');
  let renamed = false;
  let lastError = null;
  for (let attempt = 1; attempt <= 3 && !renamed; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      renamed = true;
    } catch (error) {
      lastError = error;
      await sleep(120);
    }
  }
  if (!renamed) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error(`原子替换失败（${lastError?.code ?? lastError?.message}），已保留备份 ${path.basename(backup)}，原文件未改动`);
  }

  // 回读自检：磁盘上的 JSON 必须与内存里的工作副本一致。
  const { value: readBack } = readJsonFile(file);
  const same = deepEqualJson(readBack, state.work);
  const newSha = fileSha256(file);
  push(`${C.green}【写盘完成】${C.reset}${path.relative(ROOT, file) || file}`);
  push(`  备份：${path.basename(backup)}（写入前的原始字节）`);
  push(`  自检：回读 JSON 与内存一致 = ${same ? '是' : '否'}；sha256 ${shortSha(state.origHash)} → ${shortSha(newSha)}`);
  if (!same) {
    push(`  ${C.red}自检失败：回读内容与内存不一致，请立即用备份还原：copy /Y "${backup}" "${file}"${C.reset}`);
    process.stdout.write(`\n${out.join('\n')}\n`);
    await finishAndExit(1);
    return;
  }
  push(`  写盘范围：只按内存快照重写这份 config.json（其它字段原样保留）；写前已确认磁盘内容与启动时一致，没有覆盖别人的改动。`);
  push('变更摘要（key / 字段 / 旧→新）：');
  for (const r of rows) push(`  - ${r.key} / ${r.field}: ${r.old} → ${r.new}`);
  push(`本次改动 ${rows.length} 项。`);

  // 写盘之后：调桥接端点热生效，不重启就换档。失败也绝不谎报（见 hotApplyModel）。
  const hot = await hotApplyModel();
  for (const line of hot.lines) push(line);
  for (const line of closingHintState(hot.state, hot)) push(line);
  process.stdout.write(`\n${out.join('\n')}\n`);
}

// ── 热生效：POST /api/dsh/model（写盘之后才调）─────────────────────────────────
/** 稳定 JSON（对象键排序、数组保序）——用来比对端点回读的覆盖表与内存快照是否同形。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function consolePort() {
  if (state.args.consolePort) return state.args.consolePort;
  const fromConfig = Number(state.orig?.consolePort);
  return Number.isInteger(fromConfig) && fromConfig >= 1 && fromConfig <= 65535 ? fromConfig : 3100;
}

/**
 * 控制台令牌，解析顺序与桥接自己一致（src/bridge.js 的 loadOrCreateConsoleToken 那一段）：
 *   ① 环境变量 BRIDGE_CONSOLE_TOKEN（测试 / 临时覆盖用，最高优先）；
 *   ② config.json 里手配的 consoleToken（**已加载**在 state.orig 里，不用再读盘）；
 *   ③ state/console-token —— 桥接在「配置里没配」时自动生成并落盘的那份，也就是常态。
 * 之前漏了 ②：那时 config 里配了令牌但没生成 state/console-token 的部署会 401（文档却写着先读 config）。
 */
function consoleToken() {
  const fromEnv = String(process.env.BRIDGE_CONSOLE_TOKEN ?? '').trim();
  if (fromEnv) return { token: fromEnv, source: 'BRIDGE_CONSOLE_TOKEN' };
  const fromConfig = String(state.orig?.consoleToken ?? '').trim();
  if (fromConfig) return { token: fromConfig, source: 'config.json' };
  try {
    const fromFile = String(fs.readFileSync(path.join(STATE_DIR, 'console-token'), 'utf8')).trim();
    if (fromFile) return { token: fromFile, source: 'state/console-token' };
  } catch {}
  return { token: '', source: '(没有可用令牌)' };
}

/** 期望的内存状态：用来比对端点回读值（applied）与我们要的结果是否一致。 */
function expectedApplied() {
  const sel = globalSelection(state.work);
  return {
    provider: sel.provider,
    model: sel.model,
    // null = 未设置（留空/跟随）。t5 修订后端点的 applied 应回 null/''；对不上就如实判失败。
    reasoningEffort: globalEffortValue(),
    modelOverrides: overrideTable(state.work),
  };
}

/** 端点的空值表达可能是 null / ''，统一成 null 再比对。 */
function normalizeEffortValue(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

/**
 * 覆盖表比对前做等价归一：`reasoningEffort: null` 与「字段不存在」都是「留空/跟随」，
 * 不能因为桥接内存里多留了一个 null 就误报「回读值对不上」（t5 会尽量删掉该字段，这里兜一层）。
 */
function normalizeOverridesForCompare(table) {
  if (!table || typeof table !== 'object') return table ?? null;
  const out = {};
  for (const [key, value] of Object.entries(table)) {
    if (!value || typeof value !== 'object') { out[key] = value; continue; }
    const entry = {};
    for (const [field, v] of Object.entries(value)) {
      if (field === 'reasoningEffort' && (v === null || v === '')) continue;
      entry[field] = v;
    }
    out[key] = entry;
  }
  return out;
}

/**
 * 只需发给端点的补丁 —— **只包含本次真正改到的字段**。
 *
 * 为什么必须精确：端点是「读盘 → 只改这些字段 → 原子写」，它按自己的方式重建覆盖表
 * （nextOverrideTable：显式字段覆盖、其余字段从磁盘保留）。所以：
 *   - 单会话的新值 = 该 key 覆盖表里本次要写的字段（provider/model + 档位）；
 *   - **档位清空必须显式发 null**：省略字段会被端点理解成「保持现值」（旧语义），残留旧档位；
 *   - 「跟随全局」= removeOverrides（不是写全局值）；
 *   - 全局档位 = provider / model / reasoningEffort（null = 清空）。
 * 档位一律**原样**发送目录声明值（medium/xhigh/off…），由桥接按目标模型真实能力校验，TUI 不过滤。
 */
function endpointPatch() {
  const patch = {};
  const removals = [];
  const origTable = overrideTable(state.orig);
  const workTable = overrideTable(state.work);
  for (const key of Object.keys(workTable)) {
    if (canonicalJson(workTable[key]) === canonicalJson(origTable[key])) continue;
    const w = workTable[key] ?? {};
    const o = origTable[key] ?? {};
    const entry = {};
    if (w.provider !== undefined) entry.provider = w.provider;
    if (w.model !== undefined) entry.model = w.model;
    if (w.reasoningEffort !== undefined) entry.reasoningEffort = w.reasoningEffort;
    else if (o.reasoningEffort !== undefined) entry.reasoningEffort = null; // 磁盘已清空 → 端点也显式清空
    patch[key] = entry;
  }
  for (const key of Object.keys(origTable)) {
    if (!(key in workTable)) removals.push(key);
  }
  const dsh = {};
  for (const field of ['provider', 'model']) {
    if (state.work?.dsh?.[field] !== state.orig?.dsh?.[field]) dsh[field] = state.work.dsh[field];
  }
  // 全局档位：null = 显式清空（t5 协议）；字符串原样发，由桥接按目标模型目录声明校验。
  if (JSON.stringify(state.work?.dsh?.reasoningEffort) !== JSON.stringify(state.orig?.dsh?.reasoningEffort)) {
    const v = state.work?.dsh?.reasoningEffort;
    dsh.reasoningEffort = (v === undefined || v === null || v === '') ? null : v;
  }
  return { dsh, patch, removals };
}

/**
 * 写盘成功后调一次运行中桥接的 POST /api/dsh/model：热更新内存档位 + 递增 epoch，
 * 已存在的会话在下一条消息就地重新 selectModel（不重启、不丢上下文）。
 *
 * 返回 { attempted, state, lines, ... }；state ∈ ok | failed | unreachable | mismatch | skipped-*。
 * **任何失败都不改磁盘、不静默、也不谎报成功**：说不清就按「需重启」处理。
 */
async function hotApplyModel() {
  const lines = [];
  const file = path.resolve(state.args.config);
  const patchPlan = endpointPatch();
  if (state.args.noHotApply) return { attempted: false, state: 'skipped-flag', lines };
  // 端点永远写它自己 ROOT 下的 config.json；--config 指向别处时绝不调它（否则会改到真配置）。
  if (file !== path.resolve(CONFIG_FILE)) {
    return { attempted: false, state: 'skipped-config', file, lines };
  }
  if (!Object.keys(patchPlan.dsh).length && !Object.keys(patchPlan.patch).length && !patchPlan.removals.length) {
    return { attempted: false, state: 'skipped-noop', lines };
  }

  const { dsh, patch, removals } = patchPlan;
  const body = { ...dsh };
  if (Object.keys(patch).length) body.modelOverrides = patch;
  if (removals.length) body.removeOverrides = removals;
  const port = consolePort();
  const { token, source: tokenSource } = consoleToken();
  const url = `http://127.0.0.1:${port}/api/dsh/model`;
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-console-token'] = token;

  let res;
  let text = '';
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    text = await res.text();
  } catch (error) {
    return {
      attempted: true, state: 'unreachable', port, url, tokenSource,
      reason: `${error?.name === 'TimeoutError' ? '4 秒超时' : (error?.cause?.code ?? error?.message ?? error)}`,
      lines,
    };
  }

  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok || !json?.ok) {
    // 401/403 时把「令牌取自哪里」带出来，省得用户对着「未授权」猜。
    const authHint = (res.status === 401 || res.status === 403)
      ? `；令牌来源：${tokenSource}${token ? '' : '（当前没有取到任何令牌）'}`
      : '';
    return {
      attempted: true, state: 'failed', port, url, tokenSource,
      reason: `HTTP ${res.status} ${String(json?.error ?? text).trim().slice(0, 160)}${authHint}`,
      lines,
    };
  }

  // 端点 ok 也要核对回读值：档位（含思考强度）必须真的等于我们写进磁盘的值，覆盖表必须与内存快照同形。
  const want = expectedApplied();
  const applied = json.applied ?? {};
  const diffs = [];
  if (String(applied.provider ?? '') !== want.provider) diffs.push(`provider 期望 ${want.provider}、桥接回读 ${applied.provider}`);
  if (String(applied.model ?? '') !== want.model) diffs.push(`model 期望 ${want.model}、桥接回读 ${applied.model}`);
  // 只有本次真的发过 reasoningEffort 才比对——没发的字段端点保持原值，与本次改动无关。
  if (Object.prototype.hasOwnProperty.call(dsh, 'reasoningEffort')) {
    const wantEffort = normalizeEffortValue(want.reasoningEffort);
    const gotEffort = normalizeEffortValue(applied.reasoningEffort);
    if (wantEffort !== gotEffort) {
      diffs.push(`reasoningEffort 期望 ${wantEffort ?? '(清空/未设置)'}、桥接回读 ${gotEffort ?? '(空)'}`);
    }
  }
  if (applied.modelOverrides !== undefined
    && canonicalJson(normalizeOverridesForCompare(applied.modelOverrides))
      !== canonicalJson(normalizeOverridesForCompare(want.modelOverrides))) {
    diffs.push('modelOverrides 回读值与内存快照不一致');
  }
  if (diffs.length) return { attempted: true, state: 'mismatch', port, url, tokenSource, reason: diffs.join('；'), lines };
  // 本次真正发出去的档位改动（全局 + 覆盖表），只用于摘要里说「强度也同步了」；没发的不吹。
  const sentEfforts = [];
  if (Object.prototype.hasOwnProperty.call(dsh, 'reasoningEffort')) {
    sentEfforts.push(`${dsh.reasoningEffort === null ? '清空' : dsh.reasoningEffort}（全局）`);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value && Object.prototype.hasOwnProperty.call(value, 'reasoningEffort')) {
      sentEfforts.push(`${value.reasoningEffort === null ? '清空' : value.reasoningEffort}（${key}）`);
    }
  }
  return {
    attempted: true, state: 'ok', port, url, tokenSource,
    applied, wrote: json.wrote === true,
    changes: json.changes ?? [], epoch: json.epoch, lines,
    effortSent: sentEfforts.length > 0,
    sentEffortText: sentEfforts.join('、'),
  };
}

/** 写盘后的生效提示。按行给，免得窄终端里折行折得难看。 */
function closingHintState(hotState, hot = {}) {
  const port = hot.port ?? consolePort();
  switch (hotState) {
    case 'ok': {
      // 真端点的常态是 wrote:false：本工具已经把 config.json 写好，端点重读后「该改的字段已经是目标值」，
      // 于是只同步内存、不写盘不备份不递增 epoch。别把它说成「桥接又改写了一遍」，也别拿 epoch 冒充变化。
      const changed = Array.isArray(hot.changes) ? hot.changes.length : 0;
      const effortNote = hot.effortSent
        ? `；思考强度${hot.sentEffortText ? `（${hot.sentEffortText}）` : ''}也已同步（端点回读一致）`
        : '';
      if (hot.wrote) {
        const epoch = Number.isFinite(Number(hot.epoch)) ? `（档位 epoch 已递增到 ${hot.epoch}）` : '';
        return [
          `${C.green}已热生效${C.reset}：端点又改写了 ${changed} 处并同步了内存${epoch}${effortNote}，**下一条消息生效**（不重启、不丢上下文）。`,
          '  桥接侧也留了一份写前备份（config.json.bak-model-<时间戳>，见 bridge.log），本工具自己的备份见上面。',
        ];
      }
      return [
        `${C.green}已热生效${C.reset}：桥接内存档位已同步（端点回读一致、wrote:false —— 磁盘已由本工具写好，无需再写、未递增 epoch）${effortNote}，**下一条消息生效**（不重启、不丢上下文）。`,
      ];
    }
    case 'unreachable':
    case 'failed':
    case 'mismatch': {
      const why = hotState === 'unreachable'
        ? `调不到桥接端点 http://127.0.0.1:${port}/api/dsh/model（${hot.reason}）`
        : hotState === 'failed'
          ? `桥接端点拒绝了这次热更新（${hot.reason}）`
          : `桥接端点返回 ok 但回读值对不上（${hot.reason}）`;
      const lines = [
        `${C.yellow}未能热生效${C.reset}：${why}。`,
        '  config.json 已经写好，改动**不会丢**；但运行中的桥接仍用旧档位，**下一条消息还是旧模型**。',
        '  让它生效：运行 restart.bat（或关掉再双击 start.bat）。重启只清内存态，会话映射与上下文都不动。',
        '  若桥接本来就没在跑，下次启动自然读到新配置，不用额外操作。',
      ];
      if (hotState === 'failed' && /reasoningEffort|reasoning.?effort|思考强度|effort/i.test(String(hot.reason ?? ''))) {
        lines.push(
          `  ${C.yellow}这次拒绝点名了思考强度${C.reset}：目录档位（medium/xhigh/off…）只有含 t5 兼容扩展的桥接`
            + '才会按目标模型声明接受，旧版桥接只认 low/high/max。配置文件已按目录声明原样写好（未改名、未降级），'
            + '重启到含 t5 的桥接后按磁盘加载即可。',
        );
      }
      return lines;
    }
    case 'skipped-flag':
      return [
        `${C.dim}（--no-hot-apply：写盘后没有调热更新端点）${C.reset}`,
        '  要生效：运行 restart.bat（或到控制台保存一次设置）后，下一条消息才会用新档位。',
      ];
    case 'skipped-config':
      return [
        `${C.dim}（--config 指向 ${hot.file ?? '非仓库配置'}，已跳过热生效：端点只会写它自己那份 config.json）${C.reset}`,
        '  要让真实桥接生效，请对仓库根的 config.json 再跑一次本工具，或运行 restart.bat。',
      ];
    default:
      return ['（没有需要热生效的字段变化）'];
  }
}

/** 写盘前（--dry-run / 冲突路径）用的静态提示。 */
function closingHint() {
  const port = state.orig?.consolePort ?? 3100;
  return [
    '生效方式：真写盘时本工具会调一次 POST /api/dsh/model 热生效（摘要会写明「已热生效」或「未能热生效」）；',
    `  未能热生效时才需要重启桥接（restart.bat / start.bat 守护），或到控制台 http://127.0.0.1:${port} 保存一次设置。`,
    '  重启只清内存态（档位指纹等），state/sessions.json 的会话映射与上下文都不动。',
  ];
}

function shortSha(hex) {
  return hex ? `${String(hex).slice(0, 16)}…` : '(未知)';
}

/** 重新读盘比对启动时的 sha256：返回 {changed, orig, now}。 */
function detectExternalChange() {
  let now = null;
  try {
    now = sha256Hex(fs.readFileSync(state.args.config));
  } catch {
    return { changed: true, orig: state.origHash, now: null, unreadable: true };
  }
  return { changed: now !== state.origHash, orig: state.origHash, now };
}

function runSelfCheckSummary() {
  const rows = computeChanges(state.orig, state.work);
  return `将写入的变更共 ${rows.length} 项`;
}

// ── 终端状态 ─────────────────────────────────────────────────────────────────
let rawModeOn = false;
let escTimer = null;
let cleaned = false;
let drainDone = false;

/**
 * 退出前把 stdin 里排队的残留输入读掉（**防御性加固，不是那个假命令现象的修复**）。
 *
 * 背景：曾有用户报告「双击运行后，TUI 退出时外层 shell 执行两行『不是内部或外部命令』的假命令，
 * 碎片像 'on'、'◆互终端'」。**真因已查明**（2026-10-12，队长用真 ConPTY 二分 + 我独立复现）：
 * 那两行来自 `模型管理.bat` 里的**非 ASCII echo/rem 行**在「ConPTY 控制台 + chcp 65001」下被 cmd
 * 拆坏，碎片被当成命令执行 —— 与输入残留无关，修法是让 bat 文件保持纯 ASCII。
 *
 * 那这里为什么还留着？因为它挡的是另一件真实存在的边角情况：退出瞬间还排在控制台缓冲里的多余按键，
 * 会被外层 shell（cmd 提示符 / bat 末尾的 pause）读走当命令。做法是在**恢复终端状态之前**读空并丢弃：
 *   - POSIX：raw mode 下 stdin 是非阻塞的，`fs.readSync` 循环读到 EAGAIN 即停（不会挂住）；
 *   - Windows：控制台句柄的**同步**读在没有输入时会阻塞（纯 JS 没有
 *     GetNumberOfConsoleInputEvents 可以先问"有没有"），所以改成「flowing 读 + 静默窗口」：
 *     resume 后把到达的字节计数丢弃，静默 DRAIN_IDLE_MS（可用 --drain-ms 调，0 = 关掉）就返回，全程不阻塞。
 * 两者语义一致：吃掉「此刻已经躺在缓冲里的输入」。**不承诺**能治任何退出后才出现的输入 ——
 * 那属于外层 shell 的正常输入，任何程序都无能为力。
 */
const DRAIN_IDLE_MS = 80;
const DRAIN_MAX_MS = 400;
const drainState = { active: false, bytes: 0, lastAt: 0 };

function drainPendingInput() {
  if (drainDone) return Promise.resolve({ bytes: 0, skipped: true });
  drainDone = true;
  // 只有真·交互（raw mode 开着）才有"残留输入被外层 shell 读走"这回事；
  // --script / 非 TTY 路径 stdin 是文件或管道，外层 shell 也不会去读它。
  if (!rawModeOn || !process.stdin.isTTY) return Promise.resolve({ bytes: 0, skipped: true });
  const drainIdleMs = Number.isFinite(state.args?.drainMs) ? state.args.drainMs : DRAIN_IDLE_MS;
  if (drainIdleMs <= 0) return Promise.resolve({ bytes: 0, skipped: true, mode: 'off' });
  if (process.platform !== 'win32') {
    let bytes = 0;
    const buf = Buffer.alloc(4096);
    for (let i = 0; i < 256; i += 1) {
      let n = 0;
      try {
        n = fs.readSync(0, buf, 0, buf.length, null);
      } catch (error) {
        // EAGAIN/EWOULDBLOCK = 此刻没有更多输入（raw mode 下就是非阻塞）；EOF/ENXIO 同理收工。
        break;
      }
      if (!n) break;
      bytes += n;
    }
    return Promise.resolve({ bytes, skipped: false, mode: 'readSync' });
  }
  try { process.stdin.resume(); } catch {}
  return new Promise((resolve) => {
    drainState.active = true;
    drainState.bytes = 0;
    drainState.lastAt = Date.now();
    const started = Date.now();
    const tick = () => {
      const idle = Date.now() - drainState.lastAt;
      const total = Date.now() - started;
      if (idle >= drainIdleMs || total >= Math.max(DRAIN_MAX_MS, drainIdleMs * 3)) {
        drainState.active = false;
        resolve({ bytes: drainState.bytes, ms: total, skipped: false, mode: 'idle-window' });
        return;
      }
      setTimeout(tick, 20);
    };
    setTimeout(tick, 20);
  });
}

/** 退出前清空 + 一行如实的说明（只在真读到东西时打印，免得正常退出也刷屏）。 */
async function drainBeforeExit() {
  const result = await drainPendingInput();
  if (result.bytes > 0) {
    process.stdout.write(`\n（防御性清理：退出前丢弃了 ${result.bytes} 字节残留输入 —— 免得退出后被外层 shell 当命令执行）\n`);
  }
  return result;
}

function restoreTerminal() {
  if (escTimer) { clearTimeout(escTimer); escTimer = null; }
  if (process.stdin.isTTY) {
    try {
      if (rawModeOn && typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(false);
      process.stdin.pause();
    } catch {}
  }
  rawModeOn = false;
  if (process.stdout.isTTY && !cleaned) {
    // 显示光标 + 复位所有属性（若之前 hide 过，这里一定补回来）
    process.stdout.write('\x1b[?25h\x1b[0m');
  }
  cleaned = true;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n\n${HELP}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  state.args = args;
  state.input = args.input;
  state.dryRun = args.dryRun;
  state.scriptMode = Boolean(args.script);

  if (!fs.existsSync(args.config)) {
    process.stderr.write(`找不到配置文件：${args.config}\n`);
    return 1;
  }
  const { raw, value } = readJsonFile(args.config);
  state.orig = value;
  state.origHash = sha256Hex(fs.readFileSync(args.config)); // 落盘前要比对的「启动时字节哈希」
  state.work = JSON.parse(JSON.stringify(value));
  state.format = detectFormat(raw);

  const sessions = sessionKeys(state.orig);
  state.entries = [
    ...sessions.map((s) => ({ type: 'session', key: s.key, kind: s.kind })),
    { type: 'global' },
    { type: 'exit' },
  ];
  state.cursor = 0;
  state.ledger = actualModelsByKey();

  // 目录：先渲染一帧（加载中），再读本地桥接的只读接口 GET /api/dsh/models 后重绘。
  // 本版本不查询任何供应商额度（不读取供应商凭据，不请求供应商额度接口；本地模型目录/热更新保留）；--no-quota 仍被接受，但只是兼容参数。
  state.catalog = { loadedAt: null, status: 'loading', degraded: false, source: null, error: null, providers: [], loading: true };
  render();
  state.catalog = await fetchCatalog();
  render();

  if (args.script) {
    let keys;
    try {
      keys = readScriptKeys(args.script);
    } catch (error) {
      process.stderr.write(`读不到按键脚本：${args.script}（${error?.message ?? error}）\n`);
      return 2;
    }
    for (const key of keys) {
      if (state.done) break;
      try {
        await handleKey(key);
      } catch (error) {
        process.stderr.write(`处理按键时出错：${error?.stack ?? error}\n`);
        return 1;
      }
    }
    if (!state.done) {
      process.stdout.write(`\n按键脚本结束（${keys.length} 个按键），没有选中 exit：未写盘，config.json 未改动。\n`);
    }
    return 0;
  }

  if (!process.stdin.isTTY) {
    process.stderr.write('需要交互式终端（TTY）：stdin 不是 TTY。用 --script <文件> 跑按键序列，或在真实终端里运行。\n');
    return 2;
  }

  process.stdout.write('\x1b[?25l');
  process.stdin.setEncoding('utf8');
  if (typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(true);
    rawModeOn = true;
  }
  process.stdin.resume();

  let buffer = '';
  const flush = () => {
    const text = buffer;
    buffer = '';
    for (const key of parseKeys(text)) {
      if (state.done) return;
      chain = chain.then(() => handleKey(key)).catch((error) => {
        process.stderr.write(`处理按键时出错：${error?.stack ?? error}\n`);
        restoreTerminal();
        process.exit(1);
      });
    }
  };
  let chain = Promise.resolve();

  process.stdin.on('data', (chunk) => {
    // 退出清残留期间的字节只计数、不解析（drainBeforeExit 正在把它们丢掉）。
    if (drainState.active) {
      drainState.bytes += Buffer.byteLength(chunk);
      drainState.lastAt = Date.now();
      return;
    }
    if (state.done) return;
    buffer += chunk;
    if (escTimer) { clearTimeout(escTimer); escTimer = null; }
    // 停在半个转义序列上（孤立的 ESC 或 ESC [）：等一小会儿，确认没后续字节再当 Esc 处理。
    if (/\x1b(\[[0-9;]*)?$/.test(buffer)) {
      escTimer = setTimeout(() => { escTimer = null; flush(); }, 45);
      return;
    }
    flush();
  });
  process.stdin.on('end', () => {
    if (!state.done) cancel('stdin 结束');
  });
  process.stdin.on('error', (error) => {
    if (!state.done) cancel(`stdin 出错（${error?.message ?? error}）`);
  });

  // 一直等到 done（finish/cancel 里会 process.exit）
  await new Promise((resolve) => {
    const tick = setInterval(() => {
      if (state.done) { clearInterval(tick); resolve(); }
    }, 50);
    tick.unref?.();
  });
  return 0;
}

process.on('SIGINT', () => {
  if (!state.done) {
    state.done = true;
    process.stdout.write('\n\x1b[0m已取消（SIGINT / Ctrl+C）：未写盘，config.json 未改动。\n');
  }
  restoreTerminal();
  process.exit(130);
});

process.on('SIGTERM', () => {
  if (!state.done) state.done = true;
  restoreTerminal();
  process.exit(143);
});

// Windows 上 Ctrl+Break（SIGBREAK）是能捕获的那种"中断"信号。
process.on('SIGBREAK', () => {
  if (!state.done) {
    state.done = true;
    process.stdout.write('\n\x1b[0m已取消（SIGBREAK / Ctrl+Break）：未写盘，config.json 未改动。\n');
  }
  restoreTerminal();
  process.exit(130);
});

process.on('uncaughtException', (error) => {
  restoreTerminal();
  process.stderr.write(`\n意外异常：${error?.stack ?? error}\n（未写盘；config.json 未改动）\n`);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  restoreTerminal();
  process.stderr.write(`\n未处理的 Promise 拒绝：${error?.stack ?? error}\n（未写盘；config.json 未改动）\n`);
  process.exit(1);
});

process.on('exit', () => {
  restoreTerminal();
});

main()
  .then(async (code) => {
    await drainBeforeExit(); // 正常出口也先把残留输入清掉，再恢复终端
    restoreTerminal();
    process.exitCode = code;
  })
  .catch((error) => {
    restoreTerminal();
    process.stderr.write(`运行失败：${error?.stack ?? error}\n（未写盘；config.json 未改动）\n`);
    process.exitCode = 1;
  });
