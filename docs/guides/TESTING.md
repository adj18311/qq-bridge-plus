# 测试入口（TESTING）

聚合测试只有一套清单：`scripts/test-suite-manifest.mjs`。quick 与 full 共用
`scripts/test-suite-runner.mjs` 的串行执行、每脚本 60s 超时与失败口径，不维护两份列表。

## 命令

| 场景 | 命令 | 范围 | 预期耗时 |
| --- | --- | --- | --- |
| 快速（日常改动 / 提交前） | `npm run test:quick` 或 `node scripts/test-quick.mjs` | 7 项模块边界/契约直测 + 2 项测试地基回归 + 2 项唤醒定时器检查 + 2 项看门狗判定检查 + 1 项看门狗支撑规则检查 + 2 项唤醒策略差分/集成检查 + 2 项唤醒触发差分/集成检查 + 1 项回复节奏基线检查 + 1 项原生回复节奏策略直测 + 3 项纯缝直接测试 + 1 项纯缝桥接集成检查 + 3 项纯策略缝直测 + 1 项纯策略缝桥接集成检查 + 2 项 node3 模块直测 + 1 项 node3 真桥接隔离 HTTP 集成，共 31 项 | 秒级（本机目标 ≤15s，实际视机器而定） |
| 全量（发布前 / 宿主机） | `npm run test:audit` 或 `node scripts/test-audit.mjs` | 原 48 项聚合审计 + 26 项追加检查（含会话路由单测、回复节奏基线、原生回复节奏策略、4 项纯缝检查、3 项纯策略缝直测 + 1 项纯策略缝集成、2 项 node3 模块直测 + 1 项 node3 集成、全量专用的模型端点 HTTP 集成），共 74 项 | 数分钟 |
| 显式选择 | `node scripts/test-audit.mjs full\|quick` | 同上，无参数默认 full | — |

退出码：全部通过 `0`；任一脚本失败/超时 `1`；参数错误 `2`。子进程统一注入
`QQ_BRIDGE_TEST_LIVE=0`（离线），不读真实 QQ/DSH 服务。

## quick 与 full 的差异

- quick 只覆盖模块边界/契约直测（json-store、qq-text、model-policy、console-input、
  persona-text、image-format、role-store、runtime-config、session-store、bridge-core-contract）
  和测试地基自身（清单/runner 契约、语音文档断言负向回归），另含唤醒定时器检查、看门狗纯判定与支撑规则的独立历史差分检查、
  唤醒策略与唤醒触发的独立历史差分及各自真实桥接集成检查。它不替代全量审计；不要为了让 quick 变绿而删慢检查。
- full 保留 2026-10-17 前的全部 48 项注册（含安全、协议、守护、语音系统、SnowLuma 等），
  新增项只追加在末尾，既有顺序不变；`test-model-endpoint.mjs` 仅在 full 单独登记。

## 测试文件位置与登记

新增测试默认放在 `scripts/test-*.mjs`；已有的 `src/core/session-router.test.mjs`
保留原位，通过清单中的 `../src/core/session-router.test.mjs` 接入 full（33 个用例）。
路由测试只加入 full；随后回复节奏基线同时加入 quick/full。2026-10-20 提取后又追加原生
回复节奏策略直测；同日三条纯缝提取再追加 4 项（quick/full 均登记）与 1 项 full 专用模型端点集成；
随后三条纯策略缝提取再追加 4 项（quick/full 均登记），当时清单长度为 28/71；
node3 再追加 3 项（quick/full 均登记），当前清单长度 **31/74**。
此前 24/67、20/62、19/61 的阶段记录保持原样，均只是历史。
该路由模块目前尚未接入生产桥接，测试通过不代表生产已使用会话路由。

runner 以 `scripts/` 为基准解析每项路径，不自动发现文件，也不展开 `*.test.mjs`
通配符。应纳入离线门禁的测试，无论放在哪里，都必须在权威清单中显式登记；仅创建文件
不会自动进入审计。清单契约同时检查路由测试注册及目标文件存在。

## 回复节奏拆分前基线

`scripts/fixtures/legacy-reply-timing.mjs` 冻结 2026-10-20 拆分前的
`suggestQuietMsV2`、`replyTimingV2` 函数体；正文哈希在冻结时与真实桥接核对。
`scripts/test-reply-timing-baseline.mjs` 通过既有临时桥接 harness 直接调用真实函数，
与独立夹具逐项比较结果、异常及有序读取轨迹，每侧创建新的时钟和 getter 输入。

