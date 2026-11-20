// scripts/test-tieba-write-boundary.mjs
// 贴吧写入口取证 + 防回归边界测试（离线、不启动桥接、不访问平台/QQ）。
//
// 背景：只读门禁只拦「小黑盒写工具」，贴吧侧之所以不需要代码门禁，是因为**贴吧根本没有写入口**。
// 但现有 test-read-only-gate.mjs 里那条断言只检查「小黑盒写工具名单里不含 tieba 名字」——
// 它对贴吧侧的实际情况一无所知：往贴吧加一个写工具/写端点，那条断言照样绿。
//
// 这个文件用**真实实现**取证，不只查名单：
//   1. 静态枚举 src/mcp-snowluma-safe.js 里的 `server.tool('…')` 注册，断言贴吧工具集合恰为
//      {qq_tieba_list, qq_tieba_read}，且每个贴吧工具的 handler 只 GET 贴吧只读端点；
//   2. 动态枚举（唯一权威）：以 stdio 拉起真实 MCP server，`tools/list` 后**按 config 开关**
//      计算期望集合（flag 关闭 ⇒ 该工具合法缺席；flag 开启 ⇒ 必须出现），并断言没有额外贴吧工具；
//   3. 解析 src/bridge.js 的 `req.method === '…' && url.pathname === '…'` 路由守卫，
//      断言贴吧端点只有 GET 的 /api/socialV2/tieba/bar 与 /api/socialV2/tieba/thread，
//      路由体里没有任何 HTTP 写方法；并扫描全文里每一处 `/api/socialV2/tieba/…` 字面量，
//      确认它要么是 GET 守卫、要么只是注释（否则如 startsWith 之类的新写法会直接变红）；
//   4. 实际 import src/tieba-lib.js 枚举导出，断言没有写函数、没有 HTTP 写方法、没有绕开
//      safeFetch（GET-only）的裸 fetch；
//   5. 反 vacuous 自检：把上面 4 项检查函数喂给「加了写入口」的 fixture，必须全部抛错。
//
// 红演示（仅取证用，不在清单里）：
//   · F2（路由行号锁）：设 TIEBA_WRITE_BOUNDARY_SRC 指向一份 src/ 的临时副本，在副本 bridge.js
//     顶部插入注释使贴吧守卫行号漂移——旧断言（锁 [7141,7210]）会红，语义断言保持绿；
//   · F3（动态 flag）：给 assertTiebaToolBoundary 喂「flag 合法关闭、少一项」的工具清单——
//     旧断言（无条件恰两项）会红，按 flags 计算期望的断言保持绿；
//   · 另可在副本里加入写工具/写路由/写导出，用同一个文件跑 `node --test` 验证必须变红。
//   正常清单运行从不设置该变量 → 证据始终取自真实 src/。
//
// 零副作用：只读文件、只 import 纯模块、只 spawn 本仓库的 MCP server（stdio），
// 不写 config/profile/state，不发消息、不联网、不启动桥接。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// 红演示专用逃生口：只在显式设置时生效（正常清单运行恒为真实 src/）。
const REAL_SRC = path.join(ROOT, 'src');
const SRC_DIR = process.env.TIEBA_WRITE_BOUNDARY_SRC
  ? path.resolve(process.env.TIEBA_WRITE_BOUNDARY_SRC)
  : REAL_SRC;
const USING_OVERRIDE = SRC_DIR !== REAL_SRC;
if (USING_OVERRIDE) {
  // 不静默：取证/红演示一眼能看到证据不是来自真实 src/。
  console.log(`⚠️  TIEBA_WRITE_BOUNDARY_SRC=…… 红演示模式，证据取自 ${SRC_DIR}`);
}

