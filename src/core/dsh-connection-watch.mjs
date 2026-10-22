// DSH 连接监视器：单飞（single-flight）健康检查，检查结束后才安排下一次，替代 setInterval。
// 连接恢复流程（NodeApiClient.refreshDesktopEndpoint）可能变慢（DSH 重启、端口扫描、总恢复预算），
// setInterval 会让探测叠起来；这里保证同一时刻最多一个检查在途。
// 约定：
// - start() 幂等：重复调用不会叠加检查或计时器；
// - 检查成功等待 readyDelayMs，失败/抛错等待 retryDelayMs（不注入额外周期）；
// - 检查在途期间不安排任何计时器；
// - stop() 清掉待执行的计时器；在途检查保留，但其结果不再调度下一次；
// - stop()/start() 推进 generation：旧代检查的结果既不能调度、也不能被当成新代结果；
//   若重启时旧检查还在途，等它结算后再为新代立即补一次检查（仍然永不重叠）。

const DEFAULT_READY_DELAY_MS = 5000;
const DEFAULT_RETRY_DELAY_MS = 2000;

function delayOption(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

export function createDshConnectionWatch(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const check = typeof opts.check === 'function' ? opts.check : () => Promise.resolve(false);
  const readyDelayMs = delayOption(opts.readyDelayMs, DEFAULT_READY_DELAY_MS);
  const retryDelayMs = delayOption(opts.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
  const setTimeoutFn = typeof opts.setTimeoutFn === 'function' ? opts.setTimeoutFn : setTimeout;
  const clearTimeoutFn = typeof opts.clearTimeoutFn === 'function' ? opts.clearTimeoutFn : clearTimeout;
  const reportError = typeof opts.onError === 'function' ? opts.onError : null;
  const unrefTimers = opts.unref !== false;

  let active = false;
  let generation = 0;
  let timer = null;
  let inFlight = false;
  let startWhenSettled = false;

  function clearScheduled() {
    const pending = timer;
    if (!pending) return;
    timer = null;
    try { clearTimeoutFn(pending.handle); } catch { /* 计时器可能已触发 */ }
  }

  function unrefHandle(handle) {
    if (!unrefTimers) return;
    try {
      if (handle && typeof handle.unref === 'function') handle.unref();
    } catch { /* fake timer 没有 unref */ }
  }

  function schedule(delayMs) {
    if (!active) return;
    clearScheduled();
    const owner = generation;
    const entry = { handle: null, fired: false };
    entry.handle = setTimeoutFn(() => {
      if (entry.fired) return;
      entry.fired = true;
      if (timer === entry) timer = null;
      if (!active || generation !== owner) return;
      runCheck();
    }, delayMs);
    timer = entry;
    unrefHandle(entry.handle);
  }

  function finish(owner, ready, error) {
    inFlight = false;
    if (error && reportError) {
      try { reportError(error); } catch { /* 观察者抛错不能打断重试循环 */ }
    }
    if (!active) {
      startWhenSettled = false;
      return;
    }
    if (owner !== generation) {
      // 旧代检查结果：不安排 ready/retry；若期间 stop()/start() 过，立即为新代补一次检查。
      if (startWhenSettled) {
        startWhenSettled = false;
        runCheck();
      }
      return;
    }
    schedule(ready ? readyDelayMs : retryDelayMs);
  }

  function runCheck() {
    if (!active) return;
    clearScheduled();
    if (inFlight) {
      // 正常情况下不会走到（单飞）；保险起见只标记「结算后立刻补检查」。
      startWhenSettled = true;
      return;
    }
    const owner = generation;
    inFlight = true;
    startWhenSettled = false;
    let result;
    try {
      result = check();
    } catch (error) {
      result = Promise.reject(error);
    }
    Promise.resolve(result).then(
      (value) => finish(owner, Boolean(value), null),
      (error) => finish(owner, false, error ?? new Error('dsh connection check failed'))
    );
  }

  function start() {
    if (active) return;
    active = true;
    generation += 1;
    if (inFlight) {
      // 上一次 stop() 时还在途的检查：等它结算后再立即为新代检查，永不重叠。
      startWhenSettled = true;
      return;
    }
    runCheck();
  }

  function stop() {
    active = false;
    generation += 1;
    startWhenSettled = false;
    clearScheduled();
  }

  return { start, stop };
}

/**
 * DSH 连接发现诊断日志器（bridge 复用）：按 phase+reason 做 30s 冷却的有界去重，
 * 恢复成功时清空冷却；只输出安全字段，绝不把 message/header/cookie/token 写进日志。
 */
export function createDshDiscoveryDiagnosticLog(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const sink = typeof opts.log === 'function' ? opts.log : () => {};
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const configuredCooldown = Number(opts.cooldownMs);
  const cooldownMs = Number.isFinite(configuredCooldown) && configuredCooldown > 0 ? configuredCooldown : 30000;
  const configuredMaxKeys = Number(opts.maxKeys);
  const maxKeys = Number.isInteger(configuredMaxKeys) && configuredMaxKeys > 0 ? configuredMaxKeys : 64;
  const lastLoggedAt = new Map();
  const safeText = (value, limit) => {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim().slice(0, limit);
    return /^[A-Za-z0-9_.:-]+$/.test(trimmed) ? trimmed : '';
  };
  return (event) => {
    try {
      const phase = safeText(event?.phase, 32) || 'probe';
      const reason = safeText(event?.reason, 48) || 'unknown';
      const code = safeText(event?.code, 48);
      const elapsed = Number(event?.ms);
      const ms = Number.isFinite(elapsed) && elapsed >= 0 ? ` ${Math.round(elapsed)}ms` : '';
      const count = Number(event?.candidateCount);
      const candidates = Number.isFinite(count) && count >= 0 ? ` candidates=${Math.round(count)}` : '';
      const details = `${code ? ` code=${code}` : ''}${candidates}`;
      if (event?.recovered === true) {
        lastLoggedAt.clear();
        sink(`[dsh-discovery] ${phase}/${reason}${ms}${details} (recovered)`);
        return;
      }
      const key = `${phase}:${reason}`;
      const at = now();
      const previous = lastLoggedAt.get(key);
      if (previous !== undefined && at - previous < cooldownMs) return;
      lastLoggedAt.delete(key);
      lastLoggedAt.set(key, at);
      while (lastLoggedAt.size > maxKeys) {
        const oldest = lastLoggedAt.keys().next().value;
        if (oldest === undefined) break;
        lastLoggedAt.delete(oldest);
      }
      sink(`[dsh-discovery] ${phase}/${reason}${ms}${details}`);
    } catch { /* 诊断不得影响主流程 */ }
  };
}


