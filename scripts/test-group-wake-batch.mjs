// 群聊唤醒合并窗口集成测试：真实 bridge + fake clock + 假 peer，不发真实 QQ / DSH / 网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { groupWakeBatchMs } from '../src/core/group-wake-batch.mjs';

const BASE = Date.UTC(2026, 9, 18, 12, 0, 0);
const GROUP = 'group:456';
const PRIVATE = 'private:123';

function fakeClock(start = BASE) {
  let at = start;
  let serial = 0;
  const active = new Map();
  return {
    now: () => at,
    setTimeout(fn, ms) {
      const handle = { fn, ms, due: at + ms, serial: serial++, unref() {} };
      active.set(handle, handle);
      return handle;
    },
    clearTimeout(handle) { active.delete(handle); },
    advance(ms) {
      const until = at + ms;
      for (;;) {
        const next = [...active.values()]
          .filter((handle) => handle.due <= until)
          .sort((a, b) => a.due - b.due || a.serial - b.serial)[0];
        if (!next) break;
        at = next.due;
        active.delete(next);
        next.fn();
      }
      at = until;
    },
  };
}

const flush = async () => {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

// 定时器回调里的唤醒投递是异步的；给它几轮微任务，必要时推进假时钟（投递链路内部的假定时器）。
async function waitForPrompt(h, clock, expected = 1, budgetMs = 15000) {
  for (let spent = 0; spent <= budgetMs; spent += 50) {
    await flush();
    if (h.calls.prompts.length >= expected) return h.calls.prompts.length;
    if (spent < budgetMs) clock.advance(50);
  }
  return h.calls.prompts.length;
}

async function withBridge(run) {
  const clock = fakeClock();
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now()])); }
    static now() { return clock.now(); }
  }
  const h = await bridgeHarness({
    config: { socialV2: { enabled: true } },
    globals: {
      Date: ClockDate,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      // 生产 import 由统一改动接入；测试用 globals 注入同一纯函数，保持文件所有权边界。
      groupWakeBatchMs,
    },
  });
  h.setMode('reserved2');
  h.socialV2.paused = false;
  try {
    await run(h, clock);
  } finally {
    await h.close();
  }
}

function groupState(h) {
  return h.getSocialV2State(GROUP);
}

test('groupWakeBatchMs: private 保持 Math.max(1000, configured || 8000) 原样', () => {
  assert.equal(groupWakeBatchMs(PRIVATE, 'atMention', undefined), 8000);
  assert.equal(groupWakeBatchMs(PRIVATE, 'keyword:小鲸鱼', 8000), 8000);
  assert.equal(groupWakeBatchMs(PRIVATE, 'question', 60000), 60000);
  assert.equal(groupWakeBatchMs(PRIVATE, 'nameMention', '12345'), 12345);
  // 0 是假值，先被 configured || 8000 回退成 8000，不会落到 1000 下限。
  assert.equal(groupWakeBatchMs(PRIVATE, 'atMention', 0), 8000);
  assert.equal(groupWakeBatchMs(PRIVATE, 'atMention', 10), 1000);
  assert.equal(groupWakeBatchMs(PRIVATE, 'atMention', 'bogus'), 8000);
  assert.equal(groupWakeBatchMs('private:999', 'poke', null), 8000);
});

test('groupWakeBatchMs: 群明确触发 2000ms、普通触发 4000ms', () => {
  for (const reason of ['atMention', 'nameMention', 'question', 'atMention:extra']) {
    assert.equal(groupWakeBatchMs(GROUP, reason, undefined), 2000, reason);
    assert.equal(groupWakeBatchMs(GROUP, reason, 8000), 2000, reason);
    assert.equal(groupWakeBatchMs(GROUP, reason, 60000), 2000, reason);
  }
  for (const reason of ['keyword:小鲸鱼', 'speaker:昵称', 'anyMessage', 'probability', 'poke', 'replyCheck', 'timeout', 'proactiveCheck', 'unknown', '']) {
    assert.equal(groupWakeBatchMs(GROUP, reason, undefined), 4000, reason);
    assert.equal(groupWakeBatchMs(GROUP, reason, 8000), 4000, reason);
    assert.equal(groupWakeBatchMs(GROUP, reason, 60000), 4000, reason);
  }
});

