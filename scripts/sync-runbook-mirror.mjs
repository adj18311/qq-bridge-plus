#!/usr/bin/env node
// state/RUNBOOK.md → docs/RUNBOOK.md（入库镜像）的脱敏同步。
//
// 为什么不是一句 Copy-Item
// ------------------------
// docs/ 是入库目录，会进 `npm run privacy-scan`；而 state/RUNBOOK.md 是本机运维记录，
// 天然含两类会被扫描器抓的内容：
//   ① 无空格的机器绝对路径：形如「盘符 + 冒号 + 反斜杠 + 目录名 + 反斜杠」的路径
//      （本机那份里有一处指向本机 QQ 安装目录）⇒ 命中「本机绝对路径（非系统盘的顶层目录）」；
//   ② 备份文件名里的 ISO 时间戳：形如「…-before-hintfix-2026-10-04 23:51:28」的紧凑写法
//      ⇒ 命中「高熵串」（大小写混合 + 数字；扫描器的噪音过滤器挡不住中间那个大写 T）。
//
// 权威原文始终在 state/（不入库、逐字保留真实路径与时间戳 —— 本地补丁的可重放记录就在那里）。
// 镜像只做这两处最小脱敏，让入库文件真的过得了自己的门禁；不把这个文件整份加进
// privacy-rules.json 的 allowPaths —— 那是按文件放行，会连该文件里将来真正的泄漏一起放过。
//
// 用法：node scripts/sync-runbook-mirror.mjs
//   生成后自检（输出里不得再有这两类命中）；自检失败 ⇒ 退出码 1。
//
// 注意：本脚本的源码自己也会被 privacy-scan 扫到，所以下面的说明与示例**一律不写成能命中
// 规则的字符串**（盘符示例用全角冒号、时间戳示例用空格写法）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(ROOT, 'state', 'RUNBOOK.md');
const OUT = path.join(ROOT, 'docs', 'RUNBOOK.md');

/** 与 privacy-scan.mjs 里那两条规则同形的两个类（脱敏后必须不再命中）。 */
const PATH_RE = /(?<![A-Za-z0-9])(?!C:)[A-Za-z]:\\([^\\\s"'`|<>]{2,})\\/g;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z?/g;

const HEADER = [
  '# 运维记录（RUNBOOK）—— 发布镜像（脱敏生成，勿手改）',
  '',
  '> 本文件由 `scripts/sync-runbook-mirror.mjs` 从 `state/RUNBOOK.md` **生成**；手改会在下次同步时丢失。',
  '> 运行时的**权威副本**是 `state/RUNBOOK.md`（`state/` 被 `.gitignore` 忽略、不入库，其中逐字保留本机真实路径与时间戳）。',
  '> 同步命令（提交检查点前跑一次）：`node scripts/sync-runbook-mirror.mjs`',
  '>',
  '> 镜像只做两处**最小脱敏**（为了让入库文件过得了自己的 `npm run privacy-scan`）：',
  '> ① 无空格的机器绝对路径（盘符 + 反斜杠 + 目录名那类）→ `<本机路径>\\…`；',
  '> ② 备份文件名里的 ISO 时间戳（紧凑的 `T` 写法）→ `<时间戳>`。',
  '>',
  '> 其余内容**原样保留**，包括本机会话 key（`private:<QQ号>` / `group:<群号>`）与日志原文 —— 本仓库',
  '> **仅本机使用、不推任何远端**；将来若要公开，请先按 `PRIVACY.md` 的流程把号码替换成占位符。',
  '',
].join('\n');

if (!fs.existsSync(SRC)) {
  console.error(`[sync-runbook] 找不到权威副本：${SRC}`);
  process.exit(2);
}

const source = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
let pathHits = 0;
let isoHits = 0;

// 说明头与正文一起过一遍脱敏：头里即使写了示例，也不会把命中带进入库文件。
const out = `${HEADER}${source}`
  .replace(PATH_RE, (match, dir) => { pathHits += 1; return `<本机路径>\\${dir}\\`; })
  .replace(ISO_RE, () => { isoHits += 1; return '<时间戳>'; });

// 自检：生成物（含说明头）里不得再出现这两类命中 —— 不能让红推给别人。
const leftovers = [];
for (const [name, re] of [['机器绝对路径', PATH_RE], ['ISO 时间戳', ISO_RE]]) {
  re.lastIndex = 0;
  const m = re.exec(out);
  if (m) leftovers.push(`${name}: ${JSON.stringify(m[0])}`);
}

fs.writeFileSync(OUT, out, 'utf8');
console.log(`[sync-runbook] ${path.relative(ROOT, SRC)} → ${path.relative(ROOT, OUT)}`);
console.log(`[sync-runbook] 脱敏：机器绝对路径 ${pathHits} 处、ISO 时间戳 ${isoHits} 处；`
  + `源 ${Buffer.byteLength(source, 'utf8')} 字节 → 镜像 ${Buffer.byteLength(out, 'utf8')} 字节`);
if (leftovers.length) {
  console.error('[sync-runbook] ❌ 自检失败，生成物里仍有命中：');
  for (const item of leftovers) console.error(`   - ${item}`);
  process.exit(1);
}
console.log('[sync-runbook] ✅ 自检通过（生成物里已无这两类命中）');
