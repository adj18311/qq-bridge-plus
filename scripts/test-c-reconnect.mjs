// C-reconnect 家族聚焦测试（t19/t24；t59 从 scripts/test-busy-watchdog.mjs **原样搬出**）。
//
// 覆盖两条真实事故路径下「失效在途回合」的清理与恢复：
//   · 探活翻转（t19）：DSH 不可用 → 已就绪 是确定触发点，≤10s 内清掉失效回合 + 重排被暂存唤醒；
//     只清「经历这次断连」的回合（仍在出帧 / 断连后新开回合一律不动）；同一 (reason,seq) 不重复投递。
//   · 事件流真断过（F-R2/t24）：断流点快照必须活过 pumpMux 的 finally，重放帧点亮 ④ 后仍要 ≤10s 收敛。
//   · 开关语义（F-R1）：busyWatchdog.enabled=false ⇒ 重连清理是真正的空操作。
//
// 与 `scripts/test-busy-watchdog.mjs` 共用 `scripts/busy-watchdog-harness.mjs`（同一份 harness 与夹具）。
// 拆分只改位置：下面每条用例的断言语义、日志文案与 console 证据行都与原文件逐字一致。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  test, SCALED, withWatchdog, root, seedStaleCollector, feedFrames, startBreakableMux, count, sleep, waitFor, frameOf, completedTurn, finish,
} from './busy-watchdog-harness.mjs';

// ══ C-reconnect（t19）：DSH 重连成功 → 立即清理失效在途回合 ═════════════════════
// 用户实测事故：DSH 重启时 5 个会话正在回合中，turn/end 帧随重启丢失 → ④ 残留 → 新唤醒被
// 静默暂存 → 直到 15 分钟 releaseMs 兜底。这里把「DSH 不可用 → 已就绪」这个确定事件接上。
const dshDownDescribe = () => { const e = new Error('fixture: DSH 重启中（describe 失败）'); return e; };
const describeOkReserved2 = async () => ({ result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode: 'reserved2' } }] } } });

await test('C-reconnect-1：DSH 不可用→已就绪是确定触发点；≤10s 内清掉失效在途回合并重排被暂存唤醒', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.wakeConfig.batchWindowMs = 1000;
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  // 断连前：这个会话正在回合中（turn/start 已到，turn/end 永远不会来）
  seedStaleCollector(h, sid, 10, '断连前的回复');
  assert.equal(h.v2TurnStartAt.has(sid), true);
  assert.equal(h.collectors.has(sid), true);
  // 断连前：新唤醒因「④ 忙」被静默暂存（事故现场）
  await h.sendWakePromptV2(key, 'private');
  assert.match(h.readLog(), /会话繁忙，暂存唤醒原因 private:123/, '唤醒必须被静默暂存（事故现场）');
  assert.equal(st.pendingWakeReasons.length, 1);
  assert.equal(st.pendingWakeReasons[0].reason, 'private');
  assert.equal(st.pendingWakeReasons[0].seq, 197);
  // ① 断连：checkDsh 探活失败 → dshReady=false + 拍快照
  h.api.settings.describe = async () => { throw dshDownDescribe(); };
  await h.checkDsh();
  const logDown = h.readLog();
  assert.match(logDown, /⚠️ DSH 不可用（重启中？）/, '必须有明确的不可用触发点');
  assert.match(logDown, /\[reconnect\] DSH 不可用：记下 1 个在途回合/, '断连瞬间必须拍下在途回合快照');
  // ② 重连：探活恢复 → dshReady=true → 立刻安排清理（和缓期 2s）
  h.api.settings.describe = describeOkReserved2;
  const upAt = Date.now();
  await h.checkDsh();
  const logUp = h.readLog();
  assert.match(logUp, /DSH 已就绪（模式: reserved2）/, '必须有明确的重连成功触发点');
  const reconnectLines = (logUp.match(/[^\n]*reconnect[^\n]*/g) ?? []).join(' | ');
  assert.match(logUp, /♻️ \[reconnect\] DSH 恢复/, `重连成功必须打日志（触发点）；reconnect 行=${reconnectLines || '（无）'}`);
  // ③ 清理必须 ≤10s 内发生
  const cleanedLine = await waitFor(() => (h.readLog().match(/♻️ \[reconnect\] 重连清理[^\n]*/) ?? [])[0], 10000);
  const elapsed = Date.now() - upAt;
  assert.ok(cleanedLine, '重连后必须打出清理日志');
  assert.ok(elapsed <= 10000, `清理必须在 ≤10s 内发生，实测 ${elapsed}ms`);
  assert.match(cleanedLine, /失效在途回合 1 个、涉及会话 1 个、重排被暂存唤醒 1 个/, `清理日志必须给出计数：${cleanedLine}`);
  assert.equal(h.v2TurnStartAt.has(sid), false, '失效的 v2TurnStartAt 必须被清');
  assert.equal(h.collectors.has(sid), false, '失效的 collectors 必须被清');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sid), true, '必须留墓碑：迟到的 turn/end 静默排空');
  // ④ 被暂存的唤醒按正常投递路径重排并真的送达
  await waitFor(() => h.calls.prompts.length >= 1);
  assert.equal(h.calls.prompts.length, 1, '重排后必须走正常投递路径送达 1 次');
  console.log(`   [证据] 断连→重连清理用时=${elapsed}ms；失效回合=1、重排唤醒=1、送达=${h.calls.prompts.length} 次`);
});

