// VM harnesses remove ESM imports before evaluating the bridge. Re-export the real
// core modules once so every harness injects the same production implementations.
export * from '../src/core/json-store.mjs';
export * from '../src/core/qq-text.mjs';
export * from '../src/core/reply-timing.mjs';
export * from '../src/core/group-wait-policy.mjs';
export * from '../src/core/group-wake-batch.mjs';
export * from '../src/core/model-policy.mjs';
export * from '../src/core/image-format.mjs';
// 自主机会接线新增：bridge.js 现在 import 了这两个模块，VM 夹具必须提供同一份实现。
// 少了它们，harness 里 `adaptQzoneOfflineOpportunity` / `openOfflineStore` 是 undefined，
// 定时器一触发就 ReferenceError。
export * from '../src/core/qzone-opportunity-offline.mjs';
export * from '../src/core/qzone-store-offline.mjs';
// A1：熔断通知消费 —— bridge 现在 import 这两个模块，VM 夹具必须提供同一份实现。
export * from '../src/core/qzone-health-probe-runtime.mjs';
export * from '../src/core/qzone-policy-offline.mjs';
export * from '../src/core/qzone-notice-runtime.mjs';
export * from '../src/core/qzone-owner-notice-adapter.mjs';
export * from '../src/core/persona-text.mjs';
export * from '../src/core/console-input.mjs';
export * from '../src/core/role-store.mjs';
export * from '../src/core/runtime-config.mjs';
export * from '../src/core/session-store.mjs';
export * from '../src/core/wake-timers.mjs';
export * from '../src/core/wake-policy.mjs';
export * from '../src/core/watchdog-policy.mjs';
export * from '../src/core/dsh-connection-watch.mjs';
export * from '../src/core/background-patrol-bridge-hook.mjs';
export * from '../src/core/background-patrol-audit.mjs';
export * from '../src/core/background-patrol-state.mjs';
export * from '../src/core/background-patrol-schedule-store.mjs';
export * from '../src/core/background-patrol-scheduler.mjs';
export * from '../src/core/background-patrol-session-lifecycle.mjs';
export * from '../src/core/background-patrol-report-once.mjs';
export * from '../src/core/background-patrol-report-content.mjs';
export * from '../src/core/background-patrol-notify.mjs';
export * from '../src/core/owner-notice-bridge-wiring.mjs';
// m33778 方案 2：后台巡逻受限令牌。bridge 的集中关卡与贴吧两条只读路由要用
// backgroundTokenAllowsRequest 做作用域判定；harness 必须注入真实模块，否则 VM 里
// 它是 undefined → 后台令牌恒被拒（假绿/假红都可能）。
export * from '../src/core/background-patrol-agent-token.mjs';
export * from '../src/core/xiaoheihe-identity-guard.mjs';
// A-2：降级只读层。bridge 在守卫不可用 / 身份模式 legacy 时用它接管门禁；harness 必须注入
// 真实模块，否则 `createXiaoheiheDegrade` 在 VM 里是 undefined → 降级层恒为 null（假绿）。
export * from '../src/core/xiaoheihe-degrade.mjs';
// task-87：bridge 顶层用专栏密码模块的 7 个函数；VM harness 删掉 import 后靠这里注入。
export * from '../src/core/console-column-auth.mjs';
// 写入许可 IPC：bridge.js 顶层 import 了 readQzoneWritePermitConfig / readQzoneWriteAdmitConfig /
// businessActionOf / createApprovedBindingLedger / createQzoneWritePermitIpcServer 五个名字。VM harness
// 删掉 import 行后靠这里注入；漏了就是 `createApprovedBindingLedger is not defined`，会在 bridge
// 模块初始化时直接炸掉 —— 这也是 request-id-bridge / console-http / real-host-offline-chain /
// bridge-epoch-wiring 四个套件长期失败的原因（与业务逻辑无关，纯粹是 harness 漏注入）。
export * from '../src/qzone-write-permit-ipc.mjs';
// 审批 IPC 的配置解读（纯函数）：同样被 VM harness 删掉 import 后需要注入，
// 否则 getQzoneConsoleRuntime 里 `readQzoneApprovalIpcConfig is not defined` ⇒ 控制台整台 503。
export * from '../src/qzone-approval-ipc-startup.mjs';

