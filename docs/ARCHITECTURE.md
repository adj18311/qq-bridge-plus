# 桥接代码的模块边界

本次整理只改变代码归属，不改变 QQ 模式、工具权限、API、文件格式或发送策略。`src/bridge.js` 仍是进程入口和运行状态的唯一组装点。不要通过导入它取得工具函数：导入入口会启动服务。

## 找代码

| 职责 | 位置 | 输入与边界 |
|---|---|---|
| 进程组装、QQ/DSH 事件、会话生命周期、控制台鉴权 | `src/bridge.js` | 持有当前配置与活动会话；只有入口负责启动定时器和网络服务 |
| JSON/文本安全读写、格式保留、备份命名 | `src/core/json-store.mjs` | 调用者提供路径；不推测生产目录、不在导入时访问磁盘 |
| QQ 消息清理、URL/字符边界、中文空格分条 | `src/core/qq-text.mjs` | 纯文本与发送配置输入，输出分条计划；不发送消息、不计费、不检查白名单 |
| 模型目录投影、档位验证、覆盖表合并 | `src/core/model-policy.mjs` | 纯目录/补丁数据；不请求 DSH、不写配置、不递增切换代号 |
| 控制台模型热更新的输入校验 | `src/core/console-input.mjs` | 纯 `parseModelUpdateInput(body) -> { nextProvider, nextModel, nextEffort, patch, removals }`；只校验并归一 provider/model/reasoningEffort 与 `private:`/`group:` 覆盖补丁，依赖 `model-policy` 的常量与 `httpFail`。目录读取、鉴权、读盘/备份/写盘、内存同步与 epoch 仍在入口 |
| 二代人格提示的 CJK 空格规则 | `src/core/persona-text.mjs` | `cjkLikeChar(ch)`、`convertExampleSpaces(line)`、`cjkSpaceWarning(messages)`、`splitBoundaryWarning(messages)`；只处理字符串/消息数组，不读角色文件、不决定是否发送。入口保留 `isCjkLikeChar` / `convertExampleSpacesToComma` / `findCjkSpaceWarning` / `findSplitBoundaryWarning` 原名薄封装 |
| 图片字节/URL 的 MIME、尺寸与 base64 | `src/core/image-format.mjs` | `detectImageMime(buf)`、`imageMimeFromUrl(url, fallback)`、`imageDimensions(buf)`、`parseImageBase64(value)`；不下载、不读本地文件、不检查体积/像素上限或 SSRF。入口保留 `mimeFromBuffer` / `mimeFromUrl` / `getImageDimensions` / `base64FromMaybe` 原名薄封装，抓取与上限仍在入口 |
| 人格卡文件仓库、名称与内容校验、摘要和提示 | `src/core/role-store.mjs` | `createRoleStore({ rolesDir, getInjectLimit })`；目录和动态限制由入口明确提供 |
| 运行配置默认值、字段合并与归一化 | `src/core/runtime-config.mjs` | 纯函数 `parseRuntimeConfig(file) -> { config, diagnostics }`，另导出 owner/名单归一与人格上限校正；不读文件、不发现凭据、不写日志 |
| 会话映射持久化与只读降级 | `src/core/session-store.mjs` | `createSessionStore({ file, log })`；显式文件路径与窄日志；活动映射、队列、退役仍由入口持有 |
| 唤醒定时器与租约句柄生命周期 | `src/core/wake-timers.mjs` | `createWakeTimers({ clock, leaseTimers })`；管理四类会话定时器和既有租约 Map，支持取消/替换及旧回调失效；不持有业务 busy、优先级、队列或授权 |
| 看门狗纯判定与支撑规则 | `src/core/watchdog-policy.mjs` | `watchdogTiming({ at, busySince, lastFrameAt })`、`classifyWatchdog({ busyMs, idleMs, thresholds })`、`normalizeBusyWatchdogConfig(raw, defaults)` 与 `canRearmBusyWatchdog(times, wd, at)`；只做时长/档位/归一化/速率判定，不读全局配置、不读写状态、不执行释放。原始 selector、权威默认值与 rearmV2 Map 的读取/记录/裁剪仍在入口 |
| 唤醒配置/安全/优先级纯策略 | `src/core/wake-policy.mjs` | `normalizeSpeakerIds(value)`、`defaultWakeConfig(w, { now, random })`、`hasExplicitEnd(st)`、`isSleepingConfig(wc)`、`preSleepWaitBlocked(st, w, { now })`、`computeWakeSafety(wc, { now })`、`wakePriority(reason, priorities)`、`isDirectedAtAi(textContent)`、`evaluateWakeTrigger(st, event, kind, textContent, plainContent, quoteTargetIsSelf, { getNickname, random })`；配置由入口热读传入，时钟/昵称/随机以延迟函数注入，不在导入时采样；优先表仍由入口持有并传入；不读全局配置、不读写状态。默认配置刷新、防永眠恢复、定时器与调度仍在入口 |
| 人格卡分代解析与选择 | `src/role-card.js` | 无文件访问；供人格仓库和消息注入共用 |
| 回复节奏建议与剩余静默 | `src/core/reply-timing.mjs` | `suggestQuietMs(st, capabilities)`、`replyTiming(st, capabilities)`；capabilities 为 `{ getWaitConfig, now, looksLikeUnfinished }`，延迟读取配置/时钟/纯文本判定，导入时不采样或缓存；保留 `Number(x) \|\| fallback`、`Infinity`、严格 `<15000`、逐条时钟读取与 `lastIncomingAt` 顺序。`looksLikeUnfinished` 仍在 `src/v2-wait.js`，入口只留两个薄封装 |
| 分条发送间隔计算 | `src/core/send-gaps.mjs` | `clampMessageGap(ms, sendCfg)`、`computeMessageGaps(messages, gapMode, gapMs, gaps, sendCfg, capabilities)`；capabilities 为 `{ random, randInt }`，只在需要处调用，导入/构造能力时不抽样、不缓存配置；返回延迟数组，不排队、不发送、不建定时器。入口保留 `clampGapV2` / `computeGapsV2` 原名薄封装，`randInt` 闭包仍由入口持有并延迟传入 |
| 工具调用日志参数的 JSON 脱敏 | `src/core/tool-log-format.mjs` | `redactToolLogValue(obj, capabilities)`、`formatToolLogArgs(args, capabilities)`；capabilities 为 `{ redactSensitiveText, truncateText }`。只做递归脱敏/逐层 JSON 解析/2000 字截断与无原型输出，不写文件、不发现令牌；`SENSITIVE_ARG_KEYS` 为模块私有常量。文件日志与已知令牌脱敏仍留入口 |
| 共享记忆安全文本与投影 | `src/core/memory-text.mjs` | `sanitizeMemoryText(value, maxLen = 200, capabilities)`、`unsafeMemoryKey`、`validMemoryUid`、`markMemoryInjection`、`projectMemoryImpressions(impressions, capabilities)`、`projectMemoryTopics`、`normalizeMemoryInclude`；capabilities 仅 `{ redactKnownTokensOnly, truncateText }` 供清洗与印象投影。私有正则/Set 随实现移入；不读配置/状态、不落盘、不改变共享与快照事务。入口保留 7 个旧名薄封装 |
| 反馈与工具调用日志的读写/清空 | `src/core/runtime-records.mjs` | `createRuntimeRecordStore({ feedbackFile, toolLogFile, readJsonSafe, atomicWriteJson, createCappedLogger, redactSensitiveText, redactSensitive, log })`；文件路径必须显式传入，导入零 I/O。返回 `readFeedbackEntries` / `appendFeedbackEntry` / `readToolLog` / `appendToolLog` / `clearFeedbackEntries` / `clearToolLog`。反馈 500 条上限、工具日志 200/1000 切片与 2000 行轮转、脱敏与错误策略全部保持；清空工具日志**不重置**追加器的内存计数（旧端点行为）。反馈限频、通知、路由鉴权仍在入口 |
| 控制台人格管理的六条 HTTP 路由 | `src/console/role-routes.mjs` | `createRoleRoutes({ roles, readRoleState, writeRoleState, getInjectMaxChars, log }) -> { matches(method, pathname), handle(req, url, { readBody, sendJson }) }`。只覆盖 `GET /api/roles`、`GET /api/roles/content` 与 `POST /api/roles/{create,update,rename,delete}`；`matches()` 同步、精确、零 I/O，未命中不读 body。`/api/roles/limit`、`/api/role`、`/api/role-mode`、鉴权与模式/预设仍在入口。roleStore 由入口创建并注入，不复制持久化规则 |
| DSH 鉴权、RPC、事件传输 | `src/dsh-client.js` | 不负责 QQ 业务决策 |
| 贴吧读取/巡逻规则、媒体传输安全、语音、黑话、表情、用量 | `src/tieba-lib.js`、`safe-fetch.js`、`voice-core.js`、`slang-learner.js`、`sticker-lib.js`、`token-ledger.js` 等 | 沿用已有专门模块，具体入口见文件导出 |
| 每会话策略路由 | `src/core/session-router.mjs` | 已存在的独立策略模块；本次不将它强行接入旧的全局模式状态机 |

