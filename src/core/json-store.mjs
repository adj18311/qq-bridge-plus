/**
 * 原子 JSON / 文本持久化工具。
 *
 * 这一层的语义与桥接中原函数**逐字一致**（含错误消息），本次只做「模块化 + 具名导出 +
 * 显式依赖」：调用方改为从本模块导入，行为不得变化。因此这里刻意不做的几件事：
 *
 *  · **导入时零 I/O**。本模块只在函数被调用时读写文件；import 本身不触碰磁盘，
 *    否则任何 import 它的测试/工具都会意外碰到生产 state/ 或 config.json。
 *  · **不改变写入格式**。`atomicWriteJson` 固定「2 空格 + LF + 末尾换行」；
 *    需要保留用户手写风格时必须走 `atomicWriteJsonKeepStyle`，两者不可互相替代。
 *  · **不吞错**。原子写失败会先清理随机名临时文件再原样抛出，由调用方决定提示方式。
 *  · **不依赖随机临时名之外的可预测路径**，避免固定临时名被并发或符号链接攻击利用。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
// required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。
export function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

/**
 * 读取 config.json，并保证拿到一个**可安全改写的普通对象**。
 *
 * 为什么不是 `readJsonSafe(file, null, true) ?? {}`：控制台这些端点都是
 * 「读整份 config → 改一个字段 → 原子写回」。JSON.parse 对字面量 `null` 是**成功**的，
 * 于是 `file` 可能是 null：`file.socialV2` 直接 TypeError（保存接口 500，且错误信息
 * 完全指不出"配置文件顶层是 null"）；而用 `?? {}` 兜底更糟 —— 回写会把整份配置替换成
 * 只含本次提交字段的新对象，用户的白名单、令牌、模式全被抹掉。
 * 所以：不是普通对象就抛错，让调用方的 try/catch 返回 500（与各端点注释里
 * "配置文件损坏时直接 500，绝不回写" 的既有约定一致）。
 */
export function readConfigObject(file) {
  const parsed = readJsonSafe(file, null, true);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed;
    throw new Error(`config.json 顶层不是对象（实际是 ${kind}），已拒绝改写以免覆盖整份配置：${file}`);
  }
  return parsed;
}

/**
 * 原子替换：`fs.renameSync` 覆盖一个「正被别人打开」的目标，在 Windows 上会抛 EPERM
 * （Defender / 编辑器 / 资源管理器预览 / 云同步都可能在这个窗口里碰它）。
 * 实测本机可复现。这里退避重试几次；实在不行才抛，让调用方决定怎么提示。
 */
export function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
      // 同步忙等一小会儿：调用点大多在启动/收尾路径，不值得为它改成异步。
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch {}
    }
  }
  throw lastError;
}

// 原子写 JSON 文件：先写唯一临时文件再 rename，避免进程中断写坏配置，也避免固定临时名被并发/符号链接攻击利用。
export function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    // 失败时别把随机名临时文件留在 state/ 里当垃圾。
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 原子写文本文件。
export function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

/** 本地时间戳 YYYYMMDDTHHMMSS —— 与仓库既有的 config.json.bak-switch-…/bak-tui-… 命名同源。 */
export function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 备份名撞车（同一秒内两次调用）时加 -2、-3…，绝不覆盖已有备份。 */
export function uniqueBackupPath(base) {
  if (!fs.existsSync(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`备份名冲突太多：${base}`);
}

/**
 * 原子写 JSON，并保持目标文件**原有的书写风格**（BOM / 缩进 / 换行符 / 末尾换行）。
 *
 * config.json 是用户手写 + 控制台/脚本共同维护的文件：一次模型档位热切换不该顺手改掉它的
 * 缩进、换行符或 BOM（否则编辑器与 git diff 会哗啦一片）。本仓库现状是「无 BOM + 2 空格 + LF +
 * 末尾换行」，正好与 atomicWriteJson 的固定格式一致 —— 那种情况直接复用它；只有风格不同才走
 * 这里的自定义序列化（含"整份配置本来就是单行紧凑写法"这种）。两条路径都是
 * 「唯一临时文件 + rename」，可靠性一致。返回探测到的风格，供调用方在响应/日志里回显。
 */
export function atomicWriteJsonKeepStyle(file, obj) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch {}
  const bom = raw.charCodeAt(0) === 0xfeff;
  const text = bom ? raw.slice(1) : raw;
  const indentMatch = /^([ \t]+)"/m.exec(text);
  const indent = indentMatch ? indentMatch[1] : '  ';
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const trailingNewline = text === '' ? true : text.endsWith('\n');
  const style = { bom, indent, eol, trailingNewline };
  // 单行（紧凑）写法：整份配置本来就没有换行 —— 那就别给它"展开"成多行，保持原样。
  const compact = text.trim() !== '' && !text.includes('\n');
  if (!compact && !bom && indent === '  ' && eol === '\n' && trailingNewline) {
    atomicWriteJson(file, obj);
    return style;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let out = compact ? JSON.stringify(obj) : JSON.stringify(obj, null, indent);
  if (!compact && eol !== '\n') out = out.split('\n').join(eol);
  if (trailingNewline) out += eol;
  if (bom) out = `\ufeff${out}`;
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, out, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  return style;
}
