/**
 * Fish Diary 控制台配置（P2 方案 C，任务卡 §7）。
 *
 * 职责：`state/diary-config.json` 的读写与校验。这个文件与 config.json **分离**，
 * 目的是「控制台改完立即生效」——桥接每次调用都重读它（不做缓存：读一个几百字节的小文件
 * 比维护 mtime 失效逻辑更不容易出错），不需要重启桥接
 * （彻底从 MCP 注册表里移除工具 schema 才需要重启 DSH，见任务卡）。
 *
 * 刻意做的事与不做的：
 *  · **导入零 I/O**：import 阶段不建目录、不读文件、不碰 state/。
 *  · **先校验后落盘**：整个 patch 校验通过才写盘；写盘用同目录临时文件 + rename。
 *  · **默认值单一来源**：限额默认值直接取 diary-store 的 DEFAULT_LIMITS，不复制常量。
 *  · **坏配置不静默改行为**：读不出来时返回默认值 + corrupt 标记（调用方在控制台显式提示），
 *    不在这里做「关掉日记」这种破坏性推断。写入额度仍然由 store 自己兜底。
 */
import fsDefault from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_LIMITS } from './diary-store.mjs';

/** 相对仓库根（ROOT）的配置路径；桥接负责拼绝对路径。 */
export const DIARY_CONFIG_RELATIVE_PATH = 'state/diary-config.json';

/** 四个 AI 工具的开关名（与控制台复选框、MCP 工具名一一对应）。 */
export const DIARY_TOOL_NAMES = Object.freeze(['read', 'edit', 'write', 'delete']);

/**
 * 桥接 HTTP 请求体的硬上限（字节）。**这是唯一事实来源**：src/bridge.js 的 readBody()
 * 直接 import 它当 MAX_BODY_BYTES，控制台限额校验也以它为界。
 *
 * 为什么是 1000000 而不是 1MB（1048576）或 100MB：
 *  · 桥接在**读到任何业务端点之前**就按 Content-Length / 累计字节把超过该值的请求体
 *    413 掉，所以「日记单次写入上限」配得再大，实际能进来的正文也不可能超过它。
 *  · 1_000_000 是既有全局值（改它会影响 /api/* 全部端点，属于单独评估的全局改动），
 *    这里只把它做成单一常量，避免 diary 侧再写一个 1048576 与它互相矛盾。
 *  · 因此控制台允许配置的 maxPayloadBytes 上限 = 该值；配得更大只会在 HTTP 层先失败，
 *    错误文案还会说「超过 1MB」，与用户配置值互相打脸（这就是修这个缺陷的原因）。
 */
export const DIARY_HTTP_MAX_BODY_BYTES = 1_000_000;

/**
 * 可在控制台编辑的限额项与合法区间。
 * 上限不设成无限：控制台一次手滑写成 1e9 会把日记文件撑爆，这些边界是防呆而非业务规则。
 * maxPayloadBytes 的上限**必须**等于 HTTP 体上限（DIARY_HTTP_MAX_BODY_BYTES），
 * 否则「配得进去但用不了」——桥接会在读 body 阶段先 413，用户还会看到「超过 1MB」的文案。
 */
export const DIARY_LIMIT_SPECS = Object.freeze({
  maxFileBytes: { min: 1024, max: 100 * 1024 * 1024 },
  maxPayloadBytes: { min: 1, max: DIARY_HTTP_MAX_BODY_BYTES },
  dailyWrites: { min: 1, max: 1000 },
  backupKeep: { min: 1, max: 200 },
});

