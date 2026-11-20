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
// full 与 quick 都必须覆盖（不依赖外部服务）。
export const GROUP_WAIT_BATCH_TESTS = ['test-group-wait.mjs', 'test-group-wake-batch.mjs'];

// 后台探索第一阶段：独立调度骨架与停止/重启重入回归，注入假时钟，不投递真实模型请求。
export const BACKGROUND_PATROL_TESTS = ['test-background-patrol-scheduler.mjs', 'test-background-patrol-reentrancy.mjs'];
// 后台探索第二阶段：独立持久日账。只用临时目录与假时钟，不接触真实 state 或平台。
export const BACKGROUND_PATROL_STATE_TESTS = ['test-background-patrol-state.mjs', 'test-background-patrol-adjusted-limits.mjs'];
// 第三阶段：后台 prompt 的精确 turn 标记，以及无状态的概率汇报决策。
export const BACKGROUND_PATROL_OUTPUT_TESTS = ['test-background-patrol-output.mjs'];
// 后台探索第三/四阶段（B 线，2026-10-25 修正）：七档概率汇报纯策略、汇报「一次读取至多一次尝试」
// 状态机、贴吧 5/日唯一持久账本。全部离线纯模块（注入时钟/fsOps + 系统临时目录，约 0.3 秒），
// full 与 quick 都覆盖；作为独立分组追加在两个清单末尾，不改变既有条目执行顺序。
// task-15 L4：此前三套新测试未进任何清单（inFull/inQuick 均为 false），独立审查判门禁缺失，现补入。
export const BACKGROUND_PATROL_REPORT_TESTS = [
  'test-background-patrol-report-policy.mjs',
  'test-background-patrol-report-once.mjs',
  'test-tieba-patrol-ledger.mjs'
];

// 后台探索第四/五/六阶段契约 + 唯一权威控制器（task-19 补门禁）：
// 贴吧请求边界（29 项）、小黑盒只读巡逻（14 项）、小黑盒故障策略（26 项）、
// 小黑盒唯一权威操作控制器（19 项）。全部离线纯模块（注入 fetch/limiter/时钟/fsOps + 系统临时目录，
// 单跑含 node 启动均 <0.25 秒）⇒ full 与 quick 都覆盖；作为独立分组追加在两个清单末尾，
// 不改变既有条目执行顺序。此前四个文件 inFull/inQuick 均为 false，独立审查判门禁缺失，现补入。
export const BACKGROUND_PATROL_CONTRACT_TESTS = [
  'test-xiaoheihe-read-patrol.mjs',
  'test-xiaoheihe-write-fault-policy.mjs',
  'test-tieba-patrol-request-boundary.mjs',
  'test-xiaoheihe-operation-controller.mjs'
];

// 后台探索步骤 D：结构化审计 + 7 自然日轮转（task-24 补门禁）。
// 18 项纯离线测试（注入时钟/fsOps + 系统临时目录，单跑含 node 启动约 0.22 秒）：
// 字段白名单/敏感字段拒绝、JSONL 追加与写入失败状态、坏行容错、并发串行、跨北京日文件命名、
// 7 天边界清理、路径越界/符号链接拒绝 ⇒ full 与 quick 都覆盖；作为独立分组追加在两个清单末尾，
// 不改变既有条目执行顺序。此前该文件 inFull/inQuick 均为 false，审查判门禁缺失，现补入。
export const BACKGROUND_PATROL_AUDIT_TESTS = ['test-background-patrol-audit.mjs'];

// 后台探索后台回合会话编排 + 贴吧边界适配 + 控制器持久化（task-31 补门禁）：
// · test-background-patrol-session.mjs（16 项，会话描述/prompt/后台回合隔离）
// · test-tieba-patrol-adapter.mjs（19 项，onBeforeTiebaRequest ↔ 5 次日账适配）
// · test-xiaoheihe-operation-store.mjs（16 项，原子写/degraded/reload/锁与单例；含 1 个 Windows skip）
// 全部离线纯模块（注入时钟/fsOps/假对象 + 系统临时目录，单跑含 node 启动均 <0.4 秒）⇒ full 与 quick
// 都覆盖；作为独立分组追加在两个清单末尾，不改变既有条目执行顺序。此前三个文件 inFull/inQuick 均为 false。
export const BACKGROUND_PATROL_SESSION_TESTS = ['test-background-patrol-session.mjs', 'test-background-patrol-owner-model.mjs'];
export const TIEBA_PATROL_ADAPTER_TESTS = ['test-tieba-patrol-adapter.mjs'];
export const XIAOHEIHE_OPERATION_STORE_TESTS = ['test-xiaoheihe-operation-store.mjs'];

// 小黑盒可选接入的三条专项回归：安装器（dry-run/幂等/备份/路径边界）、媒体路径守卫、
// 预设白名单契约。全部离线、只写系统临时目录，合计约数秒，因此 full 与 quick 都覆盖。
// 作为独立分组追加在两个清单末尾，不改变既有条目的执行顺序。
export const XIAOHEIHE_TESTS = [
  'test-setup-xiaoheihe.mjs',
  'test-xiaoheihe-media-guard.mjs',
  'test-xiaoheihe-preset.mjs'
];

