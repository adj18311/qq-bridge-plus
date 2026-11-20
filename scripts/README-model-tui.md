# 交互式模型管理器（`scripts/model-tui.mjs`）

一个**独立脚本 + 双击 bat** 的「模型管理器」：在终端里看上边额度、下边会话列表，
给单个会话或全局档位挑模型，**全部改动先攒在内存里，最后选中 `exit` 按 Enter 才一次性写盘**。
不是 DSH 插件，不改 `src/**`，不碰记忆桶，不引第三方依赖（只用 node 内置 + ANSI 转义）。

| 文件 | 作用 |
| --- | --- |
| `scripts/model-tui.mjs` | 交互式模型管理器本体（渲染 + 按键 + 内存改动 + exit 原子写盘） |
| `模型管理.bat` | 双击入口：`chcp 65001` + `%~dp0` 相对路径 + `pause`（UTF-8 无 BOM / CRLF） |
| `scripts/README-model-tui.md` | 本文件 |

和周边脚本的关系：

- `scripts/switch-model.mjs`：**粗粒度**开关（在 minimax / deepseek 两个档位之间整体切换，并退役重建会话）；
- `scripts/check-model-quota.mjs`：只读的额度体检 + 私聊汇报；
- 本脚本：**细粒度**手动档（逐会话挑模型），写盘前不动任何文件，写盘时只改 `dsh.provider/model`
  和 `socialV2.modelOverrides`。

## 1. 界面

```
模型管理器  （改动只留在内存，选中 exit 按 Enter 才写盘）
额度  本地 Codex 模型未配置额度查询（provider local-codex-app-server）  ｜  MiniMax 5h 剩余 62%（3h3m 后重置） · 周剩余 66%（5d19h 后重置）  ｜  DeepSeek 余额 36.71 CNY  （按 private:1420193228（实际 provider）；18:44:50 拉取，按 r 刷新）
目录  DSH 模型目录 3 个 provider / 11 个模型 （18:44:50 拉取，按 r 刷新；菜单内容 = 目录内容）
──────────────────────────────────────────────────────────────────────────
>1.  私人会话 private:1420193228   gpt-6.1-sol · 强度 medium (实际: gpt-6.1-sol)                 ［单独设置］
 2.  私人会话 private:1234567890   deepseek-flash · 强度 high (实际: deepseek-flash)             ［单独设置］
 3.  群会话 group:863736632        MiniMax-M3.1-Flash-Preview · 强度 跟随全局（high） (实际: …)  ［跟随全局］
 4.  全局档位                      deepseek-flash（provider deepseek-account） · 强度 high       ［新会话/未单独设置的会话］
 5.  exit                          退出（无改动，不写盘）
──────────────────────────────────────────────────────────────────────────
↑/↓ 选择 · Enter 打开模型列表（编号也可以直接跳：1~99）· e 选思考强度 · r 刷新额度/目录/实际模型 · Ctrl+C 放弃（不写盘）
内存累计改动：0 项
实际模型快照：state/token-usage.jsonl @ 18:44:50（列表重绘时按 mtime 自动重读，r 强制重读）
```

- **额度行**（常驻，A④）：**先按「光标所在这一行的会话实际使用的 provider」**报告，再补上其它有查询能力的源。
  - 单会话 → `state/token-usage.jsonl` 里该 key **最后一条**带 `provider` 的记录（真实使用）；没有记录才退回
    「将要生效」的档位，并在行尾标 `（实际 provider）` / `（计划 provider）` 区分，不混；
  - 全局档位 / exit → 全局 `dsh.provider`；
  - 当前 provider **没有额度查询能力**（例如 `local-codex-app-server`）⇒「`<显示名> 模型未配置额度查询`」，
    **绝不显示成 0**；
  - 有查询能力但**凭证不可用** ⇒「`API Key 不可用，无法查询余额`」（MiniMax 的 `base_resp.status_code=1004`
    / `login fail` 与 DeepSeek 的 HTTP 401 都归到这一档）；
  - 其它失败 ⇒「额度/余额查询失败（原因）」+ 真实数值三种情况分开，不糊弄；
  - MiniMax 走 `GET https://api.minimaxi.com/v1/token_plan/remains` 的 `current_interval_remaining_percent`
    （5h 窗口）/ `current_weekly_remaining_percent`（周窗口），key 取 `MINIMAX_CN_API_KEY`；DeepSeek 走
    `GET https://api.deepseek.com/user/balance` 的 `balance_infos[0].total_balance`（元），key 取
    `DEEPSEEK_API_KEY`（先环境变量，再 `~/.dsh/.credentials.yaml` 的 `refs` 段）。**本工具只读、不打印凭据**；
    `--no-quota` 跳过联网查询（此时仍会按当前 provider 报「有没有额度查询能力」）。
- **目录行**（常驻，A②/A⑤）：菜单内容的来源是运行中桥接的 `GET /api/dsh/models`（A① 只读接口）。
  - 正常：`DSH 模型目录 N 个 provider / M 个模型（… 拉取，按 r 刷新）`；
  - 读不到（404 / 401 / 超时 / 桥接自报降级 / 空目录）：**必须显示**「已降级：DSH 目录读取失败，已退回仅
    DeepSeek 的兜底（原因：…；兜底项未经本次目录验证）」，菜单换成只含 DeepSeek 家族的兜底清单
    （兼容 `deepseek-account` / `deepseek-official`，每项标「兜底·未验证」），**不空菜单、不静默、不混入
    MiniMax/GPT**。
- **列表顺序固定**：全部单会话条目（私人在前、群在后，各自号码升序）→ `全局档位` → `exit`。
  条目来自 `config.json` 的 `allow.private` / `allow.groups`；key 形如 `private:<qq>` / `group:<gid>`，
  每行都标注「私人会话」/「群会话」。
- **模型列的语义**：`将要生效的模型 · 强度 <当前强度> (实际: 最近一次使用的模型)`。
  - 「将要生效」与 `src/bridge.js` 的 `modelSelectionFor(key)` 同规则：全局 `dsh.provider/model` 打底，
    `socialV2.modelOverrides[key]` 覆盖，**未写的字段继承全局**；
  - 「强度」= 全局 `dsh.reasoningEffort`（空字符串 = 显式未设置、由模型自身默认决定；缺字段 = 老配置按
    `max`）；单会话先看覆盖表里的 `reasoningEffort`，没有就显示「跟随全局（…）」；
  - 「实际」= `state/token-usage.jsonl` 里该 key **最后一条**带 `provider`/`model` 的记录（只读，永不写）；
    取不到就是 `(实际: 无记录)`；
  - 行尾标记 `［单独设置］` / `［跟随全局］` 表示 `modelOverrides` 里有没有这个 key。

## 2. 两种输入模式

| 模式 | 进入方式 | 按键 |
| --- | --- | --- |
| 方向键（默认） | `node scripts/model-tui.mjs` | `↑`/`↓` 移高亮，`Enter` 打开/确认，`r` 刷新额度+实际模型，`Ctrl+C` 放弃 |
| 编号 | `--input number` | 直接输入编号跳到对应项（多位数字可连打），`Enter` 打开/确认，其余同上 |

两种模式是**同一套渲染 + 同一套状态机**，只是宣传的按键习惯不同；实际**两套键在任何模式下都认**
（方向键与编号互为快捷方式），所以两种模式都能完整走完「选择 → 改模型 → exit 保存」。

**编号怎么输入**（`--input number`，或在方向键模式下直接用数字当快捷键）：

- 按一位数字 → 立刻跳到第 N 项；列表多长都行（**不再有**「只有前 9 项能用数字」的限制）；
- 跳第 10、12、17 项 → 数字**连打**（例如 `1` `2` → 第 12 项）。连打按「能接上就接」：
  在 17 项的列表里 `2` `5` 会先到第 2 项、再到第 5 项（25 超过总项数，就把这一位当新编号的开头）；
- 按到不存在的编号（例如 17 项里按 `0`）→ 提示「没有第 N 项：这里一共 17 项（输入 1~17 之间的编号即可，多位数字可以连打）」，
  光标不动；
- 输入过程中底部显示「编号输入：12 （Enter 确认这一项）」；`Enter` 打开/确认，`↑`/`↓`/`r`/`Esc` 会清掉待确认的编号。

子菜单①：模型列表（`Enter` 打开，**光标默认停在当前生效模型上**）

```
选择全局档位（dsh.provider / dsh.model / dsh.reasoningEffort；菜单 = DSH 目录）
>1.  gpt-6.1-sol                provider local-codex-app-server · GPT-6.1 Sol · 档位 low/medium/high/xhigh（默认 medium） ← 当前全局档位
 2.  gpt-6-astra                provider local-codex-app-server · GPT-6 Astra · 档位 low/medium/high（默认 medium）
 …
 8.  deepseek-flash             provider deepseek-account · DeepSeek V4.1 Flash · 档位 low/high/max（默认 high） · ← 与全局相同
 …
11.  MiniMax-M3.1-Flash-Preview provider minimax-cn · MiniMax M3.1 Flash Preview · 档位 low/medium/high/xhigh/max（默认 medium）
12.  跟随全局                   跟随全局（从 modelOverrides 删除这个 key）        ← 只有单会话条目有这一项
```

