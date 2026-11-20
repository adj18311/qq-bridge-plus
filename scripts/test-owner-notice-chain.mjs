// 离线全链：生产者（插件）→ 收件箱 → 发件箱 → 发送 → 回执 → 插件读取回执记账。
// 全程用假时钟与临时目录，不联网、不发 QQ、不碰正式 profile/state。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as decision from '../src/core/xhh-tool-surface-decision.mjs';
import { createOwnerNoticeBridgeWiring } from '../src/core/owner-notice-bridge-wiring.mjs';
import { createToolSurfaceWatcher } from '../plugins/dsh-xhh-tool-watcher/index.mjs';
import { createInboxProducer } from '../plugins/dsh-xhh-tool-watcher/inbox-producer.mjs';
import { createReceiptReader } from '../plugins/dsh-xhh-tool-watcher/receipt-reader.mjs';

const MIN = 60_000;
const T0 = 1793360000000;
// 12 个预期工具名（裸名）；watcher 的 readToolNames 要求带 MCP 前缀，交由 observe() 剥掉。
const BARE_TOOLS = decision.classifyToolSurface({ observedNames: [] }).missing;
const PREFIX = 'mcp__xiaoheihe__';
const ALL_TOOLS = BARE_TOOLS.map((name) => PREFIX + name);

async function tempEnv() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-notice-chain-'));
  const inboxDir = path.join(dir, 'inbox');
  const stateFile = path.join(dir, 'state', 'outbox.json');
  await fs.mkdir(inboxDir, { recursive: true });
  return { dir, inboxDir, stateFile };
}

/**
 * 搭一条真实的离线链：watcher（含 producer/receipt reader）+ 真 outbox + 真 wiring。
 * @param {object} options
 * @param {(text:string)=>Promise<object>} [options.send] 桥接侧发送器（假）
 */
async function createChain({ send } = {}) {
  const { dir, inboxDir, stateFile } = await tempEnv();
  const clock = { now: T0 };
  const sent = [];
  const logs = [];
  const sender = async (text) => {
    sent.push(text);
    if (typeof send === 'function') return send(text);
    return { outcome: 'delivered', messageId: 880000 + sent.length };
  };

  // 生产装配形态：不注入 outbox，由 wiring 自己建（内部用 createProvenDeliverySender 收口 messageId）。
  // 这一点很关键 —— 注入裸 outbox 会让「声称 delivered 但没有 messageId」直接算送达。
  const wiring = createOwnerNoticeBridgeWiring({
    inboxDir,
    stateFile,
    sendOwnerPrivateWithReceipt: sender,
    fs,
    clock: () => clock.now,
    log: (line) => { logs.push(String(line)); },
    // 链里审计时钟是假的（与真实 mtime 不同源，年龄恒为负），年龄闸单独在「真实闸」用例里测。
    minFileAgeMs: 0,
  });
  const producer = createInboxProducer({ inboxDir, clock: () => clock.now, fs });

  let watcherRef = null;
  const receiptReader = createReceiptReader({
    inboxDir,
    decision,
    getState: () => watcherRef.getState(),
    setState: (next) => { watcherRef.setState(next); },
    clock: () => clock.now,
    fs,
  });

  let observed = [...ALL_TOOLS]; // 带前缀，模拟真实 ctx.tools 视图
  const watcher = createToolSurfaceWatcher({
    readToolNames: () => [...observed],
    decision,
    now: () => clock.now,
    store: null,
    producer,
    receiptReader,
    config: { intervalMs: MIN },
  });
  watcherRef = watcher;

  return {
    dir,
    inboxDir,
    stateFile,
    clock,
    sent,
    wiring,
    logs,
    producer,
    watcher,
    setObserved(names) { observed = [...names]; },
    async tick(at) { clock.now = at; return watcher.check({ source: 'scheduled' }); },
    async event(at) { clock.now = at; return watcher.check({ source: 'event' }); },
    async wireRun() { return wiring.runOnce(); },
    async readReceipts() { return watcher.pollReceipts(); },
    async inboxFiles() {
      try {
        return (await fs.readdir(inboxDir)).filter((n) => n.endsWith('.json')).sort();
      } catch { return []; }
    },
  };
}

