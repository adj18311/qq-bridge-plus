/**
 * t70 · 独立验证 t69-B：`scripts/test-snowluma-upstream-health.mjs` 的注释剥离是否真的变成单趟扫描。
 *
 * 纪律（本文件是验证方自己的探针，不是实现方用例的转抄）：
 *   · 被测实现 = 从**被测文件源码里抽出来的** `stripComments`，在 VM 里求值后直接调用；
 *   · 参照实现 = 我自己写的「旧顺序」（先剔块注释、再剔行注释）—— 它就是 t69 要替换掉的旧写法；
 *   · 载荷性 = 同一夹具上两实现的可量化差异（旧顺序吞掉的真源码字节数）；
 *   · 只读 src/ 与 scripts/，不写任何被测文件。
 *
 * 用法：node scripts/verify-snowluma-upstream-health.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const testFile = path.join(root, 'scripts/test-snowluma-upstream-health.mjs');
const src = fs.readFileSync(testFile, 'utf8');
const bridgeSource = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');

/** 从被测文件里抽出 stripComments 实现（不是我自己重写一份 —— 那样验的是我自己）。 */
const start = src.indexOf('function stripComments(src) {');
assert.ok(start > 0, '必须能在被测文件里定位 stripComments 实现');
const rel = src.slice(start).search(/\r?\n\}/);          // 第一个「行首 }」（= 函数结尾）
assert.ok(rel > 0, '必须能定位 stripComments 的函数结尾');
const endIdx = start + rel + (src[start + rel] === '\r' ? 3 : 2);   // \r\n} → +3；\n} → +2
const implText = src.slice(start, endIdx);
const context = {};
vm.createContext(context);
vm.runInContext(`${implText}\nthis.stripComments = stripComments;`, context);
const stripComments = context.stripComments;
assert.equal(typeof stripComments, 'function', '必须成功提取 stripComments');

/** 旧顺序（先块后行）—— 反证参照，我自己写。 */
const oldOrderStrip = (text) => String(text).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
/** 新顺序（先行后块）—— 作为「另一种错」的对照，说明**顺序不是解药、单趟扫描才是**。 */
const lineThenBlockStrip = (text) => String(text).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`✅ ${name}`); }
  catch (error) { failures += 1; console.error(`❌ ${name}\n   ${error?.message ?? error}`); }
};

// ── X1：行注释里的 `/*` 不再吞真源码（量化）────────────────────────────────────────
check('X1 行注释里的 /* ⇒ 新实现一行不少；旧顺序吞掉 ≥30KB（量化反证）', () => {
  const filler = Array.from({ length: 1600 }, (_, i) => `const filler${i} = ${i};`).join('\n');
  const fixture = `// 说明里出现 compaction/* 这种片段（t57 的真实形态）\n${filler}\nconst 目标标记 = 1;\n/* 尾块注释 */\n`;
  assert.ok(filler.length >= 30000, `夹具必须 ≥30KB：实测 ${filler.length}`);
  const oldOut = oldOrderStrip(fixture);
  const newOut = stripComments(fixture);
  const keepOld = oldOut.split('\n').filter((l) => l.startsWith('const filler')).length;
  const keepNew = newOut.split('\n').filter((l) => l.startsWith('const filler')).length;
  assert.equal(keepOld, 0, '旧顺序必须把中间真源码全吞掉（这正是 bug 本体，让断言是载荷的）');
  assert.equal(keepNew, 1600, '新实现必须一行不少地保留真源码');
  assert.match(newOut, /const 目标标记 = 1;/, '新实现必须保留注释之后的代码');
  assert.doesNotMatch(newOut, /compaction/, '注释内容本身仍必须被剔除');
  const delta = newOut.length - oldOut.length;
  assert.ok(delta >= 30000, `新实现保留的字节必须比旧顺序多 ≥30KB：实测 ${delta}`);
  console.log(`   [量化] 同一夹具：旧顺序保留 filler 行 ${keepOld}/1600、新实现 ${keepNew}/1600；字节差 ${delta}`);
});

// ── X2：块注释里的 `//`、字符串/模板串里的 `//` 与 `/*` 不被误吃；换行守恒 ──────────
check('X2 块注释里的 // 与字符串/模板串里的 //、/* 不被误吃；换行数守恒（行号一致）', () => {
  const fixture = [
    '/* 块注释：https://example.com/a//b 不许外溢 */',
    'const url = "https://x//y";',
    "const re = '/* not a comment */';",
    'const tpl = `/* 模板串里的 */ 与 // 都不是注释`;',
    'const esc = "引号 \\" 后的 // 不是注释";',
    '// 真正的行注释',
    'const 尾 = 1;',
    '',
  ].join('\n');
  const out = stripComments(fixture);
  assert.equal(out.split('\n').length, fixture.split('\n').length, '换行数必须守恒（行号一致）');
  assert.match(out, /const url = "https:\/\/x\/\/y";/, '字符串里的 // 必须原样保留');
  assert.match(out, /const re = '\/\* not a comment \*\/';/, '字符串里的 /* 必须原样保留');
  assert.match(out, /const tpl = `\/\* 模板串里的 \*\/ 与 \/\/ 都不是注释`;/, '模板串内容必须原样保留');
  assert.match(out, /const 尾 = 1;/, '行注释之后的代码必须保留');
  assert.doesNotMatch(out, /不许外溢/, '块注释内容必须被剔除');
  assert.doesNotMatch(out, /真正的行注释/, '行注释内容必须被剔除');
  // 对照：先块后行（旧）会吃掉模板串/字符串里的内容（说明「顺序」本身也是坑，单趟才稳）
  const oldOut = oldOrderStrip(fixture);
  assert.notEqual(oldOut, out, '两种顺序在同一夹具上必须可区分（否则本条对照没有信息量）');
  console.log(`   [对照] 旧顺序输出长度=${oldOut.length}，单趟实现=${out.length}（新实现多保留 ${out.length - oldOut.length} 字符）`);
});

