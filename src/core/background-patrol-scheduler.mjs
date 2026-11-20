/**
 * 后台巡检机会调度器（stage 1：独立可测）。
 *
 * 工厂持有两个平台各自的机会定时器和一个全局运行租约：
 *  · 每个平台到点后先尝试一次机会，随后只重排自己的下一次随机间隔，互不等待；
 *  · 北京时间窗口、就绪状态、跨平台 single-flight 都在机会内同步判定，失败只发 skipped；
 *  · run 返回的 promise 覆盖整个后台回合，全局租约必须在其之前同步占位；
 *  · stop() 只取消未来机会，不取消已开始的回合：租约保留到该 promise settle。
 * 依赖全部注入；import 与工厂都不注册定时器、不做 I/O，也不接触真实平台、预算或状态文件。
 */

/** 两个平台的巡检间隔区间（毫秒）。 */
export const PATROL_INTERVALS = {
  tieba: { minMs: 3600000, maxMs: 7200000 },
  xiaoheihe: { minMs: 2700000, maxMs: 5400000 },
};

const PLATFORMS = ['tieba', 'xiaoheihe'];
// 北京时间固定 UTC+8、无夏令时：把 +8h 后的 UTC 小时当作北京时间，与宿主时区无关。
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const ACTIVE_FROM_HOUR = 7; // 07:00 含
const ACTIVE_UNTIL_HOUR = 23; // 23:00 不含

/**
 * 北京时间 07:00（含）至 23:00（不含）内返回 true。
 * @param {number} timestamp 毫秒时间戳
 * @returns {boolean}
 */
export function isPatrolActiveTime(timestamp) {
  const ms = Number(timestamp);
  if (!Number.isFinite(ms)) return false;
  const beijingHour = new Date(ms + BEIJING_OFFSET_MS).getUTCHours();
  return beijingHour >= ACTIVE_FROM_HOUR && beijingHour < ACTIVE_UNTIL_HOUR;
}

/**
 * 创建独立的后台巡检机会调度器。
 *
 * @param {object} options
 * @param {{ now: () => number, setTimeout: Function, clearTimeout: Function }} [options.clock]
 * @param {() => number} [options.random] 返回 [0, 1) 的随机源，默认 Math.random
 * @param {() => ({ qqBusy?: boolean, dshAvailable?: boolean, paused?: boolean, modeAllowed?: boolean })} options.getAvailability 同步就绪注入
 * @param {(context: { platform: string, startedAt: number }) => Promise<void> | void} options.run 覆盖整个后台回合的任务
 * @param {(event: { type: string, platform: string, at: number, reason?: string }) => void} [options.onEvent] 观察者，抛错不影响调度
 * @param {{ tieba?: number|null, xiaoheihe?: number|null }} [options.initialNextAt] 重启恢复：仅接受未来时间；过期不补
 * @param {(plan: { platform: string, at: number, delayMs: number }) => void} [options.onPlan] 每次排期观察者（bridge 用于持久化 nextAt；异常不影响调度）
 * @returns {{ start: () => void, stop: () => void, snapshot: () => { started: boolean, runningPlatform: string | null, nextAt: { tieba: number | null, xiaoheihe: number | null } } }}
 */
