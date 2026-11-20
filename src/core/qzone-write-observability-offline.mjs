// Offline OBSERVABILITY for the write path: audit row + two-layer circuit breaker, composed from
// the reviewed modules that already exist.
//
// WHY THIS MODULE EXISTS
// ----------------------
// The write path (`qzone-write-path-offline.mjs`) deliberately does ONE job: reserve atomically, then
// call the transport. It writes no audit row and counts no failures — its header says so explicitly.
// Two reviewed pieces already implement those jobs, but nothing connected them to a write result:
//
//   · `qzone-audit-offline.mjs`   `formatAuditRecord` (strict validation + `SENSITIVE` redaction)
//                                 `appendOfflineAudit` (append one row to the store)
//   · `qzone-policy-offline.mjs`  `nextFailureState(state, direction, outcome)` (the breaker state
//                                 machine) — measured: `not_accessible` bumps NOTHING, `failure`
//                                 pauses at 3, `login_expired`/`captcha`/`network_unavailable` pause
//                                 IMMEDIATELY, `success` resets that direction's counter.
//
// This module is the missing adapter: it maps ONE write-path result onto exactly one audit row and
// at most one breaker transition. It re-implements NEITHER the redaction NOR the breaker arithmetic.
//
// ORDER, AND WHERE THE ATOMICITY BOUNDARY IS (t33 / G3 — corrected)
// -----------------------------------------------------------------
//   1. reserve (quota + interval + like de-dup + id reservation)  — ONE `store.update`, atomic
//   2. transport (exactly once)                                   — the irreversible step
//   3. breaker transition + audit append                          — ONE `store.update` (DEFAULT path)
//
// G3 closed a real state-drift window: steps 3 and 4 used to be TWO separate transactions, so a crash
// between them left `writes` advanced with no audit row (and, in the mirror case, an audit row with
// the breaker NOT advanced — the worse one, because a missed count means a pause that never fires).
// The default path now performs BOTH inside a single `store.update`, in the order breaker-then-audit.
// If the audit half throws, the transaction ROLLS BACK and the breaker rolls back with it. That is
// exactly what G3 asked for: they live and die together.
//
// The one deliberately NON-atomic path: when the caller injects a DIFFERENT `auditStore`. That seam
// exists so "the audit alone failed" can be injected and observed; forcing atomicity there would
// delete the only way to test that failure mode. It is therefore kept, and every result now carries
// `atomic: true|false` so a caller can never be in doubt about which contract it got.
//
// Still NOT atomic with the reservation (step 1). The audit row must carry the OUTCOME, which does not
// exist until the transport returns; nothing here pretends otherwise.
//
// CONSEQUENCES, STATED PLAINLY
// ----------------------------
//   (a) ATOMIC PATH (default): any throw — breaker arithmetic, `formatAuditRecord` validation, an
//       `invalid audit state`, or an id conflict — rolls the WHOLE thing back. Nothing drifts. The
//       caller learns which half threw via `audit.failed` / `breaker.failed`, but neither was written.
//   (b) NON-ATOMIC PATH (`auditStore` injected): old behaviour, honestly labelled `atomic:false`.
//       A failed audit leaves the breaker advanced; a failed breaker write leaves the audit written.
//       Nothing is repaired, retried or compensated — the split is reported, never hidden.
//
// MAPPING (task card, verbatim)
// -----------------------------
//   ok:true  outcome:'success'                 -> audit result:'success'  | breaker write: success
//   ok:true  outcome:'failed'                  -> audit result:'failure'  | breaker write: failure
//   ok:true  outcome:'unknown'                 -> audit result:'unknown'  | breaker: NOT a real failure
//   ok:true  outcome:'not-sent'                -> audit result:'unknown'  | breaker: not a failure
//   ok:false stage:'reserve'                   -> audit result:'denied'   | breaker: untouched
//   ok:false stage:'transport' 'paused-before-send'
//                                              -> audit result:'unknown'  | breaker: untouched
//
// The `unknown` decision is the one worth arguing: the task card says `writePaused` is driven by
// "three consecutive REAL failures". An unknown outcome means "it was sent and we do not know" — the
// quota is conservatively spent (see the write-path header), but counting it as a real failure would
// pause writes on the strength of an outcome we explicitly could not classify. Those are different
// questions and this module keeps them apart: `unknown` occupies quota, and occupies NO failure slot.
//
// WHAT THIS MODULE IS NOT
// -----------------------
//   · NOT production wiring: `src/bridge.js` and `plugins/qzone-safe/**` reference it zero times.
//   · NOT a substitute for a trusted settlement event. See the "REAL BLOCKERS" note at the bottom.
//   · NOT atomic with the reservation. See the order section above.
//
// `settled` GROWTH — BOUNDED BY NOTHING
// -------------------------------------
// `state.settled` keeps ONE entry per settle identity and has NO TTL, NO prune, NO eviction.
// Measured: 200 distinct settlements -> 200 keys. Its growth is the same ORDER as the `audit`
// array (also one row per operation, also unbounded), so this is not a new class of growth —
// but it was previously undeclared.
//
// Do NOT add a TTL as a quick fix: an expired entry means the same settle identity can be
// counted a SECOND time, silently reopening the double-counting hole G1 closed. Any compaction
// must first answer "what happens to a repeat that arrives after the entry is gone", and that
// answer is a product decision, not a cleanup detail.
//
// `settled` KEYS DEPEND ON FIELD ORDER — DO NOT REORDER `formatAuditRecord`
// ------------------------------------------------------------------------
// `settleKeyFor()` is `sha256(JSON.stringify(formatAuditRecord(...)))`, and `JSON.stringify`
// serialises objects in PROPERTY INSERTION ORDER. The settled key therefore depends on the
// literal field order inside `formatAuditRecord`. Reordering/renaming/adding a field there
// invalidates EVERY historical settled key at once: old keys stop matching any new settlement,
// cross-restart idempotency silently returns to zero, and G1 degrades back to unfixed —
// with no error and no warning. The guard is `AT-16` in
// `scripts/test-qzone-write-observability-atomic.mjs`; if it goes red, migrate the stored keys
// in the same change rather than editing the expected order.

