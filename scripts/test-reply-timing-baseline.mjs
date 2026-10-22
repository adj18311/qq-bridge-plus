// Preparation only: compare frozen expectations directly with unchanged bridge functions.
// The same comparisons remain usable when those functions become thin adapters.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { looksLikeUnfinished } from '../src/v2-wait.js';
import { createLegacyReplyTiming } from './fixtures/legacy-reply-timing.mjs';

const NOW = 40000;
function capture(fn) {
  try { return { value: structuredClone(fn()), error: null }; }
  catch (e) { return { error: { name: e.name, message: e.message } }; }
}
function inputs(wait = {}, state = {}, ticks = [NOW]) {
  const trace = [];
  let i = 0;
  const clock = { now() { const at = ticks[Math.min(i++, ticks.length - 1)]; trace.push(['now', at]); return at; } };
  const observedWait = new Proxy(wait, { get(target, key) { trace.push(['wait', String(key)]); return Reflect.get(target, key); } });
  const socialV2 = { get wait() { trace.push(['cfg', 'wait']); return observedWait; } };
  const cfg = { get socialV2() { trace.push(['cfg', 'socialV2']); return socialV2; } };
  return { cfg, socialV2, state, clock, trace };
}
async function withBridge(run) {
  let readClock = () => NOW;
  class ClockDate extends Date { static now() { return readClock(); } }
  const h = await bridgeHarness({ globals: { Date: ClockDate } });
  const originalSocial = Object.getOwnPropertyDescriptor(h.cfg, 'socialV2');
  const use = (input) => {
    Object.defineProperty(h.cfg, 'socialV2', { configurable: true, get: () => input.cfg.socialV2 });
    readClock = () => input.clock.now();
  };
  try { await run(h, use); }
  finally {
    Object.defineProperty(h.cfg, 'socialV2', originalSocial);
    await h.close();
  }
}
function compare(h, use, name, factory) {
  // Each side gets fresh getters/coercion state and a fresh clock sequence.
  const oracle = factory();
  const actual = factory();
  const baseline = createLegacyReplyTiming({ cfg: oracle.cfg, Date: oracle.clock, looksLikeUnfinished });
  const expected = capture(() => baseline[name](oracle.state));
  use(actual);
  const result = capture(() => h[name](actual.state));
  assert.deepEqual(result, expected);
  assert.deepEqual(actual.trace, oracle.trace, 'preserve ordered reads, duplicates, coercions and clock calls');
  return { result, trace: actual.trace };
}

test('frozen bodies retain hashes verified against the pre-extraction bridge', () => {
  const fixture = fs.readFileSync(new URL('./fixtures/legacy-reply-timing.mjs', import.meta.url), 'utf8');
  const hashes = {
    suggestQuietMsV2: '973964a82fbf199d63195c8c043e4e1f459f17966742ec04d71fe11bd7f3a4b0',
    replyTimingV2: 'fe23fd3d22765fee06435b162ef120e80011b91381a42c27e5b3c79c5f014b56',
  };
  for (const [name, expected] of Object.entries(hashes)) {
    // These snapshot bodies contain no nested function declarations at this indentation.
    const extract = (text) => {
      const start = text.indexOf(`  function ${name}(st) {`);
      assert.notEqual(start, -1);
      const end = text.indexOf('\n  }', start);
      assert.notEqual(end, -1);
      return text.slice(start, end + 4).replaceAll('\r\n', '\n');
    };
    assert.equal(crypto.createHash('sha256').update(extract(fixture.replaceAll('\r\n', '\n'))).digest('hex'), expected);
  }
});

test('direct differential table: absent history, unfinished text, burst and exact 15s boundary', () => withBridge((h, use) => {
  const cases = [
    [undefined, undefined, 8000], [{ defaultQuietMs: 0 }, null, 8000],
    [{ defaultQuietMs: -2 }, {}, -2], [{ defaultQuietMs: Infinity }, {}, Infinity],
    [{ defaultQuietMs: '1234' }, { recentMessages: [null, { isSelf: true }] }, 1234],
    [{}, { recentMessages: [{ tail: '然后', time: NOW }] }, 12000],
    [{}, { recentMessages: [{ tail: '然后。', time: NOW }] }, 8000],
    [{}, { recentMessages: Array.from({ length: 3 }, () => ({ text: 'done', time: NOW - 14999 })) }, 12000],
    [{}, { recentMessages: Array.from({ length: 3 }, () => ({ text: 'done', time: NOW - 15000 })) }, 8000],
    [{}, { recentMessages: [{ text: 'done', time: NOW }, { text: 'done', time: NOW }, { isSelf: true, time: NOW }] }, 8000],
  ];
  for (const [wait, state, expected] of cases) {
    const { result } = compare(h, use, 'suggestQuietMsV2', () => inputs(wait, structuredClone(state)));
    assert.equal(result.value, expected);
  }
}));

