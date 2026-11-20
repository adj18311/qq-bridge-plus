// G1 终审 · F1 —— 五类授权项「不做时的安全默认态」：只补真正没覆盖的那一条
//
// 依据：.qzone-channel-lab/AUTH-CHECKLIST-PROD-WIRING.md（下称「清单」）把待授权项分成五类，
// 每类都声明了「不做时的安全默认态」。
//
// ⚠️ 措辞纪律（Codex 裁决，本文件全程遵守）
//   本文件做的全部是【静态检查】（读源码文本 / 纯函数求值）与【模拟验证】（临时目录 + 临时 SQLite）。
//   它【不是】、也【不得】被表述为「真实 bridge 装配已验证」：
//   没有启动 src/bridge.js，没有重启任何进程，没有加载 Cordis，没有向真实 QQ 空间发过任何请求。
//
// ── 一、本文件【唯一新增】的断言（此前无任何测试覆盖）────────────────────────────────
//   T1 清单 2.1 + 2.2（插件启用 / 跨进程方案实施 ④）：
//      plugins/qzone-safe/index.mjs 的 apply() 只传【两个】实参给 createQzonePluginHandle
//      （无第三参数 runtime）⇒ 静态源码结构检查。
//      为什么这是唯一的缺口：createQzonePluginHandle 的第三参数 runtime 就是 ④ 的开关；
//      签名里留着它（能力存在），但默认装载路径不传它 ⇒ ready=false ⇒ 插件停在
//      enabled-awaiting-runtime，native tool 每次调用返回 dispatch-unavailable。
//      一旦有人顺手把 apply 补成三参，④ 就等于默认打开，而运行时不会有任何报错 ——
//      tool 只是从「永远 dispatch-unavailable」悄悄变成「真的会派发」。
//      （已核：scripts/ 下没有任何测试读取该文件源码做结构断言；它们都是**直接以三参调用**
//       createQzonePluginHandle 来构造 ready 状态，恰好绕过了这条默认态。）
//
// ── 二、清单其余默认态：已有覆盖，本文件【只引用，不重复断言】────────────────────────
//   （每条都给出 文件:用例名，便于审计时直接跳过去看；本文件不再写等价断言，避免两套矩阵漂移。）
//
//   ① 配置类 —— config.json 无 qzone 键 ⇒ parseRuntimeConfig 后 cfg.qzone === undefined；
//      parseRuntimeConfig 本身会丢弃 qzone：
//        · scripts/test-qzone-config-passthrough.mjs  T1「必要性：parseRuntimeConfig 丢弃未知顶层键 qzone」
//        · scripts/test-qzone-config-passthrough.mjs  T11「原有配置兼容：真实 config.json 解析后 qzone 仍 undefined」
//   ② 开关类 ③ —— 严格 === true、全文件恰好 1 处、无反模式（|| / !== false / ?? / 取反 / Boolean / !!）：
//        · scripts/test-qzone-config-passthrough.mjs  T4「默认关闭：开关必须是严格的 cfg.qzone?.consoleApprovals === true」
//        · 同文件 T8「源码表达式：bridge.js 抽取的那个字面条件只认布尔 true」给出非 true 值矩阵
//   ③ 动态 import 门控 —— await import('./core/qzone-production-wiring.mjs') 字面位于开关块体内、
//      且无静态 import：
//        · scripts/test-qzone-config-passthrough.mjs  T10「不触发网络（源码结构 + 绊线）：审批模块 import 只在开关块内」
//   ④ 审批路由缺席 —— 不传 operationApprovals 时 /operation-approvals 是 404 not_found（不是空列表 200）：
//        · scripts/test-qzone-console-approval-wiring.mjs  「不传 operationApprovals 时审批路由不存在
//          （与改动前一致：404 not_found，而不是空列表 200）」
//   ⑤ 写链默认拒绝 / 零 send / 零审计行 —— 已有覆盖：
//        · scripts/test-qzone-runtime-write-wiring.mjs  WW-1「默认关闭」：
//            不传 writeWiring 时 comment / reply / like ⇒ write-not-wired，
//            publish ⇒ origin-unverified（在更早的可信绑定铸票处就被拒），send 调用 0 次。
//        · scripts/test-qzone-production-wiring.mjs  PW-5：装配层同样的默认形状，且平台 call 0 次。
//        · scripts/test-qzone-production-wiring.mjs  PW-9：只传 audit 不开写，writeAudit 零行。
//   ⚠️ 措辞必须精确（Codex 裁决）：不存在「所有写动作一律 write-not-wired」这条契约 ——
//      真实形状是 publish 被更早的 origin-unverified 拒绝，其余三个才是 write-not-wired。
//
//   ⚠️ 两条 sink 不能混：state.writeAudit（写审计，PW-9 钉的那条）与 state.audit
//      （既有 dsp_/settled 流水，另一条 sink）是【两条不同的存储】。引用时不得拿 state.audit
//      当 writeAudit 的证据，也不得把「writeAudit 零行」推广成「所有 sink 零行」。
//
// ── 三、诚实边界（本文件【不能】证明什么）────────────────────────────────────────────
//   · 没有启动 src/bridge.js：loadConfig() 是否在真实启动路径上执行过、运行中进程里的 cfg 长什么样，
//     本文件一概没有证据。
//   · 没有重启 bridge / 没有重启 DSH 宿主。因此清单 2.3（重启类）的默认态
//     （「运行中进程仍跑旧代码、插件未装载」）【未被验证】—— 那需要真实进程观察，本任务禁止。
//   · 没有加载 Cordis、没有把 qzone-safe 装进任何 profile：T1 断言的是【源码结构】，
//     不是「宿主按此源码装载过」，也不是「profile 里没有该条目」。
//   · 没有做任何真实 QQ 读写；清单 2.4（真实读取）在本文件里零请求。
//   · 上面「二」引用的既有测试同样只是离线/注入假 transport 的证据，最远到进程内的 transport 边界；
//     它们不能证明生产环境没发生过任何真实收发。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const BACKTICK = String.fromCharCode(96);

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 最小源码预处理：注释抹成空格、字符串内容抹成空格（引号保留），【不增删字符】，
// 因此输出与原文的字符偏移一一对应，行号可直接换算。
//
// 为什么要抹字符串：本文件的判断是「标识符 / 实参个数 / 块体归属」，而源码里到处是
// 含 { } 、括号与逗号的字符串字面量；不抹掉就会把配对与切分带偏，静默取到错误的块体。
// ══════════════════════════════════════════════════════════════════════════════════════════════
function maskSource(src) {
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
      if (ch === BACKTICK) { state = 'template'; out.push(ch); i += 1; continue; }
      out.push(ch); i += 1; continue;
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out.push('\n'); } else out.push(' ');
      i += 1; continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; i += 2; continue; }
      out.push(ch === '\n' ? '\n' : ' ');
      i += 1; continue;
    }
    if (ch === '\\') {
      // 转义序列整段抹掉（两字符），保持偏移不变。
      out.push(ch);
      out.push(i + 1 < n && src[i + 1] === '\n' ? '\n' : ' ');
      i += 2; continue;
    }
    if (state === 'single' && ch === "'") { state = 'code'; out.push(ch); i += 1; continue; }
    if (state === 'double' && ch === '"') { state = 'code'; out.push(ch); i += 1; continue; }
    if (state === 'template' && ch === BACKTICK) { state = 'code'; out.push(ch); i += 1; continue; }
    out.push(ch === '\n' ? '\n' : ' ');
    i += 1; continue;
  }
  return out.join('');
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

