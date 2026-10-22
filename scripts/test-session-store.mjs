// node:test 套件：src/core/session-store.mjs 的映射持久化与只读降级语义。
//
// 边界：所有读写都发生在 fs.mkdtempSync(os.tmpdir()) 的临时目录里，每个用例 finally
// 递归删除；不触碰仓库里的 state/ 或任何其它生产文件，也不启动桥接。
//
// 关于「读失败」用例的平台差异：原 bridge 用 `fs.readFileSync(file)`。在 POSIX 上传
// 「父级是普通文件」的路径会抛 ENOTDIR，但在 Windows 上同一路径抛 **ENOENT**（Windows
// 不区分「路径不存在」和「路径中间不是目录」），会被 ENOENT 分支当作「首次启动」而**不**
// 降级。因此这里用「目标本身是目录」的 EISDIR 覆盖同一个「非 ENOENT 读错误 → 只读降级」
// 分支；两种平台的错误码不同，但走的是同一段代码。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSessionStore } from '../src/core/session-store.mjs';

const EMPTY = { sessions: {}, sessionPolicies: {} };

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-test-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 递归列出临时目录里遗留的随机名临时文件（成功和失败路径都不应留下它们）。
function tmpLeftovers(dir) {
  return fs.readdirSync(dir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.tmp'));
}

// 每个用例自己收集日志；保留参数数组，顺便断言日志接口只收到一个字符串。
function makeStore(file) {
  const logs = [];
  const store = createSessionStore({ file, log: (...args) => logs.push(args) });
  return { store, logs };
}

function messages(logs) {
  return logs.map((args) => args[0]);
}

test('工厂只保存 file/log：不读盘、不建目录，缺少 file 直接拒绝', () => withTempDir((dir) => {
  const file = path.join(dir, 'nested', 'sessions.json');
  const store = createSessionStore({ file });
  assert.equal(fs.existsSync(path.dirname(file)), false, '创建 store 不应建目录');
  assert.equal(store.writable, true);

  assert.throws(() => createSessionStore({}), { name: 'TypeError' });
  assert.throws(() => createSessionStore({ file: '' }), { name: 'TypeError' });
}));

test('load 原样返回已有映射（含未知顶层字段），save 原子写回 2 空格 JSON + 末尾换行', () => withTempDir((dir) => {
  const file = path.join(dir, 'sessions.json');
  const initial = {
    sessions: { 'group:1001': 'sess-a', 'private:2002': 'sess-b' },
    sessionPolicies: { 'group:1001': ['reserved2', 'qq-chat-v2', null] },
    schemaVersion: 2,
  };
  fs.writeFileSync(file, JSON.stringify(initial), 'utf8');

  const { store, logs } = makeStore(file);
  const state = store.load();
  assert.deepEqual(state, initial);
  assert.equal(store.writable, true);
  assert.deepEqual(logs, []);

  state.sessions['group:3003'] = 'sess-c';
  store.save(state);

  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw, `${JSON.stringify(state, null, 2)}\n`);
  assert.match(raw, /\n {2}"sessions": \{/);
  assert.equal(raw.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(raw), state);
  assert.deepEqual(tmpLeftovers(dir), []);
}));

test('缺失 sessionPolicies 补 {}；sessions 非对象回落 { sessions: {} }', () => withTempDir((dir) => {
  const file = path.join(dir, 'sessions.json');

  fs.writeFileSync(file, JSON.stringify({ sessions: { 'group:1': 's1' } }), 'utf8');
  assert.deepEqual(makeStore(file).store.load(), { sessions: { 'group:1': 's1' }, sessionPolicies: {} });

  // 原语义：sessions 不是对象时整个 loaded 被丢弃，连它带的 sessionPolicies 也不保留。
  fs.writeFileSync(file, JSON.stringify({ sessions: 42, sessionPolicies: { 'group:1': [] } }), 'utf8');
  assert.deepEqual(makeStore(file).store.load(), EMPTY);

  // 合法 JSON 但不是对象：一律回落到空映射，不算「损坏」，不降级也不打印。
  for (const content of ['null', '[]', '"text"', '7', 'true']) {
    fs.writeFileSync(file, content, 'utf8');
    const { store, logs } = makeStore(file);
    assert.deepEqual(store.load(), EMPTY, content);
    assert.equal(store.writable, true, `${content} 是合法 JSON，不应降级`);
    assert.deepEqual(logs, [], content);
  }
}));

test('文件不存在：返回空映射、仍可写、不打印，首次 save 落盘', () => withTempDir((dir) => {
  const file = path.join(dir, 'sessions.json');
  const { store, logs } = makeStore(file);
  const state = store.load();
  assert.deepEqual(state, EMPTY);
  assert.equal(store.writable, true);
  assert.deepEqual(logs, []);

  state.sessions['group:42'] = 'sess-42';
  store.save(state);
  assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(state, null, 2)}\n`);
  assert.deepEqual(tmpLeftovers(dir), []);
}));

test('UTF-8 BOM 在解析前剥掉', () => withTempDir((dir) => {
  const file = path.join(dir, 'sessions.json');
  const expected = { sessions: { 'group:bom': 'sess-bom' }, sessionPolicies: {} };
  fs.writeFileSync(file, `\uFEFF${JSON.stringify({ sessions: expected.sessions })}`, 'utf8');

  const { store, logs } = makeStore(file);
  assert.deepEqual(store.load(), expected);
  assert.equal(store.writable, true);
  assert.deepEqual(logs, []);
}));

test('空文件与纯空白文件都返回空映射，不降级也不打印', () => withTempDir((dir) => {
  const file = path.join(dir, 'sessions.json');
  for (const content of ['', '   \n\t\r\n  ']) {
    fs.writeFileSync(file, content, 'utf8');
    const { store, logs } = makeStore(file);
    assert.deepEqual(store.load(), EMPTY, JSON.stringify(content));
    assert.equal(store.writable, true);
    assert.deepEqual(logs, []);
  }

  // 空文件载入后落盘的是规范空映射（2 空格 + 末尾换行）。
  const { store } = makeStore(file);
  store.save(store.load());
  assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(EMPTY, null, 2)}\n`);
}));

