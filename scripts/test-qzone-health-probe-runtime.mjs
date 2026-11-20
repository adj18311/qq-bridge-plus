import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { runQzoneHealthProbe } from '../src/core/qzone-health-probe-runtime.mjs';

const now = 1000 + 86400000;
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-health-runtime-'));
  let db = openOfflineStore(join(dir, 'state.db'), {
    enabled: true, accessPaused: true, writePaused: true, pausedAt: 1000,
    botQq: '456', selfId: '456', probe: 'waiting', notices: [], audit: [], used: { post: 2 }, ...overrides
  });
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  return { get db() { return db; }, close() { db.close(); }, reopen() { db.close(); db = openOfflineStore(join(dir, 'state.db')); } };
}

test('only one eligible 24h active-window attempt is claimed, audited, and successful recovery preserves quota', async (t) => {
  const f = await fixture(t); let calls = 0;
  const deps = { store: f.db, now: () => now, adminQq: '123', botQq: '456', serviceReady: () => true,
    activeTime: () => true, readOwnSpace: async ({ targetQq }) => { calls++; return { status: 'ok', selfQq: '456', targetQq }; } };
  const result = await runQzoneHealthProbe(deps);
  assert.equal(result.status, 'recovered');
  assert.equal(calls, 1);
  assert.equal(f.db.read().accessPaused, false);
  assert.equal(f.db.read().writePaused, false);
  assert.equal(f.db.read().used.post, 2);
  assert.deepEqual(f.db.read().audit.map(x => x.record.result), ['unknown', 'success']);
  assert.equal((await runQzoneHealthProbe(deps)).status, 'not_eligible');
  assert.equal(calls, 1);
});

test('bot identity and administrator target are checked separately; mismatch queues notice without sending', async (t) => {
  const f = await fixture(t); let sends = 0;
  const result = await runQzoneHealthProbe({ store: f.db, now: () => now, adminQq: '123', botQq: '456',
    serviceReady: () => true, activeTime: () => true, notifyAdmin: async () => { sends++; },
    readOwnSpace: async ({ targetQq }) => ({ status: 'ok', selfQq: '999', targetQq, raw: 'secret-token' }) });
  assert.equal(result.status, 'failed');
  assert.equal(f.db.read().probe, 'manual_only');
  assert.equal(f.db.read().accessPaused, true);
  assert.equal(sends, 0);
  assert.equal(f.db.read().notices.length, 1);
  assert.equal(f.db.read().notices[0].cause, 'probe_failed');
  assert.doesNotMatch(JSON.stringify(f.db.read().audit), /secret-token|999999/);
  assert.equal((await runQzoneHealthProbe({ store: f.db, now: () => now, adminQq: '123', botQq: '456',
    serviceReady: () => true, activeTime: () => true, readOwnSpace: async () => { throw Error('must not retry'); } })).status, 'not_eligible');
});

test('unknown adapter outcome fails closed and overlapping calls stay single flight', async (t) => {
  const f = await fixture(t); let release; let calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const deps = { store: f.db, now: () => now, adminQq: '123456', botQq: '456', serviceReady: () => true,
    activeTime: () => true, readOwnSpace: async () => { calls++; await pending; return { status: 'unknown' }; } };
  const first = runQzoneHealthProbe(deps);
  const second = await runQzoneHealthProbe(deps);
  assert.equal(second.status, 'in_flight');
  assert.equal(calls, 1);
  release();
  assert.equal((await first).status, 'unknown');
  assert.equal(f.db.read().probe, 'manual_only');
  assert.equal(f.db.read().notices[0].cause, 'probe_failed');
});

test('missing or malformed runtime evidence never issues a read', async (t) => {
  const f = await fixture(t); let calls = 0;
  const result = await runQzoneHealthProbe({ store: f.db, now: () => now, adminQq: '123456', botQq: '456',
    serviceReady: () => true, activeTime: () => false, readOwnSpace: async () => { calls++; return { status: 'ok' }; } });
  assert.equal(result.status, 'not_eligible');
  assert.equal(calls, 0);
  assert.equal(f.db.read().probe, 'waiting');
});

test('clock failure before claim cannot leak the exception or mutate state', async (t) => {
  const f = await fixture(t); let calls = 0;
  const result = await runQzoneHealthProbe({ store: f.db, now: () => { throw new Error('Bearer clock-secret'); },
    adminQq: '123', botQq: '456', serviceReady: true, activeTime: true,
    readOwnSpace: async () => { calls++; } });
  assert.equal(result.status, 'not_eligible');
  assert.doesNotMatch(JSON.stringify(result), /clock-secret/);
  assert.equal(calls, 0);
  assert.equal(f.db.read().probe, 'waiting');
});

