# 贴吧写入口取证 + 防回归边界（task-104）

> 目的：只读门禁（`readOnly`）只针对**小黑盒写工具**；贴吧侧之所以不需要门禁，前提是**贴吧根本没有写入口**。
> 这个前提此前没有可信证据——`scripts/test-read-only-gate.mjs:56-65` 那条断言只检查
> 「`XHH_AUTHORIZE_WRITE_TOOLS` 名单里没有 `/tieba/i`」，它对贴吧实际实现一无所知：
> 往贴吧加一个写工具/写路由/写函数，那条断言依然全绿。
>
> 本文件记录离线取证结论，并由 `scripts/test-tieba-write-boundary.mjs` 固化为长期在线的防回归测试
> （已注册进 full + quick 两个清单）。

取证方式：**只读源码 + 只 import 纯模块 + stdio 拉起本仓库 MCP server**。
未启动/重启任何服务，未访问真实平台或 QQ，未发消息，未改 `config.json`/profile/state，未 git，未安装。

## 一、贴吧 MCP 工具：只有 2 个，且都是只读

| 证据 | 位置 |
| --- | --- |
| 工具开关表（注册期过滤用） | `src/mcp-snowluma-safe.js:229` `qq_tieba_list: 'tiebaList',`、`src/mcp-snowluma-safe.js:230` `qq_tieba_read: 'tiebaRead',`（表体 `src/mcp-snowluma-safe.js:191-231`） |
| 注册期过滤包装 | `src/mcp-snowluma-safe.js:233-243`：`server.tool = (name, ...rest) => { const flag = TOOL_CONFIG_FLAGS[name]; if (flag && cfg.socialV2?.tools?.[flag] === false) return undefined; return registerTool(name, ...rest); }` |
| 贴吧列吧工具 | `src/mcp-snowluma-safe.js:1374` 门控 `if (cfg.socialV2?.tools?.tiebaList !== false) {` → `src/mcp-snowluma-safe.js:1375-1406` `server.tool('qq_tieba_list', …)`，handler 在 `src/mcp-snowluma-safe.js:1392` 调 `agentApi(\`/api/socialV2/tieba/bar?…\`)` |
| 贴吧读帖工具 | `src/mcp-snowluma-safe.js:1409` 门控 `if (cfg.socialV2?.tools?.tiebaRead !== false) {` → `src/mcp-snowluma-safe.js:1410-1469` `server.tool('qq_tieba_read', …)`，handler 在 `src/mcp-snowluma-safe.js:1436` 调 `agentApi(\`/api/socialV2/tieba/thread?…\`)` |
| 无第三个贴吧工具 | 全文 `server\.tool\(\s*'([A-Za-z0-9_]+)'` 静态枚举 = 41 个注册名，含 `tieba` 的只有上面两个；无重复 |
| 动态权威清单 | 以 stdio 拉起真实 `src/mcp-snowluma-safe.js` + `client.listTools()` = 40 个工具，贴吧仍只有 `qq_tieba_list`、`qq_tieba_read`（41 − 40 = `config.json` 里 `socialV2.tools.setStickerRemark: false`） |
| 为什么贴吧 handler 不可能写 | `src/mcp-snowluma-safe.js:126-157` 的 `agentApi(path, init = {})`：不传 `method` 时走 `fetch` 默认 **GET**；仓库里的写工具都是显式传 `method:'POST'`。两个贴吧 handler 都没有传 `method`/`body` |

## 二、桥接端点：只有 2 条贴吧路由，且都是 GET

