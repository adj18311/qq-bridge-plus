/**
 * task-46：后台巡逻汇报「内容由模型决定 + 敏感分级 + 目的地选择」纯函数模块。
 *
 * 边界（有意保持很小）：
 *  · 不发送 QQ、不读写文件、不联网、不读全局随机、不启动定时器；
 *  · 敏感分级复用仓库既有实现（`src/sensitive.js` 的 SENSITIVE_RE）与调用方传入的
 *    `hasKnownToken`（KNOWN_AGENT_TOKENS 精确令牌名单），本模块只做「判定组合 + 保守附加规则」；
 *  · 群目的地只允许调用方给出的白名单，且复用 `background-patrol-report-policy.mjs` 的
 *    `allowGroupPatrolReport()`，不另立一套群规则。
 *
 * 规格依据：docs/superpowers/specs/2026-10-24-background-patrol-design.md §概率汇报
 *   「模型可自行在管理员私聊或允许发言的白名单群中选择目的地；群内只能发送非敏感内容；
 *     敏感内容只能发送给管理员私聊」。分类器是内容闸门，不是权限边界（见设计文档已知限制）。
 *
 * 关键取舍（写入设计文档 docs/superpowers/plans/2026-10-28-task46-report-content-design.md）：
 *  · 分级 blocked（疑似凭据/路径/URL/邮箱/QQ 号/控制字符/超长）→ 不外发；
 *  · 分级 sensitive → 模型原文只发管理员私聊；
 *  · 分级 non-sensitive → 模型原文可按白名单发群；
 *  · 任何缺失/非法输入 fail-closed 不发送，绝不因坏输入把内容发到群。
 *
 * 加固（复审 P1/P2）：
 *  · 分类前做 NFKC 归一（全角 URL/数字、兼容字符）+ 显式拦截零宽/DEL/C1/bidi/BOM；
 *  · URL 覆盖 scheme-less 域名、裸域名、协议相对、`hxxp` 变体、裸 IPv4；
 *  · 数字串按 Unicode Nd 计数并容忍分隔符（空格/-/_/./·），覆盖分隔符与阿拉伯数字写法；
 *  · 提取改为线性扫描（不再用惰性正则回溯），并只扫回合文本尾部 64KB；
 *  · 长度按码点计；块数 != 1 视为歧义，不发送（避免把示例块当真）；单引号属性也可解析。
 */

import { SENSITIVE_RE } from '../sensitive.js';
import { allowGroupPatrolReport } from './background-patrol-report-policy.mjs';

/** 模型汇报正文长度上限（抽取上限为 800 码点（历史 300 已退役；提示词同样按 800 且允许不分享），差异已写入设计文档）。 */
export const PATROL_REPORT_MAX_CHARS = 800;

/** 对外消息统一前缀（与既有固定模板一致）。 */
export const PATROL_REPORT_HEADER = '【后台巡逻汇报】';

/** 分享文本安全上限（Unicode 码点；仅安全阀，不约束风格）。超限不截断、不发送。 */
export const MAX_PATROL_REPORT_CHARS = 800;

/** 只扫描回合文本尾部这么多字符（汇报块由提示词要求放在最后），避免超长文本拖慢同步路径。 */
const PATROL_REPORT_SCAN_MAX = 64 * 1024;

const REPORT_OPEN = '<patrol-report';
const REPORT_CLOSE = '</patrol-report>';

const DEFAULT_TEMPLATE_LABELS = Object.freeze({ tieba: '贴吧', xiaoheihe: '小黑盒' });

/**
 * 不可见/控制/双向字符：C0（保留 \t\n\r 由 normalizeBody 折叠）、DEL、C1、软连字符、
 * 零宽（\u200b-\u200f）、bidi 控制（\u202a-\u202e）、词连接符、BOM。
 * 这些字符既能拆开 URL/数字/关键词绕过分级，也会改变群消息的视觉呈现。
 */
const INVISIBLE_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2065\u2066-\u206f\ufeff\u180e\p{Cf}]/u;