// 后台探索第六阶段：小黑盒写入账本（离线原型，未接生产入口）。
// 覆盖多实例独占 / 迟到结果归属 / 持久化失败 degraded / 坏文件 fail-closed / ID 规范化等；
// 全部离线、只写系统临时目录、含一次立即退出的子进程争锁，约 1~2 秒 ⇒ full 与 quick 都覆盖。
// task-13 F4：此前未进 ANY 清单（inQuick/inFull 均为 false），独立审查判门禁缺失，现补入。
export const XIAOHEIHE_WRITE_LEDGER_TESTS = ['test-xiaoheihe-write-ledger.mjs'];

// 上游错误分类 + 5 分钟冷却门控：纯函数直测（含「QQ 文案不得回显原始 JSON」的负向断言）。
// 事故复现相关，full 与 quick 都必须覆盖。
export const AGENT_ERROR_NOTICE_TESTS = ['test-agent-error-notice.mjs', 'test-retry-observer.mjs', 'test-retry-diagnostic.mjs', 'test-retry-observer-integration.mjs', 'test-notice-p1-integration.mjs'];
// 独立额度通知：分类、持久计数、生命周期及真实桥接边界；全部离线。
export const QUOTA_NOTICE_TESTS = ['test-quota-error.mjs', 'test-quota-notice.mjs', 'test-quota-notice-runtime.mjs', 'test-quota-notice-integration.mjs'];

// 后台探索步骤 D 第二批：会话生命周期 / 管理员通知队列 / 调度持久衔接 / 路线 B 授权回执
// （task-43 补门禁）：
// · test-background-patrol-session-lifecycle.mjs（16 项，固定复用/5 天轮换/归档保留/默认关闭零副作用/并发单建）
// · test-background-patrol-notify.mjs（18 项，通知队列原子写/去重/幂等投递/degraded/重启恢复）
// · test-background-patrol-notify-transition.mjs（6 项，task-131：按状态转换 operationId 去重/
//   旧 event+reason 10 分钟语义保留/queue-full 与 persist-failed 的 lastReject 可观察/状态向后兼容）
// · test-background-patrol-notify-mixed-dedupe.mjs（11 项，task-132：旧式/带 ID 记录两侧去重隔离、
//   recent 按 deliveredAt 裁剪、markDelivered 落盘失败的 lastFailure 可观察与保留重试）
// · test-background-patrol-schedule-store.mjs（21 项，调度持久衔接/代次/坏状态 fail-closed/scheduler 差分）
// · test-xiaoheihe-authorize-api.mjs（17 项，12 工具白名单/用户例外/暂停优先/fail-closed/complete 幂等）
// 全部离线纯模块（注入时钟/假对象 + 系统临时目录，单跑含 node 启动均 <0.6 秒）⇒ full 与 quick 都覆盖；
// 作为独立分组追加在两个清单末尾，不改变既有条目执行顺序。
export const BACKGROUND_PATROL_SESSION_LIFECYCLE_TESTS = ['test-background-patrol-session-lifecycle.mjs'];
export const BACKGROUND_PATROL_NOTIFY_TESTS = [
  'test-background-patrol-notify.mjs',
  'test-background-patrol-notify-transition.mjs',
  'test-background-patrol-notify-mixed-dedupe.mjs',
  'test-background-patrol-notify-delivered.mjs',
];
export const BACKGROUND_PATROL_SCHEDULE_STORE_TESTS = ['test-background-patrol-schedule-store.mjs'];
export const XIAOHEIHE_AUTHORIZE_API_TESTS = [
  'test-xiaoheihe-authorize-api.mjs',
  'test-xiaoheihe-pause-events.mjs',
];

// 后台探索步骤 D 第三批：后台回合编排 / 授权 HTTP 路由 / 路线 B 插件骨架（task-46 补门禁）：
// · test-background-patrol-orchestrator.mjs（20 项，注入依赖的后台回合编排，跳过/授权/unknown/单飞）
// · test-xiaoheihe-authorize-route.mjs（16 项，token timing-safe/校验/HTTP 映射/fail-closed/幂等）
// · test-xhh-quota-guard.mjs（25 项，插件 fail-closed：enabled!==true/配置非法仍注册 execute 门并拒写/仅拦 xiaoheihe/allow-deny/超时异常 deny/complete）
// 全部离线纯模块（注入假对象/临时目录，单跑含 node 启动均 <0.6 秒）⇒ full 与 quick 都覆盖；
// 作为独立分组追加在两个清单末尾，不改变既有条目执行顺序。
export const BACKGROUND_PATROL_ORCHESTRATOR_TESTS = ['test-background-patrol-orchestrator.mjs'];
export const XIAOHEIHE_AUTHORIZE_ROUTE_TESTS = ['test-xiaoheihe-authorize-route.mjs'];
export const XIAOHEIHE_AUTHORIZE_GUARD_PLUGIN_TESTS = ['test-xhh-quota-guard.mjs'];

// 后台探索步骤 D 第四批：组合回归 + 授权审计适配器（task-51 补门禁）：
// · test-background-patrol-composition.mjs（8 项，已有纯模块的组合回归）
// · test-xiaoheihe-authorize-audit-adapter.mjs（6 项，authorize 结果→结构化审计适配）
// 离线纯模块（注入假对象，单跑含 node 启动均 <0.6 秒）⇒ full 与 quick 都覆盖；
// 作为独立分组追加在两个清单末尾，不改变既有条目执行顺序。
export const BACKGROUND_PATROL_COMPOSITION_TESTS = ['test-background-patrol-composition.mjs'];
export const XIAOHEIHE_AUTHORIZE_AUDIT_ADAPTER_TESTS = ['test-xiaoheihe-authorize-audit-adapter.mjs'];

