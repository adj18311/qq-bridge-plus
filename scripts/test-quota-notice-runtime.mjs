import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';

import {
  createQuotaNotice,
  QUOTA_NOTICE_TEXT,
  QUOTA_NOTICE_INTERVAL_MS,
  QUOTA_NOTICE_LIMIT,
} from '../src/quota-notice.js';
import { createQuotaNoticeRuntime } from '../src/quota-notice-runtime.js';

const BASE_TIME = 1700000000000;
const KEY = 'group:1001';
const KEY_B = 'group:2002';
const SID = 'session-a';
const SID_B = 'session-b';
const QUOTA_TEXT = '当前模型额度不足，请切换模型';

function stringifyArg(value) {
  if (typeof value === 'string') return value;
  try {
    return inspect(value, { depth: 6, breakLength: Infinity });
  } catch {
    return String(value);
  }
}

function createStore(initial = null) {
  const store = {
    state: initial,
    saveCount: 0,
    failSave: false,
    failLoad: null,
    load() {
      if (store.failLoad) throw store.failLoad;
      return store.state;
    },
    save(payload) {
      if (store.failSave) throw new Error('persist failed');
      store.saveCount += 1;
      store.state = JSON.parse(JSON.stringify(payload));
    },
    peek() {
      return store.state;
    },
  };
  return store;
}

function sumCounts(state) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.entries)) return 0;
  return state.entries.reduce((total, entry) => {
    if (!entry || !Number.isFinite(entry.count)) return total;
    return total + entry.count;
  }, 0);
}

function entryIds(state) {
  if (!state || !Array.isArray(state.entries)) return [];
  return state.entries.map((entry) => entry && entry.id);
}

