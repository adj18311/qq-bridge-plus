/**
 * 群聊唤醒合并窗口的纯策略函数。
 *
 * 背景：私聊沿用既有的 Math.max(1000, Number(configuredMs) || 8000) 合并窗口；
 * 群聊消息密度高，旧默认/显式配置（8s、60s）会让 @、点名、提问这类明确触发
 * 也拖到很久以后才投递。这里为群聊引入更短的窗口上限，同时尊重用户更短的既有配置：
 *   · 明确触发（atMention / nameMention / question）：上限 2000ms
 *   · 其它触发（keyword / speaker / anyMessage / probability / poke 等）：上限 4000ms
 *   · 取 min(既有配置, 上限)，因此配置的 1000ms 等更短窗口不会被放大。
 *
 * 本模块是纯函数：不读配置、不注册定时器、不做 I/O，便于真实 bridge 与纯单测复用。
 */

const MIN_WAKE_BATCH_MS = 1000;
const PRIVATE_DEFAULT_BATCH_MS = 8000;
const GROUP_PRECISE_BATCH_MS = 2000;
const GROUP_NORMAL_BATCH_MS = 4000;
const GROUP_PRECISE_REASONS = new Set(['atMention', 'nameMention', 'question']);

/**
 * 计算某次唤醒最终使用的合并窗口。
 *
 * @param {string} key 会话 key（group:<群号> / private:<QQ号>）
 * @param {string} reason 唤醒原因，可能带子类型（如 keyword:小鲸鱼、speaker:昵称）
 * @param {number|string} [configuredMs] 会话当前配置的 batchWindowMs
 * @returns {number} 合并窗口毫秒数
 */
export function groupWakeBatchMs(key, reason, configuredMs) {
  // 保持私聊既有公式一字不差：非法/缺省回退 8s，最短 1s。
  const configured = Math.max(MIN_WAKE_BATCH_MS, Number(configuredMs) || PRIVATE_DEFAULT_BATCH_MS);
  if (typeof key !== 'string' || !key.startsWith('group:')) return configured;

  // 原因可能带子类型，只取冒号前的基名参与判断（keyword:xx 仍是普通触发）。
  const baseReason = String(reason ?? '').split(':')[0].trim();
  const cap = GROUP_PRECISE_REASONS.has(baseReason) ? GROUP_PRECISE_BATCH_MS : GROUP_NORMAL_BATCH_MS;
  // 只缩不放：更短的既有配置（如 1000ms）优先；旧默认 8s / 显式 60s 不覆盖新上限。
  return Math.min(configured, cap);
}
