# 本地改动清单与重打方式（升级桥接包后必看）

> 状态：✅ 生效中（2026-10-04 整理）
> 用途：本仓库在**上游 qq-bridge 代码之上**打了几处本地补丁。升级（覆盖 `src/bridge.js` /
> 重建 `restart.bat` / 重置 DSH profile）会把它们抹掉，症状往往是「某功能悄悄失效」而不是报错。
> 这份清单逐个记录**改在哪、为什么、怎么重打、怎么验证**。
>
> 相关：跨会话共享记忆的完整补丁点清单见 **[SHARED_MEMORY_PATCH.md](SHARED_MEMORY_PATCH.md)**。

---

## 1. 跨会话共享记忆（src/bridge.js）

让群会话与私聊会话共享「进行中的话题」和「对群友的印象」（pendingThoughts 保持会话私有）。

- 位置：`src/bridge.js` 里 `sharedMemoryV2()` 及其周边一整段（安全基线 / 印象 uid 主键 /
  快照回滚都在这一片）。
- 重打：见 [SHARED_MEMORY_PATCH.md](SHARED_MEMORY_PATCH.md) 的「补丁点清单」（7 处核心 +
  依赖的 memory-update / memory-query / 续期循环）。
- 验证：`npm run test:shared-memory`（抽取式断言，补丁被覆盖或标记改名会直接 FAIL）。
- 回归检查点：`state/social-v2.json` 顶层必须有 `sharedMemory`；
  `pendingThoughts` 只能出现在 `conversations.<key>.pendingThoughts`。

## 2. 记忆每日快照 + 控制台回滚（src/bridge.js，2026-10-04 新增）

被污染/误写后能一键回到昨天的状态。

- 代码位置（行号会漂移，以函数名为准）：
  `MEMORY_SNAPSHOT_DIR`（:9187）、`memorySnapshotConfigV2()`（:9190）、
  `memorySnapshotDateV2()`（:9199）、`buildMemorySnapshotV2()`（:9204）、
  `isSafeSnapshotFileNameV2()`（:9230）、`writeMemorySnapshotV2()`（:9235）、
  `pruneMemorySnapshotsV2()`（:9252）、`ensureDailyMemorySnapshotV2()`（:9274）、
  `listMemorySnapshotsV2()`（:9288）、`rollbackMemoryFromSnapshotV2()`（:9324）。
- 落盘钩子：`saveSocialV2State()` 末尾调用 `ensureDailyMemorySnapshotV2()`（:8322）——
  **启动时** load 结束会落盘一次、**跨天后**第一笔落盘各触发一次「日期变更检测」，
  不需要长驻定时器。
- 接口（**仅控制台**，t6 起的**正向前置标记**：请求必须带 `x-console-admin: 1`，且不带
  `x-agent-call`/`x-agent-token` —— 判据是 `if (!isConsoleAdminRequestV2(req)) { …403… }`；
  裸请求 / 只带控制台令牌的请求同样 403，且 403 在读 body、碰 `state/memory-snapshots` **之前**返回，
  被拒调用零副作用。独立评审 t11 verdict = pass。行号按 2026-10-04 22:1x 核对）：
  - `GET /api/socialV2/memory-snapshots`（:6564-6576）→ `{ ok, enabled, keepDays, dir, count, snapshots[] }`，
    每条含 `file / date / createdAtIso / reason / size / conversations / topics / impressions`。
  - `POST /api/socialV2/memory-rollback`（:6578-6588）body `{ date: "YYYY-MM-DD" }` 或 `{ file: "…json" }`；
    回滚前自动写一份 `YYYY-MM-DD-pre-rollback-<HHmmssmmm>.json`（**毫秒级**时间戳；万一同名再自动追加
    `-1`/`-2`…）—— 同一秒内连续两次回滚不会覆盖回滚源文件（t17-low#1 修复）。
  - `POST /api/socialV2/memory-snapshot`（:6591-6601）手动补一份快照（控制台「立即存档」/回滚前兜底）。
    **命名规则（t4 起）**：当天 daily 快照已存在时，写**独立文件** `<日期>-manual-<HHmmss>.json`
    （例 `2026-10-04-manual-210930.json`，reason=`manual-console`；同名时自动追加 `-1`），**绝不覆盖 daily**（daily 的内容与
    reason 保持原样，响应里 `keptDailySnapshot: true`）；只有 daily 还不存在时才落 `<日期>.json`。
