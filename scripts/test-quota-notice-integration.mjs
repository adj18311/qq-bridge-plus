// scripts/test-quota-notice-integration.mjs
//
// 「额度耗尽提醒」的真实 bridge VM 集成测试（node:test ESM）。
// 走真实 src/bridge.js（busyHarness 起临时目录 + 假 DSH / 假 QQ），只通过 DSH 帧与 QQ 侧可观测结果断言：
//   · 只有被证明的额度终结错误才发一条精确文案「当前模型额度不足，请切换模型」；
//   · 10 分钟冷却、每次事故最多 3 条、可信模型成功后开始新事故；
//   · 按 QQ 会话 + provider/model 分桶，跨会话隔离，模型切换不重置；
//   · snapshot / 工具成功 / 仅 completed 不误发、不复位；
//   · 排队发送期间暂停 / epoch / 模型切换取消，不占正式回复状态；
//   · 日志与持久化不含密钥 / 原始请求；通知不改读 / 活跃 / 回复 / 睡眠状态，不重发 prompt。
//
// 时钟：把 FakeDate 经 busyHarness 的 globals={Date:FakeDate} 注入 VM，测试只拨 clock，绝不真等 10 分钟。
// （globals 注入与 quota 模块 import 绑定由集成方在 busyHarness 中补齐，本文件按该约定使用。）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { busyHarness, feedFrames, frameOf, sleep, waitFor } from './busy-watchdog-harness.mjs';

const QUOTA_TEXT = '当前模型额度不足，请切换模型';
const QUOTA_STATE_PATH = path.join('state', 'quota-notices.json');
const PROVIDER = 'fixture-p';
const MODEL = 'fixture-m';
const DEFAULT_SELECTION = { provider: PROVIDER, model: MODEL };
const OTHER_SELECTION = { provider: 'fixture-p2', model: 'fixture-m2' };
const PRIVATE_KEY = 'private:123';
const GROUP_KEY = 'group:456';
const RAW_SECRET = 'fixture-secret';
const RAW_CANARY = 'private-canary';

let clock = Date.now();
class FakeDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(clock);
    else super(...args);
  }
  static now() { return clock; }
}
const advance = (ms) => { clock += ms; };

let SEQ = 0;
const nextSequence = () => { SEQ += 1; return SEQ; };

// 被证明的额度耗尽 fixture：不用被点名的 {code:'INSUFFICIENT_QUOTA'} 与 403，
// 走明确的 depletion 文案（英文 / 中文各一），避免结构化 code 大小写与 403 优先级歧义。
const quotaFailure = (extra = {}) => ({
  code: 'SERVER',
  message: 'insufficient_quota: quota exhausted; credit balance is too low',
  request: {
    headers: { authorization: `Bearer ${RAW_SECRET}` },
    messages: [{ role: 'user', content: RAW_CANARY }],
  },
  ...extra,
});
const QUOTA_FAILURE_ZH = { code: 'SERVER', message: '模型额度不足，请充值后重试（quota exhausted）' };
const RATE_LIMIT_429 = { code: 'SERVER', message: '429 Too Many Requests', status: 429 };
const BUSY_529 = { code: 'SERVER', message: '529 overloaded', status: 529 };

async function boot(keys = [PRIVATE_KEY], { markWakeConfig = true } = {}) {
  clock = Date.now();
  const h = await busyHarness({
    config: {
      dsh: { provider: PROVIDER, model: MODEL },
      sendDelayMs: 0,
      socialV2: { proactive: { enabled: false } },
    },
    globals: { Date: FakeDate },
  });
  h.setMode('reserved2');
  const sessions = new Map();
  for (const key of keys) {
    sessions.set(key, await h.ensureSession(key));
    if (markWakeConfig) h.wakeConfigUpdatedKeys.add(key);
  }
  const sends = () => h.calls.sent.filter((entry) => typeof entry.text === 'string' && entry.text.length > 0);
  const texts = () => sends().map((entry) => entry.text);
  const quotaSends = () => sends().filter((entry) => entry.text === QUOTA_TEXT);
  return { h, sessions, sends, texts, quotaSends };
}

