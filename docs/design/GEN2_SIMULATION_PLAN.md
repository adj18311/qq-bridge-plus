# 二代仿真模式（reserved2）——“一切皆工具”实施计划

> 状态：**实施中（Phase 1~4 已完成骨架/API/调度/MCP/UI/preset）**
> 关联文档：`DSH_QQ_TOOLS_PLAN.md`（同目录）、`../guides/PROJECT_GUIDE.md`、`SOCIAL_MODE_PLAN.md`（同目录）、`真人语感策略.md`（同目录）
> 目标：在一代 `reserved`（状态机驱动）之外，新增 `reserved2`（工具驱动 / agent 自主决策），把 QQ 场景里的“何时看、看什么、回不回、回什么、分几条、何时潜水”全部交给 DSH agent 在思维链中自主决定。

---

## 1. 背景与目标

### 1.1 为什么要做二代

一代仿真模式（`reserved`）已经解决了“AI 像群友”的很大一部分问题，但决策仍由桥接的规则/概率状态机主导：

- 桥接决定何时进入活跃、何时沉默、何时退场；
- AI 只能通过文本约定（`[SILENT]`、空格分句）表达有限意图；
- AI 没有“主动查看上下文、主动规划发言、主动设置下次唤醒”的能力。

二代的核心理念是：

> **AI 是 agent，不是被桥接遥控的木偶。**
> 桥接只做三件事：
> 1. 安全执行器（白名单、敏感审计、限频、日志）；
> 2. 消息仓库（最近消息、未读游标）；
> 3. 唤醒调度器（按 AI 自己设定的条件叫醒它）。
> 所有社交决策由 AI 在思维链里通过工具完成。

### 1.2 与一代的关系

- 一代 `reserved` **完整保留**，不修改其行为；
- 二代 `reserved2` 独立演进；
- 一代中与“状态机/文本协议”无关的真人感提示词（人格卡、短句、接梗、引用指向性、黑话表、当前时间等）全部迁移到二代；
- 一代中与状态机强相关的提示词（“请根据情况决定是否回复”“输出 `[SILENT]`”“按空格分句”等）在二代删除/替换为工具协议。

---

## 2. 设计原则

1. **桥接不替 AI 做社交决策**：是否回复、是否潜水、什么时候醒，由 AI 决定。
2. **所有发言必须通过工具**：二代中 AI 的最终文本输出不会自动转发到 QQ，杜绝“工具发一条 + 自动转发一条”。
3. **唤醒也工具化**：AI 通过 `qq_set_wake_config` 设置自己的“闹钟”和“提前唤醒条件”。
4. **推荐值只是参考**：控制台提供推荐值，AI 可以自由选择不遵守。
5. **可叠加条件**：@、名字、关键词、提问、普通消息概率等唤醒条件可以任意组合（OR 关系）。
6. **安全边界不削弱**：白名单、敏感审计、发送限频、唤醒限频全部由桥接硬性兜底。
7. **可观测、可干预**：控制台可以查看每个会话的 WakeConfig、未读数、唤醒历史，owner 可强制唤醒/强制潜水/重置配置。

---

## 3. 总体架构

```
QQ 消息
   │
   ▼
bridge.js（reserved2 分支）
   │
   ├─ 写入 recentMessages / unread
   ├─ 读取该会话 WakeConfig
   │     ├─ 无配置 → 发送【引导唤醒】
   │     ├─ 命中提前唤醒条件 → 发送【唤醒通知】
   │     ├─ 有限时间到期 → 发送【超时唤醒通知】
   │     └─ 未命中 → 只存档，不打扰
   │
   ▼
DSH 会话收到【唤醒通知】（只告知“你被唤醒了”，不代替 AI 做决定）
   │
   ▼
AI 自主调用工具：
   ├─ qq_get_prompt        查看角色/推荐值/可用工具/当前状态
   ├─ qq_get_unread_messages 查看未读消息
   ├─ qq_get_recent_messages 扩大查看范围
   ├─ qq_social_state      查看自己的唤醒配置与状态
   ├─ qq_send_group_message / qq_reply / qq_send_burst  发言
   ├─ qq_mark_read         标记已读但不回复
   └─ qq_set_wake_config   设置下一次如何被唤醒
   │
   ▼
MCP 工具 → 桥接本地 Agent API → 安全校验 + 执行 + 记录
```

