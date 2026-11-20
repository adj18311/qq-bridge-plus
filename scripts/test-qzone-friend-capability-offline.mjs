import assert from 'node:assert/strict';
import test from 'node:test';
import { createQzoneFriendCapabilityOffline } from '../src/core/qzone-friend-capability-offline.mjs';

function harness({ friendIds = [42], initialTime = Date.now(), ttlMs = 1_000 } = {}) {
  let now = initialTime;
  const api = createQzoneFriendCapabilityOffline({
    ttlMs,
    clock: () => now,
    trustedConstruct: async (targetQq, mint) => {
      if (friendIds.includes(targetQq)) return mint(targetQq);
      return null;
    }
  });
  return { api, initialTime, ttlMs, setNow(value) { now = value; } };
}

test('only the injected trusted constructor can mint a target-bound opaque capability', async () => {
  const { api } = harness();
  const capability = await api.issue(42);

  assert.equal(typeof capability, 'object');
  assert.equal(Object.isFrozen(capability), true);
  assert.deepEqual(await api.consume(capability, 42), { trustedStatus: 'trusted', friend: true });
  assert.deepEqual(await api.consume(capability, 84), { trustedStatus: 'unknown', friend: false });
  assert.deepEqual(await api.consume({ ...capability }, 42), { trustedStatus: 'unknown', friend: false });
});

test('a capability is consumed even when attempted against the wrong target', async () => {
  const { api } = harness();
  const capability = await api.issue(42);

  assert.deepEqual(await api.consume(capability, 84), { trustedStatus: 'unknown', friend: false });
  assert.deepEqual(await api.consume(capability, 42), { trustedStatus: 'unknown', friend: false });
});

test('a capability expires at its TTL boundary and cannot be replayed', async () => {
  const { api, initialTime, ttlMs, setNow } = harness({ initialTime: Date.now() - 10_000, ttlMs: 500 });
  const capability = await api.issue(42);
  setNow(initialTime + ttlMs);
  assert.deepEqual(await api.consume(capability, 42), { trustedStatus: 'unknown', friend: false });
  assert.deepEqual(await api.consume(capability, 42), { trustedStatus: 'unknown', friend: false });
});

test('clock rollback blocks mint and burns an attempted capability use', async () => {
  const base = Date.now();
  const { api, setNow } = harness({ initialTime: base });
  const capability = await api.issue(42);
  setNow(base - 1);

  assert.equal(await api.issue(42), null);
  assert.deepEqual(await api.consume(capability, 42), { trustedStatus: 'unknown', friend: false });
  setNow(base + 1);
  assert.deepEqual(await api.consume(capability, 42), { trustedStatus: 'unknown', friend: false });
});

test('future clock values and caller-supplied timestamps cannot produce a capability', async () => {
  const { api, setNow } = harness();
  setNow(Date.now() + 60_000);
  assert.equal(await api.issue(42), null);
  setNow(Date.now());
  assert.equal(await api.issue(42, Date.now() - 60_000), null);
});

test('invalid targets, TTL settings and absent trusted constructor fail closed', async () => {
  assert.throws(() => createQzoneFriendCapabilityOffline({ trustedConstruct: () => {} }), /invalid/);
  assert.throws(() => createQzoneFriendCapabilityOffline({ trustedConstruct: () => {}, clock: Date.now, ttlMs: 30_001 }), /invalid/);
  const { api } = harness();
  for (const target of [0, -1, 1.5, '42', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await api.issue(target), null);
  }
});

test('未完成或失败的可信读取不得提前激活或泄漏 capability', async () => {
  let leaked; let during;
  let api;
  api = createQzoneFriendCapabilityOffline({ ttlMs: 1000, clock: Date.now,
    trustedConstruct: async (target, mint) => {
      leaked = mint(target);
      during = api.consume(leaked, target);
      throw new Error('verification failed');
    } });
  assert.equal(await api.issue(42), null);
  assert.deepEqual(during, { trustedStatus: 'unknown', friend: false });
  assert.deepEqual(api.consume(leaked, 42), { trustedStatus: 'unknown', friend: false });
});