// ── 期望的只读边界（唯一事实基准）────────────────────────────────────────────
/** 贴吧 MCP 工具：只读两项，名字写死——新增任何贴吧工具都会让本文件变红。 */
export const TIEBA_READ_TOOLS = Object.freeze(['qq_tieba_list', 'qq_tieba_read']);
/** 贴吧只读工具 ↔ config 注册期开关（src/mcp-snowluma-safe.js 的工具表同源）。 */
export const TIEBA_TOOL_FLAGS = Object.freeze({
  qq_tieba_list: 'tiebaList',
  qq_tieba_read: 'tiebaRead',
});
/** 贴吧桥接端点：只读两项，方法写死 GET。 */
export const TIEBA_READ_ROUTES = Object.freeze([
  Object.freeze({ method: 'GET', path: '/api/socialV2/tieba/bar' }),
  Object.freeze({ method: 'GET', path: '/api/socialV2/tieba/thread' }),
]);

/**
 * 按「真实 config 开关」算出运行期应出现的贴吧工具集合（纯函数，不做断言）。
 *
 * 静态源码里**永远**注册两项（注册代码与运行期开关无关，见 test 1）；但动态 `tools/list`
 * 必须按 flags 算期望：
 *  · flag 为 false ⇒ 该工具合法缺席（注册期过滤生效，不是缺陷）；
 *  · flag 为 true/未设置 ⇒ 该工具必须出现（被静默过滤掉才是缺陷）。
 * 之前动态断言无条件要求「恰两项」，flag 合法关闭时会假红（F3）。
 *
 * @param {Record<string, unknown>|null|undefined} flags `cfg.socialV2.tools`
 * @returns {string[]} 期望出现的贴吧只读工具名
 */
export function expectedTiebaTools(flags) {
  return TIEBA_READ_TOOLS.filter((tool) => {
    const flag = TIEBA_TOOL_FLAGS[tool];
    return flag === undefined || flags?.[flag] !== false;
  });
}

/**
 * 名字里的平台写动作词（贴吧工具/导出函数共用，token 化后按单词比对）。
 * 只收「在贴吧语境里必然是写」的强动作词。
 * 刻意不收 create/write/update/edit/make/build：`src/tieba-lib.js` 里合法存在纯工厂
 * `createTiebaLimiter`、`createTiebaPatrolGate`（不碰网络、不是写入口）。而且真正的写入口
 * 极可能还带强动作词（`createTiebaPost` ⇒ 命中 post），或干脆走 bridge 路由（由路由检查兜住）。
 */
const WRITE_ACTION_WORDS = Object.freeze([
  'post', 'publish', 'reply', 'comment', 'like', 'upvote', 'downvote',
  'favorite', 'bookmark', 'delete', 'remove', 'submit',
]);
/** 名字 token 化：`replyTiebaThread` / `qq_tieba_reply` / `createTiebaPost` 都拆成小写单词。 */
function nameTokens(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}
/** 名字里是否含写动作词（贴吧前缀 `qq_tieba_` 先剥掉，避免把平台名误判成动作）。 */
function looksLikeWriteName(name) {
  const stripped = String(name).replace(/^qq_tieba_/i, '');
  return nameTokens(stripped).some((token) => WRITE_ACTION_WORDS.includes(token));
}
/** HTTP 写方法（桥接/tieba-lib 都不该出现）。 */
const HTTP_WRITE_METHOD_RE = /\bmethod\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i;
/** 桥接里所有 `req.method === 'X' && url.pathname === 'Y'` 路由守卫。 */
const ROUTE_GUARD_RE = /req\.method\s*===\s*'([A-Z]+)'\s*&&\s*url\.pathname\s*===\s*'([^']+)'/;
/** 桥接里贴吧路径字面量（用于抓「不是标准守卫写法」的新入口）。 */
const TIEBA_LITERAL_RE = /\/api\/socialV2\/tieba\/[A-Za-z0-9_/-]*/;
/** 贴吧工具 handler 里允许调用的只读端点前缀。 */
const TIEBA_API_PREFIX = '/api/socialV2/tieba/';
/** 桥接里唯一允许消费贴吧端点的读取函数（bridge.js 顶部 import）。 */
const TIEBA_READ_FETCHERS = Object.freeze(['fetchBarPage', 'fetchThreadPages', 'fetchThreadPage']);

