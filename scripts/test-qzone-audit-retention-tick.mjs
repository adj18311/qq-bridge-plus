#!/usr/bin/env node
// test-qzone-audit-retention-tick.mjs —— 批2-step3：七天清理（**只删日文件**）的接线面
//
// WHAT THIS FILE PINS（每条都是「代码里的性质」，不是注释里的承诺）:
//   R1 只删「过期 + 合法日名 + 位于 state/qzone-audit 内」的普通文件；
//      同目录的非日文件、子目录、符号链接、以及**兄弟目录**里的同名日文件一律不动。
//   R2 七天判定用的是既有 auditRetentionDecision（6 天留、7 天删），本文件不重写规则。
//   R3 导出 failed ⇒ 本轮**一个文件都不删**，且日志里有一句说明原因；
//   R4 导出 complete !== 'complete'（lostIds>0）⇒ 同样跳过，且日志里写明 lostIds；
//   R5 插件库 state.audit **以及其它所有字段**在 pass 前后逐字段一致；state 行的原始 TEXT
//      也逐字节一致（这是「只做日文件清理、不碰权威源」的核心证据）。
//   R6 沿用现有 10 分钟节流与 in-flight 守卫（被节流/在跑时也不得删文件）；
//      清理函数体内不出现 setInterval（没有给清理单开一套定时器）。
//
// 全部在 harness 的临时目录里跑：不碰仓库 state/、不发 QQ、不连 DSH。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import * as auditJsonl from '../src/core/qzone-audit-jsonl-offline.mjs';
import * as storeMod from '../src/core/qzone-store-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';

const DISABLED = { backgroundPatrol: { enabled: false }, ownerNotice: { enabled: false } };
const DAY_MS = 86400000;

/** 在 harness 的临时 state 目录里建一份插件库（与生产同名同形），可塞入审计行。 */
function seedPluginDb(tempDir, rows) {
  const pluginPath = path.join(tempDir, 'state', 'qzone-plugin-state.sqlite');
  const now = Date.now();
  const handle = storeMod.openOfflineStore(pluginPath, {
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: {}, limits: {},
    ledger: { day: beijingDay(now), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    intervalMinutes: 100, activeStart: 0, activeEnd: 1439, probe: 'done',
    reads: 0, writes: 0, readAttempts: {}, readOutcomes: {},
    browseDay: beijingDay(now), todayBrowses: 0, lastBrowseAt: null,
    usedOpportunities: {}, audit: [], notices: [], writeAudit: [], offlineOpportunityOffers: {},
  });
  if (Array.isArray(rows) && rows.length > 0) handle.update((state) => ({ ...state, audit: rows }));
  handle.close();
  return pluginPath;
}

/** 一行合法的 state.audit 记录（形状取自真库：{id, record}）。 */
function auditRow(seed, at) {
  return {
    id: 'dsp_' + String(seed).repeat(32).slice(0, 32),
    record: {
      time: at, source: 'qq', action: 'read_posts', target: '1234567890',
      postId: null, commentId: null, content: '', redacted: false,
      result: 'denied', reason: 'policy', quota: null,
    },
  };
}

async function withHarness(fn) {
  const h = await bridgeHarness({ config: DISABLED, globals: { ...auditJsonl, ...storeMod } });
  try { return await fn(h); } finally { await h.close(); }
}

const auditRoot = (h) => path.join(h.temp, 'state', 'qzone-audit');
const bridgeLog = (h) => {
  try { return fs.readFileSync(path.join(h.temp, 'state', 'bridge.log'), 'utf8'); } catch { return ''; }
};

/** 把插件库 state 行的**原始 TEXT**读出来（不经 JSON 往返），用于逐字节比对。 */
function rawStateText(pluginPath) {
  const db = new DatabaseSync(pluginPath, { readOnly: true });
  try { return db.prepare('SELECT value FROM state WHERE id = 1').get().value; }
  finally { db.close(); }
}

/** 在临时 state/qzone-audit 下铺一批文件：过期日文件 / 未过期日文件 / 非日文件 / 子目录。 */
function seedAuditDir(h, now) {
  const root = auditRoot(h);
  fs.mkdirSync(root, { recursive: true });
  const today = beijingDay(now);
  const name = (daysAgo) => beijingDay(now - daysAgo * DAY_MS) + '.jsonl';
  const expired = [name(8), name(30)];
  const keep = [name(0), name(3), name(6)];
  for (const n of [...expired, ...keep]) fs.writeFileSync(path.join(root, n), '{"auditId":"x"}\n', 'utf8');
  // 非日文件：名字不是 YYYY-MM-DD.jsonl，prune 必须完全无视它们。
  const nonDay = ['notes.md', 'README.txt', 'archive.jsonl', name(30) + '.bak', '2026-11-01.jsonl.tmp'];
  for (const n of nonDay) fs.writeFileSync(path.join(root, n), 'do-not-touch', 'utf8');
  // 子目录：名字即使是合法日名，isFile() 为 false，也不得被删或被递归进去。
  const subDir = path.join(root, name(30).replace('.jsonl', ''));
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'inner.txt'), 'inner', 'utf8');
  const subDirNamedLikeDay = path.join(root, name(9));
  fs.mkdirSync(subDirNamedLikeDay, { recursive: true });
  // 兄弟目录：root 之外的过期日文件不得被本 pass 碰到。
  const sibling = path.join(h.temp, 'state', 'qzone-audit-other');
  fs.mkdirSync(sibling, { recursive: true });
  const siblingExpired = path.join(sibling, name(30));
  fs.writeFileSync(siblingExpired, 'sibling', 'utf8');
  return { root, today, expired, keep, nonDay, subDir, subDirNamedLikeDay, sibling, siblingExpired };
}

