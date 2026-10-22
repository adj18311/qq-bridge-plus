import test from 'node:test';
import assert from 'node:assert/strict';
import {busyHarness, feedFrames, frameOf, waitFor} from './busy-watchdog-harness.mjs';

const THIRD = '等一下，有点卡';
const FINAL = '请联系管理员修复';
const F529 = {code:'SERVER', message:'529 overloaded'};
let SEQ = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const F = (sid, type, data, seq) => frameOf(sid, {seq: seq === undefined ? ++SEQ : seq, type, data});
const RID = (turn) => (turn === 1 ? 'fixture-chain' : 'fixture-chain-' + turn);
const TURN = (sid, turn = 1) => F(sid, 'turn/start', {turn});
const STEP = (sid, turn = 1) => F(sid, 'step/start', {turn, step:1});
const RETRY = (sid, n, failure, turn = 1) => F(sid, 'llm/retry', {retryId:RID(turn), turn, step:1, retry:n, maxRetries:5, delayMs:500, mode:'normal', policyKey:'fixture', provider:'fixture', failure});
const STARTED = (sid, n, turn = 1) => F(sid, 'llm/retry-started', {retryId:RID(turn), turn, step:1, retry:n});
const END = (sid, failure, turn = 1) => F(sid, 'turn/end', {turn, reason:{kind:'error', error:failure}});

async function boot(mark = true) {
  const h = await busyHarness({config: {sendDelayMs: 0, socialV2: {proactive: {enabled: false}}}});
  h.setMode('reserved2');
  const key = 'private:123';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  if (mark) h.wakeConfigUpdatedKeys.add(key);
  const texts = () => h.calls.sent.map((x) => x.text).filter((t) => typeof t === 'string' && t.length > 0);
  return {h, key, sid, st, texts};
}

async function base(h, sid, failure, turn = 1) {
  await feedFrames(h, [TURN(sid, turn), STEP(sid, turn)]);
  for (let n = 1; n <= 3; n += 1) await feedFrames(h, [RETRY(sid, n, failure, turn), STARTED(sid, n, turn)]);
}

async function fourth(h, sid, failure, turn = 1) {
  await feedFrames(h, [RETRY(sid, 4, failure, turn), STARTED(sid, 4, turn)]);
  await waitFor(() => h.calls.sent.some((x) => x.text === THIRD));
}

test('主链: 1-3静默, 第4次卡顿提示, 第5次未结束不发final, 529结束提醒不重开模型回合', async () => {
  const {h, key, sid, st, texts} = await boot(false);
  try {
    h.pendingWakeKeys.add(key);
    const t0 = Date.now();
    st.lastAiReplyAt = t0;
    st.lastActionAt = t0;
    st.preSleepWaitSatisfiedAt = t0;
    await base(h, sid, F529);
    assert.equal(texts().length, 0, '前3次重试不应发提示');
    await fourth(h, sid, F529);
    assert.equal(texts().filter((t) => t === THIRD).length, 1);
    assert.ok(h.pendingWakeKeys.has(key), '提示发送不应消费待唤醒标记');
    assert.equal(st.lastAiReplyAt, t0);
    assert.equal(st.lastActionAt, t0);
    assert.equal(st.preSleepWaitSatisfiedAt, t0);
    assert.equal(h.calls.prompts.length, 0, '不应重发模型 prompt');
    await feedFrames(h, [RETRY(sid, 5, F529), STARTED(sid, 5)]);
    await sleep(150);
    assert.equal(texts().filter((t) => t === FINAL).length, 0, '第5次重试未结束不应发final');
    await feedFrames(h, [END(sid, F529)]);
    await waitFor(() => texts().some((t) => t === FINAL));
    assert.equal(texts().filter((t) => t === THIRD).length, 1);
    assert.equal(texts().filter((t) => t === FINAL).length, 1);
    assert.equal(h.calls.prompts.length, 0);
    assert.ok(!h.pendingWakeKeys.has(key), '结束后应清除待唤醒标记');
    const log = h.readLog();
    assert.match(log, /\[retry\]/);
    assert.match(log, /"retry":4/);
    assert.ok(!log.includes('Bearer'));
    assert.ok(!log.includes('fixture-secret'));
  } finally { await h.close(); }
});

