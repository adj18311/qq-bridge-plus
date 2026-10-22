// Direct matrix test for the tool-log seam (src/core/tool-log-format.mjs).
// Oracle: scripts/fixtures/tool-log-format-baseline.mjs — a frozen literal copy of
// bridge.start.js lines 12021-12057; it never imports the production module.
// Run: node scripts/test-tool-log-format.mjs
import assert from 'node:assert/strict';
import * as toolLogFormat from '../src/core/tool-log-format.mjs';
import { createBaseline } from './fixtures/tool-log-format-baseline.mjs';

const { redactToolLogValue, formatToolLogArgs } = toolLogFormat;
let checks = 0;
const eq = (label, actual, expected) => { assert.equal(actual, expected, label); checks += 1; };
const throws = (label, fn, name) => { assert.throws(fn, (e) => e.name === name, label); checks += 1; };

// Faithful UTF-16 truncator: same contract as the injected bridge truncateText.
function truncateText(value, max) {
  const s = String(value ?? '');
  const limit = Number.isFinite(Number(max)) ? Math.max(0, Math.floor(Number(max))) : 0;
  if (limit === 0) return '';
  if (s.length <= limit) return s;
  let cut = limit;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  if (cut <= 0) {
    const first = s.charCodeAt(0);
    const second = s.charCodeAt(1);
    cut = (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) ? 2 : 1;
  }
  return s.slice(0, cut);
}
const caps = (redactSensitiveText = (s) => s, truncate = truncateText) => ({ redactSensitiveText, truncateText: truncate });
const base = (c = caps()) => createBaseline(c);

// Private SENSITIVE_ARG_KEYS must stay unexported: exactly the two mechanical names.
eq('exports only the two functions', Object.keys(toolLogFormat).sort().join(','), 'formatToolLogArgs,redactToolLogValue');

// Explicit output contract.
eq('null args', formatToolLogArgs(null, caps()), null);
eq('undefined args', formatToolLogArgs(undefined, caps()), null);
eq('undefined value', redactToolLogValue(undefined, caps()), undefined);
eq('null value', redactToolLogValue(null, caps()), null);
eq('empty object', formatToolLogArgs({}, caps()), '{}');
eq('sensitive mixed case', formatToolLogArgs({ ToKeN: 'marker-1' }, caps()), '{"ToKeN":"***"}');
eq('header/token key forms', formatToolLogArgs({ 'X-Agent-Token': 'm', X_Agent_Token: 'n' }, caps()), '{"X-Agent-Token":"***","X_Agent_Token":"***"}');
eq('whitespace key untouched', formatToolLogArgs({ ' token ': 'marker-2' }, caps()), '{" token ":"marker-2"}');
eq('nested redaction', formatToolLogArgs({ a: [{ Password: 'p' }, 'plain'] }, caps()), '{"a":[{"Password":"***"},"plain"]}');
eq('skip proto keys', formatToolLogArgs('{"__proto__":{"polluted":1},"constructor":2,"prototype":3,"ok":4}', caps()), '{"ok":4}');
eq('no prototype pollution', ({}).polluted, undefined);
eq('null prototype output', Object.getPrototypeOf(redactToolLogValue({ a: 1 }, caps())), null);
eq('array stays array', Array.isArray(redactToolLogValue([1], caps())), true);
eq('array hole preserved', 0 in redactToolLogValue([, 1], caps()), false);
eq('sparse array text', formatToolLogArgs([, 1], caps()), '[null,1]');
eq('number', formatToolLogArgs(42, caps()), '42');
eq('NaN', formatToolLogArgs(NaN, caps()), 'null');
eq('bigint', formatToolLogArgs(10n, caps()), '10');
throws('nested bigint String(null-proto) TypeError', () => formatToolLogArgs({ a: 10n }, caps()), 'TypeError');
eq('nested undefined dropped', formatToolLogArgs({ a: undefined, b: 1 }, caps()), '{"b":1}');

// Four JSON.parse passes, no fifth.
const nested4 = JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify('x'))));
eq('four json layers parsed', formatToolLogArgs(nested4, caps()), '"x"');
eq('five json layers stop at four', formatToolLogArgs(JSON.stringify(nested4), caps()), '"\\"x\\""');
eq('malformed json falls back to text', formatToolLogArgs('{"a":1', caps()), JSON.stringify('{"a":1'));
eq('quoted json string', formatToolLogArgs('"abc"', caps()), '"abc"');

