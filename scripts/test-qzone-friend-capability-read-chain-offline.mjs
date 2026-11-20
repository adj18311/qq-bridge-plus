import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createQzoneFriendSource } from '../src/core/qzone-friend-source.mjs';
import { createQzoneFriendCapabilityOffline } from '../src/core/qzone-friend-capability-offline.mjs';
import { simulateOfflineFriendRead } from '../src/core/qzone-simulation-offline.mjs';

// TRUSTED-CONSTRUCTOR SIMULATION: login identity and friend-list transport below
// are fixed synthetic fixtures. This proves the in-process chain only; it does
// not prove the real application's identity source or transport provenance.
function makeTrustedConstructor({ friendIds, clock, events }) {
  const source = createQzoneFriendSource({
    botQq: 9001,
    getLoginInfo: async () => {
      events.push('synthetic-login');
      return { user_id: 9001 };
    },
    getFriendList: async () => {
      events.push('synthetic-friend-list');
      return { status: 'ok', retcode: 0, data: friendIds.map((user_id) => ({ user_id })) };
    },
  });
  return createQzoneFriendCapabilityOffline({
    ttlMs: 1000,
    clock,
    trustedConstruct: async (targetQq, mint) => {
      const proof = await source.isFriend(targetQq);
      if (proof.trustedStatus !== 'trusted' || !proof.friend) return null;
      return mint(targetQq);
    },
  });
}

async function makeStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-friend-read-chain-'));
  const now = Date.parse('2026-11-08T02:00:00Z');
  const store = openOfflineStore(join(dir, 'state.sqlite'), {
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    reads: 0, writes: 0, tools: { read_posts: true }, readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-08', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
    activeStart: 420, activeEnd: 1380, audit: [],
  });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, now };
}

test('错目标、重复消费、过期和非好友均不会进入空间读取 fake', async (t) => {
  const { store, now } = await makeStore(t);
  let clockNow = Date.now() - 10_000;
  const events = [];
  const capabilityApi = makeTrustedConstructor({ friendIds: [42], clock: () => clockNow, events });
  let reads = 0;
  const invokeIfAuthorized = async (capability, targetQq, id) => {
    const proof = capabilityApi.consume(capability, targetQq);
    events.push(`consumed:${proof.trustedStatus}:${targetQq}`);
    if (proof.trustedStatus !== 'trusted' || !proof.friend) return proof;
    await simulateOfflineFriendRead(store, {
      id, now, tool: 'read_posts', source: 'requested', target: String(targetQq), activeTime: false,
    }, { friend: true, author: String(targetQq) }, async () => {
      assert.equal(store.read().readAttempts[id], true, 'read reservation must persist before the synthetic read');
      reads++;
      events.push('space-read');
      return [];
    });
    return proof;
  };

  const wrongTargetCapability = await capabilityApi.issue(42);
  assert.deepEqual(await invokeIfAuthorized(wrongTargetCapability, 84, 'wrong-target'), {
    trustedStatus: 'unknown', friend: false,
  });
  assert.deepEqual(await invokeIfAuthorized(wrongTargetCapability, 42, 'wrong-target-replay'), {
    trustedStatus: 'unknown', friend: false,
  });

  const duplicateCapability = await capabilityApi.issue(42);
  assert.deepEqual(await invokeIfAuthorized(duplicateCapability, 42, 'first-use'), {
    trustedStatus: 'trusted', friend: true,
  });
  assert.deepEqual(await invokeIfAuthorized(duplicateCapability, 42, 'duplicate-use'), {
    trustedStatus: 'unknown', friend: false,
  });

  const expiredCapability = await capabilityApi.issue(42);
  clockNow += 1000;
  assert.deepEqual(await invokeIfAuthorized(expiredCapability, 42, 'expired'), {
    trustedStatus: 'unknown', friend: false,
  });

  const nonFriendApi = makeTrustedConstructor({ friendIds: [84], clock: () => clockNow, events });
  const nonFriendCapability = await nonFriendApi.issue(42);
  assert.equal(nonFriendCapability, null);
  assert.deepEqual(await invokeIfAuthorized(nonFriendCapability, 42, 'non-friend'), {
    trustedStatus: 'unknown', friend: false,
  });

  assert.equal(reads, 1, 'only the first valid single-use capability reaches the read fake');
  assert.equal(store.read().readAttempts['first-use'], true);
  assert.equal(Object.hasOwn(store.read().readAttempts, 'wrong-target'), false);
  assert.equal(Object.hasOwn(store.read().readAttempts, 'expired'), false);
  assert.equal(Object.hasOwn(store.read().readAttempts, 'non-friend'), false);
  assert.ok(events.indexOf('consumed:trusted:42') < events.indexOf('space-read'));
});

test('可信合成好友 capability 消费后才读取，并只返回近期帖子且写入成功审计', async (t) => {
  const { store, now } = await makeStore(t);
  let clockNow = Date.now() - 5000;
  const events = [];
  const capabilityApi = makeTrustedConstructor({ friendIds: [42], clock: () => clockNow, events });
  const capability = await capabilityApi.issue(42);
  assert.ok(capability);

  const proof = capabilityApi.consume(capability, 42);
  events.push(`consumed:${proof.trustedStatus}:42`);
  assert.deepEqual(proof, { trustedStatus: 'trusted', friend: true });
  const result = await simulateOfflineFriendRead(store,
    { id: 'friend-read-1', now, tool: 'read_posts', source: 'requested', target: '42', activeTime: false },
    { friend: proof.friend, author: '42' }, async () => {
      events.push('space-read');
      return [
        { author: '42', id: 'recent-1', time: now - 60_000, content: 'recent synthetic post' },
        { author: '42', id: 'old-1', time: now - 8 * 86400000, content: 'old synthetic post' },
        { author: '84', id: 'other-author', time: now - 60_000, content: 'other synthetic post' },
      ];
    });

  assert.deepEqual(result, {
    allowed: true,
    outcome: 'success',
    posts: [{ author: '42', id: 'recent-1', time: now - 60_000, content: 'recent synthetic post' }],
  });
  assert.ok(events.indexOf('consumed:trusted:42') < events.indexOf('space-read'));
  assert.equal(store.read().readAttempts['friend-read-1'], true);
  assert.equal(store.read().readOutcomes['friend-read-1'], 'success');
  assert.equal(store.read().audit.find((entry) => entry.id === 'read:friend-read-1')?.record.result, 'success');
  assert.equal(store.read().audit.find((entry) => entry.id === 'read:friend-read-1')?.record.target, '42');
});