// 后台探索步骤 D 第五批：接线层（task-55 补门禁）：
// · test-xiaoheihe-authorize-wiring.mjs（10 项，authorize-api+route+audit-adapter 端到端接线，假 token）
// · test-background-patrol-bridge-hook.mjs（10 项，bridge 侧 tools/pre-execute 钩子纯逻辑，临时目录）
// · test-background-patrol-session-identity.mjs（8 项，DSH sessionId→patrol/owner/group/unknown 分类）
// 全部离线纯模块（注入假对象/临时目录，单跑含 node 启动均 <0.5 秒）⇒ full 与 quick 都覆盖；
// 作为独立分组追加在两个清单末尾，不改变既有条目执行顺序。
export const XIAOHEIHE_AUTHORIZE_WIRING_TESTS = ['test-xiaoheihe-authorize-wiring.mjs'];
export const BACKGROUND_PATROL_BRIDGE_HOOK_TESTS = ['test-background-patrol-bridge-hook.mjs', 'test-background-patrol-reconcile.mjs', 'test-background-patrol-reconcile-faults.mjs', 'test-background-patrol-write-gate.mjs', 'test-owner-patrol-real-dispatch.mjs'];
export const BACKGROUND_PATROL_SESSION_IDENTITY_TESTS = ['test-background-patrol-session-identity.mjs'];

// 安装辅助脚本：授权 token 生成（task-62 补门禁）：
// · test-generate-authorize-token.mjs（15 项；子进程 CLI + 临时目录/JSON，单跑约 1 秒）
// 离线无外部依赖（不写真实 config/profile/state），full 与 quick 都覆盖；
// 作为独立分组追加在两个清单末尾，不改变既有条目执行顺序。
export const AUTHORIZE_TOKEN_SCRIPT_TESTS = ['test-generate-authorize-token.mjs'];

// 小黑盒守卫（xhh-quota-guard）HTTP 兼容 + 组合回归（task-67 补门禁）：
// · test-xhh-guard-http-compatibility.mjs（5 项，route 响应/插件映射/HTTP 客户端兼容与 fail-closed）
// · test-xhh-guard-composition.mjs（3 项，authorize-api + route + 插件决策的组合链路）
// 全部离线纯模块（假 fetch/假 client，单跑含 node 启动 <0.3 秒）⇒ full 与 quick 都覆盖；
// 作为独立分组追加在两个清单末尾，不改变既有条目执行顺序。
export const XHH_GUARD_COMPATIBILITY_TESTS = [
  'test-xhh-guard-http-compatibility.mjs',
  'test-xhh-guard-composition.mjs'
];

// 只读门禁（2026-10-26 新增）：readOnly 模式下 owner/group/background 的一切平台写工具 deny，
// 读取/搜索/QQ 汇报不受影响；默认缺省/false 行为完全不变。离线纯模块 + 真实 loopback 端点，
// 不写正式 config/profile/state、不访问平台/QQ，单跑含 node 启动约 0.2 秒。
// full 与 quick 都覆盖；作为独立分组追加在两个清单末尾，不改变既有条目执行顺序。
export const READ_ONLY_GATE_TESTS = ['test-read-only-gate.mjs'];

// 贴吧写入口边界（task-104 取证 + 防回归）：贴吧侧「不需要门禁」的前提是它根本没有写入口，
// 但 test-read-only-gate.mjs 只检查「小黑盒写工具名单不含 tieba」，对贴吧侧实际实现一无所知。
// · test-tieba-write-boundary.mjs（5 项：静态 MCP 注册 / 真实 stdio tools/list /
//   bridge 路由守卫（仅 GET 两条）/ tieba-lib 导出（无写函数、无写方法、GET-only safeFetch）/
//   反 vacuous 自检——把写入口喂进检查函数必须抛错）
// 全程离线：只读源码 + 只 import 纯模块 + stdio 拉起本仓库 MCP server，不启动 bridge、
// 不写 config/profile/state、不访问平台/QQ。单跑含 node 启动约 0.9 秒 ⇒ full 与 quick 都覆盖；
// 作为独立分组追加在两个清单末尾，不改变既有条目执行顺序。
export const TIEBA_WRITE_BOUNDARY_TESTS = ['test-tieba-write-boundary.mjs'];

// 插件失效 fail-closed（task-108）：xhh-quota-guard 被加载但 enabled 非 true / 配置非法 /
// client 构造失败 / 初始化异常时，apply 仍注册 tools/execute（不抛错，避免 loader 卸载钩子），
// 在 dispatch 前拒绝**所有**小黑盒工具（含 5 个只读；无法授权时读取额度/accessPaused
// 也无法确认，不能放行）；非小黑盒直通，合法 enabled 时行为不变。
// · test-xhh-guard-failclosed.mjs（18 项：fake ctx/client 的 fail-closed 全路径）
// · test-xhh-guard-fallback-behavior.mjs（5 项：加载冻结的旧实现快照，先证明旧实现 next()
//   错误放行只读，再验证当前实现只读/写 next=0；红/绿命令见 failclosed 文档 §3）
// 全部离线（fake ctx/client，零真实网络/DSH/平台），单跑含 node 启动 <0.3 秒 ⇒ full 与 quick 都覆盖；
// 作为独立分组追加在两个清单末尾，不改变既有条目执行顺序。
export const XHH_GUARD_FAILCLOSED_TESTS = [
  'test-xhh-guard-failclosed.mjs',
  'test-xhh-guard-fallback-behavior.mjs'
];