import { createHash } from 'node:crypto';

import { formatAuditGap, appendOfflineAudit, formatAuditRecord } from './qzone-audit-offline.mjs';
import { nextFailureState } from './qzone-policy-offline.mjs';
import { latchFault } from './qzone-write-path-offline.mjs';
import { requireAuthority, resolveAuthority } from './qzone-authority-shared.mjs';

/** Audit `result` values this adapter can emit (subset of the audit module's RESULTS set). */
export const OBSERVED_RESULT = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
  UNKNOWN: 'unknown',
  DENIED: 'denied',
});

/**
 * Map a write-path result onto (audit result, breaker direction+outcome).
 *
 * Exported for the tests: the mapping is the heart of this module and should be assertable without
 * driving a whole store.
 *
 * @returns {{auditResult: string, breakerOutcome: string|null, breakerDirection: 'write'|null}}
 *   `breakerOutcome === null` means "do not touch the breaker at all".
 */
export function mapWriteResult(result) {
  if (!result || typeof result !== 'object') {
    // An unrecognisable result cannot be classified. Treat it as unknown: it may have been sent.
    return Object.freeze({ auditResult: OBSERVED_RESULT.UNKNOWN, breakerDirection: 'write', breakerOutcome: null });
  }

  // Refused before anything was sent.
  if (result.ok === false && result.stage === 'reserve') {
    return Object.freeze({ auditResult: OBSERVED_RESULT.DENIED, breakerDirection: 'write', breakerOutcome: null });
  }

  // Reserved but deliberately NOT sent (final pause check). Quota is spent, nothing left the process,
  // and it is not a platform failure — so: audit `unknown` (conservative, matches the spent quota),
  // breaker untouched (no real failure occurred).
  if (result.ok === false && result.stage === 'transport' && result.reason === 'paused-before-send') {
    return Object.freeze({ auditResult: OBSERVED_RESULT.UNKNOWN, breakerDirection: 'write', breakerOutcome: null });
  }

  // Anything else that is not ok and did not come from the reserve stage: the transport was involved.
  // Only `paused-before-send` is a provable "not sent"; every other shape may have reached the
  // platform, so it occupies quota and must not be counted as a real failure.
  if (result.ok !== true) {
    return Object.freeze({ auditResult: OBSERVED_RESULT.UNKNOWN, breakerDirection: 'write', breakerOutcome: null });
  }

  switch (result.outcome) {
    case 'success':
      return Object.freeze({ auditResult: OBSERVED_RESULT.SUCCESS, breakerDirection: 'write', breakerOutcome: 'success' });
    case 'failed':
      // A DEFINITE platform failure: the call went out and the platform said no. This is the only
      // shape that feeds the "three consecutive real failures" rule.
      return Object.freeze({ auditResult: OBSERVED_RESULT.FAILURE, breakerDirection: 'write', breakerOutcome: 'failure' });
    case 'unknown':
    case 'not-sent':
      return Object.freeze({ auditResult: OBSERVED_RESULT.UNKNOWN, breakerDirection: 'write', breakerOutcome: null });
    default:
      return Object.freeze({ auditResult: OBSERVED_RESULT.UNKNOWN, breakerDirection: 'write', breakerOutcome: null });
  }
}

/**
 * Identity of ONE settlement, used as the idempotency key (G1) — and, since M7, also the stable
 * `key` of the audit-gap entry when the audit half cannot be written.
 *
 * `request.id` alone is NOT the right key. Two settlements of the same id carrying DIFFERENT content
 * are not a repeat — they are a contradiction, and the audit half must be allowed to see them and
 * report a conflict (G2) instead of one being silently swallowed as "already settled". Including a
 * digest of the normalised record makes the two cases separable:
 *
 *   same id + same record   -> same key  -> `alreadySettled`, nothing touched
 *   same id + other record  -> other key -> falls through, audit detects the conflict and reports it
 *
 * ── WHY `time` IS EXCLUDED FROM THE DIGEST (M7 fix, measured) ──
 * The digest used to cover the WHOLE formatted record, `time` included, and `time` comes from
 * `clock()`. Measured consequence with a real store: settle once at `T`, retry the same logical
 * settlement at `T+5s`, and the digest differs — so the second call MISSED the `alreadySettled`
 * short-circuit, fell through to the audit half, and the id-based duplicate check then reported
 * `conflicting audit id`. One retry of one settlement looked like a data contradiction.
 *
 * The breaker count still came out right in that particular probe (the boolean-failure path is
 * `Math.min(3, n+1)`, and the throw rolled the whole thing back), which is exactly why this was
 * dangerous: the double-count was masked by a rollback that ALSO threw away the audit row. Under the
 * M7 rules below — where an audit-side failure no longer rolls the breaker back — the same clock
 * sensitivity would have produced a real second increment.
 *
 * So the key now covers everything that identifies the OPERATION (id, source, action, target, postId,
 * commentId, content, redacted, result, reason, quota) and excludes the one field that is merely WHEN
 * we noticed it. A retry is the same settlement regardless of when it is retried.
 *
 * ⚠️ THIS IS A KEY-SCHEMA CHANGE. Every `settled` key already on disk was minted under the old
 * digest and will no longer match. In the offline sample there is no such data. A production rollout
 * MUST either (a) rebuild `settled` from `audit` at startup, or (b) run one release where both keys
 * are accepted. Do not ship this without one of those.
 *
 * ⚠️ AND THE ORDER SENSITIVITY REMAINS. `JSON.stringify` emits properties in INSERTION order, so the
 * remaining fields still depend on `formatAuditRecord` building its object in a fixed order. See the
 * "`settled` KEYS DEPEND ON FIELD ORDER" section in the module header and the `AT-16` guard.
 */
