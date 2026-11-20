#!/usr/bin/env node
// test-qzone-audit-export-tick.mjs —— A3：谁能写 state/qzone-audit，以及写失败了看不看得见
//
// WHY THIS EXISTS（本轮 A3 第二步的裁决点，逐条钉住）:
//   · 导出器此前**没有任何生产调用者**：bridge 全文没有 auditJsonlDir，console runtime 的
//     createAuditJsonl 恒为 null，state/qzone-audit 在本机从未存在过。
//   · 接上之后有四件事必须成为「代码里的性质」而不是注释里的承诺：
//       A3X-1 正常路径：真的写出 N 行、complete、目录是首次创建时留了一行日志；
//       A3X-2 串行守卫：上一轮没结束 ⇒ 本轮 skipped='in-flight'，一个字节都不写；
//       A3X-3 节流：10 分钟内的第二次调用 skipped='throttled'（不空转）；
//       A3X-4 失败可见：导出失败必须打日志（含 failureCode / complete），不许 catch {} 静默；
//       A3X-5 无 prune：整个模块里**没有**任何 prune 调用（本轮明确不启用删除）。
//
// 全部在 harness 的临时目录里跑，不碰仓库 state/，不发 QQ、不连 DSH。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import * as auditJsonl from '../src/core/qzone-audit-jsonl-offline.mjs';
import * as storeMod from '../src/core/qzone-store-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';

const DISABLED = { backgroundPatrol: { enabled: false }, ownerNotice: { enabled: false } };

/** 在 harness 的临时 state 目录里建一份插件库（与生产同名同形），可选塞入审计行。 */
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
  if (Array.isArray(rows) && rows.length > 0) {
    handle.update((state) => ({ ...state, audit: rows }));
  }
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

test('A3X-1 正常路径：真写出 N 行、complete、首次创建留痕', async () => {
  await withHarness(async (h) => {
    const now = Date.now();
    seedPluginDb(h.temp, [auditRow('1', now), auditRow('2', now), auditRow('3', now)]);
    assert.equal(fs.existsSync(auditRoot(h)), false, '起点：目录必须还不存在（本机从未导出过）');
    h.context.__qzoneAuditExportResetClock();
    const result = h.context.__qzoneAuditExportPass();
    assert.equal(result.ran, true, `本轮必须真跑：${JSON.stringify(result)}`);
    assert.equal(result.report.exported, 3, `必须写出 3 行：${JSON.stringify(result.report)}`);
    assert.equal(result.report.complete, 'complete', 'complete 必须来自导出器的真实判定');
    assert.equal(result.report.failed, false);
    assert.equal(fs.existsSync(auditRoot(h)), true, '目录必须被创建');
    const files = fs.readdirSync(auditRoot(h));
    assert.equal(files.length, 1, `只应有一份当日文件：${JSON.stringify(files)}`);
    const lines = fs.readFileSync(path.join(auditRoot(h), files[0]), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 3, '磁盘行数必须等于导出行数');
    const ids = new Set(lines.map((line) => JSON.parse(line).auditId));
    assert.equal(ids.size, 3, 'auditId 必须唯一');
    assert.ok([...ids].every((id) => id.startsWith('plugin:')), `namespace 必须是 plugin：${[...ids]}`);
    const text = bridgeLog(h);
    assert.match(text, /QQ 空间审计导出：首次创建 state\/qzone-audit 并写入 3 行/, '首次创建必须留痕');
  });
});

test('A3X-2 串行守卫：上一轮未完成时本轮跳过，且一个字节都不写', async () => {
  await withHarness(async (h) => {
    const now = Date.now();
    seedPluginDb(h.temp, [auditRow('4', now)]);
    h.context.__qzoneAuditExportResetClock();
    // 构造「上一轮仍在跑」：用产品代码暴露的接缝置位，不伪造内部变量名。
    h.context.__qzoneAuditExportForceInFlight(true);
    assert.equal(h.context.__qzoneAuditExportProbe().inFlight, true);
    const blocked = h.context.__qzoneAuditExportPass();
    assert.equal(blocked.skipped, 'in-flight', `必须是 in-flight 跳过：${JSON.stringify(blocked)}`);
    assert.equal(blocked.ran, undefined, '跳过时不得报告 ran');
    assert.equal(fs.existsSync(auditRoot(h)), false, '跳过的一轮不得创建目录/写文件');
    // 清掉守卫后同一轮数据仍能正常导出 —— 证明刚才的跳过不是「坏了」。
    h.context.__qzoneAuditExportForceInFlight(false);
    const after = h.context.__qzoneAuditExportPass();
    assert.equal(after.report?.exported, 1, `解除守卫后必须照常导出：${JSON.stringify(after)}`);
  });
});

