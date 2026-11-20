/**
 * Fish Diary 日记存储核心模块。
 *
 * 职责边界（照任务书）：路径白名单（fail-closed）→ 编码/BOM 识别与保持 → 行边界分页读 →
 * 原子写（临时文件 + fsync + rename，Windows 退避重试）→ 每北京日每文件写入计数。
 *
 * 刻意做的事与不做的：
 *  · **导入零 I/O**：import 阶段不建目录、不读文件、不碰 state/。
 *  · **全部走可注入的 fs**：任何文件操作都经 `options.fs`，便于测试打桩（EPERM/EBUSY 注入）。
 *  · **先校验后落盘**：所有可失败的检查（which/path/mode/text/载荷/总量/日额/计数可写）
 *    都在日记文件被改动之前完成；日记写失败会回滚计数，调用方不会拿到「报错但文件已改」。
 *  · **绝不伪装错误码**：业务错误一律自带 code（见 ERROR CODES），不复用 Node 原生 ENOENT 之类。
 */
import fsDefault from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DIARY_FILES = Object.freeze({
  notebook: 'Fish Diary Notebook.txt',
  privy: 'Fish Privy Diary Notebook.txt',
});

export const DEFAULT_LIMITS = Object.freeze({
  maxLines: 500,
  maxReadBytes: 65536,
  // 这是存储层自身的兜底上限；生产路径上每一次调用都由 src/bridge.js 的 diary 端点
  // 显式传入 config 层的 maxPayloadBytes（= DIARY_HTTP_MAX_BODY_BYTES）把它覆盖掉。
  // 两者描述同一个语义量（单次写入字节上限），之所以不构成「两套限额打架」的活缺陷，
  // 靠的正是「端点必然覆盖」这一点，而不是两个数字恰好相等。
  maxPayloadBytes: 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
  dailyWrites: 10,
  backupKeep: 10,
  usageRetentionDays: 7,
});

const DIARY_DIR_NAME = 'Fish Diary';
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

// 用 Symbol 打标：既能稳定识别「已归一化的 diary 错误」，又不会混进
// JSON.stringify / 展开拷贝（控制台与端点的错误体只看 code，不会被污染）。
const DIARY_ERROR_MARK = Symbol('diaryError');

function diaryError(code, message, extra) {
  const error = new Error(message);
  error.code = code;
  error[DIARY_ERROR_MARK] = true;
  if (extra && typeof extra === 'object') Object.assign(error, extra);
  return error;
}

function isDiaryError(error) {
  return Boolean(error) && error[DIARY_ERROR_MARK] === true;
}

function sleepSync(ms) {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* spin */ }
  }
}

