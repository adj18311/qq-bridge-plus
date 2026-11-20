import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createQzoneAccountIdentityGuard } from '../src/core/qzone-account-identity-offline.mjs';

class FakeClient extends EventEmitter {
  calls = 0;
  replies = [];
  getLoginInfo() { this.calls++; return this.replies.shift()(); }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const bot = new FakeClient();
  let epoch = -1;
  const guard = createQzoneAccountIdentityGuard({ client: bot, getEpoch: () => epoch, expectedUserId: 123 });
  return { bot, guard, open(n = 1) { epoch = n; bot.emit('open'); }, setEpoch(n) { epoch = n; },
    reply(value) { bot.replies.push(() => Promise.resolve(value)); } };
}

test('explicit verification binds only after open, without connecting', async () => {
  const f = fixture(); f.reply({ user_id: 123 });
  assert.equal(await f.guard.verify(), false); assert.equal(f.bot.calls, 0);
  f.open(); assert.equal(f.guard.isVerified(), false);
  assert.equal(await f.guard.verify(), true); assert.equal(f.guard.isVerified(), true);
  assert.equal(f.guard.accountId(), 123); f.guard.close();
});

test('identity and epoch must be valid and match expected identity', async () => {
  for (const id of [0, -1, '123', 123.1, Number.MAX_SAFE_INTEGER + 1, null, 456]) {
    const f = fixture(); f.open(); f.reply({ user_id: id });
    assert.equal(await f.guard.verify(), false); assert.equal(f.guard.isVerified(), false); f.guard.close();
  }
  const f = fixture(); f.open(-1); f.reply({ user_id: 123 });
  assert.equal(await f.guard.verify(), false); assert.equal(f.bot.calls, 0); f.guard.close();
  assert.throws(() => createQzoneAccountIdentityGuard({ client: f.bot, getEpoch: () => 1, expectedUserId: '123' }));
});

test('close and error invalidate, and epoch change is checked on access', async () => {
  for (const event of ['close', 'error']) {
    const f = fixture(); f.open(); f.reply({ user_id: 123 }); await f.guard.verify();
    f.bot.emit(event, new Error('fixture')); assert.equal(f.guard.isVerified(), false); f.guard.close();
  }
  const f = fixture(); f.open(); f.reply({ user_id: 123 }); await f.guard.verify();
  f.setEpoch(2); assert.equal(f.guard.isVerified(), false); assert.equal(f.guard.accountId(), null); f.guard.close();
});

test('conflicting events and bot status invalidate even during a pending check', async () => {
  for (const event of [
    { post_type: 'message', self_id: 456 },
    { post_type: 'notice', notice_type: 'bot_status', sub_type: 'online', self_id: 123, user_id: 456 },
    { post_type: 'notice', notice_type: 'bot_status', sub_type: 'offline', self_id: 123, user_id: 123 },
    { post_type: 'meta_event', self_id: '123' },
  ]) {
    const f = fixture(); f.open(); const pending = deferred(); f.bot.replies.push(() => pending.promise);
    const result = f.guard.verify(); f.bot.emit('event', event); pending.resolve({ user_id: 123 });
    assert.equal(await result, false); assert.equal(f.guard.isVerified(), false);
    f.reply({ user_id: 123 }); assert.equal(await f.guard.verify(), false); f.guard.close();
  }
});

test('manual event observation can guard before SDK middleware dispatch', async () => {
  const f = fixture(); f.open(); f.reply({ user_id: 123 }); await f.guard.verify();
  assert.equal(f.guard.observeEvent({ post_type: 'message', self_id: 123 }), true);
  assert.equal(f.guard.observeEvent({ post_type: 'message', self_id: 456 }), false);
  assert.equal(f.guard.isVerified(), false); f.guard.close();
});

test('missing self_id on an incoming message revokes the account binding', async () => {
  const f = fixture(); f.open(); f.reply({ user_id: 123 }); await f.guard.verify();
  assert.equal(f.guard.observeEvent({ post_type: 'message' }), false);
  assert.equal(f.guard.isVerified(), false);
  f.guard.close();
});

test('late success or failure from old generation cannot override new binding', async () => {
  for (const fail of [false, true]) {
    const f = fixture(); f.open(1); const pending = deferred(); f.bot.replies.push(() => pending.promise);
    const old = f.guard.verify(); f.bot.emit('close'); f.open(2); f.reply({ user_id: 123 });
    assert.equal(await f.guard.verify(), true);
    if (fail) pending.reject(new Error('old')); else pending.resolve({ user_id: 456 });
    assert.equal(await old, false); assert.equal(f.guard.isVerified(), true); f.guard.close();
  }
});

test('revalidation fails closed and overlapping requests cannot restore stale state', async () => {
  const f = fixture(); f.open(); f.reply({ user_id: 123 }); await f.guard.verify();
  const pending = deferred(); f.bot.replies.push(() => pending.promise);
  const old = f.guard.verify(); assert.equal(f.guard.isVerified(), false);
  f.bot.replies.push(() => Promise.reject(new Error('fixture')));
  assert.equal(await f.guard.verify(), false); pending.resolve({ user_id: 123 });
  assert.equal(await old, false); assert.equal(f.guard.isVerified(), false); f.guard.close();
});

test('epoch change during query and throwing getter fail closed', async () => {
  const f = fixture(); f.open(); const pending = deferred(); f.bot.replies.push(() => pending.promise);
  const result = f.guard.verify(); f.setEpoch(2); pending.resolve({ user_id: 123 });
  assert.equal(await result, false); assert.equal(f.guard.isVerified(), false); f.guard.close();
  const bot = new FakeClient(); bot.on('error', () => {});
  const guard = createQzoneAccountIdentityGuard({ client: bot, expectedUserId: 123, getEpoch() { throw new Error('fixture'); } });
  bot.emit('open'); assert.equal(await guard.verify(), false); assert.equal(guard.isVerified(), false); guard.close();
});

test('dispose removes listeners and pending result cannot bind', async () => {
  const f = fixture(); f.open(); const pending = deferred(); f.bot.replies.push(() => pending.promise);
  const result = f.guard.verify(); f.guard.close(); pending.resolve({ user_id: 123 });
  assert.equal(await result, false); assert.equal(f.guard.isVerified(), false);
  assert.equal(f.bot.listenerCount('open'), 0); assert.equal(f.bot.listenerCount('event'), 0);
});
