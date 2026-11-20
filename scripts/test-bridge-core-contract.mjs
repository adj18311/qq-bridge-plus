// Verify native ESM linkage as well as VM bindings: a source-evaluating harness
// alone could accidentally hide a missing or wrongly named production import.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as bindings from './bridge-core-bindings.mjs';

const bridgeUrl = new URL('../src/bridge.js', import.meta.url);
const source = fs.readFileSync(bridgeUrl, 'utf8');
const imports = [...source.matchAll(/^import\s*\{([^}]+)\}\s*from\s*['"](\.\/(?:core|console)\/[^'"]+)['"];?/gm)];
// task-87：bridge 顶层开始用 `import { a as b }` 别名（如 getAuthStatus as getColumnAuthStatus）。
// 早先这里把 `a as b` 当成一个名字去查导出，必然红——那不是生产代码的问题，是测试能力缺口。
// 这里把每个 specifier 解析成 { exported, local }，导出存在性查 exported，绑定身份查 local。
function parseImportSpecifier(raw) {
  const text = raw.replace(/\/\/[^\n]*/g, '').trim(); // 允许闭包内写行注释
  if (text === '') return null;
  const parts = text.split(/\s+as\s+/);
  const exported = parts[0].trim();
  return { exported, local: (parts[1] ?? parts[0]).trim() };
}

test('production bridge core and console imports resolve through the native ESM loader', async () => {
  assert.deepEqual(imports.map(([, , specifier]) => specifier).sort(), [
    './console/role-routes.mjs',
    './core/background-patrol-agent-token.mjs',
    './core/background-patrol-audit.mjs',
    './core/background-patrol-bridge-hook.mjs',
    './core/background-patrol-notify.mjs',
    './core/background-patrol-report-content.mjs',
    './core/background-patrol-report-once.mjs',
    './core/background-patrol-schedule-store.mjs',
    './core/background-patrol-scheduler.mjs',
    './core/background-patrol-session-lifecycle.mjs',
    './core/background-patrol-state.mjs',
    // task-87：小黑盒专栏独立密码（用户裁定 m19958）认证核心。
    './core/console-column-auth.mjs',
    './core/console-input.mjs',
    // Fish Diary（P1b 接线）：bridge 端点的存储工厂。
    // Fish Diary（P2 控制台方案 C）：state/diary-config.json 的读写/校验，供限额热生效使用。
    './core/diary-config.mjs',
    './core/diary-store.mjs',
    './core/dsh-connection-watch.mjs', './core/group-wait-policy.mjs',
    './core/group-wake-batch.mjs', './core/image-format.mjs', './core/json-store.mjs',
    './core/memory-text.mjs', './core/model-policy.mjs',
    // task-77（GPT 复核 #2）：「QQ 通信已恢复」现算口径（WS 连接 / 上游自评 / 账号在线 / 事件包流动）。
    './core/owner-comms-health.mjs',
    // 阶段 2C：owner 通知发件箱接线（收件箱 → 发件箱 → 送达回执）。
    './core/owner-notice-bridge-wiring.mjs',
    './core/persona-text.mjs',
    './core/qq-text.mjs', './core/qzone-connection-epoch-runtime.mjs', './core/qzone-health-probe-runtime.mjs', './core/qzone-notice-runtime.mjs', './core/qzone-opportunity-offline.mjs', './core/qzone-owner-notice-adapter.mjs', './core/qzone-policy-offline.mjs', './core/qzone-store-offline.mjs', './core/reply-timing.mjs', './core/role-store.mjs',
    './core/runtime-config.mjs', './core/runtime-records.mjs', './core/send-gaps.mjs',
    './core/session-store.mjs',
    './core/tieba-patrol-adapter.mjs',
    './core/tieba-patrol-ledger.mjs',
    './core/tool-log-format.mjs', './core/wake-policy.mjs',
    './core/wake-timers.mjs', './core/watchdog-policy.mjs',
    // A-2：降级只读层（身份守卫不可用 / legacy 身份模式时的替代门禁）。
    './core/xiaoheihe-console-settings.mjs',
    './core/xiaoheihe-degrade.mjs',
    './core/xiaoheihe-identity-guard.mjs',
  ]);
  const declarations = imports.map(([, names, specifier]) =>
    `import {${names}} from ${JSON.stringify(new URL(specifier, bridgeUrl).href)};`).join('\n');
  await import(`data:text/javascript;base64,${Buffer.from(declarations).toString('base64')}`);
});

test('VM core/console bindings are the same exported objects used by production imports', async () => {
  for (const [, names, specifier] of imports) {
    const module = await import(new URL(specifier, bridgeUrl).href);
    const pairs = names.split(',').map(parseImportSpecifier).filter(Boolean);
    for (const { exported, local } of pairs) {
      assert.ok(Object.hasOwn(module, exported), `${specifier} exports ${exported}`);
      // VM harness 删掉 import 后按**本地名**注入，所以要比的是 local 名的绑定。
      assert.equal(bindings[local], module[exported],
        `${local} is not the same object as ${specifier} ${exported}`);
    }
  }
});

test('every full-bridge VM runner injects the shared core bindings, including standalone verifiers', () => {
  const scriptsDir = new URL('.', import.meta.url);
  const runners = fs.readdirSync(scriptsDir).filter(name => name.endsWith('.mjs')).map(name => ({
    name, text: fs.readFileSync(new URL(name, scriptsDir), 'utf8'),
  })).filter(({ text }) => text.includes('droppingImport') && /^\s*const context = vm\.createContext\(/m.test(text));
  for (const name of ['verify-busy-watchdog.mjs', 'verify-cross-session-send.mjs', 'verify-slang-selection.mjs']) {
    assert.ok(runners.some(runner => runner.name === name), `${name} must be covered by discovery`);
  }
  for (const { name, text } of runners) {
    assert.match(text, /import \* as coreBindings from ['"]\.\/bridge-core-bindings\.mjs['"]/, name);
    assert.match(text, /\.\.\.coreBindings\b/, `${name} injects the imported bindings`);
  }
});
