// Direct matrix + frozen differential test for src/core/runtime-records.mjs. Oracle:
// scripts/fixtures/runtime-records-baseline.mjs (literal bridge.start.js 11901-11961 bodies
// + logger const, no production import). Run: node scripts/test-runtime-records.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as runtimeRecords from '../src/core/runtime-records.mjs';
import { readJsonSafe, atomicWriteJson } from '../src/core/json-store.mjs';
import { createBaseline } from './fixtures/runtime-records-baseline.mjs';

const { createRuntimeRecordStore } = runtimeRecords;
let checks = 0; const eq = (label, actual, expected) => { assert.equal(actual, expected, label); checks += 1; };
const dirs = [];
const tmpdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-records-')); dirs.push(d); return d; };
process.on('exit', () => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

const redactAny = (value) => {
  if (Array.isArray(value)) return value.map(redactAny);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = /^(token|password)$/i.test(key) ? '***' : redactAny(item);
    return out;
  }
  return typeof value === 'string' ? value.replace(/SECRET/g, '***') : value;
};
function makeHarness(overrides = {}) {
  const calls = { created: [], appended: [], logs: [], text: [], any: [], writes: [] };
  return {
    calls,
    createCappedLogger(file, maxLines) {
      const rec = { file, maxLines, appends: 0 };
      calls.created.push(rec);
      return (text) => { rec.appends += 1; calls.appended.push(text); fs.appendFileSync(file, text); };
    },
    readJsonSafe: (file, fallback) => readJsonSafe(file, fallback),
    atomicWriteJson: (file, obj) => { calls.writes.push({ file, obj }); return atomicWriteJson(file, obj); },
    redactSensitiveText: (s) => { calls.text.push(s); return String(s).replace(/SECRET/g, '***'); },
    redactSensitive: (value) => { calls.any.push(value); return redactAny(value); },
    log: (...args) => calls.logs.push(args),
    ...overrides,
  };
}
const makeStore = (dir, h = makeHarness(), files = {}) => {
  const feedbackFile = files.feedbackFile ?? path.join(dir, 'feedback.json');
  const toolLogFile = files.toolLogFile ?? path.join(dir, 'tool-log.jsonl');
  const store = createRuntimeRecordStore({ feedbackFile, toolLogFile, ...h });
  return { store, feedbackFile, toolLogFile, h };
};

eq('exports factory only', Object.keys(runtimeRecords).join(','), 'createRuntimeRecordStore');
{
  const { h, toolLogFile } = makeStore(tmpdir());
  eq('constructor logger once', h.calls.created.length, 1);
  eq('constructor logger file', h.calls.created[0].file, toolLogFile);
  eq('constructor logger maxLines', h.calls.created[0].maxLines, 2000);
}
// Feedback read: missing / corrupt / top-level non-array all become [].
{
  const { store, feedbackFile } = makeStore(tmpdir());
  eq('missing feedback empty', JSON.stringify(store.readFeedbackEntries()), '[]');
  fs.writeFileSync(feedbackFile, '{"broken":');
  eq('corrupt feedback empty', JSON.stringify(store.readFeedbackEntries()), '[]');
  fs.writeFileSync(feedbackFile, '{"not":"array"}');
  eq('nonarray feedback empty', JSON.stringify(store.readFeedbackEntries()), '[]');
}

// Feedback append: spread + message-only redaction, caller object untouched.
{
  const { store, h } = makeStore(tmpdir());
  const entry = { id: 'a', message: 'token SECRET', extra: 'keep' };
  const before = JSON.stringify(entry);
  store.appendFeedbackEntry(entry);
  const list = store.readFeedbackEntries();
  eq('append length', list.length, 1);
  eq('append redacted message', list[0].message, 'token ***');
  eq('append keeps other fields', list[0].extra, 'keep');
  eq('append input not mutated', JSON.stringify(entry), before);
  eq('append reads message text once', h.calls.text.length, 1);
}

// Message getter trace: object spread read, typeof read, redaction read = three.
{
  const { store } = makeStore(tmpdir());
  let reads = 0;
  const entry = { id: 'g', get message() { reads += 1; return `n${reads} SECRET`; } };
  store.appendFeedbackEntry(entry);
  eq('message getter read count', reads, 3);
  eq('message getter redacted third value', store.readFeedbackEntries().at(-1).message, 'n3 ***');
}

