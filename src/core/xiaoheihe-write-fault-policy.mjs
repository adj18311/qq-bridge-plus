/**
 * 小黑盒写故障策略：离线纯状态机（不含任何 I/O）。
 *
 * 2026-10-25 用户决定（task-10，规格 §冲突、失败与恢复 已更新）：
 *  · 连续 3 次**明确 failure** → writePaused=true（带 writeReason='consecutive-failures'），读取不受影响；
 *  · 写暂停**跨北京零点不自动解除**；日切只推进日键（日计数/额度由持久账本层自己重置），
 *    绝不清写暂停、写暂停原因或连续失败链；
 *  · 只有可信管理员恢复（admin-clear + verifiedAdmin）能清写暂停与失败链，并同时清全访问暂停；
 *    恢复**不重置**当日额度、最小间隔或 unknown 记录——本模块没有这些字段，接入方也不得把
 *    admin-clear 当成配额重置；
 *  · `verifiedAdmin:true` 只是调用契约，**不是鉴权**：可信控制台鉴权层必须自己验证来源；
 *  · 未知结果（write-unknown）不累计失败、不清零、不影响暂停；success 只能清「尚未暂停」的失败链；
 *  · accessPaused（登录失效/验证码/网络）跨日保留、只能管理员恢复，不得被日切或写恢复顺带解除；
 *  · 拒绝时间回拨与自相矛盾的状态（writePaused↔writeReason↔失败链阈值 三者必须一致）。
 *
 * 边界（有意保持最小）：
 *  · 只做纯函数状态迁移：输入状态 + 事件 -> 新状态 + 待通知标签；
 *  · 不导入桥接、不读写文件、不访问网络、不发日志、不存 Cookie/令牌/模型文本；
 *  · 唯一的内部依赖是 background-patrol-state.mjs 的 beijingPatrolDayKey（北京时间日键）；
 *  · 不包含预算/额度字段，admin-clear 也不触碰任何外部配额数据；
 *  · notify 只是策略标签，真正落盘/推送/真实发送都留在未来接入（当前无实现）。
 *
 * 未来接入（测试均不覆盖，当前必须视为未实现）：
 *  · 通知投递与落盘：本模块只返回 notify 字符串，由未来的调度器负责持久化与去重落盘；
 *  · 真实发送：写失败/写成功的判定来自未来 bridge 的回执，本模块不发起任何发送或重试；
 *  · 唯一入口：本模块尚未接到生产 bridge，未来应由单一写入口统一调用；
 *  · verifiedAdmin 只是为未来可信管理员网关预留的布尔开关，本身不是鉴权。
 */

import { beijingPatrolDayKey } from './background-patrol-state.mjs';

/** 连续写失败达到该次数即触发写暂停（不再按天解除，只能管理员恢复）。 */
const WRITE_FAILURE_THRESHOLD = 3;

/** 写暂停的唯一合法原因标签（持久化后用于审计/展示）。 */
export const XHH_WRITE_PAUSE_REASON = 'consecutive-failures';

/** 全访问暂停原因白名单（与事件类型同名）。 */
const ACCESS_REASONS = Object.freeze(['login-required', 'captcha', 'network-unavailable']);
const ACCESS_REASON_SET = new Set(ACCESS_REASONS);


/** 允许的事件类型。未知类型一律拒绝，绝不静默忽略。 */
const EVENT_TYPES = new Set([
  'check',
  'write-success',
  'write-failure',
  'write-unknown',
  'login-required',
  'captcha',
  'network-unavailable',
  'admin-clear',
]);

