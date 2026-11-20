/**
 * src/quota-error.js
 *
 * Pure classifier for proven balance / quota exhaustion failures. No IO, no
 * timers, no model calls and no shared state. Only the allowed error wrapper
 * fields (error, message, cause) and their structural code / type / status /
 * statusCode fields are read; request, headers, body and prompt are never
 * inspected. JSON-shaped strings are parsed under a strict length bound and
 * walked with the same allow-list, so request or prompt text cannot fake
 * exhaustion. The result is { exhausted, reason } and never echoes raw input.
 */
const MAX_DEPTH = 5;
const MAX_NODES = 48;
const MAX_ARRAY_ITEMS = 8;
const MAX_CODES = 16;
const MAX_TEXTS = 24;
const MAX_TEXT_LENGTH = 8192;
const MAX_JSON_LENGTH = 8192;
const MAX_CODE_LENGTH = 120;
const REJECT_STATUSES = new Set([401, 403, 503, 529]);
const HTTP_STATUS_TOKEN = /(?:^\s*(?:http(?:\/\d(?:\.\d)?)?\s+)?|\b(?:http(?:\/\d(?:\.\d)?)?|status(?:\s*code)?|response code)\s*[:=]?\s*)(401|403|503|529)(?=\s|$|[,:;])/i;

export const QUOTA_ERROR_REASONS = Object.freeze({
  NONE: 'none', QUOTA_CODE: 'quota_code', BALANCE_CODE: 'balance_code',
  USAGE_CODE: 'usage_code', BALANCE_TEXT: 'balance_text', USAGE_TEXT: 'usage_text',
});

// Fixed structured enum: structure wins over prose; no namespace guessing,
// synonym sweep or fuzzy matching on raw codes.
const POSITIVE_CODES = new Map([
  ['insufficient_quota', QUOTA_ERROR_REASONS.QUOTA_CODE],
  ['quota_exceeded', QUOTA_ERROR_REASONS.QUOTA_CODE],
  ['insufficient_balance', QUOTA_ERROR_REASONS.BALANCE_CODE],
  ['credit_balance_too_low', QUOTA_ERROR_REASONS.BALANCE_CODE],
  ['billing_hard_limit_reached', QUOTA_ERROR_REASONS.BALANCE_CODE],
  ['usage_limit_exceeded', QUOTA_ERROR_REASONS.USAGE_CODE],
  ['coding_plan_exhausted', QUOTA_ERROR_REASONS.USAGE_CODE],
]);

// Explicit transport states that can never prove account depletion. v1 keeps
// 401/403 unconditional, even when the payload claims a billing code.
// Normalized English prose: lowercase, non alphanumerics collapsed to single
// spaces and padded, so every pattern can use plain space boundaries.
const BALANCE_TEXT = [
  / insufficient (?:quota|balance|credits?|funds) /,
  / (?:credit |account |wallet )?balance (?:is |has been |was )?(?:too low|insufficient|negative|zero|depleted|exhausted|empty) /,
  / (?:out of|ran out of) (?:remaining |available )?(?:quota|credits?|balance|funds) /,
  / (?:quota|credits?|balance) (?:has been |is |was |have been |are )?(?:exceeded|exhausted|depleted|used up) /,
  / exceeded (?:your |the |its |my |our )?(?:current |monthly |daily |weekly |annual )?(?:quota|balance|credits?) /,
  / billing hard (?:limit|cap) (?:has been |is |was )?(?:reached|exceeded) /,
  / (?:no|zero) (?:remaining |available )?(?:quota|credits?|balance) (?:left|remaining) /,
];

const USAGE_TEXT = [
  / usage limit (?:has been |is |was )?(?:reached|exceeded|hit|exhausted|used up) /,
  / (?:reached|exceeded|hit) (?:your |the |its )?(?:monthly |daily |weekly |annual |current )?(?:usage|quota) limit /,
  / coding plan (?:has been |is |was )?(?:exhausted|used up) /,
  / (?:monthly|daily|weekly|annual) (?:usage )?(?:limit|quota) (?:has been |is |was )?(?:reached|exceeded|exhausted) /,
  / quota (?:has been |is |was )?exhausted /,
];

// Minute/second/hour rate signals and generic throttling are not account
// depletion; structured billing codes are handled before prose.
const RATE_TEXT = [
  / per (?:second|minute|hour) /,
  / (?:this|current|one) (?:second|minute|hour) /,
  / rate limit /,
  / rate limited /,
  / too many requests /,
  / requests per /,
  / rpm /,
  / qps /,
  / throttl/,
];

// Chinese depletion: subject then predicate within a short bounded window, or
// the explicit over-limit form predicate then subject.
const ZH_FORWARD_TEXT = /(?:余额|额度|配额|用量|使用量|调用量)[^，。；;！!？?\s]{0,6}(?:不足|耗尽|用尽|用完|用光|见底|为零|为0|已达上限|已达到上限|达到上限|超出上限|超过上限|超限|超出限制|超过限制)/;
const ZH_OVER_LIMIT_TEXT = /(?:超出|超过|达到|已达|已超)(?:本月|当月|每日|每周|当前|可用|剩余)?(?:额度|配额|用量|使用量)(?:上限|限制|限额)/;
const ZH_RATE_TEXT = /每分钟|每秒|每小时|频率|限流|限频|请求过快/;
const ZH_BALANCE_SUBJECT = /余额|额度/;

function safeGet(target, key) {
  try {
    if (target === null || target === undefined) return undefined;
    const kind = typeof target;
    return kind === 'object' || kind === 'function' ? target[key] : undefined;
  } catch {
    return undefined;
  }
}

