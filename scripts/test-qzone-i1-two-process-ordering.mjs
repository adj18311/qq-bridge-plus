// I1 ACCEPTANCE · "the pause commit and the grant commit are ordered on ONE SQLite serialization
// boundary" — measured with real processes, not with two pre-arranged end states.
//
// WHAT I1 ACTUALLY CLAIMS, AND WHAT THIS FILE THEREFORE HAS TO SHOW
// ----------------------------------------------------------------
// A write is granted at `finalAuthorisationCheck` (stage 1b) — one `store.update`, i.e. one
// `BEGIN IMMEDIATE … COMMIT`. A pause is granted by some other writer's `store.update` on the SAME
// database. SQLite serializes both, so exactly one of them commits first, and **any transaction that
// acquires the write lock afterwards is guaranteed to read the committed value**. That is the whole
// evidence model:
//
//     the value of `state.writePaused` OBSERVED INSIDE the write lock
//         ⇒ which side of the serialization boundary the pause landed on
//
// Deliberately NOT used as evidence, because none of them can establish ordering:
//   · the order two child processes print to stdout (scheduler noise),
//   · wall-clock timings,
//   · the final database state alone (it is compatible with many interleavings).
//
// THE THREE INTERLEAVINGS (they produce three DIFFERENT results — do not merge them)
// ---------------------------------------------------------------------------------
//   A  pause COMMITTED before the write starts
//        every transaction reads `writePaused === true`
//        ⇒ refused at the RESERVE (stage 1): {stage:'reserve', reason:'write_paused'},
//          transport 0, no reservation, and NO `quotaConsumed` property at all
//   B  reserve + stage 1b commit BEFORE the pause
//        both transactions read `false`
//        ⇒ {ok:true, stage:'transport'}, transport 1, reservation present;
//          a NEW call after the pause is refused
//   C  pause lands BETWEEN the reserve and stage 1b
//        reservation transaction reads `false`, stage 1b transaction reads `true`
//        ⇒ refused at stage 1b: {stage:'transport', outcome:'not-sent', quotaConsumed:true,
//          permitRefusedBy:'authorize'}, transport 0, and the reservation IS present
//
// C is the one that proves the FINAL AUTHORISATION BOUNDARY exists: the earlier refusal (A) is only
// the reserve kernel noticing a pause that was already there, which a facade with NO stage 1b would
// produce just as well.
//
// HOW THE INTERLEAVINGS ARE MADE DETERMINISTIC (no sleeps, no retries, no probability)
// ------------------------------------------------------------------------------------
// Ordering is forced by the LOCK ITSELF, not by sleeping:
//   · A — the pauser writes its marker from INSIDE its own `store.update` callback (so the marker
//     only exists while the pause transaction holds the write lock). The writer waits for that marker
//     and then starts; its `BEGIN IMMEDIATE` cannot complete before the pause commits.
//   · B — the writer writes its marker from INSIDE the stage-1b transaction callback. The pauser waits
//     for that marker, so its `BEGIN IMMEDIATE` queues behind stage 1b and can only commit after it.
//   · C — the pause is injected between the reservation and stage 1b.
//     TWO SHAPES ARE MEASURED, and neither may stand in for the other:
//       C  (in-process)  a SECOND REAL CONNECTION on the same file, injected from inside the
//                        wrapper's `update`. Deterministic in one process, so it needs no race.
//       C2P (two-process) A REAL SECOND OS PROCESS commits the pause — the writer hands the
//                        serialization window over by parking OUTSIDE any transaction, announcing
//                        `writer.stage1bPending`, and waiting for the peer's COMMIT. No sleeps, no
//                        retries. This is the only shape in which "another OS process's COMMIT" is
//                        the cause of the ordering (see `I1-C2P`).
//
// TWO SEPARATE THINGS ARE PROVEN SEPARATELY, and neither may stand in for the other:
//   (i) CONCURRENCY — that the two processes were alive at the SAME time. ONE parent-side predicate
//       (`assertParentConcurrent`) decides this for A, B and C2P, and the SAME predicate is what the
//       sequential counter-control (I1-CC3) must be rejected by. Its inputs are the RAW `runPair`
//       results: `child.pid` from the spawn call plus the parent's own `Date.now()` readings around
//       `spawn` and the `close` event. The children's self-reported `readyAt`/`aliveUntil` are NOT an
//       input anywhere — they are diagnostic output only (a child can print any number).
//       That parent window is an OBSERVATION BOUNDARY, not a precise kernel lifetime: "both roles were
//       in flight while the parent watched" is all it says, and the claim that both really ran their
//       protocol concurrently also needs the existing mutual handshake (each side waits for the other's
//       `ready`) and the per-test in-lock/probe evidence. See `assertParentConcurrent`.
//  (ii) ORDERING — that the pause committed before/after a given transaction. That comes ONLY from
//       `state.writePaused` as read INSIDE the write lock. Timestamps are never used for ordering; the
//       C2P handoff is ordered by PROTOCOL CAUSALITY (stage 1b's `BEGIN` cannot happen before the peer
//       writes the marker that follows its `COMMIT`), not by comparing clocks.
// The two in-lock markers are themselves protected twice over:
//   · SELF-CHECK — each child drives its own `weHoldTheLock` through both states on a private database
//     (`probeCalibration`), so a constant probe cannot pass.
//   · 他证 (t42) — the marker's owner holds its transaction open while the PARENT probes the write lock,
//     and THE COMPETITOR ALSO WAITS for the probe to finish before it touches the database. During that
//     window the owner is the only possible lock holder, so the parent's `held:true` is attributable to
//     the owner rather than to "somebody". Without the competitor's wait a forged marker that had moved
//     outside its transaction still passed (measured: 10/10 green).
//
// WHAT I1 DOES NOT PROVE (carried forward from the 4th review — do NOT read the above as covering them)
// ---------------------------------------------------------------------------------------------------
//   R3  WITHDRAWN FROM EVIDENCE. The children used to report a `peerAlreadyExited` boolean and
//       A/C2P/CC3 judged on it; it is `!HANDSHAKE` in disguise (a restatement of the mode switch), so
//       it proved nothing independent. The field is GONE from the child output and no assertion reads
//       it. "The two programs really ran one after the other" is now established by the parent's raw
//       lifecycle results through the same `assertParentConcurrent` predicate A/B/C2P use — see
//       I1-CC3. No replacement boolean was added; in particular, do NOT add another child-reported
//       flag in its place.
//   R4  The children's `readyAt`/`aliveUntil` are SELF-REPORTED clock readings. They are DIAGNOSTIC
//       OUTPUT ONLY: no concurrency or ordering assertion in this file reads them, so a child that
//       lies about when it was alive cannot influence any verdict (it can only make the printed
//       diagnostic wrong). What the concurrency verdict does rest on is the parent's own `child.pid`
//       plus its `spawn`/`close` window, and that window is an OBSERVATION BOUNDARY, not a precise
//       kernel lifetime — see `assertParentConcurrent`. R4 therefore stays a limit on what
//       "concurrent" means here (both roles in flight while the parent watched), not a hole through
//       which a child can assert anything.
//   R5  SCOPE IS ALL THREE SIDES (A/B/C), NOT JUST C (corrected in t44). Two different claims get
//       conflated, and they are pinned to DIFFERENT degrees — measured, not assumed:
//         (a) WHERE the `state.writePaused` READ happens. PINNED ON A/B, NOT ON C. Moving the
//             observation out of the transaction callback (push it from a post-commit `real.read()`
//             instead) turns I1-A + I1-B red — measured 7 pass / 2 fail. I1-C stays GREEN under the same
//             move, because there the pause is injected AFTER `real.update` returns, so a post-commit
//             read sees the same value the in-lock read would have seen.
//         (b) WHETHER the DECISION uses state read inside the lock — i.e. `gateRefusal` / `authorizeTool`
//             judging on `state` rather than on an earlier `store.read()`. PINNED BY `I1-CC4` (one
//             process, two connections) AND `I1-C2P-M` (the SAME mutation through the C2P two-process
//             protocol). `I1-C2P-M` mutates only the `authorizeTool` site, so it pins the pause decision,
//             not `gateRefusal` independently.
//       In the real code (a) and (b) coincide because both use `state`, but a mutation can change (b)
//       alone and leave (a) intact. Measured counterexample (t44; independently reproduced by Codex):
//       keep BOTH real write transactions and every in-lock marker, and only feed `gateRefusal` /
//       `authorizeTool` a `staleSnapshot = store.read()` taken BEFORE the transaction —
//       **9 pass / 0 fail / leakedDirs 0**. So the suite is sensitive to "a transaction was deleted"
//       (I1-CC1 goes red) and blind to "the transaction stayed but the JUDGEMENT moved outside it".
//       The counterexample above is exactly what `I1-CC4` now pins: with the REAL code the same injection
//       shape is REFUSED at stage 1b (transport 0), and with the stale-snapshot copy it is GRANTED
//       (transport 1) — while BOTH sides open the SAME two write transactions and observe the SAME
//       `[false, true]`. So (b) is pinned WITHOUT changing the store contract and WITHOUT an injection
//       hook between `BEGIN` and `fn(state)`: the pause is committed by a SECOND REAL CONNECTION from
//       inside the wrapper's `update`, just before the second `real.update` call.
//       TWO LIMITS ON THAT, stated so it is not read as more than it is:
//         · I1-CC4 is ONE PROCESS with TWO REAL CONNECTIONS. It is NOT a two-process proof. The
//           two-process shape of C is measured separately by `I1-C2P` (+ `I1-C2P-M` for the same
//           stale-snapshot mutation through two real OS processes); the two tests share the
//           interleaving but rest on different machinery, and neither replaces the other.
//         · It does not close (a) for C: C's pause is injected after `real.update` returns, so a
//           post-commit read there is indistinguishable from an in-lock read. It also does not make the
//           whole of I1 accepted: publish only, nothing after stage 2, and no "simultaneous arrival"
//           distribution (see the list at the bottom of this header).
//       THE REMAINING LIMITS ARE COVERAGE GAPS, NOT evidence that the production write path has
//       degraded: `qzone-write-path-offline.mjs` passes `state` to both `gateRefusal` and `authorizeTool`
//       today. Nothing here says it does otherwise.
//   R8  `updateIndex === 3` counts transactions on the WRAPPED store only. A change that reached the
//       database through the raw handle would not be counted. This is a known limitation, not a defect.
// R2's 他证 does NOT close R5: it pins WHO held the lock during each marker, not WHERE the `writePaused`
// read happened, and not WHICH state the decision used. Those are three different bits.
//
// AND A FORGERY IT DOES NOT CATCH (t43, measured — added because the marker assertions used to claim
// more): each marker FILE also carries a `lockHeld` field that the CHILD writes. That field catches a
// marker emitted AFTER COMMIT, but NOT a marker emitted BEFORE `BEGIN` with `lockHeld` hardcoded — the
// 5th review measured that shape green 10/10 (writer 6/6, pauser 4/4). The attributable evidence is
// `parentProbe.held` (the parent's own reading, made while the owner is the only possible holder); the
// `lockHeld` field is self-report and is described as such at every assertion site.
//
// ⚠️ HOW TO CONSTRUCT A FAITHFUL POST-COMMIT FORGERY HERE (t43). Do NOT express "write the marker after
// COMMIT" with `setTimeout(..., 0)`: the children busy-wait with `Atomics.wait`, which blocks the event
// loop, so the timer never fires and the failure surfaces as an 8s PEER TIMEOUT instead of an evidence
// red. A timeout means "the fixture hung", NOT "the hole is closed". The faithful shape is a SYNCHRONOUS
// post-commit write (call the raw `real.update`, then write the marker) — that is what produces
// `parentProbe.held === false`.
//
// ⚠️ AND A TRAP IN HOW YOU BUILD THE COUNTER-CONTROLS THEMSELVES (t44, hit by the captain). The
// counter-controls patch a COPY of `qzone-write-path-offline.mjs` by anchor-string replacement, so a new
// mutation that INSERTION-SHIFTS one of those anchors makes CC1/CC2 fail on
// `反控补丁的锚点必须存在: let verdict = { paused: false }; …` — which LOOKS like "the mutation was
// detected" but is pure anchor pollution; the assertion that fired is about the fixture, not about the
// behaviour. Measured: a first attempt at the R5 counterexample reported 7 pass / 2 fail for exactly this
// reason, and the correct run (anchor preserved) is 9 pass / 0 fail. Rule: when a counter-control goes
// red, READ THE FAILING ASSERTION — if it names an anchor, the run proves nothing about the semantics.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createOfflineWritePath } from '../src/core/qzone-write-path-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';

const NOW = Date.parse('2026-11-14T04:00:00.000Z');
const TARGET = '9876543210';
const CHILD_TIMEOUT_MS = 8000;          // contract: each child ≤ 10s

const tempDir = (label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-i1-${label}-`));
  return {
    dir,
    dbPath: path.join(dir, 'state.db'),
    mark: (name) => path.join(dir, name),
    /**
     * Remove the temp directory and REPORT whether it is really gone.
     *
     * This used to swallow every failure (`catch { /* windows handle *\/ }`), so a leaked directory was
     * invisible — measured residuals were 0 by luck, not by check. Now every caller asserts the
     * returned boolean in its `finally`, so a leak fails the test instead of disappearing.
     *
     * @returns {boolean} true only when `dir` no longer exists.
     */
    cleanup() {
      for (let i = 0; i < 20; i += 1) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows keeps handles briefly */ }
        if (!fs.existsSync(dir)) return true;
      }
      return false;
    },
  };
};

