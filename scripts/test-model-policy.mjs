// DSH 模型目录 / 档位覆盖纯策略层的回归测试（不依赖 SnowLuma / DSH / QQ / 文件系统）。
// 用法：node --test scripts/test-model-policy.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONV_KEY_RE,
  DSH_OVERRIDE_FIELDS,
  REASONING_EFFORT_OPTIONS,
  httpFail,
  isPlainObject,
  modelCatalogProviders,
  nextOverrideTable,
  overrideTableOf,
  requireNonEmptyString,
  resolveEffortForModel,
} from '../src/core/model-policy.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

// 故意混入各种缺失/异常形状：纯函数必须原样兜底，而不是抛错或凭空补能力。
const catalog = deepFreeze({
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek 官方',
      models: [
        {
          id: 'deepseek-flash',
          name: 'Flash',
          reasoning: {
            efforts: [
              { id: 'low', name: '低', description: '快' },
              { id: 'high' },
              { id: 'max', name: '  ', description: 42 },
            ],
            defaultEffort: 'high',
          },
        },
        { id: 'no-reasoning' },
        { id: 'empty-reasoning', reasoning: { efforts: [], defaultEffort: null } },
        { id: 'broken-reasoning', reasoning: [] },
        {
          id: 'mixed-efforts',
          reasoning: { efforts: [{ id: 'medium' }, null, { id: 'XHIGH' }], defaultEffort: 'medium' },
        },
      ],
    },
    { id: '   ', name: '无 id', models: [{ id: 'x' }] },
    { id: 'empty-provider', models: [] },
    { id: 'names', name: '  ', models: [{ id: 'm', name: ' ' }, { id: '   ' }] },
  ],
});

test('modelCatalogProviders 转换缺失字段：丢弃无法定位的项，name 回退 id', () => {
  const providers = modelCatalogProviders(catalog);
  assert.deepEqual(providers, [
    {
      id: 'deepseek-official',
      name: 'DeepSeek 官方',
      models: [
        {
          id: 'deepseek-flash',
          name: 'Flash',
          reasoning: {
            efforts: [
              { id: 'low', name: '低', description: '快' },
              { id: 'high', name: 'high', description: '' },
              { id: 'max', name: 'max', description: '' },
            ],
            defaultEffort: 'high',
          },
        },
        { id: 'no-reasoning', name: 'no-reasoning', reasoning: { efforts: [], defaultEffort: null } },
        { id: 'empty-reasoning', name: 'empty-reasoning', reasoning: { efforts: [], defaultEffort: null } },
        { id: 'broken-reasoning', name: 'broken-reasoning', reasoning: { efforts: [], defaultEffort: null } },
        {
          id: 'mixed-efforts',
          name: 'mixed-efforts',
          reasoning: {
            efforts: [
              { id: 'medium', name: 'medium', description: '' },
              { id: 'XHIGH', name: 'XHIGH', description: '' },
            ],
            defaultEffort: 'medium',
          },
        },
      ],
    },
    {
      id: 'names',
      name: 'names',
      models: [{ id: 'm', name: 'm', reasoning: { efforts: [], defaultEffort: null } }],
    },
  ]);
});

test('modelCatalogProviders 对空目录/畸形目录回空数组，不伪造 DeepSeek 兜底能力', () => {
  for (const empty of [null, undefined, {}, { groups: null }, { groups: 'nope' }, { groups: [] }]) {
    assert.deepEqual(modelCatalogProviders(empty), []);
  }
  assert.deepEqual(modelCatalogProviders({ groups: [{ id: 'p', models: [] }] }), []);
});

test('无 reasoning 与显式空 reasoning 是两种语义：前者兼容旧档位，后者拒绝任何字符串档位', () => {
  // 没有 reasoning 元数据（旧 DSH / 旧目录）：只兼容内置 low/high/max，大小写不敏感。
  assert.deepEqual(resolveEffortForModel(catalog, 'deepseek-official', 'no-reasoning', 'MAX'),
    { ok: true, value: 'max' });
  // reasoning 是数组等非对象形状：同样视为没有元数据，走旧档位兼容。
  assert.deepEqual(resolveEffortForModel(catalog, 'deepseek-official', 'broken-reasoning', 'High'),
    { ok: true, value: 'high' });
  // 明确声明了 reasoning（efforts: []）：连旧档位也不接受，只能由调用方发 null 清空。
  const declaredNone = resolveEffortForModel(catalog, 'deepseek-official', 'empty-reasoning', 'low');
  assert.equal(declaredNone.ok, false);
  assert.equal(declaredNone.reason,
    'deepseek-official/empty-reasoning 在目录里声明为不支持思考强度，无法设置「low」');
});

