/**
 * 控制台模型热更新请求的纯解析层：applyDshModelUpdate 的「形状校验」前缀。
 *
 * 只搬 applyDshModelUpdate 在 '// ② 读盘（只读）' 之前的那一段（bridge HEAD faaa226 的
 * 4087-4146 行）：把请求体解析成 { nextProvider, nextModel, nextEffort, patch, removals }，
 * 不碰任何状态。读盘、模型目录校验（fail closed）、鉴权、备份、原子写与 epoch 递增全部留在 bridge。
 *
 * 语义（函数体与原实现逐行一致，本模块不“顺手修”任何校验）：
 *   · 五个顶层字段都只在「自有属性且 !== undefined」时才算提供；
 *   · undefined = 保持、null = 显式清空（仅 reasoningEffort 与覆盖表条目里的 reasoningEffort）、
 *     非空字符串 = 设值（trim 后为空即 400）；nextProvider/nextModel 只在提供时才是字符串，
 *     否则为 null（调用方据此判断是否做了目录校验）；
 *   · modelOverrides 的校验顺序：key 形状 → 条目必须是对象 → 字段白名单 → 按 DSH_OVERRIDE_FIELDS
 *     顺序取值，patch 保持 Object.entries 顺序，clean 的键序恒为白名单顺序；
 *   · removeOverrides 逐项 trim+校验，removals 用 Set 按首次出现去重；
 *   · 错误统一 httpFail(400, …)，文案与原实现逐字一致（外部按 statusCode/message 断言）。
 * nextEffort 是可变局部量：调用方后面会用目录校验的结果改写它，所以这里原样返回可写属性。
 *
 * 依赖只有 model-policy 既有的纯工具，没有 I/O、计时器或全局状态。
 */

import {
  DSH_OVERRIDE_FIELDS,
  CONV_KEY_RE,
  isPlainObject,
  httpFail,
  requireNonEmptyString,
} from './model-policy.mjs';

export function parseModelUpdateInput(body) {
  if (!isPlainObject(body)) throw httpFail(400, '请求体必须是 JSON 对象');
  const given = (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;

  // ① 形状校验（这一步不碰任何状态）
  const nextProvider = given('provider') ? requireNonEmptyString(body.provider, 'provider') : null;
  const nextModel = given('model') ? requireNonEmptyString(body.model, 'model') : null;
  // undefined = 保持；null = 显式清空；字符串 = 设值（目录校验在下面做）。
  let nextEffort;
  if (given('reasoningEffort')) {
    nextEffort = body.reasoningEffort === null
      ? null
      : requireNonEmptyString(body.reasoningEffort, 'reasoningEffort');
  }
  const patch = new Map();
  if (given('modelOverrides')) {
    if (!isPlainObject(body.modelOverrides)) {
      throw httpFail(400, 'modelOverrides 必须是对象：{"<private:QQ号|group:群号>": {"provider": …, "model": …}}');
    }
    for (const [key, value] of Object.entries(body.modelOverrides)) {
      if (!CONV_KEY_RE.test(key)) {
        throw httpFail(400, `modelOverrides 的 key「${key}」非法：应为 private:<QQ号> 或 group:<群号>（号码为正整数）`);
      }
      if (!isPlainObject(value)) throw httpFail(400, `modelOverrides["${key}"] 必须是对象`);
      for (const field of Object.keys(value)) {
        if (!DSH_OVERRIDE_FIELDS.includes(field)) {
          throw httpFail(400, `modelOverrides["${key}"] 不允许字段「${field}」：只允许 ${DSH_OVERRIDE_FIELDS.join(' / ')}`);
        }
      }
      const clean = {};
      for (const field of DSH_OVERRIDE_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(value, field) || value[field] === undefined) continue;
        if (field === 'reasoningEffort') {
          // null 是清空协议，必须原样保留到 nextOverrideTable（不能当「省略」）。
          clean[field] = value[field] === null
            ? null
            : requireNonEmptyString(value[field], `modelOverrides["${key}"].reasoningEffort`);
        } else {
          clean[field] = requireNonEmptyString(value[field], `modelOverrides["${key}"].${field}`);
        }
      }
      if (!Object.keys(clean).length) {
        throw httpFail(400, `modelOverrides["${key}"] 至少要写一个字段（${DSH_OVERRIDE_FIELDS.join(' / ')}）`);
      }
      patch.set(key, clean);
    }
  }
  const removals = new Set();
  if (given('removeOverrides')) {
    if (!Array.isArray(body.removeOverrides)) throw httpFail(400, 'removeOverrides 必须是字符串数组（要删除的 key）');
    for (const item of body.removeOverrides) {
      const key = requireNonEmptyString(item, 'removeOverrides[] 里的每一项');
      if (!CONV_KEY_RE.test(key)) {
        throw httpFail(400, `removeOverrides 里的「${key}」非法：应为 private:<QQ号> 或 group:<群号>（号码为正整数）`);
      }
      removals.add(key);
    }
  }
  if (!nextProvider && !nextModel && nextEffort === undefined && !given('modelOverrides') && !given('removeOverrides')) {
    throw httpFail(400, '没有要改的字段：provider / model / reasoningEffort / modelOverrides / removeOverrides 至少给一个');
  }
  return { nextProvider, nextModel, nextEffort, patch, removals };
}