test('503成功恢复: 仅第4次提示, completed后不发final', async () => {
  const {h, sid, texts} = await boot();
  try {
    const fail = {code:'SERVER', message:'503 service unavailable', status:503};
    await base(h, sid, fail);
    assert.equal(texts().length, 0);
    await fourth(h, sid, fail);
    assert.equal(texts().filter((t) => t === THIRD).length, 1);
    await feedFrames(h, [F(sid, 'assistant/message', {turn:1, step:1, message:{content:[]}})]);
    await sleep(250);
    assert.equal(texts().filter((t) => t === FINAL).length, 0, '恢复后不应发final');
    assert.equal(texts().filter((t) => t === THIRD).length, 1);
    assert.equal(h.calls.prompts.length, 0);
    assert.ok(!texts().some((t) => t.includes('503')));
  } finally { await h.close(); }
});

test('429/502/504/未知SERVER: 不发两条新文案且不泄露原始错误', async () => {
  const cases = [
    {status:429, message:'429 Too Many Requests'},
    {status:502, message:'502 Bad Gateway'},
    {status:504, message:'504 Gateway Timeout'},
    {message:'X-RAW-UNKNOWN-CANARY'}
  ];
  for (const c of cases) {
    const {h, sid, texts} = await boot();
    try {
      const fail = {code:'SERVER', message:c.message};
      if (c.status) fail.status = c.status;
      await base(h, sid, fail);
      await feedFrames(h, [RETRY(sid, 4, fail), STARTED(sid, 4)]);
      await feedFrames(h, [RETRY(sid, 5, fail), STARTED(sid, 5)]);
      await feedFrames(h, [END(sid, fail)]);
      await sleep(250);
      assert.equal(texts().filter((t) => t === THIRD).length, 0, c.message + ' 不应发卡顿提示');
      assert.equal(texts().filter((t) => t === FINAL).length, 0, c.message + ' 不应发final');
      for (const t of texts()) {
        assert.ok(!t.includes(c.message), '原始错误泄露: ' + t);
        assert.ok(!t.includes('X-RAW-UNKNOWN-CANARY'), '未知错误原文泄露: ' + t);
      }
    } finally { await h.close(); }
  }
});

test('同seq重放不重复提示, 仅重放retry/end不污染普通逻辑', async () => {
  const {h, sid, texts} = await boot();
  try {
    await base(h, sid, F529);
    const r4 = RETRY(sid, 4, F529);
    const s4 = STARTED(sid, 4);
    await feedFrames(h, [r4, s4]);
    await waitFor(() => texts().filter((t) => t === THIRD).length === 1);
    await feedFrames(h, [r4, s4]);
    await sleep(150);
    assert.equal(texts().filter((t) => t === THIRD).length, 1, '重复retry不应重复提示');
    await feedFrames(h, [RETRY(sid, 5, F529), STARTED(sid, 5)]);
    const end = END(sid, F529);
    await feedFrames(h, [end]);
    await waitFor(() => texts().filter((t) => t === FINAL).length === 1);
    await feedFrames(h, [end]);
    await sleep(150);
    assert.equal(texts().filter((t) => t === FINAL).length, 1, '重复end不应重复final');
    assert.equal(texts().filter((t) => t === THIRD).length, 1);
    assert.equal(h.calls.prompts.length, 0);
  } finally { await h.close(); }
});

test('snapshot回放历史不补发提示, 后续live正常', async () => {
  const {h, sid, texts} = await boot();
  try {
    const recs = [];
    const rec = (type, data) => recs.push({seq: ++SEQ, type, data});
    rec('turn/start', {turn:1});
    rec('step/start', {turn:1, step:1});
    for (let n = 1; n <= 5; n += 1) {
      rec('llm/retry', {retryId:'fixture-chain', turn:1, step:1, retry:n, maxRetries:5, delayMs:500, mode:'normal', policyKey:'fixture', provider:'fixture', failure:F529});
      rec('llm/retry-started', {retryId:'fixture-chain', turn:1, step:1, retry:n});
    }
    rec('turn/end', {turn:1, reason:{kind:'error', error:F529}});
    await feedFrames(h, [{type:'session/snapshot', sessionId:sid, snapshot:{records:recs, projections:{values:{}}}}]);
    await sleep(250);
    assert.equal(texts().filter((t) => t === THIRD).length, 0, 'snapshot历史不应补发提示');
    assert.equal(texts().filter((t) => t === FINAL).length, 0);
    assert.equal(h.calls.prompts.length, 0);
    await base(h, sid, F529, 2);
    await fourth(h, sid, F529, 2);
    assert.equal(texts().filter((t) => t === THIRD).length, 1);
    assert.equal(h.calls.prompts.length, 0);
  } finally { await h.close(); }
});

