# xhh-tool-watcher（阶段 2B：Cordis 插件，离线候选）

小黑盒 MCP「工具面快照」观察器：读 DSH 宿主工具注册表，当 `mcp__xiaoheihe__*` 工具**连续 3 次可靠缺失**时提示管理员。**只提示，不动作**。

> **这不是守护进程。** 它随 DSH 宿主进程存在而存在、随宿主退出而消失；没有任何独立进程、没有后台服务、不会重启或重连任何东西。

---

## 做什么 / 不做什么

做：

- **定时检查（scheduled，唯一计数/提示路径）**：默认每 **1 分钟** 读一次 `ctx.tools.view(undefined).visible.keys()`；
- **`tools/change` 事件（event，只刷新不计数）**：MCP 重连时 12 个工具会逐个注销/注册、事件秒内连发，因此事件只做一次采样让「恢复」尽快可见，**绝不推进连续计数、绝不发提示**；
- **间隔语义（v2.1，由 2A 判定模块执行）**：`config.intervalMs` 透传给判定模块——距上次*有效* scheduled 不足 `intervalMs/2` 的检查判 `too-soon`（不计数、不提示，避免事件密集时秒内凑满 3 次）；距上次有效检查超过 `intervalMs*2.5` 视为**错过分钟**，连续计数重置为 1；`at` 早于上次有效检查判 `clock-backwards`（不计数、不推进，避免时钟回拨把链路打断）；`too-soon`/`clock-backwards` 会写进 `snapshot().lastReason`，可与「真实缺失」（`missing-tools`）区分；事件采样不刷新「上次有效检查」时间；
- 把以 `XHH_TOOL_NAME_PREFIX`（`mcp__xiaoheihe__`）开头的名字去掉前缀后交给判定模块 `src/core/xhh-tool-surface-decision.mjs`（2A v2）；
- 判定模块返回 `alert:true`（只会由 scheduled 产生）时，先用 `decision.classifyToolSurface({observedNames})` 取缺失清单（`recordToolSurfaceObservation` 的返回体没有 `missing` 字段），调用通知通道 `notify({kind:'registration-lost', message})`——**若返回 Promise 会 `await`**——再用 `decision.noteToolSurfaceDelivery(state,{at,outcome,deliveredAt})` 正式记账：`delivered` 才推进 `lastAlertAt`，`failed/unknown` 只推进 `lastAttemptAt`；
- **通知通道（v2.2，只承认可证明的送达）**：`config.notify` 只用于测试/嵌入注入；生产用 `notifyUrl` 等键，插件内部用 `notifier.mjs` 的 `createNotifierFromConfig` 构造。
  - **2xx 不等于送达**：契约表里**只有 `none`**（默认），它恒判不满足 ⇒ 任何 2xx（含 `{ok:true}`、`{}`、`null`、`[]`、`{accepted:true}`）都只能是 `unknown`。**当前版本不存在能产出 `delivered` 的配置。**
  - 历史上打算提供的 `bridge-send-v1` 判据（2xx + `ok===true` + 整数 `sent>=1` + `failed===0`，`sent` 只在 `onebotSend()` 拿到 OneBot `status:'ok'`/`retcode:0` 后才 +1）已**下线为不可配置**：`/api/send/*` 还要求 body 里带 `token` 与 `userId/groupId`，而 YAML 无法构造该 body、把 `consoleToken` 写进插件配置又等于把管理员凭据交给被监控的智能体。该判据现由 `verifyBridgeSendV1Receipt()` 保留为「未来专用端点」的常量与测试目标。
  - 2xx + `{ok:false}` → `failed`；4xx → `failed`；5xx / 网络 / 超时 / 非 JSON / 空体 / 超 64KB → `unknown`。
  - 超时覆盖整次请求 + 响应体读取（`response.text()` 挂起也会按时返回）。
  - **运维后果**：在出现「bridge 侧持有凭据、只返回发送回执」的专用端点之前，watcher 只会有 `unknown/failed`，因此会**每 15 分钟重试一次提示**，且永远不会推进 6 小时「已送达」节流（刻意：宁可不打扰，也不谎报送达）。
- `snapshot()` 暴露 `{state, lastReason, consecutiveMisses, lastAlertAt, hasAlerted, attempted, lastAttemptAt, lastAttemptOutcome, failureRetryMs, intervalMs, notifyConfigured, decisionLoadError}`：`lastAlertAt`/`lastAttemptAt` 对外统一为 `null`（从未发生）或毫秒时间戳，`hasAlerted` 是布尔，`attempted` 表示「本轮尝试了提示」（不等于送达），`notifyConfigured` 表示是否配置了可用通知通道（不暴露 URL/token）；
- 可选把状态快照落盘（仅当显式配置 `statePath`）。

