// OPTION C — targeted release for the `paused-before-send` branch ONLY.
//
// WHAT THIS RELEASES AND WHAT IT KEEPS
// ------------------------------------
//   released :  `ledger.used[kind]` -1                    (the daily quota the user actually feels)
//               `lastPostAt` / `lastCommentAt` rolled back (guarded, see below)
//   KEPT     :  `ledger.reservations[id]`                  (the replay-proof foundation)
//               `likes` / `commentTargets`                  (duplicate-like / interval evidence)
//
// WHY THIS BRANCH IS THE ONLY ONE
// -------------------------------
// `paused-before-send` is the only outcome for which the WRITE PATH itself (not the transport) records
// that it did not call the transport. See the TRUST BOUNDARY section below: that fact holds INSIDE the
// write path, and does NOT survive the boundary into this module. Everything else is self-reported:
//   · transport-reported `not-sent` — the transport is telling us about its own behaviour; unauditable
//   · `unknown` / `failed`         — may have reached the platform
//   · pre-dispatch refusals        — never spent quota in the first place, so there is nothing to give back
// Giving quota back on any of those would be paying out on an unverifiable claim. This module
// therefore refuses (`not-paused-before-send`) when handed a result that is not that branch.
//
// Release is NOT permission to replay. `reservations[id]` survives, so the same id stays `duplicate`.
// That is deliberate: the caller has to retry under a NEW id. Releasing quota != reopening the window.
//
// THE THREE HARD PARTS (design doc §4)
// ------------------------------------
// 1. THE COOLDOWN HAS NO HISTORY. `lastPostAt` / `lastCommentAt` are bare numbers, so rolling one back
//    requires knowing what it was BEFORE the reservation. The caller snapshots it (`previous`) before
//    reserving. Two guards, both fail-safe:
//      · only roll back when `state.lastXxxAt === now` — i.e. OUR write is still the current value. If
//        another writer advanced it in between, rolling back would ERASE their advance, so we skip;
//      · only roll back when `previous` actually carries that field. No snapshot -> no rollback.
//    Skipping the rollback keeps the penalty. That is the correct direction: a wrongly-kept cooldown
//    costs availability; a wrongly-rolled-back one grants an extra send window nobody authorised.
//
// 2. DAY ROLLOVER. `used` is per-day. A reservation made on day D and released on D+1 would subtract
//    from the NEW day's counter — a release that never happened, against a quota that was never spent.
//    So the record carries `day`; when `state.ledger.day !== day` the `used` release is SKIPPED and
//    `reason:'day-rollover'` is reported. The cooldown rollback is not day-scoped and is still tried.
//
// 3. CONCURRENCY / REPEAT SETTLEMENT. Two concurrent releases of one id would subtract 2. An
//    `ledger.released[id] = true` marker is checked and written INSIDE the same `store.update`
//    transaction (real SQLite `BEGIN IMMEDIATE`), so the second caller sees the marker and gets
//    `already-released` with zero further change.
//
// FAIL-CLOSED SUMMARY (design §6) — every uncertainty keeps the penalty
// ---------------------------------------------------------------------
//   transaction throws        -> the ROLLBACK leaves the charge in place, the error propagates
//   id not in reservations    -> `not-reserved`, NOTHING changes
//   already released          -> `already-released`, NOTHING changes
//   day rolled over           -> skip `used`, still try the cooldown
//   cooldown moved by someone -> skip the cooldown, still release `used`
//
// ⚠️ TRUST BOUNDARY — READ BEFORE TREATING THIS AS PROOF (added 2026-11-12)
// -------------------------------------------------------------------------
// The paragraph above says `paused-before-send` "is a CODE-LEVEL STRUCTURAL fact". THAT SENTENCE IS
// TOO STRONG, and it was measured to be wrong. Corrected statement:
//
//   `transportCalled:false` is a structural fact ONLY INSIDE the write path. The moment the result
//   crosses this module's boundary it is an ordinary plain object supplied by the CALLER, and the
//   caller can construct it. This module therefore has NO proof that the reservation it releases was
//   the one that skipped its transport.
//
// Measured (see `.qzone-channel-lab/A-RELEASE-TRUST-BOUNDARY-v2.md`):
//   · `result` is OPTIONAL — omitting it entirely still releases (`result !== undefined` guard);
//   · `isPausedBeforeSend()` is a SHAPE CHECK on three fields, not an origin check;
//   · `day` / `now` / `previous` are all caller-supplied. `now` is especially dangerous: the cooldown
//     guard is `state.lastXxxAt === now`, so a caller who passes ANOTHER writer's timestamp satisfies
//     the guard and the rollback then erases that writer's legitimate advance.
//   · `id` is only checked for `hasOwn(reservations, id)`; `kind` IS cross-checked against
//     `reservations[id]` (that check is real and worth keeping).
//
// WHAT THIS MEANS FOR USE
//   · This module has NO trusted "was not sent" proof. Do not describe it as having one.
//   · It must NOT be wired into a production path in this form. There is currently no production
//     caller (`qzone-write-path-offline.mjs` does not import it), and that is intentional.
//   · Making the release trustworthy needs a capability the caller cannot forge — a handle minted by
//     the write path itself carrying `id/kind/day/now/previous` in a closure, so no argument is
//     accepted. That requires changing `reserveOfflinePost` / `reserveOfflineInteraction` signatures
//     (they currently return only `{allowed:true}` and cannot hand back `day/now/previous`).
//   · Until that exists: keep it offline, keep it unwired, keep the penalty.
//
// MEASURED LIMITATION — REPORTED, NOT HIDDEN
// ------------------------------------------
// For `comment` / `reply` the cooldown rollback is largely INEFFECTIVE, because
// `reserveOfflineInteraction` derives its interval from the MAX of `lastCommentAt` AND every
// `commentTargets[].time`, and this design KEEPS `commentTargets` (§9 forbids deleting it). Measured
// with a real store: reserve -> roll `lastCommentAt` back to its snapshot -> a second comment one
// second later on a DIFFERENT target is still refused with `interval`, because the retained
// `commentTargets` entry carries the same timestamp.
//   · For `publish` the rollback DOES work: `lastPostAt` is the only source of that interval
//     (measured: rollback -> a second publish 1s later is allowed).
//   · For `like` there is no cooldown at all.
// This module implements the design as approved rather than widening it: dropping `commentTargets`
// entries is exactly what §9 forbids, and doing it here would silently weaken the interval evidence
// for other targets. The consequence is reported so the decision can be made deliberately.