test('reply clamps and remaining time retain fallback, rounding and contradictory-limit behavior', () => withBridge((h, use) => {
  const cases = [
    [{}, { lastIncomingAt: NOW - 3000 }, 10000, 7000],
    [{ minQuietAfterNewMs: 0, defaultQuietMs: 500.6 }, { lastIncomingAt: NOW - 100 }, 501, 401],
    [{ minQuietAfterNewMs: -1, defaultQuietMs: -2 }, {}, 0, 0],
    [{ minQuietAfterNewMs: NaN, maxMs: 0 }, {}, 10000, 10000],
    [{ minQuietAfterNewMs: 0, defaultQuietMs: Infinity }, {}, 120000, 120000],
    [{ minQuietAfterNewMs: 200000, maxMs: 1 }, {}, 200000, 200000],
    [{ minQuietAfterNewMs: 0, maxMs: 1000, defaultQuietMs: 8000 }, {}, 1000, 1000],
    [{}, { lastIncomingAt: NOW + 100 }, 10000, 10000],
    [{}, { lastIncomingAt: NOW - 20000 }, 10000, 0],
    [{}, { lastIncomingAt: NaN }, 10000, 10000],
  ];
  for (const [wait, state, quietMs, remainingQuietMs] of cases) {
    const { result } = compare(h, use, 'replyTimingV2', () => inputs(wait, structuredClone(state)));
    assert.deepEqual(result.value, { purpose: 'reply', quietMs, remainingQuietMs });
  }
  assert.equal(compare(h, use, 'replyTimingV2', () => inputs({}, null)).result.error.name, 'TypeError');
}));

test('clock is read per eligible message, never cached or skipped after the third hit', () => withBridge((h, use) => {
  const factory = () => inputs({}, { recentMessages: Array.from({ length: 4 }, () => ({ text: 'done', time: 25001 })) }, [40000, 40001, 40002, 40003]);
  const { result, trace } = compare(h, use, 'suggestQuietMsV2', factory);
  assert.equal(result.value, 8000);
  assert.deepEqual(trace.filter(x => x[0] === 'now'), [['now',40000], ['now',40001], ['now',40002], ['now',40003]]);
  const burst = compare(h, use, 'suggestQuietMsV2', () => inputs({}, { recentMessages: Array.from({ length: 5 }, () => ({ text: 'done', time: NOW })) }));
  assert.equal(burst.trace.filter(x => x[0] === 'now').length, 5);
  const unfinished = compare(h, use, 'suggestQuietMsV2', () => inputs({}, { recentMessages: [{ text: '等一下', time: NOW }] }));
  assert.equal(unfinished.trace.filter(x => x[0] === 'now').length, 0);
}));

test('hot config, coercions, repeated history reads and thrown errors retain their order', () => withBridge((h, use) => {
  const factory = () => {
    const wait = { minQuietAfterNewMs: 0, defaultQuietMs: 2000, get maxMs() { wait.defaultQuietMs = 3000; return 9000; } };
    const input = inputs(wait, {});
    let reads = 0;
    Object.defineProperty(input.state, 'recentMessages', { get() { input.trace.push(['history', ++reads]); return [{ text: 'done', time: { valueOf() { input.trace.push(['coerce', 'time']); return 1; } } }]; } });
    input.state.lastIncomingAt = { valueOf() { input.trace.push(['coerce', 'incoming']); return NOW - 100; } };
    return input;
  };
  const { result, trace } = compare(h, use, 'replyTimingV2', factory);
  assert.equal(result.value.quietMs, 3000);
  assert.deepEqual(trace.filter(x => x[0] === 'wait').map(x => x[1]), ['minQuietAfterNewMs', 'maxMs', 'defaultQuietMs']);
  assert.deepEqual(trace.filter(x => x[0] === 'history'), [['history',1], ['history',2]]);
  compare(h, use, 'replyTimingV2', () => inputs({ get minQuietAfterNewMs() { throw new Error('fixture conversion blocked'); } }, {}));
}));

test('real bridge prompt consumer uses the timing calculation', () => withBridge((h) => {
  // Restore a normal config for the full prompt consumer, not just the direct functions.
  const st = h.getSocialV2State('private:123');
  st.recentMessages = [{ text: 'done', time: NOW - 500 }];
  st.lastIncomingAt = NOW - 3000;
  h.cfg.socialV2.wait.defaultQuietMs = 14000;
  const result = h.replyTimingV2(st, 'private:123');
  assert.equal(result.quietMs, 14000);
  assert.equal(result.remainingQuietMs, 11000);
  assert.match(h.buildWakePromptV2('private:123', 'question'), /quietMs=14000/);
  assert.match(h.buildWakePromptV2('private:123', 'question'), /还差约 11 秒静默/);
}));

