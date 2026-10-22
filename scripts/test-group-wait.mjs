// 群聊等待策略回归：真实 bridge HTTP handler + 虚拟时钟（测试中不产生真实的 3s/6s sleep）。
// 覆盖：3 秒静默、6 秒硬期限抗续延、显式 quietMs=60000 被钳、无消息观察窗口、minNew>1、
// 边界新消息、私聊不变、权限变化、断连，以及未读/水位不被清空（不自动 mark_read）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { groupWaitPolicy } from '../src/core/group-wait-policy.mjs';

// bridge 在 handler 里用 Date.now / sleep / setTimeout；这里用虚拟时钟把 3s/6s 压缩到
// 毫秒级，并允许按虚拟时间表精确投放“新消息”，从而稳定复现续延/边界场景。
function createVirtualClock() {
  const base = Date.now();
  let now = base;
  let drive = false;
  let pumping = false;
  let holdNext = false;
  const heldTimers = [];
  const queue = [];
  const realTimers = new Set();

  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() { return now; }
  }

  function pump(limit) {
    if (pumping) return;
    pumping = true;
    try {
      for (let guard = 0; guard < 200000; guard++) {
        let picked = -1;
        for (let i = 0; i < queue.length; i++) {
          if (queue[i].at > limit) continue;
          if (picked === -1 || queue[i].at < queue[picked].at) picked = i;
        }
        if (picked === -1) break;
        const entry = queue.splice(picked, 1)[0];
        if (entry.at > now) now = entry.at;
        if (entry.kind === 'action') {
          // 投放消息走真实分支：append 内部排的定时器不能在虚拟时间里被瞬间触发。
          const previousDrive = drive;
          drive = false;
          try { entry.fn(); } finally { drive = previousDrive; }
        } else {
          entry.fn();
        }
      }
      if (limit > now) now = limit;
    } finally {
      pumping = false;
    }
  }

  function schedule(delay, fn) {
    queue.push({ at: now + Math.max(0, Number(delay) || 0), fn, kind: 'action' });
  }

  function setTimeoutFake(fn, ms) {
    const delay = Math.max(0, Number(ms) || 0);
    // 只有 handler 自己的短 sleep（<=300ms）走虚拟时钟。readBody 的 30000ms
    // 截止等长定时器必须留在真实时钟，否则请求体还没读完就被判超时（400）。
    if (!drive || delay > 300) {
      const handle = setTimeout(fn, delay);
      realTimers.add(handle);
      return handle;
    }
    const handle = { fake: true, unref() {} };
    if (holdNext) {
      // 真正的挂起：定时器不触发，直到 releaseHold 才继续。断连测试靠它把
      // 请求卡在 bridge 自己的 sleep 上，而不是只靠注入 globals.sleep 假装驱动。
      holdNext = false;
      heldTimers.push({ fn, handle });
      return handle;
    }
    queue.push({ at: now + delay, fn, kind: 'timer', handle });
    pump(now + delay);
    return handle;
  }

  function clearTimeoutFake(handle) {
    if (handle && handle.fake) {
      const heldIndex = heldTimers.findIndex((entry) => entry.handle === handle);
      if (heldIndex !== -1) { heldTimers.splice(heldIndex, 1); return; }
      const index = queue.findIndex((entry) => entry.handle === handle);
      if (index !== -1) queue.splice(index, 1);
      return;
    }
    if (handle) {
      realTimers.delete(handle);
      clearTimeout(handle);
    }
  }

  function holdNextSleep() { holdNext = true; }

  function releaseHold() {
    const held = heldTimers.splice(0);
    for (const entry of held) entry.fn();
  }

  function dispose() {
    for (const handle of realTimers) clearTimeout(handle);
    realTimers.clear();
    queue.length = 0;
    releaseHold();
  }

  return {
    Date: FakeDate,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    schedule,
    holdNextSleep,
    releaseHold,
    dispose,
    now: () => now,
    begin: () => { drive = true; },
    end: () => { drive = false; },
  };
}

const realWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, { key = 'group:456', config = {} } = {}) {
  const clock = createVirtualClock();
  const h = await bridgeHarness({
    config: {
      socialV2: {
        wake: { preSleepWaitEnabled: true, preSleepWaitMs: 300000 },
        wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 100 },
        proactive: { enabled: false },
        sticker: { enabled: false },
        ...config,
      },
    },
    globals: {
      // handler 依赖的统一 import 在测试 VM 中由这里提供。
      groupWaitPolicy,
      Date: clock.Date,
      // bridge 顶层有自己的 sleep const（内部调用 setTimeout），所以不再注入
      // globals.sleep 冒充驱动；虚拟时钟只接管 <=300ms 的 setTimeout。
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  });
  h.setMode('reserved2');
  const st = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const append = (text) => {
    h.appendSocialV2Message(key, 'fixture-person', text, text, false, false, `fixture-${(st.lastUnreadSeq || 0) + 1}`, [], '789', []);
    // append 可能顺带排回复检查/唤醒定时器；它们不属于本次等待，清掉避免干扰虚拟时间。
    h.cancelReplyCheckV2?.(key);
    h.cancelPendingWakeTimerV2?.(key, st);
    return st.lastUnreadSeq || 0;
  };
  const appendAt = (delayMs, text) => clock.schedule(delayMs, () => append(text));

  const request = async (route, body, signal) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/socialV2/${route}`, {
      method: 'POST',
      headers: {
        'x-console-token': 'fixture-console-token',
        'x-agent-token': st.agentToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ key, ...body }),
      signal: signal ?? AbortSignal.timeout(10000),
    });
    const raw = await response.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* 非 JSON 错误页交给调用方按 status 断言 */ }
    return { status: response.status, data };
  };

  t.after(async () => {
    clock.dispose();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  });

  return { h, st, key, request, append, appendAt, clock, port };
}

test('groupWaitPolicy: 群聊固定 3s/6s，私聊与非法 key 返回 null', () => {
  assert.deepEqual(groupWaitPolicy('group:456'), { quietMs: 3000, maxAfterFirstMessageMs: 6000 });
  assert.deepEqual(groupWaitPolicy(' group:456 '), { quietMs: 3000, maxAfterFirstMessageMs: 6000 });
  for (const key of ['private:123', 'group:', 'group:   ', '', null, undefined, 42, {}]) {
    assert.equal(groupWaitPolicy(key), null, `key=${String(key)}`);
  }
});

test('群聊 messages 等待：显式 quietMs=60000 被钳到 3000，且不自动 mark_read', async (t) => {
  const f = await fixture(t);
  f.appendAt(200, 'hello');
  f.clock.begin();
  const result = await f.request('wait', { timeoutMs: 300000, quietMs: 60000 });
  f.clock.end();
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.quietMs, 3000);
  assert.equal(result.data.arrived, true);
  assert.equal(result.data.quiet, true);
  assert.equal(result.data.timeout, false);
  assert.equal(result.data.waitLimitReached, false);
  assert.ok(result.data.waitedMs >= 3000 && result.data.waitedMs <= 4000, `waitedMs=${result.data.waitedMs}`);
  assert.deepEqual(result.data.newMessages.map((message) => message.seq), [1]);
  assert.equal(result.data.readThroughSeq, 1);
  assert.equal(f.st.unread.length, 1, '等待不得自动 mark_read / 清空未读');
});

test('群聊 messages 等待：后台 minQuietAfterNewMs=10000 也按 3000 处理', async (t) => {
  const f = await fixture(t, { config: { wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 10000 } } });
  f.appendAt(200, 'hello');
  f.clock.begin();
  const result = await f.request('wait', { timeoutMs: 300000 });
  f.clock.end();
  assert.equal(result.data.quietMs, 3000);
  assert.equal(result.data.quiet, true);
  assert.ok(result.data.waitedMs >= 3000 && result.data.waitedMs <= 4000, `waitedMs=${result.data.waitedMs}`);
});

test('群聊 messages 等待：首条新消息后 6 秒硬期限，不被后续消息续延', async (t) => {
  const f = await fixture(t);
  f.appendAt(200, 'first');
  for (let at = 1000; at <= 9000; at += 1000) f.appendAt(at, `supplement-${at}`);
  f.clock.begin();
  const result = await f.request('wait', { timeoutMs: 300000 });
  f.clock.end();
  assert.equal(result.status, 200);
  assert.equal(result.data.arrived, true);
  assert.equal(result.data.quiet, false);
  assert.equal(result.data.timeout, false);
  assert.equal(result.data.speakerLikelyDone, false);
  assert.equal(result.data.waitLimitReached, true);
  assert.equal(result.data.preSleepWaitSatisfied, false);
  assert.ok(result.data.waitedMs >= 6000 && result.data.waitedMs <= 7000, `waitedMs=${result.data.waitedMs}`);
  const seqs = result.data.newMessages.map((message) => message.seq);
  assert.ok(seqs.includes(1));
  assert.equal(seqs[seqs.length - 1], 7, `边界前消息应全部返回，实际 ${seqs.join(',')}`);
  assert.ok(seqs.length >= 3);
});

test('群聊 messages 等待：minNewMessages>1 不会耗死，到 6 秒返回已有消息', async (t) => {
  const f = await fixture(t);
  f.appendAt(200, 'only one');
  f.clock.begin();
  const result = await f.request('wait', { timeoutMs: 300000, minNewMessages: 3 });
  f.clock.end();
  assert.equal(result.data.arrived, true);
  assert.deepEqual(result.data.newMessages.map((message) => message.seq), [1]);
  assert.equal(result.data.waitLimitReached, true);
  assert.ok(result.data.waitedMs >= 6000 && result.data.waitedMs <= 7000, `waitedMs=${result.data.waitedMs}`);
});

test('群聊 messages 等待：6 秒期限边界上到达的消息不被漏掉', async (t) => {
  const f = await fixture(t);
  f.appendAt(200, 'first');
  f.appendAt(6200, 'boundary');
  f.clock.begin();
  const result = await f.request('wait', { timeoutMs: 300000, minNewMessages: 2 });
  f.clock.end();
  assert.deepEqual(result.data.newMessages.map((message) => message.seq), [1, 2]);
  assert.equal(result.data.arrived, true);
  assert.equal(result.data.quiet, false);
  assert.equal(result.data.waitLimitReached, true);
  assert.ok(result.data.waitedMs >= 6000 && result.data.waitedMs <= 7000, `waitedMs=${result.data.waitedMs}`);
});

test('群聊 messages 等待：timeout 边界上到达的新消息也不会被漏掉', async (t) => {
  const f = await fixture(t);
  f.appendAt(450, 'just before timeout');
  f.clock.begin();
  const result = await f.request('wait', { timeoutMs: 500 });
  f.clock.end();
  assert.equal(result.data.arrived, true);
  assert.deepEqual(result.data.newMessages.map((message) => message.seq), [1]);
  assert.equal(result.data.quiet, true);
  assert.equal(result.data.waitedMs >= 500, true);
});

test('群聊 messages 等待：没有新消息时仍等满原 timeout（保留 5 分钟观察窗口）', async (t) => {
  const f = await fixture(t);
  f.clock.begin();
  const result = await f.request('wait', { timeoutMs: 300000 });
  f.clock.end();
  assert.equal(result.data.arrived, false);
  assert.equal(result.data.timeout, true);
  assert.equal(result.data.quiet, false);
  assert.equal(result.data.preSleepWaitSatisfied, true);
  assert.equal(result.data.waitLimitReached, false);
  assert.equal(result.data.preSleepWaitMs, 300000);
  assert.ok(result.data.waitedMs >= 300000, `waitedMs=${result.data.waitedMs}`);
  assert.ok(f.st.preSleepWaitSatisfiedAt > 0);
});

test('群聊 reply 等待：已有待处理消息时最多 6 秒，quiet=false 且 timeout 如实显示', async (t) => {
  const f = await fixture(t);
  f.append('first');
  f.st.lastIncomingAt = f.clock.now();
  for (let at = 1000; at <= 9000; at += 1000) {
    f.clock.schedule(at, () => {
      f.append(`supplement-${at}`);
      f.st.lastIncomingAt = f.clock.now();
    });
  }
  f.clock.begin();
  const result = await f.request('wait', { purpose: 'reply', timeoutMs: 300000, quietMs: 60000 });
  f.clock.end();
  assert.equal(result.status, 200);
  assert.equal(result.data.purpose, 'reply');
  assert.equal(result.data.quietMs, 3000);
  assert.equal(result.data.quiet, false);
  assert.equal(result.data.timeout, true);
  assert.equal(result.data.speakerLikelyDone, false);
  assert.equal(result.data.waitLimitReached, true);
  assert.equal(result.data.preSleepWaitObserved, false);
  assert.equal(result.data.preSleepWaitSatisfied, false);
  assert.ok(result.data.waitedMs >= 6000 && result.data.waitedMs <= 7000, `waitedMs=${result.data.waitedMs}`);
  const seqs = result.data.newMessages.map((message) => message.seq);
  assert.ok(seqs.includes(1));
  assert.equal(seqs[seqs.length - 1], 7, `6 秒内到达的补话应返回，实际 ${seqs.join(',')}`);
});

test('私聊 messages 等待保持原有行为：显式 60000 静默不被群策略钳制', async (t) => {
  const f = await fixture(t, { key: 'private:123' });
  f.appendAt(200, 'hello');
  f.clock.begin();
  const result = await f.request('wait', { timeoutMs: 120000, quietMs: 60000 });
  f.clock.end();
  assert.equal(result.status, 200);
  assert.equal(result.data.quietMs, 60000);
  assert.equal(result.data.quiet, true);
  assert.equal(result.data.timeout, false);
  assert.equal(result.data.waitLimitReached, false);
  assert.ok(result.data.waitedMs >= 60000 && result.data.waitedMs <= 62000, `waitedMs=${result.data.waitedMs}`);
});

test('群聊等待期间权限变化：等完后 403，且不记录任何观察', async (t) => {
  const f = await fixture(t);
  f.clock.schedule(500, () => f.h.setMode('chat'));
  f.clock.begin();
  const result = await f.request('wait', { timeoutMs: 300000 });
  f.clock.end();
  assert.equal(result.status, 403);
  assert.equal(f.st.preSleepWaitSatisfiedAt, 0);
  assert.equal(f.st.preSleepWaitObservedAt, 0);
  assert.equal(f.st.unread.length, 0);
});

test('群聊等待期间断连：请求中止、租约释放、不记录观察', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  f.clock.holdNextSleep();
  f.clock.begin();
  const pending = f.request('wait', { timeoutMs: 100000 }, controller.signal).catch(() => null);
  await realWait(20);
  controller.abort();
  await realWait(20);
  f.clock.releaseHold();
  await pending;
  await realWait(30);
  const next = await f.request('wait', { timeoutMs: 500 });
  f.clock.end();
  assert.equal(next.status, 200, `断连后租约未释放：${JSON.stringify(next.data)}`);
  assert.equal(next.data.timeout, true);
  assert.equal(f.st.preSleepWaitSatisfiedAt, 0);
  assert.equal(f.st.preSleepWaitObservedAt, 0);
  assert.equal(f.st.modelSeenSeqs.size, 0);
});

test('replyTimingV2：群聊固定 3 秒且按真实 lastIncomingAt 算剩余，私聊保留原行为', async (t) => {
  const f = await fixture(t, {
    // 后台 quiet 配置 < 3000ms：群聊仍必须是 3 秒，私聊继续按冻结实现/原配置计算。
    config: { wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 1500, replyQuietMs: 1500, quietMs: 1500 } },
  });
  const timingFn = f.h.replyTimingV2;
  assert.equal(typeof timingFn, 'function', 'bridgeHarness 需要暴露 replyTimingV2 才能锁定该回归');
  f.st.lastIncomingAt = f.clock.now() - 4000; // 已经真实安静 4 秒
  const groupTiming = timingFn(f.st, 'group:456');
  assert.equal(groupTiming.quietMs, 3000, '群聊窗口固定 3 秒，不受后台更小配置影响');
  assert.equal(groupTiming.remainingQuietMs, 0, '真实安静 4 秒后不应再提示剩余等待');
  // 私聊没有 groupPolicy：返回冻结实现的旧窗口，不能被群聊固定 3 秒覆盖。
  const privateSt = f.h.getSocialV2State('private:123');
  privateSt.lastIncomingAt = f.clock.now() - 4000;
  const privateTiming = timingFn(privateSt, 'private:123');
  assert.equal(privateTiming.quietMs, 8000);
});

test('群聊等待默认建议静默取群策略：minQuietAfterNewMs=10000 时不被抬高', async (t) => {
  const f = await fixture(t, { config: { wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 10000 } } });
  f.appendAt(200, 'hello');
  f.clock.begin();
  const result = await f.request('wait', { timeoutMs: 300000 });
  f.clock.end();
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.quietMs, 3000);
  // 旧实现把 suggestedQuietMs 按 minQuietAfterNewMs 抬到 10000；wait 响应若回传这个
  // 建议值，群聊必须与 groupPolicy.quietMs（3000）一致，不能比实际静默窗口大。
  assert.equal(result.data.suggestedQuietMs, 3000, `suggestedQuietMs=${result.data.suggestedQuietMs}`);
});

test('群聊 messages 等待：同一轮询窗口内两条新消息按首条真实时间起算 6 秒期限', async (t) => {
  const f = await fixture(t);
  // 两条消息都落在 200ms -> 300ms 这同一个 100ms 轮询窗口里：旧实现只记住最后一条
  // （lastIncomingAt=250），6 秒期限被推成 6250；首条真实时间是 220，期限应为 6220。
  // 期间持续补话（间隔 < 3 秒）保证不会因静默窗口提前返回，只能等硬期限。
  f.appendAt(220, 'first');
  f.appendAt(250, 'second');
  f.appendAt(2200, 'supplement-1');
  f.appendAt(4200, 'supplement-2');
  f.clock.begin();
  const result = await f.request('wait', { timeoutMs: 300000 });
  f.clock.end();
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.arrived, true);
  assert.equal(result.data.quiet, false);
  assert.equal(result.data.waitLimitReached, true);
  const seqs = result.data.newMessages.map((message) => message.seq);
  assert.ok(seqs.includes(1) && seqs.includes(2), `seqs=${seqs.join(',')}`);
  assert.equal(seqs[seqs.length - 1], 4, `6 秒内消息应全部返回，实际 ${seqs.join(',')}`);
  assert.ok(result.data.waitedMs >= 6000, `waitedMs=${result.data.waitedMs}`);
  assert.ok(result.data.waitedMs <= 6220, `waitedMs=${result.data.waitedMs}`);
});

test('群聊 reply 等待：更短 timeoutMs 先到不冒充 6 秒硬期限', async (t) => {
  const f = await fixture(t);
  f.appendAt(100, 'reply soon');
  f.clock.begin();
  const result = await f.request('wait', { purpose: 'reply', timeoutMs: 300, quietMs: 60000 });
  f.clock.end();
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.purpose, 'reply');
  assert.equal(result.data.arrived, true);
  assert.equal(result.data.quiet, false);
  // 300ms 的 reply 预算先到：这是本次等待超时，但没到「首条新消息 + 6 秒」，不能误报。
  assert.equal(result.data.timeout, true);
  assert.equal(result.data.waitLimitReached, false);
  assert.deepEqual(result.data.newMessages.map((message) => message.seq), [1]);
  assert.ok(result.data.waitedMs >= 300 && result.data.waitedMs <= 400, `waitedMs=${result.data.waitedMs}`);
});

test('群聊 reply 等待：真实快照已读后，只补等 lastIncomingAt 剩余约 2 秒', async (t) => {
  const f = await fixture(t);
  const seq = f.append('already handled');
  assert.ok(seq >= 1, `append 未产生消息：${seq}`);
  // 不手工清未读/水位：走真实快照投递，让 readThroughSeq 覆盖这条已有消息。
  await f.h.sendWakePromptV2(f.key, 'question');
  // 已真实安静 1 秒：群聊固定 3 秒窗口只剩约 2 秒，不能重新等满 timeout。
  f.st.lastIncomingAt = f.clock.now() - 1000;
  f.clock.begin();
  const result = await f.request('wait', { purpose: 'reply', timeoutMs: 8000 });
  f.clock.end();
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.purpose, 'reply');
  assert.equal(result.data.quiet, true);
  assert.equal(result.data.timeout, false);
  assert.equal(result.data.arrived, false);
  assert.deepEqual(result.data.newMessages.map((message) => message.seq), []);
  assert.equal(result.data.waitLimitReached, false);
  assert.ok(result.data.waitedMs >= 1900 && result.data.waitedMs <= 2100, `waitedMs=${result.data.waitedMs}`);
});

test('群聊 reply 等待：lastIncomingAt 已安静 10 秒时立即返回 waitedMs=0，不误观察', async (t) => {
  const f = await fixture(t);
  f.append('already quiet');
  await f.h.sendWakePromptV2(f.key, 'question');
  f.st.lastIncomingAt = f.clock.now() - 10000;
  f.clock.begin();
  const result = await f.request('wait', { purpose: 'reply', timeoutMs: 8000 });
  f.clock.end();
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.purpose, 'reply');
  assert.equal(result.data.waitedMs, 0);
  assert.equal(result.data.quiet, true);
  assert.equal(result.data.timeout, false);
  assert.equal(result.data.arrived, false);
  assert.deepEqual(result.data.newMessages.map((message) => message.seq), []);
  assert.equal(result.data.waitLimitReached, false);
  assert.equal(result.data.preSleepWaitObserved, false);
  assert.equal(result.data.preSleepWaitSatisfied, false);
});