// bridge.js 顶层 import 用了别名（getColumnAuthStatus 等）；VM harness 删掉 import 后，
// 必须把**别名**也注入，否则 `xxx is not defined`（task-87 首跑踩到）。
export {
  getAuthStatus as getColumnAuthStatus,
  setPassword as setColumnPassword,
  verifyPassword as setColumnVerifyPassword,
  verifySession as verifyColumnSession,
  revokeSession as revokeColumnSession,
  revokeAllSessions as revokeColumnAllSessions,
  forgotResetPassword as forgotResetColumnPassword,
} from '../src/core/console-column-auth.mjs';
// task-77（GPT 复核 #2）：bridge 顶层用 ownerCommsCurrentlyUp / OWNER_COMMS_RECEIPT_WINDOW_MS，
// VM harness 删掉 import 后必须靠这里注入，否则 `const OWNER_RECEIPT_WINDOW_MS = ...` 直接 ReferenceError。
export * from '../src/core/owner-comms-health.mjs';
export * from '../src/core/tieba-patrol-ledger.mjs';
export * from '../src/core/tieba-patrol-adapter.mjs';
export * from '../src/core/send-gaps.mjs';
export * from '../src/core/tool-log-format.mjs';
export * from '../src/core/memory-text.mjs';
export * from '../src/core/runtime-records.mjs';
export * from '../src/console/role-routes.mjs';
// 任务卡（2026-10-27 小黑盒控制台专栏）：能力开关 / 只读 / 巡逻时段 / 每日额度配置。
// bridge 里用别名 import（避免与其它模块的同名导出混淆），VM 注入必须提供同样的别名，
// 否则 `CONSOLE_SETTINGS_RELATIVE_PATH` 等在 VM 里 undefined → 配置路径拼不出来。
export {
  XHH_CONSOLE_QUOTA_MAX as CONSOLE_QUOTA_MAX,
  XHH_CONSOLE_SETTINGS_RELATIVE_PATH as CONSOLE_SETTINGS_RELATIVE_PATH,
  failSafeSettings as failSafeConsoleSettings,
  loadSettings as loadConsoleSettings,
  normalizeSettings as normalizeConsoleSettings,
  saveSettings as saveConsoleSettings,
  decidePatrolDispatch,
  windowContains,
} from '../src/core/xiaoheihe-console-settings.mjs';

// Fish Diary（P1b 接线）：bridge 端点用的存储工厂。
// VM 夹具会 `Object.assign(globalThis, coreBindings)`，所以这里必须导出同名绑定，
// 否则 bridge 里 `createDiaryStore(...)` 在虚拟环境里是 undefined —— 端点会静默 500。
export { createDiaryStore, DIARY_FILES, DEFAULT_LIMITS } from '../src/core/diary-store.mjs';

export { bindQzoneConnectionEpoch } from '../src/core/qzone-connection-epoch-runtime.mjs';
// Fish Diary（P2 方案 C）：控制台配置读写模块。bridge 顶层 import 了 6 个符号，
// VM harness 删掉 import 后必须靠这里注入，否则 readDiaryConfig 里 loadDiaryConfig
// 是 undefined → 7 个控制台端点全部 500（假红）。纯测试基建，不改生产行为。
export {
  loadDiaryConfig, saveDiaryConfig, mergeDiaryConfig, normalizeDiaryConfig,
  defaultDiaryConfig, diaryEffectiveLimits, DIARY_CONFIG_RELATIVE_PATH,
  DIARY_TOOL_NAMES, DIARY_LIMIT_SPECS, DIARY_HTTP_MAX_BODY_BYTES,
} from '../src/core/diary-config.mjs';

