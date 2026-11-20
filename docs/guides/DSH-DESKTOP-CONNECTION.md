# DSH Desktop 连接与随机端口

Windows 上 DSH Desktop 重启后可能监听新的随机本地端口。桥接会尝试自动发现并跟随当前实例的端口，避免每次都手动改配置。

## 策略

自动发现按顺序执行，任何一步不通过都不会切换连接：

1. 通过进程归属找到 DSH Desktop 可能正在监听的本地端口，排除其它程序占用的端口。
2. 通过 DSH 鉴权并核验 qq-mode 命名空间，确认候选端点确实是本项目的 DSH 实例（qq-mode 是鉴权后 `settings` 返回的命名空间核验，不是独立鉴权机制）。
3. 验证通过后只更新桥接进程内的连接，不写回 `config.json`。

每轮发现都有时间预算；本轮未成功时按既有节奏持续重试，重试不会与上一轮重叠。相关日志统一带 `[dsh-discovery]` 前缀，记录阶段、原因和耗时。

## 不持久化的理由

自动发现结果不写入 `config.json`。随机端口是 DSH Desktop 的运行期属性，写回会让显式地址与真实状态混淆，也可能覆盖手工填写的 `dsh.baseUrl`；保持配置原样，重启桥接后仍以配置为起点，再按需自动跟随。

## 端口变化时如何排查

1. 在日志中搜索 `[dsh-discovery]`，确认失败发生在发现阶段还是鉴权阶段。
2. 确认 DSH Desktop 已启动，且与桥接在同一台机器、同一用户会话下。
3. 确认配套 QQ 插件已安装并在 DSH 中启用。
4. 多个安装或实例共享同一个 `DSH_HOME` 时，仅凭进程名与命名空间无法唯一确定目标实例，选择存在歧义；应关闭自动发现并手动固定地址。
5. 需要固定地址时，不只改 `dsh.baseUrl`：同时把 `dsh.autoDiscoverDesktop` 设为 `false` 并重启桥接，否则发现失败后桥接仍可能跟随其它实例。该开关只禁止桥接自动切换，并不会让 DSH 本身使用固定端口。

## 当前限制

- 覆盖范围以 Windows DSH Desktop 为主；其它平台和非 Desktop 版 DSH 未逐一验证，仍以 `dsh.baseUrl` 为准。
- DSH 未启动、未安装 QQ 插件、共享 `DSH_HOME` 等场景无法靠自动发现解决，需要手动检查；共享 `DSH_HOME` 时多实例无法可靠自动识别目标实例，可设置 `dsh.autoDiscoverDesktop=false` 并手动指定地址。
- 不承诺消息处理不受阻塞，也不承诺固定恢复时限：发现与重试的耗时取决于运行环境，恢复取决于 DSH 重启与实际重试节奏。
- 不会自动修改 `config.json`，也不替代凭据和鉴权配置。

## 离线测试

相关回归不依赖本机 DSH 或真实端口，可用以下命令离线运行：

```powershell
node scripts/test-dsh-desktop.mjs
node scripts/test-dsh-connection-watch.mjs
node scripts/test-dsh-discovery-logging.mjs
```

三个脚本都在测试进程内模拟端口发现与鉴权结果，不连接真实 DSH，也不读取或写入 `config.json`；它们已注册进 `scripts/test-suite-manifest.mjs` 的 full 与 quick 门禁。