覆盖：默认值/零值回落、舍入与上下限冲突、15 秒临界点、每条有效消息独立读取时间、
三条命中后仍完整扫描、未完成文本提前返回、热配置读取顺序、时间值转换、剩余等待、
120 组固定种子输入及实际唤醒提示消费。两种错误变体只修改历史夹具的内存副本，
用于验证缓存时间或提前读取配置会被识别；不等于已对未来生产模块做变异验证。

上述段落记录的是拆分前的 19/61 状态（冻结夹具 + 真实桥接差分），不是当前实现状态。

## 回复节奏提取（2026-10-20，quick/full 20/62）

`src/core/reply-timing.mjs` 现导出 `suggestQuietMs(st, capabilities)` 与
`replyTiming(st, capabilities)`；capabilities 为 `{ getWaitConfig, now, looksLikeUnfinished }`，
分别延迟读取 `cfg.socialV2?.wait`、时钟和纯未完成文本判定，导入时不采样配置/时间/状态，模块不缓存。
入口保留原 `suggestQuietMsV2`/`replyTimingV2` 名称、签名和调用点作为薄封装；`looksLikeUnfinished`
实现仍留在 `src/v2-wait.js`。逐字语义（`Number(x) || fallback`、`Infinity` 原值、严格 `<15000`、
三条命中后完整扫描、未完成文本不读时钟、三次独立配置读取、`lastIncomingAt` 在建议之后转换）
由原生直测与真桥接差分共同锁定。

- 原生直测 `node scripts/test-reply-timing-policy.mjs`：9 项，覆盖 capability 边界（undefined 配置、
  空串/数值零回落、`maxMs:'0'`、注入 `looksLikeUnfinished` 探针）与精确有序读取/时钟轨迹。
- 真实桥接基线 `node scripts/test-reply-timing-baseline.mjs`：8 项，继续对照冻结夹具；夹具与
  基线测试本身保持字节不变，8/8 在提取后仍通过。
- 基线组 `REPLY_TIMING_BASELINE_TESTS` 保持只含基线脚本（测试地基契约要求）；原生策略直测单独登记为
  `REPLY_TIMING_POLICY_TESTS`，两组都追加在 quick/full 末尾，因此由 19/61 变为 20/62，旧 61/19 前缀顺序不变。
  full62 的完整审计由宿主机运行确认，本文件不声称其已通过。
- 既有 `scripts/test-reply-wait.mjs` 的真实等待/新消息/沉睡观察回归继续保留。

## 三条纯缝提取（2026-10-20，quick/full 24/67）

同日把入口里三段纯计算窄拆成独立模块，入口只留原名薄封装或原来的前缀调用点：

- `src/core/console-input.mjs` 导出 `parseModelUpdateInput(body) -> { nextProvider, nextModel, nextEffort, patch, removals }`，
  只做 `applyDshModelUpdate` 在「② 读盘」之前的形状校验与覆盖补丁归一；目录读取、鉴权、读盘、备份、原子写、
  内存同步与 epoch 仍留入口。入口用导入实现替换该前缀，后续代码不变。
- `src/core/persona-text.mjs` 导出 `cjkLikeChar`、`convertExampleSpaces`、`cjkSpaceWarning`、`splitBoundaryWarning`；
  入口的 `isCjkLikeChar` / `convertExampleSpacesToComma` / `findCjkSpaceWarning` / `findSplitBoundaryWarning`
  保留原名与签名，只做直接调用。角色文件读取与 `currentRoleHintV2` 的小节筛选仍在入口。
- `src/core/image-format.mjs` 导出 `detectImageMime`、`imageMimeFromUrl`、`imageDimensions`、`parseImageBase64`；
  入口的 `mimeFromBuffer` / `mimeFromUrl` / `getImageDimensions` / `base64FromMaybe` 保留原名、默认回退参数与返回语义，
  只做直接调用。网关下载、体积/像素上限、本地路径与 SSRF 校验仍在 `fetchOneBotImage` 等入口代码里。

登记方式：`test-console-input.mjs`、`test-persona-text.mjs`、`test-image-format.mjs`、
`test-pure-seams-integration.mjs` 归入 `PURE_SEAM_TESTS`，追加在 full/quick 既有条目之后；
`test-model-endpoint.mjs` 作为 `MODEL_ENDPOINT_TESTS` 仅加入 full。原 full62/quick20 前缀顺序不变，
由 20/62 变为 24/67。`test-bridge-core-contract.mjs` 的原生 ESM 契约当时核对 13 个 core 模块
（三条纯策略缝提取后为 16 个，见下节），`scripts/bridge-core-bindings.mjs` 同步 `export *` 这三份实现，
VM 脚手架只额外暴露旧适配器、`currentRoleHintV2` 与 `fetchOneBotImage`（不新增生产 API）。

