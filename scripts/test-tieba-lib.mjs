// 贴吧只读库的离线单元测试（t70 切片 + t71 降级搜索 + t72 搜索源换 360 + 帖子页真实校准 + t78 多页）。
//
// 验证六件事：
//   1. 入参规范化：吧名/tid/页码/页码范围（这些是唯一的注入面，必须严）；
//   2. URL 构造：吧页与**帖子页**都必须落在**移动版**入口上（PC 形态实测是空壳）；
//   3. 解析：吧页能取出吧名/关注/帖子数/帖子列表（tid/标题/作者/时间/回复数），含置顶帖、
//      含带图片表情的作者名；帖子页按 2026-10-08 真实页面校准出来的标记解析楼层
//      （`li[fn].post_list_item` + `div.content`），认不出返回 unparsed 而不崩；
//   4. 格式化：一页压成精简文本，且长度有上界（这是做专用工具的全部意义所在）；
//   5. 降级搜索（t71，t72 换源）：被百度拦住时直接跑一次 360 网页搜索并把结果并进返回——
//      搜索 URL 的编码、结果页解析（**真链取自 data-mdurl**、广告块不算结果）、畸形页面不崩、
//      格式化长度上界、抓取上限 300000，全部离线夹具驱动；
//   6. 多页（t78）：页码范围解析（"1-3"/"2"/数组/逗号，非法一律不抛）、每页 `pn=(N-1)*30`、
//      页数上限**截断但不静默**、某页失败/被拦/被节流都如实写进正文、合计长度有硬上界。
//
// 全程离线：不连贴吧、不连 360、不读 config.json、不碰 state/、不启动桥接。
// 夹具里的吧名、tid、标题、作者、摘要、链接都是编的，不含任何真实用户内容。
// 登录态用例只在系统临时目录里写**假** cookie 文件（内容全是 fixture 字样），用完即删。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { z } from 'zod';
import {
  normalizeBarName,
  normalizeTid,
  normalizePage,
  normalizePageRange,
  buildBarUrl,
  buildThreadUrl,
  buildTiebaSearchUrl,
  parseSo360Results,
  formatSearchResults,
  htmlToText,
  parsePageTitle,
  parseBarPage,
  parseThreadPage,
  formatBarPage,
  formatThreadPage,
  formatThreadPages,
  extractImageUrls,
  buildTiebaImageContent,
  isTiebaImageHost,
  isPlaceholderImageUrl,
  fetchBarPage,
  fetchThreadPage,
  fetchThreadPages,
  createTiebaLimiter,
  tiebaLimiter,
  tiebaBarLimiter,
  tiebaThreadLimiter,
  readTiebaCookie,
  tiebaCookieReasonText,
  TIEBA_MOBILE_UA,
  TIEBA_IMAGE_MAX,
  TIEBA_IMAGE_BYTES_MAX,
  TIEBA_IMAGE_TOTAL_BYTES_MAX,
  TIEBA_IMAGE_MAX_URLS,
  BAR_NAME_MAX,
  SEARCH_RESULTS_MAX,
  SEARCH_TEXT_MAX,
  MAX_THREADS,
  MAX_POSTS,
  THREAD_TEXT_MAX,
  THREAD_PAGES_MAX,
  THREAD_PAGES_TEXT_MAX
} from '../src/tieba-lib.js';

let failures = 0;
let passed = 0;
async function test(name, run) {
  const t0 = Date.now();
  try {
    await run();
    passed += 1;
    console.log(`✅ ${name}（${Date.now() - t0}ms）`);
  } catch (error) {
    failures += 1;
    console.error(`❌ ${name}（${Date.now() - t0}ms）\n   ${error?.stack ?? error?.message ?? error}`);
  }
}