test('全链：连续三次定时检查缺失 ⇒ 入队 ⇒ 送达 ⇒ 回执记账（6 小时门闸生效）', async () => {
  const chain = await createChain();
  chain.setObserved(ALL_TOOLS.slice(0, 9)); // 缺 3 个

  // 三次连续定时检查（每分钟一次）
  await chain.tick(T0 + 1 * MIN);
  await chain.tick(T0 + 2 * MIN);
  const third = await chain.tick(T0 + 3 * MIN);
  assert.equal(third.consecutiveMisses, 3);
  assert.equal(third.lastReason, 'missing-tools');
  assert.equal((await chain.inboxFiles()).length, 1, '第三次应写入一条收件箱条目');
  assert.equal(chain.sent.length, 0, '插件侧不得直接发送');

  // 桥接消费：发送 + 写回执
  const run = await chain.wireRun();
  assert.equal(run.report.delivered, 1);
  assert.equal(chain.sent.length, 1);

  // 插件读回执：delivered 才推进 lastAlertAt
  const polled = await chain.readReceipts();
  assert.equal(polled.applied, 1);
  const snap = chain.watcher.snapshot();
  assert.equal(snap.state.lastAlertAt, T0 + 3 * MIN);
  assert.equal(snap.lastAttemptOutcome, 'delivered');

  // 6 小时门闸：紧接着继续缺失，不应该再产生新的收件箱条目
  await chain.tick(T0 + 4 * MIN);
  await chain.tick(T0 + 5 * MIN);
  assert.equal((await chain.inboxFiles()).length, 0, '已送达后 6 小时内不得再入队');
  assert.equal(chain.sent.length, 1);
});

test('全链：短断线（桥接暂停一轮）⇒ 条目留在收件箱，恢复后仍能送达', async () => {
  const chain = await createChain();
  chain.setObserved(ALL_TOOLS.slice(0, 10));
  await chain.tick(T0 + MIN);
  await chain.tick(T0 + 2 * MIN);
  await chain.tick(T0 + 3 * MIN);
  assert.equal((await chain.inboxFiles()).length, 1);

  // 桥接"断线"：不 runOnce。再过一个周期，插件重试（unknown 未回执 ⇒ 15 分钟后才重试）
  await chain.tick(T0 + 4 * MIN);
  assert.equal((await chain.inboxFiles()).length, 1, '未拿到回执前不重复入队');

  await chain.wireRun();
  assert.equal(chain.sent.length, 1);
});

test('全链：长停机 3 小时 ⇒ 旧条目仍被接手并送达（不按年龄丢弃）', async () => {
  const chain = await createChain();
  chain.setObserved(ALL_TOOLS.slice(0, 11));
  await chain.tick(T0 + MIN);
  await chain.tick(T0 + 2 * MIN);
  await chain.tick(T0 + 3 * MIN);
  const files = await chain.inboxFiles();
  assert.equal(files.length, 1);

  // 桥接停机 3 小时
  chain.clock.now = T0 + 3 * 60 * MIN;
  const result = await chain.wireRun();
  assert.equal(result.ingested.accepted, 1, '3 小时前的条目不得被判 expired');
  assert.equal(chain.sent.length, 1);
});

