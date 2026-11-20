/**
 * 阶段 2B：xhh-tool-watcher —— 小黑盒 MCP「工具面快照」观察插件（离线候选，契约 v2）。
 *
 * 定位：**只提示，不动作**。读 DSH 宿主工具注册表，每分钟做一次可靠检查；
 * 连续 3 次**可靠缺失**（每次间隔一分钟）才提示管理员。
 * 绝不重启桥接、绝不调用任何平台接口、不写 config/state（除显式配置 statePath 的本地快照文件）。
 *
 * v2 触发契约（Codex 终审要求）：
 *  · 定时 tick = `check({source:'scheduled'})`，唯一允许推进连续计数、允许发提示的路径；
 *  · `tools/change` 事件 = `check({source:'event'})`，只刷新观测（让「恢复」尽快可见），
 *    **绝不推进计数、绝不发提示**（MCP 重连时 12 个工具逐个注销会让事件秒内连发，不能算 3 次）。
 *
 * 判定逻辑不在本插件：由 2A 的 `src/core/xhh-tool-surface-decision.mjs`（v2）提供，可注入 fake。
 * v2 API：`recordToolSurfaceObservation(state,{observedNames,at,source})`、
 * `noteToolSurfaceDelivery(state,{at,outcome,deliveredAt})`、`XHH_TOOL_SURFACE_FAILURE_RETRY_MS`。
 * **只支持契约 v2**：缺 `noteToolSurfaceDelivery` 的旧模块一律视为不可用（工厂抛 TypeError；
 * 装配时显式失败并给出原因），不存在 v1 兼容回退分支——否则「事件也会计数」的旧语义会以开关形式残留。
 *
 * 装配失败（默认路径不可达 / 自定义 decisionPath 指向错误 / 注入模块缺 v2 API）时**显式失败**：
 * error 级日志 + `snapshot().decisionLoadError`，不静默装死；`config.decision` 可直接注入模块对象。
 *
 * 通知通道（v2.1）：profile 的 YAML 写不了函数，所以 `config.notify` 只用于测试注入；
 * 生产用 `notifyUrl`/`notifySuccessContract`/`notifyToken`/`notifyHeaderName`/`ownerUserId`/`notifyTimeoutMs`
 * 交给 `notifier.mjs` 的 `createNotifierFromConfig`（默认契约 none：任何 2xx 都只判 unknown）；
 * 两者都没有时装配成功但只记一条 warn（绝不静默）。
 *
 * 间隔（v2.1）：`config.intervalMs`（默认 60000）透传给判定模块，用于「太近/太晚」分桶
 * （连续 3 次*有效*分钟检查才提示；事件秒内连发不计数）。
 *
 * 边界（详见 README）：
 *  · 不是守护进程；宿主进程退出即消失。
 *  · `ctx.tools.view(undefined)` 只反映「本进程全局层」可见工具名；不覆盖 scope 局部注册、
 *    也不覆盖被 `restrict()` 遮蔽的名字 —— 因此可能漏报/误报，只作提示信号。
 *  · 插件无沙箱，同进程同权；需人工在 profile 里启用，本次不写任何配置。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createNotifierFromConfig } from './notifier.mjs';
import { createInboxProducer } from './inbox-producer.mjs';
import { createReceiptReader } from './receipt-reader.mjs';

export const name = 'xhh-tool-watcher';
export const inject = ['tools'];

/** 默认 1 分钟检查一次（用户要求「每 1 分钟检查」，配合连续 3 次 ≈ 最快 3 分钟提示）。 */
export const DEFAULT_INTERVAL_MS = 60 * 1000;
/** 2A 判定模块路径（相对本插件文件）。 */
export const DECISION_MODULE_PATH = '../../src/core/xhh-tool-surface-decision.mjs';
/** 失败重试窗口兜底值：只在注入模块没导出 `XHH_TOOL_SURFACE_FAILURE_RETRY_MS` 时使用。 */
const DEFAULT_FAILURE_RETRY_MS = 15 * 60 * 1000;

function noop() {}

function safeJsonClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function humanError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 宿主 notify 常为 async：返回 Promise 时必须 await 才能拿到真实 outcome。 */
function isThenable(value) {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function';
}

/**
 * 纯工厂：不依赖 Cordis ctx，便于离线测试。
 *
 * @param {object} options
 * @param {() => (string[]|null)} options.readToolNames 读当前全局工具名（抛错/非数组 → uncertain）
 * @param {object} options.decision 2A 判定模块命名空间（**必须**是契约 v2：recordToolSurfaceObservation + noteToolSurfaceDelivery）
 * @param {() => number} [options.now]
 * @param {{load?: Function, save?: Function}|null} [options.store] 持久化抽象（失败不得抛）
 * @param {((event: {kind: string, message: string}) => ({outcome?: string}|Promise<{outcome?: string}>))|null} [options.notify]
 * @param {{intervalMs?: number, statePath?: string, decisionPath?: string, notifyUrl?: string, notifyToken?: string, notifyHeaderName?: string, ownerUserId?: (string|number), notifyTimeoutMs?: number}} [options.config]
 * @param {boolean} [options.notifyConfigured] 装配时是否配置了可用通知通道（snapshot 透出，不暴露 URL/token）
 * @param {((level: string, message: string) => void)|null} [options.log]
 * @param {{path: string, message: string}|null} [options.decisionLoadError] 装配失败原因（透传到 snapshot）
 * @returns {{check: Function, snapshot: Function, dispose: Function}}
 */
