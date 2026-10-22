// 上游模型错误 → 群里的人话提示 + 冷却门控。
//
// 事故背景：529 overloaded_error 时桥接把原始 JSON（含 request_id、type":"error"）
// 连发三条到群里，机器人被管理员禁言 12 小时，而 state/bridge.log 里一条记录都没有。
// 这里只产出**固定文案**：分类结果绝不回显原文，原文由调用方单独写日志。
//
// 纯函数 + 可注入时钟，便于单测；本模块不做任何 IO、不读配置。

export const ERROR_NOTICE_COOLDOWN_MS = 300_000;

// 本发布不做额度检测：明确429一律按限流；其余沿用 busy → auth → other。
const BUSY_RE = /(?<!\d)529(?!\d)|overloaded|负载较高|集群/i;
const AUTH_RE = /(?<!\d)(?:401|403)(?!\d)|unauthorized|鉴权/i;
// 只把明确状态前缀或限流措辞认作429，避免把 request_id=429 当成状态。
const RATE_RE = /^\s*(?:\[[a-z0-9 _.-]{1,60}\]\s*)?(?:HTTP(?:\/\d+(?:\.\d+)?)?\s+)?429(?=\s|$|[:{])|\btoo many requests\b|\brate[\s_-]?limit(?:ed|_exceeded)?\b/i;
const LABELED_429_RE = /\[\s*429\s*\]|\b(?:[a-z]*error\s*:|http\s+status|status(?:\s*code)?|statusCode)\s*[:=]?\s*429\b/i;

function failureStatus(failure, depth = 0) {
  if (depth > 4 || !failure) return null;
  try {
    if (typeof failure === 'string') {
      const value = failure.trim().replace(/^\[[a-z0-9 _.-]{1,60}\]\s*/i, '');
      const object = value.indexOf('{'), array = value.indexOf('[');
      const start = object < 0 ? array : array < 0 ? object : Math.min(object, array);
      if (value.length <= 8192 && start >= 0) return failureStatus(JSON.parse(value.slice(start)), depth + 1);
      return null;
    }
    if (typeof failure !== 'object') return null;
    if (Array.isArray(failure)) {
      for (const entry of failure.slice(0, 8)) {
        const status = failureStatus(entry, depth + 1);
        if (status !== null) return status;
      }
      return null;
    }
    const raw = failure.status ?? failure.statusCode;
    if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
    if (typeof raw === 'string' && /^\d{3}$/.test(raw.trim())) return Number(raw.trim());
    // 仅沿允许的错误包装取状态，忽略request/headers/body/prompt。
    for (const field of ['error', 'cause', 'message']) {
      const status = failureStatus(failure[field], depth + 1);
      if (status !== null) return status;
    }
  } catch { return null; }
  return null;
}

// 固定文案：QQ 侧只允许出现这里面的字符串。
export const ERROR_NOTICE_TEXTS = Object.freeze({
  busy: '⚠️ 模型服务这会儿有点挤，我过一会儿再试。',
  auth: '⚠️ 模型鉴权出问题了，需要检查配置。',
  rate: '请求过于频繁，请稍后再试',
  other: '⚠️ 处理出错了，细节记在日志里。'
});

// 把上游错误文本归类成人话。返回值里的 text 永远来自 ERROR_NOTICE_TEXTS，
// 因此调用方即使把 text 直接发到 QQ，也不可能带出原始 JSON / request_id。
export function classifyAgentError(rawText, failure) {
  const value = typeof rawText === 'string' ? rawText : String(rawText ?? '');
  const status = failureStatus(failure ?? rawText);
  if (status === 429 || (status === null && (RATE_RE.test(value) || LABELED_429_RE.test(value)))) {
    // 本发布不做额度检测：所有普通429一律按限流处理，不区分 insufficient_quota。
    return { kind: 'rate', text: ERROR_NOTICE_TEXTS.rate };
  }
  // 未分类的额度类错误不再单独识别，统一落到 other 的通用文案。
  const kind = BUSY_RE.test(value) ? 'busy'
    : AUTH_RE.test(value) ? 'auth'
      : 'other';
  return { kind, text: ERROR_NOTICE_TEXTS[kind] };
}

// 限流去重：同一 key + 同一 kind 在 cooldownMs 内只放行一次，
// 不同 kind / 不同 key 各自独立计时。now 注入成返回毫秒时间戳的函数，测试可拨表。
export function createErrorNoticeGate({ now = Date.now, cooldownMs = ERROR_NOTICE_COOLDOWN_MS } = {}) {
  if (typeof now !== 'function') throw new TypeError('createErrorNoticeGate：now 必须是函数');
  const lastSentAt = new Map(); // key → Map(kind → 上次发送时刻)
  return {
    shouldSend(key, kind) {
      const at = now();
      const bucket = String(key ?? '');
      let byKind = lastSentAt.get(bucket);
      if (!byKind) {
        byKind = new Map();
        lastSentAt.set(bucket, byKind);
      }
      const last = byKind.get(kind);
      if (last !== undefined && at - last < cooldownMs) return false;
      byKind.set(kind, at);
      return true;
    }
  };
}

// 桥接进程内共享的实例：冷却状态必须跨回合累积，否则每次报错都会重新计数。
export const defaultErrorNoticeGate = createErrorNoticeGate();