- 菜单 = `GET /api/dsh/models` 的目录内容（provider/model 与顺序都照抄）；**MODEL_CANDIDATES 已删除**，
  正常菜单不再只有写死的三个模型。每项的 detail 带 provider、显示名（与 id 不同才显示）、**该模型声明的
  档位**（含默认档位）。
- 当前配置里的模型**不在目录（或不在兜底菜单）里**时，列表第一项是
  「保持当前 `<model>`：选它 = 不改动、不自动改写（A⑥）」；光标停在第一项，按 `Enter` 只提示未改动。
- 目录降级时子菜单顶部先打两行（降级原因 + 「以下兜底项未经本次目录验证」），兜底项 detail 标「兜底·未验证」。

子菜单②：思考强度（**选中模型后自动进入**；也可以在主列表按 `e` 直接给当前条目改强度，不换模型）

```
为 private:1420193228 选择思考强度（modelOverrides 的 reasoningEffort；只列该模型声明过的档位）
>1.  low           低 · 快速回复
 2.  medium        中 · 平衡速度与质量 · （defaultEffort） · ← 当前
 3.  high          高 · 更努力地推理
 4.  xhigh         极高 · 最努力的推理
 5.  留空 / 跟随   从该 key 的覆盖里删掉 reasoningEffort（强度跟随全局）
```

- **只列所选模型 `reasoning.efforts` 里声明过的档位**（带 name/description，默认档位有标记）——
  不裁剪成 low/high/max，也不把 medium 映射成 high；
- 该模型**没有声明任何档位** ⇒ 只有一条信息项「该模型不支持思考强度」，直接 `Enter` 确认（**不给空菜单**）；
  兜底菜单里的模型档位未知 ⇒ 显示「思考强度未知（兜底·未验证）」，同样可直接确认（不写 `reasoningEffort`）；
- 档位能不能热生效取决于桥接版本（需含 t5 兼容扩展，见 §11）：本工具**不预过滤、不改名**，旧版桥接
  400 时摘要会如实说「未能热生效」；
- 切换模型后 `reasoningEffort` **重置为该模型的 `defaultEffort`**；没有 default ⇒ 留空/跟随
  （单会话 = 覆盖表删掉该字段；全局 = 写 `""`），界面会提示这次重置，并清掉旧模型残留的档位；
- `Enter` 确认、`Esc`（或 `b`）返回；**确认只改内存**，列表里立刻能看到新值；
- 光标定位规则：该会话**已单独设置** → 停在它现在用的模型上；**没单独设置** → 停在「跟随全局」上；
  全局档位条目 → 停在当前 `dsh.provider/model` 上；当前档位不在菜单里 → 停在「保持当前」；
- 确认一个**与现状完全相同**的值 → 提示「未变化：… 没有记入改动」，不会凭空多出一笔改动；
- 「跟随全局」= **从 `modelOverrides` 删掉这个 key**（不是把全局值写进去；`reasoningEffort` 随整条一起没）；
- `全局档位` 条目走同一个菜单，但没有「跟随全局」那一项；它的「留空/跟随」是
  `dsh.reasoningEffort = ""`（显式未设置，下一条 `selectModel` 省略档位、由模型自身默认决定）。

## 3. 硬约束（想改代码先读这段）

1. **exit 之前不写盘，改坏了也只丢内存**：选中 `exit` 按 `Enter` 之前，`config.json` 的 sha256 与 mtime
   都不变；中途 `Ctrl+C` / 异常退出只丢弃内存里的改动。
   ⚠️ **也正因为如此：崩溃、任务管理器强杀、或直接关掉窗口，未保存的改动就没了**——本工具没有
   「临时草稿」文件，也没有后台自动保存。改完记得回到 `exit` 那一项按 `Enter`。
2. **写盘只在 exit 发生，而且原子**：
   先备份 `config.json.bak-tui-<YYYYMMDDTHHMMSS>`（写入前的原始字节，同秒撞了就加 `-2`），
   再写 `config.json.tmp-tui-<pid>` 然后 `rename` 覆盖（失败会重试 3 次并保留备份），
   最后**回读自检**（磁盘上的 JSON 与内存深比较），打印变更摘要（key / 字段 / 旧→新）。
   热生效失败被桥接端点自己拒掉时，端点也会另留一份 `config.json.bak-model-<YYYYMMDDTHHMMSS>`（见 §6）。
   写盘范围只有：`dsh.provider` / `dsh.model` / `dsh.reasoningEffort`、`socialV2.modelOverrides[key]` 的
   `provider` / `model` / `reasoningEffort`；其它字段、键顺序、未知字段一律原样保留。
3. **保持原有 JSON 风格**：缩进（2 空格 / tab）、换行符（LF / CRLF）、BOM、末尾换行都从原文件探测后照抄。
4. **无改动就什么都不做**：提示「无改动，未写盘」，不新建备份、不碰任何文件、**也不调热生效端点**。
5. **任何退出路径都恢复终端**：关 raw mode、显示光标、复位属性（`Ctrl+C` / `Ctrl+Break`(SIGBREAK) /
   未捕获异常 / 未处理 Promise 拒绝 / `stdin` 结束；POSIX 上还有 `SIGTERM`），不会把终端留在原始模式。
   退出前还会顺手清一次 stdin 残留输入（`--drain-ms`，见 §9 —— 与 §10 的 bat 编码 bug 无关的防御性代码）。
   注意：Windows 上被 `taskkill /F` 之类**强杀**是任何程序都拦不住的，那种情况下终端本来就跟着窗口一起没了。
6. **`state/token-usage.jsonl` 只读**：只用来看「实际模型」，绝不写。
7. **落盘前先查并发**：exit 写盘前会重新读盘、比对启动时那份字节的 sha256。不一致（控制台保存过、
   `switch-model.mjs` 跑过、有人手改过）就**中止写盘**：把磁盘上的当前内容备份成
   `config.json.bak-tui-<时间戳>-conflict`，打印「config.json 已被其它进程修改，本次改动未写入」+
   before/after sha256 + 未写入的变更摘要，退出码 1。**绝不覆盖别人的改动。**
8. 不引第三方依赖（不 `import js-yaml`：凭据只用内置解析器读 `.credentials.yaml` 的 `refs` 段）。

## 4. 用法

```bat
node scripts\model-tui.mjs                       :: 方向键模式（默认）
node scripts\model-tui.mjs --input number        :: 编号模式
node scripts\model-tui.mjs --dry-run             :: exit 时只打印将要写入的变更，不写盘、也不调端点
node scripts\model-tui.mjs --no-quota            :: 不联网查额度（离线 / 自动化）
node scripts\model-tui.mjs --script keys.txt     :: 从文件喂按键（自动化，见下节）
node scripts\model-tui.mjs --config <盘符>:\tmp\c.json:: 测试用：操作指定的配置文件（会跳过热生效）
node scripts\model-tui.mjs --console-port 3100   :: 指定桥接控制台端口（目录接口与热更新端点都用它）
node scripts\model-tui.mjs --no-hot-apply        :: 写盘但不调 POST /api/dsh/model
node scripts\model-tui.mjs --help                :: 完整帮助
```

> 目录接口就是桥接控制台上的 `GET /api/dsh/models`（与热更新同一个令牌、同一个 `consolePort`）。
> 桥接是**旧版本**（还没加载 A① 路由，返回 404）时，目录行会明确显示「已降级 + 原因」，菜单只剩
> DeepSeek 兜底；此时仍能改模型，只是看不到目录里的其它 provider（重启桥接加载新路由后恢复）。
> `--config` 指向非仓库根的配置文件时，目录/额度照常读，但**热生效仍会跳过**（端点只会写它自己那份
> 仓库根 `config.json`）。

双击 `模型管理.bat` 等价于 `node scripts\model-tui.mjs`（默认方向键模式，参数可以透传：
`模型管理.bat --input number`）。

环境变量（可选）：

```bat
set BRIDGE_CONSOLE_TOKEN=<控制台令牌>           :: 覆盖热生效用的令牌（默认按 config.json 的 consoleToken → state/console-token 取）
```

退出码：`0` 正常（含「无改动」退出）/ `1` 运行失败（含自检失败、检测到 config.json 被其它进程改过）/
`2` 用法错误或非交互终端 / `130` 用户 `Ctrl+C`（或 `Ctrl+Break`）。

> `模型管理.bat` 会把 node 的退出码原样传给调用方（`set "code=%errorlevel%"` → `pause` → `exit /b 0%code%`）：
> 实测 `模型管理.bat`（stdin=NUL，非交互）→ `2`、`--help` → `0`、`--input bogus` → `2`、
> `--config <不存在>` → `1`、`--dry-run --script` 跑完 → `0`。注意它**末尾有 `pause`**：
> 非交互调用也会停住等按键（双击场景需要它），脚本里请改用 node 直调。