---

## 4. 模式与配置

### 4.1 模式标识

- 内部标识：`reserved2`
- 控制台显示：二代仿真模式
- 通道规则：与 `reserved` 一致（白名单群 + 白名单私聊）
- 默认 agent preset：`qq-chat-v2`（可配置）

### 4.2 配置位置

- 运行模式：沿用现有机制（DSH settings `qq-mode` / `state/mode.json`）；
- 二代专属配置：`config.json` 新增 `socialV2` 节点；
- 运行状态：新增 `state/social-v2.json`（或先内存 + 可选持久化）。

---

## 5. WakeConfig 模型（核心）

每个会话维护一份 WakeConfig，表示“AI 希望自己之后怎么被叫醒”。

```json
{
  "mode": "diving",
  "infinite": true,
  "sleepUntil": null,
  "triggers": {
    "atMention": true,
    "nameMention": true,
    "keywords": ["小鲸鱼", "DeepSeek"],
    "question": false,
    "anyMessage": false,
    "probability": 0.05
  },
  "batchWindowMs": 8000,
  "lastWakeAt": 0,
  "wakeCount": 0,
  "noActionCount": 0
}
```

### 5.1 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `mode` | `diving` / `active` | 便捷模式。`active` 等价于 `anyMessage: true` + 持续可唤醒；`diving` 是潜水模式 |
| `infinite` | boolean | `true` = 无限时间，只有命中条件才唤醒；`false` = 有限时间，`sleepUntil` 到期也会唤醒 |
| `sleepUntil` | ISO 时间戳 / null | 有限潜水截止时间；`infinite=true` 时忽略 |
| `triggers.atMention` | boolean | 被 QQ @ 或引用机器人自己时唤醒 |
| `triggers.nameMention` | boolean | 消息中出现机器人昵称/名字时唤醒 |
| `triggers.keywords` | string[] | 出现任意关键词时唤醒 |
| `triggers.question` | boolean | 检测到直接提问/点名挑战时唤醒 |
| `triggers.anyMessage` | boolean | 任何新消息都唤醒（活跃模式） |
| `triggers.probability` | number 0~1 | 普通消息按该概率随机唤醒 |
| `batchWindowMs` | number | 多条消息合并唤醒窗口，避免一条条轰炸 |
| `lastWakeAt` | number | 上次唤醒时间 |
| `wakeCount` | number | 累计唤醒次数（可做统计/限频） |
| `noActionCount` | number | 连续唤醒后无任何工具行动次数，用于兜底 |

### 5.2 条件组合语义

- 所有 `triggers` 条件之间是 **OR** 关系，命中任意一个即唤醒；
- `anyMessage` 是“通配”条件，开启后其他条件不再重要；
- `probability` 是随机条件，可与确定性条件叠加；
- 有限时间到期是一种**独立唤醒原因**，不属于 triggers。

### 5.3 示例

1. **纯潜水（无限期）**：
   ```json
   {
     "mode": "diving",
     "infinite": true,
     "triggers": { "atMention": true, "nameMention": true, "keywords": ["小鲸鱼"], "probability": 0 }
   }
   ```
   只有被 @、被叫名字、出现“小鲸鱼”才醒。

2. **潜水 30 分钟 + 提前条件**：
   ```json
   {
     "mode": "diving",
     "infinite": false,
     "sleepUntil": "<now+30min>",
     "triggers": { "atMention": true, "keywords": ["在吗", "d指导"], "probability": 0.1 }
   }
   ```
   30 分钟内命中条件提前醒；否则 30 分钟后因“时间到”被唤醒。

3. **活跃模式**：
   ```json
   {
     "mode": "active",
     "infinite": true,
     "triggers": { "anyMessage": true }
   }
   ```
   群里有任何新消息都会唤醒 AI。

---

## 6. 唤醒调度算法

### 6.1 消息到达时