test('caller supplied bot identity must match persisted botQq and selfId before claim', async (t) => {
  const f = await fixture(t); let calls = 0;
  const result = await runQzoneHealthProbe({ store: f.db, now: () => now, adminQq: '123', botQq: '999',
    serviceReady: () => true, activeTime: () => true,
    readOwnSpace: async () => { calls++; return { status: 'ok', selfQq: '999', targetQq: '123' }; } });
  assert.equal(result.status, 'identity_mismatch');
  assert.equal(calls, 0);
  assert.equal(f.db.read().probe, 'waiting');
  assert.equal(f.db.read().audit.length, 0);
  assert.equal(f.db.read().accessPaused, true);
});

test('persisted identity drift after claim blocks dispatch and fails closed', async (t) => {
  const f = await fixture(t); let calls = 0;
  const pending = runQzoneHealthProbe({ store: f.db, now: () => now, adminQq: '123', botQq: '456',
    serviceReady: () => true, activeTime: () => true,
    readOwnSpace: async () => { calls++; return { status: 'ok', selfQq: '456', targetQq: '123' }; } });
  f.db.update(state => ({ ...state, botQq: '789', selfId: '789' }));
  assert.equal((await pending).status, 'unknown');
  assert.equal(calls, 0);
  assert.equal(f.db.read().probe, 'manual_only');
  assert.equal(f.db.read().accessPaused, true);
});

test('persisted identity drift before success settlement prevents recovery', async (t) => {
  const f = await fixture(t);
  const result = await runQzoneHealthProbe({ store: f.db, now: () => now, adminQq: '123', botQq: '456',
    serviceReady: () => true, activeTime: () => true,
    readOwnSpace: async ({ targetQq }) => {
      f.db.update(state => ({ ...state, botQq: '789', selfId: '789' }));
      return { status: 'ok', selfQq: '456', targetQq };
    } });
  assert.equal(result.status, 'unknown');
  assert.equal(f.db.read().accessPaused, true);
  assert.equal(f.db.read().writePaused, true);
  assert.equal(f.db.read().probe, 'manual_only');
  assert.equal(f.db.read().audit.at(-1).record.result, 'unknown');
});

test('caller mutation cannot rebind an in-flight probe to a different administrator', async (t) => {
  const f = await fixture(t); let release;
  const pending = new Promise(resolve => { release = resolve; });
  const options = { store: f.db, now: () => now, adminQq: '123', botQq: '456', serviceReady: true, activeTime: true,
    readOwnSpace: async () => { await pending; return { status: 'ok', selfQq: '456', targetQq: '999' }; } };
  const running = runQzoneHealthProbe(options);
  await new Promise(resolve => setImmediate(resolve));
  options.adminQq = '999';
  release();
  const result = await running;
  assert.notEqual(result.status, 'recovered');
  assert.equal(f.db.read().accessPaused, true);
  assert.equal(f.db.read().audit[0].record.target, '123');
});

test('identity changed at settlement transaction entry cannot clear pauses', async (t) => {
  const f = await fixture(t); let updates = 0;
  const store = { read: () => f.db.read(), update: fn => f.db.update(state => {
    updates++;
    return fn(updates === 2 ? { ...state, botQq: '789', selfId: '789' } : state);
  }) };
  const result = await runQzoneHealthProbe({ store, now: () => now, adminQq: '123', botQq: '456',
    serviceReady: () => true, activeTime: () => true,
    readOwnSpace: async ({ targetQq }) => ({ status: 'ok', selfQq: '456', targetQq }) });
  assert.equal(result.status, 'unknown');
  assert.equal(f.db.read().accessPaused, true);
  assert.equal(f.db.read().writePaused, true);
  assert.equal(f.db.read().probe, 'manual_only');
  assert.equal(f.db.read().audit.at(-1).record.result, 'unknown');
});

test('timeout aborts the injected read, records unknown/manual-only outbox, and ignores a late success', async (t) => {
  const f = await fixture(t); let finishLate; let observedSignal;
  const resultPromise = runQzoneHealthProbe({ store: f.db, now: () => now, adminQq: '123', botQq: '456',
    serviceReady: () => true, activeTime: () => true, timeoutMs: 15,
    readOwnSpace: ({ targetQq, signal }) => {
      assert.equal(targetQq, '123'); observedSignal = signal;
      return new Promise(resolve => { finishLate = () => resolve({ status: 'ok', selfQq: '456', targetQq }); });
    } });
  const result = await resultPromise;
  assert.equal(result.status, 'unknown');
  assert.equal(observedSignal.aborted, true);
  assert.equal(f.db.read().probe, 'manual_only');
  assert.equal(f.db.read().accessPaused, true);
  assert.equal(f.db.read().notices[0].cause, 'probe_failed');
  finishLate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.db.read().accessPaused, true);
  assert.equal(f.db.read().audit.at(-1).record.result, 'unknown');
  assert.equal((await runQzoneHealthProbe({ store: f.db, now: () => now, adminQq: '123', botQq: '456',
    serviceReady: () => true, activeTime: () => true, readOwnSpace: async () => { throw Error('must not replay'); } })).status, 'not_eligible');
});

