// M8b + M1b: how a gap stops BLOCKING without being DELETED.
//
// THE CONFLICT THIS FILE PINS
// ---------------------------
//   · the write gate refused while any gap was present        (`audit-gap-present`)
//   · G-4 forbids deleting a gap (the gap IS the evidence that an audit row went missing)
//   ⇒ "non-empty ⇒ refuse" + "never delete" = recovery was impossible. An operator could repair the
//     store and the gate would still refuse forever, because the evidence had to stay.
//
// THE RESOLUTION
// --------------
// A gap entry gains `resolvedBy`: `null` (still open) or `{ generation, at, operator }`. The entry
// STAYS in `auditGaps`; the gate stops counting a correctly-marked one as a blocker. "Correctly
// marked" is decided by ONE shared validator, `isResolvedBy` in `qzone-policy-offline.mjs`, used by
// BOTH the gate and `formatAuditGap` — so the two sides cannot drift (GR-11 pins that they agree).
//
// WHAT A MARKER MUST SATISFY (and every "no" below still blocks writes)
// --------------------------------------------------------------------
//   · exact shape `{ generation, at, operator }` — nothing more, nothing less
//   · `generation` must EQUAL the entry's own `generation` (a marker for another failure episode
//     must not clear this one — that is the anti-stale/anti-replay rule)
//   · `at` a non-negative safe integer; `operator` a safe id
//   · missing `at`/`operator` (the "only generation" shape), wrong types, arrays, strings, numbers,
//     or extra fields ⇒ NOT resolved
//
// ⚠️ SHAPE IS NOT AUTHORISATION. Passing these checks does not prove the caller was entitled to
// clear the gap; that belongs to M9's controlled recovery transaction, which is the only code
// permitted to write the marker plus its management audit. A model-supplied claim cannot obtain
// recovery by satisfying a shape check, and nothing in this file asserts otherwise.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkWriteGate,
  isResolvedBy,
} from '../src/core/qzone-policy-offline.mjs';
import {
  formatAuditGap,
  formatAuditRecord,
  isAuditGap,
} from '../src/core/qzone-audit-offline.mjs';

const T0 = 1_800_000_000_000;
const GEN = 'gen-0001';
const OTHER_GEN = 'gen-0002';

/** A state that passes every OTHER gate check, so any refusal must come from `auditGaps`. */
const healthy = (over = {}) => ({
  enabled: true, readAllowed: true, writeAllowed: true,
  accessPaused: false, writePaused: false,
  ledger: { day: '2026-11-13', used: { post: 0, comment: 0, like: 0 }, reservations: {} },
  writeGate: null,
  auditGaps: [],
  ...over,
});

/** A gap exactly as M8b writes it. */
const gapEntry = (over = {}) => formatAuditGap({
  key: 'settle-1',
  reason: 'audit-write-failed',
  generation: GEN,
  time: T0,
  ...over,
});

/** A resolution marker for `generation`. */
const marker = (generation = GEN, over = {}) => ({ generation, at: T0 + 1000, operator: 'ops-1', ...over });

const gate = (state) => checkWriteGate(state);

// ══════════════════════════════════════════════════════════════════════════════════════
// GR-1 未解决缺口 → 拒绝
// ══════════════════════════════════════════════════════════════════════════════════════

