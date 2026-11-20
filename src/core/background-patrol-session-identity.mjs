/**
 * 后台巡逻：DSH sessionId → 会话用途映射（**纯模块，未接线**）。
 *
 * 目的（task-40 结论 / task-50）：路线 B 的 DSH pre-execute 只拿得到 `exec.agent.session.id`
 * （DSH sessionId），而「用户例外 / 后台会话 / 群聊」的判定需要把 sessionId 映射回 QQ 会话 key。
 * 本模块只做这一层纯分类，不 import bridge、不读 state/config、不联网、不修改注入对象。
 *
 * 数据来源（全部注入）：
 *  · `sessions`：bridge 侧 `state.sessions`（QQ 会话 key → DSH sessionId；plain object / Map）；
 *  · `reverse`：可选 `sessionId → QQ key`（plain object / Map）；缺省由 `sessions` 反推；
 *  · `backgroundSessionId`：当前 `patrol:background` 的 DSH sessionId（未创建时传 null）；
 *  · `ownerQQ`：管理员 QQ（必填，数字字符串）；`groupExempt`：群聊是否豁免（默认 true）。
 *
 * 分类契约（fail-closed，classify 永不抛异常）：
 *  · sessionId === backgroundSessionId → `patrol`（后台会话，计入额度）；
 *  · reverse 映射 `private:<ownerQQ>` → `owner`（用户豁免）；`private:<其它>` → `unknown`；
 *  · reverse 映射 `group:<id>` → `group`（是否豁免由 isUserExempt 按 groupExempt 决定）；
 *  · 无映射 / 空 / 非字符串 / 非法 key 格式 / 同一 sessionId 多重映射（歧义）→ `unknown`；
 *  · 调用方应把 `unknown` 视为 deny（本模块不返回 allow 语义）。
 *
 * **已知风险（必须文档化）**：群聊里无法区分「管理员明确要求」与「群友要求」——本模块只做会话级
 * 分类，默认 groupExempt=true 是按用户 2026-10-25 的要求（群聊明确要求不占额度），但存在被群友
 * 借用的风险；要区分群友要求需要额外的可信证据（当前不存在），接线层需自行权衡/收紧。
 *
 * 明确不做：不接线、不读真实 state/config、不创建/销毁 DSH 会话、不发 QQ、不持久化。
 */

/** 分类结果枚举（冻结）。 */
export const SESSION_IDENTITY_CLASSES = Object.freeze(['patrol', 'owner', 'group', 'unknown']);

const OWNER_QQ_RE = /^[0-9]{1,20}$/;
const PRIVATE_KEY_RE = /^private:([0-9]{1,20})$/;
const GROUP_KEY_RE = /^group:([^\s:]{1,64})$/;
const MAX_SESSION_ID_LENGTH = 256;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidSessionId(value) {
  return typeof value !== 'string'
    || value.trim() === ''
    || value.length > MAX_SESSION_ID_LENGTH
    || CONTROL_CHAR_RE.test(value);
}

function unknown() {
  return { ok: true, class: 'unknown' };
}

/** 把 plain object / Map / undefined 统一成 [key, sessionId] 数组；非法容器抛 TypeError。 */
function toEntries(source, label) {
  if (source === undefined || source === null) return [];
  if (source instanceof Map) {
    const entries = [];
    for (const [key, value] of source.entries()) entries.push([key, value]);
    return entries;
  }
  if (isPlainObject(source)) return Object.entries(source);
  throw new TypeError(`createSessionIdentityMapper：${label} 必须是 plain object / Map / 省略`);
}

/** 由 sessions 反推 reverse；同一 sessionId 多重映射记为歧义（fail-closed）。 */
function deriveReverse(entries) {
  const reverse = new Map();
  const ambiguous = new Set();
  for (const [key, sessionId] of entries) {
    if (typeof key !== 'string' || typeof sessionId !== 'string' || sessionId === '') continue;
    if (ambiguous.has(sessionId)) continue;
    if (reverse.has(sessionId)) {
      if (reverse.get(sessionId) !== key) {
        reverse.delete(sessionId);
        ambiguous.add(sessionId);
      }
      continue;
    }
    reverse.set(sessionId, key);
  }
  return { reverse, ambiguous };
}

