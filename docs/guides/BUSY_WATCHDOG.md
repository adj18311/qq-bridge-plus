# 卡忙自愈看门狗（busy watchdog）

2026-10-05 加入。要看代码改动，`git log --grep=watchdog` 能找到对应的提交。

## 它解决什么问题

桥接判断"某个 QQ 会话正在忙"有四个来源：

| 判据 | 什么意思 | 谁会清掉它 |
| --- | --- | --- |
| `pendingWakeTimer` | 已经排好"X 秒后唤醒"，定时器还在 | 定时器到点，或有人取消 |
| `pendingWakeKeys` | 唤醒被暂存，等这一轮忙完再补 | 回合结束，或 30 分钟租约到期 |
| `promptQueues` | DSH 侧的提示队列还没跑完 | DSH 跑完 |
| `v2TurnStartAt` / `collectors` | agent 的回合还没结束 | 回合结束的帧到达 |

四条里只有第二条带超时兜底。另外三条没有。所以只要它们的"结束信号"丢了——DSH 掉线重连、桥接重启正好撞在回合中途、客户端异常退出——这个会话就永久卡在忙的状态。之后所有唤醒都被静默暂存，QQ 那头的感觉是"它不理我了"，只能人工重启桥接。

2026-10-05 早上 08:45 到 09:11 就是这样卡了 25 分钟。

看门狗做的事情很单纯：给这个"忙"加个超时。忙了很久、并且很久没有任何 agent 活动，就强制放掉忙标记，把这期间被暂存的唤醒重新排一遍。

## 判"有没有活动"用的是什么

用 **DSH 事件流的帧**（`/api/remote.mux`）。

QQ 那侧来的新消息不算活动。理由很实际：群里刷屏的时候 agent 可能正卡着不动，如果拿入站消息当活动戳，看门狗永远不会触发，等于没装。

## 三个时间点

| 参数 | 默认 | 做什么 |
| --- | --- | --- |
| `warnMs` | 5 分钟 | 只写一行日志，不释放。留个观察窗口 |
| `releaseMs` | 15 分钟 | 释放忙标记，把积压的唤醒重新排一次 |
| `hardCapMs` | 30 分钟 | 硬上限；同时要求已静默 ≥ `min(warnMs, releaseMs)` |

15 分钟这个数照着"最长合法静默"定。一次长工具调用（跑测试、生成大文件）十几分钟不产出帧是正常的，阈值比它高才不会误伤。

## 释放之后发生什么

1. 清掉这个会话的忙标记（四条判据对应的运行时表都清）
2. 把 `pendingWakeReasons` 里还积压着的相关唤醒按正常路径重排（`scheduleWakeV2`），不旁路直接发送
3. 同一条 `(reason, seq)` 只补发一次

第 3 条是去重。释放的瞬间可能既有残留定时器又有补发在跑，没有去重的话同一条唤醒会投两遍，QQ 上就是同一句话回两次。

## 配置

```json
"socialV2": {
  "busyWatchdog": {
    "enabled": true,
    "warnMs": 300000,
    "releaseMs": 900000,
    "hardCapMs": 1800000,
    "checkIntervalMs": 10000,
    "rearmCooldownMs": 60000,
    "maxRearmPerHour": 3
  }
}
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 设成 `false` 完全停用，退回旧行为 |
| `warnMs` | `300000` | 超过这么久没帧就记一行 |
| `releaseMs` | `900000` | 超过这么久没帧就释放 |
| `hardCapMs` | `1800000` | 硬上限 |
| `checkIntervalMs` | `10000` | 扫描间隔，最小 1000 |
| `rearmCooldownMs` | `60000` | 同一会话两次补发之间的冷却 |
| `maxRearmPerHour` | `3` | 每会话每小时最多补发几次 |

这些值在桥接启动时读进内存。改完要重启 `node src/bridge.js`；控制台里改唤醒参数是热生效的，两回事。

## 怎么知道它在工作

启动时它会报一行：

```
[watchdog] 已启动（checkIntervalMs=10000 warnMs=300000 releaseMs=900000 hardCapMs=1800000 enabled=true）
```

真的释放的时候：

```
[watchdog] release key=private:10000001 busy=1080s idle=912s tier=release released=wake,lease backlog=2 rearm=1
```

`busy` 是进入忙态多久，`idle` 是多久没帧，`tier` 说明这次是按常规释放还是撞到硬上限，`backlog` 是当时积压几条，`rearm` 是这次补发了几条。

平时它一行都不打。如果日志里 WARN 每轮（默认 10 秒）重复，却一直没有 `release`，那说明只命中了第三条判据：那个会话没有可清的标记，看门狗能做的只有反复提醒，这种要人工看一眼。

## 关掉和回滚

改 `config.json`：

```json
"socialV2": { "busyWatchdog": { "enabled": false } }
```

然后只重启桥接进程（守护脚本会在 5 秒内把它拉起来）：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'src/bridge.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId }
```

要把代码也退回去：`git revert <那一笔提交>`，或者 `git checkout <改动前的提交> -- src/bridge.js scripts/test-audit.mjs`。

## 已知限制

- 如果某个回合真的十几分钟一个帧都没有，看门狗会把它当成卡住。释放后那条唤醒可能补发一次，QQ 上表现为重复回一句话。阈值是照着最长合法静默定的，概率不高，但存在；不丢消息，随时可以 `enabled: false` 关掉。
- 卡在 `v2TurnStartAt` / `collectors` 的会话，看门狗只会打 WARN，不会释放（那两条判据没有可清的标记），需要人工重启桥接。这是设计如此。
- 离线队列上限 50 条，满了丢最旧的一条——桥接原本就是这个行为。看门狗只保证一件事：被丢的那条如果带着唤醒，标记一起清掉，别让那条唤醒被永久跳过。
- 释放时会在会话状态里留一条很短的墓碑（`staleBusyTurns`），用来识别"这个回合其实早就结束了"。有界，后续帧会清掉。

## 跑测试

```powershell
npm run test:audit                       # 聚合审计，其中含 test-busy-watchdog（35 例）
node scripts/test-busy-watchdog.mjs      # 只跑看门狗聚焦测试
node scripts/verify-busy-watchdog.mjs    # 独立对抗 harness：真定时器 + 真帧链路

$env:VERIFY_STRICT='1'
node scripts/verify-busy-watchdog.mjs    # 把探针的失败也计入退出码
```

harness 里有几个默认关闭的探针（`VERIFY_F4` / `VERIFY_F6` / `VERIFY_T22FAST`）。想看某个具体场景时用 `VERIFY_ONLY` 定向跑：

```powershell
$env:VERIFY_F6='1'; $env:VERIFY_ONLY='F6 探针'; node scripts/verify-busy-watchdog.mjs
```