function createHarness(options = {}) {
  let now = Number.isFinite(options.time) ? options.time : BASE_TIME;
  const advance = (ms) => {
    now += ms;
  };

  const store = createStore(options.initialState ?? null);
  if (options.failSave) store.failSave = true;
  if (options.loadError) store.failLoad = options.loadError;
  if (typeof options.load === 'function') store.load = options.load;

  const policyLogs = [];
  const policy = createQuotaNotice({
    now: () => now,
    load: () => store.load(),
    save: (payload) => store.save(payload),
    log: (code, ...rest) => {
      policyLogs.push([code, ...rest].map(stringifyArg).join(' '));
    },
    maxEntries: options.maxEntries ?? 4096,
  });

  const selections = new Map(options.selections ?? []);
  const fallbackSelection = options.fallbackSelection ?? { provider: 'p1', model: 'm1' };
  const getSelection = (key) => selections.get(key) ?? fallbackSelection;

  const queue = [];
  const sends = [];
  const logs = [];
  const redactCalls = [];
  let guardOk = options.guardOk === undefined ? true : Boolean(options.guardOk);

  const enqueue = (task) => {
    queue.push(task);
  };

  const send = async (key, text) => {
    sends.push({ key, text, at: now });
    if (typeof options.sendImpl === 'function') return options.sendImpl(key, text);
    return undefined;
  };

  const redact = (value) => {
    redactCalls.push(value);
    if (typeof options.redact === 'function') return options.redact(value);
    return 'redacted';
  };

  const runtime = createQuotaNoticeRuntime({
    policy,
    getSelection,
    enqueue,
    captureGuard: (key, sid) => () => { if (!guardOk) throw new Error('fixture guard rejected'); },
    send,
    log: (...args) => {
      logs.push(args.map(stringifyArg).join(' '));
    },
    redact,
    maxSessions: options.maxSessions ?? 256,
  });

  let seq = 0;
  const nextSeq = () => {
    seq += 1;
    return seq;
  };

  const h = {
    policy,
    runtime,
    store,
    sends,
    queue,
    logs,
    policyLogs,
    redactCalls,
    now: () => now,
    advance,
    seq: nextSeq,
    setGuard(value) {
      guardOk = Boolean(value);
    },
    select(key, provider, model) {
      selections.set(key, { provider, model });
    },
    turnStart(turn, seqValue) {
      return { seq: seqValue ?? nextSeq(), type: 'turn/start', data: { turn } };
    },
    stepStart(turn, step, seqValue) {
      return { seq: seqValue ?? nextSeq(), type: 'step/start', data: { turn, step } };
    },
    turnEnd(turn, step, seqValue) {
      return { seq: seqValue ?? nextSeq(), type: 'turn/end', data: { turn, step } };
    },
    successMessage(turn, step, seqValue, key = KEY, sid = SID) {
      return {
        seq: seqValue ?? nextSeq(),
        type: 'assistant/message',
        data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      };
    },
    liveStart(turn, step = 1, key = KEY, sid = SID) {
      runtime.observe(key, sid, h.turnStart(turn));
      runtime.observe(key, sid, h.stepStart(turn, step));
    },
    errorEvent(fields) {
      const turn = fields.turn;
      const step = fields.step;
      const selected = getSelection(fields.key ?? KEY);
      const data = {
        turn,
        step,
        requestId: 'req-' + String(turn) + '-' + String(step),
        error: {
          code: fields.code,
          type: fields.code,
          message: fields.message,
        },
        message: fields.message,
        provider: fields.provider ?? selected.provider,
        model: fields.model ?? selected.model,
      };
      if (fields.status !== undefined) data.error.status = fields.status;
      data.reason = { kind: 'error', error: data.error };
      return { seq: fields.seq ?? nextSeq(), type: 'turn/end', data };
    },
    quotaError(fields = {}) {
      return h.errorEvent({
        turn: fields.turn,
        step: fields.step,
        seq: fields.seq,
        key: fields.key,
        provider: fields.provider,
        model: fields.model,
        status: fields.status,
        code: fields.code ?? 'insufficient_quota',
        message: fields.message ?? 'insufficient quota: account balance exhausted',
      });
    },
    nonQuotaError(fields = {}) {
      return h.errorEvent({
        turn: fields.turn,
        step: fields.step,
        seq: fields.seq,
        key: fields.key,
        status: fields.status,
        code: fields.code ?? 'rate_limit_exceeded',
        message: fields.message ?? '429 Too Many Requests',
      });
    },
    async drain() {
      while (queue.length > 0) {
        const task = queue.shift();
        await task();
      }
    },
  };

  return h;
}

test('live turn quota error sends exactly one notice with the exact text', async () => {
  const h = createHarness();
  assert.equal(QUOTA_NOTICE_TEXT, QUOTA_TEXT);
  assert.equal(QUOTA_NOTICE_INTERVAL_MS, 600000);
  assert.equal(QUOTA_NOTICE_LIMIT, 3);

  h.liveStart(1, 1);
  const result = h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 }));
  assert.equal(result.handled, true);
  assert.equal(h.sends.length, 0);

  await h.drain();
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].key, KEY);
  assert.equal(h.sends[0].text, QUOTA_TEXT);

  const state = h.store.peek();
  assert.ok(state);
  assert.equal(state.version, 1);
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].count, 1);
  assert.equal(state.entries[0].lastAt, BASE_TIME);

  const expectedId = createHash('sha256')
    .update(JSON.stringify([KEY, 'p1', 'm1']))
    .digest('hex');
  assert.equal(state.entries[0].id, expectedId);

  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes(KEY));
  assert.ok(!serialized.includes('p1'));
  assert.ok(!serialized.includes('m1'));
});