// ── 夹具：结构与真实移动版吧页一致（li.tl_shadow[data-tid] / ti_title / ti_author / ti_time / btn_icon）──
const BAR_FIXTURE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>示例吧_百度贴吧</title>
<style>.x{color:red}</style><script>var a=1;</script></head><body>
<p class="forum-name"><span class="forum-name-txt">示例吧</span></p>
<p class="info_paragraph j_like_con"><span class="info_label">关注</span><span class="info_value">            123.4W</span><span class="info_label">贴子</span><span class="info_value">4567.8W</span></p>
<div id='tlist' class="post_list"><ul class="threads_list" id="frslistcontent">
<li class="tl_top scale-1px-bottom" data-tid="11000000001"><a href="/p/11000000001?lp=5028&amp;mo_device=1&amp;is_jingpost=1" class="j_common ti_item top"><div class="ti_title"><span class="ti_title_icon ti_icon_zhiding">置顶</span><span>示例置顶公告</span></div></a></li>
<li class="tl_shadow tl_shadow_new " data-tid="11000000002" data-floor="1">
<div class="ti_infos clearfix"><div class="ti_avatar" data-url="/home/main?un=x"></div><div class="ti_author_time"><div class="ti_author_icons  clearfix"><span class="ti_author">        示例楼主甲<img src="//tb1.bdstatic.com/tb/cms/nickemoji/1-2.png" class="nicknameEmoji" style="width:13px"/></span></div><span class="ti_time">21:36</span></div></div>
<a href="/p/11000000002?lp=5028&amp;mo_device=1" class="j_common ti_item"><div class="ti_title"><span>示例帖子标题一，含 &amp; 转义</span></div><div class="ti_zan_reply clearfix"><div class="ti_func_btn btn_reply"><span class="btn_icon">19</span></div></div></a></li>
<li class="tl_shadow tl_shadow_new " data-tid="11000000003" data-floor="2">
<div class="ti_infos clearfix"><div class="ti_author_time"><div class="ti_author_icons  clearfix"><span class="ti_author">        示例楼主乙</span></div><span class="ti_time">21:35</span></div></div>
<a href="/p/11000000003?lp=5028&amp;mo_device=1" class="j_common ti_item"><div class="ti_title"><span>示例帖子标题二</span></div><div class="ti_zan_reply clearfix"><div class="ti_func_btn btn_reply"><span class="btn_icon">0</span></div></div></a></li>
</ul></div></body></html>`;

// ── 夹具：**合成**的移动版帖子页（结构与 2026-10-08 实测的真实页一致，内容全部自己编）──
//
// 真实页的关键标记：`<li tid=… data-tid=… fn="<楼层号>" data-info="{&quot;…&quot;}"
// class="list_item post_list_item … j_post_list_item …"is_inner_floor=''>`，
// 正文 `<div class="content" lz="1">`，作者 `<span class="user_name"><a class="user_name">`，
// 时间 `<span class="list_item_time">`，楼中楼 `…<span class="floor_content">`。
// 夹具刻意覆盖六个坑：
//   ① 楼层号只认 `fn`：真实页里楼层号**不连续**（缺的是被删/广告位），夹具里是 fn=1,2,4——
//      用「下标 + 1」第三层就会被算成 3 楼；
//   ② 作者昵称尾巴上挂着表情 `<img class="nicknameEmoji">`，必须剥掉才不会混进名字；
//   ③ 时间不补零（真实页的月/日是 `M-D` 而不是 `MM-DD`）；
//   ④ 楼中楼在**同一个 `<li>` 内、正文之后**，正文类名是 `floor_content`（**不是** `content`）：
//      它的作者与正文都不能被算进楼层；
//   ⑤ 有一层正文只有一个图片占位（嵌套 `<div>`，抽出来是空串）——它仍然是**一层楼**，
//      且嵌套 `<div>` 不能让正文在第一个 `</div>` 处被提前切断；
//   ⑥ 首页 `<title>` 是**空的**（真实页就是这样），标题要如实留空、吧名从 `post_title_text` 取。
const THREAD_FIXTURE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title></title>
<meta property='og:title' content= /></head><body>
<div id="i_head"><a href="/f?kw=demo" class="post_title_text">示例吧</a></div>
<div id="po_list" class="father-cut-pager-class-no-page"><ul id="pblist" class="list father_cut_list_class">
<li tid="11000000002" data-tid="11000000002" fn="1"    data-info="{&quot;un&quot;:&quot;demo_account_op&quot;,&quot;is_annoy&quot;:0,&quot;pid&quot;:11000000002,&quot;floor_num&quot;:1,&quot;name_show&quot;:&quot;示例楼主甲&quot;}"    class="list_item post_list_item default_feedback j_post_list_item    no_border"is_inner_floor=''><div class="list_item_wrapper"><div class="list_main"><div class="list_item_top clearfix"><div class="list_item_user_wrap"><div class="list_item_top_name"><span class="user_name"><a href="javascript:;" class="user_name">示例楼主甲<img src="//tb1.bdstatic.com/tb/cms/nickemoji/1-2.png" class="nicknameEmoji" style="width:13px"/></a></span><span class="level level_3">3</span><br/><span class="list_item_time">2026-10-08</span></div></div></div><div class="content"                 lz="1">第一层正文，含 &amp; 转义与 <br/> 换行。</div><div class="fr_list 1 j_floor_panel" data-list-count="1"><ul class="flist"><li pid="11000000021" data-info='{"pid":11000000021,"un":"demo_account_sub"}' class="list_item_floor j_list_item_floor"><div class="fmain j_floor_main"><div class="floor_footer_item"><a href="/home/main?un=demo_account_sub" class="user_name ">示例楼中楼丙:</a><span class="floor_content">楼中楼正文，绝不能被当成楼层正文。</span></div></div></li></ul></div></div></div></li>
<li tid="11000000003" data-tid="11000000003" fn="2" data-info="{&quot;un&quot;:&quot;demo_account_b&quot;,&quot;floor_num&quot;:2,&quot;name_show&quot;:&quot;示例回复乙&quot;}" class="list_item post_list_item j_post_list_item"><div class="list_item_top"><span class="user_name"><a href="javascript:;" class="user_name">示例回复乙</a></span><br/><span class="list_item_time">2026-10-07</span></div><div class="content" lz="0">第二层正文。<br/>第二行。</div><div class="fr_list 2 j_floor_panel"><ul class="flist"><li pid="11000000022" class="list_item_floor j_list_item_floor"><span class="user_name ">示例楼中楼丁:</span><span class="floor_content">第二层的楼中楼。</span></li></ul></div></li>
<li tid="11000000005" data-tid="11000000005" fn="4" data-info="{&quot;un&quot;:&quot;demo_account_d&quot;,&quot;floor_num&quot;:4,&quot;name_show&quot;:&quot;示例图片层戊&quot;}" class="list_item post_list_item j_post_list_item"><div class="list_item_top"><span class="user_name"><a href="javascript:;" class="user_name">示例图片层戊</a></span><br/><span class="list_item_time">2026-10-06</span></div><div class="content" lz="0"><span class="wrap pbimgwapper" ><div style='height:30px;' data-class="BDE_Image" data-url='https://example.invalid/demo.png'></div></span></div></li>
</ul></div>
<script>$(document).ready(function(){ F.use('spb/widget/pblist_slide_image', function(pbSlideImage){ new pbSlideImage({ conf:{ 'kz': "11000000002", 'title': "", 'word': "示例吧", 'page' : {"req_num":30,"page_size":30,"offset":0,"current_page":1,"total_page":4,"total_num":120,"pnum":0,"tnum":0} } }); }); });</script>
<script>$(function(){ F.use('spb/widget/fixed_bar', function(FixedBar){ new FixedBar({ threadInfo: {"id":11000000002,"reply_num":42,"valid_post_num":40} }); }); });</script>
</body></html>`;

// 真实页**第 2 页**才有非空 `<title>`（「第N/M页,回贴列表-<标题>」），首页是空的——两种都要覆盖。
const THREAD_P2_FIXTURE = `<html><head><title>第2/4页,回贴列表-示例标题一</title></head><body>
<li tid="11000000033" data-tid="11000000033" fn="33" data-info="{&quot;floor_num&quot;:33,&quot;name_show&quot;:&quot;示例回复己&quot;}" class="list_item post_list_item j_post_list_item"><span class="user_name"><a href="javascript:;" class="user_name">示例回复己</a></span><br/><span class="list_item_time">2026-10-09</span><div class="content" lz="0">第三十三层正文。</div></li>
</body></html>`;

// PC 形态（`div.l_post` + `d_post_content`）作为兜底形态：真实 PC 页本机只回 7091 字节空壳，
// 但页面改版时结构识别留着。tid 走 `/p/<tid>` 链接兜底（没有 kz conf）。
const THREAD_PC_FIXTURE = `<!DOCTYPE html><html><head><title>示例PC标题_百度贴吧</title></head><body>
<a href="/p/11000000002?lp=5028">示例链接</a>
<div class="l_post" data-field='{"floor":1}'><div class="p_author"><a class="p_author_name">示例楼主甲</a></div><div class="p_tail">2026-10-07 21:30</div><div class="d_post_content j_d_post_content">PC 形态第一层正文。</div></div>
<div class="l_post" data-field='{"floor":2}'><div class="p_author"><a class="p_author_name">示例回复乙</a></div><div class="p_tail">2026-10-07 21:31</div><div class="d_post_content j_d_post_content">PC 形态第二层正文。</div></div>
</body></html>`;

// 被百度安全验证拦住的页面（只有这一个标记，内容全是编的）。
const CHALLENGE_FIXTURE = '<html><head><title>百度安全验证</title></head><body><script>window.BIOC_OPTIONS={}</script></body></html>';

// ── 夹具：**合成**的 360 结果页（标题/链接/摘要全是我编的，不是抓来的真实页面）──
//
// 结构照 2026-10-08 实测的真实页面写，但**刻意覆盖六个坑**：
//   ① 条目容器只有 `<li class="res-list">` 这一个边界，页面里还混着广告块（有 g-linkinfo-a 而无 res-list）；
//   ② 真实 URL 只在 `data-mdurl` 里，`href` 是 `https://www.so.com/link?m=…` 跳转壳 —— 绝不能当结果 URL；
//   ③ `<h3   class="res-title">`（多余空格）与 `<h3 class="res-title " >`（尾空格 + `<a>` 前换行）两种写法；
//   ④ 摘要有两副面孔：`<p class="res-desc">` 与 `<div class='res-rich so-rich-bbs'><span class="res-list-summary">`；
//   ⑤ 有的条目**根本没有摘要**（卡片式结果只给标题）；
//   ⑥ `res-list-summary` 这类类名里含 `res-list` 子串，不能当成结果块边界。
const SO360_FIXTURE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>site:tieba.baidu.com 示例吧 - 360搜索</title></head><body>
<div id="page"><style>.res-list{display:block}.x{color:red}</style><script>var adTrack=1;</script>
<ul id="results">
<li class="res-item-ad"><h3 class="res-title"><a href="https://www.so.com/link?m=ADSHELL000" data-mdurl="https://tieba.baidu.com/p/11000000099">广告位标题（res-list 之前，绝不该进结果）</a></h3><p class="res-desc">广告位摘要。</p><cite><a href="https://www.so.com/link?m=AD" class="g-linkinfo-a">tieba.baidu.com</a></cite></li>
<li class="res-list"><h3   class="res-title"><a href="https://www.so.com/link?m=SHELLAAA" data-mdurl="https://tieba.baidu.com/p/11000000002" data-cache="https://tieba.baidu.com/p/11000000002" rel="noreferrer" data-res='{"tp":21,"pos":1}' target="_blank">示例帖子标题一_示例吧_百度贴吧</a></h3><p class="res-desc"><span class="gray g-c-gray">2026年1月2日&nbsp;-&nbsp;</span>示例摘要一：夹具里编的一句话，含 &amp; 转义。</p><p class="g-linkinfo"><cite><a href="https://www.so.com/link?m=SHELLAAA2" target="_blank" class="g-linkinfo-a" rel="noopener">tieba.baidu.com</a></cite></p></li>
<li class="res-item-ad"><h3 class="res-title"><a href="https://www.so.com/link?m=ADSHELL111" data-mdurl="https://tieba.baidu.com/p/11000000098">夹在两条结果之间的广告块</a></h3><p class="res-desc">广告摘要，必须被忽略。</p><cite><a href="https://www.so.com/link?m=AD2" class="g-linkinfo-a">tieba.baidu.com</a></cite></li>
<li class="res-list"><h3 class="res-title " >
<a  href="https://www.so.com/link?m=SHELLBBB%2F%2B" data-mdurl="https://tieba.baidu.com/p/11000000003?lp=5028&amp;mo_device=1"  rel="noopener" data-res='{"tp":21,"pos":2}' target="_blank"><em>示例</em>帖子标题二</a></h3>
<div class='res-rich so-rich-bbs clearfix'><p><span class="g-c-dark">66条回帖&nbsp;&nbsp;2026年1月2日</span></p><span class="res-list-summary">示例摘要二，带 <strong>强调</strong> 标签。</span></div></li>
<li class="res-list-summary"><h3 class="res-title"><a href="https://www.so.com/link?m=TRAP" data-mdurl="https://tieba.baidu.com/p/11000000077">类名里含 res-list 子串，但这不是结果块</a></h3><p class="res-desc">子串陷阱摘要。</p></li>
<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=SHELLCCC" data-mdurl="https://tieba.baidu.com/p/11000000004">示例帖子标题三（这条没有摘要）</a></h3><p class="g-linkinfo"><cite><a href="https://www.so.com/link?m=SHELLCCC2" class="g-linkinfo-a">tieba.baidu.com</a></cite></p></li>
<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=SHELLDDD" data-mdurl="https://tieba.baidu.com/p/11000000002">重复链接，必须被去掉</a></h3><p class="res-desc">重复摘要。</p></li>
<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=SHELLONLY" rel="noopener">只有跳转壳、没有 data-mdurl 的条目</a></h3><p class="res-desc">这条绝不能拿 href 当结果 URL，只能整条丢掉。</p></li>
</ul></div></body></html>`;

// 降级搜索用的假抓取器：记下 URL 与抓取上限，返回合成结果页。
// （360 的结果区在页面约 166000 字符之后才开始，所以上限是这条链路的关键参数，必须断言。）
function fakeSearch(seen) {
  return (u, maxChars) => { seen.push({ url: u, maxChars }); return SO360_FIXTURE; };
}


// ── 1. 入参规范化 ──────────────────────────────────────────────────────
await test('贴吧库-1：吧名规范化 —— 去空白/解百分号编码；空、控制字符、超长一律拒绝', async () => {
  assert.deepEqual(normalizeBarName('  原神  '), { ok: true, value: '原神' });
  assert.deepEqual(normalizeBarName('%E5%8E%9F%E7%A5%9E'), { ok: true, value: '原神' });
  assert.equal(normalizeBarName('').ok, false);
  assert.equal(normalizeBarName('   ').ok, false);
  assert.equal(normalizeBarName('a/b').ok, false, '斜杠必须拒（会改变 URL 路径）');
  assert.equal(normalizeBarName('a?b').ok, false, '问号必须拒（会注入查询参数）');
  assert.equal(normalizeBarName('a&b').ok, false, '& 必须拒');
  assert.equal(normalizeBarName('a\u0000b').ok, false, '控制字符必须拒');
  assert.equal(normalizeBarName('%E5%8E').ok, false, '坏掉的百分号编码必须拒而不是抛');
  assert.equal(normalizeBarName('张'.repeat(BAR_NAME_MAX + 1)).ok, false);
  assert.equal(normalizeBarName('张'.repeat(BAR_NAME_MAX)).ok, true, '正好到上限要放行');
});

await test('贴吧库-2：tid 规范化 —— 只收纯数字，拒绝空/非数字/0/超长', async () => {
  assert.deepEqual(normalizeTid(' 11000000002 '), { ok: true, value: '11000000002' });
  assert.equal(normalizeTid('').ok, false);
  assert.equal(normalizeTid('abc').ok, false);
  assert.equal(normalizeTid('11000 0002').ok, false);
  assert.equal(normalizeTid('0').ok, false);
  assert.equal(normalizeTid('-1').ok, false);
  assert.equal(normalizeTid('1'.repeat(21)).ok, false);
});

await test('贴吧库-3：页码兜底 —— 缺省 1、非法回落 1、上限 100', async () => {
  assert.equal(normalizePage(undefined), 1);
  assert.equal(normalizePage(''), 1);
  assert.equal(normalizePage('3'), 3);
  assert.equal(normalizePage('abc'), 1);
  assert.equal(normalizePage('-2'), 1);
  assert.equal(normalizePage('9999'), 100);
});

// ── 2. URL 构造（吧页与帖子页都必须走移动版）──────────────────────────
await test('贴吧库-4：URL 必须落在移动版入口上（PC 形态实测是空壳）', async () => {
  const bar1 = buildBarUrl('原神');
  assert.ok(bar1.startsWith('https://tieba.baidu.com/mo/q/m?'), `吧页必须走 /mo/q/m：${bar1}`);
  assert.ok(bar1.includes('kw=%E5%8E%9F%E7%A5%9E'), '吧名必须 URL 编码');
  assert.ok(bar1.includes('lp=5028'), '必须带 lp=5028（移动版入口的实测可用参数）');
  assert.ok(!bar1.includes('pn='), '第一页不该带 pn');
  assert.ok(buildBarUrl('原神', 2).includes('pn=50'), '第二页 pn=50');

  // 帖子页曾经是 `/p/<tid>?lp=5028&mo_device=1`：2026-10-08 实测那条只回 7091 字节空壳
  // （`<title>贴吧小程序</title>`、0 层楼），所以改成和吧页同一个移动版入口（`kw` → `kz`）。
  const th1 = buildThreadUrl('11000000002');
  assert.ok(th1.startsWith('https://tieba.baidu.com/mo/q/m?'), `帖子页必须走 /mo/q/m：${th1}`);
  assert.ok(th1.includes('kz=11000000002'), '帖子页用 kz=<tid> 定位');
  assert.ok(th1.includes('lp=5028'), '必须带 lp=5028');
  assert.ok(!th1.includes('mo_device=1'), '空壳形态的 mo_device 不该再拼');
  assert.ok(!th1.includes('pn='), '第一页不该带 pn');
  assert.ok(buildThreadUrl('11000000002', 2).includes('pn=30'), '第二页 pn=30（实测 pn 是楼层偏移、每页 30 层）');
  assert.ok(buildThreadUrl('11000000002', 3).includes('pn=60'), '第三页 pn=60');
});

// ── 3. 解析 ───────────────────────────────────────────────────────────
await test('贴吧库-5：吧页解析 —— 吧名/关注/帖子数/帖子列表（含置顶、含图片表情作者）', async () => {
  const data = parseBarPage(BAR_FIXTURE);
  assert.equal(data.bar, '示例吧');
  assert.equal(data.followText, '123.4W');
  assert.equal(data.threadCountText, '4567.8W');
  assert.equal(data.threads.length, 3, `应解析出 3 条（含置顶）：${JSON.stringify(data.threads)}`);
  const [top, one, two] = data.threads;
  assert.equal(top.tid, '11000000001');
  assert.equal(top.title, '示例置顶公告', '置顶帖的标题不能被「置顶」图标字样顶掉');
  assert.equal(one.tid, '11000000002');
  assert.equal(one.title, '示例帖子标题一，含 & 转义', 'HTML 实体必须还原');
  assert.equal(one.author, '示例楼主甲', '作者名里的表情 <img> 必须被剥掉');
  assert.equal(one.time, '21:36');
  assert.equal(one.replies, 19);
  assert.equal(two.replies, 0, '回复数 0 要是数字 0，不是 NaN');
  assert.equal(typeof two.replies, 'number');
});

await test('贴吧库-6：畸形页面不崩 —— 安全验证页/空串/垃圾都返回空列表', async () => {
  const blocked = '<html><head><title>百度安全验证</title></head><body><script>window.BIOC_OPTIONS={}</script></body></html>';
  for (const html of [blocked, '', null, '<div>没有列表</div>', '<li class="tl_shadow" data-tid="不是数字"></li>']) {
    const data = parseBarPage(html);
    assert.ok(Array.isArray(data.threads), 'threads 必须永远是数组');
    assert.equal(data.threads.length, 0, `不该从畸形页面里编出帖子：${String(html).slice(0, 40)}`);
  }
  const junk = `<li class="tl_shadow" data-tid="123"><div class="ti_title"><span>标题</span></div></li>`.repeat(200);
  assert.ok(parseBarPage(junk).threads.length <= MAX_THREADS, `必须受 MAX_THREADS 限制：${MAX_THREADS}`);
  // 安全验证页必须被**识别**，而不是被当成「这个吧没有帖子」——限流是按 IP 起作用的，工具要能说清原因。
  assert.equal(parseBarPage(blocked).blocked, true, '安全验证页必须置 blocked');
  assert.equal(parseBarPage('<div>正常的空页面</div>').blocked, false, '普通空页面不该误报 blocked');
  assert.equal(parseBarPage(BAR_FIXTURE).blocked, false, '正常吧页不该误报 blocked');
});

await test('贴吧库-7：移动版帖子页 —— 楼层号取 fn（不是下标）、作者剥表情、时间不补零、楼中楼不串味', async () => {
  const data = parseThreadPage(THREAD_FIXTURE);
  assert.equal(data.unparsed, false, `真实形态必须认得出来：${JSON.stringify(data.posts)}`);
  assert.equal(data.tid, '11000000002', 'tid 从页面 conf 的 kz 取');
  assert.equal(data.forumName, '示例吧', '吧名从 post_title_text 取');
  assert.equal(data.title, '', '真实页首页 <title> 是空的，标题必须如实留空而不是编一个');
  assert.equal(data.replyNum, 42, '回复数从内嵌 threadInfo 取');
  assert.equal(data.totalPages, 4, '总页数从内嵌 page conf 取');
  assert.equal(data.totalPosts, 120);

  assert.equal(data.posts.length, 3, `应解析出 3 层（楼中楼不算层）：${JSON.stringify(data.posts)}`);
  const [one, two, media] = data.posts;
  assert.equal(one.floor, 1, '楼层号必须取 fn');
  assert.equal(one.author, '示例楼主甲', '昵称尾巴上的表情 <img> 必须剥掉');
  assert.equal(one.time, '2026-10-08');
  assert.equal(one.isOp, true, 'lz="1" 就是楼主层');
  assert.equal(one.content, '第一层正文，含 & 转义与\n换行。', '<br/> 应变成换行、实体要还原');

  assert.equal(two.floor, 2);
  assert.equal(two.author, '示例回复乙');
  assert.equal(two.time, '2026-10-07');
  assert.equal(two.isOp, false);
  assert.equal(two.content, '第二层正文。\n第二行。');

  assert.equal(media.floor, 4, '★楼层号取 fn：真实页楼层号不连续，第三层是 fn=4，用「下标+1」会算成 3');
  assert.equal(media.author, '示例图片层戊');
  assert.equal(media.content, '', '只有图片占位的楼层正文是空串，但它仍然是**一层楼**');

  assert.ok(!data.posts.some((p) => p.content.includes('楼中楼正文')), '楼中楼（floor_content）绝不能混进楼层正文');
  assert.ok(!data.posts.some((p) => p.content.includes('第二层的楼中楼')), '第二层的楼中楼也不能串进来');
  assert.ok(!data.posts.some((p) => String(p.author).includes('楼中楼')), '楼中楼的作者不能被算成楼层作者');
  assert.ok(data.posts.every((p) => Number.isInteger(p.floor) && p.floor >= 1), '楼层号必须是正整数');

  // 第 2 页的真实形态：<title> 才有「第N/M页,回贴列表-<标题>」，前缀要剥掉；fn 也不从 1 开始。
  const p2 = parseThreadPage(THREAD_P2_FIXTURE);
  assert.equal(p2.title, '示例标题一', `第 2 页标题的前缀要剥掉：${JSON.stringify(p2.title)}`);
  assert.equal(p2.posts.length, 1);
  assert.equal(p2.posts[0].floor, 33, 'pn 偏移后的楼层号同样来自 fn，不是 1');

  // PC 形态兜底：真实 PC 页只回空壳，但结构识别留着，页面改版时还有人认。
  const pc = parseThreadPage(THREAD_PC_FIXTURE);
  assert.equal(pc.tid, '11000000002', 'PC 形态的 tid 从 /p/<tid> 链接兜底取');
  assert.equal(pc.title, '示例PC标题', '`_百度贴吧` 后缀要剥掉');
  assert.equal(pc.posts.length, 2, `PC 形态仍要能解析：${JSON.stringify(pc.posts)}`);
  assert.equal(pc.posts[0].author, '示例楼主甲');
  assert.equal(pc.posts[0].floor, 1);
  assert.match(pc.posts[1].content, /PC 形态第二层正文/);
});

await test('贴吧库-7b：帖子页畸形/残页 —— 一律 [] + unparsed:true，永不抛；上限生效', async () => {
  const junk = [
    '', null, undefined,
    '<html><body><div>完全陌生的结构</div></body></html>',
    '<li class="list_item post_list_item" fn="1"></li>',                                   // 有 fn 但没有正文容器 → 不算一层
    '<li class="list_item_floor j_list_item_floor"><span class="floor_content">楼中楼不是楼层</span></li>',
    '<li class="list_item post_list_item" fn="abc"><div class="content">fn 不是数字</div></li>',
    '<li class="list_item post_list_item" fn="1"><div class="floor_content">类名子串陷阱</div></li>',
    '<div class="content">只有正文容器、没有楼层容器</div>',
    '<li class="list_item post_list_item"'.repeat(500)
  ];
  for (const html of junk) {
    const data = parseThreadPage(html);
    assert.ok(Array.isArray(data.posts), 'posts 必须永远是数组');
    assert.equal(data.posts.length, 0, `不该从畸形页面里编出楼层：${String(html).slice(0, 40)}`);
    assert.equal(data.unparsed, true, '认不出必须如实置 unparsed');
    assert.equal(data.blocked, false, '普通残页不该误报 blocked');
  }
  // 被截断的页面（正文容器没闭合）：只该给「确实有楼层容器 + 正文容器」的那一层，且绝不抛。
  const truncated = parseThreadPage('<li class="list_item post_list_item" fn="7"><div class="content">被截断的正文');
  assert.equal(truncated.posts.length, 1, '残块里的楼层容器 + 正文容器仍然算一层');
  assert.equal(truncated.posts[0].floor, 7);
  assert.equal(truncated.unparsed, false);
  // 安全验证页要能被**识别**，而不是被当成「这帖没有楼层」。
  assert.equal(parseThreadPage(CHALLENGE_FIXTURE).blocked, true);
  assert.equal(parseThreadPage(CHALLENGE_FIXTURE).unparsed, true);
  // 楼层数必须受 MAX_POSTS 限制，否则一页能把上下文淹掉。
  const many = Array.from({ length: 200 }, (_, i) => `<li class="list_item post_list_item" fn="${i + 1}"><span class="user_name">示例用户</span><div class="content" lz="0">第${i + 1}层</div></li>`).join('');
  assert.equal(parseThreadPage(many).posts.length, MAX_POSTS, `必须受 MAX_POSTS=${MAX_POSTS} 限制`);
});

await test('贴吧库-8：htmlToText —— 剥脚本样式标签、还原实体、压掉空白', async () => {
  const text = htmlToText('<div>甲 &amp; 乙<script>var x=1;</script><style>.a{}</style><br/>丙&nbsp;丁</div>');
  assert.ok(text.includes('甲 & 乙'), text);
  assert.ok(!text.includes('var x=1'), '脚本必须被剥掉');
  assert.ok(!text.includes('.a{}'), '样式必须被剥掉');
  assert.ok(text.includes('丙') && text.includes('丁'));
  assert.equal(parsePageTitle('<title>某吧_百度贴吧</title>'), '某吧');
});

// ── 4. 格式化（做专用工具的意义：把一页压成小块）───────────────────────
await test('贴吧库-9：格式化 —— 关键信息齐全，且长度有上界（否则不如直接用 web_fetch）', async () => {
  const data = parseBarPage(BAR_FIXTURE);
  const text = formatBarPage(data);
  assert.ok(text.includes('示例吧'), '要带吧名');
  assert.ok(text.includes('11000000002'), '每条都要带 tid（下一步读帖子要用）');
  assert.ok(text.includes('qq_tieba_read'), '要告诉模型下一步怎么读');
  assert.ok(text.length < 1500, `三条帖子应远小于 1500 字符，实测 ${text.length}`);

  const big = { bar: '示例吧', followText: '1W', threadCountText: '2W', threads: Array.from({ length: 50 }, (_, i) => ({ tid: String(11000000000 + i), title: '标题'.repeat(30), author: '某吧友', time: '21:00', replies: i })) };
  const bigText = formatBarPage(big);
  assert.ok(bigText.length < 12000, `50 条满配也要有上界，实测 ${bigText.length}`);

  const threadText = formatThreadPage(parseThreadPage(THREAD_FIXTURE));
  assert.ok(threadText.includes('示例楼主甲') && threadText.includes('第一层正文'));
  assert.match(threadText, /本页 3 层/, `元信息要如实报本页层数：${threadText.split('\n')[1]}`);
  const emptyThread = formatThreadPage({ title: '某帖', tid: '123', posts: [] });
  assert.ok(emptyThread.includes('没解析到楼层正文'), '空结果要如实说明，不能沉默');
  // 被拦时的话术必须和「没有内容」区分开，并给出降级路径。
  const blockedBar = formatBarPage({ blocked: true, bar: '示例吧', threads: [] });
  assert.match(blockedBar, /安全验证/, `被拦话术要提到安全验证：${blockedBar}`);
  assert.match(blockedBar, /web_search|site:tieba/, '必须给出降级路径');
  assert.match(formatThreadPage({ blocked: true }), /安全验证/);
});

await test('贴吧库-9b：帖子页格式化 —— 长度有硬上界（否则一页 30 层就能淹掉上下文）', async () => {
  const big = {
    tid: '11000000002',
    title: '示例标题'.repeat(30),
    forumName: '示例吧',
    replyNum: 999,
    totalPages: 4,
    totalPosts: 120,
    posts: Array.from({ length: MAX_POSTS }, (_, i) => ({
      floor: i + 1,
      author: '某吧友',
      time: '2026-10-08',
      content: '示例正文'.repeat(200)
    }))
  };
  const text = formatThreadPage(big);
  assert.ok(text.length <= THREAD_TEXT_MAX, `必须守住 ${THREAD_TEXT_MAX}，实测 ${text.length}`);
  assert.match(text, /截断/, '被截断时必须说明，不能装作给全了');
  assert.ok(text.length > 0);
  // 上限极小时也不能超界，且不抛。
  assert.ok(formatThreadPage(big, { maxChars: 200 }).length <= 200, '上限极小也要守住');
  assert.ok(formatThreadPage(big, { maxChars: 0 }).length <= THREAD_TEXT_MAX, '非法上限回落默认值');
  assert.match(formatThreadPage({ posts: null }), /没解析到楼层正文/, 'posts 缺失不抛，如实说明');
});

// ── 5. 抓取编排（注入假抓取器，全程离线）──────────────────────────────
await test('贴吧库-10：抓取编排 —— 请求必须落在移动版 URL；被拦/坏输入/抓取异常都要如实返回', async () => {
  const seen = [];
  const searched = [];
  // 本用例要连做几次抓取，用宽松的专属节流器，避免被默认实例的节流规则挡住（节流本身由 11/12 覆盖）。
  const freeLimiter = () => createTiebaLimiter({ minIntervalMs: 0, maxPerMinute: 1000, cooldownMs: 0 });
  const fake = (url) => { seen.push(url); return BAR_FIXTURE; };

  const ok = await fetchBarPage('示例吧', 2, { limiter: freeLimiter(), fetchText: fake });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(seen.length, 1, '必须只抓一次');
  assert.ok(ok.url.startsWith('https://tieba.baidu.com/mo/q/m?'), `必须走移动版入口：${ok.url}`);
  assert.ok(ok.url.includes('kw=%E7%A4%BA%E4%BE%8B%E5%90%A7'), `吧名必须编码进 URL：${ok.url}`);
  assert.ok(ok.url.includes('pn=50'), `第二页要带 pn=50：${ok.url}`);
  assert.match(ok.text, /示例吧/, '返回文本要含吧名');
  assert.match(ok.text, /11000000002/, '返回文本要含 tid');
  assert.equal(ok.fallback, undefined, '正常路径不该出现 fallback 字段');

  // 被拦时必须**自动**降级搜索（这里注入假搜索，全程离线），而不是只给一句「改用 web_search」。
  const blocked = await fetchBarPage('示例吧', 1, { limiter: freeLimiter(), fetchText: () => CHALLENGE_FIXTURE, searchFetch: fakeSearch(searched) });
  assert.equal(blocked.ok, true);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.fallback, 'search', JSON.stringify(blocked.sources));
  assert.match(blocked.text, /安全验证/, `被拦要明说：${blocked.text}`);
  assert.match(blocked.text, /网页搜索结果/, '必须真的有搜索结果');
  assert.equal(searched.length, 1, '被拦时应恰好搜一次');

  const badInput = await fetchBarPage('a/b', 1, { limiter: freeLimiter(), fetchText: fake });
  assert.equal(badInput.ok, false);
  assert.match(badInput.error, /斜杠|符号|不能包含/, badInput.error);
  assert.equal(seen.length, 1, '坏输入不该发起任何请求');

  const thrown = await fetchBarPage('示例吧', 1, { limiter: freeLimiter(), fetchText: () => { throw new Error('boom'); } });
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /boom/, '抓取异常要带原因，不能吞掉');

  // 帖子页：URL 必须落在移动版 /mo/q/m?kz=<tid>，抓取上限要给足（真实页 184666 / 190437 字节）。
  const seenThread = [];
  const thread = await fetchThreadPage('11000000002', 1, {
    limiter: freeLimiter(),
    fetchText: (u, mc) => { seenThread.push({ url: u, maxChars: mc }); return THREAD_FIXTURE; }
  });
  assert.equal(thread.ok, true);
  assert.ok(thread.url.startsWith('https://tieba.baidu.com/mo/q/m?'), `帖子页必须走移动版入口：${thread.url}`);
  assert.ok(thread.url.includes('kz=11000000002'), thread.url);
  assert.equal(seenThread.length, 1, '必须只抓一次');
  assert.equal(seenThread[0].maxChars, 300000, `帖子页抓取上限要给到 300000（收到 ${seenThread[0].maxChars}）`);
  assert.match(thread.text, /示例楼主甲/);
  assert.match(thread.text, /第一层正文/);
  assert.equal(thread.data.posts.length, 3, '抓取编排要真的把解析结果带出来');
  const badTid = await fetchThreadPage('abc', 1, { limiter: freeLimiter(), fetchText: () => THREAD_FIXTURE });
  assert.equal(badTid.ok, false);
});

// ── 6. 抓取节流（时间可注入，冷却用假时钟真的推过期）──────────────────
await test('贴吧库-11：节流器 —— 最小间隔 / 每分钟上限 / 命中验证页后冷却', async () => {
  const lim = createTiebaLimiter({ minIntervalMs: 3000, cooldownMs: 600000, maxPerMinute: 3 });
  let t = 1000000;
  assert.equal(lim.allow(t).ok, true, '空账本第一次必须放行');
  const fast = lim.allow(t + 500);
  assert.equal(fast.ok, false);
  assert.equal(fast.reason, 'too-fast', JSON.stringify(fast));
  assert.ok(fast.waitMs > 0 && fast.waitMs <= 3000, `等待秒数要合理：${fast.waitMs}`);
  assert.match(fast.message, /太快/);
  t += 3000; assert.equal(lim.allow(t).ok, true);
  t += 3000; assert.equal(lim.allow(t).ok, true);
  t += 3000;
  const limited = lim.allow(t);
  assert.equal(limited.ok, false, '窗口里已有 3 条，必须触发每分钟上限');
  assert.equal(limited.reason, 'rate-limited', JSON.stringify(limited));
  lim.noteBlocked(t);
  const cooling = lim.allow(t + 1000);
  assert.equal(cooling.reason, 'blocked-cooldown', JSON.stringify(cooling));
  assert.match(cooling.message, /冷却/);
  assert.equal(lim.allow(t + 600001).ok, true, '冷却结束且窗口滑走后应恢复');
  lim.reset();
  assert.equal(lim.allow(t).ok, true, 'reset 后回到干净状态');
});

await test('贴吧库-12：节流与编排联动 —— 被节流时根本不发贴吧请求；命中验证页后进入冷却', async () => {
  const lim = createTiebaLimiter({ minIntervalMs: 3000, cooldownMs: 600000, maxPerMinute: 10 });
  let calls = 0;
  const searched = [];
  const okFetch = () => { calls += 1; return BAR_FIXTURE; };
  // 被拦/被节流时的降级搜索全部走假抓取器：本用例必须离线，且要能断言搜索结果确实进了文本。
  const search = fakeSearch(searched);
  const t = 2000000;
  const first = await fetchBarPage('示例吧', 1, { fetchText: okFetch, searchFetch: search, limiter: lim, now: t });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(calls, 1);
  // 被节流：ok 仍是 false、节流标记仍在（冷却没被搜索取消），但 error/text 里已经带着搜索结果。
  const second = await fetchBarPage('示例吧', 1, { fetchText: okFetch, searchFetch: search, limiter: lim, now: t + 200 });
  assert.equal(second.ok, false);
  assert.equal(second.throttled, true);
  assert.match(second.error, /太快/);
  assert.equal(second.fallback, 'search');
  assert.ok(second.text.includes('https://tieba.baidu.com/'), `被节流时也要给出搜索结果：${second.text}`);
  assert.match(second.text, /冷却/, '冷却说明不能被搜索顶掉');
  assert.equal(calls, 1, '被节流时必须根本没有发贴吧请求');
  const blockedOnce = await fetchBarPage('示例吧', 1, { fetchText: () => CHALLENGE_FIXTURE, searchFetch: search, limiter: lim, now: t + 5000 });
  assert.equal(blockedOnce.ok, true);
  assert.match(blockedOnce.text, /安全验证/, blockedOnce.text);
  const afterBlock = await fetchBarPage('示例吧', 1, { fetchText: okFetch, searchFetch: search, limiter: lim, now: t + 6000 });
  assert.equal(afterBlock.ok, false);
  assert.equal(afterBlock.reason, 'blocked-cooldown', JSON.stringify(afterBlock));
  assert.equal(calls, 1, `冷却期内不许再抓（被拦那次用的是另一个抓取器，不该计数），实测 ${calls}`);
  const recovered = await fetchBarPage('示例吧', 1, { fetchText: okFetch, searchFetch: search, limiter: lim, now: t + 610000 });
  assert.equal(recovered.ok, true, '冷却结束后必须恢复可用');
  assert.equal(calls, 2, '恢复后应真的再抓了一次');
  const threadThrottled = await fetchThreadPage('11000000002', 1, { fetchText: okFetch, searchFetch: search, limiter: lim, now: t + 610100 });
  // 注意：这里两边都**显式注入**同一个 limiter，所以贴页照样被节流——这测的是「注入什么就用什么」。
  // 「吧页/帖页默认各自独立」由贴吧库-20 / 贴吧库-21 覆盖（拆分前默认是同一份共享账本）。
  assert.equal(threadThrottled.throttled, true, '显式注入同一个 limiter 时，两边仍按这一份账走（注入即生效）');
});

// ── 7. 降级搜索（t71 / t72 换 360）：被百度拦住时直接给网页搜索结果 ────
await test('贴吧库-13：搜索 URL —— 走 www.so.com/s，site: 查询被正确编码', async () => {
  const url = buildTiebaSearchUrl('site:tieba.baidu.com 示例吧 吧');
  assert.ok(url.startsWith('https://www.so.com/s?'), `必须用 360 搜索（Bing 对贴吧索引为空，落地是 search-failed）：${url}`);
  assert.ok(url.includes('site%3Atieba.baidu.com'), `site: 里的冒号必须编码成 %3A：${url}`);
  assert.ok(url.includes('q='), '查询词要落在 q 参数上');
  // 控制字符与换行必须被压掉，避免拼出畸形查询串。
  const cleaned = buildTiebaSearchUrl('site:tieba.baidu.com\n示例\t吧');
  assert.ok(!/[\u0000-\u001f\u007f]/.test(cleaned), `URL 里不该有控制字符：${cleaned}`);
  assert.ok(decodeURIComponent(cleaned.replace(/\+/g, ' ')).includes('site:tieba.baidu.com 示例 吧'), cleaned);
  assert.ok(buildTiebaSearchUrl('').endsWith('q='), '空查询也不抛，退化成空 q');
});

await test('贴吧库-14：结果页解析 —— 真链取自 data-mdurl（不是 href 跳转壳）、广告块不算结果、去重、limit', async () => {
  const results = parseSo360Results(SO360_FIXTURE);
  assert.equal(results.length, 3, `应解析出 3 条（重复链接要去掉、广告块/子串陷阱/只有跳转壳的条目都不算）：${JSON.stringify(results)}`);

  // ★核心断言：两条 <a> 的 href 都是 so.com 跳转壳，URL 必须来自 data-mdurl。
  assert.equal(results[0].url, 'https://tieba.baidu.com/p/11000000002', 'URL 必须取自 data-mdurl，不能是 href 的 so.com 壳');
  assert.ok(!/so\.com/.test(results[0].url), `结果 URL 绝不能落在跳转壳上：${results[0].url}`);
  assert.ok(results.every((r) => !/so\.com/.test(r.url)), `每个结果 URL 都不能是 so.com 跳转壳：${JSON.stringify(results.map((r) => r.url))}`);
  assert.equal(results[0].title, '示例帖子标题一_示例吧_百度贴吧', results[0].title);
  assert.equal(results[0].snippet, '2026年1月2日 - 示例摘要一：夹具里编的一句话，含 & 转义。', '实体要还原，标签要剥掉');

  assert.equal(results[1].url, 'https://tieba.baidu.com/p/11000000003?lp=5028&mo_device=1', 'data-mdurl 里的 &amp; 必须还原成 &');
  assert.equal(results[1].title, '示例 帖子标题二', '标题里的 <em> 高亮标签要剥掉');
  assert.equal(results[1].snippet, '示例摘要二，带 强调 标签。', 'res-rich 里的 res-list-summary 要能当摘要');

  assert.equal(results[2].url, 'https://tieba.baidu.com/p/11000000004');
  assert.equal(results[2].snippet, '', '没有摘要的条目也要保留（360 卡片式结果就是没摘要），不算失败');
  assert.deepEqual(Object.keys(results[0]).sort(), ['snippet', 'title', 'url'], '字段必须正好是 title/url/snippet');

  assert.equal(parseSo360Results(SO360_FIXTURE, { limit: 2 }).length, 2, 'limit 要生效');
  assert.equal(parseSo360Results(SO360_FIXTURE, { limit: 0 }).length, 3, '非法 limit 回落默认值而不是返回空');
  assert.ok(parseSo360Results(SO360_FIXTURE).length <= SEARCH_RESULTS_MAX);
});

await test('贴吧库-15：畸形结果页 —— 一律返回空数组，绝不抛', async () => {
  const junk = [
    '', null, undefined,
    '<div>完全不是结果页</div>',
    // g-linkinfo-a 出现次数比 res-list 多：广告块没有 res-list，不该被当成结果容器。
    '<div class="ad"><cite><a class="g-linkinfo-a" href="https://www.so.com/link?m=AD">tieba.baidu.com</a></cite></div>',
    '<li class="res-list"><h3 class="res-title">只有标题没有链接</h3></li>',
    '<li class="res-list"><h3 class="res-title"><a href="javascript:void(0)">非 http 链接</a></h3></li>',
    // data-mdurl 本身就是跳转壳（不是 http 真链的贴吧地址）→ 整条丢掉。
    '<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=S" data-mdurl="https://www.so.com/link?m=S2">跳转壳不算结果</a></h3><p class="res-desc">摘要。</p></li>',
    '<li class="res-list"><h3 class="res-title"><a data-mdurl="https://x.example/y">标签没闭合',
    '<li class="res-list'.repeat(500),
    '<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=S" data-mdurl="https://x.example/y"></a></h3></li>',
    '<li class="res-list-summary"><h3 class="res-title"><a data-mdurl="https://x.example/y">子串不算边界</a></h3></li>'
  ];
  for (const html of junk) {
    const results = parseSo360Results(html);
    assert.ok(Array.isArray(results), '永远返回数组');
    assert.equal(results.length, 0, `不该从畸形页面里编出结果：${String(html).slice(0, 40)}`);
  }
});

await test('贴吧库-16：搜索结果格式化 —— 一行一条、含链接、长度有硬上界', async () => {
  const long = Array.from({ length: 20 }, (_, i) => ({
    title: `示例标题${i}`.repeat(10),
    url: `https://tieba.baidu.com/p/1100000${String(i).padStart(4, '0')}`,
    snippet: '示例摘要'.repeat(40)
  }));
  const text = formatSearchResults('site:tieba.baidu.com 示例吧 吧', long, { maxChars: 600 });
  assert.ok(text.length <= 600, `必须守住 maxChars，实测 ${text.length}`);
  assert.match(text, /https:\/\/tieba\.baidu\.com\/p\//, '必须带可点的链接');
  assert.match(text, /site:tieba\.baidu\.com/, '要带搜索词，方便模型判断结果来源');
  assert.match(text, /截断/, '被截断时要说明');

  const dflt = formatSearchResults('q', long);
  assert.ok(dflt.length <= SEARCH_TEXT_MAX, `默认上限 ${SEARCH_TEXT_MAX}，实测 ${dflt.length}`);
  assert.ok(formatSearchResults('q', long, { maxChars: 20 }).length <= 20, '上限极小时也不能超');
  assert.match(formatSearchResults('q', []), /没有可用/, '空结果要如实说明');
  assert.match(formatSearchResults(null, null), /没有可用/, '空输入不抛');
  assert.equal(typeof formatSearchResults('q', [{ title: '', url: '', snippet: '' }]), 'string', '缺 url 的条目要滤掉而不是崩');
});

