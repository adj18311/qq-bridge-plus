#!/usr/bin/env node
// RED-first differential tests for the wake-trigger extraction.
// Run in-process: node scripts/test-wake-trigger.mjs
//
// Expected values come ONLY from scripts/fixtures/legacy-wake-trigger.mjs, a frozen mechanical
// transcription of the current dirty src/bridge.js:11130-11144 / 12255-12290. This file never
// derives expectations from src/core/wake-policy.mjs and never reads .agent-teams state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as legacy from './fixtures/legacy-wake-trigger.mjs';

const TARGET_LABEL = '../src/core/wake-policy.mjs';
const FIXTURE_URL = new URL('./fixtures/legacy-wake-trigger.mjs', import.meta.url);

let target = null;
let loadFailure = null;
try {
  target = await import(new URL(TARGET_LABEL, import.meta.url).href);
} catch (error) {
  loadFailure = error;
}

function requireExport(name) {
  if (loadFailure) {
    const code = String(loadFailure?.code ?? '');
    const message = String(loadFailure?.message ?? loadFailure);
    throw new Error(`MISSING_FEATURE: ${TARGET_LABEL} not importable (${code || message})`);
  }
  const candidate = target?.[name];
  assert.equal(typeof candidate, 'function', `CONTRACT: export ${name} must be a function`);
  return candidate;
}

function describeError(error) {
  return { name: String(error?.name ?? 'Error'), message: String(error?.message ?? error) };
}

function captureThrow(body) {
  try {
    return { value: body(), error: null };
  } catch (error) {
    return { value: undefined, error: describeError(error) };
  }
}

// Complete ordered property tracer: every get is logged with its path (duplicates and nesting
// included, arrays/functions proxied so `.some`, `length`, indices and iteration are observable).
function traced(value, log, path) {
  if (value === null || value === undefined) return value;
  const kind = typeof value;
  if (kind !== 'object' && kind !== 'function') return value;
  return new Proxy(value, {
    get(object, key, receiver) {
      log.push(`${path}.${String(key)}`);
      return traced(Reflect.get(object, key, receiver), log, `${path}.${String(key)}`);
    },
  });
}

// Fresh plain-object input per side, descriptors preserved so accessors stay lazy.
function freshValue(value) {
  if (Array.isArray(value)) return value.map(freshValue);
  if (!value || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const copy = Object.create(proto);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) descriptor.value = freshValue(descriptor.value);
    Object.defineProperty(copy, key, descriptor);
  }
  return copy;
}

function guarded(kind, keys) {
  const object = {};
  for (const key of keys) {
    Object.defineProperty(object, key, {
      enumerable: true,
      get() { throw new Error(`${kind} must not be read`); },
    });
  }
  return object;
}

// Fresh world per side. Specs may use factories `(ctx) => value` for stateful inputs; nickname and
// random are surfaced as lazy capabilities so the production code and the oracle never share state.
function makeWorld(input, log) {
  const nick = {
    value: input.nickname,
    sequence: input.nicknameSequence ? [...input.nicknameSequence] : null,
  };
  const ctx = { nick, log };
  const materialize = (value) => (typeof value === 'function' ? value(ctx) : value);
  let randomIndex = 0;
  const caps = {
    getNickname() {
      log.push('cap.getNickname()');
      if (nick.sequence) {
        const step = nick.sequence.shift();
        if (step instanceof Error) throw step;
        if (typeof step === 'function') return step(ctx);
        return step;
      }
      return nick.value;
    },
    random() {
      log.push('cap.random()');
      const value = (input.randomValues ?? [])[randomIndex++];
      if (value instanceof Error) throw value;
      if (typeof value === 'function') return value(ctx);
      return value;
    },
  };
  if (input.forbidNickname) caps.getNickname = () => { log.push('cap.getNickname()'); throw new Error('nickname must not run'); };
  if (input.forbidRandom) caps.random = () => { log.push('cap.random()'); throw new Error('random must not run'); };
  return {
    st: traced(freshValue(materialize(input.st)), log, 'st'),
    event: traced(freshValue(materialize(input.event)), log, 'event'),
    kind: materialize(input.kind),
    textContent: traced(freshValue(materialize(input.textContent)), log, 'text'),
    plainContent: traced(freshValue(materialize(input.plainContent)), log, 'plain'),
    quoteTargetIsSelf: materialize(input.quoteTargetIsSelf),
    caps,
  };
}

function runEval(impl, input) {
  const log = [];
  const world = makeWorld(input, log);
  const outcome = captureThrow(() => impl(
    world.st, world.event, world.kind, world.textContent,
    world.plainContent, world.quoteTargetIsSelf, world.caps,
  ));
  return { ...outcome, log };
}

