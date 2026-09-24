# AUDIT_REPORT_2026-09-20（第二轮：三路并行审计与修复）

> 本文记录 2026-09-20 对 `qq-bridge` v0.1.5 工作树做的**第二轮**审计（在三路并行审计
> 之下完成）以及**已落地的修复**。第一轮是同日较早的
> [CODE_AUDIT_2026-09-20.md](CODE_AUDIT_2026-09-20.md)（该文当时未登记进文档索引，现已补登）。
>
> 状态图例：**已修**（本文件即为修复记录）/ **已确认无问题** / **列为规划**（进入 QSH 里程碑）。

---

## 一、审计范围与方法

| 路线 | 覆盖 | 结论 |
| --- | --- | --- |
| A：桥接内核 | `src/bridge.js` 全 10,348 行、`dsh-client.js`、`safe-fetch.js`、`snowluma-conn.js`、`sensitive.js`、`md-to-plain.js`、`v2-wait.js`、`forward.js`、`role-card.js`、`preset-prompt.js`、`patch-snowluma-sdk.mjs` | 无远程可利用的 CRITICAL/HIGH；授权模型分层且一致 fail-closed |
| B：控制台与打包 | `startConsoleServer()`（2,536–6,211 行）、`public/console.html` 全部 4,852 行、三个 MCP server、两个 agent preset、`qq-tool-restrict.mjs`、`setup-dsh.mjs`、`plugins/qq-mode-console` | 认证模型健全；发现配置相关的**外发通道**、一处**功能完全不可用**、两处**真实 XSS 汇点**、一处**未鉴权且有副作用的 GET** |
| C：文档基线 | README/RULES/PROJECT_GUIDE 全量、design/audits/research、`config.example.json`、`state/*` | 系统梳理出现状与文档漂移，作为 QSH 规划依据 |

方法：完整阅读源码（不抽样）+ 对关键结论用真实模块执行验证（例如直接调用
`presetPromptBlockers` 复现一代预设被锁死）。**审计过程未修改任何文件**；修复在审计
结论出来之后单独进行。

---

## 二、已修复（本轮）

### 安全（按实际可利用性排序）

