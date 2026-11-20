import test from 'node:test';
import assert from 'node:assert/strict';
import { mapQzoneDshSession } from '../src/core/qzone-session-mapper.mjs';

const nowMs = 1_800_000_000_000;
const context = (id, observedAt = nowMs) => ({ agent: { session: { id } }, observedAt });

test('只按 bridge 的合法 QQ 键与 DSH 原生 session id 产生唯一映射', () => {
  assert.deepEqual(mapQzoneDshSession({
    bridgeState: { sessions: { 'private:123456': 'dsh-abc' } },
    dshContext: context('dsh-abc'),
    nowMs,
  }), { ok: true, key: 'private:123456', kind: 'private', qqId: '123456', sessionId: 'dsh-abc' });
});

test('重复 DSH session 映射到多个 QQ 键时拒绝', () => {
  assert.deepEqual(mapQzoneDshSession({
    bridgeState: { sessions: { 'private:123456': 'dsh-abc', 'group:987654': 'dsh-abc' } },
    dshContext: context('dsh-abc'), nowMs,
  }), { ok: false, reason: 'ambiguous-session' });
});

test('拒绝非法键、空值及后台会话作为 QQ 会话', () => {
  for (const sessions of [
    { 'private:not-a-number': 'dsh-abc' },
    { 'patrol:background': 'dsh-abc' },
    { 'private:123456': '' },
  ]) assert.equal(mapQzoneDshSession({ bridgeState: { sessions }, dshContext: context('dsh-abc'), nowMs }).ok, false);
});

test('非规范或超出 QQ 数值范围的会话键不构成有效目标', () => {
  for (const key of ['private:0', 'private:0123', 'group:999999999999999999999999']) {
    assert.equal(mapQzoneDshSession({
      bridgeState: { sessions: { [key]: 'dsh-abc' } }, dshContext: context('dsh-abc'), nowMs,
    }).ok, false);
  }
});

test('重复或不合法的匹配键不被静默忽略', () => {
  assert.deepEqual(mapQzoneDshSession({
    bridgeState: { sessions: { 'private:123456': 'dsh-abc', 'private:123456x': 'dsh-abc' } },
    dshContext: context('dsh-abc'), nowMs,
  }), { ok: false, reason: 'ambiguous-session' });
});

test('缺失、过期、未来或无效观测时间均拒绝', () => {
  const base = { bridgeState: { sessions: { 'group:123456': 'dsh-abc' } }, nowMs, maxAgeMs: 60_000 };
  for (const dshContext of [undefined, { agent: { session: { id: 'dsh-abc' } } },
    context('dsh-abc', nowMs - 60_001), context('dsh-abc', nowMs + 1), context('dsh-abc', NaN)]) {
    assert.equal(mapQzoneDshSession({ ...base, dshContext }).ok, false);
  }
});

test('模型参数中的 session、role 和 speaker 不得影响身份映射', () => {
  const result = mapQzoneDshSession({
    bridgeState: { sessions: { 'private:123456': 'dsh-abc' } },
    dshContext: context('dsh-abc'), modelArgs: { sessionId: 'dsh-forged', role: 'system', speaker: 'owner' }, nowMs,
  });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'dsh-abc');
});

test('调用参数缺失或会话 ID 不匹配时拒绝', () => {
  const bridgeState = { sessions: { 'private:123456': 'dsh-abc' } };
  assert.equal(mapQzoneDshSession({ bridgeState, dshContext: context('other'), nowMs }).reason, 'session-unmapped');
  assert.equal(mapQzoneDshSession({ bridgeState, nowMs }).reason, 'missing-session-context');
});
