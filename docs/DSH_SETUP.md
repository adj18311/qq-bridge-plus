# DSH 端安装说明（另一台设备）

`qq-bridge` 仓库本身包含桥接、控制台和插件，但 **DSH 端的两个聊天模式（`qq-chat` / `qq-chat-v2`）以及 MCP 挂载** 不在仓库根目录，需要通过本说明安装到目标设备的 DSH 环境中。

## 安装步骤

在目标设备上：

1. **克隆/获取仓库**：

   ```bash
   git clone https://github.com/Derpyu520/qq-bridge.git
   cd qq-bridge
   ```

   > 默认分支 `main` 即当前版本 **v0.1.5**（适配 DSH 0.1.5-rc.1），clone 下来无需切换分支。

2. **安装依赖**：

   ```bash
   npm install
   ```

   > `postinstall` 会自动修补 `@snowluma/sdk` 的 ESM 打包 bug。

3. **创建配置文件**：

   ```bash
   cp config.example.json config.json
   ```

   > Windows CMD 用户请用：`copy config.example.json config.json`

   然后编辑 `config.json`，填写：

   - `snowluma.wsUrl` / `httpUrl`（例如 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`，分别对应 OneBot WebSocket 与 HTTP API 端口）
   - `snowluma.accessToken`
   - `dsh.authToken`（新版 DSH 的 launch token，用于换取 Cookie；默认留空，桥接会自动从 DSH guard 日志发现，DSH 重启后也会自动重新发现）
   - `ownerQQ`
   - `allow.private` / `allow.groups`

4. **运行 DSH 端安装脚本**：

   ```bash
   node scripts/setup-dsh.mjs
   ```

   默认安装到 `web` profile；如果 DSH 使用其他 profile，可以传参：

   ```bash
   node scripts/setup-dsh.mjs <profile名>
   ```

   脚本会完成：

   - 安装 agent preset：`~/.dsh/.agent-presets/qq-chat`、`~/.dsh/.agent-presets/qq-chat-v2`
   - 在 `~/.dsh/profiles/web/cordis.patch.yml` 挂载：
     - `mcp-snowluma`（`src/mcp-snowluma-safe.js`，带 `toolCallTimeoutMs: 725000`）
     - `mcp-snowluma-host`（`src/mcp-host-server.js`）
     - `mcp-web-search-safe`（`src/mcp-web-search-safe.js`）
   - 在 `~/.dsh/profiles/web/package.json` 注册 `qq-mode-console` 插件
   - 把 `qq-mode-console` 插件的默认模式设为 `reserved2`（二代仿真）
   - 创建本地 `state/mode.json`（`mode: reserved2`）作为 DSH settings 不可用时的兜底
   - 尝试自动执行 `dsh plugin --profile web install`（当 `dsh` CLI 在 PATH 中可用时），注册 `qq-mode-console` 的 bundle 依赖；若 `dsh` 不在 PATH，缺失依赖时 DSH 会提示补跑

   > 脚本可重复运行；它会覆盖 `~/.dsh/.agent-presets/qq-chat*`、更新 MCP 路径并重建失效的插件链接。
   > MCP 条目是**按条目 id 增删**的（不依赖标记注释），所以旧版本装的补丁也能被正确升级，
   > 不会出现重复 id 或漏装 `mcp-web-search-safe`。可用 `node scripts/test-setup-dsh-idempotent.mjs` 验证幂等性。
   > 已存在的 `qq-bridge/state/mode.json` 会被保留（不覆盖用户设置）；全新安装才会写入 `mode: reserved2`。
   > 如果之后把 `qq-bridge` 目录移动/重新 clone 到别的路径，请重新运行一次本脚本，否则 DSH 里的 MCP/插件绝对路径会指向旧位置。
   > 也可用环境变量指定 DSH 根目录：`DSH_HOME=/path/to/.dsh node scripts/setup-dsh.mjs <profile>`。

5. **重启 DSH**：

   必须重启 DSH（或让 DSH 重新加载 profile），新 preset 和 MCP 工具才会生效。

   > 默认模式为 **`reserved2`（二代仿真）**，即“文本不自动转发、AI 通过工具自主收发”。如果你想改用 `chat` / `closed-agent` / `reserved`，在**桥接控制台**（默认 `http://127.0.0.1:3100`）顶部按钮切换即可 —— 桥接会同时写入 DSH 设置与本地 `state/mode.json`，**无需重启**（每 5 秒轮询即时生效）。注意：DSH 设置侧有值时以 DSH 为准，所以**直接改 `state/mode.json` 不生效**（该文件只兜底 `closedAgentPreset`，见下）。