| 证据 | 位置 |
| --- | --- |
| 列吧端点 | `src/bridge.js:7141` `if (req.method === 'GET' && url.pathname === '/api/socialV2/tieba/bar') {`；工具开关 `src/bridge.js:7155` `if (!v2ToolEnabled('tiebaList'))`；实际抓取 `src/bridge.js:7180` `const r = await fetchBarPage(barName, barPage, { cookieFile: cfg.socialV2?.tieba?.cookieFile });` |
| 读帖端点 | `src/bridge.js:7210` `if (req.method === 'GET' && url.pathname === '/api/socialV2/tieba/thread') {`；工具开关 `src/bridge.js:7218` `if (!v2ToolEnabled('tiebaRead'))`；路由体走 `fetchThreadPages`/`fetchThreadPage` |
| 贴吧路由总数 | 全文 `req.method === 'X' && url.pathname === 'Y'` 路由守卫共 103 个，其中路径含 `/tieba/` 的**只有 2 个，方法都是 GET** |
| 无「非标准写法」新入口 | `/api/socialV2/tieba/` 字面量只出现在 `src/bridge.js:7141`（GET 守卫）、`src/bridge.js:7210`（GET 守卫）与注释 `src/bridge.js:7179`、`src/bridge.js:7216`、`src/bridge.js:7281`；没有任何 `startsWith('/api/socialV2/tieba/')` 之类的前缀分派 |
| 抓取层 GET-only | `src/safe-fetch.js` 的 `safeFetch`（`src/safe-fetch.js:295`）与 `safeFetchBuffer`（`src/safe-fetch.js:344`）唯一 method 字面量是 `src/safe-fetch.js:219` `method: 'GET'` |

## 三、`src/tieba-lib.js` 导出：没有写函数

| 证据 | 结论 |
| --- | --- |
| import 清单 | 只 import `node:fs` 与 `./safe-fetch.js`，没有 HTTP 客户端注入点 |
| 导出枚举 | 65 个导出、其中 36 个函数；写动作词（post/publish/reply/comment/like/favorite/delete/remove/submit…）**零命中** |
| `method:` 字面量 | 源码出现 **0 次** |
| 裸 `fetch(` | **0 次**——所有网络请求都经 `safeFetch`/`safeFetchBuffer`（见上文 GET-only） |

> 说明：`src/tieba-lib.js` 里确有 `createTiebaLimiter`、`createTiebaPatrolGate` 两个 `create*` 导出，
> 它们是**纯本地工厂**（限速/巡逻门），不碰网络、不是平台写入口，因此测试的强动作词表刻意不含
> `create/write/update/edit`（否则会误报）；真正的写入口会带强动作词（`createTiebaPost` ⇒ 命中 `post`），
> 或走 bridge 路由（由路由检查兜住）。

## 四、新增的防回归测试

`scripts/test-tieba-write-boundary.mjs`（457 行，5 个 test）：

| test | 行号 | 断言什么 |
| --- | --- | --- |
| 静态 MCP 注册 | `scripts/test-tieba-write-boundary.mjs:281` | 源码里贴吧工具集合**恰为** `{qq_tieba_list, qq_tieba_read}`（静态注册与运行期开关无关，恒为两项）；每个贴吧 handler 只调 `/api/socialV2/tieba/…` 且不含 HTTP 写方法；两个只读工具各自处在 `cfg.socialV2.tools.<flag> !== false` 门控内 |
| 动态 tools/list | `scripts/test-tieba-write-boundary.mjs:301` | **stdio 拉起真实 MCP server**、`tools/list` 后按 `config.json` 的真实开关算期望集合（`expectedTiebaTools(flags)`）：flag 关闭 ⇒ 该工具合法缺席，flag 开启 ⇒ 必须出现；集合里不得有额外贴吧工具；tools/list 里没有源码静态枚举漏掉的工具 |
| 桥接路由 | `scripts/test-tieba-write-boundary.mjs:336` | 贴吧路由**语义断言**：恰为两条、方法都是 GET、路径属于 `{/api/socialV2/tieba/bar, /api/socialV2/tieba/thread}`（**不锁源码行号**，行号漂移不再假红）；路由体不得含 HTTP 写方法、必须真的调用只读抓取函数；全文每处 `/api/socialV2/tieba/…` 字面量要么是 GET 守卫要么是注释 |
| tieba-lib 导出 | `scripts/test-tieba-write-boundary.mjs:355` | 实际 `import()` 枚举导出：无写函数、无 HTTP 写方法、无裸 `fetch`；`safeFetch` 只允许 GET；只读抓取函数 `fetchBarPage`/`fetchThreadPages`/`fetchThreadPage` 必须仍然导出（防止「整个抓取层消失」导致的假绿） |
| 反 vacuous 自检 | `scripts/test-tieba-write-boundary.mjs:376` | 把「加了写入口」的 fixture 喂进上面 4 个检查函数，**必须全部抛错**：贴吧写工具（`qq_tieba_post`/`_reply`/`_delete`/`_favorite`、以及「替换掉一个只读工具凑数」）、桥接写路由（POST/PUT 守卫、`startsWith` 前缀分派、「只读路径里塞 `method:'POST'`」）、tieba-lib 写函数（`createTiebaPost`/`replyTiebaThread`/`deleteTiebaPost`/`likeTiebaThread`）、handler 里换成非贴吧端点+写方法。另含 F3 三向自检：flag 合法关闭时工具缺席**不得抛错**（旧的无条件「恰两项」在这里会假红）、flag 关闭但工具仍注册必须抛错、flag 开启但工具缺席必须抛错 |

