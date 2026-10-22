// Direct policy test for the extracted reply-timing module.
// Oracle = the frozen 2026-10-20 factory snapshot (scripts/fixtures/legacy-reply-timing.mjs).
// The production timing module is never imported to derive expectations: both sides get fresh
// fixtures and the frozen factory is the only oracle. No VM copy of bridge.js is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeUnfinished } from '../src/v2-wait.js';
import { createLegacyReplyTiming } from './fixtures/legacy-reply-timing.mjs';
import * as timing from '../src/core/reply-timing.mjs';

const NOW = 40000;
const ORACLE_NAME = { suggestQuietMs: 'suggestQuietMsV2', replyTiming: 'replyTimingV2' };

// Both sides build their own trace, clock sequence, config objects and state graph.
function makeSide(spec = {}) {
  const trace = [];
  const ticks = spec.ticks ?? [NOW];
  let tick = 0;
  const clock = {
    now() {
      const at = ticks[Math.min(tick++, ticks.length - 1)];
      trace.push(['now', at]);
      return at;
    },
  };
  const waitSource = spec.makeWait ? spec.makeWait() : structuredClone(spec.wait ?? {});
  const wait = waitSource == null ? waitSource : new Proxy(waitSource, {
    get(target, key, receiver) {
      if (typeof key === 'string') trace.push(['wait', key]);
      return Reflect.get(target, key, receiver);
    },
  });
  const socialV2 = { get wait() { trace.push(['cfg', 'wait']); return wait; } };
  const cfg = { get socialV2() { trace.push(['cfg', 'socialV2']); return socialV2; } };
  const state = spec.makeState ? spec.makeState(trace) : structuredClone(spec.state ?? null);
  // G6: a supplied helper is called only through the capability object; the spy trace proves use.
  const helper = spec.makeHelper ? spec.makeHelper() : looksLikeUnfinished;
  const helperForSide = spec.makeHelper
    ? (text) => { const result = helper(text); trace.push(['helper', text, result]); return result; }
    : helper;
  return {
    trace, cfg, clock, state, helper, helperForSide,
    // Lazily reads the same config boundary the frozen factory reads directly.
    capabilities: { getWaitConfig: () => cfg.socialV2?.wait, now: () => clock.now(), looksLikeUnfinished: helperForSide },
  };
}

function capture(fn) {
  try { return { value: fn() }; }
  catch (error) { return { error: { name: error.name, message: error.message } }; }
}

function execute(kind, name, side) {
  if (kind === 'native') return capture(() => timing[name](side.state, side.capabilities));
  const factory = createLegacyReplyTiming({ cfg: side.cfg, Date: side.clock, looksLikeUnfinished: side.helperForSide });
  return capture(() => factory[ORACLE_NAME[name]](side.state));
}

function compare(name, spec) {
  const oracleSide = makeSide(spec);
  const nativeSide = makeSide(spec);
  const expected = execute('oracle', name, oracleSide);
  const actual = execute('native', name, nativeSide);
  assert.deepEqual(actual, expected);
  assert.deepEqual(nativeSide.trace, oracleSide.trace, 'ordered getWaitConfig/property/valueOf/clock events');
  return { ...nativeSide, result: actual };
}

const nowEvents = (trace) => trace.filter(([kind]) => kind === 'now');

test('native module exposes exactly the two capability-based exports', () => {
  assert.deepEqual(Object.keys(timing).sort(), ['replyTiming', 'suggestQuietMs']);
  assert.equal(typeof timing.suggestQuietMs, 'function');
  assert.equal(typeof timing.replyTiming, 'function');
});

