// B2 growth measurement — CORRECTED.
//
// Two device errors in the previous version (both caught by Codex):
//   1. fakeStore.update only did structuredClone + object replacement. It never serialized
//      or wrote to disk, so the timings were an IN-MEMORY object-copy benchmark, not I/O.
//   2. The decile comparison called time(0,1000) and then time(9000,10000) with nothing in
//      between, so the "last thousand" actually ran on a set of 1000→2000 keys. The 4.2x
//      figure was therefore meaningless and is withdrawn.
//
// This version reports THREE distinct cost components, clearly labelled:
//   A. object handling   — structuredClone + spread (pure JS, no serialization)
//   B. serialization     — JSON.stringify of the whole state (what the store must do)
//   C. real disk I/O     — a genuine temporary SQLite file via openOfflineStore
//
// And the decile test now fills the set OUTSIDE the timer and asserts the population at
// both ends of each measurement.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import {
  initializeReplayState,
  createReplayClaimer,
} from '../src/core/qzone-replay-claim-offline.mjs';

const ACCOUNT = 9876543210;
const ident = (i) => ({ sessionId: `sess-${i % 50}`, requestId: `req-${i}`, callId: `call-${i}` });

/** In-memory store that DOES serialize, so component B is honest. */
function memStore(initial) {
  let state = structuredClone(initial);
  return {
    read: () => structuredClone(state),
    update(fn) {
      const next = fn(structuredClone(state));
      const json = JSON.stringify(next);   // <- the serialization the real store pays
      state = JSON.parse(json);
      return next;
    },
    snapshot: () => state,
  };
}

const rows = [];

// ── A + B: in-memory, with explicit serialization ────────────────────────────────────
for (const N of [1000, 2000, 5000, 10000]) {
  const store = memStore({ enabled: false, reads: 0, audit: [] });
  initializeReplayState(store, { now: 1 });
  const c = createReplayClaimer({ store, accountId: ACCOUNT });

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i += 1) c.claim(ident(i), { now: 1000 + i });
  const t1 = process.hrtime.bigint();

  const bytes = Buffer.byteLength(JSON.stringify(store.snapshot()), 'utf8');
  rows.push({
    // LABEL NOTE: this is the COMBINED cost of object handling + JSON stringify/parse.\n    // A and B are not separated (no profiler pass); do not quote either sub-cost alone.\n    component: 'COMBINED in-memory object handling + JSON stringify/parse (A and B not separated)',
    N,
    totalMs: Number((Number(t1 - t0) / 1e6).toFixed(1)),
    msPerClaim: Number((Number(t1 - t0) / 1e6 / N).toFixed(3)),
    stateBytes: bytes,
    bytesPerKey: Math.round(bytes / N),
  });
}

// ── decile test, done correctly: fill OUTSIDE the timer ──────────────────────────────
{
  const N = 10000;
  const store = memStore({ enabled: false, reads: 0, audit: [] });
  initializeReplayState(store, { now: 1 });
  const c = createReplayClaimer({ store, accountId: ACCOUNT });

  const timeRange = (from, to) => {
    const a = process.hrtime.bigint();
    for (let i = from; i < to; i += 1) c.claim(ident(i), { now: 1000 + i });
    return Number((Number(process.hrtime.bigint() - a) / 1e6).toFixed(1));
  };

  const first = timeRange(0, 1000);
  const sizeAfterFirst = c.size();
  // Fill 1000..9000 WITHOUT timing — this was missing before.
  for (let i = 1000; i < 9000; i += 1) c.claim(ident(i), { now: 1000 + i });
  const sizeBeforeLast = c.size();
  const last = timeRange(9000, 10000);
  const sizeAfterLast = c.size();

  rows.push({
    component: 'decile (fill outside timer)',
    sizeAfterFirstThousand: sizeAfterFirst,
    sizeBeforeLastThousand: sizeBeforeLast,
    sizeAfterLastThousand: sizeAfterLast,
    first1000Ms: first,
    last1000Ms: last,
    slowdownFactor: Number((last / first).toFixed(1)),
    note: 'preconditions asserted below; 4.2x from the previous version is WITHDRAWN',
  });
  // Assert the population really was 9000→10000 during the second timer.
  if (sizeBeforeLast !== 9000 || sizeAfterLast !== 10000) {
    throw new Error(`decile precondition failed: before=${sizeBeforeLast} after=${sizeAfterLast}`);
  }
}

// ── C: real temporary SQLite file ────────────────────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-b2-growth-'));
  const dbPath = path.join(dir, 'state.db');
  try {
    const store = openOfflineStore(dbPath, { enabled: false, reads: 0, audit: [] });
    initializeReplayState(store, { now: 1 });
    const c = createReplayClaimer({ store, accountId: ACCOUNT });

    for (const [label, from, to] of [['first 500', 0, 500], ['next 500', 500, 1000]]) {
      const a = process.hrtime.bigint();
      for (let i = from; i < to; i += 1) c.claim(ident(i), { now: 1000 + i });
      const ms = Number((Number(process.hrtime.bigint() - a) / 1e6).toFixed(1));
      rows.push({
        // LABEL NOTE: end-to-end per-claim cost including object handling, JSON, SQL,\n        // transaction and commit. It is NOT pure disk I/O.\n        component: 'END-TO-END real SQLite per claim (object+JSON+SQL+txn+commit; not pure I/O)',
        block: label,
        populationAtStart: from,
        ms,
        msPerClaim: Number((ms / (to - from)).toFixed(3)),
        fileBytes: fs.statSync(dbPath).size,
      });
    }
    store.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log(JSON.stringify(rows, null, 2));
