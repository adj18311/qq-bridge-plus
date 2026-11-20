// scripts/test-notice-p1-integration.mjs
//
// P1 最小修复的用户可见行为验收（node:test，独立脚本，自包含 fixtures）。
// 真实 src/bridge.js 在临时目录 + 假 DSH/假 QQ 上运行（busyHarness），不连真实 QQ/DSH、不读线上配置。
//
// 验收点：
//   1. 普通 429（含只有结构化 status=429、message 不含 429 的形态）在 QQ 侧只出现精确的
//      「请求过于频繁，请稍后再试」；既不出现旧「额度用完」，也不出现新「额度不足」。
//   2. 429 + insufficient_quota 仍走新额度文案「当前模型额度不足，请切换模型」。
//   3. 重试通知排队后 epoch / 暂停 / 静默 / 会话替换 / 新 turn 取消都不占 5 分钟冷却；
//      之后新的合法 3rd / 5th 立刻能发。
//   4. 初始静默回合不消耗观察器（通知门）冷却。
//   5. 冷却起点是真正的发送时刻（fakeDate）：排队 120s 后再发，仍按发送时刻起算 5 分钟。
//   6. 同 key + stage 并发不双发。
//   7. 发送调用 reject / unknown 仍占冷却；之后普通消息可发送。
//
// 实现约束：不改生产源码/入口。transformSource 只在内存副本里暴露内部句柄；globals 只在 VM 里注入
// FakeDate、受控 SnowLumaWebSocketClient（确定性 hold sendChain、注入发送失败）。
// 使用生产通知门；冷却时间用假时钟推进，不替换门控实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { busyHarness, feedFrames, frameOf, waitFor, sleep } from './busy-watchdog-harness.mjs';

const RATE_TEXT = '请求过于频繁，请稍后再试';
const QUOTA_TEXT = '当前模型额度不足，请切换模型';
const THIRD = '等一下，有点卡';
const FINAL = '请联系管理员修复';
const F529 = { code: 'SERVER', message: '529 overloaded', status: 529 };
const PROVIDER = 'fixture-p';
const MODEL = 'fixture-m';
const HOOK = '  bot.onPrivateMessage(async (event) => {';

let clock = Date.UTC(2026, 0, 1, 0, 0, 0);
class FakeDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(clock); else super(...args);
  }
  static now() { return clock; }
}
const resetClock = () => { clock = Date.UTC(2026, 0, 1, 0, 0, 0); };
const advance = (ms) => { clock += ms; };

let SEQ = 0;
const F = (sid, type, data) => frameOf(sid, { seq: ++SEQ, type, data });
const rid = (turn) => (turn === 1 ? 'fixture-chain' : `fixture-chain-${turn}`);
const openTurn = (sid, turn) => [
  F(sid, 'turn/start', { turn }),
  F(sid, 'step/start', { turn, step: 1 }),
  F(sid, 'model/selection', { turn, step: 1, provider: PROVIDER, model: MODEL, selection: { provider: PROVIDER, model: MODEL } }),
  F(sid, 'request/header', { header: { config: { provider: PROVIDER, model: MODEL } } }),
];
const retryFrame = (sid, retry, failure, turn) => F(sid, 'llm/retry', {
  retryId: rid(turn), turn, step: 1, retry, maxRetries: 5, delayMs: 500, mode: 'normal',
  policyKey: 'fixture', provider: 'fixture', failure,
});
const startedFrame = (sid, retry, turn) => F(sid, 'llm/retry-started', { retryId: rid(turn), turn, step: 1, retry });
const endError = (sid, failure, turn) => F(sid, 'turn/end', { turn, reason: { kind: 'error', error: failure } });
const endCompleted = (sid, turn) => F(sid, 'turn/end', { turn, reason: { kind: 'completed' } });

const rowsFor = (bot, id) => bot.sends.filter((row) => row.kind === 'private' && Number(row.id) === id);
const textsFor = (bot, id) => rowsFor(bot, id).map((row) => row.text);
const countText = (bot, id, text) => textsFor(bot, id).filter((value) => value === text).length;
const attemptsFor = (bot, id, text) => bot.attempts.filter((row) => row.kind === 'private' && Number(row.id) === id && row.text === text).length;

