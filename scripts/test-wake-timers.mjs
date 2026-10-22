// Wake timer ownership — 聚焦契约测试（node:test，进程内，无真实定时器/IO）。
//
// 契约来源：docs/superpowers/plans/2026-10-18-wake-timers.md（已批准范围）。
// 测试先于实现：模块缺失时必须得到「工厂不存在」的明确 RED，而不是 import 语法错误。
// 覆盖：deadline、原生 handle/unref、按 owner/slot 隔离、取消（含 legacy 裸 handle）、
// 旧回调被强制投递、替换/重入、数字 handle 复用（注册身份而非 handle 相等）、
// lease 到期/重臂/disarm/clear、回调抛错后的清理由先于业务。
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

let moduleUnderTest = null;
let importFailure = null;
try {
  moduleUnderTest = await import('../src/core/wake-timers.mjs');
} catch (error) {
  importFailure = error;
}

function createFactory() {
  assert.equal(
    importFailure,
    null,
    `src/core/wake-timers.mjs 必须可导入：${importFailure && importFailure.message}`,
  );
  assert.equal(
    typeof moduleUnderTest.createWakeTimers,
    'function',
    'src/core/wake-timers.mjs 必须导出 createWakeTimers 工厂',
  );
  return moduleUnderTest.createWakeTimers;
}

function newTimers(options = {}) {
  const clock = createFakeClock(options);
  const leaseTimers = options.leaseTimers ?? new Map();
  const timers = createFactory()({ clock, leaseTimers });
  return { clock, leaseTimers, timers };
}

// 可注入假时钟：单调推进；取消的回调被保留，供“旧回调强制投递”用例使用；
// 支持数字 handle（复用同一编号）与对象 handle（带 unref spy）。
function createFakeClock({ numericHandles = false } = {}) {
  let nowMs = 0;
  let sequence = 0;
  let reuseHandle;
  const records = [];
  const retained = [];
  const stats = { scheduled: 0, cleared: 0, fired: 0, unrefs: 0, reused: 0 };

  function setTimer(fn, delay) {
    const rec = {
      seq: ++sequence,
      fn,
      due: nowMs + (Number(delay) || 0),
      cancelled: false,
      fired: false,
      staleDelivered: false,
    };
    let handle;
    if (reuseHandle !== undefined) {
      handle = reuseHandle;
      reuseHandle = undefined;
      stats.reused += 1;
    } else if (numericHandles) {
      handle = rec.seq;
    } else {
      handle = {
        id: rec.seq,
        unrefCalls: 0,
        unref() {
          stats.unrefs += 1;
          this.unrefCalls += 1;
          return this;
        },
      };
    }
    rec.handle = handle;
    records.push(rec);
    stats.scheduled += 1;
    return handle;
  }

  function clearTimer(handle) {
    if (handle === undefined || handle === null) return;
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const rec = records[i];
      if (rec.handle === handle && !rec.cancelled && !rec.fired) {
        rec.cancelled = true;
        stats.cleared += 1;
        retained.push(rec);
        return;
      }
    }
  }

  function advance(delta) {
    const target = nowMs + (Number(delta) || 0);
    for (;;) {
      let next = null;
      for (const rec of records) {
        if (rec.cancelled || rec.fired || rec.due > target) continue;
        if (!next || rec.due < next.due || (rec.due === next.due && rec.seq < next.seq)) {
          next = rec;
        }
      }
      if (!next) break;
      nowMs = next.due;
      next.fired = true;
      stats.fired += 1;
      next.fn();
    }
    nowMs = target;
  }

  // 模拟原生时钟在“外部替换后”仍把旧注册的回调投递出来（未显式 cancel）。
  function forceFire(handle) {
    for (const rec of records) {
      if (rec.handle === handle && !rec.fired) {
        rec.fired = true;
        stats.fired += 1;
        rec.fn();
        return true;
      }
    }
    return false;
  }

  function forceStale(handle) {
    for (const rec of retained) {
      if (rec.handle === handle && !rec.staleDelivered) {
        rec.staleDelivered = true;
        rec.fn();
        return true;
      }
    }
    return false;
  }

  function reuseWith(handle) {
    reuseHandle = handle;
  }

  return {
    now: () => nowMs,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    advance,
    forceFire,
    forceStale,
    reuseWith,
    stats,
    pendingCount: () => records.filter((rec) => !rec.cancelled && !rec.fired).length,
  };
}

