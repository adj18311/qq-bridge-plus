# 文档索引（docs/README.md）

> 本项目不是原创：它是 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的二次创作（改进版），特别鸣谢原作者。

> 根目录只留 `README.md` / `README.en.md` / `RULES.md` 三个文档，其余全部在本目录下。
> 仓库目录结构与 `scripts/` 命名约定见 **[FOLDER_MAP.md](FOLDER_MAP.md)**。
>
> **状态标记**：✅ 仍然有效（按它做就对） · ⚠️ 部分过时（见备注） · 🗄️ 已被取代（保留作背景）

---

## guides/ —— 面向使用者 / 运维

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [guides/PROJECT_GUIDE.md](guides/PROJECT_GUIDE.md) | **权威项目说明书**（113 KB / 1450+ 行）：架构、内外核划分、数据流、配置全解、安全机制、调试与改进指南，含 2026-08-20 ~ 2026-09-11 的逐轮更新记录 | ✅ **唯一权威版本**（另一份同名精简版已归档到 legacy，见下） |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | DSH 端安装说明：`qq-chat` / `qq-chat-v2` preset 与三个 MCP server 怎么挂到目标设备的 DSH 上 | ✅ |
| [guides/VOICE.md](guides/VOICE.md) | 语音发送全解：独立工具（`voice-tool/` 的图形界面与命令行）、桥接 CLI、AI 工具、控制台面板，以及**工具拆出后的配置解析顺序** | ✅ 2026 整理时已更新（工具移到上一级 `voice-tool/`） |
| [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | 控制台「令牌与花费」看板：数据来源、计价口径（峰谷分时）、API、配置 | ✅ |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台离线预览（`npm run preview:console`）与离线浏览器回归（`npm run test:console-ui`）怎么用 | ✅ 2026 整理时自 `scripts/` 移入 |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | **安全基线与威胁模型**：威胁主体、已实现的边界（准入/工具面/出站/控制台/落盘/网络）、已知残余风险、发布前回归清单、改动检查单 | ✅ **改动安全相关代码前必读**（2026-09-20 新增） |
| [guides/BUSY_WATCHDOG.md](guides/BUSY_WATCHDOG.md) | **卡忙自愈看门狗**：四条忙判据、"活动＝DSH 流帧"的理由、两档阈值与硬上限、释放后怎么补发去重、配置项、日志怎么读、怎么禁用与回滚、已知限制、测试怎么跑 | ✅ 2026-10-05 新增（本仓库相对上游的新功能） |
| [guides/LOCAL_PATCHES.md](guides/LOCAL_PATCHES.md) | **本地改动清单与重打方式**：跨会话共享记忆、记忆每日快照+回滚、activeHours 主动机会时间窗、restart.bat stdin 修复、DSH profile 的 yun-xi-gpt retryPolicy —— 升级桥接包/重装插件后照着重打 | ✅ 2026-10-04 新增 |
| [guides/SHARED_MEMORY_REPLAY.md](guides/SHARED_MEMORY_REPLAY.md) | **可重放记录**：7 处核心改动的「唯一锚点 + 改动前/后」、备份文件名、升级后重打步骤；锚点表由 `npm run test:shared-memory` 逐条机器核对 | ✅ 2026-10-04 新增 |
| [guides/SHARED_MEMORY_PATCH.md](guides/SHARED_MEMORY_PATCH.md) | **跨会话共享记忆（本地补丁）**：补丁点清单（7 处核心 + 依赖的 memory-update / memory-query / 续期循环）、写入口径、共享域配置、升级脆弱性与回归检查点、`npm run test:shared-memory` 怎么跑 | ✅ 2026-10-04 新增 |
| [guides/UPGRADE-RETRO-2026-10-04.md](guides/UPGRADE-RETRO-2026-10-04.md) | **2026-10-04 这一轮的复盘**：9 条缺陷（现象/根因/修复/证据 file:line，含守护自杀离线 20 分钟、快照兜底名、端点 fail-open、日志文案、印象 uid 开关、脏会话、控制台面板、改名 uid 行为断言、`start.bat` 5s 分支缺兜底）+ 三条实测事实（并发假红、N2 残余边界、面板懒加载/预览局限）+ 8 条作业纪律改进 + 下一轮候选 | ✅ 2026-10-04 新增 · ⚠️ **本文件不在公开仓库里**（`.gitignore` 保护，含本机路径与真 QQ 号，仅本机） |
| [guides/TEAM_RUN_CHECKLIST.md](guides/TEAM_RUN_CHECKLIST.md) | **团队作业 checklist**：开工前 / 进行中 / 收尾三段，每条都给可执行命令与通过标准（含冻结工作区跑审计、`file mtime` vs 进程启动时间判"是否生效"、端点 403/200 矩阵） | ✅ 2026-10-04 新增 · ⚠️ **本文件不在公开仓库里**（`.gitignore` 保护，含本机路径，仅本机） |
| [guides/REVIEW_OUT_OF_TEAM_2026-10-04.md](guides/REVIEW_OUT_OF_TEAM_2026-10-04.md) | **三处团队外改动的独立评审**（`restart.bat` / DSH profile 的 `yun-xi-gpt` retryPolicy / `SnowLuma/index.mjs` 的 historySync 探测容错）：逐处 file:line 结论与 verdict、残余风险、未核实点、被评审文件与备份的绝对路径 + SHA256 | ✅ 2026-10-04 新增 · ⚠️ **本文件不在公开仓库里**（`.gitignore` 保护，含本机绝对路径，仅本机） |
| [guides/NEXT-TASKS-ROUND2.md](guides/NEXT-TASKS-ROUND2.md) | **第 2 轮待办（含根因）**：读端点 create-on-read 会给非白名单 key 建会话、SnowLuma 跳过数不进 `failedSessions`、mark-read 容错、historySync 的 TRACE 诊断、`adminOnlyV2Paths` 注释、快照面板静态断言、N2 残余边界、守护 vs 测试桩的排障经验、守护「真控制台」路径未覆盖、**会话「忙」可无限期且唤醒被静默暂存**、控制台令牌轮换 —— 每条给现象/证据 `file:line`/为什么本轮不做/建议做法 | ✅ 2026-10-04 新增 · ⚠️ **本文件不在公开仓库里**（`.gitignore` 保护，含本机路径与真 QQ 号，仅本机） |
| ——（未登记行）`guides/HANDOFF_PROMPT.md` / `guides/NEXT-TASKS.md` | 本机内部交接提示与**第 1 轮**任务表（入口文档，不对外） | ⚠️ **不在公开仓库里**（`.gitignore` 保护，仅本机；因此不在上表单独登记，避免索引指向未提交的文件） |

## design/ —— 设计与规划（读设计意图用）

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [design/GEN2_SIMULATION_PLAN.md](design/GEN2_SIMULATION_PLAN.md) | 二代仿真（`reserved2`）「一切皆工具」实施计划：WakeConfig 唤醒调度、MCP 工具集、控制台参数、`qq-chat-v2` preset | ⚠️ 骨架/API/调度/MCP/UI 均已落地，文中「状态：实施中」与残留 TODO 以当前代码为准 |
| [design/SOCIAL_MODE_PLAN.md](design/SOCIAL_MODE_PLAN.md) | 一代仿真模式（`reserved`）的头脑风暴定案：规则引擎管「何时说」、LLM 管「说什么」 | ⚠️ 描述的一代状态机已实现；`reserved2` 已是默认模式，设计背景仍有效 |
| [design/DSH_QQ_TOOLS_PLAN.md](design/DSH_QQ_TOOLS_PLAN.md) | 「一切皆工具」总路线与交接文档：当前能力盘点、安全性设计、分阶段计划 | ⚠️ 阶段计划大部分已完成，作为路线/安全设计参考仍有效 |
| [design/真人语感策略.md](design/真人语感策略.md) | 拟人化策略：短句碎片、接梗、错别字、话题漂移、选择性沉默、括号用法 | ⚠️ 文首已自注：部分「现状」写于旧版随机分句时期，最新行为以 PROJECT_GUIDE / 代码为准 |

## research/ —— 调研记录（结论可直接引用，过程可能过时）

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [research/SnowLuma功能调研.md](research/SnowLuma功能调研.md) | SnowLuma 除「OneBot WS + 基础收发」之外还有哪些 QQ 相关功能与机制（API 面、可扩展点） | ✅ 调研对象 v1.14.9；换 SnowLuma 大版本后需复核 |
| [research/RESEARCH_QQ_MESSAGE_DND.md](research/RESEARCH_QQ_MESSAGE_DND.md) | QQ 群「消息免打扰」到底影响不影响 SnowLuma 收发消息 —— 结论：不影响，只是不提醒 | ✅ |
| [research/RESEARCH_SNOWLUMA_EMOJI_STICKER.md](research/RESEARCH_SNOWLUMA_EMOJI_STICKER.md) | SnowLuma 的表情包/收藏表情能力（`fetch_custom_face*` 等），本仓库收藏表情功能的依据 | ✅ |
| [research/LOCAL_MODEL_SIZING.md](research/LOCAL_MODEL_SIZING.md) | 若要本地复刻：本项目对模型的真实负载、显存门槛、27–35B 起步、双 3090 是性价比拐点 | ✅ 调研日期 2026-09-17 |

## audits/ —— 审查 / 体检 / 优化报告（按时间读，越新越权威）

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) | **DSH 0.2.0 适配改动记录**（v0.1.7 → v0.2.0）：逐条列出为适配 0.2.0-rc.2 做的改动（现象/为什么必须改/证据/怎么验证），并单独列出「复核后判定兼容、因此没改」的部分与「同批但不属于适配」的改动 | ✅ **最新**；升级 DSH 前先读 §10 的操作清单。放在 `guides/` 是因为 `audits/`、`design/`、`legacy/`、`research/` 都在 `.gitignore` 里（见该文件第 52–64 行），放进那几处的文档**不会进公开仓库** |
| [audits/AUDIT_FIXES_2026-09-20.md](audits/AUDIT_FIXES_2026-09-20.md) | **那一轮（第二轮）三路并行审计与修复记录**：桥接内核 / 控制台与打包 / 文档基线；逐条列出已修、已确认无问题、列为规划 | ✅（取代下面那份的结论；`CODE_AUDIT` 中当时未修完的项已在此结清）⚠️ **本文件不在公开仓库里**（`docs/audits/` 被 `.gitignore` 排除），只在本地可见 |
| [audits/CODE_AUDIT_2026-09-20.md](audits/CODE_AUDIT_2026-09-20.md) | 同日较早的代码体检（P0/P1/P2/P3 清单与实现细节、指标统计：monolith 度量、重复代码盘点） | ⚠️ **多数已修**：修复状态以 AUDIT_FIXES 为准；本文的实现细节与度量仍有参考价值（2026-09-20 补登进索引） |
| [audits/AUDIT_REPORT_2026-09-20.md](audits/AUDIT_REPORT_2026-09-20.md) | 全项目体检：四条独立审计线（状态机与重连、安全边界、健壮性与资源、配置/脚本/文档一致性）+ 按影响排序的修复 | ✅ 结论仍有效（取代 2026-09-18 那份） |
| [audits/CONSOLE_FEATURES_REPORT.md](audits/CONSOLE_FEATURES_REPORT.md) | 控制台功能增强：人格管理、两层提示词（仿真层/人格层）、DSH 思考强度 | ✅ |
| [audits/CONSOLE_UI_REDESIGN_REPORT.md](audits/CONSOLE_UI_REDESIGN_REPORT.md) | 控制台改版报告：九页导航 + 全局搜索 + 浅色/深色主题，纯前端改造 | ⚠️ 页数已增至 10（新增「令牌与花费」），其余仍有效 |
| [audits/TOKEN_OPTIMIZATION.md](audits/TOKEN_OPTIMIZATION.md) | `reserved2` 的 token 开销优化与消息水位协议、升级与回退说明（README 直接引用它） | ✅ |
| [audits/TOKEN_COST_ANALYSIS.md](audits/TOKEN_COST_ANALYSIS.md) | token 成本实测档案与优化清单（含本文档形成时的个人用量数据） | ⚠️ 数据是当时的实测快照；结论方向仍被 TOKEN_OPTIMIZATION 引用，具体数字别当现值 |

