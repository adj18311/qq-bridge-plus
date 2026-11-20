/**
 * 小黑盒控制台专栏：配置模型 + 持久化 + 门禁判定（纯模块，无 I/O 副作用除非显式调用）。
 *
 * 设计依据：`docs/superpowers/plans/2026-10-27-xiaoheihe-console-task-card.md`（用户任务卡）。
 * 这里刻意只做三件事，便于离线测试与变异验证：
 *   ① 形状与取值校验（能力开关、只读模式、巡逻开关与时段、三项每日额度）；
 *   ② 原子落盘 / 读取（损坏时 fail-safe 到「只读模式」，写全拒、读不受影响）；
 *   ③ 纯判定：给定配置与「能力类别」，回答放行还是拒绝以及机器可读的 reason。
 *
 * 门禁语义（任务卡「能力开关与只读模式」）：
 *   - 四个能力总开关：browse（浏览，含搜索）/ post（发帖）/ comment（发表评论）/ reply（回复，含楼中楼）。
 *   - 开关关闭时**禁止所有来源**的对应操作（智能体自主 + 管理员/群友要求），必须由服务端判定，不靠提示词。
 *   - 只读模式：放行已开启的浏览/搜索，禁止发帖、评论、回复（即使对应开关打开）；不清除开关原设置。
 *   - 每次判定都重新读当前配置，因此「保存后立即生效」不需要重启。
 */

export const XHH_CONSOLE_SETTINGS_SCHEMA_VERSION = 1;
export const XHH_CONSOLE_SETTINGS_RELATIVE_PATH = 'state/xiaoheihe-console-settings.json';

/** 每日额度上限的合法上界（任务卡：整数 0–99）。 */
export const XHH_CONSOLE_QUOTA_MAX = 99;

/** 四个能力总开关的键（顺序即控制台展示顺序）。 */
export const XHH_CONSOLE_CAPABILITY_KEYS = Object.freeze(['browse', 'post', 'comment', 'reply']);

/** 三项每日额度（搜索不占额度；评论与回复合计一项）。 */
export const XHH_CONSOLE_QUOTA_KEYS = Object.freeze(['browse', 'post', 'comment']);

/** 默认配置：新设计目标值，不代表运行态已生效。 */
export const XHH_CONSOLE_SETTINGS_DEFAULTS = Object.freeze({
  schemaVersion: XHH_CONSOLE_SETTINGS_SCHEMA_VERSION,
  capabilities: Object.freeze({ browse: true, post: true, comment: true, reply: true }),
  readOnly: false,
  patrol: Object.freeze({ enabled: true, window: Object.freeze({ start: '07:00', end: '23:00' }) }),
  quota: Object.freeze({ browse: 14, post: 2, comment: 12 }),
});

/**
 * 工具 → 能力类别。只列需要门禁的工具：
 *   - 登录类（interactive_login / get_login_qr_code）与 check_login_status、get_user_profile
 *     不在任务卡的四个开关范围里，保持既有凭据门禁/读路径不变。
 */
export const XHH_CONSOLE_TOOL_CAPABILITY = Object.freeze({
  get_home_content: 'browse',
  get_post_detail: 'browse',
  search_content: 'browse',
  // 只读的资料/登录态查询也归「浏览」：它们不产生平台副作用，
  // 用户关掉浏览就该连这些一起关（此前它们落进 misc 分支不受开关约束）。
  get_user_profile: 'browse',
  check_login_status: 'browse',
  publish_content: 'post',
  publish_article: 'post',
  publish_video: 'post',
  post_comment: 'comment',
  reply_comment: 'reply',
});

/** 拒绝原因（机器可读，符合 bridge 审计的 ^[a-z][a-z0-9-]{0,63}$ 约定）。 */
export const XHH_CONSOLE_REASON_READ_ONLY = 'console-read-only';
export const XHH_CONSOLE_REASON_CAPABILITY_OFF = (capability) => `console-capability-off-${capability}`;

const TIME_PATTERN = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(reason, field) {
  return field === undefined ? { ok: false, reason } : { ok: false, reason, field };
}

function cloneDefaults() {
  return {
    schemaVersion: XHH_CONSOLE_SETTINGS_SCHEMA_VERSION,
    capabilities: { ...XHH_CONSOLE_SETTINGS_DEFAULTS.capabilities },
    readOnly: XHH_CONSOLE_SETTINGS_DEFAULTS.readOnly,
    patrol: {
      enabled: XHH_CONSOLE_SETTINGS_DEFAULTS.patrol.enabled,
      window: { ...XHH_CONSOLE_SETTINGS_DEFAULTS.patrol.window },
    },
    quota: { ...XHH_CONSOLE_SETTINGS_DEFAULTS.quota },
  };
}

/** 时间段文本 → 分钟数（00:00 = 0，23:59 = 1439）；非法返回 null。 */
export function parseWindowMinutes(text) {
  if (typeof text !== 'string' || !TIME_PATTERN.test(text)) return null;
  const [hour, minute] = text.split(':').map((part) => Number(part));
  return hour * 60 + minute;
}

