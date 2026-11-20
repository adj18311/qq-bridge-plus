// B2 replay-set scale measurement on a REAL temporary SQLite store.
//
// WHAT THIS IS
//   A measurement script (not a test, not in the runner). It reports, at several
//   population sizes of the persisted B2 replay set, how long ONE claim costs and how
//   many bytes ONE claim writes, split into three separately-labelled components:
//
//     A. object handling   — structuredClone of the state + the object spreads `claim()` does
//     B. JSON serialization — JSON.stringify + JSON.parse of the WHOLE state
//     C. real store write   — the actual `store.update()` (BEGIN IMMEDIATE, read, UPDATE the
//                             single `state` row, COMMIT, and the store's own re-parse)
//
//   A and B are measured as ISOLATED primitives on the same state. C is measured as the
//   store's end-to-end path, which CONTAINS its own copy of A and B (the store reads the row,
//   the claim callback mutates, `encode()` stringifies+parses, then the return value is parsed
//   again). They are therefore NOT additive and must not be summed into "total time".
//   A `residual = C − A − B` is printed only as a labelled NON-ATTRIBUTABLE remainder, never
//   as "pure disk time": Windows FS caching, SQLite paging and the store's extra parse make
//   that subtraction meaningless as an attribution.
//
// WHAT THIS IS NOT
//   · NOT a benchmark of a production deployment (temp file on the same machine, no AV,
//     no competing writers, no WAL, `synchronous=FULL` as the offline store sets it).
//   · NOT a recommendation. The replay set has no hard cap by design; this script does not
//     decide what it "should" be. Product decision, elsewhere.
//
// USAGE
//   cmd /c "D:\Node\node.exe scripts\qzone-b2-scale-measure.mjs"
//   cmd /c "D:\Node\node.exe scripts\qzone-b2-scale-measure.mjs --quick"   (smaller ladder)
//
// Every database lives under %TEMP% and is removed before exit. Total runtime is bounded by
// BUDGET_MS; if the budget is exhausted the script stops early and says so in `notes`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { initializeReplayState, createReplayClaimer } from '../src/core/qzone-replay-claim-offline.mjs';

const ACCOUNT = 9876543210;
const QUICK = process.argv.includes('--quick');
const LADDER = QUICK ? [1000, 5000] : [1000, 5000, 10000, 20000];
const REPS = QUICK ? 5 : 11;          // timing reps per tier (median reported)
const PASSES = QUICK ? 1 : 3;         // full ladder repetitions, so run-to-run noise is visible
const BUDGET_MS = 170_000;            // hard stop well inside the 3-minute allowance
const STARTED = process.hrtime.bigint();
const elapsedMs = () => Number(process.hrtime.bigint() - STARTED) / 1e6;
const freeMemAtStart = os.freemem();

const notes = [];
const tiers = [];

