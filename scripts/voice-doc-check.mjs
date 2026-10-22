// 「语音能力发布契约」断言的唯一实现：纯函数 + 一个薄 fs 包装。
//
// 为什么改检查对象
// ----------------
// 纯净代码包只发代码，不随包附 README / docs（用户要求「无任何 README」），所以原来断言
// docs/guides/VOICE-TOOLS.md 的用例没有可断言的对象了。直接删除或 skip 会让这条门禁失效，
// 因此把同样的实质约束落到**代码与包元数据**上：
//   1. 语音核心保留：scripts/send-voice.mjs 存在且非空；
//   2. 语音测试保留：package.json 的 `test-voice` 脚本 + scripts/test-voice.mjs；
//   3. 发送入口保留：package.json 的 `send-voice` 脚本指向本包内的 scripts/send-voice.mjs；
//   4. 外置可选语音工具（voice-tool）不属于本包：不得再出现 voice-gui / voice-cli 包脚本，
//      也不得出现指向 voice-tool 的脚本命令。
//
// 旧导出名（checkVoiceDoc / checkVoiceDocText / VOICE_DOC_REL）保留，避免其它调用点
// （如 scripts/test-voice-system.mjs）改 import；语义已经是「包契约」而不是「文档」。
//
// 本模块只读文件：不写盘、不联网、不启动任何服务。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本仓库根目录。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 旧接口名保留：历史上指向权威文档；纯净代码包不再带 docs，这里指向包元数据本身。 */
export const VOICE_DOC_REL = 'package.json';

/** 必须保留的语音入口：包脚本名 → 必须包含的本包内脚本路径。 */
const REQUIRED_SCRIPTS = [
  {
    id: 'send-voice-script',
    name: 'send-voice',
    cmdFragment: 'scripts/send-voice.mjs',
    message: '缺少 send-voice 脚本，或它没有指向本包内的 scripts/send-voice.mjs（语音发送入口不在包里）',
  },
  {
    id: 'test-voice-script',
    name: 'test-voice',
    cmdFragment: 'scripts/test-voice.mjs',
    message: '缺少 test-voice 脚本，或它没有指向本包内的 scripts/test-voice.mjs（语音核心测试不在包里）',
  },
];

/** 必须存在的语音文件（相对仓库根）：核心入口与核心测试。 */
const REQUIRED_FILES = [
  { id: 'voice-core-file', rel: path.join('scripts', 'send-voice.mjs'), message: 'scripts/send-voice.mjs 缺失或为空：语音核心不在包里' },
  { id: 'voice-test-file', rel: path.join('scripts', 'test-voice.mjs'), message: 'scripts/test-voice.mjs 缺失或为空：语音测试不在包里' },
];

/** 外置可选工具不该出现在包脚本里（键名形态）。 */
const FORBIDDEN_SCRIPT_KEYS = [
  { id: 'no-voice-gui-script', name: 'voice-gui', message: '包脚本里不得再出现 voice-gui（外置可选工具不属于本包）' },
  { id: 'no-voice-cli-script', name: 'voice-cli', message: '包脚本里不得再出现 voice-cli（外置可选工具不属于本包）' },
];

/** 包脚本命令里不该出现的外置工具名（path/命令形态都覆盖）。 */
const EXTERNAL_TOOL_NEEDLE = 'voice-tool';
const EXTERNAL_TOOL_ID = 'no-external-voice-tool';
const EXTERNAL_TOOL_MESSAGE = '包脚本仍然指向 voice-tool：外置可选语音工具不属于本代码包';

function pushCheck(checks, failures, check) {
  checks.push(check);
  if (!check.ok) failures.push({ id: check.id, message: check.message });
}

/**
 * 对 package.json 正文做断言（纯函数，不碰文件系统）。
 * @param {unknown} text package.json 文本；非字符串/坏 JSON 视为缺失。
 * @param {{ docLabel?: string }} [options]
 */
export function checkVoiceDocText(text, options = {}) {
  const docLabel = options.docLabel ?? VOICE_DOC_REL;
  const checks = [];
  const failures = [];

  let pkg = null;
  if (typeof text === 'string' && text.trim() !== '') {
    try { pkg = JSON.parse(text); } catch { pkg = null; }
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    checks.push({
      id: 'package-json',
      ok: false,
      label: `包元数据 ${docLabel} 是合法 JSON（缺失即失败，不 skip）`,
      message: `${docLabel} 缺失或不是合法 JSON —— 包契约断言不允许 skip`,
    });
    return { ok: false, docLabel, checks, failures: [{ id: 'missing-package', message: `${docLabel} 缺失或不是合法 JSON —— 包契约断言不允许 skip` }] };
  }
  pushCheck(checks, failures, { id: 'package-json', ok: true, label: `包元数据 ${docLabel} 是合法 JSON` });

  if (!pkg.scripts || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts)) {
    pushCheck(checks, failures, {
      id: 'package-scripts',
      ok: false,
      label: 'package.json 有 scripts 对象',
      message: 'package.json 缺少 scripts 对象：语音入口无从校验',
    });
    return { ok: false, docLabel, checks, failures };
  }
  const scripts = pkg.scripts;

  for (const req of REQUIRED_SCRIPTS) {
    const cmd = scripts[req.name];
    const ok = typeof cmd === 'string' && cmd.trim() !== '' && cmd.includes(req.cmdFragment);
    pushCheck(checks, failures, {
      id: req.id,
      ok,
      label: `scripts.${req.name} 存在且运行本包内的 ${req.cmdFragment}`,
      message: ok ? undefined : req.message,
    });
  }

  for (const rule of FORBIDDEN_SCRIPT_KEYS) {
    const hit = Object.prototype.hasOwnProperty.call(scripts, rule.name);
    pushCheck(checks, failures, {
      id: rule.id,
      ok: !hit,
      label: `package.json scripts 不包含 ${rule.name}（外置工具不属于本包）`,
      message: hit ? rule.message : undefined,
    });
  }

  const scriptText = JSON.stringify(scripts);
  const externalHit = scriptText.includes(EXTERNAL_TOOL_NEEDLE);
  pushCheck(checks, failures, {
    id: EXTERNAL_TOOL_ID,
    ok: !externalHit,
    label: 'package.json scripts 不指向外置 voice-tool',
    message: externalHit ? EXTERNAL_TOOL_MESSAGE : undefined,
  });

  return { ok: failures.length === 0, docLabel, checks, failures };
}

/**
 * 读取并断言某个根目录下的语音发布契约。
 * @param {string} [root] 仓库根（默认本仓库；负向回归传 os.tmpdir() 下的临时根）。
 * @param {{ docRel?: string }} [options]
 */
export function checkVoiceDoc(root = REPO_ROOT, options = {}) {
  const docRel = options.docRel ?? VOICE_DOC_REL;
  const abs = path.join(root, docRel);
  let text = null;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    text = null;
  }
  const result = checkVoiceDocText(text, { docLabel: docRel });
  const checks = [...result.checks];
  const failures = [...result.failures];

  for (const req of REQUIRED_FILES) {
    let size = 0;
    try {
      size = fs.statSync(path.join(root, req.rel)).size;
    } catch {
      size = 0;
    }
    pushCheck(checks, failures, {
      id: req.id,
      ok: size > 0,
      label: `${req.rel} 存在且非空（语音能力保留）`,
      message: size > 0 ? undefined : req.message,
    });
  }

  return { ...result, ok: failures.length === 0, checks, failures, docPath: abs };
}
