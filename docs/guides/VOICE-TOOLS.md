# 语音工具速查（当前权威）

> 本文档是语音工具说明的**唯一权威**：取代已被删除的根目录 README 里的语音段落，也取代过渡期的
> `docs/guides/VOICE.md`（那份未随本仓库跟踪）。这里只写"现在真实存在的入口与边界"，不承诺任何
> 尚未就位的东西。

## 1. 两个入口：都在仓库外的 `../voice-tool/`

独立的「发语音」工具**不在本仓库里**，它和本仓库同级，位于仓库上一级的 `voice-tool/` 目录：

| 入口 | 文件 | 形态 |
| --- | --- | --- |
| 图形界面 | `../voice-tool/voice-gui.mjs` | 双击上级的 `发语音-图形界面.cmd`，在浏览器里打开本地页面 |
| 命令行 | `../voice-tool/voice-cli.mjs` | 终端里的交互菜单，逐个选语音文件试发 |

- 这两个入口是**外置工具**：克隆本仓库不会带上它们，本仓库里也没有它们的副本。
- "本机有没有这个工具"以 `scripts/voice-tool-locator.mjs` 的解析结果为准：
  `QQ_BRIDGE_VOICE_TOOL_DIR` → `<仓库上一级>/voice-tool`。
- 找不到那个目录时，相关自检会打印 **⏭ 跳过（不是通过）**，不会假装检查过。
- 本文档**不保证这两个文件已安装或已就位**：缺失时按跳过处理，工具缺失不是本仓库的运行时故障。
- 两个入口都通过 `../qq-bridge/src/` 引共享内核（`voice-core.js`），不各自复制一份实现。

## 2. AI 发语音默认关闭

**AI 发语音默认关闭。** 出厂配置（随仓库发布的 `config.example.json`）里
`socialV2.tools.sendVoice=false`、`socialV2.voice.enabled=false`；要启用需要你自己在控制台打开
`sendVoice` 工具开关，或改本机的 `config.json`。

- 关闭时：`qq_send_voice` / `qq_list_voices` 不注册（省 token），`/api/socialV2/send-voice` 直接拒绝。
- 打开后：仍然受静默模式（`shouldBlockSilentReply`）、语音额度（检查 `voiceBudgetCheck` 与记账
  `voiceBudgetCommit` 分离）、发送后回读校验（`verifyVoiceMessageSent`）约束。
- 测试只断言**出厂默认**（`config.example.json`）；本机 `config.json` 的当前值只做提示、不参与判定
  —— 用户按文档打开功能不应让测试变红。

## 3. 与桥接 `audio/` 目录的边界

- 语音库是仓库的 `audio/` 目录（独立工具的配置里 `voiceDir` 默认指向 `qq-bridge/audio`），里面放
  **已经准备好的音频文件**；发送时按文件名从库里取。
- 桥接只**读**这个目录来列表/取文件；文件名必须过审计（`assertOutboundAuditOk`），不接受任意本地
  路径（AI 侧还受 `allowAbsolutePath` 约束）。
- 语音库不是"录音上传"通道：本仓库不提供录音、不做 TTS，也不会往 `audio/` 写音频。
- 目录用仓库相对路径（`qq-bridge/audio`），不写死本机绝对路径 —— 拷贝目录或换机器后仍然可用。

## 4. 生产控制 / 操作者通道 vs AI 通道

两条通道刻意分开，不要混：

| 通道 | 端点 | 受 AI 开关约束？ | 谁用 |
| --- | --- | --- | --- |
| 操作者（生产控制面板） | `/api/voice/send`、`/api/send/voice` | 否 | 人在控制台手动试发 |
| AI（模型工具） | `/api/socialV2/send-voice` | 是（`voice.enabled` + `tools.sendVoice`） | 模型在群聊/私聊里发语音 |

- 操作者通道**不被 `voice.enabled` 挡住**：AI 默认关闭时，你自己仍然能手动试发。
- AI 通道必须两道开关都开；关掉任一即视为关闭。
- 控制台的语音面板（`voiceList` / `voiceSendBtn`）走的是**操作者**端点，不是 AI 通道。

## 5. 相关自检

- `node scripts/test-voice-system.mjs`：结构层总检（入口文件、共享内核、路由、开关、控制台、本文档
  的关键表述）。
- `node scripts/test-voice-doc-check.mjs`：本文档断言的负向回归 —— 缺文档、缺入口名、缺"默认关闭"
  表述都必须判红，合法文档判绿。
- 外置工具不在时，上面脚本里与工具文件相关的断言会显式跳过（`voice-tool-locator.mjs` 口径）；
  但**文档断言不跳过**：`docs/guides/VOICE-TOOLS.md` 缺失就是失败。

## 6. 本文档不写什么

- 不写真实的访问令牌、`SNOWLUMA_TOKEN` 或任何凭据；示例一律用占位符。
- 不写本机绝对路径（带盘符的 Windows 路径、`/Users` 或 `/home` 下的用户目录，一律省略），只用仓库
  相对路径。
- 不声称外置工具"已安装"或"随仓库提供"。