test('模块可导入、导出惰性工厂，导入与建厂不注册任何定时器', () => {
  const createWakeTimers = createFactory();
  const clock = createFakeClock();
  const leaseTimers = new Map();
  const timers = createWakeTimers({ clock, leaseTimers });
  for (const method of ['schedule', 'cancel', 'now', 'armLease', 'disarmLease', 'clearLeases']) {
    assert.equal(typeof timers[method], 'function', `timers.${method} 必须是函数`);
  }
  assert.equal(clock.stats.scheduled, 0, '导入/建厂不得注册定时器');
  assert.equal(clock.stats.cleared, 0);
  assert.equal(leaseTimers.size, 0);
  assert.equal(timers.now(), 0);
});

test('schedule：到期才执行；原生 handle 落到 owner 槽位并 unref；now 暴露注入时钟', () => {
  const { clock, timers } = newTimers();
  const st = {};
  const seen = [];
  const handle = timers.schedule(st, 'sleepTimer', 500, () => {
    seen.push(clock.now());
    assert.equal(st.sleepTimer, null, '业务回调执行前槽位必须已清空');
  });

  assert.equal(st.sleepTimer, handle, 'schedule 必须返回并存储原生 handle');
  assert.equal(handle.unrefCalls, 1, '支持 unref 的 handle 必须 unref');
  assert.equal(timers.now(), 0);

  clock.advance(499);
  assert.deepEqual(seen, [], '未到 deadline 不得执行');
  assert.equal(st.sleepTimer, handle);

  clock.advance(1);
  assert.deepEqual(seen, [500], '恰好到期执行一次');
  assert.equal(timers.now(), 500, 'now() 必须来自注入时钟');
  assert.equal(st.sleepTimer, null);
  assert.equal(clock.pendingCount(), 0);
});

test('schedule：按 owner 对象与 slot 独立隔离', () => {
  const { clock, timers } = newTimers();
  const a = {};
  const b = {};
  const seen = [];
  timers.schedule(a, 'sleepTimer', 100, () => seen.push('a.sleep'));
  timers.schedule(b, 'sleepTimer', 200, () => seen.push('b.sleep'));
  timers.schedule(a, 'proactiveTimer', 300, () => seen.push('a.proactive'));

  clock.advance(100);
  assert.deepEqual(seen, ['a.sleep']);
  assert.equal(a.sleepTimer, null);
  assert.notEqual(b.sleepTimer, null, 'a 的到期不得清掉 b 的槽位');

  clock.advance(100);
  assert.deepEqual(seen, ['a.sleep', 'b.sleep']);

  clock.advance(100);
  assert.deepEqual(seen, ['a.sleep', 'b.sleep', 'a.proactive']);
});

test('cancel：清除原生 handle、置 null、幂等布尔，且不影响其他 owner', () => {
  const { clock, timers } = newTimers();
  const a = {};
  const b = {};
  const seen = [];
  const h = timers.schedule(a, 'sleepTimer', 100, () => seen.push('a'));
  timers.schedule(b, 'sleepTimer', 100, () => seen.push('b'));

  assert.equal(timers.cancel(a, 'sleepTimer'), true, '取消已注册 slot 必须返回 true');
  assert.equal(a.sleepTimer, null);
  assert.equal(clock.stats.cleared, 1);
  assert.equal(timers.cancel(a, 'sleepTimer'), false, '重复取消必须返回 false');
  assert.equal(clock.stats.cleared, 1, '重复取消不得重复 clearTimeout');
  assert.equal(clock.forceStale(h), true, '被取消的旧回调应可被强制投递');
  assert.deepEqual(seen, [], '被取消的回调不得执行业务');

  clock.advance(100);
  assert.deepEqual(seen, ['b'], '取消 a 不得影响 b');
  assert.equal(b.sleepTimer, null);
});

test('cancel：兼容外部写入的 legacy 裸 handle', () => {
  const { clock, timers } = newTimers();
  const st = {};
  const seen = [];
  const legacyHandle = clock.setTimeout(() => seen.push('legacy'), 50);
  st.legacySleepTimer = legacyHandle;

  assert.equal(timers.cancel(st, 'legacySleepTimer'), true, '必须能取消旧调用点留下的裸 handle');
  assert.equal(st.legacySleepTimer, null);
  assert.equal(timers.cancel(st, 'legacySleepTimer'), false);

  clock.advance(50);
  assert.deepEqual(seen, [], 'legacy handle 必须被 clearTimeout');
});

