// 权威测试清单（唯一来源）：full 与 quick 都从这里取，避免两份列表漂移。
//
// · ORIGINAL_FULL_TESTS 是 2026-10-17 之前的 48 项聚合审计注册表，顺序原样冻结；
//   新增的测试地基回归只追加在 FULL_TESTS 末尾，不改变既有执行顺序。
// · quick 跑 7 项模块边界/契约直测 + 测试地基回归 + 唤醒定时器/看门狗纯判定与支撑规则检查，目标是秒级、离线、无外部服务。
// · 每脚本超时仍是 60s（与旧 test-audit.mjs 一致），不因 quick 而放宽或收紧。
export const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000;

export const ORIGINAL_FULL_TESTS = [
  // 模块边界的直接行为测试：与生产入口导入同一实现，不再依赖源码所在行。
  'test-json-store.mjs', 'test-qq-text.mjs', 'test-model-policy.mjs', 'test-role-store.mjs',
  'test-runtime-config.mjs', 'test-session-store.mjs',
  'test-bridge-core-contract.mjs',
  'test-send-image.mjs', 'test-audit-bridge.mjs', 'test-audit-protocol.mjs', 'test-audit-protocol-helpers.mjs',
  'test-audit-security.mjs', 'test-audit-security-mcp.mjs',
  'test-audit-setup.mjs', 'test-audit-setup-guards.mjs',
  'test-dsh-inbox-projection.mjs',
  'test-md-to-plain.mjs', 'test-slang-learn.mjs', 'test-mux-reconnect.mjs',
  'test-token-economy.mjs', 'test-qq-model-view.mjs', 'test-qq-preset-contract.mjs',
  'test-tieba-lib.mjs', 'test-tieba-patrol.mjs',
  'test-reply-wait.mjs', 'test-preset-prompt.mjs', 'test-role-card.mjs',
  'test-token-usage.mjs', 'test-hardening.mjs',
  'test-shared-memory.mjs',
  'test-busy-watchdog.mjs',
  'test-c-reconnect.mjs',
  'test-cross-session-send.mjs',
  'verify-snowluma-upstream-health.mjs',
  'test-slang-selection.mjs',
  'test-voice.mjs', 'test-voice-volume.mjs', 'test-voice-edge.mjs', 'test-voice-gui.mjs',
  'test-console-static.mjs',
  'test-voice-system.mjs',
  'test-snowluma-conn.mjs',
  'test-encoding.mjs', 'test-console-encoding.mjs',
  'test-start-guard.mjs',
  'test-preset-local-tools.mjs',
  'test-qq-mode-plugin.mjs',
  'test-snowluma-upstream-health.mjs'
];

// quick 的 7 项：模块边界/契约直测（不依赖外部服务、不跑长任务）。
export const CORE_TESTS = ORIGINAL_FULL_TESTS.slice(0, 7);

// 测试地基自身：清单/runner 契约 + 语音文档断言负向回归。
export const TEST_FOUNDATION_TESTS = ['test-test-suite.mjs', 'test-voice-doc-check.mjs'];
export const WAKE_TIMER_TESTS = ['test-wake-timers.mjs', 'test-wake-timer-integration.mjs'];
export const WATCHDOG_POLICY_TESTS = ['test-watchdog-policy.mjs', 'test-watchdog-integration.mjs'];
export const WATCHDOG_SUPPORT_TESTS = ['test-watchdog-support.mjs'];
export const WAKE_POLICY_TESTS = ['test-wake-policy.mjs', 'test-wake-policy-integration.mjs'];
export const WAKE_TRIGGER_TESTS = ['test-wake-trigger.mjs', 'test-wake-trigger-integration.mjs'];
// 既有路由模块尚未接入生产入口；独立单测仍应由 full 门禁持续覆盖。
// runner 以 scripts/ 为基准解析路径，不展开通配符。
export const SESSION_ROUTER_TESTS = ['../src/core/session-router.test.mjs'];
export const REPLY_TIMING_BASELINE_TESTS = ['test-reply-timing-baseline.mjs'];
export const REPLY_TIMING_POLICY_TESTS = ['test-reply-timing-policy.mjs'];
// 三条纯缝：三份模块直测 + 真桥接边界集成（console-input / persona-text / image-format）。
export const PURE_SEAM_TESTS = [
  'test-console-input.mjs', 'test-persona-text.mjs', 'test-image-format.mjs',
  'test-pure-seams-integration.mjs'
];
// 模型端点隔离 HTTP 集成只进 full：依赖临时 console server，不属于秒级 quick。
export const MODEL_ENDPOINT_TESTS = ['test-model-endpoint.mjs'];
// 三条纯策略缝：三份模块直测 + 真桥接边界集成（send-gaps / tool-log-format / memory-text）。
export const POLICY_WAVE_TESTS = [
  'test-send-gaps.mjs', 'test-tool-log-format.mjs', 'test-memory-text.mjs',
  'test-policy-wave-integration.mjs'
];
// Node3：控制台人格路由 + 反馈/工具日志存储两条缝（模块直测 + 真桥接隔离 HTTP 集成）。
export const NODE3_TESTS = [
  'test-role-routes.mjs', 'test-runtime-records.mjs', 'test-node3-integration.mjs'
];
export const DSH_021_TESTS = [
  'test-dsh-021-compat.mjs',
  'test-long-wait-http.mjs',
  // F.2：profile Team 片段的版本门控 + 纯合并函数 + 幂等/备份回归。
  'test-dsh-021-profile-patch.mjs'
];
// setup 定位 DSH CLI：DSH_CLI → 安装目录（ASAR 推导）→ PATH 的解析顺序、无效候选降级、
// 绝对路径执行与失败/超时告警。依赖全部注入，不依赖宿主机 PATH 或 DSH 是否安装。
export const DSH_CLI_TESTS = ['test-dsh-cli-resolve.mjs'];
// Windows DSH Desktop 随机端口：进程归属发现 + qq-mode 命名空间核验的纯判定与串行重试回归。
// 每轮有时间预算，未成功时持续重试且不与上一轮重叠；全部离线、注入依赖，不依赖本机是否安装 DSH 或真实监听端口。
export const DSH_CONNECTION_TESTS = ['test-dsh-desktop.mjs', 'test-dsh-connection-watch.mjs', 'test-dsh-discovery-logging.mjs'];
// 群等待/合批策略：群聊 3 秒静默 + 首条新消息后 6 秒固定上限，以及唤醒合批窗口升级的纯缝直测。
// 本发布同样 full 与 quick 都覆盖（不依赖外部服务），不改变既有 RELEASE_TESTS 等组顺序。
export const GROUP_WAIT_BATCH_TESTS = ['test-group-wait.mjs', 'test-group-wake-batch.mjs'];