不做：

- ❌ 不重启、不重连、不调用小黑盒 / QQ / 任何平台接口；
- ❌ 不写 `config.json` / `state/` / 凭据（除非显式配置 `statePath` 指向一个本地文件）；
- ❌ 不自动改配置、不“自愈”、不做任何写动作；
- ❌ 不覆盖 scope 局部注册与 `restrict()` 遮蔽名（见「边界」）。

---

## 为什么需要它

DSH 的 MCP 客户端在重连耗尽后会注销全部工具；此时智能体看不到 `mcp__xiaoheihe__*`，但服务端可能完全正常。本插件提供一个**观察信号**：每分钟一次可靠检查、连续 3 次可靠缺失（约 3 分钟）才提示一次，且同一问题 **6 小时内不重复提示**（由判定模块节流）。是否处理、如何处理，仍由人决定。

---

## 装配（profile 配置键；本仓库**不会**替你写 profile）

profile 的 YAML 里**写不了函数**，因此生产用配置键构造通知通道，`notify` 函数只用于测试/嵌入注入。
可用键（`apply(ctx, config)` 读取）：

| 键 | 含义 |
| --- | --- |
| `intervalMs` | 定时检查间隔，默认 `60000`（1 分钟）；会透传给 2A 判定模块做「太近/太晚」分桶 |
| `statePath` | 可选；状态快照落盘路径（不配则只在内存，重启重置节流窗口） |
| `decisionPath` | 可选；覆盖默认 `../../src/core/xhh-tool-surface-decision.mjs` |
| `notifyUrl` | 可选；HTTP 通知地址（仅 http/https）。配置后插件自动构造 notifier |
| `notifyToken` | 可选；放进请求头，不落日志。默认头名 `x-console-token` |
| `notifyHeaderName` | 可选；覆盖 token 的请求头名 |
| `ownerUserId` | 可选；写进通知 body 的 `ownerUserId` 字段 |
| `notifyTimeoutMs` | 可选；通知超时，默认 5000ms；**覆盖整次请求 + 响应体读取** |
| `notifySuccessContract` | 可选；送达契约 id，默认 `none`。**目前只有 `none` 可配置**；填 `bridge-send-v1` 会装配失败并记 error（原因见上） |
| `notify` | **仅测试/嵌入注入**（函数）；优先于 `notifyUrl` |
| `log` | 可选；`(level, message) => void`（默认写宿主 `ctx.logger`） |
| `scheduler` | 可选（测试注入用），默认 `setInterval + unref` |
| `decision` | 可选；注入判定模块对象（优先于 `decisionPath`，测试/嵌入用） |

示例 YAML（仓库形态）：

```yaml
- insert:
    - id: xhh-tool-watcher
      name: 'file:///D:/qq-bridge/plugins/dsh-xhh-tool-watcher/index.mjs'
      config:
        intervalMs: 60000
        decisionPath: 'D:/qq-bridge/src/core/xhh-tool-surface-decision.mjs'
        statePath: 'D:/qq-bridge/state/xhh-tool-watcher.json'
        # 通知通道（可选；不配则只记状态并 warn，且绝不会有 delivered）
        # notifyUrl: 'http://127.0.0.1:18766/api/console/xhh-notice'
        # 目前不存在能证明「已发送成功」的端点，建议先不接（保持 none）
        # notifyToken: '……'
```

装配行为：
- 两者都没有 → 装配成功，但**记一条 warn**：`未配置可用通知通道（notifyUrl 缺失/非法）…`（不静默、也不失败）。此时若判定出现 `alert:true`，提示会被**跳过**：`attempted` 保持 false、不推进 `lastAlertAt`/`lastAttemptAt`（不会把「没有通道」记成「尝试过未送达」）；
- `notifyUrl` 非法 / `notifySuccessContract` 非字符串 / 契约 id 未知或不可用（如 `bridge-send-v1`）→ **error** 日志 + 视同未配置，不拖垮装配，`snapshot().notifyConfigured=false`；
- `notify` 函数优先于 `notifyUrl`（测试注入不触网）。

> **为什么默认契约是 `none`**：目前仓库里没有「服务端能证明消息已发出」的通用通知端点；把任意 2xx 当送达会把「排队/受理」洗成「已送达」，进而让 6 小时节流与用户看到的状态都失真。要得到真实 `delivered`，需要部署一个由 bridge 侧持有凭据、并返回明确发送回执的通知端点（见接线预案），而不是让插件自己猜 HTTP 语义。

