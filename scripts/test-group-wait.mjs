// 群聊等待策略回归：真实 bridge HTTP handler + 虚拟时钟（测试中不产生真实的 3s/6s sleep）。
// 覆盖：3 秒静默、6 秒硬期限抗续延、显式 quietMs=60000 被钳、无消息观察窗口、minNew>1、
// 边界新消息、私聊不变、权限变化、断连，以及未读/水位不被清空（不自动 mark_read）。
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { groupWaitPolicy } from '../src/core/group-wait-policy.mjs';
// 端口安全辅助（唯一来源）：fetch blocked 端口表 + listen(0) 重试取可 fetch 端口。
import { closeServer, isFetchBlockedPort, MAX_PORT_ATTEMPTS } from './test-port-safe.mjs';

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

// ── 端口选择：避开 Node 内置 fetch(undici) 的 blocked-port 列表 ────────────────
//
// 背景（环境 flake，已复现证据）：harness 用 `consolePort: 0` 让 OS 分配临时端口，而本机
// Windows 动态端口范围是 **1024–15000**（`netsh int ipv4 show dynamicportrange tcp`），它与
// undici 的 blocked-port 列表重叠 13 个端口（3659/4045/5060/5061/6000/6566/6665-6669/6697/10080）。
// 实测 8000 次 listen(0)：min=2831 max=11233，**12 次落到 blocked 端口**（≈0.15%/次）。
// 一旦 fixture 拿到这些端口，`fetch()` 会抛 `TypeError: fetch failed`（cause: `bad port`）——
// 这就是 quick 里偶发失败的根因。端口表与重试助手统一在 scripts/test-port-safe.mjs；
// 这里保留 startConsoleServer 专用循环（命中 blocked 端口就关闭并重新 startConsoleServer，
// 只换端口，不吞真实请求失败、不改被测生产代码）。
async function startConsoleServerOnFetchablePort(h) {
  for (let attempt = 1; attempt <= MAX_PORT_ATTEMPTS; attempt += 1) {
    const server = h.startConsoleServer();
    if (!server.listening) {
      await new Promise((resolve) => { server.once('listening', resolve); });
    }
    const port = server.address().port;
    if (!isFetchBlockedPort(port)) {
      if (attempt > 1) {
        console.log(`[test-group-wait] 丢弃 fetch blocked port，第 ${attempt} 次重试后使用 ${port}`);
      }
      return { server, port };
    }
    // 命中 blocked 端口：只换端口，绝不把后续真实失败当 flake —— 关闭后重取。
    await closeServer(server);
  }
  throw new Error(`test-group-wait: 连续 ${MAX_PORT_ATTEMPTS} 次拿到 fetch blocked 端口，无法建立可 fetch 的本地服务`);
}

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
  const { server, port } = await startConsoleServerOnFetchablePort(h);
  assert.equal(isFetchBlockedPort(port), false, `fixture 端口 ${port} 不得在 Node fetch blocked-port 列表内`);

  const append = (text) => {
    h.appendSocialV2Message(key, 'fixture-person', text, text, false, false, `fixture-${(st.lastUnreadSeq || 0) + 1}`, [], '789', []);
    // append 可能顺带排回复检查/唤醒定时器；它们不属于本次等待，清掉避免干扰虚拟时间。
    h.cancelReplyCheckV2?.(key);
    h.cancelPendingWakeTimerV2?.(key, st);
    return st.lastUnreadSeq || 0;
  };
  const appendAt = (delayMs, text) => clock.schedule(delayMs, () => append(text));

  // task-81：请求改用 node:http，不用全局 fetch(undici)。
  // 根因（已复现）：undici 自带 blocked-port 列表（3659/4045/5060/5061/6000/6566/6665-6669/6697/10080），
  // 与 Windows 动态端口范围（1024–15000）重叠；即使本文件已避开 blocked 端口拿 listen(0)，
  // 全量负载下仍偶见 `TypeError: fetch failed`（bad port / 共享 dispatcher 调度）。
  // http.request 没有该黑名单、也不共享全局 dispatcher，错误面只剩本地连接与超时。
  // 断言与返回形状（{status, data}）保持不变，不改被测生产代码。
  const request = async (route, body, signal) => {
    const payload = JSON.stringify({ key, ...body });
    const { status, raw } = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: `/api/socialV2/${route}`,
        method: 'POST',
        // 每个请求新建连接：不与测试内其他请求复用 socket（旧 fetch 走连接池，server 关闭时
        // 仍可能复用半关闭连接导致 ECONNRESET；这些测试的请求量很小，开销可忽略）。
        agent: false,
        headers: {
          'x-console-token': 'fixture-console-token',
          'x-agent-token': st.agentToken,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
      });
      req.setTimeout(10000, () => req.destroy(new Error('fixture request timeout (10000ms)')));
      signal?.addEventListener?.('abort', () => {
        const aborted = new Error('fixture request aborted');
        aborted.name = 'AbortError';
        req.destroy(aborted);
      }, { once: true });
      req.on('error', reject);
      req.end(payload);
    });
    let data = null;
    try { data = JSON.parse(raw); } catch { /* 非 JSON 错误页交给调用方按 status 断言 */ }
    return { status, data };
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