test('全链：回执 unknown（发送器没有 message_id）⇒ 只推进重试时点，不推进 6 小时门闸', async () => {
  const chain = await createChain({ send: async () => ({ outcome: 'delivered' }) }); // 故意不带 messageId
  chain.setObserved(ALL_TOOLS.slice(0, 9));
  await chain.tick(T0 + MIN);
  await chain.tick(T0 + 2 * MIN);
  await chain.tick(T0 + 3 * MIN);

  const run = await chain.wireRun();
  assert.equal(run.report.unknown, 1);
  await chain.readReceipts();
  const snap = chain.watcher.snapshot();
  assert.equal(snap.state.lastAttemptOutcome, 'unknown');
  assert.equal(snap.state.lastAlertAt ?? 0, 0, 'unknown 不得当成送达（lastAlertAt 保持未设置）');

  // 15 分钟重试：逐分钟 tick（间隔必须 <2.5 分钟，否则判定模块按「断链」重置计数）。
  // 回执 at = T0+3min ⇒ 重试窗口在 T0+18min 打开。
  const before = (await chain.inboxFiles()).length;
  let retriedAt = null;
  for (let minute = 4; minute <= 22; minute += 1) {
    chain.setObserved(ALL_TOOLS.slice(0, 9));
    await chain.tick(T0 + minute * MIN);
    const now = (await chain.inboxFiles()).length;
    if (now > before && retriedAt === null) retriedAt = minute;
    if (minute < 18) {
      assert.equal(now, before, `第 ${minute} 分钟仍在 15 分钟节流窗口内，不得重试`);
    }
  }
  assert.equal(retriedAt, 18, '应在 15 分钟窗口一打开（第 18 分钟）就重试');
});

test('全链：恢复取消 —— 未送达的缺失提醒在工具恢复后被取消，之后不再发送', async () => {
  const chain = await createChain({ send: async () => ({ outcome: 'delivered' }) }); // unknown，事件留在待重试
  chain.setObserved(ALL_TOOLS.slice(0, 9));
  await chain.tick(T0 + MIN);
  await chain.tick(T0 + 2 * MIN);
  await chain.tick(T0 + 3 * MIN);
  await chain.wireRun(); // 发送但 unknown ⇒ 事件仍待重试
  assert.equal(chain.sent.length, 1);

  // 工具恢复：watcher 检测到 recovered 过渡 ⇒ 写恢复信号
  chain.setObserved(ALL_TOOLS);
  const recovered = await chain.tick(T0 + 4 * MIN);
  assert.equal(recovered.lastReason, 'recovered');
  const files = await chain.inboxFiles();
  assert.equal(files.length, 1, '应有一条恢复信号待处理');

  const cancel = await chain.wireRun();
  assert.equal(cancel.ingested.errors.length, 0);
  const snap = chain.wiring.snapshot();
  assert.equal(snap.cancelled, 1, '未送达的缺失提醒必须被取消');

  // 取消后：再跑很多轮都不应再发送
  const sentBefore = chain.sent.length;
  for (let i = 5; i <= 30; i += 1) {
    chain.setObserved(ALL_TOOLS);
    await chain.tick(T0 + i * MIN);
    await chain.wireRun();
    await chain.readReceipts();
  }
  assert.equal(chain.sent.length, sentBefore, '恢复之后不得再发缺失提醒');
});

