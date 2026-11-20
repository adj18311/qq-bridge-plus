// scripts/test-background-patrol-config-contract.mjs
// task-62（P2-2 契约测试）：把「消费面」与「配置白名单」钉在一起。
//
// 为什么需要它（同类问题已经第四次）：
//   · `readOnly`（task-49）
//   · `report`（task-46）
//   · `requireMapperIdentity`（task-58 → task-62 P1）
// 三次事故同一个形状：bridge.js / background-patrol-bridge-hook.mjs 读取
// `backgroundPatrol.<key>`，但 `src/core/background-patrol-session.mjs` 的 CONFIG_KEYS
// 不含该键 ⇒ `resolveBackgroundPatrolConfig()` 判 `unknown-config-field` ⇒
// `createBackgroundPatrolSessionLifecycle()` 直接 disabled（整条后台巡逻静默停摆，
// 或更糟：开关写进 config 反而让巡逻全停）。
//
// 本文件把「bridge/hook 实际消费的 backgroundPatrol.* 键集合」与
// `BACKGROUND_PATROL_CONFIG_KEYS`（= session.mjs 的 CONFIG_KEYS）做交叉校验：
// 任何「消费面有、白名单无」的键立即变红，并给出修复指引。
//
// 变异证明（报告 docs/superpowers/plans/2026-10-28-task62-config-contract.md 记录）：
// 临时从 CONFIG_KEYS 删掉 'requireMapperIdentity'，本文件必须失败——否则是空洞契约。
//
// 全部离线：只读源码文本，不联网、不读 config/state。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { BACKGROUND_PATROL_CONFIG_KEYS } from '../src/core/background-patrol-session.mjs';

// 消费面：这两个文件是真实读取 `backgroundPatrol.<key>` 的入口
// （bridge.js 透传配置、hook 读 readOnly/requireMapperIdentity/enabled 等）。
// 新增消费文件时请加进来——契约测试本身就是「消费面清单」。
const CONSUMER_FILES = [
  'src/bridge.js',
  'src/core/background-patrol-bridge-hook.mjs',
];

/** 提取 `xxx.backgroundPatrol?.key` / `xxx.backgroundPatrol.key` 形式消费的键。 */
function collectConsumedKeys(source) {
  const keys = new Set();
  for (const match of source.matchAll(/backgroundPatrol\s*\?\.\s*([A-Za-z_$][\w$]*)/g)) keys.add(match[1]);
  for (const match of source.matchAll(/backgroundPatrol\s*\.\s*([A-Za-z_$][\w$]*)/g)) keys.add(match[1]);
  return keys;
}

/**
 * bridge.js 里有别名 `const section = cfg.backgroundPatrol;`（启动期运行时/调度用），
 * 之后用 `section.enabled / section.auditDir / section.platforms` 消费。
 * 别名扫描只对 bridge.js 生效（其它文件没有该别名），避免误收无关对象属性。
 */
function collectBridgeAliasKeys(source) {
  const keys = new Set();
  if (!/const section = cfg\.backgroundPatrol\b/.test(source)) return keys;
  for (const match of source.matchAll(/\bsection\s*\.\s*([A-Za-z_$][\w$]*)/g)) keys.add(match[1]);
  return keys;
}

test('契约：bridge/hook 消费的 backgroundPatrol.* 键必须全部在 CONFIG_KEYS 白名单内', async () => {
  const consumed = new Set();
  for (const rel of CONSUMER_FILES) {
    const source = await readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
    for (const key of collectConsumedKeys(source)) consumed.add(key);
    if (rel === 'src/bridge.js') {
      for (const key of collectBridgeAliasKeys(source)) consumed.add(key);
    }
  }
  // 防止扫描器静默失效（例如源码改成别的访问形式导致一个键都扫不到）。
  assert.ok(consumed.size >= 8, `扫描到的 backgroundPatrol 消费键太少（${[...consumed].join(', ')}），契约可能已空洞`);

  const missing = [...consumed].filter((key) => !BACKGROUND_PATROL_CONFIG_KEYS.includes(key)).sort();
  assert.deepEqual(
    missing,
    [],
    `消费面有、CONFIG_KEYS 白名单无：${missing.join(', ')}。\n` +
      '修复：在 src/core/background-patrol-session.mjs 的 CONFIG_KEYS 同步该键，并按同口径补类型校验/透传；\n' +
      '否则 resolveBackgroundPatrolConfig 会判 unknown-config-field，整条后台巡逻生命周期 disabled。',
  );
});

