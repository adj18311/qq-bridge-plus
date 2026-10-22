#!/usr/bin/env node
/**
 * parseModelUpdateInput 离线直测（in-process，无服务 / 无网络 / 无文件写入）：
 *   node scripts/test-console-input.mjs
 *
 * 两个实现同场对拍：
 *   新模块    src/core/console-input.mjs
 *   冻结基线  scripts/fixtures/console-input-baseline.mjs（faaa226 前缀，独立副本）
 *
 * 断言两类：
 *   1) 显式期望：值、undefined/null、Map/Set 顺序、错误文案/状态、getter 访问序列、无副作用；
 *   2) 差分一致性：同一输入分别喂两个实现，逐字段深比较（不经过 JSON 规范化）。
 * 期望值一律来自原始前缀的语义，不读取新模块来生成期望。
 */
import assert from 'node:assert/strict';
import { parseModelUpdateInput } from '../src/core/console-input.mjs';
import { baselineParseModelUpdateInput } from './fixtures/console-input-baseline.mjs';

const failures = [];
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`not ok - ${name}`);
    console.error(error && error.stack ? error.stack : String(error));
  }
}

/** 保序快照：Map/Set/对象键序、undefined 与缺失都保留，避免 JSON 规范化吃掉差异。 */
function snap(value) {
  if (value === undefined) return { t: 'undefined' };
  if (value instanceof Map) return { t: 'Map', entries: [...value].map(([k, v]) => [k, snap(v)]) };
  if (value instanceof Set) return { t: 'Set', values: [...value] };
  if (Array.isArray(value)) return { t: 'Array', items: value.map(snap) };
  if (value && typeof value === 'object') {
    return { t: 'Object', entries: Object.keys(value).map((k) => [k, snap(value[k])]) };
  }
  return { t: 'value', value };
}
function snapResult(result) {
  return {
    nextProvider: snap(result.nextProvider),
    nextModel: snap(result.nextModel),
    nextEffort: snap(result.nextEffort),
    patch: snap(result.patch),
    removals: snap(result.removals)
  };
}
function run(fn, body) {
  try {
    return { ok: true, value: snapResult(fn(body)) };
  } catch (error) {
    return { ok: false, error: { name: error && error.name, message: error && error.message, statusCode: error && error.statusCode } };
  }
}
/** 同一输入分别喂两个实现，深比较完整结果（含错误），返回新模块的输出。 */
function both(body, label) {
  const moduleOut = run(parseModelUpdateInput, body);
  const baselineOut = run(baselineParseModelUpdateInput, body);
  assert.deepStrictEqual(moduleOut, baselineOut, `差分不一致 @ ${label}`);
  return moduleOut;
}
function expectFail(body, label, expected) {
  const out = both(body, label);
  assert.equal(out.ok, false, `应失败却成功 @ ${label}`);
  assert.equal(out.error.statusCode, expected.statusCode === undefined ? 400 : expected.statusCode, `statusCode 不一致 @ ${label}`);
  if (expected.message !== undefined) assert.equal(out.error.message, expected.message, `message 不一致 @ ${label}`);
  if (expected.includes !== undefined) {
    assert.ok(out.error.message.includes(expected.includes), `message 缺少「${expected.includes}」@ ${label}：${out.error.message}`);
  }
  return out.error;
}
function expectValue(body, label) {
  let moduleRaw;
  let baselineRaw;
  let moduleError;
  let baselineError;
  try { moduleRaw = parseModelUpdateInput(body); } catch (error) { moduleError = error; }
  try { baselineRaw = baselineParseModelUpdateInput(body); } catch (error) { baselineError = error; }
  const moduleOut = moduleError
    ? { ok: false, error: { name: moduleError.name, message: moduleError.message, statusCode: moduleError.statusCode } }
    : { ok: true, value: snapResult(moduleRaw) };
  const baselineOut = baselineError
    ? { ok: false, error: { name: baselineError.name, message: baselineError.message, statusCode: baselineError.statusCode } }
    : { ok: true, value: snapResult(baselineRaw) };
  assert.deepStrictEqual(moduleOut, baselineOut, `差分不一致 @ ${label}`);
  assert.equal(moduleOut.ok, true, `应成功却失败 @ ${label}：${moduleOut.error && moduleOut.error.message}`);
  return moduleRaw;
}
/** 期望失败时的字面量（来自原始前缀，硬编码为显式期望）。 */
const NO_FIELDS = '没有要改的字段：provider / model / reasoningEffort / modelOverrides / removeOverrides 至少给一个';
const NOT_OBJECT = '请求体必须是 JSON 对象';
const OVERRIDES_SHAPE = 'modelOverrides 必须是对象：{"<private:QQ号|group:群号>": {"provider": …, "model": …}}';
const REMOVALS_SHAPE = 'removeOverrides 必须是字符串数组（要删除的 key）';

