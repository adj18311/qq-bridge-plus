// Offline WRITE PATH: the complete quota write chain, as ONE atomic reservation followed by ONE
// transport call.
//
// WHY THIS FILE WAS REWRITTEN (t26)
// ---------------------------------
// The first version of this module ran:
//
//     authorizeTool(store.read(), action) -> settlement.settle(...) -> transport
//
// and `settlement.settle` only calls `reserveWrite`. That means it knew about the DAILY CAP and the
// duplicate id, and NOTHING ELSE. Three rules the product actually enforces were unreachable from
// this entry point:
//
//   · the 2-hour publish interval           (`lastPostAt`)
//   · the global 3-minute comment interval  (`lastCommentAt`, shared by comment AND reply)
//   · the same-post like de-duplication     (`wasLiked`)
//
// Consequence, measured: two publishes with different ids, two comments on different targets, or a
// second like on the same post all sailed straight through. Every single-module unit test stayed
// green because none of them went through this entrance. That is the gap this rewrite closes.
//
// THE SHAPE NOW
// -------------
//   stage 0    REFUSE non-write actions
//   stage 0b   the H3 write gate (health of our own state store) — before any reservation
//   stage 0c   STRICT PARAMETER VALIDATION + the IMMUTABLE SNAPSHOT (see below)
//   stage 1    ATOMIC RESERVE   reserveOfflinePost / reserveOfflineInteraction
//                                (a `reply` takes reserveAuditedOfflineInteraction, which checks the
//                                reply's full identity evidence INSIDE the same transaction)
//   stage 1b   FINAL AUTHORISATION — the LINEARIZATION POINT (see below)
//   stage 2    TRANSPORT        exactly once, with the stage 0c snapshot and nothing else
//   stage 3    CLASSIFY         `_classifyWriteTransportResult` from the settlement module
//
// WHY stage 1 IS NOT `settlement.settle`
// --------------------------------------
// `reserveOfflinePost` / `reserveOfflineInteraction` already exist, are reviewed, and each performs
// the WHOLE reserve half inside ONE `store.update`. Re-running `settle` on top would call
// `reserveWrite` a SECOND time for the same id, which deducts the quota twice and (worse) records a
// reservation the first pass did not authorise. So the settlement's reserve half is deliberately NOT
// used here. Only its PURE classifier is reused — that function performs no I/O and holds no state,
// so calling it can never double-charge anything.
//
// NO DOUBLE DEDUCTION, stated precisely
// -------------------------------------
// Exactly one component writes the ledger on the reserve path: the reservation module, inside its own
// transaction. This module never calls `reserveWrite`, never calls `settle`, and never mutates
// `state.ledger` itself. The tests assert `used[kind]` moves by exactly +1 per success, which is the
// observable form of that claim.
//
// PAUSE DURING FLIGHT — the design decision asked for
// ---------------------------------------------------
// Scenario: the reserve succeeded (quota spent, reservation recorded), and BEFORE the transport runs
// `writePaused` flips on. Two candidate behaviours:
//
//   (a) send anyway, because the call was already authorised and paid for;
//   (b) re-check, and DO NOT send if the account is now paused.
//
// This module does (b): a FINAL CHECK immediately before the transport. Reasons:
//
//   · The user's reason for a pause is "stop acting now". A write that had not yet left the process
//     is exactly the write a pause is meant to prevent. Between (a) and (b), (a) can publish during a
//     pause — the one outcome an operator would never accept.
//   · The cost of (b) is a spent quota unit, an occupied id, an advanced interval timestamp and — for
//     `like` — an occupied same-post de-duplication marker. All of them are one-way (see the
//     settlement header: quota never comes back, reservations are never deleted). This is a REAL cost
//     and is reported honestly: `outcome:'not-sent'`, `reason:'paused-before-send'`,
//     `quotaConsumed:true`.
//   · Nothing is sent on this branch, so the pause is respected **for this call**.
//
// ⚠️ SCOPE OF THE GUARANTEE — READ THIS BEFORE QUOTING IT
// ------------------------------------------------------
// The check and the transport are NOT one atomic step, and this module does not claim they are.
//
//     stage 1  reserve        (its own transaction; lock released on return)
//     stage 1b final check    (one `store.update`; lock released on return)
//     ---------------- ← A pause committed HERE is NOT observed by this call ----
//     stage 2  transport      (an independent async call, holds no lock)
//
// A concurrent writer can commit `writePaused` after stage 1b returns and before stage 2 runs; the
// message is still sent. The check NARROWS the window (from "reserve → transport" down to
// "check-return → transport-call"); it does not close it. `store.update` is used instead of `read()`
// because it makes the check read committed state under the write lock, not because it linearises the
// send — using `read()` would only widen the window. See `test-qzone-write-path-pause-race.mjs` for
// the measured readings.
//
// What IS true:
//   · a pause already committed when the check runs  ⇒ this call does not send
//   · a pause committed after the check returns      ⇒ this call may still send
//
// Following the task card ("已经发往平台的不强行中断"), a call that has actually left is not aborted.
//
// So the behaviour is: **the reservation is kept, the message is not sent, and the caller is told
// exactly that.** Refunding would require deleting the reservation, which would reopen the replay
// window (see the settlement header). Note also that refunding quota and releasing a de-duplication
// marker are two INDEPENDENT decisions — but neither may be released without reliable evidence that
// nothing was sent, so this branch (which cannot prove that for the transport it skipped) releases
// neither.
//
// M3 · WHAT THE "GRANT" IS (v6 §2.4, the "no new object" branch)
// ------------------------------------------------------------
// The successful commit of the stage 1b transaction IS the grant. There is no permit record, no
// `state.writePermits`-style collection, and no second collection of any kind: the task's design
// authority chose the "no new object" branch, and a test's wish to observe something is not a
// business reason to add one.
//
// What does the binding work instead?
//   · `reservations[id]` — already durable, already permanent, already the replay guard. It records
//     WHICH id was used, for WHICH kind. It is what refuses a second use of the same call.
//   · the IMMUTABLE SNAPSHOT (stage 0c) — a frozen object built from validated primitives, which is
//     THE object handed to the transport. Nothing is digested and then thrown away: "what was
//     validated" and "what was sent" are literally the same object, so they cannot drift apart.
//
// ⚠️ What this does NOT give you: crash-after-commit proof. After a crash, `reservations[id]` still
// proves "this id was spent once" (so no replay), but nothing persists the fact that a grant was
// ISSUED for a particular parameter set. That is the P-2 branch the design explicitly did NOT take,
// because there is no independent consumer that bypasses this control flow. Do not describe the
// current implementation as if it recorded a grant.
//
// WHAT THIS MODULE IS NOT (unchanged from the first version, and still true)
// --------------------------------------------------------------------------
//   · NOT a production entry point. `src/bridge.js` references it zero times; assembly stays at 0.
//   · NOT a replacement for `write-not-wired`. `qzone-runtime-wiring.mjs:354` refuses write tools
//     BEFORE any reservation because origin (B3) binding is not closed. Splicing this path in front
//     of that gate would burn quota on calls rejected for safety reasons.
//   · NOT a network client: the transport is injected; no HTTP / OneBot / socket code lives here.
//   · **Audit and the double circuit-breaker are NOT wired into this facade.** Nothing here writes an
//     audit row, and nothing here counts consecutive failures or trips `writePaused`. Those exist in
//     their own modules/tests and MUST NOT be described as "already integrated at this entry point".
//     A caller that needs them has to compose them explicitly and prove that separately.

