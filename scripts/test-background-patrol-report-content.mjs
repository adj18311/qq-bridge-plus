// task-46 单元测试：汇报内容提取、敏感分级、目的地选择与回退。
// 纯离线；不发送、不读写状态、不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  PATROL_REPORT_MAX_CHARS,
  buildPatrolReportPlan,
  chooseReportDestination,
  classifyReportSensitivity,
  composeTemplateReportBody,
  extractPatrolReportBlock,
} from '../src/core/background-patrol-report-content.mjs';

const HEADER = '【后台巡逻汇报】';

function block({ text = '今天贴吧很热闹，逛了三页。', sensitive = 'false', destination = 'admin' } = {}) {
  return `<patrol-report sensitive="${sensitive}" destination="${destination}">${text}</patrol-report>`;
}

// ── 1. 汇报块提取 ──────────────────────────────────────────────────────────
test('提取合法汇报块：正文折叠空白、属性解析', () => {
  const out = extractPatrolReportBlock(`前置说明\n${block({ text: '  今天\n贴吧 很热闹  ', sensitive: 'false', destination: 'group' })}\n后置`);
  assert.equal(out.ok, true);
  assert.equal(out.text, '今天 贴吧 很热闹');
  assert.equal(out.sensitive, false);
  assert.equal(out.destination, 'group');
});

test('多个块视为歧义（模型可能回显示例），不猜内容', () => {
  const out = extractPatrolReportBlock(`${block({ text: '旧' })}\n${block({ text: '新' })}`);
  assert.equal(out.ok, false);
  assert.equal(out.present, true);
  assert.equal(out.reason, 'ambiguous-block');
});

test('缺失/非法属性按 fail-closed 处理：sensitive 默认 true，destination 默认 admin', () => {
  const out = extractPatrolReportBlock('<patrol-report>一句话</patrol-report>');
  assert.equal(out.ok, true);
  assert.equal(out.sensitive, true);
  assert.equal(out.destination, 'admin');
  assert.equal(extractPatrolReportBlock('没有块').ok, false);
  assert.equal(extractPatrolReportBlock(undefined).ok, false);
  assert.equal(extractPatrolReportBlock('').ok, false);
});

test('空正文/超长正文视为非法块', () => {
  assert.equal(extractPatrolReportBlock('<patrol-report sensitive="false">   </patrol-report>').ok, false);
  assert.equal(
    extractPatrolReportBlock(`<patrol-report sensitive="false">${'字'.repeat(PATROL_REPORT_MAX_CHARS + 1)}</patrol-report>`).ok,
    false,
  );
});

test('剥离模型可能重复写出的汇报头', () => {
  const out = extractPatrolReportBlock(block({ text: `${HEADER}第 2 次逛小黑盒` }));
  assert.equal(out.ok, true);
  assert.equal(out.text, '第 2 次逛小黑盒');
});

// ── 2. 敏感分级 ────────────────────────────────────────────────────────────
test('干净文案 → non-sensitive', () => {
  const out = classifyReportSensitivity('今天贴吧很热闹，逛了三页。');
  assert.equal(out.classification, 'non-sensitive');
  assert.deepEqual(out.reasons, []);
});

test('路径/凭据赋值 → blocked（复用 SENSITIVE_RE）', () => {
  assert.equal(classifyReportSensitivity('日志在 D:\\qq-bridge\\state 里').classification, 'blocked');
  assert.equal(classifyReportSensitivity('token=abcdef123456').classification, 'blocked');
});

test('URL/邮箱/QQ 号 → blocked', () => {
  assert.equal(classifyReportSensitivity('看这个 https://example.com/a 页面').classification, 'blocked');
  assert.equal(classifyReportSensitivity('联系 a@b.com').classification, 'blocked');
  assert.equal(classifyReportSensitivity('加群 123456789').classification, 'blocked');
  assert.equal(classifyReportSensitivity('@1234567890 你好').classification, 'blocked');
});

test('短数字/百分比不误伤', () => {
  assert.equal(classifyReportSensitivity('今日第 3 次，概率 60%').classification, 'non-sensitive');
});

test('软关键词 → sensitive（非 blocked）', () => {
  assert.equal(classifyReportSensitivity('看到有人发验证码').classification, 'sensitive');
  assert.equal(classifyReportSensitivity('这个词叫 token').classification, 'sensitive');
});

