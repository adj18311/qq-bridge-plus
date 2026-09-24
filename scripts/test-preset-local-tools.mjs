// 铁律 L7 的注册期断言：仿真会话的 preset **不得包含本地执行能力**。
//
// 为什么必须有这个文件
// --------------------
// `QSH_PLAN.md` §0.1 的结论是：QQ 动作闸门全部跑在桥接进程内，而 OneBot 的
// 127.0.0.1:3000 HTTP 接口可被任何本机进程用 Bearer token 直接调用。因此
// **"仿真会话拿不到 shell"是整个分层安全模型唯一的真边界**。
//
// 但在此之前没有任何断言检查过这件事：
//   · `test-audit-setup-guards.mjs` 把工具名**喂**给 guard，验证它拒绝——这证明
//     guard 逻辑对，**不证明本地工具已从工具清单里隐藏**；
//   · `probe-tools.mjs` 只断言"模型某一轮没有调用本地工具"——**没调用 ≠ 不在清单里**。
//
// 本测试补上注册期那一半：从**真实 preset 文件**里解析出 preset 组成，断言
// 工具守卫被挂载，并且守卫的 restrict 名单覆盖每一个已知本地执行工具。
// 它不依赖运行中的 DSH，因此可以进 `npm run test:audit`，每次回归都跑。
//
// 口径说明：这里断言的是"preset 声明会隐藏/拒绝这些名字"。真正的端到端断言
// （注册出来的清单里确实没有）需要活的 DSH，属 `probe-tools.mjs` 的范畴。

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRESETS_DIR = path.join(ROOT, 'dsh', 'agent-presets');

/** 仿真模式使用的 preset（不允许有任何本地执行能力）。 */
const SIMULATION_PRESETS = ['qq-chat', 'qq-chat-v2'];

/** 封闭 agent 的 preset：按设计**允许**完整本地工具面。 */
const CLOSED_AGENT_PRESETS = ['qsh-closed'];

/**
 * 本地执行能力清单。
 *
 * ⚠️ 这里**必须**含每一个能执行本地命令、读写本地文件或派生 agent 的工具名。
 * 名字取自 DSH 0.1.5-rc.1 实际注册的工具（见 qq-tool-restrict.mjs 的注释）。
 *
 * 两类失败模式，本文件都要防：
 *   ① **漏**（本地工具不在守卫名单里 ⇒ 留在 schema）——由 test 3 对账 RESTRICTED_TOOL_NAMES 防；
 *   ② **拼错假名**（名字根本不存在 ⇒ `tools.restrict` 抛错被吞 ⇒ 静默失效）——
 *      由 test 6 用「假 restrict 会对未知名字抛错」来防。
 */
const LOCAL_EXECUTION_TOOLS = [
  'pwsh', 'bash',
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  'glob', 'grep',
  'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  'cordis_define', 'cordis_undefine', 'cordis_run', 'cordis_stop',
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
];

/**
 * 工具名 → 真实存在与否。从已安装的 DSH 包里抽取，用来抓"拼错的假名"。
 * 找不到 DSH 安装时返回 null，相关断言改为跳过（并明确打印跳过原因），
 * 而不是假装通过。
 */
