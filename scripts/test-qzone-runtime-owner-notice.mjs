import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-owner-notice-'));
  const db = openOfflineStore(join(dir, 'state.db'), { notices: [{
    layer: 'write', cause: 'failure', operationId: 'op-1',
    message: 'untrusted-notice-text', content: 'untrusted-content', recipient: '999',
  }] });
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  const io = { read: 0, update: 0, clock: 0, call: 0, sender: 0 };
  const epoch = { value: 8 };
  const options = {
    store: {
      read() { io.read++; return db.read(); },
      update(fn) { io.update++; return db.update(fn); },
    },
    botQq: 456, sourceEpoch: 'e1', authorizeSource: () => false,
    getConnectionEpoch: () => epoch.value, getBridgeSessions: () => null,
    clock: () => { io.clock++; return 1000; }, mode: 'read-only',
    call: async () => { io.call++; throw Error('unexpected dispatch call'); },
  };
  return { db, io, epoch, options };
}

test('owner notice defaults to unconfigured with zero I/O; invalid host senders are rejected', async t => {
  const f = await fixture(t);
  const before = f.db.read();
  const runtime = createQzoneRuntime(f.options);
  assert.equal(typeof runtime.dispatchOwnerNotice, 'function', 'host notice method must exist');
  assert.deepEqual(await runtime.dispatchOwnerNotice(0), { status: 'not_configured' });
  for (const sendOwnerReceipt of [null, true, {}]) {
    assert.throws(() => createQzoneRuntime({ ...f.options, sendOwnerReceipt }), TypeError);
  }
  assert.deepEqual(f.io, { read: 0, update: 0, clock: 0, call: 0, sender: 0 });
  assert.deepEqual(f.db.read(), before);
  // t43: both READ tools are wired; `read_comments` no longer depends on `exceptionReads`.
  assert.deepEqual(runtime.status(), { mode: 'read-only', connected: true, wiredTools: ['read_posts', 'read_comments'] });
});

test('fixed allowlisted message uses a snapshotted host owner sender and delivered receipt exactly once', async t => {
  const f = await fixture(t);
  const ownerQq = '123';
  const sent = [];
  f.options.sendOwnerReceipt = async (...args) => {
    f.io.sender++;
    assert.equal(args.length, 1);
    assert.equal(f.db.read().notices[0].delivery, 'claimed');
    sent.push({ ownerQq, message: args[0] });
    return { outcome: 'delivered', messageId: '-123' };
  };
  const runtime = createQzoneRuntime(f.options);
  f.options.sendOwnerReceipt = async () => { throw Error('replaced host dependency'); };
  for (const index of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0', {
    index: 0, recipient: '999', message: 'override', token: 'caller-token', recovery: true, ownership: true,
  }]) {
    await assert.rejects(runtime.dispatchOwnerNotice(index), TypeError);
  }
  await assert.rejects(runtime.dispatchOwnerNotice(0, { recipient: '999', content: 'override' }), TypeError);
  assert.equal(f.io.read, 0);
  assert.equal(f.io.update, 0);
  assert.deepEqual(await runtime.dispatchOwnerNotice(0), { status: 'sent' });
  assert.deepEqual(sent, [{ ownerQq: '123',
    message: 'QQ空间写入连续失败，写入已暂停。请管理员检查状态并手动处理。' }]);
  const notice = f.db.read().notices[0];
  assert.equal(notice.delivery, 'sent');
  assert.match(notice.claimToken, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(await runtime.dispatchOwnerNotice(0), { status: 'not_claimed' });
  assert.equal(f.io.sender, 1);
  assert.equal(f.io.clock, 0);
  assert.equal(f.io.call, 0);
});

test('generic failed, thrown, and Boolean receipts seal unknown and cannot be resent', async t => {
  for (const receipt of [async () => ({ outcome: 'failed' }),
    async () => { throw Error('sensitive sender text'); }, async () => true]) {
    const f = await fixture(t);
    const runtime = createQzoneRuntime({ ...f.options, sendOwnerReceipt: async message => {
      f.io.sender++;
      return receipt(message);
    } });
    assert.deepEqual(await runtime.dispatchOwnerNotice(0), { status: 'unknown' });
    assert.equal(f.db.read().notices[0].delivery, 'unknown');
    assert.deepEqual(await runtime.dispatchOwnerNotice(0), { status: 'not_claimed' });
    assert.equal(f.io.sender, 1);
  }
});

test('disabled and invalid epochs prevent owner sending without consuming a claim', async t => {
  for (const condition of ['disabled', 'disconnected', 'changed']) {
    const f = await fixture(t);
    const runtime = createQzoneRuntime({ ...f.options,
      mode: condition === 'disabled' ? 'disabled' : 'read-only',
      sendOwnerReceipt: async () => { f.io.sender++; return { outcome: 'delivered', messageId: '1' }; },
    });
    if (condition === 'disconnected') f.epoch.value = -1;
    if (condition === 'changed') f.epoch.value++;
    const before = f.db.read();
    assert.deepEqual(await runtime.dispatchOwnerNotice(0), { status: 'not_eligible' }, condition);
    assert.deepEqual(f.io, { read: 0, update: 0, clock: 0, call: 0, sender: 0 }, condition);
    assert.deepEqual(f.db.read(), before, condition);
  }
});

test('epoch drift before sender entry or during delivery seals unknown even after delivered receipt', async t => {
  for (const phase of ['before_send', 'in_flight']) {
    const f = await fixture(t);
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const sendOwnerReceipt = async () => {
      f.io.sender++;
      enter();
      await barrier;
      return { outcome: 'delivered', messageId: '1' };
    };
    const runtime = createQzoneRuntime({ ...f.options, sendOwnerReceipt });
    const pending = runtime.dispatchOwnerNotice(0);
    if (phase === 'in_flight') await entered;
    f.epoch.value++;
    release();
    assert.deepEqual(await pending, { status: 'unknown' }, phase);
    assert.equal(f.db.read().notices[0].delivery, 'unknown', phase);
    assert.equal(f.io.sender, phase === 'in_flight' ? 1 : 0, phase);
    // A fresh runtime can inspect the sealed record but cannot reopen delivery.
    const next = createQzoneRuntime({ ...f.options, sendOwnerReceipt });
    assert.deepEqual(await next.dispatchOwnerNotice(0), { status: 'not_claimed' }, phase);
    assert.equal(f.io.sender, phase === 'in_flight' ? 1 : 0, phase);
  }
});
