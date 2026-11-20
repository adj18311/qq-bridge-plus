// Minimal read-only dispatch wrapper: the ONLY place that decides "may this call execute?".
//
// Contract, in the order it must happen
// -------------------------------------
//   1. claim on the persistent replay store        (must be `ok:true`, must already be durable)
//   2. only then call the injected transport
//   3. if claim fails for ANY reason -> transport is NEVER called
//
// What this wrapper is NOT
//   · NOT source authentication. `claim.ok` means "this exact
//     (account, session, request, call) had never been claimed before" — nothing more. A
//     caller that fabricates ids still gets a successful claim; B3 is the separate answer
//     to "is this really from QQ". Do not treat `ok:true` here as an authorization decision
//     beyond replay prevention.
//   · NOT a retry engine. An `unknown` transport outcome keeps the claim (fail-closed); the
//     wrapper never re-sends.
//   · NOT wired into the bridge. There is no production entry point for this; it exists so
//     the ordering can be tested against a real store and a fake transport.

/**
 * Normalise a transport result into exactly one of `success` | `failed` | `unknown`.
 *
 * Two rounds of defects have been fixed here, both measured rather than theorised.
 *
 * Round 1: everything unrecognised defaulted to `success`, so `undefined`, `null`, `false`,
 * `0`, `''` and even `{outcome:'unknown'}` all reported success. "The transport was called"
 * was being equated with "the platform did something we can confirm".
 *
 * Round 2 (this version): the code short-circuited — it returned `success` as soon as it saw
 * `ok:true`, without ever looking at what `outcome` said. So `{ok:true, outcome:'failed'}`
 * — a transport explicitly reporting failure — was recorded as success, and
 * `{ok:'invalid', outcome:'success'}` treated a non-boolean `ok` as acceptable.
 *
 * The rule now, applied in this order and never short-circuited:
 *
 *   1. TYPE / VALUE VALIDATION. Every present status field must hold a legal value.
 *        ok         : boolean
 *        outcome    : 'success' | 'failed' | 'unknown'
 *        unknown    : boolean
 *      An illegal value makes the whole answer `unknown` — we cannot interpret it.
 *
 *   2. COLLECT CLAIMS. Each field that carries a conclusion contributes one claim:
 *        ok:true          -> success          outcome:'success' -> success
 *        ok:false         -> failed           outcome:'failed'  -> failed
 *        unknown:true     -> unknown          outcome:'unknown' -> unknown
 *      `unknown:false` and an absent field contribute nothing.
 *
 *   3. RECONCILE. `unknown` is contagious (a transport that says "I don't know" is never
 *      upgraded). `success` + `failed` is a contradiction. Either case yields `unknown`.
 *      Only when every claim agrees, and at least one exists, is a definite answer emitted.
 *
 * `{outcome:'success'}` with no `ok` is legitimate: it is the outcome-only form. But if `ok`
 * is PRESENT and not a boolean, that is an illegal value, not an absent one.
 *
 * The OUTER `{ok, outcome}` returned by `dispatch()` is a different pair and keeps its own
 * meaning: outer `ok` says the dispatch path completed without a refusal or a throw; outer
 * `outcome` carries this normalised verdict. `{ok:true, outcome:'failed'}` at the OUTER level
 * is perfectly legal — it means "we dispatched once and the platform told us it failed".
 * Do not read the outer pair as if it carried the transport's raw fields.
 */
function normaliseOutcome(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return 'unknown';

  // ── 1. validate every present status field ─────────────────────────────────────────
  const hasOk = Object.hasOwn(result, 'ok');
  const hasOutcome = Object.hasOwn(result, 'outcome');
  const hasUnknown = Object.hasOwn(result, 'unknown');

  if (hasOk && typeof result.ok !== 'boolean') return 'unknown';
  if (hasUnknown && typeof result.unknown !== 'boolean') return 'unknown';
  if (hasOutcome && result.outcome !== 'success' && result.outcome !== 'failed' && result.outcome !== 'unknown') {
    return 'unknown';
  }

  // ── 2. collect every claim the fields make ────────────────────────────────────────
  const claims = new Set();
  if (hasOk) claims.add(result.ok ? 'success' : 'failed');
  if (hasOutcome) claims.add(result.outcome);
  if (hasUnknown && result.unknown === true) claims.add('unknown');

  // ── 3. reconcile ─────────────────────────────────────────────────────────────────
  if (claims.has('unknown')) return 'unknown';   // contagion: never upgraded
  if (claims.has('success') && claims.has('failed')) return 'unknown';  // contradiction
  if (claims.size === 1) return [...claims][0];
  return 'unknown';                              // no claim at all, or unrecognised mix
}

/**
 * @param claimer - from `createReplayClaimer`
 * @param transport - async (action, input) => result; the fake/real QQ action executor
 * @param clock - () => trusted millisecond timestamp
 */
export function createReplayGuardedDispatcher({ claimer, transport, clock } = {}) {
  if (!claimer || typeof claimer.claim !== 'function') {
    throw new TypeError('dispatcher needs a replay claimer');
  }
  if (typeof transport !== 'function') throw new TypeError('dispatcher needs a transport function');
  if (typeof clock !== 'function') throw new TypeError('dispatcher needs a clock');

  return Object.freeze({
    /**
     * @returns
     *   { ok:true, outcome:'success'|'unknown'|'failed', result? }   transport was called once
     *   { ok:false, reason, stage:'claim' }                          transport NOT called
     *   { ok:false, reason:'transport-threw', error }                transport called, threw
     *
     * NOTE the two axes: `ok` means "the dispatch path itself completed without a refusal or
     * a throw". `outcome` describes what the TRANSPORT reported. `ok:true, outcome:'unknown'`
     * is a legitimate combination and must not be read as "nothing happened".
     */
    async dispatch({ identity, action, input } = {}) {
      // ── stage 1: claim. Any throw here propagates: the caller must not send. ─────────
      // Note the order — `claim` is settled BEFORE the transport reference is even touched,
      // so a storage failure can never be swallowed into a send.
      const claim = claimer.claim(identity, { now: clock() });
      if (!claim || claim.ok !== true) {
        return Object.freeze({ ok: false, stage: 'claim', reason: claim?.reason ?? 'claim-refused' });
      }

      // ── stage 2: the claim is durable (the store committed before `claim` returned). ──
      // Only now may the transport run. Exactly once.
      try {
        const result = await transport(action, input);
        // The claim stays consumed regardless of the outcome — including `unknown`.
        return Object.freeze({ ok: true, outcome: normaliseOutcome(result), result });
      } catch (error) {
        // The claim stays consumed on purpose: we cannot prove the platform did not act.
        return Object.freeze({ ok: false, stage: 'transport', reason: 'transport-threw', error });
      }
    },
  });
}
