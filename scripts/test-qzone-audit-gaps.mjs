// M8: the `auditGaps` entry shape — the record of an audit write that FAILED.
//
// WHAT IS BEING PINNED, AND WHY EACH ONE MATTERS
// ----------------------------------------------
//   G-1  the key is the caller's STABLE identity, never a clock stamp
//   G-2  a gap entry can never claim `result:'success'`
//   G-4  this module ships no writer, so nothing here can clear a corrupt `audit`
//   G-5  no operation content / credentials can reach a gap entry
//
// The most important case in this file is AG-6: `formatAuditRecord`'s FIELD ORDER must not
// change. `settled` idempotency keys are `sha256(JSON.stringify(formatAuditRecord(...)))`, so
// reordering those fields invalidates every historical settled key and silently degrades the
// cross-restart idempotency guard (G1) back to unfixed. AG-6 exists so that anyone tempted to
// "just add a field while I'm here" is stopped by a red test that explains the consequence.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatAuditRecord,
  formatAuditGap,
  isAuditGap,
  AUDIT_GAP_REASONS,
} from '../src/core/qzone-audit-offline.mjs';

const T0 = 1_800_000_000_000;
const DIGEST = 'a'.repeat(32);

const gap = (over = {}) => ({
  key: `settle-1#${DIGEST}`,
  reason: 'audit-write-failed',
  generation: 'gen-0001',
  time: T0,
  ...over,
});

// ══════════════════════════════════════════════════════════════════════════════════════
// AG-1 合法条目
// ══════════════════════════════════════════════════════════════════════════════════════