test('档位大小写规范化：声明档位回写目录里的规范写法，旧档位回写小写', () => {
  assert.deepEqual(resolveEffortForModel(catalog, 'deepseek-official', 'deepseek-flash', 'HIGH'),
    { ok: true, value: 'high' });
  assert.deepEqual(resolveEffortForModel(catalog, 'deepseek-official', 'deepseek-flash', '  MaX  '),
    { ok: true, value: 'max' });
  assert.deepEqual(resolveEffortForModel(catalog, 'deepseek-official', 'mixed-efforts', 'xhigh'),
    { ok: true, value: 'XHIGH' });
});

test('未在目标模型声明的档位被拒绝，并列出该模型真实声明', () => {
  const result = resolveEffortForModel(catalog, 'deepseek-official', 'deepseek-flash', 'medium');
  assert.equal(result.ok, false);
  assert.equal(result.reason,
    '思考强度「medium」不在 deepseek-official/deepseek-flash 声明的档位里（low / high / max）');
});

test('未知 provider / 未知 model 不猜测、不回退默认档位', () => {
  const unknownProvider = resolveEffortForModel(catalog, 'openai', 'gpt', 'high');
  assert.equal(unknownProvider.ok, false);
  assert.match(unknownProvider.reason, /^未知 provider「openai」：DSH 模型目录里只有 /);
  assert.match(unknownProvider.reason, /deepseek-official/);

  const unknownModel = resolveEffortForModel(catalog, 'empty-provider', 'm', 'low');
  assert.equal(unknownModel.ok, false);
  assert.equal(unknownModel.reason, '未知 model「m」：empty-provider 下只有 (空)');
});

test('resolveEffortForModel 不把 null / 空串当成合法档位（清空协议由调用方处理）', () => {
  for (const [provider, model] of [['deepseek-official', 'no-reasoning'],
    ['deepseek-official', 'empty-reasoning']]) {
    for (const raw of [null, undefined, '', '   ']) {
      assert.equal(resolveEffortForModel(catalog, provider, model, raw).ok, false,
        `${provider}/${model} raw=${String(raw)}`);
    }
  }
});

test('目录转换与档位判定都不修改输入', () => {
  const before = JSON.stringify(catalog);
  const providers = modelCatalogProviders(catalog);
  const result = resolveEffortForModel(catalog, 'deepseek-official', 'deepseek-flash', 'low');
  assert.equal(result.ok, true);
  providers[0].models[0].reasoning.efforts[0].id = 'mutated';
  assert.equal(catalog.groups[0].models[0].reasoning.efforts[0].id, 'low');
  assert.equal(JSON.stringify(catalog), before);
});

test('override 显式 null 清除字段，省略字段继承现值，历史字段原样保留', () => {
  const base = {
    'private:1': {
      provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', note: 'legacy',
    },
    'group:2': { provider: 'minimax-cn', reasoningEffort: 'max' },
  };
  const patch = new Map([['private:1', { model: 'deepseek-pro', reasoningEffort: null }]]);
  const result = nextOverrideTable(base, patch, ['group:2']);
  assert.deepEqual(result, {
    // reasoningEffort 被 null 清掉；provider 省略 → 继承；历史字段 note 不能被静默丢弃。
    'private:1': { provider: 'deepseek-official', model: 'deepseek-pro', note: 'legacy' },
  });
  // 输入不被修改，输出是全新对象（磁盘与内存各算一次，不能共享引用）。
  assert.deepEqual(base, {
    'private:1': {
      provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', note: 'legacy',
    },
    'group:2': { provider: 'minimax-cn', reasoningEffort: 'max' },
  });
  assert.notEqual(result['private:1'], base['private:1']);
  assert.deepEqual([...patch.keys()], ['private:1']);
  assert.deepEqual(patch.get('private:1'), { model: 'deepseek-pro', reasoningEffort: null });

  // 省略 reasoningEffort 时继承旧档位（旧调用兼容），而不是被清空。
  const inherit = nextOverrideTable(base, new Map([['private:1', { model: 'x' }]]), []);
  assert.deepEqual(inherit['private:1'],
    { provider: 'deepseek-official', model: 'x', reasoningEffort: 'high', note: 'legacy' });
});