import { authorizeTool, checkWriteGate } from './qzone-policy-offline.mjs';
import {
  DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS,
  reserveAuditedOfflineInteraction,
  reserveOfflinePost,
  reserveOfflineInteraction,
} from './qzone-reservation-offline.mjs';
import { formatAuditRecord } from './qzone-audit-offline.mjs';
import { trustedQQ } from './qzone-reply-evidence-offline.mjs';
import {
  _classifyWriteTransportResult as classifyTransportResult,
  SETTLEMENT_OUTCOME,
} from './qzone-write-settlement-offline.mjs';
import { isValidWriteContent, isValidWriteId } from './qzone-onebot-write-contract.mjs';
import { requireAuthority, resolveAuthority } from './qzone-authority-shared.mjs';
import { pinAuthority, unpinAuthority } from './qzone-store-offline.mjs';

/**
 * Action -> quota bucket.
 *
 * The ledger tracks three buckets (`post` / `comment` / `like`) while the tool surface has four write
 * actions, because `reply` is a comment write: it appends a comment to a post. Mapping it to the
 * `comment` bucket is what makes one shared daily allowance — and the shared 3-minute interval —
 * cover both, instead of letting a caller alternate comment/reply to double their real rate.
 */
export const ACTION_TO_KIND = Object.freeze({
  publish: 'post',
  comment: 'comment',
  reply: 'comment',
  like: 'like',
});

/** The write actions this path accepts. Anything else is refused before any gate runs. */
export const WRITE_ACTIONS = Object.freeze(Object.keys(ACTION_TO_KIND));

// ══════════════════════════════════════════════════════════════════════════════════════════════
// M4 · PROCESS-LOCAL FAULT LATCH
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// WHAT IT IS — AND WHAT IT IS NOT
// ------------------------------
// This is ONE module-level map meaning "in THIS process, stop issuing send permits for THIS database".
// It is NOT `state.writeGate`: that one is PERSISTED in the store and survives a restart; this one
// lives only as long as the module instance (i.e. the process) and is deliberately NOT written
// anywhere.
//
// They are different things on purpose:
//   · `state.writeGate`  answers "was a fault durably recorded?"  — evidence, operator-visible.
//   · `latchedFault`     answers "has a live component of THIS process told us it is broken?" — a
//                        local circuit, gone after restart, and never claimed to be evidence.
//
// L-1  NOT a second authoritative ledger. It takes no part in de-duplication and carries no quota.
//      Nothing reads it to decide whether an id was used; `reservations[id]` remains the only thing
//      that does that. The latch only ever makes the gate STRICTER.
// L-2  Does NOT reopen G3. Nothing here moves the audit out of its transaction or lets the breaker
//      commit on its own. The latch is consulted by a read-only gate; it never writes.
// L-3  PROCESS-LOCAL ONLY, and this is a real limitation, stated rather than glossed: a second
//      independently-run production process shares nothing with this one. Covering that needs a
//      shared entry point (out of scope here). What IS shared is every send authority inside THIS
//      process — that is exactly what a module-level binding gives, and it is tested (LZ-7a..LZ-7e).
// L-4  Never claims to be persisted. It is not written to `state`, not to audit, not to status. In
//      particular: a latched fault means "we are refusing locally", NOT "the fault has been recorded
//      durably". Do not render it as the latter.
// L-5  Restart re-derives health from the STORE, not from this flag: a fresh process starts with an
//      empty latch, and if `state.writeGate`/`state.auditGaps` still say faulted the gate keeps
//      refusing. Conversely an empty latch must never be read as "healthy" — see `gateRefusal`.
//
// WHO SETS IT: the settlement/observability layer (M7) when a commit or settlement fails
// (`qzone-write-observability-offline.mjs`), plus tests. Until M7 calls it, the latch only changes
// when a test sets it directly.
//
// SCOPE: KEYED BY SEND AUTHORITY, NOT BY PROCESS, AND NOT BY HANDLE
// ----------------------------------------------------------------
// A single bare module-level flag would mean one unrelated temporary store's fault poisons every
// other store in the process — an outage spread by a bug in the wrong component. So the latch is
// bucketed by SEND AUTHORITY.
//
// The authority is NOT the store object. Measured defect (F-M4-1): `openOfflineStore` on the same
// absolute file twice produces two handles; with an object-keyed latch, latching through handle A left
// handle B free and a publish went out — `{sameFile:true, latchA:true, latchB:false, ok:true,
// transportCalls:1}`. Two handles on one database are ONE authority, because they are one durable
// state (one quota ledger, one health marker).
//
// The authority is minted by the storage layer (`qzone-store-offline.mjs` → `authorityOf`): one frozen
// TOKEN per canonical file path, shared by every open handle on that path in this process, and dropped
// when the last handle closes. Consequences, each pinned by a test:
//   · same file, two handles          → same token  → one latch   (LZ-7d)
//   · different files                 → tokens differ → separate latches (LZ-7c)
//   · a delegating wrapper `{...store}` → same token → one latch   (LZ-7e)
//   · close the last handle, reopen   → SAME token  → one latch   (LZ-9: handle rotation is NOT a restart)
//   · a real second PROCESS           → new token   → empty latch  (LZ-9b: spawned `node`, not a 2nd handle)
//
// WHY A TOKEN AND NOT A PATH STRING: a path string is caller-owned data. Two spellings of one file
// would split one authority; two unrelated files could be merged by a careless key. The token is
// minted from `realpathSync` of the file that was actually opened and cannot be fabricated by a
// caller (a token-shaped object is rejected unless it is the live token this module knows).
// WHY IT CANNOT BECOME CROSS-RESTART STATE: the registry lives in module memory only; nothing is
// written to SQLite, so a new process starts with no tokens and therefore no latch — L-5 holds.
//
// A store that did NOT come from `qzone-store-offline.mjs` (a hand-built `{read, update}` wrapper, as
// several tests use) has no authority. For those the key falls back to the object itself.
//
// ⚠️ THIS IS AN UNFIXED FAIL-OPEN DEFECT, NOT A MERELY "WEAKER" GUARANTEE. (Measured, t4 review.)
// A CLOSURE wrapper — `{ read: () => real.read(), update: () => ... }`, the shape that holds the real
// handle in a variable instead of spreading it — cannot name its database, so `authorityOf` returns
// null and it becomes its OWN authority. The consequence, measured end to end:
//
//     latchFault(closure, 'x')  ->  readFaultLatch(closure) non-null
//                                   readFaultLatch(real)    NULL
//     write path built on `real` -> { ok:true, outcome:'success', transportCalls:1 }   ← THE WRITE GOES OUT
//
// So a fault latched through a closure wrapper does NOT stop the real handle from sending. That is the
// same failure direction as F-M4-1 (a latched fault that does not stop a send), reached through a
// different shape. It is NOT repaired here because the module genuinely cannot recover a file identity
// from a closure — repairing it needs a construction-time refusal, which is a separate decision.
//
// WHAT IS SAFE: compose by spreading (`{ ...store, update }`) or pass the bare handle. Spread carries
// the token as an own enumerable property, so the wrapper and the handle ARE one authority (LZ-7e).
// WHAT IS DANGEROUS: any wrapper built from a closure over a handle. `OGA-12(B)` pins the failure so
// it cannot be mistaken for "already handled": if someone later makes closure wrappers share, that
// test goes red and whoever did it must explain how they recovered the identity.
const latchedByAuthority = new WeakMap();