test('回调触发前先失效注册并清空槽位（业务代码看到 null / cancel=false）', () => {
  const { clock, timers } = newTimers();
  const st = {};
  let observed = null;
  timers.schedule(st, 'sleepTimer', 10, () => {
    observed = { slot: st.sleepTimer, cancelResult: timers.cancel(st, 'sleepTimer') };
  });
  clock.advance(10);
  assert.deepEqual(observed, { slot: null, cancelResult: false });
});

test('被取消的旧回调强制投递：不得执行业务、不得清空槽位', () => {
  const { clock, timers } = newTimers();
  const st = {};
  const seen = [];
  const handle = timers.schedule(st, 'sleepTimer', 100, () => seen.push('old'));
  assert.equal(timers.cancel(st, 'sleepTimer'), true);

  assert.equal(clock.forceStale(handle), true, '假时钟应已保留被取消回调');
  assert.deepEqual(seen, [], '旧回调不得执行');
  assert.equal(st.sleepTimer, null, '旧回调不得重新写槽位');

  clock.advance(100);
  assert.deepEqual(seen, []);
});

test('同 slot 替换：旧注册失效、旧回调强制投递不得清掉新 handle', () => {
  const { clock, timers } = newTimers();
  const st = {};
  const seen = [];
  const oldHandle = timers.schedule(st, 'sleepTimer', 100, () => seen.push('old'));
  const newHandle = timers.schedule(st, 'sleepTimer', 50, () => seen.push('new'));

  assert.equal(st.sleepTimer, newHandle);
  assert.notEqual(oldHandle, newHandle);
  assert.equal(clock.forceStale(oldHandle), true);
  assert.deepEqual(seen, [], '被替换的旧回调不得执行');
  assert.equal(st.sleepTimer, newHandle, '旧回调不得清掉新 handle');

  clock.advance(50);
  assert.deepEqual(seen, ['new']);
  assert.equal(st.sleepTimer, null);
});

test('数字 handle 复用：必须用注册身份判断，不得按 handle 数值相等误判', () => {
  const { clock, timers } = newTimers({ numericHandles: true });
  const st = {};
  const seen = [];
  const oldHandle = timers.schedule(st, 'sleepTimer', 100, () => seen.push('old'));
  assert.equal(typeof oldHandle, 'number');
  assert.equal(timers.cancel(st, 'sleepTimer'), true);

  clock.reuseWith(oldHandle);
  const newHandle = timers.schedule(st, 'sleepTimer', 50, () => seen.push('new'));
  assert.equal(newHandle, oldHandle, '假时钟必须复用同一数字 handle');
  assert.equal(st.sleepTimer, newHandle);

  assert.equal(clock.forceStale(oldHandle), true, '旧回调必须被强制投递以验证身份判断');
  assert.deepEqual(seen, [], '旧注册的回调不得执行');
  assert.equal(st.sleepTimer, newHandle, '旧回调不得清掉复用了同一数值的新 handle');

  clock.advance(50);
  assert.deepEqual(seen, ['new'], '新注册必须正常到期执行');
});

test('槽位被外部置 null：强制到期/自然到期都不得执行业务回调', () => {
  const { clock, timers } = newTimers();
  const st = {};
  const seen = [];
  timers.schedule(st, 'sleepTimer', 100, () => seen.push('orphan'));
  st.sleepTimer = null;

  clock.advance(100);
  assert.deepEqual(seen, [], '外部置 null 的旧注册不得执行回调');
  assert.equal(st.sleepTimer, null);
});

test('槽位被外部替换为新 handle：旧回调到期不得清掉更新的 handle', () => {
  const { clock, timers } = newTimers();
  const st = {};
  const seen = [];
  timers.schedule(st, 'sleepTimer', 100, () => seen.push('old'));
  const newer = clock.setTimeout(() => seen.push('raw-newer'), 200);
  st.sleepTimer = newer;

  clock.advance(100);
  assert.deepEqual(seen, [], '旧回调不得执行');
  assert.equal(st.sleepTimer, newer, '不得清掉外部写入的更新 handle');

  clock.advance(100);
  assert.deepEqual(seen, ['raw-newer'], '更新的 handle 必须保持有效');
});

test('业务回调抛错：清理先于业务，异常继续上抛且不残留注册', () => {
  const { clock, timers } = newTimers();
  const st = {};
  timers.schedule(st, 'sleepTimer', 10, () => {
    throw new Error('sleep boom');
  });
  assert.throws(() => clock.advance(10), /sleep boom/);
  assert.equal(st.sleepTimer, null, '抛错后槽位必须已清空');
  assert.equal(timers.cancel(st, 'sleepTimer'), false, '注册必须已失效');
  clock.advance(10);
});