function createBot() {
  const bot = { sends: [], attempts: [], hold: null, failNext: 0, failError: null };
  bot.__send = async (kind, id, text) => {
    bot.attempts.push({ kind, id, text });
    if (bot.hold) { const held = bot.hold; bot.hold = null; await held.promise; }
    if (bot.failNext > 0) { bot.failNext -= 1; throw bot.failError ?? new Error('fixture send failure'); }
    bot.sends.push({ kind, id, text });
  };
  bot.holdNext = () => {
    let release = () => {};
    const promise = new Promise((resolve) => { release = resolve; });
    bot.hold = { promise, release };
    return release;
  };
  class ControlledBot {
    on() {} off() {}
    async request() { return { status: 'ok', retcode: 0, data: [] }; }
    async sendPrivateMessage(id, text) { return bot.__send('private', id, text); }
    async sendGroupMessage(id, text) { return bot.__send('group', id, text); }
  }
  return { bot, ControlledBot };
}

async function boot(keys, { timeoutMs } = {}) {
  resetClock();
  const { bot, ControlledBot } = createBot();
  const holder = { value: null };
  const h = await busyHarness({
    config: {
      sendDelayMs: 0,
      dsh: { provider: PROVIDER, model: MODEL },
      allow: { private: keys.map((key) => Number(key.split(':')[1])), groups: [456] },
      socialV2: { proactive: { enabled: false } },
    },
    globals: {
      Date: FakeDate,
      SnowLumaWebSocketClient: ControlledBot,
      __p1Holder: holder,
    },
    transformSource: (source) => {
      if (timeoutMs !== undefined) {
        assert.ok(source.includes('const SEND_TIMEOUT_MS = 15000;'));
        source = source.replace('const SEND_TIMEOUT_MS = 15000;', `const SEND_TIMEOUT_MS = ${timeoutMs};`);
      }
      // task-81：暴露 sendChain 尾句柄，让测试用「排空发送链」做确定性同步点，取代计时 sleep。
      // 只读句柄，不改生产行为；sendChain 声明在本仓唯一（bridge.js 10706 行附近）。
      if (!source.includes('globalThis.__p1Holder.chain = () => sendChain;')) {
        assert.ok(source.includes('let sendChain = Promise.resolve();'), 'sendChain 声明锚点缺失，无法暴露排空句柄');
        source = source.replace('let sendChain = Promise.resolve();',
          'let sendChain = Promise.resolve();\n  globalThis.__p1Holder.chain = () => sendChain;');
      }
      return source.replace(HOOK, `  globalThis.__p1Holder.value = { social, queueRetryNotice, retryNoticeGate, retryTurnStates };
${HOOK}`);
    },
  });
  h.setMode('reserved2');
  const sessions = new Map();
  for (const key of keys) {
    sessions.set(key, await h.ensureSession(key));
    h.wakeConfigUpdatedKeys.add(key);
  }
  assert.ok(holder.value, '内存 hook 未执行：拿不到桥接内部句柄');
  assert.equal(typeof holder.value.queueRetryNotice, 'function', '未暴露 queueRetryNotice');
  assert.equal(typeof holder.value.social?.silentTurns?.set, 'function', '未暴露 social.silentTurns');
  return { h, bot, sessions, internals: holder.value, holder };
}

async function retries(h, sid, upto, failure, turn, waitMs = 25) {
  for (let index = 1; index <= upto; index += 1) {
    await feedFrames(h, [retryFrame(sid, index, failure, turn), startedFrame(sid, index, turn)], waitMs);
  }
}

