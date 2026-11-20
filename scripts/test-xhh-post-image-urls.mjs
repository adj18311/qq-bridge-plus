// scripts/test-xhh-post-image-urls.mjs
// 阶段 2D / A：`extractXhhPostImageUrls` 的离线测试（不联网、不下载、不装插件、不连 DSH）。
//
// 覆盖要点（每条都对应一个真实可能的形状或一种误报/漏报风险）：
//  1) MCP 真实信封 `{content:[{type:'text',text:'<JSON>'}]}` 与结构化对象两种形态；
//  2) 大小写/下划线变体（Images / coverImages / cover_images / COVER-IMAGES）；
//  3) 协议相对地址 `//host/x.jpg`、去重（跨 images 与 coverImages）；
//  4) 畸形条目、非 http(s) 协议、带账号密码、超长地址、超长文本、超长数组、超量地址；
//  5) 错误结果（isError=true，含插件拒绝形状）绝不提取；
//  6) 文本前后带提示语时仍能解析；不是 JSON 时不猜；
//  7) `videoUrl` 不当作图片；没有图片字段时不产出地址；
//  8) 纯函数：不修改入参、模块内无 import / fetch（不联网的结构性保证）；
//  9) notes 有界。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  extractXhhPostImageUrls,
  XHH_POST_IMAGE_MAX_URLS,
  XHH_POST_IMAGE_MAX_URL_LENGTH,
  XHH_POST_IMAGE_MAX_TEXT_LENGTH,
  XHH_POST_IMAGE_MAX_LIST_ITEMS,
  XHH_POST_IMAGE_MAX_NOTES,
  XHH_POST_IMAGE_MAX_VISITED_NODES,
} from '../plugins/xhh-quota-guard/post-image-urls.mjs';

const IMG = 'https://imgheybox.max-c.com/bbs/2026/11/01/a.jpg';
const IMG2 = 'https://imgheybox1.max-c.com/bbs/2026/11/01/b.png';
const COVER = 'https://cdn.max-c.com/bbs/2026/11/01/cover.jpg';

/** 构造一条「成功」的 get_post_detail 文本结果。 */
function textResult(payload, extra = {}) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], ...extra };
}

test('结构化结果：camelCase 的 images / coverImages 都能取到，正文图在前', () => {
  const { urls, notes } = extractXhhPostImageUrls({ postId: '1', images: [IMG], coverImages: [COVER] });
  assert.deepEqual(urls, [IMG, COVER]);
  assert.deepEqual(notes, []);
});

test('MCP 文本信封：content[0].text 是 JSON 字符串时同样能取到', () => {
  const { urls } = extractXhhPostImageUrls(textResult({ postId: '1', images: [IMG, IMG2], coverImages: [COVER] }));
  assert.deepEqual(urls, [IMG, IMG2, COVER]);
});

test('PascalCase（Pascal 序列化）与 snake_case（代理层改写）都要容忍', () => {
  const pascal = extractXhhPostImageUrls({ PostId: '1', Images: [IMG], CoverImages: [COVER] });
  assert.deepEqual(pascal.urls, [IMG, COVER]);

  const snake = extractXhhPostImageUrls({ post_id: '1', images: [IMG], cover_images: [COVER] });
  assert.deepEqual(snake.urls, [IMG, COVER]);

  const noisy = extractXhhPostImageUrls({ 'COVER-IMAGES': [COVER] });
  assert.deepEqual(noisy.urls, [COVER]);
});

test('协议相对地址 //host/path 补成 https，且与绝对地址去重', () => {
  const { urls } = extractXhhPostImageUrls({
    images: ['//imgheybox.max-c.com/bbs/2026/11/01/a.jpg', IMG],
  });
  assert.deepEqual(urls, [IMG]);
  assert.equal(urls.length, 1, '同一地址的两种写法只能出现一次');
});

