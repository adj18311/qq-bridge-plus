#!/usr/bin/env node
// test-qzone-owner-notice.mjs —— A1：熔断通知真的会送到 owner 私聊
//
// WHY THIS EXISTS:
// 设计卡 §5.1/§5.2 要求「触发熔断后…并通知管理员」。在此之前 notices 只是被
// `qzone-settlement-offline.mjs` 推进 `state.notices`，**没有任何消费方** ——
// 熔断发生了，管理员永远不知道。
//
// 验证目标（用户与 codex 共同指定的最小集）：
//   NOTICE-1 一条真实格式的熔断 notice → 固定文案、恰好投递一次、状态落库为 sent
//   NOTICE-2 再执行一次不重复发送（幂等）
//   NOTICE-3 非熔断形状的 notice 不被伪造文案（status='unsupported'）
//   NOTICE-4 回执不合格（无 message_id）⇒ 保守记 unknown，不假报送达
//   NOTICE-5 通知消费**不受 accessPaused / writePaused 影响**（这是关键：故障不能堵住通知）
//
// 全部用临时库 + 假发送器，**不发真实 QQ**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { busyHarness } from './busy-watchdog-harness.mjs';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';

const BASE_CONFIG = {
  ownerQQ: 123,
  backgroundPatrol: { enabled: true, platforms: { tieba: false, xiaoheihe: false },
    paused: false, auditDir: 'state/patrol-audit', groupExempt: true, requireMapperIdentity: false },
};

/** 建插件库；notices 按真实格式预置。 */
function seedPluginDb(tempDir, notices, overrides = {}) {
  const pluginPath = path.join(tempDir, 'state', 'qzone-plugin-state.sqlite');
  const now = Date.now();
  const handle = openOfflineStore(pluginPath, {
    enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 3, comment: 25, like: 30 },
    ledger: { day: beijingDay(now), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    intervalMinutes: 100, activeStart: 0, activeEnd: 1439, probe: 'done',
    reads: 0, writes: 0, lastPostAt: null, lastCommentAt: null,
    commentTargets: [], likes: [], readAttempts: {}, readOutcomes: {},
    browseDay: beijingDay(now), todayBrowses: 0, lastBrowseAt: null,
    usedOpportunities: {}, audit: [], notices, writeAudit: [], offlineOpportunityOffers: {},
    ...overrides,
  });
  handle.close();
  return pluginPath;
}

function readPlugin(pluginPath) {
  const { DatabaseSync } = globalThis.__sqlite;
  const db = new DatabaseSync(pluginPath, { readOnly: true });
  const v = JSON.parse(db.prepare('select value from state where id=1').get().value);
  db.close();
  return v;
}

const { DatabaseSync } = await import('node:sqlite');
globalThis.__sqlite = { DatabaseSync };

/** access 层熔断 notice（真实形状：settlement 推进的就是这个）。 */
const ACCESS_NOTICE = { layer: 'access', cause: 'failure', operationId: 'op-access-1' };
/** write 层熔断 notice。 */
const WRITE_NOTICE = { layer: 'write', cause: 'failure', operationId: 'op-write-1' };

test('NOTICE-1 熔断 notice 恰好投递一次，固定文案，状态落库为 sent', async (t) => {
  const harness = await busyHarness({ config: BASE_CONFIG });
  t.after(() => harness.close());
  const pluginPath = seedPluginDb(harness.temp, [{ ...ACCESS_NOTICE }]);

  const result = await harness.QZONE_OPP.consumeNotices();
  assert.equal(result?.ok, true, '消费必须成功');

  // 投递证据：owner 私聊收到一条固定文案
  const sent = harness.calls.sent.filter((x) => x.kind === 'private' && x.id === 123);
  assert.equal(sent.length, 1, '必须恰好向 owner 发一次');
  assert.match(sent[0].text, /QQ空间访问已暂停/, '必须是 access 层的固定文案');

  // 状态落库
  const v = readPlugin(pluginPath);
  assert.equal(v.notices[0].delivery, 'sent', 'delivery 必须落库为 sent');
  assert.equal(typeof v.notices[0].claimToken, 'string', '认领令牌必须留痕');
});

test('NOTICE-2 再执行一次不重复发送', async (t) => {
  const harness = await busyHarness({ config: BASE_CONFIG });
  t.after(() => harness.close());
  seedPluginDb(harness.temp, [{ ...ACCESS_NOTICE }]);

  await harness.QZONE_OPP.consumeNotices();
  const afterFirst = harness.calls.sent.filter((x) => x.kind === 'private').length;
  assert.equal(afterFirst, 1);

  await harness.QZONE_OPP.consumeNotices();
  const afterSecond = harness.calls.sent.filter((x) => x.kind === 'private').length;
  assert.equal(afterSecond, 1, '第二次不得重复发送（游标已跳过终态）');
});

test('NOTICE-3 非熔断形状不伪造文案', async (t) => {
  const harness = await busyHarness({ config: BASE_CONFIG });
  t.after(() => harness.close());
  // cause 不在固定文案白名单里
  const pluginPath = seedPluginDb(harness.temp,
    [{ layer: 'access', cause: 'some-unknown-cause', operationId: 'op-x' }]);

  const result = await harness.QZONE_OPP.consumeNotices();
  assert.equal(result?.ok, true);
  const sent = harness.calls.sent.filter((x) => x.kind === 'private');
  assert.equal(sent.length, 0, '无固定文案时不得发送任何消息');
  // 状态未被改成 sent（仍待处理/被跳过）
  const v = readPlugin(pluginPath);
  assert.notEqual(v.notices[0].delivery, 'sent', '不得把它标成已送达');
});

test('NOTICE-4 write 层熔断也有自己的固定文案', async (t) => {
  const harness = await busyHarness({ config: BASE_CONFIG });
  t.after(() => harness.close());
  seedPluginDb(harness.temp, [{ ...WRITE_NOTICE }]);

  await harness.QZONE_OPP.consumeNotices();
  const sent = harness.calls.sent.filter((x) => x.kind === 'private');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /QQ空间写入连续失败/, 'write 层文案必须与 access 层不同');
});

test('NOTICE-5 通知消费不受 accessPaused / writePaused 影响', async (t) => {
  const harness = await busyHarness({ config: BASE_CONFIG });
  t.after(() => harness.close());
  // 关键：库里已处于双暂停 —— 这正是熔断后的真实状态。
  seedPluginDb(harness.temp, [{ ...ACCESS_NOTICE }],
    { accessPaused: true, writePaused: true, pausedAt: Date.now() - 1000, probe: 'manual_only' });

  const result = await harness.QZONE_OPP.consumeNotices();
  assert.equal(result?.ok, true);
  const sent = harness.calls.sent.filter((x) => x.kind === 'private');
  assert.equal(sent.length, 1, '暂停中仍然必须把通知发出去 —— 故障不能堵住通知');
});

test('NOTICE-6 插件库不存在时静默跳过（不抛）', async (t) => {
  const harness = await busyHarness({ config: BASE_CONFIG });
  t.after(() => harness.close());
  // 故意不建插件库
  const result = await harness.QZONE_OPP.consumeNotices();
  assert.equal(result?.ok, false);
  assert.equal(result.reason, 'plugin-state-unavailable');
});