test('quota errors without a live trusted turn are handled but never notify', async () => {
  const h = createHarness();

  const orphan = h.runtime.observe(KEY, SID, h.quotaError({ turn: 3, step: 2 }));
  assert.equal(orphan.handled, true);
  await h.drain();
  assert.equal(h.sends.length, 0);
  assert.equal(sumCounts(h.store.peek()), 0);

  h.liveStart(5, 1);
  const stale = h.runtime.observe(KEY, SID, h.quotaError({ turn: 4, step: 1 }));
  assert.equal(stale.handled, true);
  await h.drain();
  assert.equal(h.sends.length, 0);
  assert.equal(sumCounts(h.store.peek()), 0);

  h.runtime.observe(KEY, SID, h.turnEnd(5, 1));
  const afterEnd = h.runtime.observe(KEY, SID, h.quotaError({ turn: 5, step: 1 }));
  assert.equal(afterEnd.handled, true);
  await h.drain();
  assert.equal(h.sends.length, 0);
  assert.equal(sumCounts(h.store.peek()), 0);
});

test('duplicate quota seq suppresses legacy handling without repeating effects', async () => {
  const h = createHarness();
  h.liveStart(1, 1);
  const event = h.quotaError({ turn: 1, step: 1 });
  const first = h.runtime.observe(KEY, SID, event);
  assert.equal(first.handled, true);
  const replay = h.runtime.observe(KEY, SID, event);
  assert.equal(replay.handled, true);
  await h.drain();
  assert.equal(h.sends.length, 1);
  assert.equal(sumCounts(h.store.peek()), 1);

  h.runtime.observe(KEY, SID, { seq: 1, type: 'turn/start', data: { turn: 9, step: 0 } });
  await h.drain();
  assert.equal(h.sends.length, 1);
  assert.equal(sumCounts(h.store.peek()), 1);
});

test('snapshot and hydrated history never notify nor recover an incident', async () => {
  const h = createHarness();
  h.liveStart(1, 1);
  assert.equal(h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 })).handled, true);
  await h.drain();
  assert.equal(h.sends.length, 1);
  assert.equal(sumCounts(h.store.peek()), 1);
  const lastAtAfterNotice = h.store.peek().entries[0].lastAt;
  h.advance(1);

  await h.runtime.hydrate(SID_B, [
    h.turnStart(7, 1),
    h.stepStart(7, 1, 2),
    h.successMessage(7, 1, 3),
  ]);
  h.runtime.observe(KEY, SID_B, {
    seq: 4,
    type: 'snapshot',
    data: {
      turn: 7,
      records: [
        {
          seq: 3,
          type: 'assistant/message',
          data: { turn: 7, step: 1, role: 'assistant', content: 'historical ok' },
        },
      ],
    },
  });
  await h.drain();
  assert.equal(h.sends.length, 1);
  assert.equal(sumCounts(h.store.peek()), 1);
  assert.equal(h.store.peek().entries[0].lastAt, lastAtAfterNotice);

  h.runtime.observe(KEY, SID_B, h.turnStart(8, 5));
  h.runtime.observe(KEY, SID_B, h.stepStart(8, 1, 6));
  h.runtime.observe(KEY, SID_B, h.quotaError({ turn: 8, step: 1, seq: 7 }));
  await h.drain();
  assert.equal(h.sends.length, 1);
  assert.equal(sumCounts(h.store.peek()), 1);
});

test('a new turn before drain invalidates the queued notice and rolls back', async () => {
  const h = createHarness();
  h.liveStart(1, 1);
  assert.equal(h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 })).handled, true);

  h.runtime.observe(KEY, SID, h.turnStart(2));
  await h.drain();
  assert.equal(h.sends.length, 0);
  assert.equal(sumCounts(h.store.peek()), 0);

  h.runtime.observe(KEY, SID, h.stepStart(2, 1));
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 2, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 1);
  assert.equal(sumCounts(h.store.peek()), 1);
});

