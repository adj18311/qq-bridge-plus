/**
 * per-conversation 唤醒定时器与 pending-wake 租约句柄的**生命周期归属**。
 *
 * 本模块只负责「登记 / 到期 / 取消」，不持有会话业务状态，也不做任何唤醒策略：
 *  · 原生 handle 仍落在调用方既有的槽位（`st.sleepTimer` 等）与既有的租约 Map 里，
 *    现有 busy/watchdog/重连路径照旧能观察到；方便逐点迁移、灰度。
 *  · 延迟计算、睡眠分段（含 100009 上限）、重臂标记和授权清理全部留在 bridge。
 *  · 时钟由调用方注入；工厂与 import 均不注册任何定时器、不做 I/O。
 *
 * 关键不变量（防「旧回调误杀新定时器」）：
 *  · 回调闭包持有 registration **对象身份**；到期时先确认它仍是该 owner/slot 的当前注册，
 *    再看槽位里是否还是本次 handle。只靠 handle 数值相等判断会在假时钟/编号复用时误触发。
 *  · 清理（移除注册、清空槽位 / 删除租约 Map key）必须发生在业务回调之前；业务抛错时
 *    清理已经完成，异常原样上抛，不吞、不 await。
 *  · 槽位/Map 被外部置 null、被外部换成更新的裸 handle 时，只释放自己的注册，
 *    绝不 clearTimeout 或覆写更新的 handle。
 */

/**
 * @param {object} [options]
 * @param {{ now: () => number, setTimeout: Function, clearTimeout: Function }} [options.clock]
 * @param {Map<string, any>} [options.leaseTimers] 调用方既有的「key -> 原生 handle」Map（保持可观察）
 * @returns {{ schedule: Function, cancel: Function, now: () => number, armLease: Function, disarmLease: Function, clearLeases: Function }}
 */
