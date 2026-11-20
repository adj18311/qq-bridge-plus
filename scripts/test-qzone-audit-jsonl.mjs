// §7 audit JSONL sink: one file per Beijing day, one JSON object per line, 7-day prune.
//
// Everything runs against REAL files in a %TEMP% directory. The point of this file is that the module
// under test talks to the filesystem, so the assertions have to look at the filesystem too — reading
// back through the module AND through `fs` directly, so a module that lied about its own writes could
// not pass.
//
// Conventions:
//   · "nothing was deleted" is always measured against a directory that really contains the file, and
//     paired with a positive control that a genuinely expired file IS deleted;
//   · the redaction assertions search the RAW FILE BYTES for the secret, not just the parsed object,
//     because the whole risk is the plaintext reaching disk.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAuditJsonl } from '../src/core/qzone-audit-jsonl-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';

/** 2026-11-07 23:59:00 Beijing. */
const T_LATE = Date.parse('2026-11-07T15:59:00.000Z');
/** 2026-11-08 00:01:00 Beijing — two minutes later, next Beijing day. */
const T_NEXT_DAY = Date.parse('2026-11-08T00:01:00.000Z');
const T_NOON = Date.parse('2026-11-07T04:00:00.000Z');

function tempRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-audit-jsonl-${label}-`));
  return {
    dir,
    cleanup() {
      for (let i = 0; i < 20; i += 1) {
        try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
      }
    },
  };
}

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

// ── 1. normal write ────────────────────────────────────────────────────────────────
test('AJ-1 正常写入：文件按北京日命名、一行、可 JSON.parse、字段与 formatAuditRecord 一致', () => {
  const t = tempRoot('basic');
  try {
    const sink = createAuditJsonl({ root: t.dir, clock: () => T_LATE });
    const out = sink.append(row());

    const expectedName = `${beijingDay(T_LATE)}.jsonl`;
    assert.equal(out.name, expectedName, '文件名必须是 beijingDay(time)+.jsonl');
    assert.equal(out.appended, true);
    assert.equal(out.redacted, false);
    assert.equal(path.dirname(out.path), path.resolve(t.dir), '落在 root 里');

    // exists on disk, read through fs directly (not just through the module)
    assert.equal(fs.existsSync(out.path), true);
    const raw = fs.readFileSync(out.path, 'utf8');
    assert.ok(raw.endsWith('\n'), '每行以换行结尾');
    const lines = raw.split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 1, '恰好一行');

    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.time, T_LATE);
    assert.equal(parsed.action, 'publish');
    assert.equal(parsed.target, '9876543210');
    assert.equal(parsed.result, 'success');

    // module's own reader agrees
    assert.deepEqual([...sink.read(beijingDay(T_LATE))], [lines[0]]);
  } finally { t.cleanup(); }
});

// ── 2. day split ──────────────────────────────────────────────────────────────────
test('AJ-2 跨日分文件：23:59 与 00:01 的两条落进两个不同文件，各自只有一行', () => {
  const t = tempRoot('daysplit');
  try {
    const sink = createAuditJsonl({ root: t.dir, clock: () => T_LATE });
    assert.equal(beijingDay(T_LATE), '2026-11-07', '前提：第一条属于 11-07');
    assert.equal(beijingDay(T_NEXT_DAY), '2026-11-08', '前提：第二条属于 11-08');

    const a = sink.append(row({ time: T_LATE, content: 'late' }));
    const b = sink.append(row({ time: T_NEXT_DAY, content: 'early' }));

    assert.notEqual(a.name, b.name, '必须落到不同文件');
    assert.equal(a.name, '2026-11-07.jsonl');
    assert.equal(b.name, '2026-11-08.jsonl');

    const day7 = sink.read('2026-11-07');
    const day8 = sink.read('2026-11-08');
    assert.equal(day7.length, 1);
    assert.equal(day8.length, 1);
    assert.equal(JSON.parse(day7[0]).content, 'late');
    assert.equal(JSON.parse(day8[0]).content, 'early');

    // The file name follows the RECORD's time, not the wall clock at write time — the sink's clock is
    // pinned to T_LATE throughout, yet the 11-08 record still landed in 11-08.
    const onDisk = fs.readdirSync(t.dir).filter((n) => n.endsWith('.jsonl')).sort();
    assert.deepEqual(onDisk, ['2026-11-07.jsonl', '2026-11-08.jsonl']);
  } finally { t.cleanup(); }
});

// ── 3. prune: 7 days ──────────────────────────────────────────────────────────────
//
// BOUNDARY NOTE (measured, and it is the policy's own rule — this module only re-uses it):
// `auditRetentionDecision` computes `difference = today - day` in days and returns `expired` when
// `difference >= 7`. So a file dated exactly 7 days before today IS deleted; "keep 7 days" in practice
// means "today plus the six preceding days". The case below pins that boundary in both directions so a
// future change to the policy can't slide it silently.
test('AJ-3 7 天清理：8 天前与 7 天整的都过期被删，6 天内的与今天保留', () => {
  const t = tempRoot('prune');
  try {
    const sink = createAuditJsonl({ root: t.dir, clock: () => T_NOON });   // "today" = 2026-11-07
    const eight = sink.append(row({ time: Date.parse('2026-10-30T04:00:00.000Z') })); // 8 days before
    const seven = sink.append(row({ time: Date.parse('2026-10-31T04:00:00.000Z') })); // exactly 7
    const six = sink.append(row({ time: Date.parse('2026-11-01T04:00:00.000Z') }));   // 6 days
    const recent = sink.append(row({ time: Date.parse('2026-11-05T04:00:00.000Z') })); // 2 days
    const today = sink.append(row({ time: T_NOON }));

    assert.equal(eight.name, '2026-10-30.jsonl');
    assert.equal(seven.name, '2026-10-31.jsonl');
    assert.equal(six.name, '2026-11-01.jsonl');
    assert.equal(recent.name, '2026-11-05.jsonl');
    assert.equal(today.name, '2026-11-07.jsonl');

    const out = sink.prune();
    assert.deepEqual([...out.removed], ['2026-10-30.jsonl', '2026-10-31.jsonl'],
      '8 天前与 7 天整都过期（policy 的 difference>=7 口径）');
    assert.equal(out.kept, 3, '6 天内 + 2 天前 + 今天 三个都保留');

    // Cross-check against the filesystem, not just the return value.
    const onDisk = fs.readdirSync(t.dir).filter((n) => n.endsWith('.jsonl')).sort();
    assert.deepEqual(onDisk, ['2026-11-01.jsonl', '2026-11-05.jsonl', '2026-11-07.jsonl']);
    assert.equal(fs.existsSync(eight.path), false, '过期文件确实被删了');
    assert.equal(fs.existsSync(six.path), true, '6 天前的必须留下（边界另一侧的正对照）');
  } finally { t.cleanup(); }
});

test('AJ-3b prune 不碰未来日期的文件（时钟回拨时也不能删）', () => {
  const t = tempRoot('future');
  try {
    const sink = createAuditJsonl({ root: t.dir, clock: () => T_NOON });
    const future = sink.append(row({ time: Date.parse('2026-11-20T04:00:00.000Z') }));
    const out = sink.prune();
    assert.deepEqual([...out.removed], [], '未来文件不得被删');
    assert.equal(fs.existsSync(future.path), true);
  } finally { t.cleanup(); }
});

// ── 4. redaction ──────────────────────────────────────────────────────────────────
test('AJ-4 脱敏：含 access_token 的内容落盘为 [REDACTED]，raw 文件里搜不到明文', () => {
  const t = tempRoot('redact');
  try {
    const sink = createAuditJsonl({ root: t.dir, clock: () => T_LATE });
    const secret = 'access_token=abc123SECRETVALUE';
    const out = sink.append(row({ content: secret }));

    assert.equal(out.redacted, true, '必须报告已脱敏');

    const raw = fs.readFileSync(out.path, 'utf8');
    assert.equal(raw.includes('abc123SECRETVALUE'), false, '★ 明文绝不能出现在磁盘上（这是本用例的核心）');
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.content, '[REDACTED]');
    assert.equal(parsed.redacted, true);

    // And it is the EXISTING formatter doing it — not a local regex.
    const bare = 'access_token=zzz999';
    const outBare = sink.append(row({ content: bare, postId: null }));
    const parsedBare = JSON.parse(fs.readFileSync(outBare.path, 'utf8').trim().split('\n').pop());
    assert.equal(parsedBare.content, '[REDACTED]');
  } finally { t.cleanup(); }
});

test('AJ-4b 非法记录被 formatAuditRecord 拒绝：抛错且不落盘（不会写半行）', () => {
  const t = tempRoot('invalid');
  try {
    const sink = createAuditJsonl({ root: t.dir, clock: () => T_LATE });
    const before = fs.existsSync(t.dir) ? fs.readdirSync(t.dir) : [];
    assert.throws(() => sink.append(row({ target: 'not-a-uin' })), /invalid audit record/,
      'target 不是数字串时必须被 formatter 拒掉');
    const after = fs.existsSync(t.dir) ? fs.readdirSync(t.dir) : [];
    assert.deepEqual(after, before, '拒绝的记录不得创建任何文件');
  } finally { t.cleanup(); }
});

// ── 5. path traversal ─────────────────────────────────────────────────────────────
test('AJ-5 路径穿越被拒：read() 的 dayName 只接受 YYYY-MM-DD，构造出的路径不可能是穿越', () => {
  const t = tempRoot('traversal');
  try {
    const sink = createAuditJsonl({ root: t.dir, clock: () => T_LATE });
    // Every one of these would, if concatenated naively, point outside `root` or name a non-day file.
    for (const evil of ['../evil', '../../etc/passwd', '..\\evil', '2026-11-07/../x',
      '2026-11-07.jsonl', '../2026-11-07', '2026-11-07\u0000', 'C:2026-11-07']) {
      assert.throws(() => sink.read(evil), /invalid audit day/,
        `read(${JSON.stringify(evil)}) 必须被拒`);
    }
    // Positive control: the legitimate shape works (so the rejections above mean something).
    assert.deepEqual([...sink.read('2026-11-07')], []);
    // And nothing escaped: no file appeared outside root.
    const parentEntries = fs.readdirSync(path.dirname(t.dir)).filter((n) => n === 'evil' || n === 'passwd');
    assert.deepEqual(parentEntries, [], '没有任何文件被写到 root 之外');
  } finally { t.cleanup(); }
});

test('AJ-5b root 必须是绝对路径：相对 root 直接拒（否则落点取决于 CWD）', () => {
  assert.throws(() => createAuditJsonl({ root: 'relative/dir', clock: () => T_LATE }), /must be an absolute path/);
  assert.throws(() => createAuditJsonl({ root: '', clock: () => T_LATE }), /needs a root directory/);
  assert.throws(() => createAuditJsonl({ root: 42, clock: () => T_LATE }), /needs a root directory/);
  assert.throws(() => createAuditJsonl({ root: '/tmp/x' }), /needs a clock/);
});

// ── 6. concurrent / repeated append ──────────────────────────────────────────────
test('AJ-6 连续追加：N 次 append 得到 N 行、顺序正确、每行独立可解析', () => {
  const t = tempRoot('append');
  try {
    const sink = createAuditJsonl({ root: t.dir, clock: () => T_LATE });
    const N = 50;
    for (let i = 0; i < N; i += 1) {
      sink.append(row({ content: `row-${i}`, postId: `p-${i}` }));
    }
    const lines = sink.read(beijingDay(T_LATE));
    assert.equal(lines.length, N, '行数必须正好是追加次数');

    for (let i = 0; i < N; i += 1) {
      const parsed = JSON.parse(lines[i]);   // every line must parse on its own (no torn records)
      assert.equal(parsed.content, `row-${i}`, `第 ${i} 行内容必须对应第 ${i} 次追加（顺序不能乱）`);
    }

    // The file is byte-consistent with "N lines, each ending in \n" — i.e. no interleaving damage.
    const raw = fs.readFileSync(sink.read(beijingDay(T_LATE))[0] ? path.join(t.dir, `${beijingDay(T_LATE)}.jsonl`) : '', 'utf8');
    assert.equal(raw.split('\n').filter((l) => l !== '').length, N);
    assert.equal(raw.endsWith('\n'), true);
  } finally { t.cleanup(); }
});

test('AJ-6b 两个 sink 实例写同一目录：追加语义下互不覆盖，行数为两者之和', () => {
  const t = tempRoot('two-sinks');
  try {
    const a = createAuditJsonl({ root: t.dir, clock: () => T_LATE });
    const b = createAuditJsonl({ root: t.dir, clock: () => T_LATE });
    a.append(row({ content: 'from-a' }));
    b.append(row({ content: 'from-b' }));
    a.append(row({ content: 'from-a-2' }));

    const lines = a.read(beijingDay(T_LATE));
    assert.equal(lines.length, 3, '追加不会互相覆盖');
    const contents = lines.map((line) => JSON.parse(line).content);
    assert.deepEqual(contents, ['from-a', 'from-b', 'from-a-2'], '顺序即追加顺序');
  } finally { t.cleanup(); }
});

// ── 7. prune only touches day-named .jsonl ───────────────────────────────────────
test('AJ-7 prune 只删过期的 YYYY-MM-DD.jsonl：.txt / 非日期名 / 子目录都不动', () => {
  const t = tempRoot('only-jsonl');
  try {
    const sink = createAuditJsonl({ root: t.dir, clock: () => T_NOON });
    const expired = sink.append(row({ time: Date.parse('2026-10-01T04:00:00.000Z') }));
    assert.equal(expired.name, '2026-10-01.jsonl');

    // Decoys that must survive even though they look old.
    const txtPath = path.join(t.dir, '2026-10-01.txt');
    fs.writeFileSync(txtPath, 'do not delete me\n', 'utf8');
    const notADay = path.join(t.dir, 'notes.jsonl');
    fs.writeFileSync(notADay, '{"a":1}\n', 'utf8');
    const badDay = path.join(t.dir, '2026-13-99.jsonl');   // shape-valid, not a real date
    fs.writeFileSync(badDay, '{"a":2}\n', 'utf8');
    const subdir = path.join(t.dir, '2026-10-01.jsonl.d');
    fs.mkdirSync(subdir);

    const out = sink.prune();
    assert.deepEqual([...out.removed], ['2026-10-01.jsonl'], '只删了那个过期的日文件');

    assert.equal(fs.existsSync(expired.path), false, '过期 .jsonl 被删');
    assert.equal(fs.existsSync(txtPath), true, '★ .txt 不得被碰');
    assert.equal(fs.existsSync(notADay), true, '非日期的 .jsonl 不得被碰');
    assert.equal(fs.existsSync(badDay), true, '非法日期名的 .jsonl 不得被碰（policy 返回 ignore）');
    assert.equal(fs.existsSync(subdir), true, '目录不得被碰（prune 只处理普通文件）');
  } finally { t.cleanup(); }
});

test('AJ-7b prune 在 root 不存在时返回空列表而不是抛错', () => {
  const t = tempRoot('missing');
  try {
    const missing = path.join(t.dir, 'nope', 'qzone-audit');
    const sink = createAuditJsonl({ root: missing, clock: () => T_NOON });
    const out = sink.prune();
    assert.deepEqual([...out.removed], []);
    assert.equal(fs.existsSync(missing), false, 'prune 不应顺手创建目录');
  } finally { t.cleanup(); }
});

// ── 8. directory auto-creation ───────────────────────────────────────────────────
test('AJ-8 目录自动创建：多层不存在的 root 在首次 append 时被建出来', () => {
  const t = tempRoot('mkdir');
  try {
    const nested = path.join(t.dir, 'state', 'qzone-audit');
    assert.equal(fs.existsSync(nested), false, '前提：目录不存在');

    const sink = createAuditJsonl({ root: nested, clock: () => T_MIDDLE });
    const out = sink.append(row({ time: T_MIDDLE }));
    assert.equal(fs.existsSync(nested), true, '首次 append 必须把目录建出来');
    assert.equal(out.path, path.join(nested, `${beijingDay(T_MIDDLE)}.jsonl`));
    assert.equal(sink.root(), path.resolve(nested));
  } finally { t.cleanup(); }
});

const T_MIDDLE = Date.parse('2026-11-07T04:00:00.000Z');

// ── 9. the store-array implementation is untouched and still usable ──────────────
test('AJ-9 与既有 store 数组实现并存：两套互不影响', async () => {
  const t = tempRoot('coexist');
  try {
    const { openOfflineStore } = await import('../src/core/qzone-store-offline.mjs');
    const { appendOfflineAudit } = await import('../src/core/qzone-audit-offline.mjs');
    const store = openOfflineStore(path.join(t.dir, 'state.db'), { audit: [] });

    const sink = createAuditJsonl({ root: path.join(t.dir, 'qzone-audit'), clock: () => T_LATE });
    const out = sink.append(row());

    const arrayResult = appendOfflineAudit(store, 'a-1', row());
    assert.equal(arrayResult.appended, true, '旧的 store 数组路径仍可用');

    assert.equal(store.read().audit.length, 1, 'store 数组里有一条');
    assert.equal(sink.read(beijingDay(T_LATE)).length, 1, '磁盘文件里也有一条');
    assert.notEqual(out.path, undefined);
    store.close();
  } finally { t.cleanup(); }
});