## 5. 自动化：`--script` 按键文件

把按键序列按顺序写进一个文件即可（不改变交互与写盘语义，一样会渲染、一样只在 `exit` 写盘）：

| 写法 | 含义 |
| --- | --- |
| `0`…`9` | 数字键（跳到第 N 项 / 子菜单第 N 个候选；多位数字直接连打，例如 `1` `2` = 第 12 项） |
| `\r` 或 `\n` | `Enter` |
| `\e` 或 `\x1b` | `Esc`（子菜单返回） |
| `\e[A` / `\e[B` | `↑` / `↓`（也认 `\x1bO A/B` 形态） |
| `\t` `\\` `\xNN` | 制表符 / 反斜杠 / 任意字节 |

其它规则：**文件末尾的一个换行不算按键**（编辑器自动补的那个换行不会变成多按一次 Enter）；
文件开头的 BOM 会被忽略；脚本按键用完还没选中 `exit` 就提示「未写盘」并正常结束（退出码 0）。

例（编号模式：给第 1 个会话换成目录里的第 2 个模型，确认它的 defaultEffort，然后保存退出）：

```
1\r2\r\r5\r
```

（第 1 项 = 第一个会话，第 2 项 = 模型菜单里的第 2 个模型，随后自动进入思考强度菜单、`Enter` 确认默认档位，
最后第 5 项 = `exit`。）

```bat
node scripts\model-tui.mjs --dry-run --input number --script keys.txt
```

## 6. 生效时机（写盘之后）—— 自动热生效，失败才要重启

**结论先说**：正常情况（桥接在跑、本机、仓库根的 `config.json`）**不用重启**。`exit` 写盘成功后，
本工具会自动调一次运行中桥接的 `POST /api/dsh/model`，让桥接**不重启**就把新档位装进内存，
已存在的会话在**下一条消息**就地重新 `selectModel`（摘要里会打印「已热生效…下一条消息生效」）。

### 6.1 端点成功时的完整链路

1. 本工具把内存快照**原子写**进 `config.json`（备份 `config.json.bak-tui-<时间戳>`，见 §3）；
2. 本工具 `POST http://127.0.0.1:<consolePort>/api/dsh/model`，令牌按这个顺序取（与桥接自己一致）：
   `BRIDGE_CONSOLE_TOKEN` 环境变量 → `config.json` 的 `consoleToken` → `state/console-token`（桥接自动
   生成的那份，常态就是它）；返回 401/403 时摘要会写明「令牌来源：…」，不让你对着「未授权」猜。
   端口取 `config.json` 的 `consolePort`，可用 `--console-port` 覆盖；
3. 请求体**只含这次真正改动的字段**（这点很重要）：
   - 全局档位 → `provider` / `model` / `reasoningEffort`（**字符串原样发**；`null` = 显式清空）；
   - 单会话 → `modelOverrides: {"private:<QQ号>": {provider, model, reasoningEffort?}}`；
     `reasoningEffort` **省略** = 端点保持现值；**`null`** = 显式删掉该 key 的 `reasoningEffort`（留空/跟随）。
     本工具换模型时一定会显式发 `defaultEffort` 或 `null`，所以旧模型的档位不会被悄悄带过去；
   - 「跟随全局」→ `removeOverrides: ["private:<QQ号>"]`（**删 key**，不是把全局值写进去）。
4. 端点重读 `config.json`，再按自己的规则分两支处理（**两支都以实测为准**）：
   - **有变化时**：`config.json.bak-model-<时间戳>` 备份 → 原子写 → 同步内存 → `modelSelectionEpoch += 1`；
   - **无变化时（TUI 先写盘的常态）**：**只同步内存**，不写盘、不备份、**不递增 epoch**，
     响应里 `wrote:false`、`backup:null`、`changes:[]` —— 这正是本工具写盘后调它时的常态，别把它
     说成「桥接又改写了一遍」。
   两支都会回一个 `applied`：桥接内存里**实际**生效的档位 + 覆盖表（真端点必返 `modelOverrides`；
   未设置 `reasoningEffort` 时回 `null`）；
5. 本工具**比对回读值**：`applied.provider/model` 必须等于我们刚写进磁盘的档位；本次发过
   `reasoningEffort` 时，`applied.reasoningEffort` 也必须一致（`null`/`''` 都算「清空」）；端点返回
   `applied.modelOverrides` 时（真端点必返）还要与内存快照**同形比对**（对象键排序后逐字段比，
   其中 `"reasoningEffort": null` 与字段缺失视为同义）。
   对得上才打印「已热生效」——**端点说 ok 也不算数**；`wrote`/`changes` 会被如实写进摘要。

因为桥接就是这几个字段的唯一写入者、而我们的补丁只覆盖本次改动的字段，所以**不会**顺手覆盖别人
（控制台、别的脚本）改过的其它字段。

### 6.2 什么情况下会「未能热生效」（摘要里都有明确原因 + 命令）

| 情况 | 摘要里的表现 | 怎么让它生效 |
| --- | --- | --- |
| 桥接没在跑 / 端口不通 / 4 秒无响应 | 「调不到桥接端点 http://127.0.0.1:<port>/api/dsh/model（…）」 | 桥接**本来就没跑**的话不用管：下次启动自然读到新配置。若你刚重启过它，等它起来后重启一次或再跑一遍本工具 |
| 桥接在跑但是**老版本**（没有这个端点） | 端点返回「not found」（HTTP 404） | 换用含该端点的桥接版本（见 §7.3），或重启桥接让新代码生效；老版本只能靠重启 |
| 端点报错（模型目录读不到、鉴权失败、写盘失败…） | 「桥接端点拒绝了这次热更新（HTTP 4xx/5xx + 原文）」 | 按原文里的原因处理（例如 DSH 没起来 → 目录读不到）；随后运行 `restart.bat` |
| **端点拒绝思考强度**（桥上还是只认 low/high/max 的旧版本） | 摘要会有「这次拒绝点名了思考强度：目录档位（medium/xhigh/off…）只有含 t5 兼容扩展的桥接才会按目标模型声明接受，旧版只认 low/high/max」 | 配置已按目录声明**原样**写好（没改名、没降级）。重启到含 t5 的桥接（t1+t5）后按磁盘加载；**不要**手动把档位改成 high/max |
| **强度回读对不上** | 「reasoningEffort 期望 medium、桥接回读 max」 | 桥上还是旧语义（不动 `applied`）。别信那次 ok，也**不要**改档位名；重启到新桥接或找维护者 |
| 端点返回 ok 但回读值对不上 | 「桥接端点返回 ok 但回读值对不上（provider/model/强度 期望…回读…）」 | 说明内存里是别的东西（有人同时改了配置、或桥上逻辑不同）。**别信摘要里的 ok**，跑 `restart.bat` 让它按磁盘重读 |
| `--no-hot-apply` | 「写盘后没有调热更新端点」 | 你显式要求跳过；要生效就 `restart.bat` |
| `--config` 指向**非仓库根**的配置文件 | 「已跳过热生效：端点只会写它自己那份 config.json」 | 这是刻意的保护（否则会改到真配置）。对仓库根的 `config.json` 再跑一次，或 `restart.bat` |

**只写盘不热生效的逃生口**：`--no-hot-apply`（写盘后不调端点）、`--console-port <端口>`（换端口）。

### 6.3 重启与其它热路径（备选，仍然有效）

1. **重启桥接**：双击 `restart.bat`，或停掉 `state/bridge.lock` 里的进程让 `start.bat` 的守护拉起来。
   - 重启**只清内存态**：`modelAppliedSessions`（档位指纹）、运行期缓存等；
   - **`state/sessions.json` 的会话映射不动、DSH 会话上下文也不动**，下一条消息按新配置重新 `selectModel`。
2. **控制台保存一次「二代仿真」设置**：`POST /api/socialV2/config` 会重读 `config.json` 并热合并整段
   `socialV2`（只对 `modelOverrides` 有效，不刷 `dsh.provider` / `dsh.model`）。
3. **`dsh.provider` / `dsh.model`**：用本工具的端点（首选），或 `scripts/switch-model.mjs --to minimax|deepseek`
   （改 `dsh` 段 + 退役重建会话 + 重启桥接，代价是相关会话的 DSH 上下文被清空）。

本脚本**不**杀进程、不重启桥接、不动 `state/sessions.json`；「跟随全局」与单会话改动都只碰
`socialV2.modelOverrides`。

> 版本前提：本节的「端点热生效 + 指纹含 provider/model/effort」对应**当前工作区里已含
> `POST /api/dsh/model` 与 `modelOverrides` + 指纹逻辑的 `src/bridge.js`**（`git status` 里它还是未提交状态，
> 见 §7.3 的交付单元说明）。把这套脚本搬到**更老的桥接版本**时：端点会 404（摘要会如实说「未能热生效」），
> 改动只有**重启桥接**、**退役重建会话**（`switch-model.mjs`）或重启后的新会话才会生效。


## 7. 实测记录（2026-10-12）

