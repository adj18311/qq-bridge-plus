import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { initializeReplayState } from '../src/core/qzone-replay-claim-offline.mjs';
import { createQzoneOriginLedger, isOriginLedgerConsumption } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneOperationAuthorizer } from '../src/core/qzone-operation-authorization-offline.mjs';

// Real temporary SQLite store + real origin ledger + real B2 replay claimer.
// Only the external host policy (approveOperation / isCurrent) is a fixture: no new issuer,
// no fake reader, no fake consumption is fabricated anywhere in this file.
const NOW = Date.parse('2026-11-15T04:00:00Z');
const APPROVAL_WINDOW_MS = 30000;
const INPUT = Object.freeze({ target_uin: 456 });
const initialState = () => ({ enabled: true, accessPaused: false, writePaused: false, reads: 0, writes: 0, audit: [] });

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-operation-auth-'));
  const store = openOfflineStore(path.join(dir, 'state.db'), initialState());
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  if (options.initialize !== false) {
    const installed = initializeReplayState(store, { now: NOW });
    assert.equal(installed.ok, true);
    assert.equal(installed.created, true);
  }
  const live = { now: NOW, current: true };
  const build = (overrides = {}) => createQzoneOperationAuthorizer({
    store,
    accountId: 123,
    sourceEpoch: 'e1',
    clock: () => live.now,
    approveOperation: () => true,
    isCurrent: () => live.current,
    ...overrides,
  });
  // A real ledger consumption. A fresh ledger per consumption: `consume()` retires a callId,
  // so one ledger cannot produce two consumptions and pretending otherwise would be a
  // fixture that does not exist in production.
  function makeConsumption(callId = 'c1') {
    const ledger = createQzoneOriginLedger({ sessionId: 's1', epoch: 'e1' });
    ledger.registerBridgeRequest({ requestId: 'request-1', origin: 'qq-inbound' });
    assert.equal(ledger.observeStep({
      sessionId: 's1', turn: 1, step: 1,
      messages: [{ role: 'user', source: { rpcId: 'request-1' } }],
    }), true);
    assert.equal(ledger.observeToolCall({
      sessionId: 's1', event: { type: 'tool/call', data: { turn: 1, step: 1, callId } },
    }), true);
    const consumption = ledger.consume({ sessionId: 's1', callId, turn: 1, step: 1 });
    assert.equal(isOriginLedgerConsumption(consumption), true);
    return { ledger, consumption };
  }
  const expected = (consumption, extra = {}) => ({
    action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0, ...extra,
  });
  const claimedKeys = () => Object.keys(store.read().usedReadKeys ?? {});
  return { dir, store, live, build, makeConsumption, expected, claimedKeys };
}

test('prepare mints a frozen operation that verify accepts and claim commits once', async t => {
  const f = fixture(t);
  const { consumption } = f.makeConsumption();
  const authorizer = f.build();
  const ticket = await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0 });

  assert.ok(ticket);
  assert.ok(Object.isFrozen(ticket));
  assert.deepEqual(Object.keys(ticket), ['operation']);
  const { operation } = ticket;
  assert.ok(Object.isFrozen(operation));
  assert.ok(Object.isFrozen(operation.input));
  assert.equal(operation.accountId, 123);
  assert.equal(operation.sessionId, 's1');
  assert.equal(operation.requestId, 'request-1');
  assert.equal(operation.callId, 'c1');
  assert.equal(operation.sourceEpoch, 'e1');
  assert.equal(operation.connectionEpoch, 0);
  assert.equal(operation.origin, 'qq-inbound');
  assert.equal(operation.action, 'read_posts');
  assert.deepEqual(operation.input, { target_uin: 456 });
  assert.match(operation.inputDigest, /^[0-9a-f]{64}$/);
  assert.match(operation.authorizationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(operation.expiresAt, NOW + APPROVAL_WINDOW_MS);

  // A logical read re-checks the same operation before every deterministic platform request.
  assert.equal(authorizer.verify(ticket, f.expected(consumption)), true);
  assert.equal(authorizer.verify(ticket, f.expected(consumption)), true);
  assert.deepEqual(f.claimedKeys(), []);

  const claimed = authorizer.claim(ticket, f.expected(consumption));
  assert.equal(claimed.ok, true);
  assert.ok(Object.isFrozen(claimed));
  assert.deepEqual(f.claimedKeys(), ['[123,"s1","request-1","c1"]']);
  // The same ticket stays valid and does not consume a second time.
  assert.equal(authorizer.verify(ticket, f.expected(consumption)), true);
  assert.equal(authorizer.claim(ticket, f.expected(consumption)).ok, true);
  assert.equal(f.claimedKeys().length, 1);

  authorizer.finish(ticket);
  assert.equal(authorizer.verify(ticket, f.expected(consumption)), false);
  assert.equal(authorizer.claim(ticket, f.expected(consumption)).ok, false);
  // finish() is not an undo: the B2 claim stays committed.
  assert.equal(f.claimedKeys().length, 1);
});