export function createToolSurfaceWatcher({
  readToolNames,
  decision,
  now = Date.now,
  store = null,
  notify = null,
  config = {},
  log = null,
  notifyConfigured = false,
  decisionLoadError = null,
  producer = null,
  receiptReader = null,
} = {}) {
  if (typeof readToolNames !== 'function') {
    throw new TypeError('createToolSurfaceWatcher: readToolNames 必须是函数');
  }
  if (decision === null || typeof decision !== 'object' || typeof decision.recordToolSurfaceObservation !== 'function') {
    throw new TypeError('createToolSurfaceWatcher: decision 必须提供 recordToolSurfaceObservation()');
  }
  if (typeof decision.noteToolSurfaceDelivery !== 'function') {
    throw new TypeError('createToolSurfaceWatcher: decision 必须提供 noteToolSurfaceDelivery()（需要契约 v2；不支持 v1 兼容回退）');
  }
  const prefix = config.prefix ?? decision.XHH_TOOL_NAME_PREFIX ?? 'mcp__xiaoheihe__';
  const logger = typeof log === 'function' ? log : noop;
  const failureRetryMs = Number.isFinite(decision.XHH_TOOL_SURFACE_FAILURE_RETRY_MS)
    ? decision.XHH_TOOL_SURFACE_FAILURE_RETRY_MS
    : DEFAULT_FAILURE_RETRY_MS;
  // v2.1：间隔透传给判定模块做「太近/太晚」分桶；未配置时用默认 60s。
  const intervalMs = Number.isFinite(config.intervalMs) && config.intervalMs > 0
    ? config.intervalMs
    : DEFAULT_INTERVAL_MS;

  function createState() {
    if (typeof decision.createToolSurfaceState === 'function') {
      try {
        return decision.createToolSurfaceState();
      } catch (error) {
        logger('warn', `判定模块 createToolSurfaceState 抛错，改用内置空状态：${humanError(error)}`);
      }
    }
    return { consecutiveMisses: 0, lastAlertAt: 0, lastReason: 'init' };
  }

  function parseState(raw) {
    if (raw === undefined || raw === null) return createState();
    if (typeof decision.parseToolSurfaceState !== 'function') return createState();
    try {
      return decision.parseToolSurfaceState(raw) ?? createState();
    } catch (error) {
      logger('warn', `持久化状态不可解析，改用空状态：${humanError(error)}`);
      return createState();
    }
  }

  let state = parseState(typeof store?.load === 'function' ? store.load() : undefined);
  let lastReason = state?.lastReason ?? 'init';
  /** 上一轮的语义 reason：用于只在「缺失 → 恢复」的过渡点写一次恢复信号。 */
  let previousReason = lastReason;
  // 语义是「本轮尝试了提示」而不是「已送达」：避免运维把 attempted 误读为投递成功。
  let attempted = false;
  let disposed = false;
  /** 最近一次成功写入收件箱的 noticeId（只用于排障，不含内容）。 */
  let lastQueuedNoticeId = null;
  /**
   * 单飞槽位：并发 check 复用同一个 in-flight Promise。
   * 不能「加锁后丢弃」——丢弃会让最后一条恢复事件丢失，工具面状态停在旧值。
   */
  let inFlight = null;
  /** 事件在 in-flight 期间到达：结束后补一次 **event** 采样（不计数、不提示），不补 scheduled。 */
  let pendingEventRefresh = false;

  function persist(next) {
    if (typeof store?.save !== 'function') return;
    const payload = safeJsonClone(next);
    if (payload === null) {
      logger('warn', '持久化失败：状态无法序列化');
      return;
    }
    try {
      store.save(payload);
    } catch (error) {
      // 持久化失败不得把「已提示」当成功，也不得影响本次检查结果。
      logger('warn', `持久化失败：${humanError(error)}`);
    }
  }

  function snapshot() {
    // 原始状态里的 0 是「从未提示」的哨兵值；对外统一暴露 null，避免与「1970 年提示过」混淆。
    const lastAlertAt = Number.isFinite(state?.lastAlertAt) && state.lastAlertAt > 0 ? state.lastAlertAt : null;
    const lastAttemptAt = Number.isFinite(state?.lastAttemptAt) && state.lastAttemptAt > 0 ? state.lastAttemptAt : null;
    const lastAttemptOutcome = typeof state?.lastAttemptOutcome === 'string' ? state.lastAttemptOutcome : null;
    return {
      state,
      lastReason,
      consecutiveMisses: Number.isInteger(state?.consecutiveMisses) ? state.consecutiveMisses : 0,
      lastAlertAt,
      hasAlerted: lastAlertAt !== null,
      attempted,
      lastAttemptAt,
      lastAttemptOutcome,
      failureRetryMs,
      intervalMs,
      notifyConfigured,
      decisionLoadError,
    };
  }

  async function check(options = {}) {
    // fail-safe：只有**显式** source='scheduled' 才计数/提示；未知或缺省一律按 event（不计数、不提示）。
    const source = options?.source === 'scheduled' ? 'scheduled' : 'event';
    if (disposed) return snapshot();
    // 并发触发面：MCP 重连时 12 个工具逐个注销/注册 → tools/change 连发；
    // 加上 notify 走 QQ 的 await 窗口，check 必然会并发。这里单飞：后来的调用直接复用。
    if (inFlight !== null) {
      // 事件到达时复用 in-flight，但记一个「结束后补一次 event 采样」的标记；
      // scheduled 在 in-flight 期间不排队（下一分钟自然还有一次）。
      if (source === 'event') pendingEventRefresh = true;
      return inFlight;
    }
    const pending = runCheckOnce(source).finally(() => {
      // 成功/抛错都必须清空；否则一次异常会让后续 check 永远被同一个失败 Promise 吞掉。
      inFlight = null;
      if (pendingEventRefresh && !disposed) {
        pendingEventRefresh = false;
        // 补一次 event 采样：只刷新观测，不计数、不发提示。
        Promise.resolve()
          .then(() => check({ source: 'event' }))
          .catch((error) => logger('warn', `事件补采样失败：${humanError(error)}`));
      }
    });
    inFlight = pending;
    return pending;
  }

  async function observe(scheduledAt) {
    let observedNames = null;
    try {
      const raw = readToolNames();
      if (!Array.isArray(raw)) throw new TypeError('readToolNames 未返回数组');
      const picked = raw
        .filter((entry) => typeof entry === 'string' && entry.startsWith(prefix))
        // 判定模块的 expected 是**裸**工具名（如 get_home_content），这里去掉前缀再交出去。
        .map((entry) => entry.slice(prefix.length));
      if (picked.some((entry) => typeof entry !== 'string' || entry.length === 0)) throw new TypeError('工具名非法');
      observedNames = picked;
    } catch (error) {
      // 读不到注册表 = 不确定观测：断计数，绝不当作「缺失」。
      observedNames = null;
      lastReason = 'no-observation';
      logger('warn', `读取工具注册表失败，按不确定观测处理：${humanError(error)}`);
    }
    return { observedNames, at: scheduledAt };
  }

  async function runCheckOnce(source) {
    const at = typeof now === 'function' ? now() : Date.now();
    attempted = false;
    const { observedNames } = await observe(at);

    let result;
    try {
      result = decision.recordToolSurfaceObservation(state, { observedNames, at, source, intervalMs });
      // 判定模块可能是异步的（测试注入/未来演进）：是 thenable 就必须等，不能把 Promise 当状态。
      if (isThenable(result)) result = await result;
    } catch (error) {
      logger('error', `判定模块抛错，本轮跳过：${humanError(error)}`);
      lastReason = 'decision-error';
      return snapshot();
    }
    // 契约 v2：不存在 v1 回填分支（旧模块在工厂/装配阶段就被拒绝）。
    if (result && typeof result === 'object' && result.state !== undefined) state = result.state;
    else if (result && typeof result === 'object') state = result;

    if (observedNames === null) lastReason = 'no-observation';
    // 语义字符串优先：真实 2A 对 present/uncertain 的顶层 reason 恒为 'not-absent'，
    // 恢复信号只在 result.state.lastReason（'recovered'）里；顶层 reason 仅作兜底。
    else if (typeof result?.state?.lastReason === 'string') lastReason = result.state.lastReason;
    else if (typeof result?.reason === 'string') lastReason = result.reason;
    else if (typeof state?.lastReason === 'string') lastReason = state.lastReason;

    // 事件采样永远不提示：MCP 重连的秒内连发不能凑成「连续三次一分钟检查」。
    const wantsAlert = result?.alert === true;
    if (wantsAlert && source === 'event') {
      logger('warn', '事件采样返回了 alert，已忽略（只有定时检查允许提示）');
    } else if (wantsAlert) {
      await deliverAlert(at, observedNames);
    }

    // 只在「从非恢复态进入恢复态」时写一次恢复信号；连续 recovered 不重复写。
    if (previousReason !== 'recovered' && lastReason === 'recovered'
      && producer !== null && typeof producer?.publishRecovered === 'function') {
      try {
        const published = await producer.publishRecovered({ at });
        if (published?.ok !== true) logger('warn', `恢复信号入队失败：${published?.reason ?? 'unknown'}`);
      } catch (error) {
        logger('warn', `恢复信号入队异常：${humanError(error)}`);
      }
    }
    previousReason = lastReason;

    persist(state);
    return snapshot();
  }

  async function deliverAlert(at, observedNames) {
    // 文案必须走独立的分类结果：recordToolSurfaceObservation 的返回体没有 missing 字段，
    // 旧代码读 result.missing 导致文案恒为「0 个」。
    let missingList = [];
    if (typeof decision.classifyToolSurface === 'function') {
      try {
        const classified = decision.classifyToolSurface({ observedNames });
        // 防御：只有确定 absent 才提示；uncertain / 读失败绝不进入提示分支。
        if (classified?.state === 'absent' && Array.isArray(classified.missing)) missingList = classified.missing;
      } catch (error) {
        logger('warn', `分类结果不可用，本轮不发送提示：${humanError(error)}`);
      }
    }
    if (missingList.length === 0) {
      logger('warn', '判定模块要求提示，但拿不到缺失清单（missing 为空），本轮不发送通知');
      return;
    }
    const preview = missingList.slice(0, 5).join('、');
    const suffix = missingList.length > 5 ? ` 等 ${missingList.length} 个` : '';
    const message = `检测到 ${missingList.length} 个预期的小黑盒工具未注册（registration-lost）：${preview}${suffix}；`
      + '智能体当前可能看不到这些工具。请人工检查 DSH MCP 连接与宿主日志（本插件不会重启或重连）。';

    let outcome = 'unknown';
    if (producer !== null && typeof producer?.notifyMissing === 'function') {
      // 收件箱模式：写文件只是入队，永远不是 delivered；真正的结果是 bridge 写回的回执。
      try {
        const queued = await producer.notifyMissing({
          missingCount: missingList.length,
          consecutiveMisses: Number.isInteger(state?.consecutiveMisses) && state.consecutiveMisses > 0
            ? state.consecutiveMisses
            : missingList.length,
          lastSeenAt: at,
          at,
        });
        if (queued?.noticeId) {
          lastQueuedNoticeId = queued.noticeId;
          outcome = 'unknown';
        } else {
          logger('warn', `收件箱入队失败（${queued?.code ?? 'unknown'}），本次不记账`);
          return;
        }
      } catch (error) {
        logger('error', `收件箱入队异常，按 unknown 处理：${humanError(error)}`);
        outcome = 'unknown';
      }
    } else if (typeof notify === 'function') {
      try {
        // 宿主 notify 常为 async：先拿返回值，若是 thenable 必须 await，否则永远只能看到 unknown。
        const raw = notify({ kind: 'registration-lost', message });
        const settled = isThenable(raw) ? await raw : raw;
        const reported = settled?.outcome;
        if (reported === 'delivered' || reported === 'failed' || reported === 'unknown') outcome = reported;
      } catch (error) {
        outcome = 'unknown';
        logger('error', `通知发送失败，按 unknown 处理：${humanError(error)}`);
      }
    } else {
      // P3-1：没有通知通道时，本次提示什么都没尝试 —— attempted 必须保持 false，
      // 也不能调用 noteToolSurfaceDelivery 记账，否则快照会把「无通道跳过」误报成
      // 「尝试过但未送达」，并错误推进 lastAttemptAt（15 分钟重试节流）。
      logger('warn', '无通知通道（notify 未配置），本次提示已跳过：attempted 保持 false、不推进 lastAlertAt');
      return;
    }
    attempted = true;

    const deliveryAt = typeof now === 'function' ? now() : Date.now();
    // 契约 v2 正式记账：delivered 才推进 lastAlertAt；failed/unknown 只推进 lastAttemptAt（15 分钟节流）。
    try {
      let noted = decision.noteToolSurfaceDelivery(state, {
        at: deliveryAt,
        outcome,
        deliveredAt: outcome === 'delivered' ? deliveryAt : null,
      });
      if (isThenable(noted)) noted = await noted;
      if (noted && typeof noted === 'object' && noted.state !== undefined) state = noted.state;
    } catch (error) {
      logger('warn', `投递结果记账失败：${humanError(error)}`);
    }
  }

  function dispose() {
    disposed = true;
    pendingEventRefresh = false;
    state = null;
  }

  async function pollReceipts() {
    if (receiptReader === null || typeof receiptReader.poll !== 'function') {
      return { ok: false, reason: 'no-receipt-reader' };
    }
    // receipt-reader 通过注入的 setState 回写本 watcher 的状态，因此这里不需要再同步内存态
    // （它没有 state() 接口；旧代码读的是一个不存在的函数）。
    return receiptReader.poll();
  }

  return {
    check, snapshot, dispose, pollReceipts,
    getState: () => state,
    setState: (next) => { state = next; persist(next); },
  };
}