在 **<仓库根>** 上跑过（`config.json` 的 sha256 与 mtime 全程受保护，测试后已还原原文件）。
所有需要写盘的用例都先用 `--config <副本>` 或 `--dry-run` 试，最后才在真 `config.json` 上跑一次并还原：

### 7.1 逻辑与写盘（脚本 / TTY 伪装 / 合成仓库）

| 场景 | 命令 / 手法 | 结果 |
| --- | --- | --- |
| 语法 / 帮助 | `node --check scripts/model-tui.mjs`、`--help` | 退出码 0 |
| 只有额度没有改动 | `--dry-run --input number --script`（`7\r`） | 打印「无改动，未写盘」；`config.json` sha256+mtime 不变 |
| 编号模式改单会话 | `--dry-run --input number --script`（`2\r2\r7\r`） | 打印将写入 `private:1234567890 → MiniMax-M3`（`reasoningEffort` 原样保留） |
| 方向键模式改单会话 | `--dry-run --script`（`↓↓ Enter ↓↓ Enter ↓↓↓↓ Enter`） | 打印将写入 `private:3987026018 → deepseek-flash` |
| 「跟随全局」 | `--dry-run` 子菜单选「跟随全局」 | 摘要显示 `{…} → (无)`（key 被删除） |
| 全局档位 | `--dry-run` 第 6 项 → 候选 2 | 摘要显示 `dsh.model: "MiniMax-M3.1-Flash-Preview" → "MiniMax-M3"` |
| 真写盘 | `--input number --script`（改 `private:3987026018`） | 备份 `config.json.bak-tui-20261012T184537`（原始字节，sha256 `4216e0181c16982e…` 与测试前一致）；新文件 sha256 变化；回读自检「一致」；随后已把 `config.json` 还原回原 sha256 与 mtime |
| 无改动不产生备份 | 同上但直接选 exit | 备份数不变 |
| **多位编号（本轮新增）** | 合成仓库（12 私聊 + 3 群 = 17 项）`--input number --script`：`12\r2\r17\r` | 底部显示「编号输入：12」并跳到第 12 项，摘要 `private:10012 → MiniMax-M3` |
| **编号接不上就重开（本轮新增）** | 同上，`25\r…` | 17 项列表里 `2` 先到第 2 项，`5` 接成 25 超界 → 改成第 5 项（子菜单标题为 `private:10005`） |
| **编号越界提示（本轮新增）** | 同上，`100\r…`、`0\r…` | 显示「没有第 100/0 项：这里一共 17 项（输入 1~17 之间的编号即可，多位数字可以连打）」，光标不动 |
| **子菜单光标默认位（本轮新增）** | 同上：`5\r`（该 key 已有覆盖）/ `16\r`（全局）/ `1\r`（无覆盖） | 分别停在第 3 个候选（`deepseek-flash`）/ 第 1 个候选（当前全局档位）/ 「跟随全局」 |
| **确认同值提示未变化（本轮新增）** | 同上：`5\r\r17\r` | 打印「未变化：private:10005 已经是 deepseek-flash…没有记入改动」，随后 `exit` 报「无改动，未写盘」 |
| **ledger 懒加载 / r 重读（本轮新增）** | TTY 伪装驱动跑合成仓库，中途外部往 `state/token-usage.jsonl` 追加一条记录 | 按一次 `↓` 重绘后「实际」由 `MiniMax-M3` 变成 `deepseek-flash`；按 `r` 同样刷新；脚注显示快照时间 |
| **并发落盘保护（本轮新增）** | TTY 伪装驱动：改完内存档位后外部改 `config.json`，再按 exit | 退出码 1；「config.json 已被其它进程修改，本次改动未写入。」+ before/after sha256 + 备份 `<配置文件名>.bak-tui-<时间戳>-conflict`；外部改动保留、TUI 改动未落盘 |
| raw mode / 终端恢复 | TTY 伪装 preload 喂分块按键（含单独 `ESC` 再 `[B` 的 45ms 定时器路径） | `setRawMode(true)` → `setRawMode(false)`；光标 hide/show；清屏重绘；退出码 0 |
| 交互路径真写盘 | 同上 + `--config <副本>`，改一处会话模型后 exit | 副本 sha256 变化 + 生成 `<副本名>.bak-tui-<时间戳>` + 自检通过 |
| `Ctrl+C` | 同上，喂 `\x03` | 退出码 130；打印「已取消（收到 Ctrl+C）：未写盘」；raw mode 已关；`config.json` 未变 |
| 异常 / 用法错误 | `--config <目录>`、`--input bogus`、缺 `--script` 文件 | 分别 1 / 2 / 2；都恢复终端且不写盘 |

### 7.2 真实控制台（本轮新增，集成阶段）

自动化环境里没有可交互终端（stdin/stdout 都是管道），所以这一轮用 **ConPTY（真伪控制台）** 起了
**真正的 cmd / Windows PowerShell 控制台**（`CreatePseudoConsole` + `STARTF_USESTDHANDLES` 空句柄，
让子进程拿到真控制台句柄，`process.stdin.isTTY` 与 `stdout.isTTY` 都是 `true`），再用按键脚本喂真键盘输入，
把控制台渲染出的 VT 流转回屏幕文本核对：

| 场景 | 命令 | 结果 |
| --- | --- | --- |
| **cmd 里跑 bat** | ConPTY 里 `call "<仓库根>\模型管理.bat" --config <副本>`（等价双击） | 中文标题/额度行/列表全部正常；`↓ ↓ Enter ↓ ↓ Enter` 进子菜单并确认；`r` 重新拉取额度（时间戳刷新为 19:05:14）；`↓↓↓↓ Enter` 选中 exit → 落盘成功：备份 `console-config.json.bak-tui-<时间戳>`（临时副本的备份，已清理）、自检「一致」、摘要 `private:3987026018 → MiniMax-M3`；末尾 `pause` 与光标恢复（`[?25h`）都正常 |
| **PowerShell 里跑脚本** | ConPTY 里 `powershell.exe -File run-console-ps.ps1`（内部 `node scripts\model-tui.mjs --config <副本> --no-quota`） | 编号键 `3 → Enter → 3 → Enter → 7 → Enter` 走完全流程；底部「编号输入：7」提示可见；落盘成功（备份 `console-config-ps.json.bak-tui-<时间戳>`（临时副本的备份，已清理），摘要 `private:3987026018 → (无) → {"provider":"deepseek-account","model":"deepseek-flash"}`） |
| **中文与列对齐（量测）** | 把两次抓到的 VT 流用测试脚本重建成屏幕文本，再按**显示宽度**（CJK 记 2 列）算列号 | 两个控制台里 5 条会话行的 `［单独设置］/［跟随全局］` 标记列**都落在第 99 列**（完全对齐）；中文全部正常（cmd 侧靠 `chcp 65001`，PowerShell 侧 Node 直接走控制台 API 写 UTF-16，不依赖 `chcp`）。模型名与 `(实际: …)` 按规格紧挨着显示，所以 `(实际` 的起始列会随模型名长短变化 —— 这是刻意的（对齐的是模型列与标记列） |

键位手感：两套按键（`↑/↓` 与编号）在真控制台里都即时生效；`Esc`/`b` 返回子菜单、`r` 刷新、
`Enter` 打开/确认与 `--script` 模式完全一致。

> 说明：ConPTY 的输入是「按键流」而不是物理键盘，`↓` 走的是 `ESC[B` 转义序列（和真终端一致）；
> 物理键盘的最后一公里（双击图标、真人按方向键）建议部署后再顺手过一遍，本轮的键位与渲染已用真控制台验证。

### 7.3 交付单元与桥接版本（本轮新增）

- `git status --porcelain` 里 `src/bridge.js`（+81/-35）与 `scripts/switch-model.mjs`（+71/-35）
  **本来就是未提交的工作区改动**，本轮**只读不改**（`src/**` 在 out-of-scope 里）。
- 它们的回归结果（只读核对）：`ensureChatModel` 的指纹是
  `${modelSelectionEpoch}|${sel.provider}|${sel.model}|${sel.effort}`（`src/bridge.js` 里
  `modelAppliedSessions` + `modelSelectionEpoch` 那一段），`modelSelectionFor(key)` 的覆盖语义与
  本工具完全一致，并且有 `modelSelectionEpoch += 1` 的热切换入口 ⇒ **TUI 只适用于这个版本（已含
  `modelOverrides` 与指纹逻辑）**；`scripts/switch-model.mjs` 的 `--to/--only/--force` 仍可直接配合使用
  （TUI 改细粒度、switch-model 做整体切换 + 退役重建）。
- 也就是说：本轮交付**不**包含 `src/bridge.js` / `scripts/switch-model.mjs` 的改动，
  但它们必须与本脚本**一起发布**才谈得上「改完下一条消息生效」；老版本桥接下请按 §6 结尾那段说明处理。

### 7.4 接入桥接端点（2026-10-12 晚，两轮实测）

`exit` 写盘后自动调 `POST /api/dsh/model` 的完整实测（真桥接 **pid 42380 全程未重启**、真端点、
真 `config.json`）：