// ── X3：真实 bridge.js 上的量化 + 换行守恒 ──────────────────────────────────────────
check('X3 真实 src/bridge.js：新实现比旧顺序多保留 ≥30KB 真源码，且换行数守恒', () => {
  const oldOut = oldOrderStrip(bridgeSource);
  const newOut = stripComments(bridgeSource);
  const delta = newOut.length - oldOut.length;
  assert.ok(delta >= 30000, `真实文件上必须多保留 ≥30KB：实测 ${delta} 字节`);
  assert.equal(newOut.split('\n').length, bridgeSource.split('\n').length, '真实文件上换行数必须守恒（行号一致）');
  assert.ok(bridgeSource.length - newOut.length < 400000, '新实现剔除的必须只是注释（不得吃掉整段源码）');
  console.log(`   [量化] bridge.js ${bridgeSource.length} 字节 ⇒ 单趟剔除 ${bridgeSource.length - newOut.length}、旧顺序剔除 ${bridgeSource.length - oldOut.length}（差 ${delta}）`);
});

// ── X4：既有断言未被弱化 / 实现真的被接到两处调用点 ─────────────────────────────────
check('X4 9 条既有用例与 4 条 t69-B fixture 全部在；codeOf 与 loginCall 处都改用单趟实现；无旧顺序残留', () => {
  const caseNames = [...src.matchAll(/^test\('([^']+)'/gm)].map((m) => m[1]);
  assert.equal(caseNames.length, 13, `用例数必须是 9 旧 + 4 新 = 13：实测 ${caseNames.length}`);
  for (const name of [
    'SnowLuma 客户端库不低于 bot_status 出现的版本（1.14.17）', '客户端库确实可被纯 Node ESM 解析（postinstall 补丁的成果）',
    '桥接订阅了「上游还活着」的证据（onEvent）', '桥接订阅了 bot_status（账号上下线），且对老运行时优雅降级',
    'good 取自心跳 status.good / get_status —— 绝不能取自 get_login_info', '静默检测不得声称能判断 hook 死活（心跳是本地生成的）',
    '/api/status 暴露 snowluma 健康快照，且只给操作者', '控制台有对应的告警条与卡片', '端点自愈可关，且默认保持「跟随」（向后兼容）',
  ]) assert.ok(caseNames.includes(name), `既有用例必须一字不改地保留：${name}`);
  assert.match(src, /const codeOf = \(src\) => stripComments\(src\);/, 'codeOf 必须接到单趟实现');
  assert.equal((src.match(/stripComments\(/g) ?? []).length, 2, '必须只有「1 处定义 + 1 处 codeOf 调用」（唯一实现、无第二份内联副本）');
  assert.match(src, /const loginCall = bridgeCode\.slice\(/, 'loginCall 必须直接切已剥离的 bridgeCode（= 共用同一实现，不再有第二处内联剥离）');
  assert.match(src, /const bridgeCode = codeOf\(/, 'bridgeCode 必须来自 codeOf（单趟实现的唯一出口）');
  assert.ok(!/replace\(\/\\\/\\\*\[\\s\\S\]\*\?\\\/\\\*\\\/\/g/.test(src), '不得残留「先剔块注释」的旧链路');
  assert.equal((src.match(/function stripComments\(src\) \{/g) ?? []).length, 1, '单趟实现必须只有一份');
  assert.match(stripComments(bridgeSource), /noteReceiveHealth\(/, '剥离后的 bridge.js 必须仍含被测语义（说明真源码没被吞）');
  console.log(`   [证据] 用例 ${caseNames.length} 条（9 旧 + 4 新）；stripComments 出现 ${(src.match(/stripComments\(/g) ?? []).length} 处（1 定义 + 1 codeOf）；loginCall 切的就是 codeOf 的输出`);
});

// ── X5：载荷性反证 —— 把实现换回旧顺序 ⇒ X1/X3 的断言必然转红 ──────────────────────
check('X5 载荷性反证：把实现换成旧顺序后，X1/X3 的核心断言必然失败（证明断言加载在顺序修复上）', () => {
  const swapped = (text) => oldOrderStrip(text);
  const filler = Array.from({ length: 1600 }, (_, i) => `const filler${i} = ${i};`).join('\n');
  const fixture = `// 说明里出现 compaction/*\n${filler}\nconst 目标标记 = 1;\n/* 尾块注释 */\n`;
  const keep = swapped(fixture).split('\n').filter((l) => l.startsWith('const filler')).length;
  assert.equal(keep, 0, '回退成旧顺序后真源码被吞（= X1 的 keepNew=1600 断言会红）');
  const delta = stripComments(bridgeSource).length - swapped(bridgeSource).length;
  assert.ok(delta >= 30000, '回退成旧顺序后真实文件差 ≥30KB（= X3 的 delta 断言会红）');
  console.log('   [反证] 旧顺序：夹具真源码保留 0/1600、真实文件少保留 ≥30KB ⇒ X1/X3 必红（断言是载荷的）');
});

console.log(`\n通过 ${5 - failures} 项，失败 ${failures} 项`);
if (failures) process.exitCode = 1;