```
handleIncoming(kind, id, event)：
  1. 白名单/模式检查
  2. 写入 recentMessages
  3. 如果该会话没有 WakeConfig：
       → 用控制台推荐值创建默认 WakeConfig
       → 发送【引导唤醒】（reason=bootstrap）
  4. 如果有 WakeConfig：
       a. 判断是否命中唤醒：
          - active / anyMessage=true → 命中（reason=anyMessage）
          - atMention / nameMention / keywords / question / probability → 命中（记录第一个命中的原因）
       b. 命中：
          - 如果已有 pendingWake 定时器（batchWindow 内），只追加 unread，不重复唤醒
          - 否则安排 batchWindowMs 后的唤醒通知
       c. 未命中：
          - 追加 unread
          - 不打扰
```

### 6.2 有限时间到期

- 当 AI 设置 `infinite=false` 且 `sleepUntil` 时，桥接启动一个定时器；
- 到期时若没有发生过提前唤醒，则发送【超时唤醒】：
  > 【唤醒】群 group:xxx
  > 原因：你设置的有限潜水时间已到；在你规定的时间内没有任何一项条件被触发，只是因为时间到了所以你被唤醒。
  > 你可以查看消息，或继续设置新的唤醒条件。
- 超时唤醒后，`noActionCount` 归零前的处理同普通唤醒；AI 需要设置新 WakeConfig 或发言，否则计入无行动。

### 6.3 唤醒通知格式（最小信息）

```text
【唤醒】群 group:100012
原因：被 @ 唤醒 / 关键词“小鲸鱼” / 普通消息概率命中 / 时间到
```

- 不包含“请回复”；
- 不包含“是否回复”；
- 不包含 `[SILENT]` 出口；
- 具体内容由 AI 通过工具查看。

### 6.4 引导唤醒（bootstrap）

当会话第一次进入 `reserved2` 且没有 WakeConfig 时：

```text
【引导唤醒】你已接入 QQ 会话 group:100012。
当前是二代仿真模式：你的文本输出不会自动发送到 QQ，所有发言必须通过工具完成。
请先调用 qq_get_prompt 查看你的角色、推荐值、可用工具和当前状态，
然后用 qq_set_wake_config 设置你希望如何被唤醒。
```

### 6.5 无行动兜底

- 每次唤醒后，如果 AI 在本次 turn 内既没有调用任何写工具（发送/设置 WakeConfig/markRead），也没有输出有意义的内部决策，则 `noActionCount++`；
- 连续达到 `socialV2.wake.noActionLimit`（默认 3）次后，桥接发送一次温和提醒，并自动将 WakeConfig 重置为控制台默认值：
  > 你已连续多次被唤醒但没有设置新的唤醒方式。桥接已按推荐值重置你的唤醒配置；你可以随时用 qq_set_wake_config 修改。
- AI 一旦调用 `qq_set_wake_config` 或发送工具，`noActionCount` 清零。

---

## 7. 工具清单与 Schema

### 7.1 读工具

#### `qq_get_prompt`（查看提示词/推荐值/工具列表）

- 用途：AI 主动查看当前角色、真人感提示词、控制台推荐值、当前可用工具、当前会话状态。
- 参数：无。
- 返回：
  ```json
  {
    "conversationKey": "group:100012",
    "time": "...",
    "role": { "name": "小鲸鱼", "content": "..." },
    "recommended": {
      "wake": { "mode": "diving", "sleepMinMs": 300000, "sleepMaxMs": 7200000, "probability": 0.05, "keywords": ["小鲸鱼"], "atMention": true, "nameMention": true, "question": true },
      "send": { "burstEnabled": true, "burstMaxMessages": 8, "intervalMinMs": 1000, "intervalMaxMs": 3000 }
    },
    "enabledTools": ["qq_get_prompt", "qq_get_unread_messages", "qq_get_recent_messages", "qq_social_state", "qq_send_group_message", "qq_reply", "qq_send_burst", "qq_mark_read", "qq_set_wake_config"],
    "currentWakeConfig": { "...": "..." }
  }
  ```

#### `qq_get_unread_messages`

- 用途：查看自上次已读之后的新消息。
- 参数：
  - `limit?`：默认 `socialV2.context.unreadLimit`（建议 30），最大 100。
