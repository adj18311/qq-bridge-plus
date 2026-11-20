// TRUE concurrent contention over one SQLite file: two child processes, an IPC barrier, and
// a deterministic lock-overlap handshake.
//
// Why the previous version was not concurrency (Codex was right)
// --------------------------------------------------------------
//   · the two-connection case called `claim()` sequentially in one thread
//   · the two-process case used `spawnSync`, so process 2 started only after process 1 exited
// Both only proved "sequential access to the same file", never "two writers racing".
//
// This file fixes that with async spawn + a barrier:
//   1. parent starts two children
//   2. each child opens the DB, claims NOTHING, and sends `ready`
//   3. parent waits for BOTH `ready`, then broadcasts `go` to both
//   4. each child claims the same key and reports the outcome
//   5. parent asserts exactly one success; a third child then verifies final state
//
// Bounded everywhere: per-child timeout, hard overall timeout, and cleanup in `finally`, so a
// stuck child can never hang the runner.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { initializeReplayState, createReplayClaimer } from '../src/core/qzone-replay-claim-offline.mjs';

const ACCOUNT = 9876543210;
const STORE_URL = new URL('../src/core/qzone-store-offline.mjs', import.meta.url).href;
const REPLAY_URL = new URL('../src/core/qzone-replay-claim-offline.mjs', import.meta.url).href;

const CHILD_SOURCE = (childIndex) => `
import { openOfflineStore } from ${JSON.stringify(STORE_URL)};
import { createReplayClaimer } from ${JSON.stringify(REPLAY_URL)};
const [dbPath, accountId, callId] = process.argv.slice(2);
const send = (msg) => process.send ? process.send(msg) : process.stdout.write(JSON.stringify(msg) + '\\n');
// 1. open + report ready BEFORE any claim, so the parent can barrier the race.
const store = openOfflineStore(dbPath, {});
const claimer = createReplayClaimer({ store, accountId: Number(accountId) });
send({ type: 'ready', child: ${childIndex} });
// 2. wait for the parent's go.
process.on('message', (m) => {
  if (!m || m.type !== 'go') return;
  let out;
  try {
    out = claimer.claim({ sessionId: 's1', requestId: 'r1', callId }, { now: Number(m.now) });
  } catch (e) {
    out = { ok: false, reason: 'threw', message: String(e && e.message) };
  }
  try { store.close(); } catch {}
  send({ type: 'done', child: ${childIndex }, outcome: out });
  setTimeout(() => process.exit(0), 30);
});
`;

function writeChild(dir, index) {
  const p = path.join(dir, `racer-${index}.mjs`);
  fs.writeFileSync(p, CHILD_SOURCE(index), 'utf8');
  return p;
}

/** Spawn a child with an IPC channel and a hard timeout. */
function spawnRacer(scriptPath, args, timeoutMs = 20_000) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const events = [];
  const stderr = [];
  child.stdout.on('data', (b) => { for (const line of String(b).split('\n')) { if (line.trim()) try { events.push(JSON.parse(line)); } catch {} } });
  child.stderr.on('data', (b) => stderr.push(String(b)));
  child.on('message', (m) => events.push(m));
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve('timeout'); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  return { child, events, stderr, done };
}

const waitFor = async (racer, predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (racer.events.some(predicate)) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};