test('a promise resolving to strict true approves; nothing else does', async t => {
  const f = fixture(t);
  const { consumption } = f.makeConsumption();
  const authorizer = f.build({ approveOperation: () => Promise.resolve(true) });
  const ticket = await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0 });
  assert.ok(ticket);
  assert.equal(authorizer.verify(ticket, f.expected(consumption)), true);
});

test('every non-strict-true approval fails closed to null', async t => {
  const f = fixture(t);
  const variants = [
    ['number 1', () => 1],
    ['string "true"', () => 'true'],
    ['undefined', () => undefined],
    ['null', () => null],
    ['object', () => ({ approved: true })],
    ['resolved false', () => Promise.resolve(false)],
    ['thenable resolving to 1', () => ({ then(resolve) { resolve(1); } })],
    ['synchronous throw', () => { throw new Error('host refusal detail'); }],
    ['rejected promise', () => Promise.reject(new Error('host rejection detail'))],
  ];
  for (const [name, approveOperation] of variants) {
    const { consumption } = f.makeConsumption();
    const authorizer = f.build({ approveOperation });
    assert.equal(await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0 }), null, name);
  }
  // A refusal never writes a claim and is never retried into an approval.
  assert.deepEqual(f.claimedKeys(), []);
});

test('verify binds action, full canonical input, identity and both epochs; a claimed input cannot be swapped', async t => {
  const f = fixture(t);
  const { consumption } = f.makeConsumption('c1');
  const other = f.makeConsumption('c2');
  const authorizer = f.build();
  const ticket = await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0 });
  assert.ok(ticket);

  assert.equal(authorizer.verify(ticket, f.expected(consumption, { action: 'read_comments' })), false);
  assert.equal(authorizer.verify(ticket, f.expected(consumption, { input: { target_uin: 777 } })), false);
  assert.equal(authorizer.verify(ticket, f.expected(consumption, { input: { target_uin: 456, num: 20 } })), false);
  assert.equal(authorizer.verify(ticket, f.expected(consumption, { connectionEpoch: 1 })), false);
  assert.equal(authorizer.verify(ticket, f.expected(consumption, { connectionEpoch: -1 })), false);
  assert.equal(authorizer.verify(ticket, f.expected(consumption, { connectionEpoch: '0' })), false);
  // A different genuine consumption cannot borrow this ticket, even for the same action.
  assert.equal(authorizer.verify(ticket, f.expected(other.consumption)), false);
  // Shapes that would be rejected before reaching a real decision must not throw.
  assert.equal(authorizer.verify(ticket, undefined), false);
  assert.equal(authorizer.verify(ticket, null), false);
  assert.equal(authorizer.verify(ticket, { action: 'read_posts' }), false);
  assert.equal(authorizer.verify(null, f.expected(consumption)), false);
  assert.equal(authorizer.verify(undefined, f.expected(consumption)), false);

  // A refused claim writes nothing and the operation is never rewritten from the new input.
  assert.equal(authorizer.claim(ticket, f.expected(consumption, { input: { target_uin: 777 } })).ok, false);
  assert.deepEqual(f.claimedKeys(), []);
  assert.deepEqual(ticket.operation.input, { target_uin: 456 });
  assert.equal(ticket.operation.action, 'read_posts');

  assert.equal(authorizer.claim(ticket, f.expected(consumption)).ok, true);
  assert.equal(authorizer.claim(ticket, f.expected(consumption, { input: { target_uin: 777 } })).ok, false);
  assert.deepEqual(f.claimedKeys(), ['[123,"s1","request-1","c1"]']);
});

