import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  QUOTA_NOTICE_TEXT,
  QUOTA_NOTICE_INTERVAL_MS,
  QUOTA_NOTICE_LIMIT,
  createQuotaNotice,
} from '../src/quota-notice.js';

const T0 = 1700000000000;
const KEY = 'group:123456';
const SEL = { provider: 'provider-a', model: 'model-a' };
const ENTRY_FIELDS = ['id', 'count', 'lastAt', 'epoch'];

function sel(provider = 'provider-a', model = 'model-a') {
  return { provider, model };
}

function makeHarness(options = {}) {
  let clock = options.start ?? T0;
  let state = options.store ?? null;
  let saveCalls = 0;
  let failSave = false;
  let loadError = null;
  const logs = [];
  const now = () => clock;
  const load = () => {
    if (loadError) throw loadError;
    return state;
  };
  const save = (payload) => {
    saveCalls += 1;
    if (failSave) throw new Error('disk write failed');
    state = JSON.parse(JSON.stringify(payload));
  };
  const build = (extra = {}) => {
    const base = {
      now,
      load,
      save,
      log: (...args) => logs.push(args.map((value) => String(value)).join(' ')),
    };
    if (options.maxEntries !== undefined) base.maxEntries = options.maxEntries;
    return createQuotaNotice({ ...base, ...extra });
  };
  let policy = build();
  return {
    get policy() {
      return policy;
    },
    rebuild(extra) {
      policy = build(extra);
      return policy;
    },
    get store() {
      return state;
    },
    get logs() {
      return logs;
    },
    get saveCalls() {
      return saveCalls;
    },
    get now() {
      return clock;
    },
    advance(ms) {
      clock += ms;
    },
    setClock(value) {
      clock = value;
    },
    setStore(value) {
      state = value;
    },
    setFailSave(value) {
      failSave = value;
    },
    setLoadError(value) {
      loadError = value;
    },
  };
}

function onlyEntry(store) {
  assert.equal(store.version, 1);
  assert.ok(Array.isArray(store.entries));
  assert.equal(store.entries.length, 1);
  return store.entries[0];
}

function dump(store) {
  return JSON.stringify(store);
}

test('exports the approved notice copy and hard limits', () => {
  assert.equal(QUOTA_NOTICE_TEXT, '当前模型额度不足，请切换模型');
  assert.equal(QUOTA_NOTICE_INTERVAL_MS, 600000);
  assert.equal(QUOTA_NOTICE_LIMIT, 3);
});

test('first eligible reserve creates one id-only entry and marks the ticket current', () => {
  const h = makeHarness();
  const ticket = h.policy.reserve(KEY, SEL);
  assert.ok(ticket);
  assert.equal(h.policy.isCurrent(ticket), true);
  const entry = onlyEntry(h.store);
  assert.equal(entry.count, 1);
  assert.equal(entry.lastAt, T0);
  assert.equal(typeof entry.id, 'string');
  assert.match(entry.id, /^[0-9a-f]{64}$/);
  const unexpected = Object.keys(entry).filter((field) => ENTRY_FIELDS.includes(field) === false);
  assert.deepEqual(unexpected, []);
  assert.equal(h.policy.reserve(KEY, SEL), null, 'pending notice must block duplicates');
});

test('persisted bucket id is SHA256 of the JSON tuple key, provider, model', () => {
  const h = makeHarness();
  h.policy.reserve(KEY, sel('provider-a', 'model-a'));
  const expected = createHash('sha256').update(JSON.stringify([KEY, 'provider-a', 'model-a'])).digest('hex');
  assert.equal(onlyEntry(h.store).id, expected);
});

test('cooldown boundary is exactly 600000ms between eligible errors', () => {
  const h = makeHarness();
  const first = h.policy.reserve(KEY, SEL);
  assert.ok(first);
  h.policy.settle(first, 'sent');
  h.advance(599999);
  assert.equal(h.policy.reserve(KEY, SEL), null);
  h.advance(1);
  const second = h.policy.reserve(KEY, SEL);
  assert.ok(second);
  assert.equal(h.store.entries[0].count, 2);
});

