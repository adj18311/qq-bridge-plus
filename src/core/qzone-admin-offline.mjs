import { appendOfflineAudit, formatAuditGap, formatAuditRecord } from './qzone-audit-offline.mjs';
import {
  validatePatrolInterval, resetDailyCounter, manualRestore, checkWriteGate,
} from './qzone-policy-offline.mjs';
import { requireAuthority } from './qzone-authority-shared.mjs';
import { readFaultLatch, clearFaultLatchIfRevision } from './qzone-write-path-offline.mjs';

const TOOLS = ['read_posts', 'read_comments', 'publish', 'comment', 'reply', 'like'];
const LIMITS = ['post', 'comment', 'like'];
const CONFIG_KEYS = ['enabled', 'readAllowed', 'writeAllowed', 'tools', 'limits', 'intervalMinutes', 'activeStart', 'activeEnd'];
const isPlain = (value) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const pauseScope = (state) => state.accessPaused ? (state.writePaused ? 'both' : 'access') : (state.writePaused ? 'write' : 'none');
function currentPauseCause(state, layer) {
  const cycle = isPlain(state.pauseCycles) ? state.pauseCycles[layer] : null;
  // Legacy settlement IDs are opaque; only their presence and safe length
  // matter here. They are not included in the human-facing audit summary.
  const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    !['__proto__', 'constructor', 'prototype'].includes(value);
  const causes = layer === 'write' ? ['failure', 'network_unavailable'] : ['failure', 'login_expired', 'captcha', 'network_unavailable'];
  if (!isPlain(cycle) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cycle.id ?? '') ||
      !validId(cycle.operationId) || !causes.includes(cycle.cause)) return 'unknown';
  return cycle.cause;
}

// Offline transaction prototype: caller must separately authenticate operator
// and enforce serialized access when dispatching actual platform requests.
export function configureOfflineQzone(store, patch, actor) {
  if (!store || typeof store.update !== 'function' || !isPlain(patch) || !actor ||
      Object.keys(patch).some((key) => !CONFIG_KEYS.includes(key))) throw new TypeError('invalid configuration');
  for (const key of ['enabled', 'readAllowed', 'writeAllowed']) if (Object.hasOwn(patch, key) && typeof patch[key] !== 'boolean') throw new TypeError('invalid boolean');
  if (Object.hasOwn(patch, 'tools') && (!isPlain(patch.tools) || Object.entries(patch.tools).some(([k, v]) => !TOOLS.includes(k) || typeof v !== 'boolean'))) throw new TypeError('invalid tools');
  if (Object.hasOwn(patch, 'limits') && (!isPlain(patch.limits) || Object.entries(patch.limits).some(([k, v]) => !LIMITS.includes(k) || !Number.isInteger(v) || v < 0 || v > 99))) throw new TypeError('invalid limits');
  if (Object.hasOwn(patch, 'intervalMinutes') && !validatePatrolInterval(patch.intervalMinutes)) throw new TypeError('invalid interval');
  store.update((state) => {
    if (typeof state.accessPaused !== 'boolean' || typeof state.writePaused !== 'boolean' || !isPlain(state.tools) || !isPlain(state.limits)) throw new TypeError('invalid state');
    let next = { ...state, ...patch, tools: { ...state.tools, ...patch.tools }, limits: { ...state.limits, ...patch.limits } };
    if (![next.activeStart, next.activeEnd].every((x) => Number.isInteger(x) && x >= 0 && x < 1440) || next.activeStart === next.activeEnd) throw new TypeError('invalid active time');
    const intent = { time: actor.time, source: actor.source, action: 'configure', target: actor.target, operator: actor.operator,
      pauseScope: pauseScope(state), content: JSON.stringify(patch), result: 'success' };
    const txn = { update(fn) { next = fn(next); } };
    if (!appendOfflineAudit(txn, actor.auditId, intent).appended) throw new Error('duplicate audit id');
    return next;
  });
}

function manageOffline(store, selection, actor, action) {
  if (!store || typeof store.update !== 'function' || !actor) throw new TypeError('invalid management request');
  if (actor.correlationId !== undefined && (typeof actor.correlationId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(actor.correlationId) ||
      ['__proto__', 'constructor', 'prototype'].includes(actor.correlationId))) throw new TypeError('invalid correlation id');
  store.update((state) => {
    if (typeof state.accessPaused !== 'boolean' || typeof state.writePaused !== 'boolean') throw new TypeError('invalid pause state');
    const pauseReasons = action === 'restore'
      ? Object.fromEntries((selection === 'both' ? ['access', 'write'] : [selection]).map((layer) =>
        [layer, state[`${layer}Paused`] === true ? currentPauseCause(state, layer) : 'unknown']))
      : null;
    let next = action === 'reset_quota' ? { ...state, ledger: resetDailyCounter(state.ledger, selection) } : manualRestore(state, selection);
    const record = { time: actor.time, source: actor.source, action, target: actor.target, operator: actor.operator,
      pauseScope: pauseScope(state),
      reason: action === 'restore'
        ? (Object.values(pauseReasons).includes('network_unavailable') ? 'network' :
          selection !== 'both' && pauseReasons[selection] === 'captcha' ? 'captcha' :
          selection !== 'both' && pauseReasons[selection] === 'login_expired' ? 'login_expired' : '')
        : actor.reason ?? '',
      content: JSON.stringify({ ...(action === 'restore' ? { selection, pauseReasons } : { selection }),
        ...(actor.correlationId === undefined ? {} : { correlationId: actor.correlationId }) }), result: 'success' };
    const txn = { update(fn) { next = fn(next); } };
    if (!appendOfflineAudit(txn, actor.auditId, record).appended) throw new Error('duplicate audit id');
    return next;
  });
}