test('model switch before drain cancels the queued notice', async () => {
  const h = createHarness();
  h.liveStart(1, 1);
  assert.equal(h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 })).handled, true);

  h.select(KEY, 'p2', 'm1');
  h.runtime.observe(KEY, SID, {
    seq: h.seq(),
    type: 'switch',
    data: { turn: 1, step: 1, provider: 'p2', model: 'm1' },
  });
  await h.drain();
  assert.equal(h.sends.length, 0);
  assert.equal(sumCounts(h.store.peek()), 0);

  h.liveStart(2, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 2, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 1);
  assert.equal(sumCounts(h.store.peek()), 1);
});

test('assistant/message success in the matching turn recovers the incident', async () => {
  const h = createHarness();
  h.liveStart(1, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 1);
  assert.equal(sumCounts(h.store.peek()), 1);

  h.liveStart(2, 1);
  h.runtime.observe(KEY, SID, h.successMessage(2, 1));
  await h.drain();
  assert.equal(sumCounts(h.store.peek()), 0);

  h.liveStart(3, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 3, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 2);
  assert.equal(sumCounts(h.store.peek()), 1);
});

test('completed-only and tool events cannot recover an incident', async () => {
  const h = createHarness();
  h.liveStart(1, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 1);

  h.liveStart(2, 1);
  h.runtime.observe(KEY, SID, { seq: h.seq(), type: 'tool/result', data: { turn: 2, step: 1, message: { isError: false, content: [] } } });
  h.runtime.observe(KEY, SID, { seq: h.seq(), type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
  await h.drain();
  assert.equal(sumCounts(h.store.peek()), 1);

  h.advance(1);
  h.liveStart(3, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 3, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 1);
  assert.equal(sumCounts(h.store.peek()), 1);
});

test('pause invalidates a queued notice', async () => {
  const h = createHarness();
  h.liveStart(1, 1);
  assert.equal(h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 })).handled, true);
  h.setGuard(false);
  await h.drain();
  assert.equal(h.sends.length, 0);
  assert.equal(sumCounts(h.store.peek()), 0);
});

test('retire invalidates a queued notice', async () => {
  const h = createHarness();
  h.liveStart(1, 1);
  assert.equal(h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 })).handled, true);
  h.runtime.forget(SID);
  await h.drain();
  assert.equal(h.sends.length, 0);
  assert.equal(sumCounts(h.store.peek()), 0);
});

test('clear cancels queued notices for every session and rolls them back', async () => {
  const h = createHarness();
  h.liveStart(1, 1, KEY, SID);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 }));
  h.select(KEY_B, 'p1', 'm1');
  h.liveStart(1, 1, KEY_B, SID);
  h.runtime.observe(KEY_B, SID, h.quotaError({ turn: 1, step: 1, key: KEY_B }));
  await h.runtime.clear();
  await h.drain();
  assert.equal(h.sends.length, 0);
  assert.equal(sumCounts(h.store.peek()), 0);
});

test('forget cancels pending notices without sending', async () => {
  const h = createHarness();
  h.liveStart(1, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 }));
  await h.runtime.forget(SID);
  await h.drain();
  assert.equal(h.sends.length, 0);
  assert.equal(sumCounts(h.store.peek()), 0);
});

test('forget does not reset the incident counter', async () => {
  const h = createHarness();
  h.liveStart(1, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 1);
  h.advance(1);
  await h.runtime.forget(SID);
  h.liveStart(2, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 2, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 1);
  assert.equal(sumCounts(h.store.peek()), 1);
});