test('at most three notices per incident, then blocked even after cooldown', () => {
  const h = makeHarness();
  for (let index = 0; index < QUOTA_NOTICE_LIMIT; index += 1) {
    const ticket = h.policy.reserve(KEY, SEL);
    assert.ok(ticket, 'notice ' + (index + 1) + ' must be allowed');
    h.policy.settle(ticket, 'sent');
    h.advance(QUOTA_NOTICE_INTERVAL_MS);
  }
  assert.equal(onlyEntry(h.store).count, 3);
  h.advance(QUOTA_NOTICE_INTERVAL_MS * 5);
  assert.equal(h.policy.reserve(KEY, SEL), null, 'capped incident must not reset by waiting');
});

test('only one pending notice per bucket', () => {
  const h = makeHarness();
  const ticket = h.policy.reserve(KEY, SEL);
  assert.ok(ticket);
  assert.equal(h.policy.reserve(KEY, SEL), null);
  assert.equal(onlyEntry(h.store).count, 1);
  h.policy.settle(ticket, 'cancelled');
  const total = (h.store.entries || []).reduce((sum, entry) => sum + Number(entry.count), 0);
  assert.equal(total, 0);
  assert.equal(h.policy.isCurrent(ticket), false);
  assert.ok(h.policy.reserve(KEY, SEL));
});

test('separate provider and model buckets may be pending at the same time', () => {
  const h = makeHarness();
  const first = h.policy.reserve(KEY, sel('provider-a', 'model-a'));
  const second = h.policy.reserve(KEY, sel('provider-b', 'model-b'));
  assert.ok(first);
  assert.ok(second);
  assert.equal(h.store.entries.length, 2);
});

test('uncertain network attempt consumes a slot and starts cooldown', () => {
  const h = makeHarness();
  const ticket = h.policy.reserve(KEY, SEL);
  h.policy.settle(ticket, 'unknown');
  assert.equal(h.policy.isCurrent(ticket), false);
  assert.equal(onlyEntry(h.store).count, 1);
  assert.equal(onlyEntry(h.store).lastAt, T0);
  assert.equal(h.policy.reserve(KEY, SEL), null);
  h.advance(QUOTA_NOTICE_INTERVAL_MS);
  assert.ok(h.policy.reserve(KEY, SEL));
});

test('uncertain attempts still count toward the three-notice cap', () => {
  const h = makeHarness();
  for (let index = 0; index < QUOTA_NOTICE_LIMIT; index += 1) {
    const ticket = h.policy.reserve(KEY, SEL);
    assert.ok(ticket);
    h.policy.settle(ticket, 'unknown');
    h.advance(QUOTA_NOTICE_INTERVAL_MS);
  }
  h.advance(QUOTA_NOTICE_INTERVAL_MS);
  assert.equal(h.policy.reserve(KEY, SEL), null);
});

test('durable payload survives a rebuild and still enforces cooldown and count', () => {
  const h = makeHarness();
  const ticket = h.policy.reserve(KEY, SEL);
  h.policy.settle(ticket, 'sent');
  const rebuilt = h.rebuild();
  assert.equal(rebuilt.reserve(KEY, SEL), null);
  h.advance(QUOTA_NOTICE_INTERVAL_MS);
  assert.ok(rebuilt.reserve(KEY, SEL));
  assert.equal(onlyEntry(h.store).count, 2);
});

test('recover removes the exact bucket and invalidates a pending ticket', () => {
  const h = makeHarness();
  const ticket = h.policy.reserve(KEY, SEL);
  assert.equal(h.policy.recover(KEY, SEL), true);
  assert.equal(h.policy.isCurrent(ticket), false);
  assert.equal(h.store.entries.length, 0);
  const next = h.policy.reserve(KEY, SEL);
  assert.ok(next);
  assert.equal(onlyEntry(h.store).count, 1);
});