/**
 * 「装饰性」不可见字符：emoji 的变体选择符与 ZWJ/ZWNJ。它们不改变文字语义，
 * 但可能被用来拆开 token/URL/数字（剥掉后判定即可命中），因此分类前剥离、不单独判 blocked；
 * 剩余零宽/bidi/控制字符仍按 invisible 直接 blocked。
 */
const COSMETIC_INVISIBLE_RE = /[\u200c\u200d\ufe00-\ufe0f\u{e0001}\u{e0020}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

/** blocked 级附加规则：明显不该出现在 QQ 汇报里的内容形态（对 NFKC 归一后的文本判定）。 */
const BLOCKED_PATTERNS = Object.freeze([
  // 任意 scheme（http/https/ftp/…）、协议相对 //host、www.、hxxp(s) 变体。
  { reason: 'url', re: /(?:[a-z][a-z0-9+.-]*:\/\/|\/\/[a-z0-9-]+\.[a-z]{2,}|\bwww\.|\bh(?:xx|tt)ps?:\/\/)/i },
  // 裸域名（常见 TLD）：宁可误杀，也不让站外链接进群。
  {
    reason: 'domain',
    re: /(?:^|[^a-z0-9@._-])(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|dev|xyz|top|info|me|cc|tv|co|site|online|app|link|club|vip|shop|store|tech|fun|live|pro|ai|gg|ru|jp|ly|uk|de|fr|br|in|us|ca|au|hk|tw|sg|kr|do|gd|at|is|gy|ws|to|sh|xn--[a-z0-9-]+)\b/i,
  },
  { reason: 'ipv4', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
  // IPv6：至少 3 组冒号分隔的十六进制段，或含 `::` 缩写；避免把时刻 "12:30" 误判。
  { reason: 'ipv6', re: /(?:\b(?:[0-9a-f]{1,4}:){3,}[0-9a-f]{0,4}\b|\b[0-9a-f]{0,4}::[0-9a-f:.]{1,}|(?:^|\s)::1?\b)/i },
  { reason: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  // QQ 号/手机号/订单号：Unicode 数字；数字间最多 2 个任意非字母数字字符（覆盖 , ， 、 ; : + / | 等分隔写法）。
  { reason: 'digit-run', re: /(?:\p{Nd}[^\p{L}\p{Nd}]{0,2}){5,}/u },
]);

/** sensitive 级软关键词：不带值也按敏感处理（只降级到管理员私聊，不阻断）。 */
const SOFT_SENSITIVE_RE = /(密码|口令|验证码|二维码|令牌|密钥|凭据|cookie|token|secret)/i;

const ATTRIBUTE_RE = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function isPlainObjectLike(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBody(raw) {
  let text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (text.startsWith(PATROL_REPORT_HEADER)) text = text.slice(PATROL_REPORT_HEADER.length).trim();
  return text;
}

function codepointLength(text) {
  let count = 0;
  for (const _ of text) count += 1; // eslint-disable-line no-unused-vars
  return count;
}

/**
 * 线性扫描最后一个 `<patrol-report …>…</patrol-report>` 块（不做惰性正则回溯，避免 O(n²)）。
 * 只扫尾部 `PATROL_REPORT_SCAN_MAX` 字符；返回块是否出现、出现次数与内容。
 */
function findReportBlock(turnText) {
  const scan = turnText.length > PATROL_REPORT_SCAN_MAX ? turnText.slice(-PATROL_REPORT_SCAN_MAX) : turnText;
  const lower = scan.toLowerCase();
  const closeIdx = lower.lastIndexOf(REPORT_CLOSE);
  if (closeIdx < 0) return { present: false };
  let openIdx = lower.lastIndexOf(REPORT_OPEN, Math.max(0, closeIdx - REPORT_OPEN.length));
  while (openIdx >= 0) {
    const afterName = openIdx + REPORT_OPEN.length;
    // 必须紧跟空白或 '>'：排除 `<patrol-reportx` 这类伪标签。
    if (afterName >= scan.length) return { present: false };
    const next = scan[afterName];
    if (next === '>' || /\s/.test(next)) break;
    // 下标 0 时 `lastIndexOf(REPORT_OPEN, -1)` 会被规范钳回 0，导致此处永远命中同一下标。
    if (openIdx === 0) return { present: false };
    openIdx = lower.lastIndexOf(REPORT_OPEN, openIdx - 1);
  }
  if (openIdx < 0) return { present: false };
  let attrsEnd = lower.indexOf('>', openIdx + REPORT_OPEN.length);
  if (attrsEnd < 0 || attrsEnd > closeIdx) return { present: false };
  // 只统计「合法开标签」（后跟空白或 '>'）：正文里引用示例标签不应把单块误判成多块。
  let count = 0;
  for (let at = lower.indexOf(REPORT_OPEN); at >= 0; at = lower.indexOf(REPORT_OPEN, at + 1)) {
    const after = at + REPORT_OPEN.length;
    if (after >= lower.length) continue;
    const ch = lower[after];
    if (ch === '>' || /\s/.test(ch)) count += 1;
  }
  return {
    present: true,
    count,
    attributesRaw: scan.slice(openIdx + REPORT_OPEN.length, attrsEnd),
    body: scan.slice(attrsEnd + 1, closeIdx),
  };
}

/**
 * 从后台回合文本里提取最后一个合法 `<patrol-report>` 块。
 * 属性缺省按 fail-closed：sensitive=true、destination=admin。
 * 出现多个块视为歧义（模型可能回显示例），不猜内容，也不发送模板。
 *
 * @returns {{ok:boolean, present:boolean, text?:string, sensitive?:boolean,
 *            destination?:'admin'|'group', reason?:string}}
 */
export function extractPatrolReportBlock(turnText) {
  if (typeof turnText !== 'string' || turnText === '') return { ok: false, present: false, reason: 'no-text' };
  const found = findReportBlock(turnText);
  if (found.present !== true) return { ok: false, present: false, reason: 'no-block' };
  if (found.count > 1) return { ok: false, present: true, reason: 'ambiguous-block' };
  const attributes = {};
  ATTRIBUTE_RE.lastIndex = 0;
  for (let attr = ATTRIBUTE_RE.exec(found.attributesRaw); attr !== null; attr = ATTRIBUTE_RE.exec(found.attributesRaw)) {
    attributes[attr[1].toLowerCase()] = String(attr[2] ?? attr[3] ?? '').trim().toLowerCase();
  }
  const text = normalizeBody(found.body);
  if (text === '') return { ok: false, present: true, reason: 'empty' };
  if (codepointLength(text) > PATROL_REPORT_MAX_CHARS) return { ok: false, present: true, reason: 'too-long', tooLongChars: codepointLength(text) };
  return {
    ok: true,
    present: true,
    text,
    // 缺省/非法值都按保守值处理：只发管理员。
    sensitive: attributes.sensitive !== 'false',
    destination: attributes.destination === 'group' ? 'group' : 'admin',
  };
}

/**
 * 敏感分级：blocked（不外发原文）/ sensitive（只发管理员）/ non-sensitive（可按白名单发群）。
 *
 * @param {string} text
 * @param {{hasKnownToken?:boolean}} [options] 调用方注入的精确令牌命中结果（KNOWN_AGENT_TOKENS）
 * @returns {{classification:'blocked'|'sensitive'|'non-sensitive', reasons:string[]}}
 */
export function classifyReportSensitivity(text, options = {}) {
  const hasKnownToken = isPlainObjectLike(options) && options.hasKnownToken === true;
  if (typeof text !== 'string') return { classification: 'blocked', reasons: ['empty'] };
  const raw = String(text);
  // 判空必须先剥离装饰字符（VS/ZWJ）：纯装饰字符视觉上是空消息，未剥离会把空 body 误判成 non-sensitive。
  const strippedRaw = raw.replace(COSMETIC_INVISIBLE_RE, '');
  if (strippedRaw.trim() === '') return { classification: 'blocked', reasons: ['empty'] };
  const claimed = normalizeBody(raw);
  // 不可见字符要在归一/trim 前判定（trim 会吃掉 BOM，NFKC 也不会移除零宽/bidi）。
  const rawReasons = [];
  // 装饰性 emoji 字符（VS/ZWJ）先剥离再判不可见：它们本身不构成泄漏，但会被用来拆 token。
  if (INVISIBLE_RE.test(raw.replace(COSMETIC_INVISIBLE_RE, ''))) rawReasons.push('invisible');
  const normalized = claimed.normalize('NFKC').replace(COSMETIC_INVISIBLE_RE, '');
  // 导出函数可被任意长度输入调用：超长文本直接按 blocked 处理，避免正则回溯拖慢同步路径。
  if (normalized.length > 4096) return { classification: 'blocked', reasons: [...rawReasons, 'too-long'] };
  const reasons = [...rawReasons];
  if (hasKnownToken) reasons.push('known-token');
  if (SENSITIVE_RE.test(normalized)) reasons.push('sensitive-pattern'); // 路径 / 凭据赋值
  for (const { reason, re } of BLOCKED_PATTERNS) {
    if (re.test(normalized)) reasons.push(reason);
  }
  if (codepointLength(normalized) > PATROL_REPORT_MAX_CHARS) reasons.push('too-long');
  if (reasons.length > 0) return { classification: 'blocked', reasons };
  if (SOFT_SENSITIVE_RE.test(normalized)) return { classification: 'sensitive', reasons: ['soft-keyword'] };
  return { classification: 'non-sensitive', reasons: [] };
}

/**
 * 白名单归一：只保留合法群号（[1-9]\d* 的安全整数），并 trim。
 * 这样「首个非法项」不会遮蔽后续合法群号，配置里的空白也不会静默失效。
 */
function normalizeAllowedGroups(allowedGroups) {
  if (!Array.isArray(allowedGroups)) return [];
  const out = [];
  for (const group of allowedGroups) {
    if (typeof group !== 'string' && typeof group !== 'number') continue;
    const id = String(group).trim();
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 目的地选择：默认管理员私聊；群只允许「非敏感 + 模型选 group + 白名单命中」。
 *
 * @returns {{destination:'owner'}|{destination:'group', groupId:string}}
 */
export function chooseReportDestination(input = {}) {
  const classification = isPlainObjectLike(input) ? input.classification : null;
  const modelDestination = isPlainObjectLike(input) ? input.modelDestination : null;
  if (classification !== 'non-sensitive') return { destination: 'owner' };
  if (modelDestination !== 'group') return { destination: 'owner' };
  const allowedGroups = normalizeAllowedGroups(isPlainObjectLike(input) ? input.allowedGroups : []);
  const groupId = allowedGroups[0];
  if (groupId === undefined) return { destination: 'owner' };
  // task-52（P3-5）：这里的 allowGroupPatrolReport() 恒真——它**不是**群白名单闸门。
  // 真正的闸门是 bridge 的 allow.groups + captureSendGuard（发送前按当前配置再校验一次），
  // 本函数保留该调用只为兼容既有签名、并给将来「多群选择/更多条件」留单一判定点；
  // 不要据此认为 chooseReportDestination 内已做二次白名单校验。
  if (!allowGroupPatrolReport({ classification: 'non-sensitive', allowedGroups, groupId })) {
    return { destination: 'owner' };
  }
  return { destination: 'group', groupId };
}

/** 历史模板格式工具，仅保留兼容；生产汇报计划不调用。 */
export function composeTemplateReportBody(input = {}) {
  const platform = isPlainObjectLike(input) ? input.platform : null;
  const label = DEFAULT_TEMPLATE_LABELS[String(platform ?? '')] ?? DEFAULT_TEMPLATE_LABELS.tieba;
  const rawIndex = isPlainObjectLike(input) ? input.readIndex : null;
  const readIndex = Number.isSafeInteger(rawIndex) && rawIndex >= 1 ? rawIndex : 1;
  const rawProbability = isPlainObjectLike(input) ? input.probability : null;
  const probability = typeof rawProbability === 'number' && Number.isFinite(rawProbability)
    ? Math.min(1, Math.max(0, rawProbability))
    : 0;
  return `今日第 ${readIndex} 次自主逛${label}完成（概率 ${Math.round(probability * 100)}%）。`;
}

/**
 * 组合最终汇报计划（bridge 只负责按 plan 发送）。
 *
 * 审计契约：classification 只取 `non-sensitive|sensitive|blocked` 三值。
 *  · 有块但不可用（超长/空/多块歧义）→ `blocked` + reportBlockPresent=true；
 *  · 无块/无文本 → 保守记 `sensitive` + reportBlockPresent=false（不发送）。
 *
 * @returns {{
 *   message:string|null, body:string|null,
 *   destination:'owner'|'group'|null, groupId:string|null,
 *   classification:'non-sensitive'|'sensitive'|'blocked',
 *   source:'model'|'none', reasons:string[], reportBlockPresent:boolean
 * }}
 */
export function buildPatrolReportPlan(input = {}) {
  const safe = isPlainObjectLike(input) ? input : {};
  const fallback = (classification, reasons, reportBlockPresent) => ({
    message: null,
    body: null,
    destination: null,
    groupId: null,
    classification,
    source: 'none',
    reasons,
    reportBlockPresent,
  });

  const block = extractPatrolReportBlock(safe.turnText);
  if (block.ok !== true) {
    const present = block.present === true;
    // 抽取阶段失败（空/歧义/超长）与「被安全分类拦截」是两件事：用 invalidBlock 标记，审计必须区分。
    return {
      ...fallback(present ? 'blocked' : 'sensitive', [block.reason ?? 'no-block'], present),
      invalidBlock: present,
      // 超长丢弃必须能查到实际码点数（审计/日志都用它，不能只写 unknown）。
      ...(Number.isSafeInteger(block.tooLongChars) ? { tooLongChars: block.tooLongChars } : {}),
    };
  }

  const graded = classifyReportSensitivity(block.text, {
    hasKnownToken: safe.hasKnownToken === true,
  });
  // 分类阶段返回 blocked 时直接返回：这里的 too-long 只可能来自 NFKC 归一撑长（原始码点未超限），
  // 报一个小于上限的「码点数」会让运维误判，所以不带此字段；真正的码点数由抽取层给出。
  if (graded.classification === 'blocked') return fallback('blocked', graded.reasons, true);

  // 模型显式标记敏感：尊重其保守声明，降级为 sensitive（只发管理员）。
  const classification = graded.classification === 'non-sensitive' && block.sensitive === true
    ? 'sensitive'
    : graded.classification;
  const reasons = classification !== graded.classification ? [...graded.reasons, 'model-marked'] : graded.reasons;
  const destination = chooseReportDestination({
    classification,
    modelDestination: block.destination,
    allowedGroups: Array.isArray(safe.allowedGroups) ? safe.allowedGroups : [],
  });
  // 长度上限在**完整文本分类之后**判定：超限不截断、不发送，避免把敏感片段切断后绕过分级。
  // 纵深防御：分类器已按同一码点上限拦截，正常情况走不到这里；保留以便分类器未来放宽时仍能守住。
  const codepointTotal = [...block.text].length;
  if (codepointTotal > MAX_PATROL_REPORT_CHARS) {
    return { ...fallback('blocked', [...reasons, 'too-long'], true), tooLongChars: codepointTotal };
  }
  return {
    message: block.text,
    body: block.text,
    destination: destination.destination,
    groupId: destination.destination === 'group' ? destination.groupId : null,
    classification,
    source: 'model',
    reasons,
    reportBlockPresent: true,
  };
}
