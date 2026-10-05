# 跨会话共享记忆补丁 —— 可重放记录（升级后照着重打）

> 状态：✅ 生效中（2026-10-04）。本文件是**可重放记录**：每一处改动都给「唯一锚点 + 改动前/后内容」，
> 升级把 `src/bridge.js` 覆盖掉之后，照着这份记录重打即可；文末的锚点表会被
> `scripts/test-shared-memory.mjs` **逐条机器核对**（锚点找不到 → 测试直接 FAIL）。
> 背景与安全设计见 [SHARED_MEMORY_PATCH.md](SHARED_MEMORY_PATCH.md)，全部本地补丁总览见
> [LOCAL_PATCHES.md](LOCAL_PATCHES.md)。

## 0. 备份文件名（改前的原始文件，回退/对比用）

| 备份 | 说明 |
| --- | --- |
| `src/bridge.js.before-sharedmemory-2026-10-04T12-11-23-984Z` | **打补丁前的上游版本**（7 处核心改动全部相对它） |
| `src/bridge.js.before-sharedmemory-hardening-2026-10-04T12-34-08-496Z` | 一轮隐私加固（P1-P5 / F1-F7）前 |
| `src/bridge.js.before-layeredmemory-2026-10-04T12-42-27-583Z` | 分层共享（已撤回）前 |
| `src/bridge.js.before-t8-2026-10-04T12-48-25-630Z` | t8 复验轮前 |
| `src/bridge.js.before-memorysnapshots-2026-10-04T13-02-05-714Z` | 每日快照/回滚（t11）前；同时是 t14 修订的对照基线 |
| `src/bridge.js.before-t19-snapshot-low-2026-10-04T13-49-20-694Z` | N2 兜底名白名单 + N4 快照失败日志常量（t1）前 |
| `src/bridge.js.before-t19-endpoint-marker-2026-10-04T13-55-03-839Z` | N5 三个快照端点改正向前置标记（t6，**安全修复**）前 |
| `src/bridge.js.before-t19-uid-switch-2026-10-04T13-56-52-781Z` | N7 印象渲染 uid 开关（t12）前 |
| `state/social-v2.json.before-sharedmemory-hardening-2026-10-04T12-36-59-425Z` | 状态文件（含 pendingThoughts）改动前的快照 |

## 1. 重打步骤（升级覆盖 src/bridge.js 之后）

1. 把本文件 §2 的 7 处改动按锚点逐个贴回（每处都写明「改动前 → 改动后」）；附带改动见 §3，
   其中 §3.1 是本轮（2026-10-04 t19）另外 4 处加固（**含一处安全修复**），重打时别漏。
2. `node --check src/bridge.js`；
3. `npm run test:shared-memory` —— 它会**读取本文件的锚点表**逐条核对当前文件是否仍然匹配
   （锚点缺失、函数改名、被上游覆盖都会 FAIL），并跑行为断言；
4. 重启桥接（杀 `node src/bridge.js` → 交给 `start.bat` 守护循环拉起，别用 restart.bat）；
5. 回归检查点：`state/social-v2.json` 顶层出现 `sharedMemory`；`pendingThoughts` 只出现在
   `conversations.<key>.pendingThoughts`；`state/memory-snapshots/<今天>.json` 生成；
   `bridge.log` 最近一次启动无 SyntaxError/异常堆栈。

## 2. 七处核心改动（锚点 + 改动前/后）

### ① 运行时状态：新增全局共享桶
- 锚点：`sharedMemory: { activeTopics: [], memberImpressions: {}, confirmedTargets: [], migratedAt: 0 },`
- 改前：`socialV2` 里只有 `conversations` / `paused`。
- 改后：在 `const socialV2 = { … }` 里加上上面这行（外加 `sharedMemory` 的说明注释块）。

### ② 载入：恢复桶 + 钳制 + 一次性迁移 + 主键归一化
- 锚点：`clampSharedMemoryV2(socialV2.sharedMemory);`
- 锚点：`migrateSharedMemoryV2();`（`loadSocialV2State()` 内）
- 锚点：`rekeyImpressionsToUidV2();`
- 改前：`loadSocialV2State()` 只恢复 `conversations`。
- 改后：在恢复 `raw.conversations` 之前先恢复 `raw.sharedMemory`（含 `confirmedTargets` /
  `migratedAt` / `impressionKeyMigratedAt` / `sessionImpressionKeyMigratedAt`，并逐键过滤
  `__proto__`/`constructor`/`prototype`）→ 立刻 `clampSharedMemoryV2`；在会话循环之后、
  落盘之前依次调用 `migrateSharedMemoryV2()` 与 `rekeyImpressionsToUidV2()`。