export function resetOfflineQuota(store, kind, actor) { return manageOffline(store, kind, actor, 'reset_quota'); }
export function restoreOfflinePause(store, layer, actor) { return manageOffline(store, layer, actor, 'restore'); }

// ════════════════════════════════════════════════════════════════════════════════════════════
// M9 · DEDICATED AUDIT / STORAGE FAULT RECOVERY (§5.2 — three steps, order NOT interchangeable)
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// WHAT THIS RECOVERS — AND WHAT IT MUST NOT TOUCH
// -----------------------------------------------
// Recovered: `state.writeGate` (the persisted "we could not write our own audit row" marker) and
// every OPEN `auditGaps` entry (`resolvedBy` absent or null). NOTHING else. The quota ledger,
// `commentTargets` cooldown, `likes` dedup evidence, `reservations`, `accessPaused`/`writePaused`
// and the platform pause are all left exactly as found (R-2: clearing an audit fault is not
// clearing a quota and is not lifting a platform pause).
//
// §5.1 is why this is a SEPARATE function and not a new branch of `manualRestore`: the existing
// `access` / `write` / `both` semantics stay byte-for-byte as they were, and neither `both` nor the
// 24h platform health probe may clear an audit fault as a side effect. They answer "may we talk to
// the platform again?", this one answers "may we trust our own audit sink again?". `restore_*`
// below is untouched, so `restoreOfflinePause(store, 'both', …)` on a faulted store leaves
// `writeGate` and every gap exactly where they were.
//
// A GAP IS MARKED, NEVER DELETED (G-4)
// ------------------------------------
// `resolvedBy = { generation, at, operator }` is written onto the existing entry through
// `formatAuditGap`, i.e. the SAME validator the write gate consults via `isResolvedBy`. So
// "marked as resolved" and "the gate stops counting it" cannot drift, and the entry remains as the
// evidence that an audit row went missing. Deleting it would destroy that evidence and is exactly
// what G-4 forbids.
//
// THE THREE STEPS (§5.2), ALL INSIDE ONE `store.update` (so a throw rolls the whole thing back)
// -------------------------------------------------------------------------------------------
//   ① VERIFY STRUCTURE (read-only, no repair, no guessing):
//        · `state.audit` is an array whose rows are readable and uniquely id'd;
//        · `state.writeGate` is absent/null or a readable marker of a fault name we know;
//        · `auditGaps` is enumerable and every entry is a readable gap (legacy four-field entries
//          count as OPEN — that is the same reading the gate uses for an absent `resolvedBy`).
//        Failure ⇒ refuse, return the state untouched. Nothing is half-repaired.
//   ② CHECK GENERATION: the caller's `expectedGeneration` must equal the generation of the OPEN
//        gaps, exactly. Mismatch / two distinct generations / no open gap ⇒ refuse. A different
//        episode must not be cleared by this call, and this function does not pick "the newest".
//   ③ RECORD THE MANAGEMENT AUDIT, AND ONLY THEN CLEAR: the row is appended first; the cleared
//        state is computed from the post-append state. If the append throws there is NO catch —
//        `store.update` rolls back and the fault survives (R-3, fail-closed by construction).
//
// GENERATION SEMANTICS — the "口径", stated once so it cannot be re-derived differently later
// -------------------------------------------------------------------------------------------
// The generation of the CURRENT fault = the deduplicated, sorted set of `generation` values of the
// entries that are still OPEN. Why this source and not `writeGate`, not a clock:
//   · it is the only PERSISTED per-episode identity: `writeGate.since` is a timestamp, and a retry
//     of the same broken settlement mints no second gap (same stable key), so a clock cannot tell
//     "the same episode" from "another attempt at it";
//   · `generation` derives from the settle key (`gapGenerationFor`), i.e. from the very operation
//     whose audit row was lost — agreeing on it means the operator is looking at the same lost rows;
//   · exact equality is checkable for one generation. Two distinct generations are NOT collapsed
//     here: that would silently resolve an episode nobody confirmed, so it is a refusal.
//   · zero open gaps ⇒ there is no persisted generation to compare, so nothing can be verified ⇒
//     refuse. (Consequence, stated as a limitation: a store that carries a fault marker with every
//     gap already marked resolved cannot be recovered by THIS function; it needs manual repair.
//     Guessing a generation there is precisely what ② forbids.)
//
// ACTION NAME — a deliberate, documented compromise
// -------------------------------------------------
// §7/M9 asks for a dedicated action name (`restore_audit_fault`). `formatAuditRecord` keeps a
// CLOSED action vocabulary (`qzone-audit-offline.mjs:35`), and that file is outside this task's
// inScope, so widening it here is not allowed. The row therefore uses the existing management
// action `restore` and carries an explicit discriminator in `content`:
// `{ intent: 'restore_audit_fault', … }`, so a pause restore and an audit-fault restore are never
// ambiguous in the audit log. Adding the vocabulary entry is a separate, one-line follow-up in a
// file this task must not touch.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const GAP_FIELDS = Object.freeze(['generation', 'key', 'reason', 'resolvedBy', 'time']);
const KNOWN_GATE_FAULTS = Object.freeze(['audit-unavailable']);
const RECOVERY_ACTION = 'restore';

