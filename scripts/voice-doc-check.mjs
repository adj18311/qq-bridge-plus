// 「语音工具权威文档」断言的唯一实现：纯函数 + 一个薄 fs 包装。
//
// 为什么要单独一个模块
// --------------------
// 1. `scripts/test-voice-system.mjs` 需要一条**不 skip** 的文档断言：权威文档
//    (`docs/guides/VOICE-TOOLS.md`) 是随仓库跟踪的一部分，缺失就是回归失败，不能用
//    "这份文档不在工作区里"当借口跳过（根 README.md 已被用户删除，旧断言曾无条件读它）。
// 2. 文档断言本身也要有负向证据：缺文档 / 缺 voice-gui / 缺 voice-cli / 缺"默认关闭"表述
//    都必须判红，否则"文档检查"很容易退化成永远为真的空检查。
//    `scripts/test-voice-doc-check.mjs` 复用这里的纯函数，在 os.tmpdir() 的临时副本上
//    做红/绿对照，绝不动生产文档。
//
// 本模块只读文件：不写盘、不联网、不启动任何服务。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本仓库根目录。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 权威文档的仓库相对路径。 */
export const VOICE_DOC_REL = path.join('docs', 'guides', 'VOICE-TOOLS.md');

/**
 * 权威文档必须包含的关键表述。
 *
 * 只钉"必须存在的实质内容"，不钉措辞顺序：两个外置入口名、AI 默认关闭、桥接 audio/ 边界、
 * 操作者通道、以及"工具不在本仓库"这句（防止文档把外置工具写成已随仓库提供）。
 */
export const VOICE_DOC_REQUIRED = [
  { id: 'voice-gui', needle: 'voice-gui.mjs' },
  { id: 'voice-cli', needle: 'voice-cli.mjs' },
  { id: 'default-off', needle: 'AI 发语音默认关闭' },
  { id: 'audio-dir', needle: 'audio/' },
  { id: 'operator-channel', needle: '操作者' },
  { id: 'external-not-vendored', needle: '不在本仓库' },
];

/** 文档里不该出现的东西：本机绝对路径（会让文档变成"作者机器说明书"）。 */
const FORBIDDEN_IN_DOC = [
  {
    id: 'no-absolute-windows-path',
    re: /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/m,
    message: '出现带盘符的 Windows 绝对路径（应改成仓库相对路径）',
  },
  {
    id: 'no-absolute-posix-home',
    re: /\/(?:Users|home)\//,
    message: '出现 /Users 或 /home 下的本机绝对路径（应改成仓库相对路径）',
  },
];

/**
 * 对一段文档正文做断言（纯函数，不碰文件系统）。
 *
 * @param {unknown} text 文档正文；非字符串视为缺失。
 * @param {{ docLabel?: string }} [options] 用于输出文案的文档名。
 * @returns {{
 *   ok: boolean,
 *   docLabel: string,
 *   checks: Array<{ id: string, ok: boolean, label: string, message?: string }>,
 *   failures: Array<{ id: string, message: string }>,
 * }}
 */
export function checkVoiceDocText(text, options = {}) {
  const docLabel = options.docLabel ?? VOICE_DOC_REL;
  const checks = [];
  const failures = [];

  if (typeof text !== 'string' || text.trim() === '') {
    const check = {
      id: 'doc-exists',
      ok: false,
      label: `文档 ${docLabel} 存在且非空（缺失即失败，不 skip）`,
      message: '文档缺失或为空',
    };
    checks.push(check);
    failures.push({ id: 'missing-doc', message: `${docLabel} 缺失或为空 —— 文档断言不允许 skip` });
    return { ok: false, docLabel, checks, failures };
  }

  checks.push({ id: 'doc-exists', ok: true, label: `文档 ${docLabel} 存在且非空（缺失即失败，不 skip）` });

  for (const req of VOICE_DOC_REQUIRED) {
    const hit = text.includes(req.needle);
    checks.push({
      id: req.id,
      ok: hit,
      label: `文档 ${docLabel} 提到「${req.needle}」`,
      message: hit ? undefined : `缺少必须表述「${req.needle}」`,
    });
    if (!hit) failures.push({ id: req.id, message: `缺少必须表述「${req.needle}」` });
  }

  for (const rule of FORBIDDEN_IN_DOC) {
    const hit = rule.re.test(text);
    checks.push({
      id: rule.id,
      ok: !hit,
      label: `文档 ${docLabel} 不含本机绝对路径（${rule.id}）`,
      message: hit ? rule.message : undefined,
    });
    if (hit) failures.push({ id: rule.id, message: rule.message });
  }

  return { ok: failures.length === 0, docLabel, checks, failures };
}

/**
 * 读取并断言某个根目录下的权威文档。
 *
 * 与 `test-voice-system.mjs` 里"外置工具不在就跳过"的口径刻意不同：文档在仓库里，
 * 缺失一律是 `missing-doc` 失败。
 *
 * @param {string} [root] 仓库根（默认本仓库；负向回归传 os.tmpdir() 下的临时根）。
 * @param {{ docRel?: string }} [options]
 */
export function checkVoiceDoc(root = REPO_ROOT, options = {}) {
  const docRel = options.docRel ?? VOICE_DOC_REL;
  const abs = path.join(root, docRel);
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    const result = checkVoiceDocText(null, { docLabel: docRel });
    return { ...result, docPath: abs };
  }
  return { ...checkVoiceDocText(text, { docLabel: docRel }), docPath: abs };
}