test('suggestQuietMs boundaries: defaults, raw numerics, unfinished text and strict burst window', () => {
  const cases = [
    // [label, spec, expected value, expected clock reads]
    ['null state with null config', { makeWait: () => null, state: null }, 8000, 0],
    ['zero default falls back', { wait: { defaultQuietMs: 0 }, state: null }, 8000, 0],
    ['negative default preserved raw', { wait: { defaultQuietMs: -2 }, state: {} }, -2, 0],
    ['Infinity default preserved raw', { wait: { defaultQuietMs: Infinity }, state: {} }, Infinity, 0],
    ['numeric string coerced', { wait: { defaultQuietMs: '1234' }, state: {} }, 1234, 0],
    ['non-array history', { wait: {}, state: { recentMessages: 'nope' } }, 8000, 0],
    ['null and self entries ignored', { wait: {}, state: { recentMessages: [null, { isSelf: true, time: NOW }] } }, 8000, 0],
    ['unfinished last message', { wait: {}, state: { recentMessages: [{ text: 'done', time: NOW }, { tail: '然后', time: NOW }] } }, 12000, 0],
    ['empty tail falls through to plain', { wait: {}, state: { recentMessages: [{ tail: '', plain: '然后', time: NOW }] } }, 12000, 0],
    ['empty tail and plain fall through to text', { wait: {}, state: { recentMessages: [{ tail: '', plain: '', text: '然后', time: NOW }] } }, 12000, 0],
    ['numeric zero tail and plain fall through to text', { wait: {}, state: { recentMessages: [{ tail: 0, plain: 0, text: '然后', time: NOW }] } }, 12000, 0],
    ['numeric zero text becomes empty text', { wait: {}, state: { recentMessages: [{ tail: 0, plain: 0, text: 0, time: NOW }] } }, 8000, 1],
    ['all empty strings become empty text', { wait: {}, state: { recentMessages: [{ tail: '', plain: '', text: '', time: NOW }] } }, 8000, 1],
    ['finished last message scans once', { wait: {}, state: { recentMessages: [{ text: '然后。', time: NOW }] } }, 8000, 1],
    ['three hits at 14999ms', { wait: {}, state: { recentMessages: Array.from({ length: 3 }, () => ({ text: 'done', time: NOW - 14999 })) } }, 12000, 3],
    ['three misses at 15000ms', { wait: {}, state: { recentMessages: Array.from({ length: 3 }, () => ({ text: 'done', time: NOW - 15000 })) } }, 8000, 3],
    ['full scan after third hit', { wait: {}, state: { recentMessages: Array.from({ length: 5 }, () => ({ text: 'done', time: NOW })) } }, 12000, 5],
    ['self entries excluded from burst', { wait: {}, state: { recentMessages: [{ text: 'done', time: NOW }, { text: 'done', time: NOW }, { isSelf: true, time: NOW }] } }, 8000, 2],
  ];
  for (const [label, spec, expected, expectedClocks] of cases) {
    const actual = compare('suggestQuietMs', spec);
    assert.deepEqual(actual.result.value, expected, label);
    assert.equal(nowEvents(actual.trace).length, expectedClocks, `${label}: clock reads`);
  }
});

test('explicit undefined getWaitConfig() is tolerated by both exports (G1)', () => {
  const suggest = compare('suggestQuietMs', { makeWait: () => undefined, state: {} });
  assert.equal(suggest.result.value, 8000);
  // One optional-chained pull: no wait property read and no clock call.
  assert.deepEqual(suggest.trace, [['cfg', 'socialV2'], ['cfg', 'wait']]);
  assert.equal(suggest.trace.filter(([kind]) => kind === 'wait').length, 0);

  const reply = compare('replyTiming', { makeWait: () => undefined, state: {} });
  assert.deepEqual(reply.result.value, { purpose: 'reply', quietMs: 10000, remainingQuietMs: 10000 });
  // Three separate optional-chained pulls (min, max, suggestion default), all undefined.
  assert.deepEqual(reply.trace, [
    ['cfg', 'socialV2'], ['cfg', 'wait'],
    ['cfg', 'socialV2'], ['cfg', 'wait'],
    ['cfg', 'socialV2'], ['cfg', 'wait'],
  ]);
  assert.equal(nowEvents(reply.trace).length, 0);
});

