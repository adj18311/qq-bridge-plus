# xhh-quota-guard（路线 B 授权门禁插件骨架）

> **状态：仓库副本未安装；本机 desktop profile 已配置旧副本（未验证安全）。**
> 本目录是可离线测试的插件源码，**不是**当前机器实际加载的版本：仓库副本没有被复制为正式安装版。
> 但已检测到本机 `C:\Users\user\.dsh\profiles\desktop\cordis.patch.yml:200-206`（resolved
> `cordis.yml:1815-1822`）引用旧安装副本 `C:\Users\user\.dsh\plugins\xhh-quota-guard\index.mjs`
> （305 行，mtime 2026-10-26 08:12，`enabled:true`）。旧副本是 task-108 之前的代码：配置失效时
> **零注册**，不具备本文描述的 fallback fail-closed。当前 DSH 进程是否已加载旧副本未能证实；
> **下一次 reload/restart 必然加载旧代码**。替换该安装副本并做真机验证属于独立安装任务，
> **本次未执行，需用户明确批准**；在替换并验证前，不得对外宣称 fail-closed 已部署生效。
> 安装步骤写在文末，仅供参考，**当前没有执行**。
>
> **task-108 修正后的 fail-closed 语义**：`enabled` 非 `true`、配置非法、client 构造失败或
> 初始化异常时，插件**不再“零注册”**；它会保持 fallback 模式并注册 `tools/execute` 门：
> **所有** `mcp__xiaoheihe__*`（读/写/登录/未知）都在 **dispatch 前拒绝**。
> 插件失效时无法向授权服务确认读取额度、`accessPaused`、登录失效/验证码暂停，因此只读工具
> 也不能放行；真正的只读模式（管理员 `readOnly`）走 active 路径，读取规则保持不变。
> `apply()` 不会因配置错误抛错（抛错可能导致 loader 卸载钩子，反而回到“无门禁”）。

## 它做什么（B4 execute-first）

把 DSH 的 `mcp__xiaoheihe__*` 工具调用作为**唯一权威异步门**处理：

0. **fallback 状态（task-108 新增，2026-10-26 修正）**：`apply()` 一开始就注册 `tools/execute` 并在
   `mode='fallback'` 下工作。此时**不调用授权服务**（无网络请求）：
   - 非 `mcp__xiaoheihe__*` 工具 → `next()`（不干预）；
   - **所有** `mcp__xiaoheihe__*` 工具（读/写/登录/未知）→ 返回 isError（固定原因
     `fail-closed-no-authorization`）且**绝不 next**。插件失效时无法确认读取额度、`accessPaused`、
     登录失效/验证码暂停，所以只读也不能放行；真正的只读模式（管理员 `readOnly`）走 active 路径。
   配置合法且 `enabled===true` 时才切换到下面的 active 流程；active 行为与加固前一致。
   配置合法且 `enabled===true` 时才切换到下面的 active 流程；active 行为与加固前一致。

1. `tools/execute`（around-dispatch，dispatch 前）：
   - 仅当工具名以 `mcp__xiaoheihe__` 开头；`agentKey = exec.agent?.id ?? exec.agent?.session?.id`；
   - `await authorize({agentKey, tool, args, now})`（**reserve，不计数**）；
   - deny / 超时 / 异常 / 缺 agentKey → 返回合法 `ToolExecutionResult`（`isError` + `Error: <reason>`），**不调用 next**，dispatch 不执行；
   - allow → `await commit({ticket, agentKey})`（**started 才计数/落盘**）；commit 失败（含 HTTP 200 `{ok:false,reason}`）→ 返回 isError，不 next；
   - 调 `next()`；若结果/错误码是已知 pre-dispatch 中止（`ABORTED_BEFORE_DISPATCH` / `UNKNOWN_TOOL`）→ `abort` 回滚；否则 `complete({outcome})`；
   - 用户例外（authorize `exemption:"user"` 且无票据/exempt ticket）→ 直接 `next()`，不 commit/complete。
2. `tools/post-execute`：只做兜底 finish（execute 已 finish 时不重复；同一 exec 只 complete 一次）。
   **已知限制**：execute 内 `complete` 失败只告警、不重试（post 不会补一次）；若需要“complete 失败可补”，
   需让 `finishTicket` 返回成功标志并由 post 重试（当前未实现，见下方已知限制）。
3. `tools.guard`（可选）：同步 fail-closed 预检（如缺 agentKey 时 deny），**不承担异步授权**。

它**不**注册工具、不发 QQ、不读写 `config/state`、不实现额度逻辑（额度权威在桥接 controller），
也不包含自动安装/自动改 profile 的代码。

### 写操作 operationId（内部元数据）与业务失败映射（临时）

