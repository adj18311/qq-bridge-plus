/**
 * 后台巡逻步骤 D：后台回合编排纯模块（最小可用切片，未接线）。
 *
 * 把已有纯模块组合成一个「后台回合」的决策器，所有外部依赖全部注入：
 *  · config 门禁（`resolveBackgroundPatrolConfig` 的结果，enabled=false 直接跳过）；
 *  · 会话描述 / prompt（默认复用 `background-patrol-session.mjs` 的纯函数，可注入覆盖）；
 *  · 可用性 `getAvailability()`（QQ 忙/已有后台回合/DSH 不可用/平台暂停）；
 *  · 配额 `authorizeRead` / `authorizeWrite` / `finish`（由唯一权威 controller 或等价实现注入）；
 *  · 汇报 `reportOnce`（background-patrol-report-once 状态机）与 `shouldDraw`（概率策略）；
 *  · 派发 `dispatch`、汇报发送 `send`、时钟 `now`、随机数 `random`。
 *
 * 不 import bridge / DSH / 网络，不启动定时器、不发真实 QQ、不读写文件。
 *
 * 语义（与测试钉住）：
 *  1. 未启用 / 平台未启用 / 不可用 / 已有回合（busy）→ `{ok:true, skipped:true, reason}`，
 *     **不授权、不抽概率、不 dispatch**。
 *  2. `run()` 单飞：一次只跑一个后台回合；同一 opportunityId 重复 run → duplicate-opportunity，
 *     不重复授权/不重复 dispatch（最多保留 128 个机会记录）。
 *  3. 机会到达先 `authorizeRead` 再 `dispatch`；授权拒绝/抛错 → skipped `authorization-denied`
 *     （detail 为原因），零 dispatch、零抽签。提示词构建失败也 fail-closed 跳过（不授权）。
 *  4. dispatch 抛错/未接受 → `{ok:true, dispatched:false, outcome:'unknown', reason:'dispatch-failed'}`：
 *     不自动重试，默认不推进汇报概率阶梯（`advanceOnDispatchFailure` 目前仅接受参数、未实现推进）。
 *  5. dispatch 成功 → 返回 requestId/turn 并登记 pending；调用方用 `completeTurn({turn,outcome})`
 *     回执。只有 `outcome='success'`（真实读取成功）才进入汇报决策；failure/unknown 不汇报。
 *  6. 汇报：shouldDraw(readIndex) 为 false → 不生成随机数、不发送；命中 → `reportOnce.prepare`
 *     抽签一次 → `reportOnce.dispatch` 一次 → `send` 一次 → 按发送结果 settle confirmed/failed/unknown；
 *     同一 readIndex 第二次 prepare 会被 reportOnce 以 duplicate-read 拒绝，绝不重发/重复抽签。
 *  7. `authorizeWrite` 只做委托：写暂停不影响读路径；accessPaused 由注入的 authorizeRead 拒绝。
 *  8. `close()` 后 `run` 返回 skipped closed、`completeTurn` 返回 `{ok:false,reason:'closed'}`。
 *
 * 明确限制（本切片不做）：
 *  · 不接线、不启动调度器；不发送真实 QQ、不访问平台；
 *  · 不阻塞等待回执（completeTurn 由调用方在收到真实协议证据后回调；无回执即 unknown 语义）；
 *  · pending turn 无 TTL/清理（调用方负责按真实回执或断线收尾）；
 *  · dispatch 失败的「推进概率阶梯」参数保留但未实现；写操作仅委托，不实现写回合编排；
 *  · 不写审计日志（调用方按返回结果自行审计）。
 */

import {
  buildBackgroundPatrolPrompt,
  createBackgroundSessionDescriptor,
} from './background-patrol-session.mjs';

