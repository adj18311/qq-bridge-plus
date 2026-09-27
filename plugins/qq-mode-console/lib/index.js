// QQ 桥接模式控制台（host 插件，仅注册 settings 命名空间）。
//
// 通过 DSH 官方用户设置扩展点（ctx.settings.register）暴露一个
// `qq-mode` 命名空间。本插件没有 browser/client 半，不会自动生成 WebUI 设置卡片。
// 用户通过桥接控制台切换模式，桥接进程通过 DSH settings API 轮询读取。
// 本插件不修改任何 WebUI 内核。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

// 诊断日志写系统临时目录，**不要**按相对层级往上爬。
//
// 历史坑：这里曾经是 path.join(__dirname, '..', '..', '..', 'state', ...)。
// 插件是以 `link:<DSH_HOME>/plugins/qq-mode-console` 装进 profile 的，往上是
// <DSH_HOME>/..，于是在任何非作者机器上都会在用户主目录旁凭空拉出一个 state/ 目录，
// 只有作者机器上恰好指回仓库时才"看起来正常"。可用 QQ_MODE_DIAG 覆盖路径（空字符串=关闭）。
const DIAG = process.env.QQ_MODE_DIAG ?? path.join(os.tmpdir(), 'qq-mode-plugin.log');

function diag(msg) {
  if (!DIAG) return;
  try {
    fs.mkdirSync(path.dirname(DIAG), { recursive: true });
    fs.appendFileSync(DIAG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

export const name = 'qq-mode-console';
export const inject = ['settings'];

export const QQMODE_NAMESPACE = 'qq-mode';

export const QqModeSchema = z.object({
  // `simulation` 是规范名（QSH_PLAN.md §2.1），`chat`/`reserved`/`reserved2` 是历史拼写。
  // 两者都必须能被**存进设置**：桥接在输入侧把它们归一到同一个内部值（见 bridge.js 的
  // MODE_INPUT_ALIASES），但这里如果只列历史名，用户在 DSH 设置里写 `simulation` 会被
  // schema 直接拒掉，而 schema 校验失败会把整个命名空间一起打掉 —— 连 ownerQQ 都读不到，
  // 桥接只能回退本地 mode.json 且**没有任何提示**。默认值保持 `reserved2`（不改变现有用户行为）。
  mode: z.union([
    z.const('chat'), z.const('closed-agent'), z.const('reserved'), z.const('reserved2'), z.const('simulation')
  ]).default('reserved2'),
  ownerQQ: z.string().description('管理员 QQ（ownerQQ）；留空表示不通过 DSH 设置覆盖 config.json'),
});

/**
 * 这个插件**作为 loader entry 的 Config** 暴露出去的模式设置。
 *
 * 为什么必须有它、而且字段必须标 `.volatile()`：
 *   DSH 0.1.7 的 settings.update → settings.write() 是这样定位目标的
 *   （dsh-settings/lib/index.js）：
 *       const entry = configEditor.entries().find((row) => row.options.id === ns);
 *       const schema = entry?.fiber?.runtime?.Config;
 *       if (!entry || !schema) throw new Error(`No configurable plugin entry "${ns}"`);
 *       const form = volatileForm(schema);   // 只保留 meta.volatile 的字段，否则抛
 *                                            // "Plugin entry ... has no volatile fields"
 *   也就是说，一个命名空间要能被**写入**，必须同时满足三点：
 *     ① 存在一个 loader entry，其 **id 恰好等于命名空间名** —— 所以 cordis.patch.yml 里
 *        这条 entry 的 id 是 `qq-mode`（不是 `qq-mode-console`）；
 *     ② 该 entry 的插件模块导出了 `Config`（schema(entry) 读的就是 fiber.runtime.Config）；
 *     ③ `Config` 里至少有一个字段带 `volatile` 标记。
 *   此前只有 `ctx.settings.register()`，而 entry id 与命名空间不同名 —— 于是桥接的
 *   「模式写穿 DSH 设置」永远抛 `No configurable plugin entry "qq-mode"`：模式只在本地生效，
 *   下一次 DSH 轮询就把它覆盖回滚（只在有人从控制台改模式时才会暴露）。
 *   这里补齐 ②③；① 在 cordis.patch.yml。
 *
 * `.extra('volatile', true)` 是 DSH 的"可热改、不重挂载"标记。这里**刻意不写 `.volatile()`**：
 * 那只是 schemastery 的一个语法糖（dsh-client-ui-theme 的 client.js 里就是
 * `Schema.prototype.volatile = function () { return this.extra('volatile', true) }`），
 * 而它只存在于 DSH 自带的那份 schemastery（3.18.4）；本仓库钉的 `^3.18.1` 解析出来的
 * 那份**没有**这个方法 —— 写 `.volatile()` 会让桥接自己的静态测试直接
 * `TypeError: .volatile is not a function`（实测）。`.extra` 两边都有，行为完全一致。
 */
export const Config = z.object({
  mode: z.union([
    z.const('chat'), z.const('closed-agent'), z.const('reserved'), z.const('reserved2'), z.const('simulation')
  ]).default('reserved2').extra('volatile', true),
  ownerQQ: z.string().description('管理员 QQ（ownerQQ）；留空表示不通过 DSH 设置覆盖 config.json').extra('volatile', true),
});

export function apply(ctx, config = {}) {
  diag(`apply called, settings=${typeof ctx.settings} inject=${JSON.stringify(ctx._inject)}`);
  try {
    const settings = ctx.settings;
    if (!settings || typeof settings.register !== 'function') {
      diag('settings service unavailable');
      return;
    }
    const scope = settings.register(QQMODE_NAMESPACE, QqModeSchema, {
      base: { mode: 'reserved2' },
      applies: 'live'
    });
    diag(`registered ${QQMODE_NAMESPACE} scope=${typeof scope}`);
    console.log(`[qq-mode-console] active (namespace=${QQMODE_NAMESPACE})`);
  } catch (error) {
    if (/already registered/i.test(String(error?.message ?? error))) {
      diag(`qq-mode namespace already registered, skip`);
      return;
    }
    diag(`register threw: ${error?.stack ?? error}`);
    throw error;
  }
}