// 贴吧自主访问上限可配置（task-15，2026-10-27）：日上限从固定 6 改为可配置 0..99（默认 6）。
// · test-tieba-patrol-configurable-cap.mjs（18 项，临时目录 + 注入时钟/fsOps）：
//   默认 6 / 0..99 边界 / 单次 reserve limit 覆盖 / 调上限保留当天 used 且文件字节不变 /
//   旧状态 used=5/6/50/99 可读不重置 / used=100 fail-closed 不覆盖原字节 / limit 不持久化 /
//   adapter 固定 limit 与动态 limitOf（每次求值）、非法 limit fail-closed 且不调用 ledger、reason=user 旁路。
// 全程离线（不写真实 state/config、不访问平台/QQ），单跑含 node 启动约 0.3 秒 ⇒ full 与 quick 都覆盖；
// 作为独立分组追加在两个清单末尾，不改变既有条目执行顺序。
export const TIEBA_PATROL_CONFIGURABLE_CAP_TESTS = ['test-tieba-patrol-configurable-cap.mjs'];

// task-46（2026-10-28）：巡逻汇报「内容由模型决定 + 敏感分级」纯模块单测（22 项）。
// 离线纯函数：汇报块提取/末块优先/属性 fail-closed、分级（路径/凭据/URL/邮箱/QQ 号/软关键词/已知令牌）、
// 目的地（非敏感+群选+白名单才发群，其余 owner）、模型内容/模板回退、异常输入不抛错。
export const PATROL_REPORT_CONTENT_TESTS = ['test-background-patrol-report-content.mjs'];

// task-58（2026-10-28）：身份模式 fail-closed（legacy 显式告警/可配置拒绝）+ sessions 键名校验。
// · test-session-identity-mode.mjs（6 项）：非法 sessions 键剔除+warn+计数且合法键保留、白名单常量、
//   legacy 启动 warn identity-mode-legacy 且 status().identityMode=legacy、mapper 无告警、
//   requireMapperIdentity=true 时 legacy fail-closed（identity-mode-legacy）且非布尔值拒绝、
//   legacy 模式 provenance 缺失时 patrol 写现状（allow）显式锁定。
// 全部离线（临时目录 + 127.0.0.1 临时端口），单跑含 node 启动约 0.3 秒 ⇒ full 与 quick 都覆盖；
// 作为独立分组追加在两个清单末尾，不改变既有条目执行顺序。
export const SESSION_IDENTITY_MODE_TESTS = ['test-session-identity-mode.mjs'];

// task-62（2026-10-28）：配置契约测试 —— 防「bridge/hook 消费但 CONFIG_KEYS 不认」的第四次同类事故
// （readOnly / report / requireMapperIdentity 连续三次导致 unknown-config-field → 生命周期 disabled）。
// 静态扫描 bridge.js + hook 消费的 backgroundPatrol.* 键，与 BACKGROUND_PATROL_CONFIG_KEYS 交叉校验；
// 删白名单键即变红（变异证明见 docs/superpowers/plans/2026-10-28-task62-config-contract.md）。
export const BACKGROUND_PATROL_CONFIG_CONTRACT_TESTS = ['test-background-patrol-config-contract.mjs'];

// task-63（2026-10-28）：小黑盒身份异常降级状态机（纯模块）—— 用户安全规则：
// 身份异常→临时只读+通知管理员；通知失败/未知→全停（含读取/搜索）且只能控制台手动恢复；
// stale operationId 不得改状态；并发去重；持久化失败 degrade；损坏状态 fail-closed。
// 全部离线（临时目录 + 注入 clock），单跑约 0.3 秒 ⇒ full 与 quick 都覆盖。
export const XIAOHEIHE_IDENTITY_GUARD_TESTS = ['test-xiaoheihe-identity-guard.mjs'];

// task-64（2026-10-28）：身份守卫「接线」—— 把 task-63 的纯状态机接到真实链路：
// guard 门禁消费（all-paused/degraded 读写全拒、writes-paused 只拒写）、身份异常 → owner 通知 →
// 回执写入 guard（failed/unknown 升级 all-paused）、补报防死锁、身份恢复解除、restart 保持、
// 手动恢复三条件（身份/QQ 回执/补报回执，服务端现算）以及 bridge 侧回执接口 + 恢复端点 +
// /api/status.identityGuard 快照的静态接线。全部离线（临时目录 + loopback 端口 + 真实 guard）。
export const XIAOHEIHE_IDENTITY_GUARD_WIRING_TESTS = ['test-xiaoheihe-identity-guard-wiring.mjs'];

// task-77（2026-10-29，GPT 复核 #2）：「QQ 通信已恢复」必须现算**当前**连接事实。
// 旧口径只看「最近 10 分钟内有过一次成功回执」——链路此刻已断也返回 true，等于把
// 「曾经通过」当成「现在通」，与用户规则 m13214 §4 冲突。本组钉住收敛后的判定
// （WS 连接 / 上游自评 good / 账号在线 / 事件包流动 / 静默）与 bridge 的接线方式。
// 全部离线（纯函数 + 源码断言），单跑约 0.1 秒 ⇒ full 与 quick 都覆盖。
export const OWNER_COMMS_HEALTH_TESTS = ['test-owner-comms-health.mjs'];

