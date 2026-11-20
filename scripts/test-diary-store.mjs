// Fish Diary 存储模块回归测试。
// 全部在 os.tmpdir() 下的一次性临时目录里跑，绝不触碰真实的 Fish Diary/ 与 state/。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiaryStore, DEFAULT_LIMITS, DIARY_FILES } from '../src/core/diary-store.mjs';

const NOTEBOOK = DIARY_FILES.notebook;
const PRIVY = DIARY_FILES.privy;
// 北京时间 2026-10-31 10:00（UTC 2026-10-31T02:00:00Z）。
const BASE_MS = Date.UTC(2026, 9, 31, 2, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

const created = [];
function makeRoot(label = 'diary') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-${label}-`));
  created.push(dir);
  return dir;
}
function cleanup() {
  for (const dir of created) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
function diaryPath(root, name = NOTEBOOK) { return path.join(root, 'Fish Diary', name); }
function usagePath(root) { return path.join(root, 'state', 'diary-usage.json'); }
function readUsageJson(root) { return JSON.parse(fs.readFileSync(usagePath(root), 'utf8')); }
function countOf(root, day, which) { return readUsageJson(root).days?.[day]?.[which] ?? 0; }
function tmpFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}
// fs 替身：继承真实 fs，只覆盖需要注入的调用，等价于「可注入的 fs」契约。
function stubFs(overrides) { return Object.assign(Object.create(fs), overrides); }
function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Error, `抛出的不是 Error：${String(error)}`);
    assert.equal(error.code, code, `期望 code=${code}，实际 code=${error.code}（${error.message}）`);
    return error;
  }
  throw new Error(`期望抛出 ${code}，但没有抛错`);
}
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    process.exitCode = 1;
    console.log(`❌ ${name}`);
    console.log(`   ${error?.stack ?? error}`);
  }
}

// 1. 两个合法文件名可读写
test('两个合法文件名都能读写，resolve 落在 <root>/Fish Diary 下', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  const resolved = store.resolve('notebook');
  assert.equal(path.basename(resolved), NOTEBOOK);
  assert.equal(path.basename(path.dirname(resolved)), 'Fish Diary');
  assert.equal(path.basename(store.resolve('privy')), PRIVY);

  assert.deepEqual(store.write('notebook', '今天有点累\n'), { bytes: 17, sha256: sha256('今天有点累\r\n'), lineCount: 1 });
  store.write('privy', '秘密底稿\n');
  assert.equal(store.read('notebook').text, '今天有点累\n');
  assert.equal(store.read('privy').text, '秘密底稿\n');
  assert.equal(store.read('notebook').startLine, 1);
  assert.equal(store.read('notebook').endLine, 1);
  assert.equal(fs.existsSync(diaryPath(root, PRIVY)), true);
});

// 2. bad-which / 非字符串 / 空串 / NUL
test('which 非白名单值一律 bad-which，且不创建任何目录', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  const bad = ['Notebook', 'NOTEBOOK', ' notebook', 'notebook ', '', null, undefined, 123, {}, true, [], 'notebook\0', 'privy\n', './notebook'];
  for (const which of bad) expectCode(() => store.resolve(which), 'bad-which');
  for (const which of bad) expectCode(() => store.write(which, 'x'), 'bad-which');
  for (const which of bad) expectCode(() => store.read(which), 'bad-which');
  assert.equal(fs.existsSync(path.join(root, 'Fish Diary')), false);
  assert.deepEqual(fs.readdirSync(root), []);
});

// 3. Fish Diary 目录本身是 junction / 符号链接 → path-escape
test('Fish Diary 目录是 junction 时 path-escape，外部目录不被写入', () => {
  const root = makeRoot();
  const outside = makeRoot('diary-outside');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(outside, path.join(root, 'Fish Diary'), linkType);
  const store = createDiaryStore({ root, now: () => BASE_MS });

  expectCode(() => store.resolve('notebook'), 'path-escape');
  expectCode(() => store.write('notebook', '逃逸\n'), 'path-escape');
  expectCode(() => store.read('notebook'), 'path-escape');
  expectCode(() => store.snapshot('notebook'), 'path-escape');
  assert.deepEqual(fs.readdirSync(outside), []);
});

// 4. 日记文件是符号链接指向外部文件 → path-escape
test('日记文件是符号链接（指向外部）时 path-escape，外部文件不被改写', () => {
  const root = makeRoot();
  const outsideRoot = makeRoot('diary-outside');
  const outsideFile = path.join(outsideRoot, 'target.txt');
  fs.writeFileSync(outsideFile, '外部内容\r\n');
  const dir = path.join(root, 'Fish Diary');
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(outsideFile, path.join(dir, NOTEBOOK), 'file');
  const store = createDiaryStore({ root, now: () => BASE_MS });

  expectCode(() => store.read('notebook'), 'path-escape');
  expectCode(() => store.write('notebook', '劫持\n'), 'path-escape');
  expectCode(() => store.snapshot('notebook'), 'path-escape');
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), '外部内容\r\n');
  // 另一个合法文件不受牵连
  store.write('privy', '正常\n');
  assert.equal(store.read('privy').text, '正常\n');
});

// 5. 新建文件 utf-8（无 BOM）+ CRLF，读写往返一致
test('新建文件是 utf-8 无 BOM + CRLF，读写往返一致', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', '第一行\n第二行\n');
  const raw = fs.readFileSync(diaryPath(root, NOTEBOOK));
  assert.notDeepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(raw.includes(Buffer.from('\r\n', 'utf8')), true);
  assert.equal(raw.includes(Buffer.from([0x0a, 0x0a])), false);
  const back = store.read('notebook');
  assert.equal(back.text, '第一行\n第二行\n');
  assert.equal(back.encoding, 'utf-8');
  assert.equal(back.eol, 'CRLF');
  assert.equal(back.lineCount, 2);
  assert.equal(back.totalLines, 2);
  // 二次 overwrite 仍不引入 BOM
  store.write('notebook', '只剩一行\n');
  const raw2 = fs.readFileSync(diaryPath(root, NOTEBOOK));
  assert.notDeepEqual([...raw2.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(store.read('notebook').text, '只剩一行\n');
});

// 6. UTF-8 BOM 保留；UTF-16LE 往返
test('UTF-8 BOM 保留，UTF-16LE 编码与 BOM 往返保持', () => {
  const root = makeRoot();
  const dir = path.join(root, 'Fish Diary');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, NOTEBOOK), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('旧内容\r\n', 'utf8')]));
  fs.writeFileSync(path.join(dir, PRIVY), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('秘密底稿\r\n', 'utf16le')]));
  const store = createDiaryStore({ root, now: () => BASE_MS });

  const before = store.read('notebook');
  assert.equal(before.text, '旧内容\n');
  assert.equal(before.encoding, 'utf-8');
  assert.equal(before.eol, 'CRLF');
  store.write('notebook', '新内容\n');
  const raw = fs.readFileSync(path.join(dir, NOTEBOOK));
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(raw.subarray(3).toString('utf8'), '新内容\r\n');
  assert.equal(store.read('notebook').text, '新内容\n');

  const privyBefore = store.read('privy');
  assert.equal(privyBefore.encoding, 'utf-16le');
  assert.equal(privyBefore.text, '秘密底稿\n');
  store.write('privy', '改写\n');
  const raw2 = fs.readFileSync(path.join(dir, PRIVY));
  assert.deepEqual([...raw2.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(raw2.subarray(2).toString('utf16le'), '改写\r\n');
  assert.equal(store.read('privy').encoding, 'utf-16le');
  assert.equal(store.read('privy').text, '改写\n');
});

// 6b. 正文里的 U+FEFF 不当作文件头 BOM
test('正文中的 U+FEFF 不被误判为 BOM', () => {
  const root = makeRoot();
  const dir = path.join(root, 'Fish Diary');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, NOTEBOOK), Buffer.from('a\uFEFFb\r\n', 'utf8'));
  const store = createDiaryStore({ root, now: () => BASE_MS });
  const page = store.read('notebook');
  assert.equal(page.encoding, 'utf-8');
  assert.equal(page.text, 'a\uFEFFb\n');
  assert.equal(page.text.length, 4);
});

// 7. 既有 LF 文件写入后仍保持 LF
test('既有 LF 文件 append/overwrite 后仍保持 LF', () => {
  const root = makeRoot();
  const dir = path.join(root, 'Fish Diary');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, NOTEBOOK), 'a\nb\nc\n');
  const store = createDiaryStore({ root, now: () => BASE_MS });

  assert.equal(store.read('notebook').eol, 'LF');
  store.write('notebook', 'x\ny\n', { mode: 'append' });
  const raw = fs.readFileSync(path.join(dir, NOTEBOOK));
  assert.equal(raw.includes(Buffer.from('\r\n', 'utf8')), false);
  assert.equal(store.read('notebook').text, 'a\nb\nc\nx\ny\n');
  store.write('notebook', 'z\n');
  const raw2 = fs.readFileSync(path.join(dir, NOTEBOOK));
  assert.equal(raw2.includes(Buffer.from('\r\n', 'utf8')), false);
  assert.equal(store.read('notebook').text, 'z\n');
  assert.equal(store.read('notebook').eol, 'LF');
});

// 7b. append 到「末尾无换行」的既有文件时先补一个 eol
test('append 到末尾没有换行的文件时先补一个 eol', () => {
  const root = makeRoot();
  const dir = path.join(root, 'Fish Diary');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, NOTEBOOK), '没有结尾换行');
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', '追加行\n', { mode: 'append' });
  assert.equal(store.read('notebook').text, '没有结尾换行\n追加行\n');
  assert.equal(fs.readFileSync(path.join(dir, NOTEBOOK), 'utf8'), '没有结尾换行\r\n追加行\r\n');
});

// 8. 600 行文件分页（maxLines:500），偏移落行中间时对齐到下一行开头
test('600 行文件按 500 行分页，middle-of-line 偏移向后对齐，nextOffset 单调推进', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  const lines = Array.from({ length: 600 }, (_, i) => `第 ${i + 1} 行内容`);
  const text = `${lines.join('\n')}\n`;
  store.write('notebook', text);

  const page1 = store.read('notebook');
  assert.equal(page1.lineCount, 500);
  assert.equal(page1.startLine, 1);
  assert.equal(page1.endLine, 500);
  assert.equal(page1.totalLines, 600);
  assert.equal(page1.hasMore, true);
  assert.ok(page1.nextOffset > 0);

  const page2 = store.read('notebook', { offset: page1.nextOffset });
  assert.equal(page2.lineCount, 100);
  assert.equal(page2.startLine, 501);
  assert.equal(page2.endLine, 600);
  assert.equal(page2.hasMore, false);
  assert.equal(page2.nextOffset, fs.statSync(diaryPath(root, NOTEBOOK)).size);
  assert.equal(page1.text + page2.text, text);

  // 偏移落在第 500 行中间 → 对齐到第 501 行开头
  const aligned = store.read('notebook', { offset: page1.nextOffset - 3 });
  assert.equal(aligned.startLine, 501);

  // maxLines / maxBytes 传 0 或负数时也必须保证 nextOffset 推进
  for (const opts of [{ maxLines: 0 }, { maxLines: -5 }, { maxBytes: 0 }, { maxBytes: -1 }]) {
    const page = store.read('notebook', { offset: 0, ...opts });
    assert.ok(page.text.length > 0, `限制 ${JSON.stringify(opts)} 时至少返回一整行`);
    assert.ok(page.nextOffset > 0, `限制 ${JSON.stringify(opts)} 时 nextOffset 必须推进`);
    assert.ok(page.lineCount >= 1);
  }
});

// 9. maxBytes 截断落行边界，不切坏中文多字节字符
test('maxBytes 截断落在行边界，中文不被截断，逐页拼接等于原文', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  const lines = Array.from({ length: 40 }, (_, i) => `第${i + 1}行：混排中文与ascii`);
  const text = `${lines.join('\n')}\n`;
  store.write('notebook', text);

  let offset = 0;
  let pages = 0;
  let merged = '';
  for (;;) {
    const page = store.read('notebook', { offset, maxBytes: 37 });
    if (page.lineCount === 0) break;
    assert.equal(page.text.includes('\uFFFD'), false, '不得切坏多字节字符');
    assert.ok(page.text.endsWith('\n'), `第 ${pages + 1} 页必须以完整行结尾`);
    assert.ok(page.nextOffset > offset, 'nextOffset 必须单调推进');
    merged += page.text;
    offset = page.nextOffset;
    pages += 1;
    if (!page.hasMore) break;
    assert.ok(pages < 200, '分页未收敛');
  }
  assert.equal(merged, text);
  assert.ok(pages >= 40, `40 行中文每行都超过 37 字节，应至少 40 页，实际 ${pages}`);
});

// 10. 单次载荷 > 1MB → write-too-large，文件与计数都不变
test('单次载荷超过 maxPayloadBytes 时 write-too-large，文件与计数都不变', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', '基线\n');
  const beforeFile = fs.readFileSync(diaryPath(root, NOTEBOOK));
  const beforeUsage = readUsageJson(root);
  const big = 'a'.repeat(DEFAULT_LIMITS.maxPayloadBytes + 1);

  expectCode(() => store.write('notebook', big), 'write-too-large');
  expectCode(() => store.write('notebook', big, { mode: 'append' }), 'write-too-large');
  assert.deepEqual(fs.readFileSync(diaryPath(root, NOTEBOOK)), beforeFile);
  assert.deepEqual(readUsageJson(root), beforeUsage);
  assert.deepEqual(tmpFiles(path.join(root, 'Fish Diary')), []);
});

// 11. 写后超过 maxFileBytes → file-too-large，文件不变、不计数
test('写入后会超过 maxFileBytes 时 file-too-large，文件不变且不计数', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS, limits: { maxFileBytes: 20 } });
  store.write('notebook', '一二三\n');
  const beforeFile = fs.readFileSync(diaryPath(root, NOTEBOOK));
  const beforeUsage = readUsageJson(root);

  expectCode(() => store.write('notebook', '一二三四五六七\n'), 'file-too-large');
  expectCode(() => store.write('notebook', '一二三四五六七\n', { mode: 'append' }), 'file-too-large');
  assert.deepEqual(fs.readFileSync(diaryPath(root, NOTEBOOK)), beforeFile);
  assert.deepEqual(readUsageJson(root), beforeUsage);
  assert.equal(countOf(root, '2026-10-31', 'notebook'), 1);
});

// 12. 每北京日 10 次上限、跨天重置、两文件独立计数
test('每北京日每文件 10 次写入上限，跨天重置，两文件独立计数', () => {
  const root = makeRoot();
  let clock = BASE_MS;
  const store = createDiaryStore({ root, now: () => clock });
  const append = (which, text) => store.write(which, text, { mode: 'append' });

  for (let i = 1; i <= 10; i += 1) append('notebook', `${i}\n`);
  expectCode(() => append('notebook', '11\n'), 'daily-write-limit');

  append('privy', 'p1\n');
  assert.equal(countOf(root, '2026-10-31', 'privy'), 1, '另一文件独立计数');
  for (let i = 2; i <= 10; i += 1) append('privy', `p${i}\n`);
  expectCode(() => append('privy', 'p11\n'), 'daily-write-limit');
  assert.deepEqual(readUsageJson(root).days['2026-10-31'], { notebook: 10, privy: 10 });
  assert.equal(readUsageJson(root).schemaVersion, 1);

  clock = BASE_MS + DAY_MS;
  append('notebook', '11\n');
  assert.equal(countOf(root, '2026-11-01', 'notebook'), 1, '跨北京日重置');
  assert.equal(countOf(root, '2026-10-31', 'notebook'), 10);
  const notebookText = store.read('notebook').text;
  assert.equal(store.read('notebook').totalLines, 11);
  assert.ok(notebookText.endsWith('\n11\n'), `第 11 次写入应在末尾：${JSON.stringify(notebookText.slice(-8))}`);
  const privyText = store.read('privy').text;
  assert.equal(store.read('privy').totalLines, 10);
  assert.ok(privyText.endsWith('p10\n'), `privy 末行应为 p10：${JSON.stringify(privyText.slice(-8))}`);
});

// 13. 计数文件损坏 → fail-closed，坏文件原样保留、日记不落盘
test('计数文件损坏时按当日额度已满拒绝，且绝不覆盖坏文件', () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  const corrupt = '{"schemaVersion":1,"days":{"2026-10-31":{"notebook":0,';
  fs.writeFileSync(usagePath(root), corrupt);
  const before = fs.readFileSync(usagePath(root));
  const store = createDiaryStore({ root, now: () => BASE_MS });

  expectCode(() => store.write('notebook', 'x\n'), 'daily-write-limit');
  expectCode(() => store.write('privy', 'y\n', { mode: 'append' }), 'daily-write-limit');
  assert.deepEqual(fs.readFileSync(usagePath(root)), before, '损坏的计数文件必须原样保留');
  assert.equal(fs.readFileSync(usagePath(root), 'utf8'), corrupt);
  assert.equal(fs.existsSync(diaryPath(root, NOTEBOOK)), false);
  assert.deepEqual(tmpFiles(path.join(root, 'state')), []);
  // 读取不受影响（只有写入 fail-closed）
  assert.equal(store.read('notebook').lineCount, 0);
});

// 14. rename 一直 EPERM → 抛错、原文件不变、无 .tmp 残留、不占日额
test('rename 持续 EPERM 时抛错，原文件不变、无 .tmp 残留、不占日额', () => {
  const root = makeRoot();
  const seed = createDiaryStore({ root, now: () => BASE_MS });
  seed.write('notebook', '原内容\n');
  const beforeFile = fs.readFileSync(diaryPath(root, NOTEBOOK));
  const beforeUsage = readUsageJson(root);

  const diaryDir = path.join(root, 'Fish Diary');
  let diaryRenames = 0;
  let failRename = true;
  const stub = stubFs({
    renameSync(from, to) {
      if (failRename && String(to).startsWith(`${diaryDir}${path.sep}`)) {
        diaryRenames += 1;
        const error = new Error(`EPERM: injected rename failure -> ${to}`);
        error.code = 'EPERM';
        throw error;
      }
      return fs.renameSync(from, to);
    },
  });
  const store = createDiaryStore({ root, now: () => BASE_MS, fs: stub });

  const error = expectCode(() => store.write('notebook', '新内容\n'), 'EPERM');
  assert.ok(error instanceof Error);
  assert.equal(diaryRenames, 5, '初次 + 4 次退避重试');
  assert.deepEqual(fs.readFileSync(diaryPath(root, NOTEBOOK)), beforeFile);
  assert.deepEqual(readUsageJson(root), beforeUsage, '失败不得占用日额');
  assert.deepEqual(tmpFiles(diaryDir), [], '不得残留临时文件');
  assert.equal(tmpFiles(path.join(root, 'state')).length, 0);
  // 计数回滚后同一天仍可继续写（这里已用 1 次，成功一次后应为 2 次）
  failRename = false;
  store.write('notebook', '第二次\n');
  assert.equal(countOf(root, '2026-10-31', 'notebook'), 2);
});

// 15. snapshot 与 read 的 sha256/lineCount 一致；不存在时 exists:false
test('snapshot 与 read 的 sha256/lineCount 一致，不存在时为 exists:false', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  assert.deepEqual(store.snapshot('notebook'), {
    exists: false, bytes: 0, lineCount: 0, sha256: null, encoding: null, eol: null, mtimeMs: null,
  });

  store.write('notebook', 'a\nb\nc\n');
  const snap = store.snapshot('notebook');
  const page = store.read('notebook');
  assert.equal(snap.exists, true);
  assert.equal(snap.sha256, page.sha256);
  assert.equal(snap.lineCount, page.lineCount);
  assert.equal(snap.lineCount, 3);
  assert.equal(snap.bytes, fs.statSync(diaryPath(root, NOTEBOOK)).size);
  assert.equal(snap.encoding, 'utf-8');
  assert.equal(snap.eol, 'CRLF');
  assert.ok(Number.isFinite(snap.mtimeMs));
  assert.equal(snap.sha256, sha256('a\r\nb\r\nc\r\n'));
});

// 16. 同文件并发重入 → busy
test('同一文件写操作重入时抛 busy，且内层不占日额、不污染内容', () => {
  const root = makeRoot();
  const diaryDir = path.join(root, 'Fish Diary');
  let innerError = null;
  let fired = false;
  let storeRef = null;
  const stub = stubFs({
    renameSync(from, to) {
      if (!fired && String(to).startsWith(`${diaryDir}${path.sep}`)) {
        fired = true;
        try { storeRef.write('notebook', '内层\n'); } catch (error) { innerError = error; }
      }
      return fs.renameSync(from, to);
    },
  });
  storeRef = createDiaryStore({ root, now: () => BASE_MS, fs: stub });

  const result = storeRef.write('notebook', '外层\n');
  assert.equal(fired, true, '注入点必须被触发');
  assert.ok(innerError instanceof Error, '内层 write 必须被拒绝');
  assert.equal(innerError.code, 'busy');
  assert.equal(result.lineCount, 1);
  assert.equal(storeRef.read('notebook').text, '外层\n');
  assert.equal(countOf(root, '2026-10-31', 'notebook'), 1);
});

// 17. 空文件/不存在 → 全零结构
test('不存在与空文件都返回全零读取结构', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  const zero = { text: '', lineCount: 0, startLine: 0, endLine: 0, hasMore: false };
  const missing = store.read('notebook');
  assert.deepEqual({
    text: missing.text, lineCount: missing.lineCount, startLine: missing.startLine, endLine: missing.endLine, hasMore: missing.hasMore,
  }, zero);
  assert.equal(missing.sha256, sha256(''));
  assert.equal(missing.nextOffset, 0);
  assert.equal(store.read('notebook', { offset: 999 }).lineCount, 0);

  fs.mkdirSync(path.join(root, 'Fish Diary'), { recursive: true });
  fs.writeFileSync(diaryPath(root, NOTEBOOK), '');
  const empty = store.read('notebook');
  assert.deepEqual({
    text: empty.text, lineCount: empty.lineCount, startLine: empty.startLine, endLine: empty.endLine, hasMore: empty.hasMore,
  }, zero);
  assert.equal(store.read('notebook', { offset: 0, maxLines: 500 }).lineCount, 0);
});

// 18. bad-mode / bad-text / bad-root 被拒时不产生任何文件和临时文件
test('bad-mode / bad-text / bad-root 被拒时不产生任何文件与临时文件', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  for (const mode of ['delete', 'Overwrite', 'APPEND', '', 0, null, false, {}]) {
    expectCode(() => store.write('notebook', 'x', { mode }), 'bad-mode');
  }
  for (const text of [123, null, undefined, Buffer.from('x'), {}, [], true]) {
    expectCode(() => store.write('notebook', text), 'bad-text');
  }
  expectCode(() => store.write('notebook', 'a\u0000b'), 'bad-text');
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(fs.existsSync(path.join(root, 'Fish Diary')), false);
  assert.equal(fs.existsSync(path.join(root, 'state')), false);

  const missingRoot = path.join(root, 'not-exists');
  const badRootStore = createDiaryStore({ root: missingRoot, now: () => BASE_MS });
  expectCode(() => badRootStore.resolve('notebook'), 'bad-root');
  expectCode(() => badRootStore.read('notebook'), 'bad-root');
  expectCode(() => badRootStore.write('notebook', 'x'), 'bad-root');
  assert.equal(fs.existsSync(missingRoot), false, '不得为坏 root 创建目录');

  const plainFile = path.join(root, 'plain.txt');
  fs.writeFileSync(plainFile, 'x');
  expectCode(() => createDiaryStore({ root: plainFile, now: () => BASE_MS }).write('notebook', 'x'), 'bad-root');
  expectCode(() => createDiaryStore({ root: 'a\u0000b', now: () => BASE_MS }).write('notebook', 'x'), 'bad-path');
  assert.deepEqual(fs.readdirSync(root), ['plain.txt']);
});

// 19. 计数文件只保留最近 usageRetentionDays 天
test('计数文件只保留最近 usageRetentionDays 天', () => {
  const root = makeRoot();
  let clock = BASE_MS;
  const store = createDiaryStore({ root, now: () => clock });
  for (let i = 0; i < 10; i += 1) {
    store.write('notebook', `day${i}\n`, { mode: 'append' });
    clock += DAY_MS;
  }
  const days = Object.keys(readUsageJson(root).days).sort();
  assert.equal(days.length, DEFAULT_LIMITS.usageRetentionDays);
  assert.equal(days[days.length - 1], '2026-11-09');
  assert.equal(days[0], '2026-11-03');
});

// 20. 计数写入本身失败 → 明确错误，且日记文件一个字节都不动（无不一致状态）
test('计数写入失败时抛出明确错误，日记文件保持不变', () => {
  const root = makeRoot();
  const seed = createDiaryStore({ root, now: () => BASE_MS });
  seed.write('notebook', '原样\n');
  const before = fs.readFileSync(diaryPath(root, NOTEBOOK));
  const beforeUsage = readUsageJson(root);

  const stub = stubFs({
    renameSync(from, to) {
      if (String(to) === usagePath(root)) {
        const error = new Error(`EACCES: injected usage write failure -> ${to}`);
        error.code = 'EACCES';
        throw error;
      }
      return fs.renameSync(from, to);
    },
  });
  const store = createDiaryStore({ root, now: () => BASE_MS, fs: stub });
  expectCode(() => store.write('notebook', '新内容\n'), 'EACCES');
  assert.deepEqual(fs.readFileSync(diaryPath(root, NOTEBOOK)), before, '调用方报错时日记内容不得改变');
  assert.deepEqual(readUsageJson(root), beforeUsage);
  assert.deepEqual(tmpFiles(path.join(root, 'state')), []);
});

// 23. 硬链接防护：外部 inode 通过硬链接挂进 Fish Diary → 一律 path-escape
test('日记文件带多个硬链接时拒绝（append 不逃逸、read 不泄漏、不计数）', () => {
  const root = makeRoot();
  const dir = path.join(root, 'Fish Diary');
  fs.mkdirSync(dir, { recursive: true });
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'OUTSIDE\n');
  try {
    fs.linkSync(outside, diaryPath(root, NOTEBOOK));
  } catch (error) {
    return; // 文件系统不支持硬链接（FAT/exFAT）时跳过
  }
  const store = createDiaryStore({ root, now: () => BASE_MS });

  expectCode(() => store.write('notebook', 'APP\n', { mode: 'append' }), 'path-escape');
  expectCode(() => store.write('notebook', 'NEW\n'), 'path-escape');
  expectCode(() => store.read('notebook'), 'path-escape');
  expectCode(() => store.snapshot('notebook'), 'path-escape');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE\n', '外部文件不得被写入');
  assert.equal(fs.existsSync(usagePath(root)), false, '被拒的调用不得写计数');
});

// 24. 单行超过 maxBytes：行边界优先整行返回 + overlongLine 标记
test('单行超过 maxBytes 时整行返回并标记 overlongLine，不切坏多字节字符', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  const longLine = '中'.repeat(30000); // 单行 90000 字节
  store.write('notebook', `${longLine}\n第二行\n`);

  const page = store.read('notebook', { maxBytes: 40000 });
  assert.equal(page.lineCount, 1, '只返回那一超长行');
  assert.equal(page.overlongLine, true, '本页字节数超过 maxBytes 必须显式标记');
  assert.equal(page.text.includes('\uFFFD'), false, '不得把 UTF-8 汉字切成替换符');
  assert.equal(page.text.replace(/\n$/, ''), longLine);
  assert.equal(page.hasMore, true);
  assert.equal(page.offset, 0);

  const rest = store.read('notebook', { offset: page.nextOffset });
  assert.equal(rest.text, '第二行\n');
  assert.equal(rest.overlongLine, false);

  const normal = createDiaryStore({ root: makeRoot(), now: () => BASE_MS });
  normal.write('notebook', 'a\nb\n');
  const normalPage = normal.read('notebook');
  assert.equal(normalPage.overlongLine, false, '正常页不得误标');
});

// 25. 空文件与不存在：offset=0 的全零结构
test('空文件与不存在时 read 返回 offset=0 的全零结构', () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, 'Fish Diary'), { recursive: true });
  fs.writeFileSync(diaryPath(root, NOTEBOOK), '');
  const store = createDiaryStore({ root, now: () => BASE_MS });

  for (const which of ['notebook', 'privy']) {
    const page = store.read(which);
    assert.equal(page.offset, 0, `${which} 空文件 offset 必须为 0`);
    assert.equal(page.nextOffset, 0);
    assert.equal(page.text, '');
    assert.equal(page.lineCount, 0);
    assert.equal(page.totalLines, 0);
    assert.equal(page.hasMore, false);
    assert.equal(page.overlongLine, false);
  }
});

// 26. 默认限额与任务卡一致
test('默认限额与任务卡一致：10 次/日、10MB、1MB', () => {
  assert.equal(DEFAULT_LIMITS.dailyWrites, 10);
  assert.equal(DEFAULT_LIMITS.maxFileBytes, 10 * 1024 * 1024);
  assert.equal(DEFAULT_LIMITS.maxPayloadBytes, 1024 * 1024);
});

// 27. TOCTOU：校验通过后、真正 open 之前把文件换成外部硬链接 → fd 级复核必须拦住
test('open 之前被换成硬链接时仍拒绝（fd 级 nlink 复核堵 TOCTOU）', () => {
  const root = makeRoot();
  const dir = path.join(root, 'Fish Diary');
  fs.mkdirSync(dir, { recursive: true });
  const target = diaryPath(root, NOTEBOOK);
  fs.writeFileSync(target, 'LEGIT\n');
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'OUTSIDE\n');

  let opens = 0;
  let linked = false;
  const stub = stubFs({
    openSync(file, flags, mode) {
      if (String(file) === target) {
        opens += 1;
        // 第 1 次 open 是 performWrite 读现状；第 2 次才是 append 提交时的那次
        if (opens === 2 && !linked) {
          try {
            fs.unlinkSync(target);
            fs.linkSync(outside, target);
            linked = true;
          } catch {
            fs.writeFileSync(target, 'LEGIT\n');
          }
        }
      }
      return fs.openSync(file, flags, mode);
    },
  });
  const store = createDiaryStore({ root, now: () => BASE_MS, fs: stub });
  if (!linked) return; // 文件系统不支持硬链接

  expectCode(() => store.write('notebook', '攻击\n', { mode: 'append' }), 'path-escape');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE\n', '外部文件不得被追加');
  assert.equal(fs.existsSync(usagePath(root)), false, '被拒的调用不得留下计数');
});

// 28. 计数文件存在却读不出来（EACCES）：如实报 usage-unreadable，不伪装成日额用满
test('计数文件读失败时报 usage-unreadable，且仍 fail-closed 不落盘', () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(usagePath(root), '{"schemaVersion":1,"days":{}}');
  const stub = stubFs({
    readFileSync(file, options) {
      if (String(file) === usagePath(root)) {
        const error = new Error('EACCES: injected usage read failure');
        error.code = 'EACCES';
        throw error;
      }
      return fs.readFileSync(file, options);
    },
  });
  const store = createDiaryStore({ root, now: () => BASE_MS, fs: stub });
  const error = expectCode(() => store.write('notebook', 'x\n'), 'usage-unreadable');
  assert.equal(error.ioCode, 'EACCES');
  assert.equal(fs.existsSync(diaryPath(root, NOTEBOOK)), false, 'fail-closed：日记不得落盘');
});

// 29. 校验通过后、open 之前把文件换成符号链接 → 三个入口都必须 path-escape，外部不受影响
test('文件在校验后被换成符号链接时 read/snapshot/append 全部拒绝（inode 绑定）', () => {
  for (const entry of ['read', 'snapshot', 'append']) {
    const root = makeRoot(`sym-${entry}`);
    fs.mkdirSync(path.join(root, 'Fish Diary'), { recursive: true });
    const file = diaryPath(root, NOTEBOOK);
    fs.writeFileSync(file, 'LEGIT\n');
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'OUTSIDE\n');

    let swapped = false;
    const stub = stubFs({
      openSync(target, ...rest) {
        if (!swapped && String(target) === file) {
          swapped = true;
          fs.rmSync(file, { force: true });
          try { fs.symlinkSync(outside, file); } catch { fs.writeFileSync(file, 'LEGIT\n'); return fs.openSync(target, ...rest); }
        }
        return fs.openSync(target, ...rest);
      },
    });
    const store = createDiaryStore({ root, fs: stub, now: () => BASE_MS, limits: { dailyWrites: 99 } });
    if (!swapped) return; // 文件系统不支持符号链接
    if (entry === 'read') expectCode(() => store.read('notebook'), 'path-escape');
    if (entry === 'snapshot') expectCode(() => store.snapshot('notebook'), 'path-escape');
    if (entry === 'append') expectCode(() => store.write('notebook', 'INJECT\n', { mode: 'append' }), 'path-escape');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE\n', `${entry}: 外部文件不得被改动`);
  }
});

// 30. 父目录在校验后被换成 junction → append/overwrite 必须拒绝，外部目录不受影响
test('父目录在校验后被换成 junction 时 append/overwrite 被拒绝（目录 inode 复核）', () => {
  for (const entry of ['append', 'overwrite']) {
    const root = makeRoot(`junc-${entry}`);
    const dir = path.join(root, 'Fish Diary');
    fs.mkdirSync(dir, { recursive: true });
    const file = diaryPath(root, NOTEBOOK);
    fs.writeFileSync(file, 'LEGIT\n');
    const evil = makeRoot(`junc-${entry}-evil`);
    const evilFile = path.join(evil, NOTEBOOK);
    fs.writeFileSync(evilFile, 'EVIL-SEED\n');

    let swapped = false;
    const stub = stubFs({
      openSync(target, ...rest) {
        if (!swapped && String(target).startsWith(dir + path.sep)) {
          swapped = true;
          try {
            fs.renameSync(dir, `${dir}-moved`);
            fs.symlinkSync(evil, dir, 'junction');
          } catch { swapped = false; }
        }
        return fs.openSync(target, ...rest);
      },
    });
    const store = createDiaryStore({ root, fs: stub, now: () => BASE_MS, limits: { dailyWrites: 99 } });
    if (!swapped) return; // 文件系统不支持 junction
    const run = entry === 'append'
      ? () => store.write('notebook', 'INJECT\n', { mode: 'append' })
      : () => store.write('notebook', 'INJECT\n');
    expectCode(run, 'path-escape');
    assert.ok(!fs.readFileSync(evilFile, 'utf8').includes('INJECT'), `${entry}: 外部目录文件不得被写入`);
  }
});

// 31. fs 替身不提供 fstatSync → 无法证明打开的就是校验过的 inode，必须 fail-closed
test('fs 缺少 fstatSync 时 fail-closed（path-escape），日记文件不受影响', () => {
  const root = makeRoot('nofstat');
  const dir = path.join(root, 'Fish Diary');
  fs.mkdirSync(dir, { recursive: true });
  const file = diaryPath(root, NOTEBOOK);
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'OUTSIDE\n');
  fs.writeFileSync(file, 'LEGIT\n');

  const stub = stubFs({ fstatSync: undefined }); // 覆盖掉原型上的 fstatSync，令其不可用
  const store = createDiaryStore({ root, fs: stub, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  expectCode(() => store.write('notebook', 'INJECT\n', { mode: 'append' }), 'path-escape');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'LEGIT\n', '失败写入不得改动日记文件');
});

// 32. 首次写入（目标目录尚不存在）时目录被造成为 junction → 必须拒绝，外部不受影响
test('首次写入时 Fish Diary 目录被造成 junction → path-escape，外部不变', () => {
  for (const entry of ['append', 'overwrite']) {
    const root = makeRoot(`first-${entry}`);
    const dir = path.join(root, 'Fish Diary');
    const evil = makeRoot(`first-${entry}-evil`);
    const evilFile = path.join(evil, NOTEBOOK);
    fs.writeFileSync(evilFile, 'OUTSIDE-SEED\n');

    let armed = false;
    const stub = stubFs({
      mkdirSync(target, ...rest) {
        if (!armed && String(target) === dir) {
          try { fs.symlinkSync(evil, dir, 'junction'); armed = true; return undefined; } catch { armed = false; }
        }
        return fs.mkdirSync(target, ...rest);
      },
    });
    const store = createDiaryStore({ root, fs: stub, now: () => BASE_MS, limits: { dailyWrites: 99 } });
    const run = entry === 'append'
      ? () => store.write('notebook', 'INJECT\n', { mode: 'append' })
      : () => store.write('notebook', 'INJECT\n');
    if (!armed) {
      // 目录尚未被替换时先跑一次，让 mkdirSync 触发替换
      let code = 'ok';
      try { run(); } catch (error) { code = error.code; }
      if (!armed) return; // 文件系统不支持 junction
      assert.equal(code, 'path-escape', `${entry}: 首次写入必须被拒`);
    } else {
      expectCode(run, 'path-escape');
    }
    assert.equal(fs.readFileSync(evilFile, 'utf8'), 'OUTSIDE-SEED\n', `${entry}: 外部文件不得被改动`);
  }
});

// 33. overwrite 在 open(tmp) 之前目录被换成 junction → 必须拒绝，外部不受影响
test('overwrite 在临时文件 open 前目录被换 junction → path-escape，外部不变', () => {
  const root = makeRoot('tmp-swap');
  const dir = path.join(root, 'Fish Diary');
  fs.mkdirSync(dir, { recursive: true });
  const evil = makeRoot('tmp-swap-evil');
  const evilFile = path.join(evil, NOTEBOOK);
  fs.writeFileSync(evilFile, 'OUTSIDE-SEED\n');

  let armed = false;
  const stub = stubFs({
    openSync(target, ...rest) {
      if (!armed && String(target).endsWith('.tmp')) {
        try {
          fs.renameSync(dir, `${dir}-moved`);
          fs.symlinkSync(evil, dir, 'junction');
          armed = true;
        } catch { armed = false; }
      }
      return fs.openSync(target, ...rest);
    },
  });
  const store = createDiaryStore({ root, fs: stub, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  expectCode(() => store.write('notebook', 'INJECT\n'), 'path-escape');
  assert.equal(fs.readFileSync(evilFile, 'utf8'), 'OUTSIDE-SEED\n', '外部文件不得被 rename 覆盖');
});

// 34. <root>/state 被换成 junction → 计数不得写到外面
test('state 目录被换成 junction 时计数写到外部被拒（path-escape）', () => {
  const root = makeRoot('state-swap');
  fs.mkdirSync(path.join(root, 'Fish Diary'), { recursive: true });
  const stateDir = path.join(root, 'state');
  const evil = makeRoot('state-swap-evil');

  let armed = false;
  const stub = stubFs({
    mkdirSync(target, ...rest) {
      if (!armed && String(target) === stateDir) {
        try { fs.symlinkSync(evil, stateDir, 'junction'); armed = true; return undefined; } catch { armed = false; }
      }
      return fs.mkdirSync(target, ...rest);
    },
  });
  const store = createDiaryStore({ root, fs: stub, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  expectCode(() => store.write('notebook', 'x\n'), 'path-escape');
  assert.equal(fs.readdirSync(evil).filter((f) => f.includes('diary-usage')).length, 0, '外部不得出现计数文件');
});

// 35. B5：append 的 open(O_CREAT) 窗口目录被换 junction → 拒绝且外部不残留 0 字节文件
test('B5：append 打开窗口目录被换 junction 时不在外部留下空文件', () => {
  const root = makeRoot('b5');
  const dir = path.join(root, 'Fish Diary');
  fs.mkdirSync(dir, { recursive: true });
  const evil = makeRoot('b5-evil');

  let armed = false;
  const stub = stubFs({
    openSync(target, flags, ...rest) {
      // 只在 append 的数字 flags 上动手；'r' 读阶段不动。
      if (!armed && typeof flags === 'number' && String(target) === path.join(dir, NOTEBOOK)) {
        try {
          fs.renameSync(dir, `${dir}-moved`);
          fs.symlinkSync(evil, dir, 'junction');
          armed = true;
        } catch { armed = false; }
      }
      return fs.openSync(target, flags, ...rest);
    },
  });
  const store = createDiaryStore({ root, fs: stub, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  const code = expectCode(() => store.write('notebook', 'X\n', { mode: 'append' }), 'path-escape');
  assert.ok(code);
  assert.equal(fs.existsSync(path.join(evil, NOTEBOOK)), false, '外部不得残留 0 字节文件');
});

// 36. B6：日记写入失败触发计数回滚时，state 被换 junction 不得写到外部
test('B6：回滚计数时 state 被换 junction → 不写到外部', () => {
  const root = makeRoot('b6');
  fs.mkdirSync(path.join(root, 'Fish Diary'), { recursive: true });
  const diaryFile = path.join(root, 'Fish Diary', NOTEBOOK);
  const stateDir = path.join(root, 'state');
  const evil = makeRoot('b6-evil');

  let swapped = false;
  const stub = stubFs({
    openSync(target, flags, ...rest) {
      if (!swapped && typeof flags === 'number' && String(target) === diaryFile) {
        try {
          fs.symlinkSync(evil, stateDir, 'junction');
          swapped = true;
        } catch { swapped = false; }
        throw Object.assign(new Error('注入的日记写入失败'), { code: 'EIO' });
      }
      return fs.openSync(target, flags, ...rest);
    },
  });
  const store = createDiaryStore({ root, fs: stub, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  let code = 'ok';
  try { store.write('notebook', 'X\n', { mode: 'append' }); } catch (error) { code = error.code ?? 'unknown'; }
  assert.equal(code !== 'ok', true, '写入必须失败');
  const leaked = fs.existsSync(evil) ? fs.readdirSync(evil).filter((f) => f.includes('diary-usage')) : [];
  assert.equal(leaked.length, 0, '外部不得出现计数文件');
});

// 37. B7：rename 重试窗口里目录被换 junction → 拒绝且外部文件逐字节不变
test('B7：rename 重试期间目录被换 junction → path-escape，外部不变', () => {
  const root = makeRoot('b7');
  const dir = path.join(root, 'Fish Diary');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, NOTEBOOK), 'LEGIT\r\n');
  const evil = makeRoot('b7-evil');
  const evilFile = path.join(evil, NOTEBOOK);
  fs.writeFileSync(evilFile, 'OUTSIDE\r\n');

  let attempts = 0;
  const stub = stubFs({
    renameSync(from, to) {
      if (String(to) === path.join(dir, NOTEBOOK)) {
        attempts += 1;
        if (attempts === 2) {
          try {
            fs.renameSync(dir, `${dir}-moved`);
            fs.symlinkSync(evil, dir, 'junction');
          } catch { /* ignore */ }
        }
        if (attempts <= 2) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      return fs.renameSync(from, to);
    },
  });
  const store = createDiaryStore({ root, fs: stub, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  expectCode(() => store.write('notebook', 'INJECT\r\n'), 'path-escape');
  assert.equal(fs.readFileSync(evilFile, 'utf8'), 'OUTSIDE\r\n', '外部文件不得被覆盖');
});

// ── P1b-1 新增：edit / remove / restoreBackup / status / 备份 / 审计 ─────────
function backupDirOf(root, which) { return path.join(root, 'state', 'diary-backups', which); }
function auditPathOf(root) { return path.join(root, 'state', 'diary-audit.jsonl'); }

// 38. 行号模式：replaceLines（1-based，end 含端点）
test('edit replaceLines 按 1-based 行号替换闭区间，行尾风格与 sha256 保持自洽', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', 'L1\r\nL2\r\nL3\r\nL4\r\n');
  const result = store.edit('notebook', {
    sha256: store.snapshot('notebook').sha256,
    edits: [{ op: 'replaceLines', start: 2, end: 3, text: 'X2\r\nX3' }],
  });
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), 'L1\r\nX2\r\nX3\r\nL4\r\n');
  assert.equal(result.lineCount, 4);
  assert.equal(result.sha256, store.snapshot('notebook').sha256);
  assert.ok(result.backupId, '编辑前必须先备份');
});

// 39. 行号模式：insertBefore / insertAfter 的边界
test('edit insertBefore/insertAfter 支持首行前与末行后，越界一律拒绝', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', 'A\r\nB\r\n');
  store.edit('notebook', { edits: [
    { op: 'insertBefore', line: 1, text: 'HEAD' },
    { op: 'insertAfter', line: 2, text: 'TAIL' },
  ] });
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), 'HEAD\r\nA\r\nB\r\nTAIL\r\n');
  const before = fs.readFileSync(diaryPath(root, NOTEBOOK));
  expectCode(() => store.edit('notebook', { edits: [{ op: 'insertAfter', line: 9, text: 'X' }] }), 'line-out-of-range');
  expectCode(() => store.edit('notebook', { edits: [{ op: 'insertBefore', line: 99, text: 'X' }] }), 'line-out-of-range');
  assert.deepEqual(fs.readFileSync(diaryPath(root, NOTEBOOK)), before, '被拒的编辑不得改动文件');
});

// 40. 行号模式：deleteLines
test('edit deleteLines 删除闭区间，其余行顺序不变', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', '1\r\n2\r\n3\r\n4\r\n5\r\n');
  const result = store.edit('notebook', { edits: [{ op: 'deleteLines', start: 2, end: 4 }] });
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), '1\r\n5\r\n');
  assert.equal(result.lineCount, 2);
});

// 41. 多编辑按行号从大到小应用（乱序输入也得到稳定结果）
test('edit 多编辑按行号从大到小应用，乱序输入结果与顺序无关', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', 'a\r\nb\r\nc\r\nd\r\n');
  store.edit('notebook', { edits: [
    { op: 'replaceLines', start: 1, end: 1, text: 'A' },
    { op: 'deleteLines', start: 4, end: 4 },
    { op: 'replaceLines', start: 2, end: 2, text: 'B' },
  ] });
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), 'A\r\nB\r\nc\r\n');
});

// 42. 重叠区间拒绝 overlap，且不写盘、不占日额
test('edit 重叠区间抛 overlap，文件与计数都不变', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', 'a\r\nb\r\nc\r\n');
  const before = fs.readFileSync(diaryPath(root, NOTEBOOK));
  const beforeUsage = readUsageJson(root);
  expectCode(() => store.edit('notebook', { edits: [
    { op: 'replaceLines', start: 1, end: 2, text: 'X' },
    { op: 'deleteLines', start: 2, end: 3 },
  ] }), 'overlap');
  assert.deepEqual(fs.readFileSync(diaryPath(root, NOTEBOOK)), before);
  assert.deepEqual(readUsageJson(root), beforeUsage, '被拒的编辑不得计数');
});

// 43. 插入点落在被替换区间内部 → overlap
test('edit 插入点落在被替换区间内部时抛 overlap', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', 'a\r\nb\r\nc\r\nd\r\n');
  expectCode(() => store.edit('notebook', { edits: [
    { op: 'replaceLines', start: 2, end: 3, text: 'X' },
    { op: 'insertAfter', line: 2, text: 'Y' },
  ] }), 'overlap');
});

// 44. 行号越界 / start>end / 非法 op / 非整数
test('edit 越界与非法参数都整次拒绝（line-out-of-range / bad-edit-range / bad-edit-op）', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', 'a\r\nb\r\n');
  const before = fs.readFileSync(diaryPath(root, NOTEBOOK));
  expectCode(() => store.edit('notebook', { edits: [{ op: 'deleteLines', start: 2, end: 9 }] }), 'line-out-of-range');
  expectCode(() => store.edit('notebook', { edits: [{ op: 'deleteLines', start: 2, end: 1 }] }), 'bad-edit-range');
  expectCode(() => store.edit('notebook', { edits: [{ op: 'deleteLines', start: 0, end: 1 }] }), 'bad-edit-range');
  expectCode(() => store.edit('notebook', { edits: [{ op: 'deleteLines', start: 1.5, end: 2 }] }), 'bad-edit-range');
  expectCode(() => store.edit('notebook', { edits: [{ op: 'upsertLine', line: 1, text: 'x' }] }), 'bad-edit-op');
  expectCode(() => store.edit('notebook', { edits: [] }), 'bad-edit');
  assert.deepEqual(fs.readFileSync(diaryPath(root, NOTEBOOK)), before);
});

// 45. 两种模式混用 → mixed-edit-kinds
test('edit 行号模式与内容模式混用时抛 mixed-edit-kinds', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', 'a\r\nb\r\n');
  const before = fs.readFileSync(diaryPath(root, NOTEBOOK));
  expectCode(() => store.edit('notebook', { edits: [
    { op: 'replaceLines', start: 1, end: 1, text: 'A' },
    { op: 'replaceText', oldText: 'b', newText: 'B' },
  ] }), 'mixed-edit-kinds');
  assert.deepEqual(fs.readFileSync(diaryPath(root, NOTEBOOK)), before);
});

// 46. 快照不一致 → stale-snapshot；一致时放行
test('edit 用 read/snapshot 的 sha256 做快照校验：不一致 stale-snapshot，一致才写', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', 'a\r\nb\r\n');
  const stale = store.snapshot('notebook').sha256;
  store.write('notebook', 'a\r\nb\r\nc\r\n');
  const before = fs.readFileSync(diaryPath(root, NOTEBOOK));
  expectCode(() => store.edit('notebook', {
    sha256: stale,
    edits: [{ op: 'deleteLines', start: 1, end: 1 }],
  }), 'stale-snapshot');
  assert.deepEqual(fs.readFileSync(diaryPath(root, NOTEBOOK)), before, '快照过期时不得改动文件');
  const fresh = store.snapshot('notebook').sha256;
  store.edit('notebook', { sha256: fresh, edits: [{ op: 'deleteLines', start: 1, end: 1 }] });
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), 'b\r\nc\r\n');
  expectCode(() => store.edit('notebook', { sha256: 123, edits: [{ op: 'deleteLines', start: 1, end: 1 }] }), 'bad-sha256');
});

// 47. 内容模式：单次精确替换，不做正则
test('edit replaceText 精确替换单处，且不做正则', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', '今天吃了鱼\r\n明天吃面\r\n');
  store.edit('notebook', { edits: [{ op: 'replaceText', oldText: '吃面', newText: '吃鱼' }] });
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), '今天吃了鱼\r\n明天吃鱼\r\n');
  expectCode(() => store.edit('notebook', { edits: [{ op: 'replaceText', oldText: '今.*鱼', newText: 'x' }] }), 'not-found');
});

// 48. 内容模式：0 次 not-found，多次 ambiguous-match
test('edit replaceText 0 次匹配 not-found、多次匹配 ambiguous-match，除非 replaceAll', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', 'A\r\nA\r\nB\r\n');
  expectCode(() => store.edit('notebook', { edits: [{ op: 'replaceText', oldText: 'NOPE', newText: 'x' }] }), 'not-found');
  expectCode(() => store.edit('notebook', { edits: [{ op: 'replaceText', oldText: 'A', newText: 'x' }] }), 'ambiguous-match');
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), 'A\r\nA\r\nB\r\n', '被拒的编辑不得改动文件');
  store.edit('notebook', { edits: [{ op: 'replaceText', oldText: 'A', newText: 'Z', replaceAll: true }] });
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), 'Z\r\nZ\r\nB\r\n');
});

// 49. 内容模式：newText 为空串即删除该段
test('edit replaceText 的 newText 为空串时等于删除该段文本', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', '前缀-DELETE-后缀\r\n');
  store.edit('notebook', { edits: [{ op: 'replaceText', oldText: '-DELETE-', newText: '' }] });
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), '前缀后缀\r\n');
});

// 50. 内容模式：多条按数组顺序依次应用
test('edit 多条 replaceText 按数组顺序依次应用（后一条看到前一条的结果）', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', 'one\r\n');
  store.edit('notebook', { edits: [
    { op: 'replaceText', oldText: 'one', newText: 'two' },
    { op: 'replaceText', oldText: 'two', newText: 'three' },
  ] });
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), 'three\r\n');
});

// 51. 内容模式：任一条失败 → 整次不写盘、不计数
test('edit replaceText 中途失败时整次丢弃（不写盘、不计数）', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', 'gold\r\n');
  const before = fs.readFileSync(diaryPath(root, NOTEBOOK));
  const beforeUsage = readUsageJson(root);
  expectCode(() => store.edit('notebook', { edits: [
    { op: 'replaceText', oldText: 'gold', newText: 'silver' },
    { op: 'replaceText', oldText: 'missing', newText: 'x' },
  ] }), 'not-found');
  assert.deepEqual(fs.readFileSync(diaryPath(root, NOTEBOOK)), before);
  assert.deepEqual(readUsageJson(root), beforeUsage);
});

// 52. 一次成功的 edit 计 1 次日额
test('一次成功的 edit 计 1 次日额，write 与 edit 共用同一计数', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 2 } });
  store.write('notebook', 'a\r\n');
  assert.equal(countOf(root, '2026-10-31', 'notebook'), 1);
  store.edit('notebook', { edits: [{ op: 'replaceText', oldText: 'a', newText: 'b' }] });
  assert.equal(countOf(root, '2026-10-31', 'notebook'), 2);
  expectCode(() => store.edit('notebook', { edits: [{ op: 'replaceText', oldText: 'b', newText: 'c' }] }), 'daily-write-limit');
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), 'b\r\n', '超限编辑不得改动文件');
});

// 53. 覆盖写前自动备份；追加不备份
test('write overwrite 前自动备份旧内容，append 不产生备份', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  store.write('notebook', 'v1\r\n');
  assert.equal(store.listBackups('notebook').length, 0, '空文件首次写入没有旧内容可备份');
  store.write('notebook', 'v2\r\n');
  const backups = store.listBackups('notebook');
  assert.equal(backups.length, 1);
  assert.equal(backups[0].kind, 'overwrite');
  assert.equal(fs.readFileSync(path.join(backupDirOf(root, 'notebook'), backups[0].id), 'utf8'), 'v1\r\n');
  store.write('notebook', 'v3\r\n', { mode: 'append' });
  assert.equal(store.listBackups('notebook').length, 1, 'append 不该产生备份');
});

// 54. 软删除：先备份再清空，文件保留且为 0 字节
test('remove 先备份再清空：文件仍存在且为 0 字节，删除前内容留在 delete 备份里', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', '要删掉的内容\r\n');
  const result = store.remove('notebook');
  const file = diaryPath(root, NOTEBOOK);
  assert.equal(fs.existsSync(file), true, '软删除必须保留文件本身');
  assert.equal(fs.statSync(file).size, 0);
  assert.equal(result.bytes, 0);
  const del = store.listBackups('notebook').find((b) => b.kind === 'delete');
  assert.ok(del, '删除前必须留下 delete 类型备份');
  assert.equal(fs.readFileSync(path.join(backupDirOf(root, 'notebook'), del.id), 'utf8'), '要删掉的内容\r\n');
  const st = store.status('notebook');
  assert.equal(st.exists, true);
  assert.equal(st.bytes, 0);
  assert.equal(st.lineCount, 0);
});

// 55. 备份内容从不进入 status
test('status 只返回元数据，任何字段都不含正文', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  const secret = '绝密正文标记-must-not-leak';
  store.write('notebook', `${secret}\r\n`);
  const st = store.status('notebook');
  const json = JSON.stringify(st);
  assert.ok(!json.includes(secret), `status 不得包含正文：${json}`);
  for (const key of ['exists', 'bytes', 'lineCount', 'sha256', 'encoding', 'eol', 'mtimeMs', 'usedToday', 'dailyWrites', 'backupCount']) {
    assert.ok(key in st, `status 缺少字段 ${key}`);
  }
  assert.equal(st.bytes, Buffer.byteLength(`${secret}\r\n`, 'utf8'));
  assert.equal(st.lineCount, 1);
  assert.equal(st.usedToday, 1);
  assert.equal(st.dailyWrites, 10);
  assert.equal(st.sha256, sha256(`${secret}\r\n`));
  assert.equal(st.encoding, 'utf-8');
  assert.equal(st.eol, 'CRLF');
});

// 56. status 对不存在的文件也给元数据（不创建文件）
test('status 对不存在的文件返回 exists:false 且不创建任何文件', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  const st = store.status('privy');
  assert.equal(st.exists, false);
  assert.equal(st.bytes, 0);
  assert.equal(st.lineCount, 0);
  assert.equal(st.backupCount, 0);
  assert.equal(st.usedToday, 0);
  assert.deepEqual(fs.readdirSync(root), []);
});

// 57. restoreBackup 恢复备份，且恢复前先把当前版本备走
test('restoreBackup 原子写回备份内容，并在恢复前备份当前版本', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  store.write('notebook', '原始版本\r\n');
  store.write('notebook', '被覆盖的版本\r\n');
  const overwriteBackup = store.listBackups('notebook').find((b) => b.kind === 'overwrite');
  assert.ok(overwriteBackup);
  const result = store.restoreBackup('notebook', overwriteBackup.id);
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), '原始版本\r\n');
  assert.equal(result.backupId, overwriteBackup.id);
  assert.equal(result.sha256, sha256('原始版本\r\n'));
  const restoreBackup = store.listBackups('notebook').find((b) => b.kind === 'restore');
  assert.ok(restoreBackup, '恢复前必须先备份当前版本');
  assert.equal(fs.readFileSync(path.join(backupDirOf(root, 'notebook'), restoreBackup.id), 'utf8'), '被覆盖的版本\r\n');
});

// 58. restoreBackup 校验 id
test('restoreBackup 拒绝非法 id 与不存在的 id', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', 'x\r\n');
  for (const id of ['', 'nope', '../../etc/passwd', '20261031-100000-000-overwrite-ZZZZ.bak', null, 42]) {
    expectCode(() => store.restoreBackup('notebook', id), 'bad-backup-id');
  }
  expectCode(() => store.restoreBackup('notebook', '20261031-100000-000-overwrite-00000000.bak'), 'path-escape');
  expectCode(() => store.restoreBackup('nope', '20261031-100000-000-overwrite-00000000.bak'), 'bad-which');
});

// 59. 备份只保留最近 backupKeep 份
test('每文件只保留最近 backupKeep 份备份，更旧的被清理', () => {
  const root = makeRoot();
  let clock = BASE_MS;
  const store = createDiaryStore({ root, now: () => clock, limits: { dailyWrites: 99, backupKeep: 10 } });
  store.write('notebook', 'gen0\r\n');
  for (let i = 1; i <= 14; i += 1) {
    clock += 1000;
    store.write('notebook', `gen${i}\r\n`);
  }
  const backups = store.listBackups('notebook');
  assert.equal(backups.length, 10, `备份应保留 10 份，实际 ${backups.length}`);
  assert.equal(store.status('notebook').backupCount, 10);
  const newest = backups[0];
  assert.equal(fs.readFileSync(path.join(backupDirOf(root, 'notebook'), newest.id), 'utf8'), 'gen13\r\n');
  assert.equal(store.listBackups('privy').length, 0, '两个文件的备份互不影响');
});

// 60. 备份失败 → 不执行正式写，且计数回滚
test('备份失败时抛 backup-failed，日记文件与计数都不变、无临时文件残留', () => {
  const root = makeRoot();
  const seed = createDiaryStore({ root, now: () => BASE_MS });
  seed.write('notebook', '原有内容\r\n');
  const before = fs.readFileSync(diaryPath(root, NOTEBOOK));
  const beforeUsage = readUsageJson(root);

  const dir = backupDirOf(root, 'notebook');
  const stub = stubFs({
    renameSync(from, to) {
      if (String(to).startsWith(`${dir}${path.sep}`)) {
        const error = new Error(`EPERM: injected backup rename failure -> ${to}`);
        error.code = 'EPERM';
        throw error;
      }
      return fs.renameSync(from, to);
    },
  });
  const store = createDiaryStore({ root, now: () => BASE_MS, fs: stub });
  expectCode(() => store.write('notebook', '新内容\r\n'), 'backup-failed');
  assert.deepEqual(fs.readFileSync(diaryPath(root, NOTEBOOK)), before, '备份失败不得改动正式文件');
  assert.deepEqual(readUsageJson(root), beforeUsage, '备份失败必须回滚计数');
  assert.deepEqual(tmpFiles(path.join(root, 'Fish Diary')), []);
  assert.deepEqual(tmpFiles(dir), [], '备份目录不得残留临时文件');
});

// 61. 备份可关闭
test('backup:false 时照常写入但不产生任何备份目录', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS, backup: false, limits: { dailyWrites: 99 } });
  store.write('notebook', 'v1\r\n');
  store.write('notebook', 'v2\r\n');
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), 'v2\r\n');
  assert.deepEqual(store.listBackups('notebook'), []);
  assert.equal(fs.existsSync(path.join(root, 'state', 'diary-backups')), false);
});

// 62. 审计：只记元数据，绝不写正文
test('审计日志只记元数据（不含正文），readAudit 按上限返回最近条目', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  const secret = '审计绝密标记-cannot-appear';
  store.write('notebook', `${secret}\r\n`);
  store.edit('notebook', { edits: [{ op: 'replaceText', oldText: secret, newText: '新的绝密也不能出现' }] });
  store.write('notebook', '追加也不行\r\n', { mode: 'append' });
  const raw = fs.readFileSync(auditPathOf(root), 'utf8');
  assert.ok(!raw.includes(secret), '审计文件不得包含正文');
  assert.ok(!raw.includes('新的绝密'), '审计文件不得包含正文');
  const entries = store.readAudit(10);
  assert.ok(entries.length >= 3);
  for (const entry of entries) {
    assert.ok(!('text' in entry), '审计条目不得带正文字段');
    assert.equal(typeof entry.at, 'number');
    assert.equal(typeof entry.sha256, 'string');
    assert.ok(['overwrite', 'append', 'edit'].includes(entry.op), `未知 op：${entry.op}`);
  }
  assert.equal(store.readAudit(1).length, 1);
  assert.ok(store.readAudit(10000).length <= 500, 'readAudit 上限 500');
  assert.ok(!JSON.stringify(entries).includes(secret));
});

// 63. 审计失败不影响已经成功的写入（best-effort）
test('审计写不进去时写入仍然成功（best-effort）', () => {
  const root = makeRoot();
  const target = auditPathOf(root);
  const stub = stubFs({
    openSync(file, ...rest) {
      if (String(file) === target) {
        const error = new Error(`EACCES: injected audit failure -> ${file}`);
        error.code = 'EACCES';
        throw error;
      }
      return fs.openSync(file, ...rest);
    },
  });
  const store = createDiaryStore({ root, now: () => BASE_MS, fs: stub });
  const result = store.write('notebook', '正文\r\n');
  assert.equal(result.bytes, Buffer.byteLength('正文\r\n', 'utf8'));
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), '正文\r\n');
  assert.equal(countOf(root, '2026-10-31', 'notebook'), 1);
});

// 64. 计数损坏时 edit / remove 也 fail-closed
test('计数文件损坏时 edit 与 remove 都 fail-closed（daily-write-limit + usageCorrupt）', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', 'a\r\nb\r\n');
  const before = fs.readFileSync(diaryPath(root, NOTEBOOK));
  fs.writeFileSync(usagePath(root), '{ 坏掉的 json');
  const editError = expectCode(() => store.edit('notebook', { edits: [{ op: 'deleteLines', start: 1, end: 1 }] }), 'daily-write-limit');
  assert.equal(editError.usageCorrupt, true);
  expectCode(() => store.remove('notebook'), 'daily-write-limit');
  assert.deepEqual(fs.readFileSync(diaryPath(root, NOTEBOOK)), before, 'fail-closed 时不得动文件');
});

// 65. 无换行结尾的文件编辑后仍无换行
test('edit 目标文件结尾没有换行时，编辑结果也不补换行', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', 'x\r\ny');
  store.edit('notebook', { edits: [{ op: 'replaceText', oldText: 'y', newText: 'Y' }] });
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), 'x\r\nY');
  store.edit('notebook', { edits: [{ op: 'insertAfter', line: 2, text: 'Z' }] });
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), 'x\r\nY\r\nZ', '末行后插行不得让两行粘在一起');
});

// 66. LF 文件被编辑后仍保持 LF
test('edit 保持文件原有换行风格（LF 文件编辑后仍是 LF）', () => {
  const root = makeRoot();
  const dir = path.join(root, 'Fish Diary');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(diaryPath(root, NOTEBOOK), 'l1\nl2\nl3\n');
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.edit('notebook', { edits: [{ op: 'replaceLines', start: 2, end: 2, text: 'M2' }] });
  const text = fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8');
  assert.equal(text, 'l1\nM2\nl3\n');
  assert.ok(!text.includes('\r'));
});

// 67. 删除空文件不产生备份（无旧内容）
test('删除已经是 0 字节的文件时不产生备份，但仍然成功', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', '');
  const result = store.remove('notebook');
  assert.equal(result.bytes, 0);
  assert.equal(store.listBackups('notebook').length, 0);
  assert.equal(fs.statSync(diaryPath(root, NOTEBOOK)).size, 0);
});

// 68. 两个文件的备份与计数互相独立
test('两个文件的备份目录与计数互相独立', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  store.write('notebook', 'N1\r\n');
  store.write('notebook', 'N2\r\n');
  store.write('privy', 'P1\r\n');
  assert.equal(store.listBackups('notebook').length, 1);
  assert.equal(store.listBackups('privy').length, 0);
  assert.equal(countOf(root, '2026-10-31', 'notebook'), 2);
  assert.equal(countOf(root, '2026-10-31', 'privy'), 1);
  assert.equal(store.status('notebook').usedToday, 2);
  store.remove('privy');
  assert.equal(fs.existsSync(diaryPath(root, PRIVY)), true);
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), 'N2\r\n', '删除 privy 不得影响 notebook');
});

// 69. bad-which 对新 API 同样生效，且不产生任何文件
test('新 API 对非法 which 一律 bad-which，且不创建任何文件', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  for (const which of ['Notebook', '', null, undefined, 1, {}, './notebook']) {
    expectCode(() => store.edit(which, { edits: [{ op: 'deleteLines', start: 1, end: 1 }] }), 'bad-which');
    expectCode(() => store.remove(which), 'bad-which');
    expectCode(() => store.status(which), 'bad-which');
    expectCode(() => store.listBackups(which), 'bad-which');
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

// 70. 空文件 / 不存在的文件上的行号编辑
test('edit 在空文件上可插入首行，空文件上删除越界', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  expectCode(() => store.edit('notebook', { edits: [{ op: 'deleteLines', start: 1, end: 1 }] }), 'line-out-of-range');
  store.write('notebook', '');
  store.edit('notebook', { edits: [{ op: 'insertBefore', line: 1, text: '第一行' }] });
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), '第一行');
});

// 71. 默认限额里 backupKeep 是 10（只断言新增键，不改动既有断言）
test('默认限额新增 backupKeep=10，且既有默认值不变', () => {
  assert.equal(DEFAULT_LIMITS.backupKeep, 10);
  assert.equal(DEFAULT_LIMITS.dailyWrites, 10);
  assert.equal(DEFAULT_LIMITS.maxFileBytes, 10 * 1024 * 1024);
  assert.equal(DEFAULT_LIMITS.maxPayloadBytes, 1024 * 1024);
});

// 72. edit 时文件名被换成符号链接 → path-escape（安全设计不因新 API 松动）
test('edit / remove / restoreBackup 在文件被换成符号链接时仍 path-escape', () => {
  const root = makeRoot();
  const outsideRoot = makeRoot('diary-outside');
  const outsideFile = path.join(outsideRoot, 'target.txt');
  fs.writeFileSync(outsideFile, '外部内容\r\n');
  const store = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  store.write('notebook', '内部内容\r\n');
  const del = store.remove('notebook');
  fs.rmSync(diaryPath(root, NOTEBOOK));
  fs.symlinkSync(outsideFile, diaryPath(root, NOTEBOOK), 'file');
  expectCode(() => store.edit('notebook', { edits: [{ op: 'deleteLines', start: 1, end: 1 }] }), 'path-escape');
  expectCode(() => store.remove('notebook'), 'path-escape');
  expectCode(() => store.status('notebook'), 'path-escape');
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), '外部内容\r\n', '外部文件不得被改写');
  assert.ok(del, '前置删除成功');
});


// 73. P2-2：备份根被普通文件占位 → 稳定 backup-failed（不是原生 ENOTDIR），fail-closed
test('备份根被普通文件占位时抛 backup-failed（不是原生 ENOTDIR），日记与计数都不变', () => {
  const root = makeRoot();
  const seed = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  seed.write('notebook', '原有内容\r\n');
  const before = fs.readFileSync(diaryPath(root, NOTEBOOK));
  const beforeUsage = fs.readFileSync(usagePath(root));
  // state/diary-backups 被普通文件占位：mkdirSync('.../state/diary-backups/notebook') 会抛原生 ENOTDIR。
  fs.writeFileSync(path.join(root, 'state', 'diary-backups'), '占位文件');

  const store = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  const error = expectCode(() => store.write('notebook', '新内容\r\n'), 'backup-failed');
  assert.notEqual(error.code, 'ENOTDIR', '原生 ENOTDIR 必须归一成 diary 稳定错误码');
  assert.equal(error.ioCode, 'ENOTDIR', '原生错误码保留在 ioCode 上便于排查');
  assert.match(error.message, /备份/, '错误信息应说明是备份失败');
  assert.deepEqual(fs.readFileSync(diaryPath(root, NOTEBOOK)), before, '备份没成功就绝不写正式文件');
  assert.deepEqual(fs.readFileSync(usagePath(root)), beforeUsage, 'fail-closed：已分配的计数必须回滚');
  assert.deepEqual(tmpFiles(path.join(root, 'Fish Diary')), []);
});

// 74. 同场景下 edit / remove 也 fail-closed，append 不受影响（append 本就不备份）
test('备份根不可用时 edit / remove fail-closed，append 仍可追加', () => {
  const root = makeRoot();
  const seed = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  seed.write('notebook', '第一行\r\n第二行\r\n');
  const before = fs.readFileSync(diaryPath(root, NOTEBOOK));
  const beforeUsage = fs.readFileSync(usagePath(root));
  fs.writeFileSync(path.join(root, 'state', 'diary-backups'), '占位文件');

  const store = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  expectCode(() => store.edit('notebook', { edits: [{ op: 'replaceLines', start: 1, end: 1, text: '改过' }] }), 'backup-failed');
  expectCode(() => store.remove('notebook'), 'backup-failed');
  assert.deepEqual(fs.readFileSync(diaryPath(root, NOTEBOOK)), before, '被拒的编辑与删除都不得落盘');
  assert.deepEqual(fs.readFileSync(usagePath(root)), beforeUsage, '被拒的编辑与删除都不得计数');

  // append 不产生不可逆旧版本，本来就不备份 —— 备份坏掉不该连带它一起坏。
  store.write('notebook', '第三行\r\n', { mode: 'append' });
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), '第一行\r\n第二行\r\n第三行\r\n');
});

// 75. 备份子目录被普通文件占位：保持既有 path-escape 语义（不改成 backup-failed）
test('备份子目录被普通文件占位时仍 path-escape（既有语义不变）', () => {
  const root = makeRoot();
  const seed = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  seed.write('notebook', '原有内容\r\n');
  const before = fs.readFileSync(diaryPath(root, NOTEBOOK));
  const beforeUsage = fs.readFileSync(usagePath(root));
  fs.mkdirSync(path.join(root, 'state', 'diary-backups'), { recursive: true });
  fs.writeFileSync(backupDirOf(root, 'notebook'), '占位文件');

  const store = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  expectCode(() => store.write('notebook', '新内容\r\n'), 'path-escape');
  assert.deepEqual(fs.readFileSync(diaryPath(root, NOTEBOOK)), before);
  assert.deepEqual(fs.readFileSync(usagePath(root)), beforeUsage, 'fail-closed：被拒的写入不得计数');
});

// 76. restoreBackup 读备份时同样归一，且绝不改动当前版本
test('restoreBackup 在备份根不可用时抛 backup-failed，当前版本与计数都不变', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  store.write('notebook', 'v1\r\n');
  store.write('notebook', 'v2\r\n');
  const [backup] = store.listBackups('notebook');
  assert.ok(backup, '前置备份应存在');
  const before = fs.readFileSync(diaryPath(root, NOTEBOOK));
  const beforeUsage = fs.readFileSync(usagePath(root));
  fs.rmSync(path.join(root, 'state', 'diary-backups'), { recursive: true, force: true });
  fs.writeFileSync(path.join(root, 'state', 'diary-backups'), '占位文件');

  const fresh = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  const error = expectCode(() => fresh.restoreBackup('notebook', backup.id), 'backup-failed');
  assert.equal(error.ioCode, 'ENOTDIR');
  assert.deepEqual(fs.readFileSync(diaryPath(root, NOTEBOOK)), before, '恢复失败不得改动当前版本');
  assert.deepEqual(fs.readFileSync(usagePath(root)), beforeUsage, '恢复失败不得计数');
});

// 77. 备份不可用时只读接口仍可用（控制台不能因为备份坏了整体 500），且不含正文
test('备份根被普通文件占位时 status / listBackups 仍可用且不含正文', () => {
  const root = makeRoot();
  const secret = '备份坏掉时也不能漏出的正文';
  const store = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  store.write('notebook', `${secret}\r\n`);
  fs.writeFileSync(path.join(root, 'state', 'diary-backups'), '占位文件');
  assert.deepEqual(store.listBackups('notebook'), [], '备份根不是目录时按「没有备份」处理');
  const info = store.status('notebook');
  assert.equal(info.backupCount, 0);
  assert.equal(info.lastBackupAt, null);
  assert.equal(info.exists, true);
  assert.ok(!JSON.stringify(info).includes(secret), 'status 不得返回正文');
  assert.ok(!JSON.stringify(store.readAudit(50)).includes(secret), '审计不得返回正文');
});

// 78. 「备份不存在」仍然是 path-escape，不能被归一成 backup-failed
test('备份目录健康但备份不存在时仍是 path-escape（不误归一成 backup-failed）', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  store.write('notebook', 'v1\r\n');
  const missing = '20261031-100000-000-overwrite-deadbeef.bak';
  expectCode(() => store.restoreBackup('notebook', missing), 'path-escape');
  expectCode(() => store.restoreBackup('notebook', '不是备份 id'), 'bad-backup-id');
});

// 79. 备份列表遇真实 IO 错误时也不泄露原生 code（listBackups/status 同一收口点）
test('备份目录读取遇 EACCES 时 listBackups 抛稳定 backup-failed，不透出原生 code', () => {
  const root = makeRoot();
  const seed = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  seed.write('notebook', '正文\r\n');
  const dir = backupDirOf(root, 'notebook');
  const stub = stubFs({
    readdirSync(target, ...rest) {
      if (String(target) === dir) {
        const error = new Error(`EACCES: injected readdir failure -> ${target}`);
        error.code = 'EACCES';
        throw error;
      }
      return fs.readdirSync(target, ...rest);
    },
  });
  const store = createDiaryStore({ root, now: () => BASE_MS, fs: stub, limits: { dailyWrites: 99 } });
  const error = expectCode(() => store.listBackups('notebook'), 'backup-failed');
  assert.equal(error.ioCode, 'EACCES', '原生码保留在 ioCode 上便于排查');
  // 备份目录「不存在」仍然按「没有备份」处理，不属于错误路径。
  const fresh = createDiaryStore({ root: makeRoot(), now: () => BASE_MS, limits: { dailyWrites: 99 } });
  assert.deepEqual(fresh.listBackups('notebook'), []);
});

// 80. 备份成功但清理旧份失败时，写入仍然成功（清理是收尾，不是前置条件）
test('备份成功而清理旧份失败时写入仍然成功（prune 是 best-effort）', () => {
  const root = makeRoot();
  const seed = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  seed.write('notebook', '第一版\r\n');
  seed.write('notebook', '第二版\r\n');
  seed.write('notebook', '第三版\r\n');
  // 空文件不备份：三次覆盖只在第 2、3 次留下前两版，共 2 份。
  assert.equal(seed.listBackups('notebook').length, 2);
  const dir = backupDirOf(root, 'notebook');
  const stub = stubFs({
    readdirSync(target, ...rest) {
      if (String(target) === dir) {
        const error = new Error(`EACCES: injected readdir failure -> ${target}`);
        error.code = 'EACCES';
        throw error;
      }
      return fs.readdirSync(target, ...rest);
    },
  });
  const store = createDiaryStore({ root, now: () => BASE_MS, fs: stub, limits: { dailyWrites: 99 } });
  const result = store.write('notebook', '第四版\r\n');
  assert.equal(typeof result.sha256, 'string');
  assert.deepEqual(fs.readFileSync(diaryPath(root, NOTEBOOK)), Buffer.from('第四版\r\n'), '正式写入不该因为清理失败而回滚');
  assert.equal(countOf(root, '2026-10-31', 'notebook'), 4);
});
// 81. P3-4：对不存在的文件 remove 不建文件、不烧额度，且返回体可区分
test('对不存在的文件 remove 不建文件也不烧额度，返回 removed:false / reason:not-found', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  const file = diaryPath(root, NOTEBOOK);

  const result = store.remove('notebook');
  // 语义：用返回体区分「没删到东西」，而不是抛错 —— 抛错会给 delete 端点带来新的对外状态码。
  assert.equal(result.ok, true);
  assert.equal(result.removed, false);
  assert.equal(result.reason, 'not-found');
  assert.equal(result.bytes, 0);
  assert.equal(result.lineCount, 0);
  assert.equal(result.sha256, null);
  assert.equal(result.backupId, null);

  assert.equal(fs.existsSync(file), false, '不得创建 0 字节文件');
  assert.deepEqual(fs.readdirSync(root), [], 'root 里不得出现任何新东西（连 Fish Diary 目录都不该有）');
  const usedAfterNotFound = fs.existsSync(usagePath(root)) ? countOf(root, '2026-10-31', 'notebook') : 0;
  assert.equal(usedAfterNotFound, 0, '不得烧当日额度');
  assert.equal(fs.existsSync(usagePath(root)), false, '连计数文件都不该被创建');
  assert.equal(store.status('notebook').exists, false);
  assert.equal(store.status('notebook').usedToday, 0);

  // 随后正常写一次：额度只 +1（不是 +2，说明前面那次空删除真的没计数）
  store.write('notebook', '第一行\r\n');
  assert.equal(countOf(root, '2026-10-31', 'notebook'), 1);
  assert.equal(store.status('notebook').usedToday, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '第一行\r\n');
});

// 82. 连点两次 delete（文件不存在）也不累积额度
test('对不存在的文件连点两次 remove，额度仍是 0 且目录里没有新文件', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  for (let i = 0; i < 3; i += 1) {
    const result = store.remove('notebook');
    assert.equal(result.removed, false);
    assert.equal(result.reason, 'not-found');
  }
  assert.equal(fs.existsSync(diaryPath(root, NOTEBOOK)), false);
  assert.deepEqual(fs.readdirSync(root), []);
  const usedAfterNotFounds = fs.existsSync(usagePath(root)) ? countOf(root, '2026-10-31', 'notebook') : 0;
  assert.equal(usedAfterNotFounds, 0);

  // 两个文件各自独立：privy 也存在时正常删，只加 privy 的额度
  store.write('privy', 'P\r\n');
  const privyResult = store.remove('privy');
  assert.equal(privyResult.removed !== false, true, '存在且非空的文件仍走正常软删除');
  assert.equal(countOf(root, '2026-10-31', 'privy'), 2);
  assert.equal(countOf(root, '2026-10-31', 'notebook'), 0);
});

// 83. 既有行为不变：文件存在但正文为空，remove 仍算一次写
test('文件存在但正文为空时 remove 仍算一次写入（不早退、仍不产生备份）', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.write('notebook', '');
  assert.equal(fs.existsSync(diaryPath(root, NOTEBOOK)), true, '前置：文件已存在且为 0 字节');
  assert.equal(fs.statSync(diaryPath(root, NOTEBOOK)).size, 0);

  const result = store.remove('notebook');
  assert.notEqual(result.removed, false, '存在（即使为空）不属 not-found 分支');
  assert.equal(result.reason, undefined);
  assert.equal(result.bytes, 0);
  assert.equal(fs.existsSync(diaryPath(root, NOTEBOOK)), true);
  assert.equal(fs.statSync(diaryPath(root, NOTEBOOK)).size, 0);
  assert.equal(store.listBackups('notebook').length, 0, '空内容没有旧版本可备份');
  assert.equal(countOf(root, '2026-10-31', 'notebook'), 2, 'write + remove 各计一次');
});

// 84. 早退发生在额度检查之前：额度用尽也不影响「没东西可删」
test('当日额度用尽时，对不存在的文件 remove 仍返回 not-found 而不是 daily-write-limit', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 1 } });
  store.write('notebook', 'a\r\n');
  expectCode(() => store.write('notebook', 'b\r\n'), 'daily-write-limit');
  assert.equal(countOf(root, '2026-10-31', 'notebook'), 1);

  // notebook 已存在 → 正常路径会撞额度（既有语义）；privy 不存在 → 早退，不碰额度也不抛错
  expectCode(() => store.remove('notebook'), 'daily-write-limit');
  const notFound = store.remove('privy');
  assert.equal(notFound.removed, false);
  assert.equal(notFound.reason, 'not-found');
  assert.equal(fs.existsSync(diaryPath(root, PRIVY)), false);
  assert.equal(fs.readFileSync(diaryPath(root, NOTEBOOK), 'utf8'), 'a\r\n', '被额度拒掉的删除不得动文件');
});

// 85. not-found 不与 bad-which / path-escape 混淆
test('remove 的 not-found 早退不影响 bad-which 与 path-escape 的语义', () => {
  const root = makeRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-diary-outside-'));
  created.push(outside);
  const outsideFile = path.join(outside, 'outside.txt');
  fs.writeFileSync(outsideFile, '外部内容\r\n');

  const store = createDiaryStore({ root, now: () => BASE_MS, limits: { dailyWrites: 99 } });
  // 不存在 → 返回体；非法 which → 抛错；两者不得混淆
  assert.equal(store.remove('notebook').reason, 'not-found');
  expectCode(() => store.remove('Notebook'), 'bad-which');
  expectCode(() => store.remove(''), 'bad-which');
  expectCode(() => store.remove(null), 'bad-which');

  // 文件被换成符号链接（即使目标存在）仍是 path-escape，不是 not-found
  fs.mkdirSync(path.dirname(diaryPath(root, NOTEBOOK)), { recursive: true });
  fs.symlinkSync(outsideFile, diaryPath(root, NOTEBOOK), 'file');
  expectCode(() => store.remove('notebook'), 'path-escape');
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), '外部内容\r\n');
});

// 86. 早退路径同样只读，不产生备份/审计/临时文件
test('对不存在的文件 remove 不留备份、审计与临时文件（纯读操作）', () => {
  const root = makeRoot();
  const store = createDiaryStore({ root, now: () => BASE_MS });
  store.remove('notebook');
  store.remove('privy');
  assert.equal(fs.existsSync(path.join(root, 'state')), false, 'state 目录都不该被创建');
  assert.equal(fs.existsSync(auditPathOf(root)), false, '不得写审计');
  assert.equal(fs.existsSync(backupDirOf(root, 'notebook')), false, '不得建备份目录');
  assert.equal(store.listBackups('notebook').length, 0);
  assert.deepEqual(store.readAudit(50), []);
});
cleanup();
console.log(`\n🎉 Fish Diary 存储模块 ${passed}/${passed + failed} 通过`);
if (failed > 0) process.exitCode = 1;