test('persistent disable after claim prevents dispatch and terminates the claim as unknown', async (t) => {
  const f = await fixture(t); let calls = 0;
  const pending = runQzoneHealthProbe({ store: f.db, now: () => now, adminQq: '123', botQq: '456',
    serviceReady: () => true, activeTime: () => true,
    readOwnSpace: async () => { calls++; return { status: 'ok', selfQq: '456', targetQq: '123' }; } });
  f.db.update(state => ({ ...state, enabled: false }));
  assert.equal((await pending).status, 'unknown');
  assert.equal(calls, 0);
  assert.equal(f.db.read().probe, 'waiting');
  assert.equal(f.db.read().notices.length, 0);
  assert.deepEqual(f.db.read().audit.map(x => x.record.result), ['unknown', 'denied']);
  assert.equal(f.db.read().audit.at(-1).record.content, 'not_dispatched');
  f.db.update(state => ({ ...state, enabled: true }));
  const resumed = await runQzoneHealthProbe({ store: f.db, now: () => now + 1, adminQq: '123', botQq: '456',
    serviceReady: true, activeTime: true,
    readOwnSpace: async ({ targetQq }) => { calls++; return { status: 'ok', selfQq: '456', targetQq }; } });
  assert.equal(resumed.status, 'recovered');
  assert.equal(calls, 1);
});

test('service readiness and activity are rechecked immediately before dispatch', async (t) => {
  const f = await fixture(t); let calls = 0; let ready = true;
  const pending = runQzoneHealthProbe({ store: f.db, now: () => now, adminQq: '123', botQq: '456',
    serviceReady: () => ready, activeTime: () => true,
    readOwnSpace: async () => { calls++; return { status: 'ok', selfQq: '456', targetQq: '123' }; } });
  ready = false;
  assert.equal((await pending).status, 'unknown');
  assert.equal(calls, 0);
  assert.equal(f.db.read().probe, 'waiting');
  assert.equal(f.db.read().notices.length, 0);
});

test('activity window closing after claim releases opportunity without network failure', async (t) => {
  const f = await fixture(t); let calls = 0; let active = true;
  const pending = runQzoneHealthProbe({ store: f.db, now: () => now, adminQq: '123', botQq: '456',
    serviceReady: () => true, activeTime: () => active,
    readOwnSpace: async () => { calls++; return { status: 'ok', selfQq: '456', targetQq: '123' }; } });
  active = false;
  assert.equal((await pending).status, 'unknown');
  assert.equal(calls, 0);
  assert.equal(f.db.read().probe, 'waiting');
  assert.equal(f.db.read().accessPaused, true);
  assert.equal(f.db.read().notices.length, 0);
  assert.deepEqual(f.db.read().audit.map(x => x.record.result), ['unknown', 'denied']);
});

test('adapter cannot claim no network dispatch by returning a similarly named value', async (t) => {
  const f = await fixture(t);
  const result = await runQzoneHealthProbe({ store: f.db, now: () => now, adminQq: '123', botQq: '456',
    serviceReady: true, activeTime: true, readOwnSpace: async () => ({ kind: 'not_dispatched' }) });
  assert.equal(result.status, 'unknown');
  assert.equal(f.db.read().probe, 'manual_only');
  assert.equal(f.db.read().notices[0].cause, 'probe_failed');
});

test('adapter exception and missing identity attestation stay unknown and queue notices', async (t) => {
  for (const readOwnSpace of [
    async () => { throw Error('sensitive raw failure text'); },
    async ({ targetQq }) => ({ status: 'ok', targetQq })
  ]) {
    const f = await fixture(t);
    const result = await runQzoneHealthProbe({ store: f.db, now: () => now, adminQq: '123', botQq: '456',
      serviceReady: () => true, activeTime: () => true, readOwnSpace });
    assert.equal(result.status, 'unknown');
    assert.equal(f.db.read().probe, 'manual_only');
    assert.equal(f.db.read().notices[0].cause, 'probe_failed');
    assert.doesNotMatch(JSON.stringify(f.db.read().audit), /sensitive raw failure text/);
  }
});
