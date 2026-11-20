# 模型切换 + 额度监控（本地脚本）

一套**独立脚本 + 双击 bat**，用来把桥接的模型档位在 MiniMax / DeepSeek 之间切换，并在额度
见底时私聊提醒主人。不是 DSH 插件，不改 `src/**`，不碰记忆桶。

| 文件 | 作用 |
| --- | --- |
| `scripts/switch-model.mjs` | 改 `config.json` 档位（含 `dsh.reasoningEffort`）+ 退役重建会话 + 自检 + 通知 |
| `scripts/check-model-quota.mjs` | 查 MiniMax（窗口 + `max_tokens:1` 探针）与 DeepSeek（余额），**每次运行都私聊汇报** |
| `scripts/check-reasoning-effort.mjs` | 只读：判定 `minimax-cn` 的模型到底接受哪些 `reasoningEffort`（从 DSH 应用包里读 pi-ai 目录） |
| `切换模型到MiniMax.bat` / `切换模型到DeepSeek.bat` | 双击切换（等价于 `--to minimax` / `--to deepseek`） |
| `检查模型额度.bat` | 双击查额度（每次都会给主人发一条汇报），跑完 `pause` |

## 1. 为什么必须「退役重建」

模型是绑在 DSH **会话**上的：`config.json` 的 `dsh.provider` / `dsh.model` 只在**新建**会话时生效
（`src/bridge.js` 的 `ensureChatModel` 每个会话在本进程内只 `selectModel` 一次）。重启桥接、重启
DSH 都不会改已有会话的模型。所以切档位 = **删掉 `state/sessions.json` 里的映射 → 让桥接重启 →
下一条消息建新会话并按新配置套模型**。

`switch-model.mjs` 的完整流程：

1. 备份 `config.json` → `config.json.bak-switch-YYYYMMDDTHHMMSS`，备份 `state/sessions.json` →
   `state/sessions.json.bak-switch-YYYYMMDDTHHMMSS`（同目录，纯新增文件）；
2. 改 `config.json` 的 `dsh.provider` / `dsh.model`，**并同时管理 `dsh.reasoningEffort`**
   （原子写，格式不变）。两个档位各自的思考强度策略写在 `switch-model.mjs` 顶部的 `PROFILES`：
   - `minimax`：`reasoningEffort: undefined` ⇒ **删掉这个键**（见下面的「已知问题」：这个模型的
     `off` 在线上等于「不发思考参数」）；
   - `deepseek`：`reasoningEffort: 'high'`（`deepseek-account` 走 `dsh-llm-deepseek`，接受 `off/low/high/max`）。
   想手动覆盖：`--effort <auto|off|minimal|low|medium|high|xhigh|max>`；想完全不动这个键：
   `--keep-effort`。「已经是该档位」的判据是 **provider + model + reasoningEffort 三者都对得上**，
   所以「模型没变但强度不对」的配置也会被这次切换顺手修掉；
3. 删目标会话映射（默认**全部**会话；`--only <key>` 只删一个，**测试用**），同时删同名
   `sessionPolicies` 条目——**绝不碰** `state/social-v2.json`（记忆桶）、slang、stickers、patrol-log；
4. 杀掉 `state/bridge.lock` 里的那个 PID（杀之前会核对命令行里确实是 `bridge.js`，避免误杀被回收的
   PID），然后轮询等守护（`start.bat` 的循环）把新桥接拉起来，**超时 60s 报错**；
5. 自检：读 `state/token-usage.jsonl`，打印每个 key 最近一次实际用的 `provider/model`，统计
   「已切换 / 仍是旧档位 / 无记录」；
6. 给主人私聊发一条结果通知（`--quiet` 跳过）。

```bat
node scripts\switch-model.mjs --to minimax --dry-run     :: 只看会改什么（含 reasoningEffort），不写文件、不杀进程、不发消息
node scripts\switch-model.mjs --to deepseek              :: 真切换（默认全部会话）
node scripts\switch-model.mjs --to deepseek --only group:894089522   :: 只动一个会话（测试用）
node scripts\switch-model.mjs --to minimax --force       :: 档位没变也要重建会话
node scripts\switch-model.mjs --to minimax --effort off  :: 强制把 dsh.reasoningEffort 删掉（= off）
node scripts\switch-model.mjs --to deepseek --keep-effort :: 只换模型，不动思考强度
```

- **幂等**：`config.json` 已经是目标档位时，打印「已经是该档位」并**跳过**（不备份、不杀进程、不发
  通知）。想在同一档位上重建会话，加 `--force`。
- **失败安全**：任一步失败会打印回滚命令；若失败发生在杀进程**之前**，脚本还会自动把两个文件还原回
  备份。
- `--only <key>` 用在**既不在白名单、也没有现存映射**的 key 上会直接报错退出（防呆：写错 key 不该
  看起来像成功）；key 在白名单里但暂时没有映射时只提示「没有可退役的对象」，配置照改、桥接照重启。

### 代价（切换前请知道）