const GETTER_KEYS = ['provider', 'model', 'reasoningEffort', 'modelOverrides', 'removeOverrides'];
function tracedBody(values) {
  const trace = [];
  const body = {};
  for (const key of GETTER_KEYS) {
    Object.defineProperty(body, key, {
      enumerable: true,
      configurable: true,
      get() { trace.push(key); return values[key]; }
    });
  }
  return { body, trace };
}
function traceRun(fn, values) {
  const { body, trace } = tracedBody(values);
  return { out: run(fn, body), trace };
}

test('显式：基础 trim / 缺省 / 显式 null 语义', () => {
  const full = parseModelUpdateInput({ provider: '  minimax-cn ', model: ' MiniMax-M3 ', reasoningEffort: ' high ' });
  assert.equal(full.nextProvider, 'minimax-cn');
  assert.equal(full.nextModel, 'MiniMax-M3');
  assert.equal(full.nextEffort, 'high');
  assert.ok(full.patch instanceof Map);
  assert.equal(full.patch.size, 0);
  assert.ok(full.removals instanceof Set);
  assert.equal(full.removals.size, 0);

  const omitted = parseModelUpdateInput({ provider: 'x' });
  assert.equal(omitted.nextModel, null);
  assert.equal(omitted.nextEffort, undefined);
  assert.ok(Object.prototype.hasOwnProperty.call(omitted, 'nextEffort'));

  const cleared = parseModelUpdateInput({ reasoningEffort: null });
  assert.equal(cleared.nextEffort, null);
  assert.equal(cleared.nextProvider, null);
  assert.equal(cleared.nextModel, null);
  assert.equal(cleared.patch.size, 0);
  assert.equal(cleared.removals.size, 0);
});

test('显式：空覆盖 / 空删除被接受，未知顶层字段被忽略', () => {
  const empty = expectValue({ modelOverrides: {}, removeOverrides: [] }, 'empty overrides/removals');
  assert.equal(empty.patch.size, 0);
  assert.equal(empty.removals.size, 0);
  assert.equal(empty.nextEffort, undefined);

  const unknown = expectValue({ provider: 'x', unknown: { a: 1 }, extra: undefined }, 'unknown top-level');
  assert.equal(unknown.nextProvider, 'x');
  assert.equal(unknown.patch.size, 0);

  const removal = expectValue({ removeOverrides: ['private:1'] }, 'removal only');
  assert.deepStrictEqual([...removal.removals], ['private:1']);
  assert.equal(removal.nextProvider, null);
  assert.equal(removal.nextEffort, undefined);
});

