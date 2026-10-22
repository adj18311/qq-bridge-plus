/**
 * 人格卡仓库：`roles/<名称>.md` 的命名校验、文件读写、列表与摘要。
 *
 * 边界与安全约束：
 *  · 本模块不拥有「运行期人格注入」逻辑；注入上限始终由调用方持有，模块每次通过
 *    `getInjectLimit()` 读取当前值，不在工厂创建时复制可变全局。默认 6000。
 *  · 人格名会直接拼进文件路径，因此写入/删除等入口必须先经过 `validateRoleName()`。
 *    `sanitizeRoleName()` 只保留中文 / 字母 / 数字 / 下划线 / 横线，路径分隔符、
 *    点号等都会被剥掉；保留名与 Windows 设备名（`CON`、`COM1`…）直接拒绝，
 *    避免 `roles/CON.md` 这类路径被系统当作设备而不是普通文件。
 *  · 工厂只保存参数，不读目录、不建目录；所有 I/O 都发生在返回的方法被调用时。
 *  · 内容写盘复用 `json-store` 的原子写（唯一临时名 + rename），调用方仍需先跑
 *    `validateRoleContent()`，本模块不额外放宽或收紧长度/字符规则。
 */
import fs from 'node:fs';
import path from 'node:path';
import { GEN1_ROLE_LINE_RE, parseRoleSections, roleCharStats } from '../role-card.js';
import { atomicWriteText } from './json-store.mjs';

export const ROLE_NAME_MAX = 40;
export const ROLE_CONTENT_MAX_BYTES = 64 * 1024;
export const ROLE_INJECT_MAX_CHARS_DEFAULT = 6000;

// README 是人格目录的说明文件，不是人格卡；按原名精确排除（大小写敏感，与历史行为一致）。
const ROLE_RESERVED_NAMES = new Set(['README']);
// Windows 保留设备名：roles/CON.md 这类路径会被系统当成设备而不是文件，
// 写入会失败甚至挂起，因此在人格名层面直接拒绝。
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/**
 * 从用户输入里剥掉文件名不允许的字符。
 *
 * 注意：这是「清理」而不是「校验」——清理后可能变成空串，也可能与已有名称撞车。
 * 写入/读取入口必须继续调用 `validateRoleName()` 做非空、长度、保留名检查。
 */
export function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

/**
 * 创建一个绑定到指定人格目录的仓库。
 *
 * @param {object} options
 * @param {string} options.rolesDir 人格目录（由调用方决定，工厂不探测生产目录）。
 * @param {() => number} [options.getInjectLimit] 读取当前运行期注入字符上限；
 *   每次 `roleWarnings` / `roleSummaries` 调用都会重新读取，不缓存。
 */