test('unknown send failure consumes the slot and logs no secret', async () => {
  const RAW_CANARY = 'sk-live-canary-Bearer-abcdef123456';
  const redactCalls = [];
  const formatRetryDiagnostic = (error) => {
    redactCalls.push(error);
    const code =
      error && typeof error === 'object' && typeof error.code === 'string'
        ? error.code
        : 'unclassified';
    return 'diagnostic:' + code;
  };
  const h = createHarness({
    redact: formatRetryDiagnostic,
    sendImpl: async () => {
      const error = new Error('upstream failure: ' + RAW_CANARY);
      error.code = 'transport_error';
      throw error;
    },
  });

  h.liveStart(1, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 1);
  assert.equal(sumCounts(h.store.peek()), 1);
  assert.ok(h.logs.length >= 1);

  const joined = h.logs.join('\n') + '\n' + h.policyLogs.join('\n');
  assert.ok(!joined.includes(RAW_CANARY));
  assert.ok(!joined.includes('Bearer'));
  assert.ok(!joined.includes('abcdef123456'));

  h.advance(1);
  h.liveStart(2, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 2, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 1);
  assert.equal(sumCounts(h.store.peek()), 1);

  h.advance(QUOTA_NOTICE_INTERVAL_MS - 1);
  h.liveStart(3, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 3, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 2);
  assert.equal(sumCounts(h.store.peek()), 2);
  assert.ok(redactCalls.length >= 1);
});

test('notice cap is 3 and the 600000ms boundary is exact', async () => {
  const h = createHarness();
  assert.equal(QUOTA_NOTICE_INTERVAL_MS, 600000);
  assert.equal(QUOTA_NOTICE_LIMIT, 3);

  h.liveStart(1, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 1);

  h.advance(QUOTA_NOTICE_INTERVAL_MS - 1);
  h.liveStart(2, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 2, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 1);

  h.advance(1);
  h.liveStart(3, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 3, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 2);

  h.advance(QUOTA_NOTICE_INTERVAL_MS);
  h.liveStart(4, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 4, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 3);

  h.advance(QUOTA_NOTICE_INTERVAL_MS);
  h.liveStart(5, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 5, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 3);

  h.advance(QUOTA_NOTICE_INTERVAL_MS);
  h.liveStart(6, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 6, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 3);
  assert.equal(sumCounts(h.store.peek()), 3);
});

test('provider/model and conversation identity are isolated incident buckets', async () => {
  const h = createHarness();
  h.select(KEY, 'p1', 'm1');
  h.liveStart(1, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 }));
  await h.drain();

  h.select(KEY, 'p2', 'm1');
  h.liveStart(2, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 2, step: 1 }));
  await h.drain();

  h.select(KEY, 'p1', 'm2');
  h.liveStart(3, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 3, step: 1 }));
  await h.drain();

  h.select(KEY_B, 'p1', 'm1');
  h.liveStart(1, 1, KEY_B, SID);
  h.runtime.observe(KEY_B, SID, h.quotaError({ turn: 1, step: 1, key: KEY_B }));
  await h.drain();

  assert.equal(h.sends.length, 4);
  assert.equal(sumCounts(h.store.peek()), 4);
  assert.equal(new Set(entryIds(h.store.peek())).size, 4);

  h.select(KEY, 'p1', 'm1');
  h.liveStart(4, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 4, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 4);
  assert.equal(sumCounts(h.store.peek()), 4);
});

test('malformed persisted state fails closed without overwriting it', async () => {
  const corrupt = { version: 1, entries: 'not-an-array' };
  const h = createHarness({ initialState: corrupt });
  h.liveStart(1, 1);
  const result = h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 }));
  assert.equal(result.handled, true);
  await h.drain();
  assert.equal(h.sends.length, 0);
  assert.equal(h.store.saveCount, 0);
  assert.equal(h.store.peek(), corrupt);
  assert.ok(h.policyLogs.every((line) => !line.includes('not-an-array')));
});

test('throwing load fails closed and never throws into the caller', async () => {
  const h = createHarness({ loadError: new Error('disk read failed') });
  h.liveStart(1, 1);
  let result;
  assert.doesNotThrow(() => {
    result = h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 }));
  });
  assert.equal(result.handled, true);
  await h.drain();
  assert.equal(h.sends.length, 0);
  assert.equal(h.store.saveCount, 0);
  assert.ok(h.policyLogs.every((line) => !line.includes('disk read failed')));
});