/**
 * 巡逻时段一律按**北京时间**判断，不看进程本地时区。
 * 理由：任务卡的时段是给运维看的北京时间（07:00–23:00），而 bridge 可能跑在
 * UTC 容器/服务里；用本地时区会让整段窗口偏 8 小时（复审实测 TZ=UTC 下
 * 北京 07:30 被判 window-outside、00:30 反被放行）。
 */
export const XHH_CONSOLE_TIMEZONE_OFFSET_MINUTES = 8 * 60;

export function beijingMinutesOfDay(at) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const shifted = new Date(date.getTime() + XHH_CONSOLE_TIMEZONE_OFFSET_MINUTES * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/**
 * 时间段是否包含某个时刻（按北京时间）。
 * - start === end ⇒ 全天允许（任务卡明确要求）。
 * - start < end ⇒ [start, end) 的普通区间。
 * - start > end ⇒ 跨午夜（例：23:00→07:00 覆盖 23:00–24:00 与 00:00–07:00）。
 */
export function windowContains(window, at) {
  const start = parseWindowMinutes(window?.start);
  const end = parseWindowMinutes(window?.end);
  if (start === null || end === null) return false;
  const minutes = beijingMinutesOfDay(at);
  if (minutes === null) return false;
  if (start === end) return true;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

/**
 * 校验并归一化配置。返回完整对象（缺省键用默认值补齐），便于调用方直接落盘。
 * 严格拒绝未知键：配置面是运维接口，拼错一个键必须当场报错，而不是静默忽略
 * （历史上同类问题咬过三次，见 backgroundPatrol 的 CONFIG_KEYS 契约）。
 */
export function normalizeSettings(input) {
  if (!isPlainObject(input)) return fail('invalid-settings');
  const unknownTop = Object.keys(input).filter((key) => !['schemaVersion', 'capabilities', 'readOnly', 'patrol', 'quota'].includes(key));
  if (unknownTop.length > 0) return fail('unknown-field', unknownTop[0]);
  if (input.schemaVersion !== undefined && input.schemaVersion !== XHH_CONSOLE_SETTINGS_SCHEMA_VERSION) {
    return fail('schema-version-unsupported', 'schemaVersion');
  }

  const settings = cloneDefaults();

  if (input.capabilities !== undefined) {
    if (!isPlainObject(input.capabilities)) return fail('invalid-capabilities', 'capabilities');
    const unknown = Object.keys(input.capabilities).filter((key) => !XHH_CONSOLE_CAPABILITY_KEYS.includes(key));
    if (unknown.length > 0) return fail('unknown-field', `capabilities.${unknown[0]}`);
    for (const key of XHH_CONSOLE_CAPABILITY_KEYS) {
      if (input.capabilities[key] === undefined) continue;
      if (typeof input.capabilities[key] !== 'boolean') return fail('invalid-capability-value', `capabilities.${key}`);
      settings.capabilities[key] = input.capabilities[key];
    }
  }

  if (input.readOnly !== undefined) {
    if (typeof input.readOnly !== 'boolean') return fail('invalid-read-only', 'readOnly');
    settings.readOnly = input.readOnly;
  }

  if (input.patrol !== undefined) {
    if (!isPlainObject(input.patrol)) return fail('invalid-patrol', 'patrol');
    const unknown = Object.keys(input.patrol).filter((key) => !['enabled', 'window'].includes(key));
    if (unknown.length > 0) return fail('unknown-field', `patrol.${unknown[0]}`);
    if (input.patrol.enabled !== undefined) {
      if (typeof input.patrol.enabled !== 'boolean') return fail('invalid-patrol-enabled', 'patrol.enabled');
      settings.patrol.enabled = input.patrol.enabled;
    }
    if (input.patrol.window !== undefined) {
      const window = input.patrol.window;
      if (!isPlainObject(window)) return fail('invalid-patrol-window', 'patrol.window');
      const unknownWindow = Object.keys(window).filter((key) => !['start', 'end'].includes(key));
      if (unknownWindow.length > 0) return fail('unknown-field', `patrol.window.${unknownWindow[0]}`);
      for (const key of ['start', 'end']) {
        if (window[key] === undefined) continue;
        if (parseWindowMinutes(window[key]) === null) return fail('invalid-window-time', `patrol.window.${key}`);
        settings.patrol.window[key] = window[key];
      }
    }
  }

  if (input.quota !== undefined) {
    if (!isPlainObject(input.quota)) return fail('invalid-quota', 'quota');
    const unknown = Object.keys(input.quota).filter((key) => !XHH_CONSOLE_QUOTA_KEYS.includes(key));
    if (unknown.length > 0) return fail('unknown-field', `quota.${unknown[0]}`);
    for (const key of XHH_CONSOLE_QUOTA_KEYS) {
      if (input.quota[key] === undefined) continue;
      const value = input.quota[key];
      // 任务卡：非整数、负数、大于 99、空值均为无效输入。0 合法（表示禁止该类自主操作）。
      if (!Number.isInteger(value) || value < 0 || value > XHH_CONSOLE_QUOTA_MAX) {
        return fail('invalid-quota-value', `quota.${key}`);
      }
      settings.quota[key] = value;
    }
  }

  return { ok: true, settings };
}

/** 配置损坏时的兜底：默认值 + 只读模式（写全拒、读按默认额度放行），绝不因为文件坏了而放开写。 */
export function failSafeSettings() {
  const settings = cloneDefaults();
  settings.readOnly = true;
  return settings;
}

/**
 * 能力类别 → 是否放行。返回 {allowed, reason}。
 * 判定顺序固定：先看对应能力开关（关了就拒），再看只读模式（写三类拒），浏览不受只读影响。
 */
/**
 * 后台巡逻是否允许在这个时刻投递。
 * 抽成纯函数的原因：这段判定原本只散落在 bridge 的 dispatch 里，只能靠静态 pin 覆盖；
 * 它决定「要不要花一次真实平台访问」，必须能被时刻无关地单测。
 * @param {object} settings 已规范化的配置
 * @param {number} atMs 判定时刻（毫秒）
 * @returns {{ok: boolean, reason: string|null}}
 */
export function decidePatrolDispatch(settings, atMs) {
  const patrol = settings && typeof settings === 'object' && settings.patrol && typeof settings.patrol === 'object'
    ? settings.patrol
    : {};
  if (patrol.enabled !== true) return { ok: false, reason: 'console-patrol-disabled' };
  if (!windowContains(patrol.window, atMs)) return { ok: false, reason: 'console-outside-window' };
  return { ok: true, reason: null };
}

export function decideCapability(settings, category) {
  const current = isPlainObject(settings) ? settings : XHH_CONSOLE_SETTINGS_DEFAULTS;
  if (!XHH_CONSOLE_CAPABILITY_KEYS.includes(category)) {
    return { allowed: false, reason: 'console-capability-unknown' };
  }
  if (current.capabilities?.[category] !== true) {
    return { allowed: false, reason: XHH_CONSOLE_REASON_CAPABILITY_OFF(category) };
  }
  const isWrite = category !== 'browse';
  if (isWrite && current.readOnly === true) {
    return { allowed: false, reason: XHH_CONSOLE_REASON_READ_ONLY };
  }
  return { allowed: true, reason: null };
}

/** 工具名（可带 mcp__ 前缀）→ 能力类别；不在门禁范围返回 null。 */
export function capabilityOfTool(toolName) {
  if (typeof toolName !== 'string') return null;
  const short = toolName.startsWith('mcp__xiaoheihe__') ? toolName.slice('mcp__xiaoheihe__'.length) : toolName;
  return XHH_CONSOLE_TOOL_CAPABILITY[short] ?? null;
}

/**
 * 读取配置。ENOENT 视为「尚未保存过」⇒ 默认值（不是错误）。
 * 文件存在但解析/校验/读取失败 ⇒ fail-safe（只读模式）+ 明确 reason，调用方负责记审计/日志。
 */
export function loadSettings({ filePath, fs }) {
  const readFileSync = fs?.readFileSync ?? null;
  if (typeof readFileSync !== 'function') return { ok: false, reason: 'fs-unavailable', settings: failSafeSettings() };
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ok: true, settings: cloneDefaults(), created: false };
    }
    return { ok: false, reason: 'settings-load-failed', settings: failSafeSettings() };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'settings-corrupt', settings: failSafeSettings() };
  }
  const normalized = normalizeSettings(parsed);
  if (!normalized.ok) {
    return { ok: false, reason: `settings-${normalized.reason}`, settings: failSafeSettings() };
  }
  return { ok: true, settings: normalized.settings, created: false };
}

