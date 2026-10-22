// Offline regression tests for the pure persona-text seam.
//
// Contract: the four exports in src/core/persona-text.mjs are a mechanical copy of
// isCjkLikeChar / convertExampleSpacesToComma / findCjkSpaceWarning / findSplitBoundaryWarning
// frozen from src/bridge.js at faaa226 (see scripts/fixtures/persona-text-baseline.mjs).
// Expectations below are hard-coded; the differential tests additionally compare against the
// independent frozen fixture (never against the production module to derive expectations).
//
// Run directly (in-process): node scripts/test-persona-text.mjs
// Also compatible with:      node --test scripts/test-persona-text.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as frozen from './fixtures/persona-text-baseline.mjs';
import * as seam from '../src/core/persona-text.mjs';

const SPACE_WARNING_1 = '第 1 条消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。';
const SPACE_WARNING_2 = '第 2 条消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。';
const SPACE_WARNING_3 = '第 3 条消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。';
const SPACE_WARNING_10 = '第 10 条消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。';
const SPACE_WARNING_1_3 = '第 1、3 条消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。';
const SPLIT_SUFFIX = '条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。';
const SPLIT_12 = `第 1、2 ${SPLIT_SUFFIX}`;
const SPLIT_34 = `第 3、4 ${SPLIT_SUFFIX}`;
const SPLIT_1_2__3_4 = `第 1、2，3、4 ${SPLIT_SUFFIX}`;
const SPLIT_1_2__2_3 = `第 1、2，2、3 ${SPLIT_SUFFIX}`;
const SPLIT_10_11 = `第 10、11 ${SPLIT_SUFFIX}`;

function outcome(fn, makeArgs) {
  try {
    return { ok: true, value: fn(...makeArgs()) };
  } catch (error) {
    return { ok: false, name: error.name, message: error.message };
  }
}

function differential(frozenFn, seamFn, makeArgs, label) {
  const expected = outcome(frozenFn, makeArgs);
  const actual = outcome(seamFn, makeArgs);
  assert.deepEqual(actual, expected, `frozen mismatch: ${label}`);
}

test('frozen fixture bodies are the literal faaa226 snapshots', () => {
  const text = fs.readFileSync(new URL('./fixtures/persona-text-baseline.mjs', import.meta.url), 'utf8');
  // SHA-256 over each dedented function body exactly as extracted from src/bridge.js
  // at faaa226 lines 11663-11745 (verified at extraction time against the live file).
  const hashes = {
    isCjkLikeChar: '562e5a580fd709ebbd58eb490ff9c6ec4ccbcb4d933c122ea38e224c489dfd96',
    convertExampleSpacesToComma: 'cea95aef9d91c92d5fc7b61904bb74f8bfafcbb9a7c5477b2625df6ec2238714',
    findCjkSpaceWarning: '01742d635819c3f51cb6aa14272a851bc860fac011f6d9131ed87bdf1bc3e3f4',
    findSplitBoundaryWarning: 'f34fbc5d689d82d1089bd70f6d72b9dde3687b58d97f79354b90d82b334f791e',
  };
  for (const [name, hash] of Object.entries(hashes)) {
    const start = text.indexOf(`export function ${name}(`);
    assert.notEqual(start, -1, `fixture is missing ${name}`);
    const end = text.indexOf('\n}', start);
    assert.notEqual(end, -1, `fixture body for ${name} is not terminated`);
    assert.equal(
      crypto.createHash('sha256').update(text.slice(start, end + 2)).digest('hex'),
      hash,
      `frozen body drifted: ${name}`,
    );
  }
  // The fixture must stay independent: no imports of the production seam or anything else.
  assert.doesNotMatch(text, /^import /m, 'fixture must not import production code');
});

test('module exports exactly the four renamed pure functions', () => {
  const names = ['cjkLikeChar', 'convertExampleSpaces', 'cjkSpaceWarning', 'splitBoundaryWarning'];
  for (const name of names) assert.equal(typeof seam[name], 'function', `missing export: ${name}`);
  assert.deepEqual(Object.keys(seam).sort(), [...names].sort());
});