| 场景 | 命令 / 手法 | 结果 |
| --- | --- | --- |
| **真热生效（第一轮 19:54:29）** | `node scripts\model-tui.mjs --no-quota --input number --config <仓库 config.json> --script`（`6\r2\r7\r`：全局档位 → 候选 2 → exit） | 写盘前 `config.json` = sha256 `4216e0181c16982e…` / 7805 字节 / mtime_ns `1791805501178412500`；摘要「【写盘完成】… 自检 sha256 `4216e0181c16982e…` → `62173a0a51cfb633…`」+「**已热生效** … **下一条消息生效**」；改档后 sha256 `62173a0a51cfb633…` / 7789 字节；`bridge.log` 出现「控制台：模型档位已热更新（dsh.model），epoch=27」（**就地**热更新，pid 不变） |
| **真热生效复跑（第二轮 19:55:47，token 来源改完之后）** | 同上（`6\r2\r7\r`） | 同样「已热生效」（`wrote:false`：磁盘已由本工具写好、端点只同步内存）；`bridge.log`「模型档位已热更新（dsh.model），epoch=28」；说明改 `consoleToken()` 没破坏成功路径 |
| **当场还原并核验** | 用同一端点 `POST {"provider":"minimax-cn","model":"MiniMax-M3.1-Flash-Preview"}` 改回基线 → 再 `os.utime` 把 mtime 拨回 | 还原时刻 **19:54:29 / 19:55:47**（写前备份名的时间戳 `…T195429` / `…T195547` 可对）；还原 POST 返回 `wrote:true` / `changes:[dsh.model MiniMax-M3 → MiniMax-M3.1-Flash-Preview]` / `backup config.json.bak-model-<时间戳>`；**当场**打印核验：sha256 `4216e0181c16982e…`、7805 字节、mtime_ns `1791805501178412500` —— **三项与写盘前完全相同**；主人的 `socialV2.modelOverrides["private:1234567890"]` 全程原样（本轮**没有**拿它当跟随全局的测试对象） |
| **回读不符就不认 ok** | 沙箱 + 假端点回 `200 {"ok":true,"applied":<别的档位>}` | 「未能热生效：桥接端点返回 ok 但**回读值对不上**（provider 期望 …、桥接回读 …）」——不轻信 ok |
| **端点不可达（超时）** | 沙箱仓库（脚本副本 + `config.json` 指向只接受不回响应的 TCP 服务） | 「**未能热生效**：调不到桥接端点 `http://127.0.0.1:<port>/api/dsh/model`（**4 秒超时**）」+「config.json 已经写好，改动不会丢」+ `restart.bat` |
| **端点拒绝** | 沙箱 + 假端点返回 `500 {"ok":false,"error":"模拟失败：读不到 DSH 模型目录"}` | 「未能热生效：桥接端点拒绝了这次热更新（**HTTP 500 模拟失败…**）」 |
| **401 时标注令牌来源** | 沙箱 + 假端点恒回 401；分别让 `config.json` / `state/console-token` / `BRIDGE_CONSOLE_TOKEN` 提供令牌 | 四次分别打印「令牌来源：`config.json`」「`state/console-token`」「`BRIDGE_CONSOLE_TOKEN`」「`(没有可用令牌)`（当前没有取到任何令牌）」（解析顺序见 §6.1 第 2 步） |
| **--dry-run** | `--dry-run` + 指向死端口 | 只打印将要写入的变更与并发检查；不写盘、**不调端点**（副本字节不变） |
| **--no-hot-apply** | 副本 + `--no-hot-apply` | 「（--no-hot-apply：写盘后没有调热更新端点）」+ 说明何时生效；不静默 |
| **--config 指向副本** | 副本（不带额外参数，端点其实是活的） | 「（--config 指向 <副本>，已跳过热生效：端点只会写它自己那份 config.json）」——**避免端点改到真配置**；仓库 `config.json` 未被触碰 |
| **--console-port 校验** | `--console-port 0 / 70000 / abc` | 退出码 2 +「--console-port 只支持 1-65535 的整数」 |

> 说明 1：`--config` 指向非仓库根配置时**故意不调端点**（端点永远写它自己那份 `config.json`）。
> 说明 2：上表「真热生效」两轮是仅有的、在真 `config.json` 上的写盘：**当场**改回基线并把 mtime 拨回，
> 再用 python 打印 `sha256 + 字节数 + mtime_ns` 与写盘前对比（三项相同）——不是事后凭印象声称。
> 说明 3：表里出现的中间备份（`config.json.bak-tui-<时间戳>` / `config.json.bak-model-<时间戳>`）是
> **历史记录**，测试产生的那些已清理掉（内容分别等于「写盘前的 config.json」和「改档后的 config.json」，
> sha256 见上表）。仓库里现在只留两份带具体名字的：`config.json.bak-tui-20261012T184537`
> （第一轮写盘前的原始字节）与 `config.json.bak-model-20261012T194501`（主人 19:45 用端点恢复被误删
> 覆盖时的写前备份）。

### 7.5 一分钟实机自检清单（给人看的，双击一次就够）

> 这一节是给**物理键盘 + 真人**用的最后确认步骤（自动化能测的都在 7.1–7.4 里测完了）。

1. 双击仓库根目录的 **`模型管理.bat`**。窗口里应出现中文标题、额度行、会话列表，没有乱码。
2. 看列表右侧的 `［单独设置］/［跟随全局］` 一列是否**笔直对齐**（允许模型名长短不一）。
3. 按 `↑` `↓` 几次：高亮条是否跟着走、按一下动一格、**没有残影/闪烁**（旧的高亮行是否干净消失）。
4. 按 `Enter` 打开模型列表 → 用 `↑/↓` 选一项 → 按 `Enter` 确认（会自动进思考强度菜单，再按 `Enter` 确认）
   → 回到列表并看到「已记录（内存）」；再按 `Enter` 打开一次、按 `Esc` 返回（两级子菜单能进能出）。
5. 按 `r`：额度行与目录行的时间戳应该各刷新一次（目录行会重新显示 provider/模型数量）。
6. 反复按 `↓` 到底部的 `exit` → 按 `Enter`。应看到备份名、自检「一致」、「已热生效」或「未能热生效」的
   明确结论，然后回到命令行（`pause` 停住）。
7. 关窗口前再看一眼：**光标回来了、终端能正常回显**（若光标不见了，说明终端没恢复，请回报）。
8. 默认模式：现在是**方向键**。若你的终端方向键不好用（例如某些串口/老终端），改用
   `模型管理.bat --input number`，或告诉作者把默认改成编号。

### 7.6 方案 A 动态目录 / 真实档位（2026-10-17，本轮）

> 环境事实先说清：**生产桥接（3100）仍在跑旧代码，还没加载 A① 的 `GET /api/dsh/models`**（本轮禁止重启，
> 所以 3100 上只能看到 404 → 降级；`GET /api/dsh/models` 无令牌时回 401，不能据此判断路由是否存在）。
> 真实 DSH 地址是 `http://127.0.0.1:19387`（只读核对配置，未改配置、未重启）。
>
> 本轮用两种**独立临时夹具**（`%TEMP%\model-tui-a2-20261017`，不碰真实 `config.json`/`state/`）：
> ① **假桥接端点**（`mock-catalog.cjs`，目录形状与 t5 协议按交接实现）——快速覆盖 UI 分支；
> ② **真桥接代码 + 真目录数据**（`bridgeHarness` 把真实 `src/bridge.js` 跑在临时仓库里，目录用桥接自己的
> `NodeApiClient` 从 19387 **只读**取回的 `session/modelCatalog` 注入，15 个模型 / 4 个 provider 原样；
> TUI 用真实 `scripts/model-tui.mjs` 连它做写盘 + POST + 回读）——见 §7.6.5。两者都不连 QQ/DSH 写接口，
> 不打印凭据，也不改动生产配置。
> 生产 3100 的新路由/活体仍属**未验证**（旧进程未重启，镜像不到新代码）；真实目录数据本身已只读取到。

| 场景 | 命令 / 手法（全部实际执行） | 结果 |
| --- | --- | --- |
| 语法 / 帮助 | `node --check scripts/model-tui.mjs`；`node scripts/model-tui.mjs --help` | 退出码 0 / 0 |
| 规定 verify 命令（真实仓库、**真 ConPTY**） | `node scripts/model-tui.mjs --dry-run` 放在真 pseudo-console 里（`pty2.ps1 -Variant nullstd`，子进程拿到真控制台句柄、`isTTY=true`），按键脚本「跳到第 7 项（exit）+ Enter」 | **`child_exit_code=0`**；屏幕文本「无改动，未写盘（未新建备份、未改动任何文件）」；额度行/目录行正常渲染（目录按预期显示 3100 的 404 降级）；真实 `config.json` sha256 前后一致 |
| 同上但纯管道（非 TTY） | `node scripts/model-tui.mjs --dry-run` 直接重定向 | 退出码 2 +「需要交互式终端（TTY）：stdin 不是 TTY」——这是**环境限制**，不当作通过（真实 TTY 证据见上一行） |