`apply()` 接线的副作用只有：订阅 `tools/change`（event 采样）、注册一个定时器（scheduled 检查）、注册 `dispose` 清理。没有立即执行的首次检查（第一次检查发生在首个间隔或首个 `tools/change`）。

### 安装形态（决定 decisionPath 是否必须）

| 形态 | 行为 |
| --- | --- |
| 放在本仓库 `plugins/dsh-xhh-tool-watcher/`（按仓库 profile 加载） | 默认相对路径可解析到 2A 模块，无需配置 |
| 复制到 `~/.dsh/plugins/` 等仓库外目录 | 默认相对路径**一定**解析不到；必须配置 `decisionPath`（指向 `src/core/xhh-tool-surface-decision.mjs`）或通过 `decision` 注入模块对象 |

装配失败（默认路径不可达 / `decisionPath` 指错 / 注入模块或加载到的模块缺契约 v2 的 `noteToolSurfaceDelivery`）时**不会静默装死**：写 `error` 级日志（含「插件未装配，工具面不会被监测」与可执行修法），`apply()` 返回 `{ok:false, enabled:false, decisionLoadError:{path,message}, snapshot()}`（`snapshot().lastReason='decision-unavailable'`），且不注册任何 `tools/change`/`dispose` 钩子。

**只支持契约 v2**：没有 `noteToolSurfaceDelivery` 的旧判定模块会被当作不可用，工厂直接抛 `TypeError`、装配显式失败并给出原因——不存在 v1 兼容回退分支（否则「事件也会计数」的旧语义会以开关形式残留）。

---

## 测试与离线验证（无网络、无真实定时器）

```bash
node --check plugins/dsh-xhh-tool-watcher/index.mjs
node --check plugins/dsh-xhh-tool-watcher/notifier.mjs
node --test  plugins/dsh-xhh-tool-watcher/index.test.mjs
node --test  plugins/dsh-xhh-tool-watcher/notifier.test.mjs
```

- **49 个插件用例**：连续 3 次缺失只提示 1 次、uncertain 断计数、6h 节流、失败重试、notify 抛错当 unknown、`store.save` 抛错不崩、`readToolNames` 抛错当 uncertain、恢复清零、`apply()` 冒烟（假 ctx + 假 scheduler，**绝不真起定时器**）、真实判定模块集成 3 条、并发 single-flight 3 条、v2 触发契约 10 条、语义字符串优先级 4 条、第四轮复审 5 条，以及 v2.1 的 10 条（间隔分桶 5 条、intervalMs 覆盖 1 条、通知通道装配 4 条）。
- **13 个 notifier 用例**：2xx JSON `ok:true` → `delivered`；2xx `ok:false` → `failed`；2xx 非 JSON → `unknown`；4xx → `failed`；5xx → `unknown`；网络异常 → `unknown`；超时 → `unknown`（且不挂死）；请求头带 token 且 token 不出现在 body；`ownerUserId` 写入 body；`bodyFactory`；非法 URL 抛 `TypeError`；缺 fetch 抛 `TypeError`；响应无 `text/json` 方法 → `unknown`。
- 判定逻辑全部在 2A 模块里；本插件的 fake 判定器只用于把「观测 → 提示」的接线钉死（fake 的 `recordToolSurfaceObservation` **刻意不返回 `missing`**，与真实模块一致，防止掩盖「文案恒 0」；fake 的 `source` 语义与 2A v2 契约一致；v2.1 的间隔语义只在显式 `enforceScheduledGap:true` 时启用，以保持旧用例的时序无关性）。

---

## 判定语义（来自 2A v2，本插件不重复实现）

- `observedNames` 是合法数组 → `present` / `absent`（缺任何一个，含空数组=全缺）；`null`/非数组/非法元素 → `uncertain`；
- 只有 `source='scheduled'` 的 `absent` 才累加 `consecutiveMisses`；`present`/`uncertain` 清零；`source='event'` 的 `absent` 不计数（`counted:false`、`reason='event-not-counted'`）；
- `>=3` 且距 `lastAlertAt >= 6h`（成功节流）且距 `lastAttemptAt >= 15min`（失败重试节流，仅当上次投递为 failed/unknown）才 `alert:true`；
- `noteToolSurfaceDelivery`：`delivered` 才推进 `lastAlertAt`；`failed/unknown` 只推进 `lastAttemptAt`，15 分钟后才允许重试；
- 节流窗口在内存模式（未配 `statePath`）下重启即重置；配置 `statePath` 时随状态持久化。

本插件的接线细节：