依赖方向：入口 → 职责模块 → Node 内置库或已有的小模块。职责模块不反向导入入口，也不相互传递一个包含全部运行状态的 `context`。人格仓库依赖人格解析和安全文件写入；运行配置依赖人格仓库的默认常量与黑话默认值，会话仓库依赖安全文件写入；`console-input` 依赖 `model-policy` 的既有纯校验工具（`httpFail`、`requireNonEmptyString`、`isPlainObject`、`CONV_KEY_RE`、`DSH_OVERRIDE_FIELDS`）；`persona-text` 与 `image-format` 不依赖其它职责模块；`console/role-routes` 只依赖 `role-store` 的常量与 `role-card` 的统计/分区函数，运行状态通过注入的读写回调传入。`src/console/` 与 `src/core/` 同为职责模块目录（前者是控制台 HTTP 控制器），但都不是入口。

## 本次为什么保留运行状态在入口

看门狗、DSH 断线恢复、唤醒租约、消息队列和跨会话发送授权共用回合编号、活动戳及在途映射；它们的清理顺序决定会不会丢消息、重复发言或扩大授权。只把这些闭包搬到另一个大文件，再传几十个回调，不能形成可独立理解的模块。本次保留它们，避免在无真实 QQ 收发验证时改变这些时序。

