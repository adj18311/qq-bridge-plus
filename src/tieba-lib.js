// 百度贴吧只读抓取库（t70）。
//
// 为什么单独抽一个纯模块：抓取（safeFetch）与解析分离，解析部分可以完全离线做单元测试。
//
// 实测事实（2026-10-07）：
//   · PC 版 `https://tieba.baidu.com/f?kw=…` 一律 403「百度安全验证」，裸 fetch / 浏览器 UA 都过不去；
//   · **移动版** `https://tieba.baidu.com/mo/q/m?kw=<吧名>&lp=5028` 返回 200，正文含吧名、关注数、
//     帖子数与帖子列表（`li.tl_shadow[data-tid]` 里带作者/时间/标题/回复数）；
//   · 能过反爬靠的是请求头（`src/safe-fetch.js:187` 的 `user-agent: Mozilla/5.0` 与 `:189` 的
//     `accept-language: zh-CN,zh;q=0.9`），所以**抓取必须走 `safeFetch()`**，不要自己拼 fetch。
//     ⚠️ 2026-10-08 更正：光有上面这两条默认头**不够**——不带 cookie 时吧页与帖页都回 403 /
//     百度安全验证页；能过的是「cookie + **完整移动版 UA**」，见下面那段登录态说明。
//
// 本模块只做四件事：入参规范化、URL 构造、HTML 提取、精简文本格式化。
// 它**不发网络请求、不读写文件、不依赖桥接状态**，因此可以在测试里完全离线驱动。
//
// 可选登录态（2026-10-08 接入）：配置项 `socialV2.tieba.cookieFile` 指向一个**只放 cookie 值**的
// 文件（默认空 = 不启用），本模块在抓取时把它读成 `headers: { cookie }` 交给 `safeFetch`：
//   · cookie 值**只**出现在请求头里，不进日志、不进返回文本、不进任何写盘内容；
//   · 文件缺失/为空 ⇒ 视为未启用（不抛、不打印）；
//   · **吧页与帖子页都受益**（2026-10-08 实测后统一，见 `fetchBarPage` 的注释）：cookie + 完整移动版
//     UA 才是能过百度服务端校验页的组合——同一个吧页 URL、只去掉 cookie 就回 403「百度安全验证」；
//     所以在这次改动之前「吧页保持匿名」的做法本身就是吧页抓不到内容的直接原因；
//   · 解析逻辑（parseBarPage / parseThreadPage / parseMobileFloors 等）与登录态完全无关，未做改动。

import fs from 'node:fs';
import { safeFetch, safeFetchBuffer } from './safe-fetch.js';

/** 吧名长度上限（按字符计，避免超长输入把 URL 撑爆）。 */
export const BAR_NAME_MAX = 40;
/** tid 长度上限（贴吧 tid 是十位左右数字，留出余量）。 */
export const TID_MAX_LEN = 20;
/** 一页最多返回多少条帖子/楼中楼，防止上下文被一页淹没。 */
export const MAX_THREADS = 50;
export const MAX_POSTS = 40;
/** 单条标题/正文的截断长度。 */
export const TITLE_MAX = 120;
export const CONTENT_MAX = 800;
/**
 * 格式化后的帖子文本长度上界（硬保证，含表头与尾注）。
 *
 * 一页真实帖子是 28~30 层楼、每层正文最多 `CONTENT_MAX`：不设上界时最坏能到 ~25KB，
 * 而做专用工具的全部意义就是把一页压成小块，所以这里给 16KB 的硬上界并如实标注截断。
 */
export const THREAD_TEXT_MAX = 16000;
/**
 * 一次最多取几页（多页语义的上限）。
 *
 * 10 是「够用」与「别把 IP 打热」之间的折中（用户确认的最终值）：一页 30 层，10 页 ≈ 300 层；
 * 再多就该让模型换个 tid 或直接用 web_search 了。**超出不是静默丢弃**：调用方会拿到
 * `truncated:true` 与一句「请求了 N 页、只取了前 M 页」的说明，格式化文本里也会写出来。
 *
 * 这个数也是 MCP 侧**自适应调用超时**的页数上界：`60s + 20s × 计划页数`（见
 * `src/mcp-snowluma-safe.js` 的 `tiebaReadTimeoutMs`），计划页数就是 `normalizePageRange`
 * 按这条上限截断后的结果。
 */
export const THREAD_PAGES_MAX = 10;
/**
 * 多页合计的格式化文本硬上界。
 *
 * 单页仍是 `THREAD_TEXT_MAX`（16000）——多页不能因为「页多了」就把上下文撑爆，所以给的是一条
 * **合计**上界：10 页满配最坏 10×16000=160000，这里砍到 40000（约两页半的上下文预算），
 * 放不下就少给几层并在文本里如实说明截断。
 */
export const THREAD_PAGES_TEXT_MAX = 40000;
/**
 * 一次最多提取多少个楼层图片 URL（桥接**只提取、不下载**，见 `extractImageUrls`）。
 *
 * 这个数是「JSON 体积」的安全上界，不是给模型看图的数量上限：真正喂给模型的上限在 MCP 侧
 * （`TIEBA_IMAGE_MAX` = 10 张），因为**下载与变成图像内容**是 MCP 的事。
 * 取 40 而不是刚好 10：楼层正文里混着站内表情、缩略图、重复地址，过滤与去重之后还要够 10 张，
 * 所以按「10 张 × 4 倍余量」给候选上限。
 */
export const TIEBA_IMAGE_MAX_URLS = 40;
/**
 * 一次最多把几张图变成给模型看的图像内容。
 *
 * 10 张（用户确认的最终值）与下面两条上限配合：张数、单张 4MiB、以及**总量 25MiB** ——
 * 一张图动辄几百 KB~几 MB，真正卡住上下文和请求体的是总量那一条，张数只是它的第二条护栏。
 * 超出的**如实标注未取**，不静默丢。
 */
export const TIEBA_IMAGE_MAX = 10;
/** 单张图片字节上限（与 `safeFetchBuffer` 默认值同量级）。 */
export const TIEBA_IMAGE_BYTES_MAX = 4 * 1024 * 1024;
/**
 * 一次读帖**取到的图片合计**字节上限（25MiB）。
 *
 * 单张 4MiB × 10 张最坏 40MiB，一次读帖把 40MiB base64 塞进请求体太重了，所以再加一条合计上界：
 * 累计已取字节达到 25MiB（含跨过的那一张，最多再超一张 4MiB）就**停止下载后续图片**，
 * 并把「已取几张、因总量上限跳过几张」写进返回文字——到顶不是静默丢。
 */
export const TIEBA_IMAGE_TOTAL_BYTES_MAX = 25 * 1024 * 1024;

const MOBILE_BAR_URL = 'https://tieba.baidu.com/mo/q/m';
/**
 * 帖子页入口——**和吧页同一个移动版入口**（只是把 `kw` 换成 `kz`）。
 *
 * 2026-10-08 实测对比（同一个公开帖子，同一套请求头 + 登录 cookie，按 IP 直连）：
 *   · `https://tieba.baidu.com/p/<tid>?lp=5028&mo_device=1` → HTTP 200 但只有 **7091 字节**，
 *     `<title>贴吧小程序</title>`、0 个楼层容器——是空壳，不是内容；
 *   · `https://tieba.baidu.com/mo/q/m?kz=<tid>&lp=5028` → 200 / **184666 字节** / 28 层楼；
 *   · 再加 `&pn=30` → 200 / 190437 字节 / 30 层楼（`fn` 从 33 起），页面自己的 conf 是
 *     `page:{req_num:30,page_size:30,offset:0,current_page:1,total_page:4}` —— 所以 `pn` 就是**楼层偏移**，
 *     每页 30 层，第 N 页的偏移是 `(N-1)*30`。
 */
const MOBILE_THREAD_URL = 'https://tieba.baidu.com/mo/q/m';

/**
 * 规范化吧名：去首尾空白、去掉 URL 编码痕迹、拒绝控制字符与超长输入。
 * 返回 `{ ok: true, value }` 或 `{ ok: false, error }`，永不抛异常（调用方要把它变成工具错误文案）。
 */
export function normalizeBarName(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: '吧名不能为空' };
  let decoded = text;
  try {
    // 用户可能直接粘贴 URL 编码后的吧名（例如「%E5%8E%9F%E7%A5%9E」）。
    if (/%[0-9A-Fa-f]{2}/.test(text)) decoded = decodeURIComponent(text);
  } catch {
    return { ok: false, error: '吧名里的百分号编码无法解码，请直接给中文吧名' };
  }
  const value = decoded.trim();
  if (!value) return { ok: false, error: '吧名不能为空' };
  // 控制字符与路径/查询分隔符都不允许：吧名要原样进 URL 的查询参数。
  if (/[\u0000-\u001f\u007f/?#&]/.test(value)) {
    return { ok: false, error: '吧名不能包含控制字符或 / ? # & 这类符号' };
  }
  if (Array.from(value).length > BAR_NAME_MAX) {
    return { ok: false, error: `吧名过长（上限 ${BAR_NAME_MAX} 字）` };
  }
  return { ok: true, value };
}

/** 规范化 tid：只接受纯数字串。 */
export function normalizeTid(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: 'tid 不能为空' };
  if (!/^\d+$/.test(text)) return { ok: false, error: 'tid 必须是纯数字（来自帖子链接里的 /p/<tid>）' };
  if (text.length > TID_MAX_LEN) return { ok: false, error: `tid 过长（上限 ${TID_MAX_LEN} 位）` };
  if (text === '0') return { ok: false, error: 'tid 不能是 0' };
  return { ok: true, value: text };
}

/** 页码：1 起，最多 100（再往后贴吧也不会给有效内容）。 */
export function normalizePage(raw) {
  if (raw === undefined || raw === null || raw === '') return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return 1;
  return Math.min(n, 100);
}

/**
 * 页码范围：`"1-3"` / `"2"` / 数组 / 数字 / 缺省（用 `page`）→ `{ pages, requestedPages, truncated, ... }`。
 *
 * 为什么单独一个函数：多页支持的唯一注入面就是这一段字符串。规则写死、可离线测试：
 *   · 只认 `N` 与 `N-M`（分隔符还接受 `~`；两端顺序颠倒会自动摆正，`3-1` = `1-3`）；
 *   · 去重 + 升序：页码是楼层偏移，顺序有意义，`3,1,3` 应变成 `[1,3]`；
 *   · 单页号仍走 `normalizePage`（非法回落 1、上限 100），非法整串**绝不抛**，退回单独 `page` 并在
 *     `note` 里如实说明「看不懂」；
 *   · 超过 `maxPages` 时**只截断、不静默**：`truncated:true` + `requestedPages` 让调用方能写出
 *     「请求了 12 页、只取了前 10 页」这种诚实说明。
 */
export function normalizePageRange(raw, { maxPages = THREAD_PAGES_MAX, page = 1 } = {}) {
  const cap = Number.isFinite(maxPages) && maxPages > 0 ? Math.floor(maxPages) : THREAD_PAGES_MAX;
  const fallback = normalizePage(page);
  const spec = String(raw ?? '').trim();
  let list = [];
  let invalid = false;
  if (raw === undefined || raw === null || spec === '') {
    list = [fallback];
  } else if (Array.isArray(raw)) {
    list = raw.map((v) => normalizePage(v));
    if (!list.length) list = [fallback];
  } else if (typeof raw === 'number') {
    list = [normalizePage(raw)];
  } else {
    const range = spec.match(/^(\d{1,3})\s*[-~]\s*(\d{1,3})$/);
    if (range) {
      let a = normalizePage(range[1]);
      let b = normalizePage(range[2]);
      if (a > b) [a, b] = [b, a];
      for (let p = a; p <= b; p += 1) list.push(p);
    } else if (/^\d{1,3}$/.test(spec)) {
      list = [normalizePage(spec)];
    } else if (spec.includes(',')) {
      // `"1,3"` 这种写法模型很爱给：逗号分隔的每一项都按单页号规范化，认不出就整串退回 `page`。
      const items = spec.split(',').map((s) => s.trim()).filter(Boolean);
      const parsed = items.map((s) => (/^\d{1,3}$/.test(s) ? normalizePage(s) : NaN));
      if (parsed.length && parsed.every((n) => Number.isInteger(n))) list = parsed;
      else { invalid = true; list = [fallback]; }
    } else {
      invalid = true;
      list = [fallback];
    }
  }
  const uniq = [...new Set(list)].sort((a, b) => a - b);
  const requestedPages = uniq.length;
  const pages = uniq.slice(0, cap);
  return {
    pages,
    requestedPages,
    truncated: requestedPages > pages.length,
    maxPages: cap,
    invalid,
    ...(invalid ? { note: `pages 参数看不懂（${cut(spec, 20) || '空'}），已按第 ${fallback} 页处理` } : {})
  };
}

/**
 * 移动版吧页 URL。
 *
 * **形态本身不需要改**（2026-10-08 实测：同一台机器、同一个 IP、同一个 URL，只换请求头做 A/B，
 * 见 `fetchBarPage`）——现在这个 `/mo/q/m?kw=<吧名>&lp=5028`（第一页不带 `pn`）就是能用的形态。
 * 同一天在同一台机器上试过、并**否掉**的其它形态：
 *   · `&pn=0` / `&ie=utf-8&pn=0` / `&mo_device=1` / `&rn=30&pn=0` / 再加 `&is_jingpost=0`：
 *     都是 200、约 302KB、`parseBarPage` 解析出 **30 条**线程，与这里的形态**完全等价**
 *     （所以没必要为了「换形态」去加参数）；
 *   · PC 形态 `https://tieba.baidu.com/f?kw=<吧名>&ie=utf-8`（配桌面 UA + cookie）：200 但只有
 *     约 11.2KB 空壳、解析出 **0 条**，与 2026-10-07 的实测一致；
 *   · **`&lm=0` 会被 WAF 直接拦**（403 + 百度安全验证页，2520 字节），`kw`/`pn` 之外的多余参数不要加。
 * 结论：吧页过不去是**登录态（请求头）**问题，不是 URL 形态问题；形态保持不变，
 * 改的是 `fetchBarPage` 现在会把 cookie 交出去（见该函数的注释）。
 *
 * `pn` 沿用旧值（每页 50 条、第 N 页 `(N-1)*50`）：本轮**没有**实测验证过第二页的偏移量——
 * 本轮预算全部用在「同 IP 下带/不带 cookie 的对照」上，不拿没测过的数字冒充实测值。
 */
export function buildBarUrl(bar, page = 1) {
  const p = normalizePage(page);
  const params = new URLSearchParams({ kw: bar, lp: '5028' });
  if (p > 1) params.set('pn', String((p - 1) * 50));
  return `${MOBILE_BAR_URL}?${params.toString()}`;
}

/**
 * 帖子页 URL：走**移动版 `/mo/q/m?kz=<tid>`**（与吧页同一入口）。
 *
 * 曾经是 `/p/<tid>?lp=5028&mo_device=1`，2026-10-08 实测那只是 7091 字节的空壳
 * （`<title>贴吧小程序</title>`、0 层楼），改了才有真实内容；`pn` 是楼层偏移（每页 30 层），
 * 所以第 N 页是 `(N-1)*30`——这一条也用真实页第 2 页（`pn=30` → `fn` 从 33 起）验证过。
 */