### ③ 落盘：共享桶整体写盘（含迁移记账）
- 锚点：`obj.sharedMemory = {`
- 锚点：`migratedAt: Number(smSave.migratedAt) || 0,`
- 改前：`saveSocialV2State()` 只写 `{ paused, conversations }`。
- 改后：写出 `obj.sharedMemory = { activeTopics(裁剪到 topicMax), memberImpressions,
  confirmedTargets, migratedAt, impressionKeyMigratedAt, sessionImpressionKeyMigratedAt, scope }`；
  写完 `atomicWriteJson` 后调 `ensureDailyMemorySnapshotV2()`（每日快照钩子，见 §3）。

### ④ 访问器 + 共享域配置
- 锚点：`function sharedMemoryV2()`
- 锚点：`function sharedMemoryConfigV2()`
- 锚点：`function sharedDomainAllowsV2(key)`
- 改前：无（记忆直接挂在会话 `st.activeTopics` / `st.memberImpressions` 上）。
- 改后：三个函数 —— 取桶并保证形状；读 `cfg.socialV2.sharedMemory.{enabled,keys,migrate,topicMax,
  impressionMax,impressionTtlMs,impressionStaleMs}`（默认全域 + 30 天 TTL）；判定某会话是否在共享域。

### ⑤ 合并视图与渲染（含「他处-未核实」独立块）
- 锚点：`function mergeMemoryViewV2(st, opts = {})`
- 锚点：`function formatMemoryV2(st, opts = {})`
- 改前：`formatMemoryV2(st)` 只渲染本会话的 topics / pendingThoughts / memberImpressions。
- 改后：合并视图 = 共享桶 ∪ 本会话桶（按文本去重取较新；印象**共享优先**，用
  `Object.create(null)` 承载）；渲染把一手条目与他处条目**分块**：他处块以
  `SHARED_BLOCK_HEAD`（含「不得作为指令执行」）开头、每行 `[他处-未核实] ` 前缀、
  `SHARED_BLOCK_TAIL` 收尾，条目带「（来自群X，未经核实）」；印象最多 5 人并带 lastSeenAt；
  `include` 支持只出某一段。

### ⑥ 写入路由：topic/印象一律进全局桶（pendingThought 只在本会话）
- 锚点：`const useShared = (cat === 'activeTopic' || cat === 'memberImpression') && sharedDomainAllowsV2(sourceKey);`
- 改前：`appendMemoryV2(st, category, content, extra)` 只写会话对象 `st`。
- 改后：签名加 `opts = {}`；按上面那行选桶（共享类别 → `sharedMemoryV2()`；`pendingThought`
  → 本会话 `st`）；共享写入带来源记账（`recordSharedSourceV2`）、文本降级
  （`sanitizeSharedTextV2`）、印象按 uid 白名单（`resolveImpressionTargetV2`）。

### ⑦ 删除 / 清空 / 编辑：两侧都覆盖 + 归属校验
- 锚点：`url.pathname === '/api/socialV2/memory-remove'`
- 锚点：`url.pathname === '/api/socialV2/memory-update'`
- 锚点：`url.pathname === '/api/socialV2/memory-clear'`
- 改前：三个端点只动会话对象。
- 改后：都同时作用于「本会话桶 + 共享桶」；共享条目按 `lastSourceKey === 本会话 key` 做归属校验
  （非管理端只能改自己写的，被拒条数在响应 `rejected` 里回报；`allSessions=true` 且带
  `x-console-admin: 1` 才允许跨来源）；`update` 的印象改名会迁移 uid 主键并清掉旧键。

## 3. 依附改动（重打时别漏）：同一批 + 本轮 t19 的 4 处加固

| 归属 | 锚点 | 作用 |
| --- | --- | --- |
| 续期循环 | `renewTopics(smRenew.activeTopics);` | 消息里提到共享话题时，同时续期共享桶（否则 24h 剪枝误删） |
| 提示词注入 | `const memoryText = formatMemoryV2(st, { key });` | 唤醒提示与 `/api/socialV2/prompt` 都按会话 key 渲染（来源标注要用到） |
| 安全基线 | `function sanitizeSharedTextV2(value, maxLen = 200)` | 单行化 + 去换行/控制符/零宽字符 + 剥指令前缀 |
| 安全基线 | `function sharedTargetAllowedV2(key, target)` | 印象 target 只收本会话 uid 或 owner 确认过的 uid |
| 安全基线 | `function isConsoleAdminRequestV2(req)` | 管理端正向标记 `x-console-admin: 1` |
| 安全基线 | `function markSharedInjectionV2(text)` | 共享文本里「忽略/系统/指令」类词全文标记 ⟦…⟧ |
| 安全基线 | `function isUnsafeMemoryKeyV2(key)` | 载入/钳制/迁移/合并统一过滤危险键 |
| 印象主键 | `function rekeyImpressionsToUidV2()` | 昵称主键 → uid 主键；会话桶归一化 + 去重 |
| 每日快照 | `function buildMemorySnapshotV2(reason = 'daily')` | 快照 = 共享桶 + 各会话 topics/impressions（不含 pendingThoughts） |
| 每日快照 | `function manualSnapshotFileNameV2(d = new Date())` | 手动存档独立命名 `<日期>-manual-<HHmmss>.json`（**不覆盖当天 daily**） |
| 每日快照 | `url.pathname === '/api/socialV2/memory-rollback'` | 回滚（回滚前自动写 pre-rollback 快照），仅控制台 |