test('recover returns false for a missing or non-matching bucket', () => {
  const h = makeHarness();
  h.policy.reserve(KEY, SEL);
  assert.equal(h.policy.recover(KEY, sel('provider-other', 'model-a')), false);
  assert.equal(h.policy.recover('private:999', SEL), false);
  assert.equal(h.store.entries.length, 1);
});

test('recover resets a capped incident so a later failure may notify again', () => {
  const h = makeHarness();
  for (let index = 0; index < QUOTA_NOTICE_LIMIT; index += 1) {
    const ticket = h.policy.reserve(KEY, SEL);
    h.policy.settle(ticket, 'sent');
    h.advance(QUOTA_NOTICE_INTERVAL_MS);
  }
  assert.equal(h.policy.reserve(KEY, SEL), null);
  assert.equal(h.policy.recover(KEY, SEL), true);
  assert.ok(h.policy.reserve(KEY, SEL));
  assert.equal(onlyEntry(h.store).count, 1);
});

test('switching provider or model away and back does not reset a capped incident', () => {
  const h = makeHarness();
  for (let index = 0; index < QUOTA_NOTICE_LIMIT; index += 1) {
    const ticket = h.policy.reserve(KEY, sel('provider-a', 'model-a'));
    h.policy.settle(ticket, 'sent');
    h.advance(QUOTA_NOTICE_INTERVAL_MS);
  }
  const other = h.policy.reserve(KEY, sel('provider-a', 'model-b'));
  assert.ok(other);
  h.policy.settle(other, 'sent');
  h.advance(QUOTA_NOTICE_INTERVAL_MS);
  assert.equal(h.policy.reserve(KEY, sel('provider-a', 'model-a')), null);
});

test('different QQ conversation keys have isolated incidents', () => {
  const h = makeHarness();
  for (let index = 0; index < QUOTA_NOTICE_LIMIT; index += 1) {
    const ticket = h.policy.reserve('group:1', SEL);
    h.policy.settle(ticket, 'sent');
    h.advance(QUOTA_NOTICE_INTERVAL_MS);
  }
  assert.equal(h.policy.reserve('group:1', SEL), null);
  assert.ok(h.policy.reserve('group:2', SEL));
});

test('provider and model identities are isolated buckets', () => {
  const h = makeHarness();
  for (let index = 0; index < QUOTA_NOTICE_LIMIT; index += 1) {
    const ticket = h.policy.reserve(KEY, sel('provider-a', 'model-a'));
    h.policy.settle(ticket, 'sent');
    h.advance(QUOTA_NOTICE_INTERVAL_MS);
  }
  assert.equal(h.policy.reserve(KEY, sel('provider-a', 'model-a')), null);
  assert.ok(h.policy.reserve(KEY, sel('provider-b', 'model-a')));
  assert.ok(h.policy.reserve(KEY, sel('provider-a', 'model-b')));
  assert.equal(h.store.entries.length, 3);
});

test('invalid provider or model selections are rejected without metadata writes', () => {
  const h = makeHarness();
  assert.equal(h.policy.reserve(KEY, { provider: '', model: 'model-a' }), null);
  assert.equal(h.policy.reserve(KEY, { provider: 'provider-a', model: '' }), null);
  assert.equal(h.policy.reserve(KEY, { provider: 'provider-a' }), null);
  assert.equal(h.policy.reserve(KEY, { model: 'model-a' }), null);
  assert.equal(h.policy.reserve(KEY, { provider: 42, model: 'model-a' }), null);
  assert.equal(h.store, null);
  assert.equal(h.saveCalls, 0);
});

