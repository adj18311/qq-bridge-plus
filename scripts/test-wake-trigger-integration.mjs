#!/usr/bin/env node
// Real-bridge integration tests for the wake-trigger thin wrappers.
// Run in-process: node scripts/test-wake-trigger-integration.mjs
//
// Reuses scripts/audit-bridge-harness.mjs (the vm bridge harness) only: temporary files, fake peers,
// injected Math/timers, no QQ/DSH/network side effects. The bridge object must expose the real
// adapters; missing exposure is the expected RED state before the captain wires the wrappers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const EXPOSED = ['evaluateWakeTriggerV2', 'isDirectedAtAi', 'setSelfNickname'];

function fakeTimers() {
  const created = [];
  const setTimeoutFn = (fn, ms) => {
    const handle = { fn, ms, cleared: false, unref() {} };
    created.push(handle);
    return handle;
  };
  const clearTimeoutFn = (handle) => {
    if (handle && typeof handle === 'object') handle.cleared = true;
  };
  return {
    created,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    pending: () => created.filter((handle) => !handle.cleared),
  };
}

async function withBridge(run, { wake = {}, config = {}, mode = 'reserved2' } = {}) {
  const random = { count: 0, value: 0.5 };
  const fakeMath = Object.create(Math);
  fakeMath.random = () => { random.count += 1; return random.value; };
  const timers = fakeTimers();
  const h = await bridgeHarness({
    config: { socialV2: { enabled: true, wake }, ...config },
    globals: { Math: fakeMath, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
  });
  h.setMode(mode);
  if (mode === 'reserved2') h.socialV2.paused = false;
  const reset = () => { random.count = 0; timers.created.length = 0; };
  try {
    await run(h, random, reset, timers);
  } finally {
    await h.close();
  }
}

function api(h, name) {
  const fn = h[name];
  assert.equal(typeof fn, 'function', `bridge must expose ${name}`);
  return fn;
}

function triggers(overrides = {}) {
  return {
    atMention: false, nameMention: false, keywords: [], question: false,
    speakerIds: [], anyMessage: false, probability: 0, ...overrides,
  };
}

function groupEvent(text, id = 1, overrides = {}) {
  return {
    self_id: 999,
    group_id: 456,
    user_id: 456,
    message_id: id,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: 456, nickname: '群友' },
    ...overrides,
  };
}

test('bridge exposes wake-trigger adapters with the legacy 7-arg signature', () => withBridge((h) => {
  for (const name of EXPOSED) api(h, name);
  assert.equal(api(h, 'evaluateWakeTriggerV2').length, 7, 'unused key parameter retained');
}));

test('evaluateWakeTriggerV2 returns private before any late capability', () => withBridge((h, random, reset) => {
  const evaluate = api(h, 'evaluateWakeTriggerV2');
  const st = h.getSocialV2State('private:123');
  st.wakeConfig.triggers = triggers({ anyMessage: true, atMention: true, nameMention: true, keywords: ['ds'], question: true, speakerIds: ['123'], probability: 1 });
  reset();
  assert.equal(evaluate('private:123', st, { user_id: 123 }, 'private', 'x', 'x', false), 'private', 'private early return');
  assert.equal(random.count, 0, 'private consumes no random');
  assert.equal(evaluate('group:456', st, {}, 'private', '', '', true), 'private', 'first key argument stays unused');
}));

test('evaluateWakeTriggerV2 reads hot config, hot nickname, probability counts through the wrapper', () => withBridge((h, random, reset) => {
  const evaluate = api(h, 'evaluateWakeTriggerV2');
  const isDirected = api(h, 'isDirectedAtAi');
  const setNickname = api(h, 'setSelfNickname');
  const st = h.getSocialV2State('group:456');
  const event = groupEvent('', 1);
  const setTriggers = (value) => { st.wakeConfig.triggers = triggers(value); };

  setTriggers({ anyMessage: true, probability: 1 });
  reset();
  assert.equal(evaluate('group:456', st, event, 'group', '', '', false), 'anyMessage', 'anyMessage');
  assert.equal(random.count, 0, 'early anyMessage consumes no random');

  setTriggers({ atMention: true });
  assert.equal(evaluate('group:456', st, { ...event, message: [{ type: 'at', data: { qq: 999 } }] }, 'group', '', '', false), 'atMention', 'at segment');
  assert.equal(evaluate('group:456', st, event, 'group', '', '', true), 'atMention', 'quote target is self');

  setTriggers({ nameMention: true });
  setNickname('小鲸鱼');
  assert.equal(evaluate('group:456', st, event, 'group', '@小鲸鱼 hi', '', false), 'nameMention', 'hot nickname');
  setNickname('DeepSeek');
  assert.equal(evaluate('group:456', st, event, 'group', 'DEEPSEEK 在吗', '', false), 'nameMention', 'replaced nickname stays case-insensitive');
  setNickname('');
  assert.equal(evaluate('group:456', st, event, 'group', 'deepseek 在吗', '', false), null, 'empty nickname disables nameMention');

  setTriggers({ keywords: ['DS'] });
  assert.equal(evaluate('group:456', st, event, 'group', '', 'ds 你好', false), 'keyword:DS', 'original keyword label preserved');
  assert.equal(evaluate('group:456', st, event, 'group', '', 'ads', false), null, 'short keyword word boundary');

  setTriggers({ question: true });
  assert.equal(evaluate('group:456', st, event, 'group', '', '你说话啊', false), 'question', 'question via plain content');
  assert.equal(isDirected('你说话啊'), true, 'exposed predicate agrees');

  setTriggers({ question: true, speakerIds: ['456'] });
  assert.equal(evaluate('group:456', st, event, 'group', '', '你说话啊', false), 'question', 'question before speaker');
  setTriggers({ speakerIds: ['456'] });
  assert.equal(evaluate('group:456', st, event, 'group', '', '你好', false), 'speaker:群友', 'speaker nickname fallback');

  setTriggers({ probability: 0.5 });
  reset();
  random.value = 0.4;
  assert.equal(evaluate('group:456', st, event, 'group', '', '', false), 'probability', 'probability hit');
  assert.equal(random.count, 1, 'exactly one random draw');
  reset();
  random.value = 0.5;
  assert.equal(evaluate('group:456', st, event, 'group', '', '', false), null, 'random equality fails');
  assert.equal(random.count, 1, 'still exactly one draw on equality');
  setTriggers({ probability: 0 });
  reset();
  assert.equal(evaluate('group:456', st, event, 'group', '', '', false), null, 'zero probability');
  assert.equal(random.count, 0, 'no draw when probability is not positive');
}));