/** Reason codes. Each one means "what, if anything, was released". */
export const PAUSED_RELEASE_REASON = Object.freeze({
  NOT_RESERVED: 'not-reserved',       // id never held a reservation -> nothing changed
  ALREADY_RELEASED: 'already-released', // release marker present -> nothing changed
  KIND_MISMATCH: 'kind-mismatch',     // reservations[id] !== requested kind -> nothing changed
  DAY_ROLLOVER: 'day-rollover',       // used skipped (different day); cooldown still attempted
  COOLDOWN_MOVED: 'cooldown-moved',   // cooldown guard failed; used still released
  NOT_PAUSED_BEFORE_SEND: 'not-paused-before-send', // out of scope by construction
  INVALID: 'invalid-argument',
});

const PAUSED = 'paused-before-send';
const KINDS = new Set(['post', 'comment', 'like']);
const COOLDOWN_FIELD = Object.freeze({ post: 'lastPostAt', comment: 'lastCommentAt', like: null });

/**
 * Is this write-path result the one branch this module is allowed to act on?
 *
 * Requires BOTH markers the write path emits together:
 *   `reason === 'paused-before-send'` and `transportCalled === false`.
 * Checking only the reason string would let a hand-made object claim the branch; requiring the
 * structural flag is what ties the decision to the code path rather than to a label.
 */
