import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

const NOW = Date.parse('2026-11-10T04:00:00Z'); // Beijing noon
async function fixture(t, initial = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-health-'));
  const db = openOfflineStore(join(dir, 'state.db'), {
    enabled: true, accessPaused: true, writePaused: true, pausedAt: NOW - 86400000,
    botQq: '456', selfId: '456', probe: 'waiting', notices: [], audit: [],
    activeStart: 11 * 60, activeEnd: 13 * 60,
    ledger: { day: '2026-11-10', used: { post: 2, comment: 1, like: 1 },
      reservations: { post1: 'post', post2: 'post', comment1: 'comment', like1: 'like' } }, ...initial,
  });
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  const io = { read: 0, update: 0, call: 0, clock: 0, adapter: 0 };
  const epoch = { value: 8 };
  const healthProbe = {
    adminQq: '123', serviceReady: () => true,
    readOwnSpace: async ({ targetQq }) => {
      io.adapter++;
      return { status: 'ok', targetQq, selfQq: '456' };
    },
  };
  const options = {
    store: {
      read() { io.read++; return db.read(); },
      update(fn) { io.update++; return db.update(fn); },
    },
    botQq: 456, sourceEpoch: 'e1', authorizeSource: () => false,
    getConnectionEpoch: () => epoch.value, getBridgeSessions: () => null,
    call: async () => { io.call++; throw Error('unexpected dispatch call'); },
    clock: () => { io.clock++; return NOW; }, mode: 'read-only',
  };
  return { db, io, epoch, healthProbe, options };
}

test('default host probe is unconfigured with zero I/O and unchanged tool status', async t => {
  const f = await fixture(t);
  const before = f.db.read();
  const runtime = createQzoneRuntime(f.options);
  assert.equal(runtime.runHealthProbe?.length, 0, 'zero-argument host method must exist');
  assert.deepEqual(await runtime.runHealthProbe({ healthProbe: f.healthProbe, activeTime: true }),
    { status: 'not_configured' });
  assert.deepEqual(f.io, { read: 0, update: 0, call: 0, clock: 0, adapter: 0 });
  assert.deepEqual(f.db.read(), before);
  // t43: both READ tools are wired; `read_comments` no longer depends on `exceptionReads`.
  assert.deepEqual(runtime.status(), { mode: 'read-only', connected: true, wiredTools: ['read_posts', 'read_comments'] });
});

test('24h active recovery uses the host snapshot once, clears both pauses, and preserves quota', async t => {
  const f = await fixture(t);
  const ledgerBefore = f.db.read().ledger;
  const adapter = f.healthProbe.readOwnSpace;
  f.healthProbe.readOwnSpace = async request => {
    assert.equal(Object.isFrozen(request), true);
    assert.deepEqual(Reflect.ownKeys(request).sort(), ['readOnly', 'signal', 'targetQq']);
    assert.equal(request.targetQq, '123');
    assert.equal(request.readOnly, true);
    assert.ok(request.signal instanceof AbortSignal);
    return adapter(request);
  };
  // Existing store dependencies may expose their methods on a prototype.
  const runtime = createQzoneRuntime({ ...f.options, store: Object.create(f.options.store),
    healthProbe: f.healthProbe });
  f.healthProbe.adminQq = '999';
  f.healthProbe.readOwnSpace = async () => { throw Error('mutated adapter'); };
  f.healthProbe.serviceReady = () => false;
  const result = await runtime.runHealthProbe({ adminQq: '999', readOwnSpace: () => null, activeTime: true });
  assert.equal(result.status, 'recovered');
  const state = f.db.read();
  assert.equal(state.accessPaused, false);
  assert.equal(state.writePaused, false);
  assert.deepEqual(state.ledger, ledgerBefore);
  assert.deepEqual(state.audit.map(x => [x.record.target, x.record.result]),
    [['123', 'unknown'], ['123', 'success']]);
  assert.equal((await runtime.runHealthProbe()).status, 'not_eligible');
  assert.equal(f.io.adapter, 1);
  assert.equal(f.io.call, 0);
});

test('disabled, disconnected, inactive, and unready probes never consume the claim', async t => {
  for (const condition of ['disabled', 'disconnected', 'inactive', 'unready', 'unready_async']) {
    const f = await fixture(t);
    if (condition === 'inactive') f.db.update(s => ({ ...s, activeStart: 0, activeEnd: 60 }));
    if (condition === 'unready') f.healthProbe.serviceReady = () => false;
    if (condition === 'unready_async') f.healthProbe.serviceReady = async () => { throw Error('unready'); };
    const runtime = createQzoneRuntime({ ...f.options,
      mode: condition === 'disabled' ? 'disabled' : 'read-only', healthProbe: f.healthProbe });
    if (condition === 'disconnected') f.epoch.value = -1;
    const before = f.db.read();
    assert.deepEqual(await runtime.runHealthProbe({ activeTime: true, serviceReady: () => true }),
      { status: 'not_eligible' }, condition);
    assert.equal(f.io.adapter, 0, condition);
    assert.equal(f.io.call, 0, condition);
    assert.equal(f.io.update, 0, condition);
    assert.deepEqual(f.db.read(), before, condition);
  }
});