/**
 * 原子保存：写临时文件 → rename 覆盖，权限 0600（配置里没有凭据，但仍是运维面文件）。
 * 只有 rename 成功才返回 ok，避免「内存已生效但磁盘还是旧值」的半写状态。
 */
export function saveSettings({ filePath, fs }, input) {
  const writeFileSync = fs?.writeFileSync ?? null;
  const renameSync = fs?.renameSync ?? null;
  const normalize = normalizeSettings(input);
  if (!normalize.ok) return { ok: false, reason: normalize.reason, field: normalize.field };
  if (typeof writeFileSync !== 'function' || typeof renameSync !== 'function') {
    return { ok: false, reason: 'fs-unavailable' };
  }
  const payload = `${JSON.stringify(normalize.settings, null, 2)}\n`;
  // 临时文件名带进程号与随机后缀：两个并发 apply 用同一个 `.tmp` 会互相覆盖，
  // 导致「A 的 rename 把 B 的内容装进去」这种静默错配（复审 P3-3）。
  const tmpSuffix = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const tmpPath = `${filePath}.${tmpSuffix}.tmp`;
  try {
    writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmpPath, filePath);
  } catch {
    try {
      // 失败时清掉自己的 tmp，避免残留（rename 前的半成品没有价值）。
      if (typeof fs?.unlinkSync === 'function') fs.unlinkSync(tmpPath);
    } catch {
      /* 清理失败不影响主结果 */
    }
    return { ok: false, reason: 'settings-persist-failed' };
  }
  return { ok: true, settings: normalize.settings };
}