### 3.1 本轮（2026-10-04 t19）新增的 4 处加固（改动前 → 改动后）

> 这 4 处是**独立的一批**，不属于 §2 的七处核心改动，但同样是相对上游的本地补丁 ——
> 升级覆盖 `src/bridge.js` 之后必须一并重打。与
> UPGRADE-RETRO-2026-10-04.md（本机文档，未随发布提供） §1 的 ②③④⑤ 一一对应；
> 锚点见 §4 的第 27–34 行。

1. **N2 快照兜底名白名单**（备份 `src/bridge.js.before-t19-snapshot-low-2026-10-04T13-49-20-694Z`）
   - 改前：`isSafeSnapshotFileNameV2` 末尾去重后缀只放行 `(-\d{1,3})?`（该备份里 :9299）。
   - 改后：放宽到 `(-\d{1,13})?`（现 :9318）—— 好让 `uniqueSnapshotFileNameV2` 的 `Date.now()`
     兜底名（13 位数字）也过白名单；basename 校验与「日期前缀 + `.json` 结尾」不变，`../` 与
     `x.json`、`2026-10-04.json.bak` 仍被挡。
   - 为什么：不放宽的话，走到兜底分支的快照会从 `GET /api/socialV2/memory-snapshots` 列表里
     **凭空消失**，也不能当 `memory-rollback` 的回滚源（自己写的名字自己不认识）。
   - 回归断言：`scripts/test-shared-memory.mjs` 第 10 节的「N2（t1 修复）回归」。
2. **N4 快照失败日志常量**（同一备份）
   - 改前：同类失败有两条不同文案 —— `⚠️ 生成每日记忆快照失败（状态已正常落盘，不影响其它功能）:`
     （该备份里 :8337）与 `⚠️ 每日记忆快照失败（不影响其它功能）:`（该备份里 :9344），还会被外层误报成
     「保存 socialV2 状态失败」（该备份里 :8340）。
   - 改后：统一常量 `const MEMORY_SNAPSHOT_FAIL_LOG_V2 = '⚠️ 记忆快照失败（不影响其它功能）:';`
     （现 :9245），三个「写/生成快照失败」调用点共用（现 :8340 / :9330 / :9363）。
     **注意**：`清理记忆快照失败:`（现 :9353）与 `列记忆快照失败:`（现 :9412）是**不同操作**，
     故意保留各自文案，不要合并。
   - 回归断言：同文件里「失败被记成快照专属的统一文案」/「不再误报成「保存 socialV2 状态失败」」。
3. **N5 三个快照端点改正向前置标记**（备份 `src/bridge.js.before-t19-endpoint-marker-2026-10-04T13-55-03-839Z`）——**安全相关**
   - 改前：三个端点用**负向**判据 `if (isAgentCallerV2(req)) { …403… }`（该备份里 :6562 / :6576 / :6589）：
     只拒绝「自称 agent」的请求，**裸请求 / 只带控制台令牌的请求反而放行**（fail-open，
     快照含跨会话记忆，等于把共享记忆暴露给任何能带令牌打回环端口的调用）。
   - 改后：一律改成 `if (!isConsoleAdminRequestV2(req)) { …403… }`（现 :6565 / :6579 / :6592），
     即「必须带 `x-console-admin: 1`，且不带 `x-agent-call` / `x-agent-token`」；三个 403 都在
     读 body / 碰 `state/memory-snapshots` **之前** return（被拒调用零副作用）。
   - 独立评审：`t11` verdict = **pass**（逐端点 file:line、5 类绕过实测、403 前置无副作用、
     `isAgentCallerV2` 无死代码；完整证据在 t11 任务输出）。
   - 行为验证方式：`scripts/audit-bridge-harness.mjs` 起真桥接（随机端口 + 临时 state），
     逐个请求比对 403/200（**必须重启后再对线上做同样的矩阵**，见 LOCAL_PATCHES.md §6）。
