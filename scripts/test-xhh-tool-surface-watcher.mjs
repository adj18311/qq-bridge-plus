// 聚合入口用的 shim：阶段 2B 的插件测试与插件同目录（plugins/dsh-xhh-tool-watcher/*.test.mjs），
// 但全量套件只从 scripts/ 解析条目（test-suite-runner.mjs:37 的 path.join(scriptsDir, script)）。
// 这里只做「转发 + 透传输出 + 换算退出码」，不复制任何断言，避免两处漂移。
//
// v2.1 起插件测试拆成两份（index.test.mjs 主逻辑 + notifier.test.mjs 通知映射），
// 由本 shim 顺序跑完两者，任一失败即失败；新增 `.test.mjs` 必须同时登记到 TARGETS，
// 否则会被静默漏测（test-xhh-tool-surface-watcher 自身不在套件清单之外，无第二道网）。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'dsh-xhh-tool-watcher');

export const TARGETS = ['index.test.mjs', 'notifier.test.mjs', 'inbox-producer.test.mjs', 'receipt-reader.test.mjs'];

let failed = 0;
for (const name of TARGETS) {
  const target = path.join(pluginDir, name);
  const result = spawnSync(process.execPath, ['--test', target], {
    stdio: 'inherit',
    timeout: 180_000,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  if (result.error) {
    console.error(`插件测试无法启动（${name}）：${result.error.message}`);
    failed += 1;
    continue;
  }
  if (result.status !== 0) {
    console.error(`插件测试失败（${name}）：退出码 ${result.status}`);
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`插件测试有 ${failed}/${TARGETS.length} 个文件失败`);
  process.exitCode = 1;
} else {
  console.log(`插件测试全部通过（${TARGETS.length} 个文件：${TARGETS.join('、')}）`);
  process.exitCode = 0;
}