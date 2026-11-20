// 离线端到端（真实模块 + 假 QQ 端点）：
// 插件 apply() 真实装配（生产者/回执读取器）→ 收件箱 → 发件箱 → 发送 → 回执 → 插件记账。
// 假时钟 + 临时目录 + 假发送器：不联网、不发 QQ、不碰正式 profile/config/state、不启停任何进程。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import * as decision from '../src/core/xhh-tool-surface-decision.mjs';
import { createOwnerNoticeBridgeWiring } from '../src/core/owner-notice-bridge-wiring.mjs';
import { apply } from '../plugins/dsh-xhh-tool-watcher/index.mjs';

const MIN = 60_000;
const T0 = Date.now() - 5 * MIN; // 与真实 mtime 同量级，避免假时钟造成"未来/过去"判定
const PREFIX = 'mcp__xiaoheihe__';
const EXPECTED = decision.classifyToolSurface({ observedNames: [] }).missing;
const ALL_TOOLS = EXPECTED.map((name) => PREFIX + name);
const MODULE_URL = (rel) => new URL(rel, import.meta.url).href;

function createFakeScheduler() {
  const calls = [];
  return {
    calls,
    every(ms, fn) {
      const entry = { ms, fn, stopped: false };
      calls.push(entry);
      return () => { entry.stopped = true; };
    },
  };
}