test('全链：两侧时钟 —— 生产者时钟比桥接快 11 分钟，桥接按未来时间拒绝（方向保守）', async () => {
  const chain = await createChain();
  chain.setObserved(ALL_TOOLS.slice(0, 9));
  // 插件侧时钟超前 11 分钟
  chain.clock.now = T0 + 11 * MIN;
  await chain.tick(T0 + 11 * MIN);
  await chain.tick(T0 + 12 * MIN);
  await chain.tick(T0 + 13 * MIN);
  assert.equal((await chain.inboxFiles()).length, 1);

  // 桥接侧时钟仍是 T0 ⇒ 条目 createdAt 在未来 11 分钟，超过 ±10 分钟容差
  chain.clock.now = T0;
  const result = await chain.wireRun();
  assert.equal(result.ingested.accepted, 0);
  assert.equal(result.ingested.rejected[0].reason, 'created-in-future');
  assert.equal(chain.sent.length, 0, '未来时间的条目不得发送');
});
test('全链：进程停止 —— stop() 等在途、之后不再发送，重启后 6 小时门闸仍生效', async () => {
  const chain = await createChain();
  chain.setObserved(ALL_TOOLS.slice(0, 9));
  await chain.tick(T0 + MIN);
  await chain.tick(T0 + 2 * MIN);
  await chain.tick(T0 + 3 * MIN);

  // start() 后让定时器在途：用一个会挂住的发送器，验证 stop() 会等它完成
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowChain = await createChain({ send: async () => { await gate; return { outcome: 'delivered', messageId: 880201 }; } });
  slowChain.setObserved(ALL_TOOLS.slice(0, 9));
  await slowChain.tick(T0 + MIN);
  await slowChain.tick(T0 + 2 * MIN);
  await slowChain.tick(T0 + 3 * MIN);

  const started = slowChain.wiring.start();
  assert.equal(started.ok, true);
  const inFlight = slowChain.wireRun(); // 与定时器共享单飞 Promise
  const stopPromise = slowChain.wiring.stop();
  // 关键断言（复审 P2-2）：在途未结束时 stop() 必须仍在等，不能提前 resolve。
  const early = await Promise.race([
    stopPromise.then(() => 'resolved-early'),
    new Promise((resolve) => setImmediate(() => resolve('still-pending'))),
  ]);
  assert.equal(early, 'still-pending', 'stop() 必须等在途对账结束，否则「停止」是假的');
  release();
  await inFlight;
  const stopped = await stopPromise;
  assert.equal(stopped.ok, true);
  const afterStop = await slowChain.wireRun();
  assert.equal(afterStop.ok, false);
  assert.equal(afterStop.reason, 'stopped', 'stop 之后不得再对账（更不得发送）');

  // 重启：同一 stateFile 重建 wiring，已送达事件不得重发，6 小时门闸由插件状态承担（这里验证 outbox 侧不重发）
  const sentBefore = chain.sent.length;
  await chain.wireRun();
  assert.equal(chain.sent.length, sentBefore + 1, '首次送达');
  const restartWiring = createOwnerNoticeBridgeWiring({
    inboxDir: chain.inboxDir,
    stateFile: chain.stateFile,
    sendOwnerPrivateWithReceipt: async () => ({ outcome: 'delivered', messageId: 880202 }),
    fs,
    clock: () => chain.clock.now,
    log: () => {},
    minFileAgeMs: 0,
  });
  const again = await restartWiring.runOnce();
  assert.equal(again.report.attempted, 0, '已送达的事件在重启后不得重发');
  await restartWiring.stop();
});

test('全链：messageId 传递 —— 有 message_id 才 delivered；缺失时降级 unknown 并留日志', async () => {
  const okChain = await createChain({ send: async () => ({ outcome: 'delivered', messageId: 880203 }) });
  okChain.setObserved(ALL_TOOLS.slice(0, 9));
  await okChain.tick(T0 + MIN);
  await okChain.tick(T0 + 2 * MIN);
  await okChain.tick(T0 + 3 * MIN);
  const okRun = await okChain.wireRun();
  assert.equal(okRun.report.delivered, 1, '带 messageId 的送达必须计为 delivered');
  await okChain.readReceipts();
  assert.equal(okChain.watcher.snapshot().state.lastAlertAt, T0 + 3 * MIN);

  const badChain = await createChain({ send: async () => ({ outcome: 'delivered' }) });
  badChain.setObserved(ALL_TOOLS.slice(0, 9));
  await badChain.tick(T0 + MIN);
  await badChain.tick(T0 + 2 * MIN);
  await badChain.tick(T0 + 3 * MIN);
  const badRun = await badChain.wireRun();
  assert.equal(badRun.report.delivered, 0);
  assert.equal(badRun.report.unknown, 1);
  assert.equal(badChain.logs.some((line) => line.includes('没有可用的 message_id')), true, '必须留下机械护栏日志');
  await badChain.readReceipts();
  assert.equal(badChain.watcher.snapshot().state.lastAttemptOutcome, 'unknown');
  assert.equal(badChain.watcher.snapshot().state.lastAlertAt ?? 0, 0, 'unknown 不得当成送达');
});