共享记忆的写入、快照、回滚和唤醒续期也共用状态。文件存储基础能力已独立，但业务状态事务仍由入口控制。本次不改变快照保留期、不迁移生产数据、不重建会话。

运行配置和 `state/sessions.json` 持久化现在有显式边界，但**没有**改变启动顺序：配置默认值/合并/归一化/顶层格式校验是纯函数（错误文案不变），`config.json` 的读取、launch token 兜底发现、诊断日志和可变人格上限仍按原顺序留在入口；会话映射的读/写/只读降级归会话仓库，活动 state 映射、创建中的 promise、退役、令牌撤销、队列和模式策略仍由入口持有。这样能独立测试归一化与损坏降级，又不把运行期所有权搬走。

## 修改时的约定

1. 纯计算优先加入相应策略模块，直接 import 测试；有文件副作用的模块必须接收明确路径并使用临时目录测试。
2. 新增或调整人格卡展示规则改人格仓库；人格分代语法改 `role-card.js`；每轮人格注入和静默开关仍在入口。
3. 模型目录的显示投影/档位规则改 model-policy；请求超时、错误脱敏、鉴权和配置写入的先后顺序仍在入口。
4. 新增运行期服务前先列出：拥有的状态、外部依赖、启动/停止、在途操作失效方式，以及既有回归场景。无法给出这些边界时，先保留代码并说明原因。
5. 不为兼容旧的“源码抽取测试”在入口保留第二份实现。VM 脚手架显式注入同一套生产模块，直接行为测试取代按函数位置 `eval`。
6. 运行配置默认值与合并规则改 `runtime-config`；`config.json` 读取、凭据发现、日志和可变上限仍留入口。`sessions.json` 的读写/损坏降级改 `session-store`；不要把活动映射、队列或退役搬进去。

## 验证入口