await test('贴吧库-17：端到端降级 —— 被拦/冷却时把搜索结果并进返回，节流冷却照旧保留', async () => {
  const seen = [];
  const search = fakeSearch(seen);
  const lim = createTiebaLimiter({ minIntervalMs: 0, maxPerMinute: 100, cooldownMs: 600000 });
  const t = 3000000;

  // ① 被安全验证拦住 → 搜索结果就是正文主体。
  const r = await fetchBarPage('示例吧', 1, { limiter: lim, now: t, fetchText: () => CHALLENGE_FIXTURE, searchFetch: search });
  assert.equal(r.ok, true, JSON.stringify(r.sources));
  assert.equal(r.blocked, true);
  assert.equal(r.fallback, 'search');
  assert.equal(r.sources.length, 3, JSON.stringify(r.sources));
  assert.ok(r.sources.every((s) => s.title && s.url), 'sources 要带标题与链接');
  assert.ok(r.sources.every((s) => !/so\.com/.test(s.url)), `sources 里不能有 so.com 跳转壳：${JSON.stringify(r.sources)}`);
  assert.match(r.text, /百度安全验证拦住，下面是网页搜索结果/, r.text);
  assert.ok(r.text.includes('结果来自网页搜索，不是贴吧原页'), '必须点明不是贴吧原页');
  assert.ok((r.text.match(/https:\/\/tieba\.baidu\.com\//g) ?? []).length >= 3, `正文里要 ≥3 条链接：${r.text}`);
  assert.equal(seen.length, 1, '恰好搜一次');
  assert.ok(seen[0].url.includes('site%3Atieba.baidu.com'), seen[0].url);
  assert.ok(decodeURIComponent(seen[0].url.replace(/\+/g, ' ')).includes('site:tieba.baidu.com 示例吧 吧'), seen[0].url);
  // 360 的结果区在页面约 166000 字符之后才开始：上限给小了只会拿到空壳并误判「0 条」。
  assert.equal(seen[0].maxChars, 300000, `搜索抓取上限必须是 300000（收到 ${seen[0].maxChars}）`);

  // ② 搜索本身也失败 → 保留原来的被拦话术，只补一句原因。
  //    这一条要用**独立的**节流器：① 已经让 lim 进入冷却，共用的话这里会被节流挡住，测不到「被拦」分支。
  const limFail = createTiebaLimiter({ minIntervalMs: 0, maxPerMinute: 100, cooldownMs: 600000 });
  const r2 = await fetchBarPage('示例吧', 1, { limiter: limFail, now: t, fetchText: () => CHALLENGE_FIXTURE, searchFetch: () => { throw new Error('search down'); } });
  assert.equal(r2.ok, true);
  assert.equal(r2.blocked, true);
  assert.equal(r2.fallback, 'search-failed');
  assert.match(r2.text, /安全验证/, '原话术必须保留');
  assert.match(r2.text, /网页搜索也没成功（搜索请求失败：search down）/, r2.text);

  // ③ 冷却期内：仍然被节流（不发贴吧请求、端点仍会回 429），但正文主体是搜索结果。
  let refetched = 0;
  const r3 = await fetchBarPage('示例吧', 1, { limiter: lim, now: t + 11000, fetchText: () => { refetched += 1; return BAR_FIXTURE; }, searchFetch: search });
  assert.equal(r3.ok, false, JSON.stringify(r3.sources));
  assert.equal(r3.throttled, true);
  assert.equal(r3.reason, 'blocked-cooldown');
  assert.equal(refetched, 0, '冷却期内不许再抓贴吧');
  assert.equal(r3.fallback, 'search');
  assert.ok((r3.text.match(/https:\/\/tieba\.baidu\.com\//g) ?? []).length >= 3, r3.text);
  assert.match(r3.text, /冷却/, '冷却说明不能被搜索顶掉');
  assert.match(r3.error, /冷却中/, 'error 字段仍带着原来的冷却话术');

  // ④ 帖页同构：搜索词换成 site:tieba.baidu.com <tid>。
  const seenThread = [];
  const lim2 = createTiebaLimiter({ minIntervalMs: 0, maxPerMinute: 100, cooldownMs: 0 });
  const rt = await fetchThreadPage('11000000002', 1, { limiter: lim2, now: t, fetchText: () => CHALLENGE_FIXTURE, searchFetch: fakeSearch(seenThread) });
  assert.equal(rt.ok, true);
  assert.equal(rt.fallback, 'search');
  assert.match(rt.text, /贴吧帖子被百度安全验证拦住/, rt.text);
  assert.ok(decodeURIComponent(seenThread[0].url.replace(/\+/g, ' ')).includes('site:tieba.baidu.com 11000000002'), seenThread[0].url);
});

// ── 8. 可选登录态（cookieFile）：只影响请求头，解析与格式化一律不变 ──────
//
// 登录态是「可选接入」：配置里只放**路径**，值从文件读；未配置/文件缺失/内容为空统统等于「未启用」，
// 抓取请求必须与接入前**完全一致**（第三个参数 undefined），而且 cookie 值绝不能出现在返回文本里。
// **作用域**：吧页与帖子页**都**带 cookie + 完整移动版 UA（2026-10-08 实测后统一：同一个吧页 URL
// 形态下，只去掉 cookie 就回 403「百度安全验证」，见 tieba-lib 的 `fetchBarPage`）。未配置/文件缺失/
// 内容为空统统等于「未启用」，抓取请求必须与接入前**完全一致**（第三个参数 undefined），
// 而且 cookie 值绝不能出现在返回文本或 URL 里。降级搜索走 360，**绝不**带贴吧 cookie。
// 这里用的 cookie 全是 fixture 字样的假值，写在系统临时目录，用例结束即删。

/** 在临时目录里造一个假 cookie 文件，返回 `{ dir, file }`；用完必须 fs.rmSync(dir, {recursive:true,force:true})。 */
function makeFakeCookieFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tieba-cookie-test-'));
  const file = path.join(dir, 'fake-cookie.txt');
  fs.writeFileSync(file, content);
  return { dir, file };
}

await test('贴吧库-18：cookieFile 读取 —— 单行化/字段数；未配置/缺失/空/畸形一律「未启用」且不抛', async () => {
  const { dir, file } = makeFakeCookieFile('  BDUSS=fixture-one; STOKEN=fixture-two  \n');
  try {
    const ok = readTiebaCookie({ cookieFile: file });
    assert.equal(ok.enabled, true);
    assert.equal(ok.cookie, 'BDUSS=fixture-one; STOKEN=fixture-two', '首尾空白必须去掉');
    assert.equal(ok.fields, 2, '字段数用于脱敏汇总（已启用 cookie（N 字段））');
    assert.equal(ok.reason, 'ok');

    // 多行文件：只取第一条非空行（请求头值必须单行）。
    fs.writeFileSync(file, '\r\n\r\nBDUSS=fixture-one\r\nSTOKEN=fixture-two\r\n');
    assert.equal(readTiebaCookie({ cookieFile: file }).cookie, 'BDUSS=fixture-one');

    // 一整行里混了控制字符也要单行化。
    fs.writeFileSync(file, 'BDUSS=fixture\rone; STOKEN=two');
    const controls = readTiebaCookie({ cookieFile: file });
    assert.ok(!/[\r\n\u0000-\u001f]/.test(controls.cookie), '交给请求头的值必须是单行');

    // 各种「未启用」形态：只返回 enabled:false + reason，永不抛。
    fs.writeFileSync(file, '   \n');
    assert.equal(readTiebaCookie({ cookieFile: file }).enabled, false);
    assert.equal(readTiebaCookie({ cookieFile: file }).reason, 'empty');
    assert.equal(readTiebaCookie({ cookieFile: '   ' }).reason, 'unset');
    assert.equal(readTiebaCookie({ cookieFile: path.join(dir, 'missing.txt') }).reason, 'unreadable');
    assert.equal(readTiebaCookie({ cookieFile: path.join(dir, 'missing.txt') }).enabled, false, '文件缺失必须当未启用');
    assert.equal(readTiebaCookie({ cookieFile: dir }).reason, 'unreadable', '路径是目录也当未启用');
    fs.writeFileSync(file, 'not-a-cookie-at-all');
    assert.equal(readTiebaCookie({ cookieFile: file }).reason, 'malformed');
    assert.equal(readTiebaCookie().enabled, false, '完全不传也必须安全');
    assert.equal(readTiebaCookie({}).enabled, false);
    // 人话版原因只描述状态，不含任何值。
    for (const reason of ['unset', 'unreadable', 'empty', 'malformed', '???']) {
      assert.doesNotMatch(tiebaCookieReasonText(reason), /BDUSS|fixture/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('贴吧库-19：抓取请求头 —— 吧页与帖页都要 cookie + 完整移动版 UA；未配/缺失完全不带；降级搜索不带', async () => {
  const { dir, file } = makeFakeCookieFile('BDUSS=fixture-one; STOKEN=fixture-two\n');
  const freeLimiter = () => createTiebaLimiter({ minIntervalMs: 0, maxPerMinute: 1000, cooldownMs: 0 });
  try {
    // 配了 cookieFile ⇒ 抓取请求带 `headers: { cookie: <文件内容>, 'user-agent': <完整移动版 UA> }`。
    // UA 不是装饰：实测只有 cookie + 完整移动版 UA 才能过百度的服务端校验页（裸 Mozilla/5.0 会被拦）。
    const seen = [];
    const fake = (url, maxChars, opts) => { seen.push({ url, maxChars, opts }); return THREAD_FIXTURE; };
    const withCookie = await fetchThreadPage('11000000002', 1, { limiter: freeLimiter(), fetchText: fake, cookieFile: file });
    assert.equal(withCookie.ok, true);
    assert.deepEqual(seen[0].opts, {
      headers: { cookie: 'BDUSS=fixture-one; STOKEN=fixture-two', 'user-agent': TIEBA_MOBILE_UA }
    });
    assert.match(seen[0].opts.headers['user-agent'], /^Mozilla\/5\.0 \(Linux; Android/, 'UA 必须是完整移动版');
    assert.equal(seen[0].maxChars, 300000, '加了登录态也不能动抓取上限');
    assert.match(withCookie.text, /第一层正文/, '登录态不该改变解析结果');
    assert.doesNotMatch(withCookie.text, /BDUSS|STOKEN/, 'cookie 值绝不能进返回文本');
    assert.doesNotMatch(withCookie.url, /BDUSS|STOKEN/, 'cookie 值绝不能进 URL');

    // 未配置 ⇒ 第三个参数必须是 undefined（与接入前逐字节一致：一个额外头都不带）。
    const anon = await fetchThreadPage('11000000002', 1, { limiter: freeLimiter(), fetchText: fake });
    assert.equal(anon.ok, true);
    assert.equal(seen[1].opts, undefined, '未配置 cookieFile 时不得追加任何请求头');

    // 文件缺失 ⇒ 视为未启用，且**不抛**（照旧匿名抓取）。
    const missing = await fetchThreadPage('11000000002', 1, {
      limiter: freeLimiter(), fetchText: fake, cookieFile: path.join(dir, 'missing.txt')
    });
    assert.equal(missing.ok, true);
    assert.equal(seen[2].opts, undefined);

    // 吧页**同样必须带 cookie**（2026-10-08 实测后从「永远匿名」改过来）：同一个 URL 形态
    // `/mo/q/m?kw=<吧名>&lp=5028` 下，带 cookie ⇒ 200 / 解析出 30 条线程；只去掉 cookie ⇒ 403 +
    // 百度安全验证页（同 IP、相隔 3 秒的 A/B）。所以这里断言的是「吧页也要带」，与帖页同一个形态。
    const barSeen = [];
    const bar = await fetchBarPage('示例吧', 1, {
      limiter: freeLimiter(), cookieFile: file,
      fetchText: (url, maxChars, opts) => { barSeen.push({ url, maxChars, opts }); return BAR_FIXTURE; }
    });
    assert.equal(bar.ok, true);
    assert.deepEqual(barSeen[0].opts, {
      headers: { cookie: 'BDUSS=fixture-one; STOKEN=fixture-two', 'user-agent': TIEBA_MOBILE_UA }
    }, '吧页必须带 cookie + 完整移动版 UA（没有它吧页实测就是 403 安全验证页）');
    assert.match(barSeen[0].opts.headers['user-agent'], /^Mozilla\/5\.0 \(Linux; Android/, '吧页 UA 也必须是完整移动版');
    assert.equal(barSeen[0].maxChars, 200000, '吧页抓取上限保持 200000（实测这个上限下仍解析出 30 条）');
    assert.doesNotMatch(bar.text, /BDUSS|STOKEN/, 'cookie 值绝不能进返回文本');
    assert.doesNotMatch(bar.url, /BDUSS|STOKEN/, 'cookie 值绝不能进 URL');
    // 未配置 ⇒ 吧页也和帖页一样恒为 undefined（一个额外头都不带，与接入前逐字节一致）。
    const barAnon = await fetchBarPage('示例吧', 1, {
      limiter: freeLimiter(),
      fetchText: (url, maxChars, opts) => { barSeen.push({ url, maxChars, opts }); return BAR_FIXTURE; }
    });
    assert.equal(barAnon.ok, true);
    assert.equal(barSeen[1].opts, undefined, '未配置 cookieFile 时吧页不得追加任何请求头');
    // 文件缺失 ⇒ 同样视为未启用（不抛、照旧匿名）。
    const barMissing = await fetchBarPage('示例吧', 1, {
      limiter: freeLimiter(), cookieFile: path.join(dir, 'missing.txt'),
      fetchText: (url, maxChars, opts) => { barSeen.push({ url, maxChars, opts }); return BAR_FIXTURE; }
    });
    assert.equal(barMissing.ok, true);
    assert.equal(barSeen[2].opts, undefined, 'cookie 文件缺失时吧页照旧匿名');

    // 帖页那一侧是同一个请求头形态（同一次运行、同一个 cookieFile）——两边现在口径一致。
    const threadSeenAgain = [];
    await fetchThreadPage('11000000002', 1, {
      limiter: freeLimiter(), cookieFile: file,
      fetchText: (url, maxChars, opts) => { threadSeenAgain.push({ url, maxChars, opts }); return THREAD_FIXTURE; }
    });
    assert.equal(threadSeenAgain[0].opts?.headers?.cookie, 'BDUSS=fixture-one; STOKEN=fixture-two', '帖页必须带 cookie');
    assert.equal(threadSeenAgain[0].opts?.headers?.['user-agent'], barSeen[0].opts.headers['user-agent'],
      '吧页与帖页必须用同一条 UA（两边过校验页靠的是同一个请求头组合）');
    assert.equal(barSeen.length, 3, '吧页那三次抓取的请求头形态不能被帖页那次影响');

    // 降级搜索走 360，与百度账号无关：**绝不能**把贴吧 cookie 送给搜索引擎。
    const searchArgs = [];
    const blocked = await fetchThreadPage('11000000002', 1, {
      limiter: freeLimiter(),
      fetchText: () => CHALLENGE_FIXTURE,
      searchFetch: (...args) => { searchArgs.push(args); return SO360_FIXTURE; },
      cookieFile: file
    });
    assert.equal(blocked.fallback, 'search');
    assert.equal(searchArgs.length, 1);
    assert.equal(searchArgs[0][2], undefined, '降级搜索不该带贴吧 cookie');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 9. 节流账拆分（2026-10-08）：吧页与帖页各自独立，两个方向都要成立 ────────
//
// 拆分前两者共用同一份模块级账本：吧页命中百度验证页 ⇒ `noteBlocked` 记下的 10 分钟冷却把**读帖子**
// 也一起锁死了（实测：紧接着的帖页请求直接 429，冷却文案还说「刚被百度安全验证拦住」）。下面两个
// 用例分别从「limiter 实例」和「编排默认值」两个层面把这件事钉住。
await test('贴吧库-20：节流器拆开 —— 吧页冷却不影响帖页、帖页冷却不影响吧页；间隔与每分钟上限各自记账', async () => {
  const bar = createTiebaLimiter({ minIntervalMs: 3000, cooldownMs: 600000, maxPerMinute: 2 });
  const thread = createTiebaLimiter({ minIntervalMs: 3000, cooldownMs: 600000, maxPerMinute: 2 });
  const t = 3000000;

  // 方向 ①：吧页被拦 ⇒ 帖页照旧放行（拆分前这里必是 blocked-cooldown）。
  bar.noteBlocked(t);
  assert.equal(bar.allow(t + 1).reason, 'blocked-cooldown', '吧页自己必须进冷却');
  const threadAfterBarBlock = thread.allow(t + 1);
  assert.equal(threadAfterBarBlock.ok, true, `吧页冷却不许波及帖页：${JSON.stringify(threadAfterBarBlock)}`);
  assert.equal(thread.allow(t + 2).reason, 'too-fast', '帖页自己的最小间隔照旧生效（挡它的是帖页那笔账，不是吧页的冷却）');
  thread.noteBlocked(t + 1000);
  assert.equal(thread.allow(t + 1001).reason, 'blocked-cooldown', '帖页自己必须进冷却');

  // 方向 ②：帖页被拦 ⇒ 吧页照旧放行（吧页那份冷却到 t+600000 结束，把它推过期再验）。
  const barAfterThreadBlock = bar.allow(t + 600002);
  assert.equal(barAfterThreadBlock.ok, true, `帖页冷却不许波及吧页：${JSON.stringify(barAfterThreadBlock)}`);
  assert.equal(bar.allow(t + 603003).ok, true, '吧页第二笔（隔满最小间隔）');
  const barCapped = bar.allow(t + 606004);
  assert.equal(barCapped.reason, 'rate-limited', `吧页数的是自己窗口里的 2 笔：${JSON.stringify(barCapped)}`);
  // 同一时刻帖页那份账的窗口是空的（它只在 t+2 之前记过一笔，早滑出 60 秒窗口）——分钟计数不共享。
  assert.equal(thread.allow(t + 601001).ok, true, '帖页冷却结束照旧放行（与吧页已触顶无关）');
  assert.equal(thread.allow(t + 604002).ok, true, '帖页自己数自己的第二笔');
  const threadCapped = thread.allow(t + 607003);
  assert.equal(threadCapped.reason, 'rate-limited', `帖页也有独立的每分钟上限：${JSON.stringify(threadCapped)}`);
});

await test('贴吧库-21：编排层默认账本 —— 吧页被拦后，帖页抓取（不传 limiter）照样真的发出请求', async () => {
  const t = 4000000;
  const searched = [];
  const reset = () => { tiebaBarLimiter.reset(); tiebaThreadLimiter.reset(); };
  try {
    // 方向 ①：吧页被拦 ⇒ 帖页默认账本不受影响，真的要抓一次并把楼层正文拿回来。
    reset();
    tiebaBarLimiter.noteBlocked(t);
    let barFetched = 0;
    const barR = await fetchBarPage('示例吧', 1, {
      now: t + 1, searchFetch: fakeSearch(searched),
      fetchText: () => { barFetched += 1; return BAR_FIXTURE; }
    });
    assert.equal(barR.throttled, true, JSON.stringify({ ok: barR.ok, reason: barR.reason }));
    assert.equal(barR.reason, 'blocked-cooldown');
    assert.equal(barFetched, 0, '冷却期内不许发吧页请求');
    let threadFetched = 0;
    const threadR = await fetchThreadPage('11000000002', 1, {
      now: t + 2, searchFetch: fakeSearch(searched),
      fetchText: () => { threadFetched += 1; return THREAD_FIXTURE; }
    });
    assert.notEqual(threadR.throttled, true,
      `吧页冷却不许锁死读帖（本次改动的核心）：${JSON.stringify({ ok: threadR.ok, reason: threadR.reason })}`);
    assert.equal(threadR.ok, true);
    assert.equal(threadFetched, 1, '帖页必须真的发了一次请求');
    assert.match(threadR.text, /第一层正文/, '楼层正文必须真的拿到');

    // 方向 ②：帖页被拦 ⇒ 吧页默认账本不受影响。
    reset();
    tiebaThreadLimiter.noteBlocked(t);
    let threadFetched2 = 0;
    const threadR2 = await fetchThreadPage('11000000002', 1, {
      now: t + 1, searchFetch: fakeSearch(searched),
      fetchText: () => { threadFetched2 += 1; return THREAD_FIXTURE; }
    });
    assert.equal(threadR2.throttled, true, JSON.stringify({ ok: threadR2.ok, reason: threadR2.reason }));
    assert.equal(threadR2.reason, 'blocked-cooldown');
    assert.equal(threadFetched2, 0, '帖页冷却期内不许发帖页请求');
    let barFetched2 = 0;
    const barR2 = await fetchBarPage('示例吧', 1, {
      now: t + 2, searchFetch: fakeSearch(searched),
      fetchText: () => { barFetched2 += 1; return BAR_FIXTURE; }
    });
    assert.notEqual(barR2.throttled, true,
      `帖页冷却不许波及吧页：${JSON.stringify({ ok: barR2.ok, reason: barR2.reason })}`);
    assert.equal(barR2.ok, true);
    assert.equal(barFetched2, 1, '吧页必须真的发了一次请求');

    // 兼容性：旧导出名 tiebaLimiter 还在（别名指向吧页那份），老 import 不会因拆分而炸。
    assert.equal(typeof tiebaLimiter.allow, 'function', 'tiebaLimiter 这个旧导出名必须保留');
    assert.equal(tiebaLimiter, tiebaBarLimiter, 'tiebaLimiter 是别名（文档已注明不要把它同时传给两个 fetch）');
    assert.notEqual(tiebaBarLimiter, tiebaThreadLimiter, '吧页/帖页必须是两个不同实例');
  } finally {
    // 这个用例用的是**生产默认账本**，跑完必须还原，免得给别的用例留账。
    reset();
  }
});

// ── 10. 多页（t78 切片）：页码范围 / 多页编排 / 合计长度上界 ────────────────
//
// 「只能看第一页」是用户实测的痛点，所以多页必须**如实**：请求了几页、真正取到几页、被上限截断了几页、
// 哪一页失败了，全都要能被断言到；任何一步都不许静默丢弃。

/** 造一页**合成**的移动版帖子页：楼层号从 (page-1)*30+1 起，结构与真实页一致（内容全是编的）。 */
function threadFixturePage(page, { count = 2, totalPages = 4, totalNum = 120 } = {}) {
  const base = (page - 1) * 30;
  const floors = Array.from({ length: count }, (_, i) => {
    const fn = base + i + 1;
    return `<li tid="9${fn}" data-tid="9${fn}" fn="${fn}" data-info="{&quot;floor_num&quot;:${fn},&quot;name_show&quot;:&quot;示例用户${fn}&quot;}" class="list_item post_list_item j_post_list_item"><span class="user_name"><a href="javascript:;" class="user_name">示例用户${fn}</a></span><br/><span class="list_item_time">2026-10-0${(page % 9) + 1}</span><div class="content" lz="0">第 ${fn} 层正文（来自第 ${page} 页）。</div></li>`;
  }).join('');
  return `<html><head><title>第${page}/${totalPages}页,回贴列表-示例标题</title></head><body>
<ul id="pblist" class="list">${floors}</ul>
<script>$(function(){ F.use('spb/widget/pblist_slide_image', function(){ new pbSlideImage({ conf:{ 'kz': "11000000002", 'word': "示例吧", 'page' : {"req_num":30,"page_size":30,"current_page":${page},"total_page":${totalPages},"total_num":${totalNum}} } }); }); });</script>
</body></html>`;
}

await test('贴吧库-22：页码范围解析 —— "1-3"/"2"/数组/逗号；去重升序；非法回落单页且不抛', async () => {
  assert.deepEqual(normalizePageRange('1-3').pages, [1, 2, 3]);
  assert.deepEqual(normalizePageRange('2').pages, [2]);
  assert.deepEqual(normalizePageRange(2).pages, [2]);
  assert.deepEqual(normalizePageRange('3-1').pages, [1, 2, 3], '两端颠倒要摆正（模型会写反）');
  assert.deepEqual(normalizePageRange('1~2').pages, [1, 2], '~ 也是合法分隔符');
  assert.deepEqual(normalizePageRange('1,3,3').pages, [1, 3], '逗号分隔 + 去重 + 升序');
  assert.deepEqual(normalizePageRange([3, 1]).pages, [1, 3], '数组也要去重升序');
  assert.deepEqual(normalizePageRange(undefined, { page: 4 }).pages, [4], '缺省 pages 时用 page');
  assert.deepEqual(normalizePageRange('', { page: 4 }).pages, [4]);
  assert.deepEqual(normalizePageRange(null, { page: 4 }).pages, [4]);
  // 单页号仍走 normalizePage：0/负数回落 1、超 100 收到 100。
  assert.deepEqual(normalizePageRange('0').pages, [1]);
  assert.deepEqual(normalizePageRange('999').pages, [100]);

  // 非法输入：不抛、回落到 page、并在 note 里如实说「看不懂」。
  for (const bad of ['abc', '1-', '-3', '1-2-3', '第2页', '1.5', {}, true, 'a,b']) {
    const r = normalizePageRange(bad, { page: 2 });
    assert.deepEqual(r.pages, [2], `${String(bad)} 应回落单页：${JSON.stringify(r)}`);
    assert.equal(r.invalid, true, `${String(bad)} 必须标 invalid`);
    assert.match(r.note, /看不懂/, `必须如实说明：${r.note}`);
  }
  // 页数上限：**截断但不静默**——requestedPages 留住用户的原始请求。
  // 上限是用户确认的 10：**1-9 页不再截断**（旧上限 5 会砍掉一半），1-12 才截断。
  const nine = normalizePageRange('1-9');
  assert.deepEqual(nine.pages, [1, 2, 3, 4, 5, 6, 7, 8, 9], `上限放宽到 ${THREAD_PAGES_MAX} 后 9 页必须全给`);
  assert.equal(nine.requestedPages, 9);
  assert.equal(nine.truncated, false, '9 页在 10 的上限之内，不该被截断');
  assert.equal(nine.maxPages, THREAD_PAGES_MAX);
  const capped = normalizePageRange('1-12');
  assert.deepEqual(capped.pages, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], `默认上限 ${THREAD_PAGES_MAX}`);
  assert.equal(capped.requestedPages, 12, '用户请求了几页必须记住');
  assert.equal(capped.truncated, true, '超过 10 页必须如实标截断');
  assert.deepEqual(normalizePageRange('1-8', { maxPages: 3 }).pages, [1, 2, 3], 'maxPages 可注入');
  const exact = normalizePageRange(`1-${THREAD_PAGES_MAX}`);
  assert.equal(exact.truncated, false, '正好到上限不算截断');
  assert.equal(normalizePageRange('1-12', { maxPages: 0 }).pages.length, THREAD_PAGES_MAX, '非法 maxPages 回落默认');
});

await test('贴吧库-23：多页格式化 —— 每页一节、合计长度有硬上界、页数截断要写出来', async () => {
  const entries = [1, 2, 3].map((page) => ({ page, data: parseThreadPage(threadFixturePage(page)) }));
  const text = formatThreadPages(entries);
  assert.match(text, /── 第 1 页 ──/, `多页要有页分隔：${text.slice(0, 120)}`);
  assert.match(text, /── 第 3 页 ──/);
  assert.ok(text.includes('第 61 层正文'), '第 3 页的楼层（fn=61）必须在正文里');
  assert.match(text, /合计 6 层/, '元信息要如实报合计层数');
  assert.match(text, /本次取第 1、2、3 页/);
  // 被页数上限截断的说明由调用方以 notes 传进来，格式化必须原样写出来（不能吞）。
  const noted = formatThreadPages(entries, { notes: ['（请求了 8 页，单次上限 5 页，只取了前 3 页）'] });
  assert.match(noted, /只取了前 3 页/, '截断说明必须出现在正文里');
  // 长度：合计上界是硬保证（5 页满配最坏 80000，必须被砍到 40000 以内并说明）。
  const big = [1, 2, 3, 4, 5].map((page) => ({
    page,
    data: { tid: '11000000002', title: '示例标题'.repeat(20), forumName: '示例吧', replyNum: 999, totalPages: 9, totalPosts: 999,
      posts: Array.from({ length: MAX_POSTS }, (_, i) => ({ floor: (page - 1) * 30 + i + 1, author: '某吧友', time: '2026-10-08', content: '示例正文'.repeat(200) })) }
  }));
  const bigText = formatThreadPages(big);
  assert.ok(bigText.length <= THREAD_PAGES_TEXT_MAX, `必须守住 ${THREAD_PAGES_TEXT_MAX}，实测 ${bigText.length}`);
  assert.match(bigText, /截断/, '被截断时必须说明，不能装作给全了');
  assert.ok(bigText.length > THREAD_TEXT_MAX, '5 页确实能超过单页上界（否则这条多页就没有意义）');
  assert.ok(formatThreadPages(big, { maxChars: 300 }).length <= 300, '上限极小也要守住');
  assert.ok(formatThreadPages(big, { maxChars: 0 }).length <= THREAD_PAGES_TEXT_MAX, '非法上限回落默认值');
  assert.match(formatThreadPages([]), /没有取到任何页面/, '空输入如实说明');
  assert.match(formatThreadPages([{ page: 1, data: { blocked: true } }]), /安全验证/, '被拦话术仍要认得出来');
});

await test('贴吧库-24：多页抓取编排 —— 每页 pn=(N-1)*30、截断/单页失败/被拦/被节流都如实说明', async () => {
  const freeLimiter = () => createTiebaLimiter({ minIntervalMs: 0, maxPerMinute: 1000, cooldownMs: 0 });
  const seen = [];
  const fake = (url, maxChars) => {
    seen.push({ url, maxChars });
    const pn = Number((url.match(/[?&]pn=(\d+)/) ?? [])[1] ?? 0);
    return threadFixturePage(pn / 30 + 1);
  };

  const two = await fetchThreadPages('11000000002', { pages: '1-2', limiter: freeLimiter(), fetchText: fake });
  assert.equal(two.ok, true, JSON.stringify(two));
  assert.deepEqual(two.pages, [1, 2], 'pages 要如实报真正取到的页码');
  assert.equal(two.requestedPageCount, 2);
  assert.equal(two.truncated, false);
  assert.equal(seen.length, 2, '两页就两次请求');
  assert.ok(seen[0].url.includes('kz=11000000002'), seen[0].url);
  assert.ok(!/[?&]pn=/.test(seen[0].url), `第 1 页不该带 pn：${seen[0].url}`);
  assert.ok(seen[1].url.includes('pn=30'), `第 2 页 must pn=30：${seen[1].url}`);
  assert.equal(seen[0].maxChars, 300000, '多页也不能把单页抓取上限改小');
  assert.equal(two.data.posts.length, 4, '两页各 2 层要合并到一起');
  assert.deepEqual(two.data.posts.map((p) => p.floor), [1, 2, 31, 32], '楼层号一律取自页面 fn');
  assert.deepEqual(two.data.pages.map((p) => p.page), [1, 2]);
  assert.match(two.text, /── 第 2 页 ──/);
  assert.match(two.text, /第 31 层正文/);
  assert.equal(two.data.pages[0].posts, 2, '每页层数要如实报');

  const third = await fetchThreadPages('11000000002', { pages: '3', limiter: freeLimiter(), fetchText: fake });
  assert.ok(seen[2].url.includes('pn=60'), `第 3 页 pn=60：${seen[2].url}`);
  assert.deepEqual(third.pages, [3]);
  assert.equal(third.data.posts[0].floor, 61, '第三页的楼层号从 61 起（不是 1）');

  // 上限之内：**9 页必须原样全取**（旧上限是 5，这条证明上限真的放宽到了 10，不是只改了个数字）。
  const nineBefore = seen.length;
  const nine = await fetchThreadPages('11000000002', { pages: '1-9', limiter: freeLimiter(), fetchText: fake });
  assert.equal(seen.length - nineBefore, 9, '9 页就该发 9 次请求');
  assert.deepEqual(nine.pages, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(nine.requestedPageCount, 9);
  assert.equal(nine.truncated, false, '9 页在 10 的上限之内，不许说被截断');
  assert.deepEqual(nine.fetchedPages, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.match(nine.text, /── 第 9 页 ──/, '第 9 页正文必须在');
  assert.match(nine.text, /本次取第 1、2、3、4、5、6、7、8、9 页/);
  assert.ok(!seen.slice(nineBefore).some((s) => /[?&]pn=270/.test(s.url)), '第 10 页（pn=270）没被请求，9 页就只该抓到 pn=240');
  assert.ok(seen[seen.length - 1].url.includes('pn=240'), seen[seen.length - 1].url);

  // 页数上限：请求 12 页只抓 10 页、如实说被截断（requests 只发 10 次，绝不偷偷抓 12 次）。
  const before = seen.length;
  const capped = await fetchThreadPages('11000000002', { pages: '1-12', limiter: freeLimiter(), fetchText: fake });
  assert.equal(seen.length - before, THREAD_PAGES_MAX, `只许抓 ${THREAD_PAGES_MAX} 页`);
  assert.deepEqual(capped.pages, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(capped.requestedPageCount, 12);
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.fetchedPages, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.match(capped.text, /请求了 12 页/, `被截断必须写明：${capped.text.slice(0, 200)}`);
  assert.match(capped.text, /只取了前 10 页/);
  assert.ok(!seen.slice(before).some((s) => /[?&]pn=300/.test(s.url)), '第 11 页（pn=300）绝不该被请求');
  assert.ok(seen[seen.length - 1].url.includes('pn=270'), `第 12 页的请求只该抓到第 10 页（pn=270）：${seen[seen.length - 1].url}`);

  // 某一页失败：其余页照给，失败原因写进文本（部分成功，但不假装全拿到）。
  const flaky = (url, maxChars) => {
    if (/[?&]pn=30/.test(url)) throw new Error('boom-page2');
    return fake(url, maxChars);
  };
  const partial = await fetchThreadPages('11000000002', { pages: '1-2', limiter: freeLimiter(), fetchText: flaky });
  assert.equal(partial.ok, true, '还有页面成功就不该整批失败');
  assert.deepEqual(partial.pages, [1, 2], 'pages 报的是**计划**取的页码，失败页也在里面');
  assert.deepEqual(partial.fetchedPages, [1], 'fetchedPages 才是**真的取到**的页码（与 pages 分开，避免含糊）');
  assert.equal(partial.failures.length, 1);
  assert.match(partial.failures[0], /第 2 页抓取失败.*boom-page2/);
  assert.match(partial.text, /第 2 页抓取失败/, '失败必须出现在正文里');
  assert.equal(partial.data.posts.length, 2, '成功那页的楼层照给');
  assert.deepEqual(two.fetchedPages, [1, 2], '全部成功时 fetchedPages 与 pages 一致');

  // 全部页失败 ⇒ ok:false，并且原因里带着每一页的失败。
  const allBad = await fetchThreadPages('11000000002', { pages: '1-2', limiter: freeLimiter(), fetchText: () => { throw new Error('down'); } });
  assert.equal(allBad.ok, false);
  assert.match(allBad.error, /第 1 页抓取失败/);
  assert.match(allBad.error, /第 2 页抓取失败/);

  // 被拦：停在当页（不再打后面的页），并按被拦处理（降级搜索 + blocked）。
  const blockedSeen = [];
  const searched = [];
  const blockedFetch = (url, maxChars) => {
    blockedSeen.push(url);
    return /[?&]pn=30/.test(url) ? CHALLENGE_FIXTURE : threadFixturePage(1);
  };
  const blocked = await fetchThreadPages('11000000002', {
    pages: '1-3', limiter: freeLimiter(), fetchText: blockedFetch, searchFetch: fakeSearch(searched)
  });
  assert.equal(blocked.ok, true);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.fallback, 'search');
  assert.equal(blockedSeen.length, 2, `第 2 页被拦后不许再打第 3 页：${JSON.stringify(blockedSeen)}`);
  assert.deepEqual(blocked.fetchedPages, [1, 2], '被拦那次：第 1、2 页拿到了，第 3 页没发出去');
  assert.deepEqual(blocked.pages, [1, 2, 3], '计划取的是 1-3 页');
  assert.match(blocked.text, /安全验证/);

  // 被节流：一次贴吧请求都不发，节流标记与冷却话术照旧。
  const lim = createTiebaLimiter({ minIntervalMs: 0, maxPerMinute: 100, cooldownMs: 600000 });
  lim.noteBlocked(1000);
  let fetched = 0;
  const throttled = await fetchThreadPages('11000000002', {
    pages: '1-2', limiter: lim, now: 2000, fetchText: () => { fetched += 1; return threadFixturePage(1); }, searchFetch: fakeSearch([])
  });
  assert.equal(throttled.ok, false);
  assert.equal(throttled.throttled, true);
  assert.equal(fetched, 0, '冷却期内不许发任何贴吧请求');
  assert.match(throttled.error, /冷却中/);
  assert.deepEqual(throttled.pages, [1, 2], '被节流时也要如实报计划取的页码');
  assert.deepEqual(throttled.fetchedPages, [], '被节流时一页都没取到');

  // 坏 tid：与单页一样在发请求前拒绝。
  const badTid = await fetchThreadPages('abc', { pages: '1-2', limiter: freeLimiter(), fetchText: fake });
  assert.equal(badTid.ok, false);
  assert.match(badTid.error, /纯数字/);
});

// ── 11. 楼层图片（t78 切片）：URL 提取（桥接侧）→ 图像内容（MCP 侧）────────────
//
// 真实页面的图片形态（2026-10-08 用本机保存的真实移动版帖子页校准，只记结构不记内容）：
//   · 楼层照片**不在 `<img>` 里**，而在正文的占位容器上：`<span class="wrap pbimgwapper"><div
//     data-class="BDE_Image" class='j_media_thumb_holder img_placeholder' data-url='http://<图床>/…'>`；
//   · 那个 `data-url` 是**图片代理**，真图地址在它的 `src` 查询参数里（URL 编码）——实测代理地址
//     本身取不到图（回的是百度「页面不存在」HTML），`src` 里那个地址才能取到真图字节；
//   · 正文里的 `<img>` 是**站内表情**（`/tb/editor/images/client/image_emoticonNN.png`）与昵称表情，
//     必须排除——实测那一页 4 个候选里 3 个是表情，不过滤就会「吃到的全是表情」。
// 下面的夹具是**自编**的（域名里带 fixture 字样、路径全是编的），不含任何真实图片 URL。

/** 合成一页：楼层 1 有真图（代理形态）、楼层 2 重复同一张、楼层 3 混着表情/懒加载/外站/内网/data 图。 */
const IMAGE_THREAD_FIXTURE = `<html><head><title>第1/4页,回贴列表-示例标题</title></head><body>
<ul id="pblist" class="list">
<li tid="11000000101" data-tid="11000000101" fn="1" data-info="{&quot;floor_num&quot;:1,&quot;name_show&quot;:&quot;示例楼主甲&quot;}" class="list_item post_list_item j_post_list_item"><span class="user_name"><a href="javascript:;" class="user_name">示例楼主甲<img src="https://tb2.bdstatic.com/tb/cms/nickemoji/fixture-nick.png" class="nicknameEmoji"/></a></span><br/><span class="list_item_time">2026-10-08</span><div class="content" lz="1">看图<span class="wrap pbimgwapper" ><div style='height:30px;' data-class="BDE_Image" class='j_media_thumb_holder img_placeholder' data-type='' data-url='http://fixture.gss3.bdstatic.com/fixture-bucket/ab12?wapp&amp;quality=90&amp;di=fixture0123456789abcdef0123456789ab&amp;src=http%3A%2F%2Ffixture.gsp0.baidu.com%2Ffixture-photo-a'></div></span>真好看</div><div class="fr_list 1 j_floor_panel" data-list-count="1"><ul class="flist"><li class="list_item_floor j_list_item_floor"><span class="user_name ">示例楼中楼丙:</span><span class="floor_content">楼中楼里的图不算楼层图<img src="https://imgsa.baidu.com/forum/fixture-sub.png"/></span></li></ul></div></li>
<li tid="11000000102" data-tid="11000000102" fn="2" data-info="{&quot;floor_num&quot;:2,&quot;name_show&quot;:&quot;示例回复乙&quot;}" class="list_item post_list_item j_post_list_item"><span class="user_name"><a href="javascript:;" class="user_name">示例回复乙</a></span><br/><span class="list_item_time">2026-10-07</span><div class="content" lz="0"><span class="wrap pbimgwapper" ><div data-class="BDE_Image" data-url='//fixture.gsp0.baidu.com/fixture-photo-a'></div></span>同一个地址要去重（协议相对写法）</div></li>
<li tid="11000000103" data-tid="11000000103" fn="3" data-info="{&quot;floor_num&quot;:3,&quot;name_show&quot;:&quot;示例回复丁&quot;}" class="list_item post_list_item j_post_list_item"><span class="user_name"><a href="javascript:;" class="user_name">示例回复丁</a></span><br/><span class="list_item_time">2026-10-06</span><div class="content" lz="0">纯表情<img src="//tb2.bdstatic.com/tb/editor/images/client/image_emoticon25.png"/>懒加载真图<img src="//imgsa.baidu.com/forum/fixture-thumb.png" data-original="//imgsa.baidu.com/forum/fixture-b-original.png"/>外站图<img src="https://evil.test/fixture-c.png"/>内网图<img src="http://127.0.0.1/fixture-d.png"/>data 图<img src="data:image/png;base64,AAAA"/>代理 src 不合规时退回代理本身<span class="wrap pbimgwapper"><div data-class="BDE_Image" data-url='http://fixture.gss3.bdstatic.com/fixture-bucket/cd34?src=https%3A%2F%2Fevil.test%2Ffixture-e.png'></div></span></div></li>
</ul>
<script>$(function(){ F.use('x', function(){ new pbSlideImage({ conf:{ 'kz': "11000000002", 'word': "示例吧", 'page' : {"req_num":30,"page_size":30,"current_page":1,"total_page":4,"total_num":120} } }); }); });</script>
</body></html>`;

await test('贴吧库-25：图片 URL 提取 —— 认代理 src、排除站内表情/外站/内网、去重、上限不静默', async () => {
  const { urls, found } = extractImageUrls(IMAGE_THREAD_FIXTURE);
  assert.deepEqual(urls, [
    'https://fixture.gsp0.baidu.com/fixture-photo-a',
    'https://imgsa.baidu.com/forum/fixture-b-original.png',
    'https://fixture.gss3.bdstatic.com/fixture-bucket/cd34?src=https%3A%2F%2Fevil.test%2Ffixture-e.png'
  ], `★代理形态要取 src 里的真图地址；src 不合规才退回代理本身：${JSON.stringify(urls)}`);
  assert.equal(found, 3);
  // 代理地址本身（gss3）取不到图，必须换成人话里那个可取的 src 地址（实测代理 404）。
  assert.ok(urls[0].startsWith('https://fixture.gsp0.baidu.com/'), '有 src 时必须优先用 src 里的真图地址');
  assert.ok(!urls.some((u) => u.startsWith('https://fixture.gss3.bdstatic.com/fixture-bucket/ab12')), '不该把取不到的代理地址交出去');
  assert.ok(urls.some((u) => u.includes('fixture-bucket/cd34')), 'src 指向外站（不合规）时退回代理地址本身，而不是丢掉整张图');
  // 站内表情（/tb/ 目录）绝不能被当成楼层图——这是实测踩出来的坑。
  assert.ok(!urls.some((u) => u.includes('/tb/')), `站内表情/昵称表情必须排除：${JSON.stringify(urls)}`);
  assert.ok(!urls.some((u) => /image_emoticon|nickemoji|nickname/i.test(u)), '表情与昵称表情必须排除');
  // 楼中楼里的图不算楼层图（只扫 div.content）。
  assert.ok(!urls.some((u) => u.includes('fixture-sub')), '楼中楼（floor_content）里的图不该被算成楼层图');
  // 懒加载优先取 data-original，而不是缩略图 src。
  assert.ok(urls.some((u) => u.endsWith('fixture-b-original.png')), 'data-original 优先于 src');
  assert.ok(!urls.some((u) => u.endsWith('fixture-thumb.png')), '有 data-original 时不该退回缩略图 src');
  // 外站 / 内网 / data: 一律不收（SSRF 的纵深防御）。
  assert.ok(!urls.some((u) => /evil\.test\/fixture-c|127\.0\.0\.1|^data:/.test(u)), `外站/内网/data: 必须排除：${JSON.stringify(urls)}`);

  // 上限：**截断但不静默**（found 留住「一共认出几张」）。
  const capped = extractImageUrls(IMAGE_THREAD_FIXTURE, { max: 1 });
  assert.equal(capped.urls.length, 1);
  assert.equal(capped.found, 3, 'found 必须如实报总数，否则下游无法说明"还有几张未取"');
  assert.equal(extractImageUrls(IMAGE_THREAD_FIXTURE, { max: 0 }).urls.length, 3, '非法 max 回落默认值');
  assert.ok(extractImageUrls(IMAGE_THREAD_FIXTURE).urls.length <= TIEBA_IMAGE_MAX_URLS);
  // 候选上限放宽到 40（用户确认的最终值：喂模型 10 张，过滤掉表情后还要够用）：
  // 45 个白名单图床地址 ⇒ 只给前 40 个，`found` 仍如实报 45。
  assert.equal(TIEBA_IMAGE_MAX_URLS, 40, '候选上限必须是 40');
  const capHtml = `<div class="content">${Array.from({ length: 45 }, (_, i) =>
    `<div data-class="BDE_Image" data-url="https://imgsa.baidu.com/forum/fixture-cap-${i}.png"></div>`).join('')}</div>`;
  const capUrls = extractImageUrls(capHtml);
  assert.equal(capUrls.urls.length, 40, `候选上限 40：实际 ${capUrls.urls.length}`);
  assert.equal(capUrls.found, 45, 'found 要如实报 45，下游才能说明「还有 5 张因候选上限未取」');
  assert.ok(capUrls.urls.every((u) => u.startsWith('https://imgsa.baidu.com/forum/fixture-cap-')), '顺序与内容不许乱');

  // 畸形输入永不抛。
  for (const junk of ['', null, undefined, '<div>没有正文容器</div>', '<div class="content">没有图</div>', '<img src=', '<div class="content">'.repeat(500)]) {
    const r = extractImageUrls(junk);
    assert.ok(Array.isArray(r.urls), 'urls 永远是数组');
    assert.equal(r.urls.length, 0, `不该从畸形输入里编出图片：${String(junk).slice(0, 40)}`);
    assert.equal(r.found, 0);
  }
  // 图床白名单是后缀匹配（子域也算），别把 evil-baidu.com 这种放进来。
  assert.equal(isTiebaImageHost('imgsa.baidu.com'), true);
  assert.equal(isTiebaImageHost('fixture.gss3.bdstatic.com'), true);
  assert.equal(isTiebaImageHost('tiebapic.cdn.bcebos.com'), true);
  assert.equal(isTiebaImageHost('evil-baidu.com'), false);
  assert.equal(isTiebaImageHost('baidu.com.evil.test'), false);
  assert.equal(isTiebaImageHost(''), false);
});

await test('贴吧库-26：图片随抓取返回 —— 单页 images/imagesFound；多页跨页去重合并', async () => {
  const freeLimiter = () => createTiebaLimiter({ minIntervalMs: 0, maxPerMinute: 1000, cooldownMs: 0 });
  const single = await fetchThreadPage('11000000002', 1, { limiter: freeLimiter(), fetchText: () => IMAGE_THREAD_FIXTURE });
  assert.equal(single.ok, true);
  assert.deepEqual(single.images, [
    'https://fixture.gsp0.baidu.com/fixture-photo-a',
    'https://imgsa.baidu.com/forum/fixture-b-original.png',
    'https://fixture.gss3.bdstatic.com/fixture-bucket/cd34?src=https%3A%2F%2Fevil.test%2Ffixture-e.png'
  ], '单页抓取要把图片 URL 带出来（桥接只给 URL，不下载）');
  assert.equal(single.imagesFound, 3);
  assert.match(single.text, /看图/, '图片不影响正文解析');
  // t79：图片 URL **逐行清单**必须进格式化文本 —— 这是模型唯一能看到地址的地方
  // （结构化字段 images 只在桥接↔MCP 之间流动），少了它模型就没法用 qq_send_image 把图转手发出去。
  assert.match(single.text, /（楼层图片地址，可直接用 qq_send_image\(url=…\) 发出）：/, `文本里要有地址清单标题：${single.text.split('\n').slice(0, 5).join(' | ')}`);
  for (let i = 0; i < single.images.length; i += 1) {
    assert.ok(
      single.text.includes(`- 图${i + 1}: ${single.images[i]}`),
      `第 ${i + 1} 张地址要原样（不截断）出现在文本里：${single.images[i]}`
    );
  }

  // 多页：第 1 页有 A、第 2 页有 A（重复）与 B ⇒ 合并去重后是 [A, B]，且 imagesFound 如实累加。
  const pageWith = (page, body) => `<html><head><title>第${page}/4页,回贴列表-示例标题</title></head><body><ul>
<li tid="9${page}" data-tid="9${page}" fn="${(page - 1) * 30 + 1}" data-info="{&quot;floor_num&quot;:${(page - 1) * 30 + 1},&quot;name_show&quot;:&quot;示例用户&quot;}" class="list_item post_list_item j_post_list_item"><span class="user_name"><a class="user_name">示例用户</a></span><div class="content" lz="0">${body}</div></li>
</ul></body></html>`;
  const holder = (url) => `<span class="wrap pbimgwapper"><div data-class="BDE_Image" data-url="${url}"></div></span>`;
  const multi = await fetchThreadPages('11000000002', {
    pages: '1-2',
    limiter: freeLimiter(),
    fetchText: (url) => (/[?&]pn=30/.test(url)
      ? pageWith(2, `${holder('http://fixture.gss3.bdstatic.com/fixture-photo-a')}${holder('http://fixture.gss3.bdstatic.com/fixture-photo-b')}`)
      : pageWith(1, holder('http://fixture.gss3.bdstatic.com/fixture-photo-a')))
  });
  assert.equal(multi.ok, true);
  assert.deepEqual(multi.images, [
    'https://fixture.gss3.bdstatic.com/fixture-photo-a',
    'https://fixture.gss3.bdstatic.com/fixture-photo-b'
  ], `多页图片要跨页去重合并：${JSON.stringify(multi.images)}`);
  assert.equal(multi.imagesFound, 3, '第 1 页 1 张 + 第 2 页 2 张 = 认出 3 张（去重只影响 urls）');
  assert.deepEqual(multi.data.images, multi.images, 'data.images 与顶层 images 必须一致');
  // 多页的地址清单用**跨页去重后的并集**，且去重掉的那条不会再出现一次。
  assert.ok(multi.text.includes(`- 图1: ${multi.images[0]}`) && multi.text.includes(`- 图2: ${multi.images[1]}`),
    `多页文本要列出合并后的两张地址：${multi.text.split('\n').slice(0, 6).join(' | ')}`);
  assert.ok(!multi.text.includes('- 图3:'), '跨页去重后的重复地址不该被列第二次');
});

// MCP 侧（`qq_tieba_read`）的图片管线：用**假下载器**驱动，证明 URL → 图像内容、以及
// 数量/体积上限与失败标注都生效。
//
// 分两层测，因为「下载」必须真的发生在 MCP 进程里、而离线又不能联网：
//   ① 直接测 MCP 调用的那个函数 `buildTiebaImageContent`（注入假下载器，真实逻辑全跑）；
//   ② 用 vm 夹具跑**真实的 MCP 工具回调**，证明它确实把桥接给的 `images` 交给构建器、
//      并把内容与说明拼进返回（vm 夹具照搬 test-audit-security-mcp.mjs 的既有范式：
//      去掉 import、把 `import('./tieba-lib.js')` 换成注入的假模块、不启动真 stdio server）。

await test('贴吧库-27：MCP 侧把图片 URL 变成图像内容 —— 假下载器驱动，上限与失败都如实标注', async () => {
  const urlA = 'https://fixture.gss3.bdstatic.com/fixture-photo-a';
  const urlB = 'https://imgsa.baidu.com/forum/fixture-photo-b.png';

  // ① 正常：两张图 → 两个 image 内容 + 文字里逐张结论。
  const calls = [];
  const ok = await buildTiebaImageContent([urlA, urlB], {
    fetchBuffer: async (url, maxBytes, opts) => {
      calls.push({ url, maxBytes, opts });
      return { buffer: fixturePng(calls.length), statusCode: 200 };
    }
  });
  assert.equal(ok.content.length, 2);
  assert.equal(ok.notes.length, 2, JSON.stringify(ok.notes));
  assert.deepEqual(ok.content.map((c) => c.type), ['image', 'image']);
  assert.deepEqual(ok.content.map((c) => c.mimeType), ['image/png', 'image/png']);
  assert.equal(Buffer.from(ok.content[0].data, 'base64').toString('hex'), fixturePng(1).toString('hex'), 'data 必须是原字节的 base64');
  assert.deepEqual(ok.notes, ['[图片1]', '[图片2]']);
  // 下载参数：单张上限、referer（图床不带 referer 会 403）与移动版 UA。
  assert.equal(calls.length, 2);
  assert.equal(calls[0].maxBytes, TIEBA_IMAGE_BYTES_MAX);
  assert.equal(calls[0].opts?.headers?.referer, 'https://tieba.baidu.com/');
  assert.equal(calls[0].opts?.headers?.['user-agent'], TIEBA_MOBILE_UA);
  assert.deepEqual(Object.keys(calls[0].opts?.headers ?? {}).sort(), ['referer', 'user-agent']);

  // ② 数量上限：12 个 URL 只下 10 个，且**如实说明**还有 2 张没取（上限是用户确认的 10 张）。
  //    每张给**不同**字节（真实世界里不同地址就是不同照片；字节完全相同会被判成占位图，见 32）。
  const six = [1, 2, 3, 4, 5, 6].map((i) => `https://imgsa.baidu.com/forum/fixture-${i}.png`);
  const twelve = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => `https://imgsa.baidu.com/forum/fixture-${i}.png`);
  const manyCalls = [];
  let manySeed = 0;
  const many = await buildTiebaImageContent(twelve, {
    fetchBuffer: async (url) => { manyCalls.push(url); manySeed += 1; return { buffer: fixturePng(manySeed), statusCode: 200 }; }
  });
  assert.equal(TIEBA_IMAGE_MAX, 10, '喂模型的张数上限是 10');
  assert.equal(manyCalls.length, TIEBA_IMAGE_MAX, `一次最多下 ${TIEBA_IMAGE_MAX} 张`);
  assert.equal(many.content.length, TIEBA_IMAGE_MAX);
  assert.equal(many.notes.at(-1), `（另有 2 张图片因数量上限（一次最多 ${TIEBA_IMAGE_MAX} 张）未取）`);

  // ③ 体积超限与下载失败：逐张写清原因，绝不假装取到了。
  const fail = await buildTiebaImageContent([six[0], six[1], six[2]], {
    fetchBuffer: async (url) => {
      if (url === six[0]) throw new Error(`图片超过大小限制（${TIEBA_IMAGE_BYTES_MAX} 字节）`);
      if (url === six[1]) throw new Error('fixture: 图床 403');
      return { buffer: fixturePng(3), statusCode: 200 };
    }
  });
  assert.deepEqual(fail.notes, [
    '[图片1：因体积超限未取（单张上限 4MiB）]',
    '[图片2：获取失败：fixture: 图床 403]',
    '[图片3]'
  ], JSON.stringify(fail.notes));
  assert.equal(fail.content.length, 1, '只有成功那张进 content');

  // ④ 非 http(s) 条目直接忽略：不计入数量上限、也不发请求。
  let downloads = 0;
  const none = await buildTiebaImageContent(['not-a-url', 'data:image/png;base64,AAAA', null], {
    fetchBuffer: async () => { downloads += 1; return { buffer: fixturePng(1), statusCode: 200 }; }
  });
  assert.equal(downloads, 0, '非 http(s) 地址不许发起下载');
  assert.deepEqual(none, { content: [], notes: [] });
  assert.deepEqual(await buildTiebaImageContent([]), { content: [], notes: [] }, '空输入不抛');
  assert.deepEqual(await buildTiebaImageContent(null), { content: [], notes: [] }, 'null 也不抛');

  // ⑤ 自定义上限要生效（可注入 ⇒ 上限不是写死的）。
  const custom = await buildTiebaImageContent(six, {
    maxImages: 1,
    maxBytes: 1024,
    fetchBuffer: async (url, maxBytes) => { assert.equal(maxBytes, 1024); return { buffer: fixturePng(5), statusCode: 200 }; }
  });
  assert.equal(custom.content.length, 1);
  assert.match(custom.notes.at(-1), /另有 5 张图片因数量上限（一次最多 1 张）未取/);

  // ⑥ 合计体积上限（25MiB）：每张 3MiB（>2.5MiB）——第 10 张下载前累计已 27MiB ≥ 25MiB ⇒ 停止下载后续，
  //    并把「已取几张」「因总量上限跳过几张」**如实写进返回文字**（静默少给正是这张切片要防的事）。
  //    这里先把数量上限放宽到 20，单独验总量那一条。
  assert.equal(TIEBA_IMAGE_TOTAL_BYTES_MAX, 25 * 1024 * 1024, '合计上限是 25MiB');
  const bulk = Array.from({ length: 12 }, (_, i) => `https://imgsa.baidu.com/forum/fixture-bulk-${i}.png`);
  // 每张 3MiB、**字节各不相同**（不同地址 = 不同照片；字节相同会被判成占位图，见 32）。
  const threeMiB = (seed) => Buffer.alloc(3 * 1024 * 1024, seed);
  const bulkCalls = [];
  const bulkResult = await buildTiebaImageContent(bulk, {
    maxImages: 20,
    fetchBuffer: async (url) => { bulkCalls.push(url); return { buffer: threeMiB(7 + bulkCalls.length), statusCode: 200 }; }
  });
  assert.equal(bulkCalls.length, 9, `3MiB×9=27MiB 已到 25MiB，第 10 张不该再下：实际下了 ${bulkCalls.length} 张`);
  assert.equal(bulkResult.content.length, 9, '已取的 9 张照给（到顶不是丢已取到的）');
  assert.equal(bulkResult.notes.filter((n) => n.startsWith('[图片')).length, 9);
  assert.equal(bulkResult.notes.at(-1), '（本次已取 9 张；另有 3 张图片因总量上限（一次最多 25MiB）未取）', JSON.stringify(bulkResult.notes));
  // 「停止下载」= 不再发请求，而不是下了再丢。
  assert.ok(!bulkCalls.some((u) => /fixture-bulk-(9|10|11)\.png$/.test(u)), '到顶后不许再发下载请求');
  // 上限可注入（不是写死的）：小到 12 字节时第一张就到顶 ⇒ 只取 1 张、跳过 5 张也要写清楚。
  const tinyCalls = [];
  const tinyResult = await buildTiebaImageContent(six, {
    maxTotalBytes: 12,
    fetchBuffer: async (url) => { tinyCalls.push(url); return { buffer: fixturePng(1), statusCode: 200 }; }
  });
  assert.equal(tinyCalls.length, 1);
  assert.equal(tinyResult.content.length, 1);
  assert.equal(tinyResult.notes.at(-1), '（本次已取 1 张；另有 5 张图片因总量上限（一次最多 1MiB）未取）', JSON.stringify(tinyResult.notes));
});

await test('贴吧库-28：MCP 工具把桥接的 images 交给构建器，并把图像内容与说明一起返回', async () => {
  const urlA = 'https://fixture.gss3.bdstatic.com/fixture-photo-a';
  const urlB = 'https://imgsa.baidu.com/forum/fixture-photo-b.png';
  const seen = [];
  const callTool = loadTiebaReadTool({
    bridgeResponse: { ok: true, text: '【贴吧帖子】正文（fixture）', images: [urlA, urlB], imagesFound: 7 },
    // vm 里没有模块解析：把 `import('./tieba-lib.js')` 换成这个假模块，断言真实回调的接线。
    imageModule: {
      buildTiebaImageContent: async (urls) => {
        seen.push(urls);
        return {
          content: [{ type: 'image', mimeType: 'image/png', data: 'Zml4dHVyZQ==' }],
          notes: ['[图片1]', '[图片2：获取失败：fixture: 图床 403]']
        };
      }
    }
  });
  const result = await callTool({});
  assert.deepEqual(seen, [[urlA, urlB]], 'MCP 必须把桥接给的 images 原样交给构建器');
  assert.deepEqual(callTool.timeouts, [80000], '不传 pages ⇒ 单页预算 80 秒（自适应超时的基准点）');
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 2, '1 段文字 + 1 张图（构建器只给了一张）');
  assert.equal(result.content[1].type, 'image');
  assert.equal(result.content[1].mimeType, 'image/png');
  const text = result.content[0].text;
  assert.match(text, /本次楼层图片（页面里共认出 7 张）/, `总数要用桥接给的 imagesFound：${text}`);
  assert.match(text, /\[图片1\]/);
  assert.match(text, /\[图片2：获取失败：fixture: 图床 403\]/, '失败标注必须原样带给模型');
  assert.match(text, /【贴吧帖子】正文（fixture）/, '桥接写好的正文仍要原样保留');

  // 桥接没给 images（老响应/无图）：不发下载、如实说明「没有图片」。
  let built = 0;
  const noImages = loadTiebaReadTool({
    bridgeResponse: { ok: true, text: '正文' },
    imageModule: { buildTiebaImageContent: async () => { built += 1; return { content: [], notes: [] }; } }
  });
  const noImagesResult = await noImages({});
  assert.equal(built, 0, '没有图片就不该调构建器');
  assert.equal(noImagesResult.content.length, 1);
  assert.match(noImagesResult.content[0].text, /没有楼层图片/);

  // 图片模块加载失败（夹具里没有那个文件/被裁剪）：如实说明，且**不把整个工具判失败**——正文仍有价值。
  const broken = loadTiebaReadTool({ bridgeResponse: { ok: true, text: '正文', images: [urlA] }, imageModule: null });
  const brokenResult = await broken({});
  assert.equal(brokenResult.isError, undefined, '图片取不到不该让读帖整体失败');
  assert.match(brokenResult.content[0].text, /图片模块不可用，本次未取图/, brokenResult.content[0].text);
  assert.equal(brokenResult.content.length, 1);
});

// 自适应调用超时（`timeoutMs = 60000 + 20000 × 计划页数`）：
// 「计划页数」由 **tieba-lib 的 `normalizePageRange`** 算（MCP 里没有第二份页码范围解析），
// 所以这里把真函数注进 vm 夹具的假模块，断言的是**真实回调**确实发出去的那个毫秒数
// （`AbortSignal.timeout(ms)` 是它唯一落地的地方）。期望值全写成字面量，避免测试里再抄一份公式。
await test('贴吧库-29：MCP 调用超时按计划页数自适应（单页 80s、5 页 160s、10 页 260s）', async () => {
  const timedTool = () => loadTiebaReadTool({
    bridgeResponse: { ok: true, text: '正文' },
    imageModule: { normalizePageRange, buildTiebaImageContent: async () => ({ content: [], notes: [] }) }
  });

  const noPages = timedTool();
  await noPages({});
  assert.deepEqual(noPages.timeouts, [80000], '不传 pages ⇒ 60s + 20s×1 = 80 秒');

  const onePage = timedTool();
  await onePage({ pages: '1' });
  assert.deepEqual(onePage.timeouts, [80000], '单页 ⇒ 80 秒');

  const fivePages = timedTool();
  await fivePages({ pages: '1-5' });
  assert.deepEqual(fivePages.timeouts, [160000], '5 页 ⇒ 60s + 20s×5 = 160 秒');

  const tenPages = timedTool();
  await tenPages({ pages: '1-10' });
  assert.deepEqual(tenPages.timeouts, [260000], '10 页 ⇒ 60s + 20s×10 = 260 秒');

  // 12 页：桥接只会抓 10 页（页数上限），超时按**计划**的 10 页算——与真正会发生的抓取一致。
  const cappedPages = timedTool();
  await cappedPages({ pages: '1-12' });
  assert.deepEqual(cappedPages.timeouts, [260000], '12 页被截断成计划 10 页 ⇒ 仍是 260 秒');

  // 模块不可用（算不出计划页数）：退回单页预算，绝不因为超时算不出来让读帖失败。
  const noModule = loadTiebaReadTool({ bridgeResponse: { ok: true, text: '正文' }, imageModule: null });
  const noModuleResult = await noModule({ pages: '1-10' });
  assert.deepEqual(noModule.timeouts, [80000], '模块不可用时退回单页预算');
  assert.equal(noModuleResult.isError, undefined);
  assert.match(noModuleResult.content[0].text, /正文/);
});

// 文案也是「上限」的一部分：模型只读得到描述，描述里还写 5 页/4 张就等于上限没改。
await test('贴吧库-30：qq_tieba_read 的描述文案跟着新上限走（10 页 / 10 张 / 合计 25MiB）', async () => {
  const tool = loadTiebaReadTool({ bridgeResponse: { ok: true, text: '正文' }, imageModule: null });
  assert.match(tool.description, /一次最多 10 页/, '工具描述必须写 10 页');
  assert.ok(!/一次最多 5 页/.test(tool.description), '不许留下旧上限 5 页');
  assert.match(tool.description, /一次最多 10 张/, '工具描述必须写 10 张图');
  assert.ok(!/一次最多 4 张/.test(tool.description), '不许留下旧张数 4 张');
  assert.match(tool.description, /合计 ≤25MiB/, '工具描述必须写合计 25MiB');
  assert.match(tool.pagesDescription, /一次最多 10 页/, 'pages 参数描述也要写 10 页');
  assert.ok(!/最多 5 页/.test(tool.pagesDescription), 'pages 参数描述不许留下旧上限 5 页');
});

// ── 12. 占位图（t79 切片）：**绝不返回占位图** ──────────────────────────────
//
// 用户实测反馈（真实帖 tid=8806513836，第 1~3 页）：`extractImageUrls` 认出一堆地址，
// `buildTiebaImageContent` 下了 10 张，**全是同一张 238×238「贴」占位图标**。
//
// 本机复现（2026-10-08，cookie + 完整移动版 UA，逐张真下载）定性如下——**上一轮的结论是反的**：
//   · 楼层照片的 `data-url` 是**带签名的缩略图**：`/forum/w%3D250%3Bq%3D100%3Bg%3D0/sign=<md5>/<hash>.jpg?tbpicau=…&src=…`，
//     它**自己就能取到真图**：13 个不同 hash → 13 个各不相同的 JPEG（4056 / 6238 / 68128 / 88216 / 469751 …字节）；
//   · 它的 `src` 参数（上一轮当成「真图」的那个）是**未签名的原图路径** `…/forum/pic/item/<hash>.jpg`，
//     匿名取回的是**同一张 4262 字节 JPEG**（13 个不同 hash 字节完全相同，sha1 一致）=「贴」占位图标；
//   · 所以「URL 上去重拦不住」不是懒加载，而是**把占位地址当真图地址交出去了**；
//   · 另外一张 `<img>`（`gss3…/timg?…&src=…` 图片代理）地址本身回的是百度「页面不存在」HTML（19825 字节），
//     真图在它的 `src` 里——所以「有 src 就用 src」对**其它**代理仍然是对的。
//
// 两道防线（夹具全部是自编的合成地址，不含任何真实图片 URL）：
//   ① 桥接侧（URL 特征）：`isPlaceholderImageUrl` 把未签名原图路径判为占位形态，**不交给下游**，
//      但如实计数，由 `imageExtractNotes` 写进正文；
//   ② MCP 侧（实测字节特征）：不同地址取回**字节完全相同**的内容 ⇒ 同一张服务端占位图 ⇒ **整组丢弃**。
//      判据刻意**不是**「文件小于阈值」：同一页里那张 4056 字节的真图比 4262 字节的占位图还小。

/** 合成一个**签名缩略图**地址（真图来源形态；主机/路径/签名全是编的）。 */
const signedThumbUrl = (hash, sign) =>
  `http://fixture.gss3.bdstatic.com/forum/w%3D250%3Bq%3D100%3Bg%3D0/sign=${sign}/${hash}.jpg`
  + `?tbpicau=2026-01-01-00_fixture&amp;src=http%3A%2F%2Ffixture.gss3.bdstatic.com%2Fforum%2Fpic%2Fitem%2F${hash}.jpg`;

/** 合成一个**未签名原图**地址（占位形态；匿名取回的是同一张「贴」图标）。 */
const unsignedItemUrl = (hash) => `http://fixture.gss3.bdstatic.com/forum/pic/item/${hash}.jpg`;

/** 合成一页：楼层 1 的正文里挂着若干图片占位容器。 */
const imagePageFixture = (holders) => `<html><head><title>第1/4页,回贴列表-示例标题</title></head><body><ul id="pblist" class="list">
<li tid="11000000201" data-tid="11000000201" fn="1" data-info="{&quot;floor_num&quot;:1,&quot;name_show&quot;:&quot;示例楼主甲&quot;}" class="list_item post_list_item j_post_list_item"><span class="user_name"><a href="javascript:;" class="user_name">示例楼主甲</a></span><br/><span class="list_item_time">2026-10-08</span><div class="content" lz="1">看图${holders}</div></li>
</ul></body></html>`;

/** 正文里的图片占位容器（真实形态：没有 `<img>`，地址在 data-url 上）。 */
const imageHolder = (url) =>
  `<span class="wrap pbimgwapper"><div style='height:30px;' data-class="BDE_Image" class='j_media_thumb_holder img_placeholder' data-url='${url}'></div></span>`;

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const SIGN_A = 'f'.repeat(32);

await test('贴吧库-31：占位地址（URL 特征）——签名缩略图优先用地址本身；未签名原图路径不交出去但如实计数', async () => {
  // ── ① 签名缩略图：★核心修正——必须用**地址本身**，不能用它 src 参数里的未签名原图地址。
  const signedOnly = extractImageUrls(imagePageFixture(imageHolder(signedThumbUrl(HASH_A, SIGN_A))));
  assert.equal(signedOnly.urls.length, 1, JSON.stringify(signedOnly));
  assert.ok(signedOnly.urls[0].includes('/sign='), `必须保留签名地址本身：${signedOnly.urls[0]}`);
  assert.ok(signedOnly.urls[0].includes('forum/pic/item/') === false, `绝不能退回 src 里那个未签名原图地址（实测是占位图标）：${signedOnly.urls[0]}`);
  assert.ok(signedOnly.urls[0].startsWith('https://'), 'http 要升级成 https');
  assert.equal(signedOnly.found, 1);
  assert.equal(signedOnly.placeholders, 0, '签名地址不是占位形态');

  // ── ② 未签名原图路径：URL 特征判定为占位形态（+ 白名单/畸形输入的边界）。
  assert.equal(isPlaceholderImageUrl(`https://fixture.gss3.bdstatic.com/forum/pic/item/${HASH_A}.jpg`), true);
  assert.equal(isPlaceholderImageUrl(`//fixture.gss3.bdstatic.com/forum/pic/item/${HASH_A}.jpg`), true, '协议相对写法也要认');
  assert.equal(isPlaceholderImageUrl(signedThumbUrl(HASH_A, SIGN_A).replace(/&amp;/g, '&')), false, '带签名段的地址不是占位形态');
  assert.equal(isPlaceholderImageUrl(`https://evil.test/forum/pic/item/${HASH_A}.jpg`), false, '非图床白名单不参与这条判定');
  assert.equal(isPlaceholderImageUrl(`https://imgsa.baidu.com/forum/w%3D580/fixture-x.jpg`), false, '普通可取的图床地址不是占位形态');
  for (const junk of ['', null, undefined, 'not-a-url', 'data:image/png;base64,AAAA']) {
    assert.equal(isPlaceholderImageUrl(junk), false, `畸形输入不抛、也不误判：${String(junk)}`);
  }

  // ── ③ 整页只有占位地址 ⇒ images 为空 + 正文写明「未取到真图」（本次修复的核心用例之一）。
  const onlyPlaceholders = imagePageFixture(
    [HASH_A, HASH_B, 'c'.repeat(40)].map((h) => imageHolder(unsignedItemUrl(h))).join('')
  );
  const extracted = extractImageUrls(onlyPlaceholders);
  assert.deepEqual(extracted.urls, [], `占位地址绝不交出去：${JSON.stringify(extracted)}`);
  assert.equal(extracted.found, 0);
  assert.equal(extracted.placeholders, 3, '丢掉了多少必须如实计数');
  const freeLimiter = () => createTiebaLimiter({ minIntervalMs: 0, maxPerMinute: 1000, cooldownMs: 0 });
  const thread = await fetchThreadPage('11000000201', 1, { limiter: freeLimiter(), fetchText: () => onlyPlaceholders });
  assert.equal(thread.ok, true);
  assert.deepEqual(thread.images, [], '★全是占位图时 images 必须为空，而不是给一堆占位地址');
  assert.equal(thread.imagesFound, 0);
  assert.match(thread.text, /楼层图片/, `正文必须说明图片状态：${thread.text.split('\n')[1]}`);
  assert.match(thread.text, /占位/, '要写明是占位地址');
  assert.match(thread.text, /未取到真图/, '要写明本次没取到真图');
  assert.match(thread.text, /3 个/, '占位地址个数要如实写出来');

  // ── ④ 混合（真图 + 占位）⇒ 只给真图，并如实说明跳过了几个占位地址。
  const mixedPage = imagePageFixture(
    imageHolder(signedThumbUrl(HASH_A, SIGN_A))
    + imageHolder(unsignedItemUrl(HASH_B))
    + imageHolder(unsignedItemUrl('d'.repeat(40)))
  );
  const mixed = await fetchThreadPage('11000000201', 1, { limiter: freeLimiter(), fetchText: () => mixedPage });
  assert.equal(mixed.images.length, 1, JSON.stringify(mixed.images));
  assert.ok(mixed.images[0].includes('/sign='), '留下的必须是那张真图地址');
  const mixedExtract = extractImageUrls(mixedPage);
  assert.equal(mixedExtract.placeholders, 2);
  assert.match(mixed.text, /另有 2 个占位地址/, `要说明跳过了几个：${mixed.text.split('\n')[1]}`);

  // ── ⑤ 多页：占位计数跨页累加，说明照旧出现在（合计长度的）正文里。
  const multi = await fetchThreadPages('11000000201', {
    pages: '1-2',
    limiter: freeLimiter(),
    fetchText: () => imagePageFixture(imageHolder(unsignedItemUrl(HASH_A)))
  });
  assert.equal(multi.ok, true);
  assert.deepEqual(multi.images, [], '多页也绝不交占位地址');
  assert.equal(multi.data.imagesPlaceholders, 2, '两页各 1 个占位地址，合计要如实累加');
  assert.match(multi.text, /2 个服务端占位地址/, multi.text.split('\n')[1]);

  // ── ⑥ 站内表情排除不能退化：签名缩略图与表情（/tb/ 静态资源 + timg 代理）混在一起时，只留真图。
  const withEmoticon = imagePageFixture(
    imageHolder(signedThumbUrl(HASH_A, SIGN_A))
    + '<img src="//tb2.bdstatic.com/tb/editor/images/client/image_emoticon25.png"/>'
    + '<img src="//gss3.bdstatic.com/84oSdTum2Q5BphGlnYG/timg?image&amp;quality=80&amp;src=http%3A%2F%2Ftb2.bdstatic.com%2Ftb%2Feditor%2Fimages%2Fclient%2Fimage_emoticon3.png"/>'
    + '<img src="//tb1.bdstatic.com/tb/cms/nickemoji/1-2.png" class="nicknameEmoji"/>'
  );
  const emoticonExtract = extractImageUrls(withEmoticon);
  assert.deepEqual(emoticonExtract.urls.length, 1, `表情/头像绝不能被当成楼层图：${JSON.stringify(emoticonExtract.urls)}`);
  assert.ok(!emoticonExtract.urls.some((u) => /image_emoticon|nickemoji|\/tb\//.test(u)), '表情与昵称表情必须排除');
});

await test('贴吧库-32：MCP 侧字节级占位判定 —— 全是占位 ⇒ content 为空 + 明确文案；混合 ⇒ 只留真图；字节相同 ⇒ 全部丢弃', async () => {
  const u = (i) => `https://imgsa.baidu.com/forum/fixture-placeholder-${i}.png`;
  const urls3 = [u(1), u(2), u(3)];
  /** 那张「贴」占位图标（合成字节：与真实图标的字节数无关，判定只看「不同地址字节相同」）。 */
  const iconBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0x99, 0x99]);

  // ── ① 全是占位图（**本次的核心用例**）：3 个不同地址回同一份字节 ⇒ content 为空 + 明确文案。
  const allPlaceholder = await buildTiebaImageContent(urls3, {
    fetchBuffer: async () => ({ buffer: iconBytes, statusCode: 200 })
  });
  assert.deepEqual(allPlaceholder.content, [], '★宁可 images 为空，也不要给占位图');
  assert.equal(allPlaceholder.notes.filter((n) => n.startsWith('[图片') && n.includes('服务端占位图')).length, 3, `逐张都要标注：${JSON.stringify(allPlaceholder.notes)}`);
  assert.match(allPlaceholder.notes.at(-1), /全部是同一张服务端占位图/, JSON.stringify(allPlaceholder.notes));
  assert.match(allPlaceholder.notes.at(-1), /未取到真图/, '文案要明确说本次没取到真图');
  assert.ok(!allPlaceholder.notes.some((n) => n === '[图片1]'), '不许把占位图当成功结果标注');

  // ── ② 混合（部分真图 + 部分占位）：两张字节相同的占位图被丢弃，真图照给，并如实说明跳过了几张。
  const realBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const mixed = await buildTiebaImageContent(urls3, {
    fetchBuffer: async (url) => ({ buffer: url === urls3[2] ? realBytes : iconBytes, statusCode: 200 })
  });
  assert.equal(mixed.content.length, 1, JSON.stringify(mixed.notes));
  assert.equal(Buffer.from(mixed.content[0].data, 'base64').toString('hex'), realBytes.toString('hex'), '留下的必须是真的那张');
  assert.equal(mixed.content[0].mimeType, 'image/jpeg');
  assert.match(mixed.notes.at(-1), /另有 2 张因与服务端占位图字节完全相同已丢弃/, JSON.stringify(mixed.notes));
  assert.match(mixed.notes.at(-1), /只给出 1 张真图/);

  // ── ③ 多张字节完全相同 ⇒ **整组**丢弃（含第一张）：断言与实现一致（选择「全部丢弃」）。
  const identical = await buildTiebaImageContent(urls3, {
    fetchBuffer: async () => ({ buffer: iconBytes, statusCode: 200 })
  });
  assert.equal(identical.content.length, 0, '字节完全相同 ⇒ 全部丢弃');
  assert.equal(identical.notes.filter((n) => n.includes('已丢弃')).length, 3);

  // ── ④ 字节各不相同的真图 ⇒ 全部保留（判定不能误杀正常图片）。
  let seed = 0;
  const distinct = await buildTiebaImageContent(urls3, {
    fetchBuffer: async () => { seed += 1; return { buffer: fixturePng(seed), statusCode: 200 }; }
  });
  assert.equal(distinct.content.length, 3);
  assert.deepEqual(distinct.notes, ['[图片1]', '[图片2]', '[图片3]']);

  // ── ⑤ 「小于阈值就当占位」是**错的**：两张同样小（8 字节）但内容不同的真图都要留下。
  const tiny = [u(11), u(12)];
  const tinyReal = await buildTiebaImageContent(tiny, {
    fetchBuffer: async (url) => ({ buffer: Buffer.from(url.endsWith('11.png') ? [0x89, 0x50, 9, 9, 9, 9, 9, 9] : [0x89, 0x50, 8, 8, 8, 8, 8, 8]), statusCode: 200 })
  });
  assert.equal(tinyReal.content.length, 2, '体积小但内容不同 ≠ 占位图（同一页真图可能比占位图还小）');

  // ── ⑥ 同一个地址重复出现（上游已按 URL 去重，这里只是兜底）：只保留第一张，其余按重复标注。
  const dup = await buildTiebaImageContent([u(21), u(21)], {
    fetchBuffer: async () => ({ buffer: iconBytes, statusCode: 200 })
  });
  assert.equal(dup.content.length, 1, '同一个地址只保留一张');
  assert.deepEqual(dup.notes, ['[图片1]', '[图片2：与图片1是同一个地址、内容完全相同，已去重]']);

  // ── ⑦ 与既有上限不冲突：占位判定只在**下载成功之后**发生，失败标注照旧（不重复、不吞掉）。
  const withFailure = await buildTiebaImageContent([u(31), u(32)], {
    fetchBuffer: async (url) => {
      if (url.endsWith('31.png')) throw new Error('fixture: 图床 403');
      return { buffer: iconBytes, statusCode: 200 };
    }
  });
  assert.equal(withFailure.notes[0], '[图片1：获取失败：fixture: 图床 403]', JSON.stringify(withFailure.notes));
  assert.equal(withFailure.content.length, 1, '只有一张时无法判「多张相同」，照给（诚实：判定依据是不同地址字节相同）');

  // ── ⑧ 空输入/畸形输入不抛（占位判定不能把「没有图」升级成「工具崩了」）。
  assert.deepEqual(await buildTiebaImageContent(null), { content: [], notes: [] });
  assert.deepEqual(await buildTiebaImageContent(['not-a-url']), { content: [], notes: [] });
});

function loadTiebaReadTool({ bridgeResponse, imageModule }) {
  const tools = new Map();
  // 真实回调用的**毫秒数**唯一可见的地方：agentApi 把它落成 `AbortSignal.timeout(ms)`。
  // 自适应超时的断言看这里，不再在测试里抄一份公式（抄一份就等于没测那条公式）。
  const timeouts = [];
  const source = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace("const __dirname = path.dirname(fileURLToPath(import.meta.url));", "const __dirname = '/fixture/src';")
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());')
    // vm 里的动态 import 需要 --experimental-vm-modules，所以把这一句换成注入的假模块；
    // 断言的是**真实回调**的接线（谁在什么时候调用构建器、返回值怎么拼）。
    .replace("import('./tieba-lib.js')", 'Promise.resolve(__tiebaImageModule)');
  class McpServer {
    constructor() { this.tool = (name, description, schema, callback) => tools.set(name, { description, schema, callback }); }
    connect() {}
  }
  vm.runInNewContext(source, {
    McpServer,
    StdioServerTransport: class {},
    z,
    URL,
    URLSearchParams,
    fetch: async () => Response.json(bridgeResponse),
    AbortSignal: { timeout: (ms) => { timeouts.push(ms); return AbortSignal.timeout(ms); } },
    process,
    setTimeout,
    clearTimeout,
    console,
    Buffer,
    path,
    fs,
    SENSITIVE_RE: { test: () => false },
    serializeModelData: (value) => JSON.stringify(value),
    __tiebaImageModule: imageModule
  });
  const call = async (arguments_ = {}) => {
    const tool = tools.get('qq_tieba_read');
    assert.ok(tool, 'qq_tieba_read 必须注册');
    return tool.callback(z.object(tool.schema).parse({ key: 'group:1', token: 'fixture-token', tid: '11000000002', ...arguments_ }));
  };
  const registered = tools.get('qq_tieba_read');
  call.timeouts = timeouts;
  call.description = registered?.description ?? '';
  call.pagesDescription = registered?.schema?.pages?.description ?? '';
  return call;
}

/** 一张 12 字节的合成 PNG（签名合法即可）。 */
function fixturePng(seed) {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, seed, 0, 0, 0]);
}

console.log(`\n${failures === 0 ? '🎉' : '❌'} 贴吧库单元测试：通过 ${passed} 项，失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);