function listDir(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).map((e) => e.name).sort();
}


test('R1 只删过期日文件：非日文件 / 子目录 / 兄弟目录毫发无损', async () => {
  await withHarness(async (h) => {
    const now = Date.now();
    // 导出 pass 要求插件库存在（否则连导出都不跑，自然也没有清理）——先建一份最小库。
    seedPluginDb(h.temp, [auditRow(9, now)]);
    const seeds = seedAuditDir(h, now);
    const before = listDir(seeds.root);
    h.context.__qzoneAuditExportResetClock();
    const result = h.context.__qzoneAuditExportPass();
    assert.equal(result.ran, true, `本轮必须真跑：${JSON.stringify(result?.skipped)}`);
    assert.equal(result.retention?.removed?.length, 2, `必须只删 2 个过期日文件：${JSON.stringify(result.retention)}`);

    const after = listDir(seeds.root);
    // 过期日文件：2 个都不在了。
    for (const n of seeds.expired) assert.equal(after.includes(n), false, `过期日文件必须被删：${n}`);
    // 未过期日文件（含今天、3 天前、6 天前的边界）：一个都不能少。
    for (const n of seeds.keep) assert.equal(after.includes(n), true, `未过期日文件必须保留：${n}`);
    // 非日文件：全部原地不动，且内容一个字节都没变。
    for (const n of seeds.nonDay) {
      assert.equal(after.includes(n), true, `非日文件必须保留：${n}`);
      assert.equal(fs.readFileSync(path.join(seeds.root, n), 'utf8'), 'do-not-touch', `非日文件内容不得被改写：${n}`);
    }
    // 子目录：目录本身在，里面的文件也在（没有被递归删除）。
    assert.equal(after.includes(path.basename(seeds.subDir)), true, '子目录必须保留');
    assert.equal(fs.readFileSync(path.join(seeds.subDir, 'inner.txt'), 'utf8'), 'inner', '子目录内容不得被删');
    // 名字长得像日文件、但其实是目录：isFile() 为 false，不得被 unlink。
    assert.equal(after.includes(path.basename(seeds.subDirNamedLikeDay)), true, '名字像日文件的目录必须保留');
    // 兄弟目录里的过期日文件：root 之外，不得被碰。
    assert.equal(fs.existsSync(seeds.siblingExpired), true, 'root 之外的过期日文件不得被删');
    assert.deepEqual(listDir(seeds.root).length, before.length - 2, '目录项总数只能因 2 个日文件而减少');

    // prune 的 { removed, kept } 必须进日志（首次删除至少记一次）。
    const text = bridgeLog(h);
    assert.match(text, /QQ 空间审计清理：删除过期日文件 2 个/, '删除必须留痕');
    assert.match(text, /保留 \d+ 个/, 'kept 必须一起写进日志');
  });
});