test('groupWakeBatchMs: 更短既有配置取 min，零配置先回退再按上限截断', () => {
  for (const reason of ['atMention', 'keyword:短窗']) {
    const fallback = reason === 'atMention' ? 2000 : 4000;
    assert.equal(groupWakeBatchMs(GROUP, reason, 1000), 1000, reason);
    assert.equal(groupWakeBatchMs(GROUP, reason, '1000'), 1000, reason);
    assert.equal(groupWakeBatchMs(GROUP, reason, 1500), 1500, reason);
    assert.equal(groupWakeBatchMs(GROUP, reason, 500), 1000, reason);
    // 0 同样被 configured || 8000 回退成 8000，再由群聊上限截到 2000/4000，不是 1000。
    assert.equal(groupWakeBatchMs(GROUP, reason, 0), fallback, reason);
    assert.equal(groupWakeBatchMs(GROUP, reason, -1), 1000, reason);
    assert.equal(groupWakeBatchMs(GROUP, reason, 'bogus'), fallback, reason);
  }
  assert.equal(groupWakeBatchMs(GROUP, 'atMention', 2000), 2000);
  assert.equal(groupWakeBatchMs(GROUP, 'keyword:x', 4000), 4000);
  assert.equal(groupWakeBatchMs(GROUP, 'atMention', 2500), 2000);
});

test('groupWakeBatchMs: 仅 group: 前缀应用群聊上限', () => {
  assert.equal(groupWakeBatchMs(undefined, 'atMention', undefined), 8000);
  assert.equal(groupWakeBatchMs(null, 'question', 60000), 60000);
  assert.equal(groupWakeBatchMs('private:1', 'atMention', 30000), 30000);
  assert.equal(groupWakeBatchMs('GROUP:456', 'atMention', 8000), 8000);
  assert.equal(groupWakeBatchMs('group', 'atMention', 8000), 8000);
  assert.equal(groupWakeBatchMs(123, 'atMention', 8000), 8000);
});

test('private 默认窗口 8s（独立 fixture，避免首次投递后的 busy 状态干扰）', async () => {
  await withBridge(async (h, clock) => {
    const st = h.getSocialV2State(PRIVATE);
    h.scheduleWakeV2(PRIVATE, 'atMention', { seq: 1 });
    assert.equal(st.pendingWakeTimer.ms, 8000);
    assert.equal(st.pendingWakeDueAt, clock.now() + 8000);
    clock.advance(7999);
    assert.equal(st.pendingWakeReason, 'atMention');
    assert.equal(h.calls.prompts.length, 0);
    clock.advance(1);
    assert.equal(st.pendingWakeReason, null);
    assert.equal(st.pendingWakeDueAt, null);
    assert.equal(await waitForPrompt(h, clock), 1);
  });
});

test('private 显式 60s 不被群聊上限改写（独立 fixture）', async () => {
  await withBridge(async (h, clock) => {
    const st = h.getSocialV2State(PRIVATE);
    st.wakeConfig.batchWindowMs = 60000;
    h.scheduleWakeV2(PRIVATE, 'keyword:显式长窗', { seq: 1 });
    assert.equal(st.pendingWakeTimer.ms, 60000);
    assert.equal(st.pendingWakeDueAt, clock.now() + 60000);
    clock.advance(59999);
    assert.equal(st.pendingWakeReason, 'keyword:显式长窗');
    assert.equal(h.calls.prompts.length, 0);
    clock.advance(1);
    assert.equal(st.pendingWakeReason, null);
    assert.equal(st.pendingWakeDueAt, null);
    assert.equal(await waitForPrompt(h, clock), 1);
  });
});