- **operationId 是授权层内部元数据**：真实小黑盒写工具（publish_content/publish_article/publish_video/post_comment/reply_comment）schema **不包含** `operationId`；插件对后台写操作生成内部 UUID，只注入发给 `authorize`/`commit` 的 args 副本，**不修改 `exec.arguments` 和真实工具参数**。用户豁免（exemption:user）不需要 opId。
- **业务失败三态映射（临时）**：小黑盒可能用普通文本返回错误而不设 `IsError`。明确的 `❌ …失败: Timeout Nms exceeded` 回执判为 unknown：平台写入结果不明，不自动重发、不回滚已派发的写额度；其他已知业务失败标记或 `isError===true` 判为 failure，其余判为 success。正文只是讨论超时，不视作超时回执。此映射依赖当前服务端文本格式；服务版本变化需重验。

## 配置

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `false` | 只有显式 `true` 才进入 active 授权流程；其余值/非法配置进入 **fail-closed 模式**（所有小黑盒工具，含只读，均在 dispatch 前被拒） |
| `authorize` | function | — | `({agentKey, tool, args, now}) => Promise<authorizeResult>`（reserve） |
| `commit` | function | — | `({ticket, agentKey, now}) => Promise<commitResult>`（started 才计数；HTTP 200 业务拒绝按 body.ok 判断） |
| `abort` | function | — | `({ticket, agentKey, now}) => Promise<abortResult>`（pre-dispatch 中止回滚） |
| `complete` | function | — | `({ticket, outcome, now}) => Promise<completeResult>`（只接受 started；execute-first 注入时 authorize/commit/abort/complete 都必填） |
| `bridgeUrl` | string | — | HTTP 模式：请求 `${bridgeUrl}/authorize`、`${bridgeUrl}/commit`、`${bridgeUrl}/abort`、`${bridgeUrl}/complete` |
| `consoleToken` | string | — | HTTP 模式必填；**与 bridge `backgroundPatrol.authorizeToken` 是同一个独立授权秘密（同一串值），不是控制台管理 token（`config.json` 的 `consoleToken`）**。不要写进示例/日志/提交；仅允许 `http://127.0.0.1`，拒绝重定向 |
| `timeoutMs` | integer | `800` | authorize/commit/abort/complete 或注入函数的总截止；只允许 **500–1000** |
| `agentKeyResolver` | function | — | `(exec) => string`；缺省 `exec.agent?.id ?? exec.agent?.session?.id` |
| `backgroundSessionKeys` | string[] | `[]` | 仅供本地分类排查；是否豁免由桥接 authorize 决定 |
| `userExemptAgents` | string[] | `[]` | 同上 |

返回契约与 `src/core/xiaoheihe-authorize-api.mjs` 一致：authorize=reserve；commit=started；
abort=释放/回滚；complete 只接受 started。插件只认 `decision`/`ticket`/`ok`/`started`，不解释额度。

## DSH 钩子契约取证（安装版 0.2.1-rc.2）

`D:\DSH Desktop\resources\app.asar` 不是目录，取证时用只读临时脚本解析其 header 并提取源码到
`%TEMP%\dsh-asar-取证`（未修改 DSH、未安装、未重启）。以下行号对应该提取副本：

| 证据 | 位置 | 结论 |
|---|---|---|
| pre-execute 调用点 | `dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js:3321` | `ctx.waterfall(carrier, "tools/pre-execute", exec, () => ({kind:"allow"}))` → listener 形状 `(exec, next)`，默认放行 |
| deny/ask/cancel 物化 | 同上 `:3336-3350` | `{kind:"deny", reason, info?}` → 模型看到 `Error: <reason>`；`{kind:"ask", reason, displayReason?}`；`{kind:"cancel"}` → ABORTED_BEFORE_DISPATCH |
| ToolExecution 字段 | 同上 `:3227-3252` | `name / arguments / agent / signal / callId / rootCallId / parent / token`（args 冻结，pre-execute 不得改写） |
| post-execute 调用点 | 同上 `:3598-3620` | listener `(exec, result, next)`；决策 `accept`（可带 `content`/`value`/`additionalContexts`）或 `block({feedback})`；默认 `{kind:"accept"}` |
| 插件示例（同步） | `dsh-tool-jobs/lib/index.js:235` | `ctx.on("tools/pre-execute", (exec, next) => { ...; return next(); })` |
| 插件示例（async + deny/ask/cancel） | `dsh-experimental-auto-review/lib/index.js:443-500` | async listener 合法；`ask`/`failed`/`denied` 返回形状可直接复用 |
| exec.agent 身份 | `dsh-agent/lib/index.js:243`；`dsh-session/lib/types/index.js:421-426` | `agent.session.id` 即会话身份（`Session#id = header.id`），用于默认 `agentKeyResolver` |

