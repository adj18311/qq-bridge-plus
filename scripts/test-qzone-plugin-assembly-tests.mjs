#!/usr/bin/env node
// M1 — 插件库 `state.outcomes` 的幂等初始化（G1 结算的硬前置）
//
// WHY THIS FILE EXISTS
// --------------------
// `settleOfflineWrite` / `settleOfflineRead`（`qzone-settlement-offline.mjs:40-46`）在
// `state.outcomes` 不存在（或不是非数组对象）时抛
// `TypeError: missing reservation or invalid settlement state`。
// 而 `initialState` 只在**创建数据库文件**那一次生效 —— 所有已存在的库永远拿不到它。
// 实测：真实库 34 个字段里 ledger.reservations(3) / notices(0) / readOutcomes 都在，唯独
// `outcomes` 缺失 ⇒ 这台机器上的每一次 G1 结算都会抛异常。
//
// WHAT IS PINNED HERE（每条都是「代码里的性质」）
//   M1-1 全新库（无 outcomes）⇒ 装配后被补成 `{}`，**且只补这一个字段**；
//   M1-2 已有 outcomes（含内容）⇒ 原样保留，值逐字相等（`kept`）；
//   M1-3 三种损坏形态（'x' / [] / null）⇒ **不覆盖**，`describe().outcomesInit` 报 ok:false，
//        库里的原值逐字保留（这是「不能把损坏值当缺失」的证据）；
//   M1-4 不补 `pauseCycles`，也不新增任何其它字段（与 HEAD 版基线逐字段对比）；
//   M1-5 不重置 `readOutcomes` / `notices` / `ledger` / `audit` / `writeAudit` / `usedReadKeys`；
//   M1-6 幂等：同一份库装配两次，第二次 `action === 'kept'` 且库逐字节不变。
//
// 全部在 `os.tmpdir()` 的真实 SQLite 上跑：不碰仓库 state/、不发 QQ、不连 DSH、不连 bridge。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createQzoneHostAssembly } from '../plugins/qzone-safe/host-assembly.mjs';
import { openOfflineStore, openOfflineStoreReadOnly } from '../src/core/qzone-store-offline.mjs';
import { settleOfflineWrite } from '../src/core/qzone-settlement-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';

const BOT = 10001;
const TOKEN = 'm1-outcomes-token-0123456789';
const NOW = Date.parse('2026-11-20T04:00:00Z');

/** 一份能装配成功的 policy state；可选地叠一层「已有业务数据」，用来证明没被重置。 */
function baseState(over = {}) {
  return {
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 3, comment: 25, like: 30 },
    ledger: { day: beijingDay(NOW), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [],
    reads: 0, writes: 0, readAttempts: {}, readOutcomes: {},
    browseDay: beijingDay(NOW), todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
    activeStart: 0, activeEnd: 1439, audit: [], notices: [],
    ...over,
  };
}

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-m1-outcomes-'));
  t.after(() => {
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(directory, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
    }
  });
  return directory;
}

/** 建库并写入种子状态；返回库路径。 */
function seed(directory, state) {
  const file = path.join(directory, 'qzone-plugin-state.sqlite');
  const store = openOfflineStore(file, state);
  store.close();
  return file;
}

/** 只读整份 state（不经 handle，避免任何写入面）。 */
function readState(file) {
  const probe = openOfflineStoreReadOnly(file);
  try { return probe.read(); } finally { probe.close(); }
}

/** 装配一次并立刻拆掉；返回 describe()。 */
function assemble(directory) {
  const built = createQzoneHostAssembly({
    stateDir: directory,
    initialState: baseState(),
    origin: 'http://127.0.0.1:1',
    token: TOKEN,
    botQq: BOT,
    clock: () => NOW,
    mode: 'read-only',
  });
  const described = built.describe();
  built.teardown();
  return described;
}

/** 逐字段比较两份 state，返回 { changed, added, removed }（按 JSON 序列化比较）。 */
function diffFields(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed = [];
  const added = [];
  const removed = [];
  for (const key of keys) {
    const hadBefore = Object.hasOwn(before, key);
    const hasAfter = Object.hasOwn(after, key);
    if (!hadBefore && hasAfter) { added.push(key); continue; }
    if (hadBefore && !hasAfter) { removed.push(key); continue; }
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.push(key);
  }
  return { changed, added, removed };
}