function compareEval(label, input, expected) {
  const fn = requireExport('evaluateWakeTrigger');
  const oracle = runEval(legacy.legacyEvaluateWakeTrigger, input);
  const actual = runEval(fn, input);
  assert.deepEqual(actual.error, oracle.error, `${label}: thrown error`);
  assert.deepEqual(actual.value, oracle.value, `${label}: result`);
  assert.deepEqual(actual.log, oracle.log, `${label}: complete ordered property/capability trace`);
  if (expected !== undefined) {
    assert.equal(oracle.error, null, `${label}: oracle must not throw`);
    assert.equal(oracle.value, expected, `${label}: oracle expected reason`);
    assert.equal(actual.error, null, `${label}: production must not throw`);
    assert.equal(actual.value, expected, `${label}: production expected reason`);
  }
  return { actual, oracle };
}

const OFF_TRIGGERS = Object.freeze({
  atMention: false, nameMention: false, keywords: [], question: false,
  speakerIds: [], anyMessage: false, probability: 0,
});

function state(triggers = {}, extra = {}) {
  return { wakeConfig: { triggers: { ...OFF_TRIGGERS, ...triggers } }, ...extra };
}

function spec(overrides = {}) {
  return {
    st: state(),
    event: { message: [], self_id: '999', user_id: 123, sender: { user_id: 123, nickname: '群友' } },
    kind: 'group',
    textContent: '普通消息',
    plainContent: '普通消息',
    quoteTargetIsSelf: false,
    nickname: 'deepseek',
    ...overrides,
  };
}

function withTriggers(triggers, overrides = {}) {
  return spec({ st: state(triggers), ...overrides });
}

// ── Frozen oracle self-checks (must already pass while the module exports are missing) ─────────
test('[ref] frozen fixture provenance and literal behaviors', () => {
  assert(Object.isFrozen(legacy.LEGACY_PROVENANCE), 'provenance is frozen');
  assert.equal(legacy.LEGACY_PROVENANCE.file, 'src/bridge.js', 'provenance file');
  assert.equal(legacy.LEGACY_PROVENANCE.isDirectedAtAiLines, '11130-11144', 'predicate lines');
  assert.equal(legacy.LEGACY_PROVENANCE.evaluateWakeTriggerV2Lines, '12255-12290', 'evaluator lines');
  assert.match(legacy.LEGACY_PROVENANCE.bridgeSha256, /^C14FC28A[0-9A-F]{56}$/, 'baseline hash');

  assert.equal(legacy.legacyIsDirectedAtAi('ds'), false, 'bare ds is an AI mention without a question/challenge');
  assert.equal(legacy.legacyIsDirectedAtAi('ds 怎么样'), true, 'ds with a question is directed');
  assert.equal(legacy.legacyIsDirectedAtAi('ADS'), false, 'ADS is not a whole-word ds');
  assert.equal(legacy.legacyIsDirectedAtAi('BDSM'), false, 'BDSM is not a whole-word ds');
  assert.equal(legacy.legacyIsDirectedAtAi('你有claude一半强吗'), true, 'direct challenge');
  assert.equal(legacy.legacyIsDirectedAtAi('今天天气不错'), false, 'plain chat is not directed');

  const forbidden = () => { throw new Error('capability must not run'); };
  assert.equal(legacy.legacyEvaluateWakeTrigger(null, null, 'private', null, null, false,
    { getNickname: forbidden, random: forbidden }), 'private', 'private bypasses everything');

  const tr = (extra) => ({ wakeConfig: { triggers: { ...OFF_TRIGGERS, ...extra } } });
  const event = { message: [], self_id: '999', user_id: 123, sender: {} };
  const caps = () => ({ getNickname: () => 'deepseek', random: () => 0.5 });
  assert.equal(legacy.legacyEvaluateWakeTrigger(tr({ anyMessage: true }), event, 'group', '', '', false, caps()), 'anyMessage', 'anyMessage wins');
  assert.equal(legacy.legacyEvaluateWakeTrigger(tr({ keywords: ['ds'] }), event, 'group', 'ds', 'ads', false, caps()), null, 'keyword uses plainContent');
  assert.equal(legacy.legacyEvaluateWakeTrigger(tr({ keywords: ['ds'] }), event, 'group', 'ads', 'ds', false, caps()), 'keyword:ds', 'keyword uses plainContent hit');
  assert.equal(legacy.legacyEvaluateWakeTrigger(tr({ probability: 0.5 }), event, 'group', '', '', false, caps()), null, 'probability equality fails');
});

