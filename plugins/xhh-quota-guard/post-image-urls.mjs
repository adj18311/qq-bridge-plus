// plugins/xhh-quota-guard/post-image-urls.mjs
//
// 小黑盒「帖子详情」结果的离线图片地址提取器（阶段 2D / A 部分）。
//
// 职责边界（刻意不做的事）：
//  · 不联网、不下载、不校验图片真实性 —— 只做「从可信的成功结果里把候选地址捞出来」；
//  · 不判断图床白名单 —— 主机/协议/重定向的安全判定在下载侧（B 部分的 safe-fetch/image-content）；
//  · 不改授权、额度、暂停或发送路径 —— 本模块是纯函数，没有副作用、没有 hook；
//  · 不把视频地址当图片（`videoUrl` 一律忽略）；
//  · 不读评论/头像/无关网页图片：只认 `images` 与 `coverImages` 两个字段（含常见大小写与下划线变体）。
//
// 为什么需要「容错解析」而不是直接 JSON.parse：
//  MCP 工具结果是 `{ content: [{ type: 'text', text: '<JSON 文本>' }] }`，但同一形状在
//  不同版本/不同包装层下会变成：结构化对象（SDK 直接返回对象）、PascalCase（Pascal 序列化）、
//  snake_case（某些代理层），甚至文本里在 JSON 前后带了提示语。全部盲信会误判成「没有图片」，
//  全部盲试又可能把错误文本当成功解析 —— 所以这里只在「已确认不是错误结果」的前提下尝试，
//  且每个失败分支都要留下 notes 供上层写进文字说明（不许静默丢弃）。
//
// MCP 结构化输出（`structuredContent`）：
//  新版 SDK/服务端会在 `{ isError, content, structuredContent }` 里额外给一份结构化对象（`structuredContent`），
//  它可能直接是 PostDetail，也可能再包一层 `{data|post|result|detail}`，甚至是数组或 JSON 字符串。
//  只解析 `content` 会漏掉这类结果（模型看不到图），所以这里把 structuredContent 也当作候选来源，
//  但**深度仍然有界**（最多两层包装），避免把无关的深层结构当成帖子内容。

/** 一次调用最多返回多少个地址（去重后）。下载侧另有更严的取图上限，这里只是硬上限。 */
export const XHH_POST_IMAGE_MAX_URLS = 30;
/** 单个地址的最大字符数；超过视为畸形（真实图床地址远短于此）。 */
export const XHH_POST_IMAGE_MAX_URL_LENGTH = 4096;
/** 单个文本块的最大字符数；超过直接放弃解析（防止把 10MB 的文本当 JSON 反复切片）。 */
export const XHH_POST_IMAGE_MAX_TEXT_LENGTH = 1_000_000;
/** 单个列表最多看多少项（防止超长数组拖慢/爆内存）。 */
export const XHH_POST_IMAGE_MAX_LIST_ITEMS = 200;
/** 展开结构化输出时最多访问的节点数（对象/数组/字符串各算一个）。
 *  正常帖子详情只有个位数节点；1000 是防御上限，用来挡住宽树/畸形树把 CPU 吃满。 */
export const XHH_POST_IMAGE_MAX_VISITED_NODES = 1000;
/** notes 最多保留多少条（超出折叠成一条汇总）。 */
export const XHH_POST_IMAGE_MAX_NOTES = 20;

const IMAGE_FIELDS = new Map([
  ['images', 'images'],
  ['coverimages', 'coverImages'],
  ['coverimage', 'coverImages'],
  // 下划线/连字符变体在规范化时会被剥掉，因此这里只需要小写字母形式。
]);

/** 把任意 key 规范化成「只看小写字母和数字」的形式，用于容忍 Images / cover_images / COVER-IMAGES。 */
function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 从列表里挑出可能的地址字符串：既支持 `["url"]`，也支持 `[{url}|{src}|{imageUrl}|{image}]`。
 * 其余形状（数字、null、嵌套数组、对象里没有地址字段）一律返回 null，由调用方记为「畸形」。
 */
