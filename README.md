# QQ Bridge Plus

![version](https://img.shields.io/badge/version-1.1.0-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/platform-Windows%2011%20x64-lightgrey)
![dsh](https://img.shields.io/badge/DSH-0.2.1--rc.2-orange)
[![upstream](https://img.shields.io/badge/upstream-Derpyu520%2Fqq--bridge-informational)](https://github.com/Derpyu520/qq-bridge)

只在 Windows 11 x64 + DSH Desktop 0.2.1-rc.2 上做过实机验证。这是 [qq-bridge](https://github.com/Derpyu520/qq-bridge) 的衍生项目，上游和致谢放到后面单独说。

## 这是什么

QQ Bridge Plus 把一台真实登录的 QQ 账号接到 DeepSeek Harness（下称 DSH）上，让 DSH 里的智能体用这个号在群聊和私聊里说话。

具体点说。SnowLuma 做网关，用 OneBot v11 协议把 QQ 消息推给本项目的桥接进程。桥接按白名单挑出要处理的会话，把消息整理成提示词送进 DSH 的会话。智能体处理完，通过桥接注册的一组 MCP 工具把回复、表情、图片、拍一拍发回 QQ。中间那层桥接是 Node 写的，跑在你自己的机器上，不经过任何中转服务器。当然，模型调用还是走你在 DSH 里配的那个 provider。

它不是你想象中那种“收到消息就调一次 API 回一段文本”的转发脚本。智能体可以选择不说话：有沉睡、唤醒条件、沉睡前的观察窗口，有主动开口的概率和时间窗，有发送节奏和分条上限。群聊里它会先等 3 秒，看看对方是不是还有下半句，再决定接不接。这些行为由配置和 DSH 侧的人格预设共同决定，模型本身也在做判断。同一套配置在不同模型上，表现会不一样。

会话状态、消息映射、共享记忆、黑话词库、收藏表情这些落盘在 `state/`。本地还有一个控制台（默认 `http://127.0.0.1:3100`），能看会话和连接状态、切模式、换人格卡、逐个开关工具、看日志。模型按会话选，`模型管理.bat` 提供一个终端界面，列表直接从 DSH 的模型目录读。

它还有一套只读的贴吧工具。这不是“让模型回忆贴吧内容”，是桥接真的去抓百度贴吧的页面，把吧页列表、帖子正文、楼层回复和楼层图片取回来交给模型。为什么贴吧要单独配置，后面有整整一节。

适合谁：手边有一台常年开着的 Windows 机器、已经在用 DSH Desktop、想让自己的智能体在 QQ 群里有个身份的人。只想跑个自动回复机器人，用不上这么重的东西。

## 一条消息的旅程

从 QQ 里有人说话，到智能体回一句，大致是这样：

1. SnowLuma 把消息通过 WebSocket 推给桥接（默认 `ws://127.0.0.1:3001`）。
2. 桥接检查 `allow.private` / `allow.groups`。默认两个都是空数组，`allowAllWhenEmpty` 是 `false`。装完不配白名单，它对谁都不响应。这是有意的。
3. 消息进本地队列，写进 `state/`。同一个会话短时间内的多条消息会合并成一批，群聊的合并窗口被压过：@、点名、提问这类明确触发最多等 2 秒，其它触发最多 4 秒。配置里写 60 秒也压得住。
4. 唤醒策略决定要不要叫醒智能体：被 @、被叫名字、命中关键词、被提问、被拍一拍、指定发言人发言、按概率随机。没叫醒就继续潜水。
5. 叫醒了，桥接把上下文和未读消息交给 DSH 里跑 `qq-chat-v2` 预设的会话，等它调用工具。
6. 智能体调 `qq_send_message`、`qq_reply`、`qq_send_sticker`、`qq_send_image`、`qq_wait_for_messages`、`qq_memory_append` 之类，桥接把调用翻译成 OneBot 请求发回去。发送有条数、字数、每分钟和每小时的上限。
7. 群聊里还想再等等，就用 `qq_wait_for_messages`。群聊的静默固定 3 秒，首条新消息之后最多再等 6 秒，后续消息不能无限延长。

贴吧工具走的是另一条路：`qq_tieba_list` / `qq_tieba_read` → 桥接的 `/api/socialV2/tieba/*` 端点 → 抓百度页面 → 解析成文本和图片交给模型。这条链路上没有 DSH 模型参与。它和模型配置无关，和网络、Cookie 的关系更大，剩下就看百度的心情。

## 衍生项目与致谢

这是一个衍生项目，不是从零写的。上游是 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，本项目的对照基线是上游 `v0.2.0-r3`（提交 `9df6a7e`）。

接入 SnowLuma、跟 DSH 的会话协议打交道、控制台、人格预设、二代仿真那一整套骨架，基本都是上游打的底子。这些东西不好写。DSH 的鉴权、slash-RPC、`remote.mux` 那一串协议，加上 OneBot 各种消息段和事件顺序的坑，作者是一个一个趟出来的。本项目能站在上面改，是因为上游把这些脏活干完了。谢谢 Derpyu520，也谢谢给上游提过 issue、补过 PR、写过文档的人。

改动之后本项目已经和上游差得比较远，尤其是 `src/core/` 的拆分和贴吧这一块。所以：遇到问题请提到[本仓库的 Issues](https://github.com/adj18311/qq-bridge-plus/issues)，别拿去打扰上游。想用最接近上游的版本，直接去用上游。

代码用 MIT 许可，见 [LICENSE](LICENSE)，里面的版权行仍然是上游和贡献者的。SnowLuma、DSH 及其他依赖有各自的许可，用之前自己读一遍。`npm ci` 的 `postinstall` 会修补本机安装的 SnowLuma SDK/MCP 副本，这一步会动到你 `node_modules` 里的东西。介意的话先看 [LICENSE](LICENSE) 里的说明。

## 相对上游新增了什么

只列这一版真的有的东西：

- 贴吧页面读取。列吧页帖子、读帖子正文和楼层回复、一次翻多页。楼层里的图片会作为图片内容交给模型（一次最多 10 张，单张 4 MiB，合计 25 MiB）。只读，不发帖、不回复、不点赞。
- 图片发送。`qq_send_image` 把白名单图床（目前只放行贴吧图床域名）的图片下载后按 OneBot 图片段发出，单张 4 MiB 封顶，计入该会话的发送频率。
- 按会话选模型 + 模型管理界面。每个会话可以单独指定模型和思考强度，没指定的跟随全局。`模型管理.bat` 打开一个终端界面，菜单从 DSH 的模型目录动态读，改完原子写回 `config.json` 并尝试热生效，失败会如实说“需要重启”。
- DSH 0.2.1 适配。长等待修正；安装脚本按版本门控（0.2.1 才部署 Team 适配片段，老版本绝不误装）；`dsh` CLI 自动定位（环境变量 → 安装目录 → PATH，全程绝对路径，不要求进 PATH）。
- 错误分类与 529/503 观察。常见上游错误给面向人的提示；DSH 发出 529/503 原生重试事件时记日志，满足条件时提示会话。桥接不自己重放可能产生副作用的回合。
- 模块化。唤醒策略、回复节奏、群聊等待、控制台入参、人格文本、图片解析、配置归一都拆进了 `src/core/`，各自带回归测试。原来那个八百多 KB 的 `bridge.js` 还在，但不用每次都从头读。
- 群聊静默 3 秒。群里最后一条新消息之后只等 3 秒，从首条新消息算起最多再等 6 秒。后面的人继续补话，也不能把这个总期限往后拖。私聊行为不变。
- group-wait 与唤醒合并。群聊等待策略和唤醒批次窗口各自成模块，明确触发的窗口上限 2 秒、其它 4 秒，并且只缩不放。你配了更短的 1 秒，不会被放大回 8 秒。
- 人格卡与人格注入上限。`roles/` 里五张卡（小鲸鱼、小鲸鱼-微调、小鲸鱼-微调-无脏话、傲娇助手、测试人格Tmp），注入上限模板值 10000 字符，字段是 `role.maxInjectChars`。
- Windows 下自动发现 DSH Desktop 端点。DSH Desktop 重启后可能换随机端口，桥接会找本机 DSH 进程的监听端口，通过鉴权并核验 `qq-mode` 命名空间之后才切过去。验证不通过就保留原连接继续重试。设 `dsh.autoDiscoverDesktop` 为 `false` 可以关掉，手动固定地址。

**这一版没有额度提醒，也没有额度保护。** 余额耗尽、额度为零这类专项检测、提醒、请求阻断、自动恢复都不在发布范围里。额度类错误不会被单独识别，普通的 429 按限流处理。别把上游文档或别处的描述套到这上面来。

## 环境与依赖

| 组件 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 11 x64 | 唯一实机验证过的平台。macOS / Linux 没上过真机，自动发现端点只对 Windows 生效 |
| Node.js | `>= 22.13.0` | `package.json` 的 `engines` 写的就是这个。npm 跟着 Node 一起来 |
| DSH | Desktop 0.2.1-rc.2 | 不支持 0.20；0.2.1 的改动之后没再跑 0.20 的回归 |
| QQ 网关 | SnowLuma（OneBot v11） | 实机跑的是 1.14.x。要开 OneBot 的 HTTP 服务端和 WebSocket 服务端，默认 3000 / 3001 |
| 可选 | 7-Zip / Bandizip | 下 zip 发布包时需要。Windows 自带解压对中文文件名支持很差，容易乱码 |

依赖包由 `npm ci` 装，主要是 `@snowluma/sdk` / `@snowluma/mcp`（^1.14.20）、`@modelcontextprotocol/sdk`、`zod`、`js-yaml`，外加几个 DSH 侧的包。DSH 和 SnowLuma 本体不随本项目分发，自己去装。

## 安装步骤

以下命令都在 PowerShell 里跑，路径按自己的改。

1. 装 Node.js 22.13.0 或更高，确认可用：

   ```powershell
   node --version
   npm --version
   ```

2. 装并启动 DSH Desktop，在里面配好一个能用的模型和凭据。默认端点 `http://127.0.0.1:3080`，换过就记下来。

3. 装并启动 SnowLuma，按它的引导登录 QQ、完成接入。打开 OneBot 的 HTTP 和 WebSocket 服务端，记下地址、端口和 access token（如果设了）。这两个端口别填反。

4. 拿代码。可以 clone，也可以下发布包解压。解压路径建议纯英文、不带空格，比如 `D:\qq-bridge`。

   ```powershell
   git clone https://github.com/adj18311/qq-bridge-plus.git
   cd qq-bridge-plus
   ```

5. 装依赖。**必须先装依赖再启动**，直接 `npm start` 会在 import 阶段报错：

   ```powershell
   npm ci
   ```

6. 复制配置模板。已经有自己的 `config.json` 就别覆盖，先备份再手动合并：

   ```powershell
   Copy-Item config.example.json config.json
   ```

7. 编辑 `config.json`，至少改这几处：

   - `dsh.baseUrl`：DSH 实际地址；`dsh.provider`、`dsh.model`、`dsh.reasoningEffort` 要和 DSH 里能用的模型对得上。
   - `snowluma.wsUrl` / `snowluma.httpUrl`：OneBot 的 WebSocket 和 HTTP 地址；设了 token 就填 `snowluma.accessToken`。
   - `ownerQQ`：你自己的 QQ 号。
   - `allow.private` / `allow.groups`：先只填自己的私聊，确认通了再放开群。**默认是空的，空着它一句话都不会回。**
   - `consolePort`：控制台端口，模板是 3100，冲突就换。

8. 把预设和 MCP 装进 DSH：

   ```powershell
   node scripts/setup-dsh.mjs
   ```

   这一步会改本机的 DSH profile 和插件链接，已有的 DSH 环境建议先备份。脚本会打印它做了什么。别把它报的错当成“跳过也行”。

9. **重启 DSH Desktop。** 不重启，新装的预设和 MCP 不生效。

10. 启动桥接。双击 `start.bat`（守护模式，窗口关了就不再拉起），或者在项目目录跑：

    ```powershell
    npm start
    ```

11. 打开 `http://127.0.0.1:3100`，用启动日志里的控制台令牌登录。然后在白名单里的 QQ 私聊发一条消息，看有没有回复。通了再去测群聊、人格卡、记忆、模型切换。

12. 可选自检：

    ```powershell
    npm run test:quick
    ```

    这只是离线回归，代替不了真实收发。正式发布前跑的是 `npm run test:audit`（目前 90 项 full）和 `npm run test:quick`（目前 47 项 quick），都在实机上过过。

## 视频教程

装环境、配 `config.json`、跑 `setup-dsh.mjs`、启动这些常规流程，B 站上有现成的视频。跟着做比自己啃文档快。

https://www.bilibili.com/video/BV1ss8R6zERG/

视频覆盖的是通用部分，能解决大部分人的安装问题。**贴吧功能视频里没讲**，因为它要多配一个 Cookie 文件，还得理解那套次数和时段限制，所以单独写在后面。先把视频里的流程走通、确认 QQ 能正常收发，再回来看贴吧。

## 模型管理：给不同会话配不同的大脑

双击目录里的 `模型管理.bat`，会打开一个交互界面。一边是会话，一边是可选模型，按会话挑就行。

列表不是写死的。它问 DSH 要模型目录（`GET /api/dsh/models`），DSH 里配了哪些 provider、每个 provider 下面有哪些模型，这里就列什么。所以只要某个第三方模型 API 能在 DSH 桌面版里配置成功、目录里列得出来，这里就能选，不用在别处再登记一遍。

什么时候用得上：主模型额度紧的时候，把闲聊的群切到便宜那只，把要紧的会话留给贵的；不同群对能力要求不一样，可以分开配；怀疑某个模型抽风了，临时切到另一家对比一下。切换是热生效的，不用重启桥接。

它能改三样东西：

- 全局默认，存 `config.json` 的 `dsh.provider` / `dsh.model`，新建的会话沿用；
- 单个会话，存 `dsh.modelOverrides`，键是 `private:QQ号` 或 `group:群号`；
- 推理强度 `reasoningEffort`，跟着模型一起切；目标模型不支持那个强度时，回落到它自己的默认值。

改之前它会先校验目录里有没有这个组合，再备份 `config.json`，然后原子替换、回读确认。任何一步失败，内存和磁盘都不会变，也不会留下半截配置。

几个边界：模型 ID 要完全一致，`MiniMax-M3` 和 `MiniMax-M3.1-Flash-Preview` 是两个东西；DSH 目录拉不到时界面会显示降级状态和原因，不会假装支持所有模型；它只改桥接这边的会话选择，不动 DSH 应用自己用的模型。

## 贴吧功能：为什么要单独配置，怎么配

### 为什么它不一样

其它功能都走 DSH：消息交给模型，模型想说什么就调工具说。贴吧不是。贴吧是桥接自己去抓百度贴吧的页面，把 HTML 解析成文本和图片，再塞给模型看。

这带来几个后果：

- 它绕不开百度的反爬。PC 版 `tieba.baidu.com/f?kw=…` 在 2026-10-07 的实测里一律回 403「百度安全验证」，桥接实际抓的是移动版页面（`/mo/q/m?kw=…&lp=5028`），而且必须带对请求头。
- 匿名请求基本走不通。工具在没配 Cookie 时也能用，也会真的去抓，但吧页和帖页**基本上都会回 403 或百度安全验证页**。`src/tieba-lib.js` 的实测注释写得很直接：同一个吧页 URL，只去掉 cookie 就回 403。被拦之后它会降级跑一次网页搜索，把结果标上「结果来自网页搜索，不是贴吧原页」交给模型。内容不完整，通常也没有楼层图片。要稳定用，还是得配 Cookie。
- 它是只读的。列吧页、读帖子、读回复、看楼层图，就这些。不发帖、不回帖、不点赞、不绕验证。

带上 Cookie 和完整的移动版 UA，才能稳定拿到 200 和正常楼层。Cookie 是可选的，但想要稳定体验，基本等于必配。

### Cookie 从哪来

用你自己有权访问的账号，别借别人的。

1. 浏览器登录百度贴吧，随便打开一个帖子。
2. 开开发者工具（F12），切到网络（Network）面板，刷新页面。
3. 找一条发往贴吧域名的请求，看它的请求头，找到 `Cookie` 那一行。
4. 复制它的值，就是 `BAIDUID=...; STOKEN=...; ...` 这串。不要连 `Cookie:` 这个标题一起复制。

不同浏览器界面不太一样，但都在请求头里。

### Cookie 放哪：仓库外的单独文件

**必须放在仓库外面，配置里只写路径。** 这不是洁癖，是几条很实际的理由：

- `config.json` 会进本地控制台，谁打开控制台都能看到里面的内容；
- 备份、迁移、打包的时候，`config.json` 一定会被带上；
- 只要它躺在仓库目录里，`git status` 迟早会把它扫出来。一次误提交就是永久泄露。

Cookie 等于登录凭据。拿到它的人可以以你的身份操作百度账号。所以代码里的做法是：`config.json` 只存文件路径，Cookie 的值只出现在发出去的请求头里，不进日志、不进工具返回文本、不写盘。

文件怎么写：

1. 在仓库外面建一个只有自己能读的 UTF-8 文本文件，比如 `D:/qq-bridge-secrets/tieba.txt`。
2. 把 Cookie 的值放在第一行，格式就是 `字段名=值; 另一个字段名=值`。
3. 不要写 `Cookie:` 标题，不要换行拆成多行，不要往里面塞别的请求头。

桥接读取这个文件的规则（出问题时会很有用）：取第一条非空行，去掉首尾空白，压成单行；内容里必须有一个 `=`。路径空着、文件不存在、文件是空的、内容不像 Cookie，这四种情况一律当作“没配登录态”处理。不报错、不崩溃、不打印值，只是安静地退回匿名抓取。

### 配置里改哪个字段

`config.json` 里要加的是 `socialV2` 下面的两个成员。它们不是独立文件，也不是完整的 JSON 文档，而是嵌在 `socialV2` 对象里的字段，写的时候留意和相邻字段之间的逗号。**别新建第二个 `socialV2`，也别把整个 `socialV2` 替换成下面这点内容。** 里面还有模式、工具、等待一堆设置。

```json
"tieba": {
  "cookieFile": "D:/qq-bridge-secrets/tieba.txt"
},
"patrol": {
  "enabled": true,
  "dailyVisitCap": 12,
  "maxPagesPerThread": 2,
  "quietHours": [1, 8]
}
```

只要登录态的话，`tieba` 这一节就够了。`patrol` 是可选的，不写就走默认值。完整路径是 `socialV2.tieba.cookieFile` 和 `socialV2.patrol.dailyVisitCap` 这种写法。

字段说明，默认值都是从代码里核过的：

| 字段 | 默认值 | 作用 |
|---|---|---|
| `socialV2.tieba.cookieFile` | `""`（空字符串） | Cookie 文件的路径。留空就是匿名抓取 |
| `socialV2.patrol.enabled` | `true` | 自主逛贴吧的总开关。关掉它，工具还在，只是只允许你明确要求时用 |
| `socialV2.patrol.dailyVisitCap` | `12` | 每日自主访问上限，按自然日（本地时区）重置。写 `0` 是合法的，等于自主访问全拒 |
| `socialV2.patrol.maxPagesPerThread` | `2` | 自主读帖最多看前几页 |
| `socialV2.patrol.quietHours` | `[1, 8]` | 静默时段，`[起, 止)`，含起点不含终点。`[23, 7]` 这种跨零点的写法也认，顺序不会被自动摆正 |

另外三个工具开关在 `socialV2.tools` 里：`tiebaList`、`tiebaRead`、`patrol`。它们默认就是开的，配置文件里不写也生效，只有明确写成 `false` 才关。想彻底不让它自己逛、只响应你的明确要求，把 `patrol` 设成 `false` 就够了，不用动 `tiebaList` / `tiebaRead`。

要提醒一句：`config.example.json` 里没有 `tieba`、`patrol` 这两节，也没有上面这三个工具开关。模板只是模板。这些字段的默认值来自 `src/core/runtime-config.mjs` 和 `src/tieba-lib.js` 的 `PATROL_DEFAULTS`。加进去就生效，不加就走默认。改完配置记得重启桥接。

### 那些限制是什么意思

这些数字不是随便定的，是照着“别把 IP 打热、别把百度惹急”来的：

- 每天 12 次自主访问。一次 = 抓一条帖（哪怕读了两页）或抓一次吧页列表，按自然日重置。你明确让它去（“去原神吧看看”“读这条帖”）不占这 12 次，也不算巡逻。
- 01:00–08:00 不主动逛。这个时段它自己想起来去看会被拒（`PATROL_QUIET_HOURS`），你明确要求的照样能读。
- 自主读帖一次最多前两页。第 3 页起没有预算，多要的页会被钳掉，正文里会写明“巡逻单次最多读前 2 页”。想往后翻，它得先在会话里问你一句。你同意了才继续，那部分不占当天次数。
- 单次最多 10 页。这是所有读帖的硬上限。超出不是静默丢弃，会返回 `truncated` 并在正文里说“请求了 N 页、只取了前 M 页”。页数越多越慢，一次调用读 1 页等 80 秒，读满 10 页等 260 秒。
- 抓取节流。相邻两次请求至少隔 3 秒，每分钟最多 6 次，吧页和帖页各算各的。撞上安全验证页后冷却 10 分钟，冷却期间不会再发请求。
- 图片上限。一次最多 10 张，单张 4 MiB，合计 25 MiB。超出的不会静默丢掉，会逐张注明原因和未取数量。模型能不能看懂，还取决于它支不支持图片输入。

### 怎么验证配好了

1. 重启桥接。如果 Cookie 文件读到了，启动日志里会有一行 `贴吧 cookie 已启用（N 字段）`，N 是脱敏后的字段数，不会打印值。
2. 在已经授权的二代仿真会话里说一句“读一下这个帖子”，把链接甩给它；或者说“去 XX 吧看看最近有什么”。
3. 正常情况下返回里应该能看到吧名、帖子标题、作者、楼层正文和回复。有图的楼层会把图片直接交给你用的模型。
4. 如果返回里写的是“百度安全验证”或“结果来自网页搜索，不是贴吧原页”，说明这次被拦了。检查 Cookie 有没有过期、文件路径对不对、格式是不是单行。别反复重试，越试越凉。
5. 如果报错是 `工具未启用：qq_tieba_read`，说明工具开关被关了，或者 DSH 侧的 MCP 没装好。回去重跑 `node scripts/setup-dsh.mjs` 并重启 DSH。

顺带一句：Cookie 会过期。哪天它突然又只给搜索降级结果了，先换一份 Cookie，再怀疑别的。

## 已知限制

- 只在 Windows 11 x64 + DSH Desktop 0.2.1-rc.2 上验过。0.20 不支持，macOS 和 Linux 没上过真机。换别的 DSH 构建、模型供应商或网络环境，不保证端到端跑得通。
- 缺 `config.json` 是直接报错退出，不会引导你去复制模板。第一次装容易卡在这。
- 非正常退出会留下 `state/bridge.lock`，里面是死掉的 PID。下次启动前删掉即可。
- `npm ci` 会报几个传递依赖的漏洞（1 moderate / 1 high / 1 critical），这一版没处理。
- 图片发送只放行白名单里的图床域名，本机路径、内网地址、base64 串一律拒绝。这不是限制没做完，是故意的。
- 语音默认关闭，发布包里不带音频。要用得自己往 `audio/` 放文件再开开关。
- 多个 DSH 实例共享同一个 `DSH_HOME` 时，端点自动发现分不清目标，可能选错。这种情况把 `dsh.autoDiscoverDesktop` 设成 `false`，手动指定地址。
- 529/503 的提示依赖 DSH 真的发出并送达重试事件。桥接只旁观，不自己重放回合，也不能保证每次上游抽风都有提示。
- 没有全局的 offline / dry-run 开关。想在没网关的情况下试启动，只能把 `snowluma.wsUrl` 指向一个没人听的端口，同时关掉 `followDiscoveredEndpoint`。
- 模板里的主动机会时间窗是 7:00–23:00。窗口外只是不主动开口，不等同于完全不响应消息。
- `roles/` 里的“测试人格Tmp”是测试用，“小鲸鱼-微调”含粗口规则。不想听脏话就换“小鲸鱼-微调-无脏话”，别把测试或微调人格当成默认。

## 文档、反馈与致谢

仓库地址：https://github.com/adj18311/qq-bridge-plus

更多细节在这些文件里：

- [安装与使用（含贴吧完整说明）](docs/INSTALL.md)
- [升级说明：相对上游、相对 1.0.0](docs/UPGRADE.md)
- [兼容性与支持范围](docs/COMPATIBILITY.md)
- [已知限制](docs/LIMITATIONS.md)
- [更新日志](CHANGELOG.md)
- [使用规则](RULES.md)
- [许可](LICENSE)

遇到问题去 [Issues](https://github.com/adj18311/qq-bridge-plus/issues) 提，附上版本、复现步骤和相关日志片段。贴日志之前先检查有没有 QQ 号、群号、Cookie、访问令牌、聊天内容，这些都不该出现在公开的 issue 里。配置文件和 `state/` 目录整体也不要上传。

最后再谢一次上游作者 Derpyu520 和所有给 qq-bridge 贡献过代码、文档、issue 的人。这个项目能省下大量摸索的时间，靠的是他们把路先走了一遍。