// task-65（2026-10-28）：后台巡逻可观测性 —— task-53 的「recordPlan 失败 → scheduler.stop()」
// 只有日志能看见，运维不知道巡逻停了；本组锁死 phase/startError 视图（not-started 必须带非 null
// 原因）、停摆 owner 私聊通知 + 同因 10 分钟去重、以及 /api/status 的 patrol 字段与接缝同源。
// 全部离线（temp state + fake E1），单跑约 0.9 秒 ⇒ full 与 quick 都覆盖。
export const BACKGROUND_PATROL_OBSERVABILITY_TESTS = ['test-background-patrol-observability.mjs'];

// m33778 方案 2（2026-10-30）：后台巡逻**受限令牌**（作用域 tieba-read，纯模块）。
// 背景：2026-10-29 贴吧巡逻连续三次 `未授权：智能体调用必须携带有效的会话令牌` —— 旧实现取
// `getSocialV2State('patrol:background')` 必抛（canonicalV2Key 只认 group:/private:），catch 吞成
// 空串 ⇒ 那一行是空操作。方案 2 给后台巡逻一张**独立、只读、可轮换**的令牌，而不是复用 QQ 会话令牌。
// 本组钉住：路径/方法白名单是唯一判定点、轮换后旧令牌立即失效、吊销 fail-closed、损坏状态不覆盖。
// 全部离线（临时目录 + 注入 clock/makeToken），单跑约 0.2 秒 ⇒ full 与 quick 都覆盖。
export const BACKGROUND_PATROL_AGENT_TOKEN_TESTS = ['test-background-patrol-agent-token.mjs'];
// m33778 方案 2 的**接线**（真实 bridge + 真实 HTTP）：无令牌 403、受限令牌只能读贴吧 bar/thread、
// 发 QQ / 调 /api/status / 调小黑盒授权一律 403、key 非 patrol:background 403、轮换/吊销/损坏时 403、
// 巡逻 prompt 注入真实令牌（不可用时明说不要调用）。只进 full 不进 quick：要起临时 console server。
export const BACKGROUND_PATROL_AGENT_TOKEN_HTTP_TESTS = ['test-background-patrol-agent-token-http.mjs'];

// task-86（2026-10-30）：小黑盒专栏独立密码 —— 认证核心模块（纯模块，task-87 的依赖）。
// 存储 state/xiaoheihe-console-column-auth.json（0600、临时文件+rename 原子写、只存 scrypt 哈希+盐）、
// 失败锁定 5/10/15 次 → 60s/300s/900s 且写文件（重启不清零）、锁定期内正确密码也拒、
// 进程内会话（空闲 15min / 绝对 2h）、untrusted（损坏/算法未知/长度非法）绝不当无密码、
// 落盘失败一律 persist-failed 且不得报成功、agentPaused !== true 不触碰磁盘、
// 密码/哈希/盐/token 不进返回值。getAuthStatus 额外给 passwordSetAt/lockedUntil 毫秒时间戳。
// 全部离线（临时 stateDir + 注入 now），单跑约 3.5 秒 ⇒ 只进 full（quick 保持秒级）。
export const CONSOLE_COLUMN_AUTH_TESTS = ['test-console-column-auth.mjs'];
// task-87：bridge 5 个专栏认证端点 + 三个恢复端点门禁切换（行为级，起临时 bridge 实例）。
// 只进 full 不进 quick：每次要起临时 console server（秒级但比纯单元重）。
export const CONSOLE_COLUMN_GATE_TESTS = ['test-console-column-gate.mjs'];
// task-88：小黑盒专栏入口 UI 的静态契约（导航/三态文案/密码框类型/不落 storage/脚本可解析）。
export const CONSOLE_COLUMN_UI_TESTS = ['test-console-column-ui.mjs'];
// A-2：小黑盒降级载体（身份守卫不可用/来源不明时的只读与全停载体）。
// 纯状态模块，临时目录 + 注入 clock，全部离线；只进 full 不进 quick。
export const XIAOHEIHE_DEGRADE_TESTS = ['test-xiaoheihe-degrade.mjs'];
export const XHHMCP_WATCHDOG_TESTS = ['test-xhhmcp-watchdog.mjs'];
// 阶段2A：小黑盒工具面「服务端探针 + 纯判定」（离线：假 HTTP 服务覆盖 ok/500/非 JSON-RPC/超时/非法 tools；
// 判定覆盖 present/absent/uncertain、3 次才提示、不确定断计数、6h 节流、仅 delivered 推进 lastAlertAt）。
export const XHH_TOOL_SURFACE_TESTS = ['test-xhh-tool-surface-decision.mjs', 'test-xhhmcp-tool-surface-probe.mjs'];
// 阶段2B：Cordis 插件 xhh-tool-watcher（测试与插件同目录，scripts/ 侧只有转发 shim）。
// 假 ctx/假 scheduler，无网络、无真实定时器；只进 full 不进 quick。
export const XHH_TOOL_SURFACE_WATCHER_TESTS = ['test-xhh-tool-surface-watcher.mjs'];