| # | 问题 | 影响 | 修复 |
| --- | --- | --- | --- |
| B1 | `socialV2.voice.allowAbsolutePath: true` 时，`resolveVoicePathForV2()` 把 AI 给的绝对路径直接交给 `resolveAudioSource` 解析（`bridge.js:1255-1263`） | **HIGH**：群友用提示注入就能让 AI 把本机任意音频（< 20 MB）当语音发到群里。`inspectAudio` 在 ffprobe 不可用或没有音频流时是**放行**的，等于开关本身就是任意文件外发通道 | 新增 `voicePathInsideLibrary()`：即使开了开关，绝对路径也必须落在语音库目录内（先 `path.relative` 判定，再走 `safeJoinLibrary` 的 realpath 复核）。库外文件改用操作者通道（CLI/控制台）。启动时若检测到开关为 true 会明确提示它**已不再放宽 AI 通道** |
| B3 | `public/console.html:3119` 把语音库文件名直接拼进 `innerHTML`（`v.name` / `v.error` / `v.detail` 三处都没转义） | **MEDIUM**：`audio/` 里放一个名为 `x<img src=x onerror=...>.mp3` 的文件即可在控制台执行脚本，窃取 `localStorage.consoleToken`（CSP 允许 `unsafe-inline`，拦不住内联事件处理器） | 三处插值全部走 `esc()` |
| B4 | `public/console.html:4722-4729` 价目表数值/货币符号未转义 | **LOW-MED**：`config.json` 的 `pricing` 覆盖项可注入 | 统一走 `esc()`，数值仍按数字显示 |
| B5 | `GET /api/socialV2/sticker-list?refresh=1` 与 `GET /api/stickers?refresh=1` 会在**读请求**里触发 OneBot 拉取 + 落盘 | **LOW**：绕开"非 GET 必须 JSON + 同源 Origin"的 CSRF 防护（一个 `<img src=...>` 即可触发） | GET 侧不再接受 `refresh`；强制同步改为 `POST /api/socialV2/sticker-list`（MCP 工具 `qq_list_stickers` 已同步改造），控制台走既有 `POST /api/stickers/sync` |
| B8 | 控制台不校验 `Host` 头 | **LOW**（纵深防御）：DNS rebinding 下浏览器会把 `evil.com:3100` 当作同源，Origin 校验随之失效 | 请求最前面校验 Host ∈ {`127.0.0.1`、`localhost`、`[::1]`} + **实际绑定端口**，否则 403 |
| A1 | 控制台令牌用 `!==` 比较（`bridge.js:2637`） | **MEDIUM**（硬化）：`!==` 在首个不同字符处短路，本机进程理论上可逐字节试探 | 改用 `crypto.timingSafeEqual`，比较前先比长度 |
| B10 | `/api/authorize/read` 在 token 为空时**跳过**校验，而该端点对 agent 流量开放 | **LOW**：等于一个免鉴权入口（MCP 的 `agentApi` 总是带真实控制台令牌，所以"不带令牌"这条路本就多余） | 空 token 一律 403；MCP 侧 `authorizeRead()` 改为显式失败，旧只读工具改走模式判定 |
| A2 | `state/` 里的控制台令牌、SnowLuma token、各会话 agentToken、全部 QQ 聊天记录对**本机所有已登录用户可读**（Windows 上 `mode: 0o600` 是空操作，实测 ACL 为 `Authenticated Users:(M)`） | **MEDIUM**：任何能登录本机的人拿到控制台令牌 = 完全控制 | 启动时 `hardenStateDirAcl()`：Windows 用 `icacls` 切断继承链、只保留当前用户/SYSTEM/Administrators；非 Windows 退化为 `chmod 700`；失败**明确告警**而非静默 |
| A3 | DSH launch token 换 Cookie 时必须放进 URL 查询串，却没有限制目标主机 | **MEDIUM**：`dsh.baseUrl` 指向远程时会把**进程启动凭据**交给中途每一环 | `NodeApiClient.ensureAuth()` 默认只允许回环 baseUrl（`127.0.0.0/8`、`localhost`、`::1`），远程部署需显式 `dsh.allowRemote: true`（已加入 `config.example.json`） |
| A4 | `roleRawContent()` 直接拼 `roles/<state 里的角色名>.md`，写入点虽都校验、**读取点没有** | **LOW**（纵深防御）：手工编辑 `state/current-role.json` 为 `../../x` 可让 `roles/` 之外的文件被注入每条提示词 | 读取点补 `sanitizeRoleName` + `path.resolve` 包含性校验 |
| P1-4 | 旧只读工具（`qq_list_groups` / `qq_get_group_members` / `qq_get_group_history`）用**黑名单**方式判模式（`status?.mode === 'reserved2'` 才拒绝），而桥接对"带 agent 令牌"的 `/api/status` 返回的是**不含 mode 字段**的最小对象 | **HIGH**（逻辑失效）：判定恒为假 ⇒ 在二代仿真模式下放行，把白名单群名、群成员名单注入模型上下文 | 改为白名单写法 `legacyReadToolAllowed()`：只有确认 `mode === 'closed-agent'` 才放行，判定失败一律拒绝 |
| P1-5 | MCP 的 `agentApi()` 只看 HTTP 状态，不看 `body.ok` | **HIGH**（静默错误）：桥接用 `200 + {ok:false}` 表达"发送被安全审计拦截"，MCP 却把它当成功上报，模型据此认为消息已发出、不再重试也不告诉用户 | `agentApi()` 增加 `body.ok === false` 判定并抛出真实原因 |
| P1-6 | MCP 里的 `escapeCqText()` / `messageSegments()` 是死代码（无任何调用点） | **LOW**（假安全）：看起来 MCP 侧还有一道 CQ 转义，实际发送全走桥接 | 删除该死代码并留注释说明"出站转义统一由桥接负责"（桥接的 `onebotSend` 确实做了 `{type:'text'}` 包装 + `[CQ:` 转义） |