test('cjkLikeChar accepts exactly the four legacy ranges and their exact boundaries', () => {
  const accepted = [
    ['\u3400', 'range 0x3400 start'],
    ['\u4DBF', 'range 0x4DBF end'],
    ['\u4E00', 'range 0x4E00 start'],
    ['\u9FFF', 'range 0x9FFF end'],
    ['\uF900', 'range 0xF900 start'],
    ['\uFAFF', 'range 0xFAFF end'],
    ['\u3000', 'ideographic space start'],
    ['\u303F', 'CJK symbol end'],
    ['你', 'common han'],
    ['\u3002', 'ideographic full stop U+3002 inside 0x3000-0x303F'],
  ];
  for (const [ch, label] of accepted) assert.equal(seam.cjkLikeChar(ch), true, label);
  assert.equal(seam.cjkLikeChar('\u4DBF'), frozen.isCjkLikeChar('\u4DBF'));

  const rejected = [
    ['\u2FFF', 'below 0x3000'],
    ['\u3040', 'hiragana start is outside the ranges'],
    ['\u33FF', 'between 0x303F and 0x3400'],
    ['\u4DC0', 'between 0x4DBF and 0x4E00'],
    ['\u4DFF', 'top of the gap below 0x4E00'],
    ['\uA000', 'above 0x9FFF'],
    ['\uF8FF', 'below 0xF900 (private use)'],
    ['\uFB00', 'above 0xFAFF'],
    ['A', 'ASCII letter'],
    [' ', 'ASCII space'],
    ['\u0000', 'NUL string is truthy but out of range'],
    ['\u3042', 'hiragana'],
    ['\uFF0C', 'fullwidth comma U+FF0C is outside the four legacy ranges'],
    ['\uFF01', 'fullwidth exclamation mark is outside the ranges'],
  ];
  for (const [ch, label] of rejected) assert.equal(seam.cjkLikeChar(ch), false, label);

  // Astral code points are never CJK-like here: codePointAt() returns > 0xFFFF and the
  // legacy ranges only cover BMP. Lone surrogates fall outside every range as well.
  for (const ch of ['\u{20000}', '\u{20BB7}', '\u{2A700}', '\u{2F800}', '\u{1F600}', '\uD840', '\uDC00']) {
    assert.equal(seam.cjkLikeChar(ch), false, `astral/surrogate must be false: ${ch}`);
  }
  // Only the first code point is inspected: '你a' is CJK-like, 'a你' is not.
  assert.equal(seam.cjkLikeChar('你a'), true);
  assert.equal(seam.cjkLikeChar('a你'), false);
  // Quirk: a String object is truthy and has codePointAt, so it is accepted.
  assert.equal(seam.cjkLikeChar(new String('你')), true);

  for (const falsy of [undefined, null, '', 0, -0, 0n, false, NaN]) {
    assert.equal(seam.cjkLikeChar(falsy), false, `falsy must be false: ${String(falsy)}`);
  }
  // Invalid truthy non-strings have no codePointAt and throw, exactly as before.
  for (const bad of [1, -1, true, {}, [], Symbol('x'), () => {}, 5n]) {
    assert.throws(() => seam.cjkLikeChar(bad), TypeError, `invalid truthy non-string must throw: ${String(bad)}`);
  }
});