## legacy/ —— 历史归档（**不要照着做**，留作背景与追溯）

| 文档 | 一句话说明 | 为什么归档 |
| --- | --- | --- |
| [legacy/PROJECT_GUIDE.public-condensed.md](legacy/PROJECT_GUIDE.public-condensed.md) | 面向公开仓库的**精简版**项目说明书（约 375 行、10 节，末行自述「公开版文档，不包含本地开发历史与个人配置」） | 🗄️ **被 `guides/PROJECT_GUIDE.md` 取代**：内容更全的那份一直持续更新到 2026-09-11（新增「近期更新」章节到第 25 节），精简版只覆盖到早期的 10 节；两份同名文档并存正是「界面叫法不同步」的来源（见 CONSOLE_UI_REDESIGN_REPORT 第 6 条）。**未删除**，保留以便需要对外发布脱敏版时取用 |
| [legacy/AUDIT_REPORT_2026-09-18.md](legacy/AUDIT_REPORT_2026-09-18.md) | 2026-09-18 的架构审查与修复报告（基线 `3c54e6b`，P0~P3 清单） | 🗄️ **被 `audits/AUDIT_REPORT_2026-09-20.md` 取代**：后者是对同一代码库的更新一轮体检，并已覆盖前者的待办 |
| [legacy/ARCH_REVIEW.md](legacy/ARCH_REVIEW.md) | 2026-08-18 的架构审查：严重 #1~#6、中等 #7~#15、轻微 #16~#20、新增 #21~#30 | 🗄️ **问题已全部修复**：文首两份「修复状态」清单逐条标 ✅（含复查残留项），属已结案的历史记录 |