/**
 * Refuse to persist a management row whose `content` would be REDACTED. `formatAuditRecord` swaps
 * sensitive-looking content for `'[REDACTED]'`; silently accepting that would leave a "success"
 * row that no longer says what was recovered, i.e. the evidence R-4 asks for would be gone. Throwing
 * here rolls the transaction back, so the fault is retained instead of being cleared without a trace.
 */
function safeRecord(record) {
  if (formatAuditRecord(record).redacted) throw new Error('unsafe audit content');
  return record;
}

/** Copy `object` without `key`. Works on frozen states, where `delete` would throw. */
function withoutKey(object, key) {
  const copy = {};
  for (const [name, value] of Object.entries(object)) if (name !== key) copy[name] = value;
  return copy;
}

/**
 * ① STRUCTURE — read-only inspection. Returns `{ ok: false, reason }` for anything this function
 * refuses to repair, otherwise `{ ok: true, entries, open, generations, gate, gateFaulting }`.
 */
function readAuditFault(state) {
  // `auditReadable` distinguishes "the audit sink is what failed" from "the audit sink is fine but
  // something ELSE is structurally wrong". It decides whether a refused recovery can leave a trace
  // (R-4) or truly has nowhere to write one.
  const bad = (reason, auditReadable = false) => ({ ok: false, reason, auditReadable });
  if (!isPlain(state) || typeof state.accessPaused !== 'boolean' || typeof state.writePaused !== 'boolean') {
    return bad('invalid-structure');
  }
  // The write gate already owns "is this state readable at all". Reusing it keeps ONE
  // implementation of that judgement instead of a second copy that could drift.
  // `invalid-state` is the only verdict treated as structural here: `write-gate-fault` and
  // `audit-gap-present` ARE the fault this function exists to clear, not structural errors.
  if (checkWriteGate(state).reason === 'invalid-state') return bad('invalid-structure');
  if (!Array.isArray(state.audit)) return bad('invalid-structure');
  const ids = new Set();
  for (const entry of state.audit) {
    if (!isPlain(entry)) return bad('invalid-structure');
    if (typeof entry.id !== 'string' || !SAFE_ID.test(entry.id) || ids.has(entry.id)) return bad('invalid-structure');
    if (!isPlain(entry.record)) return bad('invalid-structure');
    ids.add(entry.id);
  }
  // `settled` IS PART OF "IS THIS STATE REPAIRABLE" (Codex R7 counterexample 2, reproduced in AR-9h).
  //
  // A corrupt `settled` is exactly what latches the mismatch this function is asked to release, so a
  // recovery that does not look at it can "succeed" — clear the latch, clear nothing else — and the
  // next write goes out against a store still unable to settle. Measured: settled remained
  // `'CORRUPT-SETTLED'`, the latch was gone, and `path.write(like)` returned `ok:true`. That is not
  // recovery; it is laundering a fault.
  //
  // So an unreadable `settled` is a STRUCTURAL refusal: nothing is cleared, the corrupt value is
  // preserved verbatim (G-4), and the latch stays. Repairing `settled` itself is a separate operator
  // action this function deliberately does not perform.
  //
  // CHECKED AFTER THE AUDIT ARRAY so `auditReadable: true` is a FACT, not a hope: the audit sink is
  // provably usable, therefore the refusal can and MUST leave a `denied` row (R-4). Verifier t17
  // flagged that a refused recovery used to report `trail: 'not-recorded'` here, leaving no trace at
  // all — an operator would see "the function does not help" with nothing on disk saying why.
  if (state.settled !== undefined && state.settled !== null) {
    if (typeof state.settled !== 'object' || Array.isArray(state.settled)) return bad('settled-corrupt', true);
  }
  const rawGaps = state.auditGaps === undefined ? [] : state.auditGaps;
  if (!Array.isArray(rawGaps)) return bad('invalid-structure');
  const entries = [];
  for (const [index, entry] of rawGaps.entries()) {
    if (!isPlain(entry)) return bad('invalid-structure');
    // Closed field set: an entry carrying anything besides these five is not a gap we can reason
    // about, and `formatAuditGap` would silently DROP the extra field — i.e. destroy it. Refuse.
    if (Object.keys(entry).some((name) => !GAP_FIELDS.includes(name))) return bad('invalid-structure');
    let normalized;
    try {
      const candidate = { key: entry.key, reason: entry.reason, generation: entry.generation, time: entry.time };
      if (entry.resolvedBy !== undefined) candidate.resolvedBy = entry.resolvedBy;
      normalized = formatAuditGap(candidate);
    } catch {
      return bad('invalid-structure');
    }
    entries.push({ index, entry, normalized, open: normalized.resolvedBy === null });
  }
  const open = entries.filter((item) => item.open);
  const generations = [...new Set(open.map((item) => item.normalized.generation))].sort();
  const gate = state.writeGate === undefined ? null : state.writeGate;
  if (gate !== null && gate.fault !== undefined && gate.fault !== null
      && !KNOWN_GATE_FAULTS.includes(gate.fault)) {
    // A fault NAME we do not know is not ours to clear. The gate refuses on it and this function
    // must not turn "an unrecognised fault" into "recovered".
    return bad('unknown-fault');
  }
  const gateFaulting = gate !== null && typeof gate.fault === 'string' && gate.fault.length > 0;
  // WHICH EPISODE RAISED THE GATE? (Codex CODEX-R14-COMBINED-ABA.) A marker written before this field
  // existed has none, and `null` means "unnamed" — usable but not comparable, so the caller falls back
  // to the gap-generation check exactly as before. A NAMED gate, however, may only be cleared by a
  // recovery that names the SAME episode.
  const gateGeneration = gate !== null && typeof gate.generation === 'string' ? gate.generation : null;
  return { ok: true, entries, open, generations, gate, gateFaulting, gateGeneration };
}