test('convertExampleSpaces converts one-sided CJK spaces only and preserves blocked characters', () => {
  const cases = [
    ['你 好', '你，好', 'basic CJK both sides'],
    ['你\t好', '你，好', 'tab counts as a separator'],
    ['Hello 世界', 'Hello，世界', 'one-sided: next is CJK'],
    ['世界 Hello', '世界，Hello', 'one-sided: previous is CJK'],
    ['DeepSeek V3 好', 'DeepSeek V3，好', 'English words stay intact until CJK is adjacent'],
    ['Hello DeepSeek', 'Hello DeepSeek', 'pure English unchanged'],
    ['你\n好', '你\n好', 'newline is not a separator'],
    ['你\u3000好', '你\u3000好', 'ideographic space is not a separator'],
    ['你\u3000 好', '你\u3000，好', 'ASCII space after a CJK-like ideographic space converts'],
    ['你\u00A0好', '你\u00A0好', 'NBSP is not a separator'],
    ['你 \u00A0好', '你，\u00A0好', 'space next to NBSP still converts from the CJK side'],
    ['你  好', '你，，好', 'each space is judged against the original neighbours'],
    ['你\t\t好', '你，，好', 'consecutive tabs convert individually'],
    [' 你好 ', '，你好，', 'leading and trailing spaces convert (no trimming)'],
    ['   ', '   ', 'whitespace-only line has no CJK neighbour'],
    ['你  ', '你， ', 'trailing second space has no CJK neighbour'],
    ['  你好', ' ，你好', 'of two leading spaces only the CJK-adjacent one converts'],
    ['你 / 好', '你 / 好', 'slashes are blocked on both sides'],
    ['你 ， 好', '你 ， 好', 'fullwidth comma is blocked'],
    ['你 、 好', '你 、 好', 'ideographic comma is blocked'],
    ['你 。 好', '你 。 好', 'fullwidth full stop is blocked'],
    ['你 (好', '你 (好', 'opening paren blocks'],
    ['你 & 好', '你 & 好', 'ampersand blocks'],
    ['你 = 好', '你 = 好', 'equals blocks'],
    ['你 ; 好', '你 ; 好', 'semicolon blocks'],
    ['你 : 好', '你 : 好', 'colon blocks'],
    ['你 , 好', '你 , 好', 'ASCII comma blocks'],
    ['你 . 好', '你 . 好', 'ASCII full stop blocks'],
    ['你 | 好', '你 | 好', 'pipe blocks'],
    ['你 < 好', '你 < 好', 'angle bracket blocks'],
    ['你 " 好', '你 " 好', 'double quote blocks'],
    ['你 \' 好', '你 \' 好', 'single quote blocks'],
    ['你 ？ 好', '你，？，好', 'question mark is NOT in the blocked list'],
    ['你 ！ 好', '你，！，好', 'exclamation mark is NOT in the blocked list'],
    ['你 - 好', '你，-，好', 'hyphen is NOT in the blocked list'],
    ['见 https://a.b/c 好', '见，https://a.b/c，好', 'spaces beside a URL still convert from the CJK side'],
    ['见/ 好', '见/ 好', 'a slash directly beside the space blocks'],
    ['a 你', 'a，你', 'one-sided conversion before CJK after a Latin letter'],
    ['你 a', '你，a', 'one-sided conversion after CJK before a Latin letter'],
    ['😀 好', '😀，好', 'astral emoji neighbour is not CJK but is not blocked'],
    ['你 😀', '你，😀', 'CJK-adjacent space before an astral emoji converts'],
    ['你 𠀀 好', '你，𠀀，好', 'astral neighbour is counted as one element and is not CJK'],
    ['\uD800 好', '\uD800，好', 'lone surrogate neighbour is not CJK'],
  ];
  for (const [input, expected, label] of cases) {
    assert.equal(seam.convertExampleSpaces(input), expected, label);
    assert.equal(frozen.convertExampleSpacesToComma(input), expected, `fixture disagrees: ${label}`);
  }
  // String coercion quirks: `String(line ?? '')`.
  assert.equal(seam.convertExampleSpaces(null), '');
  assert.equal(seam.convertExampleSpaces(undefined), '');
  assert.equal(seam.convertExampleSpaces(0), '0');
  assert.equal(seam.convertExampleSpaces(42), '42');
  assert.equal(seam.convertExampleSpaces(false), 'false');
  assert.equal(seam.convertExampleSpaces({}), '[object Object]');
  assert.equal(seam.convertExampleSpaces(new String('你 好')), '你，好');
  assert.equal(seam.convertExampleSpaces(Symbol('x')), 'Symbol(x)');
  // String() coercion errors propagate unchanged.
  assert.throws(() => seam.convertExampleSpaces({ toString() { throw new Error('boom'); } }), /boom/);
  assert.throws(() => seam.convertExampleSpaces({ toString() { return {}; } }), TypeError);
  assert.throws(() => frozen.convertExampleSpacesToComma({ toString() { return {}; } }), TypeError);
});

