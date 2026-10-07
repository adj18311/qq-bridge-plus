// 用 dsh-persona 自己的配置 schema 校验修复后的 preset persona 配置。
// 说明：schema 优先取自 DSH 安装目录里那份（真正会加载我们 preset 的就是它），解析不到时
// 退回仓库自带的 devDependency —— 新版 DSH 把这类内部包收进了 app.asar，磁盘上没有可
// import 的路径（详见 CHANGELOG 与 README 的自测一节）。不依赖 YAML 解析器版本，
// 也不需要 DSH 进程在跑。
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dshModulesDir } from './dsh-modules.mjs';

const require_ = createRequire(import.meta.url);

async function loadPersona() {
  try {
    const dshModules = dshModulesDir();
    const mod = await import(pathToFileURL(path.join(dshModules, '@deepseek-ai/dsh-persona/lib/index.js')).href);
    return { mod, from: `DSH 安装处（${dshModules}）` };
  } catch (dshError) {
    try {
      const mod = await import(pathToFileURL(require_.resolve('@deepseek-ai/dsh-persona')).href);
      return { mod, from: '仓库依赖 @deepseek-ai/dsh-persona（devDependency，与目标 DSH 版本对齐）' };
    } catch (repoError) {
      return { mod: null, why: `DSH 安装处：${dshError?.message ?? dshError}；仓库依赖：${repoError?.message ?? repoError}` };
    }
  }
}

const { mod: persona, from, why } = await loadPersona();
if (!persona) {
  console.error('❌ 加载不到 @deepseek-ai/dsh-persona，没法校验 persona schema。');
  console.error(`   原因：${why}`);
  console.error('   它现在是本仓库的 devDependency：先跑 `npm ci`（不要加 --omit=dev）再试。');
  process.exit(2);
}
console.log(`persona Config schema 校验（schema 来源：${from}）：\n`);

let failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (e) { console.log(`  ❌ ${label}: ${e?.message ?? e}`); failed += 1; }
}

// （schema 来源已在上面打印）

// 旧写法（DSH 0.1.2 时代的 text 字段）—— 期望被拒绝
check('旧配置 {text} 被拒绝（复现原故障）', () => {
  let threw = false;
  try { persona.Config({ text: 'hello' }); } catch { threw = true; }
  if (!threw) throw new Error('旧配置竟然通过了校验，说明本次改动前提不成立');
});

// 新写法 —— 期望通过
check('新配置 {prefix} 通过（个人前缀）', () => {
  const v = persona.Config({ prefix: 'You are a coding agent powered by the {{model}} model.' });
  if (v.prefix.length === 0) throw new Error('prefix 为空');
});

check('新配置 {prefix, suffix} 通过（含 {{cwd}} 模板）', () => {
  const v = persona.Config({
    prefix: 'You are a coding agent powered by the {{model}} model.',
    suffix: 'Your working directory is {{cwd}}.',
  });
  if (v.suffix !== 'Your working directory is {{cwd}}.') throw new Error('suffix 未保留');
  if (v.complete !== false) throw new Error('complete 默认值异常');
  if (v.includeRuntimeContext !== true) throw new Error('includeRuntimeContext 默认值异常');
});

// 校验仓库里两个 preset 的 persona 配置块
const YAML = await import(pathToFileURL(require_.resolve('js-yaml')).href);
const yaml = YAML.default ?? YAML;

for (const preset of ['qq-chat', 'qq-chat-v2']) {
  const file = path.resolve(process.cwd(), 'dsh/agent-presets', preset, 'agent.cordis.yml');
  console.log(`\n${preset} (${path.relative(process.cwd(), file)}):`);
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  const row = doc.find((r) => r.id === 'persona');
  check('存在 persona 行', () => { if (!row) throw new Error('缺少 persona 行'); });
  check('persona 行名正确', () => {
    if (row.name !== '@deepseek-ai/dsh-persona') throw new Error(`name=${row.name}`);
  });
  check('persona.config 通过 DSH schema', () => { persona.Config(row.config); });
  check('保留了 {{model}} 变量', () => {
    if (!/\{\{model\}\}/.test(row.config.prefix)) throw new Error('prefix 缺少 {{model}}');
  });
  check('保留了 {{cwd}} 变量', () => {
    if (!/\{\{cwd\}\}/.test(row.config.suffix ?? '')) throw new Error('suffix 缺少 {{cwd}}');
  });
  check('不再包含已废弃的 text 字段', () => {
    if (Object.hasOwn(row.config, 'text')) throw new Error('仍有 text 字段');
  });
  check('persona 正文（除头句）完整保留', () => {
    const body = row.config.prefix.split('\n').slice(1).join('\n');
    if (body.length < 500) throw new Error(`正文疑似丢失，仅 ${body.length} 字符`);
  });
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