test('已知令牌命中 → blocked', () => {
  assert.equal(classifyReportSensitivity('普通一句话', { hasKnownToken: true }).classification, 'blocked');
});

test('非字符串/空 → blocked', () => {
  assert.equal(classifyReportSensitivity('').classification, 'blocked');
  assert.equal(classifyReportSensitivity(null).classification, 'blocked');
});

// ── 3. 目的地 ──────────────────────────────────────────────────────────────
test('非敏感 + 模型选群 + 白名单命中 → group', () => {
  const out = chooseReportDestination({ classification: 'non-sensitive', modelDestination: 'group', allowedGroups: ['123', 456] });
  assert.equal(out.destination, 'group');
  assert.equal(out.groupId, '123');
});

test('白名单为空/无合法群号 → 回落 owner；白名单有合法群号 → group', () => {
  assert.equal(chooseReportDestination({ classification: 'non-sensitive', modelDestination: 'group', allowedGroups: [] }).destination, 'owner');
  assert.equal(chooseReportDestination({ classification: 'non-sensitive', modelDestination: 'group', allowedGroups: ['abc', ''] }).destination, 'owner');
  const picked = chooseReportDestination({ classification: 'non-sensitive', modelDestination: 'group', allowedGroups: ['999'] });
  assert.equal(picked.destination, 'group');
  assert.equal(picked.groupId, '999');
});

test('敏感/阻断/未选群 → owner', () => {
  assert.equal(chooseReportDestination({ classification: 'sensitive', modelDestination: 'group', allowedGroups: ['123'] }).destination, 'owner');
  assert.equal(chooseReportDestination({ classification: 'blocked', modelDestination: 'group', allowedGroups: ['123'] }).destination, 'owner');
  assert.equal(chooseReportDestination({ classification: 'non-sensitive', modelDestination: 'admin', allowedGroups: ['123'] }).destination, 'owner');
});

// ── 4. 汇报计划组合 ─────────────────────────────────────────────────────────
test('无有效或安全模型内容时不产生可发送的固定模板', () => {
  for (const turnText of ['', '没有汇报块', block({ text: '链接 https://example.com/x' }), '<patrol-report sensitive="false"> </patrol-report>']) {
    const plan = buildPatrolReportPlan({ platform: 'tieba', readIndex: 1, probability: 0.6, turnText });
    assert.equal(plan.source, 'none');
    assert.equal(plan.message, null);
    assert.ok(plan.reasons.length > 0);
  }
});

test('模型给合法非敏感块 → 使用模型内容；群白名单命中则发群', () => {
  const plan = buildPatrolReportPlan({
    platform: 'tieba',
    readIndex: 2,
    probability: 0.5,
    turnText: `已完成浏览。\n${block({ text: '贴吧今天在聊新版本。', destination: 'group' })}`,
    allowedGroups: ['123'],
  });
  assert.equal(plan.source, 'model');
  assert.equal(plan.reportBlockPresent, true);
  assert.equal(plan.classification, 'non-sensitive');
  assert.equal(plan.destination, 'group');
  assert.equal(plan.groupId, '123');
  assert.equal(plan.message, '贴吧今天在聊新版本。', '不再拼接固定标题：用户可见文本就是模型原话');
});

test('模型块含敏感 → 用模型内容但只发 owner', () => {
  const plan = buildPatrolReportPlan({
    platform: 'tieba',
    readIndex: 1,
    probability: 0.6,
    turnText: block({ text: '看到有人发验证码', destination: 'group' }),
    allowedGroups: ['123'],
  });
  assert.equal(plan.source, 'model');
  assert.equal(plan.classification, 'sensitive');
  assert.equal(plan.destination, 'owner');
});

test('模型块被阻断 → 不发送，分类 blocked', () => {
  const plan = buildPatrolReportPlan({
    platform: 'xiaoheihe',
    readIndex: 1,
    probability: 0.6,
    turnText: block({ text: '看 https://example.com/x 这个' }),
  });
  assert.equal(plan.source, 'none');
  assert.equal(plan.classification, 'blocked');
  assert.equal(plan.destination, null);
  assert.equal(plan.message, null);
});