#### 7.6.1 A② 菜单来自目录（夹具端点按 t1 真实形状返回 3 provider / 11 model）

| 场景 | 手法 | 结果 |
| --- | --- | --- |
| 7 个 GPT 模型可见 | 单会话 `1\r` 打开模型列表 | 目录行 `3 个 provider / 11 个模型`；菜单逐项列出 `gpt-6.1-sol / gpt-6-astra / gpt-6-sol / gpt-6-luna / gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna`（detail 带 provider、显示名、声明档位） |
| 目录不是写死三个 | 同上 | 同时列出 `deepseek-flash / deepseek-v4-pro / MiniMax-M3.1-Flash-Preview / MiniMax-M3`；`MODEL_CANDIDATES` 已从代码删除 |
| `r` 重新读目录 | `r1\r` | 假端点收到 **2 次** `GET /api/dsh/models`（启动 1 次 + r 1 次） |

#### 7.6.2 A③ 档位 / 默认 / 清空 / 热更新（假端点按 t5 协议实现）

| 场景 | 手法 | 结果 |
| --- | --- | --- |
| 只列声明档位 | 全局 → `gpt-6.1-sol` | 档位菜单只有 `low/medium/high/xhigh` + 「留空 / 跟随」，**没有 max**；带 name/description；光标停在 `defaultEffort`（medium） |
| 切模型重置 defaultEffort | 会话 → `gpt-6-astra`（默认 medium） | 内存摘要「思考强度已重置为该模型 defaultEffort「medium」」；列表该行 `gpt-6-astra · 强度 medium` |
| 写入 + 热生效传递真实档位 | `1\r2\r\r5\r`（真写盘，假端点回读磁盘） | 磁盘 `{"provider":"local-codex-app-server","model":"gpt-6-astra","reasoningEffort":"medium"}`；POST body 原样带 `reasoningEffort:"medium"`；回读一致 → 「已热生效 … 思考强度（medium（private:1420193228））也已同步」；备份 `config.json.bak-tui-…`、自检「回读 JSON 与内存一致 = 是」 |
| 声明档位 xhigh 也能热生效 | 会话 → `gpt-6.1-sol` → 档位 `xhigh` | 磁盘 `reasoningEffort:"xhigh"`；POST 带 `xhigh`；回读一致 → 「已热生效」 |
| 全局档位同一套 | 全局 → `gpt-6.1-sol` | 变更摘要 `dsh.reasoningEffort: "high" → "medium"`；POST `{"provider":"local-codex-app-server","model":"gpt-6.1-sol","reasoningEffort":"medium"}`；「已热生效」 |
| 无档位模型可直接确认并清空旧值 | 会话（原 high）→ `MiniMax-M3` | 切模型即清空：「该模型未声明任何思考档位（不支持思考强度）⇒ reasoningEffort 已留空/跟随（原档位「high」已清除）」；档位菜单只有「该模型不支持思考强度」；磁盘覆盖 `{"provider":"minimax-cn","model":"MiniMax-M3"}`（无 effort）；POST 显式 `"reasoningEffort":null`；回读一致 → 「已热生效」 |
| 无 default 留空/跟随 | 会话 → `gpt-5.6-luna`（有档位、无 default） | 提示「该模型没有 defaultEffort ⇒ reasoningEffort 已留空/跟随」；档位菜单光标停在「留空 / 跟随」；磁盘覆盖无 effort；热生效 ok |
| `e` 键只改强度不换模型 | 会话 2 `e` → 档位 `max` | 摘要 `{"…deepseek-flash","reasoningEffort":"high"} → {"…","reasoningEffort":"max"}`；dry-run 后磁盘未变 |
| 旧桥接拒绝 medium：如实失败不伪造 | 假端点按旧白名单回 400 | 磁盘已写 `medium`；摘要「**未能热生效**：桥接端点拒绝了这次热更新（HTTP 400 reasoningEffort 非法…）」+「这次拒绝点名了思考强度…重启到含 t5 的桥接后按磁盘加载」，**没有**改写成 high/max |

#### 7.6.3 A④ 额度（真实额度端点，用**假 key**，不读真实凭据）

| 场景 | 手法 | 结果 |
| --- | --- | --- |
| 无查询能力 | 光标在 `local-codex-app-server` 的会话（ledger 实际 provider） | 「**本地 Codex 模型未配置额度查询**（provider local-codex-app-server）」，不显示 0 |
| 有能力但凭证不可用 | 设 `MINIMAX_CN_API_KEY/DEEPSEEK_API_KEY=fake-…` 后跑 | MiniMax：「**API Key 不可用，无法查询余额**（HTTP 200 base_resp 1004 login fail…）」；DeepSeek：「**API Key 不可用，无法查询余额**（HTTP 401 …）」 |
| 按实际 provider 切换 | 光标从会话 1（实际 local-codex）移到会话 3（实际 minimax） | 第一格随之变为 `MiniMax …`，行尾标 `（按 private:1420193228 / group:863736632（实际 provider））` |
| `--no-quota` | 同上加 `--no-quota` | 「本地 Codex 模型未配置额度查询（--no-quota：已跳过联网查询）」——能力说明仍保留 |

#### 7.6.4 A⑤ 降级 / A⑥ 安全行为（夹具）

| 场景 | 手法 | 结果 |
| --- | --- | --- |
| 桥接自报降级 | 假端点 `source=fallback,degraded=true` | 目录行「已降级：DSH 目录读取失败，已退回仅 DeepSeek 的兜底（原因：…；兜底项未经本次目录验证）」；菜单只有 `deepseek-account/deepseek-flash`、`deepseek-account/deepseek-v4-pro`、`deepseek-official/deepseek-flash`，**0 个** gpt/MiniMax 可选项；每项标「兜底·未验证」 |
| 连不上桥接 | `--console-port 34599`（无监听） | 目录行同上，原因 `调不到…（ECONNREFUSED）`；菜单仍是 DeepSeek 兜底（非空） |
| 未知配置模型 | 配置里 `my-unknown-model-x` | 列表正常显示；模型菜单第一项「保持当前 my-unknown-model-x：选它 = 不改动、不自动改写（A⑥）」；确认后提示未改动，`exit` 报「无改动，未写盘」，文件 sha256 不变 |
| dry-run 零写入 | `--dry-run` 走完切模型 | 打印将写入项 + 并发检查；配置文件 sha256 不变 |
| Ctrl+C 零写入 | 改完后喂 `\x03` | 退出码 **130**、「已取消（收到 Ctrl+C）：未写盘」，sha256 不变、无新备份 |
| 无改动 exit | `5\r` | 「无改动，未写盘（未新建备份、未改动任何文件）」，sha256 不变 |
| 并发改动保护 | 假端点延迟 2.5s，运行中外部改夹具 config | 退出码 **1**、「config.json 已被其它进程修改，本次改动未写入」+ before/after sha256 + `…-conflict` 备份；外部内容原样保留，TUI 改动未落盘 |
| 真写盘安全 | 夹具仓库真写盘 | 备份 `config.json.bak-tui-20261017T…` + 临时文件 rename + 回读自检「一致」+ 变更摘要（旧→新） |
| 终端恢复 | ① TTY 伪装（`isTTY` + `setRawMode` shim）：记录到 `setRawMode(true)` → `setRawMode(false)`，输出含 `\x1b[?25l`（隐藏光标）与 `\x1b[?25h\x1b[0m`（恢复光标+复位），退出码 0；② 真 ConPTY 跑完 exit → `child_exit_code=0`，捕获流含清屏与隐藏光标（结束瞬间的 `?25h` 没被 ConPTY 读取线程截到，该分支由 ① 明确覆盖） | 通过（伪装层逐字节 + 真控制台退出码） |
| 真实配置安全 | 全程 `Get-FileHash config.json` | 真实 `config.json` sha256 前后一致、字节数 7799 不变；未写 `state/` |

#### 7.6.5 联合验证：真实 TUI → 补丁 → 真实 `src/bridge.js` → 真实 DSH 目录（2026-10-17）

做法：用仓库既有的 `scripts/audit-bridge-harness.mjs` 把**真实 `src/bridge.js`（含 t1+t5）**跑在临时仓库里
（临时 config/state，QQ/DSH/SnowLuma 全是桩）；目录用桥接自己的 `NodeApiClient` 从 `19387` **只读**
`session/modelCatalog` 取回后注入（4 provider / 15 model，`local-codex-app-server` 7 个模型与
`minimax-cn/MiniMax-M3` 的声明档位都是真的）；再由**真实 `scripts/model-tui.mjs`** 连这个 console 端口
写盘 + POST + 比对回读。共 **30 条断言全过**（`JOINT_TOTAL=30 FAILED=0`）：