test('a second ticket and a second authorizer for the same tuple are refused by B2', async t => {
  const f = fixture(t);
  const { consumption } = f.makeConsumption();
  const authorizer = f.build();
  const first = await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0 });
  const second = await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0 });
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first, second);

  assert.equal(authorizer.claim(first, f.expected(consumption)).ok, true);
  const replay = authorizer.claim(second, f.expected(consumption));
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'replay');
  assert.equal(f.claimedKeys().length, 1);

  // Another instance over the same store cannot reopen the same (account, session, request, call).
  const fresh = f.build();
  const third = await fresh.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0 });
  assert.ok(third);
  assert.equal(fresh.claim(third, f.expected(consumption)).ok, false);
  assert.equal(f.claimedKeys().length, 1);
});

test('isCurrent gates prepare and verify; false, a throw and a thenable all fail closed', async t => {
  const f = fixture(t);
  const { consumption } = f.makeConsumption();
  const request = { action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0 };

  assert.equal(await f.build({ isCurrent: () => false }).prepare(request), null);
  assert.equal(await f.build({ isCurrent: () => { throw new Error('host state unavailable'); } }).prepare(request), null);
  assert.equal(await f.build({ isCurrent: () => Promise.resolve(true) }).prepare(request), null);
  assert.equal(await f.build({ isCurrent: () => ({ then(resolve) { resolve(true); } }) }).prepare(request), null);
  assert.deepEqual(f.claimedKeys(), []);

  // A source revoked DURING approval must not produce a ticket.
  const flipping = f.build({ approveOperation: () => { f.live.current = false; return true; } });
  assert.equal(await flipping.prepare(request), null);

  // A source revoked after prepare must invalidate both verify and claim.
  f.live.current = true;
  const authorizer = f.build();
  const ticket = await authorizer.prepare(request);
  assert.ok(ticket);
  f.live.current = false;
  assert.equal(authorizer.verify(ticket, f.expected(consumption)), false);
  assert.equal(authorizer.claim(ticket, f.expected(consumption)).ok, false);
  assert.deepEqual(f.claimedKeys(), []);

  // And it recovers for nothing: the ticket was never claimed, but a new one is a new decision.
  f.live.current = true;
  assert.equal(authorizer.verify(ticket, f.expected(consumption)), true);
});

test('a store failure during claim propagates and never authorizes', async t => {
  const f = fixture(t);
  const { consumption } = f.makeConsumption();
  const broken = {
    read: () => f.store.read(),
    update() { throw new Error('private store failure'); },
  };
  const authorizer = f.build({ store: broken });
  const ticket = await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0 });
  assert.ok(ticket);
  assert.equal(authorizer.verify(ticket, f.expected(consumption)), true);
  assert.throws(() => authorizer.claim(ticket, f.expected(consumption)), /private store failure/);
  // Nothing was written, and a failed transaction is not retried or remembered as claimed.
  assert.deepEqual(f.claimedKeys(), []);
  assert.throws(() => authorizer.claim(ticket, f.expected(consumption)), /private store failure/);
});