/**
 * The audit row's `content` (JSON). Keeps the three things R-1 asks for — generation, operator,
 * result — plus the pre-recovery summary an operator needs to recognise what was cleared, WITHOUT
 * copying any platform payload, gap key or credential.
 */
function recoveryContent(state, view, expectedGeneration, result, extra = {}) {
  const gapReasons = {};
  for (const item of view.entries) {
    const reason = item.normalized.reason;
    gapReasons[reason] = (gapReasons[reason] ?? 0) + 1;
  }
  // "此前暂停原因摘要": the PLATFORM pause as found. It is recorded, never touched (R-2).
  const pauseCauses = {};
  for (const layer of ['access', 'write']) {
    if (state[`${layer}Paused`] === true) pauseCauses[layer] = currentPauseCause(state, layer);
  }
  return {
    intent: 'restore_audit_fault',
    generation: view.generations.length === 1 ? view.generations[0] : null,
    observedGenerations: view.generations,
    expectedGeneration,
    gapCount: view.entries.length,
    openGapCount: view.open.length,
    gapReasons,
    writeGate: view.gate,
    pauseScope: pauseScope(state),
    pauseCauses,
    result,
    ...extra,
  };
}

/**
 * Recover an AUDIT / STORAGE fault (as opposed to a platform pause). Library function: it opens no
 * listener, performs no I/O beyond the store it is handed, and must be called from an already
 * authenticated management entry point (console / the admin script path) — it is not a public
 * bypass and adds no new authenticated surface of its own.
 *
 * @param store - synchronous store with `read`/`update` (one transaction, rollback on throw).
 * @param request - `{ expectedGeneration }`, the generation the operator is looking at. Exact
 *   equality with the OPEN gaps' single generation is mandatory (see "GENERATION SEMANTICS").
 * @param actor - `{ operator, source, target, time, auditId, correlationId? }` from the
 *   authenticated caller. `source` must be `admin_console` or `admin_script` (same rule
 *   `formatAuditRecord` applies to every management action).
 * @returns `{ ok: true, generation, expectedGeneration, resolvedGapCount, auditId, result }` on
 *   recovery, or `{ ok: false, reason, expectedGeneration, observedGenerations, resolvedGapCount,
 *   trail }` for a business refusal — `trail: 'recorded'` means a `denied` audit row was written
 *   (R-4), `'not-recorded'` means ① failed and the audit sink itself is unreadable.
 * @throws {TypeError} programmer errors (bad store / request / actor) and any audit-write, commit
 *   or post-condition failure: those roll the transaction back, so the fault is retained.
 */