`test-pure-seams-integration.mjs` 全部走隔离 VM 与临时角色的离线夹具：用注入计数桩证明八个
persona/image 适配器确实调用导入实现；第九条 console-input 缝用真实隔离 HTTP `/api/dsh/model`
哨兵证明鉴权顺序与委托——无令牌返回 401 且解析器零调用，合法夹具令牌进入注入的
`parseModelUpdateInput` 一次并返回哨兵 400，内存 cfg 与临时 `config.json` 均不变。
另用临时人格卡验证 `currentRoleHintV2` 的示例空格转换，用 FakeBot 小 PNG 验证
`base64 → MIME → 尺寸` 链，并验证 9000×9000 头仍被原始 64M 像素上限丢弃；`sendToQQ` 仅作为既有真实消费点验证发送落点。
人格空格/拆条警告在发送工具里的 HTTP 响应形状没有另建重复集成测试：警告函数按上游接口直接验证，
HTTP 发送路径沿用既有发送工具测试；`test-model-endpoint.mjs` 的 38 项继续作为模型热更新端点
正常行为的隔离 HTTP 集成（含鉴权、错误与零副作用），并作为 full 专用的 `MODEL_ENDPOINT_TESTS` 登记。
full67 的完整审计由宿主机运行确认，本文件不声称其已通过。

## 三条纯策略缝提取（2026-10-20，清单 28/71，未运行）

同日把入口里三段纯策略窄拆成独立模块，旧函数名/签名/调用点保持不变，只改为直接委托：

- `src/core/send-gaps.mjs` 导出 `clampMessageGap(ms, sendCfg)` 与
  `computeMessageGaps(messages, gapMode, gapMs, gaps, sendCfg, capabilities)`；`capabilities` 为
  `{ random, randInt }`。入口 `clampGapV2`/`computeGapsV2` 每次调用时新建延迟函数
  （`() => Math.random()`、`(min, max) => randInt(min, max)`），不缓存抽样或配置；固定/按长度
  分支不消耗随机，发送队列、延迟执行与定时器仍留入口。
- `src/core/tool-log-format.mjs` 导出 `redactToolLogValue(obj, capabilities)` 与
  `formatToolLogArgs(args, capabilities)`，`capabilities` 为 `{ redactSensitiveText, truncateText }`；
  `SENSITIVE_ARG_KEYS` 成为模块私有常量。递归脱敏、四次 JSON 解析、无原型输出、跳过原型键、
  2000 字截断与既有错误语义原样保留；文件日志与已知令牌脱敏仍留入口。
- `src/core/memory-text.mjs` 导出 `sanitizeMemoryText(value, maxLen = 200, capabilities)`、
  `unsafeMemoryKey`、`validMemoryUid`、`markMemoryInjection`、`projectMemoryImpressions(impressions, capabilities)`、
  `projectMemoryTopics`、`normalizeMemoryInclude`；仅清洗与印象投影接收
  `{ redactKnownTokensOnly, truncateText }`。入口 7 个旧名保持原名/默认参数/返回语义并直接委托，
  5 行私有正则/Set 常量随实现移入，注释与补丁标记不动；配置、状态、快照与共享桶事务未变。

登记方式：`test-send-gaps.mjs`、`test-tool-log-format.mjs`、`test-memory-text.mjs`、
`test-policy-wave-integration.mjs` 归入 `POLICY_WAVE_TESTS`，追加在 full/quick 既有条目之后；
原 full67/quick24 前缀顺序不变，清单长度变为 71/28。`test-bridge-core-contract.mjs` 的原生
ESM 契约核对 16 个 core 模块，`scripts/bridge-core-bindings.mjs` 同步多 `export *` 这三份实现。
`test-shared-memory.mjs` 的三个源码抽取工厂在三个调用点注入真实 memory 模块命名空间；
旧 `redactKnownTokensOnly`/`truncateText` 桩件与全部既有断言保留。