补充：`dsh-tools/README.md:89/109/141` 说明固定流水线
`pre-execute → guards → dispatch → post-execute → finalizeContent → result`；
`tools/pre-execute` 是 reorderable allow/deny/ask gate，`tools.guard()` 是单调 guard。

## 已知限制（execute-first 剩余风险 + fallback 边界，必须如实告知）

0. **task-108 覆盖边界（插件内无法解决的部分）**：
   - **未加载 / loader 拒绝激活**：插件文件不存在、profile 未引用、DSH loader 报错拒绝加载时，
     `tools/execute` 门不存在，本插件**无法在插件内拦截**；这需要 profile 侧约束或 XhhMCP 侧
     只读开关（本次**未实施**，需另立任务，改动正式 profile/XhhMCP 前必须获授权）。
   - **不封堵本机其他客户端**：本插件只约束 DSH 内经 `tools/execute` 的调用；其他进程直接访问
     XhhMCP / 平台不经过 DSH，**不在本插件范围内，也不得声称已封堵**。
   - **server 改名/换命名空间**：门禁按 `mcp__xiaoheihe__*` 前缀识别；若 profile 把 server 改成
     其他名字/命名空间，工具不再匹配而直通（不在插件范围；profile 必须固定为 `xiaoheihe`）。
   - **fallback 不区分读/写**：所有小黑盒工具都拒绝；未来新增工具同样拒绝（安全方向，但会误拒，
     且需要 profile/XhhMCP 侧另行提供可用性方案）。
   - **fallback 期间不计数/不审计**：拒绝发生在本地，未调用 authorize/commit，因此这些被拒调用
     不会出现在额度审计里；这是“不可用即拒绝”的代价，不能解释为“读已计数但被拒”。
1. **later execute veto（阻断②残余）**：本插件在 `tools/execute` 里 commit 后调用 `next()`；**更晚**注册的
   execute listener 若不 `next()` 直接返回结果，dispatch 会被跳过，但本插件按“结果不是已知 pre-dispatch 码”
   仍会 finish（可能“未执行但已计数”）。这是 waterfall 契约的固有缺口；缓解是尽量后置加载/顺序策略，
   彻底解决需 DSH 新增 `bodyInvoked` 或非 waterfall 异步授权钩子。composition 测试固定记录该行为。
2. **earlier execute veto（安全方向）**：更早注册的 execute listener 可直接返回结果 → 本插件与 dispatch
   都不执行（不会无授权执行，但也不会授权/计数）；依赖加载顺序，不能保证本插件总被调用。
3. **earlier pre-execute allow 短路不再导致无授权执行**：授权已移入 execute；但 pre-execute 仍可因其他
   插件 deny 而让 execute 不运行（正常策略拒绝，不计额度）。
4. **post 短路可跳过完成兜底**：更早的 post-execute listener 不 `next()` 时，execute 内已经 finish，
   因此不影响本插件；但若 execute 内在 `next()` 抛异常等极端路径，post 兜底可能被跳过（有告警/对账需求）。
5. **complete 透传 agentKey**：execute-first 的 complete 已带 `agentKey`（bridge route 接受并审计）；
   是否强制绑定校验仍由桥接 controller/route 决定，插件只透传。
6. **注册顺序未承诺**：插件未 `prepend`；HMR/重复 `apply()` 的幂等由 DSH fiber 生命周期保证，插件未额外做
   `applied` 标记；手工重复 apply 可能重复注册（测试 harness 需自行 dispose）。任务 108 的 fallback
   不改变这一点：重复 apply 仍是重复注册，由 loader 生命周期兜底。
7. **未与真实 DSH 集成验证**：execute-first / fallback 契约来自源码取证 + 离线 fake ctx/waterfall；
   首次真机安装需另立任务（验证“配置非法时日志告警 + 写工具被拒”的真机行为）。
8. **released/abort 语义**：仅已知 pre-dispatch 码/异常才 abort；第三方自定义 veto 结果无法识别（见 1）。

## 安装步骤（**当前未执行**）

1. 把本目录复制到 profile 可加载的位置（例如 profile 的插件目录，或保留仓库路径）；
2. 在目标 profile 的 `cordis.patch.yml` **手工**追加一行（示例，非自动脚本）：
   ```yaml
   - xhh-quota-guard:
       enabled: true
       bridgeUrl: http://127.0.0.1:<bridge-port>/api/xiaoheihe
       consoleToken: <通过安全配置注入，不要填写真实令牌>
       timeoutMs: 800
       agentKeyResolver: (exec) => exec.agent?.session?.id
   ```
   （实际 row 名称/路径取决于 DSH profile 的插件加载约定；**本次没有写任何 profile**。）
   **令牌说明**：上面 `consoleToken` 与 bridge `config.json` 的
   `backgroundPatrol.authorizeToken` 必须填**同一个独立授权秘密**（同一串 32+ 字符 token）；
   它不是控制台管理 token（`config.json` 的 `consoleToken`），不要复用/混淆两者。