test('group 普通触发 4s、明确触发 2s，旧 8s/60s 配置不覆盖上限', async () => {
  const cases = [
    ['keyword:小鲸鱼', 8000, 4000],
    ['anyMessage', 8000, 4000],
    ['speaker:昵称', 60000, 4000],
    ['poke', 60000, 4000],
    ['atMention', 8000, 2000],
    ['nameMention', 8000, 2000],
    ['question', 60000, 2000],
    ['atMention:extra', 60000, 2000],
  ];
  for (const [reason, configured, expected] of cases) {
    await withBridge(async (h, clock) => {
      const st = groupState(h);
      st.wakeConfig.batchWindowMs = configured;
      h.scheduleWakeV2(GROUP, reason, { seq: 1 });
      assert.equal(st.pendingWakeTimer.ms, expected, `${reason}/${configured}`);
      assert.equal(st.pendingWakeDueAt, clock.now() + expected, `${reason}/${configured}`);
      clock.advance(expected - 1);
      assert.equal(st.pendingWakeReason, reason, `${reason}/${configured} 不应提前`);
      assert.equal(h.calls.prompts.length, 0, `${reason}/${configured} 不应提前投递`);
      clock.advance(1);
      assert.equal(st.pendingWakeReason, null, `${reason}/${configured} 到点清状态`);
      assert.equal(st.pendingWakeDueAt, null, `${reason}/${configured} 到点清 due`);
      assert.equal(await waitForPrompt(h, clock), 1, `${reason}/${configured} 到点投递`);
    });
  }
});

test('group 尊重更短的既有配置（1000ms 取 min）', async () => {
  for (const [reason, configured, expected] of [
    ['keyword:短窗', 1000, 1000],
    ['atMention', 1000, 1000],
    ['keyword:短窗', 1500, 1500],
  ]) {
    await withBridge(async (h, clock) => {
      const st = groupState(h);
      st.wakeConfig.batchWindowMs = configured;
      h.scheduleWakeV2(GROUP, reason, { seq: 1 });
      assert.equal(st.pendingWakeTimer.ms, expected, `${reason}/${configured}`);
      clock.advance(expected - 1);
      assert.equal(st.pendingWakeReason, reason, `${reason}/${configured}`);
      clock.advance(1);
      assert.equal(st.pendingWakeReason, null, `${reason}/${configured}`);
    });
  }
});

test('普通窗口内升级为明确触发会缩短剩余期限并采用新 seq/owner', async () => {
  await withBridge(async (h, clock) => {
    const st = groupState(h);
    h.scheduleWakeV2(GROUP, 'keyword:普通', { seq: 1 });
    const first = st.pendingWakeTimer;
    const firstDue = st.pendingWakeDueAt;
    assert.equal(first.ms, 4000);
    assert.equal(firstDue, clock.now() + 4000);

    clock.advance(1000);
    h.scheduleWakeV2(GROUP, 'atMention', { seq: 2, ownerLetter: true });

    assert.notEqual(st.pendingWakeTimer, first);
    assert.equal(st.pendingWakeReason, 'atMention');
    assert.equal(st.pendingWakeSeq, 2);
    assert.equal(st.pendingWakeOwnerLetter, true);
    assert.equal(st.pendingWakeDueAt, clock.now() + 2000);
    assert.ok(st.pendingWakeDueAt < firstDue, '升级只能提前');
    assert.equal(st.pendingWakeTimer.ms, 2000);

    first.fn();
    assert.equal(st.pendingWakeReason, 'atMention', '旧 timer 迟到回调不得清状态');
    assert.equal(st.pendingWakeTimer.ms, 2000, '旧 timer 迟到回调不得替换新 timer');
    assert.equal(h.calls.prompts.length, 0);

    clock.advance(1999);
    assert.equal(st.pendingWakeReason, 'atMention');
    assert.equal(h.calls.prompts.length, 0);
    clock.advance(1);
    assert.equal(st.pendingWakeReason, null);
    assert.equal(await waitForPrompt(h, clock), 1);
  });
});

