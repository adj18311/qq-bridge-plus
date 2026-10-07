# 改动记录

**本项目不是原创**：它是 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的二次创作（改进版），**特别鸣谢原作者**。上游基线 `v0.2.0-r3`；上游自己的版本历史看上游仓库的 Releases。

## 0.3.1 — 2026-10-07

### 修复

- **`npm run verify:adaptation` / `npm run verify:persona` 不再要求 DSH 安装目录里能解析到 `@deepseek-ai/dsh-persona`**。新版 DSH 把这几个内部包收进了 `app.asar`，磁盘上给不出可 import 的路径，这两个脚本以前会直接以 module-not-found 崩掉。现在 schema 优先取 DSH 安装处那份（真正会加载我们 preset 的就是它），取不到就退回仓库固定版本的 devDependency（`@deepseek-ai/dsh-persona@0.2.0-rc.2` 及其 peer 依赖）；两边都取不到时，`verify:adaptation` 把这几项记为跳过，而不是崩掉。
- **`mcp 路径指向本仓库` 这条断言不再写死目录名**。它原本硬编码检查路径里是否含 `qq-bridge`（上游的名字），仓库放在别的目录（例如目录名不是 `qq-bridge`）就会假红；现在与当前仓库根比较。
- **`verify:adaptation` 缺 `config.json` 时不再崩溃**。`config.json` 是用户本地文件（仓库只带 `config.example.json`），干净克隆里没有它；现在跳过那条模型检查并写明原因。

### 测试

- 新增 12 个 devDependency：`@deepseek-ai/dsh-persona` 与它的 peer / 运行闭包，版本固定为 `0.2.0-rc.2`（本仓库适配的那版 DSH）。这样上面两项校验在任何克隆里都能复现，而它们是开发期才装的（`npm ci --omit=dev` 不会装，那种情况下脚本会明确跳过并提示）。运行时依赖不受影响：顶层 `@deepseek-ai/schemastery` 仍是 3.18.1，persona 用嵌套的 3.18.4。

## 0.3.0 — 2026-10-05

### 新增

- **卡忙自愈看门狗**：会话被判"忙"之后长时间没有 DSH 帧活动时，自动释放忙标记、补发被静默暂存的唤醒，不再依赖人工重启桥接。判据、阈值、配置、已知限制见 [docs/guides/BUSY_WATCHDOG.md](docs/guides/BUSY_WATCHDOG.md)
- **跨会话共享记忆**：话题与人物印象在群和私聊之间共享；写印象时要么目标是本会话成员，要么是控制台确认过的 uid。配置 `socialV2.sharedMemory`，说明见 [docs/guides/SHARED_MEMORY_PATCH.md](docs/guides/SHARED_MEMORY_PATCH.md)
- **记忆每日快照与回滚**：按本地日期存快照，默认保留 30 天，可以从任意一份回滚；配置 `socialV2.memory.snapshotEnabled` / `snapshotKeepDays`
- **控制台记忆快照面板**：列表、立即存档、回滚（二次确认），在控制台 socialV2 页
- **主动机会时间窗**：`socialV2.proactive.activeHours = { start: 7, end: 23 }`，窗口外不主动开口
- 人格卡补了「发言时机」与「记忆留痕」两节（`roles/小鲸鱼-微调.md`）

### 修复

- 快照相关端点缺管理端校验：只带控制台令牌原本就能过，现在还需要 `x-console-admin` 头
- `start.bat` 守护脚本：子进程以 exit 2 退出时会自我终止，桥接离线后没人拉起；同时修掉"5 秒等待"分支实际只等 76 毫秒的问题
- 记忆快照写失败不再静默，会写日志
- 人物印象主键从昵称换成 uid；改昵称不再留下两条记录
- 空快照文件名的去重边界

### 测试

- 新增 `scripts/test-shared-memory.mjs`（160 条断言）、`scripts/test-start-guard.mjs`、`scripts/test-busy-watchdog.mjs`（35 例）、`scripts/verify-busy-watchdog.mjs`（独立对抗 harness，真定时器 + 真帧链路）
- 聚合审计 `npm run test:audit` 覆盖 34 个脚本；`npm run privacy-scan` 在全新克隆里也能通过

### 升级注意

- 共享记忆与记忆快照是本仓库的补丁，不是上游代码。跟着上游升级会冲突，重打步骤见 [docs/guides/LOCAL_PATCHES.md](docs/guides/LOCAL_PATCHES.md) 与 [docs/guides/SHARED_MEMORY_REPLAY.md](docs/guides/SHARED_MEMORY_REPLAY.md)
- 看门狗的阈值在桥接启动时读取：改完 `socialV2.busyWatchdog.*` 要重启桥接进程

### 已知限制

见 README 的「已知限制」一节，以及 [BUSY_WATCHDOG.md](docs/guides/BUSY_WATCHDOG.md) 末尾。