test('显式：modelOverrides 嵌套矩阵（字段顺序 / trim / null / undefined 跳过）', () => {
  const result = expectValue({
    modelOverrides: {
      'private:10001': { reasoningEffort: ' max ', model: ' MiniMax-M3 ' },
      'group:20002': { provider: ' p ', model: undefined }
    }
  }, 'nested matrix');
  assert.deepStrictEqual([...result.patch.keys()], ['private:10001', 'group:20002']);
  assert.deepStrictEqual(Object.entries(result.patch.get('private:10001')), [
    ['model', 'MiniMax-M3'],
    ['reasoningEffort', 'max']
  ]);
  assert.deepStrictEqual(Object.keys(result.patch.get('group:20002')), ['provider']);
  assert.deepStrictEqual(result.patch.get('group:20002'), { provider: 'p' });

  const cleared = expectValue({ modelOverrides: { 'private:1': { model: 'm', reasoningEffort: null } } }, 'nested null effort');
  assert.deepStrictEqual(Object.keys(cleared.patch.get('private:1')), ['model', 'reasoningEffort']);
  assert.equal(cleared.patch.get('private:1').reasoningEffort, null);

  expectFail({ modelOverrides: { 'user:1': { provider: 'x' } } }, 'bad key', {
    message: 'modelOverrides 的 key「user:1」非法：应为 private:<QQ号> 或 group:<群号>（号码为正整数）'
  });
  expectFail({ modelOverrides: { 'private:1': [] } }, 'array entry', {
    message: 'modelOverrides["private:1"] 必须是对象'
  });
  expectFail({ modelOverrides: { 'private:1': { provider: 'x', extra: 1 } } }, 'extra field', {
    message: 'modelOverrides["private:1"] 不允许字段「extra」：只允许 provider / model / reasoningEffort'
  });
  expectFail({ modelOverrides: { 'private:1': {} } }, 'empty clean', {
    message: 'modelOverrides["private:1"] 至少要写一个字段（provider / model / reasoningEffort）'
  });
  expectFail({ modelOverrides: [] }, 'array overrides', { message: OVERRIDES_SHAPE });
  expectFail({ modelOverrides: null }, 'null overrides', { message: OVERRIDES_SHAPE });
});

test('显式：removeOverrides 去重 / trim / 顺序 / 非法项', () => {
  const result = expectValue({ removeOverrides: [' private:2 ', 'group:3', 'private:2', 'group:3'] }, 'removal dedupe');
  assert.deepStrictEqual([...result.removals], ['private:2', 'group:3']);
  assert.equal(result.removals.size, 2);

  expectFail({ removeOverrides: 'private:1' }, 'non-array removals', { message: REMOVALS_SHAPE });
  expectFail({ removeOverrides: [5] }, 'non-string item', {
    message: 'removeOverrides[] 里的每一项 必须是字符串（收到 number）'
  });
  expectFail({ removeOverrides: ['   '] }, 'blank item', {
    message: 'removeOverrides[] 里的每一项 不能是空字符串'
  });
  expectFail({ provider: 'x', removeOverrides: ['user:1'] }, 'bad removal key', {
    message: 'removeOverrides 里的「user:1」非法：应为 private:<QQ号> 或 group:<群号>（号码为正整数）'
  });
  expectFail({ provider: 'x', removeOverrides: ['private:0'] }, 'zero removal key', { includes: '非法' });
});

test('差分：图元 / 数组 / null / undefined 请求体，以及字段取值矩阵', () => {
  const bodies = [
    null, undefined, 0, 1, false, true, '', 'x', [], [1], () => {}, new Date(0),
    {}, { provider: undefined }, { provider: null }, { provider: '' }, { model: 3 },
    { reasoningEffort: '' }, { reasoningEffort: 0 }, { modelOverrides: null },
    { modelOverrides: [] }, { removeOverrides: null }, { removeOverrides: {} },
    { provider: 'x', removeOverrides: ['private:1'] },
    { provider: 'x', model: undefined, reasoningEffort: undefined }
  ];
  bodies.forEach((body, index) => both(body, `body[${index}]`));
  const values = [undefined, null, '', '  ', ' p ', ' m ', 0, 3, {}, [], ['private:1']];
  for (const value of values) {
    for (const key of GETTER_KEYS) {
      both({ [key]: value }, `field ${key} = ${JSON.stringify(value)}`);
    }
  }
});