红演示逃生口：环境变量 `TIEBA_WRITE_BOUNDARY_SRC=<临时 src 副本>` 可让同一文件对副本取证（正常清单运行从不设置，证据恒取自真实 `src/`）。

清单注册：`scripts/test-suite-manifest.mjs:224` `TIEBA_WRITE_BOUNDARY_TESTS`，追加进
`scripts/test-suite-manifest.mjs:233`（FULL_TESTS）与 `scripts/test-suite-manifest.mjs:234`（QUICK_TESTS）；
`scripts/test-test-suite.mjs:14`（import）+ `scripts/test-test-suite.mjs:86-95`（唯一性/双清单注册自检）。
full 129 项、quick 86 项，新测试在两者中都恰好注册一次（full idx 127、quick idx 84，其后是 task-108 的 fail-closed 专项）。

## 五、命令与计数（2026-10-26 复跑）

```
node --test scripts/test-tieba-write-boundary.mjs   → tests 5 / pass 5 / fail 0（约 0.8s）
node scripts/test-test-suite.mjs                    → tests 7 / pass 7 / fail 0（约 1.4s）
node scripts/test-quick.mjs                         → Quick suite: 86/86 scripts passed
node scripts/test-audit.mjs                         → Audit suite: 129/129 scripts passed
```

task-107 变更后的专项（均离线、自带端口安全）：
`test-background-patrol-bridge-hook.mjs` 37/37、`test-xhh-guard-http-compatibility.mjs` 10/10、
`test-xiaoheihe-authorize-server.mjs` 18/18、`test-xiaoheihe-authorize-wiring.mjs` 10/10、
`test-reply-wait.mjs` 12/12、`test-role-store.mjs` 11/11、`test-group-wait.mjs` 24/24、
`test-read-only-gate.mjs` 8/8。

## 六、红绿证据（不修改生产文件）

做法：把 `src/` 整体复制到 `scripts/.tmp-red-demo/src/`（副本位于仓库内，`node_modules` 仍可解析），
在**副本**里同时注入三处写入口，再用同一个测试文件对副本取证；取证后删除副本、复跑真实 `src/`。

注入内容（全部只落在临时副本）：

1. `src/mcp-snowluma-safe.js`：在 `await server.connect(new StdioServerTransport());` 之前插入
   `server.tool('qq_tieba_reply', '回复贴吧帖子（红演示注入）', {}, async () => ({ content: [{ type: 'text', text: 'red-demo' }] }));`
2. `src/bridge.js`：在 `if (req.method === 'GET' && url.pathname === '/api/socialV2/tieba/bar') {` 之前插入
   `if (req.method === 'POST' && url.pathname === '/api/socialV2/tieba/reply') { sendJson({ ok: true }); return; }`