const SETTLE_KEY_EXCLUDED = new Set(['time']);

function settleKeyFor(id, formatted) {
  const stable = {};
  for (const key of Object.keys(formatted)) {
    if (!SETTLE_KEY_EXCLUDED.has(key)) stable[key] = formatted[key];
  }
  const digest = createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32);
  return `${id}#${digest}`;
}

/** The stable per-settlement generation id used when a gap has to be recorded. Clock-free. */
function gapGenerationFor(settleKey) {
  // `settleKey` is `<id>#<32 hex>`; reuse the digest so the gap points at the SAME settlement.
  const digest = settleKey.slice(settleKey.indexOf('#') + 1);
  return `g${digest.slice(0, 24)}`;
}

/**
 * Build the observable description of an audit-id collision (G2).
 *
 * Before this existed the adapter reported only `failed:true`, so an operator could not tell "this id
 * was already used with different content" (a caller bug, worth a fix) from "the audit store is
 * broken" (an infrastructure incident). They call for opposite responses, so they are now different
 * shapes: a `conflict` object for the first, a plain `error` for the second.
 */
function describeConflict(existingRecord, incomingRecord) {
  // `content` here is whatever `formatAuditRecord` already decided — if it was sensitive it is
  // already the placeholder, and this function neither re-derives nor re-checks that. Copying the
  // value verbatim (rather than special-casing the placeholder) keeps the redaction logic in the ONE
  // place that owns it.
  const summarise = (record) => ({
    result: record?.result ?? null,
    content: typeof record?.content === 'string' ? record.content : null,
    redacted: record?.redacted === true,
    time: Number.isFinite(record?.time) ? record.time : null,
  });
  return Object.freeze({
    reason: 'conflicting-audit-id',
    existing: Object.freeze(summarise(existingRecord)),
    incoming: Object.freeze(summarise(incomingRecord)),
  });
}

/**
 * Build the observability adapter.
 *
 * @param store - the SAME offline store the write path uses (audit array + breaker counters live at
 *   the top level next to `ledger`).
 * @param clock - `() => trusted millisecond timestamp`, used for the audit row's `time`.
 */