function isWin32() {
  return process.platform === 'win32';
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return isWin32() ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function realpathOf(fsLike, target) {
  const fn = fsLike.realpathSync;
  if (typeof fn !== 'function') throw diaryError('bad-root', `fs 替身缺少 realpathSync：${target}`);
  if (typeof fn.native === 'function') return fn.native(target);
  return fn(target);
}

function readBufOrNull(fsLike, file) {
  try {
    return fsLike.readFileSync(file);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

function lstatOrNull(fsLike, target) {
  try {
    return fsLike.lstatSync(target);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

// TOCTOU 收口点：校验「已经打开的 fd」而不是「打开前的路径」。
// 只检查 isFile/nlink 是不够的 —— 符号链接或父目录 junction 会让 open 直接落到外部 inode，
// 而那个 inode 照样 isFile() 且 nlink===1。所以必须把「校验时看到的 inode」和
// 「实际打开的 inode」绑定起来：dev/ino 必须逐字相同。
function verifyOpenHandle(fsLike, fd, canonical, label, expectedId) {
  if (typeof fsLike.fstatSync !== 'function') {
    // fail-closed：拿不到 fstat 就无法证明打开的就是校验过的那个 inode。
    throw diaryError('path-escape', `${label}：fs 实现不提供 fstatSync，无法完成 inode 复核：${canonical}`);
  }
  let stat = null;
  try {
    stat = fsLike.fstatSync(fd);
  } catch {
    throw diaryError('path-escape', `${label}：打开后无法 fstat，拒绝使用：${canonical}`);
  }
  if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) {
    throw diaryError('path-escape', `${label}：打开后不是普通文件：${canonical}`);
  }
  const nlink = Number(stat.nlink);
  if (Number.isFinite(nlink) && nlink > 1) {
    throw diaryError('path-escape', `${label}：打开后存在多个硬链接（nlink=${nlink}），疑似指向日记目录之外：${canonical}`);
  }
  if (expectedId) {
    const devOk = Number(stat.dev) === Number(expectedId.dev);
    const inoOk = Number(stat.ino) === Number(expectedId.ino);
    if (!devOk || !inoOk) {
      throw diaryError(
        'path-escape',
        `${label}：打开后的 inode 与校验时不一致（可能是符号链接/junction 被中途替换）：${canonical}`,
      );
    }
  }
  // 最后一道：路径此刻指向的 inode 必须就是已打开的这个 fd。
  // 符号链接会在这里露馅 —— open 跟随链接落到外部文件，而 lstat 看到的是链接本身。
  const pathStat = lstatOrNull(fsLike, canonical);
  if (!pathStat) throw diaryError('path-escape', `${label}：路径在打开后消失：${canonical}`);
  if (pathStat.isSymbolicLink()) {
    throw diaryError('path-escape', `${label}：路径已被换成符号链接：${canonical}`);
  }
  if (Number(pathStat.dev) !== Number(stat.dev) || Number(pathStat.ino) !== Number(stat.ino)) {
    throw diaryError('path-escape', `${label}：路径与已打开的 fd 不是同一个 inode：${canonical}`);
  }
  return stat;
}

// 按 fd 读取日记文件：打开 → fd 级复核 → 读，全程只读，绝不在校验后按路径重新读。
function readDiaryBufOrNull(fsLike, file, expectedId) {
  let fd = null;
  try {
    fd = fsLike.openSync(file, 'r');
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
  try {
    verifyOpenHandle(fsLike, fd, file, '日记文件（read）', expectedId);
    return fsLike.readFileSync(fd);
  } finally {
    try { fsLike.closeSync(fd); } catch { /* ignore */ }
  }
}

function renameWithRetry(fsLike, from, to, guard) {
  let last = null;
  for (let attempt = 0; attempt <= 4; attempt += 1) {
    // 每次尝试前都复核父目录身份：rename 的重试退避（1/2/4/8ms）同样是可被利用的窗口，
    // 只在第一次之前查一次等于给后面几次开后门。
    if (guard) verifyDirIdentity(fsLike, guard.dir, guard.expectedDirId, `rename 前（第 ${attempt + 1} 次）`);
    try {
      fsLike.renameSync(from, to);
      return attempt + 1;
    } catch (error) {
      last = error;
      if (!error || !RETRYABLE_RENAME_CODES.has(error.code)) throw error;
      if (attempt === 4) break;
      sleepSync(2 ** attempt);
    }
  }
  throw last ?? diaryError('busy', `rename 重试耗尽：${to}`);
}

// O_CREAT 在「校验后被换走的目录」里会凭空建出一个 0 字节文件（无内容泄漏，但外部被留了垃圾）。
// 尽力回收：只有 fd 此刻确实是空文件时才删，绝不误删外部已有内容。
function removeIfEmptyCreated(fsLike, fd, file) {
  try {
    if (typeof fsLike.fstatSync !== 'function') return;
    const stat = fsLike.fstatSync(fd);
    if (!stat || Number(stat.size) !== 0) return;
    fsLike.unlinkSync(file);
  } catch {
    /* best-effort：回收失败不影响「这次写入被拒绝」的结论 */
  }
}

// 目录身份复核：父目录被换成 junction/符号链接时，open/create 会直接落到外部目录，
// 所以在真正落盘前用 dev/ino 再确认一次「还是校验过的那个目录」。
function verifyDirIdentity(fsLike, dir, expectedDirId, label) {
  if (!expectedDirId) return;
  const stat = lstatOrNull(fsLike, dir);
  if (!stat) throw diaryError('path-escape', `${label}：目录不存在：${dir}`);
  if (stat.isSymbolicLink() || (typeof stat.isDirectory === 'function' && !stat.isDirectory())) {
    throw diaryError('path-escape', `${label}：目录已被替换（符号链接/junction/非目录）：${dir}`);
  }
  const devOk = Number(stat.dev) === Number(expectedDirId.dev);
  const inoOk = Number(stat.ino) === Number(expectedDirId.ino);
  if (!devOk || !inoOk) throw diaryError('path-escape', `${label}：目录 inode 与校验时不一致：${dir}`);
}

// ensureDir 之后现场取目录身份：首次写入时目录还不存在、dirId 为 null，
// 「null 就跳过校验」等于放行 —— 必须当场 lstat 拿真实身份并拒绝 reparse point。
function dirIdentityAfterEnsure(fsLike, target) {
  try {
    fsLike.mkdirSync(target, { recursive: true });
  } catch (error) {
    if (!error || (error.code !== 'EEXIST' && error.code !== 'EISDIR')) throw error;
  }
  const stat = lstatOrNull(fsLike, target);
  if (!stat) throw diaryError('path-escape', `目录不存在或无法 lstat：${target}`);
  if (stat.isSymbolicLink() || (typeof stat.isDirectory === 'function' && !stat.isDirectory())) {
    throw diaryError('path-escape', `目录不是普通目录（符号链接/junction/非目录）：${target}`);
  }
  return { dev: Number(stat.dev), ino: Number(stat.ino) };
}

// 临时文件 + fsync + rename：要么整份新内容、要么保持旧内容，且失败不留 .tmp。
function atomicWriteFile(fsLike, file, buf, expectedDirId) {
  const dir = path.dirname(file);
  verifyDirIdentity(fsLike, dir, expectedDirId, '写临时文件前');
  const tmp = path.join(dir, `${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fsLike.openSync(tmp, 'w', 0o644);
    // tmp 也可能被换过：fd 必须就是该临时路径此刻指向的 inode，且父目录身份未变。
    if (typeof fsLike.fstatSync !== 'function') {
      throw diaryError('path-escape', 'fs 实现不提供 fstatSync，无法复核临时文件');
    }
    const fdStat = fsLike.fstatSync(fd);
    const tmpStat = lstatOrNull(fsLike, tmp);
    if (!tmpStat) throw diaryError('path-escape', `临时文件打开后消失：${tmp}`);
    if (tmpStat.isSymbolicLink()
      || Number(tmpStat.dev) !== Number(fdStat.dev)
      || Number(tmpStat.ino) !== Number(fdStat.ino)) {
      throw diaryError('path-escape', `临时路径与已打开的 fd 不是同一个 inode：${tmp}`);
    }
    verifyDirIdentity(fsLike, dir, expectedDirId, '写临时文件后');
    fsLike.writeSync(fd, buf, 0, buf.length, 0);
    fsLike.fsyncSync(fd);
  } catch (error) {
    try { if (fd !== null) fsLike.closeSync(fd); } catch { /* ignore */ }
    fd = null;
    try { fsLike.unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  } finally {
    try { if (fd !== null) fsLike.closeSync(fd); } catch { /* ignore */ }
  }
  try {
    verifyDirIdentity(fsLike, dir, expectedDirId, 'rename 前');
    renameWithRetry(fsLike, tmp, file, { dir, expectedDirId });
  } catch (error) {
    try { fsLike.unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
}

// BOM 只认**文件头**三个字节序列；正文里的 U+FEFF 由解码后的文本自己带，不会被误判。
function detectEncoding(buf) {
  if (!buf || buf.length === 0) return { encoding: 'utf-8', bomLength: 0 };
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { encoding: 'utf-8', bomLength: 3 };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { encoding: 'utf-16le', bomLength: 2 };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { encoding: 'utf-16be', bomLength: 2 };
  return { encoding: 'utf-8', bomLength: 0 };
}

function swapBytes(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const t = out[i];
    out[i] = out[i + 1];
    out[i + 1] = t;
  }
  return out;
}

function decodeBody(buf, encoding, bomLength) {
  const body = buf.subarray(bomLength);
  if (encoding === 'utf-16le') return body.toString('utf16le');
  if (encoding === 'utf-16be') return swapBytes(body).toString('utf16le');
  return body.toString('utf8');
}

function encodeBody(text, encoding, withBom) {
  if (encoding === 'utf-16le') {
    const body = Buffer.from(text, 'utf16le');
    return withBom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
  }
  if (encoding === 'utf-16be') {
    const body = swapBytes(Buffer.from(text, 'utf16le'));
    return withBom ? Buffer.concat([Buffer.from([0xfe, 0xff]), body]) : body;
  }
  const body = Buffer.from(text, 'utf8');
  return withBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

function byteLengthOf(text, encoding) {
  return encoding === 'utf-8' ? Buffer.byteLength(text, 'utf8') : text.length * 2;
}

function sha256OfText(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function sha256OfBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// 备份文件名里的时间戳：北京时间的 yyyyMMdd-HHmmss-SSS（按文件名排序即时间序）。
function beijingStamp(nowMs) {
  const shifted = new Date(Number(nowMs) + 8 * 3600 * 1000);
  if (Number.isNaN(shifted.getTime())) throw diaryError('bad-root', `now() 返回了非法时间：${String(nowMs)}`);
  const iso = shifted.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}-${iso.slice(20, 23)}`;
}

// 把文本切成「行内容 + 该行的换行符」：只保留真实存在的行（"a\r\n" → 1 行），
// 与 read/snapshot 的 lineCount 口径一致；末行的 eol 可能是空串（文件末尾没有换行）。
function splitEditableLines(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      const width = text.charCodeAt(i + 1) === 10 ? 2 : 1;
      out.push({ text: text.slice(start, i), eol: width === 2 ? '\r\n' : '\n' });
      i += width - 1;
      start = i + 1;
    } else if (c === 10) {
      out.push({ text: text.slice(start, i), eol: '\n' });
      start = i + 1;
    }
  }
  if (start < text.length) out.push({ text: text.slice(start), eol: '' });
  return out;
}

function endsWithEol(text) {
  if (text.length === 0) return false;
  const last = text.charCodeAt(text.length - 1);
  return last === 10 || last === 13;
}

// 把一个编辑块切成若干行；末尾那个换行不算多出一行（"a\nb\n" → ['a','b']）。
function textToLines(text) {
  const pieces = text.split(/\r\n|\r|\n/);
  if (pieces.length > 1 && pieces[pieces.length - 1] === '') pieces.pop();
  return pieces;
}

// 按行拼回文本：行间用该行自己的 eol（缺失时用文件主 eol）；
// trailing 表示原文件末尾本来就有换行，此时末行也要补 eol。
function joinEditableLines(lines, eolText, trailing) {
  let out = '';
  for (let i = 0; i < lines.length; i += 1) {
    out += lines[i].text;
    const isLast = i === lines.length - 1;
    if (!isLast) out += lines[i].eol || eolText;
    else if (trailing) out += lines[i].eol || eolText;
  }
  return out;
}

// 现场投票：CRLF 多就 CRLF，否则 LF；没有任何换行时按「新建文件」的 CRLF 兜底。
function detectEol(text, fallback) {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) { crlf += 1; i += 1; } else lf += 1;
    } else if (c === 10) lf += 1;
  }
  if (crlf === 0 && lf === 0) return fallback ?? 'CRLF';
  return crlf > lf ? 'CRLF' : 'LF';
}

function splitLines(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      const width = text.charCodeAt(i + 1) === 10 ? 2 : 1;
      lines.push({ start, end: i, eolLength: width });
      i += width - 1;
      start = i + 1;
    } else if (c === 10) {
      lines.push({ start, end: i, eolLength: 1 });
      start = i + 1;
    }
  }
  if (start < text.length) lines.push({ start, end: text.length, eolLength: 0 });
  return lines;
}