const ident = (i) => ({ sessionId: `sess-${i % 50}`, requestId: `req-${i}`, callId: `call-${i}` });

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
const ms = (n) => Number(n.toFixed(3));
const time = (fn) => { const t0 = process.hrtime.bigint(); const out = fn(); return { out, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; };

/**
 * A. Pure object handling: what `claim()` does to the state object graph, with no
 * serialization and no I/O. Measured as `structuredClone` of the state plus the two
 * spreads (`{...state, usedReadKeys: {...keys, [key]: {...}}}`).
 */
function objectHandlingMs(state, key) {
  const t0 = process.hrtime.bigint();
  const clone = structuredClone(state);
  const nextKeys = { ...clone.usedReadKeys, [key]: { claimedAt: 1, generation: null } };
  const next = { ...clone, usedReadKeys: nextKeys };
  void next;
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

/** B. Pure JSON serialization: stringify + parse of the whole state. */
function jsonSerializationMs(state) {
  const t0 = process.hrtime.bigint();
  const json = JSON.stringify(state);
  const parsed = JSON.parse(json);
  void parsed;
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

/** Build the populated state in ONE write, so construction is not an O(N^2) claim loop. */
function fillReplaySet(store, n) {
  return store.update((state) => {
    const keys = Object.create(null);
    for (let i = 0; i < n; i += 1) {
      // A key is exactly what `keyOf()` produces: a JSON array of account/session/request/call.
      keys[JSON.stringify([ACCOUNT, `sess-${i % 50}`, `req-${i}`, `call-${i}`])] = { claimedAt: 1000 + i, generation: null };
    }
    return { ...state, usedReadKeys: { ...keys } };
  });
}

function measureTier(n, pass) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-b2-scale-${n}-`));
  const dbPath = path.join(dir, 'state.db');
  const tier = { pass, n, finished: false };
  try {
    // ── populate (one write; this is CONSTRUCTION cost, not a per-claim cost) ──────────
    let store = openOfflineStore(dbPath, { enabled: false, reads: 0, audit: [] });
    initializeReplayState(store, { now: 1 });
    const fill = time(() => fillReplaySet(store, n));
    tier.fillMs = ms(fill.ms);
    store.close();

    // ── reopen: between tiers (and before measuring) nothing is cached in-process ──────
    store = openOfflineStore(dbPath, { enabled: false, reads: 0, audit: [] });
    const reopened = store.read();
    tier.populationAfterFill = Object.keys(reopened.usedReadKeys ?? {}).length;
    if (tier.populationAfterFill !== n) throw new Error(`fill precondition failed: ${tier.populationAfterFill} !== ${n}`);
    const stateStrings = [Buffer.byteLength(JSON.stringify(reopened), 'utf8')];
    tier.stateBytes = stateStrings[0];
    tier.bytesPerKey = Math.round(tier.stateBytes / n);
    tier.dbFileBytes = fs.statSync(dbPath).size;

    const claimer = createReplayClaimer({ store, accountId: ACCOUNT });

    // ── B2 has no cap, so the set only grows: prove it by claiming once and re-counting ─
    const firstClaim = claimer.claim(ident(n), { now: 2_000_000 });
    tier.firstClaimOk = firstClaim.ok === true;
    tier.populationAfterOneClaim = Object.keys(store.read().usedReadKeys).length;

    // ── A / B primitives on the CURRENT population ───────────────────────────────────
    const stateNow = store.read();
    const aSamples = [];
    const bSamples = [];
    for (let r = 0; r < REPS; r += 1) {
      aSamples.push(objectHandlingMs(stateNow, JSON.stringify([ACCOUNT, 'sess-x', `probe-a-${r}`, 'call-x'])));
      bSamples.push(jsonSerializationMs(stateNow));
    }
    tier.aObjectHandlingMs = ms(median(aSamples));
    tier.bJsonSerializationMs = ms(median(bSamples));
    tier.aSamplesMs = Object.fromEntries(['min', 'median', 'max'].map((k) => [k, ms(k === 'min' ? Math.min(...aSamples) : k === 'max' ? Math.max(...aSamples) : median(aSamples))]));
    tier.bSamplesMs = Object.fromEntries(['min', 'median', 'max'].map((k) => [k, ms(k === 'min' ? Math.min(...bSamples) : k === 'max' ? Math.max(...bSamples) : median(bSamples))]));

    // ── C1: store.update that writes the SAME state (transaction + whole-row rewrite) ─
    const noopSamples = [];
    for (let r = 0; r < REPS; r += 1) noopSamples.push(time(() => store.update((s) => s)).ms);
    tier.cUpdateNoopMs = ms(median(noopSamples));

    // ── T: the BARE transaction on the same file, with no state construction at all ────
    // This is the third INDEPENDENT slot the captain asked for ("只做 SQLite 事务不构造大对象").
    // It opens the same database file directly and times BEGIN IMMEDIATE + COMMIT with no
    // read, no stringify and no UPDATE — so the difference between C1 and T is attributable
    // to (read + encode + UPDATE + re-parse) and NOT to the transaction machinery.
    // Guarded: if the raw driver is unavailable this records null rather than inventing a 0.
    {
      let txnMs = null;
      let txnNote = null;
      try {
        const raw = new DatabaseSync(dbPath);
        try {
          raw.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
          const samples = [];
          for (let r = 0; r < REPS; r += 1) {
            const measured = time(() => { raw.exec('BEGIN IMMEDIATE'); raw.exec('COMMIT'); });
            samples.push(measured.ms);
          }
          txnMs = ms(median(samples));
        } finally { raw.close(); }
      } catch (error) {
        txnNote = `unavailable: ${error.message}`;
      }
      tier.bareTransactionMs = txnMs;
      tier.bareTransactionNote = txnNote ?? 'BEGIN IMMEDIATE + COMMIT only; no SELECT, no stringify, no UPDATE';
    }

    // ── C2: one real claim, end to end (this is the number the caller pays) ───────────
    const claimSamples = [];
    for (let r = 0; r < REPS; r += 1) {
      const id = { sessionId: 'sess-scale', requestId: `req-claim-${r}`, callId: `call-claim-${r}` };
      const measured = time(() => claimer.claim(id, { now: 3_000_000 + r }));
      if (measured.out?.ok !== true) throw new Error(`claim rep ${r} refused: ${JSON.stringify(measured.out)}`);
      claimSamples.push(measured.ms);
    }
    tier.cClaimEndToEndMs = ms(median(claimSamples));
    tier.cClaimSamplesMs = Object.fromEntries(['min', 'median', 'max'].map((k) => [k, ms(k === 'min' ? Math.min(...claimSamples) : k === 'max' ? Math.max(...claimSamples) : median(claimSamples))]));
    // Labelled NON-ATTRIBUTABLE remainder — NOT "disk time". See the header.
    tier.residualNotAttributableMs = ms(tier.cClaimEndToEndMs - tier.aObjectHandlingMs - tier.bJsonSerializationMs);
    // C1 minus the bare transaction is the part of C1 that is (read + encode + UPDATE +
    // re-parse). This one subtraction IS attributable, because T really does nothing else.
    tier.c1MinusBareTransactionMs = tier.bareTransactionMs === null
      ? null
      : ms(tier.cUpdateNoopMs - tier.bareTransactionMs);

    // ── write amplification ──────────────────────────────────────────────────────────
    // Logical: the store rewrites the SINGLE `state` row, so one claim writes the whole
    // serialized state. Measured directly from the value the UPDATE binds.
    const afterState = store.read();
    tier.logicalBytesWrittenPerClaim = Buffer.byteLength(JSON.stringify(afterState), 'utf8');
    tier.logicalRewriteFactor = Number((tier.logicalBytesWrittenPerClaim / tier.stateBytes).toFixed(2));

    // Physical: file size change across a block of claims. Page-granular (SQLite allocates in
    // pages, default 4096 B) and blind to the journal/WAL, so this is a LOWER BOUND on bytes
    // pushed to the filesystem, not an equal measure. A 0 delta means "the row still fits in
    // the pages already allocated", which is NOT "no bytes were written" — the whole state row
    // was rewritten in place. Both facts are reported so neither can be quoted alone.
    const PHYS_REPS = 20;
    store.close();
    const growthClaim = () => {
      const s = openOfflineStore(dbPath, { enabled: false, reads: 0, audit: [] });
      try {
        const c = createReplayClaimer({ store: s, accountId: ACCOUNT });
        for (let r = 0; r < PHYS_REPS; r += 1) {
          c.claim({ sessionId: 'sess-phys', requestId: `req-phys-${r}`, callId: `call-phys-${r}` }, { now: 4_000_000 + r });
        }
      } finally { s.close(); }
    };
    const fileBefore = fs.statSync(dbPath).size;
    growthClaim();
    const fileAfter = fs.statSync(dbPath).size;
    const fileAfterSecond = (growthClaim(), fs.statSync(dbPath).size);
    tier.physical = {
      claimsPerBlock: PHYS_REPS,
      bytesBeforeBlock: fileBefore,
      bytesAfterFirstBlock: fileAfter,
      bytesAfterSecondBlock: fileAfterSecond,
      deltaFirstBlock: fileAfter - fileBefore,
      deltaSecondBlock: fileAfterSecond - fileAfter,
      interpretation: 'file-size delta is page-allocation granular; 0 means the row still fit in allocated pages, NOT that nothing was written',
    };
    // A cleaner physical bound: compare the DB size against the logical state size. The gap is
    // exactly the pages SQLite holds beyond the serialized row (free pages, journal neighbours).
    tier.physical.dbOverheadBytes = tier.dbFileBytes - tier.stateBytes;

    // Final size (the "no cap" fact, measured rather than asserted).
    store = openOfflineStore(dbPath, { enabled: false, reads: 0, audit: [] });
    tier.finalPopulation = Object.keys(store.read().usedReadKeys).length;
    tier.noCapEvidence = tier.finalPopulation > n;
    store.close();
    tier.finished = true;
    return tier;
  } finally {
    try { store?.close?.(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── run the ladder PASSES times; keep every pass on disk-visible output ──────────────
const passes = [];
for (let pass = 1; pass <= PASSES; pass += 1) {
  const run = { pass, startedMs: Math.round(elapsedMs()), tiers: [] };
  for (const n of LADDER) {
    if (elapsedMs() > BUDGET_MS) {
      notes.push(`budget exhausted in pass ${pass} before N=${n}; stopped (${Math.round(elapsedMs())} ms used)`);
      break;
    }
    try {
      const tier = measureTier(n, pass);
      run.tiers.push(tier);
      tiers.push(tier);
      console.log(`pass ${pass}  N=${String(n).padStart(6)}  claim(e2e)=${tier.cClaimEndToEndMs} ms  update(noop)=${tier.cUpdateNoopMs} ms  ` +
        `A(obj)=${tier.aObjectHandlingMs} ms  B(json)=${tier.bJsonSerializationMs} ms  ` +
        `state=${tier.stateBytes} B (${tier.bytesPerKey} B/key)  db=${tier.dbFileBytes} B  ` +
        `rewrite=${tier.logicalBytesWrittenPerClaim} B/claim  fileΔ=${tier.physical.deltaFirstBlock} B/${tier.physical.claimsPerBlock} claims`);
    } catch (error) {
      notes.push(`pass ${pass} N=${n} failed: ${error.message}`);
      console.log(`pass ${pass} N=${n} FAILED: ${error.message}`);
    }
  }
  passes.push(run);
  if (elapsedMs() > BUDGET_MS) break;
}

// Per-size spread across passes: a single run's number is not a measurement, so the
// min/median/max of the per-pass medians are all reported.
const spread = LADDER.map((n) => {
  const claims = tiers.filter((t) => t.n === n).map((t) => t.cClaimEndToEndMs);
  if (claims.length === 0) return { n, passes: 0 };
  return {
    n,
    passes: claims.length,
    claimMedians: claims,
    minMs: ms(Math.min(...claims)),
    medianMs: ms(median(claims)),
    maxMs: ms(Math.max(...claims)),
    spreadFactor: claims.length > 1 ? Number((Math.max(...claims) / Math.min(...claims)).toFixed(2)) : null,
  };
});

// ── superlinearity: fitted exponent from the MEASURED per-claim medians ────────────
// Fitted from the median across passes so a lucky/unlucky single pass cannot drive it.
const shape = [];
for (let i = 1; i < spread.length; i += 1) {
  const a = spread[i - 1];
  const b = spread[i];
  if (!a.medianMs || !b.medianMs) continue;
  const exponent = Math.log(b.medianMs / a.medianMs) / Math.log(b.n / a.n);
  shape.push({
    from: a.n,
    to: b.n,
    claimMsFrom: a.medianMs,
    claimMsTo: b.medianMs,
    growthFactor: Number((b.medianMs / a.medianMs).toFixed(2)),
    fittedExponent: Number(exponent.toFixed(2)),
    superlinearOverLinear: exponent > 1.15,
  });
}
const avgExponent = shape.length
  ? Number((shape.reduce((sum, s) => sum + s.fittedExponent, 0) / shape.length).toFixed(2))
  : null;

const report = {
  script: 'scripts/qzone-b2-scale-measure.mjs',
  quick: QUICK,
  ladder: LADDER,
  passes: PASSES,
  repsPerTier: REPS,
  elapsedMs: Math.round(elapsedMs()),
  budgetMs: BUDGET_MS,

  // ── HOW THE THREE COMPONENTS WERE OBTAINED (read this before quoting any number) ──
  measurementMethod: {
    style: 'INDEPENDENT measurement (option A), NOT subtraction.',
    A: 'A is measured by TIMING ONLY the object work: structuredClone(state) followed by the two object spreads claim() performs. It contains NO JSON.stringify / JSON.parse and NO store call.',
    B: 'B is measured by TIMING ONLY the serialization: JSON.stringify(state) then JSON.parse(json) on the SAME already-parsed state. It contains NO structuredClone and NO store call.',
    C1: 'C1 is measured directly by timing store.update(s => s): BEGIN IMMEDIATE + SELECT the state row + encode() (stringify) + UPDATE the single row + COMMIT + a further JSON.parse of the value returned to the caller.',
    C2: 'C2 is measured directly by timing one real claimer.claim(): it runs the store path above with the claim mutation inside it. C2 therefore CONTAINS its own copies of the A and B work.',
    whyNotSubtraction: 'No reported number is derived as "total minus another component". A and B are each wall-clock timed in isolation; C1 and C2 are each wall-clock timed end to end. The one subtraction that IS printed (`residualNotAttributableMs` = C2 − A − B) is explicitly labelled NON-ATTRIBUTABLE and must never be quoted as disk I/O time.',
    caveatOnIndependence: 'A and B are independent AS PRIMITIVES, but they are not the exact statement sequence the store executes (the store does one extra JSON.parse of the returned value, and it reaches the state through SQL, not through structuredClone). So A and B are honest isolated costs, not a decomposition of C2.',
  },

  machine: {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    cpuModel: os.cpus()?.[0]?.model ?? 'unknown',
    cpuCores: os.cpus()?.length ?? null,
    totalMemBytes: os.totalmem(),
    freeMemBytesAtStart: freeMemAtStart,
    loadAverageAtEnd: (() => { try { return os.loadavg(); } catch { return null; } })(),
    loadControlled: false,
    loadNote: 'NO load control was applied: other processes on this desktop (editor, browser, the DSH harness itself) were running during the measurement. That is the main reason the same size shows a different number between passes; the per-size spread across passes is reported for exactly this reason.',
  },

  dataShape: {
    keyEncoding: 'JSON.stringify([accountId, sessionId, requestId, callId]) — exactly what createReplayClaimer().keyOf() produces',
    keyExample: JSON.stringify([ACCOUNT, 'sess-0', 'req-0', 'call-0']),
    keyLengthBytes: Buffer.byteLength(JSON.stringify([ACCOUNT, 'sess-0', 'req-0', 'call-0']), 'utf8'),
    valueShape: '{ claimedAt: <integer>, generation: null } — 2 fields, the audit-minimal record claim() writes',
    valueExample: JSON.stringify({ claimedAt: 1000, generation: null }),
    valueLengthBytes: Buffer.byteLength(JSON.stringify({ claimedAt: 1000, generation: null }), 'utf8'),
    sessionIdShape: 'sess-<i mod 50> — 50 distinct sessions, so keys are not all from one session',
    requestIdShape: 'req-<i>',
    callIdShape: 'call-<i>',
    measuredBytesPerKey: spread.map((s) => ({ n: s.n, bytesPerKey: tiers.find((t) => t.n === s.n)?.bytesPerKey ?? null })),
  },

  transactionAssumptions: {
    oneClaimIsOneTransaction: true,
    transaction: 'each claim = BEGIN IMMEDIATE ... COMMIT (openOfflineStore.update)',
    synchronous: 'FULL (set by src/core/qzone-store-offline.mjs: PRAGMA synchronous=FULL)',
    busyTimeoutMs: 5000,
    journalMode: 'default rollback journal (no WAL was enabled)',
    writers: 1,
    rowsRewrittenPerClaim: 1,
    rowsRewrittenNote: 'the whole state lives in ONE row (id = 1); every claim rewrites that entire row, so bytes written scale with the whole replay set, not with the one added key',
    isolation: 'the driver is synchronous: BEGIN IMMEDIATE + UPDATE + COMMIT happen inside one JS turn, so nothing else can interleave in-process',
  },

  isolation: {
    databaseLocation: '%TEMP% only (fs.mkdtempSync under os.tmpdir())',
    deletedAfterEachTier: true,
    touchedProductionState: false,
    touchedRealQQ: false,
  },

  selfReported: [
    'A and B are isolated primitives measured on the same parsed state object; they are not the exact code path the store runs (the store does one extra JSON.parse of the returned value and reaches the state through SQL, not structuredClone).',
    'C2 CONTAINS its own copies of A and B, so A + B + C2 is a double count and must never be summed.',
    'Every number in `tiers[].physical` that derives from file size is page-allocation granular and journal-blind: a 0 delta means the rewritten row still fit in already-allocated pages, NOT that nothing was written.',
    'The populated set is built in ONE write (fillReplaySet), not by N claims. Construction cost (fillMs) is reported separately and is NOT a per-claim number.',
    'C2 is a per-claim cost of a store that ALREADY holds N keys; it says nothing about throughput under concurrency (one writer only here).',
  ],
  limitations: [
    'No load control: other processes ran during the measurement (see machine.loadControlled).',
    'Windows filesystem cache and any antivirus filter sit between the process and the platter; a cold-cache run will be slower and noisier than these numbers.',
    'Temp directory is on the system volume; SSD/NVMe vs spinning disk is not characterised here.',
    'No competing writers, no WAL; `PRAGMA synchronous=FULL` and `busy_timeout=5000` as the offline store sets them. Concurrency behaviour is a separate measurement.',
    'Node `node:sqlite` is experimental in this runtime; its statement/transaction overhead is part of C and is not separated out.',
    'A and B are single-threaded JS work; cross-machine comparison is invalid.',
    `Medians of ${REPS} samples per tier, ${PASSES} full ladder pass(es); min/median/max are reported so the spread is visible rather than hidden.`,
    'The set is built by a single bulk write, so the fill cost is NOT how production reaches a large set (production grows one claim at a time and would pay the per-claim cost at every size).',
  ],
  spreadAcrossPasses: spread,
  tiers,
  superlinearity: shape,
  averageFittedExponent: avgExponent,
  notes,
  disclaimer: 'These numbers quantify a known missing hard cap. They are NOT an authorization and NOT a basis for choosing a cap; the replay set is deliberately uncapped and that decision is out of scope for this script.',
};

console.log('\n' + JSON.stringify(report, null, 2));