export function isPausedBeforeSend(result) {
  return Boolean(result)
    && result.reason === PAUSED
    && result.transportCalled === false
    // `ok:false` is how the write path reports "reserved but deliberately not sent".
    && result.ok === false;
}

/**
 * Release one `paused-before-send` reservation, partially.
 *
 * @param store - offline store (`read`/`update`).
 * @param id    - the reservation id (must exist in `ledger.reservations`).
 * @param kind  - `'post' | 'comment' | 'like'`.
 * @param day   - `beijingDay` captured at reservation time.
 * @param now   - the timestamp the reservation wrote into the cooldown field.
 * @param previous - `{ lastPostAt?, lastCommentAt? }` snapshot taken BEFORE reserving. Optional: when
 *   absent (or missing the relevant key) the cooldown is simply not rolled back.
 * @param result - optional write-path result. When PROVIDED it is enforced: anything that is not the
 *   paused-before-send branch returns `not-paused-before-send` and changes nothing.
 *
 * @returns
 *   { released, reason?, usedReleased, cooldownRolledBack: string[], cooldownSkipped: string[] }
 */
export function releasePausedWrite(store, { id, kind, day, now, previous, result } = {}) {
  if (!store || typeof store.update !== 'function' || typeof store.read !== 'function') {
    throw new TypeError('paused release needs a store with read/update');
  }
  if (typeof id !== 'string' || !id) {
    return Object.freeze({ released: false, reason: PAUSED_RELEASE_REASON.INVALID, usedReleased: false, cooldownRolledBack: Object.freeze([]), cooldownSkipped: Object.freeze([]) });
  }
  if (!KINDS.has(kind)) {
    return Object.freeze({ released: false, reason: PAUSED_RELEASE_REASON.INVALID, usedReleased: false, cooldownRolledBack: Object.freeze([]), cooldownSkipped: Object.freeze([]) });
  }
  if (!Number.isSafeInteger(now) || now < 0 || typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return Object.freeze({ released: false, reason: PAUSED_RELEASE_REASON.INVALID, usedReleased: false, cooldownRolledBack: Object.freeze([]), cooldownSkipped: Object.freeze([]) });
  }
  // Scope enforcement. `result` is optional so a caller that already holds the branch can omit it,
  // but when it IS supplied a non-paused result is refused outright — the release must never be
  // reachable from `unknown` / `failed` / transport-reported `not-sent`.
  if (result !== undefined && !isPausedBeforeSend(result)) {
    return Object.freeze({ released: false, reason: PAUSED_RELEASE_REASON.NOT_PAUSED_BEFORE_SEND, usedReleased: false, cooldownRolledBack: Object.freeze([]), cooldownSkipped: Object.freeze([]) });
  }

  let outcome = null;

  // One transaction. The idempotency check, the reservation check, the day check, the quota
  // decrement and the cooldown rollback all happen under the same `BEGIN IMMEDIATE` write lock, so
  // two concurrent releases cannot both pass the marker check.
  store.update((state) => {
    const ledger = state?.ledger;
    if (!ledger || typeof ledger !== 'object' || !ledger.used || !ledger.reservations) {
      // A malformed ledger is not something this module may "repair" by releasing. Keep the penalty
      // and report that nothing happened; the caller still owns the original charge.
      outcome = Object.freeze({ released: false, reason: PAUSED_RELEASE_REASON.NOT_RESERVED, usedReleased: false, cooldownRolledBack: Object.freeze([]), cooldownSkipped: Object.freeze([]) });
      return state;
    }

    const releasedMap = (ledger.released && typeof ledger.released === 'object' && !Array.isArray(ledger.released))
      ? ledger.released
      : {};
    if (releasedMap[id] === true) {
      outcome = Object.freeze({ released: false, reason: PAUSED_RELEASE_REASON.ALREADY_RELEASED, usedReleased: false, cooldownRolledBack: Object.freeze([]), cooldownSkipped: Object.freeze([]) });
      return state;
    }
    if (!Object.hasOwn(ledger.reservations, id)) {
      outcome = Object.freeze({ released: false, reason: PAUSED_RELEASE_REASON.NOT_RESERVED, usedReleased: false, cooldownRolledBack: Object.freeze([]), cooldownSkipped: Object.freeze([]) });
      return state;
    }
    // ── the reservation must belong to the SAME quota bucket ────────────────────────────────
    //
    // `hasOwn(id)` alone is not enough. The caller supplies `kind`, and without this check a single
    // `publish` reservation could be released as `kind:'comment'`, decrementing a DIFFERENT bucket's
    // `used` counter — i.e. giving back quota that some other, legitimate comment had spent.
    // Measured: `reservations:{p1:'post'}, used:{comment:2}` + `{id:'p1', kind:'comment'}` used to
    // turn `used.comment` from 2 into 1.
    //
    // The reservation record is the ONLY trustworthy statement about what this id actually took, so
    // it, not the argument, decides the bucket. A mismatch changes NOTHING.
    const reservedKind = ledger.reservations[id];
    if (reservedKind !== kind) {
      outcome = Object.freeze({ released: false, reason: PAUSED_RELEASE_REASON.KIND_MISMATCH, usedReleased: false, cooldownRolledBack: Object.freeze([]), cooldownSkipped: Object.freeze([]) });
      return state;
    }

    // ── (A) daily quota, day-scoped ───────────────────────────────────────────────────────────
    const sameDay = ledger.day === day;
    const used = { ...ledger.used };
    let usedReleased = false;
    if (sameDay) {
      // Never go negative: `checkLedger` requires `>= 0`, and a zero counter means there is no
      // charge left to give back (the day may have been reset by another path).
      if (Number.isSafeInteger(used[kind]) && used[kind] > 0) {
        used[kind] -= 1;
        usedReleased = true;
      }
    }

    // ── (B) cooldown, guarded, not day-scoped ────────────────────────────────────────────────
    const next = { ...state, ledger: { ...ledger, used, released: { ...releasedMap, [id]: true } } };
    const rolledBack = [];
    const skipped = [];
    const field = COOLDOWN_FIELD[kind];
    if (field === null) {
      skipped.push('no-cooldown');
    } else if (previous === undefined || previous === null || typeof previous !== 'object'
      || !Object.hasOwn(previous, field)) {
      // No snapshot -> we do not know what to restore. Skipping keeps the (harsher) cooldown in place.
      skipped.push('no-snapshot');
    } else if (next[field] !== now) {
      // Someone advanced this field after our reservation. Rolling back now would erase their work,
      // and an erased advance is an unauthorised extra send window. Skip, keep the penalty.
      skipped.push('cooldown-moved');
    } else {
      const restored = previous[field];
      if (restored === null || (Number.isSafeInteger(restored) && restored >= 0)) {
        next[field] = restored;
        rolledBack.push(field);
      } else {
        skipped.push('snapshot-invalid');
      }
    }

    // ── (C) report ──────────────────────────────────────────────────────────────────────────
    const anyReleased = usedReleased || rolledBack.length > 0;
    let reason;
    if (!sameDay) reason = PAUSED_RELEASE_REASON.DAY_ROLLOVER;
    else if (skipped.includes('cooldown-moved')) reason = PAUSED_RELEASE_REASON.COOLDOWN_MOVED;
    else if (!anyReleased) reason = undefined;

    outcome = Object.freeze({
      released: anyReleased,
      ...(reason === undefined ? {} : { reason }),
      usedReleased,
      cooldownRolledBack: Object.freeze(rolledBack),
      cooldownSkipped: Object.freeze(skipped),
    });
    return next;
  });

  return outcome ?? Object.freeze({
    released: false, reason: PAUSED_RELEASE_REASON.NOT_RESERVED,
    usedReleased: false, cooldownRolledBack: Object.freeze([]), cooldownSkipped: Object.freeze([]),
  });
}