---

## 想找什么 → 去哪看

| 我想…… | 看这个 |
| --- | --- |
| 搞懂整体架构 / 全部配置项 | [guides/PROJECT_GUIDE.md](guides/PROJECT_GUIDE.md) |
| 在新设备上把 qq-bridge 接进 DSH | [guides/DSH_SETUP.md](guides/DSH_SETUP.md) |
| 发语音 / 换 QQ 账号后语音工具 401 | [guides/VOICE.md](guides/VOICE.md)（独立工具在仓库上一级 `../voice-tool/`） |
| 看 AI 烧了多少钱 / 计价口径 | [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md)、[audits/TOKEN_COST_ANALYSIS.md](audits/TOKEN_COST_ANALYSIS.md) |
| 改控制台界面并做离线回归 | [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md)、[audits/CONSOLE_UI_REDESIGN_REPORT.md](audits/CONSOLE_UI_REDESIGN_REPORT.md) |
| 改代码前先知道有哪些坑 | [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md)（最新，DSH 适配）、[audits/AUDIT_FIXES_2026-09-20.md](audits/AUDIT_FIXES_2026-09-20.md)、[audits/AUDIT_REPORT_2026-09-20.md](audits/AUDIT_REPORT_2026-09-20.md) |
| 动安全相关代码 / 做发布前检查 | [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) |
| 知道某个目录/脚本是干什么的 | [FOLDER_MAP.md](FOLDER_MAP.md) |
| 权限边界与安全承诺 | [../RULES.md](../RULES.md) |
| 这个项目要往哪走（QSH） | 上位目录的 `../../QSH-plan/`（总索引 `README.md`；另有工具面/技能/云部署/新仓库与官网四份专项） |