- 返回：
  ```json
  {
    "unreadCount": 12,
    "messages": [
      { "message_id": -123, "sender": "群友A", "user_id": 123456, "isOwner": false, "text": "...", "quote": { "sender": "群友B", "text": "..." } }
    ]
  }
  ```
- 不自动标记已读；AI 决定不回复时需调用 `qq_mark_read`。

#### `qq_get_recent_messages`

- 用途：查看最近 N 条消息，支持 offset 扩大范围；适合“第一遍没看全，再查一次”。
- 参数：
  - `limit?`：默认 20，最大 100；
  - `offset?`：默认 0，最大 500。
- 返回：与 unread 相同的消息结构。

#### `qq_social_state`

- 用途：查看当前会话 WakeConfig、未读数、上次唤醒原因、上次发言时间等。
- 参数：无。
- 返回：
  ```json
  {
    "conversationKey": "group:100012",
    "wakeConfig": { "...": "..." },
    "unreadCount": 12,
    "lastWakeAt": 1710000000000,
    "lastWakeReason": "keyword:小鲸鱼",
    "lastAiReplyAt": 1710000000000,
    "noActionCount": 0
  }
  ```

#### 已有只读工具

- `qq_status`
- `qq_list_groups`
- `qq_get_group_members`
- `qq_get_group_history`

### 7.2 写工具（发言）

#### 已有发送工具（保持兼容）

- `qq_send_group_message`
- `qq_reply`
- `qq_send_private_message`

#### `qq_send_burst`（新增）

- 用途：AI 主动分多条发送，桥接按真人化随机间隔发出。
- 参数：
  - `groupId`：群号；
  - `messages: string[]`：消息数组，长度 1~`burstMaxMessages`；
  - `replyToMessageId?`：可选引用。
- 校验：
  - 每条长度 ≤ `maxMessageChars`（默认 500）；
  - 总条数 ≤ `burstMaxMessages`（默认 8）；
  - 目标必须白名单；
  - 文本过 `SENSITIVE_RE`。
- 返回：
  ```json
  { "sent": true, "count": 3, "messageIds": [1, 2, 3] }
  ```

### 7.3 唤醒/潜水管理工具（核心新增）

#### `qq_set_wake_config`

- 用途：AI 自主设置之后如何被唤醒。
- 参数（全部可选，缺省表示保留原值或使用推荐值）：
  ```json
  {
    "mode": "diving" | "active",
    "infinite": true | false,
    "sleepMs": 1800000,
    "sleepUntil": "2026-01-01T00:00:00.000Z",
    "triggers": {
      "atMention": true,
      "nameMention": true,
      "keywords": ["小鲸鱼"],
      "question": false,
      "anyMessage": false,
      "probability": 0.05
    },
    "batchWindowMs": 8000
  }
  ```
- 语义：
  - `mode: "active"` 是便捷预设：设置 `anyMessage: true`、`infinite: true`；
  - `infinite: true`：只按 triggers 唤醒，没有时间到唤醒；
  - `infinite: false`：必须提供 `sleepMs` 或 `sleepUntil`，到点后触发超时唤醒；
  - `sleepMs` 受 `minSleepMs` / `maxSleepMs` 硬限制；
  - `triggers` 为 OR 关系，可叠加。
- 返回：更新后的完整 WakeConfig。

#### `qq_mark_read`

- 用途：AI 看过消息但决定不回复时，标记当前未读为已读，避免下次重复出现。
- 参数：无（或可选 `upToMessageId`）。
- 返回：`{ marked: true, markedCount: n }`。

### 7.4 黑话学习（二代已接入）

- `qq_slang_query`：AI 查询已确认黑话/梗/网络表达（只读，可搜索）；
- `qq_slang_submit`：AI 把经常看到但不确定的陌生词提交给管理员筛选；
- 桥接仍保留一代的自动提取：reserved2 下群聊普通消息也会进入黑话学习窗口；
- 管理员在控制台「群聊黑话 / 网络用语库」确认后，词条会进入黑话提示词，注入 `qq_get_prompt` 与后续唤醒提示，成为 AI 可长期查询的记忆；
- 控制台支持按状态筛选、搜索、批量确认、查看语境证据、手动编辑。

### 7.5 后续扩展（二期）