```powershell
node scripts/test-json-store.mjs
node scripts/test-qq-text.mjs
node scripts/test-model-policy.mjs
node scripts/test-role-store.mjs
node scripts/test-runtime-config.mjs
node scripts/test-session-store.mjs
node scripts/test-bridge-core-contract.mjs
node scripts/test-model-endpoint.mjs
node scripts/test-console-input.mjs
node scripts/test-persona-text.mjs
node scripts/test-image-format.mjs
node scripts/test-pure-seams-integration.mjs
node scripts/test-send-gaps.mjs
node scripts/test-tool-log-format.mjs
node scripts/test-memory-text.mjs
node scripts/test-policy-wave-integration.mjs
node scripts/test-role-routes.mjs
node scripts/test-runtime-records.mjs
node scripts/test-node3-integration.mjs
npm run test:audit
```

完整审计包含新模块的直接测试和旧的桥接行为测试。模块导入无副作用不等于服务在线；离线桩的消息发送成功不等于真实 QQ 送达。外部 voice-tool 或 DSH 工具目录缺失时，保留测试的跳过说明，不把跳过记为覆盖通过。

`test-bridge-core-contract.mjs` 额外使用 Node 原生 ESM 加载器验证入口声明的 18 个职责模块导入（`src/core/` 17 份含 runtime-records，`src/console/` 1 份 role-routes；含 console-input / persona-text / image-format / send-gaps / tool-log-format / memory-text），并检查 VM 脚手架里的函数与生产导出是同一对象，避免源代码求值测试掩盖导入名称错误。它还自动发现执行完整入口的 VM 脚手架，检查主审计以外的 `verify-*` 脚本也接入同一绑定；`scripts/bridge-core-bindings.mjs` 对两个目录统一 `export *`，不使用别名。

2026-10-20 三条纯缝的离线门禁：宿主机 full 67/67、quick 24/24 通过，原 full62/quick20 前缀顺序不变；13 模块原生导入契约 3/3 与纯缝集成 6/6 通过。live 服务验证仍待用户执行；外部依赖缺失（独立 voice-tool、DSH 包、live GUI、qsh）时既有 skip 保留，不计为覆盖通过。

2026-10-20 node3 再把控制台人格管理与反馈/工具日志存储移出入口：`src/console/role-routes.mjs` 接管六条人格路由（同步 `matches()` 守在原两个 GET / 四个 POST 的插槽，`/api/roles/limit` 整块保持原位与字节不变），`src/core/runtime-records.mjs` 接管四条记录读写与两个 clear 端点（构造点仍是原 `appendToolLogFile = createCappedLogger(...)` 的位置，清空工具日志不重置计数）。入口保留 `roleStore` 单次创建与 `readRoleState`/`writeRoleState`、四个旧名记录薄封装、反馈限频与鉴权。`test-node3-integration.mjs` 用真实 bridge harness 起隔离 HTTP：401 先于 handler、agent token 403 沿用集中白名单、六路由成败分支、上限动态反映、排除路由与错误方法回落、反馈/工具日志 clear 仍要求控制台身份，并用工厂 spy 断言两个工厂各构造一次且为真实实现。原生导入契约随之覆盖 17 core + 1 console = 18 份；统一清单长度变为 full 74 / quick 31。本波次 `npm run test:quick` / `npm run test:audit`（74/31）与 live 验证均为 **NOT RUN**。node2 之前（纯缝波次）的 67/67、24/24 是宿主机实测通过；node2 的 71/28 只是清单登记、聚合未运行，node3 的 74/31 同样未运行；用户明确决定继续推迟统一聚合与 live 验证。

本次开始前的完整审计为 45/46（Stage 1 结束时的结果）：用户已删除根目录 `README.md`，`test-voice-system.mjs` 中的文档检查因此报 ENOENT。本次不恢复用户删除的文档、不跳过该断言，也不将这个已存在的问题算作新增回归。

## 后续拆分顺序

配置解析与会话持久化已按实例边界拆出。2026-10-18 又独立了唤醒定时器的时钟/句柄与租约登记：入口显式注入时钟，原生句柄仍保留在 pendingWakeTimer/sleepTimer/replyCheckTimer/proactiveTimer 和原租约 Map，现有忙状态观察不变。模块在回调前确认注册身份与当前句柄，先解除登记再执行业务；取消或替换后迟到的旧回调不能误清新任务。显式取消则清理当前槽位与旧登记，兼容测试/遗留调用点直接写入的原生句柄。