test('replyTiming boundaries: fallback, rounding, clamping, raw Infinity and finite incoming time', () => {
  const cases = [
    // [label, wait, state, quietMs, remainingQuietMs]
    ['base elapsed', {}, { lastIncomingAt: NOW - 3000 }, 10000, 7000],
    ['rounded default', { minQuietAfterNewMs: 0, defaultQuietMs: 500.6 }, { lastIncomingAt: NOW - 100 }, 501, 401],
    ['negative minimum and default', { minQuietAfterNewMs: -1, defaultQuietMs: -2 }, {}, 0, 0],
    ['NaN minimum falls back, zero max', { minQuietAfterNewMs: NaN, maxMs: 0 }, {}, 10000, 10000],
    ['Infinity suggestion clamps to 120000', { minQuietAfterNewMs: 0, defaultQuietMs: Infinity }, {}, 120000, 120000],
    ['minimum above max wins', { minQuietAfterNewMs: 200000, maxMs: 1 }, {}, 200000, 200000],
    ['max clamps suggestion', { minQuietAfterNewMs: 0, maxMs: 1000, defaultQuietMs: 8000 }, {}, 1000, 1000],
    ['maxMs numeric-string zero falls back to 600000', { minQuietAfterNewMs: 0, maxMs: '0', defaultQuietMs: 8000 }, {}, 8000, 8000],
    ['future incoming keeps full quiet', {}, { lastIncomingAt: NOW + 100 }, 10000, 10000],
    ['old incoming exhausted', {}, { lastIncomingAt: NOW - 20000 }, 10000, 0],
    ['NaN incoming ignored', {}, { lastIncomingAt: NaN }, 10000, 10000],
    ['Infinity incoming ignored', {}, { lastIncomingAt: Infinity }, 10000, 10000],
    ['zero incoming ignored', {}, { lastIncomingAt: 0 }, 10000, 10000],
    ['negative incoming ignored', {}, { lastIncomingAt: -5 }, 10000, 10000],
    ['missing incoming ignored', {}, {}, 10000, 10000],
  ];
  for (const [label, wait, state, quietMs, remainingQuietMs] of cases) {
    const actual = compare('replyTiming', { wait, state });
    assert.deepEqual(actual.result.value, { purpose: 'reply', quietMs, remainingQuietMs }, label);
  }
});

test('clock is read once per eligible message with distinct values, and never for unfinished text', () => {
  const actual = compare('suggestQuietMs', {
    wait: {},
    ticks: [NOW, NOW + 1, NOW + 2, NOW + 3],
    makeState: () => ({ recentMessages: Array.from({ length: 4 }, () => ({ text: 'done', time: NOW - 5000 })) }),
  });
  assert.equal(actual.result.value, 12000);
  assert.deepEqual(nowEvents(actual.trace), [['now', NOW], ['now', NOW + 1], ['now', NOW + 2], ['now', NOW + 3]]);

  const idle = compare('suggestQuietMs', {
    wait: {},
    makeState: () => ({ recentMessages: [{ text: 'done', time: NOW }, { tail: '等一下', time: NOW }] }),
  });
  assert.equal(idle.result.value, 12000);
  assert.equal(nowEvents(idle.trace).length, 0);
});

