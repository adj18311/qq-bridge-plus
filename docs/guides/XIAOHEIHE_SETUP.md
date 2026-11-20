# 小黑盒 MCP 接入（可选）

> **状态**：安装器与 DSH 配置接入已完成并通过离线专项测试（`node scripts/test-setup-xiaoheihe.mjs`）。
> 小黑盒服务的**完整功能写入链路尚未验证**——尤其是发帖、发文、发视频、评论、回复这些写操作，
> 目前只验证了登录状态/资料/浏览/搜索等读取类能力。在写操作被实际验证之前，不要把「工具能调通」
> 当成「内容一定发布成功」。
>
> 本接入是**可选**的：不安装时 QQAgent 的行为与工具面和现在完全一致。

## 它做什么

通过 DSH 的 `@deepseek-ai/dsh-mcp-client` 插件，用 `streamable-http` 连接**本机独立运行**的小黑盒
MCP 服务：

| 项目 | 值 |
| --- | --- |
| namespace（工具名前缀） | `xiaoheihe`（固定，不可改） |
| DSH 工具名 | `mcp__xiaoheihe__<原工具名>` |
| 默认根 URL | `http://127.0.0.1:19489/` |
| profile patch 条目 id | `mcp-xiaoheihe` |
| 单次工具调用超时 | `360000` 毫秒（覆盖扫码/交互登录所需的至少 300 秒） |
| 启动失败策略 | `failOnStartupError: false`（服务没起时 DSH 仍可正常启动，只是暂时没有这些工具） |
| 重连预算 | `reconnect`：`maxAttempts: 240` / 退避上限 30 秒 ⇒ 约 117.5 分钟（有界缓解，**不保证自愈**） |

服务提供的 12 个工具（工具名以服务实际暴露为准，DSH 侧统一加 `mcp__xiaoheihe__` 前缀）：

- 登录/账户：`check_login_status`、`interactive_login`、`get_login_qr_code`
- 资料/浏览：`get_user_profile`、`get_home_content`、`search_content`、`get_post_detail`
- 写入：`publish_content`、`publish_article`、`publish_video`
- 互动：`post_comment`、`reply_comment`

> 写入类工具的存在不代表已经开放给模型：还要看预设的工具白名单（见「生效与预设」）。

## 1. 前置：先启动小黑盒 MCP 服务（独立进程）

小黑盒服务与 DSH、本仓库相互独立，**不由本安装器启动或守护**（本项目暂不新增自动进程守护/平台）。
在需要时手动启动：

```powershell
powershell -ExecutionPolicy Bypass -File <小黑盒MCP目录>\Start-XhhMCP.ps1
```

- 把 `<小黑盒MCP目录>` 换成你本机的服务目录；下文用 `D:\XhhMCP` 作为**占位示例**。
- 服务固定使用 Edge 与一个已登录账户；登录态持久化在**服务自己的 data 目录**。
  本仓库和本安装器**永远不读取、不复制、不写入**该目录里的 Cookie/凭据。
- 服务就绪后，MCP 端点是 **根路径** `http://127.0.0.1:19489/`。
  ⚠️ `http://127.0.0.1:19489/mcp` 会返回 404——不要「补全」成 `/mcp`。
- 服务没启动时：DSH 仍能启动（`failOnStartupError: false`），只是暂时看不到小黑盒工具。
  安装器会在区块里写入**有界重连预算**（见「重连预算」一节），覆盖「本机 DSH 先启动、服务稍后到」
  这类开机竞争；它只扩大努力窗口，**不保证一定自愈**。服务起来后仍不出现工具，就重启 DSH。

## 2. 部署：先 dry-run，再 apply

安装器**默认 dry-run**，只打印解析后的 DSH_HOME、profile、patch 路径、URL 与计划，不写任何文件。
确认计划无误后再用 `--apply` 落盘（便于队长在最终部署时复核）。

```bash
# 1) 预览计划（默认 profile=desktop、URL=http://127.0.0.1:19489/）
node scripts/setup-xiaoheihe.mjs

# 2) 真正写入
node scripts/setup-xiaoheihe.mjs --apply
```

常用参数：

