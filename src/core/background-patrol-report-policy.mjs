/**
 * @deprecated 2026-11-01 起：**概率抽签已取消**（用户决定：每次真实巡逻后由智能体自主决定是否分享）。
 * 本文件里的七档概率/抽签描述与实现均为**退役兼容**：旧快照仍可读入并结算，新流程不再抽签。
 * 现行语义见 docs/superpowers/plans/2026-11-01-patrol-autonomous-share-design.md。
 */
/**
 * 后台巡逻第三阶段（修正版）：实际后台“读取”完成后的概率汇报决策。
 *
 * 这是无状态纯策略：调用方传入同一北京时间日内、已完成的实际读取次数与随机数。
 * 它不计账、不记录尝试、不发送 QQ；平台接线在实际读取成功后调用状态模块协调幂等。
 *
 * 概率阶梯（用户 2026-10-25 确认，见 docs/superpowers/specs/2026-10-24-background-patrol-design.md
 * §概率汇报）：
 *   第 1 次读取 60%，之后 50%、40%、30%、20%、10%，第 7 次及以后 0%（不再抽签）。
 *   搜索不推进阶梯；写操作不占读取额度、也不推进阶梯——这些由调用方只对「实际读取」计数保证。
 *
 * fail-closed 契约：
 *   · 非法 readCount（非 >=1 安全整数）概率按 0 处理、不抽签、不汇报，绝不因坏输入而汇报；
 *   · random 必须是 [0,1) 内的有限数字，否则抛 TypeError（即使该档概率为 0 也不接受坏随机数，
 *     避免调用方把 undefined/NaN 当成“没抽中”蒙混过去）；
 *   · 判定用半开区间 `random < probability`，相等不命中。
 */

/** 七档概率表（冻结）：索引 0 对应当天第 1 次实际读取。 */
export const BACKGROUND_REPORT_PROBABILITIES = Object.freeze([0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0]);

/** 调用者须提供可信的内容分类；缺失、未知或非白名单群均不允许发送。 */
export function allowGroupPatrolReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  if (input.classification !== 'non-sensitive' || !Array.isArray(input.allowedGroups)) return false;
  if (typeof input.groupId !== 'string' && typeof input.groupId !== 'number') return false;
  const id = String(input.groupId ?? '');
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) return false;
  return input.allowedGroups.some((group) => (typeof group === 'string' || typeof group === 'number') && String(group) === id);
}

/**
 * 第 readCount 次实际读取的主动汇报概率。
 * 非法输入（0、负数、小数、NaN、非数字等）与超过第 7 次一律返回 0：不汇报。
 */
export function backgroundReportProbability(readCount) {
  if (!Number.isSafeInteger(readCount) || readCount < 1) return 0;
  return BACKGROUND_REPORT_PROBABILITIES[readCount - 1] ?? 0;
}

/**
 * 这一次读取是否值得抽签：概率 > 0 才需要调用方生成并传入随机数（第 7 次起不抽签）。
 * 非法 readCount 返回 false（与概率 0 一致）。
 */
export function shouldDrawBackgroundReport(readCount) {
  return backgroundReportProbability(readCount) > 0;
}

/**
 * 用调用方注入的 [0,1) 随机数做一次概率判定，返回不可变快照式的普通对象。
 *
 * @param {number} readCount 当天第几次实际读取（1 起）
 * @param {number} random 调用方注入的 [0,1) 随机数（本函数不读取全局随机源）
 * @returns {{ readCount: number, probability: number, random: number, shouldReport: boolean }}
 */
export function decideBackgroundReport(readCount, random) {
  if (!Number.isFinite(random) || random < 0 || random >= 1) {
    throw new TypeError('background report random 必须是 [0, 1) 内的有限数字');
  }
  const probability = backgroundReportProbability(readCount);
  return {
    readCount,
    probability,
    random,
    shouldReport: probability > 0 && random < probability,
  };
}
