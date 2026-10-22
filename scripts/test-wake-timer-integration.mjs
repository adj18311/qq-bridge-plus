// Real bridge functions + production timer module, fake clock and temporary peers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function fakeClock() {
  let at = Date.UTC(2026, 9, 18, 12);
  let serial = 0;
  const active = new Map();
  const clock = {
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
        const next = [...active.values()].filter(h => h.due <= until)
          .sort((a, b) => a.due - b.due || a.serial - b.serial)[0];
        if (!next) break;
        at = next.due;
        active.delete(next);
        next.fn();
      }
      at = until;
    },
  };
  return clock;
}

async function withBridge(run) {
  const clock = fakeClock();
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now()])); }
    static now() { return clock.now(); }
  }
  const h = await bridgeHarness({
    config: { socialV2: { enabled: true } },
    globals: { Date: ClockDate, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
  });
  h.setMode('reserved2');
  h.socialV2.paused = false;
  try { await run(h, clock); } finally { await h.close(); }
}

test('桥接租约仍是30分钟，撤销不清业务busy标记，到期才释放', () => withBridge((h, clock) => {
  const key = 'private:123';
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  assert.equal(h.pendingWakeLeaseTimers.get(key).ms, 30 * 60 * 1000);
  clock.advance(30 * 60 * 1000 - 1);
  assert.equal(h.pendingWakeKeys.has(key), true);
  clock.advance(1);
  assert.equal(h.pendingWakeKeys.has(key), false);
  assert.equal(h.pendingWakeLeaseTimers.has(key), false);

  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  h.disarmPendingWakeLease(key);
  clock.advance(30 * 60 * 1000);
  assert.equal(h.pendingWakeKeys.has(key), true, '撤销定时器不得擅自清业务busy');
}));

test('桥接旧租约回调强制迟到，也不能删除重排后的新租约或busy', () => withBridge((h) => {
  const key = 'private:123';
  h.pendingWakeKeys.add(key);
  h.armPendingWakeLease(key);
  const old = h.pendingWakeLeaseTimers.get(key);
  h.armPendingWakeLease(key);
  const current = h.pendingWakeLeaseTimers.get(key);
  old.fn();
  assert.equal(h.pendingWakeLeaseTimers.get(key), current);
  assert.equal(h.pendingWakeKeys.has(key), true);
}));

test('桥接取消后的旧合并窗口回调不能清除较新的唤醒', () => withBridge((h) => {
  const key = 'private:123';
  const st = h.getSocialV2State(key);
  st.wakeConfig.batchWindowMs = 1000;
  h.scheduleWakeV2(key, 'keyword:old', { seq: 1 });
  const old = st.pendingWakeTimer;
  assert.ok(old);
  h.cancelPendingWakeTimerV2(key, st);
  h.scheduleWakeV2(key, 'private', { seq: 2, ownerLetter: true });
  const current = st.pendingWakeTimer;
  old.fn();
  assert.equal(st.pendingWakeTimer, current);
  assert.equal(st.pendingWakeReason, 'private');
  assert.equal(st.pendingWakeSeq, 2);
  assert.equal(st.pendingWakeOwnerLetter, true);
  assert.equal(h.calls.prompts.length, 0);
}));

test('桥接远期睡眠沿用原100009ms分段策略与注入时钟，不提前唤醒', () => withBridge((h, clock) => {
  const st = h.getSocialV2State('private:123');
  st.wakeConfig.infinite = false;
  st.wakeConfig.sleepUntil = new Date(clock.now() + 250000).toISOString();
  h.setupSleepTimerV2('private:123');
  assert.equal(st.sleepTimer.ms, 100009);
  clock.advance(100009);
  assert.equal(st.sleepTimer.ms, 100009);
  clock.advance(100009);
  assert.equal(st.sleepTimer.ms, 49982);
  assert.equal(h.calls.prompts.length, 0);
}));

test('桥接旧的外置原生handle也能取消，整体清理保留原业务字段清理', () => withBridge((h, clock) => {
  const key = 'private:123';
  const st = h.getSocialV2State(key);
  let fired = 0;
  for (const slot of ['pendingWakeTimer', 'sleepTimer', 'replyCheckTimer', 'proactiveTimer']) {
    st[slot] = clock.setTimeout(() => fired++, 1000);
  }
  st.pendingWakeReason = 'private';
  st.pendingWakeSeq = 3;
  st.pendingWakeReasons = [{ reason: 'keyword:test', seq: 2 }];
  h.clearSocialV2Timers(key);
  clock.advance(1000);
  for (const slot of ['pendingWakeTimer', 'sleepTimer', 'replyCheckTimer', 'proactiveTimer']) assert.equal(st[slot], null);
  assert.equal(fired, 0);
  assert.equal(st.pendingWakeReason, null);
  assert.equal(st.pendingWakeSeq, null);
  assert.equal(st.pendingWakeReasons.length, 0);
}));

test('桥接清空所有租约不清业务标记，旧回调随后也不能再释放busy', () => withBridge((h) => {
  const old = [];
  for (const key of ['private:123', 'group:456']) {
    h.pendingWakeKeys.add(key);
    h.armPendingWakeLease(key);
    old.push(h.pendingWakeLeaseTimers.get(key));
  }
  h.clearAllPendingWakeLeases();
  assert.equal(h.pendingWakeLeaseTimers.size, 0);
  for (const handle of old) handle.fn();
  assert.equal(h.pendingWakeKeys.size, 2);
}));