/**
 * 把库准备成「装配的 1b/2 步都已经跑过」的形态，这样再看字段变化就**只剩 outcomes 一项**。
 *
 * WHY: 装配本身还做两件早就存在的事 —— 身份绑定（botQq/selfId）与 B2 replay 集合初始化。
 * 它们会往新库里写字段，从而掩盖「本轮到底多写了什么」。先空跑一次装配把它们落盘，再把
 * outcomes 删掉（模拟真实的老库：别的都有，就差这一个），第二遍装配才是一次干净的对照。
 */
function primeThenDropOutcomes(directory) {
  assemble(directory);
  const file = path.join(directory, 'qzone-plugin-state.sqlite');
  const store = openOfflineStore(file, baseState());
  store.update((state) => {
    const next = { ...state };
    delete next.outcomes;
    return next;
  });
  store.close();
  return file;
}

test('M1-1 全新库（无 outcomes）⇒ 补成 {}，且这一步只补这一个字段', (t) => {
  const directory = tempDir(t);
  const file = primeThenDropOutcomes(directory);
  const before = readState(file);
  assert.equal(Object.hasOwn(before, 'outcomes'), false, '前置：对照库必须真的没有 outcomes');

  const described = assemble(directory);
  assert.equal(described.outcomesInit.ok, true, '补上了就必须报 ok:true');
  assert.equal(described.outcomesInit.action, 'initialized', '缺失时 action 必须是 initialized');

  const after = readState(file);
  assert.deepEqual(after.outcomes, {}, '必须补成空对象');
  const diff = diffFields(before, after);
  assert.deepEqual(diff.added, ['outcomes'], `只允许新增 outcomes 一个字段（实测新增 ${JSON.stringify(diff.added)}）`);
  assert.deepEqual(diff.changed, [], `不得改动任何已有字段（实测改动 ${JSON.stringify(diff.changed)}）`);
  assert.deepEqual(diff.removed, [], '不得删除任何已有字段');
});

test('M1-2 已有 outcomes（含内容）⇒ 原样保留，action 必须 kept', (t) => {
  const directory = tempDir(t);
  const file = primeThenDropOutcomes(directory);
  const store = openOfflineStore(file, baseState());
  store.update((state) => ({ ...state, outcomes: { 'op-a': 'success', 'op-b': 'unknown' } }));
  store.close();
  const before = readState(file);
  const beforeRaw = JSON.stringify(before.outcomes);

  const described = assemble(directory);
  assert.equal(described.outcomesInit.ok, true);
  assert.equal(described.outcomesInit.action, 'kept', '已存在就必须是 kept，不能报 initialized');

  const after = readState(file);
  assert.equal(JSON.stringify(after.outcomes), beforeRaw, '已有 outcomes 必须逐字保留（一个字节都不改）');
  const diff = diffFields(before, after);
  assert.deepEqual(diff.changed, [], `不得改动任何字段（实测 ${JSON.stringify(diff.changed)}）`);
  assert.deepEqual(diff.added, [], '不得新增字段');
});

for (const [label, corrupt] of [["字符串 'x'", 'x'], ['数组 []', []], ['null', null]]) {
  test(`M1-3 outcomes 类型损坏（${label}）⇒ 不覆盖，标记可见，原值逐字保留`, (t) => {
    const directory = tempDir(t);
    const file = primeThenDropOutcomes(directory);
    const store = openOfflineStore(file, baseState());
    store.update((state) => ({ ...state, outcomes: corrupt }));
    store.close();
    const before = readState(file);
    const beforeRaw = JSON.stringify(before.outcomes);

    const described = assemble(directory);
    assert.equal(described.outcomesInit.ok, false, '损坏必须报 ok:false（不能装作补好了）');
    assert.equal(described.outcomesInit.action, 'corrupt', `损坏时 action 必须是 corrupt：${JSON.stringify(described.outcomesInit)}`);
    assert.equal(typeof described.outcomesInit.detail, 'string', '必须有一句人能读懂的 detail');
    assert.match(described.outcomesInit.detail, /left UNTOUCHED/, 'detail 必须明说没覆盖');
    assert.ok(described.outcomesInit.found && typeof described.outcomesInit.found.type === 'string',
      '必须报出找到的类型，否则运维无法判断是哪一种损坏');

    const after = readState(file);
    assert.equal(JSON.stringify(after.outcomes), beforeRaw,
      `损坏值必须逐字保留（原本 ${beforeRaw}，现在 ${JSON.stringify(after.outcomes)}）`);
    const diff = diffFields(before, after);
    assert.deepEqual(diff.changed, [], `不得改动任何字段（实测 ${JSON.stringify(diff.changed)}）`);
  });
}