test('malformed persisted state fails closed without overwriting it', () => {
  const malformed = [
    '{not valid json',
    { version: 2, entries: [] },
    { version: 1, entries: 'not-an-array' },
    { version: 1, entries: [{ id: 'not-a-hash', count: 'many' }] },
  ];
  for (const bad of malformed) {
    const h = makeHarness();
    h.setStore(bad);
    const before = dump(h.store);
    assert.equal(h.policy.reserve(KEY, SEL), null);
    assert.equal(h.saveCalls, 0);
    assert.ok(h.logs.length > 0, 'malformed state must be logged with a safe code');
    assert.equal(dump(h.store), before);
    assert.equal(JSON.stringify(h.logs).includes(KEY), false);
  }
});

test('throwing load suppresses notices, logs safely, and never throws', () => {
  const h = makeHarness();
  h.setLoadError(new Error('EACCES /secret/path'));
  let ticket;
  assert.doesNotThrow(() => {
    ticket = h.policy.reserve(KEY, SEL);
  });
  assert.equal(ticket, null);
  assert.equal(h.saveCalls, 0);
  assert.ok(h.logs.length > 0);
  assert.equal(JSON.stringify(h.logs).includes('EACCES'), false);
});

test('null load is treated as missing empty state', () => {
  const h = makeHarness();
  assert.equal(h.store, null);
  const ticket = h.policy.reserve(KEY, SEL);
  assert.ok(ticket);
  assert.equal(h.store.version, 1);
});

test('save failure fails closed until a fresh load establishes durable state', () => {
  const h = makeHarness();
  h.setFailSave(true);
  let ticket;
  assert.doesNotThrow(() => {
    ticket = h.policy.reserve(KEY, SEL);
  });
  assert.equal(ticket, null);
  assert.ok(h.logs.length > 0);
  assert.equal(h.store, null);
  h.setFailSave(false);
  assert.equal(h.policy.reserve(KEY, SEL), null, 'uncertain persistence must stay fail closed in this instance');
  h.rebuild();
  const retry = h.policy.reserve(KEY, SEL);
  assert.ok(retry);
  assert.equal(onlyEntry(h.store).count, 1);
});

test('capacity rejects new buckets but keeps existing buckets usable', () => {
  const h = makeHarness({ maxEntries: 2 });
  const one = h.policy.reserve('group:1', SEL);
  const two = h.policy.reserve('group:2', SEL);
  assert.ok(one);
  assert.ok(two);
  h.policy.settle(one, 'sent');
  h.policy.settle(two, 'sent');
  assert.equal(h.store.entries.length, 2);
  assert.equal(h.policy.reserve('group:3', SEL), null);
  assert.equal(h.store.entries.length, 2);
  h.advance(QUOTA_NOTICE_INTERVAL_MS);
  assert.ok(h.policy.reserve('group:1', SEL));
  assert.equal(h.policy.reserve('group:3', SEL), null);
});

test('clock rollback suppresses notices until the previous timestamp is reached', () => {
  const h = makeHarness();
  const ticket = h.policy.reserve(KEY, SEL);
  h.policy.settle(ticket, 'sent');
  h.setClock(T0 - 1000);
  assert.equal(h.policy.reserve(KEY, SEL), null);
  h.setClock(T0 + QUOTA_NOTICE_INTERVAL_MS);
  assert.ok(h.policy.reserve(KEY, SEL));
});

test('persisted metadata contains no session key, model names, or error payloads', () => {
  const sessionKey = 'group:987654321';
  const provider = 'provider-UNIQUE-hidden';
  const model = 'model-UNIQUE-hidden';
  const h = makeHarness();
  const ticket = h.policy.reserve(sessionKey, { provider, model });
  h.policy.settle(ticket, 'sent');
  const dumped = dump(h.store);
  for (const raw of [sessionKey, provider, model]) {
    assert.equal(dumped.includes(raw), false);
  }
  const entry = onlyEntry(h.store);
  const unexpected = Object.keys(entry).filter((field) => ENTRY_FIELDS.includes(field) === false);
  assert.deepEqual(unexpected, []);
});