test('迟到升级不得把已更早的 timer 往后推', async () => {
  await withBridge(async (h, clock) => {
    const st = groupState(h);
    h.scheduleWakeV2(GROUP, 'keyword:普通', { seq: 1 });
    const firstDue = st.pendingWakeDueAt;

    clock.advance(3000);
    h.scheduleWakeV2(GROUP, 'atMention', { seq: 2 });

    assert.equal(st.pendingWakeReason, 'atMention');
    assert.equal(st.pendingWakeSeq, 2);
    assert.equal(st.pendingWakeDueAt, firstDue, 'min(既有 due, now+2s) 应保持原到期时间');
    assert.equal(st.pendingWakeTimer.ms, 1000);

    clock.advance(999);
    assert.equal(st.pendingWakeReason, 'atMention');
    assert.equal(h.calls.prompts.length, 0);
    clock.advance(1);
    assert.equal(st.pendingWakeReason, null);
    assert.equal(await waitForPrompt(h, clock), 1);
  });
});

test('较低或相同优先级不缩窗、不改 seq/owner/timer', async () => {
  await withBridge(async (h, clock) => {
    const st = groupState(h);
    h.scheduleWakeV2(GROUP, 'atMention', { seq: 1, ownerLetter: true });
    const timer = st.pendingWakeTimer;
    const due = st.pendingWakeDueAt;

    clock.advance(500);
    h.scheduleWakeV2(GROUP, 'keyword:较低', { seq: 2, ownerLetter: false });
    h.scheduleWakeV2(GROUP, 'atMention', { seq: 3, ownerLetter: false });

    assert.equal(st.pendingWakeTimer, timer);
    assert.equal(st.pendingWakeDueAt, due);
    assert.equal(st.pendingWakeReason, 'atMention');
    assert.equal(st.pendingWakeSeq, 1);
    assert.equal(st.pendingWakeOwnerLetter, true);
    assert.equal(h.calls.prompts.length, 0);
  });
});

test('取消后旧窗口回调不能清掉或提前触发新的唤醒', async () => {
  await withBridge(async (h, clock) => {
    const st = groupState(h);
    h.scheduleWakeV2(GROUP, 'keyword:old', { seq: 1 });
    const old = st.pendingWakeTimer;
    h.cancelPendingWakeTimerV2(GROUP, st);
    h.scheduleWakeV2(GROUP, 'atMention', { seq: 2 });
    const current = st.pendingWakeTimer;

    old.fn();
    assert.equal(st.pendingWakeTimer, current);
    assert.equal(st.pendingWakeReason, 'atMention');
    assert.equal(st.pendingWakeSeq, 2);
    assert.equal(h.calls.prompts.length, 0);

    clock.advance(1999);
    assert.equal(st.pendingWakeReason, 'atMention');
    clock.advance(1);
    assert.equal(st.pendingWakeReason, null);
    assert.equal(await waitForPrompt(h, clock), 1);
  });
});

test('busy 时暂存原因、同一 (reason,seq) 去重、不并发唤醒', async () => {
  await withBridge(async (h, clock) => {
    const st = groupState(h);
    st.lastUnreadSeq = 9;
    h.pendingWakeKeys.add(GROUP);

    h.scheduleWakeV2(GROUP, 'keyword:忙', { seq: 1 });
    h.scheduleWakeV2(GROUP, 'keyword:忙', { seq: 2 });
    h.scheduleWakeV2(GROUP, 'atMention', { seq: 3 });

    assert.equal(st.pendingWakeReasons.length, 2);
    // vm realm 里创建的数组原型与本进程不同，deepEqual 会误报；先在本 realm 复制再比较。
    assert.deepEqual(Array.from(st.pendingWakeReasons, (item) => item.reason), ['keyword:忙', 'atMention']);
    assert.equal(st.pendingWakeReasons[0].seq, 9);
    assert.equal(st.pendingWakeTimer, null);

    clock.advance(20000);
    await flush();
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(st.pendingWakeTimer, null);
  });
});