### 缺陷与健壮性

| # | 问题 | 修复 |
| --- | --- | --- |
| B2 | **控制台完全无法保存/还原一代仿真提示词**：保存与还原共用一份照二代写的硬性不变量清单（`你没有本地工具` 等），而一代预设本来就没有这些表述 ⇒ 一代在控制台 100% 报"缺少安全不变量" | `presetPromptBlockers(content, preset)` 改为**按代次**取清单（`PRESET_BLOCKING_SUBSTRINGS_V1` 取一代文案里真实存在的三条），`renderPresetPromptYaml()` 与还原路径同样按代次传入；新增两条回归测试钉住"两代预设都能通过自己的清单"且"两份清单确实不同" |
| B6 | DSH 插件 `QQ_MODE_DIAG` 用 `__dirname/../../..` 往上爬，插件是以 `link:` 装进 profile 的 ⇒ 在任何非作者机器上都会在用户主目录旁凭空建出 `state/` | 诊断日志改到系统临时目录，支持 `QQ_MODE_DIAG` 覆盖（空字符串=关闭） |
| B7 | `setup-dsh.mjs` 的 patch 备份用 `flag:'wx'`（写一次永不更新 ⇒ 备份会过期）；预设安装副本与 profile `package.json` 被覆盖时**完全没有备份** | 新增 `backupBeforeOverwrite()`：每次覆盖前打时间戳快照并只保留最近 5 份；`copyPreset()` 覆盖前给已安装的 `agent.cordis.yml` 留快照 |
| A5 | 事件流断开重连的 `finally` 清理了 collector / 唤醒租约等，但**没有清 `activeWaits`** ⇒ 长轮询租约残留会用 429 卡住该会话最长 15 分钟 | `pumpMux()` 的 `finally` 补 `activeWaits.clear()` |
| A6 | 按会话 key 记账的内存态（`lastSendFailed` / `queuedHintAt` / 限流时间戳 / `wakeConfig*`）在四条撤销路径上各清一部分，**没有统一出口** ⇒ 被移出白名单的会话会留下有界但真实的慢性残留 | 抽出 `forgetConversationCaches(key)`，在 `retireSession()` 里调用（且**有映射和无映射时都清**） |
| A9 | 未配置 `ownerQQ` 时，审批/管理命令/封闭 agent **静默失灵**，排查时无从下手 | 启动日志新增明确告警 |
| A10 | `POST /api/restart` 直接 `process.exit(0)`，不像 SIGINT/SIGTERM 那样先落盘 ⇒ 500 ms 窗口内的状态变更丢失 | 退出前 `saveState()` + `saveSocialV2State()`（各自 try/catch） |

### 2026-09-21 追加：修掉一个**随时段变红**的回归测试（真实缺陷）

| 项 | 内容 |
| --- | --- |
| 现象 | `test-token-usage.mjs` 报 `❌ 花费 = 基线 + 增量，实得 0.01080000 期望 0.00940000`（同一份代码数小时前还是 27/27 全绿） |
| 定位 | 该测试的事件**不带 `time`**，账本对无时间戳采样回退到 `now()`；`now()` 落在**高峰时段**（周一至周五 9:00–12:00、14:00–18:00）时单价为 **2 倍**，而测试的期望值是按**空闲档**手算的 ⇒ **只要在高峰时段跑就必然失败**。实测：周一 17:29 失败、当日 12:00–16:00 通过 |
| 证据 | ① 用 `costOfBuckets` 单独核算同组桶得 0.0094（正确）；② 用固定时间戳重放同一事件序列也得 0.0094 ⇒ **生产代码的计价是对的，是测试不确定** |
| 修复 | 给测试的事件辅助函数 `evMsg` / `evRetry`（以及一处裸 `assistant/attempt`）**显式加上 `time: at`**（`at` = 周一 20:00 空闲档），让期望值与"跑测试的时刻"无关 |
| 影响面 | 已全量扫描 `scripts/test-*.mjs`，确认没有其它同类写法（余下一处是纯函数断言，不受影响） |
| 为什么值得记 | ① 它**随时段随机变红**，会让人误以为代码坏了、浪费排查时间；② 它正好卡在 M0 的出口条件（"27/27 全绿"）上——若在高峰时段收尾，会被误判成"没做完"；③ 教训：**回归测试里的时间必须显式注入**（已写进该测试的注释） |