const baseState = () => ({
  enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
  tools: { publish: true, comment: true, reply: true, like: true },
  limits: { post: 3, comment: 25, like: 30 },
  ledger: { day: beijingDay(NOW), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
  lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [],
  audit: [], writeGate: null, auditGaps: [],
});

const request = (id) => ({
  id, action: 'publish', target: TARGET, postId: 'p-1', source: 'qq', content: 'i1',
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modUrl = (root, rel) => new URL(`file://${path.join(root, rel).replace(/\\/g, '/')}`).href;

/**
 * Probe the write lock on `file` from THIS process via a second connection. `BEGIN IMMEDIATE` succeeds
 * when nobody holds it, raises SQLITE_BUSY when somebody does, and `busy_timeout=0` keeps the answer
 * immediate. Returns null when the file cannot be opened at all.
 *
 * The parent uses this for the 他证 probe in `watchStage1b`; each CHILD embeds its own copy (the child
 * sources are template strings, so they cannot share this function).
 */
const probeHeld = (file) => {
  let probe;
  try { probe = new DatabaseSync(file); } catch { return null; }
  try {
    probe.exec('PRAGMA busy_timeout=0');
    probe.exec('BEGIN IMMEDIATE');
    probe.exec('COMMIT');
    return false;
  } catch { return true; } finally { try { probe.close(); } catch {} }
};

// ── child fixtures ────────────────────────────────────────────────────────────────────────────
//
// Both children are written into the temp dir and import the REAL modules through absolute
// `file://` URLs: a relative specifier would resolve against %TEMP% instead of the repo (measured
// failure in LZ-9b). Neither child touches the network or a real platform.

const WRITER_CHILD = (storeUrl, writePathUrl) => `
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openOfflineStore } from ${JSON.stringify(storeUrl)};
import { createOfflineWritePath } from ${JSON.stringify(writePathUrl)};

const [dbPath, dir, mode, handshake, id] = process.argv.slice(2);
/**
 * Write a marker file WITH A PAYLOAD. The payload is the point: the two in-lock markers carry
 * a "lockHeld" flag evaluated AT THE MARK SITE, so the file itself records whether the write lock was
 * held when the marker was written. A separate "proof" variable computed somewhere else could be true
 * while the marker had already drifted out of its transaction (measured: that mutation stayed green).
 */
const mark = (name, payload) => fs.writeFileSync(path.join(dir, name), JSON.stringify(payload ?? 1));
const has = (name) => fs.existsSync(path.join(dir, name));
const waitFor = (name) => {
  const end = Date.now() + ${CHILD_TIMEOUT_MS};
  while (!has(name)) {
    if (Date.now() > end) throw new Error('child timeout waiting for ' + name);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
};

// HANDSHAKE SWITCH. The mutual handshake is what makes the CONCURRENT runs deterministic: each side
// waits until the other is really alive before touching the database. It is fatal to a SEQUENTIAL run
// (the first child would wait for a peer the parent has not started yet, and die on its own timeout),
// so I1-CC3 passes 'none' and each child runs start-to-finish alone. Everything else — the in-lock
// markers, the lock probes, the transaction shape — stays byte-identical, which is the point: the only
// difference between I1-A and I1-CC3 is WHEN the two processes were alive.
const HANDSHAKE = handshake !== 'none';

// Does somebody else hold the write lock on THAT file right now? A BEGIN IMMEDIATE from a second
// connection succeeds when nobody holds it and raises SQLITE_BUSY when somebody does; busy_timeout=0
// makes the answer immediate instead of waiting. Returns null when the file cannot be opened at all.
const probeHeld = (file) => {
  let probe;
  try { probe = new DatabaseSync(file); } catch { return null; }
  try {
    probe.exec('PRAGMA busy_timeout=0');
    probe.exec('BEGIN IMMEDIATE');
    probe.exec('COMMIT');
    return false;
  } catch { return true; } finally { try { probe.close(); } catch {} }
};

/**
 * True iff THIS process holds the write lock on \`file\` (its own BEGIN IMMEDIATE is open).
 *
 * ⚠️ SELF-CHECK REQUIRED (t41-R2). Every marker proof — \`stage1bHeldLock\`, \`stage1bHeldLockAfterMark\`
 * and the \`lockHeld\` field written INTO the marker file — derives from this single function, so a
 * constant \`() => true\` used to satisfy all three at once while the marker had quietly moved out of
 * its transaction (measured: 9/9 green). The calibration below closes that: it drives THIS function
 * against a private database twice — once while a transaction it opened is definitely holding the
 * lock, once after that transaction committed — and the parent refuses the run unless the two answers
 * differ. A constant cannot produce both, so the constant mutant now fails on its own, independently
 * of where the marker sits.
 */
const weHoldTheLock = (file = dbPath) => probeHeld(file) === true;

/**
 * SELF-CHECK, PART 2 (t41-R2). The calibration below only proves the probe CAN answer false; it
 * says nothing about WHERE a marker sits, and the child could satisfy every self-reported field with a
 * hardcoded true (measured P8/P9). That half is closed by the RENDEZVOUS: both in-lock markers block
 * until the parent has run its own probe (watchStage1b), so the parent's independent reading decides.
 * The two halves are complementary and neither replaces the other.
 */
/**
 * Drive \`weHoldTheLock\` through both states on a PRIVATE database file.
 *
 * A private file is used so no peer process can perturb the reading: the "held" half must come from a
 * transaction this process opened, and the "free" half from the moment after it commits. Both halves
 * go through \`weHoldTheLock\` — not through \`probeHeld\` directly — because that is the function the
 * markers depend on; testing the helper would leave the constant mutant green.
 *
 * @returns {{held: boolean|null, free: boolean|null}} must be exactly \`{held:true, free:false}\`.
 */
const calibrateProbe = () => {
  // UNIQUE PER PROCESS (t41-R2 follow-up). Both children start at once, so a shared calibration file
  // meant they took each other's write lock and the second one's CREATE TABLE failed — measured: A/B
  // timing out at 8s. The calibration is about THIS process's probe, so its file must be its own.
  const calPath = path.join(dir, 'probe-calibration-' + process.pid + '.db');
  const cal = new DatabaseSync(calPath);
  let held = null;
  let free = null;
  try {
    cal.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    cal.exec('BEGIN IMMEDIATE');
    held = weHoldTheLock(calPath);      // somebody (us) holds the write lock ⇒ must be true
    cal.exec('COMMIT');
    free = weHoldTheLock(calPath);      // nobody holds it any more ⇒ must be false
  } finally { try { cal.close(); } catch {} }
  return { held, free };
};

const NOW = ${NOW};
// ★ SELF-CHECK FIRST (t41-R2): the probe must be able to answer BOTH ways before any marker trusts it.
const probeCalibration = calibrateProbe();
const real = openOfflineStore(dbPath, {});
const lockObservations = [];   // ← THE ordering evidence: writePaused as read INSIDE the write lock
const markerProof = {};        // ✓ evidence that each marker was written WHILE the lock was held
// C2P only: the two probes this process takes AROUND the handoff. Both are expected to answer
// \`false\` — if either says \`true\` the handoff drifted inside a transaction (the deadlock shape).
const handoff = { pendingLockHeld: null, preStage1bLockHeld: null };
let updateIndex = 0;
const store = { ...real, update(fn) {
  updateIndex += 1;
  const index = updateIndex;
  // ── C2P (mode 'pauseBetween'): HAND THE WRITE-LOCK WINDOW TO THE OTHER OS PROCESS ──────────
  // The second wrapper call is stage 1b. For this interleaving the peer must commit the pause in the
  // gap between the reservation and this transaction, so this process, BEFORE opening any
  // transaction of its own:
  //   (1) probes the lock (it must be free: the reservation committed and nothing else is running),
  //   (2) announces \`writer.stage1bPending\` — "reserve is committed, stage 1b has NOT begun",
  //   (3) waits for \`pauser.committed\` — the PEER's real COMMIT, not a timer,
  //   (4) probes again and announces \`writer.preStage1b\`, then waits for the parent's own probe,
  //   (5) only then opens BEGIN IMMEDIATE.
  //
  // WHY THE WAIT IS OUT HERE AND NOT INSIDE THE CALLBACK: a writer holding BEGIN IMMEDIATE while
  // waiting for a peer's COMMIT would block that COMMIT with its own lock, the wait could never
  // end, and the run would surface as a CHILD TIMEOUT — a fixture hang, which must never be read as
  // an ordering result. The probes are taken before the corresponding marker file exists, so the
  // peer cannot be the one holding the lock; a marker that drifted inside a transaction would report
  // lockHeld:true and the parent rejects the run.
  if (mode === 'pauseBetween' && index === 2) {
    if (!HANDSHAKE) throw new Error('pauseBetween requires the mutual handshake');
    handoff.pendingLockHeld = weHoldTheLock() === true;
    mark('writer.stage1bPending', { lockHeld: handoff.pendingLockHeld, at: Date.now() });
    // The peer is ALSO gated on this file (see PAUSER_CHILD): it must not take the lock until the
    // parent has probed this window, otherwise the parent's reading could land on the PEER's lock and
    // stop being attributable to "the reservation committed and nothing is held".
    waitFor('parent.probed.pending');
    waitFor('pauser.committed');
    handoff.preStage1bLockHeld = weHoldTheLock() === true;
    mark('writer.preStage1b', { lockHeld: handoff.preStage1bLockHeld, at: Date.now() });
    waitFor('parent.probed.preStage1b');
  }
  return real.update((state) => {
    lockObservations.push(state.writePaused === true);
    // Written inside the lock on purpose: for mode 'grantWins' this marker is what makes the pauser
    // queue behind stage 1b instead of racing it. \`markerProof\` records that the lock was really
    // held at that instant, so moving this line out of the transaction turns a test red instead of
    // silently degrading the harness.
    if (index === 2) {
      markerProof.stage1bHeldLock = weHoldTheLock() === true;
      mark('writer.stage1b', { lockHeld: weHoldTheLock() === true, at: Date.now() });
      markerProof.stage1bHeldLockAfterMark = weHoldTheLock() === true;
      // ★ HOLD THE LOCK UNTIL THE PARENT HAS PROBED (t41-R2, 他证). Everything above is SELF-reported:
      // a hardcoded \`true\` satisfies all three (measured). This wait makes the marker a rendezvous the
      // parent must answer while this transaction is still open, so the parent's own probe — not any
      // value written here — decides whether the lock was really held.
      if (HANDSHAKE && mode !== 'pauseBetween') waitFor('parent.probed.stage1b');
    }
    return fn(state);
  });
}};

const calls = [];
const writePath = createOfflineWritePath({
  store, clock: () => NOW,
  transport: async () => { calls.push(1); return { ok: true }; },
});

// ── DIAGNOSTIC-ONLY liveness window (NOT used for ordering, NOT used for concurrency) ─────────
// \`readyAt\`/\`aliveUntil\` are this process's own clock readings about itself. Nothing in this file
// judges on them any more: the concurrency verdict comes from the PARENT's raw spawn/close readings
// (\`assertParentConcurrent\`). They stay in the report as a diagnostic only, labelled as such, and
// must never be promoted back into evidence — a child can print whatever it likes here.
const readyAt = Date.now();
mark('writer.ready');
if (HANDSHAKE) waitFor('pauser.ready');   // 'none' ⇒ sequential run: no peer is coming, do not wait
if (HANDSHAKE && mode === 'pauseWins') {
  // THE COMPETITOR MUST NOT GRAB THE LOCK DURING THE PARENT'S PROBE (t42, HIGH).
  //
  // probeHeld answers "is SOMEBODY holding the write lock", not "is THE PAUSER holding it". Without
  // the second wait this writer begins its own BEGIN IMMEDIATE the instant pauser.inlock appears, so
  // the parent's probe can land on the WRITER's lock and report held:true even when the pauser wrote
  // its marker outside any transaction (measured: that forgery was green 9/10 runs). Holding this
  // process back until parent.probed.inlock exists leaves exactly one possible lock holder while the
  // probe runs — the pauser — so held:true becomes attributable.
  waitFor('pauser.inlock');
  waitFor('parent.probed.inlock');
}

const first = await writePath.write(${JSON.stringify(request('i1-w'))});
let followUp = null;
if (mode === 'grantWins') {
  // 'none' ⇒ nobody will ever write this marker; the sequential run must not wait for it either.
  if (HANDSHAKE) waitFor('pauser.committed');   // pause is durable now; a NEW call must be refused
  followUp = await writePath.write(${JSON.stringify(request('i1-w2'))});
}
const after = real.read();
process.stdout.write(JSON.stringify({
  mode, readyAt, aliveUntil: Date.now(),
  probeCalibration, markerProof, lockObservations, updateIndex, handoff,
  first, followUp, transportCalls: calls.length,
  reservations: Object.keys(after.ledger.reservations).sort(),
  usedPost: after.ledger.used.post,
  // THIS process's own post-run read of the pause flag — the consequence, not the ordering evidence.
  dbWritePaused: after.writePaused,
}));
real.close();
`;

const PAUSER_CHILD = (storeUrl) => `
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openOfflineStore } from ${JSON.stringify(storeUrl)};

const [dbPath, dir, mode, handshake] = process.argv.slice(2);
// See WRITER_CHILD: 'none' means the parent is running the two programs one after the other, so
// neither may wait for the other. Everything else in this fixture is unchanged on purpose.
const HANDSHAKE = handshake !== 'none';
const mark = (name, payload) => fs.writeFileSync(path.join(dir, name), JSON.stringify(payload ?? 1));
const has = (name) => fs.existsSync(path.join(dir, name));
const waitFor = (name) => {
  const end = Date.now() + ${CHILD_TIMEOUT_MS};
  while (!has(name)) {
    if (Date.now() > end) throw new Error('pauser timeout waiting for ' + name);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
};

// Same probe + same SELF-CHECK as WRITER_CHILD: the pauser's inlock proof derives from this one
// function too, so a constant \`() => true\` had to be ruled out here as well.
const probeHeld = (file) => {
  let probe;
  try { probe = new DatabaseSync(file); } catch { return null; }
  try {
    probe.exec('PRAGMA busy_timeout=0');
    probe.exec('BEGIN IMMEDIATE');
    probe.exec('COMMIT');
    return false;
  } catch { return true; } finally { try { probe.close(); } catch {} }
};
const weHoldTheLock = (file = dbPath) => probeHeld(file) === true;
const calibrateProbe = () => {
  // UNIQUE PER PROCESS (t41-R2 follow-up). Both children start at once, so a shared calibration file
  // meant they took each other's write lock and the second one's CREATE TABLE failed — measured: A/B
  // timing out at 8s. The calibration is about THIS process's probe, so its file must be its own.
  const calPath = path.join(dir, 'probe-calibration-' + process.pid + '.db');
  const cal = new DatabaseSync(calPath);
  let held = null;
  let free = null;
  try {
    cal.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    cal.exec('BEGIN IMMEDIATE');
    held = weHoldTheLock(calPath);
    cal.exec('COMMIT');
    free = weHoldTheLock(calPath);
  } finally { try { cal.close(); } catch {} }
  return { held, free };
};

const probeCalibration = calibrateProbe();
const real = openOfflineStore(dbPath, {});
const markerProof = {};
const readyAt = Date.now();
mark('pauser.ready');
if (HANDSHAKE) waitFor('writer.ready');   // 'none' ⇒ sequential run: no peer is coming, do not wait
if (mode === 'pauseWins') {
  // The marker is written INSIDE the transaction: it exists only while this pause holds the write
  // lock, so the writer cannot begin its own BEGIN IMMEDIATE before this one commits. The marker's
  // PAYLOAD is \`lockHeld\` measured AT THE MARK SITE, so moving this line after COMMIT makes the file
  // itself say "the lock was not held" — the harness reads that back and turns red.
  real.update((state) => {
    markerProof.inlockHeldLock = weHoldTheLock() === true;
    mark('pauser.inlock', { lockHeld: weHoldTheLock() === true, at: Date.now() });
    markerProof.inlockHeldLockAfterMark = weHoldTheLock() === true;
    // ★ HOLD THE LOCK UNTIL THE PARENT HAS PROBED (t41-R2, 他证) — same rendezvous as the writer's
    // stage-1b marker. Every field above is SELF-reported, so a hardcoded \`true\` satisfied all of them
    // (measured P9: 9/9 green even with this marker moved after COMMIT). This wait makes the parent's
    // independent probe the deciding evidence.
    if (HANDSHAKE) waitFor('parent.probed.inlock');
    return { ...state, writePaused: true };
  });
} else if (mode === 'pauseBetween') {
  // ── C2P: THE PAUSE COMMITS INSIDE THE WINDOW THE WRITER HANDED OVER ──────────────────────────
  // The writer has (a) committed its reservation, (b) proved the lock was free, and (c) announced
  // \`writer.stage1bPending\` — and it is now parked OUTSIDE any transaction waiting for the marker
  // written below. So this process owns the serialization window from here until its COMMIT lands.
  //
  // ⚠️ THIS IS A REAL SECOND OS PROCESS with its own handle on the same file: the pause is a genuine
  // \`BEGIN IMMEDIATE … COMMIT\` on the same SQLite serialization boundary the writer's stage 1b uses,
  // not a state arranged ahead of time inside one process's handle.
  if (HANDSHAKE) {
    waitFor('writer.stage1bPending');
    // Do not take the lock until the parent has finished its own probe of the handed-over window.
    // Without this the parent's probe could land on OUR lock and \`held:false\` would stop being
    // attributable to "the reservation committed and nothing holds the lock".
    waitFor('parent.probed.pending');
  }
  real.update((state) => ({ ...state, writePaused: true }));
  // The shared \`pauser.committed\` write below runs AFTER this COMMIT returns, so the file's existence
  // means the pause is DURABLE. (Contrast \`pauser.inlock\`, written from INSIDE the transaction; that
  // shape must NOT be used here, or the writer could wake up before the commit lands and open stage 1b
  // ahead of the pause it is supposed to observe.)
} else {
  // The competitor must not grab the lock during the parent's probe (t42, HIGH).
  //
  // probeHeld answers "is SOMEBODY holding the write lock", not "is THE WRITER holding it". Without
  // the second wait this pauser takes BEGIN IMMEDIATE as soon as writer.stage1b appears, so the
  // parent's probe can land on the PAUSER's lock and report held:true while the writer had already
  // committed its marker outside the transaction (measured: that forgery was green 10/10 runs). Waiting
  // for parent.probed.stage1b first leaves the writer as the only possible lock holder during the
  // probe, which is what makes the reading attributable.
  if (HANDSHAKE) {
    waitFor('writer.stage1b');       // 'none' ⇒ nobody writes it; do not wait
    waitFor('parent.probed.stage1b');
  }
  real.update((state) => ({ ...state, writePaused: true }));
}
mark('pauser.committed');
const after = real.read();
process.stdout.write(JSON.stringify({
  mode, readyAt, aliveUntil: Date.now(), markerProof, probeCalibration,
  writePaused: after.writePaused,
}));
real.close();
`;

/**
 * Run one writer + one pauser as two independent OS processes over ONE temporary SQLite file.
 *
 * ⚠️ THIS FUNCTION CLEANS UP AFTER ITSELF WHEN IT THROWS (t43). A caller cannot guard this: the
 * directory is created here, so a throw between `mkdtemp` and `return` leaves the caller's `pair`
 * still `null` and its `finally { if (pair) … }` guards nothing. Measured (5th review, M6): making
 * `race()` throw right after `mkdtemp` leaked FOUR directories — a/b/cc3/cc3c — while every caller
 * looked correctly guarded. So the cleanup lives HERE, where the directory is known.
 */
function race(label, mode, options = {}) {
  let t = null;
  try {
    t = tempDir(label);
    const seed = openOfflineStore(t.dbPath, baseState());
    seed.close();

    const dir = repoRoot;
    // ── OPTIONAL MODULE-GRAPH COPY (t46, C2P counter-control) ────────────────────────────────
    // With `coreCopy: true` the children import a THROWAWAY COPY of the whole `src/core` graph, so the
    // SAME two-process protocol can be run against a mutated module. `copyCore(t)` puts it at
    // `<t.dir>/core`; BOTH children must import from that copy (store AND write path), because the
    // send-authority registry is per module instance and mixing graphs is (correctly) refused.
    // The default keeps the repo modules, so I1-A / I1-B / I1-CC3 are byte-identical to before.
    const core = options.coreCopy === true ? copyCore(t) : path.join(dir, 'src', 'core');
    fs.writeFileSync(t.mark('writer.mjs'), WRITER_CHILD(
      modUrl(core, 'qzone-store-offline.mjs'),
      modUrl(core, 'qzone-write-path-offline.mjs'),
    ));
    fs.writeFileSync(t.mark('pauser.mjs'), PAUSER_CHILD(modUrl(core, 'qzone-store-offline.mjs')));
    return { t, dir, core };
  } catch (error) {
    // Best effort, and deliberately NOT asserted: this runs while an error is already propagating, and
    // replacing that error with a cleanup failure would hide the real cause. The caller's own
    // `finally`-asserted cleanup still covers the normal path.
    if (t !== null) { try { t.cleanup(); } catch { /* the original error wins */ } }
    throw error;
  }
}

/**
 * 他证 (t41-R2, strengthened t42): probe the write lock from the PARENT while the OTHER side's
 * in-lock marker exists, and make the reading ATTRIBUTABLE to the side under test.
 *
 * `probeHeld` only answers "is SOMEBODY holding the write lock". Measured (4th review): with the
 * competitor free to run, a forgery that moved the marker out of its transaction and hardcoded
 * `lockHeld: true` stayed GREEN 10/10 — because the COMPETITOR had grabbed the lock by the time the
 * parent looked. The fix is a two-sided rendezvous: the marker's owner holds its transaction open
 * until `parent.probed.<key>` appears, AND THE COMPETITOR also waits for that same file before it
 * touches the database (see the child fixtures). During the probe window the owner is then the only
 * possible lock holder, so `held:true` means "the marker's owner held the lock" and nothing else.
 *
 * The reading is written to `parent.probe.<key>` as a durable record and read back by the assertion,
 * so the file is evidence rather than a write-only artifact.
 *
 * Polling is a rendezvous on a file, not a probability sleep: it returns as soon as the marker exists,
 * and gives up the moment the children exit so a broken fixture cannot hang the run.
 */
function watchStage1b(t, isDone, markerName, probeKey, signal) {
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let timer;
    const stop = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve({ held: null, reason: 'finished or timed out' });
    };
    const tick = () => {
      if (signal?.aborted || isDone() || Date.now() > deadline) { stop(); return; }
      try {
        if (fs.existsSync(t.mark(markerName))) {
          const held = probeHeld(t.dbPath);
          fs.writeFileSync(t.mark(`parent.probe.${probeKey}`), JSON.stringify({ held, at: Date.now() }));
          fs.writeFileSync(t.mark(`parent.probed.${probeKey}`), '1');   // release the child
          signal?.removeEventListener('abort', stop);
          resolve({ held, at: Date.now() });
          return;
        }
        timer = setTimeout(tick, 2);
      } catch (error) {
        signal?.removeEventListener('abort', stop);
        reject(error);
      }
    };
    signal?.addEventListener('abort', stop, { once: true });
    tick();
  });
}