test('新 key 上的显式 null 不会留下 undefined 字段，removeOverrides 整条删除', () => {
  const result = nextOverrideTable({}, new Map([['private:9', { provider: 'p', reasoningEffort: null }]]), []);
  assert.deepEqual(result, { 'private:9': { provider: 'p' } });
  assert.equal(Object.prototype.hasOwnProperty.call(result['private:9'], 'reasoningEffort'), false);

  const removed = nextOverrideTable({ 'group:1': { provider: 'p' } }, new Map(), new Set(['group:1']));
  assert.deepEqual(removed, {});
});

test('nextOverrideTable 对非对象底表按空表处理，且无补丁时也返回深拷贝', () => {
  for (const base of [null, undefined, [], ['x'], 'nope', 42]) {
    assert.deepEqual(nextOverrideTable(base, new Map(), []), {});
  }
  const base = { 'private:1': { provider: 'p' } };
  const copy = nextOverrideTable(base, new Map(), []);
  assert.deepEqual(copy, base);
  assert.notEqual(copy, base);
  assert.notEqual(copy['private:1'], base['private:1']);
});

test('overrideTableOf 只读视图：形状不对回空表，合法时返回表本体', () => {
  const table = { 'private:1': { provider: 'p', model: 'm' } };
  assert.equal(overrideTableOf({ socialV2: { modelOverrides: table } }), table);
  for (const empty of [null, undefined, {}, { socialV2: null }, { socialV2: {} },
    { socialV2: { modelOverrides: [] } }, { socialV2: { modelOverrides: 'x' } }]) {
    assert.deepEqual(overrideTableOf(empty), {});
  }
});

test('httpFail 产出带状态码的 Error，供外层 catch 判 400/503', () => {
  const error = httpFail(400, '坏请求');
  assert.ok(error instanceof Error);
  assert.equal(error.message, '坏请求');
  assert.equal(error.statusCode, 400);
  assert.equal(httpFail(503, '目录不可用').statusCode, 503);
});

test('requireNonEmptyString 对非字符串/空串回 HTTP 400，并通过 trim 去掉首尾空白', () => {
  assert.equal(requireNonEmptyString('  model-a  ', 'model'), 'model-a');
  assert.throws(() => requireNonEmptyString(null, 'provider'), (error) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.message, 'provider 必须是字符串（收到 null）');
    return true;
  });
  for (const value of [42, undefined, {}, []]) {
    assert.throws(() => requireNonEmptyString(value, 'provider'), (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /^provider 必须是字符串（收到 /);
      return true;
    });
  }
  for (const value of ['', '   ', '\n\t']) {
    assert.throws(() => requireNonEmptyString(value, 'model'), (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.message, 'model 不能是空字符串');
      return true;
    });
  }
});

test('isPlainObject 只接受非数组对象（与桥接既有宽松判定一致）', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject({ nested: { a: 1 } }), true);
  for (const value of [null, undefined, [], ['x'], 'x', 42, true, () => {}]) {
    assert.equal(isPlainObject(value), false, String(value));
  }
});

test('CONV_KEY_RE 只接受 private/group 加正整数，且无 g 标志不漂移', () => {
  for (const key of ['private:1', 'group:42', 'private:10001']) {
    assert.equal(CONV_KEY_RE.test(key), true, key);
  }
  for (const key of ['private:0', 'group:0', 'private:01', 'group:1.5', 'private:-1',
    'private:', 'group:', 'Group:1', ' private:1', 'private:1 ', 'private:1:2', 'private:abc']) {
    assert.equal(CONV_KEY_RE.test(key), false, key);
  }
  // 无 g 标志：重复 test 同一字符串不能因 lastIndex 状态而翻转。
  assert.equal(CONV_KEY_RE.test('private:1'), true);
  assert.equal(CONV_KEY_RE.test('private:1'), true);
});

test('字段与旧档位常量保持原样（不新增档位、不改顺序）', () => {
  assert.deepEqual(DSH_OVERRIDE_FIELDS, ['provider', 'model', 'reasoningEffort']);
  assert.deepEqual(REASONING_EFFORT_OPTIONS, ['low', 'high', 'max']);
});