// 500-entry cap: over-cap reads drop the oldest rows by splice, new entry last.
{
  const { store, feedbackFile } = makeStore(tmpdir());
  atomicWriteJson(feedbackFile, Array.from({ length: 503 }, (_, i) => ({ id: `s${i}` })));
  store.appendFeedbackEntry({ id: 'new' });
  const list = store.readFeedbackEntries();
  eq('cap length 500', list.length, 500);
  eq('cap drops oldest', list[0].id, 's4');
  eq('cap keeps new last', list.at(-1).id, 'new');
}

// JSONL read: raw non-empty lines are sliced before parsing, bad rows do not count as rows.
{
  const { store, toolLogFile } = makeStore(tmpdir());
  eq('missing tool log empty', JSON.stringify(store.readToolLog()), '[]');
  fs.writeFileSync(toolLogFile, ['{"n":1}', 'bad', 'bad2', '{"n":4}'].join('\n'));
  eq('tool log default parses valid rows', JSON.stringify(store.readToolLog()), '[{"n":1},{"n":4}]');
  eq('tool log raw slice not valid-row slice', JSON.stringify(store.readToolLog(3)), '[{"n":4}]');
  fs.writeFileSync(toolLogFile, Array.from({ length: 1200 }, (_, i) => JSON.stringify({ i })).join('\n'));
  eq('tool log default limit 200', store.readToolLog().length, 200);
  eq('tool log max limit 1000 tail', JSON.stringify([store.readToolLog(5000).length, store.readToolLog(5000)[0].i]), '[1000,200]');
  eq('tool log min limit 1', store.readToolLog(-5).length, 1);
}

// Tool append: error redaction, nested-JSON redaction (four parse passes), non-string args untouched.
{
  const { store, toolLogFile, h } = makeStore(tmpdir());
  const four = JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify('x'))));
  store.appendToolLog({ type: 'result', error: 'SECRET boom' });
  store.appendToolLog({ args: four });
  store.appendToolLog({ args: JSON.stringify(four) });
  store.appendToolLog({ args: 'not-json-SECRET' });
  store.appendToolLog({ args: 42 });
  store.appendToolLog({ args: [1, { token: 'SECRET' }] });
  const lines = fs.readFileSync(toolLogFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  eq('tool error redacted', lines[0].error, '*** boom');
  eq('tool four parses result', lines[1].args, JSON.stringify('x'));
  eq('tool five layers stop at four', lines[2].args, JSON.stringify(JSON.stringify('x')));
  eq('tool malformed args fallback', lines[3].args, 'not-json-***');
  eq('tool number args unchanged', lines[4].args, 42);
  eq('tool array args unchanged', JSON.stringify(lines[5].args), '[1,{"token":"SECRET"}]');
  eq('tool logger appended six times', h.calls.created[0].appends, 6);
}

// Tool append failures are swallowed and reported through the injected log.
{
  const h = makeHarness({ redactSensitiveText: () => { throw new Error('redact boom'); } });
  const { store } = makeStore(tmpdir(), h);
  assert.doesNotThrow(() => store.appendToolLog({ error: 'x' }), 'redact failure swallowed');
  checks += 1;
  eq('redact failure logged', JSON.stringify(h.calls.logs), JSON.stringify([['写入工具调用日志失败:', 'redact boom']]));
  eq('redact failure wrote nothing', h.calls.appended.length, 0);
}
{
  const h = makeHarness();
  h.createCappedLogger = (file, maxLines) => { h.calls.created.push({ file, maxLines }); return () => { throw new Error('append boom'); }; };
  const { store } = makeStore(tmpdir(), h);
  assert.doesNotThrow(() => store.appendToolLog({ type: 'x' }), 'append failure swallowed');
  checks += 1;
  eq('append failure logged', JSON.stringify(h.calls.logs), JSON.stringify([['写入工具调用日志失败:', 'append boom']]));
}