`test-policy-wave-integration.mjs` 全部走隔离 VM：注入 `clampMessageGap`/`computeMessageGaps`
哨兵证明参数透传与 capabilities 延迟注入（构造时不抽样，`randInt` 仍走入口原闭包）；
`redactToolLogValue`/`formatToolLogArgs` 哨兵证明工具日志能力对象；真实记忆模块配假文本能力
验证清洗、注入标记、危险键/UID、印象/话题投影与 include；真实工具日志模块验证敏感键脱敏、
逐层 JSON 与 2000 字截断。原生导入同一性不在本文件重复，由 `test-bridge-core-contract.mjs` 负责。

**本轮证据范围**：用户明确推迟统一测试。上述四个脚本只应在模块落地后单独运行；
`npm run test:quick` / `npm run test:audit`（28/71）与 live 验证在本波次均为 **NOT RUN**。
此前记录的 67/67、24/24 是上一波次的历史通过结果，不代表本次清单内容已通过。

## node3：人格路由与运行记录（2026-10-20，清单 31/74，未运行）

入口把控制台人格管理的六条端点移到 `src/console/role-routes.mjs`，把反馈/工具日志的
读写与清空移到 `src/core/runtime-records.mjs`；两者都只接收显式依赖，导入零 I/O。桥接在
原两个 GET / 四个 POST 的插槽只留一个同步 `matches()` 守卫，`/api/roles/limit` 整块保持
原位；`roleStore` 仍只创建一次，四个记录函数保留原名/默认参数并直通委托，反馈限频、
工具日志计数上限与鉴权均未动（清空工具日志仍不重置计数器，属保留的历史行为）。

登记方式：`test-role-routes.mjs`、`test-runtime-records.mjs`、`test-node3-integration.mjs`
归入 `NODE3_TESTS`，追加在 full/quick 既有条目之后；原 full71/quick28 前缀顺序不变，
清单长度变为 74/31。`test-bridge-core-contract.mjs` 的原生 ESM 契约与 VM 同一性检查
扩展到 `./core/` 与 `./console/` 两个目录，共 17 core + 1 console = 18 份实现，
`scripts/bridge-core-bindings.mjs` 同步多 `export *` 这两份模块，不使用别名。

`test-node3-integration.mjs` 用真实 bridge harness 在临时仓库起真实 console server：
无/错控制台令牌 401 且人格目录与角色回调零变化、agent token 的人格写请求仍是集中白名单
403；六条人格路由的成功与 400/404 分支；重命名/删除跟随当前人格；`/api/roles/limit`
改上限后两个 GET 立即反映、`/api/role` 与 `/api/role-mode` 未被截走；错误方法与未知路径
同步回落 404 且不进入 handler；反馈/工具日志的 GET/clear 仍要求控制台身份（agent token
403 且不清空）；工厂 spy 证明两个工厂各构造一次且是真实实现。全程只碰 %TEMP% 下的
config/state/roles，不读真实凭据或连接 QQ/DSH。

**本轮证据范围**：用户明确推迟统一测试。上述三个脚本只应在模块落地后单独运行；
`npm run test:quick` / `npm run test:audit`（31/74）与 live 验证在本波次均为 **NOT RUN**。
67/67 与 24/24 是 node2 之前（纯缝波次）经宿主机验证的通过记录；node2 的 71/28 只是清单
登记、聚合门禁同样推迟未运行，因此不是通过结果；node3 登记的 74/31 也尚未运行。用户已明确
决定继续推迟统一聚合与 live 验证。

## 可选跳过（skip）的含义

测试脚本可能因外部条件缺失而显式跳过，例如独立语音工具 `../voice-tool/` 不在本机时，
`test-voice-system.mjs` 的入口/配置断言会 `skipVoiceTool(...)`。**skip 不是 pass**：
它只表示该断言本次无法执行，报告会单独列出。仓库内产物（权威文档、清单成员、fixture）
缺失一律失败，不允许用 skip 掩盖。

## 不包含什么

以下是**清单之外**的独立 live/e2e/浏览器/自检命令，需要时单独运行，不是 quick/full 的一部分：
`npm run test-wait:e2e`、`npm run test:session-retire:e2e`、`npm run test:console-ui`、
`npm run self-test`、`npm run verify:adaptation`、`npm run verify:persona`、独立语音工具的真实发送。

注意不要按前缀一概而论：`test:dsh-inbox`（`test-dsh-inbox-projection.mjs`）与
`verify-snowluma-upstream-health.mjs` **已经**是 full 清单成员。成员以
`scripts/test-suite-manifest.mjs` 为准。

## 与历史快照无关

测试不依赖 `.agent-teams/` 下的历史任务快照：旧 `loadConfig` 基线已冻结为
`scripts/fixtures/` 内的测试夹具。检出本仓库即可运行 quick/full。