test('没有汇报块/回合文本缺失 → 不发送', () => {
  for (const turnText of [null, '', '模型这次没写块']) {
    const plan = buildPatrolReportPlan({ platform: 'tieba', readIndex: 3, probability: 0.4, turnText });
    assert.equal(plan.source, 'none');
    assert.equal(plan.destination, null);
    assert.equal(plan.reportBlockPresent, false);
    assert.equal(plan.message, null);
  }
});

test('模型标记 sensitive=true 但内容干净 → 只发 owner（尊重模型保守声明）', () => {
  const plan = buildPatrolReportPlan({
    platform: 'tieba',
    readIndex: 2,
    probability: 0.5,
    turnText: block({ text: '今天挺安静', sensitive: 'true', destination: 'group' }),
    allowedGroups: ['123'],
  });
  assert.equal(plan.source, 'model');
  assert.equal(plan.classification, 'sensitive');
  assert.equal(plan.destination, 'owner');
});

test('模板正文格式（贴吧/小黑盒）', () => {
  assert.equal(composeTemplateReportBody({ platform: 'tieba', readIndex: 3, probability: 0.4 }), '今日第 3 次自主逛贴吧完成（概率 40%）。');
  assert.equal(composeTemplateReportBody({ platform: 'xiaoheihe', readIndex: 1, probability: 0.6 }), '今日第 1 次自主逛小黑盒完成（概率 60%）。');
});

test('异常输入不抛错（fail-closed 不发送）', () => {
  for (const input of [undefined, {}, { platform: 'tieba' }, { platform: 'x', readIndex: 'x', probability: NaN, turnText: 42 }]) {
    const plan = buildPatrolReportPlan(input);
    assert.equal(plan.message, null);
    assert.equal(plan.destination, null);
  }
});

// ── 5. 边界加固（复审 P1/P2） ──────────────────────────────────────────────
test('scheme-less/变体 URL 与裸 IP → blocked', () => {
  for (const text of [
    '看 www.example.com 这里',
    '访问 example.com/path?q=1',
    'ftp://x.cn/a',
    '//cdn.example.com/a',
    'hxxps://abc.cn/x',
    '192.168.1.1',
    'ｈｔｔｐｓ：／／x.cn',
  ]) {
    assert.equal(classifyReportSensitivity(text).classification, 'blocked', text);
  }
});

test('带分隔符/全角/阿拉伯数字的号码 → blocked', () => {
  for (const text of ['QQ 123 456 789', '123-456-789', '１３８００１３８０００', '١٢٣٤٥٦']) {
    assert.equal(classifyReportSensitivity(text).classification, 'blocked', text);
  }
});

test('零宽/bidi/控制字符 → blocked（invisible）', () => {
  for (const text of ['to\u200bken=abcdef', '今天很\u202e热闹', 'x\u007fy', 'x\u0085y', '\ufeffhello', 'a\u2066b']) {
    const out = classifyReportSensitivity(text);
    assert.equal(out.classification, 'blocked', text);
    assert.ok(out.reasons.includes('invisible'), text);
  }
});

test('正常中文含少量数字/百分号不误伤', () => {
  assert.equal(classifyReportSensitivity('记一次第 3 次逛贴吧，概率 60% 完成。').classification, 'non-sensitive');
});

test('按码点计长：160 个 emoji 可接受，801 个码点拒绝，800 恰好接受', () => {
  assert.equal(extractPatrolReportBlock(block({ text: '😀'.repeat(160) })).ok, true);
  // 800 码点恰好接受（emoji 按码点计），801 拒绝 —— 防止 UTF-16 length 或旧 300 闸门回归。
  assert.equal(extractPatrolReportBlock(block({ text: '😀'.repeat(800) })).ok, true);
  assert.equal(extractPatrolReportBlock(block({ text: '😀'.repeat(801) })).ok, false);
  assert.equal(extractPatrolReportBlock(block({ text: '😀'.repeat(160) + '字'.repeat(640) })).ok, true);
});

test('单引号属性也能解析（大小写不敏感）', () => {
  const out = extractPatrolReportBlock("<patrol-report sensitive='false' destination='group'>今天</patrol-report>");
  assert.equal(out.ok, true);
  assert.equal(out.sensitive, false);
  assert.equal(out.destination, 'group');
});