test('私聊 reply 等待：快照已读后只补等 lastIncomingAt 剩余约 2 秒', async (t) => {
  const f = await fixture(t, { key: 'private:123' });
  const seq = f.append('already handled');
  assert.ok(seq >= 1, `append 未产生消息：${seq}`);
  await f.h.sendWakePromptV2(f.key, 'question');
  // 不手工清未读/水位：走真实快照投递，让 readThroughSeq 覆盖这条已有消息。
  f.st.lastIncomingAt = f.clock.now() - 1000;
  f.clock.begin();
  const result = await f.request('wait', { purpose: 'reply', timeoutMs: 8000 });
  f.clock.end();
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.purpose, 'reply');
  assert.equal(result.data.quietMs, 3000);
  assert.equal(result.data.quiet, true);
  assert.equal(result.data.timeout, false);
  assert.equal(result.data.arrived, false);
  assert.deepEqual(result.data.newMessages.map((message) => message.seq), []);
  assert.equal(result.data.waitLimitReached, false);
  assert.ok(result.data.waitedMs >= 1900 && result.data.waitedMs <= 2100, `waitedMs=${result.data.waitedMs}`);
});

test('私聊 reply 等待：lastIncomingAt 已安静 10 秒时立即返回 waitedMs=0，不伪造观察', async (t) => {
  const f = await fixture(t, { key: 'private:123' });
  f.append('already quiet');
  await f.h.sendWakePromptV2(f.key, 'question');
  f.st.lastIncomingAt = f.clock.now() - 10000;
  f.clock.begin();
  const result = await f.request('wait', { purpose: 'reply', timeoutMs: 8000 });
  f.clock.end();
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.purpose, 'reply');
  assert.equal(result.data.quietMs, 3000);
  assert.equal(result.data.waitedMs, 0);
  assert.equal(result.data.quiet, true);
  assert.equal(result.data.timeout, false);
  assert.equal(result.data.arrived, false);
  assert.deepEqual(result.data.newMessages.map((message) => message.seq), []);
  assert.equal(result.data.waitLimitReached, false);
  assert.equal(result.data.preSleepWaitObserved, false);
  assert.equal(result.data.preSleepWaitSatisfied, false);
  assert.equal(f.st.preSleepWaitObservedAt, 0);
  assert.equal(f.st.preSleepWaitSatisfiedAt, 0);
});

test('私聊 reply 等待：未读与新到消息按固定 3 秒返回，不清未读也不记录观察', async (t) => {
  const f = await fixture(t, { key: 'private:123' });
  f.append('unread before wait');
  f.st.lastIncomingAt = f.clock.now();
  f.appendAt(200, 'arrived while waiting');
  f.clock.begin();
  const result = await f.request('wait', { purpose: 'reply', timeoutMs: 8000 });
  f.clock.end();
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.purpose, 'reply');
  assert.equal(result.data.quietMs, 3000);
  assert.equal(result.data.suggestedQuietMs, 3000);
  assert.equal(result.data.arrived, true);
  assert.equal(result.data.quiet, true);
  assert.equal(result.data.timeout, false);
  assert.deepEqual(result.data.newMessages.map((message) => message.seq), [1, 2]);
  assert.equal(result.data.readThroughSeq, 2);
  assert.equal(f.st.unread.length, 2, 'reply 等待不得自动 mark_read / 清空未读');
  assert.equal(result.data.preSleepWaitObserved, false);
  assert.equal(result.data.preSleepWaitSatisfied, false);
  assert.ok(result.data.waitedMs >= 2900 && result.data.waitedMs <= 3500, `waitedMs=${result.data.waitedMs}`);
});

test('私聊 reply 等待：显式 quietMs=60000 与后台 minQuietAfterNewMs=10000 都固定按 3000', async (t) => {
  const f = await fixture(t, {
    key: 'private:123',
    config: { wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 10000 } },
  });
  f.st.lastIncomingAt = f.clock.now();
  f.appendAt(200, 'hello');
  f.clock.begin();
  const result = await f.request('wait', { purpose: 'reply', timeoutMs: 300000, quietMs: 60000 });
  f.clock.end();
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.purpose, 'reply');
  assert.equal(result.data.quietMs, 3000);
  assert.equal(result.data.arrived, true);
  assert.equal(result.data.quiet, true);
  assert.equal(result.data.timeout, false);
  assert.ok(result.data.waitedMs >= 2900 && result.data.waitedMs <= 3500, `waitedMs=${result.data.waitedMs}`);
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