test('GR-1 未解决缺口（resolvedBy:null）→ checkWriteGate 拒绝 audit-gap-present', () => {
  const entry = gapEntry();
  assert.equal(entry.resolvedBy, null, '前提：新写入的缺口 resolvedBy 必须是 null（未解决）');

  assert.deepEqual(
    gate(healthy({ auditGaps: [entry] })),
    { allowed: false, reason: 'audit-gap-present' },
    '未解决的缺口必须阻写：缺口代表「一次结算没有留下审计行」，'
    + '放过它就等于允许在审计有洞的情况下继续对外写，这正是 gate 存在的理由',
  );

  // 多个未解决同样拒绝（不是只看第一条）。
  assert.deepEqual(
    gate(healthy({ auditGaps: [gapEntry({ key: 'a' }), gapEntry({ key: 'b' })] })),
    { allowed: false, reason: 'audit-gap-present' },
    '多条未解决缺口也必须拒绝：若这条红，说明只看第一条，后面新增的洞会被静默忽略',
  );

  // 空数组仍然放行（正控：证明拒绝确实来自缺口，而不是 gate 恒拒）。
  assert.deepEqual(
    gate(healthy({ auditGaps: [] })),
    { allowed: true },
    '正控：空 auditGaps 必须放行，否则上面的拒绝断言无法区分「有洞」与「gate 坏了」',
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════
// GR-2 已解决 → 放行，且条目仍在数组里（G-4 核心）
// ══════════════════════════════════════════════════════════════════════════════════════

test('GR-2 写入合法 resolvedBy 后 → 放行，且条目仍留在 auditGaps 数组里（没有删除证据）', () => {
  const resolved = gapEntry({ resolvedBy: marker() });
  assert.notEqual(resolved.resolvedBy, null, '前提：resolvedBy 已被写入');
  assert.equal(resolved.resolvedBy.generation, GEN, '前提：标记的 generation 与条目一致');

  const state = healthy({ auditGaps: [resolved] });
  assert.deepEqual(
    gate(state),
    { allowed: true },
    '已正确标记解决的缺口必须放行：若这条红，说明「已解决」被当成「未解决」，'
    + '恢复动作永远无法让写入重新可用 —— 这就是 M8b/M1b 要解决的那个死锁',
  );

  // ★ G-4：条目必须还在。gate 不得以「删掉它」作为放行手段。
  assert.equal(
    state.auditGaps.length,
    1,
    '★ 放行之后缺口条目必须仍在 auditGaps 数组里：若这条红，说明恢复是靠「删除证据」实现的，'
    + '而缺口正是「某次结算没有审计行」的唯一证据（G-4 明确禁止删除/清空）',
  );
  assert.equal(
    state.auditGaps[0],
    resolved,
    '★ 数组里保留的必须是同一条记录（不是被替换成占位）：历史证据要能原样可查',
  );
  assert.equal(isAuditGap(state.auditGaps[0]), true, '保留下来的条目仍必须通过形状校验（可被恢复流程重新读到）');

  // 正控：把 resolvedBy 去掉（回到未解决）→ 立刻又拒绝，说明放行确实来自那个标记。
  const reopened = healthy({ auditGaps: [gapEntry()] });
  assert.deepEqual(
    gate(reopened),
    { allowed: false, reason: 'audit-gap-present' },
    '正控：同一条缺口去掉 resolvedBy 后必须重新阻写，否则无法证明放行来自标记而不是别的因素',
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════
// GR-3 代际不符 → 仍拒绝
// ══════════════════════════════════════════════════════════════════════════════════════

test('GR-3 resolvedBy.generation 与条目 generation 不符 → 仍拒绝（anti-stale / anti-replay）', () => {
  // ⚠️ 这条必须**手工构造**，不能让 `formatAuditGap` 代劳：M8b 的格式器本身就会拒绝代际不符的
  //    标记（那是对的）。但 store 里的数据可能是别处写的、被迁移的或被篡改的，gate 不能假定
  //    「数组里的条目一定经过 formatAuditGap」，所以这里直接构造那种脏数据来测 gate 的防御。
  const staleEntry = {
    key: 'settle-1', reason: 'audit-write-failed', generation: GEN, time: T0,
    resolvedBy: marker(OTHER_GEN),          // ← 标记属于另一次故障代际
  };
  assert.deepEqual(
    gate(healthy({ auditGaps: [staleEntry] })),
    { allowed: false, reason: 'audit-gap-present' },
    '代际不符的标记不得放行：那是「针对另一次故障」的解决凭据，'
    + '用它清这一条等于让旧事故的解决记录去解新事故 —— 复制一个旧标记就能无限解封写入',
  );

  // 格式器侧的同一规则（写入时就被挡住，而不是先存下再靠 gate 兜）。
  assert.throws(
    () => gapEntry({ resolvedBy: marker(OTHER_GEN) }),
    /invalid audit gap/,
    'formatAuditGap 本身也必须拒绝代际不符的标记：写入侧与读取侧用同一规则，'
    + '否则会出现「能写入但永远阻写」的条目',
  );

  // 正控：标记与自身代际一致的条目必须放行，说明上面的拒绝来自「不符」而不是「凡带标记都拒」。
  const ownGeneration = gapEntry({ resolvedBy: marker(GEN) });
  assert.deepEqual(
    gate(healthy({ auditGaps: [ownGeneration] })),
    { allowed: true },
    '正控：标记与自身代际一致的条目必须放行，否则上面的拒绝断言不构成「代际匹配」的证据',
  );

  // 把一条「属于 gen-0002 的合法已解决条目」的标记搬到 gen-0001 的条目上 → 不匹配。
  const otherEpisode = formatAuditGap({
    key: 'settle-9', reason: 'audit-write-failed', generation: OTHER_GEN, time: T0,
    resolvedBy: marker(OTHER_GEN),
  });
  const crossWired = { ...gapEntry(), resolvedBy: otherEpisode.resolvedBy };
  assert.deepEqual(
    gate(healthy({ auditGaps: [crossWired] })),
    { allowed: false, reason: 'audit-gap-present' },
    '把另一代际的合法标记搬到本代际条目上必须仍拒绝：这是最小可构造的「标记错配」场景，'
    + '若这条红，说明只校验了标记内部结构而没校验它与条目的对应关系',
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════
// GR-4 / GR-5 混合与全解决
// ══════════════════════════════════════════════════════════════════════════════════════

test('GR-4 混合（1 已解决 + 1 未解决）→ 拒绝；GR-5 全部已解决 → 放行', () => {
  const open = gapEntry({ key: 'open-1' });
  const done = gapEntry({ key: 'done-1', resolvedBy: marker() });

  assert.deepEqual(
    gate(healthy({ auditGaps: [done, open] })),
    { allowed: false, reason: 'audit-gap-present' },
    '一个已解决 + 一个未解决必须仍拒绝：若这条红，说明 gate 只看第一条/只看任意一条，'
    + '后面的洞会被前面的解决记录掩盖',
  );
  // 顺序无关：把未解决那条放到前面结论必须相同。
  assert.deepEqual(
    gate(healthy({ auditGaps: [open, done] })),
    { allowed: false, reason: 'audit-gap-present' },
    '顺序颠倒后结论必须不变：若这条红，说明判定依赖数组顺序，属于易被构造绕过的实现',
  );

  assert.deepEqual(
    gate(healthy({ auditGaps: [done, gapEntry({ key: 'done-2', resolvedBy: marker() })] })),
    { allowed: true },
    '全部已解决必须放行：若这条红，说明「已解决」只对部分条目生效，多条缺口的恢复永远无法完成',
  );
  // 全部解决后条目数量仍是 2（没被删）。
  const allResolved = healthy({
    auditGaps: [done, gapEntry({ key: 'done-2', resolvedBy: marker() })],
  });
  assert.equal(allResolved.auditGaps.length, 2,
    '全部解决后两条证据都必须仍在：G-4 要求保留历史，gate 只改变「是否阻塞」');
});

// ══════════════════════════════════════════════════════════════════════════════════════
// GR-6 resolvedBy 形状非法 → invalid-state
// ══════════════════════════════════════════════════════════════════════════════════════

test('GR-6 resolvedBy 是数组/字符串/数字/布尔 → invalid-state（无法解释的声明必须 fail closed）', () => {
  for (const bad of [[], ['g'], 'resolved', 42, true, 0]) {
    assert.deepEqual(
      gate(healthy({ auditGaps: [{ ...gapEntry(), resolvedBy: bad }] })),
      { allowed: false, reason: 'invalid-state' },
      `resolvedBy=${JSON.stringify(bad)} 必须判 invalid-state：这是一种我们读不懂的「我已解决」声明，`
      + '把读不懂的东西当作「已解决」就是 fail-open，而 gate 的职责恰恰是对读不懂的东西 fail closed',
    );
  }

  // 缺口条目本身不是对象（数组/字符串/数字）也是无法解释的状态。
  for (const badEntry of ['gap', 42, true, ['x']]) {
    assert.deepEqual(
      gate(healthy({ auditGaps: [badEntry] })),
      { allowed: false, reason: 'invalid-state' },
      `auditGaps 元素=${JSON.stringify(badEntry)} 必须判 invalid-state：元素不是记录就无法读出代际，`
      + '不能默认它是已解决的',
    );
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// GR-7 formatAuditGap 形状 + formatAuditRecord 键序未被牵连
// ══════════════════════════════════════════════════════════════════════════════════════

test('GR-7 formatAuditGap 输出 = 原四字段 + resolvedBy，且 formatAuditRecord 键序未变', () => {
  const entry = gapEntry();
  assert.deepEqual(
    Object.keys(entry),
    ['key', 'reason', 'generation', 'time', 'resolvedBy'],
    'M8b 只在末尾追加 resolvedBy，原有四个字段一个都不能少也不能改名：'
    + '若这条红，说明既有字段被删/被挪，恢复流程按字段读取会拿到 undefined',
  );
  assert.equal(entry.resolvedBy, null, '默认（未解决）时 resolvedBy 必须是 null 而不是 undefined：'
    + 'null 是显式的「还没有解决标记」，undefined 会让人分不清「字段缺失」与「还没解决」');

  const resolved = gapEntry({ resolvedBy: marker() });
  assert.deepEqual(
    Object.keys(resolved.resolvedBy),
    ['generation', 'at', 'operator'],
    '标记形状必须恰是 generation/at/operator：多一个字段就意味着有额外信息（例如自报的身份证明）'
    + '可以混进长期保留的记录里',
  );
  assert.equal(Object.isFrozen(resolved.resolvedBy), true, '标记必须冻结，避免落盘后被偷改');
  assert.equal(isAuditGap(resolved), true, '带合法标记的条目仍必须通过 isAuditGap');

  // ★ formatAuditRecord 的键序不能因为 M8b 被牵连改动（settled 幂等键依赖它）。
  const record = formatAuditRecord({
    time: T0, source: 'qq', action: 'publish', target: '9876543210', postId: 'p-1',
    commentId: null, content: 'hello', result: 'success', reason: '', quota: null,
  });
  assert.deepEqual(
    Object.keys(record),
    ['time', 'source', 'action', 'target', 'postId', 'commentId',
      'content', 'redacted', 'result', 'reason', 'quota'],
    '【不要为了让它变绿而改这条断言】\n'
    + 'settled 幂等键 = sha256(JSON.stringify(formatAuditRecord(...)))，而 JSON.stringify 依赖属性插入\n'
    + '顺序。M8b 只应改动 auditGaps 条目，绝不能牵连 formatAuditRecord —— 一旦字段被重排/增删，\n'
    + '全部历史 settled 键立刻失效，跨重启的 G1 幂等保护静默归零（不报错、不告警）。\n'
    + '若确实需要改动，必须同时提供存量 settled 键的迁移方案并在同一个变更里验证。',
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════
// GR-8 Codex 反控：只有 generation 的标记不得放行
// ══════════════════════════════════════════════════════════════════════════════════════

test('GR-8 反控：resolvedBy 只给 generation（缺 at/operator）→ 仍阻写', () => {
  // Codex 原话：「加反控如 {generation:'g',resolvedBy:{generation:'g'}} 不得放行」。
  const onlyGeneration = { generation: GEN };
  const state = healthy({
    auditGaps: [{ key: 'k1', reason: 'audit-write-failed', generation: GEN, time: 1, resolvedBy: onlyGeneration }],
  });
  const verdict = gate(state);
  assert.equal(
    verdict.allowed,
    false,
    '★ 只有 generation 的标记绝不能放行：形状不完整的「已解决」声明等于没有凭据，'
    + '放行它就意味着任何人写一个 {generation:' + GEN + '} 就能解封写入',
  );
  assert.ok(
    ['audit-gap-present', 'invalid-state'].includes(verdict.reason),
    `拒绝原因必须落在 audit-gap-present / invalid-state 之一（实际 ${verdict.reason}）：`
    + '这两种之外的码会让运维以为是别的问题',
  );

  // at / operator 各自缺失都必须拒（逐个验，避免只查其中一个）。
  for (const partial of [{ generation: GEN, at: T0 + 1 }, { generation: GEN, operator: 'ops-1' }]) {
    assert.equal(
      gate(healthy({ auditGaps: [{ key: 'k1', reason: 'audit-write-failed', generation: GEN, time: 1, resolvedBy: partial }] })).allowed,
      false,
      `缺字段的标记 ${JSON.stringify(partial)} 必须仍阻写：部分字段的「已解决」不构成凭据`,
    );
  }

  // 类型错误也必须拒。
  for (const bad of [
    { generation: GEN, at: '1800000000000', operator: 'ops-1' },
    { generation: GEN, at: -1, operator: 'ops-1' },
    { generation: GEN, at: 1.5, operator: 'ops-1' },
    { generation: GEN, at: T0, operator: '' },
    { generation: GEN, at: T0, operator: 42 },
    { generation: GEN, at: T0, operator: 'ops-1', extra: 'x' },
  ]) {
    assert.equal(
      gate(healthy({ auditGaps: [{ key: 'k1', reason: 'audit-write-failed', generation: GEN, time: 1, resolvedBy: bad }] })).allowed,
      false,
      `类型/多字段错误的标记 ${JSON.stringify(bad)} 必须仍阻写：`
      + '多出来的字段可能是自报身份，长期保留后会变成「谁解决的」的伪证',
    );
  }

  // 正控：补齐 at/operator 后必须放行，证明上面的拒绝来自字段缺失而非结构不可用。
  assert.equal(
    gate(healthy({ auditGaps: [{ key: 'k1', reason: 'audit-write-failed', generation: GEN, time: 1, resolvedBy: marker() }] })).allowed,
    true,
    '正控：补齐 at/operator 后必须放行，否则无法区分「校验严格」与「带标记一律拒」',
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════
// GR-9 resolvedBy 未识别形态 → invalid-state（与 GR-6 互补：这里走 gate 的对外语义）
// ══════════════════════════════════════════════════════════════════════════════════════

test('GR-9 resolvedBy 未识别形态（数组/字符串/数字/函数）→ invalid-state，不是 audit-gap-present', () => {
  for (const bad of [[marker()], 'resolved', 1, () => true]) {
    assert.deepEqual(
      gate(healthy({ auditGaps: [{ ...gapEntry(), resolvedBy: bad }] })),
      { allowed: false, reason: 'invalid-state' },
      `未识别形态 ${typeof bad} 必须报 invalid-state：它与「有洞未解决」是两种不同的处置 —— `
      + '前者要修数据，后者要执行恢复。混淆会让运维反复执行恢复而问题依旧',
    );
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// GR-10 旧缺口（无 resolvedBy 字段）→ 按未解决
// ══════════════════════════════════════════════════════════════════════════════════════

test('GR-10 旧缺口完全没有 resolvedBy 字段 → 按未解决处理（向后兼容，安全方向）', () => {
  // M8 之前写入的条目就是这个形状。
  const legacy = { key: 'settle-1', reason: 'audit-write-failed', generation: GEN, time: T0 };
  assert.equal(Object.hasOwn(legacy, 'resolvedBy'), false, '前提：这条旧缺口确实没有 resolvedBy 字段');

  assert.deepEqual(
    gate(healthy({ auditGaps: [legacy] })),
    { allowed: false, reason: 'audit-gap-present' },
    '缺少 resolvedBy 的旧缺口必须按未解决处理：把「字段不存在」当成「已解决」，'
    + '就等于让所有历史缺口在升级的瞬间自动解封 —— 那是 fail-open 的兼容方向，选错了',
  );

  // 显式 undefined 与缺失等价（JSON 往返后两者不可区分）。
  assert.deepEqual(
    gate(healthy({ auditGaps: [{ ...legacy, resolvedBy: undefined }] })),
    { allowed: false, reason: 'audit-gap-present' },
    'resolvedBy 显式为 undefined 必须与「字段缺失」同等处理：'
    + '经 JSON 往返后两者无法区分，若判定不同就会出现「落盘前放行、落盘后拒绝」的诡异行为',
  );

  // 正控：补上合法标记后放行。
  assert.deepEqual(
    gate(healthy({ auditGaps: [{ ...legacy, resolvedBy: marker() }] })),
    { allowed: true },
    '正控：给同一条旧缺口补上合法标记后必须放行，证明兼容规则只影响「缺少标记」这一种情况',
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════
// GR-11 gate 与 audit 对 resolvedBy 的判定必须一致（共享同一规则）
// ══════════════════════════════════════════════════════════════════════════════════════

test('GR-11 一致性：同一 resolvedBy，isResolvedBy / gate / formatAuditGap 结论相同', () => {
  // 两边共享同一个校验函数（`policy.isResolvedBy`），这里是它的行为证据。
  const cases = [
    { label: '完整合法标记', value: marker(), expected: true },
    { label: '只有 generation', value: { generation: GEN }, expected: false },
    { label: '缺 operator', value: { generation: GEN, at: T0 }, expected: false },
    { label: '缺 at', value: { generation: GEN, operator: 'ops-1' }, expected: false },
    { label: '代际不符', value: marker(OTHER_GEN), expected: false },
    { label: 'at 为负', value: { generation: GEN, at: -1, operator: 'ops-1' }, expected: false },
    { label: 'at 非整数', value: { generation: GEN, at: 1.5, operator: 'ops-1' }, expected: false },
    { label: 'operator 空串', value: { generation: GEN, at: T0, operator: '' }, expected: false },
    { label: '多了字段', value: { ...marker(), extra: 1 }, expected: false },
    { label: '数组', value: [marker()], expected: false },
    { label: '字符串', value: 'resolved', expected: false },
    { label: 'null（未解决）', value: null, expected: false },
  ];

  for (const { label, value, expected } of cases) {
    // ① 共享校验函数的判定
    assert.equal(
      isResolvedBy(value, GEN),
      expected,
      `isResolvedBy(${label}) 期望 ${expected}：这是 gate 与 audit 共用的唯一规则源`,
    );

    // ② gate 的判定：合法标记 ⇒ 放行；其余 ⇒ 阻写
    const allowed = gate(healthy({ auditGaps: [{ ...gapEntry(), resolvedBy: value }] })).allowed;
    assert.equal(
      allowed,
      expected,
      `gate 对 ${label} 的结论必须与 isResolvedBy 一致（期望 allowed=${expected}）：`
      + '两边若不一致，就会出现「能写入但永远阻写」或「已阻写却被当成已解决」的镜像 bug',
    );

    // ③ formatAuditGap 的判定：**非 null** 标记能被写入 ⇔ 它被认作合法。
    //    null 是例外并且是正确的例外：null 表示「未解决」，格式器当然允许写出一个未解决的缺口，
    //    而 gate 必须把它当阻写 —— 两者并不矛盾，这正是「写入未解决」与「认作已解决」的区别。
    if (value !== null) {
      let writable;
      try {
        writable = true;
        formatAuditGap({ key: 'k', reason: 'audit-write-failed', generation: GEN, time: 1, resolvedBy: value });
      } catch { writable = false; }
      assert.equal(
        writable,
        expected,
        `formatAuditGap 对 ${label} 的可写判定必须与 isResolvedBy 一致（期望 ${expected}）：`
        + '若 audit 肯写但 gate 不认，恢复动作会「成功」却毫无效果；反之则写入即被拒',
      );
    }
  }

  // null 单独确认：能写、但不放行（这是三者里唯一一处「刻意不一致」，必须写清而不是混在循环里）。
  assert.equal(
    gate(healthy({ auditGaps: [{ ...gapEntry(), resolvedBy: null }] })).allowed,
    false,
    'null 必须放行吗？不 —— null 就是「未解决」，gate 必须阻写',
  );
  assert.equal(
    formatAuditGap({ key: 'k', reason: 'audit-write-failed', generation: GEN, time: 1, resolvedBy: null }).resolvedBy,
    null,
    'null 必须可写（写出来就是一条未解决的缺口）：这与 gate 的阻写并不矛盾，'
    + '因为「写入一条未解决缺口」和「把缺口标记为已解决」是两件事',
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 边界说明的代码化：形状合法 ≠ 有权恢复
// ══════════════════════════════════════════════════════════════════════════════════════

test('GR-12 边界：形状合法的标记能被写入，但本模块不判断「谁有权标记」（授权属于 M9）', () => {
  // 这条不是在测授权，而是把「我们没做什么」钉成可读事实，免得后来者以为 gate 已经做了鉴权。
  const forged = formatAuditGap({
    key: 'settle-1', reason: 'audit-write-failed', generation: GEN, time: T0,
    resolvedBy: { generation: GEN, at: T0, operator: 'anyone' },
  });
  assert.equal(
    gate(healthy({ auditGaps: [forged] })).allowed,
    true,
    '形状合法的标记会让 gate 放行 —— 这是设计边界，不是缺陷：gate 只做形状校验，'
    + '「谁有权写这个标记」由 M9 的受控恢复事务负责（连同管理审计一起写）',
  );
  assert.equal(
    isAuditGap(forged),
    true,
    '同样地 isAuditGap 也只做形状校验：它无法证明操作者身份，能证明的是结构可读',
  );
  // 但写不出「非法角色/自报权限」这类字段 —— 标记形状是闭集，没有放声明的地方。
  assert.throws(
    () => formatAuditGap({
      key: 'settle-1', reason: 'audit-write-failed', generation: GEN, time: T0,
      resolvedBy: { generation: GEN, at: T0, operator: 'anyone', role: 'admin' },
    }),
    /invalid audit gap/,
    '标记里不能夹带 role/scope 之类的自报权限字段：若这条红，说明有人给「自报身份」留了位置',
  );
});