test('cjkSpaceWarning is two-sided, numbers messages and dedupes hits', () => {
  const cases = [
    [['你 好'], SPACE_WARNING_1, 'space with CJK on both sides'],
    [['你\t好'], SPACE_WARNING_1, 'tab with CJK on both sides'],
    [['你  好'], null, 'double space has no CJK on both sides of either space'],
    [['你\ue000 好'], null, 'private use char is not CJK-like, so the pair is not two-sided'],
    [['你 hello'], null, 'two-sided rule: English on the right'],
    [['hello 你'], null, 'two-sided rule: English on the left'],
    [['Hello World'], null, 'pure English'],
    [['你\n好'], null, 'newline is not a separator'],
    [['你\u3000好'], null, 'ideographic space is not an ASCII separator'],
    [['你\u3000 好'], SPACE_WARNING_1, 'ASCII space between CJK-like chars'],
    [['你 \u3000好'], SPACE_WARNING_1, 'ideographic space counts as CJK-like'],
    [['\u3000 你'], SPACE_WARNING_1, 'leading ideographic space plus ASCII space'],
    [['你\u00A0 好'], null, 'NBSP is not CJK-like'],
    [['你 \u00A0好'], null, 'CJK + space + NBSP is not two-sided CJK'],
    [['你 好', 'ok', '我 们 都'], SPACE_WARNING_1_3, 'numbering skips clean messages'],
    [['你 好', '你 们'], '第 1、2 条消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。', 'consecutive hits'],
    [['你 好', '你  好'], SPACE_WARNING_1, 'second message has no two-sided space'],
    [['你 好 你 好'], SPACE_WARNING_1, 'one hit per message'],
    [[null, '你 好'], SPACE_WARNING_2, 'null message still consumes an index'],
    [[undefined, null, '你 好'], SPACE_WARNING_3, 'numbering counts empty entries'],
    [[123, '你 好'], SPACE_WARNING_2, 'non-string messages are coerced'],
    [['a 你'], null, 'space whose next char is CJK but prev is not is ignored'],
    [['你 a'], null, 'space whose prev char is CJK but next is not is ignored'],
    [[], null, 'empty list'],
    [null, null, 'null input'],
    [undefined, null, 'undefined input'],
    ['', null, 'empty string input'],
    [0, null, 'falsy non-string input'],
    [false, null, 'false input'],
    ['你 好', null, 'string input iterates code units, each char its own message'],
    ['你\t好', null, 'string input never sees a two-sided space'],
    [{}, null, 'object without length'],
    [42, null, 'number without length'],
    [{ length: 1, 0: '你 好' }, SPACE_WARNING_1, 'arraylike object works (no Array.isArray check)'],
    [{ length: 2, 0: '你 好', 1: 'ok' }, SPACE_WARNING_1, 'arraylike object with extra messages'],
    [{ length: 0 }, null, 'empty arraylike object'],
    [[Symbol('s')], null, 'String() coercion of a symbol does not throw'],
    [[new String('你 好')], SPACE_WARNING_1, 'String object element is coerced'],
  ];
  for (const [input, expected, label] of cases) {
    assert.equal(seam.cjkSpaceWarning(input), expected, label);
    assert.equal(frozen.findCjkSpaceWarning(input), expected, `fixture disagrees: ${label}`);
  }
  assert.equal(seam.cjkSpaceWarning([...Array.from({ length: 9 }, () => 'ok'), '你 好']), SPACE_WARNING_10);
  // Non-array-like coercion errors propagate.
  assert.throws(() => seam.cjkSpaceWarning([{ toString() { throw new Error('boom'); } }]), /boom/);
  assert.throws(() => seam.cjkSpaceWarning([{ toString() { return {}; } }]), TypeError);
});