// Clears: feedback write faults propagate; tool-log clear faults are swallowed.
{
  const { store, feedbackFile } = makeStore(tmpdir());
  fs.writeFileSync(feedbackFile, JSON.stringify([{ id: 'x' }]));
  store.clearFeedbackEntries();
  eq('clear feedback empties', JSON.stringify(store.readFeedbackEntries()), '[]');
  eq('clear feedback raw file', fs.readFileSync(feedbackFile, 'utf8'), '[]\n');
}
{
  const dir = tmpdir();
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a dir');
  const codes = ['ENOTDIR', 'ENOENT', 'EEXIST', 'EPERM'];
  const { store } = makeStore(dir, makeHarness(), { feedbackFile: path.join(blocker, 'feedback.json') });
  assert.throws(() => store.appendFeedbackEntry({ id: 'x' }), (e) => codes.includes(e.code), 'feedback write error propagates');
  assert.throws(() => store.clearFeedbackEntries(), (e) => codes.includes(e.code), 'clear feedback error propagates');
  checks += 2;
}
{
  const dir = tmpdir();
  const dirAsToolLog = path.join(dir, 'as-directory');
  fs.mkdirSync(dirAsToolLog);
  const { store } = makeStore(dir, makeHarness(), { toolLogFile: dirAsToolLog });
  assert.doesNotThrow(() => store.clearToolLog(), 'clear tool log swallows fs error');
  checks += 1;
}

// Clearing the tool log must not recreate/reinitialize the capped logger (legacy counter quirk).
{
  const h = makeHarness();
  const { store, toolLogFile } = makeStore(tmpdir(), h);
  store.appendToolLog({ n: 1 });
  store.appendToolLog({ n: 2 });
  store.clearToolLog();
  store.appendToolLog({ n: 3 });
  eq('clear tool log does not rebuild logger', h.calls.created.length, 1);
  eq('clear tool log keeps counter', h.calls.created[0].appends, 3);
  eq('clear tool log truncates file', fs.readFileSync(toolLogFile, 'utf8'), `{"n":3}\n`);
}

// Independent frozen differential: fresh dir/files/callback trace per implementation.
function runScenario(createStore) {
  const dir = tmpdir();
  const trace = [];
  const feedbackFile = path.join(dir, 'feedback.json');
  const toolLogFile = path.join(dir, 'tool-log.jsonl');
  const callbacks = {
    readJsonSafe(file, fallback) { trace.push(`read:${path.basename(file)}`); return readJsonSafe(file, fallback); },
    atomicWriteJson(file, obj) { trace.push(`write:${path.basename(file)}:${JSON.stringify(obj)}`); return atomicWriteJson(file, obj); },
    createCappedLogger(file, maxLines) {
      trace.push(`logger:${path.basename(file)}:${maxLines}`);
      return (text) => { trace.push(`append:${text.trim()}`); fs.appendFileSync(file, text); };
    },
    redactSensitiveText(text) { trace.push(`text:${text}`); return String(text).replace(/SECRET/g, '***'); },
    redactSensitive(value) { trace.push(`any:${JSON.stringify(value)}`); return redactAny(value); },
    log(...args) { trace.push(`log:${args.map(String).join('|')}`); },
  };
  const store = createStore({ feedbackFile, toolLogFile, ...callbacks });
  fs.writeFileSync(feedbackFile, JSON.stringify([{ id: 'old', message: 'SECRET old' }, { id: 'old2' }]));
  const obs = [store.readFeedbackEntries()];
  store.appendFeedbackEntry({ id: 'new', message: 'SECRET new' });
  obs.push(store.readFeedbackEntries());
  fs.writeFileSync(toolLogFile, ['{"n":1}', 'bad', '{"n":3}'].join('\n'));
  obs.push(store.readToolLog(2));
  store.appendToolLog({ error: 'SECRET e', args: JSON.stringify({ token: 'SECRET', a: 1 }) });
  obs.push(fs.readFileSync(toolLogFile, 'utf8').trim().split('\n').at(-1));
  obs.push(store.readToolLog());
  return { obs, trace };
}
{
  const actual = runScenario(createRuntimeRecordStore);
  const frozen = runScenario(createBaseline);
  eq('differential observations', JSON.stringify(actual.obs), JSON.stringify(frozen.obs));
  eq('differential callback trace', JSON.stringify(actual.trace), JSON.stringify(frozen.trace));
}

console.log(`test-runtime-records: PASS (${checks} checks)`);