function urlCandidateOf(item) {
  if (typeof item === 'string') return item;
  if (!isPlainObject(item)) return null;
  for (const key of ['url', 'src', 'imageUrl', 'image', 'image_url', 'img']) {
    const value = item[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

/**
 * 地址规范化。返回 `{ url, key }`：
 *  · `url` 保留原始写法（只修 `//host/path` 协议相对地址），供 qq_send_image 等既有路径复用；
 *  · `key` 是用于去重的规范化形式（去掉 hash 之外不做业务改写）。
 * 非法地址返回 null（协议不是 http/https、带用户名密码、超长、解析失败）。
 */
function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > XHH_POST_IMAGE_MAX_URL_LENGTH) return null;
  const candidate = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // 带账号密码的地址一律不接：既不像图床地址，也会把凭据带进下游日志。
  if (parsed.username !== '' || parsed.password !== '') return null;
  return { url: candidate, key: parsed.toString() };
}

/** 尝试把文本当 JSON 解析；失败时截取首个 `{` 到末尾 `}` 再试一次（容忍前后提示语）。 */
function parseJsonText(text) {
  const body = text.trim();
  if (body === '') return { ok: false, reason: 'empty' };
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    /* 继续尝试 */
  }
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, reason: 'not-json' };
  try {
    return { ok: true, value: JSON.parse(body.slice(start, end + 1)) };
  } catch {
    return { ok: false, reason: 'not-json' };
  }
}

/** 这份对象自己是否带 images / coverImages（用于决定要不要报「文本不是 JSON」）。 */
function hasImageFields(payload) {
  if (!isPlainObject(payload)) return false;
  return Object.keys(payload).some((key) => IMAGE_FIELDS.has(normalizeKey(key)));
}

/** 结构化包装层的键名：这些键下的对象/数组仍可能是同一份帖子详情。 */
const WRAPPER_KEYS = ['data', 'post', 'result', 'detail', 'structuredcontent', 'payload'];

/**
 * 把结构化值展开成候选列表，深度有界（MAX_WRAPPER_DEPTH 层；足够覆盖 structuredContent→data→post）。
 *  · 对象 ⇒ 自身入列，并沿 WRAPPER_KEYS 继续下钻；
 *  · 数组 ⇒ 逐项展开（受 XHH_POST_IMAGE_MAX_LIST_ITEMS 限制，**且数组也算一层深度**）；
 *  · 字符串 ⇒ 当作可能的 JSON 文本再解析一次（有些代理把 structuredContent 序列化成字符串）。
 * 不做无限递归：超过深度或项数就停下并记 note，绝不静默。
 */
// 深度只是安全网（真正的闸是上面的节点预算）：真实结果里 structuredContent、{code,msg,data}、
// {data:{post:{...}}} 这类信封很常见，深度 3 会把「图片在第 4 层」的真实帖子判成没图（静默失效）。
// 放到 8 层既能覆盖常见信封，又能在自引用/超深构造上及时停下（另配节点预算 1000 兜宽树）。
const MAX_WRAPPER_DEPTH = 8;

function pushStructuredPayloads(value, ctx, depth) {
  const note = (message) => {
    if (ctx.noteSet.has(message)) return;
    ctx.noteSet.add(message);
    if (ctx.notes.length >= XHH_POST_IMAGE_MAX_NOTES * 4) return;
    ctx.notes.push(message);
  };
  if (value === null || value === undefined) return;
  if (ctx.exhausted) return;
  // 全局节点预算：宽树（几千个对象）或层层包装都能把这里变成 CPU 黑洞。
  ctx.visited += 1;
  if (ctx.visited > XHH_POST_IMAGE_MAX_VISITED_NODES) {
    ctx.exhausted = true;
    note(`结构化输出节点超过 ${XHH_POST_IMAGE_MAX_VISITED_NODES} 个，未继续解析`);
    return;
  }
  if (typeof value === 'string') {
    if (value.length > XHH_POST_IMAGE_MAX_TEXT_LENGTH) {
      note('结构化输出文本过长，未解析图片');
      return;
    }
    const parsed = parseJsonText(value);
    if (parsed.ok && (isPlainObject(parsed.value) || Array.isArray(parsed.value))) {
      // 字符串里再套 JSON 同样算一层，避免 `"[\"[\"...\"]"\"` 这类构造绕过深度限制。
      pushStructuredPayloads(parsed.value, ctx, depth + 1);
    }
    return;
  }
  if (Array.isArray(value)) {
    // 环检测：自己包含自己（或相互包含）的数组必须被挡住，否则无限递归 → 栈溢出。
    if (ctx.seen.has(value)) {
      note('结构化输出存在循环引用，已停止展开');
      return;
    }
    if (depth >= MAX_WRAPPER_DEPTH) {
      note('结构化输出嵌套过深，未继续解析');
      return;
    }
    ctx.seen.add(value);
    const limit = Math.min(value.length, XHH_POST_IMAGE_MAX_LIST_ITEMS);
    for (let i = 0; i < limit; i += 1) pushStructuredPayloads(value[i], ctx, depth + 1);
    if (value.length > limit) note(`结构化输出数组过长，只看了前 ${limit} 项`);
    return;
  }
  if (!isPlainObject(value)) return;
  if (ctx.seen.has(value)) {
    note('结构化输出存在循环引用，已停止展开');
    return;
  }
  ctx.seen.add(value);
  ctx.payloads.push(value);
  if (depth >= MAX_WRAPPER_DEPTH) {
    note('结构化输出嵌套过深，未继续解析');
    return;
  }
  for (const key of Object.keys(value)) {
    const normalized = normalizeKey(key);
    if (!WRAPPER_KEYS.includes(normalized)) continue;
    const nested = value[key];
    if (isPlainObject(nested) || Array.isArray(nested) || typeof nested === 'string') {
      pushStructuredPayloads(nested, ctx, depth + 1);
    }
  }
}