本次没有拆整个唤醒调度器：唤醒原因合并、时间窗/概率、延迟计算、睡眠分段（保留原 100009ms 阈值）、30 分钟租约到期的业务 busy 清理、发送与授权均仍在入口；看门狗/重连的扫描和状态机也留在入口。旧冻结验证不再要求租约函数体逐字相同，而是对照冻结提交执行到期/撤销/unref/时长行为，再由假时钟的真实桥接集成测试检查旧回调失效。后续如需拆看门狗、授权回合或控制台路由，仍逐步移交状态所有权，不把几千行整体搬走作为“完成模块化”的证据。

实施计划：`docs/superpowers/plans/2026-10-17-bridge-modularization.md`（Stage 1）、`docs/superpowers/plans/2026-10-17-bridge-stage2-extraction.md`（Stage 2）。本机团队过程和审计证据：`.agent-teams/modularization-20261017/` 与 `.agent-teams/modularization-stage2-20261017/`，不包含生产密钥。

定时器实施计划：`docs/superpowers/plans/2026-10-18-wake-timers.md`；直接测试 `node scripts/test-wake-timers.mjs`，真实桥接/假时钟集成测试 `node scripts/test-wake-timer-integration.mjs`。两项均登记 quick/full；本机过程证据在 `.agent-teams/wake-timers-20261018/`。

同日又拆出看门狗的纯判定规则：时长计算仍在 C-stall 探测之前，档位判断仍在探测调用之后，所以“无告警档位”不会跳过早期探测。WARN 只记录，release 优先于 hardcap；hardcap 仍受零帧门槛保护。默认值/热配置、门禁、忙闲边沿、WARN 去重、日志及释放/重排/恢复动作全部留在入口，没有移交运行状态所有权。

判定计划：`docs/superpowers/plans/2026-10-18-watchdog-policy.md`。直接检查 `node scripts/test-watchdog-policy.mjs` 使用仓库内独立历史表达式夹具，不依赖本机任务快照；`node scripts/test-watchdog-integration.mjs` 在真实桥接函数和临时同伴上检查阈值、档位优先级与 episode 生命周期。这两项已追加 quick/full，本机证据位于 `.agent-teams/watchdog-policy-20261018/`。

同日继续窄拆支撑规则：`normalizeBusyWatchdogConfig(raw, defaults)` 只做七键默认/数值归一化，原始 selector 与 `BUSY_WATCHDOG_DEFAULTS` 仍留入口；`canRearmBusyWatchdog(times, wd, at)` 只做 cooldown/小时上限判定，`rearmV2` 的读取、记录与裁剪仍在入口。扫描顺序、探测、释放/重排/恢复动作与授权未动，旧语义（null/'' 回落、Number 强制、仅 enabled===false、零值 clamp、严格 `<3600000`）保持原样。计划：`docs/superpowers/plans/2026-10-18-watchdog-support.md`；直接检查 `node scripts/test-watchdog-support.mjs`，真实桥接边界仍在 `node scripts/test-watchdog-integration.mjs`。两项均登记 quick/full，本机证据位于 `.agent-teams/watchdog-support-20261018/`。

同日拆出唤醒配置/沉睡安全/原因优先级的纯策略：入口热读 `cfg.socialV2.wake` 并把配置与以延迟函数形式注入的 `now`/`random` 交给 `src/core/wake-policy.mjs`，`preSleepWaitBlockedV2(null)` 仍在读取配置前返回。`computeWakeSafetyV2` 的 `hard/timed/soft/guaranteed` 保留原非布尔类型，时钟按原分支 0/1/2 次读取；舍入、clamp、`Number(x) || fallback`、仅严格 false 关闭、20 人上限、冒号基名与普通对象继承查表均按冻结语义。默认值刷新、`ensureWakeableV2`、睡眠定时器、队列/发送/授权未动；`replyTimingV2` 仍留入口（依赖回合时序）。计划：`docs/superpowers/plans/2026-10-18-wake-policy.md`；直接历史差分 `node scripts/test-wake-policy.mjs`，真实桥接边界 `node scripts/test-wake-policy-integration.mjs`，两项登记 quick/full；证据在 `.agent-teams/wake-policy-20261018/`。