test('the canonical snapshot refuses accessors, non-plain objects, cycles, undefined and non-finite numbers', async t => {
  const f = fixture(t);
  const { consumption } = f.makeConsumption();
  const authorizer = f.build();

  const cyclic = { target_uin: 456 };
  cyclic.pos = cyclic;
  const withAccessor = { target_uin: 456 };
  Object.defineProperty(withAccessor, 'num', { get() { return 20; }, enumerable: true });
  const subclassed = new (class Input { constructor() { this.target_uin = 456; } })();
  // An array with a non-index own property: `JSON.stringify` would silently drop it, so the
  // approval would be bound to a different operation than the one that gets executed.
  const arrayExtraKey = { content: 'hello', ugc_right: 16, target_uins: [456] };
  arrayExtraKey.target_uins.extra = 1;
  const sparse = { content: 'hello', ugc_right: 16, target_uins: [, 456] };

  const cases = [
    ['accessor field', 'read_posts', withAccessor],
    ['non-plain prototype', 'read_posts', subclassed],
    ['cycle', 'read_posts', cyclic],
    ['undefined value (validation would default it away)', 'read_posts', { target_uin: 456, num: undefined }],
    ['Infinity', 'read_posts', { target_uin: 456, pos: Infinity }],
    ['NaN', 'read_posts', { target_uin: 456, num: NaN }],
    ['array extra key', 'publish', arrayExtraKey],
    ['sparse array', 'publish', sparse],
    ['function value', 'read_posts', { target_uin: 456, pos: () => 0 }],
  ];
  for (const [name, action, input] of cases) {
    assert.equal(await authorizer.prepare({ action, input, consumption, connectionEpoch: 0 }), null, name);
  }
  assert.deepEqual(f.claimedKeys(), []);

  // The same strictness applies to the input supplied to verify: no canonical snapshot, no
  // acceptance — an approval bound to one snapshot cannot be widened by a later shape.
  const ticket = await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0 });
  assert.ok(ticket);
  for (const [, , input] of cases) {
    assert.equal(authorizer.verify(ticket, f.expected(consumption, { input })), false);
  }
});

test('the canonical snapshot is key-order independent and immune to later caller mutation', async t => {
  const f = fixture(t);
  const { consumption } = f.makeConsumption();
  const authorizer = f.build();

  const input = { target_uin: 456, num: 20 };
  const ticket = await authorizer.prepare({ action: 'read_posts', input, consumption, connectionEpoch: 0 });
  assert.ok(ticket);
  // Insertion order is not part of the operation: sorted keys are.
  assert.equal(authorizer.verify(ticket, f.expected(consumption, { input: { num: 20, target_uin: 456 } })), true);

  // The frozen snapshot is the approved operation; mutating the caller's object afterwards
  // cannot change what was approved, and the mutated shape no longer verifies.
  input.target_uin = 777;
  assert.equal(ticket.operation.input.target_uin, 456);
  assert.equal(authorizer.verify(ticket, f.expected(consumption, { input })), false);
  assert.equal(authorizer.verify(ticket, f.expected(consumption, { input: { target_uin: 456, num: 20 } })), true);
});

test('an uninitialized replay store refuses the claim and is never auto-initialized', async t => {
  const f = fixture(t, { initialize: false });
  const { consumption } = f.makeConsumption();
  const authorizer = f.build();
  const ticket = await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0 });
  assert.ok(ticket);
  assert.equal(authorizer.verify(ticket, f.expected(consumption)), true);

  const outcome = authorizer.claim(ticket, f.expected(consumption));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'uninitialized');
  const state = f.store.read();
  assert.equal(Object.hasOwn(state, 'usedReadKeys'), false);
  assert.equal(Object.hasOwn(state, 'replaySchema'), false);
  assert.equal(Object.hasOwn(state, 'replayInitializedAt'), false);
});

test('an uninitialized replay store is not initialized by prepare or verify either', async t => {
  const f = fixture(t, { initialize: false });
  const { consumption } = f.makeConsumption();
  const authorizer = f.build();
  const ticket = await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0 });
  assert.ok(ticket);
  authorizer.verify(ticket, f.expected(consumption));
  authorizer.verify(ticket, f.expected(consumption));
  assert.equal(Object.hasOwn(f.store.read(), 'replaySchema'), false);
});