- `qq_slang_confirm` / `qq_slang_reject`：黑话管理（仅 owner，当前由控制台完成）；
- `qq_set_social_state`：owner/调试用强制状态。

---

## 8. 推荐值与“查看提示词”工具

### 8.1 推荐值的作用

- 控制台保存一组 `socialV2.recommended.*` 推荐值；
- AI 调用 `qq_get_prompt` 时能看到这些推荐值；
- 推荐值**仅供 AI 参考**，AI 可以不遵守；
- 控制台可以随时修改，AI 下次查看时看到新值。

### 8.2 推荐值内容

```json
{
  "wake": {
    "defaultMode": "diving",
    "sleepMinMs": 300000,
    "sleepMaxMs": 7200000,
    "probability": 0.05,
    "keywords": ["小鲸鱼", "DeepSeek"],
    "atMention": true,
    "nameMention": true,
    "question": true
  },
  "send": {
    "burstEnabled": true,
    "burstMaxMessages": 8,
    "intervalMinMs": 1000,
    "intervalMaxMs": 3000,
    "longGapProbability": 0.2,
    "longGapMinMs": 5000,
    "longGapMaxMs": 10000
  }
}
```

### 8.3 推荐值在提示词中的表述

在 `qq_get_prompt` 返回里明确写：

> 以下为管理端提供的推荐值，仅供参考，你可以根据群聊氛围自由调整，不必完全遵守。

---

## 9. 控制台参数设计（`socialV2`）

### 9.1 完整配置结构

```json
{
  "socialV2": {
    "enabled": true,
    "tools": {
      "getPrompt": true,
      "getUnread": true,
      "getRecent": true,
      "socialState": true,
      "sendGroup": true,
      "sendPrivate": true,
      "reply": true,
      "sendBurst": true,
      "setWakeConfig": true,
      "markRead": true,
      "memory": false
    },
    "wake": {
      "defaultMode": "diving",
      "sleepMinMs": 60000,
      "sleepMaxMs": 0,
      "recommendedSleepMinMs": 300000,
      "recommendedSleepMaxMs": 7200000,
      "recommendedProbability": 0.05,
      "recommendedKeywords": ["小鲸鱼", "DeepSeek"],
      "recommendedAtMention": true,
      "recommendedNameMention": true,
      "recommendedQuestion": true,
      "batchWindowMs": 8000,
      "maxWakePerMinute": 1,
      "maxWakePerHour": 12,
      "noActionLimit": 3
    },
    "send": {
      "burstEnabled": true,
      "burstMaxMessages": 8,
      "burstIntervalMinMs": 1000,
      "burstIntervalMaxMs": 3000,
      "longGapProbability": 0.2,
      "longGapMinMs": 5000,
      "longGapMaxMs": 10000,
      "maxSendPerMinute": 8,
      "maxSendPerHour": 60,
      "maxMessageChars": 500
    },
    "context": {
      "recentLimit": 100,
      "unreadLimit": 30,
      "contextWindow": 20
    }
  }
}
```

### 9.2 参数说明

| 分组 | 字段 | 说明 |
|---|---|---|
| 总开关 | `enabled` | 是否启用二代模式 |
| 工具开关 | `tools.*` | 决定 AI 能调用哪些工具。关闭后桥接本地 API 返回“工具未启用”，`qq_get_prompt` 的 `enabledTools` 也不再列出 |
| 唤醒硬限制 | `wake.sleepMinMs` | AI 设置 `sleepMs` 的最小值，防止频繁自我唤醒 |
| 唤醒硬限制 | `wake.sleepMaxMs` | AI 设置 `sleepMs` 的最大值；`0` 表示不限制（允许无限） |
| 唤醒硬限制 | `wake.maxWakePerMinute` / `maxWakePerHour` | 每会话唤醒频率上限 |
| 唤醒推荐 | `wake.recommended*` | 展示给 AI 的推荐值，不强制 |
| 无行动兜底 | `wake.noActionLimit` | 连续无行动多少次后桥接重置 WakeConfig |
| 发送硬限制 | `send.maxSendPerMinute` / `maxSendPerHour` | 防止 AI 刷屏 |
| 发送推荐/限制 | `send.burst*` | 分条发送参数 |
| 上下文 | `context.*` | 最近消息/未读消息返回上限 |