test('跨字段去重：封面与正文图重复时只保留一份（正文图优先占位）', () => {
  const { urls, notes } = extractXhhPostImageUrls({ images: [IMG], coverImages: [IMG] });
  assert.deepEqual(urls, [IMG]);
  assert.ok(notes.some((note) => note.includes('重复')), '去重必须留说明，不能静默');
});

test('对象形式的图片条目：{url} / {src} / {imageUrl} 都认', () => {
  const { urls } = extractXhhPostImageUrls({
    images: [{ url: IMG }, { src: IMG2 }],
    coverImages: [{ imageUrl: COVER }],
  });
  assert.deepEqual(urls, [IMG, IMG2, COVER]);
});

test('畸形条目计入说明但不影响同列表里的合法地址', () => {
  const { urls, notes } = extractXhhPostImageUrls({
    images: [null, 42, {}, [], '   ', IMG],
  });
  assert.deepEqual(urls, [IMG]);
  // null/42/{}/[] 记为「不是地址字符串」，空白字符串记为「不是可用地址」——两者都要留痕。
  assert.ok(notes.some((note) => note.includes('图片条目不是地址字符串')), `实际 notes=${JSON.stringify(notes)}`);
  assert.ok(notes.some((note) => note.includes('不是可用的 http(s) 地址')), `实际 notes=${JSON.stringify(notes)}`);
});

test('非 http(s) 协议、带账号密码、解析失败的地址一律丢弃', () => {
  const { urls, notes } = extractXhhPostImageUrls({
    images: [
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'ftp://imgheybox.max-c.com/a.jpg',
      'https://user:pass@imgheybox.max-c.com/a.jpg',
      'https://',
      IMG,
    ],
  });
  assert.deepEqual(urls, [IMG]);
  assert.ok(notes.some((note) => note.includes('不是可用的 http(s) 地址')), `实际 notes=${JSON.stringify(notes)}`);
});

test('单个地址超过长度上限视为畸形', () => {
  const longUrl = `https://imgheybox.max-c.com/${'a'.repeat(XHH_POST_IMAGE_MAX_URL_LENGTH)}`;
  const { urls } = extractXhhPostImageUrls({ images: [longUrl, IMG] });
  assert.deepEqual(urls, [IMG]);
});

test('错误结果（isError=true）绝不提取，即使文本里有地址', () => {
  const denied = {
    isError: true,
    content: [{ type: 'text', text: `Error: xhh-quota-guard: denied\n${JSON.stringify({ images: [IMG] })}` }],
    error: { code: 'XHH_GUARD_DENIED', message: 'denied' },
  };
  const { urls, notes } = extractXhhPostImageUrls(denied);
  assert.deepEqual(urls, []);
  assert.ok(notes.some((note) => note.includes('isError')), `实际 notes=${JSON.stringify(notes)}`);
});

test('文本不是 JSON 时不猜（不做正则捞 URL）', () => {
  const { urls, notes } = extractXhhPostImageUrls({ content: [{ type: 'text', text: `图片：${IMG}` }] });
  assert.deepEqual(urls, []);
  assert.ok(notes.some((note) => note.includes('不是 JSON')), `实际 notes=${JSON.stringify(notes)}`);
});

test('文本前后带提示语时仍能解析出 JSON', () => {
  const text = `帖子详情如下：${JSON.stringify({ images: [IMG] })}\n（以上为原始返回）`;
  const { urls } = extractXhhPostImageUrls({ content: [{ type: 'text', text }] });
  assert.deepEqual(urls, [IMG]);
});

test('超长文本直接放弃解析并说明原因（不切片、不猜）', () => {
  const huge = `${JSON.stringify({ images: [IMG] })}${'x'.repeat(XHH_POST_IMAGE_MAX_TEXT_LENGTH)}`;
  const { urls, notes } = extractXhhPostImageUrls({ content: [{ type: 'text', text: huge }] });
  assert.deepEqual(urls, []);
  assert.ok(notes.some((note) => note.includes('文本过长')), `实际 notes=${JSON.stringify(notes)}`);
});