3. `src/tieba-lib.js`：追加 `export async function createTiebaPost() { return { ok: true }; }`

红（`TIEBA_WRITE_BOUNDARY_SRC=scripts/.tmp-red-demo/src node --test scripts/test-tieba-write-boundary.mjs`）：
**tests 5 / pass 0 / fail 5**，失败信息逐条对应注入点：

- 静态：`贴吧工具集合必须恰为 ["qq_tieba_list","qq_tieba_read"]（按 config 开关计算），实际 ["qq_tieba_list","qq_tieba_read","qq_tieba_reply"]`
- 动态：`tools/list：贴吧工具集合必须恰为 […两项…]（按 config 开关计算），实际 […"qq_tieba_reply"]`（真实 server 把注入工具注册出来了）
- 桥接：`桥接贴吧端点必须恰为两条 GET 只读路由`
- tieba-lib：`tieba-lib 导出里不得有写函数：createTiebaPost`
- 自检：基线 `doesNotThrow` 因副本已被污染而抛错（红演示模式的预期现象）

绿（删除 `scripts/.tmp-red-demo/` 后 `node --test scripts/test-tieba-write-boundary.mjs`）：
**tests 5 / pass 5 / fail 0**；`node scripts/test-quick.mjs` = 86/86 scripts passed。

### 六之一、task-107 修复自证（F2 行号锁 / F3 flag 假红 / F1 blocked-port 偶发）

全部只在临时副本/fixture 上做，真实 `src/`、`config.json` 未改动。

1. **F2 行号锁**：把 `src/` 复制到 `scripts/.tmp-f2/src/`，在副本 `bridge.js` 顶部插 7 行注释 →
   贴吧守卫行号漂移到 **7148/7217**（语义不变）。用「修复前断言」（锁 `[7141,7210]`）的副本跑：
   `tests 5 / pass 4 / fail 1`，失败信息 `AssertionError: 贴吧路由行号漂移：请复核取证结论`、
   `actual [7148,7217] / expected [7141,7210]`。同一个 fixture 跑修复后文件：**5/5 绿**（语义断言）。
   真实 `src/` 上同样 5/5 绿。
2. **F3 flag 假红**：断言级 fixture 复原旧实现（无条件要求贴吧工具恰两项）。喂「flag 合法关闭、
   对应工具缺席」的工具清单 → 旧断言抛 `贴吧工具集合必须恰为只读两项`（假红重现）；修复后
   `assertTiebaToolBoundary({names, flags:{tiebaList:false}})` 不抛错；反向仍红：flag 关闭但工具仍注册、
   flag 开启但工具缺席都会抛错（`/贴吧工具集合必须恰为/`）。静态（不传 flags）仍恰两项。
3. **F1 blocked-port 偶发假红**：`scripts/test-port-safe.mjs` 固化 undici blocked-port 集合与三条路线
   （`listenFetchable`/`startOnFetchablePort` 显式端口分配 + EADDRINUSE 重试；`httpRequest`/`postJson`
   原生 http 请求）。红演示：在 6000 上 `fetch` 必抛 `TypeError: fetch failed`（cause `bad port`），
   而 `httpRequest` 同端口 200；把 `test-background-patrol-bridge-hook.mjs` 的旧 post 复原成 `fetch`
   并强制 port 6000 → `tests 37 / pass 27 / fail 10`（全为 fetch failed/bad port），
   修复后（原生 http）**37/37 绿**；`test-xhh-guard-http-compatibility.mjs` 强制 6000 →
   `tests 10 / pass 5 / fail 5`，修复后（显式可 fetch 端口）**10/10 绿**。

## 七、剩余风险（如实记录）