// 阶段 2C：owner 通知发件箱（纯模块，离线）
export const OWNER_NOTICE_OUTBOX_TESTS = ['test-owner-notice-outbox.mjs'];
export const OWNER_NOTICE_BRIDGE_WIRING_TESTS = ['test-owner-notice-bridge-wiring.mjs'];
// 阶段 2C 离线全链（插件生产者 → 收件箱 → 发件箱 → 回执 → 插件记账），全部用真实模块 + 假时钟/临时目录。
export const OWNER_NOTICE_CHAIN_TESTS = ['test-owner-notice-chain.mjs'];
// 阶段 2C 离线端到端：插件 apply() 真实装配 → 收件箱 → 发件箱 → 假 QQ → 回执 → 记账（含跨进程文件原子性）。
export const OWNER_NOTICE_E2E_TESTS = ['test-owner-notice-e2e-offline.mjs'];
// 阶段 2C 桥接侧最小接线：验证 owner 通知在主启动路径装配（与巡逻解耦）。
export const OWNER_NOTICE_BRIDGE_STARTUP_TESTS = ['test-owner-notice-bridge-startup.mjs'];
export const OWNER_NOTICE_BRIDGE_RECEIPT_TESTS = ['test-owner-notice-bridge-receipt.mjs'];
export const OWNER_NOTICE_BRIDGE_HANG_TIMEOUT_TESTS = ['test-owner-notice-bridge-hang-timeout.mjs'];
export const DSH_ASAR_TESTS = ['test-dsh-asar.mjs'];
export const CONSOLE_SETTINGS_TESTS = ['test-xiaoheihe-console-settings.mjs'];
// A-2：三条降级 HTTP 路由的真实往返（GET status / POST recover / POST resend-notify）。
// 起真实 bridge + 真实 console server（harness），推专栏会话走真实 /auth/setup 流程，
// 降级层与授权 hook 用内存假实现。只进 full 不进 quick：要起临时 console server。
export const XIAOHEIHE_DEGRADE_HTTP_TESTS = ['test-xiaoheihe-degrade-http.mjs'];
/**
 * 小黑盒控制台专栏的配置读写 HTTP 回归（GET /settings、POST /settings/apply、GET /audit）。
 * 与 CONSOLE_SETTINGS_TESTS 互补：那个测纯模块，这个测真实 server 上的门禁与顺序契约。
 */
export const CONSOLE_SETTINGS_HTTP_TESTS = ['test-xiaoheihe-console-settings-http.mjs'];