| 用例 | 手法（真实 TUI 按键） | 证据（界面 / 桥接磁盘 / 桥接内存） |
| --- | --- | --- |
| A 会话换到真实模型（真实 defaultEffort） | `1\r` → 选 `gpt-6-astra`（第 10 项，目录 default=low）→ Enter | 目录行「4 个 provider / 15 个模型」，菜单列出全部 7 个 GPT 模型（真实 id/显示名/声明档位）；摘要「思考强度已重置为该模型 defaultEffort「low」」；「【写盘完成】… 自检：回读 JSON 与内存一致 = 是」；「已热生效：端点又改写了 1 处并同步了内存（epoch 1）；思考强度（low（private:1420193228））也已同步」；桥接磁盘 = 内存 = `{provider:local-codex-app-server, model:gpt-6-astra, reasoningEffort:low}` |
| B `changes=0` 内存同步 | 先让桥接磁盘已是目标值，再跑同样的换模型 | 摘要「已热生效 … wrote:false —— 磁盘已由本工具写好」；桥接 `config.json` **mtime 不变**（没再写盘）；内存仍是 `gpt-6-astra/low`（changes=0 也同步，不残留旧值） |
| C 会话显式清空（`null`） | 会话 1 → `e` → 选「留空 / 跟随」 | 「已热生效 … 思考强度（清空（private:1420193228））」；桥接内存/磁盘覆盖表里 `reasoningEffort` **字段不存在**（跟随全局） |
| D 全局显式清空 | 全局档位 → `e` → 「留空 / 跟随」 | 桥接磁盘 `dsh.reasoningEffort = ""`、内存 `""`（t5 的「显式未设置」哨兵），applied 回 `null`，TUI 回读一致 → 「已热生效」 |
| E 全局换到真实模型（声明档位校验） | 全局 → `gpt-6.1-sol`（目录 default=low） | 摘要含 `dsh.provider/dsh.model/dsh.reasoningEffort` 三行；桥接磁盘=内存=`local-codex-app-server/gpt-6.1-sol/low`；「已热生效」 |
| F 无 `defaultEffort` 的真实模型（继承/不残留） | 会话 2 → `minimax-cn/MiniMax-M3`（真实声明 `off/minimal/low/medium/high`、**无默认**） | 切模型摘要「该模型没有 defaultEffort ⇒ reasoningEffort 已留空/跟随（原档位「high」已清除，不残留旧模型的档位）」；档位菜单把「留空 / 跟随」标成当前项；POST 带 `reasoningEffort:null`；桥接内存/磁盘 `{provider:minimax-cn, model:MiniMax-M3}`（无 effort）；「已热生效 … 清空」 |

> 口径：这是**真实桥接代码 + 真实目录数据**的联合证据，但目录 RPC 的传输层是 harness 注入（不是生产 3100
> 进程），生产 3100 上的新路由仍未加载（旧进程未重启）——那一项在 t3 里如实标注未验证。
> 真实目录里**没有** `efforts: []` 的模型，所以「该模型不支持思考强度」这一支只有夹具证据（§7.6.2）。

## 8. 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `需要交互式终端（TTY）` | stdin 不是终端（管道 / 重定向）。用 `--script` 或在真实控制台里跑 `模型管理.bat`。 |
| 中文乱码（bat 自己的 echo 行） | cmd 里必须让 bat **先** `chcp 65001`（`模型管理.bat` 已经这么做了；实测正常）。 |
| 中文乱码（Node 界面） | 实测不需要额外设置（Node 在 Windows 控制台上直接写 UTF-16）。若你的终端把控制台代码页改成了别的值又接了非 UTF-8 管道，先 `chcp 65001`。 |
| 额度行显示「取不到」/「查询失败」 | 看括号里的原因：网络、HTTP 状态码。额度本身不影响改模型。 |
| 额度行显示「API Key 不可用，无法查询余额」 | 该 provider 有额度查询能力，但凭据读不到/被拒：检查同名环境变量、`~/.dsh/.credentials.yaml` 的 `refs` 段（MiniMax 的 `base_resp.status_code=1004` 也归到这一档）。本工具不会打印令牌本身。 |
| 额度行显示「<显示名> 模型未配置额度查询」 | 当前会话实际用的 provider 没有额度查询能力（例如 `local-codex-app-server`）。这是能力说明，不是「余额为 0」。 |
| 目录行显示「已降级：DSH 目录读取失败…」 | 桥接的 `GET /api/dsh/models` 读不到/404/超时，或桥接自己报了降级。先看括号里的原因：HTTP 404 = 桥接是旧版本（未加载 A① 路由，重启桥接即可）；ECONNREFUSED = 桥接没在跑；401/403 = 令牌来源见括号。此时菜单只剩 DeepSeek 兜底（标「兜底·未验证」），不空菜单、不静默。 |
| 目录里的模型选不到 | 目录降级时菜单只保留 DeepSeek 家族（A⑤ 定稿），其它 provider 要等目录恢复（按 `r` 重试）；`--console-port` 指错了端口也会导致连不上。 |
| 档位选了 medium/xhigh 却提示「未能热生效」 | 桥接版本问题：只有含 t5 兼容扩展的桥接才会按目标模型声明接受这些档位。配置已写盘，重启到新桥接后生效；**不要**手动把档位改成 high/max（本工具不会这么做）。 |
| 「实际模型」一直不变 | 脚注里有快照时间：列表重绘时按 `state/token-usage.jsonl` 的 mtime 自动重读，按 `r` 强制重读。若一直停在旧值，检查该文件有没有新记录（桥接侧要有人说话才会写）。 |
| `config.json 已被其它进程修改，本次改动未写入` | 正常保护：控制台保存过、`switch-model.mjs` 跑过、或有人手改过。看备份 `*.bak-tui-*-conflict` 确认现状，重新打开本工具再做一次。 |
| 写了之后没生效 | 先看摘要最后几行：**「已热生效」就不用做任何事**（下一条消息生效）；只有「未能热生效」才按 §6.2 处理（一般是 `restart.bat`）。 |
| 摘要说「未能热生效」 | 括号里就是原因：端口不通 / 4 秒超时 → 桥接可能没在跑；HTTP 404 → 桥接是老版本（没有 `POST /api/dsh/model`）；HTTP 4xx/5xx → 看端点返回的原文（例如 DSH 没起来导致模型目录读不到）。改动已落盘不会丢，`restart.bat` 后即生效。 |
| 摘要说「回读值对不上」 | 有别的进程同时在改档位（控制台 / 脚本）。不要信那次 ok，跑 `restart.bat` 让桥接按磁盘重读一遍。 |
| `原子替换失败` | 极少数情况是杀软/编辑器正占用 `config.json`：备份已保留，原文件未改动，关掉占用者再试。 |
| 改坏了想回滚 | `copy /Y "<仓库根>\config.json.bak-tui-<时间戳>" "<仓库根>\config.json"`（备份是写入前的原始字节）。 |

## 9. 已知限制

- **未保存就丢**：改动只在内存（没有草稿文件、没有自动保存）。崩溃 / 强杀 / 直接关窗口 = 改动作废。
- **列表超过一屏**要自己滚：本工具按窗口高度不做分页（会直接刷满，光标移出可视区时靠终端自身滚动）。
- **编号输入只到列表长度**：光标跳转按当前项数校验；模型子菜单现在是「目录里所有模型 + 跟随全局」，
  编号可以连打（例如 `12`），超过项数会提示并停住。
- **一次只写一份配置**：`--config` 指向非仓库根文件时会跳过热生效（防误改真配置），此时只能靠重启生效。
- **额度联网失败不影响改模型**：额度行只显示「未配置查询 / API Key 不可用 / 查询失败 + 原因」，功能照常。
- **菜单依赖运行中桥接的 A① 路由**：`GET /api/dsh/models` 是新接口（t1），**桥接不重启不会加载**。
  旧桥接返回 404 ⇒ 目录行显示降级、菜单只剩 DeepSeek 兜底（不冒充目录）。
- **热生效依赖桥接版本**：`POST /api/dsh/model` 的档位校验/清空语义由 t5 扩展。旧版桥接只认
  low/high/max 且不能清空 ⇒ 目录档位（medium/xhigh/off…）写盘成功但热更新会被 400 拒绝，
  摘要会如实说「未能热生效」；重启到含 t1+t5 的桥接后按磁盘加载。本工具**不预过滤、不改名、不映射**。
- **全局 `dsh.reasoningEffort = ""` 的含义**：显式「未设置」——下一条 `selectModel` 省略该档位、由模型
  自身默认决定；**缺字段**才是老配置的默认 `max`。两种状态在界面和摘要里分开显示。
- **兜底菜单未经目录验证**：目录读不到时列出的 `deepseek-account` / `deepseek-official` 是本地兼容清单
  （id 来自本项目真实探针与桥接默认），界面一律标「兜底·未验证」；目录恢复后按 `r` 重新读取。
- **`modelOverrides` 里的历史字段**：本工具改一个会话时只改 `provider` / `model` / `reasoningEffort`，
  其它未知字段原样保留（热更新补丁会把它们留给端点按磁盘合并）；「跟随全局」是整条删除，字段一起没。