/** 文件持久化（仅当显式配置 config.statePath 时使用；原子写，失败只降级为内存）。 */
function createFileStore(statePath) {
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(statePath, 'utf8'));
      } catch {
        return undefined;
      }
    },
    save(raw) {
      const tmp = `${statePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(raw)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, statePath);
    },
  };
}

/** 默认调度器：unref 后不阻止宿主退出；dispose 时清掉。 */
function defaultScheduler() {
  return {
    every(ms, fn) {
      const timer = setInterval(fn, ms);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}

/**
 * Cordis 接线：读配置 → 建 store → 建 watcher → 订阅 tools/change（event 采样）→ 定时检查（scheduled）→
 * dispose 清理。判定模块加载失败时**显式失败**：error 级日志 + 返回 decisionLoadError（snapshot 可见）。
 */
export async function apply(ctx, config = {}) {
  const logger = typeof config.log === 'function'
    ? config.log
    : (level, message) => {
      try {
        if (level === 'error') ctx?.logger?.error?.(message);
        else ctx?.logger?.warn?.(message);
      } catch {
        /* 日志失败不影响装配 */
      }
    };

  /** 装配失败的统一出口：error 级日志 + 显式结果 + snapshot 可查，且**不注册任何钩子**。 */
  const failAssembly = (decisionLoadError, hint) => {
    logger(
      'error',
      `xhh-tool-watcher 未装配：${hint}。工具面不会被监测。修法：配置 config.decisionPath 指向 `
      + 'src/core/xhh-tool-surface-decision.mjs（契约 v2），或通过 config.decision 注入模块对象。',
    );
    return {
      ok: false,
      enabled: false,
      decisionLoadError,
      snapshot: () => ({
        state: null,
        lastReason: 'decision-unavailable',
        consecutiveMisses: 0,
        lastAlertAt: null,
        hasAlerted: false,
        attempted: false,
        lastAttemptAt: null,
        lastAttemptOutcome: null,
        decisionLoadError,
      }),
    };
  };

  let decision = config.decision ?? null;
  /** 失败报告里的来源标签：注入 vs 具体路径。 */
  let decisionPathLabel = '<injected decision>';
  if (decision === null) {
    // 装到 ~/.dsh/plugins/ 时相对路径 DECISION_MODULE_PATH 解析不到 2A 模块：支持 config.decisionPath
    // 覆盖（相对路径按进程 cwd 解析，绝对路径/URL 原样使用），失败时显式暴露而非静默不装配。
    const customPath = typeof config.decisionPath === 'string' && config.decisionPath !== '' ? config.decisionPath : null;
    const loadTarget = customPath === null
      ? DECISION_MODULE_PATH
      : (/^(file|https?|data):/.test(customPath) ? customPath : pathToFileURL(path.resolve(customPath)).href);
    decisionPathLabel = loadTarget;
    try {
      decision = await import(loadTarget);
    } catch (error) {
      return failAssembly(
        { path: loadTarget, message: humanError(error) },
        `判定模块加载失败（${loadTarget}）：${humanError(error)}`,
      );
    }
  }

  // 契约 v2 校验：注入的模块与加载到的模块都必须提供 v2 API，否则显式装配失败（不存在 v1 兼容回退）。
  const missingApis = [];
  if (typeof decision.recordToolSurfaceObservation !== 'function') missingApis.push('recordToolSurfaceObservation');
  if (typeof decision.noteToolSurfaceDelivery !== 'function') missingApis.push('noteToolSurfaceDelivery');
  if (missingApis.length > 0) {
    return failAssembly(
      { path: decisionPathLabel, message: `判定模块缺少 ${missingApis.join('、')}（需要契约 v2）` },
      `判定模块缺少 ${missingApis.join('、')}（需要契约 v2，路径 ${decisionPathLabel}）`,
    );
  }

  const store = config.store
    ?? (typeof config.statePath === 'string' && config.statePath !== '' ? createFileStore(config.statePath) : null);

  // 通知通道解析（v2.2）：YAML 写不了函数，config.notify 只作测试注入；生产走 notifyUrl →
  // createNotifierFromConfig（内部按 notifySuccessContract 校验，默认 none = 任何 2xx 都只判 unknown）。
  // 配错（URL 非法/契约未知/契约与端点不匹配）一律 error 日志 + 视同未配置，绝不把「受理」当「送达」。
  let notify = typeof config.notify === 'function' ? config.notify : null;
  let notifyConfigured = notify !== null;
  if (notify === null && config.notifyUrl !== undefined && config.notifyUrl !== null && config.notifyUrl !== '') {
    notify = createNotifierFromConfig(config, { log: logger });
    notifyConfigured = notify !== null;
  }
  if (notify === null) {
    logger('warn', '未配置可用通知通道（notifyUrl 缺失/非法），只会记录状态不会提示管理员；不会把任何 HTTP 2xx 当成送达');
  }

  // 阶段 2C 装配（复审 P1-1 指出的缺口）：不配 inboxDir 就等于「只会记录状态、不会排队提醒」。
  // 这里把生产者/回执读取器真正接进来，并在每次定时检查前先回读回执，
  // 否则 lastAttemptAt/lastAlertAt 永远不会推进（unknown 会每分钟重复提醒）。
  const inboxDir = typeof config.inboxDir === 'string' && config.inboxDir.trim() !== '' ? config.inboxDir.trim() : null;
  let producer = null;
  let receiptReaderRef = null;
  const receiptReaderProxy = {
    poll: (opts) => (receiptReaderRef === null
      ? Promise.resolve({ ok: false, reason: 'no-receipt-reader' })
      : receiptReaderRef.poll(opts)),
  };
  if (inboxDir === null) {
    logger('warn', '未配置 inboxDir：缺失提醒不会进入发件箱（只会记录状态）。接线需要把 inboxDir 指向桥接侧的 owner-notice-inbox 目录');
  } else {
    producer = createInboxProducer({ inboxDir, clock: config.now, log: logger });
  }

  const watcher = createToolSurfaceWatcher({
    readToolNames: () => [...ctx.tools.view(undefined).visible.keys()],
    decision,
    now: config.now,
    store,
    notify,
    notifyConfigured,
    config,
    log: logger,
    decisionLoadError: null,
    producer,
    receiptReader: receiptReaderProxy,
  });

  if (inboxDir !== null) {
    receiptReaderRef = createReceiptReader({
      inboxDir,
      decision,
      getState: () => watcher.getState(),
      setState: (next) => { watcher.setState(next); },
      clock: config.now,
      log: logger,
    });
  }

  const runCheck = (source) => {
    // 不阻塞事件循环，也不让异常冒泡到宿主；返回 Promise 便于测试/上层观察（不要求 await）。
    return Promise.resolve()
      // 回执先于观测：先把「上一轮到底送没送到」记账，再判定这一轮要不要提醒。
      // 顺序反了会让 unknown 永远不被记录 ⇒ 每分钟重复提醒（复审 P1-2 的机制）。
      // 回执读取失败（例如 inboxDir/receipts 被建成普通文件 ⇒ ENOTDIR）不能让本轮观测整轮丢掉：
      // 以前 poll 抛错会把 check() 一起带没（独立复审 P2-2：每 tick 只记一次 error，check 一次不跑）。
      .then(() => (source === 'scheduled'
        ? Promise.resolve()
          .then(() => watcher.pollReceipts())
          .catch((error) => {
            logger('warn', `读回执失败（本轮仍继续观测）：${humanError(error)}`);
            return undefined;
          })
        : undefined))
      .then(() => watcher.check({ source }))
      .catch((error) => {
        logger('error', `检查工具面失败：${humanError(error)}`);
        return undefined;
      });
  };

  // 两条路径分离：事件只刷新观测（不计数、不提示），定时 tick 才是唯一计数/提示路径。
  const onChange = () => runCheck('event');
  const onTick = () => runCheck('scheduled');

  const offChange = ctx.on('tools/change', onChange);
  const scheduler = config.scheduler ?? defaultScheduler();
  const intervalMs = Number.isFinite(config.intervalMs) && config.intervalMs > 0 ? config.intervalMs : DEFAULT_INTERVAL_MS;
  const stopTimer = scheduler.every(intervalMs, onTick);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    watcher.dispose();
    try {
      stopTimer?.();
    } catch (error) {
      logger('warn', `停止定时器失败：${humanError(error)}`);
    }
    try {
      if (typeof offChange === 'function') offChange();
    } catch (error) {
      logger('warn', `注销 tools/change 订阅失败：${humanError(error)}`);
    }
  };
  try {
    ctx.on('dispose', dispose);
  } catch (error) {
    logger('warn', `注册 dispose 钩子失败：${humanError(error)}`);
  }

  return { watcher, dispose, intervalMs };
}