test('a same-shape ticket copy is not a real ticket', async t => {
  const f = fixture(t);
  const { consumption } = f.makeConsumption();
  const authorizer = f.build();
  const ticket = await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0 });
  assert.ok(ticket);

  const copies = [
    { operation: ticket.operation },
    { ...ticket },
    structuredClone({ operation: ticket.operation }),
    [ticket][0] === ticket ? { operation: ticket.operation, extra: true } : null,
  ];
  // The refusal vocabulary is a closed, content-free set; the exact member is not part of the
  // contract, so assert membership rather than one spelling.
  const REFUSAL_REASONS = new Set(['replay', 'uninitialized', 'schema-marker-missing',
    'schema-version-mismatch', 'collection-lost', 'collection-corrupt', 'invalid-identity',
    'invalid-clock', 'not-authorized', 'replay-refused']);
  for (const copy of copies) {
    assert.equal(authorizer.verify(copy, f.expected(consumption)), false);
    const refused = authorizer.claim(copy, f.expected(consumption));
    assert.equal(refused.ok, false);
    assert.ok(Object.isFrozen(refused));
    assert.equal(typeof refused.reason, 'string');
    assert.ok(REFUSAL_REASONS.has(refused.reason), `uncontrolled refusal reason: ${refused.reason}`);
    // finish() on an unknown shape is a no-op, not a throw.
    assert.doesNotThrow(() => authorizer.finish(copy));
    assert.doesNotThrow(() => authorizer.finish(undefined));
  }
  assert.deepEqual(f.claimedKeys(), []);

  // The genuine ticket is unaffected by the forgeries.
  assert.equal(authorizer.verify(ticket, f.expected(consumption)), true);
  assert.equal(authorizer.claim(ticket, f.expected(consumption)).ok, true);
});

test('the operation expires 30s after prepare and an unusable clock fails closed', async t => {
  const f = fixture(t);
  const { consumption } = f.makeConsumption();
  const authorizer = f.build();
  const ticket = await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0 });
  assert.ok(ticket);

  f.live.now = NOW + APPROVAL_WINDOW_MS - 1;
  assert.equal(authorizer.verify(ticket, f.expected(consumption)), true);
  // At the expiration instant the authorization is no longer usable.
  f.live.now = NOW + APPROVAL_WINDOW_MS;
  assert.equal(authorizer.verify(ticket, f.expected(consumption)), false);
  assert.equal(authorizer.claim(ticket, f.expected(consumption)).ok, false);
  assert.deepEqual(f.claimedKeys(), []);

  for (const broken of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, '1', null]) {
    f.live.now = broken;
    assert.equal(await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0 }), null);
    assert.equal(authorizer.verify(ticket, f.expected(consumption)), false);
  }
  // A throwing clock is not a usable clock either.
  const throwingClock = f.build({ clock: () => { throw new Error('clock unavailable'); } });
  assert.equal(await throwingClock.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0 }), null);
  assert.deepEqual(f.claimedKeys(), []);
});

test('a clock that fails only at the claim stamp is a refusal, not a throw', async t => {
  const f = fixture(t);
  const { consumption } = f.makeConsumption();
  // `prepare()` reads the clock twice (issued at, confirmed at); `claim()` reads it twice more:
  // once inside `verify()` and once to stamp the B2 record. Fail exactly the FOURTH read, which
  // is claim()'s own stamp read, so this covers that guard instead of verify()'s.
  let reads = 0;
  let failAt = Number.POSITIVE_INFINITY;
  const authorizer = f.build({
    clock: () => {
      reads += 1;
      if (reads === failAt) throw new TypeError('invalid clock');
      return NOW;
    },
  });
  const ticket = await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0 });
  assert.ok(ticket);
  assert.equal(reads, 2);

  // A clock that cannot be read simply means "this claim cannot be stamped": a refusal, not a
  // crash. Only a failing STORE is documented to propagate, and nothing may be written.
  failAt = 4;
  let refused;
  assert.doesNotThrow(() => { refused = authorizer.claim(ticket, f.expected(consumption)); });
  assert.equal(reads, 4);
  assert.ok(Object.isFrozen(refused));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'invalid-clock');
  assert.deepEqual(f.claimedKeys(), []);

  // The refusal stamped nothing, so the ticket is not poisoned and no key was consumed: a
  // readable clock still claims exactly once.
  failAt = Number.POSITIVE_INFINITY;
  assert.equal(authorizer.claim(ticket, f.expected(consumption)).ok, true);
  assert.deepEqual(f.claimedKeys(), ['[123,"s1","request-1","c1"]']);
});