### 9.3 控制台 UI

新增“二代仿真模式”卡片：

- 模式切换按钮（chat / closed-agent / reserved / reserved2）；
- 工具能力开关列表（每个工具一个 checkbox）；
- 唤醒推荐值编辑（默认潜水时长、概率、关键词、@/名字/提问开关）；
- 唤醒硬限制编辑（最小/最大 sleep、每分钟/每小时唤醒上限）；
- 发送限制编辑（burst 上限、间隔、每分钟/每小时发送上限）；
- 会话状态查看器（每个会话的 WakeConfig、未读数、lastWakeReason、noActionCount）；
- owner 操作按钮：
  - 立即唤醒该会话；
  - 重置该会话 WakeConfig 为默认；
  - 强制进入 active / diving。

---

## 10. DSH 侧改动：`qq-chat-v2` preset

### 10.1 保留（从一代迁移）

- `roles/*.md` 人格卡机制；
- 真人语感策略（短句、碎片、接梗、错别字、话题漂移、选择性沉默、括号用法、自曝生活等）；
- 群聊引用指向性判断（`[引用 某人：原文]` 表示对谁说）；
- 管理员身份标记【管理员】；
- 当前时间注入；
- 已确认黑话表【群聊黑话表】；
- 联网搜索/抓取能力（内置 web_search / web_fetch + 可选安全 MCP）。

### 10.2 替换/删除（状态机相关）

- 删除“输出 `[SILENT]` 表示潜水”；
- 删除“用空格分句，桥接自动拆条”；
- 删除“请根据情况决定是否回复”；
- 删除“活跃超时退场”“冷场试探”等状态机语义提示。

### 10.3 新增（工具协议）

在 `qq-chat-v2` preset 的系统提示词中加入：

```text
你处于二代仿真模式（reserved2）。

- 你的文本输出不会自动发送到 QQ，它只是你的思考/内部输出。
- 要发言必须调用发送工具：qq_send_group_message / qq_reply / qq_send_burst。
- 你通过 qq_set_wake_config 控制自己何时被唤醒。
- 收到【唤醒】通知只代表“该看看了”，不代表必须说话。
- 看消息可以分多次：先 qq_get_unread_messages，不够再 qq_get_recent_messages 扩大范围。
- 想潜水就用 qq_mark_read + qq_set_wake_config 设置下一次唤醒条件。
- 想连续聊就把 anyMessage 设为 true（或 mode=active）。
- 你可以设置无限期潜水，只有你设定的条件（@、名字、关键词、提问、概率等）命中才会被唤醒。
- 有限时间到期被唤醒时，你可以继续潜水并设置新的唤醒条件。
- 管理端给出的推荐值只是参考，你可以根据群聊氛围自行调整。
```

### 10.4 推荐值如何进入 AI 上下文

- 稳定协议写在 preset 系统提示词；
- 完整角色卡、推荐值、可用工具列表通过 `qq_get_prompt` 按需获取；
- 桥接在唤醒通知中**不再注入完整人格卡**，减少上下文浪费，也迫使 AI 学会主动查看。

---

## 11. 桥接侧改动

### 11.1 模式接入

- `VALID_MODES` 增加 `reserved2`；
- `modeAllowed`：与 `reserved` 相同；
- `modePreset`：`reserved2` 返回 `qq-chat-v2`；
- `plugins/qq-mode-console` schema 增加 `reserved2`；
- 控制台 HTML 增加按钮与配置面板；
- `RULES.md` / `PROJECT_GUIDE.md` 同步补充。

### 11.2 事件泵（pumpMux）调整

- `reserved2` 下：
  - `ended.text` **不自动转发**到 QQ，仅记录日志（`[reserved2] 内部输出/思考`）；
  - 发送只通过 MCP 工具完成；
  - 提问/审批转发逻辑保持不变；
  - 工具成功调用发送后，不做自动转发。

### 11.3 本地 Agent API

新增桥接内部 HTTP API（挂在控制台服务或独立端口，使用独立 `agentToken` 或复用 `consoleToken`）：