export function createWriteObservability({ store, auditStore, clock } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('write observability needs a store with read/update');
  }
  // CONSTRUCTION-TIME REFUSAL (R6). If this handle cannot name its send authority, a fault latched
  // through it lands on an authority the write path never consults — measured: the write still went
  // out. Refuse at construction rather than latch something useless.
  requireAuthority(store, 'write observability');
  // `auditStore` defaults to the same store. It exists as a separate seam so an audit-specific
  // failure can be injected (and observed) without making the breaker write look like the culprit.
  const writeAudit = auditStore ?? store;
  if (typeof writeAudit.read !== 'function' || typeof writeAudit.update !== 'function') {
    throw new TypeError('write observability auditStore needs read/update');
  }
  // The audit sink is only written to, never used as an identity, so it does NOT need an authority —
  // an injected `{update}` sink is legitimate.
  if (typeof clock !== 'function') throw new TypeError('write observability needs a clock()');

  return Object.freeze({
    /**
     * Record ONE write-path result: one audit row, at most one breaker transition.
     *
     * @param request - the original write request (`{ id, action, target, postId, source, content }`)
     * @param result  - what `write()` returned
     * @param outcomeOverride - ONLY for the read direction (see `recordRead`); ignored for writes.
     *
     * @returns
     *   { recorded: boolean, audit: {appended, redacted, failed, error?},
     *     breaker: {reads, writes, accessPaused, writePaused, applied, skippedReason, failed, error?} }
     */
    record({ request, result } = {}) {
      const mapping = mapWriteResult(result);
      const now = clock();
      const req = request ?? {};

      // The audit input is built ONCE and normalised by the PURE `formatAuditRecord` before any
      // transaction opens. Doing the validation up front means a malformed audit input can never be
      // half-applied: it throws here, before the breaker has moved anywhere.
      const auditInput = {
        time: now,
        source: req.source ?? 'qq',
        action: req.action,
        target: String(req.target ?? ''),
        postId: req.postId ?? null,
        content: req.content ?? '',
        result: mapping.auditResult,
        // The audit REASONS vocabulary is narrower than the write path's; map to the closest honest
        // value rather than inventing a new one. Empty string means "no specific reason".
        reason: auditReasonFor(result),
        // A spent quota unit is worth recording when we know it: the caller can then reconcile.
        quota: null,
      };

      const atomic = writeAudit === store;
      let breakerView = null;
      let breakerFailed = false;
      let breakerError;
      let applied = false;
      let skippedReason = null;
      let auditAppended = false;
      let auditRedacted = false;
      let auditFailed = false;
      let auditError;
      let auditConflict;
      let recorded = false;
      let alreadySettled = false;
      // D2/D3 bookkeeping for the NON-atomic branch (declared here so BOTH branches can report).
      let nonAtomicCorruptRefused = false;
      let nonAtomicStorageFailed = false;
      let nonAtomicAuditStorageFailed = false;
      // G-4 additive reporting: a corrupt `settled` / `auditGaps` value is PRESERVED untouched and
      // reported here instead of being quietly replaced. `null` means "nothing corrupt was found".
      let missingSettled = null;
      let missingGaps = null;

      if (atomic) {
        // ── ATOMIC PATH (default, production shape) ─────────────────────────────────────────
        //
        // ONE `store.update` carries FOUR outcomes that must land together or not at all:
        //     breaker · settled · audit(row | gap) · writeGate
        //
        // M7 CHANGED ONE THING FROM t33, AND IT IS THE WHOLE POINT OF THIS BLOCK:
        // t33 made ANY throw roll the whole transaction back, which was right for the crash window
        // but wrong for one specific failure — an AUDIT STORAGE fault. Rolling back there threw away
        // the breaker increment too, so a store whose `audit` was broken could swallow every real
        // failure and never pause: fail-open in the dangerous direction. Measured before the fix:
        // `writes` stayed 0 after a genuine `failed` result.
        //
        // So the transaction is now SPLIT BY KIND OF THROW:
        //   · BREAKER arithmetic throws         -> whole rollback (nothing trustworthy to keep).
        //   · AUDIT CONFLICT (same id, other content) -> whole rollback + `conflict` reported.
        //       This is a CALLER BUG, not a storage fault. Kept exactly as AT-5/AT-13 require —
        //       relaxing it would let a contradiction be "settled" as if it were an ordinary repeat.
        //   · AUDIT STORAGE fault (audit not an array) -> DEGRADE, do not roll back:
        //       the breaker stays applied, a gap entry is recorded, `writeGate` is faulted, and the
        //       caller is told both halves' fate. Nothing is deleted or "repaired".
        let rolledBack = false;
        let phase = 'pre';
      // Set at the exact throw site, because `phase` only names the LAYER being executed, not the reason
      // the transaction refused. Without this, a corrupt `settled` was reported as a breaker failure and a
      // corrupt `auditGaps` as an id conflict — three different repairs behind one wrong name.
      let refusalReason = null;
        let degraded = false;
        let gapRecorded = false;
        let gapKey;
        try {
          const formatted = formatAuditRecord(auditInput);
          const settleKey = settleKeyFor(req.id, formatted);
          phase = 'breaker';
          let next = null;
          store.update((state) => {
            // (0) idempotency (G1). Same request id + same stable identity -> nothing moves.
            //
            // A CORRUPT `settled` VALUE IS NOT AN EMPTY ONE. `settled` is written below as
            // `{ ...(settledMap ?? {}), [settleKey]: ... }`, so a corrupt value (a string, a number, an
            // array) used to be SPREAD AWAY: the original evidence disappeared and the row was replaced
            // with `{ [settleKey]: {...} }` as if it had been "repaired". That is the same G-4 failure
            // OGA-3 pins for `audit` — the corrupt value must survive so whoever debugs this can see
            // what was actually on disk. So: detect "present but not a plain object", keep the original
            // value untouched, and REFUSE to advance idempotency state. Nothing is deleted, nothing is
            // overwritten with a plausible-looking object.
            const rawSettled = state.settled;
            const settledCorrupt = rawSettled !== undefined && rawSettled !== null
              && (typeof rawSettled !== 'object' || Array.isArray(rawSettled));
            missingSettled = settledCorrupt ? { value: rawSettled } : null;
            const settledMap = settledCorrupt
              ? null
              : ((rawSettled && typeof rawSettled === 'object') ? rawSettled : null);
            if (settledMap && settledMap[settleKey]) {
              alreadySettled = true;
              breakerView = pickBreaker(state);
              next = state;
              return next;
            }

            // (0b) A CORRUPT `settled` BLOCKS THE WHOLE SETTLEMENT — it does not merely "skip the
            // idempotency write while everything else proceeds". (Measured by Codex, reproduced here.)
            //
            // WHY: with a fixed clock, two calls for the SAME `failed` result previously produced
            // `writes:1` then `writes:2` — the breaker was advanced TWICE for one execution, and both
            // calls returned `recorded:true`. The clock-free settle key cannot dedupe them because no
            // key was ever written (the corrupt value was preserved, correctly, and never replaced).
            // So "preserve the evidence" and "keep settling" are NOT compatible: if the idempotency
            // record cannot be trusted, we cannot tell a retry from a first attempt, and continuing
            // would double-count real failures into a pause for the wrong reason.
            //
            // THE CONSEQUENCE OF THIS ROLLBACK, stated plainly so nobody reads it as benign:
            //   · the transaction rolls back — breaker/audit/gap for THIS call are NOT persisted;
            //   · `recorded:false`, and `corrupt.settled` is reported so the caller can see why;
            //   · the SAME request retried will roll back the same way until the state is repaired,
            //     i.e. it will NOT silently dedupe and it will NOT silently accumulate — it fails.
            // That is a fail-closed stop, not a silent stop: `state.writeGate` still governs whether
            // writes may continue, and the corrupt value stays exactly as it was found (G-4).
            if (settledCorrupt) {
              // No further use of `settledMap` below: the throw rolls the transaction back, so the
              // breaker and audit halves of THIS call never land.
              refusalReason = 'settle-settled-corrupt';
              throw new TypeError('settled state is corrupt: refusing to settle without a trustworthy idempotency record');
            }

            // (1) breaker FIRST. If this throws, the outer catch rolls everything back.
            const afterBreaker = mapping.breakerOutcome === null
              ? state
              : nextFailureState(state, mapping.breakerDirection, mapping.breakerOutcome);
            if (mapping.breakerOutcome === null) skippedReason = 'not-a-real-failure';
            else applied = true;

            // (2) audit SECOND, in its own try so a STORAGE fault can degrade instead of aborting.
            phase = 'audit';
            let afterAudit = afterBreaker;
            let auditAttemptThrew = null;
            try {
              if (!Array.isArray(afterBreaker.audit)) throw new TypeError('invalid audit state');
              const previous = afterBreaker.audit.find((entry) => entry.id === req.id);
              if (previous) {
                if (JSON.stringify(previous.record) !== JSON.stringify(formatted)) {
                  auditConflict = describeConflict(previous.record, formatted);
                  // Deliberately NOT degraded: a contradiction is not a storage fault.
                  throw new Error('conflicting audit id');
                }
                auditRedacted = previous.record.redacted === true;
              } else {
                auditAppended = true;
                auditRedacted = formatted.redacted === true;
                afterAudit = { ...afterBreaker, audit: [...afterBreaker.audit, { id: req.id, record: formatted }] };
              }
            } catch (auditError0) {
              // TYPED, NOT MESSAGE-MATCHED — same correction as the non-atomic branch (verifier t27).
              //
              // The two branches draw opposite conclusions from this classification, which is exactly why
              // the discriminator must not depend on prose owned by another module:
              //   · non-atomic: conflict -> do NOT latch (the caller made the mistake)
              //   · atomic    : conflict -> ROLL THE WHOLE TRANSACTION BACK (t33/AT-5 semantics)
              // If `appendOfflineAudit` reworded its message, a caller bug would fall through to
              // `auditAttemptThrew`, i.e. it would DEGRADE — commit the breaker, record a gap, fault the
              // gate — instead of rolling back. That is the strict path becoming lenient, the reverse of
              // the non-atomic risk, and it needs the same fix rather than a second regex.
              const isConflict = auditConflict !== undefined || isAuditIdConflict(auditError0);
              if (isConflict) throw auditError0;   // caller bug -> keep the t33 rollback semantics
              auditAttemptThrew = auditError0;      // storage fault -> degrade below
            }

            // (2b) DEGRADE: record the gap and fault the gate, in the SAME returned state.
            let afterGap = afterAudit;
            if (auditAttemptThrew !== null) {
              degraded = true;
              auditFailed = true;
              auditError = describeError(auditAttemptThrew);
              gapKey = settleKey;
              const gap = formatAuditGap({
                key: gapKey,
                // `audit-state-invalid` = the state must be repaired before audit writes can work;
                // `audit-write-failed` would mean "try again later", which is not what a broken
                // array is.
                reason: 'audit-state-invalid',
                generation: gapGenerationFor(settleKey),
                time: now,
              });
              // `auditGaps` deserves the SAME G-4 protection `audit` gets in OGA-3. It used to be
              // written as `[...priorGaps, gap]` off `Array.isArray(...) ? ... : []`, which silently
              // REPLACED a corrupt value (`"CORRUPT-GAPS"` -> `[gap]`) — the evidence of corruption
              // vanished and the field started looking healthy.
              //
              // ⚠️ AND PRESERVING IT IS NOT ENOUGH (Codex R7 counterexample 4, reproduced in OGA-13d).
              // Keeping the corrupt value while still COMMITTING the breaker + gate produced:
              // `rolledBack:false, degraded:true, writes:1, hasSettled:true` with NO audit row and NO
              // gap — i.e. the four-way "one transaction" claim was false for exactly the case where a
              // necessary record could not be written. What lands is a half-settlement: a real failure
              // counted, the evidence of it missing, and the corruption untouched.
              //
              // So an unrecordable necessary gap is now a FAIL-CLOSED STOP, not a degrade: the whole
              // transaction rolls back (breaker included), the corrupt value stays exactly as found, and
              // the outer catch latches the authority so the next write cannot go out. Reporting
              // `degraded` here would be claiming a partial success that does not exist.
              const rawGaps = afterAudit.auditGaps;
              const gapsCorrupt = rawGaps !== undefined && rawGaps !== null && !Array.isArray(rawGaps);
              if (gapsCorrupt) {
                missingGaps = { value: rawGaps };
                refusalReason = 'settle-auditgaps-corrupt';
                throw new TypeError(
                  'auditGaps state is corrupt: the necessary gap cannot be recorded safely, refusing to '
                  + 'commit a half-settlement (the corrupt value is preserved as evidence)',
                );
              }
              {
                const priorGaps = Array.isArray(rawGaps) ? rawGaps : [];
                // Same key -> same gap. A retry must NOT append a second row (unbounded growth) and
                // must not overwrite the original evidence either.
                if (!priorGaps.some((entry) => entry && entry.key === gap.key)) {
                  afterGap = { ...afterGap, auditGaps: [...priorGaps, gap] };
                  gapRecorded = true;
                }
              }
              // Persist the fault marker so the gate refuses AFTER this transaction, on every later
              // call, in every process — not just this one.
              afterGap = {
                ...afterGap,
                writeGate: afterGap.writeGate === undefined || afterGap.writeGate === null
                  // `generation` names the EPISODE that raised this marker. Without it the gate was
                  // anonymous, so any open gap of ANY generation could clear it — measured (Codex
                  // CODEX-R14-COMBINED-ABA): an old G1 gap present while the gate belonged to G2 →
                  // recovery accepted, gate dropped, `gateAfter:"allowed"`. It is the same id the gap
                  // above carries, because both describe this one settlement.
                  ? { fault: 'audit-unavailable', since: now, cause: 'audit-state-invalid', generation: gapGenerationFor(settleKey) }
                  : afterGap.writeGate,   // an existing marker wins; the first fault is the record
              };
            }

            // (3) settled LAST, so the idempotency record matches what actually landed.
            //
            // `settledCorrupt` CANNOT BE TRUE HERE. A corrupt `settled` threw at (0b) above, before the
            // breaker half was even computed, so this code is only reached with a trustworthy map.
            // (Earlier revisions of this block carried an "else leave it alone / a retry stays a retry"
            // comment plus a `next = afterGap` fallback; both described the pre-(0b) semantics and were
            // dead once (0b) began throwing. Removed rather than left to mislead the next reader into
            // thinking a corrupt settlement is still committed.)
            const settled = {
              ...(settledMap ?? {}),
              [settleKey]: { id: req.id, at: now, outcome: mapping.auditResult },
            };
            next = { ...afterGap, settled };
            return next;
          });
          recorded = !alreadySettled && !degraded;
          breakerView = pickBreaker(next ?? store.read());
        } catch (error) {
          // Reached only for breaker arithmetic or an audit CONFLICT: both roll back.
          rolledBack = true;
          applied = false;
          auditAppended = false;
          auditRedacted = false;
          recorded = false;
          if (phase === 'breaker') { breakerFailed = true; breakerError = describeError(error); } else { auditFailed = true; auditError = describeError(error); }
          try { breakerView = pickBreaker(store.read()); } catch { breakerView = null; }
          // M7 -> M4: a COMMIT failure is exactly the condition the latch exists for. Called OUTSIDE
          // the transaction because it is process memory, not state — and only when the transaction
          // really failed.
          //
          // The handle is passed STRAIGHT THROUGH, deliberately. An earlier version wrapped it in
          // `resolveAuthority(store, store)`; measurement showed that was behaviourally redundant
          // (`latchFault` resolves internally via `authorityKey → resolveAuthority`) and, worse, it
          // DOUBLE-RESOLVED: passing an already-resolved token made `latchFault` fail to recognise it
          // as a store. One resolution, one place.
          //
          // THE REASON IS THE THROW SITE'S, NOT THE PHASE'S (see `refusalReason`). `phase` only says which
          // layer was executing; a corrupt field and a genuine breaker fault both pass through here.
          latchFault(
            store,
            refusalReason ?? (phase === 'breaker' ? 'settle-breaker-failed' : 'settle-conflict-rollback'),
          );
          return Object.freeze({
            atomic: true,
            rolledBack,
            recorded: false,
            alreadySettled: false,
            degraded: false,
            permaGap: false,
            // G-4 evidence of a corrupt `settled` / `auditGaps` value that caused this rollback. Kept
            // on BOTH return shapes (success and failure) so a caller never has to guess which one
            // carries it.
            corrupt: Object.freeze({
              settled: missingSettled === null ? null : Object.freeze({ ...missingSettled }),
              auditGaps: missingGaps === null ? null : Object.freeze({ ...missingGaps }),
            }),
            audit: Object.freeze({
              appended: false, redacted: false, failed: auditFailed,
              ...(auditError === undefined ? {} : { error: auditError }),
              ...(auditConflict === undefined ? {} : { conflict: auditConflict }),
            }),
            breaker: Object.freeze({
              ...(breakerView ?? { reads: null, writes: null, accessPaused: null, writePaused: null }),
              applied: false,
              skippedReason,
              failed: breakerFailed,
              ...(breakerError === undefined ? {} : { error: breakerError }),
            }),
          });
        }

        return Object.freeze({
          atomic: true,
          rolledBack: false,
          recorded,
          alreadySettled,
          // `degraded` means: the breaker and the settlement were persisted, but the audit ROW could
          // not be. The caller must not read this as "all fine" — hence the separate flag and the gap.
          degraded,
          gap: Object.freeze({
            recorded: gapRecorded,
            ...(gapKey === undefined ? {} : { key: gapKey }),
          }),
          // G-4: a corrupt `settled` / `auditGaps` value was left EXACTLY as it was found (it is
          // evidence) and is reported here. `null` on both means the two fields were well-formed.
          corrupt: Object.freeze({
            settled: missingSettled === null ? null : Object.freeze({ ...missingSettled }),
            auditGaps: missingGaps === null ? null : Object.freeze({ ...missingGaps }),
          }),
          audit: Object.freeze({
            appended: auditAppended,
            redacted: auditRedacted,
            failed: auditFailed,
            ...(auditError === undefined ? {} : { error: auditError }),
            ...(auditConflict === undefined ? {} : { conflict: auditConflict }),
          }),
          breaker: Object.freeze({
            ...(breakerView ?? { reads: null, writes: null, accessPaused: null, writePaused: null }),
            applied,
            skippedReason,
            failed: breakerFailed,
            ...(breakerError === undefined ? {} : { error: breakerError }),
          }),
        });
      } else {        // ── NON-ATOMIC PATH (caller injected a different auditStore) ──────────────────────
        // Deliberately the OLD two-transaction behaviour for the AUDIT, kept because it is the only
        // way to inject "the audit alone failed". Labelled `atomic:false` on every return so nobody
        // can mistake it for the default contract.
        //
        // G1 still applies here: the settled-check, the breaker transition and the settled-write all
        // live in ONE `store.update`, so a repeat cannot double-count on this path either. What is
        // split is only the audit, which is the seam's entire reason to exist.
        let formatted;
        try {
          formatted = formatAuditRecord(auditInput);
        } catch (error) {
          auditFailed = true;
          auditError = describeError(error);
        }

        if (formatted !== undefined) {
          const settleKey = settleKeyFor(req.id, formatted);
          try {
            let next = null;
            store.update((state) => {
              // D3 — "ABSENT" AND "PRESENT BUT CORRUPT" ARE DIFFERENT (Codex, this round's must-fix).
              //
              // This branch used to fall back to `null` for ANY non-plain-object `settled` and then write
              // `{ ...(settledMap ?? {}), [settleKey]: … }`, i.e. it SPREAD THE EVIDENCE AWAY and replaced
              // it with a plausible-looking map. Measured on a real store with an injected auditStore:
              // `{recorded:true, corrupt.settled:null, settledAfter:'{"…-1#…":{…}}'}` — the corrupt value
              // was gone and the caller was told nothing was wrong.
              //
              // Same rule as the atomic path's (0b): if the idempotency record cannot be trusted, we cannot
              // tell a retry from a first attempt, so we must NOT settle. Refuse, preserve verbatim, latch.
              const rawSettled = state.settled;
              const settledCorrupt = rawSettled !== undefined && rawSettled !== null
                && (typeof rawSettled !== 'object' || Array.isArray(rawSettled));
              missingSettled = settledCorrupt ? { value: rawSettled } : null;
              if (settledCorrupt) {
                nonAtomicCorruptRefused = true;
                throw new TypeError(
                  'settled state is corrupt: refusing to settle without a trustworthy idempotency record',
                );
              }
              const settledMap = (rawSettled && typeof rawSettled === 'object') ? rawSettled : null;
              if (settledMap && settledMap[settleKey]) {
                alreadySettled = true;
                next = state;
                return next;
              }
              const afterBreaker = mapping.breakerOutcome === null
                ? state
                : nextFailureState(state, mapping.breakerDirection, mapping.breakerOutcome);
              if (mapping.breakerOutcome === null) skippedReason = 'not-a-real-failure';
              else applied = true;
              next = {
                ...afterBreaker,
                settled: { ...(settledMap ?? {}), [settleKey]: { id: req.id, at: now, outcome: mapping.auditResult } },
              };
              return next;
            });
            breakerView = pickBreaker(next ?? store.read());
          } catch (error) {
            breakerFailed = true;
            breakerError = describeError(error);
            try { breakerView = pickBreaker(store.read()); } catch { breakerView = null; }
            // D2: the settlement transaction FAILED to store. Corrupt-state refusal and plain breaker
            // arithmetic failure are both "this authority cannot be trusted to settle" -> latch.
            nonAtomicStorageFailed = true;
          }
        }

        if (alreadySettled) {
          // Nothing was settled again, so there is nothing to audit again — same rule as the atomic
          // path: a repeat is a no-op everywhere, not a no-op in one half.
          return Object.freeze({
            atomic,
            rolledBack: false,
            recorded: false,
            alreadySettled: true,
            audit: Object.freeze({ appended: false, redacted: false, failed: false }),
            breaker: Object.freeze({
              ...(breakerView ?? { reads: null, writes: null, accessPaused: null, writePaused: null }),
              applied: false,
              skippedReason: 'already-settled',
              failed: false,
            }),
          });
        }

        if (formatted !== undefined) {
          try {
            const appended = appendOfflineAudit(writeAudit, req.id, auditInput);
            auditAppended = appended.appended;
            recorded = true;
            try {
              const state = writeAudit.read();
              const row = Array.isArray(state.audit) ? state.audit.find((entry) => entry.id === req.id) : undefined;
              auditRedacted = row?.record?.redacted === true;
              // G2 on this path too: if a row already exists with a DIFFERENT record, `appendOfflineAudit`
              // threw, and we can describe why by comparing what is stored with what we just tried.
              if (row && JSON.stringify(row.record) !== JSON.stringify(formatted)) {
                auditConflict = describeConflict(row.record, formatted);
              }
            } catch { /* reporting only */ }
          } catch (error) {
            auditFailed = true;
            auditError = describeError(error);
            // D2: an AUDIT STORAGE fault also stops new sending for this authority. A conflict is NOT
            // storage — it is a caller bug — so it is excluded here on purpose.
            //
            // DETECTED BY CODE, NOT BY MESSAGE (verifier t26 low-1). This used to test
            // `/conflicting audit id/` against the message text, which made the classification depend on
            // prose owned by another module: rewording that message would silently reclassify a CALLER BUG
            // as a storage fault and latch a healthy authority — the reverse failure. `code` is the
            // contract; the message check stays only as a fallback for an older thrower.
            const isAuditConflict = isAuditIdConflict(error);
            if (!isAuditConflict) nonAtomicAuditStorageFailed = true;
            // Distinguish "id collision" (caller bug) from "store broken" (infrastructure) — the
            // whole point of G2.
            if (isAuditConflict) {
              try {
                const state = writeAudit.read();
                const row = Array.isArray(state.audit) ? state.audit.find((entry) => entry.id === req.id) : undefined;
                if (row) auditConflict = describeConflict(row.record, formatted);
              } catch { /* reporting only */ }
            }
          }
        }
      }

      // ── TWO SENTENCES EVERY READER OF THIS RETURN NEEDS ──────────────────────────────────
      //
      // (1) `recorded:false` DOES NOT MEAN "nothing was written". `recorded` answers exactly one
      //     question — "was this SETTLEMENT recorded in idempotency state?" — and on this branch the
      //     audit row is an INDEPENDENT transaction that may still land. So
      //     `{recorded:false, audit:{appended:true}}` is a LEGAL COMBINATION, not a contradiction
      //     (verifier t26 low-2 measured it: 19-test suite, corrupt `settled`, audit row count 1).
      //     Reading it as a bug leads to "fix" the audit row away — which would delete the only record
      //     that a real delivery attempt happened.
      //
      // (2) `atomic:false` PLUS A LATCH IS ALSO A LEGAL COMBINATION. Labelling the contract as
      //     non-atomic describes HOW the two halves commit (separately), not how safe the outcome is.
      //     A storage fault on either half still latches the authority, so the very next write for it is
      //     refused. Do not read `atomic:false` as "best effort, keep going".

      // ── NON-ATOMIC CONSEQUENCES (D2/D3) ─────────────────────────────────────────────────────
      //
      // Applied once, right before the shared return, so the non-atomic branch produces the SAME
      // observable outcome as the atomic path:
      //   · a corrupt value is REPORTED (it was preserved by the guard above, but until now nothing
      //     said so, which made "preserved and silent" indistinguishable from "nothing was corrupt");
      //   · a REAL storage failure LATCHES the authority, so the write path stops sending for it.
      //     Reporting audit.failed without latching was the fail-open shape the atomic path removed:
      //     the operator sees a red receipt while the process keeps sending.
      //   · `atomic:false` is unchanged — this branch stays honestly labelled.
      if (!atomic) {
        const latchReasons = [];
        if (nonAtomicCorruptRefused) {
          // The settlement never happened: we refused because the idempotency record is untrustworthy.
          // `recorded` must not claim a row for a settlement that did not occur.
          recorded = false;
          applied = false;
          latchReasons.push('settle-settled-corrupt');
        }
        if (nonAtomicStorageFailed) latchReasons.push('settle-breaker-failed');
        if (nonAtomicAuditStorageFailed) latchReasons.push('settle-audit-storage-failed');
        if (latchReasons.length > 0) {
          // ONE latch per authority; the FIRST reason is kept as the diagnostic (same rule as latchFault).
          latchFault(store, latchReasons[0]);
        }
      }

      return Object.freeze({
        atomic,
        // `rolledBack` is only meaningful on the atomic path, but it is present on EVERY return so a
        // caller never has to distinguish "false" from "absent". On the non-atomic path a failure
        // never rolls anything back, so it is always false there.
        rolledBack: false,
        recorded,
        // G-4 evidence on the non-atomic path too. Omitted from this return until now, which made
        // "corrupt was preserved but unreported" indistinguishable from "nothing was corrupt".
        corrupt: Object.freeze({
          settled: missingSettled === null ? null : Object.freeze({ ...missingSettled }),
          auditGaps: missingGaps === null ? null : Object.freeze({ ...missingGaps }),
        }),
        // G1: `alreadySettled` is on EVERY return so a caller can always tell "this settlement was
        // already counted" from "this settlement just happened".
        alreadySettled,
        audit: Object.freeze({
          appended: auditAppended,
          redacted: auditRedacted,
          failed: auditFailed,
          ...(auditError === undefined ? {} : { error: auditError }),
          ...(auditConflict === undefined ? {} : { conflict: auditConflict }),
        }),
        breaker: Object.freeze({
          ...(breakerView ?? { reads: null, writes: null, accessPaused: null, writePaused: null }),
          applied,
          skippedReason,
          failed: breakerFailed,
          ...(breakerError === undefined ? {} : { error: breakerError }),
        }),
      });
    },

    /**
     * Record one READ-side outcome through the same breaker.
     *
     * Kept on this interface (rather than folded into `record`) because the task card asks for the
     * read direction to be expressible and for `not_accessible` to be proven harmless to the WRITE
     * counter. `nextFailureState(state,'read',...)` is the reviewed implementation; nothing is
     * re-derived here.
     *
     * @param outcome - one of the policy's OUTCOMES: success/failure/not_accessible/login_expired/
     *   captcha/network_unavailable
     */
    recordRead({ outcome } = {}) {
      let next = null;
      store.update((state) => {
        next = nextFailureState(state, 'read', outcome);
        return next;
      });
      return Object.freeze(pickBreaker(next ?? store.read()));
    },
  });
}