function buildExplicitReverse(source) {
  const reverse = new Map();
  const ambiguous = new Set();
  for (const [sessionId, key] of source) {
    if (typeof sessionId !== 'string' || sessionId === '' || typeof key !== 'string' || key === '') continue;
    if (ambiguous.has(sessionId)) continue;
    if (reverse.has(sessionId)) {
      if (reverse.get(sessionId) !== key) {
        reverse.delete(sessionId);
        ambiguous.add(sessionId);
      }
      continue;
    }
    reverse.set(sessionId, key);
  }
  return { reverse, ambiguous };
}

/**
 * 创建 sessionId → 用途映射器。
 *
 * @param {object} options
 * @param {object|Map} [options.sessions] QQ key → DSH sessionId（bridge state.sessions）
 * @param {string|null} [options.backgroundSessionId] 当前后台会话的 DSH sessionId（未创建传 null）
 * @param {string} options.ownerQQ 管理员 QQ（数字字符串，必填）
 * @param {object|Map} [options.reverse] sessionId → QQ key（显式注入时优先于 sessions 反推）
 * @param {boolean} [options.groupExempt] 群聊是否算用户豁免（默认 true，见已知风险）
 */
export function createSessionIdentityMapper(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('createSessionIdentityMapper：options 必须是对象');
  const source = options;

  if (typeof source.ownerQQ !== 'string' || !OWNER_QQ_RE.test(source.ownerQQ)) {
    throw new TypeError('createSessionIdentityMapper：ownerQQ 必须是 1..20 位数字字符串（必填）');
  }
  const ownerQQ = source.ownerQQ;

  let backgroundSessionId = null;
  if (source.backgroundSessionId !== undefined && source.backgroundSessionId !== null) {
    if (typeof source.backgroundSessionId !== 'string' || source.backgroundSessionId.trim() === '') {
      throw new TypeError('createSessionIdentityMapper：backgroundSessionId 必须是非空字符串或 null');
    }
    backgroundSessionId = source.backgroundSessionId;
  }

  if (source.groupExempt !== undefined && typeof source.groupExempt !== 'boolean') {
    throw new TypeError('createSessionIdentityMapper：groupExempt 必须是布尔值');
  }
  const groupExempt = source.groupExempt === undefined ? true : source.groupExempt;

  const sessionEntries = toEntries(source.sessions, 'sessions');
  let built;
  if (source.reverse === undefined || source.reverse === null) {
    built = deriveReverse(sessionEntries);
  } else {
    built = buildExplicitReverse(toEntries(source.reverse, 'reverse'));
  }
  const { reverse, ambiguous } = built;

  /** @param {unknown} sessionId */
  function classify(sessionId) {
    try {
      if (invalidSessionId(sessionId)) return unknown();
      const id = sessionId;
      if (backgroundSessionId !== null && id === backgroundSessionId) {
        return { ok: true, class: 'patrol' };
      }
      if (ambiguous.has(id)) return unknown();
      const key = reverse.get(id);
      if (typeof key !== 'string' || key === '') return unknown();

      const privateMatch = PRIVATE_KEY_RE.exec(key);
      if (privateMatch !== null) {
        const qq = privateMatch[1];
        if (qq !== ownerQQ) return unknown();
        return { ok: true, class: 'owner', key, qq };
      }
      if (GROUP_KEY_RE.test(key)) {
        return { ok: true, class: 'group', key };
      }
      return unknown();
    } catch {
      return unknown();
    }
  }

  /** @param {unknown} sessionId */
  function isUserExempt(sessionId) {
    const result = classify(sessionId);
    if (result.class === 'owner') return true;
    if (result.class === 'group' && groupExempt === true) return true;
    return false;
  }

  return { classify, isUserExempt };
}