test('显式：错误状态码 / 逐字文案 / 校验顺序', () => {
  expectFail({}, 'no fields', { message: NO_FIELDS });
  expectFail([], 'array body', { message: NOT_OBJECT });
  expectFail('x', 'string body', { message: NOT_OBJECT });
  expectFail(undefined, 'undefined body', { message: NOT_OBJECT });
  expectFail({ provider: '   ' }, 'blank provider', { message: 'provider 不能是空字符串' });
  expectFail({ provider: 5 }, 'number provider', { message: 'provider 必须是字符串（收到 number）' });
  expectFail({ provider: null }, 'null provider', { message: 'provider 必须是字符串（收到 null）' });
  expectFail({ model: 3 }, 'number model', { message: 'model 必须是字符串（收到 number）' });
  expectFail({ reasoningEffort: 5 }, 'number effort', { message: 'reasoningEffort 必须是字符串（收到 number）' });
  expectFail({ reasoningEffort: '  ' }, 'blank effort', { message: 'reasoningEffort 不能是空字符串' });
  expectFail({ provider: '', model: '', reasoningEffort: '' }, 'provider first', { message: 'provider 不能是空字符串' });
  expectFail({ model: '', reasoningEffort: '', modelOverrides: null }, 'model before overrides', { message: 'model 不能是空字符串' });
  expectFail({ reasoningEffort: '', removeOverrides: 5 }, 'effort before removals', { message: 'reasoningEffort 不能是空字符串' });
  expectFail({ modelOverrides: null, removeOverrides: 5 }, 'overrides before removals', { message: OVERRIDES_SHAPE });
  expectFail({ provider: 'x', modelOverrides: { 'private:1': {} }, removeOverrides: 5 }, 'entry error before removals', {
    message: 'modelOverrides["private:1"] 至少要写一个字段（provider / model / reasoningEffort）'
  });
  expectFail({ modelOverrides: { 'private:1': { reasoningEffort: 2, provider: 3 } } }, 'DSH field order', {
    message: 'modelOverrides["private:1"].provider 必须是字符串（收到 number）'
  });
  expectFail({ modelOverrides: { 'private:1': { reasoningEffort: 2, model: 3 } } }, 'effort field order', {
    message: 'modelOverrides["private:1"].model 必须是字符串（收到 number）'
  });
  expectFail({ modelOverrides: { 'private:1': { reasoningEffort: 0 } } }, 'effort number', {
    message: 'modelOverrides["private:1"].reasoningEffort 必须是字符串（收到 number）'
  });
});

test('显式：不修改输入、返回 Map/Set 本体与全新 clean 对象', () => {
  const nested = { provider: ' p ', reasoningEffort: null, model: ' m ' };
  const body = { provider: 'x', modelOverrides: { 'private:1': nested }, removeOverrides: ['group:9'] };
  const before = snap(body);
  const result = parseModelUpdateInput(body);
  assert.deepStrictEqual(snap(body), before, '输入体被修改');
  assert.deepStrictEqual(nested, { provider: ' p ', reasoningEffort: null, model: ' m ' }, '嵌套输入被修改');
  assert.notStrictEqual(result.patch.get('private:1'), nested);
  assert.deepStrictEqual(result.patch.get('private:1'), { provider: 'p', model: 'm', reasoningEffort: null });
  result.patch.get('private:1').model = 'mutated';
  assert.equal(nested.model, ' m ');
  assert.ok(result.patch instanceof Map);
  assert.ok(result.removals instanceof Set);
});