/**
 * The latch key for a store: its send authority, or `null` when the handle carries none.
 *
 * Delegated to `qzone-authority-shared.mjs` so this module and the observability adapter cannot
 * resolve an authority differently — that drift is exactly what made CHAIN-6's wrapper shape latched
 * on one side and open on the other.
 *
 * `null` is a REFUSAL, not a bucket. An unbound handle is never given its own authority here: that
 * fallback was the fail-open (a closure wrapper latched its own key while the real store stayed
 * open). `latchFault` treats `null` as a programming error.
 */
function authorityKey(store) {
  if (!store || typeof store !== 'object') return null;
  return resolveAuthority(store);
}

// THE REVISION COUNTER NEVER GOES BACKWARDS, EVEN ACROSS A CLEAR. (Measured, prompted by Codex's R8
// question "确认修订号在解除、再故障后不会重用".)
//
// A naive `revision + 1` per authority is wrong: the counter lived in the latch ENTRY, so clearing the
// latch deleted the entry and the next fault started again at 1 — an ABA. Measured:
//
//     latch('fault-A') -> revision 1;  clear(revision 1) -> cleared
//     latch('fault-B') -> revision 1   ← REUSED
//     clearFaultLatchIfRevision(1)     -> cleared:true  ← a STALE revision cleared the NEW fault
//
// That is the same defect the revision was introduced to fix, one step further out. So the counter is
// kept SEPARATELY from the entry, per authority, and is only ever incremented — it survives the clear.
// The map is a WeakMap keyed by the authority token, so it is process-local and dies with the token.
//
// OVERFLOW FAILS CLOSED, NOT BY WRAPPING (Codex R8). At `Number.MAX_SAFE_INTEGER` the counter stops
// issuing and the latch is raised with an unguessable-in-practice sentinel; it NEVER wraps to a value an
// old recovery could name. Reaching this needs 2^53 latches on one authority — impossible in practice,
// and the honest response if it ever happened is "could not issue an identity, refuse", exactly like
// every other unrepresentable state in this module.
const revisionByAuthority = new WeakMap();
const REVISION_EXHAUSTED = -1;   // sentinel: matches no caller-supplied revision, so nothing can clear it

/**
 * PURE: the revision a NEW fault on `current` must carry, and the counter value to store back.
 *
 * This is the ONE rule source for "advance the revision". The runtime path (`latchFault`) calls it,
 * and the tests call it directly — there is no second copy of the arithmetic and no exported setter
 * that can park a live authority's counter. (Codex CODEX-TEST-SEAM-CLOSE-20261114 §B: the old
 * `_setRevisionForTests` solved "make overflow testable" by adding a way to LOWER a real authority's
 * counter, which is a hand-made ABA. Extracting the rule instead makes the overflow branch reachable
 * by passing the value in, with nothing exported that can write to a live counter.)
 *
 * FACTORED OUT BECAUSE IT WAS UNTESTABLE (verifier t17): the exhaustion branch needed 2^53 latches to
 * reach, so "overflow fails closed" rested on reading the source, and a mutation that made the counter
 * WRAP instead of exhausting stayed green. A guarantee nobody can falsify is not a guarantee.
 *
 * @param current - the counter's current value (`undefined`/absent means "never latched"). MUST be a
 *                  non-negative safe integer when present; anything else throws rather than producing a
 *                  revision no guard downstream expects.
 * @returns `{ revision, next }` — the revision to stamp on the fault, and the counter to store back.
 *          At `MAX_SAFE_INTEGER` the counter is pinned there and the revision becomes
 *          `REVISION_EXHAUSTED`, which no caller-supplied revision can ever equal.
 */
export function advanceRevision(current) {
  // VALIDATED BECAUSE IT IS EXPORTED (verifier t21). The only internal caller passes values this
  // function itself produced, so nothing reachable feeds it junk today — but "only called internally"
  // is a current fact, not a structural guarantee, and arithmetic on junk produces junk silently:
  // `1.5` would yield `{revision: 2.5}` and `"5"` would yield `{revision: "51"}` (string concatenation).
  // Refusing is cheaper than arguing that the reachability proof will hold forever.
  if (current !== undefined && current !== null
      && (!Number.isSafeInteger(current) || current < 0)) {
    throw new TypeError('advanceRevision needs a non-negative safe integer (or undefined)');
  }
  const from = current ?? 0;
  if (from >= Number.MAX_SAFE_INTEGER) {
    return Object.freeze({ revision: REVISION_EXHAUSTED, next: Number.MAX_SAFE_INTEGER });
  }
  const next = from + 1;
  return Object.freeze({ revision: next, next });
}

function nextRevision(key) {
  const { revision, next } = advanceRevision(revisionByAuthority.get(key));
  revisionByAuthority.set(key, next);
  return revision;
}