1. **工具名去前缀**：注册表里的名字是 `mcp__xiaoheihe__get_home_content`，判定模块的 `XHH_EXPECTED_TOOL_NAMES` 是裸名（`get_home_content`），因此插件先过滤前缀再 `slice`。非前缀工具（如 `mcp__other__*`）直接忽略。
2. **投递记账（只走 v2）**：`alert:true` → `await notify(...)` → `decision.noteToolSurfaceDelivery(state,{at,outcome,deliveredAt})`，不存在 v1 回填分支。
3. 读注册表抛错/非数组 → 按 `uncertain` 处理（断计数、`lastReason='no-observation'`），**绝不**当作「缺失」。
4. **单飞（single-flight）**：`check()` 并发调用复用同一个 in-flight Promise，不另起观测——`tools/change` 在 MCP 重连时会连发（12 个工具逐个注销/注册），若每次各跑一遍会把同一次缺失计成多次、或让 late 的 `recovered` 覆盖挂起中的 `absent`。in-flight 用 `.finally` 清理：成功和抛错都释放，下一次 check 能重新观测；**不用「加锁后丢弃」**，丢弃会丢掉最后一条恢复事件。

---

## 边界与已知局限（务必阅读）

- **注册表视图是「本进程全局层」的快照**：`ctx.tools.view(undefined)` 只反映当前进程全局可见的工具名；**不覆盖** scope 局部注册，**不覆盖**被 `restrict()` 遮蔽/限制的名字。因此本插件可能漏报（工具在 scope 局部注册）或误报（名字被遮蔽但服务端正常）——它只是**提示信号**，不是健康真相。
- **插件无沙箱**：Cordis 插件与宿主同进程同权限；本插件刻意只读注册表 + 可选写一个自选 `statePath` 快照，不碰其它文件。
- **需人工启用**：本次交付**不写**任何 profile/config/state；是否启用、间隔多长、是否接通知，由运维在 profile 里配置。
- **不保证告警送达**：`notify` 由上层提供；失败/未知时 15 分钟后才重试（不是每分钟狂发），成功送达后 6 小时内不重复提示，但不会升级为其它动作。
- **没有立即检查**：启用后第一次检查发生在首个 `tools/change` 或首个间隔。
- **v1 状态文件会被拒**：若 `statePath` 里是旧版（v1）判定模块写下的快照，v2 解析会拒绝它并回落初始态（不迁移、不猜测），只影响节流窗口的连续性。
- **`snapshot().lastReason` 是状态机语义**：它反映「稳定判定」（如 `recovered`/`ok`/`missing-tools`），不暴露 `throttled`/`retry-throttled` 这类「本轮为何没发」的动作原因；要判断节流请用 `lastAlertAt`/`lastAttemptAt`/`lastAttemptOutcome`。

---

## 文件

| 文件 | 说明 |
| --- | --- |
| `index.mjs` | 插件主体：`name` / `inject=['tools']` / `apply(ctx, config)` / 纯工厂 `createToolSurfaceWatcher(...)` |
| `index.test.mjs` | 51 个离线用例（含真实判定模块集成、single-flight、v2 触发契约、v2.1 间隔与通知通道、v2.2「2xx 不等于送达」） |
| `notifier.mjs` | HTTP 通知构造器 `createHttpNotifier(...)` 与 `createNotifierFromConfig(...)`（离线可测，不主动联网） |
| `notifier.test.mjs` | 21 个 notifier 用例（契约真值表、不可证明的 2xx 枚举、完整超时、token 不进日志） |
| `README.md` | 本文档 |

---

## 9. 排障：为什么提示没有送达（当前版本正常行为）

默认契约 `none` 下**永远不会**出现 `delivered`，因此可以预期的观察结果是：

- `snapshot().lastAlertAt === null`、`snapshot().hasAlerted === false`；
- `snapshot().lastAttemptAt` 每 15 分钟推进一次、`snapshot().lastAttemptOutcome === 'unknown'`；
- 日志里源源不断地出现：`通知结果未知：HTTP 200 但未满足送达契约 none（不把「受理」当「送达」）`。

排查时直接搜这两个字符串：

```bash
# 看是否每 15 分钟在尝试、结果是什么
grep -c '未满足送达契约' <日志文件>
# 看是否被服务端明确拒绝（failed）而不是未知
grep '通知被服务端拒绝' <日志文件>
```

当前 `snapshot()` **不提供** `lastAttemptReason`（只有 `lastAttemptOutcome`），因此「究竟为什么 unknown」需要看日志。若后续要加，应限定为白名单枚举串（`timeout` / `http-5xx` / `invalid-json` / `contract-not-satisfied:none` 等，≤ 64 字符）并同步更新测试，不要直接透传底层错误文本。