async function createE2E({ fakeQQ } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-notice-e2e-'));
  const inboxDir = path.join(dir, 'inbox');
  const outboxStateFile = path.join(dir, 'state', 'outbox.json');
  const pluginStatePath = path.join(dir, 'plugin-state.json');
  const clock = { now: T0 };
  const sent = [];
  const logs = [];
  // 记录判定模块被调用的顺序：用于钉住「先读回执、再观测」这条顺序要求（顺序反转必须能被测出来）。
  const decisionCalls = [];
  const tracedDecision = {
    ...decision,
    recordToolSurfaceObservation: (...args) => {
      decisionCalls.push('observe');
      return decision.recordToolSurfaceObservation(...args);
    },
    noteToolSurfaceDelivery: (...args) => {
      decisionCalls.push('delivery');
      return decision.noteToolSurfaceDelivery(...args);
    },
  };
  const visible = new Map(ALL_TOOLS.map((name) => [name, {}]));

  const ctx = {
    tools: { view: () => ({ visible, knownNames: new Set(visible.keys()), restrictableNames: new Set() }) },
    on() { return () => {}; },
  };

  const qq = async (text) => {
    sent.push(text);
    if (typeof fakeQQ === 'function') return fakeQQ(text, sent.length);
    return { outcome: 'delivered', messageId: 880000 + sent.length };
  };

  // 桥接侧：真 wiring 模块 + 假 QQ 端点（不注入裸 outbox，让它自己建，从而走 createProvenDeliverySender 收口）
  const wiring = createOwnerNoticeBridgeWiring({
    inboxDir,
    stateFile: outboxStateFile,
    sendOwnerPrivateWithReceipt: qq,
    fs,
    clock: () => clock.now,
    log: (line) => logs.push(String(line)),
    minFileAgeMs: 0, // 假时钟与真实 mtime 不同源；真实年龄闸另有独立用例
  });

  const scheduler = createFakeScheduler();
  const applied = await apply(ctx, {
    decision: tracedDecision,
    scheduler,
    store: null,
    notify: null,
    now: () => clock.now,
    log: (level, message) => logs.push(`${level}:${message}`),
    inboxDir,
    statePath: pluginStatePath,
    intervalMs: MIN,
  });
  assert.equal(typeof applied.dispose, 'function', 'apply 必须装配成功');

  const state = { applied, scheduler };
  const tickFn = () => state.scheduler.calls[0].fn();

  return {
    dir, inboxDir, outboxStateFile, pluginStatePath, clock, sent, logs, wiring, scheduler, visible, decisionCalls,
    get applied() { return state.applied; },
    /** 模拟插件重启：dispose 旧实例（进程内状态丢失）后在同一 statePath 上重新 apply。 */
    async restart() {
      state.applied.dispose();
      const nextScheduler = createFakeScheduler();
      state.scheduler = nextScheduler;
      state.applied = await apply(ctx, {
        decision: tracedDecision,
        scheduler: nextScheduler,
        store: null,
        notify: null,
        now: () => clock.now,
        log: (level, message) => logs.push(`${level}:${message}`),
        inboxDir,
        statePath: pluginStatePath,
        intervalMs: MIN,
      });
      return state.applied;
    },
    setObserved(names) {
      visible.clear();
      for (const name of names) visible.set(name, {});
    },
    async tick(at) {
      clock.now = at;
      await tickFn();
    },
    async wire() { return wiring.runOnce(); },
    async inboxFiles() {
      try { return (await fs.readdir(inboxDir)).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
    },
    async close() {
      applied.dispose();
      await wiring.stop();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

const MISSING = ALL_TOOLS.slice(0, 9); // 缺 3 个
test('E2E：插件重启后 6 小时窗口仍在（statePath 持久化）', async () => {
  const chain = await createE2E();
  chain.setObserved(MISSING);
  for (let m = 1; m <= 3; m += 1) await chain.tick(T0 + m * MIN);
  const run = await chain.wire();
  assert.equal(run.report.delivered, 1);
  // 回执要等插件下一轮 tick 才会被读回（与主链路一致：回执先于观测）
  await chain.tick(T0 + 4 * MIN);
  const alertAt = chain.applied.watcher.snapshot().lastAlertAt;
  assert.ok(alertAt > 0, '首次送达必须记录 lastAlertAt');

  // 插件重启：进程内状态清空，只能靠 statePath 恢复
  const restarted = await chain.restart();
  const afterRestart = restarted.watcher.snapshot();
  assert.equal(afterRestart.hasAlerted, true, '重启后必须仍在已提醒状态（statePath 持久化）');
  assert.equal(afterRestart.lastAlertAt, alertAt, '重启后 lastAlertAt 必须一致');

  // 6 小时内继续缺失：重启不得导致提前重复提醒
  const before = chain.sent.length;
  for (let m = 4; m <= 60; m += 1) await chain.tick(T0 + m * MIN);
  assert.equal(chain.sent.length, before, '重启后仍处在 6 小时窗口，不得重复发送');
  assert.equal((await chain.inboxFiles()).length, 0, '重启后 6 小时内不得重新排队');
  await chain.close();
});


test('E2E：插件 apply() 真实装配 ⇒ 三次定时缺失 ⇒ 假 QQ 送达 ⇒ 回执记账并进入 6 小时窗口', async () => {
  const chain = await createE2E();
  chain.setObserved(MISSING);
  for (let m = 1; m <= 3; m += 1) await chain.tick(T0 + m * MIN);
  assert.equal((await chain.inboxFiles()).length, 1, '第三次定时缺失必须写出收件箱条目');

  const run = await chain.wire();
  assert.equal(run.report.delivered, 1, '假 QQ 返回 messageId ⇒ 记 delivered');
  assert.equal(chain.sent.length, 1);

  // 下一分钟：插件必须先读回执、再观测（顺序必须可观测，否则「回执晚一轮才生效」会被漏掉）
  const before = chain.decisionCalls.length;
  await chain.tick(T0 + 4 * MIN);
  const window = chain.decisionCalls.slice(before);
  assert.ok(window.includes('delivery'), `同一 tick 必须读回执，实际 ${window.join(',')}`);
  assert.ok(window.includes('observe'), `同一 tick 必须观测，实际 ${window.join(',')}`);
  assert.ok(
    window.lastIndexOf('delivery') < window.lastIndexOf('observe'),
    `回执必须先于观测，实际顺序 ${window.join(',')}`,
  );
  const snap = chain.applied.watcher.snapshot();
  assert.equal(snap.lastAttemptOutcome, 'delivered', '回执必须经插件真实装配被读回');
  assert.equal(snap.hasAlerted, true, '确认送达后才进入 6 小时窗口');

  // 6 小时内继续缺失：不得再入队（必须真的覆盖满 6 小时窗口；原先只测到第 40 分钟，
  // 6h→1h 的变异因此仍是绿的 —— 复审 P2）
  for (let m = 5; m <= 362; m += 1) await chain.tick(T0 + m * MIN);
  assert.equal((await chain.inboxFiles()).length, 0, '送达后 6 小时内不得再排队');
  assert.equal(chain.sent.length, 1, '6 小时窗口内不得重复发送');
  // 第 363 分钟 = 首次发送（第 4 分钟）之后满 6 小时 ⇒ 必须重新入队并再发一次
  await chain.tick(T0 + 363 * MIN);
  assert.equal((await chain.inboxFiles()).length, 1, '满 6 小时后必须重新排队');
  const resent = await chain.wire();
  assert.equal(resent.report.delivered, 1, '满 6 小时后应再发一次');
  assert.equal(chain.sent.length, 2);
  await chain.close();
});

test('E2E：失败回执 ⇒ 15 分钟后重试（不是每分钟）', async () => {
  let attempt = 0;
  const chain = await createE2E({
    fakeQQ: async () => {
      attempt += 1;
      return attempt === 1 ? { outcome: 'failed', code: 'send-failed' } : { outcome: 'delivered', messageId: 880100 + attempt };
    },
  });
  chain.setObserved(MISSING);
  const sendMinutes = [];
  for (let m = 1; m <= 45; m += 1) {
    const before = chain.sent.length;
    await chain.tick(T0 + m * MIN);
    await chain.wire();
    if (chain.sent.length > before) sendMinutes.push(m);
  }
  assert.equal(sendMinutes[0], 3, `首次应在第 3 分钟，实际 ${sendMinutes.join(',')}`);
  assert.ok(sendMinutes.length >= 2, '失败必须重试');
  for (let i = 1; i < sendMinutes.length; i += 1) {
    assert.ok(sendMinutes[i] - sendMinutes[i - 1] >= 15, `每次失败重试间隔都必须 ≥15 分钟，实际 ${sendMinutes.join(',')}`);
  }
  await chain.close();
});

test('E2E：工具恢复 ⇒ 未送达提醒被取消，恢复后不再发送', async () => {
  const chain = await createE2E({ fakeQQ: async () => ({ outcome: 'failed', code: 'send-failed' }) });
  chain.setObserved(MISSING);
  for (let m = 1; m <= 3; m += 1) await chain.tick(T0 + m * MIN);
  await chain.wire();
  assert.equal(chain.sent.length, 1, '失败也要计入尝试');

  chain.setObserved(ALL_TOOLS); // 恢复
  for (let m = 4; m <= 6; m += 1) { await chain.tick(T0 + m * MIN); await chain.wire(); }
  const sentAfterRecover = chain.sent.length;
  for (let m = 7; m <= 30; m += 1) { await chain.tick(T0 + m * MIN); await chain.wire(); }
  assert.equal(chain.sent.length, sentAfterRecover, '恢复后不得再发送旧报警');
  // 取消回执不得被插件记成 delivered（复审 P2：以前只验证了 outbox 关闭，记账侧没测）
  const afterRecoverSnap = chain.applied.watcher.snapshot();
  assert.equal(afterRecoverSnap.hasAlerted, false, 'cancelled 不是送达，不得进入 6 小时窗口');
  assert.equal(afterRecoverSnap.lastAlertAt ?? null, null, 'cancelled 不得推进 lastAlertAt');
  await chain.close();
});

test('E2E：生产形状发送器（不返回 messageId）⇒ 只判 unknown、≥15 分钟节流、永不推进 6 小时门闸', async () => {
  const chain = await createE2E({ fakeQQ: async () => ({ outcome: 'delivered' }) });
  chain.setObserved(MISSING);
  const sendMinutes = [];
  for (let m = 1; m <= 45; m += 1) {
    const before = chain.sent.length;
    await chain.tick(T0 + m * MIN);
    await chain.wire();
    if (chain.sent.length > before) sendMinutes.push(m);
  }
  assert.equal(sendMinutes[0], 3, `首次应在第 3 分钟，实际 ${sendMinutes.join(',')}`);
  // 只有 1 次发送时下面的循环会空转（复审 P2）：先钉总数，再钉间隔。
  assert.ok(sendMinutes.length >= 3, `45 分钟内应至少发送 3 次（3/18/33），实际 ${sendMinutes.join(',')}`);
  for (let i = 1; i < sendMinutes.length; i += 1) {
    assert.ok(sendMinutes[i] - sendMinutes[i - 1] >= 15, `相邻发送必须 ≥15 分钟，实际 ${sendMinutes.join(',')}`);
  }
  const snap = chain.applied.watcher.snapshot();
  assert.equal(snap.hasAlerted, false, '没有 messageId ⇒ 永不确认送达');
  assert.equal(snap.lastAttemptOutcome, 'unknown');
  await chain.close();
});

test('跨进程：活进程持锁 ⇒ 另一个进程 submit 必须 fail-closed 为 owner-held，且其退出后需人工清锁', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-notice-xproc-'));
  const stateFile = path.join(dir, 'state', 'outbox.json');
  const lockFile = `${stateFile}.lock`;
  await fs.mkdir(path.dirname(stateFile), { recursive: true });

  const holderScript = path.join(dir, 'holder.mjs');
  await fs.writeFile(holderScript, `
import fs from 'node:fs/promises';
const [lockFile] = process.argv.slice(2);
const handle = await fs.open(lockFile, 'wx');
await handle.writeFile(JSON.stringify({ instanceId: 'holder-instance', pid: process.pid, at: Date.now() }));
await handle.close();
await new Promise((r) => setTimeout(r, 1500));
process.stdout.write('held');
`, 'utf8');

  const submitScript = path.join(dir, 'submit.mjs');
  await fs.writeFile(submitScript, `
import { createOwnerNoticeOutbox } from ${JSON.stringify(MODULE_URL('../src/core/owner-notice-outbox.mjs'))};
const [stateFile, eventId] = process.argv.slice(2);
const box = createOwnerNoticeOutbox({ filePath: stateFile, clock: () => ${T0}, send: async () => ({ outcome: 'delivered' }) });
const result = await box.submit({
  schemaVersion: 1, eventId, kind: 'tool-surface-missing', missingCount: 3, consecutiveMisses: 3,
  lastSeenAt: ${T0}, createdAt: ${T0},
});
process.stdout.write(JSON.stringify(result));
`, 'utf8');

  const run = (script, args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, pid: child.pid }));
  });

  const holder = run(holderScript, [lockFile]);
  // 读锁必须容错：holder 先 open('wx') 再写内容，读到空文件是合法中间态（复审 P1：
  // 原先 fs.access 成功就 JSON.parse，80 次实测 3 次 SyntaxError）。
  const lockDeadline = Date.now() + 5000;
  let held = null;
  while (Date.now() < lockDeadline) {
    try { held = JSON.parse(await fs.readFile(lockFile, 'utf8')); break; }
    catch (error) {
      const tolerable = error?.code === 'ENOENT' || error instanceof SyntaxError;
      if (!tolerable) throw error;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  assert.ok(held && Number.isSafeInteger(held.pid), '必须在 5 秒内读到完整锁文件（不能把空文件当结论）');

  const blocked = JSON.parse((await run(submitScript, [stateFile, 'aaaaaaaa-1111-1111-1111-111111111111'])).out);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'owner-held', `活进程持锁时必须 owner-held，实际 ${JSON.stringify(blocked)}`);
  assert.equal(blocked.holderPid, held.pid);
  assert.equal(blocked.holderInstanceId, 'holder-instance');

  await holder;
  // 持锁进程退出后锁文件仍在（不自动接管）⇒ 仍需 fail-closed，直到人工删除
  const afterExit = JSON.parse((await run(submitScript, [stateFile, 'bbbbbbbb-2222-2222-2222-222222222222'])).out);
  assert.equal(afterExit.ok, false, '不自动接管：残留锁必须仍是 owner-held');
  assert.equal(afterExit.reason, 'owner-held');

  await fs.rm(lockFile);
  const recovered = JSON.parse((await run(submitScript, [stateFile, 'cccccccc-3333-3333-3333-333333333333'])).out);
  assert.equal(recovered.ok, true, `人工清锁后必须放行，实际 ${JSON.stringify(recovered)}`);
  await fs.rm(dir, { recursive: true, force: true });
});