test('armLease：到期执行、Map 可观察、业务执行前删除 key', () => {
  const { clock, leaseTimers, timers } = newTimers();
  const seen = [];
  let inside = null;
  timers.armLease('private:1', 1000, () => {
    inside = { has: leaseTimers.has('private:1'), value: leaseTimers.get('private:1') };
    seen.push('lease');
  });
  assert.equal(leaseTimers.size, 1);
  assert.ok(leaseTimers.get('private:1') !== undefined, 'Map 中必须能观察到原生 handle');

  clock.advance(999);
  assert.deepEqual(seen, []);
  assert.equal(leaseTimers.size, 1);

  clock.advance(1);
  assert.deepEqual(seen, ['lease']);
  assert.deepEqual(inside, { has: false, value: undefined }, '业务回调前必须已从 Map 移除');
  assert.equal(leaseTimers.size, 0);
});

test('armLease：同一 key 只保留一个注册，旧 lease 强制投递不得误删新注册', () => {
  const { clock, leaseTimers, timers } = newTimers();
  const seen = [];
  timers.armLease('group:9', 100, () => seen.push('old'));
  const oldHandle = leaseTimers.get('group:9');
  assert.ok(oldHandle !== undefined);

  timers.armLease('group:9', 50, () => seen.push('new'));
  assert.equal(leaseTimers.size, 1, '一个 key 只能有一个注册');

  assert.equal(clock.forceStale(oldHandle), true);
  assert.deepEqual(seen, [], '旧 lease 回调不得执行');
  assert.equal(leaseTimers.has('group:9'), true, '旧 lease 不得删除新注册');

  clock.advance(50);
  assert.deepEqual(seen, ['new']);
  assert.equal(leaseTimers.size, 0);
});

test('disarmLease/clearLeases：取消后不投递、幂等、可清空全部 key', () => {
  const { clock, leaseTimers, timers } = newTimers();
  const seen = [];
  timers.armLease('a', 100, () => seen.push('a'));
  timers.armLease('b', 200, () => seen.push('b'));

  timers.disarmLease('a');
  assert.equal(leaseTimers.has('a'), false);
  timers.disarmLease('a');
  assert.equal(leaseTimers.has('a'), false, '重复 disarm 必须幂等');

  clock.advance(100);
  assert.deepEqual(seen, [], 'a 已 disarm，不得执行');
  clock.advance(100);
  assert.deepEqual(seen, ['b']);

  timers.armLease('c', 10, () => seen.push('c'));
  timers.armLease('d', 10, () => seen.push('d'));
  timers.clearLeases();
  assert.equal(leaseTimers.size, 0, 'clearLeases 必须清空全部 key');
  clock.advance(10);
  assert.deepEqual(seen, ['b'], 'clearLeases 后不得再执行任何 lease 回调');
  timers.clearLeases();
});

test('lease 到期回调内重臂同一 key：新注册保留并在新 TTL 后执行', () => {
  const { clock, leaseTimers, timers } = newTimers();
  const order = [];
  timers.armLease('reentrant', 100, () => {
    order.push('first');
    assert.equal(leaseTimers.has('reentrant'), false, '旧注册必须先移除');
    timers.armLease('reentrant', 200, () => order.push('second'));
    assert.equal(leaseTimers.has('reentrant'), true, '重臂必须立即生效');
  });

  clock.advance(100);
  assert.deepEqual(order, ['first']);
  assert.equal(leaseTimers.size, 1);

  clock.advance(199);
  assert.deepEqual(order, ['first'], '新 lease 不得提前执行');
  assert.equal(leaseTimers.size, 1);

  clock.advance(1);
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(leaseTimers.size, 0);
});

test('lease 业务回调抛错：Map 清理先于业务，异常上抛且不残留', () => {
  const { clock, leaseTimers, timers } = newTimers();
  timers.armLease('boom', 10, () => {
    throw new Error('lease boom');
  });
  assert.throws(() => clock.advance(10), /lease boom/);
  assert.equal(leaseTimers.has('boom'), false, '抛错后 Map 必须已清理');
  clock.advance(10);
});

// ── 捕获层边界契约（captain review 追加，先测后改）─────────────────────────────