const stateFilePath = (ctx) => path.join(ctx.h.temp, QUOTA_STATE_PATH);

function framesFor(sid) {
  return (type, data) => frameOf(sid, { seq: nextSequence(), type, data });
}

function openTurn(sid, turn, selection = DEFAULT_SELECTION) {
  const f = framesFor(sid);
  return [
    f('turn/start', { turn }),
    f('step/start', { turn, step: 1 }),
    f('model/selection', {
      turn, step: 1, provider: selection.provider, model: selection.model, selection: { ...selection },
    }),
    f('request/header', { header: { config: { provider: selection.provider, model: selection.model } } }),
  ];
}

function quotaEnd(sid, turn, failure = quotaFailure()) {
  return framesFor(sid)('turn/end', { turn, reason: { kind: 'error', error: failure } });
}

function switchSelection(ctx, selection) {
  ctx.h.cfg.dsh.provider = selection.provider;
  ctx.h.cfg.dsh.model = selection.model;
}

async function wakeQuotaTurn(ctx, key, turn, { selection = DEFAULT_SELECTION, failure = quotaFailure() } = {}) {
  switchSelection(ctx, selection);
  const sid = ctx.sessions.get(key);
  ctx.h.wakeConfigUpdatedKeys.add(key);
  ctx.h.pendingWakeKeys.add(key);
  await feedFrames(ctx.h, [...openTurn(sid, turn, selection), quotaEnd(sid, turn, failure)]);
}

async function settle() { await sleep(300); }

// 1) 首个被证明的额度终结错误：只发精确一句，日志有 [quota] 且不含原始凭据/请求，状态不被通知改动。
test('终结额度错误：只发精确一句、不改状态、不重发模型、日志脱敏', async () => {
  const ctx = await boot();
  try {
    const { h, sessions, quotaSends, texts } = ctx;
    const key = PRIVATE_KEY;
    const sid = sessions.get(key);
    const st = h.getSocialV2State(key);
    st.lastAiReplyAt = 111222333;
    st.lastActionAt = 111222444;
    st.preSleepWaitSatisfiedAt = 111222555;
    st.readThroughSeq = 7;
    st.wakeConfig.infinite = false;
    st.wakeConfig.sleepUntil = new FakeDate(clock + 3600000).toISOString();
    st.wakeConfig.confirmedBy = 'fixture-explicit';
    st.wakeConfig.noActionCount = 2;
    if (st.wakeConfig && typeof st.wakeConfig === 'object') st.wakeConfig.fixtureMarker = 'fixture-wake';
    const wakeConfigBefore = JSON.parse(JSON.stringify(st.wakeConfig ?? null));
    h.pendingWakeKeys.add(key);
    await feedFrames(h, [...openTurn(sid, 1), quotaEnd(sid, 1)]);
    await waitFor(() => quotaSends().length === 1, 3000);
    assert.equal(quotaSends().length, 1, '首个额度终结错误应立刻提醒一次');
    assert.equal(quotaSends()[0].kind, 'private');
    assert.equal(quotaSends()[0].id, 123);
    assert.equal(quotaSends()[0].text, QUOTA_TEXT);
    assert.deepEqual(texts(), [QUOTA_TEXT], '不得出现其它 QQ 文本（含旧错误提示）');
    assert.equal(h.pendingWakeKeys.has(key), false, '终结错误后 pendingWakeKeys 正常释放');
    assert.equal(h.calls.prompts.length, 0, '通知不得重发模型 prompt');
    assert.equal(st.lastAiReplyAt, 111222333, '不得修改回复状态');
    assert.equal(st.lastActionAt, 111222444, '不得修改活跃状态');
    assert.equal(st.preSleepWaitSatisfiedAt, 111222555, '不得修改睡眠状态');
    assert.equal(st.readThroughSeq, 7, '不得修改已读水位');
    assert.deepEqual(JSON.parse(JSON.stringify(st.wakeConfig ?? null)), wakeConfigBefore, '不得修改唤醒配置');
    const log = h.readLog();
    assert.ok(log.includes('[quota'), '日志需有 [quota] 标签');
    for (const secret of [RAW_SECRET, RAW_CANARY, 'Bearer', 'authorization']) {
      assert.ok(!log.includes(secret), '日志泄露 ' + secret);
    }
  } finally { await ctx.h.close(); }
});