// 2000/2001 boundary counted in UTF-16 code units (astral chars are 2 units).
const EMOJI = '\u{1F600}';
const at2000 = EMOJI.repeat(999);
const at2001 = EMOJI.repeat(999) + 'a';
const text2000 = JSON.stringify(at2000);
const text2001 = JSON.stringify(at2001);
eq('utf16 boundary sizes', [text2000.length, text2001.length].join(','), '2000,2001');
eq('2000 chars untouched', formatToolLogArgs(at2000, caps()), text2000);
eq('2001 chars truncated at 2000', formatToolLogArgs(at2001, caps()), text2001.slice(0, 2000) + '…(truncated)');
let truncCalls = 0;
eq('no truncation at exactly 2000', formatToolLogArgs(at2000, caps((s) => s, () => { truncCalls += 1; return 'CUT'; })), text2000);
eq('truncator not called at 2000', truncCalls, 0);

// Truncator receives the post-stringify text and max 2000; suffix is exact.
const longInput = 'z'.repeat(2001);
const longText = JSON.stringify(longInput);
let truncArgs = null;
eq('suffix exact', formatToolLogArgs(longInput, caps((s) => s, (value, max) => { truncArgs = [value, max]; return 'HEAD'; })), 'HEAD…(truncated)');
eq('truncator max', truncArgs[1], 2000);
eq('truncator argument identity', truncArgs[0], longText);
eq('truncator argument is utf16 sized', truncArgs[0].length, 2003);

// Redactor trace order; recursion re-reads the same capabilities object every time.
const traced = [];
eq('redactor trace output', formatToolLogArgs({ b: 'y', a: ['x'] }, caps((s) => { traced.push(s); return s.toUpperCase(); })), '{"b":"Y","a":["X"]}');
eq('redactor trace order', traced.join('|'), 'y|x');
let reads = 0;
const fresh = {};
Object.defineProperty(fresh, 'redactSensitiveText', { get() { reads += 1; return (s) => `<${reads}:${s}>`; } });
Object.defineProperty(fresh, 'truncateText', { get() { return truncateText; } });
eq('capabilities getter read per string', formatToolLogArgs({ a: 'x', b: { c: 'y' } }, fresh), '{"a":"<1:x>","b":{"c":"<2:y>"}}');
eq('capabilities getter count', reads, 2);
let reads2 = 0;
const live = { get value() { reads2 += 1; return reads2; } };
eq('data getter first call', formatToolLogArgs(live, caps()), '{"value":1}');
eq('data getter fresh second call', formatToolLogArgs(live, caps()), '{"value":2}');
eq('data getter reads', reads2, 2);

// Old error paths stay old: cyclic recursion RangeError, JSON.stringify→undefined TypeError.
const cyclic = {};
cyclic.self = cyclic;
throws('cyclic RangeError', () => formatToolLogArgs(cyclic, caps()), 'RangeError');
throws('function input TypeError', () => formatToolLogArgs(() => 1, caps()), 'TypeError');
throws('symbol input TypeError', () => formatToolLogArgs(Symbol('s'), caps()), 'TypeError');

// Frozen differential matrix: same injected capabilities, same output/error names.
const inputs = [
  null, undefined, 0, -0, 42, NaN, Infinity, 10n, true, false, '', '"abc"', '"null"', 'null',
  '{"a":1', 'not json', '\\"x\\"', {}, [], [1, 'x'], [, 1], { a: { b: { c: { d: 'token' } } } },
  { ToKeN: 't', ' token ': 'keep', authorization: 'a', nested: [{ Api_Key: 'k' }] },
  '{"__proto__":{"p":1},"constructor":2,"prototype":3,"ok":4}', { constructor: 1, __proto__: 2 },
  new Date(0), { date: new Date(0) }, { a: 10n }, { a: undefined, b: [undefined] },
  () => 1, Symbol('s'), { toJSON() { throw new Error('nope'); } },
  Object.assign(Object.create({ inherited: 1 }), { own: 2 }), nested4,
];
for (const input of inputs) {
  let mo, me, bo, be;
  try { mo = formatToolLogArgs(input, caps()); } catch (e) { me = e.name; }
  try { bo = base().sanitizeToolArgs(input); } catch (e) { be = e.name; }
  eq(`diff output [${typeof input}]`, mo, bo);
  eq(`diff error [${typeof input}]`, me, be);
}
for (const input of [{ a: 1 }, { ToKeN: 'x' }, { ' token ': 'keep' }, { nested: { deep: ['a'] } }, [1, ['b']], [, 1], new Date(0), Object.assign(Object.create({ inherited: 1 }), { own: 2 })]) {
  const mo = redactToolLogValue(input, caps());
  const bo = base().redactSensitive(input);
  eq(`diff value [${typeof input}]`, JSON.stringify(mo), JSON.stringify(bo));
  eq(`diff prototype [${typeof input}]`, Object.getPrototypeOf(mo), Object.getPrototypeOf(bo));
}

console.log(`test-tool-log-format: PASS (${checks} checks)`);