test('leaseTimers 是 node:vm 跨 realm Map 时必须使用该精确实例，不得用 instanceof Map 拒绝', () => {
  const createWakeTimers = createFactory();
  const clock = createFakeClock();
  const realmMap = vm.runInNewContext('new Map()');
  assert.equal(realmMap instanceof Map, false, '前置：跨 realm Map 不能通过宿主 realm 的 instanceof 检查');

  const timers = createWakeTimers({ clock, leaseTimers: realmMap });
  const seen = [];
  timers.armLease('realm:1', 100, () => seen.push('realm'));
  assert.equal(realmMap.size, 1, '必须写入调用方提供的精确 Map 实例');
  assert.ok(realmMap.get('realm:1') !== undefined, '精确 Map 中必须可观察到原生 handle');

  timers.disarmLease('realm:missing');
  clock.advance(100);
  assert.deepEqual(seen, ['realm']);
  assert.equal(realmMap.size, 0);
});

test('显式 cancel：槽位被外部替换为裸 handle 时，必须同时取消旧注册与当前裸 handle', () => {
  const { clock, timers } = newTimers();
  const st = {};
  const seen = [];
  const trackedHandle = timers.schedule(st, 'sleepTimer', 100, () => seen.push('tracked'));
  const rawHandle = clock.setTimeout(() => seen.push('raw'), 200);
  st.sleepTimer = rawHandle;

  assert.equal(timers.cancel(st, 'sleepTimer'), true, '显式取消被外部替换的槽位必须返回 true');
  assert.equal(st.sleepTimer, null);
  assert.equal(
    clock.pendingCount(),
    0,
    '旧注册与当前裸 handle 都必须被 clearTimeout，不得留下孤儿定时器',
  );

  clock.advance(300);
  assert.deepEqual(seen, []);
  assert.equal(timers.cancel(st, 'sleepTimer'), false);
  assert.equal(clock.forceStale(trackedHandle), true, '旧注册的定时器必须已被取消（可强制投递）');
  assert.deepEqual(seen, []);
});

test('旧注册回调被强制到期（非显式取消）：仍不得清掉外部写入的新 handle', () => {
  const { clock, timers } = newTimers();
  const st = {};
  const seen = [];
  const trackedHandle = timers.schedule(st, 'sleepTimer', 100, () => seen.push('tracked'));
  const newer = clock.setTimeout(() => seen.push('newer'), 200);
  st.sleepTimer = newer;

  assert.equal(clock.forceFire(trackedHandle), true, '应强制投递旧注册回调');
  assert.deepEqual(seen, [], '旧注册回调不得执行业务');
  assert.equal(st.sleepTimer, newer, '旧注册回调不得清掉外部写入的新 handle');

  clock.advance(200);
  assert.deepEqual(seen, ['newer'], '新 handle 必须保持有效');
});

test('schedule 到已有未跟踪裸 handle 的槽位：必须先取消旧定时器再登记新注册', () => {
  const { clock, timers } = newTimers();
  const st = {};
  const seen = [];
  const legacy = clock.setTimeout(() => seen.push('legacy'), 100);
  st.sleepTimer = legacy;

  const next = timers.schedule(st, 'sleepTimer', 50, () => seen.push('next'));
  assert.equal(st.sleepTimer, next);
  assert.equal(clock.pendingCount(), 1, '旧裸 handle 必须被取消，只应剩新注册');

  clock.advance(50);
  assert.deepEqual(seen, ['next']);
  clock.advance(50);
  assert.deepEqual(seen, ['next'], '旧裸定时器不得再执行');
});

test('armLease/disarmLease：Map 当前值是外部裸 handle 时必须先取消它', () => {
  const { clock, leaseTimers, timers } = newTimers();
  const seen = [];
  const legacy = clock.setTimeout(() => seen.push('legacy'), 100);
  leaseTimers.set('k', legacy);

  timers.armLease('k', 50, () => seen.push('next'));
  assert.equal(leaseTimers.size, 1);
  assert.notEqual(leaseTimers.get('k'), legacy, 'armLease 必须替换为新的原生 handle');
  clock.advance(50);
  assert.deepEqual(seen, ['next']);
  assert.equal(clock.pendingCount(), 0, '旧裸 lease 定时器必须被取消');
  clock.advance(50);
  assert.deepEqual(seen, ['next'], '旧裸 lease 定时器不得执行');

  const legacy2 = clock.setTimeout(() => seen.push('legacy2'), 100);
  leaseTimers.set('k2', legacy2);
  timers.disarmLease('k2');
  assert.equal(leaseTimers.has('k2'), false);
  assert.equal(clock.pendingCount(), 0, 'disarmLease 必须取消 Map 当前外部裸 handle');
  clock.advance(100);
  assert.deepEqual(seen, ['next']);
});