const PLATFORMS = Object.freeze(['tieba', 'xiaoheihe']);
const PLATFORM_SET = new Set(PLATFORMS);
const MAX_PROCESSED_OPPORTUNITIES = 128;
const DEFAULT_DESTINATION = 'admin-private';
const REPORT_TEXT_LIMIT = 200;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function skipped(reason, detail) {
  const result = { ok: true, skipped: true, reason };
  if (detail !== undefined) result.detail = detail;
  return result;
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 创建后台回合编排器。
 *
 * @param {object} options
 * @param {object} options.config resolveBackgroundPatrolConfig 的结果
 * @param {(request: {platform:string}) => Promise<{ok:boolean, reason?:string}>} options.getAvailability
 * @param {(request: {platform:string, tool:string, opportunityId:string}) => Promise<object>} options.authorizeRead
 * @param {(request: {sessionKey:string, prompt:string, requestId?:string}) => Promise<object>} options.dispatch
 * @param {object} options.reportOnce background-patrol-report-once 状态机
 * @param {(request: object) => Promise<object>} [options.authorizeWrite]
 * @param {(ticket: object, options: object) => Promise<object>} [options.finish]
 * @param {{preset:string, model?:string, ownerQQ?:string}} [options.session]
 * @param {() => number} [options.now]
 * @param {() => number} [options.random]
 * @param {(readIndex:number) => boolean} [options.shouldDraw]
 * @param {(request: object) => Promise<object>} [options.send]
 * @param {string} [options.destination]
 * @param {Function} [options.createDescriptor]
 * @param {Function} [options.buildPrompt]
 * @param {string} [options.taskText]
 * @param {object} [options.sharedMemory]
 * @param {boolean} [options.advanceOnDispatchFailure]
 */
export function createBackgroundPatrolOrchestrator(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('createBackgroundPatrolOrchestrator：options 必须是对象');
  const source = options;

  if (!isPlainObject(source.config) || typeof source.config.enabled !== 'boolean') {
    throw new TypeError('createBackgroundPatrolOrchestrator：config 必须是 resolveBackgroundPatrolConfig 的结果');
  }
  for (const key of ['getAvailability', 'authorizeRead', 'dispatch']) {
    if (typeof source[key] !== 'function') {
      throw new TypeError(`createBackgroundPatrolOrchestrator：${key} 必须是函数`);
    }
  }
  if (
    !isPlainObject(source.reportOnce)
    || typeof source.reportOnce.prepare !== 'function'
    || typeof source.reportOnce.dispatch !== 'function'
    || typeof source.reportOnce.settle !== 'function'
  ) {
    throw new TypeError('createBackgroundPatrolOrchestrator：reportOnce 必须是 report-once 状态机实例');
  }
  if (source.authorizeWrite !== undefined && typeof source.authorizeWrite !== 'function') {
    throw new TypeError('createBackgroundPatrolOrchestrator：authorizeWrite 必须是函数');
  }
  if (source.finish !== undefined && typeof source.finish !== 'function') {
    throw new TypeError('createBackgroundPatrolOrchestrator：finish 必须是函数');
  }
  if (source.now !== undefined && typeof source.now !== 'function') {
    throw new TypeError('createBackgroundPatrolOrchestrator：now 必须是函数');
  }
  if (source.random !== undefined && typeof source.random !== 'function') {
    throw new TypeError('createBackgroundPatrolOrchestrator：random 必须是函数');
  }
  if (source.shouldDraw !== undefined && typeof source.shouldDraw !== 'function') {
    throw new TypeError('createBackgroundPatrolOrchestrator：shouldDraw 必须是函数');
  }
  if (source.send !== undefined && typeof source.send !== 'function') {
    throw new TypeError('createBackgroundPatrolOrchestrator：send 必须是函数');
  }
  if (source.createDescriptor !== undefined && typeof source.createDescriptor !== 'function') {
    throw new TypeError('createBackgroundPatrolOrchestrator：createDescriptor 必须是函数');
  }
  if (source.buildPrompt !== undefined && typeof source.buildPrompt !== 'function') {
    throw new TypeError('createBackgroundPatrolOrchestrator：buildPrompt 必须是函数');
  }
  if (source.session !== undefined && source.session !== null) {
    if (!isPlainObject(source.session)) throw new TypeError('createBackgroundPatrolOrchestrator：session 必须是对象');
    if (typeof source.session.preset !== 'string' || source.session.preset.trim() === '') {
      throw new TypeError('createBackgroundPatrolOrchestrator：session.preset 必须是非空字符串');
    }
  }
  if (source.advanceOnDispatchFailure !== undefined && typeof source.advanceOnDispatchFailure !== 'boolean') {
    throw new TypeError('createBackgroundPatrolOrchestrator：advanceOnDispatchFailure 必须是布尔值');
  }
  if (source.destination !== undefined && (typeof source.destination !== 'string' || source.destination.trim() === '')) {
    throw new TypeError('createBackgroundPatrolOrchestrator：destination 必须是非空字符串');
  }

  const config = source.config;
  const getAvailability = source.getAvailability;
  const authorizeRead = source.authorizeRead;
  const authorizeWriteInjected = source.authorizeWrite ?? null;
  const finishInjected = source.finish ?? null;
  const dispatch = source.dispatch;
  const reportOnce = source.reportOnce;
  const session = source.session ?? null;
  const now = typeof source.now === 'function' ? source.now : () => Date.now();
  const random = typeof source.random === 'function' ? source.random : () => Math.random();
  const shouldDraw = typeof source.shouldDraw === 'function' ? source.shouldDraw : null;
  const send = typeof source.send === 'function' ? source.send : null;
  const destination = source.destination ?? DEFAULT_DESTINATION;
  const createDescriptor = source.createDescriptor ?? createBackgroundSessionDescriptor;
  const buildPrompt = source.buildPrompt ?? buildBackgroundPatrolPrompt;
  const taskText = source.taskText;
  const sharedMemory = source.sharedMemory;

  const platformConfigs = isPlainObject(config.config) && isPlainObject(config.config.platforms) ? config.config.platforms : {};
  const activePlatforms = Array.isArray(config.activePlatforms) ? config.activePlatforms : [];
  const readIndexCounters = Object.create(null);

  let closed = false;
  let running = false;
  const processed = new Set();
  const pending = new Map();

  function clockNow() {
    const value = now();
    return isFiniteTimestamp(value) ? value : null;
  }

  function isPlatformEnabled(platform) {
    if (config.enabled !== true) return false;
    if (activePlatforms.length > 0) return activePlatforms.includes(platform);
    return platformConfigs[platform] === true;
  }

  function rememberOpportunity(opportunityId) {
    processed.add(opportunityId);
    while (processed.size > MAX_PROCESSED_OPPORTUNITIES) {
      const oldest = processed.values().next().value;
      processed.delete(oldest);
    }
  }

  function nextReadIndex(platform, requested) {
    if (Number.isSafeInteger(requested) && requested >= 1) return requested;
    const previous = Number.isSafeInteger(readIndexCounters[platform]) ? readIndexCounters[platform] : 0;
    return previous + 1;
  }

  function markDispatchConsumed(platform, readIndex) {
    const previous = Number.isSafeInteger(readIndexCounters[platform]) ? readIndexCounters[platform] : 0;
    if (readIndex > previous) readIndexCounters[platform] = readIndex;
  }

  function resolveSessionDescriptor() {
    if (session === null) throw new TypeError('后台巡逻编排：缺少 session 配置（preset 必填）');
    const descriptorOptions = { config, preset: session.preset };
    if (session.model !== undefined) descriptorOptions.model = session.model;
    if (session.ownerQQ !== undefined) descriptorOptions.ownerQQ = session.ownerQQ;
    return createDescriptor(descriptorOptions);
  }

  function buildPromptFor(descriptor, platform) {
    const promptOptions = { descriptor, platform };
    if (sharedMemory !== undefined) promptOptions.sharedMemory = sharedMemory;
    if (taskText !== undefined) promptOptions.taskText = taskText;
    return buildPrompt(promptOptions);
  }

  function defaultReportText({ platform, readIndex }) {
    return truncate(
      `后台巡逻：${platform} 第 ${readIndex} 次读取已完成，本次为主动汇报（敏感内容不在此发送）。`,
      REPORT_TEXT_LIMIT,
    );
  }

  async function maybeReport({ platform, readIndex }) {
    if (!Number.isSafeInteger(readIndex) || readIndex < 1) {
      return { attempted: false, reason: 'invalid-read-index' };
    }
    if (shouldDraw !== null) {
      let draw;
      try {
        draw = shouldDraw(readIndex);
      } catch {
        return { attempted: false, reason: 'should-draw-error' };
      }
      if (draw !== true) return { attempted: false, reason: 'not-drawn' };
    }
    let at = clockNow();
    if (at === null) return { attempted: false, reason: 'invalid-clock' };
    let randomValue;
    try {
      randomValue = random();
    } catch {
      return { attempted: false, reason: 'random-error' };
    }
    if (!isFiniteTimestamp(randomValue) || randomValue < 0 || randomValue >= 1) {
      return { attempted: false, reason: 'invalid-random' };
    }
    let prepared;
    try {
      prepared = reportOnce.prepare({
        readIndex,
        dedupeKey: `${platform}:read:${readIndex}`,
        random: randomValue,
        at,
      });
    } catch {
      return { attempted: false, reason: 'prepare-error' };
    }
    if (!prepared.ok) return { attempted: false, reason: prepared.reason ?? 'prepare-refused' };
    if (prepared.shouldReport !== true) return { attempted: false, reason: 'not-drawn' };

    at = clockNow();
    if (at === null) return { attempted: false, reason: 'invalid-clock' };
    const dispatched = reportOnce.dispatch({ at });
    if (!dispatched || dispatched.ok !== true) {
      return { attempted: false, reason: dispatched?.reason ?? 'dispatch-refused' };
    }

    const text = defaultReportText({ platform, readIndex });
    let sendResult;
    if (send === null) {
      sendResult = { ok: false, reason: 'send-not-configured' };
    } else {
      try {
        sendResult = await send({ destination, platform, readIndex, text });
      } catch {
        sendResult = { ok: false, unknown: true };
      }
    }
    if (!isPlainObject(sendResult)) sendResult = { ok: false, unknown: true };
    const outcome = sendResult.ok === true ? 'confirmed' : (sendResult.unknown === true ? 'unknown' : 'failed');
    const settleAt = clockNow();
    if (settleAt !== null) {
      try {
        reportOnce.settle({ outcome, at: settleAt });
      } catch {
        // 结算失败不影响本回合结果：失败/未知都不自动重发。
      }
    }
    return { attempted: true, outcome, readIndex, destination };
  }

  /**
   * 执行一次后台巡逻机会。
   * @param {{platform:'tieba'|'xiaoheihe', tool:string, opportunityId:string, readIndex?:number, requestId?:string}} request
   */
  async function run(request) {
    if (closed) return skipped('closed');
    if (!isPlainObject(request)) return skipped('invalid-request');
    const { platform, tool, opportunityId } = request;
    if (typeof platform !== 'string' || !PLATFORM_SET.has(platform)) return skipped('invalid-request');
    if (typeof tool !== 'string' || tool.trim() === '') return skipped('invalid-request');
    if (typeof opportunityId !== 'string' || opportunityId.trim() === '') return skipped('invalid-request');

    if (running) return skipped('busy');
    if (config.enabled !== true) return skipped('disabled');
    if (!isPlatformEnabled(platform)) return skipped('platform-disabled');
    if (processed.has(opportunityId)) return skipped('duplicate-opportunity');

    running = true;
    let consumed = false;
    try {
      let availability;
      try {
        availability = await getAvailability({ platform });
      } catch {
        return skipped('unavailable', 'availability-error');
      }
      if (!isPlainObject(availability) || availability.ok !== true) {
        return skipped('unavailable', isPlainObject(availability) && typeof availability.reason === 'string' ? availability.reason : 'unavailable');
      }

      let prompt;
      try {
        const descriptor = resolveSessionDescriptor();
        prompt = buildPromptFor(descriptor, platform);
        if (typeof prompt !== 'string' || prompt.trim() === '') return skipped('session-config-invalid');
      } catch {
        return skipped('session-config-invalid');
      }

      consumed = true;
      let authorization;
      try {
        authorization = await authorizeRead({ platform, tool, opportunityId });
      } catch {
        return skipped('authorization-denied', 'authorization-error');
      }
      if (!isPlainObject(authorization) || authorization.ok !== true) {
        return skipped(
          'authorization-denied',
          isPlainObject(authorization) && typeof authorization.reason === 'string' ? authorization.reason : 'authorization-denied',
        );
      }

      const readIndex = nextReadIndex(platform, request.readIndex);
      const dispatchRequest = { sessionKey: 'patrol:background', prompt };
      if (request.requestId !== undefined) dispatchRequest.requestId = request.requestId;
      let dispatchResult;
      try {
        dispatchResult = await dispatch(dispatchRequest);
      } catch {
        dispatchResult = null;
      }
      if (!isPlainObject(dispatchResult) || dispatchResult.accepted !== true) {
        return { ok: true, dispatched: false, outcome: 'unknown', reason: 'dispatch-failed' };
      }

      markDispatchConsumed(platform, readIndex);
      const turn = dispatchResult.turn;
      const requestId = dispatchResult.requestId ?? request.requestId ?? null;
      const pendingKey = turn ?? requestId ?? opportunityId;
      pending.set(pendingKey, {
        platform,
        readIndex,
        turn: turn ?? null,
        requestId: requestId ?? null,
        opportunityId,
      });
      return {
        ok: true,
        dispatched: true,
        outcome: 'pending',
        platform,
        requestId: requestId ?? null,
        turn: turn ?? null,
        readIndex,
      };
    } finally {
      running = false;
      if (consumed) rememberOpportunity(opportunityId);
    }
  }

  /**
   * 外部回执收尾：记录本轮结果；真实读取成功才进入汇报决策。
   * @param {{turn?:number|string, requestId?:string, outcome:'success'|'failure'|'unknown'}} request
   */
  async function completeTurn(request) {
    if (closed) return { ok: false, reason: 'closed' };
    if (!isPlainObject(request)) return { ok: false, reason: 'invalid-request' };
    const outcome = request.outcome;
    if (outcome !== 'success' && outcome !== 'failure' && outcome !== 'unknown') {
      return { ok: false, reason: 'invalid-outcome' };
    }
    const key = request.turn !== undefined && request.turn !== null ? request.turn : request.requestId;
    if (key === undefined || key === null) return { ok: false, reason: 'unknown-turn' };
    const entry = pending.get(key);
    if (entry === undefined) return { ok: false, reason: 'unknown-turn' };
    pending.delete(key);
    const result = { ok: true, turn: entry.turn, requestId: entry.requestId, platform: entry.platform, outcome };
    if (outcome !== 'success') {
      result.report = { attempted: false, reason: 'read-not-successful' };
      return result;
    }
    const readIndex = Number.isSafeInteger(request.readIndex) && request.readIndex >= 1 ? request.readIndex : entry.readIndex;
    result.report = await maybeReport({ platform: entry.platform, readIndex });
    return result;
  }

  /** 写操作授权：只做委托（写暂停语义由注入的 controller 决定）。 */
  async function authorizeWrite(request) {
    if (closed) return { ok: false, reason: 'closed' };
    if (authorizeWriteInjected === null) return { ok: false, reason: 'write-not-supported' };
    try {
      return await authorizeWriteInjected(request);
    } catch {
      return { ok: false, reason: 'authorization-error' };
    }
  }

  /** 写操作结果收尾：只做委托。 */
  async function finish(ticket, rest) {
    if (closed) return { ok: false, reason: 'closed' };
    if (finishInjected === null) return { ok: false, reason: 'finish-not-supported' };
    try {
      return await finishInjected(ticket, rest);
    } catch {
      return { ok: false, reason: 'finish-error' };
    }
  }

  function snapshot() {
    return {
      running,
      processed: processed.size,
      pending: pending.size,
      closed,
    };
  }

  async function close() {
    if (closed) return;
    closed = true;
    pending.clear();
  }

  return {
    run,
    completeTurn,
    authorizeWrite,
    finish,
    snapshot,
    close,
  };
}
