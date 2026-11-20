// 负向回归：验证「语音工具权威文档」断言在缺东西时真的判红。
//
// 背景：`scripts/test-voice-system.mjs` 原来无条件 `read('README.md')`，而根 README.md 已被
// 用户删除 —— 唯一的已知审计失败。修法是把文档断言迁到随仓库跟踪的
// `docs/guides/VOICE-TOOLS.md`，并且**不允许 skip**：文档缺失就是回归。
//
// 但"不 skip"本身也要有证据，否则断言可能只是永远为真的空检查。本脚本因此复用
// `scripts/voice-doc-check.mjs` 的纯函数，在 `os.tmpdir()` 下的临时副本上做红/绿对照：
//   1. 生产文档 → 绿（只读，绝不改）
//   2. 合法副本 → 绿
//   3. 缺文档 → 红（missing-doc，不是 skip）
//   4. 缺 voice-gui.mjs → 红
//   5. 缺 voice-cli.mjs → 红
//   6. 缺「AI 发语音默认关闭」→ 红
//   7. 文档里塞本机绝对路径 → 红
//
// 只读文件 + 临时目录：不启动服务、不发消息、不联网。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, VOICE_DOC_REL, checkVoiceDoc, checkVoiceDocText } from './voice-doc-check.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};
const ids = (result) => result.failures.map((f) => f.id).sort();
const sameIds = (result, expected) => JSON.stringify(ids(result)) === JSON.stringify([...expected].sort());

const prodPath = path.join(REPO_ROOT, VOICE_DOC_REL);
const prodText = fs.readFileSync(prodPath, 'utf8');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-doc-check-'));
const tmpDoc = path.join(tmpRoot, VOICE_DOC_REL);

const seed = (text) => {
  fs.mkdirSync(path.dirname(tmpDoc), { recursive: true });
  fs.writeFileSync(tmpDoc, text);
};
const clearDoc = () => fs.rmSync(path.dirname(tmpDoc), { recursive: true, force: true });

console.log('## 生产文档（只读）：合法文档必须判绿');
const prod = checkVoiceDoc(REPO_ROOT);
ok(prod.ok, '生产 docs/guides/VOICE-TOOLS.md 判绿', prod.ok ? `${prod.checks.length} 项检查` : JSON.stringify(prod.failures));
ok(prod.checks.some((c) => c.id === 'doc-exists' && c.ok), '生产文档存在性检查通过');

console.log('## 临时副本：合法文档判绿');
seed(prodText);
const legal = checkVoiceDoc(tmpRoot);
ok(legal.ok, 'os.tmpdir() 里的合法副本判绿', legal.ok ? `${legal.checks.length} 项检查` : JSON.stringify(legal.failures));

console.log('## 临时副本：缺文档必须判红（不是 skip）');
clearDoc();
const missing = checkVoiceDoc(tmpRoot);
ok(!missing.ok, '缺 docs/guides/VOICE-TOOLS.md 判红');
ok(sameIds(missing, ['missing-doc']), '失败原因是 missing-doc', JSON.stringify(ids(missing)));
ok(missing.checks.some((c) => c.id === 'doc-exists' && c.ok === false), '存在性检查显式为 false（不是被跳过）');

console.log('## 临时副本：缺入口名必须判红');
seed(prodText.replaceAll('voice-gui.mjs', 'voice-gui'));
const noGui = checkVoiceDoc(tmpRoot);
ok(!noGui.ok && sameIds(noGui, ['voice-gui']), '缺 voice-gui.mjs 判红（且只报这一条）', JSON.stringify(ids(noGui)));

seed(prodText.replaceAll('voice-cli.mjs', 'voice-cli'));
const noCli = checkVoiceDoc(tmpRoot);
ok(!noCli.ok && sameIds(noCli, ['voice-cli']), '缺 voice-cli.mjs 判红（且只报这一条）', JSON.stringify(ids(noCli)));

console.log('## 临时副本：缺「AI 发语音默认关闭」必须判红');
seed(prodText.replaceAll('AI 发语音默认关闭', 'AI 语音在需要时开启'));
const noDefaultOff = checkVoiceDoc(tmpRoot);
ok(!noDefaultOff.ok && sameIds(noDefaultOff, ['default-off']), '缺默认关闭表述判红（且只报这一条）',
  JSON.stringify(ids(noDefaultOff)));

console.log('## 临时副本：本机绝对路径必须判红（文档不该变成作者机器说明书）');
seed(prodText + '\n示例：D:\\somewhere\\voice-tool\n');
const absPath = checkVoiceDoc(tmpRoot);
ok(!absPath.ok && sameIds(absPath, ['no-absolute-windows-path']), '带盘符的 Windows 绝对路径判红',
  JSON.stringify(ids(absPath)));

console.log('## 纯函数入口：空正文等同缺失');
const empty = checkVoiceDocText('');
ok(!empty.ok && sameIds(empty, ['missing-doc']), 'checkVoiceDocText("") 判红 missing-doc');

console.log('## 生产文档未被改动');
ok(fs.readFileSync(prodPath, 'utf8') === prodText, '生产 docs/guides/VOICE-TOOLS.md 内容未变');

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