/**
 * 收集「可能是帖子详情」的候选对象：根对象、根对象的 data/post/result 之一层、以及数组形式的 content。
 * 深度刻意限制为两层 —— 再深的嵌套更像是别的协议消息，宁可漏也不要误取。
 */
function collectPayloads(result, notes) {
  const payloads = [];
  // 节点预算/环检测/说明去重是「整份结果共享」的：文本块解析出来的 JSON 与 structuredContent
  // 走同一套预算，避免 10 个文本块各带一棵宽树把 CPU 吃满。
  const ctx = { payloads, notes, visited: 0, exhausted: false, seen: new WeakSet(), noteSet: new Set() };

  // 文本块解析失败的说明先挂起：只有在整份结果里完全找不到图片字段时才写进 notes。
  // 否则「content.text 是句人话 + structuredContent 里有真图片」会被误报成「结果文本不是 JSON」。
  const textFailureNotes = [];
  const pushParsed = (value) => {
    if (!isPlainObject(value) && !Array.isArray(value)) return;
    pushStructuredPayloads(value, ctx, 0);
  };
  const pushFromText = (text) => {
    if (typeof text !== 'string') return;
    if (text.length > XHH_POST_IMAGE_MAX_TEXT_LENGTH) {
      textFailureNotes.push(`文本过长（${text.length} 字符），未解析图片`);
      return;
    }
    const parsed = parseJsonText(text);
    if (!parsed.ok) {
      if (parsed.reason === 'not-json') textFailureNotes.push('结果文本不是 JSON，未解析图片');
      return;
    }
    // 关键：文本里的 JSON 也按「包装层」展开（{code,msg,data:{post:{images}}} 是常见信封）。
    // 只把它当成一个不透明对象，会让真实帖子的正文图静默丢失 —— 属于功能失效而非报错。
    pushParsed(parsed.value);
  };

  if (typeof result === 'string') {
    pushFromText(result);
    return payloads;
  }
  if (Array.isArray(result)) {
    for (const entry of result) {
      if (!isPlainObject(entry)) continue;
      if (typeof entry.text === 'string') pushFromText(entry.text);
      else if (entry.json !== undefined) pushParsed(entry.json);
    }
    return payloads;
  }
  if (!isPlainObject(result)) return payloads;

  if (Array.isArray(result.content)) {
    for (const entry of result.content) {
      if (!isPlainObject(entry)) continue;
      // 已经是图片内容的条目不是「地址来源」，跳过（它属于上一步已经转换好的产物）。
      if (entry.type === 'image') continue;
      if (typeof entry.text === 'string') pushFromText(entry.text);
      else if (entry.json !== undefined) pushParsed(entry.json);
    }
  } else if (typeof result.content === 'string') {
    pushFromText(result.content);
  }
  if (typeof result.text === 'string') pushFromText(result.text);

  // 结构化结果（SDK 直接把 PostDetail 序列化成对象；`structuredContent` 由 WRAPPER_KEYS 覆盖）
  // ——把根对象本身也作为候选。
  pushStructuredPayloads(result, ctx, 0);
  const anyImageFields = payloads.some((payload) => isPlainObject(payload) && hasImageFields(payload));
  if (!anyImageFields) notes.push(...textFailureNotes);
  return payloads;
}