// 逐行累计字节起点，一次线性扫描（避免大文件上 O(n^2) 的按前缀求字节长度）。
function buildLineIndex(text, encoding) {
  const unit = encoding === 'utf-8' ? 1 : 2;
  const lines = splitLines(text);
  const byteStarts = new Array(lines.length);
  const byteEnds = new Array(lines.length);
  let cursor = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    byteStarts[i] = cursor;
    const contentBytes = byteLengthOf(text.slice(line.start, line.end), encoding);
    byteEnds[i] = cursor + contentBytes;
    cursor = byteEnds[i] + line.eolLength * unit;
  }
  return { lines, byteStarts, byteEnds, totalBytes: cursor };
}

function normalizePayload(text, eol) {
  const target = eol === 'CRLF' ? '\r\n' : '\n';
  return text.replace(/\r\n|\r|\n/g, target);
}

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const t = Math.trunc(n);
  return Math.min(Math.max(t, min), max);
}

// 从 offset 起把整行纳入：offset 落在行中间 → 向后对齐到下一行开头。
function findStartLine(index, offset) {
  if (index.lines.length === 0) return -1;
  const starts = index.byteStarts;
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] >= offset) { found = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return found;
}

// 北京自然日：UTC+8 取日期，形如 2026-10-31。
function beijingDayKey(nowMs) {
  const shifted = new Date(Number(nowMs) + 8 * 3600 * 1000);
  if (Number.isNaN(shifted.getTime())) throw diaryError('bad-root', `now() 返回了非法时间：${String(nowMs)}`);
  return shifted.toISOString().slice(0, 10);
}

// 返回 { corrupt:true } 或 { days:{ [day]: { notebook, privy } } }；任何异常都 fail-closed。
function readUsage(fsLike, usageFile) {
  let raw;
  try {
    raw = fsLike.readFileSync(usageFile, 'utf8');
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { days: {}, exists: false };
    // 文件明明在却读不进去（EACCES/EMFILE/EBUSY…）不是「内容损坏」，
    // 别把它伪装成 daily-write-limit：写入照样被拒（fail-closed），但给出可排障的真实码。
    throw diaryError('usage-unreadable', `计数文件无法读取：${usageFile}`, { ioCode: (error && error.code) || null });
  }
  let text = String(raw);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { corrupt: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { corrupt: true };
  if (parsed.schemaVersion !== 1) return { corrupt: true };
  const days = parsed.days;
  if (!days || typeof days !== 'object' || Array.isArray(days)) return { corrupt: true };
  const clean = {};
  for (const [day, counts] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { corrupt: true };
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return { corrupt: true };
    const entry = { notebook: 0, privy: 0 };
    for (const [key, value] of Object.entries(counts)) {
      if (key !== 'notebook' && key !== 'privy') continue;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) return { corrupt: true };
      entry[key] = n;
    }
    clean[day] = entry;
  }
  return { days: clean, exists: true };
}

function bumpUsage(usage, which, day, limits) {
  const days = { ...usage.days };
  const current = days[day] ?? { notebook: 0, privy: 0 };
  days[day] = { notebook: Number(current.notebook) || 0, privy: Number(current.privy) || 0 };
  days[day][which] = (days[day][which] ?? 0) + 1;
  const keep = Math.max(1, Number(limits.usageRetentionDays) || DEFAULT_LIMITS.usageRetentionDays);
  const ordered = Object.keys(days).sort().reverse().slice(0, keep);
  const pruned = {};
  for (const key of ordered) pruned[key] = days[key];
  return { schemaVersion: 1, days: pruned };
}