test('暂停/epoch变化取消待发提示', async () => {
  for (const how of ['epoch', 'paused']) {
    const {h, key, sid, texts} = await boot();
    try {
      await base(h, sid, F529);
      h.cfg.sendDelayMs = 600;
      void h.sendToQQ(key, 'fixture blocker');
      await feedFrames(h, [RETRY(sid, 4, F529), STARTED(sid, 4)]);
      if (how === 'epoch') h.resetEpoch(); else h.socialV2.paused = true;
      await sleep(1000);
      assert.equal(texts().filter((t) => t === THIRD).length, 0, how + ': 取消后不应再发卡顿提示');
      h.cfg.sendDelayMs = 0;
    } finally { await h.close(); }
  }
});

test('脱敏: 日志与QQ均不含fixture-secret/private-canary, 两条文案正常', async () => {
  const {h, sid, texts} = await boot();
  try {
    const rich = '529 ' + JSON.stringify({error:{type:'overloaded_error', message:'busy'}, headers:{Authorization:'Bearer fixture-secret'}, request:{messages:[{content:'private-canary'}]}});
    const fail = {code:'SERVER', message:rich};
    await base(h, sid, fail);
    await fourth(h, sid, fail);
    await feedFrames(h, [RETRY(sid, 5, fail), STARTED(sid, 5)]);
    await feedFrames(h, [END(sid, fail)]);
    await waitFor(() => texts().filter((t) => t === FINAL).length === 1);
    assert.equal(texts().filter((t) => t === THIRD).length, 1);
    const log = h.readLog();
    for (const secret of ['fixture-secret', 'private-canary', 'Bearer']) {
      assert.ok(!log.includes(secret), '日志泄露 ' + secret);
      assert.ok(!texts().some((t) => t.includes(secret)), 'QQ泄露 ' + secret);
    }
  } finally { await h.close(); }
});

test('third retry terminal error delivers the third notice without a duplicate legacy notice', async () => {
  const {h, sid, texts} = await boot(false);
  try {
    await base(h, sid, F529);
    await feedFrames(h, [END(sid, F529)]);
    await sleep(200);
    assert.deepEqual(texts(), [THIRD]);
    assert.equal(h.calls.prompts.length, 0);
  } finally { await h.close(); }
});

test('a sixth retry schedule proves fifth failure and sends final once without changing DSH policy', async () => {
  const {h, sid, texts} = await boot();
  try {
    await base(h, sid, F529);
    await fourth(h, sid, F529);
    await feedFrames(h, [RETRY(sid, 5, F529), STARTED(sid, 5), RETRY(sid, 6, F529), STARTED(sid, 6)]);
    await sleep(200);
    assert.deepEqual(texts(), [THIRD, FINAL]);
    await feedFrames(h, [END(sid, F529)]);
    await sleep(200);
    assert.deepEqual(texts(), [THIRD, FINAL]);
    assert.equal(h.calls.prompts.length, 0);
  } finally { await h.close(); }
});

test('cooldown suppresses a second failed chain without falling back to the legacy error notice', async () => {
  const {h, sid, texts} = await boot();
  try {
    await base(h, sid, F529);
    await fourth(h, sid, F529);
    await feedFrames(h, [RETRY(sid, 5, F529), STARTED(sid, 5), END(sid, F529)]);
    await waitFor(() => texts().length === 2);
    await base(h, sid, F529, 2);
    await feedFrames(h, [RETRY(sid, 4, F529, 2), STARTED(sid, 4, 2), RETRY(sid, 5, F529, 2), STARTED(sid, 5, 2), END(sid, F529, 2)]);
    await sleep(200);
    assert.deepEqual(texts(), [THIRD, FINAL]);
    assert.equal(h.calls.prompts.length, 0);
  } finally { await h.close(); }
});