test('real group prompt consumer applies the 3s window measured from lastIncomingAt', () => withBridge((h) => {
  const st = h.getSocialV2State('group:456');
  st.recentMessages = [{ text: 'done', time: NOW - 500 }];
  st.lastIncomingAt = NOW - 1000;
  h.cfg.socialV2.wait.minQuietAfterNewMs = 0;
  h.cfg.socialV2.wait.defaultQuietMs = 14000;
  // Frozen window/remaining would be 14000/13000; the approved group policy is a fixed 3s window
  // measured against the real lastIncomingAt.
  const frozen = h.replyTimingV2(st);
  assert.equal(frozen.quietMs, 14000);
  assert.equal(frozen.remainingQuietMs, 13000);
  const result = h.replyTimingV2(st, 'group:456');
  assert.equal(result.quietMs, 3000);
  assert.equal(result.remainingQuietMs, 2000);
  const prompt = h.buildWakePromptV2('group:456', 'question');
  assert.match(prompt, /quietMs=3000/);
  assert.match(prompt, /还差约 2 秒静默/);
}));

test('group prompt consumer yields remaining 0 when the old window is under 3s but messages have been quiet 4s', () => withBridge((h) => {
  const st = h.getSocialV2State('group:456');
  st.recentMessages = [{ text: 'done', time: NOW - 4000 }];
  st.lastIncomingAt = NOW - 4000;
  h.cfg.socialV2.wait.minQuietAfterNewMs = 0;
  h.cfg.socialV2.wait.defaultQuietMs = 1000;
  // The frozen window (1s) is shorter than the group window and its remaining is already clamped
  // to 0; deriving elapsed as quietMs - remaining (1s) would claim 2s are still missing. The real
  // lastIncomingAt has been quiet for 4s, so the group remaining must be 0.
  const frozen = h.replyTimingV2(st);
  assert.equal(frozen.quietMs, 1000);
  assert.equal(frozen.remainingQuietMs, 0);
  const result = h.replyTimingV2(st, 'group:456');
  assert.equal(result.quietMs, 3000);
  assert.equal(result.remainingQuietMs, 0);
  const prompt = h.buildWakePromptV2('group:456', 'question');
  assert.match(prompt, /还差约 0 秒静默/);
}));

test('seeded mixed-history and numeric-edge differential matrix', () => withBridge((h, use) => {
  let seed = 20261020;
  const draw = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const values = [undefined, null, 0, -1, NaN, Infinity, '500.6', 999, 120000, 200000];
  for (let index = 0; index < 120; index++) {
    const wait = Object.fromEntries(['defaultQuietMs', 'minQuietAfterNewMs', 'maxMs'].map(key => [key, values[draw() % values.length]]));
    const state = { lastIncomingAt: values[draw() % values.length], recentMessages: Array.from({ length: draw() % 8 }, () => {
      const sample = draw();
      return sample % 5 === 0 ? null : { isSelf: sample % 3 === 0, tail: sample % 7 === 0 ? '然后' : 'done', time: NOW - sample % 30000 };
    }) };
    for (const name of ['suggestQuietMsV2', 'replyTimingV2']) compare(h, use, name, () => inputs(structuredClone(wait), structuredClone(state), [NOW, NOW + 1, NOW + 2]));
  }
}));

test('negative controls detect cached time and reordered config reads in memory', () => {
  const text = fs.readFileSync(new URL('./fixtures/legacy-reply-timing.mjs', import.meta.url), 'utf8');
  const build = (source) => vm.runInNewContext(source.replace('export function ', 'function ') + '\ncreateLegacyReplyTiming');
  const factory = () => inputs({}, { recentMessages: Array.from({ length: 3 }, () => ({ text: 'done', time: 25001 })) }, [40000,40001,40002]);
  const run = (make) => { const x = factory(); const fn = make({ cfg: x.cfg, Date: x.clock, looksLikeUnfinished }); return { value: fn.suggestQuietMsV2(x.state), trace: x.trace }; };
  const cached = text.replace('const burst = recent.filter', 'const cachedNow = Date.now();\n    const burst = recent.filter').replace('Date.now() - Number(m.time', 'cachedNow - Number(m.time');
  assert.notEqual(cached, text);
  assert.notDeepEqual(run(build(cached)), run(createLegacyReplyTiming));
  const earlyDefault = text.replace('const minimum = Number(cfg.socialV2?.wait?.minQuietAfterNewMs);', 'Number(cfg.socialV2?.wait?.defaultQuietMs);\n    const minimum = Number(cfg.socialV2?.wait?.minQuietAfterNewMs);');
  const runReply = (make) => { const x = inputs({}, {}); const fn = make({ cfg: x.cfg, Date: x.clock, looksLikeUnfinished }); fn.replyTimingV2(x.state); return x.trace; };
  assert.notDeepEqual(runReply(build(earlyDefault)), runReply(createLegacyReplyTiming));
});