function configError(message) {
  const error = new Error(message);
  error.code = 'bad-diary-config';
  return error;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 任务卡 §4 的默认值：10MB / 1MB / 10 次 / 备份 10；总开关与四个工具默认全开。
 *
 * maxPayloadBytes 取 min(store 默认 1MB, HTTP 体上限)：store 的 1048576 比桥接能收进来的
 * 请求体还大 48576 字节，照抄过来就是一个「配了也用不到」的默认（旧版缺陷）。
 */
export function defaultDiaryConfig() {
  return {
    schemaVersion: 1,
    enabled: true,
    tools: { read: true, edit: true, write: true, delete: true },
    limits: {
      maxFileBytes: DEFAULT_LIMITS.maxFileBytes,
      maxPayloadBytes: Math.min(DEFAULT_LIMITS.maxPayloadBytes, DIARY_HTTP_MAX_BODY_BYTES),
      dailyWrites: DEFAULT_LIMITS.dailyWrites,
      backupKeep: DEFAULT_LIMITS.backupKeep,
    },
  };
}

/**
 * 严格归一化：未知字段一律报错（静默忽略会让用户以为「改了但没生效」）。
 * 缺失字段取默认值，因此这个函数既能校验整份文件，也能校验**部分提交**的 patch。
 */
export function normalizeDiaryConfig(raw) {
  const out = defaultDiaryConfig();
  if (raw === undefined || raw === null) return out;
  if (!isPlainObject(raw)) throw configError('日记配置必须是 JSON 对象');
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
    throw configError(`不支持的 schemaVersion：${String(raw.schemaVersion)}（只接受 1）`);
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw configError('enabled 必须是 true/false');
    out.enabled = raw.enabled;
  }
  if (raw.tools !== undefined) {
    if (!isPlainObject(raw.tools)) throw configError('tools 必须是对象（read/edit/write/delete → true/false）');
    for (const [key, value] of Object.entries(raw.tools)) {
      if (!DIARY_TOOL_NAMES.includes(key)) {
        throw configError(`未知的日记工具开关：${key}（只接受 ${DIARY_TOOL_NAMES.join('/')}）`);
      }
      if (typeof value !== 'boolean') throw configError(`tools.${key} 必须是 true/false`);
      out.tools[key] = value;
    }
  }
  if (raw.limits !== undefined) {
    if (!isPlainObject(raw.limits)) throw configError('limits 必须是对象');
    for (const [key, value] of Object.entries(raw.limits)) {
      const spec = DIARY_LIMIT_SPECS[key];
      if (!spec) throw configError(`未知的限额项：${key}（只接受 ${Object.keys(DIARY_LIMIT_SPECS).join('/')}）`);
      const n = Number(value);
      if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
        // maxPayloadBytes 的超限要单独解释：它不是随便定的防呆上限，而是桥接 HTTP 请求体
        // 的硬上限（超过就 413，压根到不了 diary-store）。不写清原因，用户会以为这是 bug。
        if (key === 'maxPayloadBytes' && Number.isInteger(n) && n > spec.max) {
          throw configError(`maxPayloadBytes 最大 ${spec.max} 字节：这是桥接 HTTP 请求体的硬上限，`
            + `配得更大也不会生效（超过该值的请求在读到日记端点之前就被 413 拒绝）。收到：${n}`);
        }
        throw configError(`${key} 必须是 ${spec.min}~${spec.max} 之间的整数，收到：${String(value)}`);
      }
      out.limits[key] = n;
    }
  }
  if (out.limits.maxPayloadBytes > out.limits.maxFileBytes) {
    throw configError(`maxPayloadBytes（${out.limits.maxPayloadBytes}）不得大于 maxFileBytes（${out.limits.maxFileBytes}）`);
  }
  return out;
}

/** 部分提交：深合并 tools/limits 后再整体校验（未提供的字段保持当前值）。 */
export function mergeDiaryConfig(current, patch) {
  if (!isPlainObject(patch)) throw configError('请求体必须是对象');
  // 顶层也严格：patch 里出现 schemaVersion/enabled/tools/limits 之外的键一律拒绝。
  // 静默忽略是最坏的选择 —— 控制台发错字段名时用户会以为「改了但没生效」，
  // 反过来（悄悄接受 root/path 之类）更危险：会让人误以为那些参数有效。
  for (const key of Object.keys(patch)) {
    if (!['schemaVersion', 'enabled', 'tools', 'limits'].includes(key)) {
      throw configError(`未知的日记配置字段：${key}（只接受 schemaVersion/enabled/tools/limits）`);
    }
  }
  if (patch.tools !== undefined && !isPlainObject(patch.tools)) throw configError('tools 必须是对象');
  if (patch.limits !== undefined && !isPlainObject(patch.limits)) throw configError('limits 必须是对象');
  const base = normalizeDiaryConfig(current);
  const merged = {
    schemaVersion: 1,
    enabled: patch.enabled === undefined ? base.enabled : patch.enabled,
    tools: { ...base.tools, ...(isPlainObject(patch.tools) ? patch.tools : {}) },
    limits: { ...base.limits, ...(isPlainObject(patch.limits) ? patch.limits : {}) },
  };
  return normalizeDiaryConfig(merged);
}

/**
 * 实际生效的限额（给控制台回显用）。
 *
 * 为什么不在这里「钳位后静默保存」：用户配置就是用户配置，静默改动会让人以为值被记住了。
 * 这里只做**只读**投影：`limits` 是仍然按用户配置回显的值，`effective.netPayloadCapBytes`
 * 才是真正能进到 store 的上限（受桥接 HTTP 体上限约束），`capped:true` 表示用户配的值
 * 比 HTTP 上限更大、实际被压低了 —— 控制台据此显式提示，而不是让用户自己猜。
 */
