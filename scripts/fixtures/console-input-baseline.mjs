// Frozen legacy oracle for scripts/test-console-input.mjs. Test-only; not production code.
//
// Provenance: committed baseline HEAD faaa226 (src/bridge.js, 2026-10-20), captured before this
// seam was extracted. The frozen region is the applyDshModelUpdate(body) *prefix* above the
// '// ② 读盘（只读）' boundary (1-based lines 4087-4146 as present in the original file; the old
// throwaway generator's hardcoded indices were already stale, so the text was transcribed from a
// direct read instead of executing it). Mechanical changes only: the function name, two spaces of
// closure indentation removed, and the explicit return object added. Every expression, comment,
// validation/read order, getter repeat count and error string is byte-identical to the
// pre-extraction source.
//
// Dependencies are the *existing* model-policy pure helpers (the same ones bridge imports); no
// other imports, no I/O, no timers, no global mutable state.
//
// This is a frozen historical differential fixture: expectations are never taken from
// src/core/console-input.mjs, and that module is never imported here. Do not "improve" validation
// while transcribing.

import {
  DSH_OVERRIDE_FIELDS,
  CONV_KEY_RE,
  isPlainObject,
  httpFail,
  requireNonEmptyString,
} from '../../src/core/model-policy.mjs';

export const LEGACY_PROVENANCE = Object.freeze({
  kind: 'test-only frozen historical reference',
  commit: 'faaa226',
  file: 'src/bridge.js',
  functionName: 'applyDshModelUpdate',
  frozenLines: '4087-4146',
  boundaryComment: '② 读盘（只读）'
});

export function baselineParseModelUpdateInput(body) {
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