test('splitBoundaryWarning boundary matrix keeps punctuation, threshold and exemption quirks', () => {
  const nonTerminal = [',', '，', '、', '；', ';', ':', '：'];
  for (const punct of nonTerminal) {
    assert.equal(seam.splitBoundaryWarning([`好${punct}`, '继续']), SPLIT_12, `non-terminal punctuation ${punct}`);
  }
  // Non-terminal punctuation warns even when the next message is English/no-CJK.
  assert.equal(seam.splitBoundaryWarning(['好,', 'Hello']), SPLIT_12);
  assert.equal(seam.splitBoundaryWarning([',', '继续']), SPLIT_12, 'punctuation-only previous message still warns');

  // Terminal punctuation and characters outside the regex do not warn.
  for (const punct of ['。', '.', '！', '？', '…', '!', '?']) {
    assert.equal(seam.splitBoundaryWarning([`好${punct}`, '继续']), null, `terminal punctuation ${punct}`);
  }
  // Incomplete tail requires next message to start with a CJK-like char.
  assert.equal(seam.splitBoundaryWarning(['我懂了', '继续']), SPLIT_12, 'incomplete tail at UTF-16 length 3');
  assert.equal(seam.splitBoundaryWarning(['懂了', '继续']), null, '2-char tail is below the threshold');
  assert.equal(seam.splitBoundaryWarning(['在吗', '继续']), null, '2-char tail below threshold despite 吗');
  assert.equal(seam.splitBoundaryWarning(['你在吗', '继续']), SPLIT_12, '3-char tail at threshold');
  assert.equal(seam.splitBoundaryWarning(['了', '继续']), null, '1-char tail');
  assert.equal(seam.splitBoundaryWarning(['𠀀了', '继续']), SPLIT_12, 'astral + 了 is 3 UTF-16 units, so it warns');
  assert.equal(seam.splitBoundaryWarning(['𠀀', '继续']), null, 'astral alone is 2 UTF-16 units');
  assert.equal(seam.splitBoundaryWarning(['我懂了', 'ok']), null, 'incomplete tail needs CJK next');
  assert.equal(seam.splitBoundaryWarning(['我懂了', '𠀀好']), null, 'astral next does not start with CJK');
  assert.equal(seam.splitBoundaryWarning(['我懂了', '😀']), null, 'emoji next does not start with CJK');
  assert.equal(seam.splitBoundaryWarning(['我懂了', 'A好']), null, 'Latin next does not start with CJK');
  assert.equal(seam.splitBoundaryWarning(['我懂了', '\u00A0好']), SPLIT_12, 'NBSP is whitespace, so trim exposes the CJK first char');
  assert.equal(seam.splitBoundaryWarning(['我懂了', ' 继续']), SPLIT_12, 'next is trimmed before the first-char check');
  assert.equal(seam.splitBoundaryWarning(['如果', '继续']), null, 'ends with 果, no tail match');

  // Complete short phrases are exempt only as exact trimmed strings.
  const completeShort = ['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦'];
  for (const phrase of completeShort) {
    assert.equal(seam.splitBoundaryWarning([phrase, '继续']), null, `exempt complete phrase: ${phrase}`);
    assert.equal(seam.splitBoundaryWarning([`  ${phrase}  `, '   继续']), null, `trimmed exempt phrase: ${phrase}`);
  }
  // Adding punctuation defeats the exemption, because the set compares the trimmed string.
  assert.equal(seam.splitBoundaryWarning(['好的，', '继续']), SPLIT_12, 'punctuated 好的 is not exempt');
  assert.equal(seam.splitBoundaryWarning(['好的。', '继续']), null, '好的。 is neither exempt nor a warning');
  assert.equal(seam.splitBoundaryWarning(['抱歉,', '继续']), SPLIT_12, 'punctuated 抱歉 is not exempt');

  // Trims, nulls and empty entries.
  assert.equal(seam.splitBoundaryWarning(['  我懂了  ', '  继续  ']), SPLIT_12);
  assert.equal(seam.splitBoundaryWarning(['   ', '继续']), null);
  assert.equal(seam.splitBoundaryWarning(['我懂了', '   ']), null);
  assert.equal(seam.splitBoundaryWarning([null, '继续']), null);
  assert.equal(seam.splitBoundaryWarning(['我懂了', null]), null);
  assert.equal(seam.splitBoundaryWarning([]), null);
  assert.equal(seam.splitBoundaryWarning(['我懂了']), null, 'single message returns null');
  assert.equal(seam.splitBoundaryWarning(null), null);
  assert.equal(seam.splitBoundaryWarning(undefined), null);
  assert.equal(seam.splitBoundaryWarning('好，继续'), null, 'string input is not an array');
  assert.equal(seam.splitBoundaryWarning({ length: 2, 0: '好，', 1: '继续' }), null, 'arraylike object is not an array');
  assert.equal(seam.splitBoundaryWarning(['x', , '继续']), null, 'sparse hole is an empty message and breaks the chain');

  // Multiple and adjacent boundaries, including duplicate message numbers.
  assert.equal(seam.splitBoundaryWarning(['我懂了', '继续', '好，', '嗯']), SPLIT_1_2__3_4);
  assert.equal(seam.splitBoundaryWarning(['好，', '好，', '继续']), SPLIT_1_2__2_3, 'adjacent boundaries repeat the shared message number');
  const ten = [...Array.from({ length: 9 }, () => 'ok'), '好，', '继续'];
  assert.equal(seam.splitBoundaryWarning(ten), SPLIT_10_11);
  // Punctuation-only previous message still passes the length gate via punctuation.
  assert.equal(seam.splitBoundaryWarning(['：', '嗯']), SPLIT_12);

  // Coercion errors propagate from either side of the pair.
  assert.throws(() => seam.splitBoundaryWarning([{ toString() { throw new Error('boom'); } }, '继续']), /boom/);
  assert.throws(() => seam.splitBoundaryWarning(['好，', { toString() { throw new Error('boom'); } }]), /boom/);
  assert.throws(() => seam.splitBoundaryWarning([{ toString() { return {}; } }, '继续']), TypeError);
});

