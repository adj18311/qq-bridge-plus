#!/usr/bin/env node
// scripts/test-background-patrol-report-policy.mjs
//
// 后台巡逻第三阶段（修正版）：概率汇报「七档」纯策略测试。
//
// 用户 2026-10-25 确认的规格（docs/superpowers/specs/2026-10-24-background-patrol-design.md
// §概率汇报）：
//   · 每个平台每天首次实际读取访问结束后为 60%；
//   · 之后依次 50%、40%、30%、20%、10%；
//   · 第 7 次及以后为 0%（不再抽签）；
//   · 判定用半开区间 `random < probability`，相等不命中。
//
// 契约（fail-closed）：
//   · `backgroundReportProbability(readCount)` 对任何非「>=1 安全整数」的输入返回 0（不抛错、不汇报）；
//   · `shouldDrawBackgroundReport(readCount)` 只在概率 > 0 时为 true（第 7 次起不抽签）；
//   · `decideBackgroundReport(readCount, random)` 的 random 仍必须是 [0,1) 有限数字，否则抛 TypeError
//     （即使该档位概率为 0 也不接受非法随机数——调用方不该把 undefined 当随机数）；
//   · 无效 readCount 时 decide 返回 probability 0 / shouldReport false，绝不因为坏输入而汇报。
//
// 纯离线：不读文件、不联网、不发送 QQ、不调用全局 Math.random。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as reportPolicy from '../src/core/background-patrol-report-policy.mjs';

import {
  BACKGROUND_REPORT_PROBABILITIES,
  backgroundReportProbability,
  decideBackgroundReport,
  shouldDrawBackgroundReport,
} from '../src/core/background-patrol-report-policy.mjs';

const SEVEN_TIERS = [0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0];

test('群汇报仅在可信分类为非敏感且群在白名单时放行', () => {
  assert.equal(typeof reportPolicy.allowGroupPatrolReport, 'function');
  const decide = reportPolicy.allowGroupPatrolReport;
  assert.equal(decide({ groupId: '456', allowedGroups: ['456'], classification: 'non-sensitive' }), true);
  for (const classification of ['sensitive', 'unknown', '', null, undefined]) {
    assert.equal(decide({ groupId: '456', allowedGroups: ['456'], classification }), false);
  }
  assert.equal(decide({ groupId: '789', allowedGroups: ['456'], classification: 'non-sensitive' }), false);
  assert.equal(decide({ groupId: '456', allowedGroups: null, classification: 'non-sensitive' }), false);
  assert.equal(decide({ groupId: { toString() { throw new Error('bad'); } }, allowedGroups: [], classification: 'non-sensitive' }), false);
  assert.equal(decide({ groupId: '456', allowedGroups: [{ toString() { throw new Error('bad'); } }], classification: 'non-sensitive' }), false);
  assert.equal(decide(null), false);
});

test('概率表是冻结的七档，严格对应读取第 1 至 7 次', () => {
  assert.equal(Object.isFrozen(BACKGROUND_REPORT_PROBABILITIES), true);
  assert.deepEqual([...BACKGROUND_REPORT_PROBABILITIES], SEVEN_TIERS);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(backgroundReportProbability), SEVEN_TIERS);
});

test('第 7 次及以后概率为 0，不抽签（第 8/100 次同样 0）', () => {
  assert.equal(backgroundReportProbability(7), 0);
  assert.equal(backgroundReportProbability(8), 0);
  assert.equal(backgroundReportProbability(100), 0);
  assert.equal(shouldDrawBackgroundReport(6), true);
  assert.equal(shouldDrawBackgroundReport(7), false);
  assert.equal(shouldDrawBackgroundReport(8), false);
  // 概率为 0 时即使 random=0（最有利）也不命中。
  assert.equal(decideBackgroundReport(7, 0).shouldReport, false);
  assert.equal(decideBackgroundReport(8, 0).shouldReport, false);
});

test('无效 readCount 一律 fail-closed：概率 0、不抽签、不汇报', () => {
  const invalid = [0, -1, 1.5, NaN, Infinity, -Infinity, '1', null, undefined, {}, [], true];
  assert.deepEqual(invalid.map(backgroundReportProbability), invalid.map(() => 0));
  assert.deepEqual(invalid.map(shouldDrawBackgroundReport), invalid.map(() => false));
  for (const readCount of invalid) {
    const decision = decideBackgroundReport(readCount, 0);
    assert.equal(decision.probability, 0, `readCount=${String(readCount)} 概率必须为 0`);
    assert.equal(decision.shouldReport, false, `readCount=${String(readCount)} 不得汇报`);
  }
});