同日窄拆唤醒触发/定向提问识别：`isDirectedAtAi(textContent)` 的纯文本正则与 `evaluateWakeTrigger(st, event, kind, textContent, plainContent, quoteTargetIsSelf, { getNickname, random })` 的判定链移入 `src/core/wake-policy.mjs`，旧七函数字节级保留；入口保留 `isDirectedAtAi` 与 `evaluateWakeTriggerV2` 原名/签名/调用点作为薄封装，`key` 仍保留但未使用。昵称只在原三处表达式位置以独立 `getNickname: () => selfNickname` 延迟读取（文本转换可改变昵称），随机数仅在最终概率表达式以 `random: () => Math.random()` 抽取；规则优先级 anyMessage > at/quote > name > keyword > question > speaker > probability，短词边界正则、sender 回落、`Number(probability)` 两次与 null/false/raw 配置均按冻结语义，不做 clamp/归一化。V1 `isDirectAddress`/`isMustReplyText` 共享谓词封装，队列/授权/发送/回复时序未动。计划：`docs/superpowers/plans/2026-10-18-wake-trigger.md`；直接历史差分 `node scripts/test-wake-trigger.mjs`，真实桥接边界 `node scripts/test-wake-trigger-integration.mjs`，两项追加 quick/full；证据在 `.agent-teams/wake-trigger-20261018/`。

2026-10-20 又将依赖回合时序的回复节奏建议窄拆到 `src/core/reply-timing.mjs`：`suggestQuietMs(st, capabilities)`、`replyTiming(st, capabilities)` 通过 `getWaitConfig: () => cfg.socialV2?.wait`、`now: () => Date.now()` 与既有纯 `looksLikeUnfinished` 延迟读取，入口只在原调用点保留 `suggestQuietMsV2`/`replyTimingV2` 两个薄封装，函数名、签名和消费点不变。配置按原表达式分三次热读（min→max→建议默认），时钟按每条候选消息读取；`Infinity`/`NaN`/负数/零值与 `Number(x) || fallback` 原样保留，未完成文本在过滤前返回，`lastIncomingAt` 在建议之后才转换；未新增向上导入、模块级 I/O 或共享状态。原生直测 `node scripts/test-reply-timing-policy.mjs` 9 项（含 undefined 配置、空串/零值回落、`maxMs:'0'`、注入 helper 探针及精确读取/时钟顺序），冻结夹具的真实桥接差分 `node scripts/test-reply-timing-baseline.mjs` 8 项，均登记 quick/full（由 19/61 变为 20/62）；此前 19/61 记录保持为历史，full62 完整审计仍由宿主机另行确认。计划与证据：`.agent-teams/reply-timing-20261020/`。

2026-10-20 又把三类纯策略窄拆成模块：`src/core/send-gaps.mjs`（`clampMessageGap` / `computeMessageGaps`，随机与 `randInt` 由入口以延迟函数注入，固定/按长度模式不消耗随机）、`src/core/tool-log-format.mjs`（`redactToolLogValue` / `formatToolLogArgs`，JSON 逐层解析、2000 字截断与无原型输出保持原样，令牌发现与文件日志仍留入口）、`src/core/memory-text.mjs`（共享记忆清洗、危险键/UID 判定、注入标记与印象/话题投影，文字能力由入口注入）。入口只把 11 个旧函数体改为直接委托并移走 6 行私有常量；调用点、默认参数、状态所有权、发送时序、共享记忆事务与快照逻辑均未动。`scripts/bridge-core-bindings.mjs` 对 16 份 core 模块统一 `export *`，`test-bridge-core-contract.mjs` 的原生 ESM 契约与 VM 同一性检查随之覆盖新增 3 份实现；`test-shared-memory.mjs` 的三个源码抽取工厂在三个调用点注入真实 memory 模块命名空间，旧桩件、行为与断言全部保留。集成证据 `scripts/test-policy-wave-integration.mjs` 用哨兵绑定验证 11 个适配器的委托与延迟能力注入，并用真实模块 + 假 harness 验证记忆清洗/投影和工具 JSON 脱敏。本波次用户明确推迟统一测试：full 71 / quick 28 的**当前**聚合与 live 验证均为 NOT RUN，此前 67/24 通过只是历史记录，不能视为本波次门禁结果。