- 配置（`config.json`，都可选）：
  ```jsonc
  "socialV2": { "memory": { "snapshotEnabled": true, "snapshotKeepDays": 30 } }
  ```
- 快照格式：
  ```jsonc
  {
    "date": "2026-10-04",
    "createdAt": 1791119000000,
    "createdAtIso": "2026-10-04T13:03:20.000Z",
    "reason": "daily" | "pre-rollback" | "manual-console",   // 文件名：<日期>.json / <日期>-pre-rollback-HHmmss.json / <日期>-manual-HHmmss.json
    "sharedMemory": { "activeTopics": [...], "memberImpressions": {...}, "confirmedTargets": [...] },
    "conversations": { "group:123": { "activeTopics": [...], "memberImpressions": {...} } }
  }
  ```
  **不含 pendingThoughts**（会话私有；回滚也不动它）。
- 保留策略：超过 `snapshotKeepDays`（默认 30 天，含今天）的快照在写快照时自动清理。
- 回滚语义：只覆盖「快照里出现过的会话」的 activeTopics/memberImpressions + 整个共享桶；
  其余会话保持不动；写回后走一遍 clamp（TTL/上限/危险键过滤）。
- 验证：`node -e "const fs=require('fs');const d=new Date().toISOString().slice(0,10);
  if(!fs.existsSync('state/memory-snapshots/'+d+'.json'))throw new Error('missing snapshot');
  console.log('snapshot ok')"`；控制台可 `GET /api/socialV2/memory-snapshots` 看到当天条目。

## 3. activeHours：主动机会时间窗（src/bridge.js）

- 位置：`scheduleProactiveCheckV2()` 的定时器回调里，`// === 主动机会时间窗（本地补丁，升级后需重打）===`
  那一段（当前 :10974-10986）。
- 行为：读 `config.json` 的 `socialV2.proactive.activeHours = { start: 7, end: 23 }`；
  窗口外**只重新排期**，不摇概率、不唤醒（深夜不再主动找人说话）。
- 重打：把这段 `{ const _ah = cfg.socialV2?.proactive?.activeHours; … if (!_in) { scheduleProactiveCheckV2(key); return; } }`
  贴回 `st.proactiveTimer = setTimeout(() => { … })` 内部、且要在 `idleThreshold` 判断**之前**。
- 验证：把 `activeHours` 临时设成当前小时之外，观察 `bridge.log` 不再出现
  「已安排主动机会检查 …，约 Nmin 后」之后的实际唤醒；恢复配置后正常。

## 4. restart.bat：stdin 等待修复 + 按 PID 杀进程（restart.bat）

- 位置：`restart.bat` 全文（本次整理时已写进批注，见文件内 `rem` 说明）。
- 两个问题：
  1. 旧版用 `timeout /t 3 /nobreak` 等待旧进程退出 —— stdin 被重定向时 cmd 直接报
     `Input redirection is not supported` 并**跳过等待**，于是「锁已删、旧进程还在」→ 双实例窗口。
     现改为 `powershell -NoProfile -Command "Start-Sleep -Seconds 3"`（不依赖 stdin）。
  2. 旧版按 `*%~dp0src\bridge.js*` 匹配命令行 —— start.bat 是用相对路径启动的
     （`node src/bridge.js`），命令行里根本没有绝对路径，所以**永远匹配不上**，
     「重启」只是又起了一个实例。现改为「读 `state/bridge.lock` 里的 PID + 按 `*bridge.js*`
     兜底」两条路一起杀，并在删除锁之前确认没有存活进程（否则中止重启并提示）。
- 重打：直接沿用当前 `restart.bat`；上游覆盖后用这份的这几行替换回去即可。
- 验证：`restart.bat` 跑完后 `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` 只应有
  一个 `node src/bridge.js`；`state/bridge.log` 不应出现两个实例同时加入 DSH 事件流。

## 5. profile 的 yun-xi-gpt / deepseek-account retryPolicy（DSH 侧，不在本仓库）