/** Audit `reason` from a write-path result, using ONLY the audit module's own vocabulary. */
function auditReasonFor(result) {
  if (!result || typeof result !== 'object') return '';
  const reason = result.reason ?? '';
  if (reason === 'unknown-outcome') return 'other';
  if (reason === 'paused-before-send') return 'other';
  if (reason === 'transport-threw') return 'network';
  if (reason === 'interval') return 'rate_limit';
  if (reason === 'limit') return 'quota';
  if (reason === 'duplicate' || reason === 'duplicate_like') return 'policy';
  // Everything else (policy refusals, invalid input) is a policy decision, not a platform event.
  return result.stage === 'reserve' ? 'policy' : '';
}
/**
 * Turn a thrown value into something the caller can actually read.
 *
 * A raw `Error` cannot survive the store's JSON round-trip: `JSON.stringify(new Error('x'))` is
 * `"{}"`, so the reported `error` field arrived empty and an audit failure was undiagnosable.
 * Keeping name+message is enough to tell the operator WHICH failure happened.
 */
/**
 * Is this error "the caller reused an audit id with different content"?
 *
 * A CALLER BUG, never an infrastructure fault. Discriminated by `code` (the contract), with the message
 * kept only as a fallback so an older/differently-built thrower is still classified correctly instead of
 * being treated as a broken disk. Anything unrecognised is conservatively NOT a conflict — a storage
 * fault latches, a misclassified conflict does not, and only one of those two mistakes keeps sending.
 */