test('R2 七天边界用的是既有 auditRetentionDecision：6 天前留、7 天前删，今天与未来日留', async () => {
  await withHarness(async (h) => {
    const now = Date.now();
    seedPluginDb(h.temp, [auditRow(8, now)]);
    const root = auditRoot(h);
    fs.mkdirSync(root, { recursive: true });
    const name = (d) => beijingDay(now - d * DAY_MS) + '.jsonl';
    const keepNames = [name(0), name(1), name(6)];
    const dropNames = [name(7), name(8)];
    const futureName = beijingDay(now + 3 * DAY_MS) + '.jsonl';
    for (const n of [...keepNames, ...dropNames, futureName]) fs.writeFileSync(path.join(root, n), '\n', 'utf8');
    h.context.__qzoneAuditExportResetClock();
    const result = h.context.__qzoneAuditExportPass();
    assert.equal(result.retention?.removed?.length, 2, `必须只删 7/8 天前两个：${JSON.stringify(result.retention)}`);
    assert.deepEqual([...result.retention.removed].sort(), [...dropNames].sort(), '删掉的必须正好是 7/8 天前那两个');
    // kept = 0(今天) + 1 + 6 + future = 4 个（prune 把 future 计入 kept）。
    assert.equal(result.retention.kept, 4, `kept 必须是 4（今天/1 天前/6 天前/未来日）：${result.retention.kept}`);
    for (const n of [...keepNames, futureName]) assert.equal(fs.existsSync(path.join(root, n)), true, `必须保留：${n}`);
  });
});