// 2) 同会话：10 分钟冷却、边界可再发、每次事故最多 3 条、封顶后不退回旧错误文案。
test('同一会话冷却 10 分钟、边界再发、最多 3 条、不退回旧错误文案', async () => {
  const ctx = await boot();
  try {
    const { h, quotaSends, texts } = ctx;
    const key = PRIVATE_KEY;
    await wakeQuotaTurn(ctx, key, 1);
    await waitFor(() => quotaSends().length === 1, 3000);
    advance(599999);
    await wakeQuotaTurn(ctx, key, 2);
    await settle();
    assert.equal(quotaSends().length, 1, '10 分钟内连续错误应冷却');
    advance(1);
    await wakeQuotaTurn(ctx, key, 3);
    await waitFor(() => quotaSends().length === 2, 3000);
    assert.equal(quotaSends().length, 2, '恰好 600000ms 时应允许下一条');
    advance(600000);
    await wakeQuotaTurn(ctx, key, 4);
    await waitFor(() => quotaSends().length === 3, 3000);
    assert.equal(quotaSends().length, 3);
    advance(600000);
    await wakeQuotaTurn(ctx, key, 5);
    await settle();
    assert.equal(quotaSends().length, 3, '每次事故最多 3 条');
    assert.deepEqual(texts(), [QUOTA_TEXT, QUOTA_TEXT, QUOTA_TEXT], '封顶后不得退回旧错误提示');
    const payload = JSON.parse(fs.readFileSync(stateFilePath(ctx), 'utf8'));
    assert.equal(payload.entries.length, 1);
    assert.equal(payload.entries[0].count, 3);
    assert.equal(h.calls.prompts.length, 0);
  } finally { await ctx.h.close(); }
});

// 3) 不同群 / 私聊隔离，各发各的目的地；A 的冷却不受 B 提醒影响。
test('不同 QQ 会话隔离：私聊与群各自独立提醒并投递到对应目的', async () => {
  const ctx = await boot([PRIVATE_KEY, GROUP_KEY]);
  try {
    const { sends, quotaSends } = ctx;
    await wakeQuotaTurn(ctx, PRIVATE_KEY, 1);
    await wakeQuotaTurn(ctx, GROUP_KEY, 1, { failure: QUOTA_FAILURE_ZH });
    await waitFor(() => quotaSends().length === 2, 3000);
    const rows = sends();
    assert.equal(rows.length, 2, '两个会话都应收到自己的额度提醒');
    const privateRow = rows.find((entry) => entry.kind === 'private');
    const groupRow = rows.find((entry) => entry.kind === 'group');
    assert.ok(privateRow, '应有私聊提醒');
    assert.ok(groupRow, '应有群提醒');
    assert.equal(privateRow.id, 123);
    assert.equal(groupRow.id, 456);
    assert.equal(privateRow.text, QUOTA_TEXT);
    assert.equal(groupRow.text, QUOTA_TEXT);
    await wakeQuotaTurn(ctx, PRIVATE_KEY, 2);
    await settle();
    assert.equal(quotaSends().filter((entry) => entry.kind === 'private').length, 1, 'A 会话冷却不受 B 会话提醒影响');
    assert.equal(ctx.h.calls.prompts.length, 0);
  } finally { await ctx.h.close(); }
});

