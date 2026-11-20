import assert from 'node:assert/strict';
import { verifyOfflineQzoneFriend } from '../src/core/qzone-friend-proof-offline.mjs';

const trusted = (data, targetQq = 42) => verifyOfflineQzoneFriend({
  trustedCurrentRead: true,
  targetQq,
  envelope: { status: 'ok', retcode: 0, data }
});

assert.deepEqual(trusted([{ user_id: 42 }, { user_id: 84 }]), {
  trustedStatus: 'trusted', friend: true
});
assert.deepEqual(trusted([{ user_id: 84 }]), {
  trustedStatus: 'trusted', friend: false
});
assert.deepEqual(trusted([], 42), {
  trustedStatus: 'trusted', friend: false
});

const unknown = { trustedStatus: 'unknown', friend: false };
for (const input of [
  undefined,
  { targetQq: 42, envelope: { status: 'ok', retcode: 0, data: [] } },
  { trustedCurrentRead: false, targetQq: 42, envelope: { status: 'ok', retcode: 0, data: [] } },
  { trustedCurrentRead: true, envelope: { status: 'ok', retcode: 0, data: [] } },
  { trustedCurrentRead: true, targetQq: 42 },
  { trustedCurrentRead: true, targetQq: 42, envelope: { retcode: 0, data: [] } },
  { trustedCurrentRead: true, targetQq: 42, envelope: { status: 'ok', data: [] } },
  { trustedCurrentRead: true, targetQq: 42, envelope: { status: 'failed', retcode: 100, data: null } },
  { trustedCurrentRead: true, targetQq: 42, envelope: { status: 'ok', retcode: '0', data: [] } },
  { trustedCurrentRead: true, targetQq: 42, envelope: { status: 'ok', retcode: 1, data: [] } },
  { trustedCurrentRead: true, targetQq: 42, envelope: { status: 'ok', retcode: 0 } },
  { trustedCurrentRead: true, targetQq: 42, envelope: { status: 'ok', retcode: 0, data: {} } },
  { trustedCurrentRead: true, targetQq: 42, envelope: { status: 'ok', retcode: 0, data: [{ user_id: 42 }, {}] } },
  ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '42', null].map((user_id) => ({
    trustedCurrentRead: true, targetQq: 42,
    envelope: { status: 'ok', retcode: 0, data: [{ user_id }] }
  })),
  ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '42', null].map((targetQq) => ({
    trustedCurrentRead: true, targetQq,
    envelope: { status: 'ok', retcode: 0, data: [] }
  }))
]) {
  assert.deepEqual(verifyOfflineQzoneFriend(input), unknown);
}

assert.deepEqual(verifyOfflineQzoneFriend({
  trustedCurrentRead: true,
  targetQq: 42,
  envelope: { status: 'ok', retcode: 0, data: [] },
  unverifiedModelClaim: true
}), unknown);

let getterCalled = false;
const unsafeEnvelope = Object.defineProperty({ retcode: 0, data: [] }, 'status', {
  get() {
    getterCalled = true;
    return 'ok';
  }
});
assert.deepEqual(verifyOfflineQzoneFriend({
  trustedCurrentRead: true, targetQq: 42, envelope: unsafeEnvelope
}), unknown);
assert.equal(getterCalled, false);

const accessorFriend = Object.defineProperty({}, 'user_id', {
  get() {
    getterCalled = true;
    return 42;
  }
});
assert.deepEqual(trusted([accessorFriend]), unknown);
assert.equal(getterCalled, false);

const sparseList = new Array(1);
assert.deepEqual(trusted(sparseList), unknown);

const throwingProxy = new Proxy({}, {
  getPrototypeOf() {
    throw new Error('synthetic proxy trap');
  }
});
assert.deepEqual(verifyOfflineQzoneFriend(throwingProxy), unknown);

assert.deepEqual(Object.keys(trusted([{ user_id: 42 }])).sort(), ['friend', 'trustedStatus']);
assert.deepEqual(verifyOfflineQzoneFriend({
  trustedCurrentRead: true,
  targetQq: 42,
  envelope: { status: 'ok', retcode: 0, data: [{ user_id: 42, nickname: 'synthetic' }] }
}), { trustedStatus: 'trusted', friend: true });

console.log('qzone-friend-proof-offline: all assertions passed');