export const FULL_TESTS = [...ORIGINAL_FULL_TESTS, ...TEST_FOUNDATION_TESTS, ...WAKE_TIMER_TESTS, ...WATCHDOG_POLICY_TESTS, ...WATCHDOG_SUPPORT_TESTS, ...WAKE_POLICY_TESTS, ...WAKE_TRIGGER_TESTS, ...SESSION_ROUTER_TESTS, ...REPLY_TIMING_BASELINE_TESTS, ...REPLY_TIMING_POLICY_TESTS, ...PURE_SEAM_TESTS, ...MODEL_ENDPOINT_TESTS, ...POLICY_WAVE_TESTS, ...NODE3_TESTS, ...DSH_021_TESTS, ...DSH_CLI_TESTS, ...AGENT_ERROR_NOTICE_TESTS, ...QUOTA_NOTICE_TESTS, ...DSH_CONNECTION_TESTS, ...GROUP_WAIT_BATCH_TESTS, ...XIAOHEIHE_TESTS, ...XIAOHEIHE_WRITE_LEDGER_TESTS, ...BACKGROUND_PATROL_TESTS, ...BACKGROUND_PATROL_STATE_TESTS, ...BACKGROUND_PATROL_OUTPUT_TESTS, ...BACKGROUND_PATROL_REPORT_TESTS, ...BACKGROUND_PATROL_CONTRACT_TESTS, ...BACKGROUND_PATROL_AUDIT_TESTS, ...BACKGROUND_PATROL_SESSION_TESTS, ...TIEBA_PATROL_ADAPTER_TESTS, ...XIAOHEIHE_OPERATION_STORE_TESTS, ...BACKGROUND_PATROL_SESSION_LIFECYCLE_TESTS, ...BACKGROUND_PATROL_NOTIFY_TESTS, ...BACKGROUND_PATROL_SCHEDULE_STORE_TESTS, ...XIAOHEIHE_AUTHORIZE_API_TESTS, ...BACKGROUND_PATROL_ORCHESTRATOR_TESTS, ...XIAOHEIHE_AUTHORIZE_ROUTE_TESTS, ...XIAOHEIHE_AUTHORIZE_GUARD_PLUGIN_TESTS, ...BACKGROUND_PATROL_COMPOSITION_TESTS, ...XIAOHEIHE_AUTHORIZE_AUDIT_ADAPTER_TESTS, ...XIAOHEIHE_AUTHORIZE_WIRING_TESTS, ...BACKGROUND_PATROL_BRIDGE_HOOK_TESTS, ...BACKGROUND_PATROL_SESSION_IDENTITY_TESTS, ...AUTHORIZE_TOKEN_SCRIPT_TESTS, ...XHH_GUARD_COMPATIBILITY_TESTS, ...READ_ONLY_GATE_TESTS, ...TIEBA_WRITE_BOUNDARY_TESTS, ...XHH_GUARD_FAILCLOSED_TESTS, ...TIEBA_PATROL_CONFIGURABLE_CAP_TESTS, ...PATROL_REPORT_CONTENT_TESTS, ...SESSION_IDENTITY_MODE_TESTS, ...BACKGROUND_PATROL_CONFIG_CONTRACT_TESTS, ...XIAOHEIHE_IDENTITY_GUARD_TESTS, ...BACKGROUND_PATROL_OBSERVABILITY_TESTS, ...BACKGROUND_PATROL_AGENT_TOKEN_TESTS, ...BACKGROUND_PATROL_AGENT_TOKEN_HTTP_TESTS, ...XIAOHEIHE_IDENTITY_GUARD_WIRING_TESTS, ...OWNER_COMMS_HEALTH_TESTS, ...CONSOLE_COLUMN_AUTH_TESTS, ...CONSOLE_COLUMN_GATE_TESTS, ...CONSOLE_COLUMN_UI_TESTS, ...XIAOHEIHE_DEGRADE_TESTS, ...XIAOHEIHE_DEGRADE_HTTP_TESTS, ...XHHMCP_WATCHDOG_TESTS, ...CONSOLE_SETTINGS_TESTS, ...CONSOLE_SETTINGS_HTTP_TESTS, ...XHH_TOOL_SURFACE_TESTS, ...XHH_TOOL_SURFACE_WATCHER_TESTS, ...OWNER_NOTICE_OUTBOX_TESTS, ...OWNER_NOTICE_BRIDGE_WIRING_TESTS, ...OWNER_NOTICE_CHAIN_TESTS, ...OWNER_NOTICE_E2E_TESTS, ...OWNER_NOTICE_BRIDGE_STARTUP_TESTS, ...OWNER_NOTICE_BRIDGE_RECEIPT_TESTS, ...OWNER_NOTICE_BRIDGE_HANG_TIMEOUT_TESTS, ...DSH_ASAR_TESTS];
export const QUICK_TESTS = [...CORE_TESTS, ...TEST_FOUNDATION_TESTS, ...WAKE_TIMER_TESTS, ...WATCHDOG_POLICY_TESTS, ...WATCHDOG_SUPPORT_TESTS, ...WAKE_POLICY_TESTS, ...WAKE_TRIGGER_TESTS, ...REPLY_TIMING_BASELINE_TESTS, ...REPLY_TIMING_POLICY_TESTS, ...PURE_SEAM_TESTS, ...POLICY_WAVE_TESTS, ...NODE3_TESTS, ...DSH_021_TESTS, ...DSH_CLI_TESTS, ...AGENT_ERROR_NOTICE_TESTS, ...QUOTA_NOTICE_TESTS, ...DSH_CONNECTION_TESTS, ...GROUP_WAIT_BATCH_TESTS, ...XIAOHEIHE_TESTS, ...XIAOHEIHE_WRITE_LEDGER_TESTS, ...BACKGROUND_PATROL_TESTS, ...BACKGROUND_PATROL_STATE_TESTS, ...BACKGROUND_PATROL_OUTPUT_TESTS, ...BACKGROUND_PATROL_REPORT_TESTS, ...BACKGROUND_PATROL_CONTRACT_TESTS, ...BACKGROUND_PATROL_AUDIT_TESTS, ...BACKGROUND_PATROL_SESSION_TESTS, ...TIEBA_PATROL_ADAPTER_TESTS, ...XIAOHEIHE_OPERATION_STORE_TESTS, ...BACKGROUND_PATROL_SESSION_LIFECYCLE_TESTS, ...BACKGROUND_PATROL_NOTIFY_TESTS, ...BACKGROUND_PATROL_SCHEDULE_STORE_TESTS, ...XIAOHEIHE_AUTHORIZE_API_TESTS, ...BACKGROUND_PATROL_ORCHESTRATOR_TESTS, ...XIAOHEIHE_AUTHORIZE_ROUTE_TESTS, ...XIAOHEIHE_AUTHORIZE_GUARD_PLUGIN_TESTS, ...BACKGROUND_PATROL_COMPOSITION_TESTS, ...XIAOHEIHE_AUTHORIZE_AUDIT_ADAPTER_TESTS, ...XIAOHEIHE_AUTHORIZE_WIRING_TESTS, ...BACKGROUND_PATROL_BRIDGE_HOOK_TESTS, ...BACKGROUND_PATROL_SESSION_IDENTITY_TESTS, ...AUTHORIZE_TOKEN_SCRIPT_TESTS, ...XHH_GUARD_COMPATIBILITY_TESTS, ...READ_ONLY_GATE_TESTS, ...TIEBA_WRITE_BOUNDARY_TESTS, ...XHH_GUARD_FAILCLOSED_TESTS, ...TIEBA_PATROL_CONFIGURABLE_CAP_TESTS, ...PATROL_REPORT_CONTENT_TESTS, ...SESSION_IDENTITY_MODE_TESTS, ...BACKGROUND_PATROL_CONFIG_CONTRACT_TESTS, ...XIAOHEIHE_IDENTITY_GUARD_TESTS, ...BACKGROUND_PATROL_OBSERVABILITY_TESTS, ...BACKGROUND_PATROL_AGENT_TOKEN_TESTS, ...XIAOHEIHE_IDENTITY_GUARD_WIRING_TESTS, ...OWNER_COMMS_HEALTH_TESTS, ...XHHMCP_WATCHDOG_TESTS, ...CONSOLE_SETTINGS_TESTS, ...CONSOLE_SETTINGS_HTTP_TESTS];