function collectDshToolNames() {
  const home = process.env.DSH_HOME
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.dsh') : null);
  const roots = [
    process.env.DSH_TOOL_PACKAGES,
    // DSH 自带的工具包
    process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, 'dsh-latest', 'node_modules', '@deepseek-ai')
      : null,
    // 本机安装的第三方插件也注册工具（dsh-plugin-guard 的 dsh_snapshot/dsh_rollback
    // 就在这里）。不扫这个目录会把**真实名字误判成假名**——本测试最初就是这样
    // 误报了 dsh_snapshot/dsh_rollback。
    home ? path.join(home, 'plugins') : null,
  ].filter((p) => p && fs.existsSync(p));

  const DSH_PKG_ROOT = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, 'dsh-latest', 'node_modules', '@deepseek-ai')
    : null;

  const found = new Set();
  let scanned = 0;
  for (const root of roots) {
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    // 工具来自 dsh-tool-*，以及若干非 dsh-tool 前缀的注册方
    // （plan-mode/schedule/tools）；插件目录下则全部扫。
    // 工具来自 dsh-tool-*，但**名字**大量声明在别处的 patch 里：
    //   dsh-base/cordis.patch.yml        → toolName: subagent / subagent_fork / workflow …
    //   dsh-web-app/cordis.patch.yml     → disabled 行
    // 只筛 dsh-tool-* 会漏掉这些，从而把真实名字误判成假名——初版就是这样把
    // subagent/workflow 报成假名的。所以这里必须把 base/web-app 也纳入。
    const isDshPkgRoot = DSH_PKG_ROOT !== null && path.resolve(root) === path.resolve(DSH_PKG_ROOT);
    const interesting = isDshPkgRoot
      ? dirs.filter((n) => /^dsh-(tool-|plugin-|mode-|schedule|plan-mode|tools|base|web-app)/.test(n))
      : dirs.filter((n) => !n.startsWith('.'));
    for (const d of interesting) {
      const pkgDir = path.join(root, d);
      const files = [];
      const walk = (dir, depth) => {
        if (depth > 3) return;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full, depth + 1);
          else if (/\.(js|mjs|cjs)$/.test(e.name)) files.push(full);
        }
      };
      walk(pkgDir, 0);
      for (const f of files) {
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        scanned++;
        for (const m of text.matchAll(/\bname:\s*['"]([a-z][a-z0-9_]{2,40})['"]/g)) found.add(m[1]);
        for (const m of text.matchAll(/\btoolName:\s*['"]([a-z][a-z0-9_]{2,40})['"]/g)) found.add(m[1]);
        // 名字也可能藏在 schema 默认值里。dsh-tool-workflow 就是这样声明的：
        //   toolName: z.string().default("workflow")
        // 只看字面量会漏掉它，从而把真实名字误判成假名（本测试踩过）。
        for (const m of text.matchAll(/\btoolName:\s*[^;\n]*?\.default\(\s*['"]([a-z][a-z0-9_]{2,40})['"]/g)) {
          found.add(m[1]);
        }
        // 以及简写属性 `name,`（即 name: name）。
        if (/\bdefineTool\(\{[\s\S]{0,200}?\bname,\s*\n/.test(text)) {
          const nm = /\bname:\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\n/.exec(text);
          if (nm) found.add(nm[1]);
        }
      }
      // 名字也大量出现在 YAML patch 里，只读 .js 会漏掉它们，从而把**真实名字
      // 误判成假名**——本测试自己踩过：subagent/workflow/dsh_snapshot 最初就是这样
      // 被误报的。注意 id 常带连字符（tool-subagent-fork），所以字符类要放宽，
      // 再用"不含 / 和 @"把包名排除掉。
      for (const yml of ['cordis.patch.yml', 'cordis.patch.yaml']) {
        const p = path.join(pkgDir, yml);
        if (!fs.existsSync(p)) continue;
        let text = '';
        try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
        scanned++;
        for (const m of text.matchAll(/^\s*(?:-\s*)?(?:id|name|toolName):\s*([^\s#]+)\s*$/gm)) {
          const v = m[1].replace(/^['"]|['"]$/g, '');
          if (!v || /[/@]/.test(v)) continue;      // 包名，不是工具名
          if (!/^[a-z][a-z0-9_-]{1,40}$/.test(v)) continue;
          found.add(v);
        }
      }
    }
  }
  return scanned === 0 ? null : found;
}

/** 允许出现在名单里、但不属于"本地执行"语义的名字（开发/注入器）。 */
const DEV_TOOL_PREFIX = /^dev_/;

/** 允许出现的 MCP 命名空间前缀（QQ 动作面）。 */
const EXPECTED_SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
];

function readPreset(id) {
  const dir = path.join(PRESETS_DIR, id);
  assert.ok(fs.existsSync(dir), `preset 目录存在：${id}`);
  const cordis = path.join(dir, 'agent.cordis.yml');
  assert.ok(fs.existsSync(cordis), `preset 有 agent.cordis.yml：${id}`);
  return { dir, yml: fs.readFileSync(cordis, 'utf8'), cordis };
}

// ---------------------------------------------------------------------------
test('模拟会话的 preset 都挂了工具守卫（否则 L7 没有任何载体）', () => {
  for (const id of SIMULATION_PRESETS) {
    const { yml } = readPreset(id);
    assert.match(
      yml,
      /qq-tool-restrict/,
      `${id} 必须挂载 qq-tool-restrict（L7 的落点），否则本地工具会随全局层继承进来`,
    );
    // 守卫必须是相对插件（./qq-tool-restrict.mjs），而不是一个被忽略的名字。
    assert.match(yml, /\.\/qq-tool-restrict\.mjs/, `${id} 的守卫要指向本目录的 .mjs`);
  }
});

test('模拟会话的 preset 不得挂载 tool-web 的 search/fetch', () => {
  for (const id of SIMULATION_PRESETS) {
    const { yml } = readPreset(id);
    const webRow = /id:\s*tool-web[\s\S]{0,200}/.exec(yml);
    assert.ok(webRow, `${id} 应有 tool-web 条目`);
    assert.match(webRow[0], /search:\s*false/, `${id}: tool-web.search 必须为 false`);
    assert.match(webRow[0], /fetch:\s*false/, `${id}: tool-web.fetch 必须为 false`);
  }
});

test('守卫的 restrict 名单覆盖每一个已知本地执行工具', async () => {
  for (const id of SIMULATION_PRESETS) {
    const { dir } = readPreset(id);
    const guardPath = path.join(dir, 'qq-tool-restrict.mjs');
    assert.ok(fs.existsSync(guardPath), `${id} 的守卫文件存在`);

    // 用假 tools 服务调用真实守卫，捕获它实际下发的 restrict 请求。
    const restricted = new Set();
    const fakeTools = {
      restrict({ deny }) { for (const n of deny ?? []) restricted.add(n); },
      guard(fn) { this._guard = fn; },
    };
    const mod = await import(pathToFileURL(guardPath).href);
    mod.apply({ tools: fakeTools });

    const violations = LOCAL_EXECUTION_TOOLS.filter((t) => !restricted.has(t));
    assert.deepEqual(
      violations, [],
      `${id}: 以下本地执行工具未出现在 restrict 名单里，会留在模型的工具清单中：`
      + `${violations.join(', ')}。注册期隐藏失败 ⇒ §5.2 的 L7 断言不成立。`,
    );

    // 执行期白名单也必须拒绝它们（restrict 与 guard 是两道，不能只靠一道）。
    assert.equal(typeof fakeTools._guard, 'function', `${id}: 守卫注册了执行期白名单`);
    for (const tool of LOCAL_EXECUTION_TOOLS) {
      const verdict = fakeTools._guard({ name: tool });
      assert.ok(
        typeof verdict === 'string' && verdict.length > 0,
        `${id}: 本地工具 "${tool}" 必须在执行期被拒绝，实际返回 ${JSON.stringify(verdict)}`,
      );
    }
  }
});

test('守卫导出的名单与本测试的清单一致（防两份名单各自漂移）', async () => {
  // 先前这个测试只是"复制"名单的前 19 个名字，导致守卫里多出的 7 个名字
  // 从来没被断言过。现在改为**导入**守卫自己导出的数组，两边不可能漂移。
  for (const id of SIMULATION_PRESETS) {
    const { dir } = readPreset(id);
    const mod = await import(pathToFileURL(path.join(dir, 'qq-tool-restrict.mjs')).href);
    assert.ok(
      Array.isArray(mod.RESTRICTED_TOOL_NAMES) && mod.RESTRICTED_TOOL_NAMES.length > 0,
      `${id}: 守卫必须导出 RESTRICTED_TOOL_NAMES，供测试对账`,
    );
    const missing = LOCAL_EXECUTION_TOOLS.filter((t) => !mod.RESTRICTED_TOOL_NAMES.includes(t));
    assert.deepEqual(missing, [],
      `${id}: 守卫导出的名单缺少本地执行工具：${missing.join(', ')}`);
    // 反向：名单里不该混入"允许的无害工具"。
    for (const allowed of ['ask_user_question', 'todo_write']) {
      assert.ok(!mod.RESTRICTED_TOOL_NAMES.includes(allowed),
        `${id}: ${allowed} 是无害模型侧工具，不应出现在 restrict 名单里（会与 SAFE_EXACT 自相矛盾）`);
    }
  }
});

test('守卫名单里的每个名字都是 DSH 真实注册的工具（防拼错假名静默失效）', async () => {
  // 为什么必须测：`tools.restrict()` 对未知名字会**抛错**，而守卫逐个 try/catch
  // 只打日志 ⇒ 拼错的名字 = **静默 no-op**。这正是本名单初版的真实缺陷：
  // pwsh_persistent / bash_persistent / cordis / goal_write / goal_read 五个假名
  // 让整批限制悄悄少生效，而套件当时全绿。
  const dshNames = collectDshToolNames();
  if (dshNames === null) {
    console.log('  ⏭  跳过：未找到 DSH 工具包（设 DSH_TOOL_PACKAGES 指向 @deepseek-ai 目录即可启用）');
    return;
  }
  for (const id of SIMULATION_PRESETS) {
    const { dir } = readPreset(id);
    const mod = await import(pathToFileURL(path.join(dir, 'qq-tool-restrict.mjs')).href);
    const fabricated = mod.RESTRICTED_TOOL_NAMES
      .filter((n) => !DEV_TOOL_PREFIX.test(n) && !dshNames.has(n));
    assert.deepEqual(fabricated, [],
      `${id}: 以下名字在 DSH 已安装的工具包里找不到 ⇒ restrict 会抛错并被吞掉，`
      + `限制静默失效：${fabricated.join(', ')}`);
  }
});

test('守卫仍放行 QQ MCP 命名空间与无害模型侧工具', async () => {
  for (const id of SIMULATION_PRESETS) {
    const { dir } = readPreset(id);
    const guardPath = path.join(dir, 'qq-tool-restrict.mjs');
    const fakeTools = { restrict() {}, guard(fn) { this._guard = fn; } };
    const mod = await import(pathToFileURL(guardPath).href);
    mod.apply({ tools: fakeTools });

    for (const prefix of EXPECTED_SAFE_PREFIXES) {
      assert.equal(
        fakeTools._guard({ name: `${prefix}some_tool` }), undefined,
        `${id}: MCP 前缀 ${prefix} 应放行`,
      );
    }
    for (const name of ['ask_user_question', 'todo_write']) {
      assert.equal(fakeTools._guard({ name }), undefined, `${id}: ${name} 应放行`);
    }
    // 未知工具名必须 fail-closed。
    for (const name of ['', null, undefined, 'mcp__unknown__x', 'totally_new_tool']) {
      assert.ok(
        typeof fakeTools._guard({ name }) === 'string',
        `${id}: 未知工具 ${JSON.stringify(name)} 必须被拒绝（fail-closed）`,
      );
    }
  }
});

test('封闭 agent 的预设在创建后必须与仿真 preset 明确区分', () => {
  // qsh-closed 由 ADR 0003 定义为**故意**拥有完整本地工具面：它的守卫只负责
  // "哪些 QQ 动作可见"，不负责"本地工具权限边界"。
  //
  // ⚠️ 这条断言初版是**恒真**的：qsh-closed 还不存在，`if (!exists) continue`
  // 直接跳过整个函数体，永远不会失败——一个永远不会失败的测试不如没有。
  // 现在改为显式记录"尚未创建"，并且一旦创建就执行真实断言。
  const present = CLOSED_AGENT_PRESETS.filter((id) => fs.existsSync(path.join(PRESETS_DIR, id)));
  if (present.length === 0) {
    // 不是失败，但必须让人看见"这条闸门还没被真正覆盖"。
    console.log('  ⏭  qsh-closed 尚未创建（ADR 0003 待落地）；此项覆盖暂为空，不是通过。');
    return;
  }
  for (const id of present) {
    const yml = fs.readFileSync(path.join(PRESETS_DIR, id, 'agent.cordis.yml'), 'utf8');
    assert.match(yml, /qq-tool-restrict/, `${id} 也应挂守卫（用于 QQ 动作可见性）`);
    // 与仿真 preset 的关键区别：封闭 agent 必须能拿到本地工具 ⇒
    // 它的守卫不得把本地执行工具写进 restrict 名单。
    const guard = fs.readFileSync(path.join(PRESETS_DIR, id, 'qq-tool-restrict.mjs'), 'utf8');
    for (const tool of ['pwsh', 'read', 'write']) {
      assert.ok(
        !new RegExp(`['"]${tool}['"]`).test(guard),
        `${id}: 封闭 agent 需要本地工具，守卫不应把 "${tool}" 列入 restrict`,
      );
    }
  }
});