test('R3 导出 failed ⇒ 本轮一个文件都不删，且日志写明原因', async () => {
  await withHarness(async (h) => {
    const now = Date.now();
    // 坏库：audit 不是数组 ⇒ 导出器报 failed，snapshot 读不出 ⇒ complete=unknown。
    const pluginPath = path.join(h.temp, 'state', 'qzone-plugin-state.sqlite');
    const handle = storeMod.openOfflineStore(pluginPath, {
      enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
      tools: {}, limits: {},
      ledger: { day: beijingDay(now), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
      intervalMinutes: 100, activeStart: 0, activeEnd: 1439, probe: 'done',
      reads: 0, writes: 0, readAttempts: {}, readOutcomes: {},
      browseDay: beijingDay(now), todayBrowses: 0, lastBrowseAt: null,
      usedOpportunities: {}, audit: [], notices: [], writeAudit: [], offlineOpportunityOffers: {},
    });
    handle.update((state) => ({ ...state, audit: 'not-an-array' }));
    handle.close();

    const seeds = seedAuditDir(h, now);
    const before = listDir(seeds.root);
    h.context.__qzoneAuditExportResetClock();
    const result = h.context.__qzoneAuditExportPass();
    assert.equal(result.report?.failed, true, `坏库必须判 failed：${JSON.stringify(result.report)}`);
    // 关键：失败的这一轮必须在**进入清理之前**就 return，retention 只允许是「已跳过」的结论，
    // 绝不能带着 removed 列表出来 —— 那才是「删了东西」的证据。
    // 用字段比较而不是 deepEqual：retention 是 VM 上下文里造的对象，原型与本文件不同，
    // deepStrictEqual 会跨 realm 判不等（那是测试框架的假阳性，不是产品行为）。
    assert.equal(result.retention?.skipped, 'export-failed',
      `导出 failed 时必须显式跳过清理：${JSON.stringify(result.retention)}`);
    assert.equal(result.retention?.removed, undefined, '跳过的一轮不得带 removed 列表');
    assert.deepEqual(listDir(seeds.root), before, '导出失败的一轮：目录内容必须逐项不变（一个文件都不许少）');
    const text = bridgeLog(h);
    assert.match(text, /QQ 空间审计清理跳过：最近一次导出 failed/, '跳过必须留痕并说明是导出失败');
  });
});

test('R4 导出 complete !== complete（有漏行）⇒ 跳过清理并写明 lostIds', async () => {
  await withHarness(async (h) => {
    const now = Date.now();
    // 一行 id 形状不合法（含空格）⇒ 被计入 lostIds，complete 变 incomplete，导出本身不算 failed。
    const badRow = { id: 'bad id with spaces', record: { time: now, source: 'qq', action: 'read_posts',
      target: '1234567890', postId: null, commentId: null, content: '', redacted: false,
      result: 'denied', reason: 'policy', quota: null } };
    seedPluginDb(h.temp, [auditRow(7, now), badRow]);
    const seeds = seedAuditDir(h, now);
    const before = listDir(seeds.root);
    h.context.__qzoneAuditExportResetClock();
    const result = h.context.__qzoneAuditExportPass();
    assert.equal(result.report?.failed, false, '坏行不算 failed（它是一行被拒绝，不是整轮中断）');
    assert.equal(result.report?.complete, 'incomplete', `有漏行必须判 incomplete：${JSON.stringify(result.report?.complete)}`);
    assert.ok(result.report?.lostIds > 0, `lostIds 必须 > 0：${result.report?.lostIds}`);
    assert.equal(result.retention?.skipped, 'export-incomplete', `must skip：${JSON.stringify(result.retention)}`);
    assert.deepEqual(listDir(seeds.root), before, '导出不完整的一轮：目录内容必须逐项不变');
    const text = bridgeLog(h);
    assert.match(text, /QQ 空间审计清理跳过：导出不完整（complete=incomplete，lostIds=1）/, '跳过必须带 complete 与 lostIds');
  });
});

test('R5 插件库：state.audit 行数与其它所有字段逐字段一致，state 行原始 TEXT 逐字节一致', async () => {
  await withHarness(async (h) => {
    const now = Date.now();
    seedPluginDb(h.temp, [auditRow(1, now), auditRow(2, now - 2 * DAY_MS), auditRow(3, now - 40 * DAY_MS)]);
    const pluginPath = path.join(h.temp, 'state', 'qzone-plugin-state.sqlite');
    // 额外塞几个「不该被审计清理碰到」的运行状态字段：确认它们原样保留。
    const extra = storeMod.openOfflineStore(pluginPath, { enabled: false, tools: {}, limits: {} });
    extra.update((state) => ({
      ...state,
      settled: { ['deadbeef'.repeat(8)]: { at: now, writes: 2 } },
      lastPostAt: now - 1000,
      lastCommentAt: now - 2000,
      writeGate: { faulted: false, revision: 3 },
      auditGaps: [{ key: 'gap-1', reason: 'audit-write-failed', generation: 1, time: now, resolvedBy: null }],
      ledger: { day: beijingDay(now), used: { post: 1, comment: 2, like: 3 }, reservations: { r1: { kind: 'post', at: now } } },
    }));
    extra.close();

    const beforeText = rawStateText(pluginPath);
    const beforeState = JSON.parse(beforeText);
    const beforeRows = beforeState.audit.length;
    const seeds = seedAuditDir(h, now);
    h.context.__qzoneAuditExportResetClock();
    const result = h.context.__qzoneAuditExportPass();
    assert.equal(result.retention?.removed?.length, 2, `前置：本轮必须真的删了日文件（证明清理确实跑过）：${JSON.stringify(result.retention)}`);

    const afterText = rawStateText(pluginPath);
    const afterState = JSON.parse(afterText);
    // (a) 原始字节：一个字节都不能变 —— 这是最强的那条证据。
    assert.equal(afterText, beforeText, '插件库 state 行的原始 TEXT 必须逐字节一致（本轮不该写库）');
    // (b) 逐字段：每个顶层字段的 JSON 序列化都要相同（不只比对 audit）。
    assert.deepEqual(Object.keys(afterState).sort(), Object.keys(beforeState).sort(), '顶层字段集合不得变化');
    for (const key of Object.keys(beforeState)) {
      assert.equal(JSON.stringify(afterState[key]), JSON.stringify(beforeState[key]), `字段 ${key} 必须逐字段一致`);
    }
    // (c) 逐项点名本步最关心的几个字段：即使 (b) 全绿，也用独立断言把它们钉死。
    assert.equal(afterState.audit.length, beforeRows, `state.audit 行数必须不变（${beforeRows}）`);
    assert.deepEqual(afterState.settled, beforeState.settled, 'settled 不得被改动（去重状态）');
    assert.deepEqual(afterState.ledger, beforeState.ledger, 'ledger / reservations 不得被改动');
    assert.equal(afterState.lastPostAt, beforeState.lastPostAt, 'lastPostAt 不得被改动');
    assert.equal(afterState.lastCommentAt, beforeState.lastCommentAt, 'lastCommentAt 不得被改动');
    assert.deepEqual(afterState.writeGate, beforeState.writeGate, 'writeGate 不得被改动');
    assert.deepEqual(afterState.auditGaps, beforeState.auditGaps, 'auditGaps 不得被改动');
    assert.equal(seeds.root.length > 0, true);
  });
});

test('R6 节流与串行守卫照旧生效：被节流/在跑时也不得删文件；清理函数体内无 setInterval', async () => {
  await withHarness(async (h) => {
    const now = Date.now();
    seedPluginDb(h.temp, [auditRow(5, now)]);
    const seeds = seedAuditDir(h, now);
    const before = listDir(seeds.root);
    // (1) 在跑守卫：整轮跳过 ⇒ 不导出也不清理。
    h.context.__qzoneAuditExportResetClock();
    h.context.__qzoneAuditExportForceInFlight(true);
    const blocked = h.context.__qzoneAuditExportPass();
    assert.equal(blocked.skipped, 'in-flight', `必须是 in-flight 跳过：${JSON.stringify(blocked)}`);
    assert.equal(blocked.retention, undefined, 'in-flight 跳过时不得有清理结论');
    assert.deepEqual(listDir(seeds.root), before, 'in-flight 跳过的一轮不得删任何文件');
    h.context.__qzoneAuditExportForceInFlight(false);
    // (2) 正常跑一轮（会删过期文件）。
    const first = h.context.__qzoneAuditExportPass();
    assert.equal(first.retention?.removed?.length, 2, `首轮必须删 2 个：${JSON.stringify(first.retention)}`);
    // (3) 节流：10 分钟内的第二轮跳过 ⇒ 不得再删；也再没有可删的了，但重点是 skipped 的语义。
    seedAuditDir(h, now);   // 重新铺一批（此时目录里已有上一轮留下的未过期文件，重铺是幂等的）
    const beforeSecond = listDir(seeds.root);
    const second = h.context.__qzoneAuditExportPass();
    assert.equal(second.skipped, 'throttled', `第二轮必须被节流：${JSON.stringify(second)}`);
    assert.equal(second.retention, undefined, '被节流的一轮不得有清理结论');
    assert.deepEqual(listDir(seeds.root), beforeSecond, '被节流的一轮不得删任何文件');
  });
  // 静态面：清理函数里不得出现定时器/数据库写入。
  const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const start = source.indexOf('function runQzoneAuditRetentionPass');
  assert.ok(start > 0, 'bridge.js 必须存在 runQzoneAuditRetentionPass');
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, '必须能切出函数体');
  const body = source.slice(start, end);
  assert.equal(/setInterval\s*\(/.test(body), false, '清理不得单开定时器');
  assert.equal(/setTimeout\s*\(/.test(body), false, '清理不得单开定时器');
  assert.equal(/store\.update\s*\(/.test(body), false, '清理不得写数据库（state.audit 是权威源）');
  assert.equal(/pruneOfflineAudit/.test(body), false, '清理不得调用数据库侧 prune');
});
