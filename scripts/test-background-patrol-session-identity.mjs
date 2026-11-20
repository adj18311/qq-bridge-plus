#!/usr/bin/env node
// scripts/test-background-patrol-session-identity.mjs
//
// task-50：DSH sessionId → 会话用途映射纯模块测试（TDD 先红后绿）。
//
// 被测：`src/core/background-patrol-session-identity.mjs`
//   createSessionIdentityMapper({ sessions, backgroundSessionId, ownerQQ, reverse?, groupExempt? })
//     classify(sessionId) -> { ok:true, class:'patrol'|'owner'|'group'|'unknown', key?, qq? }
//     isUserExempt(sessionId) -> boolean（仅 owner；group 由 groupExempt 决定）
//
// 语义：
//  · sessionId === backgroundSessionId → patrol（计入额度）；
//  · reverse 映射到 `private:<ownerQQ>` → owner（用户豁免）；`private:<其它>` → unknown（不豁免）；
//  · reverse 映射到 `group:<id>` → group（默认豁免，可被 groupExempt=false 关掉）；
//  · 无映射/空/类型错/歧义 → unknown（fail-closed，绝不猜）；classify 永不抛异常、不修改输入。
//
// 已知风险（文档化）：群聊里无法区分“管理员要求”与“群友要求”，本模块只做会话级分类；
// 默认 groupExempt=true 是按用户要求（群聊明确要求不占额度），但存在被群友借用的风险，
// 接线层需要权衡/补充可信证据（当前不存在）。
//
// 纯离线：假 sessions/reverse，不 import bridge、不读 state/config、不联网。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionIdentityMapper } from '../src/core/background-patrol-session-identity.mjs';

const OWNER_QQ = '1234567890';
const BACKGROUND_SESSION_ID = 'dsh-session-background-1';

function makeMapper(overrides = {}) {
  return createSessionIdentityMapper({
    sessions: {
      [`private:${OWNER_QQ}`]: 'dsh-session-owner-1',
      'private:900000001': 'dsh-session-guest-1',
      'group:123456': 'dsh-session-group-1',
    },
    backgroundSessionId: BACKGROUND_SESSION_ID,
    ownerQQ: OWNER_QQ,
    ...overrides,
  });
}

test('构造校验：注入类型非法抛 TypeError；缺省 sessions 允许（只按 reverse/background 分类）', () => {
  assert.throws(() => createSessionIdentityMapper(), TypeError);
  assert.throws(() => createSessionIdentityMapper({ groupExempt: true }), TypeError); // ownerQQ 必填（无 ownerQQ 无法判豁免）
  assert.throws(() => createSessionIdentityMapper({ ownerQQ: OWNER_QQ, sessions: 'bad' }), TypeError);
  assert.throws(() => createSessionIdentityMapper({ ownerQQ: OWNER_QQ, sessions: [] }), TypeError);
  assert.throws(() => createSessionIdentityMapper({ ownerQQ: 'abc' }), TypeError);
  assert.throws(() => createSessionIdentityMapper({ ownerQQ: OWNER_QQ, sessions: {}, reverse: 'bad' }), TypeError);
  assert.throws(() => createSessionIdentityMapper({ ownerQQ: OWNER_QQ, sessions: {}, backgroundSessionId: 42 }), TypeError);
  assert.throws(() => createSessionIdentityMapper({ ownerQQ: OWNER_QQ, sessions: {}, groupExempt: 'yes' }), TypeError);
  // 合法最小配置：ownerQQ + 空 sessions。
  const mapper = createSessionIdentityMapper({ ownerQQ: OWNER_QQ, sessions: {} });
  assert.deepEqual(mapper.classify('anything'), { ok: true, class: 'unknown' });
});

test('patrol：backgroundSessionId 命中即 patrol（优先于 reverse 映射）', () => {
  const mapper = makeMapper({ reverse: { [BACKGROUND_SESSION_ID]: `private:${OWNER_QQ}` } });
  assert.deepEqual(mapper.classify(BACKGROUND_SESSION_ID), { ok: true, class: 'patrol' });
  assert.equal(mapper.isUserExempt(BACKGROUND_SESSION_ID), false);
  // 未创建后台会话（null）时同一 id 不再判 patrol。
  const noBackground = makeMapper({ backgroundSessionId: null, reverse: { [BACKGROUND_SESSION_ID]: `private:${OWNER_QQ}` } });
  assert.equal(noBackground.classify(BACKGROUND_SESSION_ID).class, 'owner');
});