test('save failure fails closed: handled, no notice, no throw', async () => {
  const h = createHarness({ failSave: true });
  h.liveStart(1, 1);
  let result;
  assert.doesNotThrow(() => {
    result = h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 }));
  });
  assert.equal(result.handled, true);
  await h.drain();
  assert.equal(h.sends.length, 0);
  assert.equal(h.store.saveCount, 0);
  assert.equal(h.store.peek(), null);
  assert.ok(h.policyLogs.every((line) => !line.includes('persist failed')));
});

test('guard rejection immediately before send cancels and rolls back', async () => {
  const h = createHarness();
  h.liveStart(1, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 }));
  h.setGuard(false);
  await h.drain();
  assert.equal(h.sends.length, 0);
  assert.equal(sumCounts(h.store.peek()), 0);

  h.setGuard(true);
  h.liveStart(2, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 2, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 1);
});

test('hydrate establishes history silently without notifying or recovering', async () => {
  const h = createHarness();
  await h.runtime.hydrate(SID, [
    h.turnStart(7, 1),
    h.stepStart(7, 1, 2),
    h.successMessage(7, 1, 3),
  ]);
  assert.equal(h.sends.length, 0);
  assert.equal(h.store.saveCount, 0);
  assert.equal(sumCounts(h.store.peek()), 0);

  const replay = h.runtime.observe(KEY, SID, h.quotaError({ turn: 7, step: 1, seq: 2 }));
  assert.equal(replay.handled, true);
  await h.drain();
  assert.equal(h.sends.length, 0);
  assert.equal(h.store.saveCount, 0);

  h.runtime.observe(KEY, SID, h.turnStart(8, 4));
  h.runtime.observe(KEY, SID, h.stepStart(8, 1, 5));
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 8, step: 1, seq: 6 }));
  await h.drain();
  assert.equal(h.sends.length, 1);
});

test('non-quota errors are never taken over', async () => {
  const h = createHarness();
  const cases = [
    { code: 'rate_limit_exceeded', message: '429 Too Many Requests', status: 429 },
    { code: 'insufficient_permissions', message: 'insufficient permissions' },
    { code: 'unknown_error', message: 'quota' },
    { code: 'unknown_error', message: 'quota_limit reached but not billing' },
    { code: 'token_limit', message: 'max output tokens: 4096' },
  ];
  for (const [index, item] of cases.entries()) {
    const turn = 100 + index;
    h.liveStart(turn, 1);
    const result = h.runtime.observe(
      KEY,
      SID,
      h.nonQuotaError({
        turn,
        step: 1,
        code: item.code,
        message: item.message,
        status: item.status,
      }),
    );
    assert.equal(result.handled, false, item.message + ' must not be handled');
  }
  await h.drain();
  assert.equal(h.sends.length, 0);
  assert.equal(h.store.saveCount, 0);
  assert.equal(sumCounts(h.store.peek()), 0);
});

test('orphan step and missing turn identity never create a trusted request', async () => {
  const h = createHarness();
  h.runtime.observe(KEY, SID, h.stepStart(1, 1));
  assert.equal(h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 })).handled, true);
  await h.drain();
  assert.equal(h.sends.length, 0);
  h.liveStart(2, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 0);
});

test('late error from another turn cannot end the current trusted turn', async () => {
  const h = createHarness();
  h.liveStart(2, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 }));
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 2, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 1);
});

test('changed desired selection must not relabel an old actual request', async () => {
  const h = createHarness();
  h.runtime.observe(KEY, SID, { seq: h.seq(), type: 'model/selection', data: { provider: 'p1', model: 'm1' } });
  h.liveStart(1, 1);
  h.select(KEY, 'p2', 'm2');
  h.runtime.observe(KEY, SID, h.stepStart(1, 2));
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 2 }));
  await h.drain();
  assert.equal(h.sends.length, 0);
  assert.equal(sumCounts(h.store.peek()), 0);
});