test('内容损坏：空映射 + 只读 + 精确日志，save 不改动原字节', () => withTempDir((dir) => {
  const file = path.join(dir, 'sessions.json');
  const original = '{"sessions": {"group:1": "sess-a"},';
  fs.writeFileSync(file, original, 'utf8');
  const before = fs.readFileSync(file);

  // 用同一个 JSON.parse 生成期望文案，避免绑定某个 Node 版本的 SyntaxError 措辞。
  let parseError;
  try { JSON.parse(original); } catch (error) { parseError = error; }
  const expected = `⚠️ sessions.json 内容损坏，已降级为「只读不写」（不会覆盖原文件，请先备份再修复）：${parseError?.message ?? parseError}`;

  const { store, logs } = makeStore(file);
  assert.deepEqual(store.load(), EMPTY);
  assert.equal(store.writable, false);
  assert.deepEqual(messages(logs), [expected]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].length, 1, 'log 只接收一个字符串参数');
  assert.equal(typeof logs[0][0], 'string');

  store.save({ sessions: { 'group:1': 'overwritten' }, sessionPolicies: {} });
  assert.deepEqual(fs.readFileSync(file), before, '损坏的原文件必须逐字节保留');
  assert.deepEqual(tmpLeftovers(dir), []);
}));

test('读取失败（非 ENOENT，如目标是目录 → EISDIR）：空映射 + 只读 + 精确日志，绝不落盘', () => withTempDir((dir) => {
  const file = path.join(dir, 'sessions.json');
  fs.mkdirSync(file);
  let readError;
  try { fs.readFileSync(file, 'utf8'); } catch (error) { readError = error; }
  assert.ok(readError);
  assert.notEqual(readError.code, 'ENOENT'); // 用例前提：走「其它读错误」分支
  const expected = `⚠️ sessions.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${readError?.message ?? readError}`;

  const { store, logs } = makeStore(file);
  assert.deepEqual(store.load(), EMPTY);
  assert.equal(store.writable, false);
  assert.deepEqual(messages(logs), [expected]);
  assert.equal(logs[0].length, 1, 'log 只接收一个字符串参数');

  store.save(EMPTY);
  assert.equal(fs.statSync(file).isDirectory(), true, '原目标必须原样保留');
  assert.deepEqual(fs.readdirSync(file), [], '不得在目标目录里写任何东西');
  assert.deepEqual(tmpLeftovers(dir), []);
}));