await test('C-reconnect-2：只清「经历这次断连」的回合 —— 仍在出帧/断连后新开的回合不被误清', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  h.cfg.allow.private = ['123', '999'];              // 允许第三个会话跑来验证「未经历断连」分支
  const deadKey = 'private:123';
  const aliveKey = 'group:456';
  const newKey = 'private:999';
  const sidDead = await h.ensureSession(deadKey);
  const sidAlive = await h.ensureSession(aliveKey);
  const sidNew = await h.ensureSession(newKey);
  seedStaleCollector(h, sidDead, 10, '随重启丢失的回合');
  seedStaleCollector(h, sidAlive, 11, '其实还活着的回合');
  seedStaleCollector(h, sidNew, 12, '断连后马上开了新回合的会话');
  h.api.settings.describe = async () => { throw dshDownDescribe(); };
  await h.checkDsh();
  assert.match(h.readLog(), /记下 3 个在途回合/, '断连时必须拍到 3 个在途回合');
  h.api.settings.describe = describeOkReserved2;
  await h.checkDsh();
  // 重连后：alive 会话仍在出帧（说明它的回合没丢）→ 绝不能清它
  await feedFrames(h, [frameOf(sidAlive, { type: 'assistant/message', data: { turn: 11, message: { content: [{ type: 'text', text: '还在写' }] } } })], 150);
  // 重连后：new 会话开了全新回合（turn/start 晚于断连时刻）→ 旧回合已被替换，也不算失效
  await feedFrames(h, [frameOf(sidNew, { type: 'turn/start', data: { turn: 20 } })], 150);
  const cleanedLine = await waitFor(() => (h.readLog().match(/♻️ \[reconnect\] 重连清理[^\n]*/) ?? [])[0], 10000);
  assert.ok(cleanedLine, '重连后必须打出清理日志');
  assert.match(cleanedLine, /失效在途回合 1 个/, `只有 dead 会话该被清：${cleanedLine}`);
  assert.equal(h.v2TurnStartAt.has(sidDead), false, '经历断连的失效回合必须被清');
  assert.equal(h.collectors.has(sidDead), false);
  assert.equal(h.v2TurnStartAt.has(sidAlive), true, '重连后仍在出帧的会话绝不能被误清');
  assert.equal(h.collectors.has(sidAlive), true, '仍在出帧的会话 collector 必须保留');
  assert.equal(h.v2TurnStartAt.has(sidNew), true, '断连后新开的回合不算失效');
  assert.equal(h.collectors.has(sidNew), true);
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sidAlive), false, '不能给活着的会话留墓碑（否则它的 turn/end 会被静默吞掉）');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sidNew), false);
  console.log(`   [证据] 失效回合=1（dead）；仍在出帧保留=1（alive）；新回合保留=1（new）；${(cleanedLine.match(/其中 [^）]*/) ?? [''])[0]}`);
});