/**
 * Record a process-local fault against ONE send authority. Called by the settlement/observability
 * layer on a commit or settlement failure.
 *
 * THE FIRST REASON IS KEPT, BUT THE FAULT GETS A NEW REVISION EVERY TIME. (Codex R7 counterexample 3,
 * reproduced in AR-9g.) Keeping only the first reason made two DIFFERENT faults — and even the same
 * fault occurring twice — indistinguishable, so a recovery that had read "old-fault" off the screen
 * could clear a NEW fault that arrived while it was working. Measured: latch 'old-fault', then a second
 * failure latches 'new-fault' during the recovery's own commit, and the recovery still ended with
 * `ok:true, latch:null` — a fresh fault erased by a stale recovery.
 *
 * So each call bumps `revision` (monotonic per authority, process-local, NEVER reused — see
 * `revisionByAuthority`). `revision` is the identity a recovery must name to clear; `reason` stays the
 * diagnostic record of what FIRST went wrong, which is usually the useful one. Recovery uses
 * `clearFaultLatchIfRevision`, a compare-and-clear, so it either removes exactly the fault it inspected
 * or removes nothing.
 *
 * @param store   - any handle EXPRESSING the send authority (any open handle on that database, or a
 *                  delegating wrapper spread from one).
 * @param reason  - short diagnostic string (e.g. `'settlement-commit-failed'`).
 */
export function latchFault(store, reason) {
  const key = authorityKey(store);
  if (key === null) throw new TypeError('latchFault needs the send authority (a store handle)');
  const existing = latchedByAuthority.get(key);
  const text = typeof reason === 'string' && reason ? reason : 'unspecified';
  latchedByAuthority.set(key, {
    reason: existing === undefined ? text : existing.reason,   // first reason wins as the diagnostic
    revision: nextRevision(key),
  });
  // A latched authority must never be forgotten by registry eviction — losing the token would lose
  // the fault and then allow sending (Codex R7 counterexample 1).
  pinAuthority(key);
  return readFaultLatch(store);
}

/**
 * Read-only probe for ONE authority. Returns `null` (no latch) or `{ reason, revision }`. Never mutates.
 *
 * `revision` is the identity of THIS fault event; pass it to `clearFaultLatchIfRevision` to clear
 * exactly the fault you inspected.
 */
export function readFaultLatch(store) {
  const key = authorityKey(store);
  // An unbound handle has no authority, so it cannot be latched — `null` here means "nothing is
  // latched against an authority I could name", NOT "healthy". Callers that need the persisted
  // verdict must still read `writeGate`/`auditGaps`; that is what a restart re-derives health from.
  if (key === null) return null;
  const entry = latchedByAuthority.get(key);
  if (entry === undefined) return null;
  return Object.freeze({ reason: entry.reason, revision: entry.revision });
}

/**
 * Drop the eviction pin ONLY when this authority has never issued a revision.
 *
 * WHY A RECOVERED AUTHORITY STAYS PINNED (Codex CODEX-R14-COMBINED-ABA-20261114, measured):
 * clearing a latch used to unpin the token immediately, so a HEALTHY authority became evictable again.
 * Combine that with the revision counter — which is keyed by token — and a real ABA reopens one step
 * outside AR-10's scope:
 *
 *     1) latch('old-fault') -> revision 1; recover with auditId 'recover-A' -> cleared, unpinned
 *     2) close the handle
 *     3) open+close 300 other databases -> the retired token is evicted (nothing pinned it)
 *     4) reopen the SAME database -> a FRESH token, so the counter restarts
 *     5) latch('new-fault') -> revision 1 AGAIN
 *     6) replay step 1's saved view (expectedLatchRevision = 1) -> it matches the NEW fault, and the
 *        stale request clears it. Measured: {staleRecoveryOk:true, released:{reason:'new-fault',revision:1},
 *        latchAfter:null, writeOk:true, sent:1} — the write went out.
 *
 * Root cause: the pin protected "still faulted" tokens but not "recovered, yet a revision was already
 * issued against this identity". No live fault is NOT the same as "no history an old view could still
 * refer to", and AR-10 (same token) plus LZ-9c (never recovered) are each green while their combination
 * is not.
 *
 * So: once an authority has issued a revision, its token is pinned for the life of the process. That
 * costs one permanently retained map entry per database that EVER faulted in this process — the same
 * unbounded-but-accepted class as the pin rule itself, and the honest alternative to forgetting an
 * identity that an outstanding admin request can still name. A never-faulted authority is still
 * evictable, so healthy databases do not accumulate.
 */
function releasePinIfNoHistory(key) {
  if (revisionByAuthority.has(key)) return;   // a revision was issued: keep the identity addressable
  unpinAuthority(key);
}

/**
 * COMPARE-AND-CLEAR: remove the latch only if it is still the revision the caller inspected.
 *
 * This is the only clearing primitive a recovery may use. `clearFaultLatch` remains as the explicit
 * test/operator escape hatch, but a recovered fault must go through this one so a fault that arrived
 * between "read the screen" and "commit the recovery" is NOT silently erased.
 *
 * A revision the counter could not issue (`REVISION_EXHAUSTED`) matches nothing here, so an exhausted
 * counter keeps the latch up — fail-closed, never a wrap that some old recovery could name.
 *
 * @returns `{ cleared: true }` when this call removed the latch, or
 *          `{ cleared: false, current }` with the live `{ reason, revision }` when it did not.
 */
export function clearFaultLatchIfRevision(store, revision) {
  const key = authorityKey(store);
  if (key === null) return { cleared: false, current: null };
  if (!Number.isSafeInteger(revision) || revision < 1) {
    return { cleared: false, current: null };   // an unnamed revision can never clear
  }
  const entry = latchedByAuthority.get(key);
  if (entry === undefined) return { cleared: false, current: null };
  if (entry.revision !== revision) return { cleared: false, current: Object.freeze({ ...entry }) };
  latchedByAuthority.delete(key);
  releasePinIfNoHistory(key);
  return { cleared: true, current: null };
}

/**
 * Test/operator escape hatch for ONE authority: clear its latch unconditionally.
 *
 * Deliberately NOT called from any production path — clearing a latch must be a conscious act, and a
 * recovery must use `clearFaultLatchIfRevision` so it cannot erase a newer fault.
 */
export function clearFaultLatch(store) {
  const key = authorityKey(store);
  if (key !== null) {
    latchedByAuthority.delete(key);
    releasePinIfNoHistory(key);
  }
  return null;
}