test('epoch drift before send or during the adapter prevents recovery and latches invalidation', async t => {
  for (const phase of ['before_send', 'in_flight']) {
    const f = await fixture(t);
    let entered, release;
    const entry = new Promise(resolve => { entered = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    f.healthProbe.readOwnSpace = async ({ targetQq }) => {
      f.io.adapter++;
      entered();
      await barrier;
      return { status: 'ok', targetQq, selfQq: '456' };
    };
    const runtime = createQzoneRuntime({ ...f.options, healthProbe: f.healthProbe });
    const pending = runtime.runHealthProbe();
    if (phase === 'in_flight') await entry;
    f.epoch.value++;
    release();
    assert.equal((await pending).status, 'unknown', phase);
    const state = f.db.read();
    assert.equal(state.accessPaused, true, phase);
    assert.equal(state.writePaused, true, phase);
    assert.equal(f.io.adapter, phase === 'in_flight' ? 1 : 0, phase);
    assert.equal(state.probe, phase === 'in_flight' ? 'manual_only' : 'waiting', phase);
    f.epoch.value = 8;
    assert.deepEqual(await runtime.runHealthProbe(), { status: 'not_eligible' }, phase);
    assert.equal(f.io.call, 0);
  }
});

test('completion-clock epoch drift rolls back recovery and leaves the claim without automatic retry', async t => {
  const f = await fixture(t);
  let returned = false;
  let changed = false;
  f.healthProbe.readOwnSpace = async ({ targetQq }) => {
    f.io.adapter++;
    returned = true;
    return { status: 'ok', targetQq, selfQq: '456' };
  };
  f.options.clock = () => {
    f.io.clock++;
    if (returned && !changed) { changed = true; f.epoch.value++; }
    return NOW;
  };
  const runtime = createQzoneRuntime({ ...f.options, healthProbe: f.healthProbe });
  assert.deepEqual(await runtime.runHealthProbe(), { status: 'finish_failed' });
  assert.equal(f.epoch.value, 9);
  const state = f.db.read();
  assert.equal(state.accessPaused, true);
  assert.equal(state.writePaused, true);
  assert.equal(state.probe, 'claimed');
  assert.deepEqual(state.audit.map(x => x.record.result), ['unknown']);
  assert.deepEqual(await runtime.runHealthProbe(), { status: 'not_eligible' });
  const nextRuntime = createQzoneRuntime({ ...f.options, healthProbe: f.healthProbe });
  assert.deepEqual(await nextRuntime.runHealthProbe(), { status: 'not_eligible' });
  assert.equal(f.io.adapter, 1);
  assert.deepEqual(f.db.read(), state);
});

test('host adapter identity is neither filled in nor replaced with the runtime bot identity', async t => {
  for (const selfQq of [undefined, '999']) {
    const f = await fixture(t);
    f.healthProbe.readOwnSpace = async ({ targetQq }) => ({ status: 'ok', targetQq, selfQq });
    const runtime = createQzoneRuntime({ ...f.options, healthProbe: f.healthProbe });
    assert.equal((await runtime.runHealthProbe()).status, selfQq === undefined ? 'unknown' : 'failed');
    assert.equal(f.db.read().accessPaused, true);
    assert.equal(f.db.read().writePaused, true);
  }
});

test('host configuration rejects accessors, wrong types, and unknown dependency keys without reads', async t => {
  const f = await fixture(t);
  let getterCalls = 0;
  const accessor = { ...f.healthProbe };
  Object.defineProperty(accessor, 'adminQq', { get() { getterCalls++; return '123'; } });
  const bad = [null, [], new Date(), {}, accessor,
    { ...f.healthProbe, adminQq: '0123' }, { ...f.healthProbe, adminQq: 123 },
    { ...f.healthProbe, readOwnSpace: true }, { ...f.healthProbe, serviceReady: true },
    { ...f.healthProbe, activeTime: true }, { ...f.healthProbe, [Symbol('extra')]: true }];
  for (const healthProbe of bad) {
    assert.throws(() => createQzoneRuntime({ ...f.options, healthProbe }), TypeError);
  }
  const options = { ...f.options };
  Object.defineProperty(options, 'healthProbe', { get() { getterCalls++; return f.healthProbe; } });
  assert.throws(() => createQzoneRuntime(options), TypeError);
  assert.equal(getterCalls, 0);
  assert.deepEqual(f.io, { read: 0, update: 0, call: 0, clock: 0, adapter: 0 });
});