- **`local-codex-app-server` 的两个硬限制**（插件 README 记录，与本工具无关但会影响体感）：
  **同一运行中的会话不能换模型**（要新建会话才会用新模型）；**重启后暂不能恢复 GPT 会话**（会明确报错）。
  本工具只改配置/热更新内存档位，不新建会话、不碰会话历史。
- **退出前清残留输入（`--drain-ms`，与下面 §10 那个 bug 无关）**：退出前（恢复终端状态**之前**）会把
  stdin 里排队的输入读掉并丢弃 —— POSIX 走 `fs.readSync` 循环（读到 `EAGAIN` 即停，不阻塞），
  Windows 走「flowing 读 + 静默窗口」（默认 80ms；控制台句柄的同步读在没有输入时会阻塞，纯 JS 无法先
  探测，所以不用 readSync）。真读到东西时摘要会补一行「（防御性清理：退出前丢弃了 N 字节残留输入）」。
  这只是**防御性加固**：曾经怀疑「退出后外层 shell 执行假命令」是输入残留，后来查明真因是 §10 那个
  bat 编码问题（**与输入残留无关**）。它保留下来是因为无害且能挡住真实存在的边角情况（例如退出瞬间
  还在排队的多余按键）；`--drain-ms 0` 可关掉，`--drain-ms 1500` 可把窗口拉长。

## 10. 已修：bat 里的非 ASCII 行会被 cmd 拆坏（2026-10-12 定位）

**现象**：在 Windows Terminal（ConPTY 控制台）里跑 `模型管理.bat`，窗口里会多出几行
`'on' is not recognized as an internal or external command,`、`'<乱码>' is not recognized ...`
（乱码片段是**被拆坏的中文**，例如 `互终端`）。用户双击时看到的就是这个。

**真因**（队长用真 ConPTY 二分定位，我在同一方法下独立复现）：`模型管理.bat` 里的**中文 `echo` / `rem`
行**，在「ConPTY 控制台 + `chcp 65001`」这条路径下会被 cmd 拆开，拆出来的碎片被当成命令执行。
**非 TTY 跑（管道 / CI / 逐行喂）复现不出来** —— cmd 在那种情况下走另一条解析路径，所以之前逐行、
整份、936/65001 两种代码页的测试全是绿的，问题一直藏在这里（用户也确认从未粘贴过任何东西）。

**修法**：`模型管理.bat` 保持 **ASCII-only**（注释写成英文一句话），**只有 `title` 那行保留中文**
（实测安全，窗口标题仍显示「模型管理 - QQ bridge」）。原来那 6 行中文 banner 直接删掉了 ——
TUI 一启动就清屏重绘，banner 本来也看不见。

| 变体（真 ConPTY，`cmd /c 模型管理.bat`） | 假命令条数 | 碎片 |
| --- | --- | --- |
| 原版（中文 `echo` + 中文 `rem`） | 2–3 | `on`、`互终端`（我独立复现出 2 条） |
| 中文 `echo` 全改 ASCII | 2 | `on`、`互终端` |
| 中文 `rem` 全改 ASCII | 1 | 其余碎片 |
| 全部非 ASCII → ASCII | **0** | — |
| 仅 `title` 保留中文 | **0** | — |

**怎么复现 / 怎么验证**（原样可重跑；ConPTY 驱动必须带 `-Variant nullstd`，否则子进程拿不到真控制台）：

```powershell
# 1) 真控制台里跑 bat（沙箱 config 只为了避免碰真配置；现象只取决于 bat 字节）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\model-tui-test\pty2.ps1 `
  -CommandLine 'cmd /c 模型管理.bat --config <沙箱 config 路径> --no-quota --input number' `
  -Cwd '<仓库根>' -Cols 120 -Rows 40 -InputScript <keys.txt> -OutFile <out.bin> -Variant nullstd -TailMs 2500
# 2) 把 VT 流还原成屏幕文本，断言 not recognized 条数为 0
node $env:TEMP\model-tui-test\vt-screen.cjs <out.bin> <out.screen.txt>
```

实测（2026-10-12 20:12）：改前 **2 条**假命令（`on`、`互终端`）→ 改后 **0 条**；窗口标题里的中文仍正常，
TUI 照常跑完（`无改动，未写盘` + `pause`），bat 的退出码透传（`--help`→0、未知参数→2）也没变。

> 附：本轮同时给 TUI 加了「退出前清残留输入」的防御性代码（§9 最后一条）。它**不是**这个问题的修复，
> 保留只是因为无害；真正修好这个现象的是上面这条「bat 保持 ASCII」。


## 11. 方案 A：动态目录与档位热更新协议（2026-10-17，t5 v1）

### 11.1 为什么需要这节

A③ 要求「只展示所选模型声明的档位」，而目录里真实存在 `medium` / `xhigh` / `off` 等档位；
用户已批准 A① 的兼容修订，桥接侧（t5，仅 `src/bridge.js`）为 A③ 扩展了 `POST /api/dsh/model` 的
档位校验、默认值与清空语义。本节记录**双方对齐的字段协议**，TUI 的 `endpointPatch()` /
`expectedApplied()` / `hotApplyModel()` 就是按它实现的；`config.json` 结构不变（仍是既有字段）。

### 11.2 请求（TUI → `POST /api/dsh/model`，只发本次真正改到的字段）

| 字段 | 取值 | 语义 |
| --- | --- | --- |
| `provider` / `model` | 非空字符串 | 换模型；省略 = 保持 |
| `reasoningEffort`（全局） | 非空字符串 | 设值；桥接按**目标模型**真实目录声明校验（声明 efforts ⇒ 只收声明 id，大小写不敏感；无 reasoning 元数据 ⇒ 兼容旧 low/high/max；`efforts:[]` ⇒ 拒绝）；目录不可用/空 ⇒ 503 零写盘 |
| 同上 | **`null`** | **显式清空**：磁盘写 `dsh.reasoningEffort = ""`（显式未设置），内存 `""`，`applied` 回 `null`，下一条 `selectModel` 省略该档位；重启时不回退 max。**省略**才是「保持现值」 |
| `modelOverrides[key].provider/model` | 非空字符串 | 该会话换模型 |
| `modelOverrides[key].reasoningEffort` | 非空字符串 | 设值；目标模型 = patch 的 provider/model → 磁盘现有 override → 全局（同上校验） |
| 同上 | **`null`** | **显式删除**该 key 的 `reasoningEffort`（留空/跟随全局）；磁盘/内存/`applied.modelOverrides` 里该字段都不存在（不会留 `"reasoningEffort": null`） |
| `removeOverrides` | key 数组 | 「跟随全局」= 删整条（`provider/model/reasoningEffort` 一起没） |

TUI 的规则：**换模型时一定显式发 `defaultEffort` 或 `null`**（无 default/无档位/兜底未验证都发 `null`），
所以旧模型的档位不会被端点「省略 = 保持」的旧语义悄悄带过去；只改强度不换模型时只发改动的字段。

### 11.3 回读（`applied`）与判定

- `applied.provider` / `applied.model` 必须等于刚写盘的值；
- 本次发过 `reasoningEffort` 时，`applied.reasoningEffort` 必须一致（未设置回 `null`，`''` 也按清空处理）；
- 端点返回 `applied.modelOverrides` 时，与内存快照逐字段同形比对（键排序；`null` 与字段缺失视为同义，
  但桥接实现本身不会留 null）；
- 对得上才打印「已热生效」；端点说 `ok` 不算数。`wrote` / `changes` / `epoch` 原样写进摘要。

### 11.4 边界（明确不做的）

- **不过滤、不改名、不映射**：目录声明什么档位就显示什么、写什么、发什么；不会把 `medium` 改成 `high`
  或 `max`，也不会因为旧桥接不认就预过滤。
- **`POST /api/dsh/effort` 不在本工具的使用范围**：那是控制台旧路由，仍只收 low/high/max；本工具一律走
  `/api/dsh/model`。
- **旧桥接（无 t5）**：`medium/xhigh/off` 与清空会被 400 拒绝。TUI 已先写盘，摘要会如实说「未能热生效」
  并解释是桥接版本差异；重启到含 t1+t5 的桥接后按磁盘加载。**不要**手改档位名绕过。
- **目录不可用**：读目录是「选模型/设档位」的前置；清空（`null`）不需要目录。目录不可用时 TUI 会退回
  DeepSeek 兜底菜单，并按桥接的 fail-closed 语义如实报告热更新成败。
- **生产状态（2026-10-17）**：真实 DSH 是 `http://127.0.0.1:19387`。真实目录已用桥接自己的
  `NodeApiClient` **只读**取回（`session/modelCatalog`：4 provider / 15 model，`local-codex-app-server`
  的 7 个 GPT 模型原样）。生产桥接（3100）仍跑旧代码、**未重启** ⇒ 3100 上 `GET /api/dsh/models`
  返回 404、TUI 目录行显示降级；**生产 3100 上的新路由属于未验证**。TUI→补丁→真实 `src/bridge.js`
  的联合验证见 §7.6.5（真实桥接代码 + 真实目录数据，30/30 断言）；`local-codex-app-server`
  换模型/恢复限制见 §9。