// 4) 普通 429 / 529 不满足额度判定：不发精确文案，也不占用额度计数。
test('普通 429/529 不发额度文案、不占额度计数', async () => {
  const ctx = await boot();
  try {
    const { h, quotaSends, texts } = ctx;
    await wakeQuotaTurn(ctx, PRIVATE_KEY, 1, { failure: RATE_LIMIT_429 });
    await settle();
    await wakeQuotaTurn(ctx, PRIVATE_KEY, 2, { failure: BUSY_529 });
    await settle();
    assert.equal(quotaSends().length, 0, '普通限流/忙不得发额度提醒');
    assert.ok(!texts().includes(QUOTA_TEXT));
    const file = stateFilePath(ctx);
    const payload = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { entries: [] };
    assert.equal(payload.entries.length, 0, '非额度错误不得占用额度计数');
    assert.equal(h.calls.prompts.length, 0);
  } finally { await ctx.h.close(); }
});

// 5) snapshot 回放历史：不补发、也不复位冷却/计数。
test('snapshot 回放历史：不补发额度提醒，也不复位冷却/计数', async () => {
  const ctx = await boot();
  try {
    const { h, sessions, quotaSends, texts } = ctx;
    const key = PRIVATE_KEY;
    const sid = sessions.get(key);
    await wakeQuotaTurn(ctx, key, 1);
    await waitFor(() => quotaSends().length === 1, 3000);
    const records = [];
    const rec = (type, data) => records.push({ seq: nextSequence(), type, data });
    rec('turn/start', { turn: 91 });
    rec('step/start', { turn: 91, step: 1 });
    rec('model/selection', { turn: 91, step: 1, provider: PROVIDER, model: MODEL, selection: { ...DEFAULT_SELECTION } });
    rec('assistant/message', { turn: 91, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '历史成功回复' }] } });
    rec('turn/end', { turn: 91, reason: { kind: 'completed' } });
    rec('turn/start', { turn: 92 });
    rec('turn/end', { turn: 92, reason: { kind: 'error', error: quotaFailure() } });
    await feedFrames(h, [{ type: 'session/snapshot', sessionId: sid, snapshot: { records, projections: { values: {} } } }]);
    await settle();
    assert.equal(quotaSends().length, 1, 'snapshot 历史不得补发额度提醒');
    assert.ok(!texts().includes('历史成功回复'), 'snapshot 历史不得产生 QQ 文本');
    await wakeQuotaTurn(ctx, key, 2);
    await settle();
    assert.equal(quotaSends().length, 1, 'snapshot 不得复位冷却/计数');
    advance(600000);
    await wakeQuotaTurn(ctx, key, 3);
    await waitFor(() => quotaSends().length === 2, 3000);
    assert.equal(quotaSends().length, 2, '冷却到边界后仍按新事故继续计数');
  } finally { await ctx.h.close(); }
});

// 6) sendToQQ 阻塞后，排队中的额度提醒被暂停 / epoch 取消，且不占正式回复状态。
test('sendToQQ 阻塞时排队提醒：暂停/epoch 取消且不占正式回复状态', async () => {
  for (const how of ['epoch', 'paused']) {
    const ctx = await boot();
    try {
      const { h, sessions } = ctx;
      const key = PRIVATE_KEY;
      const sid = sessions.get(key);
      const st = h.getSocialV2State(key);
      st.lastAiReplyAt = 5000;
      st.lastActionAt = 5001;
      st.preSleepWaitSatisfiedAt = 5002;
      h.cfg.sendDelayMs = 600;
      void h.sendToQQ(key, 'fixture blocker');
      await wakeQuotaTurn(ctx, key, 1);
      if (how === 'epoch') h.resetEpoch();
      else h.socialV2.paused = true;
      await sleep(900);
      assert.equal(ctx.quotaSends().length, 0, how + ': 取消后不得再发额度提醒');
      assert.equal(st.lastAiReplyAt, 5000, how + ': 不得占用正式回复状态');
      assert.equal(st.lastActionAt, 5001);
      assert.equal(st.preSleepWaitSatisfiedAt, 5002);
      h.cfg.sendDelayMs = 0;
      if (how === 'paused') h.socialV2.paused = false;
      if (how === 'epoch') sessions.set(key, await h.ensureSession(key));
      await wakeQuotaTurn(ctx, key, 2);
      await waitFor(() => ctx.quotaSends().length === 1, 3000);
      assert.equal(ctx.quotaSends().length, 1, how + ': 取消回滚后仍可提醒');
      assert.equal(h.calls.prompts.length, 0);
      if (how === 'paused') assert.equal(sid, sessions.get(key));
    } finally { await ctx.h.close(); }
  }
});