// ── isDirectedAtAi differential ───────────────────────────────────────────────────────────────
const DIRECTED_CASES = [
  ['empty', ''],
  ['plain chat', '今天天气不错'],
  ['ds', 'ds'],
  ['DS uppercase', 'DS'],
  ['ADS negative', 'ADS'],
  ['BDSM negative', 'BDSM'],
  ['DSL negative', 'DSL'],
  ['ds before CJK', 'ds群'],
  ['ai mention only', 'ai'],
  ['ai plus challenge', 'ai 太菜了'],
  ['deepseek question', 'deepseek 好用吗'],
  ['GPT comparison', 'GPT 比它强吗'],
  ['robot question', '机器人会不会赢'],
  ['direct you challenge', '你真厉害'],
  ['you comparison', '你比它强'],
  ['you question suffix', '你行不行'],
  ['you are either', '你是人类还是ai'],
  ['you are question', '你是真人吗'],
  ['you prefix question', '你是不是机器人'],
  ['question mark only', '？'],
  ['question word only', '为什么'],
  ['urging', '你说话啊'],
  ['urging short', '在不在'],
  ['urging substring', '我在不在线'],
  ['symbol input', Symbol('ds')],
  ['number input', 123],
  ['boolean input', false],
  ['null input', null],
  ['undefined input', undefined],
  ['array input', ['ds']],
  ['object input', { toString: () => 'ds 好吗' }],
  ['object thrown conversion', { toString() { throw new Error('text boom'); } }],
];

test('[contract] isDirectedAtAi differential table', () => {
  const fn = requireExport('isDirectedAtAi');
  for (const [label, input] of DIRECTED_CASES) {
    const oracle = captureThrow(() => legacy.legacyIsDirectedAtAi(input));
    const actual = captureThrow(() => fn(input));
    assert.deepEqual(actual.error, oracle.error, `${label}: thrown error`);
    assert.equal(typeof actual.value, typeof oracle.value, `${label}: result type`);
    assert.equal(actual.value, oracle.value, `${label}: result`);
  }
});

test('[contract] isDirectedAtAi explicit baseline reasons', () => {
  const fn = requireExport('isDirectedAtAi');
  const truthy = ['ds 怎么样', 'DS 怎么样', 'deepseek 好用吗', '机器人会不会赢', '你说话啊', '你是真人吗', '你比它强', '在不在', '我在不在线', 'ai 太菜了'];
  const falsy = ['', 'ds', '今天天气不错', 'ADS', 'BDSM', 'DSL', '？', '为什么', 'ai'];
  for (const text of truthy) assert.equal(fn(text), true, `isDirectedAtAi(${JSON.stringify(text)})`);
  for (const text of falsy) assert.equal(fn(text), false, `isDirectedAtAi(${JSON.stringify(text)})`);
});