test('replyTiming keeps separate config reads and ordered coercion/clock events around suggestion', () => {
  const actual = compare('replyTiming', {
    wait: {},
    ticks: [NOW, NOW, NOW],
    makeState: (trace) => {
      let reads = 0;
      const messages = [
        { text: 'done', time: { valueOf() { trace.push(['coerce', 'time', 0]); return NOW - 100; } } },
        { text: 'done', time: { valueOf() { trace.push(['coerce', 'time', 1]); return NOW - 200; } } },
      ];
      const state = {
        lastIncomingAt: { valueOf() { trace.push(['coerce', 'incoming']); return NOW - 3000; } },
      };
      Object.defineProperty(state, 'recentMessages', {
        configurable: true,
        get() { trace.push(['history', ++reads]); return messages; },
      });
      return state;
    },
  });
  assert.deepEqual(actual.result.value, { purpose: 'reply', quietMs: 10000, remainingQuietMs: 7000 });
  const { trace } = actual;
  // minQuietAfterNewMs, maxMs and the suggestion default each re-read the config boundary.
  assert.equal(trace.filter(([kind, name]) => kind === 'cfg' && name === 'socialV2').length, 3);
  assert.deepEqual(trace.filter(([kind]) => kind === 'wait').map(([, name]) => name), ['minQuietAfterNewMs', 'maxMs', 'defaultQuietMs']);
  assert.deepEqual(trace.filter(([kind]) => kind === 'history').map(([, n]) => n), [1, 2]);
  assert.deepEqual(trace.filter(([kind]) => kind === 'coerce'), [['coerce', 'time', 0], ['coerce', 'time', 1], ['coerce', 'incoming']]);
  const incomingAt = trace.findIndex(([kind, name]) => kind === 'coerce' && name === 'incoming');
  assert.ok(incomingAt > Math.max(...nowEvents(trace).slice(0, 2).map((event) => trace.indexOf(event))));
  // Nothing but the elapsed read may follow the lastIncomingAt conversion.
  assert.deepEqual(trace.slice(incomingAt), [['coerce', 'incoming'], ['now', NOW]]);
});

test('hot config getter mutation order and thrown config getter propagate identically', () => {
  const actual = compare('replyTiming', {
    makeWait: () => {
      const wait = { minQuietAfterNewMs: 0, defaultQuietMs: 2000 };
      Object.defineProperty(wait, 'maxMs', {
        configurable: true,
        get() { wait.defaultQuietMs = 3000; return 9000; },
      });
      return wait;
    },
    makeState: () => ({ recentMessages: [{ text: 'done', time: NOW }] }),
  });
  assert.deepEqual(actual.result.value, { purpose: 'reply', quietMs: 3000, remainingQuietMs: 3000 });

  const thrown = compare('replyTiming', {
    makeWait: () => ({ get minQuietAfterNewMs() { throw new Error('fixture conversion blocked'); } }),
    makeState: () => ({}),
  });
  assert.deepEqual(thrown.result.error, { name: 'Error', message: 'fixture conversion blocked' });
});

test('replyTiming reads the elapsed clock only for positive finite incoming time and throws on null state', () => {
  for (const [incoming, elapsedClocks] of [[0, 0], [-5, 0], [NaN, 0], [Infinity, 0], [NOW - 3000, 1], [NOW + 100, 1]]) {
    const actual = compare('replyTiming', {
      wait: {},
      makeState: () => ({ recentMessages: [{ text: 'done', time: NOW - 100 }], lastIncomingAt: incoming }),
    });
    assert.equal(nowEvents(actual.trace).length, 1 + elapsedClocks, `incoming=${String(incoming)}`);
  }
  const thrown = compare('replyTiming', { wait: {}, state: null });
  assert.equal(thrown.result.error.name, 'TypeError');
});

test('both exports call the supplied looksLikeUnfinished capability (G6)', () => {
  const suggest = compare('suggestQuietMs', {
    wait: {},
    makeState: () => ({ recentMessages: [{ text: 'spy-tail', time: NOW }] }),
    makeHelper: () => { const fn = (text) => { fn.calls.push(text); return true; }; fn.calls = []; return fn; },
  });
  assert.equal(suggest.result.value, 12000);
  assert.deepEqual(suggest.helper.calls, ['spy-tail']);
  assert.deepEqual(suggest.trace.filter(([kind]) => kind === 'helper'), [['helper', 'spy-tail', true]]);

  const reply = compare('replyTiming', {
    wait: {},
    makeState: () => ({ recentMessages: [{ text: 'plain-text', time: NOW }], lastIncomingAt: NOW - 1000 }),
    makeHelper: () => { const fn = (text) => { fn.calls.push(text); return false; }; fn.calls = []; return fn; },
  });
  assert.deepEqual(reply.result.value, { purpose: 'reply', quietMs: 10000, remainingQuietMs: 9000 });
  assert.deepEqual(reply.helper.calls, ['plain-text']);
  assert.deepEqual(reply.trace.filter(([kind]) => kind === 'helper'), [['helper', 'plain-text', false]]);
});