```
GET  /api/agent/prompt?key=...
GET  /api/agent/unread?key=...&limit=...
GET  /api/agent/recent?key=...&limit=...&offset=...
GET  /api/agent/state?key=...
POST /api/agent/mark-read        { key }
POST /api/agent/wake-config      { key, config }
POST /api/agent/send-burst       { key, groupId, messages, replyToMessageId? }
```

- MCP 工具通过该 API 访问桥接内存态；
- 所有写操作在桥接侧统一执行：白名单、SENSITIVE_RE、限频、活动日志；
- 工具开关在桥接侧强制生效。

### 11.4 MCP 扩展

在 `src/mcp-snowluma-safe.js`（或新增 `src/mcp-social-v2.js`）增加：

- `qq_get_prompt`
- `qq_get_unread_messages`
- `qq_get_recent_messages`
- `qq_social_state`
- `qq_send_burst`
- `qq_set_wake_config`
- `qq_mark_read`

已有发送工具保持兼容，一代 `reserved` 不受影响。

---

## 12. 数据模型 / 状态

新增 `state/social-v2.json`：

```json
{
  "conversations": {
    "group:100012": {
      "wakeConfig": { "...": "..." },
      "unreadCursor": 1710000000000,
      "recentMessages": [],
      "pendingWake": null,
      "lastWakeAt": 0,
      "lastWakeReason": "",
      "lastAiReplyAt": 0,
      "noActionCount": 0
    }
  }
}
```

- `recentMessages` 内存保留最近 `recentLimit` 条；
- WakeConfig 建议持久化，桥接重启后 AI 的“潜水计划”不丢失；
- 未读游标可持久化，也可重启后从最近消息重新计算；
- `pendingWake` 用于 batchWindow 合并，不持久化。

---

## 13. 安全与护栏

1. **白名单不变**：所有发送目标必须命中 `allow.*`。
2. **敏感审计不变**：所有发送文本仍过 `SENSITIVE_RE`。
3. **发送限频**：`maxSendPerMinute` / `maxSendPerHour` 由桥接硬限制。
4. **唤醒限频**：`maxWakePerMinute` / `maxWakePerHour` 防止成本失控。
5. **最小潜水时间**：`sleepMinMs` 防止 AI 频繁自我唤醒。
6. **无自动转发**：杜绝“工具发一条 + 文本自动发一条”的重复问题。
7. **owner 硬控制**：`/silent`、`/active`、`/status` 以及控制台按钮可随时覆盖 WakeConfig。
8. **工具开关**：控制台关闭的工具，桥接本地 API 直接拒绝。
9. **无行动兜底**：连续无行动后自动重置 WakeConfig。
10. **黑话/记忆**：仍遵循人工确认、只读、不暴露本地能力。

---

## 14. 实施阶段

### Phase 0：计划定稿（当前）

- 本计划文档继续讨论修订；
- 确定工具 schema、API 契约、`qq-chat-v2` 提示词草案。

### Phase 1：模式骨架

- `reserved2` 接入桥接/控制台/DSH 插件；
- 创建 `qq-chat-v2` preset 空壳；
- 桥接 `reserved2` 分支先只做日志，不改变行为。

### Phase 2：桥接 Agent API + 状态存储

- 实现 `/api/agent/*`；
- 实现 `social-v2` 存储：recentMessages、unread、WakeConfig；
- MCP 接入桥接 API 客户端。

### Phase 3：读工具

- `qq_get_prompt`
- `qq_get_unread_messages`
- `qq_get_recent_messages`
- `qq_social_state`
- 测试脚本覆盖。

### Phase 4：写工具 + 唤醒工具

- `qq_send_burst`
- `qq_mark_read`
- `qq_set_wake_config`
- 限频、审计、日志。

### Phase 5：唤醒调度器

- 引导唤醒；
- 提前唤醒条件（@/名字/关键词/提问/概率/anyMessage）；
- 有限时间到期唤醒；
- 无限期潜水；
- batchWindow 合并；
- `pumpMux` 关闭二代自动转发；
- 无行动兜底；
- owner 硬覆盖命令。

### Phase 6：真人感提示词打磨

- 把一代人格/真人感提示词完整搬入 `qq-chat-v2`；
- 写工具调用示例（few-shot）；
- 在受控群 `100012` 实测，调参。