test('prepare rejects a missing or forged consumption, a foreign epoch and an invalid action', async t => {
  const f = fixture(t);
  const { consumption } = f.makeConsumption();
  const authorizer = f.build();
  const forged = { ...consumption };

  assert.equal(await authorizer.prepare({ action: 'read_posts', input: INPUT, connectionEpoch: 0 }), null);
  assert.equal(await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption: forged, connectionEpoch: 0 }), null);
  assert.equal(await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption: null, connectionEpoch: 0 }), null);
  assert.equal(await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: -1 }), null);
  assert.equal(await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 1.5 }), null);
  assert.equal(await authorizer.prepare({ action: 'not_a_tool', input: INPUT, consumption, connectionEpoch: 0 }), null);
  assert.equal(await authorizer.prepare({ action: 'read_posts', input: { target_uin: '456abc' }, consumption, connectionEpoch: 0 }), null);
  assert.equal(await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0, sessionId: 'other' }), null);
  assert.equal(await authorizer.prepare(null), null);

  // A genuine consumption from a ledger with a DIFFERENT epoch must not be accepted.
  const foreignLedger = createQzoneOriginLedger({ sessionId: 's1', epoch: 'e2' });
  foreignLedger.registerBridgeRequest({ requestId: 'request-1', origin: 'qq-inbound' });
  foreignLedger.observeStep({ sessionId: 's1', turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'request-1' } }] });
  foreignLedger.observeToolCall({ sessionId: 's1', event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c9' } } });
  const foreign = foreignLedger.consume({ sessionId: 's1', callId: 'c9', turn: 1, step: 1 });
  assert.equal(foreign.epoch, 'e2');
  assert.equal(await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption: foreign, connectionEpoch: 0 }), null);
  assert.deepEqual(f.claimedKeys(), []);
});

test('a retired consumption object cannot be approved, but prepare still refuses only that record', async t => {
  const f = fixture(t);
  const { ledger, consumption } = f.makeConsumption();
  const authorizer = f.build();
  // The ledger retires the turn: the consumption brand itself stops validating. The gate must
  // fail closed rather than trust a stale branded object.
  assert.equal(ledger.endTurn({ sessionId: 's1', turn: 1 }), true);
  assert.equal(isOriginLedgerConsumption(consumption), false);
  assert.equal(await authorizer.prepare({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0 }), null);
  assert.equal(authorizer.verify({ operation: {} }, f.expected(consumption)), false);
  assert.deepEqual(f.claimedKeys(), []);
});

test('the constructor refuses invalid dependencies and exposes only four frozen methods', async t => {
  const f = fixture(t);
  const base = {
    store: f.store, accountId: 123, sourceEpoch: 'e1', clock: () => NOW,
    approveOperation: () => true, isCurrent: () => true,
  };
  assert.throws(() => createQzoneOperationAuthorizer(), TypeError);
  assert.throws(() => createQzoneOperationAuthorizer({ ...base, store: null }), TypeError);
  assert.throws(() => createQzoneOperationAuthorizer({ ...base, store: {} }), TypeError);
  assert.throws(() => createQzoneOperationAuthorizer({ ...base, store: { read() {}, update() {} }, accountId: 0 }), TypeError);
  assert.throws(() => createQzoneOperationAuthorizer({ ...base, accountId: 0 }), TypeError);
  assert.throws(() => createQzoneOperationAuthorizer({ ...base, accountId: 1.5 }), TypeError);
  assert.throws(() => createQzoneOperationAuthorizer({ ...base, accountId: '123' }), TypeError);
  assert.throws(() => createQzoneOperationAuthorizer({ ...base, sourceEpoch: '' }), TypeError);
  assert.throws(() => createQzoneOperationAuthorizer({ ...base, sourceEpoch: 'has space' }), TypeError);
  assert.throws(() => createQzoneOperationAuthorizer({ ...base, sourceEpoch: 7 }), TypeError);
  assert.throws(() => createQzoneOperationAuthorizer({ ...base, clock: 1 }), TypeError);
  assert.throws(() => createQzoneOperationAuthorizer({ ...base, approveOperation: null }), TypeError);
  assert.throws(() => createQzoneOperationAuthorizer({ ...base, isCurrent: 'no' }), TypeError);

  const authorizer = createQzoneOperationAuthorizer(base);
  assert.ok(Object.isFrozen(authorizer));
  assert.deepEqual(Object.keys(authorizer).sort(), ['claim', 'finish', 'prepare', 'verify']);
  assert.equal(typeof authorizer.prepare, 'function');
  // There is no way to initialize the replay store through this module.
  assert.equal(Object.hasOwn(authorizer, 'initialize'), false);
});

