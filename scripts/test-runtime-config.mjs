// 运行期配置解析的单元测试 + 与「抽取前旧 loadConfig」的差分特征测试。
//
// 约束：
//  · 不读生产 config.json / 凭据；差分只对照 scripts/fixtures/legacy-runtime-config.mjs。
//  · 该夹具是 2026-10-17 从历史快照窄复制出来的**不可变参照**（只含四个纯函数与默认常量），
//    测试不再读取 .agent-teams 下的历史快照，也不做源码抽取：历史快照被删除/改名后仍可运行。
//  · 夹具缺失或损坏必须**清晰失败**（静态 import + assertLegacyFixturePresent），禁止跳过。
//  · 不 import src/bridge.js；夹具的 I/O 全部是桩（readJsonSafe 返回测试对象、
//    discoverDshLaunchToken 返回 ''、log 捕获）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseRuntimeConfig,
  applyRoleInjectLimit,
  normalizeOwnerQQ,
  normalizeIdList
} from '../src/core/runtime-config.mjs';
import {
  createLegacyRuntimeConfig,
  assertLegacyFixturePresent,
  LEGACY_FIXTURE_PATH,
  ROLE_INJECT_MAX_CHARS_DEFAULT,
  SLANG_RECENT_RESERVE_DEFAULT
} from './fixtures/legacy-runtime-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const TEST_FILE = fileURLToPath(import.meta.url);
const MODULE_PATH = path.join(REPO_ROOT, 'src', 'core', 'runtime-config.mjs');
const FIXTURE_PATH = path.join(HERE, 'fixtures', 'legacy-runtime-config.mjs');
const CONFIG_PATH = 'X/config.json';

const REASONING_WARNING =
  '⚠️ config.json 的 dsh.reasoningEffort 不是字符串，已按「未设置」处理（selectModel 将省略该字段）';

function parse(file) {
  return parseRuntimeConfig(file, CONFIG_PATH);
}

// ── 直接用例：默认值 ───────────────────────────────────────────────────────