test('a late settle after cancellation cannot resurrect metadata', () => {
  const h = makeHarness();
  const ticket = h.policy.reserve(KEY, SEL);
  h.policy.settle(ticket, 'cancelled');
  const before = dump(h.store);
  h.policy.settle(ticket, 'sent');
  assert.equal(dump(h.store), before);
  assert.equal(h.policy.isCurrent(ticket), false);
});

test('reservation is persisted write-ahead before any send outcome', () => {
  const h = makeHarness();
  const ticket = h.policy.reserve(KEY, SEL);
  assert.ok(ticket);
  assert.equal(h.saveCalls, 1);
  assert.equal(onlyEntry(h.store).count, 1);
  assert.equal(onlyEntry(h.store).lastAt, T0);
  assert.equal(h.policy.isCurrent(ticket), true);
});

test('cancelled notice rolls back count and time so the next failure is eligible', () => {
  const h = makeHarness();
  const first = h.policy.reserve(KEY, SEL);
  h.policy.settle(first, 'sent');
  h.advance(QUOTA_NOTICE_INTERVAL_MS);
  const pending = h.policy.reserve(KEY, SEL);
  assert.ok(pending);
  assert.equal(onlyEntry(h.store).count, 2);
  h.policy.settle(pending, 'cancelled');
  const total = (h.store.entries || []).reduce((sum, entry) => sum + Number(entry.count), 0);
  assert.equal(total, 1);
  assert.equal(h.policy.isCurrent(pending), false);
  const retry = h.policy.reserve(KEY, SEL);
  assert.ok(retry, 'cooldown must be measured from the last eligible error, not a cancelled attempt');
});

test('suppression logs distinguish pending, cooldown, cap and capacity without identifiers', () => {
  const h = makeHarness({ maxEntries: 1 });
  const t = h.policy.reserve(KEY, SEL);
  h.policy.reserve(KEY, SEL);
  assert.match(h.logs.join(' '), /pending/);
  h.policy.settle(t, 'sent');
  h.policy.reserve(KEY, SEL);
  assert.match(h.logs.join(' '), /cooldown/);
  h.policy.reserve('group:999', SEL);
  assert.match(h.logs.join(' '), /capacity/);
  for (let i = 0; i < 2; i++) {
    h.advance(QUOTA_NOTICE_INTERVAL_MS);
    h.policy.settle(h.policy.reserve(KEY, SEL), 'sent');
  }
  h.advance(QUOTA_NOTICE_INTERVAL_MS);
  h.policy.reserve(KEY, SEL);
  assert.match(h.logs.join(' '), /limit/);
  assert.ok(!h.logs.join(' ').includes(KEY));
});

test('cooldown starts at actual dispatch, not earlier time spent waiting in the queue', () => {
  const h = makeHarness();
  const ticket = h.policy.reserve(KEY, SEL);
  h.advance(120000);
  assert.equal(h.policy.begin(ticket), true);
  h.policy.settle(ticket, 'sent');
  h.advance(480000);
  assert.equal(h.policy.reserve(KEY, SEL), null, 'only eight minutes since send');
  h.advance(120000);
  assert.ok(h.policy.reserve(KEY, SEL));
});

test('dispatch timestamp must be durable before network IO is allowed', () => {
  const h = makeHarness();
  const ticket = h.policy.reserve(KEY, SEL);
  h.advance(120000);
  h.setFailSave(true);
  assert.equal(h.policy.begin(ticket), false);
  assert.equal(h.policy.isCurrent(ticket), false);
});

test('a throwing malformed load object is also contained and fails closed', () => {
  const malformed = Object.defineProperty({}, 'version', { get() { throw new Error('secret getter'); } });
  const h = makeHarness({ store: malformed });
  assert.doesNotThrow(() => assert.equal(h.policy.reserve(KEY, SEL), null));
  assert.equal(h.policy.reserve(KEY, SEL), null);
  assert.equal(h.saveCalls, 0);
  assert.ok(!h.logs.join(' ').includes('secret getter'));
});