test('A3X-3 节流：10 分钟内的第二次调用跳过（不空转），重置后能再跑', async () => {
  await withHarness(async (h) => {
    const now = Date.now();
    seedPluginDb(h.temp, [auditRow('5', now)]);
    h.context.__qzoneAuditExportResetClock();
    const first = h.context.__qzoneAuditExportPass();
    assert.equal(first.report?.exported, 1);
    const second = h.context.__qzoneAuditExportPass();
    assert.equal(second.skipped, 'throttled', `第二次必须被节流：${JSON.stringify(second)}`);
    const probe = h.context.__qzoneAuditExportProbe();
    assert.ok(probe.intervalMs >= 60_000, `节流窗口必须 ≥1 分钟（实测 ${probe.intervalMs}）`);
    assert.ok(probe.lastAt > 0, '真正开跑的一轮必须打点');
    h.context.__qzoneAuditExportResetClock();
    const third = h.context.__qzoneAuditExportPass();
    assert.equal(third.report?.exported, 0, '重置后可以再跑，但没有新行');
    assert.equal(third.report?.alreadyPresent, 1, '已有行必须被识别为已存在（幂等）');
  });
});

test('A3X-4 失败可见：导出失败必须打日志，含 failureCode 与 complete，不得静默', async () => {
  await withHarness(async (h) => {
    // 造一个「有插件库、但 audit 不是数组」的坏库：导出器会把它报成 failed，而不是当空数组。
    const pluginPath = path.join(h.temp, 'state', 'qzone-plugin-state.sqlite');
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
    handle.update((state) => ({ ...state, audit: 'not-an-array' }));
    handle.close();
    h.context.__qzoneAuditExportResetClock();
    const result = h.context.__qzoneAuditExportPass();
    assert.equal(result.report?.failed, true, `坏库必须判 failed：${JSON.stringify(result.report)}`);
    assert.equal(result.report?.complete, 'unknown', '读不出快照时 complete 必须是 unknown，不能是 complete');
    const text = bridgeLog(h);
    assert.match(text, /QQ 空间审计导出失败：/, '失败必须留下日志行');
    assert.match(text, /failureCode=/, '失败日志必须带 failureCode');
    assert.match(text, /complete=unknown/, '失败日志必须带 complete 判定');
    assert.equal(fs.existsSync(auditRoot(h)), false, '失败的导出不得创建目录');
  });
});

test('A3X-5 prune 的接线面：只允许文件侧 prune()，数据库侧 pruneOfflineAudit 必须为 0', async () => {
  const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  // 第二步（本轮之前）这条断言是「bridge.js 里根本没有 .prune(」。第三步起**文件侧**必须真的接上，
  // 所以断言改成方向性的一条：允许 `jsonl.prune()`，但**只允许**这一个调用点。
  // 钉「只有一个」而不是「至少一个」：多出来的第二个调用点意味着有第二个人在删审计证据，
  // 而「谁负责删」必须还是唯一的 —— 这与导出的「唯一写入方」是同一条纪律。
  const filePrune = source.match(/\bjsonl\.prune\s*\(/g) ?? [];
  assert.equal(filePrune.length, 1, `文件侧 prune 必须恰好一个调用点（实测 ${filePrune.length}）`);
  // 只钉**调用点**（带括号），不钉注释里提到的名字：注释里正好要说明「数据库侧 prune 故意不接」，
  // 用裸标识符匹配会把一句正确的说明判成违规。
  assert.equal(/pruneOfflineAudit\s*\(/.test(source), false,
    'bridge.js 不得调用数据库侧 prune：state.audit 是权威源，删它不可逆（见 runQzoneAuditRetentionPass 注释）');
  // 上面那条是「没调用」。这里再钉「连 import 都没有」—— 否则以后有人把调用挪进一个新函数，
  // 名字换成别的拼写，只查调用点就会漏。
  assert.equal(/qzone-audit-offline\.mjs/.test(source), false,
    'bridge.js 不得 import qzone-audit-offline.mjs：那是权威源行清理模块，本 tick 一律不碰');
  assert.match(source, /createAuditExporter\(/, '必须真的接上导出器');
  assert.match(source, /namespace: QZONE_AUDIT_EXPORT_NAMESPACE/, 'namespace 必须是显式的常量，不能内联散落');
});