export function createDiaryStore(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const fsLike = opts.fs ?? fsDefault;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const root = opts.root ?? process.cwd();
  const rootText = typeof root === 'string' ? root : String(root);
  const limits = Object.freeze({
    ...DEFAULT_LIMITS,
    ...(opts.limits && typeof opts.limits === 'object' ? opts.limits : {}),
  });
  const inFlight = new Set();

  let usageFile = null;
  try {
    if (opts.usageFile !== undefined && opts.usageFile !== null) {
      if (typeof opts.usageFile !== 'string' || opts.usageFile.length === 0 || opts.usageFile.includes('\0')) {
        usageFile = null;
      } else {
        usageFile = path.resolve(opts.usageFile);
      }
    } else {
      usageFile = path.resolve(rootText, 'state', 'diary-usage.json');
    }
  } catch {
    usageFile = null;
  }
  const usagePath = usageFile;

  function usageTarget() {
    if (!usagePath) throw diaryError('bad-path', 'usageFile 非法（空串 / NUL / 无法解析）');
    return usagePath;
  }

  function resolveRootReal() {
    if (typeof root !== 'string' || root.length === 0) throw diaryError('bad-root', 'root 必须是非空字符串路径');
    if (root.includes('\0')) throw diaryError('bad-path', 'root 不得包含 NUL 字节');
    const absolute = path.resolve(root);
    let real;
    try {
      real = realpathOf(fsLike, absolute);
    } catch {
      throw diaryError('bad-root', `root 不存在或无法解析：${absolute}`);
    }
    let stat = null;
    try {
      stat = fsLike.statSync(real);
    } catch {
      throw diaryError('bad-root', `root 无法 stat：${absolute}`);
    }
    if (!stat || typeof stat.isDirectory !== 'function' || !stat.isDirectory()) {
      throw diaryError('bad-root', `root 不是目录：${absolute}`);
    }
    return real;
  }

  function fileNameOf(which) {
    if (typeof which !== 'string') throw diaryError('bad-which', 'which 必须是字符串');
    if (which.length === 0) throw diaryError('bad-which', 'which 不得为空');
    if (which.includes('\0')) throw diaryError('bad-which', 'which 不得包含 NUL 字节');
    if (which !== 'notebook' && which !== 'privy') throw diaryError('bad-which', `which 只能是 notebook/privy，收到：${which}`);
    return DIARY_FILES[which];
  }

  // 白名单校验：全部满足才返回规范路径；任何一条不满足立刻抛错，且全程只读不写盘。
  function resolvePath(which) {
    const fileName = fileNameOf(which);
    const real = resolveRootReal();
    const canonical = real + path.sep + DIARY_DIR_NAME + path.sep + fileName;
    const dirPath = path.join(real, DIARY_DIR_NAME);

    const dirStat = lstatOrNull(fsLike, dirPath);
    if (dirStat && (dirStat.isSymbolicLink() || typeof dirStat.isDirectory !== 'function' || !dirStat.isDirectory())) {
      throw diaryError('path-escape', `Fish Diary 目录不是普通目录（符号链接/junction/非目录）：${dirPath}`);
    }

    let resolved;
    try {
      resolved = path.resolve(real, DIARY_DIR_NAME, fileName);
    } catch {
      throw diaryError('bad-path', `无法解析日记文件规范路径：${fileName}`);
    }
    if (!samePath(resolved, canonical)) throw diaryError('path-escape', `日记路径越界：${resolved}`);

    const fileStat = lstatOrNull(fsLike, resolved);
    if (fileStat) {
      if (fileStat.isSymbolicLink() || typeof fileStat.isFile !== 'function' || !fileStat.isFile()) {
        throw diaryError('path-escape', `日记文件不是普通文件（符号链接/目录/设备）：${resolved}`);
      }
      // 硬链接防护：nlink>1 说明这个 inode 还被目录外的名字引用，
      // lstat/realpath 都看不出异常，但写入会同时改到外面那个文件（逃逸 + 泄漏）。
      const nlink = Number(fileStat.nlink);
      if (Number.isFinite(nlink) && nlink > 1) {
        throw diaryError('path-escape', `日记文件存在多个硬链接（nlink=${nlink}），疑似指向日记目录之外：${resolved}`);
      }
      let fileReal;
      try {
        fileReal = realpathOf(fsLike, resolved);
      } catch {
        throw diaryError('path-escape', `日记文件 realpath 失败：${resolved}`);
      }
      if (!samePath(fileReal, canonical)) throw diaryError('path-escape', `日记文件 realpath 越界：${fileReal}`);
    }
    // 把「校验时看到的 inode 身份」带到 open 之后：只比路径无法证明打开的是同一个 inode。
    const idOf = (stat) => (stat ? { dev: Number(stat.dev), ino: Number(stat.ino) } : null);
    return { file: canonical, dir: path.dirname(canonical), fileId: idOf(fileStat), dirId: idOf(dirStat) };
  }

  function resolve(which) {
    return resolvePath(which).file;
  }

  function ensureDir(target) {
    try {
      fsLike.mkdirSync(target, { recursive: true });
    } catch (error) {
      if (!error || (error.code !== 'EEXIST' && error.code !== 'EISDIR')) throw error;
    }
  }

  function derivedEol(text) {
    return detectEol(text, 'CRLF');
  }

  // ── 备份（方案 C：控制台只给元数据，永远读不到内容）────────────────────────
  // 备份落在 <root>/state/diary-backups/<which>/，文件名自带「北京时间-类型-sha8」，
  // 不另设 manifest：少一个可损坏的状态文件，prune/列表都能直接扫目录得出。
  const backupRoot = (() => {
    if (opts.backup === false) return null;
    if (opts.backup && typeof opts.backup === 'object' && opts.backup.enabled === false) return null;
    const configured = opts.backup && typeof opts.backup.dir === 'string' ? opts.backup.dir : null;
    try {
      return path.resolve(configured ?? path.resolve(rootText, 'state', 'diary-backups'));
    } catch {
      return null;
    }
  })();
  const BACKUP_ID_RE = /^(\d{8}-\d{6}-\d{3})-(overwrite|edit|delete|restore)-([0-9a-f]{8})\.bak$/;

  function backupDirOf(which) {
    if (!backupRoot) throw diaryError('backup-failed', '备份已关闭或备份目录不可用');
    return path.join(backupRoot, which);
  }

  function parseBackupId(id) {
    if (typeof id !== 'string' || !BACKUP_ID_RE.test(id)) {
      throw diaryError('bad-backup-id', `备份 id 非法（只接受 listBackups 返回的 id）：${String(id)}`);
    }
    return id;
  }

  function listBackups(which) {
    fileNameOf(which);
    if (!backupRoot) return [];
    const dir = backupDirOf(which);
    let names = [];
    try {
      names = fsLike.readdirSync(dir);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return [];
      throw backupUnavailable('读取备份列表失败', error);
    }
    const out = [];
    for (const name of names) {
      const text = String(name);
      const matched = BACKUP_ID_RE.exec(text);
      if (!matched) continue;
      let stat = null;
      try { stat = fsLike.statSync(path.join(dir, text)); } catch { continue; }
      if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) continue;
      out.push({ id: text, at: Number(stat.mtimeMs), bytes: Number(stat.size), kind: matched[2], sha256: matched[3] });
    }
    out.sort((a, b) => (b.at - a.at) || (a.id < b.id ? 1 : -1));
    return out;
  }

  function pruneBackups(which) {
    const keep = Math.max(1, Math.trunc(Number(limits.backupKeep) || DEFAULT_LIMITS.backupKeep));
    const entries = listBackups(which);
    let removed = 0;
    for (const entry of entries.slice(keep)) {
      try {
        fsLike.unlinkSync(path.join(backupDirOf(which), entry.id));
        removed += 1;
      } catch { /* best-effort：清理失败不影响本次写入 */ }
    }
    return { kept: entries.length - removed, removed };
  }

  // 备份目录不可用（父级被普通文件占位 → 原生 ENOTDIR、权限 EACCES、只读 EROFS…）
  // 必须归一成稳定的 diary 错误码：原生 code 会原样漏到端点的错误体里，
  // 让调用方无法区分「备份失败」与其它意外。已归一化的错误原样上抛。
  function backupUnavailable(what, error) {
    if (isDiaryError(error)) return error;
    return diaryError('backup-failed', `${what}：${error?.message ?? error}`, {
      ioCode: typeof error?.code === 'string' ? error.code : undefined,
    });
  }

  function openBackupDir(which, label, what) {
    const dir = backupDirOf(which);
    try {
      const dirId = dirIdentityAfterEnsure(fsLike, dir);
      verifyDirIdentity(fsLike, dir, dirId, label);
      return { dir, dirId };
    } catch (error) {
      throw backupUnavailable(what, error);
    }
  }

  function writeBackup(which, buf, kind) {
    if (!backupRoot) return null;
    if (!buf || buf.length === 0) return null; // 空文件没什么可备份
    // 目录身份校验也在 try 内：备份没成功就绝不写正式文件（任务卡 §5）。
    const { dir, dirId } = openBackupDir(which, '写备份前', '备份目录不可用，已放弃本次写入');
    const id = `${beijingStamp(now())}-${kind}-${sha256OfBuffer(buf).slice(0, 8)}.bak`;
    try {
      atomicWriteFile(fsLike, path.join(dir, id), buf, dirId);
    } catch (error) {
      throw backupUnavailable('备份失败，已放弃本次写入', error);
    }
    // 备份已经落盘，清理旧份只是收尾：清理阶段出问题不该把成功的备份变成失败的写入
    // （pruneBackups 本来就声明为 best-effort）。
    try { pruneBackups(which); } catch { /* best-effort */ }
    return { id, bytes: buf.length, kind, sha256: sha256OfBuffer(buf) };
  }

  function readBackupBuffer(which, id) {
    parseBackupId(id);
    const { dir } = openBackupDir(which, '读备份前', '备份目录不可用，无法读取备份');
    const target = path.join(dir, id);
    const stat = lstatOrNull(fsLike, target);
    if (!stat || stat.isSymbolicLink() || (typeof stat.isFile === 'function' && !stat.isFile())) {
      throw diaryError('path-escape', `备份文件异常（不存在/链接/非普通文件）：${target}`);
    }
    const fd = fsLike.openSync(target, 'r');
    try {
      verifyOpenHandle(fsLike, fd, target, '备份文件', { dev: Number(stat.dev), ino: Number(stat.ino) });
      return fsLike.readFileSync(fd);
    } finally {
      try { fsLike.closeSync(fd); } catch { /* ignore */ }
    }
  }

  // ── 审计（只有元数据，绝不含内容）─────────────────────────────────────────
  function auditTarget() {
    return path.join(path.dirname(usageTarget()), 'diary-audit.jsonl');
  }

  function appendAudit(entry) {
    try {
      const target = auditTarget();
      const dir = path.dirname(target);
      const dirId = dirIdentityAfterEnsure(fsLike, dir);
      verifyDirIdentity(fsLike, dir, dirId, '写审计前');
      const line = `${JSON.stringify({ at: now(), ...entry })}\n`;
      const flags = (fsLike.constants?.O_APPEND ?? fsDefault.constants.O_APPEND)
        | (fsLike.constants?.O_CREAT ?? fsDefault.constants.O_CREAT)
        | (fsLike.constants?.O_WRONLY ?? fsDefault.constants.O_WRONLY);
      const fd = fsLike.openSync(target, flags, 0o644);
      try {
        fsLike.writeSync(fd, Buffer.from(line, 'utf8'), 0, Buffer.byteLength(line), null);
      } finally {
        try { fsLike.closeSync(fd); } catch { /* ignore */ }
      }
    } catch {
      /* 审计是 best-effort：写不进去也不能让已经成功的写入变成失败 */
    }
  }

  function readAudit(limit = 50) {
    const cap = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 50)));
    let raw = '';
    try {
      raw = fsLike.readFileSync(auditTarget(), 'utf8');
    } catch {
      return [];
    }
    const lines = String(raw).split('\n').filter((line) => line.trim().length > 0);
    const out = [];
    for (const line of lines.slice(-cap)) {
      try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
    return out;
  }

  // ── 计数分配（write/edit/delete/restore 共用；先落盘计数再动日记）─────────
  function allocateUsage(which) {
    const day = beijingDayKey(now());
    const usage = readUsage(fsLike, usageTarget());
    if (usage.corrupt) {
      throw diaryError('daily-write-limit', `计数文件损坏，按当日额度已满处理（fail-closed）：${usageTarget()}`, { usageCorrupt: true });
    }
    const used = Number(usage.days[day]?.[which] ?? 0);
    if (used >= limits.dailyWrites) {
      throw diaryError('daily-write-limit', `北京日 ${day} 的 ${which} 已写 ${used} 次，上限 ${limits.dailyWrites}`);
    }
    const nextUsage = bumpUsage(usage, which, day, limits);
    const usageDirId = dirIdentityAfterEnsure(fsLike, path.dirname(usageTarget()));
    atomicWriteFile(fsLike, usageTarget(), Buffer.from(`${JSON.stringify(nextUsage)}\n`, 'utf8'), usageDirId);
    return usage;
  }

  function read(which, readOptions = {}) {
    const { file, fileId } = resolvePath(which);
    const opt = readOptions && typeof readOptions === 'object' ? readOptions : {};
    const capLines = Math.max(1, Math.min(500, Number(limits.maxLines) || DEFAULT_LIMITS.maxLines));
    const capBytes = Math.max(1, Math.min(65536, Number(limits.maxReadBytes) || DEFAULT_LIMITS.maxReadBytes));
    const lineLimit = Number.isFinite(Number(opt.maxLines)) ? Math.trunc(Number(opt.maxLines)) : capLines;
    const byteLimit = Number.isFinite(Number(opt.maxBytes)) ? Math.trunc(Number(opt.maxBytes)) : capBytes;
    const maxLines = Math.min(lineLimit, capLines);
    const maxBytes = Math.min(byteLimit, capBytes);
    const offset = Number.isFinite(Number(opt.offset)) ? Math.max(0, Math.trunc(Number(opt.offset))) : 0;

    const buf = readDiaryBufOrNull(fsLike, file, fileId);
    if (!buf || buf.length === 0) {
      return {
        text: '', lineCount: 0, startLine: 0, endLine: 0, totalLines: 0,
        offset: 0, sha256: sha256OfText(''), hasMore: false, nextOffset: 0,
        overlongLine: false, encoding: 'utf-8', eol: 'CRLF',
      };
    }
    const { encoding, bomLength } = detectEncoding(buf);
    const fullText = decodeBody(buf, encoding, bomLength);
    const sha256 = sha256OfText(fullText);
    const eol = derivedEol(fullText);
    const index = buildLineIndex(fullText, encoding);
    const unit = encoding === 'utf-8' ? 1 : 2;

    const start = findStartLine(index, offset);
    if (start < 0) {
      return {
        text: '', lineCount: 0, startLine: 0, endLine: 0, totalLines: index.lines.length,
        offset: index.totalBytes, sha256, hasMore: false, nextOffset: index.totalBytes,
        overlongLine: false, encoding, eol,
      };
    }

    let count = 0;
    let usedBytes = 0;
    while (start + count < index.lines.length) {
      const i = start + count;
      const lineBytes = index.byteEnds[i] - index.byteStarts[i] + index.lines[i].eolLength * unit;
      if (count > 0) {
        if (maxLines > 0 && count >= maxLines) break;
        if (maxBytes > 0 && usedBytes + lineBytes > maxBytes) break;
      }
      count += 1;
      usedBytes += lineBytes;
      // 非法（0/负数）上限时也至少吞下一整行，保证 nextOffset 单调推进。
      if (count === 1 && (maxLines <= 0 || maxBytes <= 0)) break;
    }

    const end = start + count - 1;
    // 单行本身就超过 maxBytes 时，行边界优先：整行返回（绝不切半个字符），
    // 并用 overlongLine 显式告知调用方本页字节数可能超过 maxBytes。
    let overlongLine = false;
    for (let i = start; i <= end; i += 1) {
      if (index.byteEnds[i] - index.byteStarts[i] + index.lines[i].eolLength * unit > maxBytes) {
        overlongLine = true;
        break;
      }
    }
    const pieces = [];
    for (let i = start; i <= end; i += 1) pieces.push(fullText.slice(index.lines[i].start, index.lines[i].end));
    let text = pieces.join('\n');
    if (index.lines[end].eolLength > 0) text += '\n';
    const hasMore = end + 1 < index.lines.length;
    return {
      text,
      lineCount: count,
      startLine: start + 1,
      endLine: end + 1,
      totalLines: index.lines.length,
      offset: index.byteStarts[start],
      sha256,
      hasMore,
      nextOffset: hasMore ? index.byteStarts[end + 1] : index.totalBytes,
      overlongLine,
      encoding,
      eol,
    };
  }

  function snapshot(which) {
    const { file, fileId } = resolvePath(which);
    const buf = readDiaryBufOrNull(fsLike, file, fileId);
    if (!buf) {
      return { exists: false, bytes: 0, lineCount: 0, sha256: null, encoding: null, eol: null, mtimeMs: null };
    }
    const { encoding, bomLength } = detectEncoding(buf);
    const text = decodeBody(buf, encoding, bomLength);
    let mtimeMs = null;
    try {
      mtimeMs = fsLike.statSync(file).mtimeMs ?? null;
    } catch {
      mtimeMs = null;
    }
    return {
      exists: true,
      bytes: buf.length,
      lineCount: buildLineIndex(text, encoding).lines.length,
      sha256: sha256OfText(text),
      encoding,
      eol: derivedEol(text),
      mtimeMs,
    };
  }

  function write(which, text, writeOptions = {}) {
    const opt = writeOptions && typeof writeOptions === 'object' ? writeOptions : {};
    const mode = opt.mode === undefined ? 'overwrite' : opt.mode;
    if (mode !== 'overwrite' && mode !== 'append') {
      throw diaryError('bad-mode', `mode 只能是 overwrite/append，收到：${String(mode)}`);
    }
    if (typeof text !== 'string') throw diaryError('bad-text', 'text 必须是字符串');
    if (text.includes('\0')) throw diaryError('bad-text', 'text 不得包含 NUL 字节');
    const { file, dir, fileId, dirId } = resolvePath(which);
    if (inFlight.has(file)) throw diaryError('busy', `同一文件正在写入（重入）：${file}`, { path: file });
    inFlight.add(file);
    try {
      // 覆盖会丢掉旧内容，必须先备份；append 只是追加，不产生不可逆的旧版本。
      return performWrite({ which, file, dir, fileId, dirId, text, mode, backupKind: mode === 'overwrite' ? 'overwrite' : null, op: mode });
    } finally {
      inFlight.delete(file);
    }
  }

  function rollbackUsage(usage) {
    try {
      const target = usageTarget();
      if (usage.exists) {
        const usageDir = path.dirname(target);
        // 回滚同样是落盘：state 被换 junction 时不能把计数写到外面。
        const usageDirId = dirIdentityAfterEnsure(fsLike, usageDir);
        verifyDirIdentity(fsLike, usageDir, usageDirId, '回滚计数前');
        atomicWriteFile(fsLike, target, Buffer.from(`${JSON.stringify({ schemaVersion: 1, days: usage.days })}\n`, 'utf8'), usageDirId);
      } else {
        try { fsLike.unlinkSync(target); } catch { /* ignore */ }
      }
    } catch {
      /* 回滚是 best-effort：绝不掩盖原始错误 */
    }
  }

  function commitDiary({ file, dir, fileId, dirId, payload, eolText, encoding, bomLength, mode, needsEolPrefix, existedBefore }) {
    // dirId 只在「目录当时已存在」时才有值；首次写入必须现场取身份，绝不跳过校验。
    const effectiveDirId = dirId ?? dirIdentityAfterEnsure(fsLike, dir);
    ensureDir(dir);
    verifyDirIdentity(fsLike, dir, effectiveDirId, '提交前');
    if (mode === 'overwrite') {
      atomicWriteFile(fsLike, file, encodeBody(payload, encoding, bomLength > 0), effectiveDirId);
      return;
    }
    const constants = fsLike.constants ?? fsDefault.constants;
    const flags = (constants.O_APPEND ?? fsDefault.constants.O_APPEND)
      | (constants.O_CREAT ?? fsDefault.constants.O_CREAT)
      | (constants.O_WRONLY ?? fsDefault.constants.O_WRONLY);
    const chunks = [];
    if (needsEolPrefix) chunks.push(encodeBody(eolText, encoding, false));
    chunks.push(encodeBody(payload, encoding, false));
    const body = Buffer.concat(chunks);
    const fd = fsLike.openSync(file, flags, 0o644);
    try {
      try {
        verifyOpenHandle(fsLike, fd, file, '日记文件（append）', fileId);
        verifyDirIdentity(fsLike, dir, effectiveDirId, '打开后');
      } catch (verifyError) {
        // O_CREAT 在「校验后被换走的目录」里会凭空建出一个 0 字节文件：尽力回收。
        // 只在「我们本以为文件不存在」且「fd 此刻确实是空文件」时才删，绝不误删外部已有内容。
        if (!existedBefore) removeIfEmptyCreated(fsLike, fd, file);
        throw verifyError;
      }
      fsLike.writeSync(fd, body, 0, body.length, null);
      fsLike.fsyncSync(fd);
    } finally {
      try { fsLike.closeSync(fd); } catch { /* ignore */ }
    }
  }

  function performWrite({ which, file, dir, fileId, dirId, text, mode, transform, guardSha256, backupKind, op }) {
    const current = readDiaryBufOrNull(fsLike, file, fileId);
    const detected = current ? detectEncoding(current) : { encoding: 'utf-8', bomLength: 0 };
    const encoding = detected.encoding;
    const currentText = current ? decodeBody(current, encoding, detected.bomLength) : '';
    // 快照校验：调用方拿 read/snapshot 的 sha256 来定稿，这里在真正动盘之前复核一次。
    if (guardSha256 !== undefined && guardSha256 !== null) {
      if (typeof guardSha256 !== 'string') throw diaryError('bad-sha256', 'sha256 必须是字符串');
      const actual = sha256OfText(currentText);
      if (actual !== guardSha256) {
        throw diaryError('stale-snapshot', `文件已被改动（当前 ${actual.slice(0, 12)}，期望 ${guardSha256.slice(0, 12)}），请重新读取后再改`);
      }
    }
    const eol = current ? derivedEol(currentText) : 'CRLF';
    const eolText = eol === 'CRLF' ? '\r\n' : '\n';
    const nextText = typeof transform === 'function' ? transform(currentText) : text;
    const payload = normalizePayload(nextText, eol);
    const payloadBytes = byteLengthOf(payload, encoding);

    if (payloadBytes > limits.maxPayloadBytes) {
      throw diaryError('write-too-large', `单次写入 ${payloadBytes} 字节，超过上限 ${limits.maxPayloadBytes}：${file}`);
    }
    const needsEolPrefix = mode === 'append' && currentText.length > 0 && !/[\r\n]$/.test(currentText);
    const prefixBytes = needsEolPrefix ? byteLengthOf(eolText, encoding) : 0;
    const nextBytes = mode === 'overwrite'
      ? detected.bomLength + payloadBytes
      : (current ? current.length : 0) + prefixBytes + payloadBytes;
    if (nextBytes > limits.maxFileBytes) {
      throw diaryError('file-too-large', `写入后 ${nextBytes} 字节，超过单文件上限 ${limits.maxFileBytes}：${file}`);
    }

    // 计数先落盘：任何「计数写不进去」都在日记文件被改动之前暴露。
    const usage = allocateUsage(which);

    // 备份必须发生在「动了正式文件」之前，且备份失败就整次放弃（任务卡 §5）。
    // 备份放在计数之后：被额度拒绝的调用不该在备份目录里留垃圾。
    let backup = null;
    try {
      backup = backupKind ? writeBackup(which, current, backupKind) : null;
    } catch (error) {
      rollbackUsage(usage);
      throw error;
    }

    try {
      commitDiary({ file, dir, fileId, dirId, payload, eolText, encoding, bomLength: detected.bomLength, mode, needsEolPrefix, existedBefore: current !== null });
    } catch (error) {
      rollbackUsage(usage);
      throw error;
    }

    // 最终读取只是为了把返回值算准：此时提交已经发生，读失败不能让调用方误以为「没写成」。
    // overwrite 走 rename，inode 已换新，故不比对身份；append 的 inode 不变，照常比对。
    let finalText = null;
    let finalEncoding = encoding;
    try {
      const finalBuf = readDiaryBufOrNull(fsLike, file, mode === 'append' ? fileId : null);
      if (finalBuf) {
        const finalDetected = detectEncoding(finalBuf);
        finalEncoding = finalDetected.encoding;
        finalText = decodeBody(finalBuf, finalDetected.encoding, finalDetected.bomLength);
      }
    } catch {
      finalText = null;
    }
    if (finalText === null) {
      finalText = mode === 'append' ? `${currentText}${needsEolPrefix ? eolText : ''}${payload}` : payload;
    }
    const result = {
      bytes: payloadBytes + prefixBytes,
      sha256: sha256OfText(finalText),
      lineCount: buildLineIndex(finalText, finalEncoding).lines.length,
    };
    if (op) {
      // 审计只记元数据：文件名靠 which，绝不含正文（任务卡 §8）。
      appendAudit({
        file: which, op, mode, bytes: result.bytes, sha256: result.sha256,
        backup: backup ? backup.id : null, ok: true,
      });
    }
    if (backup) result.backupId = backup.id;
    return result;
  }

  // ── 行号 / 内容两种编辑模式（互斥）────────────────────────────────────────
  const LINE_OPS = new Set(['replaceLines', 'insertBefore', 'insertAfter', 'deleteLines']);
  const TEXT_OPS = new Set(['replaceText']);

  function lineNoOf(spec, field, editIndex) {
    const raw = spec[field];
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw diaryError('bad-edit-range', `第 ${editIndex + 1} 个编辑的 ${field} 必须是 >=1 的整数，收到：${String(raw)}`);
    }
    return value;
  }

  function editBlockLines(spec, field, editIndex) {
    const raw = spec[field];
    if (raw === undefined) return [];
    if (typeof raw !== 'string') throw diaryError('bad-edit', `第 ${editIndex + 1} 个编辑的 ${field} 必须是字符串`);
    if (raw.includes('\0')) throw diaryError('bad-edit', `第 ${editIndex + 1} 个编辑的 ${field} 不得包含 NUL 字节`);
    return textToLines(raw);
  }

  function applyLineEdits(currentText, eolText, edits) {
    const lines = splitEditableLines(currentText);
    const count = lines.length;
    const plan = [];
    for (let i = 0; i < edits.length; i += 1) {
      const spec = edits[i];
      const op = spec.op;
      if (op === 'replaceLines' || op === 'deleteLines') {
        const start = lineNoOf(spec, 'start', i);
        const end = lineNoOf(spec, 'end', i);
        if (start > end) throw diaryError('bad-edit-range', `第 ${i + 1} 个编辑 start=${start} 大于 end=${end}`);
        if (end > count) {
          throw diaryError('line-out-of-range', `第 ${i + 1} 个编辑 end=${end} 超出当前行数 ${count}`);
        }
        const blockLines = op === 'replaceLines' ? editBlockLines(spec, 'text', i) : [];
        plan.push({ kind: 'range', start, end, lines: blockLines, index: i });
      } else {
        const line = lineNoOf(spec, 'line', i);
        if (line > count + 1) throw diaryError('line-out-of-range', `第 ${i + 1} 个编辑 line=${line} 超出当前行数 ${count}`);
        if (op === 'insertAfter' && line > count) {
          throw diaryError('line-out-of-range', `第 ${i + 1} 个编辑 insertAfter(${line}) 超出当前行数 ${count}`);
        }
        const blockLines = editBlockLines(spec, 'text', i);
        const gap = op === 'insertBefore' ? line - 1 : line;
        plan.push({ kind: 'insert', start: line, end: line, gap, lines: blockLines, index: i });
      }
    }
    // 重叠校验：区间重叠、或插入点落在被替换区间内部，一律整次拒绝。
    for (let a = 0; a < plan.length; a += 1) {
      for (let b = a + 1; b < plan.length; b += 1) {
        const x = plan[a];
        const y = plan[b];
        let clash = false;
        if (x.kind === 'range' && y.kind === 'range') clash = x.start <= y.end && y.start <= x.end;
        else if (x.kind === 'insert' && y.kind === 'insert') clash = x.gap === y.gap;
        else {
          const range = x.kind === 'range' ? x : y;
          const ins = x.kind === 'insert' ? x : y;
          // 插入点落在被替换区间「内部」（含紧贴区间末尾）时，替换后行号会漂移，
          // 落点无法无歧义地确定；紧贴区间之前（gap = start-1）是安全的，放行。
          clash = ins.gap >= range.start && ins.gap <= range.end;
        }
        if (clash) {
          throw diaryError('overlap', `第 ${x.index + 1} 个与第 ${y.index + 1} 个编辑的区间重叠（或插入点落在另一编辑的区间内）`);
        }
      }
    }
    // 从大到小应用：先改后面的行，前面的行号就不会失效。
    const ordered = [...plan].sort((left, right) => {
      const lk = left.kind === 'range' ? left.start : left.gap;
      const rk = right.kind === 'range' ? right.start : right.gap;
      return rk - lk;
    });
    const fallbackEol = eolText || '\r\n';
    for (const item of ordered) {
      if (item.kind === 'range') {
        const block = item.lines.map((text, idx) => {
          const isLast = idx === item.lines.length - 1;
          if (!isLast) return { text, eol: fallbackEol };
          // 被替换区间末尾原本带换行，则新块末尾也带换行（保持文件形状）。
          const originalLast = lines[item.end - 1];
          return { text, eol: originalLast ? originalLast.eol : '' };
        });
        lines.splice(item.start - 1, item.end - item.start + 1, ...block);
      } else {
        const anchor = lines[item.gap - 1];
        const trailingEol = anchor ? anchor.eol : '';
        const block = item.lines.map((text, idx) => {
          const isLast = idx === item.lines.length - 1;
          if (!isLast) return { text, eol: fallbackEol };
          return { text, eol: trailingEol };
        });
        if (item.gap > 0 && anchor && anchor.eol === '' && block.length > 0) {
          // 插到「末尾没有换行」的行后面：原行要补换行，否则两行会粘在一起。
          anchor.eol = fallbackEol;
          block[block.length - 1].eol = '';
        }
        lines.splice(item.gap, 0, ...block);
      }
    }
    const trailing = endsWithEol(currentText);
    return joinEditableLines(lines, fallbackEol, trailing);
  }

  function countOccurrences(haystack, needle) {
    let count = 0;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      count += 1;
      from = at + needle.length;
    }
    return count;
  }

  function applyTextEdits(currentText, edits) {
    let text = currentText;
    for (let i = 0; i < edits.length; i += 1) {
      const spec = edits[i];
      const oldText = spec.oldText;
      const newText = spec.newText === undefined ? '' : spec.newText;
      if (typeof oldText !== 'string' || oldText.length === 0) {
        throw diaryError('bad-edit', `第 ${i + 1} 个 replaceText 的 oldText 必须是非空字符串`);
      }
      if (typeof newText !== 'string') throw diaryError('bad-edit', `第 ${i + 1} 个 replaceText 的 newText 必须是字符串`);
      if (oldText.includes('\0') || newText.includes('\0')) throw diaryError('bad-edit', 'oldText/newText 不得包含 NUL 字节');
      const hits = countOccurrences(text, oldText);
      if (hits === 0) throw diaryError('not-found', `第 ${i + 1} 个 replaceText 未匹配到任何内容`);
      const all = spec.replaceAll === true;
      if (hits > 1 && !all) {
        throw diaryError('ambiguous-match', `第 ${i + 1} 个 replaceText 匹配到 ${hits} 处，请缩小范围或显式 replaceAll:true`);
      }
      text = all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
    }
    return text;
  }

  function edit(which, editSpec = {}) {
    const spec = editSpec && typeof editSpec === 'object' && !Array.isArray(editSpec) ? editSpec : {};
    const edits = Array.isArray(spec.edits) ? spec.edits : null;
    if (!edits || edits.length === 0) throw diaryError('bad-edit', 'edits 必须是非空数组');
    let hasLine = false;
    let hasText = false;
    for (let i = 0; i < edits.length; i += 1) {
      const item = edits[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw diaryError('bad-edit', `第 ${i + 1} 个编辑必须是对象`);
      const op = item.op;
      if (LINE_OPS.has(op)) hasLine = true;
      else if (TEXT_OPS.has(op)) hasText = true;
      else throw diaryError('bad-edit-op', `第 ${i + 1} 个编辑的 op 非法：${String(op)}`);
    }
    if (hasLine && hasText) throw diaryError('mixed-edit-kinds', '行号模式（replaceLines/insertBefore/insertAfter/deleteLines）与内容模式（replaceText）不能混用');
    const { file, dir, fileId, dirId } = resolvePath(which);
    if (inFlight.has(file)) throw diaryError('busy', `同一文件正在写入（重入）：${file}`, { path: file });
    inFlight.add(file);
    try {
      const transform = (currentText) => {
        if (hasText) return applyTextEdits(currentText, edits);
        const eol = detectEol(currentText, 'CRLF') === 'CRLF' ? '\r\n' : '\n';
        return applyLineEdits(currentText, eol, edits);
      };
      return performWrite({
        which, file, dir, fileId, dirId, mode: 'overwrite', text: null,
        transform, guardSha256: spec.sha256, backupKind: 'edit', op: 'edit',
      });
    } finally {
      inFlight.delete(file);
    }
  }

  function remove(which) {
    const { file, dir, fileId, dirId } = resolvePath(which);
    if (inFlight.has(file)) throw diaryError('busy', `同一文件正在写入（重入）：${file}`, { path: file });
    inFlight.add(file);
    try {
      // 文件本来就不存在：什么都没删掉，那就什么都不做 —— 不建 0 字节文件、不烧当天额度。
      // 用返回体而不是抛错来区分（removed:false / reason:'not-found'）：delete 端点只有成功分支，
      // 抛错会把「删一个本来就没有的文件」变成 404 这类新的对外行为，属跨文件的语义变更。
      // 注意这里只认「读不到文件」。文件存在但正文为空仍走正常路径：那是一次真实写入（也仍会备份）。
      if (readDiaryBufOrNull(fsLike, file, fileId) === null) {
        return { ok: true, removed: false, reason: 'not-found', bytes: 0, lineCount: 0, sha256: null, backupId: null };
      }
      // 软删除：先备份再清空，文件本身留着（0 字节），外部脚本/watch 不会看到消失。
      return performWrite({
        which, file, dir, fileId, dirId, mode: 'overwrite', text: '',
        backupKind: 'delete', op: 'delete',
      });
    } finally {
      inFlight.delete(file);
    }
  }

  function restoreBackup(which, backupId) {
    fileNameOf(which);
    parseBackupId(backupId);
    const buf = readBackupBuffer(which, backupId);
    const detected = detectEncoding(buf);
    const text = decodeBody(buf, detected.encoding, detected.bomLength);
    const { file, dir, fileId, dirId } = resolvePath(which);
    if (inFlight.has(file)) throw diaryError('busy', `同一文件正在写入（重入）：${file}`, { path: file });
    inFlight.add(file);
    try {
      // 恢复算一次写入，且恢复前先把当前版本备走（不然「恢复」会变成不可撤销）。
      const result = performWrite({
        which, file, dir, fileId, dirId, mode: 'overwrite', text: null,
        transform: () => text, backupKind: 'restore', op: 'restore',
      });
      return { ...result, backupId };
    } finally {
      inFlight.delete(file);
    }
  }

  function status(which) {
    const snap = snapshot(which);
    const day = beijingDayKey(now());
    let used = 0;
    let usageCorrupt = false;
    try {
      const usage = readUsage(fsLike, usageTarget());
      if (usage.corrupt) usageCorrupt = true;
      else used = Number(usage.days[day]?.[which] ?? 0);
    } catch {
      usageCorrupt = true;
    }
    const backups = listBackups(which);
    // 只给元数据：任何字段都不含正文（任务卡 §7）。
    return {
      which,
      exists: snap.exists,
      bytes: snap.bytes,
      lineCount: snap.lineCount,
      sha256: snap.sha256,
      encoding: snap.encoding,
      eol: snap.eol,
      mtimeMs: snap.mtimeMs,
      day,
      usedToday: used,
      dailyWrites: limits.dailyWrites,
      remaining: Math.max(0, limits.dailyWrites - used),
      usageCorrupt,
      backupCount: backups.length,
      backupKeep: Math.max(1, Math.trunc(Number(limits.backupKeep) || DEFAULT_LIMITS.backupKeep)),
      lastBackupAt: backups.length > 0 ? backups[0].at : null,
    };
  }

  return Object.freeze({
    resolve, read, write, snapshot, edit, remove, restoreBackup, status,
    listBackups, readAudit, allocateUsage, root: rootText, usageFile, limits,
  });
}