export function buildThreadUrl(tid, page = 1) {
  const p = normalizePage(page);
  const params = new URLSearchParams({ kz: String(tid), lp: '5028' });
  if (p > 1) params.set('pn', String((p - 1) * 30));
  return `${MOBILE_THREAD_URL}?${params.toString()}`;
}

// ── 「被百度拦住 → 直接给网页搜索结果」降级（t71 切片 + t72 换源）─────────
//
// 背景（2026-10-08）：百度对贴吧的限流是按 IP 起作用的，一旦命中安全验证页，旧返回对模型就是个
// 死胡同——只给一句「改用 web_search」，模型得自己再发一次搜索请求、还得自己组织 site: 查询。
// 现在抓取命中安全验证页（或节流冷却直接拒绝）时，本模块自己跑一次网页搜索，把结果并进
// 返回文本，让**一次**工具调用就能拿到可用信息。
//
// 为什么把搜索源从 Bing 换成 360（2026-10-08 实测）：
//   · `cn.bing.com/search?q=site:tieba.baidu.com …` 对贴吧的索引是**空的**——解析器没坏，
//     是数据源没结果，所以真实验收一直落在 `fallback:'search-failed'`；
//   · `https://www.so.com/s?q=site%3Atieba.baidu.com …` 直连 200、无验证码、无 Cookie、不需要
//     JS，每个 site: 查询能稳定给 5~7 条**真实**贴吧帖（无分页，所以它是降级源而不是主力）；
//   · 结果区在页面**约 166000 字符之后**才开始（前面全是大段内联 CSS/JS），抓取上限给小了
//     （例如 60k）只会拿到空壳并误判「0 条」——见 `SEARCH_FETCH_MAX_CHARS`。
//
// 三条约束：
//   · 搜索与贴吧抓取走同一条 safeFetch 链路（能过反爬的请求头 + 内网地址防护），不自己拼 fetch；
//   · 搜索**不**经过贴吧节流器：节流是为了护住被限流的百度 IP，搜索引擎不该被贴吧的冷却连坐；
//   · 解析失败返回空数组、格式化一定有长度上界——降级路径自己不能变成新的故障点。

const SEARCH_ENDPOINT = 'https://www.so.com/s';
/**
 * 搜索结果正文最多读多少字符。
 *
 * ⚠️ 360 把结果区放在**约 166000 字符**之后（前面是大段内联 CSS/JS），所以这里必须给到 300000：
 * 给 512000 是浪费，给 60000 会只看到空壳并误判成「0 条搜索结果」（2026-10-08 实测踩过）。
 */
const SEARCH_FETCH_MAX_CHARS = 300000;
/** 一次降级最多带几条结果。360 的 `site:` 查询每次只给 5~7 条（无分页），所以 8 已经足够全收。 */
export const SEARCH_RESULTS_MAX = 8;
/** 单条摘要的截断长度。 */
export const SEARCH_SNIPPET_MAX = 160;
/** 格式化后的搜索文本长度上界（硬保证，含表头与尾注）。 */
export const SEARCH_TEXT_MAX = 1600;

/**
 * 360 搜索 URL。
 * `q` 交给 `URLSearchParams` 编码（`:` → `%3A`、空格 → `+`），所以调用方可以直接传
 * `site:tieba.baidu.com <关键词>` 这种带冒号与空格的查询串，不必自己转义。
 */
export function buildTiebaSearchUrl(query) {
  const clean = String(query ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set('q', clean);
  return url.toString();
}

/**
 * 剥标签 + 还原常见实体 + 压空白；搜索结果里的标题/摘要/链接都用它清洗。
 *
 * 比 `htmlToText` 多认几类实体：搜索结果摘要里高频出现 `&nbsp;`/`&ensp;`（制表空隙）和 `&#0183;`
 * 这类数字实体，不还原就会把「2025年9月5日&ensp;&#0183;&ensp;摘要…」这种噪声塞进模型上下文
 * （最早是 2026-10-08 用真实 Bing 页面跑出来的，360 的 `<span class="g-c-dark">66条回帖&nbsp;&nbsp;…`
 * 同一类问题，所以清洗逻辑照旧）。
 */
function decodeEntities(s) {
  const codePoint = (n, fallback) => {
    // 代理区码点不能单独 fromCodePoint，坏数字也照原样留着，别把解析小问题变成抛异常。
    if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return fallback;
    try { return String.fromCodePoint(n); } catch { return fallback; }
  };
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&ensp;|&emsp;|&thinsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&middot;/g, '·')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rsquo;/g, '’')
    .replace(/&#(\d+);/g, (m, d) => codePoint(Number(d), m))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (m, h) => codePoint(parseInt(h, 16), m))
    // `&amp;` 必须最后还原，否则 `&amp;lt;` 会被解成 `<`。
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `<li …>` 开标签的类名里是否**正好**有 `res-list` 这个 token。
 *
 * 用 token 相等而不是 `\bres-list\b` 子串：`res-list-summary`（摘要 span）也含 `res-list`，
 * 子串匹配会把它当成结果块边界。引号单双都认（页面里两种都出现过）。
 */
function isResListTag(tag) {
  const m = String(tag ?? '').match(/\bclass=(?:"([^"]*)"|'([^']*)')/i);
  if (!m) return false;
  const cls = m[1] ?? m[2] ?? '';
  return cls.split(/\s+/).includes('res-list');
}

/** 是不是 so.com 自己的跳转壳（`https://www.so.com/link?m=…`）——这种 URL 绝不能当结果链接。 */
function isSearchShellUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'so.com' || host.endsWith('.so.com');
  } catch {
    return true;
  }
}

/**
 * 从 360 搜索结果页 HTML 里提取 `[{ title, url, snippet }]`。
 *
 * 用正则而不是 DOM：这里只需要「标题 + 链接 + 摘要」三样，且必须容忍结构变化——
 * 认不出就返回空数组，**绝不当成解析失败抛异常**（降级路径自己崩掉比没有降级更糟）。
 *
 * 三个关键点（都是 2026-10-08 拿真实页面校准出来的）：
 *   · 唯一边界是 `<li class="res-list">`。页面里还混着广告块与相关推荐，它们带 `g-linkinfo-a`
 *     但没有 `res-list`，所以**按这个标记切块就天然把广告排除在外**（不能按 g-linkinfo-a 计数）；
 *   · 真实 URL 只在 `data-mdurl`（`data-cache` 同值）里；`href` 是 `https://www.so.com/link?m=…`
 *     跳转壳，把它当结果 URL 就是把用户送去 so.com——所以取不到 `data-mdurl` 的条目直接丢掉；
 *   · 条目结构有两副面孔：`<p class="res-desc">…</p>` 与
 *     `<div class="res-rich so-rich-bbs"><span class="res-list-summary">…</span>`，
 *     还有的条目只有 `<span class="g-c-dark">66条回帖&nbsp;&nbsp;2025年3月23日</span>` 甚至**没有摘要**。
 *
 * 还有一个边界坑：条目只有**开**标签边界（`</li>` 不能用），所以块尾会拖进下一段内容。因此摘要只在
 * 「标题 `<a>` 之后、下一个 `res-title` 之前」这段自身区域里找，URL 优先取标题 `<a>` 自己属性里的
 * `data-mdurl`——否则会把块里夹着的广告/下一个容器的摘要与链接算到当前条目头上。
 */