test('owner：private:<ownerQQ> → owner（用户豁免），qq 字段带出', () => {
  const mapper = makeMapper();
  const result = mapper.classify('dsh-session-owner-1');
  assert.equal(result.ok, true);
  assert.equal(result.class, 'owner');
  assert.equal(result.qq, OWNER_QQ);
  assert.ok(String(result.key).startsWith('private:'));
  assert.equal(mapper.isUserExempt('dsh-session-owner-1'), true);
  // 非管理员私聊：不豁免且不是 owner。
  const guest = mapper.classify('dsh-session-guest-1');
  assert.equal(guest.class, 'unknown');
  assert.equal(mapper.isUserExempt('dsh-session-guest-1'), false);
});

test('group：group:<id> → group；默认豁免，groupExempt=false 时不豁免（class 仍是 group）', () => {
  const mapper = makeMapper();
  const group = mapper.classify('dsh-session-group-1');
  assert.equal(group.class, 'group');
  assert.equal(group.ok, true);
  assert.equal(mapper.isUserExempt('dsh-session-group-1'), true);

  const strict = makeMapper({ groupExempt: false });
  assert.equal(strict.classify('dsh-session-group-1').class, 'group');
  assert.equal(strict.isUserExempt('dsh-session-group-1'), false);
});

test('reverse 显式注入：优先于 sessions 反推；支持 Map；group/private 分类一致', () => {
  const mapper = createSessionIdentityMapper({
    ownerQQ: OWNER_QQ,
    sessions: { 'private:1': 's-wrong' },
    reverse: new Map([
      ['s-owner', `private:${OWNER_QQ}`],
      ['s-group', 'group:abc'],
      ['s-guest', 'private:2'],
    ]),
  });
  assert.equal(mapper.classify('s-owner').class, 'owner');
  assert.equal(mapper.classify('s-group').class, 'group');
  assert.equal(mapper.classify('s-guest').class, 'unknown');
  // reverse 优先：sessions 反推的结果被忽略。
  assert.equal(mapper.classify('s-wrong').class, 'unknown');
});

test('歧义映射 fail-closed：同一 sessionId 对应多个 key → unknown（不猜）', () => {
  const mapper = createSessionIdentityMapper({
    ownerQQ: OWNER_QQ,
    sessions: {
      [`private:${OWNER_QQ}`]: 's-ambiguous',
      'group:123': 's-ambiguous',
    },
  });
  assert.equal(mapper.classify('s-ambiguous').class, 'unknown');
  assert.equal(mapper.isUserExempt('s-ambiguous'), false);
});

test('未知/非法输入 fail-closed：空串、非字符串、未映射、非法 key 格式都 unknown 且不抛异常', () => {
  const mapper = makeMapper();
  for (const value of [null, undefined, '', '   ', 42, {}, [], 's-not-mapped', 'dsh-session-owner-1x']) {
    const result = mapper.classify(value);
    assert.equal(result.ok, true, `classify(${String(value)}) 不应抛错`);
    assert.equal(result.class, 'unknown', `classify(${String(value)}) 必须 unknown`);
    assert.equal(mapper.isUserExempt(value), false);
  }
  // 非法格式的 key（即使来自 reverse）也 fail-closed。
  const weird = createSessionIdentityMapper({
    ownerQQ: OWNER_QQ,
    sessions: {},
    reverse: {
      's-bad-private': 'private:abc',
      's-bad-group': 'group:',
      's-other': 'owner:1',
    },
  });
  assert.equal(weird.classify('s-bad-private').class, 'unknown');
  assert.equal(weird.classify('s-bad-group').class, 'unknown');
  assert.equal(weird.classify('s-other').class, 'unknown');
});

test('只读/幂等：不修改注入的 sessions/reverse，多次/并发调用结果一致', async () => {
  const sessions = Object.freeze({ [`private:${OWNER_QQ}`]: 's-owner', 'group:1': 's-group' });
  const reverse = Object.freeze({ 's-owner': `private:${OWNER_QQ}`, 's-group': 'group:1' });
  const mapper = createSessionIdentityMapper({ sessions, reverse, ownerQQ: OWNER_QQ });
  const before = JSON.stringify({ sessions, reverse });
  const results = await Promise.all(Array.from({ length: 50 }, () => Promise.resolve(mapper.classify('s-owner'))));
  assert.equal(results.every((result) => result.class === 'owner'), true);
  for (let index = 0; index < 50; index += 1) assert.equal(mapper.classify('s-group').class, 'group');
  assert.equal(JSON.stringify({ sessions, reverse }), before, '注入对象不得被修改');
  // classify 不接受额外参数/不会返回可变共享引用（返回新对象）。
  const first = mapper.classify('s-owner');
  first.class = 'patrol';
  assert.equal(mapper.classify('s-owner').class, 'owner');
});