1. **取证是「当前实现」的快照**：测试锁死工具集合（按 config 开关计算）、路由方法+路径、以及
   tieba-lib 的导出/写法。任何贴吧相关改动都会变红——这是防回归的代价，是**故意**的。
   task-107 起**不再锁桥接路由行号**：行号只是实现细节（插注释/重排都会漂移），断言改为
   「恰两条、方法 GET、路径属于只读白名单、路由体只读」，改行号不再需要同步测试。
2. **动态 flag 期望随 `config.json` 变化**：动态 test 读真实 `socialV2.tools` 开关，flag 合法关闭时
   该工具缺席是绿、开启时缺席才红；静态 test 仍要求源码注册恰为两项（注册代码与开关无关）。
   这样既不假红（F3），也不会漏掉「flag 开启但工具被静默过滤」的真缺陷。
3. **写入口可以绕开「名字」检查**：如果一个新函数名叫 `submitXxx` 之外的隐晦形式（例如 `pushTiebaData`），
   强动作词表会漏。兜底靠：桥接路由检查（任何平台写都必须经过 bridge 端点）+ tieba-lib 的
   「无裸 fetch / 无 HTTP 写方法 / safeFetch GET-only」三条。
4. **未覆盖运行期行为**：`safeFetch` 只发了 GET 是静态读源码得出的，没有做运行期抓包/loopback mock 验证；
   若有人改 `safeFetch` 让它按参数升级为 POST，会同时打红本文件第 4 个 test（`safe-fetch 只允许 GET`），
   但仍建议后续补一条运行期 loopback 断言。
5. **`config.json` 现值为 `backgroundPatrol.paused: true`、只读门禁未启用**：真实运行下贴吧工具仍可被 agent
   调用（只是只读）。本任务没有、也不应该改动这些运行配置。
6. **只读门禁本身不覆盖贴吧**：本任务的结论是「不需要」而不是「已生效」。若未来贴吧新增写能力，
   既需要本文件变红提醒，也需要同步把贴吧写工具并入只读门禁名单——两件事都要做。

## 八、改动清单（本任务只碰测试/文档）

task-104（贴吧写入口取证）：
- 新增 `scripts/test-tieba-write-boundary.mjs`
- 修改 `scripts/test-suite-manifest.mjs`（新增分组 `TIEBA_WRITE_BOUNDARY_TESTS`；full/quick 追加）
- 修改 `scripts/test-test-suite.mjs`（import + 清单自检）
- 新增 `docs/tieba-write-boundary-evidence.md`（本文件）

task-107（只读门禁专项测试缺陷修复：行号锁 / flag 假红 / blocked-port 偶发）：
- 新增 `scripts/test-port-safe.mjs`（辅助模块，不进 full/quick 清单）：fetch blocked-port 集合、
  `isFetchBlockedPort`、`listenFetchable`/`startOnFetchablePort`/`reserveFetchablePort`、
  `httpRequest`/`postJson`、`closeServer`。
- `scripts/test-tieba-write-boundary.mjs`：新增 `TIEBA_TOOL_FLAGS`+`expectedTiebaTools(flags)`；
  `assertTiebaToolBoundary` 支持 `flags`；动态 test 按真实开关算期望；桥接 test 去行号锁改语义断言；
  反 vacuous 增加 F3 三向自检。
- 端口安全接入：`test-background-patrol-bridge-hook.mjs`、`test-xhh-guard-http-compatibility.mjs`、
  `test-read-only-gate.mjs`、`test-xiaoheihe-authorize-server.mjs`、`test-xiaoheihe-authorize-wiring.mjs`、
  `test-reply-wait.mjs`、`test-role-store.mjs`、`test-group-wait.mjs`（统一端口表/重试助手）。
- `scripts/test-test-suite.mjs`：新增「端口安全：blocked 判定/安全监听/原生 http 请求契约」自检（7/7）。
- 本文件同步：语义断言措辞、F2/F3/F1 红→绿证据、计数（tieba 5/5、test-test-suite 7/7、
  quick 86/86、audit 129/129）。
- **未改动**任何 `src/`、`config.json`、profile、state；未 git 提交