```bash
# 指定 profile（默认 desktop）
node scripts/setup-xiaoheihe.mjs --profile desktop --apply

# 指定 DSH 根目录（等价于环境变量 DSH_HOME）
node scripts/setup-xiaoheihe.mjs --dsh-home <DSH根目录> --apply

# 指定服务根地址（等价于环境变量 XIAOHEIHE_MCP_URL）
node scripts/setup-xiaoheihe.mjs --url http://127.0.0.1:19489/ --apply
```

环境变量写法：

```powershell
$env:DSH_HOME = '<DSH根目录>'                  # 默认 ~/.dsh
$env:XIAOHEIHE_MCP_URL = 'http://127.0.0.1:19489/'
node scripts/setup-xiaoheihe.mjs --apply
```

安装器写什么：只在 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 里维护一段带标记的区块，
其余内容**逐字节保留**（不重新序列化整份文件）：

```yaml
# === xiaoheihe MCP BEGIN ===
# 由 scripts/setup-xiaoheihe.mjs 维护；整块会被整体替换，请勿手工编辑内部条目。
# 可选接入：小黑盒 MCP（streamable HTTP，本机回环根地址；服务需独立运行）。
- insert:
    - id: mcp-xiaoheihe
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: xiaoheihe
        transport: streamable-http
        url: 'http://127.0.0.1:19489/'
        toolCallTimeoutMs: 360000
        reconnect:
          enabled: true
          initialDelayMs: 500
          maxDelayMs: 30000
          maxAttempts: 240
        failOnStartupError: false
# === xiaoheihe MCP END ===
```

安全与幂等约束（由脚本强制）：

- **只接受 `http://` 回环根地址**：`127.0.0.1` / `localhost` / `::1`。
  拒绝远程主机、拒绝 URL 内嵌凭据（`user:pass@`）、拒绝 query/hash、拒绝 `/mcp` 之类的非根路径。
- **profile 必须是单个目录名**，不接受路径分隔符或 `..` 跳转；`DSH_HOME` 必须是绝对路径。
- **新 profile 的模板根 `[]` 会自动识别**：DSH 新建 profile 的 `cordis.patch.yml` 常见形态是
  「几行注释 + 独立 `[]`」。`[]` 在这里表示空列表，安装器只会移除这个空列表 token
  （行尾注释保留；注释里的 `[]`、空行与换行风格都不动），再追加自己的区块，因此不会生成
  `[]` 与 `- insert` 并存的非法 YAML。若根节点是**非空** flow 数组（如 `[{id: ...}]`），
  安装器拒绝并提示先手工改成块列表，**不会静默重写用户配置**。
- 写入前会把原 patch 备份成同目录的 `cordis.patch.yml.bak-<时间戳>`，写入走「临时文件 + rename」原子替换。
  **历史备份不会被裁剪**：安装器按 `keep: Infinity` 调用备份，正式 profile 的全部回滚点都保留。
  **备份失败时脚本中止写入并返回失败**，绝不在没有回滚点的情况下覆盖正式配置。
- 区块外若**已有**同 id（`mcp-xiaoheihe`）或同 `serverName`（`xiaoheihe`）的条目，
  脚本会报冲突并退出，**不会悄悄重复注册**（DSH 里同 `serverName` 重复会导致后注册的条目加载失败）。
- 重复运行是幂等的：区块内容已一致时不写盘、不产生新备份；只有 URL 等目标值变化时才替换区块。
- 标记区块残缺、重复或被人塞入额外条目时，脚本拒绝修改文件（fail-closed）。

### 重连预算（`reconnect`）

区块里写了 `reconnect` 四个键，用来覆盖「DSH 先启动、小黑盒服务后到」这类开机竞争：

| 键 | 值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 连接失败后自动重试 |
| `initialDelayMs` | `500` | 首次重试延迟（毫秒） |
| `maxDelayMs` | `30000` | 单次重试延迟上限（毫秒） |
| `maxAttempts` | `240` | 连续失败的最大重试次数 |