修复后 `npm run test:audit` **27/27 全绿**，且结果不再依赖跑测试的时刻。

### 测试与工程

- 新增回归：控制台传输层防护（伪造 Host / 错令牌 / 空令牌 authorize）、语音库路径约束（含 `allowAbsolutePath=true` 与相对穿越）、MCP `ok:false` 上报、旧只读工具 fail-closed、非回环 baseUrl 拒绝、两代预设各自的不变量清单。
- 修正测试夹具：`test-audit-protocol.mjs` 原先用 `http://dsh.invalid`（现在会被新的回环闸门拦下），改为回环地址，并新增一条断言验证该闸门本身。
- **`npm run test:audit`：27/27 全绿**（修复前 27/27；期间因新闸门导致 4 个脚本红过，已定位为夹具问题而非回归）。

### 收尾（第二轮，用户批准后执行）

| # | 事项 | 结果 |
| --- | --- | --- |
| A2-followup | A2 的 ACL 修复在**未提权的普通用户**下会失败（改 ACL 需要 WRITE_DAC）。原来只在日志里给一句警告，用户很难照做 | 新增 **`scripts/harden-state-acl.mjs`**：① 先直接尝试（目录属主正常就有权限，因此**通常不弹 UAC**）；② 失败才用 `Start-Process -Verb RunAs` 提权重试一次，`--elevated` 标记短路自身以**结构上杜绝递归**；③ 再失败就打印一条可复制的命令；④ **任何失败路径都以 0 退出**，绝不阻断桥接启动。`start.bat` 在启动桥接前调用它（`--quiet`）。控制台「访问与安全」页同步增加告警条与「重新检测」按钮。 |
| 测试诚实性 | 这个环境（沙箱）**禁止修改 ACL**，所以 `icacls`/UAC 的真实行为无法在此验证 | 明确**不假装测过**：只在 `test-audit-setup-guards.mjs` 里钉住"不会骗人"的结构与编码事实——助手存在、含 `icacls`/`/inheritance:r`/`--elevated`/`isHardened`、**不得以非 0 退出**、提权重试被标记短路、`start.bat` 纯 ASCII + CRLF + 助手排在桥接启动之前。真实行为需在普通终端复跑验证。 |
| `start.bat` 编码 | 编辑过程中该文件一度变成 UTF-8 + LF（中文注释 + 换行归一化） | 已还原为**纯 ASCII + CRLF + 无 BOM**，并加了回归断言，避免以后再被改坏（`cmd` 在非 UTF-8 控制台下会把非 ASCII 按 ANSI 解码成乱码） |
| preset 同步 | `verify:adaptation` 报 2 处失败：仓库 `qq-chat-v2` 与 `~/.dsh` 安装副本不一致（未提交改动尚未同步） | 跑 `node scripts/setup-dsh.mjs` 同步（**覆盖前已自动备份**安装副本，见 B7 的修复）。**`verify:adaptation` 现为 55/55 全绿**。注意：preset/MCP 改动要**重启 DSH** 才真正生效（未擅自重启） |

---

## 三、已确认无问题（不要重复审计）