test('多个块视为歧义 → 不回退示例/旧块，不发送', () => {
  const plan = buildPatrolReportPlan({
    platform: 'tieba',
    readIndex: 1,
    probability: 0.6,
    turnText: `${block({ text: '示例块', destination: 'group' })}\n${block({ text: '真块', destination: 'group' })}`,
    allowedGroups: ['123'],
  });
  assert.equal(plan.source, 'none');
  assert.equal(plan.reportBlockPresent, true);
  assert.equal(plan.classification, 'blocked');
  assert.equal(plan.destination, null);
});

test('超长块 present=true 且分类 blocked（模板发送）', () => {
  const plan = buildPatrolReportPlan({ platform: 'tieba', readIndex: 1, probability: 0.6, turnText: block({ text: '字'.repeat(801) }) });
  assert.equal(plan.reportBlockPresent, true);
  assert.equal(plan.classification, 'blocked');
});

test('无块回退：classification 落在三值内（保守 sensitive），present=false', () => {
  const plan = buildPatrolReportPlan({ turnText: 'no block' });
  assert.equal(plan.reportBlockPresent, false);
  assert.equal(plan.classification, 'sensitive');
});

test('白名单非法首项不遮蔽合法群号；空白群号归一化', () => {
  assert.equal(chooseReportDestination({ classification: 'non-sensitive', modelDestination: 'group', allowedGroups: ['abc', '999'] }).groupId, '999');
  assert.equal(chooseReportDestination({ classification: 'non-sensitive', modelDestination: 'group', allowedGroups: [' 123 '] }).groupId, '123');
  assert.equal(chooseReportDestination({ classification: 'non-sensitive', modelDestination: 'group', allowedGroups: [456] }).groupId, '456');
  assert.equal(chooseReportDestination({ classification: 'non-sensitive', modelDestination: 'group', allowedGroups: ['0', '12a'] }).destination, 'owner');
});

test('模板概率越界按 clamp 处理', () => {
  assert.equal(composeTemplateReportBody({ platform: 'tieba', readIndex: 1, probability: 1.5 }), '今日第 1 次自主逛贴吧完成（概率 100%）。');
  assert.equal(composeTemplateReportBody({ platform: 'tieba', readIndex: 1, probability: -0.2 }), '今日第 1 次自主逛贴吧完成（概率 0%）。');
});

test('大量未闭合标签不阻塞（线性扫描）', () => {
  const started = Date.now();
  const out = extractPatrolReportBlock('<patrol-report'.repeat(20000) + 'x'.repeat(500000));
  assert.equal(out.ok, false);
  assert.ok(Date.now() - started < 1000);
});

