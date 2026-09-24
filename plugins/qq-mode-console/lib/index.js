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
  mode: z.union([z.const('chat'), z.const('closed-agent'), z.const('reserved'), z.const('reserved2')]).default('reserved2'),
  ownerQQ: z.string().description('管理员 QQ（ownerQQ）；留空表示不通过 DSH 设置覆盖 config.json'),
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
