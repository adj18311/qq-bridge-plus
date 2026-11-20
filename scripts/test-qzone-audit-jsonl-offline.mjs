// 批2-step1：导出器的「合法 ID 校验」与「完整性判定」。
//
// 这一套钉的是一个**实测过的缺陷**，不是假想：
//   · 生产者在 `state.audit` 里写出带冒号的 id（`read:<32hex>` / `write:<id>`），
//     而导出器的 `STORED_AUDIT_ID` 当时是 `/^[A-Za-z0-9_-]{1,128}$/`——不含冒号；
//   · 于是这些行被判为 `invalid` 跳过，而 `exportAll()` 仍然返回 `failed:false`；
//   · 真库实测：插件库 34 行里 7 行是 `read:<hex>`，跑出来 `exported:27 / skippedInvalid:14`。
//
// 每条用例都写成「改坏这一条就必红」的形状：
//   C1 冒号 id 被导出且**原样**保留（不转义、不改写）
//   C2 校验没有被放宽成任意字符串（`a:b:c`、空格、`/etc/passwd`、尾部冒号仍被拒）
//   C3 完整性是独立字段，且 `complete` 与 `failed` 各说各的
//   C4 `lostIds` 是**不重复**的行数，不随天数量翻倍（`skippedInvalid` 才会）
//   C5 真库里那种「一天多行、其中若干含冒号」的形状端到端走通
//   C6 重复导出幂等：带了冒号的 auditId 也能被 `scanDelivered` 认回来（否则会无限重追加）
//   C7 `status()` 与 `exportAll()` 对完整性的说法一致
//
// 全部落在 %TEMP%，用真 sink 写真文件，断言看磁盘字节与返回值。

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAuditJsonl, createAuditExporter } from '../src/core/qzone-audit-jsonl-offline.mjs';
import { formatAuditRecord } from '../src/core/qzone-audit-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';

/** 2026-11-07 23:00 北京。 */
const T1 = Date.parse('2026-11-07T15:00:00.000Z');
const T2 = Date.parse('2026-11-08T00:01:00.000Z');
const D1 = beijingDay(T1);
const D2 = beijingDay(T2);
/** 「现在」放在 D2 之后一天，两个 fixture 日都还在留存窗口内。 */
const NOW = T2 + 24 * 3600 * 1000;
const CLOCK = () => NOW;
if (D1 === D2) throw new Error('fixture: D1 与 D2 必须是两天');

function tempRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-jsonl-offline-${label}-`));
  return {
    dir,
    dayPath(day) { return path.join(dir, `${day}.jsonl`); },
    lines(day) {
      const p = path.join(dir, `${day}.jsonl`);
      if (!fs.existsSync(p)) return [];
      const text = fs.readFileSync(p, 'utf8');
      if (text === '') return [];
      const parts = text.split('\n');
      if (parts[parts.length - 1] === '') parts.pop();
      return parts;
    },
    cleanup() {
      for (let i = 0; i < 20; i += 1) {
        try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows 延迟 */ }
      }
    },
  };
}

function withTemp(label, body) {
  const t = tempRoot(label);
  try { return body(t); } finally { t.cleanup(); }
}

const input = (over = {}) => ({
  time: T1, source: 'qq', action: 'read_posts', target: '1234567890',
  postId: null, content: '', result: 'success', reason: '', quota: null, ...over,
});

/** `state.audit` 条目：已格式化的 record，形状与 `appendOfflineAudit` 存的一致。 */
const stored = (id, over = {}) => ({ id, record: formatAuditRecord(input(over)) });
const storeOf = (audit) => ({ read: () => ({ audit }) });
const SINK = (t) => createAuditJsonl({ root: t.dir, clock: () => NOW });

// ── C1 冒号 id：被导出，且原样保留 ─────────────────────────────────────────────────────────────
test('C1 合法的 read:<hex> / write:<id> 现在会导出，id 原样写进 auditId（不转义）', () => withTemp('colon', (t) => {
  // 这 7 行的 id 形状取自真库（`read:` + 32 位 hex）。`write:` 取自 qzone-settlement-offline.mjs:108。
  const audit = [
    stored('dsp_7f230325ca5539139b71bb7984dbeb04'),
    stored('read:f1509536b847b222d2c2177688e51e1d', { content: 'c1' }),
    stored('read:484e9e6d3f177675c823d242aea5862a', { content: 'c2' }),
    stored('read_intent_484e9e6d3f177675c823d242aea5862a', { content: 'c3' }),
    stored('write:abc-123', { content: 'c4' }),
    stored('auth_38034ffc-360a-4200-9a5f-6856ab4610b2_intent'),
    stored('probe_result_1'),
  ];
  const exporter = createAuditExporter({ store: storeOf(audit), jsonl: SINK(t), namespace: 'plugin', clock: CLOCK });

  const out = exporter.exportDay(D1);
  assert.equal(out.failed, false, `不该失败：${JSON.stringify(out)}`);
  assert.equal(out.exported, audit.length, '★★★ 七行全导出；这正是真库里被静默丢掉的 7 行');
  assert.equal(out.skippedInvalid, 0, '★★ 没有行被判 invalid');
  assert.equal(out.lostIds, 0, '★★ 不重复的丢失数必须是 0');
  assert.equal(out.complete, 'complete', '★★ 完整性字段必须说 complete');

  const ids = t.lines(D1).map((line) => JSON.parse(line).auditId);
  assert.deepEqual(ids, audit.map((e) => `plugin:${e.id}`),
    '★★★ auditId = namespace + 原始 id，逐字保留：没有 base64、没有百分号、没有去冒号');
  // 反面证据：转义体系会让这一行变成 plugin:read%3A... 之类。
  assert.equal(ids.includes('plugin:read:f1509536b847b222d2c2177688e51e1d'), true,
    '★ 冒号原样在两个分隔位之间，人眼可直接与 SQLite 对账');
}));

// ── C2 校验没有被放宽成「任意字符串」 ──────────────────────────────────────────────────────────
test('C2 校验仍是闭集：两个冒号 / 空格 / 路径 / 空段 一律拒绝，且如实计入丢失', () => withTemp('strict', (t) => {
  const bad = [
    stored('q1:q2:q3'),              // 两段以上：仍然非法
    stored('has space'),             // 空格
    stored('/etc/passwd'),           // 路径分隔
    stored('q4:'),                   // 尾部空段
    stored(':q5'),                   // 头部空段
    stored('..:..'),                 // '.' 不在字母表里
  ];
  const good = [stored('read:0123456789abcdef0123456789abcdef', { content: 'ok' })];
  // 连 id 都没有的行（null 条目）：只能计数、无法去重 —— 走 `lostUnidentified`，不能静默消失。
  const exporter = createAuditExporter({ store: storeOf([...bad, null, ...good]), jsonl: SINK(t), namespace: 'plugin', clock: CLOCK });

  const out = exporter.exportDay(D1);
  assert.equal(out.exported, 1, '★ 只有那一条合法行被写入');
  assert.equal(out.failed, false, '★ 拒绝非法行不是「导出中断」，failed 保持 false（它的既有语义）');
  assert.equal(out.skippedInvalid, bad.length + 1, '★★ 六条非法行 + 那条 null 条目都被计入跳过');
  assert.equal(out.lostIds, bad.length,
    '★★ 不重复丢失数只数「有 id 可去重」的 6 条（不可识别的单列到 lostUnidentified）');
  assert.equal(out.complete, 'incomplete', '★★★ 有跳过 ⇒ 必须明确「不完整」，不能只看 failed:false');
  assert.equal(out.skipCauses['invalid-id'], bad.length, '★★ 原因分类落在闭集 token 上');
  assert.equal(out.lostIds, bad.length, '★ lostIds 只数得清的（有 id 的）那 6 条');
  // 那条 null 条目**不属于任何一天**，所以它不进这一天的 skipCauses —— 这是刻意的：
  // 若每天都能认领它，就又回到了「一行坏行 = N 天」的乘法缺陷。它由 run 级的
  // `lostUnidentified` 报出（下面立即验证），天级只报自己的。
  assert.equal(out.skipCauses['unidentifiable-entry'], undefined,
    '★★ 无 id 的行不归属任何一天：天级原因里不应出现它');
  const all = exporter.exportAll();
  assert.equal(all.skipCauses['unidentifiable-entry'], 1, '★★ 但它必须在 run 级被归类');
  assert.equal(all.lostUnidentified, 1, '★★ 且进 lostUnidentified：无法去重，但不能不报');
  assert.equal(all.complete, 'incomplete', '★★ 有不可识别行 ⇒ 仍是不完整');

  const ids = t.lines(D1).map((line) => JSON.parse(line).auditId);
  assert.deepEqual(ids, ['plugin:read:0123456789abcdef0123456789abcdef']);

  // 非法 id 的**原文不出现在任何返回值里**（same discipline as failureCodeOf）。
  const serialized = JSON.stringify(out);
  for (const entry of bad) assert.equal(serialized.includes(entry.id), false,
    `★★ 丢失行的原始 id 不得被回显：${entry.id}`);
}));

// ── C3 complete 与 failed 是两个问题 ──────────────────────────────────────────────────────────
test('C3 complete 与 failed 各自独立：中断是 failed，跳过是 incomplete，两者不互相顶替', () => withTemp('verdict', (t) => {
  // (a) 干净 → complete / failed:false
  const clean = createAuditExporter({ store: storeOf([stored('ok_1')]), jsonl: SINK(t), namespace: 'ns', clock: CLOCK });
  const a = clean.exportAll();
  assert.equal(a.failed, false);
  assert.equal(a.complete, 'complete');

  // (b) 有跳过、但没中断 → failed:false + incomplete（旧版这里是 failed:false 且**无任何**不完整信号）
  const t2 = tempRoot('verdict2');
  try {
    const skipped = createAuditExporter({
      store: storeOf([stored('ok_1'), { id: 'bad id', record: formatAuditRecord(input()) }]),
      jsonl: SINK(t2), namespace: 'ns', clock: CLOCK,
    });
    const b = skipped.exportAll();
    assert.equal(b.failed, false, '★ 跳过不中断，failed 语义不变');
    assert.equal(b.complete, 'incomplete', '★★★ 但完整性必须说 incomplete');
    assert.equal(b.lostIds, 1);
  } finally { t2.cleanup(); }

  // (c) 真中断（日文件读不出来）→ failed:true 且 complete:'unknown'（不是 incomplete：没法枚举）
  const t3 = tempRoot('verdict3');
  try {
    const sink = SINK(t3);
    const flaky = {
      append: sink.append,
      read(day) {
        if (day === D1) { const e = new Error('simulated EACCES'); e.code = 'EACCES'; throw e; }
        return sink.read(day);
      },
    };
    const broken = createAuditExporter({ store: storeOf([stored('ok_1')]), jsonl: flaky, namespace: 'ns', clock: CLOCK });
    const c = broken.exportAll();
    assert.equal(c.failed, true, '★ 读失败仍然 failed:true');
    assert.equal(c.complete, 'unknown', '★★★ 读不出来 ⇒ unknown，绝不 complete，也不假装数清了');
    assert.notEqual(c.complete, 'complete');
  } finally { t3.cleanup(); }
}));

// ── C4 lostIds 不随天数量翻倍（skippedInvalid 会） ─────────────────────────────────────────────
test('C4 lostIds 是不重复的行数：一行坏行跨两天只算 1，skippedInvalid 会算 2', () => withTemp('count', (t) => {
  const badRow = { id: 'nope nope', record: formatAuditRecord(input({ time: T1 })) };
  const audit = [
    stored('good_1', { time: T1 }),
    stored('good_2', { time: T2, content: 'two' }),
    badRow,
  ];
  const exporter = createAuditExporter({ store: storeOf(audit), jsonl: SINK(t), namespace: 'ns', clock: CLOCK });

  const out = exporter.exportAll();
  assert.equal(out.exported, 2, '★ 两行好的都导出，各自落到自己的日文件');
  assert.equal(out.skippedInvalid, 2,
    '★ 旧计数器按天累加：同一行在 D1、D2 各被数一次 ⇒ 2（这正是它不能当丢失数的原因）');
  assert.equal(out.lostIds, 1,
    '★★★ 不重复丢失数按 id 去重 ⇒ 1；两个数字一起出现才说明「为什么旧的不能直接用」');
  assert.equal(out.complete, 'incomplete');
  assert.equal(out.skipCauses['invalid-id'], 1, '★ 原因计数按**行**算：这一行只被拒一次');

  // 天级明细：这一行只属于 D1（它的 record.time 在 D1），所以只有 D1 认领它。
  // 注意这里和 skippedInvalid 的差别不是笔误——跳过计数按「每走一天数一次」，归属按「这行属于哪天」。
  assert.equal(out.perDay[D1].lostIds, 1, '★ 它属于 D1，由 D1 认领');
  assert.equal(out.perDay[D2].lostIds, 0,
    '★★ D2 没有丢任何属于自己的行（旧 skippedInvalid 在这里也给它记了 1，这正是它不能当丢失数的原因）');
  assert.equal(out.perDay[D2].complete, 'complete', '★★ 对 D2 而言它是完整的');
}));

// ── C5 真库形状端到端：两天、多行、其中含冒号 ─────────────────────────────────────────────────
test('C5 真库形状端到端：34 行里 7 行含冒号的形状，导出后 34 行全部落盘', () => withTemp('realshape', (t) => {
  // 用真库的**形状**（不是内容）：dsp_ / read_intent_ / read: 三种，跨两天。
  const mk = (id, time) => stored(id, { time, content: '' });
  const audit = [];
  for (let i = 0; i < 21; i += 1) audit.push(mk(`dsp_${i.toString(16).padStart(32, '0')}`, T1));
  for (let i = 0; i < 6; i += 1) audit.push(mk(`read:${i.toString(16).padStart(32, '0')}`, T1));
  audit.push(mk('read:87be2922c88892031ae020d12dfe4c71', T2));
  audit.push(mk('read_intent_87be2922c88892031ae020d12dfe4c71', T2));
  for (let i = 0; i < 5; i += 1) audit.push(mk(`dsp_${(100 + i).toString(16).padStart(32, '0')}`, T2));

  const exporter = createAuditExporter({ store: storeOf(audit), jsonl: SINK(t), namespace: 'plugin', clock: CLOCK });
  const out = exporter.exportAll();
  assert.equal(out.exported, audit.length, `★★★ 34/34 全部导出（实测真库就是这个形状）；实际 ${out.exported}`);
  assert.equal(out.lostIds, 0);
  assert.equal(out.complete, 'complete');
  assert.equal(out.skippedInvalid, 0);

  const onDisk = [...t.lines(D1), ...t.lines(D2)].map((line) => JSON.parse(line).auditId);
  assert.equal(onDisk.length, audit.length);
  assert.equal(onDisk.filter((id) => id.split(':').length === 3).length, 7,
    '★★ 7 条三段式 auditId（namespace + read: + hex）原样落盘');
}));

// ── C6 幂等：带冒号的 auditId 必须能被 scanDelivered 认回来 ────────────────────────────────────
test('C6 带冒号的 auditId 可被认回：重复导出不会无限重追加', () => withTemp('idem', (t) => {
  const audit = [stored('read:deadbeefdeadbeefdeadbeefdeadbeef', { content: 'x' })];
  const exporter = createAuditExporter({ store: storeOf(audit), jsonl: SINK(t), namespace: 'plugin', clock: CLOCK });

  const first = exporter.exportDay(D1);
  assert.equal(first.exported, 1);

  const second = exporter.exportDay(D1);
  assert.equal(second.exported, 0, '★★★ 第二次 0 行：auditId 被认出来了');
  assert.equal(second.alreadyPresent, 1, '★★ 计为 alreadyPresent，不是 conflict');
  assert.equal(second.failed, false, '★★ 不是冲突');
  assert.equal(t.lines(D1).length, 1, '★★★ 磁盘上仍然只有一行；否则每次运行都会再加一行');
  assert.equal(second.complete, 'complete');
}));

// ── C7 status() 与 exportAll() 口径一致，且 status 不宣称「完整」 ──────────────────────────────
test('C7 status() 与 exportAll() 对完整性给出同一个答案，且 status() 仍不写盘', () => withTemp('statusreport', (t) => {
  const audit = [stored('read:11111111111111111111111111111111'), { id: 'bad id', record: formatAuditRecord(input()) }];
  const exporter = createAuditExporter({ store: storeOf(audit), jsonl: SINK(t), namespace: 'plugin', clock: CLOCK });

  // status() 读日文件，但**绝不创建目录**。先确认根目录不存在，再调，再确认仍不存在。
  const nested = path.join(t.dir, 'deep', 'nested');
  const sink = createAuditJsonl({ root: nested, clock: () => NOW });
  const probe = createAuditExporter({ store: storeOf(audit), jsonl: sink, namespace: 'plugin', clock: CLOCK });
  assert.equal(fs.existsSync(nested), false, '前提：目录还不存在');

  const st = probe.status();
  assert.equal(st.lostIds, 1, '★★ status 也要报出不重复丢失数');
  assert.equal(st.complete, 'incomplete', '★★★ 状态探针不能只说 pending/delivered 而不说不完整');
  assert.equal(st.skipCauses['invalid-id'], 1);
  assert.equal(fs.existsSync(nested), false, '★★ status() 仍然不创建目录');

  const out = exporter.exportAll();
  assert.equal(out.lostIds, st.lostIds, '★★ 两个入口对丢失数的说法必须一致');
  assert.equal(out.complete, st.complete, '★★ 两个入口对完整性的说法必须一致');
}));

// ── C8 覆盖面声明：JSONL 不覆盖 writeAudit，且这一点是代码里说死的 ──────────────────────────────
test('C8 coverage() 明确声明只覆盖 state.audit，并点名 writeAudit 未覆盖', () => withTemp('coverage', (t) => {
  const exporter = createAuditExporter({ store: storeOf([stored('a-1')]), jsonl: SINK(t), namespace: 'ns', clock: CLOCK });
  const cov = exporter.coverage();
  assert.deepEqual([...cov.covers], ['audit'], '★ 覆盖的是 state.audit');
  assert.deepEqual([...cov.uncovered], ['writeAudit'],
    '★★★ writeAudit 必须被点名未覆盖：不点名就等于让调用方把沉默当成「没有可导出的」');

  // 行为与声明一致：store 里塞了 writeAudit，导出结果里不会多出任何行。
  const withWriteAudit = {
    read: () => ({
      audit: [stored('a-1')],
      writeAudit: [{ authorizationId: 'auth-1', stage: 'result', outcome: 'success' }],
    }),
  };
  const t2 = tempRoot('coverage2');
  try {
    const ex2 = createAuditExporter({ store: withWriteAudit, jsonl: SINK(t2), namespace: 'ns', clock: CLOCK });
    const out = ex2.exportAll();
    assert.equal(out.exported, 1, '★★ 只有 state.audit 那一行被导出');
    assert.equal(t2.lines(D1).length, 1, '★★ 磁盘上没有 writeAudit 行');
    assert.equal(out.complete, 'complete',
      '★ 未覆盖 ≠ 不完整：覆盖面的问题由 coverage() 回答，不混进完整性判定');
  } finally { t2.cleanup(); }
}));

// ── C9 回归护栏：不带冒号的老 id 行为一字未变 ──────────────────────────────────────────────────
test('C9 老形状（无冒号）行为不变：auditId = namespace:id，且 complete', () => withTemp('legacy', (t) => {
  const exporter = createAuditExporter({ store: storeOf([stored('a-1'), stored('a-2', { content: 'b' })]), jsonl: SINK(t), namespace: 'ns1', clock: CLOCK });
  const out = exporter.exportDay(D1);
  assert.equal(out.exported, 2);
  assert.equal(out.complete, 'complete', '★ 新增字段的默认值必须是 complete');
  assert.equal(out.lostIds, 0);
  assert.deepEqual(out.skipCauses, {});
  assert.deepEqual(t.lines(D1).map((line) => JSON.parse(line).auditId), ['ns1:a-1', 'ns1:a-2']);
}));