/** 北京时间日期键的格式校验（真正算日期走 beijingPatrolDayKey）。 */
const DAY_KEY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidDayKey(value) {
  if (typeof value !== 'string' || !DAY_KEY_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function asTimestamp(value, label) {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) throw new TypeError(`${label}：Date 必须是有效时刻`);
    return ms;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError(`${label}：必须是有限毫秒时间戳`);
}

function assertState(state) {
  if (!isPlainObject(state)) {
    throw new TypeError('transitionXhhFault：state 必须是策略状态对象');
  }
  const keys = ['day', 'lastEventAt', 'consecutiveWriteFailures', 'writePaused', 'writeReason', 'accessPaused', 'accessReason'];
  if (Object.keys(state).some((key) => !keys.includes(key))) {
    throw new TypeError('transitionXhhFault：state 包含不支持的字段');
  }
  if (!isValidDayKey(state.day)) {
    throw new TypeError('transitionXhhFault：state.day 必须是合法的北京时间日期键');
  }
  if (typeof state.lastEventAt !== 'number' || !Number.isFinite(state.lastEventAt)) {
    throw new TypeError('transitionXhhFault：state.lastEventAt 必须是有限毫秒时间戳');
  }
  if (beijingPatrolDayKey(state.lastEventAt) !== state.day) {
    throw new TypeError('transitionXhhFault：state.day 与 lastEventAt 的北京时间日期不一致');
  }
  if (!isCount(state.consecutiveWriteFailures)) {
    throw new TypeError('transitionXhhFault：consecutiveWriteFailures 必须是 >=0 的整数');
  }
  if (typeof state.writePaused !== 'boolean') {
    throw new TypeError('transitionXhhFault：writePaused 必须是布尔值');
  }
  if (!(state.writeReason === null || state.writeReason === XHH_WRITE_PAUSE_REASON)) {
    throw new TypeError('transitionXhhFault：writeReason 必须是受支持的写暂停原因或 null');
  }
  if (typeof state.accessPaused !== 'boolean') {
    throw new TypeError('transitionXhhFault：accessPaused 必须是布尔值');
  }
  if (!(state.accessReason === null || ACCESS_REASON_SET.has(state.accessReason))) {
    throw new TypeError('transitionXhhFault：accessReason 必须是受支持的暂停原因或 null');
  }
  if (state.accessPaused !== (state.accessReason !== null)) {
    throw new TypeError('transitionXhhFault：accessPaused 与 accessReason 互相矛盾');
  }
  if (state.writePaused !== (state.consecutiveWriteFailures >= WRITE_FAILURE_THRESHOLD)) {
    throw new TypeError('transitionXhhFault：writePaused 与失败次数互相矛盾');
  }
  // 写暂停必须带原因；未暂停时不得残留原因（防止把「已恢复」状态误读为仍暂停）。
  if (state.writePaused !== (state.writeReason === XHH_WRITE_PAUSE_REASON)) {
    throw new TypeError('transitionXhhFault：writePaused 与 writeReason 互相矛盾');
  }
}

function parseEvent(event) {
  if (!isPlainObject(event)) {
    throw new TypeError('transitionXhhFault：event 必须是对象');
  }
  if (typeof event.type !== 'string' || !EVENT_TYPES.has(event.type)) {
    throw new TypeError(`transitionXhhFault：未知事件类型 ${String(event.type)}`);
  }
  const at = asTimestamp(event.at, 'transitionXhhFault：event.at');
  return { type: event.type, at, verifiedAdmin: event.verifiedAdmin === true };
}

/**
 * 初始（干净）状态：北京时间日键 + 0 次失败 + 两个暂停都关闭。
 * 纯函数；非法时间抛 TypeError / RangeError，绝不写文件、绝不联网。
 */
export function initialXhhFaultState(at) {
  const ms = asTimestamp(at, 'initialXhhFaultState：at');
  return {
    day: beijingPatrolDayKey(ms),
    lastEventAt: ms,
    consecutiveWriteFailures: 0,
    writePaused: false,
    writeReason: null,
    accessPaused: false,
    accessReason: null,
  };
}

/** 组合两个暂停范围；仅供离线策略计算，不等于实际工具入口已被拦截。 */
export function xhhFaultPermissions(state) {
  assertState(state);
  return { readAllowed: !state.accessPaused, writeAllowed: !state.accessPaused && !state.writePaused };
}

/**
 * 纯状态迁移：返回 { state, notify }，绝不修改输入。
 *
 *  · writePaused 是**持久**写故障暂停（跨北京零点不自动解除，只能可信管理员恢复）；
 *    accessPaused 是全访问暂停，两者正交，也都只能管理员恢复；
 *  · 日切只推进 day（日计数/额度在持久账本层重置），绝不清写暂停/失败链/原因；
 *  · 事件时间必须不早于 lastEventAt，且日键不得早于当前日键（拒绝时钟回拨）；
 *  · notify 只可能为 null / write-failures / login-required / captcha / network-unavailable。
 */
export function transitionXhhFault(state, event) {
  assertState(state);
  const parsed = parseEvent(event);
  if (parsed.type === 'admin-clear' && parsed.verifiedAdmin !== true) {
    throw new TypeError('transitionXhhFault：admin-clear 仅接受 verifiedAdmin === true（未来可信管理员网关，不是鉴权）');
  }
  if (parsed.at < state.lastEventAt) {
    throw new RangeError('transitionXhhFault：事件时间早于 lastEventAt，拒绝时钟回拨');
  }
  const dayKey = beijingPatrolDayKey(parsed.at);
  if (dayKey < state.day) {
    throw new RangeError('transitionXhhFault：事件日键早于当前日键，拒绝跨日回拨');
  }

  // 只按 schema 构造新对象：不携带未知字段，也不修改输入。
  const next = {
    day: dayKey,
    lastEventAt: parsed.at,
    consecutiveWriteFailures: state.consecutiveWriteFailures,
    writePaused: state.writePaused,
    writeReason: state.writeReason,
    accessPaused: state.accessPaused,
    accessReason: state.accessReason,
  };

  // 北京时间跨日：**只推进日键**。写暂停/失败链/原因都跨日保留（只能管理员恢复），
  // 全访问暂停同样跨日保留。日计数/额度由持久账本层自己按日重置，与本纯策略无关。
  // （2026-10-25 用户决定：旧「当天暂停、跨零点解除」口径作废。）

  let notify = null;

  switch (parsed.type) {
    case 'write-failure': {
      next.consecutiveWriteFailures += 1;
      if (!next.writePaused && next.consecutiveWriteFailures >= WRITE_FAILURE_THRESHOLD) {
        next.writePaused = true;
        next.writeReason = XHH_WRITE_PAUSE_REASON;
        notify = 'write-failures';
      }
      break;
    }
    case 'write-success': {
      // 成功只能在未写暂停时清空连续失败；不能解除写暂停（必须管理员恢复）。
      if (!next.writePaused) next.consecutiveWriteFailures = 0;
      break;
    }
    case 'write-unknown': {
      // 未知结果既不算失败也不算成功：不改计数、不改暂停、不触发任何重试。
      break;
    }
    case 'check': {
      // 只用于日切与时钟校验；不改变任何暂停/失败链。
      break;
    }
    case 'login-required':
    case 'captcha':
    case 'network-unavailable': {
      // 首次进入全访问暂停才通知一次；保留先前已有的写暂停。
      if (!next.accessPaused) {
        next.accessPaused = true;
        next.accessReason = parsed.type;
        notify = parsed.type;
      }
      break;
    }
    case 'admin-clear': {
      // 仅未来可信管理员网关可调用（调用方必须传 verifiedAdmin === true）。
      // 只清暂停与失败链；不重置当日额度/最小间隔/unknown 记录（本模块没有这些字段，
      // 接入方也不得把 admin-clear 当作配额重置）。
      next.consecutiveWriteFailures = 0;
      next.writePaused = false;
      next.writeReason = null;
      next.accessPaused = false;
      next.accessReason = null;
      break;
    }
    default: {
      throw new TypeError(`transitionXhhFault：未知事件类型 ${String(parsed.type)}`);
    }
  }

  return { state: next, notify };
}

