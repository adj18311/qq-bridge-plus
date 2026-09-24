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
 * 本地执行能力清单。名字取自 DSH 0.1.5-rc.1 实际发布的 `@deepseek-ai/dsh-tool-*`
 * 工具包，而不是凭印象：pwsh/bash（含 persistent 变体）、read/read_image/write/
 * edit/str_replace_editor、glob/grep、以及能间接拿到 shell 的派生 agent 与编排类。
 * 若 DSH 新增本地工具，这里应当补上——这正是本测试存在的意义。
 */
const LOCAL_EXECUTION_TOOLS = [
  'pwsh', 'bash', 'pwsh_persistent', 'bash_persistent',
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  'glob', 'grep',
  'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph', 'cordis',
];

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
    const violations = [];
    const fakeTools = {
      restrict({ deny }) { for (const n of deny ?? []) restricted.add(n); },
      guard(fn) {
        // 记录守卫，稍后逐个探测本地工具名是否被拒。
        this._guard = fn;
      },
    };
    const mod = await import(pathToFileURL(guardPath).href);
    mod.apply({ tools: fakeTools });

    for (const tool of LOCAL_EXECUTION_TOOLS) {
      if (!restricted.has(tool)) violations.push(tool);
    }
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

test('封闭 agent 的预设（若已安装）允许完整本地工具面', () => {
  // qsh-closed 由 ADR 0003 定义为**故意**拥有完整本地工具面：
  // 它的隔离只负责"哪些 QQ 动作可见"，不负责"本地工具权限边界"。
  // 尚未创建时不失败，但一旦创建就必须与仿真 preset 明确区分。
  for (const id of CLOSED_AGENT_PRESETS) {
    const dir = path.join(PRESETS_DIR, id);
    if (!fs.existsSync(dir)) continue;
    const yml = fs.readFileSync(path.join(dir, 'agent.cordis.yml'), 'utf8');
    assert.match(yml, /qq-tool-restrict/, `${id} 也应挂守卫（用于 QQ 动作可见性）`);
  }
});