test('跨进程：6 个子进程并发 submit 同一发件箱 ⇒ 无重复 eventId、文件始终合法 JSON、锁被清理', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-notice-xproc-'));
  const stateFile = path.join(dir, 'state', 'outbox.json');
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const script = path.join(dir, 'submit.mjs');
  await fs.writeFile(script, `
import { createOwnerNoticeOutbox } from ${JSON.stringify(MODULE_URL('../src/core/owner-notice-outbox.mjs'))};
const [stateFile, eventId] = process.argv.slice(2);
const box = createOwnerNoticeOutbox({ filePath: stateFile, clock: () => ${T0}, send: async () => ({ outcome: 'delivered' }) });
const result = await box.submit({
  schemaVersion: 1, eventId, kind: 'tool-surface-missing', missingCount: 3, consecutiveMisses: 3,
  lastSeenAt: ${T0}, createdAt: ${T0},
});
process.stdout.write(JSON.stringify(result));
`, 'utf8');
  const runOne = (eventId) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, stateFile, eventId], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });

  const ids = Array.from({ length: 6 }, (_, i) => `${i + 1}0000000-0000-4000-8000-000000000000`);
  const results = await Promise.all(ids.map((id) => runOne(id)));
  for (const r of results) assert.equal(r.code, 0, r.out);
  const parsed = results.map((r) => JSON.parse(r.out));
  let successes = 0;
  const successfulIds = [];
  for (const [index, r] of parsed.entries()) {
    if (r.ok === true) { successes += 1; successfulIds.push(ids[index]); continue; }
    // 不是只有 owner-held 一种失败形态：抢锁窗口里还可能出现 lock-empty-needs-recovery /
    // lock-unreadable（复审 P3）。这里只要求「非响应成功时必须给出可解释的失败原因」。
    assert.ok(
      ['owner-held', 'lock-empty-needs-recovery', 'lock-unreadable', 'state-corrupt'].includes(r.reason),
      `未成功的必须带明确的锁/状态原因：${results[index].out}`,
    );
    const retry = JSON.parse((await runOne(ids[index])).out);
    if (retry.ok === true) { successes += 1; successfulIds.push(ids[index]); }
  }
  assert.ok(successes >= 1);
  const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.ok(Array.isArray(saved.events));
  const savedIds = saved.events.map((e) => e.eventId);
  // 合并语义下「事件条数」不等于「成功次数」，所以真正的丢写检测是：
  // 每个返回 ok 的 eventId 都必须能在磁盘状态里找到（复审 P3）。
  // 注意：同类缺失事件会**合并**到已有的 open 事件上，此时响应里的 eventId 是既有事件 id
  // （不是本次提交的 id）。所以丢写检测要对「响应自己的 eventId」做，而不是对提交 id。
  for (const [index, r] of parsed.entries()) {
    if (r.ok !== true) continue;
    const returned = typeof r.eventId === 'string' ? r.eventId : null;
    assert.ok(returned !== null, `成功响应必须带 eventId：${results[index].out}`);
    assert.ok(savedIds.includes(returned), `成功响应的 eventId 必须落盘：${returned} 不在 ${savedIds.join(',')}`);
    if (r.merged !== true) {
      assert.ok(savedIds.includes(ids[index]), `未合并的成功提交必须落盘其自身 id：${ids[index]}`);
    }
  }
  assert.equal(new Set(savedIds).size, savedIds.length, '不得出现重复 eventId');
  assert.ok(saved.events.length >= 1, '至少一条事件');
  const leftover = (await fs.readdir(path.dirname(stateFile))).filter((n) => n.endsWith('.lock'));
  assert.deepEqual(leftover, [], '锁必须在操作结束后清理');
  await fs.rm(dir, { recursive: true, force: true });
});