export function restoreOfflineAuditFault(store, request, actor) {
  if (!store || typeof store.update !== 'function') throw new TypeError('invalid audit recovery store');
  // An unbound handle cannot name a send authority, so it could not release a process-local latch
  // even if it succeeded. Refuse at construction rather than half-recover.
  requireAuthority(store, 'audit fault recovery');
  if (!isPlain(request) || Object.keys(request).some((key) => key !== 'expectedGeneration' && key !== 'expectedLatchRevision')) {
    throw new TypeError('invalid audit recovery request');
  }
  const { expectedGeneration, expectedLatchRevision } = request;
  if (typeof expectedGeneration !== 'string' || !SAFE_ID.test(expectedGeneration)) throw new TypeError('invalid expected generation');
  if (expectedLatchRevision !== undefined
      && (!Number.isSafeInteger(expectedLatchRevision) || expectedLatchRevision < 1)) {
    throw new TypeError('invalid expected latch revision');
  }
  if (!isPlain(actor)) throw new TypeError('invalid management actor');
  const { operator, source, target, time, auditId, correlationId } = actor;
  if (typeof operator !== 'string' || !SAFE_ID.test(operator) ||
      !['admin_console', 'admin_script'].includes(source) ||
      typeof target !== 'string' || !/^\d{1,20}$/.test(target) ||
      !Number.isSafeInteger(time) || time < 0 ||
      typeof auditId !== 'string' || !SAFE_ID.test(auditId) ||
      ['__proto__', 'constructor', 'prototype'].includes(auditId) ||
      (correlationId !== undefined && (typeof correlationId !== 'string' || !SAFE_ID.test(correlationId) ||
        ['__proto__', 'constructor', 'prototype'].includes(correlationId)))) {
    throw new TypeError('invalid management actor');
  }

  // A PROCESS-LOCAL LATCH IS A FAULT WITH NO GAP (measured: a settlement whose transaction fails
  // rolls back before it can record one). Recovery must cover it, or the only way out is the test
  // escape hatch — which is not an operator path.
  //
  // THE OPTIMISTIC LOCK IS THE LATCH **REVISION**, NOT THE REASON. (Codex R7 counterexample 3,
  // reproduced in `AR-9g`.) Comparing reasons cannot tell an OLD fault from a NEW one when the reason
  // repeats — and `latchFault` keeps the first reason, so a second, different fault did not even change
  // the string. Measured: latch 'old-fault'; a new 'new-fault' arrives while the recovery is committing;
  // the recovery still returned `ok:true, latch:null`, erasing the newer fault. `revision` is monotonic
  // per authority, so naming it pins exactly the event the operator saw.
  // "The caller named a latch revision" is NOT the same as "this is a latch-only situation"
  // (Codex CODEX-R19-MIXED-RECOVERY-20261114). The state decides that, further down, once it has been
  // read. Keeping the two ideas apart is the whole fix.
  const latched = readFaultLatch(store);
  const latchRequested = latched !== null && expectedLatchRevision !== undefined;
  if (expectedLatchRevision !== undefined && latched === null) {
    return Object.freeze({
      ok: false, reason: 'no-latch', expectedGeneration,
      observedGenerations: null, resolvedGapCount: 0, trail: 'not-recorded',
    });
  }
  if (expectedLatchRevision !== undefined && latched !== null && latched.revision !== expectedLatchRevision) {
    return Object.freeze({
      ok: false, reason: 'latch-revision-mismatch', expectedGeneration, expectedLatchRevision,
      observedLatchRevision: latched.revision, observedLatchReason: latched.reason,
      observedGenerations: null, resolvedGapCount: 0, trail: 'not-recorded',
    });
  }

  let outcome;
  store.update((state) => {
    // ── ① STRUCTURE ──────────────────────────────────────────────────────────────────────────
    const view = readAuditFault(state);
    if (!view.ok) {
      // Unreadable state is not "repaired" and not guessed at.
      //
      // BUT IF THE AUDIT SINK ITSELF IS READABLE, THE REFUSAL MUST LEAVE A TRACE (verifier t17).
      // `settled-corrupt` is the case that matters: the audit array is fine, so there is somewhere to
      // write, and an operator needs the row to learn WHY recovery refused. Leaving `not-recorded`
      // here meant the two most common refusals were indistinguishable from "nowhere to write".
      if (view.auditReadable === true) {
        let next = state;
        const txn = { update(fn) { next = fn(next); } };
        const record = {
          time, source, action: RECOVERY_ACTION, target, operator, pauseScope: pauseScope(state),
          reason: '',
          content: JSON.stringify({
            intent: 'restore_audit_fault',
            expectedGeneration,
            expectedLatchRevision: expectedLatchRevision ?? null,
            structuralRefusal: view.reason,
            result: 'denied',
            ...(correlationId === undefined ? {} : { correlationId }),
          }),
          result: 'denied',
        };
        if (!appendOfflineAudit(txn, auditId, safeRecord(record)).appended) throw new Error('duplicate audit id');
        outcome = Object.freeze({
          ok: false, reason: view.reason, expectedGeneration,
          observedGenerations: null, resolvedGapCount: 0, trail: 'recorded',
        });
        return next;
      }
      outcome = Object.freeze({
        ok: false, reason: view.reason, expectedGeneration,
        observedGenerations: null, resolvedGapCount: 0, trail: 'not-recorded',
      });
      return state;
    }

    // ── ② GENERATION ─────────────────────────────────────────────────────────────────────────
    // A latch-only recovery has no gap to key on, so the generation check does not apply; the
    // optimistic lock is `expectedLatchReason`, already verified before the transaction.
    // A GATE BELONGS TO AN EPISODE, AND AN OLD GAP MUST NOT CLEAR A NEWER ONE (Codex
    // CODEX-R14-COMBINED-ABA). Measured before this check: an OPEN gap from G1 plus a gate raised by a
    // later G2 episode → `ok:true`, gate dropped, `gateAfter:"allowed"` — an unrelated old gap
    // "recovered" a fault it never addressed. The check sits FIRST because it is the coarse one: if the
    // persisted marker names a different episode, no amount of gap bookkeeping makes this recovery
    // about that fault.
    // ── ②-a MIXED STATE IS NOT A LATCH-ONLY STATE (Codex CODEX-R19-MIXED-RECOVERY-20261114) ──
    //
    // MEASURED DEFECT THIS REPLACES. `latchOnly` used to be computed from the IN-MEMORY latch alone,
    // so any request that named a latch revision skipped the persisted-gate generation check entirely.
    // Codex built a state that needs recovery on TWO layers at once — `writeGate` named G2 plus a real
    // `latchFault` — and called recovery with `expectedGeneration: G1` (≠G2) + the CORRECT latch
    // revision. Measured: `{restoreOk:true, gateAfter:null, latchAfter:null, writeOk:true, sent:1}`.
    // A memory latch laundered a persistent gate fault of a DIFFERENT generation, and the write went out.
    //
    // The rule now: the latch shortcut applies ONLY when the persisted state really has nothing else to
    // recover. If a gate or an unresolved gap is present, each layer must satisfy its own constraint and
    // the latch merely becomes one more thing this request covers — never a way around the others.
    // "Cannot say how it maps" is answered by refusing and PRESERVING, not by clearing everything.
    const persistentFaultPresent = view.gateFaulting || view.open.length > 0;
    const latchOnly = latchRequested && !persistentFaultPresent;
    const denial = latchOnly ? null
      : (view.gateFaulting && view.gateGeneration !== null && view.gateGeneration !== expectedGeneration)
        ? 'gate-generation-mismatch'
        : view.open.length === 0 ? 'no-open-gap'
          : view.generations.length > 1 ? 'multiple-generations'
            : view.generations[0] !== expectedGeneration ? 'generation-mismatch'
              : null;
    if (denial !== null) {
      // R-4: a business refusal is evidence too. ① proved the audit sink readable, so the refusal
      // row is appended HERE, in the same transaction, and the fault is left untouched — the
      // returned state differs from `state` only by that one audit row.
      let next = state;
      const txn = { update(fn) { next = fn(next); } };
      const record = {
        time, source, action: RECOVERY_ACTION, target, operator, pauseScope: pauseScope(state),
        reason: '',
        content: JSON.stringify(recoveryContent(state, view, expectedGeneration, 'denied',
          { denial, ...(correlationId === undefined ? {} : { correlationId }) })),
        result: 'denied',
      };
      if (!appendOfflineAudit(txn, auditId, safeRecord(record)).appended) throw new Error('duplicate audit id');
      outcome = Object.freeze({
        ok: false, reason: denial, expectedGeneration,
        observedGenerations: view.generations, resolvedGapCount: 0, trail: 'recorded',
      });
      return next;
    }

    // ── ③ AUDIT FIRST (nothing has been cleared yet) ─────────────────────────────────────────
    const generation = latchOnly ? null : view.generations[0];
    let next = state;
    const txn = { update(fn) { next = fn(next); } };
    const record = {
      time, source, action: RECOVERY_ACTION, target, operator, pauseScope: pauseScope(state),
      reason: '',
      content: JSON.stringify(recoveryContent(state, view, expectedGeneration, 'success', {
        resolvedGapCount: view.open.length,
        ...(latchRequested ? { releasedLatch: { reason: latched.reason, revision: latched.revision } } : {}),
        ...(correlationId === undefined ? {} : { correlationId }),
      })),
      result: 'success',
    };
    if (!appendOfflineAudit(txn, auditId, record).appended) throw new Error('duplicate audit id');

    // ── ④ CLEAR — only now that the audit row is part of the state being committed ───────────
    const marker = { generation, at: time, operator };
    const resolvedByIndex = new Map();
    for (const item of view.open) {
      resolvedByIndex.set(item.index, formatAuditGap({
        key: item.normalized.key, reason: item.normalized.reason,
        generation: item.normalized.generation, time: item.normalized.time, resolvedBy: marker,
      }));
    }
    const gaps = (state.auditGaps ?? []).map((entry, index) => resolvedByIndex.get(index) ?? entry);
    let cleared = { ...next, auditGaps: gaps };
    // Absent and `null` mean the same thing to the gate; the key is dropped so a fully recovered
    // store looks like one that never faulted. The cleared marker itself is preserved verbatim in
    // the audit row's `content.writeGate`, so removing it here does not remove the evidence.
    if (view.gateFaulting) cleared = withoutKey(cleared, 'writeGate');
    // Self-check before commit: the state we are about to write must pass the ONE gate. If it does
    // not, this throws and the transaction rolls back rather than committing a half-clear.
    if (!checkWriteGate(cleared).allowed) throw new Error('audit fault recovery would not clear the gate');
    // ── ⑤ RELEASE THE PROCESS LATCH — LAST, after the commit-bound state is provably clean ────
    //
    // Deliberately OUTSIDE the transaction callback's own state: the latch is process memory, not
    // state. It is released here, not earlier, so a throw above still leaves the fault latched (a
    // failed recovery must not unlock sending). If the transaction itself later fails to commit,
    // `store.update` throws and the caller sees the failure — but the latch would already be gone, so
    // the release happens AFTER `store.update` returns, below.
    outcome = Object.freeze({
      ok: true, generation, expectedGeneration,
      resolvedGapCount: view.open.length, auditId, result: 'success',
      releasedLatch: latchRequested ? { reason: latched.reason, revision: latched.revision } : null,
    });
    return cleared;
  });
  // Only reached on a COMMITTED transaction: `store.update` threw otherwise.
  //
  // AND ONLY IF THE FAULT IS STILL THE ONE THAT WAS INSPECTED. `clearFaultLatchIfRevision` is a
  // compare-and-clear: a fault that arrived between the precondition check and this commit (Codex R7
  // counterexample 3) has a HIGHER revision and therefore survives — it is NOT erased by a recovery
  // that only ever saw the older one.
  if (outcome.ok === true && outcome.releasedLatch !== null) {
    const clearing = clearFaultLatchIfRevision(store, outcome.releasedLatch.revision);
    if (clearing.cleared !== true) {
      // The recovery itself is committed (its audit row is durable), but the latch belongs to a newer
      // fault now. Say so instead of reporting a clean release.
      outcome = Object.freeze({
        ...outcome,
        releasedLatch: null,
        latchRetained: Object.freeze({
          requestedRevision: outcome.releasedLatch.revision,
          current: clearing.current,
        }),
      });
    }
  }
  return outcome;
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// ⛔ NOT APPROVED — OFFLINE EXPERIMENT ONLY. NOT WIRED. NOT VERIFIED. DO NOT USE.
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// Codex rejected this function as a fix (CODEX-R30-UNAPPROVED-REPAIR-20261114), and the rejection is
// correct. It stays in the tree only so the difference is visible and reviewable; it must not be called
// by anything, and it must not be cited as evidence that the "受控修复流程未实现" gap is closed.
//
// WHY IT IS WRONG — a measured counterexample, not a style objection:
//
//   1) real `record()`, same legal request + FAILED result  -> recorded, writes = 1, settled key written
//   2) corrupt `settled` -> same record is correctly rolled back AND latched
//   3) this function -> ok:true, `settled` becomes {}
//   4) real `record()` again with the SAME clock -> recorded:true, alreadySettled:false, writes = 2
//
// THE KEY IS THE IDEMPOTENCY IDENTITY. Clearing `settled` does not "forget an unreadable record", it
// makes an ALREADY-SETTLED delivery look unsettled, so replaying it advances the breaker a second time.
// Archiving the corrupt bytes is a separate problem from restoring the anti-replay property: evidence
// in an audit row does NOT make the old identity recognisable again.
//
// So this is NOT a structural fix that preserves prior semantics — it is a POLICY CHANGE (discard
// idempotency history, then allow settling again), which is exactly what this round was told NOT to do.
//
// A real repair would have to answer one of two questions FIRST, and neither is answered here:
//   · what trustworthy backup/reconstruction source can re-establish the old identities? or
//   · how do the OLD identities keep being refused while new ones are accepted?
// Clearing + self-auditing cannot prove safety on its own.
//
// KEEP AS-IS: do not delete this file, do not revert the whole module, do not "fix" it into shape.
// The difference is preserved deliberately as an unapproved experiment.
// ════════════════════════════════════════════════════════════════════════════════════════════
// M11 · (rejected) CONTROLLED REPAIR OF A CORRUPT settled RECORD (§5.3)
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS (measured, not hypothetical)
// --------------------------------------------
// A corrupt settled value is fail-closed EVERYWHERE, by design: the settlement path refuses to
// advance idempotency state, so a real failure is never double-counted. The cost is that the ONLY
// way out was to edit the database by hand -- "受控修复流程未实现" was recorded as a known gap for
// many rounds, and t17 named it a blocker because an operator looking at a latched process had no
// supported move. This adds the smallest supported move, and NOTHING wider.
//
// WHAT IT DOES NOT DO
// -------------------
// It does NOT decide the corruption is harmless, does NOT delete it, and does NOT touch the quota
// ledger, the breaker counters, auditGaps, writeGate, or either pause layer. It archives the corrupt
// value VERBATIM into the operation audit trail, replaces the field with an EMPTY map, and does both
// inside ONE transaction. The corrupt text stays readable as evidence in the audit row.
//
// WHY AN EMPTY MAP, AND NOT undefined
// -----------------------------------
// undefined/null mean "never written". After a corrupt value was found, claiming "never written" is
// FALSE -- something WAS written and it was unreadable. An empty object says the true thing: we hold
// no trustworthy records. It also keeps the field's shape stable so the next settlement does not
// have to re-distinguish absent-vs-corrupt for a value this function just replaced.
//
// WHY A SEPARATE FUNCTION (and not a branch of restoreOfflineAuditFault)
// ---------------------------------------------------------------------
// Clearing an idempotency record is not clearing a write gate and not clearing a gap. §5.1 already
// made that split for the audit fault; the same reasoning applies here, and keeping them separate
// means neither can clear the other as a side effect.
export function restoreOfflineSettledCorruption(store, request, actor) {
  // ⛔ REJECTED — see the block comment above. This exists as a recorded unapproved experiment only.
  // It re-opens the G1 idempotency gap (measured: writes 1 -> 2 on a replayed old settlement) and is
  // NOT a supported operator path. Nothing in this repository may call it.
  if (!store || typeof store.update !== 'function') throw new TypeError('invalid settled repair store');
  requireAuthority(store, 'settled corruption repair');
  if (!isPlain(request) || Object.keys(request).some((key) => key !== 'expectedLatchRevision')) {
    throw new TypeError('invalid settled repair request');
  }
  const { expectedLatchRevision } = request;
  if (expectedLatchRevision !== undefined
      && (!Number.isSafeInteger(expectedLatchRevision) || expectedLatchRevision < 1)) {
    throw new TypeError('invalid expected latch revision');
  }
  if (!isPlain(actor)) throw new TypeError('invalid management actor');
  const { operator, source, target, time, auditId, correlationId } = actor;
  if (typeof operator !== 'string' || !SAFE_ID.test(operator) ||
      !['admin_console', 'admin_script'].includes(source) ||
      typeof target !== 'string' || !/^\d{1,20}$/.test(target) ||
      !Number.isSafeInteger(time) || time < 0 ||
      typeof auditId !== 'string' || !SAFE_ID.test(auditId) ||
      ['__proto__', 'constructor', 'prototype'].includes(auditId) ||
      (correlationId !== undefined && (typeof correlationId !== 'string' || !SAFE_ID.test(correlationId) ||
        ['__proto__', 'constructor', 'prototype'].includes(correlationId)))) {
    throw new TypeError('invalid management actor');
  }

  // A corrupt settled normally latches the authority, so the operator's view of that latch is the only
  // thing tying this repair to the fault they inspected. Supplying it makes the repair an optimistic
  // lock: a fault that arrived since the screen was read survives (same rule as M9).
  const latched = readFaultLatch(store);
  if (expectedLatchRevision !== undefined && latched === null) {
    return Object.freeze({
      ok: false, reason: 'no-latch', expectedLatchRevision,
      repaired: false, corruptLength: 0, trail: 'not-recorded',
    });
  }
  if (expectedLatchRevision !== undefined && latched !== null && latched.revision !== expectedLatchRevision) {
    return Object.freeze({
      ok: false, reason: 'latch-revision-mismatch', expectedLatchRevision,
      observedLatchRevision: latched.revision, observedLatchReason: latched.reason,
      repaired: false, corruptLength: 0, trail: 'not-recorded',
    });
  }

  let outcome;
  store.update((state) => {
    // ── (1) STRUCTURE — evidence first, nothing guessed ──────────────────────────────────────
    const rawSettled = state.settled;
    const corrupt = rawSettled !== undefined && rawSettled !== null
      && (typeof rawSettled !== 'object' || Array.isArray(rawSettled));
    if (!corrupt) {
      // Not corrupt -> this function has NOTHING to do. It must not "normalise" a healthy map, an
      // absent field, or a null: those are legitimate states only the settlement path may change.
      // Refusing here is what keeps this from becoming a general-purpose settled rewriter.
      outcome = Object.freeze({
        ok: false, reason: 'settled-not-corrupt', repaired: false,
        settledShape: rawSettled === undefined ? 'absent'
          : rawSettled === null ? 'null'
            : Array.isArray(rawSettled) ? 'array' : typeof rawSettled,
        corruptLength: 0, trail: 'not-recorded',
      });
      return state;
    }
    if (!Array.isArray(state.audit)) {
      // No readable audit sink -> the archive row cannot be written -> refuse and PRESERVE. A repair
      // that loses the evidence is worse than the corruption.
      outcome = Object.freeze({
        ok: false, reason: 'audit-unreadable', repaired: false,
        corruptLength: 0, trail: 'not-recorded',
      });
      return state;
    }

    // ── (2) THE CORRUPT VALUE ITSELF BECOMES THE RECORD ─────────────────────────────────────
    // Serialised here, not referenced: the caller must be able to read the original bytes from the
    // audit row long after the live field has been replaced.
    let evidence;
    try { evidence = JSON.stringify(rawSettled); } catch { evidence = null; }
    if (typeof evidence !== 'string') evidence = String(rawSettled);

    let next = state;
    const txn = { update(fn) { next = fn(next); } };
    const baseContent = {
      intent: 'repair_settled_corruption',
      settledShape: Array.isArray(rawSettled) ? 'array' : typeof rawSettled,
      ...(expectedLatchRevision === undefined ? {} : { expectedLatchRevision }),
      ...(correlationId === undefined ? {} : { correlationId }),
    };
    const record = {
      time, source, action: RECOVERY_ACTION, target, operator, pauseScope: pauseScope(state),
      reason: '',
      content: JSON.stringify({ ...baseContent, settledEvidence: evidence }),
      result: 'success',
    };
    // The corrupt text goes into the row ONLY if the redactor would not blank the whole content --
    // formatAuditRecord replaces content matching SENSITIVE WHOLESALE, which would destroy the very
    // evidence this row exists for. Refuse rather than silently archive "[REDACTED]".
    if (formatAuditRecord(record).redacted) {
      outcome = Object.freeze({
        ok: false, reason: 'evidence-would-be-redacted', repaired: false,
        corruptLength: evidence.length, trail: 'not-recorded',
      });
      return state;
    }
    if (!appendOfflineAudit(txn, auditId, record).appended) throw new Error('duplicate audit id');

    // ── (3) REPLACE, and only now ───────────────────────────────────────────────────────────
    const repaired = { ...next, settled: {} };
    outcome = Object.freeze({
      ok: true, repaired: true, result: 'success', auditId,
      corruptLength: evidence.length,
      settledShape: baseContent.settledShape,
      trail: 'recorded',
      releasedLatch: latched === null ? null : { reason: latched.reason, revision: latched.revision },
    });
    return repaired;
  });
  // Only reached on a COMMITTED transaction. Release the latch ONLY for the revision inspected.
  if (outcome.ok === true && outcome.releasedLatch !== null) {
    const clearing = clearFaultLatchIfRevision(store, outcome.releasedLatch.revision);
    if (clearing.cleared !== true) {
      outcome = Object.freeze({
        ...outcome,
        releasedLatch: null,
        latchRetained: Object.freeze({
          requestedRevision: outcome.releasedLatch.revision,
          current: clearing.current,
        }),
      });
    }
  }
  return outcome;
}