3. reload DSH 使配置生效；**验证 fallback**：先把 `enabled` 设为 `false`（或临时填错配置）加载插件，
   确认日志出现 `xhh-quota-guard: 未取得有效授权配置，已进入 fail-closed 模式`，且此时
   `publish_content` **和 `search_content` 等只读工具**都被拒绝（isError、无 dispatch）。
   确认通过后再改为 `true` 进入 active。
   （旧文档曾写“enabled:false 不注册钩子”，task-108 后**不再成立**。）
4. 桥接侧需实现 `POST /api/xiaoheihe/{authorize,commit,abort,complete}` 四个 loopback 端点
   （复用 `src/core/xiaoheihe-authorize-api.mjs`），并保证 ticket 幂等；B3 的 commit/abort 业务拒绝
   是 HTTP 200 `{ok:false,reason}`，插件按 body.ok 判断。
   注意：`bridgeUrl` 配置到 `/api/xiaoheihe` 为止，插件内部再拼 `/authorize`、`/complete`。

## 回滚

- 从 `cordis.patch.yml` 删除该 row → reload（或重启）
- 或把 `enabled` 改回 `false` → reload；此时**不是“无钩子”**，而是进入 fail-closed 模式：
  **所有**小黑盒工具（含只读）都被拒。若确实要完全移除门禁，必须删除该 row（或删除目录后 reload）。
- 插件不写任何持久状态（ticket 只存在内存 `WeakMap`）
- 目录可直接删除，无迁移/清理步骤

## 未关闭限制 / 风险

### 帖子图片适配器的分发边界

仓库版本还包含帖子详情图片适配器。若后续经过授权部署，`index.mjs`、`decision.mjs`、`post-image-urls.mjs`、`image-content.mjs`、`image-admission.mjs`、`safe-fetch.mjs` 必须作为同一版本完整分发；只替换入口文件会因静态 import 缺文件而导致整个插件无法加载，插件内 fallback 也不会注册。升级前应校验全部文件并保留可恢复的旧版本，不能在活动 Host 上逐个覆盖后假设门禁仍在。`safe-fetch.mjs` 与仓库 `src/safe-fetch.js` 由离线测试验证逐字节相同。此说明不构成部署授权或上线验证。

图片仅从授权成功的帖子详情提取；不携带平台凭据，不跟随重定向。具体上限：**单图 4 MiB、单次合计 8 MiB、最多 10 张、总耗时 20 秒**；合计 8 MiB 是离线保守取舍（原图经 base64 后约 ×1.33 进工具结果，25 MiB 会让单次结果接近 33 MiB），**并不等于已证实的 DSH/模型上限**，真实联调仍需单独验证。未取到的图片会**逐条**说明原因（白名单/重复/数量上限/单张超限/剩余总预算不足/超时/取消/内容不是可识别的图片结构/下载失败），超时与外部取消分别标注、不会混写；失败保留原文并提示。输入地址过多时另有「因输入上限未处理」的汇总说明。可用原图地址沿用现有 `qq_send_image` 权限边界，是否实际能显示仍取决于运行中的模型、宿主和图床。图片检查仅为文件结构检查，并非完整解码；损坏的图像仍可能被模型服务拒绝。取消会阻止 DNS 完成后继续发起 HTTP，并销毁进行中的 HTTP 请求，但已交给系统的 DNS 查询本身可能继续至结束或超时。

- **未与真实 DSH 集成验证**：契约来自源码取证与离线 fake ctx；首次真机安装需另立任务并观察日志。
- 授权端点与 ticket 幂等语义由桥接实现；本插件只转发，不重试、不落审计。
- `agentKey` 可信度依赖 DSH 会话身份与桥接归因（task-40 实验结论）；群友请求与管理员请求的区分不在本插件。
- HTTP 模式下每工具调用多一次 loopback 往返（建议 500–1000ms 超时）；超时/端点不可用会 **deny**，属于有意的 fail-closed。
- 暂停状态（writePaused/accessPaused）由 authorize 端点判定；本插件不做本地暂停缓存，避免与 controller 双权威。
- 处理 `tools/execute`（`tools/result` 不处理）；不做超时重试；配额由 `authorize`(reserve)/`commit` 处理。