test('a hung approval times out at 30s and BOTH late directions are observed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const unhandled = [];
  const onUnhandled = (error) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  // One Promise settles ONCE, so reaching both late-settlement directions needs two
  // independent host promises and two independent authorizers. Sharing one promise (as an
  // earlier version of this test did) makes the second `settle` a silent no-op: the claim
  // that "late resolve AND late reject were observed" would then be untested.
  const resolveSide = fixture(t);
  const resolveConsumption = resolveSide.makeConsumption().consumption;
  let settleResolve = null;
  const lateApproval = resolveSide.build({
    approveOperation: () => new Promise((resolve) => { settleResolve = resolve; }),
  });

  const rejectSide = fixture(t);
  const rejectConsumption = rejectSide.makeConsumption().consumption;
  let settleReject = null;
  const lateRejection = rejectSide.build({
    approveOperation: () => new Promise((_resolve, reject) => { settleReject = reject; }),
  });

  const request = (consumption) => ({ action: 'read_posts', input: INPUT, consumption, connectionEpoch: 0 });
  const pendingResolve = lateApproval.prepare(request(resolveConsumption));
  const pendingReject = lateRejection.prepare(request(rejectConsumption));
  assert.equal(typeof settleResolve, 'function', 'the approval fixture must actually be pending');
  assert.equal(typeof settleReject, 'function', 'the rejection fixture must actually be pending');

  t.mock.timers.tick(APPROVAL_WINDOW_MS - 1);
  // Still waiting: the timeout is a real deadline, not an immediate refusal.
  const states = ['pending', 'pending'];
  pendingResolve.then((value) => { states[0] = value === null ? 'null' : 'ticket'; });
  pendingReject.then((value) => { states[1] = value === null ? 'null' : 'ticket'; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(states, ['pending', 'pending']);

  t.mock.timers.tick(1);
  assert.equal(await pendingResolve, null, 'a timed-out approval mints no ticket');
  assert.equal(await pendingReject, null, 'a timed-out approval mints no ticket');
  assert.deepEqual(resolveSide.claimedKeys(), []);
  assert.deepEqual(rejectSide.claimedKeys(), []);

  // Now settle both LATE, each on a promise that is still unsettled, so each direction really
  // travels through `askHost`:
  //   · the resolve side must not mint a ticket after the deadline;
  //   · the reject side must not escape as an unhandled rejection (which would fail this test
  //     both through `unhandled` below and through node:test's own rejection tracking).
  settleResolve(true);
  settleReject(new Error('late host failure'));
  // Two turns: one for the settlement to reach the host promise's handler, one for any
  // rejection notification to be emitted before the assertion.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(unhandled, [], 'a late rejection is handled, not unhandled');
  assert.deepEqual(resolveSide.claimedKeys(), [], 'a late approval mints nothing');
  assert.deepEqual(rejectSide.claimedKeys(), [], 'a late rejection mints nothing');
  // A late approval is not retroactively live either: the timed-out authorizer stays empty.
  assert.equal(resolveSide.store.read().usedReadKeys && Object.keys(resolveSide.store.read().usedReadKeys).length, 0);
  assert.equal(rejectSide.store.read().usedReadKeys && Object.keys(rejectSide.store.read().usedReadKeys).length, 0);

  // The clock is never consulted for the deadline: only the timer fires it.
  assert.equal(resolveSide.live.now, NOW);
  assert.equal(rejectSide.live.now, NOW);
});