// ── evaluateWakeTrigger differential table: every branch isolated, early matches disabled ─────
const EVAL_CASES = [
  // private
  ['private null world', spec({ st: null, event: null, kind: 'private', textContent: null, plainContent: null, forbidNickname: true, forbidRandom: true }), 'private'],
  ['private ignores forbidden capabilities', spec({
    st: guarded('state', ['wakeConfig']),
    event: guarded('event', ['message', 'self_id', 'user_id', 'sender']),
    kind: 'private',
    textContent: { toString() { throw new Error('text must not be read'); } },
    plainContent: { toString() { throw new Error('plain must not be read'); } },
    forbidNickname: true,
    forbidRandom: true,
  }), 'private'],
  // anyMessage
  ['anyMessage true', withTriggers({ anyMessage: true, probability: 1 }, { forbidRandom: true }), 'anyMessage'],
  ['anyMessage truthy string', withTriggers({ anyMessage: 'yes' }), 'anyMessage'],
  ['anyMessage zero falls through', withTriggers({ anyMessage: 0 }), null],
  // atMention / quote
  ['at mention matching self', withTriggers({ atMention: true }, { event: { message: [{ type: 'at', data: { qq: '999' } }], self_id: '999', user_id: 123, sender: {} } }), 'atMention'],
  ['at mention number ids', withTriggers({ atMention: true }, { event: { message: [{ type: 'at', data: { qq: 999 } }], self_id: 999, user_id: 123, sender: {} } }), 'atMention'],
  ['at mention early stop', withTriggers({ atMention: true }, { event: { message: [{ type: 'at', data: { qq: '999' } }, { type: 'at', data: { qq: '123' } }], self_id: '999', user_id: 123, sender: {} } }), 'atMention'],
  ['at mention other qq', withTriggers({ atMention: true }, { event: { message: [{ type: 'at', data: { qq: '123' } }], self_id: '999', user_id: 123, sender: {} } }), null],
  ['quote target is self', withTriggers({ atMention: true }, { event: { message: [], self_id: '999', user_id: 123, sender: {} }, quoteTargetIsSelf: true }), 'atMention'],
  ['atMention disabled skips message', withTriggers({ atMention: false }, { event: guarded('event', ['message']) }), null],
  ['at seg missing qq and self', withTriggers({ atMention: true }, { event: { message: [{ type: 'at', data: {} }], user_id: 123, sender: {} } }), null],
  // nameMention
  ['name at prefix', withTriggers({ nameMention: true }, { textContent: '@deepseek hi', nickname: 'DeepSeek' }), 'nameMention'],
  ['name case insensitive bare', withTriggers({ nameMention: true }, { textContent: 'DEEPSEEK 在吗', nickname: 'deepseek' }), 'nameMention'],
  ['name empty nickname', withTriggers({ nameMention: true }, { nickname: '' }), null],
  ['name zero nickname', withTriggers({ nameMention: true }, { nickname: 0 }), null],
  ['name text conversion mutates nickname', withTriggers({ nameMention: true }, {
    nickname: 'Alpha',
    textContent: (ctx) => ({
      toString() { ctx.log.push('text.toString'); ctx.nick.value = 'Beta'; return 'hello beta'; },
    }),
  }), 'nameMention'],
  ['name second read throws', withTriggers({ nameMention: true }, { nicknameSequence: ['alpha', new Error('nickname boom')], textContent: 'hello world' })],
  ['name third read throws', withTriggers({ nameMention: true }, { nicknameSequence: ['alpha', 'zzz', new Error('third read boom')], textContent: 'hello world' })],
  ['name guard read throws', withTriggers({ nameMention: true }, { nicknameSequence: [new Error('guard boom')] })],
  // keywords
  ['keyword hit', withTriggers({ keywords: ['ds'] }, { textContent: 'hello', plainContent: '我要 ds 推荐' }), 'keyword:ds'],
  ['keyword preserves label case', withTriggers({ keywords: ['DS'] }, { plainContent: 'ds 你好' }), 'keyword:DS'],
  ['keyword boundary ads', withTriggers({ keywords: ['ds'] }, { plainContent: 'ads' }), null],
  ['keyword boundary bdsm', withTriggers({ keywords: ['ds'] }, { plainContent: 'bdsm' }), null],
  ['keyword boundary dsl', withTriggers({ keywords: ['ds'] }, { plainContent: 'dsl' }), null],
  ['keyword boundary before CJK', withTriggers({ keywords: ['ds'] }, { plainContent: 'ds群' }), 'keyword:ds'],
  ['keyword boundary punctuation', withTriggers({ keywords: ['ds'] }, { plainContent: '看 DS。' }), 'keyword:ds'],
  ['keyword long substring', withTriggers({ keywords: ['hello'] }, { plainContent: 'xhello' }), 'keyword:hello'],
  ['keyword length4 boundary', withTriggers({ keywords: ['test'] }, { plainContent: 'xtest' }), null],
  ['keyword length4 boundary hit', withTriggers({ keywords: ['test'] }, { plainContent: 'test!' }), 'keyword:test'],
  ['keyword numeric boundary', withTriggers({ keywords: ['r1'] }, { plainContent: 'R1' }), 'keyword:r1'],
  ['keyword numeric boundary miss', withTriggers({ keywords: ['r1'] }, { plainContent: 'r1x' }), null],
  ['keyword non-string label', withTriggers({ keywords: [7] }, { plainContent: '7' }), 'keyword:7'],
  ['keyword empty then hit', withTriggers({ keywords: ['', 'ok'] }, { plainContent: 'ok' }), 'keyword:ok'],
  ['keyword null skipped', withTriggers({ keywords: [null] }, { plainContent: 'null' }), null],
  ['keyword uses plain not text', withTriggers({ keywords: ['ds'] }, { textContent: 'ds', plainContent: 'hello' }), null],
  ['keyword plain hit with text miss', withTriggers({ keywords: ['ds'] }, { textContent: 'hello', plainContent: 'ds' }), 'keyword:ds'],
  ['keyword non-array', withTriggers({ keywords: 'ds' }, { plainContent: 'ds' }), null],
  // question
  ['question directed plain', withTriggers({ question: true }, { textContent: '无关', plainContent: '你说话啊' }), 'question'],
  ['question uses plain not text', withTriggers({ question: true }, { textContent: '你说话啊', plainContent: '无关' }), null],
  ['question missing plain', withTriggers({ question: true }, { textContent: '你说话啊', plainContent: null }), null],
  // speaker
  ['speaker card label', withTriggers({ speakerIds: ['123'] }, { event: { message: [], self_id: '999', user_id: 123, sender: { user_id: 123, card: '卡片', nickname: '群友' } } }), 'speaker:卡片'],
  ['speaker nickname fallback', withTriggers({ speakerIds: [123] }, { event: { message: [], self_id: '999', user_id: 123, sender: { user_id: 123, nickname: '群友' } } }), 'speaker:群友'],
  ['speaker sender id fallback', withTriggers({ speakerIds: ['456'] }, { event: { message: [], self_id: '999', sender: { user_id: 456 } } }), 'speaker:456'],
  ['speaker id label fallback', withTriggers({ speakerIds: ['123'] }, { event: { message: [], self_id: '999', user_id: 123, sender: { card: '', nickname: '' } } }), 'speaker:123'],
  ['speaker numeric label', withTriggers({ speakerIds: ['123'] }, { event: { message: [], self_id: '999', user_id: 123, sender: { card: 7, nickname: '群友' } } }), 'speaker:7'],
  ['speaker nullish card uses nickname', withTriggers({ speakerIds: ['123'] }, { event: { message: [], self_id: '999', user_id: 123, sender: { card: null, nickname: '群友' } } }), 'speaker:群友'],
  ['speaker missing ids', withTriggers({ speakerIds: ['123'] }, { event: { message: [], self_id: '999', sender: {} } }), null],
  ['speaker non-array', withTriggers({ speakerIds: '123' }), null],
  ['speaker no match', withTriggers({ speakerIds: ['456'] }), null],
  // probability
  ['probability hit', withTriggers({ probability: 0.5 }, { randomValues: [0.4] }), 'probability'],
  ['probability random zero', withTriggers({ probability: 0.5 }, { randomValues: [0] }), 'probability'],
  ['probability random NaN', withTriggers({ probability: 0.5 }, { randomValues: [NaN] }), null],
  ['probability random Infinity', withTriggers({ probability: 0.5 }, { randomValues: [Infinity] }), null],
  ['probability equality fails', withTriggers({ probability: 0.5 }, { randomValues: [0.5] }), null],
  ['probability string', withTriggers({ probability: '0.5' }, { randomValues: [0] }), 'probability'],
  ['probability above one no clamp', withTriggers({ probability: 2 }, { randomValues: [0.999] }), 'probability'],
  ['probability one', withTriggers({ probability: 1 }, { randomValues: [0.999999] }), 'probability'],
  ['probability zero', withTriggers({ probability: 0 }, { forbidRandom: true }), null],
  ['probability negative', withTriggers({ probability: -1 }, { forbidRandom: true }), null],
  ['probability NaN', withTriggers({ probability: NaN }, { forbidRandom: true }), null],
  ['probability Infinity', withTriggers({ probability: Infinity }, { randomValues: [0.5] }), 'probability'],
  ['probability negative Infinity', withTriggers({ probability: -Infinity }, { forbidRandom: true }), null],
  ['probability random throws', withTriggers({ probability: 0.5 }, { randomValues: [new Error('random boom')] })],
  ['probability valueOf throws', withTriggers({ probability: { valueOf() { throw new Error('valueOf boom'); } } }, { forbidRandom: true })],
  // config shapes / null results
  ['all off null', spec(), null],
  ['null state throws', spec({ st: null }), undefined],
  ['undefined state throws', spec({ st: undefined }), undefined],
  ['null wakeConfig', spec({ st: { wakeConfig: null } }), null],
  ['undefined wakeConfig', spec({ st: { wakeConfig: undefined } }), null],
  ['null triggers', spec({ st: { wakeConfig: { triggers: null } } }), null],
  ['false triggers', spec({ st: { wakeConfig: { triggers: false } } }), null],
  ['undefined event', withTriggers({ atMention: true, speakerIds: ['123'] }, { event: undefined }), null],
  ['non-array message', withTriggers({ atMention: true }, { event: { message: 'x', self_id: '999' } }), null],
];