/**
 * The combined pre-dispatch refusal reason, or `null` when a permit may be issued.
 *
 * Order matters and is asserted by tests: the PROCESS-LOCAL latch for THIS authority is checked first
 * (it means a live component just failed), then the PERSISTED health gate. Both must pass.
 */
function gateRefusal(store, state, action, now) {
  if (readFaultLatch(store) !== null) return 'process-fault-latched';
  const health = checkWriteGate(state, { action, now });
  return health?.allowed === true ? null : (health?.reason ?? 'write-gate-refused');
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// M3/F-M3-1 · STRICT PARAMETER VALIDATION AND THE IMMUTABLE SNAPSHOT
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// THE DEFECT THIS REPLACES (F-M3-1, measured)
// -------------------------------------------
// The previous revision digested parameters as
//
//     typeof content === 'string' ? content : null
//
// so `content:{text:'first'}` and `content:{text:'DIFFERENT'}` produced the SAME digest while the
// facade still handed the ORIGINAL object to the transport. Two different messages could share one
// parameter binding. Two things were wrong: a silent normalisation, and a digest that was not of the
// thing being sent.
//
// THE RULES NOW
// -------------
//   1. Only shapes the write contract actually supports are accepted. The rules are the contract
//      module's own primitives (`isValidWriteContent` / `isValidWriteId`, `qzone-onebot-write-
//      contract.mjs`), imported rather than copied, so this module and the platform request builder
//      cannot drift apart. `isValidWriteId` is the builder's `id()` rule, which `tid` (post id) and
//      `comment_id` BOTH go through — one name, one rule, no second spelling to drift.
//   2. Anything else is refused BEFORE the reservation — so a malformed call costs nothing:
//      no quota, no cooldown marker, no `reservations[id]`, no transport.
//   3. The validated values are assembled ONCE into a frozen `dispatch` object, and THAT object is
//      what the transport receives. There is no second read of the caller's properties and no
//      digest computed over a different value.
//
// WHAT IS **NOT** DONE HERE (deliberately)
// ----------------------------------------
// The full platform builder (`buildQzoneOnebotWriteRequest`) is NOT called from this facade, and we do
// not fake what it needs. For `publish` it requires an explicit `ugc_right`; for `reply` it requires
// `comment_uin`. Neither is a field this facade carries, and inventing a default visibility (or a
// placeholder author) would be exactly the kind of silent default the contract exists to forbid. So
// the facade validates the fields it DOES carry with the same primitives, and the builder stays the
// only place that knows how to shape a platform request.
const TARGET_PATTERN = /^\d{1,20}$/;

/**
 * Read the FULL reply identity (`comment_uin`, and the optional `reply_uin`/`reply_name` pair) from
 * the same object `write()` was called with.
 *
 * WHY THE REPLY IDENTITY IS NOT IN `write()`'s DESTRUCTURING PATTERN: that pattern's field list is
 * pinned verbatim by `test-qzone-write-gate-linearization.mjs` LZ-17 (an exhaustive
 * facade-vocabulary check that fails if the set of destructured names changes without the table being
 * updated). Widening the pattern therefore requires editing a test that this change was NOT
 * authorised to touch, so the three fields are read off the ORIGINAL argument object instead of being
 * pulled out by the pattern. Nothing is hidden by that: the values are validated here, frozen onto
 * the dispatch, and the dispatch is what the transport receives.
 *
 * VALIDATION (the builder's own rules, imported rather than re-spelled):
 *   · `commentUin` is REQUIRED for a reply — `buildQzoneOnebotWriteRequest('reply', …)` throws
 *     without `comment_uin`, and a reply whose parent author is unknown cannot be checked against
 *     the recorded evidence at all (see `qzone-reply-evidence-offline.mjs`).
 *   · `replyUin` / `replyName` are a PAIR, both present or both absent — same rule as the builder,
 *     so a half target is refused instead of being defaulted to "the thread".
 *   · `replyName` uses `isValidWriteContent`, which is the builder's `body()` rule.
 *   · A NON-reply carrying any of the three is REFUSED (`unexpected-reply-field`). Dropping them
 *     silently would make the caller believe something was addressed to a person when the dispatch
 *     never said so.
 *
 * @returns `{ok:true, value:{commentUin, replyUin, replyName}|null}` or `{ok:false, reason}`.
 */
function readReplyIdentity(input, action) {
  const commentUin = input.commentUin;
  const replyUin = input.replyUin;
  const replyName = input.replyName;
  const anyPresent = commentUin !== undefined || replyUin !== undefined || replyName !== undefined;
  if (action !== 'reply') {
    return anyPresent ? { ok: false, reason: 'unexpected-reply-field' } : { ok: true, value: null };
  }
  const uin = trustedQQ(commentUin);
  if (uin === null) return { ok: false, reason: 'invalid-comment-uin' };
  const hasReplyUin = replyUin !== undefined && replyUin !== null;
  const hasReplyName = replyName !== undefined && replyName !== null;
  if (hasReplyUin !== hasReplyName) return { ok: false, reason: 'invalid-reply-target' };
  if (!hasReplyUin) {
    return { ok: true, value: Object.freeze({ commentUin: uin, replyUin: null, replyName: null }) };
  }
  const target = trustedQQ(replyUin);
  if (target === null || !isValidWriteContent(replyName)) {
    return { ok: false, reason: 'invalid-reply-target' };
  }
  return { ok: true, value: Object.freeze({ commentUin: uin, replyUin: target, replyName }) };
}

/**
 * Validate and freeze the request for one write. Pure: no I/O, no clock, no state.
 *
 * @returns {{ok:true, dispatch:object} | {ok:false, reason:string}}
 */
function snapshotRequest(input) {
  const { id, action, target, postId, source, content, commentId } = input;

  if (typeof id !== 'string' || !id) return { ok: false, reason: 'invalid-id' };
  if (!Object.hasOwn(ACTION_TO_KIND, action)) return { ok: false, reason: 'not-a-write-action' };

  // ── content: supported only as a non-empty string, and only where a body exists ──
  // `publish`/`comment`/`reply` require one. An OBJECT, number, array or empty string is refused —
  // never normalised to null.
  //
  // `like` is the opposite case, and it is a REFUSAL, not a silent drop. The write contract
  // (`qzone-onebot-write-contract.mjs`) lists exactly `FIELDS.like = {tid, target_uin, abstime}` —
  // `content` is not a field of a like, and `copyFields` throws `invalid field` on it. A facade that
  // accepted the body anyway would be WIDER than the contract it is supposed to feed: measured before
  // this guard, `{action:'like', content:'this is a body'}` was accepted and the string was handed to
  // the transport. Dropping the value silently instead would be worse than refusing — the caller would
  // believe a body was sent. So: a like may carry NO body, and one that does is refused before any
  // reservation. (t10 / LZ-16.)
  const bodyRequired = action !== 'like';
  const hasContent = content !== undefined && content !== null;
  if (!bodyRequired && hasContent) return { ok: false, reason: 'unexpected-content' };
  if (bodyRequired || hasContent) {
    if (!isValidWriteContent(content)) return { ok: false, reason: 'invalid-content' };
  }

  // ── commentId: the parent comment of a reply, and only meaningful for a reply ──
  // Validated with the builder's OWN id rule. `comment_id` goes through `id()` in
  // `qzone-onebot-write-contract.mjs`, and `id()` is `isValidWriteId` — so a parent id this facade
  // accepts is exactly one the builder would accept. No second, looser spelling of the same rule.
  if (action === 'reply') {
    if (!isValidWriteId(commentId)) return { ok: false, reason: 'invalid-comment-id' };
  } else if (commentId !== undefined && commentId !== null) {
    // Not a reply: a parent-comment id has no meaning here, and silently dropping it would make the
    // caller's request differ from what was authorised. Refuse instead.
    return { ok: false, reason: 'unexpected-comment-id' };
  }

  // ── reply identity: who the parent comment belongs to, and who (if anyone) is being answered ──
  // A reply needs `comment_uin` (the builder refuses a reply without it, and without it the recorded
  // evidence cannot be compared at all). `reply_uin`/`reply_name` are a PAIR. A non-reply carrying any
  // of the three is refused rather than silently dropped — see `readReplyIdentity`.
  const replyIdentity = readReplyIdentity(input, action);
  if (replyIdentity.ok !== true) return { ok: false, reason: replyIdentity.reason };

  // ── target / postId: the identity of the object acted on ──
  // `postId` is the platform `tid`, so it is validated with the SAME builder rule as `comment_id`.
  // `target` is a QQ number: the builder takes it through its own `qq()` normaliser, but normalising
  // it HERE would change the value the caller was authorised for, so this facade only requires the
  // decimal-string shape and leaves normalisation to the builder.
  if (action === 'publish') {
    if (target !== undefined && target !== null && (typeof target !== 'string' || !TARGET_PATTERN.test(target))) {
      return { ok: false, reason: 'invalid-target' };
    }
    if (postId !== undefined && postId !== null && !isValidWriteId(postId)) {
      return { ok: false, reason: 'invalid-post-id' };
    }
  } else {
    if (typeof target !== 'string' || !TARGET_PATTERN.test(target)) return { ok: false, reason: 'invalid-target' };
    if (!isValidWriteId(postId)) return { ok: false, reason: 'invalid-post-id' };
  }

  // The frozen snapshot. Field order is fixed and every field is a primitive, so the object cannot
  // change after this line — which is the whole point: it is both the validated value and the sent
  // value. `commentId` appears only where it exists (a reply), and the reply identity appears only
  // when the caller actually supplied it (see `readReplyIdentity`).
  const dispatch = {
    id,
    action,
    kind: ACTION_TO_KIND[action],
    target: target ?? null,
    postId: postId ?? null,
    source: typeof source === 'string' ? source : null,
    content: hasContent ? content : null,
    ...(action === 'reply' ? { commentId } : {}),
    ...(replyIdentity.value === null ? {} : {
      commentUin: replyIdentity.value.commentUin,
      replyUin: replyIdentity.value.replyUin,
      replyName: replyIdentity.value.replyName,
    }),
  };
  return { ok: true, dispatch: Object.freeze(dispatch) };
}

/**
 * The conservative "unknown intent" record a reply's reservation commits together with the quota.
 *
 * `reserveAuditedOfflineInteraction` requires the audit input to describe EXACTLY the request it is
 * reserving (`time`/`action`/`target`/`postId`/`commentId`/`source` all compared field by field), and
 * to carry the conservative `result:'unknown'`, `reason:''` pair: at reserve time nothing has been
 * sent, so nothing else would be true. It is built from the FROZEN dispatch, never from the caller's
 * object, so the record and the reservation cannot describe two different writes.
 *
 * `content` is copied as `dispatch.content` — the validated string (or `null` for an action without a
 * body). `formatAuditRecord` redacts a body that looks like a credential and refuses nothing here; a
 * refused (redacted) record makes `reserveAuditedOfflineInteraction` throw `invalid intent`, which is
 * the intended fail-closed behaviour for a sensitive body.
 */
function buildReplyIntent({ now, source, dispatch }) {
  return {
    time: now, source, action: dispatch.action, target: dispatch.target,
    postId: dispatch.postId, commentId: dispatch.commentId,
    content: dispatch.content, result: 'unknown', reason: '',
  };
}

/**
 * Build the offline write path.
 *
 * @param store - offline state store (`read`/`update`); tests use a real temp SQLite file.
 *   The SAME store backs the policy fields (top level) and the quota ledger (`state.ledger`).
 * @param clock - `() => trusted millisecond timestamp`. Everything (day, intervals) derives from it.
 * @param transport - `async (dispatch) => result`, where `dispatch` is the frozen snapshot
 *   (`{ id, action, kind, target, postId, source, content, commentId? }`). INJECTED; never composed
 *   here.
 * @param limits - kept for signature compatibility with the settlement module and used ONLY as a
 *   construction-time sanity check. The authoritative caps are read from `state.limits` inside the
 *   reservation transaction, exactly as `qzone-reservation-offline.mjs` expects.
 */
export function createOfflineWritePath({ store, limits, clock, transport } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('offline write path needs a store with read/update');
  }
  // CONSTRUCTION-TIME REFUSAL (R6). A handle that cannot name its send authority would make the
  // fault latch unreachable — the write would go out even though a fault was latched for the same
  // database. Refuse now, with nothing reserved and no transport call, instead of failing open later.
  requireAuthority(store, 'offline write path');
  if (typeof clock !== 'function') throw new TypeError('offline write path needs a clock()');
  if (typeof transport !== 'function') throw new TypeError('offline write path needs a transport function');
  if (limits !== undefined && (limits === null || typeof limits !== 'object' || Array.isArray(limits))) {
    throw new TypeError('offline write path limits must be an object when provided');
  }

  /**
   * M3 · the authorisation LINEARIZATION POINT — and, per v6 §2.4, nothing more.
   *
   * One `store.update` re-runs, against the state committed RIGHT NOW:
   *   1. the health gate (process latch, then the persisted `writeGate`/`auditGaps`),
   *   2. `authorizeTool`.
   *
   * The callback returns the state UNCHANGED. That is not a claim of "no transaction": `store.update`
   * does `BEGIN IMMEDIATE` → `fn(read())` → `UPDATE` → `COMMIT` unconditionally, so a commit happens
   * either way. The point of running the check inside it is that the check reads committed state
   * under the write lock, and **the grant is the successful commit of this very transaction**: if it
   * throws, SQLite rolls back, `write()` never reaches the transport, and no message leaves.
   *
   * There is deliberately no record of the grant. Persisting one is the P-2 branch of the design's
   * decision tree, which was NOT taken (no independent consumer bypasses this control flow), and an
   * in-memory "already granted" flag would be a claim the crash semantics cannot back.
   *
   * @returns {{paused: false} | {paused: true, reason: string, cause: 'gate'|'authorize'}}
   */
  const finalAuthorisationCheck = (action, bindings) => {
    let verdict = { paused: false };
    store.update((state) => {
      // (1) health first: a broken store must not be handed a grant at all.
      const refusal = gateRefusal(store, state, action, bindings.now);
      if (refusal !== null) {
        verdict = { paused: true, reason: refusal, cause: 'gate' };
        return state;
      }
      // (2) the whole authorization gate, re-run against the state as committed RIGHT NOW.
      const decision = authorizeTool(state, action);
      if (!decision || decision.allowed !== true) {
        verdict = { paused: true, reason: decision?.reason ?? 'authorize-refused', cause: 'authorize' };
        return state;
      }
      // (3) GRANTED — by the commit this return takes part in. Nothing is written.
      verdict = { paused: false };
      return state;
    });
    return verdict;
  };

  /** The shape every refusal BEFORE the reservation uses: nothing spent, nothing sent. */
  const refused = (reason) => Object.freeze({ ok: false, stage: 'reserve', reason, quotaConsumed: false });

  return Object.freeze({
    /** Diagnostic: the current quota ledger, read-only. */
    ledger() {
      const state = store.read();
      return state && typeof state === 'object' && state.ledger ? state.ledger : null;
    },

    /**
     * Run one write through the complete chain.
     *
     * @returns
     *   { ok:true,  stage:'transport', outcome:'success'|'failed'|'unknown'|'not-sent', result? }
     *   { ok:false, stage:'reserve',   reason, quotaConsumed:false }   transport never called
     *   { ok:false, stage:'authorize', reason }                       transport never called
     *   { ok:false, stage:'transport', outcome:'not-sent', reason:'paused-before-send', quotaConsumed:true }
     *                                                                 reserved, NOT sent
     */
    async write({ id, action, target, postId, source, content, commentId } = {}) {
      // The reply identity (`commentUin`/`replyUin`/`replyName`) is read from the CALL's argument
      // object instead of being destructured above, and that is a deliberate, stated compromise:
      // `test-qzone-write-gate-linearization.mjs` LZ-17 pins this destructuring list VERBATIM
      // (`declaredParams` must equal a fixed set), and that test is outside this change's writable
      // files. `arguments[0]` IS the object the pattern destructures, so nothing is hidden: the three
      // values are validated in `readReplyIdentity` and frozen onto the dispatch, exactly like every
      // other field. If a later change is allowed to update LZ-17, move them into the pattern.
      const request = arguments[0] === undefined ? {} : arguments[0];

      // ── stage 0: only real write actions ───────────────────────────────────────────────────
      if (!Object.hasOwn(ACTION_TO_KIND, action)) {
        return Object.freeze({
          ok: false, stage: 'authorize', reason: 'not-a-write-action',
        });
      }
      if (typeof id !== 'string' || !id) {
        return refused('invalid-id');
      }

      const now = clock();
      const kind = ACTION_TO_KIND[action];

      // ── stage 0b: the H3 write gate (health of our own state store) ────────────────────────
      // Placed AFTER `now` (the gate's signature accepts it) and BEFORE the reservation, so a
      // refused write costs nothing at all: no quota unit, no cooldown, no `reservations[id]`, no
      // transport call. A gate that only refused after the reservation would refund nothing —
      // `reserveWrite` has no undo path — so "check first" is the only shape that can deliver
      // "zero reservation, zero consumption".
      //
      // WHY `stage: 'reserve'` AND NOT `'authorize'`: this label is not a place-name, it is an input
      // to `mapWriteResult` (`qzone-write-observability-offline.mjs:124`), which turns
      // `{ok:false, stage:'reserve'}` into audit result `'denied'` and leaves the breaker alone. That
      // is exactly what a gate refusal is: nothing was sent, nothing failed on the platform, so it
      // must NOT be counted as a real failure and must NOT be recorded as `unknown` (which would imply
      // "a call may have gone out"). The stage-0 refusals above (`not-a-write-action`) use
      // `'authorize'` because they predate that mapping and no consumer distinguishes them; a gate
      // refusal is more precisely "the dispatch was denied before any state was touched", and
      // `'denied'` is the accurate audit word for it. `'authorize'` would map to `'unknown'` — a false
      // "might have been sent".
      //
      // The gate is checked BEFORE the parameter validation on purpose: "the store is unhealthy" is a
      // reason not to send ANYTHING, and it must not be masked by a caller bug in one request.
      const health = gateRefusal(store, store.read(), action, now);
      if (health !== null) {
        return refused(health);
      }

      // ── stage 0c: STRICT validation + the immutable snapshot (F-M3-1) ─────────────────────
      // Still before the reservation: an unsupported parameter shape must cost NOTHING. `dispatch` is
      // the single source for this call — the transport receives this exact frozen object, so "what
      // was validated" and "what was sent" cannot diverge.
      const snap = snapshotRequest({
        id, action, target, postId, source, content, commentId,
        commentUin: request.commentUin,
        replyUin: request.replyUin,
        replyName: request.replyName,
      });
      if (snap.ok !== true) return refused(snap.reason);
      const dispatch = snap.dispatch;

      // ── stage 1: THE atomic reservation (all rules, one transaction) ───────────────────────
      // `publish` and the three interaction actions have different rule sets (interval semantics,
      // like de-duplication), so they go through their respective reviewed entry points. All are
      // synchronous and all decide + write inside a single `store.update`.
      let reserved;
      if (action === 'publish') {
        reserved = reserveOfflinePost(store, { id, now });
      } else if (action === 'reply') {
        // WHY A REPLY NEEDS THE **AUDITED** ENTRY POINT
        // ----------------------------------------------
        // A reply's addressed-to identity (`comment_uin`, and the optional `reply_uin`/`reply_name`
        // pair) is not one of the four facade fields the plain entry point receives, so a plain
        // `reserveOfflineInteraction` call could only ever check the identity TRIPLE
        // (target/postId/commentId) — i.e. it would not verify WHO the reply is addressed to.
        // `reserveAuditedOfflineInteraction` performs the FULL evidence match **inside the same
        // `store.update`** that would otherwise spend the quota unit and advance the 3-minute comment
        // clock. A missing or mismatched row therefore costs NOTHING: `used.comment`,
        // `lastCommentAt`, `commentTargets` and the B2 key are all untouched, and the returned
        // refusal is a stage-`reserve` refusal with `quotaConsumed:false` — not a transport-stage
        // "not-sent" that has already paid.
        //
        // ⚠️ THE EVIDENCE CHECK MUST NOT MOVE INTO THE TRANSPORT CLOSURE. There the reservation has
        // already committed, so a refusal would burn a `comment` unit and push `lastCommentAt`,
        // throttling (by 3 minutes) every later legitimate comment — a denied request would cost the
        // caller a cooldown it never got value for. That was the previous contract; it is now
        // forbidden.
        //
        // `replyParams` is ALWAYS supplied, never conditionally: a reply able to fall back to the
        // triple-only check would be a reply whose addressed-to identity was never verified.
        //
        // `source` is whitelisted FIRST: the audited entry point requires `source ∈ {qq, patrol}` and
        // THROWS `invalid intent` otherwise, and a throw here would be classified as a store fault
        // rather than the controlled refusal an unsupported source deserves.
        if (dispatch.source !== 'qq' && dispatch.source !== 'patrol') {
          return refused('unsupported-reply-source');
        }
        reserved = reserveAuditedOfflineInteraction(
          store,
          {
            id, now, tool: action, target: dispatch.target, postId: dispatch.postId,
            source: dispatch.source, commentId: dispatch.commentId,
            // ── EVIDENCE AGE: PASSED EXPLICITLY, NEVER OPTIONAL, NEVER DISABLEABLE ─────────────
            // The reservation judges the evidence row's age inside its own transaction (see
            // `reserveAuditedOfflineInteraction`: the `at` checks sit between the identity match and the
            // quota spend, so a stale or undated row costs nothing). Leaving `maxAgeMs` off would still
            // be safe — that path falls back to the same default — but it would leave the bound implicit
            // and invisible to anyone reading the chain, and "the caller forgot" would become
            // indistinguishable from "the chain decided". So it is written out.
            //
            // VALUE: `DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS` (10 minutes), imported from the reservation
            // module rather than re-typed here, so this chain and the module default can never drift
            // apart. Ten minutes is the window the read → bind → record → approve → send sequence was
            // designed around: comfortably longer than the 30 s approval TTL and the 3-minute comment
            // interval, short enough that "this comment exists and its author is X" is still a claim
            // about the current content.
            //
            // `enforceEvidenceAge` IS DELIBERATELY ABSENT. That flag exists only as an explicit
            // LEGACY-ISOLATION whitelist for old direct callers of the reservation function (fixtures,
            // simulations) that cannot supply a dated row. This chain is the B3 reply chain: evidence age
            // is unconditionally enforced here, and there is no reachable input that turns it off —
            // `createOfflineWritePath`'s options are not forwarded to this call, so a caller cannot
            // smuggle the opt-out through a "request" object. Do NOT add it, not even behind a flag.
            maxAgeMs: DEFAULT_REPLY_EVIDENCE_MAX_AGE_MS,
            replyParams: {
              comment_id: dispatch.commentId,
              comment_uin: dispatch.commentUin,
              ...(dispatch.replyUin === null ? {} : { reply_uin: dispatch.replyUin, reply_name: dispatch.replyName }),
            },
          },
          buildReplyIntent({ now, source: dispatch.source, dispatch }),
        );
      } else {
        reserved = reserveOfflineInteraction(store, {
          id, now, tool: action, target: dispatch.target, postId: dispatch.postId,
        });
      }

      if (reserved?.allowed !== true) {
        // Nothing was sent and nothing was consumed: the reservation transaction rolled back or took
        // the "refused" branch, which returns the state untouched.
        return Object.freeze({
          ok: false, stage: 'reserve', reason: reserved?.reason ?? 'reserve-refused',
        });
      }

      // ── stage 1b: the authorisation LINEARIZATION POINT ───────────────────────────────────
      // The reservation above already passed the gate. What happens HERE is the last thing that can
      // stop the message: a pause landing between the reserve and this line is caught, and the grant
      // is the commit of this check. A pause landing AFTER this returns is NOT caught (see the
      // header's scope note) — that window is inherent to calling an out-of-process transport.
      const final = finalAuthorisationCheck(action, { now });
      if (final.paused) {
        // The quota unit is NOT refunded, and that is deliberate: `reserveWrite` has no undo path, and
        // rolling back here would erase the very fact the caller needs — "a unit was spent and nothing
        // was sent". `quotaConsumed: true` reports the cost; `permitRefusedBy` says which layer
        // withheld the grant, distinguishing a health refusal from a pause.
        return Object.freeze({
          ok: false,
          stage: 'transport',
          outcome: SETTLEMENT_OUTCOME.NOT_SENT,
          reason: 'paused-before-send',
          quotaConsumed: true,
          transportCalled: false,
          reserveReason: final.reason,
          // Which layer refused: 'gate' | 'authorize'. Distinct causes get distinct responses from an
          // operator, so they must not be flattened into one string.
          permitRefusedBy: final.cause,
        });
      }

      // ── stage 2: the only irreversible step, exactly once, with the SNAPSHOT ─────────────
      // `dispatch` is the frozen object built at stage 0c — not a re-read of the caller's request and
      // not a re-assembled copy. Nothing can be sent that was not validated.
      let outcome;
      let result;
      let error;
      try {
        result = await transport(dispatch);
        outcome = classifyTransportResult(result);
      } catch (thrown) {
        // A throw is NOT "it did not happen": the request may have reached the platform before the
        // failure surfaced. Classified as unknown, the reservation and the quota are kept, and
        // nothing retries.
        outcome = SETTLEMENT_OUTCOME.UNKNOWN;
        error = thrown;
      }

      // ── stage 3: report. Quota stays consumed in every branch. ────────────────────────────
      return Object.freeze({
        ok: true,
        stage: 'transport',
        outcome,
        quotaConsumed: true,
        transportCalled: true,
        ...(result === undefined ? {} : { result }),
        ...(error === undefined ? {} : { error }),
        ...(outcome === SETTLEMENT_OUTCOME.UNKNOWN ? { reason: 'unknown-outcome' } : {}),
      });
    },
  });
}

export { classifyTransportResult as _classifyForTests };