/**
 * Both competitors must be RUNNING AT THE SAME TIME, so they are spawned with the asynchronous
 * `spawn` — a `spawnSync` would block the parent until the first child exits, and that child is
 * waiting for a marker the second child can then never write (measured: the pauser was SIGTERMed
 * after its own timeout). Each child is still bounded by CHILD_TIMEOUT_MS.
 */
async function runPair({ t, dir }, mode, ordering = 'concurrent') {
  const children = [];
  const probes = new AbortController();
  let probeWatch = Promise.resolve(null);
  const start = (script, args, who) => new Promise((resolve, reject) => {
    // argv tail: [mode, handshake, ...args]. The handshake travels as an ARGUMENT rather than being
    // inferred from `ordering`, so it stays visible at the call site and cannot drift out of sync.
    const handshake = ordering === 'sequential' ? 'none' : 'mutual';
    const child = spawn(process.execPath, [script, t.dbPath, t.dir, mode, handshake, ...args], {
      cwd: dir, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push({ child, closed: new Promise((done) => child.once('close', done)) });
    // ── OS-LEVEL IDENTITY, RECORDED BY THE PARENT (t46) ──────────────────────────────────────
    // `child.pid` comes from the SPAWN CALL, not from anything a child printed, so "two independent
    // OS processes" is a fact the parent observed. `startedAt`/`exitedAt` are the parent's own clock
    // readings around the spawn and the `close` event — deliberately NOT the children's self-reported
    // liveness windows, which R4 in the header says are unanchored.
    const pid = child.pid ?? null;
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, CHILD_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ who, pid, startedAt, exitedAt: Date.now(), status, signal, stdout, stderr, timedOut });
    });
  });

  // Launched together: neither can observe the other's `ready` marker unless both are alive.
  //
  // `ordering: 'sequential'` is NOT a supported production mode — it exists so a test can PROVE that
  // running the two programs one after the other (the way a weaker harness would) turns the concurrency
  // assertion red. The pauser runs to completion FIRST, then the writer starts, and both children are
  // told `handshake: 'none'` so neither waits for a peer that is not there yet.
  //
  // SEQUENTIAL IS ONLY VALID FOR `pauseWins`. In `grantWins` the pauser waits for the writer's stage-1b
  // marker, which a sequential run writes only AFTER the pauser has exited — an unavoidable deadlock.
  // Rather than special-case that in the fixture, `runPair` REFUSES the combination, so a future test
  // cannot accidentally create a harness that hangs for CHILD_TIMEOUT_MS and then reads the timeout as
  // an ordering result.
  try {
    if (ordering === 'sequential') {
      if (mode !== 'pauseWins') {
        throw new TypeError(`sequential ordering only supports 'pauseWins' (got '${mode}'): grantWins needs a live peer`);
      }
      const pauser = await start(t.mark('pauser.mjs'), [], 'pauser');
      const writer = await start(t.mark('writer.mjs'), ['i1-w'], 'writer');
      return { t, writer, pauser, parentProbe: null };
    }
    // Children that block inside a transaction waiting for the parent's probe, so the probe must be
    // WATCHING before the pair is awaited — otherwise the run deadlocks on its own rendezvous.
    let writerDone = false;
    const needsProbe = mode === 'grantWins' || mode === 'pauseWins';
    const probeKey = mode === 'grantWins' ? 'stage1b' : 'inlock';
    const markerName = mode === 'grantWins' ? 'writer.stage1b' : 'pauser.inlock';
    // ── C2P: TWO parent probes, both OUTSIDE any transaction, and both attributable ─────────────
    //   · `pending`    — written when the writer's reservation has COMMITTED and stage 1b has NOT
    //                    begun. During this window neither child holds the lock: the writer is parked
    //                    before its BEGIN, and the pauser is gated on `parent.probed.pending` so it
    //                    cannot have taken the lock yet. Reading a FREE lock here is therefore
    //                    attributable, exactly as the 他证 rule in `watchStage1b` requires.
    //   · `preStage1b` — written after the peer's COMMIT, immediately before stage 1b's BEGIN. The
    //                    peer has exited its transaction and the writer still has not opened one.
    // Both watchers run while the pair is alive; `isDone` releases them if a child dies.
    probeWatch = ordering === 'sequential'
      ? Promise.resolve(null)
      : mode === 'pauseBetween'
        ? watchStage1b(t, () => writerDone, 'writer.stage1bPending', 'pending', probes.signal)
          .then(async (pending) => ({
            pending,
            preStage1b: await watchStage1b(t, () => writerDone, 'writer.preStage1b', 'preStage1b', probes.signal),
          }))
        : needsProbe
          ? watchStage1b(t, () => writerDone, markerName, probeKey, probes.signal)
          : Promise.resolve(null);
    // Observe an early probe I/O rejection while the children are still being awaited.
    probeWatch.catch(() => {});
    const [pauser, writer] = await Promise.all([
      start(t.mark('pauser.mjs'), [], 'pauser'),
      start(t.mark('writer.mjs'), ['i1-w'], 'writer').then((r) => { writerDone = true; return r; }),
    ]);
    const parentProbe = await probeWatch;
    return { t, writer, pauser, parentProbe };
  } finally {
    // A failed spawn rejects Promise.all before its peer closes. Stop parent polling FIRST,
    // then terminate/wait every child owned by this pair before callers may delete its directory.
    // The original spawn/probe error is not replaced by a cleanup assertion.
    probes.abort();
    for (const { child } of children) {
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.all(children.map(({ closed }) => closed));
    await probeWatch.catch(() => {});
  }
}