test('[contract] evaluateWakeTrigger differential table', () => {
  for (const [label, input, expected] of EVAL_CASES) compareEval(label, input, expected);
});

// ── Complete ordered traces: duplicates, nesting, capability timing ─────────────────────────
test('[trace] private path performs no reads and no capability calls', () => {
  const fn = requireExport('evaluateWakeTrigger');
  const input = spec({
    st: guarded('state', ['wakeConfig']),
    event: guarded('event', ['message', 'self_id', 'user_id', 'sender']),
    kind: 'private',
    textContent: { toString() { throw new Error('text must not be read'); } },
    plainContent: { toString() { throw new Error('plain must not be read'); } },
    forbidNickname: true,
    forbidRandom: true,
  });
  const { actual } = compareEval('private trace', input, 'private');
  assert.deepEqual(actual.log, [], 'private logs no property or capability reads');
});

test('[trace] nickname getter positions and repeated reads', () => {
  const inputAt = withTriggers({ nameMention: true }, { textContent: '@deepseek hi', nickname: 'deepseek' });
  const atRun = compareEval('name at prefix trace', inputAt, 'nameMention').actual;
  assert.equal(atRun.log.filter((entry) => entry === 'cap.getNickname()').length, 2, 'at-prefix consumes guard + first match');
  const firstNick = atRun.log.indexOf('cap.getNickname()');
  const nameSwitch = atRun.log.indexOf('st.wakeConfig.triggers.nameMention');
  const firstTextRead = atRun.log.findIndex((entry) => entry.startsWith('text.'));
  assert.equal(nameSwitch !== -1 && nameSwitch < firstNick, true, 'nickname guard happens after the nameMention switch');
  if (firstTextRead !== -1) assert.equal(firstNick < firstTextRead, true, 'guard happens before text conversion');

  const bare = withTriggers({ nameMention: true }, { textContent: 'deepseek 在吗', nickname: 'deepseek' });
  const bareRun = compareEval('name bare trace', bare, 'nameMention').actual;
  assert.equal(bareRun.log.filter((entry) => entry === 'cap.getNickname()').length, 3, 'bare name consumes guard + both match reads');

  const empty = withTriggers({ nameMention: true }, { nickname: '' });
  const emptyRun = compareEval('name falsy trace', empty, null).actual;
  assert.equal(emptyRun.log.filter((entry) => entry === 'cap.getNickname()').length, 1, 'falsy nickname only reads the guard');
});