- **被切换的会话上下文清空**：重建后从零开始，历史聊天记录（QQ 侧）还在，但 DSH 会话记忆没了。
- 重启桥接期间（约 5~10 秒，守护的固定等待是 5 秒）到达的消息可能得不到及时回复。
- 记忆桶、黑话库、表情库、巡逻日志**不受影响**（脚本压根不碰它们）。

### 回滚

```bat
copy /Y "<仓库根>\config.json.bak-switch-20261009T191500"        "<仓库根>\config.json"
copy /Y "<仓库根>\state\sessions.json.bak-switch-20261009T191500" "<仓库根>\state\sessions.json"
```

（时间戳换成实际那个备份的。）还原只是把文件放回去；要让还原后的档位对**已有**会话生效，还得再退役
重建一次——重跑一次切换脚本，或手动删映射 + 杀 `state\bridge.lock` 里的 PID。失败时脚本会把这两条
命令打出来，直接复制即可。

**不要**用 `restart.bat`，**不要**重启 DSH：守护（`start.bat` 窗口）本来就会把被杀的桥接拉起来。

## 2. 额度检查

```bat
node scripts\check-model-quota.mjs              :: 查两边 + 给主人发一条余额汇报（每次运行都发）
node scripts\check-model-quota.mjs --quiet      :: 只打印，不发消息
node scripts\check-model-quota.mjs --json       :: 机器可读
node scripts\check-model-quota.mjs --min-balance 5   :: DeepSeek 余额低于 5 元也算不足
node scripts\check-model-quota.mjs --only-on-change  :: 退回旧行为（只在状态变化时发，给将来的定时任务用）
node scripts\check-model-quota.mjs --self-test-direction :: 方向自检：bat 名配不配对该边（只打印，不发消息）
```

- **默认每次都汇报**（主人明确要求）：双击 `检查模型额度.bat` 或直接跑脚本，**每次**都会发一条私聊，
  内容含两边真实数字 —— MiniMax 的窗口剩余时间 + 探针结论、DeepSeek 的可用余额、以及「现在跑在
  哪个档位、够不够用」。`state/quota-watch.json` 只用来记录状态/上次汇报结果，**默认不再用它抑制发送**。
- **只有当前在用的那一边不足**时，汇报里才追加一句处置建议，并且方向由 `SIDES` 表推出（当前 MiniMax
  不足 ⇒ 指向 `切换模型到DeepSeek.bat`，反之亦然），绝不出现反方向的 bat。方向有自动化断言：
  `--self-test-direction` 会构造两种「当前这边不足」的场景，逐字检查文案里的 bat 名与「切到 X」是否一致，
  不一致就以退出码 2 失败（见 scripts/check-model-quota.mjs 的 assertDirection()）。
- 文案示例（真实跑出来的一条）：
  `额度检查：MiniMax 窗口还剩 41m（探针正常），DeepSeek 余额 20.31 元，现在跑在 MiniMax 上，这边够用。`
  当前这边不足时会追加：`要马上切走就双击『切换模型到DeepSeek.bat』切到 DeepSeek（这边额度用尽）。`
- **MiniMax**：`GET https://api.minimaxi.com/v1/token_plan/remains` 拿窗口时间/百分比（这个端点只给
  窗口，不给可靠用量，所以**只展示**），再发一个 `max_tokens: 1` 的**探针**请求；探针失败且错误像额度
  问题（额度/余额/超限/402/429…）⇒ 判定「不足」。鉴权、网络类失败判为「未知」，汇报里如实写「无结论」，
  不编数字。
- **DeepSeek**：`GET https://api.deepseek.com/user/balance` 看 `is_available` 与 `total_balance`。
- Key 从 `~/.dsh/.credentials.yaml` 的 `refs` 读（`MINIMAX_CN_API_KEY` / `DEEPSEEK_API_KEY`），
  同名环境变量优先（方便临时换 Key 自测）。脚本只打印掩码，**不打印完整 Key**。

### 通知通道（为什么是 `/api/test-send`）

私聊走桥接控制台的 **`POST http://127.0.0.1:<consolePort>/api/test-send`**，只带 `x-console-token`
（值从 `config.json` 的 `consoleToken` 读，脚本从不打印它）。

**不能**用 `/api/socialV2/send-message`：即使带控制台令牌，那个端点也强制要求 `x-agent-token`
（`src/bridge.js`：「reserved2 模式发送必须携带 agent token」→ 无令牌 403），独立运维脚本不该持有
会话令牌。`/api/test-send` 是控制台自带的操作者通道，白名单内目标即可发，正好够用。

## 3. 挂 Windows 任务计划做定时检查（命令给在这里，**没有执行**）

直接跑 node（推荐，`node` 在本机是 `node`）：

```bat
schtasks /Create /TN "QQ桥接-模型额度检查" /TR "node \"<仓库根>\scripts\check-model-quota.mjs\"" /SC MINUTE /MO 30 /RL LIMITED /F
```