test('one-sided conversion vs two-sided warning is visible side by side', () => {
  assert.equal(seam.convertExampleSpaces('你 hello'), '你，hello');
  assert.equal(seam.cjkSpaceWarning(['你 hello']), null);
  assert.equal(seam.convertExampleSpaces('hello 你'), 'hello，你');
  assert.equal(seam.cjkSpaceWarning(['hello 你']), null);
  assert.equal(seam.convertExampleSpaces('你  好'), '你，，好');
  assert.equal(seam.cjkSpaceWarning(['你  好']), null);
});

test('arraylike and string inputs differ between the two warning functions', () => {
  const arraylike = Object.assign({ length: 2 }, ['好，', '继续']);
  assert.equal(seam.cjkSpaceWarning(Object.assign({ length: 1 }, ['你 好'])), SPACE_WARNING_1);
  assert.equal(seam.splitBoundaryWarning(arraylike), null);
  assert.equal(seam.cjkSpaceWarning('好，继续'), null);
  assert.equal(seam.splitBoundaryWarning('好，继续'), null);
  assert.equal(seam.cjkSpaceWarning('你 好'), null);
  // A real array is required for the split warning.
  assert.equal(seam.splitBoundaryWarning(['好，', '继续']), SPLIT_12);
});

test('differential against the frozen fixture: values and thrown errors with fresh inputs', () => {
  const cases = [
    ['cjk: han', () => ['你']],
    ['cjk: boundary', () => ['\u4DBF']],
    ['cjk: astral', () => ['\u{20000}']],
    ['cjk: falsy', () => [undefined]],
    ['cjk: number throws', () => [1]],
    ['cjk: object throws', () => [{}]],
    ['cjk: symbol throws', () => [Symbol('s')]],
    ['cjk: String object', () => [new String('你')]],
    ['cjk: multi codepoint', () => ['你a']],
    ['convert: null', () => [null]],
    ['convert: undefined', () => [undefined]],
    ['convert: zero', () => [0]],
    ['convert: false', () => [false]],
    ['convert: object', () => [{ a: 1 }]],
    ['convert: String object', () => [new String('你 好')]],
    ['convert: symbol', () => [Symbol('s')]],
    ['convert: fullwidth/nbsp', () => ['你\u3000 \u00A0好']],
    ['convert: blocked', () => ['你 / 好']],
    ['convert: throwing toString', () => [{ toString() { throw new Error('boom'); } }]],
    ['convert: non-primitive toString', () => [{ toString() { return {}; } }]],
    ['space: warning', () => [['你 好']]],
    ['space: no warning', () => [['你  好']]],
    ['space: numbering', () => [[null, '你 好']]],
    ['space: string input', () => ['你 好']],
    ['space: arraylike', () => [{ length: 1, 0: '你 好' }]],
    ['space: symbol element', () => [[Symbol('s')]]],
    ['space: throwing element', () => [[{ toString() { throw new Error('boom'); } }]]],
    ['split: warning', () => [['好，', '继续']]],
    ['split: threshold', () => [['𠀀了', '继续']]],
    ['split: exempt', () => [['好的', '继续']]],
    ['split: string input', () => ['好，继续']],
    ['split: arraylike', () => [{ length: 2, 0: '好，', 1: '继续' }]],
    ['split: throwing first', () => [[{ toString() { throw new Error('boom'); } }, '继续']]],
    ['split: throwing second', () => [['好，', { toString() { throw new Error('boom'); } }]]],
    ['split: non-primitive second', () => [['好，', { toString() { return {}; } }]]],
  ];
  const pairs = [
    [frozen.isCjkLikeChar, seam.cjkLikeChar, 'cjk'],
    [frozen.convertExampleSpacesToComma, seam.convertExampleSpaces, 'convert'],
    [frozen.findCjkSpaceWarning, seam.cjkSpaceWarning, 'space'],
    [frozen.findSplitBoundaryWarning, seam.splitBoundaryWarning, 'split'],
  ];
  let compared = 0;
  for (const [label, make] of cases) {
    for (const [frozenFn, seamFn, prefix] of pairs) {
      if (!label.startsWith(prefix)) continue;
      differential(frozenFn, seamFn, make, label);
      compared++;
    }
  }
  assert.equal(compared, cases.length);
});