test('[trace] text conversion mutates nickname before the matching reads', () => {
  const input = withTriggers({ nameMention: true }, {
    nickname: 'Alpha',
    textContent: (ctx) => ({
      toString() { ctx.log.push('text.toString'); ctx.nick.value = 'Beta'; return 'hello beta'; },
    }),
  });
  const { actual } = compareEval('coercion mutates nickname', input, 'nameMention');
  const conversion = actual.log.indexOf('text.toString');
  const nicknameReads = actual.log.flatMap((entry, index) => (entry === 'cap.getNickname()' ? [index] : []));
  assert.equal(nicknameReads.length, 3, 'guard plus both matching reads');
  assert.equal(nicknameReads[0] < conversion, true, 'guard happens before conversion');
  assert.equal(conversion < nicknameReads[1], true, 'matching reads happen after conversion');
});

test('[trace] keyword and speaker collections are re-read at each original position', () => {
  const keyword = withTriggers({ keywords: ['a', 'b'] }, { plainContent: 'b' });
  const keywordRun = compareEval('keyword reads', keyword, 'keyword:b').actual;
  assert.equal(keywordRun.log.filter((entry) => entry === 'st.wakeConfig.triggers.keywords').length, 3, 'Array.isArray + length + iteration');

  const speaker = withTriggers({ speakerIds: ['123'] }, { event: { message: [], self_id: '999', user_id: 123, sender: { nickname: '群友' } } });
  const speakerRun = compareEval('speaker reads', speaker, 'speaker:群友').actual;
  assert.equal(speakerRun.log.filter((entry) => entry === 'st.wakeConfig.triggers.speakerIds').length, 3, 'Array.isArray + length + some');
});

test('[trace] probability double conversion surrounds exactly one random draw', () => {
  const hit = compareEval('probability trace', withTriggers({ probability: 0.5 }, { randomValues: [0.4] }), 'probability').actual;
  assert.equal(hit.log.filter((entry) => entry === 'st.wakeConfig.triggers.probability').length, 2, 'two probability property reads');
  assert.equal(hit.log.filter((entry) => entry === 'cap.random()').length, 1, 'one random draw');
  const firstRead = hit.log.indexOf('st.wakeConfig.triggers.probability');
  const draw = hit.log.indexOf('cap.random()');
  const secondRead = hit.log.lastIndexOf('st.wakeConfig.triggers.probability');
  assert.equal(firstRead < draw && draw < secondRead, true, 'draw sits between the two conversions');

  const zero = compareEval('probability zero trace', withTriggers({ probability: 0 }, { forbidRandom: true }), null).actual;
  assert.equal(zero.log.filter((entry) => entry === 'st.wakeConfig.triggers.probability').length, 1, 'zero probability short-circuits before the second read');
  assert.equal(zero.log.includes('cap.random()'), false, 'zero probability draws nothing');

  const changing = withTriggers({ probability: 0.5 }, { randomValues: [0.2] });
  changing.st = () => {
    let reads = 0;
    const triggers = { ...OFF_TRIGGERS };
    Object.defineProperty(triggers, 'probability', {
      enumerable: true,
      get() { reads += 1; return reads === 1 ? 0.5 : NaN; },
    });
    return { wakeConfig: { triggers } };
  };
  const changingRun = compareEval('probability changing second read', changing, null).actual;
  assert.equal(changingRun.log.filter((entry) => entry === 'st.wakeConfig.triggers.probability').length, 2, 'second read still happens');
  assert.equal(changingRun.log.filter((entry) => entry === 'cap.random()').length, 1, 'draw happened before the failing second conversion');
});

test('[trace] early matches skip every later property and capability', () => {
  const input = withTriggers({ anyMessage: true, probability: 1 }, {
    event: guarded('event', ['message', 'self_id', 'user_id', 'sender']),
    forbidRandom: true,
  });
  const { actual } = compareEval('anyMessage short-circuit', input, 'anyMessage');
  assert.equal(actual.log.includes('cap.random()'), false, 'no random draw');
  assert.equal(actual.log.includes('st.wakeConfig.triggers.probability'), false, 'no probability read');
  assert.equal(actual.log.includes('cap.getNickname()'), false, 'no nickname read');
});

test('[trace] question is evaluated before speaker', () => {
  const input = withTriggers(
    { question: true, speakerIds: ['123'] },
    { plainContent: '你说话啊', event: { message: [], self_id: '999', user_id: 123, sender: { card: '卡片' } } },
  );
  const { actual } = compareEval('question before speaker', input, 'question');
  assert.equal(actual.log.includes('st.wakeConfig.triggers.speakerIds'), false, 'speaker block not reached');
  assert.equal(actual.log.includes('event.user_id'), false, 'speaker id not read');
});