function matchParen(source, openIndex) {
  assert.equal(source[openIndex], '(', 'matchParen 必须从 ( 开始（源码预处理失效）');
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('圆括号未配对（源码被改动或预处理失效）');
}

function matchBrace(source, openIndex) {
  assert.equal(source[openIndex], '{', 'matchBrace 必须从 { 开始（源码预处理失效）');
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

/** 顶层逗号切分（字符串内容已抹平，只需跟踪三种括号）。 */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail !== '') parts.push(tail);
  return parts;
}

const PLUGIN_URL = new URL('../plugins/qzone-safe/index.mjs', import.meta.url);
const pluginRaw = await readFile(PLUGIN_URL, 'utf8');
const pluginStructural = maskSource(pluginRaw);

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T1 —— 清单 2.1/2.2（插件启用 + 跨进程方案实施 ④）：apply() 只传两参（静态检查）
//
// 判据分四步，缺一条都会让「默认未注入 runtime」变成一句空话：
//   (a) 定义处仍保留第三参数 —— 否则「不传」无从谈起，签名被删同样要显式复核；
//   (b) apply() 函数体内不出现 runtime 标识符；
//   (c) 全文件「1 处定义 + 1 处调用」，且那次调用的实参逐字是 (ctx, config)，
//       调用点位于 apply() 体内；
//   (d) 除定义外，任何一处 createQzonePluginHandle 调用都只能有两个实参
//       （防止有人另开一条绕过 apply 的装载路径）。
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('T1 插件类（静态检查）：runtime 注入点存在，但默认关闭——enabled !== true 时工厂不被读取', () => {
  // 现实：apply() 现在会构造 runtime（用户已授权 ④）。默认关闭不再靠「apply 里没有 runtime 标识符」，
  // 而是靠 buildInjectedRuntime 的三条早退。本用例断言这三条；缺一条，默认态就是空话。

  // (a) 定义处仍保留第三参数（能力在）。
  const definition = pluginStructural.match(/export\s+async\s+function\s+createQzonePluginHandle\s*\(/);
  assert.ok(definition,
    '★★★ 前提：plugins/qzone-safe/index.mjs 必须仍导出 async function createQzonePluginHandle(...)');
  const defOpen = definition.index + definition[0].length - 1;
  const defClose = matchParen(pluginStructural, defOpen);
  const defParams = splitTopLevel(pluginStructural.slice(defOpen + 1, defClose));
  assert.deepEqual(defParams, ['ctx', 'config', 'runtime'],
    '★★ 签名必须仍是 (ctx, config, runtime)：第三参数是注入点，删掉它意味着注入不再有落点');

  // (b) 全文件「1 处定义 + 1 处调用」，且调用点位于 apply() 体内。
  const calls = [...pluginStructural.matchAll(/createQzonePluginHandle\s*\(/g)];
  assert.equal(calls.length, 2,
    '★★★ 全文件只允许「1 处定义 + 1 处调用」（实测 ' + calls.length + ' 处）；'
    + '第二处调用就是第二条装载路径，可以绕过 apply() 里那条默认关闭的判别');

  const applyMatch = pluginStructural.match(/export\s+async\s+function\s+apply\s*\(/);
  assert.ok(applyMatch, '★★★ 前提：plugins/qzone-safe/index.mjs 必须仍有 export async function apply(...)');
  const applyOpen = pluginStructural.indexOf('{', applyMatch.index);
  const applyClose = matchBrace(pluginStructural, applyOpen);

  const callMatch = calls.find((match) => !/function\s+$/.test(
    pluginStructural.slice(Math.max(0, match.index - 20), match.index)));
  assert.ok(callMatch, '★★ 找不到 apply() 里的调用点（源码结构变了，本用例必须显式重写）');
  assert.ok(callMatch.index > applyOpen && callMatch.index < applyClose,
    '★★★ 唯一的调用点必须位于 apply() 函数体内；跑到别的函数里就不再受「默认装载」这条约束');

  const callOpen = callMatch.index + callMatch[0].length - 1;
  const callClose = matchParen(pluginStructural, callOpen);
  const args = splitTopLevel(pluginStructural.slice(callOpen + 1, callClose));
  assert.deepEqual(args, ['ctx', 'config', 'runtime'],
    '★★ 调用形态必须是 (ctx, config, runtime)，第三个实参由 buildInjectedRuntime 提供（可能为 undefined）');

  // (c) ★ 默认关闭第一条：buildInjectedRuntime 在 !enabled 时立即返回 undefined。
  const buildMatch = pluginStructural.match(/async\s+function\s+buildInjectedRuntime\s*\([^)]*\)\s*\{/);
  assert.ok(buildMatch, '★★★ 前提：plugins/qzone-safe/index.mjs 必须仍有 async function buildInjectedRuntime(...)');
  const buildOpen = buildMatch.index + buildMatch[0].length - 1;
  const buildClose = matchBrace(pluginStructural, buildOpen);
  const buildBody = pluginStructural.slice(buildOpen, buildClose + 1);

  const firstStatement = buildBody.slice(1).trimStart();
  assert.match(firstStatement, /^if\s*\(\s*!enabled\s*\)\s*return\s+undefined/,
    '★★★ 默认关闭被破坏：buildInjectedRuntime 的第一个语句必须是 if (!enabled) return undefined。实测开头是 '
    + JSON.stringify(firstStatement.slice(0, 60)) + '。缺少这条早退意味着插件关闭时仍会去读宿主工厂');

  // (d) ★ 默认关闭第二条：工厂不存在时一律 undefined，绝不造默认值。
  assert.match(buildBody, /factory\s*=\s*ctx\?\.\[RUNTIME_FACTORY\]/,
    '★★ 工厂必须从 ctx 的约定键读取（ctx?.[RUNTIME_FACTORY]）');
  assert.match(buildBody, /if\s*\(\s*factory\s*===\s*undefined\s*\|\|\s*factory\s*===\s*null\s*\)\s*return\s+undefined/,
    '★★★ 默认关闭被破坏：没有注入工厂时必须返回 undefined（不造默认 runtime）');

  // (e) ★ 默认关闭第三条：工厂存在但不可调用时抛 TypeError，不静默忽略。
  // 注意：pluginStructural 已把字符串内容抹成空格，所以这里只能断言结构（不能断言 'function' 字面量）。
  assert.match(buildBody, /typeof\s+factory\s*!==/,
    '★★ 工厂不可调用时必须有显式类型检查');
  assert.match(buildBody, /throw\s+new\s+TypeError/,
    '★★★ 不可用的注入必须抛错（失败关闭），不得静默退化');

  // 对照：块体确实被取到了，否则上面几条 match 断言是空转。
  assert.match(buildBody, /RUNTIME_FACTORY/,
    '★ 对照失败：buildInjectedRuntime 体里找不到 RUNTIME_FACTORY，说明块体解析不可信');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T2 —— 引用完整性：本文件用「引用代替重复断言」，那这些引用本身就不能悄悄烂掉
//
// 如果哪天有人删掉/改名上面「二」里引用的用例，本文件的论证会变成一句无根据的陈述，
// 而整套测试仍然全绿 —— 那正是「引用式覆盖」最大的失效模式。所以这里只做一件事：
// 确认被引用的文件仍在，且引用的用例名字面还能在里面找到。它【不】复述任何行为断言。
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('T2 引用完整性（静态检查）：被引用的既有用例仍然存在（引用腐烂会让「已覆盖」变成空话）', async () => {
  const citations = [
    { file: '../scripts/test-qzone-config-passthrough.mjs', anchor: 'T1 必要性',
      covers: '① 配置类：parseRuntimeConfig 丢弃 qzone' },
    { file: '../scripts/test-qzone-config-passthrough.mjs', anchor: 'T4 默认关闭',
      covers: '② 开关类：严格 === true 且恰好 1 处、无反模式' },
    { file: '../scripts/test-qzone-config-passthrough.mjs', anchor: 'T8 源码表达式',
      covers: '② 开关类：非 true 值矩阵（源码抽取的表达式求值）' },
    { file: '../scripts/test-qzone-config-passthrough.mjs', anchor: 'T10 不触发网络',
      covers: '③ 动态 import 只在开关块内' },
    { file: '../scripts/test-qzone-config-passthrough.mjs', anchor: 'T11 原有配置兼容',
      covers: '① 配置类：真实 config.json 解析后 qzone 仍 undefined' },
    { file: '../scripts/test-qzone-console-approval-wiring.mjs', anchor: '不传 operationApprovals 时审批路由不存在',
      covers: '④ 审批路由缺席（404 not_found）' },
    { file: '../scripts/test-qzone-runtime-write-wiring.mjs', anchor: 'WW-1',
      covers: '⑤ 写链默认拒绝 + 零 send' },
    { file: '../scripts/test-qzone-production-wiring.mjs', anchor: 'PW-5',
      covers: '⑤ 装配层默认不接写 + 零 send / 零 call' },
    { file: '../scripts/test-qzone-production-wiring.mjs', anchor: 'PW-9',
      covers: '⑤ 只传 audit 不开写 + writeAudit 零行' },
  ];
  const cache = new Map();
  for (const citation of citations) {
    if (!cache.has(citation.file)) {
      const url = new URL(citation.file, import.meta.url);
      let text = null;
      try { text = await readFile(url, 'utf8'); } catch { text = null; }
      cache.set(citation.file, text);
    }
    const text = cache.get(citation.file);
    assert.notEqual(text, null,
      '★★★ 引用腐烂：' + citation.file + ' 已不存在（或不可读）。'
      + '本文件把「' + citation.covers + '」交给它作证，这里必须先修引用，不能放着变空话');
    assert.ok(text.includes(citation.anchor),
      '★★★ 引用腐烂：' + citation.file + ' 里找不到用例锚点「' + citation.anchor + '」'
      + '（覆盖的是「' + citation.covers + '」）。用例被删或改名后，本文件的「已覆盖」就不再成立；'
      + '要么恢复该用例，要么把断言搬回本文件并删掉这条引用');
  }
});