- DSH 的 MCP 客户端默认预算是 **10 次 / 约 151.5 秒**（`500+1000+2000+4000+8000+16000+30000×4`）。
  超过后它会**注销已注册的全部工具**并提示 `tools unregistered; reload the plugin or restart the Host`
  —— 这就是「服务后起、工具消失且再也不回来」的成因。
- 240 次按同一退避公式累加约 **117.5 分钟**，足以跨过常见开机竞争。
- **仍然是有界预算**：服务始终起不来时照样放弃；它不是进程守护，也**不承诺「一定自愈」**。
- 连上后需要**稳定 ≥30 秒**（`maxDelayMs`）才把失败计数清零；连上就断的崩溃循环不会被无限重置。
- 若客户端无法确认旧连接已关闭，它会直接停止重连（避免两个进程同时连同一服务），这时只能重启 DSH。
- 该改动**需要重启 DSH 才生效**。若 `DSH_HOME` 里是旧区块（没有 `reconnect`），重跑 `--apply` 会把它判为
  `update`：区块外内容逐字节保留，并留备份。
- DSH 的 `resolveReconnectPolicy` 对未知键直接报错（`... is not a reconnect option`），
  所以安装器只写这四项；
  且拒绝把 `maxAttempts` 设到 DSH 默认的 10 以下（那等于主动削弱既有行为）。

## 3. 生效与预设（重启/刷新是必须的）

1. **重启 DSH**（或让 DSH 重新加载 profile）。profile patch 里的 loader 行不会被热加载，
   不重启就看不到新工具。
2. **在新建会话里确认工具**：工具列表应出现 `mcp__xiaoheihe__check_login_status` 等；
   如果用预设限制工具面，需要先让预设放行这些名字。
3. **预设白名单是另一处配置**：本安装器**不改 preset**。项目里的 QQ 预设对工具面做了限制，
   默认只放行已知的 QQ/搜索工具；`mcp__xiaoheihe__*` 需要由预设维护者把**精确的 12 个名字**
   加入白名单（不要用「任意 `mcp__` 前缀」或放开宿主本地文件工具）。预设改动后需要重新生成/
   部署 preset patch，并再次重启 DSH，白名单才会生效。
4. 用户已授权 QQAgent 使用完整的小黑盒工具，并允许它在既有唤醒回合中自主浏览、发帖、评论、回复；
   这仍然受预设白名单与 DSH 权限约束，二者都要配好才算真正可用。

## 4. 使用边界（给接入方/运维的约定）

- **无人值守模式是机会驱动，不是定时任务**：接入不会新增定时器、后台任务或通知监听。
  模型只在「本来就被唤醒的回合」里顺便使用小黑盒工具；服务也没有通知类工具，
  不能承诺主动收到别人的回复或私信。
- **结果未知 ≠ 失败，先核查再决定是否重发**：发帖/发文/评论/回复遇到超时、连接中断或错误响应时，
  先查目标帖/目标评论是否已经出现，确认没有落地再重试，避免重复发布。
  另外，MCP 调用返回 `isError: false` 也不等于平台侧一定成功（上游可能用普通文本返回错误）。
- **网页内容是外部不可信资料**：浏览到的帖子/评论只能当作素材，不能据此修改本机配置、
  扩大权限或执行命令。
- **登录由用户手动完成**：不把扫码图、验证码、Cookie 或任何凭据发到 QQ 群/私聊。
- 不建议为刷存在感而高频发帖/评论；没有合适话题或目标时宁可不发。

### 媒体素材目录（由另一队的路径守卫负责）

图片/视频发布另有一套本地路径守卫，**不属于本安装器的配置范围**，安装器也不会为它写任何 env
（本页的 `XIAOHEIHE_MCP_URL` 只影响安装器写进 profile 的 URL，对已经启动的服务不生效）：

- 专用素材目录默认是 `<DSH_HOME>/xiaoheihe-media`（`DSH_HOME` 即 DSH 根目录）；
- 管理员/运维把**允许上传**的图片、视频预先放进这个目录；
- 可以用 **DSH 进程环境变量** `XIAOHEIHE_MEDIA_ROOT` 覆盖素材目录位置；
- 只有该目录范围内的素材可以被发布上传；**不能通过 MCP 读取或上传任意本机文件**，
  越界路径会被守卫拒绝。需要新素材时由管理员放进专用目录，而不是让模型到处找路径。