test('数组超长：只读前 N 项并说明', () => {
  const images = Array.from({ length: XHH_POST_IMAGE_MAX_LIST_ITEMS + 5 }, (_, i) => `https://cdn.max-c.com/b/${i}.jpg`);
  const { urls, notes } = extractXhhPostImageUrls({ images });
  assert.equal(urls.length, XHH_POST_IMAGE_MAX_URLS);
  assert.ok(notes.some((note) => note.includes(`超过 ${XHH_POST_IMAGE_MAX_LIST_ITEMS} 项`)), `实际 notes=${JSON.stringify(notes)}`);
  assert.ok(notes.some((note) => note.includes(`超过 ${XHH_POST_IMAGE_MAX_URLS} 个`)), '截断必须留说明');
});

test('地址总量上限：超出部分丢弃且只保留前 N 个', () => {
  const images = Array.from({ length: XHH_POST_IMAGE_MAX_URLS + 3 }, (_, i) => `https://cdn.max-c.com/c/${i}.jpg`);
  const { urls } = extractXhhPostImageUrls({ images });
  assert.equal(urls.length, XHH_POST_IMAGE_MAX_URLS);
  assert.equal(urls[0], 'https://cdn.max-c.com/c/0.jpg');
});

test('videoUrl 不当作图片；只有视频时不会凭空产出地址', () => {
  const { urls, notes } = extractXhhPostImageUrls({
    postId: '1',
    videoUrl: 'https://video.max-c.com/x.mp4',
    commentCount: 3,
  });
  assert.deepEqual(urls, []);
  // 无图帖是常态：不得因此给模型追加说明（曾经的「结果中没有 images…」是纯噪声）。
  assert.deepEqual(notes, []);
});

test('字段不是数组时忽略并说明（不让字符串/对象混进地址列表）', () => {
  const { urls, notes } = extractXhhPostImageUrls({ images: IMG });
  assert.deepEqual(urls, []);
  assert.ok(notes.some((note) => note.includes('不是数组')), `实际 notes=${JSON.stringify(notes)}`);
});

test('结构化结果嵌在 data/post 下也能取到', () => {
  assert.deepEqual(extractXhhPostImageUrls({ data: { images: [IMG] } }).urls, [IMG]);
  assert.deepEqual(extractXhhPostImageUrls({ post: { coverImages: [COVER] } }).urls, [COVER]);
});

test('空结果 / null / 数组信封都不抛异常', () => {
  assert.deepEqual(extractXhhPostImageUrls(null).urls, []);
  assert.deepEqual(extractXhhPostImageUrls(undefined).urls, []);
  assert.deepEqual(extractXhhPostImageUrls({ content: [] }).urls, []);
  assert.deepEqual(extractXhhPostImageUrls([]).urls, []);
  assert.deepEqual(extractXhhPostImageUrls(42).urls, []);
});

test('纯函数：不修改入参（同一对象重复调用结果一致）', () => {
  const input = { postId: '1', images: [IMG, 'bad'], coverImages: [COVER] };
  const before = JSON.stringify(input);
  const first = extractXhhPostImageUrls(input);
  const second = extractXhhPostImageUrls(input);
  assert.equal(JSON.stringify(input), before, '入参必须原样');
  assert.deepEqual(first, second);
});

test('notes 有界，不会把上千条异常逐条抛给调用方', () => {
  const images = Array.from({ length: XHH_POST_IMAGE_MAX_LIST_ITEMS }, () => null);
  const { notes } = extractXhhPostImageUrls({ images });
  assert.ok(notes.length <= XHH_POST_IMAGE_MAX_NOTES, `notes=${notes.length}`);
});