test('显式：getter 访问次数与顺序（含最终空校验短路）', () => {
  const cases = [
    ['provider only', { provider: ' p ' }, ['provider', 'provider', 'model', 'reasoningEffort', 'modelOverrides', 'removeOverrides']],
    ['all absent', {}, ['provider', 'model', 'reasoningEffort', 'modelOverrides', 'removeOverrides', 'modelOverrides', 'removeOverrides']],
    ['empty overrides', { modelOverrides: {} }, ['provider', 'model', 'reasoningEffort', 'modelOverrides', 'modelOverrides', 'modelOverrides', 'removeOverrides', 'modelOverrides']],
    ['overrides + removals', { modelOverrides: { 'private:1': { provider: 'x' } }, removeOverrides: ['private:2'] },
      ['provider', 'model', 'reasoningEffort', 'modelOverrides', 'modelOverrides', 'modelOverrides', 'removeOverrides', 'removeOverrides', 'removeOverrides', 'modelOverrides']]
  ];
  for (const [label, values, expectedTrace] of cases) {
    const moduleRun = traceRun(parseModelUpdateInput, values);
    const baselineRun = traceRun(baselineParseModelUpdateInput, values);
    assert.deepStrictEqual(moduleRun.trace, expectedTrace, `getter 序列 @ ${label}`);
    assert.deepStrictEqual(moduleRun.trace, baselineRun.trace, `getter 序列差分 @ ${label}`);
    assert.deepStrictEqual(moduleRun.out, baselineRun.out, `结果差分 @ ${label}`);
  }

  // 嵌套 getter：每个实现各用一份全新输入与独立 trace，才能对拍访问序列本身；
  // 复用同一个 body 时第二次实现读到的是已被读过两次的 getter，序列差分就被掩盖了。
  function makeFreshNestedInput(values = [' q ', ' q ']) {
    const trace = [];
    let reads = 0;
    const nestedValue = {};
    Object.defineProperty(nestedValue, 'provider', {
      enumerable: true,
      configurable: true,
      get() { trace.push('provider'); return values[Math.min(reads++, values.length - 1)]; }
    });
    nestedValue.model = ' m ';
    return { body: { modelOverrides: { 'private:1': nestedValue } }, trace };
  }
  const moduleNestedInput = makeFreshNestedInput();
  const baselineNestedInput = makeFreshNestedInput();
  const moduleNested = parseModelUpdateInput(moduleNestedInput.body);
  const baselineNested = baselineParseModelUpdateInput(baselineNestedInput.body);
  assert.equal(moduleNested.patch.get('private:1').provider, 'q');
  assert.deepStrictEqual(moduleNestedInput.trace, ['provider', 'provider'], '嵌套 getter 读取次数');
  assert.deepStrictEqual(moduleNestedInput.trace, baselineNestedInput.trace, '嵌套 getter 序列逐次差分');
  assert.deepStrictEqual(snapResult(moduleNested), snapResult(baselineNested), '嵌套结果差分');

  // 有状态 getter：每份全新输入各自计数，两次读返回 ['first', 'second']。
  // 两次读取都发生、trace 完全一致时，最终 provider 才等于第二次读的 trim 结果。
  const statefulValues = ['first', 'second'];
  const moduleStatefulInput = makeFreshNestedInput(statefulValues);
  const baselineStatefulInput = makeFreshNestedInput(statefulValues);
  const moduleStateful = parseModelUpdateInput(moduleStatefulInput.body);
  const baselineStateful = baselineParseModelUpdateInput(baselineStatefulInput.body);
  assert.deepStrictEqual(moduleStatefulInput.trace, baselineStatefulInput.trace, '有状态嵌套 getter 序列逐次差分');
  assert.deepStrictEqual(moduleStatefulInput.trace, ['provider', 'provider'], '有状态嵌套 getter 读取次数');
  assert.deepStrictEqual(snapResult(moduleStateful), snapResult(baselineStateful), '有状态嵌套结果差分');
  assert.equal(moduleStateful.patch.get('private:1').provider, statefulValues[1].trim(),
    '最终 provider 必须等于第二次读的 trim 结果');
  assert.equal(baselineStateful.patch.get('private:1').provider, statefulValues[1].trim());
});

test('显式：抛错 getter 原样传播（顶层与嵌套）', () => {
  const body = {};
  const boom = new Error('boom-top');
  boom.statusCode = 418;
  Object.defineProperty(body, 'provider', { enumerable: true, configurable: true, get() { throw boom; } });
  for (const fn of [parseModelUpdateInput, baselineParseModelUpdateInput]) {
    assert.throws(() => fn(body), (error) => error === boom);
  }

  const nestedBoom = new Error('boom-nested');
  const nestedValue = {};
  Object.defineProperty(nestedValue, 'provider', { enumerable: true, configurable: true, get() { throw nestedBoom; } });
  const nestedBody = { modelOverrides: { 'private:1': nestedValue } };
  for (const fn of [parseModelUpdateInput, baselineParseModelUpdateInput]) {
    assert.throws(() => fn(nestedBody), (error) => error === nestedBoom);
  }
});