test('runtime persists dispatch time after queue delay before sending', async () => {
  const h = createHarness();
  h.liveStart(1, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 }));
  h.advance(120000);
  await h.drain();
  assert.equal(h.store.peek().entries[0].lastAt, BASE_TIME + 120000);
  h.advance(480000);
  h.liveStart(2, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 2, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 1);
  h.advance(120000);
  h.liveStart(3, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 3, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 2);
});

test('real wrapped snapshot records permit a new live terminal without a step field', async () => {
  const h = createHarness();
  const records = [
    { seq: 100, type: 'model/selection', data: { provider: 'p1', model: 'm1' } },
    { seq: 101, type: 'turn/start', data: { turn: 7 } },
    { seq: 102, type: 'step/start', data: { turn: 7, step: 1 } },
  ];
  h.runtime.hydrate(SID, records.map(event => ({ type: 'event', event })));
  assert.equal(h.sends.length, 0);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 7, seq: 103 }));
  await h.drain();
  assert.equal(h.sends.length, 1);
});

test('live frames without seq still require a trusted start and do not double-send', async () => {
  const h = createHarness();
  h.runtime.observe(KEY, SID, { type: 'turn/start', data: { turn: 1 } });
  h.runtime.observe(KEY, SID, { type: 'step/start', data: { turn: 1, step: 1 } });
  const end = { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'insufficient_quota' } } } };
  assert.equal(h.runtime.observe(KEY, SID, end).handled, true);
  assert.equal(h.runtime.observe(KEY, SID, end).handled, true);
  await h.drain();
  assert.equal(h.sends.length, 1);
});

test('model selection for NEXT request cannot relabel the active request', async () => {
  const h = createHarness();
  h.liveStart(1, 1);
  h.runtime.observe(KEY, SID, { seq: h.seq(), type: 'request/header', data: { header: { config: { provider: 'p1', model: 'm1' } } } });
  h.select(KEY, 'p2', 'm2');
  h.runtime.observe(KEY, SID, { seq: h.seq(), type: 'model/selection', data: { provider: 'p2', model: 'm2' } });
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 0, 'old actual request must not notify for the newly selected model');
  h.liveStart(2, 1);
  h.runtime.observe(KEY, SID, { seq: h.seq(), type: 'request/header', data: { header: { config: { provider: 'p2', model: 'm2' } } } });
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 2, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 1, 'new actual request can notify for the new model');
});

test('interrupted assistant messages are partial output, not proof of recovery', async () => {
  const h = createHarness();
  h.liveStart(1, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 }));
  await h.drain();
  h.liveStart(2, 1);
  const partial = h.successMessage(2, 1);
  partial.data.interrupted = true;
  h.runtime.observe(KEY, SID, partial);
  assert.equal(sumCounts(h.store.peek()), 1);
});

test('successful assistant source is authoritative even if step start was missed', async () => {
  const h = createHarness();
  h.liveStart(1, 1);
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 1, step: 1 }));
  await h.drain();
  h.select(KEY, 'p2', 'm2');
  h.runtime.observe(KEY, SID, h.turnStart(2));
  const done = h.successMessage(2, 1);
  done.data.message.source = { provider: 'p1', model: 'm1' };
  h.runtime.observe(KEY, SID, done);
  assert.equal(sumCounts(h.store.peek()), 0, 'actual source p1/m1 recovered, not the newly desired model');
});

test('a trusted request header and terminal step can fill a missing step-start frame', async () => {
  const h = createHarness();
  h.runtime.observe(KEY, SID, h.turnStart(0));
  h.runtime.observe(KEY, SID, { seq: h.seq(), type: 'request/header', data: { header: { config: { provider: 'p1', model: 'm1' } } } });
  h.runtime.observe(KEY, SID, h.quotaError({ turn: 0, step: 1 }));
  await h.drain();
  assert.equal(h.sends.length, 1);
});