test('M1-4 不补 pauseCycles，也不改 readOutcomes / notices / ledger / audit / writeAudit / usedReadKeys', (t) => {
  const directory = tempDir(t);
  const file = primeThenDropOutcomes(directory);
  // 塞进真实形状的业务数据，证明它们不会被「顺手清理」。
  const store = openOfflineStore(file, baseState());
  store.update((state) => ({
    ...state,
    readOutcomes: { 'k1': 'allowed', 'k2': 'denied' },
    notices: [{ layer: 'write', cause: 'failure', operationId: 'op-x' }],
    audit: [{ id: 'a1', record: { time: NOW, source: 'qq', action: 'read_posts', target: '1234567890', postId: null,
      commentId: null, content: '', redacted: false, result: 'success', reason: '', quota: null } }],
    writeAudit: [{ stage: 'result', outcome: 'success' }],
    usedReadKeys: { 'read:abc': true },
    ledger: { day: beijingDay(NOW), used: { post: 1, comment: 2, like: 3 }, reservations: { 'op-1': 'post' } },
  }));
  store.close();
  const before = readState(file);
  assemble(directory);
  const after = readState(file);

  assert.equal(Object.hasOwn(before, 'pauseCycles'), Object.hasOwn(after, 'pauseCycles'),
    'pauseCycles 的存在性不得被改变（本步只补 outcomes）');
  assert.equal(Object.hasOwn(after, 'pauseCycles'), false, '对照库里本来就没有 pauseCycles，装配后也不许出现');
  for (const key of ['readOutcomes', 'notices', 'ledger', 'audit', 'writeAudit', 'usedReadKeys']) {
    assert.equal(JSON.stringify(after[key]), JSON.stringify(before[key]), `${key} 不得被重置或改写`);
  }
  assert.deepEqual(diffFields(before, after).changed, [], '整库逐字段：不得有任何改动');
});

test('M1-5 幂等：同一份库装配两次，第二次 kept 且库内容不变', (t) => {
  const directory = tempDir(t);
  const file = primeThenDropOutcomes(directory);
  const first = assemble(directory);
  assert.equal(first.outcomesInit.action, 'initialized');
  const afterFirst = readState(file);

  const second = assemble(directory);
  assert.equal(second.outcomesInit.action, 'kept', '第二次必须是 kept');
  const afterSecond = readState(file);
  assert.deepEqual(diffFields(afterFirst, afterSecond), { changed: [], added: [], removed: [] }, '第二次装配不得改动任何字段');
});

test('M1-6 补上 outcomes 之后，G1 结算才不抛（补字段不是为了好看）', (t) => {
  const directory = tempDir(t);
  const file = primeThenDropOutcomes(directory);
  // 造一条在途预留：结算需要 ledger.reservations 里有这个 id。
  const store = openOfflineStore(file, baseState());
  store.update((state) => ({
    ...state,
    writes: 1,
    probe: 'done',
    ledger: { day: beijingDay(NOW), used: { post: 0, comment: 0, like: 0 }, reservations: { 'op-settle': 'post' } },
  }));
  store.close();

  // 反面证据：装配**之前**结算必抛（这就是真实库现在的状态）。
  const raw = openOfflineStore(file, baseState());
  assert.throws(() => settleOfflineWrite(raw, 'op-settle', 'success', NOW), /missing reservation or invalid settlement state/,
    '没有 outcomes 时结算必须抛 —— 这正是 M1 要修的那个洞');
  raw.close();

  assemble(directory);

  const settled = openOfflineStore(file, baseState());
  const result = settleOfflineWrite(settled, 'op-settle', 'success', NOW);
  const finalState = settled.read();
  settled.close();
  assert.equal(result.applied, true, '补上字段后同一次结算必须能落地');
  assert.equal(finalState.outcomes['op-settle'], 'success', 'outcome 必须真的写进去');
});
