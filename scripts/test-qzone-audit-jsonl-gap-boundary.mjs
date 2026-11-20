// M10 边界：缺口记录（`auditGaps` 条目）**不得**进入操作审计 JSONL 导出。
//
// 为什么这条边界值得单独一个文件：
//   · 「缺口」与「操作审计」是两种**不同的记录**。操作审计说的是「谁在什么时候对谁做成了/失败了
//     什么」（`action` / `target` / `result` / `content`）；缺口说的是「一条本该存在的审计行**没能
//     写进去**」（`key` / `reason` / `generation` / `time` / `resolvedBy`，见 `formatAuditGap`）。
//     把后者塞进前者的文件流，等于让 `read()` 的消费方在一行一条的流里猜「这条是操作还是缺口」。
//   · 本文件钉的是 M10 的实现边界：`createAuditJsonl().append` 在**任何 I/O 之前**必须经过
//     `formatAuditRecord`，而缺口形状在该格式器这一层就被拒 —— 这是**结构性不可能**，不是「写了
//     一个 if 把它排除掉」。所以一旦有人为了「顺手支持缺口」放松格式校验，AJ-2 / AJ-2b / AJ-3 必红。
//   · AJ-4 钉另一条：`formatAuditRecord` 的字段**与顺序**不得改动。settled 幂等键 =
//     sha256(JSON.stringify(formatAuditRecord(...)))，而 JSON.stringify 依赖属性的插入顺序；重排会让
//     全部历史 settled 键失效，而且不报警、不报错（AT-16 守的就是这条）。
//
// 结论的**射程**（Codex 红线，读之前先看）：
//   本文件证明的是「**这个具体形状**的缺口输入被 `formatAuditRecord` 拒绝，且拒绝发生在任何文件
//   I/O 之前」。它**不**证明「sink 能自动判定任意伪造对象的来源/意图」—— sink 只做 allowlist
//   字段校验，不做出处鉴权。AJ-7 专门把这条射程写成断言并如实标注，别把它读成更强的结论。
//
// 全部用例都跑在 %TEMP% 真实目录上：被测模块本身就是做文件 I/O 的，断言也必须落到文件系统，
// 并且同时用模块的 `read()` 与 `fs` 直读两路核对，避免「模块对自己的写入撒谎也能过」。

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAuditJsonl } from '../src/core/qzone-audit-jsonl-offline.mjs';
import { formatAuditGap, formatAuditRecord } from '../src/core/qzone-audit-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';

/** 2026-11-07 23:59:00 Beijing。 */
const T_LATE = Date.parse('2026-11-07T15:59:00.000Z');
/** 2026-11-08 00:01:00 Beijing —— 比上一条晚两分钟，但属于下一个北京日。 */
const T_NEXT_DAY = Date.parse('2026-11-08T00:01:00.000Z');
/** 2026-11-07 12:00:00 Beijing —— 「今天」，用于 prune。 */
const T_NOON = Date.parse('2026-11-07T04:00:00.000Z');

const DAY_LATE = beijingDay(T_LATE);

function tempRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-audit-jsonl-gap-${label}-`));
  return {
    dir,
    /** 目录里 day 形状的 .jsonl 文件，排过序。 */
    dayFiles() {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
    },
    /** 目录里**任何**条目，用于「什么都没被创建」的断言。 */
    entries() {
      return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    },
    cleanup() {
      for (let i = 0; i < 20; i += 1) {
        try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
      }
    },
  };
}

function withTemp(label, body) {
  const t = tempRoot(label);
  try { return body(t); } finally { t.cleanup(); }
}

/** 一条合法操作审计输入。 */
const row = (over = {}) => ({
  time: T_LATE,
  source: 'qq',
  action: 'publish',
  target: '9876543210',
  postId: 'p-1',
  content: 'hello',
  result: 'success',
  reason: '',
  quota: null,
  ...over,
});

/**
 * 缺口语义的输入，形状刻意贴近「真实存下来的 auditGaps 条目」：
 * 有 key / reason / generation / time / resolvedBy，**没有** action / result / target / content。
 */
const gap = (over = {}) => ({
  key: 'settle-1#0123456789abcdef0123456789abcdef',
  reason: 'audit-write-failed',
  generation: 'gen-7',
  time: T_LATE,
  resolvedBy: null,
  ...over,
});

/** 已解决缺口：`resolvedBy` 是合法标记（generation 与本条一致、at 非负安全整数、operator 安全 id）。 */
const resolvedGap = () => gap({
  resolvedBy: { generation: 'gen-7', at: T_LATE + 1000, operator: 'ops-1' },
});

/** 把一次被拒尝试的实际报错文本抓出来（用于断言 + 报告里引用原文，而不是我口头描述）。 */
function captureAppendError(sink, input) {
  try {
    sink.append(input);
  } catch (error) {
    return { thrown: true, name: error.constructor.name, message: error.message };
  }
  return { thrown: false, name: null, message: null };
}

// ── AJ-1 正控：正常操作审计能进，落盘的一行与 formatAuditRecord 输出逐字节一致 ────────────
//
// 这条是负向测试的对照组。没有它，下面所有 `assert.throws` 都可能因为「sink 永远 throw」而假绿。
test('AJ-1 正控：正常操作审计写入成功，落盘行与 formatAuditRecord 输出逐字节一致', () => withTemp('ok', (t) => {
  const sink = createAuditJsonl({ root: t.dir, clock: () => T_LATE });
  const input = row();
  const out = sink.append(input);

  assert.equal(out.appended, true, '前提：合法操作审计必须写得进去');
  assert.equal(out.name, `${DAY_LATE}.jsonl`, '文件名必须是 beijingDay(记录自身 time) + .jsonl');
  assert.equal(out.redacted, false);
  assert.equal(path.dirname(out.path), path.resolve(t.dir), '落在 root 里');

  // 期望值取自被审查的格式器本身，而不是本文件手搓的模板 —— 断言的是「sink 不加工记录」。
  const expected = formatAuditRecord(input);
  const raw = fs.readFileSync(out.path, 'utf8');
  assert.equal(raw, `${JSON.stringify(expected)}\n`,
    '★ 落盘的一行必须正好是 JSON.stringify(formatAuditRecord(input)) + 换行：若这条红，说明 sink '
    + '自己改写了记录，磁盘流会与 store 数组流产生分歧');

  const lines = sink.read(DAY_LATE);
  assert.equal(lines.length, 1, '恰好一行');
  assert.deepEqual(JSON.parse(lines[0]), expected, '读回来的对象与格式器输出一致');
  assert.deepEqual(t.dayFiles(), [`${DAY_LATE}.jsonl`], '目录里只有这一个 day 文件');
}));

// ── AJ-2 未解决缺口（resolvedBy: null）→ 被拒，错误可读，且零落盘 ──────────────────────
test('AJ-2 未解决缺口喂给 append → TypeError 被拒，报错原文可读，目录/文件都没被创建', () => withTemp('gap-open', (t) => {
  const sink = createAuditJsonl({ root: t.dir, clock: () => T_LATE });
  const before = t.entries();

  const attempt = captureAppendError(sink, gap());
  assert.equal(attempt.thrown, true,
    '★ 未解决缺口必须被拒：若这条红，说明缺口能进操作审计 JSONL —— M10 被破坏');
  assert.equal(attempt.name, 'TypeError', '必须是被审查格式器抛的 TypeError（不是别的路径顺手炸的）');
  // 原文钉住：这就是 formatAuditRecord 的拒绝理由，换错误文案会让下游日志/告警失配。
  assert.equal(attempt.message, 'invalid audit record',
    `实际报错文本：${JSON.stringify(attempt.message)}（期望恰好是 formatAuditRecord 的 "invalid audit record"）`);

  // 「零 I/O」用文件系统证据说话：拒绝前后目录内容逐项一致。
  assert.deepEqual(t.entries(), before, '被拒之后目录必须没有任何变化（不能留下半条/空文件）');

  // 再喂一次「直接从 formatAuditGap 出来的冻结条目」——生产里真正会存进 state.auditGaps 的形状。
  const frozen = formatAuditGap({ key: 'settle-2', reason: 'audit-state-invalid', generation: 'gen-7', time: T_LATE });
  const second = captureAppendError(sink, frozen);
  assert.equal(second.message, 'invalid audit record', 'formatAuditGap 的正式输出同样必须被拒');
  assert.deepEqual(t.entries(), before, '两次拒绝之后目录仍必须为空');
}));

// ── AJ-2b 已解决缺口（合法 resolvedBy）→ 同样被拒 ────────────────────────────────────
test('AJ-2b 带合法 resolvedBy 的已解决缺口 → 同样被拒（恢复标记不改变它的记录种类）', () => withTemp('gap-resolved', (t) => {
  const sink = createAuditJsonl({ root: t.dir, clock: () => T_LATE });
  const entry = resolvedGap();
  assert.equal(entry.resolvedBy.generation, entry.generation, '前提：这是**合法**的 resolvedBy 标记');

  const attempt = captureAppendError(sink, entry);
  assert.equal(attempt.thrown, true, '★ 已解决缺口也必须被拒：resolvedBy 只表示「不再阻塞写」，不表示它成为操作审计');
  assert.equal(attempt.name, 'TypeError');
  assert.equal(attempt.message, 'invalid audit record', `实际报错文本：${JSON.stringify(attempt.message)}`);
  assert.deepEqual(t.entries(), [], '零落盘');
}));

// ── AJ-2c root 原本不存在 → 缺口被拒后**目录也没有被创建**（实测 ensureDir 在校验之后）──
test('AJ-2c root 不存在时缺口被拒 → 目录未被创建（校验真的排在 ensureDir 之前）', () => withTemp('gap-no-dir', (t) => {
  const nested = path.join(t.dir, 'state', 'qzone-audit');
  assert.equal(fs.existsSync(nested), false, '前提：目标目录不存在');

  const sink = createAuditJsonl({ root: nested, clock: () => T_LATE });
  const attempt = captureAppendError(sink, gap());
  assert.equal(attempt.message, 'invalid audit record');
  assert.equal(fs.existsSync(nested), false,
    '★ 缺口被拒后目录不得被创建：若这条红，说明 ensureDir（mkdirSync）跑在 formatAuditRecord 之前，'
    + '即「先建目录/先落盘、后校验」，那缺口就有了被写出去的窗口');

  // 正控：同一 sink 喂合法记录，目录必须被建出来 —— 证明上面那条不是「目录永远不建」的假绿。
  const out = sink.append(row());
  assert.equal(fs.existsSync(nested), true, '正控：合法 append 必须把目录建出来');
  assert.equal(out.name, `${DAY_LATE}.jsonl`);
}));

// ── AJ-2d 文件字节不变：已有 day 文件在两次缺口尝试前后**逐字节相同** ───────────────────
test('AJ-2d 已有 day 文件的字节在缺口 append 前后完全一致（不是「读回为空」这种弱断言）', () => withTemp('bytes', (t) => {
  const sink = createAuditJsonl({ root: t.dir, clock: () => T_LATE });
  const first = sink.append(row({ content: 'baseline-row' }));
  const file = first.path;

  // 快照：字节 + 大小 + 文件列表。三者都要在尝试后原样。
  const bytesBefore = fs.readFileSync(file);
  const textBefore = fs.readFileSync(file, 'utf8');
  const sizeBefore = fs.statSync(file).size;
  const listBefore = t.entries();
  assert.ok(sizeBefore > 0, '前提：基线文件真的有内容');

  assert.equal(captureAppendError(sink, gap({ key: 'settle-open' })).message, 'invalid audit record');
  assert.equal(captureAppendError(sink, resolvedGap()).message, 'invalid audit record');
  assert.equal(captureAppendError(sink, gap({ time: T_NEXT_DAY, key: 'settle-other-day' })).message,
    'invalid audit record', '换一个 time 的缺口同样被拒（不是只有特定天被拒）');

  const bytesAfter = fs.readFileSync(file);
  assert.equal(bytesAfter.equals(bytesBefore), true,
    '★ 字节必须完全一致：若这条红，说明缺口追加到了已有文件末尾（哪怕只写了半行也是污染）');
  assert.equal(fs.readFileSync(file, 'utf8'), textBefore, '文本视图同样一致');
  assert.equal(fs.statSync(file).size, sizeBefore, '大小不变（catch 住「写了又截断」这种假象）');
  assert.deepEqual(t.entries(), listBefore, '目录里没有新增任何文件，包括下一天的 day 文件');

  // 正控：同一文件仍然可追加合法记录，且变成两行 —— 证明上面的字节不变不是「文件被锁死」。
  sink.append(row({ content: 'after-attempts', postId: 'p-2' }));
  const afterLines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
  assert.equal(afterLines.length, 2, '正控：合法记录仍能追加，行数变 2');
  assert.equal(afterLines[0], textBefore.trimEnd(), '第一行（基线）逐字节未变');
}));

// ── AJ-3 一条 gap + 一条正常审计混着喂 → JSONL 里只有正常审计，行数 1 ──────────────────
test('AJ-3 gap 与正常审计混着喂 → 文件里只有那条正常审计，行数正好 1', () => withTemp('mixed', (t) => {
  const sink = createAuditJsonl({ root: t.dir, clock: () => T_LATE });

  // 顺序一：先缺口后正常。
  assert.equal(captureAppendError(sink, gap({ key: 'settle-single' })).message, 'invalid audit record');
  sink.append(row({ content: 'the-only-row' }));
  assert.equal(captureAppendError(sink, resolvedGap()).message, 'invalid audit record');

  const single = sink.read(DAY_LATE);
  assert.equal(single.length, 1, '★ 一缺口 + 一正常审计 ⇒ 行数必须正好是 1');
  let parsed = JSON.parse(single[0]);
  assert.equal(parsed.content, 'the-only-row');
  assert.equal(parsed.action, 'publish');
  for (const gapField of ['generation', 'resolvedBy', 'key']) {
    assert.equal(Object.hasOwn(parsed, gapField), false,
      `★ 落盘的行里不得出现缺口的 ${gapField} 字段：若这条红，说明缺口字段混进了操作审计流`);
  }
  assert.equal(fs.readFileSync(path.join(t.dir, `${DAY_LATE}.jsonl`), 'utf8').split('\n')
    .filter((line) => line !== '').length, 1, 'fs 直读同样正好 1 行（不是模块在撒谎）');

  // 顺序二（另一目录）：先正常后缺口。
  const t2 = tempRoot('mixed-reverse');
  try {
    const s2 = createAuditJsonl({ root: t2.dir, clock: () => T_LATE });
    s2.append(row({ content: 'operation-A' }));
    assert.equal(captureAppendError(s2, gap()).message, 'invalid audit record');
    s2.append(row({ content: 'operation-B', postId: 'p-2' }));
    const lines = s2.read(DAY_LATE);
    assert.equal(lines.length, 2, '两次正常 append 各占一行，缺口一条都没进');
    assert.deepEqual(lines.map((line) => JSON.parse(line).content), ['operation-A', 'operation-B'],
      '行序即合法追加顺序，中间没有缺口的空位');
  } finally { t2.cleanup(); }
}));

// ── AJ-4 序列化边界：formatAuditRecord 的字段与顺序未被改动 ───────────────────────────
test('AJ-4 快照：formatAuditRecord 11 键严格序列未变（重排 ⇒ 历史 settled 键全部失效）', () => {
  const input = {
    time: T_LATE, source: 'qq', action: 'publish', target: '9876543210',
    postId: 'p-1', commentId: null, content: 'hello', result: 'success', reason: '', quota: null,
  };
  const record = formatAuditRecord(input);

  assert.deepEqual(
    Object.keys(record),
    ['time', 'source', 'action', 'target', 'postId', 'commentId',
      'content', 'redacted', 'result', 'reason', 'quota'],
    '【不要为了让它变绿而改断言】settled 幂等键 = sha256(JSON.stringify(formatAuditRecord(...)))，'
    + '而 JSON.stringify 依赖属性插入顺序。重排/改名/增删字段会让**全部历史 settled 键立刻失效**：'
    + '旧键再也匹配不上新结算，跨重启的 G1 幂等保护整体归零，并且不报错、不告警。'
    + 'M10 的任何改动都不得触碰这个对象的构造顺序。',
  );

  // 逐字节快照：比键序更严一档 —— 值、null 占位、redacted 的位置都钉住。
  //（`${T_LATE}` 是 1794067140000 = 2026-11-07T15:59:00Z，与 T_LATE 常量同源，不是另抄一份。）
  assert.equal(
    JSON.stringify(record),
    '{"time":1794067140000,"source":"qq","action":"publish","target":"9876543210","postId":"p-1",'
    + '"commentId":null,"content":"hello","redacted":false,"result":"success","reason":"","quota":null}',
    '★ 固定输入的 JSON.stringify 快照必须逐字节一致：这是 settled 幂等键的输入，差一个字节就换一个键（AT-16）',
  );
  assert.equal(beijingDay(record.time), DAY_LATE, '前提：快照里的 time 确实是 2026-11-07（北京）');
});

test('AJ-4b M9 管理审计（restore）只在末尾**追加** operator/pauseScope，且能正常进 JSONL', () => withTemp('mgmt', (t) => {
  const input = {
    time: T_LATE, source: 'admin_script', action: 'restore', target: '9876543210',
    content: JSON.stringify({ selection: 'both', pauseReasons: { access: 'captcha', write: 'unknown' } }),
    result: 'success', reason: 'captcha', operator: 'ops-1', pauseScope: 'both',
  };
  const record = formatAuditRecord(input);
  assert.deepEqual(Object.keys(record).slice(11), ['operator', 'pauseScope'],
    '管理字段必须在 11 个基本字段**之后追加**：若这条红，说明它们被挪进基本构造，'
    + '那会同时改变普通记录的序列化结果，历史 settled 键同样失效');
  assert.deepEqual(Object.keys(record).slice(0, 11),
    ['time', 'source', 'action', 'target', 'postId', 'commentId', 'content', 'redacted', 'result', 'reason', 'quota'],
    '前 11 键与普通记录完全一致（管理审计不是另一套 schema）');

  // ★ M10 的排除范围**只有缺口**：M9 的恢复记录属于正常操作审计，必须能进。
  const sink = createAuditJsonl({ root: t.dir, clock: () => T_LATE });
  const out = sink.append(input);
  assert.equal(out.appended, true, '★ M9 的恢复/管理审计必须能写入：M10 排除的是缺口，不是管理审计');
  const lines = sink.read(DAY_LATE);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.action, 'restore');
  assert.equal(parsed.operator, 'ops-1');
  assert.equal(parsed.pauseScope, 'both');
  assert.equal(lines[0], JSON.stringify(record), '落盘内容与格式器输出逐字节一致（键序一并保留）');
}));

// ── AJ-5 日切与保留不变：文件名由记录自身 time 派生，prune 仍 7 天 ────────────────────
test('AJ-5 日切由记录自身 time 派生；prune 仍删 ≥7 天、保留 <7 天（policy 的 difference>=7 口径）', () => withTemp('day-prune', (t) => {
  // sink 的 clock 固定在 11-08，但写进去的记录 time 是 11-07 —— 文件名必须跟记录，不跟时钟。
  const sink = createAuditJsonl({ root: t.dir, clock: () => T_NEXT_DAY });
  const prevDay = sink.append(row({ time: T_LATE, content: 'yesterday-record' }));
  assert.equal(prevDay.name, '2026-11-07.jsonl', '★ 文件名必须由记录自身 time 派生，不能由写入时的 clock 派生');
  assert.equal(beijingDay(T_NEXT_DAY), '2026-11-08', '前提：clock 指向的下一天与记录不是同一天');
  const nextDay = sink.append(row({ time: T_NEXT_DAY, content: 'today-record' }));
  assert.equal(nextDay.name, '2026-11-08.jsonl');
  assert.deepEqual(t.dayFiles(), ['2026-11-07.jsonl', '2026-11-08.jsonl']);

  // prune 边界：以 T_NOON（2026-11-07）为「今天」。
  const p = tempRoot('prune');
  try {
    const sink2 = createAuditJsonl({ root: p.dir, clock: () => T_NOON });
    const eight = sink2.append(row({ time: Date.parse('2026-10-30T04:00:00.000Z') })); // 8 天前
    const seven = sink2.append(row({ time: Date.parse('2026-10-31T04:00:00.000Z') })); // 正好 7 天
    const six = sink2.append(row({ time: Date.parse('2026-11-01T04:00:00.000Z') }));   // 6 天前
    const today = sink2.append(row({ time: T_NOON }));

    assert.deepEqual([eight.name, seven.name, six.name, today.name],
      ['2026-10-30.jsonl', '2026-10-31.jsonl', '2026-11-01.jsonl', '2026-11-07.jsonl']);

    const out = sink2.prune();
    assert.deepEqual([...out.removed], ['2026-10-30.jsonl', '2026-10-31.jsonl'],
      '8 天前与 7 天整的都过期（policy 的 difference>=7 口径，本模块只是复用）');
    assert.equal(out.kept, 2, '6 天前 + 今天 两个保留');
    assert.equal(fs.existsSync(eight.path), false, '过期文件确实被删');
    assert.equal(fs.existsSync(six.path), true, '★ 6 天前的必须留下（边界另一侧的正对照）');
    assert.deepEqual(p.dayFiles(), ['2026-11-01.jsonl', '2026-11-07.jsonl']);
  } finally { p.cleanup(); }
}));

// ── AJ-6 没有旁路：对外只有 append/prune/read/root；校验排在第一次写入之前 ──────────────
test('AJ-6 不存在缺口旁路：对外面正好四个方法，且校验发生在任何文件写入之前', () => {
  const sink = createAuditJsonl({ root: path.join(os.tmpdir(), 'm10-surface'), clock: () => T_LATE });
  assert.deepEqual(Object.keys(sink).sort(), ['append', 'prune', 'read', 'root'],
    '★ createAuditJsonl 的对外面必须正好是这四个方法：若这条红，说明新增了 appendGap 之类的旁路，'
    + '那与 M10「缺口不进操作审计」的意图正相反');

  const source = fs.readFileSync(new URL('../src/core/qzone-audit-jsonl-offline.mjs', import.meta.url), 'utf8');
  const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  assert.equal(/appendGap|appendAuditGap|gapSink|formatAuditGap/.test(code), false,
    '★ 代码里（忽略纯注释行）不得出现缺口写入面：缺口只能活在 state.auditGaps，不能有第二个 sink');

  const validateAt = code.indexOf('formatAuditRecord(');
  assert.ok(validateAt > -1, '本模块必须继续复用 formatAuditRecord（不是自己写一套校验）');
  assert.ok(code.includes('appendFileSync('), '前提：模块里确实有 appendFileSync');

  // ⚠️ 这条检查收窄到 **append 的方法体**，原因不是放松，而是它原来用的是「全文第一次出现
  // appendFileSync 的位置」，那只是执行序的**代理**。现在模块里多了一个
  // `terminateTornTail(target)` 小工具（修复「残行无换行时新行被粘接、导致同一行重复落盘」），
  // 它的定义在 append 之前、里面也调 appendFileSync，于是全文序不再等于执行序 —— 原来的写法会
  // 对一个**永远不会在校验之前执行**的调用报红。
  //
  // 改成两份更精确的检查，都比原来更严格：
  //   (a) 在真正干活的 append 方法体内，校验必须排在任何写入之前；
  //   (b) terminateTornTail 的**调用点**必须排在 formatAuditRecord 之后（它只可能在那里被执行）。
  const appendStart = code.indexOf('append(input, options) {');
  assert.ok(appendStart > -1, '前提：找得到 append 方法体');
  const appendBody = code.slice(appendStart, code.indexOf('prune() {', appendStart));
  const validateInAppend = appendBody.indexOf('formatAuditRecord(');
  const firstWriteInAppend = appendBody.indexOf('appendFileSync(');
  assert.ok(validateInAppend > -1 && firstWriteInAppend > -1, '前提：append 体内既有校验也有写入');
  assert.ok(validateInAppend < firstWriteInAppend,
    '★ 校验必须排在 append 内第一次文件写入之前：若这条红，说明 append 里存在「先落盘后校验」');

  const terminateCallAt = appendBody.indexOf('terminateTornTail(target)');
  if (terminateCallAt > -1) {
    assert.ok(validateInAppend < terminateCallAt,
      '★ terminateTornTail 的调用必须排在校验之后：它在残行尾部补换行，也是写操作');
  }

  // `ensureDir` 的**定义**在 return 之前、但真正会建目录的是 append 里的**调用** `ensureDir();`。
  // 所以这里比的是调用点的位置，不是定义点的位置 —— 断言的是执行序，不是排版序。
  const ensureCallAt = code.indexOf('ensureDir();');
  assert.ok(ensureCallAt > -1, '前提：append 里有 ensureDir() 调用');
  assert.ok(validateAt < ensureCallAt,
    '★ ensureDir() 的调用必须排在 formatAuditRecord 之后（与 AJ-2c 的行为断言互相印证）：'
    + '若这条红，说明「先建目录、后校验」，缺口就有了留下副作用（目录）的窗口');
});

// ── AJ-7 射程与 SINK 的 fail-closed：混合伪造对象 —— 如实标注证明与未证明的部分 ──────────
test('AJ-7 射程：allowlist 保证缺口字段不会漏到磁盘，但 sink 不判定伪造对象的出处（如实标注）', () => withTemp('scope', (t) => {
  // (1) 未知但非敏感的额外字段被丢弃：输出由闭集 allowlist 构造。
  const withExtras = sinkAppendCapture(t, row({ note: 'forged-note', generation: 'gen-forged' }));
  assert.equal(Object.hasOwn(withExtras.parsed, 'note'), false, 'allowlist：额外字段 note 被丢弃');
  assert.equal(Object.hasOwn(withExtras.parsed, 'generation'), false, 'allowlist：额外字段 generation 被丢弃');

  // (2) 【如实标注】若调用方伪造一个**同时**带齐操作审计必填字段与缺口字段的混合对象，
  //     `formatAuditRecord` 会把它当操作审计接受（缺口字段被 allowlist 丢弃，不会落盘）。
  //     这证明的是「缺口**字段**不会漏进 JSONL」，**不**证明「sink 能自动判出处/意图」——
  //     sink 只校验形状，不做调用方鉴权（鉴权在受鉴权入口，不在这个文件 I/O 模块）。
  //     本用例因此**不**属于 M10 的「缺口不进 JSONL」结论射程，只用来钉住 allowlist 行为。
  const hybrid = {
    ...gap({ key: 'settle-hybrid' }),
    source: 'qq', action: 'publish', target: '9876543210', content: 'hybrid-row', result: 'success', reason: 'network',
  };
  const sink = createAuditJsonl({ root: t.dir, clock: () => T_LATE });
  const out = sink.append(hybrid);   // 不 assert.throws：这一条**会**被接受，因为它的操作审计字段是合法的
  const line = fs.readFileSync(out.path, 'utf8').trim().split('\n').pop();
  const parsed = JSON.parse(line);
  for (const gapField of ['key', 'generation', 'resolvedBy']) {
    assert.equal(Object.hasOwn(parsed, gapField), false,
      `★ 混合对象里的缺口字段 ${gapField} 不得落盘：若这条红，缺口字段真的进 JSONL 了`);
  }
  assert.equal(parsed.action, 'publish', '落盘的是那条被伪造的操作审计形状（缺口字段已丢弃）');
}));

/** 一次正常 append 的「磁盘行 + 解析对象」双视图。 */
function sinkAppendCapture(t, input) {
  const sink = createAuditJsonl({ root: t.dir, clock: () => T_LATE });
  const out = sink.append(input);
  const line = fs.readFileSync(out.path, 'utf8').trim().split('\n').pop();
  return { line, parsed: JSON.parse(line) };
}