- 位置：`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`（**DSH profile**，不在 qq-bridge 仓库里）。
- 内容：给 `llm-pi-ai` 插件的 `yun-xi-gpt` provider 加了重试策略，并把同一套策略复制给
  `llm-deepseek-account`：
  ```yaml
  retryPolicy:
    mode: normal
    maxRetries: 5
    retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, MALFORMED_RESPONSE]
    backoff: { initialDelayMs: 800, maxDelayMs: 15000, jitterRatio: 0.1 }
  ```
  **据实说明（2026-10-04 t5 独立评审后改写，原说法有误导）**：这段改动在 `yun-xi-gpt`
  （`api: openai-completions`）这条路由上的**实际 delta 只有退避时间**（500ms/10s → 800ms/15s）：
  - `TRANSPORT` **本来就是默认重试项**（出厂默认 `retryableCodes` 就含 `TRANSPORT`，
    默认 `maxRetries=5` / backoff 500ms~10s），所以「把 TRANSPORT 纳入重试」不是这次新增的能力；
  - `MALFORMED_RESPONSE` 在这条路由上**不可达**（pi-ai 适配器的 `classifyPiAiError` 只产生
    `AUTH / QUOTA_EXCEEDED / RATE_LIMIT / INVALID_REQUEST / SERVER / TIMEOUT / TRANSPORT / PI_AI_ERROR`；
    全 asar 搜 `MALFORMED_RESPONSE` 只命中 `dsh-llm-deepseek`，那是 DeepSeek 原生协议适配器）；
  - 结论：**这次只加了退避，并没有修好「断流导致整轮失败」**。别再以为它已修好。
  - 真正排查方向：会话里的 `llm/retry` / `llm/retry-started` 事件（重试到底有没有发生），
    以及失败是否落在**不在任何 `retryableCodes` 里**的码上（如 `PI_AI_ERROR`、`STREAM_CLOSED`）。
    重试有硬上限（`maxRetries=5`，同一 provider+策略最多 6 次请求/step），不会无限重试，
    最坏成本放大就是 6 倍单次请求。
- 重打：profile 被重置/重装插件后，把上面这段贴回 `providers.yun-xi-gpt`（以及
  `llm-deepseek-account` 的 `config`）下。改前先备份 —— 目录里已有历史备份可参照：
  `cordis.patch.yml.before-retry-fix-*.yml`、`cordis.patch.yml.before-piai-retry-*.yml`。
- 验证：DSH 里用该 provider 跑一个会断流/超时的请求，日志应出现重试而不是直接失败；
  `yun-xi-gpt` 与 `deepseek-account` 两处 `retryableCodes` 都要含 `TRANSPORT`
  （**注意**：命中重试≠断流已修；要按上面「真正排查方向」看 `llm/retry` 事件与失败码）。

---

## 6. 本轮（2026-10-04 t19）桥接侧 4 处加固（src/bridge.js，含一处安全修复）

四处都是**相对上游的本地补丁**，升级覆盖 `src/bridge.js` 后会丢；锚点与改动前/后见
**[SHARED_MEMORY_REPLAY.md](SHARED_MEMORY_REPLAY.md) §3.1 与 §4 第 27–34 行**
（锚点表会被 `npm run test:shared-memory` 逐条机器核对）。

| 补丁 | 一句话 | 备份 |
| --- | --- | --- |
| N2 快照兜底名白名单 | 去重后缀 `(-\d{1,3})?` → `(-\d{1,13})?`，兜底名快照不再从列表/回滚源里消失 | `src/bridge.js.before-t19-snapshot-low-2026-10-04T13-49-20-694Z` |
| N4 快照失败日志常量 | 新增 `MEMORY_SNAPSHOT_FAIL_LOG_V2`，三处快照失败共用一条可 grep 的文案 | 同上 |
| **N5 快照端点正向前置标记** | 三个端点由负向 `isAgentCallerV2(req)` 改成 `!isConsoleAdminRequestV2(req)`，**封死「裸请求反而放行」的 fail-open** | `src/bridge.js.before-t19-endpoint-marker-2026-10-04T13-55-03-839Z` |
| N7 印象渲染 uid 开关 | 新增 `impressionRenderUidV2()`（严格只认 `false`，缺省 true） | `src/bridge.js.before-t19-uid-switch-2026-10-04T13-56-52-781Z` |

- 重打：按 SHARED_MEMORY_REPLAY.md §3.1 的四条「改前 → 改后」贴回；然后 `node --check src/bridge.js`
  与 `npm run test:shared-memory`（锚点表会核对第 27–34 行）。