## 验证是否装好

0. **一键自检**：`npm run verify:adaptation` —— 覆盖 preset persona schema、`~/.dsh` 同步、profile patch、桥接协议与运行中的 DSH 等共 35 项断言（其中 8 项是按文件循环展开的语法检查）。另有 `npm run verify:persona`（只查 persona 配置）。
   > 若你的环境禁止以管道 stdio 拉子进程，脚本内 8 项 `node --check` 语法检查会报 `spawnSync … EPERM`。那是环境限制，可用 `node --check <文件>` 手动复核。

1. **切换桥接模式**：打开桥接控制台（默认 `http://127.0.0.1:3100`），顶部的「聊天模式 / 封闭 Agent / 一代仿真模式 / 二代仿真模式」按钮即为当前生效的切换入口。控制台会同时写入 DSH 设置与本地 `state/mode.json`。
   > ℹ️ DSH 设置页 `Plugins → Plugin configuration` 里**不会**出现 `qq-mode` 卡片：该槽位要求插件自带浏览器半（`package.json` 的 `dsh.client` + `lib/client.js`），而 `plugins/qq-mode-console` 只实现了 host 半。`qq-mode` 命名空间本身正常注册并生效（桥接能读到设置值），缺的只是那张 GUI 表单 —— 所以模式改走控制台。参见下方「常见问题」。
2. **新建会话时**：agent preset 列表中应能看到：
   - `QQ 聊天角色`（`qq-chat`）
   - `QQ 聊天角色（二代仿真）`（`qq-chat-v2`）
3. **工具列表**：QQ 会话中应能看到 `mcp__snowluma__*`、`mcp__snowluma-host__*`、`mcp__web-search-safe__*` 等工具；不应看到 `dev_*` 等开发工具。

## 常见问题