1. **绑定与令牌门**：控制台只 `listen('127.0.0.1')`；单一令牌门覆盖**所有**路由（含读），位于 favicon 204 之后、任何业务分支之前。
2. **CSRF**：所有非 GET 必须 `application/json`，且若带 `Origin` 必须是本机 host；不输出任何 CORS 头。
3. **agent 令牌是"额外限制"而非"替代凭证"**：MCP 同时携带控制台令牌与 agent 令牌；桥接另有 agent 路径白名单、管理端点黑名单、贴纸库禁令、`reserved2` 限制、暂停/开关门，以及空 token 拒绝。48 条 `/api/...` 路由逐条核对过。
4. **发送通道白名单全覆盖**：文本 / burst / 统一发送 / 拍一拍（含实时群成员校验，fail-closed）/ 贴纸 / 语音 / 转发媒体；`resolveReplyTargetV2` 会做真实的跨会话归属校验。
5. **无任意本地文件读取**：图片走 `isSafeLocalMediaPath`（realpath 限制在 SnowLuma home 内，未配置 homeDir 时返回 false）；贴纸走本地库；其余外发走 `safe-fetch.js`。
6. **`safe-fetch.js` 的 SSRF 防护是完整的**：scheme 白名单、拒绝 URL 凭据、每一个 DNS 结果都校验、**连接已校验的 IP 同时保留 Host/SNI**（关闭 rebinding 间隙）、逐跳重定向重校验、响应体大小与像素上限、magic number 校验、不读代理环境变量。
7. **预设 fail-closed**：`ensureSession()` 在严格预设解析为空时**拒绝**建会话，且只有 `closed-agent` 允许无预设重试；`reconcileSessionPolicies()` 在 preset 清单为空时不做退役判定（防止一次网络抖动导致全体群会话失忆）。
8. **`qq-tool-restrict.mjs` 不可绕过**：精确匹配白名单 + 三条 MCP 前缀，无任何归一化环节可供别名/大小写/前缀利用；两份预设副本字节一致。
9. **原型污染与注入**：配置合并用对象展开（不触发 `__proto__` setter）；记忆键在写入与加载两侧拒绝 `__proto__`/`constructor`/`prototype`；唯一的进程 spawn 是 `execFileSync('netstat'|'sh', [参数数组])`，无插值、无 shell。
10. **路径与人格处理**：`validateRoleName` 拦路径分隔符/`..`/Windows 设备名；`resolvePresetName` 把输入收敛到 2 元素集合；预设还原要求文件名来自 `listPresetBackups()` 并重跑不变量校验。
11. **定时器生命周期**：`clearSocialV2Timers` 覆盖四个按会话定时器，并在退役、两条模式切换、两种重置、暂停路径上都被调用；所有 `setInterval` 都 `unref()`。
12. **控制台转义纪律**：`esc()` 覆盖 `& < > " '`；枚举过的 30 处数据驱动 `innerHTML` 中，除本轮修掉的两处外全部使用了 `esc()` / `textContent` / `createElement`。

---

## 四、列为规划（不阻塞当前版本）

| 项 | 去向 |
| --- | --- |
| 控制台令牌明文存于 `state/`、以 `localStorage` 承载、`?token=` 会进历史记录 | QSH M2：口令 `scrypt` 派生 + HttpOnly/SameSite Cookie + 一次性引导链接 |
| 贴纸备注跨会话共享（R3） | QSH：如需多群互害模型，改为按会话隔离 |
| `self-test.js` 无断言（R7） | QSH M0：要么加断言，要么在文档里明确它只是连通性探针 |
| 文档漂移（控制台页数 10 vs 9、回归计数 15/18/20/21、MCP 工具数 35+1+2 vs 41 vs 38、PROJECT_GUIDE 页脚版本） | QSH M0：以代码为准统一，并把 `CODE_AUDIT_2026-09-20.md` 补进文档索引（本轮已补） |
| 巨石架构（`bridge.js` 10.4k 行、`main()` 占 89 %、`startConsoleServer()` 3.7k 行/100 路由、28 处手写鉴权守卫） | QSH M5：按 core / modes / console 拆分 |
| 无 lint / typecheck、`src/*.bak-*` 残留 | QSH M0：加 ESLint（`no-floating-promises` 等）与语法门禁；清理残留文件 |

---

## 五、复核方式

```bash
cd qq-bridge
npm run test:audit         # 27/27，含本轮新增的安全回归
npm run verify:adaptation
npm run verify:persona
```

安全边界与改动检查单见 [../guides/SECURITY_BASELINE.md](../guides/SECURITY_BASELINE.md)。