- `/MO 30` = 每 30 分钟一次；`/RL LIMITED` = 普通权限（不需要管理员）。
- 上面两条 `schtasks` 命令**没有在本机执行过**（任务是「给命令、别跑」）。如果本机的 `schtasks`
  对 `/TR` 里的 `\"` 解析不合口味，直接用下面的 PowerShell 版本：它没有引号歧义，效果等价。
- 想留日志（任务计划不经过 shell，重定向要套一层 cmd）：

```bat
schtasks /Create /TN "QQ桥接-模型额度检查" /TR "cmd /c \"node \"\"<仓库根>\scripts\check-model-quota.mjs\"\" >> \"<仓库根>\state\quota-check.log\" 2>&1\"" /SC MINUTE /MO 30 /RL LIMITED /F
```

- PowerShell 等价（日志更好写）：

```powershell
$act = New-ScheduledTaskAction -Execute 'node' -Argument '"<仓库根>\scripts\check-model-quota.mjs"' -WorkingDirectory '<仓库根>'
Register-ScheduledTask -TaskName 'QQ桥接-模型额度检查' -Action $act -Trigger (New-ScheduledTaskTrigger -Once -At 09:00 -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration ([TimeSpan]::MaxValue)) -Force
```

其他常用命令：

```bat
schtasks /Query  /TN "QQ桥接-模型额度检查" /V /FO LIST
schtasks /Run    /TN "QQ桥接-模型额度检查"
schtasks /Delete /TN "QQ桥接-模型额度检查" /F
```

> 别把 `检查模型额度.bat` 直接挂进任务计划：它结尾有 `pause`，无人值守时会一直挂着不退出。
> 任务计划请按上面的 `node` 命令；`pause` 只是给双击用的。

## 4. 已知问题（实测踩到的坑）

### 4.1 `minimax-cn / MiniMax-M3.1-Flash-Preview` 的 reasoningEffort：已修（2026-10-09 晚）

**症状**：切到该模型后 `state/bridge.log` 反复出现
`设置会话模型失败 … session/model-unavailable: … does not support reasoning effort "high"`，
会话退回 DSH 的会话默认模型（本机默认恰好也是这个模型，所以账本看着是对的——别被这个巧合骗了）。

**原因有两层**：

1. **DSH 侧**：`cordis.patch.yml` 里的 M3.1 是手写条目，没声明 `reasoningEfforts`，
   `dsh-llm-pi-ai` 就把它当**非推理模型** ⇒ 请求里只要带 `reasoningEffort`（连 `off`）都被 `dsh-llm` 抛掉。
2. **桥接侧**：`src/bridge.js` 的 `ensureChatModel()` 有兜底
   `String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT)`（默认 `'max'`），白名单只有
   `['low','high','max']` ⇒ **"删掉这个键" ≠ "不发这个参数"**，会变成发 `'max'`。

**关键事实：MiniMax 自己是接受这个参数的**（直连 API 实测）：

```
不带参数（对照）        200  out=29  reasoning 字段=有    ← 它会思考
reasoning_effort=low    200  out=3   reasoning 字段=无    ← 生效，思考被压低
reasoning_effort=high   200  out=3   reasoning 字段=无
thinking={disabled}     400  invalid params（只能调深度，不能关掉）
```

所以问题不在 MiniMax，而在本地模型声明缺了能力元数据。

**已做的修**（因此 `switch-model.mjs` 的 minimax 档位策略是**显式写 `high`**）：

- `~/.dsh/profiles/desktop/cordis.patch.yml` 给 M3.1 条目补上 `reasoningEfforts: [low, high]`
  （备份 `cordis.patch.yml.bak-efforts-*`）；
- `config.json` 的 `dsh.reasoningEffort` = `"high"`（桥接白名单只认 low/high/max，必须显式给值）；
- **改完要重启一次 DSH**（供应商能力声明是启动时读的）；
- 验证：切换后 `state/bridge.log` 不再出现 `设置会话模型失败`，且账本里该 key 的 `provider/model`
  为 `minimax-cn / MiniMax-M3.1-Flash-Preview`；`node scripts/check-reasoning-effort.mjs` 可复核支持集合。

其他注意事项：

- `.bat` 必须是 **CRLF** 换行 + UTF-8（无 BOM）。LF-only 的 bat 在 `chcp 65001` 下会让 cmd 把中文
  echo 行解析坏（会报 `'…' is not recognized as an internal or external command`）。
- `--only` 只该用于测试。默认（不带 `--only`）会退役**全部**会话——所有 QQ 群和私聊的上下文都会清零。
- 脚本只杀桥接 PID，不碰 `restart.bat`、不重启 DSH。

## 5. 要改档位常量 / 加参数时

两个档位（provider + model + reasoningEffort 策略）写死在 `scripts/switch-model.mjs` 顶部的
`PROFILES`；探针用的模型名在 `scripts/check-model-quota.mjs` 的 `MINIMAX_PROBE_MODEL`；两个 bat 名与
provider 的对应关系在 `check-model-quota.mjs` 的 `SIDES`（方向断言以它为准）。换模型先改常量，再核对
本 README 里的数字，并跑一次 `node scripts/check-reasoning-effort.mjs` 看新模型接受哪些强度。
