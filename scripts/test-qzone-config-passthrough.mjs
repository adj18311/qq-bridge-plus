// G1 定向验证：src/bridge.js 的 qzone 顶层键透传（默认关闭 / 严格 true / 配置兼容）。
//
// 为什么需要这个文件
// ------------------
// src/core/runtime-config.mjs 的 parseRuntimeConfig 是【白名单拼接】：它只把认识的键搬进
// cfg，其余顶层键被【静默丢弃】。实测（本文件 T1 钉住）：把 qzone 塞进输入对象，返回的
// cfg.qzone 仍是 undefined。于是 src/bridge.js 里那句
//     if (cfg.qzone?.consoleApprovals === true) { ... }
// 恒为 false —— 即便有人往 config.json 里写 qzone.consoleApprovals:true 也打不开审批路由。
// 这就是只读验证阶段发现的缺口 G1。修法是照抄 backgroundPatrol / ownerNotice 的透传写法，
// 在 loadConfig() 里把 file.qzone 原样搬到 cfg 上。
//
// 为什么不 import src/bridge.js 来测
// ----------------------------------
// loadConfig() 不是导出函数，而且 bridge.js 是【入口脚本】：import 它会执行整个模块（读配置、
// 抢单实例锁、连 SnowLuma……）。本文件因此走【纯离线】的两条路：
//   · 真实行为：只 import src/core/runtime-config.mjs 这个纯函数模块，证明透传的必要性；
//   · 结构形状：读 src/bridge.js 源码 + 正则/花括号配对解析，断言透传块的存在与形状。
// 这条路线照抄 scripts/test-qzone-console-dispatch-status.mjs 已有的做法。
//
// ⚠️ 本文件能证明什么、不能证明什么（G1 终审：措辞边界，逐字遵守）
// ---------------------------------------------------------------------------
// CAN：
//   · src/bridge.js 源码里那个【字面条件表达式】`cfg.qzone?.consoleApprovals === true` 的求值行为
//     （T8/T9：从源码抽取原文，再用 new Function 求值，不是测试里另写一个等价式）；
//   · 透传块的形状与位置（guard 原文、赋值原文、在 loadConfig() 内、三处同形）——T2/T3；
//   · parseRuntimeConfig 【丢弃】qzone 这个事实（T1），以及它对当前真实 config.json 的行为不变（T11）；
//   · 开关的源码结构与网络调用点的相对位置（T10：动态 import 在开关块内、开关块内无 fetch、
//     唯一的 fetch 在 getIdentity 回调里且目标被正则强制为回环地址）。
// CANNOT（Codex 终审提醒，必须显式承认）：
//   · **没有**证明 loadConfig() 在运行时真的执行过 —— 那需要启动 bridge，本任务明令禁止；
//   · **没有**证明 cfg 在【真实启动路径】上被那样构造（本文件是源码文本 + 纯函数，不是运行时装配）；
//   · **没有**做端到端装配验证：源码抽取只能证明「这个表达式的行为」，不能称作「bridge 实际装配路径的
//     端到端验证」。谁要那个结论，谁就得启动一次桥接并观察真实 cfg（本文件不提供该证据）；
//   · 也没有证明透传之后的 cfg.qzone 内容被校验过 —— 它是【原样】搬运，garbage in, garbage out，
//     开关仍只认 `=== true`，其它任何形状都等于关闭（T4/T6/T9 钉住）。
//   · T10 的「不触发真实网络」是【结构 + 绊线】证据，不是抓包证据：它证明本测试自身没发起任何 fetch、
//     证明开关关闭时 qzone-production-wiring.mjs 不会被 import、且唯一 fetch 被限制在回环地址；
//     但它**不**声称「开关关闭 ⇒ 桥接一次网络调用都不发」——见 T10 内部关于 openQzoneConsoleRuntime
//     与 getIdentity 的诚实说明。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parseRuntimeConfig } from '../src/core/runtime-config.mjs';

const BRIDGE_URL = new URL('../src/bridge.js', import.meta.url);
const raw = await readFile(BRIDGE_URL, 'utf8');

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 源码预处理：去注释（保留字符串），以及去注释 + 抹掉字符串内容（用于花括号配对）
//
// 为什么需要两套：
//   · 判断 `Object.prototype.hasOwnProperty.call(file, 'qzone')` 必须保留字符串字面量；
//   · 但要可靠地找「if 块的结束花括号」，字符串里的 { } 会破坏配对，所以另做一份把字符串
//     内容替换成空格的版本。两套都保留换行，行号因此可以直接换算。
//
// 为什么不能简单用正则 //.*$：bridge.js 里有 'ws://127.0.0.1:3001'、`http://127.0.0.1:${port}`
// 这类含 // 的字符串，粗暴替换会把代码吃掉。这里用一个最小状态机。
// ══════════════════════════════════════════════════════════════════════════════════════════════
function scan(src, { maskStrings }) {
  const out = [];
  const n = src.length;
  let i = 0;
  let state = 'code';
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (ch === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (ch === "'") { state = 'single'; out.push(ch); i += 1; continue; }
      if (ch === '"') { state = 'double'; out.push(ch); i += 1; continue; }
      if (ch === '\u0060') { state = 'template'; out.push(ch); i += 1; continue; }
      out.push(ch); i += 1; continue;
    }
    if (state === 'line') {
      // 注释字符必须【替换】而不是【丢弃】，否则输出与原文的字符偏移会错位，
      // 后面「用 codeSource 的匹配位置去 structural 里取块体」的写法会静默取到错误的块。
      if (ch === '\n') { state = 'code'; out.push('\n'); } else out.push(' ');
      i += 1; continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; i += 2; continue; }
      out.push(ch === '\n' ? '\n' : ' ');
      i += 1; continue;
    }
    // 字符串 / 模板字面量
    if (ch === '\\') {
      out.push(ch);
      if (maskStrings) out.push(' ');
      else if (i + 1 < n) out.push(src[i + 1]);
      i += 2; continue;
    }
    if (state === 'single' && ch === "'") { state = 'code'; out.push(ch); i += 1; continue; }
    if (state === 'double' && ch === '"') { state = 'code'; out.push(ch); i += 1; continue; }
    if (state === 'template' && ch === '\u0060') { state = 'code'; out.push(ch); i += 1; continue; }
    out.push(maskStrings && ch !== '\n' ? ' ' : ch);
    i += 1; continue;
  }
  return out.join('');
}

/** 注释被抹成空格、字符串原样保留。 */
const codeSource = scan(raw, { maskStrings: false });
/** 注释被抹掉、字符串内容被抹成空格（引号保留）。 */
const structural = scan(raw, { maskStrings: true });

/** 1-based 行号。 */
const lineOf = (source, index) => source.slice(0, index).split('\n').length;

/** 从 openIndex 指向的 '{' 开始，返回与之配对的 '}' 下标（结构源上做，可靠）。 */
function matchBrace(source, openIndex) {
  assert.equal(source[openIndex], '{', 'matchBrace 必须从 { 开始');
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('花括号未配对（源码被改动或预处理失效）');
}