/**
 * ★ THE CONCURRENCY VERDICT (requirement 2) — ONE parent-side predicate, used by A, B, C2P and the
 * CC3 sequential counter-control alike.
 *
 * ITS INPUT IS THE RAW `runPair` RESULT: `{ pid, startedAt, exitedAt }` recorded by the PARENT around
 * `spawn` and the `close` event. It deliberately does NOT accept the children's parsed stdout, so the
 * self-reported `readyAt`/`aliveUntil` (header R4 — unanchored, printable by any child) cannot reach the
 * verdict. Passing the parsed object instead fails on the `readyAt` guard below rather than silently
 * working.
 *
 * WHAT IT CHECKS:
 *   · both roles hold a REAL positive-integer `pid` from the spawn call, and the two PIDs DIFFER;
 *   · each role's parent-recorded `[startedAt, exitedAt]` is finite and ordered;
 *   · the two parent-recorded windows INTERSECT with positive width.
 *
 * ⚠️ WHAT THE WINDOW IS *NOT*. `[startedAt, exitedAt]` is the parent's OBSERVATION BOUNDARY — from the
 * moment `spawn` returned to the moment `close` arrived — not a precise kernel-level lifetime for the
 * child. A process can be dead before `close` is delivered and can be alive before the parent's
 * `Date.now()` runs. So this predicate only says "the parent had both roles in flight at the same
 * time"; the claim "both really executed their protocol concurrently" still rests on the existing
 * mutual handshakes (each side waits for the other's `ready` marker) and on the in-lock/probe evidence
 * in each test. Neither half stands alone and neither may be read as the other.
 */
function assertParentConcurrent(writer, pauser, label = '') {
  const at = label === '' ? '' : `${label}：`;
  for (const [who, raw] of [['writer', writer], ['pauser', pauser]]) {
    assert.equal(Object.hasOwn(raw, 'readyAt'), false,
      `${at}${who} 必须是 runPair 的原始结果（pid/startedAt/exitedAt），不能是子进程 stdout 解析出的对象`);
    assert.equal(Number.isInteger(raw.pid) && raw.pid > 0, true,
      `${at}父进程必须拿到 ${who} 的真实正整数 pid（实际 ${raw.pid}）`);
    assert.equal(Number.isFinite(raw.startedAt) && Number.isFinite(raw.exitedAt), true,
      `${at}父进程必须记录 ${who} 的起止时刻（实际 ${raw.startedAt} / ${raw.exitedAt}）`);
    assert.equal(raw.startedAt <= raw.exitedAt, true,
      `${at}父进程记录的 ${who} 起止必须有序（${raw.startedAt} > ${raw.exitedAt}）`);
  }
  assert.notEqual(writer.pid, pauser.pid,
    `${at}两个角色必须是两个不同的 OS 进程（writer ${writer.pid} / pauser ${pauser.pid}）`);
  const start = Math.max(writer.startedAt, pauser.startedAt);
  const end = Math.min(writer.exitedAt, pauser.exitedAt);
  assert.equal(start < end, true,
    `★★★ ${at}并发证据不成立：父侧观察窗口必须相交（交集 ${end - start}ms，`
    + `writer=[${writer.startedAt},${writer.exitedAt}] pauser=[${pauser.startedAt},${pauser.exitedAt}]）`);
  return { start, end, overlapMs: end - start };
}

/**
 * Read a marker file the children wrote and return its parsed payload.
 *
 * Requirement 3 needs this: the marker FILE must itself record that the write lock was held. Asserting
 * only on a value the child kept in memory would stay green when the `mark(...)` call drifts out of its
 * transaction (measured), because the in-memory flag and the marker are written by two different lines.
 */
