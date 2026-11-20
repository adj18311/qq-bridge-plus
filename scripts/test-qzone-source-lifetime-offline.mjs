import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzoneSourceLifetime } from '../src/core/qzone-source-lifetime-offline.mjs';
import { createQzoneOriginLedger, isOriginLedgerConsumption } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneTrustedBindingGate } from '../src/core/qzone-trusted-binding.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

function credential(ledger, sessionId) {
  ledger.registerBridgeRequest({ requestId: 'r', origin: 'qq-inbound' });
  assert.equal(ledger.observeStep({ sessionId, turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'r' } }] }), true);
  assert.equal(ledger.observeToolCall({ sessionId, event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c' } } }), true);
  return ledger.consume({ sessionId, turn: 1, step: 1, callId: 'c' });
}

test('所有者只认可自己账本签发的凭证，即使外部账本复用了相同代际', () => {
  const owner = createQzoneSourceLifetime();
  const owned = credential(owner.getLedger('a'), 'a');
  const rogue = createQzoneOriginLedger({ sessionId: 'a', epoch: owner.sourceEpoch() });
  const forged = credential(rogue, 'a');
  assert.equal(owner.ownsConsumption(owned), true);
  assert.equal(owner.ownsConsumption(forged), false);
  owner.rotate();
  assert.equal(owner.ownsConsumption(owned), false);
  assert.equal(owner.ownsConsumption(forged), false);
  owner.close();
});

test('运行时必须拒绝同代际但不属于指定所有者的来源凭证', async () => {
  const owner = createQzoneSourceLifetime();
  const rogue = createQzoneOriginLedger({ sessionId: 'a', epoch: owner.sourceEpoch() });
  const fakeTicket = credential(rogue, 'a');
  const state = { enabled: true, readAllowed: true, writeAllowed: false, accessPaused: false, writePaused: false,
    tools: { read_posts: true }, reads: 0, writes: 0, audit: [] };
  let calls = 0;
  const runtime = createQzoneRuntime({ store: { read: () => state, update: (f) => f(state) }, botQq: 123,
    sourceEpoch: owner.sourceEpoch(), authorizeSource: (value) => owner.ownsConsumption(value),
    getConnectionEpoch: () => 1, getBridgeSessions: () => rogue, clock: () => 1, mode: 'read-only',
    call: async () => { calls++; throw new Error('must not reach transport'); } });
  assert.equal((await runtime.dispatch('read_posts', { target_uin: 456 },
    { sessionId: 'a', callId: 'c', binding: fakeTicket })).error, 'origin-unverified');
  assert.equal(calls, 0);
  owner.close();
});

test('rotation synchronously revokes consumptions and already minted gate bindings', () => {
  const owner = createQzoneSourceLifetime(); const epoch = owner.sourceEpoch();
  const a = owner.getLedger('a'); const b = owner.getLedger('b');
  const ticket = credential(a, 'a'); const other = credential(b, 'b');
  const gate = createQzoneTrustedBindingGate(); const context = { connectionEpoch: 1, botQq: 123 };
  const binding = gate.mint({ consumption: ticket, ...context, targetQq: 456 });
  assert.equal(ticket.epoch, epoch); assert.equal(gate.verify(binding, context), true);
  const next = owner.rotate();
  assert.notEqual(next, epoch); assert.equal(owner.sourceEpoch(), next);
  assert.equal(isOriginLedgerConsumption(ticket), false); assert.equal(isOriginLedgerConsumption(other), false);
  assert.equal(gate.verify(binding, context), false);
  assert.equal(gate.mint({ consumption: other, ...context, targetQq: 456 }), null);
  a.reconnect(); assert.throws(() => a.registerBridgeRequest({ requestId: 'new', origin: 'qq-inbound' }));
  assert.notEqual(owner.getLedger('a'), a); owner.close();
});

test('离线组合：旋转后旧运行时和旧账本不能派发，新代账本可以', async () => {
  const owner = createQzoneSourceLifetime();
  let state = { enabled: true, readAllowed: true, writeAllowed: false, accessPaused: false, writePaused: false,
    tools: { read_posts: true }, reads: 0, writes: 0, readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-10', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {}, activeStart: 0, activeEnd: 1439, audit: [] };
  const store = { read: () => structuredClone(state), update(fn) { state = fn(structuredClone(state)); return state; } };
  let calls = 0;
  const makeRuntime = (ledger, sourceEpoch) => createQzoneRuntime({ store, botQq: 123, sourceEpoch,
    authorizeSource: (c) => owner.ownsConsumption(c),
    getConnectionEpoch: () => 1, getBridgeSessions: () => ledger, clock: () => Date.parse('2026-11-10T04:00:00Z'),
    mode: 'read-only', call: async (action) => {
      calls++;
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
      if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
      if (action === 'get_qzone_msg_list') return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
      throw new Error('unexpected fake action');
    } });
  const oldLedger = owner.getLedger('a'); const oldTicket = credential(oldLedger, 'a');
  const oldRuntime = makeRuntime(oldLedger, owner.sourceEpoch());
  const epoch = owner.rotate();
  const oldContext = { sessionId: 'a', callId: 'c', binding: oldTicket };
  assert.equal((await oldRuntime.dispatch('read_posts', { target_uin: 456 }, oldContext)).error, 'origin-unverified');
  assert.equal(calls, 0);
  const newLedger = owner.getLedger('a'), newTicket = credential(newLedger, 'a');
  const runtime = makeRuntime(newLedger, epoch);
  assert.equal((await runtime.dispatch('read_posts', { target_uin: 456 },
    { sessionId: 'a', callId: 'c', binding: newTicket })).outcome, 'success');
  assert.ok(calls > 0);
  owner.close();
});

test('close synchronously revokes all credentials, is idempotent and permanently closes owner', () => {
  const owner = createQzoneSourceLifetime(); const ledger = owner.getLedger('a');
  const ticket = credential(ledger, 'a'); owner.close(); owner.close();
  assert.equal(isOriginLedgerConsumption(ticket), false); assert.equal(owner.sourceEpoch(), null);
  assert.throws(() => owner.getLedger('a')); assert.throws(() => owner.rotate());
});

test('instances and repeated rotations get distinct random epochs', () => {
  const owners = Array.from({ length: 40 }, () => createQzoneSourceLifetime());
  const epochs = owners.map((owner) => owner.sourceEpoch());
  for (const owner of owners) { epochs.push(owner.rotate(), owner.rotate()); owner.close(); }
  assert.equal(new Set(epochs).size, epochs.length);
  for (const epoch of epochs) assert.match(epoch, /^[A-Za-z0-9_.:-]{1,128}$/);
});

test('capacity rejects new sessions without disturbing existing sessions or their credentials', () => {
  const owner = createQzoneSourceLifetime({ sessionLimit: 1, trackingLimit: 3 });
  const ledger = owner.getLedger('a'); const ticket = credential(ledger, 'a');
  assert.throws(() => owner.getLedger('b')); assert.equal(owner.getLedger('a'), ledger);
  assert.equal(isOriginLedgerConsumption(ticket), true);
  owner.rotate(); assert.ok(owner.getLedger('b')); owner.close();
});

test('rotation and close complete before queued concurrent work resumes', async () => {
  const owner = createQzoneSourceLifetime(); const old = owner.getLedger('a');
  const ticket = credential(old, 'a');
  const queued = Promise.resolve().then(() => ({ valid: isOriginLedgerConsumption(ticket), ledger: owner.getLedger('a') }));
  const next = owner.rotate(); const result = await queued;
  assert.equal(result.valid, false); assert.notEqual(result.ledger, old); assert.equal(owner.sourceEpoch(), next);
  const newTicket = credential(result.ledger, 'a');
  const afterClose = Promise.resolve().then(() => isOriginLedgerConsumption(newTicket));
  owner.close(); assert.equal(await afterClose, false);
});

test('reject invalid options and session IDs without damaging live ledger', () => {
  for (const options of [null, [], { sessionLimit: 0 }, { sessionLimit: 1.5 }, { sessionLimit: 4097 },
    { trackingLimit: 0 }, { trackingLimit: 4097 }, { sessionLimit: '1' }]) {
    assert.throws(() => createQzoneSourceLifetime(options));
  }
  const owner = createQzoneSourceLifetime(); const ledger = owner.getLedger('a'); const ticket = credential(ledger, 'a');
  for (const id of [null, '', ' ', 'a/b', 'x'.repeat(129), 7, {}]) assert.throws(() => owner.getLedger(id));
  assert.equal(isOriginLedgerConsumption(ticket), true); assert.equal(owner.getLedger('a'), ledger);
  assert.equal(Object.isFrozen(ledger), true); owner.close();
});