test('AG-1 合法 auditGaps 条目通过 formatAuditGap 与 isAuditGap，形状是四字段 + resolvedBy', () => {
  // 稳定键的两种合法形态都要能通过：裸 id，以及 `<id>#<32 hex>`（settled 键那一路上来的形态）。
  for (const key of ['settle-1', `settle-1#${DIGEST}`, 'exec_abc-123']) {
    const entry = formatAuditGap(gap({ key }));
    assert.deepEqual(
      entry,
      { key, reason: 'audit-write-failed', generation: 'gen-0001', time: T0, resolvedBy: null },
      `合法输入 ${key} 必须原样成为 { key, reason, generation, time, resolvedBy } 五字段（M8b 新增 `
      + 'resolvedBy，未删任何既有字段）；若这条红，说明形状被改动，恢复流程按字段读取时会拿到 undefined',
    );
    assert.equal(isAuditGap(entry), true, '自己写出的条目必须能通过自己的形状校验（否则写入方与校验方不一致）');
  }

  // 第二个原因码同样合法 —— 两个码必须都能落盘，否则恢复流程永远看不到「状态损坏」这一类。
  const invalid = formatAuditGap(gap({ reason: 'audit-state-invalid' }));
  assert.equal(invalid.reason, 'audit-state-invalid',
    'audit-state-invalid 必须能写入：若这条红，状态损坏这类缺口就无法登记，只能被当成「写失败」反复重试');
  assert.equal(isAuditGap(invalid), true);

  // 冻结：条目是只读快照，调用方无法在落盘后偷改。
  assert.equal(Object.isFrozen(formatAuditGap(gap())), true,
    '返回的条目必须冻结：若这条红，调用方可以在写入后改动字段，恢复时的核对就失去意义');

  // 原因码集合是封闭的两个，不许多不许少。
  assert.deepEqual(
    [...AUDIT_GAP_REASONS],
    ['audit-write-failed', 'audit-state-invalid'],
    '原因码集合必须是这两个：audit-write-failed（可重试）与 audit-state-invalid（须先修状态）。'
    + '若合并成一个，恢复流程会对「状态损坏」也去重试，而那种重试永远不可能成功',
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════
// AG-2 缺稳定 key
// ══════════════════════════════════════════════════════════════════════════════════════

test('AG-2 缺稳定 key 或 key 形态非法 → 抛错（G-1：不得用时钟拼键）', () => {
  // 缺失 / 非字符串 / 空串 / 含非法字符 / 摘要位数不对 —— 全部拒绝。
  for (const badKey of [undefined, null, '', 42, {}, [], true,
    'has space', 'a/b', `settle-1#${'a'.repeat(31)}`, `settle-1#${'A'.repeat(32)}`, 'k'.repeat(129)]) {
    assert.throws(
      () => formatAuditGap(gap({ key: badKey })),
      /invalid audit gap/,
      `key=${JSON.stringify(badKey)} 必须被拒绝：key 是缺口与操作之间唯一的关联凭据，`
      + '形态不合法就无法保证两次登记指向同一次结算，缺口会变成无法核对的孤儿记录',
    );
  }

  // 缺字段与显式 undefined 同样拒绝（不能靠「默认填一个」蒙过去）。
  const { key, ...withoutKey } = gap();
  assert.throws(() => formatAuditGap(withoutKey), /invalid audit gap/,
    '完全没有 key 字段时必须抛错：若这条红，说明存在一个「默认键」，'
    + '那么所有缺键的缺口会挤在同一个默认键上，互相覆盖');

  // 关键的一条：键里不许出现像密钥的东西（复用审计 ID 的敏感检测）。
  assert.throws(() => formatAuditGap(gap({ key: 'sk-abcdefghijklmnop' })), /invalid audit gap/,
    '像密钥的 key 必须拒绝：缺口条目会被长期保留，把凭据写进键等于把凭据永久留在状态里');
});

// ══════════════════════════════════════════════════════════════════════════════════════
// AG-3 非法原因码
// ══════════════════════════════════════════════════════════════════════════════════════

test('AG-3 非法原因码 → 抛错（必须保留「写失败」与「状态损坏」的区分）', () => {
  for (const badReason of [undefined, null, '', 'failure', 'audit_failed', 'AUDIT-WRITE-FAILED',
    'audit-write-failed ', 'other', 0, true]) {
    assert.throws(
      () => formatAuditGap(gap({ reason: badReason })),
      /invalid audit gap/,
      `reason=${JSON.stringify(badReason)} 必须被拒绝：原因码是恢复动作的分支依据，`
      + '接受任意字符串就等于放弃「可重试」与「须先修状态」的区分，恢复流程只能盲试',
    );
  }

  // 两个合法码的语义必须真的不同（不是同义词），这里用「是否有重试意义」把它写进注释与断言。
  const retryable = formatAuditGap(gap({ reason: 'audit-write-failed' }));
  const needsRepair = formatAuditGap(gap({ reason: 'audit-state-invalid' }));
  assert.notEqual(retryable.reason, needsRepair.reason,
    '两个原因码必须是不同的值：若这条红，说明它们被合并，恢复流程无法区分「重试」与「先修状态」');
});

// ══════════════════════════════════════════════════════════════════════════════════════
// AG-4 G-2：绝不出现 result:'success'
// ══════════════════════════════════════════════════════════════════════════════════════

test("AG-4 带 result:'success' → 抛错（G-2：缺口记录的是审计失败，不是虚构成功）", () => {
  // 这里刻意要求**专属**错误信息，而不是「随便抛一个错就行」：
  // 'success' 必须走「伪造证据」这条专用分支，而不是落入下面的「缺口没有 result 字段」兜底。
  // 两者都抛错，但只有前者在错误里点明了 G-2 的后果；若允许兜底通过，
  // 将来有人删掉 success 那条专用判断（比如为了「简化」）时，这条用例会静默变绿。
  assert.throws(
    () => formatAuditGap(gap({ result: 'success' })),
    /result:"success" is forbidden/,
    "result:'success' 必须命中**专属**的 G-2 拒绝分支：缺口描述的是「本该存在的审计行丢了」，"
    + '给它盖上 success 就等于凭空伪造那条已经丢失的证据，比缺口本身更危险；'
    + '若这条红但用例仍抛错，说明 success 落进了通用兜底分支，G-2 的语义没有被单独守住',
  );

  // 不只是 success —— 缺口条目根本没有 result 字段，任何取值都拒绝。
  for (const badResult of ['failure', 'unknown', 'denied', '', null, 0]) {
    assert.throws(
      () => formatAuditGap(gap({ result: badResult })),
      /invalid audit gap/,
      `result=${JSON.stringify(badResult)} 也必须拒绝：缺口条目没有 result 字段，`
      + '允许任何取值都会让下游误以为这是一条正常审计记录而按结果分支处理',
    );
  }

  // 反向正控：不带 result 的合法条目必须通过，证明上面的拒绝不是「凡是带额外字段都拒」。
  assert.equal(isAuditGap(formatAuditGap(gap())), true,
    '正控：不带 result 的条目必须通过，否则上面的拒绝断言无法区分「严格」与「函数坏了」');
});

// ══════════════════════════════════════════════════════════════════════════════════════
// AG-5 G-5：不记敏感内容 —— 选择「拒绝」而不是「剥离」
// ══════════════════════════════════════════════════════════════════════════════════════
//
// 为什么选拒绝：剥离会让调用方以为「传 content 没关系，反正会被丢掉」，于是同一个错误
// 写法会在整个代码库里扩散；而缺口条目是要长期保留的，一旦哪天剥离逻辑被改宽，内容就
// 直接进状态。拒绝则在第一次就把 bug 暴露在调用点，并且能在错误信息里点名违规字段。
// 另外输出本来就是闭集 allowlist 构造的，所以「剥离」在实现上已经是保证的，
// 这里额外做的是**把错误显式化**。

test('AG-5 带敏感字段（content/body/target…）→ 抛错，且错误信息点名该字段（G-5）', () => {
  const sensitiveFields = {
    content: 'hello world',
    body: 'post body',
    text: 'some text',
    message: 'msg',
    target: '9876543210',
    postId: 'p-1',
    commentId: 'c-1',
    rawResponse: { cookie: 'x' },
    cookie: 'abc',
    qzonetoken: 'tok',
    accessToken: 'tok',
    apiKey: 'k',
    password: 'pw',
  };

  for (const [field, value] of Object.entries(sensitiveFields)) {
    assert.throws(
      () => formatAuditGap(gap({ [field]: value })),
      new RegExp(`"${field}"`),
      `带 ${field} 的输入必须抛错，而且错误信息要**点名**这个字段：`
      + '缺口条目会被长期保留，任何操作内容/凭据进入它都会造成不可逆的留存；'
      + '如果只是静默剥离，调用方会以为「传了也没事」，同样的错误写法会扩散到所有调用点',
    );
  }

  // 显式 undefined 不算「带了内容」（JSON 往返后字段会消失），不应误伤。
  assert.equal(isAuditGap(formatAuditGap(gap({ content: undefined }))), true,
    'content 显式 undefined 不算携带内容（JSON 往返后该字段本就消失）：若这条红，'
    + '说明校验过严，会让正常的「字段可能为 undefined」调用方无谓报错');

  // 输出是闭集 allowlist：未知但**非敏感**的额外字段被丢弃，而不是原样保留。
  const withExtra = formatAuditGap(gap({ note: 'this is a note', retryCount: 3 }));
  assert.deepEqual(
    Object.keys(withExtra).sort(),
    ['generation', 'key', 'reason', 'resolvedBy', 'time'],
    '输出必须只由 allowlist 的五个字段构造（M8b 新增 resolvedBy）：若这条红，说明额外字段会被透传，'
    + '将来某个新增的上游字段（例如后来的 body）就会随手进入缺口记录',
  );
  assert.equal(JSON.stringify(withExtra).includes('this is a note'), false,
    '被丢弃的额外字段内容不得出现在结果里：若这条红，说明「丢弃」只丢了键名却留下了值');
});

// ══════════════════════════════════════════════════════════════════════════════════════
// AG-6 守卫：formatAuditRecord 的输出键序未被改动
// ══════════════════════════════════════════════════════════════════════════════════════
//
// 这是本文件最重要的一条。`settled` 幂等键 = sha256(JSON.stringify(formatAuditRecord(...)))，
// 而 JSON.stringify 按属性插入顺序序列化。任何人为了加 auditGaps 而「顺手」调整
// formatAuditRecord 的字段顺序/名字/增删，都会让全部历史 settled 键失效 —— 不报警、不报错，
// 只是跨重启幂等保护静默归零（G1 退化成未修）。

test('AG-6 守卫：formatAuditRecord 的输出键序未变（11 键严格序列，M8 未动它）', () => {
  const record = formatAuditRecord({
    time: T0,
    source: 'qq',
    action: 'publish',
    target: '9876543210',
    postId: 'p-1',
    commentId: null,
    content: 'hello',
    result: 'success',
    reason: '',
    quota: null,
  });

  assert.deepEqual(
    Object.keys(record),
    ['time', 'source', 'action', 'target', 'postId', 'commentId',
      'content', 'redacted', 'result', 'reason', 'quota'],
    '【不要为了让它变绿而改这条断言】\n'
    + 'settled 幂等键 = sha256(JSON.stringify(formatAuditRecord(...)))，而 JSON.stringify 依赖\n'
    + '属性的插入顺序。改动 formatAuditRecord 的字段顺序/名字/增删，会让**所有历史 settled 键\n'
    + '立刻失效**：旧键再也匹配不上新结算，跨重启的 G1 幂等保护整体归零，并且不报错、不告警。\n'
    + '新增 auditGaps 这类能力必须走**纯新增**（新函数、新字段名），不得改这个对象的构造顺序。\n'
    + '若确实必须改，必须同时提供存量 settled 键的迁移方案并在同一个变更里验证。',
  );

  assert.equal(Object.keys(record).length, 11,
    'formatAuditRecord 的基本字段必须恰好 11 个：若这条红，说明字段被增删，'
    + '而任何增删都会改变 JSON.stringify 的结果，等于让历史 settled 键全部失效');

  // 管理类动作仍会**追加**两个字段（operator/pauseScope）—— 这是既有行为，M8 未改。
  // 这里钉住它，免得有人误以为「11 个键」在所有动作上都成立而把管理字段挪进基本构造里。
  const management = formatAuditRecord({
    time: T0, source: 'admin_script', action: 'restore', target: '9876543210',
    content: '{}', result: 'success', reason: '', operator: 'ops-1', pauseScope: 'both',
  });
  assert.deepEqual(
    Object.keys(management).slice(11),
    ['operator', 'pauseScope'],
    '管理类动作只在末尾**追加** operator/pauseScope：若这条红，说明管理字段被挪进了基本构造，'
    + '那会同时改变普通记录的序列化结果，历史 settled 键同样失效',
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════
// AG-7 G-1 实证：键与 time 无关，同一身份重试必须得到同一个键
// ══════════════════════════════════════════════════════════════════════════════════════

test('AG-7 实证：同一稳定身份在不同 time 下得到同一个 key（键与时钟无关）', () => {
  // 同一个身份、三次不同的时间戳 → 三份条目，但 key 必须完全相同。
  const sameIdentity = ['settle-1', `settle-1#${DIGEST}`];
  for (const key of sameIdentity) {
    const entries = [T0, T0 + 1, T0 + 86400000].map((time) => formatAuditGap(gap({ key, time })));
    assert.deepEqual(
      entries.map((entry) => entry.key),
      [key, key, key],
      '同一个稳定身份在不同时间点重试，key 必须保持不变：若这条红，说明键里混入了时钟，'
      + '那么一次审计写失败会在每次重试时生成新键，缺口无限增长，且没有任何一条能与原操作对上',
    );
    // time 仍然要如实记录（它只是元数据，不是键的一部分）。
    assert.deepEqual(
      entries.map((entry) => entry.time),
      [T0, T0 + 1, T0 + 86400000],
      'time 必须如实保留每次的时间：若这条红，说明时间被键吞掉，运维无法按时间排序缺口事件',
    );
    // 只有 key+reason+generation 一起才能区分条目；仅凭 time 不能。
    assert.equal(new Set(entries.map((entry) => entry.key)).size, 1,
      '三个不同时间的条目必须共享同一个 key（这正是「按身份去重」的前提）');
  }

  // 不同身份必须得到不同键（否则不同操作的缺口会互相覆盖）。
  const a = formatAuditGap(gap({ key: 'settle-1' }));
  const b = formatAuditGap(gap({ key: 'settle-2' }));
  assert.notEqual(a.key, b.key,
    '不同身份的 key 必须不同：若这条红，说明键被固定成常量，所有缺口会挤在同一个键上');
});

// ══════════════════════════════════════════════════════════════════════════════════════
// isAuditGap：形状校验必须独立于写入方
// ══════════════════════════════════════════════════════════════════════════════════════

test('AG-8 isAuditGap 拒绝多余字段、缺字段、被篡改的值与任何带 result 的形状', () => {
  const valid = formatAuditGap(gap());
  assert.equal(isAuditGap(valid), true, '前提：合法条目必须先是 true，否则下面的拒绝断言没有对照');

  // 多一个字段就不通过（尤其是 result —— 它会让人误以为缺口结算了某个操作）。
  for (const extra of [{ result: 'success' }, { result: 'failure' }, { content: 'x' }, { note: 'n' }, { ok: true }]) {
    assert.equal(
      isAuditGap({ ...valid, ...extra }),
      false,
      `带 ${JSON.stringify(extra)} 的条目必须被 isAuditGap 拒绝：`
      + '形状校验是读取侧的守卫，它必须和写入侧一样严，否则被外部篡改的条目会被当成合法缺口',
    );
  }

  // 缺字段。
  for (const field of ['key', 'reason', 'generation', 'time']) {
    const partial = { ...valid };
    delete partial[field];
    assert.equal(isAuditGap(partial), false,
      `缺 ${field} 的条目必须被拒绝：恢复流程按四个字段工作，缺任何一个都会让它拿到 undefined `
      + '并做出错误判断（例如把缺失的 reason 当成可重试）');
  }

  // 字段值被篡改。
  for (const mutate of [{ reason: 'audit_failed' }, { key: '' }, { generation: '' }, { time: -1 },
    { time: 1.5 }, { time: '1800000000000' }, { time: NaN }]) {
    assert.equal(isAuditGap({ ...valid, ...mutate }), false,
      `被篡改成 ${JSON.stringify(mutate)} 的条目必须被拒绝：若这条红，说明形状校验只看键名不看值，`
      + '脏数据可以冒充合法缺口进入恢复流程');
  }

  // 正控：把 reason 换成**另一个合法原因码**仍应通过 —— 说明上面拒绝的是「非法值」，
  // 而不是「任何与写入时不同的值」。缺了这条对照，上面那组拒绝就无法与「函数对所有输入都返回 false」区分。
  assert.equal(
    isAuditGap({ ...valid, reason: 'audit-state-invalid' }),
    true,
    '正控：换成另一个合法原因码必须仍通过，否则上面的「拒绝非法值」结论不成立',
  );

  // 非对象一律 false（不抛错 —— 校验函数不应该让调用方崩）。
  for (const notObject of [null, undefined, 0, '', 'x', [], true, () => {}]) {
    assert.equal(isAuditGap(notObject), false,
      `${JSON.stringify(notObject)} 必须判为 false 而不是抛错：`
      + 'isAuditGap 会被用在批量读取路径上，一条脏数据不该让整轮恢复中断');
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// G-4：本模块不提供写 auditGaps 的函数，因此不存在「清空损坏 audit」的路径
// ══════════════════════════════════════════════════════════════════════════════════════

test('AG-9 G-4 结构性证据：M8 没有引入任何写 auditGaps 的函数（不覆盖/清空损坏的 audit）', async () => {
  const mod = await import('../src/core/qzone-audit-offline.mjs');
  const exported = Object.keys(mod).sort();
  assert.deepEqual(
    exported,
    ['AUDIT_GAP_REASONS', 'appendOfflineAudit', 'formatAuditGap', 'formatAuditRecord',
      'isAuditGap', 'isSafeQzoneAuditId', 'pruneOfflineAudit'],
    'M8 只应新增 AUDIT_GAP_REASONS / formatAuditGap / isAuditGap 三个导出；'
    + '若出现 appendAuditGap 之类的写函数，就意味着有一条能在 audit 损坏时仍去写状态的路径，'
    + '需要单独审它是否满足 G-4（不得覆盖/清空损坏的 audit）',
  );

  // appendOfflineAudit 面对损坏的 audit 仍是抛错而不是重建 —— 既有行为，未改。
  const brokenStore = {
    read: () => ({ audit: 'not-an-array' }),
    update() { throw new TypeError('invalid audit state'); },
  };
  assert.throws(
    () => mod.appendOfflineAudit(brokenStore, 'id-1', {
      time: T0, source: 'qq', action: 'publish', target: '9876543210',
      content: 'x', result: 'success', reason: '',
    }),
    /invalid audit state/,
    'audit 损坏时 append 必须抛错而不是重建数组：若这条红，损坏的审计证据会被一次写入悄悄清掉（G-4）',
  );
});