test('默认配置：loadConfig 的全部默认值', () => {
  const { config, diagnostics } = parse({});
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(Object.keys(parse({})).sort(), ['config', 'diagnostics']);

  assert.equal(config.dsh.baseUrl, 'http://127.0.0.1:3080');
  assert.equal(config.dsh.provider, 'deepseek-official');
  assert.equal(config.dsh.model, 'deepseek-flash');
  assert.equal(config.dsh.reasoningEffort, 'max');
  assert.equal(config.dsh.authToken, '');
  assert.equal(config.dsh.authHeader, 'authorization');
  assert.equal(config.dsh.authPrefix, 'Bearer');
  assert.equal(config.dsh.allowRemote, false);
  assert.equal(config.dsh.authTokenExplicit, false);

  assert.deepEqual(config.snowluma, { wsUrl: 'ws://127.0.0.1:3001', accessToken: '' });
  assert.equal(config.sessionCwd, '');
  assert.equal(config.agentPreset, 'qq-chat');
  assert.equal(config.workspaceTitle, 'QQ 聊天');
  assert.equal(config.ownerQQ, null);
  assert.deepEqual(config.allow, { private: [], groups: [] });
  assert.deepEqual(config.deny, { private: [], groups: [] });
  assert.equal(config.allowAllWhenEmpty, false);
  assert.equal(config.ackMessage, '🤔 收到，正在思考…');
  assert.equal(config.sendDelayMs, 300);
  assert.equal(config.questionTimeoutMs, 5 * 60 * 1000);
  assert.equal(config.consolePort, 3100);
  assert.equal(config.consoleToken, '');
  assert.equal(config.pricing, null);
  assert.deepEqual(config.security, { interceptNotify: true });

  assert.equal(config.slang.enabled, true);
  assert.equal(config.slang.extractMinMessages, 10);
  assert.equal(config.slang.extractCooldownMs, 5 * 60 * 1000);
  assert.deepEqual(config.slang.inferenceThresholds, [2, 4, 8]);
  assert.equal(config.slang.injectMax, 8);
  assert.equal(config.slang.recentReserve, SLANG_RECENT_RESERVE_DEFAULT);
  assert.equal(config.slang.learnerPreset, 'qq-chat');
  assert.equal(config.slang.workspaceTitle, 'QQ 黑话学习');
  assert.equal(config.slang.autoResearch, true);

  assert.equal(config.social.enabled, true);
  assert.equal(config.social.triggerProbability, 0.1);
  assert.equal(config.social.contextWindow, 20);
  assert.equal(config.social.activeDurationMaxMs, 30 * 60 * 1000);
  assert.equal(config.social.proactiveCheckMaxMs, 90 * 60 * 1000);
  assert.equal(config.social.surrenderProbability, 0);
  assert.deepEqual(config.social.mustReplyKeywords, ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗']);
  assert.equal(config.social.longGapMaxMs, 5000);

  assert.equal(config.socialV2.enabled, true);
  assert.equal(config.socialV2.autoReplyCheckMs, 30000);
  assert.equal(config.socialV2.agentPreset, 'qq-chat-v2');
  assert.equal(config.socialV2.provideRecommendations, true);

  // tools 的完整默认表（其中 slangQuery/slangSubmit/sendVoice/sendImage/patrol
  // 不在 socialV2 内联字面量里，必须由深度合并补齐）。
  assert.deepEqual(config.socialV2.tools, {
    getPrompt: true, getUnread: true, getRecent: true, socialState: true,
    sendGroup: true, sendPrivate: true, reply: true, sendBurst: true,
    sendMessage: true, waitMessages: true, feedback: true, getMyRecent: true,
    getMessageDetail: true, getActiveMembers: true, setWakeConfig: true,
    markRead: true, memory: true, slangQuery: true, slangSubmit: true,
    getImages: true, getForwardMsg: true, sendPoke: true, listStickers: true,
    getStickerImage: true, sendSticker: true, setStickerRemark: false,
    stickerNote: true, collectSticker: true, getSelfImage: true,
    sendVoice: false, sendImage: true, patrol: true
  });

  assert.equal(config.socialV2.wake.defaultMode, 'diving');
  assert.equal(config.socialV2.wake.preSleepWaitMs, 300000);
  assert.equal(config.socialV2.wake.recommendedDefaultInfinite, true);
  assert.equal(config.socialV2.wake.batchWindowMs, 8000);

  assert.equal(config.socialV2.send.maxSendPerHour, 60);
  assert.equal(config.socialV2.send.maxMessageChars, 500);
  assert.equal(config.socialV2.wait.minQuietAfterNewMs, 10000);

  assert.deepEqual(config.socialV2.sticker.collect, {
    enabled: true, maxPerMinute: 2, maxPerHour: 10, maxRemarkChars: 20
  });
  assert.equal(config.socialV2.sticker.syncTtlMs, 60000);

  assert.deepEqual(config.socialV2.voice, {
    enabled: false,
    dir: 'audio',
    maxSeconds: 300,
    maxBytes: 20 * 1024 * 1024,
    maxPerMinute: 2,
    maxPerHour: 10,
    allowAbsolutePath: false,
    defaultVolume: 1,
    loudness: 'normal',
    ffmpegPath: '',
    autoReadback: true
  });

  assert.equal(config.socialV2.proactive.probability, 0.3);
  assert.deepEqual(config.socialV2.feedback, { maxLength: 500, notifyOwnerOnError: false });
  assert.equal(config.socialV2.context.wakeMaxChars, 6000);
  assert.deepEqual(config.socialV2.tieba, { cookieFile: '' });
  assert.deepEqual(config.socialV2.patrol, {
    enabled: true, dailyVisitCap: 12, maxPagesPerThread: 2, quietHours: [1, 8]
  });

  assert.deepEqual(config.role, { maxInjectChars: ROLE_INJECT_MAX_CHARS_DEFAULT });
});

// ── 直接用例：部分配置与深度合并 ───────────────────────────────────────────

test('部分配置：覆盖项生效、缺省项保留默认、socialV2 各节深度合并', () => {
  const { config, diagnostics } = parse({
    dsh: { baseUrl: 'http://example:9999', model: 'm', reasoningEffort: '  high  ', authToken: 'tok' },
    snowluma: { wsUrl: 'ws://other' },
    sessionCwd: 'C:/tmp/agent',
    agentPreset: 'custom-preset',
    workspaceTitle: '自定义标题',
    ownerQQ: ' 123456 ',
    allow: { privates: [' 1 ', 'abc'], group: [2, '003'] },
    deny: { private: [7], groups: 'not-an-array' },
    allowAllWhenEmpty: true,
    ackMessage: '',
    sendDelayMs: 0,
    questionTimeoutMs: 0,
    consolePort: 4100,
    consoleToken: 'ct',
    pricing: { model: 1 },
    security: { interceptNotify: false, extra: 1 },
    slang: { injectMax: 3, recentReserve: 1 },
    social: { enabled: false, triggerProbability: 0.5 },
    socialV2: {
      enabled: false,
      tools: { setStickerRemark: true, sendVoice: true, customTool: 1 },
      voice: { enabled: true, maxSeconds: 10 },
      sticker: { enabled: false, collect: { maxPerMinute: 9, extra: true } },
      tieba: { cookieFile: 'state/cookies.txt' },
      patrol: { enabled: false, dailyVisitCap: 3, quietHours: [23, 7] }
    },
    role: { maxInjectChars: 8000 }
  });

  assert.deepEqual(diagnostics, []);
  assert.equal(config.dsh.baseUrl, 'http://example:9999');
  assert.equal(config.dsh.model, 'm');
  assert.equal(config.dsh.provider, 'deepseek-official');
  assert.equal(config.dsh.reasoningEffort, 'high');
  assert.equal(config.dsh.authToken, 'tok');
  assert.equal(config.dsh.authTokenExplicit, true);
  assert.equal(config.snowluma.wsUrl, 'ws://other');
  assert.equal(config.sessionCwd, 'C:/tmp/agent');
  assert.equal(config.agentPreset, 'custom-preset');
  assert.equal(config.workspaceTitle, '自定义标题');
  assert.equal(config.ownerQQ, 123456);
  assert.deepEqual(config.allow, { private: ['1'], groups: ['2', '003'] });
  assert.deepEqual(config.deny, { private: ['7'], groups: [] });
  assert.equal(config.allowAllWhenEmpty, true);
  assert.equal(config.ackMessage, '');
  assert.equal(config.sendDelayMs, 0);
  assert.equal(config.questionTimeoutMs, 0);
  assert.equal(config.consolePort, 4100);
  assert.equal(config.consoleToken, 'ct');
  assert.deepEqual(config.pricing, { model: 1 });
  assert.deepEqual(config.security, { interceptNotify: false, extra: 1 });
  assert.equal(config.slang.injectMax, 3);
  assert.equal(config.slang.recentReserve, 1);
  assert.equal(config.slang.enabled, true);
  assert.equal(config.social.enabled, false);
  assert.equal(config.social.triggerProbability, 0.5);
  assert.equal(config.social.activeCheckMinMs, 10000);

  assert.equal(config.socialV2.enabled, false);
  assert.equal(config.socialV2.autoReplyCheckMs, 30000);
  assert.equal(config.socialV2.tools.setStickerRemark, true);
  assert.equal(config.socialV2.tools.sendVoice, true);
  assert.equal(config.socialV2.tools.customTool, 1);
  assert.equal(config.socialV2.tools.getPrompt, true);
  assert.equal(config.socialV2.voice.enabled, true);
  assert.equal(config.socialV2.voice.maxSeconds, 10);
  assert.equal(config.socialV2.voice.dir, 'audio');
  assert.equal(config.socialV2.sticker.enabled, false);
  assert.equal(config.socialV2.sticker.syncTtlMs, 60000);
  assert.deepEqual(config.socialV2.sticker.collect, {
    enabled: true, maxPerMinute: 9, maxPerHour: 10, maxRemarkChars: 20, extra: true
  });
  assert.deepEqual(config.socialV2.tieba, { cookieFile: 'state/cookies.txt' });
  assert.equal(config.socialV2.patrol.enabled, false);
  assert.equal(config.socialV2.patrol.dailyVisitCap, 3);
  assert.equal(config.socialV2.patrol.maxPagesPerThread, 2);
  assert.deepEqual(config.socialV2.patrol.quietHours, [23, 7]);
  assert.deepEqual(config.role, { maxInjectChars: 8000 });
});

test('socialV2 非对象 / null 子节与空工具表：spread 怪癖与深度合并默认值', () => {
  assert.equal(parse({ socialV2: null }).config.socialV2.tools.patrol, true);
  assert.equal(parse({ socialV2: { tools: false } }).config.socialV2.tools.getPrompt, true);
  assert.equal(parse({ socialV2: { tools: null } }).config.socialV2.tools.slangQuery, true);
  assert.deepEqual(parse({ socialV2: { voice: null } }).config.socialV2.voice, {
    enabled: false, dir: 'audio', maxSeconds: 300, maxBytes: 20 * 1024 * 1024,
    maxPerMinute: 2, maxPerHour: 10, allowAbsolutePath: false, defaultVolume: 1,
    loudness: 'normal', ffmpegPath: '', autoReadback: true
  });
  assert.deepEqual(parse({ socialV2: { sticker: null } }).config.socialV2.sticker.collect, {
    enabled: true, maxPerMinute: 2, maxPerHour: 10, maxRemarkChars: 20
  });
  // tieba / patrol 的深度合并有「必须是普通对象且非数组」的守卫。
  assert.deepEqual(parse({ socialV2: { tieba: 'x' } }).config.socialV2.tieba, { cookieFile: '' });
  assert.deepEqual(parse({ socialV2: { tieba: ['x'] } }).config.socialV2.tieba, { cookieFile: '' });
  assert.deepEqual(parse({ socialV2: { patrol: ['x'] } }).config.socialV2.patrol, {
    enabled: true, dailyVisitCap: 12, maxPagesPerThread: 2, quietHours: [1, 8]
  });
  // sticker.collect 的两次合并：外层 spread 不会把 collect 默认值清掉。
  assert.deepEqual(
    parse({ socialV2: { sticker: { enabled: false } } }).config.socialV2.sticker.collect,
    { enabled: true, maxPerMinute: 2, maxPerHour: 10, maxRemarkChars: 20 }
  );
  // security 的非对象 spread 与 ?? 语义。
  assert.deepEqual(parse({ security: null }).config.security, { interceptNotify: true });
  assert.deepEqual(parse({ security: 'ab' }).config.security, { 0: 'a', 1: 'b', interceptNotify: true });
});

// ── 直接用例：reasoningEffort 三态 ─────────────────────────────────────────

test('reasoningEffort：缺失= max，null/空串= 空，字符串 trim，非字符串=空+警告', () => {
  assert.equal(parse({}).config.dsh.reasoningEffort, 'max');
  assert.equal(parse({ dsh: {} }).config.dsh.reasoningEffort, 'max');
  assert.equal(parse({ dsh: { reasoningEffort: null } }).config.dsh.reasoningEffort, '');
  assert.equal(parse({ dsh: { reasoningEffort: '' } }).config.dsh.reasoningEffort, '');
  assert.equal(parse({ dsh: { reasoningEffort: '   ' } }).config.dsh.reasoningEffort, '');
  assert.equal(parse({ dsh: { reasoningEffort: '  xhigh  ' } }).config.dsh.reasoningEffort, 'xhigh');

  const numeric = parse({ dsh: { reasoningEffort: 5 } });
  assert.equal(numeric.config.dsh.reasoningEffort, '');
  assert.deepEqual(numeric.diagnostics, [
    { code: 'reasoning-effort-non-string', level: 'warn', message: REASONING_WARNING }
  ]);

  const objectValue = parse({ dsh: { reasoningEffort: { level: 'high' } } });
  assert.equal(objectValue.config.dsh.reasoningEffort, '');
  assert.deepEqual(objectValue.diagnostics.map((d) => d.message), [REASONING_WARNING]);

  const booleanValue = parse({ dsh: { reasoningEffort: true } });
  assert.equal(booleanValue.config.dsh.reasoningEffort, '');
  assert.deepEqual(booleanValue.diagnostics.map((d) => d.message), [REASONING_WARNING]);
});

test('reasoningEffort：dsh 非普通对象时不做三态判断（保持 max）', () => {
  for (const dsh of [null, [], 'x', 42]) {
    const { config, diagnostics } = parse({ dsh });
    assert.equal(config.dsh.reasoningEffort, 'max', `dsh=${JSON.stringify(dsh)}`);
    assert.deepEqual(diagnostics, [], `dsh=${JSON.stringify(dsh)}`);
  }
});

test('诊断顺序：reasoningEffort 警告在前，role 上限校正警告在后', () => {
  const { diagnostics } = parse({
    dsh: { reasoningEffort: 5 },
    role: { maxInjectChars: 999 }
  });
  assert.deepEqual(diagnostics, [
    { code: 'reasoning-effort-non-string', level: 'warn', message: REASONING_WARNING },
    {
      code: 'role-inject-limit-clamped',
      level: 'warn',
      message: '人格注入上限已按范围校正为 1000 字符（配置值 999，允许 1000~20000）'
    }
  ]);
});

// ── 直接用例：ownerQQ / allow / deny ──────────────────────────────────────

test('normalizeOwnerQQ：空值=null，正整数保留，非法抛入口同款文案', () => {
  assert.equal(normalizeOwnerQQ(undefined), null);
  assert.equal(normalizeOwnerQQ(null), null);
  assert.equal(normalizeOwnerQQ(''), null);
  assert.equal(normalizeOwnerQQ('   '), null);
  assert.equal(normalizeOwnerQQ(12345), 12345);
  assert.equal(normalizeOwnerQQ(' 12345 '), 12345);
  assert.equal(normalizeOwnerQQ('000123'), 123);

  for (const bad of ['abc', '-5', '0', '1.5', '12a', '9007199254740993', true, {}]) {
    assert.throws(
      () => normalizeOwnerQQ(bad),
      { message: 'ownerQQ 必须是 QQ 号（正整数）' },
      `value=${JSON.stringify(bad)}`
    );
  }
});

test('normalizeIdList：非数组=空表，字符串化+trim+纯数字过滤', () => {
  assert.deepEqual(normalizeIdList(null), []);
  assert.deepEqual(normalizeIdList('123'), []);
  assert.deepEqual(normalizeIdList({ 0: 1 }), []);
  assert.deepEqual(normalizeIdList([]), []);
  assert.deepEqual(normalizeIdList([1, ' 2 ', 'abc', '003', null, '', -1, '1.5', '  ']), ['1', '2', '003']);
  assert.deepEqual(normalizeIdList(['０１２']), [], '全角数字不算纯数字');
});

test('allow/deny 别名、?? 回退与过滤', () => {
  const alias = parse({
    allow: { privates: [' 1 ', 'abc'], group: [2, '003'] },
    deny: { privates: [7], groups: 'not-an-array' }
  }).config;
  assert.deepEqual(alias.allow, { private: ['1'], groups: ['2', '003'] });
  assert.deepEqual(alias.deny, { private: ['7'], groups: [] });

  // private 是空数组时不会回退到 privates（?? 只认 null/undefined）。
  assert.deepEqual(parse({ allow: { private: [], privates: [5] } }).config.allow.private, []);
  // private 是 null 时才回退到 privates。
  assert.deepEqual(parse({ allow: { private: null, privates: [5] } }).config.allow.private, ['5']);
  // allow 整体非对象时按未配置处理。
  assert.deepEqual(parse({ allow: 'x' }).config.allow, { private: [], groups: [] });

  assert.equal(parse({ allowAllWhenEmpty: true }).config.allowAllWhenEmpty, true);
  assert.equal(parse({ allowAllWhenEmpty: 'true' }).config.allowAllWhenEmpty, false);
  assert.equal(parse({ allowAllWhenEmpty: 1 }).config.allowAllWhenEmpty, false);
});

test('?? 语义：只替换 null/undefined，空串 0 false 原样保留', () => {
  const { config } = parse({
    sessionCwd: 0,
    agentPreset: '',
    workspaceTitle: '',
    ackMessage: '',
    sendDelayMs: null,
    questionTimeoutMs: 0,
    consolePort: null,
    consoleToken: null,
    pricing: 0,
    ownerQQ: ''
  });
  assert.equal(config.sessionCwd, 0);
  assert.equal(config.agentPreset, '');
  assert.equal(config.workspaceTitle, '');
  assert.equal(config.ackMessage, '');
  assert.equal(config.sendDelayMs, 300);
  assert.equal(config.questionTimeoutMs, 0);
  assert.equal(config.consolePort, 3100);
  assert.equal(config.consoleToken, '');
  assert.equal(config.pricing, 0);
  assert.equal(config.ownerQQ, null);
});

// ── 直接用例：role 上限校正 ────────────────────────────────────────────────

test('applyRoleInjectLimit：非有限值回默认，否则四舍五入并夹在 1000~20000', () => {
  assert.equal(applyRoleInjectLimit(999), 1000);
  assert.equal(applyRoleInjectLimit(1000), 1000);
  assert.equal(applyRoleInjectLimit(1000.4), 1000);
  assert.equal(applyRoleInjectLimit(1000.5), 1001);
  assert.equal(applyRoleInjectLimit(6000), 6000);
  assert.equal(applyRoleInjectLimit(20000), 20000);
  assert.equal(applyRoleInjectLimit(20001), 20000);
  assert.equal(applyRoleInjectLimit(NaN), ROLE_INJECT_MAX_CHARS_DEFAULT);
  assert.equal(applyRoleInjectLimit(Infinity), ROLE_INJECT_MAX_CHARS_DEFAULT);
  assert.equal(applyRoleInjectLimit(undefined), ROLE_INJECT_MAX_CHARS_DEFAULT);
  assert.equal(applyRoleInjectLimit('abc'), ROLE_INJECT_MAX_CHARS_DEFAULT);
  assert.equal(applyRoleInjectLimit('-5'), 1000);
  assert.equal(applyRoleInjectLimit(''), 1000);
  assert.equal(applyRoleInjectLimit(null), 1000);
});

test('role.maxInjectChars：保留原始值，只有校正值不同才产生警告（含字符串/NaN 怪癖）', () => {
  const noWarn = [1000, 6000, 20000, ROLE_INJECT_MAX_CHARS_DEFAULT];
  for (const value of noWarn) {
    const { config, diagnostics } = parse({ role: { maxInjectChars: value } });
    assert.equal(config.role.maxInjectChars, value);
    assert.deepEqual(diagnostics, [], `value=${value}`);
  }

  const absent = parse({});
  assert.deepEqual(absent.diagnostics, []);
  assert.equal(absent.config.role.maxInjectChars, ROLE_INJECT_MAX_CHARS_DEFAULT);

  const cases = [
    [999, 1000, '999'],
    [20001, 20000, '20001'],
    [1000.4, 1000, '1000.4'],
    [NaN, 6000, 'NaN'],
    [Infinity, 6000, 'Infinity'],
    [null, 1000, 'null'],
    ['', 1000, ''],
    ['6000', 6000, '6000'],
    [undefined, 6000, 'undefined']
  ];
  for (const [raw, clamped, shown] of cases) {
    const { config, diagnostics } = parse({ role: { maxInjectChars: raw } });
    assert.equal(config.role.maxInjectChars, raw, `raw=${shown}`);
    assert.equal(diagnostics.length, 1, `raw=${shown}`);
    assert.equal(diagnostics[0].code, 'role-inject-limit-clamped');
    assert.equal(diagnostics[0].level, 'warn');
    assert.equal(
      diagnostics[0].message,
      `人格注入上限已按范围校正为 ${clamped} 字符（配置值 ${shown}，允许 1000~20000）`,
      `raw=${shown}`
    );
  }

  // 字符串 '6000' 数值相同但类型不同，旧实现仍会打警告（严格不等）。
  assert.equal(
    parse({ role: { maxInjectChars: '6000' } }).diagnostics[0].message,
    '人格注入上限已按范围校正为 6000 字符（配置值 6000，允许 1000~20000）'
  );
});

test('role 非对象值：spread 怪癖与默认值', () => {
  assert.deepEqual(parse({ role: null }).config.role, { maxInjectChars: ROLE_INJECT_MAX_CHARS_DEFAULT });
  assert.deepEqual(parse({ role: 5 }).config.role, { maxInjectChars: ROLE_INJECT_MAX_CHARS_DEFAULT });
  assert.deepEqual(parse({ role: 'x' }).config.role, { 0: 'x', maxInjectChars: ROLE_INJECT_MAX_CHARS_DEFAULT });
});

test('parseRuntimeConfig 不修改模块级状态：连续解析互不影响', () => {
  assert.equal(parse({ role: { maxInjectChars: 20001 } }).diagnostics.length, 1);
  const after = parse({});
  assert.equal(after.config.role.maxInjectChars, ROLE_INJECT_MAX_CHARS_DEFAULT);
  assert.deepEqual(after.diagnostics, []);
});

// ── 直接用例：顶层格式与纯函数约束 ─────────────────────────────────────────

test('顶层不是普通对象时抛入口同款「配置格式错误」', () => {
  for (const bad of [null, [], 'x', 42]) {
    assert.throws(
      () => parseRuntimeConfig(bad, CONFIG_PATH),
      { message: `配置格式错误：${CONFIG_PATH}` },
      `file=${JSON.stringify(bad)}`
    );
  }
});

test('parseRuntimeConfig 不修改传入的配置对象', () => {
  const file = {
    dsh: { reasoningEffort: 'high' },
    socialV2: { tools: { markRead: false }, sticker: { collect: { maxPerMinute: 9 } } },
    role: { maxInjectChars: 8000 }
  };
  const before = JSON.stringify(file);
  parse(file);
  assert.equal(JSON.stringify(file), before);
});

test('模块保持纯净：没有 fs/网络/日志/定时器/凭据发现/bridge import', () => {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  // 去掉整行注释（文档块与行注释），只看可执行代码。
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  const forbidden = [
    [/from\s+['"]node:(fs|net|http|https|dgram|child_process|dns|tls)['"]/, 'node I/O 模块'],
    [/\bdiscoverDshLaunchToken\b/, '凭据发现'],
    [/\bconsole\s*\./, '日志'],
    [/\b(setTimeout|setInterval|setImmediate)\s*\(/, '定时器'],
    [/\bDate\.now\s*\(|\bnew\s+Date\s*\(/, '时钟'],
    [/\bfetch\s*\(/, '网络请求'],
    [/from\s+['"].*bridge\.js['"]/, 'bridge 入口']
  ];
  for (const [pattern, label] of forbidden) {
    assert.ok(!pattern.test(code), `runtime-config.mjs 不应包含${label}`);
  }
  assert.match(code, /from\s+['"]\.\/role-store\.mjs['"]/);
  assert.match(code, /from\s+['"]\.\.\/slang-learner\.js['"]/);
});

// ── 差分特征测试：夹具里的旧 loadConfig ────────────────────────────────────

// 夹具加载本身即为「强制存在」检查：静态 import 失败会让整个测试文件报错。
assertLegacyFixturePresent(LEGACY_FIXTURE_PATH);

function runLegacy(file) {
  const legacy = createLegacyRuntimeConfig({ file, configPath: CONFIG_PATH });
  try {
    return { config: legacy.loadConfig(), messages: legacy.messages, error: null, api: legacy };
  } catch (error) {
    return { config: null, messages: legacy.messages, error: error.message, api: legacy };
  }
}

function runNew(file) {
  try {
    const { config, diagnostics } = parseRuntimeConfig(file, CONFIG_PATH);
    return { config, messages: diagnostics.map((d) => d.message), error: null };
  } catch (error) {
    return { config: null, messages: [], error: error.message };
  }
}

const DIFFERENTIAL_CASES = [
  ['空配置', {}],
  ['完整部分配置', {
    dsh: { baseUrl: 'http://example:9999', model: 'm', reasoningEffort: '  high  ', authToken: 'tok' },
    snowluma: { wsUrl: 'ws://other' },
    sessionCwd: 'C:/tmp/agent',
    agentPreset: 'custom-preset',
    workspaceTitle: '自定义标题',
    ownerQQ: '123456',
    allow: { privates: ['1', 'abc'], group: [2, '003'] },
    deny: { privates: [7], groups: 'nope' },
    allowAllWhenEmpty: true,
    ackMessage: '',
    sendDelayMs: 0,
    questionTimeoutMs: 123,
    consolePort: 4100,
    consoleToken: 'ct',
    pricing: { model: 1 },
    security: { interceptNotify: false, extra: 1 },
    slang: { injectMax: 3, recentReserve: 1 },
    social: { enabled: false, triggerProbability: 0.5 },
    socialV2: {
      enabled: false,
      tools: { setStickerRemark: true, sendVoice: true, custom: 1 },
      voice: { enabled: true, maxSeconds: 10 },
      sticker: { enabled: false, collect: { maxPerMinute: 9, extra: true } },
      tieba: { cookieFile: 'c' },
      patrol: { enabled: false, dailyVisitCap: 3, quietHours: [23, 7] }
    },
    role: { maxInjectChars: 8000 }
  }],
  ['reasoningEffort null', { dsh: { reasoningEffort: null } }],
  ['reasoningEffort 空串', { dsh: { reasoningEffort: '' } }],
  ['reasoningEffort 空白', { dsh: { reasoningEffort: '   ' } }],
  ['reasoningEffort 数字（警告）', { dsh: { reasoningEffort: 5 } }],
  ['reasoningEffort 对象（警告）', { dsh: { reasoningEffort: { x: 1 } } }],
  ['dsh null', { dsh: null }],
  ['dsh 数组', { dsh: [] }],
  ['dsh 字符串（spread）', { dsh: 'x' }],
  ['socialV2 null', { socialV2: null }],
  ['socialV2 字符串（spread）', { socialV2: 'ab' }],
  ['socialV2.tools false', { socialV2: { tools: false } }],
  ['socialV2.tools 部分', { socialV2: { tools: { markRead: false, sendVoice: true } } }],
  ['socialV2.voice null', { socialV2: { voice: null } }],
  ['socialV2.sticker 部分 collect', { socialV2: { sticker: { enabled: false, collect: { maxPerMinute: 9 } } } }],
  ['socialV2.sticker null', { socialV2: { sticker: null } }],
  ['socialV2.tools 字符串（spread）', { socialV2: { tools: 'ab' } }],
  ['socialV2.tieba 字符串', { socialV2: { tieba: 'x' } }],
  ['socialV2.tieba 数组', { socialV2: { tieba: ['x'] } }],
  ['socialV2.patrol 数组', { socialV2: { patrol: ['x'] } }],
  ['socialV2.patrol 部分', { socialV2: { patrol: { dailyVisitCap: 3, quietHours: [23, 7] } } }],
  ['security null', { security: null }],
  ['security 字符串（spread）', { security: 'ab' }],
  ['slang 字符串（spread）', { slang: 'ab' }],
  ['social null', { social: null }],
  ['allow null', { allow: null }],
  ['deny 数组', { deny: ['x'] }],
  ['snowluma 字符串（spread）', { snowluma: 'ab' }],
  ['dsh authToken 显式空串', { dsh: { authToken: '' } }],
  ['pricing 数组', { pricing: [1, 2] }],
  ['role 999（校正）', { role: { maxInjectChars: 999 } }],
  ['role 1000', { role: { maxInjectChars: 1000 } }],
  ['role 20001（校正）', { role: { maxInjectChars: 20001 } }],
  ['role 1000.4（校正）', { role: { maxInjectChars: 1000.4 } }],
  ['role NaN（校正）', { role: { maxInjectChars: NaN } }],
  ['role null（校正）', { role: { maxInjectChars: null } }],
  ['role 空串（校正）', { role: { maxInjectChars: '' } }],
  ['role 字符串 6000（类型严格不等）', { role: { maxInjectChars: '6000' } }],
  ['role undefined（警告）', { role: { maxInjectChars: undefined } }],
  ['role 非对象', { role: 'x' }],
  ['reasoning + role 双警告顺序', { dsh: { reasoningEffort: 5 }, role: { maxInjectChars: 999 } }],
  ['ownerQQ 非法（抛错）', { ownerQQ: 'abc' }],
  ['顶层 null（抛错）', null],
  ['顶层数组（抛错）', []],
  ['顶层字符串（抛错）', 'x']
];

test('差分：旧 loadConfig 的 cfg 与 log 顺序和 parseRuntimeConfig 完全一致', () => {
  // 条数自证：任何一条差分用例被删/被合并都会立刻红，而不是悄悄少测。
  assert.equal(DIFFERENTIAL_CASES.length, 46, '差分用例必须全部保留（46 条）');
  for (const [name, file] of DIFFERENTIAL_CASES) {
    const legacy = runLegacy(file);
    const current = runNew(file);
    if (legacy.error || current.error) {
      assert.equal(current.error, legacy.error, `${name}：抛错文案不一致`);
      continue;
    }
    assert.deepEqual(current.config, legacy.config, `${name}：config 不一致`);
    assert.deepEqual(current.messages, legacy.messages, `${name}：诊断/日志顺序不一致`);
  }
});

test('差分：applyRoleInjectLimit / normalizeOwnerQQ / normalizeIdList 与旧实现一致', () => {
  const legacy = runLegacy({});
  const limitValues = [undefined, null, '', '  ', '0', 0, -5, 1, 999, 1000, 1000.4, 1000.5,
    6000, 20000, 20001, 99999, NaN, Infinity, -Infinity, '6000', 'abc', true, {}, []];
  for (const value of limitValues) {
    assert.equal(
      applyRoleInjectLimit(value),
      legacy.api.applyRoleInjectLimit(value),
      `applyRoleInjectLimit(${String(value)})`
    );
  }

  const idListValues = [undefined, null, [], [1, ' 2 ', 'abc', '003', -1, ''], '123', { 0: 1 },
    [true, false, null], ['０１２']];
  for (const value of idListValues) {
    assert.deepEqual(
      normalizeIdList(value),
      legacy.api.normalizeIdList(value),
      `normalizeIdList(${JSON.stringify(value)})`
    );
  }

  const ownerValues = [undefined, null, '', '  ', 12345, ' 12345 ', '000123', 'abc', '-5', '0',
    '1.5', '9007199254740993', true, {}];
  const capture = (fn, value) => {
    try { return { value: fn(value), error: null }; }
    catch (error) { return { value: null, error: error.message }; }
  };
  for (const value of ownerValues) {
    assert.deepEqual(
      capture(normalizeOwnerQQ, value),
      capture(legacy.api.normalizeOwnerQQ, value),
      `normalizeOwnerQQ(${JSON.stringify(value)})`
    );
  }
});

// ── focused 回归：夹具可移植性 / 强制存在 / 不依赖历史快照 ──────────────────

// 只看可执行代码：整行注释（含夹具头的来源说明）不参与依赖判断。
function executableLines(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

test('夹具头：provenance（唯一来源 + 抽取日期）与「不可变参照」声明齐备', () => {
  assert.equal(LEGACY_FIXTURE_PATH, FIXTURE_PATH, '测试引用的夹具必须就是 scripts/fixtures 下的基线');
  const source = fs.readFileSync(FIXTURE_PATH, 'utf8');
  assert.match(source, /来源：\.agent-teams\/modularization-stage2-20261017\/snapshot\/bridge\.start\.js/);
  assert.match(source, /抽取日期 2026-10-17/);
  assert.match(source, /仅测试用/);
  assert.match(source, /不可变参照/);
  assert.match(source, /不是第二生产实现/);
  assert.match(source, /禁止 import 当前 src 反推期望值|不得 import 当前 src/);
});

test('夹具强制存在：缺失路径由 loader 清晰失败，而不是跳过', () => {
  assert.equal(assertLegacyFixturePresent(), FIXTURE_PATH);
  assert.ok(fs.existsSync(FIXTURE_PATH), '差分基线夹具必须随仓库提交');

  const missing = path.join(HERE, 'fixtures', '__missing__legacy-runtime-config.mjs');
  let caught = null;
  try {
    assertLegacyFixturePresent(missing);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, '缺失的夹具路径必须抛错（禁止 skip）');
  assert.match(caught.message, /旧 loadConfig 差分基线夹具缺失/);
  assert.ok(caught.message.includes(missing), '错误信息必须包含缺失路径，便于定位');
});

test('测试与夹具的依赖面封闭：只 import/读取已知文件，不读历史快照', () => {
  const testCode = executableLines(fs.readFileSync(TEST_FILE, 'utf8'));
  const fixtureCode = executableLines(fs.readFileSync(FIXTURE_PATH, 'utf8'));

  // 1) 测试的静态 import 只允许这些模块（没有快照、没有 bridge、没有 vm）。
  const ALLOWED_IMPORTS = new Set([
    'node:test', 'node:assert/strict', 'node:fs', 'node:path', 'node:url',
    '../src/core/runtime-config.mjs', './fixtures/legacy-runtime-config.mjs'
  ]);
  const specifiers = [...testCode.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.ok(specifiers.length >= 6, '测试应保持 node:test/assert/fs/path/url + 被测模块 + 夹具的 import 面');
  for (const spec of specifiers) {
    assert.ok(ALLOWED_IMPORTS.has(spec), `测试出现未登记的 import：${spec}`);
  }
  assert.ok(!/\bimport\s*\(/.test(testCode), '测试不得动态 import（那才需要快照在盘）');

  // 2) 测试只读三个已知文件：自身、夹具、被测模块。
  const reads = [...testCode.matchAll(/fs\.readFileSync\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  assert.ok(reads.length >= 2, '测试应通过 fs.readFileSync 检查自身/夹具/模块源码');
  for (const arg of reads) {
    assert.match(arg, /^(TEST_FILE|FIXTURE_PATH|MODULE_PATH)$/, `fs.readFileSync 只允许读已知文件：${arg}`);
  }

  // 3) 夹具的 import 面同样封闭，且不抽取源码。
  const fixtureImports = [...fixtureCode.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  for (const spec of fixtureImports) {
    assert.ok(['node:fs', 'node:url'].includes(spec), `夹具出现未登记的 import：${spec}`);
  }
  // 4) 不抽取源码 / 不碰 vm。token 用拼接构造：否则断言自身的文本会把
  //    「被禁止的 token」算进被检查的源码里（自指）。
  const BANNED_TOKENS = ['SNAPSHOT' + '_PATH', 'extract' + 'Function', 'node' + ':vm'];
  for (const [label, code] of [['测试', testCode], ['夹具', fixtureCode]]) {
    assert.ok(!/new\s+Function\s*\(/.test(code), `${label}不得用 Function 构造器抽取源码`);
    for (const token of BANNED_TOKENS) {
      assert.ok(!code.includes(token), `${label}不得出现 ${token}`);
    }
  }

  // 结构证据：差分只通过夹具模块的纯函数入口发生，快照不可用时照常运行。
  assert.ok(testCode.includes('./fixtures/legacy-runtime-config.mjs'), '差分应直接引用夹具模块');
  assert.ok(!/fs\.readFileSync\([^)]*snapshot/.test(testCode));
  assert.match(fixtureCode, /export function createLegacyRuntimeConfig/);
});

test('夹具每次调用都是独立作用域：旧 loadConfig 的模块级上限不跨调用泄漏', () => {
  const first = createLegacyRuntimeConfig({ file: { role: { maxInjectChars: 20001 } } });
  first.loadConfig();
  assert.equal(first.roleInjectMaxChars, 20000);
  assert.deepEqual(first.messages, [
    '人格注入上限已按范围校正为 20000 字符（配置值 20001，允许 1000~20000）'
  ]);

  const second = createLegacyRuntimeConfig({ file: {} });
  assert.equal(second.roleInjectMaxChars, ROLE_INJECT_MAX_CHARS_DEFAULT);
  second.loadConfig();
  assert.equal(second.roleInjectMaxChars, ROLE_INJECT_MAX_CHARS_DEFAULT);
  assert.deepEqual(second.messages, []);
  // 第一次调用的状态不因第二次调用而改变。
  assert.equal(first.roleInjectMaxChars, 20000);
});