### Phase 7：长期记忆（后续）

- `qq_get_memory` / `qq_memory_append` / `qq_memory_query`；
- 群友画像、话题兴趣、关系记忆。

---

## 15. 测试与验收

### 15.1 自动化

- `scripts/test-social-v2.mjs`：直接调桥接 Agent API，验证 unread/read/wake-config/send-burst；
- MCP 测试：新工具存在、白名单外拒绝、非法参数拒绝、负数 id 通过；
- 唤醒调度单测：
  - 无 WakeConfig → 引导唤醒；
  - 无限期 + 关键词命中 → 唤醒；
  - 无限期 + 普通消息概率不命中 → 不唤醒；
  - 有限时间到期 → 超时唤醒；
  - 有限时间内提前命中 → 提前唤醒，不等到期；
  - 多条消息在 batchWindow 内 → 合并为一次唤醒；
  - 唤醒限频 / 发送限频 / 最小 sleep 生效；
  - 连续无行动 → 自动重置 WakeConfig。

### 15.2 人工验收（受控群）

1. owner 在群内切换到 `reserved2`；
2. AI 收到引导唤醒后应主动调用 `qq_get_prompt` / 查看工具 / 设置 WakeConfig；
3. 群友 @AI → AI 被提前唤醒 → 自主查看消息 → 决定发言或继续潜水；
4. 潜水期间普通闲聊不打扰，但命中关键词会唤醒；
5. AI 设置有限时间后，若期间无触发，到点收到“时间到”唤醒并可继续设置；
6. AI 设置无限期后，只有自己设定的条件能唤醒它；
7. AI 想连续聊时设置 `anyMessage: true` / `mode: active`；
8. 全程无“桥接自动转发”的重复消息；
9. AI 不会刷屏，不会频繁自我唤醒；
10. 控制台工具开关关闭后，AI 调用对应工具被拒绝。

---

## 16. 风险与对策

| 风险 | 对策 |
|---|---|
| AI 醒来后不调用任何工具，沉默卡死 | `noActionLimit` 兜底 + 自动重置 WakeConfig |
| AI 频繁自我唤醒，成本飙升 | `sleepMinMs` + `maxWakePerMinute/Hour` 硬限制 |
| AI 用工具刷屏 | `maxSendPerMinute/Hour` + `burstMaxMessages` |
| AI 看不到完整上下文，误判 | `qq_get_recent_messages` 支持翻页扩大，preset 引导“没看全就再查一次” |
| 工具调用失败导致行为异常 | 结构化错误信息 + 重试提示 |
| MCP 全局工具影响一代/其他模式 | 新工具只在 `qq-chat-v2` 提示词中引导使用；控制台可关闭；后续可评估收口到 preset |
| 推荐值被 AI 无视导致行为失控 | 推荐值本身是参考，但硬限制仍由桥接兜底 |
| WakeConfig 持久化引入状态污染 | 重启后校验合法性，非法字段回退默认 |

---

## 17. 后续待讨论项

0. ~~**安全 TODO（当前已知）**：MCP 状态工具目前通过 `key` 参数访问桥接状态，尚未做“会话级隔离”。~~ **已实现（2026-08-20）**：每个二代会话生成独立 `agentToken`，MCP 状态工具必须携带该 token（`x-agent-token` / `token` 参数）才能访问对应会话；控制台管理端仍走 admin 通道。后续如需要更严格作用域，可再评估原生 DSH 插件。
1. `qq_get_unread_messages` 是否要支持按 `message_id` 增量游标，而不仅是时间游标？
2. 唤醒时是否自动附带最近 1~3 条消息作为“诱饵”，还是完全让 AI 用工具查看？
3. `qq_mark_read` 是否需要支持“只标记部分消息已读”？
4. `mode: active` 是否需要在 AI 连续活跃一段时间后由桥接建议“该潜水了”，还是完全由 AI 自行控制？
5. 是否把 `qq_get_prompt` 的返回内容做 token 上限控制（角色卡较长时只返回摘要 + 按需全文）？
6. 是否在一代 `reserved` 中保留 `[SILENT]` 和空格分句不变？（计划默认保留）

---

*计划版本：v0.1，2026-08-20*