test('[trace] no-trigger path reads the full ordered field set', () => {
  const input = withTriggers({});
  const { actual } = compareEval('no trigger trace', input, null);
  assert.deepEqual(actual.log.slice(0, 4), [
    'st.wakeConfig', 'st.wakeConfig.triggers', 'st.wakeConfig.triggers.anyMessage', 'st.wakeConfig.triggers.atMention',
  ], 'trigger reads start with anyMessage then atMention');
  assert.equal(actual.log.includes('st.wakeConfig.triggers.question'), true, 'question read even when false');
  assert.equal(actual.log.includes('st.wakeConfig.triggers.probability'), true, 'probability read even when zero');
});

// ── Error parity with custom errors (messages do not depend on expression spelling) ───────────
test('[contract] evaluateWakeTrigger exception parity', () => {
  compareEval('throwing nickname guard', withTriggers({ nameMention: true }, { nicknameSequence: [new Error('nickname guard')] }));
  compareEval('throwing random', withTriggers({ probability: 0.5 }, { randomValues: [new Error('random boom')] }));
  compareEval('throwing keyword coercion', withTriggers({ keywords: [{ toString() { throw new Error('keyword boom'); } }] }, { plainContent: 'x' }));
  compareEval('throwing plain conversion', withTriggers({ keywords: ['x'] }, { plainContent: { toString() { throw new Error('plain boom'); } } }));
  compareEval('throwing text conversion', withTriggers({ nameMention: true }, { textContent: { toString() { throw new Error('text boom'); } } }));
  compareEval('throwing wakeConfig getter', spec({ st: { get wakeConfig() { throw new Error('config boom'); } } }));
});

test('[contract] nickname non-string still throws a TypeError like the baseline', () => {
  const fn = requireExport('evaluateWakeTrigger');
  const input = withTriggers({ nameMention: true }, { nickname: 123, textContent: 'hello' });
  const oracle = runEval(legacy.legacyEvaluateWakeTrigger, input);
  const actual = runEval(fn, input);
  assert.equal(oracle.error?.name, 'TypeError', 'baseline throws on non-string nickname');
  assert.equal(actual.error?.name, oracle.error?.name, 'production keeps the same error kind');
});

// ── Precedence collisions ─────────────────────────────────────────────────────────────────────
test('[contract] trigger precedence: anyMessage>at>name>keyword>question>speaker>probability', () => {
  const event = { message: [{ type: 'at', data: { qq: '999' } }], self_id: '999', user_id: 123, sender: { card: '卡片', nickname: '群友' } };
  const all = {
    atMention: true, nameMention: true, keywords: ['ds'], question: true,
    speakerIds: ['123'], anyMessage: true, probability: 1,
  };
  const allInput = (triggers) => withTriggers(triggers, {
    event,
    textContent: '@deepseek 你说话啊',
    plainContent: 'ds 你说话啊',
    quoteTargetIsSelf: true,
    randomValues: [0.1],
  });
  compareEval('all triggers', allInput(all), 'anyMessage');
  compareEval('at over name', allInput({ ...all, anyMessage: false }), 'atMention');
  compareEval('name over keyword', allInput({ ...all, anyMessage: false, atMention: false, quoteTargetIsSelf: false }), 'nameMention');
  compareEval('keyword over question', allInput({ ...all, anyMessage: false, atMention: false, nameMention: false, quoteTargetIsSelf: false }), 'keyword:ds');
  compareEval('question over speaker', withTriggers(
    { question: true, speakerIds: ['123'] },
    { event, plainContent: '你说话啊' },
  ), 'question');
  compareEval('speaker over probability', withTriggers({ speakerIds: ['123'], probability: 1 }, { event, randomValues: [0.1] }), 'speaker:卡片');
  compareEval('probability last', withTriggers({ probability: 1 }, { randomValues: [0.1] }), 'probability');
});

// ── Small seeded differential matrix (values, errors and full traces) ────────────────────────
test('[contract] seeded differential matrix', () => {
  let seed = 0x5eed1234;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const pick = (list) => list[Math.floor(next() * list.length)];
  const texts = ['你好', 'DS 在吗', '今天天气不错', '你有claude一半强吗', 'ads', '在不在', ''];
  const nicknames = ['deepseek', 'DeepSeek', '', '小鲸鱼'];
  for (let index = 0; index < 40; index += 1) {
    const triggers = {
      atMention: next() < 0.5,
      nameMention: next() < 0.5,
      keywords: next() < 0.5 ? [pick(['ds', 'hello', '小鲸鱼'])] : [],
      question: next() < 0.5,
      speakerIds: next() < 0.5 ? ['123'] : [],
      anyMessage: next() < 0.25,
      probability: pick([0, 0.5, 1, '0.3', NaN]),
    };
    const event = {
      message: next() < 0.5 ? [{ type: 'at', data: { qq: pick(['999', '123']) } }] : [],
      self_id: '999',
      user_id: pick([123, 456]),
      sender: { user_id: 123, nickname: '群友', card: next() < 0.5 ? '卡片' : '' },
    };
    compareEval(`seeded #${index}`, spec({
      st: state(triggers),
      event,
      kind: pick(['group', 'group', 'private']),
      textContent: pick(texts),
      plainContent: pick(texts),
      quoteTargetIsSelf: next() < 0.5,
      nickname: pick(nicknames),
      randomValues: [next()],
    }));
  }
});