await test('C-reconnect-3：重连重排后同一 (reason,seq) 不会被投递两次（迟到 turn/end 无副作用）', withWatchdog(SCALED), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.wakeConfig.batchWindowMs = 1000;
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  seedStaleCollector(h, sid, 10, '断连前的回复');
  await h.sendWakePromptV2(key, 'private');            // 被暂存
  h.api.settings.describe = async () => { throw dshDownDescribe(); };
  await h.checkDsh();
  h.api.settings.describe = describeOkReserved2;
  await h.checkDsh();
  await waitFor(() => /♻️ \[reconnect\] 重连清理/.test(h.readLog()), 10000);
  await waitFor(() => h.calls.prompts.length >= 1);
  assert.equal(h.calls.prompts.length, 1, '重排只投递一次');
  // 重启前那个回合的 turn/end（本会永远丢失的那帧）迟到到达 → 不得产生任何副作用：
  // 不发 QQ、不补发同一条 (reason,seq)（墓碑 + 已重排的标记共同保证不重复投递）
  const sentBefore = h.calls.sent.length;
  h.wakeConfigUpdatedKeys.add(key);
  await feedFrames(h, [frameOf(sid, { type: 'turn/end', data: { turn: 10, reason: { kind: 'completed' } } })], 400);
  await sleep(400);
  const log = h.readLog();
  assert.equal(h.calls.sent.length, sentBefore, '迟到 turn/end 不得发出任何 QQ 消息');
  assert.equal(count(log, /\[reserved2\] 计划唤醒 private:123（private）/g), 1, '同一 (reason,seq) 不得被再次排程');
  assert.equal(h.calls.prompts.length, 1, '送达次数仍为 1（不重复投递）');
  // 墓碑不得吞掉重启后的真回合：新的 live turn/start 会作废它，回合并正常结束、会话回到不忙
  await feedFrames(h, completedTurn(sid, 30, '重启后的正常回复'), 400);
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sid), false, '新的 live turn/start 必须作废墓碑');
  assert.equal(h.v2TurnStartAt.has(sid), false, '新回合结束后不得残留 v2TurnStartAt');
  assert.equal(h.collectors.has(sid), false, '新回合结束后不得残留 collectors');
  assert.equal(h.isConversationBusyV2(key, st), false, '会话必须回到不忙（重启后不再哑火）');
  console.log(`   [证据] 重连重排 1 次；迟到 turn/end 无副作用（不发 QQ、不再排程）；送达=${h.calls.prompts.length} 次；新回合正常结束且会话不再忙`);
});

// ══ F-R1：重连清理必须与看门狗同一个开关（enabled=false ⇒ 真正空操作）═════════
await test('C-reconnect-4（F-R1）：busyWatchdog.enabled=false 时重连清理是真正的空操作', withWatchdog({ ...SCALED, enabled: false }), async (h) => {
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  st.wakeConfig.batchWindowMs = 1000;
  st.unread = [{ seq: 197, text: '在吗' }];
  st.lastUnreadSeq = 197;
  seedStaleCollector(h, sid, 10, '断连前的回复');
  await h.sendWakePromptV2(key, 'private');                 // 断连前被暂存（与事故同路径）
  h.api.settings.describe = async () => { throw dshDownDescribe(); };
  await h.checkDsh();
  assert.match(h.readLog(), /记下 1 个在途回合/, '断连快照本身仍会拍（开关只约束「清理」这一步）');
  h.api.settings.describe = describeOkReserved2;
  await h.checkDsh();
  await sleep(2400);                                        // 越过 2s 和缓期
  const log = h.readLog();
  assert.equal(count(log, /\[reconnect\] DSH 恢复/g), 0, 'enabled=false 下不得产生恢复日志');
  assert.equal(count(log, /\[reconnect\] 重连清理/g), 0, 'enabled=false 下不得产生清理日志');
  assert.equal(h.v2TurnStartAt.has(sid), true, 'enabled=false 下不得清 v2TurnStartAt（回到上游行为）');
  assert.equal(h.collectors.has(sid), true, 'enabled=false 下不得清 collectors');
  assert.equal(h.busyWatchdog.staleBusyTurns.has(sid), false, 'enabled=false 下不得打墓碑');
  assert.equal(h.calls.prompts.length, 0, 'enabled=false 下不得重排唤醒');
  assert.equal(h.busyWatchdog.dshDownTurnsV2, null, '断连快照必须按一次性消费语义丢弃');
  // 之后再把开关打开：不得补做这次（已丢弃快照的）清理
  h.cfg.socialV2.busyWatchdog = { ...SCALED, enabled: true };
  h.handleDshReconnectV2();
  await sleep(300);
  assert.equal(count(h.readLog(), /\[reconnect\] 重连清理/g), 0, '重新打开开关后不得补做清理');
  assert.equal(h.v2TurnStartAt.has(sid), true, '④ 仍不得被清');
  console.log('   [证据] enabled=false：恢复/清理日志=0、④/墓碑/唤醒均未动、快照已一次性丢弃且重开开关不补做');
});