// 7) 模型切换取消旧排队提醒；切回不重置已用次数/冷却。
test('模型切换：排队中的旧模型提醒取消；切回不重置次数', async () => {
  const a = await boot();
  try {
    const { h, sessions, quotaSends } = a;
    const key = PRIVATE_KEY;
    const sid = sessions.get(key);
    h.cfg.sendDelayMs = 600;
    void h.sendToQQ(key, 'fixture blocker');
    await wakeQuotaTurn(a, key, 1);
    switchSelection(a, OTHER_SELECTION);
    const f = framesFor(sid);
    await feedFrames(h, [f('model/selection', {
      turn: 1, step: 1, provider: OTHER_SELECTION.provider, model: OTHER_SELECTION.model, selection: { ...OTHER_SELECTION },
    })], 150);
    await sleep(800);
    assert.equal(quotaSends().length, 0, '切换模型后旧模型的排队提醒必须取消');
    h.cfg.sendDelayMs = 0;
    await wakeQuotaTurn(a, key, 2, { selection: OTHER_SELECTION });
    await waitFor(() => quotaSends().length === 1, 3000);
    assert.equal(quotaSends().length, 1, '新模型额度耗尽应可提醒');
  } finally { await a.h.close(); }

  const b = await boot();
  try {
    const { quotaSends } = b;
    const key = PRIVATE_KEY;
    await wakeQuotaTurn(b, key, 1);
    await waitFor(() => quotaSends().length === 1, 3000);
    advance(600000);
    await wakeQuotaTurn(b, key, 2);
    await waitFor(() => quotaSends().length === 2, 3000);
    advance(600000);
    await wakeQuotaTurn(b, key, 3);
    await waitFor(() => quotaSends().length === 3, 3000);
    await wakeQuotaTurn(b, key, 4, { selection: OTHER_SELECTION });
    await waitFor(() => quotaSends().length === 4, 3000);
    assert.equal(quotaSends().length, 4, '切换后的模型是独立限制桶');
    switchSelection(b, DEFAULT_SELECTION);
    advance(600000);
    await wakeQuotaTurn(b, key, 5);
    await settle();
    assert.equal(quotaSends().length, 4, '切回旧模型不得重置已用次数/冷却');
  } finally { await b.h.close(); }
});

// 8) 持久化：state/quota-notices.json 只存 hash/count/time，不含 key/model/原始错误。
test('持久化 state/quota-notices.json 只存哈希/次数/时间，不含密钥或原始错误', async () => {
  const ctx = await boot();
  try {
    const { h } = ctx;
    await wakeQuotaTurn(ctx, PRIVATE_KEY, 1);
    await waitFor(() => ctx.quotaSends().length === 1, 3000);
    const file = stateFilePath(ctx);
    assert.ok(fs.existsSync(file), '应存在 state/quota-notices.json');
    const raw = fs.readFileSync(file, 'utf8');
    const payload = JSON.parse(raw);
    assert.equal(payload.version, 1);
    assert.ok(Array.isArray(payload.entries));
    assert.equal(payload.entries.length, 1);
    const entry = payload.entries[0];
    assert.deepEqual(Object.keys(entry).sort(), ['count', 'id', 'lastAt'], '条目只允许 id/count/lastAt');
    assert.equal(entry.id.length, 64, 'id 应为 SHA256 十六进制');
    assert.ok(/^[0-9a-f]{64}$/.test(entry.id));
    assert.equal(entry.count, 1);
    assert.equal(entry.lastAt, clock);
    for (const secret of [PRIVATE_KEY, PROVIDER, MODEL, RAW_SECRET, RAW_CANARY, 'Bearer', 'insufficient_quota', 'credit balance']) {
      assert.ok(!raw.includes(secret), '持久化泄露 ' + secret);
    }
  } finally { await ctx.h.close(); }
});