test('契约：三次历史事故键必须留在 CONFIG_KEYS 白名单（删掉会触发 unknown-config-field）', async () => {
  // 显式列出历史事故键：即便将来扫描器/消费面重构，也不允许悄悄把它们从白名单删掉。
  const historical = ['readOnly', 'report', 'requireMapperIdentity'];
  for (const key of historical) {
    assert.ok(
      BACKGROUND_PATROL_CONFIG_KEYS.includes(key),
      `${key} 必须留在 CONFIG_KEYS（历史事故键；删掉会让该配置项触发 unknown-config-field）`,
    );
  }
});

test('契约：仍在使用的历史事故键必须被 bridge/hook 真实消费', async () => {
  // `report` 于 2026-10-30 退役：群汇报名单改为沿用会话白名单 `allow.groups`
  // （用户决定，经 Codex 队长裁决转达）。它必须继续被 CONFIG_KEYS 接受（旧配置不炸），
  // 但不再要求被消费；退役语义由下一条「群汇报名单来源」契约钉住。
  const mustBeConsumed = ['readOnly', 'requireMapperIdentity'];
  const consumed = new Set();
  for (const rel of CONSUMER_FILES) {
    const source = await readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
    for (const key of collectConsumedKeys(source)) consumed.add(key);
    if (rel === 'src/bridge.js') {
      for (const key of collectBridgeAliasKeys(source)) consumed.add(key);
    }
  }
  for (const key of mustBeConsumed) {
    assert.ok(consumed.has(key), `${key} 必须仍被 bridge/hook 消费（若已移除消费点，请同步更新本契约测试）`);
  }
});

test('契约：群汇报名单 = 会话白名单 allow.groups；report.groups 退役但保留兼容', async () => {
  const bridge = await readFile(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const marker = 'buildPatrolReportPlan({';
  const at = bridge.indexOf(marker);
  assert.ok(at >= 0, `bridge 里找不到 ${marker} 调用点——若已重构，请同步更新本契约`);
  const call = bridge.slice(at, at + 400);
  assert.match(call, /allowedGroups:\s*cfg\.allow\?\.groups/, '群汇报名单必须来自会话白名单 cfg.allow.groups');
  assert.doesNotMatch(call, /report\?\.groups/, 'report.groups 不得再作为群汇报名单来源');

  // 兼容面：report 键仍在 CONFIG_KEYS，旧 config 不会因 unknown-config-field 让巡逻整体停摆。
  assert.ok(BACKGROUND_PATROL_CONFIG_KEYS.includes('report'));

  // 设计与契约必须同步：设计文档里必须有退役记录（否则等于「悄悄改语义」）。
  const design = await readFile(
    new URL('../docs/superpowers/plans/2026-10-28-task46-report-content-design.md', import.meta.url),
    'utf8',
  );
  assert.match(
    design,
    /report\.groups[\s\S]{0,120}退役|群汇报名单[\s\S]{0,60}会话白名单/,
    '设计文档必须记录 report.groups 退役与「群汇报名单=会话白名单」的来源变更',
  );
});

test('契约扫描器自检：能识别 `backgroundPatrol?.x` / `backgroundPatrol.x` / bridge section 别名', () => {
  assert.deepEqual(
    [...collectConsumedKeys('const a = cfg.backgroundPatrol?.freshKey; const b = cfg.backgroundPatrol.otherKey;')].sort(),
    ['freshKey', 'otherKey'],
  );
  assert.deepEqual(
    [...collectBridgeAliasKeys('const section = cfg.backgroundPatrol;\nif (section.futureFlag === true) {}')],
    ['futureFlag'],
  );
  assert.deepEqual([...collectBridgeAliasKeys('const section = somethingElse;\nsection.futureFlag')], []);
});