function isAuditIdConflict(error) {
  if (error === null || error === undefined) return false;
  const code = typeof error === 'object' ? error.code : undefined;
  if (code === 'AUDIT_ID_CONFLICT') return true;
  // Legacy fallback: a thrower that predates `code` still says the same words.
  return /conflicting audit id/.test(String(error.message ?? ''));
}

function describeError(error) {
  if (error === null || error === undefined) return { name: 'Unknown', message: 'unknown error' };
  if (typeof error === 'string') return { name: 'Error', message: error };
  const name = typeof error.name === 'string' && error.name ? error.name : 'Error';
  const message = typeof error.message === 'string' ? error.message : String(error);
  return { name, message };
}

function pickBreaker(state) {
  const reads = Number.isSafeInteger(state?.reads) ? state.reads : null;
  const writes = Number.isSafeInteger(state?.writes) ? state.writes : null;
  return {
    reads,
    writes,
    accessPaused: state?.accessPaused === true,
    writePaused: state?.writePaused === true,
  };
}

// REAL BLOCKERS — do not read this module as evidence of platform behaviour
// ------------------------------------------------------------------------
// 1. **No trusted settlement event.** Everything above classifies a value that SOMEONE ELSE produced.
//    In the offline sample the transport is a fake, so "real failure" vs "privacy refusal" is decided
//    by a fixture, not by the platform. On a real platform, distinguishing `failed` (the call went out
//    and was refused) from `not_accessible` (a privacy wall we must not count) requires a trusted
//    settlement source that reports the platform's verdict. No such source is wired; until it exists,
//    the breaker's correctness is a property of the MAPPING, not of reality.
// 2. **Depends on unfinished B3 for provenance.** Nothing here proves the write was authorised by a
//    real inbound QQ event; that is B3's job and it is not closed. A `success` row in the audit log
//    therefore says "the injected transport returned success", never "a real QZone write happened".
export { mapWriteResult as _mapWriteResult };