// 9) 工具成功 / 仅 completed 不复位事故；可信 assistant/message 成功后新额度可再提醒。
test('工具成功/completed-only 不能复位事故；可信 assistant/message 成功后不再冷却', async () => {
  const ctx = await boot();
  try {
    const { h, sessions, quotaSends, texts } = ctx;
    const key = PRIVATE_KEY;
    const sid = sessions.get(key);
    await wakeQuotaTurn(ctx, key, 1);
    await waitFor(() => quotaSends().length === 1, 3000);
    const f = framesFor(sid);
    h.pendingWakeKeys.add(key);
    await feedFrames(h, [
      f('turn/start', { turn: 2 }),
      f('step/start', { turn: 2, step: 1 }),
      f('model/selection', { turn: 2, step: 1, provider: PROVIDER, model: MODEL, selection: { ...DEFAULT_SELECTION } }),
      f('tool/end', { turn: 2, step: 1, tool: 'fixture-tool', status: 'success' }),
      f('turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ]);
    advance(100000);
    await wakeQuotaTurn(ctx, key, 3);
    await settle();
    assert.equal(quotaSends().length, 1, '工具成功/仅 completed 不得复位额度事故');
    h.pendingWakeKeys.add(key);
    await feedFrames(h, [
      f('turn/start', { turn: 4 }),
      f('step/start', { turn: 4, step: 1 }),
      f('model/selection', { turn: 4, step: 1, provider: PROVIDER, model: MODEL, selection: { ...DEFAULT_SELECTION } }),
      f('assistant/message', { turn: 4, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '' }] } }),
      f('turn/end', { turn: 4, reason: { kind: 'completed' } }),
    ]);
    await wakeQuotaTurn(ctx, key, 5);
    await waitFor(() => quotaSends().length === 2, 3000);
    assert.equal(quotaSends().length, 2, '可信模型成功后应可再次提醒');
    assert.ok(texts().every((text) => text === QUOTA_TEXT), '不得产生正式回复或旧错误文案');
  } finally { await ctx.h.close(); }
});

// 10) 未标记 wakeConfig 的会话：额度提醒不触发旧提醒逻辑，pendingWakeKeys 正常释放。
test('未标记唤醒配置的会话：额度提醒不触发提醒逻辑', async () => {
  const ctx = await boot([PRIVATE_KEY], { markWakeConfig: false });
  try {
    const { h, sessions, quotaSends, texts } = ctx;
    const key = PRIVATE_KEY;
    const sid = sessions.get(key);
    const st = h.getSocialV2State(key);
    st.lastAiReplyAt = 7001;
    st.lastActionAt = 7002;
    st.preSleepWaitSatisfiedAt = 7003;
    h.pendingWakeKeys.add(key);
    await feedFrames(h, [...openTurn(sid, 1), quotaEnd(sid, 1)]);
    await waitFor(() => quotaSends().length === 1, 3000);
    assert.deepEqual(texts(), [QUOTA_TEXT], '额度提醒本身不得触发提醒/其它文案');
    assert.equal(h.pendingWakeKeys.has(key), false, '终结错误后 pendingWakeKeys 正常释放');
    assert.equal(st.lastAiReplyAt, 7001);
    assert.equal(st.lastActionAt, 7002);
    assert.equal(st.preSleepWaitSatisfiedAt, 7003);
    assert.equal(h.calls.prompts.length, 0);
  } finally { await ctx.h.close(); }
});