test('V1 direct-address consumers use the same predicate wrapper (handleIncoming)', () => withBridge(async (h, random, reset, timers) => {
  const setNickname = api(h, 'setSelfNickname');
  setNickname('deepseek');
  random.value = 0.5; // above legacy triggerProbability 0.15, so only the predicate can trigger
  let id = 1;

  reset();
  await h.handleIncoming('group', 456, groupEvent('你有claude一半强吗', id++), h.cfg);
  const scheduled = timers.pending().filter((handle) => handle.ms >= 2000 && handle.ms <= 8000);
  assert.equal(scheduled.length, 1, 'AI-directed group message enters active and schedules a reply');
  assert.equal(h.calls.prompts.length, 0, 'no immediate prompt');
  assert.equal(h.calls.sent.length, 0, 'no QQ send');

  reset();
  await h.handleIncoming('group', 789, groupEvent('今天天气不错', id++), h.cfg);
  assert.equal(timers.pending().length, 0, 'plain group message does not enter active');
  assert.equal(h.calls.prompts.length, 0, 'plain message never prompts');
  assert.equal(h.calls.sent.length, 0, 'plain message never sends');
}, { config: { allow: { private: ['123'], groups: ['456', '789'] } }, mode: 'reserved' }));

test('reserved2 handleIncoming schedules only matched reasons through the wrapper', () => withBridge(async (h, random, reset) => {
  const st = h.getSocialV2State('group:456');
  st.bootstrapSent = true;
  st.wakeConfig.triggers = triggers();
  let id = 1;

  reset();
  await h.handleIncoming('group', 456, groupEvent('hello', id++), h.cfg);
  assert.equal(st.pendingWakeReason ?? null, null, 'unmatched message schedules nothing');
  assert.equal(h.calls.prompts.length, 0, 'no prompt before the batch window');
  assert.equal(h.calls.sent.length, 0, 'no send before the batch window');
  assert.equal(random.count, 0, 'unmatched message draws no random');

  st.wakeConfig.triggers = triggers({ keywords: ['DS'] });
  await h.handleIncoming('group', 456, groupEvent('ds 你好', id++), h.cfg);
  assert.equal(st.pendingWakeReason, 'keyword:DS', 'keyword reason scheduled through the wrapper');
  assert.equal(st.pendingWakeSeq, null, 'group wakes carry no owner-letter seq');
  assert.equal(h.calls.prompts.length, 0, 'batch window still pending');
  assert.equal(h.calls.sent.length, 0, 'still no QQ send');
}));

test('reserved2 handleIncoming private path schedules the private reason without random', () => withBridge(async (h, random, reset) => {
  const st = h.getSocialV2State('private:123');
  st.bootstrapSent = true;
  st.wakeConfig.triggers = triggers({ probability: 1 });
  reset();
  await h.handleIncoming('private', 123, {
    self_id: 999, user_id: 123, message_id: 9,
    message: [{ type: 'text', data: { text: 'hi' } }], sender: { user_id: 123, nickname: '管理员' },
  }, h.cfg);
  assert.equal(st.pendingWakeReason, 'private', 'private reason scheduled');
  assert.equal(st.pendingWakeSeq, st.lastUnreadSeq, 'owner private wake carries the unread seq');
  assert.equal(random.count, 0, 'private path does not draw random');
  assert.equal(h.calls.sent.length, 0, 'no QQ send');
}));