test('replyTimingV2：群聊与私聊 reply 都固定 3 秒且按真实 lastIncomingAt 算剩余', async (t) => {
  const f = await fixture(t, {
    // 后台 quiet 配置 < 3000ms：群聊和私聊 reply 仍必须是 3 秒；私聊 messages 不变。
    config: { wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 1500, replyQuietMs: 1500, quietMs: 1500 } },
  });
  const timingFn = f.h.replyTimingV2;
  assert.equal(typeof timingFn, 'function', 'bridgeHarness 需要暴露 replyTimingV2 才能锁定该回归');
  f.st.lastIncomingAt = f.clock.now() - 4000; // 已经真实安静 4 秒
  const groupTiming = timingFn(f.st, 'group:456');
  assert.equal(groupTiming.quietMs, 3000, '群聊窗口固定 3 秒，不受后台更小配置影响');
  assert.equal(groupTiming.remainingQuietMs, 0, '真实安静 4 秒后不应再提示剩余等待');
  // 私聊 reply 同样固定 3 秒：不再沿用冻结实现的旧 8 秒窗口。
  const privateSt = f.h.getSocialV2State('private:123');
  privateSt.lastIncomingAt = f.clock.now() - 4000;
  const privateTiming = timingFn(privateSt, 'private:123');
  assert.equal(privateTiming.quietMs, 3000);
  assert.equal(privateTiming.remainingQuietMs, 0);
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

test('私聊 messages 省略 quietMs：按后台默认 10000ms，短等待不授予睡前观察', async (t) => {
  const f = await fixture(t, {
    key: 'private:123',
    config: { wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 10000 } },
  });
  f.clock.begin();
  const result = await f.request('wait', { purpose: 'messages', timeoutMs: 500 });
  f.clock.end();
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.purpose, 'messages');
  // 私聊 messages 省略 quietMs：不套用 replyTiming=3000，使用后台原默认值。
  assert.equal(result.data.quietMs, 10000);
  assert.equal(result.data.suggestedQuietMs, 10000);
  assert.equal(result.data.arrived, false);
  assert.equal(result.data.quiet, false);
  assert.equal(result.data.timeout, true);
  assert.equal(result.data.waitLimitReached, false);
  assert.deepEqual(result.data.newMessages.map((message) => message.seq), []);
  // 只等了 500ms，离 5 分钟观察窗口还很远，不能误报睡前观察成立。
  assert.equal(result.data.preSleepWaitSatisfied, false);
  assert.equal(result.data.preSleepWaitObserved, false);
});

test('私聊 reply 等待：每秒补话并显式对齐 lastIncomingAt，末条 8s 后 3s 返回 1..8', async (t) => {
  const f = await fixture(t, {
    key: 'private:123',
    config: { wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 10000 } },
  });
  f.st.lastIncomingAt = f.clock.now();
  for (let second = 1; second <= 8; second += 1) {
    f.clock.schedule(second * 1000, () => {
      f.append(`supplement ${second}`);
      // 补话到达后显式把最后来信时间对齐虚拟时钟：reply 静默从这一刻重新计 3 秒。
      f.st.lastIncomingAt = f.clock.now();
    });
  }
  f.clock.begin();
  const result = await f.request('wait', { purpose: 'reply', timeoutMs: 20000 });
  f.clock.end();
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.purpose, 'reply');
  assert.equal(result.data.quietMs, 3000);
  assert.equal(result.data.quiet, true);
  assert.equal(result.data.arrived, true);
  assert.equal(result.data.timeout, false);
  // 私聊 reply 没有群聊的 6 秒硬上限：补话持续 8 秒也不触发 waitLimitReached。
  assert.equal(result.data.waitLimitReached, false);
  assert.deepEqual(result.data.newMessages.map((message) => message.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  // 最后一条 8 秒到达，再等 3 秒静默，约 11 秒才返回。
  assert.ok(result.data.waitedMs >= 10900 && result.data.waitedMs <= 11300, `waitedMs=${result.data.waitedMs}`);
  // reply 等待不清未读、也不得误授予睡前观察资格。
  assert.equal(f.st.lastUnreadSeq, 8);
  assert.equal(result.data.preSleepWaitObserved, false);
  assert.equal(result.data.preSleepWaitSatisfied, false);
});
