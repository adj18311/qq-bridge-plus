// 快速测试入口：7 项模块边界/契约直测 + 测试地基回归。
// 与 full 共用 scripts/test-suite-manifest.mjs 的清单与 test-suite-runner.mjs 的执行语义；
// full 仍是 npm run test:audit / node scripts/test-audit.mjs。
import { runSuiteCli } from './test-suite-runner.mjs';

if (process.argv.length > 2) {
  console.error(`未知参数：${process.argv.slice(2).join(' ')}`);
  console.error('用法：node scripts/test-quick.mjs（无参数；全量用 npm run test:audit）');
  process.exitCode = 2;
} else {
  runSuiteCli('quick');
}