export function diaryEffectiveLimits(config, configuredMaxPayload = undefined) {
  const limits = { ...(normalizeDiaryConfig(config).limits) };
  // configuredMaxPayload 用于「用户配置文件里写了一个超上限值、读盘时被降到上限」的场景：
  // 此时 config 里已经是降级后的值，只有调用方知道用户原本写的是什么。
  const configured = Number.isFinite(Number(configuredMaxPayload))
    ? Number(configuredMaxPayload)
    : Number(limits.maxPayloadBytes);
  const effectivePayload = Math.min(configured, DIARY_HTTP_MAX_BODY_BYTES);
  return {
    limits: { ...limits, maxPayloadBytes: effectivePayload },
    configured: { maxPayloadBytes: configured },
    capped: configured > DIARY_HTTP_MAX_BODY_BYTES,
    httpMaxBodyBytes: DIARY_HTTP_MAX_BODY_BYTES,
  };
}

/**
 * 读配置（容错）：返回 { config, source, corrupt, error }。
 *  · 文件不存在 → 默认值，source='default'
 *  · 解析/校验失败 → **默认值 + corrupt:true**（不知道用户想关什么，就不能擅自关掉功能）
 *  · 正常 → source='file'
 */
export function loadDiaryConfig({ file, fs = fsDefault } = {}) {
  if (typeof file !== 'string' || file === '') throw configError('读日记配置需要 file 路径');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { config: defaultDiaryConfig(), source: 'default', corrupt: false, error: null };
    }
    return {
      config: defaultDiaryConfig(),
      source: 'default',
      corrupt: true,
      error: `日记配置无法读取（${error?.code ?? 'unknown'}），已按默认值运行`,
    };
  }
  if (typeof raw === 'string' && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    const parsed = JSON.parse(String(raw));
    try {
      return { config: normalizeDiaryConfig(parsed), source: 'file', corrupt: false, error: null };
    } catch (error) {
      // 升级兼容：旧版本允许 maxPayloadBytes 写到 1MB/100MB（> HTTP 上限），严格校验会把它
      // 判成「配置损坏」并按默认值跑 —— 用户会以为自己的设置被清空了。这里只对这一项做
      // 降级：钳到 HTTP 上限后重新校验，通过就照常生效，并把「为什么变了」如实回报。
      const relaxed = relaxPayloadLimit(parsed);
      if (relaxed) {
        try {
          return {
            config: normalizeDiaryConfig(relaxed),
            source: 'file',
            corrupt: false,
            error: null,
            // 用户原本写进文件的值：config 里已经被压到 HTTP 上限，控制台要能如实回显
            // 「你配的是 X，实际生效 Y」，所以原值必须一起带出去（不能只剩降级后的值）。
            configuredMaxPayloadBytes: Number(parsed.limits.maxPayloadBytes),
            // 非致命提示：配置本身可用，但有人把单次写入上限写到了 HTTP 体上限之上。
            notice: `maxPayloadBytes 超过桥接 HTTP 上限 ${DIARY_HTTP_MAX_BODY_BYTES} 字节，已按该上限生效`,
          };
        } catch { /* 其它字段仍然非法 → 落到下面的 corrupt 分支 */ }
      }
      throw error;
    }
  } catch (error) {
    return {
      config: defaultDiaryConfig(),
      source: 'default',
      corrupt: true,
      error: `日记配置内容非法，已按默认值运行：${error?.message ?? error}`,
    };
  }
}

/** 只在 load 的降级路径用：把超上限的 maxPayloadBytes 钳到 HTTP 体上限，其余原样。 */
function relaxPayloadLimit(raw) {
  if (!isPlainObject(raw) || !isPlainObject(raw.limits)) return null;
  const value = Number(raw.limits.maxPayloadBytes);
  if (!Number.isInteger(value) || value <= DIARY_HTTP_MAX_BODY_BYTES) return null;
  return { ...raw, limits: { ...raw.limits, maxPayloadBytes: DIARY_HTTP_MAX_BODY_BYTES } };
}

/** 原子写配置：同目录唯一临时文件 + rename（与 core/json-store.mjs 同形，但零依赖注入）。 */
export function saveDiaryConfig({ file, config, fs = fsDefault } = {}) {
  if (typeof file !== 'string' || file === '') throw configError('写日记配置需要 file 路径');
  const normalized = normalizeDiaryConfig(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
  return normalized;
}