- **看不到 `qq-mode` 设置卡片**：这是**已知限制**，不是配置错误。DSH 的 `settings.plugin.item` 槽位只渲染「host 已注册的命名空间 ∩ 声明了该 key 的卡片」，而卡片必须由插件的**浏览器半**（`package.json` 的 `dsh.client` + `lib/client.js`）注册；`plugins/qq-mode-console` 目前只有 host 半。反复重跑 `setup-dsh.mjs` 或重启 DSH 都不会让卡片出现。要真正修好需补一个 `lib/client.js`。
- **改了模式却不生效 / 5 秒后被改回去**：**此问题已在 `src/bridge.js` 修复**（桥接需重启后生效）。历史成因：`refreshMode()` 每 5 秒被 `checkDsh` 调用一次，先读 DSH 的 `qq-mode` 命名空间，只要有合法值就**直接 return，完全忽略本地 `state/mode.json`**；而插件注册时带 `base: { mode: 'reserved2' }`，所以 DSH 侧永远有值 —— 于是控制台写本地文件会在下一次轮询被覆盖回滚。现在 `POST /api/mode` 会**写穿到 DSH 设置**（`api.settings.update({ ns: 'qq-mode', patch: { mode } })`），响应里新增 `dshSynced` 字段；若写穿失败（DSH 未运行等）会记日志并保留本地值。同源问题：`closedAgentPreset` 在 DSH schema 里不存在，原先也因这个提前 return 而失效，现已改为始终以本地 `state/mode.json` 为准。若仍看到回滚，检查桥接日志里是否有「写穿 DSH 设置失败」。
- **MCP 工具没有出现**：确认 `cordis.patch.yml` 中三个 MCP 条目的路径指向当前仓库，并重启 DSH。
- **preset 没有出现**：确认 `~/.dsh/.agent-presets/qq-chat` 和 `~/.dsh/.agent-presets/qq-chat-v2` 存在，并重启 DSH。
- **启动 DSH 报 `failed to parse overlay cordis.patch.yml: YAMLException`**：多为历史版脚本残留的空数组 `[]` 引发。重新运行最新版脚本（会自动剥离）即可，或手动删除该文件里独立成行的 `[]` 后重启 DSH。
- **启动 DSH 报 `cannot resolve profile bundle "qq-mode-console"`**：profile 的 bundle 依赖尚未安装。运行 `dsh plugin --profile web install`（`web` 换成你的实际 profile 名）后重启 DSH；新版脚本会尝试自动执行这一步。
- **启动 DSH 报 `failed to apply loader entry persona (@deepseek-ai/dsh-persona): invalid config: $.prefix missing required value`**：preset 用的是旧字段 `text`，而 DSH 0.1.5 起 `dsh-persona` 只接受 `prefix` / `suffix` / `complete` / `includeRuntimeContext`。重新运行 `node scripts/setup-dsh.mjs`（本仓库 preset 已改为 `prefix`），或手动把 preset 里的 `text:` 改成 `prefix:`。可用 `node scripts/verify-persona-config.mjs` 提前自检。
- **profile 的 bundle 条目被重置**：升级 DSH 可能重置 `~/.dsh/profiles/web/package.json`，把 `qq-mode-console` 的依赖与 bundle 条目删掉（症状是启动报 `cannot resolve profile bundle`，或桥接读不到 `qq-mode` 设置值）。重新运行 `node scripts/setup-dsh.mjs`，再跑 `dsh plugin --profile web install` 并重启 DSH。
- **QQ preset 挂载失败导致群里的 AI 什么工具都不会用**：桥接建会话时先试「带 preset」，失败则**重试不带 preset** 并打日志 `⚠️ 会话 … 未能挂载 preset …，已降级为无 preset 会话`；只有两次都失败才抛错 `已拒绝退化为 DSH 默认 preset 会话`。⚠️ 注意这里的实际语义与早期文档不同：**「无 preset 会话」= DSH 默认 preset（通常 `standard`，含 bash/文件读写）**，因此降级路径本身就会把本地工具暴露出去；真正的护栏是 `resolvePresetName()` 对**不在 DSH 清单里的 preset 名**回落到 `dshDefaultPreset`（`standard`）。请确保 `~/.dsh/.agent-presets/qq-chat`、`qq-chat-v2` 已安装，并在控制台把 preset 设为有效值或留空。另注：该降级只发生在 `closed-agent` 模式（仅 owner 私聊）；群聊不在该模式准入内。
- **发送消息报 `unauthorized` / HTTP 401**：`config.json` 的 `snowluma.accessToken` 与 SnowLuma 的 OneBot 实例 token 不一致。将 SnowLuma WebUI 中 HTTP 与 WebSocket 两端的 accessToken 设为相同，再填入 `config.json`，然后重启桥。
- **DSH 侧 401/鉴权失败**：新版 DSH 使用 launch token → Cookie 的浏览器会话鉴权。`config.json` 的 `dsh.authToken` 可留空，桥接会自动从 `~/.dsh/guard/logs/server-*.out.log` 发现最新 token；若 DSH 重启导致 Cookie 失效，桥接也会在 HTTP 401 / WebSocket 断线时自动重新发现 token 并换 Cookie。`npm run self-test` 可快速验证 DSH 链路。
- **发送消息报 HTTP 426（Upgrade Required）**：说明 `config.json` 里的 `snowluma.httpUrl` 指向了 **WebSocket 端口**。`httpUrl` 必须是 OneBot 的 **HTTP API 地址**（例如 `http://127.0.0.1:3000`），而 `wsUrl` 才是 WebSocket 地址（例如 `ws://127.0.0.1:3001`）。请在 SnowLuma WebUI 的 OneBot 配置里分别确认 HTTP 和 WebSocket 的端口。也可以运行诊断脚本：
   ```bash
   node scripts/check-onebot-status.mjs
   ```