test('模块自身无 import、无 fetch —— 结构性保证「不联网、不下载」', () => {
  const file = path.resolve(import.meta.dirname, '../plugins/xhh-quota-guard/post-image-urls.mjs');
  const source = fs.readFileSync(file, 'utf8');
  // 去掉注释再判断，避免注释里的词造成误报。
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
  assert.equal(/^\s*import\s/mu.test(code), false, '不得 import 任何模块');
  assert.equal(/\bfetch\s*\(/u.test(code), false, '不得直接调用 fetch');
  assert.equal(/require\s*\(/u.test(code), false, '不得使用 require');
  assert.equal(/node:http|node:https|undici/iu.test(code), false, '不得引入网络客户端');
});
// —— 结构化 MCP 输出（structuredContent）：与 content 并列的一份对象，2026-11-01 Codex 增量要求 ——

test('structuredContent：直接是 PostDetail 时也能取到图片（content 里没有图片信息）', () => {
  const { urls, notes } = extractXhhPostImageUrls({
    isError: false,
    content: [{ type: 'text', text: '帖子详情' }],
    structuredContent: { postId: '1', images: [IMG], coverImages: [COVER] },
  });
  assert.deepEqual(urls, [IMG, COVER]);
  assert.deepEqual(notes, []);
});

test('structuredContent：外面再包一层 data/post 时仍能取到', () => {
  const wrappedData = extractXhhPostImageUrls({ structuredContent: { data: { images: [IMG] } } });
  assert.deepEqual(wrappedData.urls, [IMG], 'structuredContent.data 必须下钻');
  const wrappedPost = extractXhhPostImageUrls({ structuredContent: { detail: { post: { coverImages: [COVER] } } } });
  assert.deepEqual(wrappedPost.urls, [COVER], 'structuredContent.detail.post 必须下钻');
});

test('structuredContent：JSON 字符串与数组两种形态都要容忍', () => {
  const asText = extractXhhPostImageUrls({ structuredContent: JSON.stringify({ images: [IMG] }) });
  assert.deepEqual(asText.urls, [IMG], 'structuredContent 是 JSON 字符串时要解析');

  const asArray = extractXhhPostImageUrls({ structuredContent: [{ images: [IMG] }, { coverImages: [COVER] }] });
  assert.deepEqual(asArray.urls, [IMG, COVER], 'structuredContent 是数组时逐项解析');
});

test('structuredContent：与 content 文本里的同一地址去重，且错误结果一律不取', () => {
  const both = extractXhhPostImageUrls({
    content: [{ type: 'text', text: JSON.stringify({ images: [IMG] }) }],
    structuredContent: { images: [IMG, IMG2] },
  });
  assert.deepEqual(both.urls, [IMG, IMG2], '跨 content 与 structuredContent 必须去重');

  const errored = extractXhhPostImageUrls({
    isError: true,
    content: [{ type: 'text', text: '拒绝' }],
    structuredContent: { images: [IMG] },
  });
  assert.deepEqual(errored.urls, [], 'isError=true 时结构化输出也不得提取');
});

test('structuredContent：嵌套过深时不无限递归，且留下说明', () => {
  let deep = { images: [IMG] };
  for (let i = 0; i < 8; i += 1) deep = { data: deep };
  const { urls, notes } = extractXhhPostImageUrls({ structuredContent: deep });
  assert.equal(urls.length, 0, '超过两层包装的深层结构不应当作帖子内容');
  assert.ok(notes.some((note) => note.includes('嵌套过深')), '必须有可见说明，不能静默');
});

test('文本 JSON 的常见信封（code/msg/data/post）也能取到图片', () => {
  const payload = { code: 200, msg: 'ok', data: { post: { images: [IMG] } } };
  const { urls, notes } = extractXhhPostImageUrls({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
  assert.deepEqual(urls, [IMG], '包裹在信封里的正文图必须能取到（否则功能静默失效）');
  assert.deepEqual(notes, []);
});

test('文本 JSON 里 data 只包一层也能取到（回归：不得当成不透明对象）', () => {
  const payload = { data: { images: [IMG] } };
  const { urls } = extractXhhPostImageUrls({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
  assert.deepEqual(urls, [IMG]);
});

test('structuredContent：四层 data 包装仍在覆盖范围内（深度上限放宽后的回归）', () => {
  let deep = { images: [IMG] };
  for (let i = 0; i < 4; i += 1) deep = { data: deep };
  const { urls, notes } = extractXhhPostImageUrls({ structuredContent: deep });
  assert.deepEqual(urls, [IMG]);
  assert.deepEqual(notes, []);
});

test('structuredContent：没有 images/coverImages 时不产出地址，也不追加噪声说明', () => {
  const { urls, notes } = extractXhhPostImageUrls({ structuredContent: { title: '无图帖', videoUrl: 'https://v.max-c.com/x.mp4' } });
  assert.deepEqual(urls, [], 'videoUrl 不得当图片');
  assert.deepEqual(notes, [], '无图不该产生说明');
});

// —— 10. 畸形结构：循环引用 / 深层数组 / 宽树预算（Codex 只读复核提出） ——

test('自引用数组不得无限递归（循环引用说明 + 不抛错）', () => {
  const loop = [];
  loop.push(loop);
  const startedAt = Date.now();
  const { urls, notes } = extractXhhPostImageUrls({ structuredContent: loop });
  assert.ok(Date.now() - startedAt < 1000, '必须在毫秒级返回，不能把调用方拖死');
  assert.deepEqual(urls, []);
  assert.ok(notes.some((note) => note.includes('循环引用')), '必须给出可见说明');
});

test('层层嵌套的数组也计入深度（不得绕过深度上限）', () => {
  let deep = { images: [IMG] };
  for (let i = 0; i < 200; i += 1) deep = [deep];
  const { urls, notes } = extractXhhPostImageUrls({ structuredContent: deep });
  assert.deepEqual(urls, [], '200 层数组包装已经不属于「同一份帖子详情」');
  assert.ok(notes.some((note) => note.includes('嵌套过深')), '必须给出可见说明');
});

test('循环引用对象（data 自指）不得无限递归', () => {
  const cyclic = { data: {} };
  cyclic.data.data = cyclic.data;
  const { urls, notes } = extractXhhPostImageUrls({ structuredContent: cyclic });
  assert.deepEqual(urls, []);
  assert.ok(notes.some((note) => note.includes('循环引用')));
});

test('宽树触发全局节点预算：快速返回、有说明、且说明去重', () => {
  const wide = {};
  for (const key of ['data', 'post', 'result', 'detail', 'payload']) {
    wide[key] = [];
    for (let i = 0; i < XHH_POST_IMAGE_MAX_LIST_ITEMS; i += 1) {
      wide[key].push({ data: { post: { images: [IMG] } } });
    }
  }
  const startedAt = Date.now();
  const { urls, notes } = extractXhhPostImageUrls({ structuredContent: wide });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 2000, `必须在预算内快速返回，实际 ${elapsed}ms`);
  assert.ok(notes.some((note) => note.includes(`节点超过 ${XHH_POST_IMAGE_MAX_VISITED_NODES} 个`)), '预算耗尽必须可见');
  const sameNote = notes.filter((note) => note === '结构化输出嵌套过深，未继续解析');
  assert.ok(sameNote.length <= 1, '同一条说明不得重复刷屏（否则会把重要说明挤出上限）');
  assert.ok(urls.length <= XHH_POST_IMAGE_MAX_URLS);
});

test('正常尺寸的结构化输出不会被预算误伤', () => {
  const normal = { images: [IMG, IMG2], coverImages: [COVER] };
  const { urls, notes } = extractXhhPostImageUrls({ structuredContent: normal });
  assert.deepEqual(urls, [IMG, IMG2, COVER]);
  assert.deepEqual(notes, [], '正常结果不该有任何说明');
});