function readMarker(t, name, who) {
  const file = t.mark(name);
  assert.equal(fs.existsSync(file), true, `${who}: 标记文件 ${name} 必须存在`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Requirement 5: a failed cleanup must FAIL THE TEST, not be swallowed.
 *
 * The old `cleanup()` retried 20 times inside `catch {}` and returned nothing, so a leaked directory was
 * invisible (residuals were 0 by luck). Two things are now asserted:
 *   · `cleanup()`'s own verdict, and
 *   · the DIRECTORY STATE ITSELF — the `fs.existsSync` line below re-checks the filesystem, which is
 *     what "visible" means. Without that second half, a `cleanup()` that simply returned `true` would
 *     satisfy everything (measured: `return true` with no delete stayed green until this was added).
 */
function assertCleanup(t) {
  const reported = t.cleanup();
  assert.equal(reported, true, `★ cleanup() 报告失败：临时目录未能删除 ${t.dir}`);
  assert.equal(fs.existsSync(t.dir), false, `★★ 临时目录必须真的不存在了：${t.dir}`);
}

/**
 * Requirement 7, expressed as a PREDICATE instead of an inline "field is absent" check.
 *
 * The previous assertion was `Object.hasOwn(first, 'quotaConsumed') === false`. It held only because
 * `qzone-write-path-offline.mjs` is internally INCONSISTENT: the pre-reservation `refused()` helper sets
 * `quotaConsumed: false` while the reserve-kernel refusal does not. The day somebody unifies those two
 * shapes, I1-A would fail for a reason that has nothing to do with ordering.
 *
 * What the scenario really establishes is WHERE the refusal came from — the reservation kernel
 * (`reserveOfflinePost` → `authorizeTool` → `write_paused`), not stage 1b. That is stated positively
 * (`stage:'reserve'`, `reason:'write_paused'`, nothing reserved, nothing spent, nothing sent) and it
 * accepts EITHER quota-flag shape. `I1-A2` feeds this predicate both shapes so the intent cannot
 * silently collapse back into "the field happens to be missing".
 */
function refusalIsReserveKernel(result, { reservations, used, transportCalls }) {
  if (!result || result.ok !== false) return false;
  if (result.stage !== 'reserve') return false;                 // not the stage-1b refusal shape
  if (result.reason !== 'write_paused') return false;
  if (Object.hasOwn(result, 'quotaConsumed') && result.quotaConsumed !== false) return false;
  if (reservations.length !== 0) return false;                  // kernel refused ⇒ nothing reserved
  if (used !== 0) return false;                                 // ...and nothing spent
  if (transportCalls !== 0) return false;
  return true;
}

/**
 * Contract: a busy/timeout/non-zero child is a HARNESS FAILURE, never "it refused safely".
 * SQLITE_BUSY and a killed process both land here, so neither can be mistaken for an ordering result.
 *
 * One BENIGN exception is filtered explicitly: node:sqlite is flagged experimental on this runtime, so
 * every child emits the same `ExperimentalWarning` on stderr. That line is REMOVED and everything else
 * still fails the harness — filtering it by pattern (never by "stderr is allowed to be non-empty")
 * keeps a real error, a stack trace or a lock message from hiding behind it.
 */
const BENIGN_STDERR = /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time$|^\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)$/;

function assertChildHealthy(result, who) {
  const raw = `${result.stderr ?? ''}`;
  const leftover = raw.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !BENIGN_STDERR.test(line))
    .join('\n');
  assert.equal(result.timedOut, false, `${who}: 不得超时（>${CHILD_TIMEOUT_MS}ms 即装置失败）`);
  assert.equal(result.signal, null, `${who}: 不得被信号杀死（实际 ${result.signal}）`);
  assert.equal(result.status, 0,
    `${who}: 必须正常退出；非零/超时不是「安全拒绝」，是装置失败。stderr=${raw.slice(0, 400)}`);
  assert.equal(/SQLITE_BUSY|database is locked/i.test(raw), false,
    `${who}: 不得出现 SQLITE_BUSY —— 那是装置失败，不是排序结论`);
  assert.equal(leftover, '', `${who}: 除 SQLite experimental 警告外不得有 stderr（实际 ${leftover.slice(0, 400)}）`);
  return JSON.parse(result.stdout);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// A · the pause commits first ⇒ every transaction reads `true` ⇒ refused at the RESERVE
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('I1-A 暂停先取得串行化顺序：锁内读到 true，拒绝落在 reserve（write_paused），transport 零调用', async () => {
  // t42 MEDIUM / t43: the children are spawned inside the try and the cleanup handle is taken
  // IMMEDIATELY after the fixture exists, so a spawn failure (measured: ENOENT) still reaches
  // `assertCleanup`. What this `finally` CANNOT cover is a throw INSIDE `race()` itself — at that
  // moment `pair` is still null — so `race()` cleans up its own directory before rethrowing (t43,
  // measured: leaving it to the caller leaked 4 directories). Before t42 both `race()` and `runPair`
  // sat above the try and a spawn failure leaked the directory.
  // NOTE: `race()` returns `{ t, dir }` — the cleanup handle is `pair.t`, not the pair itself.
  let pair = null;
  let t = null;
  try {
    pair = race('a', 'pauseWins');
    // Assign the cleanup handle IMMEDIATELY after the fixture exists — before `runPair`, which is what
    // can throw (measured: spawn ENOENT leaked the directory when this line sat after the await).
    t = pair.t;
    const { writer, pauser, parentProbe } = await runPair(pair, 'pauseWins');
    const p = assertChildHealthy(pauser, 'pauser');
    const w = assertChildHealthy(writer, 'writer');

    // ★ CONCURRENCY (requirement 2): the PARENT's raw spawn/close evidence — the same predicate
    // I1-C2P and the I1-CC3 sequential counter-control use. The children's self-reported windows are
    // not an input here (header R4).
    assertParentConcurrent(writer, pauser, 'I1-A');
    assert.equal(p.writePaused, true, '暂停确实落盘了');

    // ★ The in-lock marker really was written while the transaction was open (requirement 3): the
    // marker FILE itself carries `lockHeld`, measured at the mark site, so the assertion cannot be
    // satisfied by moving the write out of the transaction (measured: moving it stayed green when only
    // an in-memory flag was checked).
    //
    // ★★ AND THE PROBE ITSELF MUST BE CALIBRATED (t41-R2). Every one of those proofs — the marker
    // file's `lockHeld`, `inlockHeldLock`, `inlockHeldLockAfterMark` — is derived from ONE function,
    // so a constant `() => true` used to satisfy all of them at once (measured: 9/9 green, and green
    // again with the marker moved out of its transaction). The child now drives its own probe through
    // both states on a private database; the parent refuses the run unless it saw BOTH. A constant
    // cannot return `false` here, so it fails on its own — independently of where the marker sits.
    assert.deepEqual(p.probeCalibration, { held: true, free: false },
      '★★★ 暂停者的锁探测必须自证：持锁时 true、无锁时 false。常量无法同时给出两者');
    assert.deepEqual(w.probeCalibration, { held: true, free: false },
      '★★★ 写入者的锁探测必须自证（同上）');
    const inlockMarker = readMarker(t, 'pauser.inlock', 'pauser');
    // ⚠️ WHAT THIS FIELD IS AND IS NOT (t43, correcting an earlier overclaim). `lockHeld` lives in the
    // marker FILE, written by the pauser itself, so it only records what the pauser computed. It does
    // catch a marker written AFTER COMMIT (the probe then answers false), but it does NOT catch a marker
    // written BEFORE `BEGIN` with `lockHeld` hardcoded — measured (5th review, M5b): that variant was
    // green 4/4. The assertion is kept because the post-commit shape is the one that actually occurred,
    // not because it proves the marker was written inside the transaction.
    assert.equal(inlockMarker.lockHeld, true, '★★ pauser.inlock 记录「写入时持锁」（子进程自报，见上方限制）');
    assert.equal(Number.isFinite(inlockMarker.at), true, '标记必须带写入时刻');
    // Same caveat for `markerProof`: self-reported by the pauser. The ATTRIBUTABLE evidence is
    // `parentProbe.held` below, not these three fields.
    assert.equal(p.markerProof.inlockHeldLock, true,
      '★★ 暂停者自报：写标记前探测到锁被占（自报，见 parentProbe 的他证）');
    assert.equal(p.markerProof.inlockHeldLockAfterMark, true,
      '★★ 暂停者自报：写标记后探测到锁仍被占（自报，见 parentProbe 的他证）');

    // ★★★ 他证, NOT 自证 (t41-R2, strengthened t42). All three fields above come from the child, so a
    // hardcoded `true` satisfied them. Now BOTH sides coordinate on `parent.probed.inlock`: the pauser
    // keeps its transaction open, and the WRITER also waits for that file before touching the database.
    // During the probe window the pauser is therefore the only possible lock holder, so `held:true`
    // means "the pauser held the lock" — not merely "somebody did" (measured before this: the same
    // forgery was green 9/10 runs because the writer had taken the lock).
    assert.ok(parentProbe, '★ 父进程必须真的做过一次独立探测');
    assert.equal(parentProbe.held, true,
      '★★★ 他证：探测窗口内只有暂停者可能持锁，而父进程探到锁被占 ⇒ 是暂停者持锁'
      + `（实际 ${JSON.stringify(parentProbe)}）`);
    // The probe result is also on DISK, and read back here, so it is evidence rather than a write-only
    // artifact (t42 LOW-1).
    const inlockProbeFile = readMarker(t, 'parent.probe.inlock', 'parent');
    assert.equal(inlockProbeFile.held, true, '★ 探测结果必须落盘且与内存读数一致');

    // ★ THE ORDERING EVIDENCE: inside the lock, the pause was already committed.
    assert.deepEqual(w.lockObservations, [true],
      '★★★ 写入者持锁时读到的 writePaused 必须是 true ⇒ 暂停的提交在它之前');

    // ★ The refusal's LOCATION, expressed semantically instead of relying on a missing field
    // (requirement 7): the refusal came from INSIDE the reservation kernel — `reserveOfflinePost`'s
    // `authorizeTool(state,'publish')` returning `write_paused` — not from one of the facade's own
    // pre-reservation refusals and not from stage 1b. See `refusalIsReserveKernel`.
    assert.equal(refusalIsReserveKernel(w.first, {
      reservations: w.reservations, used: w.usedPost, transportCalls: w.transportCalls,
    }), true, '★ 必须是「预留内核拒绝」而不是「预留前拒绝」或 stage 1b 拒绝');
  } finally { if (t !== null) assertCleanup(t); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// A2 · the refusal predicate accepts BOTH legal quota-flag shapes, and rejects the look-alikes
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// Requirement 7 says the intent of A's last assertion must be "reserve-kernel refusal", not "the
// `quotaConsumed` field happens to be missing". Those two are only equivalent while the production code
// stays internally inconsistent (`refused()` sets the flag, the kernel refusal does not), so the intent
// is pinned here directly: `refusalIsReserveKernel` must say YES to a kernel refusal whether or not it
// carries `quotaConsumed: false`, and NO to the other two refusal shapes that a passing A could
// otherwise be confused with.
test('I1-A2 拒绝形态判定：预留内核拒绝接受两种 quotaConsumed 形态，拒绝前拒绝与 stage 1b 拒绝都判否', () => {
  const clean = { reservations: [], used: 0, transportCalls: 0 };

  // Kernel refusal (what A observes today): no `quotaConsumed` field at all.
  assert.equal(refusalIsReserveKernel(
    { ok: false, stage: 'reserve', reason: 'write_paused' }, clean), true,
  '内核拒绝（不带 quotaConsumed）必须判「是预留内核拒绝」');

  // Kernel refusal that ALSO reports the flag — the shape somebody would get after unifying the two
  // refusal builders. Same scenario, same meaning, so it must still pass.
  assert.equal(refusalIsReserveKernel(
    { ok: false, stage: 'reserve', reason: 'write_paused', quotaConsumed: false }, clean), true,
  '★★ 内核拒绝（显式 quotaConsumed:false）也必须判是 —— 否则断言就依赖了「字段缺失」这一巧合');

  // An EARLY refusal (before the reservation) looks identical in its first three fields; what separates
  // it is the durable state, which this predicate is given explicitly.
  assert.equal(refusalIsReserveKernel(
    { ok: false, stage: 'reserve', reason: 'write_paused' }, { reservations: [], used: 0, transportCalls: 1 }),
  false, '★ 若 transport 被调用过，就不是「什么都没发」的内核拒绝');

  // The stage-1b refusal — the OTHER legal shape, which A must never be confused with.
  assert.equal(refusalIsReserveKernel(
    { ok: false, stage: 'transport', outcome: 'not-sent', reason: 'paused-before-send', quotaConsumed: true },
    { reservations: ['x'], used: 1, transportCalls: 0 }), false,
  '★★ stage 1b 的拒绝形态必须判否（它要求先成功预留）');

  // And a kernel refusal that somehow claims a cost is not the shape A observed.
  assert.equal(refusalIsReserveKernel(
    { ok: false, stage: 'reserve', reason: 'write_paused', quotaConsumed: true }, clean), false,
  '★ 内核拒绝不得声称扣额');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// B · reserve + stage 1b commit first ⇒ both transactions read `false` ⇒ this call completes
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('I1-B 授予先提交：两次事务锁内都读到 false，该调用完成；暂停落盘后新调用被拒', async () => {
  // t42 MEDIUM: same restructure as I1-A — the fixture and the children live inside the try so a spawn
  // failure cannot leak the directory. `race()` returns `{t, dir}`; the handle is `pair.t`.
  let pair = null;
  let t = null;
  try {
    pair = race('b', 'grantWins');
    t = pair.t;   // before runPair: that call is what can throw (spawn ENOENT)
    const { writer, pauser, parentProbe } = await runPair(pair, 'grantWins');
    const p = assertChildHealthy(pauser, 'pauser');
    const w = assertChildHealthy(writer, 'writer');

    // ★ Same concurrency verdict as A, from the same parent-side predicate and the same raw inputs.
    assertParentConcurrent(writer, pauser, 'I1-B');
    assert.equal(p.writePaused, true, '暂停最终确实落盘（在授予之后）');

    // ★ The writer's stage-1b marker. The FILE's `lockHeld` is written by the writer itself, so it
    // catches a marker emitted AFTER COMMIT (the probe then answers false) but NOT a marker emitted
    // BEFORE `BEGIN` with `lockHeld` hardcoded — measured (5th review, M5): that variant stayed green
    // 6/6. The assertions are kept because the post-commit shape is the one that actually occurred, not
    // because they prove the write happened inside the transaction.
    //
    // ★★ `w.probeCalibration` is asserted in I1-A; B runs the same child, so it is not re-asserted
    // here (one calibration per child per scenario is enough, and A is the scenario that depends on it
    // most directly).
    const stage1bMarker = readMarker(t, 'writer.stage1b', 'writer');
    assert.equal(stage1bMarker.lockHeld, true, '★★ writer.stage1b 记录「写入时持锁」（子进程自报，见上方限制）');
    assert.equal(w.markerProof.stage1bHeldLock, true,
      '★★ 写入者自报：写标记前探测到锁被占（自报，见 parentProbe 的他证）');
    assert.equal(w.markerProof.stage1bHeldLockAfterMark, true,
      '★★ 写入者自报：写标记后探测到锁仍被占（自报，见 parentProbe 的他证）');

    // ★★ 他证 (t41-R2, strengthened t42) — THE ATTRIBUTABLE PART. Everything asserted above is reported
    // by the child itself. Now BOTH sides coordinate on `parent.probed.stage1b`: the writer keeps its
    // stage-1b transaction open, and the PAUSER also waits for that file before taking the write lock.
    // During the probe window the writer is therefore the only possible lock holder, so `held:true` is
    // attributable to the WRITER rather than to "somebody".
    //
    // ⚠️ WHAT THIS DOES **NOT** PROVE (t43 wording; R5 scope widened in t44): it proves the writer held
    // the write lock while the probe window was open. It does NOT prove the `writePaused` READ happened
    // inside that lock, and it does NOT prove the DECISION used lock-held state — see R5 in the header:
    // keeping both transactions and only feeding `authorizeTool`/`gateRefusal` a pre-transaction
    // snapshot still passes 9/9.
    assert.ok(parentProbe, '★ 父进程必须真的做过一次独立探测');
    assert.equal(parentProbe.held, true,
      '★★★ 他证：探测窗口内只有写入者可能持锁，而父进程探到锁被占 ⇒ 是写入者持锁'
      + `（实际 ${JSON.stringify(parentProbe)}）`);
    const stage1bProbeFile = readMarker(t, 'parent.probe.stage1b', 'parent');
    assert.equal(stage1bProbeFile.held, true, '★ 探测结果必须落盘且与内存读数一致');

    // ★ Three lock observations, not two: the first call takes the write lock twice (reserve, then
    // stage 1b) and BOTH read `false` ⇒ both committed before the pause. The third belongs to the
    // follow-up call, whose single reserve transaction reads `true` ⇒ the pause was already durable by
    // then. `[false, false, true]` is therefore the full ordering trace of this scenario.
    assert.deepEqual(w.lockObservations, [false, false, true],
      '★★★ 前两次（预留+stage 1b）读 false ⇒ 均早于暂停；第三次（暂停后的新调用）读 true');
    assert.equal(w.updateIndex, 3,
      `★★ 恰好三次写事务（预留 + stage 1b + 暂停后的新调用）；实际 ${w.updateIndex}`);

    assert.equal(w.first.ok, true, '★ 授予先 ⇒ 该具体调用可以完成（用户已定的在途规则）');
    assert.equal(w.first.stage, 'transport');
    assert.equal(w.first.outcome, 'success');
    assert.equal(w.first.transportCalled, true);
    assert.equal(w.transportCalls, 1, '★★ transport 恰好一次');
    assert.deepEqual(w.reservations, ['i1-w'], '★★ 预留已落盘');

    // The pause took effect for everything AFTER it: the new call is refused, and nothing new is spent.
    assert.ok(w.followUp, '必须有一个暂停后的新调用');
    assert.equal(w.followUp.ok, false, '★ 暂停落盘后的新调用必须被拒');
    assert.equal(w.followUp.stage, 'reserve');
    assert.equal(w.followUp.reason, 'write_paused');
    assert.equal(w.transportCalls, 1, '★★ 新调用没有发送');
    assert.deepEqual(w.reservations, ['i1-w'], '★★ 新调用没有新增预留');
    assert.equal(w.usedPost, 1, '★★ 只扣了授予先那一次');
  } finally { if (t !== null) assertCleanup(t); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// C · the pause lands BETWEEN the reserve and stage 1b ⇒ refused at stage 1b, cost reported
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// Interleaving note (stated instead of glossed): A and B above use two independent OS processes. C
// needs the pause to land in a window a few microseconds wide, so here the pause is committed through
// a SECOND REAL CONNECTION on the same file, injected immediately after the reservation transaction
// returns. That is still a genuine crossing of the serialization boundary (a different connection
// with its own BEGIN IMMEDIATE, not a state pre-arranged inside one handle), and unlike a race it is
// deterministic, which is what a regression test needs.
test('I1-C 暂停插在预留与 stage 1b 之间：锁内先 false 后 true，拒绝落在 stage 1b（not-sent）', async () => {
  // t42 MEDIUM: created inside the try so any throw above the assertions still reaches assertCleanup.
  let t = null;
  try {
    t = tempDir('c');
    const real = openOfflineStore(t.dbPath, baseState());
    const pauser = openOfflineStore(t.dbPath, baseState());   // second REAL connection, same file
    try {
      const lockObservations = [];
      let updateIndex = 0;
      const calls = [];
      const store = {
        ...real,
        update(fn) {
          updateIndex += 1;
          const index = updateIndex;
          const out = real.update((state) => {
            lockObservations.push(state.writePaused === true);
            return fn(state);
          });
          // Between the reservation and stage 1b: commit the pause from the OTHER connection.
          if (index === 1) pauser.update((state) => ({ ...state, writePaused: true }));
          return out;
        },
      };
      const writePath = createOfflineWritePath({
        store, clock: () => NOW,
        transport: async () => { calls.push(1); return { ok: true }; },
      });

      const out = await writePath.write(request('i1-c'));

      // ★ THE ORDERING EVIDENCE, in its sharpest form: the observed value CHANGES between the two
      // transactions, so the pause committed strictly between them.
      assert.deepEqual(lockObservations, [false, true],
        '★★★ 预留事务读到 false，stage 1b 事务读到 true ⇒ 暂停恰好落在两者之间');

      assert.equal(out.ok, false);
      assert.equal(out.stage, 'transport', '★ 拒绝落在 stage 1b，而不是预留');
      assert.equal(out.outcome, 'not-sent');
      assert.equal(out.reason, 'paused-before-send');
      assert.equal(out.quotaConsumed, true, '★★ 预留已扣额，必须如实上报');
      assert.equal(out.transportCalled, false, '★★ 没有发送');
      assert.equal(out.permitRefusedBy, 'authorize', '★★ 是授权层拒绝（不是 write gate）');
      assert.equal(calls.length, 0, '★★ transport 零调用');

      const after = real.read();
      assert.deepEqual(Object.keys(after.ledger.reservations), ['i1-c'], '★★ 预留已落盘（这就是代价）');
      assert.equal(after.ledger.used.post, 1, '★★ 额度已扣');
      assert.equal(after.writePaused, true);
    } finally { try { pauser.close(); } catch {} try { real.close(); } catch {} }
  } finally { if (t !== null) assertCleanup(t); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// I1-C2P · C measured across TWO REAL OS PROCESSES: the peer's COMMIT is what stage 1b observes
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// WHAT WAS MISSING. I1-C above produces the C interleaving with a SECOND CONNECTION IN THE SAME
// PROCESS; the two-process evidence covered only A and B. So "the pause that stage 1b sees was
// committed by another OS process" was an inference, not a measurement. This test measures it.
//
// HOW THE WINDOW IS FORCED OPEN — no sleeps, no retries, no probability. The writer's second wrapper
// call is stage 1b. Before it opens ANY transaction of its own it:
//   1. probes the write lock (must be free: the reservation committed, nobody else is writing),
//   2. writes `writer.stage1bPending` — "the reserve is committed and stage 1b has NOT begun",
//   3. waits for `pauser.committed` — the OTHER PROCESS's `real.update` RETURN, i.e. its COMMIT,
//   4. probes again, writes `writer.preStage1b`, waits for the parent's probe of that window,
//   5. only then opens `BEGIN IMMEDIATE`.
// The pauser waits for step 2, commits `writePaused: true` in its own process, and only then writes
// the marker. Because the writer is parked OUTSIDE a transaction, nothing it holds can block that
// COMMIT; and because the marker is written after `real.update` returns, waiting for it means
// waiting for durability — not for a file that might precede the commit.
//
// WHY THAT IS AN ORDERING PROOF AND NOT A TIMING STORY. The writer's stage-1b transaction reads
// `writePaused === true` from INSIDE its write lock, and it could only open that transaction after
// `pauser.committed` existed, which only happens after the pauser's COMMIT. So the pause's COMMIT
// preceded stage 1b's BEGIN — by protocol causality, with no clock comparison anywhere.
//
// WHAT THE PARENT ADDS HERE (the shared `assertParentConcurrent` call, identical to I1-A/I1-B):
//   · both pids are recorded by the PARENT from `spawn`, asserted positive and DIFFERENT;
//   · the parent's own start/close windows are asserted to intersect. That window is an OBSERVATION
//     BOUNDARY, not a precise kernel lifetime (see the predicate's docblock), and the children's
//     `readyAt`/`aliveUntil` are not an input to it (nor to anything else);
//   · the parent's own lock readings are taken in BOTH handoff windows and asserted FREE, and the
//     protocol stages are ordered by the PARENT's probe timestamps.
// This does not prove a distribution of simultaneous arrivals: this is ONE forced interleaving of C.
test('I1-C2P 双进程 C：预留提交后交锁，另一进程真实 COMMIT，stage 1b 锁内读到 true 并被拒', async () => {
  let pair = null;
  let t = null;
  try {
    pair = race('c2p', 'pauseBetween');
    t = pair.t;   // before runPair: that call is what can throw (spawn ENOENT)
    const { writer, pauser, parentProbe } = await runPair(pair, 'pauseBetween');
    const p = assertChildHealthy(pauser, 'pauser');
    const w = assertChildHealthy(writer, 'writer');

    // ★★ OS-LEVEL IDENTITY, VIA THE SHARED PREDICATE. `child.pid` comes from the spawn call and the
    // window is the parent's own `Date.now()` around spawn and `close`, so "two independent OS
    // processes were in flight together" is the parent's observation rather than something a child
    // printed. This is the SAME `assertParentConcurrent` that I1-A, I1-B and I1-CC3 call — see its
    // docblock for exactly what the window is and is not. `w`/`p` below are the parsed stdout; they are
    // NOT an input to this call.
    assertParentConcurrent(writer, pauser, 'I1-C2P');

    // ★★★ THE HANDOFF WINDOWS, READ BY THE PARENT. Both must be FREE:
    //   · `pending`    — reserve committed, stage 1b not begun (writer parked, pauser gated);
    //   · `preStage1b` — peer's COMMIT landed, stage 1b still not begun.
    // A lock that answered `true` here would mean a marker had drifted INSIDE a transaction — the
    // shape that deadlocks — and this reading is attributable because the competitor is gated on
    // `parent.probed.pending` / `parent.probed.preStage1b` respectively (see both child fixtures).
    assert.ok(parentProbe && parentProbe.pending && parentProbe.preStage1b,
      '★ 父进程必须真的做过两次独立探测（pending / preStage1b）');
    assert.equal(parentProbe.pending.held, false,
      `★★★ 他证：预留已提交、stage 1b 未开始时，写锁必须空闲（实际 ${JSON.stringify(parentProbe.pending)}）`);
    assert.equal(parentProbe.preStage1b.held, false,
      `★★★ 他证：对端已提交、stage 1b 未开始时，写锁必须空闲（实际 ${JSON.stringify(parentProbe.preStage1b)}）`);
    assert.equal(parentProbe.pending.at <= parentProbe.preStage1b.at, true,
      '★ 父进程观测到的协议先后：pending 探测必须早于 preStage1b 探测');
    // The parent's preStage1b probe precedes the writer's close event.
    assert.equal(parentProbe.preStage1b.at < writer.exitedAt, true, '★ 两次探测都必须发生在写入者退出之前');

    // The same two readings are on DISK, so they are evidence rather than a write-only artifact.
    assert.equal(readMarker(t, 'parent.probe.pending', 'parent').held, false,
      '★ pending 探测结果必须落盘且为 false');
    assert.equal(readMarker(t, 'parent.probe.preStage1b', 'parent').held, false,
      '★ preStage1b 探测结果必须落盘且为 false');

    // The markers the two children exchanged, read back from disk by the parent.
    const pendingMarker = readMarker(t, 'writer.stage1bPending', 'writer');
    assert.equal(pendingMarker.lockHeld, false,
      '★★ 写入者交锁时自报「锁不在自己手里」（自报；deniable 的他证是上面的 parentProbe）');
    assert.equal(Number.isFinite(pendingMarker.at), true, '标记必须带写入时刻');
    assert.equal(Number.isFinite(readMarker(t, 'writer.preStage1b', 'writer').at), true,
      'preStage1b 标记必须带写入时刻');
    // The writer's own two probes around the handoff must both answer "not held".
    assert.equal(w.handoff.pendingLockHeld, false,
      '★★ 写入者自报：交锁前探测到锁空闲（自报，见 parentProbe）');
    assert.equal(w.handoff.preStage1bLockHeld, false,
      '★★ 写入者自报：stage 1b 之前探测到锁空闲（自报，见 parentProbe）');

    // ★★★ THE ORDERING EVIDENCE — the same reading I1-C makes, now across processes. The probe
    // self-check has already ruled out a constant, so `[false, true]` means: the reserve transaction
    // read an un-paused state, and the stage-1b transaction read a paused one ⇒ the pause committed
    // strictly between them. Combined with the parent-observed handoff above, the pause was the OTHER
    // PROCESS's COMMIT.
    assert.deepEqual(w.probeCalibration, { held: true, free: false },
      '★★★ 写入者的锁探测必须自证：持锁时 true、无锁时 false。常量无法同时给出两者');
    assert.deepEqual(p.probeCalibration, { held: true, free: false },
      '★★★ 暂停者的锁探测必须自证（同上）');
    assert.deepEqual(w.lockObservations, [false, true],
      '★★★ 预留事务读到 false、stage 1b 事务读到 true ⇒ 暂停恰好落在两次事务之间');

    // ★★ EXACTLY TWO BUSINESS TRANSACTIONS. The store's own initialisation transaction and the
    // `calibrateProbe` transactions run on separate handles / a private file, so they are not counted:
    // `updateIndex` counts WRAPPER calls only. Asserting 2 (not ≥2) is what makes "the pause landed
    // between exactly these two" a statement about the real chain.
    assert.equal(w.updateIndex, 2,
      `★★ 恰好两次业务写事务（预留 + stage 1b）；实际 ${w.updateIndex}`);

    // ★ THE REFUSAL SHAPE, at the stage-1b boundary.
    assert.equal(w.first.ok, false, '★★ 暂停先提交 ⇒ 本次调用必须被拒');
    assert.equal(w.first.stage, 'transport', '★ 拒绝落在 stage 1b，而不是预留');
    assert.equal(w.first.outcome, 'not-sent', '★ not-sent');
    assert.equal(w.first.reason, 'paused-before-send', '★ 理由是暂停');
    assert.equal(w.first.permitRefusedBy, 'authorize', '★★ 授权层拒绝（不是 write gate）');
    assert.equal(w.first.quotaConsumed, true, '★★ 预留已扣额，必须如实上报');
    assert.equal(w.first.transportCalled, false, '★★ 没有发送');
    assert.equal(w.transportCalls, 0, '★★ transport 零调用');

    // ★ NOT AN EARLY RESERVE REFUSAL MASQUERADING AS C. If the database had been paused BEFORE the
    // call started, the refusal would be `stage:'reserve'` and there would be no reservation. Asserting
    // the opposite side — the reservation IS on disk, with exactly one entry and one spent unit —
    // pins that the pause arrived after the reserve committed.
    assert.notEqual(w.first.stage, 'reserve',
      '★★★ 不能是启动时已暂停导致的 reserve 拒绝 —— 那冒充不了 C');
    assert.deepEqual(w.reservations, ['i1-w'], '★★ 预留已落盘（这就是代价），且只有这一条');
    assert.equal(w.usedPost, 1, '★★ 额度恰好扣一次');

    // ★ THE PAUSE IS REALLY DURABLE, read back by BOTH processes from their own handles.
    assert.equal(p.writePaused, true, '★★ 暂停者自己的读回：writePaused 已落盘');
    assert.equal(w.dbWritePaused, true, '★★ 写入者（另一个进程）的读回：writePaused 已落盘');
  } finally { if (t !== null) assertCleanup(t); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// I1-C2P-M · the SAME two-process C protocol must GRANT a stale-snapshot copy of the module graph
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// WHY THIS PAIR EXISTS. I1-C2P shows the real code REFUSES when another OS process commits the pause
// between the reserve and stage 1b. Refusing is only evidence if the SAME protocol can also GRANT —
// otherwise a harness that refuses everything (or a fixture that never actually reaches transport)
// would look identical. So the identical protocol is re-run against a temp copy of the whole
// `src/core` graph in which `finalAuthorisationCheck` only changes WHERE its decision input comes
// from: a `store.read()` taken BEFORE the transaction. Both real write transactions are kept, the
// in-lock observation is kept, the handoff is kept.
//
// LIMITS. This does not independently prove `gateRefusal` (only `authorizeTool` is mutated here), and
// no second fault matrix is needed: the claim is exactly "the decision must use the state read under
// the write lock". It also does not make C2P a distributed-ordering proof — one forced interleaving.
test('I1-C2P-M 双进程 C 语义反控：同一协议下真代码拒绝、锁外快照副本放行（红必须落在行为上）', async () => {
  // Runs the full two-process C2P protocol against a given module graph and returns the readings.
  //
  // ⚠️ EACH SIDE GETS ITS OWN TEMP DIRECTORY AND ITS OWN CLEAN `state.db` (created by `race`), because
  // the first run ends paused with a spent reservation; reusing the file would produce a reserve-stage
  // refusal for an unrelated reason and the pair would prove nothing.
  const measure = async ({ label, mutate }) => {
    const pair = race(`c2p-m-${label}`, 'pauseBetween', { coreCopy: mutate !== null });
    const t = pair.t;
    try {
      if (mutate !== null) {
        const moduleFile = path.join(pair.core, 'qzone-write-path-offline.mjs');
        // (1) take the decision input BEFORE the transaction opens …
        mutate(moduleFile);
      }
      const { writer, pauser, parentProbe } = await runPair(pair, 'pauseBetween');
      const p = assertChildHealthy(pauser, 'pauser');
      const w = assertChildHealthy(writer, 'writer');
      // A refused run must never be confused with a broken child: a timeout, a signal or a
      // SQLITE_BUSY is a fixture failure (assertChildHealthy has already failed the run for those).
      assert.equal(parentProbe.pending.held, false, `${label}: 交锁窗口必须空闲（装置自检）`);
      assert.equal(parentProbe.preStage1b.held, false, `${label}: stage 1b 前窗口必须空闲（装置自检）`);
      return { label, w, p, parentProbe };
    } finally {
      // Runs on EVERY exit path, including a thrown anchor assertion inside `mutate`.
      assertCleanup(t);
    }
  };

  // ★ THE BEHAVIOUR CONTRACT, written once and applied to BOTH sides. The baseline must satisfy it;
  // the mutant must FAIL it — and the text of that failure is kept below, because "the mutant went
  // red" only means something if the red lands on one of THESE lines.
  const assertRefusedBehaviour = (m) => {
    assert.equal(m.w.first.ok, false, '真代码必须拒绝：暂停已在 stage 1b 之前由另一进程提交');
    assert.equal(m.w.first.stage, 'transport', '真代码：拒绝落在 stage 1b');
    assert.equal(m.w.first.outcome, 'not-sent', '真代码：not-sent');
    assert.equal(m.w.first.transportCalled, false, '真代码：没有发送');
    assert.equal(m.w.first.permitRefusedBy, 'authorize', '真代码：授权层拒绝');
    assert.equal(m.w.transportCalls, 0, '真代码：transport 零调用');
  };

  // ── baseline: the REAL modules, through the SAME two-process protocol ───────────────────────
  const baseline = await measure({ label: 'baseline', mutate: null });
  assert.equal(baseline.w.updateIndex, 2, '★★★ 真代码：恰好两次业务写事务（预留 + stage 1b）');
  assert.deepEqual(baseline.w.lockObservations, [false, true],
    '★★★ 真代码：预留读 false、stage 1b 读 true');
  assertRefusedBehaviour(baseline);
  assert.deepEqual(baseline.w.reservations, ['i1-w'], '★★ 真代码：预留已落盘');
  assert.equal(baseline.w.usedPost, 1, '★★ 真代码：额度已扣');

  // ── mutant: a temp copy whose stage-1b decision reads a pre-transaction snapshot ────────────
  const mutant = await measure({
    label: 'mutant',
    mutate: (moduleFile) => {
      // (1) the snapshot is taken BEFORE the transaction, in `finalAuthorisationCheck`'s own scope.
      patchFile(moduleFile,
        '    let verdict = { paused: false };\n    store.update((state) => {',
        '    const staleSnapshot = store.read();   // MUTANT (t46): decision input read OUTSIDE the lock\n'
        + '    let verdict = { paused: false };\n    store.update((state) => {');
      // (2) the authorizeTool decision judges on that snapshot instead of the in-lock `state`.
      // ONLY this site is mutated: `gateRefusal` is left alone, which is why this pair cannot be
      // read as an independent proof of `gateRefusal`.
      patchFile(moduleFile,
        '      const decision = authorizeTool(state, action);',
        '      const decision = authorizeTool(staleSnapshot, action);   // MUTANT');
    },
  });

  // ★ THE POINT: same protocol, same handoff, same transaction count, same in-lock observations.
  // A mutant that "won" by opening fewer transactions or by skipping the handoff fails right here.
  assert.equal(mutant.w.updateIndex, 2,
    '★★★ 变异体同样两次业务写事务（不得靠删事务取胜）');
  assert.deepEqual(mutant.w.lockObservations, [false, true],
    '★★★ 变异体的锁内观测与真代码相同 ⇒ 差异只能来自「判据读哪份 state」');

  // ★★ THE REQUIRED RED: apply the baseline's own behaviour contract to the mutant.
  let mutantFailure = null;
  try { assertRefusedBehaviour(mutant); } catch (error) {
    mutantFailure = error instanceof Error ? error.message : String(error);
  }
  assert.notEqual(mutantFailure, null,
    '★★★ 把真代码的行为断言套到变异体上必须变红（否则装置根本区分不了两者）');
  // The red must be SEMANTIC. A failure naming a patch anchor, a parse/import error, a missing file or
  // a timeout means the fixture collapsed, not that the semantics were detected. A duplicate
  // reservation is also excluded: it would mean the two sides hit ONE database, i.e. the fixture
  // reused state instead of building a clean one.
  assert.equal(/反控补丁的锚点|SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND|timed out|ENOENT|duplicate/.test(mutantFailure), false,
    `★★★ 变异体的红必须落在行为断言上，不能落在装置故障上：${mutantFailure}`);
  assert.match(mutantFailure, /必须拒绝|not-sent|transport 零调用|授权层拒绝|拒绝落在 stage 1b/,
    `★★★ 变异体的红必须点名某条行为断言（实际：${mutantFailure}）`);

  // And the divergence, stated positively: same protocol, opposite outcome.
  assert.equal(mutant.w.first.ok, true,
    '★★★ 变异体放行（判据用了锁外旧快照）—— 真代码拒绝，这一对差异就是 (b) 被钉住的证据');
  assert.equal(mutant.w.transportCalls, 1, '★★★ 变异体 transport 恰好被调用 1 次（真代码是 0）');
  assert.equal(mutant.w.first.transportCalled, true, '★★★ 变异体确实走到了发送');
  assert.equal(mutant.w.usedPost, 1, '★ 变异体也只扣一次额（没有重复预留）');
  assert.equal(mutant.p.writePaused, true, '★ 变异体一侧的暂停同样真实落盘');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// I1-CC4 · R5(b): the SAME injection shape must REFUSE the real code and GRANT a stale-snapshot copy
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// WHAT (b) IS. `gateRefusal` and `authorizeTool` must judge on the state that was committed under the
// write lock. A copy that instead judges on a `store.read()` taken BEFORE the transaction would happily
// grant a write whose pause is already durable — and until this test existed, the suite could not tell
// those two apart (measured: such a copy passed 9/9).
//
// HOW IT IS PINNED WITHOUT TOUCHING THE STORE CONTRACT. No hook, no seam, no `BEGIN`-to-callback
// injection point: the pause is committed by a SECOND REAL CONNECTION on the same temporary SQLite file,
// from inside the wrapper's `update`, immediately BEFORE the second `real.update(fn)` call. That is the
// same interleaving I1-C produces, so both sides run the IDENTICAL shape:
//
//     baseline  real module   → stage 1b sees writePaused:true  → refused, transport 0
//     mutant    stale copy    → stage 1b judges on the stale pre-transaction snapshot → granted,
//                               transport 1
//
// The pair is only meaningful because BOTH sides open the SAME two write transactions and observe the
// SAME `[false, true]`; if the mutant won by deleting a transaction, the transaction-count assertion
// below catches it. The mutant's RED must land on a BEHAVIOUR assertion (transport/outcome), never on a
// patch anchor — see the anchor note in `patchFile`.
//
// LIMITS, stated here as well as in the header: this is ONE PROCESS with TWO REAL CONNECTIONS, not a
// two-process proof; and it does not close (a) for C, where the pause is injected after `real.update`.
test('I1-CC4 语义反控：锁外快照判据必须在同一注入形状下放行，而真代码必须拒绝', async () => {
  // Runs one call against a given module graph and returns everything the assertions need.
  //
  // ⚠️ EACH SIDE GETS ITS OWN DATABASE FILE (`<t.dir>/<label>/state.db`). The two runs must start from
  // an identical un-paused state: the first run ends with `writePaused:true` and a spent reservation, so
  // reusing its file would refuse the second run at the RESERVE for an unrelated reason and the pair
  // would prove nothing.
  const measure = async ({ label, core }) => {
    // `core` is null for the baseline (the real modules) and the copied directory for the mutant. The
    // store AND the write path always come from the SAME graph: authority is minted per module instance,
    // so mixing a repo store with a copy's write path is (correctly) refused by requireAuthority.
    const openStore = core === null ? openOfflineStore : (await import(modUrl(core, 'qzone-store-offline.mjs'))).openOfflineStore;
    const createWritePath = core === null
      ? createOfflineWritePath
      : (await import(modUrl(core, 'qzone-write-path-offline.mjs'))).createOfflineWritePath;

    const dbPath = path.join(t.dir, label, 'state.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const real = openStore(dbPath, baseState());
    const pauser = openStore(dbPath, baseState());       // second REAL connection on the same file
    try {
      const lockObservations = [];
      let updateIndex = 0;
      const calls = [];
      const store = {
        ...real,                                          // spread keeps the send authority
        update(fn) {
          updateIndex += 1;
          const index = updateIndex;
          // ★ THE INJECTION POINT: commit the pause just before the SECOND transaction begins. The
          // second transaction is stage 1b, so it opens AFTER the pause is durable — exactly the
          // interleaving I1-C uses, but reached through the wrapper instead of after `real.update`.
          if (index === 2) pauser.update((state) => ({ ...state, writePaused: true }));
          return real.update((state) => {
            lockObservations.push(state.writePaused === true);
            return fn(state);
          });
        },
      };
      const writePath = createWritePath({
        store, clock: () => NOW,
        transport: async () => { calls.push(1); return { ok: true }; },
      });

      const out = await writePath.write(request(`i1-cc4-${label}`));
      const after = real.read();
      return {
        label,
        updateIndex,
        lockObservations,
        transportCalls: calls.length,
        out,
        reservations: Object.keys(after.ledger.reservations).sort(),
        usedPost: after.ledger.used.post,
        writePaused: after.writePaused,
      };
    } finally { try { pauser.close(); } catch {} try { real.close(); } catch {} }
  };

  let t = null;
  try {
    t = tempDir('cc4');

    // ★ THE BEHAVIOUR CONTRACT, written once and applied to BOTH sides. Baseline must satisfy it; the
    // mutant must FAIL it — and the text of that failure is captured below, because "the mutant went red"
    // is only meaningful if the red lands on one of THESE lines (not on a patch anchor, a parse error or a
    // timeout, all of which would mean the fixture broke rather than the semantics being detected).
    const assertRefusedBehaviour = (m) => {
      assert.equal(m.out.ok, false, '真代码必须拒绝：暂停已在 stage 1b 之前持久化');
      assert.equal(m.out.stage, 'transport', '真代码：拒绝落在 stage 1b');
      assert.equal(m.out.outcome, 'not-sent', '真代码：not-sent');
      assert.equal(m.out.transportCalled, false, '真代码：没有发送');
      assert.equal(m.out.permitRefusedBy, 'authorize', '真代码：授权层拒绝');
      assert.equal(m.transportCalls, 0, '真代码：transport 零调用');
    };

    // ── baseline: the REAL modules ──────────────────────────────────────────────────────────────
    const baseline = await measure({ label: 'baseline', core: null });

    // Same two transactions, and the in-lock observation changes between them.
    assert.equal(baseline.updateIndex, 2, '★★★ 真代码：恰好两次真实写事务（预留 + stage 1b）');
    assert.deepEqual(baseline.lockObservations, [false, true],
      '★★★ 真代码：预留读 false、stage 1b 读 true ⇒ 暂停恰好落在两次事务之间');
    // Baseline satisfies the behaviour contract in full.
    assertRefusedBehaviour(baseline);
    assert.deepEqual(baseline.reservations, ['i1-cc4-baseline'], '★★ 预留已落盘（这就是代价）');
    assert.equal(baseline.usedPost, 1, '★★ 额度已扣');

    // ── mutant: a COPY whose two decision sites read a pre-transaction snapshot ─────────────────
    const core = copyCore(t);
    const mutantModule = path.join(core, 'qzone-write-path-offline.mjs');
    // (1) take the snapshot BEFORE the transaction opens
    patchFile(mutantModule,
      '    let verdict = { paused: false };\n    store.update((state) => {',
      '    const staleSnapshot = store.read();   // MUTANT (t45): decision input read OUTSIDE the lock\n'
      + '    let verdict = { paused: false };\n    store.update((state) => {');
    // (2)+(3) both decision sites judge on that snapshot instead of `state`
    patchFile(mutantModule,
      '      const refusal = gateRefusal(store, state, action, bindings.now);',
      '      const refusal = gateRefusal(store, staleSnapshot, action, bindings.now);   // MUTANT');
    patchFile(mutantModule,
      '      const decision = authorizeTool(state, action);',
      '      const decision = authorizeTool(staleSnapshot, action);   // MUTANT');

    const mutant = await measure({ label: 'mutant', core });

    // ★ THE POINT: same transaction count, same in-lock observations — the ONLY difference is WHICH state
    // the decision used. A mutant that won by opening fewer transactions would fail right here.
    assert.equal(mutant.updateIndex, 2,
      '★★★ 变异体同样两次真实写事务（不得靠删事务取胜）');
    assert.deepEqual(mutant.lockObservations, [false, true],
      '★★★ 变异体的锁内观测与真代码相同 ⇒ 差异只能来自「判据读哪份 state」');

    // ★★ NOW APPLY THE BASELINE'S OWN BEHAVIOUR CONTRACT TO THE MUTANT. It must break — this is the
    // required "the behaviour assertions really go red" step, and the failure text is kept so the test can
    // prove WHERE it broke.
    let mutantFailure = null;
    try { assertRefusedBehaviour(mutant); } catch (error) {
      mutantFailure = error instanceof Error ? error.message : String(error);
    }
    assert.notEqual(mutantFailure, null,
      '★★★ 把真代码的行为断言套到变异体上必须变红（否则装置根本区分不了两者）');
    // The red must be a SEMANTIC one. A failure naming a patch anchor, a parse/import error or a timeout
    // means the fixture collapsed, not that the semantics were detected — the exact trap `patchFile` and
    // the anchor note warn about.
    assert.equal(/反控补丁的锚点|SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND|timed out|ENOENT/.test(mutantFailure), false,
      `★★★ 变异体的红必须落在行为断言上，不能落在装置故障上：${mutantFailure}`);
    assert.match(mutantFailure, /必须拒绝|not-sent|transport 零调用|授权层拒绝|拒绝落在 stage 1b/,
      `★★★ 变异体的红必须点名某条行为断言（实际：${mutantFailure}）`);

    // And the divergence, stated positively as well: the same shape, the opposite outcome.
    assert.equal(mutant.out.ok, true,
      '★★★ 变异体放行（判据用了锁外旧快照）—— 真代码拒绝，这一对差异就是 (b) 被钉住的证据');
    assert.equal(mutant.transportCalls, 1, '★★★ 变异体 transport 被调用 1 次（真代码是 0）');
  } finally { if (t !== null) assertCleanup(t); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// COUNTER-CONTROL 1 (result-level, MUST be red): remove stage 1b ⇒ C stops refusing
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// The counter-control has to run against a MUTATED COPY, because the workspace modules are not ours to
// edit. `src/core` is copied whole so the copy's relative imports resolve inside the copy, and the
// store/paths are opened THROUGH the copy — the authority registry is per module instance, so mixing
// the repo's store with the copy's write path would (correctly) be refused at construction.
const copyCore = (t) => {
  const dest = path.join(t.dir, 'core');
  fs.cpSync(path.join(repoRoot, 'src', 'core'), dest, { recursive: true });
  return dest;
};

const patchFile = (file, from, to) => {
  // Only the disposable mutant copy is normalized: Git may check core modules out as CRLF.
  // A newline mismatch must not masquerade as detection of a semantic regression.
  const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(src.includes(from), true, `反控补丁的锚点必须存在: ${from.slice(0, 60)}`);
  assert.equal(src.split(from).length - 1, 1, '反控锚点必须唯一，否则补丁不可信');
  fs.writeFileSync(file, src.replace(from, to), 'utf8');
};

test('I1-CC0 反控补丁兼容 LF/CRLF 检出，不把换行差异当成语义检出', () => {
  const t = tempDir('patch-eol');
  try {
    for (const eol of ['\n', '\r\n']) {
      const file = path.join(t.dir, eol === '\n' ? 'lf.mjs' : 'crlf.mjs');
      fs.writeFileSync(file, ['const before = 1;', 'const after = 2;', ''].join(eol), 'utf8');
      patchFile(file, 'const before = 1;\nconst after = 2;', 'const before = 3;\nconst after = 2;');
      assert.equal(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'),
        'const before = 3;\nconst after = 2;\n');
    }
  } finally { assertCleanup(t); }
});

test('I1-CC1 反控：删掉 stage 1b 后 C 必须变红（ok:true + transport 发了）', async () => {
  // t42 MEDIUM: same restructure — the fixture lives inside the try, so a throw from copyCore/patchFile
  // still reaches assertCleanup.
  let t = null;
  try {
    t = tempDir('cc1');
    const core = copyCore(t);
    const mutantPath = path.join(core, 'qzone-write-path-offline.mjs');
    // Neutralise the final authorisation check: it can never withhold a grant.
    patchFile(mutantPath,
      '    let verdict = { paused: false };\n    store.update((state) => {\n      // (1) health first',
      '    let verdict = { paused: false };\n    if (true) return verdict;   // MUTANT: stage 1b deleted\n    store.update((state) => {\n      // (1) health first');

    const { openOfflineStore: openCopy } = await import(modUrl(core, 'qzone-store-offline.mjs'));
    const { createOfflineWritePath: createCopy } = await import(modUrl(core, 'qzone-write-path-offline.mjs'));

    const real = openCopy(t.dbPath, baseState());
    const pauser = openCopy(t.dbPath, baseState());
    try {
      let updateIndex = 0;
      const calls = [];
      const store = {
        ...real,
        update(fn) {
          updateIndex += 1;
          const index = updateIndex;
          const out = real.update(fn);
          if (index === 1) pauser.update((state) => ({ ...state, writePaused: true }));
          return out;
        },
      };
      const writePath = createCopy({
        store, clock: () => NOW,
        transport: async () => { calls.push(1); return { ok: true }; },
      });
      const out = await writePath.write(request('i1-cc1'));

      assert.equal(out.ok, true,
        '★★★ 反控必须红：没有 stage 1b，暂停插入后照样发送（这正是 stage 1b 存在的理由）');
      assert.equal(calls.length, 1, '★★ 反控里 transport 被调用了 —— 与 I1-C 的 0 次形成对照');
      assert.equal(updateIndex, 1, '反控只剩预留一次事务（真实代码是 2 次）');
    } finally { try { pauser.close(); } catch {} try { real.close(); } catch {} }
  } finally { if (t !== null) assertCleanup(t); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// COUNTER-CONTROL 2 (transaction-count evidence ONLY — see the warning below)
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// ⚠️ WHAT THIS DOES **NOT** PROVE. An earlier revision of this file called the 2→1 transaction count
// "structural evidence that stage 1b holds the lock". That claim is TOO STRONG and is withdrawn: the
// reviewer constructed a counterexample — a mutant that still opens TWO write transactions but takes
// its verdict from a `store.read()` OUTSIDE them — and every assertion below was satisfied. So the
// transaction count is evidence about HOW MANY transactions run, and nothing more.
//
// WHAT IT DOES PROVE (measured, and the only thing asserted): the real code opens two write
// transactions per publish; this particular mutant opens one. That is worth pinning because it detects
// a removed/swallowed transaction, but it does NOT tell you where the DECISION is made.
//
// THE ACTUAL LOCK-LOCATION PROOF lives in I1-A / I1-B: `markerProof.inlockHeldLock` /
// `markerProof.stage1bHeldLock` are produced by probing the write lock from a second connection
// immediately around each marker, so they are true only if the marker really was written while the
// transaction was open — AND only after that probe has proved it can answer `false` too
// (`probeCalibration`, asserted in I1-A). And I1-CC1 is the result-level counter-control.
//
// The C scenario itself stays GREEN under this mutation, which is reported rather than hidden: with the
// pause already committed, reading it inside or outside the lock both yield `true`.
test('I1-CC2 反控（仅事务数证据）：把 stage 1b 挪到锁外 ⇒ 每调用少一次写事务（2→1），但 C 结论不变', async () => {
  const measure = async (label) => {
    // ★ t41-R7: the directory is created INSIDE the try and cleaned in the OUTER finally, so a throw
    // from `patchFile`'s anchor assertion (or from `copyCore`) still runs `assertCleanup`. Before this
    // the directory was built above the try and a failing anchor leaked it (measured: 3 leaked dirs).
    let t = null;
    try {
      t = tempDir(`cc2-${label}`);
      const core = copyCore(t);
      if (label === 'mutant') {
        const file = path.join(core, 'qzone-write-path-offline.mjs');
        patchFile(file,
          '    let verdict = { paused: false };\n    store.update((state) => {',
          '    let verdict = { paused: false };\n    ((state) => {');
        patchFile(file,
          '      verdict = { paused: false };\n      return state;\n    });\n    return verdict;',
          '      verdict = { paused: false };\n      return state;\n    })(store.read());   // MUTANT: check moved out of the lock\n    return verdict;');
      }
      // No `?v=` cache-buster: the copy's own modules import each other by bare specifier, so a query
      // string on ONE of them would load the store module TWICE — two authority registries — and
      // `requireAuthority` would then refuse a perfectly real handle (measured). Each `measure()` call
      // gets its own directory, which is what actually separates the module graphs.
      const { openOfflineStore: openCopy } = await import(modUrl(core, 'qzone-store-offline.mjs'));
      const { createOfflineWritePath: createCopy } = await import(modUrl(core, 'qzone-write-path-offline.mjs'));
      const real = openCopy(t.dbPath, baseState());
      const pauser = openCopy(t.dbPath, baseState());
      try {
        let updateIndex = 0;
        const lockObservations = [];
        const calls = [];
        const store = {
          ...real,
          update(fn) {
            updateIndex += 1;
            const index = updateIndex;
            const out = real.update((state) => { lockObservations.push(state.writePaused === true); return fn(state); });
            if (index === 1) pauser.update((state) => ({ ...state, writePaused: true }));
            return out;
          },
        };
        const writePath = createCopy({
          store, clock: () => NOW,
          transport: async () => { calls.push(1); return { ok: true }; },
        });
        const out = await writePath.write(request(`i1-cc2-${label}`));
        return { updateIndex, lockObservations, calls: calls.length, out };
      } finally { try { pauser.close(); } catch {} try { real.close(); } catch {} }
    } finally {
      // Runs on EVERY exit path, including a thrown anchor assertion. There is deliberately NO
      // `cleaned` flag (t42 LOW-3): it would only ever be assigned `true` here, so `!cleaned` was a
      // constant and the guard was decoration. A double cleanup cannot happen — this `finally` and the
      // inner one close DIFFERENT resources, and `t` is used exactly once.
      if (t !== null) assertCleanup(t);
    }
  };

  const realCode = await measure('real');
  const mutant = await measure('mutant');

  // TRANSACTION-COUNT EVIDENCE ONLY (never "the decision is inside the lock" — see the warning above).
  assert.equal(realCode.updateIndex, 2, '★ 真实代码每次调用两次写事务（预留 + stage 1b）');
  assert.deepEqual(realCode.lockObservations, [false, true], '★ 锁内观测随暂停提交而变');
  assert.equal(realCode.out.permitRefusedBy, 'authorize');
  assert.equal(realCode.calls, 0);

  // The mutant opens ONE transaction instead of two. That is all this asserts: a transaction went away.
  // It does NOT follow that the mutant's decision is outside a lock — a two-transaction mutant with an
  // outside read satisfies every line here too (reviewer's counterexample, which is why this file no
  // longer claims structural proof; see I1-A/I1-B markerProof for the lock-location evidence).
  assert.equal(mutant.updateIndex, 1,
    '★★ 反控：检查挪出锁外后，每次调用只剩一次写事务（事务数证据，不是「判据在锁内」的证明）');
  assert.deepEqual(mutant.lockObservations, [false], '★ 变异的锁内观测只有预留那一次');

  // ★ AND THE HONEST PART: with the pause already committed, reading it outside the lock still sees
  // `true`, so C's verdict does not change. Reported, not hidden.
  assert.equal(mutant.out.ok, false);
  assert.equal(mutant.out.stage, 'transport');
  assert.equal(mutant.out.permitRefusedBy, 'authorize');
  assert.equal(mutant.calls, 0);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// COUNTER-CONTROL 3: the concurrency assertion is EXECUTED against a sequential run
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// Requirement 2 was satisfied by ADDING the interval-intersection assertion, but a capability is not
// evidence: `ordering: 'sequential'` had no call site, so nothing proved that a sequential harness
// actually fails. This test closes that loop by RUNNING the two programs one after the other and
// asserting the SAME parent-side predicate A/B/C2P use rejects the run — the red must be "the
// concurrency evidence does not hold", not a child failure, a timeout or a patch anchor.
//
// HANDSHAKE (the pitfall the card warns about): in a sequential run the first child would wait for a
// peer the parent has not started yet, and die on its own CHILD_TIMEOUT_MS. So `runPair` passes
// `handshake: 'none'` to both children, which skips ONLY the three `waitFor` calls. The in-lock
// markers, the lock probes and the transaction shape stay byte-identical — that is what makes this a
// fair counter-control rather than a different program: the sole difference from I1-A is WHEN the two
// processes were alive.
//
// `grantWins` cannot be used here at all: its pauser waits for the writer's stage-1b marker, which a
// sequential run only writes after the pauser has exited — a guaranteed deadlock. `runPair` therefore
// REJECTS that combination outright instead of letting a future test hang for 8s and misread the
// timeout as an ordering result.
test('I1-CC3 反控：严格先后执行 ⇒ 父侧并发判据判否并抛错（红因是并发证据不成立）', async () => {
  // t42 MEDIUM: fixture inside the try so a spawn failure cannot leak the directory.
  let pair = null;
  let t = null;
  try {
    pair = race('cc3', 'pauseWins');
    t = pair.t;   // before runPair: that call is what can throw (spawn ENOENT)
    const { writer, pauser } = await runPair(pair, 'pauseWins', 'sequential');
    const p = assertChildHealthy(pauser, 'pauser');
    // `w` is parsed for its HEALTH contract only (a timeout / signal / non-zero exit / SQLITE_BUSY must
    // fail the run), never as concurrency input: no field of it reaches the predicate below.
    const w = assertChildHealthy(writer, 'writer');
    // Both children really ran: `assertChildHealthy` has already failed the run for a timeout, a signal,
    // a non-zero exit or SQLITE_BUSY, so nothing below can be satisfied by a program that never started.
    assert.equal(p.writePaused, true, '暂停者确实完成了自己的事务（顺序路径真的执行了）');
    assert.equal(Number.isFinite(w.updateIndex), true, '写入者确实跑完了自己的调用（报告可解析）');

    // ★★ THE PARENT'S RAW LIFECYCLE IS WHAT DESCRIBES "SEQUENTIAL". Both raw results still carry a
    // real pid and an ordered parent window (asserted inside the predicate); what makes this run
    // sequential is that the two parent windows do NOT intersect. No child-reported flag is consulted.
    assert.equal(pauser.exitedAt <= writer.startedAt, true,
      `★ 严格先后：暂停者的父侧退出时刻必须早于写入者的父侧启动时刻（`
      + `pauser.exited=${pauser.exitedAt} writer.started=${writer.startedAt}）`);

    // ★ THE POINT OF THIS TEST: the very predicate I1-A/I1-B/I1-C2P depend on must REJECT this run,
    // and for the concurrency reason specifically.
    assert.throws(() => assertParentConcurrent(writer, pauser, 'I1-CC3'), /并发证据不成立/,
      '★★★ 父侧并发判据必须对这种运行抛错 —— 否则 I1-A 的并发证据就是个恒真断言');
  } finally { if (t !== null) assertCleanup(t); }
});

// ── I1-CC3's own negative control, expressed against the SHARED predicate ──────────────────────
// "assertParentConcurrent throws on the sequential run" is only meaningful if it can also PASS and if
// it throws for the reason claimed. These assertions pin exactly that on synthetic raw results — the
// same `{ pid, startedAt, exitedAt }` shape `runPair` returns — without a second subprocess run:
//   · two different pids with intersecting parent windows PASS (so the predicate is not "always throws");
//   · the same two roles with a gap between the windows THROW on the overlap clause;
//   · identical pids THROW even when the windows overlap (so the pid clause is live too).
test('I1-CC3b 父侧并发判据自证有效：不同 pid 且相交可过，顺序/同 pid 必拒', () => {
  const overlapping = { pid: 4001, startedAt: 1000, exitedAt: 2000 };
  const laterWriter = { pid: 4002, startedAt: 1500, exitedAt: 3000 };
  const disjoint = { pid: 4003, startedAt: 2500, exitedAt: 3500 };
  const samePid = { pid: 4001, startedAt: 1500, exitedAt: 3000 };

  // Not vacuous: a pair that really did overlap passes the same call I1-CC3 expects to throw.
  assert.doesNotThrow(() => assertParentConcurrent(laterWriter, overlapping),
    '★ 不同 pid 且窗口相交必须通过 —— 证明判据不是「恒抛错」');
  // And the sequential shape throws — the red I1-CC3 relies on.
  assert.throws(() => assertParentConcurrent(disjoint, overlapping), /并发证据不成立/,
    '★ 窗口不相交（顺序执行）必须抛错');
  // A shared pid is refused even when the windows intersect: "two roles" must be two processes.
  assert.throws(() => assertParentConcurrent(samePid, overlapping), /不同的 OS 进程/,
    '★ 同一个 pid 必须被判否 —— 否则「两个进程」这一条就没有判据');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// I1-CC3c · the "sequential + grantWins" refusal is EXECUTED, not merely written
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// `runPair` refuses `grantWins` under sequential ordering because that combination deadlocks: the
// pauser waits for the writer's stage-1b marker, which a sequential run only writes after the pauser
// has exited. Writing that guard is not the same as proving it works — the exact defect this task was
// opened for was code with no call site. So the guard is invoked here, and the failure is required to
// be a TypeError rather than a child timeout: a timeout would ALSO mean "no answer", and letting the
// two look alike is how "the harness hung" gets misread as "the ordering was refused".
test('I1-CC3c sequential+grantWins 被显式拒绝（是 TypeError，不是子进程超时）', async () => {
  // t42 MEDIUM / t43: the fixture is built inside the try and `t` is taken immediately, so a throw from
  // `runPair()` is covered. A throw from `race()` ITSELF is not reachable from here (pair would still be
  // null) — `race()` cleans up its own directory before rethrowing.
  let pair = null;
  let t = null;
  try {
    pair = race('cc3c', 'grantWins');
    t = pair.t;
    // `runPair` is async (it awaits the children), so the refusal surfaces as a REJECTION, not a
    // synchronous throw. Asserting `rejects` with the TypeError class keeps the intent: the caller gets
    // a typed refusal immediately, never a pair of children to wait 8s on.
    await assert.rejects(() => runPair(pair, 'grantWins', 'sequential'), TypeError,
      '★★ 必须立刻以 TypeError 拒绝（而不是启动两个子进程然后等 8s 超时）');
    await assert.rejects(() => runPair(pair, 'grantWins', 'sequential'), /only supports 'pauseWins'/,
      '★ 错误信息必须点名受限的模式，方便下一个改这里的人');
  } finally {
    if (t !== null) assertCleanup(t);
  }
});

test('I1-cleanup 启动失败先关闭 peer 与 parent watcher，再保留原错误返回', async () => {
  const t = tempDir('spawn-error');
  const children = [];
  const closed = new Set();
  const timers = new Set();
  const trackedTimeout = (fn, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, delay);
    timers.add(timer);
    return timer;
  };
  const trackedClear = (timer) => { timers.delete(timer); clearTimeout(timer); };
  // Exercise the actual private runner/watcher with real OS children. Only the second spawn's
  // executable is replaced to force ENOENT; no product API or scheduling seam is introduced.
  const failingSpawn = (executable, args, options) => {
    const child = children.length === 0
      ? spawn(executable, ['-e', 'setInterval(() => {}, 1000)'], options)
      : spawn(path.join(t.dir, 'missing-executable'), args, options);
    children.push(child);
    child.once('close', () => closed.add(child));
    return child;
  };
  const isolatedPair = new Function('spawn', 'CHILD_TIMEOUT_MS', 'fs', 'probeHeld',
    'setTimeout', 'clearTimeout', `${watchStage1b.toString()}\n${runPair.toString()}\nreturn runPair;`)(
    failingSpawn, CHILD_TIMEOUT_MS, fs, probeHeld, trackedTimeout, trackedClear);
  try {
    await assert.rejects(() => isolatedPair({ t, dir: repoRoot }, 'pauseBetween'), { code: 'ENOENT' });
    assert.equal(children.length, 2, '两个真实 spawn 都必须被尝试');
    assert.equal(closed.size, 2, '返回启动错误前，已启动的 peer 及失败 child 都必须 close');
    assert.equal(timers.size, 0, '返回前必须停止 parent watcher 与 child watchdog，不等 8 秒超时');
  } finally {
    // Regression itself must also clean up the unfixed runner's orphan, without hiding its red.
    for (const child of children) {
      if (child.pid && !closed.has(child)) child.kill();
    }
    await Promise.all(children.map((child) => closed.has(child)
      ? Promise.resolve() : new Promise((resolve) => child.once('close', resolve))));
    for (const timer of timers) clearTimeout(timer);
    assertCleanup(t);
  }
});
