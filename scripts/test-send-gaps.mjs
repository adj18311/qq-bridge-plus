#!/usr/bin/env node
// send-gaps 离线直测（in-process：无服务/无网络/无写入）：node scripts/test-send-gaps.mjs
// 新模块 src/core/send-gaps.mjs 对拍冻结基线 scripts/fixtures/send-gaps-baseline.mjs（f74eb90 原始桥
// 内闭包体，legacy 名，随机源由 factory 注入）；断言显式期望/差分一致/capabilities 惰性契约，期望值绝不
// 从新模块反推，每个 side 各自新建 config Proxy、random 游标与 randInt trace。
import assert from 'node:assert/strict';
import * as gaps from '../src/core/send-gaps.mjs';
import { createLegacySendGaps } from './fixtures/send-gaps-baseline.mjs';
const { clampMessageGap, computeMessageGaps } = gaps;
const failures = [];
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (error) { failures.push({ name, error }); console.error(`not ok - ${name}`); console.error(error?.stack ?? String(error)); }
}
function capture(fn) {
  try { return { value: fn() }; }
  catch (error) { return { error: { name: error?.name, message: error?.message } }; }
}
const unusedCaps = { random() { throw new Error('random must not be sampled'); }, randInt() { throw new Error('randInt must not be called'); } };
function makeCfg(values = {}, trace = [], getterThrow = null) {
  return new Proxy({ ...values }, { get(target, key, receiver) {
    if (typeof key === 'string') {
      trace.push(['cfg', key]);
      if (getterThrow === key) throw new Error(`config getter ${key} blocked`);
    }
    return Reflect.get(target, key, receiver);
  } });
}
function makeSide(spec = {}) {
  const trace = [];
  const cfg = makeCfg(spec.cfg ?? {}, trace, spec.getterThrow ?? null);
  const seq = spec.random ?? []; let cursor = 0;
  const random = () => { const value = seq.length ? seq[Math.min(cursor++, seq.length - 1)] : 0; trace.push(['random', value]); return value; };
  const randInt = (min, max) => { trace.push(['randInt', min, max]); return spec.randIntPick === 'max' ? max : min; };
  return { trace, cfg, capabilities: spec.missingCaps ? undefined : { random, randInt } };
}
function execute(kind, spec, side) {
  const args = [spec.messages, spec.gapMode, spec.gapMs, spec.gaps, side.cfg];
  if (kind === 'native') return capture(() => computeMessageGaps(...args, side.capabilities));
  return capture(() => createLegacySendGaps(side.capabilities).computeGapsV2(...args));
}
function compare(spec) {
  const oracleSide = makeSide(spec), nativeSide = makeSide(spec);
  const expected = execute('legacy', spec, oracleSide);
  const actual = execute('native', spec, nativeSide);
  assert.deepEqual(actual, expected, 'value/error parity');
  assert.deepEqual(nativeSide.trace, oracleSide.trace, 'config/random/randInt call order');
  return { result: actual, trace: nativeSide.trace };
}
test('exports and zero/one-message short-circuit (no config/capability access)', () => {
  assert.deepEqual(Object.keys(gaps).sort(), ['clampMessageGap', 'computeMessageGaps']);
  for (const messages of [undefined, null, [], ['only'], '', 'x', { length: 1 }]) {
    const expected = capture(() => createLegacySendGaps(unusedCaps).computeGapsV2(messages, 'auto', 0, [], undefined));
    const actual = capture(() => computeMessageGaps(messages, 'auto', 0, [], undefined, unusedCaps));
    assert.deepEqual(actual, { value: [] }, String(messages));
    assert.deepEqual(actual, expected, String(messages));
  }
});
test('clamp: coercion/rounding/min100/fallbacks (300/10000) and ordered reads', () => {
  const cases = [
    ['default positive', 500, {}, 500], ['zero -> min fallback', 0, {}, 300], ['negative -> min', -50, {}, 300], ['NaN -> min', NaN, {}, 300],
    ['Infinity -> max', Infinity, {}, 10000], ['numeric string', '750', {}, 750], ['round .5 up', 450.5, {}, 451], ['fraction rounds', 1024.6, {}, 1025],
    ['burst min < 100 -> 100', 500, { burstIntervalMinMs: 50 }, 500], ['burst min 0 -> 300', 150, { burstIntervalMinMs: 0 }, 300],
    ['burst min NaN -> 300', 150, { burstIntervalMinMs: 'abc' }, 300], ['max below min -> min', 500, { burstIntervalMinMs: 5000, maxGapMs: 2000 }, 5000],
    ['max 0 -> 10000', 99999, { maxGapMs: 0 }, 10000], ['max NaN -> 10000', 50000, { maxGapMs: NaN }, 10000], ['ms 0 -> custom min', 0, { burstIntervalMinMs: 1200 }, 1200],
  ];
  for (const [label, ms, values, expectedValue] of cases) {
    const oracleTrace = [], nativeTrace = [];
    const expected = capture(() => createLegacySendGaps(unusedCaps).clampGapV2(ms, makeCfg(values, oracleTrace)));
    const actual = capture(() => clampMessageGap(ms, makeCfg(values, nativeTrace)));
    assert.deepEqual(actual, { value: expectedValue }, label);
    assert.deepEqual(actual, expected, label);
    assert.deepEqual(nativeTrace, oracleTrace, label);
    assert.deepEqual(nativeTrace, [['cfg', 'burstIntervalMinMs'], ['cfg', 'maxGapMs']], label);
  }
  for (const key of ['burstIntervalMinMs', 'maxGapMs']) {
    const expected = capture(() => createLegacySendGaps(unusedCaps).clampGapV2(400, makeCfg({}, [], key)));
    const actual = capture(() => clampMessageGap(400, makeCfg({}, [], key)));
    assert.deepEqual(actual, expected);
    assert.equal(actual.error.message, `config getter ${key} blocked`);
  }
  const symbolExpected = capture(() => createLegacySendGaps(unusedCaps).clampGapV2(Symbol('ms'), makeCfg({})));
  const symbolActual = capture(() => clampMessageGap(Symbol('ms'), makeCfg({})));
  assert.equal(symbolActual.error.name, 'TypeError', 'native Number(Symbol) error surfaces');
  assert.deepEqual(symbolActual, symbolExpected);
});
test('fixed: indexed gaps vs single fallback, incl. 0/negative/NaN/Infinity and gap-array shapes', () => {
  const cases = [
    [{ messages: ['a', 'b', 'c'], gapMode: 'fixed', gaps: [1200, 2400] }, [1200, 2400]],
    [{ messages: ['a', 'b', 'c'], gapMode: 'fixed', gaps: [50, 999999] }, [300, 10000]],
    [{ messages: ['a', 'b', 'c', 'd'], gapMode: 'fixed', gaps: [undefined, 'abc', -10] }, [300, 300, 300]],
    [{ messages: ['a', 'b'], gapMode: 'fixed', gaps: 'x', gapMs: 1500 }, [1500]],
    [{ messages: ['a', 'b', 'c'], gapMode: 'fixed', gapMs: 2000 }, [2000, 2000]],
    [{ messages: ['a', 'b'], gapMode: 'fixed', gapMs: 0, cfg: { burstIntervalMinMs: 700 } }, [700]],
    [{ messages: ['a', 'b'], gapMode: 'fixed', gapMs: -5 }, [300]],
    [{ messages: ['a', 'b'], gapMode: 'fixed', gapMs: NaN, cfg: { burstIntervalMinMs: 650 } }, [650]],
    [{ messages: ['a', 'b'], gapMode: 'fixed', gapMs: Infinity }, [10000]],
    [{ messages: ['a', 'b', 'c'], gapMode: 'fixed', gapMs: 2100, gaps: [500] }, [2100, 2100]],
  ];
  for (const [spec, expected] of cases) assert.deepEqual(compare(spec).result, { value: expected });
});
test('byLength: UTF-16 length, empty/falsy messages, base/perChar fallbacks and clamping', () => {
  const cases = [
    [{ messages: ['😀', '', 'abc'], gapMode: 'byLength', cfg: { gapBaseMs: 800, gapPerCharMs: 20 } }, [840, 820]],
    [{ messages: ['😀', 0, null, '汉字', 'zz'], gapMode: 'byLength', cfg: { gapBaseMs: 800, gapPerCharMs: 20 } }, [840, 820, 820, 840]],
    [{ messages: ['ab', 'c'], gapMode: 'byLength' }, [840]],
    [{ messages: ['ab', 'c'], gapMode: 'byLength', cfg: { gapBaseMs: 1000, gapPerCharMs: NaN } }, [1040]],
    [{ messages: ['x'.repeat(600), 'y'], gapMode: 'byLength', cfg: { gapBaseMs: 800, gapPerCharMs: 20 } }, [10000]],
    [{ messages: ['a', 'b'], gapMode: 'byLength', cfg: { gapBaseMs: 50 } }, [300]],
    [{ messages: ['a', 'b'], gapMode: 'byLength', cfg: { gapBaseMs: Infinity } }, [10000]],
  ];
  for (const [spec, expected] of cases) assert.deepEqual(compare(spec).result, { value: expected });
});
test('auto zero/negative/NaN probability: no random; burst read/randInt/clamp order per message', () => {
  for (const prob of [0, -1, NaN, undefined]) {
    const { result, trace } = compare({
      messages: ['a', 'b', 'c'], gapMode: 'auto', randIntPick: 'max',
      cfg: { longGapProbability: prob, burstIntervalMinMs: 1500, burstIntervalMaxMs: 2500, maxGapMs: 9000 },
    });
    assert.deepEqual(result, { value: [2500, 2500] }, String(prob));
    assert.ok(!trace.some(([kind]) => kind === 'random'), `prob=${String(prob)} must not sample random`);
    const expectedTrace = [['cfg', 'longGapProbability']];
    for (let i = 0; i < 2; i += 1) {
      expectedTrace.push(['cfg', 'burstIntervalMinMs'], ['cfg', 'burstIntervalMaxMs'],
        ['randInt', 1500, 2500], ['cfg', 'burstIntervalMinMs'], ['cfg', 'maxGapMs']);
    }
    assert.deepEqual(trace, expectedTrace, `prob=${String(prob)} exact read/callback order`);
  }
});
test('auto long branch: random decides per message, branch bounds only, max(100) floor, fresh state', () => {
  const spec = {
    messages: ['a', 'b', 'c'], gapMode: 'auto', random: [0.4, 0.6], randIntPick: 'min',
    cfg: { longGapProbability: 0.5, longGapMinMs: 2000, longGapMaxMs: 8000, burstIntervalMinMs: 900, burstIntervalMaxMs: 1200, maxGapMs: 10000 },
  };
  const first = compare(spec);
  assert.deepEqual(first.result, { value: [2000, 900] });
  assert.deepEqual(first.trace, [
    ['cfg', 'longGapProbability'], ['random', 0.4], ['cfg', 'longGapMinMs'], ['cfg', 'longGapMaxMs'],
    ['randInt', 2000, 8000], ['cfg', 'burstIntervalMinMs'], ['cfg', 'maxGapMs'],
    ['random', 0.6], ['cfg', 'burstIntervalMinMs'], ['cfg', 'burstIntervalMaxMs'],
    ['randInt', 900, 1200], ['cfg', 'burstIntervalMinMs'], ['cfg', 'maxGapMs'],
  ]);
  const second = compare(spec);
  assert.deepEqual(second.result, first.result, 'fresh per-side inputs -> same result');
  assert.deepEqual(second.trace, first.trace, 'fresh per-side trace');
  const floored = compare({ ...spec, random: [0.1, 0.9], cfg: { longGapProbability: 0.5, longGapMinMs: 50, longGapMaxMs: 0, burstIntervalMinMs: 20, burstIntervalMaxMs: 10, maxGapMs: 10000 } });
  assert.deepEqual(floored.result, { value: [100, 100] });
  assert.deepEqual(floored.trace.filter(([kind]) => kind === 'randInt'), [['randInt', 100, 10000], ['randInt', 100, 100]]);
});
test('mode normalization and config getter errors at the exact frozen reads', () => {
  const autoCfg = { longGapProbability: 0, burstIntervalMinMs: 1000, burstIntervalMaxMs: 3000 };
  for (const gapMode of [undefined, null, 'AUTO', 'random', 'bylength', 'Fixed']) {
    assert.deepEqual(compare({ messages: ['a', 'b'], gapMode, cfg: autoCfg, randIntPick: 'min' }).result, { value: [1000] }, String(gapMode));
  }
  assert.deepEqual(compare({ messages: ['a', 'b'], gapMode: 'fixed' }).result, { value: [1000] });
  assert.deepEqual(compare({ messages: ['a', 'b'], gapMode: 'byLength' }).result, { value: [820] });
  const errors = [
    [{ messages: ['a', 'b'], gapMode: 'fixed', getterThrow: 'burstIntervalMinMs' }, 'fixed fallback burst min'],
    [{ messages: ['a', 'b'], gapMode: 'byLength', getterThrow: 'gapBaseMs' }, 'byLength base'],
    [{ messages: ['a', 'b'], gapMode: 'auto', getterThrow: 'longGapProbability' }, 'auto probability'],
    [{ messages: ['a', 'b'], gapMode: 'auto', random: [0.5], cfg: { longGapProbability: 1, longGapMinMs: 5000 }, getterThrow: 'longGapMaxMs' }, 'auto long max after random'],
  ];
  for (const [spec, label] of errors) {
    const { result, trace } = compare(spec);
    assert.equal(result.error.name, 'Error', label);
    assert.equal(result.error.message, `config getter ${spec.getterThrow} blocked`, label);
    assert.ok(trace.some(([kind, key]) => kind === 'cfg' && key === spec.getterThrow), label);
  }
});
test('capabilities stay lazy and are never defaulted', () => {
  const onlyRandInt = { randInt: (min) => min };
  const zero = capture(() => computeMessageGaps(['a', 'b'], 'auto', 0, [], makeCfg({ longGapProbability: 0, burstIntervalMinMs: 1000, burstIntervalMaxMs: 2000 }), onlyRandInt));
  assert.deepEqual(zero, { value: [1000] }, 'zero probability never touches capabilities.random');
  const positiveCfg = { longGapProbability: 1, longGapMinMs: 5000, longGapMaxMs: 6000 };
  const nativeThrown = capture(() => computeMessageGaps(['a', 'b'], 'auto', 0, [], makeCfg(positiveCfg), onlyRandInt));
  const oracleThrown = capture(() => createLegacySendGaps(onlyRandInt).computeGapsV2(['a', 'b'], 'auto', 0, [], makeCfg(positiveCfg)));
  assert.equal(nativeThrown.error.name, 'TypeError');
  assert.deepEqual(nativeThrown, oracleThrown, 'positive probability surfaces the same missing capability');
  assert.deepEqual(capture(() => computeMessageGaps(['a', 'b'], 'fixed', 0, [], makeCfg({ burstIntervalMinMs: 700 }))), { value: [700] });
  assert.deepEqual(capture(() => computeMessageGaps(['a', 'b'], 'byLength', 0, [], makeCfg({}))), { value: [820] });
});
if (failures.length) { console.error(`FAIL ${failures.length} / ${passed + failures.length}`); process.exitCode = 1; } else console.log(`PASS ${passed} / ${passed}`);