// task-81：确定性同步点 —— 等 sendChain **排空**（链尾稳定、无新任务入队），取代「睡固定毫秒再断言」。
// 为什么必须这样：`sleep(ms)` 只保证「至少过了 ms」，不保证发送链上排队的取消/补发任务已经执行；
// 全量串行负载下 80/120/150ms 不足时，断言就会在任务真正跑之前读取状态（单跑绿、全量红的根因）。
// 这里用 harness 暴露的只读句柄 `holder.chain()` 取链尾 Promise：await 它 = 已入队任务全部执行完。
async function drainSendChain(holder, why = '未说明') {
  const deadline = Date.now() + 5000;
  for (;;) {
    const chain = holder?.chain?.();
    assert.equal(typeof chain?.then, 'function', '拿不到 sendChain 排空句柄（transformSource 注入失败）');
    await chain;
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (holder.chain() === chain) return;
    if (Date.now() > deadline) throw new Error(`sendChain 在超时内未排空（${why}）`);
  }
}

async function replaceSession(h, key, oldSid) {
  h.retireSession(key);
  const next = await h.ensureSession(key);
  assert.notEqual(next, oldSid, '会话替换场景：retireSession 未产生新会话，请同步调整 retire 调用签名');
  return next;
}

test('普通 429：只发精确限流文案；status429 与 insufficient_quota 分流正确', async () => {
  const cases = [
    { id: 123, failure: { code: 'SERVER', message: '429 Too Many Requests', status: 429 }, expect: 'rate' },
    { id: 124, failure: { code: 'SERVER', message: 'fixture-status-only-message', status: 429 }, expect: 'rate' },
    { id: 125, failure: { code: 'SERVER', message: '429 Too Many Requests' }, expect: 'rate' },
    { id: 126, failure: { code: 'SERVER', message: 'insufficient_quota: quota exhausted', status: 429 }, expect: 'quota' },
    { id: 127, failure: { code: 'SERVER', message: JSON.stringify({ error: { status: 429, message: 'quota_limit reached' } }) }, expect: 'rate' },
    { id: 128, failure: { code: 'SERVER', message: '[429] Quota exceeded for Requests per minute' }, expect: 'rate' },
    { id: 129, failure: { code: 'SERVER', message: 'APIError: ' + JSON.stringify({ error: { status: 429, message: 'Quota exceeded for Requests per minute' } }) }, expect: 'rate' },
    { id: 130, failure: { code: 'SERVER', message: 'APIError: ' + JSON.stringify({ error: { status: 429, code: 'credit_balance_too_low' } }) }, expect: 'quota' },
    { id: 131, failure: { code: 'SERVER', message: '[Provider] ' + JSON.stringify({ error: { status: 429, message: 'Quota exceeded for Requests per minute' } }) }, expect: 'rate' },
  ];
  const { h, bot, sessions, holder } = await boot(cases.map((item) => `private:${item.id}`));
  try {
    for (const item of cases) {
      const key = `private:${item.id}`;
      const sid = sessions.get(key);
      await feedFrames(h, [...openTurn(sid, 1), endError(sid, item.failure, 1)], 30);
      if (item.expect === 'rate') {
        const sent = await waitFor(() => countText(bot, item.id, RATE_TEXT) === 1, 4000, 25);
        assert.ok(sent, `${key}: 应只发限流文案，实际 ${JSON.stringify(textsFor(bot, item.id))}`);
        const texts = textsFor(bot, item.id);
        assert.deepEqual(texts, [RATE_TEXT], `${key}: 普通 429 只应有这一条精确文案`);
        assert.ok(!texts.some((text) => text.includes('额度')), `${key}: 不得出现旧「额度用完」或新「额度不足」`);
        assert.equal(attemptsFor(bot, item.id, RATE_TEXT), 1);
      } else {
        const sent = await waitFor(() => countText(bot, item.id, QUOTA_TEXT) === 1, 4000, 25);
        assert.ok(sent, `${key}: 429 insufficient_quota 应保持新额度文案，实际 ${JSON.stringify(textsFor(bot, item.id))}`);
        await drainSendChain(holder, 'quota 只能有一条文案');
        const texts = textsFor(bot, item.id);
        assert.deepEqual(texts, [QUOTA_TEXT], `${key}: 只应有一条新额度文案`);
        assert.ok(!texts.some((text) => text.includes('请求过于频繁')), `${key}: 不得误判成限流`);
        assert.ok(!texts.some((text) => text.includes('额度用完')), `${key}: 不得出现旧文案`);
      }
    }
  } finally { await h.close(); }
});

