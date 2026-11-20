import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createQzoneFriendCapabilityOffline } from '../src/core/qzone-friend-capability-offline.mjs';
import { createQzoneCapabilityFriendReadOffline } from '../src/core/qzone-capability-friend-read-offline.mjs';

const NOW = Date.parse('2026-11-08T02:00:00Z');

function initial(overrides = {}) {
  return {
    offlineTestFixture: true,
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    reads: 0, writes: 0, tools: { read_posts: true }, readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-08', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
    activeStart: 420, activeEnd: 1380, audit: [], ...overrides,
  };
}

async function harness(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-capability-friend-read-'));
  const store = openOfflineStore(join(dir, 'state.sqlite'), initial(overrides));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  let clockNow = Date.now() - 10_000;
  const issuer = createQzoneFriendCapabilityOffline({
    ttlMs: 1000, clock: () => clockNow,
    trustedConstruct: async (targetQq, mint) => targetQq === 42 ? mint(targetQq) : null,
  });
  const read = createQzoneCapabilityFriendReadOffline({ store, capabilityApi: issuer, offlineTestFixture: true });
  return { store, issuer, read, setClock(value) { clockNow = value; } };
}

const request = (overrides = {}) => ({
  id: 'friend-read-1', now: NOW, tool: 'read_posts', source: 'requested', target: '42', activeTime: false,
  ...overrides,
});
const page = [
  { author: '42', id: 'recent', time: NOW - 60_000, content: 'recent fixture' },
  { author: '42', id: 'old', time: NOW - 8 * 86400000, content: 'old fixture' },
  { author: '84', id: 'other', time: NOW - 60_000, content: 'other author fixture' },
];

test('私有 issuer capability 绑定目标并消费后才预留读取、过滤及审计', async (t) => {
  const { store, issuer, read } = await harness(t);
  const capability = await issuer.issue(42);
  const result = await read({ request: request(), capability, page });

  assert.deepEqual(result, {
    allowed: true, outcome: 'success',
    posts: [{ author: '42', id: 'recent', time: NOW - 60_000, content: 'recent fixture' }],
  });
  assert.equal(store.read().readAttempts['friend-read-1'], true);
  assert.equal(store.read().readOutcomes['friend-read-1'], 'success');
  assert.equal(store.read().audit.find((entry) => entry.id === 'read:friend-read-1')?.record.target, '42');
  assert.equal(store.read().audit.find((entry) => entry.id === 'read_intent_friend-read-1')?.record.result, 'unknown');
});

test('调用方 friend:true 或伪造对象不能替代 capability，也不预留读取', async (t) => {
  const { store, read } = await harness(t);
  const result = await read({ request: request(), capability: { friend: true }, page });

  assert.deepEqual(result, { allowed: false, reason: 'friend_unverified' });
  assert.deepEqual(store.read().readAttempts, {});
  assert.deepEqual(store.read().audit, []);
});

test('错目标消费会烧毁 capability，重放不能读取', async (t) => {
  const { store, issuer, read } = await harness(t);
  const capability = await issuer.issue(42);

  assert.deepEqual(await read({ request: request({ target: '84' }), capability, page }), {
    allowed: false, reason: 'friend_unverified',
  });
  assert.deepEqual(await read({ request: request({ id: 'replay' }), capability, page }), {
    allowed: false, reason: 'friend_unverified',
  });
  assert.deepEqual(store.read().readAttempts, {});
});

test('过期 capability 不产生读取、预算或审计副作用', async (t) => {
  const { store, issuer, read, setClock } = await harness(t);
  const capability = await issuer.issue(42);
  setClock(Date.now() - 9000);
  assert.deepEqual(await read({ request: request(), capability, page }), {
    allowed: false, reason: 'friend_unverified',
  });
  assert.deepEqual(store.read().readAttempts, {});
  assert.deepEqual(store.read().audit, []);
});

test('原有读取权限、预算与主动时段拒绝仍由读取预留执行', async (t) => {
  const { store, issuer, read } = await harness(t, { readAllowed: false });
  const capability = await issuer.issue(42);

  assert.deepEqual(await read({ request: request(), capability, page }), {
    allowed: false, reason: 'permission',
  });
  assert.deepEqual(store.read().readAttempts, {});
  assert.deepEqual(store.read().audit, []);
});

test('入口拒绝传输回调与不安全页面访问器，页面 getter 不执行', async (t) => {
  const { issuer, read } = await harness(t);
  let callbackCalls = 0;
  const callbackCapability = await issuer.issue(42);
  await assert.rejects(() => read({ request: request(), capability: callbackCapability, page,
    fetch: async () => { callbackCalls++; return []; } }), /invalid/);
  assert.equal(callbackCalls, 0);

  let getterCalls = 0;
  const unsafePage = [Object.defineProperty({ author: '42', id: 'x', time: NOW - 1 }, 'content', {
    enumerable: true, get() { getterCalls++; return 'unsafe'; },
  })];
  const unsafeCapability = await issuer.issue(42);
  await assert.rejects(() => read({ request: request({ id: 'unsafe' }),
    capability: unsafeCapability, page: unsafePage }), /invalid/);
  assert.equal(getterCalls, 0);
});

test('必须显式标记离线 fixture，且该标记不替代 capability', async (t) => {
  const { store, issuer } = await harness(t);
  assert.throws(() => createQzoneCapabilityFriendReadOffline({ store, capabilityApi: issuer }), /fixture/);
});

test('形似发行器的冻结伪对象不能伪造可信好友结果', async (t) => {
  const { store } = await harness(t);
  const forged = Object.freeze({ issue() {}, consume() { return { trustedStatus: 'trusted', friend: true }; } });
  assert.throws(() => createQzoneCapabilityFriendReadOffline({ store, capabilityApi: forged, offlineTestFixture: true }), /invalid/);
});

test('状态库未标记为测试夹具时，禁止消耗 capability 或写入状态', async (t) => {
  const { store, issuer, read } = await harness(t, { offlineTestFixture: false });
  const capability = await issuer.issue(42);
  const before = store.read();
  await assert.rejects(() => read({ request: request(), capability, page }), /fixture/);
  assert.deepEqual(store.read(), before);
  assert.deepEqual(issuer.consume(capability, 42), { trustedStatus: 'trusted', friend: true });
});