test('全链：failed 回执 ⇒ 15 分钟后重试、绝不推进 6 小时门闸', async () => {
  const chain = await createChain({ send: async () => ({ outcome: 'failed', code: 'send-rejected' }) });
  chain.setObserved(ALL_TOOLS.slice(0, 9));
  await chain.tick(T0 + MIN);
  await chain.tick(T0 + 2 * MIN);
  await chain.tick(T0 + 3 * MIN);
  const run = await chain.wireRun();
  assert.equal(run.report.failed, 1);
  assert.equal(run.report.delivered, 0);

  await chain.readReceipts();
  const snap = chain.watcher.snapshot();
  assert.equal(snap.state.lastAttemptOutcome, 'failed');
  assert.equal(snap.state.lastAlertAt ?? 0, 0, 'failed 不得当成送达');

  const before = (await chain.inboxFiles()).length;
  let retriedAt = null;
  for (let minute = 4; minute <= 20; minute += 1) {
    chain.setObserved(ALL_TOOLS.slice(0, 9));
    await chain.tick(T0 + minute * MIN);
    const now = (await chain.inboxFiles()).length;
    if (now > before && retriedAt === null) retriedAt = minute;
    if (minute < 18) assert.equal(now, before, `第 ${minute} 分钟仍在重试窗口内`);
  }
  assert.equal(retriedAt, 18, 'failed 也必须在 15 分钟窗口打开时重试');
});

test('全链（真实闸）：刚写出的收件箱文件本轮跳过，超过 2 秒才消费', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-notice-age-'));
  const inboxDir = path.join(dir, 'inbox');
  const stateFile = path.join(dir, 'state', 'outbox.json');
  const realNow = Date.now();
  const producer = createInboxProducer({ inboxDir, clock: () => realNow, fs });
  const queued = await producer.notifyMissing({ missingCount: 3, consecutiveMisses: 3, lastSeenAt: realNow, at: realNow });
  assert.equal(typeof queued.noticeId, 'string');

  // 用真实时钟、默认年龄闸：文件刚写完，本轮必须跳过（且不隔离、不计数）
  const young = createOwnerNoticeBridgeWiring({
    inboxDir,
    stateFile,
    sendOwnerPrivateWithReceipt: async () => ({ outcome: 'delivered', messageId: 880204 }),
    fs,
    clock: () => Date.now(),
    log: () => {},
  });
  const first = await young.runOnce();
  assert.equal(first.ingested.accepted, 0, '刚写出的文件本轮不得被消费');
  assert.equal(first.report.attempted, 0);

  // 把时钟推过闸（+2.1 秒）后同一文件必须被消费
  const clock = { now: Date.now() + 2100 };
  const older = createOwnerNoticeBridgeWiring({
    inboxDir,
    stateFile,
    sendOwnerPrivateWithReceipt: async () => ({ outcome: 'delivered', messageId: 880205 }),
    fs,
    clock: () => clock.now,
    log: () => {},
  });
  const second = await older.runOnce();
  assert.equal(second.report.delivered, 1, '超过年龄闸后必须送达');
  await young.stop();
  await older.stop();
  await fs.rm(dir, { recursive: true, force: true });
});