export function createWakeTimers({ clock, leaseTimers } = {}) {
  const now = typeof clock?.now === 'function' ? () => clock.now() : () => Date.now();
  const setTimer = typeof clock?.setTimeout === 'function'
    ? (fn, ms) => clock.setTimeout(fn, ms)
    : (fn, ms) => setTimeout(fn, ms);
  const clearTimer = typeof clock?.clearTimeout === 'function'
    ? (handle) => clock.clearTimeout(handle)
    : (handle) => clearTimeout(handle);
  // 调用方可能在 VM 里建 Map：跨 realm 的 Map 不通过宿主 realm 的 instanceof。
  // 只认传入的精确实例（nullish 才退回私有 Map），保证 bridge 观察到的就是同一张表。
  const leases = leaseTimers ?? new Map();

  // st（会话状态对象）-> slot -> registration。用 WeakMap 避免模块替调用方持有会话。
  const slotsByOwner = new WeakMap();
  // 租约 key -> registration；一个 key 同时只允许一个注册。
  const leaseRegs = new Map();

  function unref(handle) {
    // 数字 handle / 假时钟 handle 没有 unref；有则沿用既有的「别把进程钉住」行为。
    if (handle !== null && handle !== undefined && typeof handle.unref === 'function') handle.unref();
  }

  function schedule(st, slot, delay, callback) {
    const live = slotsByOwner.get(st);
    const previous = live?.get(slot);
    const raw = st[slot];
    let cleared = null;
    if (previous) {
      // 同 owner/slot 显式重排：旧注册必须真正取消。
      clearTimer(previous.handle);
      cleared = previous.handle;
      live.delete(slot);
      if (live.size === 0) slotsByOwner.delete(st);
    }
    // 显式替换还要取消槽位当前指向的裸 handle（外部旧调用点留下的）；与旧注册同一 handle 只清一次。
    if (raw !== null && raw !== undefined && raw !== cleared) clearTimer(raw);

    // delay 原样交给时钟（与原生 setTimeout 的强制转换/溢出/抛错行为保持一致）。
    let registration;
    const fire = () => {
      const current = slotsByOwner.get(st);
      if (!current || current.get(slot) !== registration) return; // 已取消/已替换/复用了数值 handle 的旧回调
      current.delete(slot);
      if (current.size === 0) slotsByOwner.delete(st);
      if (st[slot] !== registration.handle) return; // 槽位被外部置 null / 换成更新的裸 handle：只释放注册
      st[slot] = null;
      callback();
    };

    const handle = setTimer(fire, delay);
    registration = { handle, callback };
    let current = slotsByOwner.get(st);
    if (!current) {
      current = new Map();
      slotsByOwner.set(st, current);
    }
    current.set(slot, registration);
    st[slot] = handle;
    unref(handle);
    return handle;
  }

  function cancel(st, slot) {
    const live = slotsByOwner.get(st);
    const registration = live?.get(slot);
    const raw = st[slot];

    if (!registration) {
      // 兼容旧调用点留下的裸 handle（没有经过本模块登记）。
      if (raw === null || raw === undefined) return false;
      clearTimer(raw);
      st[slot] = null;
      return true;
    }

    clearTimer(registration.handle);
    live.delete(slot);
    if (live.size === 0) slotsByOwner.delete(st);
    // 显式 cancel 必须取消「当前目标」：槽位若被外部换成裸 handle，也要一起清掉（去重、只清一次），
    // 然后置 null；只有回调被动到期（stale fire）才保留更新的外部 handle。
    if (raw !== null && raw !== undefined && raw !== registration.handle) clearTimer(raw);
    st[slot] = null;
    return true;
  }

  function armLease(key, ttl, callback) {
    const previous = leaseRegs.get(key);
    const raw = leases.get(key);
    let cleared = null;
    if (previous) {
      // 重臂：先取消旧注册。
      clearTimer(previous.handle);
      cleared = previous.handle;
      leaseRegs.delete(key);
    }
    // 显式重臂还要取消 Map 当前指向的裸 handle；与旧注册同一 handle 只清一次。
    if (raw !== null && raw !== undefined && raw !== cleared) clearTimer(raw);

    let registration;
    const fire = () => {
      if (leaseRegs.get(key) !== registration) return; // 已 disarm / 重臂的旧回调
      leaseRegs.delete(key);
      if (leases.get(key) !== registration.handle) return; // 外部删除/换成更新的 handle：只释放注册
      leases.delete(key);
      callback();
    };

    const handle = setTimer(fire, ttl);
    registration = { handle, callback };
    leaseRegs.set(key, registration);
    leases.set(key, handle);
    unref(handle);
    return handle;
  }

  function disarmLease(key) {
    const registration = leaseRegs.get(key);
    const raw = leases.get(key);

    if (!registration) {
      if (raw === null || raw === undefined) return false;
      clearTimer(raw); // 兼容外部写入的裸租约 handle
      leases.delete(key);
      return true;
    }

    clearTimer(registration.handle);
    leaseRegs.delete(key);
    // 显式 disarm 与 cancel 同理：Map 当前若被外部换成裸 handle，也要取消（去重）并删除 key。
    if (raw !== null && raw !== undefined && raw !== registration.handle) clearTimer(raw);
    leases.delete(key);
    return true;
  }

  function clearLeases() {
    // 注册与 Map 里的 handle 可能指向同一原生定时器：按 handle 去重，避免重复 clearTimeout。
    const cleared = new Set();
    for (const registration of leaseRegs.values()) {
      if (cleared.has(registration.handle)) continue;
      clearTimer(registration.handle);
      cleared.add(registration.handle);
    }
    for (const handle of leases.values()) {
      if (handle === null || handle === undefined || cleared.has(handle)) continue;
      clearTimer(handle);
      cleared.add(handle);
    }
    leaseRegs.clear();
    leases.clear();
  }

  return { schedule, cancel, now, armLease, disarmLease, clearLeases };
}
