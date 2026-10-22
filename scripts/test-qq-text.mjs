/**
 * src/core/qq-text.mjs 的行为测试。
 *
 * 只测「文本 → 消息序列」的可观察结果：不读写仓库/状态/配置，不启动服务，
 * 也不依赖 bridge.js。函数是纯的，因此不需要任何临时文件。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCjkChar,
  planSocialTimeline,
  singleLineForQQ,
  splitByCjkSpaces,
  splitLongSegment,
} from '../src/core/qq-text.mjs';

/** 孤立 UTF-16 代理项：出现在分段边界即代表 emoji/生僻字被切坏。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ── singleLineForQQ ────────────────────────────────────────────────────────

test('singleLineForQQ 折叠换行与连续空白，压成干净单行', () => {
  assert.equal(singleLineForQQ('  第一行\n\n第二行  '), '第一行 第二行');
  assert.equal(singleLineForQQ('a\t\tb   c'), 'a b c');
  assert.equal(singleLineForQQ('只有一行'), '只有一行');
});

test('singleLineForQQ 对 null/undefined 返回空串而不是字面量 "null"', () => {
  assert.equal(singleLineForQQ(null), '');
  assert.equal(singleLineForQQ(undefined), '');
  assert.equal(singleLineForQQ(''), '');
});

// ── splitLongSegment：URL 原子性 / 占位符安全 ──────────────────────────────

test('splitLongSegment 在 1..max+20 的所有长度下都不丢内容、不泄漏 NUL 占位符', () => {
  const url = 'https://example.com/very/long/path?q=1&x=2';
  const max = 500;
  for (let n = 1; n <= max + 20; n++) {
    const text = '啊'.repeat(n) + url;
    const parts = splitLongSegment(text, max);
    assert.equal(parts.join(''), text, `n=${n} 拼接后必须与原文一致`);
    assert.equal(parts.join('').split(url).length - 1, 1, `n=${n} URL 必须完整出现一次`);
    assert.ok(parts.every((p) => !p.includes('\u0000')), `n=${n} 不得残留 NUL 占位符`);
    assert.ok(parts.every((p) => !/URL\d+/.test(p)), `n=${n} 不得泄漏字面量占位符`);
  }
});

test('splitLongSegment 宁可让含 URL 的段略超上限，也不把 URL 拆成两段', () => {
  const url = 'https://example.com/a/b?x=1,2;3&y=4';
  const text = '啊'.repeat(2000) + url;
  const parts = splitLongSegment(text, 20);
  assert.equal(parts.join(''), text);
  assert.ok(parts.includes(url), 'URL 应恰好作为独立的一段出现');
  assert.equal(parts.filter((p) => p === url).length, 1);
  // 其余普通文本段仍然受 safeMax 约束
  assert.ok(parts.filter((p) => p !== url).every((p) => p.length <= 20));
});

test('splitLongSegment 多个 URL 都完整保留，不会被拆断或吞掉内容', () => {
  const url1 = 'https://example.com/one?q=1';
  const url2 = 'https://example.com/two?q=2';
  const text = '啊'.repeat(600) + url1 + '，中间，' + url2;
  const parts = splitLongSegment(text, 80);
  assert.equal(parts.join(''), text);
  assert.equal(parts.join('').split(url1).length - 1, 1);
  assert.equal(parts.join('').split(url2).length - 1, 1);
  assert.equal(parts.filter((p) => p.includes(url1)).length, 1);
  assert.equal(parts.filter((p) => p.includes(url2)).length, 1);
  // 超长 token 里的 URL 会独占一段；短 token 允许与相邻文本同段
  assert.ok(parts.includes(url1));
});

test('splitLongSegment 绝不把内部占位符切开（无 NUL、无字面量 URL0/URL1）', () => {
  const url = 'https://example.com/' + 'p'.repeat(120);
  // URL 后紧跟中文标点：否则旧实现的 URL 正则会把后面的汉字一起吞进原子（既有行为）
  const original = '啊'.repeat(1000) + url + '，' + '啊'.repeat(1000);
  for (const max of [1, 2, 3, 5, 10, 17, 64, 500]) {
    const parts = splitLongSegment(original, max);
    assert.equal(parts.join(''), original, `max=${max} 不得丢内容`);
    assert.ok(parts.includes(url), `max=${max} URL 必须是完整的一段`);
    assert.ok(parts.every((p) => !p.includes('\u0000')), `max=${max} 不得有 NUL`);
    assert.ok(parts.every((p) => !/URL\d+/.test(p)), `max=${max} 不得有字面量占位符`);
  }
});

// ── splitLongSegment：emoji 代理对 ─────────────────────────────────────────

test('splitLongSegment 硬拆不落在 emoji 代理对中间', () => {
  const original = '😀'.repeat(300);
  for (const max of [2, 3, 4, 5, 7, 64, 500]) {
    const parts = splitLongSegment(original, max);
    assert.equal(parts.join(''), original, `max=${max} 拼接后必须还原`);
    for (const p of parts) {
      assert.ok(!LONE_SURROGATE.test(p), `max=${max} 出现孤立代理项: ${JSON.stringify(p)}`);
      assert.ok([...p].every((ch) => ch === '😀'), `max=${max} 片段只由完整 emoji 组成`);
      assert.ok(p.length <= max, `max=${max} 片段不得超长`);
    }
  }
});

test('splitLongSegment 在文本中段的代理对边界同样不下刀', () => {
  const original = 'a'.repeat(3) + '😀'.repeat(20);
  const parts = splitLongSegment(original, 5);
  assert.equal(parts.join(''), original);
  for (const p of parts) assert.ok(!LONE_SURROGATE.test(p), JSON.stringify(p));
});

// ── splitLongSegment：长度参数与标点 ──────────────────────────────────────

test('splitLongSegment 空段返回空数组，短段原样返回且已 trim', () => {
  assert.deepEqual(splitLongSegment('', 10), []);
  assert.deepEqual(splitLongSegment('   ', 10), []);
  assert.deepEqual(splitLongSegment(null, 10), []);
  assert.deepEqual(splitLongSegment(undefined, 10), []);
  assert.deepEqual(splitLongSegment('abc', 10), ['abc']);
  assert.deepEqual(splitLongSegment('  abc  ', 10), ['abc']);
});

test('splitLongSegment 非法 max 回落到 500，合法值向下取整', () => {
  const text = 'x'.repeat(1200);
  for (const bad of [NaN, 0, -3, Infinity, 'abc', null, undefined]) {
    assert.deepEqual(
      splitLongSegment(text, bad).map((s) => s.length),
      [500, 500, 200],
      `max=${String(bad)} 应回落到 500`,
    );
  }
  assert.deepEqual(splitLongSegment('abcdefghij', 3.9), ['abc', 'def', 'ghi', 'j']);
  assert.deepEqual(splitLongSegment('abc', 1), ['a', 'b', 'c']);
});

test('splitLongSegment 优先按次要标点分段，且任何上限下都不丢标点', () => {
  const text = '第一段，第二段；第三段：第四段';
  assert.deepEqual(splitLongSegment(text, 5), ['第一段，', '第二段；', '第三段：', '第四段']);
  for (const max of [1, 2, 3, 5, 6, 7, 20]) {
    assert.equal(splitLongSegment(text, max).join(''), text, `max=${max}`);
  }
});

// ── isCjkChar ─────────────────────────────────────────────────────────────

test('isCjkChar 只认汉字区段，不认全角标点/字母/数字/emoji', () => {
  assert.equal(isCjkChar('中'), true);
  assert.equal(isCjkChar('㐀'), true); // U+3400 扩展 A 起点
  assert.equal(isCjkChar('豈'), true); // U+F900 兼容汉字起点
  assert.equal(isCjkChar('，'), false);
  assert.equal(isCjkChar('！'), false);
  assert.equal(isCjkChar('A'), false);
  assert.equal(isCjkChar('1'), false);
  assert.equal(isCjkChar('😀'), false);
  assert.equal(isCjkChar(''), false);
  assert.equal(isCjkChar(null), false);
  assert.equal(isCjkChar(undefined), false);
});

// ── splitByCjkSpaces ──────────────────────────────────────────────────────

test('splitByCjkSpaces 纯英文空格保持一条，中英混合按汉字一侧分条', () => {
  assert.deepEqual(splitByCjkSpaces('hello world foo'), ['hello world foo']);
  assert.deepEqual(splitByCjkSpaces('hello 世界 foo'), ['hello', '世界', 'foo']);
  assert.deepEqual(splitByCjkSpaces('世界 hello'), ['世界', 'hello']);
  assert.deepEqual(splitByCjkSpaces('a， b'), ['a， b']); // 全角标点不算汉字
  assert.deepEqual(splitByCjkSpaces('你好， 世界'), ['你好，', '世界']);
});

test('splitByCjkSpaces 把换行视作空格：中文分条，纯英文合并', () => {
  assert.deepEqual(splitByCjkSpaces('第一行\n第二行'), ['第一行', '第二行']);
  assert.deepEqual(splitByCjkSpaces('line1\nline2'), ['line1 line2']);
  assert.deepEqual(splitByCjkSpaces('  \n\t '), []);
  assert.deepEqual(splitByCjkSpaces(''), []);
  assert.deepEqual(splitByCjkSpaces(null), []);
});

// ── planSocialTimeline：结构与空消息 ──────────────────────────────────────

test('planSocialTimeline 对空消息稳定返回 {main: [], followUp: null}', () => {
  for (const input of ['', '   ', '\r\n\n\t', null, undefined]) {
    assert.deepEqual(planSocialTimeline(input), { main: [], followUp: null });
    assert.deepEqual(
      planSocialTimeline(input, { maxReplyChars: 10, burstEnabled: true }),
      { main: [], followUp: null },
    );
    assert.deepEqual(
      planSocialTimeline(input, { maxReplyChars: 10, burstEnabled: false }),
      { main: [], followUp: null },
    );
  }
});

test('planSocialTimeline 返回结构恒为 {main, followUp:null}', () => {
  for (const input of ['你好', '你好 世界', 'a'.repeat(900)]) {
    const out = planSocialTimeline(input);
    assert.deepEqual(Object.keys(out).sort(), ['followUp', 'main']);
    assert.equal(Array.isArray(out.main), true);
    assert.equal(out.followUp, null);
    assert.ok(out.main.every((m) => typeof m === 'string' && m.length > 0));
  }
});

// ── planSocialTimeline：burstEnabled ──────────────────────────────────────

test('burstEnabled=false 时不按空格/换行分条，只做安全硬拆', () => {
  assert.deepEqual(
    planSocialTimeline('你好 世界', { burstEnabled: false }),
    { main: ['你好 世界'], followUp: null },
  );
  assert.deepEqual(
    planSocialTimeline('第一行\n第二行', { burstEnabled: false }),
    { main: ['第一行 第二行'], followUp: null },
  );
  assert.deepEqual(
    planSocialTimeline('a'.repeat(120), { burstEnabled: false, maxReplyChars: 50 }).main,
    ['a'.repeat(50), 'a'.repeat(50), 'a'.repeat(20)],
  );
});

// ── planSocialTimeline：分条规则 ──────────────────────────────────────────

test('默认开启分条：中文与中英混合按空格拆分，纯英文空格不分条', () => {
  assert.deepEqual(planSocialTimeline('你好 世界').main, ['你好', '世界']);
  assert.deepEqual(planSocialTimeline('hello world foo').main, ['hello world foo']);
  assert.deepEqual(planSocialTimeline('今天 hello 明天').main, ['今天', 'hello', '明天']);
  assert.deepEqual(planSocialTimeline('第一行\n第二行').main, ['第一行', '第二行']);
  assert.deepEqual(planSocialTimeline('line1\nline2').main, ['line1 line2']);
  assert.deepEqual(planSocialTimeline('你好 世界', {}).main, ['你好', '世界']);
  assert.deepEqual(planSocialTimeline('你好 世界', undefined).main, ['你好', '世界']);
});

test('每条 main 都是单行且无首尾空白', () => {
  const out = planSocialTimeline('  你好\n\n世界  ', { maxReplyChars: 500 });
  assert.deepEqual(out.main, ['你好', '世界']);
  for (const m of out.main) assert.equal(m, singleLineForQQ(m));
});

// ── planSocialTimeline：长度参数 ──────────────────────────────────────────

test('planSocialTimeline 非法 maxReplyChars 一律回落到 500', () => {
  const text = 'a'.repeat(600);
  for (const bad of [NaN, 0, -1, -Infinity, Infinity, 'abc', null, {}]) {
    assert.deepEqual(
      planSocialTimeline(text, { burstEnabled: false, maxReplyChars: bad }).main.map((s) => s.length),
      [500, 100],
      `maxReplyChars=${String(bad)} 应回落到 500`,
    );
  }
  assert.deepEqual(
    planSocialTimeline(text, { burstEnabled: false }).main.map((s) => s.length),
    [500, 100],
    '缺省应按 500',
  );
});

test('planSocialTimeline 有效 maxReplyChars 向下取整并按上限拆条', () => {
  assert.deepEqual(
    planSocialTimeline('a'.repeat(30), { burstEnabled: false, maxReplyChars: 12.9 }).main.map((s) => s.length),
    [12, 12, 6],
  );
  assert.deepEqual(
    planSocialTimeline('ab', { burstEnabled: false, maxReplyChars: 1 }).main,
    ['a', 'b'],
  );
});

// ── planSocialTimeline：全链路 URL / emoji / 换行 ─────────────────────────

test('planSocialTimeline 全链路不泄漏 NUL 占位符，URL 完整保留', () => {
  const url = 'https://example.com/really/long?x=1,2;3';
  const text = '啊'.repeat(700) + url;
  const out = planSocialTimeline(text, { maxReplyChars: 60 });
  assert.equal(out.main.join(''), text);
  assert.ok(out.main.includes(url), 'URL 应作为独立一条消息');
  assert.ok(out.main.every((m) => !m.includes('\u0000') && !/URL\d+/.test(m)));
  assert.equal(out.followUp, null);
});

test('planSocialTimeline 的硬拆同样不切断 emoji 代理对', () => {
  const original = '😀'.repeat(400);
  const out = planSocialTimeline(original, { maxReplyChars: 7 });
  assert.equal(out.main.join(''), original);
  for (const m of out.main) {
    assert.ok(!LONE_SURROGATE.test(m), JSON.stringify(m));
    assert.ok(m.length <= 7);
  }
});

test('planSocialTimeline 先把 CRLF 归一化再按换行分条', () => {
  assert.deepEqual(planSocialTimeline('第一\r\n第二').main, ['第一', '第二']);
  assert.deepEqual(
    planSocialTimeline('第一\r\n第二', { burstEnabled: false }).main,
    ['第一 第二'],
  );
});