test('C1 真正的两进程并发争同一键：屏障同步后恰好一个成功', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-b2-race-'));
  let a, b;
  try {
    const dbPath = path.join(dir, 'state.db');
    // Prepare an initialized DB in the parent, then close it.
    const store = openOfflineStore(dbPath, { enabled: false });
    initializeReplayState(store, { now: 1000 });
    store.close();

    const scriptA = writeChild(dir, 0);
    const scriptB = writeChild(dir, 1);
    a = spawnRacer(scriptA, [dbPath, String(ACCOUNT), 'c-race']);
    b = spawnRacer(scriptB, [dbPath, String(ACCOUNT), 'c-race']);

    // Barrier: BOTH must have opened the DB and be idle before either may claim.
    assert.equal(await waitFor(a, (e) => e.type === 'ready'), true, 'child A 必须报告 ready');
    assert.equal(await waitFor(b, (e) => e.type === 'ready'), true, 'child B 必须报告 ready');

    // Release both. `now` differs only for audit; the decision is key existence.
    a.child.send({ type: 'go', now: 1100 });
    b.child.send({ type: 'go', now: 1150 });

    assert.equal(await waitFor(a, (e) => e.type === 'done'), true, 'child A 必须给出结果');
    assert.equal(await waitFor(b, (e) => e.type === 'done'), true, 'child B 必须给出结果');

    const outcomes = [a, b].map((r) => r.events.find((e) => e.type === 'done').outcome);
    const wins = outcomes.filter((o) => o.ok === true);
    const replays = outcomes.filter((o) => o.reason === 'replay');
    assert.equal(wins.length, 1, `真正的并发下恰好一个成功，实际 ${JSON.stringify(outcomes)}`);
    assert.equal(replays.length, 1, '另一个必须是 replay');
    assert.equal(wins[0].ok, true);

    // The PARENT (not a third process) re-opens the database to verify the final state:
    // exactly one key, and the same key is still refused.
    const check = openOfflineStore(dbPath, {});
    const claimer = createReplayClaimer({ store: check, accountId: ACCOUNT });
    assert.equal(claimer.size(), 1, '最终集合里只有一个键');
    assert.equal(claimer.claim({ sessionId: 's1', requestId: 'r1', callId: 'c-race' }, { now: 9999 }).reason, 'replay');
    check.close();
  } finally {
    try { a?.child.kill(); } catch {}
    try { b?.child.kill(); } catch {}
    await Promise.allSettled([a?.done, b?.done]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('C2 并发争不同键：两边都成功（并发不是"全都拒"）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-b2-race2-'));
  let a, b;
  try {
    const dbPath = path.join(dir, 'state.db');
    const store = openOfflineStore(dbPath, {});
    initializeReplayState(store, { now: 1000 });
    store.close();

    const scriptA = writeChild(dir, 0);
    const scriptB = writeChild(dir, 1);
    a = spawnRacer(scriptA, [dbPath, String(ACCOUNT), 'c-left']);
    b = spawnRacer(scriptB, [dbPath, String(ACCOUNT), 'c-right']);
    assert.equal(await waitFor(a, (e) => e.type === 'ready'), true);
    assert.equal(await waitFor(b, (e) => e.type === 'ready'), true);
    a.child.send({ type: 'go', now: 1100 });
    b.child.send({ type: 'go', now: 1100 });
    assert.equal(await waitFor(a, (e) => e.type === 'done'), true);
    assert.equal(await waitFor(b, (e) => e.type === 'done'), true);

    const outcomes = [a, b].map((r) => r.events.find((e) => e.type === 'done').outcome);
    assert.deepEqual(outcomes.map((o) => o.ok), [true, true], `不同键应都成功：${JSON.stringify(outcomes)}`);

    const check = openOfflineStore(dbPath, {});
    assert.equal(createReplayClaimer({ store: check, accountId: ACCOUNT }).size(), 2, '两个键都在');
    check.close();
  } finally {
    try { a?.child.kill(); } catch {}
    try { b?.child.kill(); } catch {}
    await Promise.allSettled([a?.done, b?.done]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('C3 确定性锁重叠：外部持 BEGIN IMMEDIATE 时 claim 必须 busy 失败，释放后恢复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-b2-lock-'));
  try {
    const dbPath = path.join(dir, 'state.db');
    const setup = openOfflineStore(dbPath, {});
    initializeReplayState(setup, { now: 1000 });
    setup.close();

    // OPEN the store first. `openOfflineStore` itself takes BEGIN IMMEDIATE, so if the
    // external lock were taken first, opening would fail — that would test "cannot open",
    // not "cannot claim". Order matters for what this case claims to prove.
    const store = openOfflineStore(dbPath, {});
    const claimer = createReplayClaimer({ store, accountId: ACCOUNT });

    // Now hold an exclusive write transaction from a SEPARATE connection, keeping the
    // short busy timeout so this test cannot stall the runner for seconds.
    const { DatabaseSync } = await import('node:sqlite');
    const holder = new DatabaseSync(dbPath);
    holder.exec('PRAGMA busy_timeout=200');
    holder.exec('BEGIN IMMEDIATE');          // lock held

    // The store sets PRAGMA busy_timeout=5000 at open, but this holder only holds briefly;
    // either way the important assertion is: the claim throws, and the caller must not send.
    let threw = null;
    try {
      claimer.claim({ sessionId: 's1', requestId: 'r1', callId: 'c-lock' }, { now: 1100 });
    } catch (error) { threw = error; }

    // Release the lock regardless, so the test cannot leak it.
    try { holder.exec('ROLLBACK'); } catch {}
    holder.close();

    try {
      // This MUST have thrown: the point of the case is that a real store.update hit a real
      // lock. "It worked in the end" is not evidence the busy path was taken.
      assert.ok(threw, '外部持锁时 claim 必须抛错，否则这个用例没有测到 busy 路径');
      assert.match(String(threw.message), /locked|busy/i, `busy 错误应可识别，实际：${threw.message}`);
      assert.equal(claimer.size(), 0, '失败的 claim 不得留下键');
      // After the lock is released, a normal claim must succeed.
      assert.deepEqual(claimer.claim({ sessionId: 's1', requestId: 'r1', callId: 'c-lock' }, { now: 1200 }), { ok: true });
    } finally {
      try { store.close(); } catch {}
    }
  } finally {
    // Windows keeps the file locked briefly after close; retry the cleanup instead of
    // failing the test on a transient EPERM.
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
  }
});