function readSource(name) {
  return fs.readFileSync(path.join(SRC_DIR, name), 'utf8');
}

function readToolFlags() {
  // 只读 config 里的工具开关（不打印、不外传），用于判断「注册期过滤」是否隐藏了贴吧工具。
  if (USING_OVERRIDE) return {};
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw)?.socialV2?.tools ?? {};
  } catch {
    return {};
  }
}

// ── 纯检查函数（导出，供 fixture 自检与红演示复用）──────────────────────────

/** 枚举 mcp-snowluma-safe.js 里实际 `server.tool('…')` 的注册名。 */
export function parseMcpToolNames(source) {
  const names = [];
  const re = /server\.tool\(\s*'([A-Za-z0-9_]+)'/g;
  let match;
  while ((match = re.exec(source)) !== null) names.push({ name: match[1], index: match.index });
  return names;
}

/** 切出某个 `server.tool('name', …)` 的调用体（到下一个 server.tool 调用为止）。 */
export function sliceMcpToolBody(source, name) {
  const start = source.search(new RegExp(`server\\.tool\\(\\s*'${name}'`));
  assert.notEqual(start, -1, `源码里找不到工具注册：${name}`);
  const rest = source.slice(start + 1);
  const next = rest.search(/server\.tool\(\s*'/);
  return next === -1 ? source.slice(start) : rest.slice(0, next);
}

/**
 * 断言「某个清单里的贴吧工具集合」恰为「只读两项按 flags 过滤后的期望集合」，
 * 且没有任何写动作词。
 *
 * `flags` 缺省（静态源码检查）= 不做运行期过滤，期望恒为两项；
 * 动态 `tools/list` 必须传真实 `readToolFlags()`，否则 flag 合法关闭会假红（F3）。
 *
 * @param {{ names: string[], label?: string, flags?: Record<string, unknown>|null }} evidence
 */
export function assertTiebaToolBoundary({ names, label = 'mcp', flags = null }) {
  assert.ok(Array.isArray(names) && names.length > 0, `${label}：必须真的枚举到工具清单（不能为空）`);
  assert.equal(new Set(names).size, names.length, `${label}：工具名不得重复`);
  const tieba = names.filter((name) => /tieba/i.test(name)).sort();
  const expected = expectedTiebaTools(flags).sort();
  assert.deepEqual(
    tieba,
    expected,
    `${label}：贴吧工具集合必须恰为 ${JSON.stringify(expected)}（按 config 开关计算），实际 ${JSON.stringify(tieba)}`,
  );
  const writeish = tieba.filter((name) => looksLikeWriteName(name));
  assert.deepEqual(writeish, [], `${label}：贴吧工具名里不得含写动作：${writeish.join(', ')}`);
}

/** 断言贴吧 MCP 工具 handler 只走 GET 只读端点。 */
export function assertTiebaHandlerReadOnly(source) {
  for (const name of TIEBA_READ_TOOLS) {
    const body = sliceMcpToolBody(source, name);
    const apiPaths = [...body.matchAll(/agentApi\(\s*`([^`]+)`/g)].map((m) => m[1]);
    assert.ok(apiPaths.length > 0, `${name}：handler 必须真的通过 agentApi 请求桥接（找不到 agentApi 调用）`);
    for (const apiPath of apiPaths) {
      assert.ok(
        apiPath.startsWith(TIEBA_API_PREFIX),
        `${name}：只允许访问贴吧只读端点 ${TIEBA_API_PREFIX}…，实际 ${apiPath}`,
      );
    }
    assert.ok(!HTTP_WRITE_METHOD_RE.test(body), `${name}：贴吧工具 handler 不得使用 HTTP 写方法`);
  }
}

/** 枚举桥接里所有标准路由守卫。 */
export function parseRouteGuards(source) {
  const guards = [];
  source.split('\n').forEach((line, i) => {
    const match = ROUTE_GUARD_RE.exec(line);
    if (match) guards.push({ method: match[1], path: match[2], line: i + 1 });
  });
  return guards;
}

/**
 * 断言桥接贴吧路由只有 GET 读、且全文没有第二种贴吧路径写法。
 * @returns {{ routes: Array<{method:string,path:string,line:number}>, literals: Array<{line:number,text:string,path:string,comment:boolean}> }}
 */
export function assertTiebaRouteBoundary(source) {
  const lines = source.split('\n');
  const guards = parseRouteGuards(source);
  const tiebaRoutes = guards.filter((guard) => guard.path.includes('/tieba/'));

  assert.deepEqual(
    tiebaRoutes.map((route) => `${route.method} ${route.path}`).sort(),
    TIEBA_READ_ROUTES.map((route) => `${route.method} ${route.path}`).sort(),
    '桥接贴吧端点必须恰为两条 GET 只读路由',
  );

  // 全文扫描贴吧路径字面量：只允许出现在 GET 守卫行或注释里。
  const literals = [];
  lines.forEach((text, i) => {
    const match = TIEBA_LITERAL_RE.exec(text);
    if (!match) return;
    const line = i + 1;
    const comment = /^\s*(\/\/|\*|\/\*)/.test(text);
    const guarded = guards.some((guard) => guard.line === line && guard.method === 'GET');
    literals.push({ line, text: text.trim(), path: match[0], comment });
    assert.ok(
      comment || guarded,
      `bridge.js:${line} 的贴吧路径不是 GET 路由守卫也不是注释：${text.trim()}`,
    );
    assert.match(
      match[0],
      /^\/api\/socialV2\/tieba\/(bar|thread)$/,
      `bridge.js:${line} 出现未登记的贴吧路径：${match[0]}`,
    );
  });

  // 每条贴吧路由体（到下一个路由守卫为止）不得包含 HTTP 写方法，且必须真的调用只读抓取函数。
  const sortedGuards = guards.slice().sort((a, b) => a.line - b.line);
  for (const route of tiebaRoutes) {
    const nextGuard = sortedGuards.find((guard) => guard.line > route.line);
    // 路由体到下一个任意路由守卫（不限贴吧）为止；没有下一守卫则到文件尾。
    // 不设固定行数上限，避免未来超长 handler 把写方法藏在截断区之外。
    const end = nextGuard ? nextGuard.line - 1 : lines.length;
    const body = lines.slice(route.line - 1, end).join('\n');
    assert.ok(
      !HTTP_WRITE_METHOD_RE.test(body),
      `bridge.js:${route.line} 贴吧路由体内出现 HTTP 写方法`,
    );
    assert.ok(
      TIEBA_READ_FETCHERS.some((fn) => body.includes(`${fn}(`)),
      `bridge.js:${route.line} 贴吧路由体必须调用只读抓取函数之一：${TIEBA_READ_FETCHERS.join('/')}`,
    );
  }

  return { routes: tiebaRoutes, literals };
}

/**
 * 断言 tieba-lib 导出没有写函数、没有 HTTP 写方法、网络请求全部经 safeFetch（GET-only）。
 */
export function assertTiebaLibBoundary({ exportNames, functionNames, source }) {
  assert.ok(Array.isArray(functionNames) && functionNames.length > 0, 'tieba-lib：必须真的枚举到导出函数（不能为空）');
  const writeFns = functionNames.filter((name) => looksLikeWriteName(name));
  assert.deepEqual(writeFns, [], `tieba-lib 导出里不得有写函数：${writeFns.join(', ')}`);
  for (const name of exportNames ?? []) {
    assert.ok(!looksLikeWriteName(name), `tieba-lib 导出名像写入口：${name}`);
  }
  if (typeof source === 'string') {
    assert.ok(!HTTP_WRITE_METHOD_RE.test(source), 'tieba-lib 源码里不得出现 HTTP 写方法');
    assert.ok(
      !/(?<![A-Za-z])fetch\s*\(/.test(source),
      'tieba-lib 不得直接 fetch（必须走 safeFetch，而 safeFetch 只发 GET）',
    );
  }
}

// ── 1. 静态：MCP 工具注册 ────────────────────────────────────────────────────
test('静态：mcp-snowluma-safe.js 注册的贴吧工具恰为 qq_tieba_list / qq_tieba_read（无写工具）', () => {
  const source = readSource('mcp-snowluma-safe.js');
  const declared = parseMcpToolNames(source).map((entry) => entry.name);
  assert.ok(declared.length >= 20, `必须真的枚举到注册清单，实际 ${declared.length} 个`);
  assertTiebaToolBoundary({ names: declared, label: 'mcp-snowluma-safe.js' });
  assertTiebaHandlerReadOnly(source);

  // 注册期过滤开关必须存在（否则「已注册」这件事本身不可信）：两个只读工具各自带 flag 门控。
  for (const [tool, flag] of [['qq_tieba_list', 'tiebaList'], ['qq_tieba_read', 'tiebaRead']]) {
    const registerAt = source.search(new RegExp(`server\\.tool\\(\\s*'${tool}'`));
    const before = source.slice(Math.max(0, registerAt - 400), registerAt);
    assert.match(
      before,
      new RegExp(`if\\s*\\(cfg\\.socialV2\\?\\.tools\\?\\.${flag}\\s*!==\\s*false\\)`),
      `${tool} 必须处在 cfg.socialV2.tools.${flag} !== false 的门控里（注册期过滤）`,
    );
  }
});

// ── 2. 动态：真实 stdio 注册清单（唯一权威）─────────────────────────────────
test('动态：真实 MCP server tools/list 里的贴吧工具与 config 开关一致（只读、无写入口）', { timeout: 60_000 }, async () => {
  const entry = path.join(SRC_DIR, 'mcp-snowluma-safe.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: SRC_DIR,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'tieba-write-boundary', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.length >= 20, `tools/list 必须真的返回工具清单，实际 ${names.length} 个`);

    // 动态期望必须按真实 config 开关算：flag 合法关闭时对应工具可以（且必须）缺席，
    // flag 开启时必须真的出现；任何额外贴吧工具（写入口/未登记）都算违约。F3 修复点。
    const flags = readToolFlags();
    assertTiebaToolBoundary({ names, label: 'tools/list', flags });
    assert.deepEqual(
      expectedTiebaTools(flags).sort(),
      TIEBA_READ_TOOLS.filter((tool) => flags[TIEBA_TOOL_FLAGS[tool]] !== false).sort(),
      '动态期望集合必须由 config 开关算出（仅用于自检本文件逻辑）',
    );

    // 静态清单必须覆盖动态清单（动态里出现的每个工具都能在源码里找到注册点）。
    const declared = new Set(parseMcpToolNames(readSource('mcp-snowluma-safe.js')).map((entry) => entry.name));
    const unregistered = names.filter((name) => !declared.has(name));
    assert.deepEqual(unregistered, [], `tools/list 里有源码静态枚举漏掉的工具：${unregistered.join(', ')}`);
  } finally {
    try { await client.close(); } catch {}
  }
});

// ── 3. 桥接：只剩 GET 读端点 ─────────────────────────────────────────────────
test('桥接：贴吧端点只有 GET /tieba/bar 与 GET /tieba/thread，无写路由/无写方法', () => {
  const source = readSource('bridge.js');
  const { routes, literals } = assertTiebaRouteBoundary(source);

  // 语义断言（F2 修复点）：不锁源码行号——行号只是实现细节，改注释/插入代码就会漂移。
  // 真正要守住的是「贴吧路由集合 = 只读两条、方法 GET、路径固定」，任何新增/改写路由都会变红。
  assert.equal(routes.length, 2, `贴吧路由必须恰为两条，实际 ${routes.length} 条`);
  for (const route of routes) {
    assert.equal(route.method, 'GET', `贴吧路由 ${route.path} 只允许 GET，实际 ${route.method}`);
    assert.match(route.path, /^\/api\/socialV2\/tieba\/(bar|thread)$/, `贴吧路由路径必须属于只读集合，实际 ${route.path}`);
    assert.ok(
      TIEBA_READ_ROUTES.some((expected) => expected.method === route.method && expected.path === route.path),
      `贴吧路由 ${route.method} ${route.path} 不在只读白名单里`,
    );
  }
  assert.ok(literals.length >= routes.length, '必须真的扫描到贴吧路径字面量');
});

// ── 4. tieba-lib：导出无写函数 ───────────────────────────────────────────────
test('tieba-lib：导出无写函数、无 HTTP 写方法、不绕开 safeFetch', async () => {
  const source = readSource('tieba-lib.js');
  const lib = await import(pathToFileURL(path.join(SRC_DIR, 'tieba-lib.js')).href);
  const exportNames = Object.keys(lib);
  const functionNames = exportNames.filter((name) => typeof lib[name] === 'function');
  assert.ok(functionNames.length > 10, `必须真的枚举到 tieba-lib 导出，实际函数 ${functionNames.length} 个`);
  assertTiebaLibBoundary({ exportNames, functionNames, source });

  // 共享抓取器也必须是 GET-only（tieba-lib 的所有网络请求都经它）。
  const safeFetch = readSource('safe-fetch.js');
  const methods = [...safeFetch.matchAll(/method\s*:\s*'([A-Z]+)'/g)].map((m) => m[1]);
  assert.ok(methods.length > 0, 'safe-fetch 必须显式声明 method（否则无法确认 GET-only）');
  assert.deepEqual([...new Set(methods)], ['GET'], 'safe-fetch 只允许 GET');

  // 读取抓取函数确实存在（否则「没有写函数」可能是整个抓取层消失导致的假绿）。
  for (const fn of TIEBA_READ_FETCHERS) {
    assert.equal(typeof lib[fn], 'function', `tieba-lib 必须导出只读抓取函数 ${fn}`);
  }
});

// ── 5. 反 vacuous 自检：加了写入口，上面 4 个检查函数必须抛错 ─────────────────
test('自检：把写入口喂进检查函数必须抛错（证明断言不是空断言）', async () => {
  const mcpSource = readSource('mcp-snowluma-safe.js');
  const bridgeSource = readSource('bridge.js');
  const lib = await import(pathToFileURL(path.join(SRC_DIR, 'tieba-lib.js')).href);

  // 5a. 贴吧 MCP 写工具
  const toolNames = parseMcpToolNames(mcpSource).map((entry) => entry.name);
  assert.doesNotThrow(() => assertTiebaToolBoundary({ names: toolNames }));
  for (const extra of ['qq_tieba_post', 'qq_tieba_reply', 'qq_tieba_delete', 'qq_tieba_favorite']) {
    assert.throws(
      () => assertTiebaToolBoundary({ names: [...toolNames, extra] }),
      /贴吧工具集合必须恰为|不得含写动作/,
      `新增贴吧写工具 ${extra} 必须让断言抛错`,
    );
  }
  // 写工具替换掉一个只读工具同样必须抛错（防止「2 个工具」的数量守恒被利用）。
  assert.throws(
    () => assertTiebaToolBoundary({ names: [...toolNames.filter((n) => n !== 'qq_tieba_read'), 'qq_tieba_reply'] }),
    /贴吧工具集合必须恰为|不得含写动作/,
  );

  // 5a-2. F3 反 vacuous 自检：动态期望按 config 开关算，既不能假红也不能假绿。
  // flag 合法关闭 → 该项缺席是正常状态，不得抛错（旧的无条件「恰两项」会在这里假红）。
  assert.doesNotThrow(
    () => assertTiebaToolBoundary({ names: toolNames.filter((n) => n !== 'qq_tieba_list'), flags: { tiebaList: false } }),
    'flag 合法关闭时对应贴吧工具缺席不得假红（F3 回归）',
  );
  // flag 关闭但工具仍然注册 → 必须抛错（注册期过滤失效就是缺陷）。
  assert.throws(
    () => assertTiebaToolBoundary({ names: toolNames, flags: { tiebaList: false } }),
    /贴吧工具集合必须恰为/,
    'flag 关闭但工具仍注册必须红',
  );
  // flag 开启但工具缺席 → 必须抛错（被静默过滤掉是缺陷）。
  assert.throws(
    () => assertTiebaToolBoundary({ names: toolNames.filter((n) => n !== 'qq_tieba_read'), flags: { tiebaRead: true } }),
    /贴吧工具集合必须恰为/,
    'flag 开启但工具缺席必须红',
  );

  // 5b. 贴吧桥接写路由（三种写法）
  assert.doesNotThrow(() => assertTiebaRouteBoundary(bridgeSource));
  const routeMutations = [
    `${bridgeSource}\n        if (req.method === 'POST' && url.pathname === '/api/socialV2/tieba/post') {\n          sendJson({ ok: true });\n          return;\n        }\n`,
    `${bridgeSource}\n        if (req.method === 'PUT' && url.pathname === '/api/socialV2/tieba/reply') {\n          sendJson({ ok: true });\n          return;\n        }\n`,
    `${bridgeSource}\n        if (url.pathname.startsWith('/api/socialV2/tieba/')) {\n          sendJson({ ok: true });\n          return;\n        }\n`,
  ];
  const openWriteBody = `${bridgeSource}\n        if (req.method === 'GET' && url.pathname === '/api/socialV2/tieba/reply') {\n          const r = await safeFetch('https://tieba.baidu.com/x', 1000, { method: 'POST' });\n          sendJson({ ok: true, ...r });\n          return;\n        }\n`;
  const cases = [
    ...routeMutations.map((mutated) => [mutated, '加写路由']),
    [openWriteBody, '只读路径里塞 HTTP 写方法'],
  ];
  for (const [mutated, why] of cases) {
    assert.throws(() => assertTiebaRouteBoundary(mutated), /贴吧端点|贴吧路径|HTTP 写方法/, `${why} 必须变红`);
  }

  // 5c. tieba-lib 写函数
  const exportNames = Object.keys(lib);
  const functionNames = exportNames.filter((name) => typeof lib[name] === 'function');
  assert.doesNotThrow(() => assertTiebaLibBoundary({ exportNames, functionNames, source: readSource('tieba-lib.js') }));
  for (const extra of ['createTiebaPost', 'replyTiebaThread', 'deleteTiebaPost', 'likeTiebaThread']) {
    assert.throws(
      () => assertTiebaLibBoundary({ exportNames: [...exportNames, extra], functionNames: [...functionNames, extra] }),
      /不得有写函数/,
      `新增写函数 ${extra} 必须让断言抛错`,
    );
  }

  // 5d. handler 里出现非贴吧端点 + HTTP 写方法（用拼接构造，避免本文件自身的引号打架）
  const barCall = 'await agentApi(`/api/socialV2/tieba/bar?';
  const publishCall = [
    'await agentApi(`/api/xiaoheihe/publish`, { method: \'POST\' }); void agentApi(`/api/socialV2/tieba/bar?',
  ].join('');
  assert.ok(mcpSource.includes(barCall), '5d fixture 前提不成立：源码里找不到贴吧 handler 的 agentApi 调用');
  const mcpMutated = mcpSource.replace(barCall, publishCall);
  assert.notEqual(mcpMutated, mcpSource, '5d fixture 必须真的改到源码');
  assert.throws(
    () => assertTiebaHandlerReadOnly(mcpMutated),
    /只允许访问贴吧只读端点|不得使用 HTTP 写方法/,
    '贴吧 handler 里出现写方法/非贴吧端点必须变红',
  );
});