test('显式：只有自有属性才算提供，原型 / undefined / 不可枚举边界', () => {
  const inherited = Object.create({ provider: ' p ' });
  expectFail(inherited, 'inherited only', { message: NO_FIELDS });
  expectFail({ provider: undefined, model: undefined }, 'undefined own fields', { message: NO_FIELDS });
  expectFail(Object.create({ modelOverrides: {} }), 'inherited overrides', { message: NO_FIELDS });

  const nonEnumerable = {};
  Object.defineProperty(nonEnumerable, 'provider', { value: ' p ', enumerable: false });
  const kept = expectValue(nonEnumerable, 'non-enumerable own provider');
  assert.equal(kept.nextProvider, 'p');

  const nullProto = Object.create(null);
  nullProto.provider = ' q ';
  const accepted = expectValue(nullProto, 'null-proto body');
  assert.equal(accepted.nextProvider, 'q');

  const nullProtoValue = Object.create(null);
  Object.defineProperty(nullProtoValue, 'provider', { value: ' z ', enumerable: false });
  const nested = expectValue({ modelOverrides: { 'private:7': nullProtoValue } }, 'null-proto non-enumerable override');
  assert.deepStrictEqual(nested.patch.get('private:7'), { provider: 'z' });
});

test('差分：确定性组合矩阵（5 个字段 × 取值，含显式 undefined）', () => {
  const MISSING = Symbol('missing');
  const providers = [MISSING, undefined, null, '', ' p ', 5];
  const models = [MISSING, undefined, null, ' m ', 0];
  const efforts = [MISSING, undefined, null, '', ' high ', 3];
  const overrides = [MISSING, undefined, null, {}, { provider: ' p ' }, { reasoningEffort: null }, { model: undefined }];
  const removals = [MISSING, undefined, null, [], ['private:1'], 'x', ['bad']];
  let count = 0;
  for (const provider of providers) {
    for (const model of models) {
      for (const effort of efforts) {
        for (const override of overrides) {
          for (const removal of removals) {
            const body = {};
            if (provider !== MISSING) body.provider = provider;
            if (model !== MISSING) body.model = model;
            if (effort !== MISSING) body.reasoningEffort = effort;
            if (override !== MISSING) body.modelOverrides = override;
            if (removal !== MISSING) body.removeOverrides = removal;
            both(body, `matrix#${count}`);
            count += 1;
          }
        }
      }
    }
  }
  assert.equal(count, 6 * 5 * 6 * 7 * 7);
});

test('显式：Map / Set 插入顺序、重复删除去重、clean 键序恒为白名单序', () => {
  const result = expectValue({
    modelOverrides: {
      'group:2': { reasoningEffort: ' low ', provider: ' p ' },
      'private:10': { model: ' m ' },
      'private:2': { reasoningEffort: null }
    },
    removeOverrides: [' private:10 ', 'group:2', 'private:10']
  }, 'insertion order');
  assert.deepStrictEqual([...result.patch.keys()], ['group:2', 'private:10', 'private:2']);
  assert.deepStrictEqual(Object.keys(result.patch.get('group:2')), ['provider', 'reasoningEffort']);
  assert.deepStrictEqual(Object.keys(result.patch.get('private:10')), ['model']);
  assert.deepStrictEqual(Object.keys(result.patch.get('private:2')), ['reasoningEffort']);
  assert.equal(result.patch.get('private:2').reasoningEffort, null);
  assert.deepStrictEqual([...result.removals], ['private:10', 'group:2']);
});

console.log('');
if (failures.length) {
  console.error(`FAIL ${failures.length} / ${passed + failures.length}`);
  process.exitCode = 1;
} else {
  console.log(`PASS ${passed} / ${passed}`);
}
