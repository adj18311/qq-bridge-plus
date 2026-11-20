// Rebuilding the JSONL from `state.audit` — repeatable, and honest about failure.
//
// The property that matters is NOT "the exporter writes rows" (the existing AJ tests already pin the
// sink). It is: **running it twice over one snapshot must not double the rows**, **a failed write must
// be visible**, and **re-exporting must not weaken a redaction decision**. Each case below is written
// so that breaking exactly that property turns it red — no source-regex padding, no count inflation.
//
// Every case runs against a real %TEMP% directory through the real sink, so the assertions look at
// bytes on disk, not at what the exporter says about itself.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAuditJsonl, createAuditExporter } from '../src/core/qzone-audit-jsonl-offline.mjs';
import { formatAuditRecord } from '../src/core/qzone-audit-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';

/** 2026-11-07 23:59:00 Beijing. */
const T1 = Date.parse('2026-11-07T15:59:00.000Z');
// T1 is 23:59 Beijing, so "+60s" would cross into the NEXT day. This one stays inside D1.
const T1_SAME_DAY = T1 - 60_000;
const T2 = Date.parse('2026-11-08T00:01:00.000Z');
const T3 = Date.parse('2026-11-09T00:01:00.000Z');
const D1 = beijingDay(T1);
const D2 = beijingDay(T2);
const D3 = beijingDay(T3);
// The exporter REQUIRES a trusted clock: retention eligibility comes from `now`, while a row's day
// still comes from the row's own `time`. NOW sits one day after T3 so every fixture day is still live.
const NOW = T3 + 24 * 3600 * 1000;
const CLOCK = () => NOW;
if (beijingDay(T1_SAME_DAY) !== D1) throw new Error('test fixture: T1_SAME_DAY must stay inside D1');
if (D1 === D2) throw new Error('test fixture: D1 and D2 must differ');

function tempRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-audit-export-${label}-`));
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
        try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows delay */ }
      }
    },
  };
}

function withTemp(label, body) {
  const t = tempRoot(label);
  try { return body(t); } finally { t.cleanup(); }
}

/** The operation-audit input shape `formatAuditRecord` accepts. */
const input = (over = {}) => ({
  time: T1,
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

/** `state.audit` entry: the FORMATTED record, exactly as `appendOfflineAudit` stores it. */
const stored = (id, over = {}) => ({ id, record: formatAuditRecord(input(over)) });

/** A store double with the single method the exporter is allowed to use. */
function storeOf(audit) {
  return { read: () => ({ audit }) };
}

const SINK = (t) => createAuditJsonl({ root: t.dir, clock: () => T1 });

// ── 1. the plain case: one row per audit entry, identity carried, `unknown` untouched ────────────
test('EX-1 normal export: N source records -> N lines, auditId = namespace:id, unknown preserved', () => withTemp('basic', (t) => {
  const store = storeOf([
    stored('a-1'),
    stored('a-2', { content: 'second', postId: 'p-2' }),
    // `unknown` is a REAL outcome ("a call may have gone out, we cannot tell") and must survive a
    // rebuild verbatim: rewriting it to failed/success would fabricate knowledge we do not have.
    stored('a-3', { result: 'unknown', content: 'third', postId: 'p-3' }),
  ]);
  const exporter = createAuditExporter({ store, jsonl: SINK(t), namespace: 'ns1', clock: CLOCK });

  const out = exporter.exportDay(D1);
  assert.equal(out.failed, false, `must not fail: ${JSON.stringify(out)}`);
  assert.equal(out.exported, 3, 'three source records -> three lines');
  assert.equal(out.alreadyPresent, 0, 'the empty file contained nothing');
  assert.equal(out.corruptLines, 0);

  const lines = t.lines(D1);
  assert.equal(lines.length, 3, 'exactly three lines on disk');
  const parsed = lines.map((line) => JSON.parse(line));
  assert.deepEqual(parsed.map((row) => row.auditId), ['ns1:a-1', 'ns1:a-2', 'ns1:a-3'],
    'ROW IDENTITY must be namespace + existing id, in source order');

  const unknown = parsed.find((row) => row.auditId === 'ns1:a-3');
  assert.equal(unknown.result, 'unknown',
    'result:"unknown" must be preserved verbatim (rewriting it to failed/success fabricates knowledge)');

  // One line per entry, and the row is the formatter's output plus exactly one extra field.
  assert.deepEqual(Object.keys(parsed[0]), [...Object.keys(formatAuditRecord(input())), 'auditId'],
    'auditId may only be APPENDED after formatAuditRecord output; field order must not change');
  assert.equal(parsed[0].content, 'hello');

  // The day file is named from the RECORD's own time, not from the exporter's clock.
  assert.deepEqual(fs.readdirSync(t.dir), [`${D1}.jsonl`]);
}));

// ── 2. retry over the same snapshot appends nothing ─────────────────────────────────────────────
test('EX-2 retry over the same snapshot does not duplicate: second run exported=0, bytes unchanged', () => withTemp('retry', (t) => {
  const audit = [stored('a-1'), stored('a-2', { content: 'x', postId: 'p-2' })];
  const exporter = createAuditExporter({ store: storeOf(audit), jsonl: SINK(t), namespace: 'ns1', clock: CLOCK });

  const first = exporter.exportDay(D1);
  assert.equal(first.exported, 2);
  const bytesAfterFirst = fs.readFileSync(t.dayPath(D1));

  const second = exporter.exportDay(D1);
  assert.equal(second.exported, 0, 'second run must append nothing');
  assert.equal(second.failed, false);
  assert.equal(second.alreadyPresent, 2, 'both rows are already on disk');
  assert.equal(t.lines(D1).length, 2, 'line count unchanged (de-duplication reads the file, not a ledger)');

  const bytesAfterSecond = fs.readFileSync(t.dayPath(D1));
  assert.equal(bytesAfterSecond.equals(bytesAfterFirst), true, 'file bytes must be identical (not "written then removed")');
}));

// ── 3. a record committed later appears on the next run, and ONLY it ────────────────────────────
test('EX-3 a later-committed record appears on the next call, and only that one is appended', () => withTemp('grow', (t) => {
  const audit = [stored('a-1')];
  const exporter = createAuditExporter({ store: storeOf(audit), jsonl: SINK(t), namespace: 'ns1', clock: CLOCK });
  assert.equal(exporter.exportDay(D1).exported, 1);

  // The store is append-only in production; model that by pushing a new entry on the same day.
  audit.push(stored('a-2', { content: 'later', postId: 'p-2', time: T1_SAME_DAY }));

  const out = exporter.exportDay(D1);
  assert.equal(out.exported, 1, 'only the new row is appended');
  assert.equal(out.alreadyPresent, 1, 'the existing row is recognised as present');
  assert.deepEqual(t.lines(D1).map((line) => JSON.parse(line).auditId), ['ns1:a-1', 'ns1:a-2'],
    'two lines on disk, in append order');
}));

// ── 4. an I/O failure is VISIBLE, and the retry after it does not duplicate ─────────────────────
test('EX-4 I/O failure is visible: failed:true + error kept; the failed row is NOT counted as present', () => withTemp('iofail', (t) => {
  const audit = [stored('a-1'), stored('a-2', { content: 'second', postId: 'p-2' })];
  const sink = SINK(t);

  // A sink whose SECOND append throws once — the first row really lands, the second does not.
  let calls = 0;
  const flaky = {
    read: (day) => sink.read(day),
    append: (...args) => {
      calls += 1;
      if (calls === 2) { const error = new Error('disk full (injected)'); error.code = 'ENOSPC'; throw error; }
      return sink.append(...args);
    },
  };
  const exporter = createAuditExporter({ store: storeOf(audit), jsonl: flaky, namespace: 'ns1', clock: CLOCK });

  const failed = exporter.exportDay(D1);
  assert.equal(failed.failed, true, 'the failure must be VISIBLE in the return value');
  assert.equal(failed.exported, 1, 'only the first row actually landed');
  assert.match(failed.error, /disk full \(injected\)/, 'the error text must be kept (operators need it)');
  assert.equal(failed.alreadyPresent, 0, 'the failed row must NOT be counted as already present');
  assert.equal(t.lines(D1).length, 1, 'only one line is on disk');

  // Retry against the honest sink: the missing row is appended, the delivered one is not.
  const recovered = createAuditExporter({ store: storeOf(audit), jsonl: sink, namespace: 'ns1', clock: CLOCK });
  const retry = recovered.exportDay(D1);
  assert.equal(retry.failed, false);
  assert.equal(retry.exported, 1, 'only the failed row is re-appended');
  assert.equal(retry.alreadyPresent, 1, 'the delivered row is correctly recognised');
  assert.deepEqual(t.lines(D1).map((line) => JSON.parse(line).auditId), ['ns1:a-1', 'ns1:a-2'],
    'no duplicate after the retry');
}));

// ── 5. redaction never weakens on re-export ────────────────────────────────────────────────────
test('EX-5 redacted stays true across re-export, and the raw secret never reaches disk', () => withTemp('redact', (t) => {
  const SECRET = 'access_token=abc123SECRETVALUE';
  const redactedRecord = formatAuditRecord(input({ content: SECRET }));
  assert.equal(redactedRecord.redacted, true, 'precondition: the source record was redacted');
  assert.equal(redactedRecord.content, '[REDACTED]');

  const audit = [{ id: 'r-1', record: redactedRecord }];
  const exporter = createAuditExporter({ store: storeOf(audit), jsonl: SINK(t), namespace: 'ns1', clock: CLOCK });

  assert.equal(exporter.exportDay(D1).exported, 1);
  const firstRow = JSON.parse(t.lines(D1)[0]);
  assert.equal(firstRow.redacted, true,
    'after re-export redacted is still true (the formatter alone would say false: it only sees [REDACTED])');
  assert.equal(firstRow.content, '[REDACTED]', 'content is still the redacted value');

  // Re-export (already present) ...
  const again = exporter.exportDay(D1);
  assert.equal(again.exported, 0);

  // ... and a from-scratch export into a DIFFERENT directory: neither may downgrade the flag.
  const t2 = tempRoot('redact-fresh');
  try {
    const fresh = createAuditExporter({ store: storeOf(audit), jsonl: SINK(t2), namespace: 'ns1', clock: CLOCK });
    assert.equal(fresh.exportDay(D1).exported, 1);
    const raw2 = fs.readFileSync(t2.dayPath(D1), 'utf8');
    assert.equal(raw2.includes('abc123SECRETVALUE'), false, 'the plaintext must never reach disk');
    assert.equal(JSON.parse(raw2.trim()).redacted, true, 'a fresh re-export must not flip true back to false');
  } finally { t2.cleanup(); }

  // The flag can only be RAISED: passing previouslyRedacted:false cannot clear a real detection.
  const sink = SINK(t);
  const direct = sink.append(input({ content: SECRET, time: T1_SAME_DAY }), { previouslyRedacted: false });
  assert.equal(direct.redacted, true, 'previouslyRedacted:false must not clear a formatter-detected redaction');
  const lastRow = JSON.parse(t.lines(D1).at(-1));
  assert.equal(lastRow.redacted, true);
  assert.equal(lastRow.content, '[REDACTED]');
}));

// ── 6. gaps never enter the export ─────────────────────────────────────────────────────────────
test('EX-6 gaps never mix in: nothing from auditGaps appears in the export', () => withTemp('gap', (t) => {
  // The exact shape a gap has in `state.auditGaps` — no action/target/result/content.
  const gap = {
    key: 'settle-1#0123456789abcdef0123456789abcdef',
    reason: 'audit-write-failed', generation: 'gen-7', time: T1, resolvedBy: null,
  };
  const audit = [stored('a-1')];
  const store = { read: () => ({ audit, auditGaps: [gap] }) };
  const exporter = createAuditExporter({ store, jsonl: SINK(t), namespace: 'ns1', clock: CLOCK });

  const out = exporter.exportDay(D1);
  assert.equal(out.exported, 1, 'only the audit entry is exported');
  assert.equal(out.failed, false, 'the presence of a gap must not make the export fail');
  const lines = t.lines(D1);
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  for (const gapField of ['generation', 'resolvedBy', 'key']) {
    assert.equal(Object.hasOwn(row, gapField), false, `the row must not carry the gap field ${gapField}`);
  }
  assert.equal(fs.readFileSync(t.dayPath(D1), 'utf8').includes('gen-7'), false, 'gap content must not reach disk');
}));

// ── 7. a torn half-line is reported, never deleted, and does not duplicate good rows ────────────
test('EX-7 torn half-line: corruptLines counted, torn line kept byte-for-byte, good rows not duplicated', () => withTemp('torn', (t) => {
  const audit = [stored('a-1'), stored('a-2', { content: 'second', postId: 'p-2' })];
  const exporter = createAuditExporter({ store: storeOf(audit), jsonl: SINK(t), namespace: 'ns1', clock: CLOCK });
  assert.equal(exporter.exportDay(D1).exported, 2);

  // Append a torn line exactly like a crash mid-append leaves behind.
  const TORN = '{"time":1794067140000,"source":"qq","action":"public';
  fs.appendFileSync(t.dayPath(D1), `${TORN}\n`, 'utf8');
  const bytesWithTorn = fs.readFileSync(t.dayPath(D1));

  const out = exporter.exportDay(D1);
  assert.ok(out.corruptLines >= 1, `corrupt line count must be reported (got ${out.corruptLines})`);
  assert.equal(out.exported, 0, 'the torn line must not swallow anything; the two good rows were already on disk');
  assert.equal(out.alreadyPresent, 2, 'both good rows are still recognised despite the torn line');

  const raw = fs.readFileSync(t.dayPath(D1), 'utf8');
  assert.equal(raw.includes(TORN), true, 'the torn line must NOT be deleted or rewritten (it is evidence)');
  assert.equal(fs.readFileSync(t.dayPath(D1)).subarray(0, bytesWithTorn.length).equals(bytesWithTorn), true,
    'the pre-existing bytes (including the torn line) must be preserved exactly');
  assert.equal(t.lines(D1).length, 3, 'two good lines + one torn line');

  // A genuinely missing row still gets appended even though a corrupt line exists in the same file.
  audit.push(stored('a-3', { content: 'third', postId: 'p-3', time: T1_SAME_DAY }));
  const grown = exporter.exportDay(D1);
  assert.equal(grown.exported, 1, 'a missing good row must still be appended while a torn line exists');
  assert.ok(grown.corruptLines >= 1);
  assert.deepEqual(
    t.lines(D1).filter((line) => { try { JSON.parse(line); return true; } catch { return false; } })
      .map((line) => JSON.parse(line).auditId),
    ['ns1:a-1', 'ns1:a-2', 'ns1:a-3'],
    'good rows: no duplicates, none lost',
  );
}));

// ── 7b. A REAL crash tail has NO trailing newline. The old fixture always appended one, which is
//        exactly why it could not see the splice defect: without the newline the next row was glued
//        onto the tail, both became unparseable, and the row was appended AGAIN on the next run. ──
test('EX-7b torn tail WITHOUT newline + a row to append: tail terminated, never spliced', () => withTemp('torn2', (t) => {
  // ⚠️ THE FIRST VERSION OF THIS TEST WAS VACUOUS. It tore the tail and then re-exported the SAME
  // snapshot, so nothing was appended and `terminateTornTail` was never reached — removing that call
  // left the test GREEN. The splice only happens when a NEW row is written onto a torn tail, so the
  // fixture must have a pending row at the moment the tail is torn.
  const audit = [stored('b-1')];
  const exporter = createAuditExporter({ store: storeOf(audit), jsonl: SINK(t), namespace: 'ns1', clock: CLOCK });
  assert.equal(exporter.exportDay(D1).exported, 1);

  // A crash mid-append leaves bytes with NO trailing newline.
  const TORN = '{"partial';
  fs.appendFileSync(t.dayPath(D1), TORN, 'utf8');
  const before = fs.readFileSync(t.dayPath(D1));
  assert.equal(before[before.length - 1] === 0x0a, false, 'precondition: no trailing newline');

  // A genuinely NEW row exists, so this run WILL append.
  audit.push(stored('b-2', { content: 'second', postId: 'p-2' }));
  const out = exporter.exportDay(D1);
  assert.equal(out.exported, 1, 'the new row is appended');
  assert.ok(out.corruptLines >= 1, `the torn tail is counted as damage (got ${out.corruptLines})`);

  const after = fs.readFileSync(t.dayPath(D1));
  assert.equal(after.subarray(0, before.length).equals(before), true,
    '★★ the torn tail keeps its exact original bytes');
  assert.equal(after[before.length], 0x0a,
    '★★ a newline was inserted right after the torn tail: it stays its own line');

  const lines = t.lines(D1);
  const parseable = lines.filter((line) => { try { JSON.parse(line); return true; } catch { return false; } });
  assert.equal(parseable.length, 2, '★★ two parseable rows; the tail is NOT glued onto the new row');
  assert.deepEqual(parseable.map((line) => JSON.parse(line).auditId), ['ns1:b-1', 'ns1:b-2']);

  // And the retry is now a clean no-op instead of appending the same row again.
  assert.equal(exporter.exportDay(D1).exported, 0, '★★ retry appends nothing');
  assert.equal(t.lines(D1).filter((line) => line.includes('ns1:b-2')).length, 1, '★ exactly one copy of b-2');
}));

test('EX-7c an identity-only fragment never counts as delivered', () => withTemp('shadow', (t) => {
  const audit = [stored('s-1')];
  const exporter = createAuditExporter({ store: storeOf(audit), jsonl: SINK(t), namespace: 'ns1', clock: CLOCK });
  // Simulate a truncated/hand-edited file that kept the id but nothing else.
  fs.writeFileSync(t.dayPath(D1), JSON.stringify({ auditId: 'ns1:s-1' }) + '\n', 'utf8');

  const out = exporter.exportDay(D1);
  assert.equal(out.exported, 1, '★★ a fragment with only an id must NOT suppress the real row');
  assert.equal(out.alreadyPresent, 0);
  assert.ok(out.corruptLines >= 1, 'the fragment is damage, not delivery');
  const raw = fs.readFileSync(t.dayPath(D1), 'utf8');
  assert.equal(raw.includes('"action"'), true, 'the real audit row is on disk');
}));

// ── 7d. One unusable timestamp must not take the whole exporter down ───────────────────────────
test('EX-7d one out-of-range time does not break days/status/exportDay/exportAll', () => withTemp('huge', (t) => {
  const audit = [stored('h-1'), stored('h-bad', { time: 1e17 })];
  const exporter = createAuditExporter({ store: storeOf(audit), jsonl: SINK(t), namespace: 'ns1', clock: CLOCK });

  assert.doesNotThrow(() => exporter.days(), '★★ days() must not throw on an out-of-range time');
  assert.doesNotThrow(() => exporter.status(), '★★ status() must not throw');
  const out = exporter.exportDay(D1);
  assert.equal(out.exported, 1, 'the good row still exports');
  assert.ok(out.skippedInvalid >= 1, 'the unusable row is reported as invalid, not as a crash');
  assert.doesNotThrow(() => exporter.exportAll());
}));

// ── 7e. A read failure is reported per day and does not destroy the other days' results ────────
test('EX-7e a day-file read failure is reported, and other days keep their results', () => withTemp('readfail', (t) => {
  const audit = [stored('r1'), stored('r2', { time: T2, content: 'c', postId: 'p-3' })];
  const sink = SINK(t);
  let failDay = null;
  const flaky = {
    append: sink.append,
    read(day) {
      if (failDay !== null && day === failDay) {
        const error = new Error('simulated EACCES');
        error.code = 'EACCES';
        throw error;
      }
      return sink.read(day);
    },
  };
  const exporter = createAuditExporter({ store: storeOf(audit), jsonl: flaky, namespace: 'ns1', clock: CLOCK });

  // Let the first day succeed, then make the second day's read fail.
  failDay = D2;
  const out = exporter.exportAll();
  assert.equal(out.failed, true, '★★ a read failure must be visible as failed:true');
  assert.equal(typeof out.error, 'string', 'the error text is kept');
  assert.equal(out.perDay[D1].failed === true, false, '★ the successful day is still reported');
  assert.equal(out.perDay[D1].exported, 1, '★★ the already-succeeded day keeps its result');
  assert.equal(out.perDay[D2].failed, true, 'the failing day is reported');
}));

// ── 9..13. The five behaviours that had NO test (5/5 mutations stayed green). Each one pins a single
//          property that the corresponding mutation breaks. ──

test('EX-9 same id + SAME content is already-present; same id + DIFFERENT content is a conflict', () => withTemp('dupid', (t) => {
  // (a) IDENTICAL duplicate in the source: nothing to write, and it is NOT damage.
  const sameStore = storeOf([stored('dup-1'), stored('dup-1')]);
  const exSame = createAuditExporter({ store: sameStore, jsonl: SINK(t), namespace: 'ns1', clock: CLOCK });
  const same = exSame.exportDay(D1);
  assert.equal(same.failed, false, 'identical duplicates are not a failure');
  assert.equal(same.exported, 1, '★★ an identical repeated id is written once');
  assert.equal(same.alreadyPresent, 1, '★★ the second occurrence counts as already present');
  assert.equal(t.lines(D1).length, 1, '★★ one line on disk');
}));

test('EX-9b same id + DIFFERENT content in the SOURCE is refused, never silently absorbed', () => withTemp('dupid2', (t) => {
  // A store holding two rows with one id cannot be exported honestly: whichever we picked would make
  // the file disagree with SQLite. `delivered.add` used to swallow this — measured `exported:1`.
  const audit = [stored('dup-2'), stored('dup-2', { content: 'a different body' })];
  const exporter = createAuditExporter({ store: storeOf(audit), jsonl: SINK(t), namespace: 'ns1', clock: CLOCK });
  const out = exporter.exportDay(D1);
  assert.equal(out.failed, true, '★★★ conflicting source rows must fail the day');
  assert.match(out.error, /conflicting source rows/);
  assert.equal(out.failedAuditId, 'ns1:dup-2');
  assert.equal(t.lines(D1).length, 1, '★ the first row was written before the conflict was seen; the second was not');
}));

test('EX-10 exportAll never prunes: a pre-existing old day file survives', () => withTemp('noprune', (t) => {
  // A file far outside the 7-day window. If exportAll ever called prune(), this would be deleted.
  const oldFile = t.dayPath('2020-01-01');
  fs.mkdirSync(t.dir, { recursive: true });
  fs.writeFileSync(oldFile, '{"old":true}\n', 'utf8');

  const exporter = createAuditExporter({ store: storeOf([stored('np-1')]), jsonl: SINK(t), namespace: 'ns1', clock: CLOCK });
  exporter.exportAll();
  assert.equal(fs.existsSync(oldFile), true, '★★ exportAll must NOT prune: the old file is still there');
}));

test('EX-11 status() writes nothing: a missing root is not created', () => withTemp('nodir', (t) => {
  const nested = path.join(t.dir, 'deep', 'nested', 'root');
  const sink = createAuditJsonl({ root: nested, clock: () => T0 });
  const exporter = createAuditExporter({ store: storeOf([stored('nd-1')]), jsonl: sink, namespace: 'ns1', clock: CLOCK });
  assert.equal(fs.existsSync(nested), false, 'precondition: the root does not exist yet');
  const out = exporter.status();
  assert.equal(fs.existsSync(nested), false, '★★ status() must not create the root directory');
  assert.equal(typeof out.pending, 'number');
}));

test('EX-12 a store without an audit array is REFUSED, not reported as "nothing to export"', () => withTemp('noaudit', (t) => {
  const store = { read: () => ({}) };   // no audit field at all
  const exporter = createAuditExporter({ store, jsonl: SINK(t), namespace: 'ns1', clock: CLOCK });
  // A single-day call is a programming-level entry point: a corrupt store throws.
  assert.throws(() => exporter.exportDay(D1), /audit array/,
    '★★ a corrupt store must be an ERROR, never an empty report');
  assert.throws(() => exporter.days(), /audit array/);
  // The aggregate entry points REPORT the failure instead of throwing, so a caller still learns that
  // nothing happened and why — and can never mistake it for "nothing to export".
  const all = exporter.exportAll();
  assert.equal(all.failed, true, '★★ exportAll reports the unreadable store');
  assert.match(all.error, /audit array/);
  assert.equal(all.exported, 0);
  const st = exporter.status();
  assert.equal(st.failed, true, '★★ status reports it too');
  assert.match(st.error, /audit array/);
  assert.equal(st.pending, 0, '★ and claims no pending work');
}));

test('EX-13 a failing day stops exportAll: the day AFTER it is never attempted', () => withTemp('stopall', (t) => {
  // ⚠️ A TWO-DAY FIXTURE CANNOT PROVE "STOPS". With only D1 and D2, a mutant that keeps going after the
  // D2 failure has nothing left to run, so it stayed GREEN. Three days are required: the third one must
  // remain untouched, which is the only observable difference.
  const audit = [
    stored('s1'),
    stored('s2', { time: T2, content: 'c', postId: 'p-3' }),
    stored('s3', { time: T3, content: 'd', postId: 'p-4' }),
  ];
  const sink = SINK(t);
  let throwOnDay = null;
  const flaky = {
    read: sink.read,
    append(record, options) {
      if (throwOnDay !== null && beijingDay(record.time) === throwOnDay) {
        const error = new Error('simulated write failure');
        error.code = 'EIO';
        throw error;
      }
      return sink.append(record, options);
    },
  };
  const exporter = createAuditExporter({ store: storeOf(audit), jsonl: flaky, namespace: 'ns1', clock: CLOCK });

  throwOnDay = D2;
  const out = exporter.exportAll();
  assert.equal(out.failed, true, '★★ the run fails');
  assert.equal(out.perDay[D1].failed, false, '★ D1 succeeded');
  assert.equal(out.perDay[D1].exported, 1, '★★ D1 keeps its result');
  assert.equal(out.perDay[D2].failed, true, 'D2 failed');
  assert.equal(out.failedDay, D2, '★ the failing day is named');
  assert.equal(typeof out.error, 'string', '★ the reason reaches the summary');
  assert.equal(out.perDay[D3], undefined,
    '★★★ D3 must NOT be attempted: a failure stops the run');
  assert.equal(fs.existsSync(t.dayPath(D3)), false, '★★★ and D3 never gets a file');
}));

// ── 14..18. The four counterexamples Codex reproduced, plus the positive controls for them. ──────

test('EX-14 an id that exists with DIFFERENT content is a conflict, not "already present"', () => withTemp('shadow2', (t) => {
  // Counterexample A-2: a complete, legal row with the same auditId but different content was reported
  // alreadyPresent while the authoritative SQLite row was never exported.
  const source = stored('c-1', { content: 'expected' });
  const exporter = createAuditExporter({ store: storeOf([source]), jsonl: SINK(t), namespace: 'ns1', clock: CLOCK });

  // Hand-write a legal row with the same identity and DIFFERENT content.
  const sink = SINK(t);
  sink.append(formatAuditRecord(input({ content: 'different' })), { auditId: 'ns1:c-1' });
  assert.equal(t.lines(D1).length, 1);

  const out = exporter.exportDay(D1);
  assert.equal(out.failed, true, '★★★ a content conflict must NOT be reported as success');
  assert.match(out.error, /conflicting export/);
  assert.equal(out.failedAuditId, 'ns1:c-1');
  assert.equal(out.alreadyPresent, 0, '★★ a conflicting row is not "already present"');
  assert.equal(t.lines(D1).length, 1, '★★ the file is neither overwritten nor appended to');
}));

test('EX-14b a BODY-LESS row with a well-formed identity does not shadow the real row', () => withTemp('shadow3', (t) => {
  // Counterexample A-1: {auditId, time, action, result} without source/target/content still hid the
  // real row. Requiring the full row shape is what fixes it.
  const exporter = createAuditExporter({ store: storeOf([stored('s-9', { content: 'expected' })]), jsonl: SINK(t), namespace: 'ns1', clock: CLOCK });
  fs.writeFileSync(t.dayPath(D1),
    JSON.stringify({ auditId: 'ns1:s-9', time: T1, action: 'like', result: 'success' }) + '\n', 'utf8');

  const out = exporter.exportDay(D1);
  assert.equal(out.failed, false, 'a body-less fragment is damage, not a conflict');
  assert.equal(out.exported, 1, '★★★ the real row IS exported');
  assert.ok(out.corruptLines >= 1, '★ the fragment is counted as damage');
  const raw = fs.readFileSync(t.dayPath(D1), 'utf8');
  assert.equal(raw.includes('expected'), true, '★★ the authoritative content reached the file');
}));

test('EX-15 an EXPIRED source row is never exported, so pruning cannot be undone', () => withTemp('expired', (t) => {
  // Counterexample B: with a fixed `now`, a 30-day-old row was exported, pruned, then exported AGAIN.
  const OLD = NOW - 30 * 24 * 3600 * 1000;
  assert.equal(beijingDay(OLD) !== D1 && beijingDay(OLD) !== D2, true, 'precondition: the row is on another day');
  const exporter = createAuditExporter({
    store: storeOf([stored('old-1', { time: OLD })]),
    jsonl: SINK(t), namespace: 'ns1', clock: CLOCK,
  });

  const first = exporter.exportAll();
  assert.equal(first.exported, 0, '★★★ an expired row is NOT exported');
  assert.ok(first.skippedExpired >= 1, '★★ and it is counted, not silently dropped');
  assert.equal(fs.existsSync(t.dayPath(beijingDay(OLD))), false, '★★★ no file is created for the expired day');

  // Even after a prune, nothing comes back.
  SINK(t).prune();
  const second = exporter.exportAll();
  assert.equal(second.exported, 0, '★★★ and a retry after prune still exports nothing');
  assert.equal(fs.existsSync(t.dayPath(beijingDay(OLD))), false, '★★ the file does not resurrect');
}));

test('EX-16 exportAll is ONE snapshot: rows committed mid-run wait for the next call', () => withTemp('snapshot', (t) => {
  // Counterexample C. A store holding 2 rows at entry produced `{exported:3}` because the row
  // committed from inside the first `append` callback landed in the SAME run.
  //
  // ⚠️ TWO late rows are needed, and they must be on DIFFERENT KINDS of day, because there are two
  // separate ways to lose snapshot discipline and one fixture cannot see both:
  //   · `late-same` on D2 (a day the entry snapshot already contains) exposes a per-day re-read:
  //     that re-read sees it immediately and exports it in the same run.
  //   · `late-new` on D3 (a day the entry snapshot does NOT contain) exposes a re-read when the day
  //     LIST is computed: the run then visits D3 at all and creates its file.
  // Measured: with only the same-day row, the day-list mutation stays green; with only the new-day row,
  // the per-day mutation stays green. Both together pin the whole property.
  const audit = [stored('snap-1'), stored('snap-2', { time: T2, content: 'b', postId: 'p-2' })];
  const store = storeOf(audit);
  const sink = SINK(t);
  let injected = false;
  const injectOnFirstAppend = {
    read: sink.read,
    append(record, options) {
      const out = sink.append(record, options);
      if (!injected) {
        injected = true;
        audit.push(stored('snap-late-same', { time: T2 + 60_000, content: 'late same day', postId: 'p-8' }));
        audit.push(stored('snap-late-new', { time: T3, content: 'late new day', postId: 'p-9' }));
      }
      return out;
    },
  };
  const exporter = createAuditExporter({ store, jsonl: injectOnFirstAppend, namespace: 'ns1', clock: CLOCK });

  const first = exporter.exportAll();
  assert.equal(first.exported, 2, '★★★ the first run exports exactly the 2 rows present at entry');
  assert.equal(first.perDay[D2].exported, 1, '★★★ D2 exported only what the snapshot held');
  assert.equal(t.lines(D2).length, 1, '★★ D2 has one line after the first run');
  assert.equal(first.perDay[D3], undefined, '★★★ the new day was not visited at all');
  assert.equal(fs.existsSync(t.dayPath(D3)), false, '★★★ and no file was created for it');

  const second = exporter.exportAll();
  assert.equal(second.exported, 2, '★★ the next explicit call picks up exactly the two new rows');
  assert.equal(second.perDay[D2].exported, 1, '★ the same-day late row lands on D2');
  assert.equal(second.perDay[D3].exported, 1, '★ the new-day late row lands on D3');
  assert.equal(t.lines(D2).length, 2, '★★ D2 now has two lines');
}));

test('EX-17 a trustworthy clock is REQUIRED, not optional', () => withTemp('noclock', (t) => {
  // Without a clock the exporter cannot tell an expired row from a live one — and would resurrect a
  // pruned file. Refusing to construct is the honest response.
  assert.throws(
    () => createAuditExporter({ store: storeOf([stored('x-1')]), jsonl: SINK(t), namespace: 'ns1' }),
    /trusted clock/,
    '★★★ a missing clock must be refused at construction',
  );
}));

// ── 18..19. Two delta fixes on top of A/B/C. Each pins ONE thing; no mutation battery. ──────────

test('EX-18 a source row the formatter REFUSES is reported per day, not thrown away', () => withTemp('badrow', (t) => {
  // Measured: one valid row + one `content: 42` row made exportAll AND status throw while the day file
  // already held the first row — so the caller lost both the progress and the reason.
  const audit = [stored('good'), { id: 'bad', record: { ...stored('probe').record, content: 42 } }];
  const exporter = createAuditExporter({ store: storeOf(audit), jsonl: SINK(t), namespace: 'ns1', clock: CLOCK });

  const out = exporter.exportAll();
  assert.equal(out.failed, true, '★★★ a refused SOURCE row must fail the day, not throw');
  assert.match(out.error, /source row rejected/);
  assert.equal(out.failedAuditId, 'ns1:bad', '★★ the offending identity is named');
  assert.equal(out.exported, 1, '★★★ the row already written is still counted');
  assert.equal(out.lastDeliveredId, 'ns1:good', '★ and the last success position survives');
  assert.equal(t.lines(D1).length, 1, '★★ the file keeps that one good row');

  // status must report the bad source row too — never look like a healthy empty result.
  const st = exporter.status();
  assert.equal(st.failed, true, '★★★ status reports the refused source row');
  assert.match(st.error, /source row rejected/);
  assert.equal(st.invalid, 1, '★ counted as invalid');
  assert.equal(st.pending, 0, '★ and it is not reported as pending work');
}));

test('EX-19 skippedExpired counts only the rows of THAT expired day', () => withTemp('expcount', (t) => {
  // Measured with 3 rows (30 days ago, 29 days ago, today): the old code reported skippedExpired:6
  // because every expired day multiplied the WHOLE array length.
  const OLD30 = NOW - 30 * 24 * 3600 * 1000;
  const OLD29 = NOW - 29 * 24 * 3600 * 1000;
  const audit = [
    stored('o30', { time: OLD30 }),
    stored('o29', { time: OLD29 }),
    stored('live'),
  ];
  const exporter = createAuditExporter({ store: storeOf(audit), jsonl: SINK(t), namespace: 'ns1', clock: CLOCK });

  const out = exporter.exportAll();
  assert.equal(out.exported, 1, '★ only the live row is exported');
  assert.equal(out.skippedExpired, 2, '★★★ 1 + 1, NOT 3 per expired day');
  assert.equal(out.perDay[beijingDay(OLD30)].skippedExpired, 1, '★★ each expired day counts its own row');
  assert.equal(out.perDay[beijingDay(OLD29)].skippedExpired, 1);
  assert.equal(fs.existsSync(t.dayPath(beijingDay(OLD30))), false, '★ no file for an expired day');

  assert.equal(exporter.status().expired, 2, '★★ status agrees on the total');
}));

// ── 8. exportAll / status: multi-day, and the two 7-day policies stay separate ──────────────────
test('EX-8 exportAll across days + read-only status: each day lands in its own file, status writes nothing', () => withTemp('days', (t) => {
  const audit = [
    stored('d1-a'), stored('d1-b', { content: 'b', postId: 'p-2' }),
    stored('d2-a', { time: T2, content: 'c', postId: 'p-3' }),
  ];
  const exporter = createAuditExporter({ store: storeOf(audit), jsonl: SINK(t), namespace: 'ns1', clock: CLOCK });

  const before = exporter.status();
  assert.equal(before.pending, 3, 'status reports three pending rows');
  assert.deepEqual(fs.readdirSync(t.dir), [], 'status() must not write or create the directory');

  const all = exporter.exportAll();
  assert.equal(all.failed, false, JSON.stringify(all));
  assert.equal(all.exported, 3);
  assert.deepEqual(Object.keys(all.perDay).sort(), [D1, D2].sort(), 'grouped by the record time, not the clock');
  assert.equal(t.lines(D1).length, 2);
  assert.equal(t.lines(D2).length, 1);
  assert.equal(JSON.parse(t.lines(D2)[0]).auditId, 'ns1:d2-a');
  assert.equal(all.lastDeliveredDay, D2, 'last successful position points at the last non-empty day');

  const after = exporter.status();
  assert.equal(after.pending, 0, 'nothing pending once everything is exported');
  assert.equal(after.delivered, 3);

  // The exporter never prunes: both day files survive exportAll, and no store row was removed.
  // (Day files and store rows have INDEPENDENT 7-day policies.)
  assert.deepEqual(fs.readdirSync(t.dir).sort(), [`${D1}.jsonl`, `${D2}.jsonl`].sort(),
    'the exporter must not call prune()');
}));