test('回归：非法 open 位于下标 0 且有 close 时不死循环（子进程超时保护）', () => {
  // 该输入曾让 findReportBlock 的 while 循环永远命中下标 0（lastIndexOf fromIndex=-1 被钳回 0），
  // 同步挂死事件循环。放进子进程并设超时，避免实现回退时把整个测试进程拖死。
  const cases = [
    '<patrol-reportx </patrol-report>',
    '<patrol-report</patrol-report>',
    '<patrol-reporty>正文</patrol-report>',
  ];
  const moduleUrl = new URL('../src/core/background-patrol-report-content.mjs', import.meta.url).href;
  const script = `
    const m = await import(${JSON.stringify(moduleUrl)});
    const cases = ${JSON.stringify(cases)};
    const out = cases.map((text) => m.extractPatrolReportBlock(text));
    process.stdout.write(JSON.stringify(out));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 5000,
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined, `子进程不应超时/失败：${result.error?.message ?? ''}`);
  assert.equal(result.status, 0, result.stderr);
  const outputs = JSON.parse(result.stdout);
  for (const out of outputs) {
    assert.equal(out.ok, false);
    assert.equal(out.present, false);
    assert.equal(out.reason, 'no-block');
  }
});

test('数字串分隔符变体：逗号/全角/加号/斜杠/顿号/分号/冒号/竖线均判 blocked', () => {
  const cases = [
    'QQ 123,456,789',
    '123，456，789',
    '123+456+789',
    '123/456/789',
    '123、456、789',
    '123;456;789',
    '123:456:789',
    '123|456|789',
    '1 2 3 4 5',
  ];
  for (const text of cases) {
    assert.equal(classifyReportSensitivity(text).classification, 'blocked', `应 blocked: ${text}`);
  }
});

test('不可见字符 Cf 家族：U+061C/U+180E/tag char/U+2065/U+FFF9 均判 blocked', () => {
  const cases = [
    'to\u061cken=abc',
    '密\u061c码',
    '\u180e',
    '\u{E0061}',
    '\u2065',
    '\ufff9',
  ];
  for (const text of cases) {
    assert.equal(classifyReportSensitivity(text).classification, 'blocked', `应 blocked: ${JSON.stringify(text)}`);
  }
});

test('emoji 变体选择符/ZWJ 属装饰字符：剥离后正常分类，不整段误杀', () => {
  for (const text of ['今天看到很多❤️帖子', '🏳️‍🌈', '1️⃣2️⃣', '👨‍👩‍👧', '😀👍🏻', '🏴󠁧󠁢󠁥󠁮󠁧󠁿', '🏴󠁧󠁢󠁳󠁣󠁴󠁿']) {
    assert.equal(classifyReportSensitivity(text).classification, 'non-sensitive', `不应误杀: ${JSON.stringify(text)}`);
  }
  // 剥离后能命中拆分绕过：ZWJ 拆 URL / 拆数字 / ZWSP 拆敏感词仍 blocked。
  assert.equal(classifyReportSensitivity('exam\u200dple.com').classification, 'blocked');
  assert.equal(classifyReportSensitivity('exam\u{e0061}ple.com').classification, 'blocked');
  assert.equal(classifyReportSensitivity('123\u200d45678').classification, 'blocked');
  assert.equal(classifyReportSensitivity('to\u200bken=abc').classification, 'blocked');
});

test('纯装饰字符正文（视觉空消息）判 blocked，不得以 non-sensitive 发群', () => {
  for (const text of ['\u200d', '\ufe0f', '\u200d'.repeat(50), '\u200d\ufe0f\u200d']) {
    assert.equal(classifyReportSensitivity(text).classification, 'blocked', `应 blocked: ${JSON.stringify(text)}`);
  }
  const plan = buildPatrolReportPlan({
    platform: 'tieba',
    readIndex: 3,
    probability: 80,
    turnText: '<patrol-report sensitive="false" destination="group">\u200d\u200d\ufe0f</patrol-report>',
    allowedGroups: ['123456'],
  });
  assert.equal(plan.classification, 'blocked');
  assert.equal(plan.destination, null);
  assert.equal(plan.groupId, null);
  assert.equal(plan.message, null);
});

test('新 TLD 与 IPv6：bit.ly / x.ai / foo.gg / 2001:db8::1 均判 blocked', () => {
  for (const text of ['见 bit.ly/abc', 'x.ai 主页', 'foo.gg/bar', '2001:db8::1']) {
    assert.equal(classifyReportSensitivity(text).classification, 'blocked', `应 blocked: ${text}`);
  }
  // 短链后缀（复审 P2 残留）与裸 ::1。
  for (const text of ['bit.do/x', 'is.gd/abc', 'v.gd/abc', 'shorturl.at/x', '::1']) {
    assert.equal(classifyReportSensitivity(text).classification, 'blocked', `应 blocked: ${text}`);
  }
  // 时刻写法不应被 IPv6 规则误伤成 blocked（走敏感词/无命中时仍是 non-sensitive）。
  assert.equal(classifyReportSensitivity('12:30 开会').classification, 'non-sensitive');
});

test('正文引用伪标签不影响块数判定（只有一个合法块时仍可提取）', () => {
  const text = `<patrol-report sensitive="false" destination="admin">今天聊到 <patrol-reportx> 这种写法。</patrol-report>`;
  const out = extractPatrolReportBlock(text);
  assert.equal(out.ok, true);
  assert.equal(out.present, true);
  assert.equal(out.sensitive, false);
});

test('导出分类器对超长文本有长度守卫（2 万 a. 不因正则回溯卡顿）', () => {
  const started = Date.now();
  const out = classifyReportSensitivity('a.'.repeat(20000));
  assert.equal(out.classification, 'blocked');
  assert.ok(Date.now() - started < 100, `耗时 ${Date.now() - started}ms`);
});

// task-190 自查缺陷：tooLongChars 曾在真实可达的路径上被丢掉（分类阶段返回 blocked 时
// 提前 return，走不到后面那道 codepointTotal 判定），导致 bridge 只能写「长度=unknown 码点」、
// 审计也拿不到码点数。这里钉住可达路径，且必须按「码点」而不是 UTF-16 长度计数。
test('tooLongChars：抽取层超长（>800 码点）必须带出码点数，且不发送', () => {
  const text = '😀'.repeat(900); // 900 码点 / 1800 UTF-16 单元
  const plan = buildPatrolReportPlan({ turnText: block({ text }) });
  assert.equal(plan.source, 'none');
  assert.equal(plan.classification, 'blocked');
  assert.equal(plan.destination, null);
  assert.ok(plan.reasons.includes('too-long'), JSON.stringify(plan.reasons));
  assert.equal(plan.tooLongChars, 900, '必须按码点计数，不是 UTF-16 长度 1800');
});

test('tooLongChars：纯中文长句超长同样带出码点数（不依赖 emoji 的 UTF-16 差）', () => {
  // 804 码点的纯中文（UTF-16 长度也是 804）：证明码点数的来源不是「UTF-16 与码点之差」。
  // 注意：抽取层与分类层共用 800 上限，超长在这里由**抽取层**拦下并带出码点数；
  // 分类阶段可达的 too-long 只有 NFKC 撑长（见下一个用例），那条路径按设计不带数字。
  const plan = buildPatrolReportPlan({ turnText: block({ text: '今天天气不错'.repeat(134) }) });
  assert.equal(plan.source, 'none');
  assert.equal(plan.classification, 'blocked');
  assert.ok(plan.reasons.includes('too-long'), JSON.stringify(plan.reasons));
  assert.equal(plan.tooLongChars, 804);
});

test('tooLongChars：NFKC 撑长但原始未超限时不得报一个小于上限的码点数', () => {
  // ﬁ(U+FB01) 500 码点 NFKC 展开成 1000 码点 ⇒ 分类器判 too-long，但原始长度 500 < 800。
  // 报 500 会让运维以为「500 码点就超限了」，所以宁可不带这个字段。
  const plan = buildPatrolReportPlan({ turnText: block({ text: '\uFB01'.repeat(500) }) });
  assert.equal(plan.classification, 'blocked');
  assert.ok(plan.reasons.includes('too-long'));
  assert.equal(Object.prototype.hasOwnProperty.call(plan, 'tooLongChars'), false);
});

test('tooLongChars：未超长时不得凭空出现该字段（避免审计多带键）', () => {
  const plan = buildPatrolReportPlan({ turnText: block({ text: '正常长度的一句话。' }) });
  assert.equal(plan.classification, 'non-sensitive', JSON.stringify(plan.reasons));
  assert.equal(plan.message, '正常长度的一句话。');
  assert.equal(Object.prototype.hasOwnProperty.call(plan, 'tooLongChars'), false);
});

test('M8 回归：分类阶段的 800 码点闸门必须自己拦住超长正文（不依赖提取层）', () => {
  // 变异 M8（删掉 classifyReportSensitivity 内的 too-long 闸门）时本用例必须变红：
  // 提取层有独立上限，但导出分类器可被任意调用，纵深防御不能只剩一层。
  assert.equal(classifyReportSensitivity('字'.repeat(800)).classification, 'non-sensitive');
  const over = classifyReportSensitivity('字'.repeat(801));
  assert.equal(over.classification, 'blocked');
  assert.ok(over.reasons.includes('too-long'), JSON.stringify(over.reasons));
  // emoji 按码点计：800 码点可接受（3200 UTF-16 code units），801 拒绝。
  assert.equal(classifyReportSensitivity('😀'.repeat(800)).classification, 'non-sensitive');
  const overEmoji = classifyReportSensitivity('😀'.repeat(801));
  assert.equal(overEmoji.classification, 'blocked');
  assert.ok(overEmoji.reasons.includes('too-long'));
  // 4096 的超长守卫仍独立存在（更长的输入按 blocked 处理，不得回溯卡顿）。
  assert.equal(classifyReportSensitivity('a.'.repeat(20000)).classification, 'blocked');
});
