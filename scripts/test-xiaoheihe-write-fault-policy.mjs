// scripts/test-xiaoheihe-write-fault-policy.mjs
// Offline unit tests for src/core/xiaoheihe-write-fault-policy.mjs.
// Pure policy only: no network, no credentials, no production files, no real sends.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  initialXhhFaultState,
  transitionXhhFault,
  xhhFaultPermissions,
} from '../src/core/xiaoheihe-write-fault-policy.mjs';

const at = (iso) => Date.parse(iso);
const T0 = at('2026-01-01T10:00:00+08:00');

function fail(state, ms) {
  return transitionXhhFault(state, { type: 'write-failure', at: ms });
}

function assertPolicyState(state) {
  assert.equal(typeof state, 'object');
  assert.notEqual(state, null);
  assert.equal(typeof state.day, 'string');
  assert.match(state.day, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  assert.equal(typeof state.consecutiveWriteFailures, 'number');
  assert.equal(typeof state.writePaused, 'boolean');
  assert.equal(typeof state.accessPaused, 'boolean');
  assert.ok(state.accessReason === null || typeof state.accessReason === 'string');
}

test('initial state is clean and keyed to the Beijing calendar day', () => {
  const state = initialXhhFaultState(T0);
  assertPolicyState(state);
  assert.equal(state.day, '2026-01-01');
  assert.equal(state.consecutiveWriteFailures, 0);
  assert.equal(state.writePaused, false);
  assert.equal(state.accessPaused, false);
  assert.equal(state.accessReason, null);
});

test('day is computed in Beijing time (UTC+8) across the UTC boundary', () => {
  assert.equal(initialXhhFaultState(at('2025-12-31T23:59:59+08:00')).day, '2025-12-31');
  assert.equal(initialXhhFaultState(at('2026-01-01T00:00:00+08:00')).day, '2026-01-01');
  assert.equal(initialXhhFaultState(at('2025-12-31T15:59:59Z')).day, '2025-12-31');
  assert.equal(initialXhhFaultState(at('2025-12-31T16:00:00Z')).day, '2026-01-01');
});

test('third consecutive write failure notifies once and pauses writes but not reads', () => {
  let out = fail(initialXhhFaultState(T0), T0 + 1000);
  assert.equal(out.notify, null);
  assert.equal(out.state.consecutiveWriteFailures, 1);
  assert.equal(out.state.writePaused, false);
  assert.equal(out.state.accessPaused, false);

  out = fail(out.state, T0 + 2000);
  assert.equal(out.notify, null);
  assert.equal(out.state.consecutiveWriteFailures, 2);
  assert.equal(out.state.writePaused, false);

  out = fail(out.state, T0 + 3000);
  assert.equal(out.notify, 'write-failures');
  assert.equal(out.state.consecutiveWriteFailures, 3);
  assert.equal(out.state.writePaused, true);
  assert.equal(out.state.accessPaused, false);
  assert.equal(out.state.accessReason, null);
  assertPolicyState(out.state);

  const fourth = fail(out.state, T0 + 4000);
  assert.equal(fourth.notify, null);
  assert.equal(fourth.state.writePaused, true);
  assert.equal(fourth.state.accessPaused, false);
  assert.ok(fourth.state.consecutiveWriteFailures >= 3);
});

test('success resets an unpaused failure streak, but cannot silently clear a pause', () => {
  let state = initialXhhFaultState(T0);
  state = fail(state, T0 + 1000).state;
  state = fail(state, T0 + 2000).state;
  state = transitionXhhFault(state, { type: 'write-success', at: T0 + 3000 }).state;
  assert.equal(state.consecutiveWriteFailures, 0);
  assert.equal(state.writePaused, false);
  state = fail(state, T0 + 4000).state;
  state = fail(state, T0 + 5000).state;
  state = fail(state, T0 + 6000).state;
  const lateSuccess = transitionXhhFault(state, { type: 'write-success', at: T0 + 7000 });
  assert.equal(lateSuccess.state.writePaused, true);
});

test('write-unknown is neither a failure nor a success and never triggers retries', () => {
  let out = transitionXhhFault(initialXhhFaultState(T0), { type: 'write-unknown', at: T0 + 1000 });
  assert.equal(out.notify, null);
  assert.equal(out.state.consecutiveWriteFailures, 0);
  assert.equal(out.state.writePaused, false);
  assert.equal(out.state.accessPaused, false);

  for (let i = 2; i <= 6; i += 1) {
    out = transitionXhhFault(out.state, { type: 'write-unknown', at: T0 + i * 1000 });
    assert.equal(out.notify, null);
  }
  assert.equal(out.state.consecutiveWriteFailures, 0);
  assert.equal(out.state.writePaused, false);

  let state = initialXhhFaultState(T0 + 60000);
  state = fail(state, T0 + 61000).state;
  state = fail(state, T0 + 62000).state;
  state = transitionXhhFault(state, { type: 'write-unknown', at: T0 + 63000 }).state;
  assert.equal(state.consecutiveWriteFailures, 2);
  assert.equal(state.writePaused, false);
});

for (const type of ['login-required', 'captcha', 'network-unavailable']) {
  test(`${type} pauses reads and writes immediately and notifies only once`, () => {
    const start = initialXhhFaultState(T0);
    const first = transitionXhhFault(start, { type, at: T0 + 1000 });
    assert.equal(first.notify, type);
    assert.equal(first.state.accessPaused, true);
    assert.equal(first.state.writePaused, false);
    assert.equal(typeof first.state.accessReason, 'string');
    assert.ok(first.state.accessReason.length > 0);
    assertPolicyState(first.state);

    const repeat = transitionXhhFault(first.state, { type, at: T0 + 2000 });
    assert.equal(repeat.notify, null);
    assert.equal(repeat.state.accessPaused, true);
    assert.equal(repeat.state.accessReason, first.state.accessReason);

    const checked = transitionXhhFault(repeat.state, { type: 'check', at: T0 + 3000 });
    assert.equal(checked.notify, null);
    assert.equal(checked.state.accessPaused, true);
    assert.equal(checked.state.writePaused, false);
  });
}

test('Beijing midnight advances the day key but keeps write and access pauses (admin-only recovery)', () => {
  const start = at('2026-01-01T09:00:00+08:00');
  let state = initialXhhFaultState(start);
  state = fail(state, start + 1000).state;
  state = fail(state, start + 2000).state;
  const third = fail(state, start + 3000);
  assert.equal(third.notify, 'write-failures');
  assert.equal(third.state.writePaused, true);

  const loginPaused = transitionXhhFault(third.state, {
    type: 'login-required',
    at: start + 4000,
  }).state;
  assert.equal(loginPaused.accessPaused, true);

  const rolled = transitionXhhFault(loginPaused, {
    type: 'check',
    at: at('2026-01-02T00:00:01+08:00'),
  });
  assert.equal(rolled.state.day, '2026-01-02');
  // 2026-10-25 新口径：日切只推进日键；写暂停/失败链/原因与全访问暂停都必须保留，
  // 只能由可信管理员恢复（task-10）。
  assert.equal(rolled.state.writePaused, true);
  assert.equal(rolled.state.writeReason, 'consecutive-failures');
  assert.equal(rolled.state.consecutiveWriteFailures, 3);
  assert.equal(rolled.state.accessPaused, true);
  assert.equal(typeof rolled.state.accessReason, 'string');
  assert.equal(rolled.notify, null);
});

test('checking within the same Beijing day does not reset the failure streak', () => {
  let state = initialXhhFaultState(T0);
  state = fail(state, T0 + 1000).state;
  state = fail(state, T0 + 2000).state;
  const checked = transitionXhhFault(state, {
    type: 'check',
    at: at('2026-01-01T23:59:00+08:00'),
  });
  assert.equal(checked.state.day, '2026-01-01');
  assert.equal(checked.state.consecutiveWriteFailures, 2);
  assert.equal(checked.state.writePaused, false);
  assert.equal(checked.notify, null);
});

test('events with a timestamp before the last observed instant are rejected', () => {
  const state = initialXhhFaultState(T0);
  const out = fail(state, T0 + 5000);
  assert.equal(out.state.consecutiveWriteFailures, 1);

  assert.throws(() => transitionXhhFault(out.state, { type: 'write-failure', at: T0 + 4000 }));
  assert.throws(() => transitionXhhFault(out.state, { type: 'write-success', at: T0 }));
  assert.throws(() => transitionXhhFault(out.state, { type: 'check', at: T0 - 1 }));

  assert.equal(out.state.consecutiveWriteFailures, 1);
  assert.equal(out.state.writePaused, false);
});

test('admin-clear is rejected unless the caller is a verified administrator', () => {
  let state = initialXhhFaultState(T0);
  state = transitionXhhFault(state, { type: 'login-required', at: T0 + 1000 }).state;
  const t = T0 + 2000;

  assert.throws(() => transitionXhhFault(state, { type: 'admin-clear', at: t }));
  assert.throws(() => transitionXhhFault(state, { type: 'admin-clear', at: t, verifiedAdmin: false }));
  assert.throws(() => transitionXhhFault(state, { type: 'admin-clear', at: t, verifiedAdmin: 'true' }));
  assert.throws(() => transitionXhhFault(state, { type: 'admin-clear', at: t, verifiedAdmin: 1 }));

  assert.equal(state.accessPaused, true);
});

test('verified admin recovery clears policy pauses', () => {
  let state = initialXhhFaultState(T0);
  state = transitionXhhFault(state, { type: 'captcha', at: T0 + 1000 }).state;

  const out = transitionXhhFault(state, {
    type: 'admin-clear',
    at: T0 + 2000,
    verifiedAdmin: true,
  });
  assert.equal(out.notify, null);
  assert.equal(out.state.accessPaused, false);
  assert.equal(out.state.accessReason, null);
  assert.equal(out.state.writePaused, false);
  assert.equal(out.state.consecutiveWriteFailures, 0);
  assert.equal(out.state.day, '2026-01-01');
  assertPolicyState(out.state);

  const after = transitionXhhFault(out.state, { type: 'write-success', at: T0 + 3000 });
  assert.equal(after.notify, null);
  assert.equal(after.state.writePaused, false);
});

test('transitions are pure, immutable and deterministic', () => {
  const start = initialXhhFaultState(T0);
  const startSnapshot = JSON.stringify(start);
  const first = transitionXhhFault(start, { type: 'write-failure', at: T0 + 1000 });

  assert.equal(JSON.stringify(start), startSnapshot);
  assert.notEqual(first.state, start);
  assert.ok(first !== null && typeof first === 'object');
  assert.ok('state' in first);
  assert.ok('notify' in first);
  assertPolicyState(first.state);

  const second = transitionXhhFault(start, { type: 'write-failure', at: T0 + 1000 });
  assert.equal(JSON.stringify(second), JSON.stringify(first));

  let paused = start;
  for (let i = 1; i <= 3; i += 1) {
    paused = fail(paused, T0 + i * 1000).state;
  }
  assert.equal(paused.writePaused, true);
  const pausedSnapshot = JSON.stringify(paused);
  const recovery = transitionXhhFault(paused, { type: 'admin-clear', at: T0 + 10000, verifiedAdmin: true });
  assert.equal(JSON.stringify(paused), pausedSnapshot);
  assert.notEqual(recovery.state, paused);
});

test('unknown events and invalid states are rejected', () => {
  const state = initialXhhFaultState(T0);

  assert.throws(() => transitionXhhFault(state, { type: 'write-failure' }));
  assert.throws(() => transitionXhhFault(state, { type: 'write-failure', at: Number.NaN }));
  assert.throws(() => transitionXhhFault(state, { type: 'write-failure', at: 'now' }));
  assert.throws(() => transitionXhhFault(state, { type: 'make-it-stop', at: T0 + 1000 }));
  assert.throws(() => transitionXhhFault(state, { at: T0 + 1000 }));
  assert.throws(() => transitionXhhFault(state, null));
  assert.throws(() => transitionXhhFault(state, undefined));
  assert.throws(() => initialXhhFaultState(Number.NaN));
  assert.throws(() => initialXhhFaultState('2026-01-01T10:00:00+08:00'));

  assert.throws(() => transitionXhhFault(null, { type: 'check', at: T0 + 1000 }));
  assert.throws(() => transitionXhhFault(undefined, { type: 'check', at: T0 + 1000 }));
  assert.throws(() => transitionXhhFault({}, { type: 'check', at: T0 + 1000 }));
  assert.throws(() => transitionXhhFault({ day: '2026-01-01' }, { type: 'check', at: T0 + 1000 }));
  assert.throws(() => transitionXhhFault('2026-01-01', { type: 'check', at: T0 + 1000 }));

  const ok = transitionXhhFault(state, { type: 'check', at: T0 + 1000 });
  assert.equal(ok.notify, null);
  assert.equal(ok.state.day, '2026-01-01');
});

test('inconsistent threshold state cannot silently allow writes after reload', () => {
  const state = initialXhhFaultState(T0);
  assert.throws(() => transitionXhhFault({ ...state, consecutiveWriteFailures: 3 }, { type: 'check', at: T0 + 1 }));
  assert.throws(() => transitionXhhFault({ ...state, writePaused: true }, { type: 'check', at: T0 + 1 }));
});

test('effective permissions combine write-only and full-access pauses', () => {
  let state = initialXhhFaultState(T0);
  assert.deepEqual(xhhFaultPermissions(state), { readAllowed: true, writeAllowed: true });
  for (let i = 1; i <= 3; i += 1) state = fail(state, T0 + i).state;
  assert.deepEqual(xhhFaultPermissions(state), { readAllowed: true, writeAllowed: false });
  state = transitionXhhFault(state, { type: 'captcha', at: T0 + 4 }).state;
  assert.deepEqual(xhhFaultPermissions(state), { readAllowed: false, writeAllowed: false });
  const fresh = transitionXhhFault(initialXhhFaultState(T0), { type: 'network-unavailable', at: T0 + 1 }).state;
  assert.deepEqual(xhhFaultPermissions(fresh), { readAllowed: false, writeAllowed: false });
});

test('unknown state fields are rejected instead of silently discarded', () => {
  const state = { ...initialXhhFaultState(T0), quotaUsed: 7 };
  assert.throws(() => transitionXhhFault(state, { type: 'check', at: T0 + 1 }));
});

test('notify is always null or one of the documented policy values', () => {
  const allowed = new Set([null, 'write-failures', 'login-required', 'captcha', 'network-unavailable']);
  const script = [
    { type: 'check', at: T0 + 1000 },
    { type: 'write-success', at: T0 + 2000 },
    { type: 'write-failure', at: T0 + 3000 },
    { type: 'write-unknown', at: T0 + 4000 },
    { type: 'write-failure', at: T0 + 5000 },
    { type: 'write-failure', at: T0 + 6000 },
    { type: 'write-failure', at: T0 + 7000 },
    { type: 'captcha', at: T0 + 8000 },
    { type: 'network-unavailable', at: T0 + 9000 },
    { type: 'login-required', at: T0 + 10000 },
    { type: 'check', at: T0 + 11000 },
    { type: 'admin-clear', at: T0 + 12000, verifiedAdmin: true },
    { type: 'write-success', at: T0 + 13000 },
  ];

  let state = initialXhhFaultState(T0);
  for (const event of script) {
    const out = transitionXhhFault(state, event);
    assert.ok(allowed.has(out.notify), `unexpected notify value: ${String(out.notify)}`);
    assertPolicyState(out.state);
    assert.equal(out.state.day, '2026-01-01');
    state = out.state;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// task-10（用户 2026-10-25 决定）：写暂停改为**持久暂停、仅可信管理员恢复**。
// 跨北京零点不自动解除；日切只更新日键（额度/日计数在持久账本层重置，不属本纯策略）；
// 恢复不重置额度/最小间隔/unknown；accessPaused 跨日保留、仅管理员恢复。
// ─────────────────────────────────────────────────────────────────────────────

const WRITE_PAUSE_REASON = 'consecutive-failures';

test('initial state carries an explicit null write-pause reason', () => {
  const state = initialXhhFaultState(T0);
  assert.equal(state.writeReason, null);
  assert.equal(state.writePaused, false);
});

test('write pause carries an explicit reason and only admin-clear lifts it', () => {
  let state = initialXhhFaultState(T0);
  for (let i = 1; i <= 3; i += 1) state = fail(state, T0 + i * 1000).state;
  assert.equal(state.writePaused, true);
  assert.equal(state.writeReason, WRITE_PAUSE_REASON, '写暂停必须带明确原因');

  // 成功 / unknown / check 都不能解除写暂停。
  const success = transitionXhhFault(state, { type: 'write-success', at: T0 + 10_000 });
  assert.equal(success.state.writePaused, true);
  assert.equal(success.state.writeReason, WRITE_PAUSE_REASON);
  const unknown = transitionXhhFault(success.state, { type: 'write-unknown', at: T0 + 11_000 });
  assert.equal(unknown.state.writePaused, true);
  const checked = transitionXhhFault(unknown.state, { type: 'check', at: T0 + 12_000 });
  assert.equal(checked.state.writePaused, true);

  // 只有可信管理员恢复。
  const cleared = transitionXhhFault(checked.state, {
    type: 'admin-clear',
    at: T0 + 13_000,
    verifiedAdmin: true,
  });
  assert.equal(cleared.state.writePaused, false);
  assert.equal(cleared.state.writeReason, null);
  assert.equal(cleared.state.consecutiveWriteFailures, 0);
});

test('Beijing midnight alone never clears the write pause (admin only)', () => {
  const start = at('2026-01-01T23:50:00+08:00');
  let state = initialXhhFaultState(start);
  for (let i = 1; i <= 3; i += 1) state = fail(state, start + i * 1000).state;
  assert.equal(state.writePaused, true);

  const afterMidnight = transitionXhhFault(state, {
    type: 'check',
    at: at('2026-01-02T00:00:01+08:00'),
  });
  assert.equal(afterMidnight.state.day, '2026-01-02', '日键仍应按北京时间推进');
  assert.equal(afterMidnight.state.writePaused, true, '跨零点不得自动解除写暂停');
  assert.ok(afterMidnight.state.consecutiveWriteFailures >= 3, '跨零点不得清失败链');
  assert.equal(afterMidnight.state.writeReason, WRITE_PAUSE_REASON);
  assert.equal(afterMidnight.notify, null);
  assert.deepEqual(xhhFaultPermissions(afterMidnight.state), { readAllowed: true, writeAllowed: false });

  const nextDayFailure = fail(afterMidnight.state, at('2026-01-02T00:01:00+08:00'));
  assert.equal(nextDayFailure.state.writePaused, true, '跨日后仍保持暂停');
  assert.equal(nextDayFailure.notify, null, '已在暂停中不得重复通知');
});

test('Beijing midnight does not silently clear a partial failure streak', () => {
  const start = at('2026-01-01T23:58:00+08:00');
  let state = initialXhhFaultState(start);
  state = fail(state, start + 1000).state;
  state = fail(state, start + 2000).state;

  const afterMidnight = transitionXhhFault(state, {
    type: 'check',
    at: at('2026-01-02T00:00:01+08:00'),
  });
  assert.equal(afterMidnight.state.writePaused, false);
  assert.equal(afterMidnight.state.consecutiveWriteFailures, 2, '日切只更新日键，不清未暂停的失败链');

  const third = fail(afterMidnight.state, at('2026-01-02T00:01:00+08:00'));
  assert.equal(third.state.writePaused, true, '跨日后的第三次 failure 仍应触发暂停');
  assert.equal(third.notify, 'write-failures');
});

test('access pause survives midnight and is not cleared by write recovery', () => {
  const start = at('2026-01-01T23:59:00+08:00');
  let state = transitionXhhFault(initialXhhFaultState(start), { type: 'captcha', at: start + 1000 }).state;
  const afterMidnight = transitionXhhFault(state, { type: 'check', at: at('2026-01-02T00:00:02+08:00') });
  assert.equal(afterMidnight.state.accessPaused, true);
  assert.equal(afterMidnight.state.accessReason, 'captcha');
  assert.equal(afterMidnight.state.writePaused, false, 'access 暂停不应顺带产生写暂停');

  const success = transitionXhhFault(afterMidnight.state, { type: 'write-success', at: at('2026-01-02T00:01:00+08:00') });
  assert.equal(success.state.accessPaused, true, 'write-success 不得解除全访问暂停');
  assert.deepEqual(xhhFaultPermissions(success.state), { readAllowed: false, writeAllowed: false });

  const cleared = transitionXhhFault(success.state, {
    type: 'admin-clear',
    at: at('2026-01-02T00:02:00+08:00'),
    verifiedAdmin: true,
  });
  assert.equal(cleared.state.accessPaused, false);
  assert.equal(cleared.state.accessReason, null);
});

test('admin recovery clears pauses but does not touch day or invent quota fields', () => {
  let state = initialXhhFaultState(T0);
  for (let i = 1; i <= 3; i += 1) state = fail(state, T0 + i).state;
  state = transitionXhhFault(state, { type: 'login-required', at: T0 + 10 }).state;
  const out = transitionXhhFault(state, { type: 'admin-clear', at: T0 + 20, verifiedAdmin: true });
  assert.equal(out.state.day, state.day, '恢复不得改动日键/额度归属');
  assert.deepEqual(
    Object.keys(out.state).sort(),
    ['accessPaused', 'accessReason', 'consecutiveWriteFailures', 'day', 'lastEventAt', 'writePaused', 'writeReason'],
    '恢复不得引入额度/间隔/unknown 等字段（这些由持久层自己负责，不得被 admin-clear 重置）',
  );
  assert.equal(out.state.consecutiveWriteFailures, 0);
  assert.equal(out.state.writePaused, false);
  assert.equal(out.state.writeReason, null);
});

test('write pause state invariants reject contradictions', () => {
  const base = initialXhhFaultState(T0);
  // 暂停但没有原因
  assert.throws(() => transitionXhhFault(
    { ...base, consecutiveWriteFailures: 3, writePaused: true, writeReason: null },
    { type: 'check', at: T0 + 1 },
  ));
  // 有原因但未暂停
  assert.throws(() => transitionXhhFault(
    { ...base, writeReason: WRITE_PAUSE_REASON },
    { type: 'check', at: T0 + 1 },
  ));
  // 不支持的原因
  assert.throws(() => transitionXhhFault(
    { ...base, consecutiveWriteFailures: 3, writePaused: true, writeReason: 'other' },
    { type: 'check', at: T0 + 1 },
  ));
  // 暂停但失败链不足阈值
  assert.throws(() => transitionXhhFault(
    { ...base, writePaused: true, writeReason: WRITE_PAUSE_REASON },
    { type: 'check', at: T0 + 1 },
  ));
});