test('全链（60 秒节奏，生产形状发送器）：45 分钟内共发送 3 次（第 3/18/33 分钟）、无同分钟重复，6 小时门闸不推进', async () => {
  // 生产形状：sendOwnerPrivateWithReceipt 命中 message_id 但**不返回** messageId
  const chain = await createChain({ send: async () => ({ outcome: 'delivered' }) });
  chain.setObserved(ALL_TOOLS.slice(0, 9));
  const sendMinutes = [];
  let lastCount = 0;
  for (let minute = 1; minute <= 45; minute += 1) {
    await chain.tick(T0 + minute * MIN);
    await chain.wireRun();
    await chain.readReceipts();
    if (chain.sent.length > lastCount) {
      sendMinutes.push(minute);
      lastCount = chain.sent.length;
    }
  }
  assert.equal(sendMinutes[0], 3, '连续三次缺失后才提醒');
  // 标题以前写「只发送 2 次」而实测是 3 次（复审指出断言没钉总数）。把总数也钉住。
  assert.deepEqual(sendMinutes, [3, 18, 33], `一共只应发送 3 次，实际 ${sendMinutes.join(',')}`);
  for (let i = 1; i < sendMinutes.length; i += 1) {
    assert.ok(sendMinutes[i] - sendMinutes[i - 1] >= 15, `相邻发送必须间隔 ≥15 分钟，实际 ${sendMinutes.join(',')}`);
  }
  const snap = chain.watcher.snapshot();
  assert.equal(snap.hasAlerted, false, '没有 messageId ⇒ 永远不算确认送达 ⇒ 6 小时门闸不得推进');
  assert.equal(snap.lastAttemptOutcome, 'unknown');
});

test('全链（event 路径）：工具变更事件只刷新观测，不计数、不入队', async () => {
  const chain = await createChain();
  chain.setObserved(ALL_TOOLS.slice(0, 9));
  // 十次 event 观察：一次都不能计数
  for (let i = 1; i <= 10; i += 1) await chain.event(T0 + i * 1000);
  const snap = chain.watcher.snapshot();
  assert.equal(snap.consecutiveMisses, 0, 'event 不得推进连续计数');
  assert.equal((await chain.inboxFiles()).length, 0, 'event 不得入队');
});

test('全链（恢复水位）：恢复之后写回的旧缺失条目被判 skippedStale，不再发送', async () => {
  const chain = await createChain();
  chain.setObserved(ALL_TOOLS.slice(0, 9));
  for (let i = 1; i <= 3; i += 1) await chain.tick(T0 + i * MIN);
  const openFiles = await chain.inboxFiles();
  assert.equal(openFiles.length, 1);
  const first = await chain.wireRun();
  assert.equal(first.report.attempted, 1);

  // 工具恢复：写 recovered 条目并消费 → 取消未送达提醒 + 落恢复水位
  chain.setObserved(ALL_TOOLS);
  await chain.tick(T0 + 4 * MIN);
  const recoveredRun = await chain.wireRun();
  // 恢复条目走 cancel 路径：收件箱必须清空，且未送达事件被取消（不发这条已完成调试的断言）
  assert.equal((await chain.inboxFiles()).length, 0, '恢复条目必须被消费');
  const afterRecover = await chain.inboxFiles();
  assert.equal(afterRecover.length, 0, '恢复条目消费后清空');

  // 模拟「插件侧迟到写回」：一条 createdAt 早于恢复水位的缺失条目
  const staleId = '22222222-2222-2222-2222-222222222222';
  await fs.writeFile(
    path.join(chain.inboxDir, `${staleId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      noticeId: staleId,
      kind: 'tool-surface-missing',
      platform: 'dsh',
      missingCount: 3,
      consecutiveMisses: 3,
      lastSeenAt: T0 + 2 * MIN,
      createdAt: T0 + 2 * MIN,
    }),
    'utf8',
  );
  const sentBefore = chain.sent.length;
  const staleRun = await chain.wireRun();
  assert.ok(staleRun.ingested.skippedStale >= 1, '水位之前的旧报警必须被判 skippedStale');
  assert.equal(chain.sent.length, sentBefore, '过时警报不得再发送');
});

test('全链（单飞）：并发 runOnce 只产生一次发送', async () => {
  const chain = await createChain();
  chain.setObserved(ALL_TOOLS.slice(0, 9));
  for (let i = 1; i <= 3; i += 1) await chain.tick(T0 + i * MIN);
  assert.equal((await chain.inboxFiles()).length, 1);
  const [a, b] = await Promise.all([chain.wireRun(), chain.wireRun()]);
  assert.equal(a, b, '并发调用必须复用同一个在飞 Promise');
  assert.equal(chain.sent.length, 1, '并发 runOnce 不得重复发送');
});