export function createRoleStore({ rolesDir, getInjectLimit } = {}) {
  if (typeof rolesDir !== 'string' || rolesDir === '') {
    throw new TypeError('createRoleStore 需要 rolesDir');
  }
  const dir = rolesDir;

  /**
   * 默认上限只在未注入 getter 时使用；范围校正（1000~20000）仍由桥接的
   * `applyRoleInjectLimit()` 负责，这里不复制那份策略。仅挡掉非有限值，
   * 避免 `NaN` 污染摘要字段。
   */
  const readInjectLimit = () => {
    if (typeof getInjectLimit !== 'function') return ROLE_INJECT_MAX_CHARS_DEFAULT;
    const value = Number(getInjectLimit());
    return Number.isFinite(value) ? value : ROLE_INJECT_MAX_CHARS_DEFAULT;
  };

  function roleFilePath(name) {
    return path.join(dir, name + '.md');
  }

  function listRoles() {
    try {
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.md') && f !== 'README.md')
        .map((f) => f.slice(0, -3))
        .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    } catch {
      return [];
    }
  }

  function firstMeaningfulLine(content) {
    for (const line of String(content ?? '').split('\n')) {
      const t = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
      if (t) return t.slice(0, 80);
    }
    return '';
  }

  function buildRoleWarnings(content, mode, injectLimit) {
    const text = String(content ?? '');
    const warnings = [];
    const stats = roleCharStats(text);
    const injected = mode === 'v1' ? stats.v1 : stats.v2;
    if (injected > injectLimit) {
      warnings.push(`超出注入上限：当前模式实际注入 ${injected} 字符，只有前 ${injectLimit} 字符会进入提示词（可在配置里调 role.maxInjectChars）`);
    }
    // 只在「没有用模式标记分开」的小节上提示兜底过滤，避免对已正确标记的卡片误报。
    const untagged = parseRoleSections(text)
      .filter((section) => section.mode === 'all')
      .map((section) => section.lines.join('\n'))
      .join('\n');
    if (GEN1_ROLE_LINE_RE.test(untagged)) {
      warnings.push('未标记的小节里含一代仿真专用指令（[SILENT] / 空格分句 / 自动转发…），二代下这些行会被兜底过滤——建议把它们移到带 〔一代〕 标记的小节里');
    }
    if (/回复示例/.test(untagged) && /[\u4e00-\u9fff]\s+[\u4e00-\u9fff]/.test(untagged)) {
      warnings.push('“回复示例”节里的中文空格会被自动改写成逗号（二代不用空格分条），建议直接写逗号，或把该节标记为 〔一代〕');
    }
    return warnings;
  }

  function roleWarnings(content, mode = 'v2') {
    return buildRoleWarnings(content, mode, readInjectLimit());
  }

  function roleSummaries() {
    return listRoles().map((name) => {
      const file = roleFilePath(name);
      const injectLimit = readInjectLimit();
      try {
        const stat = fs.statSync(file);
        const content = fs.readFileSync(file, 'utf8');
        const stats = roleCharStats(content);
        return {
          name,
          bytes: stat.size,
          chars: content.length,
          lines: content.split('\n').length,
          mtime: stat.mtimeMs,
          excerpt: firstMeaningfulLine(content),
          // 两种模式各自实际会注入多少（已按 〔一代〕/〔二代〕 标记筛过）
          injectedV1: Math.min(stats.v1, injectLimit),
          injectedV2: Math.min(stats.v2, injectLimit),
          charsV1: stats.v1,
          charsV2: stats.v2,
          hasModeTags: stats.v1Only > 0 || stats.v2Only > 0,
          truncated: stats.v1 > injectLimit || stats.v2 > injectLimit,
          warnings: buildRoleWarnings(content, 'v2', injectLimit).length,
        };
      } catch {
        return { name, bytes: 0, chars: 0, lines: 0, mtime: 0, excerpt: '', injectedV1: 0, injectedV2: 0, charsV1: 0, charsV2: 0, hasModeTags: false, truncated: false, warnings: 0 };
      }
    });
  }

  function validateRoleName(raw) {
    const name = sanitizeRoleName(raw);
    if (!name) throw new Error('人格名不能为空（仅限中文 / 字母 / 数字 / 横线）');
    if (name.length > ROLE_NAME_MAX) throw new Error(`人格名过长（最多 ${ROLE_NAME_MAX} 字）`);
    if (ROLE_RESERVED_NAMES.has(name)) throw new Error(`「${name}」是保留名称`);
    if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) throw new Error(`「${name}」是系统保留名称（Windows 设备名），请换一个`);
    return name;
  }

  function validateRoleContent(raw) {
    const content = String(raw ?? '').replace(/\r\n/g, '\n').trim();
    if (!content) throw new Error('人格内容不能为空');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > ROLE_CONTENT_MAX_BYTES) {
      throw new Error(`人格内容过长（${(bytes / 1024).toFixed(1)} KB，上限 ${ROLE_CONTENT_MAX_BYTES / 1024} KB）`);
    }
    return content;
  }

  function readRoleContent(name) {
    return fs.readFileSync(roleFilePath(name), 'utf8');
  }

  function writeRoleContent(name, content) {
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteText(roleFilePath(name), content + (content.endsWith('\n') ? '' : '\n'));
  }

  return {
    listRoles,
    roleFilePath,
    firstMeaningfulLine,
    roleWarnings,
    roleSummaries,
    validateRoleName,
    validateRoleContent,
    readRoleContent,
    writeRoleContent,
  };
}