/** 取【第一个】匹配块体的完整内容（含外层花括号）。 */
function blockAt(source, matchIndex, matchText) {
  const openIndex = matchIndex + matchText.length - 1;
  const closeIndex = matchBrace(source, openIndex);
  return { body: source.slice(openIndex, closeIndex + 1), start: openIndex, end: closeIndex };
}

// 透传 guard 的三种写法必须逐字同形：file !== null && file !== undefined && hasOwnProperty.call(file, '<key>')
const guardCode = (key) => new RegExp(
  `if\\s*\\(\\s*file\\s*!==\\s*null\\s*&&\\s*file\\s*!==\\s*undefined\\s*&&\\s*Object\\.prototype\\.hasOwnProperty\\.call\\(\\s*file\\s*,\\s*'${key}'\\s*\\)\\s*\\)\\s*\\{`,
);

/** 在结构源里定位 loadConfig() 的函数体（用于「透传必须在 loadConfig 里」这条断言）。 */
function loadConfigBody() {
  const index = structural.search(/function\s+loadConfig\s*\(\s*\)\s*\{/);
  assert.notEqual(index, -1, 'bridge.js 必须仍有 function loadConfig() { ... }（本测试的前提）');
  const open = structural.indexOf('{', index);
  const close = matchBrace(structural, open);
  return { body: structural.slice(open, close + 1), start: open, end: close };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T1 —— 必要性（真实行为，纯函数）
//
// 这就是透传存在的全部理由：parseRuntimeConfig 丢弃未知顶层键，且【不是 qzone 特殊待遇】
// —— backgroundPatrol、ownerNotice 一样被丢。谁把这条测试删掉，谁就必须先去改 runtime-config。
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('T1 必要性：parseRuntimeConfig 丢弃未知顶层键 qzone（与 backgroundPatrol 同等待遇）', () => {
  const withQzone = parseRuntimeConfig({ qzone: { consoleApprovals: true } }, 'fixture-config.json');
  assert.equal(
    Object.prototype.hasOwnProperty.call(withQzone.config, 'qzone'), false,
    '★★★ 前提：parseRuntimeConfig 不把 qzone 搬进 cfg（这正是 bridge 必须自己做透传的原因）',
  );
  assert.equal(withQzone.config.qzone, undefined);
  // 连「值本来会让开关为 true」的形状都不会漏过去；否则 bridge 的开关就不需要透传块了。
  assert.equal(withQzone.config.qzone?.consoleApprovals === true, false,
    '★ 未透传时开关求值必须是 false（不是「碰巧没有 consoleApprovals 字段」）');

  const withPatrol = parseRuntimeConfig({ backgroundPatrol: { enabled: true, paused: false } }, 'fixture-config.json');
  assert.equal(Object.prototype.hasOwnProperty.call(withPatrol.config, 'backgroundPatrol'), false,
    '★★ 同一行为对 backgroundPatrol 成立 ⇒ 这是【通用白名单】行为，不是 qzone 特例');

  const withNotice = parseRuntimeConfig({ ownerNotice: { enabled: true } }, 'fixture-config.json');
  assert.equal(Object.prototype.hasOwnProperty.call(withNotice.config, 'ownerNotice'), false,
    '★★ 同一行为对 ownerNotice 也成立 ⇒ bridge 里那三处透传是同一个已知坑的三次踩踏');

  // 对照：白名单内的键确实会被搬运，说明上面的 undefined 不是「整个函数什么都不做」。
  const known = parseRuntimeConfig({ sessionCwd: '/tmp/x', ownerQQ: '12345' }, 'fixture-config.json');
  assert.equal(known.config.sessionCwd, '/tmp/x', '对照：白名单键必须被搬运');
  // ownerQQ 走 normalizeOwnerQQ，实测被归一成 number 12345（不是字符串）—— 按实测钉，不按想象钉。
  assert.equal(String(known.config.ownerQQ), '12345', '对照：白名单键必须被搬运（ownerQQ 经归一化后为 12345）');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T2 —— 透传块存在且形状正确（源码级）
//
// 只断言「文件里出现过 cfg.qzone = file.qzone」是不够的：它可能写在别的函数里、可能只写一半。
// 所以这里解析出那个 if 的【完整块体】，再在块体内断言赋值，并断言块体【没有】顺手打开开关。
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('T2 透传块存在且形状正确：guard + 赋值在同一 if 块内，且块内不碰开关', () => {
  const guard = guardCode('qzone');
  const match = codeSource.match(guard);
  assert.ok(match, "★★★ bridge.js 必须存在 if (file !== null && file !== undefined && Object.prototype.hasOwnProperty.call(file, 'qzone')) 的透传守卫");

  // 用【同一位置】在结构源里取块体：两份源的字符偏移一致（预处理只替换字符、不增删）。
  const openIndex = match.index + match[0].length - 1;
  assert.equal(codeSource[openIndex], '{', '守卫之后必须紧跟块起始花括号');
  assert.equal(structural[openIndex], '{', '两份预处理源的偏移必须一致（否则块解析不可信）');
  const closeIndex = matchBrace(structural, openIndex);
  const body = structural.slice(openIndex, closeIndex + 1);
  const bodyLine = lineOf(structural, openIndex);
  const closeLine = lineOf(structural, closeIndex);

  // ★ 赋值必须在这个块体里（不是文件里任意位置）。
  assert.match(body, /cfg\.qzone\s*=\s*file\.qzone\s*;/,
    `★★★ 透传块（第 ${bodyLine}-${closeLine} 行）内必须原样搬运 file.qzone`);
  // 块体只允许这一条语句：多出来的语句（尤其碰 consoleApprovals / 写磁盘的）都必须先改这条测试。
  const statements = body.slice(1, -1).split(';').map((part) => part.trim()).filter(Boolean);
  assert.deepEqual(statements, ['cfg.qzone = file.qzone'],
    '★★ 透传块必须只有一条语句（目前实测：单条原样搬运）');
  // ★ 透传绝不自己打开开关：谁在这里写 consoleApprovals，谁就是把「原样透传」升级成「配置生效」，必须显式复核。
  assert.equal(/consoleApprovals/.test(body), false,
    '★★★ 透传块内不得出现 consoleApprovals（透传只搬运，不决定是否开启）');
  assert.equal(/writeFileSync|atomicWriteJson|writeFile/.test(body), false,
    '★★ 透传块内不得写磁盘（透传是内存操作，绝不回写 config.json）');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T3 —— 透传位于 loadConfig() 内，且照抄既有两处（backgroundPatrol / ownerNotice）的形状
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('T3 透传在 loadConfig() 内，且与 backgroundPatrol / ownerNotice 三处同形', () => {
  const fn = loadConfigBody();
  const qzoneMatch = codeSource.match(guardCode('qzone'));
  assert.ok(qzoneMatch);
  const qzoneOpen = qzoneMatch.index + qzoneMatch[0].length - 1;
  assert.ok(qzoneOpen > fn.start && qzoneOpen < fn.end,
    `★★★ qzone 透传必须位于 loadConfig() 函数体内（函数体第 ${lineOf(structural, fn.start)}-${lineOf(structural, fn.end)} 行）`);

  // 三处守卫必须同形（照抄既有写法，而不是新发明一种）。
  for (const key of ['backgroundPatrol', 'ownerNotice', 'qzone']) {
    assert.match(codeSource, guardCode(key), `★ ${key} 的透传守卫必须存在且同形`);
  }
  // 顺序照抄：ownerNotice 之后才是 qzone（插入点与队长描述一致）。
  const ownerIndex = codeSource.search(guardCode('ownerNotice'));
  assert.ok(ownerIndex < qzoneMatch.index, '★ qzone 透传必须排在 ownerNotice 透传之后');
  // 三处都只搬一个键，赋值目标各自独立。
  for (const key of ['backgroundPatrol', 'ownerNotice', 'qzone']) {
    assert.equal(new RegExp(`cfg\\.${key}\\s*=\\s*file\\.${key}\\s*;`).test(structural), true,
      `★ cfg.${key} = file.${key}; 必须存在（与 qzone 同形）`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T4 —— 默认关闭：开关是【严格 === true】，不是 truthy / !== false / ||
//
// 这条是「默认关闭」的守门员。任何把它放宽的写法（`!== false`、`|| true`、`?? true`、
// 裸 truthy、Boolean(...)）都会让 `qzone: { consoleApprovals: 'yes' }` 或 `{ consoleApprovals: 1 }`
// 意外打开审批路由，所以这里既钉正例也钉反例。
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('T4 默认关闭：开关必须是严格的 cfg.qzone?.consoleApprovals === true，反例一律红', () => {
  const exact = [...codeSource.matchAll(/cfg\.qzone\?\.consoleApprovals\s*===\s*true/g)];
  assert.equal(exact.length, 1,
    `★★★ 全文件必须恰好一处严格开关（实测 ${exact.length} 处）；多处会让「默认关闭」不再由一行决定`);
  // ★ 改成结构定位，不再钉死行号：行号会因同文件其它合法改动而漂移（C1 的转发端点就把它从
  // 7162 推到 7173），但「开关必须在 getQzoneConsoleRuntime 内」才是真正的约束。
  const switchPos = exact[0].index;
  const fnStart = codeSource.lastIndexOf('async function getQzoneConsoleRuntime', switchPos);
  assert.notEqual(fnStart, -1,
    '★★★ 严格开关必须位于 getQzoneConsoleRuntime 函数体内（函数找不到 ⇒ 结构变了，本用例要显式重写）');
  // 函数体结束位置：从开关往后找到该函数作用域的 } —— 用与其它用例相同的花括号配对。
  const bodyOpen = codeSource.indexOf('{', codeSource.indexOf('(', fnStart));
  const bodyOpen2 = codeSource.indexOf('{', codeSource.indexOf(')', bodyOpen));
  const bodyClose = matchBrace(codeSource, bodyOpen2);
  assert.ok(switchPos > bodyOpen2 && switchPos < bodyClose,
    '★★★ 严格开关必须位于 getQzoneConsoleRuntime 函数体内；跑到别的函数里就不再受「默认关闭」这条约束');

  // 反例（每一项都对应一种「看起来还关着、其实已经开了」的写法）。
  const forbidden = [
    [/cfg\.qzone\?\.consoleApprovals\s*\|\|/, '不得用 || 兜出 truthy'],
    [/cfg\.qzone\?\.consoleApprovals\s*(?:!==|===)\s*false/, '不得用 !== false 反向判定'],
    [/cfg\.qzone\?\.consoleApprovals\s*\?\?/, '不得用 ?? 提供默认值'],
    [/!cfg\.qzone\?\.consoleApprovals/, '不得用取反'],
    [/Boolean\(\s*cfg\.qzone\?\.consoleApprovals/, '不得用 Boolean() 归一化'],
    [/!!cfg\.qzone\?\.consoleApprovals/, '不得用 !! 归一化'],
    [/\.consoleApprovals\s*===?\s*['"]true['"]/, '不得把字符串 "true" 当成开启'],
  ];
  for (const [pattern, why] of forbidden) {
    assert.equal(pattern.test(codeSource), false, `★★ 反例：源码里 ${why}（${pattern}）`);
  }
  // 允许形态只有两种：可选的严格比较（上面已钉 1 处）或纯语义的 `cfg.qzone?.consoleApprovals`
  // 出现在注释里 —— 注释已被抹掉，所以这里断言的是：除开关外没有别处引用该字段。
  const all = [...codeSource.matchAll(/consoleApprovals/g)];
  assert.equal(all.length, 1,
    `★★ 除那一处开关外不得再有 consoleApprovals 引用（实测 ${all.length} 处）`);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T5 —— 配置兼容：空对象不抛错；file 为 null 的真实行为
//
// ⚠️ 这里如实钉住一个与任务卡预期不符的实测结果：parseRuntimeConfig(null) 【会抛错】
// （'配置格式错误：<path>'），不是「不抛错」。所以：
//   · 空对象 {} 路径：解析正常，透传守卫不命中，cfg 不新增 qzone 键；
//   · null 路径：parseRuntimeConfig 在【透传之前】就抛了（bridge.js:853 调用、守卫在 :870），
//     因此 file === null 永远到不了透传块；守卫里的 `file !== null` 是纯粹的防御性冗余，
//     不是「null 会被透传」的证据。
// 把这条写成断言，是为了让下一个改配置加载顺序的人立刻看到真实行为。
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('T5 配置兼容：{} 正常解析；null 实测抛错（因此永远到不了透传块）', () => {
  const empty = parseRuntimeConfig({}, 'fixture-config.json');
  assert.equal(typeof empty.config, 'object');
  assert.equal(Object.prototype.hasOwnProperty.call(empty.config, 'qzone'), false,
    '★ 空配置不得凭空多出 qzone 键（默认关闭）');
  assert.ok(Object.keys(empty.config).length >= 10, '对照：空配置仍产出完整默认结构');

  // 实测行为：null（config.json 字面量是 null 时 readJsonSafe 会返回 null）会抛错。
  assert.throws(() => parseRuntimeConfig(null, 'fixture-config.json'), /配置格式错误/,
    '★★ 实测：parseRuntimeConfig(null) 抛「配置格式错误」——不是「不抛错」；任务卡此条预期需要更正');
  assert.throws(() => parseRuntimeConfig(undefined, 'fixture-config.json'), /配置格式错误/,
    '★ 实测：undefined 同样抛错');

  // 守卫自身的防御形状仍然要在（照抄既有两处），且必须同时排除 null 与 undefined。
  const guard = codeSource.match(guardCode('qzone'));
  assert.ok(guard, '守卫必须存在');
  assert.match(guard[0], /file\s*!==\s*null/, '★ 守卫必须显式排除 null');
  assert.match(guard[0], /file\s*!==\s*undefined/, '★ 守卫必须显式排除 undefined');

  // 而 loadConfig 的调用点在守卫之前：null 根本走不到透传。
  const fnStart = structural.indexOf('function loadConfig() {');
  const parseIndex = structural.indexOf('parseRuntimeConfig(file, p)', fnStart);
  const guardIndex = codeSource.search(/hasOwnProperty\.call\(\s*file\s*,\s*'qzone'\s*\)/);
  assert.ok(parseIndex > fnStart && parseIndex < guardIndex,
    '★★ 结构性事实：parseRuntimeConfig(file, p) 在透传守卫之前调用 ⇒ null 先在这里被拒');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T6 —— 透传不会自动打开：全文件只有一处写 cfg.qzone，且 loadConfig 不回写 config.json
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('T6 透传不会自动打开：cfg.qzone 只被写 1 次，loadConfig 不回写 config.json', () => {
  // (a) 结构源（注释已抹、字符串已抹）里统计赋值形态。
  const assignments = [...structural.matchAll(/cfg\.qzone\s*=/g)];
  assert.equal(assignments.length, 1,
    `★★★ 全文件只允许一处写 cfg.qzone（实测 ${assignments.length} 处）；多于一处即可能有「自动打开」路径`);

  // (b) 计算属性写法的绕过必须为零。
  for (const pattern of [/cfg\[\s*['"]qzone['"]\s*\]/, /Object\.assign\(\s*cfg\s*,/, /Object\.defineProperty\(\s*cfg\s*,/]) {
    assert.equal(pattern.test(codeSource), false, `★★ 不得用计算属性/合并绕过唯一的透传点（${pattern}）`);
  }

  // (c) 原始源码的行扫描：所有含 cfg.qzone 赋值的行里，只有一行不是注释。
  const assignLines = [];
  raw.split(/\r?\n/).forEach((text, index) => {
    if (!/cfg\.qzone\s*=/.test(text)) return;
    assignLines.push({ line: index + 1, trimmed: text.trim().startsWith('//'), text: text.trim() });
  });
  const real = assignLines.filter((entry) => !entry.trimmed);
  assert.equal(real.length, 1, `★★★ 非注释的 cfg.qzone 赋值必须恰好 1 行（实测 ${real.length} 行：${JSON.stringify(real)}）`);
  assert.match(real[0].text, /^cfg\.qzone\s*=\s*file\.qzone;$/,
    '★ 那一行必须就是透传赋值本身（不接受别的写法）');

  // (d) loadConfig 体内不得出现 config.json 的回写（透传是内存行为）。
  const fn = loadConfigBody();
  for (const pattern of [/writeFileSync/, /atomicWriteJson/, /writeFile\(/, /persist/]) {
    assert.equal(pattern.test(fn.body), false,
      `★★ loadConfig() 内不得回写配置文件（${pattern}）—— 透传绝不能改用户的 config.json`);
  }
  // (e) 对照：三口子都必须保留（证明 (d) 不是因为函数体没被解析到）。
  for (const key of ['backgroundPatrol', 'ownerNotice', 'qzone']) {
    assert.match(fn.body, new RegExp(`cfg\\.${key}\\s*=\\s*file\\.${key}\\s*;`),
      `对照：loadConfig() 体内必须能找到 ${key} 的透传赋值`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T7 —— 语义镜像：把源码里那两行（守卫 + 赋值 + 开关）翻译成行为
//
// ⚠️ 这【不是】执行 bridge.js，而是把 T2/T4 断言的源码文本按字面语义跑一遍，回答一个具体问题：
// 「config.json 里有 / 没有 qzone.consoleApprovals:true 时，开关分别是什么」。
// 它证明的是【语义闭合】（守卫 + 赋值 + 严格比较 三者合起来的效果），不能替代真实启动。
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('T7 语义镜像：透传后开关只认布尔 true；缺失/异常值一律关闭', () => {
  // 与 bridge.js:870-872 同形的透传（纯函数，语义逐字对应源码文本）。
  const applyPassthrough = (file) => {
    const { config: cfg } = parseRuntimeConfig(file ?? {}, 'fixture-config.json');
    if (file !== null && file !== undefined && Object.prototype.hasOwnProperty.call(file, 'qzone')) {
      cfg.qzone = file.qzone;
    }
    return cfg;
  };
  // 与 bridge.js:7162 同形的开关。
  const gate = (cfg) => (cfg.qzone?.consoleApprovals === true);
  // 与 bridge.js:7162 附近「是否把这个键传给 runtime」同形的判断。
  const forwards = (cfg) => gate(cfg);

  assert.equal(gate(applyPassthrough({})), false, '★★★ 没有 qzone 键 ⇒ 关闭（默认关闭）');
  assert.equal(forwards(applyPassthrough({})), false, '★★ 没有 qzone 键 ⇒ 选项根本不传给 runtime');
  assert.equal(gate(applyPassthrough({ qzone: {} })), false, '★ qzone 空对象 ⇒ 关闭');
  assert.equal(gate(applyPassthrough({ qzone: { consoleApprovals: true } })), true,
    '★ 显式 true ⇒ 开启（透传修复后唯一的开启路径）');
  // 严格比较：下面每一个都必须是 false，否则就是「看起来关着其实开了」。
  for (const value of [1, 'true', 'yes', {}, [], 1n]) {
    assert.equal(gate(applyPassthrough({ qzone: { consoleApprovals: value } })), false,
      `★★ 非布尔真值 ${String(value)} 不得打开开关（严格 === true）`);
  }
  // 诡异的 file.qzone 形状不得抛错，只是等于关闭（透传是原样搬运，不做校验）。
  for (const value of [null, false, 0, 'qzone', []]) {
    const cfg = applyPassthrough({ qzone: value });
    assert.equal(gate(cfg), false, `★ qzone=${JSON.stringify(value)} 时必须安全地等于关闭，且不抛错`);
  }
});


// ══════════════════════════════════════════════════════════════════════════════════════════════
// G1 终审补充用例（T8-T11）—— 默认关闭 / 严格 true 到达接线点 / 非 true 不启用 / 不触发网络 /
//                             null 与非对象 / 原有配置兼容
//
// 背景：Codex 终审要求「不能仅凭 node --check 认定完成」。允许把 file.qzone 透传当作最小候选修复，
// 但必须补定向测试覆盖上面这几件事。
//
// ⚠️ 措辞纪律（队长转达 Codex 原话）：源码抽取测试只能证明【表达式行为】，
//    不能称作 bridge 实际装配路径的端到端验证。所以 T8/T9 一律叫「源码表达式 / 读取条件的字面行为」，
//    绝不写「验证了 bridge 实际读取路径」。真实装配验证要启动一次桥接，本轮明令禁止。
// ══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * 从 codeSource 里抽出 getQzoneConsoleRuntime 的开关条件（if 括号内那一段，原样字符串）。
 * 为什么抽取而不是重写：重写的等价式一旦走样（比如写成 !== false），测试仍然全绿 ——
 * 那测的是测试自己的逻辑，不是源码的逻辑。
 */
function extractGateExpression() {
  // C3 起开关是复合条件：consoleApprovals === true || <approvalIpc 已配置>。
  // 这里只抽取【consoleApprovals 那一段子表达式】，因为后一半依赖 readQzoneApprovalIpcConfig，
  // 不在本测试的求值环境里，而且它也不是「默认关闭」的判据。
  // 仍然原样抽取（不是重写等价式），所以形式一被放宽（!== false / || / ?? / Boolean）就会红。
  const condMatch = codeSource.match(/if\s*\(([^\n]*cfg\.qzone\?\.consoleApprovals[^\n]*)\)\s*\{/);
  assert.ok(condMatch, '★★★ bridge.js 必须存在以 cfg.qzone?.consoleApprovals 为条件的 if 语句（本测试的前提）');
  const condition = condMatch[1];
  const sub = condition.match(/cfg\.qzone\?\.consoleApprovals\s*===\s*true/);
  assert.ok(sub, '★★★ consoleApprovals 那一段必须是严格的 === true（实测条件：' + condition.trim().slice(0, 120) + '）');
  return sub[0];
}
/** 从 codeSource 里抽出 qzone 透传的【整个 if 语句】（guard + 块体，原样字符串）。 */
function extractPassthroughStatement() {
  const match = codeSource.match(guardCode('qzone'));
  assert.ok(match, "★★★ bridge.js 必须存在 qzone 透传守卫（file !== null && ... hasOwnProperty.call(file, 'qzone')）");
  const openIndex = match.index + match[0].length - 1;
  const closeIndex = matchBrace(structural, openIndex);
  return { text: codeSource.slice(match.index, closeIndex + 1), start: match.index, end: closeIndex };
}

const GATE_EXPRESSION = extractGateExpression();
const PASSTHROUGH_STATEMENT = extractPassthroughStatement();

// 源码文本 -> 可求值函数：测的是源码里那一个字面表达式，不是本文件另写的等价式。
const evaluateGate = new Function('cfg', 'return (' + GATE_EXPRESSION + ');');
// 源码文本 -> (file, cfg) => void：透传语句里没有 await，可以直接求值。
const runPassthrough = new Function('file', 'cfg', PASSTHROUGH_STATEMENT.text);

/** 按 loadConfig() 的真实顺序构造 cfg：先 parseRuntimeConfig，再执行源码抽取的透传语句。 */
function cfgFromFile(file) {
  const { config: cfg } = parseRuntimeConfig(file, 'fixture-config.json');
  runPassthrough(file, cfg);
  return cfg;
}

/** 不打印值的展示（BigInt / 循环引用会让 JSON.stringify 抛错）。 */
function showValue(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T8 —— 源码表达式本身（不是等价式）：默认关闭 + 只认布尔 true
//
// 注意命名：这里测的是「bridge.js 源码中那个条件表达式的行为」，不是「bridge 实际读取路径」。
// 它不能证明 loadConfig() 在运行时执行过，也不能证明 cfg 在真实启动路径上被那样构造。
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('T8 源码表达式：bridge.js 抽取的那个字面条件只认布尔 true（默认关闭）', () => {
  assert.equal(GATE_EXPRESSION.replace(/\s+/g, ' ').trim(), 'cfg.qzone?.consoleApprovals === true',
    '★★★ 抽出来的条件必须逐字就是 cfg.qzone?.consoleApprovals === true；'
    + '抽取失效会让本文件后面所有求值变成「测另一段代码」，必须立刻修抽取规则');

  assert.equal(evaluateGate({}), false, '★★ 无 qzone 键 ⇒ 关闭（默认关闭）');
  assert.equal(evaluateGate({ qzone: undefined }), false, '★★ qzone: undefined ⇒ 关闭');
  assert.equal(evaluateGate({ qzone: null }), false, '★★ qzone: null ⇒ 关闭且不抛错（?. 短路）');
  assert.equal(evaluateGate({ qzone: {} }), false, '★ qzone: {} ⇒ 关闭');
  assert.equal(evaluateGate({ qzone: { consoleApprovals: true } }), true,
    '★★★ 严格 true ⇒ 该读取条件求值为 true（任务卡所说「到达接线点」的条件形态）。'
    + '若这里不是 true，说明即便配置真的写对了，源码里的条件也不会放行（G1 未修复）。'
    + '注意：这仍是【表达式行为】，不是真实启动装配证据（见文件头 CANNOT）');

  // 非 true 一律不得启用（严格比较；任何 truthy 放宽都等于「看起来关着其实开了」）。
  const nonTrue = [false, 'true', 'TRUE', 'yes', '', 1, 0, -1, NaN, {}, [], [true], 1n, () => true];
  for (const value of nonTrue) {
    assert.equal(evaluateGate({ qzone: { consoleApprovals: value } }), false,
      '★★★ consoleApprovals = ' + showValue(value) + ' 不得启用：开关是严格 === true，'
      + '放宽成 truthy / Boolean() / !== false 都会让这类值意外打开审批路由');
  }
  // 严格性是双向的：值对但位置不对也不启用。
  assert.equal(evaluateGate({ consoleApprovals: true }), false, '★ 顶层 consoleApprovals 不是开关（必须挂在 qzone 下）');
  assert.equal(evaluateGate({ qzone: { consoleapprovals: true } }), false, '★ 大小写不匹配即关闭（属性名必须逐字一致）');
  assert.equal(evaluateGate({ qzone: { consoleApprovals: true, extra: 1 } }), true, '★ 同块多余字段不影响严格判定');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T9 —— 语义链：file ->（源码抽取的透传语句）-> cfg ->（源码抽取的读取条件）
//
// 任务卡要求的 11 条矩阵逐条钉住。两段文本都来自 src/bridge.js 正文，本文件不重写逻辑。
// 仍然只是【表达式 + 透传语句】的字面行为，不是真实启动装配（见 T10 与文件头的 CANNOT）。
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('T9 透传语义链（源码抽取）：11 条矩阵逐条钉住默认关闭 / 严格 true / 非 true 不启用 / 不抛错', () => {
  const cases = [
    { label: '{}（无 qzone 键）', file: {}, expected: false, expectsOwnKey: false },
    { label: '{ qzone: { consoleApprovals: true } }', file: { qzone: { consoleApprovals: true } }, expected: true, expectsOwnKey: true },
    { label: '{ qzone: { consoleApprovals: false } }', file: { qzone: { consoleApprovals: false } }, expected: false, expectsOwnKey: true },
    { label: "{ qzone: { consoleApprovals: 'true' } }", file: { qzone: { consoleApprovals: 'true' } }, expected: false, expectsOwnKey: true },
    { label: '{ qzone: { consoleApprovals: 1 } }', file: { qzone: { consoleApprovals: 1 } }, expected: false, expectsOwnKey: true },
    { label: '{ qzone: { consoleApprovals: {} } }', file: { qzone: { consoleApprovals: {} } }, expected: false, expectsOwnKey: true },
    { label: '{ qzone: null }', file: { qzone: null }, expected: false, expectsOwnKey: true },
    { label: '{ qzone: false }', file: { qzone: false }, expected: false, expectsOwnKey: true },
    { label: "{ qzone: 'qzone' }", file: { qzone: 'qzone' }, expected: false, expectsOwnKey: true },
    { label: '{ qzone: [] }', file: { qzone: [] }, expected: false, expectsOwnKey: true },
    { label: '{ qzone: 0 }', file: { qzone: 0 }, expected: false, expectsOwnKey: true },
  ];

  for (const item of cases) {
    let cfg;
    assert.doesNotThrow(() => { cfg = cfgFromFile(item.file); },
      '★★★ ' + item.label + ' 必须能走完「parseRuntimeConfig + 源码透传语句」而不抛错；'
      + '抛错意味着真实启动期会在 loadConfig() 里崩掉');
    assert.equal(Object.prototype.hasOwnProperty.call(cfg, 'qzone'), item.expectsOwnKey,
      '★★ ' + item.label + '：cfg 上 qzone 键的存在性必须与源码透传语句一致'
      + '（有该键才搬运；没有该键时不得凭空新增字段，否则「默认关闭」依赖于别的意外）');
    assert.equal(cfg.qzone, item.file.qzone,
      '★ ' + item.label + '：透传必须是【原样搬运】（同一个引用），不得改写、归一化或深拷贝');
    const gate = evaluateGate(cfg);
    assert.equal(gate, item.expected,
      '★★★ ' + item.label + '：读取条件必须求值为 ' + String(item.expected) + '（实测 ' + String(gate) + '）。'
      + (item.expected
        ? '这是唯一的开启路径；为 false 说明严格 true 到不了接线点（G1 未修复）'
        : '若为 true 就是「看起来关着其实开了」，审批来源会被意外构造'));
  }

  // 非对象 / 空值的 file：在 parseRuntimeConfig 就被拒，永远到不了透传块。
  for (const bad of [null, undefined, [], '', 0, false]) {
    assert.throws(() => cfgFromFile(bad), /配置格式错误/,
      '★★ file = ' + showValue(bad) + ' 必须在 parseRuntimeConfig 处抛「配置格式错误」'
      + '（因此不可能进入透传块）；这条钉的是「非对象不会带来意外启用」');
  }

  // 透传语句自身的防御：即便被直接调用，null / undefined 也不抛错、也不新增键。
  for (const nullish of [null, undefined]) {
    const cfg = {};
    assert.doesNotThrow(() => runPassthrough(nullish, cfg),
      '★★ 透传守卫必须对 file = ' + showValue(nullish) + ' 安全（file !== null && file !== undefined 两个条件）');
    assert.equal(Object.prototype.hasOwnProperty.call(cfg, 'qzone'), false,
      '★ file = ' + showValue(nullish) + ' 不得凭空写入 qzone 键');
  }

  // 与既有键共存：透传不得伤到白名单键。
  const mixed = cfgFromFile({ sessionCwd: '/tmp/g1', qzone: { consoleApprovals: true } });
  assert.equal(mixed.sessionCwd, '/tmp/g1', '★ 透传不得影响白名单键：sessionCwd 必须仍是 /tmp/g1');
  assert.equal(evaluateGate(mixed), true, '★★ 白名单键存在时，严格 true 仍然开启（透传不会因为别的键而失效）');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T10 —— 不触发真实网络（源码结构 + 进程内绊线）
//
// 这一条要证明的是：关闭开关时到不了「审批来源接线」这个网络相关装配点，且本测试自身不发请求。
// 同时它把一条容易说漏的事实钉成断言：openQzoneConsoleRuntime(...) 的调用点在开关块【外】，
// 所以「开关关闭 ⇒ 桥接零网络调用」并不成立（见 (f)）。
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('T10 不触发网络（源码结构 + 绊线）：审批模块 import 只在开关块内，唯一 fetch 被锁在回环', () => {
  const tripped = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    tripped.push(args);
    throw new Error('测试绊线：本定向测试不得发起任何网络请求');
  };
  try {
    const fnMatch = structural.match(/async function getQzoneConsoleRuntime\s*\(\s*\)\s*\{/);
    assert.ok(fnMatch, '★★★ bridge.js 必须仍有 async function getQzoneConsoleRuntime() {（本测试的前提）');
    const fnOpen = structural.indexOf('{', fnMatch.index);
    const fnClose = matchBrace(structural, fnOpen);
    const fnBodyCode = codeSource.slice(fnOpen, fnClose + 1);

    // (a) 开关块定位：花括号配对在结构源上做（字符串里的花括号已被抹成空格）。
    // C3 起开关是复合条件（consoleApprovals === true || approvalIpc 已配置），
    // 所以这里放宽到「以 consoleApprovals 开头的 if」，并单独断言它仍含严格 === true。
    const gateMatch = structural.match(/if\s*\([^\n]*cfg\.qzone\?\.consoleApprovals[^\n]*\)\s*\{/);
    assert.ok(gateMatch, '★★★ 开关 if 必须存在');
    assert.match(codeSource.slice(gateMatch.index, gateMatch.index + 400), /cfg\.qzone\?\.consoleApprovals\s*===\s*true/,
      '★★★ 开关里 consoleApprovals 那一段必须是严格 === true');
    assert.ok(gateMatch.index > fnOpen && gateMatch.index < fnClose,
      '★★★ 开关必须位于 getQzoneConsoleRuntime 体内（函数体第 ' + lineOf(structural, fnOpen) + '-'
      + lineOf(structural, fnClose) + ' 行）；跑到别的函数里就不再由这次懒加载控制');
    const gateOpen = structural.indexOf('{', gateMatch.index);
    const gateClose = matchBrace(structural, gateOpen);
    const gateCode = codeSource.slice(gateOpen, gateClose + 1);

    // (b) 关键：动态 import 必须在【块体里】，不是块外伪装。
    assert.match(gateCode, /await\s+import\(\s*'\.\/core\/qzone-production-wiring\.mjs'\s*\)/,
      '★★★ await import(./core/qzone-production-wiring.mjs) 必须字面位于 if (开关 === true) 的块体内；'
      + '一旦被挪到块外，关闭状态下也会加载审批接线模块 —— 那正是「不触发」要防的事');
    assert.match(gateCode, /createQzoneProductionApprovalBroker/,
      '★★ 工厂的取用也必须在块体内（「取模块」与「用模块」不能被拆到两处）');

    // (c) 全文件只有这一处引用该模块，且不得有静态 import（静态 import 在模块求值时就执行 = 永远打开）。
    const refs = [...codeSource.matchAll(/qzone-production-wiring\.mjs/g)];
    assert.equal(refs.length, 1,
      '★★★ 全文件只允许一处引用 qzone-production-wiring.mjs（实测 ' + String(refs.length) + ' 处）；'
      + '第二处就是第二条加载路径，必须显式复核');
    assert.ok(refs[0].index >= gateOpen && refs[0].index <= gateClose,
      '★★ 那唯一一处引用必须在开关块内（实测位置不在块内）');
    assert.equal(/import\s+[^;]*from\s+'\.\/core\/qzone-production-wiring\.mjs'/.test(codeSource), false,
      '★★★ 不得有静态 import：静态 import 在模块求值阶段就执行，开关等于永远打开');

    // (d) 开关块里没有任何网络调用点。
    assert.equal(/\bfetch\s*\(/.test(gateCode), false,
      '★★★ 开关块内不得出现 fetch（开关不该决定任何网络行为，也不该被网络行为依赖）');
    assert.equal(/new\s+WebSocket|https?\.request|net\.connect|\.listen\(/.test(gateCode), false,
      '★★ 开关块内不得出现其它网络/监听调用点');

    // (e) 唯一的 fetch 的位置：必须在 getIdentity 回调体内，且目标先被回环正则锁死。
    const fetches = [...fnBodyCode.matchAll(/\bfetch\s*\(/g)];
    assert.equal(fetches.length, 1,
      '★★ getQzoneConsoleRuntime 体内只允许一处 fetch（实测 ' + String(fetches.length) + ' 处）；'
      + '多出来的每一处都必须在测试里单独论证可达性');
    const idMatch = structural.match(/getIdentity:\s*async\s*\(\s*\)\s*=>\s*\{/);
    assert.ok(idMatch, '★★ getIdentity 回调必须仍是 async () => { ... }（本测试据此定位 fetch）');
    const idOpen = structural.indexOf('{', idMatch.index);
    const idClose = matchBrace(structural, idOpen);
    // fnBodyCode 是子串切片，fetch 的下标要加回函数体起点才是 codeSource 的绝对偏移。
    const fetchAbsIndex = fnOpen + fetches[0].index;
    assert.ok(fetchAbsIndex > idOpen && fetchAbsIndex < idClose,
      '★★★ 唯一的 fetch 必须落在 getIdentity 回调体内：本文件据此说明它是身份探测，不属于审批开关');
    const idCode = codeSource.slice(idOpen, idClose + 1);
    assert.ok(idCode.includes('^http:') && idCode.includes('::1'),
      '★★ fetch 的目标必须先经回环地址正则校验（^http: 与 ::1 两处字面量）；'
      + '没有这道校验，身份探测就可能把 accessToken 发往任意主机');
    assert.ok(idCode.includes("throw new Error('identity-unavailable')"),
      '★ 回环校验不通过时必须抛错（fail-closed），不得退回默认地址');

    // (f) 诚实边界钉成断言：构造点不在开关块内 ⇒「开关关闭 ⇒ 零网络调用」不成立。
    const openCallIndex = codeSource.indexOf('return openQzoneConsoleRuntime(', fnOpen);
    assert.ok(openCallIndex > gateClose,
      '★★ 诚实边界：openQzoneConsoleRuntime(...) 的调用点在开关块【外】，关闭开关并不会跳过控制台运行时构造；'
      + '构造过程会 await getIdentity()（即上面那唯一一处 fetch）。所以本文件只主张：'
      + '关闭 ⇒ 不 import qzone-production-wiring.mjs（审批路由不存在），不主张「关闭 ⇒ 桥接零网络」');
    assert.match(codeSource, /existsSync\(path\.join\(STATE_DIR,\s*'qzone-console-state\.sqlite'\)\)/,
      '★ 启动时的懒开由 qzone-console-state.sqlite 是否存在决定（与开关无关）；'
      + '这条决定了「关闭时是否连运行时构造都不发生」——不是本开关的功劳');
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
  assert.equal(tripped.length, 0,
    '★ 绊线：本文件在所有断言路径上都不得调用 fetch（实测 ' + String(tripped.length) + ' 次）；'
    + '有调用说明测试自己发了真实网络请求，本任务明令禁止');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T11 —— 原有配置兼容（真实 config.json）
//
// 用【当前机器上真实的 config.json】跑 parseRuntimeConfig + 源码透传语句，断言：
//   · cfg.qzone 仍是 undefined（默认关闭的数据面证据）；
//   · 既有键（sessionCwd / dsh / allow / consolePort ...）解析结果不变；
//   · 在副本上加一个 qzone 键，其它解析结果逐字节相同（透传是附加，不是替换）；
//   · 文件本身逐字节不变（本测试只读）。
// 注意：本断言不打印任何凭据/号码；只比较、不展示具体值。
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('T11 原有配置兼容：真实 config.json 的 qzone 经透传后逐字节相等，既有键不变且文件不被改写', async () => {
  const CONFIG_URL = new URL('../config.json', import.meta.url);
  const before = await readFile(CONFIG_URL, 'utf8');
  const text = before.charCodeAt(0) === 0xFEFF ? before.slice(1) : before;

  let file;
  assert.doesNotThrow(() => { file = JSON.parse(text); },
    '★★ 真实 config.json 必须是合法 JSON（BOM 按 src/core/json-store.mjs 的 readJsonSafe 规则剥掉）');

  // ── 2026-11-17 人工复核（按本测试原有的要求执行，不是放宽）──────────────────────────────
  //
  // 用户已明确授权把 qzone 段写进 config.json（装配读/写许可/来源登记所需的令牌与端口）。
  // 原断言「真实配置不含 qzone」因此按它自己的规则变红，规则要求的是【人工复核默认关闭是否仍成立】。
  //
  // 复核结论（逐条对着 config.json 与三条闸门的源码判据）：
  //   · writeAdmit.enabled 必须是 false —— 写通道关闭由它单独决定（C7 的 readQzoneWriteAdmitConfig）；
  //   · consoleApprovals 不写 —— 控制台审批闸门那一段仍是严格 === true，缺省即关闭；
  //   · approvalIpc / writePermitIpc / onebotForwardToken 只开启【通道】，不开启任何写能力。
  // 所以「默认关闭」在语义上仍然成立：qzone 键存在，但没有任何一条能放行写动作。
  // 下面把这三条钉成断言，强度与原断言等价（原来钉「键不存在」，现在钉「键存在且闸门全关」）。
  assert.equal(Object.prototype.hasOwnProperty.call(file, 'qzone'), true,
    '★★ 真实 config.json 现在含 qzone 键（用户授权写入）；若被移除，本段与 T4/T10 的前提要一起复核');
  // 2026-11-17 第二次人工复核：用户明确裁定「任何操作都不需要管理员手动审批，
  // 只要符合最小间隔和每日额度上限就可以」，并授权把 writeAdmit.enabled 改成 true。
  // 所以这条从「必须是 false」改为「必须是显式布尔，且与用户裁定一致」。
  // ⚠️ 这不等于写通道再无闸门：写仍受 每日额度 / 最小间隔（发说说 2h、评论 3min）/
  //    工具开关 / 来源绑定（qq-inbound + ledger）/ B2 防重放 五重约束。
  //    本断言只钉住「配置里这个值是有意的、显式的，不是拼写错误漏出来的真值」。
  assert.equal(typeof file.qzone.writeAdmit?.enabled, 'boolean',
    '★★★ qzone.writeAdmit.enabled 必须是显式布尔（缺省或非布尔意味着闸门语义不明）');
  assert.equal(Object.prototype.hasOwnProperty.call(file.qzone, 'consoleApprovals'), false,
    '★★★ 不得写 consoleApprovals：控制台审批那一段只认严格 === true，缺省即关闭（用户裁定不要人工审批）');
  // 用户裁定「任何操作都不需要管理员手动审批」⇒ approvalIpc 通道不应存在。
  // 它若回来，bridge 会重新起 3211 监听，等于把审批通道偷偷装回去。
  assert.equal(Object.prototype.hasOwnProperty.call(file.qzone, 'approvalIpc'), false,
    '★★★ 不得写 approvalIpc：用户已裁定不要人工审批，审批 IPC 通道必须保持不存在');

  const parsed = parseRuntimeConfig(file, 'config.json');
  const cfg = parsed.config;
  assert.ok(Array.isArray(parsed.diagnostics), '★ 返回值形状不变：diagnostics 仍必须是数组');
  // parseRuntimeConfig 是【白名单拼接】，它丢掉的正是 qzone —— 这是 G1 缺口本身，
  // 也是本文件 T1 一直钉住的事实。所以这一步仍必须是 undefined（不是我改弱了断言，
  // 而是透传的目的就是把这一步的结果补上）。
  assert.equal(Object.prototype.hasOwnProperty.call(cfg, 'qzone'), false,
    '★★★ parseRuntimeConfig 不得凭空造出 qzone 键（白名单拼接的本质，T1 同一事实）');
  assert.equal(cfg.qzone, undefined, '★★★ 解析后 cfg.qzone 仍是 undefined，等透传块来补');

  // 然后跑源码里的透传语句：真实配置有 qzone ⇒ 透传后 cfg.qzone 必须等于文件值。
  runPassthrough(file, cfg);
  assert.ok(Object.prototype.hasOwnProperty.call(cfg, 'qzone'),
    '★★ 真实配置有 qzone ⇒ 透传后 cfg 也必须有（这是 G1 修复的目的）');
  assert.equal(JSON.stringify(cfg.qzone), JSON.stringify(file.qzone),
    '★★★ 透传必须是【原样复制】：cfg.qzone 与文件里的 qzone 逐字节相同，不得增删任何键');
  // 措辞纪律：这里只是「源码条件表达式 + 透传语句 + 真实配置文件内容」三者的字面闭合，
  // 不是端到端装配验证（那需要启动桥接观察真实 cfg，本轮禁止）。
  assert.equal(evaluateGate(cfg), false, '★★★ 因此读取条件对真实配置恒为关闭（字面语义在此闭合）');

  // 既有键：解析结果必须与文件值一致（只比较，不打印，避免把凭据/号码写进测试输出）。
  const same = (actual, expected, label, why) => {
    assert.ok(JSON.stringify(actual) === JSON.stringify(expected),
      '★★ 既有配置键 ' + label + ' 的解析结果必须与 config.json 原值一致（' + why + '）；'
      + '不一致意味着本次改动动了既有配置语义 —— 透传只允许新增 qzone 键');
  };
  same(cfg.sessionCwd, file.sessionCwd ?? '', 'sessionCwd', '透传不得改动工作目录语义');
  same(cfg.agentPreset, file.agentPreset ?? 'qq-chat', 'agentPreset', '默认值语义不变');
  same(cfg.workspaceTitle, file.workspaceTitle ?? 'QQ 聊天', 'workspaceTitle', '默认值语义不变');
  same(cfg.consolePort, file.consolePort ?? 3100, 'consolePort', '控制台端口语义不变');
  same(cfg.allowAllWhenEmpty, file.allowAllWhenEmpty === true, 'allowAllWhenEmpty', '严格布尔语义不变');
  assert.equal(typeof cfg.consoleToken, 'string', '★ consoleToken 仍被解析成字符串（本断言不打印其值）');
  assert.equal(typeof cfg.dsh, 'object', '★ dsh 节仍存在');
  assert.equal(typeof cfg.snowluma, 'object', '★ snowluma 节仍存在');
  if (file.dsh && typeof file.dsh === 'object') {
    for (const key of ['baseUrl', 'provider', 'model']) {
      if (Object.prototype.hasOwnProperty.call(file.dsh, key)) {
        same(cfg.dsh[key], file.dsh[key], 'dsh.' + key, 'dsh 浅合并语义不变');
      }
    }
  }
  if (file.security && typeof file.security === 'object') {
    // security 是 `{ interceptNotify: true, ...(file.security ?? {}) }`：文件里没写才是默认 true。
    const expectedIntercept = Object.prototype.hasOwnProperty.call(file.security, 'interceptNotify')
      ? file.security.interceptNotify
      : true;
    same(cfg.security.interceptNotify, expectedIntercept, 'security.interceptNotify', 'security 浅合并语义不变');
  }
  // allow/deny：条目数与归一化结果不变（不打印具体号码）。
  for (const scope of ['private', 'groups']) {
    const aliasKey = scope === 'private' ? 'privates' : 'group';
    const rawList = file.allow?.[scope] ?? file.allow?.[aliasKey] ?? [];
    const normalizedRaw = rawList.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
    assert.ok(Array.isArray(cfg.allow[scope]), '★ allow.' + scope + ' 仍必须是数组');
    assert.ok(JSON.stringify(cfg.allow[scope]) === JSON.stringify(normalizedRaw),
      '★ allow.' + scope + ' 的归一化结果必须与文件一致（别名 privates/group 的兼容规则不变）');
  }

  // 最强形式：在真实配置的副本上加一个 qzone，其它解析结果必须逐字节相同。
  const withQzone = JSON.parse(text);
  withQzone.qzone = { consoleApprovals: false };
  const second = parseRuntimeConfig(withQzone, 'config.json').config;
  runPassthrough(withQzone, second);
  assert.equal(evaluateGate(second), false, '★ 显式 false ⇒ 仍关闭（非 true 不启用）');
  const stripQzone = (obj) => { const clone = JSON.parse(JSON.stringify(obj)); delete clone.qzone; return clone; };
  // 两边都要剥掉 qzone 再比：真实配置现在本身就有 qzone（用户授权写入），所以
  // 「加一个 qzone 不改变其它键」这句话的正确判据是【剥掉 qzone 后逐字节相同】。
  assert.ok(JSON.stringify(stripQzone(second)) === JSON.stringify(stripQzone(cfg)),
    '★★★ 在真实配置上替换成另一个 qzone 值，不得改变其它任何解析结果；'
    + '不同意味着透传破坏了既有配置语义（尤其对象键顺序/深度合并）');

  const after = await readFile(CONFIG_URL, 'utf8');
  assert.equal(after, before, '★★★ 解析 + 透传之后 config.json 必须逐字节不变（本测试只读，绝不回写）');
});