// 上游错误分类 + 5 分钟冷却门控（含「QQ 文案不得回显原始 JSON」的负向断言），
// 以及本发布「不做额度检测」的隔离回归；事故复现相关，full 与 quick 都必须覆盖。
export const AGENT_ERROR_NOTICE_TESTS = ['test-agent-error-notice.mjs', 'test-retry-observer.mjs', 'test-retry-diagnostic.mjs', 'test-retry-observer-integration.mjs', 'test-notice-p1-integration.mjs', 'test-release-no-quota.mjs'];

// 发布隐私扫描独立回归组：LICENSE 只允许精确公开联系地址、其它 LICENSE 邮箱照报、JSON 凭据字面量与扫描器边界均需覆盖。
// 独立成组便于维护，同时进入 full 与 quick，不改变既有清单顺序。
export const RELEASE_TESTS = ['release-privacy-scan.test.mjs'];

export const FULL_TESTS = [...ORIGINAL_FULL_TESTS, ...TEST_FOUNDATION_TESTS, ...WAKE_TIMER_TESTS, ...WATCHDOG_POLICY_TESTS, ...WATCHDOG_SUPPORT_TESTS, ...WAKE_POLICY_TESTS, ...WAKE_TRIGGER_TESTS, ...SESSION_ROUTER_TESTS, ...REPLY_TIMING_BASELINE_TESTS, ...REPLY_TIMING_POLICY_TESTS, ...PURE_SEAM_TESTS, ...MODEL_ENDPOINT_TESTS, ...POLICY_WAVE_TESTS, ...NODE3_TESTS, ...DSH_021_TESTS, ...DSH_CLI_TESTS, ...AGENT_ERROR_NOTICE_TESTS, ...RELEASE_TESTS, ...DSH_CONNECTION_TESTS, ...GROUP_WAIT_BATCH_TESTS];
export const QUICK_TESTS = [...CORE_TESTS, ...TEST_FOUNDATION_TESTS, ...WAKE_TIMER_TESTS, ...WATCHDOG_POLICY_TESTS, ...WATCHDOG_SUPPORT_TESTS, ...WAKE_POLICY_TESTS, ...WAKE_TRIGGER_TESTS, ...REPLY_TIMING_BASELINE_TESTS, ...REPLY_TIMING_POLICY_TESTS, ...PURE_SEAM_TESTS, ...POLICY_WAVE_TESTS, ...NODE3_TESTS, ...DSH_021_TESTS, ...DSH_CLI_TESTS, ...AGENT_ERROR_NOTICE_TESTS, ...RELEASE_TESTS, ...DSH_CONNECTION_TESTS, ...GROUP_WAIT_BATCH_TESTS];

function assertUnique(list, label) {
  const seen = new Set();
  for (const name of list) {
    if (seen.has(name)) throw new Error(`${label} 清单重复：${name}`);
    seen.add(name);
  }
}
assertUnique(FULL_TESTS, 'full');
assertUnique(QUICK_TESTS, 'quick');
for (const name of QUICK_TESTS) {
  if (!FULL_TESTS.includes(name)) throw new Error(`quick 含不在 full 里的脚本：${name}`);
}