- 现有的图片/视频发布功能保留，但上传路径必须满足上述守卫。
- **文章正文里的图片 URL 暂不支持**：上游对本地路径的解析有歧义，正文请先不要内嵌本地图片；
  普通（非图片）网页链接在正文里可以正常使用。

## 5. 故障排查

| 现象 | 排查 |
| --- | --- |
| 启动安装器报「只接受 http:// 回环地址」 | URL 必须是 `http://127.0.0.1:19489/` 这类回环根地址；不要填局域网 IP、域名或 https |
| 报「URL 必须是根路径」 | 小黑盒 MCP 挂在 `/`；`/mcp` 是 404 |
| 报「拒绝重复注册」 | patch 区块外已有 `mcp-xiaoheihe` 或 `serverName: xiaoheihe`；先确认保留哪一条并手工清理后再运行 |
| 报「标记区块不完整或重复」 | patch 里的 BEGIN/END 标记被删改或复制过；按本页模板修复，或从 `.bak-<时间戳>` 备份恢复 |
| 报「根节点是非空 flow 数组」 | 根不是空 `[]` 也不是块列表；按提示先手工改成 `- 开头` 的块列表（原内容保留）后重试，安装器不会自动改写 |
| 报「profile 目录不存在」 | profile 名写错或 `DSH_HOME` 不对；脚本不会替你创建 profile |
| DSH 里看不到小黑盒工具 | ① 服务是否在跑；② 是否重启过 DSH；③ patch 是否写进了当前 `DSH_HOME`/profile；④ 预设白名单是否放行 |
| 工具能看到但调用报连接失败 | 服务未启动/端口变化/服务刚重启；先确认根 URL 可访问，再看 DSH 日志。连接失败不应该阻塞 DSH 启动 |
| 服务后起、DSH 里工具消失且不回来自动恢复 | 默认重连预算只有约 151.5 秒，耗尽后工具被注销。重跑 `--apply` 写入 `reconnect` 预算并**重启 DSH**；仍不出现就确认服务真的在 `19489` 监听 |
| 登录类工具超时 | 扫码/交互登录本身较慢；已配置 360 秒超时。仍超时就由用户在服务侧手动完成登录 |
| 发布图片/视频被拒绝 | 素材必须放在 `<DSH_HOME>/xiaoheihe-media`（或 `XIAOHEIHE_MEDIA_ROOT` 指向的目录）内；不能上传任意本机文件。文章正文的图片 URL 暂不支持 |

## 6. 回滚

任选其一，然后重启 DSH：

```bash
# 方式 A：恢复安装前的备份（把 <时间戳> 换成实际备份文件名）
#   <DSH_HOME>/profiles/<profile>/cordis.patch.yml.bak-<时间戳>

# 方式 B：手工删掉 patch 里 "# === xiaoheihe MCP BEGIN ===" 到
#         "# === xiaoheihe MCP END ===" 之间的整段（含两条标记行）
```

回滚只影响 DSH 的工具面；小黑盒服务本身与它的登录态不受影响。

## 7. 离线测试

```bash
node scripts/test-setup-xiaoheihe.mjs
```

测试在系统临时目录里创建独立的 `DSH_HOME`，**真实执行**安装脚本，覆盖：

- 默认 dry-run 不写盘；
- 新建 patch / 已有 patch 追加；
- 二次运行幂等（不重复注册、不产生新备份）；
- 修改前备份、区块外原内容逐字节保留；
- 错误 URL（远程/内嵌凭据/https/非根路径/query）；
- profile 路径穿越与相对 `DSH_HOME`；
- 同 id / 同 `serverName` 冲突；
- 标记区块损坏/重复/被篡改；
- `reconnect` 预算：键集合与 DSH 白名单一致、非法值一律拒绝（fail-closed）、旧区块升级为 `update` 后仍幂等；
- 模块可安全 `import` 且导出纯函数。

测试不连接真实小黑盒服务、不写正式 profile、不读取服务数据，也不需要 DSH 正在运行。