export function createBackgroundPatrolScheduler(options = {}) {
  const { clock, random, getAvailability, run, onEvent } = options ?? {};

  if (typeof run !== 'function') {
    throw new TypeError('createBackgroundPatrolScheduler: options.run must be a function');
  }
  if (typeof getAvailability !== 'function') {
    throw new TypeError('createBackgroundPatrolScheduler: options.getAvailability must be a function');
  }

  const now = clock && typeof clock.now === 'function'
    ? () => clock.now()
    : () => Date.now();
  const setTimer = clock && typeof clock.setTimeout === 'function'
    ? (callback, delay) => clock.setTimeout(callback, delay)
    : (callback, delay) => setTimeout(callback, delay);
  const clearTimer = clock && typeof clock.clearTimeout === 'function'
    ? (handle) => clock.clearTimeout(handle)
    : (handle) => clearTimeout(handle);
  const randomSource = typeof random === 'function' ? random : Math.random;
  const emitEvent = typeof onEvent === 'function' ? onEvent : () => {};
  // task-86（E1）：重启恢复的持久 nextAt（未来才采用；过期保持不补）与排期持久化钩子。
  const initialNextAt = options && options.initialNextAt && typeof options.initialNextAt === 'object'
    ? { ...options.initialNextAt }
    : {};
  const emitPlan = typeof options.onPlan === 'function' ? options.onPlan : () => {};
  // F3：平台过滤（显式 false 不排期/不产生机会；缺失按兼容 true）。
  const isPlatformEnabled = typeof options.isPlatformEnabled === 'function'
    ? (platform) => options.isPlatformEnabled(platform) !== false
    : () => true;

  let started = false;
  let generation = 0;
  let running = null;
  let runningPlatform = null;
  // 每个平台同一时刻只有一个机会定时器；记录里带上启动世代，旧回调据此失效。
  const timers = { tieba: null, xiaoheihe: null };
  const nextAt = { tieba: null, xiaoheihe: null };

  function emit(type, platform, at, reason) {
    const event = reason === undefined
      ? { type, platform, at }
      : { type, platform, at, reason };
    try {
      emitEvent(event);
    } catch {
      // 观察者异常不得打断调度。
    }
  }

  function nextDelay(platform) {
    const { minMs, maxMs } = PATROL_INTERVALS[platform];
    let ratio = Number(randomSource());
    if (!Number.isFinite(ratio) || ratio < 0) ratio = 0;
    else if (ratio > 1) ratio = 1;
    let delay = minMs + Math.floor(ratio * (maxMs - minMs));
    if (delay < minMs) delay = minMs;
    if (delay > maxMs) delay = maxMs;
    return delay;
  }

  function scheduleNext(platform) {
    if (!isPlatformEnabled(platform)) {
      timers[platform] = null;
      nextAt[platform] = null;
      return;
    }
    const atNow = now();
    const seeded = initialNextAt[platform];
    let delay;
    if (typeof seeded === 'number' && Number.isFinite(seeded) && seeded > atNow) {
      // 重启恢复：使用持久化的未来 nextAt；过期时间一律丢弃（过期机会不补）。
      delay = seeded - atNow;
      initialNextAt[platform] = undefined;
    } else {
      delay = nextDelay(platform);
      initialNextAt[platform] = undefined;
    }
    const record = { generation, handle: null };
    nextAt[platform] = atNow + delay;
    timers[platform] = record;
    record.handle = setTimer(() => fire(platform, record), delay);
    try {
      emitPlan({ platform, at: nextAt[platform], delayMs: delay });
    } catch {
      // 持久化观察者异常不得打断调度。
    }
  }

  function cancelTimer(platform) {
    const record = timers[platform];
    timers[platform] = null;
    nextAt[platform] = null;
    if (record === null || record.handle === null || record.handle === undefined) return;
    try {
      clearTimer(record.handle);
    } catch {
      // 取消失败不应影响后续状态。
    }
  }

  function fire(platform, record) {
    if (!started) return; // stop() 之后到期的旧回调：不执行、不重排。
    if (record.generation !== generation) return; // stop/start 之前的旧注册。
    if (timers[platform] !== record) return; // 已被替换的旧注册。

    timers[platform] = null;
    nextAt[platform] = null;
    try {
      try {
        takeOpportunity(platform);
      } catch {
        // 机会内部异常不得打断调度；原始异常不进入事件。
      }
    } finally {
      // 只有仍属于当前启动世代、且没有被别人重排过，才由本次机会重排自己。
      if (started && record.generation === generation && timers[platform] === null) {
        scheduleNext(platform);
      }
    }
  }

  function takeOpportunity(platform) {
    const opportunityGeneration = generation; // 本次机会的注册世代
    const at = now();
    if (!isPlatformEnabled(platform)) {
      emit('skipped', platform, at, 'platform-disabled');
      return;
    }
    if (!isPatrolActiveTime(at)) {
      emit('skipped', platform, at, 'outside-hours');
      return;
    }
    if (running !== null) {
      emit('skipped', platform, at, 'background-busy');
      return;
    }
    let availability;
    try {
      availability = getAvailability();
    } catch {
      emit('skipped', platform, at, 'availability-error');
      return;
    }
    // getAvailability 是外部同步回调：可能 stop/start 或重入另一平台的机会。
    // 先按注册世代重查，作废的机会绝不 run；再查 running，已被重入任务占用的租约绝不覆盖。
    if (!started || opportunityGeneration !== generation) return;
    if (running !== null) {
      emit('skipped', platform, at, 'background-busy');
      return;
    }
    const reason = readinessSkipReason(availability);
    if (reason !== null) {
      emit('skipped', platform, at, reason);
      return;
    }
    startRun(platform, at);
  }

  function readinessSkipReason(availability) {
    // 只接受显式 true；缺失一律保守跳过，不把真值当许可。
    if (availability === null || typeof availability !== 'object') return 'dsh-unavailable';
    if (availability.qqBusy === true) return 'qq-busy';
    if (availability.paused === true) return 'paused';
    if (availability.dshAvailable !== true) return 'dsh-unavailable';
    if (availability.modeAllowed !== true) return 'mode-disabled';
    return null;
  }

  function startRun(platform, startedAt) {
    const lease = { platform, startedAt };
    // 先同步占住全局租约，再调用 run：任何重入（含跨平台）都会被 background-busy 挡住。
    running = lease;
    runningPlatform = platform;
    let result;
    let threw = false;
    try {
      result = run({ platform, startedAt });
    } catch {
      threw = true;
    }
    // run 已实际发起后才发 started：该事件因此代表真正已启动的任务，
    // 观察者在此事件里 stop/start 也无法让已作废的机会再被实际执行。
    emit('started', platform, startedAt);
    if (threw) {
      settle(platform, lease, false);
      return;
    }
    Promise.resolve(result).then(
      () => settle(platform, lease, true),
      () => settle(platform, lease, false),
    );
  }

  function settle(platform, lease, succeeded) {
    try {
      // 只释放自己的租约：旧回合不能误清新回合的状态。
      if (running === lease) {
        running = null;
        runningPlatform = null;
      }
      emit(succeeded ? 'completed' : 'failed', platform, now());
    } catch {
      if (running === lease) {
        running = null;
        runningPlatform = null;
      }
    }
  }

  function start() {
    if (started) return; // 幂等：重复 start 不重排、不加倍。
    started = true;
    generation += 1;
    for (const platform of PLATFORMS) scheduleNext(platform);
  }

  function stop() {
    started = false;
    generation += 1;
    for (const platform of PLATFORMS) cancelTimer(platform);
    // 已开始的 run 不取消：running 租约保留到它的 promise settle。
  }

  function snapshot() {
    return {
      started,
      runningPlatform,
      nextAt: { tieba: nextAt.tieba, xiaoheihe: nextAt.xiaoheihe },
    };
  }

  return { start, stop, snapshot };
}