test('frozen differential detects drift (negative control, harness is not vacuous)', () => {
  const text = fs.readFileSync(new URL('./fixtures/persona-text-baseline.mjs', import.meta.url), 'utf8');
  const build = (source) => vm.runInNewContext(
    source.replace(/^export /gm, '') + '\n;({ isCjkLikeChar, convertExampleSpacesToComma, findCjkSpaceWarning, findSplitBoundaryWarning });',
  );
  const original = build(text);
  assert.deepEqual(outcome(seam.cjkLikeChar, () => ['\u4DBF']), outcome(original.isCjkLikeChar, () => ['\u4DBF']));
  const narrowed = build(text.replace('0x4DBF', '0x4DBE'));
  assert.notEqual(seam.cjkLikeChar('\u4DBF'), narrowed.isCjkLikeChar('\u4DBF'));

  const reworded = build(text.replace('真人一般不这么打', '真人一般不这样打'));
  assert.notEqual(seam.cjkSpaceWarning(['你 好']), reworded.findCjkSpaceWarning(['你 好']));
});

test('seeded differential sweep: conversion and both warnings stay byte-identical', () => {
  let seed = 20261020;
  const draw = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const pick = (items) => items[draw() % items.length];
  const alphabet = [
    '你', '好', '的', '了', '吗', '我', '们', '，', '、', '。', '；', '：', '？', '！',
    'A', 'b', 'Z', '3', '%', '-', '_', '😀', '𠀀', '\uD800', '\uDC00', '\u3000', '\u00A0', '\n',
    ' ', ' ', ' ', '\t', '\t', ',', '.', '/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ';', ':', '~', '*', '+',
  ];
  const randomText = (maxCodePoints) => Array.from(
    { length: draw() % (maxCodePoints + 1) },
    () => pick(alphabet),
  ).join('');

  let compared = 0;
  for (let round = 0; round < 400; round++) {
    const text = randomText(12);
    differential(frozen.convertExampleSpacesToComma, seam.convertExampleSpaces, () => [text], `sweep convert #${round}: ${JSON.stringify(text)}`);
    compared++;

    const messages = Array.from({ length: draw() % 6 }, () => {
      const kind = draw() % 12;
      if (kind === 0) return null;
      if (kind === 1) return undefined;
      if (kind === 2) return draw() % 1000;
      if (kind === 3) return '';
      return randomText(8);
    });
    differential(frozen.findCjkSpaceWarning, seam.cjkSpaceWarning, () => [messages.slice()], `sweep space #${round}`);
    differential(frozen.findSplitBoundaryWarning, seam.splitBoundaryWarning, () => [messages.slice()], `sweep split #${round}`);
    compared += 2;
  }
  // A dense second phase that reliably hits both warning paths.
  for (let round = 0; round < 150; round++) {
    const part = () => pick(['你', '好', '了', '的', '吗', '，', '、', '。', '；', 'A', '😀', '𠀀', ' ', '\t', '\n', '\u3000', '\u00A0', ',', ';', ':', '好的', '我懂了', '然后', '继续']);
    const messages = Array.from({ length: 2 + (draw() % 3) }, part);
    differential(frozen.findCjkSpaceWarning, seam.cjkSpaceWarning, () => [messages.slice()], `dense space #${round}`);
    differential(frozen.findSplitBoundaryWarning, seam.splitBoundaryWarning, () => [messages.slice()], `dense split #${round}`);
    compared += 2;
  }
  assert.equal(compared, 1500);
});