- 验证（N5，**必须重启后再做**）：重启桥接，然后用控制台令牌对三个端点各做一次「带/不带
  `x-console-admin: 1`」的请求：
  ```bash
  # 应 403（只带令牌）
  curl -H "x-console-token: <token>" http://127.0.0.1:3100/api/socialV2/memory-snapshots
  # 应 200（令牌 + 管理端标记）
  curl -H "x-console-token: <token>" -H "x-console-admin: 1" http://127.0.0.1:3100/api/socialV2/memory-snapshots
  ```
  令牌来源：`config.json` 的 `consoleToken` 或 `state/console-token`（鉴权见 `src/bridge.js:3094-3110`，
  也支持 `?token=`）。**重启前**测到的一律是旧进程的行为（本轮就踩过：线上 PID 早于补丁落盘时间）。

## 7. start.bat：守护自愈（exit 2 不再自杀）

- 位置：`start.bat`（本轮 t2 修，t19 补第二处 `timeout` 兜底）。
- 改前：桥接以 `exit 2` 退出（判定「已有实例 / 控制台端口被占」）时，守护窗口 `pause` 后
  `exit /b 2` —— **守护自己退出**，再没人拉桥接。2026-10-04 21:16 因此离线约 20 分钟
  （`state/bridge.log` 21:16:48 → 21:37:07 零日志）。
- 改后：`if "%code%"=="2" goto bridge-busy`（:12）→ 打一行带时间戳的日志 → **有界等待 20s**
  → `goto loop` 重试（:26-32）；正常重启分支的 5s 等待也补了 stdin 兜底（:13-17）。
  两处都用「`timeout` + `if errorlevel 1 ping -n N 127.0.0.1`」：`timeout` 在 stdin 不是控制台时
  会**立刻返回**，此时由 ping 把等待补上（`ping -n 6` ≈ 5s、`ping -n 21` ≈ 20s）。
- 离线回归：`node scripts/test-start-guard.mjs`（临时目录 + 桩桥接，不碰线上端口；自带 watchdog），
  本轮 t17 已把它登记进聚合审计 `scripts/test-audit.mjs`（数组里 `'test-start-guard.mjs'`）→
  `npm run test:audit` 会一起跑（套件因此 +1 个脚本）。
- 验证：重启后 `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` 只应有 **1 个**
  `node src/bridge.js`；`state/bridge.log` 不应出现两个实例同时加入 DSH 事件流。

## 8. 新配置项：`socialV2.memory.impressionRenderUid`

- 位置：`config.json` 的 `socialV2.memory` 下（可选；代码在 `src/bridge.js:9037-9040` 的
  `impressionRenderUidV2()`，渲染点 :9044）。
- 语义：**严格只认 boolean `false`** —— 写 `false` 时印象渲染成 `昵称`（不带 QQ 号）；
  缺省 / 值是 `true` / 类型不对（字符串 `"false"`、`0`、`null`）一律按 `true`，即**默认与旧行为逐字一致**。
  ```jsonc
  "socialV2": { "memory": { "impressionRenderUid": false } }   // 想隐藏 QQ 号时再加
  ```
- 影响面：**只影响渲染层是否带 QQ 号**（唤醒提示词 / 控制台展示）；不影响 uid 主键存储、
  印象归属校验（`sharedTargetAllowedV2` 等）与快照内容。
- 验证：`npm run test:shared-memory`（默认行为的断言在「印象渲染成「昵称（uid）」」那两条；
  ⚠️ `false` 分支目前**没有**专门断言 —— 见 [UPGRADE-RETRO-2026-10-04.md](UPGRADE-RETRO-2026-10-04.md) §3）。

---

## 升级后的自检顺序（建议）

1. `node --check src/bridge.js`；
2. `npm run test:shared-memory`（共享记忆补丁是否还在）；
3. 重启后看 `state/social-v2.json`：顶层有 `sharedMemory`、`pendingThoughts` 只在会话桶里；
4. `state/memory-snapshots/<今天>.json` 是否生成（快照补丁是否还在）；
5. 控制台 `GET /api/socialV2/memory-snapshots` 能否列出条目；
6. 深夜时段观察是否还会被主动唤醒（activeHours 补丁是否还在）；
7. 跑一次 `restart.bat`，确认只有一个桥接实例；
8. DSH 侧抽查 `cordis.patch.yml` 里 `yun-xi-gpt` 的 `retryPolicy.retryableCodes` 是否含 `TRANSPORT`
   （**注意**：这只能证明配置在，不能证明断流已修 —— 见 §5 的「据实说明」）；
9. 桥接**重启后**抽查三个快照端点的 403/200 矩阵（见 §6 的 curl），确认 N5 的正向标记生效；
10. `node scripts/test-start-guard.mjs`（或整跑 `npm run test:audit`）确认守护自愈没被改回去。