// ══ F-R2（t24）：真实传输路径 —— mux 断流 → 重试 → 重连 → 重放点亮 ④ ═════════════
// t20 的 C-reconnect-1/2/3 只走「探活翻转」这一条路（事件流全程不断），漏掉了事故的真实形态：
// pumpMux 的 finally 先清 ④（旧实现还把探活时拍的快照一起抹成 null）→ 重连时无账可对、直接
// return 0；而重连后 DSH 重放那个失效回合的帧又会把 ④ 重新点亮 → 照旧哑火到 releaseMs(900s)。
// 本用例复现「断流 → 重试 → 成功重连 → 重放点亮 ④」，断言 ≤10s 收敛。
await test('C-reconnect-5（F-R2）：断流点快照活过 finally + 重放点亮 ④ 仍在 ≤10s 内收敛', withWatchdog(SCALED), async (h) => {
  // ① 静态守门：生产默认值与结构不许被 harness 的缩放掩盖
  const source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  assert.match(source, /let reconnectRecheckPlanV2 = \[[\s\S]{0,120}delayMs: 8000, quietMs: 4000[\s\S]{0,120}delayMs: 30000, quietMs: 8000/,
    '有界复核的生产默认值必须是有界的两档（8s/4s、30s/8s）');
  assert.match(source, /RECONNECT_SNAPSHOT_TTL_MS = 300000/, '快照必须 >5 分钟自动丢弃');
  assert.match(source, /clearBusyWatchdogRuntimeV2\(\{ keepDshDownSnapshot: true \}\)/, '断流路径必须显式保住断流点快照');
  const pumpMuxBody = source.slice(source.indexOf('async function pumpMux()'), source.indexOf('const bot = new SnowLumaWebSocketClient'));
  const iSnapCall = pumpMuxBody.indexOf("snapshotDshDownInFlightTurnsV2(Date.now(), 'mux')");
  const iClear = pumpMuxBody.indexOf('collectors.clear(); // 清除旧 turn collector');
  assert.ok(iSnapCall > 0 && iClear > iSnapCall, '断流点快照必须排在清 ④ 之前（否则快照永远是空的）');
  // ② 槽位语义：默认作废（模式切换/暂停/重置），只有断流路径带 keep 开关
  const probe = { at: Date.now(), turns: new Map([['probe-sid', 1]]), turnNos: new Map() };
  h.busyWatchdog.dshDownTurnsV2 = probe;
  h.clearBusyWatchdogRuntimeV2();
  assert.equal(h.busyWatchdog.dshDownTurnsV2, null, '模式切换/暂停/重置路径必须作废快照');
  h.busyWatchdog.dshDownTurnsV2 = probe;
  h.clearBusyWatchdogRuntimeV2({ keepDshDownSnapshot: true });
  assert.equal(h.busyWatchdog.dshDownTurnsV2, probe, '断流路径必须保住快照');
  h.busyWatchdog.dshDownTurnsV2 = null;
  h.setReconnectRecheckPlanV2([{ delayMs: 3000, quietMs: 600 }]);   // 时间轴缩放：复核落在 pass-1（2s）之后、≤10s 之内
  // ③ 四个会话断流前都在回合中，新唤醒全部被静默暂存
  h.setMode('reserved2');
  h.cfg.allow.private = ['123', '999'];
  h.cfg.allow.groups = ['456', '987'];
  const keyA = 'private:123';   // 断流时在途；重放帧在**重连之前**到
  const keyB = 'group:456';     // 断流时在途；重放帧在**重连之后**到
  const keyC = 'private:999';   // 断流时在途；重连后真开了新回合（回合号不同）
  const keyD = 'group:987';     // 断流时在途；重连后持续出帧
  const sidA = await h.ensureSession(keyA);
  const sidB = await h.ensureSession(keyB);
  const sidC = await h.ensureSession(keyC);
  const sidD = await h.ensureSession(keyD);
  for (const [key, seq] of [[keyA, 197], [keyB, 205], [keyC, 211], [keyD, 213]]) {
    const st = h.getSocialV2State(key);
    st.unread = [{ seq, text: '在吗' }];
    st.lastUnreadSeq = seq;
    st.wakeConfig.batchWindowMs = 1000;
  }
  const feed = startBreakableMux(h);
  feed.push([
    frameOf(sidA, { type: 'turn/start', data: { turn: 10 } }),
    frameOf(sidB, { type: 'turn/start', data: { turn: 11 } }),
    frameOf(sidC, { type: 'turn/start', data: { turn: 12 } }),
    frameOf(sidD, { type: 'turn/start', data: { turn: 13 } }),
  ]);
  assert.ok(await waitFor(() => h.v2TurnStartAt.size === 4, 3000), '四个会话必须由真实 mux 帧建立起 ④');
  for (const key of [keyA, keyB, keyC, keyD]) {
    await h.sendWakePromptV2(key, 'private');
    assert.equal(h.getSocialV2State(key).pendingWakeReasons.length, 1, `${key} 的唤醒必须被静默暂存（事故现场）`);
  }
  // ④ 断流：事件流真的抛错 → finally 拍快照 + 清 ④；快照必须活下来（F-R2 的核心）
  feed.breakStream();
  const downLine = await waitFor(() => (h.readLog().match(/⚠️ \[reconnect\] 事件流断开：记下 [^\n]*/) ?? [])[0], 5000);
  assert.ok(downLine, '断流点必须拍下快照并打日志');
  assert.match(downLine, /记下 4 个在途回合/, `断流点快照必须含 4 个在途回合：${downLine}`);
  assert.equal(h.busyWatchdog.dshDownTurnsV2?.turns.size, 4,
    '断流快照必须活过 pumpMux finally 里的 clearBusyWatchdogRuntimeV2（旧实现在这里被抹成 null）');
  assert.equal(h.v2TurnStartAt.size, 0, 'finally 仍然照旧清掉 ④');
  assert.equal(h.collectors.size, 0, 'finally 仍然照旧清掉 collectors');
  // ⑤ 探活也失败（同一次断连的第二个观测点）：不许把断流点拍到的非空快照覆盖成空
  h.api.settings.describe = async () => { throw dshDownDescribe(); };
  await h.checkDsh();
  assert.equal(h.busyWatchdog.dshDownTurnsV2?.turns.size, 4, '探活失败必须与断流点合并，不得覆盖成空');
  // ⑥ 重试 → 重连出新的流；重放帧把 ④ 重新点亮（这正是 F-R2 的现场）
  assert.ok(await waitFor(() => feed.segments() >= 2, 8000), 'pumpMux 必须自己重连出新的一段事件流');
  feed.push([
    frameOf(sidA, { type: 'turn/start', data: { turn: 10 } }),
    frameOf(sidA, { type: 'assistant/message', data: { turn: 10, message: { content: [{ type: 'text', text: '重放：断流前那半句（A）' }] } } }),
  ]);
  await sleep(250);
  assert.equal(h.v2TurnStartAt.has(sidA), true, '重放帧必须把 ④ 重新点亮');
  // ⑦ 重连成功：探活恢复 → handleDshReconnectV2
  h.api.settings.describe = describeOkReserved2;
  const upAt = Date.now();
  await h.checkDsh();
  assert.match(h.readLog(), /♻️ \[reconnect\] DSH 恢复：2000ms 后清理 4 个在途回合/, '重连必须安排清理 4 个在途回合');
  // 重连之后才到的重放（B）＋ 断连后真开的新回合（C）＋ 持续出帧的活回合（D）
  feed.push([
    frameOf(sidB, { type: 'turn/start', data: { turn: 11 } }),
    frameOf(sidB, { type: 'assistant/message', data: { turn: 11, message: { content: [{ type: 'text', text: '重放：重连之后才到（B）' }] } } }),
  ]);
  feed.push([frameOf(sidC, { type: 'turn/start', data: { turn: 20 } })]);
  // D 的回合号与快照相同（看起来像「重放」）但它**一直在出帧** ⇒ 判据③/静默复核都必须放过它
  feed.push([frameOf(sidD, { type: 'turn/start', data: { turn: 13 } })]);
  const keepD = setInterval(() => feed.push([
    frameOf(sidD, { type: 'assistant/message', data: { turn: 13, message: { content: [{ type: 'text', text: '还在写（D）' }] } } }),
  ]), 200);
  try {
    // ⑧ pass-1（和缓期 2s）：只清「重放帧早于重连」的 A
    const cleanupLine = await waitFor(() => (h.readLog().match(/♻️ \[reconnect\] 重连清理[^\n]*/) ?? [])[0], 10000);
    const passOneMs = Date.now() - upAt;
    assert.ok(cleanupLine, 'pass-1 必须打出清理日志');
    assert.ok(passOneMs <= 10000, `pass-1 必须在 ≤10s 内发生，实测 ${passOneMs}ms`);
    assert.match(cleanupLine, /失效在途回合 1 个、涉及会话 1 个、重排被暂存唤醒 1 个/, `pass-1 只该清 A：${cleanupLine}`);
    assert.equal(h.v2TurnStartAt.has(sidA), false, 'A 的 ④ 必须被清');
    assert.equal(h.collectors.has(sidA), false, 'A 的 collectors 必须被清');
    assert.equal(h.busyWatchdog.staleBusyTurns.has(sidA), true, 'A 必须留墓碑');
    assert.equal(h.v2TurnStartAt.has(sidB), true, 'B 的重放帧晚于重连 ⇒ pass-1 的判据③ 不碰它');
    // ⑨ 有界复核：清 B（重放突发帧不算「活着」的证据），仍然 ≤10s
    const recheckLine = await waitFor(() => (h.readLog().match(/♻️ \[reconnect\] 重连复核[^\n]*/) ?? [])[0], 10000);
    const recheckMs = Date.now() - upAt;
    assert.ok(recheckLine, '重放帧晚到时必须有界复核兜底');
    assert.ok(recheckMs <= 10000, `复核必须在 ≤10s 内发生，实测 ${recheckMs}ms`);
    assert.match(recheckLine, /失效在途回合 1 个、涉及会话 1 个、重排被暂存唤醒 1 个/, `复核只该清 B：${recheckLine}`);
    assert.equal(h.v2TurnStartAt.has(sidB), false, 'B 被重放点亮的 ④ 必须被复核清掉');
    assert.equal(h.busyWatchdog.staleBusyTurns.has(sidB), true, 'B 必须留墓碑');
    // ⑩ 反例对照：C（回合号 20 ≠ 12：断连后真开的新回合）与 D（一直在出帧）谁都不许碰
    assert.equal(h.v2TurnStartAt.has(sidC), true, '断连后真开的新回合绝不能被清（判据② 用回合号识别重放）');
    assert.equal(h.collectors.has(sidC), true, 'C 的 collector 必须保留');
    assert.equal(h.busyWatchdog.staleBusyTurns.has(sidC), false, 'C 不得留墓碑');
    assert.equal(h.v2TurnStartAt.has(sidD), true, '持续出帧的活回合绝不能被清');
    assert.equal(h.collectors.has(sidD), true, 'D 的 collector 必须保留');
    assert.equal(h.busyWatchdog.staleBusyTurns.has(sidD), false, 'D 不得留墓碑');
    // ⑪ 被暂存的唤醒按正常投递路径补发：A/B 各 1 次；仍忙的 C/D 原样留在 backlog
    const promptsTo = (sid) => h.calls.prompts.filter((p) => p.sessionId === sid).length;
    assert.ok(await waitFor(() => promptsTo(sidA) >= 1 && promptsTo(sidB) >= 1, 6000), 'A/B 的暂存唤醒都必须补发');
    assert.equal(promptsTo(sidA), 1, 'A 恰好投递 1 次');
    assert.equal(promptsTo(sidB), 1, 'B 恰好投递 1 次');
    assert.equal(promptsTo(sidC), 0, 'C 仍忙 ⇒ 不得抢投');
    assert.equal(promptsTo(sidD), 0, 'D 仍忙 ⇒ 不得抢投');
    assert.equal(h.getSocialV2State(keyC).pendingWakeReasons.length, 1, 'C 的 backlog 必须原样保留');
    assert.equal(h.getSocialV2State(keyD).pendingWakeReasons.length, 1, 'D 的 backlog 必须原样保留');
    console.log(`   [证据] 断流点快照=4（活过 finally）；pass-1 用时=${passOneMs}ms 清 A；复核用时=${recheckMs}ms 清 B；`
      + '新回合 C 与活回合 D 均未被误清；补发 A/B 各 1 次；backlog 保留 C/D=1');
  } finally {
    clearInterval(keepD);
  }
});

finish({ title: 'C-reconnect 家族聚焦测试', failTitle: 'C-reconnect 测试' });