// ── In-memory mutants: prove this harness rejects semantic drift (never written to src) ──────
function replaceOnce(source, from, to, label) {
  const first = source.indexOf(from);
  assert.notEqual(first, -1, `${label}: mutant anchor must exist in the frozen fixture`);
  assert.equal(source.indexOf(from, first + 1), -1, `${label}: mutant anchor must be unique`);
  return source.slice(0, first) + to + source.slice(first + from.length);
}

const MUTANTS = [
  {
    label: 'eager nickname snapshot before text conversion',
    transform: (source) => replaceOnce(source,
      "    const lower = String(textContent ?? '').toLowerCase();\n    if (lower.includes('@' + capabilities.getNickname().toLowerCase()) || lower.includes(capabilities.getNickname().toLowerCase())) return 'nameMention';",
      "    const __nick = capabilities.getNickname();\n    const lower = String(textContent ?? '').toLowerCase();\n    if (lower.includes('@' + __nick.toLowerCase()) || lower.includes(__nick.toLowerCase())) return 'nameMention';",
      'eager nickname'),
    input: () => withTriggers({ nameMention: true }, {
      nickname: 'Alpha',
      textContent: (ctx) => ({
        toString() { ctx.log.push('text.toString'); ctx.nick.value = 'Beta'; return 'hello beta'; },
      }),
    }),
  },
  {
    label: 'premature random draw at function entry',
    transform: (source) => replaceOnce(source,
      "  if (kind === 'private') return 'private';",
      "  const __earlyRandom = capabilities.random();\n  if (kind === 'private') return 'private';",
      'premature random'),
    input: () => spec({ kind: 'private', randomValues: [new Error('random must not run')] }),
  },
  {
    label: 'cached keyword collection read',
    transform: (source) => replaceOnce(source,
      "  if (Array.isArray(tr.keywords) && tr.keywords.length) {\n    const lower = String(plainContent ?? '').toLowerCase();\n    for (const kw of tr.keywords) {",
      "  const __keywords = tr.keywords;\n  if (Array.isArray(__keywords) && __keywords.length) {\n    const lower = String(plainContent ?? '').toLowerCase();\n    for (const kw of __keywords) {",
      'cached keyword read'),
    input: () => withTriggers({ keywords: ['ds'] }, { plainContent: 'ds' }),
  },
  {
    label: 'question moved after speaker',
    transform: (source) => {
      const question = "  if (tr.question && legacyIsDirectedAtAi(plainContent)) return 'question';\n";
      const speaker = "  if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {\n    const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');\n    if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {\n      const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;\n      return `speaker:${senderLabel}`;\n    }\n  }\n";
      const withSpeakerFirst = replaceOnce(source, question + speaker, speaker + question, 'question order');
      return withSpeakerFirst;
    },
    input: () => withTriggers(
      { question: true, speakerIds: ['123'] },
      { plainContent: '你说话啊', event: { message: [], self_id: '999', user_id: 123, sender: { card: '卡片' } } },
    ),
  },
];

async function importMutant(source, label) {
  const url = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}#${encodeURIComponent(label)}`;
  return import(url);
}

test('[mutants] in-memory semantic drift is rejected by this harness', async () => {
  const base = fs.readFileSync(FIXTURE_URL, 'utf8');
  for (const mutant of MUTANTS) {
    const mutated = mutant.transform(base);
    assert.notEqual(mutated, base, `${mutant.label}: mutation applied`);
    const module = await importMutant(mutated, mutant.label);
    const mutatedFn = module.legacyEvaluateWakeTrigger;
    assert.equal(typeof mutatedFn, 'function', `${mutant.label}: mutant imported`);
    const input = mutant.input();
    const oracle = runEval(legacy.legacyEvaluateWakeTrigger, input);
    const drifted = runEval(mutatedFn, input);
    const differs = drifted.error?.message !== oracle.error?.message
      || drifted.value !== oracle.value
      || JSON.stringify(drifted.log) !== JSON.stringify(oracle.log);
    assert.equal(differs, true, `${mutant.label}: mutant must differ from the oracle`);
    assert.throws(() => assert.deepEqual(
      { value: drifted.value, error: drifted.error, log: drifted.log },
      { value: oracle.value, error: oracle.error, log: oracle.log },
    ), `${mutant.label}: differential assertion must fail on the mutant`);
  }
});
