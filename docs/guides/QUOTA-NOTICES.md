# 额度不足提醒（QUOTA-NOTICES）

## 一、功能定位

- 仅针对**已证实**的余额/额度耗尽；普通 429 限流、鉴权失败、服务繁忙等都不属于本规则。
- 事件驱动：不设定时器、不做模型请求重放、不主动探测余额。
- 通知文案固定为：`当前模型额度不足，请切换模型`

## 二、判定标准

- 识别结构化错误码：`insufficient_quota`、`insufficient_balance`、`credit_balance_too_low`、`quota_exceeded`、`billing_hard_limit_reached`、`usage_limit_exceeded`、`coding_plan_exhausted`。
- 识别明确的英文/中文耗尽描述。
- 仅解析错误包装字段 `error` / `message` / `cause`，不读取 request、headers、prompt。
- 一律为 false：裸 `quota`、`quota_limit`、token 计数、`insufficient permissions`、普通 429、繁忙 529/503。
- v1 中显式 401/403 始终为 false（含 billing 类 403）。
- 分类结果仅 `{ exhausted, reason }`，不返回原始输入。

## 三、通知频率

- 维度：每个 QQ 会话 + 每个 provider/model（不含 effort）。
- 首次触发：立即发送。
- 之后：必须出现新的终态错误，且距上次通知 ≥ 600000ms（10 分钟），每个 incident 最多 3 次。
- 真实成功恢复后 incident 结束、次数归零，重新按首次立即处理。

## 四、模型切换与恢复

- 切换到其它模型：旧排队通知取消，不计为已发。
- 切走再切回：不重置次数与间隔。
- 只有真实 live 的 assistant/message 成功消息才恢复重置；`interrupted: true` 的中止部分输出不算恢复。
- 快照（snapshot）、工具结果、仅 completed 状态都不恢复。
- 选择（selection）变化会使队列中的旧通知失效。
- `recover` 只移除对应 provider/model 精确桶，并取消其 pending。

## 五、模块职责

| 文件 | 职责 |
| --- | --- |
| `src/quota-error.js` | 纯函数分类器，导出 `classifyQuotaError(failure)` |
| `src/quota-notice.js` | 纯策略：计数、间隔、上限、恢复；时钟与读写全部注入 |
| `src/quota-notice-runtime.js` | 事件生命周期与发送队列协调 |
| `src/bridge.js` | 仅适配与挂事件钩子，不含策略逻辑 |

## 六、策略模块 API

- 常量：`QUOTA_NOTICE_TEXT`、`QUOTA_NOTICE_INTERVAL_MS = 600000`、`QUOTA_NOTICE_LIMIT = 3`。
- 构造：`createQuotaNotice({ now, load, save, log, maxEntries })`，读写同步注入。
- 方法：`reserve(key, { provider, model })` 返回 ticket 或 null；`begin(ticket)` 在发送前持久化实际发送时间；`settle(ticket, sent|unknown|cancelled)`；`recover(key, selection)`；`isCurrent(ticket)`。
- 每个桶同一时刻仅一个 pending；`reserve` 为写前记账：先自增计数与时间再返回 ticket，同步阻止重复。
- 已发或网络结果未知都占额度；仅网络前已知未发的取消可回滚元数据。
- 返回值与持久化字段均不含 key、模型名或错误原文。

## 七、运行时行为

- 入口 `observe(key, sid, event)`，按 seq 去重；使用真实 `event.data` 结构，按回合/步骤绑定实际模型，不能用新配置给旧请求改名。
- DSH 0.21 的 `model/selection` 是下一次请求选择；在途归属以 `request/header` / `request/context` 的路由为准，成功恢复优先采用 `message.source` 的实际模型。
- 只有可信的当前 live turn 能预留；错误确属额度耗尽时，即使因冷却/上限/guard 未发，也返回 handled。
- 入队任务发送前重校验 guard、当前选择、turn 身份与 `policy.isCurrent`，任一不合法结算为 cancelled。
- 发送失败结算为 unknown，不重放，仅记录通用安全错误。
- 队列挂在公共 sendChain，不阻塞主事件循环；`maxSessions` 到顶时安全丢弃运行时会话并失效其排队状态。
- `hydrate` 静默建立水位与 turn；`forget` 只清运行时引用、不重置计数；`clear` 清理全部。
- 不推断不安全模型事件，无定时器，无模型请求。

## 八、状态文件

- `state/quota-notices.json` 仅 `{ version: 1, entries: [{ id, count, lastAt }] }`。
- `id` 为 `[key, provider, model]` 的 SHA256，文件不含会话 key、原始错误或凭据。
- `write-ahead` 使已发、网络结果未知、崩溃三种情况都保守计数。
- 条目上限默认 4096：满时拒绝新桶，不驱逐正在封顶的 incident。

## 九、故障处理（fail-closed）

- 状态读坏、格式非法或 `load` 抛错：当前实例抑制通知，且不覆盖原文件。
- 写入失败：同样抑制通知，记通用安全告警码，不向桥接抛异常。
- 管理员修复文件后重启桥接恢复；禁止自动删除计数或自动清理状态。
- 时钟回拨时 `now < lastAt` 一律抑制。

## 十、日志

- 固定前缀 `[quota]`：错误诊断（经 `redact` 脱敏限长）、`quota_notice_sent`、`quota_notice_suppressed_cooldown`、`quota_notice_suppressed_limit`、`quota_notice_cancelled`、`quota_notice_unknown`、`quota_notice_send_failed`。
- 不记录原始请求、提示词、token 或密钥。

## 十一、边界与测试

- 通知不改变会话已读、活跃度、回复与潜水（sleep）状态；系统通知不算正式应答。
- 测试：四个 `node --test` 脚本，覆盖分类器、策略、运行时、桥接事件路由（含无旧逻辑重复通知、日志脱敏、不触发 prompt、休眠/回复/已读不变）。
- 运行：`node --test scripts/test-quota-error.mjs scripts/test-quota-notice.mjs scripts/test-quota-notice-runtime.mjs scripts/test-quota-notice-integration.mjs`；累计回归使用 `npm run test:quick` 和 `npm run test:audit`。
- 合并门槛：红测先行、直测全绿、真实桥接源码的隔离 harness 通过、quick 与 full 全绿、diff 与隐私复核。
- 部署：仅重启桥接生效，无需修改 DSH 或供应商策略。
- 不进行线上 DSH 故障注入。

## 十二、验证限制

- 自动化使用假 QQ/DSH 与临时状态目录；真实 QQ 发送尚需人工验证，不声称已实测。