test('跨进程：两个子进程并发写收件箱 ⇒ 两个条目都是合法 JSON、noticeId 不同、无残留 tmp', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-notice-xproc-'));
  const inboxDir = path.join(dir, 'inbox');
  const script = path.join(dir, 'producer.mjs');
  await fs.writeFile(script, `
import { createInboxProducer } from ${JSON.stringify(MODULE_URL('../plugins/dsh-xhh-tool-watcher/inbox-producer.mjs'))};
const [inboxDir] = process.argv.slice(2);
const producer = createInboxProducer({ inboxDir, clock: () => ${T0} });
const out = await producer.notifyMissing({ missingCount: 3, consecutiveMisses: 3, lastSeenAt: ${T0}, at: ${T0} });
process.stdout.write(JSON.stringify(out));
`, 'utf8');
  const runOne = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, inboxDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
  const results = await Promise.all([runOne(), runOne()]);
  for (const r of results) assert.equal(r.code, 0, `${r.out} ${r.err}`);
  const files = (await fs.readdir(inboxDir)).filter((n) => n.endsWith('.json'));
  assert.equal(files.length, 2, '两个进程各写一条，不得互相覆盖');
  const entries = await Promise.all(files.map(async (n) => JSON.parse(await fs.readFile(path.join(inboxDir, n), 'utf8'))));
  for (const e of entries) assert.equal(e.kind, 'tool-surface-missing');
  assert.notEqual(entries[0].noticeId, entries[1].noticeId, 'noticeId 必须不同');
  const tmps = (await fs.readdir(inboxDir)).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(tmps, [], '临时文件必须已被 rename 掉');
  await fs.rm(dir, { recursive: true, force: true });
});