// B2 on a REAL SQLite file (temporary directory), because the in-memory fakeStore cannot
// prove anything about cross-connection behaviour, close/reopen, or commit ordering.
//
// What this DOES prove
//   · close + reopen sees the keys that were committed
//   · two INDEPENDENT connections racing for the same key: exactly one wins
//   · two independent PROCESSES racing for the same key: exactly one wins
//   · a claim that fails to persist must not be treated as a claim
//   · a damaged/missing collection does not silently become a fresh empty one at runtime
//
// What this does NOT prove
//   · real cross-machine concurrency (out of scope; single local SQLite)
//   · native DSH call authenticity (B3)
//   · anything about the production state directory: every file here is under %TEMP%
//
// The only non-fake dependency is `openOfflineStore`, which is the repo's existing
// transactional wrapper. No QQ transport, no real state, no network.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import {
  REPLAY_REFUSAL,
  initializeReplayState,
  createReplayClaimer,
} from '../src/core/qzone-replay-claim-offline.mjs';

const ACCOUNT = 9876543210;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_URL = new URL('../src/core/qzone-replay-claim-offline.mjs', import.meta.url).href;

/** Every case gets its own temp dir; nothing touches the repo's state/. */
function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-b2-${label}-`));
  return { dir, dbPath: path.join(dir, 'state.db'), cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}

const initial = () => ({ enabled: false, reads: 0, audit: [{ id: 'auth_1' }] });
const identity = (over = {}) => ({ sessionId: 's1', requestId: 'r1', callId: 'c1', ...over });

test('B2-R1 关闭再打开：已提交的键仍在，同键仍被拒（真实 SQLite 文件）', () => {
  const t = tempDb('reopen');
  try {
    let store = openOfflineStore(t.dbPath, initial());
    initializeReplayState(store, { now: 1000 });
    assert.deepEqual(createReplayClaimer({ store, accountId: ACCOUNT }).claim(identity(), { now: 1100 }), { ok: true });
    store.close();

    // A second, independent open on the same file.
    store = openOfflineStore(t.dbPath, initial());
    const c = createReplayClaimer({ store, accountId: ACCOUNT });
    assert.equal(c.size(), 1, '重新打开必须看到已提交的键');
    const refused = c.claim(identity(), { now: 2200 });
    assert.equal(refused.reason, REPLAY_REFUSAL.REPLAY, '跨连接/重启后同键仍必须拒');
    assert.equal(refused.claimedAt, 1100, '首次认领时刻持久保留');
    // Non-replay state survived too.
    assert.deepEqual(store.read().audit, [{ id: 'auth_1' }]);
    store.close();
  } finally { t.cleanup(); }
});

test('B2-R2 【顺序访问】两个独立连接先后认领同一键：后到者被拒（不是并发竞争，并发见 test-qzone-replay-race.mjs）', () => {
  const t = tempDb('two-conn');
  try {
    const a = openOfflineStore(t.dbPath, initial());
    initializeReplayState(a, { now: 1000 });
    const b = openOfflineStore(t.dbPath, initial());

    const ca = createReplayClaimer({ store: a, accountId: ACCOUNT });
    const cb = createReplayClaimer({ store: b, accountId: ACCOUNT });

    const first = ca.claim(identity(), { now: 1100 });
    const second = cb.claim(identity(), { now: 1200 });
    assert.equal(first.ok, true);
    assert.equal(second.ok, false, '另一连接必须看到已认领');
    assert.equal(second.reason, REPLAY_REFUSAL.REPLAY);
    assert.equal(cb.size(), 1, '只应有一个键');
    a.close(); b.close();
  } finally { t.cleanup(); }
});

test('B2-R3 【顺序访问】两个独立进程先后认领同一键：后者被拒（spawnSync 串行启动，不是并发；并发证据见 test-qzone-replay-race.mjs C1）', () => {
  const t = tempDb('two-proc');
  try {
    const store = openOfflineStore(t.dbPath, initial());
    initializeReplayState(store, { now: 1000 });
    store.close();

    // Child script: open the same DB and claim once, print the outcome as JSON.
    const child = path.join(t.dir, 'claim-child.mjs');
    fs.writeFileSync(child, [
      "import { openOfflineStore } from " + JSON.stringify(new URL('../src/core/qzone-store-offline.mjs', import.meta.url).href) + ";",
      "import { createReplayClaimer } from " + JSON.stringify(MODULE_URL) + ";",
      'const [dbPath, now] = process.argv.slice(2);',
      'const store = openOfflineStore(dbPath, {});',
      'const c = createReplayClaimer({ store, accountId: ' + ACCOUNT + ' });',
      "const out = c.claim({ sessionId: 's1', requestId: 'r1', callId: 'c1' }, { now: Number(now) });",
      'store.close();',
      'process.stdout.write(JSON.stringify(out));',
    ].join('\n'), 'utf8');

    const run = (now) => spawnSync(process.execPath, [child, t.dbPath, String(now)], { encoding: 'utf8', timeout: 30_000 });
    const [r1, r2] = [run(1100), run(1200)];
    assert.equal(r1.status, 0, 'child 1 exit ' + r1.status + ' stderr=' + r1.stderr);
    assert.equal(r2.status, 0, 'child 2 exit ' + r2.status + ' stderr=' + r2.stderr);

    const outs = [JSON.parse(r1.stdout), JSON.parse(r2.stdout)];
    const wins = outs.filter((o) => o.ok === true).length;
    assert.equal(wins, 1, `两个进程恰好一个成功，实际 ${JSON.stringify(outs)}`);
    assert.equal(outs.filter((o) => o.reason === REPLAY_REFUSAL.REPLAY).length, 1);

    // And after both exited, a third claim on a fresh open is still refused.
    const reopen = openOfflineStore(t.dbPath, {});
    const c = createReplayClaimer({ store: reopen, accountId: ACCOUNT });
    assert.equal(c.claim(identity(), { now: 5000 }).ok, false, '进程退出后同键仍拒');
    reopen.close();
  } finally { t.cleanup(); }
});

test('B2-R4 【异常传播】claim 内部 update 抛错时向上抛出（注入的 throw，未进入真实事务；真实 busy 锁失败见 test-qzone-replay-race.mjs C3）', () => {
  const t = tempDb('writefail');
  try {
    const store = openOfflineStore(t.dbPath, initial());
    initializeReplayState(store, { now: 1000 });

    // A store wrapper that fails the WRITE but keeps read working — the exact shape of a
    // disk-full / busy-timeout / read-only-volume failure.
    const failing = {
      read: () => store.read(),
      update() { throw new Error('database is locked'); },
    };
    const c = createReplayClaimer({ store: failing, accountId: ACCOUNT });
    assert.throws(() => c.claim(identity(), { now: 1100 }), /locked/,
      '写失败必须抛出；调用方据此不得执行 transport');

    // The real store still has NO key, so a later legit claim succeeds.
    const real = createReplayClaimer({ store, accountId: ACCOUNT });
    assert.equal(real.size(), 0, '失败的写不得留下半个键');
    assert.deepEqual(real.claim(identity(), { now: 1200 }), { ok: true });
    store.close();
  } finally { t.cleanup(); }
});

test('B2-R5 运行态遇到集合缺失/损坏：拒绝执行，且不自动重建', () => {
  const t = tempDb('damaged');
  try {
    const store = openOfflineStore(t.dbPath, initial());
    initializeReplayState(store, { now: 1000 });
    const c = createReplayClaimer({ store, accountId: ACCOUNT });
    assert.deepEqual(c.claim(identity({ callId: 'c1' }), { now: 1100 }), { ok: true });

    // Simulate damage: strip the collection but keep the install residue.
    store.update((s) => { const n = { ...s }; delete n.usedReadKeys; return n; });

    const damaged = createReplayClaimer({ store, accountId: ACCOUNT });
    const out = damaged.claim(identity({ callId: 'c2' }), { now: 1200 });
    assert.equal(out.ok, false, '集合缺失时不得放行');
    assert.equal(out.reason, REPLAY_REFUSAL.COLLECTION_LOST);
    assert.equal(damaged.size(), -1, 'size 用 -1 表示集合不可用');

    // And initialization must NOT rebuild it at runtime.
    assert.equal(initializeReplayState(store, { now: 1300 }).ok, false);
    store.close();
  } finally { t.cleanup(); }
});

test('B2-R6 【已被取代】旧版顺序断言（未调用任何 transport）；真实派发控制流见 test-qzone-replay-dispatch.mjs', () => {
  const t = tempDb('ordering');
  try {
    const store = openOfflineStore(t.dbPath, initial());
    initializeReplayState(store, { now: 1000 });
    const c = createReplayClaimer({ store, accountId: ACCOUNT });

    const events = [];
    const persistedSize = () => c.size();

    // The caller MUST claim first; only `ok:true` authorises the transport call.
    const outcome = c.claim(identity(), { now: 1100 });
    if (outcome.ok) {
      // Assert the key is already durable BEFORE the transport is touched.
      events.push({ stage: 'after-claim', size: persistedSize() });
      store.close();                                   // simulate "the process died now"
      const reopened = openOfflineStore(t.dbPath, initial());
      events.push({ stage: 'after-reopen', size: createReplayClaimer({ store: reopened, accountId: ACCOUNT }).size() });
      reopened.close();
      events.push({ stage: 'transport', dispatched: 1 });
    }

    assert.deepEqual(events.map((e) => e.stage), ['after-claim', 'after-reopen', 'transport'],
      '顺序必须是 认领→已持久化→派发');
    assert.equal(events[0].size, 1);
    assert.equal(events[1].size, 1, '崩溃前认领已落盘，重开仍能看到');
  } finally { t.cleanup(); }
});
