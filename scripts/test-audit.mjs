// 全量聚合审计入口（默认 full，行为与改造前一致：串行、每脚本 60s、失败退出码 1）。
// 可显式选择：node scripts/test-audit.mjs full|quick；无参数即 full。
// 两条 npm 命令：npm run test:audit（全量） / npm run test:quick（秒级子集）。
import { runSuiteCli } from './test-suite-runner.mjs';

const args = process.argv.slice(2);
if (args.length > 1 || (args[0] !== undefined && args[0] !== 'full' && args[0] !== 'quick')) {
  console.error(`未知参数：${args.join(' ')}`);
  console.error('用法：node scripts/test-audit.mjs [full|quick]（默认 full）');
  process.exitCode = 2;
} else {
  runSuiteCli(args[0] ?? 'full');
}