/**
 * 从一份候选对象里取 images / coverImages。
 * 顺序：先正文图（images），再封面（coverImages）—— 正文图对「帖子讲了什么」信息量更大。
 */
function collectFromPayload(payload, urls, seen, state, notes) {
  if (!isPlainObject(payload)) return;
  const buckets = new Map([['images', []], ['coverImages', []]]);
  for (const key of Object.keys(payload)) {
    const normalized = normalizeKey(key);
    const bucket = IMAGE_FIELDS.get(normalized);
    if (bucket === undefined) continue;
    const value = payload[key];
    if (!Array.isArray(value)) {
      notes.push(`字段 ${bucket} 不是数组，已忽略`);
      continue;
    }
    if (value.length > XHH_POST_IMAGE_MAX_LIST_ITEMS) {
      notes.push(`字段 ${bucket} 超过 ${XHH_POST_IMAGE_MAX_LIST_ITEMS} 项，只取前 ${XHH_POST_IMAGE_MAX_LIST_ITEMS} 项`);
    }
    const target = buckets.get(bucket);
    for (const item of value.slice(0, XHH_POST_IMAGE_MAX_LIST_ITEMS)) target.push(item);
  }

  for (const bucket of ['images', 'coverImages']) {
    for (const item of buckets.get(bucket)) {
      const raw = urlCandidateOf(item);
      if (raw === null) {
        state.malformed += 1;
        continue;
      }
      const normalized = normalizeUrl(raw);
      if (normalized === null) {
        state.invalid += 1;
        continue;
      }
      if (seen.has(normalized.key)) {
        state.duplicates += 1;
        continue;
      }
      if (urls.length >= XHH_POST_IMAGE_MAX_URLS) {
        state.truncated = true;
        continue;
      }
      seen.add(normalized.key);
      urls.push(normalized.url);
    }
  }
}

/**
 * 从 `get_post_detail` 的工具结果里提取候选图片地址（纯函数、有界、不联网）。
 *
 * 返回 `{ urls, notes }`：
 *  · `urls`：去重后的 http(s) 地址，保持原始写法（协议相对地址会补成 https）；
 *  · `notes`：给人看的说明（解析失败、字段形态异常、超限截断、去重数量等），上限
 *    {@link XHH_POST_IMAGE_MAX_NOTES} 条。调用方应把它拼进返回文字，**不要静默丢弃**。
 *    注意：**“没有图片”本身不算说明**（无图帖是常态），`urls` 为空且无异常时 `notes` 也为空，
 *    调用方因此不会给模型追加任何文字。
 *
 * 安全前提：只处理「看起来成功」的结果。`isError === true` 一律不提取 —— 拒绝/异常结果里的
 * 文本可能恰好包含地址，但那不是帖子内容，取出来就是伪造读取成功。
 */
export function extractXhhPostImageUrls(result) {
  const urls = [];
  const notes = [];
  const state = { malformed: 0, invalid: 0, duplicates: 0, truncated: false };

  if (result === null || result === undefined) {
    notes.push('结果为空，未解析图片');
    return { urls, notes };
  }
  if (isPlainObject(result) && result.isError === true) {
    notes.push('工具结果为错误（isError=true），不提取图片');
    return { urls, notes };
  }

  const payloads = collectPayloads(result, notes);
  if (payloads.length === 0) {
    if (notes.length === 0) notes.push('结果中没有可解析的内容，未解析图片');
    return { urls, notes };
  }

  const seen = new Set();
  for (const payload of payloads) collectFromPayload(payload, urls, seen, state, notes);

  if (state.malformed > 0) notes.push(`${state.malformed} 个图片条目不是地址字符串，已跳过`);
  if (state.invalid > 0) notes.push(`${state.invalid} 个地址不是可用的 http(s) 地址，已跳过`);
  if (state.duplicates > 0) notes.push(`${state.duplicates} 个重复地址已丢弃`);
  if (state.truncated) notes.push(`地址数量超过 ${XHH_POST_IMAGE_MAX_URLS} 个，已截断`);

  if (notes.length > XHH_POST_IMAGE_MAX_NOTES) {
    const dropped = notes.length - XHH_POST_IMAGE_MAX_NOTES + 1;
    return { urls, notes: [...notes.slice(0, XHH_POST_IMAGE_MAX_NOTES - 1), `另有 ${dropped} 条说明已省略`] };
  }
  return { urls, notes };
}