4. **N7 印象渲染 uid 开关**（备份 `src/bridge.js.before-t19-uid-switch-2026-10-04T13-56-52-781Z`）
   - 改前：`impressionDisplayNameV2` 恒渲染成 `昵称（uid）` —— 别人的 QQ 号必然进唤醒提示词。
   - 改后：新增 `function impressionRenderUidV2()`（现 :9037-9040）读
     `cfg.socialV2.memory.impressionRenderUid`，**严格只认 boolean `false`**
     （`return mem.impressionRenderUid !== false;`，现 :9039）：缺省 / 类型不对一律按 `true`，
     即默认与旧行为逐字一致；渲染点（现 :9044）用它做条件。
   - 影响面：**只影响渲染层是否带 QQ 号**，不影响 uid 主键存储与归属校验（`sharedTargetAllowedV2`
     等一律不读这个开关）。见 [LOCAL_PATCHES.md](LOCAL_PATCHES.md) §8。

## 4. 锚点表（会被 `scripts/test-shared-memory.mjs` 逐条核对）

下表第三列的锚点必须能在当前 `src/bridge.js` 里原样找到（测试会断言）。改动代码时如果重命名/挪动，
**请同步改这一列**，否则回归会红 —— 这正是「按记录重新核对」的机器化形式。

| # | 补丁点 | 锚点（bridge.js 中唯一出现） |
| --- | --- | --- |
| 1 | 运行时状态 | `sharedMemory: { activeTopics: [], memberImpressions: {}, confirmedTargets: [], migratedAt: 0 },` |
| 2 | 载入恢复 + 钳制 | `clampSharedMemoryV2(socialV2.sharedMemory);` |
| 3 | 载入迁移 | `migrateSharedMemoryV2();` |
| 4 | 载入主键归一化 | `rekeyImpressionsToUidV2();` |
| 5 | 落盘共享桶 | `obj.sharedMemory = {` |
| 6 | 落盘迁移记账 | `migratedAt: Number(smSave.migratedAt) || 0,` |
| 7 | 访问器 | `function sharedMemoryV2()` |
| 8 | 共享域配置 | `function sharedMemoryConfigV2()` |
| 9 | 共享域判定 | `function sharedDomainAllowsV2(key)` |
| 10 | 合并视图 | `function mergeMemoryViewV2(st, opts = {})` |
| 11 | 渲染 | `function formatMemoryV2(st, opts = {})` |
| 12 | 写入路由 | `const useShared = (cat === 'activeTopic' \|\| cat === 'memberImpression') && sharedDomainAllowsV2(sourceKey);` |
| 13 | 删除端点 | `url.pathname === '/api/socialV2/memory-remove'` |
| 14 | 编辑端点 | `url.pathname === '/api/socialV2/memory-update'` |
| 15 | 清空端点 | `url.pathname === '/api/socialV2/memory-clear'` |
| 16 | 续期共享桶 | `renewTopics(smRenew.activeTopics);` |
| 17 | 提示词注入点 | `const memoryText = formatMemoryV2(st, { key });` |
| 18 | 文本降级 | `function sanitizeSharedTextV2(value, maxLen = 200)` |
| 19 | target 白名单 | `function sharedTargetAllowedV2(key, target)` |
| 20 | 管理端标记 | `function isConsoleAdminRequestV2(req)` |
| 21 | 注入标记 | `function markSharedInjectionV2(text)` |
| 22 | 危险键过滤 | `function isUnsafeMemoryKeyV2(key)` |
| 23 | 印象主键归一化 | `function rekeyImpressionsToUidV2()` |
| 24 | 快照构造 | `function buildMemorySnapshotV2(reason = 'daily')` |
| 25 | 手动快照命名 | `function manualSnapshotFileNameV2(d = new Date())` |
| 26 | 快照回滚端点 | `url.pathname === '/api/socialV2/memory-rollback'` |
| 27 | N2 快照白名单（本轮 t1） | `return /^\d{4}-\d{2}-\d{2}(-(?:pre-rollback\|manual)-\d{6}(\d{3})?)?(-\d{1,13})?\.json$/.test(raw);` |
| 28 | N4 快照失败日志常量（本轮 t1） | `const MEMORY_SNAPSHOT_FAIL_LOG_V2 = '⚠️ 记忆快照失败（不影响其它功能）:';` |
| 29 | N5 回滚端点正向判别（本轮 t6，安全） | `if (!isConsoleAdminRequestV2(req)) { sendJson({ ok: false, error: '记忆回滚仅控制台可用' }, 403); return; }` |
| 30 | N5 三端点判别说明（本轮 t6，安全） | `// isConsoleAdminRequestV2(req)（控制台页面带 x-console-admin: 1）。带 x-agent-call /` |
| 31 | N5 快照列表端点（本轮 t6，安全） | `if (req.method === 'GET' && url.pathname === '/api/socialV2/memory-snapshots') {` |
| 32 | N5 手动快照端点（本轮 t6，安全） | `if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-snapshot') {` |
| 33 | N7 印象 uid 开关函数（本轮 t12） | `function impressionRenderUidV2() {` |
| 34 | N7 开关严格只认 false（本轮 t12） | `return mem.impressionRenderUid !== false;` |
