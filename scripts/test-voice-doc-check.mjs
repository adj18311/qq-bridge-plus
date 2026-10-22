// 「语音能力发布契约」断言的负向回归。
//
// 纯净代码包不带 README / docs，所以原来针对 docs/guides/VOICE-TOOLS.md 的断言改成了对
// 代码与包元数据的断言（见 scripts/voice-doc-check.mjs 的注释）。本脚本复用同一套纯函数 /
// 薄 fs 包装，在 os.tmpdir() 的临时副本上做红/绿对照，证明门禁不是永远为真：
//   1. 生产包 → 绿（只读，绝不改）
//   2. 合法夹具 → 绿
//   3. 缺 package.json → 红（missing-package，不是 skip）
//   4. 缺 send-voice 包脚本 → 红
//   5. 缺 test-voice 包脚本 → 红
//   6. 缺 scripts/send-voice.mjs → 红
//   7. 缺 scripts/test-voice.mjs → 红
//   8. 重新塞回外置 voice-gui / voice-cli 脚本 → 红
//   9. 包脚本指向 voice-tool → 红
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

const prodPkgPath = path.join(REPO_ROOT, 'package.json');
const prodPkgText = fs.readFileSync(prodPkgPath, 'utf8');

console.log('## 生产包（只读）：语音发布契约必须判绿');
const prod = checkVoiceDoc(REPO_ROOT);
ok(prod.ok, '生产包语音发布契约判绿', prod.ok ? `${prod.checks.length} 项检查` : JSON.stringify(prod.failures));
ok(prod.checks.some((c) => c.id === 'package-json' && c.ok), '生产 package.json 存在性检查通过');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-pack-check-'));

const basePkg = {
  name: 'voice-pack-fixture',
  version: '1.1.0',
  private: true,
  scripts: {
    'send-voice': 'node scripts/send-voice.mjs',
    'test-voice': 'node scripts/test-voice.mjs',
    'test-voice:gui': 'node scripts/test-voice-gui.mjs',
  },
};
const baseFiles = {
  [path.join('scripts', 'send-voice.mjs')]: '// fixture: voice core',
  [path.join('scripts', 'test-voice.mjs')]: '// fixture: voice tests',
  [path.join('scripts', 'test-voice-gui.mjs')]: '// fixture: voice gui tests',
};
const pkgJson = (pkg) => JSON.stringify(pkg, null, 2);

const seed = ({ pkgText = pkgJson(basePkg), files = baseFiles } = {}) => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  if (pkgText !== null) fs.writeFileSync(path.join(tmpRoot, 'package.json'), pkgText);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
};

console.log('## 临时副本：合法夹具判绿');
seed();
const legal = checkVoiceDoc(tmpRoot);
ok(legal.ok, 'os.tmpdir() 里的合法夹具判绿', legal.ok ? `${legal.checks.length} 项检查` : JSON.stringify(legal.failures));

console.log('## 临时副本：缺 package.json 必须判红（不是 skip）');
seed({ pkgText: null });
const missing = checkVoiceDoc(tmpRoot);
ok(!missing.ok, '缺 package.json 判红');
ok(sameIds(missing, ['missing-package']), '失败原因是 missing-package', JSON.stringify(ids(missing)));
ok(missing.checks.some((c) => c.id === 'package-json' && c.ok === false), '包元数据检查显式为 false（不是被跳过）');

console.log('## 临时副本：缺语音包脚本必须判红');
{
  const pkg = JSON.parse(JSON.stringify(basePkg));
  delete pkg.scripts['send-voice'];
  seed({ pkgText: pkgJson(pkg) });
  const r = checkVoiceDoc(tmpRoot);
  ok(!r.ok && sameIds(r, ['send-voice-script']), '缺 send-voice 包脚本判红（且只报这一条）', JSON.stringify(ids(r)));
}
{
  const pkg = JSON.parse(JSON.stringify(basePkg));
  delete pkg.scripts['test-voice'];
  seed({ pkgText: pkgJson(pkg) });
  const r = checkVoiceDoc(tmpRoot);
  ok(!r.ok && sameIds(r, ['test-voice-script']), '缺 test-voice 包脚本判红（且只报这一条）', JSON.stringify(ids(r)));
}

console.log('## 临时副本：缺语音文件必须判红');
{
  const files = { ...baseFiles };
  delete files[path.join('scripts', 'send-voice.mjs')];
  seed({ files });
  const r = checkVoiceDoc(tmpRoot);
  ok(!r.ok && sameIds(r, ['voice-core-file']), '缺 scripts/send-voice.mjs 判红（且只报这一条）', JSON.stringify(ids(r)));
}
{
  const files = { ...baseFiles };
  delete files[path.join('scripts', 'test-voice.mjs')];
  seed({ files });
  const r = checkVoiceDoc(tmpRoot);
  ok(!r.ok && sameIds(r, ['voice-test-file']), '缺 scripts/test-voice.mjs 判红（且只报这一条）', JSON.stringify(ids(r)));
}

console.log('## 临时副本：外置 voice-tool 必须判红（纯净包不带它）');
{
  const pkg = JSON.parse(JSON.stringify(basePkg));
  pkg.scripts['voice-gui'] = 'node voice-gui.mjs';
  seed({ pkgText: pkgJson(pkg) });
  const r = checkVoiceDoc(tmpRoot);
  ok(!r.ok && sameIds(r, ['no-voice-gui-script']), '重新塞回 voice-gui 包脚本判红（且只报这一条）', JSON.stringify(ids(r)));
}
{
  const pkg = JSON.parse(JSON.stringify(basePkg));
  pkg.scripts['voice-cli'] = 'node voice-cli.mjs';
  seed({ pkgText: pkgJson(pkg) });
  const r = checkVoiceDoc(tmpRoot);
  ok(!r.ok && sameIds(r, ['no-voice-cli-script']), '重新塞回 voice-cli 包脚本判红（且只报这一条）', JSON.stringify(ids(r)));
}
{
  const pkg = JSON.parse(JSON.stringify(basePkg));
  pkg.scripts['legacy-voice'] = 'cd ../voice-tool && node legacy.mjs';
  seed({ pkgText: pkgJson(pkg) });
  const r = checkVoiceDoc(tmpRoot);
  ok(!r.ok && sameIds(r, ['no-external-voice-tool']), '包脚本指向 voice-tool 判红（且只报这一条）', JSON.stringify(ids(r)));
}

console.log('## 纯函数入口：空正文等同缺失');
const empty = checkVoiceDocText('');
ok(!empty.ok && sameIds(empty, ['missing-package']), 'checkVoiceDocText("") 判红 missing-package');

console.log('## 旧导出名仍可用（纯净包不再依赖 docs）');
ok(VOICE_DOC_REL === 'package.json', 'VOICE_DOC_REL 兼容名指向包元数据');

console.log('## 生产 package.json 未被改动');
ok(fs.readFileSync(prodPkgPath, 'utf8') === prodPkgText, '生产 package.json 内容未变');

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