// 小黑盒帖子图片解析与受限下载；均为离线假数据，不访问平台。
export const XHH_POST_IMAGE_TESTS = ['test-xhh-post-image-urls.mjs', 'test-xhh-image-content.mjs'];
// 真实宿主全链：execute → normalizeDispatchResult → post-execute → finalize（旧落点 RED、新落点 GREEN）
export const XHH_POST_IMAGE_HOST_PIPELINE_TESTS = ['test-xhh-post-images-host-pipeline.mjs'];
FULL_TESTS.push(...XHH_POST_IMAGE_TESTS);
QUICK_TESTS.push(...XHH_POST_IMAGE_TESTS);
// 真实宿主夹具要读 asar（首次抽取较慢），只进 FULL
FULL_TESTS.push(...XHH_POST_IMAGE_HOST_PIPELINE_TESTS);

// 安装前离线预检（只读、不写安装目录、不碰进程）。
export const XHH_PLUGIN_PREFLIGHT_TESTS = ['test-xhh-plugin-preflight.mjs'];
FULL_TESTS.push(...XHH_PLUGIN_PREFLIGHT_TESTS);

// Fish Diary 存储模块（纯模块；P1b-2 起已由 src/bridge.js 接线）。只进 FULL。
export const DIARY_STORE_TESTS = ['test-diary-store.mjs'];
FULL_TESTS.push(...DIARY_STORE_TESTS);

// Fish Diary 4 个 agent 端点（read/write/edit/delete）的契约测试：真实桥接 + 真实 HTTP，
// 日记文件全落临时目录（真实 `Fish Diary/` 保持 0 字节）。要起 console server，故只进 FULL。
export const DIARY_ENDPOINT_TESTS = ['test-diary-endpoints.mjs'];
FULL_TESTS.push(...DIARY_ENDPOINT_TESTS);

// Fish Diary 控制台（P2 方案 C）7 个端点：鉴权失败、成功路径、恢复算一次写入、
// 审计无正文、config 热生效。真实桥接 + 真实 HTTP，state/ 与 `Fish Diary/` 全落临时目录。只进 FULL。
export const DIARY_CONSOLE_TESTS = ['test-diary-console.mjs'];
FULL_TESTS.push(...DIARY_CONSOLE_TESTS);

// 后台巡逻审计的**读取方**契约（表驱动/常量驱动）：真实写入 → readDay → GET /audit 路由 → console.html
// 5 列表格。要起真实 console server + 真实专栏会话 Cookie，故只进 FULL。
// 保护范围仅限「当前已知消费端」（readDay 在 src/ 下目前零调用方），不承诺保护未来新增消费端。
export const BACKGROUND_PATROL_AUDIT_READER_TESTS = ['test-background-patrol-audit-readers.mjs'];
FULL_TESTS.push(...BACKGROUND_PATROL_AUDIT_READER_TESTS);

// 鱼塘盯梢策略（src/core/fish-watch-policy.mjs）的纯函数回归：参数解析、默认目标会话、
// 事件派生（该不该叫醒模型）、状态地址。零网络零 state/，所以 quick 也进 —— 它是
// 「叫早了白花钱、叫漏了直接漏轮」这条链上唯一能离线锁死的部分。
export const FISH_WATCH_POLICY_TESTS = ['test-fish-watch-policy.mjs'];
FULL_TESTS.push(...FISH_WATCH_POLICY_TESTS);
QUICK_TESTS.push(...FISH_WATCH_POLICY_TESTS);

// 鱼塘盯梢 CLI（scripts/fish-watch.mjs）的行为级回归：假 fetch + 虚拟时钟驱动真实主循环。
// 锁「只在该叫的时候叫 / 投递失败不写去重键 / 失败重试同一条 / 404 立即收工 / 时钟冻结
// 也不会无限轮询」。全离线（不读 config.json、不起 server），因此 quick 也进。
export const FISH_WATCH_CLI_TESTS = ['test-fish-watch-cli.mjs'];
FULL_TESTS.push(...FISH_WATCH_CLI_TESTS);
QUICK_TESTS.push(...FISH_WATCH_CLI_TESTS);

// QQ 空间（qzone-safe）：审计投影与自主机会的离线回归。
//
// WHY THESE WERE MISSING: test:qzone (scripts/qzone-test-runner.mjs) discovers
// /^test-qzone-.*[.]mjs$/ by glob, which is how the 189-suite qzone gate runs. That gate is a
// separate entry point, so these never needed a manifest entry — and the manifest has never
// named a single qzone suite. They are listed now because they cover paths that outlive the
// qzone badge: the maintenance tick export writer, its retention deleter, the audit-jsonl id
// grammar, and the opportunity loop. A regression in any of those is not "a qzone test failed",
// it is the bridge deleting or mis-exporting audit evidence.
//
// OFFLINE ONLY: temp dir / temp SQLite, fake transport or none. None reads config.json, opens
// state/, touches QQ, or starts a server.
export const QZONE_AUDIT_TESTS = [
  'test-qzone-audit-jsonl-offline.mjs',
  'test-qzone-audit-export-tick.mjs',
  'test-qzone-audit-retention-tick.mjs',
];
FULL_TESTS.push(...QZONE_AUDIT_TESTS);
export const QZONE_OPPORTUNITY_TESTS = [
  'test-qzone-opportunity-startup.mjs',
  'test-qzone-opportunity-wiring.mjs',
];
FULL_TESTS.push(...QZONE_OPPORTUNITY_TESTS);
export const QZONE_NOTICE_TESTS = ['test-qzone-owner-notice.mjs'];
FULL_TESTS.push(...QZONE_NOTICE_TESTS);

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