function containsRejectStatus(value) {
  if (typeof value === 'number') return REJECT_STATUSES.has(value);
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return /^\d{3}$/.test(trimmed) ? REJECT_STATUSES.has(Number(trimmed)) : HTTP_STATUS_TOKEN.test(trimmed);
}

function jsonStart(text) {
  const object = text.indexOf('{');
  const array = text.indexOf('[');
  return object === -1 ? array : array === -1 ? object : Math.min(object, array);
}

function normalizeEnglish(raw) {
  const text = raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return text.length === 0 ? '' : ' ' + text + ' ';
}

function collectEvidence(failure) {
  const evidence = { rejected: false, codes: [], texts: [] };
  const seen = new Set();
  let budget = MAX_NODES;

  function addCode(value) {
    if (evidence.codes.length >= MAX_CODES) return;
    if (typeof value === 'string') {
      const code = value.trim().toLowerCase();
      if (code.length > 0 && code.length <= MAX_CODE_LENGTH) evidence.codes.push(code);
    } else if (typeof value === 'number' && Number.isFinite(value)) evidence.codes.push(String(value));
  }

  function addText(value, depth) {
    if (depth > MAX_DEPTH) return;
    if (evidence.rejected || evidence.texts.length >= MAX_TEXTS) return;
    let text = typeof value === 'string' ? value : null;
    if (text === null && (typeof value === 'number' || typeof value === 'bigint')) text = String(value);
    if (text === null) return;
    text = text.trim().replace(/^\[[a-z0-9 _.-]{1,60}\]\s*/i, '');
    if (text.length === 0) return;
    if (text.length > MAX_TEXT_LENGTH) text = text.slice(0, MAX_TEXT_LENGTH);
    const start = jsonStart(text);
    const probe = start === -1 ? text : text.slice(0, start);
    if (containsRejectStatus(probe)) {
      evidence.rejected = true;
      return;
    }
    if (start === -1) {
      evidence.texts.push(text);
      return;
    }
    if (probe.trim()) evidence.texts.push(probe);
    // JSON-shaped text is evidence only through its allow-listed fields; the
    // surrounding prose and any request/prompt value inside are never matched.
    if (text.length - start > MAX_JSON_LENGTH) return;
    let parsed;
    try {
      parsed = JSON.parse(text.slice(start));
    } catch {
      return;
    }
    visit(parsed, depth + 1);
  }

  function visit(value, depth) {
    if (budget <= 0 || depth > MAX_DEPTH) return;
    if (value === null || value === undefined) return;
    const kind = typeof value;
    if (kind === 'string' || kind === 'number' || kind === 'bigint') return addText(value, depth);
    if (kind !== 'object' && kind !== 'function') return;
    if (seen.has(value)) return;
    seen.add(value);
    budget -= 1;
    if (Array.isArray(value)) {
      const length = value.length < MAX_ARRAY_ITEMS ? value.length : MAX_ARRAY_ITEMS;
      for (let index = 0; index < length; index += 1) visit(safeGet(value, index), depth + 1);
      return;
    }
    if (containsRejectStatus(safeGet(value, 'status')) || containsRejectStatus(safeGet(value, 'statusCode'))) {
      evidence.rejected = true;
    }
    for (const field of ['code', 'type']) {
      const raw = safeGet(value, field);
      if (typeof raw === 'string' || typeof raw === 'number') addCode(raw);
      else visit(raw, depth + 1);
    }
    for (const field of ['error', 'message', 'cause']) {
      const raw = safeGet(value, field);
      if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'bigint') addText(raw, depth + 1);
      else visit(raw, depth + 1);
    }
  }

  visit(failure, 0);
  return evidence;
}

function classifyText(raw) {
  if (ZH_RATE_TEXT.test(raw)) return null;
  const zh = ZH_FORWARD_TEXT.exec(raw) || ZH_OVER_LIMIT_TEXT.exec(raw);
  if (zh !== null) {
    return ZH_BALANCE_SUBJECT.test(zh[0]) ? QUOTA_ERROR_REASONS.BALANCE_TEXT : QUOTA_ERROR_REASONS.USAGE_TEXT;
  }
  const text = normalizeEnglish(raw);
  if (text.length === 0) return null;
  if (RATE_TEXT.some((pattern) => pattern.test(text))) return null;
  if (BALANCE_TEXT.some((pattern) => pattern.test(text))) return QUOTA_ERROR_REASONS.BALANCE_TEXT;
  if (USAGE_TEXT.some((pattern) => pattern.test(text))) return QUOTA_ERROR_REASONS.USAGE_TEXT;
  return null;
}

export function classifyQuotaError(failure) {
  try {
    const evidence = collectEvidence(failure);
    if (evidence.rejected) return { exhausted: false, reason: QUOTA_ERROR_REASONS.NONE };
    const code = evidence.codes.find((candidate) => POSITIVE_CODES.has(candidate));
    if (code !== undefined) return { exhausted: true, reason: POSITIVE_CODES.get(code) };
    if (evidence.codes.some(code => /^(?:rate_limit(?:_error|_exceeded)?|too_many_requests|insufficient_permissions)$/.test(code))) return { exhausted: false, reason: QUOTA_ERROR_REASONS.NONE };
    for (const text of evidence.texts) {
      const reason = classifyText(text);
      if (reason !== null) return { exhausted: true, reason };
    }
    return { exhausted: false, reason: QUOTA_ERROR_REASONS.NONE };
  } catch {
    return { exhausted: false, reason: QUOTA_ERROR_REASONS.NONE };
  }
}
