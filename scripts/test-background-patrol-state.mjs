import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const stateUrl = new URL('../src/core/background-patrol-state.mjs', import.meta.url);
const BJT_OFFSET = 8 * 60 * 60 * 1000;

let api;
try {
  api = await import(stateUrl.href);
} catch (error) {
  assert.fail(`missing state feature: ${error?.code ?? error?.name ?? 'Error'}: ${error?.message ?? error}`);
}

const { createBackgroundPatrolState, beijingPatrolDayKey, BACKGROUND_PATROL_BUCKETS, PATROL_STATE_VERSION } = api;
assert.equal(typeof createBackgroundPatrolState, 'function', 'missing state feature: createBackgroundPatrolState');
assert.equal(typeof beijingPatrolDayKey, 'function', 'missing state feature: beijingPatrolDayKey');

function bjt(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - BJT_OFFSET;
}

async function exists(file) {
  try { await fs.stat(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function refused(operation, expectedReason) {
  try {
    const result = await operation();
    assert.equal(result?.ok, false, `expected rejection or explicit refusal, got ${JSON.stringify(result)}`);
    if (expectedReason) assert.equal(result.reason, expectedReason);
    return result;
  } catch (error) {
    return error;
  }
}

async function harness(t, at = bjt(2026, 10, 24, 10)) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-patrol-state-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'background-patrol-state.json');
  let now = at;
  const make = (ops) => createBackgroundPatrolState({
    filePath,
    clock: { now: () => now },
    ...(ops ? { fsOps: ops } : {})
  });
  return { dir, filePath, make, setNow: (value) => { now = value; }, now: () => now };
}

test('fixed Beijing day key and budget table are independent of host timezone', () => {
  assert.equal(PATROL_STATE_VERSION, 1);
  assert.deepEqual(BACKGROUND_PATROL_BUCKETS, {
    tieba: { read: { dailyCap: 6, minIntervalMs: 0 } },
    xiaoheihe: {
      read: { dailyCap: 14, minIntervalMs: 0 },
      post: { dailyCap: 2, minIntervalMs: 3 * 60 * 60 * 1000 },
      comment: { dailyCap: 12, minIntervalMs: 3 * 60 * 1000 }
    }
  });
  assert.equal(beijingPatrolDayKey(Date.UTC(2025, 11, 31, 15, 59, 59, 999)), '2025-12-31');
  assert.equal(beijingPatrolDayKey(Date.UTC(2025, 11, 31, 16, 0, 0, 0)), '2026-01-01');
  assert.equal(beijingPatrolDayKey(bjt(2024, 2, 29, 23, 59)), '2024-02-29');
});

test('missing file remains absent until first successful reservation and survives restart', async (t) => {
  const h = await harness(t);
  const state = h.make();
  await state.load();
  assert.equal(await exists(h.filePath), false);
  const before = await state.snapshot();
  assert.equal(before.day, '2026-10-24');
  assert.equal(await exists(h.filePath), false);
  assert.equal((await state.tryConsume({ platform: 'tieba', bucket: 'read' })).ok, true);
  assert.equal(await exists(h.filePath), true);
  const restarted = h.make();
  await restarted.load();
  for (let i = 0; i < 5; i += 1) assert.equal((await restarted.tryConsume({ platform: 'tieba', bucket: 'read' })).ok, true);
  await refused(() => restarted.tryConsume({ platform: 'tieba', bucket: 'read' }), 'daily-cap');
});

test('only fixed platform buckets may consume a quota', async (t) => {
  const h = await harness(t); const state = h.make(); await state.load();
  await assert.rejects(() => state.tryConsume({ platform: 'tieba', bucket: 'post' }));
  await assert.rejects(() => state.tryConsume({ platform: 'xiaoheihe', bucket: 'reply' }));
  await assert.rejects(() => state.tryConsume({ platform: 'other', bucket: 'read' }));
  assert.equal(await exists(h.filePath), false);
});

test('daily counters reset at Beijing midnight but a post interval crosses the date boundary', async (t) => {
  const late = bjt(2026, 10, 24, 23, 59, 0);
  const h = await harness(t, late); const state = h.make(); await state.load();
  assert.equal((await state.tryConsume({ platform: 'xiaoheihe', bucket: 'post' })).ok, true);
  h.setNow(bjt(2026, 10, 25, 0, 1, 0));
  await refused(() => state.tryConsume({ platform: 'xiaoheihe', bucket: 'post' }), 'min-interval');
  h.setNow(late + 3 * 60 * 60 * 1000);
  assert.equal((await state.tryConsume({ platform: 'xiaoheihe', bucket: 'post' })).ok, true);
  const snapshot = await state.snapshot();
  assert.equal(snapshot.day, '2026-10-25');
  assert.equal(snapshot.platforms.xiaoheihe.daily.post, 1);
});

test('separate buckets keep independent daily budgets and comment interval is enforced', async (t) => {
  const h = await harness(t); const state = h.make(); await state.load();
  const at = h.now();
  assert.equal((await state.tryConsume({ platform: 'xiaoheihe', bucket: 'comment' })).ok, true);
  await refused(() => state.tryConsume({ platform: 'xiaoheihe', bucket: 'comment' }), 'min-interval');
  h.setNow(at + 3 * 60 * 1000);
  assert.equal((await state.tryConsume({ platform: 'xiaoheihe', bucket: 'comment' })).ok, true);
  assert.equal((await state.tryConsume({ platform: 'xiaoheihe', bucket: 'read' })).ok, true);
  assert.equal((await state.tryConsume({ platform: 'tieba', bucket: 'read' })).ok, true);
});

test('twenty concurrent cap-six reservations admit exactly six and persist them', async (t) => {
  const h = await harness(t); const state = h.make(); await state.load();
  const outcomes = await Promise.all(Array.from({ length: 20 }, () => state.tryConsume({ platform: 'tieba', bucket: 'read' })));
  assert.equal(outcomes.filter((entry) => entry.ok).length, 6);
  assert.equal(outcomes.filter((entry) => entry.reason === 'daily-cap').length, 14);
  const restarted = h.make(); await restarted.load();
  await refused(() => restarted.tryConsume({ platform: 'tieba', bucket: 'read' }), 'daily-cap');
});

test('clock rollback fails closed and cannot restore an old daily budget', async (t) => {
  const h = await harness(t); const state = h.make(); await state.load();
  for (let i = 0; i < 6; i += 1) assert.equal((await state.tryConsume({ platform: 'tieba', bucket: 'read' })).ok, true);
  h.setNow(bjt(2026, 10, 23, 23));
  await refused(() => state.tryConsume({ platform: 'tieba', bucket: 'read' }), 'clock-rollback');
  h.setNow(bjt(2026, 10, 24, 11));
  await refused(() => state.tryConsume({ platform: 'tieba', bucket: 'read' }), 'daily-cap');
});

test('out-of-range and far-future timestamps cannot corrupt or advance the persisted day', async (t) => {
  const h = await harness(t); const state = h.make(); await state.load();
  assert.equal((await state.tryConsume({ platform: 'tieba', bucket: 'read' })).ok, true);
  const before = await fs.readFile(h.filePath, 'utf8');
  await assert.rejects(() => state.tryConsume({ platform: 'tieba', bucket: 'read', at: 1_700_000_000_000_000 }));
  await assert.rejects(() => state.tryConsume({ platform: 'tieba', bucket: 'read', at: h.now() + 4 * 60 * 1000 }));
  await assert.rejects(() => state.setNextAt('tieba', h.now() + 60 * 60 * 1000, h.now() + 24 * 60 * 60 * 1000));
  assert.equal(await fs.readFile(h.filePath, 'utf8'), before);
  assert.equal((await state.snapshot()).day, '2026-10-24');
  assert.equal((await state.snapshot()).platforms.tieba.daily.read, 1);
  assert.throws(() => beijingPatrolDayKey(1_700_000_000_000_000));
});

test('next schedule, status and report attempts persist; status cannot reset usage or persist secrets', async (t) => {
  const h = await harness(t); const state = h.make(); await state.load();
  assert.equal((await state.tryConsume({ platform: 'tieba', bucket: 'read' })).ok, true);
  const nextAt = h.now() + 60 * 60 * 1000;
  await state.setNextAt('tieba', nextAt);
  await state.noteReportAttempt('tieba');
  await state.setPlatformStatus('xiaoheihe', {
    paused: true, pausedReason: 'captcha', consecutiveWriteFailures: 3, pausedAt: h.now(),
    cookie: 'must-not-persist', token: 'must-not-persist', rawResponse: 'must-not-persist'
  });
  const snap = await state.snapshot();
  assert.equal(snap.platforms.tieba.daily.read, 1);
  assert.equal(snap.platforms.tieba.reportAttempts, 1);
  assert.equal(snap.platforms.tieba.nextAt, nextAt);
  assert.equal(snap.platforms.xiaoheihe.status.paused, true);
  assert.equal(snap.platforms.xiaoheihe.status.pausedReason, 'captcha');
  snap.platforms.tieba.daily.read = 0;
  assert.equal((await state.snapshot()).platforms.tieba.daily.read, 1);
  await state.setPlatformStatus('xiaoheihe', { paused: false, resumedAt: h.now() + 1 });
  assert.equal((await state.snapshot()).platforms.tieba.daily.read, 1);
  const raw = await fs.readFile(h.filePath, 'utf8');
  assert.equal(/must-not-persist|cookie|token|rawResponse/i.test(raw), false);
  await assert.rejects(() => state.setPlatformStatus('xiaoheihe', { pausedReason: 'cookie=must-not-persist' }));
  await assert.rejects(() => state.setNextAt('tieba', h.now()));
});

test('corrupt, empty and unknown-version state permanently refuse operations without overwriting bytes', async (t) => {
  const h = await harness(t);
  for (const content of ['', '{bad', JSON.stringify({ schemaVersion: 999 })]) {
    await fs.writeFile(h.filePath, content, 'utf8');
    const state = h.make();
    await assert.rejects(() => state.load());
    await assert.rejects(() => state.snapshot());
    await assert.rejects(() => state.tryConsume({ platform: 'tieba', bucket: 'read' }));
    assert.equal(await fs.readFile(h.filePath, 'utf8'), content);
  }
});

test('non-ENOENT read failures permanently fail closed and never create or overwrite state', async (t) => {
  const h = await harness(t);
  const denied = h.make({
    ...fs,
    readFile: async () => { const error = new Error('permission denied'); error.code = 'EACCES'; throw error; }
  });
  await assert.rejects(() => denied.load());
  await assert.rejects(() => denied.load());
  await assert.rejects(() => denied.snapshot());
  await assert.rejects(() => denied.tryConsume({ platform: 'tieba', bucket: 'read' }));
  assert.equal(await exists(h.filePath), false);
});

test('failed atomic replacement keeps old memory/file and does not poison later queue work', async (t) => {
  const h = await harness(t);
  let failRename = false;
  const state = h.make({
    ...fs,
    rename: async (...args) => {
      if (failRename) { const error = new Error('simulated lock'); error.code = 'EPERM'; throw error; }
      return fs.rename(...args);
    }
  });
  await state.load();
  assert.equal((await state.tryConsume({ platform: 'tieba', bucket: 'read' })).ok, true);
  const before = await fs.readFile(h.filePath, 'utf8');
  failRename = true;
  await assert.rejects(() => state.tryConsume({ platform: 'tieba', bucket: 'read' }));
  assert.equal(await fs.readFile(h.filePath, 'utf8'), before);
  assert.equal((await state.snapshot()).platforms.tieba.daily.read, 1);
  failRename = false;
  assert.equal((await state.tryConsume({ platform: 'tieba', bucket: 'read' })).ok, true);
  assert.equal((await state.snapshot()).platforms.tieba.daily.read, 2);
});
