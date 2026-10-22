# 兼容性与支持范围

这份文档说明：哪些环境**真的验证过**，哪些只是"没测"，以及跑在别的平台上要注意什么。发布任何版本前都应该更新这里。

最后更新：2026-10-22（1.1.0）

## 已验证的环境

| 项 | 版本 / 说明 |
|---|---|
| 操作系统 | Windows 11 x64（实机验证） |
| DSH | **Desktop 0.2.1-rc.2**（实机探测三轮：`qq-chat-v2` / `qq-chat` / `standard`，各 17 项通过） |
| Node.js | **>= 22.13.0**（`package.json` 的 `engines` 声明） |
| QQ 网关 | SnowLuma（OneBot v11，WebSocket）。实机验证版本 1.14.x |
| 真实 QQ 收发 | 私聊、群聊、@ / 昵称 / 关键词 / 指定发言人唤醒、图片接收、语音与表情发送，均已在真实账号上验证 |

自动化门禁（实机验证）：

```text
node scripts/test-dsh-cli-resolve.mjs         14/14
node scripts/test-dsh-021-profile-patch.mjs   12/12
node scripts/test-dsh-021-compat.mjs          11/11
npm run test:audit                            78/78
npm run test:quick                            35/35
npm run privacy-scan                          ✅ 未发现敏感信息
```

## 没有验证的（不要当成"支持"）

| 项 | 现状 |
|---|---|
| DSH 0.20 | 上一轮通过过用户验收，**本轮 0.2.1 改动后未重新完整回归**。发布说明必须写明"仅 0.2.1-rc.2 已验" |
| Linux / macOS | **完全没有实机验证**。已知代码路径会在非 Windows 上跳过桌面端点自动发现（`process.platform !== 'win32'`），需要显式配置端点 |
| 其它 OneBot v11 网关（NapCat 等） | 协议上应当可用，但没有实测；SnowLuma 特有的能力（表情、语音回读）不保证 |
| 干净的新机器 | 只做了"隔离 `DSH_HOME` 演练"，没有在第二台物理机 / 全新系统上走过完整安装 |

## 平台差异（重要）

**1. DSH 桌面端点自动发现仅 Windows**

DSH Desktop 0.2.1 起可能用 `--port 0`，监听端口每次重启都变。桥接在 Windows 上会查找 DSH 桌面进程拥有的回环监听并自动跟随；**其它平台不会**，必须在 `config.json` 里显式配置 `dsh.baseUrl`。

**2. Team 工具隔离片段的自动部署依赖 Windows 版本检测**

`scripts/setup-dsh.mjs` 会读 DSH 安装包（ASAR）的版本，≥ 0.2.1 时把 `plugins/qq-agent-presets/compat/dsh-021-team.patch.yml` 合并进 profile。

- 版本读取依赖 `DSH_INSTALL_ASAR` 环境变量，或在 Windows 上从运行中的 DSH 进程找到安装包；
- **非 Windows 或读不到版本时会跳过这一步**（跳过是有意的：绝不给老版本装 0.2.1 专用适配）；
- 跳过时，QQ 预设会获得 DSH 0.2.1 原生的 Team 工具。需要隔离的话，手工把 `plugins/qq-agent-presets/compat/dsh-021-team.patch.yml` 的片段合并进 profile 的补丁文件并重启 DSH（本发布包不附带该操作的分步指南）；
- 可用 `QQ_FORCE_021_TEAM_PATCH=1` 强制部署、`QQ_SKIP_021_TEAM_PATCH=1` 强制跳过。

**3. `dsh` CLI 会自动定位，不在 PATH 里也可以装**

`setup-dsh.mjs` 最后会调用 `dsh plugin --profile <name> install` 物化插件。脚本按「`DSH_CLI` 环境变量 → DSH 安装目录（`<安装根>/resources/runtime/cli/bin/dsh.cmd`，由 ASAR 位置推导）→ 系统 PATH」的顺序自动找 CLI，并始终用**绝对路径**执行，不要求它进 PATH。

- 找到并执行成功：打印「CLI 物化完成（来源=env/asar/path）」；
- 找到但执行失败（非 0 / 超时）：打印 stderr 尾部供排查；脚本的"插件目录 + profile `node_modules`"两级链接兜底仍然生效；
- 三个来源都找不到：只打印 info 级「未找到 dsh CLI；已用两级链接兜底，无需操作」，**不需要**手工改 PATH 或重跑。

想强制指定某个 CLI，可设置 `DSH_CLI` 指向可执行的 `dsh.cmd`；设置错误也不会中断安装，会继续按安装目录 / PATH 找。

**4. profile 是每台机器生成的，不要复制**

setup 会把**当前机器**的 Node 路径、仓库路径写进 profile 的 `cordis.patch.yml`。所以：

- 换机器请重新跑 `node scripts/setup-dsh.mjs <profile>`，不要拷贝别人的 profile；
- 同理，仓库里的示例配置只是模板。

## 可选能力（缺了不影响启动）

| 能力 | 需要什么 | 缺失时的表现 |
|---|---|---|
| 贴吧浏览 / 读帖 / 自主巡逻 | 自己的贴吧小号 cookie，写进文件后只在配置里填路径（`socialV2.tieba.cookieFile`） | 工具会如实报"未配置登录态"，不会假装成功 |
| 语音发送 | 包根 `audio/` 目录里放音频文件 | 语音工具报"库是空的" |
| 发图到 QQ | 无（白名单图床 + 体积上限内） | —— |
| 模型切换 | MiniMax 或 DeepSeek 的订阅 Key（放在 `~/.dsh/.credentials.yaml`） | 只影响模型切换，不影响收发 |

模型额度耗尽的提醒与请求保护功能**本发布不包含**（该功能已冻结）：额度类错误不会单独识别，普通 429 一律按限流处理。

## 已知限制

- 多个 DSH 实例共享同一套凭据与 profile 时，自动发现无法区分它们，可能选错实例；
- 表情库同步在一次启动里可能因 WebSocket 尚未打开而失败一次，属瞬时问题，重启或后续同步会补上；
- DSH 重启会带走由工具/宿主进程启动的桥接（子进程树）；**建议用户自己双击 `start.bat`** 启动桥接，这样它独立于任何工具的进程树。

## 发布纪律

- 发布包必须从**清理过的树**构建：不含 `state/`、真实 `config.json`、`node_modules/`、任何 zip、凭据文件与个人临时文件；
- 本机绝对路径与用户名不得出现在被跟踪文件里（`npm run privacy-scan` 必须通过）；
- 历史提交里若曾出现真实路径，删文件不足以清除——要么重写历史，要么从干净的树新建仓库；
- 文档里不得把"本机验证通过"写成"所有环境兼容"，差异以本文档为准。

包里还带了三个 0.20 的排查脚本（`verify:adaptation:020`、`probe:protocol`、`probe:settings`），是用来对照旧版本行为的，不代表 0.20 受支持。
