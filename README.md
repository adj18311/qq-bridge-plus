# QQ Bridge Plus

QQ Bridge Plus 是 [qq-bridge](https://github.com/Derpyu520/qq-bridge) 的二次开发版本。它通过 SnowLuma 的 OneBot v11 接口接收 QQ 消息，再交给 DeepSeek Harness（DSH）中的智能体处理；智能体可以在授权范围内回复、读取会话消息和使用桥接提供的工具。

感谢上游项目及其贡献者。本仓库的代码使用 MIT 许可；SnowLuma 及其他依赖有各自的许可条件，请同时阅读 [LICENSE](LICENSE) 和 [RULES.md](RULES.md)。本项目不打包 SnowLuma 本体，安装依赖时的 `postinstall` 会对本机安装的 SnowLuma SDK/MCP 包作兼容性修补，详见 LICENSE。

## 能做什么

- 在 QQ 私聊和群聊中与 DSH 智能体对话，通过白名单限制接入范围。
- 使用人格卡、会话唤醒配置、沉睡观察和消息等待；二代仿真模式下可按会话调整行为。
- 保存共享记忆、人物印象和记忆快照，在控制台查看和管理。
- 使用黑话词库、收藏表情、图片、可选语音库，以及只读的贴吧浏览工具。
- 在本地控制台管理会话、角色、工具和配置；提供模型选择、连接状态及日志查看。
- 处理断线与长时间卡忙，并观察 DSH 对 529/503 的原生重试事件。

具体能力受模型、DSH、SnowLuma 和配置影响。贴吧为只读功能，不支持发帖、回复或绕过安全验证。额度为零的专门检测、提醒及自动恢复机制不包含在本次发布包中。

## 开始使用

需要 Node.js 22.13.0 或更新版本、运行中的 DSH Desktop、已登录并启用 OneBot HTTP 和 WebSocket 的 SnowLuma。目前只在 Windows 11 x64 + DSH Desktop 0.2.1-rc.2 上做过实机验证。DSH 0.20 在 0.2.1 的改动之后没有重新跑完整回归，macOS 和 Linux 从没上过真机，这三类都不支持。具体范围见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

1. 阅读[安装步骤](docs/INSTALL.md)，准备依赖并创建本地配置。
2. 运行 `node scripts/setup-dsh.mjs` 安装 DSH 侧预设及 MCP 配置，然后重启 DSH。
3. 启动桥接，在已授权的 QQ 会话中测试收发。
4. 如需贴吧功能，按照[贴吧安装与使用](docs/INSTALL.md#tieba)配置；Cookie 可选，且应保存在仓库外。

默认私聊和群聊白名单为空，桥接不会因此对所有人开放。模板中的人格卡注入上限为 10000 字符；主动机会时间窗为 7:00–23:00，不等同于窗口外完全不响应消息。

## 文档

- [安装步骤与贴吧使用](docs/INSTALL.md)
- [升级说明：相对上游及相对 1.0.0](docs/UPGRADE.md)
- [更新日志](CHANGELOG.md)
- [已知限制与发布前核对](docs/LIMITATIONS.md)
- [兼容性与支持范围](docs/COMPATIBILITY.md)

`roles/` 附带多张人格卡。其中“测试人格Tmp”用于测试，“小鲸鱼-微调”包含粗口规则；不希望使用粗口时可选择“小鲸鱼-微调-无脏话”。请按需选择，不要将测试或微调人格视为默认行为。

## 测试

安装全部依赖后，可运行 `npm run test:quick` 做快速回归，或运行 `npm run test:audit` 做完整自动化审计。离线测试不能代替真实 QQ 收发、DSH 连接和模型调用的端到端验证；涉及在线 DSH 的脚本可能产生测试会话和模型费用，请先确认脚本用途。

请勿提交本地 `config.json`、`state/`、Cookie、访问令牌、个人音频或聊天记录。分享日志前也应检查其中是否含账号、会话内容或其他敏感信息。