test('排队后 epoch/暂停/静默/会话替换/新 turn 取消不占 5 分钟冷却，后续 3rd/5th 可发送', async () => {
  const scenarios = ['epoch', 'paused', 'silent', 'session', 'newTurn'];
  const keys = scenarios.map((_, index) => `private:${123 + index}`);
  const { h, bot, sessions, internals, holder } = await boot(keys);
  try {
    for (let index = 0; index < scenarios.length; index += 1) {
      const how = scenarios[index];
      const key = keys[index];
      const id = Number(key.split(':')[1]);
      let sid = sessions.get(key);
      let turn = 1;
      await feedFrames(h, openTurn(sid, turn), 25);
      await retries(h, sid, 3, F529, turn);
      const release = bot.holdNext();
      const blocker = `fixture blocker ${how}`;
      void h.sendToQQ(key, blocker);
      const blocked = await waitFor(() => bot.attempts.some((row) => row.text === blocker), 4000, 10);
      assert.ok(blocked, `${how}: 阻塞消息未进入发送`);
      await feedFrames(h, [retryFrame(sid, 4, F529, turn)], 40);
      if (how === 'epoch') h.resetEpoch();
      else if (how === 'paused') h.socialV2.paused = true;
      else if (how === 'silent') internals.social.silentTurns.set(sid, [{ id: 'fixture-silent', ts: clock }]);
      else if (how === 'newTurn') {
        turn += 1;
        await feedFrames(h, [F(sid, 'turn/start', { turn }), F(sid, 'step/start', { turn, step: 1 })], 25);
      } else if (how === 'session') {
        sid = await replaceSession(h, key, sid);
        sessions.set(key, sid);
      }
      release();
      await drainSendChain(holder, `${how}: 取消后发送链排空`);
      assert.equal(countText(bot, id, THIRD), 0, `${how}: 取消后不得发送第三提示，实际 ${JSON.stringify(textsFor(bot, id))}`);
      if (how === 'paused') h.socialV2.paused = false;
      if (how === 'silent') internals.social.silentTurns.delete(sid);
      if (how === 'session') {
        turn = 2;
      } else {
        await feedFrames(h, [endCompleted(sid, turn)], 25);
        turn += 1;
      }
      const curSid = sessions.get(key);
      await feedFrames(h, openTurn(curSid, turn), 25);
      await retries(h, curSid, 4, F529, turn);
      const thirdSent = await waitFor(() => countText(bot, id, THIRD) === 1, 4000, 25);
      assert.ok(thirdSent, `${how}: 取消不应占冷却，新合法 3rd 应可发送，实际 ${JSON.stringify(textsFor(bot, id))}`);
      await feedFrames(h, [retryFrame(curSid, 5, F529, turn), startedFrame(curSid, 5, turn), endError(curSid, F529, turn)], 40);
      const finalSent = await waitFor(() => countText(bot, id, FINAL) === 1, 4000, 25);
      assert.ok(finalSent, `${how}: 新合法 5th 应可发送，实际 ${JSON.stringify(textsFor(bot, id))}`);
    }
  } finally { await h.close(); }
});

test('初始静默回合不消耗观察器冷却，静默解除后合法 3rd 可发送', async () => {
  const { h, bot, sessions, internals, holder } = await boot(['private:123']);
  try {
    const key = 'private:123';
    const id = 123;
    const sid = sessions.get(key);
    internals.social.silentTurns.set(sid, [{ id: 'fixture-initial-silent', ts: clock }]);
    await feedFrames(h, openTurn(sid, 1), 25);
    await retries(h, sid, 4, F529, 1);
    await drainSendChain(holder, '初始静默回合不得发送第三提示');
    assert.equal(countText(bot, id, THIRD), 0, '初始静默回合不应发送第三提示');
    internals.social.silentTurns.delete(sid);
    await feedFrames(h, [endCompleted(sid, 1)], 25);
    await feedFrames(h, openTurn(sid, 2), 25);
    await retries(h, sid, 4, F529, 2);
    const sent = await waitFor(() => countText(bot, id, THIRD) === 1, 4000, 25);
    assert.ok(sent, `静默解除后合法 3rd 应可发送，实际 ${JSON.stringify(textsFor(bot, id))}`);
  } finally { await h.close(); }
});