test('有效载入后写入失败：错误原样抛出，不静默降级', () => withTempDir((dir) => {
  const file = path.join(dir, 'sessions.json');
  fs.writeFileSync(file, JSON.stringify(EMPTY), 'utf8');
  const { store, logs } = makeStore(file);
  const state = store.load();
  assert.equal(store.writable, true);
  assert.deepEqual(logs, []);

  // 把目标换成同名目录：原子 rename 无法用文件覆盖目录 → 写失败。
  fs.rmSync(file);
  fs.mkdirSync(file);
  let thrown;
  try {
    store.save({ ...state, sessions: { 'group:1': 's1' } });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, '写失败必须抛出');
  assert.equal(typeof thrown.code, 'string');
  assert.equal(store.writable, true, '写失败不应改变只读标记');
  assert.deepEqual(fs.readdirSync(file), [], '目标目录不得被写入');
  assert.deepEqual(tmpLeftovers(dir), [], '失败路径必须清掉随机名临时文件');
}));

test('损坏一旦发生，后续 load 仍只读；即使文件被修好也不恢复写入', () => withTempDir((dir) => {
  const file = path.join(dir, 'sessions.json');
  fs.writeFileSync(file, '{broken', 'utf8');
  const { store, logs } = makeStore(file);
  assert.deepEqual(store.load(), EMPTY);
  assert.equal(store.writable, false);

  const repaired = { sessions: { 'group:1': 's1' }, sessionPolicies: {} };
  fs.writeFileSync(file, JSON.stringify(repaired), 'utf8');
  assert.deepEqual(store.load(), repaired, '修复后的内容仍然可以读出来');
  assert.equal(store.writable, false, 'writable 只降不升');

  const before = fs.readFileSync(file);
  store.save({ sessions: { 'group:1': 'hacked' }, sessionPolicies: {} });
  assert.deepEqual(fs.readFileSync(file), before, '只读实例不得覆盖已修复的文件');

  // 再损坏一次：仍只读，日志逐次追加（与 bridge 每次 loadState 的行为一致）。
  fs.writeFileSync(file, '{broken again', 'utf8');
  assert.deepEqual(store.load(), EMPTY);
  assert.equal(store.writable, false);
  assert.equal(logs.length, 2);
  for (const message of messages(logs)) {
    assert.match(message, /^⚠️ sessions\.json 内容损坏，已降级为「只读不写」/);
  }
}));

test('sessionPolicies 不是普通对象（数组/字符串/null/数字）一律替换为 {}', () => withTempDir((dir) => {
  const file = path.join(dir, 'sessions.json');
  const cases = [
    ['array', [1, 2]],
    ['string', 'nope'],
    ['null', null],
    ['number', 3],
    ['missing', undefined],
  ];
  for (const [label, policies] of cases) {
    const payload = { sessions: { 'group:1': 's1' } };
    if (policies !== undefined) payload.sessionPolicies = policies;
    fs.writeFileSync(file, JSON.stringify(payload), 'utf8');

    const { store, logs } = makeStore(file);
    assert.deepEqual(store.load(), { sessions: { 'group:1': 's1' }, sessionPolicies: {} }, label);
    assert.equal(store.writable, true, label);
    assert.deepEqual(logs, [], label);
  }
}));

test('两个 store 各自持有自己的 file 与 writable，互不影响', () => withTempDir((dir) => {
  const goodFile = path.join(dir, 'sessions.json');
  const badDir = path.join(dir, 'bad');
  fs.mkdirSync(badDir);
  const badFile = path.join(badDir, 'sessions.json');
  fs.mkdirSync(badFile); // 读它会 EISDIR → 只读降级
  fs.writeFileSync(goodFile, JSON.stringify({ sessions: { 'group:1': 's1' } }), 'utf8');

  const good = makeStore(goodFile).store;
  const bad = makeStore(badFile).store;
  assert.equal(good.load().sessions['group:1'], 's1');
  assert.deepEqual(bad.load(), EMPTY);
  assert.equal(good.writable, true);
  assert.equal(bad.writable, false);

  bad.save({ sessions: { 'group:1': 'overwritten' }, sessionPolicies: {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(goodFile, 'utf8')).sessions, { 'group:1': 's1' });
  assert.deepEqual(fs.readdirSync(badFile), []);

  good.save({ sessions: { 'group:1': 's2' }, sessionPolicies: {} });
  assert.equal(JSON.parse(fs.readFileSync(goodFile, 'utf8')).sessions['group:1'], 's2');
}));