export function parseSo360Results(html, { limit = SEARCH_RESULTS_MAX } = {}) {
  const out = [];
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : SEARCH_RESULTS_MAX;
  try {
    const text = String(html ?? '');
    if (!text) return out;
    // 结果块以 `<li class="res-list">` 开头（类名后可能还有别的 token / 尾随空格，`<h3>` 前也可能换行）。
    // `<li>` 的开标签写法（属性顺序、引号）会变，所以逐个开标签看类名 token，而不是按固定字符串切。
    const tagRe = /<li\b[^>]*>/gi;
    const blocks = [];
    let m;
    let prev = null;
    while ((m = tagRe.exec(text)) !== null) {
      if (!isResListTag(m[0])) continue;
      if (prev !== null) blocks.push(text.slice(prev, m.index));
      prev = m.index + m[0].length;
    }
    if (prev !== null) blocks.push(text.slice(prev));

    for (const block of blocks) {
      if (out.length >= max) break;
      // `<h3   class="res-title">` / `<h3 class="res-title " >` 都见过，`<a>` 前可能换行，
      // 所以匹配到 `class=["']res-title` 后允许一段任意内容再取 `<a …>标题</a>`，并顺手拿到该 `<a>` 的属性串。
      const anchor = block.match(/<h3\b[^>]*class=["']res-title[\s\S]{0,600}?<a\b([^>]*)>([\s\S]*?)<\/a>/i);
      const attrs = anchor ? anchor[1] : '';
      // 真链优先从**标题那个 `<a>` 自己**的属性里取（data-mdurl，其次实测同值的 data-cache）；
      // 拿不到才退一步在块内找第一个——但**永远不用 href 兜底**：href 是 `https://www.so.com/link?m=…`
      // 跳转壳，把它当结果 URL 就是把用户送去 so.com。
      const rawUrl =
        (attrs.match(/\bdata-mdurl="([^"]+)"/i) ?? [])[1] ??
        (attrs.match(/\bdata-cache="([^"]+)"/i) ?? [])[1] ??
        (block.match(/\bdata-mdurl="([^"]+)"/i) ?? [])[1] ??
        (block.match(/\bdata-cache="([^"]+)"/i) ?? [])[1] ??
        '';
      const url = decodeEntities(rawUrl);
      if (!/^https?:\/\//i.test(url) || isSearchShellUrl(url) || out.some((r) => r.url === url)) continue;
      const title = cut(decodeEntities(anchor ? anchor[2] : ''), TITLE_MAX);
      // 摘要只在**条目自己的区域**里找：区域从标题 `<a>` 结束处到「下一个 res-title 标题」之前。
      // 条目只有开标签边界（`</li>` 不能用），块尾会拖进后面夹着的广告/下一个容器，不设这条界
      // 就会把别人家的摘要当成自己的（2026-10-08 那个「类名含 res-list 子串」的夹具陷阱就是这么抓出来的）。
      const anchorEnd = anchor ? anchor.index + anchor[0].length : 0;
      const nextTitle = anchor ? block.slice(anchorEnd).search(/<h3\b[^>]*class=["']res-title/i) : -1;
      const regionEnd = nextTitle >= 0 ? anchorEnd + nextTitle : block.length;
      const inOwnRegion = (re) => {
        const mm = block.match(re);
        return mm && mm.index < regionEnd ? mm : null;
      };
      // 区域里按信息量排优先级：正文摘要（res-list-summary）> 摘要段落（res-desc）> 回帖数/日期（g-c-dark）。
      const body =
        inOwnRegion(/<span\b[^>]*class=["'][^"']*res-list-summary[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) ??
        inOwnRegion(/<p\b[^>]*class=["'][^"']*res-desc[^"']*["'][^>]*>([\s\S]*?)<\/p>/i) ??
        inOwnRegion(/<span\b[^>]*class=["'][^"']*g-c-dark[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
      const snippet = cut(decodeEntities(body ? body[1] : ''), SEARCH_SNIPPET_MAX);
      // 有的条目就是没有摘要（360 的卡片式结果只给标题）：**标题在就算有效结果**，不算失败。
      // 只有标题和摘要全空、只剩个链接时，才当广告位或结构变化丢掉。
      if (!title && !snippet) continue;
      out.push({ title, url, snippet });
    }
  } catch {
    // 正则回溯超限之类的问题不该把「被拦」升级成「工具崩了」：安静地当作 0 条结果。
    return [];
  }
  return out;
}

/**
 * 把搜索结果压成给模型看的精简文本：一行一条（标题 + 链接 + 摘要），长度有硬上界。
 * 空结果/空输入返回表头加一句说明，不抛。
 */
export function formatSearchResults(query, results, { maxChars = SEARCH_TEXT_MAX } = {}) {
  const bound = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : SEARCH_TEXT_MAX;
  const head = `（搜索词：${cut(String(query ?? '').replace(/\s+/g, ' ').trim(), 120)}）`;
  const list = (Array.isArray(results) ? results : []).filter((r) => r && typeof r === 'object' && r.url);
  if (!list.length) return `${head}\n（没有可用的网页搜索结果）`;
  const lines = [head];
  let budget = bound - head.length - 1;
  let shown = 0;
  for (const r of list) {
    const line = `- ${cut(r.title || '(无标题)', TITLE_MAX)} | ${r.url}${r.snippet ? ` | ${cut(r.snippet, SEARCH_SNIPPET_MAX)}` : ''}`;
    if (line.length + 1 > budget) break;
    lines.push(line);
    budget -= line.length + 1;
    shown += 1;
  }
  if (!shown) {
    // maxChars 小到连一条都放不下时，至少要把第一条的链接露出来——链接本身就是这次降级的产物。
    lines.push(cut(`- ${list[0].title || '(无标题)'} | ${list[0].url}`, Math.max(0, bound - head.length - 1)));
  } else if (shown < list.length) {
    lines.push(`（已按长度上限截断，共 ${list.length} 条，这里给了 ${shown} 条）`);
  }
  const joined = lines.join('\n');
  // 硬保证：无论上面的账怎么算，返回文本不超过 maxChars。
  return joined.length <= bound ? joined : joined.slice(0, bound);
}

/** 去标签、反转义、压空白，得到可读纯文本。 */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * 检测「百度安全验证」页（被反爬拦下的标志）。
 *
 * 实测（2026-10-07 晚）：本机连续十几次探测之后，连先前成功的移动版吧页也开始返回这页——
 * 也就是说**限流是按 IP 起作用的**，而这不是解析能解决的问题。工具必须把它当**可识别状态**
 * 报给模型（"被百度拦了，等一会儿再试或改用网页搜索"），而不是当成"这个吧没有帖子"。
 */
export function isSecurityChallenge(html) {
  const text = String(html ?? '');
  return /百度安全验证|BIOC_OPTIONS|seccaptcha|安全验证/.test(text);
}

function cut(text, max) {  const chars = Array.from(String(text ?? ''));
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, max).join('')}…`;
}

function pick(html, re) {
  const m = String(html ?? '').match(re);
  return m ? htmlToText(m[1]) : '';
}

/** 从 `<title>` 里取页面标题（`原神吧_百度贴吧` → `原神吧`）。 */
export function parsePageTitle(html) {
  const title = pick(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  return title.replace(/[_\-—]\s*百度贴吧.*$/, '').trim();
}

/**
 * 解析移动版吧页。
 * 返回 `{ bar, followText, threadCountText, threads: [{ tid, title, author, time, replies }] }`。
 * 结构识别不了时返回空数组而不报错——页面改版不该让工具崩掉，只该让它「读到 0 条」。
 */
export function parseBarPage(html, { maxThreads = MAX_THREADS } = {}) {
  const bar = parsePageTitle(html);
  // 关注 / 帖子数：「关注」标签后面紧跟的那个 info_value。
  const followText = pick(html, /关注[\s\S]{0,80}?info_value[^>]*>([\s\S]*?)<\/span>/i);
  const threadCountText = pick(html, /贴子[\s\S]{0,80}?info_value[^>]*>([\s\S]*?)<\/span>/i);
  const threads = [];
  const chunks = String(html ?? '').split(/<li[^>]*class="[^"]*tl_(?:shadow|top)/i).slice(1);
  for (const chunk of chunks) {
    if (threads.length >= maxThreads) break;
    const tid = (chunk.match(/data-tid="(\d+)"/) ?? [])[1] ?? '';
    if (!tid) continue;
    // 置顶帖标题前有 `<span class="ti_title_icon">置顶</span>`，必须先剥掉，否则会把「置顶」当标题。
    const titleChunk = chunk.replace(/<span[^>]*class="[^"]*ti_title_icon[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '');
    const title = cut(
      pick(titleChunk, /class="ti_title"[\s\S]{0,400}?<span>([\s\S]*?)<\/span>\s*<\/div>/i)
        || pick(titleChunk, /class="ti_title"[^>]*>([\s\S]*?)<\/div>/i),
      TITLE_MAX
    );
    const author = cut(pick(chunk, /class="ti_author"[^>]*>([\s\S]*?)<\/(?:span|div)>/i).replace(/<[^>]*>/g, ''), 40);
    const time = cut(pick(chunk, /class="ti_time"[^>]*>([\s\S]*?)<\/span>/i), 20);
    const replies = Number((chunk.match(/class="btn_icon"[^>]*>(\d+)/) ?? [])[1] ?? NaN);
    threads.push({
      tid,
      title,
      author: author.replace(/^<[^>]*>/, '').trim(),
      time,
      replies: Number.isFinite(replies) ? replies : 0
    });
  }
  return { bar, followText, threadCountText, threads, blocked: isSecurityChallenge(html) };
}

// ── 帖子页解析（已用真实页面校准，2026-10-08）─────────────────────────────
//
// 校准用的真实页（公开帖子，只记结构不记内容）：`https://tieba.baidu.com/mo/q/m?kz=<tid>&lp=5028`，
// 实测 HTTP 200 / 184666 字节 / 28 层楼。楼层列表是**服务端渲染的 HTML class**，不在内嵌 JSON 里
// （内嵌 JSON 只提供元信息）。关键标记逐项如下：
//
//   · 楼层容器：`<li tid="<pid>" data-tid="<pid>" fn="<楼层号>" data-info="{&quot;…&quot;}"
//       class="list_item post_list_item … j_post_list_item …"is_inner_floor=''>`
//     —— `fn` 就是楼层号，而且真实页里**不连续**（1..17、19、21..24、26..31；缺的是被删或广告位），
//     所以楼层号必须取 `fn`，绝不能用「下标 + 1」；注意 `class="…"is_inner_floor=''` 之间**没有空格**；
//   · 楼层元信息：`data-info` 是 HTML 转义过的 JSON（`un` 账号名、`name_show` 昵称、`pid`、`floor_num`）；
//   · 作者：`<span class="user_name"><a href="javascript:;" class="user_name">昵称<img class="nicknameEmoji"…/></a></span>`
//     —— 昵称尾巴上挂着表情 `<img>`，不剥掉就会混进作者名；兜底取 `data-info.name_show` → `un`；
//   · 时间：`<span class="list_item_time">2026-1-2</span>` —— **月/日不补零**，不能按 `\d{2}` 卡；
//   · 正文：`<div class="content"                 lz="1">…</div>`（`lz="1"` = 这层是楼主）；
//     正文里允许嵌套 `<div>`（图片占位），所以取配对的 `</div>` 要按深度扫，不能非贪婪切第一个；
//   · 楼中楼：在同一个 `<li>` 里、正文**之后**——
//     `<div class="fr_list N j_floor_panel" data-list-count="4"><ul class="flist"><li … class="list_item_floor j_list_item_floor">…<span class="floor_content">`；
//     楼中楼正文类名是 `floor_content`：**按 class token 精确相等**取正文才不会把楼中楼当楼层，
//     作者/时间也只在「正文 `<div>` 之前」这段里找（楼中楼在正文之后，天然被排除）；
//   · 标题：首页 `<title>` 是**空的**（页面自己的 JS conf 里 `'title': ""`、`og:title` 也空），
//     第二页的 `<title>` 才有 `第2/4页,回贴列表-<标题>` —— 所以标题「有就取、没有就留空」，绝不编；
//   · 内嵌 JSON 只给元信息：TopBar `conf:{pn:0, forum_name:"…", kz:"<tid>", is_login:1}`、
//     分页 `page:{req_num:30,page_size:30,current_page:1,total_page:4,total_num:120}`、
//     `threadInfo:{"id":<tid>,"reply_num":116,…}`。
//
// 多形态容忍：认不出上面的标记就退回 PC 形态（`div.l_post` + `d_post_content`）再试一次；
// 两种都不认就返回 `posts: []` + `unparsed: true`，**永不抛**（页面改版不该让工具崩掉）。

/** 取一个开标签上的 class token 列表（单双引号都认；找不到类名返回空数组）。 */
function classTokens(openTag) {
  const m = String(openTag ?? '').match(/\bclass=(?:"([^"]*)"|'([^']*)')/i);
  if (!m) return [];
  return (m[1] ?? m[2] ?? '').trim().split(/\s+/).filter(Boolean);
}

/**
 * 从 `from`（某个 `<div …>` 开标签**之后**的位置）起，按嵌套深度取到与它配对的 `</div>`。
 *
 * 真实页正文里有一层嵌套 `<div>`（图片占位），所以不能用非贪婪切第一个 `</div>`；但页面也可能被
 * 抓取上限截断，所以扫不到配对时退回「第一个 `</div>`」，再不行取到扫描上界——任何情况都返回字符串。
 */
function readDivBody(text, from, maxScan = 20000) {
  const limit = Math.min(text.length, from + maxScan);
  const re = /<\/?div\b[^>]*>/gi;
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(text)) !== null && m.index < limit) {
    if (m[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) return text.slice(from, m.index);
    } else {
      depth += 1;
    }
  }
  const seg = text.slice(from, limit);
  const naive = seg.search(/<\/div>/i);
  return naive >= 0 ? seg.slice(0, naive) : seg;
}

/**
 * 楼层 `data-info`（HTML 转义过的 JSON）→ 对象；坏 JSON / 缺字段一律当空对象，绝不抛。
 */
function floorDataInfo(openTag) {
  const m = String(openTag ?? '').match(/\bdata-info=(?:"([^"]*)"|'([^']*)')/i);
  const raw = m ? m[1] ?? m[2] ?? '' : '';
  if (!raw) return {};
  try {
    const parsed = JSON.parse(decodeEntities(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 楼层作者：优先页面上渲染出来的昵称（剥掉尾巴上的表情 `<img>`），兜底 `data-info` 的 `name_show` → `un`。 */
function floorAuthor(head, info) {
  const re = /<span\b[^>]*>/gi;
  let m;
  while ((m = re.exec(head)) !== null) {
    if (!classTokens(m[0]).includes('user_name')) continue;
    const close = head.indexOf('</span>', m.index + m[0].length);
    const name = close >= 0 ? htmlToText(head.slice(m.index + m[0].length, close)) : '';
    if (name) return name;
    break;
  }
  return htmlToText(String(info?.name_show ?? info?.un ?? ''));
}

/** 楼层时间：`<span class="list_item_time">2026-1-2</span>`（月/日不补零，所以不按位数卡）。 */
function floorTime(head) {
  const re = /<span\b[^>]*>/gi;
  let m;
  while ((m = re.exec(head)) !== null) {
    if (!classTokens(m[0]).includes('list_item_time')) continue;
    const close = head.indexOf('</span>', m.index + m[0].length);
    if (close < 0) break;
    const text = htmlToText(head.slice(m.index + m[0].length, close));
    if (text) return text;
  }
  return (head.match(/\d{4}-\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{2})?/) ?? [])[0] ?? '';
}

/**
 * 移动版楼层（真实形态）：认出所有 `<li …fn="n"… class="…post_list_item…">` 容器，
 * 每个容器到下一个容器之间就是这一层的块，在块内取正文 / 作者 / 时间。
 * **只有带 `content` 正文容器的 `<li>` 才算一层**：被截断或结构变化的残块不该被算成楼层。
 */
function parseMobileFloors(html, maxPosts) {
  const opens = [];
  const re = /<li\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    if (!classTokens(tag).includes('post_list_item')) continue;
    const info = floorDataInfo(tag);
    const floor = Number((tag.match(/\bfn="(\d+)"/i) ?? [])[1] ?? info?.floor_num ?? NaN);
    if (!Number.isFinite(floor)) continue;
    opens.push({ start: m.index, end: m.index + tag.length, floor, info });
  }

  const posts = [];
  for (let i = 0; i < opens.length && posts.length < maxPosts; i += 1) {
    const open = opens[i];
    const blockEnd = i + 1 < opens.length ? opens[i + 1].start : Math.min(html.length, open.end + 40000);
    const block = html.slice(open.end, blockEnd);
    // 正文：块内第一个 class token 里正好有 `content` 的 `<div>`。类名相等而不是子串，`floor_content`
    // （楼中楼）因此不会顶替楼层正文——真实页里两种类名就在同一个 `<li>` 内相邻出现。
    const tagRe = /<div\b[^>]*>/gi;
    let contentOpen = null;
    let cm;
    while ((cm = tagRe.exec(block)) !== null) {
      if (classTokens(cm[0]).includes('content')) {
        contentOpen = cm;
        break;
      }
    }
    if (!contentOpen) continue;
    const bodyStart = contentOpen.index + contentOpen[0].length;
    // 作者 / 时间只在正文之前那段里找：楼中楼的作者与正文都在正文之后，天然排除。
    const head = block.slice(0, contentOpen.index);
    posts.push({
      floor: open.floor,
      author: cut(floorAuthor(head, open.info), 40),
      time: cut(floorTime(head), 24),
      content: cut(htmlToText(readDivBody(block, bodyStart)), CONTENT_MAX),
      isOp: /lz="1"/i.test(contentOpen[0])
    });
  }
  return posts;
}

/**
 * PC 形态兜底（`div.l_post` + `p_author_name` + `d_post_content`）。
 * 真实 PC 页在本机实测只回 7091 字节空壳（`<title>贴吧小程序</title>`），留着它是为了页面改版时还有人认。
 */
function parsePcFloors(html, maxPosts) {
  const posts = [];
  const marker = /<div[^>]*class="[^"]*d_post_content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = marker.exec(html)) !== null && posts.length < maxPosts) {
    const before = String(html).slice(Math.max(0, m.index - 1200), m.index);
    // 取**最后**一个 data-field：短正文时前面 1200 字符里会夹着上一层的 data-field。
    const fields = [...before.matchAll(/data-field=(?:"([^"]*)"|'([^']*)')/g)];
    const last = fields.length ? fields[fields.length - 1][1] ?? fields[fields.length - 1][2] ?? '' : '';
    const floor = Number((last.match(/"floor"\s*:\s*(\d+)/) ?? [])[1] ?? NaN);
    posts.push({
      floor: Number.isFinite(floor) ? floor : posts.length + 1,
      author: cut(htmlToText((before.match(/class="p_author_name[^>]*>([\s\S]*?)<\/(?:a|div)>/i) ?? [])[1] ?? ''), 40),
      time: cut((before.match(/class="p_tail[^"]*"[^>]*>[\s\S]{0,200}?(\d{4}-\d{2}-\d{2}[^<]*)</i) ?? [])[1] ?? '', 24),
      content: cut(htmlToText(m[1]), CONTENT_MAX),
      isOp: false
    });
  }
  return posts;
}

/** 真实页第二页的 `<title>` 是「第2/4页,回贴列表-<标题>」；首页 `<title>` 是空的。 */
function cleanThreadTitle(raw) {
  return String(raw ?? '')
    .replace(/^第\s*\d+\s*\/\s*\d+\s*页\s*[,，]\s*回贴列表\s*[-—]\s*/, '')
    .replace(/[_\-—]\s*百度贴吧.*$/, '')
    .trim();
}

/** 全部是「有就取、没有就给 0」——不编内容。 */
function parseThreadMeta(text) {
  const tid =
    (text.match(/\bkz['"]?\s*[:=]\s*['"]?(\d{4,})/i) ?? [])[1] ??
    (text.match(/\/p\/(\d+)/) ?? [])[1] ??
    (text.match(/mo\/q\/m\?kz=(\d+)/) ?? [])[1] ?? '';
  const title = cut(cleanThreadTitle(pick(text, /<title[^>]*>([\s\S]*?)<\/title>/i)), TITLE_MAX);
  const forumName = cut(
    pick(text, /class="post_title_text"[^>]*>([\s\S]*?)<\/a>/i) || pick(text, /forum_name\s*:\s*"([^"]*)"/i),
    40
  );
  const num = (re) => {
    const n = Number((text.match(re) ?? [])[1] ?? NaN);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    tid,
    title,
    forumName,
    replyNum: num(/"reply_num"\s*:\s*(\d+)/),
    // 分页来自 JS 字符串里的 `\"total_page\":4`，所以引号前可能带一个反斜杠。
    totalPages: num(/total_page\\?["']?\s*:\s*\\?["']?(\d+)/),
    totalPosts: num(/total_num\\?["']?\s*:\s*\\?["']?(\d+)/)
  };
}

/**
 * 解析帖子页。
 *
 * 返回 `{ tid, title, forumName, replyNum, totalPages, totalPosts, posts, unparsed, blocked }`，
 * `posts` 每项是 `{ floor, author, time, content, isOp }`。
 *
 * 已用真实页面校准（2026-10-08）：主形态是移动版 `/mo/q/m?kz=<tid>&lp=5028` 的
 * `li[fn].post_list_item` + `div.content`（见上面的标记清单），PC 形态（`d_post_content`）作为兜底。
 * 认不出就返回空数组 + `unparsed: true`，**永不抛**——由调用方决定是降级到网页搜索还是告诉用户。
 */
export function parseThreadPage(html, { maxPosts = MAX_POSTS } = {}) {
  const text = String(html ?? '');
  const bound = Number.isFinite(maxPosts) && maxPosts > 0 ? Math.floor(maxPosts) : MAX_POSTS;
  let data = { tid: '', title: '', forumName: '', replyNum: 0, totalPages: 0, totalPosts: 0, posts: [] };
  try {
    const meta = parseThreadMeta(text);
    let posts = parseMobileFloors(text, bound);
    if (!posts.length) posts = parsePcFloors(text, bound);
    data = { ...meta, posts };
  } catch {
    // 正则回溯超限之类的意外不该把「页面变了」升级成「工具崩了」：安静地当作没解析出来。
    data = { tid: '', title: '', forumName: '', replyNum: 0, totalPages: 0, totalPosts: 0, posts: [] };
  }
  return { ...data, unparsed: data.posts.length === 0, blocked: isSecurityChallenge(text) };
}

// ── 楼层图片 URL 提取（t78 切片）──────────────────────────────────────────
//
// 分工：**桥接侧只提取 URL**（`images: [...]`），下载与「变成图像内容」在 MCP 侧
// （`src/mcp-snowluma-safe.js`，那里已有 `qq_get_message_images` 的现成范式）。
// 这样桥接进程不会因为一张图被拖住，也不会把图片字节塞进 JSON。
//
// **真实页面的图片形态（2026-10-08 用本机保存的真实移动版帖子页校准，只记结构不记内容）**：
//   · 楼层照片**不在 `<img>` 里**，而在正文里的占位容器上：
//     `<div class="content" lz="0"><span class="wrap pbimgwapper"><div style='height:30px;'
//      data-class="BDE_Image" class='j_media_thumb_holder img_placeholder'
//      data-url='/forum/w%3D250%3Bq%3D100%3Bg%3D0/sign=<md5>/<hash>.jpg?tbpicau=…&src=<未签名原图地址>'>
//      </div></span>…</div>`；
//     **真图就在这个 `data-url` 自己身上**（带签名的缩略图，实测 13 张各不相同的 JPEG，4056~469751 字节）；
//     它的 `src` 参数反而是**取不到真图的未签名原图路径**（13 个不同 hash 回的是同一张 4262 字节
//     「贴」占位图标）——上一轮把两者搞反了，正是「拉回来 10 张全是同一个占位图标」的根因，
//     见 `isSignedTiebaCdnUrl` / `isPlaceholderImageUrl`；
//   · 正文里**确实还有 `<img>`**，但那些是**站内表情**（`/tb/editor/images/client/image_emoticonNN.png`）
//     与昵称表情（它们经 `…/timg?…&src=…` 图片代理渲染，真图在 `src` 里），不是楼层照片；
//     整个 `/tb/…` 目录都是贴吧自己的静态资源，必须排除，否则「一张图都没吃到」会变成「吃到的全是表情」
//     （实测这一页 4 个候选里 3 个是表情）；
//   · 页面上还有 28 张 `<img class="user_img" alt="头像">`（头像）——它们在 `div.content` **之外**，
//     只扫正文容器天然就不会收进来。
//
// 三条边界：
//   · **只扫楼层正文容器**（class token 含 `content` / PC 形态的 `d_post_content`）：头像、昵称表情、
//     页面图标都不在这个范围里，所以不会把「谁的脑袋」当成楼层插图；
//   · **只收贴吧自家图床**（*.baidu.com / *.bdstatic.com / *.bdimg.com / *.bcebos.com）且排除 `/tb/`
//     静态资源目录：页面被篡改或结构变化时，也不会把一个任意外站 URL 交给下游去抓；
//   · 认不出就返回空数组、**永不抛**；去重、协议相对地址补 `https:`、`http:` 一律升到 `https:`；
//     占位形态的地址（URL 特征）**不交出去**，但**如实计数**（见 `extractImageUrls`）。

/** 贴吧图床白名单后缀：只有这些域名下的图片才允许被提取（详见上面那段注释）。 */
const TIEBA_IMAGE_HOST_SUFFIXES = ['baidu.com', 'bdstatic.com', 'bdimg.com', 'bcebos.com'];

/** 主机名是不是贴吧自家图床（后缀匹配，子域也算）。 */
export function isTiebaImageHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  return TIEBA_IMAGE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * 贴吧自家的**静态资源目录** `/tb/…`（站内表情、昵称表情、等级图标…）：不是楼层照片。
 * 只看 URL 第一段路径——`/<bucket>/tb/…`（代理地址的桶名前缀）**不算**，那可能是用户真贴的大表情图。
 */
function isTiebaStaticAssetUrl(raw) {
  const text = String(raw ?? '').trim().replace(/&amp;/g, '&');
  if (!text) return false;
  let parsed;
  try {
    parsed = new URL(text.startsWith('//') ? `https:${text}` : text);
  } catch {
    return false;
  }
  if (!isTiebaImageHost(parsed.hostname)) return false;
  return (parsed.pathname.split('/').filter(Boolean)[0] ?? '').toLowerCase() === 'tb';
}

/**
 * 把候选地址规范化成一个「可取的图床地址」：`//host/x.png` → `https://host/x.png`，`&amp;` 还原，
 * 非 http(s) / 非图床 / `/tb/` 静态资源 / 坏 URL 一律返回空串（调用方据此丢弃）。**永不抛**。
 */
function acceptImageUrl(raw) {
  const text = String(raw ?? '').trim().replace(/&amp;/g, '&');
  if (!text || /^data:/i.test(text) || /^javascript:/i.test(text)) return '';
  const withScheme = text.startsWith('//') ? `https:${text}` : text;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  if (!isTiebaImageHost(parsed.hostname)) return '';
  // `/tb/…` 是贴吧自己的静态资源目录（站内表情、等级图标、昵称表情都在里面）：正文里那种
  // `<img src="//tb2.bdstatic.com/tb/editor/images/client/image_emoticonNN.png">` 是**文字里的表情**，
  // 不是楼层照片，必须排除（首段就是 `tb`）。
  //
  // 边界（有意为之，实测踩到过）：**代理地址的桶名前缀**会让 `/tb/` 出现在第二段
  // （`/<bucket>/tb/editor/images/client/…`），上面这条首段判断就拦不住它。这种地址只可能来自
  // 楼层正文里的 `data-class="BDE_Image"` 占位容器（也就是「这层贴了一张图」的槽位），所以**保留**：
  // 一张「大表情图」也是用户真的贴出来的图，而按路径一刀切反而会让「这层明明有图」变成 0 张。
  if (isTiebaStaticAssetUrl(withScheme)) return '';
  // 贴吧图床都支持 https：明文图片没必要，统一升到 https。
  if (parsed.protocol === 'http:') parsed.protocol = 'https:';
  return parsed.toString();
}

/**
 * 这个地址是不是 CDN 的**签名**地址（路径里有签名段 `…/sign=<md5>/<文件>`）。
 *
 * 为什么需要这条判定（2026-10-08 实测，本机真实移动版帖子页 + 逐张真下载，13 个楼层图）：
 *   · 楼层照片的 `data-url` 就是这个形态：
 *     `/forum/w%3D250%3Bq%3D100%3Bg%3D0/sign=<md5>/<hash>.jpg?tbpicau=…&src=…`；
 *   · 它**本身就能取到真图**：13 个不同 hash 分别回 469751 / 88216 / 68128 / 6238 / 4056 … 字节的
 *     真实 JPEG，字节各不相同（还带 HTTP 200 + `image/jpeg`）；
 *   · 它的 `src` 参数指向的是**未签名的原图路径**（`/<bucket>/forum/pic/item/<hash>.jpg`），
 *     匿名取回的是**同一张 238×238「贴」占位图标**：13 个不同 hash 的字节**完全相同**
 *     （4262 字节 JPEG，sha1 一致）——这正是「拉回来 10 张全是同一个占位图标」的根因。
 * 所以：**签名地址优先用它自己**，`src` 只当退路（`gss3…/timg` 这类图片代理的真是 `src` 里的地址）。
 */
function isSignedTiebaCdnUrl(parsed) {
  return /\/sign=[0-9a-f]{6,}\//i.test(String(parsed?.pathname ?? ''));
}

/**
 * 未签名的**原图路径**（`…/forum/pic/item/<文件>`）。
 * CDN 对这类匿名请求一律回同一张「贴」占位图标（实测依据见 `isSignedTiebaCdnUrl`），所以它是
 * 「服务端占位形态」而不是一个能取到图的地址。**只按 URL 特征判定，不发请求**（桥接侧不下载）。
 */
const PLACEHOLDER_IMAGE_PATH_RE = /\/forum\/pic\/item\//i;

/**
 * 这个地址是不是**服务端占位形态**（URL 特征）：图床白名单里、路径是未签名原图路径、且**不带签名段**。
 * 带签名段的地址不算占位（签名地址实测能取到真图）；`src` 参数里那个未签名地址才算。
 * 传入任何畸形值都返回 false，**永不抛**。
 */
export function isPlaceholderImageUrl(raw) {
  const text = String(raw ?? '').trim().replace(/&amp;/g, '&');
  if (!text) return false;
  let parsed;
  try {
    parsed = new URL(text.startsWith('//') ? `https:${text}` : text);
  } catch {
    return false;
  }
  if (!isTiebaImageHost(parsed.hostname)) return false;
  if (isSignedTiebaCdnUrl(parsed)) return false;
  return PLACEHOLDER_IMAGE_PATH_RE.test(parsed.pathname);
}

/**
 * 图片地址规范化：签名缩略图**用自己的地址**，其余图片代理用 `src` 里的真地址，最后按图床规范化。
 *
 * **实测（2026-10-08，本机真实移动版帖子页 + 逐张真下载验证）**：
 *   · `data-url` 是签名缩略图（`…/sign=<md5>/<hash>.jpg?tbpicau=…&src=…`）时——
 *     **地址本身可取到真图**（13 张各不相同的 JPEG，4056~469751 字节），而它的 `src`
 *     （未签名原图路径）取回的是同一张「贴」占位图标；
 *   · `data-url` 是 `gss3…/timg?image&…&src=…` 这类图片代理时——地址本身回的是
 *     百度「页面不存在」HTML（实测 19825 字节 `text/html`），真图在 `src` 里。
 * 所以：**签名地址优先取自己**；其余情况保持原行为（有 `src` 就优先 `src`，`src` 不合规才退回地址本身）——
 * 否则「图片 URL 提取成功」会变成「模型拿到一张占位图标或一个 404 地址」，等于什么都没吃到。
 */
function normalizeImageUrl(raw) {
  const text = String(raw ?? '').trim().replace(/&amp;/g, '&');
  if (!text || /^data:/i.test(text) || /^javascript:/i.test(text)) return '';
  const withScheme = text.startsWith('//') ? `https:${text}` : text;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return '';
  }
  const inner = parsed.searchParams.get('src');
  if (inner && isTiebaImageHost(parsed.hostname) && isSignedTiebaCdnUrl(parsed)) {
    const outer = acceptImageUrl(text);
    if (outer) return outer;
  }
  if (inner) {
    // `src` 指向**站内静态资源**（`/tb/…` 表情/昵称表情）时**整条丢掉**，不要退回外层代理地址：
    // 那外层（例如 `gss3…/timg?…`）是给表情做代理的，取回来是 HTML（实测 19825 字节 text/html），
    // 而它本来就不是楼层照片。只有 `src` 是**外站/坏串**时才退回外层（那种外层可能就是真图床地址）。
    if (isTiebaStaticAssetUrl(inner)) return '';
    const resolved = acceptImageUrl(inner);
    if (resolved) return resolved;
  }
  return acceptImageUrl(text);
}

/** 从一段 HTML 里挑出图片地址：`<img>` 的懒加载属性优先，其次非 `<img>` 的图片占位容器（真实形态）。 */
function imageUrlsInHtml(html) {
  const found = [];
  const push = (raw) => {
    const url = normalizeImageUrl(raw);
    if (url && !found.includes(url)) found.push(url);
  };
  const attr = (tag, name) => {
    const m = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
    return m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
  };
  const imgRe = /<img\b[^>]*>/gi;
  let m;
  while ((m = imgRe.exec(String(html))) !== null) {
    // 懒加载的真图在 data-original / data-src / data-url 里，`src` 常常是 1px 占位或小图。
    push(attr(m[0], 'data-original') || attr(m[0], 'data-src') || attr(m[0], 'data-url') || attr(m[0], 'src'));
  }
  // 真实移动版的楼层照片是**占位容器**（没有 `<img>` 标签，地址在容器自己的 data-* 上）。
  const holderRe = /<(?:div|span|a|p)\b[^>]*>/gi;
  while ((m = holderRe.exec(String(html))) !== null) {
    const tag = m[0];
    if (!/\bdata-(?:original|src|url)\s*=/i.test(tag)) continue;
    push(attr(tag, 'data-original') || attr(tag, 'data-src') || attr(tag, 'data-url'));
  }
  return found;
}

/**
 * 提取帖子页里**楼层正文**中的图片 URL。
 *
 * 返回 `{ urls, found, placeholders }`：
 *   · `urls` 是最多 `max` 个去重后的**可用**地址；
 *   · `found` 是实际认出多少个可用地址（`found > urls.length` 说明被这条上限截了，调用方要如实说明）；
 *   · `placeholders` 是认出多少个**服务端占位形态**的地址（URL 特征，见 `isPlaceholderImageUrl`）——
 *     这些**绝不交给下游**（它们取回的就是同一张「贴」占位图标），但必须**如实计数**，
 *     好让调用方在正文里写「只认出 N 个占位地址、没有真图」而不是假装这帖没有图。
 * 畸形输入/认不出：`{ urls: [], found: 0, placeholders: 0 }`，**永不抛**。
 */
export function extractImageUrls(html, { max = TIEBA_IMAGE_MAX_URLS } = {}) {
  const bound = Number.isFinite(max) && max > 0 ? Math.floor(max) : TIEBA_IMAGE_MAX_URLS;
  const all = [];
  let placeholders = 0;
  try {
    const text = String(html ?? '');
    if (!text) return { urls: [], found: 0, placeholders: 0 };
    const tagRe = /<div\b[^>]*>/gi;
    let m;
    while ((m = tagRe.exec(text)) !== null) {
      const tokens = classTokens(m[0]);
      if (!tokens.includes('content') && !tokens.includes('d_post_content')) continue;
      for (const url of imageUrlsInHtml(readDivBody(text, m.index + m[0].length))) {
        // 占位形态（URL 特征）直接丢弃并计数：交给下游等于给模型 10 张同一张「贴」图标。
        if (isPlaceholderImageUrl(url)) {
          placeholders += 1;
          continue;
        }
        if (!all.includes(url)) all.push(url);
      }
    }
  } catch {
    // 正则回溯超限之类的意外不该把「这帖有图」升级成「工具崩了」。
    return { urls: [], found: 0, placeholders: 0 };
  }
  return { urls: all.slice(0, bound), found: all.length, placeholders };
}

/**
 * 楼层图片的**如实说明**（追加进格式化正文，不额外占长度预算之外的空间）。
 *
 * 只有真的认出了占位地址才说话：全是占位就明说「没有可取的真图、本次不给图片」，混着就给一句
 * 「另有 N 个占位地址已丢弃」。**宁可 images 为空，也不要给 10 张占位图标**（用户实测的诉求）。
 */
function imageExtractNotes(extracted) {
  const placeholders = Number(extracted?.placeholders) || 0;
  const usable = Array.isArray(extracted?.urls) ? extracted.urls.length : 0;
  if (placeholders <= 0) return [];
  if (usable === 0) {
    return [`（楼层图片：只认出 ${placeholders} 个服务端占位地址（未签名的 /forum/pic/item/ 原图路径，实测不同地址取回的是同一张 238×238「贴」占位图标，真图在带签名的缩略图地址里），本次未取到真图，不给图片）`];
  }
  return [`（楼层图片：另有 ${placeholders} 个占位地址（取回的是同一张「贴」占位图标）已丢弃，这里只给其余 ${usable} 张真图地址）`];
}

/**
 * 楼层图片地址的**逐行清单**（写进返回文本，给模型看的）：`- 图1: <url>`。
 *
 * 为什么必须有这一段（2026-10-08）：图片是作为**图像内容**交给模型的，模型的上下文里
 * **没有可转手的 URL** —— 它想「把这张图发到 QQ」时手上没有任何地址可用（结构化字段 `images`
 * 只在桥接↔MCP 之间流动，模型看不到）。所以格式化文本里必须把地址原样列出来，配合
 * `qq_send_image(url=…)` 使用。
 *
 * 只列**可用地址**（占位/去重/下载失败的那些已经由 `imageExtractNotes` 如实交代过），
 * 空数组返回空数组；每条一行、**不截断 URL**（截断出来的地址是错的地址，比没有更糟）。
 * 认不出/畸形输入返回空数组，**永不抛**。
 */
function imageUrlNotes(urls) {
  const list = (Array.isArray(urls) ? urls : []).filter((u) => typeof u === 'string' && u);
  if (!list.length) return [];
  return [
    '（楼层图片地址，可直接用 qq_send_image(url=…) 发出）：',
    ...list.map((url, i) => `- 图${i + 1}: ${url}`)
  ];
}

// ── 图片 URL → MCP 图像内容（t78 切片）─────────────────────────────────────
//
// 这一段**由 MCP 侧调用**（`src/mcp-snowluma-safe.js` 的 qq_tieba_read），桥接端**不下载**任何图片：
//   · 桥接只把 `extractImageUrls` 的结果（URL 数组）放进 JSON；
//   · MCP 进程调用本函数：走 `safeFetchBuffer`（带 SSRF 防护、逐跳校验、图片格式校验）真下载，
//     再变成 `{ type:'image', mimeType, data(base64) }`——与 `qq_get_message_images` 完全同形。
// 放在这里而不是 MCP 文件里，是因为上限/UA/referer 这些**事实**只该有一份定义；MCP 那边只负责
// 按需加载、交付给模型。

/** 从图片字节判断 MIME（`safeFetchBuffer` 已校验过是 PNG/JPEG/GIF/WebP，这里只做归类）。 */
function imageMimeFromBuffer(buffer) {
  const b = buffer;
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/png';
}

/** 人话版的单张上限（用于失败标注里的「上限 N MiB」）。 */
function imageMiB(bytes) {
  return Math.max(1, Math.round(Number(bytes) / (1024 * 1024)));
}

/**
 * 把一次调用里下载到的图片按**字节内容**分组（同一组 = 字节完全相同）。
 *
 * 图片数量上限只有 10，所以 O(n²) 的逐对比对足够（先比长度再 `equals`，不同长度的绝大多数一轮就排除）。
 */
function groupByImageBytes(entries) {
  const groups = [];
  for (const entry of entries) {
    const hit = groups.find((g) => g.buffer.length === entry.buffer.length && g.buffer.equals(entry.buffer));
    if (hit) hit.items.push(entry);
    else groups.push({ buffer: entry.buffer, items: [entry] });
  }
  return groups;
}

/**
 * 把贴吧楼层图片 URL 变成给模型看的图像内容。返回 `{ content, notes }`：
 *   · `content`：`[{type:'image', mimeType, data}]`（base64，和 `qq_get_message_images` 同形）；
 *   · `notes`：逐张结论（`[图片1]` / `[图片2：获取失败：…]` / `[图片3：因体积超限未取（单张上限 4MiB）]`
 *     / `[图片4：与图片5字节完全相同，判定为同一张服务端占位图，已丢弃]`）
 *     加一条数量上限说明（`（另有 N 张图片因数量上限（一次最多 10 张）未取）`），
 *     以及一条总量上限说明（`（本次已取 M 张；另有 N 张图片因总量上限（一次最多 25MiB）未取）`）。
 *
 * **绝不返回占位图**（这一条是用户实测反馈的直接修复）：不同地址却取回**字节完全相同**的内容 ⇒
 * 那只能是服务端给的一张静态占位图/图标，不是用户贴的照片。判据与取舍：
 *   · 实测（2026-10-08）：13 个不同 hash 的未签名原图地址各自回 4262 字节、sha1 完全相同的
 *     238×238「贴」占位图标；同一页里**真图**的字节是 4056~469751 且各不相同。
 *   · 所以判据是「**不同 URL + 字节完全相同**」，**不是**「文件小于某个阈值」：同一页里有一张真图
 *     只有 4056 字节，比占位图（4262 字节）还小 ⇒ 单看体积阈值必然误杀。
 *   · 取舍：同一组**全部丢弃**（含第一张），并在 notes 里如实写明——用户明确要「宁可 images 为空，
 *     也不要给 10 张占位图」；代价是「同一张照片被上传两次（两个 URL、字节相同）」也会被当成占位图丢掉，
 *     这种情形远少于占位图泛滥，且失败方向是「如实说明没有图」而不是「骗模型说这是照片」。
 *   · 输入里同一个 URL 出现多次（上游已按 URL 去重，这里只做兜底）：只保留第一张，其余按重复标注。
 *
 * 四条上限都**如实标注**而不是静默丢：数量上限 `maxImages`、单张体积 `maxBytes`、
 * 合计体积 `maxTotalBytes`、以及逐张的失败原因。合计体积是**下载前**看累计已取字节：
 * 到顶就停止后续下载（最多只会比上限多出「已经取到的那一张」的量，单张另有 4MiB 上界）。
 * 非 http(s) 的条目直接忽略（不计入数量上限），**永不抛**。
 * `fetchBuffer` 可注入（离线测试用假下载器），默认 `safeFetchBuffer`。
 * 请求头只走 `safeFetchBuffer` 的「只允许追加」口子：贴吧图床要 `referer`（不带会 403），
 * UA 用移动版那条；`host` 仍由 URL 决定，跨源重定向会丢掉这些头。
 */
export async function buildTiebaImageContent(urls, {
  fetchBuffer = safeFetchBuffer,
  maxImages = TIEBA_IMAGE_MAX,
  maxBytes = TIEBA_IMAGE_BYTES_MAX,
  maxTotalBytes = TIEBA_IMAGE_TOTAL_BYTES_MAX,
  headers = { referer: 'https://tieba.baidu.com/', 'user-agent': TIEBA_MOBILE_UA }
} = {}) {
  const list = (Array.isArray(urls) ? urls : []).filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
  const totalBound = Number.isFinite(maxTotalBytes) && maxTotalBytes > 0
    ? Math.floor(maxTotalBytes)
    : TIEBA_IMAGE_TOTAL_BYTES_MAX;
  const take = list.slice(0, maxImages);
  // 每个槽位一个状态（`ok` 是下载成功，`note` 是失败/去重/占位，`skipped` 是到总量上限没下）。
  const slots = new Array(take.length).fill(null);
  const downloaded = [];
  let takenBytes = 0;
  let skippedByTotal = 0;
  for (let i = 0; i < take.length; i += 1) {
    // 合计体积上限：看的是**已经取到**的字节。到顶就停止下载后续图片（不再发请求），
    // 并把「已取几张、因总量跳过几张」写进 notes——静默少给几张正是这个功能要避免的事。
    if (takenBytes >= totalBound) {
      skippedByTotal = take.length - i;
      break;
    }
    try {
      const res = await fetchBuffer(take[i], maxBytes, { headers });
      const buffer = res?.buffer;
      if (!buffer || !buffer.length) throw new Error('图床返回空内容');
      slots[i] = { kind: 'ok', buffer };
      downloaded.push({ index: i, url: take[i], buffer });
      takenBytes += buffer.length;
    } catch (error) {
      const message = String(error?.message ?? error);
      // 体积超限与「其它失败」要分开说：前者是设计内的上限，后者是真故障。
      const reason = /大小限制|超过大小/.test(message)
        ? `因体积超限未取（单张上限 ${imageMiB(maxBytes)}MiB）`
        : `获取失败：${message}`;
      slots[i] = { kind: 'note', text: `[图片${i + 1}：${reason}]` };
    }
  }

  // 字节完全相同的分组：≥2 个**不同地址** ⇒ 同一张服务端占位图/图标 ⇒ 整组丢弃；
  // 同一个地址重复出现 ⇒ 只保留第一张（上游已按 URL 去重，这里只是兜底）。
  const dropped = new Set();
  const placeholderGroups = [];
  for (const group of groupByImageBytes(downloaded)) {
    if (group.items.length < 2) continue;
    const distinct = new Set(group.items.map((e) => e.url)).size >= 2;
    const [first, ...rest] = group.items;
    if (!distinct) {
      for (const entry of rest) {
        dropped.add(entry.index);
        slots[entry.index] = { kind: 'note', text: `[图片${entry.index + 1}：与图片${first.index + 1}是同一个地址、内容完全相同，已去重]` };
      }
      continue;
    }
    placeholderGroups.push(group);
    for (const entry of group.items) {
      dropped.add(entry.index);
      const peer = group.items.find((e) => e.index !== entry.index);
      slots[entry.index] = {
        kind: 'note',
        text: `[图片${entry.index + 1}：与图片${peer.index + 1}字节完全相同，判定为同一张服务端占位图，已丢弃]`
      };
    }
  }

  const content = [];
  const notes = [];
  for (let i = 0; i < take.length; i += 1) {
    const slot = slots[i];
    if (!slot) continue; // 到总量上限没下的那些，由下面的汇总说明
    if (slot.kind === 'note') { notes.push(slot.text); continue; }
    if (dropped.has(i)) continue; // 占位/重复：上面已经写过标注
    content.push({ type: 'image', mimeType: imageMimeFromBuffer(slot.buffer), data: slot.buffer.toString('base64') });
    notes.push(`[图片${i + 1}]`);
  }
  const droppedCount = [...dropped].length;
  if (placeholderGroups.length && content.length === 0) {
    notes.push(`（本次 ${droppedCount} 张图片全部是同一张服务端占位图：不同地址取回的字节完全相同，已全部丢弃——本次未取到真图）`);
  } else if (placeholderGroups.length) {
    notes.push(`（另有 ${droppedCount} 张因与服务端占位图字节完全相同已丢弃，只给出 ${content.length} 张真图）`);
  }
  if (skippedByTotal > 0) {
    notes.push(`（本次已取 ${content.length} 张；另有 ${skippedByTotal} 张图片因总量上限（一次最多 ${imageMiB(totalBound)}MiB）未取）`);
  }
  const skipped = list.length - take.length;
  if (skipped > 0) notes.push(`（另有 ${skipped} 张图片因数量上限（一次最多 ${maxImages} 张）未取）`);
  return { content, notes };
}

/** 格式化成给模型看的精简文本（吧页）。 */
export function formatBarPage(data) {
  const lines = [];
  if (data.blocked) {
    lines.push('【贴吧】被百度安全验证拦住了（按 IP 限流）。等几分钟再试；急着要信息就改用 mcp__web-search-safe__web_search 搜 site:tieba.baidu.com。');
    return lines.join('\n');
  }
  lines.push(`【贴吧】${data.bar || '(未知吧名)'}`);
  const meta = [data.followText ? `关注 ${data.followText}` : '', data.threadCountText ? `帖子 ${data.threadCountText}` : '']
    .filter(Boolean)
    .join(' · ');
  if (meta) lines.push(meta);
  if (!data.threads.length) {
    lines.push('（没解析到帖子列表：可能页面结构变化或被安全验证拦住）');
    return lines.join('\n');
  }
  lines.push('帖子列表：');
  for (const t of data.threads) {
    const bits = [`tid=${t.tid}`, t.replies ? `回复 ${t.replies}` : '', t.author ? `by ${t.author}` : '', t.time || '']
      .filter(Boolean)
      .join(' ');
    lines.push(`- ${t.title || '(无标题)'}  [${bits}]`);
  }
  lines.push(`（共 ${data.threads.length} 条；读某条用 qq_tieba_read(tid=上面的 tid)）`);
  return lines.join('\n');
}

/**
 * 格式化成给模型看的精简文本（帖子页）。
 *
 * 三层信息：表头（标题 / 吧名 / tid）+ 元信息（回复数、总页数、本页层数）+ 逐层正文。
 * 真实页首页 `<title>` 是空的，所以标题缺失时**如实写「本页未给出标题」**并补上吧名，别拿吧名冒充标题。
 * `notes`（可选，字符串数组）是调用方的**如实说明**（楼层图片状态等），排在表头之后、楼层之前，
 * 并计入长度预算——不是追加在硬上界之外。
 * 长度有硬上界 `THREAD_TEXT_MAX`；放不下就少给几层并说明，绝不超界。
 */
export function formatThreadPage(data, { maxChars = THREAD_TEXT_MAX, notes = [] } = {}) {
  const bound = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : THREAD_TEXT_MAX;
  const lines = [];
  if (data?.blocked) {
    lines.push('【贴吧帖子】被百度安全验证拦住了（按 IP 限流）。等几分钟再试；或改用 mcp__web-search-safe__web_search 搜 site:tieba.baidu.com。');
    return lines.join('\n');
  }
  const posts = Array.isArray(data?.posts) ? data.posts : [];
  const at = data?.forumName ? ` @${data.forumName}` : '';
  lines.push(`【贴吧帖子】${data?.title || '(本页未给出标题)'}${at}${data?.tid ? `（tid=${data.tid}）` : ''}`);
  for (const note of (Array.isArray(notes) ? notes : [])) if (note) lines.push(String(note));
  if (!posts.length) {
    lines.push('（没解析到楼层正文：可能页面结构变化、需要登录，或本页确实没有楼层）');
    return lines.join('\n');
  }
  const meta = [
    data?.replyNum ? `回复 ${data.replyNum}` : '',
    Number.isFinite(data?.totalPages) && data.totalPages > 1
      ? `共 ${data.totalPages} 页${data.totalPosts ? ` / 约 ${data.totalPosts} 楼` : ''}`
      : '',
    `本页 ${posts.length} 层`
  ].filter(Boolean);
  lines.push(meta.join(' · '));

  let budget = bound - lines.join('\n').length - 1;
  let shown = 0;
  for (const p of posts) {
    const head = [`${p.floor}楼`, p.author || '', p.time || ''].filter(Boolean).join(' ');
    // 只有图片/表情的楼层在真实页里很常见（正文抽出来是空字符串），如实标注而不是留一片空白。
    const block = `\n${head}\n${p.content || '（这层只有图片/表情，没有文字）'}`;
    if (block.length > budget) break;
    lines.push(block);
    budget -= block.length;
    shown += 1;
  }
  if (shown < posts.length) lines.push(`（已按长度上限截断，本页共 ${posts.length} 层，这里给了 ${shown} 层）`);
  const joined = lines.join('\n');
  return joined.length <= bound ? joined : joined.slice(0, bound);
}

// ── 降级执行与话术 ─────────────────────────────────────────────────────
//
// 话术分三层，别把它们混起来：
//   · 搜索成功 → 文本的头尾都点明「这不是贴吧原页」，中间全是搜索结果；
//   · 搜索失败 → 保留原来的「被拦/冷却」话术，只补一句说明搜索也没成功（原因）；
//   · 节流冷却 → 原来的冷却说明仍然留在文本里（且 error 字段仍是原来的话术，端点照旧回 429）。

const BLOCKED_BAR_NOTE = '贴吧被百度安全验证拦住，下面是网页搜索结果：';
const BLOCKED_THREAD_NOTE = '贴吧帖子被百度安全验证拦住，下面是网页搜索结果：';
const COOLDOWN_NOTE = '贴吧被百度安全验证拦住（冷却中），下面是网页搜索结果：';
const SEARCH_TAIL = '结果来自网页搜索，不是贴吧原页。';

/** 吧页的降级搜索词：`site:tieba.baidu.com <吧名> 吧`。 */
function barSearchQuery(bar) { return `site:tieba.baidu.com ${bar} 吧`; }
/** 帖页的降级搜索词：`site:tieba.baidu.com <tid>`。 */
function threadSearchQuery(tid) { return `site:tieba.baidu.com ${tid}`; }

/**
 * 跑一次降级搜索。返回
 * `{ ok:true, query, url, results, sources, text }` 或 `{ ok:false, query, url, error }`，永不抛。
 * `searchFetch` 可注入（离线测试用），默认 `safeFetch`——与贴吧抓取同一条带防护的链路。
 */
async function runTiebaSearch(query, { searchFetch } = {}) {
  const url = buildTiebaSearchUrl(query);
  try {
    const res = await (searchFetch ?? safeFetch)(url, SEARCH_FETCH_MAX_CHARS);
    const html = typeof res === 'string' ? res : String(res?.body ?? '');
    const status = typeof res === 'string' ? 0 : Number(res?.statusCode ?? 0);
    if (status && (status < 200 || status >= 300)) return { ok: false, query, url, error: `搜索服务 HTTP ${status}` };
    const results = parseSo360Results(html, { limit: SEARCH_RESULTS_MAX });
    if (!results.length) return { ok: false, query, url, error: '没解析到搜索结果（页面结构变了，或被 360 拦了）' };
    return {
      ok: true,
      query,
      url,
      results,
      sources: results.map((r) => ({ title: r.title, url: r.url })),
      text: formatSearchResults(query, results, { maxChars: SEARCH_TEXT_MAX })
    };
  } catch (error) {
    return { ok: false, query, url, error: `搜索请求失败：${error?.message ?? error}` };
  }
}

/** 搜索成功时的正文；失败时把原因补在原话术后面。 */
function searchText(note, baseText, search) {
  if (search.ok) return [note, search.text, SEARCH_TAIL].join('\n');
  return `${baseText}\n网页搜索也没成功（${search.error}）。`;
}

// ── 可选登录态：cookieFile → 请求头 ─────────────────────────────────────
//
// 为什么是「文件路径」而不是配置值：cookie 是账号凭据，`config.json` 会进控制台、会进备份、
// 会被 git status 看到，所以配置里**只留路径**，值单独放在一个用户自己的文件里。
//
// 读取规则（任何一步出问题都只是「未启用」，绝不抛、绝不打印）：
//   · 路径为空/空白 ⇒ 未启用（reason='unset'）；
//   · 文件不存在/读不了 ⇒ 未启用（reason='unreadable'）；
//   · 内容全空 ⇒ 未启用（reason='empty'）；
//   · 取**第一条非空行**（cookie 必须单行，多行文件里的换行会让请求头非法），去掉首尾空白；
//   · 一个 `=` 都没有 ⇒ 未启用（reason='malformed'）：把任意文本当 cookie 发出去没有意义。

const COOKIE_REASON_TEXT = {
  unset: '未配置 cookieFile',
  unreadable: 'cookie 文件不存在或不可读',
  empty: 'cookie 文件为空',
  malformed: 'cookie 文件内容不像 cookie（没有 key=value）'
};

/**
 * 读取可选的贴吧 cookie。返回 `{ enabled, cookie?, fields, reason }`，**永不抛**。
 *
 * `fields` 是 `;` 分隔的非空字段数，只用于「已启用 cookie（N 字段）」这类**脱敏汇总**；
 * `cookie` 本身只允许交给 `safeFetch` 的请求头，不得写日志/写盘/拼进返回文本。
 * `readFile` 可注入，便于离线测试（默认 `fs.readFileSync`）。
 */
export function readTiebaCookie({ cookieFile, readFile = fs.readFileSync } = {}) {
  const file = String(cookieFile ?? '').trim();
  if (!file) return { enabled: false, fields: 0, reason: 'unset' };
  let raw;
  try {
    raw = readFile(file, 'utf8');
  } catch {
    // 文件不存在/权限不足/是目录：都当「未启用」，不影响匿名抓取。
    return { enabled: false, fields: 0, reason: 'unreadable' };
  }
  const line = String(raw ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0) ?? '';
  // 单行化：即使文件里塞了 CR/LF（或一整行里混了控制字符），交给请求头的也必须是单行。
  const cookie = line.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!cookie) return { enabled: false, fields: 0, reason: 'empty' };
  if (!cookie.includes('=')) return { enabled: false, fields: 0, reason: 'malformed' };
  const fields = cookie.split(';').map((s) => s.trim()).filter(Boolean).length;
  return { enabled: true, cookie, fields, reason: 'ok' };
}

/** 人话版的未启用原因（日志里只允许出现这个，不允许出现 cookie 值）。 */
export function tiebaCookieReasonText(reason) {
  return COOKIE_REASON_TEXT[reason] ?? '未启用';
}

/**
 * 登录态请求要用的**完整移动版 UA**。
 *
 * 实测（2026-10-08，同一台机器/IP，`/mo/q/m?kz=<tid>&lp=5028`）：
 *   · cookie + 裸 `Mozilla/5.0`（`safeFetch` 的默认 UA）⇒ 百度安全验证页、0 层楼；
 *   · cookie + 这个完整移动版 UA ⇒ HTTP 200 / 181401 字节 / **28 层楼**。
 * 也就是说「登录态」不只是 cookie 一项：请求头特征也要对得上，否则服务端校验页照样拦。
 * 只在**真的读到 cookie** 时才带上它（未配置时抓取请求与接入前完全一致）。
 */
export const TIEBA_MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36';

/**
 * 抓取请求的第三个参数：**只有真的读到 cookie** 才返回 `{ headers: { cookie, 'user-agent' } }`，
 * 否则返回 `undefined`——未配置时抓取请求与接入前完全一致（不带任何额外头）。
 */
function tiebaRequestOptions({ cookieFile, readFile } = {}) {
  const cookie = readTiebaCookie({ cookieFile, readFile });
  if (!cookie.enabled) return undefined;
  return { headers: { cookie: cookie.cookie, 'user-agent': TIEBA_MOBILE_UA } };
}

/**
 * 抓取 + 解析 + 格式化（吧页）。
 *
 * `fetchText` 可注入：生产由桥接端点传入（默认就是 `safeFetch`，它带了能过反爬的请求头与内网防护），
 * 测试传假抓取器即可完全离线驱动，并顺手断言请求落在移动版 URL 上。
 * `searchFetch` 同理，只用于「被拦/被节流」时的降级搜索。
 *
 * `cookieFile`（可选，2026-10-08 起**吧页也用它**）：路径指向只放 cookie 值的文件，读到就变成
 * `headers: { cookie, 'user-agent': <完整移动版 UA> }`；未配置/读不到 ⇒ 第三个参数 `undefined`
 * （行为与接入前逐字节一致）。**实测没有它吧页就是 403**，所以桥接端点必须把它传进来。
 *
 * 返回形状：
 *   · 正常：`{ ok:true, url, data, text }`；
 *   · 命中安全验证页：`{ ok:true, url, data, text, blocked:true, fallback:'search'|'search-failed', sources }`
 *     —— 搜索成功时 `text` 的主体就是搜索结果；
 *   · 被节流器拒绝：`{ ok:false, error, text, throttled:true, reason, waitMs, fallback, sources }`
 *     —— `error` 变成「冷却说明 + 搜索结果」，端点仍回 429，但模型读到的 error 里有可用结果。
 * 不抛异常（调用方要把它变成工具错误文案）。
 */
export async function fetchBarPage(bar, page = 1, { fetchText, searchFetch, cookieFile, readFile, maxChars = 200000, limiter = tiebaBarLimiter, now = Date.now() } = {}) {
  // 吧页**需要登录态**（2026-10-08 实测后，从「永远匿名」改成「和帖页一样带 cookie」）。
  //
  // 为什么改（本机同一 IP、**同一个 URL 形态** `/mo/q/m?kw=<吧名>&lp=5028`、两次请求相隔 3 秒的 A/B）：
  //   · cookie + 完整移动版 UA ⇒ HTTP **200**、约 302KB、`parseBarPage` 解析出 **30 条**线程；
  //   · 紧接着**只去掉 cookie**（UA 不变）⇒ HTTP **403** + 百度安全验证页（2520 字节、0 条）。
  // 而且同一批里加上桌面 UA 的 PC 形态（`/f?kw=…`）只回 11.2KB 空壳，`&lm=0` 直接被 WAF 403——
  // 也就是说：吧页抓不到内容是**匿名**造成的，既不是 URL 形态问题，也不是 IP 冷却（同一分钟内带
  // cookie 那次就成功了）。旧注释里「cookie 对移动版吧页毫无帮助」的结论已被这次 A/B 推翻。
  //
  // 取舍说明（凭据暴露面）：这会把小号 cookie 送到吧页入口。cookie 的处置纪律与帖页**完全一致**
  // ——只进请求头，不进日志、不进返回文本、不进任何写盘内容（见本文件顶部的说明与 `readTiebaCookie`），
  // 未配置 `cookieFile` 时第三个参数仍是 `undefined`，抓取请求与接入前逐字节一致。
  const name = normalizeBarName(bar);
  if (!name.ok) return { ok: false, error: name.error };
  const query = barSearchQuery(name.value);
  const gate = limiter.allow(now);
  if (!gate.ok) {
    // 冷却仍然生效（不发贴吧请求），但顺手把搜索做了：冷却期内用户拿到的**主要**内容就是搜索结果。
    const search = await runTiebaSearch(query, { searchFetch });
    const text = search.ok
      ? [COOLDOWN_NOTE, search.text, SEARCH_TAIL, `（贴吧仍在冷却：${gate.message}）`].join('\n')
      : `${gate.message}\n网页搜索也没成功（${search.error}）。`;
    return {
      ok: false,
      error: text,
      text,
      throttled: true,
      reason: gate.reason,
      waitMs: gate.waitMs,
      fallback: search.ok ? 'search' : 'search-failed',
      sources: search.sources
    };
  }
  const url = buildBarUrl(name.value, page);
  // 登录态只影响请求头：与帖页同一条路径（`tiebaRequestOptions`），解析与格式化完全不变。
  const requestOptions = tiebaRequestOptions({ cookieFile, readFile });
  let html;
  try {
    const res = await (fetchText ?? safeFetch)(url, maxChars, requestOptions);
    html = typeof res === 'string' ? res : String(res?.body ?? '');
  } catch (error) {
    limiter.noteFailure(now);
    return { ok: false, error: `抓取失败：${error?.message ?? error}` };
  }
  const data = parseBarPage(html);
  if (data.blocked) {
    limiter.noteBlocked(now);
    const search = await runTiebaSearch(query, { searchFetch });
    return {
      ok: true,
      url,
      data,
      text: searchText(BLOCKED_BAR_NOTE, formatBarPage(data), search),
      blocked: true,
      fallback: search.ok ? 'search' : 'search-failed',
      sources: search.sources
    };
  }
  limiter.noteSuccess(now);
  return { ok: true, url, data, text: formatBarPage(data) };
}

/**
 * 抓取 + 解析 + 格式化（帖子页）。帖子页解析已用真实页面校准（2026-10-08，见 `parseThreadPage`），
 * 认不出仍会走 `unparsed` 文案；被拦/被节流时的降级搜索与吧页完全同构，只是搜索词换成
 * `site:tieba.baidu.com <tid>`。
 *
 * `maxChars` 默认 300000：实测同一个帖子第 1 页 184666 字节、第 2 页 190437 字节，
 * 给 200000 只剩不到 10% 余量，一被截断就会把最后一层切成残块（解析器只能用「有 content 容器才算
 * 一层」来兜底）。这里放宽到 300000，宁可整页拿全再靠格式化压长度。
 */
export async function fetchThreadPage(tid, page = 1, { fetchText, searchFetch, cookieFile, readFile, maxChars = 300000, limiter = tiebaThreadLimiter, now = Date.now() } = {}) {
  const id = normalizeTid(tid);
  if (!id.ok) return { ok: false, error: id.error };
  const query = threadSearchQuery(id.value);
  const gate = limiter.allow(now);
  if (!gate.ok) {
    const search = await runTiebaSearch(query, { searchFetch });
    const text = search.ok
      ? [COOLDOWN_NOTE, search.text, SEARCH_TAIL, `（贴吧仍在冷却：${gate.message}）`].join('\n')
      : `${gate.message}\n网页搜索也没成功（${search.error}）。`;
    return {
      ok: false,
      error: text,
      text,
      throttled: true,
      reason: gate.reason,
      waitMs: gate.waitMs,
      fallback: search.ok ? 'search' : 'search-failed',
      sources: search.sources
    };
  }
  const url = buildThreadUrl(id.value, page);
  // 同吧页：登录态只影响请求头，解析与格式化完全不变。
  const requestOptions = tiebaRequestOptions({ cookieFile, readFile });
  let html;
  try {
    const res = await (fetchText ?? safeFetch)(url, maxChars, requestOptions);
    html = typeof res === 'string' ? res : String(res?.body ?? '');
  } catch (error) {
    limiter.noteFailure(now);
    return { ok: false, error: `抓取失败：${error?.message ?? error}` };
  }
  const data = parseThreadPage(html);
  // 楼层图片：**只提取 URL，不下载**（下载与变成图像内容在 MCP 侧，见 `extractImageUrls` 的注释）。
  // 占位形态的地址已被 extractImageUrls 丢掉并**如实计数**：`imageExtractNotes` 把它写进正文，
  // 免得「服务端只给占位图」被读成「这帖没有图」。
  const extracted = extractImageUrls(html);
  // 两段说明：① 占位/真图状态（imageExtractNotes）② **可用的图片地址清单**（imageUrlNotes）——
  // 后者是模型唯一能看到 URL 的地方（结构化字段 `images` 不给模型看），少了它模型就没法
  // 把这张图转手发给 QQ（qq_send_image）。
  const imageNotes = [...imageExtractNotes(extracted), ...imageUrlNotes(extracted.urls)];
  if (data.blocked) {
    limiter.noteBlocked(now);
    const search = await runTiebaSearch(query, { searchFetch });
    return {
      ok: true,
      url,
      data,
      images: extracted.urls,
      imagesFound: extracted.found,
      text: searchText(BLOCKED_THREAD_NOTE, formatThreadPage(data, { notes: imageNotes }), search),
      blocked: true,
      fallback: search.ok ? 'search' : 'search-failed',
      sources: search.sources
    };
  }
  limiter.noteSuccess(now);
  return {
    ok: true,
    url,
    data,
    images: extracted.urls,
    imagesFound: extracted.found,
    text: formatThreadPage(data, { notes: imageNotes })
  };
}

// ── 多页抓取（pages="1-3"）：一次调用拿多页楼层 ─────────────────────────────
//
// 为什么单开一个函数，而不是给 `fetchThreadPage` 加参数：`fetchThreadPage(tid, page, …)` 的调用方
// （bridge 的 /api/socialV2/tieba/thread 与既有测试）必须**逐字节不变**地继续工作，所以多页是
// **新增入口**，单页那条路一个字节都不动。
//
// 规矩：
//   · 每页一次真实请求，URL 仍是移动版 `/mo/q/m?kz=<tid>&lp=5028`，第 N 页 `pn=(N-1)*30`；
//   · 节流器**整批只问一次**（`allow(now)`）：一次工具调用就是一次「用户意图」，逐页各问一次会让
//     第 2 页必然撞上最小间隔被拒——3 秒那条间隔是护百度 IP 的，不该在同一批内部自锁；
//   · 页数上限 `THREAD_PAGES_MAX`，超出**如实说明被截断**（`truncated` + 文本里那句说明）；
//   · 合计文本上界 `THREAD_PAGES_TEXT_MAX`，放不下就少给几层并说明；
//   · 某一页抓取失败：其余页照给，失败原因写进文本——部分成功比整批失败有用，但绝不假装全拿到了；
//   · 任何一页命中百度安全验证：立刻停止后续页（别再打已被限流的 IP），按「被拦」处理（降级搜索 + blocked）。

/**
 * 把多页结果合并成**一个** data 对象（`posts` 是各页楼层的顺序拼接）。
 *
 * 元信息（标题/吧名/回复数/总页数）只取**第一页**：真实页第 1 页的 `<title>` 是空的，而第 2 页
 * 才有标题，所以这里不追求「最全」，只保证**不编**——缺就是缺，格式化时照实写「本页未给出标题」。
 */
function mergeThreadPages(entries, range) {
  const first = entries[0]?.data ?? {};
  const posts = [];
  const pageInfo = [];
  const images = [];
  let imagesFound = 0;
  let imagesPlaceholders = 0;
  for (const entry of entries) {
    const list = Array.isArray(entry.data.posts) ? entry.data.posts : [];
    pageInfo.push({ page: entry.page, posts: list.length, unparsed: entry.data.unparsed === true });
    for (const post of list) posts.push(post);
    // 图片：各页楼层图按页序拼接、跨页去重；`imagesFound` 记住**一共认出多少张**，
    // 好让下游在「只提取了前 N 个」时如实说明，而不是假装页面只有 N 张。
    imagesFound += Number(entry.imagesFound) || 0;
    // 占位形态的地址（URL 特征，见 isPlaceholderImageUrl）不进 images，但**累计计数**：
    // 格式化时要把「认出的全是占位图，没有真图」如实写出来。
    imagesPlaceholders += Number(entry.imagesPlaceholders) || 0;
    for (const url of (Array.isArray(entry.images) ? entry.images : [])) {
      if (!images.includes(url)) images.push(url);
    }
  }
  return {
    tid: first.tid ?? '',
    title: first.title ?? '',
    forumName: first.forumName ?? '',
    replyNum: first.replyNum ?? 0,
    totalPages: first.totalPages ?? 0,
    totalPosts: first.totalPosts ?? 0,
    posts,
    pages: pageInfo,
    images,
    imagesFound,
    imagesPlaceholders,
    requestedPageCount: range.requestedPages,
    maxPages: range.maxPages,
    truncated: range.truncated === true,
    unparsed: posts.length === 0,
    blocked: false
  };
}

/**
 * 格式化成给模型看的多页精简文本。`entries` 是 `[{ page, url, data }]`。
 *
 * 与单页 `formatThreadPage` 的关系：表头/元信息同构，多页时每页加一行 `── 第 N 页 ──` 分隔。
 * 长度上界是**合计**的 `THREAD_PAGES_TEXT_MAX`（默认 40000），放不下就少给几层并**如实说明**。
 */
export function formatThreadPages(entries, { maxChars = THREAD_PAGES_TEXT_MAX, notes = [] } = {}) {
  const bound = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : THREAD_PAGES_TEXT_MAX;
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.data && typeof e.data === 'object');
  const lines = [];
  if (!list.length) return '【贴吧帖子】没有取到任何页面（多页请求一页都没成功）。';
  const first = list[0].data;
  if (first.blocked) {
    return '【贴吧帖子】被百度安全验证拦住了（按 IP 限流）。等几分钟再试；或改用 mcp__web-search-safe__web_search 搜 site:tieba.baidu.com。';
  }
  const at = first.forumName ? ` @${first.forumName}` : '';
  lines.push(`【贴吧帖子】${first.title || '(本页未给出标题)'}${at}${first.tid ? `（tid=${first.tid}）` : ''}`);
  const pageNums = list.map((e) => e.page);
  const totalPosts = list.reduce((n, e) => n + (Array.isArray(e.data.posts) ? e.data.posts.length : 0), 0);
  const meta = [
    first.replyNum ? `回复 ${first.replyNum}` : '',
    Number.isFinite(first.totalPages) && first.totalPages > 1
      ? `共 ${first.totalPages} 页${first.totalPosts ? ` / 约 ${first.totalPosts} 楼` : ''}`
      : '',
    list.length > 1 ? `本次取第 ${pageNums.join('、')} 页` : '单页',
    `合计 ${totalPosts} 层`
  ].filter(Boolean);
  lines.push(meta.join(' · '));
  for (const note of (Array.isArray(notes) ? notes : [])) if (note) lines.push(String(note));

  let budget = bound - lines.join('\n').length - 1;
  let shown = 0;
  let stopped = false;
  const multi = list.length > 1;
  for (const entry of list) {
    if (stopped) break;
    const posts = Array.isArray(entry.data.posts) ? entry.data.posts : [];
    if (multi) {
      const sectionHead = `── 第 ${entry.page} 页 ──`;
      if (sectionHead.length + 1 > budget) { stopped = true; break; }
      lines.push(sectionHead);
      budget -= sectionHead.length + 1;
    }
    if (!posts.length) {
      const empty = '（这一页没解析到楼层正文：可能页面结构变化、需要登录，或本页确实没有楼层）';
      if (empty.length + 1 > budget) { stopped = true; break; }
      lines.push(empty);
      budget -= empty.length + 1;
      continue;
    }
    for (const p of posts) {
      const head = [`${p.floor}楼`, p.author || '', p.time || ''].filter(Boolean).join(' ');
      // 同单页：只有图片/表情的楼层正文是空串，如实标注而不是留一片空白。
      const block = `\n${head}\n${p.content || '（这层只有图片/表情，没有文字）'}`;
      if (block.length > budget) { stopped = true; break; }
      lines.push(block);
      budget -= block.length;
      shown += 1;
    }
  }
  if (shown < totalPosts) lines.push(`（已按长度上限截断：本次共 ${totalPosts} 层，这里给了 ${shown} 层）`);
  const joined = lines.join('\n');
  return joined.length <= bound ? joined : joined.slice(0, bound);
}

/**
 * 抓取 + 解析 + 格式化（帖子页，**多页**）。
 *
 * 返回形状与 `fetchThreadPage` 同构，另外多出：
 *   · `pages`：**计划**取的页码（已按页数上限截断后的数组）；`urls`：对应的请求 URL（顺序一致）；
 *   · `fetchedPages`：**真的取到**（拿到 HTML 并解析过）的页码——被拦或失败会让它比 `pages` 短，
 *     两者一起看才能分清「请求了几页」和「拿到几页」；
 *   · `requestedPageCount` / `truncated`：请求了几页、是否被页数上限截断（**如实**，不静默）；
 *   · `failures`：逐页的失败说明（有失败时一定非空）；
 *   · `data.pages`：每页的楼层数（`[{page, posts, unparsed}]`），`data.posts` 是各页楼层拼接。
 * 被拦/被节流的降级搜索与单页完全同构。
 */
export async function fetchThreadPages(tid, {
  pages,
  page = 1,
  maxPages = THREAD_PAGES_MAX,
  fetchText,
  searchFetch,
  cookieFile,
  readFile,
  maxChars = 300000,
  maxCharsTotal = THREAD_PAGES_TEXT_MAX,
  limiter = tiebaThreadLimiter,
  now = Date.now()
} = {}) {
  const id = normalizeTid(tid);
  if (!id.ok) return { ok: false, error: id.error };
  const range = normalizePageRange(pages, { maxPages, page });
  const query = threadSearchQuery(id.value);
  const gate = limiter.allow(now);
  if (!gate.ok) {
    const search = await runTiebaSearch(query, { searchFetch });
    const text = search.ok
      ? [COOLDOWN_NOTE, search.text, SEARCH_TAIL, `（贴吧仍在冷却：${gate.message}）`].join('\n')
      : `${gate.message}\n网页搜索也没成功（${search.error}）。`;
    return {
      ok: false,
      error: text,
      text,
      throttled: true,
      reason: gate.reason,
      waitMs: gate.waitMs,
      fallback: search.ok ? 'search' : 'search-failed',
      sources: search.sources,
      pages: range.pages,
      fetchedPages: [],
      requestedPageCount: range.requestedPages
    };
  }
  const requestOptions = tiebaRequestOptions({ cookieFile, readFile });
  const entries = [];
  const urls = [];
  const failures = [];
  let blocked = false;
  for (const p of range.pages) {
    const url = buildThreadUrl(id.value, p);
    urls.push(url);
    let html;
    try {
      const res = await (fetchText ?? safeFetch)(url, maxChars, requestOptions);
      html = typeof res === 'string' ? res : String(res?.body ?? '');
    } catch (error) {
      failures.push(`第 ${p} 页抓取失败：${error?.message ?? error}`);
      continue;
    }
    const data = parseThreadPage(html);
    // 图片只提取、不下载（见 extractImageUrls 的注释）：`images` 是 URL 数组，`imagesFound` 是一共认出几张；
    // `imagesPlaceholders` 是**被丢弃的占位地址数**（URL 特征），汇总后写进正文说明。
    const extracted = extractImageUrls(html);
    entries.push({
      page: p,
      url,
      data,
      images: extracted.urls,
      imagesFound: extracted.found,
      imagesPlaceholders: extracted.placeholders
    });
    // 命中安全验证页：停在**这一页**，别再拿后面的页去打同一个已被限流的 IP。
    if (data.blocked) { blocked = true; break; }
  }
  const notes = [];
  if (range.truncated) {
    notes.push(`（请求了 ${range.requestedPages} 页，单次上限 ${range.maxPages} 页，只取了前 ${range.pages.length} 页：第 ${range.pages.join('、')} 页；要更多请再调用一次并放宽页码范围）`);
  }
  if (range.invalid) notes.push(`（${range.note}）`);
  for (const failure of failures) notes.push(`（${failure}）`);
  if (!entries.length) {
    return {
      ok: false,
      error: failures.length ? failures.join('；') : '抓取失败：没有取到任何页面',
      pages: range.pages,
      fetchedPages: [],
      requestedPageCount: range.requestedPages,
      truncated: range.truncated === true,
      urls,
      failures
    };
  }
  const data = mergeThreadPages(entries, range);
  // 占位图说明排在其它说明之后：它说的是「为什么没有可用的图片地址」，与页数/失败说明不冲突。
  notes.push(...imageExtractNotes({ urls: data.images, placeholders: data.imagesPlaceholders }));
  // 可用的图片地址清单（跨页去重后的并集）：模型据此调 qq_send_image 把图转手发出去。
  notes.push(...imageUrlNotes(data.images));
  const extra = {
    urls,
    pages: range.pages,
    fetchedPages: entries.map((entry) => entry.page),
    requestedPageCount: range.requestedPages,
    truncated: range.truncated === true,
    failures,
    // 图片 URL（跨页去重后的并集）与「一共认出多少张」：下游据此如实说明数量上限截断。
    images: data.images,
    imagesFound: data.imagesFound,
    data
  };
  if (blocked) {
    limiter.noteBlocked(now);
    const search = await runTiebaSearch(query, { searchFetch });
    return {
      ok: true,
      url: urls[0],
      ...extra,
      text: searchText(BLOCKED_THREAD_NOTE, formatThreadPages(entries, { maxChars: maxCharsTotal, notes }), search),
      blocked: true,
      fallback: search.ok ? 'search' : 'search-failed',
      sources: search.sources
    };
  }
  limiter.noteSuccess(now);
  return {
    ok: true,
    url: urls[0],
    ...extra,
    text: formatThreadPages(entries, { maxChars: maxCharsTotal, notes })
  };
}

// ── 抓取节流 ───────────────────────────────────────────────────────────
//
// 为什么必须有：2026-10-07 晚实测，百度是**按 IP 限流**的——十几次探测之后，连先前成功的移动版吧页
// 也返回了「百度安全验证」。所以「用户每问一次就抓一次」会在真实使用中把 IP 打热。
//
// 三条规则：两次抓取之间留最小间隔；每分钟有上限；一旦命中安全验证页，冷却一段时间不再抓。
// 时钟可注入（`now`），因此可以在测试里把冷却真的推过期，而不是靠 sleep。
//
// **吧页与帖页各用一份账本**（2026-10-08 拆开，拆分前共用同一份）：共用时的实际后果是——吧页抓到
// 一次「百度安全验证」后 `noteBlocked` 记下的 10 分钟冷却，会把**读帖子**也一起锁死（实测：吧页刚被
// 拦，紧接着的帖子页请求直接 429，冷却文案还说「刚被百度安全验证拦住」，可帖子页那次根本没发出去）。
// 百度是按入口/返回内容限流的，两类请求的失败原因不该互相记账，所以这里造两个互不相干的实例。

/** 两次抓取的最小间隔。 */
export const TIEBA_MIN_INTERVAL_MS = 3000;
/** 命中安全验证页后的冷却时长。 */
export const TIEBA_BLOCK_COOLDOWN_MS = 10 * 60 * 1000;
/** 每分钟最多抓几次。 */
export const TIEBA_MAX_PER_MINUTE = 6;

/**
 * 造一个节流器。返回 `{ allow, noteSuccess, noteBlocked, noteFailure, status, reset }`。
 * `allow(now)` 通过时会**记账**（占掉一个窗口名额），所以调用方不要「先问再决定不抓」。
 */
export function createTiebaLimiter({
  minIntervalMs = TIEBA_MIN_INTERVAL_MS,
  cooldownMs = TIEBA_BLOCK_COOLDOWN_MS,
  maxPerMinute = TIEBA_MAX_PER_MINUTE
} = {}) {
  let lastAt = 0;
  let blockedUntil = 0;
  let hits = [];

  const prune = (now) => { hits = hits.filter((t) => now - t < 60000); };
  const wait = (ms) => ({ ok: false, waitMs: Math.max(0, Math.ceil(ms)) });

  return {
    allow(now = Date.now()) {
      if (now < blockedUntil) {
        return { ...wait(blockedUntil - now), reason: 'blocked-cooldown',
          message: `刚被百度安全验证拦住，冷却中：还要等约 ${Math.ceil((blockedUntil - now) / 1000)} 秒。 想现在就要结果，可以改用 mcp__web-search-safe__web_search 搜 site:tieba.baidu.com。` };
      }
      prune(now);
      if (hits.length >= maxPerMinute) {
        return { ...wait(60000 - (now - hits[0])), reason: 'rate-limited',
          message: `贴吧抓取已达上限（每分钟 ${maxPerMinute} 次），请等约 ${Math.ceil((60000 - (now - hits[0])) / 1000)} 秒。 想现在就要结果，可以改用 mcp__web-search-safe__web_search 搜 site:tieba.baidu.com。` };
      }
      if (lastAt && now - lastAt < minIntervalMs) {
        return { ...wait(minIntervalMs - (now - lastAt)), reason: 'too-fast',
          message: `抓得太快了，两次之间至少隔 ${Math.round(minIntervalMs / 1000)} 秒。 想现在就要结果，可以改用 mcp__web-search-safe__web_search 搜 site:tieba.baidu.com。` };
      }
      lastAt = now;
      hits.push(now);
      return { ok: true };
    },
    noteSuccess(now = Date.now()) { void now; },
    noteBlocked(now = Date.now()) { blockedUntil = now + cooldownMs; },
    noteFailure(now = Date.now()) { void now; },
    status(now = Date.now()) {
      prune(now);
      return { blockedFor: Math.max(0, blockedUntil - now), lastAt, hitsInWindow: hits.length };
    },
    reset() { lastAt = 0; blockedUntil = 0; hits = []; }
  };
}

/**
 * 吧页专用的生产实例（`fetchBarPage` 的默认 limiter）。
 * 与帖页那份**完全独立**：任何一方的冷却/最小间隔/每分钟上限都影响不到另一方（两个方向都成立）。
 */
export const tiebaBarLimiter = createTiebaLimiter();

/** 帖子页专用的生产实例（`fetchThreadPage` 的默认 limiter），独立于吧页那一份。 */
export const tiebaThreadLimiter = createTiebaLimiter();

/**
 * @deprecated 拆分**之前**唯一的那份共享账本，只为「不破坏既有 import」而保留，别名指向吧页实例。
 * 本仓库已核对：`src/`、`scripts/` 里没有任何文件引用 `tiebaLimiter`（两个 fetch 的默认参数已改成各自
 * 那一份），保留它纯属对外兼容。**不要**把它同时传给 `fetchBarPage` 与 `fetchThreadPage`——那等于把
 * 这次拆分撤销、回到「吧页被拦就锁死读帖」的老毛病；新代码直接用默认值（不传 `limiter`）即可。
 */
export const tiebaLimiter = tiebaBarLimiter;

// ── 时机驱动的自主逛贴吧（巡逻闸门，t79 切片）──────────────────────────────
//
// 「巡逻」= AI **自己想起来**去看一眼贴吧（会话里刚好聊到相关话题），不是定时任务：
// 本模块**不含任何定时器**，桥接侧也没有为它新增任何 setInterval/setTimeout —— 时机完全来自
// 模型在某一轮里的自主决定（用户确认的规则 1）。
//
// 用户确认的规则（照此实现，别自行放宽）：
//   · **1 次访问** = 抓 1 条帖（含其最多两页）或抓 1 次吧页列表；每日上限默认 12 次，
//     按**自然日**（本地时区）重置；
//   · 巡逻单次读帖**最多前两页**（第 1…maxPagesPerThread 页）：第 3 页起**没有预算**，
//     想继续读必须先在会话里向用户索取，用户同意后再读，**继续读的部分不占每日次数**；
//   · 用户明确要求（`reason="user"`）⇒ **无视巡逻节奏与每日上限、不计数**——抓取层节流照旧生效；
//   · 静默时段（默认 01:00–08:00）里巡逻不主动发起，用户指定不受限；
//   · `reason` 缺省按 `patrol` 处理（保守：忘了标就按自主访问算，不能靠「忘了标」绕过上限）。
//
// 这里只放**纯策略**：时钟可注入（`now` / `at`），计数器按自然日滚动，不读写文件、不发请求。
// 落盘（`state/patrol-log.jsonl` 与 bridge.log 的那一行摘要）由桥接侧用 `buildPatrolLogEntry` /
// `formatPatrolLogSummary` 完成，这样策略可以在测试里完全离线驱动。

/** 发起方：`patrol` = 它自己想起来去看；`user` = 用户明确要求。 */
export const PATROL_REASON_PATROL = 'patrol';
export const PATROL_REASON_USER = 'user';

/**
 * 巡逻默认配置（对应配置项 `socialV2.patrol`）。
 *
 * 桥接侧 `loadConfig()` 的默认表必须与这里**逐字一致**（那边负责深度合并旧 config.json），
 * 这里这一份是策略的唯一权威：配置缺失/非法时，策略用这里的值兜底。
 */
export const PATROL_DEFAULTS = Object.freeze({
  enabled: true,          // 总开关：false ⇒ 巡逻访问一律拒绝（用户指定仍可用）
  dailyVisitCap: 12,      // 每日自主访问上限（按自然日重置）
  maxPagesPerThread: 2,   // 巡逻单次读帖最多前几页（第 1…N 页）
  quietHours: [1, 8]      // 静默时段 [起, 止)：01:00–08:00 内巡逻不主动发起
});

/** 拒绝码（桥接把它们放进响应体 `code`，MCP 与模型据此给可执行说明）。 */
export const PATROL_CODE_DISABLED = 'PATROL_DISABLED';
export const PATROL_CODE_QUIET_HOURS = 'PATROL_QUIET_HOURS';
export const PATROL_CODE_DAILY_CAP = 'PATROL_DAILY_CAP';

/**
 * 发起方归一：**只有**明确写 `user` 才算用户指定；其余（缺省 / 空 / 拼错 / null / 大小写）
 * 一律按 `patrol` 处理（fail-closed：不能靠「忘了标」绕过每日上限）。
 */
export function normalizePatrolReason(raw) {
  return String(raw ?? '').trim().toLowerCase() === PATROL_REASON_USER ? PATROL_REASON_USER : PATROL_REASON_PATROL;
}

/**
 * 静默时段归一：必须是两个 0~24 的有限数；非法整段回默认 `[1, 8]`。
 *
 * **保持调用方给的顺序**（不做「自动摆正」）：`[起, 止)` 的语义是有序区间，`[23, 7]` 是
 * 「23:00 到次日 07:00」（跨零点），把它排序成 `[7, 23]` 等于把静默时段翻转成白天——那是
 * 静默语义的反面，属于「看起来更宽容、实际默默做错事」。所以顺序照原样保留，跨零点由
 * `isPatrolQuietHour` 处理。
 */
function normalizeQuietHours(raw) {
  if (Array.isArray(raw) && raw.length === 2) {
    const a = Number(raw[0]);
    const b = Number(raw[1]);
    const hour = (n) => Number.isFinite(n) && n >= 0 && n <= 24;
    if (hour(a) && hour(b)) return [a, b];
  }
  return [...PATROL_DEFAULTS.quietHours];
}

/**
 * 巡逻配置归一：缺字段吃默认值，非法值回默认值。**永不抛**（配置是用户可编辑的，坏值不该让工具崩）。
 * `dailyVisitCap=0` 是合法值（= 自主访问一律拒绝，只留用户指定这条路）。
 */
export function normalizePatrolConfig(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const cap = Number(src.dailyVisitCap);
  const maxPages = Number(src.maxPagesPerThread);
  return {
    enabled: src.enabled !== false,
    dailyVisitCap: Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : PATROL_DEFAULTS.dailyVisitCap,
    maxPagesPerThread: Number.isFinite(maxPages) && maxPages >= 1 ? Math.floor(maxPages) : PATROL_DEFAULTS.maxPagesPerThread,
    quietHours: normalizeQuietHours(src.quietHours)
  };
}

/** 自然日 key（本地时区，`YYYY-MM-DD`）：每日上限按它滚动重置。 */
export function patrolDayKey(now = Date.now()) {
  const d = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 带本地时区偏移的 ISO 时间戳（巡逻日志用）：`2026-10-08T21:03:12+08:00`。
 * 用本地时间而不是 UTC：这份日志是给人看的，桥接的其它日志（bridge.log）也都是本地时间。
 */
export function patrolTimestamp(at = Date.now()) {
  const d = new Date(Number.isFinite(Number(at)) ? Number(at) : Date.now());
  const p = (n) => String(Math.abs(Math.floor(n))).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T`
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `${sign}${p(offsetMin / 60)}:${p(offsetMin % 60)}`;
}

/**
 * `now` 是否落在静默时段里（默认 01:00–08:00）：**含起点、不含终点**（01:00 已静默、08:00 已放行）。
 * 起点=终点视为「没有静默时段」；起点大于终点按跨零点区间处理（例如 `[23, 7]`）。
 */
export function isPatrolQuietHour(now = Date.now(), quietHours = PATROL_DEFAULTS.quietHours) {
  const [start, end] = normalizeQuietHours(quietHours);
  if (start === end) return false;
  const hour = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now()).getHours();
  return start < end ? (hour >= start && hour < end) : (hour >= start || hour < end);
}

/**
 * 巡逻读帖的页数规划：**只给前 `maxPagesPerThread` 页的预算**（第 1…N 页）。
 *
 * 与「调用方自己截断」的区别：这里把页码**过滤**掉，而不是只截个数 —— 请求第 4、5 页时
 * `normalizePageRange(..., {maxPages:2})` 会老老实实返回 `[4,5]`（它截的是个数不是页码），
 * 那等于「巡逻也能读第 4 页」，与「不给第 3 页的预算」直接冲突。超出预算的页一律丢掉；
 * 全都超预算（例如只请求了第 5 页）就退回第 1 页，并用 `note` **如实说明**这次读的是哪一页。
 *
 * 返回 `{ pages, requestedPages, truncated, droppedPages, maxPages, invalid, note }`：
 * `pages` 是真正会去抓的页码（已升序去重），`note` 非空时应写进给模型看的正文（别静默改页码）。
 */
export function planPatrolThreadPages(raw, { maxPagesPerThread = PATROL_DEFAULTS.maxPagesPerThread, page = 1 } = {}) {
  const bound = (Number.isFinite(Number(maxPagesPerThread)) && Number(maxPagesPerThread) >= 1)
    ? Math.floor(Number(maxPagesPerThread))
    : PATROL_DEFAULTS.maxPagesPerThread;
  const range = normalizePageRange(raw, { page });
  const inBudget = range.pages.filter((p) => p <= bound);
  const pages = inBudget.length ? inBudget : [1];
  const droppedPages = range.pages.filter((p) => !pages.includes(p));
  const truncated = range.truncated || droppedPages.length > 0;
  const note = truncated
    ? `（巡逻单次最多读前 ${bound} 页，这次只读第 ${pages.join('、')} 页；想继续往下读，先在会话里问一句“这条帖后面还有料，要我继续读吗？”，用户同意后再读——继续读的部分不占每日次数）`
    : '';
  return {
    pages,
    requestedPages: range.requestedPages,
    truncated,
    droppedPages,
    maxPages: bound,
    invalid: range.invalid === true,
    note
  };
}

/**
 * 巡逻日志的一行（`state/patrol-log.jsonl` 的每个 JSON 对象）。
 *
 * 字段顺序固定为 `{ts, key, reason, action, bar|tid, pages, outcome, capUsed, cap}`（外加可选
 * `trigger` = 触发这次访问的话题），`bar` 与 `tid` **只会出现一个**（吧页访问没有 tid）。
 * `pages` 一律是数组；`outcome` 的取值见 `formatPatrolLogSummary` 的注释。
 * 畸形输入一律归一成空值，**永不抛**（日志写坏了不值得再抛一个异常出来）。
 */
export function buildPatrolLogEntry({
  at = Date.now(), key = '', reason, action, bar, tid, pages, outcome, capUsed, cap, trigger
} = {}) {
  const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : fallback);
  const list = Array.isArray(pages) ? pages : (pages === undefined || pages === null ? [] : [pages]);
  const entry = {
    ts: patrolTimestamp(at),
    key: String(key ?? ''),
    reason: normalizePatrolReason(reason),
    action: String(action ?? '')
  };
  const barName = String(bar ?? '').trim();
  const threadId = String(tid ?? '').trim();
  if (barName) entry.bar = barName;
  else if (threadId) entry.tid = threadId;
  entry.pages = list.map((p) => Number(p)).filter((p) => Number.isFinite(p));
  entry.outcome = String(outcome ?? '');
  entry.capUsed = num(capUsed);
  entry.cap = num(cap);
  // 触发话题（「哪个话题让它想去看一眼」）：压成单行、去掉换行，避免一行 JSON 变成多行。
  const topic = String(trigger ?? '').replace(/\s+/g, ' ').trim();
  if (topic) entry.trigger = topic;
  return entry;
}

/**
 * 巡逻日志的人类可读摘要（写进 bridge.log，一行一条）。
 *
 * `outcome` 的取值（桥接侧写入时就用这几个）：
 *   · `silent`   —— 看完了，这次访问**当时**还没有发言（事后同一会话发言了会被升级成 `spoke`）；
 *   · `spoke`    —— 这次访问之后，同一会话在窗口内真的发了消息（`recordSentMessagesV2` 里回写）；
 *   · `blocked`  —— 被百度安全验证拦住（已走既有降级）；
 *   · `throttled`—— 被抓取层节流拦下（3 秒 / 每分钟 6 次 / 冷却），**没有发出贴吧请求**；
 *   · `failed`   —— 抓取或解析整体失败（`ok:false` 且不是节流）；
 *   · `rejected` —— 被巡逻闸门拒绝（每日上限 / 静默时段）；
 *   · `disabled` —— 自主逛贴吧总开关关着。
 */
export function formatPatrolLogSummary(entry) {
  const e = (entry && typeof entry === 'object') ? entry : {};
  const target = e.bar ? `吧页「${e.bar}」` : (e.tid ? `帖子 tid=${e.tid}` : '(未知目标)');
  const pages = Array.isArray(e.pages) && e.pages.length ? `第 ${e.pages.join('、')} 页` : '页码未知';
  const kind = e.action === 'bar' ? '吧页列表' : (e.action === 'thread' ? '读帖' : String(e.action ?? ''));
  const topic = e.trigger ? ` · 触发话题：${e.trigger}` : '';
  return `自主逛贴吧 · ${e.key ?? ''} · 发起=${e.reason ?? PATROL_REASON_PATROL} · ${kind} ${target} ${pages} · 结果=${e.outcome || '未知'} · 今日第 ${e.capUsed ?? 0}/${e.cap ?? 0} 次${topic}`;
}

/**
 * 造一个巡逻闸门。返回 `{ configure, config, usedToday, reset, request }`。
 *
 * `now` 可注入（返回毫秒），`config` 可以是对象或返回对象的函数（桥接用它读**当前生效**的配置，
 * 控制台改完 `socialV2.patrol` 立刻生效，不必重启）。`request({reason, at})` 的 `at` 也可以单独注入。
 *
 * **计数时机**：`request()` 放行时**立刻占用**一次（保守——宁可少逛也不超上限）。被抓取层节流
 * （`throttled`）或抓取失败**不退还**这次：退还等于允许「先撞冷却、再重试」，一天能打出远超 12 次
 * 的请求量，而那正是每日上限要挡的东西。
 */
export function createTiebaPatrolGate({ config, now = () => Date.now() } = {}) {
  let cfg = normalizePatrolConfig(typeof config === 'function' ? config() : config);
  let day = '';
  let used = 0;
  const at = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : Number(now());
  };
  const roll = (atMs) => {
    const key = patrolDayKey(atMs);
    if (key !== day) { day = key; used = 0; }
    return key;
  };
  return {
    configure(next) {
      cfg = normalizePatrolConfig(typeof next === 'function' ? next() : next);
      return { ...cfg };
    },
    config() { return { ...cfg }; },
    usedToday(value) { roll(at(value)); return used; },
    reset() { day = ''; used = 0; },
    /**
     * 判定一次访问请求。
     * 返回 `{ ok, code?, error?, reason, patrolled, capUsed, cap, day }`；
     * `ok:true` 时 `capUsed` 是**本次占用之后**的次数（用户指定不占名额，`capUsed` 保持不变）。
     */
    request({ reason, at: atMs } = {}) {
      const ts = at(atMs);
      const dayKey = roll(ts);
      const why = normalizePatrolReason(reason);
      const cap = cfg.dailyVisitCap;
      const base = { reason: why, day: dayKey, cap, capUsed: used, patrolled: why === PATROL_REASON_PATROL };
      if (why === PATROL_REASON_USER) return { ok: true, ...base };
      if (!cfg.enabled) {
        return {
          ok: false,
          code: PATROL_CODE_DISABLED,
          error: '自主逛贴吧已被关闭；如确需，请让用户明确要求（reason="user"）',
          ...base
        };
      }
      if (isPatrolQuietHour(ts, cfg.quietHours)) {
        return {
          ok: false,
          code: PATROL_CODE_QUIET_HOURS,
          error: `现在是静默时段（${cfg.quietHours[0]}:00–${cfg.quietHours[1]}:00），不主动逛贴吧；如确需，请让用户明确要求（reason="user"）`,
          ...base
        };
      }
      if (used >= cap) {
        return {
          ok: false,
          code: PATROL_CODE_DAILY_CAP,
          error: `今日自主访问已达 ${cap} 次上限；如确需继续，请让用户明确要求`,
          ...base
        };
      }
      used += 1;
      return { ok: true, ...base, capUsed: used };
    }
  };
}