test('第五次终态提示排队取消后，新故障仍能发送第五阶段文案', async () => {
  const { h, bot, sessions, internals, holder } = await boot(['private:123']);
  let release;
  try {
    const key = 'private:123', sid = sessions.get(key);
    await feedFrames(h, openTurn(sid, 1), 25);
    await retries(h, sid, 3, F529, 1);
    release = bot.holdNext();
    void h.sendToQQ(key, 'final-stage-blocker');
    assert.ok(await waitFor(() => bot.attempts.some(r => r.text === 'final-stage-blocker')));
    await feedFrames(h, [retryFrame(sid, 4, F529, 1), startedFrame(sid, 4, 1),
      retryFrame(sid, 5, F529, 1), startedFrame(sid, 5, 1), endError(sid, F529, 1)], 60);
    // task-81：先确定「第 5 次通知的入队判定已经发生」（turn/end 已被帧泵处理 ⇒ queueRetryNotice
    // 已同步把这个通知挂到 sendChain 上），再置代际；否则 resetEpoch 可能先于入队 —— 新代际入队的
    // 通知不会被取消，会真的发出 FINAL（全量偶发红灯的根因）。
    assert.ok(await waitFor(() => internals.retryTurnStates.get(sid)?.done === true, 4000, 10),
      'turn/end 未被处理：无法确定第 5 次通知已入队，取消时序不可判定');
    h.resetEpoch();
    release();
    await drainSendChain(holder, '取消后的 FINAL 不得发送');
    assert.equal(countText(bot, 123, FINAL), 0);
    await feedFrames(h, openTurn(sid, 2), 25);
    await retries(h, sid, 4, F529, 2);
    await feedFrames(h, [retryFrame(sid, 5, F529, 2), startedFrame(sid, 5, 2), endError(sid, F529, 2)], 60);
    assert.ok(await waitFor(() => countText(bot, 123, FINAL) === 1));
  } finally { release?.(); await h.close(); }
});

test('真实超时路径保留冷却且不补发，后续正式消息能继续', async () => {
  const { h, bot, sessions, internals, holder } = await boot(['private:123'], { timeoutMs: 40 });
  let release;
  try {
    const key = 'private:123', sid = sessions.get(key);
    await feedFrames(h, openTurn(sid, 1), 25);
    release = bot.holdNext();
    internals.queueRetryNotice(key, sid, { stage: 'third' });
    assert.ok(await waitFor(() => h.readLog().includes('操作超时(40ms)')));
    assert.equal(attemptsFor(bot, 123, THIRD), 1);
    internals.queueRetryNotice(key, sid, { stage: 'third' });
    await h.sendToQQ(key, 'formal-after-timeout');
    assert.equal(attemptsFor(bot, 123, THIRD), 1);
    assert.ok(textsFor(bot, 123).includes('formal-after-timeout'));
    release(); await drainSendChain(holder, '超时路径：取消后不得补发');
    assert.equal(countText(bot, 123, THIRD), 1, '底层晚到不触发桥接补发');
  } finally { release?.(); await h.close(); }
});

