/**
 * 群聊等待策略（纯函数，无 I/O、无定时器）。
 *
 * 群聊里“最后一条新消息之后再静默 N 秒”的等待会被后台默认 10 秒下限或模型显式
 * quietMs=60000 拉长；对方连续补话时又会不断重置静默窗口，导致回复/观察等待没有
 * 硬上限。这里把群聊参数收敛为固定值：
 *  · quietMs：最后一条新消息之后只等 3 秒；
 *  · maxAfterFirstMessageMs：首条新消息（回复等待时为 handler 进入且已有待处理消息）
 *    之后最多再等 6 秒，后续消息不得延长这个总期限。
 *
 * 私聊返回 null，调用方沿用原有配置与钳制逻辑，行为不变。
 */

const GROUP_QUIET_MS = 3000;
const GROUP_MAX_AFTER_FIRST_MESSAGE_MS = 6000;
const GROUP_KEY_PREFIX = 'group:';

/**
 * 判断是否是合法的群聊会话 key（group:<群号>，群号非空）。
 * @param {unknown} key
 * @returns {boolean}
 */
function isGroupSessionKey(key) {
  if (typeof key !== 'string') return false;
  const value = key.trim();
  if (!value.startsWith(GROUP_KEY_PREFIX)) return false;
  return value.slice(GROUP_KEY_PREFIX.length).trim().length > 0;
}

/**
 * 返回群聊等待策略；私聊或不合法 key 返回 null（表示“不套用群策略”）。
 * @param {unknown} key 会话 key（group:<群号> / private:<QQ号>）
 * @returns {{ quietMs: number, maxAfterFirstMessageMs: number } | null}
 */
export function groupWaitPolicy(key) {
  if (!isGroupSessionKey(key)) return null;
  return Object.freeze({
    quietMs: GROUP_QUIET_MS,
    maxAfterFirstMessageMs: GROUP_MAX_AFTER_FIRST_MESSAGE_MS,
  });
}