test('逐档边界：random < probability 命中，等于 probability 不命中', () => {
  for (let readCount = 1; readCount <= 7; readCount += 1) {
    const probability = SEVEN_TIERS[readCount - 1];
    if (probability === 0) {
      assert.equal(decideBackgroundReport(readCount, 0).shouldReport, false);
      continue;
    }
    assert.equal(decideBackgroundReport(readCount, 0).shouldReport, true, `第 ${readCount} 次 random=0 必须命中`);
    assert.equal(
      decideBackgroundReport(readCount, probability - Number.EPSILON * 4).shouldReport,
      true,
      `第 ${readCount} 次略小于 ${probability} 必须命中`,
    );
    assert.equal(decideBackgroundReport(readCount, probability).shouldReport, false, `第 ${readCount} 次等于 ${probability} 不得命中`);
    assert.equal(decideBackgroundReport(readCount, probability + 0.000001).shouldReport, false);
  }
});

test('典型边界值按档位钉死（0.599/0.6、0.499/0.5、0.299/0.3、0.099/0.1）', () => {
  const cases = [
    [1, 0.599999, true], [1, 0.6, false],
    [2, 0.499999, true], [2, 0.5, false],
    [3, 0.399999, true], [3, 0.4, false],
    [4, 0.299999, true], [4, 0.3, false],
    [5, 0.199999, true], [5, 0.2, false],
    [6, 0.099999, true], [6, 0.1, false],
  ];
  for (const [readCount, random, expected] of cases) {
    assert.equal(decideBackgroundReport(readCount, random).shouldReport, expected, `read=${readCount} random=${random}`);
  }
});

test('决策是确定性纯函数：同一输入结果稳定，且不触碰全局 Math.random', () => {
  const first = decideBackgroundReport(5, 0.15);
  const second = decideBackgroundReport(5, 0.15);
  assert.deepEqual(first, second);
  assert.deepEqual(first, { readCount: 5, probability: 0.2, random: 0.15, shouldReport: true });

  const original = Math.random;
  Math.random = () => {
    throw new Error('概率策略不得调用全局随机源');
  };
  try {
    assert.equal(decideBackgroundReport(1, 0.59).shouldReport, true);
    assert.equal(decideBackgroundReport(6, 0.09).shouldReport, true);
  } finally {
    Math.random = original;
  }
});

test('非法随机数抛 TypeError（含概率为 0 的档位）', () => {
  for (const random of [-0.1, 1, 1.0001, NaN, Infinity, -Infinity, undefined, null, '0.5', {}, []]) {
    assert.throws(() => decideBackgroundReport(1, random), TypeError, `random=${String(random)} 必须抛 TypeError`);
    assert.throws(() => decideBackgroundReport(7, random), TypeError, `random=${String(random)} 在 0 概率档也必须抛 TypeError`);
  }
});

test('表与返回值不可被外部改写（冻结 + 决策对象为普通新对象）', () => {
  assert.throws(() => {
    'use strict';
    BACKGROUND_REPORT_PROBABILITIES[0] = 1;
  }, TypeError);
  assert.equal(BACKGROUND_REPORT_PROBABILITIES[0], 0.6);
});

// ── task-15 L2：0 概率档与 shouldDraw 的组合契约 ─────────────────────────────
// 契约：调用方必须先用 shouldDrawBackgroundReport(readCount) 判断要不要抽签；
// 概率 0（第 7 次起）时**不要**调用 decideBackgroundReport，也不要传缺省/无效 random——
// decide 本身仍严格拒绝非法 random（保持纯函数单一契约）。report-once 状态机已在 0 档放开
// 缺省 random，这里锁的是策略层的组合用法，避免接线时 TypeError。
test('L2 组合契约：0 档先判 shouldDraw 再决定是否抽签；decide 仍严格拒绝非法 random', () => {
  for (const readCount of [7, 8, 100]) {
    assert.equal(shouldDrawBackgroundReport(readCount), false);
    // 0 档不需要随机数：调用方不应生成，也不应调用 decide。
    assert.equal(shouldDrawBackgroundReport(readCount), backgroundReportProbability(readCount) > 0);
  }
  // 非 0 档必须抽签，且 decide 只接受 [0,1) 有限数字（缺省/NaN/越界都 TypeError）。
  assert.equal(shouldDrawBackgroundReport(6), true);
  for (const random of [undefined, null, NaN, -0.1, 1]) {
    assert.throws(() => decideBackgroundReport(6, random), TypeError);
  }
  // 0 档若误传缺省 random，也必须明确失败而不是静默“不汇报”。
  assert.throws(() => decideBackgroundReport(7, undefined), TypeError);
  // 合规用法：0 档只查 shouldDraw，结果等价于“不汇报”。
  assert.equal(shouldDrawBackgroundReport(7) && decideBackgroundReport(7, 0).shouldReport, false);
});