test('冷却起点是实际发送时刻（fakeDate），不是入队时刻', async () => {
  const { h, bot, sessions, holder } = await boot(['private:123']);
  try {
    const key = 'private:123';
    const id = 123;
    const sid = sessions.get(key);
    await feedFrames(h, openTurn(sid, 1), 25);
    await retries(h, sid, 3, F529, 1);
    const release = bot.holdNext();
    const blocker = 'fixture blocker cooldown';
    void h.sendToQQ(key, blocker);
    assert.ok(await waitFor(() => bot.attempts.some((row) => row.text === blocker), 4000, 10), '阻塞发送未进入 bot');
    await feedFrames(h, [retryFrame(sid, 4, F529, 1)], 40);
    advance(120000);
    release();
    assert.ok(await waitFor(() => countText(bot, id, THIRD) === 1, 4000, 25), '排队后应发送第三提示');
    const sentAt = clock;
    advance(299999);
    await feedFrames(h, [endCompleted(sid, 1)], 25);
    await feedFrames(h, openTurn(sid, 2), 25);
    await retries(h, sid, 4, F529, 2);
    await drainSendChain(holder, '299999ms 内仍应在冷却中');
    assert.equal(countText(bot, id, THIRD), 1, `发送时刻 ${sentAt} 后 299999ms 应仍在冷却内`);
    advance(1);
    await feedFrames(h, [endCompleted(sid, 2)], 25);
    await feedFrames(h, openTurn(sid, 3), 25);
    await retries(h, sid, 4, F529, 3);
    const sent = await waitFor(() => countText(bot, id, THIRD) === 2, 4000, 25);
    assert.ok(sent, '从实际发送时刻起算满 300000ms 应放行');
  } finally { await h.close(); }
});

test('并发同 key+stage 不双发；reject/unknown 仍占冷却；之后普通消息可发送', async () => {
  const { h, bot, sessions, internals, holder } = await boot(['private:123', 'private:124', 'private:125']);
  try {
    const q = internals.queueRetryNotice;
    const sid123 = sessions.get('private:123');
    await feedFrames(h, openTurn(sid123, 1), 25);
    q('private:123', sid123, { stage: 'third' });
    q('private:123', sid123, { stage: 'third' });
    assert.ok(await waitFor(() => attemptsFor(bot, 123, THIRD) === 1, 4000, 25), '并发 3rd 应只发起一次发送');
    await drainSendChain(holder, '并发 3rd 不得双发');
    assert.equal(attemptsFor(bot, 123, THIRD), 1, '并发同 key+stage 不得双发');
    assert.equal(countText(bot, 123, THIRD), 1);
    q('private:123', sid123, { stage: 'final' });
    q('private:123', sid123, { stage: 'final' });
    assert.ok(await waitFor(() => attemptsFor(bot, 123, FINAL) === 1, 4000, 25), '并发 final 应只发起一次发送');
    await drainSendChain(holder, '并发 final 不得双发');
    assert.equal(attemptsFor(bot, 123, FINAL), 1, 'final 同 key+stage 也不得双发');
    assert.equal(countText(bot, 123, FINAL), 1);
    const rejectCases = [
      { id: 124, error: new Error('fixture: send rejected') },
      { id: 125, error: Object.assign(new Error('fixture: send outcome unknown'), { unknown: true }) },
    ];
    for (const item of rejectCases) {
      const key = `private:${item.id}`;
      const sid = sessions.get(key);
      await feedFrames(h, openTurn(sid, 1), 25);
      bot.failNext = 1;
      bot.failError = item.error;
      q(key, sid, { stage: 'third' });
      assert.ok(await waitFor(() => attemptsFor(bot, item.id, THIRD) === 1, 4000, 25), `${key}: 应发起一次发送调用`);
      await drainSendChain(holder, `${key}: 失败调用排空`);
      assert.equal(countText(bot, item.id, THIRD), 0, `${key}: 失败调用不应产生 QQ 消息`);
      advance(299999);
      q(key, sid, { stage: 'third' });
      await drainSendChain(holder, `${key}: 299999ms 内仍占冷却`);
      assert.equal(attemptsFor(bot, item.id, THIRD), 1, `${key}: reject/unknown 后 299999ms 内仍应占冷却`);
      advance(1);
      q(key, sid, { stage: 'third' });
      assert.ok(await waitFor(() => countText(bot, item.id, THIRD) === 1, 4000, 25), `${key}: 满 300000ms 应允许再发`);
      assert.equal(attemptsFor(bot, item.id, THIRD), 2);
    }
    await h.sendToQQ('private:124', '普通消息');
    assert.ok(await waitFor(() => textsFor(bot, 124).includes('普通消息'), 4000, 25), '通知失败后普通消息仍应可发送');
  } finally { await h.close(); }
});
